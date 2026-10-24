-- RE Program Bot v1.3.5 Part 2 — compatibility adapter controls.
-- Additive and idempotent. Both switches start disabled. The Worker requires
-- matching hard flags as well, so a database change alone cannot switch reads.

CREATE TABLE IF NOT EXISTS plan_compatibility_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  dual_read_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (dual_read_enabled IN (0, 1)),
  canonical_read_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (canonical_read_enabled IN (0, 1)),
  updated_by INTEGER NOT NULL DEFAULT 0,
  update_reason TEXT NOT NULL DEFAULT 'initial safe state',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (canonical_read_enabled <= dual_read_enabled)
);

INSERT OR IGNORE INTO plan_compatibility_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS plan_compatibility_setting_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL
    CHECK (action IN ('initialized', 'dual_read_changed', 'canonical_read_changed',
      'rollback')),
  from_dual_read_enabled INTEGER NOT NULL CHECK (from_dual_read_enabled IN (0, 1)),
  to_dual_read_enabled INTEGER NOT NULL CHECK (to_dual_read_enabled IN (0, 1)),
  from_canonical_read_enabled INTEGER NOT NULL
    CHECK (from_canonical_read_enabled IN (0, 1)),
  to_canonical_read_enabled INTEGER NOT NULL
    CHECK (to_canonical_read_enabled IN (0, 1)),
  actor_id INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  event_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (to_canonical_read_enabled <= to_dual_read_enabled)
);

CREATE INDEX IF NOT EXISTS idx_plan_compatibility_setting_events_date
  ON plan_compatibility_setting_events(created_at DESC, id DESC);

INSERT OR IGNORE INTO plan_compatibility_setting_events
  (action, from_dual_read_enabled, to_dual_read_enabled,
   from_canonical_read_enabled, to_canonical_read_enabled, actor_id,
   reason, event_key)
VALUES
  ('initialized', 0, 0, 0, 0, 0,
   'Part 2 starts with dual-read and canonical-read disabled.',
   'v1.3.5-part2-initial-safe-state');

CREATE TRIGGER IF NOT EXISTS trg_plan_compatibility_events_immutable_update
BEFORE UPDATE ON plan_compatibility_setting_events
BEGIN
  SELECT RAISE(ABORT, 'plan compatibility events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_plan_compatibility_events_immutable_delete
BEFORE DELETE ON plan_compatibility_setting_events
BEGIN
  SELECT RAISE(ABORT, 'plan compatibility events are append-only');
END;

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.5-plan-compatibility');
