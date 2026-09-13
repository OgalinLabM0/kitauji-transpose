import { create } from 'zustand';
import { draftIdentity } from './draftIdentityBridge';

export interface ReviewDraftTarget {
  queueId: string; seriesId: string; volumeId: string | null;
  status: 'pending' | 'resolved' | 'dismissed'; token: string; sequence: number;
}
/** Ephemeral navigation only: never persist an old library's object IDs across its identity boundary. */
export const useReviewDraftNavigation = create<{ target: ReviewDraftTarget | null; sequence: number }>(() => ({ target: null, sequence: 0 }));
export function publishReviewDraftTarget(target: Omit<ReviewDraftTarget, 'sequence'>): void {
  if (!draftIdentity.isCurrent(target.token)) return;
  useReviewDraftNavigation.setState(state => ({ sequence: state.sequence + 1, target: { ...target, sequence: state.sequence + 1 } }));
}
export function consumeReviewDraftTarget(sequence: number): void {
  useReviewDraftNavigation.setState(state => state.target?.sequence === sequence ? { target: null } : {});
}
