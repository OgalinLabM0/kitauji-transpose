import { englishRubyRules, englishRubyMarks } from '../workflow/termEnglishRuby';
import { withIdentityRead } from './identitySources';
import {foreignNoteTexts} from '../workflow/foreignNotes';
import { preReadInputsCurrent } from './narrativeSources';
import { sceneIdentitySignature } from './sceneIdentityProof';
import { createHash } from 'node:crypto';
import { preparationContract, preparationContractAccepted } from '../ai/preparationContract';
import { Db, newId, nowIso, fromJson, toJson } from './database';
import type { SeriesSummary, VolumeSummary, ChapterSummary, ParagraphView, ParagraphType, ProjectSettings, WorkstationId } from '@shared/types';
import { DEFAULT_PROJECT_SETTINGS } from '@shared/types';

export interface NewParagraph { sceneId: string; paraOrdinal: number; sourceText: string; sourceHash: string; paragraphType: ParagraphType }
export interface AnalysisRow {
  scene_boundary_before: number; atmosphere: string; scene_source_hash: string | null;
  paragraph_id: string; speaker_char_id: string | null; speaker_confidence: number | null;
  target_char_ids: string | null; present_char_ids: string | null; intent: string | null; difficulty_flags: string | null; evidence_ids: string | null;
}

/** 系列 / 册 / 章 / 场景 / 段落 / 项目设置 */
export class ProjectRepo {
  constructor(private readonly db: Db) {}

  createSeries(title: string, author: string | null): string {
    const id = newId(); const t = nowIso();
    this.db.run('INSERT INTO series(id,title,author,created_at,updated_at) VALUES(?,?,?,?,?)', [id, title, author, t, t]);
    return id;
  }
  touchSeries(id: string): void { this.db.run('UPDATE series SET updated_at=? WHERE id=?', [nowIso(), id]); }
  findSeriesByTitle(title: string): string | null {
    return (this.db.get<{ id: string }>('SELECT id FROM series WHERE title=?', [title])?.id) ?? null;
  }
  /** 预处理步骤按章完成标记：preread / terms。存 meta 表，key = prep:<kind>:<chapterId>。 */
  chapterSourceSignature(chapterId: string): string {
    const rows = this.db.all('SELECT p.id,p.source_text,p.series_ordinal,p.para_ordinal,p.paragraph_type,p.scene_id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id WHERE s.chapter_id=? ORDER BY p.series_ordinal,p.id', [chapterId]);
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  markPrepDone(kind: 'preread' | 'terms', chapterId: string, expectedSource?: string): void {
    const source = this.chapterSourceSignature(chapterId);
    if (expectedSource !== undefined && expectedSource !== source) throw new Error('章节原文范围已变化，不能标记准备完成，请继续本册重试');
    if (kind === 'preread' && !preReadInputsCurrent(this.db, chapterId)) throw new Error('预读背景依据已变化，不能标记准备完成，请继续本册重试');
    this.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [`prep:${kind}:${chapterId}`, JSON.stringify({ version: 1, source, contract: preparationContract(kind), at: nowIso() })]);
  }
  clearPrepDone(kind: 'preread' | 'terms', chapterIds: string[]): void { for (const c of chapterIds) this.db.run('DELETE FROM meta WHERE key=?', [`prep:${kind}:${c}`]); }
  prepDoneChapters(kind: 'preread' | 'terms', volumeId: string): Set<string> {
    return withIdentityRead(this.db, () => {
    const ids = this.listChapters(volumeId).map(c => c.id);
    const done = new Set<string>();
    for (const c of ids) {
      const row = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [`prep:${kind}:${c}`]);
      const proof = fromJson<{ version?: number; source?: string; contract?: string }>(row?.value, {});
      if (proof.version === 1 && preparationContractAccepted(kind, proof.contract) && proof.source === this.chapterSourceSignature(c) && (kind !== 'preread' || preReadInputsCurrent(this.db, c))) done.add(c);
    }
    return done;
    });
  }

  deleteSeries(id: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM meta WHERE key=?', [`series-run:${id}`]);
      this.db.run('DELETE FROM meta WHERE key=?', [`series-delivery:${id}`]);
      const localizationPrefix = `narrative-localization:${id}:`;
      this.db.run('DELETE FROM meta WHERE substr(key,1,?)=?', [localizationPrefix.length, localizationPrefix]);
      for (const v of this.db.all<{id: string}>('SELECT id FROM volumes WHERE series_id=?', [id])) {
        this.db.run('DELETE FROM meta WHERE key=?', [`volume-run:${v.id}`]);
        this.db.run('DELETE FROM meta WHERE substr(key,1,?)=?', [`trajectory:${v.id}:`.length, `trajectory:${v.id}:`]);
        this.db.run('DELETE FROM meta WHERE substr(key,1,?)=?', [`trajectory-repair:${v.id}:`.length, `trajectory-repair:${v.id}:`]);
      }
      // 预处理完成标记
      for (const c of this.db.all<{ id: string }>('SELECT c.id FROM chapters c JOIN volumes v ON v.id=c.volume_id WHERE v.series_id=?', [id])) { this.db.run('DELETE FROM meta WHERE key=?', [`prep:preread-progress:${c.id}`]); this.db.run('DELETE FROM meta WHERE key=?', [`prep:preread:${c.id}`]); this.db.run('DELETE FROM meta WHERE key=?', [`prep:terms:${c.id}`]); }
      const paraIds = this.db.all<{ id: string }>(
        `SELECT p.id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id JOIN volumes v ON v.id=c.volume_id WHERE v.series_id=?`, [id]).map(r => r.id);
      for (const pid of paraIds) {
        for (const prefix of ['scene-context:', 'local-repair-attempt:', 'long-paragraph-draft:', 'pipeline-generation-resume:', 'separated-body:', 'separated-editor:']) this.db.run('DELETE FROM meta WHERE key=?', [`${prefix}${pid}`]);
        const readingPrefix = `naturalness-proof:${pid}:`;
        this.db.run('DELETE FROM meta WHERE substr(key,1,?)=?', [readingPrefix.length, readingPrefix]);
      }
      const inList = (ids: string[]) => ids.length ? `(${ids.map(() => '?').join(',')})` : '(NULL)';
      for (let i = 0; i < paraIds.length; i += 500) {
        const chunk = paraIds.slice(i, i + 500); const q = inList(chunk);
        // Remove manuscript-bearing proofs, retaining historical request accounting.
        for (const prefix of ['inline-call:', 'inline-layout-proof:', 'source-style-call:'])
          this.db.run(`DELETE FROM meta WHERE key IN (SELECT ? || id FROM ai_calls WHERE paragraph_id IN ${q})`, [prefix, ...chunk]);
        for (const t of ['workflow_tasks', 'translation_finals', 'translation_candidates', 'review_findings', 'recheck_tasks', 'term_occurrences', 'paragraph_analysis', 'epub_text_blocks'])
          this.db.run(`DELETE FROM ${t} WHERE paragraph_id IN ${q}`, chunk);
      }
      this.db.run('DELETE FROM review_queue WHERE series_id=?', [id]);
      this.db.run('DELETE FROM wordplay_decisions WHERE series_id=?', [id]);
      this.db.run('DELETE FROM knowledge_change_candidates WHERE series_id=?', [id]);
      this.db.run('DELETE FROM knowledge_boundaries WHERE series_id=?', [id]);
      this.db.run('DELETE FROM address_trajectories WHERE series_id=?', [id]);
      this.db.run('DELETE FROM narrative_provenance WHERE series_id=?', [id]);
      this.db.run('DELETE FROM relationships WHERE series_id=?', [id]);
      this.db.run('DELETE FROM narrative_events WHERE series_id=?', [id]);
      this.db.run('DELETE FROM term_occurrences WHERE term_id IN (SELECT id FROM terms WHERE series_id=?)', [id]);
      this.db.run('DELETE FROM term_senses WHERE term_id IN (SELECT id FROM terms WHERE series_id=?)', [id]);
      this.db.run('DELETE FROM term_variants WHERE term_id IN (SELECT id FROM terms WHERE series_id=?)', [id]);
      this.db.run('UPDATE terms SET superseded_by_term_id=NULL WHERE series_id=?', [id]);
      this.db.run('DELETE FROM terms WHERE series_id=?', [id]);
      this.db.run('DELETE FROM character_aliases WHERE character_id IN (SELECT id FROM characters WHERE series_id=?)', [id]);
      this.db.run('DELETE FROM character_states WHERE character_id IN (SELECT id FROM characters WHERE series_id=?)', [id]);
      this.db.run('DELETE FROM characters WHERE series_id=?', [id]);
      this.db.run('DELETE FROM toc_entries WHERE archive_id IN (SELECT a.id FROM source_archives a JOIN volumes v ON v.id=a.volume_id WHERE v.series_id=?)', [id]);
      this.db.run('DELETE FROM epub_text_blocks WHERE spine_item_id IN (SELECT s.id FROM spine_items s JOIN source_archives a ON a.id=s.archive_id JOIN volumes v ON v.id=a.volume_id WHERE v.series_id=?)', [id]);
      this.db.run('DELETE FROM spine_items WHERE archive_id IN (SELECT a.id FROM source_archives a JOIN volumes v ON v.id=a.volume_id WHERE v.series_id=?)', [id]);
      this.db.run('DELETE FROM source_archives WHERE volume_id IN (SELECT id FROM volumes WHERE series_id=?)', [id]);
      this.db.run('DELETE FROM paragraphs WHERE scene_id IN (SELECT s.id FROM scenes s JOIN chapters c ON c.id=s.chapter_id JOIN volumes v ON v.id=c.volume_id WHERE v.series_id=?)', [id]);
      this.db.run('DELETE FROM scenes WHERE chapter_id IN (SELECT c.id FROM chapters c JOIN volumes v ON v.id=c.volume_id WHERE v.series_id=?)', [id]);
      this.db.run('DELETE FROM chapters WHERE volume_id IN (SELECT id FROM volumes WHERE series_id=?)', [id]);
      this.db.run('DELETE FROM volumes WHERE series_id=?', [id]);
      this.db.run('DELETE FROM project_settings WHERE series_id=?', [id]);
      this.db.run('DELETE FROM series WHERE id=?', [id]);
    });
  }

  createVolume(seriesId: string, volumeNumber: number, title: string | null): string {
    const id = newId();
    this.db.run('INSERT INTO volumes(id,series_id,volume_number,title,created_at) VALUES(?,?,?,?,?)', [id, seriesId, volumeNumber, title, nowIso()]);
    return id;
  }
  nextVolumeNumber(seriesId: string): number {
    return (this.db.get<{ n: number | null }>('SELECT MAX(volume_number) n FROM volumes WHERE series_id=?', [seriesId])?.n ?? 0) + 1;
  }
  createChapter(volumeId: string, chapterNumber: number, title: string | null): string {
    const id = newId();
    this.db.run('INSERT INTO chapters(id,volume_id,chapter_number,title) VALUES(?,?,?,?)', [id, volumeId, chapterNumber, title]);
    return id;
  }
  createScene(chapterId: string, sceneOrdinal: number): string {
    const id = newId();
    this.db.run('INSERT INTO scenes(id,chapter_id,scene_ordinal) VALUES(?,?,?)', [id, chapterId, sceneOrdinal]);
    return id;
  }
  nextSeriesOrdinal(seriesId: string): number {
    const r = this.db.get<{ n: number | null }>(
      `SELECT MAX(p.series_ordinal) n FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id JOIN volumes v ON v.id=c.volume_id WHERE v.series_id=?`, [seriesId]);
    return (r?.n ?? 0) + 1;
  }
  insertParagraph(p: NewParagraph, seriesOrdinal: number): string {
    const id = newId();
    this.db.run('INSERT INTO paragraphs(id,scene_id,para_ordinal,series_ordinal,source_text,source_hash,paragraph_type) VALUES(?,?,?,?,?,?,?)',
      [id, p.sceneId, p.paraOrdinal, seriesOrdinal, p.sourceText, p.sourceHash, p.paragraphType]);
    return id;
  }

  listSeries(): SeriesSummary[] {
    const rows = this.db.all<{ id: string; title: string; author: string | null; created_at: string; updated_at: string }>('SELECT * FROM series ORDER BY updated_at DESC');
    return rows.map(s => ({ id: s.id, title: s.title, author: s.author, createdAt: s.created_at, updatedAt: s.updated_at, volumes: this.listVolumes(s.id) }));
  }
  getSeries(id: string): SeriesSummary | null {
    const s = this.db.get<{ id: string; title: string; author: string | null; created_at: string; updated_at: string }>('SELECT * FROM series WHERE id=?', [id]);
    return s ? { id: s.id, title: s.title, author: s.author, createdAt: s.created_at, updatedAt: s.updated_at, volumes: this.listVolumes(s.id) } : null;
  }
  listVolumes(seriesId: string): VolumeSummary[] {
    return this.db.all<{ id: string; series_id: string; volume_number: number; title: string | null; file_kind: string | null; pc: number; tc: number; cc: number; rc: number }>(`
      SELECT v.id, v.series_id, v.volume_number, v.title,
        (SELECT file_kind FROM source_archives a WHERE a.volume_id=v.id LIMIT 1) file_kind,
        (SELECT COUNT(*) FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id WHERE c.volume_id=v.id) pc,
        (SELECT COUNT(DISTINCT f.paragraph_id) FROM translation_finals f JOIN paragraphs p ON p.id=f.paragraph_id JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id WHERE c.volume_id=v.id) tc,
        (SELECT COUNT(DISTINCT f.paragraph_id) FROM translation_finals f JOIN paragraphs p ON p.id=f.paragraph_id JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id WHERE c.volume_id=v.id AND f.confirmed_by_user=1) cc,
        (SELECT COUNT(*) FROM review_queue q JOIN paragraphs p ON p.id=q.paragraph_id JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id WHERE c.volume_id=v.id AND q.status='pending') rc
      FROM volumes v WHERE v.series_id=? ORDER BY v.volume_number`, [seriesId])
      .map(r => ({ id: r.id, seriesId: r.series_id, volumeNumber: r.volume_number, title: r.title,
        fileKind: (r.file_kind as 'epub' | 'txt' | null), paragraphCount: r.pc, translatedCount: r.tc, confirmedCount: r.cc, pendingReviewCount: r.rc }));
  }
  getVolumeSeriesId(volumeId: string): string {
    const r = this.db.get<{ series_id: string }>('SELECT series_id FROM volumes WHERE id=?', [volumeId]);
    if (!r) throw new Error(`册不存在：${volumeId}`);
    return r.series_id;
  }
  listChapters(volumeId: string): ChapterSummary[] {
    return this.db.all<{ id: string; volume_id: string; chapter_number: number; title: string | null; pc: number; tc: number; cc: number; bc: number }>(`
      SELECT c.id, c.volume_id, c.chapter_number, c.title,
        (SELECT COUNT(*) FROM paragraphs p JOIN scenes s ON s.id=p.scene_id WHERE s.chapter_id=c.id) pc,
        (SELECT COUNT(DISTINCT f.paragraph_id) FROM translation_finals f JOIN paragraphs p ON p.id=f.paragraph_id JOIN scenes s ON s.id=p.scene_id WHERE s.chapter_id=c.id) tc,
        (SELECT COUNT(DISTINCT f.paragraph_id) FROM translation_finals f JOIN paragraphs p ON p.id=f.paragraph_id JOIN scenes s ON s.id=p.scene_id WHERE s.chapter_id=c.id AND f.confirmed_by_user=1) cc,
        (SELECT COUNT(DISTINCT r.paragraph_id) FROM review_findings r JOIN paragraphs p ON p.id=r.paragraph_id JOIN scenes s ON s.id=p.scene_id WHERE s.chapter_id=c.id AND r.resolved=0 AND r.severity='blocks_export') bc
      FROM chapters c WHERE c.volume_id=? ORDER BY c.chapter_number`, [volumeId])
      .map(r => ({ id: r.id, volumeId: r.volume_id, chapterNumber: r.chapter_number, title: r.title, paragraphCount: r.pc, translatedCount: r.tc, confirmedCount: r.cc, blockedCount: r.bc }));
  }
  listParagraphIdsByChapter(chapterId: string): string[] {
    return this.db.all<{ id: string }>('SELECT p.id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id WHERE s.chapter_id=? ORDER BY p.series_ordinal', [chapterId]).map(r => r.id);
  }
  listParagraphIdsByVolume(volumeId: string): string[] {
    return this.db.all<{ id: string }>('SELECT p.id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id WHERE c.volume_id=? ORDER BY p.series_ordinal', [volumeId]).map(r => r.id);
  }
  getParagraph(id: string): { id: string; sceneId: string; chapterId: string; seriesOrdinal: number; sourceText: string; paragraphType: ParagraphType } | null {
    const r = this.db.get<{ id: string; scene_id: string; chapter_id: string; series_ordinal: number; source_text: string; paragraph_type: ParagraphType }>(
      'SELECT p.id, p.scene_id, s.chapter_id, p.series_ordinal, p.source_text, p.paragraph_type FROM paragraphs p JOIN scenes s ON s.id=p.scene_id WHERE p.id=?', [id]);
    return r ? { id: r.id, sceneId: r.scene_id, chapterId: r.chapter_id, seriesOrdinal: r.series_ordinal, sourceText: r.source_text, paragraphType: r.paragraph_type } : null;
  }
  paragraphIdBySeriesOrdinal(seriesId: string, ordinal: number): string | null {
    const r = this.db.get<{ id: string }>('SELECT p.id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id JOIN volumes v ON v.id=c.volume_id WHERE v.series_id=? AND p.series_ordinal=?', [seriesId, ordinal]);
    return r?.id ?? null;
  }
  paragraphsContaining(seriesId: string, needle: string, limit = 8): { id: string; seriesOrdinal: number; sourceText: string }[] {
    return this.db.all<{ id: string; series_ordinal: number; source_text: string }>(`SELECT p.id, p.series_ordinal, p.source_text FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id JOIN volumes v ON v.id=c.volume_id WHERE v.series_id=? AND instr(p.source_text, ?)>0 ORDER BY p.series_ordinal LIMIT ?`, [seriesId, needle, limit])
      .map(r => ({ id: r.id, seriesOrdinal: r.series_ordinal, sourceText: r.source_text }));
  }
  /** 已翻译且原文含某字串的段落（影响范围查询） */
  translatedParagraphsContaining(seriesId: string, needle: string): { id: string; sourceText: string; finalText: string }[] {
    return this.db.all<{ id: string; source_text: string; final_text: string }>(`
      SELECT p.id, p.source_text, f.final_text FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id JOIN volumes v ON v.id=c.volume_id
      JOIN translation_finals f ON f.id=(SELECT id FROM translation_finals WHERE paragraph_id=p.id ORDER BY version DESC LIMIT 1)
      WHERE v.series_id=? AND instr(p.source_text, ?)>0 ORDER BY p.series_ordinal`, [seriesId, needle])
      .map(r => ({ id: r.id, sourceText: r.source_text, finalText: r.final_text }));
  }
  getSeriesIdOfParagraph(paragraphId: string): string {
    const r = this.db.get<{ series_id: string }>('SELECT v.series_id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id JOIN volumes v ON v.id=c.volume_id WHERE p.id=?', [paragraphId]);
    if (!r) throw new Error(`段落不存在：${paragraphId}`);
    return r.series_id;
  }
  /** 局部窗口：同一场景内前 n 段 */
  previousParagraphs(paragraphId: string, n: number): { id: string; sourceText: string; finalText: string | null }[] {
    const p = this.getParagraph(paragraphId); if (!p) return [];
    const rows = this.db.all<{ id: string; source_text: string; final_text: string | null }>(`
      SELECT p.id, p.source_text, (SELECT final_text FROM translation_finals f WHERE f.paragraph_id=p.id ORDER BY version DESC LIMIT 1) final_text
      FROM paragraphs p WHERE p.scene_id=? AND p.series_ordinal<? ORDER BY p.series_ordinal DESC LIMIT ?`, [p.sceneId, p.seriesOrdinal, n])
      .reverse().map(r => ({ id: r.id, sourceText: r.source_text, finalText: r.final_text }));
    if (this.sceneObservation(paragraphId)?.boundary) return [];
    const boundary = rows.findLastIndex(r => this.sceneObservation(r.id)?.boundary);
    return boundary >= 0 ? rows.slice(boundary) : rows;
  }
  nextParagraphs(paragraphId: string, n: number): { id: string; sourceText: string }[] {
    const p = this.getParagraph(paragraphId); if (!p) return [];
    const rows = this.db.all<{ id: string; source_text: string }>('SELECT id, source_text FROM paragraphs WHERE scene_id=? AND series_ordinal>? ORDER BY series_ordinal LIMIT ?', [p.sceneId, p.seriesOrdinal, n])
      .map(r => ({ id: r.id, sourceText: r.source_text }));
    const boundary = rows.findIndex(r => this.sceneObservation(r.id)?.boundary);
    return boundary >= 0 ? rows.slice(0, boundary) : rows;
  }

  /** Read-only previous-chapter evidence, separate from the current scene window. */
  previousChapterSource(paragraphId: string, limit = 2): { id: string; sourceText: string; seriesOrdinal: number }[] {
    const p = this.getParagraph(paragraphId); if (!p) return [];
    const count = Number.isFinite(limit) ? Math.max(0, Math.min(2, Math.floor(limit))) : 2;
    if (!count) return [];
    const chapter = this.db.get<{volume_id:string;chapter_number:number}>('SELECT volume_id,chapter_number FROM chapters WHERE id=?', [p.chapterId]);
    if (!chapter) return [];
    const leading = this.db.all<{id:string;scene_id:string}>('SELECT p.id,p.scene_id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id WHERE s.chapter_id=? AND p.series_ordinal<=? ORDER BY p.series_ordinal', [p.chapterId,p.seriesOrdinal]);
    // Do not bridge a physical or observed scene transition inside the current chapter.
    if (leading.some(r => r.scene_id !== p.sceneId || this.sceneObservation(r.id)?.boundary)) return [];
    const previous = this.db.get<{id:string}>('SELECT id FROM chapters WHERE volume_id=? AND chapter_number<? ORDER BY chapter_number DESC LIMIT 1', [chapter.volume_id,chapter.chapter_number]);
    if (!previous) return [];
    const rows = this.db.all<{id:string;source_text:string;series_ordinal:number;scene_id:string}>('SELECT p.id,p.source_text,p.series_ordinal,p.scene_id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id WHERE s.chapter_id=? ORDER BY p.series_ordinal DESC LIMIT ?', [previous.id,count]).reverse();
    const finalScene = rows.at(-1)?.scene_id;
    const sameScene = rows.filter(r => r.scene_id === finalScene);
    const boundary = sameScene.findLastIndex(r => this.sceneObservation(r.id)?.boundary);
    return (boundary >= 0 ? sameScene.slice(boundary) : sameScene).map(r => ({id:r.id,sourceText:r.source_text,seriesOrdinal:r.series_ordinal}));
  }

  sceneContextSignature(ids: string[]): string | null {
    const rows = ids.map(id => this.getParagraph(id));
    if (rows.some(p => !p)) return null;
    return createHash('sha256').update(JSON.stringify(rows.map(p => [p!.id,p!.sourceText,p!.seriesOrdinal,p!.paragraphType,p!.sceneId,p!.chapterId]))).digest('hex');
  }

  sceneObservation(paragraphId: string): { boundary: boolean; atmosphere: string } | null {
    const row=this.db.get<{source_text:string;series_ordinal:number;paragraph_type:string;scene_id:string;chapter_id:string;scene_source_hash:string|null;scene_boundary_before:number;atmosphere:string;value:string}>(`SELECT p.source_text,p.series_ordinal,p.paragraph_type,p.scene_id,s.chapter_id,a.scene_source_hash,a.scene_boundary_before,a.atmosphere,m.value FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN paragraph_analysis a ON a.paragraph_id=p.id JOIN meta m ON m.key='scene-context:'||p.id WHERE p.id=?`,[paragraphId]);
    if(!row?.scene_source_hash||row.scene_source_hash!==createHash('sha256').update(row.source_text).digest('hex'))return null;
    {
      const proof = fromJson<{ids?:string[];signature?:string;identitySignature?:string}>(row.value, {});
      if (!proof || !Array.isArray(proof.ids) || !proof.ids.length || typeof proof.signature !== 'string')return null;
      const sourceSignature=proof.ids.length===1&&proof.ids[0]===paragraphId ? createHash('sha256').update(JSON.stringify([[paragraphId,row.source_text,row.series_ordinal,row.paragraph_type,row.scene_id,row.chapter_id]])).digest('hex') : this.sceneContextSignature(proof.ids);
      if(sourceSignature!==proof.signature)return null;
      try { if (proof.identitySignature !== this.sceneIdentitySignature(proof.ids)) return null; } catch { return null; }
    }
    return { boundary: !!row.scene_boundary_before, atmosphere: row.atmosphere };
  }

  listParagraphViews(chapterId: string): ParagraphView[] { return this.paragraphViews('s.chapter_id=?', [chapterId]); }
  getParagraphView(paragraphId: string): ParagraphView | null { return this.paragraphViews('p.id=?', [paragraphId])[0] ?? null; }
  listParagraphViewsByVolume(volumeId: string): ParagraphView[] { return this.paragraphViews('s.chapter_id IN (SELECT id FROM chapters WHERE volume_id=?)', [volumeId]); }
  private paragraphViews(where: string, params: string[]): ParagraphView[] {
    const ruleCache=new Map<string,ReturnType<typeof englishRubyRules>>();
    const ruby=(r:Record<string,unknown>)=>{const volume=String(r.volume_id);let rules=ruleCache.get(volume);if(!rules){rules=englishRubyRules(this.db,this.getVolumeSeriesId(volume));ruleCache.set(volume,rules);}return englishRubyMarks(String(r.source_text),String(r.final_text),rules);};
    return this.db.all<Record<string, unknown>>(`
      SELECT p.id, s.chapter_id, (SELECT volume_id FROM chapters WHERE id=s.chapter_id) volume_id, p.scene_id, p.series_ordinal, p.para_ordinal, p.source_text, p.paragraph_type,
        f.final_text, fc.flags final_flags, f.auto_accepted, f.confirmed_by_user, f.version,
        c.candidate_text, c.workstation_id cand_ws,
        (SELECT COUNT(*) FROM review_findings r WHERE r.paragraph_id=p.id AND r.resolved=0) open_findings,
        (SELECT COUNT(*) FROM review_findings r WHERE r.paragraph_id=p.id AND r.resolved=0 AND r.severity='blocks_export') blocking,
        pa.speaker_confidence, pa.intent, ch.canonical_name_zh, ch.canonical_name_jp
      FROM paragraphs p JOIN scenes s ON s.id=p.scene_id
      LEFT JOIN translation_finals f ON f.id=(SELECT id FROM translation_finals WHERE paragraph_id=p.id ORDER BY version DESC LIMIT 1)
      LEFT JOIN translation_candidates fc ON fc.id=f.source_candidate_id AND fc.paragraph_id=p.id AND fc.candidate_text=f.final_text
      LEFT JOIN translation_candidates c ON c.id=(SELECT id FROM translation_candidates WHERE paragraph_id=p.id ORDER BY created_at DESC LIMIT 1)
      LEFT JOIN paragraph_analysis pa ON pa.paragraph_id=p.id
      LEFT JOIN characters ch ON ch.id=pa.speaker_char_id
      WHERE ${where} ORDER BY p.series_ordinal`, params)
      .map(r => ({
        id: r.id as string, volumeId: r.volume_id as string, chapterId: r.chapter_id as string, sceneId: r.scene_id as string,
        seriesOrdinal: r.series_ordinal as number, paraOrdinal: r.para_ordinal as number,
        sourceText: r.source_text as string, paragraphType: r.paragraph_type as ParagraphType,
        final: r.final_text != null ? { text: r.final_text as string, ruby: ruby(r), notes: (()=>{try{return foreignNoteTexts(r.source_text as string,r.final_text as string,JSON.parse((r.final_flags as string|null)??'[]'));}catch{return [];}})(), autoAccepted: !!r.auto_accepted, confirmed: !!r.confirmed_by_user, version: r.version as number } : null,
        latestCandidate: r.candidate_text != null ? { text: r.candidate_text as string, workstationId: r.cand_ws as WorkstationId } : null,
        openFindings: r.open_findings as number, blocking: (r.blocking as number) > 0,
        analysis: r.speaker_confidence != null || r.intent != null
          ? { speakerName: (r.canonical_name_zh ? `${r.canonical_name_zh}（${r.canonical_name_jp}）` : (r.canonical_name_jp ?? null)) as string | null, speakerConfidence: r.speaker_confidence as number | null, intent: r.intent as string | null }
          : null,
      }));
  }

  getAnalysis(paragraphId: string): AnalysisRow | undefined {
    return this.db.get<AnalysisRow>('SELECT * FROM paragraph_analysis WHERE paragraph_id=?', [paragraphId]);
  }
  /** Use this for decisions and generated annotations; getAnalysis is historical inspection. */
  currentAnalysis(paragraphId: string): AnalysisRow | undefined {
    return this.sceneObservation(paragraphId) ? this.getAnalysis(paragraphId) : undefined;
  }
  analysesFor(paragraphIds: string[]): Map<string, AnalysisRow> {
    const out = new Map<string, AnalysisRow>();
    for (let i = 0; i < paragraphIds.length; i += 500) {
      const chunk = paragraphIds.slice(i, i + 500);
      for (const r of this.db.all<AnalysisRow>(`SELECT * FROM paragraph_analysis WHERE paragraph_id IN (${chunk.map(() => '?').join(',')})`, chunk)) out.set(r.paragraph_id, r);
    }
    return out;
  }
  sceneIdentitySignature(paragraphIds: string[]): string { return sceneIdentitySignature(this.db, paragraphIds); }

  saveAnalysis(a: { paragraphId: string; speakerCharId: string | null; speakerConfidence: number | null; targetCharIds: string[]; presentCharIds: string[]; intent: string | null; difficultyFlags: string[]; evidenceIds: string[]; sceneBoundaryBefore?: boolean; atmosphere?: string; sourceContextIds?: string[]; expectedIdentitySignature?: string }): void {
    this.db.transaction(() => {
    this.db.run(`INSERT INTO paragraph_analysis(paragraph_id,speaker_char_id,speaker_confidence,target_char_ids,present_char_ids,intent,difficulty_flags,evidence_ids,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(paragraph_id) DO UPDATE SET speaker_char_id=excluded.speaker_char_id, speaker_confidence=excluded.speaker_confidence, target_char_ids=excluded.target_char_ids, present_char_ids=excluded.present_char_ids, intent=excluded.intent, difficulty_flags=excluded.difficulty_flags, evidence_ids=excluded.evidence_ids, updated_at=excluded.updated_at`,
      [a.paragraphId, a.speakerCharId, a.speakerConfidence, JSON.stringify(a.targetCharIds), JSON.stringify(a.presentCharIds), a.intent, JSON.stringify(a.difficultyFlags), JSON.stringify(a.evidenceIds), nowIso()]);
    {
      const ids = [...new Set([a.paragraphId, ...(a.sourceContextIds ?? [])])].sort();
      const signature = this.sceneContextSignature(ids);
      if (!signature) throw new Error('场景参考原文已不存在，结果未保存');
      const identitySignature = this.sceneIdentitySignature(ids);
      if (a.expectedIdentitySignature !== undefined && a.expectedIdentitySignature !== identitySignature) throw new Error('场景人物依据已变化，旧分析未保存，请重试');
      this.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [`scene-context:${a.paragraphId}`, JSON.stringify({ids,signature,identitySignature})]);
    }
    if (a.sceneBoundaryBefore !== undefined || a.atmosphere !== undefined) {
      const paragraph = this.getParagraph(a.paragraphId);
      if (!paragraph) throw new Error('场景段落不存在');
      this.db.run('UPDATE paragraph_analysis SET scene_boundary_before=?,atmosphere=?,scene_source_hash=? WHERE paragraph_id=?', [a.sceneBoundaryBefore ? 1 : 0, a.atmosphere ?? '', createHash('sha256').update(paragraph.sourceText).digest('hex'), a.paragraphId]);
    }
  });
  }

  getSettings(seriesId: string): ProjectSettings {
    const out: ProjectSettings = { ...DEFAULT_PROJECT_SETTINGS };
    for (const r of this.db.all<{ key: string; value: string }>('SELECT key, value FROM project_settings WHERE series_id=?', [seriesId])) {
      (out as unknown as Record<string, unknown>)[r.key] = fromJson(r.value, (out as unknown as Record<string, unknown>)[r.key]);
    }
    return out;
  }
  setSetting<K extends keyof ProjectSettings>(seriesId: string, key: K, value: ProjectSettings[K]): void {
    this.db.run('INSERT INTO project_settings(series_id,key,value) VALUES(?,?,?) ON CONFLICT(series_id,key) DO UPDATE SET value=excluded.value', [seriesId, key, toJson(value)]);
  }
}
