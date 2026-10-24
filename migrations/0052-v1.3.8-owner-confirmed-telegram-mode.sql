-- Reacceptance Part 3: additive confirmation guard for human edits.
-- The Part 2 a138wr: guard remains untouched. Human edits use a138we:.

CREATE TRIGGER IF NOT EXISTS trg_ai_partner_draft_versions_human_confirmed_guard
BEFORE INSERT ON ai_draft_versions
WHEN NEW.request_id LIKE 'a138we:%' AND NOT EXISTS (
  SELECT 1 FROM ai_partner_write_intents intent
  JOIN ai_partner_write_payloads payload ON payload.intent_id = intent.intent_id
  JOIN ai_drafts draft ON draft.draft_id = NEW.draft_id
  WHERE NEW.request_id = 'a138we:' || intent.intent_id
    AND intent.intent_state = 'consumed'
    AND intent.action_type = 'save_own_draft_version'
    AND intent.owner_telegram_id = payload.owner_telegram_id
    AND intent.owner_telegram_id = draft.owner_telegram_id
    AND draft.draft_state = 'draft'
    AND payload.planned_draft_id = NEW.draft_id
    AND payload.draft_type = draft.draft_type
    AND NEW.version_no = payload.expected_current_version_no + 1
    AND NEW.content_hash = payload.preview_hash
    AND NEW.version_origin = 'user'
    AND NEW.model_alias = 'human_edit'
    AND json_extract(payload.template_json, '$.versionOrigin') = 'user'
    AND json_extract(payload.template_json, '$.modelAlias') = 'human_edit'
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
