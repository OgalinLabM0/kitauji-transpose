import { create } from 'zustand';
import type { SeriesSummary, WorkflowProgress, ActivityLogEntry, ProviderSettings, ProjectSettings } from '@shared/types';
import type { DataScope } from '@shared/ipc';
import { api } from '../api';
import { draftIdentity } from './draftIdentityBridge';

// Object IDs can be reused after restore. Fence every asynchronous state commit
// by renderer generation, including reads made while the identity boundary loads.
function acceptsLibraryRead(token: string): boolean {
  const scope = draftIdentity.snapshot();
  return scope.token === token && (scope.status === 'loading' || scope.status === 'ready');
}
function requireLibraryRead(token: string): void {
  if (!acceptsLibraryRead(token)) throw new Error('载入期间书库已变化，已拒绝使用旧资料。');
}

export type Page = 'shelf' | 'workbench' | 'glossary' | 'knowledge' | 'review' | 'logs' | 'settings' | 'trajectory';
export interface Toast { id: number; kind: 'info' | 'success' | 'warning' | 'error'; text: string }

interface AppState {
  page: Page; setPage(p: Page): void;
  theme: 'light' | 'dark'; setTheme(t: 'light' | 'dark'): void;
  series: SeriesSummary[]; currentSeriesId: string | null; currentVolumeId: string | null; currentChapterId: string | null;
  selectSeries(id: string | null): void; selectVolume(id: string | null): void; selectChapter(id: string | null): void;
  paragraphTarget: string | null; jumpToParagraph(id: string): Promise<void>;
  projectSettings: ProjectSettings | null;
  provider: ProviderSettings | null;
  progress: WorkflowProgress;
  logs: ActivityLogEntry[];
  /** 每个工作流阶段最近一次结束时的消息（含"失败/中断"），供预处理弹窗显示"最近一次运行结果" */
  lastPhaseResult: Record<string, string>;
  queueCount: number;
  toasts: Toast[]; toast(kind: Toast['kind'], text: string): void; dismissToast(id: number): void;
  /** 变更计数器，各页面 useEffect 依赖它刷新 */
  rev: Record<DataScope, number>;
  refreshSeries(): Promise<void>;
  refreshProvider(): Promise<void>;
  refreshProjectSettings(): Promise<void>;
  refreshQueueCount(): Promise<void>;
  refreshLogs(): Promise<void>;
  refreshProgress(): Promise<void>;
  init(): Promise<void>;
}

let toastSeq = 0;
let progressRevision = 0;
const idle: WorkflowProgress = { running: false, paused: false, phase: 'idle', done: 0, total: 0, currentParagraphId: null, costUsd: 0, inputTokens: 0, outputTokens: 0, message: '' };

export const useApp = create<AppState>((set, get) => ({
  page: 'shelf', setPage: (page) => set({ page }),
  theme: 'light', setTheme: (theme) => { document.documentElement.dataset.theme = theme; set({ theme }); void api.app.setUiPrefs({ theme }); },
  series: [], currentSeriesId: null, currentVolumeId: null, currentChapterId: null,
  selectSeries: (id) => {
    const s = get().series.find(x => x.id === id);
    const vol = s?.volumes[0]?.id ?? null;
    set({ currentSeriesId: id, currentVolumeId: vol, currentChapterId: null, paragraphTarget: null, queueCount: 0 });
    void api.app.setUiPrefs({ currentSeriesId: id, currentVolumeId: vol });
    void get().refreshProjectSettings(); void get().refreshQueueCount();
  },
  selectVolume: (id) => { set({ currentVolumeId: id, currentChapterId: null, paragraphTarget: null, queueCount: 0 }); void api.app.setUiPrefs({ currentVolumeId: id }); void get().refreshQueueCount(); },
  selectChapter: (id) => set({ currentChapterId: id }),
  paragraphTarget: null,
  jumpToParagraph: async (id) => {
    const token = draftIdentity.snapshot().token;
    if (!draftIdentity.isCurrent(token)) throw new Error('书库身份已变化或尚未确认，请重新定位。');
    const p = await api.project.getParagraph(id);
    if (!draftIdentity.isCurrent(token)) throw new Error('定位期间书库已变化，已拒绝使用旧资料。');
    if (!p) throw new Error('该段落已不存在');
    const series = get().series.find(s => s.volumes.some(v => v.id === p.volumeId));
    if (!series) throw new Error('该段落所属作品不可用');
    set({ currentSeriesId: series.id, currentVolumeId: p.volumeId, currentChapterId: p.chapterId, paragraphTarget: p.id, page: 'workbench' });
    void api.app.setUiPrefs({ currentSeriesId: series.id, currentVolumeId: p.volumeId });
    void get().refreshQueueCount(); void get().refreshProjectSettings();
  },
  projectSettings: null, provider: null, progress: idle, logs: [], queueCount: 0, lastPhaseResult: {},
  toasts: [],
  toast: (kind, text) => { const id = ++toastSeq; set(s => ({ toasts: [...s.toasts, { id, kind, text }] })); setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000); },
  dismissToast: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
  rev: { series: 0, paragraphs: 0, queue: 0, glossary: 0, knowledge: 0, settings: 0 },
  refreshSeries: async () => {
    const token = draftIdentity.snapshot().token;
    if (!acceptsLibraryRead(token)) return;
    const series = await api.project.listSeries();
    if (!acceptsLibraryRead(token)) return;
    const st = get();
    let cur = st.currentSeriesId && series.some(s => s.id === st.currentSeriesId) ? st.currentSeriesId : (series[0]?.id ?? null);
    const s = series.find(x => x.id === cur);
    let vol = st.currentVolumeId && s?.volumes.some(v => v.id === st.currentVolumeId) ? st.currentVolumeId : (s?.volumes[0]?.id ?? null);
    const seriesChanged = cur !== st.currentSeriesId, volumeChanged = vol !== st.currentVolumeId;
    set({ series, currentSeriesId: cur, currentVolumeId: vol, ...(volumeChanged ? { currentChapterId: null } : {}), ...(cur === null && st.page !== 'shelf' && st.page !== 'settings' && st.page !== 'logs' ? { page: 'shelf' as Page } : {}) });
    if (seriesChanged || volumeChanged) { void api.app.setUiPrefs({ currentSeriesId: cur, currentVolumeId: vol }); }
    await Promise.all([
      ...(seriesChanged ? [get().refreshProjectSettings()] : []),
      ...(seriesChanged || volumeChanged ? [get().refreshQueueCount()] : []),
    ]);
  },
  refreshProvider: async () => {
    const token = draftIdentity.snapshot().token;
    if (!acceptsLibraryRead(token)) return;
    const provider = await api.app.getProviderSettings();
    if (acceptsLibraryRead(token)) set({ provider });
  },
  refreshProjectSettings: async () => {
    const token = draftIdentity.snapshot().token;
    if (!acceptsLibraryRead(token)) return;
    const sid = get().currentSeriesId;
    const projectSettings = sid ? await api.project.getSettings(sid) : null;
    if (acceptsLibraryRead(token) && get().currentSeriesId === sid) set({ projectSettings });
  },
  refreshQueueCount: async () => {
    const token = draftIdentity.snapshot().token;
    if (!acceptsLibraryRead(token)) return;
    const sid = get().currentSeriesId;
    if (!sid) { set({ queueCount: 0 }); return; }
    const vid = get().currentVolumeId;
    const counts = await api.review.counts(sid, vid ?? undefined);
    if (!acceptsLibraryRead(token) || get().currentSeriesId !== sid || get().currentVolumeId !== vid) return;
    set({ queueCount: Object.values(counts).reduce((a, b) => a + b, 0) });
  },
  refreshLogs: async () => {
    const token = draftIdentity.snapshot().token;
    if (!acceptsLibraryRead(token)) return;
    const { entries: logs } = await api.logs.page();
    if (acceptsLibraryRead(token)) set({ logs });
  },
  refreshProgress: async () => {
    const token = draftIdentity.snapshot().token;
    if (!acceptsLibraryRead(token)) return;
    const revision = ++progressRevision;
    const progress = await api.workflow.progress();
    if (acceptsLibraryRead(token) && revision === progressRevision) set({ progress });
  },
  init: async () => {
    const token = draftIdentity.snapshot().token;
    requireLibraryRead(token);
    const prefs = await api.app.getUiPrefs();
    requireLibraryRead(token);
    const theme = (prefs.theme as 'light' | 'dark') ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
    set({ theme, currentSeriesId: (prefs.currentSeriesId as string | null) ?? null, currentVolumeId: (prefs.currentVolumeId as string | null) ?? null });
    await Promise.all([get().refreshSeries(), get().refreshProvider()]);
    requireLibraryRead(token);
    await get().refreshProjectSettings(); requireLibraryRead(token);
    await get().refreshQueueCount(); requireLibraryRead(token);
    await Promise.all([get().refreshProgress(), get().refreshLogs()]);
    requireLibraryRead(token);
    api.on('progress', (p) => {
      if (draftIdentity.snapshot().status !== 'ready') return;
      progressRevision++;
      set(s => ({ progress: p, lastPhaseResult: !p.running && s.progress.running ? { ...s.lastPhaseResult, [s.progress.phase]: p.message } : s.lastPhaseResult }));
    });
    let pendingLogs: ActivityLogEntry[] = [];
    let pendingToken = '';
    let logTimer: ReturnType<typeof setTimeout> | undefined;
    api.on('log', (e) => {
      const identity = draftIdentity.snapshot();
      if (identity.status !== 'ready') return;
      if (pendingToken !== identity.token) { pendingLogs = []; pendingToken = identity.token; }
      pendingLogs.push(e);
      if (logTimer) return;
      logTimer = setTimeout(() => {
        logTimer = undefined;
        const entries = pendingLogs; pendingLogs = [];
        if (!draftIdentity.isCurrent(pendingToken)) return;
        set(s => ({ logs: [...s.logs, ...entries].slice(-1000) }));
      }, 80);
    });
    api.on('data-changed', (scope) => {
      if (draftIdentity.snapshot().status !== 'ready') return;
      set(s => ({ rev: { ...s.rev, [scope]: s.rev[scope] + 1 } }));
      if (scope === 'series') void get().refreshSeries();
      if (scope === 'queue') void get().refreshQueueCount();
      if (scope === 'settings') { void get().refreshProvider(); void get().refreshProjectSettings(); }
    });
  },
}));

let initialized = false;
let dataLoad = Promise.resolve();
/** The boundary and maintenance completion share one generation-fenced reload. */
export function loadCurrentLibrary(): Promise<void> {
  const token = draftIdentity.snapshot().token;
  dataLoad = dataLoad.catch(() => {}).then(async () => {
    requireLibraryRead(token); // A queued old reload must not clear a newer session.
    useApp.setState({ currentSeriesId: null, currentVolumeId: null, currentChapterId: null, paragraphTarget: null, series: [], projectSettings: null, provider: null, queueCount: 0, logs: [], lastPhaseResult: {}, progress: { ...idle } });
    if (!initialized) {
      await useApp.getState().init();
      requireLibraryRead(token);
      initialized = true;
    } else {
      await useApp.getState().refreshSeries();
      requireLibraryRead(token);
      await Promise.all([useApp.getState().refreshProjectSettings(), useApp.getState().refreshProvider(), useApp.getState().refreshLogs(), useApp.getState().refreshQueueCount(), useApp.getState().refreshProgress()]);
      requireLibraryRead(token);
    }
  });
  return dataLoad;
}

/** 包装 API 调用：错误 toast */
export async function tryApi<T>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> {
  try { const r = await fn(); if (okText) useApp.getState().toast('success', okText); return r; }
  catch (e) { useApp.getState().toast('error', (e as Error).message); return undefined; }
}
