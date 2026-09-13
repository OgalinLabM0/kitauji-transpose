/** TXT 源：用 V3 自有模板生成 EPUB 3（封面页、nav、每章 XHTML、CSS、OPF）。 */
import JSZip from 'jszip';
import type { ProjectStore } from '@core/db';
import type { ExportOptions, ExportOutcome, ExportFailure } from '@core/epub/epubExport';
import { rubyForExport } from '../workflow/rubyDisplay';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const BASE_CSS = `body{font-family:serif;line-height:1.8;margin:1em 5%;}h1,h2{text-align:center;margin:1.5em 0 1em;}p{text-indent:2em;margin:0 0 .6em;}p.dialogue{text-indent:0;}.v3-jp{opacity:.72;margin-bottom:.2em;}.v3-zh{margin-top:0;}hr{border:0;text-align:center;margin:1.5em 0;}hr:after{content:"＊＊＊";}ruby rt{font-size:.6em;}`;

function rubyHtml(text: string, ruby: { start: number; end: number; rt: string }[]): string {
  if (!ruby.length) return esc(text);
  const sorted = [...ruby].sort((a, b) => a.start - b.start); let out = ''; let cur = 0;
  for (const r of sorted) { if (r.start < cur) continue; out += esc(text.slice(cur, r.start)); out += `<ruby>${esc(text.slice(r.start, r.end))}<rp>(</rp><rt>${esc(r.rt)}</rt><rp>)</rp></ruby>`; cur = r.end; }
  return out + esc(text.slice(cur));
}

export function exportTxtAsEpub(store: ProjectStore, volumeId: string, opts: ExportOptions): Promise<ExportOutcome> {
  const failures: ExportFailure[] = []; const messages: string[] = [];
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const series = store.projects.getSeries(seriesId);
  const vol = series?.volumes.find(v => v.id === volumeId);
  const title = (opts.translateTitle ? series?.title : null) ?? vol?.title ?? series?.title ?? '未命名';
  const chapters = store.projects.listChapters(volumeId);
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file('OEBPS/style.css', BASE_CSS);
  const manifest: string[] = []; const spine: string[] = []; const nav: string[] = [];
  let written = 0, skipped = 0;
  const page = (body: string, t: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${opts.mode === 'bilingual' ? 'ja' : 'zh-CN'}"><head><meta charset="UTF-8"/><title>${esc(t)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`;
  zip.file('OEBPS/cover.xhtml', page(`<h1>${esc(title)}</h1>${series?.author ? `<p style="text-align:center">${esc(series.author)}</p>` : ''}`, title));
  manifest.push(`<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="cover"/>`);
  chapters.forEach((ch, i) => {
    const ids = store.projects.listParagraphIdsByChapter(ch.id);
    const finals = store.translations.finalsForParagraphs(ids);
    const parts: string[] = []; let lastScene: string | null = null;
    const chTitle = ch.title ?? `第${ch.chapterNumber}章`;
    for (const pid of ids) {
      const p = store.projects.getParagraph(pid)!; const f = finals.get(pid);
      if (lastScene && lastScene !== p.sceneId) parts.push('<hr/>'); lastScene = p.sceneId;
      if (!f) { if (opts.allowUntranslated) { skipped++; parts.push(`<p class="v3-jp">${esc(p.sourceText)}</p>`); continue; } failures.push({ code: 'MISSING_TRANSLATION', href: `ch${i + 1}`, paragraphId: pid, message: '段落尚无译文' }); continue; }
      const cls = p.paragraphType === 'narration' ? '' : ' dialogue';
      const zh = `<p class="v3-zh${cls}">${rubyHtml(f.final_text, rubyForExport(store, pid, store.translations.rubyOf(f)))}</p>`+(opts.notes?.get(pid)??[]).map(note=>`<aside class="v3-note"><p>译注：${esc(note)}</p></aside>`).join('');
      if (opts.mode === 'bilingual') { const jp = `<p class="v3-jp${cls}">${esc(p.sourceText)}</p>`; parts.push(opts.bilingualLayout === 'zh-top' ? zh + jp : jp + zh); } else parts.push(zh);
      written++;
    }
    const headingText = finals.size && ch.title && ids[0] ? chTitle : chTitle;
    zip.file(`OEBPS/ch${i + 1}.xhtml`, page(`<h2 id="h">${esc(headingText)}</h2>${parts.join('\n')}`, headingText));
    manifest.push(`<item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="ch${i + 1}"/>`);
    nav.push(`<li><a href="ch${i + 1}.xhtml">${esc(headingText)}</a></li>`);
  });
  zip.file('OEBPS/nav.xhtml', page(`<nav epub:type="toc" id="toc"><h2>目录</h2><ol>${nav.join('')}</ol></nav>`, '目录'));
  const uid = `urn:uuid:${seriesId}`;
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">${uid}</dc:identifier><dc:title>${esc(title)}</dc:title><dc:language>${opts.mode === 'bilingual' ? 'ja' : 'zh-CN'}</dc:language>${opts.mode === 'bilingual' ? '<dc:language>zh-CN</dc:language>' : ''}${series?.author ? `<dc:creator>${esc(series.author)}</dc:creator>` : ''}<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  if (failures.length) return Promise.resolve({ ok: false, data: null, failures, writtenBlocks: written, skippedBlocks: skipped, keptBlocks: 0, messages });
  return zip.generateAsync({ type: 'uint8array', mimeType: 'application/epub+zip' }).then(data => ({ ok: true, data, failures, writtenBlocks: written, skippedBlocks: skipped, keptBlocks: 0, messages }));
}

/** TXT 源 → 纯文本（目标文件为 .txt 时）：章标题 + 段落；双语时 日文行/中文行 成对；场景切换用 ＊＊＊。 */
export function exportTxtPlain(store: ProjectStore, volumeId: string, opts: ExportOptions): ExportOutcome {
  const failures: ExportFailure[] = [];
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const series = store.projects.getSeries(seriesId);
  const vol = series?.volumes.find(v => v.id === volumeId);
  const title = (opts.translateTitle ? series?.title : null) ?? vol?.title ?? series?.title ?? '未命名';
  const lines: string[] = [title, ''];
  let written = 0, skipped = 0;
  store.projects.listChapters(volumeId).forEach((ch, i) => {
    const ids = store.projects.listParagraphIdsByChapter(ch.id);
    const finals = store.translations.finalsForParagraphs(ids);
    lines.push(ch.title ?? `第${ch.chapterNumber}章`, '');
    let lastScene: string | null = null;
    for (const pid of ids) {
      const p = store.projects.getParagraph(pid)!; const f = finals.get(pid);
      if (lastScene && lastScene !== p.sceneId) lines.push('＊＊＊', ''); lastScene = p.sceneId;
      if (!f) { if (opts.allowUntranslated) { skipped++; lines.push(p.sourceText, ''); continue; } failures.push({ code: 'MISSING_TRANSLATION', href: `ch${i + 1}`, paragraphId: pid, message: '段落尚无译文' }); continue; }
      if (opts.mode === 'bilingual') { const pair = opts.bilingualLayout === 'zh-top' ? [f.final_text, p.sourceText] : [p.sourceText, f.final_text]; lines.push(...pair, ''); } else lines.push(f.final_text, '');
      for(const note of opts.notes?.get(pid)??[])lines.push('译注：'+note,'');
      written++;
    }
    lines.push('');
  });
  if (failures.length) return { ok: false, data: null, failures, writtenBlocks: written, skippedBlocks: skipped, keptBlocks: 0, messages: [] };
  return { ok: true, data: new TextEncoder().encode('﻿' + lines.join('\r\n')), failures, writtenBlocks: written, skippedBlocks: skipped, keptBlocks: 0, messages: ['已按纯文本（.txt）导出'] };
}
