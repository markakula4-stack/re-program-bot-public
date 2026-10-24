-- RE Program Bot v1.3.9 Part 5 — closed admin analytics UX and retention audit.
--
-- Additive and idempotent. This migration stores only opaque callback/session
-- evidence and aggregate retention plans. It does not wire the Worker, enable a
-- rollout flag, apply itself to remote D1, or expose analytics publicly.

CREATE TABLE IF NOT EXISTS analytics_admin_view_sessions (
  session_id TEXT PRIMARY KEY CHECK (
    length(session_id) = 36 AND session_id = lower(session_id)
  ),
  session_token_hash TEXT NOT NULL UNIQUE CHECK (
    length(session_token_hash) = 64
    AND session_token_hash = lower(session_token_hash)
    AND session_token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  admin_pseudonym TEXT NOT NULL CHECK (
    length(admin_pseudonym) = 64
    AND admin_pseudonym = lower(admin_pseudonym)
    AND admin_pseudonym NOT GLOB '*[^0-9a-f]*'
  ),
  screen TEXT NOT NULL CHECK (screen IN (
    'overview', 'product_funnel', 'retention', 'ambassadors',
    'diagnostics', 'privacy'
  )),
  metric_date INTEGER NOT NULL CHECK (
    metric_date > 0 AND metric_date % 86400 = 0
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  expires_at INTEGER NOT NULL CHECK (
    expires_at > created_at AND expires_at <= created_at + 900
  ),
  closed_at INTEGER CHECK (
    closed_at IS NULL OR closed_at BETWEEN created_at AND expires_at
  ),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= expires_at
    AND retention_until <= created_at + 15552000
  ),
  policy_version TEXT NOT NULL CHECK (
    policy_version = '2026-09-13.analytics-v2-part5'
  )
);

CREATE INDEX IF NOT EXISTS idx_analytics_admin_sessions_actor
  ON analytics_admin_view_sessions(admin_pseudonym, expires_at, session_id);

CREATE INDEX IF NOT EXISTS idx_analytics_admin_sessions_retention
  ON analytics_admin_view_sessions(retention_until, session_id);

CREATE TABLE IF NOT EXISTS analytics_admin_action_requests (
  request_id TEXT PRIMARY KEY CHECK (
    length(request_id) = 36 AND request_id = lower(request_id)
  ),
  request_token_hash TEXT NOT NULL UNIQUE CHECK (
    length(request_token_hash) = 64
    AND request_token_hash = lower(request_token_hash)
    AND request_token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  session_id TEXT NOT NULL REFERENCES analytics_admin_view_sessions(session_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  admin_pseudonym TEXT NOT NULL CHECK (
    length(admin_pseudonym) = 64
    AND admin_pseudonym = lower(admin_pseudonym)
    AND admin_pseudonym NOT GLOB '*[^0-9a-f]*'
  ),
  action_kind TEXT NOT NULL CHECK (action_kind = 'retention'),
  cutoff_at INTEGER NOT NULL CHECK (cutoff_at > 0),
  plan_digest TEXT NOT NULL CHECK (
    length(plan_digest) = 64
    AND plan_digest = lower(plan_digest)
    AND plan_digest NOT GLOB '*[^0-9a-f]*'
  ),
  planned_rows INTEGER NOT NULL CHECK (planned_rows >= 0),
  dataset_count INTEGER NOT NULL CHECK (dataset_count = 13),
  session_revision INTEGER NOT NULL CHECK (session_revision > 0),
  created_at INTEGER NOT NULL CHECK (
    created_at > 0 AND cutoff_at <= created_at
  ),
  expires_at INTEGER NOT NULL CHECK (
    expires_at > created_at AND expires_at <= created_at + 600
  ),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= expires_at
    AND retention_until <= created_at + 15552000
  ),
  policy_version TEXT NOT NULL CHECK (
    policy_version = '2026-09-13.analytics-v2-part5'
  )
);

CREATE INDEX IF NOT EXISTS idx_analytics_admin_requests_session
  ON analytics_admin_action_requests(session_id, created_at, request_id);

CREATE INDEX IF NOT EXISTS idx_analytics_admin_requests_retention
  ON analytics_admin_action_requests(retention_until, request_id);

CREATE TABLE IF NOT EXISTS analytics_admin_action_items (
  request_id TEXT NOT NULL REFERENCES analytics_admin_action_requests(request_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  dataset_name TEXT NOT NULL CHECK (dataset_name IN (
    'analytics_admin_action_results', 'analytics_admin_action_items',
    'analytics_admin_action_requests', 'analytics_admin_view_sessions',
    'analytics_projection_snapshot_bindings',
    'analytics_projection_attribution_bindings',
    'analytics_daily_actor_facts', 'analytics_attribution_decisions',
    'analytics_attribution_touchpoints', 'canonical_analytics_events',
    'analytics_ingestion_conflicts', 'analytics_ingestion_issues',
    'analytics_ingestion_receipts'
  )),
  planned_rows INTEGER NOT NULL CHECK (planned_rows >= 0),
  item_digest TEXT NOT NULL CHECK (
    length(item_digest) = 64
    AND item_digest = lower(item_digest)
    AND item_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= created_at
    AND retention_until <= created_at + 15552000
  ),
  PRIMARY KEY (request_id, dataset_name)
);

CREATE INDEX IF NOT EXISTS idx_analytics_admin_items_retention
  ON analytics_admin_action_items(retention_until, request_id);

CREATE TABLE IF NOT EXISTS analytics_admin_action_results (
  result_id TEXT PRIMARY KEY CHECK (
    length(result_id) = 36 AND result_id = lower(result_id)
  ),
  request_id TEXT NOT NULL UNIQUE
    REFERENCES analytics_admin_action_requests(request_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'completed', 'cancelled', 'stale', 'failed'
  )),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'none', 'admin_cancelled', 'plan_changed', 'guard_busy',
    'database_rejected'
  )),
  actual_rows INTEGER NOT NULL CHECK (actual_rows >= 0),
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64
    AND evidence_digest = lower(evidence_digest)
    AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  completed_at INTEGER NOT NULL CHECK (completed_at > 0),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= completed_at
    AND retention_until <= completed_at + 15552000
  ),
  policy_version TEXT NOT NULL CHECK (
    policy_version = '2026-09-13.analytics-v2-part5'
  ),
  CHECK (
    (outcome = 'completed' AND reason_code = 'none')
    OR (outcome != 'completed' AND reason_code != 'none')
  ),
  CHECK (outcome = 'completed' OR actual_rows = 0)
);

CREATE INDEX IF NOT EXISTS idx_analytics_admin_results_retention
  ON analytics_admin_action_results(retention_until, request_id);

CREATE TABLE IF NOT EXISTS analytics_admin_privacy_inventory (
  dataset_name TEXT PRIMARY KEY CHECK (dataset_name IN (
    'analytics_admin_view_sessions', 'analytics_admin_action_requests',
    'analytics_admin_action_items', 'analytics_admin_action_results'
  )),
  privacy_class TEXT NOT NULL CHECK (privacy_class IN (
    'pseudonymous', 'anonymous', 'operational'
  )),
  raw_identifier_columns INTEGER NOT NULL DEFAULT 0
    CHECK (raw_identifier_columns = 0),
  content_columns INTEGER NOT NULL DEFAULT 0 CHECK (content_columns = 0),
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 180),
  deletion_mode TEXT NOT NULL CHECK (deletion_mode = 'guarded_retention'),
  policy_version TEXT NOT NULL CHECK (
    policy_version = '2026-09-13.analytics-v2-part5'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

INSERT OR IGNORE INTO analytics_admin_privacy_inventory
  (dataset_name, privacy_class, raw_identifier_columns, content_columns,
   retention_days, deletion_mode, policy_version, created_at)
VALUES
  ('analytics_admin_view_sessions', 'pseudonymous', 0, 0, 180,
   'guarded_retention', '2026-09-13.analytics-v2-part5', unixepoch()),
  ('analytics_admin_action_requests', 'pseudonymous', 0, 0, 180,
   'guarded_retention', '2026-09-13.analytics-v2-part5', unixepoch()),
  ('analytics_admin_action_items', 'anonymous', 0, 0, 180,
   'guarded_retention', '2026-09-13.analytics-v2-part5', unixepoch()),
  ('analytics_admin_action_results', 'anonymous', 0, 0, 180,
   'guarded_retention', '2026-09-13.analytics-v2-part5', unixepoch());

CREATE TRIGGER IF NOT EXISTS trg_analytics_admin_session_controlled_update
BEFORE UPDATE ON analytics_admin_view_sessions
WHEN NEW.session_id IS NOT OLD.session_id
  OR NEW.session_token_hash IS NOT OLD.session_token_hash
  OR NEW.admin_pseudonym IS NOT OLD.admin_pseudonym
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.retention_until IS NOT OLD.retention_until
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.revision != OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
  OR OLD.closed_at IS NOT NULL
  OR (NEW.closed_at IS NOT NULL AND NEW.closed_at != NEW.updated_at)
BEGIN
  SELECT RAISE(ABORT, 'analytics admin session update is invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_admin_sessions_guarded_delete
BEFORE DELETE ON analytics_admin_view_sessions
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_privacy_maintenance_guard guard
  WHERE guard.id = 1 AND guard.reason = 'retention'
    AND guard.expires_at >= unixepoch()
    AND OLD.retention_until <= unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'analytics admin session deletion requires retention guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_admin_requests_no_update
BEFORE UPDATE ON analytics_admin_action_requests
BEGIN
  SELECT RAISE(ABORT, 'analytics admin action request is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_admin_requests_guarded_delete
BEFORE DELETE ON analytics_admin_action_requests
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_privacy_maintenance_guard guard
  WHERE guard.id = 1 AND guard.reason = 'retention'
    AND guard.expires_at >= unixepoch()
    AND OLD.retention_until <= unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'analytics admin action request deletion requires retention guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_admin_items_no_update
BEFORE UPDATE ON analytics_admin_action_items
BEGIN
  SELECT RAISE(ABORT, 'analytics admin action item is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_admin_items_guarded_delete
BEFORE DELETE ON analytics_admin_action_items
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_admin_action_requests request
  JOIN analytics_privacy_maintenance_guard guard ON guard.id = 1
  WHERE request.request_id = OLD.request_id
    AND guard.reason = 'retention' AND guard.expires_at >= unixepoch()
    AND OLD.retention_until <= unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'analytics admin action item deletion requires retention guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_admin_results_no_update
BEFORE UPDATE ON analytics_admin_action_results
BEGIN
  SELECT RAISE(ABORT, 'analytics admin action result is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_admin_results_guarded_delete
BEFORE DELETE ON analytics_admin_action_results
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_admin_action_requests request
  JOIN analytics_privacy_maintenance_guard guard ON guard.id = 1
  WHERE request.request_id = OLD.request_id
    AND guard.reason = 'retention' AND guard.expires_at >= unixepoch()
    AND OLD.retention_until <= unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'analytics admin action result deletion requires retention guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_admin_inventory_no_update
BEFORE UPDATE ON analytics_admin_privacy_inventory
BEGIN
  SELECT RAISE(ABORT, 'analytics admin privacy inventory is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_admin_inventory_no_delete
BEFORE DELETE ON analytics_admin_privacy_inventory
BEGIN
  SELECT RAISE(ABORT, 'analytics admin privacy inventory cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_admin_request_authority
BEFORE INSERT ON analytics_admin_action_requests
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_admin_view_sessions session
  WHERE session.session_id = NEW.session_id
    AND session.admin_pseudonym = NEW.admin_pseudonym
    AND session.screen = 'privacy'
    AND session.revision = NEW.session_revision
    AND session.closed_at IS NULL
    AND session.expires_at >= NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'analytics admin action session authority mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_admin_item_authority
BEFORE INSERT ON analytics_admin_action_items
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_admin_action_requests request
  WHERE request.request_id = NEW.request_id
    AND request.created_at = NEW.created_at
    AND request.retention_until = NEW.retention_until
)
BEGIN
  SELECT RAISE(ABORT, 'analytics admin action item authority mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_admin_result_authority
BEFORE INSERT ON analytics_admin_action_results
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_admin_action_requests request
  WHERE request.request_id = NEW.request_id
    AND request.created_at <= NEW.completed_at
    AND (
      NEW.outcome != 'completed'
      OR (
        request.expires_at >= NEW.completed_at
        AND request.planned_rows = NEW.actual_rows
        AND request.dataset_count = (
          SELECT COUNT(*) FROM analytics_admin_action_items item
          WHERE item.request_id = request.request_id
        )
        AND request.planned_rows = (
          SELECT COALESCE(SUM(item.planned_rows), 0)
          FROM analytics_admin_action_items item
          WHERE item.request_id = request.request_id
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'analytics admin action result authority mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_admin_retention_completion
BEFORE INSERT ON analytics_admin_action_results
WHEN NEW.outcome = 'completed' AND EXISTS (
  SELECT 1 FROM analytics_admin_action_requests request
  WHERE request.request_id = NEW.request_id
    AND (
      EXISTS (SELECT 1 FROM analytics_admin_action_results row WHERE row.retention_until <= request.cutoff_at)
      OR EXISTS (SELECT 1 FROM analytics_admin_action_items row WHERE row.retention_until <= request.cutoff_at)
      OR EXISTS (SELECT 1 FROM analytics_admin_action_requests row WHERE row.retention_until <= request.cutoff_at)
      OR EXISTS (SELECT 1 FROM analytics_admin_view_sessions row WHERE row.retention_until <= request.cutoff_at)
      OR EXISTS (SELECT 1 FROM analytics_projection_snapshot_bindings row WHERE row.retention_until <= request.cutoff_at)
      OR EXISTS (SELECT 1 FROM analytics_projection_attribution_bindings row WHERE row.retention_until <= request.cutoff_at)
      OR EXISTS (SELECT 1 FROM analytics_daily_actor_facts row WHERE row.retention_until <= request.cutoff_at)
      OR EXISTS (SELECT 1 FROM analytics_attribution_decisions row WHERE row.retention_until <= request.cutoff_at)
      OR EXISTS (SELECT 1 FROM analytics_attribution_touchpoints row WHERE row.retention_until <= request.cutoff_at)
      OR EXISTS (SELECT 1 FROM canonical_analytics_events row WHERE row.retention_until <= request.cutoff_at)
      OR EXISTS (SELECT 1 FROM analytics_ingestion_conflicts row WHERE row.retention_until <= request.cutoff_at)
      OR EXISTS (SELECT 1 FROM analytics_ingestion_issues row WHERE row.retention_until <= request.cutoff_at)
      OR EXISTS (SELECT 1 FROM analytics_ingestion_receipts row WHERE row.retention_until <= request.cutoff_at)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'analytics retention completion has remaining rows');
END;
