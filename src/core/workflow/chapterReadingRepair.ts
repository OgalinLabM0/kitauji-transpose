import { createHash } from 'node:crypto';
import type { ProjectStore } from '@core/db';
import type { TranslationFlag } from '@shared/types';
import { fromJson, nowIso } from '@core/db';
import { buildContextPack, parseTranslation, AiCallFailed, ProviderError, type AiClient } from '@core/ai';
import { RunStopped } from '../ai/runGuard';
import { prepareTranslation, commitPreparedTranslations, type PreparedTranslation } from '../db/preparedTranslations';
import { auditInput, bindAuditReceipt, type AuditProof } from './auditReceipts';
import { chapterReadingWindows, chapterReadingReceipt, chapterReadingRetained, retainChapterReading, chapterDispositionTask, CHAPTER_RECOVERY_CONTRACT, CHAPTER_DISPOSITION_INSTRUCTION, parseChapterReading, reviewChapterReading, type ChapterDisposition, type ChapterReadingWindow } from './chapterReading';
import { parseDispute } from './disputeReview';
import { verifyCandidate } from './verifyCandidate';
import { reviewRepairResolution } from './repairResolution';
import { RubyHistoryOverlay } from './rubyHistoryOverlay';
import { requireCandidateRuby, inspectCandidateRuby } from './rubyPlan';
import { trajectoryBatches, parseTrajectory, reviewVolumeTrajectory } from './trajectoryReview';
import { routeFlags } from './flagRouter';
import { pendingFieldConflicts } from './characterConflicts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const LIMITS = { findings: 8, members: 2, windows: 12, trajectory: 12 };
type ReadingReceipt = NonNullable<ReturnType<typeof chapterReadingReceipt>>;

async function dispositions(ai: AiClient, window: ChapterReadingWindow, receipt: ReadingReceipt, current: () => void, signal?: AbortSignal): Promise<ChapterDisposition[]> {
  if (receipt.verdict.findings.length > LIMITS.findings) throw new Error('章级问题超过单窗口有界复核数量，保留待处理');
  const checks: ChapterDisposition[] = [];
  for (const [index, finding] of receipt.verdict.findings.entries()) {
    current();
    const p = window.items.find(item => item.id === finding.block_id)!;
    const checked = await ai.structured({ workstation: 'dispute-reviewer', taskId: chapterDispositionTask(window, receipt, index), paragraphId: p.id, parseRetries: 1, maxOutputTokens: 1400, ...(signal ? { signal } : {}),
      user: JSON.stringify({ source: p.source, translation: p.translation, issue: finding, context: window.items.map(item => ({ id: item.id, source: item.source, translation: item.translation })), context_task: CHAPTER_DISPOSITION_INSTRUCTION }),
    }, text => parseDispute(text, p.source, p.translation));
    current();
    checks.push({ aiCallId: checked.aiCallId, verdict: checked.value });
    if (checked.value.decision === 'uncertain') throw new Error('章级问题的原文证据仍不足，需要核对具体语境');
  }
  return checks;
}

function resolveDisplay(store: ProjectStore, seriesId: string, window: ChapterReadingWindow): void {
  for (const q of store.translations.listQueue(seriesId)) if (q.payload.type === 'CHAPTER_READING' && q.payload.windowKey === window.key) store.translations.resolveQueueItem(q.id, JSON.stringify({ action: 'chapter-source-retained', hash: window.hash }));
}

/** Consume each original window at most once per unchanged case. A source-style
 * retention has its own durable proof; genuine fixes stay private until all
 * candidate, adjacent-reading and trajectory checks pass. */
export async function repairChapterReadingIssues(store: ProjectStore, ai: AiClient, volumeId: string, signal?: AbortSignal): Promise<{ retained: number; repaired: number; pending: number }> {
  const result = { retained: 0, repaired: 0, pending: 0 };
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const initialWindows = chapterReadingWindows(store, volumeId);
  for (const original of initialWindows.filter(w => { const r = chapterReadingReceipt(store, w); return r?.verdict.findings.length && !chapterReadingRetained(store, w, r); })) {
    signal?.throwIfAborted();
    // A preceding adoption may change this window. Its new diagnosis belongs to
    // a later explicit pass, never an unbounded self-generated repair loop.
    const window = chapterReadingWindows(store, volumeId).find(w => w.key === original.key && w.hash === original.hash);
    if (!window) continue;
    const receipt = chapterReadingReceipt(store, window);
    if (!receipt?.verdict.findings.length || chapterReadingRetained(store, window, receipt)) continue;
    const findings = receipt.verdict.findings;
    const snapshot = () => digest([
      chapterReadingWindows(store, volumeId).map(w => [w.key, w.hash]),
      trajectoryBatches(store, volumeId).map(b => [b.key, b.hash]),
      window.items.map(p => { const final = store.translations.latestFinal(p.id); return [store.projects.getParagraph(p.id), final, final?.source_candidate_id ? store.translations.candidateById(final.source_candidate_id) : null]; }),
      chapterReadingReceipt(store, window),
    ]);
    const base = snapshot();
    const stamp = digest([CHAPTER_RECOVERY_CONTRACT, window.hash, window.items.map(p => store.translations.latestFinal(p.id))]);
    const key = `${window.key}:repair`;
    const old = fromJson<{ stamp?: string; status?: string } | null>(store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [key])?.value, null);
    if (old?.stamp === stamp && old.status !== 'interrupted') { result.pending++; continue; }
    if (old) store.translations.log({ level: 'info', workstationId: 'chapter-reading-reviewer', paragraphId: window.items[0]!.id, message: `章级修复续接或依据变化，保留旧尝试记录：${JSON.stringify(old)}` });
    const record = (status: string, message: string) => store.transaction(() => {
      const progress = { contract: CHAPTER_RECOVERY_CONTRACT, stamp, status, message, at: nowIso() };
      store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [key, JSON.stringify(progress)]);
      for (const q of store.translations.listQueue(seriesId)) if (q.payload.type === 'CHAPTER_READING' && q.payload.windowKey === window.key && q.payload.inputHash === window.hash) store.translations.updateQueuePayload(q.id, { ...q.payload, chapterRecovery: progress });
    });
    const current = () => { signal?.throwIfAborted(); if (snapshot() !== base) throw new Error('章级修复期间原文、稿件、人工确认、知识或诊断已变化，候选未采纳'); };
    record('running', '核对章级问题与原作表达');
    let adopted = false;
    let adoptedTargets: string[] = [];
    try {
      const checks = await dispositions(ai, window, receipt, current, signal);
      if (checks.every(check => check.verdict.decision === 'retain')) {
        store.transaction(() => {
          current(); retainChapterReading(store, window, receipt, checks);
          resolveDisplay(store, seriesId, window);
          record('retained', '当前原文、稿件与相邻语境的独立复核支持保留原作表达');
        });
        result.retained++; continue;
      }
      const targets = [...new Set(findings.filter((_, i) => checks[i]!.verdict.decision === 'revise').map(f => f.block_id))].sort((a, b) => store.projects.getParagraph(a)!.seriesOrdinal - store.projects.getParagraph(b)!.seriesOrdinal);
      if (targets.length > LIMITS.members) throw new Error('章级关联修复超出有界目标数');
      if (targets.some(id => store.translations.latestFinal(id)?.confirmed_by_user)) throw new Error('章级问题涉及人工稿，保留原稿供用户核对');
      const prepared: { id: string; rows: PreparedTranslation; proof: AuditProof; item: Awaited<ReturnType<typeof verifyCandidate>>['item']; pack: ReturnType<typeof buildContextPack> }[] = [];
      for (const id of targets) {
        current();
        const previous = store.translations.latestFinal(id)!, paragraph = store.projects.getParagraph(id)!;
        const pack = buildContextPack(store, { paragraphIds: [id], workstation: 'faithful-translator' });
        const issues = findings.flatMap((f, index) => f.block_id === id && checks[index]!.verdict.decision === 'revise' ? [{ id: `${window.key}:${index}`, type: f.type, description: `${f.description}；原文核对：${checks[index]!.verdict.reason}；方向：${checks[index]!.verdict.direction}`, source_quote: f.evidence.find(e => e.id === id)!.jp, target_quote: f.evidence.find(e => e.id === id)!.zh }] : []);
        const generated = await ai.structured({ workstation: 'faithful-translator', paragraphId: id, parseRetries: 1, ...(signal ? { signal } : {}), user: `${pack.text}\n【章级定点修复】只修独立核对确认的译文问题，保留原作信息顺序、重复、残句、留白、标点、语癖、君／酱／桑和人物声音。其它段落只供核对，不改写或借入正文。返回指定目标完整JSON。\n${JSON.stringify({ issues, context: window.items.map(p => ({ id: p.id, source: p.source, translation: p.translation })) })}\n${JSON.stringify({ items: [{ id, source: paragraph.sourceText, draft: previous.final_text }] })}` }, text => parseTranslation(text, [id]));
        current();
        const history = new RubyHistoryOverlay(store, prepared.map(p => p.rows));
        const verification = await verifyCandidate(store, ai, id, generated.value.items[0]!, signal, history);
        current();
        if (!verification.proof || verification.findings.some(f => f.severity !== 'info')) throw new Error('章级修复候选未通过完整忠实、对应、声音与读感验收');
        if (verification.item.translation === previous.final_text) throw new Error('章级修复没有改变待修问题，保留原稿与诊断');
        const resolutions = await reviewRepairResolution(ai, id, paragraph.sourceText, previous.final_text, verification.item.translation, issues, signal, window.items.map(p => ({ id: p.id, source: p.source })));
        if (resolutions.some(r => r.items.some(item => item.decision !== 'resolved' && item.decision !== 'not_applicable'))) throw new Error('章级候选尚未解决指定问题，原稿保留');
        current();
        const ruby = requireCandidateRuby(store, id, verification.item, previous, history);
        prepared.push({ id, rows: prepareTranslation(store, { item: verification.item, ruby, previous, aiCallId: generated.aiCallId }), proof: verification.proof, item: verification.item, pack });
      }
      const history = new RubyHistoryOverlay(store, prepared.map(p => p.rows));
      const assertRuby = () => { for (const p of prepared) { const plan = inspectCandidateRuby(store, p.id, p.item, store.translations.rubyOf(p.rows.final), history); if (plan.findings.length || plan.inputHash !== p.proof.rubyInputHash) throw new Error('章级联合候选ruby历史与验证依据不一致'); } };
      assertRuby();
      const beforeReading = chapterReadingWindows(store, volumeId);
      const proposedReading = chapterReadingWindows(store, volumeId, true, new Map(prepared.map(p => [p.id, p.rows.final])));
      const affectedReading = proposedReading.filter(w => w.items.some(p => targets.includes(p.id)) || !beforeReading.some(oldWindow => oldWindow.key === w.key && oldWindow.hash === w.hash));
      if (affectedReading.length > LIMITS.windows || affectedReading.some(w => !w.supported)) throw new Error('章级修复关联连读超出完整复验边界');
      for (const candidate of affectedReading) {
        current();
        const checked = await ai.structured({ workstation: 'chapter-reading-reviewer', paragraphId: candidate.items[0]!.id, user: candidate.user, parseRetries: 1, ...(signal ? { signal } : {}) }, text => parseChapterReading(text, candidate));
        current();
        if (checked.value.findings.length) {
          const remaining = await dispositions(ai, candidate, { ...receipt, hash: candidate.hash, aiCallId: checked.aiCallId, verdict: checked.value }, current, signal);
          if (remaining.some(check => check.verdict.decision !== 'retain')) throw new Error('章级候选的相邻连读仍有问题，整组原稿保留');
        }
      }
      const beforeTrajectory = trajectoryBatches(store, volumeId);
      const proposedTrajectory = trajectoryBatches(store, volumeId, new Map(prepared.map(p => [p.id, p.item.translation])));
      const affectedTrajectory = proposedTrajectory.filter(b => [...b.items, ...b.anchors].some(p => targets.includes(p.id)) || !beforeTrajectory.some(oldBatch => oldBatch.key === b.key && oldBatch.hash === b.hash));
      if (affectedTrajectory.length > LIMITS.trajectory) throw new Error('章级修复关联轨迹超出有界完整复验数量');
      for (const batch of affectedTrajectory) {
        current();
        const prose = (p: typeof batch.items[number]) => ({ id: p.id, chapter: p.chapter, source: p.source, translation: p.translation });
        const checked = await ai.structured({ workstation: 'trajectory-reviewer', paragraphId: batch.items[0]!.id, user: JSON.stringify({ items: batch.items.map(prose), anchors: batch.anchors.map(prose) }), parseRetries: 1, ...(signal ? { signal } : {}) }, text => parseTrajectory(text, batch));
        current(); if (checked.value.findings.length) throw new Error('章级候选的关联轨迹仍有问题，整组原稿保留');
      }
      store.transaction(() => {
        current(); assertRuby();
        for (const p of prepared) {
          if (auditInput(store, p.id).inputHash !== p.proof.inputHash) throw new Error('章级候选的知识依据已变化');
          const paragraph = store.projects.getParagraph(p.id)!, analysis = store.projects.currentAnalysis(p.id);
          const route = routeFlags(store, { seriesId, paragraphId: p.id, seriesOrdinal: paragraph.seriesOrdinal, sourceText: paragraph.sourceText, translation: p.item.translation, flags: p.item.flags as TranslationFlag[], glossaryHits: p.pack.glossaryHits, speakerCharId: analysis?.speaker_char_id ?? null });
          if (route.mustReview || pendingFieldConflicts(store, seriesId, paragraph.seriesOrdinal).length || store.translations.listQueue(seriesId).some(q => (!q.paragraphId || q.paragraphId === p.id) && q.kind !== 'warning')) throw new Error('章级候选涉及尚未确认的术语或知识，原稿保留');
        }
        commitPreparedTranslations(store, prepared.map(p => p.rows));
        for (const p of prepared) bindAuditReceipt(store, p.rows.final.id, p.proof);
        record('repaired', '完整验收通过的章级候选已原子采纳，关联回执待刷新');
      });
      adopted = true; adoptedTargets = targets; result.repaired += prepared.length;
    } catch (error) {
      const interrupted = signal?.aborted || error instanceof RunStopped || error instanceof ProviderError || error instanceof AiCallFailed;
      record(interrupted ? 'interrupted' : 'failed', error instanceof Error ? error.message : String(error));
      if (signal?.aborted) throw error;
      result.pending++;
      store.translations.log({ level: 'warning', workstationId: 'chapter-reading-reviewer', paragraphId: window.items[0]!.id, message: `章级自动处理未完成，原稿与诊断保留：${error instanceof Error ? error.message : String(error)}` });
    }
    if (adopted) {
      await reviewVolumeTrajectory(store, ai, volumeId, signal);
      await reviewChapterReading(store, ai, volumeId, signal);
      // The newly persisted reading call has its own identity. Establish fresh
      // source-style proof if it repeats a diagnosis; never transplant an old
      // disposition across hashes or recursively edit the just-adopted draft.
      for (const committed of chapterReadingWindows(store, volumeId).filter(w => w.items.some(p => adoptedTargets.includes(p.id)))) {
        const reading = chapterReadingReceipt(store, committed);
        if (!reading?.verdict.findings.length || chapterReadingRetained(store, committed, reading)) continue;
        const live = () => { signal?.throwIfAborted(); if (!chapterReadingWindows(store, volumeId).some(w => w.key === committed.key && w.hash === committed.hash) || JSON.stringify(chapterReadingReceipt(store, committed)) !== JSON.stringify(reading)) throw new Error('采纳后的章级原译文或回执已变化，复核不写入'); };
        const checks = await dispositions(ai, committed, reading, live, signal);
        if (checks.every(check => check.verdict.decision === 'retain')) store.transaction(() => { live(); retainChapterReading(store, committed, reading, checks); resolveDisplay(store, seriesId, committed); });
        else result.pending++;
      }
    }
  }
  return result;
}
