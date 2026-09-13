import type { ProjectStore } from '@core/db';
import type { RubyHistoryOverlay } from './rubyHistoryOverlay';

/** One sentinel detects an unfinished search; never reinterpret overflow as absence. */
export const PRIOR_RUBY_CANDIDATE_LIMIT = 128;

/** A prefilter only, not a certificate. Each returned row must still pass source,
 * current speaker/stage, literal form, range and alignment checks in rubyPlan.
 * The latest-final lookup uses idx_finals_para; ordering uses paragraph ordinals.
 * JSON decoding (rather than LIKE) also finds escaped kind names. No JS history
 * array or persistent cache is built for unannotated/other-speaker/old finals.
 */
export function priorRubyCandidates(store: ProjectStore, seriesId: string, speakerId: string, before: number, overlay?: RubyHistoryOverlay, excludedParagraphIds: readonly string[] = []) {
  overlay?.assertCurrent(store);
  const excluded = [...new Set([...(overlay?.paragraphIds ?? []), ...excludedParagraphIds])];
  // Exclude replacements BEFORE the SQL limit, including replacements with no
  // annotations. Otherwise deletions could hide a valid 129th/130th persisted row.
  const rows = store.db.all<{ id: string; final_id: string }>(`
    SELECT p.id, f.id AS final_id FROM paragraphs p
    JOIN paragraph_analysis a ON a.paragraph_id=p.id
    JOIN scenes s ON s.id=p.scene_id
    JOIN chapters c ON c.id=s.chapter_id
    JOIN volumes v ON v.id=c.volume_id
    JOIN translation_finals f ON f.id=(
      SELECT latest.id FROM translation_finals latest WHERE latest.paragraph_id=p.id ORDER BY latest.version DESC LIMIT 1
    )
    WHERE v.series_id=? AND a.speaker_char_id=? AND p.series_ordinal<?
      ${excluded.length ? `AND p.id NOT IN (${excluded.map(() => '?').join(',')})` : ''}
      AND f.ruby_annotations IS NOT NULL AND f.ruby_annotations<>'[]'
      AND EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(f.ruby_annotations)
          THEN CASE WHEN json_type(f.ruby_annotations)='array' THEN f.ruby_annotations ELSE '[]' END
          ELSE '[]' END) mark
        WHERE json_extract(CASE WHEN mark.type='object' THEN mark.value ELSE '{}' END,'$.kind')='first-person'
      )
    ORDER BY p.series_ordinal DESC, p.id DESC LIMIT ?`, [seriesId, speakerId, before, ...excluded, PRIOR_RUBY_CANDIDATE_LIMIT + 1]);
  if (!overlay?.entries.length) return rows;
  const merged = rows.map(row => ({ ...row, ordinal: store.projects.getParagraph(row.id)!.seriesOrdinal }));
  for (const row of overlay.entries) {
    const p = store.projects.getParagraph(row.final.paragraph_id)!;
    if (p.seriesOrdinal >= before || store.projects.getSeriesIdOfParagraph(p.id) !== seriesId
      || store.projects.currentAnalysis(p.id)?.speaker_char_id !== speakerId) continue;
    const marks: unknown = JSON.parse(row.final.ruby_annotations ?? '[]');
    if (Array.isArray(marks) && marks.some(m => m && typeof m === 'object' && m.kind === 'first-person')) {
      merged.push({ id: p.id, final_id: row.final.id, ordinal: p.seriesOrdinal });
    }
  }
  // SQLite's BINARY tie break is UTF-8 byte order, not localeCompare/UTF-16 order.
  merged.sort((a, b) => b.ordinal - a.ordinal || Buffer.compare(Buffer.from(b.id), Buffer.from(a.id)));
  return merged.slice(0, PRIOR_RUBY_CANDIDATE_LIMIT + 1).map(({ id, final_id }) => ({ id, final_id }));
}
