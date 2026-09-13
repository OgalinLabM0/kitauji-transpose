import { mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Fail explicitly if the application directory is read-only; never fall back to C:. */
export function prepareDataPaths(executable: string, developmentRoot: string, packaged: boolean, override?: string) {
  const data = override ? resolve(override) : join(packaged ? dirname(executable) : resolve(developmentRoot), 'data');
  try {
    mkdirSync(data, { recursive: true });
    const probe = join(data, `.write-check-${randomUUID()}`);
    closeSync(openSync(probe, 'wx'));
    unlinkSync(probe);
    const temp = join(data, 'temp'), logs = join(data, 'logs'), crashes = join(data, 'crashes');
    for (const path of [temp, logs, crashes]) mkdirSync(path, { recursive: true });
    return { data, temp, logs, crashes };
  } catch {
    throw new Error(`无法写入数据目录：${data}。请把整个程序文件夹移到可写位置后重试；不会改用C盘保存。`);
  }
}
