-- v1.4.1 Part2: additive, closed foundations only.
-- Numbers are provisional until the reviewed current-main/live-ledger inventory.
-- No old business table, trigger, payment grant, user row or rollout is changed.
-- Only new foundations/policy seed and reviewed migration-ledger markers are written.
-- Apply only through the reviewed expand controller, never unreviewed history.

-- No feature flag or assignment is enabled/inserted.
-- PERSONAL METADATA WRITERS remain closed until approved Part4 cleanup covers
-- subjects AND actors/authors; no deleting another subject's active grant to erase its author.
-- Existing privacy guards below protect new-table cleanup; no old triggers change.

CREATE TABLE IF NOT EXISTS entitlement_decision_audit (
  audit_id TEXT PRIMARY KEY NOT NULL CHECK (typeof(audit_id) = 'text' AND length(audit_id) BETWEEN 1 AND 96 AND trim(audit_id) = audit_id),
  event_key TEXT NOT NULL UNIQUE CHECK (typeof(event_key) = 'text' AND length(event_key) = 64 AND event_key NOT GLOB '*[^0-9a-f]*'),
  policy_version TEXT NOT NULL CHECK (typeof(policy_version) = 'text' AND length(policy_version) BETWEEN 1 AND 128 AND trim(policy_version) = policy_version),
  capability TEXT NOT NULL CHECK (typeof(capability) = 'text' AND length(capability) BETWEEN 1 AND 128 AND trim(capability) = capability),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('customer','trusted_service')),
  subject_telegram_id INTEGER CHECK ((subject_telegram_id IS NULL OR (typeof(subject_telegram_id) = 'integer' AND subject_telegram_id > 0))),
  actor_telegram_id INTEGER CHECK ((actor_telegram_id IS NULL OR (typeof(actor_telegram_id) = 'integer' AND actor_telegram_id > 0))),
  resource_ref TEXT CHECK ((resource_ref IS NULL OR (typeof(resource_ref) = 'text' AND length(resource_ref) BETWEEN 1 AND 192 AND trim(resource_ref) = resource_ref))),
  decision TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  reason_code TEXT NOT NULL CHECK (typeof(reason_code) = 'text' AND length(reason_code) BETWEEN 1 AND 96 AND trim(reason_code) = reason_code AND reason_code NOT GLOB '*[^a-z0-9_]*'),
  source_fingerprint TEXT NOT NULL CHECK (typeof(source_fingerprint) = 'text' AND length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
  operation_ref TEXT CHECK ((operation_ref IS NULL OR (typeof(operation_ref) = 'text' AND length(operation_ref) BETWEEN 1 AND 192 AND trim(operation_ref) = operation_ref))),
  evaluated_at INTEGER NOT NULL CHECK (typeof(evaluated_at) = 'integer' AND evaluated_at > 0),
  valid_until INTEGER CHECK ((valid_until IS NULL OR (typeof(valid_until) = 'integer' AND valid_until > 0))),
  retention_until INTEGER CHECK ((retention_until IS NULL OR (typeof(retention_until) = 'integer' AND retention_until > 0))),
  FOREIGN KEY (policy_version,capability) REFERENCES capability_catalog(policy_version,capability)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (actor_kind != 'customer' OR (subject_telegram_id IS NOT NULL AND actor_telegram_id IS NOT NULL)),
  CHECK (valid_until IS NULL OR valid_until >= evaluated_at),
  CHECK (retention_until IS NULL OR retention_until >= evaluated_at)
);
CREATE INDEX IF NOT EXISTS idx_v141_audit_subject
  ON entitlement_decision_audit(subject_telegram_id,evaluated_at);
CREATE INDEX IF NOT EXISTS idx_v141_audit_policy
  ON entitlement_decision_audit(capability,policy_version,evaluated_at);
CREATE INDEX IF NOT EXISTS idx_v141_audit_retention
  ON entitlement_decision_audit(retention_until);
CREATE TRIGGER IF NOT EXISTS v141_audit_no_update
BEFORE UPDATE ON entitlement_decision_audit
BEGIN SELECT RAISE(ABORT, 'v141_audit_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS v141_audit_catalog_actor
BEFORE INSERT ON entitlement_decision_audit
WHEN NOT EXISTS (SELECT 1 FROM capability_catalog c
  WHERE c.policy_version = NEW.policy_version AND c.capability = NEW.capability
    AND c.actor_kind = NEW.actor_kind)
BEGIN SELECT RAISE(ABORT, 'v141_audit_actor_kind_mismatch'); END;

CREATE TRIGGER IF NOT EXISTS v141_entitlement_decision_audit_guarded_delete
BEFORE DELETE ON entitlement_decision_audit
WHEN NOT EXISTS (
  SELECT 1 FROM mini_app_privacy_guard g
  WHERE g.precondition_ok = 1 AND g.expires_at > unixepoch() AND (
    (g.reason = 'subject_deletion' AND (g.subject_id = OLD.subject_telegram_id)
      AND EXISTS (SELECT 1 FROM privacy_deletion_requests p
        WHERE p.request_id = g.request_id AND p.telegram_id = g.subject_id
          AND p.status = 'pending' AND unixepoch(p.expires_at) > unixepoch()))
    OR (g.reason = 'retention' AND OLD.retention_until IS NOT NULL AND OLD.retention_until <= unixepoch())
  )
)
BEGIN SELECT RAISE(ABORT, 'v141_privacy_cleanup_required'); END;

CREATE TABLE IF NOT EXISTS feature_flags (
  flag_key TEXT PRIMARY KEY NOT NULL CHECK (typeof(flag_key) = 'text' AND length(flag_key) BETWEEN 1 AND 128 AND trim(flag_key) = flag_key),
  policy_version TEXT NOT NULL CHECK (typeof(policy_version) = 'text' AND length(policy_version) BETWEEN 1 AND 128 AND trim(policy_version) = policy_version),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (typeof(enabled) = 'integer' AND enabled IN (0,1)),
  emergency_disabled INTEGER NOT NULL DEFAULT 1 CHECK (typeof(emergency_disabled) = 'integer' AND emergency_disabled IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision) = 'integer' AND revision > 0),
  rollout_json TEXT NOT NULL DEFAULT '{}' CHECK (typeof(rollout_json) = 'text'
    AND length(rollout_json) <= 16384 AND json_valid(rollout_json) AND json_type(rollout_json) IS 'object'),
  updated_by INTEGER CHECK ((updated_by IS NULL OR (typeof(updated_by) = 'integer' AND updated_by > 0))),
  reason TEXT NOT NULL CHECK (typeof(reason) = 'text' AND length(reason) BETWEEN 1 AND 1000 AND trim(reason) = reason),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at > 0),
  CHECK (enabled = 0 OR updated_by IS NOT NULL)
);

CREATE TRIGGER IF NOT EXISTS v141_flags_initial_revision
BEFORE INSERT ON feature_flags
WHEN NEW.revision != 1
BEGIN SELECT RAISE(ABORT, 'v141_initial_revision_required'); END;
CREATE TRIGGER IF NOT EXISTS v141_flags_revision
BEFORE UPDATE ON feature_flags
WHEN NEW.flag_key IS NOT OLD.flag_key OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.revision != OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
  OR NEW.updated_by IS NULL
BEGIN SELECT RAISE(ABORT, 'v141_flag_revision_required'); END;
CREATE TRIGGER IF NOT EXISTS v141_flags_no_delete
BEFORE DELETE ON feature_flags
BEGIN SELECT RAISE(ABORT, 'v141_disable_flag_instead'); END;

CREATE TABLE IF NOT EXISTS feature_flag_assignments (
  assignment_id TEXT PRIMARY KEY NOT NULL CHECK (typeof(assignment_id) = 'text' AND length(assignment_id) BETWEEN 1 AND 96 AND trim(assignment_id) = assignment_id),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (typeof(idempotency_key) = 'text' AND length(idempotency_key) = 64 AND idempotency_key NOT GLOB '*[^0-9a-f]*'),
  flag_key TEXT NOT NULL REFERENCES feature_flags(flag_key) ON UPDATE RESTRICT ON DELETE RESTRICT,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('actor','cohort')),
  subject_key TEXT NOT NULL CHECK (typeof(subject_key) = 'text' AND length(subject_key) BETWEEN 1 AND 192 AND trim(subject_key) = subject_key),
  subject_telegram_id INTEGER CHECK ((subject_telegram_id IS NULL OR (typeof(subject_telegram_id) = 'integer' AND subject_telegram_id > 0))),
  subject_source_fingerprint TEXT CHECK ((subject_source_fingerprint IS NULL OR (typeof(subject_source_fingerprint) = 'text' AND length(subject_source_fingerprint) = 64 AND subject_source_fingerprint NOT GLOB '*[^0-9a-f]*'))),
  assigned_by INTEGER NOT NULL CHECK (typeof(assigned_by) = 'integer' AND assigned_by > 0),
  reason TEXT NOT NULL CHECK (typeof(reason) = 'text' AND length(reason) BETWEEN 1 AND 1000 AND trim(reason) = reason),
  starts_at INTEGER NOT NULL CHECK (typeof(starts_at) = 'integer' AND starts_at > 0),
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision) = 'integer' AND revision > 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at > 0),
  revoked_at INTEGER CHECK ((revoked_at IS NULL OR (typeof(revoked_at) = 'integer' AND revoked_at > 0))),
  revoked_by INTEGER CHECK ((revoked_by IS NULL OR (typeof(revoked_by) = 'integer' AND revoked_by > 0))),
  revocation_reason TEXT CHECK ((revocation_reason IS NULL OR (typeof(revocation_reason) = 'text' AND length(revocation_reason) BETWEEN 1 AND 1000 AND trim(revocation_reason) = revocation_reason))),
  retention_until INTEGER CHECK ((retention_until IS NULL OR (typeof(retention_until) = 'integer' AND retention_until > 0))),
  CHECK ((subject_kind = 'actor' AND subject_telegram_id IS NOT NULL AND subject_source_fingerprint IS NOT NULL)
    OR (subject_kind = 'cohort' AND subject_telegram_id IS NULL AND subject_source_fingerprint IS NULL)),
  CHECK (expires_at > starts_at AND updated_at >= created_at),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason IS NOT NULL
      AND revoked_at >= created_at AND updated_at >= revoked_at AND revision > 1)),
  CHECK (retention_until IS NULL OR retention_until >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_v141_assignment_unrevoked_subject
  ON feature_flag_assignments(flag_key,subject_kind,subject_key)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_v141_assignment_unrevoked_actor
  ON feature_flag_assignments(flag_key,subject_telegram_id)
  WHERE subject_kind = 'actor' AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_v141_assignment_subject
  ON feature_flag_assignments(subject_telegram_id,flag_key,expires_at);

CREATE TRIGGER IF NOT EXISTS v141_feature_flag_assignments_terminal_revocation
BEFORE UPDATE ON feature_flag_assignments
WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
    OR NEW.revision != OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
    OR NEW.assignment_id IS NOT OLD.assignment_id
    OR NEW.idempotency_key IS NOT OLD.idempotency_key
    OR NEW.flag_key IS NOT OLD.flag_key
    OR NEW.subject_kind IS NOT OLD.subject_kind
    OR NEW.subject_key IS NOT OLD.subject_key
    OR NEW.subject_telegram_id IS NOT OLD.subject_telegram_id
    OR NEW.subject_source_fingerprint IS NOT OLD.subject_source_fingerprint
    OR NEW.assigned_by IS NOT OLD.assigned_by
    OR NEW.reason IS NOT OLD.reason
    OR NEW.starts_at IS NOT OLD.starts_at
    OR NEW.expires_at IS NOT OLD.expires_at
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.retention_until IS NOT OLD.retention_until
BEGIN SELECT RAISE(ABORT, 'v141_only_terminal_revocation'); END;

CREATE TRIGGER IF NOT EXISTS v141_feature_flag_assignments_initial_revision
BEFORE INSERT ON feature_flag_assignments
WHEN NEW.revision != 1 OR NEW.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'v141_initial_revision_required'); END;

CREATE TRIGGER IF NOT EXISTS v141_feature_flag_assignments_guarded_delete
BEFORE DELETE ON feature_flag_assignments
WHEN NOT EXISTS (
  SELECT 1 FROM mini_app_privacy_guard g
  WHERE g.precondition_ok = 1 AND g.expires_at > unixepoch() AND (
    (g.reason = 'subject_deletion' AND (g.subject_id = OLD.subject_telegram_id)
      AND EXISTS (SELECT 1 FROM privacy_deletion_requests p
        WHERE p.request_id = g.request_id AND p.telegram_id = g.subject_id
          AND p.status = 'pending' AND unixepoch(p.expires_at) > unixepoch()))
    OR (g.reason = 'retention' AND OLD.retention_until IS NOT NULL AND OLD.retention_until <= unixepoch() AND (OLD.revoked_at IS NOT NULL OR OLD.expires_at <= unixepoch()))
  )
)
BEGIN SELECT RAISE(ABORT, 'v141_privacy_cleanup_required'); END;

INSERT OR IGNORE INTO re_schema_migrations(version) VALUES ('1.4.1-audit-rollout');
