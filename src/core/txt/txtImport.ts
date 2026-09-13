/** TXT 导入：按标题行切章，空行切段，分隔符行切场景（docs/设计/EPUB_WRITEBACK.md 第 8 节）。 */
import type { ProjectStore } from '@core/db';
import { sha256Hex, hashVisible } from '@core/epub/xml';
import { classifyParagraph, commitImportResult, HEADING_RE, SCENE_BREAK_RE } from '@core/epub/epubImport';
import type { ImportOptions, ImportResult } from '@core/epub/epubImport';

export interface TxtChapterDraft { title: string | null; paragraphs: string[] }

export function decodeText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^﻿/, ''); }
  catch { return new TextDecoder('shift_jis').decode(data); }
}

export function splitTxt(text: string, headingRe: RegExp = HEADING_RE): TxtChapterDraft[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chapters: TxtChapterDraft[] = [];
  let cur: TxtChapterDraft = { title: null, paragraphs: [] };
  for (const raw of lines) {
    const line = raw.replace(/[ \t　]+$/g, '');
    const t = line.trim();
    if (t.length === 0) continue;
    if (headingRe.test(t) && t.length <= 60) {
      if (cur.paragraphs.length || cur.title) chapters.push(cur);
      cur = { title: t, paragraphs: [] }; continue;
    }
    cur.paragraphs.push(line.replace(/^[ \t　]+/, ''));
  }
  if (cur.paragraphs.length || cur.title) chapters.push(cur);
  return chapters.length ? chapters : [{ title: null, paragraphs: [] }];
}

export function importTxt(store: ProjectStore, fileName: string, data: Uint8Array, opts: ImportOptions = {}): ImportResult {
  opts.signal?.throwIfAborted();
  const sha = sha256Hex(data);
  if (opts.expectedHash && opts.expectedHash !== sha) throw new Error('文件在体检后已变化，请重新体检。');
  const existing = store.archives.findArchiveBySha(sha);
  if (existing) {
    const seriesId = store.projects.getVolumeSeriesId(existing.volume_id);
    return commitImportResult(store, opts, { seriesId, volumeId: existing.volume_id, archiveId: existing.id, chapters: store.projects.listChapters(existing.volume_id).length, paragraphs: store.projects.listParagraphIdsByVolume(existing.volume_id).length, blocks: store.projects.listParagraphIdsByVolume(existing.volume_id).length, unparseable: [], missingTocResources: [], tocMapped: 0, tocTotal: 0, reusedExisting: true });
  }
  const drafts = splitTxt(decodeText(data));
  if (!drafts.some(d => d.paragraphs.some(p => !SCENE_BREAK_RE.test(p)))) throw new Error('未识别到正文段落，请检查内容与编码。');
  opts.signal?.throwIfAborted();
  return store.transaction(() => {
    const title = opts.seriesTitle ?? fileName.replace(/\.txt$/i, '');
    const seriesId = opts.seriesId ?? store.projects.findSeriesByTitle(title) ?? store.projects.createSeries(title, null);
    if (opts.seriesId && !store.projects.getSeries(seriesId)) throw new Error('目标系列不存在，请重新选择。');
    const volumeNumber = opts.volumeNumber ?? store.projects.nextVolumeNumber(seriesId);
    if (!Number.isSafeInteger(volumeNumber) || volumeNumber < 1) throw new Error('册号必须为正整数。');
    if (store.projects.listVolumes(seriesId).some(v => v.volumeNumber === volumeNumber)) throw new Error('该册号已存在，请选择其他册号。');
    const volumeId = store.projects.createVolume(seriesId, volumeNumber, opts.volumeTitle ?? null);
    const archiveId = store.archives.createArchive({ volumeId, fileName, fileKind: 'txt', sha256: sha, blob: data });
    let seriesOrdinal = store.projects.nextSeriesOrdinal(seriesId);
    let paragraphs = 0; let chapterNumber = 0;
    for (const d of drafts) {
      chapterNumber++;
      const chapterId = store.projects.createChapter(volumeId, chapterNumber, d.title);
      let sceneOrdinal = 1; let sceneId = store.projects.createScene(chapterId, sceneOrdinal); let paraOrdinal = 0; let hasContent = false;
      for (const p of d.paragraphs) {
        if (SCENE_BREAK_RE.test(p)) { if (hasContent) { sceneOrdinal++; sceneId = store.projects.createScene(chapterId, sceneOrdinal); paraOrdinal = 0; hasContent = false; } continue; }
        paraOrdinal++;
        store.projects.insertParagraph({ sceneId, paraOrdinal, sourceText: p, sourceHash: hashVisible(p), paragraphType: classifyParagraph(p) }, seriesOrdinal++);
        paragraphs++; hasContent = true;
      }
    }
    store.projects.touchSeries(seriesId);
  return commitImportResult(store, opts, { seriesId, volumeId, archiveId, chapters: chapterNumber, paragraphs, blocks: paragraphs, unparseable: [], missingTocResources: [], tocMapped: 0, tocTotal: 0, reusedExisting: false });
  });
}
