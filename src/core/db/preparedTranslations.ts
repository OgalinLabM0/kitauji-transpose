import type { ProjectStore } from './index';
import { newId, nowIso, toJson } from './database';
import type { CandidateRow, FinalRow, RubyAnnotation } from './translationRepo';
import type { TranslationItem } from '../ai/protocol';

/** Exact future SQLite rows; all fields are scalar and frozen, including JSON strings. */
export interface PreparedTranslation {
  readonly candidate: Readonly<CandidateRow>;
  readonly final: Readonly<FinalRow>;
}
interface Preparation {
  store: ProjectStore;
  previous: string;
  previousCandidate: string;
  paragraph: string;
  schema: string;
}
export const PREPARED_TRANSLATION_LIMIT = 4;
const preparations = new WeakMap<PreparedTranslation, Preparation>();
const encoded = (value: unknown) => JSON.stringify(value ?? null);
const CANDIDATE_COLUMNS = ['id', 'paragraph_id', 'workstation_id', 'candidate_text', 'source_coverage', 'tone_axes', 'flags', 'ai_call_id', 'created_at'];
const FINAL_COLUMNS = ['id', 'paragraph_id', 'final_text', 'ruby_annotations', 'source_candidate_id', 'auto_accepted', 'confirmed_by_user', 'confirmed_at', 'version'];

function schemaSnapshot(store: ProjectStore): string {
  const tables = [store.db.all<{ name: string }>('PRAGMA table_info(translation_candidates)'), store.db.all<{ name: string }>('PRAGMA table_info(translation_finals)')];
  if (encoded(tables.map(rows => rows.map(r => r.name))) !== encoded([CANDIDATE_COLUMNS, FINAL_COLUMNS])) throw new Error('候选预分配与当前稿件表结构不一致');
  return encoded(tables);
}
function currentBase(store: ProjectStore, id: string) {
  const final = store.translations.latestFinal(id);
  return { previous: encoded(final), previousCandidate: encoded(final?.source_candidate_id ? store.translations.candidateById(final.source_candidate_id) : null),
    paragraph: encoded(store.projects.getParagraph(id)) };
}

/** Preallocation is read-only: no row reservation, version increment or receipt.
 * Caller must verify the candidate, then commit inside its adoption transaction.
 * This intentionally has no API for arbitrary IDs, versions or user confirmation.
 */
export function prepareTranslation(store: ProjectStore, input: {
  item: TranslationItem; ruby: readonly RubyAnnotation[]; aiCallId: string; previous: FinalRow;
}): PreparedTranslation {
  const { item, previous } = input;
  const paragraph = store.projects.getParagraph(item.id), current = store.translations.latestFinal(item.id);
  if (!paragraph || previous.paragraph_id !== item.id || !current || current.confirmed_by_user || encoded(current) !== encoded(previous)) throw new Error('预分配依据的旧稿已变化或为人工稿');
  if (!Number.isSafeInteger(previous.version) || previous.version < 1 || !Number.isSafeInteger(previous.version + 1)) throw new Error('旧稿版本号无效');
  if (!item.translation.trim() || !Array.isArray(item.source_coverage) || !Array.isArray(item.flags) || !Array.isArray(input.ruby)) throw new Error('预分配候选内容或元数据无效');
  if (!store.db.get("SELECT id FROM ai_calls WHERE id=? AND workstation_id='faithful-translator' AND error IS NULL", [input.aiCallId])) throw new Error('预分配缺少真实生成调用');
  // Order matches SELECT * / the existing schema exactly: ruby evidence hashes full rows.
  const candidate: Readonly<CandidateRow> = Object.freeze({ id: newId(), paragraph_id: item.id, workstation_id: 'faithful-translator',
    candidate_text: item.translation, source_coverage: toJson(item.source_coverage), tone_axes: null, flags: toJson(item.flags), ai_call_id: input.aiCallId, created_at: nowIso() });
  const final: Readonly<FinalRow> = Object.freeze({ id: newId(), paragraph_id: item.id, final_text: item.translation, ruby_annotations: toJson(input.ruby),
    source_candidate_id: candidate.id, auto_accepted: 1, confirmed_by_user: 0, confirmed_at: null, version: previous.version + 1 });
  const prepared = Object.freeze({ candidate, final });
  preparations.set(prepared, { store, ...currentBase(store, item.id), schema: schemaSnapshot(store) });
  return prepared;
}

/** Compare-and-swap includes in-place confirmations, annotations, original source
 * and source-candidate edits. Only genuine preparations from this store are accepted.
 */
export function assertPreparedTranslationsCurrent(store: ProjectStore, rows: readonly PreparedTranslation[]): void {
  if (rows.length > PREPARED_TRANSLATION_LIMIT) throw new Error('候选历史覆盖超过有界组上限');
  const ids = new Set<string>();
  for (const row of rows) {
    const base = preparations.get(row), id = row.final.paragraph_id;
    if (!base || base.store !== store || ids.has(id)) throw new Error('候选预分配来源不匹配或段落重复');
    ids.add(id);
    const current = currentBase(store, id);
    if (base.previous !== current.previous || base.previousCandidate !== current.previousCandidate || base.paragraph !== current.paragraph || base.schema !== schemaSnapshot(store)) throw new Error('候选预分配的旧稿、原文、来源或表结构已变化');
    if (store.translations.candidateById(row.candidate.id) || store.db.get('SELECT id FROM translation_finals WHERE id=?', [row.final.id])) throw new Error('候选预分配身份已被使用');
    if (!store.db.get("SELECT id FROM ai_calls WHERE id=? AND workstation_id='faithful-translator' AND error IS NULL", [row.candidate.ai_call_id])) throw new Error('候选预分配生成调用已失效');
  }
}

/** Synchronous INSERT-only batch. All CAS checks precede the first write. The
 * enclosing group transaction must also bind every audit and trajectory receipt.
 * Native constraints / errors propagate; there is no INSERT OR REPLACE fallback.
 */
export function commitPreparedTranslations(store: ProjectStore, rows: readonly PreparedTranslation[]): string[] {
  return store.transaction(() => {
    assertPreparedTranslationsCurrent(store, rows);
    // Db.transaction nests without savepoints. Keep this batch atomic even if an
    // outer caller catches our error and goes on to commit its own transaction.
    const savepoint = `prepared_${newId().replaceAll('-', '')}`;
    store.db.raw.exec(`SAVEPOINT ${savepoint}`);
    try {
      for (const { candidate: c, final: f } of rows) {
        store.db.run('INSERT INTO translation_candidates(id,paragraph_id,workstation_id,candidate_text,source_coverage,tone_axes,flags,ai_call_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
          [c.id, c.paragraph_id, c.workstation_id, c.candidate_text, c.source_coverage, c.tone_axes, c.flags, c.ai_call_id, c.created_at]);
        store.db.run('INSERT INTO translation_finals(id,paragraph_id,final_text,ruby_annotations,source_candidate_id,auto_accepted,confirmed_by_user,confirmed_at,version) VALUES(?,?,?,?,?,?,?,?,?)',
          [f.id, f.paragraph_id, f.final_text, f.ruby_annotations, f.source_candidate_id, f.auto_accepted, f.confirmed_by_user, f.confirmed_at, f.version]);
      }
      // Triggers or a future schema must not silently change the rows that were reviewed.
      for (const row of rows) if (encoded(store.translations.candidateById(row.candidate.id)) !== encoded(row.candidate)
        || encoded(store.translations.latestFinal(row.final.paragraph_id)) !== encoded(row.final)) throw new Error('提交的稿件行与已验证预分配内容不一致');
      store.db.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return rows.map(row => row.final.id);
    } catch (error) {
      store.db.raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      store.db.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  });
}
