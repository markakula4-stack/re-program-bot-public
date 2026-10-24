-- Additive hardening for bounded intake, operational health and privacy requests.
-- Safe to execute more than once.

CREATE TABLE IF NOT EXISTS support_daily_rate (
  user_id INTEGER NOT NULL,
  day INTEGER NOT NULL,
  total INTEGER NOT NULL CHECK (total >= 0),
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS support_global_rate (
  minute INTEGER PRIMARY KEY,
  total INTEGER NOT NULL CHECK (total >= 0)
);

CREATE TABLE IF NOT EXISTS support_runtime_health (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_drain_ok_at INTEGER,
  last_maintenance_ok_at INTEGER,
  last_failure_at INTEGER,
  last_failure_code TEXT CHECK (last_failure_code IN ('webhook_drain', 'scheduled_drain', 'scheduled_maintenance')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS support_deletion_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  request_update_id INTEGER UNIQUE,
  confirm_update_id INTEGER UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'awaiting_admin', 'completed', 'cancelled')),
  requested_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  completed_at INTEGER,
  decided_by INTEGER,
  deleted_tickets INTEGER,
  deleted_messages INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS support_deletion_one_active
  ON support_deletion_requests(user_id)
  WHERE user_id IS NOT NULL AND status IN ('pending', 'awaiting_admin');
CREATE INDEX IF NOT EXISTS support_deletion_admin_queue
  ON support_deletion_requests(status, requested_at, id);

CREATE INDEX IF NOT EXISTS support_ticket_retention
  ON support_tickets(status, closed_at);
CREATE INDEX IF NOT EXISTS support_message_direction
  ON support_messages(ticket_id, direction, id);
CREATE INDEX IF NOT EXISTS support_outbox_ticket_delivery
  ON support_outbox(ticket_id, kind, state, reviewed_at, id);
CREATE INDEX IF NOT EXISTS support_outbox_retention
  ON support_outbox(ticket_id, created_at, state);
CREATE INDEX IF NOT EXISTS support_reply_expiry
  ON support_reply_targets(expires_at);
CREATE INDEX IF NOT EXISTS support_rate_expiry
  ON support_rate(minute);
CREATE INDEX IF NOT EXISTS support_daily_rate_expiry
  ON support_daily_rate(day);
CREATE INDEX IF NOT EXISTS support_update_expiry
  ON support_updates(created_at);
