-- P10 additive candidate, selected after LIVE inventory on 2026-09-30.

-- Existing canonical/cabinet objects and rows remain unchanged.

-- Apply through the guarded reviewed release controller; never all historical files.

CREATE TABLE IF NOT EXISTS lead_request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  lead_id INTEGER NOT NULL REFERENCES lead_requests(id),
  operation TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  status_from TEXT,
  status_to TEXT NOT NULL,
  actor_telegram_id INTEGER NOT NULL,
  actor_role TEXT NOT NULL,
  offer_code TEXT NOT NULL,
  reward_kopecks INTEGER NOT NULL CHECK (reward_kopecks >= 0),
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS rebuild_lead_history_no_update BEFORE UPDATE ON lead_request_events
BEGIN SELECT RAISE(ABORT, 'lead history is immutable'); END;

CREATE TRIGGER IF NOT EXISTS rebuild_lead_history_no_delete BEFORE DELETE ON lead_request_events
BEGIN SELECT RAISE(ABORT, 'lead history is immutable'); END;

CREATE INDEX IF NOT EXISTS idx_rebuild_lead_history ON lead_request_events(lead_id, id);

CREATE INDEX IF NOT EXISTS idx_rebuild_lead_actor_time ON lead_request_events(actor_telegram_id, occurred_at);

INSERT OR IGNORE INTO re_schema_migrations(version) VALUES ('1.4.0-rebuild-lead-history');
