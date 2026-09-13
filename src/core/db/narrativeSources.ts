import { identityDependenciesCurrent, currentIdentityDependencies, identityInputCurrent, withIdentityRead, activeProofReadMemo, type IdentityDependency, type IdentityInputReceipt } from './identitySources';
import { createHash } from 'node:crypto';
import { Db, fromJson } from './database';
import { preparationContract } from '../ai/preparationContract';

export type NarrativeKind = 'event' | 'relationship';
interface Dependency { id: string; fingerprint: string }
interface SourceScope { ids: string[]; dependencies: Dependency[]; identities?: IdentityDependency[] }
interface Proof { source_ids: string; source_hash: string; content_hash: string; contract: string; superseded: number }
const scopeOf = (raw: string): SourceScope => {
  const value = fromJson<string[] | SourceScope>(raw, []);
  if (Array.isArray(value)) return { ids: value.filter(id => typeof id === 'string'), dependencies: [] };
  if (!value || !Array.isArray(value.ids) || !value.ids.every(id => typeof id === 'string') || !Array.isArray(value.dependencies) || !value.dependencies.every(d => d && typeof d.id === 'string' && typeof d.fingerprint === 'string')) return { ids: [], dependencies: [] };
  return value;
};
const readProof = (db: Db, kind: NarrativeKind, id: string) => db.get<Proof>('SELECT source_ids,source_hash,content_hash,contract,superseded FROM narrative_provenance WHERE kind=? AND record_id=?', [kind, id]);
const proofFingerprint = (db: Db, id: string) => hash(readProof(db, 'event', id));
export const eventSourceFingerprint = proofFingerprint;
export function narrativeSourceStatus(db: Db, kind: NarrativeKind, id: string): 'current' | 'stale' | 'superseded' | 'unverified' {
  const proof = db.get<{ superseded: number }>('SELECT superseded FROM narrative_provenance WHERE kind=? AND record_id=?', [kind, id]);
  return !proof ? 'unverified' : proof.superseded ? 'superseded' : narrativeSourceCurrent(db, kind, id) ? 'current' : 'stale';
}
const table = (kind: NarrativeKind) => kind === 'event' ? 'narrative_events' : 'relationships';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sources(db: Db, ids: string[]) {
  return [...new Set(ids)].sort().map(id => db.get(`SELECT p.id,p.source_text,p.series_ordinal,p.paragraph_type,p.scene_id,s.chapter_id,c.volume_id,v.series_id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id JOIN volumes v ON v.id=c.volume_id WHERE p.id=?`, [id]) ?? null);
}
function content(db: Db, kind: NarrativeKind, id: string) {
  const row = db.get(`SELECT * FROM ${table(kind)} WHERE id=?`, [id]);
  if (!row) return null;
  // Chinese summaries are display-only derivatives; changing them cannot recertify JP facts.
  const { summary_zh, description_zh, localized_at, created_at, ...facts } = row;
  return facts;
}

export function bindNarrativeSources(db: Db, kind: NarrativeKind, id: string, ids: string[], dependencyIds: string[] = []): void {
  const row = content(db, kind, id), snapshot = sources(db, ids);
  if (!row || !ids.length || snapshot.some(p => !p || p.series_id !== row.series_id)) return;
  const narrativeMemo = new Map<string, boolean>();
  const dependencies = withIdentityRead(db, () => [...new Set(dependencyIds)].map(dependencyId => {
    const event = content(db, 'event', dependencyId);
    if (!event || event.series_id !== row.series_id || Number(event.at_para) >= Math.min(...snapshot.map(p => Number(p!.series_ordinal))) || !narrativeSourceCurrent(db, 'event', dependencyId, narrativeMemo)) throw new Error('预读背景依据已变化，不能保存旧结果');
    return { id: dependencyId, fingerprint: proofFingerprint(db, dependencyId) };
  }));
  db.run('INSERT OR REPLACE INTO narrative_provenance(kind,record_id,series_id,source_ids,source_hash,content_hash,contract,superseded) VALUES(?,?,?,?,?,?,?,0)',
    [kind, id, String(row.series_id), JSON.stringify({ ids: [...new Set(ids)].sort(), dependencies, identities: currentIdentityDependencies(db, String(row.series_id), Math.min(...snapshot.map(p => Number(p!.series_ordinal)))) }), hash(snapshot), hash(row), preparationContract('preread')]);
}

export function narrativeSourceCurrent(db: Db, kind: NarrativeKind, id: string, memo = new Map<string, boolean>()): boolean {
  memo = activeProofReadMemo(db) ?? memo;
  // Iterative DFS avoids call-stack growth across long books. Cache lasts only for this read.
  const tasks: { kind: NarrativeKind; id: string; finish?: Dependency[] }[] = [{ kind, id }];
  const key = (k: NarrativeKind, i: string) => `${k}:${i}`;
  while (tasks.length) {
    const task = tasks.pop()!, k = key(task.kind, task.id);
    if (task.finish) { memo.set(k, task.finish.every(d => memo.get(key('event', d.id)) === true)); continue; }
    if (memo.has(k)) continue;
    memo.set(k, false); // also rejects corrupted cycles
    const proof = readProof(db, task.kind, task.id);
    if (!proof || proof.superseded || proof.contract !== preparationContract('preread')) continue;
    const scope = scopeOf(proof.source_ids);
    const snapshot = sources(db, scope.ids), facts = content(db, task.kind, task.id);
    if (!scope.ids.length || snapshot.some(row => !row) || !facts || proof.source_hash !== hash(snapshot) || proof.content_hash !== hash(facts)) continue;
    if (!identityDependenciesCurrent(db, scope.identities, { seriesId: String(facts.series_id), before: Math.min(...snapshot.map(row => Number(row!.series_ordinal))) }) || scope.dependencies.some(d => d.fingerprint !== proofFingerprint(db, d.id))) continue;
    tasks.push({ ...task, finish: scope.dependencies });
    for (const d of scope.dependencies) if (!memo.has(key('event', d.id))) tasks.push({ kind: 'event', id: d.id });
  }
  return memo.get(key(kind, id)) === true;
}

export interface NarrativeEvent { id: string; summary_jp: string; summary_zh: string | null; at_para: number; reveals_to_reader: number; character_ids: string | null }
export function previousNarrativeEvents(db: Db, seriesId: string, atPara: number, limit: number, characterIds?: string[], pastScopeOnly = false): NarrativeEvent[] {
  return withIdentityRead(db, () => collectPreviousEvents(db, seriesId, atPara, limit, characterIds, pastScopeOnly, new Map()));
}

/** An explicit accepted end changes the interval, not the earlier observed relationship.
 * Never recertify a stale/legacy relationship by editing its end. Caller owns the transaction. */
export function endObservedRelationship(db: Db, id: string, until: number | null): { changes: number } {
  const current = narrativeSourceCurrent(db, 'relationship', id);
  const result = db.run('UPDATE relationships SET valid_to_para=? WHERE id=?', [until, id]);
  if (current && result.changes === 1) db.run("UPDATE narrative_provenance SET content_hash=? WHERE kind='relationship' AND record_id=?", [hash(content(db, 'relationship', id)), id]);
  return result;
}
function collectPreviousEvents(db: Db, seriesId: string, atPara: number, limit: number, characterIds: string[] | undefined, pastScopeOnly: boolean, memo: Map<string, boolean>): NarrativeEvent[] {
  const found: NarrativeEvent[] = [];
  for (let offset = 0; found.length < limit; offset += 64) {
    const rows = db.all<NarrativeEvent>(`SELECT e.id,e.summary_jp,e.summary_zh,e.at_para,e.reveals_to_reader,e.character_ids FROM narrative_events e JOIN narrative_provenance p ON p.kind='event' AND p.record_id=e.id AND p.superseded=0 WHERE e.series_id=? AND e.at_para<? ORDER BY e.at_para DESC,e.created_at DESC,e.rowid DESC LIMIT 64 OFFSET ?`, [seriesId, atPara, offset]);
    for (const r of rows) {
      const ids = fromJson<string[]>(r.character_ids, []);
      if (characterIds?.length && ids.length && !ids.some(i => characterIds.includes(i))) continue;
      if (!narrativeSourceCurrent(db, 'event', r.id, memo)) continue;
      // A prior output from a larger old batch must not become its own rerun's background.
      if (pastScopeOnly && sources(db, scopeOf(readProof(db, 'event', r.id)!.source_ids).ids).some(p => !p || Number(p.series_ordinal) >= atPara)) continue;
      found.push(r);
      if (found.length >= limit) break;
    }
    if (rows.length < 64) break;
  }
  return found.reverse();
}
export function preReadBackground(db: Db, seriesId: string, before: number) {
  return withIdentityRead(db, () => readBackground(db, seriesId, before, new Map()));
}
function readBackground(db: Db, seriesId: string, before: number, memo: Map<string, boolean>) {
  const events = collectPreviousEvents(db, seriesId, before, 6, undefined, true, memo);
  return { events, signature: hash(events.map(e => [e.id, e.at_para, e.summary_jp, proofFingerprint(db, e.id)])) };
}
export interface PreReadInputReceipt { before: number; background: string; identity?: IdentityInputReceipt }
export function preReadInputsCurrent(db: Db, chapterId: string): boolean {
  const row = db.get<{value:string}>('SELECT value FROM meta WHERE key=?', [`prep:preread-progress:${chapterId}`]);
  if (!row) return true; // Empty chapters and direct explicit completion have no batch receipts.
  const entries = fromJson<Record<string, { input?: PreReadInputReceipt }>>(row.value, {});
  const series = db.get<{series_id:string}>('SELECT v.series_id FROM chapters c JOIN volumes v ON v.id=c.volume_id WHERE c.id=?', [chapterId]);
  if (!series) return false;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return false;
  // A synchronous read only: no cached proof survives a write or the next status request.
  const backgrounds = new Map<number, string>(), memo = new Map<string, boolean>(), identityInputs = new Map<string, boolean>();
  return withIdentityRead(db, () => {
   for (const entry of Object.values(entries)) {
    const input = entry?.input;
    if (!input || !Number.isFinite(input.before) || typeof input.background !== 'string') return false;
    const identityKey = JSON.stringify([input.before, input.identity]);
    if (!identityInputs.has(identityKey)) identityInputs.set(identityKey, identityInputCurrent(db, series.series_id, input.before, input.identity));
    if (!identityInputs.get(identityKey)) return false;
    let signature = backgrounds.get(input.before);
    if (signature === undefined) {
      signature = readBackground(db, series.series_id, input.before, memo).signature;
      backgrounds.set(input.before, signature);
    }
    // Check every receipt, including conflicting receipts sharing the same boundary.
    if (signature !== input.background) return false;
   }
   return true;
  });
}

/** Called inside the successful replacement batch's transaction, before its new records.
 * A changed row is preserved for inspection; no historical content is overwritten. */
export function supersedeNarrativeBatch(db: Db, seriesId: string, paragraphIds: string[]): void {
  const scope = new Set(paragraphIds);
  for (const row of db.all<{ kind: NarrativeKind; record_id: string; source_ids: string }>('SELECT kind,record_id,source_ids FROM narrative_provenance WHERE series_id=? AND superseded=0', [seriesId])) {
    const ids = scopeOf(row.source_ids).ids;
    if (ids.length && ids.some(id => scope.has(id))) db.run('UPDATE narrative_provenance SET superseded=1 WHERE kind=? AND record_id=?', [row.kind, row.record_id]);
  }
}
