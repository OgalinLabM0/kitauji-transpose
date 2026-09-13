import type { ProjectStore, Param } from '@core/db';
import { createHash } from 'node:crypto';
import { nowIso } from '@core/db';
import type { QuirkProfile, ReviewKind } from '@shared/types';
import { scheduleFieldRechecks } from './characterConflicts';
import { reopenOrdinaryQuirkDismissal } from './ordinaryQuirkDismissal';
import { reopenParagraphLiteralAddress } from './paragraphLiteralAddresses';

type RecordRow = Record<string, string | number | null> & {id:string};
const TABLES = ['terms','term_senses','term_variants','term_occurrences','characters','address_trajectories'] as const;
type Table = typeof TABLES[number];
interface Scope {
  seriesId:string; kind:'term-proposal'|'honorific-first'|'quirk-candidate'; characterIds:string[];
  termId?:string; termJp?:string; linkedTermIds?:string[];
  speakerId?:string; targetId?:string; sourceForm?:string; triggerForm?:string;
  localParagraphId?:string;
}
interface Snapshot { tables:Partial<Record<Table,RecordRow[]>>; identities:RecordRow[]; quirks?:QuirkProfile[] }
interface Journal { version:1; scope:Scope; before:Snapshot; after:Snapshot; afterHash?:string; usageIndependentHash?:string; createdAt:string; undoneAt?:string; invalidated?:boolean }
const fingerprint=(snapshot:Snapshot)=>createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
const withoutRoutineUsage = (snapshot: Snapshot): Snapshot => ({ ...snapshot, tables: { ...snapshot.tables,
  term_occurrences: (snapshot.tables.term_occurrences ?? []).filter(row => row.deviation_status !== 'none' || !!row.flagged_for_review || !!row.is_ambiguous),
} });
export interface JournalStart { scope:Scope; before:Snapshot }
export const JOURNALED_KINDS = new Set<ReviewKind>(['term-proposal','honorific-first','quirk-candidate']);

function capture(store:ProjectStore,scope:Scope):Snapshot {
  const tables:Snapshot['tables']={};
  const identities=scope.characterIds.map(id=>{
    const row=store.db.get<RecordRow>('SELECT id,series_id,canonical_name_jp,locked_by_user FROM characters WHERE id=?',[id]);
    if (!row || row.series_id!==scope.seriesId) throw new Error('决定关联的人物已不存在或不属于当前作品');
    return row;
  });
  if (scope.kind==='term-proposal') {
    const linked=scope.linkedTermIds ?? [];
    tables.terms=store.db.all<RecordRow>(`SELECT * FROM terms WHERE series_id=? AND (id=? OR term_jp=? OR superseded_by_term_id=? ${linked.length ? `OR id IN (${linked.map(()=>'?').join(',')})` : ''}) ORDER BY id`,[scope.seriesId,scope.termId!,scope.termJp!,scope.termId!,...linked]);
    const ids=[...new Set([scope.termId!,...tables.terms.filter(t=>t.term_jp===scope.termJp).map(t=>t.id)])];
    for (const table of ['term_senses','term_variants','term_occurrences'] as const) tables[table]=store.db.all<RecordRow>(`SELECT * FROM ${table} WHERE term_id IN (${ids.map(()=>'?').join(',')}) ORDER BY id`,ids);
    tables.characters=scope.characterIds.map(id=>store.db.get<RecordRow>('SELECT id,canonical_name_zh FROM characters WHERE id=?',[id])!);
  } else if (scope.kind==='honorific-first' && !scope.localParagraphId) {
    tables.address_trajectories=store.db.all<RecordRow>('SELECT * FROM address_trajectories WHERE series_id=? AND speaker_char_id=? AND target_char_id=? AND source_form_jp=? ORDER BY id',[scope.seriesId,scope.speakerId!,scope.targetId!,scope.sourceForm!]);
  }
  return {tables,identities,...(scope.kind==='quirk-candidate' ? {quirks:store.knowledge.quirks(scope.characterIds[0]!).filter(q=>q.trigger_form===scope.triggerForm)} : {})};
}

/** A paragraph-only disposition changes no character or address knowledge. */
export function beginParagraphAddressDecision(store:ProjectStore,queueId:string):JournalStart {
  const item=store.translations.getQueueItem(queueId);
  if (!item || item.kind!=='honorific-first' || item.status!=='pending' || !item.paragraph_id ||
    store.projects.getSeriesIdOfParagraph(item.paragraph_id)!==item.series_id || item.payload.speakerCharId || item.payload.knowledgeDecision || item.payload.autoSuppressed) throw new Error('本段称呼决定不满足匿名、待处理且未撤销的条件');
  const scope:Scope={kind:'honorific-first',seriesId:item.series_id,characterIds:[],localParagraphId:item.paragraph_id};
  return {scope,before:capture(store,scope)};
}

export function beginKnowledgeDecision(store:ProjectStore,queueId:string):JournalStart|undefined {
  const item=store.translations.getQueueItem(queueId);
  if (!item || !JOURNALED_KINDS.has(item.kind)) return;
  const p=item.payload;
  let scope:Scope;
  if (item.kind==='term-proposal') {
    const term=store.db.get<RecordRow>('SELECT * FROM terms WHERE id=? AND series_id=?',[String(p.termId),item.series_id]);
    // A missing/deleted proposal may still be dismissed; it has no database side effects.
    if (!term) return;
    if (store.db.get('SELECT 1 FROM terms WHERE superseded_by_term_id=? AND series_id<>?',[term.id,item.series_id])) throw new Error('术语存在跨作品引用，请先核对关联，不能修改其他作品的数据');
    const character=store.knowledge.findByName(item.series_id,String(term.term_jp));
    scope={kind:'term-proposal',seriesId:item.series_id,termId:term.id,termJp:String(term.term_jp),characterIds:character?[character.id]:[],linkedTermIds:store.db.all<{id:string}>('SELECT id FROM terms WHERE superseded_by_term_id=?',[term.id]).map(t=>t.id)};
  } else if (item.kind==='honorific-first') {
    scope={kind:'honorific-first',seriesId:item.series_id,characterIds:[String(p.speakerCharId),String(p.targetCharId)],speakerId:String(p.speakerCharId),targetId:String(p.targetCharId),sourceForm:String(p.sourceFormJp)};
  } else scope={kind:'quirk-candidate',seriesId:item.series_id,characterIds:[String(p.characterId)],triggerForm:String(p.triggerForm)};
  if (scope.characterIds.some(id=>store.knowledge.getCharacter(id)?.series_id!==scope.seriesId)) return;
  return {scope,before:capture(store,scope)};
}

export function finishKnowledgeDecision(store:ProjectStore,queueId:string,start:JournalStart):void {
  const item=store.translations.getQueueItem(queueId)!;
  const old=item.payload.knowledgeDecision as Journal|undefined;
  const history=Array.isArray(item.payload.knowledgeDecisionHistory)?item.payload.knowledgeDecisionHistory:[];
  const fullAfter=capture(store,start.scope);
  const before:Snapshot={...start.before,tables:{}},after:Snapshot={...fullAfter,tables:{}};
  // Keep only changed rows; do not duplicate thousands of unchanged term occurrences in every queue payload.
  for (const table of TABLES) {
    const a=start.before.tables[table]??[],b=fullAfter.tables[table]??[];
    const aById=new Map(a.map(row=>[row.id,JSON.stringify(row)])),bById=new Map(b.map(row=>[row.id,JSON.stringify(row)]));
    before.tables[table]=a.filter(row=>aById.get(row.id)!==bById.get(row.id));
    after.tables[table]=b.filter(row=>aById.get(row.id)!==bById.get(row.id));
  }
  const journal:Journal={version:1,scope:start.scope,before,after,afterHash:fingerprint(fullAfter),createdAt:nowIso()};
  // Automatic new-term adoption changes no usage records. Later ordinary translation is
  // historical usage, not a new knowledge decision; explicit deviations remain protected.
  if (item.payload.automaticTermDecision && start.scope.kind === 'term-proposal' &&
    !before.tables.term_occurrences?.length && !after.tables.term_occurrences?.length) {
    journal.usageIndependentHash = fingerprint(withoutRoutineUsage(fullAfter));
  }
  store.translations.updateQueuePayload(queueId,{...item.payload,knowledgeDecision:journal,knowledgeDecisionHistory:old?[...history,old]:history});
}

/** Restore rows in foreign-key order; later edits cause a refusal, never a best-effort overwrite. */
export function undoKnowledgeDecision(store:ProjectStore,queueId:string):void {
  if(store.translations.getQueueItem(queueId)?.payload.automaticParagraphLiteralAddress) { reopenParagraphLiteralAddress(store,queueId,true); return; }
  if(store.translations.getQueueItem(queueId)?.payload.automaticOrdinaryQuirkDismissal) { reopenOrdinaryQuirkDismissal(store,queueId,true); return; }
  store.transaction(()=>{
    const item=store.translations.getQueueItem(queueId);
    const journal=item?.payload.knowledgeDecision as Journal|undefined;
    if (!item || item.status==='pending' || !journal || journal.version!==1 || journal.undoneAt || journal.invalidated) throw new Error('此决定没有可用的撤销记录，或已撤销／人物已合并；旧记录不能假装恢复数据');
    const current=capture(store,journal.scope);
    const exact = journal.afterHash ? fingerprint(current) === journal.afterHash : JSON.stringify(current) === JSON.stringify(journal.after);
    const routineUsageOnly = !!journal.usageIndependentHash && journal.scope.kind === 'term-proposal' &&
      fingerprint(withoutRoutineUsage(current)) === journal.usageIndependentHash;
    if (!exact && !routineUsageOnly) throw new Error('相关知识已有后续修改，不能用旧决定覆盖；请先处理较新的决定');
    if (store.db.get("SELECT 1 FROM workflow_tasks WHERE workstation_id=? AND status='running'",[`repair:${queueId}`])) throw new Error('此决定的修复任务仍在运行，请先停止任务再撤销');
    if (routineUsageOnly) {
      for (const sense of journal.after.tables.term_senses ?? []) {
        if (journal.before.tables.term_senses?.some(row => row.id === sense.id)) continue;
        // Keep the exact historical rendering; detach only a removed generated sense.
        store.db.run("UPDATE term_occurrences SET applied_sense_id=NULL WHERE applied_sense_id=? AND term_id=? AND deviation_status='none' AND flagged_for_review=0 AND is_ambiguous=0", [sense.id, journal.scope.termId!]);
      }
    }
    // Delete only rows introduced by this decision, children first.
    for (const table of [...TABLES].reverse()) {
      const before=journal.before.tables[table]??[],after=journal.after.tables[table]??[];
      for (const row of after) if (!before.some(r=>r.id===row.id)) store.db.run(`DELETE FROM ${table} WHERE id=?`,[row.id]);
    }
    // Reinsert removed terms before their senses/occurrences, then restore changed rows.
    for (const table of TABLES) {
      const before=journal.before.tables[table]??[],after=journal.after.tables[table]??[];
      for (const row of before) if (!after.some(r=>r.id===row.id)) {
        const columns=Object.keys(row);
        store.db.run(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,columns.map(c=>row[c] as Param));
      }
      for (const row of before) {
        const current=after.find(r=>r.id===row.id);
        if (!current || JSON.stringify(current)===JSON.stringify(row)) continue;
        const columns=Object.keys(row);
        const changed=columns.filter(c=>c!=='id' && row[c]!==current[c]);
        if (changed.length) store.db.run(`UPDATE ${table} SET ${changed.map(c=>`${c}=?`).join(',')} WHERE id=?`,[...changed.map(c=>row[c] as Param),row.id]);
      }
    }
    if (journal.scope.kind==='quirk-candidate') {
      const id=journal.scope.characterIds[0]!;
      store.knowledge.setQuirks(id,[...store.knowledge.quirks(id).filter(q=>q.trigger_form!==journal.scope.triggerForm),...journal.before.quirks!]);
    }
    store.translations.updateQueuePayload(queueId,{...item.payload,knowledgeDecision:{...journal,undoneAt:nowIso()}});
    store.db.run("UPDATE review_queue SET status='pending',resolution=NULL,resolved_at=NULL WHERE id=?",[queueId]);
    store.db.run("UPDATE workflow_tasks SET status='done',error_message='原决定已撤销，取消旧修复',updated_at=? WHERE workstation_id=? AND status IN ('queued','failed')",[nowIso(),`repair:${queueId}`]);
    store.db.run("UPDATE review_queue SET status='dismissed',resolution='原决定已撤销，旧修复失败项关闭',resolved_at=? WHERE kind='failed' AND status='pending' AND json_extract(payload,'$.repairJobId') IN (SELECT id FROM workflow_tasks WHERE workstation_id=?)",[nowIso(),`repair:${queueId}`]);
    // Existing prose is preserved and re-checked against restored knowledge, including pronoun-only passages.
    if (journal.scope.localParagraphId) store.translations.addRecheck(journal.scope.localParagraphId,'paragraph-address-undone','本段称呼核对已撤销，需重新检查');
    else scheduleFieldRechecks(store,item.series_id,0);
  });
}
