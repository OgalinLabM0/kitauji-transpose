import { z } from 'zod';
import type { Db } from '../db/database';
import type { RubyAnnotation } from '../db';
import { stripMarkers } from '../epub/blocks';
const prefix='[english-ruby-v1]';
export const englishRubySchema=z.object({english:z.string().trim().min(1).max(300).regex(/^[\p{Script=Latin}0-9\s'’&.,!?():;\-]+$/u,'请填写英文原形，不要填写日文假名或HTML'),gloss:z.string().trim().min(1).max(300)}).strict();
export function englishRubyNotes(notes:string|null, value:unknown):string {
  const rule=englishRubySchema.parse(value);
  return [...(notes??'').split('\n').filter(l=>!l.startsWith(prefix)),prefix+JSON.stringify(rule)].filter(Boolean).join('\n');
}
export function englishRubyRules(db:Db,seriesId:string){
 return db.all<{term_jp:string;term_zh:string;notes:string}>('SELECT term_jp,term_zh,notes FROM terms WHERE series_id=? AND valid_to_para IS NULL AND lock_level<>? AND notes LIKE ?',[seriesId,'suggested',`%${prefix}%`]).flatMap(t=>{
  try{const raw=t.notes.split('\n').find(l=>l.startsWith(prefix));const rule=englishRubySchema.parse(JSON.parse(raw!.slice(prefix.length)));return rule.english===t.term_zh?[{jp:t.term_jp,...rule}]:[];}catch{return [];}
 });
}
export function englishRubyMarks(source:string,text:string,rules:ReturnType<typeof englishRubyRules>,marks:readonly RubyAnnotation[]=[]):RubyAnnotation[]{
 const plain=stripMarkers(text),jp=stripMarkers(source),out=[...marks];
 for(const r of [...rules].sort((a,b)=>b.english.length-a.english.length)){
  if(!jp.includes(r.jp))continue;
  let from=0;
  for(;;){const start=plain.indexOf(r.english,from);if(start<0)break;const end=start+r.english.length;from=end;
   if(/[A-Za-z0-9]/.test(plain[start-1]??'')||/[A-Za-z0-9]/.test(plain[end]??''))continue;
   if(out.some(m=>start<m.end&&m.start<end))continue;
   out.push({start,end,rt:r.gloss,kind:'proper-noun'});
  }
 }
 return out.sort((a,b)=>a.start-b.start);
}
