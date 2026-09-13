import type { RubyHistoryOverlay } from './rubyHistoryOverlay';
import { createHash } from 'node:crypto';
import type { ProjectStore, RubyAnnotation, FinalRow } from '@core/db';
import type { TranslationItem } from '@core/ai/protocol';
import type { ValidationFinding } from '@shared/types';
import { stripMarkers } from '@core/epub/blocks';
import { planFirstPersonRuby } from './firstPersonRuby';
import { relocateRubyAnnotations } from './rubyAnnotations';
import { priorRubyCandidates, PRIOR_RUBY_CANDIDATE_LIMIT } from './priorRubyCandidates';

export const RUBY_CONTRACT = 'first-person-literal-ja-bounded-history-v2';
const hash = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const block = (message: string): ValidationFinding => ({ code: 'REVIEW:RUBY_UNRESOLVED', severity: 'blocks_export', message });
const sameMark = (a: RubyAnnotation, b: RubyAnnotation) => a.start === b.start && a.end === b.end && a.rt === b.rt && a.kind === b.kind;
function validateMarkRanges(text: string, marks: readonly RubyAnnotation[]): ValidationFinding[] {
  const plain = stripMarkers(text), ordered = [...marks].sort((a, b) => a.start - b.start);
  const invalid = ordered.some((mark, index) => !Number.isSafeInteger(mark.start) || !Number.isSafeInteger(mark.end)
    || mark.start < 0 || mark.end <= mark.start || mark.end > plain.length || !mark.rt.trim()
    || (index > 0 && ordered[index - 1]!.end > mark.start));
  return invalid ? [block('读音标注偏移无效或互相重叠')] : [];
}

interface PriorRuby { form: string | null; evidence: unknown[]; exhausted: boolean }

/** Read only plausible marks in earlier latest finals, then verify every dependency.
 * This runs afresh for each synchronous plan: raw SQL writes cannot evade a cache.
 */
function previousRubyForm(store: ProjectStore, seriesId: string, speakerId: string, ordinal: number, overlay?: RubyHistoryOverlay): PriorRuby {
  const rows = priorRubyCandidates(store, seriesId, speakerId, ordinal, overlay);
  const evidence: unknown[] = [];
  for (const row of rows.slice(0, PRIOR_RUBY_CANDIDATE_LIMIT)) {
    const p = store.projects.getParagraph(row.id)!;
    const analysis = store.projects.currentAnalysis(row.id);
    const final = overlay?.finalFor(row.id) ?? store.translations.latestFinal(row.id);
    // Keep rejected candidates in the receipt too: changes to their source,
    // speaker validity, stage or coverage can change which earlier form wins.
    evidence.push([p, analysis ?? null, final ?? null]);
    if (analysis?.speaker_char_id !== speakerId || !final || final.id !== row.final_id) continue;
    const speaker = store.knowledge.getCharacterAt(speakerId, p.seriesOrdinal);
    evidence.push(speaker ?? null);
    if (!speaker || speaker.series_id !== seriesId) continue;
    const decoded: unknown = store.translations.rubyOf(final);
    if (!Array.isArray(decoded)) continue;
    const marks = decoded.filter((m): m is RubyAnnotation => !!m && typeof m === 'object' && m.kind === 'first-person');
    if (!marks.length || marks.some(m => typeof m.rt !== 'string')) continue;
    // Paragraph-level identity cannot attribute several quoted voices to the same speaker.
    if ((p.sourceText.match(/[「『]/gu) ?? []).length > 1) continue;
    const candidate = final.source_candidate_id ? (overlay?.candidateFor(final.source_candidate_id) ?? store.translations.candidateById(final.source_candidate_id)) : undefined;
    let coverage: TranslationItem['source_coverage'] = [];
    try {
      if (candidate?.paragraph_id === p.id && candidate.candidate_text === final.final_text) {
        const parsed: unknown = JSON.parse(candidate.source_coverage ?? '[]');
        if (!Array.isArray(parsed) || parsed.some(c => !c || typeof c.segment !== 'string' || typeof c.rendered_as !== 'string' || !['covered', 'uncertain', 'restructured'].includes(c.status))) continue;
        coverage = parsed;
      }
    } catch { continue; /* Corrupt alignment is not proof of a prior annotation. */ }
    evidence.push([candidate ?? null, coverage]);
    const expected = planFirstPersonRuby({ source: p.sourceText, translation: final.final_text, enabled: true,
      isDialogue: p.paragraphType !== 'narration', speakerKnown: true, speakerType: speaker.first_person_type ?? null, alreadyAnnotated: false, coverage });
    if (expected.unresolved.length || validateMarkRanges(final.final_text, marks).length || marks.some(m => !expected.ruby.some(r => sameMark(m, r)))) continue;
    const valid = expected.ruby.filter(r => marks.some(m => sameMark(m, r))).at(-1);
    if (valid) return { form: valid.rt, evidence, exhausted: false };
  }
  return { form: null, evidence, exhausted: rows.length > PRIOR_RUBY_CANDIDATE_LIMIT };
}

/** Purely local plan: no model calls, no metadata writes, no modification of Chinese prose. */
export function candidateRubyPlan(store: ProjectStore, paragraphId: string, item: TranslationItem, overlay?: RubyHistoryOverlay) {
  overlay?.assertCurrent(store);
  const paragraph = store.projects.getParagraph(paragraphId);
  if (!paragraph || item.id !== paragraphId) throw new Error('标注对应段落不存在');
  const seriesId = store.projects.getSeriesIdOfParagraph(paragraphId);
  const settings = store.projects.getSettings(seriesId);
  const analysis = store.projects.currentAnalysis(paragraphId);
  const observedSpeaker = analysis?.speaker_char_id ? store.knowledge.getCharacterAt(analysis.speaker_char_id, paragraph.seriesOrdinal) : undefined;
  const speaker = observedSpeaker?.series_id === seriesId ? observedSpeaker : undefined;
  const input = { source: paragraph.sourceText, translation: item.translation, enabled: settings['ruby.first_person'],
    isDialogue: paragraph.paragraphType !== 'narration', speakerKnown: !!speaker, speakerType: speaker?.first_person_type ?? null,
    alreadyAnnotated: false, coverage: item.source_coverage };
  const first = planFirstPersonRuby(input);
  // History can only suppress/change a mark that this unchanged local rule
  // would otherwise emit for one known speaker. Disabled, unquoted narration,
  // omitted/absent first persons and multi-voice paragraphs cannot use it.
  const relevant = !!speaker && first.ruby.length > 0 && (paragraph.sourceText.match(/[「『]/gu) ?? []).length <= 1;
  const prior: PriorRuby = relevant ? previousRubyForm(store, seriesId, speaker!.id, paragraph.seriesOrdinal, overlay) : { form: null, evidence: [], exhausted: false };
  const plan = prior.form === null ? first : planFirstPersonRuby({ ...input, alreadyAnnotated: true, previousForm: prior.form });
  return {
    ruby: plan.ruby,
    findings: [...plan.unresolved.map(block), ...(prior.exhausted ? [block(`较早一人称标注候选超过${PRIOR_RUBY_CANDIDATE_LIMIT}条且未找到有效依据，历史核对未完成`)] : [])],
    inputHash: hash([RUBY_CONTRACT, paragraph, item.translation, item.source_coverage, settings['ruby.first_person'], analysis, speaker?.first_person_type, prior]),
  };
}

/** Rebuild all first-person marks. Old romaji and old offsets never win a merge. */
export function rebuildCandidateRuby(store: ProjectStore, paragraphId: string, item: TranslationItem, previous?: FinalRow, overlay?: RubyHistoryOverlay) {
  const plan = candidateRubyPlan(store, paragraphId, item, overlay);
  const proper = previous ? store.translations.rubyOf(previous).filter(r => r.kind === 'proper-noun') : [];
  const retained = previous ? relocateRubyAnnotations(previous.final_text, item.translation, proper) : [];
  const findings = [...plan.findings];
  if (retained.length !== proper.length) findings.push(block('无法可靠保留原稿专名读音标注，请核对后继续'));
  if (retained.some(a => plan.ruby.some(b => a.start < b.end && b.start < a.end))) findings.push(block('专名读音与一人称标注位置冲突'));
  const ruby = [...retained, ...plan.ruby].sort((a, b) => a.start - b.start);
  findings.push(...validateMarkRanges(item.translation, ruby));
  return { ...plan, ruby, findings };
}

/** For final adoption/export checks: recompute against the exact current source and current text. */
export function inspectCandidateRuby(store: ProjectStore, paragraphId: string, item: TranslationItem, marks: readonly RubyAnnotation[], overlay?: RubyHistoryOverlay) {
  const plan = candidateRubyPlan(store, paragraphId, item, overlay), findings = [...plan.findings];
  const actual = marks.filter(m => m.kind === 'first-person').map(m => ({ start: m.start, end: m.end, rt: m.rt, kind: m.kind })).sort((a, b) => a.start - b.start);
  if (JSON.stringify(actual) !== JSON.stringify(plan.ruby)) findings.push(block('一人称标注与当前日文形式、人物阶段或中文位置不一致，需要重新复核'));
  findings.push(...validateMarkRanges(item.translation, marks));
  return { ...plan, findings };
}
export function validateCandidateRuby(store: ProjectStore, paragraphId: string, item: TranslationItem, marks: readonly RubyAnnotation[]): ValidationFinding[] {
  return inspectCandidateRuby(store, paragraphId, item, marks).findings;
}

export function requireCandidateRuby(store: ProjectStore, paragraphId: string, item: TranslationItem, previous?: FinalRow, overlay?: RubyHistoryOverlay): RubyAnnotation[] {
  const result = rebuildCandidateRuby(store, paragraphId, item, previous, overlay);
  if (result.findings.length) throw new Error(result.findings.map(f => f.message).join('；'));
  return result.ruby;
}
