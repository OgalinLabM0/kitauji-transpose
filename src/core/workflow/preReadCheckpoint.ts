import { identityInputCurrent, preReadIdentityInput, withIdentityRead } from '../db/identitySources';
import { preReadBackground, type PreReadInputReceipt } from '../db/narrativeSources';
import { createHash } from 'node:crypto';
import type { ProjectStore } from '@core/db';
import type { PreReadParagraph } from '@core/ai/protocol';
import { preparationContract } from '@core/ai/preparationContract';

const key = (chapterId: string) => `prep:preread-progress:${chapterId}`;
const signature = (p: PreReadParagraph, chapterSource: string) => createHash('sha256').update(JSON.stringify([preparationContract('preread'), chapterSource, p.id, p.seriesOrdinal, p.sourceText])).digest('hex');

/** Used only to resume an incomplete chapter. Explicit reruns of complete chapters start fresh. */
export class PreReadCheckpoint {
  private entries: Record<string, { signature: string; input: PreReadInputReceipt }> = {};
  private chapterSource: string;
  constructor(private store: ProjectStore, private chapterId: string, restart: boolean) {
    this.chapterSource = store.projects.chapterSourceSignature(chapterId);
    if (restart) store.db.run('DELETE FROM meta WHERE key=?', [key(chapterId)]);
    else {
      const row = store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [key(chapterId)]);
      try {
        const parsed: unknown = JSON.parse(row?.value ?? '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.entries = parsed as Record<string, { signature: string; input: PreReadInputReceipt }>;
      } catch { /* Corrupt progress cannot certify any paragraph. */ }
    }
  }
  done(p: PreReadParagraph): boolean {
    return this.doneMany([p])[0] ?? false;
  }
  doneMany(paragraphs: readonly PreReadParagraph[]): boolean[] {
    const backgrounds = new Map<number, string>();
    const identities = new Map<string, boolean>();
    return withIdentityRead(this.store.db, () => paragraphs.map(p => {
      const entry = this.entries[p.id];
      if (!entry?.input) return false;
      const seriesId = this.store.projects.getSeriesIdOfParagraph(p.id);
      const identityKey = `${seriesId}\u0000${entry.input.before}\u0000${JSON.stringify(entry.input.identity)}`;
      let identityCurrent = identities.get(identityKey);
      if (identityCurrent === undefined) {
        identityCurrent = identityInputCurrent(this.store.db, seriesId, entry.input.before, entry.input.identity);
        identities.set(identityKey, identityCurrent);
      }
      if (!identityCurrent) return false;
      let background = backgrounds.get(entry.input.before);
      if (background === undefined) {
        background = preReadBackground(this.store.db, seriesId, entry.input.before).signature;
        backgrounds.set(entry.input.before, background);
      }
      return entry.signature === signature(p, this.chapterSource) && entry.input.background === background;
    }));
  }
  /** Call inside the same transaction as knowledge writes. */
  save(paragraphs: readonly PreReadParagraph[], input?: PreReadInputReceipt): void {
    if (!paragraphs.length) return;
    const before = Math.min(...paragraphs.map(p => p.seriesOrdinal));
    const receipt: PreReadInputReceipt = { ...(input ?? { before, background: preReadBackground(this.store.db, this.store.projects.getSeriesIdOfParagraph(paragraphs[0]!.id), before).signature }),
      identity: input?.identity ?? preReadIdentityInput(this.store.db, this.store.projects.getSeriesIdOfParagraph(paragraphs[0]!.id), before, paragraphs.map(p => p.id)) };
    const liveIds = new Set(this.store.projects.listParagraphIdsByChapter(this.chapterId));
    for (const id of Object.keys(this.entries)) if (!liveIds.has(id)) delete this.entries[id];
    for (const p of paragraphs) this.entries[p.id] = { signature: signature(p, this.chapterSource), input: receipt };
    this.store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [key(this.chapterId), JSON.stringify(this.entries)]);
  }
}
