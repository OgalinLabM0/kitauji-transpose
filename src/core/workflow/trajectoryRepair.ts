import { createHash } from 'node:crypto';
import type { ProjectStore } from '@core/db';
import { nowIso, fromJson } from '@core/db';
import { buildContextPack, parseTranslation, type AiClient } from '@core/ai';
import type { TranslationFlag } from '@shared/types';
import { verifyCandidate } from './verifyCandidate';
import { auditInput, bindAuditReceipt } from './auditReceipts';
import { assessNaturalness } from './naturalness';
import { trajectoryBatches, trajectoryReceipt, parseTrajectory, reviewVolumeTrajectory } from './trajectoryReview';
import { routeFlags } from './flagRouter';
import { pendingFieldConflicts } from './characterConflicts';
import { requireCandidateRuby } from './rubyPlan';
import { trajectoryRepairGroups, repairTrajectoryGroup } from './trajectoryGroupRepair';

/** Explicit retry preparation only. Caller must hold idle/exclusive task state. */
export function resetFailedTrajectoryRepairs(store: ProjectStore, volumeId: string): number {
  store.projects.getVolumeSeriesId(volumeId);
  return store.transaction(() => {
    let count = 0;
    for (const paragraphId of store.projects.listParagraphIdsByVolume(volumeId)) {
      const key = `trajectory-repair:${volumeId}:${paragraphId}`;
      const row = store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [key]);
      const attempt = fromJson<{ status?: string }>(row?.value ?? null, {});
      if (attempt.status !== 'failed' && attempt.status !== 'running') continue;
      store.translations.log({ level: 'info', paragraphId, workstationId: 'trajectory-reviewer', message: `用户允许再次尝试跨章修复；旧尝试记录：${row!.value}` });
      store.db.run('DELETE FROM meta WHERE key=?', [key]);
      count++;
    }
    return count;
  });
}

/** One evidence-bound attempt per unchanged final. Candidates remain private until all affected spans pass. */
export async function repairTrajectoryIssues(store: ProjectStore, ai: AiClient, volumeId: string, signal?: AbortSignal): Promise<{ repaired: number; pending: number }> {
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const groups = trajectoryRepairGroups(store, volumeId).filter(g => g.ids.length > 1);
  const groupedIds = new Set(groups.flatMap(g => g.ids));
  const targets = new Set(trajectoryBatches(store, volumeId).flatMap(b => trajectoryReceipt(store, b)?.verdict.findings.map(f => f.block_id) ?? []).filter(id => !groupedIds.has(id)));
  let repaired = 0, pending = 0;
  for (const group of groups) {
    if (await repairTrajectoryGroup(store, ai, volumeId, group, signal)) repaired += group.ids.length;
    else pending += group.ids.length;
  }
  // A failed connected group must never fall through to independent single repairs.
  for (const paragraphId of targets) {
    signal?.throwIfAborted();
    const before = trajectoryBatches(store, volumeId);
    const issues = before.flatMap(b => trajectoryReceipt(store, b)?.verdict.findings.filter(f => f.block_id === paragraphId) ?? []);
    const previous = store.translations.latestFinal(paragraphId);
    const paragraph = store.projects.getParagraph(paragraphId);
    if (!issues.length || !previous || !paragraph || previous.confirmed_by_user || issues.some(f => f.type === 'uncertain')) { pending++; continue; }
    const attemptKey = `trajectory-repair:${volumeId}:${paragraphId}`;
    const relevant = before.filter(b => [...b.items, ...b.anchors].some(p => p.id === paragraphId));
    const stamp = createHash('sha256').update(JSON.stringify(['trajectory-repair-v1', previous.id, relevant.map(b => b.hash)])).digest('hex');
    const old = store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [attemptKey]);
    if (fromJson<{ stamp?: string }>(old?.value ?? null, {}).stamp === stamp) { pending++; continue; }
    const record = (status: string, message: string) => store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [attemptKey, JSON.stringify({ stamp, status, message, at: nowIso() })]);
    const unchanged = () => JSON.stringify(store.translations.latestFinal(paragraphId)) === JSON.stringify(previous) && JSON.stringify(trajectoryBatches(store, volumeId).map(b => b.hash)) === JSON.stringify(before.map(b => b.hash));
    record('running', '正在生成并核查跨章修复候选');
    let adopted = false;
    try {
      const pack = buildContextPack(store, { paragraphIds: [paragraphId], workstation: 'faithful-translator' });
      const evidenceIds = new Set(issues.flatMap(f => f.evidence.map(e => e.id)));
      const evidence = [...new Map(before.flatMap(b => [...b.items, ...b.anchors]).filter(p => evidenceIds.has(p.id)).map(p => [p.id, { id: p.id, source: p.source, translation: p.translation }])).values()];
      const generated = await ai.structured({ workstation: 'faithful-translator', paragraphId, ...(signal ? { signal } : {}), parseRetries: 1,
        user: `${pack.text}\n【跨章定点修复】只修有日文依据的已定位问题。保留其余表达、君／酱／桑、语癖、方向和阶段，不为统一文风改写。参考文本是核对资料，不能照抄到正文。\n${JSON.stringify({ issues, evidence })}\n${JSON.stringify({ items: [{ id: paragraphId, source: paragraph.sourceText, draft: previous.final_text }] })}`,
      }, text => parseTranslation(text, [paragraphId]));
      let draft = generated.value.items[0]!;
      if (draft.translation === previous.final_text) throw new Error('修复未改变有问题的当前稿');
      const verification = await verifyCandidate(store, ai, paragraphId, draft, signal);
      draft = verification.item;
      if (!verification.proof || verification.findings.some(f => f.severity !== 'info')) throw new Error('候选未通过全部忠实与对应检查');
      if ((await assessNaturalness(store, ai, paragraphId, draft.translation, signal)).decision !== 'keep') throw new Error('候选中文读感未通过');
      if (!unchanged()) throw new Error('修复期间稿件或知识已变化');
      // Recompute boundaries with the proposed length, then check every span that uses it.
      const proposed = trajectoryBatches(store, volumeId, new Map([[paragraphId, draft.translation]]));
      const priorIssues = before.flatMap(b => trajectoryReceipt(store, b)?.verdict.findings ?? []);
      for (const batch of proposed.filter(b => [...b.items, ...b.anchors].some(p => p.id === paragraphId) || !before.some(old => old.key === b.key && old.hash === b.hash))) {
        const prose = (p: typeof batch.items[number]) => ({ id: p.id, chapter: p.chapter, source: p.source, translation: p.translation });
        const checked = await ai.structured({ workstation: 'trajectory-reviewer', paragraphId, ...(signal ? { signal } : {}), parseRetries: 1,
          user: JSON.stringify({ items: batch.items.map(prose), anchors: batch.anchors.map(prose) }),
        }, text => parseTrajectory(text, batch));
        const newOrTargetIssue = checked.value.findings.some(f => f.block_id === paragraphId || !priorIssues.some(old => old.block_id === f.block_id && old.type === f.type && JSON.stringify(old.evidence) === JSON.stringify(f.evidence)));
        if (newOrTargetIssue) throw new Error('候选跨章复验仍有目标问题或新增问题，保留原稿');
      }
      signal?.throwIfAborted();
      if (!unchanged() || auditInput(store, paragraphId).inputHash !== verification.proof.inputHash) throw new Error('修复核查期间原文、稿件或知识已变化');
      store.transaction(() => {
        signal?.throwIfAborted();
        if (!unchanged()) throw new Error('修复采纳前原稿或人工确认已变化');
        const item = verification.item;
        const flags = item.flags as TranslationFlag[];
        const analysis = store.projects.currentAnalysis(paragraphId);
        const route = routeFlags(store, { seriesId, paragraphId, seriesOrdinal: paragraph.seriesOrdinal, sourceText: paragraph.sourceText, translation: item.translation, flags, glossaryHits: pack.glossaryHits, speakerCharId: analysis?.speaker_char_id ?? null });
        if (route.mustReview || pendingFieldConflicts(store, seriesId, paragraph.seriesOrdinal).length || store.translations.listQueue(seriesId).some(q => (!q.paragraphId || q.paragraphId === paragraphId) && q.kind !== 'warning' && q.payload.type !== 'TRAJECTORY')) throw new Error('候选涉及未决定的知识，保留原稿');
        const ruby = requireCandidateRuby(store, paragraphId, item, previous);
        const candidateId = store.translations.addCandidate({ paragraphId, workstationId: 'faithful-translator', text: item.translation, flags, sourceCoverage: item.source_coverage, aiCallId: generated.aiCallId });
        const finalId = store.translations.setFinal({ paragraphId, text: item.translation, ruby, sourceCandidateId: candidateId, autoAccepted: true });
        bindAuditReceipt(store, finalId, verification.proof!);
        // Cross-chapter findings stay open until the ordinary persisted review of this final completes.
        record('repaired', `已保存核查通过的新版本 ${finalId}，等待整册轨迹回执更新`);
      });
      repaired++;
      adopted = true;
    } catch (error) {
      if (signal?.aborted) { store.db.run('DELETE FROM meta WHERE key=?', [attemptKey]); throw error; }
      pending++;
      record('failed', (error as Error).message);
      store.translations.log({ level: 'warning', paragraphId, workstationId: 'trajectory-reviewer', message: `跨章自动修复未采纳，原稿与问题保留：${(error as Error).message}` });
    }
    // Refresh persisted evidence before considering the next target; it may refer to the changed anchor.
    if (adopted) await reviewVolumeTrajectory(store, ai, volumeId, signal);
  }
  return { repaired, pending };
}
