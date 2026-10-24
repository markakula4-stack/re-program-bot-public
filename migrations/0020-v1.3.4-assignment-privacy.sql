-- Additive split: immutable assignment facts contain no personal identifiers.
-- Deployment gate requires zero legacy personal assignment events while Beta
-- remains disabled. Existing tables, rows and immutable triggers stay intact.
CREATE TABLE IF NOT EXISTS offer_assignment_event_private (
  event_id INTEGER PRIMARY KEY REFERENCES offer_visibility_assignment_events(id),
  telegram_id INTEGER NOT NULL,
  actor_id INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_offer_assignment_private_user
  ON offer_assignment_event_private(telegram_id);
CREATE INDEX IF NOT EXISTS idx_offer_assignment_private_actor
  ON offer_assignment_event_private(actor_id);

CREATE TRIGGER IF NOT EXISTS trg_offer_assignment_no_new_personal_data
BEFORE INSERT ON offer_visibility_assignment_events
WHEN NEW.telegram_id <> 0 OR NEW.actor_id <> 0 OR NEW.reason <> ''
BEGIN
  SELECT RAISE(ABORT, 'assignment personal data must use private storage');
END;

CREATE TRIGGER IF NOT EXISTS trg_offer_assignment_private_immutable_update
BEFORE UPDATE ON offer_assignment_event_private
BEGIN
  SELECT RAISE(ABORT, 'assignment private history is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_offer_assignment_private_delete_guard
BEFORE DELETE ON offer_assignment_event_private
WHEN NOT EXISTS (
  SELECT 1 FROM privacy_deletion_requests
  WHERE telegram_id IN (OLD.telegram_id, OLD.actor_id)
    AND status = 'pending' AND datetime(expires_at) > datetime('now')
) AND NOT EXISTS (
  SELECT 1 FROM offer_visibility_assignment_events
  WHERE id = OLD.event_id
    AND datetime(created_at) <= datetime('now', '-180 days')
)
BEGIN
  SELECT RAISE(ABORT, 'assignment private data requires deletion request or retention expiry');
END;

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.4-assignment-privacy');
