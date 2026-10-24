-- Additive candidate only: confirmed refund is not provider cancellation.
-- Keep all original charges, links, grants and contract identity. No flags or
-- money rows change; future periods require exact full refunds before retirement.
CREATE TABLE subscription_refund_cancellations (
 refund_id TEXT PRIMARY KEY REFERENCES payment_refunds(refund_id),
 refund_ledger_entry_id TEXT NOT NULL UNIQUE REFERENCES payment_ledger(ledger_entry_id),
 contract_id TEXT NOT NULL REFERENCES subscription_billing_contracts(contract_id),
 telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),
 command_id TEXT NOT NULL UNIQUE REFERENCES subscription_provider_commands(command_id),
 actor_id INTEGER NOT NULL CHECK(typeof(actor_id)='integer' AND actor_id>0),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at>0)
);
CREATE TRIGGER v143_refund_cancellation_binding BEFORE INSERT ON subscription_refund_cancellations
WHEN NOT EXISTS(SELECT 1 FROM payment_refunds r JOIN payment_ledger paid ON paid.ledger_entry_id=r.original_ledger_entry_id
 JOIN payment_ledger refund ON refund.related_ledger_entry_id=paid.ledger_entry_id
 JOIN subscription_provider_commands cmd ON cmd.command_id=NEW.command_id
 JOIN subscription_billing_contracts c ON c.contract_id=cmd.contract_id
 WHERE r.refund_id=NEW.refund_id AND r.status='applied' AND r.requested_by_type='admin'
 AND refund.ledger_entry_id=NEW.refund_ledger_entry_id AND refund.entry_type='refund' AND refund.direction='debit'
 AND refund.telegram_id=NEW.telegram_id AND refund.currency=r.currency AND refund.amount_stars=r.amount_stars
 AND paid.entry_type='payment' AND paid.direction='credit' AND paid.telegram_id=NEW.telegram_id
 AND paid.currency=r.currency AND paid.amount_stars=r.amount_stars AND paid.telegram_payment_charge_id=r.telegram_payment_charge_id
 AND r.telegram_id=NEW.telegram_id AND c.telegram_id=NEW.telegram_id AND c.contract_id=NEW.contract_id
 AND cmd.telegram_id=NEW.telegram_id AND cmd.action='cancel_renewal' AND cmd.desired_auto_renew=0
 AND cmd.state='admitted' AND cmd.attempted_count=0 AND cmd.first_payment_ledger_entry_id=c.first_payment_ledger_entry_id
 AND c.retired_at IS NULL AND cmd.expected_contract_revision=c.revision
 AND (EXISTS(SELECT 1 FROM subscription_payment_links l WHERE l.ledger_entry_id=paid.ledger_entry_id
   AND l.direction='incoming' AND l.contract_id=c.contract_id AND l.telegram_id=c.telegram_id)
  OR EXISTS(SELECT 1 FROM subscription_payment_review_receipts retained WHERE retained.ledger_entry_id=paid.ledger_entry_id
   AND retained.contract_id=c.contract_id AND retained.telegram_id=c.telegram_id)))
BEGIN SELECT RAISE(ABORT,'v143_refund_cancellation_invalid'); END;
CREATE TRIGGER v143_refund_cancellation_no_update BEFORE UPDATE ON subscription_refund_cancellations
BEGIN SELECT RAISE(ABORT,'v143_refund_cancellation_append_only'); END;
CREATE TRIGGER v143_refund_cancellation_no_delete BEFORE DELETE ON subscription_refund_cancellations
BEGIN SELECT RAISE(ABORT,'v143_refund_cancellation_append_only'); END;

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
   OR (NEW.first_payment_ledger_entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM subscription_provider_commands cmd
 JOIN subscription_provider_events ack ON ack.event_id=cmd.acknowledgement_event_id
 JOIN subscription_refund_cancellations linked ON linked.command_id=cmd.command_id
 WHERE cmd.contract_id=NEW.contract_id AND cmd.telegram_id=NEW.telegram_id AND cmd.action='cancel_renewal'
 AND cmd.desired_auto_renew=0 AND cmd.state='confirmed' AND cmd.attempted_count=1
 AND cmd.first_payment_ledger_entry_id=NEW.first_payment_ledger_entry_id AND cmd.expected_contract_revision=OLD.revision
 AND ack.command_id=cmd.command_id AND ack.contract_id=NEW.contract_id AND ack.telegram_id=NEW.telegram_id
 AND ack.event_type='command_confirmed' AND ack.source='provider_response' AND ack.provider_state IS NULL
 AND linked.contract_id=NEW.contract_id AND linked.telegram_id=NEW.telegram_id
 AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands other WHERE other.contract_id=NEW.contract_id
   AND other.state='confirmed' AND other.command_id!=cmd.command_id AND other.attempted_at>=cmd.attempted_at)
 AND NOT EXISTS(SELECT 1 FROM subscription_provider_events later WHERE later.contract_id=NEW.contract_id
   AND ((later.source='telegram_update' AND later.received_at>=cmd.attempted_at
       AND NOT (later.event_id IS NEW.last_provider_event_id AND later.received_at<=cmd.attempted_at))
     OR later.event_type='review_observed'))) AND 
 NOT EXISTS(SELECT 1 FROM subscription_provider_commands pending WHERE pending.contract_id=NEW.contract_id
   AND pending.state IN ('admitted','attempted','unknown'))
 AND NOT EXISTS(SELECT 1 FROM subscription_payment_links l JOIN subscription_orders o ON o.order_id=l.applied_order_id
   JOIN payment_ledger paid ON paid.ledger_entry_id=l.ledger_entry_id
   WHERE l.contract_id=NEW.contract_id AND l.direction='incoming'
   AND (l.provider_period_end>NEW.retired_at OR o.order_state='paid')
   AND NOT EXISTS(SELECT 1 FROM payment_ledger refund WHERE refund.related_ledger_entry_id=paid.ledger_entry_id
     AND refund.entry_type='refund' AND refund.direction='debit' AND refund.telegram_id=paid.telegram_id
     AND refund.currency=paid.currency AND refund.amount_stars=paid.amount_stars))
 AND NOT EXISTS(SELECT 1 FROM subscription_access_grants g JOIN subscription_payment_links l
   ON l.ledger_entry_id=g.payment_ledger_entry_id WHERE l.contract_id=NEW.contract_id AND g.status='active' AND g.ends_at>NEW.retired_at)
 AND NOT EXISTS(SELECT 1 FROM subscription_payment_review_receipts r JOIN payment_ledger paid ON paid.ledger_entry_id=r.ledger_entry_id
   WHERE r.contract_id=NEW.contract_id AND NOT EXISTS(SELECT 1 FROM subscription_payment_review_settlements settled
     WHERE settled.ledger_entry_id=paid.ledger_entry_id)
   AND NOT EXISTS(SELECT 1 FROM payment_ledger refund WHERE refund.related_ledger_entry_id=paid.ledger_entry_id
     AND refund.entry_type='refund' AND refund.direction='debit' AND refund.telegram_id=paid.telegram_id
     AND refund.currency=paid.currency AND refund.amount_stars=paid.amount_stars)))
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

INSERT INTO re_schema_migrations(version) VALUES('1.4.3-refund-contract-retirement');
