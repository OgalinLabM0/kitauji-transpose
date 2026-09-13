import type { DecisionPayload } from './ipc';
import type { ReviewItemView, ReviewKind } from './types';

/** Explicit frozen IDs are mandatory: an omitted volume never means “current volume”. */
export interface ReviewOperationScope {
  seriesId: string;
  volumeId?: string;
  kind?: ReviewKind;
  ids: string[];
}
export type ReviewOperation = 'ai-review' | 'generate-honorific' | 'arbitrate' | 'confirm-preselected' | 'confirm-ai' | 'dismiss' | 'retry';
export interface ReviewOperationRequest {
  scope: ReviewOperationScope;
  operation: ReviewOperation;
  allowVariation?: boolean;
  /** Exact queue contents shown in the preview, keyed by the explicitly selected IDs. */
  expectedVersions?: Record<string, string>;
}
export function reviewItemVersion(item: ReviewItemView): string {
  return JSON.stringify([item.id, item.kind, item.paragraphId, item.status, item.payload]);
}
export function reviewPreviewValue(item: ReviewItemView, operation: ReviewOperation): string | null {
  if (operation !== 'confirm-preselected' && operation !== 'confirm-ai') return null;
  const decision = reviewConfirmation(item, false, operation === 'confirm-ai');
  if (!decision) return null;
  if ('zh' in decision && typeof decision.zh === 'string') return decision.zh;
  const value = item.payload.inferred ?? item.payload.usedZh;
  return typeof value === 'string' ? value : null;
}
export interface ReviewOperationItemResult {
  id: string;
  title: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  message: string;
}
export interface ReviewOperationResult {
  operation: ReviewOperation;
  items: ReviewOperationItemResult[];
  cancelled: boolean;
}
export const REVIEW_OPERATION_LABELS: Record<ReviewOperation, string> = {
  'ai-review': 'AI 辅助审核（仅推荐）',
  'generate-honorific': '生成称谓候选',
  arbitrate: '自动仲裁',
  'confirm-preselected': '正式确认预选',
  'confirm-ai': '正式确认 AI 推荐',
  dismiss: '忽略选中',
  retry: '重试选中失败项',
};

export const AI_REVIEW_KINDS: readonly ReviewKind[] = ['term-proposal', 'ambiguity', 'honorific-first', 'review-block', 'quirk-candidate'];
export const PRESELECT_KINDS: readonly ReviewKind[] = ['term-proposal', 'ambiguity', 'honorific-first'];
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function reviewCandidates(item: ReviewItemView): { zh: string; basis?: string; cons?: string }[] {
  const raw = item.payload.candidates;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((candidate: unknown) => {
    if (item.kind === 'ambiguity' && nonempty(candidate)) return [{ zh: candidate }];
    if (!candidate || typeof candidate !== 'object' || !('zh' in candidate) || !nonempty(candidate.zh)) return [];
    const c = candidate as Record<string, unknown>;
    return [{ zh: candidate.zh, ...(nonempty(c.basis) ? { basis: c.basis } : {}), ...(nonempty(c.cons) ? { cons: c.cons } : {}) }];
  });
}

/** No confidence score can turn a quality blocker into a legal confirmation decision. */
export function reviewConfirmation(item: ReviewItemView, allowVariation = false, allowInferred = false): DecisionPayload | null {
  if (item.status !== 'pending' || !PRESELECT_KINDS.includes(item.kind)) return null;
  const pl = item.payload;
  const chosen = nonempty(pl.preSelected) ? pl.preSelected : null;
  if (item.kind === 'ambiguity') {
    const inferred = nonempty(pl.inferred) ? pl.inferred : nonempty(pl.usedZh) ? pl.usedZh : null;
    if (chosen) return chosen === inferred
      ? { kind: 'ambiguity', action: 'confirm' }
      : { kind: 'ambiguity', action: 'set', zh: chosen, addAsSense: !!pl.termId };
    return allowInferred && inferred ? { kind: 'ambiguity', action: 'confirm' } : null;
  }
  if (!chosen) return null;
  return item.kind === 'term-proposal'
    ? { kind: 'term-proposal', action: 'choose', zh: chosen, acceptVariants: true }
    : { kind: 'honorific-first', action: 'choose', zh: chosen, allowVariation };
}

export function proposedReviewSelection(item: ReviewItemView): { zh: string; basis: string } | null {
  if (item.kind === 'honorific-first' && item.payload.needsContextConfirmation === true) return null;
  if (!PRESELECT_KINDS.includes(item.kind) || nonempty(item.payload.preSelected)) return null;
  if (item.kind === 'ambiguity') {
    const value = nonempty(item.payload.inferred) ? item.payload.inferred : item.payload.usedZh;
    return nonempty(value) ? { zh: value, basis: item.payload.inferred ? '推断' : '初译用法' } : null;
  }
  const candidates = reviewCandidates(item);
  if (!candidates.length) return null;
  const chosen = item.kind === 'term-proposal'
    ? candidates.find(c => !c.cons) ?? candidates[0]!
    : candidates.find(c => c.zh === item.payload.recommended) ?? candidates[0]!;
  return { zh: chosen.zh, basis: chosen.zh === item.payload.recommended ? 'AI 推荐' : '候选预选' };
}

/** Stored recommendations live in payload; older preview fixtures expose a top-level view. */
export function reviewRecommendation(item: ReviewItemView): ReviewItemView['aiRecommendation'] {
  const failure = item.payload.scopedOperationFailure;
  if (failure && typeof failure === 'object' && 'operation' in failure && failure.operation === 'ai-review') return undefined;
  const raw = item.payload.aiRecommendation ?? item.aiRecommendation;
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (!['accept', 'reject', 'uncertain'].includes(String(value.action)) || typeof value.confidence !== 'number'
    || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 || typeof value.reason !== 'string') return undefined;
  return raw as NonNullable<ReviewItemView['aiRecommendation']>;
}

/** One applicability rule shared by visible counts, frozen requests and the backend. */
export function reviewOperationApplicable(item: ReviewItemView, operation: ReviewOperation): boolean {
  if (item.status !== 'pending') return false;
  switch (operation) {
    case 'ai-review': return AI_REVIEW_KINDS.includes(item.kind);
    case 'generate-honorific': return item.kind === 'honorific-first' && reviewCandidates(item).length === 0;
    case 'arbitrate': return PRESELECT_KINDS.includes(item.kind) || (item.kind === 'review-block' && item.payload.type !== 'TRAJECTORY' && !!item.paragraphId);
    case 'confirm-preselected': return reviewConfirmation(item) !== null;
    case 'confirm-ai': {
      const recommendation = reviewRecommendation(item);
      return recommendation?.action === 'accept' && recommendation.confidence >= 0.7 && reviewConfirmation(item, false, true) !== null;
    }
    case 'dismiss': return item.kind === 'warning' || item.kind === 'failed';
    case 'retry': return item.kind === 'failed';
  }
}

export function reviewOperationItems(items: readonly ReviewItemView[], kind: ReviewKind | null, operation: ReviewOperation): ReviewItemView[] {
  return items.filter(item => (!kind || item.kind === kind) && reviewOperationApplicable(item, operation));
}
