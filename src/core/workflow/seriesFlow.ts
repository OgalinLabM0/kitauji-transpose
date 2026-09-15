import type { ProjectStore } from '@core/db';
import { nowIso } from '@core/db';
import type { AiClient } from '@core/ai';
import type { SeriesRunState } from '@shared/ipc';
import { runVolumeFlow, volumeRunState, type VolumeFlowOptions } from './volumeFlow';
import { runQualityGate } from './qualityGate';

const key = (id: string) => `series-run:${id}`;
export function seriesRunState(store: ProjectStore, seriesId: string): SeriesRunState | null {
  const row = store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [key(seriesId)]);
  try { return row ? JSON.parse(row.value) as SeriesRunState : null; } catch { return null; }
}
export function recoverSeriesRuns(store: ProjectStore): void {
  for (const row of store.db.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key LIKE 'series-run:%'")) {
    try {
      const state = JSON.parse(row.value) as SeriesRunState;
      if (state.status === 'running') store.db.run('UPDATE meta SET value=? WHERE key=?', [JSON.stringify({ ...state, status: 'stopped', message: '上次作品任务中断，可继续处理全部册', updatedAt: nowIso() }), row.key]);
    } catch { /* Corrupt historical state is not evidence of completion. */ }
  }
}

interface SeriesFlowOptions {
  signal?: AbortSignal;
  onState?: (state: SeriesRunState) => void;
  volumeOptions?: Pick<VolumeFlowOptions, 'operations' | 'limits'>;
}

/** Each continuation revalidates earlier volumes before allowing later knowledge work. */
export async function runSeriesFlow(store: ProjectStore, ai: AiClient, seriesId: string, opts: SeriesFlowOptions = {}): Promise<SeriesRunState> {
  if (!store.projects.getSeries(seriesId)) throw new Error('作品不存在');
  const volumes = store.projects.listVolumes(seriesId);
  const scope = () => store.projects.listVolumes(seriesId).map(v => [v.id, v.volumeNumber]);
  const snapshot = JSON.stringify(scope());
  const usage = new Map(volumes.map(v => [v.id, volumeRunState(store, v.id)?.usage]));
  const startingRequests = new Map(volumes.map(v => [v.id, usage.get(v.id)?.requests ?? 0]));
  const totalUsage = () => [...usage.values()].reduce((sum, u) => ({ inputTokens: sum.inputTokens + (u?.inputTokens ?? 0), outputTokens: sum.outputTokens + (u?.outputTokens ?? 0), unknownUsageRequests: sum.unknownUsageRequests + (u?.unknownUsageRequests ?? 0) }), { inputTokens: 0, outputTokens: 0, unknownUsageRequests: 0 });
  let state: SeriesRunState = { seriesId, volumeIds: volumes.map(v => v.id), currentVolumeId: null, currentRun: null, usage: totalUsage(), status: 'running', done: 0, total: volumes.length, message: '按册次检查并连续处理全部已导入册', updatedAt: nowIso() };
  const publish = (patch: Partial<SeriesRunState>) => {
    state = { ...state, ...patch, updatedAt: nowIso() };
    store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [key(seriesId), JSON.stringify(state)]);
    opts.onState?.(structuredClone(state));
  };
  const check = () => {
    opts.signal?.throwIfAborted();
    if (JSON.stringify(scope()) !== snapshot) throw new Error('作品册次或范围已变化，请重新继续全部册');
  };
  try {
    publish({}); check();
    if (!volumes.length) throw new Error('作品没有已导入册');
    let previousEnd = -Infinity;
    for (const volume of volumes) {
      const ordinals = store.projects.listParagraphIdsByVolume(volume.id).map(id => store.projects.getParagraph(id)!.seriesOrdinal);
      if (ordinals.length && ordinals[0]! <= previousEnd) throw new Error('册号顺序与正文知识时间顺序不一致，无法安全连续处理；请先核对导入顺序，原稿和知识未改动');
      if (ordinals.length) previousEnd = ordinals.at(-1)!;
    }
    for (const [index, volume] of volumes.entries()) {
      check();
      publish({ currentVolumeId: volume.id, currentRun: null, done: index });
      check();
      const result = await runVolumeFlow(store, ai, volume.id, { ...opts.volumeOptions, ...(opts.signal ? { signal: opts.signal } : {}), onState: currentRun => {
        usage.set(volume.id, currentRun.usage);
        publish({ currentRun, usage: totalUsage(), message: `第${volume.volumeNumber}册（${index + 1}/${volumes.length}）：${currentRun.message}` });
      } });
      check();
      if (result.status !== 'done') {
        publish({ status: result.status === 'stopped' ? 'stopped' : 'attention' });
        return state;
      }
      publish({ done: index + 1 });
    }
    // Later knowledge can invalidate earlier reviews. Recheck each affected volume
    // once automatically, within its original allowance; never restart a failed run.
    const reviewOnly = new Set(['AUDIT_MISSING', 'AUDIT_STALE', 'TRAJECTORY_MISSING', 'CHAPTER_READING_MISSING', 'CHAPTER_READING_STALE', 'RECHECK_PENDING']);
    for (const volume of volumes) {
      check();
      const gate = runQualityGate(store, volume.id);
      if (gate.ok || gate.blockers.some(b => !reviewOnly.has(b.code))) continue;
      const prior = volumeRunState(store, volume.id);
      const allowance = opts.volumeOptions?.limits?.maxRequests ?? prior?.requestLimit ?? 1000;
      const spent = (usage.get(volume.id)?.requests ?? 0) - startingRequests.get(volume.id)!;
      const remaining = allowance - spent;
      if (remaining <= 0) {
        publish({ status: 'attention', currentVolumeId: volume.id, currentRun: prior, message: `第${volume.volumeNumber}册需要复查，已达到本次请求上限；已保存成果保留` });
        return state;
      }
      publish({ currentVolumeId: volume.id, currentRun: null, done: volumes.filter(v => runQualityGate(store, v.id).ok).length, message: `正在补查第${volume.volumeNumber}册受后续资料影响的内容` });
      check();
      const result = await runVolumeFlow(store, ai, volume.id, { ...opts.volumeOptions,
        limits: { ...opts.volumeOptions?.limits, maxRequests: remaining },
        ...(opts.signal ? { signal: opts.signal } : {}), onState: currentRun => {
          usage.set(volume.id, currentRun.usage);
          publish({ currentRun, usage: totalUsage(), message: `补查第${volume.volumeNumber}册：${currentRun.message}` });
        } });
      check();
      if (result.status !== 'done') {
        publish({ status: result.status === 'stopped' ? 'stopped' : 'attention' });
        return state;
      }
    }
    // A final fresh gate also catches changes made during the bounded recheck.
    for (const volume of volumes) {
      check();
      if (!runQualityGate(store, volume.id).ok) {
        publish({ status: 'attention', currentVolumeId: volume.id, currentRun: null, message: `第${volume.volumeNumber}册仍需复核，后续知识可能已使旧凭证失效；继续全部册会重新检查` });
        return state;
      }
    }
    publish({ status: 'done', done: volumes.length, currentVolumeId: null, currentRun: null, message: `全部${volumes.length}册当前版本通过交付检查，可逐册导出` });
    return state;
  } catch (error) {
    publish({ status: opts.signal?.aborted ? 'stopped' : 'attention', message: opts.signal?.aborted ? '全部册任务已停止，已保存成果保留，可继续' : (error as Error).message });
    return state;
  }
}
