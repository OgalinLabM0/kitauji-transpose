export interface RepairSpan { source: string; draft: string; start: number; end: number }
export const SYNTAX_RECOVERY_INSTRUCTION = '【句法重译】只重新翻译任务块的 source，使用自然中文表达相同内容。expression_constraints是先前发现的表达问题，仅作核对线索，不是新增事实。修正标点时也要解决这些句法问题。原文表达动作的方式或伴随状态时，可改用自然的状语短语，不要把两个谓语挤接或只在中间硬加“地”。保留原文的标点、主体省略、否定、事实与语气，不补解释。只返回任务块范围内的正文。';

/** Continue the same local edit only while everything outside it is unchanged. */
export function continueRepairSpan(original: string, current: string, span: RepairSpan, quotes: readonly string[]): RepairSpan | null {
  const prefix = original.slice(0, span.start), suffix = original.slice(span.end);
  if (!current.startsWith(prefix) || !current.endsWith(suffix) || current.length <= prefix.length + suffix.length) return null;
  const end = current.length - suffix.length, draft = current.slice(prefix.length, end);
  if (quotes.some(q => !q || !draft.includes(q))) return null;
  return { source: span.source, draft, start: prefix.length, end };
}

/** Use an existing unique alignment span; never guess where a repeated quote belongs. */
export function selectRepairSpan(source: string, draft: string, coverage: unknown, quotes: readonly string[]): RepairSpan | null {
  if (!Array.isArray(coverage) || !quotes.length || quotes.some(q => !q || draft.indexOf(q) < 0 || draft.indexOf(q) !== draft.lastIndexOf(q))) return null;
  const options: RepairSpan[] = [];
  for (const row of coverage) {
    if (!row || !['covered', 'restructured'].includes(row.status) || typeof row.segment !== 'string' || typeof row.rendered_as !== 'string') continue;
    const target = row.rendered_as, segment = row.segment;
    if (!target || !segment || !quotes.every(q => target.includes(q))) continue;
    const start = draft.indexOf(target), at = source.indexOf(segment);
    if (start < 0 || start !== draft.lastIndexOf(target) || at < 0 || at !== source.lastIndexOf(segment)) continue;
    options.push({ source: segment, draft: target, start, end: start + target.length });
  }
  return options.sort((a, b) => a.draft.length - b.draft.length)[0] ?? null;
}
