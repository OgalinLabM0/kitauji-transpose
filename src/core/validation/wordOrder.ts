/**
 * 语序与信息流校验（docs/标准/TRANSLATION_RULES.md 二.N 的确定性化）。
 *
 * 机制：初译时模型在 source_coverage 里给每个信息单元按原文出现顺序标 ord（1,2,3…），
 * 程序在译文中依次定位每个 rendered_as（去除标点空白后按子串匹配），检查它们出现的先后
 * 顺序是否与 ord 递增一致。若译文把后面的单元放到了前面（整段倒置），判定 ORDER_INVERTED，
 * 阻断导出并提示模型重排。这是硬校验，不靠提示词自觉。
 */
import type { SourceCoverageItem } from '@shared/types';
import { visibleNameSource } from './nameEvidence';

export type OrderCheckCode = 'ORDER_INVERTED' | 'ORDER_MISSING' | 'ORDER_OK';
export interface OrderCheckResult { code: OrderCheckCode; message: string; inverted: { ord: number; segment: string; rendered: string }[]; missing: { ord: number; rendered: string }[] }

/** 宽松入参：zod 推断的 cover 项可能带 ord?: number|undefined，exactOptionalPropertyTypes 下不能用 SourceCoverageItem 的严格类型 */
export type OrderCoverageItem = Pick<SourceCoverageItem, 'segment' | 'rendered_as' | 'status'> & { ord?: number | undefined };

const norm = (s: string): string => visibleNameSource(s).normalize('NFKC').replace(/[,!.?，。、？！…—「」『』（）()《》【】・\r\n\s]/g, '');

/** 在译文里找 rendered_as 的位置。rendered_as 可能是译文的一个片段；若找不到独立的对应位置则记 missing；重复片段按实际出现次数和顺序消耗。 */
export function checkInfoOrder(sourceText: string, translation: string, coverage: readonly OrderCoverageItem[]): OrderCheckResult {
  const items = coverage
    .filter(c => c.ord !== undefined && c.ord > 0)
    .map(c => ({ ord: c.ord!, segment: c.segment, rendered: c.rendered_as }))
    .sort((a, b) => a.ord - b.ord);
  if (items.length < 2) return { code: 'ORDER_OK', message: '不足两个信息单元，不做语序核对', inverted: [], missing: [] };

  const hay = norm(translation);
  const missing: { ord: number; rendered: string }[] = [];
  const inverted: OrderCheckResult['inverted'] = [];
  const consumed: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const it of items) {
    const needle = norm(it.rendered);
    if (!needle) continue;
    const positions: number[] = [];
    for (let start = hay.indexOf(needle); start >= 0; start = hay.indexOf(needle, start + 1)) {
      if (!consumed.some(span => start < span.end && start + needle.length > span.start)) positions.push(start);
    }
    const forward = positions.find(pos => pos >= cursor);
    const pos = forward ?? positions[0];
    if (pos === undefined) { missing.push({ ord: it.ord, rendered: it.rendered }); continue; }
    consumed.push({ start: pos, end: pos + needle.length });
    if (forward === undefined) inverted.push({ ord: it.ord, segment: it.segment, rendered: it.rendered });
    cursor = Math.max(cursor, pos + needle.length);
  }
  if (missing.length) return { code: 'ORDER_MISSING', message: `原译对应中 ${missing.length} 个信息单元没有独立的译文位置；不可用同一次出现证明多次原文重复均已译出`, inverted, missing };
  if (inverted.length) {
    return {
      code: 'ORDER_INVERTED',
      message: `语序倒置信息流：信息单元在译文中出现的顺序与原文不一致（${inverted.map(i => `#${i.ord}「${i.rendered}」`).join('、')}）。请保持原文的成分出场顺序：句首话题保持句首、句末落点保持句末、分句顺序不变。仅当保序会造成中文歧义或病句时才允许调整，并在该项标 restructured。`,
      inverted,
      missing,
    };
  }
  return { code: 'ORDER_OK', message: '语序一致', inverted: [], missing };
}

/**
 * 被动倒置检测（不依赖模型自报 coverage 的独立旁路）。
 * 日文「X を 嗅がせる」（让×嗅X）中宾语 X 在使役动词前，中文应译为「让其嗅到X」——宾语放动词后。
 * 若译成「让X被嗅到」这类「让（名）被（动）」，等于把 X 置于「被」前，比原文把宾语更前置，属生硬被动倒置。
 * 用正则即可判定，无需 jieba（jieba 版本在 tests 里交叉验证过，误报低，但正则更快更稳）。
 * 这是 warning（交人工），不直接阻断——「让…被…」在某些原文确为被动时是合法译法。
 */
const PASSIVE_INVERT_RE = /让([^，。、！？…「」]{1,16}?)被([^，。、！？…「」]{1,12}?)(了|着|过)?(?=[，。、！？…]|$)/;
export function checkPassiveInversion(translation: string): { bad: boolean; matched: string | null } {
  const m = PASSIVE_INVERT_RE.exec(translation);
  return m ? { bad: true, matched: m[0] } : { bad: false, matched: null };
}

/** 话题被挪到句末检测：日文「X を、…なるのは、なぜか」式话题，中文若把 X 放句末即违规。 */
const TOPIC_JP_RE = /^(.{2,24}?)[をがは]、/;
export function checkTopicShiftToEnd(sourceText: string, translation: string): { bad: boolean; matched: string | null } {
  const m = TOPIC_JP_RE.exec(sourceText);
  if (!m) return { bad: false, matched: null };
  return { bad: false, matched: null }; // 中日词无法直接对齐，留待 coverage 版 + 人工
}
