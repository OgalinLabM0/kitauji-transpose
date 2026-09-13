/**
 * 供应商适配：把统一请求映射到 OpenAI 兼容 chat-completions、Responses API、Anthropic Messages。
 * 完成状态统一校验：截断（length / max_tokens / incomplete）视为失败，不把半截 JSON 交给解析层。
 */
import type { ApiProtocol } from '@shared/types';
import { withExperimentGuard } from '../experimentGuard';

export interface ProviderConfig {
  baseUrl: string; protocol: ApiProtocol; model: string; apiKey: string;
  authScheme: 'bearer' | 'x-api-key' | 'none';
  temperature: number; maxOutputTokens: number; timeoutMs: number;
  thinkingMode: 'auto' | 'enabled' | 'disabled';
  /** 思考强度；DeepSeek/OpenAI 兼容用顶层 reasoning_effort，Responses 用 reasoning.effort，Anthropic 映射为 budget */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  /** 每 1M token 价格（USD），用于费用估算；未知为 null */
  pricing?: { input: number; output: number } | null;
}
/** Internal per-attempt accounting; never serialized or logged. */
export interface ExperimentAttempt {
  /** Synchronous admission immediately before fetch. Throwing prevents sending. */
  onSendStart: () => void;
  /** Actual received usage, retained even if the ledger's final write fails. */
  usage?: { inputTokens: number | null; outputTokens: number | null };
}
export interface ChatRequest { system: string; user: string; jsonMode?: boolean; signal?: AbortSignal; maxOutputTokens?: number; temperature?: number; /** Internal evaluation hook; never serialized or logged. */ validateExperimentResponse?: (text: string) => boolean; experimentAttempt?: ExperimentAttempt }
export interface ChatResponse {
  text: string; finishReason: string | null; truncated: boolean;
  inputTokens: number | null; outputTokens: number | null; raw?: unknown;
}

export class ProviderError extends Error {
  retryAfterMs?: number;
  usage?: { inputTokens: number | null; outputTokens: number | null };
  constructor(readonly kind: 'http' | 'network' | 'timeout' | 'abort' | 'shape' | 'truncated' | 'config' | 'incompatible', message: string, readonly status?: number, readonly retryable = kind !== 'config' && kind !== 'abort' && kind !== 'incompatible') {
    super(message); this.name = 'ProviderError';
  }
}

const joinUrl = (base: string, path: string): string => `${base.replace(/\/+$/, '')}${path}`;

function headers(cfg: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.authScheme === 'bearer' && cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.authScheme === 'x-api-key' && cfg.apiKey) h['x-api-key'] = cfg.apiKey;
  if (cfg.protocol === 'anthropic-messages') h['anthropic-version'] = '2023-06-01';
  return h;
}

function endpoint(cfg: ProviderConfig): string {
  const b = cfg.baseUrl.trim();
  if (/\/(chat\/completions|responses|messages)\/?$/.test(b)) return b;
  switch (cfg.protocol) {
    case 'chat-completions': return joinUrl(b, '/chat/completions');
    case 'responses': return joinUrl(b, '/responses');
    case 'anthropic-messages': return joinUrl(b, '/messages');
  }
}

function body(cfg: ProviderConfig, req: ChatRequest): Record<string, unknown> {
  const maxTokens = req.maxOutputTokens ?? cfg.maxOutputTokens;
  const temperature = req.temperature ?? cfg.temperature;
  switch (cfg.protocol) {
    case 'chat-completions': {
      const b: Record<string, unknown> = {
        model: cfg.model, temperature, max_tokens: maxTokens, stream: false,
        messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
      };
      if (req.jsonMode) b.response_format = { type: 'json_object' };
      if (cfg.thinkingMode !== 'auto') b.thinking = { type: cfg.thinkingMode };
      if (cfg.thinkingMode === 'enabled' && cfg.reasoningEffort) b.reasoning_effort = cfg.reasoningEffort;
      return b;
    }
    case 'responses': {
      const b: Record<string, unknown> = {
        model: cfg.model, temperature, max_output_tokens: maxTokens, store: false,
        instructions: req.system, input: [{ role: 'user', content: [{ type: 'input_text', text: req.user }] }],
      };
      if (req.jsonMode) b.text = { format: { type: 'json_object' } };
      if (cfg.thinkingMode === 'enabled') b.reasoning = { effort: cfg.reasoningEffort ?? 'medium' };
      return b;
    }
    case 'anthropic-messages': {
      const b: Record<string, unknown> = {
        model: cfg.model, max_tokens: maxTokens, system: req.system,
        messages: [{ role: 'user', content: req.user }],
      };
      if (cfg.thinkingMode !== 'enabled') b.temperature = temperature;
      if (cfg.thinkingMode === 'enabled') { const ratio = cfg.reasoningEffort === 'low' ? 0.2 : (cfg.reasoningEffort === 'high' || cfg.reasoningEffort === 'max') ? 0.75 : 0.5; b.thinking = { type: 'enabled', budget_tokens: Math.max(1024, Math.floor(maxTokens * ratio)) }; }
      return b;
    }
  }
}

// Server metadata is untrusted text, not a safe diagnostic. Persist only these
// protocol codes; unexpected values become one fixed label, including objects.
const FINISH_REASONS = new Set([
  'stop', 'length', 'content_filter', 'tool_calls', 'function_call',
  'completed', 'incomplete', 'in_progress', 'failed', 'cancelled', 'queued',
  'incomplete:max_output_tokens', 'incomplete:content_filter', 'incomplete:unknown',
  'end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded',
]);
export function normalizeFinishReason(value: unknown): string | null {
  return value == null ? null : typeof value === 'string' && FINISH_REASONS.has(value) ? value : 'unknown';
}

function parseResponse(cfg: ProviderConfig, json: unknown, isolated: boolean): ChatResponse {
  const o = json as Record<string, unknown>;
  const usage = (o.usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
  switch (cfg.protocol) {
    case 'chat-completions': {
      const choice = ((o.choices as unknown[]) ?? [])[0] as Record<string, unknown> | undefined;
      const msg = (choice?.message ?? {}) as Record<string, unknown>;
      const finish = normalizeFinishReason(choice?.finish_reason);
      const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
      // Check incompatibility before parsing content or treating it as truncation.
      // Retain only a fixed diagnostic and usage, never the reasoning text.
      if (isolated && cfg.thinkingMode === 'disabled' && reasoning.length > 0) {
        const error = new ProviderError('incompatible', '隔离评测接口与关闭思考要求不兼容，已停止实验（响应内容已隐藏）');
        error.usage = { inputTokens: num(usage.prompt_tokens), outputTokens: num(usage.completion_tokens) };
        throw error;
      }
      const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? (msg.content as { text?: string }[]).map(p => p.text ?? '').join('') : '';
      // 非实验请求保留原截断语义：思考与正文共用预算，空正文加思考输出按截断重试。
      const truncated = finish === 'length' || finish === 'content_filter' || (text.trim() === '' && reasoning.length > 0);
      return { text, finishReason: finish, truncated, inputTokens: num(usage.prompt_tokens), outputTokens: num(usage.completion_tokens), raw: json };
    }
    case 'responses': {
      const status = normalizeFinishReason(o.status);
      const inc = (o.incomplete_details as { reason?: unknown } | undefined)?.reason;
      const finish = status === 'incomplete' && inc != null ? `incomplete:${inc === 'max_output_tokens' || inc === 'content_filter' ? inc : 'unknown'}` : status;
      let text = typeof o.output_text === 'string' ? o.output_text : '';
      if (!text) for (const item of (o.output as Record<string, unknown>[]) ?? []) if (item.type === 'message') for (const c of (item.content as Record<string, unknown>[]) ?? []) if (c.type === 'output_text' && typeof c.text === 'string') text += c.text;
      return { text, finishReason: finish, truncated: status === 'incomplete', inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens), raw: json };
    }
    case 'anthropic-messages': {
      const stop = normalizeFinishReason(o.stop_reason);
      const text = ((o.content as Record<string, unknown>[]) ?? []).filter(c => c.type === 'text').map(c => String(c.text ?? '')).join('');
      return { text, finishReason: stop, truncated: stop === 'max_tokens', inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens), raw: json };
    }
  }
}

export async function chat(cfg: ProviderConfig, req: ChatRequest): Promise<ChatResponse> {
  if (!cfg.baseUrl.trim()) throw new ProviderError('config', 'AI 接口地址不能为空');
  // Callers may update settings while a request waits for a shared slot. Freeze this attempt's inputs.
  cfg = { ...cfg };
  req = { ...req };
  if (!cfg.model.trim()) throw new ProviderError('config', '模型名称不能为空');
  if (cfg.authScheme !== 'none' && !cfg.apiKey.trim()) throw new ProviderError('config', 'API 密钥不能为空');
  const url = endpoint(cfg);
  return withExperimentGuard(url, cfg, req, async (signal, _timeoutMs, isolated, startSend) => {
    // Construct the isolated request before admission. A local serialization
    // failure must not be counted as a send. Normal-provider semantics stay intact.
    const isolatedInit: RequestInit | undefined = isolated ? { method: 'POST', headers: headers(cfg), body: JSON.stringify(body(cfg, req)), signal, redirect: 'error' } : undefined;
    if (isolated) startSend(); // outside the transport catch: preserve admission errors
    let res: Response;
    try { res = await fetch(url, isolatedInit ?? { method: 'POST', headers: headers(cfg), body: JSON.stringify(body(cfg, req)), signal }); }
    catch (e) {
      if (signal.aborted) throw signal.reason;
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('network', isolated ? '隔离评测网络请求失败' : `网络错误：${(e as Error).message}`);
    }
    if (isolated && (res.redirected || (res.url && res.url !== url) || (res.status >= 300 && res.status < 400))) throw new ProviderError('http', '隔离评测拒绝重定向', res.status, false);
    const textBody = await res.text();
    if (!res.ok) {
      const retryable = res.status === 408 || res.status === 409 || res.status === 425 || res.status === 429 || res.status >= 500;
      const error = new ProviderError('http', isolated ? `HTTP ${res.status}（响应正文已隐藏）` : `HTTP ${res.status}：${textBody.slice(0, 300)}`, res.status, retryable);
      const wait = res.headers.get('retry-after');
      if (wait) {
        const seconds = Number(wait);
        const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(wait) - Date.now();
        if (Number.isFinite(ms) && ms > 0) error.retryAfterMs = ms;
      }
      throw error;
    }
    let json: unknown; try { json = JSON.parse(textBody); } catch { throw new ProviderError('shape', isolated ? '响应不是 JSON（正文已隐藏）' : `响应不是 JSON：${textBody.slice(0, 200)}`); }
    let out: ChatResponse;
    try {
      if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new Error('shape');
      out = parseResponse(cfg, json, isolated);
      if (isolated && !out.text.trim() && !out.truncated) throw new Error('shape');
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'incompatible') throw error;
      throw new ProviderError('shape', '响应结构不符合接口协议');
    }
    if (out.truncated) {
      const error = new ProviderError('truncated', isolated ? '输出被截断' : `输出被截断（${out.finishReason}）`, undefined, true);
      error.usage = { inputTokens: out.inputTokens, outputTokens: out.outputTokens };
      throw error;
    }
    return out;
  });
}

/** JSON 模式不被支持时（400/422）可退回普通模式再试一次。 */
export const canRetryWithoutJsonMode = (e: unknown): boolean => e instanceof ProviderError && e.kind === 'http' && (e.status === 400 || e.status === 422);

export function estimateCost(cfg: ProviderConfig, input: number | null, output: number | null): number | null {
  if (!cfg.pricing || input == null || output == null) return null;
  return (input * cfg.pricing.input + output * cfg.pricing.output) / 1_000_000;
}
