import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ProjectStore } from '@core/db';
import { fromJson, nowIso } from '@core/db';
import type { AiClient, ProtocolResult } from '@core/ai';
import { auditInput } from './auditReceipts';
import { TRAJECTORY_PROMPT } from '../ai/prompts/trajectoryPrompt';

interface Passage { id: string; chapter: string; source: string; translation: string; finalId: string | null; inputHash: string }
export interface TrajectoryBatch { key: string; hash: string; items: Passage[]; anchors: Passage[] }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const verdictSchema = z.object({
  reviewed_ids: z.array(z.string()),
  findings: z.array(z.object({ block_id: z.string(), type: z.enum(['term_drift', 'address_drift', 'voice_drift', 'continuity', 'uncertain']), description: z.string().trim().min(1),
    evidence: z.array(z.object({ id: z.string(), jp: z.string().min(1), zh: z.string().min(1) }).strict()).min(2),
  }).strict()),
}).strict();
type Verdict = z.infer<typeof verdictSchema>;
interface Receipt { hash: string; aiCallId: string; verdict: Verdict; checkedAt: string }

/** All prose is covered; prior entity occurrences and chapter seams provide bounded comparison spans. */
function buildTrajectoryBatches(store: ProjectStore, volumeId: string, overrides: ReadonlyMap<string, string>, inputHashFor: (id: string) => string): TrajectoryBatch[] {
  const ids = store.projects.listParagraphIdsByVolume(volumeId);
  if (ids.length < 2) return [];
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const finals = store.translations.finalsForParagraphs(ids);
  const passages: Passage[] = ids.map(id => {
    const p = store.projects.getParagraph(id)!;
    const final = finals.get(id);
    return { id, chapter: p.chapterId, source: p.sourceText, translation: overrides.get(id) ?? final?.final_text ?? '', finalId: final?.id ?? null, inputHash: inputHashFor(id) };
  });
  const entities = [...new Set([...store.knowledge.listCharacters(seriesId).map(c => c.canonical_name_jp), ...store.glossary.activeTerms(seriesId).map(t => t.term_jp)])].filter(Boolean);
  const first = new Map<string, Passage>(), recent = new Map<string, Passage>();
  const batches: TrajectoryBatch[] = [];
  for (let start = 0; start < passages.length;) {
    const items: Passage[] = []; let chars = 0;
    while (start + items.length < passages.length && items.length < 4) {
      const p = passages[start + items.length]!;
      const length = p.source.length + p.translation.length;
      if (items.length && (chars + length > 6000 || p.chapter !== items[0]!.chapter)) break;
      items.push(p); chars += length;
    }
    const anchors: Passage[] = passages.slice(Math.max(0, start - 2), start);
    const selected = new Set(anchors.map(p => p.id));
    let anchorChars = anchors.reduce((n, p) => n + p.source.length + p.translation.length, 0);
    for (const entity of entities.filter(e => items.some(p => p.source.includes(e)))) {
      for (const p of [first.get(entity), recent.get(entity)]) {
        if (!p || selected.has(p.id) || anchors.length >= 6 || anchorChars + p.source.length + p.translation.length > 6000) continue;
        anchors.push(p); selected.add(p.id); anchorChars += p.source.length + p.translation.length;
      }
    }
    // A singleton first chapter still needs a real comparison. The next source is audit context only.
    if (items.length === 1 && !anchors.length && passages[start + 1]) anchors.push(passages[start + 1]!);
    const key = `trajectory:${volumeId}:${items[0]!.id}`;
    batches.push({ key, hash: digest([TRAJECTORY_PROMPT, items, anchors]), items, anchors });
    for (const p of items) for (const entity of entities) if (p.source.includes(entity)) { if (!first.has(entity)) first.set(entity, p); recent.set(entity, p); }
    start += items.length;
  }
  return batches;
}

export function trajectoryBatches(store: ProjectStore, volumeId: string, overrides: ReadonlyMap<string, string> = new Map()): TrajectoryBatch[] {
  return buildTrajectoryBatches(store, volumeId, overrides, id => auditInput(store, id).inputHash);
}

export function parseTrajectory(text: string, batch: TrajectoryBatch): ProtocolResult<Verdict> {
  try {
    const verdict = verdictSchema.parse(JSON.parse(text));
    const expected = new Set(batch.items.map(p => p.id));
    if (verdict.reviewed_ids.length !== expected.size || new Set(verdict.reviewed_ids).size !== expected.size || verdict.reviewed_ids.some(id => !expected.has(id))) throw new Error('轨迹审核缺少完整逐段回执');
    const passages = new Map([...batch.items, ...batch.anchors].map(p => [p.id, p]));
    for (const f of verdict.findings) {
      if (!expected.has(f.block_id) || new Set(f.evidence.map(e => e.id)).size < 2 || !f.evidence.some(e => e.id === f.block_id)) throw new Error('轨迹问题必须定位本次段落并引用至少两段证据');
      for (const e of f.evidence) {
        const p = passages.get(e.id);
        if (!p || !e.jp.trim() || !e.zh.trim() || !p.source.includes(e.jp) || !p.translation.includes(e.zh)) throw new Error('轨迹引文不属于本次原文和当前译稿');
      }
    }
    return { ok: true, value: verdict };
  } catch (e) { return { ok: false, error: { code: 'INVALID_SHAPE', message: (e as Error).message } }; }
}

export function trajectoryReceipt(store: ProjectStore, batch: TrajectoryBatch): Receipt | null {
  const row = store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [batch.key]);
  const receipt = fromJson<Receipt | null>(row?.value ?? null, null);
  if (!receipt || receipt.hash !== batch.hash || !store.db.get("SELECT id FROM ai_calls WHERE id=? AND workstation_id='trajectory-reviewer' AND error IS NULL", [receipt.aiCallId])) return null;
  if (!parseTrajectory(JSON.stringify(receipt.verdict), batch).ok) return null;
  return receipt;
}

export function trajectoryStatus(store: ProjectStore, volumeId: string): { missing: string[]; issues: string[] } {
  const missing: string[] = [], issues: string[] = [];
  // A missing receipt cannot be valid, regardless of its source fingerprint.
  // Build the same structural batches first and fingerprint only existing receipts.
  // This cache is confined to one synchronous read; no result survives a mutation.
  const hashes = new Map<string, string>();
  const hydrate = (p: Passage): Passage => {
    if (!hashes.has(p.id)) hashes.set(p.id, auditInput(store, p.id).inputHash);
    return { ...p, inputHash: hashes.get(p.id)! };
  };
  for (const pending of buildTrajectoryBatches(store, volumeId, new Map(), () => '')) {
    if (!store.db.get('SELECT key FROM meta WHERE key=?', [pending.key])) { missing.push(pending.items[0]!.id); continue; }
    const items = pending.items.map(hydrate), anchors = pending.anchors.map(hydrate);
    const batch = { ...pending, items, anchors, hash: digest([TRAJECTORY_PROMPT, items, anchors]) };
    const receipt = trajectoryReceipt(store, batch);
    if (!receipt) missing.push(batch.items[0]!.id);
    else issues.push(...receipt.verdict.findings.map(f => f.block_id));
  }
  return { missing, issues: [...new Set(issues)] };
}

export async function reviewVolumeTrajectory(store: ProjectStore, ai: AiClient, volumeId: string, signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<void> {
  const batches = trajectoryBatches(store, volumeId);
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  for (const [index, batch] of batches.entries()) {
    signal?.throwIfAborted();
    onProgress?.(index, batches.length);
    if (trajectoryReceipt(store, batch)?.verdict.findings.length === 0) continue;
    if ([...batch.items, ...batch.anchors].some(p => !p.finalId || !p.translation.trim())) throw new Error('轨迹审核需要相关段落都有当前译稿');
    const current = () => [...batch.items, ...batch.anchors].every(p => {
      const paragraph = store.projects.getParagraph(p.id), final = store.translations.latestFinal(p.id);
      return paragraph?.sourceText === p.source && paragraph.chapterId === p.chapter && final?.id === p.finalId && final.final_text === p.translation && auditInput(store, p.id).inputHash === p.inputHash;
    });
    if (!current()) throw new Error('轨迹审核期间稿件或知识已变化，请继续任务重试');
    const prose = (p: Passage) => ({ id: p.id, chapter: p.chapter, source: p.source, translation: p.translation });
    const result = await ai.structured({ workstation: 'trajectory-reviewer', user: JSON.stringify({ items: batch.items.map(prose), anchors: batch.anchors.map(prose) }), paragraphId: batch.items[0]!.id, ...(signal ? { signal } : {}), parseRetries: 1 }, text => parseTrajectory(text, batch));
    signal?.throwIfAborted();
    if (!current()) throw new Error('轨迹审核期间稿件或知识已变化，本次结论不保存');
    store.transaction(() => {
      for (const p of batch.items) {
        for (const f of store.translations.openFindings(p.id)) if (f.workstation_id === 'trajectory-reviewer') store.translations.resolveFinding(f.id);
        for (const q of store.translations.listQueue(seriesId)) if (q.paragraphId === p.id && q.payload.type === 'TRAJECTORY') store.translations.resolveQueueItem(q.id, JSON.stringify({ action: 'trajectory-rechecked' }));
      }
      for (const f of result.value.findings) {
        const p = batch.items.find(p => p.id === f.block_id)!;
        store.translations.addFinding({ paragraphId: p.id, workstationId: 'trajectory-reviewer', findingType: `TRAJECTORY:${f.type}`, severity: 'blocks_export', description: f.description, evidenceJp: f.evidence.map(e => `${e.id}: ${e.jp}`).join('\n'), evidenceZh: f.evidence.map(e => `${e.id}: ${e.zh}`).join('\n'), aiCallId: result.aiCallId });
        store.translations.enqueue({ seriesId, paragraphId: p.id, kind: 'review-block', title: `跨章核查：${f.description.slice(0, 65)}`, payload: { type: 'TRAJECTORY', source: p.source, translation: p.translation, description: f.description, evidence: f.evidence, batchHash: batch.hash } });
      }
      store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [batch.key, JSON.stringify({ hash: batch.hash, aiCallId: result.aiCallId, verdict: result.value, checkedAt: nowIso() } satisfies Receipt)]);
    });
  }
  onProgress?.(batches.length, batches.length);
}
