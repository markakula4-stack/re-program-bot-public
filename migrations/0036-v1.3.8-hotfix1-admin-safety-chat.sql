-- RE Program Bot v1.3.8-hotfix.1 — persistent moderation and admin AI chat.
--
-- Additive and idempotent. The existing users.is_blocked column remains a
-- Telegram delivery-health flag. Moderation bans live in their own table and
-- therefore cannot be cleared merely because a blocked user sends an update.

CREATE TABLE IF NOT EXISTS admin_safety_runtime_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  moderation_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (moderation_enabled IN (0, 1)),
  admin_ai_chat_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (admin_ai_chat_enabled IN (0, 1)),
  deepseek_chat_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (deepseek_chat_enabled IN (0, 1)),
  updated_by INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at > 0)
);

INSERT OR IGNORE INTO admin_safety_runtime_settings (
  id, moderation_enabled, admin_ai_chat_enabled, deepseek_chat_enabled,
  updated_by, updated_at
) VALUES (1, 1, 1, 1, NULL, unixepoch());

CREATE TABLE IF NOT EXISTS user_moderation_blocks (
  target_telegram_id INTEGER PRIMARY KEY CHECK (target_telegram_id > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  blocked_by INTEGER NOT NULL CHECK (blocked_by > 0),
  blocked_at INTEGER NOT NULL CHECK (blocked_at > 0),
  unblocked_by INTEGER CHECK (unblocked_by IS NULL OR unblocked_by > 0),
  unblocked_at INTEGER CHECK (unblocked_at IS NULL OR unblocked_at > 0),
  last_notice_at INTEGER CHECK (last_notice_at IS NULL OR last_notice_at > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK (
    (status = 'active' AND unblocked_by IS NULL AND unblocked_at IS NULL)
    OR
    (status = 'revoked' AND unblocked_by IS NOT NULL
      AND unblocked_at IS NOT NULL AND unblocked_at >= blocked_at)
  )
);

CREATE INDEX IF NOT EXISTS idx_user_moderation_blocks_status_time
  ON user_moderation_blocks(status, blocked_at DESC, target_telegram_id);

CREATE TABLE IF NOT EXISTS user_moderation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE CHECK (length(event_key) BETWEEN 16 AND 120),
  target_telegram_id INTEGER NOT NULL CHECK (target_telegram_id > 0),
  actor_telegram_id INTEGER NOT NULL CHECK (actor_telegram_id > 0),
  action TEXT NOT NULL CHECK (action IN ('block', 'unblock')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  resulting_revision INTEGER NOT NULL CHECK (resulting_revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_user_moderation_events_target_time
  ON user_moderation_events(target_telegram_id, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_user_moderation_events_no_update
BEFORE UPDATE ON user_moderation_events
BEGIN
  SELECT RAISE(ABORT, 'moderation events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_user_moderation_events_no_delete
BEFORE DELETE ON user_moderation_events
BEGIN
  SELECT RAISE(ABORT, 'moderation events cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_user_moderation_blocks_identity
BEFORE UPDATE ON user_moderation_blocks
WHEN NEW.target_telegram_id IS NOT OLD.target_telegram_id
BEGIN
  SELECT RAISE(ABORT, 'moderation target is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_user_moderation_blocks_revision
BEFORE UPDATE ON user_moderation_blocks
WHEN NEW.revision != OLD.revision
  AND NEW.revision != OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'moderation revision must advance exactly once');
END;

CREATE TRIGGER IF NOT EXISTS trg_user_moderation_blocks_versioned_change
BEFORE UPDATE ON user_moderation_blocks
WHEN NEW.revision = OLD.revision AND (
  NEW.status IS NOT OLD.status
  OR NEW.reason IS NOT OLD.reason
  OR NEW.blocked_by IS NOT OLD.blocked_by
  OR NEW.blocked_at IS NOT OLD.blocked_at
  OR NEW.unblocked_by IS NOT OLD.unblocked_by
  OR NEW.unblocked_at IS NOT OLD.unblocked_at
)
BEGIN
  SELECT RAISE(ABORT, 'moderation state change requires a new revision');
END;

CREATE TABLE IF NOT EXISTS admin_moderation_sessions (
  admin_telegram_id INTEGER PRIMARY KEY CHECK (admin_telegram_id > 0),
  step TEXT NOT NULL CHECK (step IN ('target', 'reason', 'confirm')),
  target_telegram_id INTEGER CHECK (
    target_telegram_id IS NULL OR target_telegram_id > 0
  ),
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (step = 'target' AND target_telegram_id IS NULL AND reason = '')
    OR
    (step = 'reason' AND target_telegram_id IS NOT NULL AND reason = '')
    OR
    (step = 'confirm' AND target_telegram_id IS NOT NULL
      AND length(reason) BETWEEN 3 AND 300)
  )
);

CREATE TABLE IF NOT EXISTS admin_ai_chat_state (
  admin_telegram_id INTEGER PRIMARY KEY CHECK (admin_telegram_id > 0),
  active_model TEXT NOT NULL DEFAULT 'off'
    CHECK (active_model IN ('off', 'qwen', 'deepseek')),
  external_consent_version TEXT NOT NULL DEFAULT ''
    CHECK (length(external_consent_version) <= 80),
  external_consented_at INTEGER CHECK (
    external_consented_at IS NULL OR external_consented_at > 0
  ),
  external_revoked_at INTEGER CHECK (
    external_revoked_at IS NULL OR external_revoked_at > 0
  ),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  CHECK (
    (external_consent_version = '' AND external_consented_at IS NULL)
    OR
    (length(external_consent_version) BETWEEN 8 AND 80
      AND external_consented_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS admin_ai_chat_turns (
  request_id TEXT PRIMARY KEY CHECK (length(request_id) BETWEEN 16 AND 96),
  admin_telegram_id INTEGER NOT NULL CHECK (admin_telegram_id > 0),
  telegram_update_id INTEGER NOT NULL CHECK (telegram_update_id >= 0),
  requested_model TEXT NOT NULL CHECK (requested_model IN ('qwen', 'deepseek')),
  final_model_alias TEXT NOT NULL DEFAULT 'none' CHECK (
    final_model_alias IN ('none', 'qwen_safe', 'deepseek_flash_dragon')
  ),
  prompt_hash TEXT NOT NULL CHECK (length(prompt_hash) = 64),
  user_message TEXT NOT NULL DEFAULT '' CHECK (length(user_message) <= 2500),
  assistant_message TEXT NOT NULL DEFAULT ''
    CHECK (length(assistant_message) <= 3500),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed')),
  error_code TEXT NOT NULL DEFAULT '' CHECK (length(error_code) <= 80),
  billed_tokens INTEGER NOT NULL DEFAULT 0 CHECK (billed_tokens >= 0),
  cost_microusd INTEGER NOT NULL DEFAULT 0 CHECK (cost_microusd >= 0),
  latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= created_at),
  UNIQUE (admin_telegram_id, telegram_update_id),
  CHECK (
    (status = 'pending' AND final_model_alias = 'none'
      AND user_message = '' AND assistant_message = ''
      AND error_code = '' AND completed_at IS NULL)
    OR
    (status = 'completed' AND final_model_alias != 'none'
      AND length(user_message) BETWEEN 1 AND 2500
      AND length(assistant_message) BETWEEN 1 AND 3500
      AND error_code = '' AND completed_at IS NOT NULL)
    OR
    (status = 'failed' AND final_model_alias = 'none'
      AND user_message = '' AND assistant_message = ''
      AND length(error_code) BETWEEN 3 AND 80
      AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_admin_ai_chat_turns_history
  ON admin_ai_chat_turns(
    admin_telegram_id, status, completed_at DESC, telegram_update_id DESC
  );

CREATE TRIGGER IF NOT EXISTS trg_admin_ai_chat_turns_identity
BEFORE UPDATE ON admin_ai_chat_turns
WHEN NEW.request_id IS NOT OLD.request_id
  OR NEW.admin_telegram_id IS NOT OLD.admin_telegram_id
  OR NEW.telegram_update_id IS NOT OLD.telegram_update_id
  OR NEW.requested_model IS NOT OLD.requested_model
  OR NEW.prompt_hash IS NOT OLD.prompt_hash
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'admin AI chat request identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_ai_chat_turns_terminal
BEFORE UPDATE ON admin_ai_chat_turns
WHEN OLD.status IN ('completed', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'admin AI chat turn is terminal');
END;
