import { APP_VERSION } from '@shared/appVersion';
import type { Api, PrepStatus } from '../../shared/ipc';
import type { QualityGateReport, WorkflowProgress } from '../../shared/types';
import { createPreviewData, PREVIEW_DATE, PREVIEW_SERIES, PREVIEW_VOLUME } from './data';

export const PREVIEW_NOTICE_EVENT = 'workshop-preview-notice';
export class PreviewUnsupportedError extends Error {
  constructor(operation: string) {
    super(`浏览器预览：不支持「${operation}」。未执行操作、未保存数据，也未调用模型或访问本机文件。请在 Electron 正式应用中使用此功能。`);
    this.name = 'PreviewUnsupportedError';
  }
}

/** Explicit read-only contract. Each instance owns its data and memory-only UI preferences. */
export function createPreviewApi(notify: (message: string) => void = () => {}): Api {
  const data = createPreviewData();
  const copy = <T>(value: T): T => structuredClone(value);
  let prefs: Record<string, unknown> = { theme: 'light', currentSeriesId: PREVIEW_SERIES, currentVolumeId: PREVIEW_VOLUME };
  const deny = (operation: string) => async (..._args: unknown[]): Promise<never> => {
    const error = new PreviewUnsupportedError(operation);
    notify(error.message);
    throw error;
  };
  const requireSeries = (id: string) => {
    const series = data.series.find(s => s.id === id);
    if (!series) throw new Error('浏览器预览：找不到此演示作品。');
    return series;
  };
  const volumeParagraphs = (id: string) => {
    if (!data.series.some(s => s.volumes.some(v => v.id === id))) throw new Error('浏览器预览：找不到此演示册。');
    return data.paragraphs.filter(p => p.volumeId === id);
  };
  const requireParagraph = (id: string) => {
    const p = data.paragraphs.find(p => p.id === id);
    if (!p) throw new Error('浏览器预览：找不到此演示段落。');
    return p;
  };
  const requireCharacter = (id: string) => {
    const c = data.characters.find(c => c.id === id);
    if (!c) throw new Error('浏览器预览：找不到此演示人物。');
    return c;
  };
  const forSeries = <T>(id: string, rows: T[]): T[] => { requireSeries(id); return copy(id === PREVIEW_SERIES ? rows : []); };
  const reviews = (sid: string, status: 'pending' | 'resolved' | 'dismissed' = 'pending', vid?: string) => {
    const series = requireSeries(sid);
    if (vid && !series.volumes.some(v => v.id === vid)) throw new Error('浏览器预览：该册不属于所选演示作品。');
    return forSeries(sid, data.reviews).filter(r => r.status === status && (!vid || data.paragraphs.some(p => p.id === r.paragraphId && p.volumeId === vid)));
  };
  const report = (vid: string): QualityGateReport => {
    const paragraphs = volumeParagraphs(vid);
    const translated = paragraphs.filter(p => p.final).length;
    const confirmed = paragraphs.filter(p => p.final?.confirmed).length;
    const pending = reviews(PREVIEW_SERIES, 'pending', vid).length;
    return {
      ok: false, totalParagraphs: paragraphs.length, translated, confirmed,
      blockers: [
        ...(paragraphs.length > translated ? [{ code: 'UNTRANSLATED', count: paragraphs.length - translated, sample: paragraphs.filter(p => !p.final).map(p => p.id) }] : []),
        ...(pending ? [{ code: 'PENDING_REVIEW', count: pending, sample: reviews(PREVIEW_SERIES, 'pending', vid).map(r => r.id) }] : []),
        { code: 'PREVIEW_READ_ONLY', count: 1, sample: ['演示数据，仅展示检查界面，不执行真实质量检查或导出。'] },
      ], warnings: [], pendingDeviations: 0,
    };
  };
  const progress: WorkflowProgress = { running: false, paused: false, phase: 'idle', done: 0, total: 0, currentParagraphId: null, costUsd: 0, inputTokens: 0, outputTokens: 0, message: '浏览器预览 · 固定演示数据 · 未调用模型 · 所有业务写入已禁用' };
  const logs: Awaited<ReturnType<Api['logs']['recent']>> = [
    { id: 1, ts: PREVIEW_DATE, level: 'info', workstationId: null, paragraphId: null, message: '浏览器预览已载入原创样例；正式数据库、文件系统和付费 API 均未连接。', durationMs: null, tokens: null },
    { id: 2, ts: PREVIEW_DATE, level: 'warning', workstationId: null, paragraphId: 'preview-paragraph-3', message: '演示待处理项：地名译名与称谓需要确认。这是静态样例，不是本次工作流结果。', durationMs: null, tokens: null },
  ];
  const api: Api = {
    app: {
      getLibraryIdentity: async () => ({ version: 1, libraryId: '00000000-0000-4000-8000-000000000008', epoch: 0 }),
      version: async () => APP_VERSION + '-browser-preview',
      chooseDataDirectory: deny('更改数据目录'),
      getDataDirectory: async () => '浏览器预览不使用本机书库',
      getProviderSettings: async () => copy(data.provider),
      setProviderSettings: deny('保存接口配置或密钥'), testProvider: deny('测试模型连接'),
      getUiPrefs: async () => copy(prefs),
      setUiPrefs: async p => {
        // Only navigation and theme are accepted; never store arbitrary values or credentials.
        for (const key of ['theme', 'currentSeriesId', 'currentVolumeId'] as const) {
          const value = p[key];
          if (value === null || typeof value === 'string') prefs[key] = value;
        }
      },
      usage: async () => ({ unknownUsageRequests: 0, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }),
      openExternal: deny('打开外部链接'), createBackup: deny('创建数据库备份'), pickBackup: deny('选择备份文件'), restoreBackup: deny('恢复数据库'), resetLibrary: deny('清空书库'),
    },
    files: { pickImport: deny('选择导入文件'), pickSavePath: deny('选择保存位置'), showInFolder: deny('打开本机文件夹') },
    project: {
      listImportQueues: async () => [], listDamagedImportQueues: async () => [], quarantineImportQueue: deny('保留损坏导入清单'), createImportQueue: deny('保存导入清单'), updateImportQueue: deny('修改导入清单'), discardImportQueue: deny('丢弃导入清单'), inspectQueuedFile: deny('体检导入清单文件'), importNextQueuedFile: deny('继续导入清单'),
      listSeries: async () => copy(data.series), getSeries: async id => copy(data.series.find(s => s.id === id) ?? null),
      referenceTranslations: async () => ({}), deleteSeries: deny('删除作品'), inspectImport: deny('检查导入文件'), cancelImport: deny('取消原生导入任务'), importFile: deny('导入文件'),
      listVolumes: async id => copy(requireSeries(id).volumes),
      rebuildEpubChapters: deny('整理EPUB章节'),
      listChapters: async id => { volumeParagraphs(id); return copy(data.chapters.filter(c => c.volumeId === id)); },
      listParagraphs: async id => {
        if (!data.chapters.some(c => c.id === id)) throw new Error('浏览器预览：找不到此演示章节。');
        return copy(data.paragraphs.filter(p => p.chapterId === id));
      },
      listParagraphsByVolume: async id => copy(volumeParagraphs(id)),
      getParagraph: async id => copy(data.paragraphs.find(p => p.id === id) ?? null),
      getSettings: async id => { requireSeries(id); return copy(data.settings); }, setSetting: deny('保存作品设置'),
      prepStatus: async id => {
        const ps = volumeParagraphs(id), ready = id === PREVIEW_VOLUME;
        const chapters = data.chapters.filter(c => c.volumeId === id).length;
        const status: PrepStatus = {
          preRead: ready, termsExtracted: ready, scenesAnalyzed: ready ? ps.length : 0, total: ps.length,
          chapters, prereadChapters: ready ? chapters : 0, termsChapters: ready ? chapters : 0,
          characters: ready ? data.characters.length : 0, charactersNamed: ready ? data.characters.length : 0, relationships: ready ? data.relationships.length : 0,
          events: ready ? data.events.length : 0, genderPending: 0, stalePending: 0, quirkPending: 0, quirksLocked: ready ? 1 : 0,
          terms: ready ? data.terms.length : 0, termsUndecided: ready ? 1 : 0, termProposalsPending: ready ? 1 : 0,
          dialogues: ps.filter(p => p.analysis).length, speakersIdentified: ps.filter(p => p.analysis).length,
          honorificsTotal: ready ? 1 : 0, honorificsPending: ready ? 1 : 0, addressesConfirmed: ready ? 1 : 0,
          honorificsNeedingCandidates: 0, recheckPending: 0, translated: ps.filter(p => p.final).length,
        };
        return status;
      },
      analysis: async id => {
        const p = requireParagraph(id);
        if (!p.analysis) return null;
        const speaker = data.characters.find(c => c.nameJp === p.analysis?.speakerName)!;
        return { speakerId: speaker.id, speakerName: speaker.nameZh, speakerConfidence: 0.94, targets: data.characters.filter(c => c.id !== speaker.id).map(c => c.id), present: data.characters.map(c => c.id), intent: p.analysis.intent, difficultyFlags: p.blocking ? ['称谓或专名待确认（演示）'] : [], evidenceIds: [id] };
      },
    },
    workflow: {
      deliveryState: async id => { requireSeries(id); return null; }, deliverSeries: deny('处理并导出整个系列'),
      volumeOverview: async id => {
        const ps = volumeParagraphs(id);
        return { volumeId: id, run: null, report: report(id), total: ps.length, drafted: ps.filter(p => p.final || p.latestCandidate).length, adopted: ps.filter(p => p.final).length, audited: ps.filter(p => p.audit === 'valid').length, pending: reviews(PREVIEW_SERIES, 'pending', id).length, staleKnowledge: [], staleChanges: [] };
      },
      volumeRunState: async id => { volumeParagraphs(id); return null; }, continueVolume: deny('继续处理本册'),
      seriesRunState: async id => { requireSeries(id); return null; }, continueSeries: deny('继续处理系列'),
      resetTrajectoryRepairs: deny('重置轨迹修复'), pendingRepairs: async () => ({ queued: 0, failed: 0 }), resumeRepairs: deny('恢复修复任务'),
      preRead: deny('模型预读'), extractTerms: deny('模型术语提取'), analyzeScenes: deny('模型场景分析'), resolveHonorifics: deny('模型称谓解析'), prescanHonorifics: deny('模型称谓预扫描'), localizeNarrative: deny('模型预读中文化'),
      checkLocalizationStatus: async id => { requireSeries(id); return { needsLocalization: false, canLocalize: false, unlocalizedEvents: 0, unlocalizedRelationships: 0, confirmedTerms: id === PREVIEW_SERIES ? 2 : 0 }; },
      translate: deny('调用模型翻译'), retranslateRechecks: deny('调用模型重译'), autoArbitrate: deny('模型自动仲裁'),
      pause: deny('暂停工作流'), resume: deny('恢复工作流'), cancel: deny('停止工作流'), progress: async () => copy(progress),
    },
    translation: {
      reverify: deny('重新检查译文'), reverifyVolume: deny('重新检查全册'), editFinal: deny('保存译文'), confirm: deny('确认译文'), unconfirm: deny('撤销译文确认'),
      findings: async id => {
        const p = requireParagraph(id);
        if (!p.blocking) return [];
        const punctuationExample = ['preview-paragraph-2', 'preview-paragraph-3', 'preview-paragraph-6'].includes(id);
        return [{ id: `preview-finding-${id}`, workstationId: punctuationExample ? 'validator' : 'address-reviewer', type: punctuationExample ? 'PUNCTUATION_MISMATCH' : 'PENDING_REVIEW', severity: 'blocks_export', description: punctuationExample ? '错误样例：原文「」被换成“”，并在原本没有句末标点的引号内新增了句号或问号。此稿未通过真实检查，必须保留原文标点后重新检查。' : '演示标注：请核对专名或称谓，非实际模型审校结果。', evidenceJp: p.sourceText, evidenceZh: p.final?.text ?? null, suggestedFix: null }];
      },
      candidates: async id => { const p = requireParagraph(id); return p.latestCandidate ? [{ workstationId: p.latestCandidate.workstationId, text: p.latestCandidate.text, createdAt: PREVIEW_DATE }] : []; },
      context: async id => {
        const p = requireParagraph(id), ps = volumeParagraphs(p.volumeId), i = ps.findIndex(x => x.id === id);
        return { before: ps.slice(Math.max(0, i - 2), i).map(x => ({ id: x.id, source: x.sourceText, final: x.final?.text ?? null })), after: ps.slice(i + 1, i + 3).map(x => ({ id: x.id, source: x.sourceText })) };
      },
    },
    review: {
      assistant: deny('待确认助手需要正式模型接口'),
      list: async (sid, status, vid) => reviews(sid, status, vid),
      counts: async (sid, vid) => { const counts: Record<string, number> = {}; for (const r of reviews(sid, 'pending', vid)) counts[r.kind] = (counts[r.kind] ?? 0) + 1; return counts; },
      previewLegacyChange: deny('预览旧知识人工重新确认（演示无旧记录）'), reconfirmLegacyChange: deny('保存旧知识人工重新确认'), undoLegacyReconfirmation: deny('撤销本次人工重新确认'),
      decide: deny('提交复核决定'), resolveHonorific: deny('模型生成称谓选项'), undoResolved: deny('撤销复核决定'), setPreselect: deny('保存复核预选'), aiReview: deny('AI 辅助审核'), runScoped: deny('分类审核操作'),
    },
    glossary: {
      list: async id => forSeries(id, data.terms), upsert: deny('保存术语'), setLock: deny('修改术语锁定'), remove: deny('删除术语'),
      addSense: deny('添加义项'), setDefaultSense: deny('设置默认义项'), removeSense: deny('删除义项'),
      occurrences: async id => {
        const term = data.terms.find(t => t.id === id);
        if (!term) throw new Error('浏览器预览：找不到此演示术语。');
        const paragraphId = id === 'preview-term-observatory' ? 'preview-paragraph-3' : id === 'preview-term-library' ? 'preview-paragraph-1' : 'preview-paragraph-2';
        return [{ id: `preview-occurrence-${id}`, paragraphId, seriesOrdinal: requireParagraph(paragraphId).seriesOrdinal, occurrenceText: term.termJp === '朝倉遥' ? '遥' : term.termJp, appliedZh: term.termZh, deviationStatus: 'none', deviationRationale: null, confidence: term.confidence }];
      },
      importCsv: deny('导入术语 CSV'), exportCsv: deny('导出术语 CSV'),
    },
    knowledge: {
      characters: async id => forSeries(id, data.characters),
      history: async id => {
        const c = requireCharacter(id), p = requireParagraph(c.id === 'preview-character-haruka' ? 'preview-paragraph-2' : 'preview-paragraph-3');
        return { names: [{ id: `preview-name-${id}`, name: c.nameJp, sourceStatus: 'manual', fromPara: null, toPara: null, evidence: [] }], aliases: [{ id: `preview-alias-${id}`, name: c.nameJp.slice(2), sourceStatus: 'current', fromPara: p.seriesOrdinal, toPara: null, evidence: [{ id: p.id, at: p.seriesOrdinal, currentText: p.sourceText }] }], fields: [{ id: `preview-field-${id}`, field: 'speech_register', value: c.speechRegister!, sourceStatus: 'manual', fromPara: 0, evidence: [], quotes: [] }], fieldTotal: 1 };
      },
      automaticFieldDecisions: async id => { requireCharacter(id); return []; }, undoAutomaticFieldDecision: deny('撤销自动字段决定'),
      fieldDecisions: async id => { requireCharacter(id); return []; }, undoFieldDecision: deny('撤销人物字段决定'),
      upsertCharacter: deny('保存人物档案'), setQuirks: deny('保存人物语癖'), aliases: async id => [requireCharacter(id).nameJp.slice(2)], addAlias: deny('添加人物别名'),
      mergeCharacters: deny('合并人物'), setCanonicalName: deny('修改人物主名'), removeAlias: deny('删除人物别名'), repairNames: deny('修复人物姓名'),
      relationships: async id => forSeries(id, data.relationships), addresses: async id => forSeries(id, data.addresses), events: async id => forSeries(id, data.events),
      addAddress: deny('添加称呼轨迹'), setAddressVariation: deny('修改称呼变体'), endAddress: deny('结束称呼阶段'),
    },
    export: {
      seriesQualityGate: async id => ({ ok: false, volumes: requireSeries(id).volumes.map(v => ({ volumeId: v.id, volumeNumber: v.volumeNumber, title: v.title, report: report(v.id) })) }),
      runSeries: deny('导出系列文件'), qualityGate: async id => report(id), run: deny('导出册文件'),
    },
    logs: { page: async () => ({ entries: copy(logs), hasMore: false }), detail: async (id, offset=0) => { const text=logs.find(l=>l.id===id)?.message; return text == null ? null : { text: text.slice(offset,offset+12000), hasMore: text.length>offset+12000 }; }, recent: async (afterId, limit = 300) => copy(logs.filter(l => l.id > afterId).slice(0, Math.max(0, Math.min(1000, limit)))), clear: deny('清除任务日志') },
    // Static read-only fixtures never emit progress/log/data changes. No native IPC is attached.
    on: (_event, _callback) => () => {},
  };
  return api;
}
