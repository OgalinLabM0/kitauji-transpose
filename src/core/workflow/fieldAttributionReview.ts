import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AiClient } from '@core/ai';
import type { ProtocolResult } from '@core/ai/protocol';
import { nowIso, type ProjectStore } from '@core/db';
import { containsVisibleQuote, visibleNameSource } from '../validation/nameEvidence';
import { conflictFingerprint, pendingFieldConflicts, validateFieldConflict, type FieldConflict } from './characterConflicts';
import { fieldEvidenceContext } from './fieldEvidenceContext';

export const FIELD_ATTRIBUTION_CONTRACT = 'field-attribution-v2-complete-neighbors';
const quote = z.object({paragraph_id:z.string(),quote:z.string().trim().min(1)}).strict();
const side = z.object({attribution:z.enum(['target','other','uncertain']),reason:z.string().trim().min(1).max(1200),evidence_citations:z.array(quote),attribution_citations:z.array(quote)}).strict();
const schema = z.object({reviewed_ids:z.array(z.string()),previous:side,proposed:side}).strict();
type Assessment = z.infer<typeof schema>;
type Background = ReturnType<typeof fieldEvidenceContext>;
type Evidence = {contract:string;inputHash:string;aiCallId:string;assessment:Assessment;background:Background;receipt:string};
type Payload = FieldConflict & {autoSuppressed?:boolean;identityInvalidated?:boolean;items?:Record<string,unknown>[];fieldAttributionEvidence?:Evidence;fieldAttributionAttempt?:{inputHash:string};automaticFieldAttributionDismissal?:{inputHash:string;receipt:string;aiCallId:string;createdAt:string}};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inputHash=(c:FieldConflict,background:Background)=>hash({contract:FIELD_ATTRIBUTION_CONTRACT,conflict:conflictFingerprint(c),background});
const receipt=(input:string,assessment:Assessment,aiCallId:string)=>hash({input,assessment,aiCallId,contract:FIELD_ATTRIBUTION_CONTRACT});

export function parseFieldAttribution(text:string,c:FieldConflict,background:Background):ProtocolResult<Assessment> {
  try {
    const value=schema.parse(JSON.parse(text));
    const ids=c.sources.map(s=>s.id);
    if(value.reviewed_ids.length!==ids.length || new Set(value.reviewed_ids).size!==ids.length || ids.some(id=>!value.reviewed_ids.includes(id)))throw new Error('须核对所有原文来源，不重不漏');
    for(const [body,evidenceIds] of [[value.previous,c.previousEvidenceIds],[value.proposed,c.evidenceIds]] as const) {
      if(body.evidence_citations.some(q=>!evidenceIds.includes(q.paragraph_id)))throw new Error('两侧证据不可混用');
      for(const q of [...body.evidence_citations,...body.attribution_citations])if(!containsVisibleQuote([...c.sources,...background].find(s=>s.id===q.paragraph_id)?.text??'',q.quote))throw new Error('引文须为实际可见原文中的连续短语');
      if(body.attribution!=='uncertain' && (!evidenceIds.length || evidenceIds.some(id=>!body.evidence_citations.some(q=>q.paragraph_id===id)) || !body.attribution_citations.length))throw new Error('明确归属须引用每个本侧证据和归属定位原文；证据不足请保留uncertain');
    }
    return {ok:true,value};
  } catch(e) {return {ok:false,error:{code:'INVALID_SHAPE',message:(e as Error).message}};}
}

function allowed(store:ProjectStore,c:Payload,seriesId:string,paragraphId:string|null):boolean {
  if(!['first_person_type','gender','plurality'].includes(c.field) || c.autoSuppressed || c.identityInvalidated || !c.sourceProof || !c.previousSourceProof || !c.evidenceIds?.length || !c.previousEvidenceIds?.length || !Number.isSafeInteger(c.at))return false;
  if(c.items && (c.items.length!==1 || c.items[0]!.paragraphId!==paragraphId || conflictFingerprint(c.items[0] as unknown as FieldConflict)!==conflictFingerprint(c)))return false;
  if(c.sources.length>6 || JSON.stringify(c.sources).length>8000 || c.sources.some(s=>s.at>c.at))return false;
  if([...c.evidenceIds,...c.previousEvidenceIds].some(id=>!c.sources.some(s=>s.id===id)))return false;
  const row=store.knowledge.getCharacter(c.characterId);
  if(!row || row.series_id!==seriesId || row.canonical_name_jp!==c.characterName || !row.is_active || row.locked_by_user)return false;
  if(store.db.get("SELECT 1 FROM character_field_history WHERE character_id=? AND field=? AND origin='user'",[c.characterId,c.field]))return false;
  try{validateFieldConflict(store,c,seriesId);return true;}catch{return false;}
}

function completedEvidenceCurrent(store:ProjectStore,c:Payload,seriesId:string,paragraphId:string|null):boolean {
  if(!allowed(store,c,seriesId,paragraphId))return false;
  const e=c.fieldAttributionEvidence;
  if(!e || e.contract!==FIELD_ATTRIBUTION_CONTRACT)return false;
  const background=fieldEvidenceContext(store,c,seriesId,8);
  if(JSON.stringify(background)!==JSON.stringify(e.background) || e.inputHash!==inputHash(c,background))return false;
  const parsed=parseFieldAttribution(JSON.stringify(e.assessment),c,background);
  if(!parsed.ok || e.receipt!==receipt(e.inputHash,parsed.value,e.aiCallId))return false;
  return !!store.db.get("SELECT 1 FROM ai_calls WHERE id=? AND workstation_id='character-evidence-reviewer' AND error IS NULL AND finish_reason='stop'",[e.aiCallId]);
}

function verified(store:ProjectStore,c:Payload,seriesId:string,paragraphId:string|null):boolean {
  return c.fieldAttributionEvidence?.assessment.previous.attribution==='target' && c.fieldAttributionEvidence.assessment.proposed.attribution==='other' && completedEvidenceCurrent(store,c,seriesId,paragraphId);
}

/** Runs after normal field adoption and scenes. Only a false attribution can be closed; no identity writes. */
export async function reviewFieldAttributions(store:ProjectStore,ai:AiClient,volumeId:string,signal?:AbortSignal):Promise<number> {
  const seriesId=store.projects.getVolumeSeriesId(volumeId),ids=new Set(store.projects.listParagraphIdsByVolume(volumeId));
  let reviewed=0;
  for(const q of pendingFieldConflicts(store,seriesId,Number.MAX_SAFE_INTEGER)) {
    signal?.throwIfAborted();
    const c=q.payload as unknown as Payload;
    const prior=q.payload.evidenceReview as {verdict?:string;inputHash?:string}|undefined;
    if(!q.paragraphId || !ids.has(q.paragraphId) || !allowed(store,c,seriesId,q.paragraphId) || c.evidenceIds.some(id=>!ids.has(id)) || !prior || !['supported-change','uncertain'].includes(prior.verdict??'') || prior.inputHash!==conflictFingerprint(c))continue;
    const background=fieldEvidenceContext(store,c,seriesId,8),fingerprint=inputHash(c,background);
    if(completedEvidenceCurrent(store,c,seriesId,q.paragraphId))continue;
    // Attempts are history, not successful receipts. A later authorized pass can
    // retry interrupted/failed work, while a current completed uncertain result is reused.
    store.translations.updateQueuePayload(q.id,{...q.payload,...(c.fieldAttributionAttempt?{fieldAttributionAttemptHistory:[...(Array.isArray(q.payload.fieldAttributionAttemptHistory)?q.payload.fieldAttributionAttemptHistory:[]),c.fieldAttributionAttempt]}:{}),fieldAttributionAttempt:{inputHash:fingerprint,createdAt:nowIso()}});
    try {
      const visible=(s:FieldConflict['sources'][number])=>({...s,text:visibleNameSource(s.text)});
      const result=await ai.structured({workstation:'character-evidence-reviewer',fieldAttribution:true,user:JSON.stringify({target:{id:c.characterId,name:c.characterName},previous_evidence_ids:c.previousEvidenceIds,proposed_evidence_ids:c.evidenceIds,sources:c.sources.map(visible),background:background.map(visible)}),paragraphId:q.paragraphId,parseRetries:1,maxOutputTokens:1600,...(signal?{signal}:{})},text=>parseFieldAttribution(text,c,background));
      signal?.throwIfAborted();
      store.transaction(()=>{
        const current=store.translations.getQueueItem(q.id);
        if(!current || current.status!=='pending')return;
        const next=current.payload as unknown as Payload;
        if(!allowed(store,next,seriesId,current.paragraph_id) || fingerprint!==inputHash(next,fieldEvidenceContext(store,next,seriesId,8)))return;
        const evidence:Evidence={contract:FIELD_ATTRIBUTION_CONTRACT,inputHash:fingerprint,aiCallId:result.aiCallId,assessment:result.value,background,receipt:receipt(fingerprint,result.value,result.aiCallId)};
        const history=Array.isArray(current.payload.fieldAttributionHistory)?current.payload.fieldAttributionHistory:[];
        const payload={...current.payload,...(next.fieldAttributionEvidence?{fieldAttributionHistory:[...history,{evidence:next.fieldAttributionEvidence}]}:{}),fieldAttributionEvidence:evidence};
        store.translations.updateQueuePayload(q.id,payload);
        reviewed++;
        if(!verified(store,payload as unknown as Payload,seriesId,current.paragraph_id))return;
        const reason=`独立归属核对：旧侧属于目标；新侧明确非目标。${result.value.proposed.reason}`;
        store.translations.updateQueuePayload(q.id,{...payload,automaticFieldAttributionDismissal:{inputHash:fingerprint,receipt:evidence.receipt,aiCallId:result.aiCallId,createdAt:nowIso()},fieldAttributionReason:reason});
        store.translations.resolveQueueItem(q.id,JSON.stringify({action:'automatic-field-attribution-dismissal',reason,aiCallId:result.aiCallId}));
      });
    }catch(e){signal?.throwIfAborted();store.translations.log({level:'warning',workstationId:'character-evidence-reviewer',paragraphId:q.paragraphId,message:`独立字段归属核对未完成，候选保留：${(e as Error).message}`});}
  }
  return reviewed;
}

export function fieldAttributionDismissalCurrent(store:ProjectStore,queueId:string):boolean {
  const item=store.translations.getQueueItem(queueId);
  if(!item || item.status!=='resolved')return false;
  const c=item.payload as unknown as Payload,d=c.automaticFieldAttributionDismissal,e=c.fieldAttributionEvidence;
  try{return !!d && !!e && d.inputHash===e.inputHash && d.receipt===e.receipt && d.aiCallId===e.aiCallId && verified(store,c,item.series_id,item.paragraph_id);}catch{return false;}
}

export function reopenFieldAttributionDismissal(store:ProjectStore,queueId:string,userUndo:boolean):void {
  store.transaction(()=>{
    const item=store.translations.getQueueItem(queueId);
    if(!item || item.status!=='resolved' || !item.payload.automaticFieldAttributionDismissal)throw new Error('字段归属结案已改变或已撤销');
    if(store.db.get("SELECT 1 FROM workflow_tasks WHERE workstation_id=? AND status='running'",[`repair:${queueId}`]))throw new Error('此决定的修复仍在运行，请先停止');
    const next={...item.payload};
    next.fieldAttributionHistory=[...(Array.isArray(next.fieldAttributionHistory)?next.fieldAttributionHistory:[]),{evidence:next.fieldAttributionEvidence,decision:next.automaticFieldAttributionDismissal,attempt:next.fieldAttributionAttempt,undoneAt:nowIso(),reason:userUndo?'user':'source-changed'}];
    for(const key of ['automaticFieldAttributionDismissal','fieldAttributionEvidence','fieldAttributionAttempt'])delete next[key];
    if(userUndo)next.autoSuppressed=true;
    next.fieldAttributionReason=userUndo?'已撤销归属结案，保留人工核对':'归属依据已变化，旧结案已撤回';
    store.translations.updateQueuePayload(queueId,next);
    store.db.run("UPDATE review_queue SET status='pending',resolution=NULL,resolved_at=NULL WHERE id=?",[queueId]);
  });
}
