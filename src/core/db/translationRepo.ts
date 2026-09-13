import { Db, newId, nowIso, fromJson, toJson } from './database';
import type { WorkstationId, ReviewKind, ReviewItemView, ActivityLogEntry, ValidationFinding } from '@shared/types';

export interface CandidateRow { id: string; paragraph_id: string; workstation_id: WorkstationId; candidate_text: string; source_coverage: string | null; tone_axes: string | null; flags: string | null; ai_call_id: string | null; created_at: string }
export interface FinalRow { id: string; paragraph_id: string; final_text: string; ruby_annotations: string | null; source_candidate_id: string | null; auto_accepted: number; confirmed_by_user: number; confirmed_at: string | null; version: number }
export interface FindingInput { paragraphId: string; workstationId: WorkstationId | 'program-check'; findingType: string; severity: 'blocks_export' | 'warning' | 'info'; description: string; evidenceJp?: string | null; evidenceZh?: string | null; suggestedFix?: string | null; aiCallId?: string | null }
export interface RubyAnnotation { start: number; end: number; rt: string; kind: 'first-person' | 'proper-noun' }

export const REVIEW_PRIORITY: Record<ReviewKind, number> = {
  failed: 0, 'lock-conflict': 1, 'review-block': 2, 'honorific-first': 3, 'quirk-candidate': 4,
  'gender-plural': 5, 'term-proposal': 6, wordplay: 7, ambiguity: 8, 'glossary-deviation': 9, 'stale-knowledge': 10, warning: 11,
};

/** 候选 / 最终稿 / 审校发现 / 回查 / 复核队列 / 双关 / 日志 / AI 调用 */
export class TranslationRepo {
  constructor(private readonly db: Db) {}

  addCandidate(c: { paragraphId: string; workstationId: WorkstationId; text: string; sourceCoverage?: unknown; toneAxes?: unknown; flags?: unknown; aiCallId?: string | null }): string {
    const id = newId();
    this.db.run('INSERT INTO translation_candidates(id,paragraph_id,workstation_id,candidate_text,source_coverage,tone_axes,flags,ai_call_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [id, c.paragraphId, c.workstationId, c.text, toJson(c.sourceCoverage), toJson(c.toneAxes), toJson(c.flags), c.aiCallId ?? null, nowIso()]);
    return id;
  }
  latestCandidate(paragraphId: string, workstationId?: WorkstationId): CandidateRow | undefined {
    return workstationId
      ? this.db.get<CandidateRow>('SELECT * FROM translation_candidates WHERE paragraph_id=? AND workstation_id=? ORDER BY created_at DESC LIMIT 1', [paragraphId, workstationId])
      : this.db.get<CandidateRow>('SELECT * FROM translation_candidates WHERE paragraph_id=? ORDER BY created_at DESC LIMIT 1', [paragraphId]);
  }

  latestFinal(paragraphId: string): FinalRow | undefined {
    return this.db.get<FinalRow>('SELECT * FROM translation_finals WHERE paragraph_id=? ORDER BY version DESC LIMIT 1', [paragraphId]);
  }
  candidateById(id: string): CandidateRow | undefined {
    return this.db.get<CandidateRow>('SELECT * FROM translation_candidates WHERE id=?', [id]);
  }
  setFinal(f: { paragraphId: string; text: string; ruby?: RubyAnnotation[]; sourceCandidateId?: string | null; autoAccepted?: boolean; confirmedByUser?: boolean }): string {
    const prev = this.latestFinal(f.paragraphId);
    const id = newId();
    const confirmed = f.confirmedByUser ? 1 : 0;
    this.db.run('INSERT INTO translation_finals(id,paragraph_id,final_text,ruby_annotations,source_candidate_id,auto_accepted,confirmed_by_user,confirmed_at,version) VALUES(?,?,?,?,?,?,?,?,?)',
      [id, f.paragraphId, f.text, toJson(f.ruby ?? []), f.sourceCandidateId ?? null, f.autoAccepted ? 1 : 0, confirmed, confirmed ? nowIso() : null, (prev?.version ?? 0) + 1]);
    return id;
  }
  confirmFinal(paragraphId: string): void {
    const f = this.latestFinal(paragraphId); if (!f) return;
    this.db.run('UPDATE translation_finals SET confirmed_by_user=1, auto_accepted=0, confirmed_at=? WHERE id=?', [nowIso(), f.id]);
  }
  unconfirmFinal(paragraphId: string): void {
    const f = this.latestFinal(paragraphId); if (!f) return;
    this.db.run('UPDATE translation_finals SET confirmed_by_user=0, auto_accepted=0, confirmed_at=NULL WHERE id=?', [f.id]);
  }
  rubyOf(f: FinalRow): RubyAnnotation[] { return fromJson<RubyAnnotation[]>(f.ruby_annotations, []); }
  /** 该角色的发言是否已经出现过一人称 ruby（用于“仅首次与转变处加注”） */
  firstPersonRubyExists(speakerCharId: string, beforeSeriesOrdinal: number): boolean {
    return !!this.db.get(`SELECT 1 FROM translation_finals f JOIN paragraph_analysis a ON a.paragraph_id=f.paragraph_id JOIN paragraphs p ON p.id=f.paragraph_id
      WHERE a.speaker_char_id=? AND p.series_ordinal<? AND f.ruby_annotations LIKE '%first-person%' LIMIT 1`, [speakerCharId, beforeSeriesOrdinal]);
  }
  finalsForParagraphs(paragraphIds: string[]): Map<string, FinalRow> {
    const out = new Map<string, FinalRow>();
    for (let i = 0; i < paragraphIds.length; i += 500) {
      const chunk = paragraphIds.slice(i, i + 500);
      const rows = this.db.all<FinalRow>(`SELECT f.* FROM translation_finals f WHERE f.paragraph_id IN (${chunk.map(() => '?').join(',')}) AND f.version=(SELECT MAX(version) FROM translation_finals WHERE paragraph_id=f.paragraph_id)`, chunk);
      for (const r of rows) out.set(r.paragraph_id, r);
    }
    return out;
  }

  /** Preserve validated review quotes on every candidate verification save path. */
  addValidationFinding(paragraphId: string, finding: ValidationFinding): string {
    const value = (key: string): string | null => typeof finding.details?.[key] === 'string' ? finding.details[key] as string : null;
    return this.addFinding({ paragraphId, workstationId: 'program-check', findingType: finding.code,
      severity: finding.severity, description: finding.message,
      evidenceJp: value('evidence_jp'), evidenceZh: value('evidence_zh'), aiCallId: value('aiCallId') });
  }
  addFinding(f: FindingInput): string {
    const id = newId();
    this.db.run('INSERT INTO review_findings(id,paragraph_id,workstation_id,finding_type,severity,description,evidence_jp,evidence_zh,suggested_fix,ai_call_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [id, f.paragraphId, f.workstationId, f.findingType, f.severity, f.description, f.evidenceJp ?? null, f.evidenceZh ?? null, f.suggestedFix ?? null, f.aiCallId ?? null, nowIso()]);
    return id;
  }
  openFindings(paragraphId: string): { id: string; workstation_id: string; finding_type: string; severity: string; description: string; evidence_jp: string | null; evidence_zh: string | null; suggested_fix: string | null }[] {
    return this.db.all('SELECT id, workstation_id, finding_type, severity, description, evidence_jp, evidence_zh, suggested_fix FROM review_findings WHERE paragraph_id=? AND resolved=0 ORDER BY created_at', [paragraphId]);
  }
  resolveFindings(paragraphId: string): void { this.db.run('UPDATE review_findings SET resolved=1 WHERE paragraph_id=?', [paragraphId]); }
  resolveFinding(id: string): void { this.db.run('UPDATE review_findings SET resolved=1 WHERE id=?', [id]); }
  blockingFindingSummary(paragraphIds: string[]): { code: string; count: number; sample: string[] }[] {
    const acc = new Map<string, { count: number; sample: string[] }>();
    for (let i = 0; i < paragraphIds.length; i += 500) {
      const chunk = paragraphIds.slice(i, i + 500);
      // The overview locates paragraphs, not repeated audit observations. Keep
      // every observation in history without multiplying the same location.
      for (const r of this.db.all<{ finding_type: string; paragraph_id: string }>(`SELECT DISTINCT finding_type, paragraph_id FROM review_findings WHERE resolved=0 AND severity='blocks_export' AND paragraph_id IN (${chunk.map(() => '?').join(',')})`, chunk)) {
        const e = acc.get(r.finding_type) ?? { count: 0, sample: [] }; e.count++; if (e.sample.length < 5) e.sample.push(r.paragraph_id); acc.set(r.finding_type, e);
      }
    }
    return [...acc].map(([code, v]) => ({ code, ...v }));
  }

  addRecheck(paragraphId: string, triggeredBy: string, reason: string): void {
    if (this.db.get(`SELECT 1 FROM recheck_tasks WHERE paragraph_id=? AND status='pending'`, [paragraphId])) return;
    this.db.run('INSERT INTO recheck_tasks(id,paragraph_id,triggered_by,reason,created_at) VALUES(?,?,?,?,?)', [newId(), paragraphId, triggeredBy, reason, nowIso()]);
  }
  pendingRechecks(paragraphIds?: string[]): { id: string; paragraph_id: string; reason: string }[] {
    if (!paragraphIds) return this.db.all(`SELECT id, paragraph_id, reason FROM recheck_tasks WHERE status='pending'`);
    if (!paragraphIds.length) return [];
    return this.db.all(`SELECT id, paragraph_id, reason FROM recheck_tasks WHERE status='pending' AND paragraph_id IN (${paragraphIds.map(() => '?').join(',')})`, paragraphIds);
  }
  markRecheckDone(paragraphId: string): void { this.db.run(`UPDATE recheck_tasks SET status='done' WHERE paragraph_id=? AND status='pending'`, [paragraphId]); }

  /** 复核队列；同 group_key 的待处理项合并（payload.items 追加） */
  enqueue(item: { seriesId: string; kind: ReviewKind; paragraphId?: string | null; groupKey?: string | null; title: string; payload: Record<string, unknown> }): string {
    if (item.groupKey) {
      const ex = this.db.get<{ id: string; payload: string }>(`SELECT id, payload FROM review_queue WHERE series_id=? AND kind=? AND group_key=? AND status='pending'`, [item.seriesId, item.kind, item.groupKey]);
      if (ex) {
        const p = fromJson<Record<string, unknown>>(ex.payload, {});
        const items = Array.isArray(p.items) ? (p.items as unknown[]) : [];
        items.push({ paragraphId: item.paragraphId ?? null, ...item.payload });
        this.db.run('UPDATE review_queue SET payload=? WHERE id=?', [JSON.stringify({ ...p, items }), ex.id]);
        return ex.id;
      }
    }
    // 验证 paragraph_id 是否存在（防止 AI 返回的 evidence_ids 引用不存在的段落导致外键约束失败）
    let validParagraphId: string | null = item.paragraphId ?? null;
    if (validParagraphId) {
      const exists = this.db.get('SELECT 1 FROM paragraphs WHERE id=?', [validParagraphId]);
      if (!exists) {
        this.log({ level: 'warning', workstationId: null, paragraphId: null, message: `enqueue: paragraph_id ${validParagraphId} 不存在，已清空为 null` });
        validParagraphId = null;
      }
    }
    const id = newId();
    const payload = item.groupKey ? { ...item.payload, items: [{ paragraphId: validParagraphId, ...item.payload }] } : item.payload;
    this.db.run('INSERT INTO review_queue(id,series_id,kind,priority,paragraph_id,group_key,title,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [id, item.seriesId, item.kind, REVIEW_PRIORITY[item.kind], validParagraphId, item.groupKey ?? null, item.title, JSON.stringify(payload), nowIso()]);
    return id;
  }
  listPendingByKind(seriesId: string, kind: ReviewKind): { id: string; paragraph_id: string | null; group_key: string | null; payload: Record<string, unknown> }[] {
    return this.db.all<{ id: string; paragraph_id: string | null; group_key: string | null; payload: string }>(`SELECT id, paragraph_id, group_key, payload FROM review_queue WHERE series_id=? AND kind=? AND status='pending'`, [seriesId, kind])
      .map(r => ({ ...r, payload: fromJson<Record<string, unknown>>(r.payload, {}) }));
  }
  updateQueuePayload(id: string, payload: Record<string, unknown>): void { this.db.run('UPDATE review_queue SET payload=? WHERE id=?', [JSON.stringify(payload), id]); }
  hasPending(seriesId: string, kind: ReviewKind, groupKey: string): boolean {
    return !!this.db.get(`SELECT 1 FROM review_queue WHERE series_id=? AND kind=? AND group_key=? AND status='pending'`, [seriesId, kind, groupKey]);
  }
  listQueue(seriesId: string, status: 'pending' | 'resolved' | 'dismissed' = 'pending'): ReviewItemView[] {
    return this.db.all<{ id: string; kind: ReviewKind; priority: number; paragraph_id: string | null; series_ordinal: number | null; chapter_label: string | null; title: string; payload: string; status: ReviewItemView['status']; created_at: string }>(`
      SELECT q.id, q.kind, q.priority, q.paragraph_id, p.series_ordinal,
        (SELECT '第' || c.chapter_number || '章 §' || p.para_ordinal FROM scenes s JOIN chapters c ON c.id=s.chapter_id WHERE s.id=p.scene_id) chapter_label,
        q.title, q.payload, q.status, q.created_at
      FROM review_queue q LEFT JOIN paragraphs p ON p.id=q.paragraph_id
      WHERE q.series_id=? AND q.status=? ORDER BY q.priority, p.series_ordinal, q.created_at`, [seriesId, status])
      .map(r => ({ id: r.id, kind: r.kind, priority: r.priority, paragraphId: r.paragraph_id, seriesOrdinal: r.series_ordinal, chapterLabel: r.chapter_label, title: r.title, payload: fromJson<Record<string, unknown>>(r.payload, {}), status: r.status, createdAt: r.created_at }));
  }
  getQueueItem(id: string): { id: string; series_id: string; kind: ReviewKind; paragraph_id: string | null; status: 'pending' | 'resolved' | 'dismissed'; payload: Record<string, unknown> } | undefined {
    const r = this.db.get<{ id: string; series_id: string; kind: ReviewKind; paragraph_id: string | null; status: 'pending' | 'resolved' | 'dismissed'; payload: string }>('SELECT id, series_id, kind, paragraph_id, status, payload FROM review_queue WHERE id=?', [id]);
    return r ? { ...r, payload: fromJson<Record<string, unknown>>(r.payload, {}) } : undefined;
  }
  resolveQueueItem(id: string, resolution: string, status: 'resolved' | 'dismissed' = 'resolved'): void {
    this.db.run('UPDATE review_queue SET status=?, resolution=?, resolved_at=? WHERE id=?', [status, resolution, nowIso(), id]);
  }
  /** 待处理的人物相关候选（语癖/称谓/性别）payload 串，供快速路径条件 5 判断 */
  pendingCharacterCandidatePayloads(seriesId: string): string[] {
    return this.db.all<{ payload: string }>(`SELECT payload FROM review_queue WHERE series_id=? AND status='pending' AND kind IN ('quirk-candidate','honorific-first','gender-plural')`, [seriesId]).map(r => r.payload);
  }
  pendingQueueForParagraph(paragraphId: string): number {
    return this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM review_queue WHERE paragraph_id=? AND status='pending'`, [paragraphId])?.n ?? 0;
  }

  addWordplay(w: { seriesId: string; paragraphId: string | null; wordplayType: string; original: string; variant: string; meaning: string; proposedZh: string | null; rationale: string | null; confidence: number | null }): string {
    const id = newId();
    this.db.run('INSERT INTO wordplay_decisions(id,series_id,paragraph_id,wordplay_type,source_original,source_variant,source_meaning,proposed_zh,zh_rationale,confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [id, w.seriesId, w.paragraphId, w.wordplayType, w.original, w.variant, w.meaning, w.proposedZh, w.rationale, w.confidence, nowIso()]);
    return id;
  }
  decideWordplay(id: string, finalZh: string, notes: string | null): void {
    this.db.run('UPDATE wordplay_decisions SET final_zh=?, decision_notes=?, confirmed_by_user=1 WHERE id=?', [finalZh, notes, id]);
  }
  confirmedWordplay(seriesId: string): { source_original: string; source_variant: string; source_meaning: string; final_zh: string }[] {
    return this.db.all('SELECT source_original, source_variant, source_meaning, final_zh FROM wordplay_decisions WHERE series_id=? AND confirmed_by_user=1', [seriesId]);
  }
  findWordplay(seriesId: string, original: string, variant: string): { id: string; final_zh: string | null; confirmed_by_user: number } | undefined {
    return this.db.get('SELECT id, final_zh, confirmed_by_user FROM wordplay_decisions WHERE series_id=? AND source_original=? AND source_variant=? ORDER BY confirmed_by_user DESC LIMIT 1', [seriesId, original, variant]);
  }

  recordAiCall(c: { taskId?: string | null; paragraphId?: string | null; model: string; provider: string; promptVersion: string; workstationId: WorkstationId; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; durationMs: number; finishReason: string | null; error?: string | null }): string {
    const id = newId();
    this.db.run('INSERT INTO ai_calls(id,task_id,paragraph_id,model,provider,prompt_version,workstation_id,input_tokens,output_tokens,cost_usd,duration_ms,finish_reason,error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, c.taskId ?? null, c.paragraphId ?? null, c.model, c.provider, c.promptVersion, c.workstationId, c.inputTokens, c.outputTokens, c.costUsd, c.durationMs, c.finishReason, c.error ?? null, nowIso()]);
    return id;
  }
  usageTotals(sinceIso?: string): { unknownUsageRequests: number; calls: number; inputTokens: number; outputTokens: number; costUsd: number } {
    const r = this.db.get<{ unknown: number; calls: number; i: number | null; o: number | null; c: number | null }>('SELECT SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) unknown, COUNT(*) calls, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cost_usd) c FROM ai_calls WHERE created_at>=?', [sinceIso ?? '']);
    return { unknownUsageRequests: r?.unknown ?? 0, calls: r?.calls ?? 0, inputTokens: r?.i ?? 0, outputTokens: r?.o ?? 0, costUsd: r?.c ?? 0 };
  }

  log(e: { level: ActivityLogEntry['level']; workstationId?: WorkstationId | null; paragraphId?: string | null; message: string; durationMs?: number | null; tokens?: number | null }): void {
    this.db.run('INSERT INTO activity_log(ts,level,workstation_id,paragraph_id,message,duration_ms,tokens) VALUES(?,?,?,?,?,?,?)',
      [nowIso(), e.level, e.workstationId ?? null, e.paragraphId ?? null, e.message, e.durationMs ?? null, e.tokens ?? null]);
  }
  recentLogs(afterId: number, limit = 200): ActivityLogEntry[] {
    return this.db.all<{ id: number; ts: string; level: ActivityLogEntry['level']; workstation_id: WorkstationId | null; paragraph_id: string | null; message: string; duration_ms: number | null; tokens: number | null }>('SELECT * FROM activity_log WHERE id>? ORDER BY id LIMIT ?', [afterId, limit])
      .map(r => ({ id: r.id, ts: r.ts, level: r.level, workstationId: r.workstation_id, paragraphId: r.paragraph_id, message: r.message, durationMs: r.duration_ms, tokens: r.tokens }));
  }
  /** 清空任务日志（activity_log 整表）。 */
  clearLogs(): number {
    const n = this.db.all<{ c: number }>('SELECT COUNT(*) c FROM activity_log')[0]?.c ?? 0;
    this.db.run('DELETE FROM activity_log');
    return n;
  }
}
