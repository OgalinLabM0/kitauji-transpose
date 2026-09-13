import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { ProjectStore } from '@core/db';
import type { ImportQueueDamage, ImportQueueState, ImportQueueTarget } from '@shared/importQueue';
import { importEpub, type ImportResult } from '@core/epub/epubImport';
import { importTxt } from '@core/txt/txtImport';
import { inspectImport } from './importPreflight';

const PREFIX = 'import-queue:';
const text = z.string().min(1);
export const importQueueTargetSchema = z.object({ seriesId: text.nullable(), title: z.string(), volumeNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const reportSchema = z.object({ hash: text, chapters: z.array(z.object({ title: z.string().nullable(), paragraphs: z.number().int().nonnegative() })), paragraphs: z.number().int().nonnegative(), warnings: z.array(z.string()), existing: z.object({ seriesId: text, volumeId: text, seriesTitle: z.string() }).nullable() });
const resultSchema = z.object({ seriesId: text, volumeId: text, chapters: z.number().int().nonnegative(), paragraphs: z.number().int().nonnegative(), blocks: z.number().int().nonnegative(), unparseable: z.array(z.string()), missingTocResources: z.array(z.string()).default([]), tocMapped: z.number().int().nonnegative(), tocTotal: z.number().int().nonnegative(), reusedExisting: z.boolean() });
const stateSchema = z.object({ version: z.literal(1), id: text, revision: z.number().int().nonnegative(), updatedAt: text, target: importQueueTargetSchema, entries: z.array(z.object({ id: text, path: text, name: text, state: z.enum(['pending', 'inspected', 'importing', 'done', 'error']), report: reportSchema.nullable(), result: resultSchema.nullable(), error: z.string().nullable() })) });
type Reader = (path: string, signal?: AbortSignal) => Promise<Uint8Array>;
const QUARANTINE_PREFIX = 'import-queue-quarantine:';
const DAMAGED_MESSAGE = '导入清单损坏，原记录已保留。隔离只保留损坏记录，不是数据修复；原文件和已导入书籍不受影响，可重新选择文件，导入时会核对哈希并复用已有书籍。';
type QueueRecord = { key: string; value: unknown; bytes: Uint8Array; storageType: string };
const fingerprintOf = (row: QueueRecord): string => createHash('sha256').update(row.storageType).update('\0').update(row.bytes).digest('hex');

/** Only malformed record content is isolated. Database and unexpected runtime failures propagate. */
function parseQueue(id: string, value: unknown): ImportQueueState | null {
  if (typeof value !== 'string') return null;
  let decoded: unknown;
  try { decoded = JSON.parse(value); }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  const parsed = stateSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.id !== id || new Set(parsed.data.entries.map(e => e.id)).size !== parsed.data.entries.length || parsed.data.entries.some(e => (e.state === 'done') !== !!e.result)) return null;
  return parsed.data;
}

/** Persistent local-file workflow only. Loading/recovery never reads files or starts a model. */
export class ImportQueue {
  constructor(private readonly store: ProjectStore, private readonly read: Reader = async (path, signal) => new Uint8Array(await readFile(path, { ...(signal ? { signal } : {}) }))) {}
  list(): ImportQueueState[] {
    const rows = this.store.db.all<{ key: string; value: unknown }>('SELECT key,value FROM meta WHERE substr(key,1,?)=? ORDER BY key', [PREFIX.length, PREFIX]);
    return rows.flatMap(row => { const state = parseQueue(row.key.slice(PREFIX.length), row.value); return state ? [state] : []; });
  }
  listDamaged(): ImportQueueDamage[] {
    const rows = this.store.db.all<QueueRecord>('SELECT key,value,CAST(value AS BLOB) AS bytes,typeof(value) AS storageType FROM meta WHERE substr(key,1,?)=? ORDER BY key', [PREFIX.length, PREFIX]);
    return rows.flatMap(row => {
      const id = row.key.slice(PREFIX.length);
      return parseQueue(id, row.value) ? [] : [{ id, fingerprint: fingerprintOf(row), message: DAMAGED_MESSAGE }];
    });
  }
  /** Explicitly preserve exact SQLite value bytes before removing an active damaged record. */
  quarantine(id: string, fingerprint: string): void {
    if (typeof id !== 'string' || !id.trim()) throw new Error('导入清单编号不能为空。');
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('导入清单指纹无效，请重新读取损坏清单。');
    this.store.transaction(() => {
      const key = `${PREFIX}${id}`;
      const row = this.store.db.get<QueueRecord>('SELECT key,value,CAST(value AS BLOB) AS bytes,typeof(value) AS storageType FROM meta WHERE key=?', [key]);
      if (!row) throw new Error('导入清单不存在或已隔离，请重新读取。');
      if (parseQueue(id, row.value)) throw new Error('该导入清单正常，不能作为损坏记录隔离。');
      if (fingerprintOf(row) !== fingerprint) throw new Error('损坏清单已变化，本次未隔离，请重新读取后确认。');
      // Copy in SQL, without decoding or serializing: even malformed UTF-8/BLOB values stay intact.
      const copied = this.store.db.run('INSERT INTO meta(key,value) SELECT ?,value FROM meta WHERE key=?', [`${QUARANTINE_PREFIX}${id}:${randomUUID()}`, key]);
      if (Number(copied.changes) !== 1) throw new Error('隔离记录未保存，原清单保留，请重试。');
      const removed = this.store.db.run('DELETE FROM meta WHERE key=?', [key]);
      if (Number(removed.changes) !== 1) throw new Error('清单未完成隔离，本次操作已回滚，请重试。');
    });
  }
  get(id: string): ImportQueueState {
    const row = this.store.db.get<{ value: unknown }>('SELECT value FROM meta WHERE key=?', [`${PREFIX}${id}`]);
    if (!row) throw new Error('导入清单不存在，请重新打开书架。');
    const parsed = parseQueue(id, row.value);
    if (!parsed) throw new Error(DAMAGED_MESSAGE);
    return parsed;
  }
  create(files: { path: string; name: string }[], target: ImportQueueTarget): ImportQueueState {
    const validFiles = z.array(z.object({ path: text, name: text }).strict()).min(1).max(1000).parse(files);
    const validTarget = importQueueTargetSchema.parse(target);
    if (!validTarget.seriesId && !validTarget.title.trim()) throw new Error('请填写系列名称。');
    const state: ImportQueueState = { version: 1, id: randomUUID(), revision: 0, updatedAt: new Date().toISOString(), target: validTarget, entries: validFiles.map(f => ({ ...f, id: randomUUID(), state: 'pending', report: null, result: null, error: null })) };
    this.store.db.run('INSERT INTO meta(key,value) VALUES(?,?)', [`${PREFIX}${state.id}`, JSON.stringify(state)]);
    return state;
  }
  private save(state: ImportQueueState, expected: number): ImportQueueState {
    const current = this.get(state.id);
    if (current.revision !== expected) throw new Error('导入清单已更新，本次旧操作未覆盖新清单。');
    const next = stateSchema.parse({ ...state, revision: expected + 1, updatedAt: new Date().toISOString() });
    this.store.db.run('UPDATE meta SET value=? WHERE key=?', [JSON.stringify(next), `${PREFIX}${next.id}`]);
    return next;
  }
  update(id: string, revision: number, target: ImportQueueTarget, pendingOrder: string[]): ImportQueueState {
    return this.store.transaction(() => {
      const current = this.get(id);
      if (current.revision !== revision || current.entries.some(e => e.state === 'importing')) throw new Error('导入清单正在处理或已更新，请重新打开。');
      const validTarget = importQueueTargetSchema.parse(target);
      if (!validTarget.seriesId && !validTarget.title.trim()) throw new Error('请填写系列名称。');
      if (new Set(pendingOrder).size !== pendingOrder.length) throw new Error('文件顺序不能重复。');
      const pending = pendingOrder.map(pid => { const e = current.entries.find(e => e.id === pid && !e.result); if (!e) throw new Error('未完成文件已变化。'); return e; });
      return this.save({ ...current, target: validTarget, entries: [...current.entries.filter(e => !!e.result), ...pending] }, revision);
    });
  }
  discard(id: string, revision: number): void {
    const state = this.get(id);
    if (state.revision !== revision || state.entries.some(e => e.state === 'importing')) throw new Error('导入清单正在处理或已更新。');
    this.store.db.run('DELETE FROM meta WHERE key=?', [`${PREFIX}${id}`]);
  }
  recover(): void {
    for (const state of this.list()) if (state.entries.some(e => e.state === 'importing')) {
      this.save({ ...state, entries: state.entries.map(e => e.state === 'importing' ? { ...e, state: 'error', error: '上次导入已中断，已提交整册和结果保留；请重新体检后继续。', report: null } : e) }, state.revision);
    }
  }
  async inspect(id: string, entryId: string, signal?: AbortSignal): Promise<ImportQueueState> {
    const state = this.get(id), entry = state.entries.find(e => e.id === entryId);
    if (!entry || entry.result || entry.state === 'importing') throw new Error('该文件无需体检或正在导入。');
    signal?.throwIfAborted();
    try {
      const bytes = await this.read(entry.path, signal); signal?.throwIfAborted();
      const report = await inspectImport(this.store, basename(entry.path), bytes, signal); signal?.throwIfAborted();
      return this.save({ ...state, entries: state.entries.map(e => e.id === entryId ? { ...e, state: 'inspected', report, error: null } : e) }, state.revision);
    } catch (error) {
      if (this.get(id).revision === state.revision) this.save({ ...state, entries: state.entries.map(e => e.id === entryId ? { ...e, state: 'error', report: null, error: signal?.aborted ? '体检已停止，可重新体检。' : String(error) } : e) }, state.revision);
      throw error;
    }
  }
  async importNext(id: string, signal?: AbortSignal): Promise<ImportQueueState> {
    let state = this.get(id);
    if (state.entries.some(e => e.state === 'importing')) throw new Error('已有文件正在导入。');
    const entry = state.entries.find(e => !e.result);
    if (!entry) return state;
    if (!entry.report) throw new Error('请先体检第一个未完成文件。');
    signal?.throwIfAborted();
    state = this.save({ ...state, entries: state.entries.map(e => e.id === entry.id ? { ...e, state: 'importing', error: null } : e) }, state.revision);
    const expected = state.revision;
    try {
      const bytes = await this.read(entry.path, signal); signal?.throwIfAborted();
      if (!/\.(epub|txt)$/i.test(entry.path)) throw new Error('仅支持 EPUB 或 TXT 文件。');
      const onCommitted = (result: ImportResult) => {
        signal?.throwIfAborted();
        const { archiveId: _archiveId, ...summary } = result;
        const target = result.reusedExisting ? state.target : { ...state.target, seriesId: result.seriesId, volumeNumber: state.target.volumeNumber + 1 };
        state = this.save({ ...state, target, entries: state.entries.map(e => e.id === entry.id ? { ...e, state: 'done', result: summary, error: null } : e) }, expected);
      };
      const options = { ...(state.target.seriesId ? { seriesId: state.target.seriesId } : { seriesTitle: state.target.title.trim() }), volumeNumber: state.target.volumeNumber, expectedHash: entry.report.hash, ...(signal ? { signal } : {}), onCommitted };
      if (/\.epub$/i.test(entry.path)) await importEpub(this.store, basename(entry.path), bytes, options);
      else importTxt(this.store, basename(entry.path), bytes, options);
      return state;
    } catch (error) {
      const current = this.get(id);
      if (current.revision === expected) this.save({ ...current, entries: current.entries.map(e => e.id === entry.id ? { ...e, state: 'error', report: null, error: signal?.aborted ? '导入已停止；本文件未完成，可重新体检后继续。' : String(error) } : e) }, expected);
      throw error;
    }
  }
}
