/**
 * 各工位输出协议（docs/标准/TRANSLATION_RULES.md 第九节）。
 * “完整通过或完整拒绝”：JSON 无法解析、根类型错误、必需字段缺失、ID 集合不等，一律返回失败码供重试。
 */
import { z } from 'zod';
import { isExplicitNonFinding } from './reviewEvidence';
import { guardGender } from '../validation/genderEvidence';
import { isHanOnlyTerm, normalizeTermGranularity } from '../validation/termGranularity';
import type { WorkstationId } from '@shared/types';

export type ProtocolErrorCode = 'EMPTY_RESPONSE' | 'INVALID_JSON' | 'INVALID_SHAPE' | 'PARTIAL_ID_SET' | 'POLLUTION';
export interface ProtocolError { code: ProtocolErrorCode; message: string; details?: unknown }
export type ProtocolResult<T> = { ok: true; value: T } | { ok: false; error: ProtocolError };

const conf = z.number().min(0).max(1);
const level = z.preprocess(
  (v) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
    // 模型把七轴输出成任意字符串描述时，容错为 'unknown'（触发人工/退出快速路径），而不是拒签整份输出
    return 'unknown';
  },
  z.union([z.number().int().min(0).max(4), z.literal('unknown')]),
);
export const toneAxesSchema = z.object({
  detail: level, explicitness: level, vulgarity: level, aggression: level,
  offensiveness: level, taboo_directness: level, emotional_intensity: level,
});
const idList = z.array(z.string()).default([]);
const nullableStr = z.string().nullable();

export const flagSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('foreign-note'), source_quote: z.string().trim().min(1).max(300), gloss_zh: z.string().trim().min(1).max(600), rationale: z.string().trim().min(1).max(600) }).strict(),
  z.object({ type: z.literal('katakana-ambiguity'), term: z.string(), inferred: z.string(), confidence: conf, evidence: z.string().optional() }),
  z.object({ type: z.literal('glossary-sense'), term: z.string(), sense_id: z.string().optional(), used_zh: z.string().optional(), confidence: conf }),
  z.object({ type: z.literal('glossary-deviation'), term: z.string(), glossary_zh: z.string(), used_zh: z.string(), rationale: z.string(), confidence: conf }),
  z.object({ type: z.literal('glossary-conflict'), term: z.string(), glossary_zh: z.string(), believed_zh: z.string(), rationale: z.string() }),
  z.object({ type: z.literal('wordplay'), original: z.string(), variant: z.string(), meaning: z.string(), proposal: nullableStr.default(null), rationale: z.string().default(''), confidence: conf }),
  z.object({ type: z.literal('quirk-candidate'), character_id: nullableStr.default(null), character_name: z.string().optional(), trigger_form: z.string(), proposed_pattern: z.string(), signal: z.enum(['default', 'strong', 'consistency']) }),
  z.object({ type: z.literal('honorific-first'), speaker_char_id: nullableStr.default(null), target_char_id: nullableStr.default(null), speaker_name: z.string().optional(), target_name: z.string().optional(), source_form_jp: z.string(), used_zh: z.string().optional() }),
  z.object({ type: z.literal('first-person-shift'), character_id: nullableStr.default(null), from: z.string(), to: z.string() }),
  z.object({ type: z.literal('logic-conflict'), note: z.string() }),
]);
export type ParsedFlag = z.infer<typeof flagSchema>;

export const translationItemSchema = z.object({
  id: z.string(),
  translation: z.string(),
  source_coverage: z.array(z.object({ segment: z.string(), rendered_as: z.string(), status: z.enum(['covered', 'uncertain', 'restructured']), ord: z.number().int().positive().optional() })).default([]),
  tone_axes: toneAxesSchema.optional(),
  flags: z.array(flagSchema).default([]),
});
export const translationOutputSchema = z.object({ items: z.array(translationItemSchema) });
export type TranslationOutput = z.infer<typeof translationOutputSchema>;
export type TranslationItem = z.infer<typeof translationItemSchema>;

export const FINDING_TYPES = ['omission', 'addition', 'reversal', 'sanitization', 'weakening', 'intensification', 'gender', 'plural', 'number', 'speaker_error', 'address_inconsistency', 'term_drift', 'glossary_deviation', 'glossary_conflict', 'voice_drift', 'other'] as const;
export const reviewOutputSchema = z.object({
  reviewed_ids: z.array(z.string()).min(1),
  findings: z.array(z.object({
    block_id: z.string(),
    type: z.enum(FINDING_TYPES),
    severity: z.enum(['blocks_export', 'warning', 'info']),
    evidence_jp: z.string().default(''),
    evidence_zh: z.string().default(''),
    description: z.string(),
    suggested_fix: z.string().nullable().optional(),
  })),
  tone_axes_source: toneAxesSchema.optional(),
  tone_axes_translation: toneAxesSchema.optional(),
  recheck_requests: z.array(z.object({ series_ordinal: z.number().int(), reason: z.string() })).default([]),
});
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

export const INTENTS = ['sincere', 'teasing', 'sarcastic', 'provoking', 'comforting', 'concealing', 'distancing', 'other'] as const;
export const sceneOutputSchema = z.object({
  paragraphs: z.array(z.object({
    id: z.string(),
    speaker_char_id: nullableStr.default(null),
    speaker_name: z.string().nullable().optional(),
    speaker_confidence: conf.default(0),
    target_char_ids: idList,
    present_char_ids: idList,
    intent: z.enum(INTENTS).default('other'),
    difficulty_flags: z.array(z.string()).default([]),
    scene_boundary_before: z.boolean().default(false),
    atmosphere: z.string().default(''),
    evidence_ids: idList,
  })),
});
export type SceneOutput = z.infer<typeof sceneOutputSchema>;

export const honorificOutputSchema = z.object({
  speaker_char_id: nullableStr.default(null),
  target_char_id: nullableStr.default(null),
  source_form_jp: z.string(),
  relation_stage: z.string().default(''),
  candidates: z.array(z.object({ zh: z.string(), register: z.enum(['intimate', 'neutral', 'formal', 'mocking']).default('neutral'), rationale: z.string().default('') })).min(1),
  recommended: z.string(),
  evidence_ids: idList,
});
export type HonorificOutput = z.infer<typeof honorificOutputSchema>;

export const preReadOutputSchema = z.object({
  reviewed_ids: z.array(z.string()).min(1),
  characters: z.array(z.object({
    name_jp: z.string(), aliases: z.array(z.string()).default([]),
    name_evidence: z.object({ paragraph_id: z.string(), quote: z.string().min(1) }).strict().optional(),
    gender: z.enum(['male', 'female', 'unknown']).default('unknown'), gender_confidence: conf.default(0),
    /** 性别判断依据：必须引用原文中的具体词语（彼/彼女/少女/少年/娘/息子/お嬢様/母/父/一人称+语尾…）；为空或仅凭名字 → 程序强制 unknown */
    gender_evidence: z.string().default(''),
    first_person_type: z.enum(['boku', 'ore', 'watashi', 'atashi', 'uchi', 'washi', 'sessha', 'unknown']).default('unknown'),
    speech_register: z.enum(['formal', 'casual', 'rough', 'noble', 'archaic', 'childlike', 'unknown']).default('unknown'),
    voice_notes: z.string().default(''), evidence_ids: idList,
    field_evidence: z.array(z.object({ field: z.enum(['first_person_type', 'speech_register', 'voice_notes']), paragraph_id: z.string(), quote: z.string().min(1) })).default([]),
    /** 预读阶段的语癖候选：只报该人物对话中反复出现（≥3 次）、区别于标准礼貌体的句尾/口头禅；程序会核对出现次数 */
    quirk_candidates: z.array(z.object({ trigger_form: z.string(), proposed_pattern: z.string().default(''), evidence_ids: idList, note: z.string().default('') })).default([]),
  })),
  relationship_events: z.array(z.object({
    from_name_jp: z.string(), to_name_jp: z.string(), event_type: z.string(), description_jp: z.string(),
    intimacy_level: z.number().int().min(0).max(10).nullable().default(null), respect_level: z.number().int().min(0).max(10).nullable().default(null),
    power_distance: z.number().int().min(-10).max(10).nullable().default(null), formality_level: z.number().int().min(0).max(10).nullable().default(null),
    at_para: z.number().int(), evidence_ids: idList,
  })),
  plot_events: z.array(z.object({ summary_jp: z.string(), at_para: z.number().int(), reveals_to_reader: z.boolean().default(true), character_names: z.array(z.string()).default([]), evidence_ids: idList })),
  knowledge_change_candidates: z.array(z.object({ entity_type: z.enum(['character', 'character_state', 'relationship', 'address', 'term']), entity_name_jp: z.string(), change_type: z.enum(['stale', 'contradicted', 'superseded']), description: z.string(), evidence_ids: idList })),
});
export type PreReadOutput = z.infer<typeof preReadOutputSchema>;

export const TERM_TYPES = ['person', 'place', 'organization', 'ability', 'item', 'concept', 'honorific', 'other'] as const;
const termType = z.preprocess(
  (v) => {
    // 容错：模型输出不在枚举中的term_type时，转换为'other'而不是拒签整份输出
    if (typeof v === 'string' && v.trim() !== '') {
      const normalized = v.trim().toLowerCase();
      if (TERM_TYPES.includes(normalized as any)) return normalized;
    }
    return 'other';
  },
  z.enum(TERM_TYPES),
);
export const termExtractOutputSchema = z.object({
  reviewed_ids: z.array(z.string()).min(1),
  terms: z.array(z.object({
    term_jp: z.string().min(1), term_type: termType, sense_identity: z.string().default(''),
    occurrence_paragraph_ids: idList, split_suggestion: z.string().nullable().default(null), confidence: conf.default(0.5), conflicts: z.array(z.string()).default([]),
    components: z.array(z.object({ term_jp: z.string().min(1), term_type: termType })).max(6).default([]),
    split_preserves_meaning: z.boolean().default(false), split_reason: z.string().default(''),
  })),
});
export type TermExtractOutput = z.infer<typeof termExtractOutputSchema>;

export const termProposalOutputSchema = z.object({
  proposals: z.array(z.object({
    term_jp: z.string(),
    candidates: z.array(z.object({ zh: z.string(), basis: z.enum(['phonetic', 'semantic', 'official']).default('semantic'), pros: z.string().default(''), cons: z.string().default('') })).min(1),
    variants: z.array(z.object({ variant_jp: z.string(), zh: z.string(), variant_type: z.enum(['honorific', 'nickname', 'codename', 'contextual']), speaker_name_jp: z.string().nullable().default(null), target_name_jp: z.string().nullable().default(null), relation_stage: z.string().nullable().default(null), scene_scope: z.string().nullable().default(null), evidence_ids: idList })).default([]),
    annotation_draft: z.object({ anchor_paragraph_id: z.string(), text: z.string() }).nullable().default(null),
  })).default([]),
});
export type TermProposalOutput = z.infer<typeof termProposalOutputSchema>;

const POLLUTION_RE = /^(以下是|下面是|好的[，,]|Sure|Certainly|Here is|Here's|As an AI|抱歉)/i;

/** 剥离围栏与前后杂文，取最外层 {...}。 */
export function extractJsonObject(raw: string): ProtocolResult<unknown> {
  const s = raw.trim();
  if (!s) return { ok: false, error: { code: 'EMPTY_RESPONSE', message: '模型返回为空' } };
  let body = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const a = body.indexOf('{'), b = body.lastIndexOf('}');
  if (a < 0 || b <= a) return { ok: false, error: { code: POLLUTION_RE.test(s) ? 'POLLUTION' : 'INVALID_JSON', message: '返回中找不到 JSON 对象', details: s.slice(0, 200) } };
  if (a > 0 && POLLUTION_RE.test(body.slice(0, a))) return { ok: false, error: { code: 'POLLUTION', message: 'JSON 前含元语言', details: body.slice(0, a) } };
  body = body.slice(a, b + 1);
  try { return { ok: true, value: JSON.parse(body) }; }
  catch (e) { return { ok: false, error: { code: 'INVALID_JSON', message: `JSON 解析失败：${(e as Error).message}`, details: body.slice(0, 300) } }; }
}

export function parseWith<T>(schema: z.ZodType<T>, raw: string): ProtocolResult<T> {
  const j = extractJsonObject(raw); if (!j.ok) return j;
  const r = schema.safeParse(j.value);
  if (!r.success) return { ok: false, error: { code: 'INVALID_SHAPE', message: r.error.issues.slice(0, 5).map(i => `${i.path.join('.')}: ${i.message}`).join('；'), details: r.error.issues } };
  return { ok: true, value: r.data };
}

/** ID 集合必须与请求完全相等。 */
export function checkIdSet(expected: readonly string[], actual: readonly string[]): ProtocolError | null {
  const e = new Set(expected), a = new Set(actual);
  if (actual.length !== a.size) return { code: 'PARTIAL_ID_SET', message: '返回 ID 重复', details: actual };
  const missing = expected.filter(x => !a.has(x)), extra = actual.filter(x => !e.has(x));
  if (missing.length || extra.length) return { code: 'PARTIAL_ID_SET', message: `ID 集合不一致：缺 ${missing.length}，多 ${extra.length}`, details: { missing, extra } };
  return null;
}

export function parseTranslation(raw: string, expectedIds: readonly string[]): ProtocolResult<TranslationOutput> {
  const r = parseWith(translationOutputSchema, raw); if (!r.ok) return r;
  const idErr = checkIdSet(expectedIds, r.value.items.map(i => i.id)); if (idErr) return { ok: false, error: idErr };
  const empty = r.value.items.find(i => i.translation.trim().length === 0);
  if (empty) return { ok: false, error: { code: 'INVALID_SHAPE', message: `块 ${empty.id} 译文为空` } };
  return r;
}
export function parseReview(raw: string, allowedIds: readonly string[]): ProtocolResult<ReviewOutput> {
  const r = parseWith(reviewOutputSchema, raw); if (!r.ok) return r;
  const coverage = checkIdSet(allowedIds, r.value.reviewed_ids);
  if (coverage) return { ok: false, error: coverage };
  const allowed = new Set(allowedIds);
  const bad = r.value.findings.filter(f => !allowed.has(f.block_id));
  if (bad.length) return { ok: false, error: { code: 'PARTIAL_ID_SET', message: `findings 引用了未知块 ID：${bad.map(b => b.block_id).slice(0, 3).join(',')}` } };
  for (const finding of r.value.findings) {
    if (!finding.description.trim() || (!finding.evidence_jp.trim() && !finding.evidence_zh.trim())) {
      return { ok: false, error: { code: 'INVALID_SHAPE', message: '审校问题须说明具体差异并引用当前原文或译文；漏译可只引用日文，增译可只引用中文。不能用空白充当依据。' } };
    }
    if (isExplicitNonFinding(finding.description)) {
      return { ok: false, error: { code: 'INVALID_SHAPE', message: 'findings中包含明确表示没有问题的条目。请重新核对；只列真实差异，没有问题时返回完整reviewed_ids和空findings，不能把通过说明列为问题。' } };
    }
  }
  return r;
}
/** Validate current-text evidence inside the existing bounded protocol retry. */
export function parseCandidateReview(raw: string, id: string, source: string, translation: string): ProtocolResult<ReviewOutput> {
  const result = parseReview(raw, [id]);
  if (!result.ok) return result;
  for (const finding of result.value.findings) {
    if ((finding.evidence_jp && !containsVisibleQuote(source, finding.evidence_jp)) ||
        (finding.evidence_zh && !containsVisibleQuote(translation, finding.evidence_zh))) {
      return { ok: false, error: { code: 'INVALID_SHAPE', message: '审校引句不在当前source或translation中。请逐字引用当前文本，不引用上下文、旧稿或自己改写的句子；重新核对问题，不要编造引句。' } };
    }
  }
  return result;
}

export function parseScene(raw: string, expectedIds: readonly string[]): ProtocolResult<SceneOutput> {
  const r = parseWith(sceneOutputSchema, raw); if (!r.ok) return r;
  const idErr = checkIdSet(expectedIds, r.value.paragraphs.map(p => p.id)); if (idErr) return { ok: false, error: idErr };
  for (const p of r.value.paragraphs) {
    if ((p.scene_boundary_before || p.atmosphere.trim()) && (!p.evidence_ids.includes(p.id) || p.evidence_ids.some(id => !expectedIds.includes(id)))) {
      return { ok: false, error: { code: 'INVALID_SHAPE', message: '场景边界／氛围必须引用当前段，不能引用本批之外的段落' } };
    }
  }
  return r;
}
export const parseHonorific = (raw: string): ProtocolResult<HonorificOutput> => parseWith(honorificOutputSchema, raw);
export interface PreReadParagraph { id: string; sourceText: string; seriesOrdinal: number }
export function parsePreRead(raw: string, paragraphs?: readonly PreReadParagraph[], knownNames: readonly string[] = []): ProtocolResult<PreReadOutput> {
  const result = parseWith(preReadOutputSchema, raw);
  if (!result.ok || !paragraphs) return result;
  const idError = checkIdSet(paragraphs.map(p => p.id), result.value.reviewed_ids);
  if (idError) return { ok: false, error: idError };
  const byId = new Map(paragraphs.map(p => [p.id, p]));
  const invalid = (message: string): ProtocolResult<PreReadOutput> => ({ ok: false, error: { code: 'INVALID_SHAPE', message } });
  const candidates = [...result.value.characters, ...result.value.relationship_events, ...result.value.plot_events, ...result.value.knowledge_change_candidates,
    ...result.value.characters.flatMap(c => c.quirk_candidates)];
  for (const c of candidates) {
    if (!c.evidence_ids.length || new Set(c.evidence_ids).size !== c.evidence_ids.length || c.evidence_ids.some(id => !byId.has(id))) return invalid('候选证据必须非空、不重复，且全部来自本次段落');
    if ('at_para' in c) {
      // at_para is a derived boundary: after evidence IDs are validated, the
      // latest cited paragraph is the earliest safe point at which this event
      // may enter background context. It is not a claim about when it truly
      // happened.
      c.at_para = Math.max(...c.evidence_ids.map(id => byId.get(id)!.seriesOrdinal));
    }
  }
  for (const c of result.value.characters) {
    // The persistence guard already discards unsupported gender guesses. Do
    // that before quote-position checks too: an absent optional fact must not
    // force regeneration of otherwise valid names and voice observations.
    if (guardGender(c.gender, c.gender_confidence, c.gender_evidence, c.name_jp).gender === null) {
      c.gender = 'unknown';
      c.gender_confidence = 0;
      c.gender_evidence = '';
    }
    const sources = c.evidence_ids.map(id => byId.get(id)!.sourceText);
    const nameSources = sources.map(source => visibleNameSource(source));
    if (c.name_evidence && (!c.evidence_ids.includes(c.name_evidence.paragraph_id) || !validNameQuote(c.name_jp, c.name_evidence.quote, byId.get(c.name_evidence.paragraph_id)?.sourceText ?? ''))) {
      const known = knownNames.includes(c.name_jp);
      const positions = known ? [] : paragraphs.filter(p => validNameQuote(c.name_jp, p.sourceText, p.sourceText)).slice(0, 3).map(p => p.id);
      const hint = positions.length ? `本次存在独立词形的段落ID：${JSON.stringify(positions)}。回查这些段落；只有确实指此人物时才从其中逐字引用，并把所选ID加入evidence_ids，保留其他字段的证据位置。这些位置不证明人物身份，不能裁掉被拒引句的相邻原字。` : '';
      return invalid(`人物「${c.name_jp}」的姓名证据须逐字引用本次人物证据段中的独立主名，不得使用词内字或别名代替。${known ? '该名字已在known_names中，已有前文姓名依据；本次无法提供独立主名引句时，省略整个name_evidence字段（不是改写引文或写null），保留name_jp和本次有效evidence_ids。其他字段仍各自提供本次证据；不要反复提交同一条被拒引句。' : `此名字不在known_names中，不能借已有身份解释引句；不要裁掉相邻原字来伪造独立姓名。${hint}`}`);
    }
    if (!c.name_jp.trim() || ![c.name_jp, ...c.aliases].some(name => name.trim() && nameSources.some(text => text.includes(name)))) return invalid('人物名字或别名未出现在所引证据中');
    if (c.gender_evidence && !sources.some(text => containsVisibleQuote(text, c.gender_evidence))) {
      const literalIds = paragraphs.filter(p => containsVisibleQuote(p.sourceText, c.gender_evidence)).map(p => p.id);
      return invalid(`人物「${c.name_jp}」的gender_evidence：性别证据必须逐字引用所列段落，不能编造证据。${JSON.stringify({ cited_ids: c.evidence_ids, literal_quote_ids: literalIds.slice(0, 12) })}。literal_quote_ids只说明引文位置，不证明引文说的是该人物。确认属于该人物后，将正确位置补入evidence_ids并保留姓名和其他字段的证据位置；无法确认时gender=unknown、gender_evidence=""。此字段只放原文引句，不加段落ID、冒号或说明。`);
    }
    for (const e of c.field_evidence) {
      if (!e.quote.trim() || !c.evidence_ids.includes(e.paragraph_id) || !containsVisibleQuote(byId.get(e.paragraph_id)?.sourceText ?? '', e.quote)) return invalid('字段证据必须逐字引用该人物的本次证据段');
    }
    for (const field of ['first_person_type', 'speech_register', 'voice_notes'] as const) {
      if (c[field] && c[field] !== 'unknown' && !c.field_evidence.some(e => e.field === field)) return invalid(`人物「${c.name_jp}」的${field} 缺少独立字段证据；提供field_evidence中对应field、paragraph_id与精确quote，没有把握应返回 unknown 或空说明`);
    }
    if (![c.name_jp, ...c.aliases].every(name => name.trim() && (knownNames.includes(name) || paragraphs.some(p => visibleNameSource(p.sourceText).includes(name))))) return invalid('人名与别名必须来自本次原文或已知名字，不得编造');
  }
  const names = result.value.characters.map(c => c.name_jp);
  if (new Set(names).size !== names.length) return invalid('同一人物在本次结果中重复');
  const availableNames = new Set([...knownNames, ...names]);
  if (result.value.relationship_events.some(e => e.from_name_jp === e.to_name_jp || !availableNames.has(e.from_name_jp) || !availableNames.has(e.to_name_jp)) || result.value.plot_events.some(e => e.character_names.some(name => !availableNames.has(name)))) return invalid('事件涉及未建档人物，请补人物候选或使用已知标准名');
  if (result.value.plot_events.some(e => !e.summary_jp.trim()) || result.value.relationship_events.some(e => !e.description_jp.trim())) return invalid('事件摘要与关系描述不能为空');
  return result;
}
export function parseTermExtract(raw: string, paragraphs?: readonly Pick<PreReadParagraph, 'id' | 'sourceText'>[]): ProtocolResult<TermExtractOutput> {
  const r = parseWith(termExtractOutputSchema, raw);
  if (!r.ok || !paragraphs) return r;
  const idError = checkIdSet(paragraphs.map(p => p.id), r.value.reviewed_ids);
  if (idError) return { ok: false, error: idError };
  // Excluded kanji expressions never enter the glossary; do not spend model retries
  // repairing citations for candidates the user explicitly does not want.
  r.value.terms = r.value.terms.filter(t => !isHanOnlyTerm(t.term_jp));
  const byId = new Map(paragraphs.map(p => [p.id, p.sourceText]));
  for (const t of r.value.terms) {
    if (!t.term_jp.trim() || !t.occurrence_paragraph_ids.length || new Set(t.occurrence_paragraph_ids).size !== t.occurrence_paragraph_ids.length) {
      return { ok: false, error: { code: 'INVALID_SHAPE', message: '每个术语必须逐字出现在所引的本次段落中，不能伪造或缺少出现位置' } };
    }
    const invalidIds = t.occurrence_paragraph_ids.filter(id => !containsVisibleQuote(byId.get(id) ?? '', t.term_jp));
    if (invalidIds.length) {
      const literalIds = paragraphs.filter(p => containsVisibleQuote(p.sourceText, t.term_jp)).map(p => p.id);
      return { ok: false, error: { code: 'INVALID_SHAPE', message: `术语位置不匹配：${JSON.stringify({ term_jp: t.term_jp.slice(0, 100), invalid_ids: invalidIds.slice(0, 6), literal_occurrence_ids: literalIds.slice(0, 20) })}。invalid_ids中原文没有逐字出现该词；同义词、简称不能当作完整词的出现。只引用确实含该原词且义项吻合的位置；literal_occurrence_ids为空时删除该候选，不造新词。重新核对全部候选，返回完整JSON。` } };
    }
  }
  try { r.value.terms = r.value.terms.flatMap(t => normalizeTermGranularity(t)); }
  catch (error) { return { ok: false, error: { code: 'INVALID_SHAPE', message: (error as Error).message } }; }
  return r;
}
export function parseTermProposal(raw: string, expectedTerms?: readonly string[], examples?: readonly Pick<PreReadParagraph, 'id' | 'sourceText'>[]): ProtocolResult<TermProposalOutput> {
  const r = parseWith(termProposalOutputSchema, raw);
  if (!r.ok) return r;
  if (expectedTerms) {
    const error = checkIdSet(expectedTerms, r.value.proposals.map(p => p.term_jp));
    if (error) return { ok: false, error };
  }
  const byId = new Map(examples?.map(p => [p.id, p.sourceText]) ?? []);
  for (const p of r.value.proposals) {
    if (p.candidates.length > 3 || p.candidates.some(c => !c.zh.trim())) return { ok: false, error: { code: 'INVALID_SHAPE', message: '每个术语须有1至3个非空译名候选' } };
    if (examples) {
      for (const v of p.variants) {
        if (!v.variant_jp.trim() || !v.zh.trim() || !v.evidence_ids.length) return { ok: false, error: { code: 'INVALID_SHAPE', message: `变体缺少原文形式、译法或证据：${JSON.stringify(v.variant_jp.slice(0, 100))}。无依据的可选变体应省略，不能补造。` } };
        const invalidIds = v.evidence_ids.filter(id => !containsVisibleQuote(byId.get(id) ?? '', v.variant_jp));
        if (invalidIds.length) return { ok: false, error: { code: 'INVALID_SHAPE', message: `变体位置不匹配：${JSON.stringify({ term_jp: p.term_jp.slice(0, 100), variant_jp: v.variant_jp.slice(0, 100), invalid_ids: invalidIds.slice(0, 6), literal_occurrence_ids: examples.filter(e => containsVisibleQuote(e.sourceText, v.variant_jp)).map(e => e.id).slice(0, 20) })}。完整变体须逐字出现在所引例句，简称不能充当证据。无合适证据就省略此可选变体；不要改基础词条或制造引用。返回完整JSON。` } };
      }
      if (p.annotation_draft && (!byId.has(p.annotation_draft.anchor_paragraph_id) || !p.annotation_draft.text.trim())) return { ok: false, error: { code: 'INVALID_SHAPE', message: `注释缺少本次例句依据或正文：${JSON.stringify({ term_jp: p.term_jp.slice(0, 100), invalid_anchor: p.annotation_draft.anchor_paragraph_id })}。无必要就省略annotation_draft；如提供，只引用本次examples中的ID并给出非空文本。` } };
    }
  }
  return r;
}

export const isReviewWorkstation = (ws: WorkstationId): boolean => ws === 'fidelity-reviewer' || ws === 'address-reviewer' || ws === 'trajectory-reviewer';
import { validNameQuote, visibleNameSource, containsVisibleQuote } from '../validation/nameEvidence';
