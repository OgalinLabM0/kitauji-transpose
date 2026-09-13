import { generationConstraints } from '../ai/prompts/generationConstraints';

/** A reader's interpretation is an audit hypothesis, never translation guidance. */
export function sourceRelationCheckpoints(notes: readonly {quote:string}[], source: string): string[] {
  return [...new Set(notes.map(n=>n.quote).filter(quote=>quote.length>0&&source.includes(quote)))];
}
export function sourceRelationReminder(notes: readonly {quote:string}[], source: string): string {
  const quotes=sourceRelationCheckpoints(notes,source);
  return quotes.length ? '\n【原文核对位置】'+JSON.stringify(quotes)+'\n自行结合日文上下文核对动作主体、受话人、施受方向和否定范围；不能补写未明示事实。' : '';
}

export function localSourceContext(fullSource: string, source: string) {
  const at = fullSource.indexOf(source);
  if (!source || at < 0 || at !== fullSource.lastIndexOf(source)) throw new Error('局部编辑原文范围不能唯一定位');
  return { before: fullSource.slice(0, at), after: fullSource.slice(at + source.length) };
}

/** Reading diagnostics are observations, not source-language facts. */
export function localEditorRequest(input: {
  id: string; source: string; draft: string; fullSource: string;
  issues: readonly { quote_zh: string; reason: string; constraint?: string }[];
  glossary: readonly { source: string; translation: string | null }[];
  relations?: readonly { quote: string; reading: string; uncertain: boolean }[];
}): string {
  return JSON.stringify({
    glossary: input.glossary,
    source_context: localSourceContext(input.fullSource, input.source),
    expression_issues: input.issues.filter(i => input.draft.includes(i.quote_zh)).map(({ quote_zh, reason }) => ({ quote_zh, reason })),
    source_relation_quotes: sourceRelationCheckpoints(input.relations ?? [],input.source),
  }) + '\n【当前候选局部读感编辑】局部中文修复只修任务块draft的具体表达问题，对照source保留事实、语气和全部标点。source_context只帮助理解指代，不属于输出范围，其余正文由程序原样保留。读感诊断只看过中文，不能据此决定日文含义；对照原文引句核对动作主体、受话人、施受方向和否定范围。\n【任务块】'
    + JSON.stringify({ items: [{ id: input.id, source: input.source, draft: input.draft, source_constraints: generationConstraints(input.source) }] });
}
