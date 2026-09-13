import { useVolumeOverview } from '../../store/useVolumeOverview';
import { deliveryStatus } from './deliveryStatus';
import { PersistentImportDialog } from './PersistentImportDialog';
import { SeriesExportDialog } from '../workbench/SeriesExportDialog';
import type { ImportQueueState, ImportQueueDamage } from '@shared/importQueue';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useApp } from '../../store/app';
import { draftIdentity } from '../../store/draftIdentityBridge';
import { api } from '../../api';
import { ConfirmDestructive, Modal, Progress, Pill } from '../../components/ui';
import { BookOpen, Plus, Trash2, Library } from 'lucide-react';
import type { SeriesSummary, VolumeSummary } from '@shared/types';

function ShelfVolume({ volume, onOpen }: { volume: VolumeSummary; onOpen: () => void }) {
  const { value, running, error } = useVolumeOverview(volume.id);
  const status = deliveryStatus(value, running, error);
  return <button className="shelf-volume" onClick={onOpen} title={error || '点击打开这一册'}>
    <span className="shelf-volume-name">第 {volume.volumeNumber} 册{volume.title && <span className="small muted"> · {volume.title}</span>}</span>
    <span className="shelf-volume-progress"><Progress value={volume.translatedCount} max={volume.paragraphCount} /><span className="small muted">已翻译 {volume.translatedCount}/{volume.paragraphCount} 段</span></span>
    <Pill kind={status.kind}>{status.label}</Pill>
  </button>;
}

/** Local destructive flow: keep failed confirmation and fence every late side effect. */
function DeleteSeriesDialog({ series, scopeToken, refreshSeries, onClose }: { series: SeriesSummary; scopeToken: string; refreshSeries: () => Promise<void>; onClose: () => void }) {
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleted, setDeleted] = useState(false);
  const lock = useRef(false);
  const deletedOnce = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && draftIdentity.isCurrent(scopeToken);
  const close = () => { if (!lock.current && current()) onClose(); };
  const confirm = async (): Promise<void> => {
    if (lock.current || !current() || (!deletedOnce.current && confirmation.trim() !== series.title)) return;
    lock.current = true; setBusy(true); setError('');
    try {
      if (!deletedOnce.current) {
        await api.project.deleteSeries(series.id);
        if (!current()) return;
        deletedOnce.current = true; setDeleted(true);
      }
      // A refresh failure is not a deletion failure. Never delete twice on refresh retry.
      await refreshSeries();
      if (!current()) return;
      useApp.getState().toast('success', '已删除');
      onClose();
    } catch (failure) {
      if (!current()) return;
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(deletedOnce.current
        ? `删除已完成，但书架刷新失败：${message}。请重试刷新，不会再次删除。`
        : `删除失败：${message}。删除对象和确认输入已保留，请核对后重试。`);
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  };
  return <Modal title="删除系列" onClose={close} footer={<>
    <button className="btn btn-secondary" disabled={busy} onClick={close}>{deleted ? '关闭' : '取消'}</button>
    <button className="btn btn-danger" disabled={busy || (!deleted && confirmation.trim() !== series.title)} onClick={() => void confirm()}>{busy ? '处理中…' : deleted ? '重试刷新书架' : '确认删除'}</button>
  </>}>
    <p>会删除「{series.title}」的全部 {series.volumes.length} 册、译文、知识和待处理记录。此操作不可恢复。</p>
    {error && <p role="alert">{error}</p>}
    <div className="field" style={{ marginTop: 12 }}><label htmlFor="delete-series-confirmation">输入“{series.title}”以确认</label><input id="delete-series-confirmation" className="input" value={confirmation} disabled={busy || deleted} onChange={e => setConfirmation(e.target.value)} autoFocus /></div>
  </Modal>;
}

export function ShelfPage() {
  const { series, currentSeriesId, selectSeries, selectVolume, setPage, refreshSeries, rev, progress } = useApp();
  // 各系列知识库概况（多系列时一眼看出每个系列的进展）
  const [stats, setStats] = useState<Record<string, { chars: number; terms: number; queue: number }>>({});
  useEffect(() => { void (async () => { const out: Record<string, { chars: number; terms: number; queue: number }> = {}; for (const s of series) { try { const [c, t, q] = await Promise.all([api.knowledge.characters(s.id), api.glossary.list(s.id), api.review.counts(s.id)]); out[s.id] = { chars: c.length, terms: t.length, queue: Object.values(q).reduce((a, b) => a + b, 0) }; } catch { /* 系列可能刚被删 */ } } setStats(out); })(); }, [series, rev.knowledge, rev.glossary, rev.queue]);
  const [importing, setImporting] = useState<ImportQueueState | null>(null);
  const [queues, setQueues] = useState<ImportQueueState[]>([]);
  const [damaged, setDamaged] = useState<ImportQueueDamage[]>([]);
  const [quarantining, setQuarantining] = useState<ImportQueueDamage | null>(null);
  const [queueError, setQueueError] = useState('');
  const [discarding, setDiscarding] = useState<ImportQueueState | null>(null);
  const [picking, setPicking] = useState(false);
  const pickLock = useRef(false);
  const deletionScope = useSyncExternalStore(draftIdentity.subscribe, draftIdentity.snapshot);
  const [del, setDel] = useState<{ series: SeriesSummary; scopeToken: string } | null>(null);
  const [delivery, setDelivery] = useState<{ seriesId: string; scopeToken: string } | null>(null);
  const dialogOpen = !!(importing || discarding || quarantining || (del && del.scopeToken === deletionScope.token && deletionScope.status === 'ready') || delivery);
  useEffect(() => {
    if (delivery && (deletionScope.status !== 'ready' || delivery.scopeToken !== deletionScope.token || !series.some(s => s.id === delivery.seriesId))) setDelivery(null);
  }, [delivery, deletionScope.status, deletionScope.token, series]);
  const refreshQueues = useCallback(async () => {
    try {
      const [saved, broken] = await Promise.all([api.project.listImportQueues(), api.project.listDamagedImportQueues()]);
      setQueues(saved); setDamaged(broken); setQueueError('');
    }
    catch (error) { setQueueError(`导入清单读取失败：${String(error)}。原书和原记录保留。`); }
  }, []);
  useEffect(() => { void refreshQueues(); }, [refreshQueues, importing]);

  const pick = async (seriesId?: string): Promise<void> => {
    if (pickLock.current) return;
    pickLock.current = true; setPicking(true);
    try {
      const files = await api.files.pickImport(); if (!files?.length) return;
      const s = series.find(x => x.id === seriesId);
      const queue = await api.project.createImportQueue(files, { seriesId: seriesId ?? null, title: s?.title ?? (files[0]!.name.replace(/\.(epub|txt)$/i, '').replace(/[\[\(（【].*?[\]\)）】]/g, '').trim() || '未命名系列'), volumeNumber: s ? Math.max(0, ...s.volumes.map(v => v.volumeNumber)) + 1 : 1 });
      setImporting(queue);
    } catch (error) { setQueueError(`创建导入清单失败：${String(error)}。未开始导入，可重新选择文件。`); }
    finally { pickLock.current = false; setPicking(false); }
  };
  const open = (s: SeriesSummary, v: VolumeSummary): void => { selectSeries(s.id); selectVolume(v.id); setPage('workbench'); };
  const openDelivery = (seriesId: string): void => {
    const current = useApp.getState();
    if (current.progress.running || pickLock.current || dialogOpen || !draftIdentity.isCurrent(deletionScope.token)
      || !current.series.some(s => s.id === seriesId && s.volumes.length > 0)) return;
    selectSeries(seriesId);
    setDelivery({ seriesId, scopeToken: deletionScope.token });
  };

  return (
    <>
      <div className="page-header"><h1>书架</h1><span className="sub">{series.length} 个系列</span><div className="grow" /><button className="btn btn-primary" disabled={picking} onClick={() => void pick()}><BookOpen size={15} /> 导入原文</button></div>
      <div className="page-body">
        <div className="row wrap" style={{ marginBottom: 20 }}><p className="small muted" aria-label="拿到成品的步骤" style={{ margin: 0 }}>导入原文 → 开始翻译，必要时确认译法 → 打开成品</p><button className="btn btn-text btn-sm" disabled={progress.running || picking || dialogOpen} onClick={() => setPage('settings')}>首次使用：设置接口</button></div>
        {queueError && <div role="alert"><p>{queueError}</p><button className="btn btn-secondary" onClick={() => void refreshQueues()}>重新读取导入清单</button></div>}
        {damaged.length > 0 && <section aria-label="需要处理的损坏导入清单" style={{ marginBottom: 16 }}>
          <h2>有 {damaged.length} 份导入清单无法读取</h2><p>其他清单仍可继续。可以保留损坏记录并移出续导列表，再重新选择原文件；已导入的书不会删除，相同文件会复用原书。</p>
          {damaged.map((entry, index) => <div className="card" key={entry.id}><p>损坏清单 {index + 1}：{entry.message}</p><button className="btn btn-secondary" onClick={() => setQuarantining(entry)}>保留损坏记录并移出列表</button></div>)}
        </section>}
        {queues.length > 0 && <section aria-label="已保存的导入清单" style={{ marginBottom: 20 }}>
          <h2>已保存的导入清单</h2><p className="small muted">重启不会自动导入或请求 AI。继续时只处理未完成文件；移除清单不会删除已经导入的书。</p>
          {queues.map(queue => {
            const done = queue.entries.filter(e => e.result).length;
            return <div className="card" key={queue.id} style={{ marginBottom: 8, overflowWrap: 'anywhere' }}>
              <strong>{series.find(s => s.id === queue.target.seriesId)?.title ?? queue.target.title}</strong>
              <p className="small muted">已完成 {done}/{queue.entries.length} 个文件 · 下一本新书为第 {queue.target.volumeNumber} 册</p>
              <div className="row wrap"><button className="btn btn-secondary" onClick={() => setImporting(queue)}>{done < queue.entries.length ? '继续上次导入' : '查看导入结果'}</button><button className="btn btn-text" onClick={() => setDiscarding(queue)}>移除清单</button></div>
            </div>;
          })}
        </section>}
        {series.length === 0 ? (
          <div className="empty"><Library size={40} strokeWidth={1.2} style={{ color: 'var(--accent-primary)' }} /><h2>开始翻译你的第一本书</h2><p className="muted">支持 EPUB 和 TXT 格式。同一系列的多册会共享人物、关系和术语知识。</p><p className="small muted">首次使用先在设置中填写 AI 接口并测试连接。导入后，在作品卡上点击“翻译并保存”，选好位置即可开始。</p><p className="small muted">导入只读取本地文件。测试连接、预处理和翻译会调用你配置的 AI 服务，可能产生费用。</p><div className="row wrap"><button className="btn btn-secondary" onClick={() => setPage('settings')}>打开设置</button><button className="btn btn-primary" disabled={picking} onClick={() => void pick()}><BookOpen size={15} /> 选择文件</button></div></div>
        ) : (
          <div className="shelf">
            {series.map(s => (
              <div key={s.id} className={`shelf-card${s.id === currentSeriesId ? ' current' : ''}`}>
                <div className="row"><button className="shelf-series-title title grow ellipsis" title={s.id === currentSeriesId ? s.title : `${s.title}（切换为当前系列）`} onClick={() => selectSeries(s.id)}>{s.title}</button>{s.id === currentSeriesId ? <Pill kind="info">当前</Pill> : series.length > 1 && <button className="btn btn-text btn-sm" onClick={() => selectSeries(s.id)}>切换</button>}<button className="btn btn-text btn-sm" disabled={picking} onClick={() => void pick(s.id)}><Plus size={13} /> 册</button><button className="btn btn-text btn-sm" style={{ color: 'var(--status-error)' }} disabled={deletionScope.status !== 'ready'} onClick={() => { if (draftIdentity.isCurrent(deletionScope.token)) setDel({ series: s, scopeToken: deletionScope.token }); }} aria-label={`删除系列 ${s.title}`} title="删除系列"><Trash2 size={13} /></button></div>
                {s.author && <div className="small muted">{s.author}</div>}
                <div className="row wrap"><button className="btn btn-primary" disabled={progress.running || picking || dialogOpen || deletionScope.status !== 'ready' || s.volumes.length === 0} onClick={() => openDelivery(s.id)} aria-label={`翻译并保存 ${s.title}`}>翻译并保存</button><span className="small muted">{s.volumes.length ? `处理全部 ${s.volumes.length} 册，完成后保存 EPUB 合集。` : '先用上方“＋ 册”导入原文。'}</span></div>
                {stats[s.id] && <div className="small faint" style={{ marginBottom: 6 }}>人物 {stats[s.id]!.chars} 个 · 术语 {stats[s.id]!.terms} 个 · 待处理 {stats[s.id]!.queue} 项{s.volumes.length > 1 && ' · 各册共享知识'}</div>}
                <div>
                  {s.volumes.map(v => <ShelfVolume key={v.id} volume={v} onOpen={() => open(s, v)} />)}
                  {s.volumes.length === 0 && <div className="small faint">尚无册</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {importing && <PersistentImportDialog initial={importing} series={series} onClose={() => setImporting(null)} onImported={async sid => { await refreshSeries(); if (sid) selectSeries(sid); await refreshQueues(); }} />}
      {delivery && deletionScope.status === 'ready' && delivery.scopeToken === deletionScope.token && series.some(s => s.id === delivery.seriesId) && <SeriesExportDialog key={`${delivery.scopeToken}:${delivery.seriesId}`} seriesId={delivery.seriesId} autoProcess onClose={() => setDelivery(null)} />}
      {discarding && <ConfirmDestructive title="移除导入清单" expected="移除清单" onClose={() => setDiscarding(null)} onConfirm={async () => {
        try { await api.project.discardImportQueue(discarding.id, discarding.revision); setDiscarding(null); await refreshQueues(); }
        catch (error) { setQueueError(`移除清单失败：${String(error)}。清单和书籍均保留，可关闭此窗口后重新读取。`); }
      }}><p>只移除此批文件的顺序和续导记录，已导入的书和原始文件均保留。</p>{queueError && <p role="alert">{queueError}</p>}</ConfirmDestructive>}
      {quarantining && <ConfirmDestructive title="保留损坏导入记录" expected="保留记录" confirmLabel="保留记录并移出列表" onClose={() => setQuarantining(null)} onConfirm={async () => {
        try { await api.project.quarantineImportQueue(quarantining.id, quarantining.fingerprint); setQuarantining(null); await refreshQueues(); }
        catch (error) { setQueueError(`操作失败：${String(error)}。原记录保留，请重新读取清单。`); }
      }}><p>损坏记录会完整保留在书库中，已导入的书和原文件均不删除。这不是修复清单；随后请重新选择原文件并体检。</p>{queueError && <p role="alert">{queueError}</p>}</ConfirmDestructive>}
      {del && deletionScope.status === 'ready' && del.scopeToken === deletionScope.token && <DeleteSeriesDialog key={`${del.scopeToken}:${del.series.id}`} series={del.series} scopeToken={del.scopeToken} refreshSeries={refreshSeries} onClose={() => setDel(current => current === del ? null : current)} />}
    </>
  );
}
