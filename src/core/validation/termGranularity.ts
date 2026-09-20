import { HONORIFIC_SUFFIX_RE } from '../db/specialNames';

export const TERM_GRANULARITY_VERSION = 'kana-components-v2';
export function isHanOnlyTerm(word: string): boolean {
  const plain = word.replace(/[\p{P}\p{S}\s]/gu, '');
  // Grammatical hiragana does not turn an otherwise kanji expression into a
  // foreign-name candidate (e.g. 漢字の名称). Pure hiragana nicknames remain eligible.
  return /\p{Script=Han}/u.test(plain) && !/[\p{Script=Katakana}\p{Script=Latin}]/u.test(plain);
}
export const unwrappedTerm = (word: string) => word.replace(/^[《〈「『【（("“‘]+|[》〉」』】）)"”’]+$/gu, '');
export const isOrdinaryRoleTerm = (word: string) => ['アシスタント', 'スタッフ', 'マネージャー', 'リーダー', 'メンバー'].includes(unwrappedTerm(word));
export interface TermComponent { term_jp: string; term_type: string }
interface ExtractedTerm extends TermComponent {
  sense_identity: string; split_suggestion: string | null;
  components: TermComponent[]; split_preserves_meaning: boolean; split_reason: string;
}
export interface TermSplitReceipt { version: string; parent: string; parts: string[]; reason: string }

/** The explicitly requested company suffix is separable. A personal-name middle
 * dot or an arbitrary title separator does not authorize splitting. */
export function companyTermParts(word: string, kind: string): TermComponent[] | null {
  const bare = unwrappedTerm(word);
  if (bare !== word) return [{ term_jp: bare, term_type: kind }];
  if (kind === 'person' && /^[ァ-ヺー]+(?:・[ァ-ヺー]+)+$/u.test(word)) return word.split('・').map(term_jp => ({ term_jp, term_type: kind }));
  const shop = /^(?:高級|一般|普通)?([ァ-ヺー]+)(?:料理店|専門店|用品店)$/u.exec(word);
  if (shop) return [{ term_jp: shop[1]!, term_type: 'concept' }];
  if (kind !== 'organization') return null;
  const match = /^(.+)・(プロダクション)$/u.exec(word);
  return match ? [{ term_jp: match[1]!, term_type: 'organization' }, { term_jp: match[2]!, term_type: 'concept' }] : null;
}

export function normalizeTermGranularity<T extends ExtractedTerm>(term: T): T[] {
  const base = ['person', 'honorific'].includes(term.term_type) ? term.term_jp.replace(HONORIFIC_SUFFIX_RE, '') : term.term_jp;
  if (!base || isHanOnlyTerm(base) || isOrdinaryRoleTerm(base)) return [];
  const forced = companyTermParts(base, term.term_type);
  // Extraction owns literal candidates, not semantic decomposition. Optional
  // model split hints are never authoritative; the independent contextual
  // selector receives the intact candidate and its source before proposals.
  const pieces = forced;
  if (!pieces) return [{ ...term, term_jp: base, components: [], split_preserves_meaning: false, split_reason: '', split_suggestion: null }];
  const kept = pieces.filter(p => !isHanOnlyTerm(p.term_jp) && !isOrdinaryRoleTerm(p.term_jp));
  const receipt: TermSplitReceipt = { version: TERM_GRANULARITY_VERSION, parent: term.term_jp, parts: kept.map(p => p.term_jp), reason: '去除外层符号及普通搭配，姓名或组织名按组成部分分别确认' };
  return kept.map(p => ({ ...term, term_jp: p.term_jp, term_type: p.term_type as T['term_type'], sense_identity: '', components: [], split_suggestion: JSON.stringify(receipt) }));
}

export function termSplitReceipt(raw: string | null): TermSplitReceipt | null {
  if (!raw) return null;
  try { const p = JSON.parse(raw) as TermSplitReceipt;
    return p.version === TERM_GRANULARITY_VERSION && typeof p.parent === 'string' && Array.isArray(p.parts) && p.parts.length > 0 && p.parts.every(v => typeof v === 'string' && v.length > 0) && typeof p.reason === 'string' ? p : null;
  } catch { return null; }
}
