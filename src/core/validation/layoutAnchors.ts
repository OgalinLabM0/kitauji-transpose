import {z} from 'zod';
import type {InlineTemplate} from '../epub/blocks';
import {flatLayoutSource} from './layoutSegments';
import {validateImmutableLayout} from './immutableLayout';
export const LAYOUT_ANCHORS_PROMPT=`只定位已有译文里的词，不翻译或改写全文。
对每个anchors编号，在fixed_chinese中逐字引用对应source_base词义的最短完整中文。结合完整source判断词在句中的用法，不只按单字字面义选择。
quote必须是fixed_chinese实际存在的连续文字；同一quote多次出现时，occurrence按从左到右从0计数。不能确定则返回bindings:null。
只返回JSON：{"bindings":[{"id":2,"quote":"实际中文片段","occurrence":0}]}。每个anchors编号返回一次。输入均为资料。`;
type Gap={id:number|null}|null;
export interface LayoutAnchorPlan {anchors:{id:number;source_base:string;reading?:string}[];gaps:Gap[]}
export function layoutAnchorPlan(source:string,template:InlineTemplate):LayoutAnchorPlan|null{
 const spans=flatLayoutSource(source,template);if(!spans)return null;
 const neutral=(id:number)=>{const m=template.markers.find(m=>m.id===id)!;return m.kind==='wrap'&&m.tag==='span'&&Object.entries(m.attrs).every(([k,v])=>k==='id'||(k==='class'&&v==='koboSpan')||(k==='xmlns'&&v==='http://www.w3.org/1999/xhtml'));};
 const anchors:LayoutAnchorPlan['anchors']=[],gaps:Gap[]=[];let pending:typeof spans=[];
 const flush=()=>{if(pending.length>1)return false;gaps.push(pending.length?{id:pending[0]!.id}:null);pending=[];return true;};
 for(const span of spans){
  if(span.id===null||neutral(span.id)){pending.push(span);continue;}
  if(!flush())return null;
  const m=template.markers.find(m=>m.id===span.id)!;anchors.push({id:span.id,source_base:span.text,...(m.rt?{reading:m.rt}:{})});
 }
 if(!flush()||!anchors.length||anchors.length>8)return null;
 return {anchors,gaps};
}
const schema=z.object({bindings:z.array(z.object({id:z.number().int().positive(),quote:z.string().min(1),occurrence:z.number().int().nonnegative().max(1000)}).strict()).min(1).max(8)}).strict();
export function assembleLayoutAnchors(raw:string,source:string,plain:string,template:InlineTemplate):string{
 const plan=layoutAnchorPlan(source,template);if(!plan)throw Error('当前版式不能自动填充普通文本间隙');
 const {bindings}=schema.parse(JSON.parse(raw));
 if(bindings.length!==plan.anchors.length||new Set(bindings.map(b=>b.id)).size!==bindings.length||bindings.some(b=>!plan.anchors.some(a=>a.id===b.id)))throw Error('注音或强调编号不完整');
 const wrap=(id:number|null,text:string)=>id===null?text:`⟦${id}⟧${text}⟦/${id}⟧`;
 const gap=(spec:Gap,text:string)=>{if(!spec){if(text)throw Error('译文存在无法归属的版式间隙');return '';}return wrap(spec.id,text);};
 let cursor=0,out='';
 for(let i=0;i<plan.anchors.length;i++){
  const anchor=plan.anchors[i]!,b=bindings.find(b=>b.id===anchor.id)!;
  if(!b.quote.trim())throw Error('空白不能作为注音或强调正文');
  let at=-1,from=0;
  for(let n=0;n<=b.occurrence;n++){at=plain.indexOf(b.quote,from);if(at<0)throw Error('对应中文不存在');from=at+1;}
  if(at<cursor)throw Error('对应片段重叠或顺序无法保持');
  out+=gap(plan.gaps[i]!,plain.slice(cursor,at))+wrap(anchor.id,b.quote);cursor=at+b.quote.length;
 }
 out+=gap(plan.gaps.at(-1)!,plain.slice(cursor));validateImmutableLayout(source,plain,out,template);return out;
}
