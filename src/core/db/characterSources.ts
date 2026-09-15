import { hasVerifiedNameMentionDb } from '../workflow/nameMentionReceipts';
import { identityDependenciesCurrent, readIdentityProof, currentIdentityDependencies, withIdentityRead } from './identitySources';
import type { IdentityDependency } from './identitySources';
import { createHash } from 'node:crypto';
import { Db, fromJson } from './database';
import { preparationContract, preparationContractAccepted } from '../ai/preparationContract';
import { eventSourceFingerprint, narrativeSourceCurrent } from './narrativeSources';

interface Proof { nameReview?:{name:string;paragraphId:string;id:string}; ids: string[]; signature: string; contract: string; events: { id: string; fingerprint: string }[]; identities: IdentityDependency[] }
function snapshot(db: Db, ids: string[]) {
  return ids.map(id => db.get(`SELECT p.id,p.source_text,p.series_ordinal,p.paragraph_type,p.scene_id,s.chapter_id,c.volume_id,v.series_id FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id JOIN volumes v ON v.id=c.volume_id WHERE p.id=?`, [id]) ?? null);
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function characterSourceProof(db: Db, characterId: string, ids: string[], eventIds: string[] = []): string {
  const series = db.get<{series_id: string}>('SELECT series_id FROM characters WHERE id=?', [characterId]);
  return originalSourceProof(db, series?.series_id ?? '', ids, eventIds);
}
export function originalSourceProof(db: Db, seriesId: string, ids: string[], eventIds: string[] = []): string {
  ids = [...new Set(ids)].sort();
  const rows = snapshot(db, ids);
  if (!seriesId || !ids.length || rows.some(row => !row || row.series_id !== seriesId)) throw new Error('观察缺少当前作品的有效原文依据');
  const before = Math.min(...rows.map(row => Number(row!.series_ordinal)));
  const eventMemo = new Map<string, boolean>();
  const events = withIdentityRead(db, () => [...new Set(eventIds)].map(id => {
    const event = db.get<{ series_id: string; at_para: number }>('SELECT series_id,at_para FROM narrative_events WHERE id=?', [id]);
    if (!event || event.series_id !== seriesId || event.at_para >= before || !narrativeSourceCurrent(db, 'event', id, eventMemo)) throw new Error('人物观察的预读背景依据已变化或不属于前文');
    return { id, fingerprint: eventSourceFingerprint(db, id) };
  }));
  return JSON.stringify({ ids, signature: hash(rows), contract: preparationContract('preread'), events, identities: currentIdentityDependencies(db, seriesId, before) } satisfies Proof);
}
export function characterSourceCurrent(db: Db, raw: string | null | undefined): boolean {
  const proof = fromJson<Proof | null>(raw, null);
  if (!proof || !Array.isArray(proof.ids) || !proof.ids.length || !proof.ids.every(id => typeof id === 'string') || !preparationContractAccepted('preread', proof.contract)) return false;
  if(proof.nameReview&&!hasVerifiedNameMentionDb(db,proof.nameReview.paragraphId,proof.nameReview.name,proof.nameReview.id))return false;
  if (!Array.isArray(proof.events) || !proof.events.every(e => e && typeof e.id === 'string' && typeof e.fingerprint === 'string')) return false;
  const memo = new Map<string, boolean>();
  return readIdentityProof(db, `character:${raw}`, () => {
    const rows = snapshot(db, proof.ids);
    if (rows.some(row => !row)) return false;
    const scope = { seriesId: String(rows[0]!.series_id), before: Math.min(...rows.map(row => Number(row!.series_ordinal))) };
    return proof.signature === hash(rows) && identityDependenciesCurrent(db, proof.identities, scope) && proof.events.every(e => e.fingerprint === eventSourceFingerprint(db, e.id) && narrativeSourceCurrent(db, 'event', e.id, memo));
  });
}
