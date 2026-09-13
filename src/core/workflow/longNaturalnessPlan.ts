import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ProjectStore } from '@core/db';
import { PROMPT_VERSION, systemPromptFor } from '@core/ai/prompts/systemPrompts';
import {naturalnessText,NATURALNESS_VISIBLE_CONTRACT,type NaturalnessText} from './naturalnessText';
import type {InlineTemplate} from '../epub/blocks';

export const LONG_NATURALNESS_CONTRACT = 'long-naturalness-zh-coverage-v2-sentence-boundaries';
export const NATURALNESS_SHORT_LIMIT = 12000;
export const LONG_READING_CHUNK_LIMIT = 4000;
export const LONG_READING_MAX_CHUNKS = 32;
export const LONG_READING_REQUEST_LIMIT = 12000;
export const readingHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PREFIX = 'long-naturalness:';
const PROOF_PREFIX = 'long-naturalness-proof:';
export const longNaturalnessKey = (id: string): string => `${PREFIX}${id}`;
export const longNaturalnessProofKey = (plan: Pick<LongReadingPlan, 'id' | 'fingerprint'>): string => `${PROOF_PREFIX}${plan.id}:${plan.fingerprint}`;
const SCOPE = '只检查draft的中文搭配与连接，不改写、不判断增漏译或源文顺序。source为空表示此局部检查不提供伪造的日中对齐；原作声音、信息与忠实性由整段独立原文审核负责。保留短句、残句、重复、迟疑、含混和称谓。';

export class LongNaturalnessBoundaryError extends Error {
  readonly code = 'LONG_NATURALNESS_NEEDS_BOUNDARY';
  constructor(readonly start: number, readonly end: number, reason: string) {
    super(`${reason}（中文UTF-16范围 ${start}–${end}）。已保留完整稿；请核对并补充合法句末/对白边界后重新复核，或使用经确认的段落拆分流程。不能仅点击通过或删除原文来绕过必需读感。`);
    this.name = 'LongNaturalnessBoundaryError';
  }
}
export interface ReadingRange { start: number; end: number }
export interface ReadingTask extends ReadingRange { kind: 'chunk' | 'join'; index: number; requestHash: string; taskId: string }
export interface LongReadingPlan {
  id: string; fingerprint: string; draft: string; sourceHash: string; paragraphType: string;
  chunks: ReadingRange[]; tasks: ReadingTask[];
  visible?:NaturalnessText;
}

/** Split only after a complete top-level sentence or complete quotation. Never cut a quote/surrogate pair. */
export function readingUnits(draft: string): ReadingRange[] {
  const units: ReadingRange[] = [], stack: string[] = [];
  const closes: Record<string, string> = { '「': '」', '『': '』', '“': '”', '‘': '’', '（': '）', '(': ')', '【': '】', '[': ']' };
  const closing = new Set(Object.values(closes));
  let start = 0;
  const flush = (end: number) => {
    if (end > start) {
      const previous = units.at(-1);
      if (previous && /^[\s\p{P}]+$/u.test(draft.slice(start, end))) previous.end = end;
      else units.push({ start, end });
    }
    start = end;
  };
  for (let i = 0; i < draft.length; i++) {
    const c = draft[i]!;
    // ASCII quotation cannot be attributed safely by this contract; recover rather than silently splitting it.
    if (c === '"') throw new LongNaturalnessBoundaryError(start, i + 1, '长段包含本契约尚不能安全配对的ASCII双引号');
    if (closes[c]) stack.push(closes[c]!);
    else if (closing.has(c)) {
      if (stack.pop() !== c) throw new LongNaturalnessBoundaryError(start, i + 1, '长段引号或括号未配对');
      // Do not cut a reporting clause immediately following a closing quote.
    }
    // A layout newline is not proof that a sentence has ended. Whitespace
    // immediately after a completed unit belongs to that unit, not a new sentence.
    if (!stack.length && units.length && start === i && /\s/u.test(c)) flush(i + 1);
    if (!stack.length && /[。！？!?]/u.test(c)) flush(i + 1);
    if (!stack.length && /[」』”’]/u.test(c) && (i + 1 === draft.length || /[「『“‘\s]/u.test(draft[i + 1]!))) flush(i + 1);
  }
  if (stack.length) throw new LongNaturalnessBoundaryError(start, draft.length, '长段引号或括号尚未闭合');
  flush(draft.length);
  for (const unit of units) if (unit.end - unit.start > LONG_READING_CHUNK_LIMIT) throw new LongNaturalnessBoundaryError(unit.start, unit.end, '完整单句或对白超过单次读感安全范围');
  return units;
}

export function readingRequest(plan: Pick<LongReadingPlan, 'id' | 'draft' | 'sourceHash' | 'paragraphType' | 'chunks'|'visible'>, task: Pick<ReadingTask, 'kind' | 'index' | 'start' | 'end'>): string {
  const text=plan.visible?plan.visible.range(task.start,task.end).text:plan.draft.slice(task.start, task.end);
  if(!text.trim())throw new LongNaturalnessBoundaryError(task.start,task.end,'读感范围没有可见正文');
  return JSON.stringify({ id: plan.id, source: '', draft: text, paragraph_type: plan.paragraphType,
    reading_contract: LONG_NATURALNESS_CONTRACT, task_scope: SCOPE,
    source_reference: { hash: plan.sourceHash, aligned: false, responsibility: 'whole-paragraph fidelity verification, not positional slicing' },
    reading: { kind: task.kind, index: task.index, start: task.start, end: task.end, scope: task.kind === 'join' ? (plan.chunks.length === 1 ? '中文全段只有一个范围；本次再次核查展示的完整中文，不判断源文忠实性' : '检查这两个相邻完整中文范围之间的语言衔接；不是对未展示全文的总结') : '检查展示范围的全部中文表达' } });
}

/** Deterministic coverage: contiguous chunks plus every adjacent chunk boundary, with complete edge units. */
export function makeLongReadingPlan(id: string, source: string, draft: string, paragraphType: string, inputHash: string,template?:InlineTemplate): LongReadingPlan {
  if (!draft.trim()) throw new LongNaturalnessBoundaryError(0, draft.length, '当前中文稿为空');
  if (draft.length > LONG_READING_CHUNK_LIMIT * LONG_READING_MAX_CHUNKS) throw new LongNaturalnessBoundaryError(0, draft.length, '长段超过有界中文读感总长度');
  // Boundary-only callers have no archive template and create no reading proof.
  const marked=!!template&&/[⟦⟧]/u.test(draft);
  const visible=marked?naturalnessText(draft,template!):undefined;
  const units = readingUnits(draft), chunks: ReadingRange[] = [];
  if(visible){
    // A closing-token tail is raw coverage, not another Chinese sentence.
    // Merge only zero-visible structure; an atomic placeholder remains a boundary.
    for(let i=0;i<units.length;){
      const unit=units[i]!;
      if(visible.range(unit.start,unit.end).text.length){i++;continue;}
      if(i>0){units[i-1]!.end=unit.end;units.splice(i,1);}
      else if(units.length>1){units[1]!.start=unit.start;units.splice(i,1);}
      else throw new LongNaturalnessBoundaryError(unit.start,unit.end,'读感范围只有结构标记');
    }
  }
  for (const unit of units) {
    const last = chunks.at(-1);
    if (last && unit.end - last.start <= LONG_READING_CHUNK_LIMIT) last.end = unit.end;
    else chunks.push({ ...unit });
  }
  if (chunks.length > LONG_READING_MAX_CHUNKS) throw new LongNaturalnessBoundaryError(0, draft.length, `长段超过${LONG_READING_MAX_CHUNKS}块的有界读感预算`);
  const ranges: Omit<ReadingTask, 'requestHash' | 'taskId'>[] = chunks.map((c, index) => ({ ...c, kind: 'chunk', index }));
  if (chunks.length === 1) ranges.push({ ...chunks[0]!, kind: 'join', index: 0 });
  for (let index = 1; index < chunks.length; index++) {
    const boundary = chunks[index]!.start;
    const left = units.find(u => u.end === boundary)!, right = units.find(u => u.start === boundary)!;
    ranges.push({ start: left.start, end: right.end, kind: 'join', index: index - 1 });
  }
  const plan: LongReadingPlan = { id, draft, sourceHash: readingHash(source), paragraphType, chunks, tasks: [], fingerprint: '',...(visible?{visible}:{}) };
  const requests = ranges.map(r => readingRequest(plan, r));
  if (requests.some(r => r.length > LONG_READING_REQUEST_LIMIT)) throw new LongNaturalnessBoundaryError(0, draft.length, '编码后请求超过短职责安全范围');
  plan.fingerprint = readingHash([LONG_NATURALNESS_CONTRACT, inputHash, source, draft, paragraphType, PROMPT_VERSION,
    systemPromptFor('naturalness-reviewer'), LONG_READING_CHUNK_LIMIT, LONG_READING_MAX_CHUNKS, LONG_READING_REQUEST_LIMIT, ranges, requests,...(marked?[NATURALNESS_VISIBLE_CONTRACT]:[])]);
  plan.tasks = ranges.map((r, index) => ({ ...r, requestHash: readingHash(requests[index]), taskId: `long-reading:${readingHash([id, plan.fingerprint, index])}` }));
  return plan;
}

const checkSchema = z.object({ taskId: z.string(), requestHash: z.string(), aiCallId: z.string(),
  assessment: z.object({ id: z.string(), decision: z.literal('keep'), issues: z.array(z.never()).length(0) }).strict(), checksum: z.string() }).strict();
export type ReadingCheck = z.infer<typeof checkSchema>;
const stateSchema = z.object({ contract: z.literal(LONG_NATURALNESS_CONTRACT), fingerprint: z.string(), owner: z.string(),
  baseFinalStamp: z.string(), checks: z.array(checkSchema).max(2 * LONG_READING_MAX_CHUNKS), complete: z.boolean() }).strict();
export type LongReadingState = z.infer<typeof stateSchema>;
export const checkChecksum = (check: Omit<ReadingCheck, 'checksum'>): string => readingHash(check);

export function validReadingCheck(store: ProjectStore, plan: LongReadingPlan, index: number, check: ReadingCheck): boolean {
  const task = plan.tasks[index];
  if (!task || check.taskId !== task.taskId || check.requestHash !== task.requestHash || check.assessment.id !== plan.id
    || check.assessment.decision !== 'keep' || check.assessment.issues.length !== 0) return false;
  const { checksum, ...body } = check;
  if (checksum !== checkChecksum(body)) return false;
  return !!store.db.get(`SELECT id FROM ai_calls WHERE id=? AND task_id=? AND workstation_id='naturalness-reviewer'
    AND prompt_version=? AND error IS NULL AND finish_reason='stop'`, [check.aiCallId, task.taskId, PROMPT_VERSION]);
}

/** All metadata is untrusted on reopen; only a correctly bound successful prefix can be resumed. */
export function readLongReadingState(store: ProjectStore, plan: LongReadingPlan, key = longNaturalnessKey(plan.id)): LongReadingState | null {
  try {
    const raw = store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [key]);
    const state = stateSchema.parse(raw ? JSON.parse(raw.value) : null);
    if (state.fingerprint !== plan.fingerprint || state.checks.length > plan.tasks.length) return null;
    const seen = new Set<string>();
    let prefix = 0;
    for (const check of state.checks) {
      if (seen.has(check.aiCallId) || !validReadingCheck(store, plan, prefix, check)) break;
      seen.add(check.aiCallId); prefix++;
    }
    return { ...state, checks: state.checks.slice(0, prefix), complete: state.complete && prefix === plan.tasks.length };
  } catch { return null; }
}

/** The public ID is the last actual join call, only after every chunk and join passes. */
export function longNaturalnessEvidence(store: ProjectStore, id: string, inputHash: string, draft: string): string | null {
  try {
    const p = store.projects.getParagraph(id);
    if (!p || p.sourceText.length + draft.length <= NATURALNESS_SHORT_LIMIT) return null;
    const raw=store.archives.blocksOfParagraph(id)[0]?.inline_template;
    const plan = makeLongReadingPlan(id, p.sourceText, draft, p.paragraphType, inputHash,raw?JSON.parse(raw):{markers:[]});
    const state = readLongReadingState(store, plan, longNaturalnessProofKey(plan));
    return state?.complete ? state.checks.at(-1)!.aiCallId : null;
  } catch { return null; }
}

export function pruneLongNaturalnessCheckpoints(store: ProjectStore): void {
  store.transaction(() => {
    store.db.run('DELETE FROM meta WHERE substr(key,1,?)=? AND NOT EXISTS (SELECT 1 FROM paragraphs WHERE id=substr(meta.key,?))', [PREFIX.length, PREFIX, PREFIX.length + 1]);
    store.db.run("DELETE FROM meta WHERE substr(key,1,?)=? AND NOT EXISTS (SELECT 1 FROM paragraphs WHERE substr(meta.key,?,length(id)+1)=id||':')", [PROOF_PREFIX.length, PROOF_PREFIX, PROOF_PREFIX.length + 1]);
  });
}
