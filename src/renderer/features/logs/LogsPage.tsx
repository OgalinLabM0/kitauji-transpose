import { memo, useEffect, useRef, useState } from 'react';
import { useApp } from '../../store/app';
import { api } from '../../api';
import { draftIdentity } from '../../store/draftIdentityBridge';
import { fmtTime, fmtTokens, ConfirmDestructive } from '../../components/ui';
import { Trash2 } from 'lucide-react';
import type { UsageSummary, Api } from '@shared/ipc';
import { WORKSTATION_LABELS, type ActivityLogEntry } from '@shared/types';

type LogPage = Awaited<ReturnType<Api['logs']['page']>>;
/** A collapsed row has no large hidden text node. Full details are read only on demand. */
const LogRow = memo(function LogRow({ entry: l }: { entry: ActivityLogEntry }) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<{ text: string; hasMore: boolean } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) { setDetail(null); return; }
    let live = true; const token = draftIdentity.snapshot().token; setDetail(null); setError('');
    void api.logs.detail(l.id, offset).then(value => {
      if (live && draftIdentity.isCurrent(token)) { setDetail(value); if (!value) setError('这条日志已被清除'); }
    }).catch(() => { if (live) setError('读取失败，请收起后重试'); });
    return () => { live = false; };
  }, [open, offset, l.id]);
  const technical = /发送请求|收到响应/.test(l.message);
  const expandable = technical || l.message.length >= 500;
  return <div className={`log ${l.level}`}><span className="ts">{fmtTime(l.ts)}</span><span className="ws" title={l.workstationId ?? ''}>{l.workstationId ? WORKSTATION_LABELS[l.workstationId] ?? l.workstationId : ''}</span><span className="msg">
    {expandable ? <><button className="btn btn-text btn-sm" aria-expanded={open} onClick={() => { setOffset(0); setOpen(v => !v); }}>{technical ? l.message.includes('发送请求') ? '已发送处理请求' : '已收到模型响应' : l.message.slice(0,200)} · {open ? '收起详情' : '查看详情'}</button>
      {open && <div>{error || (!detail ? '正在读取…' : <><pre style={{ whiteSpace:'pre-wrap', overflowWrap:'anywhere', maxHeight:320, overflow:'auto' }}>{detail.text}</pre><div className="row"><button className="btn btn-secondary btn-sm" disabled={offset===0} onClick={() => setOffset(n=>Math.max(0,n-12000))}>上一段详情</button><span>第 {offset/12000+1} 段</span><button className="btn btn-secondary btn-sm" disabled={!detail.hasMore} onClick={() => setOffset(n=>n+12000)}>下一段详情</button></div></>)}</div>}</> : l.message}
    </span><span className="faint">{l.tokens ? `${fmtTokens(l.tokens)} tok` : ''}{l.durationMs ? ` ${(l.durationMs / 1000).toFixed(1)}s` : ''}</span></div>;
});

export function LogsPage() {
  const latestId = useApp(s => s.logs.at(-1)?.id ?? 0);
  const refreshLogs = useApp(s => s.refreshLogs);
  const [level, setLevel] = useState<'all'|'warning'|'error'>('all');
  const [workstation, setWorkstation] = useState('all');
  const [search, setSearch] = useState(''); const [query, setQuery] = useState('');
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [follow, setFollow] = useState(true);
  const [cursors, setCursors] = useState<number[]>([]);
  const [loaded, setLoaded] = useState<LogPage>({ entries:[], hasMore:false });
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [clearOpen, setClearOpen] = useState(false); const [revision, setRevision] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const beforeId = cursors.at(-1);
  // The ID keeps changing after the in-memory ring reaches its limit; length does not.
  const liveRevision = follow && !beforeId ? latestId : 0;
  useEffect(() => { const timer=setTimeout(()=>setQuery(search),250); return ()=>clearTimeout(timer); },[search]);
  useEffect(() => { setCursors([]); },[level,workstation,query]);
  useEffect(() => {
    let live=true; const token=draftIdentity.snapshot().token; setBusy(true); setError('');
    void api.logs.page({ beforeId,level,workstation,search:query }).then(value=>{if(live&&draftIdentity.isCurrent(token))setLoaded(value);}).catch(()=>{if(live)setError('日志读取失败，可点击刷新重试。');}).finally(()=>{if(live)setBusy(false);});
    return ()=>{live=false;};
  },[beforeId,level,workstation,query,liveRevision,revision]);
  useEffect(()=>{if(follow&&!beforeId&&ref.current)ref.current.scrollTop=ref.current.scrollHeight;},[loaded,follow,beforeId]);
  useEffect(()=>{
    let live=true,reading=false; const token=draftIdentity.snapshot().token;
    const read=async()=>{if(reading)return;reading=true;try{const since=new Date();since.setHours(0,0,0,0);const value=await api.app.usage(since.toISOString());if(live&&draftIdentity.isCurrent(token))setUsage(value);}catch{}finally{reading=false;}};
    void read(); const timer=setInterval(()=>void read(),3000);return()=>{live=false;clearInterval(timer);};
  },[]);
  return <>
    <div className="page-header"><h1>任务日志</h1><div className="grow"/><div className="filters" style={{margin:0}}>{(['all','warning','error'] as const).map(l=><button key={l} className={`chip${level===l?' on':''}`} onClick={()=>setLevel(l)}>{{all:'全部',warning:'警告+',error:'错误'}[l]}</button>)}</div>
      <select className="input" style={{width:150}} value={workstation} onChange={e=>setWorkstation(e.target.value)}><option value="all">全部步骤</option>{Object.entries(WORKSTATION_LABELS).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select>
      <input className="input" style={{width:180}} maxLength={500} placeholder="搜索全部日志…" value={search} onChange={e=>setSearch(e.target.value)}/>
      <label className="small row"><input type="checkbox" checked={follow} onChange={e=>{setFollow(e.target.checked);if(e.target.checked)setCursors([]);}}/>跟随最新</label>
      <button className="btn btn-secondary btn-sm" onClick={()=>setClearOpen(true)}><Trash2 size={13}/>清空日志</button></div>
    <div className="row" style={{padding:'8px 24px',flexWrap:'wrap'}}><span className="small muted">{beforeId?'历史记录':'最新记录'} · 每页最多 100 条 · 完整记录保留在本机</span><button className="btn btn-secondary btn-sm" disabled={busy||!loaded.hasMore} onClick={()=>{setFollow(false);setCursors(s=>[...s,loaded.entries[0]!.id]);}}>更早记录</button><button className="btn btn-secondary btn-sm" disabled={busy||!beforeId} onClick={()=>setCursors(s=>s.slice(0,-1))}>较新记录</button><button className="btn btn-text btn-sm" onClick={()=>{setCursors([]);setFollow(true);setRevision(n=>n+1);}}>返回最新 / 刷新</button></div>
    <div className="page-body" ref={ref} style={{padding:'8px 24px'}} onWheel={e=>{if(e.deltaY<0)setFollow(false);}}>
      {error&&<p role="alert">{error}</p>}{!loaded.entries.length&&<p className="faint small">{busy?'正在读取…':'暂无符合条件的日志'}</p>}{loaded.entries.map(l=><LogRow key={l.id} entry={l}/>)}</div>
    <div className="taskbar">{usage&&<>今日：{usage.calls} 次调用 · 输入 {fmtTokens(usage.inputTokens)} · 输出 {fmtTokens(usage.outputTokens)} token{usage.unknownUsageRequests?` · ${usage.unknownUsageRequests} 次用量未知`:''}</>}</div>
    {clearOpen&&<ConfirmDestructive title="清空任务日志" expected="清空日志" confirmLabel="清空日志" onClose={()=>setClearOpen(false)} onConfirm={async()=>{await api.logs.clear();await refreshLogs();setCursors([]);setRevision(n=>n+1);setClearOpen(false);}}><p>将清除本机全部任务日志，不仅是当前页面。日志用于排查问题，清除后不可恢复。输入 <b>清空日志</b> 确认。</p></ConfirmDestructive>}
  </>;
}
