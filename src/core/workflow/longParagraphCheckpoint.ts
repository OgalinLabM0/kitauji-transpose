import { createHash, randomUUID } from 'node:crypto';
import type { ProjectStore } from '@core/db';
import { translationItemSchema, type TranslationItem } from '@core/ai/protocol';
import { auditInput } from './auditReceipts';

const PREFIX = 'long-paragraph-draft:';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface Part { item: TranslationItem; aiCallId: string; checksum: string }
interface Checkpoint { version: 1; fingerprint: string; owner: string; parts: Part[] }
export interface LongParagraphCheckpointInput {
  paragraphId: string; parts: readonly string[]; context: string; diagnostic: string; rulesFingerprint: string;
}

/** No quality receipt or final is written here: these are unverified generation results only. */
export function openLongParagraphCheckpoint(store: ProjectStore, input: LongParagraphCheckpointInput) {
  const key = `${PREFIX}${input.paragraphId}`;
  const dependency = () => {
    const paragraph = store.projects.getParagraph(input.paragraphId);
    if (!paragraph || paragraph.sourceText !== input.parts.join('')) throw new Error('长段原文已变化，旧片段未合并');
    return hash([auditInput(store, input.paragraphId).inputHash, store.translations.latestFinal(input.paragraphId) ?? null]);
  };
  const initialDependency = dependency();
  const fingerprint = hash([input, initialDependency]);
  const read = (): Checkpoint | null => {
    const row = store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [key]);
    try {
      const data = row ? JSON.parse(row.value) : null;
      if (data?.version !== 1 || data.fingerprint !== fingerprint || typeof data.owner !== 'string' || !Array.isArray(data.parts) || data.parts.length > input.parts.length) return null;
      for (const part of data.parts) {
        const item = translationItemSchema.safeParse(part?.item);
        if (!item.success || item.data.id !== input.paragraphId || !item.data.translation.trim() || typeof part.aiCallId !== 'string' ||
          part.checksum !== hash([part.item, part.aiCallId]) ||
          !store.db.get("SELECT id FROM ai_calls WHERE id=? AND error IS NULL AND workstation_id='faithful-translator'", [part.aiCallId])) return null;
      }
      return data as Checkpoint;
    } catch { return null; }
  };
  // One bounded record per paragraph, replacing obsolete inputs rather than accumulating retries.
  const state: Checkpoint = { version: 1, fingerprint, owner: randomUUID(), parts: read()?.parts ?? [] };
  store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [key, JSON.stringify(state)]);
  const assertCurrent = () => {
    if (dependency() !== initialDependency) throw new Error('长段原文、上下文或稿件已变化，旧片段未合并');
    if (read()?.owner !== state.owner) throw new Error('长段检查点已由较新任务接管或失效，请继续重试');
  };
  return {
    // Defensive copies: later whole-paragraph checks must not mutate saved segment evidence.
    completed: structuredClone(state.parts),
    assertCurrent,
    append(item: TranslationItem, aiCallId: string) {
      store.transaction(() => {
        assertCurrent();
        if (state.parts.length >= input.parts.length || item.id !== input.paragraphId || !item.translation.trim()) throw new Error('长段片段记录不完整');
        const next = { ...state, parts: [...state.parts, { item: structuredClone(item), aiCallId, checksum: hash([item, aiCallId]) }] };
        store.db.run('UPDATE meta SET value=? WHERE key=?', [JSON.stringify(next), key]);
        state.parts = next.parts;
      });
    },
  };
}

/** meta has no foreign keys; remove deleted paragraphs' cached text during existing startup recovery. */
export function pruneLongParagraphCheckpoints(store: ProjectStore): void {
  store.db.run('DELETE FROM meta WHERE substr(key,1,?)=? AND NOT EXISTS (SELECT 1 FROM paragraphs WHERE id=substr(meta.key,?))', [PREFIX.length, PREFIX, PREFIX.length + 1]);
}
