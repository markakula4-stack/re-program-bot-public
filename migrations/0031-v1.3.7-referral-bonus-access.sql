-- RE Program Bot v1.3.7 Part 4 — referral bonus access.
-- Additive and idempotent. This migration records the exact access effect,
-- expiry and safe compensation reversal for a confirmed referral reward.
-- It does not connect callbacks, change the production entrypoint, add
-- production flags or enable rollout.

CREATE TABLE IF NOT EXISTS bonus_access_effects (
  effect_id TEXT PRIMARY KEY CHECK (length(effect_id) = 36),
  effect_key TEXT NOT NULL UNIQUE CHECK (length(effect_key) BETWEEN 16 AND 160),
  bonus_grant_id TEXT NOT NULL UNIQUE
    REFERENCES bonus_access_grants(bonus_grant_id),
  reward_id TEXT NOT NULL REFERENCES referral_rewards(reward_id),
  beneficiary_telegram_id INTEGER NOT NULL
    CHECK (beneficiary_telegram_id > 0),
  effect_kind TEXT NOT NULL CHECK (effect_kind IN (
    'manual_professional_access', 'paid_plan_extension'
  )),
  plan_code TEXT NOT NULL CHECK (plan_code IN ('professional', 'dragon')),
  prior_plan_code TEXT NOT NULL
    CHECK (prior_plan_code IN ('free', 'professional', 'dragon')),
  prior_access_state TEXT NOT NULL CHECK (prior_access_state IN (
    'none', 'trial', 'active', 'cancel_at_period_end', 'expired',
    'refunded', 'suspended'
  )),
  prior_plan_revision INTEGER NOT NULL CHECK (prior_plan_revision > 0),
  result_plan_revision INTEGER NOT NULL
    CHECK (result_plan_revision = prior_plan_revision + 1),
  prior_access_revision INTEGER NOT NULL CHECK (prior_access_revision > 0),
  result_access_revision INTEGER NOT NULL
    CHECK (result_access_revision = prior_access_revision + 1),
  target_subscription_id TEXT REFERENCES subscriptions(subscription_id),
  prior_subscription_revision INTEGER,
  result_subscription_revision INTEGER,
  source_payment_ledger_entry_id TEXT NOT NULL
    REFERENCES payment_ledger(ledger_entry_id),
  applied_transition_id TEXT NOT NULL UNIQUE
    REFERENCES referral_reward_transitions(transition_id),
  effect_starts_at INTEGER NOT NULL CHECK (effect_starts_at > 0),
  effect_ends_at INTEGER NOT NULL
    CHECK (effect_ends_at = effect_starts_at + 259200),
  recorded_at INTEGER NOT NULL CHECK (recorded_at > 0),
  CHECK (
    (effect_kind = 'manual_professional_access'
      AND plan_code = 'professional'
      AND prior_plan_code = 'free'
      AND prior_access_state IN ('none', 'trial', 'expired', 'refunded')
      AND target_subscription_id IS NULL
      AND prior_subscription_revision IS NULL
      AND result_subscription_revision IS NULL
      AND recorded_at = effect_starts_at)
    OR
    (effect_kind = 'paid_plan_extension'
      AND prior_plan_code = plan_code
      AND prior_access_state IN ('active', 'cancel_at_period_end')
      AND target_subscription_id IS NOT NULL
      AND prior_subscription_revision IS NOT NULL
      AND prior_subscription_revision > 0
      AND result_subscription_revision = prior_subscription_revision + 1
      AND recorded_at <= effect_starts_at)
  )
);

CREATE INDEX IF NOT EXISTS idx_bonus_access_effects_beneficiary_time
  ON bonus_access_effects(
    beneficiary_telegram_id, effect_ends_at DESC, effect_id
  );

CREATE INDEX IF NOT EXISTS idx_bonus_access_effects_due
  ON bonus_access_effects(effect_kind, effect_ends_at, effect_id);

CREATE TABLE IF NOT EXISTS bonus_access_expiry_events (
  expiry_event_id TEXT PRIMARY KEY CHECK (length(expiry_event_id) = 36),
  event_key TEXT NOT NULL UNIQUE CHECK (length(event_key) BETWEEN 16 AND 160),
  effect_id TEXT NOT NULL UNIQUE REFERENCES bonus_access_effects(effect_id),
  bonus_grant_id TEXT NOT NULL UNIQUE
    REFERENCES bonus_access_grants(bonus_grant_id),
  beneficiary_telegram_id INTEGER NOT NULL
    CHECK (beneficiary_telegram_id > 0),
  prior_plan_revision INTEGER NOT NULL CHECK (prior_plan_revision > 0),
  result_plan_revision INTEGER NOT NULL
    CHECK (result_plan_revision = prior_plan_revision + 1),
  prior_access_revision INTEGER NOT NULL CHECK (prior_access_revision > 0),
  result_access_revision INTEGER NOT NULL
    CHECK (result_access_revision = prior_access_revision + 1),
  access_ended_at INTEGER NOT NULL CHECK (access_ended_at > 0),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= access_ended_at)
);

CREATE INDEX IF NOT EXISTS idx_bonus_access_expiry_recorded
  ON bonus_access_expiry_events(recorded_at, expiry_event_id);

CREATE TABLE IF NOT EXISTS bonus_access_reversals (
  reversal_id TEXT PRIMARY KEY CHECK (length(reversal_id) = 36),
  reversal_key TEXT NOT NULL UNIQUE
    CHECK (length(reversal_key) BETWEEN 16 AND 160),
  effect_id TEXT NOT NULL UNIQUE REFERENCES bonus_access_effects(effect_id),
  bonus_grant_id TEXT NOT NULL UNIQUE
    REFERENCES bonus_access_grants(bonus_grant_id),
  reward_id TEXT NOT NULL REFERENCES referral_rewards(reward_id),
  compensation_ledger_entry_id TEXT NOT NULL UNIQUE
    REFERENCES payment_ledger(ledger_entry_id),
  beneficiary_telegram_id INTEGER NOT NULL
    CHECK (beneficiary_telegram_id > 0),
  reversal_kind TEXT NOT NULL CHECK (reversal_kind IN (
    'manual_access_removed', 'paid_extension_removed'
  )),
  removed_seconds INTEGER NOT NULL CHECK (removed_seconds = 259200),
  prior_plan_revision INTEGER NOT NULL CHECK (prior_plan_revision > 0),
  result_plan_revision INTEGER NOT NULL
    CHECK (result_plan_revision = prior_plan_revision + 1),
  prior_access_revision INTEGER NOT NULL CHECK (prior_access_revision > 0),
  result_access_revision INTEGER NOT NULL
    CHECK (result_access_revision = prior_access_revision + 1),
  target_subscription_id TEXT REFERENCES subscriptions(subscription_id),
  prior_subscription_revision INTEGER,
  result_subscription_revision INTEGER,
  access_would_start_at INTEGER NOT NULL CHECK (access_would_start_at > 0),
  access_would_end_at INTEGER NOT NULL
    CHECK (access_would_end_at = access_would_start_at + removed_seconds),
  compensation_occurred_at INTEGER NOT NULL
    CHECK (compensation_occurred_at > 0),
  recorded_at INTEGER NOT NULL
    CHECK (recorded_at >= compensation_occurred_at),
  CHECK (recorded_at <= access_would_start_at),
  CHECK (
    (reversal_kind = 'manual_access_removed'
      AND target_subscription_id IS NULL
      AND prior_subscription_revision IS NULL
      AND result_subscription_revision IS NULL)
    OR
    (reversal_kind = 'paid_extension_removed'
      AND target_subscription_id IS NOT NULL
      AND prior_subscription_revision IS NOT NULL
      AND prior_subscription_revision > 0
      AND result_subscription_revision = prior_subscription_revision + 1)
  )
);

CREATE INDEX IF NOT EXISTS idx_bonus_access_reversals_recorded
  ON bonus_access_reversals(recorded_at, reversal_id);

-- A three-day subscription extension that keeps the same payment-ledger head
-- must already be backed by an applied referral bonus transition.
CREATE TRIGGER IF NOT EXISTS trg_subscriptions_referral_extension_guard
BEFORE UPDATE OF current_period_end ON subscriptions
WHEN NEW.current_period_end = OLD.current_period_end + 259200
  AND NEW.last_ledger_entry_id IS OLD.last_ledger_entry_id
  AND NOT EXISTS (
    SELECT 1
    FROM bonus_access_grants grant_record
    JOIN referral_rewards reward
      ON reward.reward_id = grant_record.reward_id
    WHERE grant_record.target_subscription_id = OLD.subscription_id
      AND grant_record.beneficiary_telegram_id = OLD.telegram_id
      AND grant_record.delivery_mode = 'extend_active_plan'
      AND grant_record.plan_code = OLD.plan_code
      AND grant_record.grant_status = 'applied'
      AND grant_record.starts_at = OLD.current_period_end
      AND grant_record.ends_at = NEW.current_period_end
      AND grant_record.applied_at = NEW.updated_at
      AND reward.reward_status = 'confirmed'
  )
BEGIN
  SELECT RAISE(ABORT, 'subscription extension lacks an applied referral bonus');
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_access_effects_guard
BEFORE INSERT ON bonus_access_effects
WHEN NOT EXISTS (
  SELECT 1
  FROM bonus_access_grants grant_record
  JOIN referral_rewards reward
    ON reward.reward_id = grant_record.reward_id
  JOIN referral_reward_candidates candidate
    ON candidate.candidate_id = reward.candidate_id
  JOIN referral_reward_transitions transition
    ON transition.transition_id = NEW.applied_transition_id
  JOIN user_plans plans
    ON plans.telegram_id = grant_record.beneficiary_telegram_id
  JOIN user_access_states access_state
    ON access_state.telegram_id = grant_record.beneficiary_telegram_id
  LEFT JOIN subscriptions subscription
    ON subscription.subscription_id = NEW.target_subscription_id
  WHERE grant_record.bonus_grant_id = NEW.bonus_grant_id
    AND grant_record.reward_id = NEW.reward_id
    AND grant_record.beneficiary_telegram_id = NEW.beneficiary_telegram_id
    AND grant_record.plan_code = NEW.plan_code
    AND grant_record.grant_status = 'applied'
    AND grant_record.last_transition_id = NEW.applied_transition_id
    AND grant_record.starts_at = NEW.effect_starts_at
    AND grant_record.ends_at = NEW.effect_ends_at
    AND reward.reward_status = 'confirmed'
    AND candidate.source_payment_ledger_entry_id =
      NEW.source_payment_ledger_entry_id
    AND transition.transition_scope = 'bonus_grant'
    AND transition.reward_id = NEW.reward_id
    AND transition.bonus_grant_id = NEW.bonus_grant_id
    AND transition.to_status = 'applied'
    AND transition.effect_starts_at = NEW.effect_starts_at
    AND transition.effect_ends_at = NEW.effect_ends_at
    AND plans.plan_code = NEW.plan_code
    AND plans.revision = NEW.result_plan_revision
    AND CAST(strftime('%s', plans.effective_until) AS INTEGER) =
      NEW.effect_ends_at
    AND access_state.revision = NEW.result_access_revision
    AND access_state.access_state = CASE
      WHEN NEW.effect_kind = 'manual_professional_access' THEN 'active'
      ELSE NEW.prior_access_state
    END
    AND CAST(strftime('%s', access_state.state_ends_at) AS INTEGER) =
      NEW.effect_ends_at
    AND NOT EXISTS (
      SELECT 1
      FROM payment_ledger compensation
      WHERE compensation.related_ledger_entry_id =
        candidate.source_payment_ledger_entry_id
        AND compensation.entry_type IN ('refund', 'chargeback')
    )
    AND (
      (NEW.effect_kind = 'manual_professional_access'
        AND grant_record.delivery_mode = 'manual_claim'
        AND transition.reason_code = 'manual_claim'
        AND transition.actor_type = 'telegram'
        AND NEW.target_subscription_id IS NULL
        AND plans.source_code = 'referral_bonus_manual'
        AND access_state.source_code = 'referral_bonus_manual'
        AND (
          NEW.prior_access_state != 'trial'
          OR EXISTS (
            SELECT 1
            FROM trial_grants preview
            WHERE preview.telegram_id = NEW.beneficiary_telegram_id
              AND preview.program_code = 'dragon_preview'
              AND preview.status = 'expired'
              AND preview.ended_at = NEW.effect_starts_at
          )
        ))
      OR
      (NEW.effect_kind = 'paid_plan_extension'
        AND grant_record.delivery_mode = 'extend_active_plan'
        AND transition.reason_code = 'active_plan_extension'
        AND transition.actor_type = 'workflow'
        AND subscription.subscription_id = NEW.target_subscription_id
        AND subscription.telegram_id = NEW.beneficiary_telegram_id
        AND subscription.plan_code = NEW.plan_code
        AND subscription.status IN ('active', 'cancel_at_period_end')
        AND subscription.current_period_end = NEW.effect_ends_at
        AND subscription.revision = NEW.result_subscription_revision
        AND plans.source_code = 'referral_bonus_extension'
        AND access_state.source_code = 'referral_bonus_extension')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'bonus access effect lacks matching entitlement state');
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_access_effects_immutable_update
BEFORE UPDATE ON bonus_access_effects
BEGIN
  SELECT RAISE(ABORT, 'bonus access effects are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_access_effects_immutable_delete
BEFORE DELETE ON bonus_access_effects
BEGIN
  SELECT RAISE(ABORT, 'bonus access effects are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_access_expiry_events_guard
BEFORE INSERT ON bonus_access_expiry_events
WHEN NOT EXISTS (
  SELECT 1
  FROM bonus_access_effects effect
  JOIN bonus_access_grants grant_record
    ON grant_record.bonus_grant_id = effect.bonus_grant_id
  JOIN user_plans plans
    ON plans.telegram_id = effect.beneficiary_telegram_id
  JOIN user_access_states access_state
    ON access_state.telegram_id = effect.beneficiary_telegram_id
  WHERE effect.effect_id = NEW.effect_id
    AND effect.bonus_grant_id = NEW.bonus_grant_id
    AND effect.beneficiary_telegram_id = NEW.beneficiary_telegram_id
    AND effect.effect_kind = 'manual_professional_access'
    AND grant_record.grant_status IN ('applied', 'manual_review')
    AND effect.effect_ends_at = NEW.access_ended_at
    AND plans.plan_code = 'free'
    AND plans.source_code = 'referral_bonus_expired'
    AND plans.revision = NEW.result_plan_revision
    AND access_state.access_state = 'expired'
    AND access_state.source_code = 'referral_bonus_expired'
    AND access_state.revision = NEW.result_access_revision
)
BEGIN
  SELECT RAISE(ABORT, 'bonus expiry lacks matching ended entitlement');
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_access_expiry_events_immutable_update
BEFORE UPDATE ON bonus_access_expiry_events
BEGIN
  SELECT RAISE(ABORT, 'bonus access expiry events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_access_expiry_events_immutable_delete
BEFORE DELETE ON bonus_access_expiry_events
BEGIN
  SELECT RAISE(ABORT, 'bonus access expiry events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_access_reversals_guard
BEFORE INSERT ON bonus_access_reversals
WHEN NOT EXISTS (
  SELECT 1
  FROM bonus_access_effects effect
  JOIN bonus_access_grants grant_record
    ON grant_record.bonus_grant_id = effect.bonus_grant_id
  JOIN referral_rewards reward
    ON reward.reward_id = grant_record.reward_id
  JOIN payment_ledger compensation
    ON compensation.ledger_entry_id = NEW.compensation_ledger_entry_id
  JOIN referral_reward_candidates candidate
    ON candidate.candidate_id = reward.candidate_id
  JOIN user_plans plans
    ON plans.telegram_id = effect.beneficiary_telegram_id
  JOIN user_access_states access_state
    ON access_state.telegram_id = effect.beneficiary_telegram_id
  LEFT JOIN subscriptions subscription
    ON subscription.subscription_id = NEW.target_subscription_id
  WHERE effect.effect_id = NEW.effect_id
    AND effect.bonus_grant_id = NEW.bonus_grant_id
    AND effect.reward_id = NEW.reward_id
    AND effect.beneficiary_telegram_id = NEW.beneficiary_telegram_id
    AND effect.effect_starts_at = NEW.access_would_start_at
    AND effect.effect_ends_at = NEW.access_would_end_at
    AND reward.reward_status = 'cancelled'
    AND grant_record.grant_status = 'revoked'
    AND grant_record.compensation_ledger_entry_id =
      NEW.compensation_ledger_entry_id
    AND grant_record.compensated_seconds = NEW.removed_seconds
    AND compensation.related_ledger_entry_id =
      candidate.source_payment_ledger_entry_id
    AND compensation.entry_type IN ('refund', 'chargeback')
    AND compensation.entry_type = (
      SELECT reason_code
      FROM referral_reward_transitions
      WHERE transition_id = grant_record.last_transition_id
    )
    AND compensation.occurred_at = NEW.compensation_occurred_at
    AND compensation.recorded_at <= NEW.recorded_at
    AND plans.revision = NEW.result_plan_revision
    AND access_state.revision = NEW.result_access_revision
    AND (
      (NEW.reversal_kind = 'manual_access_removed'
        AND effect.effect_kind = 'manual_professional_access'
        AND NEW.target_subscription_id IS NULL
        AND plans.plan_code = 'free'
        AND plans.source_code = 'referral_bonus_compensation'
        AND access_state.access_state = 'expired'
        AND access_state.source_code = 'referral_bonus_compensation')
      OR
      (NEW.reversal_kind = 'paid_extension_removed'
        AND effect.effect_kind = 'paid_plan_extension'
        AND subscription.subscription_id = NEW.target_subscription_id
        AND subscription.current_period_end = NEW.access_would_start_at
        AND subscription.revision = NEW.result_subscription_revision
        AND plans.plan_code = effect.plan_code
        AND plans.source_code = 'referral_bonus_compensation'
        AND access_state.access_state = effect.prior_access_state
        AND access_state.source_code = 'referral_bonus_compensation'
        AND CAST(strftime('%s', plans.effective_until) AS INTEGER) =
          NEW.access_would_start_at
        AND CAST(strftime('%s', access_state.state_ends_at) AS INTEGER) =
          NEW.access_would_start_at)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'bonus reversal lacks matching compensation state');
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_access_reversals_immutable_update
BEFORE UPDATE ON bonus_access_reversals
BEGIN
  SELECT RAISE(ABORT, 'bonus access reversals are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_access_reversals_immutable_delete
BEFORE DELETE ON bonus_access_reversals
BEGIN
  SELECT RAISE(ABORT, 'bonus access reversals are append-only');
END;

CREATE INDEX IF NOT EXISTS idx_bonus_grants_applied_end
  ON bonus_access_grants(grant_status, delivery_mode, ends_at, bonus_grant_id);

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.7-referral-bonus-access');
