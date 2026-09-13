import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {ProjectStore} from '@core/db';
import {nowIso} from '@core/db';
import type {AiClient,ProtocolResult} from '@core/ai';
import {ORDINARY_ADDRESS_CLASSIFIER_PROMPT} from '../ai/prompts/ordinaryAddressClassifierPrompt';

const candidate=z.object({characterId:z.string(),triggerForm:z.enum(['さん','君','くん','ちゃん','さま','様']),evidenceIds:z.array(z.string()).min(2).max(8)});
const answer=z.object({decision:z.enum(['ordinary-address','habit','uncertain']),reason:z.string().trim().min(1),reviewed_ids:z.array(z.string()),evidence:z.array(z.object({occurrence_id:z.string(),quote:z.string()}).strict())}).strict();
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');

function prepare(store:ProjectStore,queueId:string) {
  const item=store.translations.getQueueItem(queueId);
  if(!item || item.kind!=='quirk-candidate' || !item.paragraph_id || item.payload.autoSuppressed || item.payload.identityInvalidated || item.payload.knowledgeDecision) return;
  const parsed=candidate.safeParse(item.payload);if(!parsed.success) return;
  const p=parsed.data;
  const members=item.payload.items;
  if(members!==undefined && (!Array.isArray(members) || members.length!==1 || members[0].paragraphId!==item.paragraph_id || !candidate.safeParse(members[0]).success || hash(candidate.parse(members[0]))!==hash(p))) return;
  if(new Set(p.evidenceIds).size!==p.evidenceIds.length || !p.evidenceIds.includes(item.paragraph_id)) return;
  const character=store.knowledge.getCharacter(p.characterId);
  if(!character || character.series_id!==item.series_id || !character.is_active || character.locked_by_user || store.knowledge.quirks(character.id).some(q=>q.trigger_form===p.triggerForm)) return;
  const sources=p.evidenceIds.map(id=>store.projects.getParagraph(id));
  if(sources.some(s=>!s || store.projects.getSeriesIdOfParagraph(s.id)!==item.series_id) || sources.reduce((n,s)=>n+(s?.sourceText.length??0),0)>9000) return;
  // Scope by actual volume membership; a merged cross-volume evidence list is never partly closed.
  const volumeIds=store.db.all<{volume_id:string}>(`SELECT DISTINCT ch.volume_id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters ch ON ch.id=s.chapter_id WHERE p.id IN (${p.evidenceIds.map(()=>'?').join(',')})`,p.evidenceIds);
  if(volumeIds.length!==1) return;
  const occurrences:{id:string;paragraphId:string;start:number;form:string;name:string;characterId:string}[]=[];
  const namesBySource=sources.map(source=>{
    const names=store.knowledge.charactersAt(item.series_id,source!.seriesOrdinal).filter(c=>c.is_active).map(c=>({id:c.id,name:c.canonical_name_jp})).sort((a,b)=>b.name.length-a.name.length || a.id.localeCompare(b.id));
    const text=source!.sourceText;
    for(let at=text.indexOf(p.triggerForm);at!==-1;at=text.indexOf(p.triggerForm,at+p.triggerForm.length)) {
      const matches=names.filter(n=>n.name && text.slice(0,at).endsWith(n.name));
      if(matches.length!==1) return null;
      const name=matches[0]!,start=at-name.name.length,previous=text[start-1]??'',next=text[at+p.triggerForm.length]??'';
      // Reject unknown name prefixes and longer lexical words. Bare/discussed suffixes have no name match.
      if(/[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9]/u.test(previous) || /[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9]/u.test(next)) return null;
      occurrences.push({id:`o${occurrences.length+1}`,paragraphId:source!.id,start,form:name.name+p.triggerForm,name:name.name,characterId:name.id});
    }
    return {id:source!.id,names};
  });
  if(namesBySource.some(x=>!x) || occurrences.length<3 || occurrences.length>30 || sources.some(s=>!occurrences.some(o=>o.paragraphId===s!.id))) return;
  const examples=sources.map(s=>({id:s!.id,source:s!.sourceText,at:s!.seriesOrdinal,chapter:s!.chapterId,type:s!.paragraphType}));
  const inputHash=hash({prompt:ORDINARY_ADDRESS_CLASSIFIER_PROMPT,candidate:p,members,character:[character.id,character.canonical_name_jp,character.locked_by_user],examples,namesBySource,occurrences,volume:volumeIds[0]!.volume_id});
  return {item,p,examples,occurrences,inputHash,volumeId:volumeIds[0]!.volume_id};
}

/** A separate source-only classification; no Chinese rendering or directed address is adopted. */
export async function dismissOrdinaryQuirk(store:ProjectStore,ai:AiClient,queueId:string,volumeId:string,signal?:AbortSignal):Promise<boolean> {
  const start=prepare(store,queueId);
  if(!start || start.item.status!=='pending' || start.volumeId!==volumeId || start.item.payload.ordinaryQuirkReview && (start.item.payload.ordinaryQuirkReview as {inputHash?:string}).inputHash===start.inputHash) return false;
  const result=await ai.structured({workstation:'ordinary-address-classifier',paragraphId:start.item.paragraph_id!,parseRetries:1,...(signal?{signal}:{}),user:JSON.stringify({task:'ordinary-address',trigger:start.p.triggerForm,examples:start.examples,occurrences:start.occurrences})},(text):ProtocolResult<z.infer<typeof answer>>=>{
    try {
      const v=answer.parse(JSON.parse(text));
      if(v.reviewed_ids.length!==start.examples.length || new Set(v.reviewed_ids).size!==v.reviewed_ids.length || start.examples.some(e=>!v.reviewed_ids.includes(e.id))) throw new Error('称谓分类须完整核对所有证据段');
      if(v.decision==='ordinary-address' && (v.evidence.length!==start.occurrences.length || new Set(v.evidence.map(e=>e.occurrence_id)).size!==v.evidence.length || start.occurrences.some(o=>!v.evidence.some(e=>{
        if(e.occurrence_id!==o.id || !e.quote) return false;
        const source=start.examples.find(p=>p.id===o.paragraphId)!.source;
        for(let at=source.indexOf(e.quote);at!==-1;at=source.indexOf(e.quote,at+1)) {
          if(at<=o.start && at+e.quote.length>=o.start+o.form.length) return true;
        }
        return false;
      })))) throw new Error('普通称谓结论须覆盖全部出现编号；每条quote须是该编号所在段落的精确原文片段，并覆盖该处完整姓名与后缀，不能引用别处或编造');
      return {ok:true,value:v};
    }catch(e){return {ok:false,error:{code:'INVALID_SHAPE',message:(e as Error).message}};}
  });
  signal?.throwIfAborted();
  return store.transaction(()=>{
    const current=prepare(store,queueId);if(!current || current.item.status!=='pending' || current.inputHash!==start.inputHash) return false;
    const review={...result.value,aiCallId:result.aiCallId,inputHash:start.inputHash,createdAt:nowIso()};
    store.translations.updateQueuePayload(queueId,{...current.item.payload,ordinaryQuirkReview:review});
    if(result.value.decision!=='ordinary-address' || !store.db.get("SELECT 1 FROM ai_calls WHERE id=? AND workstation_id='ordinary-address-classifier' AND error IS NULL AND finish_reason='stop'",[result.aiCallId])) return false;
    store.translations.updateQueuePayload(queueId,{...current.item.payload,ordinaryQuirkReview:review,automaticOrdinaryQuirkDismissal:{version:1,inputHash:start.inputHash,reviewHash:hash(review),createdAt:nowIso(),sourceIds:start.examples.map(s=>s.id)}});
    store.translations.resolveQueueItem(queueId,JSON.stringify({action:'automatic-ordinary-address-dismissal',aiCallId:result.aiCallId}));
    return true;
  });
}

export function ordinaryQuirkDismissalCurrent(store:ProjectStore,queueId:string):boolean {
  const current=prepare(store,queueId);if(!current || current.item.status!=='resolved') return false;
  const d=current.item.payload.automaticOrdinaryQuirkDismissal as {version?:number;inputHash?:string;reviewHash?:string}|undefined;
  const r=current.item.payload.ordinaryQuirkReview as {aiCallId?:string}|undefined;
  return d?.version===1 && d.inputHash===current.inputHash && d.reviewHash===hash(r) && !!r?.aiCallId && !!store.db.get("SELECT 1 FROM ai_calls WHERE id=? AND workstation_id='ordinary-address-classifier' AND error IS NULL AND finish_reason='stop'",[r.aiCallId]);
}

export function reopenOrdinaryQuirkDismissal(store:ProjectStore,queueId:string,userUndo:boolean):void {
  store.transaction(()=>{
    const item=store.translations.getQueueItem(queueId);if(!item || item.status!=='resolved' || !item.payload.automaticOrdinaryQuirkDismissal) throw new Error('此称谓误分类结案已改变或撤销');
    if(store.db.get("SELECT 1 FROM workflow_tasks WHERE workstation_id=? AND status='running'",[`repair:${queueId}`])) throw new Error('相关修复仍在运行，请先停止');
    const next={...item.payload};
    next.ordinaryQuirkHistory=[...(Array.isArray(next.ordinaryQuirkHistory)?next.ordinaryQuirkHistory:[]),{decision:next.automaticOrdinaryQuirkDismissal,review:next.ordinaryQuirkReview,undoneAt:nowIso(),reason:userUndo?'user':'source-changed'}];
    delete next.automaticOrdinaryQuirkDismissal;delete next.ordinaryQuirkReview;
    if(userUndo)next.autoSuppressed=true;
    store.translations.updateQueuePayload(queueId,next);
    store.db.run("UPDATE review_queue SET status='pending',resolution=NULL,resolved_at=NULL WHERE id=?",[queueId]);
  });
}
