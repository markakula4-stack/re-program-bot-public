-- RE Program Bot v1.3.8 reacceptance Part 2. Additive and dormant.
-- Short-lived prepared draft templates only; no prompt, provider token,
-- confirmation secret, or published message is persisted.

CREATE TABLE IF NOT EXISTS ai_partner_write_payloads (
  intent_id TEXT PRIMARY KEY
    REFERENCES ai_partner_write_intents(intent_id) ON DELETE CASCADE,
  owner_telegram_id INTEGER NOT NULL
    REFERENCES users(telegram_id) ON DELETE CASCADE,
  planned_draft_id TEXT NOT NULL CHECK (length(planned_draft_id) = 36),
  expected_current_version_no INTEGER NOT NULL
    CHECK (expected_current_version_no BETWEEN 0 AND 999999),
  draft_type TEXT NOT NULL CHECK (draft_type IN (
    'telegram_post', 'private_message', 'short_card', 'promotion_idea',
    'short_video_script', 'offer_explanation'
  )),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  fact_source_ids_json TEXT NOT NULL CHECK (
    json_valid(fact_source_ids_json)
    AND json_type(fact_source_ids_json) = 'array'
    AND json_array_length(fact_source_ids_json) BETWEEN 1 AND 32
  ),
  template_json TEXT NOT NULL CHECK (
    json_valid(template_json)
    AND json_type(template_json) = 'object'
    AND length(template_json) BETWEEN 20 AND 12000
  ),
  preview_hash TEXT NOT NULL CHECK (length(preview_hash) = 64),
  prepared_at INTEGER NOT NULL CHECK (prepared_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_ai_partner_write_payloads_owner
  ON ai_partner_write_payloads(owner_telegram_id, prepared_at, intent_id);

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_write_payloads_scope
BEFORE INSERT ON ai_partner_write_payloads
WHEN NOT EXISTS (
  SELECT 1 FROM ai_partner_write_intents intent
  WHERE intent.intent_id = NEW.intent_id
    AND intent.owner_telegram_id = NEW.owner_telegram_id
    AND intent.intent_state = 'pending'
    AND intent.issued_at = NEW.prepared_at
    AND (
      (intent.action_type = 'save_own_draft'
       AND intent.target_draft_id IS NULL
       AND NEW.expected_current_version_no = 0)
      OR
      (intent.action_type = 'save_own_draft_version'
       AND intent.target_draft_id = NEW.planned_draft_id
       AND NEW.expected_current_version_no > 0)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'AI prepared write payload owner or intent mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_write_payloads_no_update
BEFORE UPDATE ON ai_partner_write_payloads
BEGIN
  SELECT RAISE(ABORT, 'AI prepared write payload is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_write_payloads_no_active_delete
BEFORE DELETE ON ai_partner_write_payloads
WHEN EXISTS (
  SELECT 1 FROM ai_partner_write_intents intent
  WHERE intent.intent_id = OLD.intent_id
    AND intent.intent_state = 'pending'
) AND EXISTS (
  SELECT 1 FROM users user WHERE user.telegram_id = OLD.owner_telegram_id
)
BEGIN
  SELECT RAISE(ABORT, 'AI pending write payload cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_write_intents_require_payload
BEFORE UPDATE OF intent_state ON ai_partner_write_intents
WHEN NEW.intent_state = 'consumed' AND NOT EXISTS (
  SELECT 1 FROM ai_partner_write_payloads payload
  WHERE payload.intent_id = NEW.intent_id
    AND payload.owner_telegram_id = NEW.owner_telegram_id
)
BEGIN
  SELECT RAISE(ABORT, 'AI confirmed write lacks prepared payload');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_write_events_terminal_guard
BEFORE INSERT ON ai_partner_write_events
WHEN NEW.event_type IN ('prepared', 'confirmed', 'cancelled', 'expired')
  AND NOT EXISTS (
  SELECT 1 FROM ai_partner_write_intents intent
  WHERE intent.intent_id = NEW.intent_id
    AND intent.owner_telegram_id = NEW.owner_telegram_id
    AND (
      (NEW.event_type = 'prepared'
       AND intent.intent_state = 'pending'
       AND intent.issued_at = NEW.occurred_at)
      OR
      (NEW.event_type = 'confirmed'
       AND intent.intent_state = 'consumed'
       AND intent.resolved_at = NEW.occurred_at)
      OR
      (NEW.event_type = 'cancelled'
       AND intent.intent_state = 'cancelled'
       AND intent.resolved_at = NEW.occurred_at)
      OR
      (NEW.event_type = 'expired'
       AND intent.intent_state = 'expired'
       AND intent.resolved_at = NEW.occurred_at)
    )
    AND (NEW.event_type NOT IN ('prepared', 'confirmed') OR EXISTS (
      SELECT 1 FROM ai_partner_write_payloads payload
      WHERE payload.intent_id = intent.intent_id
        AND payload.owner_telegram_id = intent.owner_telegram_id
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'AI write event lacks exact intent state');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_draft_versions_confirmed_guard
BEFORE INSERT ON ai_draft_versions
WHEN NEW.request_id LIKE 'a138wr:%' AND NOT EXISTS (
  SELECT 1 FROM ai_partner_write_intents intent
  JOIN ai_partner_write_payloads payload ON payload.intent_id = intent.intent_id
  JOIN ai_drafts draft ON draft.draft_id = NEW.draft_id
  WHERE NEW.request_id = 'a138wr:' || intent.intent_id
    AND intent.intent_state = 'consumed'
    AND intent.owner_telegram_id = payload.owner_telegram_id
    AND intent.owner_telegram_id = draft.owner_telegram_id
    AND draft.draft_state = 'draft'
    AND payload.planned_draft_id = NEW.draft_id
    AND payload.draft_type = draft.draft_type
    AND NEW.version_no = payload.expected_current_version_no + 1
    AND NEW.content_hash = payload.preview_hash
    AND NEW.model_alias = 'qwen_safe'
    AND EXISTS (
      SELECT 1 FROM ai_partner_write_events event
      WHERE event.intent_id = intent.intent_id
        AND event.owner_telegram_id = intent.owner_telegram_id
        AND event.event_type = 'confirmed'
        AND event.occurred_at = intent.resolved_at
    )
)
BEGIN
  SELECT RAISE(ABORT, 'AI draft write lacks exact owner confirmation');
END;
