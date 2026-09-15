/** Renderer 与 Main 共享的纯数据类型；不含任何 Node API。 */

export type WorkstationId =
  | 'character-invalidation-reviewer'
  | 'relationship-termination-reviewer'
  | 'ordinary-address-classifier'
  | 'chapter-reading-reviewer'
  | 'dispute-reviewer' | 'source-relation-reader' | 'repair-resolution-reviewer' | 'event-pre-reader' | 'book-pre-reader' | 'term-extractor' | 'term-translation-proposer' | 'honorific-resolver'
  | 'scene-analyst' | 'faithful-translator' | 'chinese-editor' | 'sentence-translator' | 'fidelity-reviewer' | 'comma-location-reviewer'
  | 'address-reviewer' | 'trajectory-reviewer' | 'narrative-localizer' | 'source-aligner' | 'character-evidence-reviewer' | 'naturalness-reviewer' | 'restructuring-reviewer' | 'term-evidence-reviewer' | 'address-evidence-reviewer' | 'quirk-evidence-reviewer';

export const WORKSTATION_LABELS: Record<WorkstationId, string> = {
  'character-invalidation-reviewer': '人物停用候选核对',
  'relationship-termination-reviewer': '关系终止候选核对',
  'ordinary-address-classifier': '普通称谓分类',
  'chapter-reading-reviewer': '章级连续阅读',
  'dispute-reviewer': '争议原文复核',
  'source-relation-reader': '日文难句关系整理',
  'repair-resolution-reviewer': '指定问题修复验收',
  'event-pre-reader': '事件与关系预读', 'book-pre-reader': '人物预读', 'term-extractor': '专名提取', 'term-translation-proposer': '术语译名提案',
  'honorific-resolver': '称谓解析', 'scene-analyst': '场景分析', 'faithful-translator': '忠实初译',
  'chinese-editor': '中文编辑', 'sentence-translator': '病句重译', 'fidelity-reviewer': '忠实审校', 'address-reviewer': '称呼审校',
  'trajectory-reviewer': '全书轨迹审校', 'narrative-localizer': '预读中文化',
  'source-aligner': '原译对应核对',
  'character-evidence-reviewer': '人物字段证据核对',
  'naturalness-reviewer': '中文读感检查',
  'restructuring-reviewer': '必要句法重构核对',
  'term-evidence-reviewer': '术语候选证据核对',
  'address-evidence-reviewer': '称谓方向证据核对',
  'quirk-evidence-reviewer': '语癖证据核对',
  'comma-location-reviewer': '逗号位置核对',
};

export type LockLevel = 'suggested' | 'confirmed' | 'hard-locked';
export type DeviationStatus = 'none' | 'sense-selected' | 'flagged' | 'accepted' | 'promoted' | 'rejected' | 'conflict';
export type ParagraphType = 'dialogue' | 'narration' | 'mixed';
export type FastPathMode = 'off' | 'normal' | 'aggressive';
export type ApiProtocol = 'chat-completions' | 'responses' | 'anthropic-messages';

export interface SeriesSummary {
  id: string; title: string; author: string | null; createdAt: string; updatedAt: string;
  volumes: VolumeSummary[];
}
export interface VolumeSummary {
  id: string; seriesId: string; volumeNumber: number; title: string | null;
  fileKind: 'epub' | 'txt' | null; paragraphCount: number; translatedCount: number; confirmedCount: number;
  pendingReviewCount: number;
}
export interface ChapterSummary {
  id: string; volumeId: string; chapterNumber: number; title: string | null;
  paragraphCount: number; translatedCount: number; confirmedCount: number; blockedCount: number;
}
export interface DraftBase { version: number; sourceText: string }
export interface ParagraphView {
  volumeId: string; audit?: 'valid' | 'missing' | 'stale';
  id: string; chapterId: string; sceneId: string; seriesOrdinal: number; paraOrdinal: number;
  sourceText: string; paragraphType: ParagraphType;
  final: { text: string; notes?: string[]; autoAccepted: boolean; confirmed: boolean; version: number } | null;
  latestCandidate: { text: string; workstationId: WorkstationId } | null;
  openFindings: number; blocking: boolean;
  analysis: { speakerName: string | null; speakerConfidence: number | null; intent: string | null } | null;
}

export interface TermView {
  id: string; termJp: string; termZh: string | null; termType: string; senseIdentity: string | null;
  lockLevel: LockLevel; confidence: number; introducedVolume: number; notes: string | null;
  senses: TermSenseView[]; occurrenceCount: number; deviationCount: number;
}
export interface TermSenseView {
  id: string; senseZh: string; senseGloss: string | null; contextHint: string | null;
  isDefault: boolean; confirmedByUser: boolean;
}
export interface TermOccurrenceView {
  id: string; paragraphId: string; seriesOrdinal: number; occurrenceText: string;
  appliedZh: string | null; deviationStatus: DeviationStatus; deviationRationale: string | null;
  confidence: number | null;
}

export type KnowledgeSourceStatus = 'manual' | 'current' | 'stale' | 'unverified' | 'superseded';
export interface KnowledgeEvidenceView { id: string; at: number | null; currentText: string | null }
export interface CharacterKnowledgeHistory {
  names?: { id: string; name: string; sourceStatus: KnowledgeSourceStatus; fromPara: number | null; toPara: number | null; evidence: KnowledgeEvidenceView[] }[];
  aliases: { id: string; name: string; sourceStatus: KnowledgeSourceStatus; fromPara: number | null; toPara: number | null; evidence: KnowledgeEvidenceView[] }[];
  fields: { id: string; field: string; value: string; sourceStatus: KnowledgeSourceStatus; fromPara: number; evidence: KnowledgeEvidenceView[]; quotes: string[] }[];
  fieldTotal: number;
}

export interface CharacterFieldDecisionView {
  id: number; field: string; fromPara: number; previous: unknown; value: unknown;
  createdAt: string; canUndo: boolean; undone: boolean;
}
export interface CharacterAutomaticDecisionView {
  id: string; field: string; fromPara: number; previous: unknown; value: unknown;
  createdAt: string; canUndo: boolean; undone: boolean; reason: string;
  sources: {id:string;text:string;at:number}[];
}
export interface CharacterView {
  id: string; nameJp: string; nameZh: string | null; gender: string | null; genderConfidence: number | null;
  firstPersonType: string | null; speechRegister: string | null; voiceNotes: string | null;
  quirkProfiles: QuirkProfile[]; isActive: boolean; lockedByUser: boolean; lockedFields?: string[]; introducedVolume: number;
}
export interface QuirkProfile {
  example_review_queue_id?: string;
  automatically_adopted?: boolean;
  quirk_id: string; quirk_type: string; trigger_form: string; translation_pattern: string;
  confirmed_by_user: boolean; locked_at_para: number; evidence_ids: string[]; notes?: string;
}
export interface AddressTrajectoryView {
  id: string; speakerId: string; speakerName: string; targetId: string; targetName: string;
  sourceFormJp: string; translatedForm: string; relationStage: string | null; allowVariation: boolean;
  confirmedByUser: boolean; automaticallyAdopted?: boolean; validFromPara: number; validToPara: number | null;
}

export type ReviewKind =
  | 'failed' | 'lock-conflict' | 'review-block' | 'honorific-first' | 'quirk-candidate'
  | 'gender-plural' | 'term-proposal' | 'wordplay' | 'ambiguity' | 'glossary-deviation' | 'stale-knowledge' | 'warning';
export const REVIEW_KIND_LABELS: Record<ReviewKind, string> = {
  failed: '失败', 'lock-conflict': '锁定冲突', 'review-block': '审校阻断', 'honorific-first': '称谓首次',
  'quirk-candidate': '语癖候选', 'gender-plural': '性别/人数', 'term-proposal': '术语提案', wordplay: '双关', ambiguity: '歧义词',
  'glossary-deviation': '术语偏离', 'stale-knowledge': '可能过时', warning: '警告',
};
export interface ReviewItemView {
  id: string; kind: ReviewKind; priority: number; paragraphId: string | null; seriesOrdinal: number | null;
  chapterLabel: string | null; title: string; payload: Record<string, unknown>; status: 'pending' | 'resolved' | 'dismissed';
  createdAt: string;
  /** AI辅助审核推荐 */
  aiRecommendation?: {
    action: 'accept' | 'reject' | 'uncertain';
    confidence: number; // 0-1
    reason: string;
    suggestedFix?: string; // 建议修复（如果是reject）
  };
}

export interface ActivityLogEntry {
  id: number; ts: string; level: 'info' | 'success' | 'warning' | 'error';
  workstationId: WorkstationId | null; paragraphId: string | null; message: string;
  durationMs: number | null; tokens: number | null;
}

export interface ProviderSettings {
  baseUrl: string; protocol: ApiProtocol; model: string; judgeModel: string;
  authScheme: 'bearer' | 'x-api-key' | 'none'; hasApiKey: boolean;
  temperature: number; maxOutputTokens: number; concurrency: number; timeoutMs: number;
  thinkingMode: 'auto' | 'enabled' | 'disabled';
  reasoningEffort: 'low' | 'medium' | 'high';
  /** 单价（美元 / 百万 token），用于用量页费用估算；null = 不估算（显示 —） */
  pricingInput: number | null; pricingOutput: number | null;
  /** 预处理任务是否使用独立模型配置 */
  usePreprocessingModel: boolean;
  /** 预处理模型名称（术语提取、人物识别等需要深度分析的任务） */
  preprocessingModel: string;
  /** 预处理模型思考模式 */
  preprocessingThinkingMode: 'auto' | 'enabled' | 'disabled';
  /** 预处理模型推理强度 */
  preprocessingReasoningEffort: 'low' | 'medium' | 'high';
}
export interface ProjectSettings {
  'ruby.first_person': boolean; 'ruby.proper_noun': boolean; 'fast_path.mode': FastPathMode;
  'export.translate_title': boolean; 'export.bilingual_layout': 'jp-top' | 'zh-top';
  'honorific.default_style': 'loan' | 'native';
}
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  'ruby.first_person': true, 'ruby.proper_noun': false, 'fast_path.mode': 'normal',
  'export.translate_title': false, 'export.bilingual_layout': 'jp-top', 'honorific.default_style': 'loan',
};

export interface QualityGateReport {
  ok: boolean; totalParagraphs: number; translated: number; confirmed: number;
  blockers: { code: string; count: number; sample: string[] }[];
  warnings: { code: string; count: number }[];
  pendingDeviations: number;
}
export interface ExportResult { snapshotId?: string; snapshotAt?: string; preview?: boolean; ok: boolean; outputPath: string | null; report: QualityGateReport; writtenBlocks: number; skippedBlocks: number; keptBlocks: number; messages: string[] }

export interface WorkflowStepProgress {
  phase: string; label: string; done: number; total: number; unit: '段' | '章' | '册' | '组' | '项'; chapterTitle?: string;
}
export interface WorkflowProgress {
  detail?: WorkflowStepProgress | null;
  running: boolean; paused: boolean; phase: string; done: number; total: number;
  unknownUsageRequests?: number;
  currentParagraphId: string | null; costUsd: number; inputTokens: number; outputTokens: number; message: string;
}

/** 初译/编辑工位输出的 flags（TRANSLATION_RULES.md 第九节） */
export type TranslationFlag =
  | { type: 'foreign-note'; source_quote: string; gloss_zh: string; rationale: string }
  | { type: 'katakana-ambiguity'; term: string; inferred: string; confidence: number; evidence?: string }
  | { type: 'glossary-sense'; term: string; sense_id?: string; used_zh?: string; confidence: number }
  | { type: 'glossary-deviation'; term: string; glossary_zh: string; used_zh: string; rationale: string; confidence: number }
  | { type: 'glossary-conflict'; term: string; glossary_zh: string; believed_zh: string; rationale: string }
  | { type: 'wordplay'; original: string; variant: string; meaning: string; proposal: string | null; rationale: string; confidence: number }
  | { type: 'quirk-candidate'; character_id: string | null; character_name?: string; trigger_form: string; proposed_pattern: string; signal: 'default' | 'strong' | 'consistency' }
  | { type: 'honorific-first'; speaker_char_id: string | null; target_char_id: string | null; speaker_name?: string; target_name?: string; source_form_jp: string; used_zh?: string }
  | { type: 'first-person-shift'; character_id: string | null; from: string; to: string }
  | { type: 'logic-conflict'; note: string };

export type ToneAxes = Record<'detail' | 'explicitness' | 'vulgarity' | 'aggression' | 'offensiveness' | 'taboo_directness' | 'emotional_intensity', number | 'unknown'>;
export interface SourceCoverageItem { segment: string; rendered_as: string; status: 'covered' | 'uncertain' | 'restructured'; ord?: number | undefined }

export type ValidationCode =
  | 'EMPTY_TRANSLATION' | 'UNTRANSLATED' | 'PRONOUN_HALLUCINATION' | 'PRONOUN_DELETED' | 'NUMERIC_FORMAT' | 'HIRAGANA_LEAK'
  | 'POLLUTION' | 'LENGTH_VARIANCE' | 'QUOTE_MISMATCH' | 'MOJIBAKE' | 'STUTTER_STRIPPED' | 'MARKER_ROUNDTRIP_FAILED' | 'ORDER_INVERTED'
  | 'GLOSSARY_UNFLAGGED_DEVIATION' | 'GLOSSARY_HARD_LOCK_VIOLATION' | 'GLOSSARY_SYNONYM_SWAP' | 'GLOSSARY_COUNT_MISMATCH'
  | 'PASSIVE_INVERSION' | 'PUNCTUATION_MISMATCH' | 'ORDER_MISSING' | 'REVIEW_INCOMPLETE' | 'NATURALNESS_UNRESOLVED' | 'LONG_NATURALNESS_NEEDS_BOUNDARY'
  | 'REVIEW_INVALID_EVIDENCE' | 'REVIEW_MISSING_EVIDENCE' | 'DEICTIC_SCOPE_NARROWED' | `REVIEW:${string}`;
export interface ValidationFinding { code: ValidationCode; severity: 'blocks_export' | 'warning' | 'info'; message: string; details?: Record<string, unknown> }
