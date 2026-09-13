import type {ProjectStore} from '@core/db';
import {fromJson} from '@core/db';
import {characterFactCurrent,type CharacterFact} from '../db/characterHistory';

/** Model evidence is local; only an explicit user field setting establishes a lasting stage. */
export function scopedRegisters(store:ProjectStore,seriesId:string,paragraphs:{id:string;seriesOrdinal:number;paragraphType:string}[],speakerOf:(id:string)=>string|null|undefined):{paragraphId:string;characterId:string;name:string;value:string;origin:'user'|'model'}[] {
  const rows:{paragraphId:string;characterId:string;name:string;value:string;origin:'user'|'model'}[]=[];
  const histories=new Map<string,CharacterFact[]>();
  for(const p of paragraphs){
    const speaker=speakerOf(p.id);
    if(p.paragraphType!=='dialogue' || !speaker)continue;
    const character=store.knowledge.getCharacter(speaker);
    if(!character || character.series_id!==seriesId || (!character.is_active && (character.deactivated_at_para??Infinity)<=p.seriesOrdinal) || !store.knowledge.nameCurrent(character,p.seriesOrdinal))continue;
    let facts=histories.get(speaker);
    if(!facts){facts=store.db.all<CharacterFact>("SELECT field,value_json,valid_from_para,origin,evidence_ids,source_proof FROM character_field_history WHERE character_id=? AND field='speech_register' AND origin IN ('user','model') ORDER BY valid_from_para DESC",[speaker]);histories.set(speaker,facts);}
    const current=facts.filter(f=>f.valid_from_para<=p.seriesOrdinal && characterFactCurrent(store.db,f));
    const fact=current.find(f=>f.origin==='user')??current.find(f=>f.origin==='model');
    if(!fact)continue;
    const value=fromJson<unknown>(fact.value_json,null),ids=fromJson<unknown>(fact.evidence_ids,[]);
    if(typeof value!=='string' || !value.trim() || value==='unknown' || (fact.origin==='model' && (!Array.isArray(ids) || !ids.includes(p.id))))continue;
    rows.push({paragraphId:p.id,characterId:speaker,name:character.canonical_name_jp,value,origin:fact.origin});
  }
  return rows;
}
