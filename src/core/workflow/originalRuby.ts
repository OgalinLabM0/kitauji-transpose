import {createHash} from 'node:crypto';
import {z} from 'zod';
import {validateMarkers,type InlineTemplate} from '../epub/blocks';

export const ORIGINAL_RUBY_CONTRACT='original-ruby-attachment-meaning-v1';
export const ORIGINAL_RUBY_REVIEW_INSTRUCTION='仅当本块提供 original_ruby_entries 时，在普通 reviewed_ids/findings 之外返回 original_ruby_reviews，完整覆盖全部原作 ruby。每项仅含 markerId/sourceBase/rt/targetBase（逐字回显对应输入）、attachment 和 meaning（各为 supported|mismatch|uncertain）、非空 reason。attachment 核实原注音实际附着的中文基词是否对应原文基词，meaning 核实注层的读音、别义或双关是否保留；不能只检查标记存在。中文词的发音不要求等于日文读音，普通词音差异本身不是错误；归属错位、语义注层丢失必须指出。无法确认则 uncertain，不猜支持。';
export interface OriginalRubyEntry {markerId:number;sourceBase:string;rt:string;targetBase?:string}
const markerSchema=z.object({id:z.number().int().positive().safe(),kind:z.enum(['wrap','ruby','atomic']),tag:z.string().min(1),attrs:z.record(z.string(),z.string()),rt:z.string().optional(),xml:z.string().optional()}).strict();
const templateSchema=z.object({markers:z.array(markerSchema)}).strict();
const axis=z.enum(['supported','mismatch','uncertain']);
const reviewSchema=z.object({markerId:z.number().int().positive().safe(),sourceBase:z.string().min(1),rt:z.string().min(1),targetBase:z.string().min(1),attachment:axis,meaning:axis,reason:z.string().refine(s=>!!s.trim(),'Empty reason')}).strict();
export type OriginalRubyReview=z.infer<typeof reviewSchema>;

/** Extract only within actual ruby tokens. Other wrap boundaries remain intact. */
export function originalRubyEntries(source:string,template:InlineTemplate,draft?:string):OriginalRubyEntry[]{
 templateSchema.parse(template);
 const specs=new Map(template.markers.map(m=>[m.id,m]));
 if(specs.size!==template.markers.length)throw Error('Duplicate original ruby/template marker');
 const bases=(text:string)=>{
  if(text.replace(/⟦\/?\d+⟧/gu,'').match(/[⟦⟧]/u))throw Error('Malformed original ruby marker');
  const validated=validateMarkers(text,template);if(!validated.ok)throw Error(validated.error.message);
  const found=new Map<number,string>();let active:number|undefined;
  for(const token of validated.tokens){
   if(token.t==='text'){if(active!==undefined)found.set(active,found.get(active)!+token.s);continue;}
   const spec=specs.get(token.id)!;
   if(token.t==='atomic'){if(active!==undefined)throw Error('Atomic content inside original ruby is ambiguous');continue;}
   if(token.t==='open'&&spec.kind==='ruby'){
    if(active!==undefined)throw Error('Nested original ruby is ambiguous');
    if(!spec.rt?.trim())throw Error('Original ruby reading is empty');
    active=token.id;found.set(active,'');
   }
   if(token.t==='close'&&spec.kind==='ruby'){
    if(active!==token.id||!found.get(token.id)?.trim())throw Error('Original ruby base is empty');
    active=undefined;
   }
  }
  return found;
 };
 const sourceBases=bases(source),targetBases=draft===undefined?undefined:bases(draft);
 return [...sourceBases].map(([markerId,sourceBase])=>({markerId,sourceBase,rt:specs.get(markerId)!.rt!,...(targetBases?{targetBase:targetBases.get(markerId)!}:{})}));
}

/** Strict result body only; caller retains ordinary reviewed_ids/findings parsing. */
export function parseOriginalRubyReview(raw:unknown,expected:readonly OriginalRubyEntry[]):OriginalRubyReview[]{
 const parsed=z.array(reviewSchema).parse(typeof raw==='string'?JSON.parse(raw):raw);
 if(new Set(expected.map(e=>e.markerId)).size!==expected.length||parsed.length!==expected.length||new Set(parsed.map(r=>r.markerId)).size!==parsed.length)throw Error('Original ruby review IDs are incomplete or duplicated');
 const byId=new Map(parsed.map(r=>[r.markerId,r]));
 return expected.map(e=>{
  const review=byId.get(e.markerId);
  if(!review||e.targetBase===undefined||review.sourceBase!==e.sourceBase||review.rt!==e.rt||review.targetBase!==e.targetBase)throw Error('Original ruby review quotes do not match current source/draft');
  return review;
 });
}
const inputHash=(source:string,template:InlineTemplate,draft:string)=>createHash('sha256').update(JSON.stringify([ORIGINAL_RUBY_CONTRACT,source,template,draft])).digest('hex');
const receiptChecksum=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receiptSchema=z.object({checksum:z.string().regex(/^[a-f0-9]{64}$/),aiCallId:z.string().min(1),contract:z.literal(ORIGINAL_RUBY_CONTRACT),inputHash:z.string().regex(/^[a-f0-9]{64}$/),reviews:z.array(reviewSchema)}).strict();
export function originalRubyReceipt(source:string,template:InlineTemplate,draft:string,reviews:unknown,aiCallId:string){
 const body={aiCallId,contract:ORIGINAL_RUBY_CONTRACT,inputHash:inputHash(source,template,draft),reviews:parseOriginalRubyReview(reviews,originalRubyEntries(source,template,draft))};
 return {...body,checksum:receiptChecksum(body)};
}
export function validOriginalRubyReceipt(source:string,template:InlineTemplate,draft:string,receipt:unknown,expectedAiCallId:string):boolean{
 try{
  const parsed=receiptSchema.parse(receipt);
  const {checksum,...body}=parsed;
  if(parsed.aiCallId!==expectedAiCallId||checksum!==receiptChecksum(body)||parsed.inputHash!==inputHash(source,template,draft))return false;
  return parseOriginalRubyReview(parsed.reviews,originalRubyEntries(source,template,draft)).every(r=>r.attachment==='supported'&&r.meaning==='supported');
 }catch{return false;}
}
