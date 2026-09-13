import { createHash } from 'node:crypto';
import type { ProjectStore } from '@core/db';
import { fromJson } from '@core/db';
import { auditInput, AUDIT_VERSION } from './auditReceipts';
import { systemPromptFor } from '../ai/prompts/systemPrompts';
import { SYNTAX_RECOVERY_INSTRUCTION } from './repairSpan';
import { syntaxHintsFor, speechActHintsFor } from '../ai/prompts/syntaxHints';
import {checkPunctuation} from '../validation/rules';
import {punctuationRepairRequest} from './punctuationRepairRequest';
import {separatedRepairTemplate,separatedRepairIdentity} from './separatedRepair';
import {isAlignmentPendingState} from './alignmentState';

const key = (id: string) => `local-repair-attempt:${id}`;
export const REPAIR_BEHAVIOR_CONTRACT = 'repair-v10-exact-punctuation-mapping-status';
export class RepairLimitError extends Error { constructor(readonly canReviewDispute: boolean) { super('同一原文、知识与译稿已连续尝试两次修复仍未通过。请查看诊断或点击“允许再次修复”后继续'); } }
export function repairInputStamp(store: ProjectStore, paragraphId: string): string {
  const final = store.translations.latestFinal(paragraphId);
  if (!final) throw new Error('修复原稿不存在');
  const syntaxHints=syntaxHintsFor(store.projects.getParagraph(paragraphId)!.sourceText);
  const speechHints=speechActHintsFor(store.projects.getParagraph(paragraphId)!.sourceText);
  const source=store.projects.getParagraph(paragraphId)!.sourceText;
  const punctuationTask=checkPunctuation(source,final.final_text).length?punctuationRepairRequest({id:paragraphId,source,draft:final.final_text,glossary:[]}):null;
  const stamp = createHash('sha256').update(JSON.stringify([REPAIR_BEHAVIOR_CONTRACT, SYNTAX_RECOVERY_INSTRUCTION, systemPromptFor('sentence-translator'), auditInput(store, paragraphId).inputHash, final.final_text, final.ruby_annotations, AUDIT_VERSION, systemPromptFor('faithful-translator'), systemPromptFor('chinese-editor'), systemPromptFor('repair-resolution-reviewer'), systemPromptFor('dispute-reviewer'),...(syntaxHints.length?[syntaxHints]:[]),...(speechHints.length?[speechHints]:[]),...(punctuationTask?['punctuation-first-no-dispute-v2-bounded-comma-choice',punctuationTask]:[])])).digest('hex');
  const dashStamp=punctuationTask&&/[─—]/u.test(source)?createHash('sha256').update(JSON.stringify([stamp,'source-dash-glyphs-equal-count-v1'])).digest('hex'):stamp;
  const quotedStamp=punctuationTask&&/[「」『』]/u.test(source)?createHash('sha256').update(JSON.stringify([dashStamp,'quoted-label-punctuation-projection-v1'])).digest('hex'):dashStamp;
  const alignmentStamp=store.translations.openFindings(paragraphId).some(isAlignmentPendingState)?createHash('sha256').update(JSON.stringify([quotedStamp,'fresh-alignment-resolves-workflow-state-v1'])).digest('hex'):quotedStamp;
  const styleStamp=punctuationTask||store.translations.openFindings(paragraphId).some(f=>f.finding_type==='NATURALNESS_UNRESOLVED')?createHash('sha256').update(JSON.stringify([alignmentStamp,'source-style-review-on-repair-v1'])).digest('hex'):alignmentStamp;
  return separatedRepairTemplate(store,paragraphId)?createHash('sha256').update(JSON.stringify([styleStamp,separatedRepairIdentity()])).digest('hex'):styleStamp;
}
/** Once both repairs and their one dispute review are spent, refuse before any
 * model-based preparation. Changed source/knowledge/prose still starts a new case.
 * This is a read-only preflight; beginRepairAttempt remains the reservation gate. */
export function assertRepairWorkAllowed(store: ProjectStore, paragraphId: string): void {
  const old = store.db.get<{value:string}>('SELECT value FROM meta WHERE key=?', [key(paragraphId)]);
  const previous = fromJson<{stamp?:string; count?:number}>(old?.value ?? null, {});
  if (Number.isInteger(previous.count) && previous.count! >= 3 && previous.stamp === repairInputStamp(store, paragraphId)) throw new RepairLimitError(false);
}
export function beginRepairAttempt(store: ProjectStore, paragraphId: string, dispute = false): () => void {
  const stamp = repairInputStamp(store, paragraphId);
  const old = store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [key(paragraphId)]);
  const previous = fromJson<{ stamp?: string; count?: number }>(old?.value ?? null, {});
  const count = previous.stamp === stamp && Number.isInteger(previous.count) ? previous.count! : 0;
  if (old && previous.stamp !== stamp) store.translations.log({ level: 'info', paragraphId, message: `修复依据或行为版本已变化，保留旧尝试记录：${old.value}` });
  if (count >= 2 && !(dispute && count === 2)) throw new RepairLimitError(count === 2);
  // Persist before requesting: a crash must not silently grant unlimited retries.
  const value = JSON.stringify({ stamp, count: count + 1 });
  store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [key(paragraphId), value]);
  return () => {
    if (store.db.get<{value:string}>('SELECT value FROM meta WHERE key=?', [key(paragraphId)])?.value !== value) return;
    if (old) store.db.run('UPDATE meta SET value=? WHERE key=?', [old.value, key(paragraphId)]);
    else clearRepairAttempts(store, paragraphId);
  };
}
export function clearRepairAttempts(store: ProjectStore, paragraphId: string): void { store.db.run('DELETE FROM meta WHERE key=?', [key(paragraphId)]); }
/** Explicit user retry; resets only this volume and does not accept manuscripts. */
export function resetLocalRepairs(store: ProjectStore, volumeId: string): number {
  store.projects.getVolumeSeriesId(volumeId);
  return store.transaction(() => {
    let count = 0;
    for (const id of store.projects.listParagraphIdsByVolume(volumeId)) {
      const row = store.db.get<{value:string}>('SELECT value FROM meta WHERE key=?', [key(id)]);
      if (!row) continue;
      store.translations.log({ level: 'info', paragraphId: id, message: `用户允许再次修复，旧尝试记录：${row.value}` });
      clearRepairAttempts(store, id); count++;
    }
    return count;
  });
}
