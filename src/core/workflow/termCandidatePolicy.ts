import type { ProjectStore } from '@core/db';
import { createHash } from 'node:crypto';
import { nowIso } from '../db/database';
import { containsVisibleQuote } from '../validation/nameEvidence';
import { companyTermParts, isHanOnlyTerm, isOrdinaryRoleTerm, TERM_GRANULARITY_VERSION, type TermSplitReceipt } from '../validation/termGranularity';

/** Retire only unchosen machine candidates. Original rows, proposals, and people
 * remain available for audit; this is not a human translation decision. */
export function retireTermCandidate(store: ProjectStore, termId: string, reason: string, parts: string[]): boolean {
  const term = store.glossary.activeTerms(store.db.get<{series_id:string}>('SELECT series_id FROM terms WHERE id=?', [termId])?.series_id ?? '').find(t => t.id === termId);
  if (!term || term.lock_level !== 'suggested' || term.term_zh || term.senses.length) return false;
  const prior = store.db.get('SELECT * FROM terms WHERE id=?', [termId]);
  const receipt = { version: TERM_GRANULARITY_VERSION, at: nowIso(), reason, parts, prior };
  store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [`term-granularity:${termId}`, JSON.stringify(receipt)]);
  store.db.run('UPDATE terms SET valid_to_para=0,updated_at=? WHERE id=?', [nowIso(), termId]);
  for (const q of store.translations.listPendingByKind(term.series_id, 'term-proposal').filter(q => q.payload.termId === termId)) {
    store.db.run("UPDATE review_queue SET status='dismissed',resolution=?,resolved_at=?,payload=? WHERE id=?", [JSON.stringify({ kind: 'term-granularity', reason, parts }), nowIso(), JSON.stringify({ ...q.payload, termGranularity: receipt }), q.id]);
  }
  return true;
}

export function reconcileTermCandidates(store: ProjectStore, volumeId: string, splits: readonly TermSplitReceipt[] = []) {
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const paragraphs = store.projects.listParagraphIdsByVolume(volumeId).map(id => store.projects.getParagraph(id)!);
  const retired: string[] = [], created: string[] = [];
  store.transaction(() => {
    // Extraction can already return separate components: preserve the proven
    // parent rule even when no parent row ever existed in the glossary.
    for (const split of splits) {
      if (split.version !== TERM_GRANULARITY_VERSION) continue;
      const kind = (['person', 'organization'] as const).find(kind => {
        const parts = companyTermParts(split.parent, kind);
        return parts && parts.length > 1 && JSON.stringify(parts.map(p => p.term_jp)) === JSON.stringify(split.parts);
      });
      if (!kind || !paragraphs.some(p => containsVisibleQuote(p.sourceText, split.parent))) continue;
      const key = createHash('sha256').update(JSON.stringify([volumeId, split.parent, kind])).digest('hex');
      store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [
        `term-component-source:${key}`, JSON.stringify({ volumeId, parent: split.parent, kind })
      ]);
    }
    for (const term of store.glossary.activeTerms(seriesId)) {
      if (term.lock_level !== 'suggested' || term.term_zh || term.senses.length) continue;
      const evidence = paragraphs.filter(p => containsVisibleQuote(p.sourceText, term.term_jp));
      if (!evidence.length) continue;
      if (isHanOnlyTerm(term.term_jp) || isOrdinaryRoleTerm(term.term_jp)) {
        if (retireTermCandidate(store, term.id, '汉字词、普通角色称谓不进入术语确认；人物资料不变', [])) retired.push(term.term_jp);
        continue;
      }
      const fixed = companyTermParts(term.term_jp, term.term_type);
      const split = splits.find(s => s.version === TERM_GRANULARITY_VERSION && s.parent === term.term_jp);
      const pieces = fixed ?? split?.parts.map(word => ({ term_jp: word, term_type: 'concept' }));
      if (!pieces?.length || pieces.some(p => p.term_jp === term.term_jp || !evidence.some(e => containsVisibleQuote(e.sourceText, p.term_jp)))) continue;
      for (const piece of pieces) {
        if (isHanOnlyTerm(piece.term_jp) || store.glossary.findTermByJp(seriesId, piece.term_jp)) continue;
        store.glossary.upsertTerm({ seriesId, introducedVolume: term.introduced_volume, termJp: piece.term_jp, termZh: null, termType: piece.term_type, lockLevel: 'suggested', evidenceIds: evidence.filter(p => containsVisibleQuote(p.sourceText, piece.term_jp)).map(p => p.id).slice(0, 20), notes: `从「${term.term_jp}」拆出，译名尚未确认` });
        created.push(piece.term_jp);
      }
      if (retireTermCandidate(store, term.id, fixed ? '组织专名与通用组成词分别确认' : split!.reason, pieces.map(p => p.term_jp))) retired.push(term.term_jp);
    }
  });
  return { retired, created };
}
