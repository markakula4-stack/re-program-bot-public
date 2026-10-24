-- RE Program Bot v1.3.7 Part 2 — invitation-cycle guard.
-- Additive and idempotent. The runtime checks the current inviter chain before
-- writing; this trigger repeats the decisive check inside the D1 transaction.

CREATE TRIGGER IF NOT EXISTS trg_referral_candidates_cycle_guard
BEFORE INSERT ON referral_reward_candidates
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

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.7-referral-candidate-cycle-guard');
