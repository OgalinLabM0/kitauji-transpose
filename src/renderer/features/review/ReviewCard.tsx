import { kanaReading } from '@shared/kanaReading';
import { visibleNameSource } from '../../../core/validation/nameEvidence';
import { useDraft, currentDraftSession } from '../../store/useDraft';
import { useFormDraft } from '../../store/useFormDraft';
import { DraftStatus } from '../../components/DraftStatus';
import type { DraftBase } from '@shared/types';
import { ReviewEvidence } from './ReviewEvidence';
import { createContext, useContext, useState, useEffect, useRef, type ReactNode } from 'react';
import { CheckCircle, AlertCircle, XCircle } from 'lucide-react';
import { api } from '../../api';
import { tryApi, useApp } from '../../store/app';
import { MarkedText, Pill } from '../../components/ui';
import { REVIEW_KIND_LABELS, type ReviewItemView, type ReviewKind } from '@shared/types';
import type { DecisionPayload } from '@shared/ipc';
import { reviewRecommendation, reviewCandidates } from '@shared/reviewOperations';
import { DiagnosticDetails, ReviewItemDiagnostics, reviewDisplayTitle, needsDiagnosticSummary } from './ReviewDiagnostics';

const KIND_PILL: Record<ReviewKind, 'error' | 'warning' | 'info' | 'muted'> = {
  failed: 'error', 'lock-conflict': 'error', 'review-block': 'error', 'honorific-first': 'info', 'quirk-candidate': 'info', 'gender-plural': 'warning',
  'term-proposal': 'info', wordplay: 'info', ambiguity: 'warning', 'glossary-deviation': 'warning', 'stale-knowledge': 'warning', warning: 'muted',
};

// 卡片局部状态通过 context 下发给 B/Choice/CustomChoice。
// 这三个组件必须定义在模块层：若定义在 ReviewCard 渲染体内，每次 setState 都会生成新组件身份，
// React 会整树卸载重挂，自定义输入框每敲一个字就失焦（曾出现的 bug）。
interface CardCtx { busy: boolean; pick: string | null; setPick: (v: string | null) => void; custom: string; setCustom: (v: string) => void; commitCustom: () => void }
const Ctx = createContext<CardCtx>({ busy: false, pick: null, setPick: () => {}, custom: '', setCustom: () => {}, commitCustom: () => {} });

function B({ children, primary, onClick, disabled }: { children: ReactNode; primary?: boolean; onClick: () => void; disabled?: boolean }) {
  const { busy } = useContext(Ctx);
  return <button className={`btn btn-sm ${primary ? 'btn-primary' : 'btn-secondary'}`} disabled={busy || disabled} onClick={onClick}>{children}</button>;
}
function Choice({ v, label, why }: { v: string; label: ReactNode; why?: string }) {
  const { busy, pick, setPick } = useContext(Ctx);
  return <div className={`choice${pick === v ? ' on' : ''}`} onClick={() => { if (!busy) setPick(v); }}><input type="radio" disabled={busy} readOnly checked={pick === v} /><span className="grow">{label}</span>{why && <span className="why">{why}</span>}</div>;
}
function CustomChoice() {
  const { busy, pick, setPick, custom, setCustom, commitCustom } = useContext(Ctx);
  // 自定义值在失焦 / 回车时持久化为预选（边打字边存会太频繁）
  return <div className={`choice${pick === '__custom' ? ' on' : ''}`} onClick={() => { if (!busy) setPick('__custom'); }}><input type="radio" disabled={busy} readOnly checked={pick === '__custom'} /><input disabled={busy} className="input" placeholder="自定义…" value={custom} onChange={e => { setCustom(e.target.value); setPick('__custom'); }} onBlur={commitCustom} onKeyDown={e => { if (e.key === 'Enter') commitCustom(); }} onClick={e => e.stopPropagation()} /></div>;
}

interface ReviewCardProps { item: ReviewItemView; disabled?: boolean; onBusy?: (busy: boolean) => void; compact?: boolean; active?: boolean; onSelect?: () => void; onPreselect?: (id: string, zh: string) => void }
function TermProposalBackground({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ id: string; source: string; ordinal: number }[] | null>(null);
  const [error, setError] = useState('');
  const seriesId = useApp(s => s.currentSeriesId);
  const series = useApp(s => s.series);
  const revision = useApp(s => s.rev.paragraphs);
  useEffect(() => {
    let active = true; setRows(null); setError('');
    if (!open || !Array.isArray(value) || !value.length) return;
    const token = currentDraftSession();
    const entries = value as { id?: unknown; source?: unknown }[];
    if (entries.length > 6 || entries.some(e => !e || typeof e.id !== 'string' || typeof e.source !== 'string')
      || new Set(entries.map(e => e.id)).size !== entries.length) { setError('背景记录不完整，未显示。'); return; }
    const volumeIds = new Set(series.find(s => s.id === seriesId)?.volumes.map(v => v.id) ?? []);
    void Promise.all(entries.map(e => api.project.getParagraph(e.id as string))).then(paragraphs => {
      if (!active || token !== currentDraftSession()) return;
      if (paragraphs.some((p, i) => !p || !volumeIds.has(p.volumeId) || visibleNameSource(p.sourceText) !== entries[i]!.source)) {
        setError('背景原文已变化或不属于当前作品，旧背景未显示。'); return;
      }
      setRows(paragraphs.map(p => ({ id: p!.id, source: visibleNameSource(p!.sourceText), ordinal: p!.seriesOrdinal })));
    }).catch(() => { if (active && token === currentDraftSession()) setError('暂时无法读取背景原文。'); });
    return () => { active = false; };
  }, [open, value, seriesId, series, revision]);
  if (!Array.isArray(value) || !value.length) return null;
  return <details onToggle={e => setOpen(e.currentTarget.open)}><summary>查看译名参考的背景原文</summary>
    <p className="small muted">这些原文帮助理解简称和昵称，不能单凭相似读音认定是同一人物。</p>
    {open && (rows ? rows.map(p => <div key={p.id} className="small faint"><span>§{p.ordinal}：</span><MarkedText text={p.source} /></div>) : <p className="small muted">{error || '正在核对原文…'}</p>)}
  </details>;
}
export function ReviewCard(props: ReviewCardProps) {
  const seriesId = useApp(s => s.currentSeriesId);
  // Reset transient requests and paragraph reads even when the parent reuses this card.
  return <ReviewCardForm key={`${seriesId}:${props.item.kind}:${props.item.id}:${props.item.paragraphId}`} {...props} />;
}
function ReviewCardForm({ item, compact, active, onSelect, onPreselect, disabled = false, onBusy }: ReviewCardProps) {
  const mounted = useRef(true);
  const externallyDisabled = useRef(disabled); externallyDisabled.current = disabled;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onBusy?.(false); }; }, []);
  const pl = item.payload as Record<string, any>;
  // 预选：自动仲裁（或用户上次改选）写入的 preSelected，作为初始选中项（用户仍可改可推翻）
  const preSelected: string | null = typeof pl?.preSelected === 'string' ? pl.preSelected : null;
  const canPreselect = item.kind === 'term-proposal' || item.kind === 'ambiguity' || item.kind === 'honorific-first';
  // 若 preSelected 不在候选里，说明是用户之前输入的自定义值 → 初始落到自定义框
  const candZh = reviewCandidates(item).map(candidate => candidate.zh).concat(item.kind === 'honorific-first' && typeof pl.usedZh === 'string' ? [pl.usedZh] : []);
  const preIsCustom = !!preSelected && canPreselect && !candZh.includes(preSelected);
  // review-block: 预填充AI的建议修复（如果有）或当前译文（让用户修改）
  const reviewBlockInitial = item.kind === 'review-block' ? (pl.suggestedFix ? String(pl.suggestedFix) : (pl.translation ? String(pl.translation) : '')) : '';
  const [currentDraft, setCurrentDraft] = useState<{base: DraftBase; text: string} | null>(null);
  const rev = useApp(s => s.rev.paragraphs);
  useEffect(() => {
    let active = true;
    if (item.kind === 'review-block' && item.paragraphId) void api.project.getParagraph(item.paragraphId).then(p => { if (active && p) setCurrentDraft({ base: { version: p.final?.version ?? 0, sourceText: p.sourceText }, text: p.final?.text ?? '' }); }).catch(() => {});
    return () => { active = false; };
  }, [item.id, item.paragraphId, item.kind, rev]);
  // Preselection acknowledgements are metadata, not the candidate/evidence baseline.
  const { preSelected: _preSelected, preSelectedBasis: _basis, ...decisionPayload } = pl;
  const baseline = { kind: item.kind, status: item.status, paragraphId: item.paragraphId, payload: decisionPayload };
  const draft = useDraft(`draft-review-${item.id}`, item.kind === 'review-block' ? currentDraft?.text ?? reviewBlockInitial : (preIsCustom ? preSelected! : ''), item.kind === 'review-block' ? currentDraft?.base ?? null : { version: 1, sourceText: JSON.stringify(baseline) });
  const custom = draft.text;
  const initialPick = preIsCustom ? '__custom' : preSelected ?? (item.kind === 'honorific-first' ? pl.recommended ?? '' : '');
  const seriesId = useApp(s => s.currentSeriesId);
  const selection = useFormDraft(`review-choice-${item.id}`, { pick: draft.stored && item.kind !== 'review-block' ? '__custom' : String(initialPick) }, { page: 'review', ...(seriesId ? { seriesId } : {}), objectId: item.id, title: `${item.title} · 复核选择` }, baseline);
  const pick = selection.value.pick || null;
  const conflict = draft.conflict || (item.kind !== 'review-block' && (selection.conflict || selection.malformed));
  const [localBusy, setLocalBusy] = useState(false);
  const busy = localBusy || disabled;
  const setBusy = (value: boolean) => { if (mounted.current) { setLocalBusy(value); onBusy?.(value); } };
  const lock = useRef(false);
  const [preselectError, setPreselectError] = useState('');
  const [acknowledged, setAcknowledged] = useState('');
  const toast = useApp(s => s.toast);
  const setCustom = (text: string): void => { if (!lock.current && !externallyDisabled.current && mounted.current) draft.change(text); };
  // Serialize writes and decisions. A late acknowledgement never rewrites a draft.
  const persistPreselect = (zh: string): void => {
    if (lock.current || externallyDisabled.current || !mounted.current || conflict || !canPreselect || !zh) return;
    if (zh === preSelected && !preselectError) { setAcknowledged(zh); return; }
    const scope = currentDraftSession();
    lock.current = true; setBusy(true); setPreselectError('');
    void api.review.setPreselect(item.id, zh).then(() => {
      if (!mounted.current || scope !== currentDraftSession()) return;
      setAcknowledged(zh); onPreselect?.(item.id, zh);
    }).catch((error: unknown) => {
      if (!mounted.current || scope !== currentDraftSession()) return;
      setPreselectError(`预选写入失败：${error instanceof Error ? error.message : String(error)}。本地选择和自定义输入已保留；批量确认仍可能使用旧预选，请重试或在本卡确认。`);
    }).finally(() => { lock.current = false; setBusy(false); });
  };
  const setPick = (v: string | null): void => {
    if (lock.current || externallyDisabled.current || !mounted.current) return;
    selection.change({ pick: v ?? '' }); setAcknowledged('');
    if (v && v !== '__custom') persistPreselect(v);
  };
  const commitCustom = (): void => { const v = custom.trim(); if (pick === '__custom' && v) persistPreselect(v); };
  const decide = async (d: { action: string; [k: string]: unknown }): Promise<void> => {
    if (lock.current || externallyDisabled.current || !mounted.current || conflict || (item.kind === 'review-block' && d.action === 'edit' && !draft.base)) return;
    const scope = currentDraftSession();
    lock.current = true; setBusy(true);
    try {
      const r = await tryApi(() => api.review.decide(item.id, { ...d, ...(item.kind === 'review-block' && d.action === 'edit' ? { base: draft.base } : {}), kind: item.kind } as DecisionPayload));
      if (!mounted.current || scope !== currentDraftSession()) return;
      if (r?.ok) {
        // Captured-record comparison protects edits made after submission.
        draft.clear(); selection.clear();
        if (!mounted.current || scope !== currentDraftSession()) return;
        setPreselectError('');
        if (item.kind === 'review-block' && item.paragraphId) {
          const check = await tryApi(() => api.translation.reverify(item.paragraphId!));
          if (check) toast(check.ok ? 'success' : 'warning', check.message);
          return;
        }
        toast('success', r.message + (r.recheckCount ? `（${r.recheckCount} 段进入回查）` : '') + (r.retranslate.length ? '，本段重译中' : ''));
      }
      else if (r) toast('error', `未能处理：${r.message}`);
    } finally { lock.current = false; setBusy(false); }
  };
  const chosen = pick === '__custom' ? custom.trim() : pick;
  const unpersisted = canPreselect && !!selection.stored && !!chosen && chosen !== preSelected && chosen !== acknowledged;
  useEffect(() => { onBusy?.(localBusy || !!preselectError || !!unpersisted || !!conflict); }, [localBusy, preselectError, unpersisted, conflict]);
  const combinedDraft = {
    ...selection, busy, stored: draft.stored || selection.stored, conflict,
    error: [draft.error, selection.error].filter(Boolean).join('；'),
    text: JSON.stringify({ pick, custom }, null, 2),
    rebase: () => { if (draft.stored) draft.rebase(); if (selection.stored) selection.rebase(); },
    clear: () => { const textCleared = draft.clear(); const pickCleared = selection.clear(); return textCleared && pickCleared; },
  };

  let body: ReactNode = null;
  let helpText: string | null = null;
  switch (item.kind) {
    case 'failed':
      helpText = '这段还没有处理完成。可点“重跑”重新处理；忽略此项不代表译文已经通过检查。';
      body = <div className="btn-group"><B primary onClick={() => decide({ action: 'retry' })}>重跑</B><B onClick={() => decide({ action: 'dismiss' })}>忽略</B></div>; break;
    case 'review-block':
      helpText = '发现需要检查的问题。你可以修改译文，保存后会重新检查；检查通过就关闭这个问题，没通过会保留原文和这条待处理项。';
      body = <>
      {compact && pl.source && <div className="small muted" style={{ marginBottom: 4 }}>原文：<span style={{ fontFamily: 'var(--font-reading)' }}>{pl.source}</span></div>}
      {compact && pl.translation && <div className="small" style={{ marginBottom: 4 }}>当前译文（AI认为有问题）：{pl.translation}</div>}
      {pl.evidenceJp && <div className="small muted" style={{ marginBottom: 4 }}>原文证据：<span style={{ fontFamily: 'var(--font-reading)' }}>{pl.evidenceJp}</span></div>}
      {draft.conflict && <div role="alert">原稿已变化或旧草稿没有版本记录；请对照当前稿。<div><MarkedText text={currentDraft?.text ?? '正在读取当前稿…'} /></div><B disabled={!currentDraft} onClick={draft.rebase}>已对照，以当前版本为基准保留输入</B></div>}
      <textarea className="input" style={{ marginTop: 8 }} placeholder="修改译文" value={custom} disabled={busy} onChange={e => setCustom(e.target.value)} />
      <div className="btn-group" style={{ marginTop: 8 }}>
        <B primary onClick={() => decide({ action: 'edit', text: custom.trim() })} disabled={!custom.trim() || !draft.base || draft.conflict}>保存并重新检查</B>
        {pl.translation && <B onClick={() => setCustom(String(pl.translation))}>改回原译文</B>}
      </div></>; break;
    case 'lock-conflict':
      helpText = '这个术语已经锁定了译名，但AI觉得这里应该用另一个译法。可能是之前锁定错了，也可能是AI判断错了。';
      body = <>
      <div className="small">模型认为应为「{pl.believedZh}」：{pl.rationale}</div>
      <div className="btn-group" style={{ marginTop: 8 }}><B primary onClick={() => decide({ action: 'keep-lock' })}>维持锁定「{pl.glossaryZh}」</B><B onClick={() => decide({ action: 'change-lock', newZh: pl.believedZh })}>改锁定为「{pl.believedZh}」</B></div></>; break;
    case 'honorific-first': {
      helpText = '某个人物第一次称呼另一个人物，需要确定中文怎么叫。锁定后这个阶段都会这样叫；如果选"允许变化"，AI可以根据关系发展或情绪变化调整称呼。';
      const cands = (Array.isArray(pl.candidates) ? pl.candidates : []).filter((c: any) => c && typeof c.zh === 'string' && c.zh.trim()) as { zh: string; register?: string; rationale?: string }[];
      body = <>
        {pl.source && <div className="small muted" style={{ marginBottom: 4 }}>原文：<span style={{ fontFamily: 'var(--font-reading)' }}>{pl.source}</span></div>}
        {pl.translation && <div className="small" style={{ marginBottom: 4 }}>初译：{pl.translation}</div>}
        {pl.relationStage && <div className="small muted">关系阶段：{pl.relationStage}</div>}
        {pl.needsContextConfirmation === true && <div className="small">原文信息不足，尚未推荐称呼。请结合人物关系确认。</div>}
        {Array.isArray(pl.evidenceSources) && pl.evidenceSources.length > 0 && <details className="small"><summary>查看称呼依据</summary>{pl.evidenceSources.filter((p: any) => p && typeof p.source === 'string').map((p: any) => <p key={p.id}>{p.source}</p>)}</details>}
        {cands.length === 0 && <div className="row small" style={{ margin: '6px 0' }}><span className="muted">还没有 AI 选项</span><B onClick={async () => {
          if (lock.current || externallyDisabled.current || !mounted.current) return;
          const session = currentDraftSession(); lock.current = true; setBusy(true);
          try {
            const result = await api.review.resolveHonorific(item.id);
            if (mounted.current && session === currentDraftSession() && (!result || !reviewCandidates(result).length)) setPreselectError('候选未生成，问题保留；请检查人物、中文名和活动日志。');
          } catch (error) { if (mounted.current && session === currentDraftSession()) setPreselectError(`候选生成失败：${String(error)}`); }
          finally { lock.current = false; if (session === currentDraftSession()) setBusy(false); }
        }}>生成选项</B></div>}
        {pl.prescan && <div className="small faint">来自「④ 称谓预扫描」：全册 {pl.occurrences ?? '?'} 处。确认后翻译时直接套用，且 A→B 与 B→A 分开记录。</div>}
        {cands.map(c => <Choice key={c.zh} v={c.zh} label={<>{c.zh}{pl.recommended === c.zh && <Pill kind="info">AI 推荐</Pill>}{pl.preSelected === c.zh && pl.preSelectedBasis === '人工改选' && <Pill kind="warning">人工</Pill>}</>} why={`${({intimate:'亲近',neutral:'日常',formal:'正式',mocking:'戏谑'} as Record<string,string>)[c.register ?? ''] ?? ''}${c.rationale ? ` · ${c.rationale}` : ''}`} />)}
        {pl.usedZh && !cands.some(c => c.zh === pl.usedZh) && <Choice v={pl.usedZh} label={pl.usedZh} why="初译用法" />}
        <CustomChoice />
        <div className="row" style={{ marginTop: 8, gap: 6 }}><B primary disabled={!chosen} onClick={() => decide({ action: 'choose', zh: chosen })}>{pl.preSelected && chosen === pl.preSelected ? '确认预选并锁定' : '锁定此称呼'}</B><B disabled={!chosen} onClick={() => decide({ action: 'choose', zh: chosen, allowVariation: true })}>锁定（允许变化）</B></div></>; break;
    }
    case 'quirk-candidate':
      helpText = 'AI发现这个角色的对话里总出现特殊语尾或口头禅，可能是语癖（比如「〜にゃ」→「喵」）。确认后这个角色的这种语尾会统一按你定义的方式翻译；如果不是语癖就选否定。';
      body = <>
      {pl.prescan && <div className="small faint">来自「① 全书预读」：全册对话中出现 {pl.occurrences ?? '?'} 处{pl.note ? ` · ${pl.note}` : ''}。锁定后翻译时该人物的这一形式统一按译法处理；否定后不再提示。</div>}
      <div className="small">译法：<b>{pl.proposedPattern}</b> · 信号：{pl.signal === 'strong' ? '强（波浪号/♥）' : pl.signal === 'consistency' ? '一致性' : '默认'}{pl.items ? ` · 合并 ${(pl.items as unknown[]).length + 1} 处` : ''}</div>
      <div className="row" style={{ marginTop: 8 }}><input className="input" style={{ maxWidth: 160 }} placeholder={pl.proposedPattern} value={custom} onChange={e => setCustom(e.target.value)} /><B primary onClick={() => decide({ action: 'confirm', pattern: custom.trim() || pl.proposedPattern })}>锁定为语癖</B><B onClick={() => decide({ action: 'reject' })}>否定（不是语癖）</B></div></>; break;
    case 'gender-plural':
      helpText = 'AI需要确认某个角色的性别或代词的单复数。确认后会记录到角色档案，影响后面翻译里「他/她」的用法。如果原文看不出来，可以选「保持未知」。';
      body = <>{pl.evidence && <div className="small" style={{ marginBottom: 6 }}>原文证据：<span style={{ fontFamily: 'var(--font-reading)' }}>{String(pl.evidence)}</span>{pl.confidence != null && <span className="faint"> · 置信度 {Number(pl.confidence).toFixed(2)}</span>}</div>}<div className="btn-group"><B primary onClick={() => decide({ action: 'confirm' })}>确认 {pl.gender}</B><B onClick={() => decide({ action: 'set', gender: pl.gender === 'female' ? 'male' : 'female' })}>改为 {pl.gender === 'female' ? 'male' : 'female'}</B><B onClick={() => decide({ action: 'set', gender: null })}>保持未知</B></div></>; break;
    case 'term-proposal': {
      const reading = typeof pl.termJp === 'string' ? kanaReading(pl.termJp) : null;
      helpText = '请确定这个专名、称呼或作品用语的中文译法。确认后全书都用这个译名，会写入术语表。可以选音译、意译，也可以自己输入。';
      const cands = (Array.isArray(pl.candidates) ? pl.candidates : []).filter((c: any) => c && typeof c.zh === 'string' && c.zh.trim()) as { zh: string; basis?: string; pros?: string; cons?: string }[];
      body = <>
        {reading && <div className="small muted" style={{ marginBottom: 8 }}>假名读音：<b>{reading}</b>（罗马音，非英文词源）</div>}
        {(pl.examples as { text: string }[] | undefined)?.slice(0, 2).map((e, i) => <div key={i} className="small faint" style={{ fontFamily: 'var(--font-reading)' }}>{e.text}</div>)}
        <TermProposalBackground value={pl.proposalBackground} />
        {cands.length === 0 && <div style={{ background: 'rgba(234, 179, 8, 0.1)', border: '1px solid rgba(234, 179, 8, 0.3)', borderRadius: 4, padding: '8px 12px', marginBottom: 8, fontSize: '0.9em', color: 'var(--color-text-secondary)' }}>⚠️ AI 没有生成译名选项。这可能是预处理阶段的数据异常，请手动输入译名或重新运行预处理。</div>}
        {cands.map(c => <Choice key={c.zh} v={c.zh} label={<>{c.zh}{pl.preSelected === c.zh && <Pill kind="info">AI 预选</Pill>}</>} why={`${c.basis === 'phonetic' ? '音译' : c.basis === 'official' ? '官方' : '意译'}${c.pros ? ` · ${c.pros}` : ''}${c.cons ? ` · 缺点：${c.cons}` : ''}`} />)}
        <CustomChoice />
        <div className="row" style={{ marginTop: 8 }}><B primary disabled={!chosen} onClick={() => decide({ action: 'choose', zh: chosen, acceptVariants: true })}>{pl.preSelected && chosen === pl.preSelected ? '确认预选' : '确认为默认义'}</B><B disabled={!chosen} onClick={() => decide({ action: 'choose', zh: chosen, lockLevel: 'hard-locked', acceptVariants: true })}>硬锁定</B><B onClick={() => decide({ action: 'reject' })}>不是术语</B></div>
        {pl.preSelected && <div className="small faint" style={{ marginTop: 6 }}>建议译名：“{pl.preSelected}”。请你核对原文后确认，也可以改选或自填；确认后仍可在术语表修改。</div>}
        </>; break;
    }
    case 'wordplay':
      helpText = 'AI发现原文里有谐音梗或双关语。你可以用AI的谐音方案，也可以自己想一个，或者放弃谐音效果直接翻译原意并加注释。';
      body = <>
      <div className="small">「{pl.variant}」是「{pl.original}」（{pl.meaning}）的谐音/口误。{pl.rationale}</div>
      {pl.proposal && <Choice v={pl.proposal} label={pl.proposal} why={`AI 提案 · 置信度 ${Number(pl.confidence).toFixed(2)}`} />}
      <CustomChoice />
      <div className="row" style={{ marginTop: 8 }}><B primary disabled={!chosen} onClick={() => decide(chosen === pl.proposal ? { action: 'accept' } : { action: 'custom', zh: chosen })}>采用</B><B onClick={() => decide({ action: 'literal', zh: pl.meaning })}>放弃谐音，直译加注</B></div></>; break;
    case 'ambiguity': {
      helpText = '这个片假名外来词有多个可能的意思（比如「コード」可能是「代码」或「电线」），AI根据上下文猜了一个，但不太确定。你来确认一下正确的意思。';
      const inferred = (pl.inferred ?? pl.usedZh) as string | undefined;
      // 用户选了不同于推断的候选/自定义时，主按钮必须落到所选值，不能仍去 confirm 推断值
      const differs = !!chosen && chosen !== inferred;
      body = <>
      <div className="small">推断：<b>{inferred}</b>（{Number(pl.confidence).toFixed(2)}）{pl.evidence ? ` · ${pl.evidence}` : ''}</div>
      {reviewCandidates(item).map(({ zh: c }) => <Choice key={c} v={c} label={<>{c}{pl.preSelected === c && <Pill kind="info">AI 预选</Pill>}</>} />)}
      <CustomChoice />
      <div className="row" style={{ marginTop: 8 }}>
        {differs
          ? <B primary onClick={() => decide({ action: 'set', zh: chosen, addAsSense: !!pl.termId })}>确认为"{chosen}"</B>
          : <B primary onClick={() => decide({ action: 'confirm' })}>{pl.preSelected ? '确认预选' : '确认推断并写入术语表'}</B>}
        {differs && <B onClick={() => decide({ action: 'set', zh: inferred })}>仍用推断"{inferred}"</B>}
      </div>
      {pl.preSelected && <div className="small faint" style={{ marginTop: 6 }}>建议译名：“{pl.preSelected}”。请你核对原文后确认，也可以修改译名。</div>}
      </>; break;
    }
    case 'glossary-deviation':
      helpText = 'AI翻译时没用术语表里确认的译名，而是用了另一个译法。可能是这里有特殊含义（一词多义），也可能是AI翻错了。你可以接受这次偏离、新增义项，或者改回术语表的译名重新翻译。';
      body = <>
      <div className="small">术语表：<b>{pl.glossaryZh}</b> → 此处：<b>{pl.usedZh}</b>（{Number(pl.confidence).toFixed(2)}）<br />{pl.rationale}</div>
      <div className="btn-group" style={{ marginTop: 8 }}><B primary onClick={() => decide({ action: 'accept-here' })}>接受本处</B><B onClick={() => decide({ action: 'add-sense', contextHint: null })}>新增义项 "{pl.usedZh}"</B><B onClick={() => decide({ action: 'revert' })}>改回 "{pl.glossaryZh}" 并重译</B></div></>; break;
    case 'stale-knowledge':
      if (pl.subtype === 'character-field') {
        const labels: Record<string, string> = { gender: '性别', first_person_type: '一人称', speech_register: '语域', voice_notes: '声音说明', plurality: '人数' };
        const verdicts: Record<string, string> = { 'supported-change': '原文支持阶段变化', equivalent: '前后可能同义', compatible: '本处表达与原有声线兼容', 'local-register':'仅本处语域，不替换长期值', unsupported: '新判断缺少支持', uncertain: '证据尚不充分' };
        const display = (v: any) => typeof v === 'object' && v ? String(v.gender ?? '未知') : String(v ?? '未知');
        helpText = '前后不一致不等于人物设定变了。请核对说话人、情境和时间；原记录会保留到你做决定。继续处理时，原文明确标明说话人和一人称、且单独检查通过的阶段变化会自动采纳；其他情况会让你确认。采纳只修改这个字段，从证据位置开始生效，可以在人物页撤销。';
        body = <>
          <div>{pl.characterName} · {labels[pl.field] ?? pl.field}</div>
          <div className="small">原记录：{display(pl.before)} → 新发现：{display(pl.proposed)}（第 {pl.at} 段起）</div>
          {(pl.sources ?? []).map((s: any) => <blockquote key={s.id} className="small">第 {s.at} 段：{s.text}</blockquote>)}
          {pl.evidenceReview ? <div className="small">独立检查：{verdicts[pl.evidenceReview.verdict]}。{pl.evidenceReview.reason}（供决定参考）</div> : <div className="small faint">{pl.evidenceReviewNote ?? '还没有独立检查；继续处理本册会尝试补充检查。'}</div>}
          <div className="small faint">{pl.autoSuppressed ? '你已撤销过自动决定，这个不会再次自动采纳。' : ''}</div><div className="btn-group" style={{ marginTop: 8 }}><B primary onClick={() => decide({ action: 'accept' })}>从此处采纳新字段</B><B onClick={() => decide({ action: 'reject' })}>拒绝，保留原记录</B></div>
        </>; break;
      }
      if (pl.entityType === 'character') {
        const receipt = pl.automaticCharacterInvalidationReview as { review?: { reason?: string }; reason?: string } | undefined;
        const reason = receipt?.review?.reason ?? receipt?.reason;
        helpText = '人物认识、职业或经历发生变化，不等于整个人物档案应停用。请核对原文证据；只有确认人物本身不应继续参与作品时才停用。停用会从证据位置起停用整个人物档案。';
        body = <>
          <div className="small">{pl.description}</div>
          {reason && <div className="small">核对理由：{reason}</div>}
          <div className="btn-group" style={{ marginTop: 8 }}><B primary onClick={() => decide({ action: 'accept' })}>停用人物档案</B><B onClick={() => decide({ action: 'reject' })}>保留人物档案</B></div>
        </>; break;
      }
      helpText = '全书检查发现某个已记录的信息可能过时了或前后矛盾。你判断一下是真的过时了需要标记失效，还是误报需要保留。';
      body = <><div className="small">{pl.description}</div><div className="btn-group" style={{ marginTop: 8 }}><B primary onClick={() => decide({ action: 'accept' })}>标记失效</B><B onClick={() => decide({ action: 'reject' })}>保留</B></div></>; break;
    case 'warning':
      helpText = '发现一个不影响导出的问题，提醒你注意一下。确认「知道了」后可以继续。';
      body = <>{pl.note && (needsDiagnosticSummary(String(pl.note)) ? <DiagnosticDetails value={pl.note} /> : <div className="small" style={{ marginBottom: 8 }}>{String(pl.note)}</div>)}<div className="btn-group"><B onClick={() => decide({ action: 'dismiss' })}>知道了 / 忽略</B></div></>; break;
  }

  // AI推荐指示器
  const aiRec = reviewRecommendation(item);
  let aiIndicator: ReactNode = null;
  if (aiRec) {
    const isHighConf = aiRec.confidence >= 0.7;
    if (aiRec.action === 'accept' && isHighConf) {
      aiIndicator = (
        <div style={{ background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.3)', borderRadius: 4, padding: '6px 8px', marginBottom: 8, fontSize: '0.9em' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <CheckCircle size={14} style={{ color: '#22c55e' }} />
            <span style={{ color: '#22c55e', fontWeight: 500 }}>AI推荐接受</span>
            <span style={{ color: 'var(--color-text-muted)', fontSize: '0.9em' }}>置信度 {(aiRec.confidence * 100).toFixed(0)}%</span>
          </div>
          <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.9em' }}>{aiRec.reason}</div>
        </div>
      );
    } else if (aiRec.action === 'reject') {
      aiIndicator = (
        <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 4, padding: '6px 8px', marginBottom: 8, fontSize: '0.9em' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <XCircle size={14} style={{ color: '#ef4444' }} />
            <span style={{ color: '#ef4444', fontWeight: 500 }}>AI推荐拒绝</span>
            <span style={{ color: 'var(--color-text-muted)', fontSize: '0.9em' }}>置信度 {(aiRec.confidence * 100).toFixed(0)}%</span>
          </div>
          <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.9em' }}>{aiRec.reason}</div>
        </div>
      );
    } else {
      aiIndicator = (
        <div style={{ background: 'rgba(234, 179, 8, 0.1)', border: '1px solid rgba(234, 179, 8, 0.3)', borderRadius: 4, padding: '6px 8px', marginBottom: 8, fontSize: '0.9em' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <AlertCircle size={14} style={{ color: '#eab308' }} />
            <span style={{ color: '#eab308', fontWeight: 500 }}>AI不确定</span>
            <span style={{ color: 'var(--color-text-muted)', fontSize: '0.9em' }}>置信度 {(aiRec.confidence * 100).toFixed(0)}%</span>
          </div>
          <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.9em' }}>{aiRec.reason}</div>
        </div>
      );
    }
  }

  return (
    <Ctx.Provider value={{ busy: busy || (item.kind !== 'review-block' && conflict), pick, setPick, custom, setCustom, commitCustom }}>
      <div className={`queue-item${active ? ' active' : ''}`} onClick={onSelect} tabIndex={onSelect ? 0 : undefined} onKeyDown={e => { if (e.target === e.currentTarget && onSelect && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(); } }}>
        <div className="head"><Pill kind={KIND_PILL[item.kind]}>{REVIEW_KIND_LABELS[item.kind]}</Pill><span className="loc">{item.chapterLabel ?? ''}</span><span className="title grow ellipsis" title={reviewDisplayTitle(item)}>{reviewDisplayTitle(item)}</span></div>
        {!compact && <ReviewEvidence paragraphId={item.paragraphId} />}
        {item.kind === 'review-block' ? <>{draft.error && <p role="alert">{draft.error}</p>}{draft.stored && !draft.error && <span className="small muted">输入已暂存；需提交后才写入正式稿或知识</span>}</> : <DraftStatus draft={combinedDraft} />}
        {canPreselect && (preselectError || (selection.stored && chosen && chosen !== preSelected && chosen !== acknowledged)) && <div role="alert" className="notice small">
          {preselectError || '本地选择尚未确认写入预选；批量确认可能使用旧预选。'}
          <button className="btn btn-secondary btn-sm" disabled={busy || conflict || !chosen} onClick={() => { if (chosen) persistPreselect(chosen); }}>重试写入预选</button>
        </div>}
        {aiIndicator}
        {aiRec && <p className="small muted">仅为 AI 推荐，尚未正式采纳；质量阻断须完整复核。</p>}
        {typeof pl.scopedOperationFailure?.message === 'string' && <div role="alert"><p>最近操作未完成，此项仍需处理。</p><DiagnosticDetails value={pl.scopedOperationFailure} label="查看操作详情" /></div>}
        {pl.repairFailure && typeof pl.repairFailure.message === 'string' && <div role="status" className="small" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginBottom: 8 }}>
          <strong>最近一次自动修复未完成</strong>{typeof pl.repairFailure.finalVersion === 'number' ? `（第${pl.repairFailure.finalVersion}版原稿保留）` : '，原稿保留'}
          <DiagnosticDetails value={pl.repairFailure} label="查看修复详情" />
          <div className="muted">可对照原文处理；若已达到尝试上限，可在本册任务区选择“允许再次修复”。</div>
        </div>}
        {helpText && <div className="help-text" style={{ fontSize: '0.9em', color: 'var(--color-text-muted)', marginBottom: 8, lineHeight: 1.5 }}>{helpText}</div>}
        <ReviewItemDiagnostics item={item} />
        {!compact && pl.source && <div className="src"><MarkedText text={String(pl.source)} /></div>}
        {!compact && pl.translation && <div className="zh"><MarkedText text={String(pl.translation)} /></div>}
        <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>{body}</fieldset>
      </div>
    </Ctx.Provider>
  );
}
