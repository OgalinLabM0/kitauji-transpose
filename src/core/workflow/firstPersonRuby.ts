import type { RubyAnnotation } from '@core/db';
import type { TranslationItem } from '@core/ai/protocol';
import { stripMarkers } from '@core/epub/blocks';

/** Literal source forms, never pronunciation labels. Ambiguous lexical forms need explicit alignment. */
export const FIRST_PERSON_FORMS: Record<string, readonly string[]> = {
  boku: ['僕', 'ぼく'], ore: ['俺様', '俺', 'おれ'], watashi: ['私', 'わたし'], atashi: ['あたし'],
  uchi: ['うち'], washi: ['儂', 'わし'], sessha: ['拙者'], watakushi: ['私', 'わたくし'],
  ware: ['我', 'われ'], oira: ['おいら'], jibun: ['自分'],
};
export interface SourcePerson { start: number; end: number; form: string }
export function sourceFirstPersons(source: string): SourcePerson[] {
  const text = stripMarkers(source);
  const forms = [...new Set(Object.values(FIRST_PERSON_FORMS).flat())].sort((a, b) => b.length - a.length);
  const result: SourcePerson[] = [];
  for (const m of text.matchAll(new RegExp(forms.join('|'), 'gu'))) {
    const form = m[0], start = m.index, end = start + form.length;
    if (!/^(?:$|[はがのをにともでだしこさっかよまだけ、。，！？!?…「」『』\s])/u.test(text.slice(end))) continue;
    if (form === '僕' && /[公下従召]/u.test(text[start - 1] ?? '')) continue;
    if (form === '私' && /[公無]/u.test(text[start - 1] ?? '')) continue;
    if (form === '我' && /[自忘無物]/u.test(text[start - 1] ?? '')) continue;
    // Plural source pronouns are not evidence for a singular Chinese 我.
    if (/^(?:たち|達|ら|等)/u.test(text.slice(end))) continue;
    result.push({ start, end, form });
  }
  return result;
}

export function chineseFirstPersons(text: string): number[] {
  return [...text.matchAll(/(?<![自忘无無物敌敵])我(?![们們国國方军軍辈輩]|等(?=$|[\p{P}\s]))/gu)].map(m => m.index);
}

/**
 * Enforce the confirmed body convention only where the source-to-target
 * coverage proves the exact self-reference span.  This deliberately does not
 * scan or rewrite the whole translation: omitted subjects, quoted words,
 * special self-references and ambiguous/multi-voice paragraphs remain for
 * the existing human review path.
 */
interface Unit { start: number; end: number; path: string; group: string }
/** A nested quote interrupts a clause, but never inherits its parent's voice or offsets. */
function units(text: string): { units: Unit[]; valid: boolean } {
  const out: Unit[] = [], stack: { close: string; path: string }[] = [];
  const clauses = new Map<string, number>();
  const closing: Record<string, string> = { '「': '」', '『': '』', '“': '”', '‘': '’' };
  let start = 0, serial = 0;
  const path = () => stack.map(s => s.path).join('/');
  const flush = (end: number) => {
    if (end > start && /[^\s\p{P}]/u.test(text.slice(start, end))) out.push({ start, end, path: path(), group: `${path()}:${clauses.get(path()) ?? 0}` });
    start = end;
  };
  for (let n = 0; n < text.length; n++) {
    const c = text[n]!;
    if (closing[c]) { flush(n); stack.push({ close: closing[c]!, path: String(serial++) }); start = n + 1; }
    else if (/[」』”’]/u.test(c)) { if (stack.at(-1)?.close !== c) return { units: [], valid: false }; flush(n); stack.pop(); start = n + 1; }
    else if (/[。！？!?\n]/u.test(c)) { flush(n + 1); clauses.set(path(), (clauses.get(path()) ?? 0) + 1); }
  }
  flush(text.length);
  return { units: out, valid: stack.length === 0 };
}
const uniqueAt = (text: string, token: string) => { const at = token ? text.indexOf(token) : -1; return at >= 0 && text.indexOf(token, at + 1) < 0 ? at : -1; };
export interface FirstPersonInput {
  source: string; translation: string; enabled: boolean; isDialogue: boolean;
  speakerType: string | null; alreadyAnnotated: boolean;
  /** Identity can be known even when the stage has no habitual first-person type. */
  speakerKnown?: boolean;
  /** Only a validated earlier literal form, not a model shift flag. */
  previousForm?: string | null;
  coverage?: TranslationItem['source_coverage'];
}
export interface FirstPersonPlan { ruby: RubyAnnotation[]; unresolved: string[] }

export function planFirstPersonRuby(input: FirstPersonInput): FirstPersonPlan {
  const ruby: RubyAnnotation[] = [], unresolved: string[] = [];
  if (!input.enabled) return { ruby, unresolved };
  const source = stripMarkers(input.source), target = stripMarkers(input.translation);
  if (!input.isDialogue && !/[「『]/u.test(source)) return { ruby, unresolved };
  const people = sourceFirstPersons(source);
  if (!people.length || !chineseFirstPersons(target).length) return { ruby, unresolved };
  const src = units(source), dst = units(target);
  if (!src.valid || !dst.valid) return { ruby, unresolved: ['引号边界不完整，无法确定一人称标注位置'] };
  const sourcePaths = [...new Set(src.units.map(u => u.path))], targetPaths = [...new Set(dst.units.map(u => u.path))];
  // A wholly quoted dialogue may be rendered without enclosing marks; mixed/nested voices cannot.
  const bareDialogue = input.isDialogue && sourcePaths.length === 1 && sourcePaths[0] !== '' && !sourcePaths[0]!.includes('/')
    && targetPaths.length === 1 && targetPaths[0] === '';
  const sourceGroup = (u: Unit) => bareDialogue ? u.group.slice(u.path.length) : u.group;
  const sameVoice = (a: Unit, b: Unit) => a.path === b.path || (bareDialogue && b.path === '');
  const sourceGroups = [...new Set(src.units.map(sourceGroup))], targetGroups = [...new Set(dst.units.map(u => u.group))];
  const structurallyPaired = JSON.stringify(sourceGroups) === JSON.stringify(targetGroups);
  const seen = new Map<string, string>();
  // A whole-paragraph speaker is applicable only when there is at most one non-nested quote.
  const paths = new Set(src.units.filter(u => u.path).map(u => u.path));
  const knownSpeaker = (input.speakerKnown ?? input.speakerType !== null) && paths.size <= 1;
  if (knownSpeaker && input.alreadyAnnotated) seen.set('speaker', input.previousForm ?? `type:${input.speakerType}`);
  for (const person of people) {
    const unitIndex = src.units.findIndex(u => person.start >= u.start && person.end <= u.end);
    const unit = src.units[unitIndex];
    if (!unit) { unresolved.push('一人称跨越原文结构边界'); continue; }
    if (unit.path && /^(?:[」』”’])(?:という|と言う|と呼ぶ|の(?:字|文字|意味|一人称))/u.test(source.slice(unit.end))) {
      unresolved.push(`原文「${person.form}」可能是词语引用，而非说话人自称`); continue;
    }
    const sourceUnits = src.units.filter(u => u.group === unit.group);
    const sourcePeople = people.filter(p => sourceUnits.some(u => p.start >= u.start && p.end <= u.end));
    let targetRanges: { start: number; end: number }[] = [];
    // Finer verified alignment can separate omitted subjects and repeated 我 within one sentence.
    let crossesVoice = false;
    const anchors = (input.coverage ?? []).flatMap(c => {
      if (c.status === 'uncertain') return [];
      // Coverage may legitimately include enclosing quotation punctuation, while
      // voice units exclude it. Normalize only anchor edges; uniqueness and the
      // original source/target voice checks below still decide eligibility.
      const anchor = (text: string) => stripMarkers(text).replace(/^[「『“‘]+|[」』”’]+$/gu, '');
      const segment = anchor(c.segment), rendered = anchor(c.rendered_as);
      const a = uniqueAt(source, segment), b = uniqueAt(target, rendered);
      if (a < 0 || b < 0 || person.start < a || person.end > a + segment.length) return [];
      // A standalone self-reference may include its following pause in exact
      // alignment (私、 -> 我，). That boundary is not a second clause. Keep
      // interior separators and broader/uncertain mappings on the review path.
      const isolatedSelfReference = c.status === 'covered'
        && segment.replace(/[、，,]$/u, '') === person.form
        && rendered.replace(/[、，,]$/u, '') === '我';
      if (a < unit.start || a + segment.length > unit.end || (/[、，,；;]/u.test(segment + rendered) && !isolatedSelfReference)) return [];
      if (people.filter(p => p.start >= a && p.end <= a + segment.length).length !== 1) return [];
      const dstUnit = dst.units.find(u => b >= u.start && b + rendered.length <= u.end);
      if (dstUnit && !sameVoice(unit, dstUnit)) crossesVoice = true;
      if (!dstUnit || !sameVoice(unit, dstUnit)) return [];
      return [{ start: b, end: b + rendered.length }];
    });
    if (crossesVoice) { unresolved.push(`原文「${person.form}」的对齐证据跨越不同引号说话范围`); continue; }
    const distinct = [...new Map(anchors.map(a => [`${a.start}:${a.end}`, a])).values()];
    if (distinct.length === 1) targetRanges = distinct;
    else if (distinct.length > 1) { unresolved.push(`原文「${person.form}」有相互冲突的对应范围`); continue; }
    else if (structurallyPaired && sourcePeople.length === 1) {
      targetRanges = dst.units.filter(u => u.group === sourceGroup(unit));
      if (sourceUnits.some(u => /[、，,；;]/u.test(source.slice(u.start, u.end)))) {
        unresolved.push(`原文「${person.form}」的多分句需要更细的对齐证据`); continue;
      }
    }
    else { unresolved.push(`原文「${person.form}」缺少唯一的中文对应范围`); continue; }
    const validOffsets = new Set(chineseFirstPersons(target));
    const offsets = targetRanges.flatMap(range => chineseFirstPersons(target.slice(range.start, range.end)).map(n => range.start + n)).filter(n => validOffsets.has(n));
    if (!offsets.length) continue; // Chinese may legitimately omit a subject; never insert prose.
    if (offsets.length !== 1 || ruby.some(r => r.start === offsets[0])) { unresolved.push(`原文「${person.form}」无法唯一对应当前中文“我”`); continue; }
    if (['うち', 'われ', '我', '自分'].includes(person.form)) {
      const explicit = knownSpeaker && input.speakerType && FIRST_PERSON_FORMS[input.speakerType]?.includes(person.form)
        && (input.coverage ?? []).some(c => c.status === 'covered' && stripMarkers(c.segment) === person.form && stripMarkers(c.rendered_as) === '我'
          && uniqueAt(source, person.form) === person.start && uniqueAt(target, '我') === offsets[0]);
      if (!explicit) { unresolved.push(`原文「${person.form}」可能不是自称，需要人物及逐词对齐证据`); continue; }
    }
    const identity = knownSpeaker && (!paths.size || !!unit.path) ? 'speaker' : unit.path || `unit:${unitIndex}`;
    const previous = seen.get(identity);
    const sameType = previous?.startsWith('type:') && FIRST_PERSON_FORMS[previous.slice(5)]?.includes(person.form);
    if (previous === person.form || sameType) continue;
    ruby.push({ start: offsets[0]!, end: offsets[0]! + 1, rt: person.form, kind: 'first-person' });
    seen.set(identity, person.form);
  }
  return { ruby: ruby.sort((a, b) => a.start - b.start), unresolved: [...new Set(unresolved)] };
}
