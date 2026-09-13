import { z } from 'zod';
import type { ProjectStore } from '@core/db';
import { REVIEW_KIND_LABELS, type ReviewKind, type ReviewItemView } from '@shared/types';
import { reviewItemVersion, reviewOperationApplicable, type ReviewOperationRequest } from '@shared/reviewOperations';
import { scopedReview } from './taskOverview';

const identifier = z.string().trim().min(1).max(300);
const requestSchema = z.object({
  scope: z.object({
    seriesId: identifier,
    volumeId: identifier.optional(),
    kind: z.enum(Object.keys(REVIEW_KIND_LABELS) as [ReviewKind, ...ReviewKind[]]).optional(),
    ids: z.array(identifier).min(1).max(10000).refine(ids => new Set(ids).size === ids.length, '选择中有重复问题'),
  }).strict(),
  operation: z.enum(['ai-review', 'generate-honorific', 'arbitrate', 'confirm-preselected', 'confirm-ai', 'dismiss', 'retry']),
  allowVariation: z.boolean().optional(),
  expectedVersions: z.record(identifier, z.string().max(1048576)).optional(),
}).strict();

/** Validate the complete request before any model call or mutation. Shared rows use list semantics. */
export function captureReviewOperation(store: ProjectStore, input: unknown): { request: ReviewOperationRequest; items: ReviewItemView[] } {
  const request = requestSchema.parse(input) as ReviewOperationRequest;
  const { scope, operation } = request;
  if (!store.projects.getSeries(scope.seriesId)) throw new Error('作品不存在');
  const visible = new Map(scopedReview(store, scope.seriesId, 'pending', scope.volumeId)
    .filter(item => !scope.kind || item.kind === scope.kind).map(item => [item.id, item]));
  const items = scope.ids.map(id => {
    const item = visible.get(id);
    if (!item) throw new Error('选择包含不存在、已处理或不属于当前册／分类的问题：' + id);
    if (item.paragraphId && store.projects.getSeriesIdOfParagraph(item.paragraphId) !== scope.seriesId) throw new Error('问题引用的段落不属于当前作品');
    if (!reviewOperationApplicable(item, operation)) throw new Error('此类别不支持所选操作：' + item.title);
    if ((request.expectedVersions || operation === 'confirm-preselected' || operation === 'confirm-ai')
      && request.expectedVersions?.[id] !== reviewItemVersion(item)) throw new Error('预览中的答案已变化或尚未预览，未采用任何译法。请刷新列表并重新查看适用项');
    return structuredClone(item);
  });
  return { request, items };
}

/** A late response cannot be applied to a replaced payload or newly resolved row. */
export function assertReviewOperationItemCurrent(store: ProjectStore, scope: ReviewOperationRequest['scope'], snapshot: ReviewItemView): ReviewItemView {
  const current = scopedReview(store, scope.seriesId, 'pending', scope.volumeId).find(item => item.id === snapshot.id);
  if (!current || current.kind !== snapshot.kind || current.paragraphId !== snapshot.paragraphId
    || JSON.stringify(current.payload) !== JSON.stringify(snapshot.payload)) throw new Error('问题或人工选择已变化，本次结果未覆盖，请刷新后重试');
  return current;
}
