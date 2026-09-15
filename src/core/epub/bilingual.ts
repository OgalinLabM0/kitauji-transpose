import { localName, type Element } from './xml';
import type { ExtractedBlock } from './blocks';

export const REFERENCE_BLOCK = 'reference-zh';
export const BILINGUAL_HELP = '双语 EPUB：支持逐段中日交替（中文在前或日文在前，同一正文文件顺序一致），两段为相邻的 p 元素。日文段须有 lang="ja"、xml:lang="ja"（也支持 ja-JP），或行内 style="opacity:0.4;"。语言标记有效时，淡色可由外部 CSS 设置。已有中文只供对照，不发送给模型、不计入翻译进度，也不混入导出成品。整章分语种、表格对照、没有语言标记且仅靠外部 CSS 或颜色区分暂不支持。';
export class BilingualFormatError extends Error {}
const marked = (el: Element) => /(?:^|;)\s*opacity\s*:\s*(?:0?\.4)\s*(?:;|$)/i.test(el.getAttribute('style') ?? '');

/** Read only paragraph-local declarations, not the whole book's inherited language. */
function paragraphLanguage(el: Element, href: string): string | undefined {
  const values = [el.getAttribute('lang'), el.getAttribute('xml:lang')]
    .map(v => v?.trim().toLowerCase()).filter((v): v is string => !!v);
  const languages = values.map(v => v.split('-')[0]!);
  if (new Set(languages).size > 1) throw new BilingualFormatError(`${href}：同一段落的 lang 与 xml:lang 语言标记冲突，请核对后重新导入。`);
  return languages[0];
}

/** Unpaired headings are preserved for presentation, never offered as Japanese source. */
export function isBilingualPresentationHeading(block: ExtractedBlock, references: Map<Element, ExtractedBlock>): boolean {
  return references.size > 0 && /^h[1-6]$/.test(localName(block.el)) && paragraphLanguage(block.el, '标题') !== 'ja';
}

/** Structural pairing, never a "no kana means Chinese" filter. Reference nodes
 * remain in the immutable source archive but never become model paragraphs. */
export function bilingualPairs(blocks: ExtractedBlock[], href: string): Map<Element, ExtractedBlock> {
  const paragraphs = blocks.filter(b => localName(b.el) === 'p' && b.visibleText.trim());
  const languages = new Map(paragraphs.map(b => [b.el, paragraphLanguage(b.el, href)]));
  for (const b of paragraphs) {
    if (marked(b.el) && languages.get(b.el) && languages.get(b.el) !== 'ja') {
      throw new BilingualFormatError(`${href}：淡色日文标记与段落语言标记冲突，请核对双语格式。`);
    }
  }
  const japanese = (b: ExtractedBlock) => languages.get(b.el) === 'ja' || marked(b.el);
  // A normal Japanese book often labels every paragraph. That is not a bilingual signal.
  if (paragraphs.length && paragraphs.every(b => languages.get(b.el) === 'ja')) return new Map();
  if (!blocks.some(b => marked(b.el)) && !paragraphs.some(japanese)) {
    if (paragraphs.some(b => languages.get(b.el) === 'zh')) throw new BilingualFormatError(`${href}：存在中文段落语言标记，但未找到可配对的日文标记；未将中文作为日文导入。`);
    return new Map();
  }
  const attempt = (direction: -1 | 1): Map<Element, ExtractedBlock> | null => {
    const result = new Map<Element, ExtractedBlock>();
    const used = new Set<Element>();
    for (let i = 0; i < blocks.length; i++) {
      const jp = blocks[i]!;
      if (!japanese(jp)) continue;
      const zh = blocks[i + direction];
      let adjacent = direction === -1 ? jp.el.previousSibling : jp.el.nextSibling;
      while (adjacent && adjacent.nodeType !== 1) adjacent = direction === -1 ? adjacent.previousSibling : adjacent.nextSibling;
      if (!zh || adjacent !== zh.el || localName(jp.el) !== 'p' || localName(zh.el) !== 'p' || japanese(zh) || (languages.get(zh.el) && languages.get(zh.el) !== 'zh') || !zh.visibleText.trim() || !jp.visibleText.trim() || used.has(zh.el)) return null;
      result.set(zh.el, jp); used.add(zh.el); used.add(jp.el);
    }
    for (const b of blocks) {
      if (used.has(b.el) || !b.visibleText.trim() || b.protocol === 'untranslatable') continue;
      if (/^h[1-6]$/.test(localName(b.el))) continue;
      return null;
    }
    return result;
  };
  const before = attempt(-1), after = attempt(1);
  if (!!before === !!after) throw new BilingualFormatError(`${href}：双语段落无法唯一配对。支持中文在前或日文在前，同一正文文件须顺序一致，淡色日文与中文为相邻 p 段落；请整理未配对内容后重新导入。`);
  const selected = before ?? after!;
  const sourceLines = [...selected.values()];
  const referenceLines = blocks.filter(b => selected.has(b.el));
  if ((!sourceLines.every(b => languages.get(b.el) === 'ja') && !sourceLines.some(b => /[ぁ-んァ-ヶ]/u.test(b.visibleText))) || referenceLines.filter(b => /[ぁ-んァ-ヶ]/u.test(b.visibleText)).length > referenceLines.length / 2) {
    throw new BilingualFormatError(`${href}：淡色段落与相邻段落的语言方向不明确，未自动排除正文；请核对双语格式。`);
  }
  return selected;
}
