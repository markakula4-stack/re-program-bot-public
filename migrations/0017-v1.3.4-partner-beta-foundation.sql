-- RE Program Bot v1.3.4 — Partner Beta and private offer foundation.
-- Additive and idempotent: existing tables, columns, callbacks and data remain.

CREATE TABLE IF NOT EXISTS partner_beta_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  private_offers_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (private_offers_enabled IN (0, 1)),
  submissions_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (submissions_enabled IN (0, 1)),
  public_visibility_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (public_visibility_enabled IN (0, 1)),
  max_active_offers_per_partner INTEGER NOT NULL DEFAULT 3
    CHECK (max_active_offers_per_partner BETWEEN 1 AND 50),
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO partner_beta_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS partner_beta_access (
  partner_profile_id INTEGER PRIMARY KEY,
  access_status TEXT NOT NULL DEFAULT 'active'
    CHECK (access_status IN ('active', 'paused', 'revoked')),
  can_create_private_offers INTEGER NOT NULL DEFAULT 1
    CHECK (can_create_private_offers IN (0, 1)),
  can_submit_offers INTEGER NOT NULL DEFAULT 1
    CHECK (can_submit_offers IN (0, 1)),
  granted_by INTEGER NOT NULL,
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  reason TEXT NOT NULL DEFAULT '',
  status_changed_by INTEGER,
  status_changed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_partner_beta_access_status
  ON partner_beta_access(access_status, expires_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS partner_application_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  decision TEXT NOT NULL
    CHECK (decision IN ('submitted', 'resubmitted', 'approved', 'rejected')),
  actor_id INTEGER NOT NULL,
  actor_role TEXT NOT NULL
    CHECK (actor_role IN ('user', 'admin', 'system')),
  reason TEXT NOT NULL DEFAULT '',
  event_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_partner_application_decisions_application
  ON partner_application_decisions(application_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS offer_owners (
  offer_code TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('system', 'partner')),
  partner_profile_id INTEGER,
  created_by INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (owner_kind = 'system' AND partner_profile_id IS NULL) OR
    (owner_kind = 'partner' AND partner_profile_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_offer_owners_partner
  ON offer_owners(partner_profile_id, owner_kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS offer_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_code TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  snapshot_schema_version INTEGER NOT NULL DEFAULT 1
    CHECK (snapshot_schema_version > 0),
  snapshot_json TEXT NOT NULL,
  business_status TEXT NOT NULL
    CHECK (business_status IN ('draft', 'active', 'paused', 'archived')),
  content_hash TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (offer_code, version_number)
);

CREATE INDEX IF NOT EXISTS idx_offer_versions_offer
  ON offer_versions(offer_code, version_number DESC, id DESC);

CREATE TABLE IF NOT EXISTS offer_visibility_rules (
  offer_code TEXT PRIMARY KEY,
  moderation_status TEXT NOT NULL DEFAULT 'not_submitted'
    CHECK (moderation_status IN
      ('not_submitted', 'pending', 'changes_requested', 'approved', 'rejected')),
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'assigned', 'public')),
  current_version_id INTEGER NOT NULL,
  submitted_version_id INTEGER,
  approved_version_id INTEGER,
  published_at TEXT,
  updated_by INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_offer_visibility_public
  ON offer_visibility_rules(visibility, moderation_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS offer_visibility_assignments (
  offer_code TEXT NOT NULL,
  telegram_id INTEGER NOT NULL,
  assignment_status TEXT NOT NULL DEFAULT 'active'
    CHECK (assignment_status IN ('active', 'revoked')),
  assigned_by INTEGER NOT NULL,
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_by INTEGER,
  revoked_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (offer_code, telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_offer_assignments_user
  ON offer_visibility_assignments(telegram_id, assignment_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS offer_moderation_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_code TEXT NOT NULL,
  offer_version_id INTEGER,
  decision TEXT NOT NULL
    CHECK (decision IN
      ('submitted', 'approved', 'changes_requested', 'rejected',
       'approval_invalidated', 'visibility_changed', 'legacy_backfill')),
  from_status TEXT NOT NULL DEFAULT '',
  to_status TEXT NOT NULL DEFAULT '',
  actor_id INTEGER NOT NULL,
  actor_role TEXT NOT NULL
    CHECK (actor_role IN ('partner', 'admin', 'system')),
  reason TEXT NOT NULL DEFAULT '',
  event_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_offer_moderation_offer
  ON offer_moderation_decisions(offer_code, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_offer_moderation_queue
  ON offer_moderation_decisions(decision, created_at DESC, id DESC);

-- Existing partner application rows receive one historical starting event.
INSERT OR IGNORE INTO partner_application_decisions
  (application_id, decision, actor_id, actor_role, reason, event_key, created_at)
SELECT id,
       CASE status
         WHEN 'approved' THEN 'approved'
         WHEN 'rejected' THEN 'rejected'
         ELSE 'submitted'
       END,
       CASE
         WHEN status = 'pending' THEN telegram_id
         ELSE COALESCE(reviewed_by, 0)
       END,
       CASE
         WHEN status = 'pending' THEN 'user'
         WHEN reviewed_by IS NOT NULL THEN 'admin'
         ELSE 'system'
       END,
       CASE
         WHEN status = 'rejected' THEN rejection_reason
         ELSE 'Совместимый снимок состояния до v1.3.4.'
       END,
       'v134-application-' || id || '-' || status,
       COALESCE(reviewed_at, submitted_at, updated_at, CURRENT_TIMESTAMP)
FROM partner_applications;

-- Every existing offer remains system-owned. Partner-owned offers are created
-- only by the v1.3.4 server flow after explicit Beta authorization.
INSERT OR IGNORE INTO offer_owners
  (offer_code, owner_kind, partner_profile_id, created_by, created_at,
   updated_by, updated_at)
SELECT code, 'system', NULL, 0, created_at, 0, updated_at
FROM offers;

-- Version 1 freezes all material legacy fields. SHA-256 is completed by the
-- Worker runtime because SQLite/D1 SQL has no portable built-in SHA-256.
INSERT OR IGNORE INTO offer_versions
  (offer_code, version_number, snapshot_schema_version, snapshot_json,
   business_status, content_hash, created_by, created_at)
SELECT code,
       1,
       1,
       json_object(
         'code', code,
         'button_text', button_text,
         'title', title,
         'description', description,
         'provider', provider,
         'category', category,
         'url', url,
         'url_env_key', url_env_key,
         'payout_text', payout_text,
         'required_action', required_action,
         'min_age', min_age,
         'max_age', max_age,
         'geo', geo,
         'hold_days', hold_days,
         'traffic_sources', traffic_sources,
         'source_name', source_name,
         'starts_at', starts_at,
         'expires_at', expires_at,
         'status', status
       ),
       status,
       '',
       0,
       created_at
FROM offers;

-- Preserve the exact public behavior of all active v1.3.3 offers. Every other
-- business state starts private and is not silently approved.
INSERT OR IGNORE INTO offer_visibility_rules
  (offer_code, moderation_status, visibility, current_version_id,
   submitted_version_id, approved_version_id, published_at, updated_by,
   updated_at)
SELECT o.code,
       CASE WHEN o.status = 'active' THEN 'approved' ELSE 'not_submitted' END,
       CASE WHEN o.status = 'active' THEN 'public' ELSE 'private' END,
       v.id,
       CASE WHEN o.status = 'active' THEN v.id ELSE NULL END,
       CASE WHEN o.status = 'active' THEN v.id ELSE NULL END,
       CASE WHEN o.status = 'active' THEN o.updated_at ELSE NULL END,
       0,
       o.updated_at
FROM offers o
JOIN offer_versions v
  ON v.offer_code = o.code AND v.version_number = 1;

INSERT OR IGNORE INTO offer_moderation_decisions
  (offer_code, offer_version_id, decision, from_status, to_status,
   actor_id, actor_role, reason, event_key, created_at)
SELECT o.code,
       v.id,
       'legacy_backfill',
       '',
       CASE WHEN o.status = 'active' THEN 'approved' ELSE 'not_submitted' END,
       0,
       'system',
       CASE
         WHEN o.status = 'active'
           THEN 'Сохранена публичная совместимость активного оффера v1.3.3.'
         ELSE 'Сохранён непубличный бизнес-статус оффера v1.3.3.'
       END,
       'v134-offer-' || o.code || '-legacy-backfill',
       o.updated_at
FROM offers o
JOIN offer_versions v
  ON v.offer_code = o.code AND v.version_number = 1;

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.4-partner-beta-foundation');
