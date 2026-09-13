import { z } from 'zod';
import type { AiClient, ProtocolResult } from '@core/ai';
import type { RepairIssue } from './repairResolution';
import { containsVisibleQuote } from '../validation/nameEvidence';
const schema = z.object({ decision: z.enum(['retain','revise','uncertain']), source_quote: z.string(), target_quote: z.string(), reason: z.string().trim().min(1).max(600), direction: z.string().max(400) }).strict();
export function parseDispute(text: string, source: string, translation: string): ProtocolResult<z.infer<typeof schema>> {
  try {
    const value = schema.parse(JSON.parse(text));
    if (!containsVisibleQuote(source,value.source_quote) || !containsVisibleQuote(translation,value.target_quote)) throw new Error('争议复核缺少真实原译文引文');
    if (value.decision === 'revise' ? !value.direction.trim() : !!value.direction.trim()) throw new Error('争议复核修复方向与结论不一致');
    return {ok:true,value};
  } catch (error) { return {ok:false,error:{code:'INVALID_SHAPE',message:(error as Error).message}}; }
}
export async function reviewDisputes(ai: AiClient, paragraphId: string, source: string, translation: string, issues: readonly RepairIssue[], context: readonly {id:string;source:string}[], signal?: AbortSignal) {
  const results: {issueId:string;aiCallId:string;verdict:z.infer<typeof schema>}[] = [];
  if (!issues.length || issues.length > 8) throw new Error('争议问题范围过大或缺少具体诊断，请先分项核对');
  for (const issue of issues) {
    const r = await ai.structured({workstation:'dispute-reviewer',paragraphId,user:JSON.stringify({source,translation,issue,context,
      context_task:'先核对context里实际发生的动作、发言及相互关系，再判断本句。词典列有多个义项不等于原作刻意保留了这些义项；有上下文依据的正常选义不自动是增译。声称仍有歧义时，说明不同解读各自得到哪些实际语境支持；只有词典可能性不是另一解读的证据。确实缺少语境或多种解读均有依据时保留uncertain，不能凭常见程度选择。reason写具体语境依据，不只复述issue。'}),parseRetries:1,maxOutputTokens:1400,...(signal?{signal}:{})},text=>parseDispute(text,source,translation));
    results.push({issueId:issue.id,aiCallId:r.aiCallId,verdict:r.value});
    if (r.value.decision === 'uncertain') break;
  }
  return results;
}
