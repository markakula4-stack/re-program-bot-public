-- RE Program Bot v1.3.8 Part 4 — additive final provider evidence.
--
-- The immutable ai_generation_sessions.model_alias remains the session identity
-- used for replay protection. This table records the final server-selected
-- provider route after gateway validation, including DeepSeek -> Qwen fallback.
-- No prompt, provider response, secret or Telegram token is stored.

CREATE TABLE IF NOT EXISTS ai_generation_provider_evidence (
  generation_id TEXT PRIMARY KEY
    REFERENCES ai_generation_sessions(generation_id) ON DELETE CASCADE,
  owner_telegram_id INTEGER NOT NULL
    REFERENCES users(telegram_id) ON DELETE CASCADE,
  provider_request_id TEXT NOT NULL UNIQUE
    CHECK (length(provider_request_id) BETWEEN 16 AND 96),
  final_model_alias TEXT NOT NULL CHECK (final_model_alias IN (
    'qwen_safe', 'deepseek_flash_dragon'
  )),
  final_provider_code TEXT NOT NULL CHECK (final_provider_code IN (
    'cloudflare', 'deepseek'
  )),
  fallback_used INTEGER NOT NULL DEFAULT 0 CHECK (fallback_used IN (0, 1)),
  evidence_source TEXT NOT NULL CHECK (evidence_source IN (
    'gateway', 'compatibility'
  )),
  recorded_at INTEGER NOT NULL CHECK (recorded_at > 0),
  CHECK (
    (final_model_alias = 'qwen_safe'
      AND final_provider_code = 'cloudflare')
    OR
    (final_model_alias = 'deepseek_flash_dragon'
      AND final_provider_code = 'deepseek')
  ),
  CHECK (
    evidence_source = 'gateway'
    OR fallback_used = 0
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_generation_provider_evidence_owner_time
  ON ai_generation_provider_evidence(
    owner_telegram_id, recorded_at DESC, generation_id
  );

-- Existing completed sessions were created under the old invariant where the
-- session alias and persisted draft alias were necessarily identical.
INSERT OR IGNORE INTO ai_generation_provider_evidence (
  generation_id, owner_telegram_id, provider_request_id,
  final_model_alias, final_provider_code, fallback_used,
  evidence_source, recorded_at
)
SELECT
  generation_id,
  owner_telegram_id,
  'compat:' || generation_id,
  model_alias,
  CASE model_alias
    WHEN 'deepseek_flash_dragon' THEN 'deepseek'
    ELSE 'cloudflare'
  END,
  0,
  'compatibility',
  COALESCE(completed_at, updated_at, created_at)
FROM ai_generation_sessions
WHERE generation_state = 'completed';

CREATE TRIGGER IF NOT EXISTS trg_ai_generation_provider_evidence_insert_guard
BEFORE INSERT ON ai_generation_provider_evidence
WHEN NOT EXISTS (
  SELECT 1
  FROM ai_generation_sessions session
  WHERE session.generation_id = NEW.generation_id
    AND session.owner_telegram_id = NEW.owner_telegram_id
    AND (
      session.generation_state = 'finalizing'
      OR (
        session.generation_state = 'completed'
        AND NEW.evidence_source = 'compatibility'
        AND NEW.provider_request_id = 'compat:' || session.generation_id
        AND NEW.final_model_alias = session.model_alias
        AND NEW.fallback_used = 0
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'AI generation provider evidence is outside finalization scope');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_generation_provider_evidence_gateway_guard
BEFORE INSERT ON ai_generation_provider_evidence
WHEN NEW.evidence_source = 'gateway' AND NOT EXISTS (
  SELECT 1
  FROM ai_gateway_usage_metadata metadata
  JOIN ai_gateway_budget_reservations reservation
    ON reservation.request_id = metadata.request_id
  WHERE metadata.request_id = NEW.provider_request_id
    AND reservation.owner_telegram_id = NEW.owner_telegram_id
    AND metadata.final_model_alias = NEW.final_model_alias
    AND metadata.fallback_used = NEW.fallback_used
    AND metadata.final_model_alias != 'none'
)
BEGIN
  SELECT RAISE(ABORT, 'AI generation provider evidence lacks gateway metadata');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_generation_provider_evidence_append_only_update
BEFORE UPDATE ON ai_generation_provider_evidence
BEGIN
  SELECT RAISE(ABORT, 'AI generation provider evidence is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_generation_provider_evidence_append_only_delete
BEFORE DELETE ON ai_generation_provider_evidence
WHEN EXISTS (
  SELECT 1
  FROM users user
  WHERE user.telegram_id = OLD.owner_telegram_id
)
AND EXISTS (
  SELECT 1
  FROM ai_generation_sessions session
  WHERE session.generation_id = OLD.generation_id
)
BEGIN
  SELECT RAISE(ABORT, 'AI generation provider evidence is append-only');
END;

-- Provider evidence cannot be erased by deleting only its generation
-- session. A full account deletion remains allowed because the parent
-- user row is already absent while SQLite applies the owner cascade.
CREATE TRIGGER IF NOT EXISTS trg_ai_generation_sessions_provider_evidence_delete_guard
BEFORE DELETE ON ai_generation_sessions
WHEN EXISTS (
  SELECT 1
  FROM ai_generation_provider_evidence evidence
  WHERE evidence.generation_id = OLD.generation_id
)
AND EXISTS (
  SELECT 1
  FROM users user
  WHERE user.telegram_id = OLD.owner_telegram_id
)
BEGIN
  SELECT RAISE(ABORT, 'AI generation session with provider evidence is append-only');
END;

-- Replace only the completion evidence trigger. The original session identity,
-- transition, revision, retry and result-binding guards remain unchanged.
DROP TRIGGER IF EXISTS trg_ai_generation_sessions_completion_guard;

CREATE TRIGGER trg_ai_generation_sessions_completion_guard
BEFORE UPDATE ON ai_generation_sessions
WHEN NEW.generation_state = 'completed' AND NOT EXISTS (
  SELECT 1
  FROM ai_generation_provider_evidence evidence
  JOIN ai_draft_versions version
    ON version.version_id = NEW.version_id
  JOIN ai_drafts draft
    ON draft.draft_id = version.draft_id
  WHERE evidence.generation_id = NEW.generation_id
    AND evidence.owner_telegram_id = NEW.owner_telegram_id
    AND evidence.recorded_at <= NEW.completed_at
    AND version.request_id = NEW.version_request_id
    AND version.generation_state = 'complete'
    AND version.content_hash = NEW.stream_digest
    AND version.model_alias = evidence.final_model_alias
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
  SELECT RAISE(ABORT, 'AI generation completion lacks exact provider and draft evidence');
END;
