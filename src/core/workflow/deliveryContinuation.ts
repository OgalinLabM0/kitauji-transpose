import { createHash } from 'node:crypto';
import type { ProjectStore } from '@core/db';
import { nowIso } from '@core/db';
import type { SeriesDeliveryState } from '@shared/ipc';
import { scopedReview } from './taskOverview';

interface WaitingSnapshot { version: 1; volumeId: string; scopeHash: string; taskHash: string; sourcesHash: string; members: { id: string; hash: string }[] }
type InternalState = SeriesDeliveryState & { waitingDecisionSnapshot?: WaitingSnapshot };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeHash = (store: ProjectStore, seriesId: string) => hash(store.projects.listVolumes(seriesId).map(v => ({ id: v.id, number: v.volumeNumber })));
const taskHash = (state: SeriesDeliveryState) => hash([state.seriesId, state.mode, state.outputPath, state.originalFileHash, state.scope, state.run?.currentVolumeId]);
const excluded = new Set(['warning', 'failed', 'review-block']);
const memberHash = (item: NonNullable<ReturnType<ProjectStore['translations']['getQueueItem']>>) => hash([item.series_id, item.kind, item.paragraph_id,
  ['sourceFormJp', 'speakerCharId', 'targetCharId', 'termId', 'characterId', 'triggerForm', 'subtype', 'field', 'at'].map(k => [k, item.payload[k] ?? null]), item.payload.items ?? null]);
function sourcesHash(store: ProjectStore, volumeId: string): string {
  return hash(store.projects.listParagraphIdsByVolume(volumeId).map(id => { const p = store.projects.getParagraph(id)!; return [id, p.sourceText, p.seriesOrdinal, p.chapterId, p.paragraphType]; }));
}
function isDecisionWait(state: SeriesDeliveryState): boolean {
  return state.continueAfterDecisions === true && state.status === 'attention' && state.phase === 'process'
    && state.run?.status === 'attention' && state.run.currentRun?.status === 'attention'
    && state.run.currentRun.phase === 'knowledge' && !state.run.currentRun.stopReason
    && state.run.currentRun.volumeId === state.run.currentVolumeId;
}
function blockers(store: ProjectStore, seriesId: string, volumeId: string) {
  // These are exactly the knowledge kinds that stop volumeFlow, including its shared series items.
  return scopedReview(store, seriesId, 'pending', volumeId).filter(q => !excluded.has(q.kind));
}

export function clearDeliveryDecisionWait(): { waitingDecisionIds: string[]; waitingDecisionSnapshot: undefined } {
  return { waitingDecisionIds: [], waitingDecisionSnapshot: undefined };
}

/** Explicit user stop while no worker is running. Running tasks remain owned by their abort signal. */
export function stopWaitingDeliveryContinuation(store: ProjectStore, seriesId: string): void {
  const key = `series-delivery:${seriesId}`;
  const row = store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [key]);
  if (!row) return;
  let state: SeriesDeliveryState;
  try { state = JSON.parse(row.value) as SeriesDeliveryState; } catch { return; }
  if (state.seriesId !== seriesId || state.status !== 'attention' || state.continueAfterDecisions !== true) return;
  store.db.run('UPDATE meta SET value=? WHERE key=?', [JSON.stringify({ ...state, ...clearDeliveryDecisionWait(), status: 'stopped', message: '已停止自动续接，成果和保存位置保留；需要时可点击继续', updatedAt: nowIso() }), key]);
}

/** Capture only the actual queue boundary. This does not authorize a session to restart work. */
export function captureDeliveryDecisionWait(store: ProjectStore, state: SeriesDeliveryState): { waitingDecisionIds: string[]; waitingDecisionSnapshot: WaitingSnapshot | undefined } {
  if (!isDecisionWait(state) || !store.projects.getSeries(state.seriesId) || scopeHash(store, state.seriesId) !== hash(state.scope)) return clearDeliveryDecisionWait();
  const volumeId = state.run!.currentVolumeId!;
  const ids = new Set(store.projects.listParagraphIdsByVolume(volumeId));
  const pending = blockers(store, state.seriesId, volumeId);
  if (!pending.length) return clearDeliveryDecisionWait();
  const members: WaitingSnapshot['members'] = [];
  for (const q of pending) {
    const row = store.translations.getQueueItem(q.id);
    if (!row || row.series_id !== state.seriesId || row.status !== 'pending') return clearDeliveryDecisionWait();
    // A combined decision crossing volumes cannot be represented as waiting for this volume alone.
    const combined = row.payload.items;
    if (combined !== undefined && (!Array.isArray(combined) || combined.some(m => !m || typeof m !== 'object' ||
      (m.paragraphId != null && (typeof m.paragraphId !== 'string' || !ids.has(m.paragraphId)))))) return clearDeliveryDecisionWait();
    members.push({ id: q.id, hash: memberHash(row) });
  }
  return { waitingDecisionIds: members.map(m => m.id), waitingDecisionSnapshot: { version: 1, volumeId, scopeHash: scopeHash(store, state.seriesId), taskHash: taskHash(state), sourcesHash: sourcesHash(store, volumeId), members } };
}

/** Read-only event check. The service must additionally require current-session user authorization. */
export function canContinueDeliveryAfterDecision(store: ProjectStore, state: SeriesDeliveryState, decidedQueueId: string): boolean {
  const snapshot = (state as InternalState).waitingDecisionSnapshot;
  if (!isDecisionWait(state) || !snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.members) || !snapshot.members.length
    || snapshot.members.some(m => !m || typeof m.id !== 'string' || typeof m.hash !== 'string')
    || !Array.isArray(state.waitingDecisionIds) || !state.waitingDecisionIds.includes(decidedQueueId) || !snapshot.members.some(m => m.id === decidedQueueId)
    || JSON.stringify(state.waitingDecisionIds) !== JSON.stringify(snapshot.members.map(m => m.id))) return false;
  try {
    if (!store.projects.getSeries(state.seriesId) || snapshot.volumeId !== state.run!.currentVolumeId
      || scopeHash(store, state.seriesId) !== snapshot.scopeHash || hash(state.scope) !== snapshot.scopeHash
      || taskHash(state) !== snapshot.taskHash || sourcesHash(store, snapshot.volumeId) !== snapshot.sourcesHash) return false;
    for (const member of snapshot.members) {
      const row = store.translations.getQueueItem(member.id);
      if (!row || !['resolved', 'dismissed'].includes(row.status) || memberHash(row) !== member.hash) return false;
    }
    return blockers(store, state.seriesId, snapshot.volumeId).length === 0;
  } catch { return false; }
}
