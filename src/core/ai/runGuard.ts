import type { RunUsage } from '@shared/ipc';

export interface RunLimits { maxRequests: number; maxConsecutiveFailures: number }
export class RunStopped extends Error {
  constructor(readonly reason: 'request-limit' | 'consecutive-failures') {
    super(reason === 'request-limit' ? '已达到本次请求上限，结果已保留；检查后可继续' : '连续请求或输出协议失败，已停止后续调用；检查接口或问题后可继续');
    this.name = 'RunStopped';
  }
}
/** A request is reserved synchronously after acquiring the client semaphore. */
export class RunGuard {
  readonly usage: RunUsage;
  stopped: RunStopped | null = null;
  private reserving = false;
  constructor(prior: RunUsage | undefined, readonly limits: RunLimits, private changed: (usage: RunUsage, phase: 'admission' | 'accounting') => void) {
    for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('请求和连续失败上限必须为正整数');
    this.usage = { requests: prior?.requests ?? 0, inputTokens: prior?.inputTokens ?? 0, outputTokens: prior?.outputTokens ?? 0, unknownUsageRequests: prior?.unknownUsageRequests ?? 0, runRequests: 0, consecutiveFailures: 0 };
  }
  check(): void { if (this.stopped) throw this.stopped; }
  reserve(): void {
    this.check();
    if (this.reserving) throw new Error('请求准入通知不允许重入');
    if (this.usage.runRequests >= this.limits.maxRequests) {
      this.stopped = new RunStopped('request-limit'); this.changed({ ...this.usage }, 'accounting'); throw this.stopped;
    }
    // Notify a candidate before committing unsent usage. A failing synchronous
    // publisher vetoes admission; it must transact its own durable side effects.
    // We cannot undo arbitrary external notifications or writes in this callback.
    const next = { ...this.usage, requests: this.usage.requests + 1, runRequests: this.usage.runRequests + 1, unknownUsageRequests: this.usage.unknownUsageRequests + 1 };
    this.reserving = true;
    try { this.changed({ ...next }, 'admission'); Object.assign(this.usage, next); }
    finally { this.reserving = false; }
  }
  response(input: number | null, output: number | null): void {
    const valid = (v: number | null): v is number => v !== null && Number.isSafeInteger(v) && v >= 0;
    if (valid(input)) this.usage.inputTokens += input;
    if (valid(output)) this.usage.outputTokens += output;
    if (valid(input) && valid(output)) this.usage.unknownUsageRequests--;
    this.changed({ ...this.usage }, 'accounting');
  }
  outcome(ok: boolean): void {
    if (!this.stopped) this.usage.consecutiveFailures = ok ? 0 : this.usage.consecutiveFailures + 1;
    if (!ok && this.usage.consecutiveFailures >= this.limits.maxConsecutiveFailures && !this.stopped) this.stopped = new RunStopped('consecutive-failures');
    this.changed({ ...this.usage }, 'accounting');
  }
}
