import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { tryApi } from '../../store/app';
import { Modal } from '../../components/ui';
import { ImportFileError } from './ImportFileError';
import type { SeriesSummary } from '@shared/types';
import type { ImportPreflight, ImportSummary } from '@shared/ipc';

type Selection = { files: { path: string; name: string }[]; seriesId: string; title: string; volumeNumber: number };
type Entry = { path: string; name: string; report?: ImportPreflight; result?: ImportSummary; error?: string };

export function ImportDialog({ initial, series, onClose, onImported }: { initial: Selection; series: SeriesSummary[]; onClose: () => void; onImported: (sid?: string) => Promise<void> }) {
  const [entries, setEntries] = useState<Entry[]>(initial.files);
  const [target, setTarget] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('先体检文件，核对章节、顺序与重复情况，再开始导入。');
  const lock = useRef(false); const cancelled = useRef(false);
  useEffect(() => () => {
    if (lock.current) { cancelled.current = true; void tryApi(() => api.project.cancelImport()); }
  }, []);
  const update = (index: number, value: Entry): void => setEntries(previous => previous.map((e, i) => i === index ? value : e));
  const inspect = async (): Promise<void> => {
    if (lock.current) return; lock.current = true; cancelled.current = false; setBusy(true);
    try {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        if (entry.result || cancelled.current) continue;
        setMessage(`正在体检 ${i + 1}/${entries.length}：${entry.name}`);
        try {
          const report = await api.project.inspectImport(entry.path);
          update(i, { path: entry.path, name: entry.name, report });
        } catch (error) { update(i, { path: entry.path, name: entry.name, error: cancelled.current ? '体检已停止，可重新体检。' : String(error) }); }
      }
      setMessage(cancelled.current ? '体检已停止。书库未新增本次体检内容。' : '体检完成。请核对下面的完整章节清单与提醒；有错误的文件需修复或移除。');
    } finally { lock.current = false; setBusy(false); }
  };
  const importFiles = async (): Promise<void> => {
    if (lock.current) return; lock.current = true; cancelled.current = false; setBusy(true);
    let sid = target.seriesId === 'new' ? undefined : target.seriesId;
    let number = target.volumeNumber;
    try {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        if (entry.result) continue;
        if (cancelled.current) break;
        if (!entry.report) { setMessage('请先体检所有未完成文件。'); break; }
        setMessage(`正在导入 ${i + 1}/${entries.length}：${entry.name}`);
        try {
          const result = await api.project.importFile(entry.path, { ...(sid ? { seriesId: sid } : { seriesTitle: target.title.trim() }), volumeNumber: number, expectedHash: entry.report.hash });
          update(i, { path: entry.path, name: entry.name, report: entry.report, result });
          // Reusing an old book must never redirect later files into its series or consume a number.
          if (!result.reusedExisting) {
            sid = result.seriesId; number++;
            setTarget(previous => ({ ...previous, seriesId: sid!, volumeNumber: number }));
          }
        } catch (error) {
          update(i, { ...entry, error: cancelled.current ? '已停止；本文件未完成，可重试。' : String(error) });
          setMessage('已暂停：保留已完成文件和剩余队列。修复问题后可重新体检或继续导入。');
          return;
        }
      }
      setMessage(cancelled.current ? '已停止。已经提交的整册保留，未完成文件可继续。' : '本批导入完成。下方保留每个文件的实际结果。');
    } finally { lock.current = false; setBusy(false); try { await onImported(sid); } catch { setMessage('导入结果已保留，但书架刷新失败，请重新打开书架。'); } }
  };
  const stop = (): void => { cancelled.current = true; setMessage('正在停止，等待当前解析结束；已经提交的整册保留。'); void tryApi(() => api.project.cancelImport()); };
  const pending = entries.filter(e => !e.result);
  const move = (index: number, offset: number): void => setEntries(previous => {
    const next = [...previous]; const other = index + offset;
    if (other < 0 || other >= next.length || next[index]?.result || next[other]?.result) return previous;
    [next[index], next[other]] = [next[other]!, next[index]!]; return next;
  });
  return <Modal title="导入体检与续导" width={760} onClose={() => { if (!lock.current) onClose(); }} footer={<>
    <button className="btn btn-secondary" disabled={busy} onClick={onClose}>关闭</button>
    {busy ? <button className="btn btn-secondary" onClick={stop}>停止</button> : <>
      <button className="btn btn-secondary" disabled={!pending.length} onClick={inspect}>体检未完成文件</button>
      <button className="btn btn-primary" disabled={!pending.length || pending.some(e => !e.report) || !Number.isSafeInteger(target.volumeNumber) || target.volumeNumber < 1 || (target.seriesId === 'new' && !target.title.trim())} onClick={importFiles}>继续导入未完成文件</button>
    </>}
  </>}>
    <p role="status" aria-live="polite">{message}</p>
    <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
      <div className="field"><label>未完成文件归入系列</label><select className="input" value={target.seriesId} onChange={e => {
        const found = series.find(s => s.id === e.target.value);
        setTarget({ ...target, seriesId: e.target.value, volumeNumber: found ? Math.max(0, ...found.volumes.map(v => v.volumeNumber)) + 1 : 1 });
      }}><option value="new">新建系列</option>{series.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></div>
      {target.seriesId === 'new' && <div className="field"><label>系列名称</label><input className="input" value={target.title} onChange={e => setTarget({ ...target, title: e.target.value })} /></div>}
      <div className="field"><label>下一本新书册号</label><input className="input" type="number" min={1} step={1} value={target.volumeNumber} onChange={e => setTarget({ ...target, volumeNumber: Number(e.target.value) })} /><span className="hint">按下方顺序导入；重复文件只复用原书，不改变目标系列，也不占用新册号。停止不撤销已完成整册。关闭此窗口会清除未完成文件清单，可重新选文件后按重复检测续导。</span></div>
      {entries.map((entry, index) => <div className="card" key={`${index}:${entry.path}`} style={{ marginBottom: 10, overflowWrap: 'anywhere' }}>
        <b>{index + 1}. {entry.name}</b>
        {!entry.result && <div className="row"><button className="btn btn-text" onClick={() => move(index, -1)}>上移</button><button className="btn btn-text" onClick={() => move(index, 1)}>下移</button><button className="btn btn-text" onClick={() => setEntries(previous => previous.filter((_, i) => i !== index))}>移出本批</button></div>}
        {entry.result ? <>{<p>{entry.result.reusedExisting ? '已复用原书，未重复导入' : '已导入'}：{entry.result.chapters} 章，{entry.result.paragraphs} 段。</p>}{entry.result.missingTocResources.map((href, i) => <p key={i} className="small" style={{ color: 'var(--status-warning)' }}>原文件缺少目录指向的内容：{href}</p>)}</> : entry.report && <>
          <p>{entry.report.chapters.length} 章，{entry.report.paragraphs} 段。{entry.report.existing && `同一文件已在「${entry.report.existing.seriesTitle}」中，将复用原书。`}</p>
          {entry.report.warnings.map((w, i) => <p key={i} className="small" style={{ color: 'var(--status-warning)' }}>{w}</p>)}
          <details><summary>核对章节与正文覆盖</summary>{entry.report.chapters.map((c, i) => <div key={i} className="small">{i + 1}. {c.title ?? '无标题'} · {c.paragraphs} 段</div>)}</details>
        </>}
        {entry.error && <ImportFileError error={entry.error} />}
      </div>)}
    </fieldset>
  </Modal>;
}
