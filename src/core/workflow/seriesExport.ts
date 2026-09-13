import JSZip from 'jszip';
import { randomUUID } from 'node:crypto';
import type { ProjectStore } from '@core/db';
import type { SeriesExportCheck, SeriesExportResult } from '@shared/ipc';
import { captureVolumeExport, runQualityGate } from './qualityGate';

export function seriesExportCheck(store: ProjectStore, seriesId: string): SeriesExportCheck {
  if (!store.projects.getSeries(seriesId)) throw new Error('作品不存在');
  const volumes = store.projects.listVolumes(seriesId).map(v => ({ volumeId: v.id, volumeNumber: v.volumeNumber, title: v.title, report: runQualityGate(store, v.id) }));
  return { ok: volumes.length > 0 && volumes.every(v => v.report.ok), volumes };
}
function safeTitle(title: string): string {
  return Array.from(title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()).slice(0, 72).join('').replace(/[. ]+$/, '') || '未命名';
}

/** Capture all volumes in one synchronous DB snapshot; publish one complete archive only. */
export async function exportSeries(store: ProjectStore, seriesId: string, mode: 'zh' | 'bilingual', outputPath: string, writeFile: (path: string, data: Uint8Array) => Promise<void>, signal?: AbortSignal): Promise<SeriesExportResult> {
  signal?.throwIfAborted();
  if (!/\.zip$/i.test(outputPath)) throw new Error('全作品导出请选择 .zip 文件');
  if (!['zh', 'bilingual'].includes(mode)) throw new Error('不支持的导出模式');
  const captured = store.transaction(() => {
    const check = seriesExportCheck(store, seriesId);
    const snapshotId = randomUUID(), snapshotAt = new Date().toISOString();
    const title = store.projects.getSeries(seriesId)!.title;
    const volumes = check.ok ? check.volumes.map((v, i) => {
      const fileName = `${String(i + 1).padStart(3, '0')}_第${v.volumeNumber}册_${safeTitle(v.title ?? title)}.epub`;
      const prepared = captureVolumeExport(store, { volumeId: v.volumeId, mode, outputPath: fileName, preview: false });
      return { fileName, prepared };
    }) : [];
    return { check, snapshotId, snapshotAt, title, volumes };
  });
  const result: SeriesExportResult = { ok: false, outputPath: null, snapshotId: captured.snapshotId, snapshotAt: captured.snapshotAt, check: captured.check, files: [], messages: [] };
  if (!captured.check.ok) { result.messages.push('有册次尚未通过交付检查或作品为空，未保存全作品文件。请处理后重试。'); return result; }
  const outcomes = await Promise.allSettled(captured.volumes.map(v => v.prepared.generated));
  if (signal?.aborted) { result.messages.push('导出已取消，未保存文件。'); return result; }
  const zip = new JSZip();
  for (const [index, outcome] of outcomes.entries()) {
    const volume = captured.volumes[index]!;
    if (outcome.status === 'rejected') { result.messages.push(`${volume.fileName}：生成失败：${String(outcome.reason)}`); continue; }
    const out = outcome.value;
    if (!out?.ok || !out.data) {
      result.messages.push(`${volume.fileName}：${volume.prepared.error ?? out?.failures.map(f => f.message).join('；') ?? '生成失败'}`); continue;
    }
    zip.file(volume.fileName, out.data, { compression: 'STORE' });
  }
  if (result.messages.length) { result.messages.push('没有保存部分合集；原有文件未改动。'); return result; }
  const files = captured.volumes.map(v => v.fileName);
  zip.file('导出说明.txt', [`作品：${captured.title}`, `模式：${mode === 'zh' ? '中文译文' : '日中对照（依作品设置排列）'}`, `导出时间：${captured.snapshotAt}`, `导出快照：${captured.snapshotId}`, '', '本次全部册来自同一份书库快照，并已通过程序交付检查。检查通过不等于人工翻译质量认证。', '请解压后用阅读器打开各册 EPUB；后续修改稿件需要重新导出。', '', ...files].join('\n'));
  try {
    const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    signal?.throwIfAborted();
    await writeFile(outputPath, data);
  } catch (error) { result.messages.push(`保存未完成：${(error as Error).message}。可以重试，重试会检查最新稿件。`); return result; }
  result.ok = true; result.outputPath = outputPath; result.files = files;
  result.messages.push(`已保存全部${files.length}册及导出说明。`);
  try { store.translations.log({ level: 'success', message: `全作品导出完成：${outputPath}，${files.length}册，快照${captured.snapshotId}` }); }
  catch { result.messages.push('文件已保存，但操作日志未能记录。'); }
  return result;
}
