import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { nextReviewItem } from './navigation';
import { draftIdentity } from '../../store/draftIdentityBridge';
import { useReviewDraftNavigation, consumeReviewDraftTarget } from '../../store/reviewDraftNavigation';
import { useApp, tryApi } from '../../store/app';
import { api } from '../../api';
import { ReviewCard } from './ReviewCard';
import { DiagnosticDetails, ReviewItemDiagnostics, reviewDisplayTitle } from './ReviewDiagnostics';
import { LegacyChangeRecovery } from './LegacyChangeRecovery';
import { ScopedReviewActions } from './ScopedReviewActions';
import { Pill } from '../../components/ui';
import { REVIEW_KIND_LABELS, type ReviewItemView, type ReviewKind } from '@shared/types';

const ORDER: ReviewKind[] = ['failed', 'lock-conflict', 'review-block', 'honorific-first', 'quirk-candidate', 'gender-plural', 'term-proposal', 'wordplay', 'ambiguity', 'glossary-deviation', 'stale-knowledge', 'warning'];
const undoReceipt = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  return receipt.undoneAt ? null : receipt;
};
export function canUndoResolved(item: ReviewItemView): boolean {
  const payload = item.payload;
  if (!['term-proposal', 'honorific-first', 'quirk-candidate'].includes(item.kind)) return true;
  return [payload.knowledgeDecision, payload.automaticParagraphLiteralAddress,
    payload.automaticOrdinaryQuirkDismissal].some(value => !!undoReceipt(value));
}
function resolvedDetail(item: ReviewItemView): ReactNode {
  const payload = item.payload;
  const pair = payload.automaticParagraphLiteralAddress && typeof payload.automaticParagraphLiteralAddress === 'object'
    ? (payload.automaticParagraphLiteralAddress as { pair?: { source?: string; target?: string } }).pair : undefined;
  const fieldReceipt = undoReceipt(payload.automaticFieldDismissal);
  const unadoptedVoice = fieldReceipt?.action === 'unadopted-voice-observation' && fieldReceipt.verdict === 'uncertain';
  const quirkReceipt = undoReceipt(payload.automaticQuirkDecision);
  const relationReceipt = undoReceipt(payload.automaticRelationshipTerminationReview) as { review?: {reason?:string} } | null;
  const characterReceipt = undoReceipt(payload.automaticCharacterInvalidationReview);
  const character = characterReceipt as { review?: { reason?: string; decision?: string }; reason?: string } | null;
  return <>{pair?.source && pair.target && <div className="small">本段：{pair.source} → {pair.target}（不改变人物关系）</div>}
    {fieldReceipt?.action==='local-register-observation' && fieldReceipt.verdict==='local-register' && <div className="small"><strong>仅本处的语域观察</strong>：未替换人物长期语域；只适用于这处对话，正文按原文的说话方式翻译。</div>}
    {unadoptedVoice && <div className="small"><strong>未采用的声音观察</strong>：证据不足，已保留资料；未确认人物归属、未修改声音字段，正文仍须正常翻译与审校。</div>}
    {quirkReceipt?.action === 'unadopted-quirk-observation' && <div className="small"><strong>未采用此语癖提案</strong>：{quirkReceipt.decision === 'uncertain' ? '证据不足，已保留原判断。' : quirkReceipt.decision === 'supported' ? '普通礼貌表达按原文翻译，不固定成特殊口癖。' : '审核不支持此提案。'}人物资料和正文没有因此改写。</div>}
    {relationReceipt?.review?.reason && <div className="small">{relationReceipt.review.reason}（已保留关系记录）</div>}
    {character?.review?.reason && <div className="small">{character.review.reason}</div>}
    {character?.review?.decision === 'unsupported' && <div className="small">已保留人物档案</div>}</>;
}
export function ReviewPage() {
  const { currentSeriesId, currentVolumeId, rev, progress, toast } = useApp();
  const identity = useSyncExternalStore(draftIdentity.subscribe, draftIdentity.snapshot);
  const target = useReviewDraftNavigation(s => s.target);
  const [scope, setScope] = useState<'volume' | 'series'>('volume');
  const [tab, setTab] = useState<'pending' | 'resolved' | 'dismissed'>('pending');
  const [filter, setFilter] = useState<ReviewKind | null>(null);
  const [items, setItems] = useState<ReviewItemView[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [cardBusy, setCardBusy] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const previousOrder = useRef<string[]>([]);
  const listKey = JSON.stringify([identity.token, currentSeriesId, currentVolumeId, scope, tab]);
  const currentListKey = useRef(listKey); currentListKey.current = listKey;
  const busyCards = useRef(new Set<string>());
  const cardActivity = (id: string, value: boolean) => {
    if (currentListKey.current !== listKey) return;
    value ? busyCards.current.add(id) : busyCards.current.delete(id);
    setCardBusy(busyCards.current.size > 0);
  };
  const readyScope = !!currentSeriesId && (scope === 'series' || !!currentVolumeId) && identity.status === 'ready';
  const listReady = readyScope && !loading && loadedKey === listKey && !loadError;
  const locked = operationBusy || cardBusy || progress.running;
  useEffect(() => {
    if (!target || locked) return;
    if (!draftIdentity.isCurrent(target.token)) { consumeReviewDraftTarget(target.sequence); return; }
    if (target.seriesId !== currentSeriesId || (target.volumeId && target.volumeId !== currentVolumeId)) return;
    setTab(target.status); setScope(target.volumeId ? 'volume' : 'series'); setFilter(null);
  }, [target, currentSeriesId, currentVolumeId, identity.token, locked]);
  useEffect(() => {
    setItems([]); setLoadedKey(null); setLoadError(null); setActive(null); previousOrder.current = []; busyCards.current.clear(); setCardBusy(false); setOperationBusy(false);
  }, [listKey]);
  useEffect(() => {
    let live = true;
    const current = () => live && draftIdentity.isCurrent(identity.token);
    setLoading(true); setLoadedKey(null); setLoadError(null);
    if (!readyScope || !currentSeriesId) { setItems([]); setLoading(false); return; }
    void api.review.list(currentSeriesId, tab, scope === 'volume' ? currentVolumeId! : undefined)
      .then(list => { if (current()) { setItems(list); setLoadedKey(listKey); } })
      .catch(error => { if (current()) { const message=error instanceof Error?error.message:String(error);setLoadError(message || '未能取得当前列表');toast('error','问题列表读取失败，请重试读取。'); } })
      .finally(() => { if (current()) setLoading(false); });
    return () => { live = false; };
  }, [listKey, rev.queue, refreshEpoch, readyScope]);
  const shown = useMemo(() => items.filter(item => !filter || item.kind === filter)
    .sort((a, b) => b.priority - a.priority || (a.seriesOrdinal ?? 999999) - (b.seriesOrdinal ?? 999999)), [items, filter]);
  const counts = useMemo(() => { const result: Partial<Record<ReviewKind, number>> = {}; for (const item of items) result[item.kind] = (result[item.kind] ?? 0) + 1; return result; }, [items]);
  useEffect(() => {
    if (loading || loadedKey !== listKey) return;
    const ids = shown.map(item => item.id);
    const locating = target && draftIdentity.isCurrent(target.token) && target.seriesId === currentSeriesId && target.status === tab
      && (target.volumeId ? scope === 'volume' && currentVolumeId === target.volumeId : scope === 'series') && filter === null;
    if (locating) {
      if (ids.includes(target.queueId)) setActive(target.queueId);
      else toast('info', '复核列表已变化，请重新定位草稿；输入仍保留。');
      consumeReviewDraftTarget(target.sequence);
    } else setActive(previous => nextReviewItem(previousOrder.current, ids, previous));
    previousOrder.current = ids;
  }, [shown, loading, loadedKey, listKey, target, currentSeriesId, currentVolumeId, scope, tab, filter]);
  const activeIndex = shown.findIndex(item => item.id === active);
  const move = (step: number) => { if (!locked) { const item = shown[activeIndex + step]; if (item) setActive(item.id); } };
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => document.getElementById(`q-${active}`)?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [active]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (locked || (event.target as HTMLElement)?.closest('input, textarea, select, button, [contenteditable="true"]')) return;
      if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); move(1); }
      if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });
  if (!currentSeriesId) return <div className="empty"><h2>请先选择系列</h2></div>;
  return <>
    <div className="page-header" style={{ flexWrap: 'wrap' }}><h1 style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>待确认</h1><select className="input" style={{ width: 'auto', maxWidth: '100%' }} aria-label="问题范围" value={scope} disabled={locked} onChange={event => { if (!locked) setScope(event.target.value as 'volume' | 'series'); }}><option value="volume">本册与共享知识</option><option value="series">整个系列</option></select><span className="sub small" style={{ flex: '1 1 24rem', minWidth: 0 }}>这里只需处理软件无法自动确定的译法或问题。当前分类 {shown.length} 项 / 当前范围 {items.length} 项</span></div>
    <div className="tabs" style={{ padding: '0 24px' }}>{(['pending', 'resolved', 'dismissed'] as const).map(value => <button key={value} disabled={locked} className={`tab${tab === value ? ' active' : ''}`} onClick={() => { if (!locked) setTab(value); }}>{{ pending: '待处理', resolved: '已处理', dismissed: '已忽略' }[value]}</button>)}</div>
    <div className="page-body">
      <div className="filters"><button disabled={locked} className={`chip${filter === null ? ' on' : ''}`} onClick={() => { if (!locked) setFilter(null); }}>全部 {items.length}</button>{ORDER.filter(kind => counts[kind]).map(kind => <button key={kind} disabled={locked} className={`chip${filter === kind ? ' on' : ''}`} onClick={() => { if (!locked) setFilter(filter === kind ? null : kind); }}>{REVIEW_KIND_LABELS[kind]} {counts[kind]}</button>)}</div>
      {tab === 'pending' && <details className="review-batch-tools"><summary onClick={event=>{if(operationBusy)event.preventDefault();}}>批量处理当前列表</summary><ScopedReviewActions key={`${listKey}:${filter}`} items={shown}
        scope={{ seriesId: currentSeriesId, ...(scope === 'volume' && currentVolumeId ? { volumeId: currentVolumeId } : {}), ...(filter ? { kind: filter } : {}) }}
        scopeLabel={scope === 'volume' ? '本册与共享知识' : '整个系列'} identityToken={identity.token}
        ready={readyScope && !loading && loadedKey === listKey} disabled={progress.running || cardBusy}
        execute={request => api.review.runScoped(request)} onBusy={setOperationBusy} onRefresh={() => setRefreshEpoch(value => value + 1)} cancel={() => api.workflow.cancel()} /></details>}
      <div className="review-navigation"><button className="btn btn-secondary btn-sm" disabled={locked || loading || activeIndex <= 0} onClick={() => move(-1)}>上一项</button><span aria-live="polite">{activeIndex < 0 ? 0 : activeIndex + 1} / {shown.length}</span><button className="btn btn-secondary btn-sm" disabled={locked || loading || activeIndex < 0 || activeIndex >= shown.length - 1} onClick={() => move(1)}>下一项</button></div>
      {!readyScope && <p className="muted">请先选择有效的册；本册未选择时不会扩大到整个系列。</p>}
      {loading && <p className="muted">正在读取问题…</p>}
      {readyScope && !loading && loadError && <div className="notice" role="alert"><strong>问题列表读取失败</strong><p className="small">请重试读取，成功后再处理问题。</p><DiagnosticDetails value={loadError} />{items.length>0&&<p className="small">下方是上次读取的记录，暂不能操作。重新读取成功后再处理，已输入的草稿保留。</p>}<button className="btn btn-secondary btn-sm" onClick={() => setRefreshEpoch(value => value + 1)}>重试读取</button></div>}
      {readyScope && !loading && loadedKey === listKey && !loadError && !shown.length && <div className="empty"><h2>当前分类没有问题</h2></div>}
      <div inert={!listReady}>{shown.map(item => tab === 'pending'
        ? <div key={`${listKey}:${item.id}`} id={`q-${item.id}`} className="review-item-wrapper"><ReviewCard item={item} active={active === item.id} disabled={operationBusy || progress.running || !listReady} onBusy={value => cardActivity(item.id, value)} onSelect={() => { if (!locked && listReady) setActive(item.id); }} onPreselect={(id, zh) => setItems(list => list.map(row => row.id === id ? { ...row, payload: { ...row.payload, preSelected: zh, preSelectedBasis: '人工改选' } } : row))} /></div>
        : tab === 'resolved' && item.kind === 'stale-knowledge' && item.payload.subtype !== 'character-field' && !!item.payload.candidateId && !item.payload.changeDecision
          ? <div key={`${currentSeriesId}:${item.id}`} id={`q-${item.id}`} className={`queue-item${active === item.id ? ' active' : ''}`} aria-current={active === item.id ? 'true' : undefined}><h3>{reviewDisplayTitle(item)}</h3><ReviewItemDiagnostics item={item} /><LegacyChangeRecovery item={item} seriesId={currentSeriesId} /></div>
          : <div key={item.id} id={`q-${item.id}`} className={`queue-item${active === item.id ? ' active' : ''}`} aria-current={active === item.id ? 'true' : undefined}><div className="head"><Pill kind="muted">{REVIEW_KIND_LABELS[item.kind]}</Pill><span className="title grow">{reviewDisplayTitle(item)}</span><button className="btn btn-text btn-sm" disabled={locked || !canUndoResolved(item)} onClick={() => tryApi(() => api.review.undoResolved(item.id), '已重新打开此项')}>撤销并重新打开</button></div>{resolvedDetail(item)}<ReviewItemDiagnostics item={item} /></div>)}
      </div>
    </div>
  </>;
}

