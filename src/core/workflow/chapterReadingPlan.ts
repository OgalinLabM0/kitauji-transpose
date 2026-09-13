import { LONG_READING_CHUNK_LIMIT, LONG_READING_MAX_CHUNKS, readingUnits, type ReadingRange } from './longNaturalnessPlan';

export interface ChapterPassage {
  id: string; chapter: string; source: string; translation: string;
  finalId: string | null; ruby: string | null; inputHash: string;
  fullTranslation?: string; range?: ReadingRange;
}
export interface ChapterTask { suffix: string; items: ChapterPassage[]; user: string }
export function chapterRequest(items: ChapterPassage[]): string {
  return JSON.stringify({ items: items.map(p => ({ id: p.id, source: p.source, translation: p.translation,
    ...(p.range ? { translation_range: p.range, source_scope: '完整段落日文，非当前中文范围的精确对齐；只诊断展示的完整中文句群，不推断未展示中文。原译忠实性仍由独立整段审核负责。' } : {}) })) });
}

/** The full Japanese paragraph is repeated, never sliced by Chinese position.
 * All Chinese chunks and all chunk/paragraph seams are mandatory, not samples.
 * Fail the entire replacement when even one complete edge unit cannot fit. */
export function splitChapterPair(items: ChapterPassage[], limit: number): ChapterTask[] | null {
  try {
    if (items.some(p => !p.translation.trim() || p.translation.length > LONG_READING_CHUNK_LIMIT * LONG_READING_MAX_CHUNKS || chapterRequest([{ ...p, translation: '' }]).length > limit)) return null;
    const tasks: ChapterTask[] = [];
    const edgeUnits = items.map(p => readingUnits(p.translation));
    const part = (p: ChapterPassage, range: ReadingRange): ChapterPassage => ({ ...p,
      fullTranslation: p.translation, translation: p.translation.slice(range.start, range.end), range: { start: range.start, end: range.end } });
    for (const [i, p] of items.entries()) {
      const units = edgeUnits[i]!, chunks: ReadingRange[] = [];
      for (const unit of units) {
        const last = chunks.at(-1);
        const merged = { start: last?.start ?? unit.start, end: unit.end };
        if (last && merged.end - merged.start <= LONG_READING_CHUNK_LIMIT && chapterRequest([part(p, merged)]).length <= limit) last.end = unit.end;
        else chunks.push({ ...unit });
        if (chunks.length > LONG_READING_MAX_CHUNKS) return null;
      }
      const ranges = chunks.map((range, index) => ({ ...range, kind: 'chunk', index }));
      for (let index = 1; index < chunks.length; index++) {
        const boundary = chunks[index]!.start;
        ranges.push({ start: units.find(u => u.end === boundary)!.start, end: units.find(u => u.start === boundary)!.end, kind: 'join', index: index - 1 });
      }
      for (const task of ranges) {
        const pieces = [part(p, task)];
        tasks.push({ suffix: `${task.kind}:${task.index}`, items: pieces, user: chapterRequest(pieces) });
      }
    }
    if (items.length === 2) {
      const pieces = [part(items[0]!, edgeUnits[0]!.at(-1)!), part(items[1]!, edgeUnits[1]![0]!)];
      tasks.push({ suffix: 'paragraph-seam', items: pieces, user: chapterRequest(pieces) });
    }
    return tasks.every(t => t.user.length <= limit) ? tasks : null;
  } catch { return null; }
}
