-- P04: additive manual-approval gate and fail-closed privacy projection fence.
-- Requires the existing 0039 ambassador schema and 0037 privacy guard.
-- This migration does not activate analytics or grant a product role.

CREATE TRIGGER IF NOT EXISTS trg_p04_ambassador_manual_activation
BEFORE INSERT ON ambassador_profile_transitions
WHEN NEW.from_status = 'draft' AND NEW.to_status = 'active'
  AND NEW.actor_kind != 'admin'
BEGIN
  SELECT RAISE(ABORT, 'ambassador activation requires manual admin approval');
END;

CREATE TRIGGER IF NOT EXISTS trg_p04_ambassador_partner_eligibility
BEFORE INSERT ON ambassador_profile_transitions
WHEN NEW.from_status = 'draft' AND NEW.to_status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM ambassador_profiles_v2 ambassador
    JOIN partner_profiles profile ON profile.id = ambassador.partner_profile_id
    JOIN partner_applications application ON application.id = profile.application_id
      AND application.telegram_id = profile.telegram_id
    JOIN user_roles role ON role.telegram_id = profile.telegram_id
      AND role.role = 'partner' AND role.status = 'active'
    JOIN users account ON account.telegram_id = profile.telegram_id
      AND account.is_blocked = 0
    WHERE ambassador.ambassador_id = NEW.ambassador_id
      AND profile.status = 'active'
      AND application.status = 'approved'
      AND application.age_confirmed = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'ambassador partner eligibility is invalid');
END;

-- A subject deletion invalidates immutable, historical daily/cohort aggregates.
-- Insertion belongs in the same D1 batch as pseudonym denial and raw deletion.
-- P05 may clear the fence only after all affected snapshots are rebuilt and
-- checked against the remaining source rows; clearing never happens here.
CREATE TABLE IF NOT EXISTS analytics_privacy_projection_fence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

CREATE TRIGGER IF NOT EXISTS trg_p04_privacy_fence_deletion_guard
BEFORE INSERT ON analytics_privacy_projection_fence
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_privacy_maintenance_guard guard
  WHERE guard.id = 1 AND guard.reason = 'user_deletion'
    AND guard.created_at <= unixepoch()
    AND guard.expires_at > unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'privacy projection fence requires active deletion guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_p04_privacy_fence_no_update
BEFORE UPDATE ON analytics_privacy_projection_fence
BEGIN
  SELECT RAISE(ABORT, 'privacy projection fence cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS trg_p04_privacy_fence_no_delete
BEFORE DELETE ON analytics_privacy_projection_fence
BEGIN
  SELECT RAISE(ABORT, 'privacy fence needs verified P05 reconciliation');
END;

CREATE TABLE IF NOT EXISTS analytics_p04_privacy_inventory (
  dataset_name TEXT PRIMARY KEY CHECK (
    dataset_name = 'analytics_privacy_projection_fence'
  ),
  privacy_class TEXT NOT NULL CHECK (privacy_class = 'operational'),
  raw_identifier_columns INTEGER NOT NULL CHECK (raw_identifier_columns = 0),
  content_columns INTEGER NOT NULL CHECK (content_columns = 0),
  policy_version TEXT NOT NULL CHECK (
    policy_version = '2026-09-24.analytics-v139-p04-v1'
  )
);

INSERT OR IGNORE INTO analytics_p04_privacy_inventory
  (dataset_name, privacy_class, raw_identifier_columns, content_columns,
   policy_version)
VALUES ('analytics_privacy_projection_fence', 'operational', 0, 0,
  '2026-09-24.analytics-v139-p04-v1');

CREATE TRIGGER IF NOT EXISTS trg_p04_privacy_inventory_no_update
BEFORE UPDATE ON analytics_p04_privacy_inventory
BEGIN
  SELECT RAISE(ABORT, 'P04 privacy inventory is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_p04_privacy_inventory_no_delete
BEFORE DELETE ON analytics_p04_privacy_inventory
BEGIN
  SELECT RAISE(ABORT, 'P04 privacy inventory cannot be deleted');
END;

INSERT OR IGNORE INTO re_schema_migrations(version)
VALUES ('1.3.9-owner-privacy-fence');
