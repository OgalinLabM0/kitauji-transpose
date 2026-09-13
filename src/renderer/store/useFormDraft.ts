import { useRef, useState } from 'react';
import { useDraft } from './useDraft';
import { tryApi } from './app';
import type { DraftLocation } from './drafts';

/** Flat, explicitly selected form fields only. Never pass provider credentials here. */
export function useFormDraft<T extends Record<string, string | number | boolean>>(key: string, initial: T, location: DraftLocation, baseline: unknown = initial) {
  const draft = useDraft(key, JSON.stringify(initial), { version: 1, sourceText: JSON.stringify(baseline) }, location);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  let value = initial;
  let malformed = false;
  try {
    const parsed = JSON.parse(draft.text);
    if (!parsed || Object.keys(initial).some(k => typeof parsed[k] !== typeof initial[k]) || Object.keys(parsed).some(k => !Object.hasOwn(initial, k))) malformed = true;
    else value = parsed as T;
  } catch { malformed = true; }
  const change = (next: T) => { if (!lock.current) draft.change(JSON.stringify(next)); };
  const save = async (submit: () => Promise<unknown>, success?: string): Promise<boolean> => {
    if (lock.current || !draft.isCurrent() || draft.conflict || malformed) return false;
    lock.current = true; setBusy(true);
    try {
      const ok = await tryApi(async () => { await submit(); return true; }, success);
      if (!ok || !draft.isCurrent()) return false;
      draft.clear(); return true;
    } finally { lock.current = false; setBusy(false); }
  };
  return { ...draft, value, change, save, busy, malformed, current: JSON.stringify(baseline, null, 2) };
}
