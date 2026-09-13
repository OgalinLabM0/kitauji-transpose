import { createHash } from 'node:crypto';
import { Db } from './database';
import { characterSourceCurrent } from './characterSources';
import { visibleNameSource } from '../validation/nameEvidence';
import { eventSourceFingerprint, narrativeSourceCurrent } from './narrativeSources';

/** The actual canonical-name -> character mapping supplied in known_names.
 * Model identities point to one immutable, earlier observation, never a later replacement. */
export interface IdentityDependency {
  characterId: string;
  name: string;
  seriesId: string;
  before: number;
  origin: string;
  observationId: string | null;
  fingerprint: string;
}
interface NameRow { id: string; series_id: string; canonical_name_jp: string; origin: string }
interface Observation { id: string; source_proof: string; valid_from_para: number }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const namesBefore = (db: Db, seriesId: string, before: number) => db.all<NameRow>(`SELECT c.id,c.series_id,c.canonical_name_jp,COALESCE(o.origin,'user') AS origin
  FROM characters c LEFT JOIN character_name_origins o ON o.character_id=c.id
  WHERE c.series_id=? AND (c.is_active=1 OR COALESCE(c.deactivated_at_para,9223372036854775807)>?)
  ORDER BY c.canonical_name_jp,c.id`, [seriesId, before - 1]);

export interface BackgroundIdentityEvent { id: string; atPara: number; fingerprint: string }

export function knownNameIdentities(db: Db, seriesId: string, before: number, text: string, backgroundText = ''): IdentityDependency[] {
  return withIdentityRead(db, () => {
  const dependencies: IdentityDependency[] = [];
  // Match against what the model can see: balanced wrap/ruby markers are
  // layout boundaries only.  Keep the raw source/proof unchanged so the
  // identity receipt still invalidates when the underlying paragraph changes.
  const visibleText = `${visibleNameSource(text)}\n${visibleNameSource(backgroundText)}`;
  for (const row of namesBefore(db, seriesId, before)) {
    if (!visibleText.includes(row.canonical_name_jp)) continue;
    const observation = row.origin === 'user' ? undefined : db.all<Observation>(`SELECT id,source_proof,valid_from_para FROM character_name_observations
      WHERE character_id=? AND name_jp=? AND valid_from_para<? ORDER BY valid_from_para,rowid`, [row.id, row.canonical_name_jp, before])
      .find(o => characterSourceCurrent(db, o.source_proof));
    if (row.origin !== 'user' && !observation) continue;
    dependencies.push({ characterId: row.id, name: row.canonical_name_jp, seriesId, before, origin: row.origin,
      observationId: observation?.id ?? null, fingerprint: hash(observation ?? null) });
  }
  return dependencies;
  });
}

export function identityDependenciesCurrent(db: Db, value: unknown, scope?: { seriesId: string; before: number }): value is IdentityDependency[] {
  if (!Array.isArray(value)) return false;
  return value.every((d: IdentityDependency) => {
    if (!d || typeof d.characterId !== 'string' || typeof d.name !== 'string' || typeof d.seriesId !== 'string' || !Number.isSafeInteger(d.before) || typeof d.origin !== 'string' || typeof d.fingerprint !== 'string') return false;
    if (scope && (d.seriesId !== scope.seriesId || d.before > scope.before)) return false;
    const row = namesBefore(db, d.seriesId, d.before).find(r => r.id === d.characterId);
    if (!row || row.canonical_name_jp !== d.name || row.origin !== d.origin) return false;
    if (d.origin === 'user') return d.observationId === null && d.fingerprint === hash(null);
    if (typeof d.observationId !== 'string') return false;
    const observation = db.get<Observation>(`SELECT id,source_proof,valid_from_para FROM character_name_observations
      WHERE id=? AND character_id=? AND name_jp=? AND valid_from_para<?`, [d.observationId, d.characterId, d.name, d.before]);
    return !!observation && hash(observation) === d.fingerprint && characterSourceCurrent(db, observation.source_proof);
  });
}

export interface IdentityInputReceipt { sourceIds: string[]; signature: string; backgroundEvents?: BackgroundIdentityEvent[] }
function validBackgroundEvents(db: Db, seriesId: string, before: number, events: unknown): events is BackgroundIdentityEvent[] {
  if (events === undefined) return true;
  if (!Array.isArray(events)) return false;
  const memo = new Map<string, boolean>();
  return events.every(e => {
    if (!e || typeof e.id !== 'string' || !Number.isSafeInteger(e.atPara) || typeof e.fingerprint !== 'string' || e.atPara >= before) return false;
    const row = db.get<{ series_id: string; at_para: number }>('SELECT series_id,at_para FROM narrative_events WHERE id=?', [e.id]);
    return !!row && row.series_id === seriesId && row.at_para === e.atPara && e.fingerprint === eventSourceFingerprint(db, e.id) && narrativeSourceCurrent(db, 'event', e.id, memo);
  });
}
export function preReadIdentityInput(db: Db, seriesId: string, before: number, sourceIds: string[], backgroundEvents?: readonly BackgroundIdentityEvent[]): IdentityInputReceipt {
  return withIdentityRead(db, () => {
    const ids = [...new Set(sourceIds)].sort();
    const rows = ids.map(id => db.get<{ source_text: string; series_ordinal: number; series_id: string }>(`SELECT p.source_text,p.series_ordinal,v.series_id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id JOIN volumes v ON v.id=c.volume_id WHERE p.id=?`, [id]));
    if (!ids.length || rows.some(r => !r || r.series_id !== seriesId || r.series_ordinal < before)) throw new Error('预读姓名依据的原文范围已变化');
    if (!validBackgroundEvents(db, seriesId, before, backgroundEvents)) throw new Error('预读姓名背景依据已变化或不属于前文');
    const backgroundText = (backgroundEvents ?? []).map(e => db.get<{summary_jp:string}>('SELECT summary_jp FROM narrative_events WHERE id=?', [e.id])?.summary_jp ?? '').join('\n');
    const identity = knownNameIdentities(db, seriesId, before, rows.map(r => r!.source_text).join('\n'), backgroundText);
    return { sourceIds: ids, signature: hash(identity), ...(backgroundEvents?.length ? { backgroundEvents: backgroundEvents.map(e => ({ ...e })) } : {}) };
  });
}
export function identityInputCurrent(db: Db, seriesId: string, before: number, input: IdentityInputReceipt | undefined): boolean {
  if (!input || !Array.isArray(input.sourceIds) || !input.sourceIds.every(id => typeof id === 'string') || typeof input.signature !== 'string') return false;
  try { return preReadIdentityInput(db, seriesId, before, input.sourceIds, input.backgroundEvents).signature === input.signature; }
  catch { return false; }
}

// Bound only around the synchronous preread commit. This makes every existing proof
// writer (fields, names, aliases, conflicts, changes and narrative facts) share the
// captured model input without threading optional arguments through unrelated APIs.
const writing = new WeakMap<Db, IdentityDependency[]>();
export function withIdentityDependencies(db: Db, dependencies: IdentityDependency[], commit: () => void): void {
  if (!identityDependenciesCurrent(db, dependencies)) throw new Error('预读姓名依据已变化，旧观察未保存');
  const previous = writing.get(db);
  writing.set(db, dependencies);
  try { commit(); }
  finally { if (previous) writing.set(db, previous); else writing.delete(db); }
}
export function currentIdentityDependencies(db: Db, seriesId: string, before: number): IdentityDependency[] {
  const dependencies = writing.get(db) ?? [];
  if (dependencies.some(d => d.seriesId !== seriesId || d.before > before)) throw new Error('身份依赖不属于当前作品的前文');
  return dependencies;
}

// Per synchronous read only. A corrupt identity/event cycle fails closed; no cache survives writes.
const reads = new WeakMap<Db, Map<string, boolean>>();
type ReadScopeState = { stamp: string; dirty: boolean };
const readScopeStates = new WeakMap<Map<string, boolean>, ReadScopeState>();
// total_changes catches this connection; data_version catches other connections.
const readScopeStamp = (db: Db): string => JSON.stringify(db.get('SELECT total_changes() AS n, data_version FROM pragma_data_version'));
/** Shared only by synchronous proof readers; keys are prefixed by proof kind. */
export function activeProofReadMemo(db: Db): Map<string, boolean> | undefined {
  return reads.get(db);
}
/**
 * A proof memo is valid only while its enclosing synchronous reader stayed
 * read-only. Callers that may reuse a complete result must check this before
 * using it: a source, knowledge, or external-connection write clears every
 * transitive proof in the active scope and marks that scope non-cacheable.
 */
export function identityReadScopeIsPristine(db: Db): boolean {
  const memo = reads.get(db);
  if (!memo) return false;
  const state = readScopeStates.get(memo);
  const stamp = readScopeStamp(db);
  if (!state || state.stamp !== stamp) {
    memo.clear();
    readScopeStates.set(memo, { stamp, dirty: true });
    return false;
  }
  return !state.dirty;
}
/** Run one synchronous dependency read with a shared proof memo. The scope is
 * always released on return, so writes and later reads cannot reuse it. */
export function withIdentityRead<T>(db: Db, read: () => T): T {
  if (reads.has(db)) return read();
  const memo = new Map<string, boolean>();
  const state: ReadScopeState = { stamp: readScopeStamp(db), dirty: false };
  reads.set(db, memo);
  readScopeStates.set(memo, state);
  try { return read(); }
  finally { reads.delete(db); readScopeStates.delete(memo); }
}
export function readIdentityProof(db: Db, key: string, evaluate: () => boolean): boolean {
  const outer = reads.get(db), memo = outer ?? new Map<string, boolean>();
  if (memo.has(key)) return memo.get(key)!;
  if (!outer) reads.set(db, memo);
  memo.set(key, false);
  try { const current = evaluate(); memo.set(key, current); return current; }
  finally { if (!outer) reads.delete(db); }
}
