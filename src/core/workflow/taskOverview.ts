import { groupTermForms } from './reviewTermForms';
import { termReviewMatcher } from './termConfirmation';
import type { ProjectStore } from '@core/db';
import type { ParagraphView } from '@shared/types';
import type { VolumeOverview } from '@shared/ipc';
import { auditStatus } from './auditReceipts';
import { runQualityGate } from './qualityGate';
import { volumeRunState } from './volumeFlow';
import { staleAutomaticSourceIssues } from './automaticKnowledgeSources';
import { appliedChangeIssues } from './appliedChangeSources';

export function scopedReview(store: ProjectStore, seriesId: string, status: 'pending'|'resolved'|'dismissed' = 'pending', volumeId?: string) {
  const items = store.translations.listQueue(seriesId, status);
  if (!volumeId) return status === 'pending' ? groupTermForms(store,items) : items;
  if (store.projects.getVolumeSeriesId(volumeId) !== seriesId) throw new Error('本册不属于当前系列');
  const ids = store.projects.listParagraphIdsByVolume(volumeId);
  const within = new Set(ids);
  const through = Math.max(-1, ...ids.map(id => store.projects.getParagraph(id)!.seriesOrdinal));
  const termInVolume = termReviewMatcher(store, volumeId);
  const scoped = items.filter(q => !q.paragraphId || within.has(q.paragraphId) || termInVolume(q) || (q.payload.subtype === 'character-field' && Number(q.payload.at) <= through));
  return status === 'pending' ? groupTermForms(store,scoped) : scoped;
}
export function withAuditStatus(store: ProjectStore, views: ParagraphView[]): ParagraphView[] {
  return views.map(p => { const final = store.translations.latestFinal(p.id); return { ...p, audit: final ? auditStatus(store, final) : 'missing' }; });
}
export function volumeOverview(store: ProjectStore, volumeId: string): VolumeOverview {
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const views = withAuditStatus(store, store.projects.listParagraphViewsByVolume(volumeId));
  const report = runQualityGate(store, volumeId);
  if (!views.length) { report.ok = false; report.blockers.push({ code: 'EMPTY_VOLUME', count: 1, sample: [] }); }
  return { volumeId, run: volumeRunState(store, volumeId), report, staleKnowledge: staleAutomaticSourceIssues(store, seriesId), staleChanges: appliedChangeIssues(store, seriesId),
    total: views.length, drafted: views.filter(p => p.final).length,
    adopted: views.filter(p => p.final && (p.final.confirmed || p.final.autoAccepted)).length,
    audited: views.filter(p => p.audit === 'valid').length,
    pending: scopedReview(store, seriesId, 'pending', volumeId).length };
}

/** Recheck only existing text that lacks current proof or still has unresolved checks. */
export function pendingFinalReviews(store: ProjectStore, volumeId: string): string[] {
  const ids = store.projects.listParagraphIdsByVolume(volumeId);
  const rechecks = new Set(store.translations.pendingRechecks(ids).map(r => r.paragraph_id));
  const issues = new Set(scopedReview(store, store.projects.getVolumeSeriesId(volumeId), 'pending', volumeId).filter(q => q.kind === 'review-block' || q.kind === 'failed').map(q => q.paragraphId));
  return ids.filter(id => {
    const final = store.translations.latestFinal(id);
    return !!final && (auditStatus(store, final) !== 'valid' || rechecks.has(id) || issues.has(id) || store.translations.openFindings(id).length > 0);
  });
}
