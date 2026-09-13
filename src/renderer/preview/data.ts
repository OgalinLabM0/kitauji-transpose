import type { Api, NarrativeEventView, RelationshipView } from '../../shared/ipc';
import { DEFAULT_PROJECT_SETTINGS, type AddressTrajectoryView, type ChapterSummary, type CharacterView, type ParagraphView, type ReviewItemView, type SeriesSummary, type TermView } from '../../shared/types';

/** Entirely fictional, checked-in examples. No database, credentials or generated API output. */
export const PREVIEW_DATE = '2026-09-09T06:00:00.000Z';
export const PREVIEW_SERIES = 'preview-series-harbor';
export const PREVIEW_VOLUME = 'preview-volume-1';
export const PREVIEW_VOLUME_2 = 'preview-volume-2';
const chapterOne = 'preview-chapter-1';
const chapterTwo = 'preview-chapter-2';
const chapterThree = 'preview-chapter-3';

const passages: { source: string; zh: string | null; chapter: string; speaker?: string; candidate?: string; blocked?: boolean; confirmed?: boolean }[] = [
  { chapter: chapterOne, source: '放課後の図書室には、雨の匂いが残っていた。', zh: '放学后的图书室里，还留着雨的气息。', confirmed: true },
  { chapter: chapterOne, source: '「水野さん、この手紙を見つけたんです」遥は古い封筒を差し出した。', zh: '“水野同学，我找到了这封信。”遥递出一只旧信封。', speaker: '朝倉遥', blocked: true },
  { chapter: chapterOne, source: '「星見台の時計が、また動き始めたのか」水野は窓の向こうを見た。', zh: '“观星台的钟又开始走了吗？”水野望向窗外。', speaker: '水野律', blocked: true },
  { chapter: chapterOne, source: '封筒の裏には、細い字で「夏の終わりに」とだけ書かれていた。', zh: null, candidate: '信封背面只有一行纤细的字：“夏末之时”。' },
  { chapter: chapterTwo, source: '翌朝、二人は港へ続く坂道を下った。', zh: '第二天清晨，两人沿着通往港口的坡道走了下去。' },
  { chapter: chapterTwo, source: '「先輩、待ってください。まだ話していないことがあります」', zh: '“学长，请等一下。我还有件事没告诉你。”', speaker: '朝倉遥', blocked: true },
  { chapter: chapterTwo, source: '汽笛が短く鳴った。律は足を止め、振り返った。', zh: null },
  { chapter: chapterThree, source: '秋の駅には、あの日と同じ風が吹いていた。', zh: null },
];

export function createPreviewData() {
  const paragraphs: ParagraphView[] = passages.map((p, i) => ({
    id: `preview-paragraph-${i + 1}`, chapterId: p.chapter, volumeId: p.chapter === chapterThree ? PREVIEW_VOLUME_2 : PREVIEW_VOLUME,
    sceneId: `preview-scene-${p.chapter}`, seriesOrdinal: i + 1, paraOrdinal: i + 1,
    sourceText: p.source, paragraphType: p.speaker ? 'mixed' : 'narration',
    final: p.zh ? { text: p.zh, autoAccepted: false, confirmed: !!p.confirmed, version: 1 } : null,
    latestCandidate: p.candidate ? { text: p.candidate, workstationId: 'faithful-translator' } : null,
    openFindings: p.blocked ? 1 : 0, blocking: !!p.blocked,
    audit: 'missing', // 演示稿均无真实检查记录，人工确认也不能伪装成检查通过。
    analysis: p.speaker ? { speakerName: p.speaker, speakerConfidence: 0.94, intent: '告知与询问（演示标注）' } : null,
  }));
  const chapters: ChapterSummary[] = [
    { id: chapterOne, volumeId: PREVIEW_VOLUME, chapterNumber: 1, title: '第一章 雨后的图书室', paragraphCount: 4, translatedCount: 3, confirmedCount: 1, blockedCount: 2 },
    { id: chapterTwo, volumeId: PREVIEW_VOLUME, chapterNumber: 2, title: '第二章 通往港口的坡道', paragraphCount: 3, translatedCount: 2, confirmedCount: 0, blockedCount: 1 },
    { id: chapterThree, volumeId: PREVIEW_VOLUME_2, chapterNumber: 1, title: '序章 秋日站台', paragraphCount: 1, translatedCount: 0, confirmedCount: 0, blockedCount: 0 },
  ];
  const series: SeriesSummary[] = [
    { id: PREVIEW_SERIES, title: '海风与未寄出的信（演示作品）', author: '演示作者 · 原创样例', createdAt: PREVIEW_DATE, updatedAt: PREVIEW_DATE, volumes: [
      { id: PREVIEW_VOLUME, seriesId: PREVIEW_SERIES, volumeNumber: 1, title: '夏末的观星台', fileKind: 'epub', paragraphCount: 7, translatedCount: 5, confirmedCount: 1, pendingReviewCount: 3 },
      { id: PREVIEW_VOLUME_2, seriesId: PREVIEW_SERIES, volumeNumber: 2, title: '秋日站台', fileKind: 'txt', paragraphCount: 1, translatedCount: 0, confirmedCount: 0, pendingReviewCount: 0 },
    ] },
    { id: 'preview-series-empty', title: '等待开始的新作品（空书架演示）', author: null, createdAt: PREVIEW_DATE, updatedAt: PREVIEW_DATE, volumes: [] },
  ];
  const characters: CharacterView[] = [
    { id: 'preview-character-haruka', nameJp: '朝倉遥', nameZh: '朝仓遥', gender: 'female', genderConfidence: 0.98, firstPersonType: 'watashi', speechRegister: 'formal', voiceNotes: '对学长使用礼貌语，紧张时句子会变短。此处为人工编写的演示说明。', quirkProfiles: [], isActive: true, lockedByUser: false, lockedFields: ['gender'], introducedVolume: 1 },
    { id: 'preview-character-ritsu', nameJp: '水野律', nameZh: '水野律', gender: 'male', genderConfidence: 0.97, firstPersonType: 'boku', speechRegister: 'casual', voiceNotes: '语气平静，常以短句回应。', quirkProfiles: [{ quirk_id: 'preview-quirk-1', quirk_type: 'sentence-ending', trigger_form: 'かな', translation_pattern: '疑问语气，按语境使用“吧”', confirmed_by_user: true, locked_at_para: 1, evidence_ids: ['preview-paragraph-3'], notes: '仅展示语癖档案结构，并非模型判断。' }], isActive: true, lockedByUser: true, introducedVolume: 1 },
  ];
  const terms: TermView[] = [
    { id: 'preview-term-haruka', termJp: '朝倉遥', termZh: '朝仓遥', termType: 'person', senseIdentity: null, lockLevel: 'hard-locked', confidence: 1, introducedVolume: 1, notes: '主人公姓名（演示）', senses: [], occurrenceCount: 1, deviationCount: 0 },
    { id: 'preview-term-observatory', termJp: '星見台', termZh: '观星台', termType: 'place', senseIdentity: null, lockLevel: 'suggested', confidence: 0.78, introducedVolume: 1, notes: '虚构地名，等待确认统一译名。', senses: [{ id: 'preview-sense-1', senseZh: '观星台', senseGloss: '山坡上的旧观测设施', contextHint: '钟与港口的上下文', isDefault: true, confirmedByUser: false }, { id: 'preview-sense-2', senseZh: '星见台', senseGloss: '保留地名音形', contextHint: null, isDefault: false, confirmedByUser: false }], occurrenceCount: 1, deviationCount: 0 },
    { id: 'preview-term-library', termJp: '図書室', termZh: '图书室', termType: 'other', senseIdentity: null, lockLevel: 'confirmed', confidence: 0.99, introducedVolume: 1, notes: null, senses: [], occurrenceCount: 1, deviationCount: 0 },
  ];
  const reviews: ReviewItemView[] = [
    { id: 'preview-review-term', kind: 'term-proposal', priority: 80, paragraphId: 'preview-paragraph-3', seriesOrdinal: 3, chapterLabel: '第一章 · 第3段', title: '星見台：选择统一译名（演示）', status: 'pending', createdAt: PREVIEW_DATE, payload: { termId: 'preview-term-observatory', termJp: '星見台', preSelected: '观星台', preSelectedBasis: '演示预选，非模型输出', candidates: [{ zh: '观星台', basis: 'semantic', pros: '设施含义清晰' }, { zh: '星见台', basis: 'phonetic', pros: '保留地名形式' }], examples: [{ id: 'preview-paragraph-3', text: passages[2]!.source }] } },
    { id: 'preview-review-address', kind: 'honorific-first', priority: 70, paragraphId: 'preview-paragraph-6', seriesOrdinal: 6, chapterLabel: '第二章 · 第6段', title: '朝仓遥 → 水野律：先輩（演示）', status: 'pending', createdAt: PREVIEW_DATE, payload: { source: passages[5]!.source, translation: passages[5]!.zh, speakerId: characters[0]!.id, targetId: characters[1]!.id, sourceFormJp: '先輩', relationStage: '同校前后辈', recommended: '学长', candidates: [{ zh: '学长', register: '礼貌', rationale: '学校场景中的前后辈关系' }, { zh: '前辈', register: '中性', rationale: '保留更宽泛的关系含义' }] } },
    { id: 'preview-review-warning', kind: 'warning', priority: 20, paragraphId: 'preview-paragraph-4', seriesOrdinal: 4, chapterLabel: '第一章 · 第4段', title: '信封题字的排版提醒（演示）', status: 'pending', createdAt: PREVIEW_DATE, payload: { note: '正式导出时可核对信封题字的独立段落格式。浏览器预览不会生成或写入导出文件。' } },
    { id: 'preview-review-resolved', kind: 'warning', priority: 10, paragraphId: 'preview-paragraph-1', seriesOrdinal: 1, chapterLabel: '第一章 · 第1段', title: '已处理记录样例：段首空格', status: 'resolved', createdAt: PREVIEW_DATE, payload: { note: '这是固定的已处理样例，不表示本次预览执行过操作。' } },
  ];
  const addresses: AddressTrajectoryView[] = [
    { id: 'preview-address-1', speakerId: characters[0]!.id, speakerName: '朝仓遥', targetId: characters[1]!.id, targetName: '水野律', sourceFormJp: '水野さん', translatedForm: '水野同学', relationStage: '初识', allowVariation: false, confirmedByUser: true, validFromPara: 2, validToPara: 5 },
    { id: 'preview-address-2', speakerId: characters[0]!.id, speakerName: '朝仓遥', targetId: characters[1]!.id, targetName: '水野律', sourceFormJp: '先輩', translatedForm: '学长', relationStage: '知道前后辈关系后（待确认样例）', allowVariation: true, confirmedByUser: false, validFromPara: 6, validToPara: null },
  ];
  const relationships: RelationshipView[] = [{ id: 'preview-relationship-1', sourceStatus: 'current', fromId: characters[0]!.id, fromName: '朝仓遥', toId: characters[1]!.id, toName: '水野律', eventType: '初次共同调查', description: '遥把旧信交给律，两人决定调查观星台。', intimacy: 0.3, respect: 0.7, powerDistance: 0.2, formality: 0.6, validFromPara: 2, validToPara: null }];
  const events: NarrativeEventView[] = [{ id: 'preview-event-1', sourceStatus: 'current', summary: '遥在图书室找到一封未寄出的旧信。', atPara: 2, revealsToReader: true, characterNames: ['朝仓遥', '水野律'], chapterLabel: '第一章' }, { id: 'preview-event-2', sourceStatus: 'current', summary: '信与停摆的钟有关，真相尚未对读者揭示（虚构演示）。', atPara: 3, revealsToReader: false, characterNames: ['水野律'], chapterLabel: '第一章' }];
  const provider: Awaited<ReturnType<Api['app']['getProviderSettings']>> = {
    baseUrl: 'https://preview.invalid/v1', protocol: 'chat-completions', model: 'preview-no-network', judgeModel: 'preview-no-network',
    authScheme: 'none', hasApiKey: false, temperature: 0.3, maxOutputTokens: 4096, concurrency: 1, timeoutMs: 60000,
    thinkingMode: 'disabled', reasoningEffort: 'medium', pricingInput: null, pricingOutput: null,
    usePreprocessingModel: false, preprocessingModel: 'preview-no-network', preprocessingThinkingMode: 'disabled', preprocessingReasoningEffort: 'medium',
  };
  return { series, chapters, paragraphs, characters, terms, reviews, addresses, relationships, events, provider, settings: { ...DEFAULT_PROJECT_SETTINGS } };
}
