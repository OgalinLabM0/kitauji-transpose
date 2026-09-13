import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { Modal } from '../../components/ui';
import { ImportFileError } from './ImportFileError';
import type { SeriesSummary } from '@shared/types';
import type { ImportQueueState, ImportQueueTarget } from '@shared/importQueue';

/** Main-process queue survives window close, renderer crash and whole application restart. */
export function PersistentImportDialog({ initial, series, onClose, onImported }: { initial: ImportQueueState; series: SeriesSummary[]; onClose: () => void; onImported: (sid?: string) => Promise<void> }) {
  const [queue, setQueue] = useState(initial);
  const [target, setTarget] = useState(initial.target);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('文件顺序、目标册号和导入结果已保存。检查通过后可继续导入。关闭或重启后可从书架找回。');
  const current = useRef(initial), lock = useRef(false), cancelled = useRef(false);
  const entriesRef = useRef(queue.entries);
  const accept = (next: ImportQueueState) => { current.current = next; entriesRef.current = next.entries; setQueue(next); setTarget(next.target); };
  useEffect(() => () => { if (lock.current) { cancelled.current = true; void api.project.cancelImport().catch(() => {}); } }, []);
  const refresh = async () => { const saved = (await api.project.listImportQueues()).find(q => q.id === current.current.id); if (saved) accept(saved); };
  const saveTarget = async (order = current.current.entries.filter(e => !e.result).map(e => e.id)) => {
    const state = current.current;
    if (JSON.stringify(state.target) === JSON.stringify(target) && JSON.stringify(order) === JSON.stringify(state.entries.filter(e => !e.result).map(e => e.id))) return state;
    const next = await api.project.updateImportQueue(state.id, state.revision, target, order); accept(next); return next;
  };
  const exclusive = async (work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; cancelled.current = false; setBusy(true);
    try { await work(); }
    catch (error) { setMessage(`操作未完成：${String(error)}。已提交整册和原清单保留。`); }
    finally { lock.current = false; setBusy(false); }
  };
  const inspectWork = async () => {
    const saved = await saveTarget();
    for (const entry of saved.entries) {
      if (cancelled.current) break;
      if (entry.result) continue;
      setMessage(`正在体检：${entry.name}`);
      try { accept(await api.project.inspectQueuedFile(saved.id, entry.id)); }
      catch (error) { await refresh(); setMessage(`文件体检失败：${String(error)}`); }
    }
    setMessage(cancelled.current ? '体检已停止，清单已保存。' : '体检结束。请核对每个文件的章节、提醒和错误，再继续导入。');
  };
  const inspect = () => exclusive(inspectWork);
  const importWork = async () => {
    await saveTarget();
    while (!cancelled.current) {
      const entry = current.current.entries.find(e => !e.result);
      if (!entry) { setMessage('本批导入完成。全部结果已保存，可关闭窗口。'); break; }
      if (!entry.report) { setMessage('已暂停：请先体检第一个未完成文件。可以修复文件后重新体检，或将其移出清单。'); break; }
      setMessage(`正在导入：${entry.name}`);
      try { accept(await api.project.importNextQueuedFile(current.current.id)); }
      catch (error) { await refresh(); setMessage(`已暂停：${String(error)}。已完成文件不会重复导入，请重新体检后继续。`); break; }
    }
    if (cancelled.current) setMessage('已停止。已经提交的整册和剩余文件清单保留，下次可继续。');
    try { await onImported(current.current.target.seriesId ?? undefined); }
    catch { setMessage('导入结果已保存，但书架刷新失败，请重新打开书架。'); }
  };
  const importFiles = () => exclusive(importWork);
  const inspectThenImport = () => exclusive(async () => {
    if (entriesRef.current.some(e => !e.result && !e.report)) await inspectWork();
    if (cancelled.current) return;
    const checked = entriesRef.current.filter(e => !e.result);
    const risky = checked.some(e => !!e.error || !e.report || !!e.report.warnings.length);
    if (risky) {
      setMessage('检查发现提醒或错误。请核对下方报告，修复或移出有问题的文件后，再点击下方“继续导入未完成文件”；未自动跳过风险。');
      return;
    }
    await importWork();
  });
  const rearrange = (entryId: string, offset: number | null) => exclusive(async () => {
    const order = current.current.entries.filter(e => !e.result).map(e => e.id), index = order.indexOf(entryId);
    if (index < 0) return;
    if (offset === null) order.splice(index, 1);
    else { const next = index + offset; if (next < 0 || next >= order.length) return; [order[index], order[next]] = [order[next]!, order[index]!]; }
    await saveTarget(order); setMessage('文件顺序已保存。');
  });
  const close = () => exclusive(async () => { await saveTarget(); onClose(); });
  const stop = () => { cancelled.current = true; setMessage('正在停止；等待当前文件安全结束，清单不会清空。'); void api.project.cancelImport().catch(error => setMessage(`停止请求失败：${String(error)}，请等待当前操作结束。`)); };
  const pending = queue.entries.filter(e => !e.result);
  const readyToContinue = !!pending[0]?.report;
  const validTarget = Number.isSafeInteger(target.volumeNumber) && target.volumeNumber > 0 && (!!target.seriesId || !!target.title.trim());
  const changeTarget = (patch: Partial<ImportQueueTarget>) => setTarget(previous => ({ ...previous, ...patch }));
  return <Modal title="导入体检与续导" width={760} onClose={() => { if (!lock.current) void close(); }} footer={<>
    <button className="btn btn-secondary" disabled={busy || !validTarget} onClick={() => void close()}>保存清单并关闭</button>
    {busy ? <button className="btn btn-secondary" onClick={stop}>停止</button> : <>
      <button className="btn btn-secondary" disabled={!pending.length || !validTarget} onClick={() => void inspect()}>体检未完成文件</button>
      <button className="btn btn-primary" disabled={!pending.length || !validTarget} onClick={() => void (readyToContinue ? importFiles() : inspectThenImport())}>{readyToContinue ? '继续导入未完成文件' : '检查并导入'}</button>
    </>}
  </>}>
    <p role="status" aria-live="polite">{message}</p>
    {JSON.stringify(target) !== JSON.stringify(queue.target) && <p role="status">目标设置尚未保存。体检、导入或“保存清单并关闭”会先保存；保存失败时窗口和输入会保留。</p>}
    <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
      <div className="field"><label>未完成文件归入系列</label><select className="input" value={target.seriesId ?? 'new'} onChange={e => {
        const found = series.find(s => s.id === e.target.value);
        changeTarget({ seriesId: found?.id ?? null, volumeNumber: found ? Math.max(0, ...found.volumes.map(v => v.volumeNumber)) + 1 : 1 });
      }}><option value="new">新建系列</option>{target.seriesId && !series.some(s => s.id === target.seriesId) && <option value={target.seriesId}>原目标已不存在，请重新选择</option>}{series.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></div>
      {!target.seriesId && <div className="field"><label>系列名称</label><input className="input" value={target.title} onChange={e => changeTarget({ title: e.target.value })} /></div>}
      <div className="field"><label>下一本新书册号</label><input className="input" type="number" min={1} step={1} value={target.volumeNumber} onChange={e => changeTarget({ volumeNumber: Number(e.target.value) })} /><span className="hint">按顺序导入。重复文件只复用原书，不改变目标系列或占用册号。重启后会重新读取并核对未完成文件；已提交整册不会重导。</span></div>
      {queue.entries.map((entry, index) => <div className="card" key={entry.id} style={{ marginBottom: 10, overflowWrap: 'anywhere' }}>
        <b>{index + 1}. {entry.name}</b><div className="small muted">{entry.path}</div>
        {!entry.result && <div className="row wrap"><button className="btn btn-text" onClick={() => void rearrange(entry.id, -1)}>上移</button><button className="btn btn-text" onClick={() => void rearrange(entry.id, 1)}>下移</button><button className="btn btn-text" onClick={() => void rearrange(entry.id, null)}>移出本批</button></div>}
        {entry.result ? <p>{entry.result.reusedExisting ? '已复用原书，未重复导入' : '已导入'}：{entry.result.chapters} 章，{entry.result.paragraphs} 段。</p> : entry.report && <>
          <p>{entry.report.chapters.length} 章，{entry.report.paragraphs} 段。{entry.report.existing && `同一文件已在「${entry.report.existing.seriesTitle}」中，将复用原书。`}</p>
          {entry.report.warnings.map((warning, i) => <p className="small" key={i}>{warning}</p>)}
          <details><summary>核对章节与正文覆盖</summary>{entry.report.chapters.map((chapter, i) => <div className="small" key={i}>{i + 1}. {chapter.title ?? '无标题'} · {chapter.paragraphs} 段</div>)}</details>
        </>}
        {entry.error && <ImportFileError error={entry.error} />}
      </div>)}
    </fieldset>
  </Modal>;
}
