import { containsVisibleQuote, visibleNameSource } from '../validation/nameEvidence';
import { fieldEvidenceContext } from './fieldEvidenceContext';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AiClient } from '@core/ai';
import type { ProtocolResult } from '@core/ai/protocol';
import type { ProjectStore } from '@core/db';
import { validateFieldConflict, pendingFieldConflicts, conflictFingerprint, type FieldConflict } from './characterConflicts';

const voiceAxes = z.object({proposed_support:z.enum(['full','partial','none','uncertain']),scope:z.enum(['same','local','durable','uncertain'])}).strict();
const schema = z.object({ reviewed_ids: z.array(z.string()), verdict: z.enum(['supported-change','equivalent','compatible','local-register','unsupported','uncertain']), attribution: z.enum(['supported','uncertain']), reason: z.string().trim().min(1).max(1200), citations: z.array(z.object({ paragraph_id: z.string(), quote: z.string().trim().min(1) }).strict()), voiceAssessment:voiceAxes.optional(), registerAssessment:voiceAxes.optional() }).strict();
export type EvidenceReview = z.infer<typeof schema>;
export const FIELD_REVIEW_CONTRACT = 'field-evidence-v4-local-window';
export const VOICE_REVIEW_CONTRACT = 'field-evidence-v5-voice-axes';
export const REGISTER_REVIEW_CONTRACT='register-evidence-v1-content-scope';
export function fieldReviewUsesBackground(review:{contract?:string}):boolean {return [FIELD_REVIEW_CONTRACT,VOICE_REVIEW_CONTRACT,REGISTER_REVIEW_CONTRACT,'field-evidence-v3-context'].includes(review.contract??'');}
export function currentFieldReviewContract(review: {contract?:string;verdict?:string}): boolean {
  return review.contract === REGISTER_REVIEW_CONTRACT || review.contract === VOICE_REVIEW_CONTRACT || review.contract === FIELD_REVIEW_CONTRACT || review.contract === 'field-evidence-v3-context' || (review.contract === 'field-evidence-v2' && review.verdict !== 'compatible');
}
/** Written only beside a fresh successful call, never reconstructed from a legacy review. */
export function fieldReviewReceipt(c: FieldConflict, review: EvidenceReview, aiCallId: string, background?: ReturnType<typeof fieldEvidenceContext>) {
  return { version: 1, hash: createHash('sha256').update(JSON.stringify({ input: conflictFingerprint(c), review, aiCallId, ...(background ? {background} : {}) })).digest('hex') };
}
export function parseFieldEvidence(text: string, c: FieldConflict, background: FieldConflict['sources'] = [], requireVoiceAxes=false,requireRegisterAxes=false): ProtocolResult<EvidenceReview> {
  try {
    const value = schema.parse(JSON.parse(text));
    if(requireVoiceAxes && !value.voiceAssessment)throw new Error('声音新契约缺少内容支持度和范围');
    if(value.voiceAssessment && (c.field!=='voice_notes' || value.verdict!==voiceVerdict(value.voiceAssessment,value.attribution)))throw new Error('声音两个轴与结论不一致');
    if(requireRegisterAxes && !value.registerAssessment)throw new Error('语域新契约缺少内容支持度和范围');
    if(value.registerAssessment && (c.field!=='speech_register' || value.verdict!==registerVerdict(value.registerAssessment,value.attribution)))throw new Error('语域两个轴与字段或结论不一致');
    if(value.verdict==='local-register' && (c.field!=='speech_register' || !value.registerAssessment))throw new Error('局部语域结论需要独立语域双轴凭证');
    if (value.verdict === 'compatible' && c.field !== 'voice_notes') throw new Error('compatible仅用于局部声音描述，不能用于性别、一人称、人数或语域阶段');
    const ids = c.sources.map(s => s.id);
    if (value.reviewed_ids.length !== ids.length || new Set(value.reviewed_ids).size !== ids.length || ids.some(id => !value.reviewed_ids.includes(id))) throw new Error('缺少完整原文核对回执');
    const invalid=value.citations.find(q => !containsVisibleQuote([...c.sources,...background].find(s => s.id === q.paragraph_id)?.text ?? '', q.quote));
    const errors:string[]=[];
    if(invalid) errors.push(`引文不匹配：${JSON.stringify(invalid)}。请改引对应原文中一段连续短语，不要漏掉短语中间的标点；不必引用整句。`);
    if (value.attribution === 'uncertain' && value.verdict !== 'uncertain') errors.push('attribution=uncertain时verdict必须也为uncertain；请保留归属不明，不要为了通过改成supported');
    if (value.verdict !== 'uncertain' && (!value.citations.some(q => c.evidenceIds.includes(q.paragraph_id)) || !value.citations.some(q => c.previousEvidenceIds.includes(q.paragraph_id)))) errors.push('明确判断缺少前后两侧引文；证据不足时verdict填uncertain');
    if(value.voiceAssessment && value.voiceAssessment.proposed_support!=='uncertain' && [...c.previousEvidenceIds,...c.evidenceIds].some(id=>!value.citations.some(q=>q.paragraph_id===id)))errors.push('声音明确支持度须引用每个前后字段证据段');
    if(value.registerAssessment && value.registerAssessment.proposed_support!=='uncertain' && [...c.previousEvidenceIds,...c.evidenceIds].some(id=>!value.citations.some(q=>q.paragraph_id===id)))errors.push('语域明确支持度须引用每个前后字段证据段');
    if(errors.length)throw new Error(errors.join('\n'));
    return { ok: true, value };
  } catch (e) { return { ok: false, error: { code: 'INVALID_SHAPE', message: (e as Error).message } }; }
}

function voiceVerdict(axes:z.infer<typeof voiceAxes>,attribution:EvidenceReview['attribution']):EvidenceReview['verdict'] {
  if(attribution==='uncertain' && (axes.proposed_support!=='uncertain' || axes.scope!=='uncertain'))throw new Error('归属不足时两个声音轴必须uncertain');
  if(axes.proposed_support!=='full' && axes.scope!=='uncertain')throw new Error('未完整支持的提案不能声明same/local/durable范围');
  if(attribution==='uncertain' || axes.proposed_support==='uncertain')return 'uncertain';
  if(axes.proposed_support==='none' || axes.proposed_support==='partial')return 'unsupported';
  return ({same:'equivalent',local:'compatible',durable:'supported-change',uncertain:'uncertain'} as const)[axes.scope];
}
const voiceSchema=schema.omit({verdict:true,voiceAssessment:true,registerAssessment:true}).extend(voiceAxes.shape).strict();
export function parseVoiceFieldEvidence(text:string,c:FieldConflict,background:FieldConflict['sources']=[]):ProtocolResult<EvidenceReview> {
  try {
    if(c.field!=='voice_notes')throw new Error('声音契约只能用于voice_notes');
    const {proposed_support,scope,...body}=voiceSchema.parse(JSON.parse(text));
    const voiceAssessment={proposed_support,scope};
    const result=parseFieldEvidence(JSON.stringify({...body,voiceAssessment,verdict:voiceVerdict(voiceAssessment,body.attribution)}),c,background,true);
    if(result.ok && proposed_support!=='uncertain' && [...c.previousEvidenceIds,...c.evidenceIds].some(id=>!body.citations.some(q=>q.paragraph_id===id)))throw new Error('声音明确支持度须引用每个前后字段证据段');
    return result;
  }catch(e){return {ok:false,error:{code:'INVALID_SHAPE',message:(e as Error).message}};}
}

function registerVerdict(axes:z.infer<typeof voiceAxes>,attribution:EvidenceReview['attribution']):EvidenceReview['verdict'] {
  const result=voiceVerdict(axes,attribution);
  return result==='compatible'?'local-register':result;
}
export function parseRegisterFieldEvidence(text:string,c:FieldConflict,background:FieldConflict['sources']=[]):ProtocolResult<EvidenceReview> {
  try {
    if(c.field!=='speech_register')throw new Error('语域范围契约只能用于speech_register');
    const {proposed_support,scope,...body}=voiceSchema.parse(JSON.parse(text));
    const registerAssessment={proposed_support,scope};
    return parseFieldEvidence(JSON.stringify({...body,registerAssessment,verdict:registerVerdict(registerAssessment,body.attribution)}),c,background,false,true);
  }catch(e){return {ok:false,error:{code:'INVALID_SHAPE',message:(e as Error).message}};}
}

function currentRegisterReview(store:ProjectStore,payload:Record<string,unknown>,seriesId:string):boolean {
  try {
    const c=payload as unknown as FieldConflict;
    const review=payload.evidenceReview as EvidenceReview & {contract:string;inputHash:string;aiCallId:string};
    if(c.field!=='speech_register' || review.contract!==REGISTER_REVIEW_CONTRACT || review.inputHash!==conflictFingerprint(c))return false;
    validateFieldConflict(store,c,seriesId);
    const background=fieldEvidenceContext(store,c,seriesId);
    if(JSON.stringify(background)!==JSON.stringify(payload.fieldReviewBackground))return false;
    const {contract:_contract,inputHash:_hash,aiCallId,...body}=review;
    const parsed=parseFieldEvidence(JSON.stringify(body),c,background,false,true);
    const receipt=payload.fieldReviewReceipt as {version:number;hash:string}|undefined;
    return parsed.ok && receipt?.version===1 && receipt.hash===fieldReviewReceipt(c,parsed.value,aiCallId,background).hash && !!store.db.get("SELECT 1 FROM ai_calls WHERE id=? AND workstation_id='character-evidence-reviewer' AND error IS NULL AND finish_reason='stop'",[aiCallId]);
  }catch{return false;}
}

/** Small, independently logged advisory calls. They do not grant themselves adoption authority. */
export async function reviewFieldConflicts(store: ProjectStore, ai: AiClient, volumeId: string, signal?: AbortSignal, maxAttempts = 12): Promise<number> {
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const ids = store.projects.listParagraphIdsByVolume(volumeId);
  const through = Math.max(...ids.map(id => store.projects.getParagraph(id)!.seriesOrdinal));
  const pending = pendingFieldConflicts(store,seriesId,through).filter(q => { const r = q.payload.evidenceReview as {contract?:string;inputHash?:string;verdict?:string} | undefined; return !q.payload.autoSuppressed && ((r?.contract===REGISTER_REVIEW_CONTRACT && !currentRegisterReview(store,q.payload,seriesId)) || !r || !currentFieldReviewContract(r) || ((r.verdict === 'uncertain' || (['voice_notes','speech_register'].includes(String(q.payload.field)) && r.verdict === 'supported-change')) && r.contract !== (q.payload.field==='voice_notes'?VOICE_REVIEW_CONTRACT:q.payload.field==='speech_register'?REGISTER_REVIEW_CONTRACT:FIELD_REVIEW_CONTRACT)) || r.inputHash !== conflictFingerprint(q.payload as unknown as FieldConflict) || (['equivalent','compatible','local-register','unsupported'].includes(r.verdict ?? '') && !q.payload.fieldReviewReceipt)); });
  let reviewed = 0;
  let attempted = 0;
  for (const item of pending) {
    if (attempted >= Math.min(12,Math.max(1,maxAttempts))) break;
    signal?.throwIfAborted();
    const c = item.payload as unknown as FieldConflict;
    try {
      validateFieldConflict(store,c,seriesId);
      const skipReason = !c.previousEvidenceIds.length ? '旧档案缺少定位证据，需人工核对或重新预读' : c.sources.some(s => s.at > c.at) ? '旧记录引用后文，需补较早阶段证据' : c.sources.length > 6 || JSON.stringify(c.sources).length > 8000 ? '证据超过短审核范围，暂留人工核对' : null;
      if (skipReason) { store.translations.updateQueuePayload(item.id, { ...item.payload, evidenceReviewNote: skipReason }); continue; }
      attempted++;
      const background = fieldEvidenceContext(store,c,seriesId);
      const visible=(s: FieldConflict['sources'][number])=>({...s,text:visibleNameSource(s.text)});
      const voice=c.field==='voice_notes',register=c.field==='speech_register';
      const result = await ai.structured({ workstation: 'character-evidence-reviewer', ...(voice?{voiceEvidence:true}:register?{registerEvidence:true}:{}), user: JSON.stringify({ character: c.characterName, field: c.field, before: c.before, proposed: c.proposed, at: c.at, previous_evidence_ids: c.previousEvidenceIds, proposed_evidence_ids: c.evidenceIds, sources: c.sources.map(visible), background:background.map(visible) }),
        paragraphId: item.paragraphId, parseRetries: 1, maxOutputTokens: 1400, ...(signal ? { signal } : {}) }, text => voice?parseVoiceFieldEvidence(text,c,background):register?parseRegisterFieldEvidence(text,c,background):parseFieldEvidence(text,c,background));
      signal?.throwIfAborted();
      store.transaction(() => {
        const current = store.translations.getQueueItem(item.id);
        if (!current || current.status !== 'pending' || conflictFingerprint(current.payload as unknown as FieldConflict) !== conflictFingerprint(c)) return;
        validateFieldConflict(store,c,seriesId);
        if(register && JSON.stringify(fieldEvidenceContext(store,c,seriesId))!==JSON.stringify(background))return;
        const history=Array.isArray(current.payload.fieldEvidenceReviewHistory)?current.payload.fieldEvidenceReviewHistory:[];
        store.translations.updateQueuePayload(item.id, { ...current.payload, ...(current.payload.evidenceReview?{fieldEvidenceReviewHistory:[...history,{review:current.payload.evidenceReview,receipt:current.payload.fieldReviewReceipt,background:current.payload.fieldReviewBackground}]}:{}), fieldReviewBackground:background, evidenceReview: { ...result.value, aiCallId: result.aiCallId, contract: voice?VOICE_REVIEW_CONTRACT:register?REGISTER_REVIEW_CONTRACT:FIELD_REVIEW_CONTRACT, inputHash: conflictFingerprint(c) }, fieldReviewReceipt: fieldReviewReceipt(c, result.value, result.aiCallId, background) });
        reviewed++;
      });
    } catch (e) {
      signal?.throwIfAborted();
      store.translations.log({ level: 'warning', workstationId: 'character-evidence-reviewer', paragraphId: item.paragraphId, message: `字段独立审核未完成，候选保留：${(e as Error).message}` });
    }
  }
  return reviewed;
}

