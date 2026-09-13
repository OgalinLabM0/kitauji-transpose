import type { AiClient, ProtocolResult } from '@core/ai';
import type { WorkstationId } from '@shared/types';
import { punctuationSequence } from './rules';

const workstation: WorkstationId = 'comma-location-reviewer';
function validBoundary(text: string, index: number): boolean {
  const before = text.charCodeAt(index - 1), after = text.charCodeAt(index);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) return false;
  return !/[\p{P}\s]/u.test(text[index - 1] ?? '') && !/[\p{P}\s]/u.test(text[index] ?? '');
}

export type CommaLocationResult = { item: string; prefix: string; aiCallId: string };

/** Proposes exactly one insertion. This is never an alignment or acceptance proof. */
export async function locateUniqueComma(source: string, draft: string, ai: AiClient, paragraphId: string, signal?: AbortSignal): Promise<CommaLocationResult | null> {
  if (source.length > 1500 || draft.length > 500 || /[⟦⟧]/u.test(source) || /[⟦⟧]/u.test(draft)) return null;
  const src = punctuationSequence(source), out = punctuationSequence(draft);
  // Adjacent comma tokens in this punctuation-only sequence are indistinguishable.
  // Require a single-character deficit, not a uniquely numbered source comma.
  // The model proposes the Chinese boundary; the caller must verify the full text.
  if (src.length !== out.length + 1 || !src.some((ch, i) =>
    ch === ',' && src.slice(0, i).concat(src.slice(i + 1)).join('\0') === out.join('\0'))) return null;
  const r = await ai.structured({ workstation, paragraphId, user: JSON.stringify({ source, draft }), maxOutputTokens: 1024, parseRetries: 0, ...(signal ? { signal } : {}) }, (text: string): ProtocolResult<{ prefix: string | null }> => {
    try {
      const value = JSON.parse(text) as unknown;
      if (!value || Array.isArray(value) || typeof value !== 'object') return { ok: false, error: { code: 'INVALID_SHAPE', message: 'invalid prefix' } };
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'prefix') || (record.prefix !== null && typeof record.prefix !== 'string')) return { ok: false, error: { code: 'INVALID_SHAPE', message: 'invalid prefix' } };
      return { ok: true, value: { prefix: record.prefix as string | null } };
    } catch { return { ok: false, error: { code: 'INVALID_JSON', message: 'invalid JSON' } }; }
  });
  if (r.value.prefix === null || r.value.prefix.length === 0 || r.value.prefix.length === draft.length || !draft.startsWith(r.value.prefix) || !validBoundary(draft, r.value.prefix.length)) return null;
  const item = `${r.value.prefix}，${draft.slice(r.value.prefix.length)}`;
  return punctuationSequence(item).join('\u0000') === src.join('\u0000') ? { item, prefix: r.value.prefix, aiCallId: r.aiCallId } : null;
}
