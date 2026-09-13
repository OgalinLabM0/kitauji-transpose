import { createHash } from 'node:crypto';
import type { ProjectStore, FinalRow } from '@core/db';
import { fromJson, nowIso } from '@core/db';
import { buildContextPack, parseTranslation, type AiClient, type TranslationItem } from '@core/ai';
import { prepareTranslation, commitPreparedTranslations, type PreparedTranslation } from '../db/preparedTranslations';
import { RubyHistoryOverlay } from './rubyHistoryOverlay';
import type { TranslationFlag } from '@shared/types';
import { auditInput, bindAuditReceipt, type AuditProof } from './auditReceipts';
import { verifyCandidate, type VerificationResult } from './verifyCandidate';
import { trajectoryBatches, trajectoryReceipt, parseTrajectory, type TrajectoryBatch } from './trajectoryReview';
import { requireCandidateRuby, inspectCandidateRuby } from './rubyPlan';
import { priorRubyCandidates } from './priorRubyCandidates';
import { routeFlags } from './flagRouter';
import { pendingFieldConflicts } from './characterConflicts';

export const TRAJECTORY_GROUP_LIMITS = { members: 4, evidenceCharacters: 12000, preflightBatches: 12 } as const;
type Issue = NonNullable<ReturnType<typeof trajectoryReceipt>>['verdict']['findings'][number];
export interface TrajectoryRepairGroup { ids: string[]; issues: Issue[]; blockedReason?: string }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const prose = (p: TrajectoryBatch['items'][number]) => ({ id: p.id, chapter: p.chapter, source: p.source, translation: p.translation });
const allIssues = (store: ProjectStore, batches: TrajectoryBatch[]) => batches.flatMap(b => trajectoryReceipt(store, b)?.verdict.findings ?? []);

/** Only independently diagnosed targets can be edited. A finding must actually cite
 * another diagnosed target to connect them; proximity/shared read-only anchors do not.
 * Oversized connected components remain indivisible and are refused, never truncated.
 */
export function trajectoryRepairGroups(store: ProjectStore, volumeId: string): TrajectoryRepairGroup[] {
  const batches = trajectoryBatches(store, volumeId), issues = allIssues(store, batches);
  const edges = new Map([...new Set(issues.map(f => f.block_id))].map(id => [id, new Set<string>()]));
  for (const f of issues) for (const e of f.evidence) if (e.id !== f.block_id && edges.has(e.id)) {
    edges.get(f.block_id)!.add(e.id); edges.get(e.id)!.add(f.block_id);
  }
  const seen = new Set<string>(), groups: TrajectoryRepairGroup[] = [];
  for (const start of edges.keys()) {
    if (seen.has(start)) continue;
    const ids: string[] = [], queue = [start]; seen.add(start);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!; ids.push(id);
      for (const next of edges.get(id)!) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    ids.sort((a, b) => store.projects.getParagraph(a)!.seriesOrdinal - store.projects.getParagraph(b)!.seriesOrdinal);
    const connected = issues.filter(f => ids.includes(f.block_id));
    const evidenceIds = new Set(connected.flatMap(f => f.evidence.map(e => e.id)));
    const passages = new Map(batches.flatMap(b => [...b.items, ...b.anchors]).map(p => [p.id, p]));
    const chars = [...evidenceIds].reduce((sum, id) => sum + (passages.get(id)?.source.length ?? 0) + (passages.get(id)?.translation.length ?? 0), 0);
    const blockedReason = ids.length > TRAJECTORY_GROUP_LIMITS.members ? '关联目标超过联合修复段数上限，不拆开提交'
      : chars > TRAJECTORY_GROUP_LIMITS.evidenceCharacters ? '关联证据超过联合修复字符上限，不截断证据' : undefined;
    groups.push({ ids, issues: connected, ...(blockedReason ? { blockedReason } : {}) });
  }
  return groups;
}

interface Prepared {
  id: string; pack: ReturnType<typeof buildContextPack>;
  verification: VerificationResult & { proof: AuditProof }; rows: PreparedTranslation;
}

/** Source/knowledge plus full final and candidate rows catch in-place confirmations,
 * annotations and source-candidate edits, not merely changes to latest-final IDs.
 * No manuscript/candidate writes occur during generation or model verification.
 */
function snapshot(store: ProjectStore, volumeId: string, ids: string[]): string {
  const finalSource = (id: string) => {
    const final = store.translations.latestFinal(id);
    return [final ?? null, final?.source_candidate_id ? store.translations.candidateById(final.source_candidate_id) : null];
  };
  const rubySources = ids.map(id => {
    const paragraph = store.projects.getParagraph(id)!, analysis = store.projects.currentAnalysis(id);
    const speaker = analysis?.speaker_char_id;
    return [analysis, buildContextPack(store, { paragraphIds: [id], workstation: 'faithful-translator' }).text,
      // Include the bounded history exposed if every group mark is removed. It
      // can extend beyond the original 129-row window, including earlier volumes.
      speaker ? [...new Map([
        ...priorRubyCandidates(store, store.projects.getVolumeSeriesId(volumeId), speaker, paragraph.seriesOrdinal),
        ...priorRubyCandidates(store, store.projects.getVolumeSeriesId(volumeId), speaker, paragraph.seriesOrdinal, undefined, ids),
      ].map(row => [row.id, row])).values()].map(row => {
        const p = store.projects.getParagraph(row.id)!;
        return [p, store.projects.currentAnalysis(row.id), finalSource(row.id), store.knowledge.getCharacterAt(speaker, p.seriesOrdinal)];
      }) : []];
  });
  const batches = trajectoryBatches(store, volumeId);
  // A newer review can change the repair authorization without changing prose or
  // knowledge. Never resolve findings/queue entries created after this snapshot.
  const diagnosis = [
    batches.map(b => trajectoryReceipt(store, b)),
    ids.map(id => store.translations.openFindings(id).filter(f => f.workstation_id === 'trajectory-reviewer')),
    store.translations.listQueue(store.projects.getVolumeSeriesId(volumeId))
      .filter(q => q.paragraphId && ids.includes(q.paragraphId) && q.payload.type === 'TRAJECTORY'),
  ];
  return digest([rubySources, diagnosis, batches.map(b => [b.hash, [...b.items, ...b.anchors].map(p => finalSource(p.id))])]);
}

function assertPreparedRuby(store: ProjectStore, prepared: Prepared[], overlay: RubyHistoryOverlay): void {
  for (const p of prepared) {
    const plan = inspectCandidateRuby(store, p.id, p.verification.item, store.translations.rubyOf(p.rows.final), overlay);
    if (plan.findings.length || plan.inputHash !== p.verification.proof.rubyInputHash) throw new Error('联合候选的完整未来 ruby 历史与实际审校依据不一致');
  }
}

/** All AI checks finish before the synchronous adoption transaction. Earlier
 * prepared rows are visible only through an explicit immutable ruby history view.
 * bindAuditReceipt remains unchanged and checks the actual fully committed rows.
 */
export async function repairTrajectoryGroup(store: ProjectStore, ai: AiClient, volumeId: string, group: TrajectoryRepairGroup, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (group.ids.length < 2) throw new Error('联合修复至少需要两个有诊断依据的目标');
  const currentGroup = trajectoryRepairGroups(store, volumeId).find(g => JSON.stringify(g.ids) === JSON.stringify(group.ids));
  if (!currentGroup) return false;
  group = currentGroup;
  const before = trajectoryBatches(store, volumeId), initial = snapshot(store, volumeId, group.ids);
  const previous = group.ids.map(id => store.translations.latestFinal(id));
  if (previous.some(f => !f || f.confirmed_by_user) || group.issues.some(f => f.type === 'uncertain')) return false;
  const memberSet = new Set(group.ids), seriesId = store.projects.getVolumeSeriesId(volumeId);
  const relevant = before.filter(b => [...b.items, ...b.anchors].some(p => memberSet.has(p.id)));
  const stamp = digest(['trajectory-group-v1', previous, relevant.map(b => b.hash), group.issues]);
  const keys = group.ids.map(id => `trajectory-repair:${volumeId}:${id}`);
  if (keys.some(key => fromJson<{ stamp?: string }>(store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [key])?.value, {}).stamp === stamp)) return false;
  const record = (status: string, message: string) => store.transaction(() => {
    for (const key of keys) store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [key, JSON.stringify({ stamp, status, message, groupIds: group.ids, at: nowIso() })]);
  });
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (snapshot(store, volumeId, group.ids) !== initial) throw new Error('联合修复期间原文、稿件、人工确认、知识来源或轨迹诊断已变化，整组未采纳');
  };
  record('running', '正在生成同一快照的联合修复候选');
  try {
    if (group.blockedReason) throw new Error(group.blockedReason);
    const evidenceIds = new Set(group.issues.flatMap(f => f.evidence.map(e => e.id)));
    const evidence = [...new Map(before.flatMap(b => [...b.items, ...b.anchors]).filter(p => evidenceIds.has(p.id)).map(p => [p.id, prose(p)])).values()];
    const prepared: Prepared[] = [];
    const generatedDrafts: { id: string; previous: FinalRow; pack: ReturnType<typeof buildContextPack>; draft: TranslationItem; aiCallId: string }[] = [];
    // Generate the complete group against the same unchanged manuscript/knowledge.
    // No generated text is used as knowledge or saved before independent checks.
    for (const [index, id] of group.ids.entries()) {
      assertCurrent();
      const p = store.projects.getParagraph(id)!, old = previous[index]!;
      const pack = buildContextPack(store, { paragraphIds: [id], workstation: 'faithful-translator' });
      const generated = await ai.structured({ workstation: 'faithful-translator', paragraphId: id, ...(signal ? { signal } : {}), parseRetries: 1,
        user: `${pack.text}\n【有界联合轨迹修复】仅修指定目标，整组全部通过才采纳。依据各自日文和有向关系／阶段，不统一称呼或文风；保留君／酱／桑、语癖、重复、留白和粗俗程度。其余段只读，不把候选当知识。\n${JSON.stringify({ group_ids: group.ids, issues: group.issues, evidence })}\n${JSON.stringify({ items: [{ id, source: p.sourceText, draft: old.final_text }] })}`,
      }, text => parseTranslation(text, [id]));
      assertCurrent();
      const draft = generated.value.items[0]!;
      if (draft.translation === old.final_text) throw new Error('联合修复成员未改变已有问题稿');
      generatedDrafts.push({ id, previous: old, pack, draft, aiCallId: generated.aiCallId });
    }
    // History is strictly earlier-only, so source order is a dependency order.
    // Each checker obtains real alignment itself; only after it completes can its
    // exact candidate/final rows become read-only history for the next checker.
    for (const generated of generatedDrafts) {
      assertCurrent();
      const { id, previous: old, pack, draft } = generated;
      const history = new RubyHistoryOverlay(store, prepared.map(p => p.rows));
      const verification = await verifyCandidate(store, ai, id, draft, signal, history);
      assertCurrent();
      if (!verification.proof || verification.findings.some(f => f.severity !== 'info')) throw new Error('联合修复成员未通过独立忠实、对应、声音或读感检查');
      const ruby = requireCandidateRuby(store, id, verification.item, old, history);
      const rows = prepareTranslation(store, { item: verification.item, ruby, previous: old, aiCallId: generated.aiCallId });
      prepared.push({ id, pack, verification: { ...verification, proof: verification.proof }, rows });
    }
    const history = new RubyHistoryOverlay(store, prepared.map(p => p.rows));
    assertPreparedRuby(store, prepared, history);
    const proposed = trajectoryBatches(store, volumeId, new Map(prepared.map(p => [p.id, p.verification.item.translation])));
    const affected = proposed.filter(b => [...b.items, ...b.anchors].some(p => memberSet.has(p.id)) || !before.some(old => old.key === b.key && old.hash === b.hash));
    if (affected.length > TRAJECTORY_GROUP_LIMITS.preflightBatches) throw new Error('联合修复关联复验超过有界批次数，不部分复验');
    const checked: { batch: TrajectoryBatch; aiCallId: string; verdict: NonNullable<ReturnType<typeof trajectoryReceipt>>['verdict'] }[] = [];
    for (const batch of affected) {
      assertCurrent();
      const result = await ai.structured({ workstation: 'trajectory-reviewer', paragraphId: batch.items[0]!.id, ...(signal ? { signal } : {}), parseRetries: 1,
        user: JSON.stringify({ items: batch.items.map(prose), anchors: batch.anchors.map(prose) }),
      }, text => parseTrajectory(text, batch));
      assertCurrent();
      // Every affected span must pass. An unchanged outside finding is still an
      // unresolved review, not permission to adopt this group or edit that target.
      if (result.value.findings.length) throw new Error('联合轨迹关联复验仍有未解决问题，全部关联批次通过前整组保留');
      checked.push({ batch, aiCallId: result.aiCallId, verdict: result.value });
    }
    assertCurrent();
    store.transaction(() => {
      assertCurrent();
      assertPreparedRuby(store, prepared, history);
      for (const p of prepared) {
        const paragraph = store.projects.getParagraph(p.id)!, item = p.verification.item;
        if (auditInput(store, p.id).inputHash !== p.verification.proof.inputHash) throw new Error('联合审校知识快照已失效');
        const route = routeFlags(store, { seriesId, paragraphId: p.id, seriesOrdinal: paragraph.seriesOrdinal, sourceText: paragraph.sourceText,
          translation: item.translation, flags: item.flags as TranslationFlag[], glossaryHits: p.pack.glossaryHits, speakerCharId: store.projects.currentAnalysis(p.id)?.speaker_char_id ?? null });
        if (route.mustReview || pendingFieldConflicts(store, seriesId, paragraph.seriesOrdinal).length || store.translations.listQueue(seriesId).some(q => (!q.paragraphId || q.paragraphId === p.id) && q.kind !== 'warning' && q.payload.type !== 'TRAJECTORY')) throw new Error('联合修复涉及未决定知识，整组保留');
      }
      const finals = commitPreparedTranslations(store, prepared.map(p => p.rows));
      // Bind only after every new final exists, so no receipt certifies old group history.
      for (const [index, p] of prepared.entries()) bindAuditReceipt(store, finals[index]!, p.verification.proof);
      const committed = trajectoryBatches(store, volumeId);
      for (const result of checked) {
        const batch = committed.find(b => b.key === result.batch.key);
        const payload = (b: TrajectoryBatch) => [b.items.map(p => [prose(p), p.inputHash]), b.anchors.map(p => [prose(p), p.inputHash])];
        if (!batch || digest(payload(batch)) !== digest(payload(result.batch))) throw new Error('联合轨迹预检与提交正文或知识不一致');
        // Rebind the real preflight call to the exact committed IDs; no synthetic call.
        for (const p of batch.items) {
          // Unrelated diagnosed targets retain their original findings and queue entries.
          if (!memberSet.has(p.id)) continue;
          for (const finding of store.translations.openFindings(p.id)) if (finding.workstation_id === 'trajectory-reviewer') store.translations.resolveFinding(finding.id);
          for (const q of store.translations.listQueue(seriesId)) if (q.paragraphId === p.id && q.payload.type === 'TRAJECTORY') store.translations.resolveQueueItem(q.id, JSON.stringify({ action: 'trajectory-group-rechecked', groupIds: group.ids }));
        }
        store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [batch.key, JSON.stringify({ hash: batch.hash, aiCallId: result.aiCallId, verdict: result.verdict, checkedAt: nowIso() })]);
      }
      record('repaired', '联合候选、实际检查回执和轨迹结果已在同一事务采纳');
    });
    return true;
  } catch (error) {
    record('failed', error instanceof Error ? error.message : String(error));
    if (signal?.aborted) throw error;
    store.translations.log({ level: 'warning', workstationId: 'trajectory-reviewer', paragraphId: group.ids[0]!, message: `联合修复整组未采纳，旧稿和诊断保留：${error instanceof Error ? error.message : String(error)}` });
    return false;
  }
}
