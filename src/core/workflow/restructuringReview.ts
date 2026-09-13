import type { AiClient, ProtocolResult } from '@core/ai';

export interface RestructuringVerdict { decision: 'necessary' | 'unnecessary' | 'uncertain'; evidence_jp: string; evidence_zh: string; reason: string }
export function parseRestructuring(text: string, source: string, translation: string): ProtocolResult<RestructuringVerdict> {
  try {
    const value = JSON.parse(text) as RestructuringVerdict;
    if (!value || !['necessary', 'unnecessary', 'uncertain'].includes(value.decision) || typeof value.reason !== 'string' || !value.reason.trim() || typeof value.evidence_jp !== 'string' || typeof value.evidence_zh !== 'string') throw new Error('必要重构审核缺少明确结论或理由');
    if (!value.evidence_jp.trim() || !value.evidence_zh.trim() || !source.includes(value.evidence_jp) || !translation.includes(value.evidence_zh)) throw new Error('必要重构审核必须精确引用当前原文与译文');
    return { ok: true, value };
  } catch (e) { return { ok: false, error: { code: 'INVALID_SHAPE', message: (e as Error).message } }; }
}

export async function reviewRestructuring(ai: AiClient, paragraphId: string, source: string, translation: string, signal?: AbortSignal) {
  return ai.structured({ workstation: 'restructuring-reviewer', paragraphId, ...(signal ? { signal } : {}),
    user: JSON.stringify({ source, translation }), parseRetries: 1,
  }, text => parseRestructuring(text, source, translation));
}
