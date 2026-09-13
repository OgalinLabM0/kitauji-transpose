import { z } from 'zod';
import type { AiClient, ProtocolResult } from '@core/ai';
import type { ProjectStore } from '@core/db';
import { auditInput } from './auditReceipts';
import { syntaxHintsFor } from '../ai/prompts/syntaxHints';
const schema = z.object({ id: z.string(), notes: z.array(z.object({ quote: z.string().min(1), reading: z.string().trim().min(1).max(300), uncertain: z.boolean() }).strict()).min(1).max(4) }).strict();
export type SourceRelationNote = z.infer<typeof schema>['notes'][number];
/** Conservative routing hints, never a claim that unmarked Japanese is simple. */
export const needsSemanticPreparation = (source: string): boolean =>
  /ないわけ(?:で)?はない|ないわけでもない|とは限らない|とはかぎらない|させられ|ざるを得ない|ざるをえない/.test(source)
  || /(?:思|おも)わ(?:せ|され)/.test(source)
  // A bounded same-sentence quotation-to-thought hint, not a grammatical verdict.
  || /と(?:は|も)?(?:[、，,][^。！？\r\n]{0,80})?(?:思(?:う|い|っ|わ)|おも(?:う|い|っ|わ)|考え|かんがえ)/.test(source);
/** Keep tentative readings visibly unconfirmed in generation and mandatory review. */
export function sourceRelationReviewText(note: SourceRelationNote): string {
  return `原文「${note.quote}」关系核对：${note.reading}${note.uncertain ? '（未确定，须保留原作歧义）' : '（分析尚待核查）'}`;
}
export function parseSourceRelations(text: string, id: string, source: string, context: readonly {id:string;source:string}[] = [], excluded?: (notes: SourceRelationNote[]) => void): ProtocolResult<z.infer<typeof schema>> {
  try {
    const value = schema.parse(JSON.parse(text));
    if (value.id !== id || value.notes.some(n => !n.quote.trim())) throw new Error('难句关系整理缺少当前段落或真实原文引文');
    const current = value.notes.filter(n => source.includes(n.quote));
    const outside = value.notes.filter(n => !source.includes(n.quote));
    if (!current.length || outside.some(n => !context.some(p => p.id !== id && p.source.includes(n.quote)))) throw new Error('难句关系整理包含未知引文或没有当前段分析');
    excluded?.(outside);
    return { ok: true, value: {...value, notes:current} };
  } catch (error) { return { ok: false, error: { code: 'INVALID_SHAPE', message: (error as Error).message } }; }
}
export async function prepareSourceRelations(ai: AiClient, id: string, source: string, context: readonly { id: string; source: string }[], signal?: AbortSignal) {
  let excluded: SourceRelationNote[] = [];
  const result = await ai.structured({ workstation: 'source-relation-reader', paragraphId: id, user: JSON.stringify({ id, source, context, grammar_hints:syntaxHintsFor(source), response_contract: { required_id: id, required_keys: ['id', 'notes'], instruction: '返回对象必须含当前段id；不返回type或json_object。notes只引用source，不输出context段落的分析。' } }), parseRetries: 1, maxOutputTokens: 1600, ...(signal ? { signal } : {}) }, text => parseSourceRelations(text, id, source, context, notes => {excluded=notes;}));
  return {...result, excludedContextNotes:excluded};
}

/** Expand only when uncertainty and additional audited Japanese evidence both exist. */
export async function prepareWithEvidence(store: ProjectStore, ai: AiClient, id: string, source: string, context: readonly {id:string;source:string}[], signal?: AbortSignal) {
  const baseline = auditInput(store, id);
  const first = await prepareSourceRelations(ai, id, source, context, signal);
  if (first.excludedContextNotes.length) store.translations.log({level:'info',workstationId:'source-relation-reader',paragraphId:id,message:JSON.stringify({kind:'excluded-context-relations-v1',aiCallId:first.aiCallId,excluded:first.excludedContextNotes,note:'仅隔离已提供上下文的分析；当前段条目不改，仍须完整审校'})});
  signal?.throwIfAborted();
  if (auditInput(store, id).inputHash !== baseline.inputHash) throw new Error('难句分析期间原文依据已变化');
  const known = new Set(context.map(p => p.id));
  const expanded = (baseline.pack.sourceContextIds ?? []).map(pid => store.projects.getParagraph(pid)).filter(p => p != null).map(p => ({id:p.id,source:p.sourceText}));
  if (!first.value.notes.some(n => n.uncertain) || !expanded.some(p => !known.has(p.id))) return { ...first, inputHash: baseline.inputHash };
  // Whole paragraphs only; do not silently cut a sentence to fit a token target.
  if (source.length + expanded.reduce((n,p) => n + p.source.length, 0) > 6000) {
    store.translations.log({level:'warning',paragraphId:id,workstationId:'source-relation-reader',message:'难句补读范围超过6000字符，保留未决分析，不截断原文或继续扩大请求'});
    return { ...first, inputHash: baseline.inputHash };
  }
  const second = await prepareSourceRelations(ai, id, source, expanded, signal);
  signal?.throwIfAborted();
  if (auditInput(store, id).inputHash !== baseline.inputHash) throw new Error('难句补读期间原文依据已变化');
  store.translations.log({level:'info',paragraphId:id,workstationId:'source-relation-reader',message:JSON.stringify({contract:'source-expansion-v1',inputHash:baseline.inputHash,firstCallId:first.aiCallId,secondCallId:second.aiCallId,sourceIds:expanded.map(p=>p.id),stillUncertain:second.value.notes.some(n=>n.uncertain)})});
  return { ...second, inputHash: baseline.inputHash };
}
