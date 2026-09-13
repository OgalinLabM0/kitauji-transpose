import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSION } from './schema';

/** Runs before any application DDL or WAL changes. Unknown databases are read-only failures. */
export function inspectDatabaseVersion(raw: DatabaseSync): number | null {
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  if (!tables.length) return null;
  if (!tables.some(t => t.name === 'meta')) throw new Error('书库缺少版本记录，已拒绝修改；请从备份恢复或使用创建它的程序。');
  const value = raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
  const version = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('书库版本记录损坏，已拒绝修改原库。');
  if (version > SCHEMA_VERSION) throw new Error(`书库版本${version}高于本程序支持的${SCHEMA_VERSION}，请使用较新版本；原库未修改。`);
  return version;
}

/** SQLite snapshot includes committed WAL data; copying the main file alone does not. */
export function snapshotBeforeMigration(raw: DatabaseSync, path: string, from: number): string | null {
  if (path === ':memory:') return null;
  const backupPath = `${path}.before-v${from}-to-v${SCHEMA_VERSION}-${randomUUID()}.bak`;
  raw.prepare('VACUUM INTO ?').run(backupPath);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const integrity = backup.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || inspectDatabaseVersion(backup) !== from) {
      throw new Error('升级前快照校验失败，未开始修改原库。');
    }
  } finally { backup.close(); }
  return backupPath;
}
