/** Keep selection stable; when an item disappears, advance in its former reading order. */
export function nextReviewItem(previous: string[], current: string[], active: string | null): string | null {
  if (active && current.includes(active)) return active;
  const index = active ? previous.indexOf(active) : -1;
  if (index >= 0) {
    const available = new Set(current);
    const next = previous.slice(index + 1).find(id => available.has(id)) ?? previous.slice(0, index).reverse().find(id => available.has(id));
    if (next) return next;
  }
  return current[0] ?? null;
}
