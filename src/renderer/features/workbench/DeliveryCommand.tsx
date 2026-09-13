import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SeriesDeliveryState } from '@shared/ipc';
import { api } from '../../api';
import { useApp } from '../../store/app';
import { draftIdentity } from '../../store/draftIdentityBridge';

/** One entry for the existing delivery service, without owning background work. */
export function DeliveryCommand({ seriesId, onSetup, onDetails }: { seriesId: string; onSetup: () => void; onDetails: (volumeId?: string) => void }) {
  const { rev, progress, series, toast, provider } = useApp();
  const identity = useSyncExternalStore(draftIdentity.subscribe, draftIdentity.snapshot);
  const scope = `${identity.token}:${seriesId}`;
  const current = useRef(scope); current.current = scope;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const key = JSON.stringify([scope, rev.series, rev.queue, progress.running]);
  const [loaded, setLoaded] = useState<{ key: string; value: SeriesDeliveryState | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const valid = () => mounted.current && current.current === scope && draftIdentity.isCurrent(identity.token);
  useEffect(() => {
    let live = true; setError(null);
    if (identity.status !== 'ready') return;
    void api.workflow.deliveryState(seriesId).then(value => {
      if (!live || !draftIdentity.isCurrent(identity.token)) return;
      if (value && value.seriesId !== seriesId) { setError('保存任务不匹配，请重新读取'); return; }
      setLoaded({ key, value });
    }).catch(() => { if (live && draftIdentity.isCurrent(identity.token)) setError('暂时无法读取任务'); });
    return () => { live = false; };
  }, [key, retry]);
  const ready = identity.status === 'ready' && loaded?.key === key && !error;
  const state = ready ? loaded.value : null;
  const done = state?.status === 'done' && state.result?.ok && state.result.outputPath === state.outputPath;
  const waiting = state?.status === 'attention' && !!state.waitingDecisionIds?.length;
  const needsProvider = !!provider && !provider.hasApiKey && provider.authScheme !== 'none' && !done && !waiting;
  const ours = state?.status === 'running' && progress.running;
  const work = series.find(s => s.id === seriesId);
  const changedScope = state && JSON.stringify(state.scope) !== JSON.stringify(work?.volumes.map(v => ({ id: v.id, number: v.volumeNumber })));
  const newLocation = !!state && (!!changedScope || /保存位置的文件已被改动或新增|册次范围已变化/.test(state.message));
  const label = error ? '重试读取' : !ready ? '正在读取…' : progress.running ? ours ? state?.phase === 'export' ? '正在保存' : '正在翻译' : '其他任务运行中' : newLocation ? '重新选择保存位置' : done ? '打开保存位置' : waiting ? '处理待确认项' : state && state.status !== 'done' ? '继续任务' : '开始翻译';
  const message = progress.running ? ours ? progress.message : '请等待当前任务结束' : error ?? (!ready ? '正在核对保存任务' : newLocation ? '保存目标已变化' : done ? '成品已保存' : waiting ? '确认必要译法后继续' : state?.status === 'stopped' ? '已停止，进度保留' : state?.status === 'attention' ? '任务暂停，请查看详情' : '自动预处理、翻译、检查并保存');
  async function act() {
    if (lock.current || !valid()) return;
    if (error) { setError(null); setLoaded(null); setRetry(n => n + 1); return; }
    if (!ready || progress.running) return;
    if (needsProvider) { useApp.getState().setPage('settings'); return; }
    if (newLocation) { onSetup(); return; }
    if (waiting) {
      const app = useApp.getState(); app.selectSeries(seriesId);
      const volumeId = state?.run?.currentVolumeId;
      if (volumeId && work?.volumes.some(v => v.id === volumeId)) app.selectVolume(volumeId);
      app.setPage('review'); return;
    }
    if (!state || newLocation || state.status === 'done' && !done) { onSetup(); return; }
    lock.current = true; setBusy(true);
    try {
      if (done) {
        const latest = await api.workflow.deliveryState(seriesId);
        if (!valid()) return;
        if (latest?.seriesId !== seriesId || latest.status !== 'done' || !latest.result?.ok || latest.outputPath !== state.outputPath || latest.result.outputPath !== state.outputPath || latest.updatedAt !== state.updatedAt) { setLoaded(null); setRetry(n => n + 1); return; }
        await api.files.showInFolder(latest.outputPath);
      } else {
        const next = await api.workflow.deliverSeries(seriesId);
        if (valid()) { setLoaded(null); setRetry(n => n + 1); toast(next.status === 'done' ? 'success' : 'info', next.status === 'done' ? '成品已保存' : '任务暂停，进度已保留'); }
      }
    } catch (e) { if (valid()) toast('error', (e as Error).message); }
    finally { lock.current = false; if (valid()) setBusy(false); }
  }
  return <section className="delivery-command" aria-label="翻译与保存">
    <div className="delivery-command-copy" role="status"><strong>{ready && needsProvider && !progress.running ? '首次使用，先设置翻译接口' : message}</strong><p>全部已导入册：预处理 → 术语由你确认 → 翻译与检查 → 保存成品</p>{ours && progress.total > 0 && <span className="small">{progress.phase === '全作品 · 已检查册数' ? '全作品已检查册数' : progress.phase === '保存成品' ? '已检查册数，正在保存' : '当前步骤'}：{progress.done}/{progress.total}</span>}{!progress.running && state && (state.status === 'attention' || state.status === 'stopped') && <details><summary>查看暂停原因</summary><p>{state.message}</p></details>}</div>
    <div className="delivery-command-actions">
      <button className="btn btn-primary btn-sm" disabled={busy || (!error && !ready) || progress.running} onClick={() => void act()}>{ready && needsProvider && !progress.running ? '设置接口' : label}</button>
      {(progress.running || waiting) && <button className="btn btn-secondary btn-sm" onClick={() => { if (valid()) void api.workflow.cancel().catch(e => { if (valid()) toast('error', (e as Error).message); }); }}>{progress.running && !ours ? '停止当前任务' : '停止'}</button>}
      <button className="btn btn-text btn-sm" onClick={() => { const id=state?.run?.currentVolumeId; onDetails(id && work?.volumes.some(v => v.id === id) ? id : undefined); }}>任务详情</button>
      {state && !progress.running && <button className="btn btn-text btn-sm" disabled={busy} onClick={onSetup}>保存设置</button>}
    </div>
  </section>;
}

