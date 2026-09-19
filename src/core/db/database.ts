import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SCHEMA_DDL, SCHEMA_VERSION } from './schema';
import { inspectDatabaseVersion, snapshotBeforeMigration } from './databaseSafety';

export type Row = Record<string, unknown>;
export type Param = string | number | bigint | null | Uint8Array;

export const nowIso = (): string => new Date().toISOString();
export const newId = (): string => randomUUID();
export const toJson = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
export const fromJson = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || v.length === 0) return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
};

/** node:sqlite 的薄封装：同步、事务、类型化查询。 */
export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  readonly migrationBackupPath: string | null;
  constructor(readonly path: string, options: { readOnly?: boolean } = {}) {
    this.raw = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    if (options.readOnly) {
      this.migrationBackupPath = null;
      try { if (inspectDatabaseVersion(this.raw) !== SCHEMA_VERSION) throw new Error('只读查询要求已升级的当前书库'); }
      catch (error) { this.raw.close(); throw error; }
      return;
    }
    let backupPath: string | null = null;
    try {
      const from = inspectDatabaseVersion(this.raw);
      if (from !== null && from < SCHEMA_VERSION) backupPath = snapshotBeforeMigration(this.raw, path, from);
      this.migrationBackupPath = backupPath;
      this.raw.exec(SCHEMA_DDL);
      if (from === null) this.run('INSERT INTO meta(key, value) VALUES(?, ?)', ['schema_version', String(SCHEMA_VERSION)]);
      else this.migrate(from);
    } catch (error) {
      this.raw.close();
      if (backupPath) throw new Error(`书库升级失败。升级前完整快照已保留在：${backupPath}。原库暂不继续打开。`, { cause: error });
      throw error;
    }
  }

  /** 逐版本迁移已有库。CREATE IF NOT EXISTS 不会改动已存在的表，约束变更必须在这里重建表。 */
  private migrate(from: number): void {
    let v = from;
    if (v < 2) {
      // v1 → v2：paragraphs.series_ordinal 去掉全表 UNIQUE（按系列编号，多系列必撞）。SQLite 不能删约束，只能重建表。
      const hasGlobalUnique = this.all<{ sql: string | null }>(`SELECT sql FROM sqlite_master WHERE type='table' AND name='paragraphs'`)[0]?.sql?.includes('series_ordinal INTEGER NOT NULL UNIQUE') ?? false;
      if (hasGlobalUnique) {
        this.raw.exec('PRAGMA foreign_keys = OFF');
        try {
          this.raw.exec(`BEGIN IMMEDIATE;
            CREATE TABLE paragraphs_v2 (
              id TEXT PRIMARY KEY, scene_id TEXT NOT NULL REFERENCES scenes(id),
              para_ordinal INTEGER NOT NULL, series_ordinal INTEGER NOT NULL,
              source_text TEXT NOT NULL, source_hash TEXT NOT NULL,
              paragraph_type TEXT NOT NULL,
              UNIQUE(scene_id, para_ordinal)
            );
            INSERT INTO paragraphs_v2 SELECT id, scene_id, para_ordinal, series_ordinal, source_text, source_hash, paragraph_type FROM paragraphs;
            DROP TABLE paragraphs;
            ALTER TABLE paragraphs_v2 RENAME TO paragraphs;
            CREATE INDEX IF NOT EXISTS idx_paragraphs_scene ON paragraphs(scene_id, para_ordinal);
            CREATE INDEX IF NOT EXISTS idx_paragraphs_series_ordinal ON paragraphs(series_ordinal);
            COMMIT;`);
        } catch (e) { try { this.raw.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
        finally { this.raw.exec('PRAGMA foreign_keys = ON'); }
      }
      v = 2;
    }
    if (v < 3) {
      // v2 → v3：支持多工位架构，narrative_events.summary → summary_jp + summary_zh，relationships.description → description_jp + description_zh
      this.raw.exec('PRAGMA foreign_keys = OFF');
      try {
        // 迁移 narrative_events
        const hasOldEvents = this.all<{ sql: string | null }>(`SELECT sql FROM sqlite_master WHERE type='table' AND name='narrative_events'`)[0]?.sql?.includes('summary TEXT NOT NULL') ?? false;
        if (hasOldEvents) {
          this.raw.exec(`BEGIN IMMEDIATE;
            CREATE TABLE narrative_events_v3 (
              id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id),
              summary_jp TEXT NOT NULL, summary_zh TEXT, at_para INTEGER NOT NULL, reveals_to_reader INTEGER NOT NULL DEFAULT 1,
              character_ids TEXT, evidence_ids TEXT, created_at TEXT NOT NULL, localized_at TEXT
            );
            INSERT INTO narrative_events_v3 (id, series_id, summary_jp, at_para, reveals_to_reader, character_ids, evidence_ids, created_at)
              SELECT id, series_id, summary, at_para, reveals_to_reader, character_ids, evidence_ids, created_at FROM narrative_events;
            DROP TABLE narrative_events;
            ALTER TABLE narrative_events_v3 RENAME TO narrative_events;
            COMMIT;`);
        }
        // 迁移 relationships
        const hasOldRels = this.all<{ sql: string | null }>(`SELECT sql FROM sqlite_master WHERE type='table' AND name='relationships'`)[0]?.sql?.includes('description TEXT NOT NULL') ?? false;
        if (hasOldRels) {
          this.raw.exec(`BEGIN IMMEDIATE;
            CREATE TABLE relationships_v3 (
              id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id),
              from_char_id TEXT NOT NULL REFERENCES characters(id), to_char_id TEXT NOT NULL REFERENCES characters(id),
              event_type TEXT NOT NULL, description_jp TEXT NOT NULL, description_zh TEXT,
              intimacy_level INTEGER, respect_level INTEGER, power_distance INTEGER, formality_level INTEGER,
              valid_from_para INTEGER NOT NULL, valid_to_para INTEGER, evidence_ids TEXT, created_at TEXT NOT NULL, localized_at TEXT
            );
            INSERT INTO relationships_v3 (id, series_id, from_char_id, to_char_id, event_type, description_jp, intimacy_level, respect_level, power_distance, formality_level, valid_from_para, valid_to_para, evidence_ids, created_at)
              SELECT id, series_id, from_char_id, to_char_id, event_type, description, intimacy_level, respect_level, power_distance, formality_level, valid_from_para, valid_to_para, evidence_ids, created_at FROM relationships;
            DROP TABLE relationships;
            ALTER TABLE relationships_v3 RENAME TO relationships;
            COMMIT;`);
        }
      } catch (e) { try { this.raw.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
      finally { this.raw.exec('PRAGMA foreign_keys = ON'); }
      v = 3;
    }
    // v4 adds immutable per-final audit receipts through the additive DDL above.
    // Historical finals deliberately receive no inferred/forged audit receipt.
    if (v < 4) {
      if (!this.all<{ name: string }>('PRAGMA table_info(workflow_tasks)').some(c => c.name === 'base_final_id')) this.raw.exec('ALTER TABLE workflow_tasks ADD COLUMN base_final_id TEXT');
      v = 4;
    }
    // v5 adds field history without inventing dates or evidence for legacy profiles.
    if (v < 5) v = 5;
    // v6 journals new manual field decisions; legacy decisions get no invented undo history.
    if (v < 6) {
      if (!this.all<{name: string}>('PRAGMA table_info(character_field_history)').some(c => c.name === 'source_quotes')) this.raw.exec('ALTER TABLE character_field_history ADD COLUMN source_quotes TEXT');
      v = 6;
    }
    if (v < 7) {
      const names = new Set(this.all<{ name: string }>('PRAGMA table_info(paragraph_analysis)').map(c => c.name));
      if (!names.has('scene_boundary_before')) this.raw.exec('ALTER TABLE paragraph_analysis ADD COLUMN scene_boundary_before INTEGER NOT NULL DEFAULT 0');
      if (!names.has('atmosphere')) this.raw.exec("ALTER TABLE paragraph_analysis ADD COLUMN atmosphere TEXT NOT NULL DEFAULT ''");
      if (!names.has('scene_source_hash')) this.raw.exec('ALTER TABLE paragraph_analysis ADD COLUMN scene_source_hash TEXT');
      v = 7;
    }
    // v8 adds an independent provenance table via SCHEMA_DDL; never certify legacy facts.
    if (v < 8) v = 8;
    if (v < 9) {
      if (!this.all<{name: string}>('PRAGMA table_info(character_field_history)').some(c => c.name === 'source_proof')) this.raw.exec('ALTER TABLE character_field_history ADD COLUMN source_proof TEXT');
      v = 9; // Keep legacy observations unverified; no invented original snapshots.
    }
    if (v < 10) v = 10; // Alias observations are created by SCHEMA_DDL; no legacy certification.
    if (v < 11) v = 11; // Change-candidate proofs are independent; legacy candidates stay unverified.
    if (v < 12) {
      // Old names have no origin receipt. Preserve explicit manual profiles; never infer name evidence from a modeled field.
      this.run(`INSERT OR IGNORE INTO character_name_origins(character_id,origin)
        SELECT c.id,CASE WHEN c.locked_by_user=1 OR EXISTS(SELECT 1 FROM character_field_history h WHERE h.character_id=c.id AND h.origin='user')
        THEN 'user' ELSE 'legacy' END FROM characters c`);
      v = 12;
    }
    if (v < 13) {
      const columns = this.all<{name:string}>('PRAGMA table_info(ai_calls)');
      if (!columns.some(c => c.name === 'paragraph_id')) this.raw.exec('ALTER TABLE ai_calls ADD COLUMN paragraph_id TEXT');
      v = 13; // Old calls remain NULL: their paragraph provenance must not be invented.
    }
    if (v !== from) this.run('UPDATE meta SET value=? WHERE key=?', [String(v), 'schema_version']);
  }

  run(sql: string, params: readonly Param[] = []): { changes: number } {
    const r = this.raw.prepare(sql).run(...(params as Param[]));
    return { changes: Number(r.changes) };
  }
  get<T extends object = Row>(sql: string, params: readonly Param[] = []): T | undefined {
    return this.raw.prepare(sql).get(...(params as Param[])) as T | undefined;
  }
  all<T extends object = Row>(sql: string, params: readonly Param[] = []): T[] {
    return this.raw.prepare(sql).all(...(params as Param[])) as T[];
  }
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) { this.depth++; try { return fn(); } finally { this.depth--; } }
    this.raw.exec('BEGIN IMMEDIATE'); this.depth = 1;
    try { const out = fn(); this.raw.exec('COMMIT'); return out; }
    catch (e) { this.raw.exec('ROLLBACK'); throw e; }
    finally { this.depth = 0; }
  }
  close(): void { this.raw.close(); }
}
