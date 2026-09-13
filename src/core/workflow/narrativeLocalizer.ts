import {withIdentityRead} from '../db/identitySources';
import { containsVisibleQuote, visibleNameSource } from '../validation/nameEvidence';
import { createHash } from 'node:crypto';
import { narrativeSourceCurrent, type NarrativeKind } from '../db/narrativeSources';
import { buildSystemPrompt } from '../ai/prompts/systemPrompts';
import type { ProjectStore } from '@core/db';
import { AiClient } from '@core/ai';
import type { WorkflowProgress } from '@shared/types';

export interface LocalizationStats { events: number; relationships: number; skipped: number }
export interface LocalizeOptions { volumeId?: string; onProgress?: (p: WorkflowProgress) => void; signal?: AbortSignal }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const columns = (kind: NarrativeKind) => kind === 'event'
  ? { table: 'narrative_events', jp: 'summary_jp', zh: 'summary_zh', at: 'at_para' }
  : { table: 'relationships', jp: 'description_jp', zh: 'description_zh', at: 'valid_from_para' };
const receiptKey = (seriesId: string, kind: NarrativeKind, id: string) => `narrative-localization:${seriesId}:${kind}:${id}`;
interface DisplayRow { id: string; jp: string; zh: string | null; localized_at: string | null; at: number }
interface LocalizationJob extends DisplayRow { kind: NarrativeKind; glossary: Map<string, string>; input: string; receipt: string | null }

/** Only names actually sent to this display task enter its receipt. */
function buildGlossaryMap(store: ProjectStore, seriesId: string, source: string, at: number): Map<string, string> {
  return withIdentityRead(store.db, () => {
  const names = store.knowledge.charactersAt(seriesId, at).filter(c => c.canonical_name_zh && containsVisibleQuote(source, c.canonical_name_jp))
    .map(c => [c.canonical_name_jp, c.canonical_name_zh!] as const);
  const terms = store.glossary.activeTerms(seriesId).filter(t => t.term_zh && containsVisibleQuote(source, t.term_jp) && (t.lock_level === 'confirmed' || t.lock_level === 'hard-locked'))
    .map(t => [t.term_jp, t.term_zh!] as const);
  return new Map([...new Map([...names, ...terms])].sort(([a], [b]) => a.localeCompare(b)));
  });
}
function inputFingerprint(store: ProjectStore, seriesId: string, kind: NarrativeKind, row: DisplayRow, glossary: Map<string, string>): string {
  const { table, zh } = columns(kind);
  const facts = store.db.get<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id=? AND series_id=?`, [row.id, seriesId]);
  if (facts) { delete facts[zh]; delete facts.localized_at; delete facts.created_at; }
  const proof = store.db.get('SELECT source_ids,source_hash,content_hash,contract,superseded FROM narrative_provenance WHERE kind=? AND record_id=?', [kind, row.id]);
  return hash(['narrative-display-v1', buildSystemPrompt('narrative-localizer'), facts, proof, [...glossary]]);
}
function receiptOf(store: ProjectStore, seriesId: string, kind: NarrativeKind, id: string): string | null {
  return store.db.get<{value:string}>('SELECT value FROM meta WHERE key=?', [receiptKey(seriesId, kind, id)])?.value ?? null;
}
function jobsFor(store: ProjectStore, seriesId: string, kind: NarrativeKind, first = 0, last = Number.MAX_SAFE_INTEGER): LocalizationJob[] {
  const { table, jp, zh, at } = columns(kind);
  return withIdentityRead(store.db, () => store.db.all<DisplayRow>(`SELECT id,${jp} AS jp,${zh} AS zh,localized_at,${at} AS at FROM ${table} WHERE series_id=? AND ${at} BETWEEN ? AND ? ORDER BY ${at},id`, [seriesId, first, last])
    .filter(row => narrativeSourceCurrent(store.db, kind, row.id))
    .map(row => {
      const glossary = buildGlossaryMap(store, seriesId, row.jp, row.at);
      return { ...row, kind, glossary, input: inputFingerprint(store, seriesId, kind, row, glossary), receipt: receiptOf(store, seriesId, kind, row.id) };
    }).filter(row => !row.zh?.trim() || row.receipt !== JSON.stringify({ input: row.input, translation: hash(row.zh) })));
}

export async function translateWithGlossary(textJp: string, glossary: Map<string, string>, ai: AiClient, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const relevant = [...glossary].filter(([jp]) => containsVisibleQuote(textJp, jp));
  const response = await ai.structured({ workstation: 'narrative-localizer', user: JSON.stringify({ source: visibleNameSource(textJp), glossary: Object.fromEntries(relevant) }), maxOutputTokens: 2048, temperature: 0.2, parseRetries: 1, ...(signal ? { signal } : {}) }, text => {
    try {
      const result: unknown = JSON.parse(text);
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1 || !('translation' in result) || typeof result.translation !== 'string' || !result.translation.trim()) throw new Error('中文化返回缺少有效译文，原记录保留待重试');
      return { ok: true as const, value: result.translation.trim() };
    } catch { return { ok: false as const, error: { code: 'INVALID_SHAPE' as const, message: '中文化返回缺少有效译文，原记录保留待重试' } }; }
  });
  signal?.throwIfAborted();
  return response.value;
}

/** Existing Chinese is a derivative, not a completion flag. Missing/obsolete receipts
 * requeue it; failures keep the old text and Japanese facts intact for a later retry. */
export async function localizeNarrativeData(store: ProjectStore, ai: AiClient, seriesId: string, opts: LocalizeOptions = {}): Promise<LocalizationStats> {
  const stats: LocalizationStats = { events: 0, relationships: 0, skipped: 0 };
  const progress: WorkflowProgress = { running: true, paused: false, phase: '中文化预读数据', done: 0, total: 0, currentParagraphId: null, costUsd: 0, inputTokens: 0, outputTokens: 0, message: '准备中文化...' };
  const emit = (patch: Partial<WorkflowProgress>) => {
    Object.assign(progress, patch, { costUsd: ai.totals.costUsd, inputTokens: ai.totals.inputTokens, outputTokens: ai.totals.outputTokens });
    opts.onProgress?.({ ...progress });
  };
  const check = () => { if (opts.signal?.aborted) throw new Error('已取消'); };
  try {
    check();
    let first = 0, last = Number.MAX_SAFE_INTEGER;
    if (opts.volumeId) {
      if (store.projects.getVolumeSeriesId(opts.volumeId) !== seriesId) throw new Error('中文化册次不属于当前系列');
      const ids = store.projects.listParagraphIdsByVolume(opts.volumeId);
      if (!ids.length) return stats;
      first = store.projects.getParagraph(ids[0]!)!.seriesOrdinal;
      last = store.projects.getParagraph(ids[ids.length - 1]!)!.seriesOrdinal;
    }
    const jobs = withIdentityRead(store.db, () => [...jobsFor(store, seriesId, 'event', first, last), ...jobsFor(store, seriesId, 'relationship', first, last)]);
    emit({ total: jobs.length, message: `需要中文化：${jobs.length} 项（含已过期展示）` });
    for (const job of jobs) {
      check();
      // A prior await may have changed this queued job; never overwrite the fresh value.
      const stillPending = () => jobsFor(store, seriesId, job.kind, job.at, job.at).some(r => r.id === job.id && r.input === job.input && r.zh === job.zh && r.localized_at === job.localized_at && r.receipt === job.receipt);
      if (!stillPending()) { stats.skipped++; progress.done++; emit({ message: '记录已变化，等待重新中文化' }); continue; }
      const translated = await translateWithGlossary(job.jp, job.glossary, ai, opts.signal);
      check();
      if (JSON.stringify([...buildGlossaryMap(store, seriesId, job.jp, job.at)]) !== JSON.stringify([...job.glossary])) throw new Error('中文化期间相关译名已变化，保留原记录待重试');
      const saved = store.db.transaction(() => {
        if (!stillPending()) return false;
        const { table, jp, zh } = columns(job.kind);
        const result = store.db.run(`UPDATE ${table} SET ${zh}=?,localized_at=datetime('now') WHERE id=? AND series_id=? AND ${jp}=? AND ${zh} IS ? AND localized_at IS ?`, [translated, job.id, seriesId, job.jp, job.zh, job.localized_at]);
        if (!result.changes) return false;
        store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [receiptKey(seriesId, job.kind, job.id), JSON.stringify({ input: job.input, translation: hash(translated) })]);
        return true;
      });
      if (saved) { if (job.kind === 'event') stats.events++; else stats.relationships++; }
      else stats.skipped++;
      progress.done++;
      emit({ message: saved ? `中文化进度：${progress.done}/${progress.total}` : '记录已变化，旧中文化结果未覆盖' });
    }
    store.translations.log({ level: 'info', workstationId: 'narrative-localizer', message: `中文化完成：${stats.events}个事件，${stats.relationships}个关系；${stats.skipped}项因记录变化未覆盖` });
    emit({ running: false, phase: 'idle', message: `中文化完成：${stats.events}个事件，${stats.relationships}个关系` });
  } catch (e) {
    const error = e as Error;
    store.translations.log({ level: 'error', workstationId: 'narrative-localizer', message: `中文化失败：${error.message}` });
    emit({ running: false, phase: 'idle', message: error.message.includes('已取消') ? '已停止' : `中文化失败：${error.message}` });
    throw e;
  }
  return stats;
}

export function checkLocalizationStatus(store: ProjectStore, seriesId: string): {
  needsLocalization: boolean; canLocalize: boolean; unlocalizedEvents: number; unlocalizedRelationships: number; confirmedTerms: number;
} {
  return withIdentityRead(store.db, () => {
  const unlocalizedEvents = jobsFor(store, seriesId, 'event').length;
  const unlocalizedRelationships = jobsFor(store, seriesId, 'relationship').length;
  const confirmedTerms = store.db.get<{n:number}>("SELECT COUNT(*) AS n FROM terms WHERE series_id=? AND lock_level IN ('confirmed','hard-locked') AND term_zh IS NOT NULL", [seriesId])?.n ?? 0;
  const pending = unlocalizedEvents > 0 || unlocalizedRelationships > 0;
  return { needsLocalization: pending, canLocalize: pending, unlocalizedEvents, unlocalizedRelationships, confirmedTerms };
  });
}
