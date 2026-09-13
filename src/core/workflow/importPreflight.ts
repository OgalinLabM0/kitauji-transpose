import { ProjectStore } from '@core/db';
import { importEpub } from '@core/epub/epubImport';
import { importTxt, decodeText } from '@core/txt/txtImport';
import { sha256Hex } from '@core/epub/xml';
import type { ImportPreflight } from '@shared/ipc';

/** Use the real parser in an isolated disposable database; never write into the library. */
export async function inspectImport(store: ProjectStore, name: string, data: Uint8Array, signal?: AbortSignal): Promise<ImportPreflight> {
  signal?.throwIfAborted();
  if (!/\.(epub|txt)$/i.test(name)) throw new Error('仅支持 EPUB 或 TXT 文件。');
  const hash = sha256Hex(data);
  const existing = store.archives.findArchiveBySha(hash);
  const temporary = new ProjectStore(':memory:');
  try {
    const result = /\.epub$/i.test(name) ? await importEpub(temporary, name, data, signal ? { signal } : {}) : importTxt(temporary, name, data, signal ? { signal } : {});
    signal?.throwIfAborted();
    const warnings: string[] = [];
    if (result.unparseable.length) warnings.push(`无法解析、将原样保留：${result.unparseable.join('、')}`);
    if (result.missingTocResources.length) warnings.push(`原文件缺少目录指向的内容：${result.missingTocResources.join('、')}`);
    if (result.tocMapped < result.tocTotal) warnings.push(`目录 ${result.tocTotal - result.tocMapped} 项未映射到正文标题。`);
    if (/\.txt$/i.test(name) && decodeText(data).includes('\uFFFD')) warnings.push('检测到替换字符，可能存在编码损坏，请核对原文件。');
    if (/\.epub$/i.test(name)) warnings.push('图片内文字尚未识别；章节数按可译正文资源统计。');
    const seriesId = existing ? store.projects.getVolumeSeriesId(existing.volume_id) : undefined;
    return { hash, chapters: temporary.projects.listChapters(result.volumeId).map(c => ({ title: c.title, paragraphs: temporary.projects.listParagraphIdsByChapter(c.id).length })), paragraphs: result.paragraphs, warnings,
      existing: existing && seriesId ? { seriesId, volumeId: existing.volume_id, seriesTitle: store.projects.getSeries(seriesId)?.title ?? '已有系列' } : null };
  } finally { temporary.close(); }
}
