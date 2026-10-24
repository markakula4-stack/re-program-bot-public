-- RE Program Bot v1.3.5 final security gate.
-- Additive and idempotent: no legacy table or business row is rewritten.

CREATE TABLE IF NOT EXISTS telegram_update_receipts (
  update_id INTEGER PRIMARY KEY CHECK (update_id >= 0),
  update_type TEXT NOT NULL
    CHECK (update_type IN ('message', 'callback_query', 'unsupported')),
  actor_id INTEGER CHECK (actor_id IS NULL OR actor_id > 0),
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed', 'abandoned')),
  claim_token TEXT NOT NULL CHECK (length(claim_token) BETWEEN 16 AND 64),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  lease_expires_at INTEGER NOT NULL DEFAULT 0 CHECK (lease_expires_at >= 0),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
  last_error_code TEXT NOT NULL DEFAULT '' CHECK (length(last_error_code) <= 64)
);

CREATE INDEX IF NOT EXISTS idx_telegram_update_receipts_status_lease
  ON telegram_update_receipts(status, lease_expires_at, update_id);

CREATE INDEX IF NOT EXISTS idx_telegram_update_receipts_received
  ON telegram_update_receipts(received_at, update_id);

CREATE TABLE IF NOT EXISTS telegram_ingress_rate_limits (
  scope_key TEXT PRIMARY KEY CHECK (length(scope_key) BETWEEN 4 AND 64),
  window_started_at INTEGER NOT NULL CHECK (window_started_at >= 0),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0)
);

-- A claim is permanent after an outbound delivery starts.  If a Worker dies
-- after Telegram accepts a message, the row is marked unknown instead of
-- sending the same broadcast twice.
CREATE TABLE IF NOT EXISTS admin_broadcast_delivery_claims (
  broadcast_id INTEGER NOT NULL,
  telegram_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed', 'abandoned')),
  claim_token TEXT NOT NULL CHECK (length(claim_token) BETWEEN 16 AND 64),
  claimed_at INTEGER NOT NULL CHECK (claimed_at >= 0),
  lease_expires_at INTEGER NOT NULL CHECK (lease_expires_at >= 0),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
  error_code TEXT NOT NULL DEFAULT '' CHECK (length(error_code) <= 64),
  PRIMARY KEY (broadcast_id, telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_broadcast_claims_status_lease
  ON admin_broadcast_delivery_claims(status, lease_expires_at, broadcast_id);

-- A release latch makes the pre-deploy broadcast drain authoritative even
-- while the previous Worker generation can still receive requests.  It is
-- enabled only by the guarded release workflow and cleared only after smoke.
CREATE TABLE IF NOT EXISTS admin_broadcast_release_gate (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT 0 CHECK (updated_at >= 0)
);

INSERT OR IGNORE INTO admin_broadcast_release_gate (id, paused, updated_at)
VALUES (1, 0, 0);

CREATE TRIGGER IF NOT EXISTS trg_admin_broadcast_release_gate_insert
BEFORE INSERT ON admin_broadcasts
WHEN NEW.status = 'sending'
  AND COALESCE((SELECT paused FROM admin_broadcast_release_gate WHERE id = 1), 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'admin_broadcast_release_paused');
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_broadcast_release_gate_update
BEFORE UPDATE OF status ON admin_broadcasts
WHEN NEW.status = 'sending'
  AND OLD.status <> 'sending'
  AND COALESCE((SELECT paused FROM admin_broadcast_release_gate WHERE id = 1), 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'admin_broadcast_release_paused');
END;

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.5-final-security-and-support');
