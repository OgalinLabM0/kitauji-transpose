import {quirkExampleReceiptHash} from '../ai/quirkExamples';
import { bindAutomaticSources } from './automaticKnowledgeSources';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ProjectStore } from '@core/db';
import { newId, nowIso } from '@core/db';
import type { AiClient, ProtocolResult } from '@core/ai';
import { beginKnowledgeDecision, finishKnowledgeDecision } from './knowledgeDecisionJournal';
import { QUIRK_EVIDENCE_PROMPT } from '../ai/prompts/quirkEvidencePrompt';
import { dismissOrdinaryQuirk } from './ordinaryQuirkDismissal';
import { containsVisibleQuote, visibleNameSource } from '../validation/nameEvidence';

const payload = z.object({ characterId: z.string(), triggerForm: z.string().trim().min(1), proposedPattern: z.string().trim().min(1), evidenceIds: z.array(z.string()).min(2).max(8) });
const ordinaryPoliteness=(trigger:string)=>/^(?:です|ます|でした|ました|である)$/.test(trigger);
const verdict = z.object({ decision: z.enum(['supported', 'uncertain', 'rejected']), reason: z.string().trim().min(1), evidence: z.array(z.object({ id: z.string(), quote: z.string().trim().min(1) }).strict()) }).strict();

export async function resolveQuirkProposals(store: ProjectStore, ai: AiClient, volumeId: string, signal?: AbortSignal): Promise<number> {
  const seriesId = store.projects.getVolumeSeriesId(volumeId), ids = new Set(store.projects.listParagraphIdsByVolume(volumeId));
  let adopted = 0;
  for (const q of store.translations.listQueue(seriesId).filter(q => q.kind === 'quirk-candidate' && q.paragraphId && ids.has(q.paragraphId))) {
    signal?.throwIfAborted();
    try { if (await dismissOrdinaryQuirk(store,ai,q.id,volumeId,signal)) continue; }
    catch(error) { if(signal?.aborted) throw error; store.translations.log({level:'warning',paragraphId:q.paragraphId,message:`普通称谓分类未完成，候选保留：${(error as Error).message}`}); }
    const prepare = () => {
      const item = store.translations.getQueueItem(q.id);
      if (!item || item.status !== 'pending' || item.payload.knowledgeDecision || item.payload.autoSuppressed) return null;
      const result = payload.safeParse(item.payload); if (!result.success) return null;
      const p = result.data;
      if (item.payload.identityInvalidated || new Set(p.evidenceIds).size!==p.evidenceIds.length || !p.evidenceIds.includes(item.paragraph_id!)) return null;
      const members=item.payload.items;
      if(members!==undefined && (!Array.isArray(members) || members.length!==1 || members[0].paragraphId!==item.paragraph_id || !payload.safeParse(members[0]).success || JSON.stringify(payload.parse(members[0]))!==JSON.stringify(p)))return null;
      const character = store.knowledge.getCharacter(p.characterId);
      if (!character || character.series_id !== seriesId || !character.is_active || character.locked_by_user || store.knowledge.quirks(character.id).some(k => k.trigger_form === p.triggerForm)) return null;
      const evidence = [...new Set(p.evidenceIds)].map(id => {
        const paragraph = store.projects.getParagraph(id), analysis = store.projects.currentAnalysis(id);
        if (!ids.has(id) || !paragraph || !store.projects.sceneObservation(id) || analysis?.speaker_char_id !== character.id || !containsVisibleQuote(paragraph.sourceText, p.triggerForm) || paragraph.paragraphType === 'narration') return null;
        return { id, source: paragraph.sourceText, at: paragraph.seriesOrdinal, analysis };
      });
      if (evidence.length < 2 || evidence.some(e => !e)) return null;
      const sources = evidence.filter(e => !!e);
      const visibleTrigger = visibleNameSource(p.triggerForm);
      if (!visibleTrigger.trim() || sources.reduce((n, e) => n + visibleNameSource(e.source).split(visibleTrigger).length - 1, 0) < 3 || sources.reduce((n, e) => n + e.source.length, 0) > 9000) return null;
      const hash = createHash('sha256').update(JSON.stringify(['quirk-observation-v2',QUIRK_EVIDENCE_PROMPT, p, character, sources])).digest('hex');
      return { item, p, character, sources, hash };
    };
    const start = prepare(); if (!start || (start.item.payload.quirkEvidence as { inputHash?: string } | undefined)?.inputHash === start.hash) continue;
    try {
      const reviews: (z.infer<typeof verdict> & { task: string; aiCallId: string })[] = [];
      let pattern=start.p.proposedPattern;
      let renderingProposal: {pattern:string;examples:{id:string;translation:string}[];aiCallId:string}|undefined;
      for (const task of ['habit', 'rendering']) {
        signal?.throwIfAborted();
        const live = prepare();
        if (!live || live.hash !== start.hash) break;
        if(task==='rendering') {
          const proposal=await ai.structured({workstation:'quirk-evidence-reviewer',paragraphId:q.paragraphId!,parseRetries:1,...(signal?{signal}:{}),user:JSON.stringify({task:'rendering-proposal',character:start.character.canonical_name_jp,trigger:start.p.triggerForm,observation:pattern,examples:start.sources.map(e=>({id:e.id,source:visibleNameSource(e.source)}))})},(text):ProtocolResult<{pattern:string;examples:{id:string;translation:string}[]}>=>{
            try {
              const v=z.object({pattern:z.string().trim().min(1).max(500),examples:z.array(z.object({id:z.string(),translation:z.string().trim().min(1).max(4000)}).strict())}).strict().parse(JSON.parse(text));
              if(/[ぁ-ゖァ-ヺ]/.test(v.pattern) || v.examples.some(e=>/[ぁ-ゖァ-ヺ]/.test(e.translation)) || new Set(v.examples.map(e=>e.id)).size!==start.sources.length || v.examples.length!==start.sources.length || start.sources.some(s=>!v.examples.some(e=>e.id===s.id)))throw Error('中文语癖方案须提供全部原文段的中文例句');
              return {ok:true,value:v};
            }catch(e){return {ok:false,error:{code:'INVALID_SHAPE',message:(e as Error).message}};}
          });
          signal?.throwIfAborted();const checked=prepare();if(!checked || checked.hash!==start.hash)break;
          pattern=proposal.value.pattern;renderingProposal={...proposal.value,aiCallId:proposal.aiCallId};
        }
        const result = await ai.structured({ workstation: 'quirk-evidence-reviewer', paragraphId: q.paragraphId!, parseRetries: 1, ...(signal ? { signal } : {}), user: JSON.stringify({ task, character: start.character.canonical_name_jp, trigger: start.p.triggerForm, ...(task === 'rendering' ? { pattern, ...(renderingProposal?{rendering_examples:renderingProposal.examples}:{}) } : {}), examples: start.sources.map(e => ({ id: e.id, source: visibleNameSource(e.source) })) }) }, (text): ProtocolResult<z.infer<typeof verdict>> => {
          try {
            const value = verdict.parse(JSON.parse(text));
            const unique = new Set(value.evidence.map(e => e.id));
            if (unique.size !== value.evidence.length || (value.decision !== 'uncertain' && (unique.size !== start.sources.length || start.sources.some(s=>!unique.has(s.id)))) || value.evidence.some(e => !containsVisibleQuote(e.quote, start.p.triggerForm) || !start.sources.some(p => p.id === e.id && containsVisibleQuote(p.source, e.quote)))) throw new Error('语癖核对缺少真实跨段引用');
            return { ok: true, value };
          } catch (e) { return { ok: false, error: { code: 'INVALID_SHAPE', message: (e as Error).message } }; }
        });
        reviews.push({ task, ...result.value, aiCallId: result.aiCallId });
        if (result.value.decision !== 'supported' || (task==='habit' && ordinaryPoliteness(start.p.triggerForm))) break;
      }
      signal?.throwIfAborted();
      const current = prepare(); if (!current || current.hash !== start.hash) continue;
      store.transaction(() => {
        if(!reviews.length)return;
        const calls=[...reviews.map(r=>r.aiCallId),...(renderingProposal?[renderingProposal.aiCallId]:[])];
        if(calls.some(id=>!store.db.get("SELECT 1 FROM ai_calls WHERE id=? AND workstation_id='quirk-evidence-reviewer' AND error IS NULL AND finish_reason='stop'",[id])))return;
        const previous=current.item.payload.quirkEvidence;
        const evidence={inputHash:start.hash,reviews,...(renderingProposal?{renderingProposal}:{}),at:nowIso()};
        // Keep the full response even when generic source refresh later removes the active receipt.
        const history=Array.isArray(current.item.payload.quirkEvidenceHistory)?current.item.payload.quirkEvidenceHistory:[];
        store.translations.updateQueuePayload(q.id,{...current.item.payload,quirkEvidence:evidence,quirkEvidenceHistory:[...history,...(previous && !history.some(h=>JSON.stringify(h)===JSON.stringify(previous))?[previous]:[]),evidence]});
        if(reviews.some(r=>r.decision!=='supported') || ordinaryPoliteness(current.p.triggerForm)) {
          // A no-adoption disposition cannot erase the question of an already used rule.
          const records=store.db.all<{payload:string}>("SELECT payload FROM review_queue WHERE kind='quirk-candidate' AND json_extract(payload,'$.characterId')=? AND json_extract(payload,'$.triggerForm')=?",[current.character.id,current.p.triggerForm]);
          if(records.some(row=>{const p=JSON.parse(row.payload);return [p.knowledgeDecision,...(Array.isArray(p.knowledgeDecisionHistory)?p.knowledgeDecisionHistory:[])].some(j=>j?.after?.quirks?.some((k:{trigger_form?:string})=>k.trigger_form===current.p.triggerForm));} ))return;
          const journal=beginKnowledgeDecision(store,q.id);if(!journal)throw Error('无法记录未采用语癖观察的撤销');
          const last=reviews.at(-1)!;
          store.translations.updateQueuePayload(q.id,{...store.translations.getQueueItem(q.id)!.payload,automaticQuirkDecision:{action:'unadopted-quirk-observation',decision:last.decision,reason:last.reason,calls:reviews.map(r=>r.aiCallId)}});
          store.translations.resolveQueueItem(q.id,JSON.stringify({action:'unadopted-quirk-observation',decision:last.decision,reason:last.decision==='uncertain'?'证据不足，未采用此语癖观察；正文仍按原文翻译与审校。':last.decision==='supported'?'普通礼貌体不自动固化为独特语癖；按每处原文呈现，未修改人物或正文。':'审核不支持此语癖提案，未修改人物或正文。'}));
          bindAutomaticSources(store,q.id,current.sources.map(e=>e.id),true);finishKnowledgeDecision(store,q.id,journal);return;
        }
        if (reviews.length !== 2 || /[ぁ-ゖァ-ヺ]/.test(pattern) || /^(?:です|ます|でした|ました|である)$/.test(current.p.triggerForm)) return;
        const journal = beginKnowledgeDecision(store, q.id); if (!journal) throw new Error('无法记录语癖撤销');
        const at = Math.max(...current.sources.map(e => e.at));
        const quirkId=newId();
        if(renderingProposal){
          const body={version:1 as const,quirkId,characterId:current.character.id,characterName:current.character.canonical_name_jp,sources:current.sources};
          const full={...evidence,exampleReceipt:{...body,hash:quirkExampleReceiptHash(q.id,body,evidence)}};
          const live=store.translations.getQueueItem(q.id)!;
          store.translations.updateQueuePayload(q.id,{...live.payload,quirkEvidence:full,quirkEvidenceHistory:[...(live.payload.quirkEvidenceHistory as unknown[]),full]});
        }
        store.knowledge.setQuirks(current.character.id, [...store.knowledge.quirks(current.character.id), { quirk_id: quirkId,...(renderingProposal?{example_review_queue_id:q.id}:{}), quirk_type: `${current.p.triggerForm}型`, trigger_form: current.p.triggerForm, translation_pattern: pattern, confirmed_by_user: false, automatically_adopted: true, locked_at_para: at, evidence_ids: current.sources.map(e => e.id) }]);
        store.translations.resolveQueueItem(q.id, JSON.stringify({ action: 'automatic-evidenced-quirk', calls: reviews.map(r => r.aiCallId) }));
        for (const p of store.projects.translatedParagraphsContaining(seriesId, current.p.triggerForm)) {
          if (store.projects.getParagraph(p.id)!.seriesOrdinal < at) continue;
          const speaker = store.projects.currentAnalysis(p.id)?.speaker_char_id;
          if (speaker && speaker !== current.character.id) continue;
          store.translations.addRecheck(p.id, 'automatic-quirk-decision', `语癖「${current.p.triggerForm}」已自动采用，需核对当前原文与人物声音`);
        }
        bindAutomaticSources(store, q.id, current.sources.map(e => e.id), true);
        finishKnowledgeDecision(store, q.id, journal); adopted++;
      });
    } catch (error) { if (signal?.aborted) throw error; store.translations.log({ level: 'warning', paragraphId: q.paragraphId, workstationId: 'quirk-evidence-reviewer', message: `语癖自动核对失败，保留候选：${(error as Error).message}` }); }
  }
  return adopted;
}
