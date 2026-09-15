import { quarantineInitialFields } from '../db/initialFieldTrust';
import { reviewInitialFields } from './initialFieldAttribution';
import { reviewRelationshipTerminations } from './relationshipTerminationReview';
import { termReviewMatcher } from './termConfirmation';
import { pruneGenerationResumes } from './generationResume';
import { reviewCharacterInvalidations } from './characterInvalidationReview';
import { exposeUnacceptedWarnings } from './reviewWarnings';
import { pruneLongParagraphCheckpoints } from './longParagraphCheckpoint';
import { pruneLongNaturalnessCheckpoints } from './longNaturalnessPlan';
import { longReadingBoundary } from './longReadingRecovery';
import { refreshAutomaticSources } from './automaticKnowledgeSources';
import { assertAcceptedChangeSources } from '../db/knowledgeChanges';
import { resolveAddressProposals } from './automaticAddressDecisions';
import { resolveParagraphAddressProposals } from './paragraphAddressDecisions';
import { resolveParagraphLiteralAddresses } from './paragraphLiteralAddresses';
import { resolveQuirkProposals } from './automaticQuirkDecisions';
import { reviewVolumeTrajectory } from './trajectoryReview';
import { reviewChapterReading } from './chapterReading';
import { repairChapterReadingIssues } from './chapterReadingRepair';
import { repairTrajectoryIssues } from './trajectoryRepair';
import { resolveTermProposals } from './automaticTermDecisions';
import { RunGuard, RunStopped, type RunLimits } from '../ai/runGuard';
import { pendingFieldConflicts } from './characterConflicts';
import { reviewFieldAttributions } from './fieldAttributionReview';
import { resolveCharacterKnowledge } from './automaticFieldDecisions';
import { createHash } from 'node:crypto';
import type { ProjectStore } from '@core/db';
import { nowIso } from '@core/db';
import type { AiClient } from '@core/ai';
import { PROMPT_VERSION } from '@core/ai';
import type { VolumeRunState } from '@shared/ipc';
import { PrepRunner } from './prepRunner';
import { TranslationPipeline } from './pipeline';
import { reverifyFinal } from './reverifyFinal';
import { AutoArbiter } from './autoArbiter';
import { assertRepairWorkAllowed } from './repairAttempts';
import { auditStatus } from './auditReceipts';
import { runQualityGate } from './qualityGate';
import { missingTermProposals } from './termPreparation';

const key = (volumeId: string) => `volume-run:${volumeId}`;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function volumeRunState(store: ProjectStore, volumeId: string): VolumeRunState | null {
  const row = store.db.get<{value: string}>('SELECT value FROM meta WHERE key=?', [key(volumeId)]);
  if (!row) return null;
  try { return JSON.parse(row.value) as VolumeRunState; } catch { return null; }
}
export function recoverVolumeRuns(store: ProjectStore): void {
  pruneGenerationResumes(store);
  pruneLongParagraphCheckpoints(store);
  pruneLongNaturalnessCheckpoints(store);
  for (const row of store.db.all<{key: string; value: string}>("SELECT key,value FROM meta WHERE key LIKE 'volume-run:%'")) {
    try {
      const state = JSON.parse(row.value) as VolumeRunState;
      if (state.status === 'running') store.db.run('UPDATE meta SET value=? WHERE key=?', [JSON.stringify({ ...state, status: 'stopped', message: '上次运行中断，点击继续处理本册', updatedAt: nowIso() }), row.key]);
    } catch { /* Invalid historical progress is ignored, never treated as completed. */ }
  }
}

export interface VolumeOperations {
  preRead(chapterIds: string[]): Promise<unknown>;
  terms(chapterIds: string[]): Promise<unknown>;
  scenes(paragraphIds: string[]): Promise<unknown>;
  honorifics(): Promise<unknown>;
  translate(paragraphId: string): Promise<unknown>;
  reverify(paragraphId: string): Promise<unknown>;
  repair?(paragraphId: string): Promise<unknown>;
}
export interface VolumeFlowOptions { limits?: Partial<RunLimits>; signal?: AbortSignal; onState?: (state: VolumeRunState) => void; operations?: VolumeOperations }

/** Resumable preparation and translation. A completed call is never assumed to be successful work. */
export async function runVolumeFlow(store: ProjectStore, ai: AiClient, volumeId: string, opts: VolumeFlowOptions = {}): Promise<VolumeRunState> {
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const ids = store.projects.listParagraphIdsByVolume(volumeId);
  const chapters = store.projects.listChapters(volumeId).map(c => c.id);
  const sourceHash = () => hash(ids.map(pid => store.projects.getParagraph(pid)));
  const sourceAtStart = sourceHash();
  const prior = volumeRunState(store, volumeId);
  let state: VolumeRunState = { volumeId, status: 'running', phase: 'preread', done: 0, total: ids.length, message: '准备本册任务', updatedAt: nowIso(), scanKey: prior?.scanKey ?? null, stopReason: null };
  const publish = (patch: Partial<VolumeRunState>, admission = false) => {
    const next = { ...state, ...(patch.phase && patch.phase !== state.phase ? { detail: null } : {}), ...patch, updatedAt: nowIso() };
    if (next.phase === 'translate') next.detail = { phase: 'translate', label: '翻译与逐段检查', done: next.done, total: next.total, unit: '段' };
    const persistAndNotify = () => {
      store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [key(volumeId), JSON.stringify(next)]);
      opts.onState?.(structuredClone(next));
    };
    if (admission) {
      // A synchronous veto must not persist an unsent request. Only writes in
      // this DB transaction are reversible, never external observer effects.
      store.db.transaction(persistAndNotify);
      state = next;
    } else {
      // Received usage is a fact, not a candidate: retain it even if notifying
      // an observer fails after persistence.
      state = next;
      persistAndNotify();
    }
  };
  const guard = new RunGuard(prior?.usage, { maxRequests: Math.max(1000, ids.length * 40 + chapters.length * 200), maxConsecutiveFailures: 3, ...opts.limits }, (usage, phase) => publish({ usage, ...(guard.stopped ? { stopReason: guard.stopped.reason } : {}) }, phase === 'admission'));
  const releaseGuard = ai.attachRunGuard(guard);
  state.usage = { ...guard.usage }; state.requestLimit = guard.limits.maxRequests;
  const check = () => {
    opts.signal?.throwIfAborted();
    guard.check();
    if (sourceHash() !== sourceAtStart || store.projects.listParagraphIdsByVolume(volumeId).join() !== ids.join() || store.projects.listChapters(volumeId).map(c => c.id).join() !== chapters.join()) throw new Error('本册原文范围已变化，请重新继续任务');
  };
  const begin = (patch: Partial<VolumeRunState>) => { publish(patch); check(); };
  const prep = new PrepRunner(store, ai, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    // PrepRunner's done/total are chapter-level. Forward its finer-grained
    // messages without pretending that a paragraph batch is translated work.
    onProgress: p => { if (p.message) publish({ message: p.message, detail: p.detail ?? (p.running && state.phase === 'scenes' ? { phase: state.phase, label: p.phase, done: p.done, total: p.total, unit: '段' } : null) }); },
  });
  const operations: VolumeOperations = opts.operations ?? {
    preRead: c => prep.preRead(volumeId, c), terms: c => prep.extractTerms(volumeId, c), scenes: p => prep.analyzeScenes(p), honorifics: () => prep.prescanHonorifics(volumeId),
    translate: async pid => {
      const pipeline = new TranslationPipeline(store, ai, { separateInlineLayout: true });
      const cancel = () => pipeline.cancel();
      opts.signal?.addEventListener('abort', cancel, { once: true });
      try { check(); return await pipeline.run([pid], '连续处理本册'); }
      finally { opts.signal?.removeEventListener('abort', cancel); }
    },
    reverify: pid => reverifyFinal(store, ai, pid, opts.signal),
    repair: pid => new AutoArbiter(store).arbitrateAsync(seriesId, ai, opts.signal, [pid]),
  };
  const attention = (message: string) => { publish({ status: 'attention', message }); return state; };
  const reverifyAutomatically = async (paragraphId: string) => {
    const final = store.translations.latestFinal(paragraphId);
    // Continuing the volume is not permission to pay for the same exhausted
    // case again. Explicit review stays separate; human drafts remain reviewable.
    if (final && !final.confirmed_by_user) assertRepairWorkAllowed(store, paragraphId);
    return operations.reverify(paragraphId);
  };
  try {
    publish({});
    check();
    if (!ids.length) return attention('本册没有可处理正文，请检查导入结果');
    quarantineInitialFields(store,seriesId);
    assertAcceptedChangeSources(store.db, seriesId);
    const refreshed = refreshAutomaticSources(store, seriesId);
    if (refreshed.blocked) return attention(`有 ${refreshed.blocked} 项自动知识来源已变化且存在后续修改，请先核对较新的决定，原数据已保留`);
    for (const [kind, phase, action] of [['preread', 'preread', operations.preRead], ['terms', 'terms', operations.terms]] as const) {
      let doneChapters = store.projects.prepDoneChapters(kind, volumeId);
      const missing = chapters.filter(cid => !doneChapters.has(cid));
      const needsTermProposals = kind === 'terms' && (missing.length > 0 || missingTermProposals(store, volumeId).length > 0);
      begin({ phase, message: kind === 'preread' ? `预读：补齐 ${missing.length} 章` : `术语：补齐 ${missing.length} 章` });
      if (kind === 'preread') {
        for (const cid of chapters) {
          check();
          if (!doneChapters.has(cid)) {
            await action([cid]);
            doneChapters = store.projects.prepDoneChapters(kind, volumeId);
          }
          check();
          if (!doneChapters.has(cid)) return attention('部分章节准备失败，修复后继续会只补未完成章');
        }
      } else if (needsTermProposals) {
        await action(missing);
        doneChapters = store.projects.prepDoneChapters(kind, volumeId);
      }
      check();
      if (chapters.some(cid => !doneChapters.has(cid))) return attention('部分章节准备失败，修复后继续会只补未完成章');
    }
    begin({ phase: 'knowledge', message: '独立核对本册新术语候选及原文证据' });
    await resolveTermProposals(store, ai, volumeId, opts.signal);
    check();
    const termInVolume = termReviewMatcher(store, volumeId);
    const pendingTermProposals = store.translations.listQueue(seriesId).filter(q => q.kind === 'term-proposal' && termInVolume(q));
    if (pendingTermProposals.length) return attention(`有 ${pendingTermProposals.length} 项术语译名待用户确认，确认后继续处理本册`);
    // Resolve source-only character observations before scenes depend on them.
    // Otherwise adopting a field immediately invalidates the scene just built.
    begin({ phase: 'knowledge', message: '核对人物观察与旧记录' });
    await reviewInitialFields(store,ai,volumeId,opts.signal);
    check();
    await resolveCharacterKnowledge(store,ai,volumeId,opts.signal);
    check();
    begin({ phase: 'knowledge', message: '核对人物档案的停用建议' });
    await reviewCharacterInvalidations(store,ai,volumeId,opts.signal);
    await reviewRelationshipTerminations(store,ai,volumeId,opts.signal);
    check();
    begin({ phase: 'scenes', message: '检查现有场景分析' });
    const missingScenes = ids.filter(pid => !store.projects.sceneObservation(pid));
    begin({ phase: 'scenes', message: `场景分析：补齐 ${missingScenes.length} 段` });
    if (missingScenes.length) await operations.scenes(missingScenes);
    check();
    if (ids.some(pid => !store.projects.sceneObservation(pid))) return attention('部分段落场景分析缺失或已因原文变化失效，请重试');
    begin({ phase: 'knowledge', message: '独立核对待定字段的原文归属' });
    await reviewFieldAttributions(store, ai, volumeId, opts.signal);
    check();
    const scanKey = hash([sourceAtStart, PROMPT_VERSION, [...store.projects.analysesFor(ids).values()], store.knowledge.listCharacters(seriesId)]);
    if (state.scanKey !== scanKey) {
      begin({ phase: 'honorifics', message: '核对首次称谓与角色方向' });
      await operations.honorifics(); check(); publish({ scanKey });
    }
    begin({ phase: 'knowledge', message: '核对称谓方向与待定人物知识' });
    await resolveAddressProposals(store, ai, volumeId, opts.signal);
    check();
    resolveParagraphLiteralAddresses(store,volumeId);
    check();
    await resolveParagraphAddressProposals(store, ai, volumeId, opts.signal);
    check();
    begin({ message: '分别核对语癖原文证据和中文表达' });
    await resolveQuirkProposals(store, ai, volumeId, opts.signal);
    check();
    const fieldPending = new Set(pendingFieldConflicts(store,seriesId,Math.max(...ids.map(id => store.projects.getParagraph(id)!.seriesOrdinal))).map(q => q.id));
    const unresolved = store.translations.listQueue(seriesId).filter(q => (fieldPending.has(q.id) || !q.paragraphId || ids.includes(q.paragraphId) || termInVolume(q)) && !['failed', 'review-block', 'warning'].includes(q.kind));
    const sourceText = ids.map(pid => store.projects.getParagraph(pid)!.sourceText).join('\n');
    const untranslatedTerms = store.glossary.activeTerms(seriesId).filter(t => !t.term_zh && sourceText.includes(t.term_jp));
    if (unresolved.length || untranslatedTerms.length) return attention(`有 ${unresolved.length} 项知识复核、${untranslatedTerms.length} 个空译名待处理。处理后继续，已完成准备步骤会保留`);
    // Translation uses the validated Japanese facts. Display-only Chinese
    // summaries are generated by the existing on-demand material-page action;
    // they must not consume the manuscript run's time and request budget.
    begin({ phase: 'translate', done: 0, message: '翻译缺稿，复核旧稿，跳过仍然有效的已验稿' });
    const pendingRechecks = new Set(store.translations.pendingRechecks(ids).map(r => r.paragraph_id));
    let failedParagraphs = 0;
    for (const [index, pid] of ids.entries()) {
      check();
      begin({ done: index, message: `处理第 ${index + 1}/${ids.length} 段` });
      // Read after progress callbacks: a user may have saved a manuscript at this boundary.
      const final = store.translations.latestFinal(pid);
      if (!final) await operations.translate(pid);
      else if (auditStatus(store, final) !== 'valid' || (!final.confirmed_by_user && !final.auto_accepted) || pendingRechecks.has(pid) || store.translations.openFindings(pid).some(f => f.severity === 'blocks_export' && f.workstation_id !== 'trajectory-reviewer')) await reverifyAutomatically(pid);
      check();
      const beforeRepair = store.translations.latestFinal(pid);
      const unacceptedWarnings = exposeUnacceptedWarnings(store, pid);
      const currentParagraph = store.projects.getParagraph(pid);
      const boundary = beforeRepair && currentParagraph ? longReadingBoundary(currentParagraph, beforeRepair.final_text) : null;
      if (boundary) { publish({ done: index + 1 }); return attention(boundary.message); }
      if (operations.repair && beforeRepair && !beforeRepair.confirmed_by_user && (unacceptedWarnings || auditStatus(store, beforeRepair) !== 'valid' || store.translations.openFindings(pid).some(f => f.severity === 'blocks_export' && f.workstation_id !== 'trajectory-reviewer'))) {
        begin({ message: `第 ${index + 1}/${ids.length} 段：尝试一次定点修复并重新验收` });
        const repairBase = store.translations.latestFinal(pid);
        if (repairBase?.id === beforeRepair.id && !repairBase.confirmed_by_user) await operations.repair(pid);
        check();
      }
      publish({ done: index + 1 });
      check();
      const current = store.translations.latestFinal(pid);
      const failed = !current || auditStatus(store, current) !== 'valid' || store.translations.openFindings(pid).some(f => f.severity === 'blocks_export' && f.workstation_id !== 'trajectory-reviewer');
      failedParagraphs = failed ? failedParagraphs + 1 : 0;
      if (failedParagraphs >= 3) { publish({ stopReason: 'paragraph-failures' }); return attention('连续3段未通过验收，已停止后续处理；保留当前稿件与问题，检查后可继续'); }
    }
    // Translation may discover forms absent from the initial preparation pass.
    begin({ phase: 'knowledge', message: '核对翻译中新发现的称呼，保留无法确定的方向' });
    await resolveAddressProposals(store, ai, volumeId, opts.signal); check();
    await resolveParagraphAddressProposals(store, ai, volumeId, opts.signal); check();
    for (const pid of new Set(store.translations.pendingRechecks(ids).map(r=>r.paragraph_id))) {
      await reverifyAutomatically(pid); check();
    }
    begin({ phase: 'trajectory', message: '核对跨段／跨章术语、人物声音与前后承接' });
    check();
    await reviewVolumeTrajectory(store, ai, volumeId, opts.signal, (done, total) => begin({ detail: { phase: 'trajectory', label: '跨段与跨章核查', done, total, unit: '组' }, message: `跨段／跨章核查：${done}/${total} 组` }));
    check();
    begin({ message: '尝试修复有明确证据的跨章问题，保留人工稿与不确定项' });
    await repairTrajectoryIssues(store, ai, volumeId, opts.signal);
    check();
    begin({ message: '章级连续阅读：独立核对相邻句群，不改写正文' });
    await reviewChapterReading(store, ai, volumeId, opts.signal, (done, total) => begin({ detail: { phase: 'trajectory', label: '章节连读检查', done, total, unit: '组' }, message: `章级连续阅读：${done}/${total} 组；失效结果重新核查` }));
    check();
    begin({ message: '核对章级问题的原文依据，必要时定点修复并完整复验' });
    await repairChapterReadingIssues(store, ai, volumeId, opts.signal);
    check();
    begin({ phase: 'delivery', message: '检查整册交付条件' });
    check();
    const report = runQualityGate(store, volumeId);
    if (!report.ok) return attention(`处理已结束，仍有 ${report.blockers.reduce((n, b) => n + b.count, 0)} 条交付阻断记录；请查看复核和导出检查`);
    publish({ status: 'done', message: '本册当前版本已通过交付检查，可以导出' });
    return state;
  } catch (error) {
    try {
      publish({ usage: { ...guard.usage }, stopReason: opts.signal?.aborted ? 'cancelled' : guard.stopped?.reason ?? (error instanceof RunStopped ? error.reason : 'error'), status: opts.signal?.aborted ? 'stopped' : 'attention', message: opts.signal?.aborted ? '已停止，完成结果已保留，可继续' : (error as Error).message });
    } catch { throw error; } // A second notification failure must not hide the first.
    return state;
  } finally { releaseGuard(); }
}
