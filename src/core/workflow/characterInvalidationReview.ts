import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {AiClient,ProtocolResult} from '@core/ai';
import type {ProjectStore} from '@core/db';
import {nowIso} from '@core/db';
import {characterSourceCurrent} from '../db/characterSources';
import {changeTarget} from '../db/knowledgeChanges';
import {beginChangeDecision,finishChangeDecision,undoChangeDecision} from './changeDecisionJournal';
import {CHARACTER_INVALIDATION_PROMPT} from '../ai/prompts/characterInvalidationPrompt';
import {containsVisibleQuote} from '../validation/nameEvidence';

const schema=z.object({reviewed_ids:z.array(z.string()),decision:z.enum(['unsupported','needs-review']),reason:z.string().trim().min(1).max(1200),citations:z.array(z.object({id:z.string(),quote:z.string().trim().min(1)}).strict())}).strict();
type Review=z.infer<typeof schema>;
type Candidate={id:string;series_id:string;entity_type:string;entity_id:string;change_type:string;description:string;triggered_at_para:number;proposed_valid_to_para:number|null;evidence_ids:string;status:string};
type Receipt={version:1;inputHash:string;aiCallId:string;review:Review;undoneAt?:string};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Input={character:string;operation:string;description:string;sources:{id:string;text:string;at:number}[]};

export function parseCharacterInvalidation(text:string,input:Input):ProtocolResult<Review> {
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
  if(!c || c.entity_type!=='character' || c.status!==(allowResolved?'rejected':'pending'))return null;
  if(!allowResolved && item.payload.changeDecision && !(item.payload.changeDecision as {undoneAt?:string}).undoneAt)return null;
  const members=item.payload.items;
  if(members!==undefined && (!Array.isArray(members) || members.length!==1 || members[0]?.candidateId!==c.id || members[0]?.paragraphId!==item.paragraph_id))return null;
  const target=store.knowledge.getCharacter(c.entity_id),proof=store.db.get<{source_proof:string;target_snapshot:string}>('SELECT * FROM knowledge_change_proofs WHERE candidate_id=?',[c.id]);
  if(!target || !target.is_active || target.locked_by_user || target.series_id!==item.series_id || !proof || !characterSourceCurrent(store.db,proof.source_proof))return null;
  // Filling in an agreed Chinese name doesn't change the proposed Japanese identity or interval.
  const semantic=(text:string)=>{const {canonical_name_zh,...rest}=JSON.parse(text);return rest;};
  const snapshot=changeTarget(store.db,'character',target.id,item.series_id);
  try{if(hash(semantic(proof.target_snapshot))!==hash(semantic(snapshot)))return null;}catch{return null;}
  let ids:string[];try{ids=z.array(z.string()).min(1).max(6).parse(JSON.parse(c.evidence_ids));}catch{return null;}
  if(new Set(ids).size!==ids.length)return null;
  const sources=ids.map(id=>store.projects.getParagraph(id));
  if(sources.some(p=>!p || store.projects.getSeriesIdOfParagraph(p.id)!==item.series_id || p.seriesOrdinal>c.triggered_at_para) || Math.max(...sources.map(p=>p!.seriesOrdinal))!==c.triggered_at_para)return null;
  const input:Input={character:target.canonical_name_jp,operation:`从第${c.proposed_valid_to_para??c.triggered_at_para}段起停用整个人物档案`,description:c.description,sources:sources.map((p,i)=>({id:`s${i+1}`,text:p!.sourceText,at:p!.seriesOrdinal}))};
  if(JSON.stringify(input).length>8500)return null;
  const {status,...candidate}=c;
  return {item,c,input,hash:hash([CHARACTER_INVALIDATION_PROMPT,input,candidate,proof,snapshot,ids,item.paragraph_id,members])};
}

export function characterInvalidationCurrent(store:ProjectStore,id:string):boolean {
  const item=store.translations.getQueueItem(id),r=item?.payload.automaticCharacterInvalidationReview as Receipt|undefined;
  if(!item || item.status!=='resolved' || !r || r.version!==1 || r.undoneAt)return false;
  const p=prepare(store,id,true);
  return !!p && p.hash===r.inputHash && r.review.decision==='unsupported' && parseCharacterInvalidation(JSON.stringify(r.review),p.input).ok &&
    !!store.db.get("SELECT 1 FROM ai_calls WHERE id=? AND workstation_id='character-invalidation-reviewer' AND error IS NULL AND finish_reason='stop'",[r.aiCallId]);
}

export function reopenCharacterInvalidation(store:ProjectStore,id:string,user:boolean):void {
  store.transaction(()=>{
    const item=store.translations.getQueueItem(id),r=item?.payload.automaticCharacterInvalidationReview as Receipt|undefined;
    if(!item || !r || r.undoneAt)throw new Error('没有可撤回的人物停用候选审核');
    undoChangeDecision(store,id); // Rejected candidate journal never restores or overwrites character data.
    const current=store.translations.getQueueItem(id)!;
    store.translations.updateQueuePayload(id,{...current.payload,automaticCharacterInvalidationReview:{...r,undoneAt:nowIso()},autoSuppressed:user});
    if(item.paragraph_id)store.translations.addRecheck(item.paragraph_id,'character-invalidation-review','人物停用候选的自动审核已撤回，需要按当前原文重新核对');
  });
}

export async function reviewCharacterInvalidations(store:ProjectStore,ai:AiClient,volumeId:string,signal?:AbortSignal):Promise<number> {
  const seriesId=store.projects.getVolumeSeriesId(volumeId),ids=new Set(store.projects.listParagraphIdsByVolume(volumeId));let closed=0,attempted=0;
  for(const q of store.translations.listQueue(seriesId).filter(q=>q.kind==='stale-knowledge' && q.paragraphId && ids.has(q.paragraphId))) {
    signal?.throwIfAborted();const p=prepare(store,q.id);if(!p)continue;
    if((p.item.payload.characterInvalidationEvidence as {inputHash?:string}|undefined)?.inputHash===p.hash)continue;
    if(attempted>=12)break;
    attempted++;
    try {
      const result=await ai.structured({workstation:'character-invalidation-reviewer',paragraphId:q.paragraphId!,user:JSON.stringify(p.input),parseRetries:1,maxOutputTokens:1600,...(signal?{signal}:{})},text=>parseCharacterInvalidation(text,p.input));
      signal?.throwIfAborted();
      store.transaction(()=>{
        const current=prepare(store,q.id);if(!current || current.hash!==p.hash)return;
        const receipt:Receipt={version:1,inputHash:p.hash,aiCallId:result.aiCallId,review:result.value};
        store.translations.updateQueuePayload(q.id,{...current.item.payload,characterInvalidationEvidence:receipt});
        if(result.value.decision!=='unsupported')return;
        const start=beginChangeDecision(store,q.id,false);
        store.knowledge.resolveChangeCandidate(p.c.id,false,seriesId);
        const previous=current.item.payload.automaticCharacterInvalidationReview,history=current.item.payload.characterInvalidationHistory;
        store.translations.updateQueuePayload(q.id,{...store.translations.getQueueItem(q.id)!.payload,automaticCharacterInvalidationReview:receipt,characterInvalidationHistory:[...(Array.isArray(history)?history:[]),...(previous?[previous]:[])]});
        store.translations.resolveQueueItem(q.id,JSON.stringify({action:'automatic-unsupported-character-invalidation',aiCallId:result.aiCallId,reason:result.value.reason}));
        finishChangeDecision(store,q.id,start);closed++;
      });
    }catch(e){signal?.throwIfAborted();store.translations.log({level:'warning',paragraphId:q.paragraphId,workstationId:'character-invalidation-reviewer',message:`人物停用候选核对未完成，保留待办：${(e as Error).message}`});}
  }
  return closed;
}
