import { createHash } from 'node:crypto';
import type { ProjectStore } from '@core/db';
import { parseTermExtract, type TermExtractOutput } from '../ai/protocol';
import { TERM_EXTRACT_PROMPT } from '../ai/prompts/termPrompts';
import { visibleNameSource } from '../validation/nameEvidence';

type Paragraph = { id: string; sourceText: string };
export const TERM_EXTRACTION_CHECKPOINT_CONTRACT = createHash('sha256')
  .update(JSON.stringify(['term-extraction-batch-v1', TERM_EXTRACT_PROMPT])).digest('hex');
const PREFIX = 'prep:term-extraction-batch:';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Provenance = { aiCallId?: string } | { exchangeId: string; sourcePath?: string; sourceHash?: string; index?: number };
export interface TermExtractionCheckpoint { raw: string; value: TermExtractOutput; provenance: Provenance }

/** A cache hit is one successful model batch, never a chapter/preparation certificate. */
function identity(store: ProjectStore, user: string, batch: readonly Paragraph[]): { key: string; signature: string } | null {
  if (!batch.length || new Set(batch.map(p => p.id)).size !== batch.length) return null;
  let input: unknown;
  try { input = JSON.parse(user); } catch { return null; }
  if (!input || typeof input !== 'object') return null;
  const data = input as { paragraphs?: unknown; existing?: unknown };
  if (!Array.isArray(data.paragraphs) || data.paragraphs.length !== batch.length
    || !Array.isArray(data.existing) || data.existing.some(value => typeof value !== 'string')) return null;
  const sources: unknown[] = [];
  let seriesId: string | undefined;
  for (const [index, p] of batch.entries()) {
    const row = store.projects.getParagraph(p.id);
    const sent = data.paragraphs[index] as { id?: unknown; source?: unknown } | null;
    if (!row || row.sourceText !== p.sourceText || !sent || sent.id !== p.id || sent.source !== visibleNameSource(p.sourceText)) return null;
    const series = store.projects.getSeriesIdOfParagraph(p.id);
    if (seriesId !== undefined && series !== seriesId) return null;
    seriesId = series;
    sources.push([series, row.chapterId, row.seriesOrdinal, row.id, row.sourceText]);
  }
  const signature = hash(JSON.stringify([TERM_EXTRACTION_CHECKPOINT_CONTRACT, user, sources]));
  return { key: PREFIX + signature, signature };
}

export function loadTermExtractionCheckpoint(store: ProjectStore, user: string, batch: readonly Paragraph[]): TermExtractionCheckpoint | null {
  const id = identity(store, user, batch); if (!id) return null;
  const row = store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [id.key]);
  if (!row) return null;
  try {
    const cached = JSON.parse(row.value) as { signature?: unknown; raw?: unknown; rawHash?: unknown; provenance?: unknown; contract?: unknown };
    if (!cached || cached.signature !== id.signature || cached.contract !== TERM_EXTRACTION_CHECKPOINT_CONTRACT
      || typeof cached.raw !== 'string' || cached.rawHash !== hash(cached.raw)) return null;
    const parsed = parseTermExtract(cached.raw, batch);
    if (!parsed.ok) return null;
    return { raw: cached.raw, value: parsed.value, provenance: cached.provenance && typeof cached.provenance === 'object' ? cached.provenance as Provenance : {} };
  } catch { return null; }
}

/** Caller supplies the actual successful raw response, not the normalized parsed value.
 * Invalid or stale input throws before any write. Existing raw evidence is never replaced.
 */
export function saveTermExtractionCheckpoint(store: ProjectStore, user: string, batch: readonly Paragraph[], raw: string,
  provenance: Provenance = {}): TermExtractionCheckpoint {
  const id = identity(store, user, batch);
  if (!id) throw new Error('术语小批原文或请求已变化，不能保存断点');
  const parsed = parseTermExtract(raw, batch);
  if (!parsed.ok) throw new Error(`术语小批未通过当前校验，不能保存断点：${parsed.error.message}`);
  const existing = loadTermExtractionCheckpoint(store, user, batch);
  if (existing) return existing;
  // Preserve corrupt/obsolete receipts rather than silently overwriting evidence.
  const previous = store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [id.key]);
  store.transaction(() => {
    if (previous) store.db.run('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)', [id.key + ':history:' + hash(previous.value), previous.value]);
    store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [id.key, JSON.stringify({ contract: TERM_EXTRACTION_CHECKPOINT_CONTRACT,
      signature: id.signature, raw, rawHash: hash(raw), provenance, savedAt: new Date().toISOString() })]);
  });
  return { raw, value: parsed.value, provenance };
}

/** Explicit recovery from a recorded successful exchange. This does not read files,
 * edit request ledgers, or certify stage completion. The caller keeps its original record.
 */
export function importTermExtractionCheckpoint(store: ProjectStore, user: string, batch: readonly Paragraph[], exchange: {
  exchangeId: string; user: string; raw: string; status: number; error?: unknown;
  sourcePath?: string; sourceHash?: string; index?: number;
}): TermExtractionCheckpoint {
  if (!exchange.exchangeId.trim() || exchange.user !== user || exchange.status !== 200
    || (exchange.error !== undefined && exchange.error !== null)) {
    throw new Error('历史术语交换记录并非匹配原请求的成功返回，不能导入断点');
  }
  return saveTermExtractionCheckpoint(store, user, batch, exchange.raw, { exchangeId: exchange.exchangeId,
    ...(exchange.sourcePath !== undefined ? { sourcePath: exchange.sourcePath } : {}),
    ...(exchange.sourceHash !== undefined ? { sourceHash: exchange.sourceHash } : {}),
    ...(exchange.index !== undefined ? { index: exchange.index } : {}) });
}
