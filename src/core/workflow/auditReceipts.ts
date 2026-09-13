import {FOREIGN_NOTE_CONTRACT,FOREIGN_NOTE_REVIEW_INSTRUCTION,foreignEntries,validForeignNoteReceipt,foreignNoteReceipt} from './foreignNotes';
import { inspectCandidateRuby, RUBY_CONTRACT } from './rubyPlan';
import {validCandidateLayoutSource} from '../validation/immutableLayout';
import { naturalnessEvidence } from './naturalnessEvidence';
import { staleAutomaticSources } from './automaticKnowledgeSources';
import { assertAcceptedChangeSources, staleAcceptedChanges } from '../db/knowledgeChanges';
import { checkInfoOrder, type OrderCoverageItem } from '@core/validation/wordOrder';
import { createHash } from 'node:crypto';
import type { ProjectStore, FinalRow } from '@core/db';
import { fromJson, nowIso } from '@core/db';
import { buildContextPack, type TranslationItem } from '@core/ai';
import { PROMPT_VERSION, systemPromptFor } from '@core/ai/prompts/systemPrompts';
import { CANDIDATE_REVIEW_TASKS } from '../ai/prompts/candidateReviewTasks';
import { firstPersonBodyRule } from '../ai/prompts/firstPersonBody';
import { sourcePrecisionRules } from '../ai/prompts/sourcePrecision';
import { checkPunctuation } from '../validation/rules';
import { withIdentityRead } from '../db/identitySources';
import {originalRubyReceipt,validOriginalRubyReceipt,ORIGINAL_RUBY_CONTRACT,ORIGINAL_RUBY_REVIEW_INSTRUCTION} from './originalRuby';
import type {InlineTemplate} from '../epub/blocks';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Dispute dispositions are evidence about this candidate, never blanket waivers.
export const AUDIT_VERSION = `${PROMPT_VERSION}:final-audit-v12-ruby-and-scope:${RUBY_CONTRACT}:${hash([FOREIGN_NOTE_CONTRACT,FOREIGN_NOTE_REVIEW_INSTRUCTION,CANDIDATE_REVIEW_TASKS, systemPromptFor('fidelity-reviewer'), systemPromptFor('address-reviewer'), systemPromptFor('source-aligner'), systemPromptFor('restructuring-reviewer'), systemPromptFor('repair-resolution-reviewer'), systemPromptFor('naturalness-reviewer'), systemPromptFor('dispute-reviewer')]).slice(0, 16)}`;
export interface AuditProof {
  inputHash: string;
  rubyInputHash: string;
  candidateHash: string;
  checks: { kind: string; aiCallId: string; originalRuby?:ReturnType<typeof originalRubyReceipt>;foreignNotes?:ReturnType<typeof foreignNoteReceipt> }[];
}
export const AUDIT_CHECKS = ['source-alignment', 'source-to-target', 'target-to-source', 'character-voice'] as const;

/** Fingerprint exactly the source, effective knowledge and structural constraints used in review. */
export function auditInput(store: ProjectStore, paragraphId: string) {
  assertAcceptedChangeSources(store.db, store.projects.getSeriesIdOfParagraph(paragraphId));
  const paragraph = store.projects.getParagraph(paragraphId);
  if (!paragraph) throw new Error('段落不存在');
  const pack = buildContextPack(store, { paragraphIds: [paragraphId], workstation: 'fidelity-reviewer', sourceOnlyWindow: true });
  const bodyRule = firstPersonBodyRule(paragraph.sourceText);
  const precisionRules = sourcePrecisionRules(paragraph.sourceText);
  const templates=store.archives.blocksOfParagraph(paragraphId).map(b=>b.inline_template);
  const hasOriginalRuby=templates.some(raw=>raw&&(JSON.parse(raw) as InlineTemplate).markers.some(m=>m.kind==='ruby'));
  const inputHash = hash({ source: paragraph.sourceText, type: paragraph.paragraphType, ordinal: paragraph.seriesOrdinal,
    ...(bodyRule ? { firstPersonBodyRule: bodyRule } : {}),
    ...(precisionRules.length ? { sourcePrecisionRules: precisionRules } : {}),
    context: pack.text, settings: store.projects.getSettings(pack.seriesId),
    templates,...(hasOriginalRuby?{originalRubyReview:[ORIGINAL_RUBY_CONTRACT,ORIGINAL_RUBY_REVIEW_INSTRUCTION]}:{}) });
  return { pack, inputHash };
}
export const candidateHash = (item: Pick<TranslationItem, 'translation' | 'source_coverage' | 'flags'>): string =>
  hash([item.translation, item.source_coverage, item.flags]);
/** v8 binds local ruby dependencies in final_hash, without inventing an AI check or schema migration. */
const finalHash = (final: FinalRow, rubyInputHash: string): string => hash([final.paragraph_id, final.final_text, final.source_candidate_id, final.ruby_annotations, RUBY_CONTRACT, rubyInputHash]);
function finalRubyInput(store: ProjectStore, final: FinalRow, candidate: NonNullable<ReturnType<ProjectStore['translations']['candidateById']>>) {
  const item: TranslationItem = { id: final.paragraph_id, translation: final.final_text, source_coverage: fromJson(candidate.source_coverage, []), flags: fromJson(candidate.flags, []) };
  return inspectCandidateRuby(store, final.paragraph_id, item, store.translations.rubyOf(final));
}

function validChecks(store: ProjectStore, final: FinalRow, checks: unknown, restructured: boolean, inputHash: string): boolean {
  const expectedChecks = [...AUDIT_CHECKS, 'naturalness', ...(restructured ? ['necessary-restructuring'] : [])];
  if (!Array.isArray(checks) || checks.length < expectedChecks.length || checks.length > expectedChecks.length + 3 ||
    checks.some((check, index) => !check || check.kind !== (expectedChecks[index] ?? 'warning-dispute') || typeof check.aiCallId !== 'string')) return false;
  if (new Set(checks.map(c => c.aiCallId)).size !== checks.length) return false;
  const workstations: Record<string, string> = { 'source-alignment': 'source-aligner', 'source-to-target': 'fidelity-reviewer', 'target-to-source': 'fidelity-reviewer', 'character-voice': 'address-reviewer', 'necessary-restructuring': 'restructuring-reviewer', naturalness: 'naturalness-reviewer', 'warning-dispute': 'dispute-reviewer' };
  if (checks.some(c => !store.db.get('SELECT id FROM ai_calls WHERE id=? AND workstation_id=? AND error IS NULL', [c.aiCallId, workstations[c.kind]!])) ) return false;
  const source=store.projects.getParagraph(final.paragraph_id)?.sourceText;
  const raw=store.archives.blocksOfParagraph(final.paragraph_id)[0]?.inline_template;
  try {
    const template:InlineTemplate=raw?JSON.parse(raw):{markers:[]};
    const candidate=final.source_candidate_id?store.translations.candidateById(final.source_candidate_id):undefined;
    const flags=fromJson<TranslationItem['flags']>(candidate?.flags,[]);
    const foreignCheck=checks.find(c=>c.kind==='source-to-target');
    if(checks.some(c=>c.foreignNotes!==undefined&&c.kind!=='source-to-target'))return false;
    if(source===undefined)return false;
    const confirmed=auditInput(store,final.paragraph_id).pack.glossaryHits;
    if(foreignEntries(source,final.final_text,flags,confirmed).length){if(!foreignCheck||!validForeignNoteReceipt(source,final.final_text,flags,foreignCheck.foreignNotes,foreignCheck.aiCallId,confirmed))return false;}else if(foreignCheck?.foreignNotes!==undefined)return false;
    const rubyCheck=checks.find(c=>c.kind==='source-to-target');
    if(checks.some(c=>c.originalRuby!==undefined&&c.kind!=='source-to-target'))return false;
    if(template.markers.some(m=>m.kind==='ruby')) {
      if(source===undefined||!validOriginalRubyReceipt(source,template,final.final_text,rubyCheck?.originalRuby,rubyCheck?.aiCallId)
        || !store.db.get("SELECT id FROM ai_calls WHERE id=? AND workstation_id='fidelity-reviewer' AND paragraph_id=? AND prompt_version=? AND error IS NULL AND finish_reason='stop'",[rubyCheck.aiCallId,final.paragraph_id,PROMPT_VERSION]))return false;
    } else if(rubyCheck?.originalRuby!==undefined)return false;
  } catch {return false;}
  return checks.find(c => c.kind === 'naturalness')!.aiCallId === naturalnessEvidence(store, final.paragraph_id, inputHash, final.final_text);
}

/** Called in the same transaction as final adoption. Never carries a receipt to a new edit. */
export function bindAuditReceipt(store: ProjectStore, finalId: string, proof: AuditProof): void {
  const final = store.db.get<FinalRow>('SELECT * FROM translation_finals WHERE id=?', [finalId]);
  if (!final) throw new Error('审校对应译稿不存在');
  const candidate = final.source_candidate_id ? store.translations.candidateById(final.source_candidate_id) : undefined;
  if (!candidate || !validCandidateLayoutSource(store,candidate) || candidate.paragraph_id !== final.paragraph_id || candidate.candidate_text !== final.final_text ||
    candidateHash({ translation: candidate.candidate_text, source_coverage: fromJson(candidate.source_coverage, []), flags: fromJson(candidate.flags, []) }) !== proof.candidateHash ||
    auditInput(store, final.paragraph_id).inputHash !== proof.inputHash) throw new Error('译稿或知识已改变，需要重新审校');
  const ruby = finalRubyInput(store, final, candidate);
  if (ruby.inputHash !== proof.rubyInputHash || ruby.findings.length) throw new Error('一人称标注或其来源已改变，需要重新复核');
  const order = checkInfoOrder('', final.final_text, fromJson<OrderCoverageItem[]>(candidate.source_coverage, []));
  if (!validChecks(store, final, proof.checks, order.code === 'ORDER_INVERTED', proof.inputHash)) throw new Error('审校调用凭证不完整');
  store.db.run('INSERT INTO final_audit_receipts(final_id,paragraph_id,input_hash,candidate_hash,final_hash,prompt_version,checks_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
    [final.id, final.paragraph_id, proof.inputHash, proof.candidateHash, finalHash(final, proof.rubyInputHash), AUDIT_VERSION, JSON.stringify(proof.checks), nowIso()]);
}

export function auditStatus(store: ProjectStore, final: FinalRow): 'valid' | 'missing' | 'stale' {
  return withIdentityRead(store.db, () => {
  const receipt = store.db.get<{ input_hash: string; candidate_hash: string; final_hash: string; prompt_version: string; checks_json: string }>('SELECT * FROM final_audit_receipts WHERE final_id=?', [final.id]);
  if (!receipt) return 'missing';
  // Recheck cheap local constraints for historical receipts without changing the
  // global audit version (which would also renew unrelated repair budgets).
  const paragraph = store.projects.getParagraph(final.paragraph_id);
  if (!paragraph || checkPunctuation(paragraph.sourceText, final.final_text).some(f => f.severity === 'blocks_export')) return 'stale';
  if (staleAcceptedChanges(store.db, store.projects.getSeriesIdOfParagraph(final.paragraph_id)).length) return 'stale';
  if (staleAutomaticSources(store, store.projects.getSeriesIdOfParagraph(final.paragraph_id)).length) return 'stale';
  const candidate = final.source_candidate_id ? store.translations.candidateById(final.source_candidate_id) : undefined;
  if (!candidate || !validCandidateLayoutSource(store,candidate) || candidate.paragraph_id !== final.paragraph_id || candidate.candidate_text !== final.final_text || receipt.prompt_version !== AUDIT_VERSION ||
    receipt.candidate_hash !== candidateHash({ translation: candidate.candidate_text, source_coverage: fromJson(candidate.source_coverage, []), flags: fromJson(candidate.flags, []) }) ||
    receipt.input_hash !== auditInput(store, final.paragraph_id).inputHash) return 'stale';
  const ruby = finalRubyInput(store, final, candidate);
  if (receipt.final_hash !== finalHash(final, ruby.inputHash) || ruby.findings.length) return 'stale';
  const order = checkInfoOrder('', final.final_text, fromJson<OrderCoverageItem[]>(candidate.source_coverage, []));
  const checks = fromJson<AuditProof['checks']>(receipt.checks_json, []);
  if (!validChecks(store, final, checks, order.code === 'ORDER_INVERTED', receipt.input_hash)) return 'stale';
  return 'valid';
  });
}
