import type { ProjectStore, Param } from '@core/db';
import { nowIso } from '@core/db';
import { changeTarget, changeTables } from '../db/knowledgeChanges';
import { scheduleFieldRechecks } from './characterConflicts';

type Row = Record<string, string | number | null>;
interface Scope { seriesId: string; candidateId: string; kind: keyof typeof changeTables; targetId: string; accepted: boolean }
interface Snapshot { candidate: Row; target: string | null; provenance: Row | null }
interface Start { scope: Scope; before: Snapshot }
interface Receipt extends Start { version: 1; after: Snapshot; undoneAt?: string }

function capture(store: ProjectStore, scope: Scope): Snapshot {
  const candidate = store.db.get<Row>('SELECT * FROM knowledge_change_candidates WHERE id=? AND series_id=?', [scope.candidateId, scope.seriesId]);
  if (!candidate || candidate.entity_type !== scope.kind || candidate.entity_id !== scope.targetId) throw new Error('知识变化候选已不存在或目标已变化，不能撤销旧决定');
  return { candidate, target: scope.accepted ? changeTarget(store.db, scope.kind, scope.targetId, scope.seriesId) : null,
    provenance: scope.accepted && scope.kind === 'relationship' ? store.db.get<Row>("SELECT * FROM narrative_provenance WHERE kind='relationship' AND record_id=?", [scope.targetId]) ?? null : null };
}

export function beginChangeDecision(store: ProjectStore, queueId: string, accepted: boolean): Start {
  const item = store.translations.getQueueItem(queueId)!;
  const candidateId = String(item.payload.candidateId);
  const candidate = store.db.get<Row>('SELECT * FROM knowledge_change_candidates WHERE id=? AND series_id=?', [candidateId, item.series_id]);
  if (!candidate || candidate.status !== 'pending') throw new Error('知识变化候选不存在、已处理或不属于当前作品');
  if (!Object.hasOwn(changeTables, String(candidate.entity_type))) throw new Error('不支持的知识变化目标');
  const scope: Scope = { seriesId: item.series_id, candidateId, kind: candidate.entity_type as Scope['kind'], targetId: String(candidate.entity_id), accepted };
  return { scope, before: capture(store, scope) };
}

export function finishChangeDecision(store: ProjectStore, queueId: string, start: Start): void {
  const item = store.translations.getQueueItem(queueId)!;
  const previous = item.payload.changeDecision;
  const history = Array.isArray(item.payload.changeDecisionHistory) ? item.payload.changeDecisionHistory : [];
  const receipt: Receipt = { ...start, version: 1, after: capture(store, start.scope) };
  store.translations.updateQueuePayload(queueId, { ...item.payload, changeDecision: receipt, changeDecisionHistory: previous ? [...history, previous] : history });
}

/** Undo the actual interval/status mutation, never just reopen its UI card. */
export function undoChangeDecision(store: ProjectStore, queueId: string): void {
  store.transaction(() => {
    const item = store.translations.getQueueItem(queueId);
    const receipt = item?.payload.changeDecision as Receipt | undefined;
    if (!item || item.status === 'pending' || !receipt || receipt.version !== 1 || receipt.undoneAt) throw new Error('此知识变化没有可用的撤销记录；旧决定不能只恢复卡片而假装恢复知识');
    if (receipt.scope.seriesId !== item.series_id || receipt.scope.candidateId !== item.payload.candidateId) throw new Error('撤销记录与当前知识候选不一致');
    const current = capture(store, receipt.scope);
    if (JSON.stringify(current) !== JSON.stringify(receipt.after)) throw new Error('相关知识已有后续修改，请先处理较新的决定，不能覆盖');
    if (receipt.scope.accepted) {
      const before = JSON.parse(receipt.before.target!) as Row, after = JSON.parse(receipt.after.target!) as Row;
      const allowed = receipt.scope.kind === 'character' ? ['is_active', 'deactivated_at_para'] : ['valid_to_para'];
      const changed = allowed.filter(k => before[k] !== after[k]);
      if (changed.length) store.db.run(`UPDATE ${changeTables[receipt.scope.kind]} SET ${changed.map(k => `${k}=?`).join(',')} WHERE id=?`, [...changed.map(k => before[k] as Param), receipt.scope.targetId]);
      if (receipt.before.provenance && receipt.after.provenance && receipt.before.provenance.content_hash !== receipt.after.provenance.content_hash) {
        store.db.run("UPDATE narrative_provenance SET content_hash=? WHERE kind='relationship' AND record_id=?", [receipt.before.provenance.content_hash!, receipt.scope.targetId]);
      }
      scheduleFieldRechecks(store, item.series_id, 0, '知识变化决定已撤销，需要按恢复后的知识复核当前稿');
    }
    store.db.run("UPDATE knowledge_change_candidates SET status='pending' WHERE id=?", [receipt.scope.candidateId]);
    store.translations.updateQueuePayload(queueId, { ...item.payload, changeDecision: { ...receipt, undoneAt: nowIso() } });
    store.db.run("UPDATE review_queue SET status='pending',resolution=NULL,resolved_at=NULL WHERE id=?", [queueId]);
  });
}
