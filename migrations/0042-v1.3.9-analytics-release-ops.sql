-- RE Program Bot v1.3.9 Part 6 — closed shadow release evidence.
--
-- Additive and idempotent. The tables below store aggregate, append-only
-- operational evidence only. No Telegram IDs, source rows, prompts, payment
-- identifiers, secrets, deployment credentials or restore payloads are stored.
-- This migration does not wire a Worker, route, cron or public rollout.

CREATE TABLE IF NOT EXISTS analytics_release_runs (
  run_id TEXT PRIMARY KEY CHECK (
    length(run_id) = 36 AND run_id = lower(run_id)
  ),
  action TEXT NOT NULL CHECK (action IN (
    'prepare_closed', 'enable_admin_shadow', 'disable'
  )),
  source_mode TEXT NOT NULL CHECK (source_mode IN (
    'none', 'synthetic', 'readonly_backfill'
  )),
  requested_by_hash TEXT NOT NULL CHECK (
    length(requested_by_hash) = 64
    AND requested_by_hash = lower(requested_by_hash)
    AND requested_by_hash NOT GLOB '*[^0-9a-f]*'
  ),
  commit_sha TEXT NOT NULL CHECK (
    length(commit_sha) = 40
    AND commit_sha = lower(commit_sha)
    AND commit_sha NOT GLOB '*[^0-9a-f]*'
  ),
  manifest_digest TEXT NOT NULL CHECK (
    length(manifest_digest) = 64
    AND manifest_digest = lower(manifest_digest)
    AND manifest_digest NOT GLOB '*[^0-9a-f]*'
  ),
  flags_digest TEXT NOT NULL CHECK (
    length(flags_digest) = 64
    AND flags_digest = lower(flags_digest)
    AND flags_digest NOT GLOB '*[^0-9a-f]*'
  ),
  high_watermark_at INTEGER NOT NULL CHECK (high_watermark_at > 0),
  expected_source_count INTEGER NOT NULL CHECK (
    expected_source_count BETWEEN 0 AND 11
  ),
  plan_digest TEXT NOT NULL UNIQUE CHECK (
    length(plan_digest) = 64
    AND plan_digest = lower(plan_digest)
    AND plan_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= created_at
    AND retention_until <= created_at + 15552000
  ),
  policy_version TEXT NOT NULL CHECK (
    policy_version = '2026-09-13.analytics-v2-part6'
  )
);

CREATE INDEX IF NOT EXISTS idx_analytics_release_runs_time
  ON analytics_release_runs(created_at, run_id);

CREATE INDEX IF NOT EXISTS idx_analytics_release_runs_retention
  ON analytics_release_runs(retention_until, run_id);

CREATE TABLE IF NOT EXISTS analytics_release_source_evidence (
  run_id TEXT NOT NULL REFERENCES analytics_release_runs(run_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'users', 'terms', 'bot_start', 'legacy_funnel', 'partner_program',
    'partner_link', 'lead', 'stars_payment', 'stars_access',
    'referral_reward', 'ai_partner'
  )),
  source_order INTEGER NOT NULL CHECK (source_order BETWEEN 1 AND 11),
  high_watermark_at INTEGER NOT NULL CHECK (high_watermark_at > 0),
  rows_seen INTEGER NOT NULL CHECK (rows_seen BETWEEN 0 AND 100),
  rows_inserted INTEGER NOT NULL CHECK (rows_inserted BETWEEN 0 AND rows_seen),
  rows_duplicate INTEGER NOT NULL CHECK (rows_duplicate BETWEEN 0 AND rows_seen),
  rows_conflict INTEGER NOT NULL CHECK (rows_conflict BETWEEN 0 AND rows_seen),
  rows_unmapped INTEGER NOT NULL CHECK (rows_unmapped BETWEEN 0 AND rows_seen),
  rows_invalid INTEGER NOT NULL CHECK (rows_invalid BETWEEN 0 AND rows_seen),
  rows_ambiguous INTEGER NOT NULL CHECK (rows_ambiguous BETWEEN 0 AND rows_seen),
  rows_excluded INTEGER NOT NULL CHECK (rows_excluded BETWEEN 0 AND rows_seen),
  rows_accounted INTEGER NOT NULL CHECK (rows_accounted = rows_seen),
  canonical_expected INTEGER NOT NULL CHECK (
    canonical_expected = rows_inserted + rows_duplicate
  ),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'complete', 'blocked'
  )),
  input_digest TEXT NOT NULL CHECK (
    length(input_digest) = 64
    AND input_digest = lower(input_digest)
    AND input_digest NOT GLOB '*[^0-9a-f]*'
  ),
  result_digest TEXT NOT NULL CHECK (
    length(result_digest) = 64
    AND result_digest = lower(result_digest)
    AND result_digest NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64
    AND evidence_digest = lower(evidence_digest)
    AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= high_watermark_at),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= recorded_at
    AND retention_until <= recorded_at + 15552000
  ),
  policy_version TEXT NOT NULL CHECK (
    policy_version = '2026-09-13.analytics-v2-part6'
  ),
  PRIMARY KEY (run_id, source_kind),
  UNIQUE (run_id, source_order),
  CHECK (
    rows_seen = rows_inserted + rows_duplicate + rows_conflict
      + rows_unmapped + rows_invalid + rows_ambiguous + rows_excluded
  ),
  CHECK (
    (outcome = 'complete'
      AND rows_conflict = 0 AND rows_unmapped = 0
      AND rows_invalid = 0 AND rows_ambiguous = 0)
    OR outcome = 'blocked'
  )
);

CREATE INDEX IF NOT EXISTS idx_analytics_release_sources_retention
  ON analytics_release_source_evidence(retention_until, run_id);

CREATE TABLE IF NOT EXISTS analytics_release_stage_evidence (
  run_id TEXT NOT NULL REFERENCES analytics_release_runs(run_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  stage_order INTEGER NOT NULL CHECK (stage_order BETWEEN 1 AND 9),
  stage_kind TEXT NOT NULL CHECK (stage_kind IN (
    'backup', 'restore', 'schema', 'source_snapshot', 'ingestion',
    'projection', 'reconciliation', 'runtime_regression', 'disable'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'blocked', 'skipped')),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'none', 'not_applicable', 'backup_missing', 'restore_failed',
    'schema_mismatch', 'source_changed', 'source_partial',
    'unexplained_delta', 'scope_leak', 'runtime_regression',
    'operator_disabled'
  )),
  observed_count INTEGER NOT NULL DEFAULT 0 CHECK (observed_count >= 0),
  expected_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_count >= 0),
  unexplained_delta INTEGER NOT NULL DEFAULT 0,
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64
    AND evidence_digest = lower(evidence_digest)
    AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  recorded_at INTEGER NOT NULL CHECK (recorded_at > 0),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= recorded_at
    AND retention_until <= recorded_at + 15552000
  ),
  policy_version TEXT NOT NULL CHECK (
    policy_version = '2026-09-13.analytics-v2-part6'
  ),
  PRIMARY KEY (run_id, stage_order),
  UNIQUE (run_id, stage_kind),
  CHECK (
    (outcome = 'passed' AND reason_code = 'none' AND unexplained_delta = 0)
    OR (outcome = 'skipped' AND reason_code IN (
      'not_applicable', 'operator_disabled'
    ))
    OR outcome = 'blocked'
  )
);

CREATE INDEX IF NOT EXISTS idx_analytics_release_stages_retention
  ON analytics_release_stage_evidence(retention_until, run_id);

CREATE TABLE IF NOT EXISTS analytics_release_privacy_inventory (
  dataset_name TEXT PRIMARY KEY CHECK (dataset_name IN (
    'analytics_release_runs', 'analytics_release_source_evidence',
    'analytics_release_stage_evidence'
  )),
  privacy_class TEXT NOT NULL CHECK (privacy_class = 'anonymous_operational'),
  raw_identifier_columns INTEGER NOT NULL DEFAULT 0
    CHECK (raw_identifier_columns = 0),
  content_columns INTEGER NOT NULL DEFAULT 0 CHECK (content_columns = 0),
  retention_days INTEGER NOT NULL CHECK (retention_days = 180),
  policy_version TEXT NOT NULL CHECK (
    policy_version = '2026-09-13.analytics-v2-part6'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

INSERT OR IGNORE INTO analytics_release_privacy_inventory
  (dataset_name, privacy_class, raw_identifier_columns, content_columns,
   retention_days, policy_version, created_at)
VALUES
  ('analytics_release_runs', 'anonymous_operational', 0, 0, 180,
   '2026-09-13.analytics-v2-part6', unixepoch()),
  ('analytics_release_source_evidence', 'anonymous_operational', 0, 0, 180,
   '2026-09-13.analytics-v2-part6', unixepoch()),
  ('analytics_release_stage_evidence', 'anonymous_operational', 0, 0, 180,
   '2026-09-13.analytics-v2-part6', unixepoch());

CREATE TRIGGER IF NOT EXISTS trg_analytics_release_runs_no_update
BEFORE UPDATE ON analytics_release_runs
BEGIN
  SELECT RAISE(ABORT, 'analytics release run is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_release_sources_no_update
BEFORE UPDATE ON analytics_release_source_evidence
BEGIN
  SELECT RAISE(ABORT, 'analytics release source evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_release_stages_no_update
BEFORE UPDATE ON analytics_release_stage_evidence
BEGIN
  SELECT RAISE(ABORT, 'analytics release stage evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_release_inventory_no_update
BEFORE UPDATE ON analytics_release_privacy_inventory
BEGIN
  SELECT RAISE(ABORT, 'analytics release privacy inventory is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_release_inventory_no_delete
BEFORE DELETE ON analytics_release_privacy_inventory
BEGIN
  SELECT RAISE(ABORT, 'analytics release privacy inventory is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_release_runs_guarded_delete
BEFORE DELETE ON analytics_release_runs
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_privacy_maintenance_guard guard
  WHERE guard.id = 1 AND guard.reason = 'retention'
    AND guard.expires_at >= unixepoch()
    AND OLD.retention_until <= unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'analytics release run deletion requires retention guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_release_sources_guarded_delete
BEFORE DELETE ON analytics_release_source_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_release_runs run
  JOIN analytics_privacy_maintenance_guard guard ON guard.id = 1
  WHERE run.run_id = OLD.run_id AND guard.reason = 'retention'
    AND guard.expires_at >= unixepoch()
    AND OLD.retention_until <= unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'analytics release source deletion requires retention guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_release_stages_guarded_delete
BEFORE DELETE ON analytics_release_stage_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_release_runs run
  JOIN analytics_privacy_maintenance_guard guard ON guard.id = 1
  WHERE run.run_id = OLD.run_id AND guard.reason = 'retention'
    AND guard.expires_at >= unixepoch()
    AND OLD.retention_until <= unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'analytics release stage deletion requires retention guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_release_source_authority
BEFORE INSERT ON analytics_release_source_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_release_runs run
  WHERE run.run_id = NEW.run_id
    AND run.action = 'enable_admin_shadow'
    AND run.source_mode IN ('synthetic', 'readonly_backfill')
    AND run.high_watermark_at = NEW.high_watermark_at
    AND run.expected_source_count > 0
    AND NEW.recorded_at >= run.created_at
    AND NEW.retention_until = run.retention_until
)
BEGIN
  SELECT RAISE(ABORT, 'analytics release source evidence lacks authority');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_release_stage_authority
BEFORE INSERT ON analytics_release_stage_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_release_runs run
  WHERE run.run_id = NEW.run_id
    AND NEW.recorded_at >= run.created_at
    AND NEW.retention_until = run.retention_until
)
BEGIN
  SELECT RAISE(ABORT, 'analytics release stage evidence lacks authority');
END;

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('0042-v1.3.9-analytics-release-ops');
