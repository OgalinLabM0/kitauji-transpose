import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, realpathSync, lstatSync, copyFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Db } from '../src/core/db/database';
import { rebindMovedLibrary } from '../src/core/db/libraryIdentity';

interface Location { current: string; pending?: string }
const configName = 'data-location.json';
export function readDataLocation(root: string): Location {
  const file = join(root, configName);
  if (!existsSync(file)) return { current: join(root, 'data') };
  const config: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!config || typeof config !== 'object' || !('current' in config) || typeof config.current !== 'string'
    || ('pending' in config && typeof config.pending !== 'string')) throw new Error('数据目录配置损坏，请恢复 data-location.json；原书库未改动。');
  const c = config as Location;
  return { current: resolve(root, c.current), ...(c.pending ? { pending: resolve(root, c.pending) } : {}) };
}
function save(root: string, config: Location): void {
  const file = join(root, configName), temp = `${file}.${randomUUID()}.tmp`;
  // Keep the default portable when the entire application folder moves.
  const current = resolve(config.current) === resolve(root, 'data') ? 'data' : config.current;
  writeFileSync(temp, JSON.stringify({ ...config, current }, null, 2), { flag: 'wx' });
  renameSync(temp, file);
}
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !rel || (!rel.startsWith('..') && !isAbsolute(rel));
}
export function checkDataDestination(source: string, destination: string): string {
  const src = realpathSync(source), dst = realpathSync(destination);
  if (inside(src, dst) || inside(dst, src)) throw new Error('请选择与当前数据目录互不包含的空文件夹。');
  if (!lstatSync(dst).isDirectory() || readdirSync(dst).length) throw new Error('请选择空文件夹，避免覆盖已有文件或混合两份书库。');
  return dst;
}
export function scheduleDataMove(root: string, current: string, destination: string): void {
  const target = checkDataDestination(current, destination);
  save(root, { current, pending: target });
}
/** Runs on restart, after the source instance lock and before Chromium/SQLite open. */
export function finishDataMove(root: string): string {
  const config = readDataLocation(root);
  if (!config.pending) return config.current;
  try {
    const target = checkDataDestination(config.current, config.pending);
    const copy = (source: string, dest: string): void => {
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        const from = join(source, entry.name), to = join(dest, entry.name);
        if (entry.isSymbolicLink()) throw new Error('数据目录含链接，已停止迁移以保护原文件。');
        if (entry.isDirectory()) { mkdirSync(to); copy(from, to); }
        else if (entry.isFile()) {
          copyFileSync(from, to, 1);
          const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
          if (hash(from) !== hash(to)) throw new Error('迁移校验失败，原文件保留。');
        } else throw new Error('数据目录含不支持的文件，原文件保留。');
      }
    };
    copy(config.current, target);
    const library = join(target, 'library.sqlite');
    if (existsSync(library)) {
      const db = new Db(library);
      try { rebindMovedLibrary(db, join(config.current, 'library.sqlite')); }
      finally { db.close(); }
    }
    save(root, { current: target });
    return target;
  } catch (error) {
    // Never adopt an incomplete target or silently retry a partial copy.
    save(root, { current: config.current });
    throw new Error(`数据迁移未完成，仍使用原目录；目标中的副本请保留核查。${(error as Error).message}`);
  }
}
