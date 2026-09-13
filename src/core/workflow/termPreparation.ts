import type { ProjectStore } from '@core/db';
import { containsVisibleQuote } from '../validation/nameEvidence';

/** Extraction completion does not imply proposal completion. Pending human choices are not regenerated. */
export function missingTermProposals(store: ProjectStore, volumeId: string) {
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const paragraphs = store.projects.listParagraphIdsByVolume(volumeId).map(id => store.projects.getParagraph(id)!).filter(Boolean);
  return store.glossary.activeTerms(seriesId).filter(t => !t.term_zh && t.lock_level === 'suggested' && paragraphs.some(p => containsVisibleQuote(p.sourceText, t.term_jp))
    && !store.translations.hasPending(seriesId, 'term-proposal', `term:${t.id}`));
}
