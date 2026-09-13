import type { ProjectStore } from '@core/db';

/** A warning that prevents automatic adoption must have a visible, recoverable task. */
export function exposeUnacceptedWarnings(store: ProjectStore, paragraphId: string): boolean {
  const final = store.translations.latestFinal(paragraphId);
  if (!final || final.confirmed_by_user || final.auto_accepted) return false;
  const findings = store.translations.openFindings(paragraphId).filter(f => f.severity === 'warning' && f.workstation_id !== 'trajectory-reviewer');
  if (!findings.length) return false;
  const seriesId = store.projects.getSeriesIdOfParagraph(paragraphId);
  if (!store.translations.listQueue(seriesId).some(q => q.paragraphId === paragraphId && q.kind === 'review-block')) {
    store.translations.enqueue({ seriesId, paragraphId, kind: 'review-block', title: '译文还有疑点，需要继续核对',
      payload: { type: 'UNACCEPTED_REVIEW_WARNING', source: store.projects.getParagraph(paragraphId)!.sourceText,
        translation: final.final_text, finalId: final.id, findingIds: findings.map(f => f.id),
        description: findings.map(f => f.description).join('\n') } });
  }
  return true;
}
