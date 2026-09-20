import { useShallow } from 'zustand/react/shallow';
import { kanaReading } from '@shared/kanaReading';
import { useEffect, useMemo, useState } from 'react';
import { useFormDraft } from '../../store/useFormDraft';
import { DraftStatus } from '../../components/DraftStatus';
import { useDraftTarget } from '../../components/DraftRecovery';
import { useApp, tryApi } from '../../store/app';
import { api } from '../../api';
import { Pill, Modal, ConfirmDestructive } from '../../components/ui';
import { Plus, Upload, Download } from 'lucide-react';
import type { TermView, TermOccurrenceView, LockLevel } from '@shared/types';

const TYPES: [string, string][] = [['person', '人物'], ['place', '地点'], ['organization', '组织'], ['ability', '能力/术式'], ['item', '物品'], ['concept', '概念'], ['honorific', '称谓'], ['other', '其他']];
const LOCK_LABEL: Record<LockLevel, string> = { suggested: '提案', confirmed: '默认义', 'hard-locked': '硬锁定' };

export function GlossaryPage() {
  const { currentSeriesId, rev, toast } = useApp(useShallow(s => ({ currentSeriesId: s.currentSeriesId, rev: s.rev, toast: s.toast })));
  const [terms, setTerms] = useState<TermView[]>([]);
  const [type, setType] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useDraftTarget('glossary', target => { if (target === 'new-term') setAdding(true); else setSel(target); });
  useEffect(() => { let active = true; setTerms([]); if (currentSeriesId) void api.glossary.list(currentSeriesId).then(rows => { if (active) setTerms(rows); }); return () => { active = false; }; }, [currentSeriesId]);
  useEffect(() => { let active = true; if (currentSeriesId) void api.glossary.list(currentSeriesId).then(rows => { if (active) setTerms(rows); }); return () => { active = false; }; }, [currentSeriesId, rev.glossary]);
  const shown = useMemo(() => terms.filter(t => (!type || t.termType === type) && (!q || t.termJp.includes(q) || (kanaReading(t.termJp) ?? '').toLowerCase().includes(q.toLowerCase()) || (t.termZh ?? '').includes(q))), [terms, type, q]);
  const cur = terms.find(t => t.id === sel) ?? null;
  const noOcc = terms.length > 0 && terms.every(t => t.occurrenceCount === 0);
  const undecided = terms.filter(t => !t.termZh).length;
  const typeCounts = useMemo(() => { const c: Record<string, number> = {}; for (const t of terms) c[t.termType] = (c[t.termType] ?? 0) + 1; return c; }, [terms]);
  if (!currentSeriesId) return <div className="empty"><h2>请先选择系列</h2></div>;

  const importCsv = async (): Promise<void> => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.csv,.txt,.tsv';
    input.onchange = async () => { const f = input.files?.[0]; if (!f) return; const text = await f.text(); const r = await tryApi(() => api.glossary.importCsv(currentSeriesId, text)); if (r) toast(r.errors.length ? 'warning' : 'success', `新增 ${r.added}，更新 ${r.updated}${r.errors.length ? `，${r.errors.length} 行错误` : ''}`); };
    input.click();
  };
  const exportCsv = async (): Promise<void> => { const csv = await api.glossary.exportCsv(currentSeriesId); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })); a.download = '术语表.csv'; a.click(); };
  const downloadTemplate = (): void => {
    const template = '原文,译文,类型,锁定,备注\nリスナー,听众,concept,confirmed,直播用语\nドリームライト,Dreamlight,organization,hard-locked,组织名\n東京タワー,东京塔,place,confirmed,\n佐藤さん,小佐藤,person,suggested,需确认称呼风格';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + template], { type: 'text/csv' }));
    a.download = '术语表模板.csv';
    a.click();
  };

  return (
    <>
      <div className="page-header"><h1>术语表</h1><span className="sub small">{terms.length} 条 · 术语表是默认义，AI 在语境属其他义项时可声明偏离；硬锁定则无条件使用</span><div className="grow" />
        <input className="input" style={{ width: 200 }} placeholder="搜索…" value={q} onChange={e => setQ(e.target.value)} />
        <button className="btn btn-secondary btn-sm" onClick={downloadTemplate}><Download size={13} /> 下载模板</button><button className="btn btn-secondary btn-sm" onClick={importCsv}><Upload size={13} /> 导入 CSV</button><button className="btn btn-secondary btn-sm" onClick={exportCsv}><Download size={13} /> 导出 CSV</button><button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><Plus size={13} /> 新增</button></div>
      {noOcc && <div className="notice small" style={{ margin: '0 24px 8px' }}>「出现」「偏离」两列在<b>正式翻译开始后</b>才有数据：出现 = AI 实际套用该译名的次数；偏离 = AI 认为语境属其他义项而没用默认译名的次数（每次都会让你确认）。{undecided > 0 && <> 目前 <b>{undecided}</b> 条译名未定——去待处理列表确认 AI 提议，或在右侧详情手动填写。</>}</div>}
      <div className="three">
        <div className="col-left">
          <button className={`list-item${type === null ? ' active' : ''}`} onClick={() => setType(null)}>全部 <span className="faint small" style={{ marginLeft: 'auto' }}>{terms.length}</span></button>
          {TYPES.filter(([k]) => typeCounts[k]).map(([k, l]) => <button key={k} className={`list-item${type === k ? ' active' : ''}`} onClick={() => setType(k)}>{l}<span className="faint small" style={{ marginLeft: 'auto' }}>{typeCounts[k]}</span></button>)}
        </div>
        <div>
          <table className="table"><thead><tr><th>原文</th><th>译名</th><th>类型</th><th>锁定</th><th title="正式翻译时 AI 实际套用该术语的次数（翻译前为 0）">出现 <span className="faint">?</span></th><th title="正式翻译时 AI 判断语境不属默认义、声明偏离默认译名的次数；每一次都会让你确认（接受本处 / 新增义项 / 改回并重译）。翻译前为空。">偏离 <span className="faint">?</span></th></tr></thead><tbody>
            {shown.map(t => <tr key={t.id} className={`selectable${sel === t.id ? ' selected' : ''}`} onClick={() => setSel(t.id)}>
              <td style={{ fontFamily: 'var(--font-reading)' }}>{t.termJp}{kanaReading(t.termJp) && <div className="small faint" title="假名读音（罗马音，非英文词源）">{kanaReading(t.termJp)}</div>}</td><td style={{ fontFamily: 'var(--font-reading)' }}>{t.termZh ?? <span className="faint">未定</span>}{t.senses.length > 1 && <span className="faint small"> +{t.senses.length - 1} 义项</span>}</td>
              <td className="small muted">{TYPES.find(x => x[0] === t.termType)?.[1] ?? t.termType}</td><td><Pill kind={t.lockLevel === 'hard-locked' ? 'error' : t.lockLevel === 'confirmed' ? 'success' : 'muted'}>{LOCK_LABEL[t.lockLevel]}</Pill></td>
              <td className="small muted">{t.occurrenceCount}</td><td className="small">{t.deviationCount ? <Pill kind="warning">{t.deviationCount}</Pill> : ''}</td></tr>)}
          </tbody></table>
          {shown.length === 0 && <div className="empty"><p className="muted">{terms.length ? '没有匹配的术语' : '刚导入时术语表为空是正常的。回工作台点击“连续处理本册”，会自动提取术语；也可在“分步与维护工具 → 预处理”中提取，或手动新增。'}</p></div>}
        </div>
        <div className="col-right">{cur ? <TermDetail term={cur} seriesId={currentSeriesId} onDeleted={() => setSel(null)} /> : <p className="faint small">选择一条术语查看详情</p>}</div>
      </div>
      {adding && <TermEditor seriesId={currentSeriesId} terms={terms} onClose={() => setAdding(false)} />}
    </>
  );
}

function TermDetail({ term, seriesId, onDeleted }: { term: TermView; seriesId: string; onDeleted: () => void }) {
  const { rev, toast } = useApp(useShallow(s => ({ rev: s.rev, toast: s.toast })));
  const [occ, setOcc] = useState<TermOccurrenceView[]>([]);
  const senseDraft = useFormDraft(`sense-${term.id}`, { zh: '', gloss: '', hint: '' }, { page: 'glossary', seriesId, objectId: term.id, title: `${term.termJp} · 新义项` }, { id: term.id, name: term.termJp, senses: term.senses });
  const newSense = senseDraft.value, setNewSense = senseDraft.change;
  const nameDraft = useFormDraft(`term-${term.id}`, { zh: term.termZh ?? '' }, { page: 'glossary', seriesId, objectId: term.id, title: `${term.termJp} · 默认译名` }, { id: term.id, termJp: term.termJp, termZh: term.termZh, termType: term.termType, lockLevel: term.lockLevel });
  const editZh = nameDraft.value.zh, setEditZh = (zh: string) => nameDraft.change({ zh });
  const [deleteOpen, setDeleteOpen] = useState(false);
  useEffect(() => { let active = true; void api.glossary.occurrences(term.id).then(rows => { if (active) setOcc(rows); }); return () => { active = false; }; }, [term.id, rev.glossary]);
  return (
    <>
      <h3 style={{ fontFamily: 'var(--font-reading)', fontSize: 'var(--text-lg)', margin: '0 0 4px' }}>{term.termJp}</h3>
      <div className="small muted" style={{ marginBottom: 12 }}>{term.termType}{term.senseIdentity ? ` · ${term.senseIdentity}` : ''} · 第 {term.introducedVolume} 册引入</div>
      {kanaReading(term.termJp) && <p className="small muted">假名读音：{kanaReading(term.termJp)}（罗马音，非英文词源）</p>}
      <DraftStatus draft={nameDraft} /><div className="field"><label>默认译名</label><div className="row"><input className="input" disabled={nameDraft.busy} value={editZh} onChange={e => setEditZh(e.target.value)} /><button className="btn btn-secondary btn-sm" disabled={nameDraft.busy || nameDraft.conflict || editZh.trim() === (term.termZh ?? '')} onClick={() => nameDraft.save(() => api.glossary.upsert(seriesId, { termJp: term.termJp, termZh: editZh.trim() || null, termType: term.termType, lockLevel: term.lockLevel === 'suggested' && editZh.trim() ? 'confirmed' : term.lockLevel }), '已保存')}>保存</button></div></div>
      <div className="field"><label>锁定级别</label>
        <div className="lock-toggle">{(['suggested', 'confirmed', 'hard-locked'] as LockLevel[]).map(l => <button key={l} className={term.lockLevel === l ? 'on' : ''} disabled={l !== 'suggested' && !term.termZh} onClick={() => tryApi(() => api.glossary.setLock(term.id, l))}>{LOCK_LABEL[l]}</button>)}</div>
        <span className="hint">{term.lockLevel === 'hard-locked' ? 'AI 将无条件使用此译名；即使语境不符也只会提出异议。' : term.lockLevel === 'confirmed' ? '默认义。AI 在语境明显属于其他义项（如 莱茵 vs 回路）时可偏离，但必须声明并进入复核提醒。' : '仅供 AI 参考，不做一致性校验。'}</span></div>
      <div className="field"><label>义项</label>
        {term.senses.map(s => <div key={s.id} className="side-item"><div className="row"><b style={{ fontFamily: 'var(--font-reading)' }}>{s.senseZh}</b>{s.isDefault && <Pill kind="info">默认</Pill>}{!s.confirmedByUser && <Pill kind="muted">候选</Pill>}<span className="grow" />{!s.isDefault && <><button className="btn btn-text btn-sm" onClick={() => tryApi(() => api.glossary.setDefaultSense(term.id, s.id))}>设为默认</button><button className="btn btn-text btn-sm" onClick={() => tryApi(() => api.glossary.removeSense(s.id))}>删除</button></>}</div>{(s.senseGloss || s.contextHint) && <div className="small muted">{s.senseGloss}{s.contextHint ? ` · 判别：${s.contextHint}` : ''}</div>}</div>)}
        <DraftStatus draft={senseDraft} /><fieldset disabled={senseDraft.busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><div className="row" style={{ marginTop: 4 }}><input className="input" placeholder="新义项" value={newSense.zh} onChange={e => setNewSense({ ...newSense, zh: e.target.value })} /><input className="input" placeholder="说明" value={newSense.gloss} onChange={e => setNewSense({ ...newSense, gloss: e.target.value })} /><input className="input" placeholder="判别提示" value={newSense.hint} onChange={e => setNewSense({ ...newSense, hint: e.target.value })} /><button className="btn btn-secondary btn-sm" disabled={senseDraft.busy || senseDraft.conflict || !newSense.zh.trim()} onClick={() => senseDraft.save(() => api.glossary.addSense(term.id, newSense.zh.trim(), newSense.gloss || null, newSense.hint || null), '义项已添加')}>添加</button></div></fieldset></div>
      {term.notes && <div className="field"><label>备注</label><div className="small">{term.notes.split('\n').map((line,index)=>{if(!line.startsWith('[english-ruby-v1]'))return <div key={index}>{line}</div>;try{const rule=JSON.parse(line.slice('[english-ruby-v1]'.length));if(typeof rule.english!=='string'||typeof rule.gloss!=='string')return null;return <div key={index}>{rule.english===term.termZh?'已确认英文注释：':'此前英文注释（当前译名已改变）：'}<ruby>{rule.english}<rt>{rule.gloss}</rt></ruby></div>;}catch{return <div key={index}>英文注释记录无法读取</div>;}})}</div></div>}
      <div className="field"><label>出现位置（{occ.length}）</label>
        <div style={{ maxHeight: 260, overflow: 'auto' }}>{occ.map(o => <div key={o.id} className="row small" style={{ padding: '3px 0', borderBottom: '1px solid var(--border-subtle)' }}><span className="faint mono" style={{ width: 52 }}>#{o.seriesOrdinal}</span><span className="grow" style={{ fontFamily: 'var(--font-reading)' }}>{o.appliedZh ?? <span className="faint">—</span>}</span>{o.deviationStatus !== 'none' && <Pill kind={o.deviationStatus === 'flagged' || o.deviationStatus === 'conflict' ? 'warning' : o.deviationStatus === 'rejected' ? 'muted' : 'success'}>{{ 'sense-selected': '义项', flagged: '待处理', accepted: '已接受', promoted: '已升级', rejected: '已改回', conflict: '异议', none: '' }[o.deviationStatus]}</Pill>}</div>)}</div></div>
      <button className="btn btn-text btn-sm" style={{ color: 'var(--status-error)' }} onClick={() => setDeleteOpen(true)}>删除术语</button>
      {deleteOpen && <ConfirmDestructive title="删除术语" expected={term.termJp} confirmLabel="删除术语" onClose={() => setDeleteOpen(false)} onConfirm={async () => { try { await api.glossary.remove(term.id); toast('success', '已删除术语'); setDeleteOpen(false); onDeleted(); } catch (e) { toast('error', (e as Error).message); } }}><p>删除「{term.termJp}」会移除它的默认译名和义项。已翻译内容不会自动改写。</p></ConfirmDestructive>}
    </>
  );
}

function TermEditor({ seriesId, terms, onClose }: { seriesId: string; terms: TermView[]; onClose: () => void }) {
  const form = useFormDraft('new-term', { termJp: '', termZh: '', termType: 'concept', lockLevel: 'confirmed' as LockLevel, notes: '' }, { page: 'glossary', seriesId, objectId: 'new-term', title: '新增术语' }, terms.map(t => ({ id: t.id, termJp: t.termJp, termZh: t.termZh, lockLevel: t.lockLevel, notes: t.notes })));
  const t = form.value, setT = form.change;
  const close = () => { if (!form.busy) onClose(); };
  return (
    <Modal title="新增术语" onClose={close} footer={<><button className="btn btn-secondary" disabled={form.busy} onClick={close}>关闭并保留输入</button><button className="btn btn-primary" disabled={form.busy || form.conflict || !t.termJp.trim()} onClick={async () => { if (await form.save(() => api.glossary.upsert(seriesId, { termJp: t.termJp.trim(), termZh: t.termZh.trim() || null, termType: t.termType, lockLevel: t.termZh.trim() ? t.lockLevel : 'suggested', notes: t.notes || null }), '已添加')) onClose(); }}>添加</button></>}>
      <DraftStatus draft={form} /><fieldset disabled={form.busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className="field"><label>日文原文</label><input className="input" value={t.termJp} onChange={e => setT({ ...t, termJp: e.target.value })} autoFocus /></div>
      <div className="field"><label>中文译名（默认义）</label><input className="input" value={t.termZh} onChange={e => setT({ ...t, termZh: e.target.value })} /></div>
      <div className="row"><div className="field grow"><label>类型</label><select className="input" value={t.termType} onChange={e => setT({ ...t, termType: e.target.value })}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="field grow"><label>锁定</label><select className="input" value={t.lockLevel} onChange={e => setT({ ...t, lockLevel: e.target.value as LockLevel })}><option value="confirmed">默认义（可声明偏离）</option><option value="hard-locked">硬锁定（无条件）</option></select></div></div>
      <div className="field"><label>备注</label><input className="input" value={t.notes} onChange={e => setT({ ...t, notes: e.target.value })} /></div>
      </fieldset>
    </Modal>
  );
}
