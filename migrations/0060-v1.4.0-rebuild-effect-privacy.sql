-- P11: only rebuild-owned storage is extended. Historical objects are unchanged.
CREATE TABLE IF NOT EXISTS mini_app_effect_claims (
  dedupe_key TEXT PRIMARY KEY REFERENCES mini_app_effect_outbox(dedupe_key),
  claim_token TEXT NOT NULL UNIQUE,
  notification_id INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
  delivery_state TEXT NOT NULL CHECK (delivery_state IN
    ('stored','attempted','delivered','suppressed','unknown')),
  recipient_telegram_id INTEGER,
  attempted_at INTEGER,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_rebuild_effect_delivery
  ON mini_app_effect_claims(delivery_state, next_attempt_at, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_rebuild_effect_recipient
  ON mini_app_effect_claims(recipient_telegram_id);

CREATE TABLE IF NOT EXISTS mini_app_privacy_guard (
  guard_key TEXT PRIMARY KEY,
  subject_id INTEGER,
  reason TEXT NOT NULL CHECK (reason IN ('subject_deletion','retention')),
  request_id TEXT,
  subject_lead_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(subject_lead_ids_json) AND json_type(subject_lead_ids_json)='array'),
  expires_at INTEGER NOT NULL,
  precondition_ok INTEGER NOT NULL CHECK (precondition_ok = 1)
);
CREATE TABLE IF NOT EXISTS mini_app_privacy_denials (
  init_data_fingerprint TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rebuild_privacy_denial_expiry
  ON mini_app_privacy_denials(expires_at);

-- Replace only the two new P10 deletion guards; mutation remains forbidden.
DROP TRIGGER IF EXISTS rebuild_legal_history_no_delete;
CREATE TRIGGER rebuild_legal_history_no_delete BEFORE DELETE ON partner_legal_profile_events
WHEN NOT EXISTS (
  SELECT 1 FROM mini_app_privacy_guard g
  WHERE g.expires_at > unixepoch() AND (
    (g.reason = 'retention' AND unixepoch(OLD.created_at) <= unixepoch()-15552000)
    OR (g.reason = 'subject_deletion' AND
      (g.subject_id = OLD.actor_id OR g.subject_id IN
        (SELECT telegram_id FROM partner_profiles WHERE id=OLD.partner_profile_id))
      AND EXISTS (SELECT 1 FROM privacy_deletion_requests p
        WHERE p.request_id=g.request_id AND p.telegram_id=g.subject_id
          AND p.status='pending' AND unixepoch(p.expires_at)>unixepoch())
      AND NOT EXISTS (SELECT 1 FROM partner_profiles WHERE telegram_id=g.subject_id))
  )
)
BEGIN SELECT RAISE(ABORT, 'legal history requires confirmed deletion or retention'); END;

DROP TRIGGER IF EXISTS rebuild_lead_history_no_delete;
CREATE TRIGGER rebuild_lead_history_no_delete BEFORE DELETE ON lead_request_events
WHEN NOT EXISTS (
  SELECT 1 FROM mini_app_privacy_guard g
  WHERE g.expires_at > unixepoch() AND (
    (g.reason='retention' AND unixepoch(OLD.occurred_at)<=unixepoch()-15552000)
    OR (g.reason='subject_deletion' AND
      (g.subject_id=OLD.actor_telegram_id OR OLD.lead_id IN
        (SELECT CAST(value AS INTEGER) FROM json_each(g.subject_lead_ids_json)))
      AND EXISTS (SELECT 1 FROM privacy_deletion_requests p
        WHERE p.request_id=g.request_id AND p.telegram_id=g.subject_id
          AND p.status='pending' AND unixepoch(p.expires_at)>unixepoch())
      AND NOT EXISTS (SELECT 1 FROM partner_profiles WHERE telegram_id=g.subject_id))
  )
)
BEGIN SELECT RAISE(ABORT, 'lead history requires confirmed deletion or retention'); END;

INSERT OR IGNORE INTO re_schema_migrations(version) VALUES ('1.4.0-rebuild-effect-privacy');
