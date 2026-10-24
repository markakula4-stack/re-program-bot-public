-- P12 release-owned lease. Empty after expand; no business backfill.
-- No FK to users: confirmed privacy deletion clears an active owner atomically.
CREATE TABLE IF NOT EXISTS mini_app_release_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  candidate_sha TEXT NOT NULL CHECK (length(candidate_sha) = 40 AND candidate_sha NOT GLOB '*[^0-9a-f]*'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('closed','open')),
  beta_enabled INTEGER NOT NULL DEFAULT 0 CHECK (beta_enabled IN (0,1)),
  owner_telegram_id INTEGER CHECK (owner_telegram_id IS NULL OR owner_telegram_id > 0),
  issued_at INTEGER,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK ((state = 'closed' AND beta_enabled = 0 AND owner_telegram_id IS NULL AND issued_at IS NULL AND expires_at IS NULL)
    OR (state = 'open' AND owner_telegram_id IS NOT NULL AND issued_at > 0
      AND expires_at > issued_at AND expires_at <= issued_at + 1200))
);
INSERT OR IGNORE INTO re_schema_migrations(version) VALUES ('1.4.0-rebuild-release-lease');
