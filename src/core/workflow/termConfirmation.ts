import type { ProjectStore } from '@core/db';

/** Read-only identification; never reinterpret a later human confirmation as automatic. */
export function legacyTermsAwaitingUser(store: ProjectStore, seriesId: string) {
  const terms = new Map(store.glossary.activeTerms(seriesId).map(t => [t.id, t]));
  return store.translations.listQueue(seriesId, 'resolved').filter(q => {
    if (q.kind !== 'term-proposal') return false;
    const row = store.db.get<{resolution:string|null}>('SELECT resolution FROM review_queue WHERE id=?',[q.id])!;
    try { if (JSON.parse(row.resolution ?? '{}').action !== 'automatic-evidenced-term') return false; } catch { return false; }
    const old = q.payload.automaticTermDecision as { zh?: string } | undefined;
    const term = terms.get(String(q.payload.termId));
    return !!old?.zh && !!term && term.term_zh === old.zh && term.lock_level !== 'hard-locked'
      && !term.senses.some(s => s.is_default && s.confirmed_by_user);
  });
}
export function termReviewMatcher(store: ProjectStore, volumeId: string) {
  const ids = new Set(store.projects.listParagraphIdsByVolume(volumeId));
  const text = [...ids].map(id => store.projects.getParagraph(id)!.sourceText).join('\n');
  const terms = new Map(store.glossary.activeTerms(store.projects.getVolumeSeriesId(volumeId)).map(t => [t.id, t.term_jp]));
  return (item: { kind: string; paragraphId: string | null; payload: Record<string, unknown> }): boolean => {
    if (item.kind !== 'term-proposal') return false;
    if (item.paragraphId && ids.has(item.paragraphId)) return true;
    const term = terms.get(String(item.payload.termId));
    return !!term && text.includes(term);
  };
}
