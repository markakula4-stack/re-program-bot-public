-- RE Program Bot v1.3.8 Part 4 — dormant AI Gateway budget and telemetry.
--
-- This migration extends the existing ai_usage_events and
-- ai_quota_reservations ledgers instead of replacing them. It stores only
-- request/attempt metadata: never a prompt, model response, API secret,
-- Telegram callback payload or payment identifier. No runtime flag is enabled.

CREATE TABLE IF NOT EXISTS ai_gateway_budget_reservations (
  request_id TEXT PRIMARY KEY
    REFERENCES ai_quota_reservations(request_id) ON DELETE CASCADE,
  owner_telegram_id INTEGER NOT NULL
    REFERENCES users(telegram_id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL CHECK (
    length(usage_date) = 10
    AND substr(usage_date, 5, 1) = '-'
    AND substr(usage_date, 8, 1) = '-'
  ),
  user_cycle_start_at INTEGER NOT NULL CHECK (user_cycle_start_at > 0),
  user_cycle_end_at INTEGER NOT NULL CHECK (
    user_cycle_end_at = user_cycle_start_at + 2592000
  ),
  global_cycle_start_at INTEGER NOT NULL CHECK (global_cycle_start_at > 0),
  global_cycle_end_at INTEGER NOT NULL CHECK (
    global_cycle_end_at = global_cycle_start_at + 2592000
  ),
  reserved_billed_tokens INTEGER NOT NULL
    CHECK (reserved_billed_tokens BETWEEN 1 AND 100000000),
  reserved_cost_microusd INTEGER NOT NULL
    CHECK (reserved_cost_microusd BETWEEN 0 AND 2000000),
  reservation_state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (reservation_state IN ('reserved', 'consumed', 'released')),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 8 AND 80),
  pricing_version TEXT NOT NULL CHECK (length(pricing_version) BETWEEN 8 AND 80),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  completed_at INTEGER,
  CHECK (
    (reservation_state = 'reserved' AND completed_at IS NULL)
    OR
    (reservation_state IN ('consumed', 'released')
      AND completed_at IS NOT NULL AND completed_at >= created_at)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_gateway_one_active_owner
  ON ai_gateway_budget_reservations(owner_telegram_id)
  WHERE reservation_state = 'reserved';

CREATE INDEX IF NOT EXISTS idx_ai_gateway_user_cycle
  ON ai_gateway_budget_reservations(
    owner_telegram_id, user_cycle_start_at, reservation_state, created_at,
    request_id
  );

CREATE INDEX IF NOT EXISTS idx_ai_gateway_global_cycle
  ON ai_gateway_budget_reservations(
    global_cycle_start_at, reservation_state, created_at, request_id
  );

CREATE TABLE IF NOT EXISTS ai_gateway_attempts (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) = 36),
  request_id TEXT NOT NULL
    REFERENCES ai_gateway_budget_reservations(request_id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  route_step TEXT NOT NULL CHECK (
    route_step IN ('primary', 'retry', 'fallback')
  ),
  model_alias TEXT NOT NULL CHECK (
    model_alias IN ('qwen_safe', 'deepseek_flash_dragon')
  ),
  provider_code TEXT NOT NULL CHECK (
    provider_code IN ('cloudflare', 'deepseek')
  ),
  attempt_status TEXT NOT NULL CHECK (
    attempt_status IN ('success', 'failed', 'timeout')
  ),
  input_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (input_tokens BETWEEN 0 AND 10000000),
  cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (
    cached_input_tokens BETWEEN 0 AND input_tokens
  ),
  output_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (output_tokens BETWEEN 0 AND 10000000),
  cost_microusd INTEGER NOT NULL DEFAULT 0
    CHECK (cost_microusd BETWEEN 0 AND 2000000),
  latency_ms INTEGER NOT NULL CHECK (latency_ms BETWEEN 0 AND 300000),
  status_code INTEGER CHECK (
    status_code IS NULL OR status_code BETWEEN 100 AND 599
  ),
  error_code TEXT NOT NULL DEFAULT '' CHECK (length(error_code) <= 80),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  UNIQUE (request_id, attempt_no),
  UNIQUE (request_id, route_step),
  CHECK (
    (model_alias = 'deepseek_flash_dragon' AND provider_code = 'deepseek')
    OR
    (model_alias = 'qwen_safe' AND provider_code = 'cloudflare')
  ),
  CHECK (
    (route_step = 'primary' AND attempt_no = 1)
    OR
    (route_step = 'retry' AND attempt_no = 2
      AND model_alias = 'deepseek_flash_dragon')
    OR
    (route_step = 'fallback' AND attempt_no BETWEEN 2 AND 3
      AND model_alias = 'qwen_safe')
  ),
  CHECK (
    (attempt_status = 'success' AND error_code = '')
    OR
    (attempt_status != 'success' AND length(error_code) BETWEEN 3 AND 80)
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_gateway_attempts_request
  ON ai_gateway_attempts(request_id, attempt_no, attempt_id);

CREATE INDEX IF NOT EXISTS idx_ai_gateway_attempts_provider_time
  ON ai_gateway_attempts(
    provider_code, model_alias, attempt_status, created_at, attempt_id
  );

CREATE TABLE IF NOT EXISTS ai_gateway_usage_metadata (
  request_id TEXT PRIMARY KEY
    REFERENCES ai_usage_events(request_id) ON DELETE CASCADE,
  provider_user_id TEXT NOT NULL CHECK (
    length(provider_user_id) = 45
    AND substr(provider_user_id, 1, 5) = 'reai_'
  ),
  data_class TEXT NOT NULL CHECK (data_class IN ('public', 'private')),
  primary_model_alias TEXT NOT NULL CHECK (
    primary_model_alias IN ('qwen_safe', 'deepseek_flash_dragon')
  ),
  final_model_alias TEXT NOT NULL CHECK (
    final_model_alias IN ('qwen_safe', 'deepseek_flash_dragon', 'none')
  ),
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 1 AND 3),
  retry_count INTEGER NOT NULL CHECK (retry_count BETWEEN 0 AND 1),
  fallback_used INTEGER NOT NULL DEFAULT 0 CHECK (fallback_used IN (0, 1)),
  total_latency_ms INTEGER NOT NULL CHECK (
    total_latency_ms BETWEEN 0 AND 900000
  ),
  cached_input_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (cached_input_tokens BETWEEN 0 AND 30000000),
  billed_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (billed_tokens BETWEEN 0 AND 30000000),
  cost_microusd INTEGER NOT NULL DEFAULT 0
    CHECK (cost_microusd BETWEEN 0 AND 2000000),
  cache_scope TEXT NOT NULL CHECK (cache_scope IN ('none', 'public', 'private')),
  cache_key_hash TEXT CHECK (
    cache_key_hash IS NULL OR length(cache_key_hash) = 64
  ),
  pricing_version TEXT NOT NULL CHECK (length(pricing_version) BETWEEN 8 AND 80),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 8 AND 80),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  CHECK (
    (cache_scope = 'none' AND cache_key_hash IS NULL)
    OR (cache_scope != 'none' AND cache_key_hash IS NOT NULL)
  ),
  CHECK (data_class = 'public' OR cache_scope != 'public'),
  CHECK (fallback_used = 0 OR final_model_alias IN ('qwen_safe', 'none')),
  CHECK (retry_count < attempt_count)
);

CREATE INDEX IF NOT EXISTS idx_ai_gateway_usage_provider_time
  ON ai_gateway_usage_metadata(
    final_model_alias, fallback_used, created_at, request_id
  );

CREATE INDEX IF NOT EXISTS idx_ai_gateway_usage_cost_time
  ON ai_gateway_usage_metadata(cost_microusd, created_at, request_id);

CREATE TABLE IF NOT EXISTS ai_gateway_daily_aggregates (
  usage_date TEXT NOT NULL CHECK (length(usage_date) = 10),
  model_alias TEXT NOT NULL CHECK (
    model_alias IN ('qwen_safe', 'deepseek_flash_dragon')
  ),
  provider_code TEXT NOT NULL CHECK (
    provider_code IN ('cloudflare', 'deepseek')
  ),
  attempt_status TEXT NOT NULL CHECK (
    attempt_status IN ('success', 'failed', 'timeout')
  ),
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= request_count),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL CHECK (
    cached_input_tokens BETWEEN 0 AND input_tokens
  ),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cost_microusd INTEGER NOT NULL CHECK (cost_microusd >= 0),
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  aggregated_at INTEGER NOT NULL CHECK (aggregated_at > 0),
  PRIMARY KEY (usage_date, model_alias, provider_code, attempt_status)
);

CREATE TABLE IF NOT EXISTS ai_gateway_policy_daily_aggregates (
  usage_date TEXT NOT NULL CHECK (length(usage_date) = 10),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 3 AND 80),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'warn', 'block', 'fallback')),
  rule_code TEXT NOT NULL CHECK (length(rule_code) BETWEEN 3 AND 80),
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  aggregated_at INTEGER NOT NULL CHECK (aggregated_at > 0),
  PRIMARY KEY (usage_date, event_type, decision, rule_code)
);

CREATE TRIGGER IF NOT EXISTS trg_ai_gateway_budget_identity_immutable
BEFORE UPDATE ON ai_gateway_budget_reservations
WHEN NEW.request_id IS NOT OLD.request_id
  OR NEW.owner_telegram_id IS NOT OLD.owner_telegram_id
  OR NEW.usage_date IS NOT OLD.usage_date
  OR NEW.user_cycle_start_at IS NOT OLD.user_cycle_start_at
  OR NEW.user_cycle_end_at IS NOT OLD.user_cycle_end_at
  OR NEW.global_cycle_start_at IS NOT OLD.global_cycle_start_at
  OR NEW.global_cycle_end_at IS NOT OLD.global_cycle_end_at
  OR NEW.reserved_billed_tokens IS NOT OLD.reserved_billed_tokens
  OR NEW.reserved_cost_microusd IS NOT OLD.reserved_cost_microusd
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.pricing_version IS NOT OLD.pricing_version
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'AI Gateway reservation identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_gateway_budget_state_guard
BEFORE UPDATE OF reservation_state ON ai_gateway_budget_reservations
WHEN NEW.reservation_state != OLD.reservation_state AND NOT (
  OLD.reservation_state = 'reserved'
  AND NEW.reservation_state IN ('consumed', 'released')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid AI Gateway reservation transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_gateway_budget_terminal
BEFORE UPDATE ON ai_gateway_budget_reservations
WHEN OLD.reservation_state IN ('consumed', 'released')
BEGIN
  SELECT RAISE(ABORT, 'terminal AI Gateway reservation is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_gateway_attempts_append_only
BEFORE UPDATE ON ai_gateway_attempts
BEGIN
  SELECT RAISE(ABORT, 'AI Gateway attempts are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_gateway_usage_append_only
BEFORE UPDATE ON ai_gateway_usage_metadata
BEGIN
  SELECT RAISE(ABORT, 'AI Gateway usage metadata is append-only');
END;
