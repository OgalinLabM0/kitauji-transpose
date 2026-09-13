import type { ProjectStore } from '@core/db';
import { fromJson } from '@core/db';
import { staleAcceptedChanges } from '../db/knowledgeChanges';
import type { AppliedChangeIssue } from '@shared/ipc';

export function appliedChangeIssues(store: ProjectStore, seriesId: string): AppliedChangeIssue[] {
  return staleAcceptedChanges(store.db, seriesId).map(row => {
    const queue = store.db.get<{ id: string; payload: string }>(`SELECT id,payload FROM review_queue WHERE series_id=? AND kind='stale-knowledge' AND status='resolved' AND json_extract(payload,'$.candidateId')=? ORDER BY resolved_at DESC LIMIT 1`, [seriesId, row.id]);
    const receipt = fromJson<{ changeDecision?: { version?: number; undoneAt?: string } }>(queue?.payload, {}).changeDecision;
    const rawIds = fromJson<{ ids?: unknown }>(row.source_proof, {}).ids ?? fromJson<unknown>(row.evidence_ids, []);
    const ids = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === 'string') : [];
    return { id: row.id, title: row.description, queueId: receipt?.version === 1 && !receipt.undoneAt ? queue!.id : null,
      reason: row.source_proof ? '已采纳的知识变化所依据的原文、位置或预读契约已变化，需要重新核对。' : '这条已采纳的旧知识变化缺少原文凭证，不能继续当作已验证知识。',
      sources: ids.map(id => { const p = store.projects.getParagraph(id); return { id, text: p?.sourceText ?? null, ordinal: p?.seriesOrdinal ?? null }; }) };
  });
}
