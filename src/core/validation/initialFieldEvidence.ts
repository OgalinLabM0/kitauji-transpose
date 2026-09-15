import { z } from 'zod';
import type { ProtocolResult } from '../ai/protocol';
import { containsVisibleQuote } from './nameEvidence';
import type { InitialFieldCandidate } from '../db/initialFieldTrust';

const basis=z.array(z.object({id:z.string(),quote:z.string().trim().min(1)}).strict());
const ownerSchema=z.object({items:z.array(z.object({id:z.string(),owner:z.enum(['target','other','uncertain']),basis,reason:z.string().trim().min(1).max(1200)}).strict()).min(1).max(5)}).strict();
const supportSchema=z.object({items:z.array(z.object({id:z.string(),decision:z.enum(['adopt','local','omit','uncertain']),basis,reason:z.string().trim().min(1).max(1200)}).strict()).min(1).max(5)}).strict();
export type InitialOwnership=z.infer<typeof ownerSchema>;
export type InitialSupport=z.infer<typeof supportSchema>;
export type InitialFieldAssessment={id:string;attribution:'target'|'other'|'uncertain';support:'full'|'none'|'uncertain';scope:'durable'|'local'|'uncertain';evidence_citations:{paragraph_id:string;quote:string}[];attribution_citations:{paragraph_id:string;quote:string}[];reason:string};

/** Immutable internal group identity; proposals are never sent to the ownership stage. */
export function initialFieldInput(candidates: InitialFieldCandidate[]) {
  if(!candidates.length || candidates.length>5 || candidates.some(c=>c.characterId!==candidates[0]!.characterId))throw new Error('初次字段核对须为同人物最多五项');
  const sources=[...new Map(candidates.flatMap(c=>c.sources).map(s=>[s.id,s])).values()].sort((a,b)=>a.at-b.at);
  return {target:{id:candidates[0]!.characterId,name:candidates[0]!.name},candidates:candidates.map(c=>({id:c.id,field:c.field,proposed:c.value,name_evidence:c.nameQuote,evidence_ids:c.evidenceIds,evidence_citations:c.quotes})),sources};
}
export function initialOwnershipInput(candidates:InitialFieldCandidate[]) {
  const input=initialFieldInput(candidates),ids=new Map(input.sources.map((s,i)=>[s.id,'p'+(i+1)]));
  const focus=candidates.map((c,i)=>({id:'f'+(i+1),citations:c.evidenceIds.flatMap(id=>{const quotes=c.quotes.filter(q=>q.paragraph_id===id);return (quotes.length?quotes:[{paragraph_id:id,quote:input.sources.find(s=>s.id===id)?.text??''}]).map(q=>({id:ids.get(id)!,quote:q.quote}));})}));
  if(focus.some(f=>!f.citations.length || f.citations.some(q=>!q.id || !q.quote || !containsVisibleQuote(input.sources.find(s=>ids.get(s.id)===q.id)?.text??'',q.quote))))throw new Error('初次属性观察缺少有效原文引句');
  return {target:input.target.name,sources:input.sources.map(s=>({id:ids.get(s.id)!,text:s.text})),focus};
}
export function initialSupportInput(candidates:InitialFieldCandidate[],ownership:InitialOwnership) {
  const input=initialOwnershipInput(candidates),approved=input.focus.filter(f=>ownership.items.find(i=>i.id===f.id)?.owner==='target');
  return {target:input.target,trusted_quotes:[...new Map(approved.flatMap(f=>f.citations).map(q=>[JSON.stringify(q),q])).values()],candidates:approved.map(f=>{const c=candidates[Number(f.id.slice(1))-1]!;return {id:f.id,field:c.field,value:c.value};})};
}
function exactItems(actual:string[],expected:string[]):void {if(actual.length!==expected.length || new Set(actual).size!==expected.length || expected.some(id=>!actual.includes(id)))throw new Error('须逐项核对全部输入，不重不漏');}
export function parseInitialOwnership(text:string,candidates:InitialFieldCandidate[]):ProtocolResult<InitialOwnership> {
  try {const value=ownerSchema.parse(JSON.parse(text)),input=initialOwnershipInput(candidates);exactItems(value.items.map(i=>i.id),input.focus.map(i=>i.id));
    const owners=new Map<string,string>();
    for(const i of value.items) {
      const key=JSON.stringify(input.focus.find(f=>f.id===i.id)!.citations.map(q=>JSON.stringify(q)).sort());
      if(owners.has(key) && owners.get(key)!==i.owner)throw new Error('同一目标的相同引文不可给出相反归属');owners.set(key,i.owner);
      if(i.owner!=='uncertain' && !i.basis.length)throw new Error('明确归属须引用定位原文');for(const q of i.basis)if(!containsVisibleQuote(input.sources.find(s=>s.id===q.id)?.text??'',q.quote))throw new Error('归属引文不是所给原文');
    }
    return {ok:true,value};
  }catch(e){return {ok:false,error:{code:'INVALID_SHAPE',message:(e as Error).message}};}
}
export function parseInitialSupport(text:string,candidates:InitialFieldCandidate[],ownership:InitialOwnership):ProtocolResult<InitialSupport> {
  try {const value=supportSchema.parse(JSON.parse(text)),input=initialSupportInput(candidates,ownership);exactItems(value.items.map(i=>i.id),input.candidates.map(i=>i.id));
    for(const i of value.items) {
      if(['adopt','local'].includes(i.decision) && !i.basis.length)throw new Error('采用属性须引用本人原文');
      if(i.decision==='local' && !['voice_notes','speech_register'].includes(input.candidates.find(c=>c.id===i.id)!.field))throw new Error('局部属性仅适用于声音或语域');
      // The actual input is a shared pool of this target's independently owned
      // quotations. A complete proposal may need several of those quotations.
      for(const q of i.basis)if(!input.trusted_quotes.some(s=>s.id===q.id && containsVisibleQuote(s.quote,q.quote)))throw new Error('支持引文须属于本组已核实归属的本人原句');
    }
    return {ok:true,value};
  }catch(e){return {ok:false,error:{code:'INVALID_SHAPE',message:(e as Error).message}};}
}
/** This conversion cannot invent a positive judgment absent from either actual response. */
export function combineInitialReviews(candidates:InitialFieldCandidate[],ownership:InitialOwnership,support:InitialSupport|null):InitialFieldAssessment[] {
  const input=initialFieldInput(candidates),focus=initialOwnershipInput(candidates).focus;
  const mapped=(quotes:{id:string;quote:string}[])=>quotes.map(q=>({paragraph_id:input.sources[Number(q.id.slice(1))-1]!.id,quote:q.quote}));
  return candidates.map((c,n)=>{
    const id='f'+(n+1),owner=ownership.items.find(i=>i.id===id)!,s=support?.items.find(i=>i.id===id),adopt=owner.owner==='target' && ['adopt','local'].includes(s?.decision??'');
    // Carry the ownership proof of every borrowed quotation as well. Its owner
    // may only become identifiable later than the quoted sentence itself.
    const borrowed=s?.basis.filter(q=>!focus[n]!.citations.some(citation=>citation.id===q.id && containsVisibleQuote(citation.quote,q.quote)))??[];
    const contributing=focus.filter(f=>ownership.items.find(i=>i.id===f.id)?.owner==='target' && borrowed.some(q=>f.citations.some(citation=>citation.id===q.id && containsVisibleQuote(citation.quote,q.quote))));
    const ownershipBasis=[...owner.basis];
    for(const q of contributing.flatMap(f=>ownership.items.find(i=>i.id===f.id)!.basis))if(!ownershipBasis.some(existing=>existing.id===q.id && existing.quote===q.quote))ownershipBasis.push(q);
    return {id:c.id,attribution:owner.owner,support:adopt?'full':s?.decision==='omit'?'none':'uncertain',scope:adopt?(s?.decision==='local'?'local':'durable'):'uncertain',evidence_citations:mapped(s?.basis??focus[n]!.citations),attribution_citations:mapped(ownershipBasis),reason:[owner.reason,s?.reason].filter(Boolean).join('\n')};
  });
}
