/** Literal letter/number labels need no choice of a translated name. */
export const isLiteralRankLabel = (jp: string) => /^[A-Z0-9]+(?:[+-])?級$/u.test(jp.normalize('NFKC'));

/** A fragment only seen inside already-confirmed whole words adds no new evidence.
 * The caller exempts explicitly required proper-name components. */
export function coveredByConfirmedTerms(jp: string, sources: readonly string[], confirmed: readonly string[]): boolean {
  if (!jp) return false;
  const longer = confirmed.filter(word => word.length > jp.length && word.includes(jp));
  if (!longer.length) return false;
  let found = false;
  for (const source of sources) {
    for (let at = source.indexOf(jp); at >= 0; at = source.indexOf(jp, at + 1)) {
      found = true;
      const covered = longer.some(word => {
        for (let start = source.indexOf(word); start >= 0 && start <= at; start = source.indexOf(word, start + 1)) {
          if (start + word.length >= at + jp.length) return true;
        }
        return false;
      });
      if (!covered) return false;
    }
  }
  return found;
}
