import { useDraft } from '../../store/useDraft';
import { draftIdentity } from '../../store/draftIdentityBridge';
import { TaskOverview } from './TaskOverview';
import { DeliveryCommand } from './DeliveryCommand';
import '../../styles/workbench.css';
import { SeriesExportDialog } from './SeriesExportDialog';
import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react';
import { useApp, tryApi } from '../../store/app';
import { api } from '../../api';
import { MarkedText, Pill, Modal, Progress, Switch } from '../../components/ui';
import { Download, Settings2, ChevronsLeft, ChevronsRight, Play, CheckCheck, ListTree } from 'lucide-react';
import type { ChapterSummary, ParagraphView, QualityGateReport, ExportResult, CharacterView, TermView, ReviewItemView } from '@shared/types';
import type { PrepStatus, ParagraphAnalysisView, VolumeRunState, SeriesRunState } from '@shared/ipc';
import { ReviewCard } from '../review/ReviewCard';

type PageScope = 'chapter' | 'volume';
type StatusFilter = 'all' | 'untranslated' | 'translating' | 'needsReview' | 'confirmed';

/** 段落状态分类：用于状态筛选 chips 与卡片着色 */
function paraStatus(p: ParagraphView, running: boolean): StatusFilter {
  if (running) return 'translating';
  if (!p.final) return 'untranslated';
  if (p.audit !== 'valid' || p.blocking || p.openFindings > 0) return 'needsReview';
  if (p.final.confirmed || p.final.autoAccepted) return 'confirmed';
  return 'needsReview'; // 有待确认的 final → 待人工
}
const STATUS_LABEL: Record<StatusFilter, string> = {
  all: '全部', untranslated: '未开始', translating: '进行中', needsReview: '需要处理', confirmed: '已通过检查',
};

export function WorkbenchPage() {
  const { currentSeriesId, currentVolumeId, currentChapterId, selectChapter, paragraphTarget, rev, progress, series, toast } = useApp();
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  const [paras, setParas] = useState<ParagraphView[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [readingMode, setReadingMode] = useState(false);
  const [chapterOpen, setChapterOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildMessage, setRebuildMessage] = useState('');
  useEffect(() => { setRebuildMessage(''); }, [currentVolumeId]);
  const [overviewVolume, setOverviewVolume] = useState<string | null>(null);
  const [sideOpen, setSideOpen] = useState(false);
  useEffect(() => { setOverviewVolume(null); setToolsOpen(false); setSideOpen(false); }, [currentSeriesId]);
  const [prep, setPrep] = useState<PrepStatus | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [seriesExportOpen, setSeriesExportOpen] = useState(false);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [repairs, setRepairs] = useState({ queued: 0, failed: 0 });
  useEffect(() => { let active = true; void api.workflow.pendingRepairs().then(r => { if (active) setRepairs(r); }).catch(() => {}); return () => { active = false; }; }, [rev.queue, progress.running]);
  const [prepOpen, setPrepOpen] = useState(false);
  const [volumeRun, setVolumeRun] = useState<VolumeRunState | null>(null);
  const [seriesRun, setSeriesRun] = useState<SeriesRunState | null>(null);
  useEffect(() => { let active = true; setSeriesRun(null); if (currentSeriesId) void api.workflow.seriesRunState(currentSeriesId).then(r => { if (active) setSeriesRun(r); }).catch(() => {}); return () => { active = false; }; }, [currentSeriesId, progress.running]);
  useEffect(() => { let active = true; setVolumeRun(null); if (currentVolumeId) void api.workflow.volumeRunState(currentVolumeId).then(r => { if (active) setVolumeRun(r); }).catch(() => {}); return () => { active = false; }; }, [currentVolumeId, progress.running]);
  const [page, setPage] = useState<PageScope>('chapter');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const unitsRef = useRef<HTMLDivElement>(null);
  const vol = series.find(s => s.id === currentSeriesId)?.volumes.find(v => v.id === currentVolumeId);

  useEffect(() => {
    let active = true;
    if (!currentVolumeId) return;
    void api.project.listChapters(currentVolumeId).then(ch => { if (!active) return; setChapters(ch); if (!currentChapterId || !ch.some(c => c.id === currentChapterId)) selectChapter(ch[0]?.id ?? null); }).catch(e => { if (active) toast('error', (e as Error).message); });
    void api.project.prepStatus(currentVolumeId).then(p => { if (active) setPrep(p); }).catch(() => {});
    return () => { active = false; };
  }, [currentVolumeId, currentChapterId, rev.paragraphs, rev.series, rev.knowledge, rev.glossary, rev.queue]);
  useEffect(() => { setParas([]); setCurrent(null); setEditing(null); }, [currentVolumeId, currentChapterId, page]);
  // 切册／切章时拒绝较早请求的迟到响应。
  useEffect(() => {
    let active = true;
    if (!currentVolumeId || (page === 'chapter' && !currentChapterId)) return;
    const request = page === 'volume' ? api.project.listParagraphsByVolume(currentVolumeId) : api.project.listParagraphs(currentChapterId!);
    void request.then(p => { if (active) setParas(p); }).catch(e => { if (active) toast('error', (e as Error).message); });
    return () => { active = false; };
  }, [currentVolumeId, currentChapterId, page, rev.paragraphs, rev.knowledge, rev.glossary, rev.settings, rev.queue]);
  useEffect(() => {
    if (!paragraphTarget) return;
    setStatusFilter('all'); setCurrent(paragraphTarget);
    const frame = requestAnimationFrame(() => { const element = document.getElementById(`u-${paragraphTarget}`); if (element) { element.scrollIntoView({ block: 'center' }); useApp.setState({ paragraphTarget: null }); } });
    return () => cancelAnimationFrame(frame);
  }, [paragraphTarget, paras]);
  // 翻译进行中：跟随当前段落
  useEffect(() => { if (progress.running && progress.currentParagraphId && paras.some(p => p.id === progress.currentParagraphId)) { void api.project.getParagraph(progress.currentParagraphId).then(v => v && setParas(ps => ps.map(p => p.id === v.id ? v : p))); } }, [progress.done]);

  // 按状态过滤
  const filtered = useMemo(() => statusFilter === 'all' ? paras : paras.filter(p => paraStatus(p, false) === statusFilter), [paras, statusFilter]);
  const statusCounts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: paras.length, untranslated: 0, translating: 0, needsReview: 0, confirmed: 0 };
    for (const p of paras) c[paraStatus(p, false)]++;
    return c;
  }, [paras]);
  const chapterIds = useMemo(() => paras.map(p => p.id), [paras]);
  const pendingIdx = useMemo(() => paras.map((p, i) => paraStatus(p, false) !== 'confirmed' ? i : -1).filter(i => i >= 0), [paras]);
  const jumpPending = useCallback((dir: 1 | -1) => {
    const ci = paras.findIndex(p => p.id === current);
    const next = dir > 0 ? pendingIdx.find(i => i > ci) : [...pendingIdx].reverse().find(i => i < ci);
    if (next != null) { setCurrent(paras[next]!.id); document.getElementById(`u-${paras[next]!.id}`)?.scrollIntoView({ block: 'center' }); }
  }, [paras, current, pendingIdx]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement)?.tagName === 'TEXTAREA' || (e.target as HTMLElement)?.tagName === 'INPUT') { if (e.key === 'Escape') setEditing(null); return; }
      if (e.ctrlKey && e.key === 'Enter' && current) { e.preventDefault(); void tryApi(() => api.translation.confirm([current])); }
      else if (e.ctrlKey && e.key.toLowerCase() === 'e' && current) { e.preventDefault(); setEditing(current); }
      else if (e.ctrlKey && e.key === ']') { e.preventDefault(); jumpPending(1); }
      else if (e.ctrlKey && e.key === '[') { e.preventDefault(); jumpPending(-1); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [current, jumpPending]);

  if (!currentVolumeId || !vol) return <div className="empty"><h2>请先在书架选择一册</h2></div>;
  const ch = chapters.find(c => c.id === currentChapterId);
  const untranslated = paras.filter(p => !p.final).length;
  const scenesDone = prep && prep.total > 0 && prep.scenesAnalyzed >= prep.total;
  const prepReady = !!prep && prep.preRead && prep.termsExtracted && scenesDone;
  // 未完成的预处理步骤（用作按钮提示 + 引导）
  const missing: string[] = [];
  if (prep && !prep.preRead) missing.push('预读');
  if (prep && !prep.termsExtracted) missing.push('术语');
  if (prep && !scenesDone) missing.push('场景');
  const prepLabel = missing.length ? `预处理 ${missing.join(' ')}` : '预处理';

  return (
    <>
      <header className="reader-heading">
        <div className="reader-heading-copy"><span className="reader-eyebrow">第 {vol.volumeNumber} 册 · 翻译与阅读</span><h1>{page === 'volume' ? (vol.title ?? '全册连读') : (ch?.title ?? vol.title ?? '正文')}</h1></div>
        <button className="btn btn-secondary btn-sm" onClick={() => setToolsOpen(true)}>更多操作</button>
      </header>
      {currentSeriesId && <DeliveryCommand key={currentSeriesId} seriesId={currentSeriesId} onSetup={() => setDeliveryOpen(true)} onDetails={id => setOverviewVolume(id ?? currentVolumeId)} />}
      <div className="reader-toolbar" aria-label="阅读显示设置">
        <button className="btn btn-secondary btn-sm" aria-expanded={chapterOpen} onClick={() => setChapterOpen(o => !o)}><ListTree size={15} />目录</button>
        <div className="page-toggle" role="group" aria-label="阅读范围"><button className={'pt-item'+(page === 'chapter' ? ' on' : '')} aria-pressed={page === 'chapter'} onClick={() => { setPage('chapter'); unitsRef.current?.scrollTo(0, 0); }}>当前章</button><button className={'pt-item'+(page === 'volume' ? ' on' : '')} aria-pressed={page === 'volume'} onClick={() => { setPage('volume'); unitsRef.current?.scrollTo(0, 0); }}>全册连读</button></div>
        <label className="reader-chapter-select"><span className="sr-only">章节</span><select className="input" aria-label="章节" value={page === 'volume' ? '' : currentChapterId ?? ''} onChange={e => { if (page === 'volume') { document.getElementById(`reader-chapter-${e.target.value}`)?.scrollIntoView({ block: 'start', behavior: 'instant' }); } else { selectChapter(e.target.value); unitsRef.current?.scrollTo(0, 0); } }}>{page === 'volume' && <option value="" disabled>全册连读 · 跳转到章节…</option>}{chapters.map(c => <option key={c.id} value={c.id}>{c.title ?? '无标题'}</option>)}</select></label>
        <div className="page-toggle" role="group" aria-label="阅读方式"><button className={'pt-item'+(!readingMode ? ' on' : '')} aria-pressed={!readingMode} onClick={() => setReadingMode(false)}>日中对照</button><button className={'pt-item'+(readingMode ? ' on' : '')} aria-pressed={readingMode} onClick={() => setReadingMode(true)}>只读中文</button></div>
        <label className="reader-filter"><span className="sr-only">段落筛选</span><select className="input" aria-label="段落筛选" value={statusFilter} onChange={e => setStatusFilter(e.target.value as StatusFilter)}>{(Object.keys(STATUS_LABEL) as StatusFilter[]).filter(k => k !== 'translating').map(k => <option key={k} value={k}>{STATUS_LABEL[k]} {statusCounts[k]}</option>)}</select></label>
      </div>
      <div className={'workbench reader-workbench side-collapsed'+(chapterOpen ? ' with-directory' : '')+(readingMode ? ' reading-mode' : ' comparison-mode')}>
        {chapterOpen && <aside className="chapters" aria-label="章节目录"><div className="directory-heading"><strong>章节目录</strong><button className="btn btn-text btn-sm" onClick={() => setChapterOpen(false)}>收起</button></div>{chapters.map(c => <button key={c.id} className={'chapter-item'+(page === 'chapter' && c.id === currentChapterId ? ' active' : '')} onClick={() => { if (page === 'volume') { document.getElementById(`reader-chapter-${c.id}`)?.scrollIntoView({ block: 'start', behavior: 'instant' }); } else { selectChapter(c.id); unitsRef.current?.scrollTo(0, 0); } }}><span className="n">{c.title ?? '第 '+c.chapterNumber+' 章'}</span><span className="c">{c.confirmedCount}/{c.paragraphCount}</span></button>)}</aside>}
        <div className="units" ref={unitsRef}>
          {!readingMode && <div className="comparison-heading"><span>日文原文</span><span>中文译文</span></div>}
          {readingMode && !paras.some(p => p.final) && <p className="reader-empty-note">当前阅读范围还没有译文，先显示日文原文。开始翻译后，中文会出现在这里。</p>}
          {filtered.length === 0 && <div className="empty"><p className="muted">{paras.length === 0 ? (page === 'chapter' ? '本章没有段落' : '全册没有段落') : '没有符合该状态的段落'}</p></div>}
          {page === 'chapter' ? (
            filtered.map(p => <Unit key={p.id} readingMode={readingMode} p={p} isCurrent={p.id === current} isEditing={editing === p.id} onSelect={() => setCurrent(p.id)} onEdit={() => setEditing(p.id)} onEditDone={() => setEditing(null)} running={progress.running && progress.currentParagraphId === p.id} />)
          ) : (
            chapters.map(c => {
              const group = filtered.filter(p => p.chapterId === c.id);
              if (group.length === 0) return null;
              return (
                <div key={c.id} id={`reader-chapter-${c.id}`} className="unit-group">
                  <div className="unit-group-head" onClick={() => { selectChapter(c.id); setPage('chapter'); setCurrent(null); unitsRef.current?.scrollTo(0, 0); }}>
                    <span className="unit-group-title">{c.title ?? `第 ${c.chapterNumber} 章`}</span>
                    <span className="small muted">{group.length} 段</span>
                    <span className="grow" />
                    <span className="small faint">切到本章</span>
                  </div>
                  {group.map(p => <Unit key={p.id} readingMode={readingMode} p={p} isCurrent={p.id === current} isEditing={editing === p.id} onSelect={() => setCurrent(p.id)} onEdit={() => setEditing(p.id)} onEditDone={() => setEditing(null)} running={progress.running && progress.currentParagraphId === p.id} />)}
                </div>
              );
            })
          )}

        </div>

      </div>
      {overviewVolume && <Modal title="任务详情" width={760} onClose={() => setOverviewVolume(null)}><TaskOverview volumeId={overviewVolume} onNavigate={() => setOverviewVolume(null)} /></Modal>}
      {toolsOpen && <Modal title="更多操作" width={700} onClose={() => setToolsOpen(false)}><p className="muted small">日常只需“开始翻译”。以下操作供单独检查、修复或另存文件时使用。</p><div className="reader-tools-grid">
        <button className={`btn btn-sm${prep && missing.length ? ' btn-primary' : ' btn-secondary'}`} onClick={() => { setToolsOpen(false); setPrepOpen(true); }} title={prep && missing.length ? `尚未完成：${missing.join(' ')}` : '预处理'}><Settings2 size={13} /> {prepLabel}{prep && missing.length > 0 && <span className="badge" style={{ marginLeft: 4, background: 'var(--status-warning)' }}>{missing.length}</span>}</button>
        <button className="btn btn-secondary btn-sm" disabled={progress.running || !ch} title={!prepReady ? '建议先完成预处理（预读、术语、场景），译者知识与场景归属会让译文更准' : undefined} onClick={() => { if (!prepReady) { setToolsOpen(false); setPrepOpen(true); return; } void tryApi(() => api.workflow.translate({ chapterId: currentChapterId! })); }}><Play size={13} /> 翻译本章{untranslated ? `（${untranslated} 段）` : ''}</button>
        <button className="btn btn-secondary btn-sm" disabled={progress.running} title={!prepReady ? '建议先完成预处理' : undefined} onClick={() => { if (!prepReady) { setToolsOpen(false); setPrepOpen(true); return; } void tryApi(() => api.workflow.translate({ volumeId: currentVolumeId })); }}>翻译全册</button>
        {repairs.queued > 0 && <button className="btn btn-secondary btn-sm" disabled={progress.running} onClick={() => void tryApi(() => api.workflow.resumeRepairs())}>继续所有作品待办（{repairs.queued}）</button>}
        {repairs.failed > 0 && <span className="small muted">{repairs.failed} 项重译未完成，请到待处理列表查看</span>}
        <button className="btn btn-secondary btn-sm" disabled={progress.running || !vol?.translatedCount} onClick={() => void tryApi(() => api.translation.reverifyVolume(currentVolumeId)).then(r => { if (r) toast(r.pending ? 'warning' : 'success', `检查完成：${r.passed} 段通过，${r.pending} 段需要处理`); })}>补做本册待检查的稿件</button>
        <button className="btn btn-secondary btn-sm" disabled={progress.running} onClick={() => void tryApi(() => api.workflow.continueVolume(currentVolumeId)).then(r => { if (r) { setVolumeRun(r); toast(r.status === 'done' ? 'success' : 'info', r.message); } })}>{volumeRun && volumeRun.status !== 'done' ? '继续处理本册' : '连续处理本册'}</button>
        {currentSeriesId && <><button className="btn btn-secondary btn-sm" disabled={progress.running} title="按册号从前往后处理全部已导入册，复用有效稿件；遇未解决问题停止，不跳过前册" onClick={() => void tryApi(() => api.workflow.continueSeries(currentSeriesId)).then(r => { if (r) { if (useApp.getState().currentSeriesId === r.seriesId) setSeriesRun(r); toast(r.status === 'done' ? 'success' : 'info', r.message); } })}>连续处理全部册</button></>}

        {vol.fileKind === 'epub' && <button className="btn btn-secondary btn-sm" disabled={progress.running || rebuilding} onClick={async () => {
          const scope = draftIdentity.snapshot().token; const volumeId = currentVolumeId;
          setRebuilding(true); setRebuildMessage('正在核对原书目录…');
          try {
            const result = await api.project.rebuildEpubChapters(volumeId);
            if (!draftIdentity.isCurrent(scope) || useApp.getState().currentVolumeId !== volumeId) return;
            setRebuildMessage(result.changed ? `目录已整理：${result.beforeChapters} 组 → ${result.afterChapters} 组，保留 ${result.paragraphs} 段及已有译稿。备份：${result.backupPath}` : '目录已与原书一致，无需修改。');
          } catch (error) { if (draftIdentity.isCurrent(scope) && useApp.getState().currentVolumeId === volumeId) setRebuildMessage(`目录整理未完成：${(error as Error).message}`); }
          finally { setRebuilding(false); }
        }}>{rebuilding ? '正在整理目录…' : '按原书修复目录'}</button>}
        {vol.fileKind === 'epub' && <p className="small muted">旧版导入的章节不对时使用；修改前自动备份，保留已有译稿。不会调用 AI。</p>}
        {rebuildMessage && <p className="small" role="status" style={{ overflowWrap: 'anywhere' }}>{rebuildMessage}</p>}
        <button className="btn btn-secondary btn-sm" onClick={() => { setToolsOpen(false); setExportOpen(true); }}><Download size={13} />单独导出本册</button>
        <button className="btn btn-secondary btn-sm" onClick={() => { setToolsOpen(false); setSeriesExportOpen(true); }}>导出全部册</button>
        <button className="btn btn-secondary btn-sm" onClick={() => { setToolsOpen(false); setSideOpen(true); }}>查看段落检查详情</button>
        <button className="btn btn-secondary btn-sm" onClick={() => { setPage(page === 'volume' ? 'chapter' : 'volume'); setToolsOpen(false); }}>{page === 'volume' ? '仅查看当前章' : '连续查看全册'}</button>
      </div></Modal>}
      {sideOpen && <Modal title="段落检查详情" width={800} onClose={() => setSideOpen(false)}><SidePanel current={paras.find(p => p.id === current) ?? null} chapterIds={chapterIds} /></Modal>}
      {exportOpen && <ExportDialog volumeId={currentVolumeId} title={`${series.find(s => s.id === currentSeriesId)?.title ?? ''} 第${String(vol.volumeNumber).padStart(2, '0')}册`} onClose={() => setExportOpen(false)} />}
      {deliveryOpen && currentSeriesId && <SeriesExportDialog key={`delivery-${currentSeriesId}`} seriesId={currentSeriesId} autoProcess onClose={() => setDeliveryOpen(false)} />}
      {seriesExportOpen && currentSeriesId && <SeriesExportDialog seriesId={currentSeriesId} onClose={() => setSeriesExportOpen(false)} />}
      {prepOpen && prep && <PrepDialog volumeId={currentVolumeId} seriesId={currentSeriesId!} prep={prep} onClose={() => setPrepOpen(false)} />}
    </>
  );
}

function Unit({ p, isCurrent, isEditing, onSelect, onEdit, onEditDone, running, readingMode }: { readingMode: boolean; p: ParagraphView; isCurrent: boolean; isEditing: boolean; onSelect: () => void; onEdit: () => void; onEditDone: () => void; running: boolean }) {
  const draft = useDraft(`draft-paragraph-${p.id}`, p.final?.text ?? p.latestCandidate?.text ?? '', { version: p.final?.version ?? 0, sourceText: p.sourceText });
  const text = draft.text; const setText = draft.change;
  const flagged = (p.final && p.audit !== 'valid') || p.openFindings > 0 || (p.final && !p.final.confirmed && !p.final.autoAccepted);
  const cls = ['unit', isCurrent && 'current', isEditing && 'editing', p.blocking ? 'blocked flagged' : (flagged && p.final ? 'flagged' : '')].filter(Boolean).join(' ');
  const [saving, setSaving] = useState(false);
  const save = async (confirm: boolean): Promise<void> => {
    if (saving || draft.conflict || !draft.base) return;
    setSaving(true);
    try { const result = await tryApi(() => api.translation.editFinal(p.id, text, confirm, draft.base!)); if (result) { draft.clear(); onEditDone(); } }
    finally { setSaving(false); }
  };
  return (
    <div id={`u-${p.id}`} className={cls} onClick={onSelect}>
      <div className="unit-meta">
        <span>§{p.paraOrdinal}</span><span>{p.paragraphType === 'dialogue' ? '对话' : p.paragraphType === 'narration' ? '叙述' : '混合'}</span>
        {p.analysis?.speakerName && <span>说话人：{p.analysis.speakerName}{p.analysis.speakerConfidence != null && p.analysis.speakerConfidence < 0.8 ? ` (${p.analysis.speakerConfidence.toFixed(2)})` : ''}</span>}

        <span className="grow" />
        {running && <Pill kind="info"><span className="spinner" style={{ marginRight: 4 }} />翻译中</Pill>}
        {p.final?.confirmed && <Pill kind="muted">人工已采纳</Pill>}
        {p.final?.autoAccepted && !p.final.confirmed && <Pill kind="muted">{p.audit === 'valid' ? '已自动采纳' : '曾自动采纳'}</Pill>}
        {p.final && <Pill kind={p.audit === 'valid' ? 'info' : 'warning'}>{p.audit === 'valid' ? '质量检查通过' : p.audit === 'stale' ? '检查已失效' : '还没检查'}</Pill>}
        {draft.stored && <Pill kind="warning">有本地草稿</Pill>}
        {p.blocking && <Pill kind="error">有问题 {p.openFindings}</Pill>}
        {!p.blocking && p.openFindings > 0 && <Pill kind="warning">提示 {p.openFindings}</Pill>}
      </div>
      <div className="unit-pair">{readingMode && p.final && !isEditing ? <details className="reader-source"><summary>查看对应日文</summary><div className="unit-jp"><MarkedText text={p.sourceText} /></div></details> : <div className="unit-jp" lang="ja"><MarkedText text={p.sourceText} /></div>}
      {isEditing ? (
        <div className="unit-zh">{draft.conflict && <div role="alert">原文或译稿已更新；旧草稿未覆盖新稿。请与上方原文及下方当前稿对照。<div><MarkedText text={p.final?.text ?? '尚无当前稿'} /></div><button className="btn btn-secondary btn-sm" disabled={saving} onClick={draft.rebase}>已对照，保留输入并以当前版本为基准</button></div>}{draft.error && <p role="alert">{draft.error}</p>}<textarea disabled={saving} value={text} onChange={e => setText(e.target.value)} autoFocus onKeyDown={e => { if (e.ctrlKey && e.key === 'Enter') void save(true); }} />
          <div className="row" style={{ marginTop: 8 }}><button className="btn btn-primary btn-sm" disabled={saving || draft.conflict} onClick={() => save(true)}>保存并确认</button><button className="btn btn-secondary btn-sm" disabled={saving || draft.conflict} onClick={() => save(false)}>仅保存</button><button className="btn btn-text btn-sm" disabled={saving} onClick={onEditDone}>收起并保留草稿</button><button className="btn btn-text btn-sm" disabled={saving} onClick={() => { draft.clear(); onEditDone(); }}>丢弃本地草稿</button><span className="small faint">本地草稿不参与导出，需先保存；保留 ⟦n⟧ 标记</span></div></div>
      ) : running ? <div className="unit-zh pending"><div className="skeleton" style={{ width: '80%' }} /><div className="skeleton" style={{ width: '55%', marginTop: 8 }} /></div>
        : p.final ? <div className={`unit-zh${p.final.confirmed ? ' confirmed' : ''}`} onDoubleClick={onEdit}><MarkedText text={p.final.text} />{p.final.notes?.map((note,index)=><p key={index} className="small muted" aria-label="译注">译注：{note}</p>)}</div>
        : <div className="unit-zh pending">{running ? '正在翻译…' : '译文将在翻译后显示'}</div>}
      </div>
      {!isEditing && (!!p.final || isCurrent) && (
        <details className="unit-options">
        <summary className="small muted">修改与检查</summary>
        <div className="unit-actions">
          {p.final && <button className="btn btn-text btn-sm" disabled={running} onClick={e => { e.stopPropagation(); void tryApi(() => api.translation.reverify(p.id)).then(r => { if (r) useApp.getState().toast(r.ok ? 'success' : 'warning', r.message); }); }}>重新检查</button>}
          {p.final && !p.final.confirmed && <button className="btn btn-text btn-sm" onClick={e => { e.stopPropagation(); void tryApi(() => api.translation.confirm([p.id])); }}>确认</button>}
          {p.final?.confirmed && <button className="btn btn-text btn-sm" onClick={e => { e.stopPropagation(); void tryApi(() => api.translation.unconfirm([p.id])); }}>取消确认</button>}
          <button className="btn btn-text btn-sm" onClick={e => { e.stopPropagation(); onEdit(); }}>编辑</button>
          <button className="btn btn-text btn-sm" onClick={e => { e.stopPropagation(); void tryApi(() => api.workflow.translate({ paragraphIds: [p.id] }, { forceFullReview: true })); }}>重译</button>
        </div>
        </details>
      )}
    </div>
  );
}

function SidePanel({ current, chapterIds }: { current: ParagraphView | null; chapterIds: string[] }) {
  const { currentSeriesId, rev } = useApp();
  const [tab, setTab] = useState<'scene' | 'audit' | 'chars' | 'terms' | 'queue'>('scene');
  const [analysis, setAnalysis] = useState<ParagraphAnalysisView | null>(null);
  const [findings, setFindings] = useState<Awaited<ReturnType<typeof api.translation.findings>>>([]);
  const [cands, setCands] = useState<Awaited<ReturnType<typeof api.translation.candidates>>>([]);
  const [chars, setChars] = useState<CharacterView[]>([]);
  const [terms, setTerms] = useState<TermView[]>([]);
  const [queue, setQueue] = useState<ReviewItemView[]>([]);
  useEffect(() => { if (!current) { setFindings([]); setCands([]); setAnalysis(null); return; } void api.translation.findings(current.id).then(setFindings); void api.translation.candidates(current.id).then(setCands); void api.project.analysis(current.id).then(setAnalysis); }, [current?.id, rev.paragraphs]);
  useEffect(() => { if (!currentSeriesId) return; void api.knowledge.characters(currentSeriesId).then(setChars); void api.glossary.list(currentSeriesId).then(setTerms); }, [currentSeriesId, rev.knowledge, rev.glossary]);
  useEffect(() => { if (!currentSeriesId) return; void api.review.list(currentSeriesId).then(q => setQueue(q.filter(i => i.paragraphId && chapterIds.includes(i.paragraphId)))); }, [currentSeriesId, rev.queue, chapterIds]);
  const src = current?.sourceText ?? '';
  const presentChars = chars.filter(c => src.includes(c.nameJp));
  const hitTerms = terms.filter(t => src.includes(t.termJp));
  const curQueue = queue.filter(q => q.paragraphId === current?.id);
  return (
    <aside className="side">
      <div className="tabs">
        {(['scene', 'audit', 'chars', 'terms', 'queue'] as const).map(t => <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>{{ scene: '场景', audit: '审计', chars: `人物${presentChars.length ? ` ${presentChars.length}` : ''}`, terms: `术语${hitTerms.length ? ` ${hitTerms.length}` : ''}`, queue: `待确认${queue.length ? ` ${queue.length}` : ''}` }[t]}</button>)}
      </div>
      <div className="side-body">
        {!current && tab !== 'queue' && <p className="faint small">点击一个段落查看</p>}
        {tab === 'scene' && current && (analysis
          ? <div className="side-item">
              <h4>场景分析结果 <span className="faint small">（③ 产出）</span></h4>
              <div className="small"><span className="muted">说话人：</span>{analysis.speakerName ?? <span className="faint">未识别</span>}{analysis.speakerConfidence != null && <span className="faint"> 置信度 {analysis.speakerConfidence.toFixed(2)}</span>}</div>
              <div className="small"><span className="muted">受话人：</span>{analysis.targets.length ? analysis.targets.join('、') : <span className="faint">—</span>}</div>
              <div className="small"><span className="muted">在场：</span>{analysis.present.length ? analysis.present.join('、') : <span className="faint">—</span>}</div>
              <div className="small"><span className="muted">意图：</span>{analysis.intent ?? <span className="faint">—</span>}</div>
              <div className="small"><span className="muted">难点信号：</span>{analysis.difficultyFlags.length ? analysis.difficultyFlags.map(f => <Pill key={f} kind="warning">{f}</Pill>) : <span className="faint">无</span>}</div>
              {current.paragraphType !== 'narration' && !analysis.speakerId && <div className="small faint" style={{ marginTop: 6 }}>对话段未识别到说话人：通常是该人物未建档。到人物页补建后重跑 ③。</div>}
            </div>
          : <p className="faint small">{current.paragraphType === 'narration' ? '叙述段' : '本段'}尚无场景分析结果。运行「预处理 → ③ 场景分析」后，这里会显示说话人 / 受话人 / 在场者 / 意图 / 难点信号。</p>)}
        {tab === 'audit' && current && <>
          {findings.length === 0 && <p className="faint small">没有未解决的检查问题</p>}
          {findings.map(f => <div key={f.id} className={`finding ${f.severity}`}><div><b>{f.type}</b> <span className="faint">{f.workstationId}</span></div><div>{f.description}</div>{f.evidenceJp && <div className="ev">JP: {f.evidenceJp}</div>}{f.evidenceZh && <div className="ev">ZH: {f.evidenceZh}</div>}{f.suggestedFix && <div className="ev">建议：{f.suggestedFix}</div>}</div>)}
          {cands.length > 0 && <><h4 className="small muted" style={{ margin: '12px 0 6px' }}>其他版本</h4>{cands.map((c, i) => <div key={i} className="side-item"><div className="small faint">{c.workstationId}</div><div style={{ fontFamily: 'var(--font-reading)' }}><MarkedText text={c.text} /></div></div>)}</>}
        </>}
        {tab === 'chars' && current && (presentChars.length === 0 ? <p className="faint small">本段未识别到已建档人物</p> : presentChars.map(c => <div key={c.id} className="side-item"><h4>{c.nameJp}{c.nameZh ? ` → ${c.nameZh}` : ''} {c.lockedByUser && <Pill kind="muted">锁定</Pill>}</h4><div className="small muted">性别 {c.gender ?? '未知'} · 一人称 {c.firstPersonType ?? '未知'} · 语域 {c.speechRegister ?? '未知'}</div>{c.voiceNotes && <div className="small">{c.voiceNotes}</div>}{c.quirkProfiles.filter(q => (q.confirmed_by_user || q.automatically_adopted) && q.locked_at_para <= current.seriesOrdinal).length > 0 && <div className="small">语癖：{c.quirkProfiles.filter(q => (q.confirmed_by_user || q.automatically_adopted) && q.locked_at_para <= current.seriesOrdinal).map(q => `${q.trigger_form}→${q.translation_pattern}`).join('；')}</div>}</div>))}
        {tab === 'terms' && current && (hitTerms.length === 0 ? <p className="faint small">本段未命中术语表</p> : hitTerms.map(t => <div key={t.id} className="side-item"><h4>{t.termJp} → {t.termZh ?? <span className="faint">未定</span>}</h4><div className="small muted">{t.termType} · {t.lockLevel === 'hard-locked' ? '硬锁定' : t.lockLevel === 'confirmed' ? '默认义' : '建议'}{t.senses.length > 1 && ` · 义项：${t.senses.map(s => s.senseZh).join(' / ')}`}</div></div>))}
        {tab === 'queue' && (queue.length === 0 ? <p className="faint small">本章没有待确认项</p> : (curQueue.length ? curQueue : queue).map(q => <ReviewCard key={q.id} item={q} compact />))}
      </div>
    </aside>
  );
}

type StepId = 'preread' | 'terms' | 'scene' | 'honorific';
const PREP_STEPS: { id: StepId; n: string; title: string; desc: string; phases: string[] }[] = [
  { id: 'preread', n: '1', title: '全书预读', desc: '逐章整理人物、关系、剧情和说话习惯，供后续翻译参考。结果可在“人物与关系”查看；不确定的知识会留给你确认。', phases: ['全书预读'] },
  { id: 'terms', n: '2', title: '专名提取与译名提案', desc: '找出人名、地名和作品专用词，提出中文译名。术语表保存用法，需要你决定的选项会出现在“需要处理”页。', phases: ['专名提取', '术语译名提案'] },
  { id: 'scene', n: '3', title: '场景分析', desc: '根据原文判断谁在说话、对谁说、当前发生了什么。点击工作台中的段落，可在检查面板查看结果；识别结果仍可能需要核对。', phases: ['场景分析'] },
  { id: 'honorific', n: '4', title: '称谓预扫描（可选）', desc: '利用人物和场景结果，提前找出君、酱、桑等称呼并生成中文选项，减少翻译途中停下确认的次数。没有发现称呼不一定是失败；未确定的用法仍会进入“需要处理”页。', phases: ['称谓预扫描'] },
];
/** 判断一个 phase 字符串属于哪个步骤（术语含两个 phase） */
const phaseOf = (phase: string): StepId | null => {
  if (phase === '全书预读') return 'preread';
  if (phase === '专名提取' || phase === '术语译名提案') return 'terms';
  if (phase === '场景分析') return 'scene';
  if (phase === '称谓预扫描') return 'honorific';
  return null;
};
function stepState(step: typeof PREP_STEPS[number], prep: PrepStatus, runningPhase: string | null): 'idle' | 'done' | 'running' | 'warn' {
  if (runningPhase && phaseOf(runningPhase) === step.id) return 'running';
  // 预读/术语：按章完成度。0 章 → 未运行；部分 → "部分"（重跑只补失败章）；全部 → 完成
  // 跨册：系列已有人物库但本册一章都没预读 → 也算"部分"，提醒跑本册
  if (step.id === 'preread') return prep.chapters > 0 && prep.prereadChapters >= prep.chapters ? 'done' : (prep.prereadChapters > 0 || prep.preRead) ? 'warn' : 'idle';
  if (step.id === 'terms') return prep.chapters > 0 && prep.termsChapters >= prep.chapters ? 'done' : (prep.termsChapters > 0 || prep.termsExtracted) ? 'warn' : 'idle';
  if (step.id === 'scene') return prep.total > 0 && prep.scenesAnalyzed >= prep.total ? 'done' : (prep.scenesAnalyzed > 0 ? 'warn' : 'idle');
  // ④：扫过（队列里有过称谓项或已有锁定轨迹）即视为完成；仍有待确认项则"部分"
  if (step.id === 'honorific') return prep.honorificsTotal === 0 && prep.addressesConfirmed === 0 ? 'idle' : prep.honorificsPending > 0 ? 'warn' : 'done';
  return 'idle';
}

function PrepDialog({ volumeId, seriesId, prep, onClose }: { volumeId: string; seriesId: string; prep: PrepStatus; onClose: () => void }) {
  const { progress, setPage, lastPhaseResult } = useApp();
  const [localizationStatus, setLocalizationStatus] = useState<{ needsLocalization: boolean; canLocalize: boolean; unlocalizedEvents: number; unlocalizedRelationships: number; confirmedTerms: number } | null>(null);
  const lastOf = (phases: string[]): string | null => { for (const ph of phases) if (lastPhaseResult[ph]) return lastPhaseResult[ph]!; return null; };
  // 当前正在跑的 phase（非 running 则为 null）
  const runningPhase = progress.running ? progress.phase : null;
  const go = (page: 'knowledge' | 'glossary' | 'review'): void => { onClose(); setPage(page); };
  const link = (to: 'knowledge' | 'glossary' | 'review', text: string): ReactNode => <button className="btn btn-text btn-sm" style={{ padding: '0 4px', height: 'auto' }} onClick={() => go(to)}>{text} →</button>;

  // 检查中文化状态
  useEffect(() => {
    let active = true;
    let generation = 0;
    const refresh = () => { const request = ++generation; void api.workflow.checkLocalizationStatus(seriesId).then(value => { if (active && generation === request) setLocalizationStatus(value); }).catch(err => {
      console.error('Failed to check localization status:', err);
      if (active && generation === request) setLocalizationStatus(null);
    }); };
    refresh();
    const unsubscribe = api.on('data-changed', scope => { if (scope === 'knowledge' || scope === 'glossary') refresh(); });
    return () => { active = false; unsubscribe(); };
  }, [seriesId, prep.preRead, prep.termsExtracted, progress.running, prep.events, prep.relationships, prep.terms]);
  // 每步的"结果"行：让用户看到这一步实际产出了什么，而不只是一个"已完成"徽标
  const resultOf = (id: StepId): ReactNode => {
    if (id === 'preread') {
      if (!prep.preRead) return <span className="faint">尚无结果。运行后会建立人物档案（性别/一人称/语域/声音备注/别名）、有向关系事件流、剧情时间线。</span>;
      return <>
        {prep.prereadChapters < prep.chapters && <span style={{ color: 'var(--status-warning)' }}>{prep.prereadChapters === 0 ? '本册尚未预读（以下是本系列已有的知识库，来自前几册）；运行本步补充本册人物/事件' : `已完成 ${prep.prereadChapters}/${prep.chapters} 章，「重新运行」只补未完成章`} ·</span>}
        <span>人物 <b>{prep.characters}</b>{prep.charactersNamed < prep.characters && <span className="faint">（{prep.characters - prep.charactersNamed} 人中文名待定，由 ② 术语提案确认后自动填入）</span>} · 关系事件 <b>{prep.relationships}</b> · 剧情事件 <b>{prep.events}</b></span>
        {link('knowledge', '人物档案')}
        {prep.quirksLocked > 0 && <span>· 已锁定语癖 <b>{prep.quirksLocked}</b></span>}
        {(prep.genderPending > 0 || prep.stalePending > 0 || prep.quirkPending > 0) && <span style={{ color: 'var(--accent-primary)' }}>· 需要你确认：{[prep.genderPending ? `性别推断 ${prep.genderPending}` : '', prep.quirkPending ? `语癖 ${prep.quirkPending}` : '', prep.stalePending ? `知识变化 ${prep.stalePending}` : ''].filter(Boolean).join('、')} {link('review', '待处理列表')}</span>}
      </>;
    }
    if (id === 'terms') {
      if (!prep.termsExtracted) return <span className="faint">尚无结果。运行后会提取专名并给出译名候选，候选进入复核队列等你确认。</span>;
      return <>
        {prep.termsChapters < prep.chapters && <span style={{ color: 'var(--status-warning)' }}>{prep.termsChapters === 0 ? '本册尚未提取（术语表来自前几册）；运行本步提取本册新专名' : `已完成 ${prep.termsChapters}/${prep.chapters} 章，「重新运行」只补未完成章`} ·</span>}
        <span>术语 <b>{prep.terms}</b>{prep.termsUndecided > 0 && <span className="faint">（{prep.termsUndecided} 条译名未定）</span>}</span>
        {link('glossary', '术语表')}
        {prep.termProposalsPending > 0 ? <span style={{ color: 'var(--accent-primary)' }}>· <b>{prep.termProposalsPending}</b> 项译名提案待你确认 {link('review', '复核队列')}</span> : prep.termsUndecided > 0 ? <span className="faint">· 未定译名没有待确认提案：重新运行本步可再提案，或到术语表手动填写</span> : <span className="faint">· 译名已全部确定</span>}
      </>;
    }
    if (id === 'honorific') {
      if (prep.honorificsTotal === 0 && prep.addressesConfirmed === 0) return <span className="faint">尚无结果。需先完成 ③（说话人）。运行后：发现的称呼组合进入复核队列，AI 候选已预选，你确认即锁定。</span>;
      return <>
        <span>已锁定称呼 <b>{prep.addressesConfirmed}</b> 条</span>{link('knowledge', '称呼轨迹')}
        {prep.honorificsPending > 0
          ? <span style={{ color: 'var(--accent-primary)' }}>· <b>{prep.honorificsPending}</b> 组称呼待你确认{prep.honorificsNeedingCandidates > 0 && <span className="faint">（{prep.honorificsNeedingCandidates} 组尚无候选，用下方「称谓解析」补生成）</span>} {link('review', '复核队列')}</span>
          : <span className="faint">· 队列中没有待确认的称呼</span>}
      </>;
    }
    // scene
    if (prep.scenesAnalyzed === 0) return <span className="faint">尚无结果。运行后每段会标注说话人、受话人、意图与难点信号，显示在工作台每段的元信息行。</span>;
    const pct = prep.dialogues ? Math.round(prep.speakersIdentified / prep.dialogues * 100) : 0;
    return <>
      <span>已分析 <b>{prep.scenesAnalyzed}</b>/{prep.total} 段 · 对话段 {prep.dialogues}，识别出说话人 <b>{prep.speakersIdentified}</b>{prep.dialogues > 0 && <span className={pct < 60 ? '' : 'faint'} style={pct < 60 ? { color: 'var(--status-warning)' } : undefined}>（{pct}%{pct < 60 ? '，偏低：通常是 ① 预读人物不全，补建人物后重跑本步' : ''}）</span>}</span>
      <span className="faint">· 在工作台段落元信息行查看"说话人：…"</span>
    </>;
  };
  const tools: { title: string; when: string; what: string; count: number; zero: string; run: () => Promise<unknown>; label: string }[] = [
    {
      title: '称谓解析', count: prep.honorificsNeedingCandidates,
      when: '翻译中/翻译后补漏。④ 预扫描已覆盖规则能识别的称呼；翻译时 AI 仍可能发现漏网的（如无名字的「先輩」「隊長」），会让你确认但没有中文选项。',
      what: '为这些还没选项的称谓批量生成中文选项并推荐，你确认后锁定。',
      zero: prep.translated === 0 ? '还没开始翻译，还没有称谓项' : '待处理列表里没有缺选项的称谓',
      run: () => api.workflow.resolveHonorifics(seriesId), label: '生成选项',
    },
    {
      title: '回查重译', count: prep.recheckPending,
      when: '翻译后。你锁定了某个术语/称呼/语癖时，之前已译但用法不同的段落会被标记"待回查"。',
      what: '用完整质量检查流程重译这些段落，使其与你的最新决定一致。重译后的段落会取消确认状态，需重新确认。',
      zero: prep.translated === 0 ? '尚未开始翻译，没有待回查段落' : '本册没有待回查段落',
      run: () => api.workflow.retranslateRechecks(volumeId), label: '重译回查段',
    },
  ];
  return (
    <Modal title="预处理（翻译前）" onClose={onClose} footer={<button className="btn btn-secondary" onClick={onClose}>关闭</button>}>
      <p className="small muted" style={{ marginTop: 0 }}>
        <b style={{ color: 'var(--accent-primary)' }}>通常不需要逐个点击这些步骤。</b>回到工作台，使用“自动处理并保存”，程序会按需要完成准备；这里用于单独检查和补做。
      </p>
      <p className="small muted">各步骤会调用 AI，耗时取决于书籍长度和接口响应，暂不提供固定时间估计。中断后先查看最近一次结果和日志；连接问题到设置中检查，知识问题到“需要处理”页核对，再继续本册。已有有效结果会尽量复用，修改原文或知识后可能需要重新检查。</p>

      {/* 一键预读到术语按钮 */}
      <div className="notice" style={{ marginBottom: 16, background: 'var(--bg-secondary)', padding: 12, borderRadius: 6 }}>
        <div className="row" style={{ alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500, marginBottom: 4 }}>一键预读到术语（仅准备）</div>
            <div className="small muted">依次运行预读、场景分析和术语提取，本按钮不会开始正文翻译。完成后查看“需要处理”中的译名选项。人物和剧情的中文摘要方便阅读；尚未补齐不代表不能翻译。</div>
          </div>
          <button
            className="btn btn-primary"
            disabled={progress.running}
            onClick={() => void tryApi(async () => {
              await api.workflow.preRead(volumeId);
              await api.workflow.analyzeScenes(volumeId);
              await api.workflow.extractTerms(volumeId);
            })}
          >
            一键执行
          </button>
        </div>
      </div>

      {/* 中文化预读数据按钮 */}
      {localizationStatus && localizationStatus.needsLocalization && (
        <div className="notice" style={{ marginBottom: 16, padding: 12, borderRadius: 6 }}>
          <div className="row" style={{ alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>中文资料说明（可选）</div>
              <div className="small">
                可将 {localizationStatus.unlocalizedEvents} 条剧情记录、{localizationStatus.unlocalizedRelationships} 条关系说明转为中文，方便查阅。正文翻译会自动使用已有原文资料。
              </div>
            </div>
            <button
              className="btn"
              disabled={progress.running || !localizationStatus.canLocalize}
              title="生成资料页的中文说明，需要额外模型调用"
              onClick={() => void tryApi(() => api.workflow.localizeNarrative(seriesId))}
            >
              生成中文资料说明
            </button>
          </div>
        </div>
      )}

      {localizationStatus && !localizationStatus.needsLocalization && localizationStatus.confirmedTerms > 0 && (
        <div className="notice small" style={{ marginBottom: 16, background: 'var(--status-success-bg)', padding: 8, borderRadius: 6, color: 'var(--status-success)' }}>
          ✓ 预读数据已中文化
        </div>
      )}
      {PREP_STEPS.map(step => {
        const state = stepState(step, prep, runningPhase);
        const isRunning = state === 'running';
        const isDone = state === 'done';
        const isWarn = state === 'warn';
        // 前置未完成时提示（预读→术语→场景，场景依赖预读的人物 ID）
        const needsPre = step.id === 'terms' && !prep.preRead;
        const needsTerm = step.id === 'scene' && !prep.preRead;
        const needsScene = step.id === 'honorific' && prep.scenesAnalyzed === 0;
        const hint = needsPre ? '建议先完成 ① 预读' : needsTerm ? '建议先完成 ① 预读（场景依赖人物档案）' : needsScene ? '需要先完成 ③ 场景分析（称呼要知道是谁说的）' : null;
        const runFn = step.id === 'preread' ? (() => api.workflow.preRead(volumeId)) : step.id === 'terms' ? (() => api.workflow.extractTerms(volumeId)) : step.id === 'scene' ? (() => api.workflow.analyzeScenes(volumeId)) : (() => api.workflow.prescanHonorifics(volumeId));
        return (
          <div key={step.id} className={`step${isRunning ? ' running' : ''}${isDone ? ' done' : ''}`}>
            <div className="step-num">{isDone ? '✓' : step.n}</div>
            <div className="step-body">
              <div className="step-title">{step.title}
                {isRunning && <span className="step-badge running"><span className="spinner" />运行中</span>}
                {isDone && <span className="step-badge done">已完成</span>}
                {isWarn && !isRunning && <span className="step-badge warn">部分</span>}
                {!isRunning && !isDone && !isWarn && <span className="step-badge idle">未运行</span>}
              </div>
              <div className="step-desc">{step.desc}</div>
              {isRunning && <div className="step-state">
                <span className="spinner" />
                <span>{progress.message}</span>
                {progress.total > 0 && <span className="step-progress"><Progress value={progress.done} max={progress.total} /></span>}
                <span className="small faint">{progress.done}/{progress.total}</span>
              </div>}
              <div className="step-result small">{resultOf(step.id)}{hint && !isRunning && <span className="faint">· {hint}</span>}</div>
              {!isRunning && lastOf(step.phases) && <div className="step-result small" style={/失败|中断|错误/.test(lastOf(step.phases)!) ? { color: 'var(--status-error)' } : undefined}>最近一次运行：{lastOf(step.phases)}</div>}
            </div>
            <div className="step-actions">
              {isRunning
                ? <button className="btn btn-primary btn-sm" disabled>运行中…</button>
                : <button className={`btn btn-sm ${step.id === 'honorific' ? 'btn-secondary' : 'btn-primary'}`} disabled={progress.running || needsScene} title={needsScene ? '需要先完成 ③ 场景分析' : undefined} onClick={() => void tryApi(runFn)}>{isDone || isWarn ? '重新运行' : '运行'}</button>}
            </div>
          </div>
        );
      })}
      <div style={{ height: 12 }} />
      <div className="small muted" style={{ marginBottom: 6 }}><b>翻译阶段工具</b>（翻译开始后才有对象；按钮显示当前可处理数量）</div>
      {tools.map(t => (
        <div key={t.title} className="step tool">
          <div className="step-num">◇</div>
          <div className="step-body">
            <div className="step-title" style={{ fontSize: 'var(--text-sm)' }}>{t.title}{t.count > 0 ? <span className="step-badge warn">{t.count} 项可处理</span> : <span className="step-badge idle">0 项</span>}</div>
            <div className="step-desc"><b>何时用：</b>{t.when}</div>
            <div className="step-desc"><b>做什么：</b>{t.what}</div>
            {t.count === 0 && <div className="step-result small faint">{t.zero}</div>}
          </div>
          <div className="step-actions"><button className="btn btn-secondary btn-sm" disabled={progress.running || t.count === 0} title={t.count === 0 ? t.zero : undefined} onClick={() => void tryApi(t.run)}>{t.label}</button></div>
        </div>
      ))}
    </Modal>
  );
}

function ExportDialog({ volumeId, title, onClose }: { volumeId: string; title: string; onClose: () => void }) {
  const { projectSettings, currentSeriesId, toast, rev } = useApp();
  const [gate, setGate] = useState<QualityGateReport | null>(null);
  const [mode, setMode] = useState<'zh' | 'bilingual'>('zh');
  const [result, setResult] = useState<ExportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const exportLock = useRef(false);
  useEffect(() => {
    let active = true; setGate(null);
    void tryApi(() => api.export.qualityGate(volumeId)).then(r => { if (active && r) setGate(r); });
    return () => { active = false; };
  }, [volumeId, rev.paragraphs, rev.series, rev.knowledge, rev.glossary, rev.queue, rev.settings, busy]);
  const run = async (preview: boolean): Promise<void> => {
    if (exportLock.current) return;
    exportLock.current = true; setBusy(true); setResult(null);
    try {
      const suffix = mode === 'zh' ? '' : projectSettings?.['export.bilingual_layout'] === 'zh-top' ? '（中日对照）' : '（日中对照）';
      const path = await api.files.pickSavePath(`${title}${suffix}${preview ? '（预览）' : ''}.epub`);
      if (!path) return;
      const r = await api.export.run(volumeId, mode, path, preview);
      setResult(r);
      if (r.ok) { toast('success', `${preview ? '预览文件' : '正式文件'}已保存：${path}`); void tryApi(() => api.files.showInFolder(path)); }
    } catch (e) { toast('error', `导出未完成：${(e as Error).message}。可以重试。`); }
    finally { exportLock.current = false; setBusy(false); }
  };
  return (
    <Modal title="导出文件" width={640} onClose={() => { if (!exportLock.current) onClose(); }} footer={<><button className="btn btn-secondary" onClick={onClose} disabled={busy}>关闭</button><button className="btn btn-secondary" disabled={busy} onClick={() => run(true)}>预览导出（跳过质量门）</button><button className="btn btn-primary" disabled={busy || !gate?.ok} onClick={() => run(false)}>正式导出</button></>}>
      {busy && <div className="card" role="status" aria-live="polite">正在选择位置、检查稿件并生成文件，请等待保存结果。耗时取决于书籍大小。</div>}
      <p className="small muted">正式导出使用本次检查的数据快照。预览可能包含原文和未解决问题，不代表交付达标。TXT 源可保存为 .txt；EPUB 源请保存为 .epub。</p>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
      <div className="row" style={{ marginBottom: 12, gap: 8 }}>
        <div className={`choice${mode === 'zh' ? ' on' : ''}`} style={{ flex: 1, marginBottom: 0 }} onClick={() => { if (!busy) setMode('zh'); }}>
          <input type="radio" readOnly checked={mode === 'zh'} />
          <span>纯中文</span>
        </div>
        <div className={`choice${mode === 'bilingual' ? ' on' : ''}`} style={{ flex: 1, marginBottom: 0 }} onClick={() => { if (!busy) setMode('bilingual'); }}>
          <input type="radio" readOnly checked={mode === 'bilingual'} />
          <span>{projectSettings?.['export.bilingual_layout'] === 'zh-top' ? '中日对照（中上日下）' : '日中对照（日上中下）'}</span>
        </div>
      </div>
      {projectSettings && currentSeriesId && <div className="row wrap small" style={{ marginBottom: 12 }}>
        <Switch checked={projectSettings['ruby.first_person']} onChange={v => api.project.setSetting(currentSeriesId, 'ruby.first_person', v)} label="一人称 ruby 罗马音（首次与转变处）" />
        <Switch checked={projectSettings['export.translate_title']} onChange={v => api.project.setSetting(currentSeriesId, 'export.translate_title', v)} label="翻译书名/目录" />
        {mode === 'bilingual' && <Switch checked={projectSettings['export.bilingual_layout'] === 'zh-top'} onChange={v => api.project.setSetting(currentSeriesId, 'export.bilingual_layout', v ? 'zh-top' : 'jp-top')} label="中文在上（默认日文在上）" />}
      </div>}
      </fieldset>
      {!gate ? <div className="skeleton" /> : (
        <div className="card">
          <div className="row"><h3 style={{ margin: 0 }}>质量门</h3><Pill kind={gate.ok ? 'success' : 'error'}>{gate.ok ? '通过' : `${gate.blockers.reduce((a, b) => a + b.count, 0)} 项阻断`}</Pill><span className="grow" /><span className="small muted">{gate.totalParagraphs} 段</span></div>
          <GateVisual gate={gate} />
          {gate.blockers.length > 0 && <div className="gate-blockers" style={{ marginTop: 10 }}>{gate.blockers.map(b => <span key={b.code} className="gate-chip err" title={b.sample.map(id => `#${id?.slice(0, 8) ?? ''}`).join(', ')}>{({ AUTOMATIC_KNOWLEDGE_STALE: '自动知识来源变化，请继续本册重新核对', TRAJECTORY_MISSING: '请继续处理本册，补做跨章审核', TRAJECTORY_UNRESOLVED: '跨章问题待处理', EMPTY_VOLUME: '没有可导出段落', AUDIT_MISSING: '当前稿尚未复核', AUDIT_STALE: '原文或知识变化，需重新复核', RECHECK_PENDING: '有待回查段落' } as Record<string, string>)[b.code] ?? b.code} ×{b.count}</span>)}</div>}
          {gate.warnings.length > 0 && <div className="gate-blockers" style={{ marginTop: 6 }}>{gate.warnings.map(w => <span key={w.code} className="gate-chip warn" title="不阻断导出">⚠ {w.code} ×{w.count}</span>)}</div>}
          {gate.pendingDeviations > 0 && <div className="small muted" style={{ marginTop: 6 }}>{gate.pendingDeviations} 处术语偏离未处理（需处理后正式导出）</div>}
        </div>
      )}
      {result && <div className="card" style={{ marginTop: 12 }}><h3>{result.ok ? result.preview ? '预览文件已保存（非正式交付）' : '正式文件已保存' : '导出失败，可重试'}</h3><div className="small muted">本次快照：{result.snapshotAt} · {result.snapshotId}。此报告针对该快照，后续修改需重新导出。</div><div className="small">写回 {result.writtenBlocks} 块，保留 {result.keptBlocks} 块，跳过 {result.skippedBlocks} 块</div>{result.messages.slice(0, 20).map((m, i) => <div key={i} className="small muted">{m}</div>)}</div>}
    </Modal>
  );
}

/** 质量门可视化：把整册段落按互斥的采纳／翻译状态显示，问题记录单独计数。 */
function GateVisual({ gate }: { gate: QualityGateReport }) {
  const total = gate.totalParagraphs || 1;
  const confirmed = gate.confirmed;
  const translated = gate.translated;
  const blockCount = gate.blockers.reduce((a, b) => a + b.count, 0);
  const untranslated = Math.max(0, gate.totalParagraphs - translated);
  const pending = Math.max(0, translated - confirmed);
  const seg = (val: number, cls: string, label: string): ReactNode => val <= 0 ? null : <div className={`gv-seg ${cls}`} style={{ width: `${(val / total) * 100}%` }} title={`${label} ${val} 段`}><span className="gv-label">{label} {val}</span></div>;
  return (
    <div className="gate-visual">
      <div className="gv-bar">{seg(confirmed, 'ok', '人工采纳')}{seg(pending, 'pending', '其他已译')}{seg(untranslated, 'empty', '未翻译')}</div>
      <div className="row wrap small muted" style={{ marginTop: 8 }}>
        <span><i className="gv-dot ok" />人工采纳 {gate.confirmed}</span>
        <span><i className="gv-dot pending" />其他已译 {pending}</span>
        <span><i className="gv-dot err" />有问题的记录 {blockCount}（同一段可能有多个）</span>
        <span><i className="gv-dot empty" />未翻译 {untranslated}</span>
      </div>
    </div>
  );
}

