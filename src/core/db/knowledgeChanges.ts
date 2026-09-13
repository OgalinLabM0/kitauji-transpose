import { Db, fromJson, nowIso } from './database';
import { characterSourceCurrent, originalSourceProof } from './characterSources';

export const changeTables = { term: 'terms', character: 'characters', relationship: 'relationships', address: 'address_trajectories', character_state: 'character_states' } as const;
/** Accepted interval changes still depend on their original evidence, even when their target disappeared from context. */
export function staleAcceptedChanges(db: Db, seriesId: string) {
  return db.all<{ id: string; description: string; evidence_ids: string | null; source_proof: string | null }>(`SELECT c.id,c.description,c.evidence_ids,p.source_proof FROM knowledge_change_candidates c LEFT JOIN knowledge_change_proofs p ON p.candidate_id=c.id WHERE c.series_id=? AND c.status='accepted'`, [seriesId])
    .filter(row => !characterSourceCurrent(db, row.source_proof));
}
export function assertAcceptedChangeSources(db: Db, seriesId: string): void {
  if (staleAcceptedChanges(db, seriesId).length) throw new Error('已采纳的知识变化原文依据已过期或缺失，请在工作台核对并撤销旧决定后继续；旧稿已保留');
}
export function changeTarget(db: Db, kind: string, id: string, seriesId: string): string {
  if (!Object.hasOwn(changeTables, kind)) throw new Error('不支持的知识变化目标');
  const table = changeTables[kind as keyof typeof changeTables];
  const row = db.get(`SELECT * FROM ${table} WHERE id=?`, [id]);
  const owner = kind === 'character_state' && row ? db.get<{series_id: string}>('SELECT series_id FROM characters WHERE id=?', [String(row.character_id)])?.series_id : row?.series_id;
  if (!row || owner !== seriesId) throw new Error('知识变化目标不存在或不属于当前作品，不能标记成功');
  const { updated_at, created_at, localized_at, summary_zh, description_zh, ...facts } = row;
  return JSON.stringify(facts);
}
export function bindChangeProof(db: Db, id: string, seriesId: string, kind: string, entityId: string, ids: string[], eventIds: string[] = []): void {
  db.run('INSERT INTO knowledge_change_proofs(candidate_id,source_proof,target_snapshot) VALUES(?,?,?)', [id, originalSourceProof(db, seriesId, ids, eventIds), changeTarget(db, kind, entityId, seriesId)]);
}
export function verifyChangeProof(db: Db, id: string, seriesId: string, kind: string, entityId: string): void {
  const proof = db.get<{source_proof: string; target_snapshot: string}>('SELECT * FROM knowledge_change_proofs WHERE candidate_id=?', [id]);
  if (!proof || !characterSourceCurrent(db, proof.source_proof)) throw new Error('候选原文依据已变化或缺少凭证，请重新预读；旧记录已保留');
  if (proof.target_snapshot !== changeTarget(db, kind, entityId, seriesId)) throw new Error('候选目标已被修改，请重新核对，不能覆盖后来的决定');
}

/** Only retire pending observations after their source batch has successfully been reread.
 * Caller runs this alongside replacement writes in a transaction. Human decisions stay intact. */
export function supersedeChangeCandidates(db: Db, seriesId: string, paragraphIds: string[], retained: string[]): number {
  const scope = new Set(paragraphIds), keep = new Set(retained);
  let count = 0;
  const rows = db.all<{id:string;evidence_ids:string|null;source_proof:string|null}>(`SELECT c.id,c.evidence_ids,p.source_proof FROM knowledge_change_candidates c LEFT JOIN knowledge_change_proofs p ON p.candidate_id=c.id WHERE c.series_id=? AND c.status='pending'`, [seriesId]);
  for (const row of rows) {
    if (keep.has(row.id)) continue;
    const ids = fromJson<{ids?:string[]}>(row.source_proof, {}).ids ?? fromJson<string[]>(row.evidence_ids, []);
    if (!ids.some(id => scope.has(id))) continue;
    db.run("UPDATE knowledge_change_candidates SET status='superseded' WHERE id=?", [row.id]);
    db.run(`UPDATE review_queue SET status='dismissed',resolved_at=?,resolution=? WHERE series_id=? AND kind='stale-knowledge' AND status='pending' AND json_extract(payload,'$.candidateId')=?`, [nowIso(), JSON.stringify({ action: 'superseded', reason: '来源批次已重新预读，旧候选不再参与待办；历史及人工决定保留' }), seriesId, row.id]);
    count++;
  }
  return count;
}
