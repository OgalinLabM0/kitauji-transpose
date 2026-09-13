import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { ProjectStore } from '@core/db';
import { nowIso } from '@core/db';
import type { AiClient } from '@core/ai';
import type { SeriesDeliveryRequest, SeriesDeliveryState } from '@shared/ipc';
import { atomicWriteFile } from '../files/atomicWrite';
import { runSeriesFlow } from './seriesFlow';
import { exportSeries } from './seriesExport';
import { captureDeliveryDecisionWait, clearDeliveryDecisionWait } from './deliveryContinuation';

const key = (id: string) => `series-delivery:${id}`;
export function deliveryState(store: ProjectStore, seriesId: string): SeriesDeliveryState | null {
  const row = store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [key(seriesId)]);
  try { return row ? JSON.parse(row.value) as SeriesDeliveryState : null; } catch { return null; }
}
export function recoverDeliveries(store: ProjectStore): void {
  for (const row of store.db.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key LIKE 'series-delivery:%'")) {
    try {
      const state = JSON.parse(row.value) as SeriesDeliveryState;
      if (state.status === 'running' || state.status === 'attention') store.db.run('UPDATE meta SET value=? WHERE key=?', [JSON.stringify({ ...state, ...clearDeliveryDecisionWait(), ...(state.status === 'running' ? { status: 'stopped' } : {}), message: '上次自动交付已保留，点击继续会核对稿件和保存位置；不会因旧选择自行启动', updatedAt: nowIso() }), row.key]);
    } catch { /* Never infer delivery from malformed historical state. */ }
  }
}
async function fileHash(path: string): Promise<string> {
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw e; }
}
interface Options {
  signal?: AbortSignal;
  onState?: (state: SeriesDeliveryState) => void;
  volumeOptions?: NonNullable<Parameters<typeof runSeriesFlow>[3]>['volumeOptions'];
}

/** User selects destination once; pauses preserve intent, and resumes never overwrite a newer file. */
export async function deliverSeries(store: ProjectStore, ai: AiClient, seriesId: string, request?: SeriesDeliveryRequest, opts: Options = {}): Promise<SeriesDeliveryState> {
  if (!store.projects.getSeries(seriesId)) throw new Error('作品不存在');
  opts.signal?.throwIfAborted();
  const scope = () => store.projects.listVolumes(seriesId).map(v => ({ id: v.id, number: v.volumeNumber }));
  const previous = deliveryState(store, seriesId);
  if (!request && (!previous || previous.status === 'done')) throw new Error('没有未完成的自动交付任务；如需重新导出，请选择保存位置并开始新任务');
  const config = request ?? previous!;
  if (!['zh', 'bilingual'].includes(config.mode) || !isAbsolute(config.outputPath) || !/\.zip$/i.test(config.outputPath)) throw new Error('请选择完整的 ZIP 保存位置');
  let state: SeriesDeliveryState = request ? { ...request, seriesId, status: 'running', phase: 'process', scope: scope(), originalFileHash: await fileHash(request.outputPath), message: '准备自动处理并保存', updatedAt: nowIso(), run: null, result: null } : { ...previous!, status: 'running', result: null };
  const publish = (patch: Partial<SeriesDeliveryState>) => {
    state = { ...state, ...patch, updatedAt: nowIso() };
    store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [key(seriesId), JSON.stringify(state)]);
    opts.onState?.(structuredClone(state));
  };
  const check = () => {
    opts.signal?.throwIfAborted();
    if (JSON.stringify(scope()) !== JSON.stringify(state.scope)) throw new Error('已导入册次范围已变化，请重新选择保存位置并开始新任务');
  };
  const checkFile = async () => {
    await access(dirname(state.outputPath), constants.W_OK);
    if (await fileHash(state.outputPath) !== state.originalFileHash) throw new Error('保存位置的文件已被改动或新增，未覆盖它；请查看现有文件，重新选择保存位置后再开始');
  };
  try {
    publish({ ...clearDeliveryDecisionWait(), phase: 'process', message: '核对原保存位置与册次范围' }); check();
    await checkFile(); check();
    const run = await runSeriesFlow(store, ai, seriesId, { ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.volumeOptions ? { volumeOptions: opts.volumeOptions } : {}), onState: run => publish({ run, message: run.message }) });
    check();
    if (run.status !== 'done') {
      const stopped: SeriesDeliveryState = { ...state, run, status: run.status === 'stopped' ? 'stopped' : 'attention' };
      publish({ ...captureDeliveryDecisionWait(store, stopped), status: stopped.status, message: `${run.message}；保存位置已保留，处理问题后可继续自动交付` }); return state;
    }
    publish({ phase: 'export', message: '全部册通过，正在生成并保存合集' });
    check();
    const result = await exportSeries(store, seriesId, state.mode, state.outputPath, (path, bytes) => atomicWriteFile(path, bytes, async () => { check(); await checkFile(); check(); }), opts.signal);
    if (result.ok) {
      try { publish({ result, status: 'done', message: `已自动保存${result.files.length}册：${state.outputPath}` }); }
      catch { state = { ...state, result, status: 'done', message: `文件已保存：${state.outputPath}，但任务记录未能更新；请先查看文件再重试` }; }
    } else publish({ result, status: opts.signal?.aborted ? 'stopped' : 'attention', message: result.messages.join('；') });
    return state;
  } catch (e) {
    publish({ ...clearDeliveryDecisionWait(), status: opts.signal?.aborted ? 'stopped' : 'attention', message: opts.signal?.aborted ? '自动交付已停止，成果与保存位置保留，可继续' : (e as Error).message });
    return state;
  }
}
