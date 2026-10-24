-- Apply only to the NEW re-program-support-db. No references to RE Program D1.
CREATE TABLE IF NOT EXISTS support_updates (
  update_id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  allowed INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS support_people (
  user_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT,
  composing INTEGER NOT NULL DEFAULT 0,
  seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS support_rate (
  user_id INTEGER NOT NULL,
  minute INTEGER NOT NULL,
  total INTEGER NOT NULL,
  PRIMARY KEY (user_id, minute)
);
CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES support_people(user_id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting','closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  last_message_id INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS support_one_active_ticket
  ON support_tickets(user_id) WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS support_ticket_queue ON support_tickets(status, updated_at, id);
CREATE INDEX IF NOT EXISTS support_ticket_owner ON support_tickets(user_id, id);
CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  update_id INTEGER NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('user','staff')),
  body TEXT NOT NULL,
  photo_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS support_message_history ON support_messages(ticket_id, id);
CREATE TABLE IF NOT EXISTS support_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  chat_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  ticket_id INTEGER REFERENCES support_tickets(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES support_messages(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','sent','failed','unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  ready_at INTEGER NOT NULL,
  claimed_at INTEGER,
  telegram_message_id INTEGER,
  error_code TEXT,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS support_delivery_queue ON support_outbox(state, ready_at, id);
CREATE INDEX IF NOT EXISTS support_delivery_chat ON support_outbox(chat_id, state, id);
CREATE TABLE IF NOT EXISTS support_reply_targets (
  chat_id INTEGER NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_update_id INTEGER,
  PRIMARY KEY (chat_id, telegram_message_id)
);
CREATE TABLE IF NOT EXISTS support_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (update_id, action)
);
