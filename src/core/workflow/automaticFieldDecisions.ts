import {reopenRelationshipTermination} from './relationshipTerminationReview';
import {reopenFieldAttributionDismissal} from './fieldAttributionReview';
import { JOURNALED_KINDS, undoKnowledgeDecision } from './knowledgeDecisionJournal';
import { reopenCharacterInvalidation } from './characterInvalidationReview';
import { undoChangeDecision } from './changeDecisionJournal';
import { undoFieldReplacementArchive } from './characterConflicts';
import { dismissFieldObservations, reopenFieldDismissal } from './fieldObservationDismissal';
import type { ProjectStore } from '@core/db';
import { nowIso } from '@core/db';
import { characterAt } from '@core/db/characterHistory';
import type { AiClient } from '@core/ai';
import type { CharacterAutomaticDecisionView } from '@shared/types';
import { conflictFingerprint, fieldSnapshot, pendingFieldConflicts, refreshFieldConflicts, scheduleFieldRechecks, validateFieldConflict, type FieldConflict } from './characterConflicts';
import { FIELD_REVIEW_CONTRACT, VOICE_REVIEW_CONTRACT, REGISTER_REVIEW_CONTRACT, fieldReviewReceipt, currentFieldReviewContract, parseFieldEvidence, reviewFieldConflicts, type EvidenceReview } from './fieldEvidenceReview';
import { fieldEvidenceContext } from './fieldEvidenceContext';

const pronouns: Record<string,string[]> = { boku:['僕','ぼく'],ore:['俺','おれ'],watashi:['私','わたし'],atashi:['あたし'],uchi:['うち'],washi:['儂','わし'],sessha:['拙者'] };
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** Deliberately narrow: one complete named utterance. Unknown speakers and nested quotations never qualify. */
export function explicitFirstPerson(text: string, name: string, value: unknown): boolean {
  const forms = typeof value === 'string' ? pronouns[value] : undefined;
  if (!forms) return false;
  const match = new RegExp(`^${escaped(name)}[はが]「([^「」『』]+)」と(?:言った|言う|答えた|答える)[。！!]?$`).exec(text.trim());
  if (!match) return false;
  return forms.some(form => new RegExp(`^${escaped(form)}(?:$|[はがものをに、，。！？!?])`).test(match[1]!));
}
interface AutomaticDecision { action:'adopt-stage'; createdAt:string; afterSnapshot:string; aiCallId:string; before:unknown; proposed:unknown; sources:FieldConflict['sources']; reason:string; undoneAt?:string }
type Payload = FieldConflict & { evidenceReview?:EvidenceReview & {aiCallId:string;contract:string;inputHash:string}; automaticDecision?:AutomaticDecision; autoSuppressed?:boolean; identityInvalidated?:boolean };

export function adoptAutomaticFields(store: ProjectStore, seriesId: string, through: number): number {
  let adopted = 0;
  for (const item of pendingFieldConflicts(store,seriesId,through)) store.transaction(() => {
    const c = item.payload as unknown as Payload;
    const review = c.evidenceReview;
    if (review?.contract === VOICE_REVIEW_CONTRACT || review?.contract === REGISTER_REVIEW_CONTRACT) return; // Voice scope cannot authorize an identity field stage.
    if (c.field !== 'first_person_type' || c.autoSuppressed || c.identityInvalidated || c.automaticDecision || !review || !currentFieldReviewContract(review) || review.inputHash !== conflictFingerprint(c) || review.verdict !== 'supported-change') return;
    const {aiCallId,contract: _contract,inputHash: _inputHash,...body} = review;
    if (!store.db.get("SELECT 1 FROM ai_calls WHERE id=? AND workstation_id='character-evidence-reviewer' AND error IS NULL AND finish_reason='stop'",[aiCallId])) return;
    try { validateFieldConflict(store,c,seriesId); } catch { return; }
    let background: ReturnType<typeof fieldEvidenceContext>|undefined;
    if(review.contract===FIELD_REVIEW_CONTRACT || review.contract==='field-evidence-v3-context') {
      try{background=fieldEvidenceContext(store,c,seriesId);}catch{return;}
      if(JSON.stringify(background)!==JSON.stringify(item.payload.fieldReviewBackground) || (item.payload.fieldReviewReceipt as {hash?:string}|undefined)?.hash!==fieldReviewReceipt(c,body,aiCallId,background).hash) return;
    }
    if (!parseFieldEvidence(JSON.stringify(body),c,background).ok) return;
    const row = store.knowledge.getCharacter(c.characterId)!;
    if (row.locked_by_user || !row.is_active) return;
    if (store.db.get("SELECT 1 FROM character_field_history WHERE character_id=? AND field=? AND (valid_from_para=? OR (origin='user' AND valid_from_para<=?))",[row.id,c.field,c.at,c.at])) return;
    if (pendingFieldConflicts(store,seriesId,through).some(q => q.id !== item.id && q.payload.characterId === row.id && q.payload.field === c.field && q.payload.at === c.at)) return;
    const source = (id:string) => c.sources.find(s=>s.id===id);
    if (!c.previousEvidenceIds.length || !c.evidenceIds.length || c.previousEvidenceIds.some(id=>!source(id) || source(id)!.at >= c.at || !explicitFirstPerson(source(id)!.text,c.characterName,c.before)) ||
      c.evidenceIds.some(id=>!source(id) || source(id)!.at > c.at || !explicitFirstPerson(source(id)!.text,c.characterName,c.proposed))) return;
    if ([...c.previousEvidenceIds,...c.evidenceIds].some(id => { const a = store.projects.currentAnalysis(id); return a?.speaker_char_id && a.speaker_char_id !== row.id; })) return;
    // Keep model provenance: automatic adoption must not lock this field as if a human chose it.
    store.knowledge.observeCharacter({seriesId,introducedVolume:row.introduced_volume,nameJp:row.canonical_name_jp,firstPersonType:String(c.proposed)},c.evidenceIds,{first_person_type:c.evidenceIds},{first_person_type:c.quotes},c.sourceIds ?? c.evidenceIds,c.eventIds ?? []);
    const decision: AutomaticDecision = {action:'adopt-stage',createdAt:nowIso(),afterSnapshot:fieldSnapshot(store,row.id,c.field),aiCallId,before:c.before,proposed:c.proposed,sources:c.sources,reason:review.reason};
    store.translations.updateQueuePayload(item.id,{...item.payload,automaticDecision:decision});
    store.translations.resolveQueueItem(item.id,JSON.stringify({action:'automatic-evidenced-stage',aiCallId,policy:'explicit-first-person-v1'}));
    scheduleFieldRechecks(store,seriesId,c.at);
    adopted++;
  });
  return adopted;
}

function canUndo(store: ProjectStore, c: Payload, status: string): boolean {
  return status === 'resolved' && !!c.automaticDecision && !c.automaticDecision.undoneAt && !c.identityInvalidated &&
    !!store.knowledge.getCharacter(c.characterId) && c.field === 'first_person_type' && fieldSnapshot(store,c.characterId,c.field) === c.automaticDecision.afterSnapshot;
}

export function automaticFieldDecisions(store: ProjectStore, characterId: string): CharacterAutomaticDecisionView[] {
  return store.db.all<{id:string;status:string;payload:string}>("SELECT id,status,payload FROM review_queue WHERE json_extract(payload,'$.characterId')=? AND json_extract(payload,'$.automaticDecision.action')='adopt-stage' ORDER BY resolved_at DESC,created_at DESC LIMIT 50",[characterId]).map(row=>{
    const c = JSON.parse(row.payload) as Payload;
    return {id:row.id,field:c.field,fromPara:c.at,previous:c.automaticDecision!.before,value:c.automaticDecision!.proposed,createdAt:c.automaticDecision!.createdAt,undone:!!c.automaticDecision!.undoneAt,canUndo:canUndo(store,c,row.status),reason:c.automaticDecision!.reason,sources:c.automaticDecision!.sources};
  });
}

export function undoAutomaticFieldDecision(store: ProjectStore, characterId: string, queueId: string): void {
  store.transaction(()=>{
    const item = store.translations.getQueueItem(queueId);
    const c = item?.payload as unknown as Payload | undefined;
    if (!c || c.characterId !== characterId || !canUndo(store,c,item!.status)) throw new Error('该自动决定已被后续记录或人物合并改变，不能撤销旧版本');
    store.db.run("DELETE FROM character_field_history WHERE character_id=? AND field='first_person_type' AND valid_from_para=? AND origin='model'",[characterId,c.at]);
    const row = characterAt(store.db,store.knowledge.getCharacter(characterId)!,Number.MAX_SAFE_INTEGER);
    store.db.run('UPDATE characters SET first_person_type=?,updated_at=? WHERE id=?',[row.first_person_type,nowIso(),characterId]);
    store.translations.updateQueuePayload(queueId,{...item!.payload,automaticDecision:{...c.automaticDecision!,undoneAt:nowIso()},autoSuppressed:true});
    store.db.run("UPDATE review_queue SET status='pending',resolution=NULL,resolved_at=NULL WHERE id=?",[queueId]);
    scheduleFieldRechecks(store,item!.series_id,c.at);
  });
}

/** Route the legacy review-page undo through the same real restoration for automatic fields. */
export function undoResolvedReview(store: ProjectStore, queueId: string): void {
  const item = store.translations.getQueueItem(queueId);
  const c = item?.payload as unknown as Payload | undefined;
  if (item?.payload.automaticRelationshipTerminationReview && !(item.payload.automaticRelationshipTerminationReview as {undoneAt?:string}).undoneAt) reopenRelationshipTermination(store,queueId,true);
  else if (item?.payload.automaticCharacterInvalidationReview && !(item.payload.automaticCharacterInvalidationReview as {undoneAt?:string}).undoneAt) reopenCharacterInvalidation(store,queueId,true);
  else if (item?.payload.fieldReplacementArchive) undoFieldReplacementArchive(store,queueId);
  else if (item?.payload.automaticFieldAttributionDismissal) reopenFieldAttributionDismissal(store,queueId,true);
  else if (item?.payload.automaticFieldDismissal) reopenFieldDismissal(store,queueId,true);
  else if (c?.automaticDecision?.action === 'adopt-stage') {
    if (c.automaticDecision.undoneAt) throw new Error('自动决定已撤销；如随后做了人工决定，请在人物页撤销对应字段记录');
    undoAutomaticFieldDecision(store,c.characterId,queueId);
  } else if (item?.kind === 'stale-knowledge' && item.payload.subtype !== 'character-field') undoChangeDecision(store, queueId);
  else if (item && JOURNALED_KINDS.has(item.kind)) undoKnowledgeDecision(store,queueId);
  else store.db.run("UPDATE review_queue SET status='pending',resolution=NULL,resolved_at=NULL WHERE id=?",[queueId]);
}

/** A bounded pass can advance several chronological stages without repeatedly restarting the whole book. */
export async function resolveCharacterKnowledge(store: ProjectStore, ai: AiClient, volumeId: string, signal?: AbortSignal) {
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const through = Math.max(...store.projects.listParagraphIdsByVolume(volumeId).map(id=>store.projects.getParagraph(id)!.seriesOrdinal));
  let adopted = 0;
  // Finish one bounded pass over the actual queue; a fixed twelve observations
  // made long books stop for repeated clicks even when every call succeeded.
  const passLimit=Math.max(1,pendingFieldConflicts(store,seriesId,through).length+1);
  for (let i=0;i<passLimit;i++) {
    signal?.throwIfAborted();
    refreshFieldConflicts(store,seriesId,through);
    const reviewed = await reviewFieldConflicts(store,ai,volumeId,signal,1);
    signal?.throwIfAborted();
    const closed = dismissFieldObservations(store,seriesId,volumeId);
    const changed = adoptAutomaticFields(store,seriesId,through);
    adopted += changed;
    if (!reviewed && !changed && !closed) break;
  }
  refreshFieldConflicts(store,seriesId,through);
  return {adopted};
}
