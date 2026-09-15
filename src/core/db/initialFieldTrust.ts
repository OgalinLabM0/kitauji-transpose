import { createHash } from 'node:crypto';
import type { ProjectStore } from './index';
import type { Db } from './database';
import { fromJson, nowIso } from './database';
import type { CharacterFact, CharacterField } from './characterHistory';
import { characterSourceCurrent, originalSourceProof } from './characterSources';
import { validNameQuote } from '../validation/nameEvidence';
import { INITIAL_OWNERSHIP_PROMPT, INITIAL_SUPPORT_PROMPT } from '../ai/prompts/initialFieldPrompt';
import { initialFieldInput, initialOwnershipInput, initialSupportInput, parseInitialOwnership, parseInitialSupport, combineInitialReviews } from '../validation/initialFieldEvidence';
import { readIdentityProof, withIdentityRead } from './identitySources';
import { conflictFingerprint, type FieldConflict } from '../workflow/characterConflicts';
import { fieldReviewReceipt, parseFieldEvidence, currentFieldReviewContract } from '../workflow/fieldEvidenceReview';
import { explicitFirstPerson } from '../workflow/automaticFieldDecisions';

export const INITIAL_FIELD_CONTRACT = 'initial-field-attribution-v2:' + createHash('sha256').update(INITIAL_OWNERSHIP_PROMPT+'\n'+INITIAL_SUPPORT_PROMPT).digest('hex');
export const initialHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type InitialQuote = { paragraph_id: string; quote: string };
export type InitialSource = { id: string; text: string; at: number; chapterId: string };
export interface InitialFieldCandidate {
  id: string; contract: string; seriesId: string; characterId: string; name: string;
  field: CharacterField; value: unknown; at: number; evidenceIds: string[]; quotes: InitialQuote[];
  sourceProof: string; sources: InitialSource[]; nameProof: string | null; nameAt: number; nameQuote: InitialQuote | null;
  originalFact?: CharacterFact; status: 'pending' | 'accepted' | 'unadopted' | 'uncertain';
  review?: InitialFieldReview;
  createdAt: string;
}
export interface InitialFieldReview { aiCallId:string; ownershipCallId:string; supportCallId:string|null; candidateIds:string[]; inputHash:string; assessment:unknown; effectiveAt:number; receipt:string }
const prefix = 'initial-field:candidate:';
export const initialFactKey = (id: string, fact: CharacterFact) => 'initial-field:fact:' + initialHash([id, fact.field, fact.value_json, fact.valid_from_para, fact.evidence_ids, fact.source_proof]);
export function readInitialCandidate(db: Db, id: string): InitialFieldCandidate | null {
  return fromJson(db.get<{value:string}>('SELECT value FROM meta WHERE key=?',[prefix+id])?.value,null);
}
export function writeInitialCandidate(db: Db, c: InitialFieldCandidate): void {
  db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)',[prefix+c.id,JSON.stringify(c)]);
}
export function initialCandidates(db: Db, seriesId: string): InitialFieldCandidate[] {
  return db.all<{value:string}>("SELECT value FROM meta WHERE key LIKE 'initial-field:candidate:%'").map(r=>fromJson<InitialFieldCandidate|null>(r.value,null)).filter((c):c is InitialFieldCandidate=>!!c && c.seriesId===seriesId).sort((a,b)=>a.at-b.at || a.id.localeCompare(b.id));
}
export function initialCandidateCurrent(db: Db, c: InitialFieldCandidate): boolean {
  const {id:_id,originalFact:_originalFact,status:_status,review:_review,createdAt:_createdAt,...body}=c;
  if(c.id!==initialHash(body))return false;
  if(c.contract!==INITIAL_FIELD_CONTRACT || !characterSourceCurrent(db,c.sourceProof))return false;
  const row=db.get<{canonical_name_jp:string;is_active:number}>('SELECT canonical_name_jp,is_active FROM characters WHERE id=? AND series_id=?',[c.characterId,c.seriesId]);
  if(!row?.is_active || row.canonical_name_jp!==c.name)return false;
  if(c.nameProof && !characterSourceCurrent(db,c.nameProof))return false;
  return c.sources.every(s=>{const p=db.get<{source_text:string;series_ordinal:number;chapter_id:string}>(`SELECT p.source_text,p.series_ordinal,s.chapter_id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id WHERE p.id=?`,[s.id]);return p?.source_text===s.text && p.series_ordinal===s.at && p.chapter_id===s.chapterId;});
}
export function initialReceipt(c:InitialFieldCandidate,review:Omit<InitialFieldReview,'receipt'>):string {
  return initialHash([INITIAL_FIELD_CONTRACT,c.id,review]);
}
/** Raw successful call record, including actual retry diagnostics; base input alone is not the sent request. */
export function readInitialCall(db:Db,aiCallId:string,stage:'ownership'|'support',taskHash:string,input:unknown):string|null {
  if(!db.get("SELECT 1 FROM ai_calls WHERE id=? AND task_id=? AND workstation_id='character-evidence-reviewer' AND error IS NULL AND finish_reason='stop'",[aiCallId,'initial-fields:'+stage+':'+taskHash]))return null;
  const call=fromJson<{baseUser:string;user:string;response:string;stage:string;prompt:string;diagnostics:string[]}|null>(db.get<{value:string}>('SELECT value FROM meta WHERE key=?',['initial-field-call:'+aiCallId])?.value,null);
  if(!call || call.stage!==stage || call.prompt!==(stage==='ownership'?INITIAL_OWNERSHIP_PROMPT:INITIAL_SUPPORT_PROMPT) || call.baseUser!==JSON.stringify(input) || !Array.isArray(call.diagnostics) || call.diagnostics.length>3)return null;
  const expected=call.diagnostics.length?call.baseUser+'\n\n【本次重试须同时满足】以下是本次调用已发现的问题；已改好的部分继续保持，不要修好一项又改坏另一项。\n'+call.diagnostics.map((d,i)=>String(i+1)+'. '+d).join('\n')+'\n请严格按契约重新输出完整 JSON（不是修补，是完整重发）。':call.baseUser;
  return call.user===expected?call.response:null;
}
export function initialFactCandidate(db: Db, fact: CharacterFact, characterId = fact.character_id): InitialFieldCandidate | null {
  if(!characterId || fact.origin==='user')return null;
  const id=db.get<{value:string}>('SELECT value FROM meta WHERE key=?',[initialFactKey(characterId,fact)])?.value;
  return id?readInitialCandidate(db,id):null;
}
export function initialFactAllowed(db:Db,fact:CharacterFact,characterId=fact.character_id,scope:'global'|'local'='global'):boolean {
  if(fact.origin==='user')return true;if(!characterId)return false;
  const c=initialFactCandidate(db,fact,characterId);if(!c)return independentStageAllowed(db,characterId,fact);
  if(c.characterId!==characterId || c.field!==fact.field || JSON.stringify(c.value)!==fact.value_json)return false;
  return readIdentityProof(db,'initial-field:'+scope+':'+c.id+':'+JSON.stringify(c.review),()=>{
    const r=c.review;if(c.status!=='accepted' || !r || !initialCandidateCurrent(db,c))return false;
    const {receipt,...body}=r;if(receipt!==initialReceipt(c,body) || !r.supportCallId || r.aiCallId!==r.supportCallId)return false;
    try {
      const candidates=r.candidateIds.map(id=>readInitialCandidate(db,id));
      if(candidates.some(i=>!i || !initialCandidateCurrent(db,i)))return false;
      const group=candidates as InitialFieldCandidate[];
      if(initialHash(initialFieldInput(group))!==r.inputHash)return false;
      const ownershipRaw=readInitialCall(db,r.ownershipCallId,'ownership',r.inputHash,initialOwnershipInput(group));if(!ownershipRaw)return false;
      const ownership=parseInitialOwnership(ownershipRaw,group);if(!ownership.ok)return false;
      const supportInput=initialSupportInput(group,ownership.value),supportHash=initialHash([r.inputHash,r.ownershipCallId,ownership.value,supportInput]);
      const supportRaw=readInitialCall(db,r.supportCallId,'support',supportHash,supportInput);if(!supportRaw)return false;
      const support=parseInitialSupport(supportRaw,group,ownership.value);if(!support.ok)return false;
      const assessment=combineInitialReviews(group,ownership.value,support.value).find(i=>i.id===c.id);
      if(!assessment || initialHash(assessment)!==initialHash(r.assessment) || assessment.attribution!=='target' || assessment.support!=='full' || (assessment.scope==='local' && scope!=='local'))return false;
      const sources=initialFieldInput(group).sources;
      const effectiveAt=Math.max(c.at,c.nameAt,...[...assessment.evidence_citations,...assessment.attribution_citations].map(q=>sources.find(s=>s.id===q.paragraph_id)!.at));
      return effectiveAt===r.effectiveAt;
    }catch{return false;}
  });
}
/** Keep a previously accepted, independent chronological change; never infer one from a name or a lock. */
function independentStageAllowed(db:Db,id:string,fact:CharacterFact):boolean {
  if(fact.field!=='first_person_type')return false;
  return db.all<{payload:string}>(`SELECT payload FROM review_queue WHERE status='resolved' AND json_extract(payload,'$.characterId')=? AND json_extract(payload,'$.field')=? AND json_extract(payload,'$.at')=?`,[id,fact.field,fact.valid_from_para]).some(row=>{
    const c=fromJson<any>(row.payload,null),d=c?.automaticDecision,r=c?.evidenceReview;
    if(!(d?.action==='adopt-stage' && !d.undoneAt && !c.identityInvalidated && !c.autoSuppressed && JSON.stringify(d.proposed)===fact.value_json && JSON.stringify(c.proposed)===fact.value_json && d.aiCallId===r?.aiCallId && r.verdict==='supported-change' && r.attribution==='supported' && characterSourceCurrent(db,c.sourceProof) && characterSourceCurrent(db,c.previousSourceProof) && !!db.get("SELECT 1 FROM ai_calls WHERE id=? AND workstation_id='character-evidence-reviewer' AND error IS NULL AND finish_reason='stop'",[d.aiCallId])))return false;
    if(!currentFieldReviewContract(r) || r.inputHash!==conflictFingerprint(c) || c.sourceProof!==fact.source_proof || JSON.stringify(c.evidenceIds)!==fact.evidence_ids)return false;
    const {aiCallId,contract:_contract,inputHash:_inputHash,...body}=r;
    if(r.contract==='field-evidence-v2') {
      // Preserve a historical decision under its actual contract. It must still
      // have the successful review and both complete, explicitly named utterances.
      const side=(ids:string[],value:unknown)=>ids.length && ids.every(id=>{const s=c.sources.find((s:FieldConflict['sources'][number])=>s.id===id);const p=db.get<{source_text:string;series_ordinal:number}>('SELECT source_text,series_ordinal FROM paragraphs WHERE id=?',[id]);return s && p && p.source_text===s.text && p.series_ordinal===s.at && explicitFirstPerson(s.text,c.characterName,value);});
      return parseFieldEvidence(JSON.stringify(body),c,[]).ok && !!side(c.previousEvidenceIds,c.before) && !!side(c.evidenceIds,c.proposed);
    }
    const background=c.fieldReviewBackground;
    if(!Array.isArray(background) || ![...c.sources,...background].every((s:FieldConflict['sources'][number])=>{const p=db.get<{source_text:string;series_ordinal:number}>('SELECT source_text,series_ordinal FROM paragraphs WHERE id=?',[s.id]);return p?.source_text===s.text && p.series_ordinal===s.at;}))return false;
    return parseFieldEvidence(JSON.stringify(body),c,background).ok && c.fieldReviewReceipt?.hash===fieldReviewReceipt(c,body,aiCallId,background).hash;
  });
}
export function initialFactFrom(db: Db, fact: CharacterFact): number {
  return Math.max(fact.valid_from_para,initialFactCandidate(db,fact)?.review?.effectiveAt??fact.valid_from_para);
}
export function initialFieldProtected(db: Db, id: string, field: CharacterField): boolean {
  return !!db.get('SELECT 1 FROM characters WHERE id=? AND locked_by_user=1',[id]) || !!db.get("SELECT 1 FROM character_field_history WHERE character_id=? AND field=? AND origin='user'",[id,field]);
}

/** Original records remain intact. The separate receipt controls their use. */
export function stageInitialField(store: ProjectStore, args: {characterId:string;field:CharacterField;value:unknown;at:number;evidenceIds:string[];quotes:InitialQuote[];sourceIds:string[];eventIds?:string[];originalFact?:CharacterFact}): InitialFieldCandidate {
  const row=store.knowledge.getCharacter(args.characterId)!;
  const supplied=args.sourceIds.map(id=>store.projects.getParagraph(id)).filter(p=>!!p);
  const max=Math.max(args.at,...supplied.map(p=>p!.seriesOrdinal));
  const names=store.db.all<{source_proof:string;valid_from_para:number}>(`SELECT source_proof,valid_from_para FROM character_name_observations WHERE character_id=? AND name_jp=? AND valid_from_para<=? ORDER BY valid_from_para`,[row.id,row.canonical_name_jp,max]);
  const name=names.find(n=>characterSourceCurrent(store.db,n.source_proof) && (()=>{const q=fromJson<{nameEvidence?:InitialQuote}>(n.source_proof,{}).nameEvidence;return q && validNameQuote(row.canonical_name_jp,q.quote,store.projects.getParagraph(q.paragraph_id)?.sourceText??'');})());
  const fallback=supplied.filter(p=>validNameQuote(row.canonical_name_jp,p!.sourceText,p!.sourceText)).sort((a,b)=>a!.seriesOrdinal-b!.seriesOrdinal)[0];
  const nameQuote=name?fromJson<{nameEvidence:InitialQuote}>(name.source_proof,{} as any).nameEvidence:fallback?{paragraph_id:fallback.id,quote:fallback.sourceText}:null;
  // At most the original extraction window plus two adjacent raw paragraphs per evidence.
  const ids=new Set(args.evidenceIds);
  if(nameQuote)ids.add(nameQuote.paragraph_id);
  for(const id of [...ids]) {
    const p=store.projects.getParagraph(id);if(!p)continue;
    for(const other of store.projects.listParagraphIdsByChapter(p.chapterId)) {
      const q=store.projects.getParagraph(other)!;
      if(Math.abs(q.seriesOrdinal-p.seriesOrdinal)<=2 && q.seriesOrdinal<=max+2)ids.add(other);
    }
  }
  const sources=[...ids].map(id=>{const p=store.projects.getParagraph(id);if(!p)throw new Error('人物属性原文已不存在');return {id,text:p.sourceText,at:p.seriesOrdinal,chapterId:p.chapterId};}).sort((a,b)=>a.at-b.at);
  const sourceProof=args.originalFact?.source_proof??originalSourceProof(store.db,row.series_id,args.sourceIds,args.eventIds??[]);
  const body={contract:INITIAL_FIELD_CONTRACT,seriesId:row.series_id,characterId:row.id,name:row.canonical_name_jp,field:args.field,value:args.value,at:args.at,evidenceIds:args.evidenceIds,quotes:args.quotes,sourceProof,sources,nameProof:name?.source_proof??null,nameAt:name?.valid_from_para??fallback?.seriesOrdinal??args.at,nameQuote};
  const id=initialHash(body);
  const c=readInitialCandidate(store.db,id)??{...body,id,...(args.originalFact?{originalFact:args.originalFact}:{}),status:'pending' as const,createdAt:nowIso()};
  writeInitialCandidate(store.db,c);
  if(args.originalFact)store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)',[initialFactKey(row.id,args.originalFact),id]);
  return c;
}

/** Called before model contexts: historical unreviewed model fields are candidates too. */
export function quarantineInitialFields(store: ProjectStore, seriesId: string): number {
  return withIdentityRead(store.db,()=>{
  let count=0;
  for(const fact of store.db.all<CharacterFact & {character_id:string;source_quotes:string}>(`SELECT h.* FROM character_field_history h JOIN characters c ON c.id=h.character_id WHERE c.series_id=? AND h.origin='model'`,[seriesId])) {
    if(initialFieldProtected(store.db,fact.character_id,fact.field) || initialFactCandidate(store.db,fact))continue;
    // Existing independently checked changes are outside initial-field migration.
    if(independentStageAllowed(store.db,fact.character_id,fact))continue;
    const proof=fromJson<{ids?:string[]}>(fact.source_proof,{});
    const ids=fromJson<string[]>(fact.evidence_ids,[]);
    if(!ids.length || ids.some(id=>!store.projects.getParagraph(id)))continue; // Source-current already excludes unavailable originals.
    stageInitialField(store,{characterId:fact.character_id,field:fact.field,value:fromJson(fact.value_json,null),at:fact.valid_from_para,evidenceIds:ids,quotes:fromJson(fact.source_quotes,[]),sourceIds:proof.ids??ids,originalFact:fact});count++;
    for(const p of store.db.all<{id:string}>(`SELECT p.id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters ch ON ch.id=s.chapter_id JOIN volumes v ON v.id=ch.volume_id JOIN translation_finals f ON f.paragraph_id=p.id WHERE v.series_id=? AND p.series_ordinal>=?`,[seriesId,fact.valid_from_para]))store.translations.addRecheck(p.id,'user-decision','人物旧模型属性尚待独立原文归属核对');
  }
  return count;
  });
}
