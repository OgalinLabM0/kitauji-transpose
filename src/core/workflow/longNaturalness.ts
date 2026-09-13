import { randomUUID } from 'node:crypto';
import type { AiClient } from '@core/ai';
import type { ProtocolResult } from '@core/ai/protocol';
import type { ProjectStore } from '@core/db';
import type { NaturalnessAssessment } from './naturalness';
import { auditInput } from './auditReceipts';
import type {NaturalnessText} from './naturalnessText';
import { LONG_NATURALNESS_CONTRACT, checkChecksum, longNaturalnessKey, longNaturalnessProofKey, makeLongReadingPlan,
  readingHash, readingRequest, readLongReadingState, validReadingCheck, type LongReadingState } from './longNaturalnessPlan';

/** Local language reading only. Full source alignment/fidelity remains the existing whole-paragraph chain. */
export async function assessLongNaturalness(store: ProjectStore, ai: AiClient, id: string, draft: string, inputHash: string,
  parse: (text: string, id: string, draft: string,visible?:NaturalnessText) => ProtocolResult<NaturalnessAssessment>, signal?: AbortSignal): Promise<NaturalnessAssessment> {
  signal?.throwIfAborted();
  const p = store.projects.getParagraph(id);
  if (!p) throw new Error('长段读感对应的原文不存在');
  const raw=store.archives.blocksOfParagraph(id)[0]?.inline_template;
  const plan = makeLongReadingPlan(id, p.sourceText, draft, p.paragraphType, inputHash,raw?JSON.parse(raw):{markers:[]});
  const finalStamp = () => readingHash(store.translations.latestFinal(id) ?? null);
  const baseFinalStamp = finalStamp(), key = longNaturalnessKey(id);
  const previous = readLongReadingState(store, plan);
  const state: LongReadingState = { contract: LONG_NATURALNESS_CONTRACT, fingerprint: plan.fingerprint, owner: randomUUID(), baseFinalStamp,
    checks: previous?.baseFinalStamp === baseFinalStamp ? previous.checks : [], complete: false };
  const unchanged = () => {
    signal?.throwIfAborted();
    if (auditInput(store, id).inputHash !== inputHash || finalStamp() !== baseFinalStamp) throw new Error('长段读感期间原文、知识或当前稿已变化；旧检查不用于后继任务，请重新复核');
  };
  unchanged();
  store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [key, JSON.stringify(state)]);
  const current = () => {
    unchanged();
    const saved = readLongReadingState(store, plan);
    if (!saved || saved.owner !== state.owner || saved.checks.length !== state.checks.length) throw new Error('长段读感检查点已由新任务接管或凭据失效，请重新复核');
  };
  for (let index = state.checks.length; index < plan.tasks.length; index++) {
    current();
    const task = plan.tasks[index]!, text = draft.slice(task.start, task.end);
    const result = await ai.structured({ workstation: 'naturalness-reviewer', paragraphId: id, taskId: task.taskId,
      user: readingRequest(plan, task), maxOutputTokens: 1100, parseRetries: 1, ...(signal ? { signal } : {}) }, response => parse(response, id, text,plan.visible?.range(task.start,task.end)));
    current();
    if (result.value.decision !== 'keep') {
      store.translations.log({ level: 'warning', workstationId: 'naturalness-reviewer', paragraphId: id,
        message: JSON.stringify({ contract: LONG_NATURALNESS_CONTRACT, fingerprint: plan.fingerprint, task, aiCallId: result.aiCallId, assessment: result.value }) });
      return result.value; // Do not start another chunk/join or persist a positive whole-paragraph result.
    }
    const body = { taskId: task.taskId, requestHash: task.requestHash, aiCallId: result.aiCallId,
      assessment: { id, decision: 'keep' as const, issues: [] as never[] } };
    const check = { ...body, checksum: checkChecksum(body) };
    if (!validReadingCheck(store, plan, index, check) || state.checks.some(c => c.aiCallId === check.aiCallId)) throw new Error('长段读感缺少独立真实成功调用凭据，未保存通过状态');
    store.transaction(() => {
      current();
      const next = { ...state, checks: [...state.checks, check] };
      store.db.run('UPDATE meta SET value=? WHERE key=?', [JSON.stringify(next), key]);
      state.checks = next.checks;
    });
  }
  store.transaction(() => {
    current();
    if (state.checks.length !== plan.tasks.length || plan.tasks.at(-1)?.kind !== 'join') throw new Error('长段读感覆盖或衔接检查尚未完整');
    const completed = JSON.stringify({ ...state, complete: true });
    store.db.run('UPDATE meta SET value=? WHERE key=?', [completed, key]);
    // Separate immutable-input proofs from the resumable current attempt. A rejected new draft
    // must not erase a previously accepted final's complete reading evidence.
    store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [longNaturalnessProofKey(plan), completed]);
  });
  return { id, decision: 'keep', issues: [] };
}
