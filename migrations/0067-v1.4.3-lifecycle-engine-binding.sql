-- v1.4.3 Part 2: minimal binding to the existing ledger/access engine.
-- 0066 remains frozen. The three named guards alone are replaced.
-- The original access-grant predicate is preserved verbatim as the first arm.
-- No business rows, monetary constraints, public invoice lock, flags or policy seeds change.
-- A first receipt records authenticated is_first_recurring evidence; it is not a ledger.
-- Apply only in a reviewed local/installation transaction. SQL cannot authenticate provider data.

-- A policy-blocked real charge is retained in the SAME existing ledger, with
-- no grant or current projection change. This small receipt preserves the
-- provider period/first marker needed for later review; it creates no money.
CREATE TABLE IF NOT EXISTS subscription_payment_review_receipts (
  ledger_entry_id TEXT PRIMARY KEY REFERENCES payment_ledger(ledger_entry_id),
  origin_order_id TEXT NOT NULL REFERENCES subscription_orders(order_id),
  contract_id TEXT REFERENCES subscription_billing_contracts(contract_id),
  telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),
  plan_code TEXT NOT NULL CHECK(plan_code IN ('professional','dragon')),
  external_invoice_payload TEXT NOT NULL CHECK(length(external_invoice_payload) BETWEEN 1 AND 128),
  external_payload_sha256 TEXT NOT NULL CHECK(length(external_payload_sha256)=64 AND external_payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  provider_period_start INTEGER,
  provider_period_end INTEGER,
  is_first_recurring INTEGER NOT NULL CHECK(typeof(is_first_recurring)='integer' AND is_first_recurring IN (0,1)),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  telegram_update_id INTEGER CHECK(telegram_update_id IS NULL OR (typeof(telegram_update_id)='integer' AND telegram_update_id>=0)),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 3 AND 64),
  recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at>0),
  CHECK((contract_id IS NOT NULL AND typeof(provider_period_start)='integer' AND provider_period_start>0
    AND provider_period_end=provider_period_start+2592000)
   OR (contract_id IS NULL AND provider_period_start IS NULL AND provider_period_end IS NULL AND is_first_recurring=0))
);
CREATE INDEX IF NOT EXISTS idx_v143_payment_review_receipt_own
  ON subscription_payment_review_receipts(telegram_id,recorded_at DESC,ledger_entry_id);
CREATE TRIGGER IF NOT EXISTS v143_payment_review_receipt_binding BEFORE INSERT ON subscription_payment_review_receipts
WHEN NOT EXISTS(
 SELECT 1 FROM payment_ledger p JOIN subscription_orders origin ON origin.order_id=NEW.origin_order_id
 WHERE p.ledger_entry_id=NEW.ledger_entry_id AND p.order_id=origin.order_id
 AND p.telegram_id=NEW.telegram_id AND p.entry_type='payment' AND p.direction='credit' AND p.currency='XTR'
 AND p.amount_stars=origin.amount_stars AND p.reason_code='payment_review_retained' AND p.recorded_at<=NEW.recorded_at
 AND origin.telegram_id=NEW.telegram_id AND origin.plan_code=NEW.plan_code
 AND origin.invoice_payload=NEW.external_invoice_payload
 AND EXISTS(SELECT 1 FROM payment_events e WHERE e.order_id=origin.order_id AND e.telegram_id=NEW.telegram_id
   AND e.telegram_update_id IS NEW.telegram_update_id AND e.event_type='payment_recorded'
   AND e.outcome='accepted' AND e.reason_code='payment_review_retained' AND e.payload_sha256=NEW.evidence_sha256
   AND e.received_at<=NEW.recorded_at)
 AND ((origin.billing_mode='prepaid' AND origin.order_state IN ('failed','cancelled') AND NEW.contract_id IS NULL
   AND NEW.provider_period_start IS NULL AND NEW.provider_period_end IS NULL AND NEW.is_first_recurring=0)
  OR (origin.billing_mode='recurring' AND origin.order_state IN ('paid','applied','refunded','chargeback','failed','cancelled')
   AND EXISTS(SELECT 1 FROM subscription_billing_contracts c WHERE c.contract_id=NEW.contract_id
     AND c.origin_order_id=origin.order_id AND c.telegram_id=NEW.telegram_id AND c.plan_code=NEW.plan_code
     AND c.price_id=origin.price_id AND c.currency=origin.currency AND c.amount_stars=origin.amount_stars
     AND c.period_seconds=origin.access_seconds AND c.terms_revision=origin.terms_revision
     AND c.external_invoice_payload=NEW.external_invoice_payload AND c.external_payload_sha256=NEW.external_payload_sha256))))
BEGIN SELECT RAISE(ABORT,'v143_payment_review_receipt_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v143_payment_review_receipt_no_update BEFORE UPDATE ON subscription_payment_review_receipts
BEGIN SELECT RAISE(ABORT,'v143_payment_review_receipt_append_only'); END;
CREATE TRIGGER IF NOT EXISTS v143_payment_review_receipt_no_delete BEFORE DELETE ON subscription_payment_review_receipts
BEGIN SELECT RAISE(ABORT,'v143_payment_review_receipt_append_only'); END;

CREATE TABLE IF NOT EXISTS subscription_first_recurring_receipts (
  contract_id TEXT PRIMARY KEY REFERENCES subscription_billing_contracts(contract_id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES subscription_payment_links(operation_id),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  verified_at INTEGER NOT NULL CHECK(typeof(verified_at)='integer' AND verified_at>0)
);
CREATE TRIGGER IF NOT EXISTS v143_first_recurring_receipt_binding BEFORE INSERT ON subscription_first_recurring_receipts
WHEN NOT EXISTS(
 SELECT 1 FROM subscription_billing_contracts c
 JOIN subscription_payment_links l ON l.operation_id=NEW.operation_id
 JOIN payment_ledger p ON p.ledger_entry_id=l.ledger_entry_id
 JOIN subscription_orders origin ON origin.order_id=c.origin_order_id
 JOIN subscription_orders child ON child.order_id=l.applied_order_id
 WHERE c.contract_id=NEW.contract_id AND c.first_payment_ledger_entry_id IS NULL
 AND l.contract_id=c.contract_id AND l.direction='incoming' AND l.link_kind='recurring_charge'
 AND l.origin_order_id=c.origin_order_id AND l.telegram_id=c.telegram_id AND l.plan_code=c.plan_code
 AND l.external_invoice_payload=c.external_invoice_payload AND l.external_payload_sha256=c.external_payload_sha256
 AND l.evidence_sha256=NEW.evidence_sha256 AND l.recorded_at<=NEW.verified_at
 AND p.order_id=child.order_id AND p.telegram_id=c.telegram_id AND p.entry_type='payment' AND p.direction='credit'
 AND p.currency=c.currency AND p.amount_stars=c.amount_stars AND p.telegram_payment_charge_id=l.provider_charge_id
 AND child.telegram_id=c.telegram_id AND child.plan_code=c.plan_code AND child.billing_mode='recurring'
 AND child.price_id=origin.price_id AND child.price_version=origin.price_version AND child.currency=origin.currency
 AND child.amount_stars=origin.amount_stars AND child.access_seconds=origin.access_seconds AND child.terms_revision=origin.terms_revision
 AND ((child.order_id=origin.order_id) OR (
  child.order_id!=origin.order_id AND child.invoice_payload!=c.external_invoice_payload
  AND child.created_at=origin.created_at AND child.expires_at=origin.expires_at
  AND (origin.order_state IN ('failed','cancelled') OR (origin.order_state='paid'
   AND NOT EXISTS(SELECT 1 FROM subscription_first_recurring_receipts existing_first WHERE existing_first.contract_id=c.contract_id)
   AND EXISTS(SELECT 1 FROM subscription_payment_links prior
    JOIN payment_ledger prior_payment ON prior_payment.ledger_entry_id=prior.ledger_entry_id
    WHERE prior.contract_id=c.contract_id AND prior.origin_order_id=origin.order_id AND prior.applied_order_id=origin.order_id
     AND prior.direction='incoming' AND prior.link_kind='recurring_charge'
     AND prior.telegram_id=c.telegram_id AND prior.plan_code=c.plan_code
     AND prior.external_invoice_payload=c.external_invoice_payload AND prior.external_payload_sha256=c.external_payload_sha256
     AND prior.ledger_entry_id!=l.ledger_entry_id AND prior.provider_charge_id!=l.provider_charge_id
     AND prior.provider_period_start>=l.provider_period_end
     AND prior_payment.order_id=origin.order_id AND prior_payment.telegram_id=c.telegram_id
     AND prior_payment.entry_type='payment' AND prior_payment.direction='credit' AND prior_payment.currency=c.currency
     AND prior_payment.amount_stars=c.amount_stars AND prior_payment.telegram_payment_charge_id=prior.provider_charge_id))))))
BEGIN SELECT RAISE(ABORT,'v143_first_recurring_receipt_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v143_first_recurring_receipt_no_update BEFORE UPDATE ON subscription_first_recurring_receipts
BEGIN SELECT RAISE(ABORT,'v143_first_recurring_receipt_append_only'); END;
CREATE TRIGGER IF NOT EXISTS v143_first_recurring_receipt_no_delete BEFORE DELETE ON subscription_first_recurring_receipts
BEGIN SELECT RAISE(ABORT,'v143_first_recurring_receipt_append_only'); END;

DROP TRIGGER IF EXISTS v143_contract_update_binding;
CREATE TRIGGER IF NOT EXISTS v143_contract_update_binding BEFORE UPDATE ON subscription_billing_contracts
WHEN NEW.contract_id IS NOT OLD.contract_id OR NEW.telegram_id IS NOT OLD.telegram_id OR NEW.plan_code IS NOT OLD.plan_code
 OR NEW.price_id IS NOT OLD.price_id OR NEW.origin_order_id IS NOT OLD.origin_order_id
 OR NEW.external_invoice_payload IS NOT OLD.external_invoice_payload OR NEW.external_payload_sha256 IS NOT OLD.external_payload_sha256
 OR NEW.terms_revision IS NOT OLD.terms_revision OR NEW.terms_acceptance_id IS NOT OLD.terms_acceptance_id
 OR NEW.billing_mode IS NOT OLD.billing_mode OR NEW.period_seconds IS NOT OLD.period_seconds OR NEW.currency IS NOT OLD.currency
 OR NEW.amount_stars IS NOT OLD.amount_stars OR NEW.created_at IS NOT OLD.created_at
 OR NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at
 OR (OLD.first_payment_ledger_entry_id IS NOT NULL AND NEW.first_payment_ledger_entry_id IS NOT OLD.first_payment_ledger_entry_id)
 OR ((NEW.provider_state IS NOT OLD.provider_state OR NEW.auto_renew_confirmed IS NOT OLD.auto_renew_confirmed) AND NOT EXISTS(
  SELECT 1 FROM subscription_provider_events e WHERE e.event_id=NEW.last_provider_event_id AND e.contract_id=NEW.contract_id
  AND e.telegram_id=NEW.telegram_id AND e.provider_state=NEW.provider_state
  AND e.event_type IN ('provider_control','renewal_failed','command_confirmed')))
 OR (OLD.retired_at IS NOT NULL AND (NEW.retired_at IS NOT OLD.retired_at OR NEW.retirement_event_id IS NOT OLD.retirement_event_id))
 OR (NEW.retired_at IS NOT OLD.retired_at AND NOT (
  OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL AND EXISTS(SELECT 1 FROM subscription_provider_events e
   WHERE e.event_id=NEW.retirement_event_id AND e.contract_id=NEW.contract_id AND e.telegram_id=NEW.telegram_id
   AND e.event_type='contract_retired' AND e.source='system' AND e.received_at<=NEW.retired_at)
  AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands c WHERE c.contract_id=NEW.contract_id AND c.state IN ('admitted','attempted','unknown'))
  AND ((NEW.provider_state='canceled' AND NEW.first_payment_ledger_entry_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM subscription_provider_events e WHERE e.event_id=NEW.last_provider_event_id AND e.provider_state='canceled'
     AND e.contract_id=NEW.contract_id AND e.telegram_id=NEW.telegram_id AND e.source='telegram_update')
    AND EXISTS(SELECT 1 FROM subscription_payment_links l WHERE l.contract_id=NEW.contract_id AND l.direction='incoming'
     AND l.ledger_entry_id=NEW.first_payment_ledger_entry_id AND l.provider_period_end<=NEW.retired_at)
    AND NOT EXISTS(SELECT 1 FROM subscription_payment_links l JOIN subscription_orders o ON o.order_id=l.applied_order_id
     WHERE l.contract_id=NEW.contract_id AND l.direction='incoming' AND (l.provider_period_end>NEW.retired_at OR o.order_state='paid'))
    AND NOT EXISTS(SELECT 1 FROM subscription_access_grants g JOIN subscription_payment_links l ON l.ledger_entry_id=g.payment_ledger_entry_id
     WHERE l.contract_id=NEW.contract_id AND g.status='active' AND g.ends_at>NEW.retired_at))
   OR (NEW.provider_state='unconfirmed' AND NEW.first_payment_ledger_entry_id IS NULL
    AND EXISTS(SELECT 1 FROM subscription_orders o WHERE o.order_id=NEW.origin_order_id AND o.order_state IN ('failed','cancelled')
     AND o.expires_at<=NEW.retired_at AND o.precheckout_approved_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM payment_events e WHERE e.order_id=NEW.origin_order_id AND e.outcome='accepted'
     AND e.event_type IN ('precheckout_received','precheckout_approved','successful_payment_received','payment_recorded','access_applied'))
    AND NOT EXISTS(SELECT 1 FROM payment_ledger p WHERE p.order_id=NEW.origin_order_id AND p.entry_type='payment')
    AND NOT EXISTS(SELECT 1 FROM subscription_payment_links l WHERE l.contract_id=NEW.contract_id AND l.direction='incoming')))))
 OR (NEW.first_payment_ledger_entry_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM subscription_first_recurring_receipts first_receipt
  JOIN subscription_payment_links l ON l.operation_id=first_receipt.operation_id
  JOIN payment_ledger p ON p.ledger_entry_id=l.ledger_entry_id
  JOIN subscription_orders o ON o.order_id=l.applied_order_id
  WHERE first_receipt.contract_id=NEW.contract_id AND l.contract_id=NEW.contract_id
  AND l.direction='incoming' AND l.link_kind='recurring_charge' AND l.origin_order_id=NEW.origin_order_id
  AND l.telegram_id=NEW.telegram_id AND l.plan_code=NEW.plan_code
  AND l.external_invoice_payload=NEW.external_invoice_payload AND l.external_payload_sha256=NEW.external_payload_sha256
  AND l.ledger_entry_id=NEW.first_payment_ledger_entry_id AND p.order_id=o.order_id
  AND p.telegram_id=NEW.telegram_id AND p.entry_type='payment' AND p.direction='credit'
  AND p.currency=NEW.currency AND p.amount_stars=NEW.amount_stars AND p.telegram_payment_charge_id=l.provider_charge_id
  AND o.billing_mode='recurring' AND first_receipt.evidence_sha256=l.evidence_sha256))
BEGIN SELECT RAISE(ABORT,'v143_contract_update_invalid'); END;

DROP TRIGGER IF EXISTS v143_provider_command_insert;
CREATE TRIGGER IF NOT EXISTS v143_provider_command_insert BEFORE INSERT ON subscription_provider_commands
WHEN NEW.state!='admitted' OR NEW.attempted_count!=0 OR NEW.acknowledgement_event_id IS NOT NULL OR NEW.revision!=1 OR NOT EXISTS(
 SELECT 1 FROM subscription_billing_contracts c
 JOIN subscription_first_recurring_receipts first_receipt ON first_receipt.contract_id=c.contract_id
 JOIN subscription_payment_links l ON l.operation_id=first_receipt.operation_id
 JOIN payment_ledger p ON p.ledger_entry_id=l.ledger_entry_id
 JOIN subscription_orders o ON o.order_id=l.applied_order_id
 WHERE c.contract_id=NEW.contract_id AND c.telegram_id=NEW.telegram_id AND c.revision=NEW.expected_contract_revision
 AND c.first_payment_ledger_entry_id=NEW.first_payment_ledger_entry_id AND l.ledger_entry_id=NEW.first_payment_ledger_entry_id
 AND l.contract_id=c.contract_id AND l.origin_order_id=c.origin_order_id AND l.direction='incoming' AND l.link_kind='recurring_charge'
 AND l.telegram_id=NEW.telegram_id AND l.plan_code=c.plan_code AND l.external_invoice_payload=c.external_invoice_payload
 AND l.external_payload_sha256=c.external_payload_sha256 AND first_receipt.evidence_sha256=l.evidence_sha256
 AND p.telegram_id=NEW.telegram_id AND p.order_id=o.order_id AND p.entry_type='payment' AND p.direction='credit'
 AND p.currency=c.currency AND p.amount_stars=c.amount_stars AND p.telegram_payment_charge_id=l.provider_charge_id
 AND o.telegram_id=NEW.telegram_id AND o.plan_code=c.plan_code AND o.billing_mode='recurring')
BEGIN SELECT RAISE(ABORT,'v143_provider_command_admission_invalid'); END;

DROP TRIGGER IF EXISTS trg_subscription_access_grants_payment_guard;
CREATE TRIGGER IF NOT EXISTS trg_subscription_access_grants_payment_guard
BEFORE INSERT ON subscription_access_grants
WHEN (NOT EXISTS (
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
) OR NOT EXISTS(SELECT 1 FROM subscription_orders prepaid_order
  WHERE prepaid_order.order_id=NEW.order_id AND prepaid_order.billing_mode='prepaid')) AND NOT EXISTS (
  SELECT 1 FROM subscription_orders orders
  JOIN payment_ledger payment ON payment.order_id=orders.order_id
  JOIN subscription_payment_links link ON link.ledger_entry_id=payment.ledger_entry_id
  JOIN subscription_billing_contracts contract ON contract.contract_id=link.contract_id
  JOIN subscription_orders origin ON origin.order_id=contract.origin_order_id
  JOIN subscriptions projection ON projection.subscription_id=NEW.subscription_id
  WHERE orders.order_id=NEW.order_id AND orders.billing_mode='recurring'
    AND (orders.order_state='paid' OR (orders.order_state='applied' AND orders.order_id!=origin.order_id
      AND orders.applied_at IS NOT NULL AND orders.created_at=origin.created_at AND orders.expires_at=origin.expires_at))
    AND orders.telegram_id=NEW.telegram_id AND orders.plan_code=NEW.plan_code AND orders.access_seconds=NEW.access_seconds
    AND orders.price_id=origin.price_id AND orders.price_version=origin.price_version
    AND orders.currency=origin.currency AND orders.amount_stars=origin.amount_stars
    AND orders.access_seconds=origin.access_seconds AND orders.billing_mode=origin.billing_mode AND orders.terms_revision=origin.terms_revision
    AND payment.ledger_entry_id=NEW.payment_ledger_entry_id AND payment.entry_type='payment' AND payment.direction='credit'
    AND payment.telegram_id=NEW.telegram_id AND payment.currency='XTR' AND payment.amount_stars=orders.amount_stars
    AND payment.telegram_payment_charge_id=link.provider_charge_id
    AND link.direction='incoming' AND link.link_kind='recurring_charge' AND link.applied_order_id=orders.order_id
    AND link.origin_order_id=origin.order_id AND link.telegram_id=NEW.telegram_id AND link.plan_code=NEW.plan_code
    AND link.external_invoice_payload=contract.external_invoice_payload AND link.external_payload_sha256=contract.external_payload_sha256
    AND contract.telegram_id=NEW.telegram_id AND contract.plan_code=NEW.plan_code AND contract.price_id=orders.price_id
    AND contract.currency=orders.currency AND contract.amount_stars=orders.amount_stars AND contract.period_seconds=NEW.access_seconds
    AND contract.terms_revision=orders.terms_revision AND contract.billing_mode='recurring'
    AND origin.telegram_id=NEW.telegram_id AND origin.plan_code=NEW.plan_code
    AND origin.invoice_payload=contract.external_invoice_payload
    AND projection.telegram_id=NEW.telegram_id AND projection.plan_code=NEW.plan_code AND projection.billing_mode='recurring'
    AND EXISTS(
      SELECT 1 FROM subscription_payment_links source_link
      WHERE source_link.contract_id=contract.contract_id AND source_link.direction='incoming'
        AND source_link.link_kind='recurring_charge' AND source_link.applied_order_id=projection.source_order_id
        AND source_link.provider_charge_id=projection.telegram_payment_charge_id
        AND source_link.telegram_id=NEW.telegram_id AND source_link.plan_code=NEW.plan_code)
    AND NEW.starts_at=link.provider_period_start AND NEW.ends_at=link.provider_period_end
) AND NOT EXISTS (
  SELECT 1 FROM subscription_orders orders
  JOIN payment_ledger payment ON payment.order_id=orders.order_id
  JOIN subscription_payment_links link ON link.ledger_entry_id=payment.ledger_entry_id
  JOIN subscription_orders origin ON origin.order_id=link.origin_order_id
  JOIN subscriptions projection ON projection.subscription_id=NEW.subscription_id
  WHERE orders.order_id=NEW.order_id AND orders.order_state='applied' AND orders.billing_mode='prepaid'
    AND orders.order_id!=origin.order_id AND orders.applied_at IS NOT NULL
    AND orders.created_at=origin.created_at AND orders.expires_at=origin.expires_at
    AND origin.order_state IN ('failed','cancelled') AND origin.billing_mode='prepaid'
    AND orders.telegram_id=NEW.telegram_id AND origin.telegram_id=NEW.telegram_id
    AND orders.plan_code=NEW.plan_code AND origin.plan_code=NEW.plan_code AND orders.access_seconds=NEW.access_seconds
    AND orders.price_id=origin.price_id AND orders.price_version=origin.price_version AND orders.currency=origin.currency
    AND orders.amount_stars=origin.amount_stars AND orders.access_seconds=origin.access_seconds AND orders.terms_revision=origin.terms_revision
    AND payment.ledger_entry_id=NEW.payment_ledger_entry_id AND payment.entry_type='payment' AND payment.direction='credit'
    AND payment.telegram_id=NEW.telegram_id AND payment.currency='XTR' AND payment.amount_stars=orders.amount_stars
    AND payment.telegram_payment_charge_id=link.provider_charge_id
    AND link.direction='incoming' AND link.link_kind='late_prepaid_charge' AND link.contract_id IS NULL
    AND link.applied_order_id=orders.order_id AND link.telegram_id=NEW.telegram_id AND link.plan_code=NEW.plan_code
    AND link.external_invoice_payload=origin.invoice_payload AND orders.invoice_payload!=origin.invoice_payload
    AND projection.telegram_id=NEW.telegram_id AND projection.plan_code=NEW.plan_code AND projection.billing_mode='prepaid'
    AND projection.last_ledger_entry_id=NEW.payment_ledger_entry_id AND projection.current_period_end=NEW.ends_at
)

BEGIN
  SELECT RAISE(ABORT, 'access grant is not backed by an applied payment');
END;


INSERT OR IGNORE INTO re_schema_migrations(version) VALUES('1.4.3-lifecycle-engine-binding');
