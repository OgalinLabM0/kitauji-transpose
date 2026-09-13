import type {ProjectStore} from '@core/db';

/** Only preceding original prose: two paragraphs before the earliest example in each chapter. */
export function termBackground(store:ProjectStore,exampleIds:readonly string[]) {
  const examples=exampleIds.map(id=>store.projects.getParagraph(id));
  if(examples.some(p=>!p)) return [];
  const firstByChapter=new Map<string,number>();
  for(const p of examples)firstByChapter.set(p!.chapterId,Math.min(firstByChapter.get(p!.chapterId)??Infinity,p!.seriesOrdinal));
  const selected:{id:string;text:string;ordinal:number;chapterId:string;seriesId:string;type:string}[]=[];
  let remaining=2400;
  for(const [chapterId,before] of [...firstByChapter].sort((a,b)=>a[1]-b[1] || a[0].localeCompare(b[0]))) {
    const previous=store.projects.listParagraphIdsByChapter(chapterId).map(id=>store.projects.getParagraph(id)!).filter(p=>p.seriesOrdinal<before && !exampleIds.includes(p.id)).slice(-2);
    for(const p of previous.reverse()) {
      if(selected.length>=4) return selected.sort((a,b)=>a.ordinal-b.ordinal || a.id.localeCompare(b.id));
      if(!p.sourceText.trim() || p.sourceText.length>remaining) continue;
      selected.push({id:p.id,text:p.sourceText,ordinal:p.seriesOrdinal,chapterId:p.chapterId,seriesId:store.projects.getSeriesIdOfParagraph(p.id),type:p.paragraphType});
      remaining-=p.sourceText.length;
    }
  }
  return selected.sort((a,b)=>a.ordinal-b.ordinal || a.id.localeCompare(b.id));
}
