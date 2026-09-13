import { Db, fromJson } from './database';
import { characterSourceCurrent } from './characterSources';
import type { CharacterKnowledgeHistory, KnowledgeEvidenceView } from '@shared/types';

export function characterKnowledgeHistory(db: Db, id: string): CharacterKnowledgeHistory {
  if (!db.get('SELECT 1 FROM characters WHERE id=?', [id])) throw new Error('人物不存在');
  const evidence = (raw: string | null, fallback: string | null): KnowledgeEvidenceView[] => {
    const ids = fromJson<{ids?:string[]}>(raw, {}).ids ?? fromJson<string[]>(fallback, []);
    return [...new Set(ids)].slice(0, 8).map(pid => {
      const p = db.get<{source_text:string;series_ordinal:number}>('SELECT source_text,series_ordinal FROM paragraphs WHERE id=?', [pid]);
      return { id: pid, at: p?.series_ordinal ?? null, currentText: p?.source_text ?? null };
    });
  };
  const sourceStatus = (proof: string | null) => !proof ? 'unverified' as const : characterSourceCurrent(db, proof) ? 'current' as const : 'stale' as const;
  const aliases = db.all<{id:string;alias_jp:string;alias_type:string;valid_from_para:number|null;valid_to_para:number|null}>('SELECT * FROM character_aliases WHERE character_id=? ORDER BY alias_jp,id', [id]).map(alias => {
    const observations = db.all<{source_proof:string;valid_from_para:number}>('SELECT source_proof,valid_from_para FROM character_alias_observations WHERE alias_id=? ORDER BY valid_from_para DESC,created_at DESC', [alias.id]);
    const valid = observations.find(o => characterSourceCurrent(db, o.source_proof));
    const latest = valid ?? observations[0];
    return { id: alias.id, name: alias.alias_jp, sourceStatus: alias.alias_type !== 'pre-read' ? 'manual' as const : sourceStatus(latest?.source_proof ?? null), fromPara: alias.valid_from_para ?? latest?.valid_from_para ?? null, toPara: alias.valid_to_para, evidence: evidence(latest?.source_proof ?? null, null) };
  });
  const rows = db.all<{fact_json:string;archived:number}>(`SELECT fact_json,archived FROM (
    SELECT json_object('field',field,'value_json',value_json,'valid_from_para',valid_from_para,'origin',origin,'evidence_ids',evidence_ids,'source_proof',source_proof,'source_quotes',source_quotes) fact_json,0 archived,created_at stamp FROM character_field_history WHERE character_id=?
    UNION ALL SELECT fact_json,1 archived,archived_at stamp FROM character_field_archive WHERE character_id=?
  ) ORDER BY stamp DESC LIMIT 100`, [id,id]);
  const fields = rows.map((row, index) => {
    const fact = JSON.parse(row.fact_json);
    const value = fromJson<unknown>(fact.value_json, null);
    return { id: String(index), field: String(fact.field), value: typeof value === 'object' && value && 'gender' in value ? String(value.gender ?? '未知') : String(value ?? '未知'), fromPara: Number(fact.valid_from_para), sourceStatus: row.archived ? 'superseded' as const : fact.origin === 'user' ? 'manual' as const : sourceStatus(fact.source_proof), evidence: evidence(fact.source_proof, fact.evidence_ids), quotes: fromJson<{paragraph_id:string;quote:string}[]>(fact.source_quotes, []).map(q => q.quote) };
  });
  const fieldTotal = db.get<{n:number}>('SELECT (SELECT COUNT(*) FROM character_field_history WHERE character_id=?) + (SELECT COUNT(*) FROM character_field_archive WHERE character_id=?) n', [id,id])!.n;
  const origin = db.get<{origin:string}>('SELECT origin FROM character_name_origins WHERE character_id=?', [id]);
  const name = db.get<{canonical_name_jp:string}>('SELECT canonical_name_jp FROM characters WHERE id=?', [id])!.canonical_name_jp;
  const observations = db.all<{id:string;name_jp:string;source_proof:string;valid_from_para:number}>('SELECT * FROM character_name_observations WHERE character_id=? ORDER BY valid_from_para DESC,created_at DESC', [id]);
  const names: NonNullable<CharacterKnowledgeHistory['names']> = origin?.origin === 'user'
    ? [{ id, name, sourceStatus: 'manual', fromPara: null, toPara: null, evidence: [] }]
    : observations.map(o => ({ id:o.id, name:o.name_jp, sourceStatus:o.name_jp === name ? sourceStatus(o.source_proof) : 'superseded', fromPara:o.valid_from_para, toPara:null, evidence:evidence(o.source_proof,null) }));
  if (origin && origin.origin !== 'user' && !names.length) names.push({ id, name, sourceStatus:'unverified', fromPara:null, toPara:null, evidence:[] });
  return { names, aliases, fields, fieldTotal };
}
