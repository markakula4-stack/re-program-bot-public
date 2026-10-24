-- RE Program Bot v1.3.7 Part 3 — referral reward protection Workflow.
-- Additive and idempotent. This migration records durable Workflow jobs and
-- immutable payment rechecks. It does not grant bonus access, change the
-- production entrypoint, add production bindings or enable rollout.

CREATE TABLE IF NOT EXISTS referral_reward_protection_jobs (
  protection_job_id TEXT PRIMARY KEY CHECK (length(protection_job_id) = 36),
  job_key TEXT NOT NULL UNIQUE CHECK (length(job_key) BETWEEN 16 AND 160),
  reward_id TEXT NOT NULL UNIQUE REFERENCES referral_rewards(reward_id),
  candidate_id TEXT NOT NULL UNIQUE
    REFERENCES referral_reward_candidates(candidate_id),
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
    REFERENCES referral_reward_transitions(transition_id),
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

CREATE INDEX IF NOT EXISTS idx_referral_protection_jobs_repair
  ON referral_reward_protection_jobs(
    workflow_state, scheduled_for, protection_job_id
  );

CREATE TABLE IF NOT EXISTS referral_reward_protection_checks (
  protection_check_id TEXT PRIMARY KEY
    CHECK (length(protection_check_id) = 36),
  check_key TEXT NOT NULL UNIQUE CHECK (length(check_key) BETWEEN 16 AND 160),
  reward_id TEXT NOT NULL REFERENCES referral_rewards(reward_id),
  candidate_id TEXT NOT NULL REFERENCES referral_reward_candidates(candidate_id),
  reward_revision INTEGER NOT NULL CHECK (reward_revision > 0),
  decision TEXT NOT NULL CHECK (decision IN ('confirm', 'cancel')),
  reason_code TEXT NOT NULL
    CHECK (reason_code IN ('hold_elapsed', 'refund', 'chargeback')),
  source_payment_ledger_entry_id TEXT NOT NULL
    REFERENCES payment_ledger(ledger_entry_id),
  source_access_grant_id TEXT NOT NULL
    REFERENCES subscription_access_grants(grant_id),
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

CREATE INDEX IF NOT EXISTS idx_referral_protection_checks_reward
  ON referral_reward_protection_checks(
    reward_id, checked_at, protection_check_id
  );

CREATE INDEX IF NOT EXISTS idx_referral_protection_checks_payment
  ON referral_reward_protection_checks(
    source_payment_ledger_entry_id, checked_at, protection_check_id
  );

CREATE TRIGGER IF NOT EXISTS trg_referral_protection_jobs_insert_guard
BEFORE INSERT ON referral_reward_protection_jobs
WHEN NOT EXISTS (
  SELECT 1
  FROM referral_rewards reward
  JOIN referral_reward_candidates candidate
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

CREATE TRIGGER IF NOT EXISTS trg_referral_protection_jobs_identity_immutable
BEFORE UPDATE ON referral_reward_protection_jobs
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

CREATE TRIGGER IF NOT EXISTS trg_referral_protection_jobs_state_guard
BEFORE UPDATE OF workflow_state ON referral_reward_protection_jobs
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

CREATE TRIGGER IF NOT EXISTS trg_referral_protection_jobs_completed_immutable
BEFORE UPDATE ON referral_reward_protection_jobs
WHEN OLD.workflow_state = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'completed protection job is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_protection_jobs_completion_guard
BEFORE UPDATE ON referral_reward_protection_jobs
WHEN NEW.workflow_state = 'completed' AND NOT EXISTS (
  SELECT 1
  FROM referral_rewards reward
  JOIN referral_reward_transitions transition
    ON transition.transition_id = NEW.settled_transition_id
  JOIN referral_reward_protection_checks protection_check
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

CREATE TRIGGER IF NOT EXISTS trg_referral_protection_jobs_no_delete
BEFORE DELETE ON referral_reward_protection_jobs
BEGIN
  SELECT RAISE(ABORT, 'protection jobs cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_protection_checks_confirm_guard
BEFORE INSERT ON referral_reward_protection_checks
WHEN NEW.decision = 'confirm' AND NOT EXISTS (
  SELECT 1
  FROM referral_rewards reward
  JOIN referral_reward_candidates candidate
    ON candidate.candidate_id = reward.candidate_id
  JOIN subscription_orders orders
    ON orders.order_id = candidate.source_order_id
  JOIN payment_ledger payment
    ON payment.ledger_entry_id = candidate.source_payment_ledger_entry_id
  JOIN subscription_access_grants source_access
    ON source_access.grant_id = candidate.source_access_grant_id
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
    AND candidate.source_access_grant_id = NEW.source_access_grant_id
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
    AND source_access.status = 'active'
    AND reconciliation.status IN ('completed', 'manual_review')
    AND reconciliation.started_at >= reward.confirm_after
    AND reconciliation.finished_at IS NOT NULL
    AND reconciliation.finished_at <= NEW.recorded_at
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

CREATE TRIGGER IF NOT EXISTS trg_referral_protection_checks_cancel_guard
BEFORE INSERT ON referral_reward_protection_checks
WHEN NEW.decision = 'cancel' AND NOT EXISTS (
  SELECT 1
  FROM referral_rewards reward
  JOIN referral_reward_candidates candidate
    ON candidate.candidate_id = reward.candidate_id
  JOIN payment_ledger compensation
    ON compensation.ledger_entry_id = NEW.compensation_ledger_entry_id
  WHERE reward.reward_id = NEW.reward_id
    AND reward.candidate_id = NEW.candidate_id
    AND reward.reward_status = 'pending'
    AND reward.revision = NEW.reward_revision
    AND candidate.source_payment_ledger_entry_id =
      NEW.source_payment_ledger_entry_id
    AND candidate.source_access_grant_id = NEW.source_access_grant_id
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

CREATE TRIGGER IF NOT EXISTS trg_referral_protection_checks_immutable_update
BEFORE UPDATE ON referral_reward_protection_checks
BEGIN
  SELECT RAISE(ABORT, 'protection checks are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_protection_checks_immutable_delete
BEFORE DELETE ON referral_reward_protection_checks
BEGIN
  SELECT RAISE(ABORT, 'protection checks are append-only');
END;

-- Part 3 requires a matching immutable recheck before an automated Workflow
-- may confirm or cancel a pending reward. Part 1 admin corrections remain
-- available and keep their own author/reason audit contract.
CREATE TRIGGER IF NOT EXISTS trg_referral_transitions_protection_check_guard
BEFORE INSERT ON referral_reward_transitions
WHEN NEW.transition_scope = 'reward'
  AND NEW.from_status = 'pending'
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
    FROM referral_reward_protection_checks protection_check
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

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.7-referral-protection-workflow');
