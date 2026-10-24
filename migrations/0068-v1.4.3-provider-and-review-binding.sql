-- v1.4.3 Part 3: two proven missing metadata journals and six exact guards.
-- 0066/0067 stay frozen; existing money, states and public invoice indexes stay.
-- No ledger/order/subscription rows are rewritten and no rollout is enabled.

-- Same approved Stars price, a separate explicit monthly recurring product.
-- The immutable prepaid products and their terms remain unchanged.
-- valid_from is the recorded Part 3 authorization, 2026-10-03T20:49:24+03:00.
INSERT OR IGNORE INTO price_book(price_id,price_version,plan_code,currency,amount_stars,
 access_seconds,billing_mode,publication_state,terms_revision,valid_from,created_at,created_by)
VALUES('professional-30d-recurring-v1',1,'professional','XTR',249,2592000,'recurring','approved',
 '2026-10-03.stars-recurring-v1',1791049764,1791049764,'v143-reviewed-recurring');
INSERT OR IGNORE INTO price_book(price_id,price_version,plan_code,currency,amount_stars,
 access_seconds,billing_mode,publication_state,terms_revision,valid_from,created_at,created_by)
VALUES('dragon-30d-recurring-v1',1,'dragon','XTR',499,2592000,'recurring','approved',
 '2026-10-03.stars-recurring-v1',1791049764,1791049764,'v143-reviewed-recurring');
INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES('v143_recurring_price_seed',CASE WHEN
 (SELECT COUNT(*) FROM price_book WHERE price_id IN ('professional-30d-recurring-v1','dragon-30d-recurring-v1')
  AND price_version=1 AND currency='XTR' AND access_seconds=2592000 AND billing_mode='recurring'
  AND publication_state='approved' AND terms_revision='2026-10-03.stars-recurring-v1'
  AND valid_from=1791049764 AND valid_until IS NULL AND created_at=1791049764 AND created_by='v143-reviewed-recurring'
  AND ((price_id='professional-30d-recurring-v1' AND plan_code='professional' AND amount_stars=249)
    OR (price_id='dragon-30d-recurring-v1' AND plan_code='dragon' AND amount_stars=499)))=2 THEN 1 ELSE 0 END);
DELETE FROM mini_app_atomic_guards WHERE guard_key='v143_recurring_price_seed';

-- A createInvoiceLink attempt is not repeatable after an unknown result.
-- A confirmed URL is persisted for the same idempotent request/restart.
CREATE TABLE IF NOT EXISTS subscription_invoice_requests (
 request_id TEXT PRIMARY KEY CHECK(length(request_id)=36),
 idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 16 AND 160),
 contract_id TEXT NOT NULL UNIQUE REFERENCES subscription_billing_contracts(contract_id),
 origin_order_id TEXT NOT NULL UNIQUE REFERENCES subscription_orders(order_id),
 telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),
 expected_contract_revision INTEGER NOT NULL CHECK(typeof(expected_contract_revision)='integer' AND expected_contract_revision>0),
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL DEFAULT 'admitted' CHECK(state IN ('admitted','attempted','confirmed','rejected','unknown')),
 attempted_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempted_count)='integer' AND attempted_count IN (0,1)),
 attempted_at INTEGER,
 invoice_url TEXT CHECK(invoice_url IS NULL OR (length(invoice_url) BETWEEN 9 AND 2048 AND substr(invoice_url,1,8)='https://')),
 provider_result_sha256 TEXT CHECK(provider_result_sha256 IS NULL OR (length(provider_result_sha256)=64 AND provider_result_sha256 NOT GLOB '*[^0-9a-f]*')),
 error_code TEXT NOT NULL DEFAULT '' CHECK(length(error_code)<=64),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>0),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=created_at),
 CHECK((attempted_count=0 AND attempted_at IS NULL) OR (attempted_count=1 AND typeof(attempted_at)='integer' AND attempted_at>=created_at)),
 CHECK((state='confirmed' AND invoice_url IS NOT NULL AND provider_result_sha256 IS NOT NULL)
  OR (state!='confirmed' AND invoice_url IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_v143_invoice_request_own ON subscription_invoice_requests(telegram_id,created_at DESC,request_id);
CREATE INDEX IF NOT EXISTS idx_v143_invoice_request_review ON subscription_invoice_requests(state,updated_at,request_id);
CREATE TRIGGER IF NOT EXISTS v143_invoice_request_insert BEFORE INSERT ON subscription_invoice_requests
WHEN NEW.state!='admitted' OR NEW.attempted_count!=0 OR NEW.attempted_at IS NOT NULL OR NEW.invoice_url IS NOT NULL
 OR NEW.provider_result_sha256 IS NOT NULL OR NEW.error_code!='' OR NEW.revision!=1 OR NOT EXISTS(
 SELECT 1 FROM subscription_billing_contracts c JOIN subscription_orders o ON o.order_id=c.origin_order_id
 WHERE c.contract_id=NEW.contract_id AND c.origin_order_id=NEW.origin_order_id AND c.telegram_id=NEW.telegram_id
  AND c.revision=NEW.expected_contract_revision AND c.first_payment_ledger_entry_id IS NULL AND c.retired_at IS NULL
  AND o.telegram_id=NEW.telegram_id AND o.billing_mode='recurring' AND o.order_state='created'
  AND o.created_at<=NEW.created_at AND o.expires_at>NEW.created_at)
BEGIN SELECT RAISE(ABORT,'v143_invoice_request_admission_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v143_invoice_request_update BEFORE UPDATE ON subscription_invoice_requests
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.contract_id IS NOT OLD.contract_id
 OR NEW.origin_order_id IS NOT OLD.origin_order_id OR NEW.telegram_id IS NOT OLD.telegram_id
 OR NEW.expected_contract_revision IS NOT OLD.expected_contract_revision OR NEW.request_sha256 IS NOT OLD.request_sha256
 OR NEW.created_at IS NOT OLD.created_at OR NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at
 OR NOT ((OLD.state='admitted' AND NEW.state IN ('attempted','rejected'))
  OR (OLD.state='attempted' AND NEW.state IN ('confirmed','rejected','unknown'))
  OR (OLD.state='unknown' AND NEW.state IN ('confirmed','rejected')))
 OR (NEW.state IN ('attempted','confirmed','unknown') AND NEW.attempted_count!=1)
 OR (OLD.state='admitted' AND NEW.state='rejected' AND (NEW.attempted_count!=0 OR NEW.attempted_at IS NOT NULL))
 OR (NEW.attempted_count=1 AND NEW.updated_at<NEW.attempted_at)
 OR (OLD.attempted_count=1 AND (NEW.attempted_count!=1 OR NEW.attempted_at IS NOT OLD.attempted_at))
 OR (NEW.state='attempted' AND NOT EXISTS(SELECT 1 FROM subscription_billing_contracts c
  JOIN subscription_orders o ON o.order_id=c.origin_order_id WHERE c.contract_id=NEW.contract_id
   AND c.telegram_id=NEW.telegram_id AND c.revision=NEW.expected_contract_revision AND c.first_payment_ledger_entry_id IS NULL
   AND c.retired_at IS NULL AND o.order_id=NEW.origin_order_id AND o.telegram_id=NEW.telegram_id
   AND o.order_state='created' AND o.expires_at>NEW.attempted_at))
BEGIN SELECT RAISE(ABORT,'v143_invoice_request_transition_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v143_invoice_request_no_delete BEFORE DELETE ON subscription_invoice_requests
BEGIN SELECT RAISE(ABORT,'v143_invoice_request_retains_attempt'); END;

-- This owner decision binds an already recorded credit to its completed child.
-- operation_id intentionally has no forward FK: settlement is inserted BEFORE
-- that link in one atomic batch; fixed writer MUST assert final link+grant.
CREATE TABLE IF NOT EXISTS subscription_payment_review_settlements (
 ledger_entry_id TEXT PRIMARY KEY REFERENCES payment_ledger(ledger_entry_id),
 applied_order_id TEXT NOT NULL UNIQUE REFERENCES subscription_orders(order_id),
 operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id)=36),
 resolution_key TEXT NOT NULL UNIQUE CHECK(length(resolution_key) BETWEEN 16 AND 160),
 actor_id INTEGER NOT NULL CHECK(typeof(actor_id)='integer' AND actor_id>0),
 reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 3 AND 64),
 evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
 settled_at INTEGER NOT NULL CHECK(typeof(settled_at)='integer' AND settled_at>0)
);
CREATE INDEX IF NOT EXISTS idx_v143_review_settlement_actor ON subscription_payment_review_settlements(actor_id,settled_at,ledger_entry_id);
CREATE TRIGGER IF NOT EXISTS v143_review_settlement_binding BEFORE INSERT ON subscription_payment_review_settlements
WHEN NOT EXISTS(
 SELECT 1 FROM subscription_payment_review_receipts r JOIN payment_ledger p ON p.ledger_entry_id=r.ledger_entry_id
 JOIN subscription_orders origin ON origin.order_id=r.origin_order_id
 JOIN subscription_orders child ON child.order_id=NEW.applied_order_id
 WHERE r.ledger_entry_id=NEW.ledger_entry_id AND p.order_id=origin.order_id AND p.telegram_id=r.telegram_id
  AND p.entry_type='payment' AND p.direction='credit' AND p.currency='XTR' AND p.amount_stars=origin.amount_stars
  AND p.reason_code='payment_review_retained' AND r.recorded_at<=NEW.settled_at
  AND child.order_id!=origin.order_id AND child.order_state='applied' AND child.applied_at IS NOT NULL
  AND child.telegram_id=r.telegram_id AND child.plan_code=r.plan_code AND child.invoice_payload!=r.external_invoice_payload
  AND child.price_id=origin.price_id AND child.price_version=origin.price_version AND child.currency=origin.currency
  AND child.amount_stars=origin.amount_stars AND child.access_seconds=origin.access_seconds AND child.billing_mode=origin.billing_mode
  AND child.terms_revision=origin.terms_revision AND child.created_at=origin.created_at AND child.expires_at=origin.expires_at
  AND NOT EXISTS(SELECT 1 FROM payment_ledger compensation WHERE compensation.related_ledger_entry_id=p.ledger_entry_id
   AND compensation.entry_type IN ('refund','chargeback'))
  AND NOT EXISTS(SELECT 1 FROM subscription_payment_links l WHERE l.ledger_entry_id=p.ledger_entry_id)
  AND NOT EXISTS(SELECT 1 FROM subscription_access_grants g WHERE g.payment_ledger_entry_id=p.ledger_entry_id))
BEGIN SELECT RAISE(ABORT,'v143_review_settlement_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v143_review_settlement_no_update BEFORE UPDATE ON subscription_payment_review_settlements
BEGIN SELECT RAISE(ABORT,'v143_review_settlement_append_only'); END;
CREATE TRIGGER IF NOT EXISTS v143_review_settlement_no_delete BEFORE DELETE ON subscription_payment_review_settlements
BEGIN SELECT RAISE(ABORT,'v143_review_settlement_append_only'); END;


DROP TRIGGER IF EXISTS v143_payment_link_incoming_binding;
CREATE TRIGGER IF NOT EXISTS v143_payment_link_incoming_binding BEFORE INSERT ON subscription_payment_links
WHEN NEW.direction='incoming' AND NOT EXISTS(
 SELECT 1 FROM subscription_orders origin JOIN subscription_orders child ON child.order_id=NEW.applied_order_id
 JOIN payment_ledger p ON p.ledger_entry_id=NEW.ledger_entry_id
 WHERE origin.order_id=NEW.origin_order_id AND origin.telegram_id=NEW.telegram_id AND origin.plan_code=NEW.plan_code
 AND child.telegram_id=NEW.telegram_id AND child.plan_code=NEW.plan_code AND child.price_id=origin.price_id
 AND child.price_version=origin.price_version AND child.currency=origin.currency AND child.amount_stars=origin.amount_stars
 AND child.access_seconds=origin.access_seconds AND child.billing_mode=origin.billing_mode AND child.terms_revision=origin.terms_revision
 AND child.order_state IN ('paid','applied','refunded','chargeback') AND p.order_id=child.order_id AND p.telegram_id=NEW.telegram_id
 AND p.entry_type='payment' AND p.direction='credit' AND p.currency=child.currency AND p.amount_stars=child.amount_stars
 AND p.telegram_payment_charge_id=NEW.provider_charge_id
 AND ((NEW.link_kind='recurring_charge' AND EXISTS(
   SELECT 1 FROM subscription_billing_contracts c WHERE c.contract_id=NEW.contract_id AND c.origin_order_id=origin.order_id
   AND c.telegram_id=NEW.telegram_id AND c.plan_code=NEW.plan_code AND c.external_invoice_payload=NEW.external_invoice_payload
   AND c.external_payload_sha256=NEW.external_payload_sha256 AND child.billing_mode='recurring'
   AND (child.order_id=origin.order_id OR child.invoice_payload!=NEW.external_invoice_payload)))
 OR (NEW.link_kind='late_prepaid_charge' AND NEW.contract_id IS NULL AND origin.billing_mode='prepaid'
   AND origin.order_state IN ('failed','cancelled') AND child.order_id!=origin.order_id
   AND origin.invoice_payload=NEW.external_invoice_payload AND child.invoice_payload!=NEW.external_invoice_payload))) AND NOT EXISTS(
 SELECT 1 FROM subscription_payment_review_receipts r
 JOIN subscription_payment_review_settlements s ON s.ledger_entry_id=r.ledger_entry_id
 JOIN payment_ledger p ON p.ledger_entry_id=r.ledger_entry_id
 JOIN subscription_orders child ON child.order_id=s.applied_order_id
 WHERE s.operation_id=NEW.operation_id AND s.applied_order_id=NEW.applied_order_id
  AND r.ledger_entry_id=NEW.ledger_entry_id AND r.origin_order_id=NEW.origin_order_id
  AND r.contract_id IS NEW.contract_id AND r.telegram_id=NEW.telegram_id AND r.plan_code=NEW.plan_code
  AND r.external_invoice_payload=NEW.external_invoice_payload AND r.external_payload_sha256=NEW.external_payload_sha256
  AND r.evidence_sha256=NEW.evidence_sha256 AND r.provider_period_start IS NEW.provider_period_start
  AND r.provider_period_end IS NEW.provider_period_end
  AND p.order_id=r.origin_order_id AND p.telegram_id=NEW.telegram_id AND p.entry_type='payment' AND p.direction='credit'
  AND p.currency='XTR' AND p.amount_stars=child.amount_stars AND p.telegram_payment_charge_id=NEW.provider_charge_id
  AND child.order_state='applied' AND child.telegram_id=NEW.telegram_id AND child.plan_code=NEW.plan_code
  AND ((child.billing_mode='recurring' AND NEW.link_kind='recurring_charge' AND r.contract_id IS NOT NULL)
   OR (child.billing_mode='prepaid' AND NEW.link_kind='late_prepaid_charge' AND r.contract_id IS NULL)))
BEGIN SELECT RAISE(ABORT,'v143_payment_link_binding_invalid'); END;

DROP TRIGGER IF EXISTS v143_first_recurring_receipt_binding;
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
     AND prior_payment.amount_stars=c.amount_stars AND prior_payment.telegram_payment_charge_id=prior.provider_charge_id)))))) AND NOT EXISTS(
 SELECT 1 FROM subscription_billing_contracts c
 JOIN subscription_payment_review_receipts r ON r.contract_id=c.contract_id
 JOIN subscription_payment_review_settlements s ON s.ledger_entry_id=r.ledger_entry_id
 JOIN subscription_payment_links l ON l.operation_id=s.operation_id
 JOIN payment_ledger p ON p.ledger_entry_id=r.ledger_entry_id
 WHERE c.contract_id=NEW.contract_id AND c.first_payment_ledger_entry_id IS NULL
  AND r.is_first_recurring=1 AND r.ledger_entry_id=l.ledger_entry_id AND r.origin_order_id=c.origin_order_id
  AND r.telegram_id=c.telegram_id AND r.plan_code=c.plan_code AND r.external_invoice_payload=c.external_invoice_payload
  AND r.external_payload_sha256=c.external_payload_sha256 AND r.evidence_sha256=NEW.evidence_sha256
  AND l.operation_id=NEW.operation_id AND l.contract_id=c.contract_id AND l.direction='incoming' AND l.link_kind='recurring_charge'
  AND l.applied_order_id=s.applied_order_id AND l.origin_order_id=r.origin_order_id
  AND l.telegram_id=r.telegram_id AND l.plan_code=r.plan_code AND l.provider_charge_id=p.telegram_payment_charge_id
  AND l.evidence_sha256=r.evidence_sha256 AND l.external_invoice_payload=r.external_invoice_payload
  AND l.external_payload_sha256=r.external_payload_sha256
  AND l.provider_period_start=r.provider_period_start AND l.provider_period_end=r.provider_period_end
  AND l.recorded_at<=NEW.verified_at AND p.order_id=r.origin_order_id AND p.telegram_id=r.telegram_id
  AND p.entry_type='payment' AND p.direction='credit' AND p.currency=c.currency AND p.amount_stars=c.amount_stars)
BEGIN SELECT RAISE(ABORT,'v143_first_recurring_receipt_invalid'); END;

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
  AND l.ledger_entry_id=NEW.first_payment_ledger_entry_id AND (p.order_id=o.order_id OR EXISTS(SELECT 1 FROM subscription_payment_review_receipts retained
   JOIN subscription_payment_review_settlements settlement ON settlement.ledger_entry_id=retained.ledger_entry_id
   WHERE retained.ledger_entry_id=p.ledger_entry_id AND retained.origin_order_id=p.order_id
    AND settlement.applied_order_id=o.order_id AND settlement.operation_id=l.operation_id
    AND retained.contract_id=l.contract_id AND retained.telegram_id=p.telegram_id
    AND retained.evidence_sha256=l.evidence_sha256 AND retained.is_first_recurring=1))
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
 AND p.telegram_id=NEW.telegram_id AND (p.order_id=o.order_id OR EXISTS(SELECT 1 FROM subscription_payment_review_receipts retained
   JOIN subscription_payment_review_settlements settlement ON settlement.ledger_entry_id=retained.ledger_entry_id
   WHERE retained.ledger_entry_id=p.ledger_entry_id AND retained.origin_order_id=p.order_id
    AND settlement.applied_order_id=o.order_id AND settlement.operation_id=l.operation_id
    AND retained.contract_id=l.contract_id AND retained.telegram_id=p.telegram_id
    AND retained.evidence_sha256=l.evidence_sha256 AND retained.is_first_recurring=1)) AND p.entry_type='payment' AND p.direction='credit'
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
 AND NOT EXISTS(
 SELECT 1 FROM subscription_payment_review_receipts r
 JOIN subscription_payment_review_settlements s ON s.ledger_entry_id=r.ledger_entry_id
 JOIN payment_ledger p ON p.ledger_entry_id=r.ledger_entry_id
 JOIN subscription_payment_links l ON l.operation_id=s.operation_id
 JOIN subscription_orders child ON child.order_id=s.applied_order_id
 JOIN subscriptions projection ON projection.subscription_id=NEW.subscription_id
 WHERE r.ledger_entry_id=NEW.payment_ledger_entry_id AND s.applied_order_id=NEW.order_id
  AND p.order_id=r.origin_order_id AND p.telegram_id=NEW.telegram_id AND p.entry_type='payment' AND p.direction='credit'
  AND p.currency='XTR' AND p.amount_stars=child.amount_stars AND p.telegram_payment_charge_id=l.provider_charge_id
  AND r.telegram_id=NEW.telegram_id AND r.plan_code=NEW.plan_code
  AND child.order_state='applied' AND child.telegram_id=NEW.telegram_id AND child.plan_code=NEW.plan_code
  AND child.access_seconds=NEW.access_seconds AND child.order_id!=r.origin_order_id
  AND l.ledger_entry_id=r.ledger_entry_id AND l.applied_order_id=child.order_id AND l.origin_order_id=r.origin_order_id
  AND l.contract_id IS r.contract_id AND l.direction='incoming' AND l.telegram_id=NEW.telegram_id AND l.plan_code=NEW.plan_code
  AND l.evidence_sha256=r.evidence_sha256 AND l.external_invoice_payload=r.external_invoice_payload
  AND l.external_payload_sha256=r.external_payload_sha256
  AND l.provider_period_start IS r.provider_period_start AND l.provider_period_end IS r.provider_period_end
  AND projection.telegram_id=NEW.telegram_id AND projection.plan_code=NEW.plan_code AND projection.billing_mode=child.billing_mode
  AND NOT EXISTS(SELECT 1 FROM payment_ledger compensation WHERE compensation.related_ledger_entry_id=p.ledger_entry_id
   AND compensation.entry_type IN ('refund','chargeback'))
  AND ((child.billing_mode='recurring' AND l.link_kind='recurring_charge' AND r.contract_id IS NOT NULL
    AND NEW.starts_at=r.provider_period_start AND NEW.ends_at=r.provider_period_end
    AND EXISTS(SELECT 1 FROM subscription_payment_links source_link WHERE source_link.contract_id=r.contract_id
     AND source_link.direction='incoming' AND source_link.link_kind='recurring_charge'
     AND source_link.applied_order_id=projection.source_order_id AND source_link.provider_charge_id=projection.telegram_payment_charge_id
     AND source_link.telegram_id=NEW.telegram_id AND source_link.plan_code=NEW.plan_code))
   OR (child.billing_mode='prepaid' AND l.link_kind='late_prepaid_charge' AND r.contract_id IS NULL
    AND projection.last_ledger_entry_id=NEW.payment_ledger_entry_id AND projection.current_period_end=NEW.ends_at)))
BEGIN
  SELECT RAISE(ABORT, 'access grant is not backed by an applied payment');
END;

DROP TRIGGER IF EXISTS trg_subscription_access_grants_compensation_guard;
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
    AND (compensation.order_id = NEW.order_id OR EXISTS(
      SELECT 1 FROM subscription_payment_review_receipts retained
      JOIN subscription_payment_review_settlements settlement ON settlement.ledger_entry_id=retained.ledger_entry_id
      WHERE retained.ledger_entry_id=original.ledger_entry_id AND retained.origin_order_id=original.order_id
        AND compensation.order_id=retained.origin_order_id AND settlement.applied_order_id=NEW.order_id
        AND retained.telegram_id=NEW.telegram_id AND retained.plan_code=NEW.plan_code
        AND EXISTS(SELECT 1 FROM subscription_payment_links settled_link WHERE settled_link.operation_id=settlement.operation_id
          AND settled_link.ledger_entry_id=retained.ledger_entry_id AND settled_link.applied_order_id=NEW.order_id
          AND settled_link.evidence_sha256=retained.evidence_sha256)))
    AND compensation.telegram_id = NEW.telegram_id
    AND compensation.currency = original.currency
    AND compensation.amount_stars = original.amount_stars
    AND compensation.telegram_payment_charge_id =
      original.telegram_payment_charge_id
)
BEGIN
  SELECT RAISE(ABORT, 'access compensation does not match its payment');
END;

INSERT OR IGNORE INTO re_schema_migrations(version) VALUES('1.4.3-provider-and-review-binding');
