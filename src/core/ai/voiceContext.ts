import type {ProjectStore,CharacterRow} from '@core/db';
import {fromJson} from '@core/db';
import {characterFactCurrent,characterFactFrom,type CharacterFact} from '../db/characterHistory';

type LocalVoice={paragraphId:string;characterId:string;name:string;note:string};
/** Context scope only. A verified source does not establish a lasting character trait. */
export function scopedBaseVoices(store:ProjectStore,characters:CharacterRow[],paragraphs:{id:string;seriesOrdinal:number;paragraphType:string}[],speakerOf:(id:string)=>string|null|undefined):{userNotes:LocalVoice[];local:LocalVoice[]} {
  const userNotes:LocalVoice[]=[],local:LocalVoice[]=[];
  for(const character of characters) {
    // Whole-profile locks, name origins and undated legacy summaries do not prove
    // that this particular voice field was confirmed by the user.
    const facts=store.db.all<CharacterFact>("SELECT character_id,field,value_json,valid_from_para,origin,evidence_ids,source_proof FROM character_field_history WHERE character_id=? AND field='voice_notes' AND origin IN ('user','model') ORDER BY valid_from_para DESC",[character.id]);
    const select=(position:number)=>{
      const current=facts.filter(f=>characterFactFrom(store.db,f)<=position && characterFactCurrent(store.db,f,character.id,'local'));
      return current.find(f=>f.origin==='user')??current.find(f=>f.origin==='model');
    };
    for(const paragraph of paragraphs) {
      // Unattributed dialogue and narration must not inherit a nearby person's voice.
      if(paragraph.paragraphType!=='dialogue' || speakerOf(paragraph.id)!==character.id)continue;
      const fact=select(paragraph.seriesOrdinal);
      if(!fact)continue;
      const ids=fromJson<unknown>(fact.evidence_ids,[]),value=fromJson<unknown>(fact.value_json,null);
      if(typeof value!=='string' || !value.trim())continue;
      const note={paragraphId:paragraph.id,characterId:character.id,name:character.canonical_name_jp,note:value};
      // User stages persist, but each target has its own effective stage. Never
      // project a batch's first voice onto later user-confirmed stages.
      if(fact.origin==='user')userNotes.push(note);
      else if(Array.isArray(ids) && ids.includes(paragraph.id))local.push(note);
    }
  }
  return {userNotes,local};
}
