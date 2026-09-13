import type { ProjectStore } from '@core/db';
import { nowIso } from '@core/db';
import { conflictFingerprint, pendingFieldConflicts, validateFieldConflict, type FieldConflict } from './characterConflicts';
import { REGISTER_REVIEW_CONTRACT, VOICE_REVIEW_CONTRACT, fieldReviewUsesBackground, currentFieldReviewContract, fieldReviewReceipt, parseFieldEvidence, type EvidenceReview } from './fieldEvidenceReview';
import { fieldEvidenceContext } from './fieldEvidenceContext';

type Review = EvidenceReview & { aiCallId: string; contract: string; inputHash: string };
interface Disposition { version: 1; inputHash: string; receiptHash: string; aiCallId: string; verdict: 'equivalent'|'compatible'|'local-register'|'unsupported'|'uncertain'; action?:'unadopted-voice-observation'|'local-register-observation'; createdAt: string; undoneAt?: string }
type Payload = FieldConflict & { evidenceReview?: Review; fieldReviewBackground?: ReturnType<typeof fieldEvidenceContext>; fieldReviewReceipt?: {version: number; hash: string}; automaticFieldDismissal?: Disposition; autoSuppressed?: boolean; identityInvalidated?: boolean; items?: Record<string, unknown>[] };

/** This archive is only for an unused suggestion, never an adopted character fact. */
function unusedVoice(store:ProjectStore,c:Payload):boolean {
  if(c.field!=='voice_notes' || typeof c.proposed!=='string' || !c.proposed.trim())return false;
  const proposed=c.proposed.trim(),row=store.knowledge.getCharacter(c.characterId);
  if(row?.voice_notes?.trim()===proposed)return false;
  if(store.db.get("SELECT 1 FROM character_field_history WHERE character_id=? AND field='voice_notes' AND origin='user'",[c.characterId]))return false;
  const values=store.db.all<{value_json:string}>("SELECT value_json FROM character_field_history WHERE character_id=? AND field='voice_notes' UNION ALL SELECT value_json FROM character_field_baselines WHERE character_id=? AND field='voice_notes'",[c.characterId,c.characterId]);
  try {
    for(const r of store.db.all<{fact_json:string}>('SELECT fact_json FROM character_field_archive WHERE character_id=?',[c.characterId])) {
      const fact=JSON.parse(r.fact_json);if(fact.field==='voice_notes')values.push({value_json:fact.value_json});
    }
    for(const r of store.db.all<{previous_fact_json:string|null;applied_fact_json:string}>("SELECT previous_fact_json,applied_fact_json FROM character_field_edits WHERE character_id=? AND field='voice_notes'",[c.characterId])) {
      for(const raw of [r.previous_fact_json,r.applied_fact_json])if(raw)values.push({value_json:JSON.parse(raw).value_json});
    }
    return !values.some(r=>{const v=JSON.parse(r.value_json);return typeof v==='string' && v.trim()===proposed;});
  }catch{return false;}
}
function isUnadoptedReview(c:Payload):boolean {
  const r=c.evidenceReview;
  return c.field==='voice_notes' && r?.contract===VOICE_REVIEW_CONTRACT && r.verdict==='uncertain' && r.voiceAssessment?.proposed_support==='uncertain' && r.voiceAssessment.scope==='uncertain';
}

function verified(store: ProjectStore, c: Payload, seriesId: string): Review | undefined {
  // These observations describe voice, not categorical identity or an explicit first-person stage.
  if (!['speech_register','voice_notes'].includes(c.field) || c.autoSuppressed || c.identityInvalidated || !c.sourceProof || !c.previousSourceProof || !c.previousEvidenceIds?.length || !c.evidenceIds?.length) return;
  const review = c.evidenceReview;
  const unadopted=isUnadoptedReview(c);
  if(review?.contract===REGISTER_REVIEW_CONTRACT && c.field!=='speech_register')return;
  if((review?.registerAssessment || review?.verdict==='local-register') && review.contract!==REGISTER_REVIEW_CONTRACT)return;
  if (!review || !currentFieldReviewContract(review) || review.inputHash !== conflictFingerprint(c)) return;
  if(unadopted ? !unusedVoice(store,c) : review.attribution !== 'supported' || !['equivalent','compatible','local-register','unsupported'].includes(review.verdict))return;
  const {aiCallId, contract: _contract, inputHash: _inputHash, ...body} = review;
  let background: ReturnType<typeof fieldEvidenceContext>|undefined;
  if(fieldReviewUsesBackground(review)) {
    try{background=fieldEvidenceContext(store,c,seriesId);}catch{return;}
    if(JSON.stringify(background)!==JSON.stringify(c.fieldReviewBackground))return;
  }
  const parsed = parseFieldEvidence(JSON.stringify(body), c, background, review.contract===VOICE_REVIEW_CONTRACT,review.contract===REGISTER_REVIEW_CONTRACT);
  if (!parsed.ok || c.fieldReviewReceipt?.version !== 1 || c.fieldReviewReceipt.hash !== fieldReviewReceipt(c, parsed.value, aiCallId, background).hash) return;
  if (!store.db.get("SELECT 1 FROM ai_calls WHERE id=? AND workstation_id='character-evidence-reviewer' AND error IS NULL AND finish_reason='stop'", [aiCallId])) return;
  // Require every claimed field evidence location, not merely one quote from either side.
  if (!unadopted && [...c.previousEvidenceIds,...c.evidenceIds].some(id => !body.citations.some(q => q.paragraph_id === id))) return;
  const row = store.knowledge.getCharacter(c.characterId);
  if (!row || row.series_id !== seriesId || !row.is_active || row.locked_by_user || row.canonical_name_jp !== c.characterName) return;
  if (store.db.get("SELECT 1 FROM character_field_history WHERE character_id=? AND field=? AND origin='user' AND valid_from_para<=?", [c.characterId,c.field,c.at])) return;
  try { validateFieldConflict(store,c,seriesId); } catch { return; }
  return review;
}

function singleMember(c: Payload, paragraphId: string | null): boolean {
  return !c.items || (c.items.length === 1 && c.items[0]!.paragraphId === paragraphId && conflictFingerprint(c.items[0] as unknown as FieldConflict) === conflictFingerprint(c));
}

/** Close a verified false alarm or archive an unused uncertain voice suggestion. No character facts are written. */
export function dismissFieldObservations(store: ProjectStore, seriesId: string, volumeId: string): number {
  const ids = new Set(store.projects.listParagraphIdsByVolume(volumeId));
  if (store.projects.getVolumeSeriesId(volumeId) !== seriesId) return 0;
  let closed = 0;
  for (const q of pendingFieldConflicts(store,seriesId,Number.MAX_SAFE_INTEGER)) store.transaction(() => {
    const item = store.translations.getQueueItem(q.id);
    if (!item || item.status !== 'pending' || !item.paragraph_id || !ids.has(item.paragraph_id)) return;
    const c = item.payload as unknown as Payload;
    if (c.automaticFieldDismissal || !singleMember(c,item.paragraph_id) || c.evidenceIds.some(id => !ids.has(id))) return;
    const review = verified(store,c,seriesId);
    if (!review) return;
    const decision: Disposition = {version:1,inputHash:conflictFingerprint(c),receiptHash:c.fieldReviewReceipt!.hash,aiCallId:review.aiCallId,verdict:review.verdict as Disposition['verdict'],...(isUnadoptedReview(c)?{action:'unadopted-voice-observation' as const}:review.verdict==='local-register'?{action:'local-register-observation' as const}:{}),createdAt:nowIso()};
    store.translations.updateQueuePayload(item.id,{...item.payload,automaticFieldDismissal:decision});
    store.translations.resolveQueueItem(item.id,JSON.stringify({action:decision.action??'automatic-field-observation-dismissal',verdict:decision.verdict,aiCallId:decision.aiCallId,...(decision.action==='unadopted-voice-observation'?{reason:'证据不足，未采用的声音观察；没有确认人物归属或修改声音字段，正文仍须正常翻译与审校。'}:decision.action==='local-register-observation'?{reason:'仅本处语域观察，未替换长期语域值；正文按此处原文的说话方式翻译。'}:{})}));
    closed++;
  });
  return closed;
}

export function fieldDismissalCurrent(store: ProjectStore, queueId: string): boolean {
  const item = store.translations.getQueueItem(queueId);
  if (!item || item.status !== 'resolved') return false;
  const c = item.payload as unknown as Payload, d = c.automaticFieldDismissal;
  return !!d && d.version === 1 && !d.undoneAt && singleMember(c,item.paragraph_id) && d.inputHash === conflictFingerprint(c) && d.receiptHash === c.fieldReviewReceipt?.hash && d.aiCallId === c.evidenceReview?.aiCallId && d.verdict===c.evidenceReview?.verdict && (d.verdict==='uncertain' ? d.action==='unadopted-voice-observation' : d.verdict==='local-register'?d.action==='local-register-observation':!d.action) && !!verified(store,c,item.series_id);
}

/** A compatible observation applies only at its own evidence, never the whole preread batch. */
export function localVoiceObservations(store: ProjectStore, paragraphIds: readonly string[]): {paragraphId:string;characterId:string;name:string;note:string}[] {
  const rows: {paragraphId:string;characterId:string;name:string;note:string}[]=[];
  for (const paragraphId of paragraphIds) {
    const paragraph=store.projects.getParagraph(paragraphId);
    const analysis=store.projects.currentAnalysis(paragraphId);
    if (!paragraph || !analysis?.speaker_char_id || !store.projects.sceneObservation(paragraphId)) continue;
    for (const item of store.db.all<{id:string;payload:string}>("SELECT id,payload FROM review_queue WHERE status='resolved' AND json_extract(payload,'$.automaticFieldDismissal.verdict')='compatible' AND json_extract(payload,'$.characterId')=?",[analysis.speaker_char_id])) {
      const c=JSON.parse(item.payload) as Payload;
      if (c.field!=='voice_notes' || typeof c.proposed!=='string' || c.proposed.length>1200 || !c.evidenceIds.includes(paragraphId) || paragraph.seriesOrdinal<c.at || !fieldDismissalCurrent(store,item.id)) continue;
      rows.push({paragraphId,characterId:c.characterId,name:c.characterName,note:c.proposed});
    }
  }
  return rows;
}

/** Reopening restores only the question; later knowledge edits are never overwritten. */
export function reopenFieldDismissal(store: ProjectStore, queueId: string, userUndo: boolean): void {
  store.transaction(() => {
    const item = store.translations.getQueueItem(queueId);
    const c = item?.payload as unknown as Payload | undefined;
    if (!item || item.status !== 'resolved' || !c?.automaticFieldDismissal || c.automaticFieldDismissal.undoneAt) throw new Error('字段观察结案已改变或已撤销');
    if (store.db.get("SELECT 1 FROM workflow_tasks WHERE workstation_id=? AND status='running'", [`repair:${queueId}`])) throw new Error('此决定的修复仍在运行，请先停止');
    const next = {...item.payload};
    if(next.evidenceReview)next.fieldEvidenceReviewHistory=[...(Array.isArray(next.fieldEvidenceReviewHistory)?next.fieldEvidenceReviewHistory:[]),{review:next.evidenceReview,receipt:next.fieldReviewReceipt,background:next.fieldReviewBackground}];
    next.fieldDismissalHistory = [...(Array.isArray(next.fieldDismissalHistory) ? next.fieldDismissalHistory : []),{...c.automaticFieldDismissal,undoneAt:nowIso(),reason:userUndo ? 'user' : 'source-changed'}];
    for (const key of ['automaticFieldDismissal','fieldReviewReceipt','evidenceReview']) delete next[key];
    if (userUndo) next.autoSuppressed = true;
    next.evidenceReviewNote = userUndo ? '已撤销自动结案，保留人工核对' : '原文或人物依据已变化，旧结案已撤回，需重新核对';
    store.translations.updateQueuePayload(queueId,next);
    store.db.run("UPDATE review_queue SET status='pending',resolution=NULL,resolved_at=NULL WHERE id=?",[queueId]);
  });
}
