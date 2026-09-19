import {restoreWholeParagraphWrap} from '../validation/wholeParagraphWrap';
import type {InlineTemplate} from '../epub/blocks';
import { pendingFieldConflicts } from './characterConflicts';
import { exposeUnacceptedWarnings } from './reviewWarnings';
import type { ProjectStore } from '@core/db';
import { fromJson } from '@core/db';
import { type AiClient, type TranslationItem } from '@core/ai';
import { verifyCandidate } from './verifyCandidate';
import { auditInput, bindAuditReceipt } from './auditReceipts';
import { rebuildCandidateRuby } from './rubyPlan';
import { RepairResolutionUnresolved, reviewRepairResolution } from './repairResolution';

export { parseAlignment } from './sourceAlignment';

/** Reviews exact existing prose. It never asks a translator/editor to replace a human edit. */
export async function reverifyFinal(store: ProjectStore, ai: AiClient, paragraphId: string, signal?: AbortSignal, adjudicateWarnings = false): Promise<{ ok: boolean; message: string; diagnosticIds?: string[] }> {
  const previous = store.translations.latestFinal(paragraphId);
  const paragraph = store.projects.getParagraph(paragraphId);
  if (!previous || !paragraph) throw new Error('当前译稿不存在');
  const oldFindings = store.translations.openFindings(paragraphId).filter(f => f.workstation_id !== 'trajectory-reviewer');
  const seriesId = store.projects.getSeriesIdOfParagraph(paragraphId);
  const oldIssues = store.translations.listQueue(seriesId).filter(q => q.paragraphId === paragraphId && q.payload.type !== 'TRAJECTORY' && ['failed', 'review-block'].includes(q.kind));
  const candidate = previous.source_candidate_id ? store.translations.candidateById(previous.source_candidate_id) : undefined;
  const exact = candidate?.candidate_text === previous.final_text && candidate.paragraph_id === paragraphId;
  let item: TranslationItem = { id: paragraphId, translation: previous.final_text, source_coverage: exact ? fromJson(candidate.source_coverage, []) : [], flags: exact ? fromJson(candidate.flags, []) : [] };
  const inputHash = auditInput(store, paragraphId).inputHash;
  const result = await verifyCandidate(store, ai, paragraphId, item, signal, undefined, adjudicateWarnings, true);
  item = result.item;
  if(item.translation!==previous.final_text){
    const raw=store.archives.blocksOfParagraph(paragraphId)[0]?.inline_template;
    const template:InlineTemplate=raw?JSON.parse(raw):{markers:[]};
    if(restoreWholeParagraphWrap(paragraph.sourceText,previous.final_text,template)!==item.translation)
      return {ok:false,message:'复核结果改变了可见正文或非整段样式，原稿保留'};
  }
  signal?.throwIfAborted();
  if (store.translations.latestFinal(paragraphId)?.id !== previous.id) return { ok: false, message: '译稿已更新，本次检查不覆盖新稿，请重新复核' };
  if (auditInput(store, paragraphId).inputHash !== inputHash) return { ok: false, message: '原文或知识已更新，本次诊断不用于修复，请重新复核' };
  const rubyPlan = rebuildCandidateRuby(store, paragraphId, item, previous);
  result.findings.push(...rubyPlan.findings);
  if (!result.proof || rubyPlan.findings.length) {
    const diagnosticIds = store.transaction(() => result.findings.map(f => store.translations.addValidationFinding(paragraphId, f)));
    return { ok: false, message: '当前稿未通过复核，正文及原问题已保留', diagnosticIds };
  }
  // Rechecking an existing draft must not clear concrete editing failures
  // merely because a fresh general reader returned keep.
  const concreteReading = oldFindings.filter(f => f.finding_type === 'NATURALNESS_UNRESOLVED' && (f.evidence_zh || f.evidence_jp))
    .map(f => ({ id: f.id, type: f.finding_type, description: f.description, source_quote: f.evidence_jp, target_quote: f.evidence_zh }));
  if (concreteReading.length) {
    try {
      const context = (auditInput(store, paragraphId).pack.sourceContextIds ?? [])
        .map(id => store.projects.getParagraph(id)).filter(p => p != null).map(p => ({ id: p.id, source: p.sourceText }));
      const resolution = await reviewRepairResolution(ai, paragraphId, paragraph.sourceText, previous.final_text, item.translation, concreteReading, signal, context);
      signal?.throwIfAborted();
      if (store.translations.latestFinal(paragraphId)?.id !== previous.id || auditInput(store, paragraphId).inputHash !== inputHash)
        return { ok: false, message: '稿件或依据已变化，原问题保留，请重新复核' };
      store.translations.log({ level: 'info', workstationId: 'repair-resolution-reviewer', paragraphId,
        message: JSON.stringify({ contract: 'recheck-concrete-reading-v1', previousFinalId: previous.id, inputHash, resolution }) });
    } catch (error) {
      signal?.throwIfAborted();
      store.translations.log({ level: 'warning', workstationId: 'repair-resolution-reviewer', paragraphId, message: '具体读感问题复核未通过：' + (error as Error).message });
      // A previous edit may have removed the old issue quote without fixing its
      // meaning. Hand the validated CURRENT quote back to bounded repair rather
      // than repeatedly rechecking an obsolete quote and stopping without a target.
      if (error instanceof RepairResolutionUnresolved) {
        if (store.translations.latestFinal(paragraphId)?.id !== previous.id || auditInput(store, paragraphId).inputHash !== inputHash)
          return { ok: false, message: '稿件或依据已变化，原问题保留，请重新复核' };
        const unresolved = error.receipt.items.filter(i => i.decision === 'unresolved' && i.target_quote.trim());
        const covered = new Set(error.receipt.items.map(i => i.id));
        if (unresolved.length && concreteReading.every(i => covered.has(i.id)) && !error.receipt.items.some(i => i.decision === 'uncertain')) {
          const diagnosticIds = store.transaction(() => unresolved.map(i => store.translations.addFinding({
            paragraphId, workstationId: 'repair-resolution-reviewer', findingType: 'NATURALNESS_UNRESOLVED',
            severity: 'blocks_export', description: i.reason, evidenceJp: i.source_quote, evidenceZh: i.target_quote,
          })));
          store.translations.log({ level: 'info', workstationId: 'repair-resolution-reviewer', paragraphId,
            message: JSON.stringify({ contract: 'current-reading-repair-target-v1', previousFinalId: previous.id, inputHash, diagnosticIds, receipt: error.receipt }) });
          return { ok: false, message: '当前稿的具体表达问题已定位，可继续有界修复；原稿和原问题保留', diagnosticIds };
        }
      }
      return { ok: false, message: '此前指出的表达问题尚未确认解决，正文及原问题已保留' };
    }
  }
  const warningIds: string[] = [];
  store.transaction(() => {
    const candidateId = store.translations.addCandidate({ paragraphId, workstationId: 'source-aligner', text: item.translation, sourceCoverage: item.source_coverage, flags: item.flags });
    const ruby = rubyPlan.ruby;
    const pending = pendingFieldConflicts(store,seriesId,store.projects.getParagraph(paragraphId)!.seriesOrdinal).length > 0 || store.translations.listQueue(seriesId).some(q => q.paragraphId === paragraphId && q.kind !== 'warning' && !oldIssues.some(old => old.id === q.id));
    const finalId = store.translations.setFinal({ paragraphId, text: item.translation, ruby, sourceCandidateId: candidateId, confirmedByUser: !!previous.confirmed_by_user, autoAccepted: !pending && !result.findings.some(f => f.severity === 'warning') });
    bindAuditReceipt(store, finalId, result.proof!);
    for (const f of oldFindings) store.translations.resolveFinding(f.id);
    for (const q of oldIssues) if (store.translations.getQueueItem(q.id)?.status === 'pending') store.translations.resolveQueueItem(q.id, JSON.stringify({ action: 'verified-current-final', finalId }));
    for (const f of result.findings) {
      const id = store.translations.addValidationFinding(paragraphId, f);
      if (f.severity === 'warning') warningIds.push(id);
    }
    exposeUnacceptedWarnings(store, paragraphId);
    store.translations.markRecheckDone(paragraphId);
    store.db.run("UPDATE workflow_tasks SET status='done', error_message=NULL WHERE paragraph_id=? AND workstation_id LIKE 'repair:%' AND status='failed'", [paragraphId]);
  });
  return warningIds.length && !previous.confirmed_by_user
    ? { ok: false, message: '当前稿仍有疑点，已加入待处理列表，正文保持不变', diagnosticIds: warningIds }
    : { ok: true, message: warningIds.length ? '当前稿复核完成，仍有提示待查看' : '当前稿复核通过，正文保持不变' };
}
