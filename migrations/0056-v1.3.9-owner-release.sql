-- P05: persistent owner audience over the existing admin_shadow engine.
-- The 0037 settings CHECK remains unchanged. This audience starts closed;
-- enabling it requires an explicit operator action after source reconciliation.
CREATE TABLE IF NOT EXISTS analytics_v139_owner_runtime (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  audience_mode TEXT NOT NULL DEFAULT 'off'
    CHECK (audience_mode IN ('off', 'owner_only')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  CHECK (enabled = 0 OR audience_mode = 'owner_only')
);
INSERT OR IGNORE INTO analytics_v139_owner_runtime
  (id, audience_mode, enabled, updated_at) VALUES (1, 'off', 0, unixepoch());

-- Only explicitly admitted partner accounts can exercise the ordinary-role
-- acceptance path. Owner identity still comes from ADMIN_ID in the Worker.
CREATE TABLE IF NOT EXISTS analytics_v139_partner_pilot (
  telegram_id INTEGER PRIMARY KEY CHECK (telegram_id > 0),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  admitted_at INTEGER NOT NULL CHECK (admitted_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > admitted_at
    AND expires_at <= admitted_at + 2592000)
);

-- P03/P04 readers use this view. A permanent audience setting never overrides
-- the old engine gate, a privacy fence, or a disabled environment flag.
CREATE VIEW IF NOT EXISTS analytics_v139_active_shadow_authority AS
SELECT 1 AS active FROM analytics_v2_settings settings
JOIN analytics_v139_owner_runtime audience ON audience.id = 1
WHERE settings.id = 1 AND settings.rollout_mode = 'admin_shadow'
  AND settings.master_enabled = 1 AND settings.ingest_enabled = 1
  AND settings.projections_enabled = 1 AND settings.ambassador_enabled = 1
  AND audience.audience_mode = 'owner_only' AND audience.enabled = 1
  AND NOT EXISTS (SELECT 1 FROM analytics_privacy_projection_fence);

-- Replacing P04's unconditional deletion veto is safe only with a proof
-- written after the latest denial and after all current checkpoints were
-- rebuilt and reconciled. Old proof cannot clear a later deletion.
CREATE TABLE IF NOT EXISTS analytics_privacy_fence_reconciliation (
  fence_created_at INTEGER NOT NULL CHECK (fence_created_at > 0),
  last_denial_at INTEGER NOT NULL CHECK (last_denial_at > 0),
  checkpoint_count INTEGER NOT NULL CHECK (checkpoint_count >= 0),
  validated_at INTEGER NOT NULL CHECK (validated_at > last_denial_at),
  PRIMARY KEY (fence_created_at, validated_at)
);

CREATE TRIGGER IF NOT EXISTS trg_p05_fence_proof_insert
BEFORE INSERT ON analytics_privacy_fence_reconciliation
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_privacy_projection_fence f
  WHERE f.id = 1 AND f.created_at = NEW.fence_created_at
) OR NEW.last_denial_at != COALESCE(
  (SELECT MAX(denied_at) FROM analytics_privacy_denials), 0
) OR NEW.validated_at > unixepoch()
  OR NEW.checkpoint_count != (SELECT COUNT(*) FROM analytics_projection_checkpoints)
  OR (NEW.checkpoint_count = 0 AND EXISTS (
      SELECT 1 FROM canonical_analytics_events WHERE retention_until > unixepoch()
    ))
  OR EXISTS (
    SELECT 1 FROM analytics_projection_checkpoints checkpoint
    LEFT JOIN analytics_projection_snapshots snapshot
      ON snapshot.snapshot_id = checkpoint.current_snapshot_id
    LEFT JOIN analytics_projection_reconciliation reconciliation
      ON reconciliation.snapshot_id = checkpoint.current_snapshot_id
    WHERE snapshot.created_at <= NEW.last_denial_at
      OR snapshot.snapshot_id IS NULL OR reconciliation.snapshot_id IS NULL
      OR reconciliation.source_delta != 0
      OR reconciliation.canonical_delta != 0
      OR reconciliation.projection_delta != 0
  )
  OR EXISTS (
    SELECT 1 FROM canonical_analytics_events event
    JOIN analytics_privacy_denials denied
      ON denied.subject_pseudonym = event.actor_pseudonym
  )
BEGIN
  SELECT RAISE(ABORT, 'privacy fence reconciliation is incomplete');
END;

CREATE TRIGGER IF NOT EXISTS trg_p05_fence_proof_no_update
BEFORE UPDATE ON analytics_privacy_fence_reconciliation
BEGIN SELECT RAISE(ABORT, 'privacy fence proof is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_p05_fence_proof_no_delete
BEFORE DELETE ON analytics_privacy_fence_reconciliation
BEGIN SELECT RAISE(ABORT, 'privacy fence proof is immutable'); END;

DROP TRIGGER IF EXISTS trg_p04_privacy_fence_no_delete;
CREATE TRIGGER IF NOT EXISTS trg_p05_privacy_fence_verified_delete
BEFORE DELETE ON analytics_privacy_projection_fence
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_privacy_fence_reconciliation proof
  WHERE proof.fence_created_at = OLD.created_at
    AND proof.last_denial_at = COALESCE(
      (SELECT MAX(denied_at) FROM analytics_privacy_denials), 0)
    AND proof.checkpoint_count = (
      SELECT COUNT(*) FROM analytics_projection_checkpoints)
    AND proof.validated_at > proof.last_denial_at
    AND proof.validated_at <= unixepoch()
    AND NOT EXISTS (
      SELECT 1 FROM analytics_projection_checkpoints checkpoint
      JOIN analytics_projection_snapshots snapshot
        ON snapshot.snapshot_id = checkpoint.current_snapshot_id
      WHERE snapshot.created_at <= proof.last_denial_at
    )
)
BEGIN
  SELECT RAISE(ABORT, 'privacy fence requires current reconciliation proof');
END;

INSERT OR IGNORE INTO re_schema_migrations(version)
VALUES ('1.3.9-owner-release');
