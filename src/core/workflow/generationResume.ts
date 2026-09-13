import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ProjectStore } from '@core/db';
import { PROMPT_VERSION, systemPromptFor, translationItemSchema, type TranslationItem } from '@core/ai';
import { auditInput, AUDIT_VERSION } from './auditReceipts';
import {layoutProofSchema,validLayoutProof,layoutSourceCalls,type LayoutProof} from '../validation/immutableLayout';

export const GENERATION_RESUME_CONTRACT = 'pipeline-incomplete-faithful-v1';
/** Distinct from ownership/candidate corruption: final review can report this as pending work. */
export class GenerationResumeContextChangedError extends Error {
  constructor() { super('初译恢复依据或当前稿已变化，旧候选不再继续或保存'); this.name = 'GenerationResumeContextChangedError'; }
}
const PREFIX = 'pipeline-generation-resume:';
export const generationResumeKey = (id: string) => `${PREFIX}${id}`;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const projectionSchema=z.object({aiCallId:z.string().min(1),before:z.string().min(1),after:z.string().min(1)}).strict();
type ProjectionSource=z.infer<typeof projectionSchema>;
const savedSchema = z.object({ contract: z.literal(GENERATION_RESUME_CONTRACT), fingerprint: z.string(), owner: z.string(),
  candidate: z.object({ id: z.string(), rowHash: z.string(), item: translationItemSchema, calls: z.array(z.string()).min(1), projection:projectionSchema.optional(), layout:layoutProofSchema.optional(), checksum: z.string() }).strict().nullable() }).strict();
type State = z.infer<typeof savedSchema>;
type Candidate = NonNullable<State['candidate']>;

/** Only explicit Pipeline snapshots qualify. No latestCandidate fallback and no quality receipt. */
export function openGenerationResume(store: ProjectStore, id: string, context: () => string, allowResume: boolean, repair?: { purpose: 'repair'; contract: string; allowEditedCandidate?: boolean }) {
  const key = generationResumeKey(id);
  const dependency = () => hash([GENERATION_RESUME_CONTRACT, PROMPT_VERSION, AUDIT_VERSION, systemPromptFor('faithful-translator'),
    auditInput(store, id).inputHash, store.projects.getParagraph(id), context(), store.translations.latestFinal(id) ?? null, ...(repair ? [repair] : [])]);
  const fingerprint = dependency();
  const read = (): State | null => {
    try {
      const raw = store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [key]);
      const parsed = savedSchema.parse(raw ? JSON.parse(raw.value) : null);
      return parsed.fingerprint === fingerprint ? parsed : null;
    } catch { return null; }
  };
  const allowedWorkstation = (ws:string) => ws === 'faithful-translator' || (repair?.allowEditedCandidate === true && ws === 'chinese-editor');
  const validCalls = (calls: string[], workstation:string) => allowedWorkstation(workstation) && (!repair || calls.length === 1) && new Set(calls).size === calls.length && calls.every(call => !!store.db.get(
    "SELECT id FROM ai_calls WHERE id=? AND workstation_id=? AND prompt_version=? AND error IS NULL AND finish_reason='stop'" + (repair ? ' AND paragraph_id=?' : ' AND (paragraph_id IS NULL OR paragraph_id=?)'), [call, workstation, PROMPT_VERSION, id]));
  const validProjection=(projection:ProjectionSource|undefined,workstation:string,text:string)=>{
    // Edited repair checkpoints are only written by punctuation projection.
    // Legacy edited checkpoints without its source cannot be reconstructed.
    if(!projection)return workstation!=='chinese-editor';
    return repair?.allowEditedCandidate===true && ['faithful-translator','chinese-editor'].includes(workstation) && projection.after===text && projection.before!==projection.after
      && projection.before.replace(/[、，,。]/gu,'')===projection.after.replace(/[、，,。]/gu,'')
      && !!store.db.get("SELECT id FROM ai_calls WHERE id=? AND workstation_id='source-aligner' AND paragraph_id=? AND prompt_version=? AND error IS NULL AND finish_reason='stop'",[projection.aiCallId,id,PROMPT_VERSION]);
  };
  const validCandidate = (saved: Candidate | null): saved is Candidate => {
    if (!saved || saved.item.id !== id) return false;
    const { checksum, ...body } = saved;
    const row = store.translations.candidateById(saved.id);
    if (!row) return false;
    try {
      if (hash(JSON.parse(row.source_coverage ?? 'null')) !== hash(saved.item.source_coverage ?? null)
        || hash(JSON.parse(row.flags ?? 'null')) !== hash(saved.item.flags ?? null)
        || hash(JSON.parse(row.tone_axes ?? 'null')) !== hash(saved.item.tone_axes ?? null)) return false;
    } catch { return false; }
    return checksum === hash(body) && hash(row) === saved.rowHash && row.paragraph_id === id && allowedWorkstation(row.workstation_id)
      && row.candidate_text === saved.item.translation && row.ai_call_id === saved.calls.at(-1) && validCalls(saved.calls,row.workstation_id)
      && (!store.db.get('SELECT key FROM meta WHERE key=?',[`inline-call:${row.ai_call_id}`])||!!saved.layout)
      && (!saved.layout||(JSON.stringify(saved.calls)===JSON.stringify(layoutSourceCalls(saved.layout))&&validLayoutProof(store,id,saved.item.translation,saved.layout)))
      && validProjection(saved.projection,row.workstation_id,saved.item.translation);
  };
  const old = allowResume ? read() : null;
  const candidate = old && validCandidate(old.candidate) ? old.candidate : null;
  const state: State = { contract: GENERATION_RESUME_CONTRACT, fingerprint, owner: randomUUID(), candidate };
  if (!allowResume && !repair) store.db.run('DELETE FROM meta WHERE key=?', [`long-paragraph-draft:${id}`]);
  store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', [key, JSON.stringify(state)]);
  const assertCurrent = () => {
    const latest = read();
    if (latest?.owner !== state.owner || (state.candidate && (!validCandidate(latest.candidate) || latest.candidate.id !== state.candidate.id))) throw new Error('初译恢复检查点已被新任务接管或候选已变化');
    if (dependency() !== fingerprint) throw new GenerationResumeContextChangedError();
  };
  return {
    restored: candidate ? { candidateId: candidate.id, item: structuredClone(candidate.item), aiCallId: candidate.calls.at(-1)!, workstation: store.translations.candidateById(candidate.id)!.workstation_id as 'faithful-translator'|'chinese-editor' } : null,
    assertCurrent,
    /** Caller stores the candidate and this binding in the same SQLite transaction. */
    save(candidateId: string, item: TranslationItem, aiCallId: string, projection?:ProjectionSource, layout?:LayoutProof) {
      assertCurrent();
      const row = store.translations.candidateById(candidateId);
      if (!row || row.paragraph_id !== id || !allowedWorkstation(row.workstation_id) || row.candidate_text !== item.translation || row.ai_call_id !== aiCallId) throw new Error('初译候选与恢复记录不一致');
      let calls = [aiCallId];
      if(!layout&&store.db.get('SELECT key FROM meta WHERE key=?',[`inline-call:${aiCallId}`]))throw Error('正文版式候选缺少双调用来源');
      if(layout){
        if(repair||row.workstation_id!=='faithful-translator'||layout.layoutCallId!==aiCallId||!validLayoutProof(store,id,item.translation,layout))throw Error('正文版式来源记录无效');
        calls=layoutSourceCalls(layout);
      }
      // A merged long generation has a real call per fragment, not only the final fragment ID.
      const raw = repair||layout ? undefined : store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [`long-paragraph-draft:${id}`]);
      if (raw) {
        try {
          const fragments = JSON.parse(raw.value).parts as { item: TranslationItem; aiCallId: string; checksum: string }[];
          if (Array.isArray(fragments) && fragments.length && fragments.at(-1)!.aiCallId === aiCallId) {
            if (fragments.some(p => !translationItemSchema.safeParse(p.item).success || p.item.id !== id || p.checksum !== hash([p.item, p.aiCallId]))
              || fragments.map(p => p.item.translation).join('') !== item.translation) throw new Error('invalid fragments');
            calls = fragments.map(p => p.aiCallId);
          }
        } catch { throw new Error('长段初译来源片段损坏，不能保存可恢复凭据'); }
      }
      if (!validCalls(calls,row.workstation_id)) throw new Error('初译恢复缺少真实成功生成调用');
      if (!validProjection(projection,row.workstation_id,item.translation)) throw new Error('修复恢复缺少有效标点投影来源或前后稿绑定');
      const body = { id: candidateId, rowHash: hash(row), item: structuredClone(item), calls, ...(projection?{projection:structuredClone(projection)}:{}),...(layout?{layout:structuredClone(layout)}:{}) };
      state.candidate = { ...body, checksum: hash(body) };
      store.db.run('UPDATE meta SET value=? WHERE key=?', [JSON.stringify(state), key]);
    },
    /** Retire only this owner's record; never delete a newer session or any historical candidate. */
    finish() {
      if (read()?.owner === state.owner) store.db.run('DELETE FROM meta WHERE key=?', [key]);
    },
  };
}

export function pruneGenerationResumes(store: ProjectStore): void {
  for (const prefix of [PREFIX, 'separated-body:', 'separated-editor:'])
    store.db.run('DELETE FROM meta WHERE substr(key,1,?)=? AND NOT EXISTS (SELECT 1 FROM paragraphs WHERE id=substr(meta.key,?))', [prefix.length, prefix, prefix.length + 1]);
}
