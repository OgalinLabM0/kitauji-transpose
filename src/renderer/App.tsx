import { useEffect } from 'react';
import { DraftIdentityBoundary } from './components/DraftIdentityBoundary';
import { DraftRecovery } from './components/DraftRecovery';
import { DeliveryOutcome } from './components/DeliveryOutcome';
import { useApp, tryApi, type Page } from './store/app';
import { api } from './api';
import { Toasts, Progress, fmtTokens } from './components/ui';
import { ShelfPage } from './features/shelf/ShelfPage';
import { WorkbenchPage } from './features/workbench/WorkbenchPage';
import { GlossaryPage } from './features/glossary/GlossaryPage';
import { KnowledgePage } from './features/knowledge/KnowledgePage';
import { AddressTrajectoryPage } from './features/knowledge/AddressTrajectoryPage';
import { ReviewPage } from './features/review/ReviewPage';
import { LogsPage } from './features/logs/LogsPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { Library, PenLine, ListChecks, BookMarked, Users, ScrollText, Settings, Feather, GitBranch } from 'lucide-react';

const NAV: { id: Page; label: string; needSeries?: boolean; icon: typeof Library }[] = [
  { id: 'shelf', label: '书架', icon: Library },
  { id: 'workbench', label: '翻译与阅读', needSeries: true, icon: PenLine },
  { id: 'review', label: '待确认', needSeries: true, icon: ListChecks },
  { id: 'glossary', label: '术语表', needSeries: true, icon: BookMarked },
  { id: 'knowledge', label: '人物与关系', needSeries: true, icon: Users },
  { id: 'trajectory', label: '称呼记录', needSeries: true, icon: GitBranch },
  { id: 'logs', label: '运行记录', icon: ScrollText },
];

export function App() { return <DraftIdentityBoundary><AppContent /></DraftIdentityBoundary>; }
function AppContent() {
  const { page, setPage, series, currentSeriesId, currentVolumeId, selectSeries, selectVolume, queueCount, progress, provider, toast } = useApp();
  const canPause = progress.phase === '翻译' || progress.phase === '决定后重译' || progress.phase === '回查重译';
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key === ',') { e.preventDefault(); setPage('settings'); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [setPage]);
  const cur = series.find(s => s.id === currentSeriesId);

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-brand"><span className="brand-mark"><Feather size={14} /></span><div>北宇治译奏部<small>KitaUji Transpose · 0.0.1</small></div></div>
        {cur && (
          <div className="nav-context">
            <div className="title" title={cur.title}>{cur.title}</div>
            {series.length > 1 && <select className="input" value={currentSeriesId ?? ''} onChange={e => selectSeries(e.target.value)}>{series.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select>}
            <select className="input" value={currentVolumeId ?? ''} onChange={e => selectVolume(e.target.value)}>
              {cur.volumes.map(v => <option key={v.id} value={v.id}>第 {String(v.volumeNumber).padStart(2, '0')} 册{v.title ? ` · ${v.title}` : ''}</option>)}
            </select>
          </div>
        )}
        {NAV.filter(n => ['shelf', 'workbench', 'review'].includes(n.id)).map(n => {
          const Icon = n.icon;
          return (
            <button key={n.id} title={n.label} aria-label={n.label} className={`nav-item${page === n.id ? ' active' : ''}`} disabled={!!n.needSeries && !currentSeriesId} onClick={() => setPage(n.id)}>
              <span className="nav-ic"><Icon size={16} /></span><span className="nav-label">{n.label}</span>{n.id === 'review' && queueCount > 0 && <span className="badge">{queueCount}</span>}
            </button>
          );
        })}
        <details className="nav-reference" open={['glossary', 'knowledge', 'trajectory', 'logs'].includes(page) || undefined}><summary>资料与记录</summary>{NAV.filter(n => !['shelf', 'workbench', 'review'].includes(n.id)).map(n => { const Icon=n.icon; return <button key={n.id} aria-label={n.label} className={`nav-item${page === n.id ? ' active' : ''}`} disabled={!!n.needSeries && !currentSeriesId} onClick={() => setPage(n.id)}><span className="nav-ic"><Icon size={16}/></span><span className="nav-label">{n.label}</span></button>; })}</details>
        <div className="nav-spacer" />
        <div className="nav-group">
          <button title="设置" aria-label="设置" className={`nav-item${page === 'settings' ? ' active' : ''}`} onClick={() => setPage('settings')}>
            <span className="nav-ic"><Settings size={16} /></span><span className="nav-label">设置</span>{provider && !provider.hasApiKey && provider.authScheme !== 'none' && <span className="badge badge-warning">!</span>}
          </button>
        </div>
        <div className="nav-footer">{provider ? `${provider.model}` : ''}</div>
      </nav>
      <div className="main">
        <DeliveryOutcome />
        <div className="compact-navigation" aria-label="页面与当前书籍">
          <label>页面<select className="input" value={page} onChange={e => setPage(e.target.value as Page)}>{[...NAV, { id: 'settings' as Page, label: '设置', needSeries: false }].map(n => <option key={n.id} value={n.id} disabled={!!n.needSeries && !currentSeriesId}>{n.label}</option>)}</select></label>
          {cur && <><label>系列<select className="input" value={currentSeriesId ?? ''} onChange={e => selectSeries(e.target.value)}>{series.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label><label>册<select className="input" value={currentVolumeId ?? ''} onChange={e => selectVolume(e.target.value)}>{cur.volumes.map(v => <option key={v.id} value={v.id}>第 {v.volumeNumber} 册{v.title ? ` · ${v.title}` : ''}</option>)}</select></label></>}
        </div>
        <div className={`page${page === 'workbench' ? ' reader-page' : ''}`}>
          {page === 'shelf' && <ShelfPage />}
          {page === 'workbench' && <WorkbenchPage />}
          {page === 'review' && <ReviewPage />}
          {page === 'glossary' && <GlossaryPage key={currentSeriesId} />}
          {page === 'knowledge' && <KnowledgePage key={currentSeriesId} />}
          {page === 'trajectory' && <AddressTrajectoryPage />}
          {page === 'logs' && <LogsPage />}
          {page === 'settings' && <SettingsPage />}
        </div>
        <div className="taskbar">
          {progress.running ? (
            <>
              <span className="spinner" />
              <span className="taskbar-phase">{progress.phase === '全作品 · 已检查册数' || progress.phase === '保存成品' ? '' : '当前步骤 · '}{progress.phase}</span>
              <Progress value={progress.done} max={progress.total} />
              <span>{progress.done}/{progress.total}</span>
              <span className="ellipsis grow">{progress.message}</span>
              <span>输入 {fmtTokens(progress.inputTokens)} · 输出 {fmtTokens(progress.outputTokens)} token{progress.unknownUsageRequests ? ` · ${progress.unknownUsageRequests} 次用量未知` : ''}</span>
              {canPause && (progress.paused
                ? <button className="btn btn-text btn-sm" onClick={() => tryApi(() => api.workflow.resume())}>继续</button>
                : <button className="btn btn-text btn-sm" onClick={() => tryApi(() => api.workflow.pause())}>暂停</button>)}
              <button className="btn btn-text btn-sm" onClick={() => tryApi(() => api.workflow.cancel())}>停止</button>
            </>
          ) : <span className="ellipsis grow">{progress.message || '稿件会自动保存到本机'}</span>}
          <DraftRecovery />
        </div>
      </div>
      <Toasts />
    </div>
  );
}
