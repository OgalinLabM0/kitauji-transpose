import { setImmediate as yieldImport } from 'node:timers/promises';
/**
 * EPUB 导入（docs/设计/EPUB_WRITEBACK.md 第 1 节）：不可变快照 + xpath/hash 定位 + 叶子块协议 + 目录映射。
 */
import JSZip from 'jszip';
import type { ProjectStore } from '@core/db';
import { parseXml, firstElementByName, elementsByName, childElements, localName, xpathOf, hashVisible, sha256Hex, resolveHref, dirOf, findById } from './xml';
import type { Element } from './xml';
import { collectLeafBlocks, extractBlock, type ExtractedBlock } from './blocks';
import type { ParagraphType } from '@shared/types';

export interface EpubManifest {
  opfPath: string; opfDir: string;
  items: Map<string, { href: string; mediaType: string; properties: string }>; // id -> item
  spine: { idref: string; href: string; linear: boolean }[];
  navHref: string | null; ncxHref: string | null;
  title: string | null; author: string | null; language: string | null; version: string;
}

export interface ImportResult {
  seriesId: string; volumeId: string; archiveId: string;
  chapters: number; paragraphs: number; blocks: number; unparseable: string[]; missingTocResources: string[]; tocMapped: number; tocTotal: number;
  reusedExisting: boolean;
}

export const SCENE_BREAK_RE = /^[\s＊*◆◇●○■□▲△▼▽☆★※〇・…‥—－\-＝=~〜～]+$/u;
export const DIALOGUE_RE = /[「『（(]/u;
export const HEADING_RE = /^(第[〇一二三四五六七八九十百千0-9０-９]+[章話话節话幕部巻卷]|プロローグ|エピローグ|序章|終章|幕間|間章|外伝|あとがき|Prologue|Epilogue|Chapter\s*\d+)/u;

export function classifyParagraph(text: string): ParagraphType {
  const t = text.trim();
  const dialogue = /^[「『]/.test(t) || (/[「『]/.test(t) && /[」』]/.test(t));
  if (!dialogue) return 'narration';
  const stripped = t.replace(/「[^」]*」|『[^』]*』/g, '');
  return stripped.replace(/[\s、。！？!?…—]/g, '').length > 6 ? 'mixed' : 'dialogue';
}

export async function readManifest(zip: JSZip): Promise<EpubManifest> {
  const container = await zip.file('META-INF/container.xml')?.async('string');
  if (!container) throw new Error('无效 EPUB：缺少 META-INF/container.xml');
  const cdoc = parseXml(container, 'xml').doc;
  const rootfile = firstElementByName(cdoc, 'rootfile');
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath) throw new Error('无效 EPUB：container.xml 缺少 rootfile');
  const opfText = await zip.file(opfPath)?.async('string');
  if (!opfText) throw new Error(`无效 EPUB：找不到 ${opfPath}`);
  const opf = parseXml(opfText, 'xml').doc;
  const opfDir = dirOf(opfPath);
  const pkg = firstElementByName(opf, 'package');
  const version = pkg?.getAttribute('version') ?? '2.0';
  const items = new Map<string, { href: string; mediaType: string; properties: string }>();
  let navHref: string | null = null; let ncxHref: string | null = null;
  for (const it of elementsByName(opf, 'item')) {
    const id = it.getAttribute('id') ?? ''; const href = resolveHref(opfDir, it.getAttribute('href') ?? '');
    const mediaType = it.getAttribute('media-type') ?? ''; const properties = it.getAttribute('properties') ?? '';
    items.set(id, { href, mediaType, properties });
    if (/\bnav\b/.test(properties)) navHref = href;
    if (mediaType === 'application/x-dtbncx+xml') ncxHref = href;
  }
  const spineEl = firstElementByName(opf, 'spine');
  if (!ncxHref && spineEl?.getAttribute('toc')) ncxHref = items.get(spineEl.getAttribute('toc')!)?.href ?? null;
  const spine = elementsByName(opf, 'itemref').map(r => {
    const idref = r.getAttribute('idref') ?? ''; const item = items.get(idref);
    return { idref, href: item?.href ?? '', linear: r.getAttribute('linear') !== 'no' };
  }).filter(s => s.href);
  const text = (name: string): string | null => { const e = firstElementByName(opf, name); return e ? (e.textContent ?? '').trim() || null : null; };
  return { opfPath, opfDir, items, spine, navHref, ncxHref, title: text('title'), author: text('creator'), language: text('language'), version };
}

interface ParsedSpineItem { href: string; index: number; parseable: boolean; blocks: ExtractedBlock[]; bodyId: Map<string, Element>; sectionTitle?: string }

/** Structural declarations only: never classify story prose by its words. */
function declaredSectionTitle(body: Element): string | undefined {
  const semantic = (body.getAttribute('epub:type') ?? body.getAttributeNS?.('http://www.idpf.org/2007/ops', 'type') ?? '').split(/\s+/);
  const names: Record<string, string> = { titlepage: '扉页', 'copyright-page': '版权页', colophon: '出版信息', acknowledgments: '致谢', dedication: '献词', foreword: '前言', preface: '序言', afterword: '后记', bibliography: '参考资料', glossary: '词汇表', index: '索引', toc: '目录' };
  for (const value of semantic) if (names[value]) return names[value];
  // Explicit publisher page classes present in Japanese EPUBs, not text heuristics.
  const classes = (body.getAttribute('class') ?? '').split(/\s+/);
  if (classes.includes('caution-page')) return '阅读说明';
  if (classes.includes('info-top')) return '出版说明';
  return undefined;
}

async function parseSpineItem(zip: JSZip, href: string, index: number): Promise<ParsedSpineItem> {
  const src = await zip.file(href)?.async('string');
  if (src == null) return { href, index, parseable: false, blocks: [], bodyId: new Map() };
  try {
    const parsed = parseXml(src, 'xhtml');
    if (parsed.errors.length) return { href, index, parseable: false, blocks: [], bodyId: new Map() };
    const body = firstElementByName(parsed.doc, 'body');
    if (!body) return { href, index, parseable: false, blocks: [], bodyId: new Map() };
    const blocks = collectLeafBlocks(body).map(el => extractBlock(el, xpathOf(el, body)));
    const bodyId = new Map<string, Element>();
    for (const b of blocks) { const id = b.el.getAttribute('id'); if (id) bodyId.set(id, b.el); let p = b.el.parentNode; while (p && p !== body) { const pid = (p as Element).getAttribute?.('id'); if (pid && !bodyId.has(pid)) bodyId.set(pid, b.el); p = p.parentNode; } }
    if (body.getAttribute('id') && blocks[0]) bodyId.set(body.getAttribute('id')!, blocks[0].el);
    const sectionTitle = declaredSectionTitle(body);
    return { href, index, parseable: true, blocks, bodyId, ...(sectionTitle ? { sectionTitle } : {}) };
  } catch { return { href, index, parseable: false, blocks: [], bodyId: new Map() }; }
}

interface TocEntry { source: 'nav' | 'ncx'; path: string; label: string; href: string; fragment: string | null }

async function readToc(zip: JSZip, m: EpubManifest): Promise<TocEntry[]> {
  const out: TocEntry[] = [];
  if (m.navHref) {
    const src = await zip.file(m.navHref)?.async('string');
    if (src) try {
      const doc = parseXml(src, 'xhtml').doc;
      const nav = elementsByName(doc, 'nav').find(n => /\btoc\b/.test(n.getAttribute('epub:type') ?? n.getAttributeNS?.('http://www.idpf.org/2007/ops', 'type') ?? '')) ?? elementsByName(doc, 'nav')[0];
      if (nav) {
        const walk = (ol: Element, prefix: string): void => {
          childElements(ol).filter(li => localName(li) === 'li').forEach((li, i) => {
            const path = `${prefix}/${i + 1}`;
            const a = childElements(li).find(c => localName(c) === 'a' || localName(c) === 'span');
            if (a) {
              const href = a.getAttribute('href') ?? '';
              const [file, frag] = href.split('#');
              if (href.trim()) out.push({ source: 'nav', path, label: (a.textContent ?? '').trim(), href: resolveHref(dirOf(m.navHref!), file ?? ''), fragment: frag ?? null });
            }
            const sub = childElements(li).find(c => localName(c) === 'ol'); if (sub) walk(sub, path);
          });
        };
        const ol = childElements(nav).find(c => localName(c) === 'ol'); if (ol) walk(ol, 'nav');
      }
    } catch { /* toc 解析失败不阻止导入 */ }
  }
  if (m.ncxHref) {
    const src = await zip.file(m.ncxHref)?.async('string');
    if (src) try {
      const doc = parseXml(src, 'xml').doc;
      elementsByName(doc, 'navpoint').forEach((np, i) => {
        const label = firstElementByName(np, 'text')?.textContent?.trim() ?? '';
        const content = firstElementByName(np, 'content')?.getAttribute('src') ?? '';
        const [file, frag] = content.split('#');
        if (content.trim() && file?.trim()) out.push({ source: 'ncx', path: `ncx/${np.getAttribute('id') ?? i + 1}`, label, href: resolveHref(dirOf(m.ncxHref!), file), fragment: frag ?? null });
      });
    } catch { /* ignore */ }
  }
  return out;
}

export interface ImportOptions {
  seriesTitle?: string; seriesId?: string; volumeNumber?: number; volumeTitle?: string | null; signal?: AbortSignal; expectedHash?: string;
  /** Internal synchronous progress commit; never accepted from renderer IPC. Throwing rolls back the entire new volume. */
  onCommitted?: (result: ImportResult) => void;
}

export function commitImportResult(store: ProjectStore, opts: ImportOptions, result: ImportResult): ImportResult {
  return store.transaction(() => { opts.signal?.throwIfAborted(); opts.onCommitted?.(result); return result; });
}

export async function importEpub(store: ProjectStore, fileName: string, data: Uint8Array, opts: ImportOptions = {}): Promise<ImportResult> {
  opts.signal?.throwIfAborted();
  const sha = sha256Hex(data);
  if (opts.expectedHash && opts.expectedHash !== sha) throw new Error('文件在体检后已变化，请重新体检。');
  const existing = store.archives.findArchiveBySha(sha);
  if (existing) {
    const seriesId = store.projects.getVolumeSeriesId(existing.volume_id);
    const chapters = store.projects.listChapters(existing.volume_id).length;
    const paragraphs = store.db.get<{ n: number }>('SELECT COUNT(*) n FROM paragraphs WHERE scene_id IN (SELECT id FROM scenes WHERE chapter_id IN (SELECT id FROM chapters WHERE volume_id=?))', [existing.volume_id])?.n ?? 0;
    const blocks = store.db.get<{ n: number }>('SELECT COUNT(*) n FROM epub_text_blocks WHERE paragraph_id IS NOT NULL AND spine_item_id IN (SELECT id FROM spine_items WHERE archive_id=?)', [existing.id])?.n ?? 0;
    const unparseable = store.db.all<{ href: string }>('SELECT href FROM spine_items WHERE archive_id=? AND parseable=0', [existing.id]).map(r => r.href);
    const tocStats = store.db.get<{ total: number; mapped: number }>('SELECT COUNT(*) total, SUM(CASE WHEN heading_block_id IS NOT NULL THEN 1 ELSE 0 END) mapped FROM toc_entries WHERE archive_id=?', [existing.id]);
    const zip = await JSZip.loadAsync(data);
    const manifest = await readManifest(zip);
    const tocEntries = await readToc(zip, manifest);
    const missingTocResources = [...new Set(tocEntries.filter(t => t.href.trim().length > 0 && !zip.file(t.href)).map(t => t.href))];
    return commitImportResult(store, opts, { seriesId, volumeId: existing.volume_id, archiveId: existing.id, chapters, paragraphs, blocks, unparseable, missingTocResources, tocMapped: tocStats?.mapped ?? 0, tocTotal: tocStats?.total ?? 0, reusedExisting: true });
  }
  const zip = await JSZip.loadAsync(data);
  const m = await readManifest(zip);
  const spineItems: ParsedSpineItem[] = [];
  for (let i = 0; i < m.spine.length; i++) {
    await yieldImport(); opts.signal?.throwIfAborted();
    spineItems.push(await parseSpineItem(zip, m.spine[i]!.href, i));
  }
  const toc = await readToc(zip, m);
  // A spine item is a packaging fragment, not necessarily a chapter. Resolve
  // actual navigation targets first; EPUB3 nav wins duplicate NCX targets.
  const chapterStarts = new Map<Element, string>();
  for (const t of toc) {
    if (!t.label.trim()) continue;
    const si = spineItems.find(s => s.href === t.href && s.parseable);
    if (!si) continue;
    const target = t.fragment ? si.bodyId.get(t.fragment) : si.blocks.find(b => b.protocol !== 'untranslatable' && b.visibleText.trim())?.el;
    if (target && !chapterStarts.has(target)) {
      const heading = si.blocks.find(b => b.el === target && /^h[1-6]$/.test(localName(b.el)));
      chapterStarts.set(target, heading?.visibleText.trim() || t.label.trim());
    }
  }

  await yieldImport(); opts.signal?.throwIfAborted();
  return store.transaction(() => {
    // Another caller may have imported the same source while parsing yielded.
    if (store.archives.findArchiveBySha(sha)) throw new Error('该文件已被另一任务导入，请重新体检。');
    const title = opts.seriesTitle ?? m.title ?? fileName.replace(/\.epub$/i, '');
    const seriesId = opts.seriesId ?? store.projects.findSeriesByTitle(title) ?? store.projects.createSeries(title, m.author);
    if (opts.seriesId && !store.projects.getSeries(seriesId)) throw new Error('目标系列不存在，请重新选择。');
    const volumeNumber = opts.volumeNumber ?? store.projects.nextVolumeNumber(seriesId);
    if (!Number.isSafeInteger(volumeNumber) || volumeNumber < 1) throw new Error('册号必须为正整数。');
    if (store.projects.listVolumes(seriesId).some(v => v.volumeNumber === volumeNumber)) throw new Error('该册号已存在，请选择其他册号。');
    const volumeId = store.projects.createVolume(seriesId, volumeNumber, opts.volumeTitle ?? m.title);
    const archiveId = store.archives.createArchive({ volumeId, fileName, fileKind: 'epub', sha256: sha, blob: data });
    let seriesOrdinal = store.projects.nextSeriesOrdinal(seriesId);
    let chapterNumber = 0; let paragraphs = 0; let blocks = 0;
    const unparseable: string[] = [];
    const blockIdByHrefAndEl = new Map<string, Map<Element, string>>();
    const firstBlockIdByHref = new Map<string, string>();
    let chapterId: string | null = null;
    let sceneId: string | null = null;
    let sceneOrdinal = 1; let paraOrdinal = 0; let sceneHasContent = false;

    for (const si of spineItems) {
      const spineItemId = store.archives.addSpineItem(archiveId, si.href, si.index, si.parseable);
      if (!si.parseable) { unparseable.push(si.href); continue; }
      const translatable = si.blocks.filter(b => b.protocol !== 'untranslatable' && b.visibleText.trim().length > 0);
      const elMap = new Map<Element, string>(); blockIdByHrefAndEl.set(si.href, elMap);
      if (translatable.length === 0) {
        for (const b of si.blocks) store.archives.addBlock({ spine_item_id: spineItemId, paragraph_id: null, xpath: b.xpath, block_hash: hashVisible(b.visibleText), block_type: b.blockType, protocol: 'untranslatable', inline_template: JSON.stringify(b.template), source_text: b.visibleText });
        continue;
      }
      // When a document has no resolved TOC entry, an explicit opening heading
      // can start a chapter. Plain continuation files never create numbered chapters.
      const first = translatable[0]!;
      if (si.sectionTitle && !chapterStarts.has(first.el)) chapterStarts.set(first.el, si.sectionTitle);
      if (!si.blocks.some(b => chapterStarts.has(b.el)) && (/^h[1-6]$/.test(localName(first.el)) || HEADING_RE.test(first.visibleText.trim()))) chapterStarts.set(first.el, first.visibleText.trim());
      let pendingTitle: string | null = null;

      for (const b of si.blocks) {
        if (chapterStarts.has(b.el)) pendingTitle = chapterStarts.get(b.el)!;
        const hash = hashVisible(b.visibleText);
        const isBreak = SCENE_BREAK_RE.test(b.visibleText) && b.visibleText.trim().length > 0;
        if (b.protocol === 'untranslatable' || b.visibleText.trim().length === 0) {
          const id = store.archives.addBlock({ spine_item_id: spineItemId, paragraph_id: null, xpath: b.xpath, block_hash: hash, block_type: b.blockType, protocol: 'untranslatable', inline_template: JSON.stringify(b.template), source_text: b.visibleText });
          elMap.set(b.el, id);
          if (isBreak && sceneHasContent && chapterId) { sceneOrdinal++; sceneId = store.projects.createScene(chapterId, sceneOrdinal); paraOrdinal = 0; sceneHasContent = false; }
          continue;
        }
        if (!chapterId || pendingTitle !== null) {
          chapterId = store.projects.createChapter(volumeId, ++chapterNumber, pendingTitle ?? '正文');
          sceneOrdinal = 1; sceneId = store.projects.createScene(chapterId, sceneOrdinal); paraOrdinal = 0; sceneHasContent = false; pendingTitle = null;
        }
        paraOrdinal++;
        const paragraphId = store.projects.insertParagraph({ sceneId: sceneId!, paraOrdinal, sourceText: b.modelText, sourceHash: hash, paragraphType: classifyParagraph(b.visibleText) }, seriesOrdinal++);
        const id = store.archives.addBlock({ spine_item_id: spineItemId, paragraph_id: paragraphId, xpath: b.xpath, block_hash: hash, block_type: b.blockType, protocol: b.protocol, inline_template: JSON.stringify(b.template), source_text: b.visibleText });
        elMap.set(b.el, id);
        if (!firstBlockIdByHref.has(si.href)) firstBlockIdByHref.set(si.href, id);
        paragraphs++; blocks++; sceneHasContent = true;
      }
    }

    let tocMapped = 0;
    for (const t of toc) {
      let headingBlockId: string | null = null;
      const si = spineItems.find(s => s.href === t.href);
      if (si) {
        if (t.fragment) { const el = si.bodyId.get(t.fragment); if (el) headingBlockId = blockIdByHrefAndEl.get(t.href)?.get(el) ?? null; }
        if (!headingBlockId) {
          const norm = t.label.replace(/\s+/g, '');
          const match = si.blocks.find(b => b.visibleText.replace(/\s+/g, '') === norm);
          headingBlockId = match ? (blockIdByHrefAndEl.get(t.href)?.get(match.el) ?? null) : null;
        }
        if (!headingBlockId && !t.fragment) headingBlockId = firstBlockIdByHref.get(t.href) ?? null;
      }
      if (headingBlockId) tocMapped++;
      store.archives.addToc({ archive_id: archiveId, toc_source: t.source, entry_path: t.path, source_label: t.label, heading_block_id: headingBlockId });
    }
    if (!paragraphs) throw new Error('未识别到正文段落，请检查 EPUB 内容。');
    store.projects.touchSeries(seriesId);
    // Only call it a missing resource when the ZIP has no target file. A
    // cover can be present yet contain no translatable block, and a malformed
    // package can omit an existing file from the spine; both are distinct from
    // a broken TOC link.
    const missingTocResources = [...new Set(toc.filter(t => t.href.trim().length > 0 && !zip.file(t.href)).map(t => t.href))];
    return commitImportResult(store, opts, { seriesId, volumeId, archiveId, chapters: chapterNumber, paragraphs, blocks, unparseable, missingTocResources, tocMapped, tocTotal: toc.length, reusedExisting: false });
  });
}

/** 供目录/元数据处理复用 */
export { findById };
