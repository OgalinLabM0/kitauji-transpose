import type { ProjectStore } from '@core/db';
import { assertPreparedTranslationsCurrent, type PreparedTranslation } from '../db/preparedTranslations';

/** Explicit, store-bound read-only view. It contains only genuine immutable future
 * rows, never substitutes the store or intercepts SQL. The original latest final
 * is shadowed even when the future row removes its last first-person annotation.
 */
export class RubyHistoryOverlay {
  readonly paragraphIds: readonly string[];
  readonly entries: readonly PreparedTranslation[];
  readonly #store: ProjectStore;
  readonly #byParagraph: ReadonlyMap<string, PreparedTranslation>;
  readonly #byCandidate: ReadonlyMap<string, PreparedTranslation>;

  constructor(store: ProjectStore, rows: readonly PreparedTranslation[]) {
    assertPreparedTranslationsCurrent(store, rows);
    this.#store = store;
    this.entries = Object.freeze([...rows]);
    this.paragraphIds = Object.freeze(rows.map(row => row.final.paragraph_id));
    this.#byParagraph = new Map(rows.map(row => [row.final.paragraph_id, row]));
    this.#byCandidate = new Map(rows.map(row => [row.candidate.id, row]));
    Object.freeze(this);
  }
  assertCurrent(store: ProjectStore): void {
    if (store !== this.#store) throw new Error('候选历史视图属于其他书库实例');
    assertPreparedTranslationsCurrent(store, this.entries);
  }
  finalFor(paragraphId: string) { return this.#byParagraph.get(paragraphId)?.final; }
  candidateFor(candidateId: string) { return this.#byCandidate.get(candidateId)?.candidate; }
}
