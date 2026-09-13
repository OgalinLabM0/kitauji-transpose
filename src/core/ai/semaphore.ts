import { ProviderError } from './providers/adapter';

interface Waiter { grant: () => void; cancel: () => void; signal?: AbortSignal }

/** Reserve permits before waking waiters; cancelled waiters never run a request. */
export class Semaphore {
  private readonly queue: Waiter[] = [];
  private active = 0;
  private max: number;
  constructor(max: number) { this.max = Math.max(1, max); }
  setMax(max: number): void { this.max = Math.max(1, max); this.drain(); }
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new ProviderError('abort', '已取消'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        ...(signal ? { signal } : {}),
        grant: () => {
          signal?.removeEventListener('abort', waiter.cancel);
          this.active++;
          let released = false;
          resolve(() => { if (released) return; released = true; this.active--; this.drain(); });
        },
        cancel: () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal?.removeEventListener('abort', waiter.cancel);
          reject(new ProviderError('abort', '已取消'));
          this.drain();
        },
      };
      this.queue.push(waiter);
      signal?.addEventListener('abort', waiter.cancel, { once: true });
      this.drain();
    });
  }
  private drain(): void {
    while (this.active < this.max && this.queue.length) this.queue.shift()!.grant();
  }
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new ProviderError('abort', '已取消'));
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new ProviderError('abort', '已取消')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
