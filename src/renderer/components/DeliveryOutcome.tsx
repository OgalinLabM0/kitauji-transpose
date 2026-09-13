import { useEffect, useState, useSyncExternalStore } from 'react';
import type { SeriesDeliveryState } from '@shared/ipc';
import { api } from '../api';
import { useApp, tryApi } from '../store/app';
import { draftIdentity } from '../store/draftIdentityBridge';
import { SeriesExportDialog } from '../features/workbench/SeriesExportDialog';

/** Keep the final step reachable after a decision closes the original task dialog. */
export function DeliveryOutcome() {
  const { series, rev, progress, page, currentSeriesId } = useApp();
  const identity = useSyncExternalStore(draftIdentity.subscribe, draftIdentity.snapshot);
  const scope = JSON.stringify(series.map(s => s.id));
  const key = JSON.stringify([identity.token, scope, rev.series, progress.running]);
  const [loaded, setLoaded] = useState<{ key: string; state: SeriesDeliveryState | null } | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [opened, setOpened] = useState<{ seriesId: string; token: string } | null>(null);
  useEffect(() => {
    let live = true; setError(false);
    if (identity.status !== 'ready' || progress.running) return;
    void Promise.all(series.map(async s => {
      const state = await api.workflow.deliveryState(s.id);
      return state?.seriesId === s.id && state.status !== 'running' ? state : null;
    })).then(states => {
      if (live && draftIdentity.isCurrent(identity.token)) setLoaded({ key, state: states.filter((s): s is SeriesDeliveryState => !!s).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null });
    }).catch(() => { if (live && draftIdentity.isCurrent(identity.token)) setError(true); });
    return () => { live = false; };
  }, [key, retry]);
  const state = loaded?.key === key && !error && !progress.running ? loaded.state : null;
  const title = series.find(s => s.id === state?.seriesId)?.title;
  const done = state?.status === 'done' && state.result?.ok && state.result.outputPath === state.outputPath;
  const view = () => { if (state && draftIdentity.isCurrent(identity.token)) { useApp.getState().selectSeries(state.seriesId); setOpened({ seriesId: state.seriesId, token: identity.token }); } };
  return <>
    {error && !progress.running && <div role="alert" className="small">暂时无法读取保存任务。<button className="btn btn-text btn-sm" onClick={() => setRetry(n => n + 1)}>重试读取任务</button></div>}
    {state && title && !(page === 'workbench' && currentSeriesId === state.seriesId) && <section className="delivery-outcome-bar" aria-label="保存任务结果">
      <strong>{title} · {done ? '成品已保存' : state.status === 'stopped' ? '任务已停止' : '任务需要处理'}</strong>
      <details><summary>详情</summary><p className="small">{state.message}</p></details>
      {done && <button className="btn btn-primary btn-sm" onClick={() => void tryApi(async () => {
        const latest = await api.workflow.deliveryState(state.seriesId);
        if (!draftIdentity.isCurrent(identity.token)) return;
        if (latest?.seriesId !== state.seriesId || latest.status !== 'done' || !latest.result?.ok || latest.outputPath !== state.outputPath || latest.result.outputPath !== state.outputPath || latest.updatedAt !== state.updatedAt) { setLoaded(null); setRetry(n => n + 1); return; }
        await api.files.showInFolder(latest.outputPath);
      })}>打开保存位置</button>}
      <button className="btn btn-secondary btn-sm" onClick={view}>{done ? '查看保存详情' : '查看原因与继续'}</button>
    </section>}
    {opened && opened.token === identity.token && identity.status === 'ready' && series.some(s => s.id === opened.seriesId) && <SeriesExportDialog key={`${opened.token}:${opened.seriesId}`} seriesId={opened.seriesId} autoProcess onClose={() => setOpened(null)} />}
  </>;
}
