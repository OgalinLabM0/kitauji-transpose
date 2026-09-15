import { Db, fromJson, nowIso } from './database';
import type { CharacterRow } from './knowledgeRepo';
import type { CharacterFieldDecisionView, QuirkProfile } from '@shared/types';
import { characterSourceProof, characterSourceCurrent } from './characterSources';
import { withIdentityRead } from './identitySources';
import { initialFactAllowed, initialFactFrom } from './initialFieldTrust';

export const CHARACTER_FIELDS = ['gender', 'first_person_type', 'speech_register', 'voice_notes', 'plurality'] as const;
export type CharacterField = typeof CHARACTER_FIELDS[number];
export interface CharacterFact { character_id?: string; field: CharacterField; value_json: string; valid_from_para: number; origin: 'model' | 'user'; evidence_ids: string; source_proof?: string | null }
export const characterFactCurrent = (db: Db, fact: CharacterFact, id = fact.character_id, scope:'global'|'local'='global') => fact.origin === 'user' || (characterSourceCurrent(db, fact.source_proof) && initialFactAllowed(db,fact,id,scope));
export const characterFactFrom = initialFactFrom;

interface StoredFact extends CharacterFact { created_at: string; source_quotes: string | null }
interface FieldEdit { id: number; character_id: string; field: CharacterField; valid_from_para: number; previous_fact_json: string | null; applied_fact_json: string; baseline_json: string; created_at: string; undone_at: string | null; invalidated: number }
const factAt = (db: Db, id: string, field: CharacterField, at: number, origin: 'model' | 'user') => {
  const row = db.get<StoredFact>('SELECT field,value_json,valid_from_para,origin,evidence_ids,created_at,source_quotes,source_proof FROM character_field_history WHERE character_id=? AND field=? AND valid_from_para=? AND origin=?', [id,field,at,origin]);
  // Preserve the serialized shape of pre-v9 manual undo receipts.
  if (row && origin === 'user') delete row.source_proof;
  return row;
};
const fieldValue = (row: CharacterRow, field: CharacterField): unknown => field === 'gender' ? { gender: row.gender, confidence: row.gender_confidence, evidenceIds: fromJson<string[]>(row.gender_evidence_ids, []) } : row[field];
const meaning = (field: CharacterField, json: string): unknown => { const value = JSON.parse(json); return field === 'gender' ? value.gender : value; };

export function saveCharacterFact(db: Db, id: string, field: CharacterField, value: unknown, at: number, origin: 'model' | 'user', evidence: string[], baseline?: CharacterRow, quotes: { paragraph_id: string; quote: string }[] = [], sourceIds = evidence, eventIds: string[] = []): void {
  if (!Number.isSafeInteger(at) || at < 0 || !CHARACTER_FIELDS.includes(field)) throw new Error('人物字段生效位置不正确');
  const previous = factAt(db,id,field,at,origin);
  const valueJson = JSON.stringify(value);
  if (origin === 'model') {
    if (evidence.some(id => !sourceIds.includes(id))) throw new Error('人物观察来源范围未覆盖字段证据');
    if (db.get("SELECT 1 FROM character_field_history WHERE character_id=? AND field=? AND origin='user' AND valid_from_para<=?", [id,field,at])) return;
    if (previous && characterFactCurrent(db, previous,id) && meaning(field,previous.value_json) !== meaning(field,valueJson)) throw new Error(`人物字段 ${field} 在第 ${at} 段存在冲突候选：原记录「${String(meaning(field,previous.value_json)).slice(0, 100)}」，新候选「${String(meaning(field,valueJson)).slice(0, 100)}」。原记录已保留，请核对后决定`);
  }
  if (origin === 'user' && !baseline) throw new Error('字段决定缺少撤销基线');
  const original = baseline ?? db.get<CharacterRow>('SELECT * FROM characters WHERE id=?', [id]);
  if (!original) throw new Error('人物不存在');
  db.run('INSERT OR IGNORE INTO character_field_baselines(character_id,field,value_json) VALUES(?,?,?)', [id,field,JSON.stringify(fieldValue(original,field))]);
  const createdAt = nowIso();
  const proof = origin === 'model' ? characterSourceProof(db, id, sourceIds, eventIds) : null;
  if (previous && origin === 'model' && !characterFactCurrent(db, previous,id)) db.run('INSERT INTO character_field_archive(character_id,fact_json,archived_at) VALUES(?,?,?)', [id, JSON.stringify(previous), createdAt]);
  db.run(`INSERT INTO character_field_history(character_id,field,value_json,valid_from_para,origin,evidence_ids,created_at,source_quotes,source_proof)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(character_id,field,valid_from_para,origin) DO UPDATE SET value_json=excluded.value_json,evidence_ids=excluded.evidence_ids,created_at=excluded.created_at,source_quotes=excluded.source_quotes,source_proof=excluded.source_proof`,
  [id, field, valueJson, at, origin, JSON.stringify(evidence), createdAt, JSON.stringify(quotes), proof]);
  if (origin === 'user') db.run('INSERT INTO character_field_edits(character_id,field,valid_from_para,previous_fact_json,applied_fact_json,baseline_json,created_at) VALUES(?,?,?,?,?,?,?)',
    [id,field,at,previous ? JSON.stringify(previous) : null,JSON.stringify(factAt(db,id,field,at,'user')),JSON.stringify(fieldValue(baseline!,field)),createdAt]);
}

function canUndo(db: Db, edit: FieldEdit): boolean {
  if (edit.undone_at || edit.invalidated) return false;
  const latest = db.get<{id: number}>('SELECT id FROM character_field_edits WHERE character_id=? AND field=? AND valid_from_para=? AND undone_at IS NULL ORDER BY id DESC LIMIT 1', [edit.character_id,edit.field,edit.valid_from_para]);
  return latest?.id === edit.id && JSON.stringify(factAt(db,edit.character_id,edit.field,edit.valid_from_para,'user')) === edit.applied_fact_json;
}

export function fieldDecisions(db: Db, id: string): CharacterFieldDecisionView[] {
  return db.all<FieldEdit>('SELECT * FROM character_field_edits WHERE character_id=? ORDER BY id DESC LIMIT 50', [id]).map(edit => ({
    id: edit.id, field: edit.field, fromPara: edit.valid_from_para, createdAt: edit.created_at, canUndo: canUndo(db,edit), undone: !!edit.undone_at,
    previous: edit.previous_fact_json ? JSON.parse(JSON.parse(edit.previous_fact_json).value_json) : JSON.parse(edit.baseline_json),
    value: JSON.parse(JSON.parse(edit.applied_fact_json).value_json),
  }));
}

/** The caller refreshes the profile summary in the same transaction. */
export function undoFieldDecision(db: Db, id: string, editId: number): void {
  const edit = db.get<FieldEdit>('SELECT * FROM character_field_edits WHERE id=? AND character_id=?', [editId,id]);
  if (!edit || !CHARACTER_FIELDS.includes(edit.field) || !canUndo(db,edit)) throw new Error('该字段已被后续决定或合并改变，不能撤销旧版本；请刷新记录');
  db.run("DELETE FROM character_field_history WHERE character_id=? AND field=? AND valid_from_para=? AND origin='user'", [id,edit.field,edit.valid_from_para]);
  if (edit.previous_fact_json) {
    const old = JSON.parse(edit.previous_fact_json) as StoredFact;
    db.run('INSERT INTO character_field_history(character_id,field,value_json,valid_from_para,origin,evidence_ids,created_at,source_quotes) VALUES(?,?,?,?,?,?,?,?)', [id,old.field,old.value_json,old.valid_from_para,old.origin,old.evidence_ids,old.created_at,old.source_quotes ?? null]);
  }
  const original = db.get<{value_json: string}>('SELECT value_json FROM character_field_baselines WHERE character_id=? AND field=?', [id,edit.field]);
  const baseline = JSON.parse(original?.value_json ?? edit.baseline_json);
  // Avoid falling back to the very value being undone when this was the first dated record.
  if (edit.field === 'gender') db.run('UPDATE characters SET gender=?,gender_confidence=?,gender_evidence_ids=? WHERE id=?', [baseline.gender,baseline.confidence,JSON.stringify(baseline.evidenceIds),id]);
  else db.run(`UPDATE characters SET ${edit.field}=? WHERE id=?`, [baseline,id]);
  db.run('UPDATE character_field_edits SET undone_at=? WHERE id=?', [nowIso(),edit.id]);
}

/** A later observation cannot become the fallback for an earlier paragraph. User decisions lock only their field. */
export function characterAt(db: Db, row: CharacterRow, at: number): CharacterRow {
  return withIdentityRead(db, () => {
  const result = { ...row };
  const history = db.all<CharacterFact>('SELECT * FROM character_field_history WHERE character_id=? ORDER BY valid_from_para DESC', [row.id]);
  for (const field of CHARACTER_FIELDS) {
    const all = history.filter(h => h.field === field);
    // A raw profile mirror without field-level provenance is not an established fact.
    // Preserve it in storage, but expose unknown until source review or an explicit user field decision.
    const applicable = all.filter(h => characterFactFrom(db,h) <= at && characterFactCurrent(db, h)).sort((a,b)=>characterFactFrom(db,b)-characterFactFrom(db,a));
    const selected = applicable.find(h => h.origin === 'user') ?? applicable.find(h => h.origin === 'model');
    if (field === 'gender') {
      const value = selected ? fromJson<{ gender: string | null; confidence: number | null; evidenceIds: string[] }>(selected.value_json, { gender: null, confidence: 0, evidenceIds: [] }) : { gender: null, confidence: 0, evidenceIds: [] };
      result.gender = value.gender; result.gender_confidence = value.confidence; result.gender_evidence_ids = JSON.stringify(value.evidenceIds);
    } else result[field] = selected ? fromJson<string | null>(selected.value_json, null) : null;
  }
  result.quirk_profiles = JSON.stringify(fromJson<QuirkProfile[]>(row.quirk_profiles, []).filter(q => q.locked_at_para <= at));
  return result;
  });
}
