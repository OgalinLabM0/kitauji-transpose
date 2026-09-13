import type { ValidationFinding } from '@shared/types';

type Relation = 'le' | 'ge' | 'lt' | 'gt' | 'approx';
const numeral = '[0-9〇零一二两三四五六七八九十百千]+';
const numericCharacters = '0-9〇零一二两三四五六七八九十百千万億亿兆点.,';
const units: Record<string, string[]> = {
  人: ['人', '个', '名', '位'], 名: ['人', '个', '名', '位'],
  冊: ['本', '册'], 個: ['个'], 歳: ['岁'],
};
const sourcePattern = new RegExp(`(?<![${numericCharacters}+\\-])(${numeral})(人|名|冊|個|歳)(以下|以上|未満)(?![のな]?わけでは|ではな|じゃな)`, 'gu');
const prefixRelations: Record<string, Relation> = {
  不超过: 'le', 不多于: 'le', 至多: 'le', 最多: 'le',
  不少于: 'ge', 不低于: 'ge', 至少: 'ge', 最少: 'ge',
  不到: 'lt', 少于: 'lt', 低于: 'lt', 超过: 'gt', 多于: 'gt', 高于: 'gt',
};
const suffixRelations: Record<string, Relation> = { 以下: 'le', 以上: 'ge', 以内: 'le', 左右: 'approx' };

/** Deliberately small domain: nonnegative integers below 10,000, without unit conversion. */
function integer(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text) < 10_000 ? Number(text) : null;
  if (/\d/.test(text) || /[百千][一二两三四五六七八九]$/.test(text)) return null;
  const digits = '零一二三四五六七八九';
  const normalized = text.replaceAll('〇', '零').replaceAll('两', '二');
  if (!/[十百千]/.test(normalized)) return Number([...normalized].map(c => digits.indexOf(c)).join(''));
  let value = 0, pending = 0, previousUnit = 10_000;
  for (const char of normalized) {
    const unit = ({ 十: 10, 百: 100, 千: 1000 } as Record<string, number>)[char];
    if (unit) {
      if (unit >= previousUnit) return null;
      value += (pending || 1) * unit;
      pending = 0;
      previousUnit = unit;
    } else pending = digits.indexOf(char);
  }
  return value + pending;
}

/** Detect only an explicit contradictory boundary, never infer an error from missing keywords.
 * Multi-quantity passages, negated comparisons and conversions remain semantic-review work.
 */
export function checkNumericBounds(source: string, translation: string): ValidationFinding[] {
  const src = source.normalize('NFKC'), zh = translation.normalize('NFKC');
  if (/ない|なかった|ではな|じゃな|とは限ら|わけでは|不是|并非|並非|未必|不能说|不能說|不一定/.test(src + zh)) return [];
  const sourceNumbers = [...src.matchAll(new RegExp(numeral, 'gu'))];
  const translatedNumbers = [...zh.matchAll(new RegExp(numeral, 'gu'))];
  if (sourceNumbers.length !== 1 || translatedNumbers.length !== 1) return [];
  const bounds = [...src.matchAll(sourcePattern)];
  if (bounds.length !== 1) return [];
  const [, number, unit, relation] = bounds[0]!;
  const expected = ({ 以下: 'le', 以上: 'ge', 未満: 'lt' } as const)[relation as '以下' | '以上' | '未満'];
  const value = integer(number!);
  if (value === null) return [];
  const prefix = Object.keys(prefixRelations).join('|');
  const suffix = Object.keys(suffixRelations).join('|');
  const targetUnit = units[unit!]!.join('|');
  const pattern = new RegExp(`(${prefix})(${numeral})(${targetUnit})(?![${numericCharacters}])|(?<![${numericCharacters}+\\-])(${numeral})(${targetUnit})(${suffix})`, 'gu');
  const matches = [...zh.matchAll(pattern)];
  if (matches.length !== 1) return [];
  const match = matches[0]!;
  const actual = match[1] ? prefixRelations[match[1]] : suffixRelations[match[6]!];
  if (integer((match[2] ?? match[4])!) !== value || actual === expected) return [];
  // Don't read a prefix in a double negative or a compound range as the full claim.
  const before = zh.slice(Math.max(0, match.index - 3), match.index);
  const after = zh.slice(match.index + match[0].length);
  if (/[不非没未]$/.test(before) || /^(以上|以下|以内|左右|不到|不止)/.test(after)) return [];
  // Endpoint wording alone is not proof of a literary mistranslation. Keep a
  // signal for context review without forcing a repair before that review runs.
  const endpointOnly = (expected === 'le' && actual === 'lt') || (expected === 'lt' && actual === 'le')
    || (expected === 'ge' && actual === 'gt');
  return [{
    code: 'NUMERIC_FORMAT', severity: endpointOnly ? 'info' : 'blocks_export',
    message: endpointOnly
      ? `数量端点措辞不同：原文“${bounds[0]![0]}”，译文“${match[0]}”；由语境审校核对是否影响实际含义，不单凭措辞要求重译`
      : `数值范围改变：原文“${bounds[0]![0]}”，译文“${match[0]}”。请核对上限、下限方向及是否擅改为约数`,
    details: { kind: 'numeric-boundary', source: bounds[0]![0], translation: match[0], expected, actual, endpointOnly },
  }];
}
