import { type AiClient, type TranslationItem, translationItemSchema, type ProtocolResult } from '@core/ai';
import { checkInfoOrder } from '@core/validation/wordOrder';
import { visibleNameSource } from '../validation/nameEvidence';

export function parseAlignment(text: string, source: string, translation: string): ProtocolResult<TranslationItem['source_coverage']> {
  try {
    // Visible information is aligned; raw markers remain in manuscript storage
    // and provenance. Atomic/malformed nodes remain explicit boundaries.
    source=visibleNameSource(source);
    translation=visibleNameSource(translation);
    const raw = JSON.parse(text);
    if (!Array.isArray(raw?.source_coverage) || !raw.source_coverage.length) throw new Error('缺少原译对应信息');
    const coverage = translationItemSchema.shape.source_coverage.parse(raw.source_coverage).map(c=>({...c,segment:visibleNameSource(c.segment),rendered_as:visibleNameSource(c.rendered_as)}));
    const onlyPunctuation = (s: string) => /^[\s「」『』。！？、，,.!?]*$/u.test(s);
    let sourceEnd = 0;
    for (const [i, c] of coverage.entries()) {
      if (c.ord !== i + 1 || !c.segment || !source.includes(c.segment) || (c.status !== 'uncertain' && (!c.rendered_as || !translation.includes(c.rendered_as)))) throw new Error('原译对应引用或编号不正确');
      const start = source.indexOf(c.segment, sourceEnd);
      if (start < 0 || !onlyPunctuation(source.slice(sourceEnd, start))) throw new Error('原译对应未覆盖连续原文信息');
      sourceEnd = start + c.segment.length;
    }
    if (!onlyPunctuation(source.slice(sourceEnd))) throw new Error('原译对应漏掉了原文信息');
    if (coverage.every(c => c.status !== 'uncertain') && checkInfoOrder(source, translation, coverage).code === 'ORDER_MISSING') {
      throw new Error('对应表重复占用了同一处中文：rendered_as 不能互相重叠。将共用同一中文表达的相邻原文片段合并为一个完整信息单元，保持原文连续覆盖；不要改写译文。');
    }
    return { ok: true, value: coverage };
  } catch (e) { return { ok: false, error: { code: 'INVALID_SHAPE', message: (e as Error).message } }; }
}


export async function alignSource(ai: AiClient, paragraphId: string, source: string, translation: string, signal?: AbortSignal, refinement?: string) {
  return ai.structured({ workstation: 'source-aligner', user: JSON.stringify({ source:visibleNameSource(source), translation:visibleNameSource(translation), ...(refinement ? { refinement } : {}) }), paragraphId, ...(signal ? { signal } : {}), parseRetries: 1 }, text => parseAlignment(text, source, translation));
}
