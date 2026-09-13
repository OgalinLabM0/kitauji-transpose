import {checkPunctuation} from './rules';

/** Restore only equal-count line/em dashes to the original glyph. Never add
 * pauses or normalize hyphens/minus signs; every punctuation position must fit. */
export function restoreSourceDashGlyphs(source:string,draft:string):string {
 const originals=source.match(/[─—]/gu)??[],generated=draft.match(/[─—]/gu)??[];
 if(!originals.length||originals.length!==generated.length)return draft;
 let index=0;
 const restored=draft.replace(/[─—]/gu,()=>originals[index++]!);
 return restored!==draft&&checkPunctuation(source,restored).length===0?restored:draft;
}
