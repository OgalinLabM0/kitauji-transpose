import { useEffect, useRef, useState, useMemo } from 'react';
import { useApp } from '../../store/app';
import { api } from '../../api';
import { fmtTime, fmtTokens, ConfirmDestructive } from '../../components/ui';
import { Trash2 } from 'lucide-react';
import type { UsageSummary } from '@shared/ipc';
import { WORKSTATION_LABELS, type WorkstationId } from '@shared/types';

export function LogsPage() {
  const { logs, refreshLogs } = useApp();
  const [level, setLevel] = useState<'all' | 'warning' | 'error'>('all');
  const [workstation, setWorkstation] = useState<WorkstationId | 'all'>('all');
  const [search, setSearch] = useState('');
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [follow, setFollow] = useState(true);
  const [clearOpen, setClearOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // usage 统计：节流 3s，失败静默（它本身不是用户动作，失败不该制造新日志）
  const usageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (usageTimer.current) return;
    usageTimer.current = setTimeout(() => { usageTimer.current = null; const since = new Date(); since.setHours(0, 0, 0, 0); api.app.usage(since.toISOString()).then(setUsage).catch(() => setUsage(null)); }, logs.length === 0 ? 0 : 3000);
  }, [logs.length]);
  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [logs.length, follow]);

  // 工位筛选选项
  const workstations = useMemo(() => {
    const ws = new Set<WorkstationId>();
    logs.forEach(l => { if (l.workstationId) ws.add(l.workstationId as WorkstationId); });
    return Array.from(ws).sort();
  }, [logs]);

  // 多重筛选
  const shown = useMemo(() => {
    return logs.filter(l => {
      // 级别筛选
      if (level !== 'all' && l.level !== level && !(level === 'warning' && l.level === 'error')) return false;
      // 工位筛选
      if (workstation !== 'all' && l.workstationId !== workstation) return false;
      // 搜索筛选
      if (search && !l.message.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [logs, level, workstation, search]);
  return (
    <>
      <div className="page-header"><h1>任务日志</h1><div className="grow" />
        <div className="filters" style={{ margin: 0 }}>
          {(['all', 'warning', 'error'] as const).map(l => <button key={l} className={`chip${level === l ? ' on' : ''}`} onClick={() => setLevel(l)}>{{ all: '全部', warning: '警告+', error: '错误' }[l]}</button>)}
        </div>
        <select className="input" style={{ width: 140, height: 28, padding: '0 8px', fontSize: '0.9em' }} value={workstation} onChange={e => setWorkstation(e.target.value as WorkstationId | 'all')}>
          <option value="all">全部步骤</option>
          {workstations.map(ws => <option key={ws} value={ws}>{WORKSTATION_LABELS[ws]}</option>)}
        </select>
        <input className="input" style={{ width: 180, height: 28, padding: '0 8px', fontSize: '0.9em' }} placeholder="搜索关键词..." value={search} onChange={e => setSearch(e.target.value)} />
        <label className="small row" style={{ gap: 4 }}><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />跟随</label>
        {logs.length > 0 && <button className="btn btn-secondary btn-sm" onClick={() => setClearOpen(true)} title="清空任务日志"><Trash2 size={13} /> 清空日志</button>}</div>
      <div className="page-body" ref={ref} style={{ padding: '8px 24px' }} onScroll={e => { const el = e.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight > 40 && follow) setFollow(false); }}>
        {shown.length === 0 && <p className="faint small">暂无日志</p>}
        {shown.map(l => <div key={l.id} className={`log ${l.level}`}><span className="ts">{fmtTime(l.ts)}</span><span className="ws" title={l.workstationId ?? ''}>{l.workstationId ? WORKSTATION_LABELS[l.workstationId as WorkstationId] ?? l.workstationId : ''}</span><span className="msg">{/发送请求|收到响应/.test(l.message) ? <details><summary>{l.message.includes('发送请求') ? '已发送处理请求' : '已收到模型响应'} · 展开技术详情</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{l.message}</pre></details> : l.message}</span><span className="faint">{l.tokens ? `${fmtTokens(l.tokens)} tok` : ''}{l.durationMs ? ` ${(l.durationMs / 1000).toFixed(1)}s` : ''}</span></div>)}
      </div>
      <div className="taskbar" style={{ borderTop: '1px solid var(--border-subtle)' }}>{usage && <>今日：{usage.calls} 次调用 · 输入 {fmtTokens(usage.inputTokens)} · 输出 {fmtTokens(usage.outputTokens)} token{usage.unknownUsageRequests ? ` · ${usage.unknownUsageRequests} 次用量未知` : ''}</>}</div>
      {clearOpen && <ConfirmDestructive title="清空任务日志" expected="清空日志" confirmLabel="清空日志" onClose={() => setClearOpen(false)} onConfirm={async () => {
        await api.logs.clear();
        await refreshLogs();
        setClearOpen(false);
      }}>
        <p>将清除当前全部任务日志（{logs.length} 条）。日志用于排查翻译问题，清除后不可恢复。输入 <b>清空日志</b> 确认。</p></ConfirmDestructive>}
    </>
  );
}
