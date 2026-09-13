/** Keep complete source paragraphs; 900 characters is a batching target, never a cut. */
export function translationBatches<T extends { sourceText: string; seriesOrdinal: number; boundaryBefore?: boolean }>(paragraphs: T[], requestedSize = 1): T[][] {
  const maxCount = Number.isFinite(requestedSize) ? Math.max(1, Math.min(3, Math.floor(requestedSize))) : 1;
  const batches: T[][] = [];
  let current: T[] = [], chars = 0;
  for (const p of [...paragraphs].sort((a, b) => a.seriesOrdinal - b.seriesOrdinal)) {
    const previous = current.at(-1);
    if (previous && (current.length >= maxCount || chars + p.sourceText.length > 900 || p.seriesOrdinal !== previous.seriesOrdinal + 1 || p.boundaryBefore)) {
      batches.push(current); current = []; chars = 0;
    }
    current.push(p); chars += p.sourceText.length;
  }
  if (current.length) batches.push(current);
  return batches;
}
