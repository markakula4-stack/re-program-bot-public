-- RE Program Bot v1.3.6 Part 3 — paid access and reconciliation evidence.
-- Additive and idempotent. No existing table, column, trigger or user record is
-- removed. Production payments remain disabled until the Part 4 release gate.

-- Every applied payment receives its own immutable 30-day access slice. The
-- subscriptions table remains the current projection, while this table makes
-- renewals, refunds and chargebacks independently auditable.
CREATE TABLE IF NOT EXISTS subscription_access_grants (
  grant_id TEXT PRIMARY KEY CHECK (length(grant_id) = 36),
  grant_key TEXT NOT NULL UNIQUE
    CHECK (length(grant_key) BETWEEN 16 AND 160),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(subscription_id),
  order_id TEXT NOT NULL UNIQUE REFERENCES subscription_orders(order_id),
  payment_ledger_entry_id TEXT NOT NULL UNIQUE
    REFERENCES payment_ledger(ledger_entry_id),
  telegram_id INTEGER NOT NULL CHECK (telegram_id > 0),
  plan_code TEXT NOT NULL CHECK (plan_code IN ('professional', 'dragon')),
  access_seconds INTEGER NOT NULL CHECK (
    access_seconds BETWEEN 86400 AND 31622400
    AND access_seconds % 86400 = 0
  ),
  starts_at INTEGER NOT NULL CHECK (starts_at > 0),
  ends_at INTEGER NOT NULL CHECK (ends_at = starts_at + access_seconds),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'refunded', 'chargeback')),
  compensation_ledger_entry_id TEXT UNIQUE
    REFERENCES payment_ledger(ledger_entry_id),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (status = 'active' AND compensation_ledger_entry_id IS NULL)
    OR
    (status IN ('refunded', 'chargeback')
      AND compensation_ledger_entry_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_subscription_access_grants_user_time
  ON subscription_access_grants(telegram_id, ends_at DESC, grant_id);

CREATE INDEX IF NOT EXISTS idx_subscription_access_grants_subscription
  ON subscription_access_grants(subscription_id, starts_at, grant_id);

CREATE TRIGGER IF NOT EXISTS trg_subscription_access_grants_payment_guard
BEFORE INSERT ON subscription_access_grants
WHEN NOT EXISTS (
  SELECT 1
  FROM subscription_orders orders
  JOIN payment_ledger payment
    ON payment.order_id = orders.order_id
  JOIN subscriptions projection
    ON projection.subscription_id = NEW.subscription_id
  WHERE orders.order_id = NEW.order_id
    AND orders.order_state = 'paid'
    AND orders.telegram_id = NEW.telegram_id
    AND orders.plan_code = NEW.plan_code
    AND orders.access_seconds = NEW.access_seconds
    AND payment.ledger_entry_id = NEW.payment_ledger_entry_id
    AND payment.entry_type = 'payment'
    AND payment.direction = 'credit'
    AND payment.telegram_id = NEW.telegram_id
    AND payment.order_id = NEW.order_id
    AND projection.telegram_id = NEW.telegram_id
    AND projection.plan_code = NEW.plan_code
    AND projection.last_ledger_entry_id = NEW.payment_ledger_entry_id
    AND projection.current_period_end = NEW.ends_at
)
BEGIN
  SELECT RAISE(ABORT, 'access grant is not backed by an applied payment');
END;

CREATE TRIGGER IF NOT EXISTS trg_subscription_access_grants_identity_immutable
BEFORE UPDATE ON subscription_access_grants
WHEN NEW.grant_id IS NOT OLD.grant_id
  OR NEW.grant_key IS NOT OLD.grant_key
  OR NEW.subscription_id IS NOT OLD.subscription_id
  OR NEW.order_id IS NOT OLD.order_id
  OR NEW.payment_ledger_entry_id IS NOT OLD.payment_ledger_entry_id
  OR NEW.telegram_id IS NOT OLD.telegram_id
  OR NEW.plan_code IS NOT OLD.plan_code
  OR NEW.access_seconds IS NOT OLD.access_seconds
  OR NEW.starts_at IS NOT OLD.starts_at
  OR NEW.ends_at IS NOT OLD.ends_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'access grant identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_subscription_access_grants_transition
BEFORE UPDATE OF status ON subscription_access_grants
WHEN NEW.status != OLD.status AND NOT (
  OLD.status = 'active' AND NEW.status IN ('refunded', 'chargeback')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid access grant state transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_subscription_access_grants_compensation_guard
BEFORE UPDATE ON subscription_access_grants
WHEN NEW.status IN ('refunded', 'chargeback') AND NOT EXISTS (
  SELECT 1
  FROM payment_ledger compensation
  JOIN payment_ledger original
    ON original.ledger_entry_id = NEW.payment_ledger_entry_id
  WHERE compensation.ledger_entry_id = NEW.compensation_ledger_entry_id
    AND compensation.related_ledger_entry_id = original.ledger_entry_id
    AND (
      (NEW.status = 'refunded' AND compensation.entry_type = 'refund')
      OR
      (NEW.status = 'chargeback'
        AND compensation.entry_type = 'chargeback')
    )
    AND compensation.direction = 'debit'
    AND compensation.order_id = NEW.order_id
    AND compensation.telegram_id = NEW.telegram_id
    AND compensation.currency = original.currency
    AND compensation.amount_stars = original.amount_stars
    AND compensation.telegram_payment_charge_id =
      original.telegram_payment_charge_id
)
BEGIN
  SELECT RAISE(ABORT, 'access compensation does not match its payment');
END;

CREATE TRIGGER IF NOT EXISTS trg_subscription_access_grants_no_rewrite
BEFORE UPDATE ON subscription_access_grants
WHEN NEW.status = OLD.status AND (
  NEW.compensation_ledger_entry_id IS NOT OLD.compensation_ledger_entry_id
  OR NEW.updated_at IS NOT OLD.updated_at
)
BEGIN
  SELECT RAISE(ABORT, 'settled access grant cannot be rewritten');
END;

CREATE TRIGGER IF NOT EXISTS trg_subscription_access_grants_no_delete
BEFORE DELETE ON subscription_access_grants
BEGIN
  SELECT RAISE(ABORT, 'access grants cannot be deleted');
END;

-- Reconciliation stores only the transaction fingerprint and safe matching
-- metadata. Raw Bot tokens, invoice secrets, provider secrets and Telegram API
-- responses are never persisted here.
CREATE TABLE IF NOT EXISTS payment_reconciliation_items (
  item_id TEXT PRIMARY KEY CHECK (length(item_id) BETWEEN 16 AND 96),
  item_key TEXT NOT NULL UNIQUE CHECK (length(item_key) BETWEEN 16 AND 160),
  run_id TEXT NOT NULL REFERENCES payment_reconciliation_runs(run_id),
  transaction_id_sha256 TEXT NOT NULL CHECK (
    length(transaction_id_sha256) = 64
  ),
  observation_side TEXT NOT NULL
    CHECK (observation_side IN ('telegram', 'local')),
  transaction_direction TEXT NOT NULL
    CHECK (transaction_direction IN ('incoming', 'outgoing')),
  partner_type TEXT NOT NULL DEFAULT '' CHECK (length(partner_type) <= 32),
  transaction_type TEXT NOT NULL DEFAULT ''
    CHECK (length(transaction_type) <= 48),
  telegram_id INTEGER CHECK (telegram_id IS NULL OR telegram_id > 0),
  amount_stars INTEGER NOT NULL CHECK (amount_stars > 0),
  transaction_date INTEGER NOT NULL CHECK (transaction_date > 0),
  local_state TEXT NOT NULL CHECK (local_state IN (
    'matched', 'recovered', 'missing_local', 'missing_telegram',
    'mismatch', 'unsupported', 'manual_review'
  )),
  order_id TEXT REFERENCES subscription_orders(order_id),
  ledger_entry_id TEXT REFERENCES payment_ledger(ledger_entry_id),
  reason_code TEXT NOT NULL DEFAULT '' CHECK (length(reason_code) <= 64),
  observed_at INTEGER NOT NULL CHECK (observed_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_items_run_state
  ON payment_reconciliation_items(run_id, local_state, item_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_items_transaction
  ON payment_reconciliation_items(transaction_id_sha256,
                                  transaction_direction, observed_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_reconciliation_items_immutable_update
BEFORE UPDATE ON payment_reconciliation_items
BEGIN
  SELECT RAISE(ABORT, 'reconciliation evidence is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_reconciliation_items_immutable_delete
BEFORE DELETE ON payment_reconciliation_items
BEGIN
  SELECT RAISE(ABORT, 'reconciliation evidence is append-only');
END;

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.6-stars-access-and-reconciliation');
