/** Keep a contiguous window, counting repeated forum headers as metadata rather
 * than conversational content. Headers are retained to preserve attribution.
 * A lone numbered sentence is not enough to trigger this treatment. */
const headerLabel=(source:string):string|null=>{
 const visible=source.replace(/⟦\/?\d+⟧/gu,'').normalize('NFKC').trim();
 return /^\d{1,8}:\s+([^\r\n]{1,80})$/u.exec(visible)?.[1]?.trim()??null;
};
export function hasContextHeader(rows:readonly {sourceText:string}[]):boolean{return rows.some(r=>headerLabel(r.sourceText)!==null);}
export function meaningfulContextWindow<T extends {sourceText:string}>(rows:readonly T[],count:number,direction:'before'|'after'):T[]{
 if(!Number.isSafeInteger(count)||count<0)throw Error('Invalid context size');
 if(count===0)return [];
 const labels=rows.map(r=>headerLabel(r.sourceText)),frequencies=new Map<string,number>();
 for(const name of labels)if(name)frequencies.set(name,(frequencies.get(name)??0)+1);
 let meaningful=0,taken=0;
 const indices=rows.map((_,i)=>i);if(direction==='before')indices.reverse();
 for(const index of indices){
  taken++;
  const name=labels[index];
  if(!name||(frequencies.get(name)??0)<2)meaningful++;
  if(meaningful>=count)break;
 }
 if(direction==='after')return rows.slice(0,taken);
 let start=rows.length-taken;
 // The first retained body still needs its immediately preceding author line.
 const previous=labels[start-1];
 if(start>0&&previous&&(frequencies.get(previous)??0)>=2)start--;
 return rows.slice(start);
}
