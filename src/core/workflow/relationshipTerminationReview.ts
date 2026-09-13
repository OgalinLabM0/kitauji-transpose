import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {AiClient,ProtocolResult} from '@core/ai';
import type {ProjectStore} from '@core/db';
import {nowIso} from '@core/db';
import {characterSourceCurrent} from '../db/characterSources';
import {narrativeSourceCurrent} from '../db/narrativeSources';
import {changeTarget} from '../db/knowledgeChanges';
import {beginChangeDecision,finishChangeDecision,undoChangeDecision} from './changeDecisionJournal';
import {RELATIONSHIP_TERMINATION_PROMPT} from '../ai/prompts/relationshipTerminationPrompt';
import {containsVisibleQuote} from '../validation/nameEvidence';

const schema=z.object({reviewed_ids:z.array(z.string()),decision:z.enum(['unsupported','needs-review']),reason:z.string().trim().min(1).max(1200),citations:z.array(z.object({id:z.string(),quote:z.string().trim().min(1)}).strict())}).strict();
type Review=z.infer<typeof schema>;
type Candidate={id:string;series_id:string;entity_type:string;entity_id:string;change_type:string;description:string;triggered_at_para:number;proposed_valid_to_para:number|null;evidence_ids:string;status:string};
type Receipt={version:1;inputHash:string;aiCallId:string;review:Review;undoneAt?:string};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Input={relationship:{from:string;to:string;description:string;validFrom:number;validTo:number|null};operation:string;description:string;sources:{id:string;text:string;at:number}[]};

export function parseRelationshipTermination(text:string,input:Input):ProtocolResult<Review> {
  try {
    const v=schema.parse(JSON.parse(text)),ids=input.sources.map(s=>s.id);
    if(v.reviewed_ids.length!==ids.length || new Set(v.reviewed_ids).size!==ids.length || ids.some(id=>!v.reviewed_ids.includes(id)))throw new Error('需要完整且不重复的原文核对编号');
    if(v.citations.some(c=>!containsVisibleQuote(input.sources.find(s=>s.id===c.id)?.text ?? '',c.quote)))throw new Error('引文必须逐字存在于对应原文段落');
    if(v.decision==='unsupported' && ids.some(id=>!v.citations.some(c=>c.id===id)))throw new Error('拒绝停用须给出每个证据段的逐字依据');
    return {ok:true,value:v};
  }catch(e){return {ok:false,error:{code:'INVALID_SHAPE',message:(e as Error).message}};}
}

/** A rejection changes only a candidate. Its input still protects identity, source and later edits. */
function prepare(store:ProjectStore,id:string,allowResolved=false) {
  const item=store.translations.getQueueItem(id);
  if(!item || item.kind!=='stale-knowledge' || item.payload.subtype==='character-field' || item.payload.autoSuppressed || item.payload.identityInvalidated || (!allowResolved && item.status!=='pending'))return null;
  const c=store.db.get<Candidate>('SELECT * FROM knowledge_change_candidates WHERE id=? AND series_id=?',[String(item.payload.candidateId),item.series_id]);
  if(!c || c.entity_type!=='relationship' || c.status!==(allowResolved?'rejected':'pending'))return null;
  if(!allowResolved && item.payload.changeDecision && !(item.payload.changeDecision as {undoneAt?:string}).undoneAt)return null;
  const members=item.payload.items;
  if(members!==undefined && (!Array.isArray(members) || members.length!==1 || members[0]?.candidateId!==c.id || members[0]?.paragraphId!==item.paragraph_id))return null;
  const target=store.db.get<{id:string;series_id:string;from_char_id:string;to_char_id:string;description_jp:string;valid_from_para:number;valid_to_para:number|null}>('SELECT * FROM relationships WHERE id=? AND series_id=?',[c.entity_id,item.series_id]);
  const proof=store.db.get<{source_proof:string;target_snapshot:string}>('SELECT * FROM knowledge_change_proofs WHERE candidate_id=?',[c.id]);
  if(!target || !proof || !characterSourceCurrent(store.db,proof.source_proof) || !narrativeSourceCurrent(store.db,'relationship',target.id))return null;
  const relationProof=store.db.get("SELECT * FROM narrative_provenance WHERE kind='relationship' AND record_id=?",[target.id]);
  const from=store.knowledge.getCharacter(target.from_char_id),to=store.knowledge.getCharacter(target.to_char_id);
  if(!from || !to || from.series_id!==item.series_id || to.series_id!==item.series_id || from.locked_by_user || to.locked_by_user)return null;
  const until=c.proposed_valid_to_para??c.triggered_at_para;
  if(!Number.isSafeInteger(until) || until<c.triggered_at_para || target.valid_from_para>until || (target.valid_to_para!==null && target.valid_to_para<=until))return null;
  const snapshot=changeTarget(store.db,'relationship',target.id,item.series_id);
  if(proof.target_snapshot!==snapshot)return null;
  let ids:string[];try{ids=z.array(z.string()).min(1).max(6).parse(JSON.parse(c.evidence_ids));}catch{return null;}
  if(new Set(ids).size!==ids.length)return null;
  const sources=ids.map(id=>store.projects.getParagraph(id));
  if(sources.some(p=>!p || store.projects.getSeriesIdOfParagraph(p.id)!==item.series_id || p.seriesOrdinal>c.triggered_at_para) || Math.max(...sources.map(p=>p!.seriesOrdinal))!==c.triggered_at_para)return null;
  const input:Input={relationship:{from:from.canonical_name_jp,to:to.canonical_name_jp,description:target.description_jp,validFrom:target.valid_from_para,validTo:target.valid_to_para},operation:`从第${until}段起结束这条关系记录的有效范围`,description:c.description,sources:sources.map((p,i)=>({id:`s${i+1}`,text:p!.sourceText,at:p!.seriesOrdinal}))};
  if(JSON.stringify(input).length>8500)return null;
  const {status,...candidate}=c;
  return {item,c,input,hash:hash([RELATIONSHIP_TERMINATION_PROMPT,input,candidate,proof,relationProof,snapshot,ids,item.paragraph_id,members])};
}

export function relationshipTerminationCurrent(store:ProjectStore,id:string):boolean {
  const item=store.translations.getQueueItem(id),r=item?.payload.automaticRelationshipTerminationReview as Receipt|undefined;
  if(!item || item.status!=='resolved' || !r || r.version!==1 || r.undoneAt)return false;
  const p=prepare(store,id,true);
  return !!p && p.hash===r.inputHash && r.review.decision==='unsupported' && parseRelationshipTermination(JSON.stringify(r.review),p.input).ok &&
    !!store.db.get("SELECT 1 FROM ai_calls WHERE id=? AND workstation_id='relationship-termination-reviewer' AND error IS NULL AND finish_reason='stop'",[r.aiCallId]);
}

export function reopenRelationshipTermination(store:ProjectStore,id:string,user:boolean):void {
  store.transaction(()=>{
    const item=store.translations.getQueueItem(id),r=item?.payload.automaticRelationshipTerminationReview as Receipt|undefined;
    if(!item || !r || r.undoneAt)throw new Error('没有可撤回的关系终止候选审核');
    undoChangeDecision(store,id); // Rejected candidate journal never restores or overwrites relationship data.
    const current=store.translations.getQueueItem(id)!;
    const next={...current.payload},undoneAt=nowIso();
    if(next.relationshipTerminationEvidence){
      const history=next.relationshipTerminationEvidenceHistory;
      next.relationshipTerminationEvidenceHistory=[...(Array.isArray(history)?history:[]),{evidence:next.relationshipTerminationEvidence,undoneAt,reason:user?'user':'source-changed'}];
      delete next.relationshipTerminationEvidence;
    }
    store.translations.updateQueuePayload(id,{...next,automaticRelationshipTerminationReview:{...r,undoneAt},autoSuppressed:user});
    if(item.paragraph_id)store.translations.addRecheck(item.paragraph_id,'relationship-termination-review','关系终止候选的自动审核已撤回，需要按当前原文重新核对');
  });
}

export async function reviewRelationshipTerminations(store:ProjectStore,ai:AiClient,volumeId:string,signal?:AbortSignal):Promise<number> {
  const seriesId=store.projects.getVolumeSeriesId(volumeId),ids=new Set(store.projects.listParagraphIdsByVolume(volumeId));let closed=0,attempted=0;
  for(const q of store.translations.listQueue(seriesId).filter(q=>q.kind==='stale-knowledge' && q.paragraphId && ids.has(q.paragraphId))) {
    signal?.throwIfAborted();const p=prepare(store,q.id);if(!p)continue;
    if((p.item.payload.relationshipTerminationEvidence as {inputHash?:string}|undefined)?.inputHash===p.hash)continue;
    if(attempted>=12)break;
    attempted++;
    try {
      const result=await ai.structured({workstation:'relationship-termination-reviewer',paragraphId:q.paragraphId!,user:JSON.stringify(p.input),parseRetries:1,maxOutputTokens:1600,...(signal?{signal}:{})},text=>parseRelationshipTermination(text,p.input));
      signal?.throwIfAborted();
      store.transaction(()=>{
        const current=prepare(store,q.id);if(!current || current.hash!==p.hash)return;
        const receipt:Receipt={version:1,inputHash:p.hash,aiCallId:result.aiCallId,review:result.value};
        store.translations.updateQueuePayload(q.id,{...current.item.payload,relationshipTerminationEvidence:receipt});
        if(result.value.decision!=='unsupported')return;
        const start=beginChangeDecision(store,q.id,false);
        store.knowledge.resolveChangeCandidate(p.c.id,false,seriesId);
        const previous=current.item.payload.automaticRelationshipTerminationReview,history=current.item.payload.relationshipTerminationHistory;
        store.translations.updateQueuePayload(q.id,{...store.translations.getQueueItem(q.id)!.payload,automaticRelationshipTerminationReview:receipt,relationshipTerminationHistory:[...(Array.isArray(history)?history:[]),...(previous?[previous]:[])]});
        store.translations.resolveQueueItem(q.id,JSON.stringify({action:'automatic-unsupported-relationship-termination',aiCallId:result.aiCallId,reason:result.value.reason}));
        finishChangeDecision(store,q.id,start);closed++;
      });
    }catch(e){signal?.throwIfAborted();store.translations.log({level:'warning',paragraphId:q.paragraphId,workstationId:'relationship-termination-reviewer',message:`关系终止候选核对未完成，保留待办：${(e as Error).message}`});}
  }
  return closed;
}
