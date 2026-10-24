-- RE Program Bot v1.3.6 Part 1 — Telegram Stars payment foundation.
-- Additive and idempotent. This migration defines the server price book,
-- orders, append-only payment evidence and subscription projections. It does
-- not enable invoices, purchases, paid capabilities or automatic renewal.

CREATE TABLE IF NOT EXISTS price_book (
  price_id TEXT PRIMARY KEY
    CHECK (length(price_id) BETWEEN 12 AND 96),
  price_version INTEGER NOT NULL CHECK (price_version > 0),
  plan_code TEXT NOT NULL REFERENCES plan_catalog(plan_code)
    CHECK (plan_code IN ('professional', 'dragon')),
  currency TEXT NOT NULL CHECK (currency = 'XTR'),
  amount_stars INTEGER NOT NULL CHECK (amount_stars BETWEEN 1 AND 10000),
  -- The v1.3.6 resolver releases only 30 days. The wider additive database
  -- envelope avoids a destructive table rebuild when prepaid 3/6/12-month
  -- packages are introduced by the later roadmap release.
  access_seconds INTEGER NOT NULL CHECK (
    access_seconds BETWEEN 86400 AND 31622400
    AND access_seconds % 86400 = 0
  ),
  billing_mode TEXT NOT NULL CHECK (billing_mode IN ('prepaid', 'recurring')),
  publication_state TEXT NOT NULL DEFAULT 'approved'
    CHECK (publication_state IN ('draft', 'approved', 'retired')),
  terms_revision TEXT NOT NULL CHECK (length(terms_revision) BETWEEN 8 AND 64),
  valid_from INTEGER NOT NULL CHECK (valid_from > 0),
  valid_until INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  created_by TEXT NOT NULL DEFAULT 'release'
    CHECK (length(created_by) BETWEEN 3 AND 64),
  UNIQUE (plan_code, billing_mode, access_seconds, price_version),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

CREATE INDEX IF NOT EXISTS idx_price_book_resolution
  ON price_book(plan_code, billing_mode, publication_state,
                price_version DESC, valid_from DESC);

INSERT OR IGNORE INTO price_book (
  price_id, price_version, plan_code, currency, amount_stars,
  access_seconds, billing_mode, publication_state, terms_revision,
  valid_from, created_at, created_by
) VALUES
  ('professional-30d-prepaid-v1', 1, 'professional', 'XTR', 249,
   2592000, 'prepaid', 'approved', '2026-09-10.stars-v1',
   1788998400, 1788998400, 'v1.3.6-part1'),
  ('dragon-30d-prepaid-v1', 1, 'dragon', 'XTR', 499,
   2592000, 'prepaid', 'approved', '2026-09-10.stars-v1',
   1788998400, 1788998400, 'v1.3.6-part1');

CREATE TRIGGER IF NOT EXISTS trg_price_book_immutable_update
BEFORE UPDATE ON price_book
BEGIN
  SELECT RAISE(ABORT, 'price book versions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_price_book_immutable_delete
BEFORE DELETE ON price_book
BEGIN
  SELECT RAISE(ABORT, 'price book versions are immutable');
END;

CREATE TABLE IF NOT EXISTS subscription_orders (
  order_id TEXT PRIMARY KEY CHECK (length(order_id) = 36),
  telegram_id INTEGER NOT NULL CHECK (telegram_id > 0),
  price_id TEXT NOT NULL REFERENCES price_book(price_id),
  price_version INTEGER NOT NULL CHECK (price_version > 0),
  plan_code TEXT NOT NULL CHECK (plan_code IN ('professional', 'dragon')),
  currency TEXT NOT NULL CHECK (currency = 'XTR'),
  amount_stars INTEGER NOT NULL CHECK (amount_stars BETWEEN 1 AND 10000),
  access_seconds INTEGER NOT NULL CHECK (
    access_seconds BETWEEN 86400 AND 31622400
    AND access_seconds % 86400 = 0
  ),
  billing_mode TEXT NOT NULL CHECK (billing_mode IN ('prepaid', 'recurring')),
  terms_revision TEXT NOT NULL CHECK (length(terms_revision) BETWEEN 8 AND 64),
  invoice_payload TEXT NOT NULL UNIQUE
    CHECK (length(invoice_payload) BETWEEN 1 AND 128),
  order_state TEXT NOT NULL DEFAULT 'created' CHECK (order_state IN (
    'created', 'precheckout_ok', 'paid', 'applied',
    'refunded', 'chargeback', 'failed', 'cancelled'
  )),
  state_revision INTEGER NOT NULL DEFAULT 1 CHECK (state_revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  precheckout_approved_at INTEGER,
  paid_at INTEGER,
  applied_at INTEGER,
  closed_at INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (precheckout_approved_at IS NULL OR precheckout_approved_at >= created_at),
  CHECK (paid_at IS NULL OR paid_at >= created_at),
  CHECK (applied_at IS NULL OR applied_at >= created_at),
  CHECK (closed_at IS NULL OR closed_at >= created_at),
  CHECK (order_state != 'precheckout_ok' OR precheckout_approved_at IS NOT NULL),
  CHECK (order_state NOT IN ('paid', 'applied') OR paid_at IS NOT NULL),
  CHECK (order_state != 'applied' OR applied_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_subscription_orders_user_time
  ON subscription_orders(telegram_id, created_at DESC, order_id);

CREATE INDEX IF NOT EXISTS idx_subscription_orders_state_expiry
  ON subscription_orders(order_state, expires_at, order_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_orders_one_open_per_user
  ON subscription_orders(telegram_id)
  WHERE order_state IN ('created', 'precheckout_ok', 'paid');

CREATE TRIGGER IF NOT EXISTS trg_subscription_orders_price_guard
BEFORE INSERT ON subscription_orders
WHEN NOT EXISTS (
  SELECT 1
  FROM price_book price
  WHERE price.price_id = NEW.price_id
    AND price.price_version = NEW.price_version
    AND price.plan_code = NEW.plan_code
    AND price.currency = NEW.currency
    AND price.amount_stars = NEW.amount_stars
    AND price.access_seconds = NEW.access_seconds
    AND price.billing_mode = NEW.billing_mode
    AND price.terms_revision = NEW.terms_revision
    AND price.publication_state = 'approved'
    AND price.valid_from <= NEW.created_at
    AND (price.valid_until IS NULL OR price.valid_until > NEW.created_at)
)
BEGIN
  SELECT RAISE(ABORT, 'order price snapshot is not server-approved');
END;

CREATE TRIGGER IF NOT EXISTS trg_subscription_orders_identity_immutable
BEFORE UPDATE ON subscription_orders
WHEN NEW.order_id IS NOT OLD.order_id
  OR NEW.telegram_id IS NOT OLD.telegram_id
  OR NEW.price_id IS NOT OLD.price_id
  OR NEW.price_version IS NOT OLD.price_version
  OR NEW.plan_code IS NOT OLD.plan_code
  OR NEW.currency IS NOT OLD.currency
  OR NEW.amount_stars IS NOT OLD.amount_stars
  OR NEW.access_seconds IS NOT OLD.access_seconds
  OR NEW.billing_mode IS NOT OLD.billing_mode
  OR NEW.terms_revision IS NOT OLD.terms_revision
  OR NEW.invoice_payload IS NOT OLD.invoice_payload
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'order identity and price snapshot are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_subscription_orders_state_transition
BEFORE UPDATE OF order_state ON subscription_orders
WHEN NEW.order_state != OLD.order_state AND NOT (
  (OLD.order_state = 'created' AND NEW.order_state IN
    ('precheckout_ok', 'failed', 'cancelled'))
  OR (OLD.order_state = 'precheckout_ok' AND NEW.order_state IN
    ('paid', 'failed', 'cancelled'))
  OR (OLD.order_state = 'paid' AND NEW.order_state IN
    ('applied', 'refunded', 'chargeback'))
  OR (OLD.order_state = 'applied' AND NEW.order_state IN
    ('refunded', 'chargeback'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid order state transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_subscription_orders_no_delete
BEFORE DELETE ON subscription_orders
BEGIN
  SELECT RAISE(ABORT, 'payment orders cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS payment_events (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 16 AND 96),
  event_key TEXT NOT NULL UNIQUE CHECK (length(event_key) BETWEEN 16 AND 160),
  order_id TEXT REFERENCES subscription_orders(order_id),
  telegram_id INTEGER CHECK (telegram_id IS NULL OR telegram_id > 0),
  telegram_update_id INTEGER,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'order_created', 'invoice_issued', 'precheckout_received',
    'precheckout_approved', 'precheckout_rejected',
    'successful_payment_received', 'payment_recorded',
    'access_applied', 'access_apply_failed',
    'refund_requested', 'refund_confirmed', 'refund_failed',
    'refunded_payment_received', 'chargeback_observed',
    'reconciliation_observed'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN
    ('accepted', 'rejected', 'ignored', 'error')),
  reason_code TEXT NOT NULL DEFAULT '' CHECK (length(reason_code) <= 64),
  payload_sha256 TEXT CHECK (
    payload_sha256 IS NULL OR length(payload_sha256) = 64
  ),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  received_at INTEGER NOT NULL CHECK (received_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_payment_events_order_time
  ON payment_events(order_id, occurred_at, event_id);

CREATE INDEX IF NOT EXISTS idx_payment_events_user_time
  ON payment_events(telegram_id, occurred_at DESC, event_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_update_type
  ON payment_events(telegram_update_id, event_type)
  WHERE telegram_update_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_payment_events_immutable_update
BEFORE UPDATE ON payment_events
BEGIN
  SELECT RAISE(ABORT, 'payment events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_payment_events_immutable_delete
BEFORE DELETE ON payment_events
BEGIN
  SELECT RAISE(ABORT, 'payment events are append-only');
END;

CREATE TABLE IF NOT EXISTS payment_ledger (
  ledger_entry_id TEXT PRIMARY KEY
    CHECK (length(ledger_entry_id) BETWEEN 16 AND 96),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(idempotency_key) BETWEEN 16 AND 160),
  order_id TEXT NOT NULL REFERENCES subscription_orders(order_id),
  telegram_id INTEGER NOT NULL CHECK (telegram_id > 0),
  entry_type TEXT NOT NULL CHECK (entry_type IN
    ('payment', 'refund', 'chargeback', 'adjustment')),
  direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  currency TEXT NOT NULL CHECK (currency = 'XTR'),
  amount_stars INTEGER NOT NULL CHECK (amount_stars BETWEEN 1 AND 10000),
  telegram_payment_charge_id TEXT CHECK (
    telegram_payment_charge_id IS NULL OR
    length(telegram_payment_charge_id) BETWEEN 1 AND 256
  ),
  provider_payment_charge_id TEXT CHECK (
    provider_payment_charge_id IS NULL OR
    length(provider_payment_charge_id) <= 256
  ),
  telegram_update_id INTEGER,
  related_ledger_entry_id TEXT REFERENCES payment_ledger(ledger_entry_id),
  reason_code TEXT NOT NULL DEFAULT '' CHECK (length(reason_code) <= 64),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  recorded_at INTEGER NOT NULL CHECK (recorded_at > 0),
  CHECK (
    (entry_type = 'payment' AND direction = 'credit'
      AND telegram_payment_charge_id IS NOT NULL
      AND related_ledger_entry_id IS NULL)
    OR
    (entry_type IN ('refund', 'chargeback') AND direction = 'debit'
      AND telegram_payment_charge_id IS NOT NULL
      AND related_ledger_entry_id IS NOT NULL)
    OR
    (entry_type = 'adjustment' AND related_ledger_entry_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_payment_ledger_order_time
  ON payment_ledger(order_id, occurred_at, ledger_entry_id);

CREATE INDEX IF NOT EXISTS idx_payment_ledger_user_time
  ON payment_ledger(telegram_id, occurred_at DESC, ledger_entry_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_ledger_charge_type
  ON payment_ledger(telegram_payment_charge_id, entry_type)
  WHERE telegram_payment_charge_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_payment_ledger_compensation_guard
BEFORE INSERT ON payment_ledger
WHEN NEW.entry_type IN ('refund', 'chargeback') AND NOT EXISTS (
  SELECT 1
  FROM payment_ledger original
  WHERE original.ledger_entry_id = NEW.related_ledger_entry_id
    AND original.entry_type = 'payment'
    AND original.direction = 'credit'
    AND original.order_id = NEW.order_id
    AND original.telegram_id = NEW.telegram_id
    AND original.currency = NEW.currency
    AND original.amount_stars = NEW.amount_stars
    AND original.telegram_payment_charge_id = NEW.telegram_payment_charge_id
)
BEGIN
  SELECT RAISE(ABORT, 'ledger compensation does not match original payment');
END;

CREATE TRIGGER IF NOT EXISTS trg_payment_ledger_immutable_update
BEFORE UPDATE ON payment_ledger
BEGIN
  SELECT RAISE(ABORT, 'payment ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_payment_ledger_immutable_delete
BEFORE DELETE ON payment_ledger
BEGIN
  SELECT RAISE(ABORT, 'payment ledger is append-only');
END;

CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id TEXT PRIMARY KEY CHECK (length(subscription_id) = 36),
  telegram_id INTEGER NOT NULL CHECK (telegram_id > 0),
  plan_code TEXT NOT NULL CHECK (plan_code IN ('professional', 'dragon')),
  billing_mode TEXT NOT NULL CHECK (billing_mode IN ('prepaid', 'recurring')),
  source_order_id TEXT NOT NULL UNIQUE REFERENCES subscription_orders(order_id),
  telegram_payment_charge_id TEXT NOT NULL UNIQUE
    CHECK (length(telegram_payment_charge_id) BETWEEN 1 AND 256),
  status TEXT NOT NULL CHECK (status IN (
    'active', 'cancel_at_period_end', 'expired',
    'refunded', 'chargeback', 'suspended'
  )),
  current_period_start INTEGER NOT NULL CHECK (current_period_start > 0),
  current_period_end INTEGER NOT NULL CHECK (
    current_period_end > current_period_start
  ),
  auto_renew INTEGER NOT NULL DEFAULT 0 CHECK (auto_renew IN (0, 1)),
  last_ledger_entry_id TEXT NOT NULL REFERENCES payment_ledger(ledger_entry_id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (billing_mode = 'recurring' OR auto_renew = 0)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_time
  ON subscriptions(telegram_id, current_period_end DESC, subscription_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_due
  ON subscriptions(status, current_period_end, subscription_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_one_current_per_user
  ON subscriptions(telegram_id)
  WHERE status IN ('active', 'cancel_at_period_end', 'suspended');

CREATE TRIGGER IF NOT EXISTS trg_subscriptions_identity_immutable
BEFORE UPDATE ON subscriptions
WHEN NEW.subscription_id IS NOT OLD.subscription_id
  OR NEW.telegram_id IS NOT OLD.telegram_id
  OR NEW.plan_code IS NOT OLD.plan_code
  OR NEW.billing_mode IS NOT OLD.billing_mode
  OR NEW.source_order_id IS NOT OLD.source_order_id
  OR NEW.telegram_payment_charge_id IS NOT OLD.telegram_payment_charge_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'subscription identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_subscriptions_state_transition
BEFORE UPDATE OF status ON subscriptions
WHEN NEW.status != OLD.status AND NOT (
  (OLD.status = 'active' AND NEW.status IN
    ('cancel_at_period_end', 'expired', 'refunded',
     'chargeback', 'suspended'))
  OR (OLD.status = 'cancel_at_period_end' AND NEW.status IN
    ('active', 'expired', 'refunded', 'chargeback', 'suspended'))
  OR (OLD.status = 'suspended' AND NEW.status IN
    ('active', 'expired', 'refunded', 'chargeback'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid subscription state transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_subscriptions_no_delete
BEFORE DELETE ON subscriptions
BEGIN
  SELECT RAISE(ABORT, 'subscriptions cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS subscription_status_history (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 16 AND 96),
  event_key TEXT NOT NULL UNIQUE CHECK (length(event_key) BETWEEN 16 AND 160),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(subscription_id),
  order_id TEXT NOT NULL REFERENCES subscription_orders(order_id),
  telegram_id INTEGER NOT NULL CHECK (telegram_id > 0),
  plan_code TEXT NOT NULL CHECK (plan_code IN ('professional', 'dragon')),
  from_status TEXT CHECK (from_status IS NULL OR from_status IN (
    'active', 'cancel_at_period_end', 'expired',
    'refunded', 'chargeback', 'suspended'
  )),
  to_status TEXT NOT NULL CHECK (to_status IN (
    'active', 'cancel_at_period_end', 'expired',
    'refunded', 'chargeback', 'suspended'
  )),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 3 AND 64),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'telegram', 'admin')),
  actor_id INTEGER,
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  CHECK (
    (actor_type = 'admin' AND actor_id IS NOT NULL AND actor_id > 0)
    OR (actor_type != 'admin' AND actor_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_subscription_history_user_time
  ON subscription_status_history(telegram_id, occurred_at DESC, event_id);

CREATE TRIGGER IF NOT EXISTS trg_subscription_history_immutable_update
BEFORE UPDATE ON subscription_status_history
BEGIN
  SELECT RAISE(ABORT, 'subscription history is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_subscription_history_immutable_delete
BEFORE DELETE ON subscription_status_history
BEGIN
  SELECT RAISE(ABORT, 'subscription history is append-only');
END;

CREATE TABLE IF NOT EXISTS terms_acceptances (
  acceptance_id TEXT PRIMARY KEY CHECK (length(acceptance_id) BETWEEN 16 AND 96),
  telegram_id INTEGER NOT NULL CHECK (telegram_id > 0),
  terms_revision TEXT NOT NULL CHECK (length(terms_revision) BETWEEN 8 AND 64),
  acceptance_scope TEXT NOT NULL CHECK (acceptance_scope = 'stars_purchase'),
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256) = 64),
  telegram_update_id INTEGER,
  accepted_at INTEGER NOT NULL CHECK (accepted_at > 0),
  UNIQUE (telegram_id, terms_revision, acceptance_scope)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_terms_acceptance_update
  ON terms_acceptances(telegram_update_id)
  WHERE telegram_update_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_terms_acceptances_immutable_update
BEFORE UPDATE ON terms_acceptances
BEGIN
  SELECT RAISE(ABORT, 'terms acceptances are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_terms_acceptances_immutable_delete
BEFORE DELETE ON terms_acceptances
BEGIN
  SELECT RAISE(ABORT, 'terms acceptances are append-only');
END;

CREATE TABLE IF NOT EXISTS payment_reconciliation_runs (
  run_id TEXT PRIMARY KEY CHECK (length(run_id) BETWEEN 16 AND 96),
  run_source TEXT NOT NULL CHECK (run_source IN ('scheduled', 'admin', 'release')),
  initiated_by INTEGER CHECK (initiated_by IS NULL OR initiated_by > 0),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'manual_review')),
  offset_start INTEGER NOT NULL DEFAULT 0 CHECK (offset_start >= 0),
  offset_end INTEGER CHECK (offset_end IS NULL OR offset_end >= offset_start),
  transactions_seen INTEGER NOT NULL DEFAULT 0 CHECK (transactions_seen >= 0),
  transactions_matched INTEGER NOT NULL DEFAULT 0 CHECK (transactions_matched >= 0),
  missing_local INTEGER NOT NULL DEFAULT 0 CHECK (missing_local >= 0),
  missing_telegram INTEGER NOT NULL DEFAULT 0 CHECK (missing_telegram >= 0),
  discrepancies INTEGER NOT NULL DEFAULT 0 CHECK (discrepancies >= 0),
  error_code TEXT NOT NULL DEFAULT '' CHECK (length(error_code) <= 64),
  started_at INTEGER NOT NULL CHECK (started_at > 0),
  finished_at INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= started_at),
  CHECK (
    (status = 'running' AND finished_at IS NULL)
    OR (status != 'running' AND finished_at IS NOT NULL
      AND finished_at >= started_at)
  )
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_time
  ON payment_reconciliation_runs(started_at DESC, run_id);

CREATE TRIGGER IF NOT EXISTS trg_reconciliation_identity_immutable
BEFORE UPDATE ON payment_reconciliation_runs
WHEN NEW.run_id IS NOT OLD.run_id
  OR NEW.run_source IS NOT OLD.run_source
  OR NEW.initiated_by IS NOT OLD.initiated_by
  OR NEW.offset_start IS NOT OLD.offset_start
  OR NEW.started_at IS NOT OLD.started_at
BEGIN
  SELECT RAISE(ABORT, 'reconciliation identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_reconciliation_state_transition
BEFORE UPDATE OF status ON payment_reconciliation_runs
WHEN NEW.status != OLD.status AND NOT (
  OLD.status = 'running' AND NEW.status IN
    ('completed', 'failed', 'manual_review')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid reconciliation state transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_reconciliation_no_delete
BEFORE DELETE ON payment_reconciliation_runs
BEGIN
  SELECT RAISE(ABORT, 'reconciliation runs cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS payment_refunds (
  refund_id TEXT PRIMARY KEY CHECK (length(refund_id) BETWEEN 16 AND 96),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(idempotency_key) BETWEEN 16 AND 160),
  order_id TEXT NOT NULL REFERENCES subscription_orders(order_id),
  original_ledger_entry_id TEXT NOT NULL REFERENCES payment_ledger(ledger_entry_id),
  telegram_id INTEGER NOT NULL CHECK (telegram_id > 0),
  telegram_payment_charge_id TEXT NOT NULL UNIQUE
    CHECK (length(telegram_payment_charge_id) BETWEEN 1 AND 256),
  currency TEXT NOT NULL CHECK (currency = 'XTR'),
  amount_stars INTEGER NOT NULL CHECK (amount_stars BETWEEN 1 AND 10000),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 3 AND 64),
  requested_by_type TEXT NOT NULL
    CHECK (requested_by_type IN ('telegram', 'admin', 'system')),
  requested_by INTEGER,
  status TEXT NOT NULL CHECK (status IN
    ('requested', 'confirmed', 'applied', 'failed', 'manual_review')),
  error_code TEXT NOT NULL DEFAULT '' CHECK (length(error_code) <= 64),
  requested_at INTEGER NOT NULL CHECK (requested_at > 0),
  confirmed_at INTEGER,
  applied_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= requested_at),
  CHECK (
    (requested_by_type = 'admin' AND requested_by IS NOT NULL
      AND requested_by > 0)
    OR (requested_by_type != 'admin' AND requested_by IS NULL)
  ),
  CHECK (status NOT IN ('confirmed', 'applied') OR confirmed_at IS NOT NULL),
  CHECK (status != 'applied' OR applied_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_payment_refunds_state_time
  ON payment_refunds(status, requested_at, refund_id);

CREATE TRIGGER IF NOT EXISTS trg_payment_refunds_original_guard
BEFORE INSERT ON payment_refunds
WHEN NOT EXISTS (
  SELECT 1
  FROM payment_ledger original
  WHERE original.ledger_entry_id = NEW.original_ledger_entry_id
    AND original.entry_type = 'payment'
    AND original.direction = 'credit'
    AND original.order_id = NEW.order_id
    AND original.telegram_id = NEW.telegram_id
    AND original.telegram_payment_charge_id = NEW.telegram_payment_charge_id
    AND original.currency = NEW.currency
    AND original.amount_stars = NEW.amount_stars
)
BEGIN
  SELECT RAISE(ABORT, 'refund does not match original payment');
END;

CREATE TRIGGER IF NOT EXISTS trg_payment_refunds_identity_immutable
BEFORE UPDATE ON payment_refunds
WHEN NEW.refund_id IS NOT OLD.refund_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.order_id IS NOT OLD.order_id
  OR NEW.original_ledger_entry_id IS NOT OLD.original_ledger_entry_id
  OR NEW.telegram_id IS NOT OLD.telegram_id
  OR NEW.telegram_payment_charge_id IS NOT OLD.telegram_payment_charge_id
  OR NEW.currency IS NOT OLD.currency
  OR NEW.amount_stars IS NOT OLD.amount_stars
  OR NEW.reason_code IS NOT OLD.reason_code
  OR NEW.requested_by_type IS NOT OLD.requested_by_type
  OR NEW.requested_by IS NOT OLD.requested_by
  OR NEW.requested_at IS NOT OLD.requested_at
BEGIN
  SELECT RAISE(ABORT, 'refund identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_payment_refunds_state_transition
BEFORE UPDATE OF status ON payment_refunds
WHEN NEW.status != OLD.status AND NOT (
  (OLD.status = 'requested' AND NEW.status IN
    ('confirmed', 'failed', 'manual_review'))
  OR (OLD.status = 'confirmed' AND NEW.status IN
    ('applied', 'failed', 'manual_review'))
  OR (OLD.status = 'manual_review' AND NEW.status IN
    ('confirmed', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid refund state transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_payment_refunds_no_delete
BEFORE DELETE ON payment_refunds
BEGIN
  SELECT RAISE(ABORT, 'refund records cannot be deleted');
END;

-- Public plan cards remain non-purchasable. A later release gate must
-- explicitly enable invoices after terms, support and payment tests pass.
INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.6-stars-core-foundation');
