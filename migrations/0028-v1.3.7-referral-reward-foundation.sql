-- RE Program Bot v1.3.7 Part 1 — referral reward foundation.
-- Additive and idempotent. This migration stores immutable eligibility
-- evidence, reward and bonus projections, plus their append-only transitions.
-- It does not connect payment handlers, start a Workflow, grant access or
-- enable the feature.

CREATE TABLE IF NOT EXISTS referral_reward_candidates (
  candidate_id TEXT PRIMARY KEY CHECK (length(candidate_id) = 36),
  candidate_key TEXT NOT NULL UNIQUE
    CHECK (length(candidate_key) BETWEEN 16 AND 160),
  program_code TEXT NOT NULL
    CHECK (program_code = 'first_paid_friend_v1'),
  buyer_telegram_id INTEGER NOT NULL CHECK (buyer_telegram_id > 0),
  inviter_telegram_id INTEGER NOT NULL CHECK (inviter_telegram_id > 0),
  source_order_id TEXT NOT NULL UNIQUE
    REFERENCES subscription_orders(order_id),
  source_payment_ledger_entry_id TEXT NOT NULL UNIQUE
    REFERENCES payment_ledger(ledger_entry_id),
  source_access_grant_id TEXT NOT NULL UNIQUE
    REFERENCES subscription_access_grants(grant_id),
  buyer_plan_code TEXT NOT NULL
    CHECK (buyer_plan_code IN ('professional', 'dragon')),
  amount_stars INTEGER NOT NULL CHECK (amount_stars BETWEEN 1 AND 10000),
  first_started_at INTEGER NOT NULL CHECK (first_started_at > 0),
  inviter_bound_at INTEGER NOT NULL CHECK (inviter_bound_at > 0),
  paid_at INTEGER NOT NULL CHECK (paid_at > 0),
  eligible_until INTEGER NOT NULL
    CHECK (eligible_until = first_started_at + 2592000),
  confirm_after INTEGER NOT NULL
    CHECK (confirm_after = paid_at + 1814400),
  selected_at INTEGER NOT NULL CHECK (selected_at >= paid_at),
  selection_reason TEXT NOT NULL DEFAULT 'first_eligible_paid_friend'
    CHECK (selection_reason = 'first_eligible_paid_friend'),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at INTEGER NOT NULL CHECK (created_at >= selected_at),
  UNIQUE (program_code, buyer_telegram_id),
  UNIQUE (program_code, inviter_telegram_id),
  CHECK (buyer_telegram_id != inviter_telegram_id),
  CHECK (inviter_bound_at <= paid_at),
  CHECK (paid_at >= first_started_at),
  CHECK (paid_at <= eligible_until)
);

CREATE INDEX IF NOT EXISTS idx_referral_candidates_hold
  ON referral_reward_candidates(confirm_after, candidate_id);

CREATE INDEX IF NOT EXISTS idx_referral_candidates_inviter
  ON referral_reward_candidates(inviter_telegram_id, selected_at, candidate_id);

CREATE TABLE IF NOT EXISTS referral_rewards (
  reward_id TEXT PRIMARY KEY CHECK (length(reward_id) = 36),
  reward_key TEXT NOT NULL UNIQUE CHECK (length(reward_key) BETWEEN 16 AND 160),
  candidate_id TEXT NOT NULL UNIQUE
    REFERENCES referral_reward_candidates(candidate_id),
  program_code TEXT NOT NULL
    CHECK (program_code = 'first_paid_friend_v1'),
  beneficiary_telegram_id INTEGER NOT NULL
    CHECK (beneficiary_telegram_id > 0),
  buyer_telegram_id INTEGER NOT NULL CHECK (buyer_telegram_id > 0),
  reward_seconds INTEGER NOT NULL CHECK (reward_seconds = 259200),
  reward_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (reward_status IN ('pending', 'confirmed', 'cancelled')),
  confirm_after INTEGER NOT NULL CHECK (confirm_after > 0),
  confirmed_at INTEGER,
  cancelled_at INTEGER,
  last_transition_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (program_code, beneficiary_telegram_id),
  UNIQUE (program_code, buyer_telegram_id),
  CHECK (beneficiary_telegram_id != buyer_telegram_id),
  CHECK (
    (reward_status = 'pending'
      AND confirmed_at IS NULL AND cancelled_at IS NULL)
    OR
    (reward_status = 'confirmed'
      AND confirmed_at IS NOT NULL AND confirmed_at >= confirm_after
      AND cancelled_at IS NULL)
    OR
    (reward_status = 'cancelled'
      AND cancelled_at IS NOT NULL
      AND cancelled_at >= created_at
      AND (confirmed_at IS NULL OR cancelled_at >= confirmed_at))
  )
);

CREATE INDEX IF NOT EXISTS idx_referral_rewards_due
  ON referral_rewards(reward_status, confirm_after, reward_id);

CREATE INDEX IF NOT EXISTS idx_referral_rewards_beneficiary
  ON referral_rewards(beneficiary_telegram_id, created_at, reward_id);

CREATE TABLE IF NOT EXISTS bonus_access_grants (
  bonus_grant_id TEXT PRIMARY KEY CHECK (length(bonus_grant_id) = 36),
  grant_key TEXT NOT NULL UNIQUE CHECK (length(grant_key) BETWEEN 16 AND 160),
  reward_id TEXT NOT NULL UNIQUE REFERENCES referral_rewards(reward_id),
  program_code TEXT NOT NULL
    CHECK (program_code = 'first_paid_friend_v1'),
  beneficiary_telegram_id INTEGER NOT NULL
    CHECK (beneficiary_telegram_id > 0),
  delivery_mode TEXT NOT NULL
    CHECK (delivery_mode IN ('manual_claim', 'extend_active_plan')),
  plan_code TEXT NOT NULL CHECK (plan_code IN ('professional', 'dragon')),
  bonus_seconds INTEGER NOT NULL CHECK (bonus_seconds = 259200),
  grant_status TEXT NOT NULL CHECK (grant_status IN (
    'pending', 'claimable', 'applied', 'expired', 'revoked', 'manual_review'
  )),
  available_at INTEGER NOT NULL CHECK (available_at > 0),
  claim_expires_at INTEGER,
  claimed_at INTEGER,
  applied_at INTEGER,
  starts_at INTEGER,
  ends_at INTEGER,
  target_subscription_id TEXT REFERENCES subscriptions(subscription_id),
  compensation_ledger_entry_id TEXT UNIQUE
    REFERENCES payment_ledger(ledger_entry_id),
  compensated_seconds INTEGER NOT NULL DEFAULT 0
    CHECK (compensated_seconds BETWEEN 0 AND 259200),
  compensated_at INTEGER,
  last_transition_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= available_at),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (delivery_mode = 'manual_claim'
      AND plan_code = 'professional'
      AND claim_expires_at IS NOT NULL
      AND claim_expires_at = available_at + 2592000
      AND target_subscription_id IS NULL
      AND grant_status IN (
        'claimable', 'applied', 'expired', 'revoked', 'manual_review'
      ))
    OR
    (delivery_mode = 'extend_active_plan'
      AND claim_expires_at IS NULL
      AND target_subscription_id IS NOT NULL
      AND grant_status IN ('pending', 'applied', 'revoked', 'manual_review'))
  ),
  CHECK (
    (grant_status IN ('pending', 'claimable', 'expired')
      AND claimed_at IS NULL AND applied_at IS NULL
      AND starts_at IS NULL AND ends_at IS NULL)
    OR
    (grant_status IN ('applied', 'manual_review')
      AND applied_at IS NOT NULL AND applied_at >= available_at
      AND starts_at IS NOT NULL AND starts_at >= available_at
      AND ends_at IS NOT NULL
      AND ends_at = starts_at + bonus_seconds
      AND (
        (delivery_mode = 'manual_claim'
          AND claimed_at IS NOT NULL
          AND claimed_at BETWEEN available_at AND claim_expires_at
          AND applied_at >= claimed_at)
        OR
        (delivery_mode = 'extend_active_plan' AND claimed_at IS NULL)
      ))
    OR
    (grant_status = 'revoked' AND (
      (claimed_at IS NULL AND applied_at IS NULL
        AND starts_at IS NULL AND ends_at IS NULL)
      OR
      (applied_at IS NOT NULL AND starts_at IS NOT NULL
        AND ends_at IS NOT NULL
        AND ends_at = starts_at + bonus_seconds)
    ))
  ),
  CHECK (
    (compensation_ledger_entry_id IS NULL
      AND compensated_seconds = 0 AND compensated_at IS NULL)
    OR
    (compensation_ledger_entry_id IS NOT NULL
      AND compensated_at IS NOT NULL AND compensated_at >= available_at)
  ),
  CHECK (grant_status != 'manual_review'
    OR compensation_ledger_entry_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_bonus_access_grants_claimable
  ON bonus_access_grants(grant_status, claim_expires_at, bonus_grant_id);

CREATE INDEX IF NOT EXISTS idx_bonus_access_grants_beneficiary
  ON bonus_access_grants(
    beneficiary_telegram_id, grant_status, created_at, bonus_grant_id
  );

CREATE TABLE IF NOT EXISTS referral_reward_transitions (
  transition_id TEXT PRIMARY KEY
    CHECK (length(transition_id) BETWEEN 16 AND 96),
  transition_key TEXT NOT NULL UNIQUE
    CHECK (length(transition_key) BETWEEN 16 AND 160),
  transition_scope TEXT NOT NULL
    CHECK (transition_scope IN ('reward', 'bonus_grant')),
  reward_id TEXT NOT NULL REFERENCES referral_rewards(reward_id),
  bonus_grant_id TEXT REFERENCES bonus_access_grants(bonus_grant_id),
  from_status TEXT NOT NULL CHECK (from_status IN (
    'none', 'pending', 'confirmed', 'claimable', 'applied'
  )),
  to_status TEXT NOT NULL CHECK (to_status IN (
    'pending', 'confirmed', 'cancelled', 'claimable', 'applied',
    'expired', 'revoked', 'manual_review'
  )),
  from_revision INTEGER NOT NULL CHECK (from_revision >= 0),
  to_revision INTEGER NOT NULL CHECK (to_revision = from_revision + 1),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 3 AND 64),
  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('workflow', 'system', 'telegram', 'admin')),
  actor_id INTEGER,
  related_payment_ledger_entry_id TEXT NOT NULL
    REFERENCES payment_ledger(ledger_entry_id),
  effect_starts_at INTEGER,
  effect_ends_at INTEGER,
  compensated_seconds INTEGER NOT NULL DEFAULT 0
    CHECK (compensated_seconds BETWEEN 0 AND 259200),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= occurred_at),
  CHECK (
    (transition_scope = 'reward' AND bonus_grant_id IS NULL AND (
      (from_status = 'none' AND to_status = 'pending')
      OR (from_status = 'pending' AND to_status IN ('confirmed', 'cancelled'))
      OR (from_status = 'confirmed' AND to_status = 'cancelled')
    ))
    OR
    (transition_scope = 'bonus_grant' AND bonus_grant_id IS NOT NULL AND (
      (from_status = 'none' AND to_status IN ('pending', 'claimable'))
      OR (from_status = 'pending' AND to_status IN ('applied', 'revoked'))
      OR (from_status = 'claimable'
        AND to_status IN ('applied', 'expired', 'revoked'))
      OR (from_status = 'applied'
        AND to_status IN ('revoked', 'manual_review'))
    ))
  ),
  CHECK (
    (from_status = 'none' AND from_revision = 0 AND to_revision = 1)
    OR (from_status != 'none' AND from_revision > 0)
  ),
  CHECK (
    (actor_type IN ('admin', 'telegram')
      AND actor_id IS NOT NULL AND actor_id > 0)
    OR (actor_type IN ('workflow', 'system') AND actor_id IS NULL)
  ),
  CHECK (
    (transition_scope = 'bonus_grant' AND to_status = 'applied'
      AND effect_starts_at IS NOT NULL
      AND effect_ends_at IS NOT NULL
      AND effect_ends_at = effect_starts_at + 259200)
    OR
    (NOT (transition_scope = 'bonus_grant' AND to_status = 'applied')
      AND effect_starts_at IS NULL AND effect_ends_at IS NULL)
  ),
  CHECK (transition_scope = 'bonus_grant' OR compensated_seconds = 0),
  CHECK (
    reason_code IN ('refund', 'chargeback') OR compensated_seconds = 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_transitions_reward_revision
  ON referral_reward_transitions(reward_id, from_revision)
  WHERE transition_scope = 'reward';

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_transitions_grant_revision
  ON referral_reward_transitions(bonus_grant_id, from_revision)
  WHERE transition_scope = 'bonus_grant';

CREATE INDEX IF NOT EXISTS idx_referral_transitions_reward_time
  ON referral_reward_transitions(reward_id, occurred_at, transition_id);

CREATE INDEX IF NOT EXISTS idx_referral_transitions_payment_time
  ON referral_reward_transitions(
    related_payment_ledger_entry_id, occurred_at, transition_id
  );

CREATE TRIGGER IF NOT EXISTS trg_referral_candidates_payment_guard
BEFORE INSERT ON referral_reward_candidates
WHEN NOT EXISTS (
  SELECT 1
  FROM subscription_orders orders
  JOIN payment_ledger payment
    ON payment.order_id = orders.order_id
  JOIN subscription_access_grants access_grant
    ON access_grant.order_id = orders.order_id
  WHERE orders.order_id = NEW.source_order_id
    AND orders.telegram_id = NEW.buyer_telegram_id
    AND orders.plan_code = NEW.buyer_plan_code
    AND orders.amount_stars = NEW.amount_stars
    AND orders.order_state = 'applied'
    AND payment.ledger_entry_id = NEW.source_payment_ledger_entry_id
    AND payment.entry_type = 'payment'
    AND payment.direction = 'credit'
    AND payment.currency = 'XTR'
    AND payment.telegram_id = NEW.buyer_telegram_id
    AND payment.amount_stars = NEW.amount_stars
    AND payment.occurred_at = NEW.paid_at
    AND access_grant.grant_id = NEW.source_access_grant_id
    AND access_grant.payment_ledger_entry_id = payment.ledger_entry_id
    AND access_grant.telegram_id = NEW.buyer_telegram_id
    AND access_grant.plan_code = NEW.buyer_plan_code
    AND access_grant.status = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM payment_ledger compensation
      WHERE compensation.related_ledger_entry_id = payment.ledger_entry_id
        AND compensation.entry_type IN ('refund', 'chargeback')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM payment_ledger earlier
      JOIN subscription_orders earlier_order
        ON earlier_order.order_id = earlier.order_id
      WHERE earlier.telegram_id = NEW.buyer_telegram_id
        AND earlier.entry_type = 'payment'
        AND earlier.direction = 'credit'
        AND earlier.currency = 'XTR'
        AND earlier_order.plan_code IN ('professional', 'dragon')
        AND (
          earlier.occurred_at < NEW.paid_at
          OR (earlier.occurred_at = NEW.paid_at
            AND earlier.ledger_entry_id < NEW.source_payment_ledger_entry_id)
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'candidate lacks first applied payment evidence');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_candidates_attribution_guard
BEFORE INSERT ON referral_reward_candidates
WHEN NOT EXISTS (
  SELECT 1
  FROM users user
  WHERE user.telegram_id = NEW.buyer_telegram_id
    AND user.inviter_id = NEW.inviter_telegram_id
    AND user.inviter_bound_at IS NOT NULL
    AND CAST(strftime('%s', user.inviter_bound_at) AS INTEGER) =
      NEW.inviter_bound_at
)
BEGIN
  SELECT RAISE(ABORT, 'candidate attribution mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_candidates_first_start_guard
BEFORE INSERT ON referral_reward_candidates
WHEN NOT EXISTS (
  SELECT 1
  FROM bot_start_events starts
  WHERE starts.telegram_id = NEW.buyer_telegram_id
    AND starts.is_new_user = 1
  GROUP BY starts.telegram_id
  HAVING CAST(strftime('%s', MIN(starts.started_at)) AS INTEGER) =
    NEW.first_started_at
)
BEGIN
  SELECT RAISE(ABORT, 'candidate first start mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_candidates_immutable_update
BEFORE UPDATE ON referral_reward_candidates
BEGIN
  SELECT RAISE(ABORT, 'referral candidates are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_candidates_immutable_delete
BEFORE DELETE ON referral_reward_candidates
BEGIN
  SELECT RAISE(ABORT, 'referral candidates are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_rewards_candidate_guard
BEFORE INSERT ON referral_rewards
WHEN NOT EXISTS (
  SELECT 1
  FROM referral_reward_candidates candidate
  WHERE candidate.candidate_id = NEW.candidate_id
    AND candidate.program_code = NEW.program_code
    AND candidate.inviter_telegram_id = NEW.beneficiary_telegram_id
    AND candidate.buyer_telegram_id = NEW.buyer_telegram_id
    AND candidate.confirm_after = NEW.confirm_after
    AND candidate.selected_at <= NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'reward does not match its candidate');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_rewards_initial_state_guard
BEFORE INSERT ON referral_rewards
WHEN NEW.reward_status != 'pending'
  OR NEW.revision != 1
  OR NEW.last_transition_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'reward must start pending at revision one');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_rewards_identity_immutable
BEFORE UPDATE ON referral_rewards
WHEN NEW.reward_id IS NOT OLD.reward_id
  OR NEW.reward_key IS NOT OLD.reward_key
  OR NEW.candidate_id IS NOT OLD.candidate_id
  OR NEW.program_code IS NOT OLD.program_code
  OR NEW.beneficiary_telegram_id IS NOT OLD.beneficiary_telegram_id
  OR NEW.buyer_telegram_id IS NOT OLD.buyer_telegram_id
  OR NEW.reward_seconds IS NOT OLD.reward_seconds
  OR NEW.confirm_after IS NOT OLD.confirm_after
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'reward identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_rewards_state_transition
BEFORE UPDATE OF reward_status ON referral_rewards
WHEN NEW.reward_status != OLD.reward_status AND (
  NEW.revision != OLD.revision + 1
  OR NEW.last_transition_id IS NULL
  OR NEW.last_transition_id IS OLD.last_transition_id
  OR NOT EXISTS (
    SELECT 1
    FROM referral_reward_transitions transition
    WHERE transition.transition_id = NEW.last_transition_id
      AND transition.transition_scope = 'reward'
      AND transition.reward_id = OLD.reward_id
      AND transition.from_status = OLD.reward_status
      AND transition.to_status = NEW.reward_status
      AND transition.from_revision = OLD.revision
      AND transition.to_revision = NEW.revision
  )
)
BEGIN
  SELECT RAISE(ABORT, 'reward update lacks its append-only transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_rewards_no_same_state_rewrite
BEFORE UPDATE ON referral_rewards
WHEN NEW.reward_status = OLD.reward_status
BEGIN
  SELECT RAISE(ABORT, 'reward updates require a state transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_rewards_no_delete
BEFORE DELETE ON referral_rewards
BEGIN
  SELECT RAISE(ABORT, 'rewards cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_grants_reward_guard
BEFORE INSERT ON bonus_access_grants
WHEN NOT EXISTS (
  SELECT 1
  FROM referral_rewards reward
  JOIN referral_reward_candidates candidate
    ON candidate.candidate_id = reward.candidate_id
  WHERE reward.reward_id = NEW.reward_id
    AND reward.program_code = NEW.program_code
    AND reward.beneficiary_telegram_id = NEW.beneficiary_telegram_id
    AND reward.reward_seconds = NEW.bonus_seconds
    AND reward.reward_status = 'confirmed'
    AND reward.confirmed_at = NEW.available_at
    AND NOT EXISTS (
      SELECT 1
      FROM payment_ledger compensation
      WHERE compensation.related_ledger_entry_id =
        candidate.source_payment_ledger_entry_id
        AND compensation.entry_type IN ('refund', 'chargeback')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'bonus grant requires a confirmed matching reward');
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_grants_subscription_guard
BEFORE INSERT ON bonus_access_grants
WHEN NEW.delivery_mode = 'extend_active_plan' AND NOT EXISTS (
  SELECT 1
  FROM subscriptions subscription
  WHERE subscription.subscription_id = NEW.target_subscription_id
    AND subscription.telegram_id = NEW.beneficiary_telegram_id
    AND subscription.plan_code = NEW.plan_code
    AND subscription.status IN ('active', 'cancel_at_period_end')
    AND subscription.current_period_end > NEW.available_at
    AND subscription.current_period_end > NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'extension lacks a matching active subscription');
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_grants_initial_state_guard
BEFORE INSERT ON bonus_access_grants
WHEN NEW.revision != 1
  OR NEW.last_transition_id IS NOT NULL
  OR NEW.compensation_ledger_entry_id IS NOT NULL
  OR NEW.compensated_seconds != 0
  OR NEW.compensated_at IS NOT NULL
  OR (NEW.delivery_mode = 'manual_claim' AND NEW.grant_status != 'claimable')
  OR (NEW.delivery_mode = 'extend_active_plan' AND NEW.grant_status != 'pending')
BEGIN
  SELECT RAISE(ABORT, 'bonus grant has an invalid initial state');
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_grants_identity_immutable
BEFORE UPDATE ON bonus_access_grants
WHEN NEW.bonus_grant_id IS NOT OLD.bonus_grant_id
  OR NEW.grant_key IS NOT OLD.grant_key
  OR NEW.reward_id IS NOT OLD.reward_id
  OR NEW.program_code IS NOT OLD.program_code
  OR NEW.beneficiary_telegram_id IS NOT OLD.beneficiary_telegram_id
  OR NEW.delivery_mode IS NOT OLD.delivery_mode
  OR NEW.plan_code IS NOT OLD.plan_code
  OR NEW.bonus_seconds IS NOT OLD.bonus_seconds
  OR NEW.available_at IS NOT OLD.available_at
  OR NEW.claim_expires_at IS NOT OLD.claim_expires_at
  OR NEW.target_subscription_id IS NOT OLD.target_subscription_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'bonus grant identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_grants_state_transition
BEFORE UPDATE OF grant_status ON bonus_access_grants
WHEN NEW.grant_status != OLD.grant_status AND (
  NEW.revision != OLD.revision + 1
  OR NEW.last_transition_id IS NULL
  OR NEW.last_transition_id IS OLD.last_transition_id
  OR NOT EXISTS (
    SELECT 1
    FROM referral_reward_transitions transition
    WHERE transition.transition_id = NEW.last_transition_id
      AND transition.transition_scope = 'bonus_grant'
      AND transition.reward_id = OLD.reward_id
      AND transition.bonus_grant_id = OLD.bonus_grant_id
      AND transition.from_status = OLD.grant_status
      AND transition.to_status = NEW.grant_status
      AND transition.from_revision = OLD.revision
      AND transition.to_revision = NEW.revision
  )
)
BEGIN
  SELECT RAISE(ABORT, 'bonus grant update lacks its append-only transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_grants_no_same_state_rewrite
BEFORE UPDATE ON bonus_access_grants
WHEN NEW.grant_status = OLD.grant_status
BEGIN
  SELECT RAISE(ABORT, 'bonus grant updates require a state transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_grants_no_delete
BEFORE DELETE ON bonus_access_grants
BEGIN
  SELECT RAISE(ABORT, 'bonus grants cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_transitions_current_guard
BEFORE INSERT ON referral_reward_transitions
WHEN NOT (
  (NEW.transition_scope = 'reward' AND (
    (NEW.from_status = 'none' AND EXISTS (
      SELECT 1 FROM referral_rewards reward
      WHERE reward.reward_id = NEW.reward_id
        AND reward.reward_status = NEW.to_status
        AND reward.revision = NEW.to_revision
        AND reward.last_transition_id IS NULL
    ))
    OR
    (NEW.from_status != 'none' AND EXISTS (
      SELECT 1 FROM referral_rewards reward
      WHERE reward.reward_id = NEW.reward_id
        AND reward.reward_status = NEW.from_status
        AND reward.revision = NEW.from_revision
    ))
  ))
  OR
  (NEW.transition_scope = 'bonus_grant' AND (
    (NEW.from_status = 'none' AND EXISTS (
      SELECT 1 FROM bonus_access_grants grant_record
      WHERE grant_record.bonus_grant_id = NEW.bonus_grant_id
        AND grant_record.reward_id = NEW.reward_id
        AND grant_record.grant_status = NEW.to_status
        AND grant_record.revision = NEW.to_revision
        AND grant_record.last_transition_id IS NULL
    ))
    OR
    (NEW.from_status != 'none' AND EXISTS (
      SELECT 1 FROM bonus_access_grants grant_record
      WHERE grant_record.bonus_grant_id = NEW.bonus_grant_id
        AND grant_record.reward_id = NEW.reward_id
        AND grant_record.grant_status = NEW.from_status
        AND grant_record.revision = NEW.from_revision
    ))
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'transition does not match current state');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_transitions_semantic_guard
BEFORE INSERT ON referral_reward_transitions
WHEN NOT (
  (NEW.transition_scope = 'reward'
    AND NEW.from_status = 'none' AND NEW.to_status = 'pending'
    AND NEW.reason_code = 'candidate_selected'
    AND NEW.actor_type = 'system')
  OR
  (NEW.transition_scope = 'reward'
    AND NEW.from_status = 'pending' AND NEW.to_status = 'confirmed'
    AND NEW.reason_code = 'hold_elapsed'
    AND NEW.actor_type = 'workflow')
  OR
  (NEW.transition_scope = 'reward'
    AND NEW.from_status IN ('pending', 'confirmed')
    AND NEW.to_status = 'cancelled'
    AND NEW.reason_code IN ('refund', 'chargeback')
    AND NEW.actor_type IN ('workflow', 'system'))
  OR
  (NEW.transition_scope = 'reward'
    AND NEW.from_status IN ('pending', 'confirmed')
    AND NEW.to_status = 'cancelled'
    AND NEW.reason_code IN ('fraud', 'policy_violation', 'admin_correction')
    AND NEW.actor_type = 'admin')
  OR
  (NEW.transition_scope = 'bonus_grant'
    AND NEW.from_status = 'none'
    AND NEW.to_status IN ('pending', 'claimable')
    AND NEW.reason_code = 'grant_created'
    AND NEW.actor_type = 'system')
  OR
  (NEW.transition_scope = 'bonus_grant'
    AND NEW.from_status = 'claimable' AND NEW.to_status = 'applied'
    AND NEW.reason_code = 'manual_claim'
    AND NEW.actor_type = 'telegram'
    AND EXISTS (
      SELECT 1 FROM bonus_access_grants grant_record
      WHERE grant_record.bonus_grant_id = NEW.bonus_grant_id
        AND grant_record.beneficiary_telegram_id = NEW.actor_id
    ))
  OR
  (NEW.transition_scope = 'bonus_grant'
    AND NEW.from_status = 'pending' AND NEW.to_status = 'applied'
    AND NEW.reason_code = 'active_plan_extension'
    AND NEW.actor_type = 'workflow')
  OR
  (NEW.transition_scope = 'bonus_grant'
    AND NEW.from_status = 'claimable' AND NEW.to_status = 'expired'
    AND NEW.reason_code = 'claim_window_expired'
    AND NEW.actor_type = 'workflow')
  OR
  (NEW.transition_scope = 'bonus_grant'
    AND NEW.from_status IN ('pending', 'claimable')
    AND NEW.to_status = 'revoked'
    AND NEW.reason_code IN ('refund', 'chargeback')
    AND NEW.actor_type IN ('workflow', 'system')
    AND NEW.compensated_seconds = 259200)
  OR
  (NEW.transition_scope = 'bonus_grant'
    AND NEW.from_status IN ('pending', 'claimable')
    AND NEW.to_status = 'revoked'
    AND NEW.reason_code IN ('fraud', 'policy_violation', 'admin_correction')
    AND NEW.actor_type = 'admin'
    AND NEW.compensated_seconds = 0)
  OR
  (NEW.transition_scope = 'bonus_grant'
    AND NEW.from_status = 'applied'
    AND NEW.to_status IN ('revoked', 'manual_review')
    AND NEW.reason_code IN ('refund', 'chargeback')
    AND NEW.actor_type IN ('workflow', 'system'))
)
BEGIN
  SELECT RAISE(ABORT, 'transition reason or actor is not allowed');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_transitions_confirmation_guard
BEFORE INSERT ON referral_reward_transitions
WHEN NEW.transition_scope = 'reward'
  AND NEW.to_status = 'confirmed'
  AND NOT EXISTS (
    SELECT 1
    FROM referral_rewards reward
    JOIN referral_reward_candidates candidate
      ON candidate.candidate_id = reward.candidate_id
    JOIN subscription_access_grants source_access
      ON source_access.grant_id = candidate.source_access_grant_id
    WHERE reward.reward_id = NEW.reward_id
      AND candidate.source_payment_ledger_entry_id =
        NEW.related_payment_ledger_entry_id
      AND source_access.payment_ledger_entry_id =
        candidate.source_payment_ledger_entry_id
      AND source_access.status = 'active'
      AND NOT EXISTS (
        SELECT 1
        FROM payment_ledger compensation
        WHERE compensation.related_ledger_entry_id =
          candidate.source_payment_ledger_entry_id
          AND compensation.entry_type IN ('refund', 'chargeback')
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'reward confirmation lacks uncompensated access');
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_transitions_reward_still_valid
BEFORE INSERT ON referral_reward_transitions
WHEN NEW.transition_scope = 'bonus_grant'
  AND NEW.to_status = 'applied'
  AND NOT EXISTS (
    SELECT 1
    FROM bonus_access_grants grant_record
    JOIN referral_rewards reward
      ON reward.reward_id = grant_record.reward_id
    JOIN referral_reward_candidates candidate
      ON candidate.candidate_id = reward.candidate_id
    JOIN subscription_access_grants source_access
      ON source_access.grant_id = candidate.source_access_grant_id
    WHERE grant_record.bonus_grant_id = NEW.bonus_grant_id
      AND grant_record.reward_id = NEW.reward_id
      AND reward.reward_status = 'confirmed'
      AND source_access.status = 'active'
      AND NOT EXISTS (
        SELECT 1
        FROM payment_ledger compensation
        WHERE compensation.related_ledger_entry_id =
          candidate.source_payment_ledger_entry_id
          AND compensation.entry_type IN ('refund', 'chargeback')
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'bonus cannot apply after reward compensation');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_transitions_time_guard
BEFORE INSERT ON referral_reward_transitions
WHEN (
  NEW.from_status != 'none'
  AND NEW.transition_scope = 'reward'
  AND NOT EXISTS (
    SELECT 1 FROM referral_rewards reward
    WHERE reward.reward_id = NEW.reward_id
      AND NEW.recorded_at >= reward.updated_at
  )
) OR (
  NEW.from_status != 'none'
  AND NEW.transition_scope = 'bonus_grant'
  AND NOT EXISTS (
    SELECT 1 FROM bonus_access_grants grant_record
    WHERE grant_record.bonus_grant_id = NEW.bonus_grant_id
      AND NEW.recorded_at >= grant_record.updated_at
  )
) OR (
  NEW.transition_scope = 'reward'
  AND NEW.to_status = 'confirmed'
  AND NOT EXISTS (
    SELECT 1 FROM referral_rewards reward
    WHERE reward.reward_id = NEW.reward_id
      AND NEW.occurred_at >= reward.confirm_after
  )
) OR (
  NEW.transition_scope = 'bonus_grant'
  AND NEW.from_status = 'claimable'
  AND NEW.to_status = 'applied'
  AND NOT EXISTS (
    SELECT 1 FROM bonus_access_grants grant_record
    WHERE grant_record.bonus_grant_id = NEW.bonus_grant_id
      AND NEW.occurred_at BETWEEN
        grant_record.available_at AND grant_record.claim_expires_at
      AND NEW.effect_starts_at = NEW.occurred_at
  )
) OR (
  NEW.transition_scope = 'bonus_grant'
  AND NEW.to_status = 'expired'
  AND NOT EXISTS (
    SELECT 1 FROM bonus_access_grants grant_record
    WHERE grant_record.bonus_grant_id = NEW.bonus_grant_id
      AND NEW.occurred_at > grant_record.claim_expires_at
  )
) OR (
  NEW.transition_scope = 'bonus_grant'
  AND NEW.from_status = 'pending'
  AND NEW.to_status = 'applied'
  AND NOT EXISTS (
    SELECT 1
    FROM bonus_access_grants grant_record
    JOIN subscriptions subscription
      ON subscription.subscription_id = grant_record.target_subscription_id
    WHERE grant_record.bonus_grant_id = NEW.bonus_grant_id
      AND subscription.telegram_id = grant_record.beneficiary_telegram_id
      AND subscription.plan_code = grant_record.plan_code
      AND subscription.status IN ('active', 'cancel_at_period_end')
      AND subscription.current_period_end > NEW.occurred_at
      AND NEW.effect_starts_at = subscription.current_period_end
      AND NEW.effect_starts_at >= NEW.occurred_at
  )
)
BEGIN
  SELECT RAISE(ABORT, 'transition occurred outside its allowed time');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_transitions_payment_guard
BEFORE INSERT ON referral_reward_transitions
WHEN (
  NEW.reason_code IN ('refund', 'chargeback') AND NOT EXISTS (
    SELECT 1
    FROM referral_rewards reward
    JOIN referral_reward_candidates candidate
      ON candidate.candidate_id = reward.candidate_id
    JOIN payment_ledger compensation
      ON compensation.ledger_entry_id = NEW.related_payment_ledger_entry_id
    WHERE reward.reward_id = NEW.reward_id
      AND compensation.related_ledger_entry_id =
        candidate.source_payment_ledger_entry_id
      AND compensation.entry_type = NEW.reason_code
      AND compensation.direction = 'debit'
      AND compensation.occurred_at = NEW.occurred_at
      AND compensation.recorded_at <= NEW.recorded_at
  )
) OR (
  NEW.reason_code NOT IN ('refund', 'chargeback') AND NOT EXISTS (
    SELECT 1
    FROM referral_rewards reward
    JOIN referral_reward_candidates candidate
      ON candidate.candidate_id = reward.candidate_id
    WHERE reward.reward_id = NEW.reward_id
      AND candidate.source_payment_ledger_entry_id =
        NEW.related_payment_ledger_entry_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'transition lacks matching payment evidence');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_transitions_late_compensation_guard
BEFORE INSERT ON referral_reward_transitions
WHEN NEW.transition_scope = 'bonus_grant'
  AND NEW.from_status = 'applied'
  AND NEW.to_status IN ('revoked', 'manual_review')
  AND (
    NEW.reason_code NOT IN ('refund', 'chargeback')
    OR NOT EXISTS (
      SELECT 1 FROM bonus_access_grants grant_record
      WHERE grant_record.bonus_grant_id = NEW.bonus_grant_id
        AND (
          (NEW.to_status = 'revoked'
            AND NEW.recorded_at <= grant_record.starts_at
            AND NEW.compensated_seconds = grant_record.bonus_seconds)
          OR
          (NEW.to_status = 'manual_review'
            AND NEW.recorded_at > grant_record.starts_at
            AND NEW.compensated_seconds = 0)
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'applied bonus requires safe late compensation');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_transitions_immutable_update
BEFORE UPDATE ON referral_reward_transitions
BEGIN
  SELECT RAISE(ABORT, 'reward transitions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_transitions_immutable_delete
BEFORE DELETE ON referral_reward_transitions
BEGIN
  SELECT RAISE(ABORT, 'reward transitions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_rewards_initial_transition
AFTER INSERT ON referral_rewards
BEGIN
  INSERT INTO referral_reward_transitions (
    transition_id, transition_key, transition_scope, reward_id,
    bonus_grant_id, from_status, to_status, from_revision, to_revision,
    reason_code, actor_type, actor_id, related_payment_ledger_entry_id,
    effect_starts_at, effect_ends_at, compensated_seconds,
    occurred_at, recorded_at
  )
  SELECT
    'initial-' || NEW.reward_id,
    'reward-initial:' || NEW.reward_id,
    'reward', NEW.reward_id, NULL, 'none', 'pending', 0, 1,
    'candidate_selected', 'system', NULL,
    candidate.source_payment_ledger_entry_id,
    NULL, NULL, 0, NEW.created_at, NEW.created_at
  FROM referral_reward_candidates candidate
  WHERE candidate.candidate_id = NEW.candidate_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_bonus_grants_initial_transition
AFTER INSERT ON bonus_access_grants
BEGIN
  INSERT INTO referral_reward_transitions (
    transition_id, transition_key, transition_scope, reward_id,
    bonus_grant_id, from_status, to_status, from_revision, to_revision,
    reason_code, actor_type, actor_id, related_payment_ledger_entry_id,
    effect_starts_at, effect_ends_at, compensated_seconds,
    occurred_at, recorded_at
  )
  SELECT
    'initial-' || NEW.bonus_grant_id,
    'bonus-initial:' || NEW.bonus_grant_id,
    'bonus_grant', NEW.reward_id, NEW.bonus_grant_id,
    'none', NEW.grant_status, 0, 1,
    'grant_created', 'system', NULL,
    candidate.source_payment_ledger_entry_id,
    NULL, NULL, 0, NEW.created_at, NEW.created_at
  FROM referral_rewards reward
  JOIN referral_reward_candidates candidate
    ON candidate.candidate_id = reward.candidate_id
  WHERE reward.reward_id = NEW.reward_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_transitions_apply_reward
AFTER INSERT ON referral_reward_transitions
WHEN NEW.transition_scope = 'reward' AND NEW.from_status != 'none'
BEGIN
  UPDATE referral_rewards
  SET reward_status = NEW.to_status,
      confirmed_at = CASE
        WHEN NEW.to_status = 'confirmed' THEN NEW.occurred_at
        ELSE confirmed_at
      END,
      cancelled_at = CASE
        WHEN NEW.to_status = 'cancelled' THEN NEW.recorded_at
        ELSE cancelled_at
      END,
      last_transition_id = NEW.transition_id,
      revision = NEW.to_revision,
      updated_at = NEW.recorded_at
  WHERE reward_id = NEW.reward_id
    AND reward_status = NEW.from_status
    AND revision = NEW.from_revision;
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_transitions_apply_bonus
AFTER INSERT ON referral_reward_transitions
WHEN NEW.transition_scope = 'bonus_grant' AND NEW.from_status != 'none'
BEGIN
  UPDATE bonus_access_grants
  SET grant_status = NEW.to_status,
      claimed_at = CASE
        WHEN NEW.from_status = 'claimable' AND NEW.to_status = 'applied'
          THEN NEW.occurred_at
        ELSE claimed_at
      END,
      applied_at = CASE
        WHEN NEW.to_status = 'applied' THEN NEW.recorded_at
        ELSE applied_at
      END,
      starts_at = CASE
        WHEN NEW.to_status = 'applied' THEN NEW.effect_starts_at
        ELSE starts_at
      END,
      ends_at = CASE
        WHEN NEW.to_status = 'applied' THEN NEW.effect_ends_at
        ELSE ends_at
      END,
      compensation_ledger_entry_id = CASE
        WHEN NEW.reason_code IN ('refund', 'chargeback')
          THEN NEW.related_payment_ledger_entry_id
        ELSE compensation_ledger_entry_id
      END,
      compensated_seconds = CASE
        WHEN NEW.reason_code IN ('refund', 'chargeback')
          THEN NEW.compensated_seconds
        ELSE compensated_seconds
      END,
      compensated_at = CASE
        WHEN NEW.reason_code IN ('refund', 'chargeback')
          THEN NEW.recorded_at
        ELSE compensated_at
      END,
      last_transition_id = NEW.transition_id,
      revision = NEW.to_revision,
      updated_at = NEW.recorded_at
  WHERE bonus_grant_id = NEW.bonus_grant_id
    AND reward_id = NEW.reward_id
    AND grant_status = NEW.from_status
    AND revision = NEW.from_revision;
END;

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.7-referral-reward-foundation');
