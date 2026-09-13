import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ProjectStore} from '../db';
import type {AiClient} from '../ai/client';
import {parseTranslation,translationItemSchema,type TranslationItem} from '../ai/protocol';
import {PROMPT_VERSION} from '../ai/prompts/systemPrompts';
import {visibleBodyPrompt} from '../ai/prompts/generationPrompts';
import {IMMUTABLE_LAYOUT_PROMPT} from '../ai/prompts/immutableLayoutPrompt';
import {originalRubyEntries} from './originalRuby';
import {validateImmutableLayout,type LayoutProof} from '../validation/immutableLayout';
import type {InlineTemplate} from '../epub/blocks';
import {flatLayoutSource,assembleLayoutSegments,LAYOUT_SEGMENTS_PROMPT} from '../validation/layoutSegments';
import {layoutAnchorPlan,assembleLayoutAnchors,LAYOUT_ANCHORS_PROMPT} from '../validation/layoutAnchors';
import {commaDeletionChoices,commaChoiceSchema,COMMA_SELECTION_PROMPT,punctuationChoiceProofSchema,validPunctuationChoice,type PunctuationChoiceProof} from '../validation/commaSelection';
import {EXPRESSION_FOCUS_PROMPT,parseFocusedReplacement,type ExpressionFocus} from '../validation/expressionFocus';

export const SEPARATED_GENERATION_CONTRACT='separated-visible-body-layout-v1';
export const separatedGenerationIdentity=()=>JSON.stringify([SEPARATED_GENERATION_CONTRACT,visibleBodyPrompt(),visibleBodyPrompt('chinese-editor'),IMMUTABLE_LAYOUT_PROMPT,LAYOUT_SEGMENTS_PROMPT,LAYOUT_ANCHORS_PROMPT,COMMA_SELECTION_PROMPT,EXPRESSION_FOCUS_PROMPT]);
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bodySchema=z.object({fingerprint:z.string(),owner:z.string(),item:translationItemSchema,aiCallId:z.string(),checksum:z.string(),punctuation:punctuationChoiceProofSchema.optional()}).strict();
/** A failed/cancelled layout keeps the successful body under exact input binding. */
export async function separatedGeneration(a:{store:ProjectStore;ai:AiClient;id:string;source:string;template:InlineTemplate;user:string;resume:boolean;signal:AbortSignal;check:()=>Promise<void>;workstation?:'faithful-translator'|'chinese-editor';focus?:ExpressionFocus}){
 const {store,ai,id,source,template,user,signal}=a;
 const workstation=a.workstation??'faithful-translator';
 if(a.focus&&workstation!=='chinese-editor')throw Error('局部表达只能编辑已有中文');
 const fingerprint=hash([SEPARATED_GENERATION_CONTRACT,PROMPT_VERSION,a.focus?EXPRESSION_FOCUS_PROMPT:visibleBodyPrompt(workstation),IMMUTABLE_LAYOUT_PROMPT,id,source,template,user,...(a.focus?[a.focus]:[])]);
 const key=`${workstation==='chinese-editor'?'separated-editor':'separated-body'}:${id}`,owner=randomUUID();
 const successful=(call:string)=>{
  const raw=store.db.get<{value:string}>('SELECT value FROM meta WHERE key=?',[`inline-call:${call}`]);
  const stage=raw?JSON.parse(raw.value):null;
  return stage?.stage===(a.focus?'body-focus':'body')&&stage.paragraphId===id&&!!store.db.get("SELECT id FROM ai_calls WHERE id=? AND paragraph_id=? AND workstation_id=? AND prompt_version=? AND error IS NULL AND finish_reason='stop'",[call,id,workstation,PROMPT_VERSION]);
 };
 let saved:z.infer<typeof bodySchema>|null=null;
 if(a.resume){try{
  const raw=store.db.get<{value:string}>('SELECT value FROM meta WHERE key=?',[key]);
  const value=bodySchema.parse(raw?JSON.parse(raw.value):null),{checksum,...body}=value;
  if(value.fingerprint===fingerprint&&checksum===hash(body)&&value.item.id===id&&!/[⟦⟧]/u.test(value.item.translation)&&successful(value.aiCallId))saved=value;
 }catch{/* Invalid cache never becomes a candidate. */}}
 await a.check();signal.throwIfAborted();
 store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)',[key,JSON.stringify({fingerprint,owner})]);
 const check=async()=>{
  await a.check();signal.throwIfAborted();
  const raw=store.db.get<{value:string}>('SELECT value FROM meta WHERE key=?',[key]);
  if(!raw||JSON.parse(raw.value).owner!==owner)throw Error('正文版式任务已被新任务接管');
 };
 let item:TranslationItem,bodyCallId:string;
 if(saved){item=saved.item;bodyCallId=saved.aiCallId;}else{
  const body=await ai.structured({workstation,inlineStage:a.focus?'body-focus':'body',paragraphId:id,user,signal,parseRetries:1},text=>{
   if(a.focus)return parseFocusedReplacement(text,id,a.focus);
   const result=parseTranslation(text,[id]);
   return result.ok&&(!result.value.items[0]!.translation.trim()||/[⟦⟧]/u.test(result.value.items[0]!.translation))?{ok:false as const,error:{code:'INVALID_SHAPE' as const,message:'本步只返回非空正文，不含版式标记'}}:result;
  });
  item=body.value.items[0]!;bodyCallId=body.aiCallId;
 }
 await check();
 const body={fingerprint,owner,item,aiCallId:bodyCallId};
 let punctuation:PunctuationChoiceProof|undefined;
 const cache=()=>{const value={...body,...(punctuation?{punctuation}: {})};store.db.run('UPDATE meta SET value=? WHERE key=?',[JSON.stringify({...value,checksum:hash(value)}),key]);};
 // Keep the paid original before attempting selection or layout.
 cache();
 store.translations.log({level:'info',workstationId:workstation,paragraphId:id,message:JSON.stringify({contract:SEPARATED_GENERATION_CONTRACT,stage:saved?'body-resumed':'body-saved',bodyCallId})});
 let fixedChinese=item.translation;
 const choices=commaDeletionChoices(source,item.translation);
 if(choices.length){
  const old=saved?.punctuation;
  if(old&&old.originalPlain===item.translation&&old.selectionCallId!==bodyCallId&&validPunctuationChoice(store,id,source,choices[old.index]??'',old,workstation)){
   punctuation=old;fixedChinese=choices[old.index]!;cache();
  }else{
   await check();
   const selection=await ai.structured({workstation,inlineStage:'punctuation-choice',paragraphId:id,user:JSON.stringify({source:source.replace(/⟦\/?\d+⟧/gu,''),draft:item.translation,candidates:choices}),signal,parseRetries:1},text=>{
    try{const value=commaChoiceSchema.parse(JSON.parse(text));if(value.index!==null&&value.index>=choices.length)throw Error('候选编号不存在');return {ok:true as const,value};}
    catch(error){return {ok:false as const,error:{code:'INVALID_SHAPE' as const,message:(error as Error).message}};}
   });
   await check();
   if(selection.value.index!==null){
    punctuation={originalPlain:item.translation,selectionCallId:selection.aiCallId,index:selection.value.index,contract:COMMA_SELECTION_PROMPT};
    fixedChinese=choices[selection.value.index]!;cache();
   }
  }
 }
 const flat=flatLayoutSource(source,template);
 const anchors=layoutAnchorPlan(source,template);
 const layout=await ai.structured({workstation,inlineStage:anchors?'layout-anchors':flat?'layout-segments':'layout',paragraphId:id,user:JSON.stringify({...anchors?{source:source.replace(/⟦\/?\d+⟧/gu,''),anchors:anchors.anchors}:flat?{source_spans:flat,required_ids:template.markers.map(m=>m.id)}:{source,template},...(!anchors?{original_ruby:originalRubyEntries(source,template)}:{}),fixed_chinese:fixedChinese}),signal,parseRetries:1},text=>{
  try{const value=anchors?{translation:assembleLayoutAnchors(text,source,fixedChinese,template)}:flat?{translation:assembleLayoutSegments(text,source,fixedChinese,template)}:z.object({translation:z.string().min(1)}).strict().parse(JSON.parse(text));validateImmutableLayout(source,fixedChinese,value.translation,template);return {ok:true as const,value};}
  catch(error){return {ok:false as const,error:{code:'INVALID_SHAPE' as const,message:(error as Error).message}};}
 });
 await check();
 const proof:LayoutProof={source,plain:fixedChinese,marked:layout.value.translation,bodyCallId,layoutCallId:layout.aiCallId,...(punctuation?{punctuation}: {}),...(workstation==='chinese-editor'?{workstation}: {})};
 store.db.run('INSERT INTO meta(key,value) VALUES(?,?)',[`inline-layout-proof:${layout.aiCallId}`,JSON.stringify(proof)]);
 store.translations.log({level:'info',workstationId:workstation,paragraphId:id,message:JSON.stringify({contract:SEPARATED_GENERATION_CONTRACT,stage:'layout-complete',bodyCallId,layoutCallId:layout.aiCallId,visibleTextUnchanged:true})});
 return {...layout,value:{items:[{...item,translation:layout.value.translation}]},layoutProof:proof};
}
