import { REVIEW_ASSISTANT_PROMPT } from '../workflow/reviewAssistant';
import { NAME_MENTION_REVIEW_PROMPT } from '../validation/nameMentionReview';
import { INITIAL_OWNERSHIP_PROMPT, INITIAL_SUPPORT_PROMPT } from './prompts/initialFieldPrompt';
import { requestIdentity, redactCredential } from './requestIdentity';
import {translationThinking,TRANSLATION_THINKING_POLICY} from './translationThinking';
import { RunGuard } from './runGuard';
import { getProcessExperiment } from './experimentLedger';
/**
 * AI 客户端：在 provider adapter 之上加重试/退避、JSON 模式回退、并发闸、取消与 token 记账。
 * 每次调用写入 ai_calls 与 activity_log；解析失败与被截断响应的已知 token 也计入。
 */
import type { ProjectStore } from '@core/db';
import type { WorkstationId } from '@shared/types';
import { chat, normalizeFinishReason, canRetryWithoutJsonMode, ProviderError, type ProviderConfig, type ExperimentAttempt } from './providers/adapter';
import { systemPromptFor, PROMPT_VERSION } from './prompts/systemPrompts';
import { VOICE_EVIDENCE_PROMPT, FIELD_ATTRIBUTION_PROMPT, REGISTER_EVIDENCE_PROMPT } from './prompts/fieldEvidencePrompt';
import { TERM_SELECTION_INSTRUCTION } from './prompts/termSelectionPrompt';
import {visibleBodyPrompt} from './prompts/generationPrompts';
import {withMandatoryRequirements} from './prompts/mandatoryRequirements';
import {IMMUTABLE_LAYOUT_PROMPT} from './prompts/immutableLayoutPrompt';
import {LAYOUT_SEGMENTS_PROMPT} from '../validation/layoutSegments';
import {LAYOUT_ANCHORS_PROMPT} from '../validation/layoutAnchors';
import {COMMA_SELECTION_PROMPT} from '../validation/commaSelection';
import {EXPRESSION_FOCUS_PROMPT} from '../validation/expressionFocus';
import {SOURCE_STYLE_PROMPT} from '../validation/sourceStyleEvidence';
import type { ProtocolResult, ProtocolError } from './protocol';
import { Semaphore, abortableDelay } from './semaphore';

export interface CallOptions {
  reviewAssistant?: boolean;
  nameMentionReview?: boolean;
  initialFieldAttribution?: 'ownership'|'support';
  sourceStyle?: boolean;
  inlineStage?: 'body'|'body-focus'|'layout'|'layout-segments'|'layout-anchors'|'punctuation-choice';
  /** Isolated short contract for semantic term filtering, not initial extraction. */
  termSelection?: boolean;
  /** Voice scope contract on the existing character evidence workstation only. */
  voiceEvidence?: boolean;
  fieldAttribution?: boolean;
  registerEvidence?: boolean;
  workstation: WorkstationId;
  user: string;
  paragraphId?: string | null;
  taskId?: string | null;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
  /** 解析失败时的重试次数（协议层）；网络/HTTP 层重试独立计算 */
  parseRetries?: number;
  /** 使用判官模型 */
  judge?: boolean;
}
export interface CallResult<T> {
  value: T; aiCallId: string; inputTokens: number; outputTokens: number; costUsd: number; durationMs: number; attempts: number;
}
export class AiCallFailed extends Error {
  constructor(message: string, readonly lastError: ProtocolError | ProviderError | null, readonly attempts: number) { super(message); this.name = 'AiCallFailed'; }
}

export interface AiClientConfig { translationThinkingPolicy?: typeof TRANSLATION_THINKING_POLICY; primary: ProviderConfig; judge?: ProviderConfig | null; concurrency: number; networkRetries: number }

export class AiClient {
  private runGuard: RunGuard | null = null;
  attachRunGuard(guard: RunGuard): () => void {
    if (this.runGuard) throw new Error('已有整册任务使用当前AI客户端');
    this.runGuard = guard;
    return () => { if (this.runGuard === guard) this.runGuard = null; };
  }
  private sem: Semaphore;
  private cfg: AiClientConfig;
  readonly totals = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

  /** chatFn 可注入：测试用假模型，或未来接入流式实现 */
  constructor(private readonly store: ProjectStore, cfg: AiClientConfig, private readonly chatFn: typeof chat = chat) { this.cfg = cfg; this.sem = new Semaphore(cfg.concurrency); }
  updateConfig(cfg: AiClientConfig): void { this.cfg = cfg; this.sem.setMax(cfg.concurrency); }
  get config(): AiClientConfig { return this.cfg; }

  /** 原始文本调用（一次请求，含网络层重试与 JSON 模式回退） */
  async raw(opts: CallOptions): Promise<{ text: string; aiCallId: string; inputTokens: number; outputTokens: number; costUsd: number; durationMs: number }> {
    return this.rawRequest(opts, false);
  }
  private async rawRequest(opts: CallOptions, structured: boolean, validateExperimentResponse?: (text: string) => boolean): Promise<{ text: string; aiCallId: string; inputTokens: number; outputTokens: number; costUsd: number; durationMs: number }> {
    const guard = this.runGuard;
    const experiment = getProcessExperiment();
    experiment?.assertRunnable();
    const networkRetries = experiment?.limits.networkRetries ?? this.cfg.networkRetries;
    const selected = (opts.judge && this.cfg.judge) ? this.cfg.judge : this.cfg.primary;
    const stage=translationThinking(selected,opts,this.cfg.translationThinkingPolicy);
    const provider={...stage.provider};
    if(opts.nameMentionReview){provider.thinkingMode='disabled';delete provider.reasoningEffort;}
    const identity=requestIdentity(provider);
    if(stage.maxOutputTokens!==undefined)opts={...opts,maxOutputTokens:stage.maxOutputTokens};
    if (opts.termSelection && opts.workstation !== 'term-extractor') throw new Error('术语筛选提示只能用于术语工位');
    if (opts.voiceEvidence && (opts.workstation !== 'character-evidence-reviewer' || opts.termSelection)) throw new Error('声音核对提示只能用于人物证据工位');
    if (opts.fieldAttribution && (opts.workstation !== 'character-evidence-reviewer' || opts.termSelection || opts.voiceEvidence)) throw new Error('字段归属提示只能独立用于人物证据工位');
    if(opts.registerEvidence && (opts.workstation!=='character-evidence-reviewer' || opts.termSelection || opts.voiceEvidence || opts.fieldAttribution))throw new Error('语域范围提示只能独立用于人物证据工位');
    if(opts.inlineStage&&((!['faithful-translator','chinese-editor'].includes(opts.workstation)&&!(opts.workstation==='source-aligner'&&opts.inlineStage==='punctuation-choice'))||opts.termSelection||opts.voiceEvidence||opts.fieldAttribution||opts.registerEvidence))throw new Error('正文版式分离只能独立用于初译或编辑工位；对齐工位仅可选择程序生成的停顿候选');
    if(opts.inlineStage==='body-focus'&&opts.workstation!=='chinese-editor')throw new Error('局部表达替换只用于中文编辑');
    if(opts.sourceStyle&&(opts.workstation!=='naturalness-reviewer'||opts.inlineStage||opts.termSelection||opts.voiceEvidence||opts.fieldAttribution||opts.registerEvidence))throw new Error('原作表达复核只能独立用于读感工位');
    if(opts.initialFieldAttribution && (opts.workstation!=='character-evidence-reviewer' || opts.termSelection || opts.voiceEvidence || opts.fieldAttribution || opts.registerEvidence || opts.inlineStage || opts.sourceStyle))throw new Error('初次属性复核只能独立用于人物证据工位');
    if(opts.nameMentionReview&&(opts.workstation!=='character-evidence-reviewer'||opts.initialFieldAttribution||opts.sourceStyle||opts.inlineStage||opts.termSelection||opts.voiceEvidence||opts.fieldAttribution||opts.registerEvidence))throw new Error('姓名核对只能作为独立证据步骤');
    if (opts.reviewAssistant && (opts.workstation !== 'term-translation-proposer' || opts.termSelection || opts.inlineStage || opts.nameMentionReview)) throw new Error('待确认助手只能使用独立提案提示');
    const selectedSystem = opts.reviewAssistant?REVIEW_ASSISTANT_PROMPT:opts.nameMentionReview?NAME_MENTION_REVIEW_PROMPT:opts.initialFieldAttribution?(opts.initialFieldAttribution==='ownership'?INITIAL_OWNERSHIP_PROMPT:INITIAL_SUPPORT_PROMPT):opts.sourceStyle?SOURCE_STYLE_PROMPT:opts.inlineStage==='body-focus'?EXPRESSION_FOCUS_PROMPT:opts.inlineStage==='punctuation-choice'?COMMA_SELECTION_PROMPT:opts.inlineStage==='body'?visibleBodyPrompt(opts.workstation as 'faithful-translator'|'chinese-editor'):opts.inlineStage==='layout'?IMMUTABLE_LAYOUT_PROMPT:opts.inlineStage==='layout-segments'?LAYOUT_SEGMENTS_PROMPT:opts.inlineStage==='layout-anchors'?LAYOUT_ANCHORS_PROMPT:opts.registerEvidence ? REGISTER_EVIDENCE_PROMPT : opts.fieldAttribution ? FIELD_ATTRIBUTION_PROMPT : opts.voiceEvidence ? VOICE_EVIDENCE_PROMPT : opts.termSelection ? TERM_SELECTION_INSTRUCTION : systemPromptFor(opts.workstation);
    const system = opts.reviewAssistant || opts.nameMentionReview || (opts.inlineStage && !['body','body-focus'].includes(opts.inlineStage)) ? selectedSystem : withMandatoryRequirements(selectedSystem,opts.workstation);
    const release = await this.sem.acquire(opts.signal);
    const started = Date.now();
    let jsonMode = true; let lastErr: ProviderError | null = null;

    try {
      // A queued caller may have become ineligible while waiting. Keep this
      // inside finally's scope so local refusal cannot leak the semaphore.
      experiment?.assertRunnable();
      // 记录请求开始
      this.store.translations.log({
        level: 'info',
        workstationId: opts.workstation,
        paragraphId: opts.paragraphId ?? null,
        message: `🔵 AI调用开始 [${opts.workstation}] ${identity}`
      });

      for (let attempt = 0; attempt <= networkRetries; attempt++) {
        if (opts.signal?.aborted) throw new ProviderError('abort', '已取消');
        // Includes retries and JSON fallback; local stops are not AI failures.
        experiment?.assertRunnable();
        let sendStarted = false;
        let responseReceived = false;
        let usageAccounted = false;
        let aiCallRecorded = false;
        const experimentAttempt: ExperimentAttempt | undefined = experiment ? {
          onSendStart: () => {
            // The ledger reservation is already durable, but this synchronous
            // run admission can still veto sending without inventing an ai_call.
            guard?.reserve();
            this.totals.calls++;
            sendStarted = true;
          }
        } : undefined;
        if (!experiment) { guard?.reserve(); this.totals.calls++; }
        try {
          const r = await (experiment ? chat : this.chatFn)(provider, { system, user: opts.user, jsonMode, ...(experimentAttempt ? { experimentAttempt } : {}), ...(experiment && validateExperimentResponse ? { validateExperimentResponse } : {}), ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}), ...(opts.temperature != null ? { temperature: opts.temperature } : {}) });
          responseReceived = true;
          const durationMs = Date.now() - started;
          const inputTokens = r.inputTokens ?? 0, outputTokens = r.outputTokens ?? 0;
          const costUsd = 0; // Legacy result field; monetary estimation is disabled.
          if (experiment) {
            // Received tokens remain facts if the response notification throws.
            this.totals.inputTokens += inputTokens; this.totals.outputTokens += outputTokens; this.totals.costUsd += costUsd;
            usageAccounted = true;
          }
          guard?.response(r.inputTokens, r.outputTokens);
          if (!structured) guard?.outcome(true);
          const aiCallId = this.store.translations.recordAiCall({ taskId: opts.taskId ?? null, paragraphId: opts.paragraphId ?? null, model: provider.model, provider: provider.protocol, promptVersion: PROMPT_VERSION, workstationId: opts.workstation, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd, durationMs, finishReason: normalizeFinishReason(r.finishReason) });
          aiCallRecorded = true;
          if(opts.inlineStage)this.store.db.run('INSERT INTO meta(key,value) VALUES(?,?)',[`inline-call:${aiCallId}`,JSON.stringify({stage:opts.inlineStage,paragraphId:opts.paragraphId??null})]);
          if(opts.sourceStyle)this.store.db.run('INSERT INTO meta(key,value) VALUES(?,?)',[`source-style-call:${aiCallId}`,JSON.stringify({paragraphId:opts.paragraphId??null})]);
          if (!experiment) { this.totals.inputTokens += inputTokens; this.totals.outputTokens += outputTokens; this.totals.costUsd += costUsd; }

          // 记录响应成功
          this.store.translations.log({
            level: 'success',
            workstationId: opts.workstation,
            paragraphId: opts.paragraphId ?? null,
            message: `✅ AI响应完成 [${opts.workstation}] ${identity} · ${durationMs}ms | in:${r.inputTokens ?? '未知'} out:${r.outputTokens ?? '未知'}`,
            durationMs,
            tokens: inputTokens + outputTokens
          });

          return { text: redactCredential(r.text, provider.apiKey), aiCallId, inputTokens, outputTokens, costUsd, durationMs };
        } catch (e) {
          if(e instanceof Error){e.message=redactCredential(e.message,provider.apiKey);if(e.stack)e.stack=redactCredential(e.stack,provider.apiKey);}
          // Configuration, ledger waits/stops and send-hook vetoes are local
          // refusals, not unknown-usage provider calls or consecutive failures.
          if (experiment && !sendStarted) throw e;
          const usage = (e instanceof ProviderError ? e.usage : undefined) ?? experimentAttempt?.usage;
          if (!experiment || !aiCallRecorded) this.store.translations.recordAiCall({ taskId: opts.taskId ?? null, paragraphId: opts.paragraphId ?? null, model: provider.model, provider: provider.protocol, promptVersion: PROMPT_VERSION, workstationId: opts.workstation, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, costUsd: null, durationMs: Date.now() - started, finishReason: null, error: (e as Error).message });
          if (usage && !usageAccounted) {
            if (experiment) { this.totals.inputTokens += usage.inputTokens ?? 0; this.totals.outputTokens += usage.outputTokens ?? 0; usageAccounted = true; }
            guard?.response(usage.inputTokens, usage.outputTokens);
            if (!experiment) { this.totals.inputTokens += usage.inputTokens ?? 0; this.totals.outputTokens += usage.outputTokens ?? 0; }
          }
          // Preserve a post-response observer error without notifying it again
          // or applying the same received usage twice.
          if (experiment && responseReceived) throw e;
          if (!(e instanceof ProviderError)) { guard?.outcome(false); throw e; }
          if (e.kind !== 'abort') guard?.outcome(false);
          lastErr = e;
          if (e.kind === 'abort') throw e;
          guard?.check();
          if (jsonMode && canRetryWithoutJsonMode(e)) { jsonMode = false; attempt--; continue; }
          if (e.kind === 'truncated' && attempt < networkRetries) {
            // 截断：下一次放大输出上限（由调用方缩小批次是更根本的办法）
            opts = { ...opts, maxOutputTokens: Math.min((opts.maxOutputTokens ?? provider.maxOutputTokens) * 2, 65536) };
          }
          if (!e.retryable || attempt === networkRetries) break;
          this.store.translations.log({ level: 'warning', workstationId: opts.workstation, paragraphId: opts.paragraphId ?? null, message: `⚠️ 请求失败，第 ${attempt + 1} 次重试：${e.message.slice(0, 120)}` });
          await abortableDelay(Math.min(30000, 1000 * 2 ** attempt + Math.random() * 500), opts.signal);
        }
      }
      const durationMs = Date.now() - started;


      // 记录最终失败
      this.store.translations.log({
        level: 'error',
        workstationId: opts.workstation,
        paragraphId: opts.paragraphId ?? null,
        message: `❌ AI调用失败 [${opts.workstation}] ${identity} · ${lastErr?.message ?? 'unknown'}`,
        durationMs
      });

      throw lastErr ?? new ProviderError('network', '未知错误');
    } finally { release(); }
  }

  /** 结构化调用：文本 → 协议解析；解析失败带诊断重试。 */
  async structured<T>(opts: CallOptions, parse: (text: string) => ProtocolResult<T>): Promise<CallResult<T>> {
    const experiment = getProcessExperiment();
    experiment?.assertRunnable();
    const retries = experiment ? Math.min(opts.parseRetries ?? 2, 2) : opts.parseRetries ?? 2;
    let user = opts.user; let attempts = 0; let last: ProtocolError | ProviderError | null = null;
    const diagnostics: string[] = [];
    let inputTokens = 0, outputTokens = 0, costUsd = 0, durationMs = 0;

    // 记录用户请求概要（截断以避免过长）
    const userPreview = user.length > 200 ? user.slice(0, 200) + '...' : user;
    this.store.translations.log({
      level: 'info',
      workstationId: opts.workstation,
      paragraphId: opts.paragraphId ?? null,
      message: experiment ? `📤 发送隔离评测请求 [${opts.workstation}]（正文已隐藏）` : `📤 发送请求 [${opts.workstation}]: ${userPreview.replace(/\n/g, ' ')}`
    });

    for (let i = 0; i <= retries; i++) {
      attempts++;
      let r;
      let parsed: ProtocolResult<T> | undefined;
      try { r = await this.rawRequest({ ...opts, user }, true, experiment ? text => { parsed = parse(text); return parsed.ok; } : undefined); }
      catch (e) { if (e instanceof ProviderError) { last = e; if (e.kind === 'abort') throw e; break; } throw e; }
      inputTokens += r.inputTokens; outputTokens += r.outputTokens; costUsd += r.costUsd; durationMs += r.durationMs;

      // 记录响应内容概要
      const responsePreview = r.text.length > 300 ? r.text.slice(0, 300) + '...' : r.text;
      this.store.translations.log({
        level: 'info',
        workstationId: opts.workstation,
        paragraphId: opts.paragraphId ?? null,
        message: experiment ? `📥 收到隔离评测响应 [${opts.workstation}]（正文已隐藏）` : `📥 收到响应 [${opts.workstation}]: ${responsePreview.replace(/\n/g, ' ')}`
      });

      const p = parsed ?? parse(r.text);
      this.runGuard?.outcome(p.ok);
      if (p.ok) {
        if(opts.initialFieldAttribution)this.store.db.run('INSERT INTO meta(key,value) VALUES(?,?)',['initial-field-call:'+r.aiCallId,JSON.stringify({baseUser:opts.user,user,response:r.text,stage:opts.initialFieldAttribution,prompt:opts.initialFieldAttribution==='ownership'?INITIAL_OWNERSHIP_PROMPT:INITIAL_SUPPORT_PROMPT,diagnostics:[...diagnostics]})]);
        this.store.translations.log({
          level: 'success',
          workstationId: opts.workstation,
          paragraphId: opts.paragraphId ?? null,
          message: `✨ 解析成功 [${opts.workstation}] 共${attempts}次尝试`
        });
        return { value: p.value, aiCallId: r.aiCallId, inputTokens, outputTokens, costUsd, durationMs, attempts };
      }
      last = p.error;
      this.store.translations.log({ level: 'warning', workstationId: opts.workstation, paragraphId: opts.paragraphId ?? null, message: experiment ? '⚠️ 隔离评测输出协议不合规（诊断正文已隐藏）' : `⚠️ 输出协议不合规（${p.error.code}）：${p.error.message.slice(0, 160)}${i < retries ? '，带诊断重试' : ''}` });
      const diagnostic = `${p.error.code} — ${p.error.message}`;
      if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
      if (diagnostics.length > 3) diagnostics.shift();
      user = `${opts.user}\n\n【本次重试须同时满足】以下是本次调用已发现的问题；已改好的部分继续保持，不要修好一项又改坏另一项。\n${diagnostics.map((d, index) => `${index + 1}. ${d}`).join('\n')}\n请严格按契约重新输出完整 JSON（不是修补，是完整重发）。`;
    }
    throw new AiCallFailed(experiment ? `隔离评测调用失败（${attempts} 次，诊断正文已隐藏）` : `AI 调用失败（${attempts} 次）：${last?.message ?? 'unknown'}`, last, attempts);
  }
}
