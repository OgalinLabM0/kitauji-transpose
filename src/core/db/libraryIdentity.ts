import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Db } from './database';
import type { LibraryIdentity } from '@shared/ipc';
import { validLibraryIdentity } from '@shared/libraryIdentity';

/** Additive meta protocol, independent of relational schema_version. Unknown/corrupt
 * records fail closed; only a wholly missing key (legacy DB) may be initialized.
 * Path binding prevents an ordinary copied database at another path impersonating
 * the original library. Supported restore always retains destination ID + advances epoch.
 */
export const LIBRARY_IDENTITY_KEY = 'library_identity_v1';
interface StoredIdentity extends LibraryIdentity { binding: string }
function pathBinding(file: string): string {
  if (file === ':memory:') return 'memory';
  const path = realpathSync.native(resolve(file));
  return createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex');
}
function binding(db: Db): string { return pathBinding(db.path); }
function parse(value: unknown): StoredIdentity {
  let record: unknown;
  try { record = JSON.parse(String(value)); } catch { throw new Error('书库身份记录损坏，已停止使用草稿身份。'); }
  if (!validLibraryIdentity(record) || !('binding' in record) || typeof record.binding !== 'string' || !/^(memory|[a-f0-9]{64})$/.test(record.binding)) throw new Error('书库身份版本或记录无效，已停止打开书库。');
  return { version: record.version, libraryId: record.libraryId, epoch: record.epoch, binding: record.binding };
}
function publicIdentity(record: StoredIdentity): LibraryIdentity { return { version: 1, libraryId: record.libraryId, epoch: record.epoch }; }
function write(db: Db, record: StoredIdentity): LibraryIdentity {
  const text = JSON.stringify(record);
  db.run('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [LIBRARY_IDENTITY_KEY, text]);
  if (db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [LIBRARY_IDENTITY_KEY])?.value !== text) throw new Error('书库身份写入校验失败，事务已取消。');
  return publicIdentity(record);
}
export function initializeLibraryIdentity(db: Db): LibraryIdentity {
  return db.transaction(() => {
    const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [LIBRARY_IDENTITY_KEY]);
    const current = row ? parse(row.value) : null;
    const pathBinding = binding(db);
    if (current?.binding === pathBinding) return publicIdentity(current);
    return write(db, { version: 1, libraryId: randomUUID(), epoch: 0, binding: pathBinding });
  });
}
/** Read-only. Never trusts an identity supplied by an IPC caller, or repairs on read. */
export function readLibraryIdentity(db: Db): LibraryIdentity {
  const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [LIBRARY_IDENTITY_KEY]);
  if (!row) throw new Error('书库身份尚未初始化，已停止使用草稿。');
  const current = parse(row.value);
  if (current.binding !== binding(db)) throw new Error('书库路径身份不匹配，已停止使用草稿。');
  return publicIdentity(current);
}
/** Must run INSIDE the same transaction that replaces/deletes library rows.
 * previous is read from the destination DB before deleting meta, never from a backup or renderer.
 */
export function advanceLibraryIdentity(db: Db, previous: LibraryIdentity): LibraryIdentity {
  if (!Number.isSafeInteger(previous.epoch + 1)) throw new Error('书库恢复代数已超出安全范围，操作已取消。');
  return write(db, { ...previous, epoch: previous.epoch + 1, binding: binding(db) });
}
/** Only for a verified full-profile move, before opening ProjectStore at the target.
 * Ordinary copied databases still receive a new identity on initialization. */
export function rebindMovedLibrary(db: Db, verifiedSourcePath: string): void {
  db.transaction(() => {
    const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [LIBRARY_IDENTITY_KEY]);
    if (!row) return; // Legacy profiles have no scoped drafts yet.
    const current = parse(row.value);
    if (current.binding !== pathBinding(verifiedSourcePath)) throw new Error('迁移来源书库身份不匹配，已停止切换目录。');
    write(db, { ...current, binding: binding(db) });
  });
}
