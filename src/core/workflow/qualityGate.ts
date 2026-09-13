import { legacyTermsAwaitingUser, termReviewMatcher } from './termConfirmation';
import { staleAutomaticSources } from './automaticKnowledgeSources';
import { staleAcceptedChanges } from '../db/knowledgeChanges';
import { trajectoryStatus } from './trajectoryReview';
import { chapterReadingStatus } from './chapterReading';
import { randomUUID } from 'node:crypto';
import { pendingFieldConflicts } from './characterConflicts';
/**
 * 质量门（docs/设计/PLAN_历史架构.md 第 8 节）与导出入口。任何 blocks_export 触发均阻止正式导出；预览导出可绕过（allowUntranslated）。
 */
import type { ProjectStore } from '@core/db';
import { exportEpub, type ExportOptions, type ExportOutcome } from '@core/epub/epubExport';
import { exportTxtAsEpub, exportTxtPlain } from '@core/txt/txtExport';
import { validateTranslation, hasBlocking } from '@core/validation';
import { checkInfoOrder } from '@core/validation/wordOrder';
import { validateMarkers, type InlineTemplate } from '@core/epub/blocks';
import { findGlossaryHits } from '@core/glossary/hits';
import {foreignNoteTexts} from './foreignNotes';
import type { QualityGateReport, ExportResult, TranslationFlag } from '@shared/types';
import { auditStatus } from './auditReceipts';
import { withIdentityRead } from '../db/identitySources';

export function runQualityGate(store: ProjectStore, volumeId: string): QualityGateReport {
  return withIdentityRead(store.db, () => {
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const ids = store.projects.listParagraphIdsByVolume(volumeId);
  const finals = store.translations.finalsForParagraphs(ids);
  const blockers = new Map<string, { count: number; sample: string[] }>();
  const warnings = new Map<string, number>();
  const add = (code: string, id: string): void => { const e = blockers.get(code) ?? { count: 0, sample: [] }; e.count++; if (e.sample.length < 5) e.sample.push(id); blockers.set(code, e); };
  const warn = (code: string): void => { warnings.set(code, (warnings.get(code) ?? 0) + 1); };

  if (!ids.length) add('EMPTY_VOLUME', volumeId);
  const staleChanges = staleAcceptedChanges(store.db, seriesId);
  for (const change of staleChanges) {
    const evidence = store.db.get<{ paragraph_id: string | null }>("SELECT paragraph_id FROM review_queue WHERE series_id=? AND json_extract(payload,'$.candidateId')=? LIMIT 1", [seriesId, change.id]);
    add('APPLIED_KNOWLEDGE_STALE', evidence?.paragraph_id && ids.includes(evidence.paragraph_id) ? evidence.paragraph_id : (ids[0] ?? volumeId));
  }
  const staleSources = staleAutomaticSources(store, seriesId);
  const trajectory = staleSources.length || staleChanges.length ? { missing: ids, issues: [] } : trajectoryStatus(store, volumeId);
  for (const id of trajectory.missing) add('TRAJECTORY_MISSING', id);
  for (const id of trajectory.issues) add('TRAJECTORY_UNRESOLVED', id);
  const reading = staleSources.length || staleChanges.length ? { missing: ids, stale: [], issues: [], unsupported: [] } : chapterReadingStatus(store, volumeId);
  for (const id of reading.missing) add('CHAPTER_READING_MISSING', id);
  for (const id of reading.stale) add('CHAPTER_READING_STALE', id);
  for (const id of reading.issues) add('CHAPTER_READING_UNRESOLVED', id);
  for (const id of reading.unsupported) add('CHAPTER_READING_NEEDS_BOUNDARY', id);
  let translated = 0, confirmed = 0;
  const terms = store.glossary.activeTerms(seriesId);
  for (const id of ids) {
    const f = finals.get(id);
    if (!f) { add('UNTRANSLATED', id); continue; }
    translated++; if (f.confirmed_by_user) confirmed++;
    const receipt = auditStatus(store, f);
    if (receipt !== 'valid') add(receipt === 'missing' ? 'AUDIT_MISSING' : 'AUDIT_STALE', id);
    if (!f.confirmed_by_user && !f.auto_accepted) add('ACCEPTANCE_PENDING', id);
    const p = store.projects.getParagraph(id)!;
    // 重新跑程序校验（最终稿可能被用户手改）
    const referenced = f.source_candidate_id ? store.translations.candidateById(f.source_candidate_id) : undefined;
    const cand = referenced?.candidate_text === f.final_text ? referenced : undefined;
    const flags = cand?.flags ? (JSON.parse(cand.flags) as TranslationFlag[]) : [];
    const hits = findGlossaryHits(terms.map(t => ({ id: t.id, term_jp: t.term_jp, term_zh: t.term_zh, term_type: t.term_type, lock_level: t.lock_level, sense_identity: t.sense_identity, senses: t.senses })), [p.sourceText]);
    const findings = validateTranslation({ source: p.sourceText, translation: f.final_text, paragraphType: p.paragraphType, flags, glossary: hits });
    const ord = checkInfoOrder(p.sourceText, f.final_text, cand?.source_coverage ? JSON.parse(cand.source_coverage) : []);
    if (ord.code !== 'ORDER_OK' && !(ord.code === 'ORDER_INVERTED' && receipt === 'valid')) findings.push({ code: ord.code, severity: 'blocks_export', message: ord.message });
    // 用户已接受/升级为义项的术语偏离不再阻断
    const acceptedTerms = new Set(store.db.all<{ term_id: string }>(`SELECT term_id FROM term_occurrences WHERE paragraph_id=? AND deviation_status IN ('accepted','promoted','sense-selected')`, [id]).map(r => r.term_id));
    for (let k = findings.length - 1; k >= 0; k--) { const x = findings[k]!; if ((x.code === 'GLOSSARY_UNFLAGGED_DEVIATION' || x.code === 'GLOSSARY_COUNT_MISMATCH') && acceptedTerms.has(String(x.details?.termId))) findings.splice(k, 1); }
    const block = store.archives.blocksOfParagraph(id)[0];
    const tpl: InlineTemplate = block?.inline_template ? JSON.parse(block.inline_template) : { markers: [] };
    const mk = validateMarkers(f.final_text, tpl);
    if (!mk.ok) findings.push({ code: 'MARKER_ROUNDTRIP_FAILED', severity: 'blocks_export', message: mk.error.message });
    for (const x of findings) { if (x.severity === 'blocks_export') add(x.code, id); else if (x.severity === 'warning') warn(x.code); }
    // 人工确认表示采纳，不等价于所有程序诊断已被证明无误。
  }
  // AI 审校未解决的阻断项
  for (const s of store.translations.blockingFindingSummary(ids)) { const e = blockers.get(`REVIEW:${s.code}`) ?? { count: 0, sample: [] }; e.count += s.count; e.sample.push(...s.sample.slice(0, 5 - e.sample.length)); blockers.set(`REVIEW:${s.code}`, e); }
  // 未处理的必须人工队列项（failed / lock-conflict / review-block）
  const queue = store.translations.listQueue(seriesId).filter(q => q.paragraphId && ids.includes(q.paragraphId));
  for (const q of queue) { if (q.kind !== 'warning') add(`QUEUE:${q.kind}`, q.paragraphId!); else warn(`QUEUE:${q.kind}`); }
  const termInVolume = termReviewMatcher(store, volumeId);
  for (const item of legacyTermsAwaitingUser(store, seriesId)) {
    if (termInVolume(item)) add('QUEUE:term-proposal', item.paragraphId && ids.includes(item.paragraphId) ? item.paragraphId : (ids[0] ?? volumeId));
  }
  for (const item of store.translations.listQueue(seriesId)) {
    if (item.kind === 'term-proposal' && !queue.some(q => q.id === item.id) && termInVolume(item)) add('QUEUE:term-proposal', ids[0] ?? volumeId);
  }
  for (const id of staleSources) { const q = store.translations.getQueueItem(id); add('AUTOMATIC_KNOWLEDGE_STALE', q?.paragraph_id && ids.includes(q.paragraph_id) ? q.paragraph_id : (ids[0] ?? volumeId)); }
  const through = Math.max(...ids.map(id => store.projects.getParagraph(id)!.seriesOrdinal));
  for (const q of pendingFieldConflicts(store,seriesId,through)) if (!queue.some(item => item.id === q.id) && ids[0]) add('QUEUE:stale-knowledge',ids[0]);
  // 待回查
  const rechecks = store.translations.pendingRechecks(ids); for (const r of rechecks) add('RECHECK_PENDING', r.paragraph_id);
  // 未处理的术语偏离
  const pendingDeviations = queue.filter(q => q.kind === 'glossary-deviation').length;

  return {
    ok: blockers.size === 0, totalParagraphs: ids.length, translated, confirmed,
    blockers: [...blockers].map(([code, v]) => ({ code, ...v })).sort((a, b) => b.count - a.count),
    warnings: [...warnings].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    pendingDeviations,
  };
  });
}

export interface ExportRequest { volumeId: string; mode: 'zh' | 'bilingual'; preview?: boolean; outputPath: string | null }

/** 收集注释：双关决定与术语注释草稿 → 段落脚注 */
export function collectNotes(store: ProjectStore, volumeId: string): Map<string, string[]> {
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const notes = new Map<string, string[]>();
  const push = (pid: string, text: string): void => { const a = notes.get(pid) ?? []; a.push(text); notes.set(pid, a); };
  for (const w of store.db.all<{ paragraph_id: string | null; source_original: string; source_variant: string; source_meaning: string; final_zh: string; decision_notes: string | null }>(`SELECT paragraph_id, source_original, source_variant, source_meaning, final_zh, decision_notes FROM wordplay_decisions WHERE series_id=? AND confirmed_by_user=1 AND paragraph_id IS NOT NULL`, [seriesId])) {
    if (w.final_zh.startsWith('[直译+注]') && w.paragraph_id) push(w.paragraph_id, `原文「${w.source_variant}」为「${w.source_original}」（${w.source_meaning}）的谐音/口误。${w.decision_notes ?? ''}`.trim());
  }
  for(const pid of store.projects.listParagraphIdsByVolume(volumeId)){
    const final=store.translations.latestFinal(pid);
    if(!final||!final.source_candidate_id)continue;
    const candidate=store.translations.candidateById(final.source_candidate_id);
    if(!candidate||candidate.candidate_text!==final.final_text||candidate.paragraph_id!==pid)continue;
    const flags=JSON.parse(candidate.flags??'[]') as TranslationFlag[];
    if(!flags.some(f=>f.type==='foreign-note')||auditStatus(store,final)!=='valid')continue;
    for(const text of foreignNoteTexts(store.projects.getParagraph(pid)!.sourceText,final.final_text,flags))push(pid,text);
  }
  return notes;
}

export function captureVolumeExport(store: ProjectStore, req: ExportRequest) {
  // Exporters must capture all database inputs before their first await. Returning
  // a wrapper keeps the SQLite transaction synchronous; ZIP/file IO runs outside it.
  return store.transaction(() => {
    const report = runQualityGate(store, req.volumeId);
    const snapshot = { snapshotId: randomUUID(), snapshotAt: new Date().toISOString(), preview: !!req.preview };
    const archive = store.archives.archiveOfVolume(req.volumeId);
    let error: string | undefined;
    if (!report.totalParagraphs) error = '本册没有可导出段落。';
    else if (!report.ok && !req.preview) error = '质量门未通过，已阻止正式导出。可先“预览导出”。';
    else if (req.outputPath && !/\.(epub|txt)$/i.test(req.outputPath)) error = '请选择 .epub 或 .txt 扩展名。';
    else if (archive?.file_kind === 'epub' && /\.txt$/i.test(req.outputPath ?? '')) error = 'EPUB 源请导出为 .epub，不能将 EPUB 内容保存为 .txt。';
    if (error) return { report, snapshot, error, generated: undefined };
    const settings = store.projects.getSettings(store.projects.getVolumeSeriesId(req.volumeId));
    const opts: ExportOptions = { mode: req.mode, bilingualLayout: settings['export.bilingual_layout'], translateTitle: settings['export.translate_title'], keepOriginalRuby: true, notes: collectNotes(store, req.volumeId), allowUntranslated: !!req.preview };
    try {
      const generated = archive?.file_kind === 'epub' ? exportEpub(store, req.volumeId, opts) : /\.txt$/i.test(req.outputPath ?? '') ? Promise.resolve(exportTxtPlain(store, req.volumeId, opts)) : exportTxtAsEpub(store, req.volumeId, opts);
      return { report, snapshot, generated, error: undefined };
    } catch (e) { return { report, snapshot, error: `生成失败：${(e as Error).message}`, generated: undefined }; }
  });
}

export async function exportVolume(store: ProjectStore, req: ExportRequest, writeFile: (path: string, data: Uint8Array) => Promise<void>): Promise<ExportResult> {
  const empty = { outputPath: null, writtenBlocks: 0, skippedBlocks: 0, keptBlocks: 0 };
  const captured = captureVolumeExport(store, req);
  const { report, snapshot } = captured;
  if (!captured.generated) return { ok: false, report, ...empty, ...snapshot, messages: [captured.error!] };
  let out: ExportOutcome;
  try { out = await captured.generated; }
  catch (e) { return { ok: false, report, ...empty, ...snapshot, messages: [`生成失败：${(e as Error).message}。可重试；重试会检查最新稿件。`] }; }
  const messages = [...out.messages, ...out.failures.map(f => `[${f.code}] ${f.href}${f.xpath ? ` ${f.xpath}` : ''}：${f.message}`)];
  const counts = { writtenBlocks: out.writtenBlocks, skippedBlocks: out.skippedBlocks, keptBlocks: out.keptBlocks };
  if (!out.ok || !out.data) return { ok: false, report, ...empty, ...snapshot, ...counts, messages };
  try { if (req.outputPath) await writeFile(req.outputPath, out.data); }
  catch (e) { return { ok: false, report, ...empty, ...snapshot, ...counts, messages: [...messages, `保存失败：${(e as Error).message}。请检查目录权限或文件占用后重试；重试会检查最新稿件。`] }; }
  // A log failure after committing the file must not misreport a failed delivery.
  try { store.translations.log({ level: 'success', message: `导出${req.preview ? '（预览）' : ''}完成：${req.outputPath ?? '(内存)'}，快照 ${snapshot.snapshotId}（${snapshot.snapshotAt}），写回 ${out.writtenBlocks} 块` }); }
  catch { messages.push('文件已生成，但导出日志未能保存。'); }
  return { ok: true, report, ...snapshot, outputPath: req.outputPath, ...counts, messages };
}
export { hasBlocking };
