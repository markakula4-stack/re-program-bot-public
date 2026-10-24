-- Retained genuine package charges use the EXISTING payment_ledger. This
-- immutable receipt alone confers no period, grant, plan or financial effect.
-- Original v143 receipt guards and the base0072 objects remain untouched.
CREATE TABLE IF NOT EXISTS subscription_package_payment_reviews (
 ledger_entry_id TEXT PRIMARY KEY REFERENCES payment_ledger(ledger_entry_id),
 order_id TEXT NOT NULL REFERENCES subscription_package_orders(order_id),
 telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),
 plan_code TEXT NOT NULL CHECK(plan_code IN ('professional','dragon')),
 external_invoice_payload TEXT NOT NULL CHECK(length(external_invoice_payload) BETWEEN 1 AND 128),
 external_payload_sha256 TEXT NOT NULL CHECK(length(external_payload_sha256)=64 AND external_payload_sha256 NOT GLOB '*[^0-9a-f]*'),
 evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
 telegram_update_id INTEGER CHECK(telegram_update_id IS NULL OR (typeof(telegram_update_id)='integer' AND telegram_update_id>=0)),
 reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 3 AND 64),
 reconciliation_run_id TEXT REFERENCES payment_reconciliation_runs(run_id),
 provider_page_sha256 TEXT CHECK(provider_page_sha256 IS NULL OR (length(provider_page_sha256)=64 AND provider_page_sha256 NOT GLOB '*[^0-9a-f]*')),
 provider_transaction_sha256 TEXT CHECK(provider_transaction_sha256 IS NULL OR (length(provider_transaction_sha256)=64 AND provider_transaction_sha256 NOT GLOB '*[^0-9a-f]*')),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at>0),
 CHECK((reconciliation_run_id IS NULL AND provider_page_sha256 IS NULL AND provider_transaction_sha256 IS NULL)
  OR (reconciliation_run_id IS NOT NULL AND provider_page_sha256 IS NOT NULL AND provider_transaction_sha256 IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_v144_package_payment_review_own ON subscription_package_payment_reviews(telegram_id,recorded_at DESC,ledger_entry_id);
CREATE TRIGGER IF NOT EXISTS v144_package_payment_review_binding BEFORE INSERT ON subscription_package_payment_reviews
WHEN NOT EXISTS(SELECT 1 FROM subscription_package_orders m JOIN subscription_orders o ON o.order_id=m.order_id
 JOIN payment_ledger p ON p.order_id=o.order_id
 WHERE m.order_id=NEW.order_id AND o.telegram_id=NEW.telegram_id AND m.telegram_id=NEW.telegram_id
 AND o.plan_code=NEW.plan_code AND o.billing_mode='prepaid' AND m.billing_mode='prepaid'
 AND o.invoice_payload=NEW.external_invoice_payload AND p.ledger_entry_id=NEW.ledger_entry_id
 AND p.telegram_id=NEW.telegram_id AND p.entry_type='payment' AND p.direction='credit' AND p.currency='XTR'
 AND p.amount_stars=o.amount_stars AND p.reason_code='package_payment_review_retained'
 AND p.related_ledger_entry_id IS NULL AND p.recorded_at<=NEW.recorded_at
 AND p.occurred_at>=o.created_at AND NOT EXISTS(SELECT 1 FROM subscription_package_periods pp WHERE pp.payment_ledger_entry_id=p.ledger_entry_id)
 AND EXISTS(SELECT 1 FROM payment_events e WHERE e.order_id=o.order_id AND e.telegram_id=NEW.telegram_id
  AND e.telegram_update_id IS NEW.telegram_update_id AND e.event_type='payment_recorded' AND e.outcome='accepted'
  AND e.reason_code='package_payment_review_retained' AND e.payload_sha256=NEW.evidence_sha256 AND e.received_at<=NEW.recorded_at))
BEGIN SELECT RAISE(ABORT,'v144_package_payment_review_binding_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v144_package_payment_review_no_update BEFORE UPDATE ON subscription_package_payment_reviews
BEGIN SELECT RAISE(ABORT,'v144_package_payment_review_immutable'); END;
CREATE TRIGGER IF NOT EXISTS v144_package_payment_review_no_delete BEFORE DELETE ON subscription_package_payment_reviews
BEGIN SELECT RAISE(ABORT,'v144_package_payment_review_retention_required'); END;
INSERT OR IGNORE INTO re_schema_migrations(version) VALUES('1.4.4-package-payment-review');

-- One durable provider attempt per immutable package order. An uncertain
-- createInvoiceLink call is never resent after a lost response or retry.
CREATE TABLE IF NOT EXISTS subscription_package_invoice_requests (
 request_id TEXT PRIMARY KEY CHECK(length(request_id)=36),
 order_id TEXT NOT NULL UNIQUE REFERENCES subscription_package_orders(order_id),
 telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL DEFAULT 'admitted' CHECK(state IN ('admitted','attempted','confirmed','rejected','unknown')),
 attempted_count INTEGER NOT NULL DEFAULT 0 CHECK(attempted_count IN (0,1)),
 attempted_at INTEGER,
 invoice_url TEXT CHECK(invoice_url IS NULL OR length(invoice_url) BETWEEN 16 AND 512),
 provider_result_sha256 TEXT CHECK(provider_result_sha256 IS NULL OR (length(provider_result_sha256)=64 AND provider_result_sha256 NOT GLOB '*[^0-9a-f]*')),
 error_code TEXT NOT NULL DEFAULT '' CHECK(length(error_code)<=64),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>0),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=created_at),
 CHECK((attempted_count=0 AND attempted_at IS NULL) OR (attempted_count=1 AND typeof(attempted_at)='integer' AND attempted_at>=created_at)),
 CHECK((state='confirmed' AND invoice_url IS NOT NULL AND provider_result_sha256 IS NOT NULL) OR (state!='confirmed' AND invoice_url IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_v144_package_invoice_own ON subscription_package_invoice_requests(telegram_id,created_at DESC,request_id);
CREATE TRIGGER IF NOT EXISTS v144_package_invoice_insert BEFORE INSERT ON subscription_package_invoice_requests
WHEN NEW.state!='admitted' OR NEW.attempted_count!=0 OR NEW.attempted_at IS NOT NULL OR NEW.invoice_url IS NOT NULL
 OR NEW.provider_result_sha256 IS NOT NULL OR NEW.error_code!='' OR NEW.revision!=1 OR NEW.created_at!=NEW.updated_at
 OR NOT EXISTS(SELECT 1 FROM subscription_package_orders m JOIN subscription_orders o ON o.order_id=m.order_id
  WHERE o.order_id=NEW.order_id AND o.telegram_id=NEW.telegram_id AND m.telegram_id=NEW.telegram_id
  AND o.billing_mode='prepaid' AND o.order_state='created' AND o.created_at<=NEW.created_at AND o.expires_at>NEW.created_at)
BEGIN SELECT RAISE(ABORT,'v144_package_invoice_admission_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v144_package_invoice_update BEFORE UPDATE ON subscription_package_invoice_requests
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.order_id IS NOT OLD.order_id OR NEW.telegram_id IS NOT OLD.telegram_id
 OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.created_at IS NOT OLD.created_at OR NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at
 OR NOT ((OLD.state='admitted' AND NEW.state IN ('attempted','rejected')) OR (OLD.state='attempted' AND NEW.state IN ('confirmed','rejected','unknown'))
  OR (OLD.state='unknown' AND NEW.state IN ('confirmed','rejected')))
 OR (NEW.state IN ('attempted','confirmed','unknown') AND NEW.attempted_count!=1)
 OR (OLD.state='admitted' AND NEW.state='rejected' AND (NEW.attempted_count!=0 OR NEW.attempted_at IS NOT NULL))
 OR (NEW.attempted_count=1 AND NEW.updated_at<NEW.attempted_at)
 OR (OLD.attempted_count=1 AND (NEW.attempted_count!=1 OR NEW.attempted_at IS NOT OLD.attempted_at))
 OR (NEW.state='attempted' AND NOT EXISTS(SELECT 1 FROM subscription_orders o WHERE o.order_id=NEW.order_id
  AND o.telegram_id=NEW.telegram_id AND o.order_state='created' AND o.expires_at>NEW.attempted_at))
BEGIN SELECT RAISE(ABORT,'v144_package_invoice_transition_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v144_package_invoice_no_delete BEFORE DELETE ON subscription_package_invoice_requests
BEGIN SELECT RAISE(ABORT,'v144_package_invoice_retains_attempt'); END;
