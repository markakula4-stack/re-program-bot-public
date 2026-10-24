-- RE Program Bot v1.3.8 reacceptance Part 1.
-- Additive, dormant owner memory and confirmed-write foundations. No existing
-- runtime flag or Worker entrypoint is changed by this migration.

CREATE TABLE IF NOT EXISTS ai_partner_memory_settings (
  owner_telegram_id INTEGER PRIMARY KEY
    REFERENCES users(telegram_id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  consent_version TEXT NOT NULL CHECK (length(consent_version) BETWEEN 8 AND 80),
  revision INTEGER NOT NULL CHECK (revision > 0),
  enabled_at INTEGER,
  disabled_at INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  CHECK (
    (enabled = 1 AND enabled_at IS NOT NULL AND enabled_at > 0
      AND disabled_at IS NULL)
    OR
    (enabled = 0 AND enabled_at IS NULL
      AND disabled_at IS NOT NULL AND disabled_at > 0)
  )
);

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_memory_settings_revision
BEFORE UPDATE ON ai_partner_memory_settings
WHEN NEW.owner_telegram_id IS NOT OLD.owner_telegram_id
  OR NEW.revision != OLD.revision + 1
  OR NEW.updated_at < OLD.updated_at
  OR (NEW.enabled = OLD.enabled AND NEW.enabled != 1)
BEGIN
  SELECT RAISE(ABORT, 'AI owner memory consent revision invalid');
END;

CREATE TABLE IF NOT EXISTS ai_partner_memory_exchanges (
  exchange_id TEXT PRIMARY KEY CHECK (length(exchange_id) = 36),
  exchange_key TEXT NOT NULL UNIQUE CHECK (
    length(exchange_key) BETWEEN 16 AND 160
  ),
  owner_telegram_id INTEGER NOT NULL
    REFERENCES ai_partner_memory_settings(owner_telegram_id) ON DELETE CASCADE,
  consent_revision INTEGER NOT NULL CHECK (consent_revision > 0),
  user_summary TEXT NOT NULL CHECK (
    length(trim(user_summary)) BETWEEN 1 AND 800
  ),
  assistant_summary TEXT NOT NULL CHECK (
    length(trim(assistant_summary)) BETWEEN 1 AND 800
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  expires_at INTEGER NOT NULL CHECK (
    expires_at > created_at AND expires_at <= created_at + 2592000
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_partner_memory_owner_recent
  ON ai_partner_memory_exchanges(
    owner_telegram_id, consent_revision, created_at DESC, exchange_id DESC
  );

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_memory_exchanges_opt_in
BEFORE INSERT ON ai_partner_memory_exchanges
WHEN NOT EXISTS (
  SELECT 1 FROM ai_partner_memory_settings settings
  WHERE settings.owner_telegram_id = NEW.owner_telegram_id
    AND settings.enabled = 1
    AND settings.revision = NEW.consent_revision
    AND settings.enabled_at <= NEW.created_at
) OR (
  SELECT COUNT(*) FROM ai_partner_memory_exchanges old
  WHERE old.owner_telegram_id = NEW.owner_telegram_id
    AND old.consent_revision = NEW.consent_revision
    AND old.expires_at > NEW.created_at
) >= 5
BEGIN
  SELECT RAISE(ABORT, 'AI owner memory requires current opt-in and free capacity');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_memory_exchanges_no_update
BEFORE UPDATE ON ai_partner_memory_exchanges
BEGIN
  SELECT RAISE(ABORT, 'AI owner memory exchanges cannot be changed');
END;

CREATE TABLE IF NOT EXISTS ai_partner_memory_events (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) = 36),
  owner_telegram_id INTEGER NOT NULL
    REFERENCES users(telegram_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('grant', 'revoke', 'clear')),
  consent_revision INTEGER NOT NULL CHECK (consent_revision > 0),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  UNIQUE (owner_telegram_id, consent_revision)
);

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_memory_events_state_guard
BEFORE INSERT ON ai_partner_memory_events
WHEN NOT EXISTS (
  SELECT 1 FROM ai_partner_memory_settings settings
  WHERE settings.owner_telegram_id = NEW.owner_telegram_id
    AND settings.revision = NEW.consent_revision
    AND settings.updated_at = NEW.occurred_at
    AND (settings.enabled = 0) = (NEW.event_type = 'revoke')
)
BEGIN
  SELECT RAISE(ABORT, 'AI owner memory event does not match consent');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_memory_events_no_update
BEFORE UPDATE ON ai_partner_memory_events
BEGIN
  SELECT RAISE(ABORT, 'AI owner memory events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_memory_events_no_delete
BEFORE DELETE ON ai_partner_memory_events
WHEN EXISTS (
  SELECT 1 FROM users user WHERE user.telegram_id = OLD.owner_telegram_id
)
BEGIN
  SELECT RAISE(ABORT, 'AI owner memory events are append-only');
END;

CREATE TABLE IF NOT EXISTS ai_partner_write_intents (
  intent_id TEXT PRIMARY KEY CHECK (length(intent_id) = 36),
  owner_telegram_id INTEGER NOT NULL
    REFERENCES users(telegram_id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'save_own_draft', 'save_own_draft_version'
  )),
  target_draft_id TEXT REFERENCES ai_drafts(draft_id),
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 16 AND 160),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  confirmation_token_hash TEXT NOT NULL UNIQUE
    CHECK (length(confirmation_token_hash) = 64),
  intent_state TEXT NOT NULL DEFAULT 'pending' CHECK (intent_state IN (
    'pending', 'consumed', 'cancelled', 'expired'
  )),
  issued_at INTEGER NOT NULL CHECK (issued_at > 0),
  expires_at INTEGER NOT NULL CHECK (
    expires_at BETWEEN issued_at + 60 AND issued_at + 600
  ),
  resolved_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  UNIQUE (owner_telegram_id, action_type, request_key),
  CHECK (
    (action_type = 'save_own_draft' AND target_draft_id IS NULL)
    OR (action_type = 'save_own_draft_version' AND target_draft_id IS NOT NULL)
  ),
  CHECK (
    (intent_state = 'pending' AND resolved_at IS NULL)
    OR (intent_state != 'pending' AND resolved_at IS NOT NULL
      AND resolved_at >= issued_at)
  ),
  CHECK (intent_state != 'consumed' OR resolved_at < expires_at),
  CHECK (intent_state != 'expired' OR resolved_at >= expires_at)
);

CREATE INDEX IF NOT EXISTS idx_ai_partner_write_intents_owner_state
  ON ai_partner_write_intents(
    owner_telegram_id, intent_state, expires_at, intent_id
  );

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_write_intents_owner_guard
BEFORE INSERT ON ai_partner_write_intents
WHEN NEW.target_draft_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM ai_drafts draft
  WHERE draft.draft_id = NEW.target_draft_id
    AND draft.owner_telegram_id = NEW.owner_telegram_id
    AND draft.draft_state = 'draft'
)
BEGIN
  SELECT RAISE(ABORT, 'AI confirmed write must target an active own draft');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_write_intents_transition
BEFORE UPDATE ON ai_partner_write_intents
WHEN NEW.intent_id IS NOT OLD.intent_id
  OR NEW.owner_telegram_id IS NOT OLD.owner_telegram_id
  OR NEW.action_type IS NOT OLD.action_type
  OR NEW.target_draft_id IS NOT OLD.target_draft_id
  OR NEW.request_key IS NOT OLD.request_key
  OR NEW.payload_hash IS NOT OLD.payload_hash
  OR NEW.confirmation_token_hash IS NOT OLD.confirmation_token_hash
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR OLD.intent_state != 'pending'
  OR NEW.intent_state NOT IN ('consumed', 'cancelled', 'expired')
  OR NEW.revision != OLD.revision + 1
  OR NEW.resolved_at < OLD.issued_at
BEGIN
  SELECT RAISE(ABORT, 'AI confirmed write intent transition invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_write_intents_no_delete
BEFORE DELETE ON ai_partner_write_intents
WHEN EXISTS (
  SELECT 1 FROM users user WHERE user.telegram_id = OLD.owner_telegram_id
)
BEGIN
  SELECT RAISE(ABORT, 'AI confirmed write intents are append-only');
END;

CREATE TABLE IF NOT EXISTS ai_partner_write_events (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) = 36),
  event_key TEXT NOT NULL UNIQUE CHECK (length(event_key) BETWEEN 16 AND 160),
  intent_id TEXT NOT NULL
    REFERENCES ai_partner_write_intents(intent_id) ON DELETE CASCADE,
  owner_telegram_id INTEGER NOT NULL
    REFERENCES users(telegram_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'prepared', 'confirmed', 'cancelled', 'expired', 'rejected'
  )),
  rule_code TEXT NOT NULL DEFAULT '' CHECK (length(rule_code) <= 80),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_ai_partner_write_events_owner
  ON ai_partner_write_events(owner_telegram_id, occurred_at DESC, event_id);

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_write_events_owner_guard
BEFORE INSERT ON ai_partner_write_events
WHEN NOT EXISTS (
  SELECT 1 FROM ai_partner_write_intents intent
  WHERE intent.intent_id = NEW.intent_id
    AND intent.owner_telegram_id = NEW.owner_telegram_id
)
BEGIN
  SELECT RAISE(ABORT, 'AI confirmed write event owner mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_write_events_no_update
BEFORE UPDATE ON ai_partner_write_events
BEGIN
  SELECT RAISE(ABORT, 'AI confirmed write events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_write_events_no_delete
BEFORE DELETE ON ai_partner_write_events
WHEN EXISTS (
  SELECT 1 FROM users user WHERE user.telegram_id = OLD.owner_telegram_id
)
BEGIN
  SELECT RAISE(ABORT, 'AI confirmed write events are append-only');
END;
