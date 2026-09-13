import {z} from 'zod';
import {validateMarkers,type InlineTemplate} from '../epub/blocks';
import {naturalnessText} from '../workflow/naturalnessText';
import {originalRubyEntries} from '../workflow/originalRuby';
import type {ProjectStore} from '../db';
import {PROMPT_VERSION} from '../ai/prompts/systemPrompts';
import {normalizeGeneratedStutter} from './rules';
import {punctuationChoiceProofSchema,validPunctuationChoice} from './commaSelection';
export const layoutProofSchema=z.object({source:z.string(),plain:z.string().min(1),marked:z.string().min(1),bodyCallId:z.string().min(1),layoutCallId:z.string().min(1),punctuation:punctuationChoiceProofSchema.optional(),workstation:z.enum(['faithful-translator','chinese-editor']).optional()}).strict();
export type LayoutProof=z.infer<typeof layoutProofSchema>;
export const layoutSourceCalls=(p:LayoutProof)=>[p.bodyCallId,...(p.punctuation?[p.punctuation.selectionCallId]:[]),p.layoutCallId];
export function validateImmutableLayout(source:string,plain:string,marked:string,template:InlineTemplate):void{
 if(!plain.trim()||/[⟦⟧]/u.test(plain))throw Error('正文为空或含版式标记');
 if(template.markers.some(m=>m.kind==='atomic'))throw Error('原子内容不能走正文版式分离路径');
 if(!validateMarkers(source,template).ok||!validateMarkers(marked,template).ok)throw Error('原文或译文版式标记不完整');
 if(naturalnessText(marked,template).text!==plain)throw Error('版式定位改动了中文正文');
 originalRubyEntries(source,template,marked);
}
export function validLayoutProof(store:ProjectStore,id:string,text:string,proof:LayoutProof):boolean{
 try{
  layoutProofSchema.parse(proof);
  if(proof.source!==store.projects.getParagraph(id)?.sourceText||normalizeGeneratedStutter(proof.marked)!==text||proof.bodyCallId===proof.layoutCallId)return false;
  const workstation=proof.workstation??'faithful-translator';
  if(new Set(layoutSourceCalls(proof)).size!==layoutSourceCalls(proof).length||proof.punctuation&&!validPunctuationChoice(store,id,proof.source,proof.plain,proof.punctuation,workstation))return false;
  const raw=store.archives.blocksOfParagraph(id)[0]?.inline_template;if(!raw)return false;
  validateImmutableLayout(proof.source,proof.plain,proof.marked,JSON.parse(raw));
  return [proof.bodyCallId,proof.layoutCallId].every((call,index)=>{
   const raw=store.db.get<{value:string}>('SELECT value FROM meta WHERE key=?',[`inline-call:${call}`]);
   const stage=raw?JSON.parse(raw.value):null;
   return (index===0?(stage?.stage==='body'||workstation==='chinese-editor'&&stage?.stage==='body-focus'):['layout','layout-segments','layout-anchors'].includes(stage?.stage))&&stage.paragraphId===id&&!!store.db.get("SELECT id FROM ai_calls WHERE id=? AND paragraph_id=? AND workstation_id=? AND prompt_version=? AND error IS NULL AND finish_reason='stop'",[call,id,workstation,PROMPT_VERSION]);
  });
 }catch{return false;}
}
/** Final acceptance retains both origins after the unfinished checkpoint retires. */
export function validCandidateLayoutSource(store:ProjectStore,candidate:{paragraph_id:string;ai_call_id:string|null;candidate_text:string}):boolean{
 const call=candidate.ai_call_id;if(!call)return true;
 const stage=store.db.get<{value:string}>('SELECT value FROM meta WHERE key=?',[`inline-call:${call}`]);
 if(!stage)return true;
 try{
  const raw=store.db.get<{value:string}>('SELECT value FROM meta WHERE key=?',[`inline-layout-proof:${call}`]);
  if(!raw)return false;
  const proof=layoutProofSchema.parse(JSON.parse(raw.value));
  return proof.layoutCallId===call&&validLayoutProof(store,candidate.paragraph_id,candidate.candidate_text,proof);
 }catch{return false;}
}
