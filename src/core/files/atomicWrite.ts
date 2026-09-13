import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Never truncate the destination before the complete sibling file is ready. */
export async function atomicWriteFile(path: string, data: Uint8Array, beforeCommit?: () => Promise<void>): Promise<void> {
  const temporary = join(dirname(path), `.v3-export-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx');
  let closed = false;
  try {
    await file.writeFile(data);
    await file.sync();
    await file.close(); closed = true;
    await beforeCommit?.();
    await rename(temporary, path);
  } catch (error) {
    if (!closed) await file.close().catch(() => {});
    try { await unlink(temporary); }
    catch (cleanup) {
      if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`${(error as Error).message}；临时文件未能清理：${temporary}`);
      }
    }
    throw error;
  }
}
