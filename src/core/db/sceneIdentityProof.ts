import { characterFactCurrent, characterFactFrom, type CharacterFact } from './characterHistory';
import { createHash } from 'node:crypto';
import { Db } from './database';
import { preparationContract } from '../ai/preparationContract';
import { characterSourceCurrent } from './characterSources';
import { narrativeSourceCurrent } from './narrativeSources';
import { withIdentityRead } from './identitySources';

type Rows = Record<string, unknown>[];
const cache = new WeakMap<Db, { stamp:string; series:Map<string,Map<string,Rows>>; signatures:Map<string,Map<number,string>> }>();

/** Conservative knowledge dependency, never a source of model-visible facts.
 * Analysis writes and translation drafts deliberately do not participate. */
export function sceneIdentitySignature(db: Db, paragraphIds: string[]): string {
  // This function only reads knowledge and source dependencies. Share their DAG
  // proof checks within this synchronous call; release before any caller writes
  // analysis or knowledge, and keep the existing snapshot-stamp invalidation.
  return withIdentityRead(db, () => {
  const scope = db.all<{id:string;series_id:string;series_ordinal:number}>(`SELECT p.id,p.series_ordinal,v.series_id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id JOIN volumes v ON v.id=c.volume_id WHERE p.id IN (${paragraphIds.map(()=>'?').join(',')})`,paragraphIds);
  if(scope.length!==new Set(paragraphIds).size)throw new Error('场景姓名依据的原文已不存在');
  const series = [...new Set(scope.map(p=>p.series_id))];
  if (series.length !== 1) throw new Error('场景姓名依据必须属于同一作品');
  // total_changes catches this connection, data_version catches other connections.
  const stamp = JSON.stringify([db.get('SELECT total_changes() AS n, data_version FROM pragma_data_version'),preparationContract('preread')]);
  let memo=cache.get(db);
  if(!memo || memo.stamp!==stamp){memo={stamp,series:new Map(),signatures:new Map()};cache.set(db,memo);}
  const at=Math.max(...scope.map(p=>p.series_ordinal));
  // The signature depends on series knowledge at this date, not which valid
  // scope IDs established it. Always validate scope above, even on a hit.
  // Never retain uncommitted snapshots: rollback does not undo total_changes.
  const cached=!db.raw.isTransaction ? memo.signatures.get(series[0]!)?.get(at) : undefined;
  if(cached!==undefined)return cached;
  const rows: unknown[] = [preparationContract('preread'), 'scene-identity-v1'];
  const stable = (items: Record<string, unknown>[]) => items.map(item => Object.fromEntries(Object.entries(item).filter(([key]) => !['created_at','updated_at','localized_at','quirk_profiles','summary_zh','description_zh'].includes(key)))).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  let data=!db.raw.isTransaction ? memo.series.get(series[0]!) : undefined;
  if(!data){
    data=new Map();
    for(const table of ['characters','relationships','narrative_events'])data.set(table,db.all(`SELECT * FROM ${table} WHERE series_id=?`,[series[0]!]));
    for(const table of ['character_name_origins','character_name_observations','character_field_history','character_aliases','character_states'])data.set(table,db.all(`SELECT t.* FROM ${table} t JOIN characters c ON c.id=t.character_id WHERE c.series_id=?`,[series[0]!]));
    data.set('character_alias_observations',db.all(`SELECT o.* FROM character_alias_observations o JOIN character_aliases a ON a.id=o.alias_id JOIN characters c ON c.id=a.character_id WHERE c.series_id=?`,[series[0]!]));
    // Evidence can become stale without changing its stored knowledge row. Resolve
    // transitive original-source dependencies once per unchanged database snapshot.
    const characterProofs=new Map<string,boolean>(), narrativeProofs=new Map<string,boolean>();
    for(const [table,items] of data)for(const row of items){
      if(typeof row.source_proof==='string'){
        if(!characterProofs.has(row.source_proof))characterProofs.set(row.source_proof,characterSourceCurrent(db,row.source_proof));
        row.scene_source_current=characterProofs.get(row.source_proof)!;
      }
      if(table==='character_field_history') {row.scene_field_current=characterFactCurrent(db,row as unknown as CharacterFact);row.scene_field_local_current=characterFactCurrent(db,row as unknown as CharacterFact,String(row.character_id),'local');row.scene_field_from=characterFactFrom(db,row as unknown as CharacterFact);}
      if(table==='narrative_events'||table==='relationships')row.scene_source_current=narrativeSourceCurrent(db,table==='narrative_events'?'event':'relationship',String(row.id),narrativeProofs);
    }
    if(!db.raw.isTransaction)memo.series.set(series[0]!,data);
  }
  const history=data.get('character_field_history')!;
  for(const [table,items] of data){
    const current=items.filter(r=>Number(r.valid_from_para??r.at_para??0)<=at).map(r=>{
      if(table!=='characters')return r;
      const copy={...r};
      // Current-row mirrors of dated fields must not import a later observation.
      for(const field of ['gender','first_person_type','speech_register','voice_notes','plurality'])if(history.some(h=>h.character_id===r.id&&h.field===field)){
        delete copy[field];if(field==='gender'){delete copy.gender_confidence;delete copy.gender_evidence_ids;}
      }
      return copy;
    });
    rows.push([table,stable(current)]);
  }
  const signature=createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  if(!db.raw.isTransaction){
    let signatures=memo.signatures.get(series[0]!);
    if(!signatures){signatures=new Map();memo.signatures.set(series[0]!,signatures);}
    signatures.set(at,signature);
  }
  return signature;
  });
}
