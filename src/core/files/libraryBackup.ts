import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ProjectStore, type Param } from '@core/db';
import { SCHEMA_VERSION } from '@core/db/schema';
import { advanceLibraryIdentity, readLibraryIdentity } from '@core/db/libraryIdentity';
import { atomicWriteFile } from './atomicWrite';
import type { BackupSummary } from '@shared/ipc';

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const tables = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(r => r.name);
const columns = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string; type: string }[]).map(r => [r.name, r.type]).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0);

/** VACUUM INTO includes WAL state and produces a standalone consistent database. */
export async function backupLibrary(store: ProjectStore, outputPath: string): Promise<BackupSummary> {
  if (!/\.v3backup$/i.test(outputPath)) throw new Error('备份文件请使用 .v3backup 扩展名。');
  if (resolve(outputPath).toLowerCase() === resolve(store.db.path).toLowerCase()) throw new Error('不能覆盖正在使用的书库。');
  const dir = await mkdtemp(join(tmpdir(), 'v3-backup-'));
  try {
    const path = join(dir, 'snapshot.sqlite');
    store.db.run('VACUUM INTO ?', [path]);
    const summary = await inspectBackup(path);
    await atomicWriteFile(outputPath, new Uint8Array(await readFile(path)));
    return summary;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function withBackup<T>(path: string, work: (source: DatabaseSync, hash: string) => T): Promise<T> {
  const data = await readFile(path);
  if (!data.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw new Error('这不是有效的书库备份。');
  const dir = await mkdtemp(join(tmpdir(), 'v3-restore-'));
  let source: DatabaseSync | undefined;
  try {
    const immutable = join(dir, 'source.sqlite');
    await writeFile(immutable, data, { flag: 'wx' });
    source = new DatabaseSync(immutable, { readOnly: true });
    source.exec('PRAGMA trusted_schema=OFF');
    if ((source.prepare('PRAGMA integrity_check').all() as Record<string, unknown>[]).some(r => Object.values(r)[0] !== 'ok')) throw new Error('备份完整性检查失败。');
    if (source.prepare('PRAGMA foreign_key_check').all().length) throw new Error('备份存在断开的数据关联。');
    const version = source.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
    const migrateNames = Number(version) === 11;
    const migrateCalls = Number(version) === 11 || Number(version) === 12;
    if (Number(version) !== SCHEMA_VERSION && !migrateCalls) throw new Error(`备份版本 ${String(version)} 与当前版本 ${SCHEMA_VERSION} 不兼容。`);
    const canonical = new ProjectStore(':memory:');
    try {
      const names = tables(canonical.db.raw).filter(name => !migrateNames || !['character_name_origins','character_name_observations'].includes(name));
      if (JSON.stringify(names) !== JSON.stringify(tables(source))) throw new Error('备份数据表与本软件不匹配。');
      for (const table of names) {
        const expected = columns(canonical.db.raw, table).filter(([name]) => !(migrateCalls && table === 'ai_calls' && name === 'paragraph_id'));
        if (JSON.stringify(expected) !== JSON.stringify(columns(source, table))) throw new Error(`备份字段不匹配：${table}`);
      }
    } finally { canonical.close(); }
    if (migrateCalls) {
      if (source.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger'").get()) throw new Error('旧备份包含非标准触发器，不能自动升级。');
      source.close(); source = undefined;
      const migrated = new ProjectStore(immutable); migrated.close();
      source = new DatabaseSync(immutable, { readOnly: true }); source.exec('PRAGMA trusted_schema=OFF');
      if (source.prepare('PRAGMA foreign_key_check').all().length) throw new Error('旧备份升级后关联检查失败。');
    }
    return work(source, digest(data));
  } finally { source?.close(); await rm(dir, { recursive: true, force: true }); }
}

function summary(db: DatabaseSync, hash: string): BackupSummary {
  const count = (table: string) => Number(db.prepare(`SELECT COUNT(*) n FROM ${quote(table)}`).get()!.n);
  return { hash, schemaVersion: SCHEMA_VERSION, series: count('series'), volumes: count('volumes'), paragraphs: count('paragraphs'), finals: count('translation_finals'), archives: count('source_archives') };
}

export function inspectBackup(path: string): Promise<BackupSummary> { return withBackup(path, summary); }

/** Clear rows atomically without closing or deleting an in-use database file. */
export function clearLibraryData(store: ProjectStore): void {
  store.db.raw.exec('PRAGMA foreign_keys=OFF');
  try {
    store.transaction(() => {
      const previousIdentity = readLibraryIdentity(store.db);
      for (const table of tables(store.db.raw)) store.db.run(`DELETE FROM ${quote(table)}`);
      store.db.run('INSERT INTO meta(key,value) VALUES(?,?)', ['schema_version', String(SCHEMA_VERSION)]);
      advanceLibraryIdentity(store.db, previousIdentity);
    });
  } finally { store.db.raw.exec('PRAGMA foreign_keys=ON'); }
}

/** Caller holds exclusive maintenance ownership. Preserve the connection and all repo references. */
export async function restoreLibrary(store: ProjectStore, path: string, expectedHash: string, afterCopy?: () => void): Promise<BackupSummary> {
  return withBackup(path, (source, hash) => {
    if (hash !== expectedHash) throw new Error('备份在检查后已变化，请重新选择。');
    const result = summary(source, hash);
    const names = tables(store.db.raw);
    const foreignKeys = Number(store.db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys ?? 1);
    store.db.raw.exec('PRAGMA foreign_keys=OFF');
    try {
      store.transaction(() => {
        const previousIdentity = readLibraryIdentity(store.db);
        for (const table of names) store.db.run(`DELETE FROM ${quote(table)}`);
        for (const table of names) {
          const fields = columns(source, table).map(c => c[0]!);
          const insert = store.db.raw.prepare(`INSERT INTO ${quote(table)} (${fields.map(quote).join(',')}) VALUES (${fields.map(() => '?').join(',')})`);
          for (const row of source.prepare(`SELECT * FROM ${quote(table)}`).iterate()) insert.run(...fields.map(f => row[f] as Param));
        }
        if (store.db.all('PRAGMA foreign_key_check').length) throw new Error('恢复关联检查失败，已保留原书库。');
        advanceLibraryIdentity(store.db, previousIdentity);
        afterCopy?.();
      });
    } finally { store.db.raw.exec(`PRAGMA foreign_keys=${foreignKeys ? 'ON' : 'OFF'}`); }
    return result;
  });
}
