import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from '@shared/ipc';
import { IPC_EVENTS } from '@shared/ipc';

/**
 * 在 sandbox 模式下，contextBridge.exposeInMainWorld 无法克隆 Proxy/嵌套动态对象，
 * 必须暴露「普通数据 + 显式函数」。因此这里不用 Proxy，而是按契约显式生成。
 *
 * 完整性由类型系统强制：`NsKeys` 校验列出的每个方法名都是 Api 契约里的真实键；
 * 下面的 Exhaustive<List, Expected> 校验每个命名空间列出的方法集与契约一一对应——
 * 契约新增方法而此处未加时，构建当场报错，不会拖到运行时渲染层静默崩掉。
 */

// —— 编译期完整性校验工具 ——
type NamespacesOnly = Omit<Api, 'on'>;  // on 是顶层事件订阅，不是方法命名空间
type KeysOf<Ns extends keyof NamespacesOnly> = Array<keyof NamespacesOnly[Ns] & string>;
type Missing<List extends readonly string[], Expected extends string> = Exclude<Expected, List[number]>;
// 若缺失任何契约方法，则 Never[]（类型错误）；否则 [true]
type IsExhaustive<List extends readonly string[], Expected extends string> = Missing<List, Expected> extends never ? true : false;

const NAMESPACES = {
  app: ['getLibraryIdentity', 'getDataDirectory', 'chooseDataDirectory', 'version', 'getProviderSettings', 'setProviderSettings', 'testProvider', 'getUiPrefs', 'setUiPrefs', 'usage', 'openExternal', 'resetLibrary', 'createBackup', 'pickBackup', 'restoreBackup'],
  files: ['pickImport', 'pickSavePath', 'showInFolder'],
  project: ['listImportQueues', 'listDamagedImportQueues', 'quarantineImportQueue', 'createImportQueue', 'updateImportQueue', 'discardImportQueue', 'inspectQueuedFile', 'importNextQueuedFile', 'listSeries', 'getSeries', 'deleteSeries', 'inspectImport', 'cancelImport', 'importFile', 'listVolumes', 'listChapters', 'rebuildEpubChapters', 'referenceTranslations', 'listParagraphs', 'listParagraphsByVolume', 'getParagraph', 'getSettings', 'setSetting', 'prepStatus', 'analysis'],
  workflow: ['deliveryState', 'deliverSeries', 'seriesRunState', 'continueSeries', 'volumeOverview', 'volumeRunState', 'continueVolume', 'resetTrajectoryRepairs', 'pendingRepairs', 'resumeRepairs', 'preRead', 'extractTerms', 'analyzeScenes', 'resolveHonorifics', 'prescanHonorifics', 'localizeNarrative', 'checkLocalizationStatus', 'translate', 'retranslateRechecks', 'autoArbitrate', 'pause', 'resume', 'cancel', 'progress'],
  translation: ['reverify', 'reverifyVolume', 'editFinal', 'confirm', 'unconfirm', 'findings', 'candidates', 'context'],
  review: ['list', 'counts', 'decide', 'resolveHonorific', 'undoResolved', 'previewLegacyChange', 'reconfirmLegacyChange', 'undoLegacyReconfirmation', 'setPreselect', 'aiReview', 'runScoped'],
  glossary: ['list', 'upsert', 'setLock', 'remove', 'addSense', 'setDefaultSense', 'removeSense', 'occurrences', 'importCsv', 'exportCsv'],
  knowledge: ['history', 'characters', 'automaticFieldDecisions', 'undoAutomaticFieldDecision', 'fieldDecisions', 'undoFieldDecision', 'upsertCharacter', 'setQuirks', 'aliases', 'addAlias', 'mergeCharacters', 'setCanonicalName', 'removeAlias', 'repairNames', 'relationships', 'addresses', 'events', 'addAddress', 'setAddressVariation', 'endAddress'],
  export: ['seriesQualityGate', 'runSeries', 'qualityGate', 'run'],
  logs: ['recent', 'clear'],
} as const satisfies { [K in keyof NamespacesOnly]: KeysOf<K> };

// 编译期断言：每个命名空间必须完整覆盖契约。缺失即类型错误。
type AssertExhaustive = {
  [K in keyof NamespacesOnly]: IsExhaustive<(typeof NAMESPACES)[K], keyof NamespacesOnly[K] & string>;
};
const _exhaustive: AssertExhaustive = {
  app: true, files: true, project: true, workflow: true, translation: true,
  review: true, glossary: true, knowledge: true, export: true, logs: true,
} as const;

function buildNamespace<Ns extends keyof NamespacesOnly>(ns: Ns): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of NAMESPACES[ns]) {
    out[method] = (...args: unknown[]): Promise<unknown> => ipcRenderer.invoke(`${String(ns)}.${method}`, ...args);
  }
  return out;
}

const api: Record<string, unknown> = {};
for (const ns of Object.keys(NAMESPACES) as Array<keyof NamespacesOnly>) {
  api[ns] = buildNamespace(ns);
}

// 事件订阅：on(event, cb) —— 返回取消订阅函数
api.on = (event: string, cb: (payload: unknown) => void): (() => void) => {
  if (!(IPC_EVENTS as readonly string[]).includes(event)) throw new Error(`未知事件 ${event}`);
  const listener = (_e: unknown, payload: unknown): void => cb(payload);
  ipcRenderer.on(`event.${event}`, listener);
  return () => ipcRenderer.removeListener(`event.${event}`, listener);
};

contextBridge.exposeInMainWorld('api', api);
