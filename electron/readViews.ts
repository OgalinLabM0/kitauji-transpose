import { Worker } from 'node:worker_threads';
import type { PrepStatus } from '../src/shared/ipc';
import type { ParagraphView } from '../src/shared/types';
type Results = { prep: PrepStatus; chapter: ParagraphView[]; volume: ParagraphView[] };
/** UI reads never share the main-thread database connection or perform writes. */
export class ReadViews {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly path: () => string) {}
  read<K extends keyof Results>(kind: K, id: string): Promise<Results[K]> {
    if (!this.worker) {
      const worker = new Worker(new URL('./readViewsWorker.mjs', import.meta.url));
      this.worker = worker;
      worker.on('message', (message: { seq: number; value?: unknown; error?: string }) => {
        if (this.worker !== worker) return;
        const request = this.pending.get(message.seq); if (!request) return;
        this.pending.delete(message.seq); clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
      });
      worker.on('error', error => { if (this.worker === worker) this.cancel(error); });
      worker.on('exit', () => { if (this.worker === worker) this.cancel(new Error('状态查询线程已退出，请重试')); });
    }
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancel(new Error('状态查询耗时过长，已有任务不受影响，请重试')), 60000);
      this.pending.set(seq, { resolve, reject, timer });
      this.worker!.postMessage({ seq, kind, id, path: this.path() });
    });
  }
  cancel(error = new Error('书库正在关闭或维护，查询已取消')): Promise<void> {
    const worker = this.worker; this.worker = null;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); return worker ? worker.terminate().then(() => {}) : Promise.resolve();
  }
}
