import { englishRubyRules, englishRubyMarks } from './termEnglishRuby';
import type { ProjectStore, RubyAnnotation } from '@core/db';

const ROMAJI: Readonly<Record<string, string>> = {
  俺: 'ore', おれ: 'ore', 俺様: 'ore-sama', 僕: 'boku', ぼく: 'boku',
  私: 'watashi', わたし: 'watashi', わたくし: 'watakushi', あたし: 'atashi',
  うち: 'uchi', 儂: 'washi', わし: 'washi', 拙者: 'sessha', 我: 'ware',
  われ: 'ware', おいら: 'oira', 自分: 'jibun',
};

/** Presentation only. Keep literal source forms in stored alignment/history receipts. */
export function displayRubyReading(mark: Pick<RubyAnnotation, 'kind' | 'rt'>, speakerType?: string | null): string {
  if (mark.kind !== 'first-person') return mark.rt;
  if (mark.rt === '私' && speakerType === 'watakushi') return 'watakushi';
  return ROMAJI[mark.rt] ?? mark.rt;
}

/** Read all contextual inputs before an exporter yields; never mutate stored marks. */
export function rubyForExport(store: ProjectStore, paragraphId: string, marks: readonly RubyAnnotation[]): RubyAnnotation[] {
  const paragraph = store.projects.getParagraph(paragraphId);
  const analysis = store.projects.currentAnalysis(paragraphId);
  const speaker = paragraph && analysis?.speaker_char_id && (paragraph.sourceText.match(/[「『]/gu) ?? []).length <= 1
    ? store.knowledge.getCharacterAt(analysis.speaker_char_id, paragraph.seriesOrdinal) : undefined;
  const speakerType = speaker?.series_id === store.projects.getSeriesIdOfParagraph(paragraphId) ? speaker.first_person_type : null;
  const visible=marks.map(mark => ({ ...mark, rt: displayRubyReading(mark, speakerType) }));
  const final=store.translations.latestFinal(paragraphId);
  return paragraph&&final?englishRubyMarks(paragraph.sourceText,final.final_text,englishRubyRules(store.db,store.projects.getSeriesIdOfParagraph(paragraphId)),visible):visible;
}
