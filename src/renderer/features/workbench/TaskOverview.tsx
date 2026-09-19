import { useShallow } from 'zustand/react/shallow';
import { useVolumeOverview } from '../../store/useVolumeOverview';
import { useApp, tryApi } from '../../store/app';
import { useState, useEffect } from 'react';
import { api } from '../../api';
import type { VolumeRunState } from '@shared/ipc';
import { taskPhaseLabel } from '../../components/TaskProgressView';
import { draftIdentity } from '../../store/draftIdentityBridge';

export function TaskOverview({ volumeId, onNavigate }: { volumeId: string; onNavigate?: () => void }) {
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState('');
  const [restoring, setRestoring] = useState(false);
  useEffect(() => { setRetryMessage(''); }, [volumeId]);
  const { setPage, jumpToParagraph } = useApp(useShallow(s => ({ setPage: s.setPage, jumpToParagraph: s.jumpToParagraph })));
  const { value, error, running } = useVolumeOverview(volumeId);
  const [liveRun, setLiveRun] = useState<{ volumeId: string; run: VolumeRunState | null } | null>(null);
  useEffect(() => {
    let active = true;
    setLiveRun(null);
    if (!running) return;
    const token = draftIdentity.snapshot().token;
    const read = () => void api.workflow.volumeRunState(volumeId).then(run => {
      if (active && draftIdentity.isCurrent(token)) setLiveRun({ volumeId, run });
    }).catch(() => { if (active) setLiveRun(null); });
    read(); const timer = setInterval(read, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [volumeId, running]);
  if (running) {
    const run = liveRun?.volumeId === volumeId ? liveRun.run : null;
    return <section className="task-overview" aria-live="polite"><strong>{run?.status === 'running' ? `正在${run.detail?.label ?? taskPhaseLabel(run.phase)}` : '后台任务运行中'}</strong>{run?.detail && <p>{run.detail.chapterTitle && `${run.detail.chapterTitle} · `}当前步骤：{run.detail.done} / {run.detail.total} {run.detail.unit}</p>}{run && <p className="small muted">{run.message}</p>}<p className="small muted">当前任务进度见上方任务区。稿件通过检查的数量将在本次处理结束后核对。</p></section>;
  }
  if (!value) return <section className="task-overview" aria-live="polite">{error ? `状态读取失败：${error}` : '正在检查当前状态…'}</section>;
  const runLabels = { running: '上次任务状态待刷新', stopped: '已停止，可继续', attention: '处理未完成', done: '上次处理已完成' };
  const nextStep = value.report.ok
    ? '这一册已通过检查，可以导出中文或日中对照文件。'
    : value.run?.status === 'stopped'
      ? '任务已停止；确认可以继续后，回到正文，点击任务主按钮从已保存进度接着做。'
      : value.run?.status === 'attention' && value.pending > 0
        ? '先处理待确认问题；处理完成后任务会按设置继续，必要时再回到正文，点击任务主按钮。'
        : value.run?.status === 'attention'
          ? `任务暂时停下：${value.run.message || '有一项检查未完成'}。请按提示处理后，再回到正文，点击任务主按钮继续。`
          : value.pending > 0
            ? '先处理待确认问题；处理完成后任务会按设置继续，必要时再回到正文，点击任务主按钮。'
        : value.drafted === 0
          ? '回到正文，点击任务主按钮，选择保存位置后开始；已有进度会保留。'
          : '已有译稿，但这一册还没有全部完成。回到正文，点击任务主按钮继续，已有进度会保留。';
  return <section className="task-overview" aria-label="本册任务状态">
    <div className="task-overview-head"><strong>{value.report.ok ? '这一册可以导出了' : value.run?.status === 'stopped' ? '任务已停止' : value.run?.status === 'attention' ? value.pending > 0 ? '需要你处理问题' : '任务暂时停下' : value.pending > 0 ? '需要你处理问题' : value.drafted === 0 ? '可以开始处理了' : '还有内容未完成'}</strong><span className="muted">{value.run ? runLabels[value.run.status] : '尚未开始整册处理'}</span>{value.pending > 0 && <button className="btn btn-secondary btn-sm" onClick={() => setPage('review')}>查看待处理问题（{value.pending}）</button>}</div>
    <div className="task-metrics"><span>已翻译 <b>{value.drafted}/{value.total}</b> 段</span><span>已采纳 <b>{value.adopted}</b> 段</span><span>通过检查 <b>{value.audited}</b> 段</span></div>
    <p className="small muted">{nextStep}</p>
    {value.staleChanges.length > 0 && <div className="stale-knowledge-details">
      <strong>有{value.staleChanges.length}个已确认的知识变化需要重新核对</strong>
      <p className="small muted">旧决定还在影响知识库，已暂停继续处理和导出。撤销后会恢复原知识并重新检查译稿；原译文不会改写。</p>
      {value.staleChanges.map(item => <div key={item.id} style={{ padding: '10px 0', overflowWrap: 'anywhere' }}>
        <strong>{item.title}</strong><p className="small">{item.reason}</p>
        {item.sources.map(source => <details key={source.id}><summary>{source.ordinal == null ? '原依据段落已不存在' : `查看当前原文 · 第${source.ordinal}段`}</summary>
          {source.text != null && <><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{source.text}</p><button className="btn btn-text btn-sm" onClick={() => void tryApi(async () => { await jumpToParagraph(source.id); onNavigate?.(); })}>定位依据段落</button></>}
        </details>)}
        {item.queueId ? <button className="btn btn-secondary btn-sm" disabled={restoring} onClick={() => void tryApi(async () => {
          setRestoring(true);
          try { await api.review.undoResolved(item.queueId!); }
          finally { setRestoring(false); }
        })}>撤销并重新检查</button> : <p className="small">旧记录缺少恢复快照，不能自动撤销。请先备份，核对原决定和知识历史；不要反复重试翻译。</p>}
      </div>)}
    </div>}
    {value.staleKnowledge.length > 0 && <details className="stale-knowledge-details">
      <summary>自动知识依据需要重新核对（{value.staleKnowledge.length}项）</summary>
      <p className="small muted">这些决定由同一作品各册共享。回到正文，点击任务主按钮继续任务时，会尝试安全撤回并重新核对；后续编辑存在冲突时会保留数据并暂停。</p>
      {value.staleKnowledge.map(item => <div key={item.id} style={{ padding: '10px 0', overflowWrap: 'anywhere' }}>
        <strong>{item.title}</strong><p className="small">{item.reason}</p>
        {item.recoveryError && <p className="small">上次未能自动撤回：{item.recoveryError}</p>}
        {item.sources.map(source => <details key={source.id}><summary>{source.ordinal == null ? '原依据段落已不存在' : `查看当前原文 · 第${source.ordinal}段`}</summary>
          {source.text != null && <><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{source.text}</p><button className="btn btn-text btn-sm" onClick={() => void tryApi(async () => { await jumpToParagraph(source.id); onNavigate?.(); })}>定位依据段落</button></>}
        </details>)}
        <button className="btn btn-secondary btn-sm" onClick={() => setPage(item.kind === 'term-proposal' ? 'glossary' : item.kind === 'honorific-first' ? 'trajectory' : 'knowledge')}>查看{item.kind === 'term-proposal' ? '术语' : item.kind === 'honorific-first' ? '称呼轨迹' : item.kind === 'stale-knowledge' ? '人物档案' : '人物语癖'}</button>
      </div>)}
    </details>}
    {!value.report.ok && <details><summary>更多处理方式</summary><p className="small muted">如果相同问题已多次修复失败，先查看原因。确认需要再试时，可允许再次修复；这不会跳过检查或自动改稿。</p><button className="btn btn-secondary btn-sm" disabled={retrying} onClick={() => void tryApi(async () => {
      setRetrying(true);
      try { const count = await api.workflow.resetTrajectoryRepairs(volumeId); setRetryMessage(count ? `已允许${count}处再次尝试，请回到正文，点击任务主按钮继续。` : '没有受失败次数限制的修复；不确定项和人工稿请到复核页处理。'); }
      finally { setRetrying(false); }
    })}>允许再次修复</button><span className="small" role="status">{retryMessage}</span></details>}
    {value.run?.usage && <p className="small">本册累计输入 {value.run.usage.inputTokens.toLocaleString()} / 输出 {value.run.usage.outputTokens.toLocaleString()} token{value.run.usage.unknownUsageRequests > 0 ? ` · ${value.run.usage.unknownUsageRequests} 次用量未知` : ''}</p>}
    {!value.report.ok && <details><summary>查看还需要解决的问题</summary>{value.report.blockers.map(b => <div className="task-blocker" key={b.code}><span>{b.code === 'UNTRANSLATED' ? '还没翻译' : b.code.startsWith('AUDIT') ? '质量检查未完成' : b.code === 'TRAJECTORY_MISSING' ? '全章检查未完成' : b.code === 'TRAJECTORY_UNRESOLVED' ? '全章问题待处理' : b.code === 'ACCEPTANCE_PENDING' ? '还没确认' : b.code === 'RECHECK_PENDING' ? '需要重新检查' : b.code.startsWith('QUEUE') ? '有待处理的问题' : '有未解决的问题'} · {b.count} 处</span><span>{b.sample.map((id, index) => <button key={id} className="btn btn-text btn-sm" onClick={() => void tryApi(async () => { await jumpToParagraph(id); onNavigate?.(); })}>定位 {index + 1}</button>)}</span></div>)}<p className="small muted">同一段可能有多个问题；每类最多显示5个位置。</p></details>}
  </section>;
}


