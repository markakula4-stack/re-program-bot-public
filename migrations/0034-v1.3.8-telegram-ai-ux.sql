-- RE Program Bot v1.3.8 Part 3 — dormant Telegram AI UX state.
-- Additive and idempotent. This migration stores lifecycle metadata only:
-- no raw prompt/stream content, provider secret, Telegram callback token or
-- delivery result is persisted. Production wiring and feature flags remain off.

CREATE TABLE IF NOT EXISTS ai_generation_sessions (
  generation_id TEXT PRIMARY KEY CHECK (length(generation_id) = 36),
  generation_key TEXT NOT NULL UNIQUE
    CHECK (length(generation_key) BETWEEN 16 AND 160),
  owner_telegram_id INTEGER NOT NULL
    REFERENCES users(telegram_id) ON DELETE CASCADE,
  source_draft_id TEXT REFERENCES ai_drafts(draft_id) ON DELETE CASCADE,
  draft_id TEXT REFERENCES ai_drafts(draft_id) ON DELETE CASCADE,
  draft_request_key TEXT NOT NULL
    CHECK (length(draft_request_key) BETWEEN 16 AND 160),
  version_request_id TEXT NOT NULL UNIQUE
    CHECK (length(version_request_id) BETWEEN 16 AND 96),
  draft_type TEXT NOT NULL CHECK (draft_type IN (
    'telegram_post', 'private_message', 'short_card', 'promotion_idea',
    'short_video_script', 'offer_explanation'
  )),
  draft_title TEXT NOT NULL DEFAULT '' CHECK (length(draft_title) <= 160),
  base_version_no INTEGER NOT NULL DEFAULT 0 CHECK (base_version_no >= 0),
  model_alias TEXT NOT NULL CHECK (model_alias IN (
    'qwen_safe', 'deepseek_flash_dragon'
  )),
  fact_source_ids_json TEXT NOT NULL CHECK (
    json_valid(fact_source_ids_json)
    AND json_type(fact_source_ids_json) = 'array'
    AND json_array_length(fact_source_ids_json) BETWEEN 1 AND 32
  ),
  fact_bundle_hash TEXT NOT NULL CHECK (length(fact_bundle_hash) = 64),
  prompt_hash TEXT NOT NULL CHECK (length(prompt_hash) = 64),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  generation_state TEXT NOT NULL CHECK (generation_state IN (
    'streaming', 'stopped', 'finalizing', 'completed', 'failed'
  )),
  attempt_no INTEGER NOT NULL DEFAULT 1
    CHECK (attempt_no BETWEEN 1 AND 100),
  streamed_chars INTEGER NOT NULL DEFAULT 0
    CHECK (streamed_chars BETWEEN 0 AND 12000),
  stream_digest TEXT NOT NULL DEFAULT ''
    CHECK (length(stream_digest) IN (0, 64)),
  version_id TEXT REFERENCES ai_draft_versions(version_id) ON DELETE CASCADE,
  failure_code TEXT NOT NULL DEFAULT '' CHECK (length(failure_code) <= 80),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  stopped_at INTEGER,
  completed_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (
    (generation_state = 'streaming'
      AND stopped_at IS NULL AND completed_at IS NULL
      AND version_id IS NULL AND failure_code = '')
    OR
    (generation_state = 'stopped'
      AND stopped_at IS NOT NULL AND stopped_at >= created_at
      AND completed_at IS NULL AND version_id IS NULL AND failure_code = '')
    OR
    (generation_state = 'finalizing'
      AND stopped_at IS NULL AND completed_at IS NULL
      AND version_id IS NULL AND failure_code = '')
    OR
    (generation_state = 'completed'
      AND stopped_at IS NULL
      AND completed_at IS NOT NULL AND completed_at >= created_at
      AND draft_id IS NOT NULL AND version_id IS NOT NULL
      AND length(stream_digest) = 64 AND failure_code = '')
    OR
    (generation_state = 'failed'
      AND stopped_at IS NULL AND completed_at IS NULL
      AND version_id IS NULL AND length(failure_code) BETWEEN 3 AND 80)
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_generation_sessions_owner_time
  ON ai_generation_sessions(
    owner_telegram_id, updated_at DESC, generation_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_generation_sessions_one_active_owner
  ON ai_generation_sessions(owner_telegram_id)
  WHERE generation_state IN ('streaming', 'finalizing');

CREATE TABLE IF NOT EXISTS ai_generation_actions (
  action_id TEXT PRIMARY KEY CHECK (length(action_id) = 36),
  action_key TEXT NOT NULL UNIQUE CHECK (length(action_key) BETWEEN 16 AND 160),
  generation_id TEXT NOT NULL
    REFERENCES ai_generation_sessions(generation_id) ON DELETE CASCADE,
  owner_telegram_id INTEGER NOT NULL
    REFERENCES users(telegram_id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'start', 'stop', 'retry', 'finalize', 'complete', 'fail'
  )),
  from_state TEXT NOT NULL CHECK (from_state IN (
    '', 'streaming', 'stopped', 'finalizing', 'failed'
  )),
  to_state TEXT NOT NULL CHECK (to_state IN (
    'streaming', 'stopped', 'finalizing', 'completed', 'failed'
  )),
  attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 100),
  detail_code TEXT NOT NULL DEFAULT '' CHECK (length(detail_code) <= 80),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  CHECK (
    (action_type = 'start' AND from_state = ''
      AND to_state = 'streaming' AND attempt_no = 1)
    OR (action_type = 'stop' AND from_state = 'streaming'
      AND to_state = 'stopped')
    OR (action_type = 'retry' AND from_state IN ('stopped', 'failed')
      AND to_state = 'streaming')
    OR (action_type = 'finalize' AND from_state = 'streaming'
      AND to_state = 'finalizing')
    OR (action_type = 'complete' AND from_state = 'finalizing'
      AND to_state = 'completed')
    OR (action_type = 'fail' AND from_state IN ('streaming', 'finalizing')
      AND to_state = 'failed' AND length(detail_code) BETWEEN 3 AND 80)
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_generation_actions_session
  ON ai_generation_actions(generation_id, created_at, action_id);

CREATE TABLE IF NOT EXISTS ai_share_intents (
  share_intent_id TEXT PRIMARY KEY CHECK (length(share_intent_id) = 36),
  intent_key TEXT NOT NULL UNIQUE CHECK (length(intent_key) BETWEEN 16 AND 160),
  delivery_key TEXT NOT NULL UNIQUE
    CHECK (length(delivery_key) BETWEEN 16 AND 96),
  owner_telegram_id INTEGER NOT NULL
    REFERENCES users(telegram_id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL REFERENCES ai_drafts(draft_id) ON DELETE CASCADE,
  version_id TEXT NOT NULL
    REFERENCES ai_draft_versions(version_id) ON DELETE CASCADE,
  preview_hash TEXT NOT NULL CHECK (length(preview_hash) = 64),
  confirmation_token_hash TEXT NOT NULL UNIQUE
    CHECK (length(confirmation_token_hash) = 64),
  intent_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (intent_state IN ('pending', 'consumed', 'expired', 'revoked')),
  issued_at INTEGER NOT NULL CHECK (issued_at > 0),
  expires_at INTEGER NOT NULL CHECK (
    expires_at BETWEEN issued_at + 60 AND issued_at + 600
  ),
  resolved_at INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= issued_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (
    (intent_state = 'pending' AND resolved_at IS NULL)
    OR
    (intent_state != 'pending'
      AND resolved_at IS NOT NULL AND resolved_at >= issued_at)
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_share_intents_owner_state
  ON ai_share_intents(
    owner_telegram_id, intent_state, expires_at, share_intent_id
  );

CREATE TRIGGER IF NOT EXISTS trg_ai_generation_sessions_fact_guard
BEFORE INSERT ON ai_generation_sessions
WHEN EXISTS (
  SELECT 1
  FROM json_each(NEW.fact_source_ids_json) requested
  LEFT JOIN content_fact_sources source
    ON source.fact_source_id = requested.value
  WHERE source.fact_source_id IS NULL
    OR source.source_status != 'approved'
    OR (
      source.visibility = 'private'
      AND source.owner_telegram_id != NEW.owner_telegram_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'AI generation fact source is unavailable or outside owner scope');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_generation_sessions_draft_guard_insert
BEFORE INSERT ON ai_generation_sessions
WHEN NEW.draft_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM ai_drafts draft
  WHERE draft.draft_id = NEW.draft_id
    AND draft.owner_telegram_id = NEW.owner_telegram_id
    AND draft.draft_type = NEW.draft_type
    AND draft.draft_state = 'draft'
)
BEGIN
  SELECT RAISE(ABORT, 'AI generation draft is unavailable or outside owner scope');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_generation_sessions_source_draft_guard
BEFORE INSERT ON ai_generation_sessions
WHEN NEW.source_draft_id IS NOT NEW.draft_id
BEGIN
  SELECT RAISE(ABORT, 'AI generation source draft binding mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_generation_sessions_identity_immutable
BEFORE UPDATE ON ai_generation_sessions
WHEN NEW.generation_id IS NOT OLD.generation_id
  OR NEW.generation_key IS NOT OLD.generation_key
  OR NEW.owner_telegram_id IS NOT OLD.owner_telegram_id
  OR NEW.source_draft_id IS NOT OLD.source_draft_id
  OR NEW.draft_request_key IS NOT OLD.draft_request_key
  OR NEW.version_request_id IS NOT OLD.version_request_id
  OR NEW.draft_type IS NOT OLD.draft_type
  OR NEW.draft_title IS NOT OLD.draft_title
  OR NEW.base_version_no IS NOT OLD.base_version_no
  OR NEW.model_alias IS NOT OLD.model_alias
  OR NEW.fact_source_ids_json IS NOT OLD.fact_source_ids_json
  OR NEW.fact_bundle_hash IS NOT OLD.fact_bundle_hash
  OR NEW.prompt_hash IS NOT OLD.prompt_hash
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'AI generation identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_generation_sessions_state_guard
BEFORE UPDATE OF generation_state ON ai_generation_sessions
WHEN NEW.generation_state != OLD.generation_state AND NOT (
  (OLD.generation_state = 'streaming'
    AND NEW.generation_state IN ('stopped', 'finalizing', 'failed'))
  OR (OLD.generation_state IN ('stopped', 'failed')
    AND NEW.generation_state = 'streaming')
  OR (OLD.generation_state = 'finalizing'
    AND NEW.generation_state IN ('completed', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid AI generation state transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_generation_sessions_revision_guard
BEFORE UPDATE ON ai_generation_sessions
WHEN NEW.revision != OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'AI generation revision must advance exactly once');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_generation_sessions_attempt_guard
BEFORE UPDATE ON ai_generation_sessions
WHEN (
  OLD.generation_state IN ('stopped', 'failed')
  AND NEW.generation_state = 'streaming'
  AND NEW.attempt_no != OLD.attempt_no + 1
) OR (
  NOT (
    OLD.generation_state IN ('stopped', 'failed')
    AND NEW.generation_state = 'streaming'
  )
  AND NEW.attempt_no != OLD.attempt_no
)
BEGIN
  SELECT RAISE(ABORT, 'AI generation retry attempt mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_generation_sessions_stream_guard
BEFORE UPDATE ON ai_generation_sessions
WHEN (
  OLD.generation_state = 'streaming'
  AND NEW.generation_state = 'streaming'
  AND NEW.streamed_chars < OLD.streamed_chars
) OR (
  OLD.generation_state IN ('stopped', 'failed')
  AND NEW.generation_state = 'streaming'
  AND (NEW.streamed_chars != 0 OR NEW.stream_digest != '')
)
BEGIN
  SELECT RAISE(ABORT, 'AI generation stream progress is invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_generation_sessions_binding_guard
BEFORE UPDATE ON ai_generation_sessions
WHEN (
  NEW.draft_id IS NOT OLD.draft_id
  OR NEW.version_id IS NOT OLD.version_id
) AND NOT (
  OLD.generation_state = 'finalizing'
  AND NEW.generation_state = 'completed'
  AND OLD.version_id IS NULL
  AND NEW.version_id IS NOT NULL
  AND NEW.draft_id IS NOT NULL
  AND (
    NEW.draft_id IS OLD.draft_id
    OR (OLD.draft_id IS NULL AND NEW.draft_id IS NOT NULL)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'AI generation result binding is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_generation_sessions_completion_guard
BEFORE UPDATE ON ai_generation_sessions
WHEN NEW.generation_state = 'completed' AND NOT EXISTS (
  SELECT 1
  FROM ai_draft_versions version
  JOIN ai_drafts draft ON draft.draft_id = version.draft_id
  WHERE version.version_id = NEW.version_id
    AND version.request_id = NEW.version_request_id
    AND version.generation_state = 'complete'
    AND version.content_hash = NEW.stream_digest
    AND version.model_alias = NEW.model_alias
    AND version.fact_source_ids_json = NEW.fact_source_ids_json
    AND json_extract(version.structured_payload_json, '$.factBundleHash')
      = NEW.fact_bundle_hash
    AND version.version_no = NEW.base_version_no + 1
    AND draft.draft_id = NEW.draft_id
    AND draft.owner_telegram_id = NEW.owner_telegram_id
    AND draft.draft_type = NEW.draft_type
    AND draft.current_version_no = version.version_no
)
BEGIN
  SELECT RAISE(ABORT, 'AI generation completion lacks exact draft evidence');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_generation_sessions_completed_terminal
BEFORE UPDATE ON ai_generation_sessions
WHEN OLD.generation_state = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'completed AI generation is terminal');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_generation_actions_owner_guard
BEFORE INSERT ON ai_generation_actions
WHEN NOT EXISTS (
  SELECT 1
  FROM ai_generation_sessions session
  WHERE session.generation_id = NEW.generation_id
    AND session.owner_telegram_id = NEW.owner_telegram_id
)
BEGIN
  SELECT RAISE(ABORT, 'AI generation action owner mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_generation_actions_append_only
BEFORE UPDATE ON ai_generation_actions
BEGIN
  SELECT RAISE(ABORT, 'AI generation actions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_share_intents_insert_guard
BEFORE INSERT ON ai_share_intents
WHEN NOT EXISTS (
  SELECT 1
  FROM ai_draft_versions version
  JOIN ai_drafts draft ON draft.draft_id = version.draft_id
  WHERE version.version_id = NEW.version_id
    AND version.draft_id = NEW.draft_id
    AND version.generation_state = 'complete'
    AND version.content_hash = NEW.preview_hash
    AND draft.owner_telegram_id = NEW.owner_telegram_id
    AND draft.draft_state = 'draft'
    AND draft.current_version_no = version.version_no
)
BEGIN
  SELECT RAISE(ABORT, 'AI share intent requires the current complete owner draft');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_share_intents_identity_immutable
BEFORE UPDATE ON ai_share_intents
WHEN NEW.share_intent_id IS NOT OLD.share_intent_id
  OR NEW.intent_key IS NOT OLD.intent_key
  OR NEW.delivery_key IS NOT OLD.delivery_key
  OR NEW.owner_telegram_id IS NOT OLD.owner_telegram_id
  OR NEW.draft_id IS NOT OLD.draft_id
  OR NEW.version_id IS NOT OLD.version_id
  OR NEW.preview_hash IS NOT OLD.preview_hash
  OR NEW.confirmation_token_hash IS NOT OLD.confirmation_token_hash
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'AI share intent identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_share_intents_state_guard
BEFORE UPDATE OF intent_state ON ai_share_intents
WHEN NEW.intent_state != OLD.intent_state AND NOT (
  OLD.intent_state = 'pending'
  AND NEW.intent_state IN ('consumed', 'expired', 'revoked')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid AI share intent transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_share_intents_revision_guard
BEFORE UPDATE ON ai_share_intents
WHEN NEW.revision != OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'AI share intent revision must advance exactly once');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_share_intents_consume_guard
BEFORE UPDATE OF intent_state ON ai_share_intents
WHEN NEW.intent_state = 'consumed' AND NOT EXISTS (
  SELECT 1
  FROM ai_draft_versions version
  JOIN ai_drafts draft ON draft.draft_id = version.draft_id
  WHERE version.version_id = NEW.version_id
    AND version.draft_id = NEW.draft_id
    AND version.content_hash = NEW.preview_hash
    AND version.generation_state = 'complete'
    AND draft.owner_telegram_id = NEW.owner_telegram_id
    AND draft.draft_state = 'draft'
    AND draft.current_version_no = version.version_no
)
BEGIN
  SELECT RAISE(ABORT, 'AI share confirmation no longer matches current preview');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_share_intents_terminal
BEFORE UPDATE ON ai_share_intents
WHEN OLD.intent_state != 'pending'
BEGIN
  SELECT RAISE(ABORT, 'resolved AI share intent is terminal');
END;
