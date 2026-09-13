import {inheritForeignNotes,foreignEntries,parseForeignReviews,foreignReviewsPass,foreignNoteReceipt,FOREIGN_NOTE_REVIEW_INSTRUCTION} from './foreignNotes';
import {restoreWholeParagraphWrap} from '../validation/wholeParagraphWrap';
import {originalRubyEntries,parseOriginalRubyReview,originalRubyReceipt,ORIGINAL_RUBY_REVIEW_INSTRUCTION} from './originalRuby';
import type { RubyHistoryOverlay } from './rubyHistoryOverlay';
import { candidateRubyPlan } from './rubyPlan';
import { longReadingBoundary } from './longReadingRecovery';
import { reviewRestructuring } from './restructuringReview';
import { assessNaturalness } from './naturalness';
import {reviewSourceStyle} from './sourceStyleReview';
import { naturalnessEvidence } from './naturalnessEvidence';
import type { ProjectStore } from '@core/db';
import { parseCandidateReview, type AiClient, type TranslationItem } from '@core/ai';
import { validateTranslation, hasBlocking } from '@core/validation';
import { validateMarkers, type InlineTemplate } from '@core/epub/blocks';
import { checkInfoOrder } from '@core/validation/wordOrder';
import type { TranslationFlag, ValidationFinding } from '@shared/types';
import { auditInput, candidateHash, AUDIT_CHECKS, type AuditProof } from './auditReceipts';
import { alignSource } from './sourceAlignment';
import { CANDIDATE_REVIEW_TASKS } from '../ai/prompts/candidateReviewTasks';
import { reviewRepairResolution } from './repairResolution';
import { reviewDisputes } from './disputeReview';
import { firstPersonBodyRule } from '../ai/prompts/firstPersonBody';
import { sourcePrecisionRules } from '../ai/prompts/sourcePrecision';
import { containsVisibleQuote } from '../validation/nameEvidence';
import {ALIGNMENT_PENDING_MESSAGE} from './alignmentState';

export interface VerificationResult { findings: ValidationFinding[]; proof: AuditProof | null; item: TranslationItem }

/** Each check sees the source and exact candidate, never the other check's verdict. */
export async function verifyCandidate(store: ProjectStore, ai: AiClient, paragraphId: string, item: TranslationItem, signal?: AbortSignal, rubyHistory?: RubyHistoryOverlay, adjudicateWarnings = false, sourceStyleReview = false): Promise<VerificationResult> {
  const paragraph = store.projects.getParagraph(paragraphId);
  if (!paragraph) throw new Error('段落不存在');
  const block = store.archives.blocksOfParagraph(paragraphId)[0];
  const template: InlineTemplate = block?.inline_template ? JSON.parse(block.inline_template) : { markers: [] };
  const restoredWrap=restoreWholeParagraphWrap(paragraph.sourceText,item.translation,template);
  if(restoredWrap!==null){
    item={...item,translation:restoredWrap};
    store.translations.log({level:'info',paragraphId,message:JSON.stringify({kind:'whole-paragraph-wrap-restored-v1',message:'仅恢复原文覆盖整段的样式标记，未修改可见译文；仍须完整标点、忠实和读感审校'})});
  }
  const boundary = longReadingBoundary(paragraph, item.translation);
  if (boundary) return { findings: [boundary], proof: null, item };
  const { pack, inputHash } = auditInput(store, paragraphId);
  const previous=store.translations.latestFinal(paragraphId);
  const priorCandidate=previous?.source_candidate_id?store.translations.candidateById(previous.source_candidate_id):undefined;
  if(previous&&priorCandidate?.candidate_text===previous.final_text&&priorCandidate.paragraph_id===paragraphId){
    try{item={...item,flags:inheritForeignNotes(paragraph.sourceText,item.translation,item.flags,JSON.parse(priorCandidate.flags??'[]'),pack.glossaryHits) as TranslationItem['flags']};}catch(error){return {findings:[{code:'REVIEW:FOREIGN_NOTE_INVALID',severity:'blocks_export',message:'既有译注结构无效：'+(error as Error).message}],proof:null,item};}
  }
  // Reject locally provable defects before spending a model request on alignment.
  // This is rejection only: every eligible candidate still gets fresh alignment.
  const findings = validateTranslation({ source: paragraph.sourceText, translation: item.translation, paragraphType: paragraph.paragraphType, glossary: pack.glossaryHits, flags: item.flags as TranslationFlag[] });
  let foreign:ReturnType<typeof foreignEntries>=[];
  try{foreign=foreignEntries(paragraph.sourceText,item.translation,item.flags,pack.glossaryHits);}catch(error){findings.push({code:'REVIEW:FOREIGN_NOTE_INVALID',severity:'blocks_export',message:(error as Error).message});}
  const markers = validateMarkers(item.translation, template);
  if (!markers.ok) findings.push({ code: 'MARKER_ROUNDTRIP_FAILED', severity: 'blocks_export', message: markers.error.message });
  if (hasBlocking(findings)) return { findings, proof: null, item };
  // Independent alignment is mandatory even if the generator supplied coverage.
  let alignment = await alignSource(ai, paragraphId, paragraph.sourceText, item.translation, signal);
  item = { ...item, source_coverage: alignment.value };
  let rubyPlan = candidateRubyPlan(store, paragraphId, item, rubyHistory);
  if (rubyPlan.findings.some(f => f.message.includes('多分句需要更细的对齐证据'))) {
    // Repair inadequate evidence once; never rewrite prose to make ruby mapping easier.
    alignment = await alignSource(ai, paragraphId, paragraph.sourceText, item.translation, signal,
      '上一份对应表把含一人称的多个分句合在一起，无法确定中文“我”的位置。请细分对应表：一人称所在片段不跨逗号、句号或引号；结巴前缀与后面的完整分句分开对应。保持连续覆盖，不重叠引用中文，不修改source或translation。');
    item = { ...item, source_coverage: alignment.value };
    rubyPlan = candidateRubyPlan(store, paragraphId, item, rubyHistory);
  }
  const proof: AuditProof = { inputHash, rubyInputHash: rubyPlan.inputHash, candidateHash: candidateHash(item), checks: [{ kind: 'source-alignment', aiCallId: alignment.aiCallId }] };
  findings.unshift(...rubyPlan.findings);
  if (item.source_coverage.some(c => c.status === 'uncertain')) findings.push({ code: 'REVIEW:ALIGNMENT_UNCERTAIN', severity: 'blocks_export', message: ALIGNMENT_PENDING_MESSAGE });
  const order = checkInfoOrder(paragraph.sourceText, item.translation, item.source_coverage);
  const needsRestructuring = order.code === 'ORDER_INVERTED' && order.inverted.every(i => item.source_coverage.some(c => c.ord === i.ord && c.status === 'restructured'));
  if (order.code !== 'ORDER_OK' && !needsRestructuring) findings.push({ code: order.code, severity: 'blocks_export', message: order.message });
  if (hasBlocking(findings)) return { findings, proof: null, item };
  const blocks = JSON.stringify({ items: [{ id: paragraphId, source: paragraph.sourceText, translation: item.translation,
    source_coverage: item.source_coverage, ruby_annotations: rubyPlan.ruby }] });
  const originalRuby=originalRubyEntries(paragraph.sourceText,template,item.translation);
  for (const check of CANDIDATE_REVIEW_TASKS) {
    signal?.throwIfAborted();
    const personRule = check.ws === 'address-reviewer' ? firstPersonBodyRule(paragraph.sourceText) : null;
    const precisionRules = check === CANDIDATE_REVIEW_TASKS[1] ? sourcePrecisionRules(paragraph.sourceText) : [];
    const rubyCheck=check===CANDIDATE_REVIEW_TASKS[0]&&originalRuby.length>0;
    const foreignCheck=check===CANDIDATE_REVIEW_TASKS[0]&&foreign.length>0;
    const foreignTask=foreignCheck?'\n'+FOREIGN_NOTE_REVIEW_INSTRUCTION+'\n'+JSON.stringify({foreign_entries:foreign}):'';
    const rubyTask=rubyCheck?'\n'+ORIGINAL_RUBY_REVIEW_INSTRUCTION+'\n'+JSON.stringify({original_ruby_entries:originalRuby}):'';
    const result = await ai.structured({ workstation: check.ws, user: `${pack.text}\n\n【本次唯一检查任务】${check.task}${personRule ? '\n'+personRule : ''}${precisionRules.length ? '\n'+precisionRules.join('\n') : ''}${rubyTask}${foreignTask}\n【只审核这些块】${blocks}`, paragraphId, ...(signal ? { signal } : {}), parseRetries: 1 }, text => {
      const reviewed=parseCandidateReview(text,paragraphId,paragraph.sourceText,item.translation);
      if(!reviewed.ok)return reviewed;
      try{return {ok:true as const,value:{...reviewed.value,foreign_reviews:foreignCheck?parseForeignReviews(JSON.parse(text).foreign_reviews,foreign):undefined,original_ruby_reviews:rubyCheck?parseOriginalRubyReview(JSON.parse(text).original_ruby_reviews,originalRuby):undefined}};}
      catch(error){return {ok:false as const,error:{code:'INVALID_SHAPE' as const,message:'原作注音或外文逐项回执不完整或与当前文本不符：'+(error as Error).message}};}
    });
    const originalReceipt=rubyCheck?originalRubyReceipt(paragraph.sourceText,template,item.translation,result.value.original_ruby_reviews!,result.aiCallId):undefined;
    proof.checks.push({ kind: AUDIT_CHECKS[proof.checks.length]!, aiCallId: result.aiCallId,...(originalReceipt?{originalRuby:originalReceipt}:{}),...(foreignCheck?{foreignNotes:foreignNoteReceipt(paragraph.sourceText,item.translation,item.flags,result.value.foreign_reviews!,result.aiCallId,pack.glossaryHits)}:{}) });
    if(foreignCheck&&!foreignReviewsPass(result.value.foreign_reviews!,foreign))findings.push({code:'REVIEW:FOREIGN_NOTE_UNRESOLVED',severity:'blocks_export',message:'外文保留或译注的适用性、中文含义未通过审校',details:{foreignReviews:result.value.foreign_reviews,foreignEntries:foreign,aiCallId:result.aiCallId}});
    for(const ruby of result.value.original_ruby_reviews??[])if(ruby.attachment!=='supported'||ruby.meaning!=='supported')findings.push({code:'REVIEW:ORIGINAL_RUBY_UNRESOLVED',severity:'blocks_export',message:`原作注音 ${ruby.markerId}「${ruby.sourceBase}／${ruby.rt}」当前附着「${ruby.targetBase}」的对应或注层含义未通过：${ruby.reason}`,details:{evidence_jp:ruby.sourceBase,evidence_zh:ruby.targetBase,originalRuby:ruby,aiCallId:result.aiCallId}});
    for (const finding of result.value.findings) {
      if ((finding.evidence_jp && !containsVisibleQuote(paragraph.sourceText, finding.evidence_jp)) || (finding.evidence_zh && !containsVisibleQuote(item.translation, finding.evidence_zh))) {
        findings.push({ code: 'REVIEW_INVALID_EVIDENCE', severity: 'blocks_export', message: '审校引用的证据不属于当前原文或译稿，需要重新核对' });
        continue;
      }
      if (finding.severity === 'blocks_export' && !finding.evidence_jp && !finding.evidence_zh) {
        findings.push({ code: 'REVIEW_MISSING_EVIDENCE', severity: 'blocks_export', message: '审校未提供可定位证据，不能判定已通过' });
        continue;
      }
      findings.push({ code: `REVIEW:${finding.type}`, severity: finding.severity, message: finding.description,
        details: { evidence_jp: finding.evidence_jp, evidence_zh: finding.evidence_zh, check: AUDIT_CHECKS[proof.checks.length - 1], aiCallId: result.aiCallId } });
    }
  }
  if (!hasBlocking(findings)) {
    // Keep reading before the optional syntax check so receipt order is stable.
    let reading = await assessNaturalness(store, ai, paragraphId, item.translation, signal);
    if(sourceStyleReview&&await reviewSourceStyle(store,ai,paragraphId,item.translation,reading,signal))reading={id:paragraphId,decision:'keep',issues:[]};
    const aiCallId = naturalnessEvidence(store, paragraphId, inputHash, item.translation);
    if (reading.decision !== 'keep' || !aiCallId) findings.push({ code: 'NATURALNESS_UNRESOLVED', severity: 'blocks_export', message: '当前稿的中文读感尚未获得有效检查' });
    else proof.checks.push({ kind: 'naturalness', aiCallId });
  }
  if (needsRestructuring) {
    const review = await reviewRestructuring(ai, paragraphId, paragraph.sourceText, item.translation, signal);
    if (review.value.decision !== 'necessary') findings.push({ code: 'ORDER_INVERTED', severity: 'blocks_export', message: `必要句法重构未获验证：${review.value.reason}` });
    else proof.checks.push({ kind: 'necessary-restructuring', aiCallId: review.aiCallId });
  }
  const logic = item.flags.filter(f => f.type === 'logic-conflict');
  if (logic.length && !hasBlocking(findings)) {
    try {
      const context = (pack.sourceContextIds ?? []).map(id => store.projects.getParagraph(id)).filter(p => p != null).map(p => ({ id: p.id, source: p.sourceText }));
      const resolution = await reviewRepairResolution(ai, paragraphId, paragraph.sourceText, item.translation, item.translation,
        logic.map((f, index) => ({ id: `logic-${index}`, type: 'logic-conflict', description: f.note, source_quote: null, target_quote: null })), signal, context);
      store.translations.log({ level: 'info', workstationId: 'repair-resolution-reviewer', paragraphId, message: JSON.stringify({ contract: 'logic-evidence-v1', inputHash, candidateHash: candidateHash(item), resolution }) });
      item = { ...item, flags: item.flags.filter(f => f.type !== 'logic-conflict') };
      proof.candidateHash = candidateHash(item);
    } catch (error) {
      signal?.throwIfAborted();
      findings.push({ code: 'REVIEW:LOGIC_UNRESOLVED', severity: 'blocks_export', message: `逻辑难点尚未得到有效证据核查：${logic.map(f => f.note).join('；')}；${(error as Error).message}` });
    }
  }
  // Repair must not rewrite a good candidate merely because a model alleged a
  // defect. Only model warnings are eligible; deterministic and blocking checks
  // cannot be discharged here. Each disposition is tied to this exact candidate.
  const disputedWarnings = findings.filter(f => f.severity === 'warning' && f.code.startsWith('REVIEW:') && typeof f.details?.aiCallId === 'string');
  if (adjudicateWarnings && !hasBlocking(findings) && disputedWarnings.length > 0 && disputedWarnings.length <= 3) {
    const context = (pack.sourceContextIds ?? []).map(id => store.projects.getParagraph(id)).filter(p => p != null).map(p => ({ id: p.id, source: p.sourceText }));
    const disputes = await reviewDisputes(ai, paragraphId, paragraph.sourceText, item.translation,
      disputedWarnings.map((f, index) => ({ id: String(index), type: f.code, description: f.message, source_quote: String(f.details?.evidence_jp ?? ''), target_quote: String(f.details?.evidence_zh ?? '') })), context, signal);
    for (const dispute of disputes) {
      proof.checks.push({ kind: 'warning-dispute', aiCallId: dispute.aiCallId });
      const finding = disputedWarnings[Number(dispute.issueId)]!;
      finding.details = { ...finding.details, dispute: { ...dispute, inputHash, candidateHash: proof.candidateHash } };
      if (dispute.verdict.decision === 'retain') finding.severity = 'info';
    }
    store.translations.log({ level: 'info', workstationId: 'dispute-reviewer', paragraphId, message: JSON.stringify({ contract: 'candidate-warning-dispute-v1', inputHash, candidateHash: proof.candidateHash, disputes }) });
  }
  signal?.throwIfAborted();
  if (auditInput(store, paragraphId).inputHash !== inputHash || candidateRubyPlan(store, paragraphId, item, rubyHistory).inputHash !== proof.rubyInputHash) findings.push({ code: 'REVIEW:CONTEXT_CHANGED', severity: 'blocks_export', message: '审校期间原文、知识或此前一人称标注已改变，本次结论失效，请重新复核' });
  // A moderate length difference is a screening signal, not proof of omission.
  // Retain the measurement, but don't rewrite good prose after every independent
  // content/voice/reading check has passed on this exact, unchanged candidate.
  if (!findings.some(f => f.severity === 'blocks_export' || (f.severity === 'warning' && f.code !== 'LENGTH_VARIANCE'))) {
    for (const finding of findings) if (finding.code === 'LENGTH_VARIANCE' && finding.severity === 'warning') {
      finding.severity = 'info';
      finding.message += '；当前稿已通过信息完整性、增译、人物声音及中文读感检查，仅保留长度记录';
      finding.details = { ...finding.details, disposition: 'verified-content', inputHash, candidateHash: proof.candidateHash, checks: proof.checks.map(c => ({ ...c })) };
    }
  }
  return { findings, proof: hasBlocking(findings) ? null : proof, item };
}
