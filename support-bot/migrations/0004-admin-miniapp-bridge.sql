-- Owner-only Mini App commands reuse the genuine support outbox.
-- Telegram update IDs are nonnegative; a negative command reference is an
-- internal message origin and is never passed to the webhook update adapter.
CREATE TABLE IF NOT EXISTS support_admin_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  origin_token TEXT NOT NULL UNIQUE,
  actor_id INTEGER NOT NULL,
  source_sha TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('reply','close')),
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  expected_last_message_id INTEGER,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','rejected')),
  reason_code TEXT,
  message_id INTEGER REFERENCES support_messages(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS support_admin_command_ticket
  ON support_admin_commands(ticket_id,created_at,id);
