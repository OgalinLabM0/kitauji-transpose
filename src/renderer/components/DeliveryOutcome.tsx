import { useEffect, useState, useSyncExternalStore } from 'react';
import type { SeriesDeliveryState } from '@shared/ipc';
import { api } from '../api';
import { useApp } from '../store/app';
import { draftIdentity } from '../store/draftIdentityBridge';
import { SeriesExportDialog } from '../features/workbench/SeriesExportDialog';
import { DeliveryCommand } from '../features/workbench/DeliveryCommand';
import { TaskOverview } from '../features/workbench/TaskOverview';
import { Modal } from './ui';

/** One persistent task area, shared by the manuscript, decisions and logs. */
export function DeliveryOutcome() {
  const { series, rev, progress, currentSeriesId } = useApp();
  const identity = useSyncExternalStore(draftIdentity.subscribe, draftIdentity.snapshot);
  const scope = JSON.stringify(series.map(s => s.id));
  const key = JSON.stringify([identity.token, scope, rev.series, rev.queue, progress.running]);
  const [discoveryError, setDiscoveryError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => { if (progress.running) setChosen(null); }, [progress.running]);
  const [loaded, setLoaded] = useState<{ key: string; states: SeriesDeliveryState[] } | null>(null);
  const [opened, setOpened] = useState<{ seriesId: string; token: string } | null>(null);
  const [overview, setOverview] = useState<{ volumeId: string; token: string } | null>(null);
  useEffect(() => {
    let live = true; setDiscoveryError(false);
    let reading = false;
    let foundRunning = false;
    if (identity.status !== 'ready') return;
    const read = async () => {
      if (reading || foundRunning) return;
      reading = true;
      try {
        const states = await Promise.all(series.map(async s => {
          const state = await api.workflow.deliveryState(s.id);
          return state?.seriesId === s.id ? state : null;
        }));
        if (live && draftIdentity.isCurrent(identity.token)) {
          const valid = states.filter((s): s is SeriesDeliveryState => !!s);
          setLoaded({ key, states: valid });
          foundRunning = progress.running && valid.some(s => s.status === 'running');
        }
      } catch { if (live && draftIdentity.isCurrent(identity.token)) setDiscoveryError(true); }
      finally { reading = false; }
    };
    void read();
    const timer = progress.running ? setInterval(() => void read(), 1500) : undefined;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [key, retry]);
  const states = loaded?.key === key ? loaded.states : [];
  const active = progress.running ? states.find(s => s.status === 'running') : null;
  const latest = [...states].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const seriesId = active?.seriesId ?? (chosen && series.some(s => s.id === chosen) ? chosen : null) ?? latest?.seriesId ?? currentSeriesId;
  if (identity.status !== 'ready' || !seriesId || !series.some(s => s.id === seriesId)) return null;
  return <>
    {discoveryError ? <div role="alert" className="task-discovery-error">暂时无法读取保存任务，已有进度保留。<button className="btn btn-secondary btn-sm" onClick={() => setRetry(n => n + 1)}>重试读取任务</button></div> : <>
    {!progress.running && currentSeriesId && seriesId !== currentSeriesId && <div className="task-scope-switch"><span>上次任务的进度和结果</span><button className="btn btn-text btn-sm" onClick={() => setChosen(currentSeriesId)}>处理当前作品</button></div>}
    <DeliveryCommand key={identity.token + ':' + seriesId} seriesId={seriesId}
      onSetup={() => setOpened({ seriesId, token: identity.token })}
      onDetails={volumeId => {
        const id = volumeId ?? series.find(s => s.id === seriesId)?.volumes[0]?.id;
        if (id) setOverview({ volumeId: id, token: identity.token });
      }} /></>}
    {opened && opened.token === identity.token && series.some(s => s.id === opened.seriesId) && <SeriesExportDialog key={opened.token + ':' + opened.seriesId} seriesId={opened.seriesId} autoProcess onClose={() => setOpened(null)} />}
    {overview && overview.token === identity.token && series.some(s => s.volumes.some(v => v.id === overview.volumeId)) && <Modal title="任务详情" width={760} onClose={() => setOverview(null)}><TaskOverview volumeId={overview.volumeId} onNavigate={() => setOverview(null)} /></Modal>}
  </>;
}
