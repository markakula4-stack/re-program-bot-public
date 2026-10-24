-- RE Program Bot v1.3.5 Part 3 — server plan authority readiness.
-- Additive and idempotent. This migration does not enable dual-read,
-- canonical-read, paid capabilities, Preview, Stars or public renaming.

CREATE TABLE IF NOT EXISTS plan_switch_readiness_runs (
  run_key TEXT PRIMARY KEY
    CHECK (length(run_key) BETWEEN 8 AND 128),
  schema_version INTEGER NOT NULL DEFAULT 1
    CHECK (schema_version = 1),
  triggered_by INTEGER NOT NULL CHECK (triggered_by > 0),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  total_users INTEGER NOT NULL CHECK (total_users >= 0),
  role_user_users INTEGER NOT NULL CHECK (role_user_users >= 0),
  role_partner_users INTEGER NOT NULL CHECK (role_partner_users >= 0),
  role_admin_users INTEGER NOT NULL CHECK (role_admin_users >= 0),
  canonical_complete_users INTEGER NOT NULL
    CHECK (canonical_complete_users >= 0),
  review_required_users INTEGER NOT NULL
    CHECK (review_required_users >= 0),
  blocking_users INTEGER NOT NULL CHECK (blocking_users >= 0),
  alias_canonical_users INTEGER NOT NULL
    CHECK (alias_canonical_users >= 0),
  alias_legacy_state_users INTEGER NOT NULL
    CHECK (alias_legacy_state_users >= 0),
  alias_legacy_plan_users INTEGER NOT NULL
    CHECK (alias_legacy_plan_users >= 0),
  alias_unknown_users INTEGER NOT NULL
    CHECK (alias_unknown_users >= 0),
  matched_users INTEGER NOT NULL CHECK (matched_users >= 0),
  different_users INTEGER NOT NULL CHECK (different_users >= 0),
  mapped_legacy_users INTEGER NOT NULL
    CHECK (mapped_legacy_users >= 0),
  missing_canonical_users INTEGER NOT NULL
    CHECK (missing_canonical_users >= 0),
  partial_canonical_users INTEGER NOT NULL
    CHECK (partial_canonical_users >= 0),
  manual_review_users INTEGER NOT NULL
    CHECK (manual_review_users >= 0),
  preserved_legacy_users INTEGER NOT NULL
    CHECK (preserved_legacy_users >= 0),
  mapped_legacy_mismatch_users INTEGER NOT NULL
    CHECK (mapped_legacy_mismatch_users >= 0),
  unknown_legacy_users INTEGER NOT NULL
    CHECK (unknown_legacy_users >= 0),
  ready_for_canonical_read INTEGER NOT NULL
    CHECK (ready_for_canonical_read IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    role_user_users + role_partner_users + role_admin_users = total_users
  ),
  CHECK (
    alias_canonical_users + alias_legacy_state_users +
    alias_legacy_plan_users + alias_unknown_users = total_users
  ),
  CHECK (
    matched_users + different_users + mapped_legacy_users +
    missing_canonical_users + partial_canonical_users +
    manual_review_users + preserved_legacy_users +
    mapped_legacy_mismatch_users + unknown_legacy_users = total_users
  ),
  CHECK (canonical_complete_users <= total_users),
  CHECK (review_required_users <= total_users),
  CHECK (blocking_users <= total_users),
  CHECK (
    ready_for_canonical_read =
      CASE WHEN blocking_users = 0 THEN 1 ELSE 0 END
  )
);

CREATE INDEX IF NOT EXISTS idx_plan_readiness_created
  ON plan_switch_readiness_runs(created_at DESC, run_key);

CREATE INDEX IF NOT EXISTS idx_plan_readiness_ready
  ON plan_switch_readiness_runs(ready_for_canonical_read, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_plan_readiness_runs_immutable_update
BEFORE UPDATE ON plan_switch_readiness_runs
BEGIN
  SELECT RAISE(ABORT, 'plan readiness runs are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_plan_readiness_runs_immutable_delete
BEFORE DELETE ON plan_switch_readiness_runs
BEGIN
  SELECT RAISE(ABORT, 'plan readiness runs are append-only');
END;

-- Part 5 release inventory is aggregate-only and append-only. It is captured
-- at the exact migration boundary without copying Telegram identifiers.
INSERT OR IGNORE INTO plan_legacy_audit
  (audit_key, audit_phase, users_total, access_rows_total,
   access_rows_missing, legacy_free_rows, legacy_trial_rows,
   legacy_team_rows, unknown_rows, canonical_backfilled_rows, note)
SELECT
  'v1.3.5-part5-release',
  'part5_release',
  (SELECT COUNT(*) FROM users),
  (SELECT COUNT(*) FROM user_access),
  (SELECT COUNT(*) FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM user_access a WHERE a.telegram_id = u.telegram_id
    )),
  (SELECT COUNT(*) FROM user_access WHERE lower(access_tier) = 'free'),
  (SELECT COUNT(*) FROM user_access WHERE lower(access_tier) = 'trial'),
  (SELECT COUNT(*) FROM user_access WHERE lower(access_tier) = 'team'),
  (SELECT COUNT(*) FROM user_access
    WHERE lower(COALESCE(access_tier, '')) NOT IN ('free', 'trial', 'team')),
  (SELECT COUNT(*) FROM user_plans
    WHERE source_code = 'v1.3.5:legacy_free'),
  'Part 5 release snapshot: legacy data preserved; plan read switches remain disabled.';

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.5-plan-authority');
