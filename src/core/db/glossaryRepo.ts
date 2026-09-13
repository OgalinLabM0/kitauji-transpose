import { Db, newId, nowIso, toJson } from './database';
import type { TermView, TermSenseView, TermOccurrenceView, LockLevel, DeviationStatus } from '@shared/types';

export interface TermRow {
  id: string; series_id: string; introduced_volume: number; term_jp: string; term_zh: string | null; term_type: string;
  sense_identity: string | null; confidence: number; lock_level: LockLevel; notes: string | null; valid_to_para: number | null;
}
export interface SenseRow { id: string; term_id: string; sense_zh: string; sense_gloss: string | null; context_hint: string | null; is_default: number; confirmed_by_user: number }

/** 术语 / 义项 / 变体 / 出现记录（含偏离状态） */
export class GlossaryRepo {
  constructor(private readonly db: Db) {}

  /** 用户在术语表填写 = confirmed 默认义 */
  upsertTerm(input: { seriesId: string; introducedVolume: number; termJp: string; termZh: string | null; termType: string; senseIdentity?: string | null; lockLevel?: LockLevel; notes?: string | null; confidence?: number; evidenceIds?: string[] }): string {
    return this.db.transaction(() => {
      const t = nowIso();
      const existing = this.db.get<{ id: string }>('SELECT id FROM terms WHERE series_id=? AND term_jp=? AND valid_to_para IS NULL', [input.seriesId, input.termJp]);
      const id = existing?.id ?? newId();
      const lock = input.lockLevel ?? (input.termZh ? 'confirmed' : 'suggested');
      if (existing) {
        this.db.run('UPDATE terms SET term_zh=?, term_type=?, sense_identity=COALESCE(?,sense_identity), lock_level=?, notes=COALESCE(?,notes), confidence=?, evidence_ids=COALESCE(?,evidence_ids), updated_at=? WHERE id=?',
          [input.termZh, input.termType, input.senseIdentity ?? null, lock, input.notes ?? null, input.confidence ?? 1.0, toJson(input.evidenceIds), t, id]);
      } else {
        this.db.run('INSERT INTO terms(id,series_id,introduced_volume,term_jp,term_zh,term_type,sense_identity,confidence,lock_level,notes,evidence_ids,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [id, input.seriesId, input.introducedVolume, input.termJp, input.termZh, input.termType, input.senseIdentity ?? null, input.confidence ?? 1.0, lock, input.notes ?? null, toJson(input.evidenceIds), t, t]);
      }
      if (input.termZh) {
        const def = this.db.get<{ id: string }>('SELECT id FROM term_senses WHERE term_id=? AND is_default=1', [id]);
        if (def) this.db.run('UPDATE term_senses SET sense_zh=?, sense_gloss=COALESCE(?,sense_gloss), confirmed_by_user=? WHERE id=?', [input.termZh, input.senseIdentity ?? null, lock === 'suggested' ? 0 : 1, def.id]);
        else this.db.run('INSERT INTO term_senses(id,term_id,sense_zh,sense_gloss,is_default,confirmed_by_user,created_at) VALUES(?,?,?,?,1,?,?)', [newId(), id, input.termZh, input.senseIdentity ?? null, lock === 'suggested' ? 0 : 1, t]);
      }
      return id;
    });
  }
  setLockLevel(termId: string, lock: LockLevel): void {
    this.db.run('UPDATE terms SET lock_level=?, updated_at=? WHERE id=?', [lock, nowIso(), termId]);
    if (lock !== 'suggested') this.db.run('UPDATE term_senses SET confirmed_by_user=1 WHERE term_id=? AND is_default=1', [termId]);
  }
  deleteTerm(termId: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM term_occurrences WHERE term_id=?', [termId]);
      this.db.run('DELETE FROM term_senses WHERE term_id=?', [termId]);
      this.db.run('DELETE FROM term_variants WHERE term_id=?', [termId]);
      this.db.run('UPDATE terms SET superseded_by_term_id=NULL WHERE superseded_by_term_id=?', [termId]);
      this.db.run('DELETE FROM terms WHERE id=?', [termId]);
    });
  }
  addSense(termId: string, senseZh: string, senseGloss: string | null, contextHint: string | null, confirmed: boolean, evidenceIds: string[] = []): string {
    const id = newId();
    this.db.run('INSERT INTO term_senses(id,term_id,sense_zh,sense_gloss,context_hint,is_default,confirmed_by_user,evidence_ids,created_at) VALUES(?,?,?,?,?,0,?,?,?)',
      [id, termId, senseZh, senseGloss, contextHint, confirmed ? 1 : 0, toJson(evidenceIds), nowIso()]);
    return id;
  }
  setDefaultSense(termId: string, senseId: string): void {
    this.db.transaction(() => {
      this.db.run('UPDATE term_senses SET is_default=0 WHERE term_id=?', [termId]);
      this.db.run('UPDATE term_senses SET is_default=1, confirmed_by_user=1 WHERE id=? AND term_id=?', [senseId, termId]);
      const s = this.db.get<{ sense_zh: string }>('SELECT sense_zh FROM term_senses WHERE id=?', [senseId]);
      if (s) this.db.run('UPDATE terms SET term_zh=?, updated_at=? WHERE id=?', [s.sense_zh, nowIso(), termId]);
    });
  }
  deleteSense(senseId: string): void {
    this.db.run('UPDATE term_occurrences SET applied_sense_id=NULL WHERE applied_sense_id=?', [senseId]);
    this.db.run('DELETE FROM term_senses WHERE id=? AND is_default=0', [senseId]);
  }

  /** 当前有效的术语（含义项），供 L1 注入与命中检测 */
  activeTerms(seriesId: string, atPara?: number): (TermRow & { senses: SenseRow[] })[] {
    const rows = this.db.all<TermRow>('SELECT * FROM terms WHERE series_id=? AND (valid_to_para IS NULL OR valid_to_para > ?) ORDER BY LENGTH(term_jp) DESC', [seriesId, atPara ?? 2147483647]);
    const senses = this.db.all<SenseRow>('SELECT s.* FROM term_senses s JOIN terms t ON t.id=s.term_id WHERE t.series_id=?', [seriesId]);
    const byTerm = new Map<string, SenseRow[]>();
    for (const s of senses) { const arr = byTerm.get(s.term_id) ?? []; arr.push(s); byTerm.set(s.term_id, arr); }
    return rows.map(r => ({ ...r, senses: byTerm.get(r.id) ?? [] }));
  }
  findTermByJp(seriesId: string, termJp: string): TermRow | undefined {
    return this.db.get<TermRow>('SELECT * FROM terms WHERE series_id=? AND term_jp=? AND valid_to_para IS NULL', [seriesId, termJp]);
  }
  listTermViews(seriesId: string): TermView[] {
    const terms = this.activeTerms(seriesId);
    const occ = new Map<string, { n: number; d: number }>();
    for (const r of this.db.all<{ term_id: string; n: number; d: number }>(`SELECT term_id, COUNT(*) n, SUM(CASE WHEN deviation_status IN ('flagged','conflict') THEN 1 ELSE 0 END) d FROM term_occurrences GROUP BY term_id`)) occ.set(r.term_id, { n: r.n, d: r.d });
    return terms.map(t => ({
      id: t.id, termJp: t.term_jp, termZh: t.term_zh, termType: t.term_type, senseIdentity: t.sense_identity, lockLevel: t.lock_level,
      confidence: t.confidence, introducedVolume: t.introduced_volume, notes: t.notes,
      senses: t.senses.map<TermSenseView>(s => ({ id: s.id, senseZh: s.sense_zh, senseGloss: s.sense_gloss, contextHint: s.context_hint, isDefault: !!s.is_default, confirmedByUser: !!s.confirmed_by_user })),
      occurrenceCount: occ.get(t.id)?.n ?? 0, deviationCount: occ.get(t.id)?.d ?? 0,
    }));
  }
  listOccurrences(termId: string): TermOccurrenceView[] {
    return this.db.all<{ id: string; paragraph_id: string; series_ordinal: number; occurrence_text: string; applied_zh: string | null; deviation_status: DeviationStatus; deviation_rationale: string | null; inferred_confidence: number | null }>(
      'SELECT o.id, o.paragraph_id, p.series_ordinal, o.occurrence_text, o.applied_zh, o.deviation_status, o.deviation_rationale, o.inferred_confidence FROM term_occurrences o JOIN paragraphs p ON p.id=o.paragraph_id WHERE o.term_id=? ORDER BY p.series_ordinal', [termId])
      .map(r => ({ id: r.id, paragraphId: r.paragraph_id, seriesOrdinal: r.series_ordinal, occurrenceText: r.occurrence_text, appliedZh: r.applied_zh, deviationStatus: r.deviation_status, deviationRationale: r.deviation_rationale, confidence: r.inferred_confidence }));
  }
  /** 段落重译前清除本段出现记录 */
  clearOccurrences(paragraphId: string): void { this.db.run('DELETE FROM term_occurrences WHERE paragraph_id=?', [paragraphId]); }
  recordOccurrence(o: { termId: string; paragraphId: string; occurrenceText: string; appliedSenseId?: string | null; appliedZh?: string | null; confidence?: number | null; isAmbiguous?: boolean; deviationStatus?: DeviationStatus; rationale?: string | null; flagged?: boolean }): string {
    const id = newId();
    this.db.run('INSERT INTO term_occurrences(id,term_id,paragraph_id,occurrence_text,applied_sense_id,applied_zh,inferred_confidence,is_ambiguous,deviation_status,deviation_rationale,flagged_for_review) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [id, o.termId, o.paragraphId, o.occurrenceText, o.appliedSenseId ?? null, o.appliedZh ?? null, o.confidence ?? null, o.isAmbiguous ? 1 : 0, o.deviationStatus ?? 'none', o.rationale ?? null, o.flagged ? 1 : 0]);
    return id;
  }
  setOccurrenceStatus(occurrenceId: string, status: DeviationStatus, appliedSenseId?: string | null): void {
    this.db.run('UPDATE term_occurrences SET deviation_status=?, flagged_for_review=0, applied_sense_id=COALESCE(?,applied_sense_id) WHERE id=?', [status, appliedSenseId ?? null, occurrenceId]);
  }
  getOccurrence(id: string): { id: string; term_id: string; paragraph_id: string; applied_zh: string | null; deviation_rationale: string | null } | undefined {
    return this.db.get('SELECT id, term_id, paragraph_id, applied_zh, deviation_rationale FROM term_occurrences WHERE id=?', [id]);
  }
  pendingDeviationCount(seriesId: string): number {
    return this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM term_occurrences o JOIN terms t ON t.id=o.term_id WHERE t.series_id=? AND o.deviation_status IN ('flagged','conflict')`, [seriesId])?.n ?? 0;
  }
  addVariant(v: { termId: string; variantJp: string; variantZh: string | null; variantType: string; speakerCharId?: string | null; targetCharId?: string | null; relationStage?: string | null; sceneScope?: string | null; evidenceIds?: string[] }): string {
    const id = newId();
    this.db.run('INSERT INTO term_variants(id,term_id,variant_jp,variant_zh,variant_type,speaker_char_id,target_char_id,relation_stage,scene_scope,evidence_ids) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [id, v.termId, v.variantJp, v.variantZh, v.variantType, v.speakerCharId ?? null, v.targetCharId ?? null, v.relationStage ?? null, v.sceneScope ?? null, toJson(v.evidenceIds)]);
    return id;
  }
}
