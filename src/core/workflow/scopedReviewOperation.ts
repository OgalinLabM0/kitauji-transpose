import type { ProjectStore } from '@core/db';
import type { AiClient, ProviderConfig } from '@core/ai';
import type { ReviewItemView } from '@shared/types';
import {
  proposedReviewSelection, reviewCandidates, reviewConfirmation,
  type ReviewOperationRequest, type ReviewOperationResult, type ReviewOperationItemResult,
} from '@shared/reviewOperations';
import { captureReviewOperation, assertReviewOperationItemCurrent } from './reviewOperationScope';
import { reviewItem, type ReviewRecommendation } from './reviewAuditor';
import { PrepRunner } from './prepRunner';
import { AutoArbiter } from './autoArbiter';
import { DecisionService, type Decision } from './decisions';
import { RepairQueue } from './repairQueue';

export interface ScopedReviewDependencies {
  ai: AiClient;
  config: ProviderConfig;
  signal?: AbortSignal;
  /** Useful for isolated transport tests; production uses reviewAuditor.reviewItem. */
  recommend?: (item: ReviewItemView, config: ProviderConfig, signal?: AbortSignal) => Promise<ReviewRecommendation>;
  onProgress?: (done: number, total: number, result: ReviewOperationItemResult) => void;
}
const running = new WeakSet<ProjectStore>();
export function isScopedReviewRunning(store: ProjectStore): boolean { return running.has(store); }

/** Check after every asynchronous AI result, before existing candidate writers resume. */
function guardedAi(ai: AiClient, checkpoint: () => void): AiClient {
  return new Proxy(ai, {
    get(target, property) {
      if (property === 'structured') return async (...args: Parameters<AiClient['structured']>) => {
        checkpoint();
        const result = await target.structured(...args);
        checkpoint();
        return result;
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * This is deliberately a queue operation, not volumeFlow: its existing independent
 * automatic term/address/field/quirk adoption remains unchanged.
 * Call within AppService.withTask, passing its AbortController. Successful retry
 * results mean queued, never translated/verified. The host schedules RepairQueue
 * only AFTER the whole request settles.
 */
export async function runScopedReviewOperation(store: ProjectStore, input: unknown, dependencies: ScopedReviewDependencies): Promise<ReviewOperationResult> {
  if (running.has(store)) throw new Error('已有分类审核操作在运行');
  const { request, items } = captureReviewOperation(store, input);
  const { signal } = dependencies;
  const result: ReviewOperationResult = { operation: request.operation, items: [], cancelled: false };
  running.add(store);
  const repaired = new Map<string, ReviewOperationItemResult>();
  try {
    for (const snapshot of items) {
      if (signal?.aborted) {
        result.cancelled = true;
        result.items.push({ id: snapshot.id, title: snapshot.title, status: 'cancelled', message: '已取消，未继续处理' });
        continue;
      }
      const originalParagraph = snapshot.paragraphId ? store.projects.getParagraph(snapshot.paragraphId) : undefined;
      const checkpoint = () => {
        signal?.throwIfAborted();
        if (snapshot.paragraphId && store.projects.getParagraph(snapshot.paragraphId)?.sourceText !== originalParagraph?.sourceText) throw new Error('原文已变化，本次结果未覆盖');
        assertReviewOperationItemCurrent(store, request.scope, snapshot);
        if (request.operation === 'arbitrate' && snapshot.kind === 'review-block') {
          const chosen = new Set(items.map(item => item.id));
          if (store.translations.listQueue(request.scope.seriesId, 'pending').some(item => item.paragraphId === snapshot.paragraphId && !chosen.has(item.id))) throw new Error('同段出现选择以外的新问题，已停止修复并保留待办');
        }
      };
      let outcome: ReviewOperationItemResult;
      try {
        const previousRepair = snapshot.paragraphId ? repaired.get(snapshot.paragraphId) : undefined;
        if (request.operation === 'arbitrate' && snapshot.kind === 'review-block' && previousRepair) {
          outcome = { ...previousRepair, id: snapshot.id, title: snapshot.title };
        } else {
          checkpoint();
          const message = await executeItem(store, request, snapshot, dependencies, checkpoint, items);
          outcome = { id: snapshot.id, title: snapshot.title, status: 'succeeded', message };
        }
      } catch (error) {
        const cancelled = !!signal?.aborted;
        result.cancelled ||= cancelled;
        const message = cancelled ? '已取消；已提交的候选或决定保留，未完成项仍待处理' : error instanceof Error ? error.message : String(error);
        outcome = { id: snapshot.id, title: snapshot.title, status: cancelled ? 'cancelled' : 'failed', message };
        // Failure metadata must never overwrite a newer manual choice.
        if (!cancelled) {
          try {
            const current = assertReviewOperationItemCurrent(store, request.scope, snapshot);
            store.translations.updateQueuePayload(snapshot.id, { ...current.payload, scopedOperationFailure: { operation: request.operation, message, at: new Date().toISOString() } });
          } catch { /* Changed or resolved rows retain their newer state. */ }
        }
      }
      result.items.push(outcome);
      if (request.operation === 'arbitrate' && snapshot.kind === 'review-block' && snapshot.paragraphId) repaired.set(snapshot.paragraphId, outcome);
      try { dependencies.onProgress?.(result.items.length, items.length, outcome); }
      catch { /* A progress notification cannot turn a committed decision into failure. */ }
    }
    return result;
  } finally { running.delete(store); }
}

async function executeItem(
  store: ProjectStore, request: ReviewOperationRequest, snapshot: ReviewItemView,
  dependencies: ScopedReviewDependencies, checkpoint: () => void, selected: readonly ReviewItemView[],
): Promise<string> {
  const { operation, scope } = request;
  const clearFailure = (payload: Record<string, unknown>): Record<string, unknown> => {
    const { scopedOperationFailure: _failure, ...clean } = payload;
    return clean;
  };
  switch (operation) {
    case 'ai-review': {
      const recommendation = await (dependencies.recommend ?? reviewItem)(snapshot, dependencies.config, dependencies.signal);
      checkpoint();
      if (!['accept', 'reject', 'uncertain'].includes(recommendation.action) || !Number.isFinite(recommendation.confidence)
        || recommendation.confidence < 0 || recommendation.confidence > 1 || typeof recommendation.reason !== 'string' || !recommendation.reason.trim()) throw new Error('AI 推荐格式无效，问题保留');
      // The existing auditor reports transport/parse failure as uncertain. Preserve
      // the reason but report failure instead of counting it as a completed review.
      if (/^(AI审核失败|AI返回格式错误)/.test(recommendation.reason)) throw new Error(recommendation.reason);
      store.translations.updateQueuePayload(snapshot.id, { ...clearFailure(snapshot.payload), aiRecommendation: recommendation });
      return '已生成推荐；尚未正式采纳，不关闭问题';
    }
    case 'generate-honorific': {
      const ai = guardedAi(dependencies.ai, checkpoint);
      const runner = new PrepRunner(store, ai, dependencies.signal ? { signal: dependencies.signal } : {});
      const ok = await runner.resolveHonorific(snapshot.id);
      dependencies.signal?.throwIfAborted();
      const current = store.translations.listQueue(scope.seriesId, 'pending').find(item => item.id === snapshot.id);
      if (!ok || !current || reviewCandidates(current).length === 0) throw new Error('称谓候选未生成：请核对段落、人物与中文名；模型失败详情见活动日志');
      store.translations.updateQueuePayload(snapshot.id, clearFailure(current.payload));
      return '已生成称谓候选；推荐与候选均未正式采纳';
    }
    case 'arbitrate': {
      if (snapshot.kind !== 'review-block') {
        if (typeof snapshot.payload.preSelected === 'string' && snapshot.payload.preSelected.trim()) return '已有预选，保留人工或既有选择，未正式采纳';
        const selection = proposedReviewSelection(snapshot);
        if (!selection) throw new Error(snapshot.kind === 'honorific-first' ? '缺少合法称谓候选，请先生成候选' : '缺少合法候选或推断值，无法预选');
        store.translations.updateQueuePayload(snapshot.id, { ...clearFailure(snapshot.payload), preSelected: selection.zh, preSelectedBasis: selection.basis });
        return '已写入预选；尚未正式采纳';
      }
      const paragraphId = snapshot.paragraphId!;
      const chosenIds = new Set(selected.map(item => item.id));
      // Existing repair/reverification is paragraph-atomic. Never call it while
      // another hidden issue on that paragraph could be closed as a side effect.
      const hidden = store.translations.listQueue(scope.seriesId, 'pending').filter(item => item.paragraphId === paragraphId && !chosenIds.has(item.id));
      if (hidden.length) throw new Error('同段还有当前选择以外的问题；段落修复会共同核验，请在全部分类中完整选择该段问题后重试');
      const repaired = await new AutoArbiter(store).arbitrateAsync(scope.seriesId, guardedAi(dependencies.ai, checkpoint), dependencies.signal, [paragraphId]);
      dependencies.signal?.throwIfAborted();
      if (!repaired.finalized || store.translations.getQueueItem(snapshot.id)?.status === 'pending') throw new Error(repaired.details.join('；') || '完整复核未通过，原稿和待办保留');
      return '该段经过既有完整复核并定稿；未按推荐置信度放行';
    }
    case 'confirm-preselected':
    case 'confirm-ai':
    case 'dismiss':
    case 'retry': {
      const decision = operation === 'dismiss' ? { kind: snapshot.kind, action: 'dismiss' } as Decision
        : operation === 'retry' ? { kind: 'failed', action: 'retry' } as Decision
        : reviewConfirmation(snapshot, request.allowVariation ?? false, operation === 'confirm-ai');
      if (!decision) throw new Error('缺少合法确认值，未采纳');
      const outcome = store.transaction(() => {
        checkpoint();
        const applied = new DecisionService(store).apply(snapshot.id, decision as Decision);
        if (applied.ok) for (const paragraphId of applied.retranslate) {
          if (store.projects.getSeriesIdOfParagraph(paragraphId) !== scope.seriesId) throw new Error('决定要求重译其他作品，已回滚');
          if (scope.volumeId && !store.projects.listParagraphIdsByVolume(scope.volumeId).includes(paragraphId)) throw new Error('决定要求重译当前册以外的段落，已回滚');
          const chosen = new Set(selected.map(item => item.id));
          if (store.translations.listQueue(scope.seriesId, 'pending').some(item => item.paragraphId === paragraphId && !chosen.has(item.id))) throw new Error('本决定会重译含有未选择问题的段落，已保留原决定；请先逐项处理同段其他问题');
          new RepairQueue(store).enqueue(snapshot.id, paragraphId);
        }
        return applied;
      });
      if (!outcome.ok) throw new Error(outcome.message);
      return operation === 'retry' ? '已排入重试队列；原失败项保留，实际重译通过后才关闭'
        : outcome.message + (outcome.retranslate.length ? '；本段待重译已入队，尚未自动启动，请回工作台继续本册' : '')
          + (outcome.recheckCount ? `；${outcome.recheckCount} 段依赖此共享知识，已标记待回查（不等于已重译）` : '');
    }
  }
}
