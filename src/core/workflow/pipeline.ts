import {inheritForeignNotes} from './foreignNotes';
import {originalRubyContext} from './originalRubyContext';
import {originalRubyEntries} from './originalRuby';
import {separatedGeneration,separatedGenerationIdentity} from './separatedGeneration';
import {expressionFocus} from '../validation/expressionFocus';
import {reviewSourceStyle} from './sourceStyleReview';
import {naturalnessText} from './naturalnessText';
import type {LayoutProof} from '../validation/immutableLayout';
import {restoreWholeParagraphWrap} from '../validation/wholeParagraphWrap';
import { sourceRelationCheckpoints, sourceRelationReminder } from './localEditorRequest';
import { quoteGlyphCandidate } from '../validation/quoteCandidate';
import { draftLongParagraph, longParagraphParts } from './longParagraphDraft';
import { exposeUnacceptedWarnings } from './reviewWarnings';
import { GenerationResumeContextChangedError, openGenerationResume } from './generationResume';
import { assertAcceptedChangeSources } from '../db/knowledgeChanges';
import { needsSemanticPreparation, prepareWithEvidence, type SourceRelationNote } from './semanticPreparation';
import { assessNaturalness, type NaturalnessAssessment } from './naturalness';
import { naturalnessRepairIssues, reviewRepairResolution } from './repairResolution';
import { generationConstraints } from '../ai/prompts/generationConstraints';
import { uniqueCommaDeletion } from '../validation/commaCandidate';
import { LongNaturalnessBoundaryError } from './longNaturalnessPlan';
import { translationBatches } from './translationBatches';
import { pendingFieldConflicts } from './characterConflicts';
/** 翻译流水线：短指令初译 → 中文编辑 → 独立原译对应 → 三项审校 → 凭证与定稿。
 * 场景间并发；默认一次一段，降低弱模型漏块和指令混淆。 */
import type { ProjectStore, AnalysisRow } from '@core/db';
import { fromJson } from '@core/db';
import { AiClient, AiCallFailed, ProviderError, buildContextPack, parseTranslation, type TranslationItem, type ContextPack } from '@core/ai';
import { validateTranslation, hasBlocking, normalizeGeneratedStutter } from '@core/validation';
import { checkPassiveInversion } from '@core/validation/wordOrder';
import { validateMarkers, type InlineTemplate } from '@core/epub/blocks';
import type { GlossaryHitDetail } from '@core/glossary/hits';
import { routeFlags } from './flagRouter';
import { verifyCandidate } from './verifyCandidate';
import { auditInput, bindAuditReceipt, type AuditProof } from './auditReceipts';
import { rebuildCandidateRuby } from './rubyPlan';
import type { WorkflowProgress, TranslationFlag, ValidationFinding, ParagraphType } from '@shared/types';

export interface PipelineOptions {
  /** Separate eligible ruby layout from prose; enabled by application entrypoints. */
  separateInlineLayout?: boolean;
  batchSize?: number;
  skipConfirmed?: boolean;
  /** Resume only an explicitly bound, unfinished faithful candidate. False requests fresh generation. */
  resumeIncomplete?: boolean;
  onProgress?: (p: WorkflowProgress) => void;
  /** 兼容旧调用参数；所有稿件现在都完整审校。 */
  forceFullReview?: boolean;
  /** 兼容旧调用参数；已不使用抽样跳审。 */
  disableSampling?: boolean;
}

interface Para { id: string; sceneId: string; seriesOrdinal: number; sourceText: string; paragraphType: ParagraphType }
interface Validated { aiCallId: string; item: TranslationItem; findings: ValidationFinding[]; ok: boolean; layoutProof?:LayoutProof }
type ValidatedMap = Map<string, Validated>;


export class TranslationPipeline {
  private seriesIds: string[] = [];
  private allowGenerationResume = true;
  private sourceRelations = new Map<string, SourceRelationNote[]>();
  private sourceRelationInputs = new Map<string, string>();
  private abort = new AbortController();
  private paused = false;
  private waiters: (() => void)[] = [];
  readonly progress: WorkflowProgress = { running: false, paused: false, phase: 'idle', done: 0, total: 0, currentParagraphId: null, costUsd: 0, inputTokens: 0, outputTokens: 0, message: '' };

  constructor(private readonly store: ProjectStore, private readonly ai: AiClient, private readonly opts: PipelineOptions = {}) {
  }

  pause(): void { this.paused = true; this.emit({ paused: true, message: '已暂停' }); }
  resume(): void { this.paused = false; this.emit({ paused: false, message: '继续' }); const w = this.waiters; this.waiters = []; w.forEach(f => f()); }
  cancel(): void { this.abort.abort(new ProviderError('abort', '用户已停止任务')); this.resume(); }
  get signal(): AbortSignal { return this.abort.signal; }

  private emit(patch: Partial<WorkflowProgress>): void {
    Object.assign(this.progress, patch, { costUsd: this.ai.totals.costUsd, inputTokens: this.ai.totals.inputTokens, outputTokens: this.ai.totals.outputTokens });
    this.opts.onProgress?.({ ...this.progress });
  }
  private async gate(): Promise<void> {
    if (this.abort.signal.aborted) throw new ProviderError('abort', '已取消');
    while (this.paused) { await new Promise<void>(r => this.waiters.push(r)); if (this.abort.signal.aborted) throw new ProviderError('abort', '已取消'); }
    for (const id of this.seriesIds) assertAcceptedChangeSources(this.store.db, id);
  }

  /** 翻译一组段落（任意范围，内部按场景分组保序） */
  async run(paragraphIds: string[], phase = '翻译'): Promise<{ done: number; failed: number; autoAccepted: number; needsReview: number }> {
    const stats = { done: 0, failed: 0, autoAccepted: 0, needsReview: 0 };
    // Existing explicit retranslation entry points use skipConfirmed:false or a 重译 phase.
    this.allowGenerationResume = this.opts.resumeIncomplete !== false && this.opts.skipConfirmed !== false && !phase.includes('重译');
    const paras: Para[] = [];
    for (const id of new Set(paragraphIds)) {
      const p = this.store.projects.getParagraph(id); if (!p) continue;
      if (this.opts.skipConfirmed !== false && this.store.translations.latestFinal(id)?.confirmed_by_user) continue;
      paras.push(p);
    }
    this.seriesIds = [...new Set(paras.map(p => this.store.projects.getSeriesIdOfParagraph(p.id)))];
    const scenes = new Map<string, Para[]>();
    for (const p of paras) { const arr = scenes.get(p.sceneId) ?? []; arr.push(p); scenes.set(p.sceneId, arr); }
    this.emit({ running: true, paused: false, phase, done: 0, total: paras.length, message: `共 ${paras.length} 段，${scenes.size} 个场景` });
    const queue = [...scenes.values()];
    const workers = Math.max(1, Math.min(this.ai.config.concurrency, queue.length));
    try {
      const workerResults = await Promise.allSettled(Array.from({ length: workers }, async () => {
        try {
        for (;;) {
          const scene = queue.shift(); if (!scene) return;
          for (const batch of translationBatches(scene.map(p => ({ ...p, boundaryBefore: !!this.store.projects.sceneObservation(p.id)?.boundary })), this.opts.batchSize)) {
            await this.gate();
            const r = await this.processBatch(batch);
            stats.done += r.done; stats.failed += r.failed; stats.autoAccepted += r.autoAccepted; stats.needsReview += r.needsReview;
            this.emit({ done: this.progress.done + batch.length, currentParagraphId: batch[batch.length - 1]!.id, message: `已处理 ${this.progress.done + batch.length}/${paras.length}` });
          }
        }
        } catch (error) { this.abort.abort(error); throw error; }
      }));
      const failure = workerResults.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failure) throw failure.reason;
      this.emit({ running: false, phase: 'idle', message: `完成：${stats.done} 段，自动确认 ${stats.autoAccepted}，待人工 ${stats.needsReview}，失败 ${stats.failed}` });
    } catch (e) {
      const aborted = e instanceof ProviderError && e.kind === 'abort';
      this.emit({ running: false, paused: false, phase: 'idle', message: aborted ? '已停止' : `中断：${(e as Error).message}` });
      if (!aborted) throw e;
    }
    return stats;
  }

  private templateOf(paragraphId: string): InlineTemplate {
    const b = this.store.archives.blocksOfParagraph(paragraphId)[0];
    return b?.inline_template ? (JSON.parse(b.inline_template) as InlineTemplate) : { markers: [] };
  }
  private hitsFor(pack: ContextPack, source: string): GlossaryHitDetail[] { return pack.glossaryHits.filter(h => source.includes(h.termJp)); }

  private userMessage(pack: ContextPack, blocks: Record<string, unknown>[], extra?: string): string {
    return `${pack.text}\n\n【本次任务块】（id 必须原样、完整返回）\n${JSON.stringify({ items: blocks })}${extra ? `\n\n${extra}` : ''}`;
  }

  /** 初译或编辑：结构化调用 + 程序校验。阻断块只重发失败块（带诊断），最多 2 次；通过的块不再重跑。 */
  private async translateWithValidation(ws: 'faithful-translator' | 'chinese-editor', pack: ContextPack, paras: Para[], drafts?: Map<string, string>, editIssues?: Map<string,NaturalnessAssessment>, contextParagraphIds = paras.map(p => p.id)): Promise<ValidatedMap> {
    const out: ValidatedMap = new Map();
    if (ws === 'faithful-translator') for (const p of paras) {
      await this.gate();
      this.sourceRelations.delete(p.id);
      this.sourceRelationInputs.delete(p.id);
      if (!needsSemanticPreparation(p.sourceText)) continue;
      const context = (pack.sourceContextIds ?? []).map(id => this.store.projects.getParagraph(id)).filter(p => p != null).map(p => ({ id: p.id, source: p.sourceText }));
      const reading = await prepareWithEvidence(this.store, this.ai, p.id, p.sourceText, context, this.signal);
      await this.gate();
      if (buildContextPack(this.store, { paragraphIds: contextParagraphIds, workstation: ws }).text !== pack.text || this.store.projects.getParagraph(p.id)?.sourceText !== p.sourceText) throw new Error('难句整理期间原文或上下文已变化');
      this.sourceRelations.set(p.id, reading.value.notes);
      this.sourceRelationInputs.set(p.id, reading.inputHash);
      this.store.translations.log({ level: 'info', workstationId: 'source-relation-reader', paragraphId: p.id, message: JSON.stringify({ aiCallId: reading.aiCallId, notes: reading.value.notes, status: '待候选定向复核' }) });
    }
    let pending = paras; let diagByBlock = new Map<string, string>();
    const rejectedDrafts = new Map<string, string>();
    const rejectedOutputs = new Map<string, Set<string>>();
    for (let attempt = 0; attempt < 3 && pending.length; attempt++) {
      await this.gate();
      const ids = pending.map(p => p.id);
      const blocks = pending.map(p => ({ id: p.id, source: p.sourceText, source_constraints: generationConstraints(p.sourceText), ...(rejectedDrafts.has(p.id) ? { rejected_draft: rejectedDrafts.get(p.id), correction_instruction: '这是上次未通过的稿件。结合后面的具体错误修正，不能原样重交；保持已经正确的内容。' } : {}), ...(this.sourceRelations.has(p.id) ? { source_relation_quotes: sourceRelationCheckpoints(this.sourceRelations.get(p.id) ?? [],p.sourceText), relation_check_instruction: '自行根据日文核对动作主体、受话人、施受方向和否定范围，保留原作歧义' } : {}), ...(drafts ? { ...(originalRubyContext(this.store,p.id,drafts.get(p.id)??'')?{original_ruby_context:originalRubyContext(this.store,p.id,drafts.get(p.id)??'')} : {}), draft: drafts.get(p.id) ?? '', expression_issues: (editIssues?.get(p.id)?.issues ?? []).map(({quote_zh,reason})=>({quote_zh,reason})) } : {}) }));
      const editInstruction=ws === 'chinese-editor' ? '【编辑要求】draft 为初译稿；对照对象是 source（日文原文）。只处理expression_issues指出且对照原文确实成立的问题，其余表达保持；若问题是原作有意特征则原样保留。没有具体问题时只修明确病句，不扩写或同义换词。不得改变信息集合；后续独立工位会核对。' : undefined;
      let user = this.userMessage(pack, blocks, editInstruction);
      if (attempt > 0) user += `\n\n【上一次输出未通过程序校验，请修正后完整重发以下块】\n${[...diagByBlock.values()].join('\n')}\n提示：不要补出没有原文依据的人称、性别或人数；修复不能改变施受关系，也不要用原文未支持的复数名词代替。`;
      const parts = ws === 'faithful-translator' && pending.length === 1 ? longParagraphParts(pending[0]!.sourceText, this.templateOf(pending[0]!.id)) : [];
      const separated=this.opts.separateInlineLayout===true&&pending.length===1&&longParagraphParts(pending[0]!.sourceText,this.templateOf(pending[0]!.id)).length<=1&&this.templateOf(pending[0]!.id).markers.some(m=>m.kind==='ruby')&&!this.templateOf(pending[0]!.id).markers.some(m=>m.kind==='atomic');
      const r = separated ? await (()=>{
        const p=pending[0]!,template=this.templateOf(p.id);
        const bodyPack=buildContextPack(this.store,{paragraphIds:contextParagraphIds,workstation:ws,visibleBody:true});
        const bodyBlocks=blocks.map(block=>{const {original_ruby_context:ignored,...rest}=block;return {...rest,source:naturalnessText(p.sourceText,template).text,...(typeof block.draft==='string'?{draft:naturalnessText(block.draft,template).text}:{}),...(typeof block.rejected_draft==='string'?{rejected_draft:block.rejected_draft.replace(/⟦\/?\d+⟧/gu,'')}:{})};});
        const focus=ws==='chinese-editor'?expressionFocus(naturalnessText(drafts?.get(p.id)??'',template).text,editIssues?.get(p.id)?.issues??[]):null;
        const request=focus?bodyPack.text+'\n【本次局部编辑】\n'+JSON.stringify({source:naturalnessText(p.sourceText,template).text,source_constraints:generationConstraints(p.sourceText),draft_parts:focus}):this.userMessage(bodyPack,bodyBlocks,editInstruction);
        const bodyUser=(request+'\n【原作注音含义，仅供理解】'+JSON.stringify(originalRubyEntries(p.sourceText,template).map(({sourceBase,rt})=>({sourceBase,reading:rt})))+(attempt>0?'\n【上次程序检查】'+[...diagByBlock.values()].join('\n'):'')).replace(/⟦\/?\d+⟧/gu,'');
        return separatedGeneration({store:this.store,ai:this.ai,workstation:ws,...(focus?{focus}:{}),id:p.id,source:p.sourceText,template,user:bodyUser,resume:this.allowGenerationResume,signal:this.abort.signal,check:async()=>{await this.gate();if(buildContextPack(this.store,{paragraphIds:contextParagraphIds,workstation:ws}).text!==pack.text||this.store.projects.getParagraph(p.id)?.sourceText!==p.sourceText)throw Error('正文版式处理期间原文或知识已变化');}});
      })() : parts.length > 1 ? await draftLongParagraph(this.ai, {
        store: this.store,
        paragraphId: pending[0]!.id, parts, context: pack.text + sourceRelationReminder(this.sourceRelations.get(pending[0]!.id) ?? [],pending[0]!.sourceText), signal: this.abort.signal,
        diagnostic: attempt > 0 ? `\n【整段上次校验问题，仅修改当前句群相关部分】${[...diagByBlock.values()].join('\n')}` : '',
        check: async () => {
          await this.gate();
          this.abort.signal.throwIfAborted();
          const p = this.store.projects.getParagraph(pending[0]!.id);
          if (!p || p.sourceText !== pending[0]!.sourceText || buildContextPack(this.store, {paragraphIds: contextParagraphIds, workstation:'faithful-translator'}).text !== pack.text) throw new Error('长段原文或上下文已变化，旧片段未合并，请继续本册重试');
        },
        onPart: (index, total, callId) => this.store.translations.log({level:'info', workstationId:ws, paragraphId:pending[0]!.id, message:`长段初译 ${index}/${total} 完成；请求 ${callId}，全部完成后合回原段审校`}),
      }) : await this.ai.structured({ workstation: ws, user, paragraphId: pending.length === 1 ? pending[0]!.id : null, signal: this.abort.signal, parseRetries: 1 }, text => parseTranslation(text, ids));
      const next: Para[] = []; diagByBlock = new Map();
      for (const item of r.value.items) {
        const sourceParagraph=pending.find(p=>p.id===item.id)!;
        const restoredWrap=restoreWholeParagraphWrap(sourceParagraph.sourceText,item.translation,this.templateOf(item.id));
        if(restoredWrap!==null){
          this.store.translations.log({level:'info',workstationId:ws,paragraphId:item.id,message:JSON.stringify({kind:'whole-paragraph-wrap-restored-v1',aiCallId:r.aiCallId,message:'仅恢复原文覆盖整段的样式标记，未修改可见译文；仍须完整标点、忠实和读感审校'})});
          item.translation=restoredWrap;
        }
        const normalized = normalizeGeneratedStutter(item.translation);
        if (normalized !== item.translation) {
          this.store.translations.log({ level: 'info', workstationId: ws, paragraphId: item.id, message: '按中文停顿规则规范生成稿的结巴逗号；原始模型响应保留在调用记录中，规范后仍须完整审校' });
          item.translation = normalized;
        }
        const analysisInput = this.sourceRelationInputs.get(item.id);
        if (analysisInput && auditInput(this.store, item.id).inputHash !== analysisInput) throw new Error('生成期间难句原文依据已变化，旧候选不保存');
        for (const note of this.sourceRelations.get(item.id) ?? []) {
          const question = `原文「${note.quote}」关系核对：${note.reading}${note.uncertain ? '（未确定，须保留原作歧义）' : '（分析尚待核查）'}`;
          if (!item.flags.some(f => f.type === 'logic-conflict' && f.note === question)) item.flags.push({ type: 'logic-conflict', note: question });
        }
        const p = pending.find(x => x.id === item.id)!;
        const quoteCandidate = quoteGlyphCandidate(p.sourceText, item.translation);
        if (!separated&&quoteCandidate !== null && validateMarkers(quoteCandidate, this.templateOf(p.id)).ok) {
          this.store.translations.log({ level: 'info', workstationId: ws, paragraphId: p.id, message: JSON.stringify({ kind: 'source-quote-glyph-candidate-v1', original: item.translation, proposed: quoteCandidate, aiCallId: r.aiCallId, status: '仅规范引号字形，位置与正文不改，仍须完整审校' }) });
          item.translation = quoteCandidate;
        }
        let findings = validateTranslation({ source: p.sourceText, translation: item.translation, paragraphType: p.paragraphType, flags: item.flags as TranslationFlag[], glossary: this.hitsFor(pack, p.sourceText) });
        const blockers = findings.filter(f => f.severity === 'blocks_export');
        if (!separated&&ws === 'faithful-translator' && blockers.length && blockers.every(f => f.code === 'PUNCTUATION_MISMATCH')) {
          const proposed = uniqueCommaDeletion(p.sourceText, item.translation);
          if (proposed != null && validateMarkers(proposed, this.templateOf(p.id)).ok) {
            const proposedFindings = validateTranslation({ source: p.sourceText, translation: proposed, paragraphType: p.paragraphType, flags: item.flags as TranslationFlag[], glossary: this.hitsFor(pack, p.sourceText) });
            if (!hasBlocking(proposedFindings)) {
              this.store.translations.log({ level: 'info', workstationId: ws, paragraphId: p.id, message: JSON.stringify({ kind: 'unique-comma-deletion-candidate-v1', original: item.translation, proposed, aiCallId: r.aiCallId, status: '仅提出候选，仍须完整读感及忠实核查' }) });
              item.translation = proposed; findings = proposedFindings;
            }
          }
        }
        const mk = validateMarkers(item.translation, this.templateOf(p.id));
        if (!mk.ok) findings.push({ code: 'MARKER_ROUNDTRIP_FAILED', severity: 'blocks_export', message: mk.error.message });
        const ok = !hasBlocking(findings);
        out.set(item.id, { aiCallId: r.aiCallId, item, findings, ok,...('layoutProof' in r?{layoutProof:r.layoutProof as LayoutProof}:{}) });
        if (!ok) {
          const signature = JSON.stringify([item.translation, item.flags, findings.filter(f => f.severity === 'blocks_export').map(f => [f.code, f.message])]);
          const seen = rejectedOutputs.get(p.id) ?? new Set<string>();
          if (seen.has(signature)) {
            this.store.translations.log({ level: 'warning', workstationId: ws, paragraphId: p.id, message: JSON.stringify({ kind:'repeated-invalid-generation', aiCallId:r.aiCallId, attempt:attempt+1, message:'已反馈问题但返回相同失败稿，停止本块重复请求；保留稿件和未通过项，不影响其他块' }) });
            continue;
          }
          seen.add(signature); rejectedOutputs.set(p.id, seen);
          next.push(p); rejectedDrafts.set(p.id, item.translation); diagByBlock.set(p.id, `- ${p.id}：${findings.filter(f => f.severity === 'blocks_export').map(f => `${f.code} ${f.message}`).join('；')}`);
        }
      }
      pending = next;
      if (pending.length && attempt < 2) this.store.translations.log({ level: 'warning', workstationId: ws, paragraphId: pending[0]!.id, message: `程序校验阻断 ${pending.length} 块，只重发失败块（第 ${attempt + 1} 次）：${[...diagByBlock.values()].join(' | ').slice(0, 400)}` });
    }
    return out;
  }

  private async processBatch(paras: Para[]): Promise<{ done: number; failed: number; autoAccepted: number; needsReview: number }> {
    const stats = { done: 0, failed: 0, autoAccepted: 0, needsReview: 0 };
    const ids = paras.map(p => p.id);
    const seriesId = this.store.projects.getSeriesIdOfParagraph(ids[0]!);
    const settings = this.store.projects.getSettings(seriesId);

    // 记录批次开始
    this.store.translations.log({
      level: 'info',
      paragraphId: ids[0]!,
      message: `📦 开始处理批次 (${paras.length}段): ${ids.map(id => id.slice(0, 8)).join(', ')}`
    });

    let pack: ContextPack;
    try { pack = buildContextPack(this.store, { paragraphIds: ids, workstation: 'faithful-translator' }); }
    catch (e) {
      this.store.translations.log({
        level: 'error',
        paragraphId: ids[0]!,
        message: `❌ 上下文组装失败：${(e as Error).message}`
      });
      this.failBatch(seriesId, paras, `上下文组装失败：${(e as Error).message}`);
      return { ...stats, failed: paras.length };
    }
    const previousFindingIds = new Map(paras.map(p => [p.id, this.store.translations.openFindings(p.id).filter(f => f.workstation_id !== 'trajectory-reviewer').map(f => f.id)]));
    const previousFinalIds = new Map(paras.map(p => [p.id, this.store.translations.latestFinal(p.id)?.id]));
    const previousReviewItems = this.store.translations.listQueue(seriesId).filter(q => q.paragraphId && q.payload.type !== 'TRAJECTORY' && ids.includes(q.paragraphId) && (q.kind === 'review-block' || q.kind === 'failed'));

    // 1. 忠实初译
    this.store.translations.log({
      level: 'info',
      paragraphId: ids[0]!,
      message: `🔹 阶段1: 忠实初译 (${paras.length}段)`
    });
    const generation = new Map(paras.map(p => [p.id, openGenerationResume(this.store, p.id,
      () => buildContextPack(this.store, { paragraphIds: ids, workstation: 'faithful-translator' }).text+(this.opts.separateInlineLayout?'\n'+separatedGenerationIdentity():''),
      this.allowGenerationResume && !this.store.translations.latestFinal(p.id))]));
    const faithful: ValidatedMap = new Map();
    const restoredIds = new Map<string, string>();
    for (const p of paras) {
      const restored = generation.get(p.id)!.restored;
      if (!restored) continue;
      const findings = validateTranslation({ source: p.sourceText, translation: restored.item.translation, paragraphType: p.paragraphType,
        flags: restored.item.flags as TranslationFlag[], glossary: this.hitsFor(pack, p.sourceText) });
      const markers = validateMarkers(restored.item.translation, this.templateOf(p.id));
      if (hasBlocking(findings) || !markers.ok) continue;
      faithful.set(p.id, { aiCallId: restored.aiCallId, item: restored.item, findings, ok: true });
      restoredIds.set(p.id, restored.candidateId);
      this.store.translations.log({ level: 'info', paragraphId: p.id, workstationId: 'faithful-translator',
        message: `恢复未完成初译候选 ${restored.candidateId}，跳过生成，继续精确稿读感及完整审校` });
    }
    const missing = paras.filter(p => !faithful.has(p.id));
    try {
      if (missing.length) for (const [id, value] of await this.translateWithValidation('faithful-translator', pack, missing, undefined, undefined, ids)) faithful.set(id, value);
    }
    catch (e) { if (e instanceof AiCallFailed) { this.failBatch(seriesId, paras, e.message); return { ...stats, failed: paras.length }; } throw e; }
    this.abort.signal.throwIfAborted();
    const alive: Para[] = [];
    const adopted = new Map<string, { candidateId: string; item: TranslationItem }>();
    for (const p of paras) {
      if (this.store.translations.latestFinal(p.id)?.id !== previousFinalIds.get(p.id)) { stats.needsReview++; continue; }
      const v = faithful.get(p.id);
      if (!v) { this.failParagraph(seriesId, p, [{ code: 'EMPTY_TRANSLATION', severity: 'blocks_export', message: '模型未返回该块' }]); stats.failed++; continue; }
      generation.get(p.id)!.assertCurrent();
      const candidateId = restoredIds.get(p.id) ?? this.store.transaction(() => {
        const id = this.store.translations.addCandidate({ paragraphId: p.id, workstationId: 'faithful-translator', text: v.item.translation, sourceCoverage: v.item.source_coverage, toneAxes: v.item.tone_axes, flags: v.item.flags, aiCallId: v.aiCallId });
        if (v.ok) generation.get(p.id)!.save(id, v.item, v.aiCallId,undefined,v.layoutProof);
        return id;
      });
      adopted.set(p.id, { candidateId, item: v.item });
      if (!v.ok) {
        // 模型三次坚持同一处理：保留译文但标为阻断，交人工裁决（可能是规则误判，也可能模型确实加了原文没有的信息）
        for (const f of v.findings) this.store.translations.addValidationFinding(p.id, f);
        const blockers = v.findings.filter(f => f.severity === 'blocks_export');
        this.store.translations.enqueue({ seriesId, kind: 'review-block', paragraphId: p.id, title: `程序校验 ${blockers.map(f => f.code).join(',')}（重试后仍阻断）`, payload: { type: blockers[0]?.code ?? 'program-check', description: blockers.map(f => f.message).join('；'), source: p.sourceText, translation: v.item.translation, suggestedFix: null, workstation: 'program-check' } });
        this.store.translations.setFinal({ paragraphId: p.id, text: v.item.translation, sourceCandidateId: candidateId, autoAccepted: false });
        generation.get(p.id)!.finish();
        this.store.translations.log({ level: 'warning', paragraphId: p.id, message: `程序校验重试后仍阻断，已保留译文待人工：${blockers.map(f => f.message).join('；').slice(0, 200)}` });
        stats.done++; stats.needsReview++; continue;
      }
      alive.push(p);
    }
    if (!alive.length) return stats;

    // 3. 独立读感检查：明确无需修改的稿件跳过编辑，不能跳过忠实审校。
    const editIssues = new Map<string,NaturalnessAssessment>();
    const needsEditing: Para[] = [];
    for (const p of alive) {
      await this.gate();
      generation.get(p.id)!.assertCurrent();
      try {
        let assessment = await assessNaturalness(this.store,this.ai,p.id,faithful.get(p.id)!.item.translation,this.abort.signal);
        if(this.opts.separateInlineLayout&&await reviewSourceStyle(this.store,this.ai,p.id,faithful.get(p.id)!.item.translation,assessment,this.abort.signal))assessment={id:p.id,decision:'keep',issues:[]};
        editIssues.set(p.id,assessment);
        if (assessment.decision !== 'keep') needsEditing.push(p);
        else this.store.translations.log({level:'info',workstationId:'naturalness-reviewer',paragraphId:p.id,message:'未发现具体中文问题，保留初译，继续独立原文审校'});
      } catch(error) {
        if (this.abort.signal.aborted) throw error;
        if (error instanceof LongNaturalnessBoundaryError) {
          this.store.translations.log({ level: 'warning', workstationId: 'naturalness-reviewer', paragraphId: p.id, message: '长段无法安全分块，保留完整初译并进入待处理；不以编辑改写绕过结构限制' });
          continue;
        }
        needsEditing.push(p);
        this.store.translations.log({level:'warning',workstationId:'naturalness-reviewer',paragraphId:p.id,message:'读感判断未完成，使用保守编辑回退，不视为读感通过：'+(error as Error).message});
      }
    }
    for (const p of alive) {
      if (this.store.translations.latestFinal(p.id)?.id !== previousFinalIds.get(p.id)) {
        const index = needsEditing.findIndex(item => item.id === p.id);
        if (index >= 0) needsEditing.splice(index, 1);
      } else generation.get(p.id)!.assertCurrent();
    }
    this.store.translations.log({
      level: 'info',
      paragraphId: ids[0]!,
      message: `🔹 阶段3: 按需中文编辑 (${needsEditing.length}/${alive.length}段)`
    });
    const finals = new Map<string, string>(alive.map(p => [p.id, faithful.get(p.id)!.item.translation]));
    const postEditReadings = new Map<string, NaturalnessAssessment | null>();
    const selectedProgramFindings = new Map(alive.map(p => [p.id, faithful.get(p.id)!.findings]));
    const mergedFlags = new Map<string, TranslationFlag[]>(alive.map(p => [p.id, [...(faithful.get(p.id)!.item.flags as TranslationFlag[])]]));
    try {
      const edited = needsEditing.length ? await this.translateWithValidation('chinese-editor', pack, needsEditing, finals, editIssues) : new Map<string,Validated>();
      for (const p of needsEditing) {
        const v = edited.get(p.id);
        if (!v) continue;
        v.item={...v.item,flags:inheritForeignNotes(p.sourceText,v.item.translation,v.item.flags,faithful.get(p.id)!.item.flags,pack.glossaryHits) as TranslationItem['flags']};
        const candidateId = this.store.translations.addCandidate({ paragraphId: p.id, workstationId: 'chinese-editor', text: v.item.translation, sourceCoverage: v.item.source_coverage, toneAxes: v.item.tone_axes, flags: v.item.flags, aiCallId: v.aiCallId });
        if (v.ok && v.item.translation !== finals.get(p.id)) {
          await this.gate();
          try { postEditReadings.set(p.id, await assessNaturalness(this.store, this.ai, p.id, v.item.translation, this.abort.signal)); }
          catch (error) {
            if (this.abort.signal.aborted) throw error;
            postEditReadings.set(p.id, null);
            this.store.translations.log({ level: 'warning', workstationId: 'naturalness-reviewer', paragraphId: p.id, message: '编辑后读感复检未完成：' + (error as Error).message });
          }
          selectedProgramFindings.set(p.id, v.findings);
          adopted.set(p.id, { candidateId, item: v.item }); finals.set(p.id, v.item.translation); for (const f of v.item.flags as TranslationFlag[]) if (!mergedFlags.get(p.id)!.some(x => JSON.stringify(x) === JSON.stringify(f))) mergedFlags.get(p.id)!.push(f); }
        else if (!v.ok) this.store.translations.log({ level: 'warning', workstationId: 'chinese-editor', paragraphId: p.id, message: `编辑稿未通过程序校验，回退初译稿：${v.findings.filter(f => f.severity === 'blocks_export').map(f => f.code).join(',')}` });

      }
    } catch (e) { if (e instanceof AiCallFailed) this.store.translations.log({ level: 'error', workstationId: 'chinese-editor', paragraphId: alive[0]!.id, message: `编辑调用失败，沿用初译稿：${e.message}` }); else throw e; }


    // 最终候选必须分别通过源文覆盖、增译和声音/称谓审核。初译快速路径不能豁免编辑稿。
    const blocking = new Set<string>();
    const proofs = new Map<string, AuditProof>();
    const reviewWarnings = new Set<string>();
    // Final review and commit follow source order: later first-person checks must
    // see the earlier paragraph already adopted by this same batch.
    for (const p of [...alive].sort((a, b) => a.seriesOrdinal - b.seriesOrdinal)) {
      try {
        await this.gate();
        if (this.store.translations.latestFinal(p.id)?.id !== previousFinalIds.get(p.id)) { stats.needsReview++; continue; }
        let result = await verifyCandidate(this.store, this.ai, p.id, adopted.get(p.id)!.item, this.abort.signal,undefined,this.opts.separateInlineLayout===true,this.opts.separateInlineLayout===true);
        const wasEdited = finals.get(p.id) !== faithful.get(p.id)!.item.translation;
        if (!result.proof && wasEdited && result.findings.some(f => f.severity === 'blocks_export' && f.code !== 'NATURALNESS_UNRESOLVED') && !result.findings.some(f => f.code === 'REVIEW:CONTEXT_CHANGED')) {
          // 拒绝稿的诊断留在候选日志，不挂到即将采用的初译上。
          this.store.translations.log({ level: 'warning', workstationId: 'chinese-editor', paragraphId: p.id,
            message: '编辑稿审校未通过，开始完整复验初译：' + JSON.stringify({ candidateId: adopted.get(p.id)!.candidateId, findings: result.findings }) });
          await this.gate();
          const initial = faithful.get(p.id)!;
          const fallback = await verifyCandidate(this.store, this.ai, p.id, initial.item, this.abort.signal,undefined,this.opts.separateInlineLayout===true,this.opts.separateInlineLayout===true);
          // Prefer a faithful but awkward original to an edited fidelity error;
          // it stays blocked and receives no full audit receipt until reading passes.
          if (fallback.proof || (fallback.findings.some(f => f.code === 'NATURALNESS_UNRESOLVED') &&
            !fallback.findings.some(f => f.severity === 'blocks_export' && f.code !== 'NATURALNESS_UNRESOLVED'))) {
            const candidateId = this.store.translations.addCandidate({ paragraphId: p.id, workstationId: 'faithful-translator', text: initial.item.translation, sourceCoverage: initial.item.source_coverage, flags: initial.item.flags, toneAxes: initial.item.tone_axes, aiCallId: initial.aiCallId });
            adopted.set(p.id, { candidateId, item: initial.item });
            finals.set(p.id, initial.item.translation);
            mergedFlags.set(p.id, [...initial.item.flags as TranslationFlag[]]);
            selectedProgramFindings.set(p.id, initial.findings);
            postEditReadings.set(p.id, editIssues.get(p.id) ?? null);
            result = fallback;
            this.store.translations.log({ level: 'info', paragraphId: p.id, message: '初译完整忠实复验通过，恢复初译；读感状态另行判断' });
          } else {
            this.store.translations.log({ level: 'warning', paragraphId: p.id, message: '初译与编辑稿均未通过，保留待处理稿，不继续改写：' + JSON.stringify({ findings: fallback.findings }) });
          }
        }
        if (this.store.translations.latestFinal(p.id)?.id !== previousFinalIds.get(p.id)) { stats.needsReview++; continue; }
        const { findings, proof, item } = result;
        findings.push(...selectedProgramFindings.get(p.id)!.filter(f => f.severity !== 'blocks_export'
          && !(f.code === 'LENGTH_VARIANCE' && findings.some(checked => checked.code === 'LENGTH_VARIANCE' && checked.details?.disposition === 'verified-content'))));
        const reading = postEditReadings.has(p.id) ? postEditReadings.get(p.id) : editIssues.get(p.id);
        // A proof includes the final exact naturalness check. Earlier routing failures
        // may explain editing, but cannot override a later successful verification.
        if (!proof && (!reading || reading.decision !== 'keep')) {
          findings.push({ code: 'NATURALNESS_UNRESOLVED', severity: 'blocks_export', message: '当前稿的中文读感仍有问题或尚未确认；已停止继续润色，需复核' + (reading?.issues.length ? '：' + JSON.stringify(reading.issues) : '') });
        }
        // A new keep receipt records a general reading verdict; it
        // does not prove that each concrete issue which caused the edit was
        // actually resolved. Keep those old issues in a separate, exact
        // resolution review. Generic "not checked" state is handled by proof.
        const priorNaturalness = editIssues.get(p.id);
        const priorIssues = item.translation !== faithful.get(p.id)!.item.translation && proof && priorNaturalness?.decision === 'edit'
          ? naturalnessRepairIssues(p.id, priorNaturalness.issues) : [];
        if (priorIssues.length && proof) {
          const context = (auditInput(this.store, p.id).pack.sourceContextIds ?? [])
            .map(id => this.store.projects.getParagraph(id)).filter(item => item != null)
            .map(item => ({ id: item.id, source: item.sourceText }));
          const resolution = await reviewRepairResolution(this.ai, p.id, p.sourceText, faithful.get(p.id)!.item.translation,
            item.translation, priorIssues, this.abort.signal, context);
          this.abort.signal.throwIfAborted();
          generation.get(p.id)!.assertCurrent();
          if (this.store.translations.latestFinal(p.id)?.id !== previousFinalIds.get(p.id)) { stats.needsReview++; continue; }
          this.store.translations.log({ level: 'info', workstationId: 'repair-resolution-reviewer', paragraphId: p.id,
            message: JSON.stringify({ contract: 'initial-edit-issue-resolution-v1', inputHash: proof.inputHash, candidateHash: proof.candidateHash, resolution }) });
        }
        {
          // Retain the actual alignment even for blocked candidates, for precise recovery.
          const origin = this.store.translations.candidateById(adopted.get(p.id)!.candidateId)!;
          const candidateId = this.store.translations.addCandidate({ paragraphId: p.id, workstationId: origin.workstation_id, text: item.translation, sourceCoverage: item.source_coverage, flags: item.flags, toneAxes: item.tone_axes, aiCallId: origin.ai_call_id });
          adopted.set(p.id, { candidateId, item });
          mergedFlags.set(p.id, item.flags as TranslationFlag[]);
        }
        if (proof) proofs.set(p.id, proof);
        if (findings.some(f => f.severity === 'warning')) reviewWarnings.add(p.id);
        for (const f of findings) {
          this.store.translations.addValidationFinding(p.id, f);
          if (f.severity === 'blocks_export') {
            blocking.add(p.id);
            this.store.translations.enqueue({ seriesId, kind: 'review-block', paragraphId: p.id, title: f.message.slice(0, 80), payload: { type: f.code, severity: f.severity, source: p.sourceText, translation: finals.get(p.id), description: f.message } });
          }
        }
      } catch (error) {
        if (this.abort.signal.aborted) throw error;
        blocking.add(p.id);
        const reading = postEditReadings.has(p.id) ? postEditReadings.get(p.id) : editIssues.get(p.id);
        const concrete = editIssues.get(p.id)?.decision === 'edit' ? editIssues.get(p.id)!.issues : [];
        if (concrete.length) for (const issue of naturalnessRepairIssues(p.id, concrete)) this.store.translations.addFinding({ paragraphId: p.id, workstationId: 'naturalness-reviewer', findingType: issue.type, severity: 'blocks_export', description: issue.description, evidenceZh: issue.target_quote });
        else if (!reading || reading.decision !== 'keep') this.store.translations.addFinding({ paragraphId: p.id, workstationId: 'naturalness-reviewer', findingType: 'NATURALNESS_UNRESOLVED', severity: 'blocks_export', description: '读感验收尚未完成，恢复时必须重新检查' });
        const message = '审校未完成：' + (error as Error).message;
        this.store.translations.addFinding({ paragraphId: p.id, workstationId: 'program-check', findingType: 'REVIEW_INCOMPLETE', severity: 'blocks_export', description: message });
        this.store.translations.enqueue({ seriesId, kind: 'review-block', paragraphId: p.id, title: message.slice(0, 80), payload: { type: 'REVIEW_INCOMPLETE', severity: 'blocks_export', source: p.sourceText, translation: finals.get(p.id) } });
      }

      // Commit synchronously before verifying the next dependent paragraph.
      this.abort.signal.throwIfAborted();
      if (this.store.translations.latestFinal(p.id)?.id !== previousFinalIds.get(p.id)) { stats.needsReview++; continue; }
      this.store.transaction(() => {
      try { generation.get(p.id)!.assertCurrent(); }
      catch (error) {
        if (!(error instanceof GenerationResumeContextChangedError)) throw error;
        // Review-time input changes are actionable pending work, not permission to adopt a stale draft.
        // Keep every candidate and any prior final; skip routing, receipt binding and issue resolution.
        const message = '审校期间初译依据已变化；已保留候选和原稿，未采纳旧结果。请继续本册或重新翻译，以当前依据生成并完整复核。';
        this.store.translations.addFinding({ paragraphId: p.id, workstationId: 'program-check', findingType: 'GENERATION_CONTEXT_CHANGED', severity: 'blocks_export', description: message });
        this.store.translations.enqueue({ seriesId, kind: 'review-block', paragraphId: p.id, title: message, payload: { type: 'GENERATION_CONTEXT_CHANGED', severity: 'blocks_export', description: message, source: p.sourceText, translation: finals.get(p.id), candidateId: adopted.get(p.id)!.candidateId } });
        this.store.translations.log({ level: 'warning', paragraphId: p.id, message });
        stats.needsReview++;
        return;
      }
      const a = this.store.projects.currentAnalysis(p.id);
      const speakerId = a?.speaker_char_id ?? null;
      const route = routeFlags(this.store, { seriesId, paragraphId: p.id, seriesOrdinal: p.seriesOrdinal, sourceText: p.sourceText, translation: finals.get(p.id)!, flags: mergedFlags.get(p.id)!, glossaryHits: this.hitsFor(pack, p.sourceText), speakerCharId: speakerId });
      const rubyPlan = rebuildCandidateRuby(this.store, p.id, adopted.get(p.id)!.item, this.store.translations.latestFinal(p.id));
      const ruby = rubyPlan.ruby;
      const proof = proofs.get(p.id);
      const rubyFindings = [...rubyPlan.findings];
      if (proof && proof.rubyInputHash !== rubyPlan.inputHash) rubyFindings.push({ code: 'REVIEW:CONTEXT_CHANGED', severity: 'blocks_export', message: '定稿前一人称标注依据已变化，请重新复核当前稿' });
      for (const finding of rubyFindings) {
        blocking.add(p.id); proofs.delete(p.id);
        this.store.translations.addValidationFinding(p.id, finding);
        this.store.translations.enqueue({ seriesId, kind: 'review-block', paragraphId: p.id, title: finding.message, payload: { type: finding.code, source: p.sourceText, translation: finals.get(p.id), description: finding.message } });
      }
      const candidateId = adopted.get(p.id)!.candidateId;
      const hasPendingKnowledge = pendingFieldConflicts(this.store,seriesId,p.seriesOrdinal).length > 0 || this.store.translations.listQueue(seriesId).some(q => q.paragraphId === p.id && q.kind !== 'review-block' && q.kind !== 'failed');
      let auto = !route.mustReview && !blocking.has(p.id) && !hasPendingKnowledge && !reviewWarnings.has(p.id);
      // 被动倒置（让N被V）警告：优先质量，命中即转人工复核，不快速路径自动确认
      const passive = checkPassiveInversion(finals.get(p.id)!);
      if (passive.bad) {
        this.store.translations.addFinding({ paragraphId: p.id, workstationId: 'program-check', findingType: 'PASSIVE_INVERSION', severity: 'warning', description: `译文用「让…被…」把宾语置于「被」前，比原文更提前，疑似被动倒置：「${passive.matched}」。若原文确为被动可保留，否则改为「让其＋动词＋宾语」（如「让其嗅到硝烟的芳香」）。` });
        this.store.translations.enqueue({ seriesId, kind: 'warning', paragraphId: p.id, title: `被动倒置：「${passive.matched}」`, payload: { type: 'PASSIVE_INVERSION', matched: passive.matched, source: p.sourceText, translation: finals.get(p.id)!, suggestedFix: '改为“让其＋动词＋宾语”，保持宾语在动词后' } });
        auto = false;
      }
      const finalId = this.store.translations.setFinal({ paragraphId: p.id, text: finals.get(p.id)!, ruby, sourceCandidateId: candidateId, autoAccepted: auto });
      const finalProof = proofs.get(p.id);
      if (finalProof) bindAuditReceipt(this.store, finalId, finalProof);
      generation.get(p.id)!.finish();
      if (!blocking.has(p.id)) {
        for (const findingId of previousFindingIds.get(p.id) ?? []) this.store.translations.resolveFinding(findingId);
        for (const issue of previousReviewItems.filter(q => q.paragraphId === p.id)) {
          if (this.store.translations.getQueueItem(issue.id)?.status === 'pending') this.store.translations.resolveQueueItem(issue.id, JSON.stringify({ action: 'verified-replacement', candidateId }));
        }
        this.store.translations.markRecheckDone(p.id);
      }
      exposeUnacceptedWarnings(this.store, p.id);
      if (auto) stats.autoAccepted++; else stats.needsReview++;
      stats.done++;
      this.store.translations.log({ level: blocking.has(p.id) ? 'warning' : 'success', paragraphId: p.id, message: `${auto ? '完整审校通过' : blocking.has(p.id) ? '审校阻断，待人工' : route.mustReview ? `待人工（${route.enqueued.join(',')}）` : '完成，待确认'}${route.deviationWarnings ? `；术语偏离提醒 ${route.deviationWarnings}` : ''}` });
      });
    }

    // 批次完成总结
    this.store.translations.log({
      level: 'success',
      paragraphId: ids[0]!,
      message: `✅ 批次完成: ${stats.done}段完成 | ${stats.autoAccepted}段自动确认 | ${stats.needsReview}段待人工 | ${stats.failed}段失败`
    });

    return stats;
  }

  private failParagraph(seriesId: string, p: Para, findings: ValidationFinding[]): void {
    for (const f of findings) this.store.translations.addValidationFinding(p.id, f);
    this.store.translations.enqueue({ seriesId, kind: 'failed', paragraphId: p.id, title: `程序校验重试后仍失败：${findings.filter(f => f.severity === 'blocks_export').map(f => f.code).join(',')}`, payload: { findings, source: p.sourceText } });
    this.store.translations.log({ level: 'error', paragraphId: p.id, message: `失败：${findings.filter(f => f.severity === 'blocks_export').map(f => f.message).join('；').slice(0, 200)}` });
  }
  private failBatch(seriesId: string, paras: Para[], message: string): void {
    for (const p of paras) { this.store.translations.enqueue({ seriesId, kind: 'failed', paragraphId: p.id, title: `AI 调用失败：${message.slice(0, 80)}`, payload: { error: message, source: p.sourceText } }); }
    this.store.translations.log({ level: 'error', paragraphId: paras[0]!.id, message: `批次失败（${paras.length} 段）：${message.slice(0, 200)}` });
  }
}

export type { AnalysisRow };
export const readAnalysisFlags = (a: AnalysisRow | undefined): string[] => fromJson<string[]>(a?.difficulty_flags, []);
