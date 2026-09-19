import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AiClient, ProtocolResult } from '@core/ai';
import {containsVisibleQuote} from '../validation/nameEvidence';

export interface RepairIssue { id: string; type: string; description: string; source_quote: string | null; target_quote: string | null }

/** Convert a concrete naturalness diagnosis into a stable, resolution-scoped issue. */
export function naturalnessRepairIssues(paragraphId: string, issues: readonly { quote_zh: string; reason: string }[]): RepairIssue[] {
  const seen = new Set<string>();
  return issues.flatMap(issue => {
    const key = JSON.stringify([issue.quote_zh, issue.reason]);
    if (seen.has(key)) return [];
    seen.add(key);
    const digest = createHash('sha256').update(`${paragraphId}\0${key}`).digest('hex').slice(0, 16);
    return [{ id: `naturalness:${paragraphId}:${digest}`, type: 'NATURALNESS_UNRESOLVED', description: issue.reason, source_quote: null, target_quote: issue.quote_zh }];
  });
}
const schema = z.object({ items: z.array(z.object({ id: z.string(), decision: z.enum(['resolved', 'not_applicable', 'unresolved', 'uncertain']), source_quote: z.string(), target_quote: z.string(), reason: z.string().trim().min(1).max(600) }).strict()).min(1).max(3) }).strict();
export function parseRepairResolution(text: string, source: string, after: string, issues: readonly RepairIssue[]): ProtocolResult<z.infer<typeof schema>> {
  try {
    const value = schema.parse(JSON.parse(text));
    if (value.items.length !== issues.length || new Set(value.items.map(i => i.id)).size !== issues.length) throw new Error('修复验收问题覆盖不完整');
    for (const item of value.items) {
      const issue = issues.find(i => i.id === item.id);
      if (!issue) throw new Error('修复验收返回未知问题');
      if (!containsVisibleQuote(source,item.source_quote)) throw new Error('修复验收原文引文无效');
      if (item.target_quote.trim() ? !containsVisibleQuote(after,item.target_quote) : !(issue.target_quote && !containsVisibleQuote(after,issue.target_quote) && /addition/.test(issue.type))) throw new Error('修复验收候选引文无效');
    }
    return { ok: true, value };
  } catch (error) { return { ok: false, error: { code: 'INVALID_SHAPE', message: (error as Error).message } }; }
}

export class RepairResolutionUnresolved extends Error {
  constructor(readonly receipt: { aiCallId: string; items: z.infer<typeof schema>['items'] }) {
    super('指定问题尚未解决或依据不足，保留原稿');
    this.name = 'RepairResolutionUnresolved';
  }
}

export async function reviewRepairResolution(ai: AiClient, paragraphId: string, source: string, before: string, after: string, issues: readonly RepairIssue[], signal?: AbortSignal, sourceContext: readonly { id: string; source: string }[] = []) {
  const receipts: { aiCallId: string; items: z.infer<typeof schema>['items'] }[] = [];
  for (let offset = 0; offset < issues.length; offset += 3) {
    const batch = issues.slice(offset, offset + 3);
    const result = await ai.structured({ workstation: 'repair-resolution-reviewer', paragraphId, user: JSON.stringify({ source, before, after, issues: batch, source_context_read_only: sourceContext }), parseRetries: 1, maxOutputTokens: 1800, ...(signal ? { signal } : {}) }, text => parseRepairResolution(text, source, after, batch));
    if (result.value.items.some(i => i.decision === 'unresolved' || i.decision === 'uncertain')) throw new RepairResolutionUnresolved({ aiCallId: result.aiCallId, items: result.value.items });
    receipts.push({ aiCallId: result.aiCallId, items: result.value.items });
  }
  return receipts;
}
