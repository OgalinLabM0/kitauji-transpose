import { useEffect } from 'react';
import { DraftIdentityBoundary } from './components/DraftIdentityBoundary';
import { DraftRecovery } from './components/DraftRecovery';
import { DeliveryOutcome } from './components/DeliveryOutcome';
import { useApp, type Page } from './store/app';
import { Toasts, fmtTokens } from './components/ui';
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
        <div className="nav-brand"><span className="brand-mark"><Feather size={14} /></span><div>北宇治译奏部<small>KitaUji Transpose · 0.0.2</small></div></div>
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
              <span className="grow">{progress.paused ? '任务已暂停，进度保留' : '任务在后台处理，可继续阅读'}</span>
              <span>输入 {fmtTokens(progress.inputTokens)} · 输出 {fmtTokens(progress.outputTokens)} token{progress.unknownUsageRequests ? ` · ${progress.unknownUsageRequests} 次用量未知` : ''}</span>
            </>
          ) : <span className="grow">稿件与处理进度保存在本机</span>}
          <button className="btn btn-text btn-sm" onClick={() => useApp.getState().setPage('logs')}>查看日志</button>
          <DraftRecovery />
        </div>
      </div>
      <Toasts />
    </div>
  );
}
