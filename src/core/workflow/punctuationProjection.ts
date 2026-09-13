import type {AiClient, TranslationItem} from '@core/ai';
import {validateMarkers,type InlineTemplate} from '../epub/blocks';
import {restoreWholeParagraphWrap} from '../validation/wholeParagraphWrap';
import {alignSource} from './sourceAlignment';
import {commaDeletionChoices,commaChoiceSchema} from '../validation/commaSelection';
import {checkPunctuation} from '../validation/rules';

const withoutStops=(text:string)=>text.replace(/[、，,。]/gu,'');
function balancedQuotes(text:string):boolean {
  const stack:string[]=[];
  for(const c of text.match(/[「」『』]/gu)??[]){if(c==='「'||c==='『')stack.push(c);else if(stack.pop()!==(c==='」'?'「':'『'))return false;}
  return stack.length===0;
}
function plainParagraph(text:string,source:string,template:InlineTemplate):string|null {
  if(!/[⟦⟧]/u.test(text))return text;
  if(!validateMarkers(text,template).ok)return null;
  const plain=text.replace(/⟦\/?\d+⟧/gu,'');
  return restoreWholeParagraphWrap(source,plain,template)===text?plain:null;
}
function projectionInput(source:string,draft:string,template:InlineTemplate) {
  if(template.markers.length&&!validateMarkers(source,template).ok)return null;
  const jp=plainParagraph(source,source,template),zh=plainParagraph(draft,source,template);
  // Quotes are immutable target characters, not generated punctuation. Require
  // balanced identical quote order and recheck the full stop sequence afterward.
  if(jp===null||zh===null||!balancedQuotes(jp)||!balancedQuotes(zh)||(jp.match(/[「」『』]/gu)??[]).join('')!==(zh.match(/[「」『』]/gu)??[]).join('')||/[\p{P}\p{S}]/u.test(withoutStops(jp+zh).replace(/[「」『』]/gu,''))||!/[、，,]/u.test(jp))return null;
  const parts=jp.match(/[^、，,。]+(?:[、，,。]|$)/gu)??[];
  if(parts.length<2||parts.length>8||parts.join('')!==jp||parts.some(p=>!withoutStops(p).trim()))return null;
  return {jp,zh,parts};
}

/** Project only punctuation onto complete, ordered, verbatim target spans.
 * No word, whitespace, source fact, or target order is generated here. */
export function projectAlignedPunctuation(source:string,draft:string,template:InlineTemplate,coverage:TranslationItem['source_coverage']):string|null {
  const input=projectionInput(source,draft,template);
  if(!input||coverage.length!==input.parts.length)return null;
  const targets:string[]=[];
  for(const [i,c] of coverage.entries()) {
    // The aligner may call a changed stop "restructured". It is not evidence
    // of successful translation; exact spans and all later audits still apply.
    if(c.ord!==i+1||!['covered','restructured'].includes(c.status)||c.segment!==input.parts[i]||!c.rendered_as||!input.zh.includes(c.rendered_as))return null;
    const target=withoutStops(c.rendered_as);
    if(!target.trim())return null;
    targets.push(target);
  }
  if(targets.join('')!==withoutStops(input.zh))return null;
  const result=targets.map((text,i)=>text+(input.parts[i]!.match(/[、，,。]$/u)?.[0]??'').replace(/[、,]/u,'，')).join('');
  if(withoutStops(result)!==withoutStops(input.zh)||checkPunctuation(input.jp,result).length)return null;
  return restoreWholeParagraphWrap(source,result,template)??(!/[⟦⟧]/u.test(source)?result:null);
}

export async function proposePunctuationProjection(ai:AiClient,id:string,source:string,draft:string,template:InlineTemplate,signal?:AbortSignal) {
  const plain=plainParagraph(draft,source,template);
  const sourcePlain=plainParagraph(source,source,template);
  const choices=plain!==null&&sourcePlain!==null?commaDeletionChoices(sourcePlain,plain):[];
  if(choices.length){
    const selected=await ai.structured({workstation:'source-aligner',inlineStage:'punctuation-choice',paragraphId:id,user:JSON.stringify({source:sourcePlain,draft:plain,candidates:choices}),parseRetries:1,...(signal?{signal}:{})},text=>{
      try{const value=commaChoiceSchema.parse(JSON.parse(text));if(value.index!==null&&value.index>=choices.length)throw Error('候选编号不存在');return {ok:true as const,value};}
      catch(error){return {ok:false as const,error:{code:'INVALID_SHAPE' as const,message:(error as Error).message}};}
    });
    signal?.throwIfAborted();
    if(selected.value.index===null)return null;
    const chosen=choices[selected.value.index]!;
    const translation=restoreWholeParagraphWrap(source,chosen,template)??(!/[⟦⟧]/u.test(source)?chosen:null);
    return translation!==null?{translation,aiCallId:selected.aiCallId}:null;
  }
  const input=projectionInput(source,draft,template);
  if(!input)return null;
  const aligned=await alignSource(ai,id,source,draft,signal,
    '本次只定位现有中文，不翻译或改字。source_coverage逐项使用下面日文片段（含末尾标点），不可合并或拆分；rendered_as按顺序逐字引用对应中文，全部引用合起来必须覆盖整份译文的所有非标点文字，不重复使用同一位置。若无法独立对应，标uncertain，不编造对应。日文片段：'+JSON.stringify(input.parts));
  const translation=projectAlignedPunctuation(source,draft,template,aligned.value);
  return translation!==null&&translation!==draft?{translation,aiCallId:aligned.aiCallId}:null;
}
