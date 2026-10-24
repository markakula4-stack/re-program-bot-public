-- Marker: 1.4.4-provider-inactive-exit
-- Exact replacement only; the reviewed transactional controller records its marker.
-- Native actor, bot, invoice HMAC and evidence-digest assertions remain mandatory.
DROP TRIGGER v144_package_period_binding;
CREATE TRIGGER v144_package_period_binding BEFORE INSERT ON subscription_package_periods
WHEN NOT EXISTS(SELECT 1 FROM subscription_package_orders m JOIN subscription_orders o ON o.order_id=m.order_id
 JOIN price_book p ON p.price_id=o.price_id JOIN payment_ledger paid ON paid.order_id=o.order_id
 WHERE m.order_id=NEW.order_id AND o.telegram_id=NEW.telegram_id AND m.telegram_id=NEW.telegram_id
 AND o.plan_code=NEW.plan_code AND m.plan_code=NEW.plan_code AND o.billing_mode='prepaid' AND m.billing_mode='prepaid'
 AND o.order_state IN ('paid','applied') AND o.paid_at IS NOT NULL
 AND o.price_id=NEW.price_id AND m.price_id=NEW.price_id AND p.price_id=NEW.price_id
 AND o.price_version=NEW.price_version AND m.price_version=NEW.price_version AND p.price_version=NEW.price_version
 AND p.plan_code=NEW.plan_code AND p.billing_mode='prepaid' AND p.currency='XTR'
 AND p.amount_stars=o.amount_stars AND m.amount_stars=o.amount_stars
 AND p.access_seconds=NEW.period_seconds AND m.period_seconds=NEW.period_seconds AND o.access_seconds=NEW.period_seconds
 AND m.transition_id IS NEW.transition_id AND paid.ledger_entry_id=NEW.payment_ledger_entry_id
 AND paid.telegram_id=NEW.telegram_id AND paid.entry_type='payment' AND paid.direction='credit'
 AND paid.currency=o.currency AND paid.currency='XTR' AND paid.amount_stars=o.amount_stars
 AND paid.related_ledger_entry_id IS NULL AND paid.telegram_payment_charge_id IS NOT NULL
 AND paid.occurred_at>=o.created_at AND paid.recorded_at<=NEW.recorded_at AND o.paid_at<=NEW.recorded_at
 AND NEW.starts_at=MAX(m.quoted_starts_at,paid.occurred_at) AND NEW.recorded_at>=m.created_at
 AND (m.source_paid_until IS NULL OR NEW.starts_at>=m.source_paid_until)
 AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=paid.ledger_entry_id AND r.entry_type IN ('refund','chargeback')))
 -- Prepaid refunds can compact surviving old grants. The old current
 -- projection, verified alongside the source assertions, is the paid residue;
 -- checking raw historical grant intervals here would reject legitimate buys.
 OR EXISTS(SELECT 1 FROM subscriptions s WHERE s.telegram_id=NEW.telegram_id
  AND s.status IN ('active','cancel_at_period_end','suspended') AND s.current_period_end>NEW.starts_at)
 OR EXISTS(SELECT 1 FROM subscription_access_grants g WHERE g.payment_ledger_entry_id=NEW.payment_ledger_entry_id OR g.order_id=NEW.order_id)
 -- An open recurring contract needs an exact acknowledgement of cancellation.
 -- A provider control state by itself is not an acknowledgement or a payment.
 -- Retired contracts remain governed by the existing retirement/refund proof.
 OR EXISTS(SELECT 1 FROM subscription_billing_contracts c WHERE c.telegram_id=NEW.telegram_id AND c.retired_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands cmd JOIN subscription_provider_events ack ON ack.event_id=cmd.acknowledgement_event_id
   WHERE cmd.contract_id=c.contract_id AND cmd.telegram_id=NEW.telegram_id AND cmd.action='cancel_renewal' AND cmd.desired_auto_renew=0
   AND cmd.state='confirmed' AND cmd.attempted_count=1 AND cmd.expected_contract_revision=c.revision
   AND cmd.first_payment_ledger_entry_id=c.first_payment_ledger_entry_id AND c.first_payment_ledger_entry_id IS NOT NULL
   AND ack.command_id=cmd.command_id AND ack.contract_id=c.contract_id AND ack.telegram_id=NEW.telegram_id
   AND ack.event_type='command_confirmed' AND ack.source='provider_response' AND ack.received_at<=NEW.recorded_at
   AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands pending WHERE pending.contract_id=c.contract_id AND pending.state IN ('admitted','attempted','unknown'))
   AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands later WHERE later.contract_id=c.contract_id AND later.state='confirmed'
    AND later.command_id!=cmd.command_id AND later.attempted_at>=cmd.attempted_at)
   AND NOT EXISTS(SELECT 1 FROM subscription_provider_events later WHERE later.contract_id=c.contract_id
    AND later.received_at>=cmd.attempted_at AND ((later.source='telegram_update' AND later.provider_state IN ('active','failed')) OR later.event_type='review_observed'))))
 AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands inactive
  CROSS JOIN subscription_billing_contracts c
  CROSS JOIN subscription_provider_events rejected
  CROSS JOIN (SELECT id,actor_id,entity_id,created_at,
   CASE WHEN json_valid(details) THEN details ELSE '{}' END AS diagnostic
   FROM admin_audit_log WHERE action='subscription_provider_diagnostic' AND entity_type='subscription_provider_command') audit
  CROSS JOIN payment_ledger first
  CROSS JOIN subscription_orders origin
  CROSS JOIN price_book original_price
  CROSS JOIN terms_acceptances consent
  CROSS JOIN subscription_first_recurring_receipts receipt
  CROSS JOIN subscription_payment_links incoming
  CROSS JOIN subscription_orders applied
  CROSS JOIN payment_ledger reversal
  CROSS JOIN payment_refunds refund
  CROSS JOIN subscription_access_grants grant_row
  WHERE (((((((c.telegram_id=NEW.telegram_id
  AND c.retired_at IS NULL)
  AND (rejected.command_id=inactive.command_id
  AND audit.entity_id=inactive.command_id))
  AND ((audit.actor_id=8987576334
  AND first.ledger_entry_id=c.first_payment_ledger_entry_id)
  AND (origin.order_id=c.origin_order_id
  AND (original_price.price_id=origin.price_id
  AND consent.acceptance_id=c.terms_acceptance_id))))
  AND (((receipt.contract_id=c.contract_id
  AND incoming.operation_id=receipt.operation_id)
  AND (applied.order_id=incoming.applied_order_id
  AND (reversal.related_ledger_entry_id=first.ledger_entry_id
  AND refund.original_ledger_entry_id=first.ledger_entry_id)))
  AND ((grant_row.payment_ledger_entry_id=first.ledger_entry_id
  AND NEW.telegram_id=8987576334)
  AND (c.telegram_id=8987576334
  AND (c.billing_mode='recurring'
  AND c.plan_code='professional')))))
  AND ((((c.currency='XTR'
  AND c.amount_stars=249)
  AND (c.period_seconds=2592000
  AND c.terms_revision='2026-10-03.stars-recurring-v1'))
  AND ((origin.telegram_id=c.telegram_id
  AND origin.plan_code=c.plan_code)
  AND (origin.price_id=c.price_id
  AND (origin.price_version=1
  AND origin.currency=c.currency))))
  AND (((origin.amount_stars=c.amount_stars
  AND origin.access_seconds=c.period_seconds)
  AND (origin.billing_mode='recurring'
  AND (origin.terms_revision=c.terms_revision
  AND origin.invoice_payload=c.external_invoice_payload)))
  AND ((original_price.price_version=1
  AND original_price.plan_code=c.plan_code)
  AND (original_price.currency=c.currency
  AND (original_price.amount_stars=c.amount_stars
  AND original_price.access_seconds=c.period_seconds))))))
  AND (((((original_price.billing_mode='recurring'
  AND original_price.terms_revision=c.terms_revision)
  AND (original_price.publication_state IN ('approved','retired')
  AND original_price.valid_from<=origin.created_at))
  AND (((original_price.valid_until IS NULL OR original_price.valid_until>origin.created_at)
  AND consent.telegram_id=c.telegram_id)
  AND (consent.acceptance_scope='stars_purchase'
  AND (consent.terms_revision=c.terms_revision
  AND consent.accepted_at<=origin.created_at))))
  AND (((length(consent.evidence_sha256)=64
  AND first.telegram_id=c.telegram_id)
  AND (first.entry_type='payment'
  AND (first.direction='credit'
  AND first.currency='XTR')))
  AND ((first.amount_stars=249
  AND first.related_ledger_entry_id IS NULL)
  AND (first.telegram_payment_charge_id IS NOT NULL
  AND (incoming.contract_id=c.contract_id
  AND incoming.telegram_id=c.telegram_id)))))
  AND ((((incoming.origin_order_id=origin.order_id
  AND incoming.direction='incoming')
  AND (incoming.link_kind='recurring_charge'
  AND incoming.ledger_entry_id=first.ledger_entry_id))
  AND ((incoming.original_payment_ledger_entry_id IS NULL
  AND incoming.plan_code=c.plan_code)
  AND (incoming.provider_charge_id=first.telegram_payment_charge_id
  AND (incoming.external_invoice_payload=c.external_invoice_payload
  AND incoming.external_payload_sha256=c.external_payload_sha256))))
  AND (((incoming.evidence_sha256=receipt.evidence_sha256
  AND incoming.provider_period_start>0)
  AND (incoming.provider_period_end=incoming.provider_period_start+c.period_seconds
  AND (incoming.recorded_at<=receipt.verified_at
  AND receipt.verified_at>0)))
  AND ((length(receipt.evidence_sha256)=64
  AND applied.telegram_id=c.telegram_id)
  AND (applied.plan_code=c.plan_code
  AND (applied.billing_mode='recurring'
  AND applied.currency='XTR')))))))
  AND ((((((applied.amount_stars=249
  AND applied.access_seconds=2592000)
  AND ((first.order_id=applied.order_id OR EXISTS(SELECT 1 FROM subscription_payment_review_receipts retained
   JOIN subscription_payment_review_settlements settled ON settled.ledger_entry_id=retained.ledger_entry_id
   WHERE retained.ledger_entry_id=first.ledger_entry_id AND retained.origin_order_id=first.order_id
    AND retained.contract_id=c.contract_id AND retained.telegram_id=c.telegram_id AND retained.is_first_recurring=1
    AND retained.evidence_sha256=incoming.evidence_sha256 AND settled.applied_order_id=applied.order_id
    AND settled.operation_id=incoming.operation_id AND settled.actor_id=8987576334))
  AND grant_row.telegram_id=c.telegram_id))
  AND ((grant_row.order_id=applied.order_id
  AND grant_row.plan_code=c.plan_code)
  AND (grant_row.status='refunded'
  AND (grant_row.compensation_ledger_entry_id=reversal.ledger_entry_id
  AND reversal.telegram_id=c.telegram_id))))
  AND (((reversal.order_id=first.order_id
  AND reversal.entry_type='refund')
  AND (reversal.direction='debit'
  AND (reversal.currency='XTR'
  AND reversal.amount_stars=249)))
  AND ((reversal.telegram_payment_charge_id=first.telegram_payment_charge_id
  AND reversal.recorded_at>=reversal.occurred_at)
  AND (reversal.occurred_at>=first.occurred_at
  AND ((SELECT COUNT(*) FROM payment_ledger r WHERE r.related_ledger_entry_id=first.ledger_entry_id AND r.entry_type IN ('refund','chargeback'))=1
  AND refund.telegram_id=c.telegram_id)))))
  AND ((((refund.order_id=first.order_id
  AND refund.status='applied')
  AND (refund.currency='XTR'
  AND refund.amount_stars=249))
  AND ((refund.telegram_payment_charge_id=first.telegram_payment_charge_id
  AND refund.requested_by_type='admin')
  AND (refund.requested_by=8987576334
  AND (refund.reason_code='admin_canary_validation'
  AND typeof(refund.applied_at)='integer'))))
  AND (((refund.applied_at>0
  AND inactive.contract_id=c.contract_id)
  AND (inactive.telegram_id=c.telegram_id
  AND (inactive.action='cancel_renewal'
  AND inactive.desired_auto_renew=0)))
  AND ((inactive.state='rejected'
  AND inactive.attempted_count=1)
  AND (inactive.expected_contract_revision=c.revision
  AND (inactive.first_payment_ledger_entry_id=first.ledger_entry_id
  AND inactive.acknowledgement_event_id IS NULL))))))
  AND (((((inactive.error_code='telegram_400_detail_29b36909890ff6ff'
  AND inactive.attempted_at>MAX(refund.applied_at,reversal.recorded_at))
  AND (rejected.contract_id=c.contract_id
  AND rejected.telegram_id=c.telegram_id))
  AND ((rejected.event_type='command_rejected'
  AND rejected.source='provider_response')
  AND (rejected.actor_type='system'
  AND (rejected.actor_id IS NULL
  AND rejected.operation_id IS NULL))))
  AND (((rejected.telegram_update_id IS NULL
  AND rejected.provider_state IS NULL)
  AND (rejected.provider_occurred_at IS NULL
  AND (rejected.reason_code=inactive.error_code
  AND rejected.received_at>=inactive.attempted_at)))
  AND ((rejected.received_at<=NEW.recorded_at
  AND inactive.updated_at=rejected.received_at)
  AND ((SELECT COUNT(*) FROM subscription_provider_events e WHERE e.command_id=inactive.command_id AND e.event_type='command_rejected')=1
  AND ((SELECT COUNT(*) FROM admin_audit_log a WHERE a.entity_id=inactive.command_id AND a.actor_id=8987576334
   AND a.action='subscription_provider_diagnostic' AND a.entity_type='subscription_provider_command')=1
  AND typeof(unixepoch(audit.created_at))='integer')))))
  AND ((((unixepoch(audit.created_at)>=rejected.received_at
  AND unixepoch(audit.created_at)<=NEW.recorded_at)
  AND (json_extract(audit.diagnostic,'$.version')=1
  AND (json_extract(audit.diagnostic,'$.method')='editUserStarSubscription'
  AND json_extract(audit.diagnostic,'$.code')=inactive.error_code)))
  AND ((json_extract(audit.diagnostic,'$.httpStatus')=400
  AND json_extract(audit.diagnostic,'$.apiErrorCode')=400)
  AND (json_extract(audit.diagnostic,'$.descriptionCode')='unclassified'
  AND (json_extract(audit.diagnostic,'$.descriptionSafe')='Bad Request: SUBSCRIPTION_NOT_ACTIVE'
  AND json_extract(audit.diagnostic,'$.descriptionSha256')='29b36909890ff6ffc0230f02a03f07eb00465af871a8ebbb21f9c222d61a0b0e'))))
  AND (((json_type(audit.diagnostic,'$.descriptionTruncated')='false'
  AND NOT EXISTS(SELECT 1 FROM subscription_billing_contracts other WHERE other.telegram_id=c.telegram_id AND other.retired_at IS NULL AND other.contract_id!=c.contract_id))
  AND (NOT EXISTS(SELECT 1 FROM subscription_provider_commands newer WHERE newer.contract_id=c.contract_id AND newer.command_id!=inactive.command_id
   AND (newer.created_at>=rejected.received_at OR newer.updated_at>rejected.received_at OR newer.state IN ('admitted','attempted','unknown')))
  AND (NOT EXISTS(SELECT 1 FROM subscription_provider_commands enabled WHERE enabled.contract_id=c.contract_id AND enabled.state='confirmed' AND enabled.action='reenable_renewal'
   AND (enabled.attempted_at>=inactive.attempted_at OR NOT EXISTS(SELECT 1 FROM subscription_provider_events enable_ack
    WHERE enable_ack.event_id=enabled.acknowledgement_event_id AND enable_ack.command_id=enabled.command_id
     AND enable_ack.source='provider_response' AND enable_ack.event_type='command_confirmed' AND enable_ack.received_at<inactive.attempted_at)))
  AND NOT EXISTS(SELECT 1 FROM subscription_provider_events newer WHERE newer.contract_id=c.contract_id AND newer.event_id!=rejected.event_id
   AND newer.event_type!='lifecycle_transition' AND newer.received_at>=rejected.received_at))))
  AND ((NOT EXISTS(SELECT 1 FROM subscription_provider_events review WHERE review.contract_id=c.contract_id AND review.event_type='review_observed')
  AND NOT EXISTS(SELECT 1 FROM payment_refunds unsettled WHERE unsettled.telegram_id=c.telegram_id AND unsettled.status IN ('requested','confirmed','manual_review')))
  AND (NOT EXISTS(SELECT 1 FROM subscription_access_grants active_grant WHERE active_grant.telegram_id=c.telegram_id AND active_grant.status='active' AND active_grant.ends_at>rejected.received_at)
  AND (NOT EXISTS(SELECT 1 FROM subscription_payment_links other_charge LEFT JOIN payment_ledger paid_charge ON paid_charge.ledger_entry_id=other_charge.ledger_entry_id
   WHERE other_charge.contract_id=c.contract_id AND other_charge.direction='incoming' AND (paid_charge.ledger_entry_id IS NULL
    OR paid_charge.recorded_at>rejected.received_at OR NOT EXISTS(SELECT 1 FROM payment_ledger refunded_charge
     WHERE (((refunded_charge.related_ledger_entry_id=paid_charge.ledger_entry_id
  AND refunded_charge.entry_type='refund')
  AND (refunded_charge.direction='debit'
  AND refunded_charge.telegram_id=c.telegram_id))
  AND ((refunded_charge.order_id=paid_charge.order_id
  AND refunded_charge.currency=paid_charge.currency)
  AND (refunded_charge.amount_stars=paid_charge.amount_stars
  AND (refunded_charge.telegram_payment_charge_id=paid_charge.telegram_payment_charge_id
  AND refunded_charge.recorded_at<=rejected.received_at)))))))
  AND NOT EXISTS(SELECT 1 FROM subscription_payment_review_receipts retained WHERE retained.contract_id=c.contract_id
   AND (retained.recorded_at>rejected.received_at OR NOT EXISTS(SELECT 1 FROM payment_ledger retained_payment JOIN payment_ledger retained_refund
    ON retained_refund.related_ledger_entry_id=retained_payment.ledger_entry_id WHERE (((retained_payment.ledger_entry_id=retained.ledger_entry_id
  AND retained_refund.entry_type='refund')
  AND (retained_refund.direction='debit'
  AND retained_refund.telegram_id=c.telegram_id))
  AND ((retained_refund.order_id=retained_payment.order_id
  AND retained_refund.currency=retained_payment.currency)
  AND (retained_refund.amount_stars=retained_payment.amount_stars
  AND (retained_refund.telegram_payment_charge_id=retained_payment.telegram_payment_charge_id
  AND retained_refund.recorded_at<=rejected.received_at))))))))))))))))
 OR EXISTS(SELECT 1 FROM subscription_package_periods pp WHERE pp.telegram_id=NEW.telegram_id
  AND pp.starts_at<NEW.ends_at AND pp.ends_at>NEW.starts_at
  AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=pp.payment_ledger_entry_id AND r.entry_type IN ('refund','chargeback')))
 OR (NEW.transition_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_plan_transitions t
  WHERE t.transition_id=NEW.transition_id AND t.telegram_id=NEW.telegram_id AND t.state='scheduled'
  AND t.to_plan=NEW.plan_code AND t.to_billing_mode=NEW.billing_mode AND t.target_price_id=NEW.price_id
  AND t.target_price_version=NEW.price_version AND t.period_seconds=NEW.period_seconds AND t.effective_at<=NEW.starts_at))
BEGIN SELECT RAISE(ABORT,'v144_package_period_binding_invalid'); END;
