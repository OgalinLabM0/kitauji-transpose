import { generationConstraints } from '../ai/prompts/generationConstraints';
import {syntaxHintsFor} from '../ai/prompts/syntaxHints';

/** A bounded punctuation edit, not a new interpretation of the paragraph.
 * The returned candidate still goes through every ordinary quality check. */
export function punctuationRepairRequest(input: {
  id: string; source: string; draft: string;
  glossary: readonly { source: string; translation: string | null }[];
}): string {
  return '【标点与句法修复】对照 source 修正 draft 的标点及相邻句法。保留原译的人名、称呼、语癖、事实和语气，不另作整段润色。标点必须依原文顺序保留：话题后的读点也不能遗漏，句号不能换成逗号。调整文字使停顿自然，不堆叠标点，不补解释。\n'
    + JSON.stringify({ glossary: input.glossary, ...(syntaxHintsFor(input.source).length?{syntax_hints:syntaxHintsFor(input.source)}:{}) })
    + '\n【任务块】' + JSON.stringify({ items: [{ id: input.id, source: input.source, draft: input.draft, source_constraints: generationConstraints(input.source) }] });
}
