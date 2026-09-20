import type { WorkflowProgress, WorkflowTaskStep } from '@shared/types';
import type { SeriesDeliveryState } from '@shared/ipc';

const phaseLabels: Record<string, string> = {
  preread: '人物与事件预读', terms: '术语提取', scenes: '场景分析',
  honorifics: '称呼核对', knowledge: '人物资料核对', translate: '翻译',
  trajectory: '全章连读检查', delivery: '成品检查', export: '保存成品',
};
export function taskPhaseLabel(phase: string | undefined): string {
  return phase ? phaseLabels[phase] ?? (phase === 'idle' ? '准备开始' : phase) : '准备开始';
}

const legacySteps: Record<string, WorkflowTaskStep> = {
  preread: { stage: 'preparation', index: 1, total: 8, label: '人物与事件预读' },
  terms: { stage: 'preparation', index: 2, total: 8, label: '术语提取' },
  scenes: { stage: 'preparation', index: 5, total: 8, label: '场景分析' },
  honorifics: { stage: 'preparation', index: 7, total: 8, label: '称呼扫描' },
  translate: { stage: 'translation', index: 1, total: 5, label: '翻译与逐段检查' },
  delivery: { stage: 'translation', index: 5, total: 5, label: '成品检查' },
};

export function TaskProgressView({ progress, state, live }: { progress: WorkflowProgress; state: SeriesDeliveryState | null; live: boolean }) {
  const run = state?.run?.currentRun;
  const step = (live ? progress.step ?? run?.step : run?.step) ?? (run ? legacySteps[run.phase] : undefined);
  const detail = live ? progress.detail : run?.detail;
  const done = state?.status === 'done' && state.result?.ok && state.result.outputPath === state.outputPath;
  const waiting = state?.status === 'attention' && !!state.waitingDecisionIds?.length;
  const phase = state?.phase === 'export' ? 'export' : detail?.phase ?? run?.phase;
  const phaseLabel = phase === 'export' ? '保存成品' : detail?.label ?? taskPhaseLabel(phase ?? (live ? progress.phase : undefined));
  // A second knowledge pass follows the completed paragraph loop. Its persisted
  // paragraph count distinguishes it from preparation, including after restart.
  const translating = step?.stage === 'translation' || ['translate', 'trajectory', 'delivery'].includes(phase ?? '') || phase === 'knowledge' && !!run && run.total > 0 && run.done >= run.total;
  const stage = done || phase === 'export' ? 3 : translating ? 2 : waiting ? 1 : state || detail ? 0 : -1;
  const stages = ['预读与准备', '必要确认', '翻译与检查', '保存成品'];
  const hasCount = phase !== 'export' && !!detail && Number.isFinite(detail.total) && detail.total > 0 && Number.isFinite(detail.done) && detail.done >= 0;
  const pct = hasCount ? Math.min(100, Math.floor(detail.done / detail.total * 100)) : null;
  return <div className={'task-progress-view'+(done?' is-complete':'')}>
    <ol className="task-stages" aria-label="自动处理步骤">{stages.map((label, index) => <li key={label} className={done || index < stage ? 'complete' : index === stage ? 'current' : ''} aria-current={!done && index === stage ? 'step' : undefined}><span>{done || index < stage ? '✓' : index + 1}</span>{label}</li>)}</ol>
    {!done && step && phase !== 'export' && <div className="task-scope-line" aria-label="流程步骤"><strong>{step.stage === 'preparation' ? '预处理' : '翻译与检查'} · 第 {step.index}/{step.total} 步：{step.label}</strong><span>本阶段后续 {step.total - step.index} 步{step.stage === 'preparation' ? '；之后进行翻译与检查，再保存成品' : '；通过后保存成品'}</span></div>}
    <div className="task-progress-heading"><strong>{done ? '成品已保存' : waiting ? '等待确认 · ' + state.waitingDecisionIds!.length + ' 项' : phaseLabel}</strong>
      {hasCount && !done && <span className="task-step-count">{detail.done.toLocaleString()} / {detail.total.toLocaleString()} {detail.unit}<b>{pct}%</b><small>当前步骤，非全书完成率</small></span>}
      {done && <span className="task-step-count">全部检查通过</span>}
    </div>
    {!done && hasCount && <div className={'task-wide-progress' + (progress.paused || state?.status === 'stopped' || state?.status === 'attention' ? ' paused' : '')} role="progressbar" aria-label={phaseLabel + '进度'} aria-valuemin={0} aria-valuemax={detail.total} aria-valuenow={Math.min(detail.done, detail.total)} aria-valuetext={detail.done + ' / ' + detail.total + ' ' + detail.unit + '，' + pct + '%'}><i style={{ width: pct + '%' }} /></div>}
    {!done && !hasCount && live && <p className="task-count-pending">{progress.phase === 'review-assistant' ? '正在解释当前待确认项，书稿与译名仍等你确认。' : phase === 'export' ? '正在写入成品文件，保存完成后可直接打开。' : '正在处理，等待当前步骤的完成数量…'}</p>}
    {(detail?.chapterTitle || state?.run) && <div className="task-scope-line">{detail?.chapterTitle && <span className="task-chapter-title" title={detail.chapterTitle}>{detail.chapterTitle}</span>}{state?.run && <span>全任务已检查 <b>{state.run.done} / {state.run.total}</b> 册</span>}</div>}
  </div>;
}
