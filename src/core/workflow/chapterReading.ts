import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ProjectStore } from '@core/db';
import { fromJson, nowIso } from '@core/db';
import type { AiClient, ProtocolResult } from '@core/ai';
import { AUDIT_VERSION, auditInput } from './auditReceipts';
import { CHAPTER_READING_PROMPT } from '../ai/prompts/chapterReadingPrompt';
import { chapterRequest, splitChapterPair, type ChapterPassage } from './chapterReadingPlan';
import { LONG_NATURALNESS_CONTRACT, LONG_READING_CHUNK_LIMIT, LONG_READING_MAX_CHUNKS } from './longNaturalnessPlan';
import { PROMPT_VERSION } from '../ai/prompts/systemPrompts';
import { systemPromptFor } from '../ai/prompts/systemPrompts';
import { parseDispute } from './disputeReview';

export const CHAPTER_READING_LIMIT = 16000;
const workstation = 'chapter-reading-reviewer' as const;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contract = digest(['chapter-reading-v2-full-source-chunks', LONG_NATURALNESS_CONTRACT, LONG_READING_CHUNK_LIMIT, LONG_READING_MAX_CHUNKS, CHAPTER_READING_PROMPT, AUDIT_VERSION, CHAPTER_READING_LIMIT]);
const taskId = (window: ChapterReadingWindow) => `chapter-reading:${digest([window.key, window.hash])}`;
type Passage = ChapterPassage;
const windowHash = (scope: string, items: Passage[]) => digest([contract, scope, items, chapterRequest(items)]);
export interface ChapterReadingWindow { key: string; hash: string; items: Passage[]; scope: string; user: string; supported: boolean }
const schema = z.object({
  reviewed_ids: z.array(z.string()),
  findings: z.array(z.object({
    block_id: z.string(), type: z.enum(['transition', 'repetition', 'rhythm', 'voice', 'uncertain']),
    description: z.string().trim().min(1).max(1200), source_task: z.string().trim().min(1).max(1200),
    evidence: z.array(z.object({ id: z.string(), jp: z.string().trim().min(1), zh: z.string().trim().min(1) }).strict()).min(1).max(2),
  }).strict()).max(12),
}).strict();
export type ChapterReadingVerdict = z.infer<typeof schema>;
type Verdict = ChapterReadingVerdict;
interface Receipt { contract: string; hash: string; aiCallId: string; verdict: Verdict; checkedAt: string }
export const CHAPTER_DISPOSITION_INSTRUCTION = '独立核对相邻日文与当前中文。原作已有的重复、停顿、残句、含混、声线或节奏必须保留，不能仅因不流畅要求改写。retain仅用于具体原文和上下文证明当前表达应保留；revise须指出译文引入的具体问题与局部方向；证据不足返回uncertain。诊断不是事实。只引用当前目标source/translation，邻段用于语境核对。';
export const CHAPTER_RECOVERY_CONTRACT = digest(['chapter-recovery-v1', contract, CHAPTER_DISPOSITION_INSTRUCTION, systemPromptFor('dispute-reviewer'), systemPromptFor('faithful-translator'), systemPromptFor('repair-resolution-reviewer')]);
export type ChapterDisposition = { aiCallId: string; verdict: Extract<ReturnType<typeof parseDispute>, { ok: true }>['value'] };
export const chapterDispositionTask = (window: ChapterReadingWindow, receipt: Receipt, index: number) => `chapter-disposition:${digest([CHAPTER_RECOVERY_CONTRACT, window.hash, receipt.aiCallId, receipt.verdict, index])}`;

/** A dismissed display row is never evidence. Retention requires one current,
 * independently checked, source-bound disposition for every original finding. */
export function chapterReadingRetained(store: ProjectStore, window: ChapterReadingWindow, receipt: Receipt): boolean {
  const saved = fromJson<{ contract?: string; hash?: string; receiptId?: string; checks?: ChapterDisposition[] } | null>(storedValue(store, `${window.key}:retained`), null);
  if (!receipt.verdict.findings.length || !saved || saved.contract !== CHAPTER_RECOVERY_CONTRACT || saved.hash !== window.hash || saved.receiptId !== receipt.aiCallId || !Array.isArray(saved.checks) || saved.checks.length !== receipt.verdict.findings.length) return false;
  return saved.checks.every((check, index) => {
    const finding = receipt.verdict.findings[index]!, passage = window.items.find(p => p.id === finding.block_id)!;
    const parsed = parseDispute(JSON.stringify(check?.verdict), passage.source, passage.translation);
    return parsed.ok && parsed.value.decision === 'retain' && !!store.db.get("SELECT id FROM ai_calls WHERE id=? AND task_id=? AND workstation_id='dispute-reviewer' AND paragraph_id=? AND prompt_version=? AND finish_reason='stop' AND error IS NULL", [check.aiCallId, chapterDispositionTask(window, receipt, index), passage.id, PROMPT_VERSION]);
  });
}

export function retainChapterReading(store: ProjectStore, window: ChapterReadingWindow, receipt: Receipt, checks: ChapterDisposition[]): void {
  store.transaction(() => {
    const paragraph = store.projects.getParagraph(window.items[0]!.id);
    const volume = paragraph && store.db.get<{ volume_id: string }>('SELECT volume_id FROM chapters WHERE id=?', [paragraph.chapterId]);
    if (!volume || !chapterReadingWindows(store, volume.volume_id).some(w => w.key === window.key && w.hash === window.hash) || JSON.stringify(chapterReadingReceipt(store, window)) !== JSON.stringify(receipt)) throw new Error('章级问题回执或原译文已变化，旧复核不采纳');
    store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [`${window.key}:retained`, JSON.stringify({ contract: CHAPTER_RECOVERY_CONTRACT, hash: window.hash, receiptId: receipt.aiCallId, checks, checkedAt: nowIso() })]);
    if (!chapterReadingRetained(store, window, receipt)) throw new Error('章级保留决定缺少完整当前复核证据');
  });
}

/** Every paragraph and every adjacent seam is covered. Long pairs use full-source
 * Chinese chunks only when all complete chunk and edge requests fit the limit. */
export function chapterReadingWindows(store: ProjectStore, volumeId: string, fingerprint = true, overrides: ReadonlyMap<string, { id: string; final_text: string; ruby_annotations: string | null }> = new Map()): ChapterReadingWindow[] {
  const ids = store.projects.listParagraphIdsByVolume(volumeId);
  const finals = store.translations.finalsForParagraphs(ids);
  const chapters = new Map<string, Passage[]>();
  for (const id of ids) {
    const p = store.projects.getParagraph(id)!;
    const final = overrides.get(id) ?? finals.get(id);
    const items = chapters.get(p.chapterId) ?? [];
    items.push({ id, chapter: p.chapterId, source: p.sourceText, translation: final?.final_text ?? '', finalId: final?.id ?? null, ruby: final?.ruby_annotations ?? null, inputHash: fingerprint ? auditInput(store, id).inputHash : '' });
    chapters.set(p.chapterId, items);
  }
  const windows: ChapterReadingWindow[] = [];
  for (const [chapter, passages] of chapters) {
    const scope = digest([chapter, passages.map(p => p.id)]);
    const seenParagraphTasks = new Set<string>();
    for (let i = 0; i < Math.max(1, passages.length - 1); i++) {
      const items = passages.slice(i, i + 2);
      const user = chapterRequest(items);
      const key = `chapter-reading:${volumeId}:${chapter}:${items[0]!.id}`;
      const split = user.length > CHAPTER_READING_LIMIT ? splitChapterPair(items, CHAPTER_READING_LIMIT) : null;
      if (split) for (const task of split) {
        // Validate the entire original pair before deduplicating. Internal tasks
        // depend only on their paragraph; the pair's own seam is always retained.
        const singleParagraph = task.items.length === 1;
        const taskKey = singleParagraph ? `chapter-reading:${volumeId}:${chapter}:${task.items[0]!.id}:${task.suffix}` : `${key}:${task.suffix}`;
        if (singleParagraph && seenParagraphTasks.has(taskKey)) continue;
        if (singleParagraph) seenParagraphTasks.add(taskKey);
        windows.push({ key: taskKey, hash: windowHash(scope, task.items), items: task.items, scope, user: task.user, supported: true });
      }
      else windows.push({ key, hash: windowHash(scope, items), items, scope, user, supported: user.length <= CHAPTER_READING_LIMIT });
    }
  }
  return windows;
}

export function parseChapterReading(text: string, window: ChapterReadingWindow): ProtocolResult<Verdict> {
  try {
    const verdict = schema.parse(JSON.parse(text));
    if (JSON.stringify(verdict.reviewed_ids) !== JSON.stringify(window.items.map(p => p.id))) throw new Error('章级连读缺少完整有序逐段回执');
    for (const finding of verdict.findings) {
      if (!window.items.some(p => p.id === finding.block_id) || !finding.evidence.some(e => e.id === finding.block_id) || new Set(finding.evidence.map(e => e.id)).size !== window.items.length) throw new Error('章级问题须定位当前段并引用完整相邻窗口');
      for (const e of finding.evidence) {
        const p = window.items.find(p => p.id === e.id);
        if (!p || !p.source.includes(e.jp) || !p.translation.includes(e.zh)) throw new Error('连读原译引文不属于当前窗口');
      }
    }
    return { ok: true, value: verdict };
  } catch (error) { return { ok: false, error: { code: 'INVALID_SHAPE', message: (error as Error).message } }; }
}

function storedValue(store: ProjectStore, key: string): string | null {
  return store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [key])?.value ?? null;
}
export function chapterReadingReceipt(store: ProjectStore, window: ChapterReadingWindow): Receipt | null {
  const receipt = fromJson<Receipt | null>(storedValue(store, window.key), null);
  if (!window.supported || window.items.some(p => !p.finalId || !p.translation.trim()) || !receipt || receipt.contract !== contract || receipt.hash !== window.hash || typeof receipt.aiCallId !== 'string' || typeof receipt.checkedAt !== 'string') return null;
  if (!parseChapterReading(JSON.stringify(receipt.verdict), window).ok || !store.db.get("SELECT id FROM ai_calls WHERE id=? AND workstation_id=? AND task_id=? AND prompt_version=? AND finish_reason='stop' AND error IS NULL", [receipt.aiCallId, workstation, taskId(window), PROMPT_VERSION])) return null;
  return receipt;
}

export function chapterReadingStatus(store: ProjectStore, volumeId: string) {
  const missing: string[] = [], stale: string[] = [], issues: string[] = [], unsupported: string[] = [];
  const hashes = new Map<string, string>();
  for (const pending of chapterReadingWindows(store, volumeId, false)) {
    const id = pending.items[0]!.id;
    if (!pending.supported) { unsupported.push(id); continue; }
    if (!storedValue(store, pending.key)) { missing.push(id); continue; }
    const items = pending.items.map(p => {
      if (!hashes.has(p.id)) hashes.set(p.id, auditInput(store, p.id).inputHash);
      return { ...p, inputHash: hashes.get(p.id)! };
    });
    const receipt = chapterReadingReceipt(store, { ...pending, items, hash: windowHash(pending.scope, items) });
    if (!receipt) stale.push(id);
    else if (!chapterReadingRetained(store, { ...pending, items, hash: windowHash(pending.scope, items) }, receipt)) issues.push(...receipt.verdict.findings.map(f => f.block_id));
  }
  return { missing, stale, issues: [...new Set(issues)], unsupported };
}

/** Invoked only by an explicit volume run/recheck, never on startup or export.
 * Receipts, unlike diagnostic display rows, cannot be cleared by local reverify. */
export async function reviewChapterReading(store: ProjectStore, ai: AiClient, volumeId: string, signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<void> {
  const windows = chapterReadingWindows(store, volumeId);
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  for (const [index, window] of windows.entries()) {
    signal?.throwIfAborted();
    onProgress?.(index, windows.length);
    signal?.throwIfAborted();
    const current = () => {
      const chapter = window.items[0]!.chapter;
      const ids = store.projects.listParagraphIdsByChapter(chapter);
      return !!store.db.get('SELECT id FROM chapters WHERE id=? AND volume_id=?', [chapter, volumeId]) && digest([chapter, ids]) === window.scope && window.items.every(p => {
        const paragraph = store.projects.getParagraph(p.id), final = store.translations.latestFinal(p.id);
        return paragraph?.sourceText === p.source && paragraph.chapterId === p.chapter && final?.id === p.finalId && final.final_text === (p.fullTranslation ?? p.translation) && final.ruby_annotations === p.ruby && auditInput(store, p.id).inputHash === p.inputHash;
      });
    };
    if (!window.supported) throw new Error(`章级连读窗口超出 ${CHAPTER_READING_LIMIT} 字符边界：${window.items.map(p => p.id).join('、')}；保留全文，需明确分段后重新核查，未覆盖窗口不会放行`);
    if (window.items.some(p => !p.finalId || !p.translation.trim())) throw new Error('章级连读需要完整当前译稿');
    if (!current()) throw new Error('章级连读原文、稿件、知识或章内顺序已变化，请显式重新核查');
    const existing = chapterReadingReceipt(store, window);
    if (existing && (!existing.verdict.findings.length || chapterReadingRetained(store, window, existing))) continue;
    const baseReceipt = storedValue(store, window.key);
    const result = await ai.structured({ workstation, taskId: taskId(window), paragraphId: window.items[0]!.id, user: window.user, parseRetries: 1, ...(signal ? { signal } : {}) }, text => parseChapterReading(text, window));
    signal?.throwIfAborted();
    if (!current() || storedValue(store, window.key) !== baseReceipt) throw new Error('章级连读期间依据或已有结论已变化，迟到结论不保存，请显式重新核查');
    store.transaction(() => {
      // Display-only warnings deliberately cannot enter the local automatic repair path.
      // The receipt's unresolved verdict remains a mandatory quality-gate blocker.
      for (const q of store.translations.listQueue(seriesId)) if (q.payload.type === 'CHAPTER_READING' && q.payload.windowKey === window.key) store.translations.resolveQueueItem(q.id, JSON.stringify({ action: 'chapter-reading-rechecked' }));
      for (const f of result.value.findings) store.translations.enqueue({ seriesId, paragraphId: f.block_id, kind: 'warning', title: `章级连读待核查：${f.description.slice(0, 60)}`, payload: { type: 'CHAPTER_READING', windowKey: window.key, inputHash: window.hash, sourceTask: f.source_task, description: f.description, issueType: f.type, evidence: f.evidence } });
      store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [window.key, JSON.stringify({ contract, hash: window.hash, aiCallId: result.aiCallId, verdict: result.value, checkedAt: nowIso() } satisfies Receipt)]);
    });
  }
  signal?.throwIfAborted();
  onProgress?.(windows.length, windows.length);
}
