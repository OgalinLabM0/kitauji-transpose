import type { LibraryIdentity } from '@shared/ipc';

import { validLibraryIdentity } from '@shared/libraryIdentity';
export { validLibraryIdentity } from '@shared/libraryIdentity';
export function sameLibraryIdentity(a: LibraryIdentity | null | undefined, b: LibraryIdentity | null | undefined): boolean {
  return validLibraryIdentity(a) && validLibraryIdentity(b) && a.libraryId === b.libraryId && a.epoch === b.epoch;
}
export interface IdentityState { identity: LibraryIdentity | null; token: string; status: 'loading' | 'blocked' | 'ready' | 'error'; error: string }
/** IPC loader, deliberately with no public setter accepting a renderer-declared identity.
 * A generation fence rejects late loads, even when IDs happen to match. A second
 * backend read after initial data loading rejects maintenance during bootstrap.
 */
export class DraftIdentityScope {
  private state: IdentityState = { identity: null, token: crypto.randomUUID(), status: 'loading', error: '' };
  private listeners = new Set<() => void>();
  snapshot = (): IdentityState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private publish(state: IdentityState): void { this.state = state; this.listeners.forEach(fn => fn()); }
  invalidate(status: 'blocked' | 'loading' = 'blocked'): void { this.publish({ identity: null, token: crypto.randomUUID(), status, error: '' }); }
  isCurrent(token: string): boolean { return this.state.status === 'ready' && this.state.token === token; }
  async load(read: () => Promise<unknown>, prepare: () => Promise<void> = async () => {}): Promise<boolean> {
    this.invalidate('loading');
    const token = this.state.token;
    try {
      const identity = await read();
      if (this.state.token !== token) return false;
      if (!validLibraryIdentity(identity)) throw new Error('书库身份返回无效，已停止自动恢复草稿。');
      await prepare();
      if (this.state.token !== token) return false;
      const verified = await read();
      if (this.state.token !== token) return false;
      if (!sameLibraryIdentity(identity, verified as LibraryIdentity)) throw new Error('载入期间书库身份已变化，请重试读取。');
      this.publish({ identity: { ...identity }, token, status: 'ready', error: '' });
      return true;
    } catch (error) {
      if (this.state.token !== token) return false;
      this.publish({ identity: null, token, status: 'error', error: `无法确认书库身份：${error instanceof Error ? error.message : String(error)}。历史草稿仍可复制，暂不自动填入或提交。` });
      return false;
    }
  }
}
