-- v1.4.1 Part2: additive, closed foundations only.
-- Numbers are provisional until the reviewed current-main/live-ledger inventory.
-- No old business table, trigger, payment grant, user row or rollout is changed.
-- Only new foundations/policy seed and reviewed migration-ledger markers are written.
-- Apply only through the reviewed expand controller, never unreviewed history.

-- Permission metadata is not an independent paid-plan/financial authority.
-- No grant, override, financial backfill or author row is inserted here.

CREATE TABLE IF NOT EXISTS entitlement_grants (
  grant_id TEXT PRIMARY KEY NOT NULL CHECK (typeof(grant_id) = 'text' AND length(grant_id) BETWEEN 1 AND 96 AND trim(grant_id) = grant_id),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (typeof(idempotency_key) = 'text' AND length(idempotency_key) = 64 AND idempotency_key NOT GLOB '*[^0-9a-f]*'),
  policy_version TEXT NOT NULL CHECK (typeof(policy_version) = 'text' AND length(policy_version) BETWEEN 1 AND 128 AND trim(policy_version) = policy_version),
  capability TEXT NOT NULL CHECK (typeof(capability) = 'text' AND length(capability) BETWEEN 1 AND 128 AND trim(capability) = capability),
  subject_telegram_id INTEGER NOT NULL CHECK (typeof(subject_telegram_id) = 'integer' AND subject_telegram_id > 0),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('actor','resource','tenant')),
  scope_key TEXT NOT NULL CHECK (typeof(scope_key) = 'text' AND length(scope_key) BETWEEN 1 AND 192 AND trim(scope_key) = scope_key),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('manual_capability','verified_existing_source')),
  source_ref TEXT NOT NULL CHECK (typeof(source_ref) = 'text' AND length(source_ref) BETWEEN 1 AND 192 AND trim(source_ref) = source_ref),
  source_revision INTEGER NOT NULL CHECK (typeof(source_revision) = 'integer' AND source_revision > 0),
  source_fingerprint TEXT NOT NULL CHECK (typeof(source_fingerprint) = 'text' AND length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
  issued_by INTEGER NOT NULL CHECK (typeof(issued_by) = 'integer' AND issued_by > 0),
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
  FOREIGN KEY (policy_version,capability) REFERENCES capability_catalog(policy_version,capability)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (expires_at > starts_at AND updated_at >= created_at),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason IS NOT NULL
      AND revoked_at >= created_at AND updated_at >= revoked_at AND revision > 1)),
  CHECK (retention_until IS NULL OR retention_until >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_v141_grant_subject
  ON entitlement_grants(subject_telegram_id,capability,policy_version,expires_at);
CREATE INDEX IF NOT EXISTS idx_v141_grant_source
  ON entitlement_grants(source_kind,source_ref,source_revision);
CREATE INDEX IF NOT EXISTS idx_v141_grant_expiry
  ON entitlement_grants(revoked_at,expires_at);

CREATE TRIGGER IF NOT EXISTS v141_entitlement_grants_customer_capability
BEFORE INSERT ON entitlement_grants
WHEN NOT EXISTS (SELECT 1 FROM capability_catalog c
  WHERE c.policy_version = NEW.policy_version AND c.capability = NEW.capability
    AND c.actor_kind = 'customer' AND c.availability != 'future_disabled')
BEGIN SELECT RAISE(ABORT, 'v141_customer_capability_required'); END;

CREATE TRIGGER IF NOT EXISTS v141_entitlement_grants_terminal_revocation
BEFORE UPDATE ON entitlement_grants
WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
    OR NEW.revision != OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
    OR NEW.grant_id IS NOT OLD.grant_id
    OR NEW.idempotency_key IS NOT OLD.idempotency_key
    OR NEW.policy_version IS NOT OLD.policy_version
    OR NEW.capability IS NOT OLD.capability
    OR NEW.subject_telegram_id IS NOT OLD.subject_telegram_id
    OR NEW.scope_kind IS NOT OLD.scope_kind
    OR NEW.scope_key IS NOT OLD.scope_key
    OR NEW.source_kind IS NOT OLD.source_kind
    OR NEW.source_ref IS NOT OLD.source_ref
    OR NEW.source_revision IS NOT OLD.source_revision
    OR NEW.source_fingerprint IS NOT OLD.source_fingerprint
    OR NEW.issued_by IS NOT OLD.issued_by
    OR NEW.reason IS NOT OLD.reason
    OR NEW.starts_at IS NOT OLD.starts_at
    OR NEW.expires_at IS NOT OLD.expires_at
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.retention_until IS NOT OLD.retention_until
BEGIN SELECT RAISE(ABORT, 'v141_only_terminal_revocation'); END;

CREATE TRIGGER IF NOT EXISTS v141_entitlement_grants_initial_revision
BEFORE INSERT ON entitlement_grants
WHEN NEW.revision != 1 OR NEW.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'v141_initial_revision_required'); END;

CREATE TRIGGER IF NOT EXISTS v141_entitlement_grants_guarded_delete
BEFORE DELETE ON entitlement_grants
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

CREATE TABLE IF NOT EXISTS entitlement_overrides (
  override_id TEXT PRIMARY KEY NOT NULL CHECK (typeof(override_id) = 'text' AND length(override_id) BETWEEN 1 AND 96 AND trim(override_id) = override_id),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (typeof(idempotency_key) = 'text' AND length(idempotency_key) = 64 AND idempotency_key NOT GLOB '*[^0-9a-f]*'),
  policy_version TEXT NOT NULL CHECK (typeof(policy_version) = 'text' AND length(policy_version) BETWEEN 1 AND 128 AND trim(policy_version) = policy_version),
  capability TEXT NOT NULL CHECK (typeof(capability) = 'text' AND length(capability) BETWEEN 1 AND 128 AND trim(capability) = capability),
  subject_telegram_id INTEGER NOT NULL CHECK (typeof(subject_telegram_id) = 'integer' AND subject_telegram_id > 0),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('actor','resource','tenant')),
  scope_key TEXT NOT NULL CHECK (typeof(scope_key) = 'text' AND length(scope_key) BETWEEN 1 AND 192 AND trim(scope_key) = scope_key),
  subject_source_fingerprint TEXT NOT NULL CHECK (typeof(subject_source_fingerprint) = 'text' AND length(subject_source_fingerprint) = 64 AND subject_source_fingerprint NOT GLOB '*[^0-9a-f]*'),
  effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  limit_value INTEGER CHECK ((limit_value IS NULL OR (typeof(limit_value) = 'integer' AND limit_value BETWEEN 0 AND 1000000000))),
  issued_by INTEGER NOT NULL CHECK (typeof(issued_by) = 'integer' AND issued_by > 0),
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
  FOREIGN KEY (policy_version,capability) REFERENCES capability_catalog(policy_version,capability)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (effect != 'deny' OR limit_value IS NULL),
  CHECK (expires_at > starts_at AND updated_at >= created_at),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason IS NOT NULL
      AND revoked_at >= created_at AND updated_at >= revoked_at AND revision > 1)),
  CHECK (retention_until IS NULL OR retention_until >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_v141_override_unrevoked_scope
  ON entitlement_overrides(policy_version,capability,subject_telegram_id,scope_kind,scope_key)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_v141_override_subject
  ON entitlement_overrides(subject_telegram_id,capability,policy_version,expires_at);

CREATE TRIGGER IF NOT EXISTS v141_entitlement_overrides_customer_capability
BEFORE INSERT ON entitlement_overrides
WHEN NOT EXISTS (SELECT 1 FROM capability_catalog c
  WHERE c.policy_version = NEW.policy_version AND c.capability = NEW.capability
    AND c.actor_kind = 'customer' AND (NEW.effect = 'deny' OR c.availability != 'future_disabled'))
BEGIN SELECT RAISE(ABORT, 'v141_customer_capability_required'); END;

CREATE TRIGGER IF NOT EXISTS v141_entitlement_overrides_terminal_revocation
BEFORE UPDATE ON entitlement_overrides
WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
    OR NEW.revision != OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
    OR NEW.override_id IS NOT OLD.override_id
    OR NEW.idempotency_key IS NOT OLD.idempotency_key
    OR NEW.policy_version IS NOT OLD.policy_version
    OR NEW.capability IS NOT OLD.capability
    OR NEW.subject_telegram_id IS NOT OLD.subject_telegram_id
    OR NEW.scope_kind IS NOT OLD.scope_kind
    OR NEW.scope_key IS NOT OLD.scope_key
    OR NEW.subject_source_fingerprint IS NOT OLD.subject_source_fingerprint
    OR NEW.effect IS NOT OLD.effect
    OR NEW.limit_value IS NOT OLD.limit_value
    OR NEW.issued_by IS NOT OLD.issued_by
    OR NEW.reason IS NOT OLD.reason
    OR NEW.starts_at IS NOT OLD.starts_at
    OR NEW.expires_at IS NOT OLD.expires_at
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.retention_until IS NOT OLD.retention_until
BEGIN SELECT RAISE(ABORT, 'v141_only_terminal_revocation'); END;

CREATE TRIGGER IF NOT EXISTS v141_entitlement_overrides_initial_revision
BEFORE INSERT ON entitlement_overrides
WHEN NEW.revision != 1 OR NEW.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'v141_initial_revision_required'); END;

CREATE TRIGGER IF NOT EXISTS v141_entitlement_overrides_guarded_delete
BEFORE DELETE ON entitlement_overrides
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

INSERT OR IGNORE INTO re_schema_migrations(version) VALUES ('1.4.1-grants-overrides');
