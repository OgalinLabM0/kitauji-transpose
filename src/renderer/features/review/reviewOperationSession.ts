import type { ReviewOperationRequest, ReviewOperationResult } from '@shared/reviewOperations';

/** UI-owned lifetime: captures one request and rejects double clicks synchronously. */
export class ReviewOperationSession {
  private generation = 0;
  private running = false;
  private disposed = false;
  get busy(): boolean { return this.running; }
  /** Call on identity, book, classification or page change. Does not cancel somebody else's task. */
  invalidate(): void { this.generation++; }
  dispose(): void { this.disposed = true; this.invalidate(); }

  async run(
    request: ReviewOperationRequest,
    execute: (request: ReviewOperationRequest) => Promise<ReviewOperationResult>,
    callbacks: { result: (result: ReviewOperationResult) => void; error: (message: string) => void; settled: () => void },
  ): Promise<boolean> {
    if (this.running || this.disposed) return false;
    this.running = true;
    const generation = this.generation;
    const captured = structuredClone(request);
    const current = () => !this.disposed && generation === this.generation;
    try {
      const result = await execute(captured);
      if (current()) callbacks.result(result);
    } catch (error) {
      if (current()) callbacks.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
      if (current()) callbacks.settled();
    }
    return true;
  }
}
