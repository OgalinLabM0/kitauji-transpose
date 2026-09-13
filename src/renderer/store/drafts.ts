import type { DraftBase } from '@shared/types';
import type { LibraryIdentity } from '@shared/ipc';
import { sameLibraryIdentity } from './draftIdentity';
export interface DraftLocation { page: 'workbench' | 'review' | 'glossary' | 'knowledge' | 'settings'; seriesId?: string; objectId?: string; title: string }
export interface LocalDraft { identity?: LibraryIdentity; text: string; base: DraftBase | null; session?: string; location?: DraftLocation; updatedAt?: number; editId?: string }
export interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; keys?(): string[] }
export function sameBase(a: DraftBase | null, b: DraftBase | null): boolean {
  return !!a && !!b && a.version === b.version && a.sourceText === b.sourceText;
}
export function draftKey(seriesId: string | null, key: string): string {
  return `draft-v2:${encodeURIComponent(seriesId ?? 'settings')}:${encodeURIComponent(key)}`;
}
export function libraryDraftKey(identity: LibraryIdentity, seriesId: string | null, objectKey: string): string {
  return `draft-v3:${identity.libraryId}:${identity.epoch}:${encodeURIComponent(seriesId ?? 'settings')}:${encodeURIComponent(objectKey)}`;
}
export function draftMatchesLibrary(record: LocalDraft | null, identity: LibraryIdentity | null): boolean {
  return !!record && sameLibraryIdentity(record.identity, identity);
}
/** Memory is authoritative within this renderer; failures never evict unsaved input. */
export class DraftStore {
  private memory = new Map<string, LocalDraft>();
  private listeners = new Set<() => void>();
  private revision = 0;
  readonly unsaved = new Set<string>();
  constructor(private storage: DraftStorage) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = (): number => this.revision;
  private notify(): void { this.revision++; this.listeners.forEach(fn => fn()); }
  read(key: string): LocalDraft | null {
    if (this.memory.has(key)) return this.memory.get(key)!;
    const raw = this.storage.getItem(key);
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw);
      if (typeof value.text === 'string' && (value.base === null || (Number.isSafeInteger(value.base?.version) && typeof value.base?.sourceText === 'string'))) return value as LocalDraft;
    } catch { /* Legacy text has no trustworthy base or library identity. */ }
    return { text: raw, base: null };
  }
  listError = '';
  list(): { key: string; record: LocalDraft }[] {
    this.listError = '';
    let diskKeys: string[] = [];
    try { diskKeys = (this.storage.keys?.() ?? []).filter(key => key.startsWith('draft-')); }
    catch { this.listError = '无法读取历史草稿列表；仅显示本次会话可用的输入。'; }
    const keys = new Set([...this.memory.keys(), ...diskKeys]);
    return [...keys].flatMap(key => {
      try { const record = this.read(key); return record ? [{ key, record }] : []; }
      catch { this.listError = '部分历史草稿读取失败；可用的会话输入仍保留，请先复制。'; return []; }
    });
  }
  write(key: string, value: LocalDraft): boolean {
    this.memory.set(key, value);
    let saved = false;
    try { this.storage.setItem(key, JSON.stringify(value)); this.unsaved.delete(key); saved = true; }
    catch { this.unsaved.add(key); }
    this.notify(); return saved;
  }
  clear(key: string, expected: string | LocalDraft): boolean {
    try {
      const current = this.read(key);
      if (typeof expected === 'string' ? current?.text !== expected : JSON.stringify(current) !== JSON.stringify(expected)) return false;
      this.storage.removeItem(key); this.memory.delete(key); this.unsaved.delete(key); this.notify(); return true;
    } catch { this.unsaved.add(key); this.notify(); return false; }
  }
}
