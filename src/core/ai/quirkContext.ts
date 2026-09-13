import type {ProjectStore} from '@core/db';
import type {QuirkProfile} from '@shared/types';
import {containsVisibleQuote} from '../validation/nameEvidence';

/** Retrieve only dated rules for identified utterances, never a later whole profile. */
export function scopedQuirkRules(store:ProjectStore,seriesId:string,paragraphs:{id:string;seriesOrdinal:number;paragraphType:string;sourceText:string}[],speakerOf:(id:string)=>string|null|undefined):{characterId:string;name:string;quirk:QuirkProfile;paragraphIds:string[]}[] {
  const groups=new Map<string,{characterId:string;name:string;quirk:QuirkProfile;paragraphIds:string[]}>();
  for(const p of paragraphs){
    const speaker=speakerOf(p.id);
    if(!speaker || p.paragraphType==='narration')continue;
    const character=store.knowledge.getCharacter(speaker);
    if(!character || character.series_id!==seriesId || (!character.is_active && (character.deactivated_at_para??Infinity)<=p.seriesOrdinal) || !store.knowledge.nameCurrent(character,p.seriesOrdinal))continue;
    for(const quirk of store.knowledge.quirks(speaker)){
      if(!(quirk.confirmed_by_user || quirk.automatically_adopted) || quirk.locked_at_para>p.seriesOrdinal || !quirk.trigger_form || !containsVisibleQuote(p.sourceText,quirk.trigger_form))continue;
      const key=JSON.stringify([speaker,quirk]);
      const entry=groups.get(key);
      if(entry)entry.paragraphIds.push(p.id);
      else groups.set(key,{characterId:speaker,name:character.canonical_name_jp,quirk,paragraphIds:[p.id]});
    }
  }
  return [...groups.values()];
}
