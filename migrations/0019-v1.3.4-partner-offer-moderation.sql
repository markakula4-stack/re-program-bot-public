-- RE Program Bot v1.3.4 — Partner Beta moderation and visibility history.
-- Additive and idempotent. Existing partner, offer, link and audit tables stay
-- canonical; the new tables only preserve append-only administrative events.

CREATE TABLE IF NOT EXISTS partner_beta_access_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_profile_id INTEGER NOT NULL,
  action TEXT NOT NULL
    CHECK (action IN ('granted', 'paused', 'resumed', 'revoked')),
  from_status TEXT NOT NULL DEFAULT '',
  to_status TEXT NOT NULL,
  actor_id INTEGER NOT NULL,
  actor_role TEXT NOT NULL DEFAULT 'admin' CHECK (actor_role = 'admin'),
  reason TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  event_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_partner_beta_access_events_profile
  ON partner_beta_access_events
    (partner_profile_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS offer_visibility_assignment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_code TEXT NOT NULL,
  offer_version_id INTEGER NOT NULL,
  telegram_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('assigned', 'revoked')),
  actor_id INTEGER NOT NULL,
  actor_role TEXT NOT NULL DEFAULT 'admin' CHECK (actor_role = 'admin'),
  reason TEXT NOT NULL DEFAULT '',
  event_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_offer_assignment_events_offer
  ON offer_visibility_assignment_events
    (offer_code, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_offer_assignment_events_user
  ON offer_visibility_assignment_events
    (telegram_id, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_partner_beta_events_immutable_update
BEFORE UPDATE ON partner_beta_access_events
BEGIN
  SELECT RAISE(ABORT, 'partner beta access events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_partner_beta_events_immutable_delete
BEFORE DELETE ON partner_beta_access_events
BEGIN
  SELECT RAISE(ABORT, 'partner beta access events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_offer_assignment_events_immutable_update
BEFORE UPDATE ON offer_visibility_assignment_events
BEGIN
  SELECT RAISE(ABORT, 'offer assignment events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_offer_assignment_events_immutable_delete
BEFORE DELETE ON offer_visibility_assignment_events
BEGIN
  SELECT RAISE(ABORT, 'offer assignment events are immutable');
END;

-- Legacy system-offer deletion remains compatible. Only partner-owned
-- moderation history is protected from mutation and deletion.
CREATE TRIGGER IF NOT EXISTS trg_partner_moderation_immutable_update
BEFORE UPDATE ON offer_moderation_decisions
WHEN EXISTS (
  SELECT 1 FROM offer_owners
  WHERE offer_code = OLD.offer_code AND owner_kind = 'partner'
)
BEGIN
  SELECT RAISE(ABORT, 'partner offer moderation decisions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_partner_moderation_immutable_delete
BEFORE DELETE ON offer_moderation_decisions
WHEN EXISTS (
  SELECT 1 FROM offer_owners
  WHERE offer_code = OLD.offer_code AND owner_kind = 'partner'
)
BEGIN
  SELECT RAISE(ABORT, 'partner offer moderation decisions are immutable');
END;

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.4-partner-offer-moderation');
