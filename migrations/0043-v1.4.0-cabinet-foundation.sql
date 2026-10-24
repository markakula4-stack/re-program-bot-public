-- RE Program Bot v1.4.0 Part 1 — Partner Cabinet foundation.
--
-- Additive and idempotent. All cabinet switches remain fail-closed. This
-- migration does not rewrite an existing identity/access authority, wire the
-- production Worker, publish a Mini App, or enable a public rollout.

CREATE TABLE IF NOT EXISTS re_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cabinet_v1_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rollout_mode TEXT NOT NULL DEFAULT 'off'
    CHECK (rollout_mode IN ('off', 'admin_shadow')),
  master_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (master_enabled IN (0, 1)),
  profile_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (profile_enabled IN (0, 1)),
  offer_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (offer_enabled IN (0, 1)),
  application_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (application_enabled IN (0, 1)),
  export_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (export_enabled IN (0, 1)),
  init_data_max_age_seconds INTEGER NOT NULL DEFAULT 300
    CHECK (init_data_max_age_seconds BETWEEN 60 AND 900),
  session_ttl_seconds INTEGER NOT NULL DEFAULT 300
    CHECK (session_ttl_seconds BETWEEN 60 AND 900),
  capability_registry_version INTEGER NOT NULL DEFAULT 1
    CHECK (capability_registry_version = 1),
  tariff_capacity_version INTEGER NOT NULL DEFAULT 1
    CHECK (tariff_capacity_version = 1),
  policy_version TEXT NOT NULL DEFAULT '2026-09-14.cabinet-v1-part1'
    CHECK (length(policy_version) BETWEEN 8 AND 80),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by INTEGER REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  CHECK (
    (master_enabled = 0 AND rollout_mode = 'off')
    OR (master_enabled = 1 AND rollout_mode = 'admin_shadow')
  ),
  CHECK (
    master_enabled = 1
    OR (profile_enabled = 0 AND offer_enabled = 0
      AND application_enabled = 0 AND export_enabled = 0)
  )
);

INSERT OR IGNORE INTO cabinet_v1_settings (
  id, rollout_mode, master_enabled, profile_enabled, offer_enabled,
  application_enabled, export_enabled, init_data_max_age_seconds,
  session_ttl_seconds, capability_registry_version,
  tariff_capacity_version, policy_version, revision, updated_by, updated_at
) VALUES (
  1, 'off', 0, 0, 0, 0, 0, 300, 300, 1, 1,
  '2026-09-14.cabinet-v1-part1', 1, NULL, unixepoch()
);

CREATE TABLE IF NOT EXISTS cabinet_capability_registry (
  capability_code TEXT PRIMARY KEY CHECK (
    length(capability_code) BETWEEN 5 AND 64
    AND capability_code = lower(capability_code)
    AND capability_code GLOB '*.*'
    AND capability_code NOT GLOB '*[^a-z0-9._]*'
  ),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN (
    'profile', 'offer', 'application', 'export'
  )),
  action TEXT NOT NULL CHECK (action IN (
    'read', 'create', 'update', 'submit'
  )),
  feature_flag TEXT NOT NULL CHECK (feature_flag IN (
    'profile', 'offer', 'application', 'export'
  )),
  default_effect TEXT NOT NULL DEFAULT 'deny'
    CHECK (default_effect = 'deny'),
  registry_version INTEGER NOT NULL DEFAULT 1 CHECK (registry_version = 1),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 8 AND 80),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  CHECK (substr(capability_code, 1, length(resource_kind) + 1)
    = resource_kind || '.'),
  UNIQUE (resource_kind, action)
);

INSERT OR IGNORE INTO cabinet_capability_registry (
  capability_code, resource_kind, action, feature_flag, default_effect,
  registry_version, policy_version, created_at
) VALUES
  ('profile.read', 'profile', 'read', 'profile', 'deny', 1,
   '2026-09-14.cabinet-v1-part1', unixepoch()),
  ('profile.update', 'profile', 'update', 'profile', 'deny', 1,
   '2026-09-14.cabinet-v1-part1', unixepoch()),
  ('offer.read', 'offer', 'read', 'offer', 'deny', 1,
   '2026-09-14.cabinet-v1-part1', unixepoch()),
  ('offer.create', 'offer', 'create', 'offer', 'deny', 1,
   '2026-09-14.cabinet-v1-part1', unixepoch()),
  ('offer.update', 'offer', 'update', 'offer', 'deny', 1,
   '2026-09-14.cabinet-v1-part1', unixepoch()),
  ('offer.submit', 'offer', 'submit', 'offer', 'deny', 1,
   '2026-09-14.cabinet-v1-part1', unixepoch()),
  ('application.read', 'application', 'read', 'application', 'deny', 1,
   '2026-09-14.cabinet-v1-part1', unixepoch()),
  ('application.create', 'application', 'create', 'application', 'deny', 1,
   '2026-09-14.cabinet-v1-part1', unixepoch()),
  ('application.update', 'application', 'update', 'application', 'deny', 1,
   '2026-09-14.cabinet-v1-part1', unixepoch()),
  ('export.create', 'export', 'create', 'export', 'deny', 1,
   '2026-09-14.cabinet-v1-part1', unixepoch());

CREATE TABLE IF NOT EXISTS cabinet_role_capability_matrix (
  capability_code TEXT NOT NULL REFERENCES cabinet_capability_registry(
    capability_code
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('user', 'partner', 'admin')),
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  scope_rule TEXT NOT NULL CHECK (scope_rule IN (
    'none', 'self', 'public', 'partner_owner',
    'public_or_partner_owner', 'global'
  )),
  reason_code TEXT NOT NULL CHECK (
    length(reason_code) BETWEEN 3 AND 48
    AND reason_code = lower(reason_code)
    AND reason_code NOT GLOB '*[^a-z0-9_]*'
  ),
  matrix_version INTEGER NOT NULL DEFAULT 1 CHECK (matrix_version = 1),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (capability_code, actor_role),
  CHECK (
    (effect = 'deny' AND scope_rule = 'none')
    OR (effect = 'allow' AND scope_rule != 'none')
  )
);

INSERT OR IGNORE INTO cabinet_role_capability_matrix (
  capability_code, actor_role, effect, scope_rule, reason_code,
  matrix_version, created_at
) VALUES
  ('profile.read', 'user', 'allow', 'self', 'own_profile', 1, unixepoch()),
  ('profile.read', 'partner', 'allow', 'self', 'own_profile', 1, unixepoch()),
  ('profile.read', 'admin', 'allow', 'global', 'admin_scope', 1, unixepoch()),
  ('profile.update', 'user', 'allow', 'self', 'own_profile', 1, unixepoch()),
  ('profile.update', 'partner', 'allow', 'self', 'own_profile', 1, unixepoch()),
  ('profile.update', 'admin', 'allow', 'global', 'admin_scope', 1, unixepoch()),
  ('offer.read', 'user', 'allow', 'public', 'public_offer', 1, unixepoch()),
  ('offer.read', 'partner', 'allow', 'public_or_partner_owner',
   'public_or_owned_offer', 1, unixepoch()),
  ('offer.read', 'admin', 'allow', 'global', 'admin_scope', 1, unixepoch()),
  ('offer.create', 'user', 'deny', 'none', 'role_denied', 1, unixepoch()),
  ('offer.create', 'partner', 'allow', 'partner_owner', 'owned_offer', 1,
   unixepoch()),
  ('offer.create', 'admin', 'allow', 'global', 'admin_scope', 1, unixepoch()),
  ('offer.update', 'user', 'deny', 'none', 'role_denied', 1, unixepoch()),
  ('offer.update', 'partner', 'allow', 'partner_owner', 'owned_offer', 1,
   unixepoch()),
  ('offer.update', 'admin', 'allow', 'global', 'admin_scope', 1, unixepoch()),
  ('offer.submit', 'user', 'deny', 'none', 'role_denied', 1, unixepoch()),
  ('offer.submit', 'partner', 'allow', 'partner_owner', 'owned_offer', 1,
   unixepoch()),
  ('offer.submit', 'admin', 'allow', 'global', 'admin_scope', 1, unixepoch()),
  ('application.read', 'user', 'allow', 'self', 'own_application', 1,
   unixepoch()),
  ('application.read', 'partner', 'allow', 'partner_owner',
   'owned_application', 1, unixepoch()),
  ('application.read', 'admin', 'allow', 'global', 'admin_scope', 1,
   unixepoch()),
  ('application.create', 'user', 'allow', 'self', 'own_application', 1,
   unixepoch()),
  ('application.create', 'partner', 'deny', 'none', 'role_denied', 1,
   unixepoch()),
  ('application.create', 'admin', 'allow', 'global', 'admin_scope', 1,
   unixepoch()),
  ('application.update', 'user', 'deny', 'none', 'role_denied', 1,
   unixepoch()),
  ('application.update', 'partner', 'allow', 'partner_owner',
   'owned_application', 1, unixepoch()),
  ('application.update', 'admin', 'allow', 'global', 'admin_scope', 1,
   unixepoch()),
  ('export.create', 'user', 'allow', 'self', 'own_export', 1, unixepoch()),
  ('export.create', 'partner', 'allow', 'partner_owner', 'owned_export', 1,
   unixepoch()),
  ('export.create', 'admin', 'allow', 'global', 'admin_scope', 1, unixepoch());

CREATE TABLE IF NOT EXISTS cabinet_tariff_capacity (
  plan_code TEXT PRIMARY KEY CHECK (plan_code IN (
    'free', 'professional', 'dragon'
  )),
  capacity_percent INTEGER NOT NULL CHECK (
    capacity_percent IN (10, 50, 100)
  ),
  capacity_version INTEGER NOT NULL DEFAULT 1 CHECK (capacity_version = 1),
  policy_version TEXT NOT NULL DEFAULT 'tariff_capacity_v1'
    CHECK (policy_version = 'tariff_capacity_v1'),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

INSERT OR IGNORE INTO cabinet_tariff_capacity (
  plan_code, capacity_percent, capacity_version, policy_version, created_at
) VALUES
  ('free', 10, 1, 'tariff_capacity_v1', unixepoch()),
  ('professional', 50, 1, 'tariff_capacity_v1', unixepoch()),
  ('dragon', 100, 1, 'tariff_capacity_v1', unixepoch());

CREATE TABLE IF NOT EXISTS cabinet_plan_quotas (
  plan_code TEXT NOT NULL REFERENCES cabinet_tariff_capacity(plan_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  quota_code TEXT NOT NULL CHECK (quota_code IN (
    'active_applications', 'successful_ai_messages_utc_day'
  )),
  limit_value INTEGER NOT NULL CHECK (limit_value > 0),
  window_kind TEXT NOT NULL CHECK (window_kind IN ('concurrent', 'utc_day')),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'fixed_product_override', 'capacity_formula'
  )),
  quota_version INTEGER NOT NULL DEFAULT 1 CHECK (quota_version = 1),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (plan_code, quota_code),
  CHECK (
    (quota_code = 'active_applications' AND window_kind = 'concurrent'
      AND source_kind = 'fixed_product_override')
    OR
    (quota_code = 'successful_ai_messages_utc_day'
      AND window_kind = 'utc_day' AND source_kind = 'capacity_formula')
  )
);

INSERT OR IGNORE INTO cabinet_plan_quotas (
  plan_code, quota_code, limit_value, window_kind, source_kind,
  quota_version, created_at
) VALUES
  ('free', 'active_applications', 5, 'concurrent',
   'fixed_product_override', 1, unixepoch()),
  ('professional', 'active_applications', 25, 'concurrent',
   'fixed_product_override', 1, unixepoch()),
  ('dragon', 'active_applications', 50, 'concurrent',
   'fixed_product_override', 1, unixepoch()),
  ('free', 'successful_ai_messages_utc_day', 5, 'utc_day',
   'capacity_formula', 1, unixepoch()),
  ('professional', 'successful_ai_messages_utc_day', 25, 'utc_day',
   'capacity_formula', 1, unixepoch()),
  ('dragon', 'successful_ai_messages_utc_day', 50, 'utc_day',
   'capacity_formula', 1, unixepoch());

CREATE TABLE IF NOT EXISTS cabinet_partner_specializations (
  partner_profile_id INTEGER PRIMARY KEY REFERENCES partner_profiles(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  specialization TEXT NOT NULL CHECK (specialization IN (
    'producer', 'investor', 'scout'
  )),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  changed_by INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  last_idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(last_idempotency_key) = 68
    AND substr(last_idempotency_key, 1, 4) = 'key_'
    AND substr(last_idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS cabinet_partner_specialization_events (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) = 68
    AND substr(event_id, 1, 4) = 'spe_'
    AND substr(event_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  partner_profile_id INTEGER NOT NULL REFERENCES partner_profiles(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'partner', 'admin', 'system'
  )),
  before_hash TEXT NOT NULL CHECK (
    length(before_hash) = 64
    AND before_hash = lower(before_hash)
    AND before_hash NOT GLOB '*[^0-9a-f]*'
  ),
  after_hash TEXT NOT NULL CHECK (
    length(after_hash) = 64
    AND after_hash = lower(after_hash)
    AND after_hash NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) = 68
    AND substr(idempotency_key, 1, 4) = 'key_'
    AND substr(idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  CHECK (before_hash != after_hash)
);

CREATE INDEX IF NOT EXISTS idx_cabinet_specialization_events_profile
  ON cabinet_partner_specialization_events(
    partner_profile_id, occurred_at, event_id
  );

CREATE TABLE IF NOT EXISTS cabinet_resource_bindings (
  resource_id TEXT PRIMARY KEY CHECK (
    length(resource_id) = 68
    AND substr(resource_id, 1, 4) = 'res_'
    AND substr(resource_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN (
    'profile', 'offer', 'application', 'export'
  )),
  authority_kind TEXT NOT NULL CHECK (authority_kind IN (
    'users', 'partner_profiles', 'offer_owners', 'lead_requests', 'cabinet'
  )),
  authority_key_hash TEXT NOT NULL CHECK (
    length(authority_key_hash) = 64
    AND authority_key_hash = lower(authority_key_hash)
    AND authority_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user', 'partner', 'system')),
  owner_telegram_id INTEGER REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  owner_partner_profile_id INTEGER REFERENCES partner_profiles(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  UNIQUE (resource_kind, authority_kind, authority_key_hash),
  CHECK (
    (owner_kind = 'user' AND owner_telegram_id IS NOT NULL
      AND owner_partner_profile_id IS NULL)
    OR
    (owner_kind = 'partner' AND owner_telegram_id IS NOT NULL
      AND owner_partner_profile_id IS NOT NULL)
    OR
    (owner_kind = 'system' AND owner_telegram_id IS NULL
      AND owner_partner_profile_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_cabinet_resource_bindings_user
  ON cabinet_resource_bindings(
    owner_telegram_id, resource_kind, resource_id
  );

CREATE INDEX IF NOT EXISTS idx_cabinet_resource_bindings_partner
  ON cabinet_resource_bindings(
    owner_partner_profile_id, resource_kind, resource_id
  );

CREATE TABLE IF NOT EXISTS cabinet_capability_grants (
  grant_id TEXT PRIMARY KEY CHECK (
    length(grant_id) = 68
    AND substr(grant_id, 1, 4) = 'cgr_'
    AND substr(grant_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  actor_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  capability_code TEXT NOT NULL REFERENCES cabinet_capability_registry(
    capability_code
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  scope_rule TEXT NOT NULL CHECK (scope_rule IN (
    'global', 'self', 'partner_owner', 'resource'
  )),
  resource_id TEXT REFERENCES cabinet_resource_bindings(resource_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  starts_at INTEGER NOT NULL CHECK (starts_at > 0),
  expires_at INTEGER CHECK (expires_at IS NULL OR expires_at > starts_at),
  issued_by INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (
    length(reason_code) BETWEEN 3 AND 48
    AND reason_code = lower(reason_code)
    AND reason_code NOT GLOB '*[^a-z0-9_]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) = 68
    AND substr(idempotency_key, 1, 4) = 'key_'
    AND substr(idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash = lower(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at = starts_at),
  CHECK (
    (scope_rule = 'resource' AND resource_id IS NOT NULL)
    OR (scope_rule != 'resource' AND resource_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_cabinet_capability_grants_actor
  ON cabinet_capability_grants(
    actor_telegram_id, capability_code, starts_at, grant_id
  );

CREATE TABLE IF NOT EXISTS cabinet_capability_grant_revocations (
  revocation_id TEXT PRIMARY KEY CHECK (
    length(revocation_id) = 68
    AND substr(revocation_id, 1, 4) = 'crv_'
    AND substr(revocation_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  grant_id TEXT NOT NULL UNIQUE REFERENCES cabinet_capability_grants(grant_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (
    length(reason_code) BETWEEN 3 AND 48
    AND reason_code = lower(reason_code)
    AND reason_code NOT GLOB '*[^a-z0-9_]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) = 68
    AND substr(idempotency_key, 1, 4) = 'key_'
    AND substr(idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash = lower(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  revoked_at INTEGER NOT NULL CHECK (revoked_at > 0)
);

CREATE TABLE IF NOT EXISTS cabinet_init_data_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(receipt_id) = 68
    AND substr(receipt_id, 1, 4) = 'idr_'
    AND substr(receipt_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  init_data_hash TEXT NOT NULL UNIQUE CHECK (
    length(init_data_hash) = 64
    AND init_data_hash = lower(init_data_hash)
    AND init_data_hash NOT GLOB '*[^0-9a-f]*'
  ),
  bot_id INTEGER NOT NULL CHECK (bot_id > 0),
  telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  query_id_hash TEXT CHECK (
    query_id_hash IS NULL
    OR (length(query_id_hash) = 64
      AND query_id_hash = lower(query_id_hash)
      AND query_id_hash NOT GLOB '*[^0-9a-f]*')
  ),
  auth_date INTEGER NOT NULL CHECK (auth_date > 0),
  received_at INTEGER NOT NULL CHECK (received_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= received_at),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) = 68
    AND substr(idempotency_key, 1, 4) = 'key_'
    AND substr(idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= expires_at
    AND retention_until <= received_at + 15552000
  ),
  CHECK (auth_date <= received_at + 60),
  CHECK (received_at <= auth_date + 900),
  CHECK (expires_at <= auth_date + 900)
);

CREATE INDEX IF NOT EXISTS idx_cabinet_init_data_receipts_retention
  ON cabinet_init_data_receipts(retention_until, receipt_id);

CREATE TABLE IF NOT EXISTS cabinet_sessions (
  session_id TEXT PRIMARY KEY CHECK (
    length(session_id) = 68
    AND substr(session_id, 1, 4) = 'ses_'
    AND substr(session_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  session_token_hash TEXT NOT NULL UNIQUE CHECK (
    length(session_token_hash) = 64
    AND session_token_hash = lower(session_token_hash)
    AND session_token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  receipt_id TEXT NOT NULL UNIQUE REFERENCES cabinet_init_data_receipts(
    receipt_id
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  bot_id INTEGER NOT NULL CHECK (bot_id > 0),
  token_version INTEGER NOT NULL DEFAULT 1 CHECK (token_version = 1),
  issued_at INTEGER NOT NULL CHECK (issued_at > 0),
  expires_at INTEGER NOT NULL CHECK (
    expires_at > issued_at AND expires_at <= issued_at + 900
  ),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= expires_at
    AND retention_until <= issued_at + 15552000
  )
);

CREATE INDEX IF NOT EXISTS idx_cabinet_sessions_identity
  ON cabinet_sessions(telegram_id, expires_at, session_id);

CREATE INDEX IF NOT EXISTS idx_cabinet_sessions_retention
  ON cabinet_sessions(retention_until, session_id);

CREATE TABLE IF NOT EXISTS cabinet_authorization_audit (
  audit_id TEXT PRIMARY KEY CHECK (
    length(audit_id) = 68
    AND substr(audit_id, 1, 4) = 'aud_'
    AND substr(audit_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  actor_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('user', 'partner', 'admin')),
  requested_capability TEXT NOT NULL CHECK (
    length(requested_capability) BETWEEN 3 AND 64
    AND requested_capability = lower(requested_capability)
    AND requested_capability NOT GLOB '*[^a-z0-9._]*'
  ),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN (
    'profile', 'offer', 'application', 'export', 'unknown'
  )),
  resource_id TEXT REFERENCES cabinet_resource_bindings(resource_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'baseline_allow', 'grant_allow', 'explicit_deny', 'feature_off',
    'invalid_actor', 'invalid_resource', 'role_denied', 'scope_denied',
    'unknown_capability'
  )),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'mini_app', 'worker', 'admin', 'system'
  )),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash = lower(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  before_hash TEXT NOT NULL CHECK (
    length(before_hash) = 64
    AND before_hash = lower(before_hash)
    AND before_hash NOT GLOB '*[^0-9a-f]*'
  ),
  after_hash TEXT NOT NULL CHECK (
    length(after_hash) = 64
    AND after_hash = lower(after_hash)
    AND after_hash NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) = 68
    AND substr(idempotency_key, 1, 4) = 'key_'
    AND substr(idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= occurred_at
    AND retention_until <= occurred_at + 15552000
  )
);

CREATE INDEX IF NOT EXISTS idx_cabinet_authorization_audit_actor
  ON cabinet_authorization_audit(
    actor_telegram_id, occurred_at, audit_id
  );

CREATE INDEX IF NOT EXISTS idx_cabinet_authorization_audit_retention
  ON cabinet_authorization_audit(retention_until, audit_id);

CREATE TABLE IF NOT EXISTS cabinet_privacy_maintenance_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  reason TEXT NOT NULL CHECK (reason IN ('retention', 'user_deletion')),
  subject_telegram_id INTEGER REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  token_hash TEXT NOT NULL CHECK (
    length(token_hash) = 64
    AND token_hash = lower(token_hash)
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_by INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  expires_at INTEGER NOT NULL CHECK (
    expires_at >= created_at AND expires_at <= created_at + 900
  ),
  CHECK (
    (reason = 'retention' AND subject_telegram_id IS NULL)
    OR (reason = 'user_deletion' AND subject_telegram_id IS NOT NULL)
  )
);

CREATE TRIGGER IF NOT EXISTS trg_cabinet_v1_settings_identity
BEFORE UPDATE ON cabinet_v1_settings
WHEN NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT, 'cabinet settings identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_v1_settings_revision
BEFORE UPDATE ON cabinet_v1_settings
WHEN NEW.revision != OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'cabinet settings revision must advance exactly once');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_v1_settings_admin_update
BEFORE UPDATE ON cabinet_v1_settings
WHEN NEW.updated_by IS NULL OR NOT EXISTS (
  SELECT 1 FROM user_roles role
  WHERE role.telegram_id = NEW.updated_by
    AND role.role = 'admin' AND role.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet settings update requires active admin');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_v1_settings_monotonic_time
BEFORE UPDATE ON cabinet_v1_settings
WHEN NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'cabinet settings time cannot regress');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_v1_settings_no_delete
BEFORE DELETE ON cabinet_v1_settings
BEGIN
  SELECT RAISE(ABORT, 'cabinet settings cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_capability_registry_no_update
BEFORE UPDATE ON cabinet_capability_registry
BEGIN
  SELECT RAISE(ABORT, 'cabinet capability registry is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_capability_registry_no_delete
BEFORE DELETE ON cabinet_capability_registry
BEGIN
  SELECT RAISE(ABORT, 'cabinet capability registry cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_role_matrix_no_update
BEFORE UPDATE ON cabinet_role_capability_matrix
BEGIN
  SELECT RAISE(ABORT, 'cabinet role matrix is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_role_matrix_no_delete
BEFORE DELETE ON cabinet_role_capability_matrix
BEGIN
  SELECT RAISE(ABORT, 'cabinet role matrix cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_tariff_capacity_no_update
BEFORE UPDATE ON cabinet_tariff_capacity
BEGIN
  SELECT RAISE(ABORT, 'cabinet tariff capacity is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_tariff_capacity_no_delete
BEFORE DELETE ON cabinet_tariff_capacity
BEGIN
  SELECT RAISE(ABORT, 'cabinet tariff capacity cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_plan_quotas_no_update
BEFORE UPDATE ON cabinet_plan_quotas
BEGIN
  SELECT RAISE(ABORT, 'cabinet plan quotas are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_plan_quotas_no_delete
BEFORE DELETE ON cabinet_plan_quotas
BEGIN
  SELECT RAISE(ABORT, 'cabinet plan quotas cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_specialization_active_partner_insert
BEFORE INSERT ON cabinet_partner_specializations
WHEN NOT EXISTS (
  SELECT 1 FROM partner_profiles profile
  WHERE profile.id = NEW.partner_profile_id AND profile.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet specialization requires active partner');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_specialization_active_partner_update
BEFORE UPDATE ON cabinet_partner_specializations
WHEN NOT EXISTS (
  SELECT 1 FROM partner_profiles profile
  WHERE profile.id = NEW.partner_profile_id AND profile.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet specialization requires active partner');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_specialization_actor_insert
BEFORE INSERT ON cabinet_partner_specializations
WHEN NOT EXISTS (
  SELECT 1 FROM partner_profiles profile
  WHERE profile.id = NEW.partner_profile_id
    AND profile.telegram_id = NEW.changed_by
)
AND NOT EXISTS (
  SELECT 1 FROM user_roles role
  WHERE role.telegram_id = NEW.changed_by
    AND role.role = 'admin' AND role.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet specialization actor is not owner or admin');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_specialization_actor_update
BEFORE UPDATE ON cabinet_partner_specializations
WHEN NOT EXISTS (
  SELECT 1 FROM partner_profiles profile
  WHERE profile.id = NEW.partner_profile_id
    AND profile.telegram_id = NEW.changed_by
)
AND NOT EXISTS (
  SELECT 1 FROM user_roles role
  WHERE role.telegram_id = NEW.changed_by
    AND role.role = 'admin' AND role.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet specialization actor is not owner or admin');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_specialization_identity
BEFORE UPDATE ON cabinet_partner_specializations
WHEN NEW.partner_profile_id IS NOT OLD.partner_profile_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'cabinet specialization identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_specialization_revision
BEFORE UPDATE ON cabinet_partner_specializations
WHEN NEW.revision != OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'cabinet specialization revision must advance once');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_specialization_monotonic_time
BEFORE UPDATE ON cabinet_partner_specializations
WHEN NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'cabinet specialization time cannot regress');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_specialization_no_delete
BEFORE DELETE ON cabinet_partner_specializations
BEGIN
  SELECT RAISE(ABORT, 'cabinet specialization cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_specialization_events_no_update
BEFORE UPDATE ON cabinet_partner_specialization_events
BEGIN
  SELECT RAISE(ABORT, 'cabinet specialization events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_specialization_events_actor_insert
BEFORE INSERT ON cabinet_partner_specialization_events
WHEN (
  NEW.source_kind = 'partner' AND NOT EXISTS (
    SELECT 1 FROM partner_profiles profile
    WHERE profile.id = NEW.partner_profile_id
      AND profile.telegram_id = NEW.actor_telegram_id
      AND profile.status = 'active'
  )
)
OR (
  NEW.source_kind IN ('admin', 'system') AND NOT EXISTS (
    SELECT 1 FROM user_roles role
    WHERE role.telegram_id = NEW.actor_telegram_id
      AND role.role = 'admin' AND role.status = 'active'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet specialization event actor mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_specialization_events_no_delete
BEFORE DELETE ON cabinet_partner_specialization_events
BEGIN
  SELECT RAISE(ABORT, 'cabinet specialization events cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_resource_partner_owner_insert
BEFORE INSERT ON cabinet_resource_bindings
WHEN NEW.owner_kind = 'partner' AND NOT EXISTS (
  SELECT 1 FROM partner_profiles profile
  WHERE profile.id = NEW.owner_partner_profile_id
    AND profile.telegram_id = NEW.owner_telegram_id
    AND profile.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet resource partner ownership mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_resource_bindings_no_update
BEFORE UPDATE ON cabinet_resource_bindings
BEGIN
  SELECT RAISE(ABORT, 'cabinet resource bindings are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_resource_bindings_no_delete
BEFORE DELETE ON cabinet_resource_bindings
BEGIN
  SELECT RAISE(ABORT, 'cabinet resource bindings cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_capability_grants_no_update
BEFORE UPDATE ON cabinet_capability_grants
BEGIN
  SELECT RAISE(ABORT, 'cabinet capability grants are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_capability_grants_admin_insert
BEFORE INSERT ON cabinet_capability_grants
WHEN NOT EXISTS (
  SELECT 1 FROM user_roles role
  WHERE role.telegram_id = NEW.issued_by
    AND role.role = 'admin' AND role.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet capability grant requires active admin');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_capability_grants_no_delete
BEFORE DELETE ON cabinet_capability_grants
BEGIN
  SELECT RAISE(ABORT, 'cabinet capability grants cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_grant_revocations_no_update
BEFORE UPDATE ON cabinet_capability_grant_revocations
BEGIN
  SELECT RAISE(ABORT, 'cabinet grant revocations are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_grant_revocations_admin_insert
BEFORE INSERT ON cabinet_capability_grant_revocations
WHEN NOT EXISTS (
  SELECT 1 FROM user_roles role
  WHERE role.telegram_id = NEW.actor_telegram_id
    AND role.role = 'admin' AND role.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet grant revocation requires active admin');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_grant_revocations_no_delete
BEFORE DELETE ON cabinet_capability_grant_revocations
BEGIN
  SELECT RAISE(ABORT, 'cabinet grant revocations cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_init_data_receipts_no_update
BEFORE UPDATE ON cabinet_init_data_receipts
BEGIN
  SELECT RAISE(ABORT, 'cabinet initData receipts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_init_data_receipts_guarded_delete
BEFORE DELETE ON cabinet_init_data_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_privacy_maintenance_guard guard
  WHERE guard.id = 1 AND guard.expires_at >= unixepoch()
    AND (
      (guard.reason = 'retention' AND OLD.retention_until <= unixepoch())
      OR (guard.reason = 'user_deletion'
        AND guard.subject_telegram_id = OLD.telegram_id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet initData deletion requires privacy guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_session_receipt_guard
BEFORE INSERT ON cabinet_sessions
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_init_data_receipts receipt
  WHERE receipt.receipt_id = NEW.receipt_id
    AND receipt.telegram_id = NEW.telegram_id
    AND receipt.bot_id = NEW.bot_id
    AND receipt.expires_at >= NEW.issued_at
    AND NEW.expires_at <= receipt.expires_at
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet session receipt mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_sessions_no_update
BEFORE UPDATE ON cabinet_sessions
BEGIN
  SELECT RAISE(ABORT, 'cabinet sessions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_sessions_guarded_delete
BEFORE DELETE ON cabinet_sessions
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_privacy_maintenance_guard guard
  WHERE guard.id = 1 AND guard.expires_at >= unixepoch()
    AND (
      (guard.reason = 'retention' AND OLD.retention_until <= unixepoch())
      OR (guard.reason = 'user_deletion'
        AND guard.subject_telegram_id = OLD.telegram_id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet session deletion requires privacy guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_authorization_audit_no_update
BEFORE UPDATE ON cabinet_authorization_audit
BEGIN
  SELECT RAISE(ABORT, 'cabinet authorization audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_authorization_audit_role_insert
BEFORE INSERT ON cabinet_authorization_audit
WHEN (NEW.actor_role = 'partner' AND NOT EXISTS (
  SELECT 1 FROM user_roles role
  JOIN partner_profiles profile ON profile.telegram_id = role.telegram_id
  WHERE role.telegram_id = NEW.actor_telegram_id
    AND role.role = 'partner' AND role.status = 'active'
    AND profile.status = 'active'
))
OR (NEW.actor_role = 'admin' AND NOT EXISTS (
  SELECT 1 FROM user_roles role
  WHERE role.telegram_id = NEW.actor_telegram_id
    AND role.role = 'admin' AND role.status = 'active'
))
BEGIN
  SELECT RAISE(ABORT, 'cabinet authorization audit role mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_authorization_audit_guarded_delete
BEFORE DELETE ON cabinet_authorization_audit
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_privacy_maintenance_guard guard
  WHERE guard.id = 1 AND guard.expires_at >= unixepoch()
    AND (
      (guard.reason = 'retention' AND OLD.retention_until <= unixepoch())
      OR (guard.reason = 'user_deletion'
        AND guard.subject_telegram_id = OLD.actor_telegram_id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet audit deletion requires privacy guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_privacy_guard_no_update
BEFORE UPDATE ON cabinet_privacy_maintenance_guard
BEGIN
  SELECT RAISE(ABORT, 'cabinet privacy guard must be replaced, not updated');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_privacy_guard_admin_insert
BEFORE INSERT ON cabinet_privacy_maintenance_guard
WHEN NOT EXISTS (
  SELECT 1 FROM user_roles role
  WHERE role.telegram_id = NEW.created_by
    AND role.role = 'admin' AND role.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet privacy guard requires active admin');
END;

INSERT OR IGNORE INTO re_schema_migrations(version)
VALUES ('0043-v1.4.0-cabinet-foundation');
