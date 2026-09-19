/**
 * IPC 契约：渲染层可调用的全部方法及其参数/返回类型。preload 按此暴露；main 按此注册。
 * 事件（主进程 → 渲染层）：progress / log / queue-changed / data-changed。
 */
import type { ImportQueueState, ImportQueueTarget, ImportQueueDamage } from './importQueue';
export interface EpubChapterRebuildResult { changed:boolean; beforeChapters:number; afterChapters:number; paragraphs:number; backupPath:string|null }
import type { ReviewOperationRequest, ReviewOperationResult } from './reviewOperations';
import type {
  CharacterKnowledgeHistory, DraftBase, SeriesSummary, VolumeSummary, ChapterSummary, ParagraphView, TermView, TermOccurrenceView, CharacterView, CharacterFieldDecisionView, CharacterAutomaticDecisionView, AddressTrajectoryView,
  ReviewItemView, ActivityLogEntry, ProviderSettings, ProjectSettings, QualityGateReport, ExportResult, WorkflowProgress, LockLevel, QuirkProfile, ReviewKind,
} from './types';

export interface LibraryIdentity { version: 1; libraryId: string; epoch: number }
export type LibraryIdentityEvent = 'blocked' | 'ready';
export interface BackupSummary { hash: string; schemaVersion: number; series: number; volumes: number; paragraphs: number; finals: number; archives: number }
export interface ImportPreflight { hash: string; chapters: { title: string | null; paragraphs: number }[]; paragraphs: number; warnings: string[]; existing: { seriesId: string; volumeId: string; seriesTitle: string } | null }
export interface ImportSummary { seriesId: string; volumeId: string; chapters: number; paragraphs: number; blocks: number; unparseable: string[]; missingTocResources: string[]; tocMapped: number; tocTotal: number; reusedExisting: boolean }
export type OpenFileResult = { path: string; name: string } | null;
export interface DecisionPayload { kind: ReviewKind; action: string; [k: string]: unknown }
export interface DecisionOutcome { ok: boolean; message: string; recheckCount: number; retranslate: string[] }
export interface AutomaticSourceIssue {
  id: string; title: string; kind: 'term-proposal' | 'honorific-first' | 'quirk-candidate' | 'stale-knowledge';
  reason: string; recoveryError: string | null;
  sources: { id: string; text: string | null; ordinal: number | null }[];
}
export interface AppliedChangeIssue { id: string; title: string; reason: string; queueId: string | null; sources: { id: string; text: string | null; ordinal: number | null }[] }
export interface SeriesExportCheck { ok: boolean; volumes: { volumeId: string; volumeNumber: number; title: string | null; report: QualityGateReport }[] }
export interface SeriesExportResult { ok: boolean; outputPath: string | null; snapshotId: string; snapshotAt: string; check: SeriesExportCheck; files: string[]; messages: string[] }
export interface SeriesDeliveryRequest { mode: 'zh' | 'bilingual'; outputPath: string; continueAfterDecisions?: boolean }
export interface SeriesDeliveryState extends SeriesDeliveryRequest {
  seriesId: string; status: 'running' | 'stopped' | 'attention' | 'done'; phase: 'process' | 'export';
  scope: { id: string; number: number }[]; originalFileHash: string;
  message: string; updatedAt: string; run: SeriesRunState | null; result: SeriesExportResult | null;
  waitingDecisionIds?: string[];
}
export interface VolumeOverview { volumeId: string; run: VolumeRunState | null; report: QualityGateReport; total: number; drafted: number; adopted: number; audited: number; pending: number; staleKnowledge: AutomaticSourceIssue[]; staleChanges: AppliedChangeIssue[] }
export interface RunUsage { requests: number; inputTokens: number; outputTokens: number; unknownUsageRequests: number; runRequests: number; consecutiveFailures: number }
export interface SeriesRunState {
  seriesId: string; volumeIds: string[]; currentVolumeId: string | null;
  status: 'running' | 'stopped' | 'attention' | 'done';
  done: number; total: number; message: string; updatedAt: string; currentRun: VolumeRunState | null;
  usage: Pick<RunUsage, 'inputTokens' | 'outputTokens' | 'unknownUsageRequests'>;
}
export interface VolumeRunState {
  detail?: import('./types').WorkflowStepProgress | null;
  usage?: RunUsage; requestLimit?: number; stopReason?: string | null;
  volumeId: string; status: 'running' | 'stopped' | 'attention' | 'done';
  phase: 'preread' | 'terms' | 'scenes' | 'honorifics' | 'knowledge' | 'translate' | 'trajectory' | 'delivery';
  done: number; total: number; message: string; updatedAt: string; scanKey: string | null;
}
export interface UsageSummary { unknownUsageRequests: number; calls: number; inputTokens: number; outputTokens: number; costUsd: number }
export interface RelationshipView { sourceStatus: 'current' | 'stale' | 'superseded' | 'unverified'; id: string; fromId: string; fromName: string; toId: string; toName: string; eventType: string; description: string; intimacy: number | null; respect: number | null; powerDistance: number | null; formality: number | null; validFromPara: number; validToPara: number | null }
export interface PrepStatus {
  preRead: boolean; termsExtracted: boolean; scenesAnalyzed: number; total: number;
  /** 章级完成度（预读/术语按章续跑） */
  chapters: number; prereadChapters: number; termsChapters: number;
  /** ① 预读产出 */
  characters: number; charactersNamed: number; relationships: number; events: number; genderPending: number; stalePending: number; quirkPending: number; quirksLocked: number;
  /** ② 术语产出 */
  terms: number; termsUndecided: number; termProposalsPending: number;
  /** ③ 场景产出：对话段数 / 其中识别出说话人的段数 */
  dialogues: number; speakersIdentified: number;
  /** ④ 称谓预扫描产出：队列中称谓项总数（含已处理）/ 待确认 / 已锁定称呼轨迹 */
  honorificsTotal: number; honorificsPending: number; addressesConfirmed: number;
  /** 翻译阶段工具的可处理数量 */
  honorificsNeedingCandidates: number; recheckPending: number; translated: number;
}
export interface ParagraphAnalysisView { speakerId: string | null; speakerName: string | null; speakerConfidence: number | null; targets: string[]; present: string[]; intent: string | null; difficultyFlags: string[]; evidenceIds: string[] }
export interface NarrativeEventView { sourceStatus: 'current' | 'stale' | 'superseded' | 'unverified'; id: string; summary: string; atPara: number; revealsToReader: boolean; characterNames: string[]; chapterLabel: string | null }

export interface Api {
  // ---- 应用 / 设置 ----
  app: {
    version(): Promise<string>;
    getDataDirectory(): Promise<string>;
    chooseDataDirectory(): Promise<string | null>;
    /** Backend-issued identity; no renderer-supplied library ID or epoch. */
    getLibraryIdentity(): Promise<LibraryIdentity>;
    getProviderSettings(): Promise<ProviderSettings>;
    setProviderSettings(s: Partial<ProviderSettings> & { apiKey?: string }): Promise<ProviderSettings>;
    testProvider(): Promise<{ ok: boolean; message: string; latencyMs: number }>;
    getUiPrefs(): Promise<Record<string, unknown>>;
    setUiPrefs(p: Record<string, unknown>): Promise<void>;
    usage(sinceIso?: string): Promise<UsageSummary>;
    openExternal(url: string): Promise<void>;
    createBackup(): Promise<{ path: string; summary: BackupSummary } | null>;
    pickBackup(): Promise<{ path: string; summary: BackupSummary } | null>;
    restoreBackup(path: string, expectedHash: string): Promise<{ summary: BackupSummary; safetyPath: string }>;
    resetLibrary(): Promise<{ ok: boolean; message: string }>;
  };
  // ---- 文件 ----
  files: {
    pickImport(): Promise<{ path: string; name: string }[] | null>;
    pickSavePath(defaultName: string): Promise<string | null>;
    showInFolder(path: string): Promise<void>;
  };
  // ---- 项目 ----
  project: {
    listSeries(): Promise<SeriesSummary[]>;
    getSeries(id: string): Promise<SeriesSummary | null>;
    deleteSeries(id: string): Promise<void>;
    listImportQueues(): Promise<ImportQueueState[]>;
    listDamagedImportQueues(): Promise<ImportQueueDamage[]>;
    quarantineImportQueue(id: string, fingerprint: string): Promise<void>;
    createImportQueue(files: { path: string; name: string }[], target: ImportQueueTarget): Promise<ImportQueueState>;
    updateImportQueue(id: string, revision: number, target: ImportQueueTarget, pendingOrder: string[]): Promise<ImportQueueState>;
    discardImportQueue(id: string, revision: number): Promise<void>;
    inspectQueuedFile(id: string, entryId: string): Promise<ImportQueueState>;
    importNextQueuedFile(id: string): Promise<ImportQueueState>;
    inspectImport(path: string): Promise<ImportPreflight>;
    cancelImport(): Promise<void>;
    importFile(path: string, opts: { seriesId?: string; seriesTitle?: string; volumeNumber?: number; volumeTitle?: string | null; expectedHash?: string }): Promise<ImportSummary>;
    listVolumes(seriesId: string): Promise<VolumeSummary[]>;
    listChapters(volumeId: string): Promise<ChapterSummary[]>;
    rebuildEpubChapters(volumeId:string):Promise<EpubChapterRebuildResult>;
    referenceTranslations(volumeId: string): Promise<Record<string, string>>;
    listParagraphs(chapterId: string): Promise<ParagraphView[]>;
    listParagraphsByVolume(volumeId: string): Promise<ParagraphView[]>;
    getParagraph(id: string): Promise<ParagraphView | null>;
    getSettings(seriesId: string): Promise<ProjectSettings>;
    setSetting(seriesId: string, key: keyof ProjectSettings, value: unknown): Promise<ProjectSettings>;
    prepStatus(volumeId: string): Promise<PrepStatus>;
    /** 场景分析完整结果（说话人/受话人/在场者/意图/难点/证据），无则 null */
    analysis(paragraphId: string): Promise<ParagraphAnalysisView | null>;
  };
  // ---- 翻译工作流 ----
  workflow: {
    deliveryState(seriesId: string): Promise<SeriesDeliveryState | null>;
    deliverSeries(seriesId: string, request?: SeriesDeliveryRequest): Promise<SeriesDeliveryState>;
    volumeOverview(volumeId: string): Promise<VolumeOverview>;
    volumeRunState(volumeId: string): Promise<VolumeRunState | null>;
    continueVolume(volumeId: string): Promise<VolumeRunState>;
    seriesRunState(seriesId: string): Promise<SeriesRunState | null>;
    continueSeries(seriesId: string): Promise<SeriesRunState>;
    resetTrajectoryRepairs(volumeId: string): Promise<number>;
    pendingRepairs(): Promise<{ queued: number; failed: number }>;
    resumeRepairs(): Promise<void>;
    preRead(volumeId: string, chapterIds?: string[]): Promise<void>;
    extractTerms(volumeId: string, chapterIds?: string[]): Promise<void>;
    analyzeScenes(volumeId: string, chapterId?: string): Promise<void>;
    resolveHonorifics(seriesId: string): Promise<void>;
    /** ④ 称谓预扫描（可选）：翻译前扫出全册 说话人→受话人「称呼」，AI 生成候选并预选（不锁定） */
    prescanHonorifics(volumeId: string): Promise<void>;
    /** 中文化预读数据：将日文事件摘要和关系描述翻译为中文（使用已确认术语表） */
    localizeNarrative(seriesId: string): Promise<{ events: number; relationships: number }>;
    /** 检查中文化状态 */
    checkLocalizationStatus(seriesId: string): Promise<{ needsLocalization: boolean; canLocalize: boolean; unlocalizedEvents: number; unlocalizedRelationships: number; confirmedTerms: number }>;
    translate(target: { volumeId?: string; chapterId?: string; paragraphIds?: string[] }, opts?: { forceFullReview?: boolean }): Promise<void>;
    retranslateRechecks(volumeId: string): Promise<void>;
    autoArbitrate(seriesId: string): Promise<{ autoResolved: number; adoptedFix: number; leftForHuman: number; preselected: number; asyncFinalized: number; asyncStillPending: number; details: string[] }>;
    pause(): Promise<void>; resume(): Promise<void>; cancel(): Promise<void>;
    progress(): Promise<WorkflowProgress>;
  };
  // ---- 译文 ----
  translation: {
    reverify(paragraphId: string): Promise<{ ok: boolean; message: string }>;
    reverifyVolume(volumeId: string): Promise<{ passed: number; pending: number }>;
    editFinal(paragraphId: string, text: string, confirm: boolean, base?: DraftBase): Promise<ParagraphView>;
    confirm(paragraphIds: string[]): Promise<number>;
    unconfirm(paragraphIds: string[]): Promise<void>;
    findings(paragraphId: string): Promise<{ id: string; workstationId: string; type: string; severity: string; description: string; evidenceJp: string | null; evidenceZh: string | null; suggestedFix: string | null }[]>;
    candidates(paragraphId: string): Promise<{ workstationId: string; text: string; createdAt: string }[]>;
    context(paragraphId: string): Promise<{ before: { id: string; source: string; final: string | null }[]; after: { id: string; source: string }[] }>;
  };
  // ---- 复核队列 ----
  review: {
    list(seriesId: string, status?: 'pending' | 'resolved' | 'dismissed', volumeId?: string): Promise<ReviewItemView[]>;
    counts(seriesId: string, volumeId?: string): Promise<Record<string, number>>;
    decide(queueItemId: string, decision: DecisionPayload): Promise<DecisionOutcome>;
    resolveHonorific(queueItemId: string): Promise<ReviewItemView | null>;
    undoResolved(queueItemId: string): Promise<void>;
    previewLegacyChange(queueItemId: string, seriesId: string, evidenceIds: string[]): Promise<{
      queueId: string; seriesId: string; candidateId: string; kind: 'term' | 'character' | 'relationship' | 'address' | 'character_state'; targetId: string;
      target: Record<string, string | number | null>; evidence: { id: string; at: number; text: string }[]; token: string;
    }>;
    reconfirmLegacyChange(queueItemId: string, seriesId: string, decision: { token: string; evidenceIds: string[]; reason: string; validToPara: number | null }): Promise<{ recheckCount: number }>;
    undoLegacyReconfirmation(queueItemId: string, seriesId: string): Promise<void>;
    /** 用户在卡片上改选候选/自定义 → 持久化为该项当前预选（term-proposal / ambiguity），供「一键确认全部预选」使用 */
    setPreselect(queueItemId: string, zh: string): Promise<void>;
    /** AI辅助审核复核项，返回推荐（accept/reject/uncertain）和置信度 */
    aiReview(seriesId: string): Promise<{ reviewed: number; recommendations: Record<string, { action: 'accept' | 'reject' | 'uncertain'; confidence: number; reason: string }> }>;
    runScoped(request: ReviewOperationRequest): Promise<ReviewOperationResult>;
  };
  // ---- 术语 ----
  glossary: {
    list(seriesId: string): Promise<TermView[]>;
    upsert(seriesId: string, t: { termJp: string; termZh: string | null; termType: string; senseIdentity?: string | null; lockLevel?: LockLevel; notes?: string | null; introducedVolume?: number }): Promise<TermView[]>;
    setLock(termId: string, lock: LockLevel): Promise<void>;
    remove(termId: string): Promise<void>;
    addSense(termId: string, senseZh: string, gloss: string | null, hint: string | null): Promise<void>;
    setDefaultSense(termId: string, senseId: string): Promise<void>;
    removeSense(senseId: string): Promise<void>;
    occurrences(termId: string): Promise<TermOccurrenceView[]>;
    importCsv(seriesId: string, csv: string): Promise<{ added: number; updated: number; errors: string[] }>;
    exportCsv(seriesId: string): Promise<string>;
  };
  // ---- 人物 / 关系 / 称呼 ----
  knowledge: {
    characters(seriesId: string): Promise<CharacterView[]>;
    history(characterId: string): Promise<CharacterKnowledgeHistory>;
    automaticFieldDecisions(characterId: string): Promise<CharacterAutomaticDecisionView[]>;
    undoAutomaticFieldDecision(characterId: string, queueId: string): Promise<void>;
    fieldDecisions(characterId: string): Promise<CharacterFieldDecisionView[]>;
    undoFieldDecision(characterId: string, decisionId: number): Promise<void>;
    upsertCharacter(seriesId: string, c: { id?: string; nameJp: string; nameZh?: string | null; gender?: string | null; firstPersonType?: string | null; speechRegister?: string | null; voiceNotes?: string | null; lockedByUser?: boolean; isActive?: boolean; introducedVolume?: number }): Promise<CharacterView[]>;
    setQuirks(characterId: string, quirks: QuirkProfile[]): Promise<void>;
    aliases(characterId: string): Promise<string[]>;
    addAlias(characterId: string, alias: string): Promise<void>;
    /** 把 dropId 合并进 keepId（别名/关系/称呼/场景分析/事件/队列全部改指 keepId，然后删除 dropId） */
    mergeCharacters(keepId: string, dropId: string): Promise<CharacterView[]>;
    /** 把某别名提升为主名（旧主名降为别名）；修正"代词被当成主名、真名挂在别名里"的档案 */
    setCanonicalName(characterId: string, nameJp: string): Promise<CharacterView[]>;
    removeAlias(characterId: string, alias: string): Promise<void>;
    /** 修复整个系列里主名为代词/职称的档案（提升真名别名 / 无真名则标记失效）并清理代词别名 */
    repairNames(seriesId: string): Promise<{ promoted: string[]; deactivated: string[]; aliasesRemoved: number }>;
    relationships(seriesId: string): Promise<RelationshipView[]>;
    addresses(seriesId: string): Promise<AddressTrajectoryView[]>;
    /** 预读建立的剧情时间线 */
    events(seriesId: string): Promise<NarrativeEventView[]>;
    addAddress(seriesId: string, a: { speakerId: string; targetId: string; sourceFormJp: string; translatedForm: string; relationStage?: string | null; allowVariation?: boolean; validFromPara: number }): Promise<void>;
    setAddressVariation(id: string, allow: boolean): Promise<void>;
    endAddress(id: string, atPara: number): Promise<void>;
  };
  // ---- 导出 ----
  export: {
    seriesQualityGate(seriesId: string): Promise<SeriesExportCheck>;
    runSeries(seriesId: string, mode: 'zh' | 'bilingual', outputPath: string): Promise<SeriesExportResult>;
    qualityGate(volumeId: string): Promise<QualityGateReport>;
    run(volumeId: string, mode: 'zh' | 'bilingual', outputPath: string, preview: boolean): Promise<ExportResult>;
  };
  // ---- 日志 ----
  logs: { recent(afterId: number, limit?: number): Promise<ActivityLogEntry[]>;
    page(options?: { beforeId?: number | undefined; level?: 'all' | 'warning' | 'error'; workstation?: string | undefined; search?: string | undefined }): Promise<{ entries: ActivityLogEntry[]; hasMore: boolean }>;
    detail(id: number, offset?: number): Promise<{ text: string; hasMore: boolean } | null>;
    clear(): Promise<number> };
  // ---- 事件 ----
  on(event: 'library-identity', cb: (state: LibraryIdentityEvent) => void): () => void;
  on(event: 'progress', cb: (p: WorkflowProgress) => void): () => void;
  on(event: 'log', cb: (e: ActivityLogEntry) => void): () => void;
  on(event: 'data-changed', cb: (scope: DataScope) => void): () => void;
}
export type DataScope = 'series' | 'paragraphs' | 'queue' | 'glossary' | 'knowledge' | 'settings';

/** 通道名 = `${namespace}.${method}` */
export const IPC_NAMESPACES = ['app', 'files', 'project', 'workflow', 'translation', 'review', 'glossary', 'knowledge', 'export', 'logs'] as const;
export const IPC_EVENTS = ['progress', 'log', 'data-changed', 'library-identity'] as const;
