import { z } from 'zod';
import { isExplicitNonFinding } from '../ai/reviewEvidence';
import { createHash } from 'node:crypto';
import type { AiClient } from '@core/ai';
import type { ProtocolResult } from '@core/ai/protocol';
import type { ProjectStore } from '@core/db';
import { auditInput } from './auditReceipts';
import { naturalnessEvidence, naturalnessEvidenceKey, NATURALNESS_CONTRACT } from './naturalnessEvidence';
import { assessLongNaturalness } from './longNaturalness';
import { LONG_NATURALNESS_CONTRACT, NATURALNESS_SHORT_LIMIT } from './longNaturalnessPlan';
import {naturalnessText,type NaturalnessText} from './naturalnessText';
import type {InlineTemplate} from '../epub/blocks';

const schema=z.object({id:z.string(),decision:z.enum(['keep','edit','uncertain']),issues:z.array(z.object({quote_zh:z.string().trim().min(1),reason:z.string().trim().min(1).max(400),constraint:z.string().trim().min(1).max(400)}).strict()).max(3)}).strict();
export type NaturalnessAssessment=z.infer<typeof schema>;
export function parseNaturalness(text:string,id:string,draft:string,visible?:NaturalnessText):ProtocolResult<NaturalnessAssessment> {
  try {
    const value=schema.parse(JSON.parse(text));
    if(visible)for(const issue of value.issues){const raw=visible.rawQuote(issue.quote_zh);if(raw===null)throw Error('读感引用不是当前可见正文的明确连续范围');issue.quote_zh=raw;}
    if(value.issues.some(i=>isExplicitNonFinding(i.reason))) throw new Error('读感问题中包含无需修改的结论，请重新核对decision与issues；不要把通过说明作为修改理由');
    if(value.id!==id || value.issues.some(i=>!draft.includes(i.quote_zh)) || (value.decision==='keep' && value.issues.length) || (value.decision==='edit' && !value.issues.length)) throw new Error('自然度判断缺少正确块ID或具体译文依据');
    return {ok:true,value};
  } catch(e) {return {ok:false,error:{code:'INVALID_SHAPE',message:(e as Error).message}};}
}

const sessionReadings = new WeakMap<AbortSignal, Map<string, NaturalnessAssessment>>();
const retainedRefreshes = new WeakMap<AbortSignal, Set<string>>();

/** A short routing assessment; this does not replace source alignment or fidelity review. */
export async function assessNaturalness(store:ProjectStore,ai:AiClient,id:string,draft:string,signal?:AbortSignal,options?:{ refreshAfterRetainedDispute: true }):Promise<NaturalnessAssessment> {
  const p=store.projects.getParagraph(id);
  if(!p) throw new Error('自然度核对的原文不存在');
  signal?.throwIfAborted();
  const { inputHash } = auditInput(store, id);
  const retainedFinalId = options?.refreshAfterRetainedDispute ? store.translations.latestFinal(id)?.id : undefined;
  if (naturalnessEvidence(store, id, inputHash, draft)) return { id, decision: 'keep', issues: [] };
  const isLong = p.sourceText.length + draft.length > NATURALNESS_SHORT_LIMIT;
  const evidenceKey = isLong ? `${LONG_NATURALNESS_CONTRACT}:${naturalnessEvidenceKey(id, inputHash, draft)}` : naturalnessEvidenceKey(id, inputHash, draft);
  // Failed/uncertain assessments are reused only in the same task. A later
  // explicit recheck can obtain new evidence without stale negative caching.
  const taskReading = signal ? sessionReadings.get(signal)?.get(evidenceKey) : undefined;
  if (taskReading) {
    const used = signal ? retainedRefreshes.get(signal) : undefined;
    if (!options?.refreshAfterRetainedDispute || !signal || taskReading.decision === 'keep' || used?.has(evidenceKey)) return structuredClone(taskReading);
    const next = used ?? new Set<string>(); next.add(evidenceKey); retainedRefreshes.set(signal, next);
    // Consume before requesting so a failed refresh cannot grant another attempt.
  }
  if (isLong) {
    const result = await assessLongNaturalness(store, ai, id, draft, inputHash, parseNaturalness, signal);
    if (signal && result.decision !== 'keep') {
      const readings = sessionReadings.get(signal) ?? new Map<string, NaturalnessAssessment>();
      readings.set(evidenceKey, structuredClone(result)); sessionReadings.set(signal, readings);
    }
    return result;
  }
  // As in long-paragraph reading, assess Chinese expression separately from
  // source fidelity. The evidence key still binds the source and knowledge.
  const rawTemplate=store.archives.blocksOfParagraph(id)[0]?.inline_template;
  const template:InlineTemplate=rawTemplate?JSON.parse(rawTemplate):{markers:[]};
  const visible=/[⟦⟧]/u.test(draft)?naturalnessText(draft,template):undefined;
  const input={id,draft:visible?.text??draft,paragraph_type:p.paragraphType,task_scope:'只检查中文表达；原文事实、语气与施受关系由完整忠实审校另行核对'};
  const r=await ai.structured({workstation:'naturalness-reviewer',user:JSON.stringify(input),paragraphId:id,maxOutputTokens:1100,parseRetries:1,...(signal?{signal}:{})},text=>parseNaturalness(text,id,draft,visible));
  signal?.throwIfAborted();
  if(auditInput(store,id).inputHash!==inputHash) throw new Error('自然度核对期间原文或知识已改变');
  if(options?.refreshAfterRetainedDispute && store.translations.latestFinal(id)?.id !== retainedFinalId) throw new Error('争议后读感复核期间稿件已变化');
  if (r.value.decision === 'keep') store.db.run('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [evidenceKey, JSON.stringify({ contract: NATURALNESS_CONTRACT, decision: r.value.decision, assessment: r.value, aiCallId: r.aiCallId })]);
  if (signal) {
    const readings = sessionReadings.get(signal) ?? new Map<string, NaturalnessAssessment>();
    readings.set(evidenceKey, structuredClone(r.value)); sessionReadings.set(signal, readings);
  }
  store.translations.log({level:'info',workstationId:'naturalness-reviewer',paragraphId:id,message:JSON.stringify({contract:'naturalness-route-v1',inputHash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),aiCallId:r.aiCallId,assessment:r.value})});
  return r.value;
}
