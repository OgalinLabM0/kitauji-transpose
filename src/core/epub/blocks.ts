/**
 * 文本块协议（docs/设计/EPUB_WRITEBACK.md 第 2 节）。
 * 模型只看到 modelText：纯文本 + 不透明标记 ⟦n⟧…⟦/n⟧（包裹）/ ⟦n⟧（原子）。
 * 回写时严格校验标记集合与嵌套，再按模板重建行内结构。
 */
import { NODE_ELEMENT, NODE_TEXT, NODE_CDATA, childElements, localName, parseXml } from './xml';
import { XMLSerializer } from '@xmldom/xmldom';
import type { Document, Element, Node } from './xml';

export type BlockProtocol = 'slots' | 'markers' | 'untranslatable';
export type BlockType = 'plain' | 'ruby' | 'em' | 'link' | 'footnote' | 'mixed';

export interface MarkerSpec {
  id: number;
  kind: 'wrap' | 'atomic' | 'ruby';
  tag: string;
  attrs: Record<string, string>;
  /** ruby 专用：原 rt 文本 */
  rt?: string;
  /** Original opaque SVG/MathML subtree; never exposed as editable model text. */
  xml?: string;
}
export interface InlineTemplate { markers: MarkerSpec[] }

export interface ExtractedBlock {
  el: Element;
  xpath: string;
  visibleText: string;
  modelText: string;
  protocol: BlockProtocol;
  blockType: BlockType;
  template: InlineTemplate;
}

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'blockquote', 'div', 'dd', 'dt', 'figcaption', 'caption', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'figure', 'ul', 'ol', 'dl', 'table', 'tbody', 'thead', 'tr', 'body', 'pre', 'address', 'hr']);
const SKIP_TAGS = new Set(['script', 'style', 'svg', 'math', 'template', 'head', 'title', 'rt', 'rp']);
const UNTRANSLATABLE_BLOCK = new Set(['pre', 'code', 'hr']);
const OPEN = '⟦', CLOSE = '⟧';

const hasBlockDescendant = (el: Element): boolean => childElements(el).some(c => BLOCK_TAGS.has(localName(c)) || hasBlockDescendant(c));

/** 收集叶子块（自身是块级、无块级后代） */
export function collectLeafBlocks(body: Element): Element[] {
  const out: Element[] = [];
  const walk = (el: Element): void => {
    const name = localName(el);
    if (SKIP_TAGS.has(name)) return;
    const kids = childElements(el);
    if (BLOCK_TAGS.has(name) && name !== 'body' && !hasBlockDescendant(el)) { out.push(el); return; }
    for (const k of kids) walk(k);
  };
  walk(body);
  return out;
}

export function visibleTextOf(node: Node): string {
  let s = '';
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === NODE_TEXT || c.nodeType === NODE_CDATA) s += c.nodeValue ?? '';
    else if (c.nodeType === NODE_ELEMENT) {
      const name = localName(c as Element);
      if (SKIP_TAGS.has(name)) continue;
      if (name === 'br') s += '\n'; else s += visibleTextOf(c);
    }
  }
  return s;
}

const isSymbolOnly = (s: string): boolean => /^[\s\d０-９\p{P}\p{S}]*$/u.test(s);

export function extractBlock(el: Element, xpath: string): ExtractedBlock {
  const name = localName(el);
  const visibleText = visibleTextOf(el);
  const markers: MarkerSpec[] = [];
  const types = new Set<string>();
  let next = 1;

  const build = (node: Node): string => {
    let s = '';
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === NODE_TEXT || c.nodeType === NODE_CDATA) { s += c.nodeValue ?? ''; continue; }
      if (c.nodeType !== NODE_ELEMENT) continue;
      const e = c as Element; const tag = localName(e);
      if (tag === 'svg' || tag === 'math') {
        const id = next++;
        markers.push({ id, kind: 'atomic', tag, attrs: {}, xml: new XMLSerializer().serializeToString(e) });
        types.add('mixed'); s += `${OPEN}${id}${CLOSE}`; continue;
      }
      if (SKIP_TAGS.has(tag)) continue;
      const attrs: Record<string, string> = {};
      for (let i = 0; i < e.attributes.length; i++) { const a = e.attributes.item(i)!; attrs[a.name] = a.value; }
      if (tag === 'ruby') {
        let base = ''; let rt = '';
        for (let r = e.firstChild; r; r = r.nextSibling) {
          if (r.nodeType === NODE_TEXT) base += r.nodeValue ?? '';
          else if (r.nodeType === NODE_ELEMENT) { const rn = localName(r as Element); if (rn === 'rt') rt += visibleTextOf(r); else if (rn !== 'rp') base += visibleTextOf(r); }
        }
        const id = next++; markers.push({ id, kind: 'ruby', tag, attrs, rt }); types.add('ruby');
        s += `${OPEN}${id}${CLOSE}${base}${OPEN}/${id}${CLOSE}`; continue;
      }
      const inner = visibleTextOf(e);
      if (tag === 'br' || tag === 'img' || tag === 'image' || inner.length === 0) {
        const id = next++; markers.push({ id, kind: 'atomic', tag, attrs }); types.add(tag === 'br' ? 'plain' : 'mixed');
        s += `${OPEN}${id}${CLOSE}`; continue;
      }
      const id = next++; markers.push({ id, kind: 'wrap', tag, attrs });
      types.add(tag === 'a' ? (/noteref|footnote/i.test(attrs['epub:type'] ?? '') ? 'footnote' : 'link') : (tag === 'em' || tag === 'strong' || tag === 'b' || tag === 'i' || tag === 'span') ? 'em' : 'mixed');
      s += `${OPEN}${id}${CLOSE}${build(e)}${OPEN}/${id}${CLOSE}`;
    }
    return s;
  };
  const modelText = build(el);

  let protocol: BlockProtocol = markers.length === 0 ? 'slots' : 'markers';
  if (UNTRANSLATABLE_BLOCK.has(name) || isSymbolOnly(visibleText)) protocol = 'untranslatable';
  const blockType: BlockType = types.size === 0 ? 'plain' : types.size === 1 ? ([...types][0] as BlockType) : 'mixed';
  return { el, xpath, visibleText, modelText, protocol, blockType, template: { markers } };
}

// ---------- 回环：解析模型输出 ----------

export type Token = { t: 'text'; s: string } | { t: 'open'; id: number } | { t: 'close'; id: number } | { t: 'atomic'; id: number };

export function tokenize(s: string): Token[] {
  const out: Token[] = []; const re = /⟦(\/?)(\d+)⟧/g; let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: 'text', s: s.slice(last, m.index) });
    out.push(m[1] === '/' ? { t: 'close', id: Number(m[2]) } : { t: 'open', id: Number(m[2]) });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ t: 'text', s: s.slice(last) });
  return out;
}

export const stripMarkers = (s: string): string => s.replace(/⟦\/?\d+⟧/g, '');

export interface RoundtripError { code: 'MARKER_ROUNDTRIP_FAILED'; message: string }

/** 校验标记集合、配对与嵌套；返回归一化后的 token 序列（原子标记标为 atomic）。 */
export function validateMarkers(output: string, template: InlineTemplate): { ok: true; tokens: Token[] } | { ok: false; error: RoundtripError } {
  const spec = new Map(template.markers.map(m => [m.id, m]));
  const fail = (message: string) => ({ ok: false as const, error: { code: 'MARKER_ROUNDTRIP_FAILED' as const, message } });
  const raw = tokenize(output);
  const tokens: Token[] = []; const stack: number[] = []; const opened = new Set<number>(); const closed = new Set<number>();
  for (const tk of raw) {
    if (tk.t === 'text') { tokens.push(tk); continue; }
    const m = spec.get(tk.id);
    if (!m) return fail(`译文含模板中不存在的标记 ${tk.id}`);
    if (tk.t === 'open') {
      if (opened.has(tk.id)) return fail(`标记 ${tk.id} 重复出现`);
      opened.add(tk.id);
      if (m.kind === 'atomic') { tokens.push({ t: 'atomic', id: tk.id }); continue; }
      stack.push(tk.id); tokens.push(tk);
    } else {
      if (m.kind === 'atomic') return fail(`原子标记 ${tk.id} 不应有闭合`);
      if (stack[stack.length - 1] !== tk.id) return fail(`标记 ${tk.id} 闭合顺序错误`);
      stack.pop(); closed.add(tk.id); tokens.push(tk);
    }
  }
  if (stack.length) return fail(`标记 ${stack.join(',')} 未闭合`);
  for (const m of template.markers) {
    if (!opened.has(m.id)) return fail(`标记 ${m.id} 在译文中缺失`);
    if (m.kind !== 'atomic' && !closed.has(m.id)) return fail(`标记 ${m.id} 未闭合`);
  }
  return { ok: true, tokens };
}

export interface RubySpan { start: number; end: number; rt: string }
export interface RebuildOptions { keepOriginalRuby: boolean; rubySpans?: RubySpan[] }
export interface RebuildError { code: 'RUBY_SPAN_CROSSES_MARKER' | 'MARKER_ROUNDTRIP_FAILED'; message: string }

/** 清空 target 的子节点，按 tokens + 模板重建。visible 偏移按去标记文本计。 */
export function rebuildInline(doc: Document, target: Element, tokens: Token[], template: InlineTemplate, opts: RebuildOptions): RebuildError | null {
  const spec = new Map(template.markers.map(m => [m.id, m]));
  const ns = target.namespaceURI;
  const spans = [...(opts.rubySpans ?? [])].sort((a, b) => a.start - b.start);
  // 先校验 ruby 区间不跨越标记边界
  let off = 0;
  const runs: { start: number; end: number }[] = [];
  for (const tk of tokens) if (tk.t === 'text') { runs.push({ start: off, end: off + tk.s.length }); off += tk.s.length; }
  for (const sp of spans) if (!runs.some(r => sp.start >= r.start && sp.end <= r.end)) return { code: 'RUBY_SPAN_CROSSES_MARKER', message: `ruby 区间 ${sp.start}-${sp.end} 跨越行内标记边界` };

  while (target.firstChild) target.removeChild(target.firstChild);
  const mk = (tag: string, attrs: Record<string, string>): Element => {
    const e = ns ? doc.createElementNS(ns, tag) : doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const appendText = (parent: Element, text: string, base: number): void => {
    let cur = base; let rest = text;
    for (const sp of spans) {
      if (sp.start < base || sp.end > base + text.length) continue;
      const before = text.slice(cur - base, sp.start - base);
      if (before) parent.appendChild(doc.createTextNode(before));
      const ruby = mk('ruby', {});
      ruby.appendChild(doc.createTextNode(text.slice(sp.start - base, sp.end - base)));
      const rp1 = mk('rp', {}); rp1.appendChild(doc.createTextNode('(')); ruby.appendChild(rp1);
      const rt = mk('rt', {}); rt.appendChild(doc.createTextNode(sp.rt)); ruby.appendChild(rt);
      const rp2 = mk('rp', {}); rp2.appendChild(doc.createTextNode(')')); ruby.appendChild(rp2);
      parent.appendChild(ruby);
      cur = sp.end; rest = text.slice(cur - base);
    }
    if (rest) parent.appendChild(doc.createTextNode(rest));
  };
  const stack: Element[] = [target]; off = 0;
  for (const tk of tokens) {
    const parent = stack[stack.length - 1]!;
    if (tk.t === 'text') { appendText(parent, tk.s, off); off += tk.s.length; continue; }
    const m = spec.get(tk.id)!;
    if (tk.t === 'atomic') {
      if (m.xml) {
        const original = parseXml(m.xml, 'xml');
        if (original.errors.length || !original.doc.documentElement) return { code: 'MARKER_ROUNDTRIP_FAILED', message: '原始图形／公式模板无法解析' };
        parent.appendChild(doc.importNode(original.doc.documentElement, true));
      } else parent.appendChild(mk(m.tag, m.attrs));
      continue;
    }
    if (tk.t === 'open') {
      if (m.kind === 'ruby' && !opts.keepOriginalRuby) { stack.push(parent); continue; } // 解包：只保留 base 中文
      const e = mk(m.tag, m.attrs); parent.appendChild(e); stack.push(e); continue;
    }
    // close
    const e = stack.pop()!;
    if (m.kind === 'ruby' && opts.keepOriginalRuby && m.rt) { const rt = mk('rt', {}); rt.appendChild(doc.createTextNode(m.rt)); e.appendChild(rt); }
  }
  return null;
}

/** 便捷：校验 + 重建 */
export function writeTranslation(doc: Document, target: Element, output: string, template: InlineTemplate, opts: RebuildOptions): RebuildError | null {
  const v = validateMarkers(output, template);
  if (!v.ok) return v.error;
  return rebuildInline(doc, target, v.tokens, template, opts);
}
