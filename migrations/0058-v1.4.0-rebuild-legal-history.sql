-- P10 additive candidate, selected after LIVE inventory on 2026-09-30.

-- Existing canonical/cabinet objects and rows remain unchanged.

-- Apply through the guarded reviewed release controller; never all historical files.

CREATE TABLE IF NOT EXISTS partner_legal_profiles (
  partner_profile_id INTEGER PRIMARY KEY REFERENCES partner_profiles(id),
  profile_kind TEXT NOT NULL CHECK (profile_kind IN
    ('individual', 'self_employed', 'individual_entrepreneur')),
  verification_state TEXT NOT NULL CHECK (verification_state = 'self_declared'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  declared_by INTEGER NOT NULL,
  declared_at TEXT NOT NULL,
  verified_by INTEGER CHECK (verified_by IS NULL),
  verified_at TEXT CHECK (verified_at IS NULL),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS partner_legal_profile_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_profile_id INTEGER NOT NULL,
  from_kind TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  from_revision INTEGER NOT NULL,
  to_revision INTEGER NOT NULL,
  actor_id INTEGER NOT NULL,
  actor_role TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS rebuild_legal_history_no_update BEFORE UPDATE ON partner_legal_profile_events
BEGIN SELECT RAISE(ABORT, 'legal history is immutable'); END;

CREATE TRIGGER IF NOT EXISTS rebuild_legal_history_no_delete BEFORE DELETE ON partner_legal_profile_events
BEGIN SELECT RAISE(ABORT, 'legal history is immutable'); END;

CREATE INDEX IF NOT EXISTS idx_rebuild_legal_history ON partner_legal_profile_events(partner_profile_id, id);

INSERT OR IGNORE INTO re_schema_migrations(version) VALUES ('1.4.0-rebuild-legal-history');
