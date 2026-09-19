import { ReadViews } from '../readViews';
import { scheduleDataMove } from '../dataLocation';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { requestIdentity } from '../../src/core/ai/requestIdentity';
import { rebuildEpubChapters } from '@core/epub/rebuildChapters';
import { previewLegacyChangeRecovery, reconfirmLegacyChange, undoLegacyChangeReconfirmation } from '@core/workflow/legacyChangeRecovery';
import { readLibraryIdentity } from '@core/db/libraryIdentity';
import { characterKnowledgeHistory } from '../../src/core/db/characterKnowledgeHistory';
import { narrativeSourceStatus } from '../../src/core/db/narrativeSources';
import { pruneLongNaturalnessCheckpoints } from '@core/workflow/longNaturalnessPlan';
import { backupLibrary, inspectBackup, restoreLibrary, clearLibraryData } from '@core/files/libraryBackup';
import { ImportQueue } from '@core/workflow/importQueue';
import { inspectImport } from '@core/workflow/importPreflight';
import { atomicWriteFile } from '../../src/core/files/atomicWrite';
import { pendingFinalReviews } from '@core/workflow/taskOverview';
import { scopedReview, volumeOverview, withAuditStatus } from '@core/workflow/taskOverview';
import { automaticFieldDecisions, undoAutomaticFieldDecision, undoResolvedReview } from '@core/workflow/automaticFieldDecisions';
import { runScopedReviewOperation } from '@core/workflow/scopedReviewOperation';
import { captureReviewOperation } from '@core/workflow/reviewOperationScope';
/**
 * IPC 处理器：实现 src/shared/ipc.ts 的 Api 契约。单一 AppService 持有 store / AiClient / 当前任务；
 * 所有 handler 参数用 zod 粗校验（防止渲染层传入畸形数据），错误以 Error 抛回渲染层。
 */
import { ipcMain, dialog, shell, BrowserWindow, app } from 'electron';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { ProjectStore } from '@core/db';
import { importEpub } from '@core/epub/epubImport';
import { importTxt } from '@core/txt/txtImport';
import { AiClient, chat } from '@core/ai';
import { TranslationPipeline, PrepRunner, DecisionService, runQualityGate, exportVolume, AutoArbiter, type Decision } from '@core/workflow';
import type { Api, DataScope, PrepStatus, RelationshipView, SeriesDeliveryRequest } from '@shared/ipc';
import type { WorkflowProgress, ActivityLogEntry, ProjectSettings, LockLevel, QuirkProfile } from '@shared/types';
import { AppSettings } from '../appSettings';
import { TaskControl } from '@core/workflow/taskControl';
import { RepairQueue } from '@core/workflow/repairQueue';
import { auditStatus } from '@core/workflow/auditReceipts';
import { recoverVolumeRuns, runVolumeFlow, volumeRunState } from '@core/workflow/volumeFlow';
import { deliveryState, deliverSeries, recoverDeliveries } from '@core/workflow/seriesDelivery';
import { canContinueDeliveryAfterDecision, stopWaitingDeliveryContinuation } from '@core/workflow/deliveryContinuation';
import { recoverSeriesRuns, runSeriesFlow, seriesRunState } from '@core/workflow/seriesFlow';
import { exportSeries, seriesExportCheck } from '@core/workflow/seriesExport';

type Handlers = { [NS in Exclude<keyof Api, 'on'>]: { [M in keyof Api[NS]]: Api[NS][M] extends (...a: infer A) => Promise<infer R> ? (...a: A) => Promise<R> | R : never } };

const id = z.string().min(1);
const ids = z.array(id);

/** 这些是渲染层自动轮询/只读的调用，失败不写任务日志（避免反馈环刷屏），错误只回给调用方 */
const NO_LOG_ON_ERROR = new Set(['app.getLibraryIdentity', 'app.usage', 'logs.recent', 'logs.page', 'logs.detail', 'logs.clear', 'workflow.progress', 'app.getUiPrefs', 'app.setUiPrefs', 'project.prepStatus', 'project.analysis', 'review.counts']);

NO_LOG_ON_ERROR.add('review.previewLegacyChange');

export class AppService {
  store: ProjectStore;
  private readonly readViews = new ReadViews(() => this.store.db.path);
  readonly settings = new AppSettings();
  ai: AiClient;
  private current: { kind: 'pipeline'; run: TranslationPipeline } | { kind: 'prep'; run: PrepRunner; abort: AbortController } | { kind: 'import' | 'provider-test'; abort: AbortController } | null = null;
  private readonly tasks = new TaskControl();
  private maintenance = false;
  private disposed = false;
  private drainingRepairs = false;
  private stopRepairs = true;
  private cancelEpoch = 0;
  // Session-only authorization: reopening the application never arms old work.
  private readonly automaticDeliveries = new Set<string>();
  private readonly pendingDeliveryContinuations = new Map<string,string>();
  private deliveryTimer: NodeJS.Timeout | null = null;
  private latestProgress: WorkflowProgress = { running: false, paused: false, detail: null, phase: 'idle', done: 0, total: 0, currentParagraphId: null, costUsd: 0, inputTokens: 0, outputTokens: 0, message: '' };
  private lastLogId = 0;
  private logTimer: NodeJS.Timeout | null = null;
  private repairTimer: NodeJS.Timeout | null = null;
  private readonly repairWaiters = new Set<() => void>();
  private maintenanceFinished: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private closing = false;

  constructor(private readonly win: () => BrowserWindow | null) {
    const dataDir = process.env.V3_TEST_USERDATA ?? app.getPath('userData');
    mkdirSync(dataDir, { recursive: true });
    this.store = new ProjectStore(join(dataDir, 'library.sqlite'));
    this.ai = new AiClient(this.store, this.settings.toClientConfig());
    this.lastLogId = this.store.translations.latestLogId();
    new RepairQueue(this.store).recover();
    recoverVolumeRuns(this.store);
    recoverSeriesRuns(this.store);
    recoverDeliveries(this.store);
    try { new ImportQueue(this.store).recover(); }
    catch { this.store.translations.log({ level: 'warning', message: '导入清单无法恢复，原记录与已导入书籍保留，请先备份后检查导入清单。' }); }
    this.repairAllSeriesNames();
    this.logTimer = setInterval(() => this.flushLogs(), 700);
  }
  /** 启动修复：上一版预读可能把主角合并进了「僕」这类代词档案；这里把真名提升回主名并清掉代词别名。幂等。 */
  private repairAllSeriesNames(): void {
    try {
      for (const se of this.store.projects.listSeries()) {
        const r = this.store.knowledge.repairGenericNames(se.id);
        if (r.promoted.length || r.deactivated.length || r.aliasesRemoved) this.store.translations.log({ level: 'warning', message: `启动修复「${se.title}」人物档案：主名修正 ${r.promoted.join('、') || '无'}；无真名档案标记失效 ${r.deactivated.join('、') || '无'}；移除代词/职称别名 ${r.aliasesRemoved} 个` });
      }
    } catch (e) { this.store.translations.log({ level: 'error', message: `启动修复失败：${(e as Error).message}` }); }
  }
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    if (this.disposed) return Promise.resolve();
    this.closing = true; this.stopRepairs = true;
    this.clearServiceTimers();
    const queriesStopped = this.readViews.cancel();
    this.cancelCurrent();
    this.disposePromise = (async () => {
      // A maintenance operation may still be reading/writing its backup. Never close its store.
      await queriesStopped;
      await this.maintenanceFinished;
      this.maintenance = true;
      await this.backgroundSettled();
      this.store.close(); this.disposed = true;
    })().catch(error => {
      // Stay safely closed to new work, but allow the user to retry shutdown.
      this.disposePromise = null;
      throw error;
    });
    return this.disposePromise;
  }
  private clearServiceTimers(): void {
    if (this.logTimer) clearInterval(this.logTimer);
    if (this.repairTimer) clearTimeout(this.repairTimer);
    this.logTimer = null; this.repairTimer = null;
  }
  private scheduleRepairs(): void {
    if (this.repairTimer || this.maintenance || this.closing || this.disposed || this.stopRepairs) return;
    this.repairTimer = setTimeout(() => {
      this.repairTimer = null;
      void this.drainRepairs().catch(error => {
        this.stopRepairs = true;
        this.maintenanceLog(`后台修复停止：${this.errorMessage(error)}`);
      });
    }, 0);
  }
  private repairsSettled(): Promise<void> {
    if (!this.drainingRepairs) return Promise.resolve();
    return new Promise(resolve => this.repairWaiters.add(resolve));
  }
  private async backgroundSettled(): Promise<void> {
    await this.tasks.settled();
    await this.repairsSettled();
  }
  private async waitBounded(work: Promise<void>, ms: number, message: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  private errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  private maintenanceLog(message: string): void {
    try { this.store.translations.log({ level: 'info', message }); }
    catch { /* Observability cannot change the result or hide the original failure. */ }
  }
  private assertMaintenanceCurrent(epoch: number): void {
    if (this.closing || this.disposed || epoch !== this.cancelEpoch) throw new Error('已取消数据维护，原书库保留');
  }
  /** Ownership outlives a timeout: late task/queue completion can only touch the original library. */
  private async withMaintenance<T>(work: (checkpoint: () => void) => Promise<T>, options: { preserveLibraryIdentity?: boolean } = {}): Promise<T> {
    if (this.maintenance || this.closing || this.disposed) throw new Error('正在维护数据，请稍后再试');
    this.maintenance = true; this.stopRepairs = true;
    if (!options.preserveLibraryIdentity) this.emit('library-identity', 'blocked');
    this.clearServiceTimers();
    const queriesStopped = this.readViews.cancel();
    let release!: () => void;
    this.maintenanceFinished = new Promise<void>(resolve => { release = resolve; });
    let epoch = this.cancelEpoch;
    const checkpoint = () => this.assertMaintenanceCurrent(epoch);
    try {
      await queriesStopped;
      this.cancelCurrent();
      epoch = this.cancelEpoch;
      await this.waitBounded(this.tasks.settled(), 10_000, '后台任务尚未结束，已取消数据维护并保留原书库；任务结束后可重试');
      await this.waitBounded(this.repairsSettled(), 5_000, '后台修复尚未结束，已取消数据维护并保留原书库；修复结束后可重试');
      checkpoint();
      return await work(checkpoint);
    } finally {
      const finish = () => {
        this.maintenanceFinished = null;
        this.maintenance = this.closing;
        if (!options.preserveLibraryIdentity) this.emit('library-identity', 'ready');
        // Success and failure both require explicit queue resumption. Never wake old jobs here.
        this.stopRepairs = true;
        if (!this.closing && !this.disposed) this.logTimer = setInterval(() => this.flushLogs(), 700);
        release();
      };
      if (this.tasks.busy || this.drainingRepairs) void this.backgroundSettled().then(finish);
      else finish();
    }
  }
  private async verifiedSafetyBackup(prefix: string, checkpoint: () => void): Promise<string> {
    const safetyPath = join(process.env.V3_TEST_USERDATA ?? app.getPath('userData'), 'backups', `${prefix}-${Date.now()}-${randomUUID()}.v3backup`);
    mkdirSync(join(safetyPath, '..'), { recursive: true });
    const snapshot = await backupLibrary(this.store, safetyPath);
    checkpoint();
    // Verify the saved file, not just the temporary snapshot used by backupLibrary.
    const persisted = await inspectBackup(safetyPath);
    checkpoint();
    if (persisted.hash !== snapshot.hash) throw new Error('安全备份写入后校验不一致，原书库保留');
    return safetyPath;
  }
  private resetMaintenanceUi(): string {
    this.lastLogId = 0; this.lastSceneDone = 0;
    this.latestProgress = { ...this.latestProgress, running: false, paused: false, detail: null, phase: 'idle', done: 0, total: 0, currentParagraphId: null, message: '' };
    try { this.settings.setUi({ currentSeriesId: null, currentVolumeId: null }); return ''; }
    catch (error) { return `；界面选择保存失败：${this.errorMessage(error)}`; }
  }
  private cancelCurrent(): void {
    this.cancelEpoch++;
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    this.deliveryTimer = null;
    for (const seriesId of this.automaticDeliveries) stopWaitingDeliveryContinuation(this.store,seriesId);
    this.automaticDeliveries.clear(); this.pendingDeliveryContinuations.clear();
    if (this.repairTimer) clearTimeout(this.repairTimer);
    this.repairTimer = null;
    this.current?.kind === 'pipeline' ? this.current.run.cancel() : this.current?.abort.abort();
  }
  private withTask<T>(work: () => Promise<T>): Promise<T> {
    this.ensureIdle();
    const epoch = this.cancelEpoch;
    return this.tasks.run(async () => {
      if (this.maintenance || epoch !== this.cancelEpoch) throw new Error('已取消');
      this.latestProgress = { ...this.latestProgress, running: true, paused: false, detail: null, done: 0, total: 0, phase: '准备任务', message: '准备任务…' };
      try { this.emit('progress', this.latestProgress); return await work(); }
      finally {
        this.current = null;
        this.latestProgress = { ...this.latestProgress, running: false, paused: false, message: this.latestProgress.message === '准备任务…' ? '' : this.latestProgress.message };
        this.emit('progress', this.latestProgress);
        this.scheduleRepairs();
        this.scheduleDeliveryContinuations();
      }
    });
  }
  private async drainRepairs(): Promise<void> {
    if (this.drainingRepairs || this.tasks.busy || this.maintenance || this.closing || this.disposed || this.stopRepairs) return;
    this.drainingRepairs = true;
    try {
      const queue = new RepairQueue(this.store);
      while (!this.tasks.busy && !this.stopRepairs && !this.maintenance) {
        const job = queue.claim(); if (!job) break;
        if (!this.store.projects.getParagraph(job.paragraph_id)) { queue.finish(job, 'failed', '段落已不存在'); continue; }
        if (!queue.canApply(job)) { queue.finish(job, 'failed', '排队后译稿已更新，未覆盖新稿；请复核当前稿或重新提交重译'); this.changed('queue'); continue; }
        const previousId = this.store.translations.latestFinal(job.paragraph_id)?.id;
        try {
          await this.runPipeline([job.paragraph_id], { phase: '决定后重译', forceFullReview: true, skipConfirmed: false });
          const final = this.store.translations.latestFinal(job.paragraph_id);
          const valid = final && final.id !== previousId && auditStatus(this.store, final) === 'valid' && !this.store.translations.openFindings(job.paragraph_id).some(f => f.severity === 'blocks_export');
          if (this.stopRepairs || this.maintenance) { queue.finish(job, 'queued', '已停止，等待继续'); break; }
          queue.finish(job, valid ? 'done' : 'failed', valid ? null : '未通过审校，原复核项保留');
          if (valid) {
            const queueId = job.workstation_id.slice('repair:'.length);
            const item = this.store.translations.getQueueItem(queueId);
            if (item?.status === 'pending' && item.kind === 'failed') this.store.translations.resolveQueueItem(queueId, JSON.stringify({ action: 'verified-retry', finalId: final.id }));
          }
        } catch (error) {
          queue.finish(job, this.stopRepairs || this.maintenance ? 'queued' : 'failed', (error as Error).message);
          if (this.stopRepairs || this.maintenance) break;
        }
        this.changed('queue', 'paragraphs', 'series');
      }
    } finally {
      this.drainingRepairs = false;
      for (const resolve of this.repairWaiters) resolve();
      this.repairWaiters.clear();
      this.scheduleDeliveryContinuations();
    }
  }

  private deliveryOwnsDecision(queueId:string):boolean {
    const item=this.store.translations.getQueueItem(queueId);
    return !!item && this.automaticDeliveries.has(item.series_id) && !!deliveryState(this.store,item.series_id)?.waitingDecisionIds?.includes(queueId);
  }
  private queueDeliveryAfterDecision(queueId:string):void {
    const item=this.store.translations.getQueueItem(queueId);
    if (!item || !this.automaticDeliveries.has(item.series_id)) return;
    const state=deliveryState(this.store,item.series_id);
    if (!state || !canContinueDeliveryAfterDecision(this.store,state,queueId)) return;
    this.pendingDeliveryContinuations.set(item.series_id,queueId);
    this.scheduleDeliveryContinuations();
  }
  private scheduleDeliveryContinuations():void {
    if (this.deliveryTimer || !this.pendingDeliveryContinuations.size || this.maintenance || this.closing || this.disposed) return;
    const epoch=this.cancelEpoch;
    this.deliveryTimer=setTimeout(()=>{
      this.deliveryTimer=null;
      if (epoch!==this.cancelEpoch || this.tasks.busy || this.drainingRepairs || this.maintenance || this.closing || this.disposed) return;
      for (const [seriesId,queueId] of this.pendingDeliveryContinuations) {
        this.pendingDeliveryContinuations.delete(seriesId);
        const state=deliveryState(this.store,seriesId);
        if (!this.automaticDeliveries.has(seriesId) || !state || !canContinueDeliveryAfterDecision(this.store,state,queueId)) continue;
        void this.runDelivery(seriesId).catch(error=>{
          this.automaticDeliveries.delete(seriesId);
          stopWaitingDeliveryContinuation(this.store,seriesId);
          this.maintenanceLog(`自动继续未完成，原稿与保存位置保留：${this.errorMessage(error)}`);
          this.changed('queue','series');
        });
        break;
      }
    },0);
  }
  private runDelivery(seriesId:string,request?:SeriesDeliveryRequest):Promise<import('@shared/ipc').SeriesDeliveryState> {
    return this.withTask(async()=>{
      this.ensureProvider();
      const abort=new AbortController();
      this.current={kind:'prep',run:new PrepRunner(this.store,this.ai,{signal:abort.signal}),abort};
      try {
        const result=await deliverSeries(this.store,this.ai,seriesId,request,{signal:abort.signal,onState:state=>{
          this.progress({...this.latestProgress,running:true,phase:state.phase==='export'?'保存成品':'全作品 · 已检查册数',detail:state.phase==='export'?null:state.run?.currentRun?.detail??null,done:state.run?.done??0,total:state.run?.total??0,message:state.message,costUsd:0,inputTokens:state.run?.usage.inputTokens??0,outputTokens:state.run?.usage.outputTokens??0,unknownUsageRequests:state.run?.usage.unknownUsageRequests??0});
        }});
        // A verified new final fulfills an already queued decision repair in this delivery scope.
        try { for (const volume of result.scope) for (const paragraphId of this.store.projects.listParagraphIdsByVolume(volume.id)) {
          const final=this.store.translations.latestFinal(paragraphId);
          if (!final?.auto_accepted || auditStatus(this.store,final)!=='valid') continue;
          this.store.db.run("UPDATE workflow_tasks SET status='done',error_message=NULL WHERE paragraph_id=? AND workstation_id LIKE 'repair:%' AND status='queued' AND (base_final_id IS NULL OR base_final_id<>?)",[paragraphId,final.id]);
        } } catch (error) { this.maintenanceLog(`稿件处理结果已保留，修复队列记录未能同步：${this.errorMessage(error)}`); }
        if (result.status!=='attention' || !result.waitingDecisionIds?.length) this.automaticDeliveries.delete(seriesId);
        return result;
      } finally {this.changed('paragraphs','queue','series','knowledge','glossary');}
    });
  }

  /** 独占维护：确认后台结束 → 校验已落盘备份 → 事务清空。超时保留原库。 */
  async resetLibrary(): Promise<{ ok: boolean; message: string }> {
    try {
      return await this.withMaintenance(async checkpoint => {
        const safetyPath = await this.verifiedSafetyBackup('before-clear', checkpoint);
        checkpoint();
        clearLibraryData(this.store);
        const warning = this.resetMaintenanceUi();
        this.maintenanceLog(`清空完成；安全备份：${safetyPath}${warning}`);
        return { ok: true, message: `数据已清空。备份位置: ${safetyPath}${warning}` };
      });
    } catch (error) {
      // No logging in this path: an old timed-out task may still own the original store.
      return { ok: false, message: `清空失败: ${this.errorMessage(error)}` };
    }
  }

  private emit(event: 'progress' | 'log' | 'data-changed' | 'library-identity', payload: unknown): void {
    if (this.closing || this.disposed) return;
    try {
      const window = this.win();
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(`event.${event}`, payload);
    } catch { /* A closing renderer must not interrupt cancellation or falsify a committed result. */ }
  }
  private changed(...scopes: DataScope[]): void { for (const s of scopes) this.emit('data-changed', s); }
  private flushLogs(): void {
    if (this.maintenance || this.closing || this.disposed) return;
    try {
      const logs = this.store.translations.recentLogs(this.lastLogId, 200, true);
      for (const l of logs) { this.emit('log', l satisfies ActivityLogEntry); this.lastLogId = l.id; }
    } catch { /* Polling failures must not escape a timer or recursively write logs. */ }
  }
  private progress = (p: WorkflowProgress): void => {
    this.latestProgress = { ...p };
    this.emit('progress', p);
    if (!p.running) { this.changed('paragraphs', 'queue', 'series'); return; }
    // 场景分析每完成一块就刷新段落列表，工作台上说话人/意图随进度逐块出现，而不是整步结束才一次性变化
    if (p.phase === '场景分析' && p.done > this.lastSceneDone) { this.lastSceneDone = p.done; this.changed('paragraphs'); }
    if (p.phase === '场景分析' && p.done === 0) this.lastSceneDone = 0;
    // 移除这里的通用实时更新逻辑，改由各工作流在自己的onProgress回调中控制
  };
  private lastSceneDone = 0;
  private lastErrorLogged = '';
  private ensureIdle(): void { if (this.maintenance || this.closing || this.disposed) throw new Error('正在维护数据，请稍后再试'); if (this.tasks.busy) throw new Error('已有任务在运行，请先停止或等待完成'); }
  private ensureProvider(): void { const p = this.settings.provider; if (!p.hasApiKey && p.authScheme !== 'none') throw new Error('尚未设置 API 密钥（设置 → AI 接口）'); }

  /** 预读/术语按章续跑：有章未完成 → 只跑未完成章；全部完成 → 用户要整体重跑，清掉标记跑全部 */
  private prepChapterScope(kind: 'preread' | 'terms', volumeId: string): string[] | undefined {
    const s = this.store;
    const all = s.projects.listChapters(volumeId).map(c => c.id);
    const done = s.projects.prepDoneChapters(kind, volumeId);
    if (done.size === 0 || done.size >= all.length) { s.projects.clearPrepDone(kind, all); return undefined; }
    const missing = all.filter(c => !done.has(c));
    s.translations.log({ level: 'info', message: `${kind === 'preread' ? '全书预读' : '专名提取'}：只跑 ${missing.length} 个未完成章（已完成 ${done.size} 章保留）；全部完成后再点「重新运行」才会整体重跑` });
    return missing;
  }
  private async runPrep(fn: (r: PrepRunner) => Promise<unknown>): Promise<void> {
    this.ensureProvider();
    return this.withTask(async () => {
    const abort = new AbortController();
    const run = new PrepRunner(this.store, this.ai, {
      onProgress: (p) => {
        this.progress(p);
        // 实时推送数据变更：预处理阶段每次进度更新时通知前端刷新
        if (p.running && p.done > 0) {
          this.changed('paragraphs', 'glossary', 'knowledge', 'series');
        }
      },
      signal: abort.signal,
    });
    this.current = { kind: 'prep', run, abort };
    try { await fn(run); if (abort.signal.aborted) throw new Error('已取消'); } finally { this.changed('paragraphs', 'queue', 'glossary', 'knowledge', 'series'); }
    });
  }
  private async runPipeline(paragraphIds: string[], opts?: { forceFullReview?: boolean; phase?: string; skipConfirmed?: boolean }): Promise<void> {
    this.ensureProvider();
    return this.withTask(async () => {
    const run = new TranslationPipeline(this.store, this.ai, {
      separateInlineLayout: true,
      onProgress: (p) => {
        this.progress(p);
        // 实时推送数据变更：每次进度更新时通知前端刷新
        if (p.running && p.done > 0) {
          this.changed('paragraphs', 'series');
        }
      },
      ...(opts?.forceFullReview ? { forceFullReview: true } : {}),
      ...(opts?.skipConfirmed !== undefined ? { skipConfirmed: opts.skipConfirmed } : {}),
    });
    this.current = { kind: 'pipeline', run };
    try { await run.run(paragraphIds, opts?.phase ?? '翻译'); } finally { this.changed('paragraphs', 'queue', 'glossary', 'series'); }
    });
  }
  private paragraphIdsOf(target: { volumeId?: string; chapterId?: string; paragraphIds?: string[] }): string[] {
    if (target.paragraphIds?.length) return target.paragraphIds;
    if (target.chapterId) return this.store.projects.listParagraphIdsByChapter(target.chapterId);
    if (target.volumeId) return this.store.projects.listParagraphIdsByVolume(target.volumeId);
    throw new Error('未指定翻译范围');
  }

  handlers(): Handlers {
    // Maintenance preserves the connection; this proxy resolves the service's current store.
    const svc = this;
    const s = new Proxy({} as ProjectStore, {
      get(_t, key) { const cur = svc.store as unknown as Record<string | symbol, unknown>; const v = cur[key]; return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(svc.store) : v; },
    });
    return {
      app: {
        getLibraryIdentity: (...args: unknown[]) => {
          if (args.length) throw new Error('书库身份只读接口不接受参数');
          if (this.maintenance || this.closing || this.disposed) throw new Error('书库维护中，身份暂不可用');
          return readLibraryIdentity(this.store.db);
        },
        version: () => app.getVersion(),
        getDataDirectory: () => app.getPath('userData'),
        chooseDataDirectory: async () => {
          this.ensureIdle();
          if (process.env.V3_TEST_USERDATA) throw new Error('隔离测试目录不允许修改正式数据位置');
          const selection = await dialog.showOpenDialog(this.win()!, { title: '选择空文件夹存放书库与设置', properties: ['openDirectory', 'createDirectory'], defaultPath: app.getPath('userData') });
          if (selection.canceled || !selection.filePaths[0]) return null;
          this.ensureIdle();
          const root = app.isPackaged ? dirname(app.getPath('exe')) : dirname(dirname(fileURLToPath(import.meta.url)));
          scheduleDataMove(root, app.getPath('userData'), selection.filePaths[0]);
          this.closing = true;
          setTimeout(() => { app.relaunch(); app.quit(); }, 250);
          return selection.filePaths[0];
        },
        getProviderSettings: () => this.settings.provider,
        setProviderSettings: (patch) => { const p = this.settings.updateProvider(patch); this.ai.updateConfig(this.settings.toClientConfig()); this.changed('settings'); return p; },
        testProvider: () => this.withTask(async () => {
          this.ensureProvider();
          const abort = new AbortController();
          this.current = { kind: 'provider-test', abort };
          this.progress({ ...this.latestProgress, running: true, phase: '测试接口', done: 0, total: 1, message: '正在验证接口响应，可点击停止取消。' });
          const t = Date.now();
          const valid = (text: string): boolean => {
            try { return z.object({ pong: z.literal(1) }).strict().safeParse(JSON.parse(text)).success; }
            catch { return false; }
          };
          try {
            const provider=this.settings.toProviderConfig();
            this.store.translations.log({level:'info',message:`接口连通性测试 · ${requestIdentity(provider)}`});
            const r = await chat(provider, { system: '你是接口连通性测试助手。只输出 JSON。', user: '请原样返回 {"pong":1}', jsonMode: true, maxOutputTokens: 64, signal: abort.signal, validateExperimentResponse: valid });
            abort.signal.throwIfAborted();
            const ok = valid(r.text);
            // Provider responses are untrusted and may contain secrets; display
            // a fixed result instead of reflecting its body into the renderer.
            const message = ok ? '接口已返回有效测试响应。' : '接口可达，但响应不符合测试格式。';
            this.progress({ ...this.latestProgress, phase: 'idle', done: ok ? 1 : 0, message });
            return { ok, message, latencyMs: Date.now() - t };
          } catch {
            const message = abort.signal.aborted ? '接口测试已取消。' : '接口测试失败，请检查接口设置或稍后重试。';
            this.progress({ ...this.latestProgress, phase: 'idle', done: 0, message });
            return { ok: false, message, latencyMs: Date.now() - t };
          }
        }),
        getUiPrefs: () => this.settings.ui,
        setUiPrefs: (p) => { this.settings.setUi(p); },
        usage: (since) => s.translations.usageTotals(since),
        openExternal: (url) => shell.openExternal(url),
        // 只发 'series'：渲染层先用新系列列表修正当前选择，再由各页面按需刷新；若同时发 paragraphs/queue 等，
        // 页面会在选择尚未修正时用旧 id 查询，日志里刷出一串"册不存在"。
        createBackup: () => this.withTask(async () => {
          const abort = new AbortController(); this.current = { kind: 'import', abort };
          mkdirSync(join(app.getPath('userData'), 'backups'),{recursive:true});
          const choice = await dialog.showSaveDialog(this.win()!, { title: '备份全部书库', defaultPath: join(app.getPath('userData'), 'backups', `书库-${new Date().toISOString().slice(0, 10)}.v3backup`), filters: [{ name: '书库备份', extensions: ['v3backup'] }] });
          abort.signal.throwIfAborted();
          if (choice.canceled || !choice.filePath) return null;
          const snapshot = await backupLibrary(s, choice.filePath);
          const summary = await inspectBackup(choice.filePath);
          if (snapshot.hash !== summary.hash) throw new Error('备份写入后校验不一致，请重试');
          // The completed save is reported accurately even if cancellation arrived during writing.
          return { path: choice.filePath, summary };
        }),
        pickBackup: () => this.withTask(async () => {
          const abort = new AbortController(); this.current = { kind: 'import', abort };
          const choice = await dialog.showOpenDialog(this.win()!, { title: '检查书库备份', properties: ['openFile'], filters: [{ name: '书库备份', extensions: ['v3backup'] }] });
          abort.signal.throwIfAborted();
          if (choice.canceled || !choice.filePaths[0]) return null;
          const summary = await inspectBackup(choice.filePaths[0]);
          abort.signal.throwIfAborted();
          return { path: choice.filePaths[0], summary };
        }),
        restoreBackup: (path, expectedHash) => this.withMaintenance(async checkpoint => {
          const checked = await inspectBackup(path);
          checkpoint();
          if (checked.hash !== expectedHash) throw new Error('备份已变化，请重新选择。');
          const safetyPath = await this.verifiedSafetyBackup('before-restore', checkpoint);
          // restoreLibrary validates an immutable temporary copy and rolls back its transaction on failure.
          const summary = await restoreLibrary(s, path, expectedHash, () => {
            checkpoint();
            new RepairQueue(s).recover(); recoverVolumeRuns(s); recoverSeriesRuns(s); recoverDeliveries(s);
            // Restore must release interrupted imports just like startup, in the same rollback boundary.
            new ImportQueue(s).recover();
          });
          const warning = this.resetMaintenanceUi();
          if (warning) this.maintenanceLog(`书库已恢复${warning}`);
          this.changed('series', 'paragraphs', 'queue', 'knowledge', 'glossary', 'settings');
          return { summary, safetyPath };
        }),
        resetLibrary: async () => { const r = await this.resetLibrary(); this.changed('series', 'settings'); return r; },
      },
      files: {
        pickImport: async () => {
          const w = this.win(); const r = await dialog.showOpenDialog(w!, { title: '导入原文', properties: ['openFile', 'multiSelections'], filters: [{ name: 'EPUB / 文本', extensions: ['epub', 'txt'] }] });
          return r.canceled ? null : r.filePaths.map(p => ({ path: p, name: basename(p) }));
        },
        pickSavePath: async (defaultName) => { const exportDir=join(app.getPath('userData'), 'exports');mkdirSync(exportDir,{recursive:true}); const r = await dialog.showSaveDialog(this.win()!, { title: '导出', defaultPath: join(exportDir,basename(defaultName)), filters: /\.zip$/i.test(defaultName) ? [{ name: '全作品 EPUB 合集', extensions: ['zip'] }] : [{ name: 'EPUB', extensions: ['epub'] }, { name: '纯文本 TXT（仅 TXT 导入的书）', extensions: ['txt'] }] }); return r.canceled ? null : r.filePath ?? null; },
        showInFolder: (p) => { shell.showItemInFolder(p); },
      },
      project: {
        listImportQueues: () => new ImportQueue(s).list(),
        listDamagedImportQueues: () => new ImportQueue(s).listDamaged(),
        quarantineImportQueue: (queueId, fingerprint) => { this.ensureIdle(); new ImportQueue(s).quarantine(id.parse(queueId), z.string().regex(/^[a-f0-9]{64}$/).parse(fingerprint)); },
        createImportQueue: (files, target) => { this.ensureIdle(); return new ImportQueue(s).create(files, target); },
        updateImportQueue: (queueId, revision, target, order) => { this.ensureIdle(); return new ImportQueue(s).update(id.parse(queueId), z.number().int().nonnegative().parse(revision), target, ids.parse(order)); },
        discardImportQueue: (queueId, revision) => { this.ensureIdle(); new ImportQueue(s).discard(id.parse(queueId), z.number().int().nonnegative().parse(revision)); },
        inspectQueuedFile: (queueId, entryId) => this.withTask(async () => {
          const abort = new AbortController(); this.current = { kind: 'import', abort };
          this.progress({ ...this.latestProgress, phase: '导入体检', message: '正在体检所选文件，停止后清单仍保留。' });
          try { return await new ImportQueue(s).inspect(id.parse(queueId), id.parse(entryId), abort.signal); }
          finally { this.latestProgress = { ...this.latestProgress, phase: 'idle', message: abort.signal.aborted ? '体检已停止，清单已保留。' : '本次体检已结束，请查看导入清单。' }; }
        }),
        importNextQueuedFile: queueId => this.withTask(async () => {
          const abort = new AbortController(); this.current = { kind: 'import', abort };
          this.progress({ ...this.latestProgress, phase: '导入', message: '正在导入下一文件，成功结果与整册一起保存。' });
          try { return await new ImportQueue(s).importNext(id.parse(queueId), abort.signal); }
          finally {
            this.latestProgress = { ...this.latestProgress, phase: 'idle', message: abort.signal.aborted ? '导入已停止，已提交整册与剩余清单保留。' : '本次导入已结束，请查看实际结果。' };
            this.changed('series');
          }
        }),
        listSeries: () => s.projects.listSeries(),
        getSeries: (sid) => s.projects.getSeries(id.parse(sid)),
        deleteSeries: (sid) => { const seriesId = id.parse(sid); s.transaction(() => { s.projects.deleteSeries(seriesId); pruneLongNaturalnessCheckpoints(s); }); if (this.settings.ui.currentSeriesId === seriesId) this.settings.setUi({ currentSeriesId: null, currentVolumeId: null }); this.changed('series'); },
        inspectImport: (path) => this.withTask(async () => {
          const abort = new AbortController(); this.current = { kind: 'import', abort };
          const data = new Uint8Array(await readFile(path, { signal: abort.signal }));
          return inspectImport(s, basename(path), data, abort.signal);
        }),
        cancelImport: async () => { if (this.current?.kind === 'import') this.current.abort.abort(); },
        importFile: async (path, opts) => this.withTask(async () => {
          const abort = new AbortController(); this.current = { kind: 'import', abort };
          const data = new Uint8Array(await readFile(path, { signal: abort.signal }));
          abort.signal.throwIfAborted();
          if (!/\.(epub|txt)$/i.test(path)) throw new Error('仅支持 EPUB 或 TXT 文件。');
          const name = basename(path);
          const r = /\.epub$/i.test(name) ? await importEpub(s, name, data, { ...opts, signal: abort.signal }) : importTxt(s, name, data, { ...opts, signal: abort.signal });
          this.changed('series', 'paragraphs');
          return { seriesId: r.seriesId, volumeId: r.volumeId, chapters: r.chapters, paragraphs: r.paragraphs, blocks: r.blocks, unparseable: r.unparseable, missingTocResources: r.missingTocResources, tocMapped: r.tocMapped, tocTotal: r.tocTotal, reusedExisting: r.reusedExisting };
        }),
        listVolumes: (sid) => s.projects.listVolumes(id.parse(sid)),
        rebuildEpubChapters: async (vid) => {
          const volumeId=id.parse(vid);this.ensureIdle();if(this.drainingRepairs)throw new Error('后台修复尚未结束，请稍后整理章节');
          return this.withMaintenance(async checkpoint=>{
            const result=await rebuildEpubChapters(s,volumeId,()=>this.verifiedSafetyBackup('before-chapter-rebuild',checkpoint),checkpoint);
            if(result.changed)this.changed('series','paragraphs','queue','knowledge');
            return result;
          }, { preserveLibraryIdentity: true });
        },
        listChapters: (vid) => s.projects.listChapters(id.parse(vid)),
        referenceTranslations: (vid) => s.archives.referenceTranslations(id.parse(vid)),
        listParagraphs: cid => this.readViews.read('chapter', id.parse(cid)),
        listParagraphsByVolume: vid => this.readViews.read('volume', id.parse(vid)),
        getParagraph: (pid) => { const p = s.projects.getParagraphView(id.parse(pid)); return p ? withAuditStatus(s, [p])[0]! : null; },
        getSettings: (sid) => s.projects.getSettings(id.parse(sid)),
        setSetting: (sid, key, value) => { s.projects.setSetting(id.parse(sid), key, value as ProjectSettings[typeof key]); this.changed('settings'); return s.projects.getSettings(sid); },
        analysis: (pid) => {
          const a = s.projects.getAnalysis(id.parse(pid)); if (!a) return null;
          const nm = (cid: string): string => { const c = s.knowledge.getCharacter(cid); return c ? (c.canonical_name_zh ? `${c.canonical_name_zh}（${c.canonical_name_jp}）` : c.canonical_name_jp) : cid; };
          const arr = (j: string | null): string[] => { try { const v = JSON.parse(j ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
          return { speakerId: a.speaker_char_id, speakerName: a.speaker_char_id ? nm(a.speaker_char_id) : null, speakerConfidence: a.speaker_confidence, targets: arr(a.target_char_ids).map(nm), present: arr(a.present_char_ids).map(nm), intent: a.intent, difficultyFlags: arr(a.difficulty_flags), evidenceIds: arr(a.evidence_ids) };
        },
        prepStatus: vid => this.readViews.read('prep', id.parse(vid)),
      },
      workflow: {
        deliveryState: sid => deliveryState(this.store, id.parse(sid)),
        deliverSeries: (sid,request) => {
          this.ensureIdle(); this.ensureProvider();
          const seriesId=id.parse(sid);
          const parsed=request===undefined?undefined:z.object({mode:z.enum(['zh','bilingual']),outputPath:z.string().min(1),continueAfterDecisions:z.boolean().optional()}).parse(request);
          const config=parsed??deliveryState(this.store,seriesId);
          if (config?.continueAfterDecisions) this.automaticDeliveries.add(seriesId);else this.automaticDeliveries.delete(seriesId);
          this.pendingDeliveryContinuations.delete(seriesId);
          return this.runDelivery(seriesId,parsed ? {mode:parsed.mode,outputPath:parsed.outputPath,...(parsed.continueAfterDecisions===undefined?{}:{continueAfterDecisions:parsed.continueAfterDecisions})} : undefined);
        },
        seriesRunState: sid => seriesRunState(this.store, id.parse(sid)),
        continueSeries: sid => this.withTask(async () => {
          this.ensureProvider();
          const abort = new AbortController();
          this.current = { kind: 'prep', run: new PrepRunner(this.store, this.ai, { signal: abort.signal }), abort };
          try { return await runSeriesFlow(this.store, this.ai, id.parse(sid), { signal: abort.signal, onState: state => {
            this.progress({ ...this.latestProgress, running: true, phase: '连续处理全部册', detail: state.currentRun?.detail ?? null, done: state.done, total: state.total, message: state.message, costUsd: 0, ...state.usage });
          } }); }
          finally { this.changed('paragraphs', 'queue', 'series', 'knowledge', 'glossary'); }
        }),
        volumeOverview: (vid) => volumeOverview(this.store, id.parse(vid)),
        volumeRunState: (vid) => volumeRunState(this.store, id.parse(vid)),
        continueVolume: (vid) => this.withTask(async () => {
          this.ensureProvider();
          const abort = new AbortController();
          this.current = { kind: 'prep', run: new PrepRunner(this.store, this.ai, { signal: abort.signal }), abort };
          try { return await runVolumeFlow(this.store, this.ai, id.parse(vid), { signal: abort.signal, onState: state => {
            this.progress({ ...this.latestProgress, running: true, phase: '连续处理本册', detail: state.detail ?? null, done: state.done, total: state.total, message: state.message, costUsd: 0, inputTokens: state.usage?.inputTokens ?? 0, outputTokens: state.usage?.outputTokens ?? 0, unknownUsageRequests: state.usage?.unknownUsageRequests ?? 0 });
          } }); }
          finally { this.changed('paragraphs', 'queue', 'series', 'knowledge', 'glossary'); }
        }),
        resetTrajectoryRepairs: async vid => {
          this.ensureIdle();
          const { resetFailedTrajectoryRepairs } = await import('@core/workflow/trajectoryRepair');
          const { resetLocalRepairs } = await import('@core/workflow/repairAttempts');
          this.ensureIdle();
          return this.store.transaction(() => resetFailedTrajectoryRepairs(this.store, id.parse(vid)) + resetLocalRepairs(this.store, id.parse(vid)));
        },
        pendingRepairs: () => new RepairQueue(this.store).counts(),
        resumeRepairs: async () => { this.ensureIdle(); this.ensureProvider(); this.stopRepairs = false; await this.drainRepairs(); this.changed('queue', 'paragraphs'); },
        preRead: (vid, cids) => this.runPrep(r => r.preRead(id.parse(vid), cids ?? this.prepChapterScope('preread', id.parse(vid)))),
        extractTerms: (vid, cids) => this.runPrep(r => r.extractTerms(id.parse(vid), cids ?? this.prepChapterScope('terms', id.parse(vid)))),
        analyzeScenes: (vid, cid) => this.runPrep(r => {
          const pids = cid ? s.projects.listParagraphIdsByChapter(cid) : s.projects.listParagraphIdsByVolume(id.parse(vid));
          // 缺失或原文已变化的分析需要补做；全部有效时显式重跑。
          const missing = pids.filter(p => !s.projects.sceneObservation(p));
          if (missing.length > 0 && missing.length < pids.length) { s.translations.log({ level: 'info', message: `场景分析：只补 ${missing.length} 个缺失或失效的段落（已有 ${pids.length - missing.length} 段有效结果保留）；如需整体重跑，请等全部完成后再点「重新运行」` }); return r.analyzeScenes(missing); }
          return r.analyzeScenes(pids);
        }),
        resolveHonorifics: (sid) => this.runPrep(r => r.resolveAllPendingHonorifics(id.parse(sid))),
        prescanHonorifics: (vid) => this.runPrep(r => r.prescanHonorifics(id.parse(vid))),
        localizeNarrative: (sid) => this.withTask(async () => {
          this.ensureProvider();
          const seriesId = id.parse(sid);
          const abort = new AbortController();
          const prep = new PrepRunner(this.store, this.ai, { onProgress: this.progress, signal: abort.signal });
          this.current = { kind: 'prep', run: prep, abort };
          try {
            const { localizeNarrativeData } = await import('@core/workflow/narrativeLocalizer');
            const stats = await localizeNarrativeData(this.store, this.ai, seriesId, { onProgress: this.progress, signal: abort.signal });
            return { events: stats.events, relationships: stats.relationships };
          } finally {
            this.current = null;
            this.changed('knowledge');
          }
        }),
        checkLocalizationStatus: async (sid) => {
          const { checkLocalizationStatus } = await import('@core/workflow/narrativeLocalizer');
          return checkLocalizationStatus(this.store, id.parse(sid));
        },
        translate: (target, opts) => this.runPipeline(this.paragraphIdsOf(target), { ...opts, ...(target.paragraphIds ? { skipConfirmed: false } : {}) }),
        retranslateRechecks: (vid) => {
          const pids = s.projects.listParagraphIdsByVolume(id.parse(vid));
          const targets = s.translations.pendingRechecks(pids).map(r => r.paragraph_id);
          if (!targets.length) throw new Error('没有待回查段落');
          for (const t of targets) s.translations.unconfirmFinal(t);
          return this.runPipeline(targets, { phase: '回查重译', forceFullReview: true });
        },
        autoArbitrate: (sid) => this.withTask(async () => {
          this.ensureProvider();
          const seriesId = id.parse(sid);
          // 1. 同步仲裁（有修复稿/确认无误的自动消化）
          const sync = new AutoArbiter(s).arbitrateAll(seriesId);
          // 2. 异步重译仲裁（无修复稿且被 flag 的，AI 带诊断重译，过校验才定稿），可取消
          const abort = new AbortController();
          this.current = { kind: 'prep', run: new PrepRunner(this.store, this.ai, { signal: abort.signal }), abort };
          let async = { finalized: 0, stillPending: 0, details: [] as string[] };
          try { async = await new AutoArbiter(s).arbitrateAsync(seriesId, this.ai, abort.signal); }
          finally {
            this.current = null;
            this.changed('queue', 'paragraphs', 'glossary', 'knowledge');
          }
          return { autoResolved: sync.autoResolved, adoptedFix: sync.adoptedFix, leftForHuman: sync.leftForHuman, preselected: sync.preselected, asyncFinalized: async.finalized, asyncStillPending: async.stillPending, details: async.details };
        }),
        pause: () => { if (this.current?.kind === 'pipeline') this.current.run.pause(); },
        resume: () => { if (this.current?.kind === 'pipeline') this.current.run.resume(); },
        cancel: () => { this.stopRepairs = true; this.cancelCurrent(); },
        progress: () => ({ ...this.latestProgress, running: this.tasks.busy }),
      },
      translation: {
        reverifyVolume: (vid) => this.withTask(async () => {
          this.ensureProvider();
          const abort = new AbortController();
          this.current = { kind: 'prep', run: new PrepRunner(this.store, this.ai, { signal: abort.signal }), abort };
          const targets = pendingFinalReviews(this.store, id.parse(vid));
          let passed = 0, pending = 0;
          try {
            const { reverifyFinal } = await import('@core/workflow/reverifyFinal');
            for (const pid of targets) {
              abort.signal.throwIfAborted();
              this.progress({ ...this.latestProgress, running: true, phase: '复核本册现有稿', total: targets.length, done: passed + pending, currentParagraphId: pid, message: `正在复核第 ${passed + pending + 1}/${targets.length} 段` });
              try { const result = await reverifyFinal(this.store, this.ai, pid, abort.signal); result.ok ? passed++ : pending++; }
              catch (error) { abort.signal.throwIfAborted(); pending++; this.store.translations.log({ level: 'warning', paragraphId: pid, message: `当前稿复核失败，原稿保留：${(error as Error).message}` }); }
            }
            this.progress({ ...this.latestProgress, running: true, done: passed + pending, message: `复核完成：${passed} 段通过，${pending} 段待处理` });
            return { passed, pending };
          } finally { this.changed('paragraphs', 'queue'); }
        }),
        reverify: (pid) => this.withTask(async () => {
          this.ensureProvider();
          const abort = new AbortController();
          this.current = { kind: 'prep', run: new PrepRunner(this.store, this.ai, { signal: abort.signal }), abort };
          try { const { reverifyFinal } = await import('@core/workflow/reverifyFinal'); return await reverifyFinal(this.store, this.ai, id.parse(pid), abort.signal); }
          finally { this.changed('paragraphs', 'queue'); }
        }),
        editFinal: (pid, text, confirm, base) => { new DecisionService(s).editFinal(id.parse(pid), z.string().parse(text), confirm, base === undefined ? undefined : z.object({ version: z.number().int().nonnegative(), sourceText: z.string() }).parse(base)); this.changed('paragraphs'); return s.projects.getParagraphView(pid)!; },
        confirm: (pids) => { const n = new DecisionService(s).confirm(ids.parse(pids)); this.changed('paragraphs', 'series'); return n; },
        unconfirm: (pids) => { new DecisionService(s).unconfirm(ids.parse(pids)); this.changed('paragraphs', 'series'); },
        findings: (pid) => s.translations.openFindings(id.parse(pid)).map(f => ({ id: f.id, workstationId: f.workstation_id, type: f.finding_type, severity: f.severity, description: f.description, evidenceJp: f.evidence_jp, evidenceZh: f.evidence_zh, suggestedFix: f.suggested_fix })),
        candidates: (pid) => s.db.all<{ workstation_id: string; candidate_text: string; created_at: string }>('SELECT workstation_id, candidate_text, created_at FROM translation_candidates WHERE paragraph_id=? ORDER BY created_at DESC LIMIT 10', [id.parse(pid)]).map(c => ({ workstationId: c.workstation_id, text: c.candidate_text, createdAt: c.created_at })),
        context: (pid) => ({ before: s.projects.previousParagraphs(id.parse(pid), 4).map(b => ({ id: b.id, source: b.sourceText, final: b.finalText })), after: s.projects.nextParagraphs(pid, 2).map(a => ({ id: a.id, source: a.sourceText })) }),
      },
      review: {
        list: (sid, status, vid) => scopedReview(s, id.parse(sid), status ?? 'pending', vid ? id.parse(vid) : undefined),
        counts: (sid, vid) => { const out: Record<string, number> = {}; for (const q of scopedReview(s, id.parse(sid), 'pending', vid ? id.parse(vid) : undefined)) out[q.kind] = (out[q.kind] ?? 0) + 1; return out; },
        decide: async (qid, decision) => {
          this.ensureIdle();
          const deliveryOwned=this.deliveryOwnsDecision(qid);
          const r = s.transaction(() => {
            const outcome = new DecisionService(s).apply(id.parse(qid), decision as Decision);
            if (outcome.ok) for (const paragraphId of outcome.retranslate) new RepairQueue(s).enqueue(qid, paragraphId);
            return outcome;
          });
          this.changed('queue', 'paragraphs', 'glossary', 'knowledge', 'series');
          if (r.ok && r.retranslate.length && !deliveryOwned) { this.stopRepairs = false; this.scheduleRepairs(); }
          if (r.ok) this.queueDeliveryAfterDecision(qid);
          return r;
        },
        resolveHonorific: async (qid) => {
          await this.runPrep(run => run.resolveHonorific(id.parse(qid)));
          this.changed('queue', 'knowledge');
          const item = s.translations.getQueueItem(qid);
          return item ? s.translations.listQueue(item.series_id).find(q => q.id === qid) ?? null : null;
        },
        undoResolved: (qid) => { this.ensureIdle(); undoResolvedReview(s,id.parse(qid)); this.changed('queue','knowledge','paragraphs','glossary'); },
        previewLegacyChange: (qid, sid, evidenceIds) => {
          this.ensureIdle();
          if (this.drainingRepairs) throw new Error('后台修复尚未结束，请先停止或等待完成');
          return previewLegacyChangeRecovery(s, id.parse(qid), id.parse(sid), ids.min(1).max(100).parse(evidenceIds));
        },
        reconfirmLegacyChange: (qid, sid, decision) => {
          this.ensureIdle();
          if (this.drainingRepairs) throw new Error('后台修复尚未结束，请先停止或等待完成');
          const parsed = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), evidenceIds: ids.min(1).max(100), reason: z.string().trim().min(1).max(10000), validToPara: z.number().int().nonnegative().safe().nullable() }).strict().parse(decision);
          // Local synchronous transaction: no task scheduling, model call or maintenance identity reset.
          const result = reconfirmLegacyChange(s, id.parse(qid), id.parse(sid), parsed);
          this.stopRepairs = true;
          if (this.repairTimer) clearTimeout(this.repairTimer);
          this.repairTimer = null;
          this.changed('queue', 'knowledge', 'glossary', 'paragraphs', 'series');
          return result;
        },
        undoLegacyReconfirmation: (qid, sid) => {
          this.ensureIdle();
          if (this.drainingRepairs) throw new Error('后台修复尚未结束，请先停止或等待完成');
          undoLegacyChangeReconfirmation(s, id.parse(qid), id.parse(sid));
          this.stopRepairs = true;
          if (this.repairTimer) clearTimeout(this.repairTimer);
          this.repairTimer = null;
          this.changed('queue', 'knowledge', 'glossary', 'paragraphs', 'series');
        },
        aiReview: async (sid) => this.withTask(async () => {
          this.ensureProvider();
          const abort = new AbortController();
          this.current = { kind: 'prep', run: new PrepRunner(this.store, this.ai, { signal: abort.signal }), abort };
          const seriesId = id.parse(sid);
          const items = s.translations.listQueue(seriesId, 'pending');
          if (items.length === 0) return { reviewed: 0, recommendations: {} };

          s.translations.log({ level: 'info', message: `开始AI辅助审核 ${items.length} 个复核项` });
          const { reviewBatch } = await import('@core/workflow/reviewAuditor');
          const config = this.settings.toPreprocessingConfig();

          const recommendations = await reviewBatch(items, config, (done, total) => {
            s.translations.log({ level: 'info', message: `AI审核进度：${done}/${total}` });
          }, abort.signal);

          // 将推荐写入数据库
          const results: Record<string, { action: 'accept' | 'reject' | 'uncertain'; confidence: number; reason: string }> = {};
          for (const [itemId, rec] of recommendations) {
            const item = s.translations.getQueueItem(itemId);
            if (!item) continue;

            // 确保payload是有效的JSON对象
            let payload: Record<string, unknown>;
            try {
              payload = item.payload;
            } catch {
              payload = {};
            }

            // 创建一个纯数据对象，避免序列化问题
            payload.aiRecommendation = {
              action: rec.action,
              confidence: rec.confidence,
              reason: rec.reason,
              suggestedFix: rec.suggestedFix || undefined
            };

            try {
              s.db.run(`UPDATE review_queue SET payload=? WHERE id=?`, [JSON.stringify(payload), itemId]);
              results[itemId] = { action: rec.action, confidence: rec.confidence, reason: rec.reason };
            } catch (e) {
              s.translations.log({ level: 'warning', message: `保存AI推荐失败（${itemId}）：${(e as Error).message}` });
            }
          }

          this.changed('queue');
          s.translations.log({ level: 'success', message: `AI审核完成：${recommendations.size} 个复核项` });
          return { reviewed: recommendations.size, recommendations: results };
        }),
        runScoped: (input) => this.withTask(async () => {
          if (this.drainingRepairs) throw new Error('后台修复尚未结束，请先停止或等待完成');
          const { request, items } = captureReviewOperation(this.store, input);
          const needsModel = request.operation === 'ai-review' || request.operation === 'generate-honorific' || (request.operation === 'arbitrate' && items.some(item => item.kind === 'review-block'));
          if (needsModel) this.ensureProvider();
          // This operation must not wake previously queued work in other books.
          this.stopRepairs = true;
          if (this.repairTimer) clearTimeout(this.repairTimer);
          this.repairTimer = null;
          const abort = new AbortController();
          this.current = { kind: 'prep', run: new PrepRunner(this.store, this.ai, { signal: abort.signal }), abort };
          try {
            const result = await runScopedReviewOperation(this.store, request, {
              ai: this.ai, config: this.settings.toPreprocessingConfig(), signal: abort.signal,
              onProgress: (done, total, entry) => this.progress({ ...this.latestProgress, running: true, phase: '分类审核', done, total, message: entry.message }),
            });
            if (request.operation === 'retry') {
              const selected = new Set(request.scope.ids);
              for (const entry of result.items.filter(entry => entry.status === 'succeeded')) {
                const item = items.find(item => item.id === entry.id)!;
                if (abort.signal.aborted) { entry.status = 'cancelled'; entry.message = '已停止，重试仍在队列等待明确继续'; result.cancelled = true; continue; }
                try {
                  this.ensureProvider();
                  if (s.translations.listQueue(request.scope.seriesId).some(other => other.paragraphId === item.paragraphId && !selected.has(other.id))) throw new Error('同段出现未选择问题，未重译');
                  const run = new TranslationPipeline(s, this.ai, { separateInlineLayout: true, skipConfirmed: false, forceFullReview: true, onProgress: this.progress });
                  const stop = () => run.cancel(); abort.signal.addEventListener('abort', stop, { once: true });
                  const previous = s.translations.latestFinal(item.paragraphId!)?.id;
                  try { await run.run([item.paragraphId!], '分类失败重译'); }
                  finally { abort.signal.removeEventListener('abort', stop); }
                  abort.signal.throwIfAborted();
                  const final = s.translations.latestFinal(item.paragraphId!);
                  if (!final || final.id === previous || auditStatus(s, final) !== 'valid' || s.translations.openFindings(item.paragraphId!).some(f => f.severity === 'blocks_export')) throw new Error('重译未通过完整核验，失败项保留');
                  s.transaction(() => {
                    s.translations.resolveQueueItem(item.id, JSON.stringify({ action: 'verified-retry', finalId: final.id }));
                    s.db.run("UPDATE workflow_tasks SET status='done', error_message=NULL WHERE id=?", [`repair:${item.id}:${item.paragraphId}`]);
                  });
                  entry.message = '选中段落已重译并完整核验；其他册待办未启动';
                } catch (error) {
                  entry.status = abort.signal.aborted ? 'cancelled' : 'failed'; result.cancelled ||= abort.signal.aborted;
                  entry.message = abort.signal.aborted ? '已停止，原失败项保留' : this.errorMessage(error);
                  s.db.run("UPDATE workflow_tasks SET status=?, error_message=? WHERE id=?", [abort.signal.aborted ? 'queued' : 'failed', entry.message, `repair:${item.id}:${item.paragraphId}`]);
                }
              }
            }
            if (!result.cancelled && (request.operation==='confirm-preselected' || request.operation==='confirm-ai')) {
              for (const entry of result.items) if (entry.status==='succeeded') this.queueDeliveryAfterDecision(entry.id);
            }
            return result;
          } finally { this.changed('queue', 'paragraphs', 'glossary', 'knowledge', 'series'); }
        }),
        setPreselect: (qid, zh) => {
          this.ensureIdle();
          const item = s.translations.getQueueItem(id.parse(qid));
          if (!item || item.status !== 'pending' || (item.kind !== 'term-proposal' && item.kind !== 'ambiguity' && item.kind !== 'honorific-first')) throw new Error('复核项已变化或不支持预选，请刷新');
          const v = z.string().trim().min(1).parse(zh);
          const pl = item.payload as Record<string, unknown>;
          if (pl.preSelected === v) return;
          s.translations.updateQueuePayload(item.id, { ...pl, preSelected: v, preSelectedBasis: '人工改选' });
          // 不 emit data-changed('queue')：避免用户正在输入时列表刷新打断；ReviewPage 本地同步 payload
        },
      },
      glossary: {
        list: (sid) => s.glossary.listTermViews(id.parse(sid)),
        upsert: (sid, t) => {
          const seriesId = id.parse(sid); const termJp = z.string().min(1).parse(t.termJp);
          s.glossary.upsertTerm({ seriesId, introducedVolume: t.introducedVolume ?? 1, termJp, termZh: t.termZh, termType: t.termType, senseIdentity: t.senseIdentity ?? null, ...(t.lockLevel ? { lockLevel: t.lockLevel } : {}), notes: t.notes ?? null });
          // 术语表里给人名填了译名 → 同步到人物档案中文名（档案为空时）
          if (s.knowledge.syncNameZhFromTerm(seriesId, termJp, t.termZh ?? null)) this.changed('knowledge');
          this.changed('glossary'); return s.glossary.listTermViews(sid);
        },
        setLock: (tid, lock) => { s.glossary.setLockLevel(id.parse(tid), lock as LockLevel); this.changed('glossary'); },
        remove: (tid) => { s.glossary.deleteTerm(id.parse(tid)); this.changed('glossary'); },
        addSense: (tid, zh, gloss, hint) => { s.glossary.addSense(id.parse(tid), z.string().min(1).parse(zh), gloss, hint, true); this.changed('glossary'); },
        setDefaultSense: (tid, sid) => { s.glossary.setDefaultSense(id.parse(tid), id.parse(sid)); this.changed('glossary'); },
        removeSense: (sid) => { s.glossary.deleteSense(id.parse(sid)); this.changed('glossary'); },
        occurrences: (tid) => s.glossary.listOccurrences(id.parse(tid)),
        importCsv: async (sid, csv) => this.withTask(async () => {
          this.ensureProvider();
          const seriesId = id.parse(sid); let added = 0, updated = 0; const errors: string[] = [];
          const existing = new Set(s.glossary.activeTerms(seriesId).map(t => t.term_jp));

          // AI识别CSV结构
          let mapping: { termJp?: number; termZh?: number; termType?: number; lockLevel?: number; notes?: number; confidence: number; reason: string } | null = null;
          try {
            const { recognizeCsvStructure } = await import('@core/workflow/csvRecognizer');
            const config = this.settings.toPreprocessingConfig();
            mapping = await recognizeCsvStructure(csv, config);
            s.translations.log({ level: 'info', message: `CSV格式识别：${mapping.reason}（置信度 ${(mapping.confidence * 100).toFixed(0)}%）` });
          } catch (e) {
            s.translations.log({ level: 'warning', message: `CSV格式识别失败：${(e as Error).message}，使用默认映射` });
          }

          s.db.transaction(() => {
            csv.split(/\r?\n/).forEach((line, i) => {
              if (!line.trim() || (i === 0 && /^(原文|term_jp|日文)/i.test(line))) return;
              const cols = line.split(/[,\t，]/).map(c => c.trim().replace(/^"|"$/g, ''));

              // 使用AI识别的映射或默认映射
              const jp = cols[mapping?.termJp ?? 0];
              const zh = cols[mapping?.termZh ?? 1] || null;
              const type = cols[mapping?.termType ?? 2] || 'concept';
              const lock = cols[mapping?.lockLevel ?? 3] || '';
              const notes = cols[mapping?.notes ?? 4] || null;

              if (!jp) { errors.push(`第 ${i + 1} 行：缺原文`); return; }
              const lockLevel: LockLevel = lock === 'hard-locked' || lock === '硬锁定' ? 'hard-locked' : lock === 'suggested' || lock === '建议' ? 'suggested' : 'confirmed';
              s.glossary.upsertTerm({ seriesId, introducedVolume: 1, termJp: jp, termZh: zh, termType: type, lockLevel: zh ? lockLevel : 'suggested', notes });
              existing.has(jp) ? updated++ : added++;
            });
          });
          this.changed('glossary'); return { added, updated, errors };
        }),
        exportCsv: (sid) => ['原文,译文,类型,锁定,备注', ...s.glossary.listTermViews(id.parse(sid)).map(t => [t.termJp, t.termZh ?? '', t.termType, t.lockLevel, (t.notes ?? '').replace(/[\r\n,]/g, ' ')].map(c => `"${c.replace(/"/g, '""')}"`).join(','))].join('\n'),
      },
      knowledge: {
        history: cid => characterKnowledgeHistory(s.db, id.parse(cid)),
        automaticFieldDecisions: cid => automaticFieldDecisions(s,id.parse(cid)),
        undoAutomaticFieldDecision: (cid,qid) => { this.ensureIdle(); undoAutomaticFieldDecision(s,id.parse(cid),id.parse(qid)); this.changed('queue','knowledge','paragraphs'); },
        fieldDecisions: cid => s.knowledge.fieldDecisions(id.parse(cid)),
        undoFieldDecision: (cid, decisionId) => { this.ensureIdle(); s.knowledge.undoFieldDecision(id.parse(cid), z.number().int().positive().parse(decisionId)); this.changed('knowledge', 'paragraphs'); },
        characters: (sid) => s.knowledge.listCharacterViews(id.parse(sid)),
        upsertCharacter: (sid, c) => {
          const seriesId = id.parse(sid);
          const cid = c.id ?? s.knowledge.upsertCharacter({ seriesId, introducedVolume: c.introducedVolume ?? 1, nameJp: z.string().min(1).parse(c.nameJp), nameZh: c.nameZh ?? null, gender: c.gender ?? null, firstPersonType: c.firstPersonType ?? null, speechRegister: c.speechRegister ?? null, voiceNotes: c.voiceNotes ?? null });
          if (c.id) { const patch = Object.fromEntries(Object.entries({ nameZh: c.nameZh, gender: c.gender, firstPersonType: c.firstPersonType, speechRegister: c.speechRegister, voiceNotes: c.voiceNotes, lockedByUser: c.lockedByUser, isActive: c.isActive }).filter(([, v]) => v !== undefined)); s.knowledge.updateCharacter(cid, patch); if (c.nameJp) s.db.run('UPDATE characters SET canonical_name_jp=? WHERE id=?', [c.nameJp, cid]); }
          else if (c.lockedByUser) s.knowledge.updateCharacter(cid, { lockedByUser: true });
          this.changed('knowledge'); return s.knowledge.listCharacterViews(seriesId);
        },
        setQuirks: (cid, quirks) => { s.knowledge.setQuirks(id.parse(cid), quirks as QuirkProfile[]); this.changed('knowledge'); },
        aliases: (cid) => s.knowledge.aliasesOf(id.parse(cid)),
        addAlias: (cid, alias) => { s.knowledge.addAlias(id.parse(cid), z.string().min(1).parse(alias), 'user'); this.changed('knowledge'); },
        relationships: (sid): RelationshipView[] => s.knowledge.relationshipViews(id.parse(sid)).map(r => ({ id: r.id, sourceStatus: narrativeSourceStatus(s.db, 'relationship', r.id), fromId: r.from_char_id, fromName: r.from_name, toId: r.to_char_id, toName: r.to_name, eventType: r.event_type, description: r.description_zh ?? r.description_jp, intimacy: r.intimacy_level, respect: r.respect_level, powerDistance: r.power_distance, formality: r.formality_level, validFromPara: r.valid_from_para, validToPara: r.valid_to_para })),
        mergeCharacters: (keepId, dropId) => {
          const keep = s.knowledge.getCharacter(id.parse(keepId)); if (!keep) throw new Error('人物不存在');
          const r = s.knowledge.mergeCharacters(keep.id, id.parse(dropId));
          s.translations.log({ level: 'info', message: `人物合并：${r.aliasAdded ?? dropId} → ${keep.canonical_name_jp}` });
          this.changed('knowledge', 'paragraphs', 'queue');
          return s.knowledge.listCharacterViews(keep.series_id);
        },
        setCanonicalName: (cid, name) => { const c = s.knowledge.getCharacter(id.parse(cid)); if (!c) throw new Error('人物不存在'); s.knowledge.setCanonicalName(c.id, z.string().min(1).parse(name)); this.changed('knowledge', 'paragraphs'); return s.knowledge.listCharacterViews(c.series_id); },
        removeAlias: (cid, alias) => { s.knowledge.removeAlias(id.parse(cid), z.string().min(1).parse(alias)); this.changed('knowledge'); },
        repairNames: (sid) => { const r = s.knowledge.repairGenericNames(id.parse(sid)); if (r.promoted.length || r.deactivated.length || r.aliasesRemoved) { s.translations.log({ level: 'info', message: `档案清理：主名修正 ${r.promoted.join('、') || '无'}；标记失效 ${r.deactivated.join('、') || '无'}；移除代词/职称别名 ${r.aliasesRemoved}` }); this.changed('knowledge', 'paragraphs'); } return r; },
        addresses: (sid) => s.knowledge.listAddressViews(id.parse(sid)),
        events: (sid) => {
          const seriesId = id.parse(sid);
          const rows = s.db.all<{ id: string; summary: string; at_para: number; reveals_to_reader: number; character_ids: string | null; chapter_label: string | null }>(`
            SELECT e.id, COALESCE(e.summary_zh, e.summary_jp) AS summary, e.at_para, e.reveals_to_reader, e.character_ids,
              (SELECT '第' || c.chapter_number || '章 §' || p.para_ordinal FROM paragraphs p JOIN scenes sc ON sc.id=p.scene_id JOIN chapters c ON c.id=sc.chapter_id JOIN volumes vv ON vv.id=c.volume_id WHERE vv.series_id=e.series_id AND p.series_ordinal=e.at_para LIMIT 1) chapter_label
            FROM narrative_events e WHERE e.series_id=? ORDER BY e.at_para`, [seriesId]);
          const nm = (cid: string): string => { const c = s.knowledge.getCharacter(cid); return c ? (c.canonical_name_zh ?? c.canonical_name_jp) : cid; };
          return rows.map(r => { let ids: string[] = []; try { const v = JSON.parse(r.character_ids ?? '[]'); if (Array.isArray(v)) ids = v.map(String); } catch { /* ignore */ } return { id: r.id, sourceStatus: narrativeSourceStatus(s.db, 'event', r.id), summary: r.summary, atPara: r.at_para, revealsToReader: !!r.reveals_to_reader, characterNames: ids.map(nm), chapterLabel: r.chapter_label }; });
        },
        addAddress: (sid, a) => { s.knowledge.addAddress({ seriesId: id.parse(sid), speakerCharId: a.speakerId, targetCharId: a.targetId, sourceFormJp: a.sourceFormJp, translatedForm: a.translatedForm, relationStage: a.relationStage ?? null, allowVariation: !!a.allowVariation, validFromPara: a.validFromPara, confirmedByUser: true }); this.changed('knowledge'); },
        setAddressVariation: (aid, allow) => { s.knowledge.setAddressVariation(id.parse(aid), allow); this.changed('knowledge'); },
        endAddress: (aid, at) => { s.knowledge.endAddress(id.parse(aid), at); this.changed('knowledge'); },
      },
      export: {
        seriesQualityGate: sid => seriesExportCheck(s, id.parse(sid)),
        runSeries: (sid, mode, outputPath) => this.withTask(async () => {
          const abort = new AbortController();
          this.current = { kind: 'prep', run: new PrepRunner(s, this.ai, { signal: abort.signal }), abort };
          this.progress({ ...this.latestProgress, running: true, phase: '导出全部册', done: 0, total: 0, message: '检查全部册并生成合集，完成后一次保存', inputTokens: 0, outputTokens: 0, costUsd: 0 });
          const result = await exportSeries(s, id.parse(sid), mode, outputPath, atomicWriteFile, abort.signal);
          this.latestProgress = { ...this.latestProgress, message: result.messages.join('；') };
          return result;
        }),
        qualityGate: (vid) => runQualityGate(s, id.parse(vid)),
        run: (vid, mode, outputPath, preview) => this.withTask(() => exportVolume(s, { volumeId: id.parse(vid), mode, outputPath, preview }, atomicWriteFile)),
      },
      logs: {
        recent: (after, limit) => s.translations.recentLogs(z.number().int().nonnegative().parse(after), z.number().int().min(1).max(1000).parse(limit ?? 200), true),
        page: options => s.translations.logPage(z.object({ beforeId: z.number().int().positive().optional(), level: z.enum(['all','warning','error']).optional(), workstation: z.string().max(100).optional(), search: z.string().max(500).optional() }).parse(options ?? {})),
        detail: (logId, offset) => s.translations.logDetail(z.number().int().positive().parse(logId), z.number().int().nonnegative().parse(offset ?? 0)),
        clear: () => { const count = s.translations.clearLogs(); this.lastLogId = s.translations.latestLogId(); return count; },
      },
    };
  }

  register(): void {
    const h = this.handlers() as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>;
    for (const ns of Object.keys(h)) for (const m of Object.keys(h[ns]!)) {
      ipcMain.handle(`${ns}.${m}`, async (_e, ...args: unknown[]) => {
        try {
          if ((this.maintenance || this.closing || this.disposed) && !['workflow.cancel', 'workflow.progress'].includes(`${ns}.${m}`)) throw new Error('正在维护数据，请稍后再试');
          if (['translation.editFinal', 'translation.confirm', 'project.deleteSeries', 'app.setProviderSettings', 'review.decide'].includes(`${ns}.${m}`)) this.ensureIdle();
          return await h[ns]![m]!(...args);
        }
        catch (e) {
          const msg = e instanceof z.ZodError ? `参数错误：${e.issues.map(i => i.message).join('；')}` : (e as Error).message;
          // 只把"用户动作"的失败写进任务日志；轮询/只读调用（usage、日志拉取、进度）失败不入库，
          // 否则日志页每收到一条日志就重拉 usage → 失败 → 又写一条 → 无限刷屏。连续重复的同一错误也只记一次。
          const key = `[${ns}.${m}] ${msg}`;
          if (!this.maintenance && !this.closing && !this.disposed && !NO_LOG_ON_ERROR.has(`${ns}.${m}`) && key !== this.lastErrorLogged) { this.lastErrorLogged = key; try { this.store.translations.log({ level: 'error', message: key }); } catch { /* 库不可用时放弃记日志 */ } }
          throw new Error(msg);
        }
      });
    }
  }
}
