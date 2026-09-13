import {validateMarkers,type InlineTemplate} from '../epub/blocks';

export const NATURALNESS_VISIBLE_CONTRACT='naturalness-visible-raw-quote-v1';
export interface NaturalnessText {text:string;rawQuote(quote:string):string|null;range(start:number,end:number):NaturalnessText}
/** Readable flow only; the returned quote always refers to an exact raw span. */
export function naturalnessText(raw:string,template:InlineTemplate):NaturalnessText{
 if(new Set(template.markers.map(m=>m.id)).size!==template.markers.length)throw Error('读感模板标记重复');
 const validated=validateMarkers(raw,template);if(!validated.ok)throw Error(validated.error.message);
 const specs=new Map(template.markers.map(m=>[m.id,m]));
 const starts:number[]=[],ends:number[]=[];let text='',cursor=0;
 for(const token of validated.tokens){
  if(token.t==='text'){
   if(/[⟦⟧]/u.test(token.s))throw Error('读感文本包含破损标记');
   for(let i=0;i<token.s.length;i++){text+=token.s[i]!;starts.push(cursor+i);ends.push(cursor+i+1);}
   cursor+=token.s.length;
  }else{
   const marker=/^⟦\/?\d+⟧/u.exec(raw.slice(cursor));if(!marker)throw Error('读感标记位置不一致');
   if(token.t==='atomic'){
    text+=specs.get(token.id)?.tag.toLowerCase()==='br'?'\n':'\uFFFC';starts.push(cursor);ends.push(cursor+marker[0].length);
   }
   cursor+=marker[0].length;
  }
 }
 if(cursor!==raw.length)throw Error('读感原文范围不完整');
 const view=(start:number,end:number):NaturalnessText=>{
 const indices=starts.map((_,i)=>i).filter(i=>starts[i]!>=start&&ends[i]!<=end);
 const shown=indices.map(i=>text[i]!).join('');
 return {text:shown,range:(a,b)=>view(Math.max(start,a),Math.min(end,b)),rawQuote(quote:string){
  if(!quote.trim())return null;
  const at=shown.indexOf(quote);
  if(at<0||shown.indexOf(quote,at+1)>=0)return null;
  return raw.slice(starts[indices[at]!],ends[indices[at+quote.length-1]!]);
 }};
 };
 return view(0,raw.length);
}
