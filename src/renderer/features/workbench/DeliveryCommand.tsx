import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SeriesDeliveryState } from '@shared/ipc';
import { api } from '../../api';
import { useApp } from '../../store/app';
import { draftIdentity } from '../../store/draftIdentityBridge';
import { TaskProgressView, taskPhaseLabel } from '../../components/TaskProgressView';

/** One entry for the existing delivery service, without owning background work. */
export function DeliveryCommand({ seriesId, onSetup, onDetails }: { seriesId: string; onSetup: () => void; onDetails: (volumeId?: string) => void }) {
  const { rev, progress, series, toast, provider } = useApp();
  const identity = useSyncExternalStore(draftIdentity.subscribe, draftIdentity.snapshot);
  const scope = `${identity.token}:${seriesId}`;
  const current = useRef(scope); current.current = scope;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [tick, setTick] = useState(0);
  useEffect(() => { if (!progress.running) return; const timer=setInterval(() => setTick(t => t+1), 1500); return () => clearInterval(timer); }, [progress.running]);
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
  }, [key, retry, tick]);
  const ready = identity.status === 'ready' && loaded?.key === key && !error;
  const state = ready ? loaded.value : null;
  const done = state?.status === 'done' && state.result?.ok && state.result.outputPath === state.outputPath;
  const waiting = state?.status === 'attention' && !!state.waitingDecisionIds?.length;
  const needsProvider = !!provider && !provider.hasApiKey && provider.authScheme !== 'none' && !done && !waiting;
  const ours = state?.status === 'running' && progress.running;
  const work = series.find(s => s.id === seriesId);
  const currentVolume = work?.volumes.find(v => v.id === state?.run?.currentVolumeId);
  const autoContinue = state?.continueAfterDecisions !== false;
  const changedScope = state && JSON.stringify(state.scope) !== JSON.stringify(work?.volumes.map(v => ({ id: v.id, number: v.volumeNumber })));
  const newLocation = !!state && (!!changedScope || /保存位置的文件已被改动或新增|册次范围已变化/.test(state.message));
  const canPause = ['翻译', '决定后重译', '回查重译'].includes(progress.phase);
  const label = error ? '重试读取' : !ready ? '正在读取…' : progress.running ? progress.paused ? '已暂停' : '自动处理中' : newLocation ? '重新选择保存位置' : done ? '打开保存位置' : waiting ? `处理待确认项（${state.waitingDecisionIds!.length}）` : state && state.status !== 'done' ? '继续任务' : '开始翻译';
  const message = progress.running ? progress.paused ? '已暂停 · 进度保留' : `正在${taskPhaseLabel(ours && state.phase === 'export' ? 'export' : progress.detail?.phase ?? (ours ? state.run?.currentRun?.phase : undefined) ?? progress.phase)}` : error ?? (!ready ? '正在核对保存任务' : newLocation ? '保存目标已变化' : done ? '成品已保存' : waiting ? autoContinue ? '需要你确认，完成后自动继续' : '需要你确认，完成后可继续任务' : state?.status === 'stopped' ? '已停止 · 进度保留' : state?.status === 'attention' ? '本次处理未完成 · 进度保留' : '一键处理全部已导入册');
  const reason = progress.running ? progress.message : state && !done ? state.message : '';
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
  return <section className={'delivery-command task-command' + (waiting || state?.status === 'attention' ? ' needs-attention' : '')} aria-label="翻译与保存">
    <div className="delivery-command-copy">
      <div className="task-command-title"><strong title={work?.title}>{progress.running && !ours ? '后台任务' : work?.title}{(!progress.running || ours) && currentVolume && !done ? ` · 第 ${currentVolume.volumeNumber} 册` : ''}</strong><span role="status">{ready && needsProvider && !progress.running ? '首次使用，先设置翻译接口' : message}</span></div>
      <TaskProgressView progress={progress} state={progress.running && !ours ? null : state} live={progress.running} />
      {reason && <div className={'task-reason' + (!progress.running && state?.status === 'attention' ? ' attention' : '')}>{reason}</div>}
      {!progress.running && waiting && <p className="task-next-action">{autoContinue ? '完成必要确认后会自动接着处理，已有译稿保留。' : '完成必要确认后，点击“继续任务”接着处理。'}</p>}
      {!progress.running && state?.status === 'attention' && !waiting && <p className="task-next-action">查看原因后可继续任务；已有稿件和保存位置保留。</p>}
    </div>
    <div className="delivery-command-actions">
      <button className="btn btn-primary btn-sm" disabled={busy || (!error && !ready) || progress.running} onClick={() => void act()}>{ready && needsProvider && !progress.running ? '设置接口' : label}</button>
      {progress.running && canPause && <button className="btn btn-secondary btn-sm" onClick={() => { if (valid()) void (progress.paused ? api.workflow.resume() : api.workflow.pause()).catch(e => { if (valid()) toast('error', (e as Error).message); }); }}>{progress.paused ? '继续' : '暂停'}</button>}
      {(progress.running || waiting) && <button className="btn btn-secondary btn-sm" onClick={() => { if (valid()) void api.workflow.cancel().catch(e => { if (valid()) toast('error', (e as Error).message); }); }}>{progress.running && !ours ? '停止当前任务' : '停止'}</button>}
      <button className="btn btn-text btn-sm" onClick={() => useApp.getState().setPage('logs')}>查看日志</button>
      <button className="btn btn-text btn-sm" disabled={progress.running && !ours} onClick={() => { const id=state?.run?.currentVolumeId; onDetails(id && work?.volumes.some(v => v.id === id) ? id : undefined); }}>任务详情</button>
      {state && !progress.running && <button className="btn btn-text btn-sm" disabled={busy} onClick={onSetup}>保存设置</button>}
    </div>
  </section>;
}

