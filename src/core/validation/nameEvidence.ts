export interface NameEvidence { paragraph_id: string; quote: string; reviewId?: string }

// A title can adjoin a name without a Japanese word separator. Recognize
// bounded title forms, never an arbitrary Han suffix or a cropped source.
const militaryRank = '(?:准尉|少尉|中尉|大尉|少佐|中佐|大佐|准将|少将|中将|大将|元帥|伍長|軍曹|曹長|兵長|上等兵|一等兵|二等兵)';
const formalTitle = '(?:(?:陸軍|海軍|空軍|航空|魔導|軍医)?'+militaryRank+'|(?:教皇|王室|政府)?(?:特使|大使)|教授|准教授|助教授|社長|会長|部長|課長|店長|隊長|団長|司令官)';
// Numeric school designations are suffix boundaries, not glossary candidates.
const studentTitle = '(?:第?[一二三四五六七八九十百〇零0-9０-９]+(?:号生|年生|期生))';
const nameTitleSuffix = new RegExp('^(?:'+formalTitle+'|'+studentTitle+')(?:殿|様|氏|閣下)?(?=$|[\\p{P}\\p{Z}\\p{Script=Hiragana}])','u');
const nameTitlePrefix = new RegExp('(?:^|[\\p{P}\\p{Z}\\p{Script=Hiragana}])'+formalTitle+'$','u');

// Stylized speech can spell grammatical endings in katakana too. Require the
// complete ending and its real boundary; never accept a cropped compound.
const katakanaNameEnding = /^(?:トヤラ|サン|クン|チャン|サマ|ドノ)(?=$|[\p{P}\p{Z}\p{Script=Hiragana}])/u;

/**
 * Project paragraph text may contain opaque EPUB markers between characters
 * that are visibly adjacent (for example a name split across styled spans).
 * Remove only balanced wrap/ruby markers. Unpaired markers represent atomic
 * nodes such as br/img and remain a hard boundary so evidence cannot be
 * fabricated across them.
 */
export function visibleNameSource(source: string): string {
  const markers = [...source.matchAll(/⟦(\/?)(\d+)⟧/g)];
  const counts = new Map<string, { open: number; close: number }>();
  for (const match of markers) {
    const c = counts.get(match[2]!) ?? { open: 0, close: 0 };
    if (match[1] === '/') c.close++; else c.open++;
    counts.set(match[2]!, c);
  }
  const candidates = new Set([...counts].filter(([, c]) => c.open === 1 && c.close === 1).map(([id]) => id));
  const invalid = new Set<string>();
  const paired = new Set<string>();
  const stack: string[] = [];
  for (const match of markers) {
    const id = match[2]!;
    // Atomic nodes have no close marker and must not disturb an outer wrapper.
    if (!candidates.has(id) || invalid.has(id)) continue;
    if (match[1] !== '/') {
      stack.push(id);
      continue;
    }
    const top = stack[stack.length - 1];
    if (top !== id) {
      invalid.add(id);
      const at = stack.lastIndexOf(id);
      if (at >= 0) { for (const nested of stack.slice(at)) invalid.add(nested); stack.splice(at); }
      continue;
    }
    stack.pop();
    paired.add(id);
  }
  for (const id of stack) invalid.add(id);
  return source.replace(/⟦(\/?)(\d+)⟧/g, (_full, _slash: string, id: string) => paired.has(id) && !invalid.has(id) ? '' : '\uFFFC');
}

/** An exact visible quote within one paragraph; never an empty or atomic-only receipt. */
export function containsVisibleQuote(source: string, quote: string): boolean {
  const visible = visibleNameSource(quote);
  // An atomic placeholder may legitimately surround a complete quote. It is
  // only invalid when the quote has no visible characters of its own.
  return !!visible.replace(/\uFFFC/g, '').trim() && visibleNameSource(source).includes(visible);
}

/** Check the real source boundaries, not only a possibly cropped model quote. */
export function validNameQuote(name: string, quote: string, source: string): boolean {
  quote = visibleNameSource(quote);
  if (!name.trim() || name !== name.trim() || name.includes('\uFFFC') || !quote.trim() || !quote.replace(/\uFFFC/g, '').trim()) return false;
  source = visibleNameSource(source);
  const word = /[\p{Script=Han}\p{Script=Katakana}\p{Script=Latin}\p{N}々ー]/u;
  for (let at = source.indexOf(quote); at >= 0; at = source.indexOf(quote, at + 1)) {
    for (let offset = quote.indexOf(name); offset >= 0; offset = quote.indexOf(name, offset + 1)) {
      const start = at + offset, end = start + name.length;
      const before = [...source.slice(0, start)].at(-1) ?? '';
      const after = [...source.slice(end)][0] ?? '';
      const honorific = /^(?:君|様|殿|氏|先生|先輩|後輩|博士)(?=$|[\p{P}\p{Z}\p{Script=Hiragana}])/u.test(source.slice(end)) || nameTitleSuffix.test(source.slice(end)) || katakanaNameEnding.test(source.slice(end));
      const titleBefore = nameTitlePrefix.test(source.slice(0,start));
      if ((!word.test(before) || titleBefore) && (!word.test(after) || honorific)) return true;
    }
  }
  return false;
}
