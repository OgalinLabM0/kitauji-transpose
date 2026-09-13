import { containsVisibleQuote, visibleNameSource } from '../validation/nameEvidence';

type Source = { id: string; chapterId: string; sourceText: string };
/** Retrieval hints are literal source, never an assertion that two names are identical. */
export function termProposalContext<T extends Source>(paragraphs: readonly T[], jp: string) {
  const hits = paragraphs.filter(p => containsVisibleQuote(p.sourceText, jp));
  // Prefer a source introduction over another short reaction containing the nickname.
  const introduction = hits.find(p => /[一-龯]/u.test(visibleNameSource(p.sourceText)) && /──|――|こと|呼[ばぶん]|名前|愛称|あだ名/u.test(visibleNameSource(p.sourceText)));
  const examples = [...new Set([hits[0], introduction ?? hits[Math.floor(hits.length / 2)], hits.at(-1)])].filter((p): p is T => !!p);
  const stem = jp.replace(/(?:ちゃん|さん|くん|君|様|さま|殿)$/u, '');
  const expansion = stem !== jp && /^[ァ-ヶー]{2,}$/u.test(stem)
    ? paragraphs.filter(p => (visibleNameSource(p.sourceText).match(/[ァ-ヶー]+/gu) ?? []).some(word => word.startsWith(stem) && word.length > stem.length))
    : [];
  const adjacent = examples.flatMap(p => {
    const i = paragraphs.indexOf(p);
    return paragraphs.slice(Math.max(0, i - 2), i + 3).filter(other => other.chapterId === p.chapterId);
  });
  const seen = new Set(examples.map(p => p.id));
  const background: { id: string; source: string }[] = [];
  let remaining = 3000;
  for (const p of [...expansion.slice(0, 2), ...adjacent]) {
    const source = visibleNameSource(p.sourceText);
    if (seen.has(p.id) || !source.trim() || source.length > remaining) continue;
    seen.add(p.id); background.push({ id: p.id, source }); remaining -= source.length;
    if (background.length === 6) break;
  }
  return { examples, background };
}
