-- Additive genuine package referral compatibility. No legacy source/grant relaxation.
-- Shared lifetime claims retain cancelled and compensated history. No paid periods are rewritten.


CREATE TABLE IF NOT EXISTS package_referral_candidates (
  candidate_id TEXT NOT NULL PRIMARY KEY CHECK (length(candidate_id) = 36),
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
  source_package_period_id TEXT NOT NULL UNIQUE
    REFERENCES subscription_package_periods(period_id),
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


CREATE TABLE IF NOT EXISTS package_referral_rewards (
  reward_id TEXT NOT NULL PRIMARY KEY CHECK (length(reward_id) = 36),
  reward_key TEXT NOT NULL UNIQUE CHECK (length(reward_key) BETWEEN 16 AND 160),
  candidate_id TEXT NOT NULL UNIQUE
    REFERENCES package_referral_candidates(candidate_id),
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


CREATE TABLE IF NOT EXISTS package_referral_transitions (
 transition_id TEXT NOT NULL PRIMARY KEY CHECK(length(transition_id) BETWEEN 16 AND 96),
 transition_key TEXT NOT NULL UNIQUE CHECK(length(transition_key) BETWEEN 16 AND 160),
 transition_scope TEXT NOT NULL CHECK(transition_scope='reward'),
 reward_id TEXT NOT NULL REFERENCES package_referral_rewards(reward_id),
 bonus_grant_id TEXT CHECK(bonus_grant_id IS NULL),
 from_status TEXT NOT NULL CHECK(from_status IN ('none','pending','confirmed')),
 to_status TEXT NOT NULL CHECK(to_status IN ('pending','confirmed','cancelled')),
 from_revision INTEGER NOT NULL CHECK(from_revision>=0),
 to_revision INTEGER NOT NULL CHECK(to_revision=from_revision+1),
 reason_code TEXT NOT NULL CHECK(reason_code IN ('candidate_selected','hold_elapsed','refund','chargeback','fraud','policy_violation','admin_correction')),
 actor_type TEXT NOT NULL CHECK(actor_type IN ('workflow','system','admin')),
 actor_id INTEGER,
 related_payment_ledger_entry_id TEXT NOT NULL REFERENCES payment_ledger(ledger_entry_id),
 effect_starts_at INTEGER CHECK(effect_starts_at IS NULL),effect_ends_at INTEGER CHECK(effect_ends_at IS NULL),
 compensated_seconds INTEGER NOT NULL DEFAULT 0 CHECK(compensated_seconds=0),
 occurred_at INTEGER NOT NULL CHECK(occurred_at>0),recorded_at INTEGER NOT NULL CHECK(recorded_at>=occurred_at),
 UNIQUE(reward_id,from_revision),
 CHECK((from_status='none' AND to_status='pending' AND from_revision=0) OR (from_status='pending' AND to_status IN ('confirmed','cancelled') AND from_revision>0) OR (from_status='confirmed' AND to_status='cancelled' AND from_revision>0)),
 CHECK((actor_type='admin' AND actor_id IS NOT NULL AND actor_id>0) OR (actor_type IN ('system','workflow') AND actor_id IS NULL))
);

CREATE TABLE IF NOT EXISTS package_referral_protection_jobs (
  protection_job_id TEXT NOT NULL PRIMARY KEY CHECK (length(protection_job_id) = 36),
  job_key TEXT NOT NULL UNIQUE CHECK (length(job_key) BETWEEN 16 AND 160),
  reward_id TEXT NOT NULL UNIQUE REFERENCES package_referral_rewards(reward_id),
  candidate_id TEXT NOT NULL UNIQUE
    REFERENCES package_referral_candidates(candidate_id),
  workflow_instance_id TEXT NOT NULL UNIQUE
    CHECK (length(workflow_instance_id) BETWEEN 20 AND 96),
  workflow_state TEXT NOT NULL DEFAULT 'pending' CHECK (workflow_state IN (
    'pending', 'started', 'start_failed', 'completed', 'manual_review'
  )),
  scheduled_for INTEGER NOT NULL CHECK (scheduled_for > 0),
  start_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (start_attempt_count BETWEEN 0 AND 20),
  last_attempt_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  settlement_outcome TEXT NOT NULL DEFAULT ''
    CHECK (settlement_outcome IN ('', 'confirmed', 'cancelled')),
  settled_transition_id TEXT UNIQUE
    REFERENCES package_referral_transitions(transition_id),
  last_reconciliation_run_id TEXT
    REFERENCES payment_reconciliation_runs(run_id),
  last_error_code TEXT NOT NULL DEFAULT '' CHECK (length(last_error_code) <= 64),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (workflow_state = 'pending'
      AND start_attempt_count = 0
      AND last_attempt_at IS NULL
      AND started_at IS NULL
      AND completed_at IS NULL
      AND settlement_outcome = ''
      AND settled_transition_id IS NULL
      AND last_error_code = '')
    OR
    (workflow_state = 'started'
      AND start_attempt_count > 0
      AND last_attempt_at IS NOT NULL
      AND started_at IS NOT NULL
      AND completed_at IS NULL
      AND settlement_outcome = ''
      AND settled_transition_id IS NULL
      AND last_error_code = '')
    OR
    (workflow_state = 'start_failed'
      AND start_attempt_count > 0
      AND last_attempt_at IS NOT NULL
      AND completed_at IS NULL
      AND settlement_outcome = ''
      AND settled_transition_id IS NULL
      AND last_error_code != '')
    OR
    (workflow_state = 'manual_review'
      AND start_attempt_count > 0
      AND last_attempt_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND settlement_outcome = ''
      AND settled_transition_id IS NULL
      AND last_error_code != '')
    OR
    (workflow_state = 'completed'
      AND start_attempt_count > 0
      AND last_attempt_at IS NOT NULL
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND completed_at >= started_at
      AND settlement_outcome IN ('confirmed', 'cancelled')
      AND settled_transition_id IS NOT NULL
      AND last_error_code = '')
  )
);


CREATE TABLE IF NOT EXISTS package_referral_protection_checks (
  protection_check_id TEXT NOT NULL PRIMARY KEY
    CHECK (length(protection_check_id) = 36),
  check_key TEXT NOT NULL UNIQUE CHECK (length(check_key) BETWEEN 16 AND 160),
  reward_id TEXT NOT NULL REFERENCES package_referral_rewards(reward_id),
  candidate_id TEXT NOT NULL REFERENCES package_referral_candidates(candidate_id),
  reward_revision INTEGER NOT NULL CHECK (reward_revision > 0),
  decision TEXT NOT NULL CHECK (decision IN ('confirm', 'cancel')),
  reason_code TEXT NOT NULL
    CHECK (reason_code IN ('hold_elapsed', 'refund', 'chargeback')),
  source_payment_ledger_entry_id TEXT NOT NULL
    REFERENCES payment_ledger(ledger_entry_id),
  source_package_period_id TEXT NOT NULL
    REFERENCES subscription_package_periods(period_id),
  reconciliation_run_id TEXT REFERENCES payment_reconciliation_runs(run_id),
  reconciliation_item_id TEXT REFERENCES payment_reconciliation_items(item_id),
  compensation_ledger_entry_id TEXT REFERENCES payment_ledger(ledger_entry_id),
  transition_id TEXT NOT NULL UNIQUE
    CHECK (length(transition_id) BETWEEN 16 AND 96),
  checked_at INTEGER NOT NULL CHECK (checked_at > 0),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= checked_at),
  UNIQUE (reward_id, reward_revision),
  CHECK (
    (reconciliation_run_id IS NULL AND reconciliation_item_id IS NULL)
    OR
    (reconciliation_run_id IS NOT NULL AND reconciliation_item_id IS NOT NULL)
  ),
  CHECK (
    (decision = 'confirm'
      AND reason_code = 'hold_elapsed'
      AND reconciliation_run_id IS NOT NULL
      AND reconciliation_item_id IS NOT NULL
      AND compensation_ledger_entry_id IS NULL)
    OR
    (decision = 'cancel'
      AND reason_code IN ('refund', 'chargeback')
      AND compensation_ledger_entry_id IS NOT NULL)
  )
);


CREATE TRIGGER IF NOT EXISTS v144_package_referral_candidates_payment_guard
BEFORE INSERT ON package_referral_candidates
WHEN NOT EXISTS (
  SELECT 1
  FROM subscription_orders orders
  JOIN payment_ledger payment
    ON payment.order_id = orders.order_id
  JOIN subscription_package_periods access_grant
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
    AND access_grant.period_id = NEW.source_package_period_id
    AND access_grant.payment_ledger_entry_id = payment.ledger_entry_id
    AND orders.billing_mode='prepaid'
    AND payment.related_ledger_entry_id IS NULL
    AND payment.telegram_payment_charge_id IS NOT NULL
    AND payment.recorded_at<=NEW.selected_at
    AND access_grant.telegram_id = NEW.buyer_telegram_id
    AND access_grant.plan_code = NEW.buyer_plan_code
    AND access_grant.recorded_at <= NEW.selected_at
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

CREATE TRIGGER IF NOT EXISTS v144_package_referral_candidates_attribution_guard
BEFORE INSERT ON package_referral_candidates
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

CREATE TRIGGER IF NOT EXISTS v144_package_referral_candidates_first_start_guard
BEFORE INSERT ON package_referral_candidates
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

CREATE TRIGGER IF NOT EXISTS v144_package_referral_candidates_immutable_update
BEFORE UPDATE ON package_referral_candidates
BEGIN
  SELECT RAISE(ABORT, 'referral candidates are immutable');
END;

CREATE TRIGGER IF NOT EXISTS v144_package_referral_candidates_immutable_delete
BEFORE DELETE ON package_referral_candidates
BEGIN
  SELECT RAISE(ABORT, 'referral candidates are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_package_referral_rewards_candidate_guard
BEFORE INSERT ON package_referral_rewards
WHEN NOT EXISTS (
  SELECT 1
  FROM package_referral_candidates candidate
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

CREATE TRIGGER IF NOT EXISTS trg_package_referral_rewards_initial_state_guard
BEFORE INSERT ON package_referral_rewards
WHEN NEW.reward_status != 'pending'
  OR NEW.revision != 1
  OR NEW.last_transition_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'reward must start pending at revision one');
END;

CREATE TRIGGER IF NOT EXISTS trg_package_referral_rewards_identity_immutable
BEFORE UPDATE ON package_referral_rewards
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

CREATE TRIGGER IF NOT EXISTS trg_package_referral_rewards_state_transition
BEFORE UPDATE OF reward_status ON package_referral_rewards
WHEN NEW.reward_status != OLD.reward_status AND (
  NEW.revision != OLD.revision + 1
  OR NEW.last_transition_id IS NULL
  OR NEW.last_transition_id IS OLD.last_transition_id
  OR NOT EXISTS (
    SELECT 1
    FROM package_referral_transitions transition
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

CREATE TRIGGER IF NOT EXISTS trg_package_referral_rewards_no_same_state_rewrite
BEFORE UPDATE ON package_referral_rewards
WHEN NEW.reward_status = OLD.reward_status
BEGIN
  SELECT RAISE(ABORT, 'reward updates require a state transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_package_referral_rewards_no_delete
BEFORE DELETE ON package_referral_rewards
BEGIN
  SELECT RAISE(ABORT, 'rewards cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_package_referral_rewards_initial_transition
AFTER INSERT ON package_referral_rewards
BEGIN
  INSERT INTO package_referral_transitions (
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
  FROM package_referral_candidates candidate
  WHERE candidate.candidate_id = NEW.candidate_id;
END;

CREATE TRIGGER IF NOT EXISTS v144_package_referral_transitions_apply_reward
AFTER INSERT ON package_referral_transitions
WHEN NEW.transition_scope = 'reward' AND NEW.from_status != 'none'
BEGIN
  UPDATE package_referral_rewards
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

CREATE TRIGGER IF NOT EXISTS v144_package_referral_transitions_immutable_update
BEFORE UPDATE ON package_referral_transitions
BEGIN
  SELECT RAISE(ABORT, 'reward transitions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS v144_package_referral_transitions_immutable_delete
BEFORE DELETE ON package_referral_transitions
BEGIN
  SELECT RAISE(ABORT, 'reward transitions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS v144_package_referral_candidates_cycle_guard
BEFORE INSERT ON package_referral_candidates
WHEN EXISTS (
  WITH RECURSIVE inviter_chain(telegram_id) AS (
    SELECT NEW.inviter_telegram_id
    UNION
    SELECT ancestor.inviter_id
    FROM users ancestor
    JOIN inviter_chain chain
      ON ancestor.telegram_id = chain.telegram_id
    WHERE ancestor.inviter_id IS NOT NULL
  )
  SELECT 1
  FROM inviter_chain
  WHERE telegram_id = NEW.buyer_telegram_id
)
BEGIN
  SELECT RAISE(ABORT, 'candidate invitation cycle detected');
END;

CREATE TRIGGER IF NOT EXISTS v144_package_referral_protection_jobs_insert_guard
BEFORE INSERT ON package_referral_protection_jobs
WHEN NOT EXISTS (
  SELECT 1
  FROM package_referral_rewards reward
  JOIN package_referral_candidates candidate
    ON candidate.candidate_id = reward.candidate_id
  WHERE reward.reward_id = NEW.reward_id
    AND reward.candidate_id = NEW.candidate_id
    AND reward.reward_status = 'pending'
    AND reward.confirm_after = NEW.scheduled_for
    AND candidate.candidate_id = NEW.candidate_id
)
BEGIN
  SELECT RAISE(ABORT, 'protection job does not match a pending reward');
END;

CREATE TRIGGER IF NOT EXISTS v144_package_referral_protection_jobs_identity_immutable
BEFORE UPDATE ON package_referral_protection_jobs
WHEN NEW.protection_job_id IS NOT OLD.protection_job_id
  OR NEW.job_key IS NOT OLD.job_key
  OR NEW.reward_id IS NOT OLD.reward_id
  OR NEW.candidate_id IS NOT OLD.candidate_id
  OR NEW.workflow_instance_id IS NOT OLD.workflow_instance_id
  OR NEW.scheduled_for IS NOT OLD.scheduled_for
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'protection job identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS v144_package_referral_protection_jobs_state_guard
BEFORE UPDATE OF workflow_state ON package_referral_protection_jobs
WHEN NEW.workflow_state != OLD.workflow_state AND NOT (
  (OLD.workflow_state = 'pending'
    AND NEW.workflow_state IN ('started', 'start_failed', 'manual_review'))
  OR
  (OLD.workflow_state = 'start_failed'
    AND NEW.workflow_state IN ('started', 'manual_review'))
  OR
  (OLD.workflow_state = 'manual_review'
    AND NEW.workflow_state = 'started')
  OR
  (OLD.workflow_state = 'started'
    AND NEW.workflow_state IN ('completed', 'start_failed', 'manual_review'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid protection job state transition');
END;

CREATE TRIGGER IF NOT EXISTS v144_package_referral_protection_jobs_completed_immutable
BEFORE UPDATE ON package_referral_protection_jobs
WHEN OLD.workflow_state = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'completed protection job is immutable');
END;

CREATE TRIGGER IF NOT EXISTS v144_package_referral_protection_jobs_completion_guard
BEFORE UPDATE ON package_referral_protection_jobs
WHEN NEW.workflow_state = 'completed' AND NOT EXISTS (
  SELECT 1
  FROM package_referral_rewards reward
  JOIN package_referral_transitions transition
    ON transition.transition_id = NEW.settled_transition_id
  JOIN package_referral_protection_checks protection_check
    ON protection_check.transition_id = transition.transition_id
  WHERE reward.reward_id = NEW.reward_id
    AND reward.last_transition_id = transition.transition_id
    AND reward.reward_status = NEW.settlement_outcome
    AND transition.reward_id = reward.reward_id
    AND transition.to_status = reward.reward_status
    AND protection_check.reward_id = reward.reward_id
)
BEGIN
  SELECT RAISE(ABORT, 'completed job lacks its settled reward transition');
END;

CREATE TRIGGER IF NOT EXISTS v144_package_referral_protection_jobs_no_delete
BEFORE DELETE ON package_referral_protection_jobs
BEGIN
  SELECT RAISE(ABORT, 'protection jobs cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS v144_package_referral_protection_checks_confirm_guard
BEFORE INSERT ON package_referral_protection_checks
WHEN NEW.decision = 'confirm' AND NOT EXISTS (
  SELECT 1
  FROM package_referral_rewards reward
  JOIN package_referral_candidates candidate
    ON candidate.candidate_id = reward.candidate_id
  JOIN subscription_orders orders
    ON orders.order_id = candidate.source_order_id
  JOIN payment_ledger payment
    ON payment.ledger_entry_id = candidate.source_payment_ledger_entry_id
  JOIN subscription_package_periods source_access
    ON source_access.period_id = candidate.source_package_period_id
  JOIN payment_reconciliation_runs reconciliation
    ON reconciliation.run_id = NEW.reconciliation_run_id
  JOIN payment_reconciliation_items reconciliation_item
    ON reconciliation_item.item_id = NEW.reconciliation_item_id
  WHERE reward.reward_id = NEW.reward_id
    AND reward.candidate_id = NEW.candidate_id
    AND reward.reward_status = 'pending'
    AND reward.revision = NEW.reward_revision
    AND NEW.checked_at >= reward.confirm_after
    AND candidate.candidate_id = NEW.candidate_id
    AND candidate.source_payment_ledger_entry_id =
      NEW.source_payment_ledger_entry_id
    AND candidate.source_package_period_id = NEW.source_package_period_id
    AND orders.order_state = 'applied'
    AND orders.telegram_id = candidate.buyer_telegram_id
    AND orders.plan_code = candidate.buyer_plan_code
    AND orders.amount_stars = candidate.amount_stars
    AND payment.order_id = candidate.source_order_id
    AND payment.telegram_id = candidate.buyer_telegram_id
    AND payment.entry_type = 'payment'
    AND payment.direction = 'credit'
    AND payment.currency = 'XTR'
    AND payment.amount_stars = candidate.amount_stars
    AND payment.occurred_at = candidate.paid_at
    AND source_access.payment_ledger_entry_id = payment.ledger_entry_id
    AND source_access.order_id = candidate.source_order_id
    AND source_access.telegram_id = candidate.buyer_telegram_id
    AND source_access.plan_code = candidate.buyer_plan_code
    AND source_access.recorded_at <= NEW.recorded_at
    AND reconciliation.status IN ('completed', 'manual_review')
    AND reconciliation.started_at >= reward.confirm_after
    AND reconciliation.finished_at IS NOT NULL
    AND reconciliation.finished_at <= NEW.checked_at
    AND reconciliation_item.run_id = reconciliation.run_id
    AND reconciliation_item.ledger_entry_id = payment.ledger_entry_id
    AND reconciliation_item.observation_side = 'telegram'
    AND reconciliation_item.transaction_direction = 'incoming'
    AND reconciliation_item.telegram_id = candidate.buyer_telegram_id
    AND reconciliation_item.amount_stars = candidate.amount_stars
    AND ABS(reconciliation_item.transaction_date - candidate.paid_at) <= 86400
    AND reconciliation_item.local_state IN ('matched', 'recovered')
    AND reconciliation_item.observed_at >= reward.confirm_after
    AND reconciliation_item.observed_at <= NEW.checked_at
    AND NOT EXISTS (
      SELECT 1
      FROM payment_ledger compensation
      WHERE compensation.related_ledger_entry_id = payment.ledger_entry_id
        AND compensation.entry_type IN ('refund', 'chargeback')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'confirmation check lacks fresh payment evidence');
END;

CREATE TRIGGER IF NOT EXISTS v144_package_referral_protection_checks_cancel_guard
BEFORE INSERT ON package_referral_protection_checks
WHEN NEW.decision = 'cancel' AND NOT EXISTS (
  SELECT 1
  FROM package_referral_rewards reward
  JOIN package_referral_candidates candidate
    ON candidate.candidate_id = reward.candidate_id
  JOIN payment_ledger compensation
    ON compensation.ledger_entry_id = NEW.compensation_ledger_entry_id
  WHERE reward.reward_id = NEW.reward_id
    AND reward.candidate_id = NEW.candidate_id
    AND reward.reward_status IN ('pending','confirmed')
    AND reward.revision = NEW.reward_revision
    AND candidate.source_payment_ledger_entry_id =
      NEW.source_payment_ledger_entry_id
    AND candidate.source_package_period_id = NEW.source_package_period_id
    AND compensation.related_ledger_entry_id =
      candidate.source_payment_ledger_entry_id
    AND compensation.entry_type = NEW.reason_code
    AND compensation.direction = 'debit'
    AND compensation.currency = 'XTR'
    AND compensation.order_id = candidate.source_order_id
    AND compensation.telegram_id = candidate.buyer_telegram_id
    AND compensation.amount_stars = candidate.amount_stars
    AND compensation.recorded_at <= NEW.checked_at
)
BEGIN
  SELECT RAISE(ABORT, 'cancellation check lacks compensation evidence');
END;

CREATE TRIGGER IF NOT EXISTS v144_package_referral_protection_checks_immutable_update
BEFORE UPDATE ON package_referral_protection_checks
BEGIN
  SELECT RAISE(ABORT, 'protection checks are append-only');
END;

CREATE TRIGGER IF NOT EXISTS v144_package_referral_protection_checks_immutable_delete
BEFORE DELETE ON package_referral_protection_checks
BEGIN
  SELECT RAISE(ABORT, 'protection checks are append-only');
END;

CREATE TRIGGER IF NOT EXISTS v144_package_referral_transitions_protection_check_guard
BEFORE INSERT ON package_referral_transitions
WHEN NEW.transition_scope = 'reward'
  AND NEW.from_status IN ('pending','confirmed')
  AND (
    NEW.to_status = 'confirmed'
    OR (
      NEW.to_status = 'cancelled'
      AND NEW.reason_code IN ('refund', 'chargeback')
      AND NEW.actor_type IN ('workflow', 'system')
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM package_referral_protection_checks protection_check
    WHERE protection_check.transition_id = NEW.transition_id
      AND protection_check.reward_id = NEW.reward_id
      AND protection_check.reward_revision = NEW.from_revision
      AND protection_check.reason_code = NEW.reason_code
      AND protection_check.recorded_at <= NEW.recorded_at
      AND (
        (NEW.to_status = 'confirmed'
          AND protection_check.decision = 'confirm'
          AND protection_check.source_payment_ledger_entry_id =
            NEW.related_payment_ledger_entry_id
          AND protection_check.checked_at = NEW.occurred_at)
        OR
        (NEW.to_status = 'cancelled'
          AND protection_check.decision = 'cancel'
          AND protection_check.compensation_ledger_entry_id =
            NEW.related_payment_ledger_entry_id)
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'reward transition lacks its protection check');
END;

CREATE TRIGGER IF NOT EXISTS v144_package_referral_transition_identity BEFORE INSERT ON package_referral_transitions
WHEN NOT EXISTS(SELECT 1 FROM package_referral_rewards r WHERE r.reward_id=NEW.reward_id AND ((NEW.from_status='none' AND r.reward_status='pending' AND r.revision=1 AND NEW.to_revision=1 AND NEW.reason_code='candidate_selected' AND NEW.actor_type='system' AND NEW.occurred_at=r.created_at) OR (NEW.from_status=r.reward_status AND NEW.from_revision=r.revision AND NEW.to_revision=r.revision+1 AND NEW.recorded_at>=r.updated_at)))
 OR NOT((NEW.from_status='none' AND NEW.to_status='pending' AND NEW.reason_code='candidate_selected' AND NEW.actor_type='system') OR (NEW.to_status='confirmed' AND NEW.reason_code='hold_elapsed' AND NEW.actor_type='workflow') OR (NEW.to_status='cancelled' AND NEW.reason_code IN ('refund','chargeback') AND NEW.actor_type IN ('workflow','system')) OR (NEW.to_status='cancelled' AND NEW.reason_code IN ('fraud','policy_violation','admin_correction') AND NEW.actor_type='admin'))
 OR (NEW.reason_code IN ('refund','chargeback') AND NOT EXISTS(SELECT 1 FROM package_referral_rewards r JOIN package_referral_candidates c ON c.candidate_id=r.candidate_id JOIN payment_ledger p ON p.ledger_entry_id=NEW.related_payment_ledger_entry_id WHERE r.reward_id=NEW.reward_id AND p.related_ledger_entry_id=c.source_payment_ledger_entry_id AND p.entry_type=NEW.reason_code AND p.direction='debit' AND p.currency='XTR' AND p.amount_stars=c.amount_stars AND p.telegram_id=c.buyer_telegram_id AND p.order_id=c.source_order_id AND p.occurred_at=NEW.occurred_at AND p.recorded_at<=NEW.recorded_at))
 OR (NEW.reason_code NOT IN ('refund','chargeback') AND NOT EXISTS(SELECT 1 FROM package_referral_rewards r JOIN package_referral_candidates c ON c.candidate_id=r.candidate_id WHERE r.reward_id=NEW.reward_id AND c.source_payment_ledger_entry_id=NEW.related_payment_ledger_entry_id))
BEGIN SELECT RAISE(ABORT,'package_referral_transition_invalid'); END;

CREATE INDEX IF NOT EXISTS idx_v144_package_referral_due ON package_referral_rewards(reward_status,confirm_after,reward_id);
CREATE INDEX IF NOT EXISTS idx_v144_package_referral_beneficiary ON package_referral_rewards(beneficiary_telegram_id,created_at,reward_id);
CREATE INDEX IF NOT EXISTS idx_v144_package_referral_checks ON package_referral_protection_checks(reward_id,reward_revision);
CREATE INDEX IF NOT EXISTS idx_v144_package_referral_jobs ON package_referral_protection_jobs(workflow_state,scheduled_for,protection_job_id);

CREATE TABLE IF NOT EXISTS referral_reward_lifetime_slots (
 candidate_id TEXT NOT NULL PRIMARY KEY CHECK(length(candidate_id)=36),source_kind TEXT NOT NULL CHECK(source_kind IN ('legacy','package')),
 legacy_candidate_id TEXT UNIQUE REFERENCES referral_reward_candidates(candidate_id),
 package_candidate_id TEXT UNIQUE REFERENCES package_referral_candidates(candidate_id),
 program_code TEXT NOT NULL CHECK(program_code='first_paid_friend_v1'),
 buyer_telegram_id INTEGER NOT NULL CHECK(buyer_telegram_id>0),inviter_telegram_id INTEGER NOT NULL CHECK(inviter_telegram_id>0),
 source_order_id TEXT NOT NULL UNIQUE REFERENCES subscription_orders(order_id),
 source_payment_ledger_entry_id TEXT NOT NULL UNIQUE REFERENCES payment_ledger(ledger_entry_id),
 created_at INTEGER NOT NULL CHECK(created_at>0),
 UNIQUE(program_code,buyer_telegram_id),UNIQUE(program_code,inviter_telegram_id),
 CHECK(buyer_telegram_id!=inviter_telegram_id),
 CHECK((source_kind='legacy' AND legacy_candidate_id IS NOT NULL AND legacy_candidate_id=candidate_id AND package_candidate_id IS NULL) OR (source_kind='package' AND package_candidate_id IS NOT NULL AND package_candidate_id=candidate_id AND legacy_candidate_id IS NULL))
);
CREATE TRIGGER IF NOT EXISTS v144_referral_lifetime_slot_binding BEFORE INSERT ON referral_reward_lifetime_slots
WHEN NOT((NEW.source_kind='legacy' AND EXISTS(SELECT 1 FROM referral_reward_candidates c WHERE c.candidate_id=NEW.legacy_candidate_id AND c.program_code=NEW.program_code AND c.buyer_telegram_id=NEW.buyer_telegram_id AND c.inviter_telegram_id=NEW.inviter_telegram_id AND c.source_order_id=NEW.source_order_id AND c.source_payment_ledger_entry_id=NEW.source_payment_ledger_entry_id AND c.created_at=NEW.created_at)) OR (NEW.source_kind='package' AND EXISTS(SELECT 1 FROM package_referral_candidates c WHERE c.candidate_id=NEW.package_candidate_id AND c.program_code=NEW.program_code AND c.buyer_telegram_id=NEW.buyer_telegram_id AND c.inviter_telegram_id=NEW.inviter_telegram_id AND c.source_order_id=NEW.source_order_id AND c.source_payment_ledger_entry_id=NEW.source_payment_ledger_entry_id AND c.created_at=NEW.created_at)))
BEGIN SELECT RAISE(ABORT,'referral_lifetime_slot_source_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v144_referral_lifetime_slot_no_update BEFORE UPDATE ON referral_reward_lifetime_slots
BEGIN SELECT RAISE(ABORT,'referral_lifetime_slot_immutable'); END;
CREATE TRIGGER IF NOT EXISTS v144_referral_lifetime_slot_no_delete BEFORE DELETE ON referral_reward_lifetime_slots
BEGIN SELECT RAISE(ABORT,'referral_lifetime_slot_retained'); END;
-- UNION also validates every existing reward identity. Conflicting history aborts;
-- only an exactly matching previously backfilled source is skipped on replay.
INSERT INTO referral_reward_lifetime_slots(candidate_id,source_kind,legacy_candidate_id,package_candidate_id,program_code,buyer_telegram_id,inviter_telegram_id,source_order_id,source_payment_ledger_entry_id,created_at)
SELECT c.candidate_id,'legacy',c.candidate_id,NULL,c.program_code,c.buyer_telegram_id,c.inviter_telegram_id,c.source_order_id,c.source_payment_ledger_entry_id,c.created_at FROM referral_reward_candidates c
WHERE NOT EXISTS(SELECT 1 FROM referral_reward_lifetime_slots s WHERE s.candidate_id=c.candidate_id AND s.source_kind='legacy' AND s.legacy_candidate_id=c.candidate_id AND s.program_code=c.program_code AND s.buyer_telegram_id=c.buyer_telegram_id AND s.inviter_telegram_id=c.inviter_telegram_id AND s.source_order_id=c.source_order_id AND s.source_payment_ledger_entry_id=c.source_payment_ledger_entry_id AND s.created_at=c.created_at)
UNION
SELECT r.candidate_id,'legacy',r.candidate_id,NULL,r.program_code,r.buyer_telegram_id,r.beneficiary_telegram_id,c.source_order_id,c.source_payment_ledger_entry_id,c.created_at FROM referral_rewards r LEFT JOIN referral_reward_candidates c ON c.candidate_id=r.candidate_id
WHERE NOT EXISTS(SELECT 1 FROM referral_reward_lifetime_slots s WHERE s.candidate_id=r.candidate_id AND s.source_kind='legacy' AND s.legacy_candidate_id=r.candidate_id AND s.program_code=r.program_code AND s.buyer_telegram_id=r.buyer_telegram_id AND s.inviter_telegram_id=r.beneficiary_telegram_id AND s.source_order_id=c.source_order_id AND s.source_payment_ledger_entry_id=c.source_payment_ledger_entry_id AND s.created_at=c.created_at);
CREATE TRIGGER IF NOT EXISTS v144_legacy_referral_lifetime_guard BEFORE INSERT ON referral_reward_candidates
WHEN EXISTS(SELECT 1 FROM referral_reward_lifetime_slots s WHERE s.program_code=NEW.program_code AND (s.buyer_telegram_id=NEW.buyer_telegram_id OR s.inviter_telegram_id=NEW.inviter_telegram_id OR s.source_order_id=NEW.source_order_id OR s.source_payment_ledger_entry_id=NEW.source_payment_ledger_entry_id))
BEGIN SELECT RAISE(ABORT,'referral_lifetime_slot_occupied'); END;
CREATE TRIGGER IF NOT EXISTS v144_legacy_referral_lifetime_claim AFTER INSERT ON referral_reward_candidates
BEGIN INSERT INTO referral_reward_lifetime_slots VALUES(NEW.candidate_id,'legacy',NEW.candidate_id,NULL,NEW.program_code,NEW.buyer_telegram_id,NEW.inviter_telegram_id,NEW.source_order_id,NEW.source_payment_ledger_entry_id,NEW.created_at); END;
CREATE TRIGGER IF NOT EXISTS v144_package_referral_lifetime_guard BEFORE INSERT ON package_referral_candidates
WHEN EXISTS(SELECT 1 FROM referral_reward_lifetime_slots s WHERE s.program_code=NEW.program_code AND (s.buyer_telegram_id=NEW.buyer_telegram_id OR s.inviter_telegram_id=NEW.inviter_telegram_id OR s.source_order_id=NEW.source_order_id OR s.source_payment_ledger_entry_id=NEW.source_payment_ledger_entry_id))
BEGIN SELECT RAISE(ABORT,'referral_lifetime_slot_occupied'); END;
CREATE TRIGGER IF NOT EXISTS v144_package_referral_lifetime_claim AFTER INSERT ON package_referral_candidates
BEGIN INSERT INTO referral_reward_lifetime_slots VALUES(NEW.candidate_id,'package',NULL,NEW.candidate_id,NEW.program_code,NEW.buyer_telegram_id,NEW.inviter_telegram_id,NEW.source_order_id,NEW.source_payment_ledger_entry_id,NEW.created_at); END;

CREATE TABLE IF NOT EXISTS package_referral_bonus_grants (
 bonus_grant_id TEXT NOT NULL PRIMARY KEY CHECK(length(bonus_grant_id)=36),grant_key TEXT NOT NULL UNIQUE CHECK(length(grant_key) BETWEEN 16 AND 160),
 program_code TEXT NOT NULL CHECK(program_code='first_paid_friend_v1'),reward_kind TEXT NOT NULL CHECK(reward_kind IN ('legacy','package')),reward_id TEXT NOT NULL,
 legacy_reward_id TEXT UNIQUE REFERENCES referral_rewards(reward_id),package_reward_id TEXT UNIQUE REFERENCES package_referral_rewards(reward_id),
 beneficiary_telegram_id INTEGER NOT NULL CHECK(beneficiary_telegram_id>0),delivery_mode TEXT NOT NULL CHECK(delivery_mode IN ('manual_claim','extend_active_plan')),
 plan_code TEXT NOT NULL CHECK(plan_code IN ('professional','dragon')),bonus_seconds INTEGER NOT NULL CHECK(bonus_seconds=259200),
 grant_status TEXT NOT NULL CHECK(grant_status IN ('pending','claimable','applied','expired','revoked','manual_review')),
 available_at INTEGER NOT NULL CHECK(available_at>0),claim_expires_at INTEGER,claimed_at INTEGER,applied_at INTEGER,starts_at INTEGER,ends_at INTEGER,
 allocation_anchor_at INTEGER,allocation_fingerprint TEXT CHECK(allocation_fingerprint IS NULL OR (length(allocation_fingerprint)=64 AND allocation_fingerprint NOT GLOB '*[^0-9a-f]*')),
 target_source_kind TEXT NOT NULL CHECK(target_source_kind IN ('none','subscription','package','earned')),
 target_subscription_id TEXT REFERENCES subscriptions(subscription_id),target_package_period_id TEXT REFERENCES subscription_package_periods(period_id),
 target_payment_ledger_entry_id TEXT REFERENCES payment_ledger(ledger_entry_id),
 target_legacy_bonus_grant_id TEXT REFERENCES bonus_access_grants(bonus_grant_id),target_package_bonus_grant_id TEXT REFERENCES package_referral_bonus_grants(bonus_grant_id),
 source_payment_ledger_entry_id TEXT NOT NULL REFERENCES payment_ledger(ledger_entry_id),compensation_ledger_entry_id TEXT REFERENCES payment_ledger(ledger_entry_id),
 compensated_seconds INTEGER NOT NULL DEFAULT 0 CHECK(compensated_seconds BETWEEN 0 AND 259200),compensated_at INTEGER,last_transition_id TEXT,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),created_at INTEGER NOT NULL CHECK(created_at>=available_at),updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
 CHECK((reward_kind='legacy' AND legacy_reward_id IS NOT NULL AND legacy_reward_id=reward_id AND package_reward_id IS NULL) OR (reward_kind='package' AND package_reward_id IS NOT NULL AND package_reward_id=reward_id AND legacy_reward_id IS NULL)),
 CHECK((delivery_mode='manual_claim' AND plan_code='professional' AND claim_expires_at IS NOT NULL AND claim_expires_at=available_at+2592000 AND target_source_kind='none') OR (delivery_mode='extend_active_plan' AND claim_expires_at IS NULL AND target_source_kind IN ('subscription','package','earned'))),
 CHECK((target_source_kind='none' AND target_subscription_id IS NULL AND target_package_period_id IS NULL AND target_payment_ledger_entry_id IS NULL AND target_legacy_bonus_grant_id IS NULL AND target_package_bonus_grant_id IS NULL) OR (target_source_kind='subscription' AND target_subscription_id IS NOT NULL AND target_package_period_id IS NULL AND target_payment_ledger_entry_id IS NOT NULL AND target_legacy_bonus_grant_id IS NULL AND target_package_bonus_grant_id IS NULL) OR (target_source_kind='package' AND target_package_period_id IS NOT NULL AND target_subscription_id IS NULL AND target_payment_ledger_entry_id IS NOT NULL AND target_legacy_bonus_grant_id IS NULL AND target_package_bonus_grant_id IS NULL) OR (target_source_kind='earned' AND target_subscription_id IS NULL AND target_package_period_id IS NULL AND target_payment_ledger_entry_id IS NULL AND ((target_legacy_bonus_grant_id IS NOT NULL AND target_package_bonus_grant_id IS NULL) OR (target_legacy_bonus_grant_id IS NULL AND target_package_bonus_grant_id IS NOT NULL)))),
 CHECK((grant_status IN ('pending','claimable','expired') AND claimed_at IS NULL AND applied_at IS NULL AND starts_at IS NULL AND ends_at IS NULL AND allocation_anchor_at IS NULL AND allocation_fingerprint IS NULL) OR (grant_status IN ('applied','manual_review') AND applied_at IS NOT NULL AND applied_at>=available_at AND starts_at IS NOT NULL AND starts_at>=available_at AND ends_at IS NOT NULL AND ends_at>starts_at AND allocation_anchor_at IS NOT NULL AND allocation_anchor_at>=available_at AND allocation_fingerprint IS NOT NULL) OR grant_status='revoked'),
 CHECK((compensation_ledger_entry_id IS NULL AND compensated_seconds=0 AND compensated_at IS NULL) OR (compensation_ledger_entry_id IS NOT NULL AND compensated_at IS NOT NULL AND compensated_at>=available_at)),
 CHECK(grant_status!='manual_review' OR compensation_ledger_entry_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS package_referral_bonus_segments (
 segment_id TEXT NOT NULL PRIMARY KEY CHECK(length(segment_id)=36),bonus_grant_id TEXT NOT NULL REFERENCES package_referral_bonus_grants(bonus_grant_id),
 segment_index INTEGER NOT NULL CHECK(segment_index BETWEEN 0 AND 63),plan_code TEXT NOT NULL CHECK(plan_code IN ('professional','dragon')),
 starts_at INTEGER NOT NULL CHECK(starts_at>0),ends_at INTEGER NOT NULL CHECK(ends_at>starts_at),seconds INTEGER NOT NULL CHECK(seconds=ends_at-starts_at AND seconds BETWEEN 1 AND 259200),
 recorded_at INTEGER NOT NULL CHECK(recorded_at>0),UNIQUE(bonus_grant_id,segment_index)
);
CREATE TABLE IF NOT EXISTS package_referral_bonus_effects (
 effect_id TEXT NOT NULL PRIMARY KEY CHECK(length(effect_id)=36),effect_key TEXT NOT NULL UNIQUE CHECK(length(effect_key) BETWEEN 16 AND 160),bonus_grant_id TEXT NOT NULL UNIQUE REFERENCES package_referral_bonus_grants(bonus_grant_id),
 reward_kind TEXT NOT NULL CHECK(reward_kind IN ('legacy','package')),reward_id TEXT NOT NULL,beneficiary_telegram_id INTEGER NOT NULL CHECK(beneficiary_telegram_id>0),
 effect_kind TEXT NOT NULL CHECK(effect_kind IN ('manual_professional_access','paid_plan_extension')),plan_code TEXT NOT NULL CHECK(plan_code IN ('professional','dragon')),
 source_payment_ledger_entry_id TEXT NOT NULL REFERENCES payment_ledger(ledger_entry_id),target_source_kind TEXT NOT NULL CHECK(target_source_kind IN ('none','subscription','package','earned')),
 target_subscription_id TEXT REFERENCES subscriptions(subscription_id),target_package_period_id TEXT REFERENCES subscription_package_periods(period_id),target_payment_ledger_entry_id TEXT REFERENCES payment_ledger(ledger_entry_id),
 target_legacy_bonus_grant_id TEXT REFERENCES bonus_access_grants(bonus_grant_id),target_package_bonus_grant_id TEXT REFERENCES package_referral_bonus_grants(bonus_grant_id),
 allocation_anchor_at INTEGER NOT NULL CHECK(allocation_anchor_at>0),allocation_fingerprint TEXT NOT NULL CHECK(length(allocation_fingerprint)=64 AND allocation_fingerprint NOT GLOB '*[^0-9a-f]*'),
 allocation_json TEXT NOT NULL CHECK(length(allocation_json) BETWEEN 2 AND 65536 AND json_valid(allocation_json)),
 applied_transition_id TEXT NOT NULL UNIQUE CHECK(length(applied_transition_id) BETWEEN 16 AND 96),recorded_at INTEGER NOT NULL CHECK(recorded_at>0)
);
CREATE TABLE IF NOT EXISTS package_referral_bonus_transitions (
 transition_id TEXT NOT NULL PRIMARY KEY CHECK(length(transition_id) BETWEEN 16 AND 96),transition_key TEXT NOT NULL UNIQUE CHECK(length(transition_key) BETWEEN 16 AND 160),
 bonus_grant_id TEXT NOT NULL REFERENCES package_referral_bonus_grants(bonus_grant_id),from_status TEXT NOT NULL CHECK(from_status IN ('none','pending','claimable','applied')),
 to_status TEXT NOT NULL CHECK(to_status IN ('pending','claimable','applied','expired','revoked','manual_review')),from_revision INTEGER NOT NULL CHECK(from_revision>=0),to_revision INTEGER NOT NULL CHECK(to_revision=from_revision+1),
 reason_code TEXT NOT NULL CHECK(reason_code IN ('grant_created','manual_claim','active_plan_extension','claim_window_expired','refund','chargeback')),
 actor_type TEXT NOT NULL CHECK(actor_type IN ('system','workflow','telegram')),actor_id INTEGER,related_payment_ledger_entry_id TEXT NOT NULL REFERENCES payment_ledger(ledger_entry_id),
 compensated_seconds INTEGER NOT NULL DEFAULT 0 CHECK(compensated_seconds BETWEEN 0 AND 259200),occurred_at INTEGER NOT NULL CHECK(occurred_at>0),recorded_at INTEGER NOT NULL CHECK(recorded_at>=occurred_at),
 UNIQUE(bonus_grant_id,from_revision),CHECK((actor_type='telegram' AND actor_id IS NOT NULL AND actor_id>0) OR (actor_type IN ('system','workflow') AND actor_id IS NULL)),
 CHECK((from_status='none' AND to_status IN ('pending','claimable') AND from_revision=0) OR (from_status='pending' AND to_status IN ('applied','revoked') AND from_revision>0) OR (from_status='claimable' AND to_status IN ('applied','expired','revoked') AND from_revision>0) OR (from_status='applied' AND to_status IN ('revoked','manual_review') AND from_revision>0))
);
CREATE TABLE IF NOT EXISTS package_referral_bonus_reversals (
 reversal_id TEXT NOT NULL PRIMARY KEY CHECK(length(reversal_id)=36),reversal_key TEXT NOT NULL UNIQUE CHECK(length(reversal_key) BETWEEN 16 AND 160),
 bonus_grant_id TEXT NOT NULL REFERENCES package_referral_bonus_grants(bonus_grant_id),effect_id TEXT NOT NULL UNIQUE REFERENCES package_referral_bonus_effects(effect_id),
 compensation_ledger_entry_id TEXT NOT NULL REFERENCES payment_ledger(ledger_entry_id),reversal_transition_id TEXT NOT NULL UNIQUE REFERENCES package_referral_bonus_transitions(transition_id),
 compensated_seconds INTEGER NOT NULL CHECK(compensated_seconds BETWEEN 0 AND 259200),occurred_at INTEGER NOT NULL CHECK(occurred_at>0),recorded_at INTEGER NOT NULL CHECK(recorded_at>=occurred_at)
);
CREATE TABLE IF NOT EXISTS referral_bonus_reward_slots (
 reward_kind TEXT NOT NULL CHECK(reward_kind IN ('legacy','package')),reward_id TEXT NOT NULL,
 legacy_reward_id TEXT REFERENCES referral_rewards(reward_id),package_reward_id TEXT REFERENCES package_referral_rewards(reward_id),
 legacy_bonus_grant_id TEXT UNIQUE REFERENCES bonus_access_grants(bonus_grant_id),package_bonus_grant_id TEXT UNIQUE REFERENCES package_referral_bonus_grants(bonus_grant_id),
 created_at INTEGER NOT NULL CHECK(created_at>0),PRIMARY KEY(reward_kind,reward_id),
 CHECK((reward_kind='legacy' AND legacy_reward_id IS NOT NULL AND legacy_reward_id=reward_id AND package_reward_id IS NULL) OR (reward_kind='package' AND package_reward_id IS NOT NULL AND package_reward_id=reward_id AND legacy_reward_id IS NULL)),
 CHECK((legacy_bonus_grant_id IS NOT NULL AND package_bonus_grant_id IS NULL AND reward_kind='legacy') OR (legacy_bonus_grant_id IS NULL AND package_bonus_grant_id IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS v144_referral_bonus_slot_binding BEFORE INSERT ON referral_bonus_reward_slots
WHEN NOT((NEW.legacy_bonus_grant_id IS NOT NULL AND EXISTS(SELECT 1 FROM bonus_access_grants g WHERE g.bonus_grant_id=NEW.legacy_bonus_grant_id AND g.reward_id=NEW.reward_id AND g.created_at=NEW.created_at)) OR (NEW.package_bonus_grant_id IS NOT NULL AND EXISTS(SELECT 1 FROM package_referral_bonus_grants g WHERE g.bonus_grant_id=NEW.package_bonus_grant_id AND g.reward_kind=NEW.reward_kind AND g.reward_id=NEW.reward_id AND g.created_at=NEW.created_at)))
BEGIN SELECT RAISE(ABORT,'referral_bonus_slot_source_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v144_referral_bonus_slot_no_update BEFORE UPDATE ON referral_bonus_reward_slots
BEGIN SELECT RAISE(ABORT,'referral_bonus_slot_immutable'); END;
CREATE TRIGGER IF NOT EXISTS v144_referral_bonus_slot_no_delete BEFORE DELETE ON referral_bonus_reward_slots
BEGIN SELECT RAISE(ABORT,'referral_bonus_slot_retained'); END;
INSERT INTO referral_bonus_reward_slots(reward_kind,reward_id,legacy_reward_id,package_reward_id,legacy_bonus_grant_id,package_bonus_grant_id,created_at)
SELECT 'legacy',g.reward_id,g.reward_id,NULL,g.bonus_grant_id,NULL,g.created_at FROM bonus_access_grants g
WHERE NOT EXISTS(SELECT 1 FROM referral_bonus_reward_slots s WHERE s.reward_kind='legacy' AND s.reward_id=g.reward_id AND s.legacy_reward_id=g.reward_id AND s.package_reward_id IS NULL AND s.legacy_bonus_grant_id=g.bonus_grant_id AND s.package_bonus_grant_id IS NULL AND s.created_at=g.created_at);
CREATE TRIGGER IF NOT EXISTS v144_legacy_referral_bonus_slot_guard BEFORE INSERT ON bonus_access_grants
WHEN EXISTS(SELECT 1 FROM referral_bonus_reward_slots s WHERE s.reward_kind='legacy' AND s.reward_id=NEW.reward_id)
BEGIN SELECT RAISE(ABORT,'referral_bonus_slot_occupied'); END;
CREATE TRIGGER IF NOT EXISTS v144_legacy_referral_bonus_slot_claim AFTER INSERT ON bonus_access_grants
BEGIN INSERT INTO referral_bonus_reward_slots VALUES('legacy',NEW.reward_id,NEW.reward_id,NULL,NEW.bonus_grant_id,NULL,NEW.created_at); END;
CREATE TRIGGER IF NOT EXISTS v144_package_referral_bonus_slot_guard BEFORE INSERT ON package_referral_bonus_grants
WHEN EXISTS(SELECT 1 FROM referral_bonus_reward_slots s WHERE s.reward_kind=NEW.reward_kind AND s.reward_id=NEW.reward_id)
BEGIN SELECT RAISE(ABORT,'referral_bonus_slot_occupied'); END;
CREATE TRIGGER IF NOT EXISTS v144_package_referral_bonus_slot_claim AFTER INSERT ON package_referral_bonus_grants
BEGIN INSERT INTO referral_bonus_reward_slots VALUES(NEW.reward_kind,NEW.reward_id,NEW.legacy_reward_id,NEW.package_reward_id,NULL,NEW.bonus_grant_id,NEW.created_at); END;

-- Bonus authority guards: append-only allocations never rewrite paid windows.
CREATE TRIGGER IF NOT EXISTS v144_package_bonus_initial BEFORE INSERT ON package_referral_bonus_grants
WHEN NOT (NEW.revision=1 AND NEW.last_transition_id IS NULL AND NEW.updated_at=NEW.created_at AND NEW.compensation_ledger_entry_id IS NULL AND NEW.compensated_seconds=0 AND NEW.compensated_at IS NULL AND ((NEW.delivery_mode='manual_claim' AND NEW.grant_status='claimable') OR (NEW.delivery_mode='extend_active_plan' AND NEW.grant_status='pending')) AND (( NEW.reward_kind='legacy' AND EXISTS(SELECT 1 FROM referral_rewards r JOIN referral_reward_candidates c ON c.candidate_id=r.candidate_id JOIN subscription_access_grants source_g ON source_g.grant_id=c.source_access_grant_id JOIN payment_ledger p ON p.ledger_entry_id=c.source_payment_ledger_entry_id WHERE r.reward_id=NEW.legacy_reward_id AND r.program_code=NEW.program_code AND r.reward_status='confirmed' AND r.beneficiary_telegram_id=NEW.beneficiary_telegram_id AND r.confirmed_at=NEW.available_at AND p.ledger_entry_id=NEW.source_payment_ledger_entry_id AND p.entry_type='payment' AND p.direction='credit' AND p.currency='XTR' AND source_g.payment_ledger_entry_id=p.ledger_entry_id AND source_g.order_id=c.source_order_id AND source_g.status='active')) OR (NEW.reward_kind='package' AND EXISTS(SELECT 1 FROM package_referral_rewards r JOIN package_referral_candidates c ON c.candidate_id=r.candidate_id JOIN subscription_package_periods source_g ON source_g.period_id=c.source_package_period_id JOIN payment_ledger p ON p.ledger_entry_id=c.source_payment_ledger_entry_id WHERE r.reward_id=NEW.package_reward_id AND r.program_code=NEW.program_code AND r.reward_status='confirmed' AND r.beneficiary_telegram_id=NEW.beneficiary_telegram_id AND r.confirmed_at=NEW.available_at AND p.ledger_entry_id=NEW.source_payment_ledger_entry_id AND p.entry_type='payment' AND p.direction='credit' AND p.currency='XTR' AND source_g.payment_ledger_entry_id=p.ledger_entry_id AND source_g.order_id=c.source_order_id))) AND NOT EXISTS(SELECT 1 FROM payment_ledger x WHERE x.related_ledger_entry_id=NEW.source_payment_ledger_entry_id AND x.entry_type IN ('refund','chargeback')) AND (NEW.target_source_kind='none' OR (NEW.target_source_kind='subscription' AND EXISTS(SELECT 1 FROM subscriptions t JOIN payment_ledger p ON p.ledger_entry_id=NEW.target_payment_ledger_entry_id JOIN subscription_access_grants g ON g.payment_ledger_entry_id=p.ledger_entry_id WHERE t.subscription_id=NEW.target_subscription_id AND t.telegram_id=NEW.beneficiary_telegram_id AND t.plan_code=NEW.plan_code AND t.status IN ('active','cancel_at_period_end') AND (t.current_period_start<=NEW.created_at OR (t.billing_mode='recurring' AND g.starts_at=t.current_period_start AND p.occurred_at<=NEW.created_at AND p.occurred_at<=g.starts_at AND g.starts_at-p.occurred_at<=86400 AND EXISTS(SELECT 1 FROM subscription_first_recurring_receipts first_receipt JOIN subscription_payment_links first_link ON first_link.operation_id=first_receipt.operation_id JOIN subscription_billing_contracts first_contract ON first_contract.contract_id=first_link.contract_id WHERE first_receipt.contract_id=first_contract.contract_id AND first_contract.first_payment_ledger_entry_id=p.ledger_entry_id AND first_link.ledger_entry_id=p.ledger_entry_id AND first_link.applied_order_id=g.order_id AND first_link.direction='incoming' AND first_link.link_kind='recurring_charge' AND first_link.telegram_id=t.telegram_id AND first_contract.telegram_id=t.telegram_id AND first_link.plan_code=t.plan_code AND first_contract.plan_code=t.plan_code AND first_link.provider_charge_id=p.telegram_payment_charge_id AND first_link.provider_period_start=g.starts_at AND first_link.provider_period_end=g.ends_at AND first_link.external_invoice_payload=first_contract.external_invoice_payload AND first_link.external_payload_sha256=first_contract.external_payload_sha256 AND first_link.evidence_sha256=first_receipt.evidence_sha256 AND p.currency=first_contract.currency AND p.amount_stars=first_contract.amount_stars AND p.occurred_at=first_link.occurred_at AND p.occurred_at>=first_contract.created_at AND p.occurred_at<=p.recorded_at AND p.recorded_at<=NEW.created_at AND p.occurred_at<=first_link.recorded_at AND first_link.recorded_at<=first_receipt.verified_at AND first_receipt.verified_at<=NEW.created_at))) AND t.current_period_end>NEW.created_at AND p.telegram_id=t.telegram_id AND p.order_id=g.order_id AND p.entry_type='payment' AND p.direction='credit' AND g.subscription_id=t.subscription_id AND g.telegram_id=t.telegram_id AND g.status='active' AND g.plan_code=t.plan_code AND NOT EXISTS(SELECT 1 FROM payment_ledger x WHERE x.related_ledger_entry_id=p.ledger_entry_id AND x.entry_type IN ('refund','chargeback')))) OR (NEW.target_source_kind='package' AND EXISTS(SELECT 1 FROM subscription_package_periods t WHERE t.period_id=NEW.target_package_period_id AND t.payment_ledger_entry_id=NEW.target_payment_ledger_entry_id AND t.telegram_id=NEW.beneficiary_telegram_id AND t.plan_code=NEW.plan_code AND t.starts_at<=NEW.created_at AND t.ends_at>NEW.created_at AND t.recorded_at<=NEW.created_at AND NOT EXISTS(SELECT 1 FROM payment_ledger x WHERE x.related_ledger_entry_id=t.payment_ledger_entry_id AND x.entry_type IN ('refund','chargeback')))) OR (NEW.target_source_kind='earned' AND (EXISTS(SELECT 1 FROM bonus_access_grants t WHERE t.bonus_grant_id=NEW.target_legacy_bonus_grant_id AND t.beneficiary_telegram_id=NEW.beneficiary_telegram_id AND t.plan_code=NEW.plan_code AND t.grant_status='applied' AND t.compensation_ledger_entry_id IS NULL AND t.starts_at<=NEW.created_at AND t.ends_at>NEW.created_at) OR EXISTS(SELECT 1 FROM package_referral_bonus_grants t JOIN package_referral_bonus_segments z ON z.bonus_grant_id=t.bonus_grant_id WHERE t.bonus_grant_id=NEW.target_package_bonus_grant_id AND t.beneficiary_telegram_id=NEW.beneficiary_telegram_id AND t.plan_code=NEW.plan_code AND t.grant_status='applied' AND t.compensation_ledger_entry_id IS NULL AND z.starts_at<=NEW.created_at AND z.ends_at>NEW.created_at)))))
BEGIN SELECT RAISE(ABORT,'package_referral_bonus_invariant'); END;
CREATE TRIGGER IF NOT EXISTS v144_package_bonus_segment_binding BEFORE INSERT ON package_referral_bonus_segments
WHEN NOT EXISTS(SELECT 1 FROM package_referral_bonus_grants g WHERE g.bonus_grant_id=NEW.bonus_grant_id AND g.grant_status IN ('pending','claimable') AND g.plan_code=NEW.plan_code AND NEW.recorded_at>=g.created_at AND NEW.starts_at>=NEW.recorded_at AND NEW.segment_index=(SELECT COUNT(*) FROM package_referral_bonus_segments z WHERE z.bonus_grant_id=g.bonus_grant_id) AND NEW.starts_at>=COALESCE((SELECT MAX(ends_at) FROM package_referral_bonus_segments z WHERE z.bonus_grant_id=g.bonus_grant_id),NEW.starts_at) AND NEW.seconds+COALESCE((SELECT SUM(seconds) FROM package_referral_bonus_segments z WHERE z.bonus_grant_id=g.bonus_grant_id),0)<=259200 AND (( g.reward_kind='legacy' AND EXISTS(SELECT 1 FROM referral_rewards r JOIN referral_reward_candidates c ON c.candidate_id=r.candidate_id JOIN subscription_access_grants source_g ON source_g.grant_id=c.source_access_grant_id JOIN payment_ledger p ON p.ledger_entry_id=c.source_payment_ledger_entry_id WHERE r.reward_id=g.legacy_reward_id AND r.program_code=g.program_code AND r.reward_status='confirmed' AND r.beneficiary_telegram_id=g.beneficiary_telegram_id AND r.confirmed_at=g.available_at AND p.ledger_entry_id=g.source_payment_ledger_entry_id AND p.entry_type='payment' AND p.direction='credit' AND p.currency='XTR' AND source_g.payment_ledger_entry_id=p.ledger_entry_id AND source_g.order_id=c.source_order_id AND source_g.status='active')) OR (g.reward_kind='package' AND EXISTS(SELECT 1 FROM package_referral_rewards r JOIN package_referral_candidates c ON c.candidate_id=r.candidate_id JOIN subscription_package_periods source_g ON source_g.period_id=c.source_package_period_id JOIN payment_ledger p ON p.ledger_entry_id=c.source_payment_ledger_entry_id WHERE r.reward_id=g.package_reward_id AND r.program_code=g.program_code AND r.reward_status='confirmed' AND r.beneficiary_telegram_id=g.beneficiary_telegram_id AND r.confirmed_at=g.available_at AND p.ledger_entry_id=g.source_payment_ledger_entry_id AND p.entry_type='payment' AND p.direction='credit' AND p.currency='XTR' AND source_g.payment_ledger_entry_id=p.ledger_entry_id AND source_g.order_id=c.source_order_id))) AND NOT EXISTS(SELECT 1 FROM payment_ledger x WHERE x.related_ledger_entry_id=g.source_payment_ledger_entry_id AND x.entry_type IN ('refund','chargeback'))) OR EXISTS(SELECT 1 FROM package_referral_bonus_grants g JOIN subscription_package_periods p ON p.telegram_id=g.beneficiary_telegram_id WHERE g.bonus_grant_id=NEW.bonus_grant_id AND p.starts_at<NEW.ends_at AND p.ends_at>NEW.starts_at AND NOT EXISTS(SELECT 1 FROM payment_ledger x WHERE x.related_ledger_entry_id=p.payment_ledger_entry_id AND x.entry_type IN ('refund','chargeback'))) OR EXISTS(SELECT 1 FROM package_referral_bonus_grants g JOIN subscriptions t ON t.telegram_id=g.beneficiary_telegram_id WHERE g.bonus_grant_id=NEW.bonus_grant_id AND t.status IN ('active','cancel_at_period_end','suspended') AND t.current_period_start<NEW.ends_at AND t.current_period_end>NEW.starts_at) OR EXISTS(SELECT 1 FROM package_referral_bonus_grants g JOIN package_referral_bonus_grants h ON h.beneficiary_telegram_id=g.beneficiary_telegram_id JOIN package_referral_bonus_segments z ON z.bonus_grant_id=h.bonus_grant_id WHERE g.bonus_grant_id=NEW.bonus_grant_id AND h.grant_status='applied' AND z.starts_at<NEW.ends_at AND z.ends_at>NEW.starts_at) OR EXISTS(SELECT 1 FROM package_referral_bonus_grants g JOIN bonus_access_grants h ON h.beneficiary_telegram_id=g.beneficiary_telegram_id WHERE g.bonus_grant_id=NEW.bonus_grant_id AND h.grant_status='applied' AND h.starts_at<NEW.ends_at AND h.ends_at>NEW.starts_at)
BEGIN SELECT RAISE(ABORT,'package_referral_bonus_invariant'); END;
CREATE TRIGGER IF NOT EXISTS v144_package_bonus_effect_binding BEFORE INSERT ON package_referral_bonus_effects
WHEN NOT EXISTS(SELECT 1 FROM package_referral_bonus_grants g WHERE g.bonus_grant_id=NEW.bonus_grant_id AND g.grant_status IN ('pending','claimable') AND NEW.reward_kind IS g.reward_kind AND NEW.reward_id IS g.reward_id AND NEW.beneficiary_telegram_id IS g.beneficiary_telegram_id AND NEW.plan_code IS g.plan_code AND NEW.source_payment_ledger_entry_id IS g.source_payment_ledger_entry_id AND NEW.target_source_kind IS g.target_source_kind AND NEW.target_subscription_id IS g.target_subscription_id AND NEW.target_package_period_id IS g.target_package_period_id AND NEW.target_payment_ledger_entry_id IS g.target_payment_ledger_entry_id AND NEW.target_legacy_bonus_grant_id IS g.target_legacy_bonus_grant_id AND NEW.target_package_bonus_grant_id IS g.target_package_bonus_grant_id AND NEW.recorded_at>=g.created_at AND NEW.allocation_anchor_at>=NEW.recorded_at AND ((g.delivery_mode='manual_claim' AND NEW.effect_kind='manual_professional_access') OR (g.delivery_mode='extend_active_plan' AND NEW.effect_kind='paid_plan_extension')) AND (SELECT SUM(seconds) FROM package_referral_bonus_segments z WHERE z.bonus_grant_id=g.bonus_grant_id)=259200 AND (SELECT MIN(starts_at) FROM package_referral_bonus_segments z WHERE z.bonus_grant_id=g.bonus_grant_id)>=NEW.allocation_anchor_at AND NOT EXISTS(SELECT 1 FROM package_referral_bonus_segments z WHERE z.bonus_grant_id=g.bonus_grant_id AND (z.plan_code!=NEW.plan_code OR z.recorded_at!=NEW.recorded_at)) AND json_extract(NEW.allocation_json,'$.version')=1 AND json_extract(NEW.allocation_json,'$.planCode')=NEW.plan_code AND json_extract(NEW.allocation_json,'$.anchorAt')=NEW.allocation_anchor_at AND json_extract(NEW.allocation_json,'$.appliedAt')=NEW.recorded_at AND (( g.reward_kind='legacy' AND EXISTS(SELECT 1 FROM referral_rewards r JOIN referral_reward_candidates c ON c.candidate_id=r.candidate_id JOIN subscription_access_grants source_g ON source_g.grant_id=c.source_access_grant_id JOIN payment_ledger p ON p.ledger_entry_id=c.source_payment_ledger_entry_id WHERE r.reward_id=g.legacy_reward_id AND r.program_code=g.program_code AND r.reward_status='confirmed' AND r.beneficiary_telegram_id=g.beneficiary_telegram_id AND r.confirmed_at=g.available_at AND p.ledger_entry_id=g.source_payment_ledger_entry_id AND p.entry_type='payment' AND p.direction='credit' AND p.currency='XTR' AND source_g.payment_ledger_entry_id=p.ledger_entry_id AND source_g.order_id=c.source_order_id AND source_g.status='active')) OR (g.reward_kind='package' AND EXISTS(SELECT 1 FROM package_referral_rewards r JOIN package_referral_candidates c ON c.candidate_id=r.candidate_id JOIN subscription_package_periods source_g ON source_g.period_id=c.source_package_period_id JOIN payment_ledger p ON p.ledger_entry_id=c.source_payment_ledger_entry_id WHERE r.reward_id=g.package_reward_id AND r.program_code=g.program_code AND r.reward_status='confirmed' AND r.beneficiary_telegram_id=g.beneficiary_telegram_id AND r.confirmed_at=g.available_at AND p.ledger_entry_id=g.source_payment_ledger_entry_id AND p.entry_type='payment' AND p.direction='credit' AND p.currency='XTR' AND source_g.payment_ledger_entry_id=p.ledger_entry_id AND source_g.order_id=c.source_order_id))) AND NOT EXISTS(SELECT 1 FROM payment_ledger x WHERE x.related_ledger_entry_id=g.source_payment_ledger_entry_id AND x.entry_type IN ('refund','chargeback')) AND (NEW.target_source_kind='none' OR (NEW.target_source_kind='subscription' AND EXISTS(SELECT 1 FROM subscriptions t JOIN payment_ledger p ON p.ledger_entry_id=NEW.target_payment_ledger_entry_id JOIN subscription_access_grants g ON g.payment_ledger_entry_id=p.ledger_entry_id WHERE t.subscription_id=NEW.target_subscription_id AND t.telegram_id=NEW.beneficiary_telegram_id AND t.plan_code=NEW.plan_code AND t.status IN ('active','cancel_at_period_end') AND (t.current_period_start<=NEW.recorded_at OR (t.billing_mode='recurring' AND g.starts_at=t.current_period_start AND p.occurred_at<=NEW.recorded_at AND p.occurred_at<=g.starts_at AND g.starts_at-p.occurred_at<=86400 AND EXISTS(SELECT 1 FROM subscription_first_recurring_receipts first_receipt JOIN subscription_payment_links first_link ON first_link.operation_id=first_receipt.operation_id JOIN subscription_billing_contracts first_contract ON first_contract.contract_id=first_link.contract_id WHERE first_receipt.contract_id=first_contract.contract_id AND first_contract.first_payment_ledger_entry_id=p.ledger_entry_id AND first_link.ledger_entry_id=p.ledger_entry_id AND first_link.applied_order_id=g.order_id AND first_link.direction='incoming' AND first_link.link_kind='recurring_charge' AND first_link.telegram_id=t.telegram_id AND first_contract.telegram_id=t.telegram_id AND first_link.plan_code=t.plan_code AND first_contract.plan_code=t.plan_code AND first_link.provider_charge_id=p.telegram_payment_charge_id AND first_link.provider_period_start=g.starts_at AND first_link.provider_period_end=g.ends_at AND first_link.external_invoice_payload=first_contract.external_invoice_payload AND first_link.external_payload_sha256=first_contract.external_payload_sha256 AND first_link.evidence_sha256=first_receipt.evidence_sha256 AND p.currency=first_contract.currency AND p.amount_stars=first_contract.amount_stars AND p.occurred_at=first_link.occurred_at AND p.occurred_at>=first_contract.created_at AND p.occurred_at<=p.recorded_at AND p.recorded_at<=NEW.recorded_at AND p.occurred_at<=first_link.recorded_at AND first_link.recorded_at<=first_receipt.verified_at AND first_receipt.verified_at<=NEW.recorded_at))) AND t.current_period_end>NEW.recorded_at AND p.telegram_id=t.telegram_id AND p.order_id=g.order_id AND p.entry_type='payment' AND p.direction='credit' AND g.subscription_id=t.subscription_id AND g.telegram_id=t.telegram_id AND g.status='active' AND g.plan_code=t.plan_code AND NOT EXISTS(SELECT 1 FROM payment_ledger x WHERE x.related_ledger_entry_id=p.ledger_entry_id AND x.entry_type IN ('refund','chargeback')) AND NEW.allocation_anchor_at>=t.current_period_end)) OR (NEW.target_source_kind='package' AND EXISTS(SELECT 1 FROM subscription_package_periods t WHERE t.period_id=NEW.target_package_period_id AND t.payment_ledger_entry_id=NEW.target_payment_ledger_entry_id AND t.telegram_id=NEW.beneficiary_telegram_id AND t.plan_code=NEW.plan_code AND t.starts_at<=NEW.recorded_at AND t.ends_at>NEW.recorded_at AND t.recorded_at<=NEW.recorded_at AND NOT EXISTS(SELECT 1 FROM payment_ledger x WHERE x.related_ledger_entry_id=t.payment_ledger_entry_id AND x.entry_type IN ('refund','chargeback')) AND NEW.allocation_anchor_at>=t.ends_at)) OR (NEW.target_source_kind='earned' AND (EXISTS(SELECT 1 FROM bonus_access_grants t WHERE t.bonus_grant_id=NEW.target_legacy_bonus_grant_id AND t.beneficiary_telegram_id=NEW.beneficiary_telegram_id AND t.plan_code=NEW.plan_code AND t.grant_status='applied' AND t.compensation_ledger_entry_id IS NULL AND t.starts_at<=NEW.recorded_at AND t.ends_at>NEW.recorded_at AND NEW.allocation_anchor_at>=t.ends_at) OR EXISTS(SELECT 1 FROM package_referral_bonus_grants t JOIN package_referral_bonus_segments z ON z.bonus_grant_id=t.bonus_grant_id WHERE t.bonus_grant_id=NEW.target_package_bonus_grant_id AND t.beneficiary_telegram_id=NEW.beneficiary_telegram_id AND t.plan_code=NEW.plan_code AND t.grant_status='applied' AND t.compensation_ledger_entry_id IS NULL AND z.starts_at<=NEW.recorded_at AND z.ends_at>NEW.recorded_at AND NEW.allocation_anchor_at>=z.ends_at)))))
BEGIN SELECT RAISE(ABORT,'package_referral_bonus_invariant'); END;
CREATE TRIGGER IF NOT EXISTS v144_package_bonus_transition_binding BEFORE INSERT ON package_referral_bonus_transitions
WHEN NOT EXISTS(SELECT 1 FROM package_referral_bonus_grants g WHERE g.bonus_grant_id=NEW.bonus_grant_id AND NEW.recorded_at>=g.updated_at AND NEW.occurred_at>=g.created_at AND ((NEW.from_status='none' AND NEW.from_revision=0 AND NEW.to_revision=1 AND g.revision=1 AND NEW.to_status=g.grant_status AND NEW.reason_code='grant_created' AND NEW.actor_type='system' AND NEW.related_payment_ledger_entry_id=g.source_payment_ledger_entry_id AND NEW.occurred_at=g.created_at AND NEW.recorded_at=g.created_at AND NEW.compensated_seconds=0) OR (NEW.from_status=g.grant_status AND NEW.from_revision=g.revision AND NEW.to_status='applied' AND NEW.compensated_seconds=0 AND NEW.related_payment_ledger_entry_id=g.source_payment_ledger_entry_id AND EXISTS(SELECT 1 FROM package_referral_bonus_effects e WHERE e.bonus_grant_id=g.bonus_grant_id AND e.applied_transition_id=NEW.transition_id AND e.recorded_at=NEW.recorded_at AND e.recorded_at=NEW.occurred_at) AND (SELECT SUM(seconds) FROM package_referral_bonus_segments z WHERE z.bonus_grant_id=g.bonus_grant_id)=259200 AND ((g.grant_status='pending' AND g.delivery_mode='extend_active_plan' AND NEW.reason_code='active_plan_extension' AND NEW.actor_type='system') OR (g.grant_status='claimable' AND g.delivery_mode='manual_claim' AND NEW.reason_code='manual_claim' AND NEW.actor_type='telegram' AND NEW.actor_id=g.beneficiary_telegram_id AND NEW.occurred_at BETWEEN g.available_at AND g.claim_expires_at)) AND (( g.reward_kind='legacy' AND EXISTS(SELECT 1 FROM referral_rewards r JOIN referral_reward_candidates c ON c.candidate_id=r.candidate_id JOIN subscription_access_grants source_g ON source_g.grant_id=c.source_access_grant_id JOIN payment_ledger p ON p.ledger_entry_id=c.source_payment_ledger_entry_id WHERE r.reward_id=g.legacy_reward_id AND r.program_code=g.program_code AND r.reward_status='confirmed' AND r.beneficiary_telegram_id=g.beneficiary_telegram_id AND r.confirmed_at=g.available_at AND p.ledger_entry_id=g.source_payment_ledger_entry_id AND p.entry_type='payment' AND p.direction='credit' AND p.currency='XTR' AND source_g.payment_ledger_entry_id=p.ledger_entry_id AND source_g.order_id=c.source_order_id AND source_g.status='active')) OR (g.reward_kind='package' AND EXISTS(SELECT 1 FROM package_referral_rewards r JOIN package_referral_candidates c ON c.candidate_id=r.candidate_id JOIN subscription_package_periods source_g ON source_g.period_id=c.source_package_period_id JOIN payment_ledger p ON p.ledger_entry_id=c.source_payment_ledger_entry_id WHERE r.reward_id=g.package_reward_id AND r.program_code=g.program_code AND r.reward_status='confirmed' AND r.beneficiary_telegram_id=g.beneficiary_telegram_id AND r.confirmed_at=g.available_at AND p.ledger_entry_id=g.source_payment_ledger_entry_id AND p.entry_type='payment' AND p.direction='credit' AND p.currency='XTR' AND source_g.payment_ledger_entry_id=p.ledger_entry_id AND source_g.order_id=c.source_order_id))) AND NOT EXISTS(SELECT 1 FROM payment_ledger x WHERE x.related_ledger_entry_id=g.source_payment_ledger_entry_id AND x.entry_type IN ('refund','chargeback'))) OR (NEW.from_status=g.grant_status AND NEW.from_revision=g.revision AND g.grant_status='claimable' AND NEW.to_status='expired' AND NEW.reason_code='claim_window_expired' AND NEW.actor_type='system' AND NEW.related_payment_ledger_entry_id=g.source_payment_ledger_entry_id AND NEW.occurred_at>g.claim_expires_at AND NEW.compensated_seconds=0 AND NOT EXISTS(SELECT 1 FROM package_referral_bonus_effects e WHERE e.bonus_grant_id=g.bonus_grant_id)) OR (NEW.from_status=g.grant_status AND NEW.from_revision=g.revision AND EXISTS(SELECT 1 FROM payment_ledger x JOIN payment_ledger p ON p.ledger_entry_id=g.source_payment_ledger_entry_id WHERE x.ledger_entry_id=NEW.related_payment_ledger_entry_id AND x.related_ledger_entry_id=p.ledger_entry_id AND x.order_id=p.order_id AND x.telegram_id=p.telegram_id AND x.currency=p.currency AND x.amount_stars=p.amount_stars AND x.telegram_payment_charge_id=p.telegram_payment_charge_id AND x.entry_type=NEW.reason_code AND x.entry_type IN ('refund','chargeback') AND x.direction='debit' AND x.recorded_at<=NEW.recorded_at AND x.occurred_at<=NEW.occurred_at) AND NEW.actor_type='system' AND ((g.grant_status IN ('pending','claimable') AND NEW.to_status='revoked' AND NEW.compensated_seconds=259200) OR (g.grant_status='applied' AND g.starts_at>NEW.occurred_at AND NEW.to_status='revoked' AND NEW.compensated_seconds=259200) OR (g.grant_status='applied' AND g.starts_at<=NEW.occurred_at AND NEW.to_status='manual_review' AND NEW.compensated_seconds=0)))))
BEGIN SELECT RAISE(ABORT,'package_referral_bonus_invariant'); END;
CREATE TRIGGER IF NOT EXISTS v144_package_bonus_initial_transition AFTER INSERT ON package_referral_bonus_grants
BEGIN INSERT INTO package_referral_bonus_transitions(transition_id,transition_key,bonus_grant_id,from_status,to_status,from_revision,to_revision,reason_code,actor_type,actor_id,related_payment_ledger_entry_id,compensated_seconds,occurred_at,recorded_at) VALUES('initial:'||NEW.bonus_grant_id,'initial:'||NEW.bonus_grant_id,NEW.bonus_grant_id,'none',NEW.grant_status,0,1,'grant_created','system',NULL,NEW.source_payment_ledger_entry_id,0,NEW.created_at,NEW.created_at); END;
CREATE TRIGGER IF NOT EXISTS v144_package_bonus_transition_apply AFTER INSERT ON package_referral_bonus_transitions
BEGIN UPDATE package_referral_bonus_grants SET grant_status=NEW.to_status,revision=NEW.to_revision,last_transition_id=NEW.transition_id,updated_at=NEW.recorded_at,
 claimed_at=CASE WHEN NEW.to_status='applied' AND delivery_mode='manual_claim' THEN NEW.occurred_at ELSE claimed_at END,
 applied_at=CASE WHEN NEW.to_status='applied' THEN NEW.recorded_at ELSE applied_at END,
 starts_at=CASE WHEN NEW.to_status='applied' THEN (SELECT MIN(starts_at) FROM package_referral_bonus_segments WHERE bonus_grant_id=NEW.bonus_grant_id) ELSE starts_at END,
 ends_at=CASE WHEN NEW.to_status='applied' THEN (SELECT MAX(ends_at) FROM package_referral_bonus_segments WHERE bonus_grant_id=NEW.bonus_grant_id) ELSE ends_at END,
 allocation_anchor_at=CASE WHEN NEW.to_status='applied' THEN (SELECT allocation_anchor_at FROM package_referral_bonus_effects WHERE bonus_grant_id=NEW.bonus_grant_id) ELSE allocation_anchor_at END,
 allocation_fingerprint=CASE WHEN NEW.to_status='applied' THEN (SELECT allocation_fingerprint FROM package_referral_bonus_effects WHERE bonus_grant_id=NEW.bonus_grant_id) ELSE allocation_fingerprint END,
 compensation_ledger_entry_id=CASE WHEN NEW.to_status IN ('revoked','manual_review') THEN NEW.related_payment_ledger_entry_id ELSE compensation_ledger_entry_id END,
 compensated_seconds=CASE WHEN NEW.to_status IN ('revoked','manual_review') THEN NEW.compensated_seconds ELSE compensated_seconds END,
 compensated_at=CASE WHEN NEW.to_status IN ('revoked','manual_review') THEN NEW.recorded_at ELSE compensated_at END WHERE bonus_grant_id=NEW.bonus_grant_id; END;
CREATE TRIGGER IF NOT EXISTS v144_package_bonus_identity BEFORE UPDATE ON package_referral_bonus_grants
WHEN NEW.bonus_grant_id IS NOT OLD.bonus_grant_id OR NEW.grant_key IS NOT OLD.grant_key OR NEW.program_code IS NOT OLD.program_code OR NEW.reward_kind IS NOT OLD.reward_kind OR NEW.reward_id IS NOT OLD.reward_id OR NEW.legacy_reward_id IS NOT OLD.legacy_reward_id OR NEW.package_reward_id IS NOT OLD.package_reward_id OR NEW.beneficiary_telegram_id IS NOT OLD.beneficiary_telegram_id OR NEW.delivery_mode IS NOT OLD.delivery_mode OR NEW.plan_code IS NOT OLD.plan_code OR NEW.bonus_seconds IS NOT OLD.bonus_seconds OR NEW.available_at IS NOT OLD.available_at OR NEW.claim_expires_at IS NOT OLD.claim_expires_at OR NEW.target_source_kind IS NOT OLD.target_source_kind OR NEW.target_subscription_id IS NOT OLD.target_subscription_id OR NEW.target_package_period_id IS NOT OLD.target_package_period_id OR NEW.target_payment_ledger_entry_id IS NOT OLD.target_payment_ledger_entry_id OR NEW.target_legacy_bonus_grant_id IS NOT OLD.target_legacy_bonus_grant_id OR NEW.target_package_bonus_grant_id IS NOT OLD.target_package_bonus_grant_id OR NEW.source_payment_ledger_entry_id IS NOT OLD.source_payment_ledger_entry_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'package_referral_bonus_invariant'); END;
CREATE TRIGGER IF NOT EXISTS v144_package_bonus_projection BEFORE UPDATE ON package_referral_bonus_grants
WHEN NOT EXISTS(SELECT 1 FROM package_referral_bonus_transitions t WHERE t.transition_id=NEW.last_transition_id AND t.bonus_grant_id=OLD.bonus_grant_id AND NEW.grant_status=t.to_status AND NEW.revision=t.to_revision AND NEW.updated_at=t.recorded_at AND NEW.last_transition_id IS NOT OLD.last_transition_id AND ((t.from_status='none' AND OLD.last_transition_id IS NULL AND OLD.revision=1 AND t.from_revision=0 AND t.to_revision=1) OR (t.from_status=OLD.grant_status AND t.from_revision=OLD.revision AND t.to_revision=OLD.revision+1)) AND NEW.claimed_at IS (CASE WHEN t.to_status='applied' AND OLD.delivery_mode='manual_claim' THEN t.occurred_at ELSE OLD.claimed_at END) AND NEW.applied_at IS (CASE WHEN t.to_status='applied' THEN t.recorded_at ELSE OLD.applied_at END) AND NEW.starts_at IS (CASE WHEN t.to_status='applied' THEN (SELECT MIN(starts_at) FROM package_referral_bonus_segments WHERE bonus_grant_id=OLD.bonus_grant_id) ELSE OLD.starts_at END) AND NEW.ends_at IS (CASE WHEN t.to_status='applied' THEN (SELECT MAX(ends_at) FROM package_referral_bonus_segments WHERE bonus_grant_id=OLD.bonus_grant_id) ELSE OLD.ends_at END) AND NEW.allocation_anchor_at IS (CASE WHEN t.to_status='applied' THEN (SELECT allocation_anchor_at FROM package_referral_bonus_effects WHERE bonus_grant_id=OLD.bonus_grant_id) ELSE OLD.allocation_anchor_at END) AND NEW.allocation_fingerprint IS (CASE WHEN t.to_status='applied' THEN (SELECT allocation_fingerprint FROM package_referral_bonus_effects WHERE bonus_grant_id=OLD.bonus_grant_id) ELSE OLD.allocation_fingerprint END) AND NEW.compensation_ledger_entry_id IS (CASE WHEN t.to_status IN ('revoked','manual_review') THEN t.related_payment_ledger_entry_id ELSE OLD.compensation_ledger_entry_id END) AND NEW.compensated_seconds IS (CASE WHEN t.to_status IN ('revoked','manual_review') THEN t.compensated_seconds ELSE OLD.compensated_seconds END) AND NEW.compensated_at IS (CASE WHEN t.to_status IN ('revoked','manual_review') THEN t.recorded_at ELSE OLD.compensated_at END))
BEGIN SELECT RAISE(ABORT,'package_referral_bonus_invariant'); END;
CREATE TRIGGER IF NOT EXISTS v144_package_bonus_reversal_binding BEFORE INSERT ON package_referral_bonus_reversals
WHEN NOT EXISTS(SELECT 1 FROM package_referral_bonus_grants g JOIN package_referral_bonus_effects e ON e.bonus_grant_id=g.bonus_grant_id JOIN package_referral_bonus_transitions t ON t.transition_id=g.last_transition_id JOIN payment_ledger x ON x.ledger_entry_id=t.related_payment_ledger_entry_id WHERE g.bonus_grant_id=NEW.bonus_grant_id AND e.effect_id=NEW.effect_id AND g.grant_status='revoked' AND t.from_status='applied' AND t.to_status='revoked' AND t.transition_id=NEW.reversal_transition_id AND x.ledger_entry_id=NEW.compensation_ledger_entry_id AND x.related_ledger_entry_id=g.source_payment_ledger_entry_id AND NEW.compensated_seconds=259200 AND t.compensated_seconds=259200 AND NEW.occurred_at=x.occurred_at AND NEW.recorded_at=t.recorded_at)
BEGIN SELECT RAISE(ABORT,'package_referral_bonus_invariant'); END;
CREATE TRIGGER IF NOT EXISTS v144_bonus_segments_no_update BEFORE UPDATE ON package_referral_bonus_segments
BEGIN SELECT RAISE(ABORT,'package_referral_bonus_invariant'); END;
CREATE TRIGGER IF NOT EXISTS v144_bonus_segments_no_delete BEFORE DELETE ON package_referral_bonus_segments
BEGIN SELECT RAISE(ABORT,'package_referral_bonus_invariant'); END;
CREATE TRIGGER IF NOT EXISTS v144_bonus_effects_no_update BEFORE UPDATE ON package_referral_bonus_effects
BEGIN SELECT RAISE(ABORT,'package_referral_bonus_invariant'); END;
CREATE TRIGGER IF NOT EXISTS v144_bonus_effects_no_delete BEFORE DELETE ON package_referral_bonus_effects
BEGIN SELECT RAISE(ABORT,'package_referral_bonus_invariant'); END;
CREATE TRIGGER IF NOT EXISTS v144_bonus_transitions_no_update BEFORE UPDATE ON package_referral_bonus_transitions
BEGIN SELECT RAISE(ABORT,'package_referral_bonus_invariant'); END;
CREATE TRIGGER IF NOT EXISTS v144_bonus_transitions_no_delete BEFORE DELETE ON package_referral_bonus_transitions
BEGIN SELECT RAISE(ABORT,'package_referral_bonus_invariant'); END;
CREATE TRIGGER IF NOT EXISTS v144_bonus_reversals_no_update BEFORE UPDATE ON package_referral_bonus_reversals
BEGIN SELECT RAISE(ABORT,'package_referral_bonus_invariant'); END;
CREATE TRIGGER IF NOT EXISTS v144_bonus_reversals_no_delete BEFORE DELETE ON package_referral_bonus_reversals
BEGIN SELECT RAISE(ABORT,'package_referral_bonus_invariant'); END;
CREATE TRIGGER IF NOT EXISTS v144_package_bonus_no_delete BEFORE DELETE ON package_referral_bonus_grants
BEGIN SELECT RAISE(ABORT,'package_referral_bonus_invariant'); END;
CREATE INDEX IF NOT EXISTS idx_v144_package_bonus_claimable ON package_referral_bonus_grants(grant_status,claim_expires_at,bonus_grant_id);
CREATE INDEX IF NOT EXISTS idx_v144_package_bonus_beneficiary ON package_referral_bonus_grants(beneficiary_telegram_id,grant_status,created_at,bonus_grant_id);
CREATE INDEX IF NOT EXISTS idx_v144_package_bonus_segments ON package_referral_bonus_segments(starts_at,ends_at,bonus_grant_id);
INSERT OR IGNORE INTO re_schema_migrations(version) VALUES('1.4.4-package-referral-compatibility');
