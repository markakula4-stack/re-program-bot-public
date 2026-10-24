-- v1.4.1 Part4: reviewed offline schema/privacy/AI durability expansion.
-- This scoped exception rebuilds ONLY four new v1.4.1 personal foundations.
-- Immutable0062-64 and old finance/users/business schemas are untouched.
-- No feature flag, grant, payment backfill or runtime activation is inserted.
-- Execute atomically through the reviewed migration controller exactly once.
-- Number0065 remains provisional until a fresh live ledger inventory.

INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
VALUES('v141_p04_migration',CASE WHEN NOT EXISTS(
  SELECT 1 FROM re_schema_migrations WHERE version='1.4.1-privacy-ai-journal'
) THEN 1 ELSE 0 END);


CREATE TABLE entitlement_grants_v141_p04 (
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
  issued_by INTEGER CHECK (issued_by IS NULL OR (typeof(issued_by) = 'integer' AND issued_by > 0)),
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
  subject_source_fingerprint TEXT CHECK (subject_source_fingerprint IS NULL OR (typeof(subject_source_fingerprint)='text' AND length(subject_source_fingerprint)=64 AND subject_source_fingerprint NOT GLOB '*[^0-9a-f]*')),
  issuer_anonymized INTEGER NOT NULL DEFAULT 0 CHECK (issuer_anonymized IN (0,1)),
  revoker_anonymized INTEGER NOT NULL DEFAULT 0 CHECK (revoker_anonymized IN (0,1)),
  authority_seal TEXT CHECK (authority_seal IS NULL OR (typeof(authority_seal)='text' AND length(authority_seal)=64 AND authority_seal NOT GLOB '*[^0-9a-f]*')),
  seal_version INTEGER CHECK (seal_version IS NULL OR seal_version=1),
  CHECK ((authority_seal IS NULL AND seal_version IS NULL) OR (authority_seal IS NOT NULL AND seal_version=1)),
  CHECK ((issued_by IS NOT NULL AND issuer_anonymized=0) OR (issued_by IS NULL AND issuer_anonymized=1)),
  CHECK ((revoker_anonymized=0) OR (revoked_at IS NOT NULL AND revoked_by IS NULL)),
  CHECK (authority_seal IS NULL OR subject_source_fingerprint IS NOT NULL),
  FOREIGN KEY (policy_version,capability) REFERENCES capability_catalog(policy_version,capability)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (expires_at > starts_at AND updated_at >= created_at),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL AND revoker_anonymized = 0)
    OR (revoked_at IS NOT NULL AND (revoked_by IS NOT NULL OR revoker_anonymized = 1) AND revocation_reason IS NOT NULL
      AND revoked_at >= created_at AND updated_at >= revoked_at AND revision > 1)),
  CHECK (retention_until IS NULL OR retention_until >= created_at)
);


INSERT INTO entitlement_grants_v141_p04(grant_id,idempotency_key,policy_version,capability,subject_telegram_id,scope_kind,scope_key,source_kind,source_ref,source_revision,source_fingerprint,issued_by,reason,starts_at,expires_at,revision,created_at,updated_at,revoked_at,revoked_by,revocation_reason,retention_until) SELECT grant_id,idempotency_key,policy_version,capability,subject_telegram_id,scope_kind,scope_key,source_kind,source_ref,source_revision,source_fingerprint,issued_by,reason,starts_at,expires_at,revision,created_at,updated_at,revoked_at,revoked_by,revocation_reason,retention_until FROM entitlement_grants;


CREATE TABLE entitlement_overrides_v141_p04 (
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
  issued_by INTEGER CHECK (issued_by IS NULL OR (typeof(issued_by) = 'integer' AND issued_by > 0)),
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
  issuer_anonymized INTEGER NOT NULL DEFAULT 0 CHECK (issuer_anonymized IN (0,1)),
  revoker_anonymized INTEGER NOT NULL DEFAULT 0 CHECK (revoker_anonymized IN (0,1)),
  authority_seal TEXT CHECK (authority_seal IS NULL OR (typeof(authority_seal)='text' AND length(authority_seal)=64 AND authority_seal NOT GLOB '*[^0-9a-f]*')),
  seal_version INTEGER CHECK (seal_version IS NULL OR seal_version=1),
  CHECK ((authority_seal IS NULL AND seal_version IS NULL) OR (authority_seal IS NOT NULL AND seal_version=1)),
  CHECK ((issued_by IS NOT NULL AND issuer_anonymized=0) OR (issued_by IS NULL AND issuer_anonymized=1)),
  CHECK ((revoker_anonymized=0) OR (revoked_at IS NOT NULL AND revoked_by IS NULL)),
  FOREIGN KEY (policy_version,capability) REFERENCES capability_catalog(policy_version,capability)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (effect != 'deny' OR limit_value IS NULL),
  CHECK (expires_at > starts_at AND updated_at >= created_at),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL AND revoker_anonymized = 0)
    OR (revoked_at IS NOT NULL AND (revoked_by IS NOT NULL OR revoker_anonymized = 1) AND revocation_reason IS NOT NULL
      AND revoked_at >= created_at AND updated_at >= revoked_at AND revision > 1)),
  CHECK (retention_until IS NULL OR retention_until >= created_at)
);


INSERT INTO entitlement_overrides_v141_p04(override_id,idempotency_key,policy_version,capability,subject_telegram_id,scope_kind,scope_key,subject_source_fingerprint,effect,limit_value,issued_by,reason,starts_at,expires_at,revision,created_at,updated_at,revoked_at,revoked_by,revocation_reason,retention_until) SELECT override_id,idempotency_key,policy_version,capability,subject_telegram_id,scope_kind,scope_key,subject_source_fingerprint,effect,limit_value,issued_by,reason,starts_at,expires_at,revision,created_at,updated_at,revoked_at,revoked_by,revocation_reason,retention_until FROM entitlement_overrides;


CREATE TABLE feature_flags_v141_p04 (
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
  updater_anonymized INTEGER NOT NULL DEFAULT 0 CHECK (updater_anonymized IN (0,1)),
  authority_seal TEXT CHECK (authority_seal IS NULL OR (typeof(authority_seal)='text' AND length(authority_seal)=64 AND authority_seal NOT GLOB '*[^0-9a-f]*')),
  seal_version INTEGER CHECK (seal_version IS NULL OR seal_version=1),
  CHECK ((authority_seal IS NULL AND seal_version IS NULL) OR (authority_seal IS NOT NULL AND seal_version=1)),
  CHECK (updater_anonymized=0 OR updated_by IS NULL),
  CHECK (enabled = 0 OR updated_by IS NOT NULL OR updater_anonymized = 1)
);


INSERT INTO feature_flags_v141_p04(flag_key,policy_version,enabled,emergency_disabled,revision,rollout_json,updated_by,reason,updated_at) SELECT flag_key,policy_version,enabled,emergency_disabled,revision,rollout_json,updated_by,reason,updated_at FROM feature_flags;


CREATE TABLE feature_flag_assignments_v141_p04 (
  assignment_id TEXT PRIMARY KEY NOT NULL CHECK (typeof(assignment_id) = 'text' AND length(assignment_id) BETWEEN 1 AND 96 AND trim(assignment_id) = assignment_id),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (typeof(idempotency_key) = 'text' AND length(idempotency_key) = 64 AND idempotency_key NOT GLOB '*[^0-9a-f]*'),
  flag_key TEXT NOT NULL REFERENCES feature_flags_v141_p04(flag_key) ON UPDATE RESTRICT ON DELETE RESTRICT,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('actor','cohort')),
  subject_key TEXT NOT NULL CHECK (typeof(subject_key) = 'text' AND length(subject_key) BETWEEN 1 AND 192 AND trim(subject_key) = subject_key),
  subject_telegram_id INTEGER CHECK ((subject_telegram_id IS NULL OR (typeof(subject_telegram_id) = 'integer' AND subject_telegram_id > 0))),
  subject_source_fingerprint TEXT CHECK ((subject_source_fingerprint IS NULL OR (typeof(subject_source_fingerprint) = 'text' AND length(subject_source_fingerprint) = 64 AND subject_source_fingerprint NOT GLOB '*[^0-9a-f]*'))),
  assigned_by INTEGER CHECK (assigned_by IS NULL OR (typeof(assigned_by) = 'integer' AND assigned_by > 0)),
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
  assigner_anonymized INTEGER NOT NULL DEFAULT 0 CHECK (assigner_anonymized IN (0,1)),
  revoker_anonymized INTEGER NOT NULL DEFAULT 0 CHECK (revoker_anonymized IN (0,1)),
  authority_seal TEXT CHECK (authority_seal IS NULL OR (typeof(authority_seal)='text' AND length(authority_seal)=64 AND authority_seal NOT GLOB '*[^0-9a-f]*')),
  seal_version INTEGER CHECK (seal_version IS NULL OR seal_version=1),
  CHECK ((authority_seal IS NULL AND seal_version IS NULL) OR (authority_seal IS NOT NULL AND seal_version=1)),
  CHECK ((assigned_by IS NOT NULL AND assigner_anonymized=0) OR (assigned_by IS NULL AND assigner_anonymized=1)),
  CHECK ((revoker_anonymized=0) OR (revoked_at IS NOT NULL AND revoked_by IS NULL)),
  CHECK ((subject_kind = 'actor' AND subject_telegram_id IS NOT NULL AND subject_source_fingerprint IS NOT NULL)
    OR (subject_kind = 'cohort' AND subject_telegram_id IS NULL AND subject_source_fingerprint IS NULL)),
  CHECK (expires_at > starts_at AND updated_at >= created_at),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL AND revoker_anonymized = 0)
    OR (revoked_at IS NOT NULL AND (revoked_by IS NOT NULL OR revoker_anonymized = 1) AND revocation_reason IS NOT NULL
      AND revoked_at >= created_at AND updated_at >= revoked_at AND revision > 1)),
  CHECK (retention_until IS NULL OR retention_until >= created_at)
);


INSERT INTO feature_flag_assignments_v141_p04(assignment_id,idempotency_key,flag_key,subject_kind,subject_key,subject_telegram_id,subject_source_fingerprint,assigned_by,reason,starts_at,expires_at,revision,created_at,updated_at,revoked_at,revoked_by,revocation_reason,retention_until) SELECT assignment_id,idempotency_key,flag_key,subject_kind,subject_key,subject_telegram_id,subject_source_fingerprint,assigned_by,reason,starts_at,expires_at,revision,created_at,updated_at,revoked_at,revoked_by,revocation_reason,retention_until FROM feature_flag_assignments;


DROP TABLE feature_flag_assignments;

DROP TABLE feature_flags;

DROP TABLE entitlement_overrides;

DROP TABLE entitlement_grants;

ALTER TABLE entitlement_grants_v141_p04 RENAME TO entitlement_grants;

ALTER TABLE entitlement_overrides_v141_p04 RENAME TO entitlement_overrides;

ALTER TABLE feature_flags_v141_p04 RENAME TO feature_flags;

ALTER TABLE feature_flag_assignments_v141_p04 RENAME TO feature_flag_assignments;

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

CREATE TRIGGER IF NOT EXISTS v141_entitlement_grants_initial_revision
BEFORE INSERT ON entitlement_grants
WHEN NEW.revision != 1 OR NEW.revoked_at IS NOT NULL
    OR NEW.issuer_anonymized != 0 OR NEW.revoker_anonymized != 0
BEGIN SELECT RAISE(ABORT, 'v141_initial_revision_required'); END;

CREATE TRIGGER v141_entitlement_grants_terminal_revocation
BEFORE UPDATE ON entitlement_grants
WHEN NOT ((NOT (OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
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
    OR NEW.retention_until IS NOT OLD.retention_until OR NEW.subject_source_fingerprint IS NOT OLD.subject_source_fingerprint OR NEW.issuer_anonymized IS NOT OLD.issuer_anonymized OR NEW.revoker_anonymized IS NOT OLD.revoker_anonymized OR NEW.authority_seal IS NOT OLD.authority_seal OR NEW.seal_version IS NOT OLD.seal_version)) OR (EXISTS(SELECT 1 FROM mini_app_privacy_guard g WHERE g.reason='subject_deletion' AND g.precondition_ok=1 AND g.expires_at>unixepoch()
    AND EXISTS(SELECT 1 FROM privacy_deletion_requests p WHERE p.request_id=g.request_id
      AND p.telegram_id=g.subject_id AND p.status='pending' AND unixepoch(p.expires_at)>unixepoch())
    AND NOT EXISTS(SELECT 1 FROM user_roles r WHERE r.telegram_id=g.subject_id AND r.role='admin' AND r.status='active')
    AND NOT EXISTS(SELECT 1 FROM partner_profiles p WHERE p.telegram_id=g.subject_id)
      AND (OLD.issued_by=g.subject_id OR OLD.revoked_by=g.subject_id)
      AND NEW.issued_by IS CASE WHEN OLD.issued_by=g.subject_id THEN NULL ELSE OLD.issued_by END
      AND NEW.issuer_anonymized IS CASE WHEN OLD.issued_by=g.subject_id THEN 1 ELSE OLD.issuer_anonymized END
      AND NEW.reason IS CASE WHEN OLD.issued_by=g.subject_id THEN 'author_deleted' ELSE OLD.reason END
      AND NEW.grant_id IS OLD.grant_id
      AND NEW.idempotency_key IS OLD.idempotency_key
      AND NEW.policy_version IS OLD.policy_version
      AND NEW.capability IS OLD.capability
      AND NEW.subject_telegram_id IS OLD.subject_telegram_id
      AND NEW.scope_kind IS OLD.scope_kind
      AND NEW.scope_key IS OLD.scope_key
      AND NEW.source_kind IS OLD.source_kind
      AND NEW.source_ref IS OLD.source_ref
      AND NEW.source_revision IS OLD.source_revision
      AND NEW.source_fingerprint IS OLD.source_fingerprint
      AND NEW.starts_at IS OLD.starts_at
      AND NEW.expires_at IS OLD.expires_at
      AND NEW.revision IS OLD.revision
      AND NEW.created_at IS OLD.created_at
      AND NEW.updated_at IS OLD.updated_at
      AND NEW.revoked_at IS OLD.revoked_at
      AND NEW.retention_until IS OLD.retention_until
      AND (NEW.authority_seal IS OLD.authority_seal OR (OLD.authority_seal IS NULL AND NEW.authority_seal IS NOT NULL AND NEW.seal_version=1))
      AND (NEW.seal_version IS OLD.seal_version OR (OLD.seal_version IS NULL AND NEW.seal_version=1 AND NEW.authority_seal IS NOT NULL))
      AND NEW.revoked_by IS CASE WHEN OLD.revoked_by=g.subject_id THEN NULL ELSE OLD.revoked_by END
      AND NEW.revoker_anonymized IS CASE WHEN OLD.revoked_by=g.subject_id THEN 1 ELSE OLD.revoker_anonymized END
      AND NEW.revocation_reason IS CASE WHEN OLD.revoked_by=g.subject_id THEN 'author_deleted' ELSE OLD.revocation_reason END
      AND (NEW.subject_source_fingerprint IS OLD.subject_source_fingerprint OR
        (OLD.subject_source_fingerprint IS NULL AND NEW.subject_source_fingerprint IS NOT NULL AND NEW.authority_seal IS NOT NULL)))))
BEGIN SELECT RAISE(ABORT,'v141_only_terminal_revocation'); END;

CREATE TRIGGER v141_entitlement_grants_guarded_delete
BEFORE DELETE ON entitlement_grants
WHEN NOT EXISTS(SELECT 1 FROM mini_app_privacy_guard g WHERE
  ((g.reason='subject_deletion' AND g.precondition_ok=1 AND g.expires_at>unixepoch()
    AND EXISTS(SELECT 1 FROM privacy_deletion_requests p WHERE p.request_id=g.request_id
      AND p.telegram_id=g.subject_id AND p.status='pending' AND unixepoch(p.expires_at)>unixepoch())
    AND NOT EXISTS(SELECT 1 FROM user_roles r WHERE r.telegram_id=g.subject_id AND r.role='admin' AND r.status='active')
    AND NOT EXISTS(SELECT 1 FROM partner_profiles p WHERE p.telegram_id=g.subject_id)) AND g.subject_id=OLD.subject_telegram_id)
  OR (g.reason='retention' AND g.precondition_ok=1 AND g.expires_at>unixepoch()
    AND OLD.retention_until IS NOT NULL AND OLD.retention_until<=unixepoch()
    AND (OLD.revoked_at IS NOT NULL OR OLD.expires_at<=unixepoch())))
BEGIN SELECT RAISE(ABORT,'v141_privacy_cleanup_required'); END;

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

CREATE TRIGGER IF NOT EXISTS v141_entitlement_overrides_initial_revision
BEFORE INSERT ON entitlement_overrides
WHEN NEW.revision != 1 OR NEW.revoked_at IS NOT NULL
    OR NEW.issuer_anonymized != 0 OR NEW.revoker_anonymized != 0
BEGIN SELECT RAISE(ABORT, 'v141_initial_revision_required'); END;

CREATE TRIGGER v141_entitlement_overrides_terminal_revocation
BEFORE UPDATE ON entitlement_overrides
WHEN NOT ((NOT (OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
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
    OR NEW.retention_until IS NOT OLD.retention_until OR NEW.issuer_anonymized IS NOT OLD.issuer_anonymized OR NEW.revoker_anonymized IS NOT OLD.revoker_anonymized OR NEW.authority_seal IS NOT OLD.authority_seal OR NEW.seal_version IS NOT OLD.seal_version)) OR (EXISTS(SELECT 1 FROM mini_app_privacy_guard g WHERE g.reason='subject_deletion' AND g.precondition_ok=1 AND g.expires_at>unixepoch()
    AND EXISTS(SELECT 1 FROM privacy_deletion_requests p WHERE p.request_id=g.request_id
      AND p.telegram_id=g.subject_id AND p.status='pending' AND unixepoch(p.expires_at)>unixepoch())
    AND NOT EXISTS(SELECT 1 FROM user_roles r WHERE r.telegram_id=g.subject_id AND r.role='admin' AND r.status='active')
    AND NOT EXISTS(SELECT 1 FROM partner_profiles p WHERE p.telegram_id=g.subject_id)
      AND (OLD.issued_by=g.subject_id OR OLD.revoked_by=g.subject_id)
      AND NEW.issued_by IS CASE WHEN OLD.issued_by=g.subject_id THEN NULL ELSE OLD.issued_by END
      AND NEW.issuer_anonymized IS CASE WHEN OLD.issued_by=g.subject_id THEN 1 ELSE OLD.issuer_anonymized END
      AND NEW.reason IS CASE WHEN OLD.issued_by=g.subject_id THEN 'author_deleted' ELSE OLD.reason END
      AND NEW.override_id IS OLD.override_id
      AND NEW.idempotency_key IS OLD.idempotency_key
      AND NEW.policy_version IS OLD.policy_version
      AND NEW.capability IS OLD.capability
      AND NEW.subject_telegram_id IS OLD.subject_telegram_id
      AND NEW.scope_kind IS OLD.scope_kind
      AND NEW.scope_key IS OLD.scope_key
      AND NEW.subject_source_fingerprint IS OLD.subject_source_fingerprint
      AND NEW.effect IS OLD.effect
      AND NEW.limit_value IS OLD.limit_value
      AND NEW.starts_at IS OLD.starts_at
      AND NEW.expires_at IS OLD.expires_at
      AND NEW.revision IS OLD.revision
      AND NEW.created_at IS OLD.created_at
      AND NEW.updated_at IS OLD.updated_at
      AND NEW.revoked_at IS OLD.revoked_at
      AND NEW.retention_until IS OLD.retention_until
      AND (NEW.authority_seal IS OLD.authority_seal OR (OLD.authority_seal IS NULL AND NEW.authority_seal IS NOT NULL AND NEW.seal_version=1))
      AND (NEW.seal_version IS OLD.seal_version OR (OLD.seal_version IS NULL AND NEW.seal_version=1 AND NEW.authority_seal IS NOT NULL))
      AND NEW.revoked_by IS CASE WHEN OLD.revoked_by=g.subject_id THEN NULL ELSE OLD.revoked_by END
      AND NEW.revoker_anonymized IS CASE WHEN OLD.revoked_by=g.subject_id THEN 1 ELSE OLD.revoker_anonymized END
      AND NEW.revocation_reason IS CASE WHEN OLD.revoked_by=g.subject_id THEN 'author_deleted' ELSE OLD.revocation_reason END)))
BEGIN SELECT RAISE(ABORT,'v141_only_terminal_revocation'); END;

CREATE TRIGGER v141_entitlement_overrides_guarded_delete
BEFORE DELETE ON entitlement_overrides
WHEN NOT EXISTS(SELECT 1 FROM mini_app_privacy_guard g WHERE
  ((g.reason='subject_deletion' AND g.precondition_ok=1 AND g.expires_at>unixepoch()
    AND EXISTS(SELECT 1 FROM privacy_deletion_requests p WHERE p.request_id=g.request_id
      AND p.telegram_id=g.subject_id AND p.status='pending' AND unixepoch(p.expires_at)>unixepoch())
    AND NOT EXISTS(SELECT 1 FROM user_roles r WHERE r.telegram_id=g.subject_id AND r.role='admin' AND r.status='active')
    AND NOT EXISTS(SELECT 1 FROM partner_profiles p WHERE p.telegram_id=g.subject_id)) AND g.subject_id=OLD.subject_telegram_id)
  OR (g.reason='retention' AND g.precondition_ok=1 AND g.expires_at>unixepoch()
    AND OLD.retention_until IS NOT NULL AND OLD.retention_until<=unixepoch()
    AND (OLD.revoked_at IS NOT NULL OR OLD.expires_at<=unixepoch())))
BEGIN SELECT RAISE(ABORT,'v141_privacy_cleanup_required'); END;

CREATE TRIGGER IF NOT EXISTS v141_flags_initial_revision
BEFORE INSERT ON feature_flags
WHEN NEW.revision != 1
    OR NEW.updater_anonymized != 0
BEGIN SELECT RAISE(ABORT, 'v141_initial_revision_required'); END;

CREATE TRIGGER IF NOT EXISTS v141_flags_no_delete
BEFORE DELETE ON feature_flags
BEGIN SELECT RAISE(ABORT, 'v141_disable_flag_instead'); END;

CREATE TRIGGER v141_flags_revision
BEFORE UPDATE ON feature_flags
WHEN NOT ((NOT (NEW.flag_key IS NOT OLD.flag_key OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.revision != OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
  OR NEW.updated_by IS NULL OR NEW.updater_anonymized IS NOT OLD.updater_anonymized OR NEW.authority_seal IS NOT OLD.authority_seal OR NEW.seal_version IS NOT OLD.seal_version)) OR (EXISTS(SELECT 1 FROM mini_app_privacy_guard g WHERE g.reason='subject_deletion' AND g.precondition_ok=1 AND g.expires_at>unixepoch()
    AND EXISTS(SELECT 1 FROM privacy_deletion_requests p WHERE p.request_id=g.request_id
      AND p.telegram_id=g.subject_id AND p.status='pending' AND unixepoch(p.expires_at)>unixepoch())
    AND NOT EXISTS(SELECT 1 FROM user_roles r WHERE r.telegram_id=g.subject_id AND r.role='admin' AND r.status='active')
    AND NOT EXISTS(SELECT 1 FROM partner_profiles p WHERE p.telegram_id=g.subject_id)
      AND (OLD.updated_by=g.subject_id)
      AND NEW.updated_by IS CASE WHEN OLD.updated_by=g.subject_id THEN NULL ELSE OLD.updated_by END
      AND NEW.updater_anonymized IS CASE WHEN OLD.updated_by=g.subject_id THEN 1 ELSE OLD.updater_anonymized END
      AND NEW.reason IS CASE WHEN OLD.updated_by=g.subject_id THEN 'author_deleted' ELSE OLD.reason END
      AND NEW.flag_key IS OLD.flag_key
      AND NEW.policy_version IS OLD.policy_version
      AND NEW.enabled IS OLD.enabled
      AND NEW.emergency_disabled IS OLD.emergency_disabled
      AND NEW.revision IS OLD.revision
      AND NEW.rollout_json IS OLD.rollout_json
      AND NEW.updated_at IS OLD.updated_at
      AND (NEW.authority_seal IS OLD.authority_seal OR (OLD.authority_seal IS NULL AND NEW.authority_seal IS NOT NULL AND NEW.seal_version=1))
      AND (NEW.seal_version IS OLD.seal_version OR (OLD.seal_version IS NULL AND NEW.seal_version=1 AND NEW.authority_seal IS NOT NULL)))))
BEGIN SELECT RAISE(ABORT,'v141_flag_revision_required'); END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_v141_assignment_unrevoked_subject
  ON feature_flag_assignments(flag_key,subject_kind,subject_key)
  WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_v141_assignment_unrevoked_actor
  ON feature_flag_assignments(flag_key,subject_telegram_id)
  WHERE subject_kind = 'actor' AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_v141_assignment_subject
  ON feature_flag_assignments(subject_telegram_id,flag_key,expires_at);

CREATE TRIGGER IF NOT EXISTS v141_feature_flag_assignments_initial_revision
BEFORE INSERT ON feature_flag_assignments
WHEN NEW.revision != 1 OR NEW.revoked_at IS NOT NULL
    OR NEW.assigner_anonymized != 0 OR NEW.revoker_anonymized != 0
BEGIN SELECT RAISE(ABORT, 'v141_initial_revision_required'); END;

CREATE TRIGGER v141_feature_flag_assignments_terminal_revocation
BEFORE UPDATE ON feature_flag_assignments
WHEN NOT ((NOT (OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
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
    OR NEW.retention_until IS NOT OLD.retention_until OR NEW.assigner_anonymized IS NOT OLD.assigner_anonymized OR NEW.revoker_anonymized IS NOT OLD.revoker_anonymized OR NEW.authority_seal IS NOT OLD.authority_seal OR NEW.seal_version IS NOT OLD.seal_version)) OR (EXISTS(SELECT 1 FROM mini_app_privacy_guard g WHERE g.reason='subject_deletion' AND g.precondition_ok=1 AND g.expires_at>unixepoch()
    AND EXISTS(SELECT 1 FROM privacy_deletion_requests p WHERE p.request_id=g.request_id
      AND p.telegram_id=g.subject_id AND p.status='pending' AND unixepoch(p.expires_at)>unixepoch())
    AND NOT EXISTS(SELECT 1 FROM user_roles r WHERE r.telegram_id=g.subject_id AND r.role='admin' AND r.status='active')
    AND NOT EXISTS(SELECT 1 FROM partner_profiles p WHERE p.telegram_id=g.subject_id)
      AND (OLD.assigned_by=g.subject_id OR OLD.revoked_by=g.subject_id)
      AND NEW.assigned_by IS CASE WHEN OLD.assigned_by=g.subject_id THEN NULL ELSE OLD.assigned_by END
      AND NEW.assigner_anonymized IS CASE WHEN OLD.assigned_by=g.subject_id THEN 1 ELSE OLD.assigner_anonymized END
      AND NEW.reason IS CASE WHEN OLD.assigned_by=g.subject_id THEN 'author_deleted' ELSE OLD.reason END
      AND NEW.assignment_id IS OLD.assignment_id
      AND NEW.idempotency_key IS OLD.idempotency_key
      AND NEW.flag_key IS OLD.flag_key
      AND NEW.subject_kind IS OLD.subject_kind
      AND NEW.subject_key IS OLD.subject_key
      AND NEW.subject_telegram_id IS OLD.subject_telegram_id
      AND NEW.subject_source_fingerprint IS OLD.subject_source_fingerprint
      AND NEW.starts_at IS OLD.starts_at
      AND NEW.expires_at IS OLD.expires_at
      AND NEW.revision IS OLD.revision
      AND NEW.created_at IS OLD.created_at
      AND NEW.updated_at IS OLD.updated_at
      AND NEW.revoked_at IS OLD.revoked_at
      AND NEW.retention_until IS OLD.retention_until
      AND (NEW.authority_seal IS OLD.authority_seal OR (OLD.authority_seal IS NULL AND NEW.authority_seal IS NOT NULL AND NEW.seal_version=1))
      AND (NEW.seal_version IS OLD.seal_version OR (OLD.seal_version IS NULL AND NEW.seal_version=1 AND NEW.authority_seal IS NOT NULL))
      AND NEW.revoked_by IS CASE WHEN OLD.revoked_by=g.subject_id THEN NULL ELSE OLD.revoked_by END
      AND NEW.revoker_anonymized IS CASE WHEN OLD.revoked_by=g.subject_id THEN 1 ELSE OLD.revoker_anonymized END
      AND NEW.revocation_reason IS CASE WHEN OLD.revoked_by=g.subject_id THEN 'author_deleted' ELSE OLD.revocation_reason END)))
BEGIN SELECT RAISE(ABORT,'v141_only_terminal_revocation'); END;

CREATE TRIGGER v141_feature_flag_assignments_guarded_delete
BEFORE DELETE ON feature_flag_assignments
WHEN NOT EXISTS(SELECT 1 FROM mini_app_privacy_guard g WHERE
  ((g.reason='subject_deletion' AND g.precondition_ok=1 AND g.expires_at>unixepoch()
    AND EXISTS(SELECT 1 FROM privacy_deletion_requests p WHERE p.request_id=g.request_id
      AND p.telegram_id=g.subject_id AND p.status='pending' AND unixepoch(p.expires_at)>unixepoch())
    AND NOT EXISTS(SELECT 1 FROM user_roles r WHERE r.telegram_id=g.subject_id AND r.role='admin' AND r.status='active')
    AND NOT EXISTS(SELECT 1 FROM partner_profiles p WHERE p.telegram_id=g.subject_id)) AND g.subject_id=OLD.subject_telegram_id)
  OR (g.reason='retention' AND g.precondition_ok=1 AND g.expires_at>unixepoch()
    AND OLD.retention_until IS NOT NULL AND OLD.retention_until<=unixepoch()
    AND (OLD.revoked_at IS NOT NULL OR OLD.expires_at<=unixepoch())))
BEGIN SELECT RAISE(ABORT,'v141_privacy_cleanup_required'); END;

DROP TRIGGER v141_entitlement_decision_audit_guarded_delete;
CREATE TRIGGER v141_entitlement_decision_audit_guarded_delete
BEFORE DELETE ON entitlement_decision_audit
WHEN NOT EXISTS(SELECT 1 FROM mini_app_privacy_guard g WHERE
  ((g.reason='subject_deletion' AND g.precondition_ok=1 AND g.expires_at>unixepoch()
    AND EXISTS(SELECT 1 FROM privacy_deletion_requests p WHERE p.request_id=g.request_id
      AND p.telegram_id=g.subject_id AND p.status='pending' AND unixepoch(p.expires_at)>unixepoch())
    AND NOT EXISTS(SELECT 1 FROM user_roles r WHERE r.telegram_id=g.subject_id AND r.role='admin' AND r.status='active')
    AND NOT EXISTS(SELECT 1 FROM partner_profiles p WHERE p.telegram_id=g.subject_id)) AND (g.subject_id=OLD.subject_telegram_id OR g.subject_id=OLD.actor_telegram_id))
  OR (g.reason='retention' AND g.precondition_ok=1 AND g.expires_at>unixepoch()
    AND OLD.retention_until IS NOT NULL AND OLD.retention_until<=unixepoch()))
BEGIN SELECT RAISE(ABORT,'v141_privacy_cleanup_required'); END;

-- Actual AI durability only: no prompts, answers, provider calls or authority backfill.
CREATE TABLE ai_operation_journal (
  request_id TEXT PRIMARY KEY NOT NULL CHECK(typeof(request_id)='text' AND length(request_id)=64 AND request_id NOT GLOB '*[^0-9a-f]*'),
  namespace TEXT NOT NULL CHECK(namespace IN ('public','partner')),
  subject_telegram_id INTEGER CHECK(subject_telegram_id IS NULL OR (typeof(subject_telegram_id)='integer' AND subject_telegram_id>0)),
  account_generation_hash TEXT CHECK(account_generation_hash IS NULL OR (typeof(account_generation_hash)='text' AND length(account_generation_hash)=64 AND account_generation_hash NOT GLOB '*[^0-9a-f]*')),
  usage_date TEXT NOT NULL CHECK(typeof(usage_date)='text' AND length(usage_date)=10 AND date(usage_date) IS usage_date),
  bucket TEXT NOT NULL CHECK(bucket IN ('public','admin')),
  admitted_at INTEGER NOT NULL CHECK(typeof(admitted_at)='integer' AND admitted_at>0),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at>admitted_at AND expires_at<=admitted_at+300),
  user_cycle_start_at INTEGER,
  user_cycle_end_at INTEGER,
  global_cycle_start_at INTEGER,
  global_cycle_end_at INTEGER,
  reserved_milli INTEGER NOT NULL CHECK(typeof(reserved_milli)='integer' AND reserved_milli BETWEEN 0 AND 9007199254740991),
  reserved_billed_tokens INTEGER NOT NULL CHECK(typeof(reserved_billed_tokens)='integer' AND reserved_billed_tokens BETWEEN 0 AND 100000000),
  reserved_cost_microusd INTEGER NOT NULL CHECK(typeof(reserved_cost_microusd)='integer' AND reserved_cost_microusd BETWEEN 0 AND 9007199254740991),
  policy_version TEXT NOT NULL CHECK(typeof(policy_version)='text' AND length(policy_version) BETWEEN 1 AND 128 AND trim(policy_version)=policy_version),
  pricing_version TEXT NOT NULL CHECK(typeof(pricing_version)='text' AND length(pricing_version) BETWEEN 1 AND 128 AND trim(pricing_version)=pricing_version),
  policy_json TEXT NOT NULL CHECK(typeof(policy_json)='text' AND length(policy_json)<=8192 AND json_valid(policy_json) AND json_type(policy_json) IS 'object'),
  policy_hash TEXT NOT NULL CHECK(typeof(policy_hash)='text' AND length(policy_hash)=64 AND policy_hash NOT GLOB '*[^0-9a-f]*'),
  primary_model_alias TEXT NOT NULL CHECK(primary_model_alias IN ('qwen_safe','deepseek_flash_dragon')),
  generation_id TEXT CHECK(generation_id IS NULL OR (typeof(generation_id)='text' AND length(generation_id) BETWEEN 1 AND 96)),
  state TEXT NOT NULL DEFAULT 'admitted' CHECK(state IN ('admitted','provider_started','unknown','terminal_succeeded','terminal_failed')),
  settlement_kind TEXT NOT NULL DEFAULT 'owned' CHECK(settlement_kind IN ('owned','anonymous')),
  attempted_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempted_count)='integer' AND attempted_count BETWEEN 0 AND 3),
  active_attempt_no INTEGER CHECK(active_attempt_no IS NULL OR (typeof(active_attempt_no)='integer' AND active_attempt_no BETWEEN 1 AND 3)),
  active_attempt_id TEXT CHECK(active_attempt_id IS NULL OR (typeof(active_attempt_id)='text' AND length(active_attempt_id)=36)),
  active_route_step TEXT CHECK(active_route_step IS NULL OR active_route_step IN ('primary','retry','fallback')),
  active_model_alias TEXT CHECK(active_model_alias IS NULL OR active_model_alias IN ('qwen_safe','deepseek_flash_dragon')),
  active_started_at INTEGER CHECK(active_started_at IS NULL OR (typeof(active_started_at)='integer' AND active_started_at>=admitted_at)),
  provider_started_at INTEGER CHECK(provider_started_at IS NULL OR (typeof(provider_started_at)='integer' AND provider_started_at>=admitted_at)),
  terminal_at INTEGER CHECK(terminal_at IS NULL OR (typeof(terminal_at)='integer' AND terminal_at>=admitted_at)),
  terminal_reason TEXT NOT NULL DEFAULT '' CHECK(typeof(terminal_reason)='text' AND length(terminal_reason)<=96 AND terminal_reason NOT GLOB '*[^a-z0-9_]*'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>0),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=admitted_at),
  retention_until INTEGER CHECK(retention_until IS NULL OR (typeof(retention_until)='integer' AND retention_until>=admitted_at)),
  CHECK((subject_telegram_id IS NULL AND account_generation_hash IS NULL AND settlement_kind='anonymous' AND generation_id IS NULL)
    OR (subject_telegram_id IS NOT NULL AND account_generation_hash IS NOT NULL)),
  CHECK((namespace='public' AND user_cycle_start_at IS NULL AND user_cycle_end_at IS NULL AND global_cycle_start_at IS NULL AND global_cycle_end_at IS NULL AND reserved_milli=20000 AND reserved_billed_tokens=0 AND reserved_cost_microusd=0)
    OR (namespace='partner' AND typeof(user_cycle_start_at)='integer' AND user_cycle_start_at>0 AND user_cycle_end_at=user_cycle_start_at+2592000
      AND typeof(global_cycle_start_at)='integer' AND global_cycle_start_at>0 AND global_cycle_end_at=global_cycle_start_at+2592000 AND reserved_milli=1 AND bucket='admin')),
  CHECK((active_attempt_no IS NULL AND active_attempt_id IS NULL AND active_route_step IS NULL AND active_model_alias IS NULL AND active_started_at IS NULL)
    OR (active_attempt_no IS NOT NULL AND active_attempt_id IS NOT NULL AND active_route_step IS NOT NULL AND active_model_alias IS NOT NULL AND active_started_at IS NOT NULL)),
  CHECK((state IN ('admitted','provider_started','unknown') AND terminal_at IS NULL AND terminal_reason='')
    OR (state IN ('terminal_succeeded','terminal_failed') AND terminal_at IS NOT NULL AND length(terminal_reason)>0 AND active_attempt_no IS NULL)),
  CHECK(state!='admitted' OR (provider_started_at IS NULL AND active_attempt_no IS NULL)),
  CHECK(state NOT IN ('provider_started','terminal_succeeded') OR provider_started_at IS NOT NULL)
);
CREATE INDEX idx_v141_ai_journal_subject ON ai_operation_journal(subject_telegram_id,state,usage_date);
CREATE INDEX idx_v141_ai_journal_global_hold ON ai_operation_journal(namespace,state,settlement_kind,global_cycle_start_at,usage_date);
CREATE INDEX idx_v141_ai_journal_retention ON ai_operation_journal(retention_until,state);

CREATE TABLE ai_operation_receipts (
  request_id TEXT NOT NULL REFERENCES ai_operation_journal(request_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  attempt_no INTEGER NOT NULL CHECK(typeof(attempt_no)='integer' AND attempt_no BETWEEN 1 AND 3),
  attempt_id TEXT NOT NULL UNIQUE CHECK(typeof(attempt_id)='text' AND length(attempt_id)=36),
  route_step TEXT NOT NULL CHECK(route_step IN ('primary','retry','fallback')),
  model_alias TEXT NOT NULL CHECK(model_alias IN ('qwen_safe','deepseek_flash_dragon')),
  provider_code TEXT NOT NULL CHECK(provider_code IN ('cloudflare','deepseek')),
  attempt_status TEXT NOT NULL CHECK(attempt_status IN ('success','failed','timeout')),
  input_tokens INTEGER NOT NULL CHECK(typeof(input_tokens)='integer' AND input_tokens BETWEEN 0 AND 10000000),
  cached_input_tokens INTEGER NOT NULL CHECK(typeof(cached_input_tokens)='integer' AND cached_input_tokens BETWEEN 0 AND input_tokens),
  output_tokens INTEGER NOT NULL CHECK(typeof(output_tokens)='integer' AND output_tokens BETWEEN 0 AND 10000000),
  cost_microusd INTEGER NOT NULL CHECK(typeof(cost_microusd)='integer' AND cost_microusd BETWEEN 0 AND 9007199254740991),
  neurons_milli INTEGER NOT NULL CHECK(typeof(neurons_milli)='integer' AND neurons_milli BETWEEN 0 AND 9007199254740991),
  latency_ms INTEGER NOT NULL CHECK(typeof(latency_ms)='integer' AND latency_ms BETWEEN 0 AND 300000),
  status_code INTEGER CHECK(status_code IS NULL OR (typeof(status_code)='integer' AND status_code BETWEEN 100 AND 599)),
  error_code TEXT NOT NULL DEFAULT '' CHECK(typeof(error_code)='text' AND length(error_code)<=96 AND error_code NOT GLOB '*[^a-z0-9_]*'),
  receipt_hash TEXT NOT NULL CHECK(typeof(receipt_hash)='text' AND length(receipt_hash)=64 AND receipt_hash NOT GLOB '*[^0-9a-f]*'),
  expense_location TEXT NOT NULL DEFAULT 'pending' CHECK(expense_location IN ('pending','owned','anonymous')),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0),
  applied_at INTEGER CHECK(applied_at IS NULL OR (typeof(applied_at)='integer' AND applied_at>=created_at)),
  PRIMARY KEY(request_id,attempt_no),
  UNIQUE(request_id,route_step),
  CHECK((expense_location='pending' AND applied_at IS NULL) OR (expense_location!='pending' AND applied_at IS NOT NULL)),
  CHECK((model_alias='qwen_safe' AND provider_code='cloudflare' AND cost_microusd=0)
    OR (model_alias='deepseek_flash_dragon' AND provider_code='deepseek' AND neurons_milli=0)),
  CHECK((route_step='primary' AND attempt_no=1) OR (route_step='retry' AND attempt_no=2 AND model_alias='deepseek_flash_dragon') OR (route_step='fallback' AND attempt_no IN (2,3) AND model_alias='qwen_safe'))
);
CREATE INDEX idx_v141_ai_receipt_pending ON ai_operation_receipts(expense_location,created_at,request_id);

CREATE TRIGGER v141_ai_journal_initial BEFORE INSERT ON ai_operation_journal
WHEN NEW.revision!=1 OR NEW.state NOT IN ('admitted','unknown') OR NEW.attempted_count!=0
  OR NEW.active_attempt_no IS NOT NULL
BEGIN SELECT RAISE(ABORT,'v141_ai_journal_initial_required'); END;

CREATE TRIGGER v141_ai_journal_immutable_admission BEFORE UPDATE ON ai_operation_journal
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.namespace IS NOT OLD.namespace OR NEW.usage_date IS NOT OLD.usage_date OR NEW.bucket IS NOT OLD.bucket
  OR NEW.admitted_at IS NOT OLD.admitted_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.user_cycle_start_at IS NOT OLD.user_cycle_start_at
  OR NEW.user_cycle_end_at IS NOT OLD.user_cycle_end_at OR NEW.global_cycle_start_at IS NOT OLD.global_cycle_start_at OR NEW.global_cycle_end_at IS NOT OLD.global_cycle_end_at
  OR NEW.reserved_milli IS NOT OLD.reserved_milli OR NEW.reserved_billed_tokens IS NOT OLD.reserved_billed_tokens OR NEW.reserved_cost_microusd IS NOT OLD.reserved_cost_microusd
  OR NEW.policy_version IS NOT OLD.policy_version OR NEW.pricing_version IS NOT OLD.pricing_version OR NEW.policy_json IS NOT OLD.policy_json OR NEW.policy_hash IS NOT OLD.policy_hash
  OR NEW.primary_model_alias IS NOT OLD.primary_model_alias OR NEW.retention_until IS NOT OLD.retention_until
  OR NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at
BEGIN SELECT RAISE(ABORT,'v141_ai_admission_is_immutable'); END;

CREATE TRIGGER v141_ai_journal_identity_privacy BEFORE UPDATE ON ai_operation_journal
WHEN (NEW.subject_telegram_id IS NOT OLD.subject_telegram_id OR NEW.account_generation_hash IS NOT OLD.account_generation_hash
  OR NEW.generation_id IS NOT OLD.generation_id OR NEW.settlement_kind IS NOT OLD.settlement_kind)
  AND NOT (NEW.subject_telegram_id IS NULL AND NEW.account_generation_hash IS NULL AND NEW.generation_id IS NULL AND NEW.settlement_kind='anonymous'
    AND EXISTS(SELECT 1 FROM mini_app_privacy_guard g JOIN privacy_deletion_requests p ON p.request_id=g.request_id
      WHERE g.subject_id=OLD.subject_telegram_id AND g.reason='subject_deletion' AND g.precondition_ok=1 AND g.expires_at>unixepoch()
        AND p.telegram_id=g.subject_id AND p.status='pending' AND unixepoch(p.expires_at)>unixepoch()
        AND NOT EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=g.subject_id AND role='admin' AND status='active')
        AND NOT EXISTS(SELECT 1 FROM partner_profiles WHERE telegram_id=g.subject_id)))
BEGIN SELECT RAISE(ABORT,'v141_ai_identity_cleanup_required'); END;

CREATE TRIGGER v141_ai_journal_state BEFORE UPDATE ON ai_operation_journal
WHEN NOT (NEW.state=OLD.state OR (OLD.state='admitted' AND NEW.state IN ('provider_started','terminal_failed'))
  OR (OLD.state='provider_started' AND NEW.state IN ('unknown','terminal_succeeded','terminal_failed'))
  OR (OLD.state='unknown' AND NEW.state='terminal_failed'))
  OR (OLD.state IN ('terminal_succeeded','terminal_failed') AND (NEW.terminal_at IS NOT OLD.terminal_at OR NEW.terminal_reason IS NOT OLD.terminal_reason OR NEW.provider_started_at IS NOT OLD.provider_started_at))
  OR (OLD.provider_started_at IS NOT NULL AND NEW.provider_started_at IS NOT OLD.provider_started_at)
  OR (NEW.state='terminal_succeeded' AND (NEW.active_attempt_no IS NOT NULL
    OR NEW.attempted_count!=(SELECT COUNT(*) FROM ai_operation_receipts WHERE request_id=NEW.request_id)
    OR NOT EXISTS(SELECT 1 FROM ai_operation_receipts r WHERE r.request_id=NEW.request_id AND r.attempt_status='success' AND r.expense_location!='pending')
    OR EXISTS(SELECT 1 FROM ai_operation_receipts r WHERE r.request_id=NEW.request_id AND r.expense_location='pending')))
  OR (OLD.state='unknown' AND NEW.state='terminal_failed' AND OLD.active_attempt_no IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM ai_operation_receipts r WHERE r.request_id=OLD.request_id AND r.attempt_no=OLD.active_attempt_no AND r.attempt_id=OLD.active_attempt_id))
BEGIN SELECT RAISE(ABORT,'v141_ai_state_transition_required'); END;

CREATE TRIGGER v141_ai_journal_active_attempt BEFORE UPDATE ON ai_operation_journal
WHEN (NEW.attempted_count IS NOT OLD.attempted_count OR NEW.active_attempt_no IS NOT OLD.active_attempt_no OR NEW.active_attempt_id IS NOT OLD.active_attempt_id
  OR NEW.active_route_step IS NOT OLD.active_route_step OR NEW.active_model_alias IS NOT OLD.active_model_alias OR NEW.active_started_at IS NOT OLD.active_started_at)
  AND NOT ((OLD.state IN ('admitted','provider_started') AND OLD.active_attempt_no IS NULL AND NEW.state='provider_started'
      AND NEW.attempted_count=OLD.attempted_count+1 AND NEW.active_attempt_no=NEW.attempted_count
      AND NEW.active_attempt_no=COALESCE((SELECT MAX(attempt_no)+1 FROM ai_operation_receipts WHERE request_id=OLD.request_id),1))
    OR (NEW.attempted_count=OLD.attempted_count AND NEW.active_attempt_no IS NULL AND (EXISTS(SELECT 1 FROM ai_operation_receipts r WHERE r.request_id=OLD.request_id AND r.attempt_no=OLD.active_attempt_no AND r.attempt_id=OLD.active_attempt_id)
      OR (OLD.state='provider_started' AND NEW.state='terminal_failed' AND NEW.terminal_reason='local_not_started'))))
BEGIN SELECT RAISE(ABORT,'v141_ai_active_attempt_required'); END;

CREATE TRIGGER v141_ai_receipt_collision BEFORE INSERT ON ai_operation_receipts
WHEN EXISTS(SELECT 1 FROM ai_operation_receipts r WHERE r.request_id=NEW.request_id AND r.attempt_no=NEW.attempt_no
  AND (r.receipt_hash IS NOT NEW.receipt_hash OR r.attempt_id IS NOT NEW.attempt_id))
BEGIN SELECT RAISE(ABORT,'v141_ai_receipt_conflict'); END;
CREATE TRIGGER v141_ai_receipt_terminal BEFORE INSERT ON ai_operation_receipts
WHEN EXISTS(SELECT 1 FROM ai_operation_journal j WHERE j.request_id=NEW.request_id AND j.state='terminal_succeeded')
  AND NOT EXISTS(SELECT 1 FROM ai_operation_receipts r WHERE r.request_id=NEW.request_id AND r.attempt_no=NEW.attempt_no AND r.receipt_hash=NEW.receipt_hash)
BEGIN SELECT RAISE(ABORT,'v141_ai_terminal_receipt_required'); END;
CREATE TRIGGER v141_ai_receipt_immutable BEFORE UPDATE ON ai_operation_receipts
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.attempt_no IS NOT OLD.attempt_no OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.route_step IS NOT OLD.route_step
  OR NEW.model_alias IS NOT OLD.model_alias OR NEW.provider_code IS NOT OLD.provider_code OR NEW.attempt_status IS NOT OLD.attempt_status
  OR NEW.input_tokens IS NOT OLD.input_tokens OR NEW.cached_input_tokens IS NOT OLD.cached_input_tokens OR NEW.output_tokens IS NOT OLD.output_tokens
  OR NEW.cost_microusd IS NOT OLD.cost_microusd OR NEW.neurons_milli IS NOT OLD.neurons_milli OR NEW.latency_ms IS NOT OLD.latency_ms
  OR NEW.status_code IS NOT OLD.status_code OR NEW.error_code IS NOT OLD.error_code OR NEW.receipt_hash IS NOT OLD.receipt_hash OR NEW.created_at IS NOT OLD.created_at
  OR NOT ((OLD.expense_location='pending' AND NEW.expense_location IN ('owned','anonymous') AND NEW.applied_at IS NOT NULL)
    OR (OLD.expense_location='owned' AND NEW.expense_location='anonymous' AND NEW.applied_at IS OLD.applied_at
      AND EXISTS(SELECT 1 FROM ai_operation_journal j JOIN mini_app_privacy_guard g ON g.subject_id=j.subject_telegram_id
        JOIN privacy_deletion_requests p ON p.request_id=g.request_id WHERE j.request_id=OLD.request_id
          AND g.reason='subject_deletion' AND g.precondition_ok=1 AND g.expires_at>unixepoch() AND p.telegram_id=g.subject_id AND p.status='pending' AND unixepoch(p.expires_at)>unixepoch()
          AND NOT EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=g.subject_id AND role='admin' AND status='active')
          AND NOT EXISTS(SELECT 1 FROM partner_profiles WHERE telegram_id=g.subject_id))))
BEGIN SELECT RAISE(ABORT,'v141_ai_receipt_is_immutable'); END;

CREATE TRIGGER v141_ai_receipt_guarded_delete BEFORE DELETE ON ai_operation_receipts
WHEN NOT EXISTS(SELECT 1 FROM ai_operation_journal j JOIN mini_app_privacy_guard g ON g.reason='retention'
  WHERE j.request_id=OLD.request_id AND j.state IN ('terminal_succeeded','terminal_failed') AND j.retention_until IS NOT NULL AND j.retention_until<=unixepoch()
    AND OLD.expense_location!='pending' AND g.precondition_ok=1 AND g.expires_at>unixepoch())
BEGIN SELECT RAISE(ABORT,'v141_ai_retention_required'); END;
CREATE TRIGGER v141_ai_journal_guarded_delete BEFORE DELETE ON ai_operation_journal
WHEN NOT EXISTS(SELECT 1 FROM mini_app_privacy_guard g WHERE g.reason='retention' AND g.precondition_ok=1 AND g.expires_at>unixepoch()
  AND OLD.state IN ('terminal_succeeded','terminal_failed') AND OLD.retention_until IS NOT NULL AND OLD.retention_until<=unixepoch())
BEGIN SELECT RAISE(ABORT,'v141_ai_retention_required'); END;

INSERT INTO re_schema_migrations(version) VALUES('1.4.1-privacy-ai-journal');
DELETE FROM mini_app_atomic_guards WHERE guard_key='v141_p04_migration';
