-- RE Program Bot v1.3.8 Part 1 — AI Partner foundation.
-- Additive and idempotent. This migration creates versioned drafts,
-- immutable approved fact snapshots, privacy-minimal policy events and a
-- fail-closed settings row. It does not call an external model, enable Rich
-- Messages, change the production entrypoint or grant any user capability.

CREATE TABLE IF NOT EXISTS ai_partner_runtime_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rollout_mode TEXT NOT NULL DEFAULT 'off'
    CHECK (rollout_mode IN ('off', 'admin')),
  master_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (master_enabled IN (0, 1)),
  external_provider_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (external_provider_enabled IN (0, 1)),
  primary_model_alias TEXT NOT NULL DEFAULT 'qwen_safe'
    CHECK (primary_model_alias = 'qwen_safe'),
  dragon_model_alias TEXT NOT NULL DEFAULT 'deepseek_flash_dragon'
    CHECK (dragon_model_alias = 'deepseek_flash_dragon'),
  fallback_model_alias TEXT NOT NULL DEFAULT 'qwen_safe'
    CHECK (fallback_model_alias = 'qwen_safe'),
  external_model_name TEXT NOT NULL DEFAULT 'deepseek-flash'
    CHECK (external_model_name = 'deepseek-flash'),
  thinking_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (thinking_enabled = 0),
  dragon_daily_burst_limit INTEGER NOT NULL DEFAULT 100
    CHECK (dragon_daily_burst_limit BETWEEN 1 AND 100),
  dragon_cycle_success_limit INTEGER NOT NULL DEFAULT 900
    CHECK (
      dragon_cycle_success_limit BETWEEN dragon_daily_burst_limit AND 900
    ),
  quota_cycle_days INTEGER NOT NULL DEFAULT 30
    CHECK (quota_cycle_days = 30),
  quota_cycle_carryover_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (quota_cycle_carryover_enabled = 0),
  max_concurrent_per_user INTEGER NOT NULL DEFAULT 1
    CHECK (max_concurrent_per_user = 1),
  max_provider_retries INTEGER NOT NULL DEFAULT 1
    CHECK (max_provider_retries BETWEEN 0 AND 1),
  pilot_user_limit INTEGER NOT NULL DEFAULT 10
    CHECK (pilot_user_limit BETWEEN 1 AND 10),
  user_cycle_cost_ceiling_microusd INTEGER NOT NULL DEFAULT 2000000
    CHECK (user_cycle_cost_ceiling_microusd BETWEEN 1 AND 2000000),
  global_cycle_cost_ceiling_microusd INTEGER NOT NULL DEFAULT 20000000
    CHECK (
      global_cycle_cost_ceiling_microusd
        BETWEEN user_cycle_cost_ceiling_microusd AND 20000000
    ),
  memory_exchange_limit INTEGER NOT NULL DEFAULT 5
    CHECK (memory_exchange_limit BETWEEN 0 AND 5),
  confirmation_ttl_seconds INTEGER NOT NULL DEFAULT 600
    CHECK (confirmation_ttl_seconds BETWEEN 60 AND 600),
  telemetry_retention_days INTEGER NOT NULL DEFAULT 90
    CHECK (telemetry_retention_days BETWEEN 1 AND 90),
  policy_version TEXT NOT NULL DEFAULT '2026-09-12.ai-partner-v1'
    CHECK (length(policy_version) BETWEEN 8 AND 80),
  updated_by INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  CHECK (
    master_enabled = 0
    OR rollout_mode = 'admin'
  ),
  CHECK (
    external_provider_enabled = 0
    OR (master_enabled = 1 AND rollout_mode = 'admin')
  )
);

INSERT OR IGNORE INTO ai_partner_runtime_settings (
  id,
  rollout_mode,
  master_enabled,
  external_provider_enabled,
  primary_model_alias,
  dragon_model_alias,
  fallback_model_alias,
  external_model_name,
  thinking_enabled,
  dragon_daily_burst_limit,
  dragon_cycle_success_limit,
  quota_cycle_days,
  quota_cycle_carryover_enabled,
  max_concurrent_per_user,
  max_provider_retries,
  pilot_user_limit,
  user_cycle_cost_ceiling_microusd,
  global_cycle_cost_ceiling_microusd,
  memory_exchange_limit,
  confirmation_ttl_seconds,
  telemetry_retention_days,
  policy_version,
  updated_by,
  updated_at
) VALUES (
  1,
  'off',
  0,
  0,
  'qwen_safe',
  'deepseek_flash_dragon',
  'qwen_safe',
  'deepseek-flash',
  0,
  100,
  900,
  30,
  0,
  1,
  1,
  10,
  2000000,
  20000000,
  5,
  600,
  90,
  '2026-09-12.ai-partner-v1',
  NULL,
  CAST(strftime('%s', 'now') AS INTEGER)
);

CREATE TABLE IF NOT EXISTS content_fact_sources (
  fact_source_id TEXT PRIMARY KEY CHECK (length(fact_source_id) = 36),
  source_key TEXT NOT NULL UNIQUE
    CHECK (length(source_key) BETWEEN 16 AND 160),
  visibility TEXT NOT NULL
    CHECK (visibility IN ('public', 'private')),
  owner_telegram_id INTEGER REFERENCES users(telegram_id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN (
    'partner_program', 'offer', 'official_snapshot', 'partner_offer'
  )),
  subject_key TEXT NOT NULL CHECK (length(subject_key) BETWEEN 1 AND 160),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'server_record', 'official_snapshot', 'admin_verified'
  )),
  source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 80),
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
  facts_json TEXT NOT NULL
    CHECK (json_valid(facts_json) AND json_type(facts_json) = 'object'),
  source_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (source_status IN ('pending', 'approved', 'stale', 'revoked')),
  approved_by INTEGER,
  approved_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (subject_type, subject_key, source_version, visibility, owner_telegram_id),
  CHECK (
    (visibility = 'public' AND owner_telegram_id IS NULL)
    OR (visibility = 'private' AND owner_telegram_id IS NOT NULL)
  ),
  CHECK (
    (source_status = 'pending'
      AND approved_by IS NULL AND approved_at IS NULL AND revoked_at IS NULL)
    OR
    (source_status IN ('approved', 'stale')
      AND approved_by IS NOT NULL AND approved_by > 0
      AND approved_at IS NOT NULL AND approved_at >= created_at
      AND revoked_at IS NULL)
    OR
    (source_status = 'revoked'
      AND approved_by IS NOT NULL AND approved_by > 0
      AND approved_at IS NOT NULL AND approved_at >= created_at
      AND revoked_at IS NOT NULL AND revoked_at >= approved_at)
  )
);

CREATE INDEX IF NOT EXISTS idx_content_fact_sources_subject
  ON content_fact_sources(
    subject_type, subject_key, source_status, source_version, fact_source_id
  );

CREATE INDEX IF NOT EXISTS idx_content_fact_sources_owner
  ON content_fact_sources(
    owner_telegram_id, source_status, updated_at DESC, fact_source_id
  ) WHERE owner_telegram_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_drafts (
  draft_id TEXT PRIMARY KEY CHECK (length(draft_id) = 36),
  request_key TEXT NOT NULL UNIQUE
    CHECK (length(request_key) BETWEEN 16 AND 160),
  owner_telegram_id INTEGER NOT NULL
    REFERENCES users(telegram_id) ON DELETE CASCADE,
  draft_type TEXT NOT NULL CHECK (draft_type IN (
    'telegram_post', 'private_message', 'short_card', 'promotion_idea',
    'short_video_script', 'offer_explanation'
  )),
  draft_state TEXT NOT NULL DEFAULT 'draft'
    CHECK (draft_state IN ('draft', 'archived', 'deleted')),
  title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 160),
  current_version_no INTEGER NOT NULL DEFAULT 0
    CHECK (current_version_no >= 0),
  policy_version TEXT NOT NULL
    CHECK (length(policy_version) BETWEEN 8 AND 80),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  deleted_at INTEGER,
  CHECK (
    (draft_state = 'deleted'
      AND deleted_at IS NOT NULL AND deleted_at >= created_at)
    OR (draft_state != 'deleted' AND deleted_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_drafts_owner_state
  ON ai_drafts(
    owner_telegram_id, draft_state, updated_at DESC, draft_id
  );

CREATE TABLE IF NOT EXISTS ai_draft_versions (
  version_id TEXT PRIMARY KEY CHECK (length(version_id) = 36),
  version_key TEXT NOT NULL UNIQUE
    CHECK (length(version_key) BETWEEN 16 AND 160),
  request_id TEXT NOT NULL UNIQUE
    CHECK (length(request_id) BETWEEN 16 AND 96),
  draft_id TEXT NOT NULL REFERENCES ai_drafts(draft_id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  version_origin TEXT NOT NULL CHECK (version_origin IN ('ai', 'user')),
  generation_state TEXT NOT NULL
    CHECK (generation_state IN ('complete', 'stopped')),
  content TEXT NOT NULL CHECK (length(content) <= 12000),
  structured_payload_json TEXT NOT NULL CHECK (
    json_valid(structured_payload_json)
    AND json_type(structured_payload_json) = 'object'
  ),
  fact_source_ids_json TEXT NOT NULL CHECK (
    json_valid(fact_source_ids_json)
    AND json_type(fact_source_ids_json) = 'array'
    AND json_array_length(fact_source_ids_json) BETWEEN 1 AND 32
  ),
  warnings_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(warnings_json) AND json_type(warnings_json) = 'array'
  ),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  model_alias TEXT NOT NULL CHECK (model_alias IN (
    'qwen_safe', 'deepseek_flash_dragon', 'human_edit'
  )),
  prompt_version TEXT NOT NULL CHECK (length(prompt_version) BETWEEN 8 AND 80),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 8 AND 80),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  UNIQUE (draft_id, version_no),
  CHECK (
    (generation_state = 'complete' AND length(trim(content)) > 0)
    OR generation_state = 'stopped'
  ),
  CHECK (
    (version_origin = 'user' AND model_alias = 'human_edit')
    OR (version_origin = 'ai' AND model_alias != 'human_edit')
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_draft_versions_draft
  ON ai_draft_versions(draft_id, version_no DESC, version_id);

CREATE TABLE IF NOT EXISTS ai_policy_events (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) = 36),
  event_key TEXT NOT NULL UNIQUE
    CHECK (length(event_key) BETWEEN 16 AND 160),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 16 AND 96),
  actor_telegram_id INTEGER REFERENCES users(telegram_id) ON DELETE SET NULL,
  draft_id TEXT REFERENCES ai_drafts(draft_id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'consent_denied', 'owner_scope_denied', 'tool_denied',
    'prompt_injection', 'unsupported_claim', 'fact_source_denied',
    'content_redacted', 'budget_denied', 'provider_fallback',
    'generation_stopped', 'schema_rejected'
  )),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'warn', 'block', 'fallback')),
  rule_code TEXT NOT NULL CHECK (length(rule_code) BETWEEN 3 AND 80),
  detail_code TEXT NOT NULL DEFAULT '' CHECK (length(detail_code) <= 80),
  model_alias TEXT NOT NULL DEFAULT 'qwen_safe' CHECK (model_alias IN (
    'qwen_safe', 'deepseek_flash_dragon', 'none'
  )),
  provider_code TEXT NOT NULL DEFAULT 'none'
    CHECK (provider_code IN ('cloudflare', 'deepseek', 'none')),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 8 AND 80),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_ai_policy_events_actor_time
  ON ai_policy_events(actor_telegram_id, created_at DESC, event_id);

CREATE INDEX IF NOT EXISTS idx_ai_policy_events_type_time
  ON ai_policy_events(event_type, decision, created_at DESC, event_id);

CREATE TRIGGER IF NOT EXISTS trg_content_fact_sources_approved_immutable
BEFORE UPDATE ON content_fact_sources
WHEN OLD.source_status != 'pending' AND (
  NEW.fact_source_id IS NOT OLD.fact_source_id
  OR NEW.source_key IS NOT OLD.source_key
  OR NEW.visibility IS NOT OLD.visibility
  OR NEW.owner_telegram_id IS NOT OLD.owner_telegram_id
  OR NEW.subject_type IS NOT OLD.subject_type
  OR NEW.subject_key IS NOT OLD.subject_key
  OR NEW.source_kind IS NOT OLD.source_kind
  OR NEW.source_version IS NOT OLD.source_version
  OR NEW.snapshot_hash IS NOT OLD.snapshot_hash
  OR NEW.facts_json IS NOT OLD.facts_json
  OR NEW.approved_by IS NOT OLD.approved_by
  OR NEW.approved_at IS NOT OLD.approved_at
  OR NEW.created_at IS NOT OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'approved AI fact evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_content_fact_sources_state_guard
BEFORE UPDATE OF source_status ON content_fact_sources
WHEN NEW.source_status != OLD.source_status AND NOT (
  (OLD.source_status = 'pending' AND NEW.source_status IN ('approved', 'revoked'))
  OR (OLD.source_status = 'approved' AND NEW.source_status IN ('stale', 'revoked'))
  OR (OLD.source_status = 'stale' AND NEW.source_status = 'revoked')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid AI fact source transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_drafts_identity_immutable
BEFORE UPDATE ON ai_drafts
WHEN NEW.draft_id IS NOT OLD.draft_id
  OR NEW.request_key IS NOT OLD.request_key
  OR NEW.owner_telegram_id IS NOT OLD.owner_telegram_id
  OR NEW.draft_type IS NOT OLD.draft_type
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'AI draft identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_drafts_state_guard
BEFORE UPDATE OF draft_state ON ai_drafts
WHEN NEW.draft_state != OLD.draft_state AND NOT (
  (OLD.draft_state = 'draft' AND NEW.draft_state IN ('archived', 'deleted'))
  OR (OLD.draft_state = 'archived' AND NEW.draft_state IN ('draft', 'deleted'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid AI draft state transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_drafts_version_monotonic
BEFORE UPDATE OF current_version_no ON ai_drafts
WHEN NEW.current_version_no < OLD.current_version_no
  OR NEW.current_version_no > OLD.current_version_no + 1
BEGIN
  SELECT RAISE(ABORT, 'AI draft version must advance exactly once');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_drafts_deleted_terminal
BEFORE UPDATE ON ai_drafts
WHEN OLD.draft_state = 'deleted'
BEGIN
  SELECT RAISE(ABORT, 'deleted AI draft is terminal');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_draft_versions_sequence
BEFORE INSERT ON ai_draft_versions
WHEN NEW.version_no != (
  SELECT COALESCE(MAX(existing.version_no), 0) + 1
  FROM ai_draft_versions existing
  WHERE existing.draft_id = NEW.draft_id
)
BEGIN
  SELECT RAISE(ABORT, 'AI draft version sequence mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_draft_versions_owner_fact_guard
BEFORE INSERT ON ai_draft_versions
WHEN EXISTS (
  SELECT 1
  FROM json_each(NEW.fact_source_ids_json) requested
  JOIN ai_drafts draft ON draft.draft_id = NEW.draft_id
  LEFT JOIN content_fact_sources source
    ON source.fact_source_id = requested.value
  WHERE source.fact_source_id IS NULL
    OR source.source_status != 'approved'
    OR (
      source.visibility = 'private'
      AND source.owner_telegram_id != draft.owner_telegram_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'AI draft fact source is missing, stale or outside owner scope');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_draft_versions_append_only
BEFORE UPDATE ON ai_draft_versions
BEGIN
  SELECT RAISE(ABORT, 'AI draft versions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_draft_versions_advance_projection
AFTER INSERT ON ai_draft_versions
BEGIN
  UPDATE ai_drafts
  SET current_version_no = NEW.version_no,
      updated_at = CASE
        WHEN updated_at < NEW.created_at THEN NEW.created_at
        ELSE updated_at
      END
  WHERE draft_id = NEW.draft_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_policy_events_append_only
BEFORE UPDATE ON ai_policy_events
WHEN NOT (
  NEW.event_id IS OLD.event_id
  AND NEW.event_key IS OLD.event_key
  AND NEW.request_id IS OLD.request_id
  AND (NEW.actor_telegram_id IS OLD.actor_telegram_id
    OR (OLD.actor_telegram_id IS NOT NULL AND NEW.actor_telegram_id IS NULL))
  AND (NEW.draft_id IS OLD.draft_id
    OR (OLD.draft_id IS NOT NULL AND NEW.draft_id IS NULL))
  AND NEW.event_type IS OLD.event_type
  AND NEW.decision IS OLD.decision
  AND NEW.rule_code IS OLD.rule_code
  AND NEW.detail_code IS OLD.detail_code
  AND NEW.model_alias IS OLD.model_alias
  AND NEW.provider_code IS OLD.provider_code
  AND NEW.policy_version IS OLD.policy_version
  AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'AI policy events are append-only');
END;
