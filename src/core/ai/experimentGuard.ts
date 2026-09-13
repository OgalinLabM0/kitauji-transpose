import { ExperimentStopped, getProcessExperiment, validateExperimentEndpoint } from './experimentLedger';
import { abortableDelay } from './semaphore';
import { ProviderError, type ChatRequest, type ChatResponse, type ProviderConfig } from './providers/adapter';

/** Wrap the bottom-most adapter call, not a particular client/workstation. */
export async function withExperimentGuard(
  url: string, cfg: ProviderConfig, req: ChatRequest,
  send: (signal: AbortSignal, timeoutMs: number, isolated: boolean, startSend: () => void) => Promise<ChatResponse>,
): Promise<ChatResponse> {
  if (req.signal?.aborted) throw new ProviderError('abort', '已取消');
  const ledger = getProcessExperiment();
  if (ledger) {
    validateExperimentEndpoint(url);
    const thinkingAllowed = cfg.thinkingMode === 'disabled' || (ledger.thinkingComparison && cfg.thinkingMode === 'enabled' && ['low','high','max'].includes(cfg.reasoningEffort ?? ''));
    if (cfg.protocol !== 'chat-completions' || !thinkingAllowed) throw new ExperimentStopped('configuration');
  }
  let reservation: string | undefined;
  if (ledger) {
    while (!reservation) {
      if (req.signal?.aborted) throw new ProviderError('abort', '已取消');
      const result = ledger.reserve();
      if (result) reservation = result;
      else await abortableDelay(25, req.signal);
    }
  }
  const ctrl = new AbortController();
  const timeoutMs = ledger ? Math.min(Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : ledger.limits.timeoutMs, ledger.limits.timeoutMs) : cfg.timeoutMs;
  const abort = (): void => ctrl.abort(new ProviderError('abort', '已取消'));
  if (req.signal?.aborted) abort();
  else req.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new ProviderError('timeout', `请求超时（${timeoutMs}ms）`)), timeoutMs);
  let response: ChatResponse | undefined;
  let receivedUsage: ProviderError['usage'];
  let error: unknown;
  let sendStarted = !ledger;
  const startSend = (): void => {
    if (!ledger) return;
    if (ctrl.signal.aborted) throw ctrl.signal.reason;
    req.experimentAttempt?.onSendStart();
    sendStarted = true;
  };
  try {
    if (ctrl.signal.aborted) throw ctrl.signal.reason;
    response = await send(ctrl.signal, timeoutMs, !!ledger, startSend);
    if (ctrl.signal.aborted) throw ctrl.signal.reason;
    if (ledger && req.validateExperimentResponse && !req.validateExperimentResponse(response.text)) {
      // The client retains the parser diagnostic and performs its own bounded format retry.
      if (reservation) ledger.finish(reservation, 'protocol', response.inputTokens, response.outputTokens);
      reservation = undefined;
    }
    return response;
  } catch (caught) {
    if (sendStarted && caught instanceof ProviderError) receivedUsage = caught.usage;
    // A cancellation/timeout racing a received incompatibility must not hide
    // that evidence or turn the durable stop into an ordinary aborted request.
    // Local admission errors (including RunStopped) must not become provider
    // protocol failures. No send has started, but the reservation stays spent.
    error = !sendStarted ? caught : caught instanceof ProviderError && caught.kind === 'incompatible' ? caught : ctrl.signal.aborted ? ctrl.signal.reason : ledger && !(caught instanceof ProviderError) && !(caught instanceof ExperimentStopped) ? new ProviderError('shape', '隔离评测响应处理失败（正文已隐藏）') : caught;
    throw error;
  } finally {
    clearTimeout(timer); req.signal?.removeEventListener('abort', abort);
    const providerError = error instanceof ProviderError ? error : undefined;
    const usage = { inputTokens: sendStarted ? response?.inputTokens ?? receivedUsage?.inputTokens ?? null : null, outputTokens: sendStarted ? response?.outputTokens ?? receivedUsage?.outputTokens ?? null : null };
    // Capture evidence before finish(): a fail-closed storage error must not
    // erase tokens already returned by the provider from client accounting.
    if (ledger && sendStarted && req.experimentAttempt) req.experimentAttempt.usage = usage;
    if (ledger && reservation) {
      const outcome = !sendStarted ? 'abort' : error ? (providerError && providerError.kind !== 'config' ? providerError.kind : 'shape') : 'success';
      ledger.finish(reservation, outcome, usage.inputTokens, usage.outputTokens, sendStarted ? providerError?.retryAfterMs ?? 0 : 0);
    }
  }
}
