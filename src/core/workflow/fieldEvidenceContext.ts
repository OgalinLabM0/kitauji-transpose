import type { ProjectStore } from '@core/db';
import { characterSourceCurrent } from '../db/characterSources';
import type { FieldConflict } from './characterConflicts';

/** Original-text background only: proximity and batch membership do not prove a speaker. */
export function fieldEvidenceContext(store: ProjectStore, c: FieldConflict, seriesId: string, maxRows: 6 | 8 = 6): FieldConflict['sources'] {
  const proofs = [c.previousSourceProof, c.sourceProof];
  if (proofs.some(proof => !characterSourceCurrent(store.db, proof))) throw new Error('人物字段背景依据已变化或缺失，请重新预读');
  const allowed = new Set(proofs.flatMap(proof => (JSON.parse(proof!) as { ids: string[] }).ids));
  const evidence = new Set([...c.previousEvidenceIds, ...c.evidenceIds]);
  const read = (id: string) => {
    const p = store.projects.getParagraph(id);
    if (!p || store.projects.getSeriesIdOfParagraph(id) !== seriesId) throw new Error('人物字段背景不属于当前作品');
    return p;
  };
  // Check the whole certified scope, including rows later excluded by the limits.
  const rows = [...allowed].map(read);
  const anchors = [...evidence].map(read);
  if (anchors.some(p => !allowed.has(p.id))) throw new Error('人物字段证据未包含在已验证背景中');
  const result: FieldConflict['sources'] = [];
  const seen = new Set(evidence);
  let size = 0;
  // Round-robin by distance keeps both sides represented before adding outer context.
  for (const offset of [-1, 1, -2, 2]) for (const anchor of anchors) {
    const p = rows.find(p => p.chapterId === anchor.chapterId && p.seriesOrdinal === anchor.seriesOrdinal + offset);
    // The next sentence may explicitly identify the preceding speaker. This
    // bounded raw-text window is not a later character fact or a stage change.
    if (!p || seen.has(p.id) || p.seriesOrdinal > c.at + 2) continue;
    seen.add(p.id);
    if (result.length >= maxRows || size + p.sourceText.length > 3000) continue;
    result.push({ id: p.id, text: p.sourceText, at: p.seriesOrdinal });
    size += p.sourceText.length;
  }
  return result.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}
