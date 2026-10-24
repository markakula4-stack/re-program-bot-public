-- RE Program Bot v1.3.7 Part 5 — referral reward UX and operations.
-- Additive and idempotent. This migration creates a durable, privacy-minimal
-- notification outbox sourced only from immutable reward transitions. It does
-- not switch the production entrypoint, add production flags or enable rollout.

CREATE TABLE IF NOT EXISTS referral_reward_notice_jobs (
  notice_key TEXT PRIMARY KEY
    CHECK (length(notice_key) BETWEEN 24 AND 180),
  source_event_key TEXT NOT NULL UNIQUE
    CHECK (length(source_event_key) BETWEEN 20 AND 180),
  source_transition_id TEXT UNIQUE
    REFERENCES referral_reward_transitions(transition_id),
  source_expiry_event_id TEXT UNIQUE
    REFERENCES bonus_access_expiry_events(expiry_event_id),
  reward_id TEXT NOT NULL REFERENCES referral_rewards(reward_id),
  bonus_grant_id TEXT REFERENCES bonus_access_grants(bonus_grant_id),
  recipient_telegram_id INTEGER NOT NULL
    CHECK (recipient_telegram_id > 0),
  notice_type TEXT NOT NULL CHECK (notice_type IN (
    'pending_review', 'reward_confirmed', 'bonus_claimable',
    'bonus_applied', 'reward_cancelled', 'claim_window_expired',
    'bonus_access_ended', 'bonus_manual_review'
  )),
  delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN (
    'pending', 'processing', 'retry', 'delivered', 'suppressed',
    'manual_review'
  )),
  not_before INTEGER NOT NULL CHECK (not_before > 0),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= not_before),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 10),
  lease_token TEXT,
  lease_expires_at INTEGER,
  last_attempt_at INTEGER,
  inbox_recorded_at INTEGER,
  delivered_at INTEGER,
  last_error_code TEXT NOT NULL DEFAULT ''
    CHECK (length(last_error_code) <= 64),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (reward_id, notice_type),
  CHECK (
    (notice_type IN ('pending_review', 'reward_confirmed', 'reward_cancelled')
      AND bonus_grant_id IS NULL)
    OR
    (notice_type IN (
      'bonus_claimable', 'bonus_applied', 'claim_window_expired',
      'bonus_access_ended', 'bonus_manual_review'
    ) AND bonus_grant_id IS NOT NULL)
  ),
  CHECK (
    (source_transition_id IS NOT NULL AND source_expiry_event_id IS NULL)
    OR
    (source_transition_id IS NULL AND source_expiry_event_id IS NOT NULL
      AND notice_type = 'bonus_access_ended')
  ),
  CHECK (
    (delivery_state = 'pending'
      AND attempt_count = 0
      AND lease_token IS NULL AND lease_expires_at IS NULL
      AND last_attempt_at IS NULL AND delivered_at IS NULL
      AND last_error_code = '')
    OR
    (delivery_state = 'processing'
      AND attempt_count BETWEEN 1 AND 10
      AND lease_token IS NOT NULL AND length(lease_token) = 36
      AND lease_expires_at IS NOT NULL
      AND last_attempt_at IS NOT NULL AND delivered_at IS NULL)
    OR
    (delivery_state = 'retry'
      AND attempt_count BETWEEN 1 AND 9
      AND lease_token IS NULL AND lease_expires_at IS NULL
      AND last_attempt_at IS NOT NULL AND delivered_at IS NULL
      AND last_error_code != '')
    OR
    (delivery_state IN ('delivered', 'suppressed')
      AND attempt_count BETWEEN 1 AND 10
      AND lease_token IS NULL AND lease_expires_at IS NULL
      AND last_attempt_at IS NOT NULL AND delivered_at IS NOT NULL)
    OR
    (delivery_state = 'manual_review'
      AND attempt_count BETWEEN 1 AND 10
      AND lease_token IS NULL AND lease_expires_at IS NULL
      AND last_attempt_at IS NOT NULL AND delivered_at IS NULL
      AND last_error_code != '')
  )
);

CREATE INDEX IF NOT EXISTS idx_referral_notice_jobs_due
  ON referral_reward_notice_jobs(
    delivery_state, next_attempt_at, not_before, notice_key
  );

CREATE INDEX IF NOT EXISTS idx_referral_notice_jobs_recipient
  ON referral_reward_notice_jobs(
    recipient_telegram_id, created_at DESC, notice_key
  );

CREATE TRIGGER IF NOT EXISTS trg_referral_notice_jobs_identity_immutable
BEFORE UPDATE ON referral_reward_notice_jobs
WHEN NEW.notice_key IS NOT OLD.notice_key
  OR NEW.source_event_key IS NOT OLD.source_event_key
  OR NEW.source_transition_id IS NOT OLD.source_transition_id
  OR NEW.source_expiry_event_id IS NOT OLD.source_expiry_event_id
  OR NEW.reward_id IS NOT OLD.reward_id
  OR NEW.bonus_grant_id IS NOT OLD.bonus_grant_id
  OR NEW.recipient_telegram_id IS NOT OLD.recipient_telegram_id
  OR NEW.notice_type IS NOT OLD.notice_type
  OR NEW.not_before IS NOT OLD.not_before
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'referral notice identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_notice_jobs_terminal_immutable
BEFORE UPDATE ON referral_reward_notice_jobs
WHEN OLD.delivery_state IN ('delivered', 'suppressed', 'manual_review')
BEGIN
  SELECT RAISE(ABORT, 'terminal referral notice is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_notice_jobs_state_guard
BEFORE UPDATE OF delivery_state ON referral_reward_notice_jobs
WHEN NEW.delivery_state != OLD.delivery_state AND NOT (
  (OLD.delivery_state IN ('pending', 'retry')
    AND NEW.delivery_state = 'processing')
  OR
  (OLD.delivery_state = 'processing'
    AND NEW.delivery_state IN (
      'retry', 'delivered', 'suppressed', 'manual_review'
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid referral notice state transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_notice_jobs_delivery_guard
BEFORE UPDATE ON referral_reward_notice_jobs
WHEN NEW.delivery_state = 'delivered' AND NEW.inbox_recorded_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'delivered referral notice lacks inbox evidence');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_notice_jobs_no_delete
BEFORE DELETE ON referral_reward_notice_jobs
BEGIN
  SELECT RAISE(ABORT, 'referral notice history cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_notice_jobs_transition_guard
BEFORE INSERT ON referral_reward_notice_jobs
WHEN NEW.source_transition_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM referral_reward_transitions transition
  JOIN referral_rewards reward ON reward.reward_id = transition.reward_id
  WHERE transition.transition_id = NEW.source_transition_id
    AND transition.reward_id = NEW.reward_id
    AND transition.bonus_grant_id IS NEW.bonus_grant_id
    AND reward.beneficiary_telegram_id = NEW.recipient_telegram_id
    AND (
      (NEW.notice_type = 'pending_review'
        AND transition.transition_scope = 'reward'
        AND transition.from_status = 'none'
        AND transition.to_status = 'pending')
      OR
      (NEW.notice_type = 'reward_confirmed'
        AND transition.transition_scope = 'reward'
        AND transition.to_status = 'confirmed')
      OR
      (NEW.notice_type = 'reward_cancelled'
        AND transition.transition_scope = 'reward'
        AND transition.to_status = 'cancelled')
      OR
      (NEW.notice_type = 'bonus_claimable'
        AND transition.transition_scope = 'bonus_grant'
        AND transition.from_status = 'none'
        AND transition.to_status = 'claimable')
      OR
      (NEW.notice_type = 'bonus_applied'
        AND transition.transition_scope = 'bonus_grant'
        AND transition.to_status = 'applied')
      OR
      (NEW.notice_type = 'claim_window_expired'
        AND transition.transition_scope = 'bonus_grant'
        AND transition.to_status = 'expired')
      OR
      (NEW.notice_type = 'bonus_manual_review'
        AND transition.transition_scope = 'bonus_grant'
        AND transition.to_status = 'manual_review')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'referral notice lacks its immutable transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_notice_jobs_expiry_guard
BEFORE INSERT ON referral_reward_notice_jobs
WHEN NEW.source_expiry_event_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM bonus_access_expiry_events expiry
  JOIN bonus_access_grants grant_record
    ON grant_record.bonus_grant_id = expiry.bonus_grant_id
  WHERE expiry.expiry_event_id = NEW.source_expiry_event_id
    AND expiry.bonus_grant_id = NEW.bonus_grant_id
    AND grant_record.reward_id = NEW.reward_id
    AND expiry.beneficiary_telegram_id = NEW.recipient_telegram_id
    AND NEW.notice_type = 'bonus_access_ended'
)
BEGIN
  SELECT RAISE(ABORT, 'referral notice lacks its immutable expiry event');
END;

-- Existing Part 1–4 transitions are backfilled without rewriting their history.
INSERT OR IGNORE INTO referral_reward_notice_jobs (
  notice_key, source_event_key, source_transition_id,
  source_expiry_event_id, reward_id, bonus_grant_id,
  recipient_telegram_id, notice_type, delivery_state,
  not_before, next_attempt_at, attempt_count,
  lease_token, lease_expires_at, last_attempt_at,
  inbox_recorded_at, delivered_at, last_error_code,
  created_at, updated_at
)
SELECT
  'referral-notice:' || transition.transition_id,
  'transition:' || transition.transition_id,
  transition.transition_id,
  NULL,
  transition.reward_id,
  transition.bonus_grant_id,
  reward.beneficiary_telegram_id,
  CASE
    WHEN transition.transition_scope = 'reward'
      AND transition.from_status = 'none'
      AND transition.to_status = 'pending' THEN 'pending_review'
    WHEN transition.transition_scope = 'reward'
      AND transition.to_status = 'confirmed' THEN 'reward_confirmed'
    WHEN transition.transition_scope = 'reward'
      AND transition.to_status = 'cancelled' THEN 'reward_cancelled'
    WHEN transition.transition_scope = 'bonus_grant'
      AND transition.from_status = 'none'
      AND transition.to_status = 'claimable' THEN 'bonus_claimable'
    WHEN transition.transition_scope = 'bonus_grant'
      AND transition.to_status = 'applied' THEN 'bonus_applied'
    WHEN transition.transition_scope = 'bonus_grant'
      AND transition.to_status = 'expired' THEN 'claim_window_expired'
    WHEN transition.transition_scope = 'bonus_grant'
      AND transition.to_status = 'manual_review' THEN 'bonus_manual_review'
  END,
  'pending',
  CASE
    WHEN transition.transition_scope = 'reward'
      AND transition.to_status = 'confirmed'
      THEN transition.recorded_at + 300
    ELSE transition.recorded_at
  END,
  CASE
    WHEN transition.transition_scope = 'reward'
      AND transition.to_status = 'confirmed'
      THEN transition.recorded_at + 300
    ELSE transition.recorded_at
  END,
  0, NULL, NULL, NULL, NULL, NULL, '',
  transition.recorded_at, transition.recorded_at
FROM referral_reward_transitions transition
JOIN referral_rewards reward ON reward.reward_id = transition.reward_id
WHERE
  (transition.transition_scope = 'reward'
    AND transition.from_status = 'none'
    AND transition.to_status = 'pending')
  OR
  (transition.transition_scope = 'reward'
    AND transition.to_status IN ('confirmed', 'cancelled'))
  OR
  (transition.transition_scope = 'bonus_grant'
    AND (
      (transition.from_status = 'none' AND transition.to_status = 'claimable')
      OR transition.to_status IN ('applied', 'expired', 'manual_review')
    ));

INSERT OR IGNORE INTO referral_reward_notice_jobs (
  notice_key, source_event_key, source_transition_id,
  source_expiry_event_id, reward_id, bonus_grant_id,
  recipient_telegram_id, notice_type, delivery_state,
  not_before, next_attempt_at, attempt_count,
  lease_token, lease_expires_at, last_attempt_at,
  inbox_recorded_at, delivered_at, last_error_code,
  created_at, updated_at
)
SELECT
  'referral-notice-expiry:' || expiry.expiry_event_id,
  'expiry:' || expiry.expiry_event_id,
  NULL,
  expiry.expiry_event_id,
  grant_record.reward_id,
  expiry.bonus_grant_id,
  expiry.beneficiary_telegram_id,
  'bonus_access_ended',
  'pending',
  expiry.recorded_at,
  expiry.recorded_at,
  0, NULL, NULL, NULL, NULL, NULL, '',
  expiry.recorded_at, expiry.recorded_at
FROM bonus_access_expiry_events expiry
JOIN bonus_access_grants grant_record
  ON grant_record.bonus_grant_id = expiry.bonus_grant_id;

-- Future immutable transitions enqueue exactly one privacy-minimal notice job.
CREATE TRIGGER IF NOT EXISTS trg_referral_transitions_enqueue_notice
AFTER INSERT ON referral_reward_transitions
WHEN
  (NEW.transition_scope = 'reward'
    AND NEW.from_status = 'none' AND NEW.to_status = 'pending')
  OR
  (NEW.transition_scope = 'reward'
    AND NEW.to_status IN ('confirmed', 'cancelled'))
  OR
  (NEW.transition_scope = 'bonus_grant'
    AND (
      (NEW.from_status = 'none' AND NEW.to_status = 'claimable')
      OR NEW.to_status IN ('applied', 'expired', 'manual_review')
    ))
BEGIN
  INSERT OR IGNORE INTO referral_reward_notice_jobs (
    notice_key, source_event_key, source_transition_id,
    source_expiry_event_id, reward_id, bonus_grant_id,
    recipient_telegram_id, notice_type, delivery_state,
    not_before, next_attempt_at, attempt_count,
    lease_token, lease_expires_at, last_attempt_at,
    inbox_recorded_at, delivered_at, last_error_code,
    created_at, updated_at
  )
  SELECT
    'referral-notice:' || NEW.transition_id,
    'transition:' || NEW.transition_id,
    NEW.transition_id,
    NULL,
    NEW.reward_id,
    NEW.bonus_grant_id,
    reward.beneficiary_telegram_id,
    CASE
      WHEN NEW.transition_scope = 'reward'
        AND NEW.from_status = 'none'
        AND NEW.to_status = 'pending' THEN 'pending_review'
      WHEN NEW.transition_scope = 'reward'
        AND NEW.to_status = 'confirmed' THEN 'reward_confirmed'
      WHEN NEW.transition_scope = 'reward'
        AND NEW.to_status = 'cancelled' THEN 'reward_cancelled'
      WHEN NEW.transition_scope = 'bonus_grant'
        AND NEW.from_status = 'none'
        AND NEW.to_status = 'claimable' THEN 'bonus_claimable'
      WHEN NEW.transition_scope = 'bonus_grant'
        AND NEW.to_status = 'applied' THEN 'bonus_applied'
      WHEN NEW.transition_scope = 'bonus_grant'
        AND NEW.to_status = 'expired' THEN 'claim_window_expired'
      WHEN NEW.transition_scope = 'bonus_grant'
        AND NEW.to_status = 'manual_review' THEN 'bonus_manual_review'
    END,
    'pending',
    CASE
      WHEN NEW.transition_scope = 'reward' AND NEW.to_status = 'confirmed'
        THEN NEW.recorded_at + 300
      ELSE NEW.recorded_at
    END,
    CASE
      WHEN NEW.transition_scope = 'reward' AND NEW.to_status = 'confirmed'
        THEN NEW.recorded_at + 300
      ELSE NEW.recorded_at
    END,
    0, NULL, NULL, NULL, NULL, NULL, '',
    NEW.recorded_at, NEW.recorded_at
  FROM referral_rewards reward
  WHERE reward.reward_id = NEW.reward_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_expiry_events_enqueue_notice
AFTER INSERT ON bonus_access_expiry_events
BEGIN
  INSERT OR IGNORE INTO referral_reward_notice_jobs (
    notice_key, source_event_key, source_transition_id,
    source_expiry_event_id, reward_id, bonus_grant_id,
    recipient_telegram_id, notice_type, delivery_state,
    not_before, next_attempt_at, attempt_count,
    lease_token, lease_expires_at, last_attempt_at,
    inbox_recorded_at, delivered_at, last_error_code,
    created_at, updated_at
  )
  SELECT
    'referral-notice-expiry:' || NEW.expiry_event_id,
    'expiry:' || NEW.expiry_event_id,
    NULL,
    NEW.expiry_event_id,
    grant_record.reward_id,
    NEW.bonus_grant_id,
    NEW.beneficiary_telegram_id,
    'bonus_access_ended',
    'pending', NEW.recorded_at, NEW.recorded_at,
    0, NULL, NULL, NULL, NULL, NULL, '',
    NEW.recorded_at, NEW.recorded_at
  FROM bonus_access_grants grant_record
  WHERE grant_record.bonus_grant_id = NEW.bonus_grant_id;
END;

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.7-referral-ux-admin');
