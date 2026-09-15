/**
 * EPUB 精确写回（docs/设计/EPUB_WRITEBACK.md 第 3–7 节）。
 * 任一定位/哈希/标记回环失败即阻止导出，不静默降级。
 */
import JSZip from 'jszip';
import { REFERENCE_BLOCK } from './bilingual';
import type { ProjectStore, BlockRow, RubyAnnotation } from '@core/db';
import { parseXml, serializeXml, firstElementByName, elementsByName, childElements, localName, resolveXpath, hashVisible, resolveHref, dirOf, relativeTo } from './xml';
import type { Document, Element } from './xml';
import { visibleTextOf, writeTranslation, stripMarkers, extractBlock, type InlineTemplate } from './blocks';
import { readManifest } from './epubImport';
import { rubyForExport } from '../workflow/rubyDisplay';

export type ExportFailureCode =
  | 'XPATH_NOT_FOUND' | 'BLOCK_HASH_MISMATCH' | 'MARKER_ROUNDTRIP_FAILED' | 'RUBY_SPAN_CROSSES_MARKER'
  | 'NOTE_ID_COLLISION' | 'XHTML_SERIALIZE_FAILED' | 'MANIFEST_BROKEN' | 'UNPARSEABLE_SOURCE' | 'MISSING_TRANSLATION';

export interface ExportFailure { code: ExportFailureCode; href: string; xpath?: string; paragraphId?: string | null; message: string }

export interface ExportOptions {
  mode: 'zh' | 'bilingual';
  bilingualLayout: 'jp-top' | 'zh-top';
  translateTitle: boolean;
  keepOriginalRuby: boolean;
  /** 段落 → 注释文本（双关/术语）；EPUB2 普通链接脚注，EPUB3 语义脚注。 */
  notes?: Map<string, string[]>;
  /** 允许未翻译块原样保留（仅预览用；正式导出应为 false） */
  allowUntranslated?: boolean;
}

export interface ExportOutcome {
  ok: boolean; data: Uint8Array | null; failures: ExportFailure[]; writtenBlocks: number; skippedBlocks: number; keptBlocks: number; messages: string[];
}

const NOTE_PREFIX = 'v3-note-'; const REF_PREFIX = 'v3-ref-';
const BILINGUAL_CSS = `.v3-jp { opacity: 0.72; margin-bottom: 0.2em; }\n.v3-zh { margin-top: 0; }\n.v3-notes { margin-top: 2em; font-size: 0.9em; border-top: 1px solid #999; padding-top: 0.6em; }\n`;

function collectIds(doc: Document): Set<string> {
  const ids = new Set<string>(); const stack = [doc as unknown as Element];
  while (stack.length) { const n = stack.pop()!; if (n.nodeType === 1) { const id = n.getAttribute?.('id'); if (id) ids.add(id); } for (let c = n.lastChild; c; c = c.previousSibling) stack.push(c as Element); }
  return ids;
}

export async function exportEpub(store: ProjectStore, volumeId: string, opts: ExportOptions): Promise<ExportOutcome> {
  const failures: ExportFailure[] = []; const messages: string[] = [];
  let writtenBlocks = 0, skippedBlocks = 0, keptBlocks = 0;
  const archive = store.archives.archiveOfVolume(volumeId);
  if (!archive || archive.file_kind !== 'epub') return { ok: false, data: null, failures: [{ code: 'MANIFEST_BROKEN', href: '', message: '该册不是 EPUB 源' }], writtenBlocks, skippedBlocks, keptBlocks, messages };
  const blob = store.archives.archiveBlob(archive.id)!;
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const series = store.projects.getSeries(seriesId);

  const spineItems = store.archives.spineItems(archive.id);
  const paragraphIds = store.projects.listParagraphIdsByVolume(volumeId);
  const finals = store.translations.finalsForParagraphs(paragraphIds);
  // Capture every database input synchronously, before ZIP work yields to live edits.
  const blocksBySpine = new Map(spineItems.map(si => [si.id, store.archives.blocksOfSpineItem(si.id)]));
  const toc = store.archives.tocEntries(archive.id);
  const rubyByParagraph = new Map([...finals].map(([id, fin]) => [id, rubyForExport(store, id, store.translations.rubyOf(fin))]));
  const zip = await JSZip.loadAsync(new Uint8Array(blob));
  const m = await readManifest(zip);
  const cssPrefix = m.opfDir ? m.opfDir + '/' : '';
  let cssName = 'v3-bilingual.css', cssSuffix = 1;
  const reservedHrefs = new Set([...m.items.values()].map(item => item.href));
  while (zip.files[cssPrefix + cssName] || reservedHrefs.has(cssPrefix + cssName)) cssName = `v3-bilingual-${cssSuffix++}.css`;
  const opfSource = await zip.file(m.opfPath)!.async('string');
  const opfIds = collectIds(parseXml(opfSource, 'xml').doc);
  let cssId = 'v3-bilingual-css', idSuffix = 1;
  while (opfIds.has(cssId)) cssId = `v3-bilingual-css-${idSuffix++}`;
  const usedNoteIds = new Set<string>();
  let noteCounter = 0;
  const headingTextByBlockId = new Map<string, string>();
  let bilingualCssAdded = false;

  for (const si of spineItems) {
    const blocks = blocksBySpine.get(si.id)!;
    if (!si.parseable) { if (blocks.some(b => b.paragraph_id)) failures.push({ code: 'UNPARSEABLE_SOURCE', href: si.href, message: '导入时无法解析，含可译块' }); else messages.push(`原样保留：${si.href}（不可解析）`); keptBlocks += blocks.length; continue; }
    if (!blocks.some(b => b.paragraph_id)) { keptBlocks += blocks.length; continue; }
    const src = await zip.file(si.href)?.async('string');
    if (src == null) { failures.push({ code: 'MANIFEST_BROKEN', href: si.href, message: 'spine 文件缺失' }); continue; }
    let parsed; try { parsed = parseXml(src, 'xhtml'); } catch (e) { failures.push({ code: 'UNPARSEABLE_SOURCE', href: si.href, message: String(e) }); continue; }
    const doc = parsed.doc; const body = firstElementByName(doc, 'body');
    if (!body) { failures.push({ code: 'UNPARSEABLE_SOURCE', href: si.href, message: '无 body' }); continue; }
    const existingIds = collectIds(doc);
    const notesForFile: { id: string; refId: string; text: string }[] = [];
    let touched = false;

    // 两阶段：先在未修改的 DOM 上定位并校验全部块，再写回。
    // 双语模式会插入兄弟节点，边写边定位会让后续 xpath 序号整体偏移。
    const referenceElements: Element[] = [];
    const located: { b: BlockRow; paragraphId: string; el: Element }[] = [];
    for (const b of blocks) {
      if (b.block_type === REFERENCE_BLOCK) {
        const ref = resolveXpath(body, b.xpath);
        if (!ref || hashVisible(visibleTextOf(ref)) !== b.block_hash) failures.push({ code: 'BLOCK_HASH_MISMATCH', href: si.href, xpath: b.xpath, message: '已有译文定位校验失败，停止导出' });
        else referenceElements.push(ref);
        continue;
      }
      if (!b.paragraph_id) { keptBlocks++; continue; }
      const el = resolveXpath(body, b.xpath);
      if (!el) { failures.push({ code: 'XPATH_NOT_FOUND', href: si.href, xpath: b.xpath, paragraphId: b.paragraph_id, message: '定位路径不存在' }); continue; }
      const curHash = hashVisible(visibleTextOf(el));
      if (curHash !== b.block_hash) { failures.push({ code: 'BLOCK_HASH_MISMATCH', href: si.href, xpath: b.xpath, paragraphId: b.paragraph_id, message: '源块文本与导入时不一致' }); continue; }
      located.push({ b, paragraphId: b.paragraph_id, el });
    }
    // All XPath lookups above precede any removal, preserving positional paths.
    for (const ref of referenceElements) {
      // Retain fragment destinations without retaining any old translation text.
      for (const id of collectIds(ref as unknown as Document)) {
        const anchor = doc.createElementNS(ref.namespaceURI, 'span'); anchor.setAttribute('id', id);
        ref.parentNode?.insertBefore(anchor, ref);
      }
      ref.parentNode?.removeChild(ref); touched = true;
    }
    for (const { b, paragraphId, el } of located) {
      const fin = finals.get(paragraphId);
      if (!fin) {
        if (opts.allowUntranslated) { skippedBlocks++; continue; }
        failures.push({ code: 'MISSING_TRANSLATION', href: si.href, xpath: b.xpath, paragraphId: paragraphId, message: '段落尚无译文' }); continue;
      }
      const template: InlineTemplate = b.inline_template ? JSON.parse(b.inline_template) as InlineTemplate : { markers: [] };
      if (JSON.stringify(extractBlock(el, b.xpath).template) !== JSON.stringify(template)) {
        failures.push({ code: 'MARKER_ROUNDTRIP_FAILED', href: si.href, xpath: b.xpath, paragraphId, message: '原始内联结构与保存模板不一致，请重新导入并核对；不能丢弃图形或公式后导出' }); continue;
      }
      const ruby: RubyAnnotation[] = rubyByParagraph.get(paragraphId)!;
      const target = opts.mode === 'bilingual' ? cloneAsSibling(doc, el) : el;
      if (referenceElements.length) {
        target.setAttribute('lang','zh-CN');
        if(target.hasAttribute('xml:lang'))target.setAttribute('xml:lang','zh-CN');
        const style = (target.getAttribute('style') ?? '').replace(/(?:^|;)\s*opacity\s*:[^;]*(?:;|$)/gi, ';');
        target.setAttribute('style', style + ';opacity:1;');
      }
      const err = writeTranslation(doc, target, fin.final_text, template, { keepOriginalRuby: opts.keepOriginalRuby, rubySpans: ruby.map(r => ({ start: r.start, end: r.end, rt: r.rt })) });
      if (err) {
        if (opts.mode === 'bilingual') target.parentNode?.removeChild(target);
        failures.push({ code: err.code, href: si.href, xpath: b.xpath, paragraphId: paragraphId, message: err.message }); continue;
      }
      if (opts.mode === 'bilingual') {
        remapCloneIds(target, existingIds);
        el.setAttribute('class', `${el.getAttribute('class') ?? ''} v3-jp`.trim());
        target.setAttribute('class', `${(target.getAttribute('class') ?? '').replace(/\bv3-jp\b/, '')} v3-zh`.trim());
        if (opts.bilingualLayout === 'zh-top') { el.parentNode!.insertBefore(target, el); }
      }
      // 注释
      const notes = opts.notes?.get(paragraphId) ?? [];
      for (const text of notes) {
        let id: string; do { noteCounter++; id = `${NOTE_PREFIX}${noteCounter}`; } while (existingIds.has(id) || usedNoteIds.has(id) || existingIds.has(`${REF_PREFIX}${noteCounter}`));
        usedNoteIds.add(id);
        existingIds.add(id); existingIds.add(`${REF_PREFIX}${noteCounter}`);
        const a = doc.createElementNS(target.namespaceURI, 'a');
        if (m.version.startsWith('3')) a.setAttributeNS('http://www.idpf.org/2007/ops', 'epub:type', 'noteref');
        a.setAttribute('href', `#${id}`); a.setAttribute('id', `${REF_PREFIX}${noteCounter}`);
        a.appendChild(doc.createTextNode(`[${notesForFile.length + 1}]`));
        target.appendChild(a); notesForFile.push({ id, refId: `${REF_PREFIX}${noteCounter}`, text });
      }
      if (/^h[1-6]$/.test(localName(el))) headingTextByBlockId.set(b.id, stripMarkers(fin.final_text));
      writtenBlocks++; touched = true;
    }
    if (notesForFile.length) {
      const modern = m.version.startsWith('3');
      const wrap = doc.createElementNS(body.namespaceURI, modern ? 'div' : 'ol'); wrap.setAttribute('class', 'v3-notes');
      for (const n of notesForFile) {
        const note = doc.createElementNS(body.namespaceURI, modern ? 'aside' : 'li');
        if (modern) note.setAttributeNS('http://www.idpf.org/2007/ops', 'epub:type', 'footnote');
        note.setAttribute('id', n.id);
        const p = doc.createElementNS(body.namespaceURI, 'p'); p.appendChild(doc.createTextNode(n.text));
        const back = doc.createElementNS(body.namespaceURI, 'a'); back.setAttribute('href', `#${n.refId}`); back.appendChild(doc.createTextNode('返回正文'));
        // EPUB3 readers need not implement footnote popovers; keep an explicit route back.
        if (modern) back.setAttribute('style', 'margin-left: 0.5em');
        else p.appendChild(doc.createTextNode(' '));
        p.appendChild(back);
        note.appendChild(p); wrap.appendChild(note);
      }
      body.appendChild(wrap); touched = true;
    }
    if (touched) {
      if (opts.mode === 'bilingual' || notesForFile.length) {
        const head = firstElementByName(doc, 'head');
        if (head) { const link = doc.createElementNS(head.namespaceURI, 'link'); link.setAttribute('rel', 'stylesheet'); link.setAttribute('type', 'text/css'); link.setAttribute('href', relativeTo(dirOf(si.href), cssPrefix + cssName)); head.appendChild(link); bilingualCssAdded = true; }
      }
      let out: string; try { out = serializeXml(parsed); parseXml(out, 'xhtml'); } catch (e) { failures.push({ code: 'XHTML_SERIALIZE_FAILED', href: si.href, message: String(e) }); continue; }
      zip.file(si.href, out);
    }
  }

  // 目录标题
  const tocUnmapped = toc.filter(t => !t.heading_block_id).length;
  if (tocUnmapped) messages.push(`目录中 ${tocUnmapped} 项未能映射到标题块，保留原文`);
  await rewriteToc(zip, m, toc, headingTextByBlockId, failures);

  // OPF 元数据 + CSS manifest
  await rewriteOpf(zip, m, { translateTitle: opts.translateTitle, titleZh: series?.title ?? null, bilingual: opts.mode === 'bilingual', addCss: bilingualCssAdded, cssName, cssId });
  if (bilingualCssAdded) zip.file(cssPrefix + cssName, BILINGUAL_CSS);

  const structural = await validateStructure(zip);
  for (const s of structural) failures.push({ code: 'MANIFEST_BROKEN', href: s, message: 'manifest/spine 引用缺失' });

  if (failures.length) return { ok: false, data: null, failures, writtenBlocks, skippedBlocks, keptBlocks, messages };
  const data = await zip.generateAsync({ type: 'uint8array', mimeType: 'application/epub+zip', compression: 'DEFLATE', compressionOptions: { level: 6 } }, undefined);
  // mimetype 必须首项且不压缩：JSZip 按插入顺序写；重建保证
  const rebuilt = await ensureMimetypeFirst(data);
  return { ok: true, data: rebuilt, failures, writtenBlocks, skippedBlocks, keptBlocks, messages };
}

function cloneAsSibling(doc: Document, el: Element): Element {
  const clone = doc.createElementNS(el.namespaceURI, el.tagName);
  for (let i = 0; i < el.attributes.length; i++) { const a = el.attributes.item(i)!; if (a.name !== 'id') clone.setAttribute(a.name, a.value); }
  el.parentNode!.insertBefore(clone, el.nextSibling);
  return clone;
}

/** A bilingual copy needs its own anchors, including SVG url(#id) references. */
function remapCloneIds(root: Element, used: Set<string>): void {
  const nodes: Element[] = [];
  const visit = (el: Element) => { nodes.push(el); for (const child of childElements(el)) visit(child); };
  visit(root);
  const map = new Map<string, string>();
  for (const el of nodes) {
    const old = el.getAttribute('id'); if (!old) continue;
    let id = `v3-zh-${old}`, n = 1; while (used.has(id)) id = `v3-zh-${old}-${n++}`;
    used.add(id); map.set(old, id); el.setAttribute('id', id);
  }
  for (const el of nodes) for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes.item(i)!;
    let value = attr.value;
    if ((attr.name === 'href' || attr.name === 'xlink:href') && value.startsWith('#') && map.has(value.slice(1))) value = `#${map.get(value.slice(1))}`;
    if (['aria-labelledby', 'aria-describedby', 'headers'].includes(attr.name)) value = value.split(/\s+/).map(id => map.get(id) ?? id).join(' ');
    value = value.replace(/url\(#([^)]*)\)/g, (original, id: string) => map.has(id) ? `url(#${map.get(id)})` : original);
    if (value !== attr.value) el.setAttributeNS(attr.namespaceURI, attr.name, value);
  }
}

async function rewriteToc(zip: JSZip, m: Awaited<ReturnType<typeof readManifest>>, toc: { toc_source: string; entry_path: string; heading_block_id: string | null }[], texts: Map<string, string>, failures: ExportFailure[]): Promise<void> {
  const labelFor = (source: string, path: string): string | null => { const t = toc.find(x => x.toc_source === source && x.entry_path === path); return t?.heading_block_id ? texts.get(t.heading_block_id) ?? null : null; };
  if (m.navHref) {
    const src = await zip.file(m.navHref)?.async('string');
    if (src) try {
      const parsed = parseXml(src, 'xhtml');
      const navs = elementsByName(parsed.doc, 'nav');
      const nav = navs.find(n => /\btoc\b/.test(n.getAttribute('epub:type') ?? '')) ?? navs[0];
      let changed = false;
      const walk = (ol: Element, prefix: string): void => {
        childElements(ol).filter(li => localName(li) === 'li').forEach((li, i) => {
          const path = `${prefix}/${i + 1}`;
          const a = childElements(li).find(c => localName(c) === 'a' || localName(c) === 'span');
          const label = labelFor('nav', path);
          if (a && label) { while (a.firstChild) a.removeChild(a.firstChild); a.appendChild(parsed.doc.createTextNode(label)); changed = true; }
          const sub = childElements(li).find(c => localName(c) === 'ol'); if (sub) walk(sub, path);
        });
      };
      if (nav) { const ol = childElements(nav).find(c => localName(c) === 'ol'); if (ol) walk(ol, 'nav'); }
      if (changed) zip.file(m.navHref, serializeXml(parsed));
    } catch (e) { failures.push({ code: 'XHTML_SERIALIZE_FAILED', href: m.navHref, message: `nav：${String(e)}` }); }
  }
  if (m.ncxHref) {
    const src = await zip.file(m.ncxHref)?.async('string');
    if (src) try {
      const parsed = parseXml(src, 'xml'); let changed = false;
      elementsByName(parsed.doc, 'navpoint').forEach((np, i) => {
        const label = labelFor('ncx', `ncx/${np.getAttribute('id') ?? i + 1}`);
        const t = firstElementByName(np, 'text');
        if (label && t) { while (t.firstChild) t.removeChild(t.firstChild); t.appendChild(parsed.doc.createTextNode(label)); changed = true; }
      });
      if (changed) zip.file(m.ncxHref, serializeXml(parsed));
    } catch (e) { failures.push({ code: 'XHTML_SERIALIZE_FAILED', href: m.ncxHref, message: `ncx：${String(e)}` }); }
  }
}

async function rewriteOpf(zip: JSZip, m: Awaited<ReturnType<typeof readManifest>>, o: { translateTitle: boolean; titleZh: string | null; bilingual: boolean; addCss: boolean; cssName: string; cssId: string }): Promise<void> {
  const src = await zip.file(m.opfPath)?.async('string'); if (!src) return;
  const parsed = parseXml(src, 'xml'); const doc = parsed.doc;
  const metadata = firstElementByName(doc, 'metadata'); const manifest = firstElementByName(doc, 'manifest');
  if (metadata) {
    const langs = elementsByName(metadata, 'language');
    if (o.bilingual) {
      if (!langs.some(l => (l.textContent ?? '').startsWith('zh'))) { const l = langs[0] ? doc.createElementNS(langs[0].namespaceURI, langs[0].tagName) : doc.createElement('dc:language'); l.appendChild(doc.createTextNode('zh-CN')); metadata.appendChild(l); }
    } else if (langs[0]) { while (langs[0].firstChild) langs[0].removeChild(langs[0].firstChild); langs[0].appendChild(doc.createTextNode('zh-CN')); }
    if (o.translateTitle && o.titleZh) { const t = elementsByName(metadata, 'title')[0]; if (t) { while (t.firstChild) t.removeChild(t.firstChild); t.appendChild(doc.createTextNode(o.titleZh)); } }
    if (m.version.startsWith('3')) {
      const contrib = doc.createElementNS(metadata.namespaceURI, 'meta'); contrib.setAttribute('property', 'dcterms:modified'); contrib.appendChild(doc.createTextNode(new Date().toISOString().replace(/\.\d+Z$/, 'Z')));
      const old = elementsByName(metadata, 'meta').find(x => x.getAttribute('property') === 'dcterms:modified'); if (old) metadata.removeChild(old);
      metadata.appendChild(contrib);
    }
  }
  if (manifest && o.addCss) {
    const item = doc.createElementNS(manifest.namespaceURI, 'item'); item.setAttribute('id', o.cssId); item.setAttribute('href', o.cssName); item.setAttribute('media-type', 'text/css'); manifest.appendChild(item);
  }
  zip.file(m.opfPath, serializeXml(parsed));
}

/** 最小结构校验：manifest 项存在、spine 项在 manifest 中、nav/ncx 存在 */
export async function validateStructure(zip: JSZip): Promise<string[]> {
  const missing: string[] = [];
  try {
    const m = await readManifest(zip);
    for (const [, it] of m.items) if (!zip.file(it.href) && !it.href.startsWith('http')) missing.push(it.href);
    for (const s of m.spine) if (!m.items.has(s.idref)) missing.push(`spine:${s.idref}`);
    if (m.version.startsWith('3') && !m.navHref && !m.ncxHref) missing.push('nav');
  } catch (e) { missing.push(`opf:${String(e)}`); }
  return missing;
}

async function ensureMimetypeFirst(data: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(data);
  const out = new JSZip();
  out.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  const names = Object.keys(zip.files).filter(n => n !== 'mimetype').sort();
  for (const n of names) { const f = zip.files[n]!; if (f.dir) continue; out.file(n, await f.async('uint8array'), { compression: 'DEFLATE' }); }
  return out.generateAsync({ type: 'uint8array' });
}
