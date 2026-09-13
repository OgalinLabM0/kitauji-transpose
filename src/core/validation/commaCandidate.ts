import { punctuationSequence } from './rules';

/** Propose only a unique deletion in generated text; this is never acceptance.
 * A comma can change negation/meaning, so callers must still run full review. */
export function uniqueCommaDeletion(source: string, draft: string): string | null {
  const expected = punctuationSequence(source);
  const actual = punctuationSequence(draft);
  if (actual.length !== expected.length + 1) return null;
  const signature = JSON.stringify(expected);
  const candidates = new Set<string>();
  for (let i = 0; i < draft.length; i++) {
    if (draft[i] !== '，') continue;
    const candidate = draft.slice(0, i) + draft.slice(i + 1);
    if (JSON.stringify(punctuationSequence(candidate)) === signature) candidates.add(candidate);
    if (candidates.size > 1) return null;
  }
  return candidates.size === 1 ? [...candidates][0]! : null;
}
