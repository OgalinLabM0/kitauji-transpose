import {sourceKaomoji} from '../validation/sourceTokenPreservation';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {TranslationFlag} from '@shared/types';

export const FOREIGN_NOTE_CONTRACT='foreign-phrase-notes-v1';
export const FOREIGN_NOTE_GENERATION_RULE='外文分三类：专名、代号原样保留，不擅自加释义；用户已确认的外文专名译法优先，URL、代码、公式、颜文字不是待翻译短语；普通外文短语原样保留，并在flags返回foreign-note中文释义；含义模糊时注释只说明可证实含义与不确定处，不猜。释义由程序显示为译注，不往正文添加括号或解释。已有译注须对照当前原文保留或修正，不能将普通英语专名一概注释。';
export const FOREIGN_NOTE_REVIEW_INSTRUCTION='对foreign_entries逐项返回foreign_reviews，每项含quote、classification(named|phrase|ambiguous)、preservation(supported|mismatch|uncertain)、meaning(supported|mismatch|uncertain)、reason。quote逐字回显。依本处日文语境判外文为专名代号（含字母等级与单位）、普通表达或模糊用法：named不得添加释义；phrase和ambiguous须有准确、不过度解释的gloss_zh译注。模糊用法译注可说明不确定，不能冒充确定事实。正文须原样保留外文，释义在正文之外不算增译，也不能要求往正文补括号。缺译注、释义错误、未经依据把专名当普通表达均不通过；不能仅因同为字母就判普通短语。';
export type ForeignNote=Extract<TranslationFlag,{type:'foreign-note'}>;
const noteSchema=z.object({type:z.literal('foreign-note'),source_quote:z.string().trim().min(1).max(300),gloss_zh:z.string().trim().min(1).max(600),rationale:z.string().trim().min(1).max(600)}).strict();
export type ConfirmedForeignTerm={termJp:string;termZh:string|null;lockLevel:string};
export function foreignEntries(source:string,translation:string,flags:readonly unknown[],confirmed:readonly ConfirmedForeignTerm[]=[]){
 let visible=source.replace(/⟦\/?\d+⟧/gu,'');
 for(const face of sourceKaomoji(visible))visible=visible.split(face).join(' ');
 visible=visible.replace(/https?:\/\/[^\s「」『』<>]+|www\.[^\s「」『』<>]+|`[^`]*`|[A-Za-z0-9]+(?:\s*[=+*/^]\s*[A-Za-z0-9]+)+/gu,' ');
 for(const term of [...confirmed].sort((a,b)=>b.termJp.length-a.termJp.length))if(term.lockLevel!=='suggested'&&term.termZh&&translation.split(term.termZh).length-1>=visible.split(term.termJp).length-1)visible=visible.split(term.termJp).join(' ');
 const quotes=[...new Set((visible.match(/[\p{Script=Latin}][\p{Script=Latin}0-9０-９'’\-]*(?:[ \t]+[\p{Script=Latin}0-9０-９][\p{Script=Latin}0-9０-９'’\-]*)*[!?！？]?/gu)??[]))];
 const notes=flags.filter(f=>typeof f==='object'&&f!==null&&'type' in f&&f.type==='foreign-note').map(f=>noteSchema.parse(f));
 if(new Set(notes.map(n=>n.source_quote)).size!==notes.length)throw Error('同一外文译注重复');
 for(const n of notes)if(!quotes.includes(n.source_quote)||!translation.replace(/⟦\/?\d+⟧/gu,'').includes(n.source_quote))throw Error('外文译注不属于本段实际保留的完整外文');
 return quotes.map(quote=>({quote,preserved:translation.replace(/⟦\/?\d+⟧/gu,'').includes(quote),gloss_zh:notes.find(n=>n.source_quote===quote)?.gloss_zh??null,rationale:notes.find(n=>n.source_quote===quote)?.rationale??null}));
}
const axis=z.enum(['supported','mismatch','uncertain']);
const reviewSchema=z.object({quote:z.string().min(1),classification:z.enum(['named','phrase','ambiguous']),preservation:axis,meaning:axis,reason:z.string().trim().min(1)}).strict();
export function parseForeignReviews(raw:unknown,entries:ReturnType<typeof foreignEntries>){
 const rows=z.array(reviewSchema).parse(raw);
 if(rows.length!==entries.length||new Set(rows.map(r=>r.quote)).size!==rows.length)throw Error('外文审校未完整覆盖');
 return entries.map(e=>{const r=rows.find(r=>r.quote===e.quote);if(!r)throw Error('外文审校引文不属于当前段');return r;});
}
export function foreignReviewsPass(rows:ReturnType<typeof parseForeignReviews>,entries:ReturnType<typeof foreignEntries>){return entries.every(e=>e.preserved)&&rows.every(r=>r.preservation==='supported'&&r.meaning==='supported'&&(r.classification==='named'?!entries.find(e=>e.quote===r.quote)!.gloss_zh:!!entries.find(e=>e.quote===r.quote)!.gloss_zh));}
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function foreignNoteReceipt(source:string,translation:string,flags:readonly unknown[],raw:unknown,aiCallId:string,confirmed:readonly ConfirmedForeignTerm[]=[]){const entries=foreignEntries(source,translation,flags,confirmed);const body={contract:FOREIGN_NOTE_CONTRACT,inputHash:hash([source,translation,entries]),aiCallId,reviews:parseForeignReviews(raw,entries)};return {...body,checksum:hash(body)};}
export function validForeignNoteReceipt(source:string,translation:string,flags:readonly unknown[],raw:unknown,aiCallId:string,confirmed:readonly ConfirmedForeignTerm[]=[]){try{const r=z.object({contract:z.literal(FOREIGN_NOTE_CONTRACT),inputHash:z.string(),aiCallId:z.string(),reviews:z.array(reviewSchema),checksum:z.string()}).strict().parse(raw);const {checksum,...body}=r;return checksum===hash(body)&&r.inputHash===hash([source,translation,foreignEntries(source,translation,flags,confirmed)])&&r.aiCallId===aiCallId&&foreignReviewsPass(parseForeignReviews(r.reviews,foreignEntries(source,translation,flags,confirmed)),foreignEntries(source,translation,flags,confirmed));}catch{return false;}}
export function foreignNoteTexts(source:string,translation:string,flags:readonly unknown[]):string[]{return foreignEntries(source,translation,flags).filter(e=>e.gloss_zh).map(e=>`${e.quote}：${e.gloss_zh}`);}

/** Keep only explicit notes from this manuscript, never from an arbitrary latest candidate. */
export function inheritForeignNotes(source:string,translation:string,current:readonly unknown[],prior:readonly unknown[],confirmed:readonly ConfirmedForeignTerm[]=[]):unknown[]{
 const notes=prior.filter(f=>typeof f==='object'&&f!==null&&'type' in f&&f.type==='foreign-note').map(f=>noteSchema.parse(f));
 const own=new Set(current.filter(f=>typeof f==='object'&&f!==null&&'type' in f&&f.type==='foreign-note').map(f=>noteSchema.parse(f).source_quote));
 const plain=translation.replace(/⟦\/?\d+⟧/gu,'');
 const eligible=new Set(foreignEntries(source,translation,[],confirmed).map(e=>e.quote));
 return [...current,...notes.filter(n=>!own.has(n.source_quote)&&eligible.has(n.source_quote)&&source.replace(/⟦\/?\d+⟧/gu,'').includes(n.source_quote)&&plain.includes(n.source_quote))];
}
