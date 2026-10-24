-- P10 additive candidate, selected after LIVE inventory on 2026-09-30.

-- Existing canonical/cabinet objects and rows remain unchanged.

-- Apply through the guarded reviewed release controller; never all historical files.

CREATE TABLE IF NOT EXISTS mini_app_init_data_receipts (
  init_data_fingerprint TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  bot_id INTEGER NOT NULL,
  telegram_id INTEGER NOT NULL,
  query_id_hash TEXT,
  auth_date INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mini_app_sessions (
  session_id TEXT PRIMARY KEY,
  session_token_hash TEXT NOT NULL UNIQUE,
  init_data_fingerprint TEXT NOT NULL UNIQUE
    REFERENCES mini_app_init_data_receipts(init_data_fingerprint),
  bot_id INTEGER NOT NULL,
  telegram_id INTEGER NOT NULL,
  token_version INTEGER NOT NULL CHECK (token_version = 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at AND expires_at <= issued_at + 300),
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS mini_app_command_receipts (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  bot_id INTEGER NOT NULL,
  actor_telegram_id INTEGER NOT NULL,
  operation TEXT NOT NULL,
  commit_status TEXT NOT NULL CHECK (commit_status IN ('committed', 'unchanged')),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  committed_at INTEGER NOT NULL,
  precondition_ok INTEGER NOT NULL CHECK (precondition_ok = 1)
);

CREATE TABLE IF NOT EXISTS mini_app_atomic_guards (
  guard_key TEXT PRIMARY KEY,
  precondition_ok INTEGER NOT NULL CHECK (precondition_ok = 1)
);

CREATE TABLE IF NOT EXISTS mini_app_effect_outbox (
  dedupe_key TEXT PRIMARY KEY,
  command_key TEXT NOT NULL REFERENCES mini_app_command_receipts(idempotency_key),
  effect_kind TEXT NOT NULL CHECK (effect_kind IN ('notification', 'analytics_adapter')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_rebuild_init_expiry ON mini_app_init_data_receipts(expires_at);

CREATE INDEX IF NOT EXISTS idx_rebuild_session_subject ON mini_app_sessions(telegram_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_rebuild_command_actor_time ON mini_app_command_receipts(actor_telegram_id, committed_at);

CREATE INDEX IF NOT EXISTS idx_rebuild_outbox_pending ON mini_app_effect_outbox(status, created_at, dedupe_key);

INSERT OR IGNORE INTO re_schema_migrations(version) VALUES ('1.4.0-rebuild-mini-app-storage');
