/** Kana spelling aid, not a translation, an English etymology, or a kanji reading.
 * Explicit ー receives a macron. Written vowel sequences stay separate (ou, ei):
 * deciding whether they are a long vowel requires lexical knowledge we do not have.
 */
const SINGLE: Record<string, string> = {
  あ:'a',い:'i',う:'u',え:'e',お:'o',
  か:'ka',き:'ki',く:'ku',け:'ke',こ:'ko',が:'ga',ぎ:'gi',ぐ:'gu',げ:'ge',ご:'go',
  さ:'sa',し:'shi',す:'su',せ:'se',そ:'so',ざ:'za',じ:'ji',ず:'zu',ぜ:'ze',ぞ:'zo',
  た:'ta',ち:'chi',つ:'tsu',て:'te',と:'to',だ:'da',ぢ:'ji',づ:'zu',で:'de',ど:'do',
  な:'na',に:'ni',ぬ:'nu',ね:'ne',の:'no',
  は:'ha',ひ:'hi',ふ:'fu',へ:'he',ほ:'ho',ば:'ba',び:'bi',ぶ:'bu',べ:'be',ぼ:'bo',
  ぱ:'pa',ぴ:'pi',ぷ:'pu',ぺ:'pe',ぽ:'po',
  ま:'ma',み:'mi',む:'mu',め:'me',も:'mo',や:'ya',ゆ:'yu',よ:'yo',
  ら:'ra',り:'ri',る:'ru',れ:'re',ろ:'ro',わ:'wa',ゐ:'wi',ゑ:'we',を:'wo',ん:'n',ゔ:'vu',
};
const PAIR: Record<string, string> = {
  いぇ:'ye',うぃ:'wi',うぇ:'we',うぉ:'wo',
  しぇ:'she',じぇ:'je',ちぇ:'che',
  すぃ:'si',ずぃ:'zi',てぃ:'ti',でぃ:'di',とぅ:'tu',どぅ:'du',
  てゅ:'tyu',でゅ:'dyu',つぁ:'tsa',つぃ:'tsi',つぇ:'tse',つぉ:'tso',
  ふぁ:'fa',ふぃ:'fi',ふぇ:'fe',ふぉ:'fo',ふゅ:'fyu',
  ゔぁ:'va',ゔぃ:'vi',ゔぇ:'ve',ゔぉ:'vo',ゔゅ:'vyu',
  くぁ:'kwa',くぃ:'kwi',くぇ:'kwe',くぉ:'kwo',くゎ:'kwa',
  ぐぁ:'gwa',ぐぃ:'gwi',ぐぇ:'gwe',ぐぉ:'gwo',ぐゎ:'gwa',
};
for (const [kana, stem] of Object.entries({き:'ky',ぎ:'gy',し:'sh',じ:'j',ち:'ch',ぢ:'j',に:'ny',ひ:'hy',び:'by',ぴ:'py',み:'my',り:'ry'})) {
  for (const [small, vowel] of Object.entries({ゃ:'a',ゅ:'u',ょ:'o'})) PAIR[kana + small] = stem + vowel;
}
const MACRON: Record<string, string> = {a:'ā',i:'ī',u:'ū',e:'ē',o:'ō'};

/** Returns null rather than displaying a fabricated partial reading. */
export function kanaReading(source: string): string | null {
  // Do not let compatibility symbols (e.g. square unit symbols) masquerade as
  // a verified reading merely because NFKC expands them into kana.
  if (!/^[\u3041-\u3096\u3099\u309a\u30a1-\u30f6\u30fb\u30fc\uff66-\uff9f\s]+$/u.test(source)) return null;
  const kana = source.normalize('NFKC').trim().replace(/[\u30a1-\u30f6]/gu,
    c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  if (!kana) return null;
  let result = '', hasKana = false;
  for (let i = 0; i < kana.length; i++) {
    const c = kana[i]!;
    if (c === '・' || /\s/u.test(c)) {
      // Separators divide words; they cannot supply a missing pronunciation.
      if (!result || result.endsWith(' ')) return null;
      result += ' ';
      continue;
    }
    if (c === 'ー') {
      const vowel = result.at(-1)!;
      if (!MACRON[vowel]) return null;
      result = result.slice(0, -1) + MACRON[vowel];
      continue;
    }
    const pair = PAIR[kana.slice(i, i + 2)];
    const syllable = pair ?? SINGLE[c];
    if (c === 'っ') {
      const next = PAIR[kana.slice(i + 1, i + 3)] ?? SINGLE[kana[i + 1]!];
      if (!next || !/^[kstpbdfgjczv]/u.test(next)) return null;
      result += next.startsWith('ch') ? 't' : next[0];
      continue;
    }
    if (!syllable) return null;
    if (c === 'ん') {
      const next = PAIR[kana.slice(i + 1, i + 3)] ?? SINGLE[kana[i + 1]!];
      result += next && /^[aeiouy]/u.test(next) ? "n'" : 'n';
    } else result += syllable;
    hasKana = true;
    if (pair) i++;
  }
  return hasKana && !result.endsWith(' ') ? result : null;
}
