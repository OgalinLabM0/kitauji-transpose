import { parseTranslation, PROMPT_VERSION, systemPromptFor, type AiClient, type TranslationItem } from '@core/ai';
import type { ProjectStore } from '@core/db';
import { AUDIT_VERSION } from './auditReceipts';
import { openLongParagraphCheckpoint } from './longParagraphCheckpoint';
import { validateMarkers, type InlineTemplate } from '@core/epub/blocks';
import { generationConstraints } from '../ai/prompts/generationConstraints';

/** Split only complete top-level sentences; never cut quotations, parentheses or inline wrappers. */
export function longParagraphParts(source: string, template: InlineTemplate, target = 900, minimumLength = 1200): string[] {
  if (source.length <= minimumLength || !validateMarkers(source, template).ok) return [source];
  const pairs: Record<string,string> = { '「':'」', '『':'』', '（':'）', '(' : ')', '【':'】', '《':'》', '〈':'〉', '［':'］', '[':']' };
  const quoted: string[] = [], markers: number[] = [], ends: number[] = [];
  const wrapping = new Set(template.markers.filter(m => m.kind !== 'atomic').map(m => m.id));
  let asciiQuote = false;
  for (const m of source.matchAll(/⟦\/?\d+⟧|[\s\S]/gu)) {
    const token = m[0];
    if (token.startsWith('⟦')) {
      const id = Number(token.replace(/\D/g, ''));
      if (token.startsWith('⟦/')) markers.pop(); else if (wrapping.has(id)) markers.push(id);
      continue;
    }
    if (token === '"') asciiQuote = !asciiQuote;
    else if (!asciiQuote) {
      if (pairs[token]) quoted.push(pairs[token]!);
      else if (token === quoted.at(-1)) quoted.pop();
    }
    const end = m.index + token.length;
    // Preserve a sentence across layout newlines; only actual terminal punctuation splits it.
    if (!asciiQuote && !quoted.length && !markers.length && /[。！？!?]/u.test(token) && !/[。！？!?…‥]/u.test(source[end] ?? '')) ends.push(end);
  }
  // Unbalanced literary punctuation is ambiguous: use the original whole paragraph.
  if (quoted.length || asciiQuote || markers.length) return [source];
  if (ends.at(-1) !== source.length) ends.push(source.length);
  const parts: string[] = []; let start = 0, current = '';
  for (const end of ends) {
    const sentence = source.slice(start, end); start = end;
    if (current.trim() && sentence.trim() && current.length + sentence.length > target) { parts.push(current); current = ''; }
    current += sentence;
  }
  if (current) parts.push(current);
  return parts;
}

export async function draftLongParagraph(ai: AiClient, args: {
  paragraphId: string; parts: string[]; context: string; diagnostic?: string;
  /** The caller's library, never a global cache. Omit only for non-persistent standalone callers. */
  store?: ProjectStore;
  signal: AbortSignal; check: () => void | Promise<void>; onPart: (index: number, total: number, callId: string) => void;
}): Promise<{ value: { items: TranslationItem[] }; aiCallId: string }> {
  const check = async () => { args.signal.throwIfAborted(); await args.check(); args.signal.throwIfAborted(); };
  await check();
  const constraints = args.parts.map(generationConstraints);
  const checkpoint = args.store ? openLongParagraphCheckpoint(args.store, {
    paragraphId: args.paragraphId, parts: args.parts, context: args.context, diagnostic: args.diagnostic ?? '',
    rulesFingerprint: JSON.stringify(['long-paragraph-v3-source-constraints', PROMPT_VERSION, AUDIT_VERSION, systemPromptFor('faithful-translator'), constraints]),
  }) : undefined;
  const items: TranslationItem[] = []; let aiCallId = '';
  for (const [index, source] of args.parts.entries()) {
    await check(); checkpoint?.assertCurrent();
    const cached = checkpoint?.completed[index];
    if (cached) {
      items.push(cached.item); aiCallId = cached.aiCallId;
      args.onPart(index + 1, args.parts.length, aiCallId);
      continue;
    }
    const neighbors = { previous_source: args.parts[index - 1] ?? '', next_source: args.parts[index + 1] ?? '' };
    const result = await ai.structured({ workstation:'faithful-translator', paragraphId:args.paragraphId, signal:args.signal, parseRetries:1,
      user:`${args.context}\n\n【长段第${index + 1}/${args.parts.length}部分】只译当前完整句群；程序按顺序合回一个段落。不要增加段首介绍、过渡解释或总结。\n【同段相邻原文，仅供指代，不翻译】${JSON.stringify(neighbors)}\n【本次任务块】\n${JSON.stringify({items:[{id:args.paragraphId,source,source_constraints:constraints[index]}]})}${args.diagnostic ?? ''}`,
    }, raw => parseTranslation(raw, [args.paragraphId]));
    await check(); checkpoint?.assertCurrent();
    if (!result.value.items[0]?.translation.trim()) throw new Error('长段片段译文为空');
    checkpoint?.append(result.value.items[0], result.aiCallId);
    items.push(result.value.items[0]); aiCallId = result.aiCallId;
    args.onPart(index + 1, args.parts.length, aiCallId);
  }
  await check(); checkpoint?.assertCurrent();
  if (!items.length) throw new Error('长段缺少初译片段');
  // Segment coverage/ratings cannot certify the reconstructed paragraph.
  return { aiCallId, value:{items:[{id:args.paragraphId, translation:items.map(i => i.translation).join(''), source_coverage:[], flags:items.flatMap(i => i.flags)}]} };
}
