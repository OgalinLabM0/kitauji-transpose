import type {ValidationFinding} from '@shared/types';
import type {GlossaryHit} from './rules';

/** Original default conventions, not a per-book glossary or manuscript replacement. */
const terms=[['魔導師','魔导师'],['魔導士','魔导士'],['魔法使い','魔法使'],['魔法師','魔法师'],['魔術師','魔术师'],['錬金術師','炼金术师']] as const;
const count=(text:string,part:string)=>text.split(part).length-1;
export function checkWorldbuildingTerms(source:string,translation:string,hits:readonly GlossaryHit[]=[]):ValidationFinding[]{
 const out:ValidationFinding[]=[];
 for(const [jp,zh] of terms){
  // A confirmed whole expression can legitimately have a different official name.
  let remaining=source;
  for(const h of hits.filter(h=>h.lockLevel!=='suggested'&&(h.termZh||h.senses.length)&&h.termJp.includes(jp)).sort((a,b)=>b.termJp.length-a.termJp.length))remaining=remaining.split(h.termJp).join('');
  const needed=count(remaining,jp);
  if(needed&&count(translation,zh)<needed)out.push({code:'REVIEW:WORLD_TERM_PRECISION',severity:'blocks_export',message:`原词「${jp}」默认应保留为“${zh}”，不得混用其他职阶；用户明确译名另行优先`,details:{termJp:jp,termZh:zh,needed}});
 }
 return out;
}

/** Closed facial patterns avoid treating arbitrary parenthesized prose/math as kaomoji. */
export function sourceKaomoji(text:string):string[]{
 return [...text.matchAll(/[mM]?[（(]([^()（）\r\n]{1,32})[)）][mM]?/gu)].filter(m=>{
  const face=m[1]!;
  if(/^[\d\s.+*/−-]+$/u.test(face))return false;
  if(/[ωДд∀▽﹏ಠಥ]/u.test(face)&&!/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}a-ik-np-su-zA-IK-NP-SU-Z]/u.test(face))return true;
  return /^[\s*~～;；:：'"´｀`^＾＿_><TQxXoO0・.．-]+$/u.test(face)
   && (/[＿_]/u.test(face)||/[\^＾]{2}/u.test(face))
   && (face.match(/[TQxXoO0^＾><・＿_-]/gu)?.length??0)>=2;
 }).map(m=>m[0]);
}
export function checkKaomoji(source:string,translation:string):ValidationFinding[]{
 const original=sourceKaomoji(source),target=sourceKaomoji(translation);
 if(JSON.stringify(original)===JSON.stringify(target))return [];
 return [{code:'REVIEW:KAOMOJI_CHANGED',severity:'blocks_export',message:'颜文字须按原文完整保留，不能删除、改字或换成另一种表情',details:{original,target}}];
}
