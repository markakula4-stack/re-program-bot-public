-- Additive upgrade for guided self-help before escalation.
-- Drafts are isolated from tickets until the user explicitly asks for a specialist.
CREATE TABLE IF NOT EXISTS support_drafts (
  user_id INTEGER PRIMARY KEY REFERENCES support_people(user_id) ON DELETE CASCADE,
  update_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  photo_id TEXT,
  intent_key TEXT CHECK (intent_key IS NULL OR intent_key IN ('start','partner','stats','privacy')),
  escalated_update_id INTEGER UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS support_draft_expiry ON support_drafts(expires_at);
