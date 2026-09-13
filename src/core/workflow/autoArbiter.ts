import {inheritForeignNotes} from './foreignNotes';
import {originalRubyContext} from './originalRubyContext';
import { pendingFieldConflicts } from './characterConflicts';
import { exposeUnacceptedWarnings } from './reviewWarnings';
import { longReadingBoundary } from './longReadingRecovery';
/** 自动仲裁：知识仅预选；正文修复必须经过与翻译相同的完整验证。 */
import type { ProjectStore } from '@core/db';
import { AiClient, buildContextPack, parseTranslation, ProviderError, type TranslationItem } from '@core/ai';
import { hasBlocking, normalizeGeneratedStutter } from '@core/validation';
import { verifyCandidate } from './verifyCandidate';
import {generateSeparatedRepair,separatedRepairTemplate} from './separatedRepair';
import {restoreSourceDashGlyphs} from '../validation/sourceDashGlyphs';
import {restoreMissingWholeParagraphBoundary} from '../validation/missingWholeParagraphBoundary';
import {isAlignmentPendingState} from './alignmentState';
import { reverifyFinal } from './reverifyFinal';
import { naturalnessRepairIssues, reviewRepairResolution } from './repairResolution';
import { generationConstraints } from '../ai/prompts/generationConstraints';
import { longParagraphParts } from './longParagraphDraft';
import { currentCandidateRepairSpan, currentCandidateRepairSpans } from './currentCandidateRepairSpan';
import type { InlineTemplate } from '../epub/blocks';
import { needsSemanticPreparation, prepareWithEvidence, sourceRelationReviewText } from './semanticPreparation';
import { assertRepairWorkAllowed, beginRepairAttempt, clearRepairAttempts, RepairLimitError, repairInputStamp } from './repairAttempts';
import { openGenerationResume } from './generationResume';
import { reviewDisputes } from './disputeReview';
import { auditInput, bindAuditReceipt } from './auditReceipts';
import { assessNaturalness } from './naturalness';
import { localEditorRequest, localSourceContext, sourceRelationReminder } from './localEditorRequest';
import { punctuationRepairRequest } from './punctuationRepairRequest';
import { proposePunctuationProjection } from './punctuationProjection';
import { routeFlags } from './flagRouter';
import { requireCandidateRuby } from './rubyPlan';
import { selectRepairSpan, continueRepairSpan, SYNTAX_RECOVERY_INSTRUCTION } from './repairSpan';
import { syntaxHintsFor } from '../ai/prompts/syntaxHints';
import type { TranslationFlag } from '@shared/types';

// A length ratio is a diagnostic, not proof of missing/added meaning. Keep its
// stored warning and normal validation, but never ask a writer to fix the ratio.
const isStatisticalLengthWarning = (f: { workstation_id: string; finding_type: string; severity: string; evidence_jp: string | null; evidence_zh: string | null }) =>
  f.workstation_id === 'program-check' && f.finding_type === 'LENGTH_VARIANCE' && f.severity === 'warning' && !f.evidence_jp && !f.evidence_zh;

export interface AutoArbitrateResult {
  autoResolved: number; leftForHuman: number; adoptedFix: number; rejectedFix: number; preselected: number; details: string[];
}

export class AutoArbiter {
  constructor(private readonly store: ProjectStore) {}
  private preselectCandidate(queueItemId: string, kind: string, pl: Record<string, unknown>): boolean {
    let preSelected: string | null = null;
    let basis = '';
    if (kind === 'term-proposal') {
      const cands = pl.candidates as { zh: string; basis?: string; cons?: string }[] | undefined;
      if (cands?.length) {
        // 优先取有明显缺点最少的候选：有 cons 的往后排，选第一个无 cons 或推荐项
        const clean = cands.find(c => !c.cons) ?? cands[0];
        preSelected = clean?.zh ?? null;
        basis = clean?.basis ? `候选${clean.basis === 'official' ? '（官方）' : clean.basis === 'phonetic' ? '（音译）' : '（意译）'}` : '候选首项';
      }
    } else if (kind === 'ambiguity') {
      preSelected = (pl.inferred ?? pl.usedZh ?? null) as string | null;
      basis = pl.inferred ? '推断' : '初译用法';
    } else if (kind === 'honorific-first') {
      if (pl.needsContextConfirmation === true) return false;
      // 只有已生成候选（称谓解析/预扫描跑过）的项才能预选：取 AI 推荐，否则取首候选
      const cands = pl.candidates as { zh: string }[] | undefined;
      if (cands?.length) { preSelected = (typeof pl.recommended === 'string' && cands.some(c => c.zh === pl.recommended) ? pl.recommended : cands[0]!.zh) as string; basis = pl.recommended ? 'AI 推荐' : '候选首项'; }
    }
    if (!preSelected) return false;
    // 写回 payload（不覆盖已有 preSelected，避免重复运行覆盖用户已看过的选择）
    const cur = this.store.translations.getQueueItem(queueItemId)?.payload as Record<string, unknown> | undefined;
    if (cur?.preSelected) return false;
    this.store.translations.updateQueuePayload(queueItemId, { ...pl, preSelected, preSelectedBasis: basis });
    return true;
  }


  arbitrateAll(seriesId: string): AutoArbitrateResult {
    const result: AutoArbitrateResult = { autoResolved: 0, leftForHuman: 0, adoptedFix: 0, rejectedFix: 0, preselected: 0, details: [] };
    for (const item of this.store.translations.listQueue(seriesId)) {
      if (['term-proposal', 'ambiguity', 'honorific-first'].includes(item.kind) && this.preselectCandidate(item.id, item.kind, item.payload as Record<string, unknown>)) result.preselected++;
      result.leftForHuman++;
    }
    return result;
  }

  async arbitrateAsync(seriesId: string, ai: AiClient, signal?: AbortSignal, paragraphIds?: readonly string[]): Promise<{ finalized: number; stillPending: number; details: string[] }> {
    // Share candidate assessments within this invocation, including callers without cancellation.
    signal ??= new AbortController().signal;
    const result = { finalized: 0, stillPending: 0, details: [] as string[] };
    const scope = paragraphIds ? new Set(paragraphIds) : null;
    if (scope) for (const id of scope) if (this.store.projects.getSeriesIdOfParagraph(id) !== seriesId) throw new Error('修复段落不属于当前作品');
    const pending = this.store.translations.listQueue(seriesId).filter(q => (q.kind === 'review-block' || (scope && q.kind === 'failed')) && q.payload.type !== 'TRAJECTORY' && q.paragraphId && (!scope || scope.has(q.paragraphId)));
    for (const paragraphId of scope ?? new Set(pending.map(q => q.paragraphId!))) {
      if (signal?.aborted) throw new ProviderError('abort', '已取消');
      const previous = this.store.translations.latestFinal(paragraphId);
      const paragraph = this.store.projects.getParagraph(paragraphId);
      if (!previous || !paragraph || previous.confirmed_by_user) { result.stillPending++; continue; }
      const boundary = longReadingBoundary(paragraph, previous.final_text);
      if (boundary) { result.stillPending++; result.details.push(boundary.message); continue; }
      let findings = this.store.translations.openFindings(paragraphId).filter(f => f.workstation_id !== 'trajectory-reviewer');
      const obsoleteFindings = [...findings];
      const problems = pending.filter(q => q.paragraphId === paragraphId);
      let undoAttempt: (() => void) | undefined;
      try {
        assertRepairWorkAllowed(this.store, paragraphId);
        if (!findings.length || findings.every(isStatisticalLengthWarning) || findings.some(f => (f.evidence_jp && !paragraph.sourceText.includes(f.evidence_jp)) || (f.evidence_zh && !previous.final_text.includes(f.evidence_zh)))) {
          const refreshed = await reverifyFinal(this.store, ai, paragraphId, signal, true);
          if (refreshed.ok) { result.finalized++; result.details.push('当前稿重新核查通过，无需改写：' + paragraphId); continue; }
          if (!refreshed.diagnosticIds?.length) throw new Error(refreshed.message);
          findings = this.store.translations.openFindings(paragraphId).filter(f => refreshed.diagnosticIds!.includes(f.id));
          if (findings.some(f => ['REVIEW_INVALID_EVIDENCE', 'REVIEW_MISSING_EVIDENCE', 'REVIEW:CONTEXT_CHANGED'].includes(f.finding_type))) throw new Error('重新审核证据无效，保留原稿与待办');
        }
        const inputHash = auditInput(this.store, paragraphId).inputHash;
        // Keep full history in storage; repeated identical observations are one repair task.
        const uniqueFindings = [...new Map(findings.filter(f => f.severity !== 'info' && !isStatisticalLengthWarning(f)).map(f => [JSON.stringify([f.finding_type, f.severity, f.description, f.evidence_jp, f.evidence_zh]), f])).values()];
        if (!uniqueFindings.length) {
          result.stillPending++; result.details.push('仅剩长度统计提示，没有具体语义修复目标；保留原稿与提示：' + paragraphId); continue;
        }
        const priorReading = uniqueFindings.some(f => f.finding_type === 'NATURALNESS_UNRESOLVED')
          ? await assessNaturalness(this.store, ai, paragraphId, previous.final_text, signal) : null;
        const priorCandidate = previous.source_candidate_id ? this.store.translations.candidateById(previous.source_candidate_id) : undefined;
        let repairSpan: ReturnType<typeof selectRepairSpan> = null;
        let preservedFlags: TranslationFlag[] = [];
        if (priorReading?.decision === 'edit' && uniqueFindings.every(f => f.finding_type === 'NATURALNESS_UNRESOLVED') && priorCandidate?.candidate_text === previous.final_text) {
          try {
            const flags = JSON.parse(priorCandidate.flags ?? '[]');
            if (Array.isArray(flags)) {
              preservedFlags = flags;
              repairSpan = selectRepairSpan(paragraph.sourceText, previous.final_text, JSON.parse(priorCandidate.source_coverage ?? '[]'), priorReading.issues.map(i => i.quote_zh));
              if (!repairSpan) {
                const block = this.store.archives.blocksOfParagraph(paragraphId)[0];
                const template: InlineTemplate = block?.inline_template ? JSON.parse(block.inline_template) : {markers:[]};
                repairSpan = currentCandidateRepairSpan(paragraph.sourceText, previous.final_text, JSON.parse(priorCandidate.source_coverage ?? '[]'), priorReading.issues.map(i => i.quote_zh), template);
              }
            }
          } catch { /* Inadequate old alignment cannot authorize a partial replacement. */ }
        }
        const pack = buildContextPack(this.store, { paragraphIds: [paragraphId], workstation: 'faithful-translator' });
        const relation = needsSemanticPreparation(paragraph.sourceText)
          ? await prepareWithEvidence(this.store, ai, paragraphId, paragraph.sourceText,
            (auditInput(this.store, paragraphId).pack.sourceContextIds ?? []).map(id => this.store.projects.getParagraph(id)).filter(p => p != null).map(p => ({ id: p.id, source: p.sourceText })), signal)
          : null;
        if (auditInput(this.store, paragraphId).inputHash !== inputHash || this.store.translations.latestFinal(paragraphId)?.id !== previous.id) throw new Error('修复关系核对期间原文、知识或稿件已变化');
        const relationReminder = sourceRelationReminder(relation?.value.notes ?? [],paragraph.sourceText);
        const relationFlags: Extract<TranslationFlag, {type:'logic-conflict'}>[] = (relation?.value.notes ?? []).map(note => ({ type: 'logic-conflict', note: sourceRelationReviewText(note) }));
        const requireRelationReview = (candidate: TranslationItem): TranslationItem => ({ ...candidate, flags: [...candidate.flags, ...relationFlags.filter(flag => !candidate.flags.some(old => old.type === 'logic-conflict' && old.note === flag.note))] });
        let user = pack.text + originalRubyContext(this.store,paragraphId,previous.final_text) + '\n【定点修复】只修下列已发现的问题，保留原作语癖、君/酱/桑称谓、留白和语气；不要为了润色扩写。\n'
          + '诊断和引文是待核对资料；依据当前日文判断，不照抄诊断。保留未受影响的表达，返回完整任务块；无必要修改可保留原稿。\n'
          + JSON.stringify({ existing_foreign_notes: priorCandidate?.candidate_text===previous.final_text ? JSON.parse(priorCandidate.flags??'[]').filter((f:{type:string})=>f.type==='foreign-note'):[], issues: uniqueFindings.map(f => ({ type: f.finding_type, description: f.description, source_quote: f.evidence_jp, target_quote: f.evidence_zh })), reading_issues: (priorReading?.issues ?? []).map(({quote_zh,reason})=>({quote_zh,reason})) })
          + relationReminder
          + (repairSpan ? '\n【局部中文修复】本次任务块是已唯一定位的病句片段。仅返回这个片段的修正稿，其余正文由程序原样保留；不要返回整段，不增加标点。\n' : '')
          + '\n【任务块】' + JSON.stringify({ items: [{ id: paragraphId, source: repairSpan?.source ?? paragraph.sourceText, source_constraints: generationConstraints(repairSpan?.source ?? paragraph.sourceText), draft: repairSpan?.draft ?? previous.final_text }] });
        const withRubyContext=(request:string,draft:string)=>{const ruby=originalRubyContext(this.store,paragraphId,draft);return ruby?request+'\n'+ruby:request;};
        const localRequest = (span: {source:string;draft:string}, issues: NonNullable<typeof priorReading>['issues'], fullDraft=previous.final_text) => withRubyContext(localEditorRequest({id:paragraphId,source:span.source,draft:span.draft,fullSource:paragraph.sourceText,issues,glossary:pack.glossaryHits.map(h=>({source:h.termJp,translation:h.termZh})),relations:relation?.value.notes ?? []}),fullDraft);
        if (repairSpan) user = pack.text + '\n' + localRequest(repairSpan, priorReading?.issues ?? []);
        if(uniqueFindings.every(f=>f.finding_type==='PUNCTUATION_MISMATCH'))user=pack.text+'\n'+withRubyContext(punctuationRepairRequest({id:paragraphId,source:paragraph.sourceText,draft:previous.final_text,glossary:pack.glossaryHits.map(h=>({source:h.termJp,translation:h.termZh}))}),previous.final_text);
        try { undoAttempt = beginRepairAttempt(this.store, paragraphId); }
        catch (error) {
          if (!(error instanceof RepairLimitError) || !error.canReviewDispute) throw error;
          undoAttempt = beginRepairAttempt(this.store, paragraphId, true);
          if(uniqueFindings.some(f=>f.finding_type==='PUNCTUATION_MISMATCH'))throw new Error('标点差异由程序确认，不能用语义争议撤销；本次修复次数已用完，原稿和诊断已保留');
          const context = (auditInput(this.store, paragraphId).pack.sourceContextIds ?? []).map(id => this.store.projects.getParagraph(id)).filter(p => p != null).map(p => ({id:p.id,source:p.sourceText}));
          const disputes = await reviewDisputes(ai, paragraphId, paragraph.sourceText, previous.final_text,
            uniqueFindings.map(f => ({id:f.id,type:f.finding_type,description:f.description,source_quote:f.evidence_jp,target_quote:f.evidence_zh})), context, signal);
          signal?.throwIfAborted();
          if (auditInput(this.store, paragraphId).inputHash !== inputHash || this.store.translations.latestFinal(paragraphId)?.id !== previous.id) throw new Error('争议复核期间原文、知识或稿件已变化');
          this.store.translations.log({level:'info',workstationId:'dispute-reviewer',paragraphId,message:JSON.stringify({contract:'dispute-v1',inputHash,finalId:previous.id,disputes})});
          if (disputes.some(d => d.verdict.decision === 'uncertain')) throw new Error('争议原文证据仍不足，保留原稿与待办：' + disputes.at(-1)!.verdict.reason);
          if (disputes.every(d => d.verdict.decision === 'retain')) {
            if (relationFlags.length) {
              const checkedRelations = await reviewRepairResolution(ai, paragraphId, paragraph.sourceText, previous.final_text, previous.final_text,
                relationFlags.map((flag, index) => ({ id: `repair-relation-${index}`, type: 'logic-conflict', description: flag.note, source_quote: null, target_quote: null })), signal, context);
              if (auditInput(this.store, paragraphId).inputHash !== inputHash || this.store.translations.latestFinal(paragraphId)?.id !== previous.id) throw new Error('保留原稿关系核查期间稿件或依据已变化');
              this.store.translations.log({ level:'info', workstationId:'repair-resolution-reviewer', paragraphId, message:JSON.stringify({contract:'retained-repair-relations-v1',inputHash,finalId:previous.id,checkedRelations}) });
            }
            if ((await assessNaturalness(this.store, ai, paragraphId, previous.final_text, signal, { refreshAfterRetainedDispute: true })).decision !== 'keep') throw new Error('争议复核建议保留，但原稿读感尚未通过');
            if (auditInput(this.store, paragraphId).inputHash !== inputHash || this.store.translations.latestFinal(paragraphId)?.id !== previous.id) throw new Error('争议复核后稿件或依据已变化');
            const checked = await reverifyFinal(this.store, ai, paragraphId, signal, true);
            if (!checked.ok) throw new Error('争议建议保留未获完整复核通过，原问题仍保留');
            clearRepairAttempts(this.store, paragraphId); result.finalized++; continue;
          }
          user += '\n【争议复核的待核对方向，日文优先，不可扩写】' + JSON.stringify(disputes.map(d => ({decision:d.verdict.decision,source_quote:d.verdict.source_quote,target_quote:d.verdict.target_quote,direction:d.verdict.direction,reason:d.verdict.reason})));
        }
        const generationWorkstation = repairSpan ? 'chinese-editor' as const : 'faithful-translator' as const;
        const separatedTemplate = !repairSpan ? separatedRepairTemplate(this.store,paragraphId) : null;
        // The shared resume slot is purpose-bound. Attempt accounting above still applies to every continuation.
        const resume = !repairSpan && !separatedTemplate ? openGenerationResume(this.store, paragraphId,
          () => JSON.stringify([buildContextPack(this.store, { paragraphIds: [paragraphId], workstation: 'faithful-translator' }).text, repairInputStamp(this.store, paragraphId)]),
          true, { purpose: 'repair', contract: 'complete-faithful-repair-v1', allowEditedCandidate:true }) : null;
        const restored = resume?.restored;
        const generated = restored ? { value: { items: [restored.item] }, aiCallId: restored.aiCallId }
          : separatedTemplate ? await generateSeparatedRepair({store:this.store,ai,id:paragraphId,source:paragraph.sourceText,draft:previous.final_text,template:separatedTemplate,issues:{findings:uniqueFindings.map(f=>({type:f.finding_type,description:f.description,source_quote:f.evidence_jp,target_quote:f.evidence_zh})),reading:priorReading?.issues??[]},relations:relationReminder,signal,check:async()=>{signal.throwIfAborted();if(auditInput(this.store,paragraphId).inputHash!==inputHash||this.store.translations.latestFinal(paragraphId)?.id!==previous.id)throw Error('正文版式修复期间原文、知识或稿件已变化');}})
          : await ai.structured({ workstation: generationWorkstation, user, paragraphId, ...(signal ? { signal } : {}), parseRetries: 1 }, text => parseTranslation(text, [paragraphId]));
        signal?.throwIfAborted(); resume?.assertCurrent();
        if (auditInput(this.store, paragraphId).inputHash !== inputHash || this.store.translations.latestFinal(paragraphId)?.id !== previous.id) throw new Error('生成期间原文、知识或稿件已变化，请重新复核');
        let item = requireRelationReview(generated.value.items[0]!);
        if (repairSpan) {
          if (item.translation === repairSpan.draft) throw new Error('局部编辑原样返回仍有疑点的表达，保留原稿与问题，不重复付费审校');
          item = { ...item, translation: previous.final_text.slice(0, repairSpan.start) + item.translation + previous.final_text.slice(repairSpan.end), flags: [...preservedFlags, ...item.flags] };
          this.store.translations.log({ level: 'info', workstationId: generationWorkstation, paragraphId, message: JSON.stringify({ contract: 'aligned-language-repair-v1', previousFinalId: previous.id, start: repairSpan.start, end: repairSpan.end, aiCallId: generated.aiCallId }) });
        }
        let candidateCallId = generated.aiCallId;
        let candidateWorkstation: 'faithful-translator' | 'chinese-editor' | 'sentence-translator' = restored?.workstation ?? generationWorkstation;
        const normalizeDraft = () => {
          const normalized = normalizeGeneratedStutter(item.translation);
          if (normalized !== item.translation) this.store.translations.log({ level: 'info', workstationId: candidateWorkstation, paragraphId, message: '按中文停顿规则规范修复稿的结巴逗号；原始响应保留，规范后仍须完整审校' });
          const rawTemplate=this.store.archives.blocksOfParagraph(paragraphId)[0]?.inline_template;
          const wrapped=separatedTemplate||!rawTemplate?normalized:restoreMissingWholeParagraphBoundary(paragraph.sourceText,normalized,JSON.parse(rawTemplate));
          if(wrapped!==normalized)this.store.translations.log({level:'info',workstationId:candidateWorkstation,paragraphId,message:'按原文恢复唯一整段版式外框；可见正文不变，原始响应保留，随后完整审校'});
          const restoredDashes=separatedTemplate?wrapped:restoreSourceDashGlyphs(paragraph.sourceText,wrapped);
          if(restoredDashes!==wrapped)this.store.translations.log({level:'info',workstationId:candidateWorkstation,paragraphId,message:'按原文恢复等数量破折号的字符；不改正文或其他停顿，随后完整审校'});
          item = { ...item, translation: restoredDashes };
        };
        normalizeDraft();
        let validation = await verifyCandidate(this.store, ai, paragraphId, item, signal, undefined, true, true);
        item = validation.item;
        const blockingChecks = validation.findings.filter(f => f.severity === 'blocks_export');
        if (resume && !restored && generationWorkstation === 'faithful-translator' && blockingChecks.length && blockingChecks.every(f => f.code === 'NATURALNESS_UNRESOLVED')) {
          signal?.throwIfAborted(); resume.assertCurrent();
          this.store.transaction(() => {
            const candidateId = this.store.translations.addCandidate({ paragraphId, workstationId: 'faithful-translator', text: item.translation, sourceCoverage: item.source_coverage, flags: item.flags, toneAxes: item.tone_axes, aiCallId: generated.aiCallId });
            resume.save(candidateId, item, generated.aiCallId);
          });
        }
        if (blockingChecks.length && blockingChecks.every(f => ['NATURALNESS_UNRESOLVED', 'PUNCTUATION_MISMATCH'].includes(f.code))) {
          const punctuation = blockingChecks.filter(f => f.code === 'PUNCTUATION_MISMATCH');
          const reading = punctuation.length
            ? { decision: 'edit', issues: punctuation.map(f => ({ quote_zh: item.translation, reason: f.message, constraint: '对照原文调整句法和标点，不能增删原文没有允许的停顿，保留全部事实和语气' })) }
            : await assessNaturalness(this.store, ai, paragraphId, item.translation, signal);
          if (reading.decision === 'edit') {
            const block = this.store.archives.blocksOfParagraph(paragraphId)[0];
            const template: InlineTemplate = block?.inline_template ? JSON.parse(block.inline_template) : {markers:[]};
            const originalContinuation = repairSpan ? continueRepairSpan(previous.final_text, item.translation, repairSpan,
              punctuation.length ? [] : reading.issues.map(i => i.quote_zh)) : null;
            const currentReadingSpan = !originalContinuation && !punctuation.length
              ? currentCandidateRepairSpan(paragraph.sourceText, item.translation, item.source_coverage, reading.issues.map(i => i.quote_zh), template) : null;
            const continuation = originalContinuation ?? currentReadingSpan;
            const separateSpans = !continuation && !punctuation.length
              ? currentCandidateRepairSpans(paragraph.sourceText, item.translation, item.source_coverage, reading.issues.map(i => i.quote_zh), template) : null;
            const recoverySource = continuation?.source ?? paragraph.sourceText;
            // One bounded language pass on the repaired candidate. Original fidelity
            // issues remain in scope, and the edited result must pass every check again.
            const punctuationOnly = !continuation && blockingChecks.every(f => f.code === 'PUNCTUATION_MISMATCH');
            const skipRepeatedPunctuation=punctuationOnly&&!restored&&uniqueFindings.every(f=>f.finding_type==='PUNCTUATION_MISMATCH')&&item.translation===previous.final_text;
            const separatedRecovery=!!separatedTemplate&&!continuation&&!separateSpans&&!skipRepeatedPunctuation;
            const recoveryWorkstation = skipRepeatedPunctuation?candidateWorkstation:separatedRecovery || punctuationOnly || currentReadingSpan || separateSpans ? 'chinese-editor' as const : 'sentence-translator' as const;
            const recoveryUser = punctuationOnly
              ? withRubyContext(punctuationRepairRequest({id:paragraphId,source:recoverySource,draft:item.translation,glossary:pack.glossaryHits.map(h=>({source:h.termJp,translation:h.termZh}))}),item.translation)
              : currentReadingSpan
              ? localRequest(currentReadingSpan, reading.issues,item.translation)
              : continuation
              ? JSON.stringify({source_context:localSourceContext(paragraph.sourceText,recoverySource),glossary:pack.glossaryHits.map(h=>({source:h.termJp,translation:h.termZh})), syntax_hints:syntaxHintsFor(recoverySource), expression_constraints:[...(priorReading?.issues??[]),...reading.issues].map(({reason})=>({reason}))}) + '\n' + SYNTAX_RECOVERY_INSTRUCTION
                + '\n其余正文由程序保留。本片段中文逗号数须为' + (recoverySource.match(/[、，,]/gu) ?? []).length + '，其余标点逐一保留。'
                + '\n【任务块】' + JSON.stringify({items:[{id:paragraphId,source:recoverySource,source_constraints:generationConstraints(recoverySource)}]})
              : pack.text + '\n【从原文重新表达】上次修复仍有句法或标点问题。本次不提供待修改的中文底稿，只从source重新组织同样的内容。以下诊断可能有误，仅供对照日文核实，不能照抄或添加事实。\n'
                + JSON.stringify({ original_issues: uniqueFindings.map(f => ({ type: f.finding_type, description: f.description })), expression_constraints: [...(priorReading?.issues ?? []), ...reading.issues].map(({reason})=>({reason})), syntax_hints: syntaxHintsFor(recoverySource) })
                + '\n' + SYNTAX_RECOVERY_INSTRUCTION
                + '\n【任务块】' + JSON.stringify({ items: [{ id: paragraphId, source: recoverySource, source_constraints: generationConstraints(recoverySource) }] });
            // A failed multi-sentence rewrite can anchor the model to its old syntax.
            // Retry intact top-level sentence groups, at most six, then verify the
            // reconstructed paragraph. Never split quotations or EPUB wrappers.
            const proposed = separatedRecovery?[recoverySource]:separateSpans ? separateSpans.map(s => s.source) : continuation || punctuationOnly ? [recoverySource] : longParagraphParts(recoverySource, template, 1, 0);
            const parts = proposed.length <= 6 ? proposed : [recoverySource];
            const pieces: TranslationItem[] = [];let editedCallId='';
            for (const [index,source] of parts.entries()) {
              signal?.throwIfAborted(); resume?.assertCurrent();
              if(auditInput(this.store,paragraphId).inputHash!==inputHash||this.store.translations.latestFinal(paragraphId)?.id!==previous.id)throw new Error('句群修复期间原文、知识或稿件已变化');
              if(skipRepeatedPunctuation){pieces.push(item);editedCallId=candidateCallId;continue;}
              const local = separateSpans?.[index];
              const user = local ? localRequest(local, reading.issues,item.translation)
                : parts.length === 1 ? recoveryUser + (currentReadingSpan ? '' : continuation ? sourceRelationReminder(relation?.value.notes ?? [],recoverySource) : relationReminder)
                : pack.text + sourceRelationReminder(relation?.value.notes ?? [],source) + '\n【独立句群重译】只译当前source，前后日文只供理解；程序原样按顺序合回一段，不加过渡或总结。\n'
                  + JSON.stringify({glossary:pack.glossaryHits.map(h=>({source:h.termJp,translation:h.termZh})),previous_source:parts[index-1]??'',next_source:parts[index+1]??'',syntax_hints:syntaxHintsFor(source),expression_constraints:[...(priorReading?.issues??[]),...reading.issues].map(({reason})=>({reason}))})
                  + '\n【任务块】' + JSON.stringify({items:[{id:paragraphId,source,source_constraints:generationConstraints(source)}]});
              const part=separatedRecovery?await generateSeparatedRepair({store:this.store,ai,id:paragraphId,source:paragraph.sourceText,draft:item.translation,template:separatedTemplate!,workstation:'chinese-editor',issues:{original:uniqueFindings.map(f=>({type:f.finding_type,description:f.description})),reading:reading.issues},relations:relationReminder,signal,check:async()=>{signal.throwIfAborted();if(auditInput(this.store,paragraphId).inputHash!==inputHash||this.store.translations.latestFinal(paragraphId)?.id!==previous.id)throw Error('正文版式再编辑期间依据或稿件已变化');}})
                :await ai.structured({workstation:recoveryWorkstation,paragraphId,...(signal?{signal}:{}),parseRetries:1,user},text=>parseTranslation(text,[paragraphId]));
              signal?.throwIfAborted(); resume?.assertCurrent();
              if(auditInput(this.store,paragraphId).inputHash!==inputHash||this.store.translations.latestFinal(paragraphId)?.id!==previous.id)throw new Error('句群修复期间原文、知识或稿件已变化');
              if(local && part.value.items[0]!.translation===local.draft)throw new Error('局部编辑未改动仍有疑点的表达，原稿与问题已保留');
              if(local)this.store.translations.log({level:'info',workstationId:recoveryWorkstation,paragraphId,message:JSON.stringify({contract:'disjoint-language-repair-v1',previousFinalId:previous.id,start:local.start,end:local.end,aiCallId:part.aiCallId})});
              pieces.push(part.value.items[0]!);editedCallId=part.aiCallId;
            }
            signal?.throwIfAborted();
            if (auditInput(this.store, paragraphId).inputHash !== inputHash || this.store.translations.latestFinal(paragraphId)?.id !== previous.id) throw new Error('表达修复期间原文、知识或稿件已变化');
            // The language-only pass cannot silently remove unresolved flags
            // from its input candidate. Full verification decides their fate.
            const editedItem = {...pieces[0]!,translation:pieces.map(p=>p.translation).join(''),flags:pieces.flatMap(p=>p.flags),source_coverage:[]};
            if (currentReadingSpan && editedItem.translation === currentReadingSpan.draft) {
              // The unchanged candidate already failed this task's reading check.
              // Repeating alignment/reviews cannot discharge that same negative.
              throw new Error('局部编辑未改动仍有疑点的表达，原稿与问题已保留');
            }
            let composed = editedItem.translation;
            if(separateSpans){
              composed=item.translation;
              for(let i=separateSpans.length-1;i>=0;i--){const span=separateSpans[i]!;composed=composed.slice(0,span.start)+pieces[i]!.translation+composed.slice(span.end);}
            }
            item = { ...editedItem, translation: continuation ? item.translation.slice(0, continuation.start) + editedItem.translation + item.translation.slice(continuation.end) : composed,
              flags: inheritForeignNotes(paragraph.sourceText,continuation ? item.translation.slice(0, continuation.start) + editedItem.translation + item.translation.slice(continuation.end) : composed,[...item.flags.filter(f=>f.type!=='foreign-note'),...editedItem.flags],item.flags,pack.glossaryHits) as TranslationItem['flags'] };
            item = requireRelationReview(item);
            candidateCallId = editedCallId; candidateWorkstation = recoveryWorkstation;
            normalizeDraft();
            validation = await verifyCandidate(this.store, ai, paragraphId, item, signal, undefined, true, true);
            item = validation.item;
            if (punctuationOnly && validation.findings.some(f=>f.severity==='blocks_export') && validation.findings.filter(f=>f.severity==='blocks_export').every(f=>f.code==='PUNCTUATION_MISMATCH')) {
              const projection=await proposePunctuationProjection(ai,paragraphId,paragraph.sourceText,item.translation,template,signal);
              signal?.throwIfAborted();resume?.assertCurrent();
              if(auditInput(this.store,paragraphId).inputHash!==inputHash||this.store.translations.latestFinal(paragraphId)?.id!==previous.id)throw new Error('标点定位期间原文、知识或稿件已变化');
              if(projection){
                const projectionSource={aiCallId:projection.aiCallId,before:item.translation,after:projection.translation};
                this.store.translations.log({level:'info',paragraphId,message:JSON.stringify({contract:'verbatim-punctuation-projection-v1',aiCallId:projection.aiCallId,before:item.translation,after:projection.translation,requiresFullReview:true})});
                item={...item,translation:projection.translation,source_coverage:[]};
                validation=await verifyCandidate(this.store,ai,paragraphId,item,signal,undefined,true,true);
                item=validation.item;
                const remaining=validation.findings.filter(f=>f.severity==='blocks_export');
                // Keep the exact punctuation-correct candidate for the next bounded
                // repair, never as a final or an approval. All checks run again.
                if(resume && remaining.length && remaining.every(f=>f.code==='NATURALNESS_UNRESOLVED')){
                  signal?.throwIfAborted();resume.assertCurrent();
                  this.store.transaction(()=>{
                    const candidateId=this.store.translations.addCandidate({paragraphId,workstationId:candidateWorkstation,text:item.translation,sourceCoverage:item.source_coverage,flags:item.flags,toneAxes:item.tone_axes,aiCallId:candidateCallId});
                    resume.save(candidateId,item,candidateCallId,projectionSource);
                  });
                }
              }
            }
          }
        }
        if (hasBlocking(validation.findings) || !validation.proof) {
          throw new Error('修复稿未通过核查：' + validation.findings.filter(f => f.severity === 'blocks_export').map(f => f.message).join('；').slice(0, 800));
        }
        // verifyCandidate already checks reading when a known reading blocker exists.
        if (!findings.some(f => f.finding_type === 'NATURALNESS_UNRESOLVED') && (await assessNaturalness(this.store, ai, paragraphId, item.translation, signal)).decision !== 'keep') {
          throw new Error('修复稿中文读感未通过');
        }
        // "Reading not yet checked" is a workflow state, not a literary defect.
        // An exact-candidate reading receipt resolves that state; the text-only
        // repair reviewer cannot know which software checks have already run.
        const priorConcreteReadingIssues = priorReading?.decision === 'edit'
          ? naturalnessRepairIssues(paragraphId, priorReading.issues) : [];
        const findingIssues = uniqueFindings.filter(f => {
          // The new independent alignment and full audit already prove this
          // exact workflow state resolved. Concrete semantic allegations remain.
          if(isAlignmentPendingState(f)&&validation.proof?.checks.some(c=>c.kind==='source-alignment')&&item.source_coverage.length>0&&item.source_coverage.every(c=>['covered','restructured'].includes(c.status)))return false;
          // A concrete persisted quote remains in scope even when the new
          // candidate has a keep receipt. A finding without evidence is only
          // the workflow state "reading not yet checked".
          if (f.finding_type === 'NATURALNESS_UNRESOLVED') {
            if (!f.evidence_zh && !f.evidence_jp) return false;
            return true;
          }
          // Exact punctuation is owned by the deterministic validator, which has
          // just run on this candidate. Don't ask a model to reinterpret its rule.
          if (f.workstation_id === 'program-check' && f.finding_type === 'PUNCTUATION_MISMATCH'
            && !validation.findings.some(checked => checked.code === 'PUNCTUATION_MISMATCH')) return false;
          return true;
          }).map(f => ({ id: f.id, type: f.finding_type, description: f.description, source_quote: f.evidence_jp, target_quote: f.evidence_zh }));
        const semanticIssues = [
          ...findingIssues,
          ...priorConcreteReadingIssues.filter(issue => !findingIssues.some(f => f.type === issue.type && f.target_quote === issue.target_quote && f.description === issue.description)),
        ];
        signal?.throwIfAborted(); resume?.assertCurrent();
        const resolution = semanticIssues.length ? await reviewRepairResolution(ai, paragraphId, paragraph.sourceText, previous.final_text, item.translation,
          semanticIssues, signal,
          (auditInput(this.store, paragraphId).pack.sourceContextIds ?? []).map(id => this.store.projects.getParagraph(id)).filter(p => p != null).map(p => ({ id: p.id, source: p.sourceText }))) : [];
        if (signal?.aborted) throw new ProviderError('abort', '已取消');
        if (this.store.translations.latestFinal(paragraphId)?.id !== previous.id) {
          result.stillPending++; result.details.push('译稿已被修改，未覆盖较新版本：' + paragraphId); continue;
        }
        this.store.transaction(() => {
          resume?.assertCurrent();
          const candidateId = this.store.translations.addCandidate({ paragraphId, workstationId: candidateWorkstation, text: item.translation, sourceCoverage: item.source_coverage, flags: item.flags, toneAxes: item.tone_axes, aiCallId: candidateCallId });
          const analysis = this.store.projects.currentAnalysis(paragraphId);
          const flags = item.flags as TranslationFlag[];
          const route = routeFlags(this.store, { seriesId, paragraphId, seriesOrdinal: paragraph.seriesOrdinal, sourceText: paragraph.sourceText, translation: item.translation, flags, glossaryHits: pack.glossaryHits, speakerCharId: analysis?.speaker_char_id ?? null });
          const ruby = requireCandidateRuby(this.store, paragraphId, item, previous);
          const knowledgePending = pendingFieldConflicts(this.store,seriesId,this.store.projects.getParagraph(paragraphId)!.seriesOrdinal).length > 0 || this.store.translations.listQueue(seriesId).some(q => q.paragraphId === paragraphId && q.kind !== 'warning' && !problems.some(p => p.id === q.id));
          const finalId = this.store.translations.setFinal({ paragraphId, text: item.translation, ruby, sourceCandidateId: candidateId, autoAccepted: !route.mustReview && !knowledgePending && !validation.findings.some(f => f.severity === 'warning') });
          bindAuditReceipt(this.store, finalId, validation.proof!);
          resume?.finish();
          this.store.translations.log({ level: 'info', workstationId: 'repair-resolution-reviewer', paragraphId, message: JSON.stringify({ contract: 'repair-resolution-v1', finalId, candidateId, previousFinalId: previous.id, resolution }) });
          for (const f of validation.findings) this.store.translations.addValidationFinding(paragraphId, f);
          for (const finding of [...obsoleteFindings, ...findings]) this.store.translations.resolveFinding(finding.id);
          for (const problem of problems) this.store.translations.resolveQueueItem(problem.id, JSON.stringify({ action: 'verified-repair', candidateId }));
          this.store.translations.markRecheckDone(paragraphId);
          if (!exposeUnacceptedWarnings(this.store, paragraphId)) clearRepairAttempts(this.store, paragraphId);
        });
        if (this.store.translations.latestFinal(paragraphId)?.auto_accepted) result.finalized++;
        else { result.stillPending++; result.details.push('修复稿已保存，仍有疑点或资料待确认：' + paragraphId); }
      } catch (error) {
        if (signal?.aborted || (error instanceof ProviderError && error.kind === 'abort')) { undoAttempt?.(); throw error; }
        this.store.translations.log({ level: 'warning', paragraphId, message: '自动修复未采纳：' + (error as Error).message });
        if (this.store.translations.latestFinal(paragraphId)?.id === previous.id) {
          const repairFailure = { message: (error as Error).message.slice(0, 1200), at: new Date().toISOString(), finalVersion: previous.version };
          const currentProblems = problems.map(p => this.store.translations.getQueueItem(p.id)).filter(p => p?.status === 'pending');
          if (currentProblems.length) for (const problem of currentProblems) this.store.translations.updateQueuePayload(problem!.id, { ...problem!.payload, repairFailure });
          else this.store.translations.enqueue({ seriesId, paragraphId, kind: 'review-block', title: '自动修复未完成，原稿已保留', payload: { type: 'REPAIR_ATTEMPT_FAILED', source: paragraph.sourceText, translation: previous.final_text, repairFailure } });
        }
        result.stillPending++; result.details.push('修复或审校失败，原稿保留：' + (error as Error).message);
      }
    }
    return result;
  }
}
