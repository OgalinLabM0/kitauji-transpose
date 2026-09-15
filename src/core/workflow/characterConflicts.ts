import { createHash } from 'node:crypto';
import type { ProjectStore } from '@core/db';
import type { KnowledgeRepo } from '@core/db/knowledgeRepo';
import { characterFactCurrent, type CharacterFact, type CharacterField } from '@core/db/characterHistory';
import { characterSourceCurrent, originalSourceProof } from '../db/characterSources';
import { withIdentityRead } from '../db/identitySources';
import { stageInitialField } from '../db/initialFieldTrust';

type Observation = Parameters<KnowledgeRepo['observeCharacter']>;
type Quote = { paragraph_id: string; quote: string };
export interface FieldConflict {
  subtype: 'character-field'; characterId: string; characterName: string; field: CharacterField;
  before: unknown; proposed: unknown; at: number; snapshot: string;
  evidenceIds: string[]; quotes: Quote[];
  sources: { id: string; text: string; at: number }[];
  previousEvidenceIds: string[];
  sourceProof?: string; previousSourceProof?: string | null; sourceIds?: string[]; eventIds?: string[];
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceSeries = (store: ProjectStore, id: string) => store.db.get<{series_id: string}>(`SELECT v.series_id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters ch ON ch.id=s.chapter_id JOIN volumes v ON v.id=ch.volume_id WHERE p.id=?`, [id])?.series_id;
const semantic = (field: CharacterField, value: any): unknown => field === 'gender' ? value?.gender : value;
export function conflictFingerprint(c: FieldConflict): string {
  return hash({ subtype:c.subtype, characterId:c.characterId, characterName:c.characterName, field:c.field, before:c.before, proposed:c.proposed, at:c.at,
    snapshot:c.snapshot, evidenceIds:c.evidenceIds, previousEvidenceIds:c.previousEvidenceIds, quotes:c.quotes, sources:c.sources,
    sourceProof:c.sourceProof,previousSourceProof:c.previousSourceProof,sourceIds:c.sourceIds,eventIds:c.eventIds });
}
export function fieldSnapshot(store: ProjectStore, id: string, field: CharacterField): string {
  const c = store.knowledge.getCharacter(id);
  return hash([c?.canonical_name_jp, c?.locked_by_user, c?.is_active, field === 'gender' ? [c?.gender, c?.gender_confidence, c?.gender_evidence_ids] : c?.[field],
    store.db.all('SELECT field,value_json,valid_from_para,origin,evidence_ids,source_quotes,source_proof FROM character_field_history WHERE character_id=? AND field=? ORDER BY valid_from_para,origin', [id,field])]);
}

export function pendingFieldConflicts(store: ProjectStore, seriesId: string, through: number) {
  return store.translations.listQueue(seriesId).filter(q => q.payload.subtype === 'character-field' && Number(q.payload.at) <= through);
}

/** Preparation stages uncertain differences without promoting them into the effective profile. */
export function observeWithConflicts(store: ProjectStore, ...args: Observation): string {
  return store.transaction(() => {
    const [input, evidenceIds, evidenceByField, quotesByField = {}, sourceIds = evidenceIds, eventIds = [], nameEvidence] = args;
    const observationAt = Math.max(...sourceIds.map(id => store.projects.getParagraph(id)?.seriesOrdinal ?? -1));
    const existing = store.knowledge.findByName(input.seriesId, input.nameJp, observationAt);
    if (existing?.locked_by_user) return store.knowledge.observeCharacter(...args);
    const nameId = store.knowledge.observeCharacter({seriesId:input.seriesId,introducedVolume:input.introducedVolume,nameJp:input.nameJp},evidenceIds,evidenceByField,quotesByField,sourceIds,eventIds,nameEvidence);
    const row = store.knowledge.getCharacter(nameId)!;
    const safe = { ...input };
    for (const [key, field] of [['gender','gender'], ['firstPersonType','first_person_type'], ['speechRegister','speech_register'], ['voiceNotes','voice_notes'], ['plurality','plurality']] as const) {
      const value = input[key];
      if (value == null || value === '' || value === 'unknown') continue;
      const ids = [...new Set(evidenceByField?.[field] ?? evidenceIds)];
      if (!ids.length || ids.some(id => !evidenceIds.includes(id))) throw new Error('人物字段证据不属于本次观察');
      const paragraphs = ids.map(id => store.projects.getParagraph(id));
      if (paragraphs.some(p => !p || sourceSeries(store,p.id) !== input.seriesId)) throw new Error('人物字段证据不属于当前作品');
      const at = Math.max(...paragraphs.map(p => p!.seriesOrdinal));
      if (store.db.get("SELECT 1 FROM character_field_history WHERE character_id=? AND field=? AND origin='user' AND valid_from_para<=?", [row.id,field,at])) continue;
      const history = store.db.all<CharacterFact>("SELECT * FROM character_field_history WHERE character_id=? AND field=? AND origin='model' ORDER BY valid_from_para DESC", [row.id,field]);
      const facts = withIdentityRead(store.db, () => history.filter(f => characterFactCurrent(store.db,f,row.id,['voice_notes','speech_register'].includes(field)?'local':'global')));
      const prior = facts.find(f => f.valid_from_para <= at) ?? facts.at(-1);
      const before = prior ? JSON.parse(prior.value_json) : history.length ? null : field === 'gender' ? { gender: store.knowledge.characterAt(row,at).gender } : store.knowledge.characterAt(row,at)[field];
      const proposed = field === 'gender' ? { gender: value, confidence: input.genderConfidence ?? 0, evidenceIds: ids } : value;
      if (semantic(field,before) == null || semantic(field,before) === 'unknown' || semantic(field,before) === '') {
        safe[key]=null;
        stageInitialField(store,{characterId:row.id,field,value:proposed,at,evidenceIds:ids,quotes:quotesByField[field]??[],sourceIds,eventIds});
        continue;
      }
      if (semantic(field,before) === semantic(field,proposed)) {safe[key]=null;continue;}
      safe[key] = null;
      const previousEvidenceIds: string[] = prior ? JSON.parse(prior.evidence_ids) : [];
      const sources = [...new Set([...previousEvidenceIds,...ids])].map(id => {
        const p = store.projects.getParagraph(id);
        if (!p) throw new Error('人物旧证据已失效，请重新准备');
        return { id, text: p.sourceText, at: p.seriesOrdinal };
      });
      const payload: FieldConflict = { subtype: 'character-field', characterId: row.id, characterName: row.canonical_name_jp, field, before, proposed, at,
        snapshot: fieldSnapshot(store,row.id,field), evidenceIds: ids, previousEvidenceIds, quotes: quotesByField[field] ?? [], sources,
        sourceProof: originalSourceProof(store.db,input.seriesId,sourceIds,eventIds), previousSourceProof: prior?.source_proof ?? null, sourceIds, eventIds };
      const groupKey = `character-field:${conflictFingerprint(payload)}`;
      // Resolved decisions are also a receipt: identical observations must not re-open them.
      if (!store.db.get('SELECT 1 FROM review_queue WHERE series_id=? AND group_key=?', [input.seriesId,groupKey])) {
        const paragraphId = paragraphs.find(p => p!.seriesOrdinal === at)!.id;
        store.translations.enqueue({ seriesId: input.seriesId, kind: 'stale-knowledge', paragraphId, groupKey,
          title: `${row.canonical_name_jp}：${({gender:'性别',first_person_type:'一人称',speech_register:'语域',voice_notes:'声音说明',plurality:'人数'})[field]} 前后观察不同，待核对`, payload: { ...payload } });
      }
    }
    return store.knowledge.observeCharacter(safe,evidenceIds,evidenceByField,quotesByField,sourceIds,eventIds,nameEvidence);
  });
}

export function validateFieldConflict(store: ProjectStore, c: FieldConflict, seriesId: string): void {
  if (!characterSourceCurrent(store.db,c.sourceProof) || (c.previousSourceProof && !characterSourceCurrent(store.db,c.previousSourceProof))) throw new Error('候选原文或预读背景证据已改变，请重新预读');
  if ((c as FieldConflict & { identityInvalidated?: boolean }).identityInvalidated) throw new Error('人物已合并，请重新核对归属');
  const row = store.knowledge.getCharacter(c.characterId);
  if (!row || row.series_id !== seriesId || fieldSnapshot(store,c.characterId,c.field) !== c.snapshot) throw new Error('人物字段已改变，请保留旧记录并重新预读核对，不能采纳过期候选');
  for (const source of c.sources) {
    const p = store.projects.getParagraph(source.id);
    if (!p || p.sourceText !== source.text || p.seriesOrdinal !== source.at || sourceSeries(store,p.id) !== seriesId) throw new Error('候选原文证据已改变，请重新预读');
  }
}

export function applyFieldConflict(store: ProjectStore, c: FieldConflict, seriesId: string): number {
  validateFieldConflict(store,c,seriesId);
  const key = { gender: 'gender', first_person_type: 'firstPersonType', speech_register: 'speechRegister', voice_notes: 'voiceNotes', plurality: 'plurality' }[c.field];
  if (!key) throw new Error('未知人物字段');
  store.knowledge.updateCharacter(c.characterId, { [key]: semantic(c.field,c.proposed) }, c.at);
  return scheduleFieldRechecks(store,seriesId,c.at);
}

export function scheduleFieldRechecks(store: ProjectStore, seriesId: string, at: number, reason = '人物字段阶段决定变化，需要复核当前稿'): number {
  // Include pronoun-only paragraphs: a name substring search misses affected narration/dialogue.
  const affected = store.db.all<{id: string}>(`SELECT DISTINCT p.id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters ch ON ch.id=s.chapter_id JOIN volumes v ON v.id=ch.volume_id JOIN translation_finals f ON f.paragraph_id=p.id WHERE v.series_id=? AND p.series_ordinal>=?`, [seriesId,at]);
  for (const p of affected) store.translations.addRecheck(p.id,'user-decision',reason);
  return affected.length;
}

/** Refresh knowledge-dependent comparisons only. Changed source must be re-read, never silently re-certified. */
export function refreshFieldConflicts(store: ProjectStore, seriesId: string, through: number): number {
  // This synchronous pass only updates review_queue metadata, including its
  // replacement archive. Source, identity and narrative facts remain unchanged;
  // share their dependency proofs until return, never across an await or later call.
  return withIdentityRead(store.db, () => {
  let refreshed = 0;
  const originals = new Map(pendingFieldConflicts(store,seriesId,through).map(q=>[q.id,store.translations.getQueueItem(q.id)!.payload]));
  for (const item of pendingFieldConflicts(store,seriesId,through)) store.transaction(() => {
    const c = item.payload as unknown as FieldConflict;
    const row = store.knowledge.getCharacter(c.characterId);
    const note = (message: string) => store.translations.updateQueuePayload(item.id,{...item.payload,evidenceReview:undefined,evidenceReviewNote:message});
    if (!row || row.series_id !== seriesId || item.payload.identityInvalidated || row.canonical_name_jp !== c.characterName) { note('人物归属已改变，需重新预读核对'); return; }
    if (c.sources.some(s => { const p = store.projects.getParagraph(s.id); return !p || p.sourceText !== s.text || p.seriesOrdinal !== s.at || sourceSeries(store,s.id) !== seriesId; })) { note('原文证据已改变，旧候选不能复用；请重新预读'); return; }
    if (!characterSourceCurrent(store.db,c.sourceProof) || (c.previousSourceProof && !characterSourceCurrent(store.db,c.previousSourceProof))) { note('候选预读背景依据已变化，旧候选不能复用；请重新预读'); return; }
    if (!row.is_active || row.locked_by_user) { note('人物已停用或暂停自动更新，候选保留'); return; }
    if (store.db.get("SELECT 1 FROM character_field_history WHERE character_id=? AND field=? AND origin='user' AND valid_from_para<=?",[row.id,c.field,c.at])) {
      store.translations.resolveQueueItem(item.id,JSON.stringify({action:'superseded-by-user-field',snapshot:fieldSnapshot(store,row.id,c.field)})); refreshed++; return;
    }
    const snapshot = fieldSnapshot(store,row.id,c.field);
    if (snapshot === c.snapshot) {
      if (syncHistoricalMemberSnapshot(store,item.id,seriesId)) refreshed++;
      return;
    }
    const prior = store.db.all<CharacterFact>("SELECT * FROM character_field_history WHERE character_id=? AND field=? AND origin='model' AND valid_from_para<=? ORDER BY valid_from_para DESC",[row.id,c.field,c.at]).find(f => characterFactCurrent(store.db,f));
    if (!prior) { note('当前阶段缺少有位置的旧记录，需重新预读'); return; }
    const before: unknown = JSON.parse(prior.value_json);
    if (semantic(c.field,before) === semantic(c.field,c.proposed)) {
      store.translations.resolveQueueItem(item.id,JSON.stringify({action:'already-effective-field',snapshot})); refreshed++; return;
    }
    const previousEvidenceIds: string[] = JSON.parse(prior.evidence_ids);
    const sources: FieldConflict['sources'] = [];
    for (const id of new Set([...previousEvidenceIds,...c.evidenceIds])) {
      const p = store.projects.getParagraph(id);
      if (!p || sourceSeries(store,id) !== seriesId) { note('当前字段记录缺少有效原文证据，需重新预读'); return; }
      sources.push({id,text:p.sourceText,at:p.seriesOrdinal});
    }
    const next: FieldConflict = {...c,before,snapshot,previousEvidenceIds,sources,previousSourceProof:prior.source_proof ?? null};
    const groupKey = `character-field:${conflictFingerprint(next)}`;
    const duplicate = store.db.get<{id:string}>('SELECT id FROM review_queue WHERE series_id=? AND group_key=? AND id<>?',[seriesId,groupKey,item.id]);
    if (duplicate) store.translations.resolveQueueItem(item.id,JSON.stringify({action:'replaced-field-candidate',replacementId:duplicate.id}));
    else {
      const history = Array.isArray(item.payload.refreshHistory) ? item.payload.refreshHistory : [];
      const members=item.payload.items;
      const synced=Array.isArray(members) && members.length===1 && members[0].paragraphId===item.paragraphId && conflictFingerprint(members[0])===conflictFingerprint(c)
        ? {items:[{...members[0],...next}]} : {};
      store.translations.updateQueuePayload(item.id,{...item.payload,...next,...synced,evidenceReview:undefined,evidenceReviewNote:'旧知识已变化，已刷新前后对照，等待重新核对',refreshHistory:[...history,{snapshot:c.snapshot,before:c.before,previousEvidenceIds:c.previousEvidenceIds,sources:c.sources,evidenceReview:item.payload.evidenceReview ?? null}]});
      store.db.run('UPDATE review_queue SET group_key=? WHERE id=?',[groupKey,item.id]);
    }
    refreshed++;
  });
  return refreshed + archiveReplacedFieldObservations(store,seriesId,through,originals);
  });
}

/** Compatibility for the old refresh path that changed only the top-level snapshot. */
function syncHistoricalMemberSnapshot(store:ProjectStore,queueId:string,seriesId:string):boolean {
  const item=store.translations.getQueueItem(queueId);if(!item || item.status!=='pending') return false;
  const p=item.payload,c=p as unknown as FieldConflict,members=p.items,history=p.refreshHistory;
  if(['autoSuppressed','identityInvalidated','automaticDecision','automaticFieldDismissal','knowledgeDecision','fieldReplacementArchive','userDecision'].some(k=>!!p[k])) return false;
  if(!Array.isArray(members) || members.length!==1 || !members[0] || members[0].paragraphId!==item.paragraph_id || !Array.isArray(history) || history.length!==1) return false;
  const member=members[0],old=history[0];
  if(!member || !old || typeof member.snapshot!=='string' || member.snapshot===c.snapshot || old.snapshot!==member.snapshot ||
    JSON.stringify(old.before)!==JSON.stringify(c.before) || JSON.stringify(old.previousEvidenceIds)!==JSON.stringify(c.previousEvidenceIds) || JSON.stringify(old.sources)!==JSON.stringify(c.sources) ||
    conflictFingerprint({...member,snapshot:c.snapshot})!==conflictFingerprint(c)) return false;
  const row=store.knowledge.getCharacter(c.characterId);
  if(!row || row.series_id!==seriesId || !row.is_active || row.locked_by_user || row.canonical_name_jp!==c.characterName ||
    store.db.get("SELECT 1 FROM character_field_history WHERE character_id=? AND field=? AND origin='user'",[c.characterId,c.field])) return false;
  try{validateFieldConflict(store,c,seriesId);}catch{return false;}
  store.translations.updateQueuePayload(queueId,{...p,items:[{...member,snapshot:c.snapshot}],memberSnapshotRepair:{from:member.snapshot,to:c.snapshot,at:new Date().toISOString()}});
  return true;
}

/** A completed full reread may replace a stale observation, never certify its old evidence. */
function archiveReplacedFieldObservations(store:ProjectStore,seriesId:string,through:number,originals:Map<string,Record<string,unknown>>):number {
  let archived=0;
  const candidates=pendingFieldConflicts(store,seriesId,through);
  // This synchronous pass changes only review-queue metadata, never preread
  // sources or character facts. Recheck each volume once per pass; do not retain
  // these results across calls, awaits, or later source/knowledge changes.
  const completedByVolume=new Map<string,Set<string>>();
  const eligible=(id:string)=>{
    const item=store.translations.getQueueItem(id);
    if(!item || item.status!=='pending' || !item.paragraph_id || item.kind!=='stale-knowledge') return;
    const p=item.payload,c=p as unknown as FieldConflict;
    if(c.subtype!=='character-field' || ['autoSuppressed','identityInvalidated','automaticDecision','automaticFieldDismissal','knowledgeDecision','fieldReplacementArchive','userDecision'].some(k=>!!p[k])) return;
    if(p.items!==undefined && (!Array.isArray(p.items) || p.items.length!==1 || p.items[0].paragraphId!==item.paragraph_id || conflictFingerprint(p.items[0])!==conflictFingerprint(c))) return;
    const row=store.knowledge.getCharacter(c.characterId);
    if(!row || row.series_id!==seriesId || row.canonical_name_jp!==c.characterName || !row.is_active || row.locked_by_user || store.db.get("SELECT 1 FROM character_field_history WHERE character_id=? AND field=? AND origin='user'",[c.characterId,c.field])) return;
    if(!c.sourceIds?.length || new Set(c.sourceIds).size!==c.sourceIds.length || !c.evidenceIds?.length || c.evidenceIds.some(id=>!c.sourceIds!.includes(id))) return;
    let proof:{ids?:string[]};try{proof=JSON.parse(c.sourceProof??'');}catch{return;}
    if(!Array.isArray(proof.ids) || hash([...proof.ids].sort())!==hash([...c.sourceIds].sort())) return;
    const positions=c.sourceIds.map(id=>store.projects.getParagraph(id));
    if(positions.some(p=>!p || sourceSeries(store,p.id)!==seriesId)) return;
    const chapters=new Set(positions.map(p=>p!.chapterId));if(chapters.size!==1) return;
    const chapterId=positions[0]!.chapterId;
    const volume=store.db.get<{volume_id:string}>('SELECT volume_id FROM chapters WHERE id=?',[chapterId]);
    if(!volume) return;
    let completed=completedByVolume.get(volume.volume_id);
    if(!completed) { completed=store.projects.prepDoneChapters('preread',volume.volume_id); completedByVolume.set(volume.volume_id,completed); }
    if(!completed.has(chapterId)) return;
    return {item,c,batch:hash([...c.sourceIds].sort())};
  };
  for(const q of candidates)store.transaction(()=>{
    const old=eligible(q.id);if(!old || characterSourceCurrent(store.db,old.c.sourceProof)) return;
    const replacements=candidates.filter(n=>n.id!==q.id).map(n=>eligible(n.id)).filter(n=>{
      if(!n || n.c.characterId!==old.c.characterId || n.c.field!==old.c.field || n.batch!==old.batch || !n.c.previousSourceProof) return false;
      try{validateFieldConflict(store,n.c,seriesId);return true;}catch{return false;}
    });
    if(replacements.length!==1) return;
    const replacement=replacements[0]!;
    const preserved=originals.get(q.id)??old.item.payload;
    store.translations.updateQueuePayload(q.id,{...preserved,fieldReplacementArchive:{version:1,replacementId:replacement.item.id,replacementFingerprint:conflictFingerprint(replacement.c),sourceIds:old.c.sourceIds,at:new Date().toISOString()}});
    store.translations.resolveQueueItem(q.id,JSON.stringify({action:'replaced-stale-field-observation',replacementId:replacement.item.id,replacementFingerprint:conflictFingerprint(replacement.c)}));
    archived++;
  });
  return archived;
}

export function undoFieldReplacementArchive(store:ProjectStore,queueId:string):void {
  store.transaction(()=>{
    const item=store.translations.getQueueItem(queueId);
    const archive=item?.payload.fieldReplacementArchive as Record<string,unknown>|undefined;
    if(!item || item.status!=='resolved' || !archive || archive.undoneAt) throw new Error('旧观察归档已改变或已撤销');
    store.translations.updateQueuePayload(queueId,{...item.payload,fieldReplacementArchive:{...archive,undoneAt:new Date().toISOString()},autoSuppressed:true});
    store.db.run("UPDATE review_queue SET status='pending',resolution=NULL,resolved_at=NULL WHERE id=?",[queueId]);
  });
}
