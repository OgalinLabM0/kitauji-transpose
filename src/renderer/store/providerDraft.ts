import type { ProviderSettings } from '@shared/types';
/** Explicit allowlist: API keys and any future credential fields are never serialized. */
export function providerDraftFields(p: Partial<ProviderSettings>) {
  return {
    protocol: p.protocol ?? 'chat-completions', authScheme: p.authScheme ?? 'bearer',
    baseUrl: p.baseUrl ?? '', model: p.model ?? '', judgeModel: p.judgeModel ?? '',
    temperature: p.temperature ?? 0.2, maxOutputTokens: p.maxOutputTokens ?? 8192,
    concurrency: p.concurrency ?? 3, timeoutMs: p.timeoutMs ?? 180000,
    thinkingMode: p.thinkingMode ?? 'disabled', reasoningEffort: p.reasoningEffort ?? 'low',
  };
}
