import { bindChangeProof, changeTarget, changeTables, verifyChangeProof } from './knowledgeChanges';
import { Db, newId, nowIso, fromJson, toJson } from './database';
import { bindNarrativeSources, endObservedRelationship, narrativeSourceCurrent, previousNarrativeEvents } from './narrativeSources';
import { characterSourceCurrent, characterSourceProof, originalSourceProof } from './characterSources';
import { characterAt, saveCharacterFact, fieldDecisions, undoFieldDecision, type CharacterField } from './characterHistory';
import { validNameQuote, type NameEvidence } from '../validation/nameEvidence';
import type { CharacterView, QuirkProfile, AddressTrajectoryView } from '@shared/types';

/** 一人称/代词/泛称/常见军衔职务：不是人名 */
const GENERIC_NAME_WORDS = new Set(['私', '僕', '俺', '我', '吾', '儂', '拙者', '自分', 'わたし', 'わたくし', 'ぼく', 'おれ', 'あたし', 'うち', 'わし', 'おいら', '彼', '彼女', 'あいつ', 'こいつ', 'そいつ', '奴', 'やつ', '貴様', 'お前', 'あなた', '君', 'きみ', '貴方', '自称神', '神', '存在', '老翁', '老人', '少女', '少年', '男', '女', '男性', '女性', '子供', '大人',
  '少尉', '中尉', '大尉', '少佐', '中佐', '大佐', '准将', '少将', '中将', '大将', '元帥', '軍曹', '伍長', '曹長', '准尉', '兵長', '上等兵', '一等兵', '二等兵', '新兵', '士官', '下士官', '将校', '参謀', '参謀長', '指揮官', '司令官', '司令', '隊長', '中隊長', '大隊長', '小隊長', '連隊長', '師団長', '副官', '上官', '部下', '教官', '先任士官', '候補生', '一号生', '二号生', '魔導師', '兵士', '将軍', '団長', '会長', '社長', '部長', '課長', '店長', '先生', '教授', '博士', '医者', '医師', '看護師', '執事', 'メイド', '王', '女王', '王子', '王女', '姫', '陛下', '殿下', '閣下', '皇帝', '国王', '父', '母', '兄', '姉', '弟', '妹', '祖父', '祖母', '叔父', '叔母', '息子', '娘', '夫', '妻', '主人', '奥さん', '旦那', '友人', '親友', '仲間', '敵', '味方', '相手', '全員', '皆', 'みんな']);

export interface CharacterRow {
  id: string; series_id: string; introduced_volume: number; canonical_name_jp: string; canonical_name_zh: string | null;
  gender: string | null; gender_confidence: number | null; gender_evidence_ids: string | null; plurality: string | null; first_person_type: string | null;
  speech_register: string | null; quirk_profiles: string | null; voice_notes: string | null; is_active: number; deactivated_at_para: number | null; locked_by_user: number;
}
export interface RelationshipRow {
  id: string; from_char_id: string; to_char_id: string; event_type: string; description_jp: string; description_zh: string | null;
  intimacy_level: number | null; respect_level: number | null; power_distance: number | null; formality_level: number | null;
  valid_from_para: number; valid_to_para: number | null;
}
export interface AddressRow {
  automatically_adopted?: boolean;
  id: string; speaker_char_id: string; target_char_id: string; source_form_jp: string; translated_form: string;
  relation_stage: string | null; scene_scope: string | null; allow_variation: number; valid_from_para: number; valid_to_para: number | null; confirmed_by_user: number;
}

/** 人物 / 别名 / 状态 / 事件 / 关系 / 称呼轨迹 / 知识边界 / 过时候选 */
export class KnowledgeRepo {
  constructor(private readonly db: Db) {}

  upsertCharacter(c: { seriesId: string; introducedVolume: number; nameJp: string; nameZh?: string | null; gender?: string | null; genderConfidence?: number | null; genderEvidenceIds?: string[]; firstPersonType?: string | null; speechRegister?: string | null; voiceNotes?: string | null; plurality?: string | null }, at = Number.MAX_SAFE_INTEGER, origin: 'model' | 'user' = 'user'): string {
    const t = nowIso();
    const ex = this.db.get<CharacterRow>('SELECT * FROM characters WHERE series_id=? AND canonical_name_jp=?', [c.seriesId, c.nameJp]) ?? this.findByName(c.seriesId, c.nameJp, at);
    if (ex) {
      if (origin === 'user' && ex.canonical_name_jp === c.nameJp) this.db.run("INSERT OR REPLACE INTO character_name_origins(character_id,origin) VALUES(?,'user')", [ex.id]);
      if (ex.locked_by_user) return ex.id;
      this.db.run(`UPDATE characters SET canonical_name_zh=COALESCE(?,canonical_name_zh), gender=COALESCE(?,gender), gender_confidence=COALESCE(?,gender_confidence),
        gender_evidence_ids=COALESCE(?,gender_evidence_ids), first_person_type=COALESCE(?,first_person_type), speech_register=COALESCE(?,speech_register),
        voice_notes=COALESCE(?,voice_notes), plurality=COALESCE(?,plurality), updated_at=? WHERE id=?`,
        [c.nameZh ?? null, c.gender ?? null, c.genderConfidence ?? null, toJson(c.genderEvidenceIds), c.firstPersonType ?? null, c.speechRegister ?? null, c.voiceNotes ?? null, c.plurality ?? null, t, ex.id]);
      return ex.id;
    }
    const id = newId();
    this.db.run('INSERT INTO characters(id,series_id,introduced_volume,canonical_name_jp,canonical_name_zh,gender,gender_confidence,gender_evidence_ids,plurality,first_person_type,speech_register,quirk_profiles,voice_notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, c.seriesId, c.introducedVolume, c.nameJp, c.nameZh ?? null, c.gender ?? null, c.genderConfidence ?? null, toJson(c.genderEvidenceIds), Object.hasOwn(c, 'plurality') ? c.plurality ?? null : 'singular', c.firstPersonType ?? null, c.speechRegister ?? null, '[]', c.voiceNotes ?? null, t, t]);
    this.db.run('INSERT INTO character_name_origins(character_id,origin) VALUES(?,?)', [id, origin]);
    return id;
  }
  /** Pre-reader observations keep their evidence boundary instead of overwriting the past. */
  observeCharacter(c: Parameters<KnowledgeRepo['upsertCharacter']>[0], evidenceIds: string[], fieldEvidence?: Partial<Record<CharacterField, string[]>>, fieldQuotes: Partial<Record<CharacterField, { paragraph_id: string; quote: string }[]>> = {}, sourceIds = evidenceIds, eventIds: string[] = [], nameEvidence?: NameEvidence): string {
    return this.db.transaction(() => {
      if (!evidenceIds.length) throw new Error('人物观察缺少原文证据');
      const positions = evidenceIds.map(id => this.db.get<{series_id: string; series_ordinal: number}>(`SELECT v.series_id,p.series_ordinal FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters ch ON ch.id=s.chapter_id JOIN volumes v ON v.id=ch.volume_id WHERE p.id=?`, [id]));
      if (positions.some(p => !p || p.series_id !== c.seriesId)) throw new Error('人物观察证据不属于当前作品');
      const evidenceFor = (field: CharacterField): string[] => {
        const ids = fieldEvidence?.[field] ?? evidenceIds;
        if (!ids.length || ids.some(id => !evidenceIds.includes(id))) throw new Error('人物字段证据不属于该人物的本次观察');
        return [...new Set(ids)];
      };
      const atFor = (field: CharacterField) => Math.max(...evidenceFor(field).map(id => positions[evidenceIds.indexOf(id)]!.series_ordinal));
      const observationAt = Math.max(...sourceIds.map(id => this.db.get<{series_ordinal: number}>('SELECT series_ordinal FROM paragraphs WHERE id=?', [id])?.series_ordinal ?? -1));
      let nameAt = observationAt;
      if (nameEvidence) {
        const paragraph = this.db.get<{source_text:string;series_ordinal:number}>('SELECT source_text,series_ordinal FROM paragraphs WHERE id=?', [nameEvidence.paragraph_id]);
        if (!evidenceIds.includes(nameEvidence.paragraph_id) || !sourceIds.includes(nameEvidence.paragraph_id) || !paragraph || !validNameQuote(c.nameJp, nameEvidence.quote, paragraph.source_text)) throw new Error('姓名证据不属于本次独立主名原文');
        nameAt = paragraph.series_ordinal;
      }
      const id = this.findByName(c.seriesId, c.nameJp, observationAt)?.id ?? this.upsertCharacter({ seriesId: c.seriesId, introducedVolume: c.introducedVolume, nameJp: c.nameJp, plurality: null }, observationAt, 'model');
      const row = this.getCharacter(id)!;
      if (row.canonical_name_jp === c.nameJp) {
        this.db.run("UPDATE character_name_origins SET origin='model' WHERE character_id=? AND origin='legacy'", [id]);
        const sourceProof = characterSourceProof(this.db, id, sourceIds, eventIds);
        const proof = nameEvidence ? JSON.stringify({ ...JSON.parse(sourceProof), nameEvidence }) : sourceProof;
        this.db.run('INSERT OR IGNORE INTO character_name_observations(id,character_id,name_jp,source_proof,valid_from_para,created_at) VALUES(?,?,?,?,?,?)', [newId(), id, c.nameJp, proof, nameAt, nowIso()]);
      }
      if (row.locked_by_user) return id;
      if (c.gender && c.gender !== 'unknown') saveCharacterFact(this.db, id, 'gender', { gender: c.gender, confidence: c.genderConfidence ?? 0, evidenceIds: evidenceFor('gender') }, atFor('gender'), 'model', evidenceFor('gender'), undefined, fieldQuotes.gender, sourceIds, eventIds);
      for (const [field, value] of [['first_person_type', c.firstPersonType], ['speech_register', c.speechRegister], ['voice_notes', c.voiceNotes], ['plurality', c.plurality]] as const) {
        if (value != null && value !== '' && value !== 'unknown') saveCharacterFact(this.db, id, field, value, atFor(field), 'model', evidenceFor(field), undefined, fieldQuotes[field], sourceIds, eventIds);
      }
      this.refreshCharacterSummary(id);
      return id;
    });
  }
  private refreshCharacterSummary(id: string): void {
    const row = characterAt(this.db, this.getCharacter(id)!, Number.MAX_SAFE_INTEGER);
    this.db.run('UPDATE characters SET gender=?,gender_confidence=?,gender_evidence_ids=?,first_person_type=?,speech_register=?,voice_notes=?,plurality=?,updated_at=? WHERE id=?', [row.gender,row.gender_confidence,row.gender_evidence_ids,row.first_person_type,row.speech_register,row.voice_notes,row.plurality,nowIso(),id]);
  }
  characterAt(row: CharacterRow, at: number): CharacterRow { return characterAt(this.db, row, at); }
  updateCharacter(id: string, patch: Partial<{ nameZh: string | null; gender: string | null; genderConfidence: number | null; firstPersonType: string | null; speechRegister: string | null; voiceNotes: string | null; plurality: string | null; lockedByUser: boolean; isActive: boolean }>, atPara = 0): void {
    if (patch.gender !== undefined && patch.genderConfidence === undefined) patch = { ...patch, genderConfidence: patch.gender && patch.gender !== 'unknown' ? 1 : 0 };
    const sets: string[] = []; const params: (string | number | null)[] = [];
    const map: Record<string, string> = { nameZh: 'canonical_name_zh', gender: 'gender', genderConfidence: 'gender_confidence', firstPersonType: 'first_person_type', speechRegister: 'speech_register', voiceNotes: 'voice_notes', plurality: 'plurality', lockedByUser: 'locked_by_user', isActive: 'is_active' };
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; sets.push(`${map[k]}=?`); params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v); }
    if (!sets.length) return;
    sets.push('updated_at=?'); params.push(nowIso(), id);
    this.db.transaction(() => {
      const before = this.getCharacter(id); if (!before) throw new Error('人物不存在');
      this.db.run(`UPDATE characters SET ${sets.join(',')} WHERE id=?`, params);
      const current = this.getCharacter(id)!;
      if (patch.lockedByUser === true) this.db.run("INSERT OR REPLACE INTO character_name_origins(character_id,origin) VALUES(?,'user')", [id]);
      if (patch.gender !== undefined || patch.genderConfidence !== undefined) saveCharacterFact(this.db, id, 'gender', { gender: current.gender, confidence: current.gender_confidence, evidenceIds: [] }, atPara, 'user', [], before);
      for (const [key, field] of [['firstPersonType','first_person_type'],['speechRegister','speech_register'],['voiceNotes','voice_notes'],['plurality','plurality']] as const) {
        if (Object.hasOwn(patch, key) && patch[key] !== undefined) saveCharacterFact(this.db, id, field as CharacterField, patch[key], atPara, 'user', [], before);
      }
      this.refreshCharacterSummary(id);
    });
  }
  findByName(seriesId: string, nameJp: string, at = Number.MAX_SAFE_INTEGER): CharacterRow | undefined {
    const direct = this.db.get<CharacterRow>('SELECT * FROM characters WHERE series_id=? AND canonical_name_jp=?', [seriesId, nameJp]);
    if (direct) return this.nameCurrent(direct, at) ? direct : undefined;
    const matches = this.db.all<CharacterRow>('SELECT DISTINCT c.* FROM characters c JOIN character_aliases a ON a.character_id=c.id WHERE c.series_id=? AND a.alias_jp=?', [seriesId, nameJp]).filter(c => this.nameCurrent(c, at) && this.aliasesAt(c.id, at).includes(nameJp));
    return matches.length === 1 ? matches[0] : undefined;
  }
  /** Raw profiles remain visible to people; modeled names require a current, dated observation for inference. */
  nameCurrent(row: CharacterRow, at: number): boolean {
    const origin = this.db.get<{origin: string}>('SELECT origin FROM character_name_origins WHERE character_id=?', [row.id]);
    if (!origin || origin.origin === 'user') return true;
    return this.db.all<{source_proof: string}>('SELECT source_proof FROM character_name_observations WHERE character_id=? AND name_jp=? AND valid_from_para<=?', [row.id,row.canonical_name_jp,at]).some(o => characterSourceCurrent(this.db,o.source_proof));
  }
  charactersAt(seriesId: string, at: number): CharacterRow[] {
    return this.listCharacters(seriesId).filter(c => this.nameCurrent(c, at) && (c.is_active || (c.deactivated_at_para ?? Infinity) > at));
  }
  fieldDecisions(id: string) { if (!this.getCharacter(id)) throw new Error('人物不存在'); return fieldDecisions(this.db,id); }
  undoFieldDecision(id: string, editId: number): void { this.db.transaction(() => { undoFieldDecision(this.db,id,editId); this.refreshCharacterSummary(id); }); }
  getCharacterAt(id: string, at: number): CharacterRow | undefined { const row = this.getCharacter(id); return row ? characterAt(this.db, row, at) : undefined; }
  getCharacter(id: string): CharacterRow | undefined { return this.db.get<CharacterRow>('SELECT * FROM characters WHERE id=?', [id]); }
  /**
   * 预读阶段可自动接受的安全别名：只能是主名的确定性变体（全名部件/去称谓后缀/全名加军衔等），
   * 其它 AI 返回的昵称、代号、相关实体一律不自动写入人物档案，必须人工确认。
   */
  static isSafeAutoAlias(canonical: string, alias: string): boolean {
    const raw = alias.trim();
    const strip = (v: string): string => v.trim().replace(/(さん|ちゃん|くん|君|様|さま|先輩|先生|殿|どの|氏|たん|中尉|大尉|少尉|少佐|中佐|大佐|軍曹|伍長|曹長|准尉|魔導少尉|魔導中尉|魔導士官|候補生|一号生|二号生)$/g, '').trim();
    const c = strip(canonical), a = strip(raw);
    if (!c || !a || raw === canonical || KnowledgeRepo.isGenericName(a)) return false;
    if (c === a) return true; // 全名 + 军衔/身份后缀
    const split = (v: string): string[] => v.split(/[・･=＝\s　]+/).filter(Boolean);
    const cp = split(c);
    // 全名的单个部件；或完整主名只增加后缀（白銀のターニャ 不是可确定推导的变体）
    if (cp.length > 1 && cp.includes(a)) return true;
    if (raw.startsWith(c) && a === c) return true;
    // 对没有分隔符的汉字姓名，只接受首/尾部件
    if (!/[ぁ-ゖァ-ヺー]/.test(c) && c.length >= 4 && a.length >= 2 && (c.startsWith(a) || c.endsWith(a))) return true;
    return false;
  }

  /**
   * 不是人名的词：一人称/代词、纯职称军衔、泛称。这些词绝不能成为人物档案名或别名——
   * 一旦入库，名字匹配会把「中隊長」「僕」绑到某个人，造成错误合并与错误称谓归属。
   */
  static isGenericName(name: string): boolean {
    const n = name.replace(/(さん|ちゃん|くん|君|様|さま|殿|どの|氏|たん)$/, '').trim();
    if (n.length === 0) return true;
    if (GENERIC_NAME_WORDS.has(n)) return true;
    // 无片假名/无人名汉字线索、且以职务/身份词结尾（…官/…長/…生/…兵/…尉/…佐/…将/…者/…員/…人）→ 职称而非人名
    if (!/[ァ-ヺー]/.test(n) && /(官|長|生|兵|尉|佐|将|者|員|人|殿|神|様|上司|部下|教官|隊員|士官|少女|少年|老人|老翁|老婆|男|女)$/.test(n)) return true;
    // 纯平假名/短代词
    if (/^[ぁ-ゖー]{1,4}$/.test(n)) return true;
    return false;
  }
  /** 把某个别名提升为主名（旧主名降为别名）。用于修正"AI 把代词当人名、真名被挂成别名"的档案。 */
  setCanonicalName(characterId: string, nameJp: string, automatic = false): void {
    const c = this.getCharacter(characterId); if (!c) throw new Error('人物不存在');
    const name = nameJp.trim(); if (!name) throw new Error('名字为空');
    if (KnowledgeRepo.isGenericName(name)) throw new Error(`「${name}」是代词/职称，不能作为人物主名`);
    const dup = this.db.get<CharacterRow>('SELECT * FROM characters WHERE series_id=? AND canonical_name_jp=?', [c.series_id,name]) ?? this.findByName(c.series_id, name); if (dup && dup.id !== characterId) throw new Error(`「${name}」已属于另一人物`);
    this.db.transaction(() => {
      const alias = this.db.get<{id:string;alias_type:string}>('SELECT id,alias_type FROM character_aliases WHERE character_id=? AND alias_jp=?', [characterId,name]);
      const modeled = automatic && alias?.alias_type === 'pre-read';
      if (modeled) {
        for (const o of this.db.all<{source_proof:string;valid_from_para:number;created_at:string}>('SELECT source_proof,valid_from_para,created_at FROM character_alias_observations WHERE alias_id=?', [alias.id])) {
          this.db.run('INSERT OR IGNORE INTO character_name_observations(id,character_id,name_jp,source_proof,valid_from_para,created_at) VALUES(?,?,?,?,?,?)', [newId(),characterId,name,o.source_proof,o.valid_from_para,o.created_at]);
        }
      }
      this.db.run('DELETE FROM character_aliases WHERE character_id=? AND alias_jp=?', [characterId, name]);
      if (c.canonical_name_jp !== name && !KnowledgeRepo.isGenericName(c.canonical_name_jp)) this.addAlias(characterId, c.canonical_name_jp, 'former-canonical');
      this.db.run('UPDATE characters SET canonical_name_jp=?, updated_at=? WHERE id=?', [name, nowIso(), characterId]);
      this.db.run("INSERT OR REPLACE INTO character_name_origins(character_id,origin) VALUES(?,?)", [characterId,modeled ? 'model' : 'user']);
    });
  }
  removeAlias(characterId: string, aliasJp: string): void { this.db.run('DELETE FROM character_aliases WHERE character_id=? AND alias_jp=?', [characterId, aliasJp]); }
  /**
   * 启动/预读后修复：主名是代词/职称的档案 → 若有真名别名（优先 merged/former-canonical、再取含片假名的最长者）提升为主名；
   * 没有真名的 → 标记失效。同时清掉所有代词/职称类别名。返回处理条数。
   */
  repairGenericNames(seriesId: string): { promoted: string[]; deactivated: string[]; aliasesRemoved: number } {
    const out = { promoted: [] as string[], deactivated: [] as string[], aliasesRemoved: 0 };
    for (const c of this.listCharacters(seriesId)) {
      const rows = this.db.all<{ alias_jp: string; alias_type: string }>('SELECT alias_jp, alias_type FROM character_aliases WHERE character_id=?', [c.id]);
      // 先从旧坏档案的全部非泛称别名中挑真名；不能先按旧主名校验，否则「僕」无法提升到「ターニャ」
      if (KnowledgeRepo.isGenericName(c.canonical_name_jp)) {
        const cands = rows.filter(a => !KnowledgeRepo.isGenericName(a.alias_jp) && (a.alias_type !== 'pre-read' || this.aliasesAt(c.id, Number.MAX_SAFE_INTEGER).includes(a.alias_jp)));
        const pick = cands.filter(a => a.alias_type === 'merged' || a.alias_type === 'former-canonical').sort((x, y) => y.alias_jp.length - x.alias_jp.length)[0]
          ?? cands.filter(a => /[ァ-ヺー]/.test(a.alias_jp)).sort((x, y) => y.alias_jp.length - x.alias_jp.length)[0]
          ?? cands.sort((x, y) => y.alias_jp.length - x.alias_jp.length)[0];
        if (pick) { const old = c.canonical_name_jp; this.setCanonicalName(c.id, pick.alias_jp, true); out.promoted.push(`${old}→${pick.alias_jp}`); }
        else if (c.is_active) { this.updateCharacter(c.id, { isActive: false }); out.deactivated.push(c.canonical_name_jp); }
      }
      // 修正后（或原本就是正常主名）清理所有非用户手动添加的不安全别名
      const now = this.db.all<{ alias_jp: string; alias_type: string }>('SELECT alias_jp, alias_type FROM character_aliases WHERE character_id=?', [c.id]);
      const canonical = this.getCharacter(c.id)?.canonical_name_jp ?? c.canonical_name_jp;
      for (const a of now) if (a.alias_type !== 'user' && (!KnowledgeRepo.isSafeAutoAlias(canonical, a.alias_jp) || KnowledgeRepo.isGenericName(a.alias_jp))) { this.removeAlias(c.id, a.alias_jp); out.aliasesRemoved++; }
    }
    return out;
  }

  /**
   * 名字变体解析：预读/场景分析给出的名字若是某已建档人物的"全名/姓/名/去后缀形"，返回该人物。
   * 规则（确定性，不猜）：把名字按 ・／＝／空格 切成部件，去掉称谓后缀；
   *  - 新名等于某人物（全名或别名）的一个部件 → 同一人（「デグレチャフ」⊂「ターニャ・デグレチャフ」）
   *  - 某人物的全名/别名等于新名的一个部件 → 同一人（「ターニャ」⊂ 新名「ターニャ・デグレチャフ」）
   * 若能匹配到 ≥2 个不同人物（同姓等），返回 ambiguous，不自动合并。
   */
  resolveNameVariant(seriesId: string, nameJp: string, at = Number.MAX_SAFE_INTEGER): { id: string | null; ambiguous: boolean; matchedBy: string | null } {
    const strip = (s: string): string => s.replace(/(さん|ちゃん|くん|君|様|さま|先輩|先生|殿|どの|氏|たん)$/, '').trim();
    const parts = (s: string): string[] => strip(s).split(/[・･=＝\s　]+/).map(x => x.trim()).filter(x => x.length >= 2 && !KnowledgeRepo.isGenericName(x));
    const target = strip(nameJp); if (target.length < 2 || KnowledgeRepo.isGenericName(target)) return { id: null, ambiguous: false, matchedBy: null };
    const targetParts = parts(nameJp);
    const hits = new Map<string, string>();
    for (const c of this.charactersAt(seriesId, at)) {
      const names = [c.canonical_name_jp, ...this.aliasesAt(c.id, at)];
      for (const n of names) {
        const np = parts(n); const ns = strip(n);
        if (ns === target) { hits.set(c.id, n); break; }
        if (np.length > 1 && np.includes(target)) { hits.set(c.id, n); break; }          // 新名是某全名的一部分
        if (targetParts.length > 1 && targetParts.includes(ns)) { hits.set(c.id, n); break; } // 某已有名是新全名的一部分
      }
    }
    if (hits.size === 1) { const [id, by] = [...hits.entries()][0]!; return { id, ambiguous: false, matchedBy: by }; }
    return { id: null, ambiguous: hits.size > 1, matchedBy: null };
  }

  /**
   * 把 dropId 合并进 keepId：别名/状态/关系/称呼轨迹/场景分析/事件/术语变体/知识变化/队列 payload 全部改指 keepId，
   * drop 的日文名变为 keep 的别名，keep 为空的档案字段用 drop 的补齐，语癖取并集，最后删除 drop。
   */
  mergeCharacters(keepId: string, dropId: string): { aliasAdded: string | null } {
    if (keepId === dropId) return { aliasAdded: null };
    const keep = this.getCharacter(keepId), drop = this.getCharacter(dropId);
    if (!keep || !drop) throw new Error('人物不存在');
    if (keep.series_id !== drop.series_id) throw new Error('不能跨系列合并');
    return this.db.transaction(() => {
      const t = nowIso();
      // 档案字段：keep 为空则取 drop
      this.db.run(`UPDATE characters SET canonical_name_zh=COALESCE(canonical_name_zh,?), gender=COALESCE(gender,?), gender_confidence=COALESCE(gender_confidence,?), gender_evidence_ids=COALESCE(gender_evidence_ids,?),
        first_person_type=COALESCE(first_person_type,?), speech_register=COALESCE(speech_register,?), voice_notes=COALESCE(voice_notes,?), updated_at=? WHERE id=?`,
        [drop.canonical_name_zh, drop.gender, drop.gender_confidence, drop.gender_evidence_ids, drop.first_person_type, drop.speech_register, drop.voice_notes, t, keepId]);
      // 语癖并集（按 trigger_form 去重，keep 优先）
      const q = this.quirks(keepId); const seen = new Set(q.map(x => x.trigger_form));
      for (const x of this.quirks(dropId)) if (!seen.has(x.trigger_form)) q.push(x);
      this.setQuirks(keepId, q);
      // 别名：drop 的名字与别名都成为 keep 的别名
      const keepNames = new Set([keep.canonical_name_jp, ...this.aliasesOf(keepId)]);
      let aliasAdded: string | null = null;
      if (!keepNames.has(drop.canonical_name_jp)) {
        const origin = this.db.get<{origin:string}>('SELECT origin FROM character_name_origins WHERE character_id=?', [dropId])?.origin;
        const modeled = origin === 'model' || origin === 'legacy';
        if (modeled) {
          const aliasId = newId();
          this.db.run("INSERT INTO character_aliases(id,character_id,alias_jp,alias_zh,alias_type) VALUES(?,?,?,?,'pre-read')", [aliasId,keepId,drop.canonical_name_jp,drop.canonical_name_zh]);
          for (const o of this.db.all<{source_proof:string;valid_from_para:number;created_at:string}>('SELECT source_proof,valid_from_para,created_at FROM character_name_observations WHERE character_id=? AND name_jp=?', [dropId,drop.canonical_name_jp])) {
            this.db.run('INSERT OR IGNORE INTO character_alias_observations(id,alias_id,source_proof,valid_from_para,created_at) VALUES(?,?,?,?,?)', [newId(),aliasId,o.source_proof,o.valid_from_para,o.created_at]);
          }
        } else this.addAlias(keepId, drop.canonical_name_jp, 'merged', drop.canonical_name_zh);
        aliasAdded = drop.canonical_name_jp; keepNames.add(drop.canonical_name_jp);
      }
      // Merging people is not fresh original evidence for their automatic aliases.
      // Move those rows with their observation history rather than promoting them to manual aliases.
      this.db.run("UPDATE character_aliases SET character_id=? WHERE character_id=? AND alias_type='pre-read'", [keepId, dropId]);
      for (const a of this.aliasesOf(dropId)) if (!keepNames.has(a)) { this.addAlias(keepId, a, 'merged'); keepNames.add(a); }
      this.db.run('DELETE FROM character_aliases WHERE character_id=?', [dropId]);
      // 直接外键列
      const conflicts = this.db.get(`SELECT 1 FROM character_field_history a JOIN character_field_history b ON a.field=b.field AND a.valid_from_para=b.valid_from_para AND a.origin=b.origin WHERE a.character_id=? AND b.character_id=? AND a.value_json<>b.value_json`, [keepId, dropId]);
      if (conflicts) throw new Error('人物字段历史存在同位置冲突，请先核对后再合并');
      this.db.run(`INSERT OR IGNORE INTO character_field_history(character_id,field,value_json,valid_from_para,origin,evidence_ids,created_at,source_quotes,source_proof) SELECT ?,field,value_json,valid_from_para,origin,evidence_ids,created_at,source_quotes,source_proof FROM character_field_history WHERE character_id=?`, [keepId, dropId]);
      this.db.run('UPDATE character_field_archive SET character_id=? WHERE character_id=?', [keepId, dropId]);
      this.db.run('UPDATE character_states SET character_id=? WHERE character_id=?', [keepId, dropId]);
      this.db.run('UPDATE paragraph_analysis SET speaker_char_id=? WHERE speaker_char_id=?', [keepId, dropId]);
      this.db.run('UPDATE relationships SET from_char_id=? WHERE from_char_id=?', [keepId, dropId]);
      this.db.run('UPDATE relationships SET to_char_id=? WHERE to_char_id=?', [keepId, dropId]);
      this.db.run('DELETE FROM relationships WHERE from_char_id=to_char_id', []);
      this.db.run('UPDATE address_trajectories SET speaker_char_id=? WHERE speaker_char_id=?', [keepId, dropId]);
      this.db.run('UPDATE address_trajectories SET target_char_id=? WHERE target_char_id=?', [keepId, dropId]);
      this.db.run('DELETE FROM address_trajectories WHERE speaker_char_id=target_char_id', []);
      this.db.run('UPDATE term_variants SET speaker_char_id=? WHERE speaker_char_id=?', [keepId, dropId]);
      this.db.run('UPDATE term_variants SET target_char_id=? WHERE target_char_id=?', [keepId, dropId]);
      this.db.run('UPDATE knowledge_boundaries SET character_id=? WHERE character_id=?', [keepId, dropId]);
      this.db.run(`UPDATE knowledge_change_candidates SET entity_id=? WHERE entity_id=? AND entity_type='character'`, [keepId, dropId]);
      this.db.run("UPDATE review_queue SET payload=json_set(payload,'$.identityInvalidated',json('true')) WHERE json_extract(payload,'$.subtype')='character-field' AND json_extract(payload,'$.characterId') IN (?,?)", [keepId,dropId]);
      this.db.run("UPDATE review_queue SET payload=json_set(payload,'$.knowledgeDecision.invalidated',json('true')) WHERE json_extract(payload,'$.knowledgeDecision') IS NOT NULL AND (payload LIKE ? OR payload LIKE ?)", [`%${keepId}%`,`%${dropId}%`]);
      // JSON 列里的 id（uuid 全局唯一，直接文本替换安全）
      for (const [table, col] of [['paragraph_analysis', 'target_char_ids'], ['paragraph_analysis', 'present_char_ids'], ['narrative_events', 'character_ids'], ['review_queue', 'payload']] as const) {
        this.db.run(`UPDATE ${table} SET ${col}=REPLACE(${col}, ?, ?) WHERE ${col} LIKE ?`, [dropId, keepId, `%${dropId}%`]);
      }
      this.db.run('DELETE FROM character_field_baselines WHERE character_id IN (?,?)', [keepId,dropId]);
      this.db.run('UPDATE character_field_edits SET invalidated=1 WHERE character_id IN (?,?)', [keepId,dropId]);
      this.db.run('UPDATE character_field_edits SET character_id=? WHERE character_id=?', [keepId,dropId]);
      this.refreshCharacterSummary(keepId);
      this.db.run('DELETE FROM characters WHERE id=?', [dropId]);
      return { aliasAdded };
    });
  }

  /**
   * 术语表里确认了某个人名的译名 → 同步到人物档案的中文名（仅当档案中文名为空且未被用户锁定）。
   * 预读只建日文档案，中文名本来只存在术语表里，人物页会一直显示"未定"；这里补上单向同步。
   * 返回是否写入。
   */
  syncNameZhFromTerm(seriesId: string, termJp: string, zh: string | null): boolean {
    if (!zh) return false;
    const c = this.findByName(seriesId, termJp);
    if (!c || c.canonical_name_jp !== termJp || c.canonical_name_zh || c.locked_by_user) return false;
    this.updateCharacter(c.id, { nameZh: zh });
    return true;
  }
  listCharacters(seriesId: string): CharacterRow[] { return this.db.all<CharacterRow>('SELECT * FROM characters WHERE series_id=? ORDER BY introduced_volume, created_at', [seriesId]); }
  listCharacterViews(seriesId: string): CharacterView[] {
    return this.listCharacters(seriesId).map(r => this.toView(characterAt(this.db, r, Number.MAX_SAFE_INTEGER)));
  }
  toView(r: CharacterRow): CharacterView {
    return { id: r.id, nameJp: r.canonical_name_jp, nameZh: r.canonical_name_zh, gender: r.gender, genderConfidence: r.gender_confidence,
      firstPersonType: r.first_person_type, speechRegister: r.speech_register, voiceNotes: r.voice_notes,
      quirkProfiles: fromJson<QuirkProfile[]>(r.quirk_profiles, []), isActive: !!r.is_active, lockedByUser: !!r.locked_by_user, lockedFields: this.db.all<{field: string}>("SELECT DISTINCT field FROM character_field_history WHERE character_id=? AND origin='user'", [r.id]).map(f => f.field), introducedVolume: r.introduced_volume };
  }
  addAlias(characterId: string, aliasJp: string, aliasType: string, aliasZh: string | null = null, sourceIds: string[] = [], eventIds: string[] = []): void {
    this.db.transaction(() => {
      const existing = this.db.get<{id: string; alias_type: string}>('SELECT id,alias_type FROM character_aliases WHERE character_id=? AND alias_jp=?', [characterId, aliasJp]);
      const aliasId = existing?.id ?? newId();
      if (!existing) this.db.run('INSERT INTO character_aliases(id,character_id,alias_jp,alias_zh,alias_type) VALUES(?,?,?,?,?)', [aliasId, characterId, aliasJp, aliasZh, aliasType]);
      // An explicit human adoption must be able to promote a previously automatic alias.
      else if (aliasType === 'user') this.db.run("UPDATE character_aliases SET alias_type='user' WHERE id=?", [aliasId]);
      if (aliasType !== 'pre-read' || (existing && existing.alias_type !== 'pre-read')) return;
      const proof = characterSourceProof(this.db, characterId, sourceIds, eventIds);
      const at = Math.max(...sourceIds.map(id => this.db.get<{series_ordinal: number}>('SELECT series_ordinal FROM paragraphs WHERE id=?', [id])!.series_ordinal));
      this.db.run('INSERT OR IGNORE INTO character_alias_observations(id,alias_id,source_proof,valid_from_para,created_at) VALUES(?,?,?,?,?)', [newId(), aliasId, proof, at, nowIso()]);
    });
  }
  aliasesAt(characterId: string, at: number): string[] {
    return [...new Set(this.db.all<{id: string; alias_jp: string; alias_type: string}>('SELECT id,alias_jp,alias_type FROM character_aliases WHERE character_id=? AND (valid_from_para IS NULL OR valid_from_para<=?) AND (valid_to_para IS NULL OR valid_to_para>?)', [characterId,at,at])
      .filter(alias => alias.alias_type !== 'pre-read' || this.db.all<{source_proof: string}>('SELECT source_proof FROM character_alias_observations WHERE alias_id=? AND valid_from_para<=?', [alias.id,at]).some(observation => characterSourceCurrent(this.db, observation.source_proof)))
      .map(r => r.alias_jp))];
  }
  aliasesOf(characterId: string): string[] { return this.db.all<{ alias_jp: string }>('SELECT alias_jp FROM character_aliases WHERE character_id=?', [characterId]).map(r => r.alias_jp); }

  quirks(characterId: string): QuirkProfile[] { return fromJson<QuirkProfile[]>(this.getCharacter(characterId)?.quirk_profiles, []); }
  setQuirks(characterId: string, quirks: QuirkProfile[]): void { this.db.run('UPDATE characters SET quirk_profiles=?, updated_at=? WHERE id=?', [JSON.stringify(quirks), nowIso(), characterId]); }
  /** 用户确认语癖：写入档案并锁定 */
  confirmQuirk(characterId: string, q: Omit<QuirkProfile, 'quirk_id' | 'confirmed_by_user'>): QuirkProfile {
    const list = this.quirks(characterId).filter(x => x.trigger_form !== q.trigger_form);
    const item: QuirkProfile = { ...q, quirk_id: newId(), confirmed_by_user: true };
    list.push(item); this.setQuirks(characterId, list); return item;
  }

  addState(s: { characterId: string; stateType: string; description: string; validFromPara: number; validToPara?: number | null; evidenceIds?: string[]; mayLeakToReader?: boolean; translatorOnly?: boolean }): string {
    const id = newId();
    this.db.run('INSERT INTO character_states(id,character_id,state_type,description,valid_from_para,valid_to_para,evidence_ids,may_leak_to_reader,is_translator_only) VALUES(?,?,?,?,?,?,?,?,?)',
      [id, s.characterId, s.stateType, s.description, s.validFromPara, s.validToPara ?? null, toJson(s.evidenceIds), s.mayLeakToReader === false ? 0 : 1, s.translatorOnly ? 1 : 0]);
    return id;
  }
  statesAt(characterIds: string[], atPara: number): { character_id: string; state_type: string; description: string; is_translator_only: number }[] {
    if (!characterIds.length) return [];
    const q = characterIds.map(() => '?').join(',');
    return this.db.all(`SELECT character_id, state_type, description, is_translator_only FROM character_states WHERE character_id IN (${q}) AND valid_from_para<=? AND (valid_to_para IS NULL OR valid_to_para>?) ORDER BY valid_from_para`, [...characterIds, atPara, atPara]);
  }

  addEvent(e: { seriesId: string; summaryJp: string; atPara: number; revealsToReader: boolean; characterIds: string[]; evidenceIds: string[] }): string {
    const id = newId();
    this.db.run('INSERT INTO narrative_events(id,series_id,summary_jp,at_para,reveals_to_reader,character_ids,evidence_ids,created_at) VALUES(?,?,?,?,?,?,?,?)',
      [id, e.seriesId, e.summaryJp, e.atPara, e.revealsToReader ? 1 : 0, JSON.stringify(e.characterIds), JSON.stringify(e.evidenceIds), nowIso()]);
    bindNarrativeSources(this.db, 'event', id, e.evidenceIds);
    return id;
  }
  eventsBefore(seriesId: string, atPara: number, limit: number, characterIds?: string[]): { summary_jp: string; summary_zh: string | null; at_para: number; reveals_to_reader: number; character_ids: string | null }[] {
    return previousNarrativeEvents(this.db, seriesId, atPara, limit, characterIds);
  }

  addRelationship(r: { seriesId: string; fromCharId: string; toCharId: string; eventType: string; descriptionJp: string; intimacy?: number | null; respect?: number | null; powerDistance?: number | null; formality?: number | null; validFromPara: number; evidenceIds?: string[] }): string {
    const id = newId();
    this.db.run('INSERT INTO relationships(id,series_id,from_char_id,to_char_id,event_type,description_jp,intimacy_level,respect_level,power_distance,formality_level,valid_from_para,evidence_ids,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, r.seriesId, r.fromCharId, r.toCharId, r.eventType, r.descriptionJp, r.intimacy ?? null, r.respect ?? null, r.powerDistance ?? null, r.formality ?? null, r.validFromPara, toJson(r.evidenceIds), nowIso()]);
    bindNarrativeSources(this.db, 'relationship', id, r.evidenceIds ?? []);
    return id;
  }
  relationshipsAt(seriesId: string, characterIds: string[], atPara: number): RelationshipRow[] {
    if (!characterIds.length) return [];
    const q = characterIds.map(() => '?').join(',');
    const rows = this.db.all<RelationshipRow>(`SELECT * FROM relationships WHERE series_id=? AND from_char_id IN (${q}) AND to_char_id IN (${q}) AND valid_from_para<=? ORDER BY valid_from_para DESC,created_at DESC,rowid DESC`, [seriesId, ...characterIds, ...characterIds, atPara]);
    const latest = new Map<string, RelationshipRow>();
    for (const r of rows) if (narrativeSourceCurrent(this.db, 'relationship', r.id)) {
      const key = JSON.stringify([r.from_char_id, r.to_char_id]);
      if (!latest.has(key)) latest.set(key, r);
    }
    return [...latest.values()].filter(r => r.valid_to_para === null || r.valid_to_para > atPara);
  }
  relationshipViews(seriesId: string): (RelationshipRow & { from_name: string; to_name: string })[] {
    return this.db.all<RelationshipRow & { from_name: string; to_name: string }>(`SELECT r.*, COALESCE(a.canonical_name_zh,a.canonical_name_jp) from_name, COALESCE(b.canonical_name_zh,b.canonical_name_jp) to_name FROM relationships r JOIN characters a ON a.id=r.from_char_id JOIN characters b ON b.id=r.to_char_id WHERE r.series_id=? ORDER BY r.valid_from_para`, [seriesId]);
  }

  addAddress(a: { seriesId: string; speakerCharId: string; targetCharId: string; sourceFormJp: string; translatedForm: string; relationStage?: string | null; sceneScope?: string | null; allowVariation?: boolean; validFromPara: number; confirmedByUser: boolean; evidenceIds?: string[] }): string {
    const id = newId();
    this.db.run('INSERT INTO address_trajectories(id,series_id,speaker_char_id,target_char_id,source_form_jp,translated_form,relation_stage,scene_scope,allow_variation,valid_from_para,confirmed_by_user,evidence_ids,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, a.seriesId, a.speakerCharId, a.targetCharId, a.sourceFormJp, a.translatedForm, a.relationStage ?? null, a.sceneScope ?? null, a.allowVariation ? 1 : 0, a.validFromPara, a.confirmedByUser ? 1 : 0, toJson(a.evidenceIds), nowIso()]);
    return id;
  }
  activeAddress(seriesId: string, speakerCharId: string, targetCharId: string, sourceFormJp: string, atPara: number): AddressRow | undefined {
    return this.db.get<AddressRow>('SELECT * FROM address_trajectories WHERE series_id=? AND speaker_char_id=? AND target_char_id=? AND source_form_jp=? AND valid_from_para<=? AND (valid_to_para IS NULL OR valid_to_para>?) ORDER BY valid_from_para DESC LIMIT 1', [seriesId, speakerCharId, targetCharId, sourceFormJp, atPara, atPara]);
  }
  isAddressAdopted(address: AddressRow | undefined): boolean {
    if (!address) return false;
    return !!address.confirmed_by_user || !!this.db.get("SELECT id FROM review_queue WHERE status='resolved' AND json_extract(payload,'$.automaticAddressDecision.addressId')=? AND json_extract(payload,'$.knowledgeDecision.undoneAt') IS NULL", [address.id]);
  }
  /** 任一说话人对某个原文称呼形式的已确认译法（说话人未知时回退用） */
  anyAddressForForm(seriesId: string, sourceFormJp: string): AddressRow[] {
    return this.db.all<AddressRow>('SELECT * FROM address_trajectories WHERE series_id=? AND source_form_jp=? AND confirmed_by_user=1 AND valid_to_para IS NULL', [seriesId, sourceFormJp]);
  }
  addressesFor(seriesId: string, characterIds: string[], atPara: number): AddressRow[] {
    if (!characterIds.length) return [];
    const q = characterIds.map(() => '?').join(',');
    return this.db.all<AddressRow>(`SELECT * FROM address_trajectories WHERE series_id=? AND (speaker_char_id IN (${q}) OR target_char_id IN (${q})) AND valid_from_para<=? AND (valid_to_para IS NULL OR valid_to_para>?)`, [seriesId, ...characterIds, ...characterIds, atPara, atPara]);
  }
  listAddressViews(seriesId: string): AddressTrajectoryView[] {
    return this.db.all<AddressRow & { speaker_name: string; target_name: string }>(`SELECT a.*, COALESCE(s.canonical_name_zh,s.canonical_name_jp) speaker_name, COALESCE(t.canonical_name_zh,t.canonical_name_jp) target_name FROM address_trajectories a JOIN characters s ON s.id=a.speaker_char_id JOIN characters t ON t.id=a.target_char_id WHERE a.series_id=? ORDER BY a.valid_from_para`, [seriesId])
      .map(r => ({ id: r.id, speakerId: r.speaker_char_id, speakerName: r.speaker_name, targetId: r.target_char_id, targetName: r.target_name, sourceFormJp: r.source_form_jp, translatedForm: r.translated_form, relationStage: r.relation_stage, allowVariation: !!r.allow_variation, confirmedByUser: !!r.confirmed_by_user, automaticallyAdopted: !r.confirmed_by_user && this.isAddressAdopted(r), validFromPara: r.valid_from_para, validToPara: r.valid_to_para }));
  }
  setAddressVariation(id: string, allow: boolean): void { this.db.run('UPDATE address_trajectories SET allow_variation=? WHERE id=?', [allow ? 1 : 0, id]); }
  endAddress(id: string, atPara: number): void { this.db.run('UPDATE address_trajectories SET valid_to_para=? WHERE id=?', [atPara, id]); }

  addChangeCandidate(c: { seriesId: string; entityType: string; entityId: string; changeType: string; description: string; triggeredAtPara: number; proposedValidToPara?: number | null; evidenceIds?: string[] }, sourceIds = c.evidenceIds ?? [], eventIds: string[] = []): string {
    return this.db.transaction(() => {
      changeTarget(this.db, c.entityType, c.entityId, c.seriesId);
      if (!Number.isSafeInteger(c.triggeredAtPara) || c.triggeredAtPara < 0 || !c.evidenceIds?.length || c.evidenceIds.some(id => !sourceIds.includes(id))) throw new Error('知识变化缺少正确的证据位置');
      const evidenceAt = Math.max(...c.evidenceIds.map(id => this.db.get<{series_ordinal: number}>('SELECT series_ordinal FROM paragraphs WHERE id=?', [id])?.series_ordinal ?? -1));
      if (evidenceAt !== c.triggeredAtPara) throw new Error('知识变化位置必须对应所引证据');
      const until = c.proposedValidToPara ?? c.triggeredAtPara;
      if (!Number.isSafeInteger(until) || until < c.triggeredAtPara) throw new Error('知识变化不能提前于证据生效');
      const identical = this.db.get<{id:string}>(`SELECT c.id FROM knowledge_change_candidates c JOIN knowledge_change_proofs p ON p.candidate_id=c.id
        WHERE c.series_id=? AND c.entity_type=? AND c.entity_id=? AND c.change_type=? AND c.description=? AND c.triggered_at_para=? AND COALESCE(c.proposed_valid_to_para,c.triggered_at_para)=?
        AND c.status IN ('pending','accepted','rejected') AND p.source_proof=? AND p.target_snapshot=? LIMIT 1`,
      [c.seriesId,c.entityType,c.entityId,c.changeType,c.description,c.triggeredAtPara,until,originalSourceProof(this.db,c.seriesId,sourceIds,eventIds),changeTarget(this.db,c.entityType,c.entityId,c.seriesId)]);
      if (identical) return identical.id;
      const id = newId();
      this.db.run('INSERT INTO knowledge_change_candidates(id,series_id,entity_type,entity_id,change_type,description,triggered_at_para,proposed_valid_to_para,evidence_ids,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [id, c.seriesId, c.entityType, c.entityId, c.changeType, c.description, c.triggeredAtPara, c.proposedValidToPara ?? null, toJson(c.evidenceIds), nowIso()]);
      bindChangeProof(this.db, id, c.seriesId, c.entityType, c.entityId, sourceIds, eventIds);
      return id;
    });
  }
  resolveChangeCandidate(id: string, accept: boolean, expectedSeries?: string): void {
    this.db.transaction(() => {
      const c = this.db.get<{ series_id: string; status: string; entity_type: string; entity_id: string; proposed_valid_to_para: number | null; triggered_at_para: number }>('SELECT * FROM knowledge_change_candidates WHERE id=?', [id]);
      if (!c || (expectedSeries && c.series_id !== expectedSeries)) throw new Error('知识变化候选不存在或不属于当前作品');
      if (c.status !== 'pending') throw new Error('该候选已处理，请刷新列表');
      if (accept) {
        verifyChangeProof(this.db, id, c.series_id, c.entity_type, c.entity_id);
        const until = c.proposed_valid_to_para ?? c.triggered_at_para;
        if (!Number.isSafeInteger(until) || until < c.triggered_at_para) throw new Error('知识变化生效位置无效');
        const table = changeTables[c.entity_type as keyof typeof changeTables];
        const result = c.entity_type === 'character'
          ? this.db.run('UPDATE characters SET is_active=0, deactivated_at_para=? WHERE id=?', [until, c.entity_id])
          : c.entity_type === 'relationship' ? endObservedRelationship(this.db, c.entity_id, until)
            : this.db.run(`UPDATE ${table} SET valid_to_para=? WHERE id=?`, [until, c.entity_id]);
        if (result.changes !== 1) throw new Error('知识变化未写入目标，不能标记成功');
      }
      this.db.run('UPDATE knowledge_change_candidates SET status=? WHERE id=?', [accept ? 'accepted' : 'rejected', id]);
    });
  }
}
