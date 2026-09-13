/**
 * 程序校验层（docs/标准/TRANSLATION_RULES.md 第八节）。零成本、确定性、在 AI 审校之前运行。
 * 输入为带 ⟦n⟧ 标记的原文与译文；标记先剥离再检测。
 */
import type { ValidationFinding, TranslationFlag, LockLevel, ParagraphType } from '@shared/types';
import { checkNumericBounds } from './numericBounds';
import { checkDeicticScope } from './deicticScope';
import { checkWorldbuildingTerms, checkKaomoji } from './sourceTokenPreservation';

export interface GlossaryHit {
  termId: string; termJp: string; termZh: string | null; lockLevel: LockLevel; termType: string;
  /** 全部义项中文（含默认义） */
  senses: string[];
}
export interface ValidationInput {
  source: string; translation: string; paragraphType: ParagraphType;
  flags?: readonly TranslationFlag[]; glossary?: readonly GlossaryHit[];
}

const strip = (s: string): string => s.replace(/⟦\/?\d+⟧/g, '');
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
const B = (code: ValidationFinding['code'], message: string, details?: Record<string, unknown>): ValidationFinding => ({ code, severity: 'blocks_export', message, ...(details ? { details } : {}) });
const W = (code: ValidationFinding['code'], message: string, details?: Record<string, unknown>): ValidationFinding => ({ code, severity: 'warning', message, ...(details ? { details } : {}) });
const I = (code: ValidationFinding['code'], message: string, details?: Record<string, unknown>): ValidationFinding => ({ code, severity: 'info', message, ...(details ? { details } : {}) });

export const POLLUTION_PATTERNS: RegExp[] = [
  /^\s*(以下是|下面是|这是)(译文|翻译|润色|中文|结果)/u, /^\s*(译文|翻译结果|润色结果|中文译文)\s*[:：]/u, /```/, /\b(Here is|Here's|Sure,|Certainly|As an AI|As a language model|I cannot|I can't)\b/i,
  /(作为(一个)?(AI|人工智能|语言模型)|抱歉，我(无法|不能)|无法满足(您|你)?的|违反(政策|准则|使用规范)|我不能提供)/u, /\bNote:\s/,
];
/** 原文本身含同义前缀（如书中的「翻訳：」注记）时不算污染 */
const SRC_META_RE = /^\s*(翻訳|訳|訳文|注)\s*[:：]/u;

// ---- 人称 / 性别 / 单复数 ----
const JP_SHE = /彼女(?![らたち達等])/g, JP_HE = /彼(?![女らたち達等氏方岸此])/g;
const JP_THEY = /(彼ら|彼等|彼女ら|彼女たち|彼女達|彼女等|彼たち|奴ら|やつら|ヤツら|あいつら|こいつら|そいつら)/g;
const JP_PLURAL = /(たち|(?<!友)達(?![人成])|人々|方々|諸君|一同|皆さん|皆様|みんな|(?<=[俺僕私君貴様前])ら|(?<=お前)ら|それら|これら|あれら)/g;
// 日文劝诱/意志形式（ましょう）暗含复数第一人称
const JP_VOLITIONAL = /(ましょう|ませんか)/g;
const ZH_HE = /(?<!其)他(?![人乡国日方者们])/g, ZH_SHE = /她(?!们)/g, ZH_THEY = /(他们|她们)/g, ZH_MEN = /们/g;
// 中文第一人称复数（我们/咱们）
const ZH_WE = /(我们|咱们)/g;

export function checkPronouns(src: string, zh: string): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  const jpShe = count(src, JP_SHE), jpHe = count(src, JP_HE), jpThey = count(src, JP_THEY), jpPlural = count(src, JP_PLURAL);
  const jpVolitional = count(src, JP_VOLITIONAL); // ましょう等劝诱形
  const pronounText = zh.replace(/吉他|维他命|維他命|利他主义|利他主義|排他性|他山之石/g, '');
  const zhHe = count(pronounText, ZH_HE), zhShe = count(zh, ZH_SHE), zhThey = count(zh, ZH_THEY), zhMen = count(zh, ZH_MEN);
  const zhWe = count(zh, ZH_WE); // 我们/咱们

  if (zhWe > jpPlural + jpVolitional) out.push(B('PRONOUN_HALLUCINATION', '译文新增“我们／咱们”，原文缺少足够的明确复数或邀约依据', { kind: 'first-person-plural', zh: zhWe, jp: jpPlural + jpVolitional }));

  // 中性指示词/蔑称并不携带性别信息，不能作为“他/她”的授权来源。
  if (zhShe > jpShe) out.push(B('PRONOUN_HALLUCINATION', `译文出现 ${zhShe} 处”她”，原文只有 ${jpShe} 处明示女性第三人称`, { kind: 'gender', word: '她', zh: zhShe, jp: jpShe }));
  if (zhHe + zhShe > jpHe + jpShe) out.push(B('PRONOUN_HALLUCINATION', `译文第三人称单数 ${zhHe + zhShe} 处，多于原文 ${jpHe + jpShe} 处明确性别指示`, { kind: 'third-person', zh: zhHe + zhShe, jp: jpHe + jpShe }));
  if (zhThey > jpThey) {
    // 原文含复数标记（たち/達/ら…）时，”他们”可能只是把复数名词代词化（不增信息）→ 警告；原文毫无复数信息 → 阻断
    const mk = jpPlural > 0 ? W : B;
    out.push(mk('PRONOUN_HALLUCINATION', `译文出现 ${zhThey} 处”他们/她们”，原文只有 ${jpThey} 处复数第三人称${jpPlural > 0 ? '（原文有复数名词，请确认是否为同一所指）' : ''}`, { kind: 'plural-pronoun', zh: zhThey, jp: jpThey }));
  }

  // 修正：允许劝诱形对应中文第一人称复数
  // “行きましょう” → “我们去吧” 是合法转换，不应阻断
  const allowedMen = zhWe + zhThey; // “我们”和”他们/她们”都包含”们”
  const jpImpliedPlural = jpPlural + jpThey + jpVolitional; // 原文的复数信号
  if (zhMen > allowedMen && zhMen - allowedMen > jpImpliedPlural) {
    out.push(B('PRONOUN_HALLUCINATION', `译文”们”多于原文复数标记（${zhMen} vs ${jpImpliedPlural}）`, { kind: 'plural', zh: zhMen, jp: jpImpliedPlural }));
  }

  if (jpShe > 0 && zhShe + zhThey === 0) out.push(W('PRONOUN_DELETED', `原文有 ${jpShe} 处「彼女」，译文没有”她”（若为”女朋友”义请人工确认）`, { word: '彼女' }));
  if (jpHe > 0 && zhHe + zhThey === 0) out.push(W('PRONOUN_DELETED', `原文有 ${jpHe} 处「彼」，译文没有”他”`, { word: '彼' }));
  if (jpThey > 0 && zhThey + zhMen === 0) out.push(W('PRONOUN_DELETED', '原文有复数第三人称，译文没有对应复数', { word: 'they' }));
  return out;
}

// ---- 数字 ----
const fw = (s: string): string => s.replace(/[０-９．，＋－]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/−/g, '-');
const HAN_NUM_CHARS = '〇零一二两三四五六七八九十百千万億亿兆';
const HAN_NUM_UNITS = '人个つ個本枚匹回度年月日時分秒番歳才岁階阶名台冊册巻卷章話话';
const HAN_NUM_RE = new RegExp(`[${HAN_NUM_CHARS}]+(?=[${HAN_NUM_UNITS}])`, 'gu');
// These are lexical compounds, rather than count/ordinal expressions.  Keep this
// list closed so an arbitrary Han prefix cannot suppress numeric validation.
const LEXICAL_NUM_SUFFIX = /^(?:人称|番(?!目|号)|人前|人暮らし|人旅|人娘|人息子|人芝居|人勝ち|人当たり)/u;
const HAN_DIGIT = new Map([['〇', 0], ['零', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9]]);
const HAN_UNIT = new Map([['十', 10n], ['百', 100n], ['千', 1000n]]);
const HAN_LARGE_UNIT = new Map([['万', 10000n], ['億', 100000000n], ['亿', 100000000n], ['兆', 1000000000000n]]);
type HanNumber = { token: string; value: bigint };
const parseHanNumber = (token: string): bigint | null => {
  if ([...token].every(c => HAN_DIGIT.has(c))) return BigInt([...token].map(c => HAN_DIGIT.get(c)).join(''));
  let total = 0n, section = 0n, digit: bigint | null = null;
  for (const c of token) {
    const d = HAN_DIGIT.get(c);
    if (d !== undefined) { digit = BigInt(d); continue; }
    const small = HAN_UNIT.get(c);
    if (small) { section += (digit ?? 1n) * small; digit = null; continue; }
    const large = HAN_LARGE_UNIT.get(c);
    if (large) { section += digit ?? 0n; total += (section || 1n) * large; section = 0n; digit = null; continue; }
    return null;
  }
  return total + section + (digit ?? 0n);
};
const hanNumbers = (s: string): HanNumber[] => {
  const text = fw(s), out: HanNumber[] = [];
  for (const match of text.matchAll(HAN_NUM_RE)) {
    const token = match[0], end = (match.index ?? 0) + token.length;
    if (LEXICAL_NUM_SUFFIX.test(text.slice(end))) continue;
    const value = parseHanNumber(token); if (value !== null) out.push({ token, value });
  }
  return out;
};
export function checkNumbers(src: string, zh: string): ValidationFinding[] {
  const nums = (s: string): Map<string, number> => { const text = fw(s), m = new Map<string, number>(); for (const match of text.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const offset = match.index ?? 0, suffix = text.slice(offset + match[0].length);
    if (LEXICAL_NUM_SUFFIX.test(suffix)) continue;
    const prefix = text.slice(0, offset);
    // A sign after another numeral is a range/operator separator, not a unary sign.
    const signed = /[+-]$/.test(prefix) && !/[0-9]\s*[+-]$/.test(prefix);
    const n = (signed ? prefix.slice(-1) : '') + match[0];
    m.set(n, (m.get(n) ?? 0) + 1);
  } return m; };
  const a = nums(src), b = nums(zh), sourceHan = hanNumbers(src); const out: ValidationFinding[] = [];
  for (const [n, c] of a) if ((b.get(n) ?? 0) < c) out.push(B('NUMERIC_FORMAT', `原文数字 ${n} 在译文中缺失或次数不足`, { number: n }));
  const usedSourceHan = new Set<number>();
  for (const [n, c] of b) {
    let missing = c - (a.get(n) ?? 0);
    while (missing-- > 0) {
      const value = /^\d+$/.test(n) ? BigInt(n) : null;
      const index = value === null ? -1 : sourceHan.findIndex((item, i) => !usedSourceHan.has(i) && item.value === value);
      const matched = index >= 0 ? sourceHan[index] : undefined;
      if (matched) {
        usedSourceHan.add(index);
        out.push(B('NUMERIC_FORMAT', `原文汉字数字「${matched.token}」被改写为阿拉伯数字 ${n}，请按要求保留原形`, { number: n, sourceHan: matched.token }));
      } else out.push(B('NUMERIC_FORMAT', `译文出现原文没有的数字 ${n}`, { number: n }));
    }
  }
  return out;
}

// ---- 假名泄漏 / 乱码 / 污染 ----
const KANA = /[ぁ-ゖァ-ヺ]/g;
export function checkKana(zh: string): ValidationFinding[] {
  const noNote = zh.replace(/（注[:：][^）]*）/g, '');
  const hits = noNote.match(KANA); if (!hits) return [];
  const runs = noNote.match(/[ぁ-ゖァ-ヺー]+/g) ?? [];
  return [B('HIRAGANA_LEAK', `译文残留日文假名：${[...new Set(runs)].slice(0, 5).join('、')}`, { runs: [...new Set(runs)] })];
}
export function checkMojibake(zh: string): ValidationFinding[] {
  const m = zh.match(/[ --�-]/g);
  return m ? [B('MOJIBAKE', `译文含 ${m.length} 个控制/替代/私用字符`, { codes: [...new Set(m.map(c => 'U+' + c.charCodeAt(0).toString(16).padStart(4, '0')))] })] : [];
}
export function checkPollution(zh: string, src = ''): ValidationFinding[] {
  if (SRC_META_RE.test(src)) return [];
  for (const re of POLLUTION_PATTERNS) { const m = re.exec(zh); if (m) return [B('POLLUTION', `译文含模型元语言：“${m[0].trim()}”`, { match: m[0] })]; }
  return [];
}

// ---- 长度 / 引号 / 口吃 ----
export function checkLength(src: string, zh: string): ValidationFinding[] {
  const a = src.replace(/\s/g, '').length, b = zh.replace(/\s/g, '').length;
  if (a < 8) return [];
  const v = Math.abs(b - a) / a;
  if (v > 0.6) return [B('LENGTH_VARIANCE', `译文长度偏差 ${(v * 100).toFixed(0)}%（原文 ${a}，译文 ${b}）`, { variance: v })];
  if (v >= 0.4) return [W('LENGTH_VARIANCE', `译文长度偏差 ${(v * 100).toFixed(0)}%`, { variance: v })];
  return [];
}
export function checkQuotes(src: string, zh: string): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  const pairs: [string, string][] = [['「', '」'], ['『', '』'], ['（', '）'], ['【', '】'], ['《', '》'], ['〈', '〉']];
  for (const [o, c] of pairs) { const zo = count(zh, new RegExp(o, 'g')), zc = count(zh, new RegExp(c, 'g')); if (zo !== zc) out.push(B('QUOTE_MISMATCH', `译文 ${o}${c} 不配对（${zo}/${zc}）`, { open: o, zo, zc })); }
  const cq = count(zh, /“/g), cqc = count(zh, /”/g); if (cq !== cqc) out.push(B('QUOTE_MISMATCH', `译文 “” 不配对（${cq}/${cqc}）`, { open: '“', zo: cq, zc: cqc }));
  const so = count(src, /[「『]/g), zo = count(zh, /[「『“]/g);
  if (so !== zo && out.length === 0) out.push(W('QUOTE_MISMATCH', `原文 ${so} 组引号，译文 ${zo} 组`, { src: so, zh: zo }));
  return out;
}
const JP_STUTTER = /([ぁ-ゖァ-ヺ一-龯])[っッ]?[、，]\s*\1/u;
const ZH_STUTTER = /(.)[、，…—]+\s*\1/u;
export function checkStutter(src: string, zh: string): ValidationFinding[] {
  if (!JP_STUTTER.test(src)) return [];
  return ZH_STUTTER.test(zh) ? [] : [W('STUTTER_STRIPPED', '原文有口吃/结巴（X、X），译文没有对应的重复', { source: src.match(JP_STUTTER)?.[0] })];
}

// ---- 标点符号 ----
// 用户规则：除逗号外，标点字符和出现顺序必须与原文一致。
// 日文读点、中文逗号和半角逗号统一为逗号；句号、问号、感叹号、引号等不得换形、增删或调位。
const PUNCTUATION_COMMA = new Set(['、', '，', ',']);
// Unicode punctuation includes curly quotes, apostrophes, dashes and nested brackets.
// Wave and Japanese EPUB box-drawing dashes have Unicode category Symbol.
// They still encode authored pauses, whose glyph and length must be preserved.
export const punctuationSequence = (text: string): string[] => [...strip(text)].filter(char => /[\p{P}~～─━]/u.test(char)).map(char => PUNCTUATION_COMMA.has(char) ? ',' : char);
/** Only for newly generated drafts, before alignment/ruby/verification. Never human edits. */
export function normalizeGeneratedStutter(text: string): string {
  return text.replace(/([我你他她])、(?=\1(?![们們国國方]))/gu, '$1，');
}
export function checkPunctuation(src: string, zh: string): ValidationFinding[] {
  const source = punctuationSequence(src), translated = punctuationSequence(zh);
  const out: ValidationFinding[] = [];
  // Repeated personal pronouns are a stutter, not an enumeration. Keep other
  // comma equivalences; never globally replace list punctuation.
  const stutter = /([我你他她])、\1(?![们們国國方])/u.exec(zh);
  if (stutter) out.push(B('PUNCTUATION_MISMATCH', `结巴停顿“${stutter[0]}”应使用中文逗号，保留人称词重复，不用列举顿号`, { kind: 'stutter-comma', quote: stutter[0] }));
  if (source.length === translated.length && source.every((char, i) => char === translated[i])) {
    // Matching counts do not permit dumping a comma beside a sentence ending.
    // Preserve unusual pauses already authored in the source; reject only extras.
    const emptyPauses = (text: string) => {
      const pairs = new Map<string, number>();
      for (const match of strip(text).matchAll(/[,，、]\s*[。！？!?]/gu)) {
        const pair = ',' + match[0].at(-1)!;
        pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
      }
      return pairs;
    };
    const originalPauses = emptyPauses(src);
    for (const [pair, number] of emptyPauses(zh)) if (number > (originalPauses.get(pair) ?? 0)) {
      out.push(B('PUNCTUATION_MISMATCH', `译文把逗号挤在句末标点旁（${pair.replace(',', '，')}），原文没有这么多相邻停顿。请调整句法保留完整停顿，不要用空分句凑标点数量`, { kind: 'collapsed-clause', pair, sourceCount: originalPauses.get(pair) ?? 0, translationCount: number }));
    }
    return out;
  }
  const firstDifference = source.findIndex((char, i) => translated[i] !== char);
  const at = firstDifference >= 0 ? firstDifference : Math.min(source.length, translated.length);
  out.push(B('PUNCTUATION_MISMATCH', `标点与原文不一致：第${at + 1}个标点原文为“${source[at] ?? '无'}”，译文为“${translated[at] ?? '无'}”。除逗号外，标点字符、数量和顺序必须保持一致`, { source, translation: translated, index: at }));
  return out;
}

// ---- 术语 ----
const overlap = (a: string, b: string): number => { const s = new Set(a); let n = 0; for (const c of b) if (s.has(c)) n++; return n / Math.max(a.length, b.length); };
export function checkGlossary(src: string, zh: string, hits: readonly GlossaryHit[], flags: readonly TranslationFlag[]): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  for (const h of hits) {
    if (!h.termZh && h.senses.length === 0) continue;
    const jpCount = src.split(h.termJp).length - 1; if (jpCount === 0) continue;
    const senses = [...new Set([h.termZh, ...h.senses].filter((x): x is string => !!x))];
    const zhCount = senses.reduce((n, s) => n + (zh.split(s).length - 1), 0);
    const dev = flags.find(f => f.type === 'glossary-deviation' && f.term === h.termJp) as Extract<TranslationFlag, { type: 'glossary-deviation' }> | undefined;
    const sense = flags.find(f => f.type === 'glossary-sense' && f.term === h.termJp);
    const conflict = flags.find(f => f.type === 'glossary-conflict' && f.term === h.termJp);
    if (h.lockLevel === 'hard-locked') {
      if (zhCount < jpCount) out.push(B('GLOSSARY_HARD_LOCK_VIOLATION', `硬锁定术语「${h.termJp}」→“${h.termZh}”未在译文中完整使用（${zhCount}/${jpCount}）`, { termId: h.termId, termJp: h.termJp }));
      else if (conflict) out.push(I('GLOSSARY_HARD_LOCK_VIOLATION', `模型对硬锁定「${h.termJp}」提出异议，已按锁定译出`, { termId: h.termId, conflict: true }));
      continue;
    }
    if (zhCount >= jpCount) { if (dev) out.push(W('GLOSSARY_UNFLAGGED_DEVIATION', `「${h.termJp}」声明了偏离但译文实际仍用术语表译法`, { termId: h.termId })); continue; }
    if (dev) {
      if (!dev.used_zh || !zh.includes(dev.used_zh)) { out.push(B('GLOSSARY_UNFLAGGED_DEVIATION', `「${h.termJp}」声明偏离为“${dev.used_zh}”，但译文中找不到该译法`, { termId: h.termId })); continue; }
      if (h.termZh && overlap(h.termZh, dev.used_zh) >= 0.5 && Math.abs(h.termZh.length - dev.used_zh.length) <= 1) out.push(W('GLOSSARY_SYNONYM_SWAP', `「${h.termJp}」偏离“${h.termZh}”→“${dev.used_zh}”疑似同义换词而非义项不同，需审校复核`, { termId: h.termId, glossaryZh: h.termZh, usedZh: dev.used_zh }));
      if (zhCount + (zh.split(dev.used_zh).length - 1) < jpCount) out.push(W('GLOSSARY_COUNT_MISMATCH', `「${h.termJp}」原文 ${jpCount} 次，译文术语+偏离译法合计不足`, { termId: h.termId }));
      continue;
    }
    if (h.lockLevel === 'confirmed') out.push(zhCount === 0
      ? B('GLOSSARY_UNFLAGGED_DEVIATION', `已确认术语「${h.termJp}」→“${h.termZh}”在译文中缺失，且未声明 glossary-deviation`, { termId: h.termId, termJp: h.termJp, termZh: h.termZh })
      : W('GLOSSARY_COUNT_MISMATCH', `「${h.termJp}」原文 ${jpCount} 次，译文 ${zhCount} 次`, { termId: h.termId }));
    else out.push(I('GLOSSARY_UNFLAGGED_DEVIATION', `建议级术语「${h.termJp}」未按提案译出${sense ? '（已声明义项）' : ''}`, { termId: h.termId }));
  }
  return out;
}

/** 全部检测；调用方决定阻断/重试/路由。 */
export function validateTranslation(input: ValidationInput): ValidationFinding[] {
  const src = strip(input.source), zh = strip(input.translation);
  if (zh.trim().length === 0) return [B('EMPTY_TRANSLATION', '译文为空')];
  const out: ValidationFinding[] = [];
  if (zh.trim() === src.trim() && /[ぁ-ゖァ-ヺ]/.test(src)) out.push(B('UNTRANSLATED', '译文与原文相同'));
  out.push(...checkPollution(zh, src), ...checkMojibake(zh), ...checkKana(zh), ...checkPronouns(src, zh), ...checkNumbers(src, zh), ...checkNumericBounds(src, zh), ...checkDeicticScope(src, zh), ...checkLength(src, zh), ...checkQuotes(src, zh), ...checkStutter(src, zh), ...checkPunctuation(src, zh));
  if (input.glossary?.length) out.push(...checkGlossary(src, zh, input.glossary, input.flags ?? []));
  out.push(...checkWorldbuildingTerms(src, zh, input.glossary ?? []), ...checkKaomoji(src, zh));
  return out;
}
export const hasBlocking = (f: readonly ValidationFinding[]): boolean => f.some(x => x.severity === 'blocks_export');
