import { useEffect, useMemo, useRef, useState } from 'react';
import { REVIEW_KIND_LABELS, type ReviewItemView } from '@shared/types';
import {
  REVIEW_OPERATION_LABELS, reviewOperationItems, reviewItemVersion, reviewPreviewValue,
  type ReviewOperation, type ReviewOperationRequest, type ReviewOperationResult, type ReviewOperationScope,
} from '@shared/reviewOperations';
import { ReviewOperationSession } from './reviewOperationSession';

export interface ScopedReviewActionsProps {
  /** Parent includes only rows of the active status and visible category. */
  items: readonly ReviewItemView[];
  scope: Omit<ReviewOperationScope, 'ids'>;
  scopeLabel: string;
  identityToken: string;
  ready: boolean;
  disabled: boolean;
  execute: (request: ReviewOperationRequest) => Promise<ReviewOperationResult>;
  onBusy: (busy: boolean) => void;
  onRefresh: () => void;
  cancel: () => Promise<void> | void;
}
const operations = Object.keys(REVIEW_OPERATION_LABELS) as ReviewOperation[];

/** Standalone toolbar. Host disables cards, category and scope controls while onBusy is true. */
export function ScopedReviewActions(props: ScopedReviewActionsProps) {
  const [operation, setOperation] = useState<ReviewOperation>('ai-review');
  const [preview, setPreview] = useState<ReviewItemView[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [variation, setVariation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ReviewOperationResult | null>(null);
  const [error, setError] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const session = useRef(new ReviewOperationSession());
  const scopeKey = JSON.stringify([props.identityToken, props.scope]);
  const currentKey = useRef(scopeKey); currentKey.current = scopeKey;
  useEffect(() => {
    session.current.invalidate(); setPreview(null); setSelected(new Set()); setReport(null); setError(''); setNeedsRefresh(false); setBusy(false); props.onBusy(false);
  }, [scopeKey]);
  useEffect(() => { const lifetime = new ReviewOperationSession(); session.current = lifetime; return () => lifetime.dispose(); }, []);
  const eligible = useMemo(() => reviewOperationItems(props.items, props.scope.kind ?? null, operation), [props.items, props.scope.kind, operation]);
  const locked = busy || props.disabled || !props.ready;
  const open = () => {
    if (locked || session.current.busy) return;
    const frozen = structuredClone(needsRefresh ? eligible.filter(item => selected.has(item.id)) : eligible);
    setPreview(frozen); setSelected(new Set(frozen.map(item => item.id))); setNeedsRefresh(false); setVariation(false); setError('');
  };
  const run = async () => {
    if (locked || session.current.busy || needsRefresh || !preview || !selected.size) return;
    const capturedKey = scopeKey;
    const ids = preview.filter(item => selected.has(item.id)).map(item => item.id);
    const request: ReviewOperationRequest = { operation, scope: { ...props.scope, ids }, allowVariation: variation,
      expectedVersions: Object.fromEntries(preview.filter(item => selected.has(item.id)).map(item => [item.id, reviewItemVersion(item)])) };
    setBusy(true); props.onBusy(true); setError('');
    await session.current.run(request, props.execute, {
      result: result => {
        if (currentKey.current !== capturedKey) return;
        setReport(result);
        const failed = new Set(result.items.filter(item => item.status !== 'succeeded').map(item => item.id));
        setSelected(failed); setPreview(failed.size ? preview.filter(item => failed.has(item.id)) : null); setNeedsRefresh(failed.size > 0);
        props.onRefresh();
      },
      error: message => { if (currentKey.current === capturedKey) { setError(message); setNeedsRefresh(true); props.onRefresh(); } },
      settled: () => { if (currentKey.current === capturedKey) { setBusy(false); props.onBusy(false); } },
    });
  };
  return <section aria-label="分类审核操作">
    <p>本次范围：{props.scopeLabel} · {props.scope.kind ? REVIEW_KIND_LABELS[props.scope.kind] : '全部可见分类'}。先选操作，再核对要处理的名单。</p>
    <p className="small muted">确认前会列出将采用的译法。生成候选或获取 AI 建议不会直接采用；译文中的质量问题仍须检查通过。</p>
    <fieldset disabled={locked} style={{ border: 0, padding: 0 }}>
      <label>操作类别 <select aria-label="操作类别" value={operation} onChange={event => {
        if (locked || session.current.busy) return;
        setOperation(event.target.value as ReviewOperation); setPreview(null); setSelected(new Set()); setNeedsRefresh(false); setReport(null);
      }}>{operations.map(value => <option key={value} value={value}>{REVIEW_OPERATION_LABELS[value]}</option>)}</select></label>
      <button className="btn btn-secondary btn-sm" disabled={locked || !eligible.length} onClick={open}>{needsRefresh ? '重新查看未完成项' : '查看适用项'}（{needsRefresh ? eligible.filter(item => selected.has(item.id)).length : eligible.length}）</button>
      {preview && <div role="group" aria-label="确认本次范围">
        <p>已选择 {selected.size} / {preview.length} 项。开始后会按这份名单处理；未选项目保持原样。</p>
        {preview.map(item => <label key={item.id} style={{ display: 'block' }}><input type="checkbox" checked={selected.has(item.id)} disabled={locked} onChange={() => {
          if (locked || session.current.busy) return;
          setSelected(previous => { const next = new Set(previous); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next; });
        }} />{REVIEW_KIND_LABELS[item.kind]} · {item.title}
          {reviewPreviewValue(item, operation) !== null && <span style={{ display: 'block', marginLeft: 24 }}>将采用：{reviewPreviewValue(item, operation)}</span>}
        </label>)}
        {(operation === 'confirm-preselected' || operation === 'confirm-ai') && <label><input type="checkbox" checked={variation} disabled={locked} onChange={event => { if (!locked && !session.current.busy) setVariation(event.target.checked); }} />称谓允许变化</label>}
        {needsRefresh && <p>未完成项已保留。请先重新查看当前答案，再提交。</p>}
        <button className="btn btn-primary btn-sm" disabled={locked || needsRefresh || !selected.size} onClick={run}>{busy ? '处理中…' : `执行${REVIEW_OPERATION_LABELS[operation]}（${selected.size}）`}</button>
        <button className="btn btn-secondary btn-sm" disabled={locked} onClick={() => { if (!locked && !session.current.busy) { setPreview(null); setNeedsRefresh(false); } }}>取消选择</button>
      </div>}
    </fieldset>
    {busy && <button className="btn btn-secondary btn-sm" onClick={() => { void Promise.resolve(props.cancel()).catch(reason => setError(String(reason))); }}>停止当前操作</button>}
    {error && <p role="alert">{error}</p>}
    {report && <div aria-live="polite"><p>本次成功 {report.items.filter(item => item.status === 'succeeded').length} 项；失败或取消 {report.items.filter(item => item.status !== 'succeeded').length} 项。{report.cancelled ? '操作已取消。' : ''}</p>
      {report.items.map(item => <p key={item.id}>{item.title}：{item.message}</p>)}
    </div>}
  </section>;
}
