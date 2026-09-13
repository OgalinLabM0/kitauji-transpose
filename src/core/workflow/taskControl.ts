/** A lease lasts until the real async operation settles, not until a progress event. */
export class TaskControl {
  private active: Promise<unknown> | null = null;
  get busy(): boolean { return this.active !== null; }
  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('已有任务在运行，请先停止或等待完成');
    // Set the lease before invoking operation so synchronous progress cannot reenter.
    const result = Promise.resolve().then(operation);
    this.active = result;
    return result.finally(() => { if (this.active === result) this.active = null; });
  }
  async settled(): Promise<void> { try { await this.active; } catch { /* callers own the task error */ } }
}
