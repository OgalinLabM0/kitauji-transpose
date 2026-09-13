/**
 * SQLite DDL —— 与 docs/设计/DATABASE_SCHEMA.md 一一对应。
 * 约定：所有 *_para 字段引用 paragraphs.series_ordinal；evidence_ids 为 paragraphs.id 的 JSON 数组。
 */
export const SCHEMA_VERSION = 13;

export const SCHEMA_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS final_audit_receipts (
  final_id TEXT PRIMARY KEY REFERENCES translation_finals(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id),
  input_hash TEXT NOT NULL, candidate_hash TEXT NOT NULL, final_hash TEXT NOT NULL,
  prompt_version TEXT NOT NULL, checks_json TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS series (
  id TEXT PRIMARY KEY, title TEXT NOT NULL,
  original_lang TEXT NOT NULL DEFAULT 'ja', target_lang TEXT NOT NULL DEFAULT 'zh',
  author TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS volumes (
  id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id),
  volume_number INTEGER NOT NULL, title TEXT, created_at TEXT NOT NULL,
  UNIQUE(series_id, volume_number)
);
CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY, volume_id TEXT NOT NULL REFERENCES volumes(id),
  chapter_number INTEGER NOT NULL, title TEXT,
  UNIQUE(volume_id, chapter_number)
);
CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL REFERENCES chapters(id),
  scene_ordinal INTEGER NOT NULL, time_label TEXT, location_id TEXT, atmosphere TEXT,
  UNIQUE(chapter_id, scene_ordinal)
);
CREATE TABLE IF NOT EXISTS paragraphs (
  id TEXT PRIMARY KEY, scene_id TEXT NOT NULL REFERENCES scenes(id),
  para_ordinal INTEGER NOT NULL, series_ordinal INTEGER NOT NULL,
  source_text TEXT NOT NULL, source_hash TEXT NOT NULL,
  paragraph_type TEXT NOT NULL,
  UNIQUE(scene_id, para_ordinal)
);
-- series_ordinal 只在同一系列内唯一（每个系列从 1 编号）；v1 曾误设为全表 UNIQUE，导致第二个系列无法导入。见 Db.migrate()。
CREATE INDEX IF NOT EXISTS idx_paragraphs_scene ON paragraphs(scene_id, para_ordinal);
CREATE INDEX IF NOT EXISTS idx_paragraphs_series_ordinal ON paragraphs(series_ordinal);

CREATE TABLE IF NOT EXISTS paragraph_analysis (
  paragraph_id TEXT PRIMARY KEY REFERENCES paragraphs(id),
  speaker_char_id TEXT REFERENCES characters(id), speaker_confidence REAL,
  target_char_ids TEXT, present_char_ids TEXT, intent TEXT, difficulty_flags TEXT,
  evidence_ids TEXT, updated_at TEXT NOT NULL,
  scene_boundary_before INTEGER NOT NULL DEFAULT 0, atmosphere TEXT NOT NULL DEFAULT '', scene_source_hash TEXT
);
CREATE TABLE IF NOT EXISTS project_settings (
  series_id TEXT NOT NULL REFERENCES series(id), key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY(series_id, key)
);

CREATE TABLE IF NOT EXISTS source_archives (
  id TEXT PRIMARY KEY, volume_id TEXT NOT NULL REFERENCES volumes(id),
  file_name TEXT NOT NULL, file_kind TEXT NOT NULL, sha256 TEXT NOT NULL,
  blob BLOB NOT NULL, imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spine_items (
  id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES source_archives(id),
  href TEXT NOT NULL, spine_index INTEGER NOT NULL, parseable INTEGER NOT NULL DEFAULT 1,
  UNIQUE(archive_id, href)
);
CREATE TABLE IF NOT EXISTS epub_text_blocks (
  id TEXT PRIMARY KEY, spine_item_id TEXT NOT NULL REFERENCES spine_items(id),
  paragraph_id TEXT REFERENCES paragraphs(id), xpath TEXT NOT NULL, block_hash TEXT NOT NULL,
  block_type TEXT NOT NULL, protocol TEXT NOT NULL, inline_template TEXT, source_text TEXT NOT NULL,
  UNIQUE(spine_item_id, xpath)
);
CREATE INDEX IF NOT EXISTS idx_blocks_paragraph ON epub_text_blocks(paragraph_id);
CREATE TABLE IF NOT EXISTS toc_entries (
  id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES source_archives(id),
  toc_source TEXT NOT NULL, entry_path TEXT NOT NULL, source_label TEXT NOT NULL,
  heading_block_id TEXT REFERENCES epub_text_blocks(id)
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id),
  introduced_volume INTEGER NOT NULL, canonical_name_jp TEXT NOT NULL, canonical_name_zh TEXT,
  gender TEXT, gender_confidence REAL, gender_evidence_ids TEXT,
  plurality TEXT DEFAULT 'singular', first_person_type TEXT, speech_register TEXT,
  quirk_profiles TEXT, voice_notes TEXT, is_active INTEGER DEFAULT 1, deactivated_at_para INTEGER,
  locked_by_user INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS character_field_history (
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK(field IN ('gender','first_person_type','speech_register','voice_notes','plurality')),
  value_json TEXT NOT NULL, valid_from_para INTEGER NOT NULL CHECK(valid_from_para>=0),
  origin TEXT NOT NULL CHECK(origin IN ('model','user','legacy')), evidence_ids TEXT NOT NULL,
  created_at TEXT NOT NULL, source_quotes TEXT, source_proof TEXT,
  PRIMARY KEY(character_id,field,valid_from_para,origin)
);
CREATE TABLE IF NOT EXISTS character_field_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  fact_json TEXT NOT NULL, archived_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS character_field_baselines (
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  field TEXT NOT NULL, value_json TEXT NOT NULL,
  PRIMARY KEY(character_id,field)
);
CREATE TABLE IF NOT EXISTS character_field_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  field TEXT NOT NULL, valid_from_para INTEGER NOT NULL,
  previous_fact_json TEXT, applied_fact_json TEXT NOT NULL, baseline_json TEXT NOT NULL,
  created_at TEXT NOT NULL, undone_at TEXT, invalidated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_character_field_edits ON character_field_edits(character_id,field,valid_from_para,id);
CREATE TABLE IF NOT EXISTS character_aliases (
  id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id),
  alias_jp TEXT NOT NULL, alias_zh TEXT, alias_type TEXT NOT NULL, context_note TEXT,
  valid_from_para INTEGER, valid_to_para INTEGER
);
CREATE TABLE IF NOT EXISTS character_name_origins (
  character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK(origin IN ('model','user','legacy'))
);
CREATE TABLE IF NOT EXISTS character_name_observations (
  id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name_jp TEXT NOT NULL, source_proof TEXT NOT NULL, valid_from_para INTEGER NOT NULL,
  created_at TEXT NOT NULL, UNIQUE(character_id,name_jp,source_proof)
);
CREATE INDEX IF NOT EXISTS idx_character_name_time ON character_name_observations(character_id,valid_from_para);
CREATE TABLE IF NOT EXISTS character_alias_observations (
  id TEXT PRIMARY KEY,
  alias_id TEXT NOT NULL REFERENCES character_aliases(id) ON DELETE CASCADE,
  source_proof TEXT NOT NULL, valid_from_para INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(alias_id,source_proof,valid_from_para)
);
CREATE TABLE IF NOT EXISTS character_states (
  id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id),
  state_type TEXT NOT NULL, description TEXT NOT NULL, valid_from_para INTEGER NOT NULL,
  valid_to_para INTEGER, evidence_ids TEXT, may_leak_to_reader INTEGER DEFAULT 1,
  is_translator_only INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS narrative_events (
  id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id),
  summary_jp TEXT NOT NULL, summary_zh TEXT, at_para INTEGER NOT NULL, reveals_to_reader INTEGER NOT NULL DEFAULT 1,
  character_ids TEXT, evidence_ids TEXT, created_at TEXT NOT NULL, localized_at TEXT
);
CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id),
  from_char_id TEXT NOT NULL REFERENCES characters(id), to_char_id TEXT NOT NULL REFERENCES characters(id),
  event_type TEXT NOT NULL, description_jp TEXT NOT NULL, description_zh TEXT,
  intimacy_level INTEGER, respect_level INTEGER, power_distance INTEGER, formality_level INTEGER,
  valid_from_para INTEGER NOT NULL, valid_to_para INTEGER, evidence_ids TEXT, created_at TEXT NOT NULL, localized_at TEXT
);
CREATE TABLE IF NOT EXISTS address_trajectories (
  id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id),
  speaker_char_id TEXT NOT NULL REFERENCES characters(id), target_char_id TEXT NOT NULL REFERENCES characters(id),
  source_form_jp TEXT NOT NULL, translated_form TEXT NOT NULL, relation_stage TEXT, scene_scope TEXT,
  allow_variation INTEGER DEFAULT 0, valid_from_para INTEGER NOT NULL, valid_to_para INTEGER,
  confirmed_by_user INTEGER DEFAULT 0, evidence_ids TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS terms (
  id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id),
  introduced_volume INTEGER NOT NULL, term_jp TEXT NOT NULL, term_zh TEXT, term_type TEXT NOT NULL,
  sense_identity TEXT, confidence REAL DEFAULT 1.0,
  lock_level TEXT NOT NULL DEFAULT 'suggested',
  notes TEXT, valid_to_para INTEGER, superseded_by_term_id TEXT REFERENCES terms(id),
  evidence_ids TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_terms_jp ON terms(series_id, term_jp);
CREATE TABLE IF NOT EXISTS term_senses (
  id TEXT PRIMARY KEY, term_id TEXT NOT NULL REFERENCES terms(id),
  sense_zh TEXT NOT NULL, sense_gloss TEXT, context_hint TEXT,
  is_default INTEGER NOT NULL DEFAULT 0, confirmed_by_user INTEGER NOT NULL DEFAULT 0,
  evidence_ids TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS term_variants (
  id TEXT PRIMARY KEY, term_id TEXT NOT NULL REFERENCES terms(id),
  variant_jp TEXT NOT NULL, variant_zh TEXT, variant_type TEXT NOT NULL,
  speaker_char_id TEXT, target_char_id TEXT, relation_stage TEXT, scene_scope TEXT, evidence_ids TEXT
);
CREATE TABLE IF NOT EXISTS term_occurrences (
  id TEXT PRIMARY KEY, term_id TEXT NOT NULL REFERENCES terms(id),
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id), occurrence_text TEXT NOT NULL,
  applied_sense_id TEXT REFERENCES term_senses(id), applied_zh TEXT, inferred_confidence REAL,
  is_ambiguous INTEGER DEFAULT 0, deviation_status TEXT NOT NULL DEFAULT 'none',
  deviation_rationale TEXT, flagged_for_review INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_term_occ_para ON term_occurrences(paragraph_id);

CREATE TABLE IF NOT EXISTS wordplay_decisions (
  id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id),
  paragraph_id TEXT REFERENCES paragraphs(id), wordplay_type TEXT NOT NULL,
  source_original TEXT NOT NULL, source_variant TEXT NOT NULL, source_meaning TEXT NOT NULL,
  proposed_zh TEXT, zh_rationale TEXT, confidence REAL, final_zh TEXT, decision_notes TEXT,
  confirmed_by_user INTEGER DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_boundaries (
  id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id),
  boundary_type TEXT NOT NULL, character_id TEXT, fact_description TEXT NOT NULL,
  known_from_para INTEGER NOT NULL, known_to_para INTEGER, evidence_ids TEXT
);
CREATE TABLE IF NOT EXISTS knowledge_change_candidates (
  id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id),
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, change_type TEXT NOT NULL,
  description TEXT NOT NULL, triggered_at_para INTEGER NOT NULL, proposed_valid_to_para INTEGER,
  evidence_ids TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_change_proofs (
  candidate_id TEXT PRIMARY KEY REFERENCES knowledge_change_candidates(id) ON DELETE CASCADE,
  source_proof TEXT NOT NULL, target_snapshot TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS narrative_provenance (
  kind TEXT NOT NULL, record_id TEXT NOT NULL, series_id TEXT NOT NULL REFERENCES series(id),
  source_ids TEXT NOT NULL, source_hash TEXT NOT NULL, content_hash TEXT NOT NULL,
  contract TEXT NOT NULL, superseded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(kind, record_id)
);
CREATE INDEX IF NOT EXISTS idx_narrative_provenance_series ON narrative_provenance(series_id, superseded);

CREATE TABLE IF NOT EXISTS ai_calls (
  id TEXT PRIMARY KEY, task_id TEXT, model TEXT NOT NULL, provider TEXT NOT NULL,
  prompt_version TEXT NOT NULL, workstation_id TEXT, input_tokens INTEGER, output_tokens INTEGER,
  cost_usd REAL, duration_ms INTEGER, finish_reason TEXT, error TEXT, created_at TEXT NOT NULL, paragraph_id TEXT
);
CREATE TABLE IF NOT EXISTS translation_candidates (
  id TEXT PRIMARY KEY, paragraph_id TEXT NOT NULL REFERENCES paragraphs(id),
  workstation_id TEXT NOT NULL, candidate_text TEXT NOT NULL,
  source_coverage TEXT, tone_axes TEXT, flags TEXT, ai_call_id TEXT REFERENCES ai_calls(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cand_para ON translation_candidates(paragraph_id, created_at);
CREATE TABLE IF NOT EXISTS translation_finals (
  id TEXT PRIMARY KEY, paragraph_id TEXT NOT NULL REFERENCES paragraphs(id),
  final_text TEXT NOT NULL, ruby_annotations TEXT,
  source_candidate_id TEXT REFERENCES translation_candidates(id),
  auto_accepted INTEGER DEFAULT 0, confirmed_by_user INTEGER DEFAULT 0, confirmed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_finals_para ON translation_finals(paragraph_id, version);
CREATE TABLE IF NOT EXISTS review_findings (
  id TEXT PRIMARY KEY, paragraph_id TEXT NOT NULL REFERENCES paragraphs(id),
  workstation_id TEXT NOT NULL, finding_type TEXT NOT NULL, severity TEXT NOT NULL,
  description TEXT NOT NULL, evidence_jp TEXT, evidence_zh TEXT, suggested_fix TEXT,
  ai_call_id TEXT, resolved INTEGER DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_para ON review_findings(paragraph_id, resolved);
CREATE TABLE IF NOT EXISTS recheck_tasks (
  id TEXT PRIMARY KEY, paragraph_id TEXT NOT NULL REFERENCES paragraphs(id),
  triggered_by TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_queue (
  id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id),
  kind TEXT NOT NULL, priority INTEGER NOT NULL, paragraph_id TEXT REFERENCES paragraphs(id),
  group_key TEXT, title TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', resolution TEXT, created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_status ON review_queue(series_id, status, priority);
CREATE TABLE IF NOT EXISTS workflow_tasks (
  id TEXT PRIMARY KEY, workstation_id TEXT NOT NULL, paragraph_id TEXT,
  base_final_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle', error_message TEXT, retry_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, level TEXT NOT NULL,
  workstation_id TEXT, paragraph_id TEXT, message TEXT NOT NULL, duration_ms INTEGER, tokens INTEGER
);
`;
