import type { ProjectStore } from '../db';
import { fromJson } from '../db';
import { validNameQuote } from '../validation/nameEvidence';
import { withIdentityRead } from '../db/identitySources';

function currentIdentities(store:ProjectStore,id:string):Set<string>{
  const a=store.projects.currentAnalysis(id);
  return new Set(a?[a.speaker_char_id,...fromJson<string[]>(a.target_char_ids,[]),...fromJson<string[]>(a.present_char_ids,[])].filter((id):id is string=>!!id):[]);
}

/** Carry forward original-source dependencies of identities reused during reanalysis.
 * These IDs are receipts, not additional model-visible context or new participants. */
export function sceneNameCandidateSourceIds(store:ProjectStore,paragraphIds:string[]):string[]{
  const result=new Set<string>();
  for(const id of paragraphIds){
    if(!currentIdentities(store,id).size)continue;
    const row=store.db.get<{value:string}>('SELECT value FROM meta WHERE key=?',[`scene-context:${id}`]);
    const proof=fromJson<{ids?:string[]}>(row?.value,{});
    for(const sourceId of proof.ids??[])result.add(sourceId);
  }
  return [...result].sort();
}

/** Name-to-ID choices, not claims about speaker, presence or character traits. */
export function sceneNameCandidates(store: ProjectStore, paragraphIds: string[], contextIds: string[]) {
  // Names are checked separately at each paragraph's date, while their unchanged
  // source proofs can be shared within this synchronous, read-only batch.
  return withIdentityRead(store.db, () => {
  const paragraphs=paragraphIds.map(id=>store.projects.getParagraph(id)!);
  const seriesId=store.projects.getSeriesIdOfParagraph(paragraphIds[0]!);
  const sources=[...new Set([...paragraphIds,...contextIds])].map(id=>store.projects.getParagraph(id)?.sourceText??'');
  const characters=store.knowledge.listCharacters(seriesId);
  return paragraphs.map(p=>{const existing=currentIdentities(store,p.id);return {paragraph_id:p.id, candidates:characters.flatMap(c=>{
    if(!store.knowledge.nameCurrent(c,p.seriesOrdinal))return [];
    const current=store.knowledge.characterAt(c,p.seriesOrdinal);
    if(!current.is_active && (current.deactivated_at_para??Infinity)<=p.seriesOrdinal)return [];
    const names=[c.canonical_name_jp,...store.knowledge.aliasesAt(c.id,p.seriesOrdinal)];
    const matched=names.filter(name=>sources.some(source=>validNameQuote(name,name,source)));
    return matched.length||existing.has(c.id)?[{id:c.id,name_jp:c.canonical_name_jp,matched_names:matched}]:[];
  })};});
  });
}
