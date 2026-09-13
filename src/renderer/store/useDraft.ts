import { useState, useSyncExternalStore } from 'react';
import type { DraftBase } from '@shared/types';
import { useApp } from './app';
import { DraftStore, draftKey, libraryDraftKey, draftMatchesLibrary, sameBase, type DraftLocation, type LocalDraft } from './drafts';
import { draftIdentity } from './draftIdentityBridge';
export const drafts = new DraftStore({ getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key), keys: () => Object.keys(localStorage) });
// Kept for existing request guards and maintenance callers. This token fences in-flight
// renderer work; it is NOT the persistent library ID and is never accepted by the backend.
export function isolateDrafts(): void { draftIdentity.invalidate(); }
export function currentDraftSession(): string { return draftIdentity.snapshot().token; }
window.addEventListener('beforeunload', e => { if (drafts.unsaved.size) { e.preventDefault(); e.returnValue = ''; } });
export function useDraft(objectKey: string, initial: string, base: DraftBase | null, location?: DraftLocation) {
  const seriesId = useApp(s => s.currentSeriesId);
  const scope = useSyncExternalStore(draftIdentity.subscribe, draftIdentity.snapshot);
  const sid = location?.seriesId ?? (location?.page === 'settings' ? null : seriesId);
  const identity = scope.status === 'ready' ? scope.identity : null;
  const key = identity ? libraryDraftKey(identity, sid, objectKey) : `${draftKey(sid, objectKey)}:unverified:${scope.token}`;
  useSyncExternalStore(drafts.subscribe, drafts.snapshot);
  const [errorState, setError] = useState({ key: '', message: '' });
  let record: LocalDraft | null = null;
  let readError = '';
  try {
    record = drafts.read(key);
    if (record && identity && !draftMatchesLibrary(record, identity)) { record = null; readError = '草稿身份不匹配，已拒绝套用；请在找回草稿中手动复制核对。'; }
  } catch { readError = '无法读取草稿；请复制输入后再退出应用。'; }
  const text = record?.text ?? initial;
  const inferredLocation: DraftLocation | undefined = location ?? (objectKey.startsWith('draft-paragraph-') ? { page: 'workbench', ...(seriesId ? { seriesId } : {}), objectId: objectKey.slice('draft-paragraph-'.length), title: '正文编辑' } : objectKey.startsWith('draft-review-') ? { page: 'review', ...(seriesId ? { seriesId } : {}), objectId: objectKey.slice('draft-review-'.length), title: '复核输入' } : undefined);
  const isCurrent = () => draftIdentity.isCurrent(scope.token);
  const write = (value: string, nextBase: DraftBase | null) => {
    // A stale input callback must not label old-page text with a newly loaded identity.
    if (draftIdentity.snapshot().token !== scope.token || readError) return;
    const next: LocalDraft = { text: value, base: nextBase, session: scope.token, ...(identity ? { identity } : {}), ...(inferredLocation ? { location: inferredLocation } : {}), updatedAt: Date.now(), editId: crypto.randomUUID() };
    setError({ key, message: drafts.write(key, next) ? '' : '本地草稿写入失败，输入暂留本次会话；请保存或复制后再退出。' });
  };
  const change = (value: string) => write(value, record ? record.base : base);
  const clear = (): boolean => {
    if (!isCurrent()) return false;
    if (!record) return true;
    const ok = drafts.clear(key, record);
    setError({ key, message: ok ? '' : '草稿已变化或清理失败，仍保留输入。' }); return ok;
  };
  const rebase = () => { if (isCurrent()) write(text, base); };
  const conflict = !identity || !!readError || (!!record && !sameBase(record.base, base));
  return { text, change, clear, rebase, conflict, isCurrent, error: readError || scope.error || (!identity ? '书库身份尚未确认；输入仅可保留供人工核对，暂不提交。' : '') || (errorState.key === key ? errorState.message : '') || (drafts.unsaved.has(key) ? '草稿仅在本次会话，请先保存或复制。' : ''), stored: !!record, base: identity ? (record ? record.base : base) : null };
}
