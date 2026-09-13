import { punctuationSequence } from './rules';
const pairs:Record<string,string>={'「':'」','『':'』','“':'”','‘':'’'};
const closing=new Set(Object.values(pairs));
const shape=(c:string)=>pairs[c]?'open':closing.has(c)?'close':c;
function balanced(chars:string[]):boolean {
 const stack:string[]=[];
 for(const c of chars){if(pairs[c])stack.push(pairs[c]!);else if(closing.has(c)&&stack.pop()!==c)return false;}
 return stack.length===0;
}
/** Formatting candidate only: quote glyphs change in place, all wording and boundaries stay.
 * Full source alignment and independent review are still required before adoption. */
export function quoteGlyphCandidate(source:string,draft:string):string|null {
 const expected=punctuationSequence(source),actual=punctuationSequence(draft);
 if(expected.length!==actual.length||!balanced(expected)||!balanced(actual))return null;
 if(expected.some((c,i)=>shape(c)!==shape(actual[i]!)))return null;
 const quotes=expected.filter(c=>pairs[c]||closing.has(c));let index=0;
 const proposed=draft.replace(/[「」『』“”‘’]/g,()=>quotes[index++]!);
 if(index!==quotes.length||proposed===draft||JSON.stringify(punctuationSequence(proposed))!==JSON.stringify(expected))return null;
 return proposed;
}
