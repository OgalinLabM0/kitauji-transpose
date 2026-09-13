import { useEffect, useRef, useState } from 'react';
import { Modal } from '../../components/ui';
import { api } from '../../api';
import { useApp, tryApi } from '../../store/app';
import type { SeriesDeliveryState, SeriesExportCheck, SeriesExportResult } from '@shared/ipc';

export function SeriesExportDialog({ seriesId, onClose, autoProcess = false }: { seriesId: string; onClose: () => void; autoProcess?: boolean }) {
  const { series, rev, toast, progress } = useApp();
  const [check, setCheck] = useState<SeriesExportCheck | null>(null);
  const [mode, setMode] = useState<'zh' | 'bilingual'>('zh');
  const [continueAfterDecisions,setContinueAfterDecisions] = useState(true);
  const [result, setResult] = useState<SeriesExportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [delivery, setDelivery] = useState<SeriesDeliveryState | null>(null);
  const [loaded, setLoaded] = useState(!autoProcess);
  const [readRetry, setReadRetry] = useState(0);
  const [deliveryError, setDeliveryError] = useState('');
  const [checkError, setCheckError] = useState('');
  const hydratedSeries = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    setDeliveryError(''); setLoaded(!autoProcess);
    if (autoProcess) void api.workflow.deliveryState(seriesId).then(r => {
      if (!active) return;
      setDelivery(r); setResult(r?.result ?? null);
      if (hydratedSeries.current !== seriesId) { setMode(r?.mode ?? 'zh'); hydratedSeries.current = seriesId; }
      setLoaded(true);
    }).catch(error => { if (active) setDeliveryError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [seriesId, autoProcess, rev.series, readRetry]);
  useEffect(() => {
    let active = true; setCheck(null); setCheckError('');
    void api.export.seriesQualityGate(seriesId).then(r => { if (active) setCheck(r); })
      .catch(error => { if (active) setCheckError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [seriesId, rev.paragraphs, rev.series, rev.knowledge, rev.glossary, rev.queue, rev.settings, busy, readRetry]);
  const run = async (resume = false) => {
    if (locked.current || progress.running) return;
    locked.current = true; setBusy(true);
    try {
      if (autoProcess && resume) {
        setResult(null);
        const r = await api.workflow.deliverSeries(seriesId); setDelivery(r); setResult(r.result);
        toast(r.status === 'done' ? 'success' : 'info', r.status === 'done' ? '成品已保存' : '任务已暂停，详情和保存位置已保留'); return;
      }
      const title = (series.find(s => s.id === seriesId)?.title ?? '全作品').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 72);
      const path = await api.files.pickSavePath(`${title}（${mode === 'zh' ? '中文' : '对照'}全集）.zip`);
      if (!path) return;
      setResult(null);
      if (autoProcess) {
        const r = await api.workflow.deliverSeries(seriesId, { mode, outputPath: path, continueAfterDecisions }); setDelivery(r); setResult(r.result);
        toast(r.status === 'done' ? 'success' : 'info', r.status === 'done' ? '成品已保存' : '任务已暂停，详情和保存位置已保留'); return;
      }
      const r = await api.export.runSeries(seriesId, mode, path); setResult(r);
      if (r.ok) toast('success', `已保存${r.files.length}册：${path}`);
    } catch (e) { toast('error', `任务未完成：${(e as Error).message}`); }
    finally { locked.current = false; setBusy(false); }
  };
  return <Modal title={autoProcess ? '自动处理并保存' : '导出全部册'} width={640} onClose={() => { if (!locked.current) onClose(); }} footer={<>
    <button className="btn btn-secondary" disabled={busy} onClick={onClose}>关闭</button>
    {(busy || (autoProcess && delivery?.status==='running')) && <button className="btn btn-secondary" onClick={() => void tryApi(() => api.workflow.cancel())}>{autoProcess ? '停止任务' : '取消导出'}</button>}
    {autoProcess && delivery?.status==='attention' && delivery.waitingDecisionIds?.length ? <button className="btn btn-secondary" disabled={busy || progress.running} onClick={()=>void tryApi(async()=>{await api.workflow.cancel();setDelivery(await api.workflow.deliveryState(seriesId));})}>停止自动继续</button>:null}
    {autoProcess && delivery && delivery.status !== 'done' && <button className="btn btn-primary" disabled={busy || progress.running || !loaded} onClick={() => void run(true)}>继续处理</button>}
    {(!autoProcess || !delivery || delivery.status==='done') && <button className="btn btn-primary" disabled={busy || progress.running || !loaded || (autoProcess ? !check?.volumes.length : !check?.ok)} onClick={() => void run()}>{autoProcess ? '选择位置并开始' : '保存全作品 ZIP'}</button>}
  </>}>
    {autoProcess && <p className="delivery-setup-lead">{delivery && delivery.status !== 'done' ? '已有进度会接着处理，无需重新选位置。' : '选好保存位置，剩下的准备、翻译和检查会自动完成。只在需要你决定译法时停下来。'}</p>}
    {(deliveryError || checkError) && <div role="alert"><p>暂时无法读取{deliveryError ? '上次任务' : '各册进度'}：{deliveryError || checkError}。请重试，已有译稿和任务不会删除。</p><button className="btn btn-secondary btn-sm" disabled={busy || progress.running} onClick={() => setReadRetry(value => value + 1)}>重试读取</button></div>}
    <p className="small muted">完成后保存为 ZIP，解压即可阅读各册 EPUB。</p>
    <label className="small">内容<select className="input" disabled={busy} value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="zh">中文译文</option><option value="bilingual">日中对照（依作品设置排列）</option></select></label>
    {autoProcess && <details className="delivery-setup-options"><summary>保存选项</summary><label className="small"><input type="checkbox" checked={continueAfterDecisions} disabled={busy || progress.running} onChange={e=>setContinueAfterDecisions(e.target.checked)}/> 新任务：确认译法后自动继续</label><p className="small muted">停止或关闭程序后需手动继续。错误与用量上限仍会暂停任务。</p>{delivery && delivery.status !== 'done' && <button className="btn btn-secondary btn-sm" disabled={busy || progress.running || !loaded || !check?.volumes.length} onClick={() => void run()}>重新选择保存位置</button>}</details>}
    {autoProcess && delivery && <div className="card" style={{ marginTop: 12, overflowWrap: 'anywhere' }}><strong>{delivery.status === 'done' ? '成品已保存' : delivery.status==='stopped'?'任务已停止':'当前任务'}</strong><p className="small">{delivery.outputPath} · {delivery.mode === 'zh' ? '中文译文' : '日中对照'}</p><p className="small">{delivery.message}</p><p className="small">继续使用原来的内容模式、保存位置和续接选择；上方选项仅用于新任务。</p>{delivery.status==='attention'&&<button className="btn btn-secondary btn-sm" disabled={busy || progress.running} onClick={()=>{if(delivery.run?.currentVolumeId)useApp.getState().selectVolume(delivery.run.currentVolumeId);useApp.getState().setPage('review');onClose();}}>查看待确认与问题</button>}</div>}
    {busy && <p role="status">{autoProcess ? progress.message || '正在准备任务…' : '正在检查稿件、生成并保存合集。开始保存文件后，会等待本次写入完成。'}</p>}
    {!check ? !checkError && <p>正在读取各册进度…</p> : <div style={{ marginTop: 12 }}>
      <strong>{check.ok ? `${check.volumes.length}册已准备好，可以保存` : autoProcess ? `将按顺序处理已导入的${check.volumes.length}册` : '还有册次未准备好，请先完成处理'}</strong>
      <details open={!autoProcess || !!delivery && delivery.status === 'attention'}><summary>查看各册进度（{check.volumes.filter(v => v.report.ok).length}/{check.volumes.length} 已准备好）</summary>
      {check.volumes.map(v => <div key={v.volumeId} className="card" style={{ marginTop: 8, overflowWrap: 'anywhere' }}>
        <b>第{v.volumeNumber}册 {v.title ?? ''}</b><p className="small">{v.report.ok ? '已准备好' : v.report.translated === 0 ? '尚未翻译' : `已翻译 ${v.report.translated}/${v.report.totalParagraphs} 段，还有检查未完成`}</p>
        {!v.report.ok && <button className="btn btn-text btn-sm" disabled={busy || progress.running} onClick={() => { const app=useApp.getState(); app.selectSeries(seriesId); app.selectVolume(v.volumeId); app.setPage('workbench'); onClose(); }}>前往本册处理</button>}
      </div>)}
      </details>
    </div>}
    {result && <div className="card" style={{ marginTop: 12, overflowWrap: 'anywhere' }}>
      <strong>{result.ok ? '全作品文件已保存' : '没有保存合集，可处理后重试'}</strong>
      <p className="small">{result.messages.join('；')}</p>
      {result.ok && <><p className="small">{result.files.length}册 · {result.snapshotAt}，后续修改需重新导出。</p><button className="btn btn-secondary btn-sm" onClick={() => void tryApi(() => api.files.showInFolder(result.outputPath!))}>打开保存位置</button></>}
    </div>}
  </Modal>;
}
