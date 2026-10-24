-- RE Program Bot v1.4.0 Part 6 — closed cabinet release evidence.
--
-- Additive and idempotent. Only aggregate operational evidence is stored.
-- No Telegram ID, partner/application/offer row, contact, note, initData,
-- session, cursor, payment identifier, secret or recovery payload is stored.
-- This migration does not wire or deploy a Worker, publish a Mini App, alter a
-- route, enable a flag, read an authority table, or make a public rollout.

CREATE TABLE IF NOT EXISTS re_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cabinet_release_v1_runs (
  run_id TEXT PRIMARY KEY CHECK (
    length(run_id) = 36 AND run_id = lower(run_id)
  ),
  action TEXT NOT NULL CHECK (action IN (
    'prepare_closed', 'enable_admin_shadow', 'disable'
  )),
  source_mode TEXT NOT NULL CHECK (source_mode IN ('none', 'synthetic')),
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
  plan_digest TEXT NOT NULL UNIQUE CHECK (
    length(plan_digest) = 64
    AND plan_digest = lower(plan_digest)
    AND plan_digest NOT GLOB '*[^0-9a-f]*'
  ),
  expected_stage_count INTEGER NOT NULL CHECK (expected_stage_count = 8),
  expected_canary_count INTEGER NOT NULL CHECK (
    expected_canary_count = CASE
      WHEN action = 'enable_admin_shadow' THEN 1 ELSE 0 END
  ),
  status TEXT NOT NULL CHECK (status IN ('complete', 'blocked')),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= created_at
    AND retention_until <= created_at + 15552000
  ),
  policy_version TEXT NOT NULL CHECK (
    policy_version = '2026-09-14.cabinet-v1-part6'
  ),
  CHECK (
    (action = 'enable_admin_shadow' AND source_mode = 'synthetic')
    OR (action != 'enable_admin_shadow' AND source_mode = 'none')
  )
);

CREATE INDEX IF NOT EXISTS idx_cabinet_release_v1_runs_time
  ON cabinet_release_v1_runs(created_at, run_id);

CREATE INDEX IF NOT EXISTS idx_cabinet_release_v1_runs_retention
  ON cabinet_release_v1_runs(retention_until, run_id);

CREATE TABLE IF NOT EXISTS cabinet_release_v1_stage_evidence (
  run_id TEXT NOT NULL REFERENCES cabinet_release_v1_runs(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  stage_order INTEGER NOT NULL CHECK (stage_order BETWEEN 1 AND 8),
  stage_kind TEXT NOT NULL CHECK (stage_kind IN (
    'backup', 'restore', 'schema', 'stable_regression',
    'owner_scope', 'closed_canary', 'replay', 'rollback'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'blocked', 'skipped')),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'none', 'not_applicable', 'backup_missing', 'restore_failed',
    'schema_mismatch', 'runtime_regression', 'scope_leak',
    'canary_mismatch', 'replay_mismatch', 'rollback_failed'
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
    policy_version = '2026-09-14.cabinet-v1-part6'
  ),
  PRIMARY KEY (run_id, stage_order),
  UNIQUE (run_id, stage_kind),
  CHECK (stage_order = CASE stage_kind
    WHEN 'backup' THEN 1
    WHEN 'restore' THEN 2
    WHEN 'schema' THEN 3
    WHEN 'stable_regression' THEN 4
    WHEN 'owner_scope' THEN 5
    WHEN 'closed_canary' THEN 6
    WHEN 'replay' THEN 7
    WHEN 'rollback' THEN 8
    ELSE 0 END),
  CHECK (
    (outcome = 'passed' AND reason_code = 'none'
      AND unexplained_delta = 0 AND observed_count = expected_count)
    OR (outcome = 'skipped' AND reason_code = 'not_applicable'
      AND unexplained_delta = 0)
    OR outcome = 'blocked'
  )
);

CREATE INDEX IF NOT EXISTS idx_cabinet_release_v1_stages_retention
  ON cabinet_release_v1_stage_evidence(retention_until, run_id);

CREATE TABLE IF NOT EXISTS cabinet_release_v1_canary_evidence (
  run_id TEXT PRIMARY KEY REFERENCES cabinet_release_v1_runs(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  route_count INTEGER NOT NULL CHECK (route_count = 6),
  tariff_count INTEGER NOT NULL CHECK (tariff_count = 3),
  quota_count INTEGER NOT NULL CHECK (quota_count = 6),
  owner_projector_count INTEGER NOT NULL CHECK (owner_projector_count = 5),
  foreign_denial_count INTEGER NOT NULL CHECK (foreign_denial_count >= 4),
  cursor_denial_count INTEGER NOT NULL CHECK (cursor_denial_count >= 4),
  recovery_denial_count INTEGER NOT NULL CHECK (recovery_denial_count >= 4),
  scope_leak_count INTEGER NOT NULL CHECK (scope_leak_count = 0),
  replay_new_rows INTEGER NOT NULL CHECK (replay_new_rows = 0),
  public_enabled INTEGER NOT NULL CHECK (public_enabled = 0),
  worker_deployed INTEGER NOT NULL CHECK (worker_deployed = 0),
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
    policy_version = '2026-09-14.cabinet-v1-part6'
  )
);

CREATE INDEX IF NOT EXISTS idx_cabinet_release_v1_canary_retention
  ON cabinet_release_v1_canary_evidence(retention_until, run_id);

CREATE TABLE IF NOT EXISTS cabinet_release_v1_privacy_inventory (
  dataset_name TEXT PRIMARY KEY CHECK (dataset_name IN (
    'cabinet_release_v1_runs',
    'cabinet_release_v1_stage_evidence',
    'cabinet_release_v1_canary_evidence'
  )),
  privacy_class TEXT NOT NULL CHECK (privacy_class = 'anonymous_operational'),
  raw_identifier_columns INTEGER NOT NULL CHECK (raw_identifier_columns = 0),
  content_columns INTEGER NOT NULL CHECK (content_columns = 0),
  retention_days INTEGER NOT NULL CHECK (retention_days = 180),
  policy_version TEXT NOT NULL CHECK (
    policy_version = '2026-09-14.cabinet-v1-part6'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

INSERT OR IGNORE INTO cabinet_release_v1_privacy_inventory (
  dataset_name, privacy_class, raw_identifier_columns, content_columns,
  retention_days, policy_version, created_at
) VALUES
  ('cabinet_release_v1_runs', 'anonymous_operational', 0, 0, 180,
   '2026-09-14.cabinet-v1-part6', unixepoch()),
  ('cabinet_release_v1_stage_evidence', 'anonymous_operational', 0, 0, 180,
   '2026-09-14.cabinet-v1-part6', unixepoch()),
  ('cabinet_release_v1_canary_evidence', 'anonymous_operational', 0, 0, 180,
   '2026-09-14.cabinet-v1-part6', unixepoch());

CREATE TRIGGER IF NOT EXISTS trg_cabinet_release_v1_runs_no_update
BEFORE UPDATE ON cabinet_release_v1_runs
BEGIN
  SELECT RAISE(ABORT, 'cabinet release run is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_release_v1_runs_guarded_delete
BEFORE DELETE ON cabinet_release_v1_runs
WHEN OLD.retention_until > unixepoch() OR NOT EXISTS (
  SELECT 1 FROM cabinet_privacy_maintenance_guard guard
  WHERE guard.id = 1 AND guard.reason = 'retention'
    AND guard.subject_telegram_id IS NULL
    AND guard.expires_at >= unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet release run deletion requires expired retention guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_release_v1_stages_no_update
BEFORE UPDATE ON cabinet_release_v1_stage_evidence
BEGIN
  SELECT RAISE(ABORT, 'cabinet release stage is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_release_v1_stages_guarded_delete
BEFORE DELETE ON cabinet_release_v1_stage_evidence
WHEN OLD.retention_until > unixepoch() OR NOT EXISTS (
  SELECT 1 FROM cabinet_privacy_maintenance_guard guard
  WHERE guard.id = 1 AND guard.reason = 'retention'
    AND guard.subject_telegram_id IS NULL
    AND guard.expires_at >= unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet release stage deletion requires expired retention guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_release_v1_canary_no_update
BEFORE UPDATE ON cabinet_release_v1_canary_evidence
BEGIN
  SELECT RAISE(ABORT, 'cabinet release canary is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_release_v1_canary_guarded_delete
BEFORE DELETE ON cabinet_release_v1_canary_evidence
WHEN OLD.retention_until > unixepoch() OR NOT EXISTS (
  SELECT 1 FROM cabinet_privacy_maintenance_guard guard
  WHERE guard.id = 1 AND guard.reason = 'retention'
    AND guard.subject_telegram_id IS NULL
    AND guard.expires_at >= unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet release canary deletion requires expired retention guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_release_v1_inventory_no_update
BEFORE UPDATE ON cabinet_release_v1_privacy_inventory
BEGIN
  SELECT RAISE(ABORT, 'cabinet release inventory is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_release_v1_inventory_no_delete
BEFORE DELETE ON cabinet_release_v1_privacy_inventory
BEGIN
  SELECT RAISE(ABORT, 'cabinet release inventory is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_release_v1_stage_authority
BEFORE INSERT ON cabinet_release_v1_stage_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_release_v1_runs run
  WHERE run.run_id = NEW.run_id
    AND NEW.recorded_at >= run.created_at
    AND NEW.retention_until = run.retention_until
    AND (
      (NEW.stage_kind IN (
        'backup', 'restore', 'schema', 'stable_regression', 'rollback'
      ) AND NEW.outcome = 'passed' AND NEW.reason_code = 'none')
      OR
      (run.action = 'enable_admin_shadow'
        AND NEW.stage_kind IN ('owner_scope', 'closed_canary', 'replay')
        AND NEW.outcome = 'passed' AND NEW.reason_code = 'none')
      OR
      (run.action != 'enable_admin_shadow'
        AND NEW.stage_kind IN ('owner_scope', 'closed_canary', 'replay')
        AND NEW.outcome = 'skipped'
        AND NEW.reason_code = 'not_applicable')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet release stage lacks run authority');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_release_v1_canary_authority
BEFORE INSERT ON cabinet_release_v1_canary_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_release_v1_runs run
  WHERE run.run_id = NEW.run_id
    AND run.action = 'enable_admin_shadow'
    AND run.source_mode = 'synthetic'
    AND run.expected_canary_count = 1
    AND NEW.recorded_at >= run.created_at
    AND NEW.retention_until = run.retention_until
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet release canary lacks run authority');
END;

INSERT OR IGNORE INTO re_schema_migrations(version)
VALUES ('0048-v1.4.0-cabinet-release-ops');
