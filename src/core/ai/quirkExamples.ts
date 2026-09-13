import {createHash} from 'node:crypto';
import type {ProjectStore} from '@core/db';
import type {QuirkProfile} from '@shared/types';
import {containsVisibleQuote,visibleNameSource} from '../validation/nameEvidence';

export const quirkExampleReceiptHash=(queueId:string,receipt:unknown,evidence:unknown)=>createHash('sha256').update(JSON.stringify({queueId,receipt,evidence})).digest('hex');

/** Only independently reviewed examples for the exact adopted rule and known speaker. */
export function reviewedQuirkExamples(store:ProjectStore,characterId:string,quirk:QuirkProfile,paragraphIds:string[]):{source:string;translation:string}[] {
  try {
    if(!quirk.automatically_adopted || !quirk.example_review_queue_id)return [];
    if(!paragraphIds.some(id=>{const p=store.projects.getParagraph(id);return p && p.paragraphType!=='narration' && p.seriesOrdinal>=quirk.locked_at_para && containsVisibleQuote(p.sourceText,quirk.trigger_form) && !!store.projects.sceneObservation(id) && store.projects.currentAnalysis(id)?.speaker_char_id===characterId;}))return [];
    const item=store.translations.getQueueItem(quirk.example_review_queue_id),character=store.knowledge.getCharacter(characterId);
    if(!item || item.kind!=='quirk-candidate' || item.status!=='resolved' || !character?.is_active || item.series_id!==character.series_id || item.payload.autoSuppressed || item.payload.identityInvalidated || item.payload.characterId!==characterId || item.payload.triggerForm!==quirk.trigger_form)return [];
    if(JSON.stringify(store.knowledge.quirks(characterId).find(q=>q.quirk_id===quirk.quirk_id))!==JSON.stringify(quirk))return [];
    const journal=item.payload.knowledgeDecision as any,e=item.payload.quirkEvidence as any;
    if(!journal || journal.undoneAt || journal.invalidated || !journal.after?.quirks?.some((q:QuirkProfile)=>JSON.stringify(q)===JSON.stringify(quirk)) || !e?.exampleReceipt)return [];
    const {hash,...receipt}=e.exampleReceipt,{exampleReceipt:_receipt,...evidence}=e;
    if(receipt.version!==1 || receipt.quirkId!==quirk.quirk_id || receipt.characterId!==characterId || receipt.characterName!==character.canonical_name_jp || hash!==quirkExampleReceiptHash(item.id,receipt,evidence))return [];
    const sources=receipt.sources as {id:string;source:string;at:number;analysis:unknown}[];
    if(!Array.isArray(sources) || sources.length<2 || JSON.stringify(sources.map(s=>s.id))!==JSON.stringify(quirk.evidence_ids))return [];
    for(const source of sources){const p=store.projects.getParagraph(source.id);if(!p || store.projects.getSeriesIdOfParagraph(p.id)!==item.series_id || p.sourceText!==source.source || p.seriesOrdinal!==source.at || !store.projects.sceneObservation(p.id) || JSON.stringify(store.projects.currentAnalysis(p.id))!==JSON.stringify(source.analysis))return [];}
    const proposal=e.renderingProposal;
    if(!proposal || proposal.pattern!==quirk.translation_pattern || !Array.isArray(proposal.examples) || proposal.examples.length!==sources.length || new Set(proposal.examples.map((x:any)=>x.id)).size!==sources.length || sources.some(s=>!proposal.examples.some((x:any)=>x.id===s.id && typeof x.translation==='string' && x.translation.trim() && !/[ぁ-ゖァ-ヺ]/.test(x.translation))))return [];
    if(!Array.isArray(e.reviews) || e.reviews.length!==2 || e.reviews[0]?.task!=='habit' || e.reviews[1]?.task!=='rendering')return [];
    for(const r of e.reviews){if(r.decision!=='supported' || !Array.isArray(r.evidence) || r.evidence.length!==sources.length || sources.some(s=>!r.evidence.some((q:any)=>q.id===s.id && typeof q.quote==='string' && containsVisibleQuote(s.source,q.quote) && containsVisibleQuote(q.quote,quirk.trigger_form))))return [];}
    if([...e.reviews.map((r:any)=>r.aiCallId),proposal.aiCallId].some(id=>!store.db.get("SELECT 1 FROM ai_calls WHERE id=? AND workstation_id='quirk-evidence-reviewer' AND error IS NULL AND finish_reason='stop'",[id])))return [];
    return proposal.examples.map((x:any)=>({source:visibleNameSource(sources.find(s=>s.id===x.id)!.source),translation:x.translation as string})).filter((x:{source:string;translation:string})=>x.source.length+x.translation.length<=1000).slice(0,2);
  }catch{return [];}
}
