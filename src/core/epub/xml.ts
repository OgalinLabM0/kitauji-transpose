import { DOMParser, XMLSerializer, MIME_TYPE } from '@xmldom/xmldom';
import type { Document, Element, Node } from '@xmldom/xmldom';
import { createHash } from 'node:crypto';

export type { Document, Element, Node };

export const NODE_ELEMENT = 1;
export const NODE_TEXT = 3;
export const NODE_CDATA = 4;

export interface ParsedXml { doc: Document; declaration: string | null; errors: string[] }

/** 严格 XML 解析：fatalError 抛出；error 记录但继续（返回 errors 供调用方决定是否标记 parseable=0）。 */
export function parseXml(source: string, mime: 'xhtml' | 'xml' = 'xhtml'): ParsedXml {
  const errors: string[] = [];
  const parser = new DOMParser({
    onError: (level, message) => {
      if (level === 'fatalError') throw new Error(message);
      if (level === 'error') errors.push(message);
    },
  });
  const doc = parser.parseFromString(source, mime === 'xhtml' ? MIME_TYPE.XML_XHTML_APPLICATION : MIME_TYPE.XML_APPLICATION);
  const m = /^\s*(<\?xml[^>]*\?>)/.exec(source);
  return { doc, declaration: m?.[1] ?? null, errors };
}

export function serializeXml(parsed: ParsedXml): string {
  const body = new XMLSerializer().serializeToString(parsed.doc);
  if (parsed.declaration && !body.startsWith('<?xml')) return `${parsed.declaration}\n${body}`;
  return body;
}

export const localName = (el: Element): string => (el.localName ?? el.tagName).toLowerCase();

export function childElements(node: Node): Element[] {
  const out: Element[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.nodeType === NODE_ELEMENT) out.push(c as Element);
  return out;
}

export function firstElementByName(root: Node, name: string): Element | null {
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.nodeType === NODE_ELEMENT && localName(n as Element) === name) return n as Element;
    for (let c = n.lastChild; c; c = c.previousSibling) stack.push(c);
  }
  return null;
}

export function elementsByName(root: Node, name: string): Element[] {
  const out: Element[] = []; const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.nodeType === NODE_ELEMENT && localName(n as Element) === name) out.push(n as Element);
    for (let c = n.lastChild; c; c = c.previousSibling) stack.push(c);
  }
  return out;
}

export function findById(root: Node, id: string): Element | null {
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.nodeType === NODE_ELEMENT && (n as Element).getAttribute('id') === id) return n as Element;
    for (let c = n.lastChild; c; c = c.previousSibling) stack.push(c);
  }
  return null;
}

/** 从 body 起的绝对路径：/body/div[2]/p[17]，只用元素序号（同名兄弟计数）。 */
export function xpathOf(el: Element, body: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== body) {
    const name = localName(cur);
    let idx = 1;
    for (let s = cur.previousSibling; s; s = s.previousSibling) if (s.nodeType === NODE_ELEMENT && localName(s as Element) === name) idx++;
    parts.unshift(`${name}[${idx}]`);
    cur = cur.parentNode && cur.parentNode.nodeType === NODE_ELEMENT ? (cur.parentNode as Element) : null;
  }
  return `/body/${parts.join('/')}`;
}

export function resolveXpath(body: Element, xpath: string): Element | null {
  const segs = xpath.replace(/^\/body\/?/, '').split('/').filter(Boolean);
  let cur: Element = body;
  for (const seg of segs) {
    const m = /^([a-zA-Z0-9_:-]+)\[(\d+)\]$/.exec(seg); if (!m) return null;
    const name = m[1]!.toLowerCase(); let want = Number(m[2]); let found: Element | null = null;
    for (const c of childElements(cur)) if (localName(c) === name && --want === 0) { found = c; break; }
    if (!found) return null; cur = found;
  }
  return cur;
}

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
export const normalizeVisible = (s: string): string => s.replace(/\s+/g, ' ').trim();
export const hashVisible = (s: string): string => sha256Hex(normalizeVisible(s));

export function resolveHref(baseDir: string, href: string): string {
  const clean = decodeURIComponent(href.split('#')[0]!);
  const parts = (baseDir ? baseDir.split('/').filter(Boolean) : []);
  for (const seg of clean.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.' && seg !== '') parts.push(seg); }
  return parts.join('/');
}
export const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const relativeTo = (fromDir: string, target: string): string => {
  const a = fromDir ? fromDir.split('/') : []; const b = target.split('/');
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
};
