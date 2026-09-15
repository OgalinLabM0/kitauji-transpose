import { initialFieldInput, initialOwnershipInput, initialSupportInput, parseInitialOwnership, parseInitialSupport, combineInitialReviews, type InitialFieldAssessment } from '../validation/initialFieldEvidence';
export { initialFieldInput, initialOwnershipInput, initialSupportInput, parseInitialOwnership, parseInitialSupport } from '../validation/initialFieldEvidence';
import type { ProtocolResult } from '../ai/protocol';
import type { ProjectStore } from '../db';
import type { AiClient } from '../ai/client';
import { characterFactFrom, characterFactCurrent, saveCharacterFact, type CharacterFact } from '../db/characterHistory';
import { initialCandidateCurrent, initialCandidates, initialFieldProtected, initialFactKey, initialHash, initialReceipt, quarantineInitialFields, readInitialCall, readInitialCandidate, writeInitialCandidate, type InitialFieldCandidate } from '../db/initialFieldTrust';
import { observeWithConflicts, scheduleFieldRechecks } from './characterConflicts';

const canAdopt=(i:InitialFieldAssessment)=>i.attribution==='target' && i.support==='full' && ['durable','local'].includes(i.scope);
async function stageCall<T>(store:ProjectStore,ai:AiClient,stage:'ownership'|'support',taskHash:string,input:unknown,parse:(raw:string)=>ProtocolResult<T>,signal?:AbortSignal):Promise<{value:T;aiCallId:string}> {
  signal?.throwIfAborted();
  const calls=store.db.all<{id:string}>("SELECT id FROM ai_calls WHERE task_id=? ORDER BY created_at DESC",['initial-fields:'+stage+':'+taskHash]);
  for(const call of calls){const raw=readInitialCall(store.db,call.id,stage,taskHash,input);if(raw===null)continue;const parsed=parse(raw);if(parsed.ok)return {value:parsed.value,aiCallId:call.id};}
  return ai.structured({workstation:'character-evidence-reviewer',initialFieldAttribution:stage,user:JSON.stringify(input),taskId:'initial-fields:'+stage+':'+taskHash,...(signal?{signal}:{}),parseRetries:1,maxOutputTokens:3000},parse);
}
/** Two short independent source-only checks, with separate durable call checkpoints. */
export async function reviewInitialFields(store:ProjectStore,ai:AiClient,volumeId:string,signal?:AbortSignal):Promise<number> {
  const seriesId=store.projects.getVolumeSeriesId(volumeId);
  quarantineInitialFields(store,seriesId);
  const through=Math.max(...store.projects.listParagraphIdsByVolume(volumeId).map(id=>store.projects.getParagraph(id)!.seriesOrdinal));
  const pending=initialCandidates(store.db,seriesId).filter(c=>c.status==='pending' && c.nameQuote && c.at<=through && !initialFieldProtected(store.db,c.characterId,c.field) && initialCandidateCurrent(store.db,c));
  const groups=new Map<string,InitialFieldCandidate[]>();
  for(const c of pending){const key=initialHash([c.characterId,c.sourceProof,c.nameProof]);const values=groups.get(key)??[];values.push(c);groups.set(key,values);}
  type Plan={c:InitialFieldCandidate;candidates:InitialFieldCandidate[];input:ReturnType<typeof initialFieldInput>;inputHash:string;ownershipCallId:string;supportCallId:string|null;assessment:InitialFieldAssessment;effectiveAt:number};
  const plans:Plan[]=[];
  const current=(c:InitialFieldCandidate)=>{const row=readInitialCandidate(store.db,c.id);return !!row && row.status==='pending' && initialCandidateCurrent(store.db,row) && initialHash(row)===initialHash(c) && !initialFieldProtected(store.db,c.characterId,c.field);};
  for(const all of groups.values())for(let start=0;start<all.length;start+=5){
    signal?.throwIfAborted();const candidates=all.slice(start,start+5),input=initialFieldInput(candidates),inputHash=initialHash(input);
    if(!candidates.every(current))continue;
    const ownership=await stageCall(store,ai,'ownership',inputHash,initialOwnershipInput(candidates),raw=>parseInitialOwnership(raw,candidates),signal);
    signal?.throwIfAborted();if(!candidates.every(current))continue;
    const supportInput=initialSupportInput(candidates,ownership.value);
    const supportHash=initialHash([inputHash,ownership.aiCallId,ownership.value,supportInput]);
    const support=supportInput.candidates.length?await stageCall(store,ai,'support',supportHash,supportInput,raw=>parseInitialSupport(raw,candidates,ownership.value),signal):null;
    signal?.throwIfAborted();if(!candidates.every(current))continue;
    for(const assessment of combineInitialReviews(candidates,ownership.value,support?.value??null)){
      const c=candidates.find(c=>c.id===assessment.id)!;
      const citations=[...assessment.evidence_citations,...assessment.attribution_citations];
      const effectiveAt=Math.max(c.at,c.nameAt,...citations.map(q=>input.sources.find(s=>s.id===q.paragraph_id)!.at));
      plans.push({c,candidates,input,inputHash,ownershipCallId:ownership.aiCallId,supportCallId:support?.aiCallId??null,assessment,effectiveAt});
    }
  }
  // Attribution may be established later than extraction. Apply real effective dates,
  // not request order; a future baseline must not become the prior of an earlier fact.
  plans.sort((a,b)=>a.effectiveAt-b.effectiveAt || a.c.at-b.c.at || a.c.id.localeCompare(b.c.id));
  let adopted=0;
  for(const plan of plans)store.transaction(()=>{
    const {c,candidates,input,inputHash,ownershipCallId,supportCallId,assessment,effectiveAt}=plan;
    if(!current(c) || candidates.some(peer=>{const stored=readInitialCandidate(store.db,peer.id);return !stored || !initialCandidateCurrent(store.db,stored);}))return;
    const citations=[...assessment.evidence_citations,...assessment.attribution_citations];
    const body={aiCallId:supportCallId??ownershipCallId,ownershipCallId,supportCallId,candidateIds:candidates.map(i=>i.id),inputHash,assessment,effectiveAt};
    const review={...body,receipt:initialReceipt(c,body)};
    const prior=store.db.all<CharacterFact>("SELECT * FROM character_field_history WHERE character_id=? AND field=? AND origin='model'",[c.characterId,c.field]).filter(f=>characterFactCurrent(store.db,f) || (characterFactFrom(store.db,f)===effectiveAt && characterFactCurrent(store.db,f,c.characterId,'local')));
    const different=prior.some(f=>f.value_json!==JSON.stringify(c.value) && (assessment.scope!=='local' || characterFactFrom(store.db,f)===effectiveAt));
    const accepted=canAdopt(assessment) && !different;
    writeInitialCandidate(store.db,{...c,review,status:accepted?'accepted':assessment.attribution==='uncertain'||assessment.support==='uncertain'?'uncertain':'unadopted'});
    if(different && canAdopt(assessment)){
      const ids=[...new Set([...c.evidenceIds,...citations.map(q=>q.paragraph_id),...(c.nameQuote?[c.nameQuote.paragraph_id]:[])])];
      const key={gender:'gender',first_person_type:'firstPersonType',speech_register:'speechRegister',voice_notes:'voiceNotes',plurality:'plurality'}[c.field];
      const value=c.field==='gender'?(c.value as {gender:string}).gender:c.value;
      const row=store.knowledge.getCharacter(c.characterId)!;
      observeWithConflicts(store,{seriesId:c.seriesId,introducedVolume:row.introduced_volume,nameJp:c.name,[key]:value},ids,{[c.field]:ids},{[c.field]:[...c.quotes,...citations]},input.sources.map(s=>s.id),[],c.nameQuote??undefined);
    }
    if(accepted){
      if(!c.originalFact){
        saveCharacterFact(store.db,c.characterId,c.field,c.value,effectiveAt,'model',c.evidenceIds,undefined,c.quotes,input.sources.map(s=>s.id),[]);
        // Keep the extraction's actual event/identity dependencies. Independent
        // neighbor evidence is additionally bound by the two review receipts.
        store.db.run("UPDATE character_field_history SET source_proof=? WHERE character_id=? AND field=? AND valid_from_para=? AND origin='model'",[c.sourceProof,c.characterId,c.field,effectiveAt]);
        const fact=store.db.get<CharacterFact>("SELECT * FROM character_field_history WHERE character_id=? AND field=? AND valid_from_para=? AND origin='model'",[c.characterId,c.field,effectiveAt])!;
        store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)',[initialFactKey(c.characterId,fact),c.id]);
      }
      store.knowledge.refreshCharacterSummary(c.characterId);
      scheduleFieldRechecks(store,seriesId,effectiveAt,'人物属性已独立核实原文归属，需要复核当前稿');adopted++;
    }
  });
  return adopted;
}
