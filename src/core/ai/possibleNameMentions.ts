/** Lexical retrieval only: a match must never establish presence or speaker identity. */
export function possibleNameQuote(source: string, name: string): string | null {
  if ([...name].length !== 1) return null;
  for (let at = source.indexOf(name); at >= 0; at = source.indexOf(name, at + name.length)) {
    const before = [...source.slice(0, at)].at(-1) ?? '';
    const after = source.slice(at + name.length);
    if (/[\p{Script=Han}\p{Script=Katakana}\p{Script=Latin}\p{Number}々]/u.test(before)) continue;
    if (after && !/^(?:[はがをにとのもへで、。「」『』！？!?\s]|君|くん|さん|ちゃん|様|さま|殿|先輩|先生)/u.test(after)) continue;
    return source.slice(Math.max(0, at - 12), Math.min(source.length, at + name.length + 24));
  }
  return null;
}
