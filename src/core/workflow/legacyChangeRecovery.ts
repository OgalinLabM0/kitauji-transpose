import { createHash } from 'node:crypto';
import type { ProjectStore } from '@core/db';
import { nowIso } from '@core/db';
import { changeTables, changeTarget } from '../db/knowledgeChanges';
import { originalSourceProof } from '../db/characterSources';
import { endObservedRelationship } from '../db/narrativeSources';
import { scheduleFieldRechecks } from './characterConflicts';

type Kind = keyof typeof changeTables;
type Row = Record<string, string | number | null>;
interface Candidate extends Row { id: string; series_id: string; entity_type: Kind; entity_id: string; status: string }
export interface LegacyChangeRecoveryPreview {
  queueId: string; seriesId: string; candidateId: string; kind: Kind; targetId: string;
  target: Row; evidence: { id: string; at: number; text: string }[]; token: string;
}
export interface LegacyChangeReconfirmation {
  token: string; evidenceIds: string[]; reason: string;
  /** Explicit new human decision, not an inferred historical value. Null means no end. */
  validToPara: number | null;
}
interface Receipt {
  version: 1; action: 'manual-reconfirmation'; createdAt: string; reason: string;
  evidence: LegacyChangeRecoveryPreview['evidence']; inputToken: string; validToPara: number | null;
  beforeTarget: Row; beforeCandidate: Candidate; beforeProvenance: Row | null;
  afterFingerprint: string; queueFingerprint: string; undoneAt?: string;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function context(store: ProjectStore, queueId: string, seriesId: string) {
  const item = store.translations.getQueueItem(queueId);
  if (!item || item.series_id !== seriesId || item.kind !== 'stale-knowledge' || item.payload.subtype === 'character-field') throw new Error('旧知识决定不存在或不属于当前作品');
  const candidate = store.db.get<Candidate>('SELECT * FROM knowledge_change_candidates WHERE id=? AND series_id=?', [String(item.payload.candidateId), seriesId]);
  if (!candidate || !Object.hasOwn(changeTables, candidate.entity_type)) throw new Error('旧知识候选或目标类型无效');
  const target = JSON.parse(changeTarget(store.db, candidate.entity_type, candidate.entity_id, seriesId)) as Row;
  return { item, candidate, target };
}

/** Conservative explicit-recovery guard, not a hot translation-path query. Include all source
 * positions and identities, including later names and manual edits; none become certified proof. */
function fingerprint(store: ProjectStore, queueId: string, seriesId: string) {
  const { candidate, target } = context(store, queueId, seriesId);
  const db = store.db;
  const owned = ['characters', 'knowledge_change_candidates', 'narrative_events', 'narrative_provenance'].map(table =>
    db.all(`SELECT * FROM ${table} WHERE series_id=? ORDER BY rowid`, [seriesId]));
  const identities = ['character_name_origins', 'character_name_observations', 'character_aliases', 'character_field_history', 'character_field_edits'].map(table =>
    db.all(`SELECT x.* FROM ${table} x JOIN characters c ON c.id=x.character_id WHERE c.series_id=? ORDER BY x.rowid`, [seriesId]));
  const aliases = db.all('SELECT x.* FROM character_alias_observations x JOIN character_aliases a ON a.id=x.alias_id JOIN characters c ON c.id=a.character_id WHERE c.series_id=? ORDER BY x.rowid', [seriesId]);
  const sources = db.all(`SELECT p.*,s.chapter_id,c.volume_id,v.volume_number,v.series_id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id JOIN volumes v ON v.id=c.volume_id WHERE v.series_id=? ORDER BY p.id`, [seriesId]);
  const otherDecisions = db.all('SELECT * FROM review_queue WHERE series_id=? AND id<>? ORDER BY id', [seriesId, queueId]);
  const targetRow = db.get(`SELECT * FROM ${changeTables[candidate.entity_type]} WHERE id=?`, [candidate.entity_id]);
  const proof = db.get('SELECT * FROM knowledge_change_proofs WHERE candidate_id=?', [candidate.id]);
  return hash({ candidate, target, targetRow, owned, identities, aliases, sources, otherDecisions, proof });
}

/** Read-only preview. Call again after a conflict; never regenerate its token at commit time. */
export function previewLegacyChangeRecovery(store: ProjectStore, queueId: string, seriesId: string, evidenceIds: string[]): LegacyChangeRecoveryPreview {
  const { item, candidate, target } = context(store, queueId, seriesId);
  if (candidate.status !== 'accepted' || item.status !== 'resolved' || item.payload.changeDecision || item.payload.legacyRecovery) throw new Error('仅无撤销快照的已采纳旧决定可重新确认；有快照时请使用真实撤销');
  if (!Array.isArray(evidenceIds) || !evidenceIds.length || evidenceIds.some(id => typeof id !== 'string')) throw new Error('请明确选择本次重新核对的原文');
  // Validate ownership and capture the current source/identity contract, without storing a proof.
  const source = originalSourceProof(store.db, seriesId, evidenceIds);
  const evidence = [...new Set(evidenceIds)].sort().map(id => {
    const p = store.projects.getParagraph(id)!;
    return { id, at: p.seriesOrdinal, text: p.sourceText };
  });
  return { queueId, seriesId, candidateId: candidate.id, kind: candidate.entity_type, targetId: candidate.entity_id, target, evidence,
    token: hash({ state: fingerprint(store, queueId, seriesId), item, source }) };
}

/** Human-only replacement of an explicitly reviewed interval. Does not claim to undo history,
 * certify old model evidence, or validate existing manuscripts. Caller must obtain explicit consent. */
export function reconfirmLegacyChange(store: ProjectStore, queueId: string, seriesId: string, decision: LegacyChangeReconfirmation): { recheckCount: number } {
  return store.transaction(() => {
    const preview = previewLegacyChangeRecovery(store, queueId, seriesId, decision.evidenceIds);
    if (decision.token !== preview.token) throw new Error('原文、身份或知识已有后续修改，请刷新重新核对；未覆盖新决定');
    if (typeof decision.reason !== 'string' || !decision.reason.trim()) throw new Error('请填写人工重新确认的理由');
    const until = decision.validToPara;
    const evidenceAt = Math.max(...preview.evidence.map(e => e.at));
    if (until !== null && (!Number.isSafeInteger(until) || until < evidenceAt || until < Number(preview.target.valid_from_para ?? 0))) throw new Error('结束位置不能早于本次证据或记录起点');
    const { item, candidate, target } = context(store, queueId, seriesId);
    const beforeProvenance = candidate.entity_type === 'relationship' ? store.db.get<Row>("SELECT * FROM narrative_provenance WHERE kind='relationship' AND record_id=?", [candidate.entity_id]) ?? null : null;
    const result = candidate.entity_type === 'character'
      ? store.db.run('UPDATE characters SET is_active=?,deactivated_at_para=? WHERE id=?', [until === null ? 1 : 0, until, candidate.entity_id])
      : candidate.entity_type === 'relationship' ? endObservedRelationship(store.db, candidate.entity_id, until)
        : store.db.run(`UPDATE ${changeTables[candidate.entity_type]} SET valid_to_para=? WHERE id=?`, [until, candidate.entity_id]);
    if (result.changes !== 1) throw new Error('重新确认未写入目标');
    // Keep the old evidence and proposal untouched. Superseded explicitly means replaced,
    // not accepted on newly fabricated source evidence and not historically undone.
    store.db.run("UPDATE knowledge_change_candidates SET status='superseded' WHERE id=?", [candidate.id]);
    const receipt: Receipt = { version: 1, action: 'manual-reconfirmation', createdAt: nowIso(), reason: decision.reason.trim(), evidence: preview.evidence,
      inputToken: preview.token, validToPara: until, beforeTarget: target, beforeCandidate: candidate, beforeProvenance,
      afterFingerprint: fingerprint(store, queueId, seriesId), queueFingerprint: hash(item) };
    store.translations.updateQueuePayload(queueId, { ...item.payload, legacyRecovery: receipt });
    const recheckCount = scheduleFieldRechecks(store, seriesId, 0, '旧知识范围已由人工重新确认，原稿保留并需重新复核');
    return { recheckCount };
  });
}

/** Undo only this new, journaled reconfirmation; the original legacy blocker then returns. */
export function undoLegacyChangeReconfirmation(store: ProjectStore, queueId: string, seriesId: string): void {
  store.transaction(() => {
    const { item, candidate } = context(store, queueId, seriesId);
    const receipt = item.payload.legacyRecovery as Receipt | undefined;
    if (!receipt || receipt.version !== 1 || receipt.action !== 'manual-reconfirmation' || receipt.undoneAt || candidate.status !== 'superseded' || item.status !== 'resolved') throw new Error('没有可撤销的重新确认记录');
    const { legacyRecovery: _, ...payload } = item.payload;
    if (receipt.afterFingerprint !== fingerprint(store, queueId, seriesId) || receipt.queueFingerprint !== hash({ ...item, payload })) throw new Error('原文、身份或知识已有后续修改，不能覆盖新决定');
    const before = receipt.beforeTarget;
    if (candidate.entity_type === 'character') store.db.run('UPDATE characters SET is_active=?,deactivated_at_para=? WHERE id=?', [before.is_active!, before.deactivated_at_para!, candidate.entity_id]);
    else store.db.run(`UPDATE ${changeTables[candidate.entity_type]} SET valid_to_para=? WHERE id=?`, [before.valid_to_para!, candidate.entity_id]);
    if (receipt.beforeProvenance) store.db.run("UPDATE narrative_provenance SET content_hash=? WHERE kind='relationship' AND record_id=?", [receipt.beforeProvenance.content_hash!, candidate.entity_id]);
    store.db.run('UPDATE knowledge_change_candidates SET status=? WHERE id=?', [receipt.beforeCandidate.status, candidate.id]);
    const history = Array.isArray(item.payload.legacyRecoveryHistory) ? item.payload.legacyRecoveryHistory : [];
    store.translations.updateQueuePayload(queueId, { ...payload, legacyRecoveryHistory: [...history, { ...receipt, undoneAt: nowIso() }] });
    scheduleFieldRechecks(store, seriesId, 0, '本次人工重新确认已撤销，原旧决定恢复为待核对状态');
  });
}
