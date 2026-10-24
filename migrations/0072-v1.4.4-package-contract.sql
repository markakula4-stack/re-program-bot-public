-- v1.4.4 Part 1: additive, inactive package/next-period foundations.
-- No existing object, price, user, ledger, access grant or projection changes.
-- Quotes are estimates. Paid periods refer to the existing incoming ledger;
-- neither a quote nor a scheduled intent grants current access. Apply only
-- through a reviewed later expand controller, never automatically at startup.

CREATE TABLE IF NOT EXISTS subscription_package_orders (
 order_id TEXT PRIMARY KEY REFERENCES subscription_orders(order_id),
 telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),
 contract_version TEXT NOT NULL CHECK(length(contract_version) BETWEEN 8 AND 96),
 package_code TEXT NOT NULL CHECK(package_code IN ('30d','3m','6m','12m')),
 duration_days INTEGER NOT NULL CHECK(typeof(duration_days)='integer' AND duration_days IN (30,90,180,360)),
 period_seconds INTEGER NOT NULL CHECK(typeof(period_seconds)='integer' AND period_seconds=duration_days*86400),
 price_id TEXT NOT NULL REFERENCES price_book(price_id),
 price_version INTEGER NOT NULL CHECK(typeof(price_version)='integer' AND price_version>0),
 plan_code TEXT NOT NULL CHECK(plan_code IN ('professional','dragon')),
 billing_mode TEXT NOT NULL CHECK(billing_mode IN ('prepaid','recurring')),
 currency TEXT NOT NULL CHECK(currency='XTR'),
 amount_stars INTEGER NOT NULL CHECK(typeof(amount_stars)='integer' AND amount_stars BETWEEN 1 AND 10000),
 offer_version TEXT NOT NULL CHECK(length(offer_version) BETWEEN 8 AND 96),
 campaign_code TEXT CHECK(campaign_code IS NULL OR (length(campaign_code) BETWEEN 1 AND 64 AND campaign_code NOT GLOB '*[^A-Za-z0-9._:-]*')),
 quoted_starts_at INTEGER NOT NULL CHECK(typeof(quoted_starts_at)='integer' AND quoted_starts_at>0),
 quoted_ends_at INTEGER NOT NULL CHECK(typeof(quoted_ends_at)='integer' AND quoted_ends_at=quoted_starts_at+period_seconds),
 source_subscription_id TEXT REFERENCES subscriptions(subscription_id),
 source_package_period_id TEXT REFERENCES subscription_package_periods(period_id),
 source_paid_until INTEGER,
 source_revision INTEGER,
 source_payment_ledger_entry_id TEXT REFERENCES payment_ledger(ledger_entry_id),
 source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint)=64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
 transition_id TEXT REFERENCES subscription_plan_transitions(transition_id),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0 AND quoted_starts_at>=created_at),
 CHECK((package_code='30d' AND duration_days=30) OR (package_code='3m' AND duration_days=90)
  OR (package_code='6m' AND duration_days=180) OR (package_code='12m' AND duration_days=360)),
 CHECK(billing_mode='prepaid' OR package_code='30d'),
 CHECK((source_subscription_id IS NULL AND source_package_period_id IS NULL AND source_paid_until IS NULL
    AND source_revision IS NULL AND source_payment_ledger_entry_id IS NULL)
  OR (((source_subscription_id IS NOT NULL AND source_package_period_id IS NULL)
     OR (source_subscription_id IS NULL AND source_package_period_id IS NOT NULL))
    AND typeof(source_paid_until)='integer' AND source_paid_until>created_at
    AND typeof(source_revision)='integer' AND source_revision>0 AND source_payment_ledger_entry_id IS NOT NULL
    AND quoted_starts_at=source_paid_until))
);
CREATE INDEX IF NOT EXISTS idx_v144_package_order_own ON subscription_package_orders(telegram_id,created_at DESC,order_id);
CREATE TRIGGER IF NOT EXISTS v144_package_order_binding BEFORE INSERT ON subscription_package_orders
WHEN NOT EXISTS(SELECT 1 FROM subscription_orders o JOIN price_book p ON p.price_id=o.price_id
 WHERE o.order_id=NEW.order_id AND o.telegram_id=NEW.telegram_id AND o.plan_code=NEW.plan_code
 AND o.price_id=NEW.price_id AND o.price_version=NEW.price_version AND o.currency=NEW.currency
 AND o.amount_stars=NEW.amount_stars AND o.access_seconds=NEW.period_seconds AND o.billing_mode=NEW.billing_mode
 AND o.order_state IN ('created','precheckout_ok') AND o.created_at<=NEW.created_at AND o.expires_at>NEW.created_at
 AND p.price_version=NEW.price_version AND p.plan_code=NEW.plan_code AND p.currency=NEW.currency
 AND p.amount_stars=NEW.amount_stars AND p.access_seconds=NEW.period_seconds AND p.billing_mode=NEW.billing_mode)
 OR (NEW.source_subscription_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscriptions s
  JOIN subscription_access_grants g ON g.subscription_id=s.subscription_id
  JOIN payment_ledger paid ON paid.ledger_entry_id=g.payment_ledger_entry_id
  WHERE s.subscription_id=NEW.source_subscription_id AND s.telegram_id=NEW.telegram_id
  AND s.revision=NEW.source_revision AND s.current_period_end=NEW.source_paid_until
  AND s.status IN ('active','cancel_at_period_end') AND g.telegram_id=NEW.telegram_id AND g.status='active'
  AND g.payment_ledger_entry_id=NEW.source_payment_ledger_entry_id
  AND paid.telegram_id=NEW.telegram_id AND paid.entry_type='payment' AND paid.direction='credit'
  AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=paid.ledger_entry_id AND r.entry_type IN ('refund','chargeback'))))
 OR (NEW.source_package_period_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_package_periods pp
  WHERE pp.period_id=NEW.source_package_period_id AND pp.telegram_id=NEW.telegram_id AND pp.ends_at=NEW.source_paid_until
  AND pp.payment_ledger_entry_id=NEW.source_payment_ledger_entry_id AND NEW.source_revision=1
  AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=pp.payment_ledger_entry_id AND r.entry_type IN ('refund','chargeback'))))
 OR (NEW.transition_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_plan_transitions t
  WHERE t.transition_id=NEW.transition_id AND t.telegram_id=NEW.telegram_id AND t.state='scheduled'
  AND t.to_plan=NEW.plan_code AND t.to_billing_mode=NEW.billing_mode AND t.target_package_code=NEW.package_code
  AND t.target_price_id=NEW.price_id AND t.target_price_version=NEW.price_version AND t.period_seconds=NEW.period_seconds
  AND t.offer_version=NEW.offer_version AND t.campaign_code IS NEW.campaign_code
  AND t.effective_at=NEW.quoted_starts_at AND t.source_fingerprint=NEW.source_fingerprint
  AND t.source_subscription_id IS NEW.source_subscription_id AND t.source_package_period_id IS NEW.source_package_period_id
  AND t.source_revision IS NEW.source_revision AND t.source_payment_ledger_entry_id IS NEW.source_payment_ledger_entry_id))
BEGIN SELECT RAISE(ABORT,'v144_package_order_binding_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v144_package_order_no_update BEFORE UPDATE ON subscription_package_orders
BEGIN SELECT RAISE(ABORT,'v144_package_order_immutable'); END;
CREATE TRIGGER IF NOT EXISTS v144_package_order_no_delete BEFORE DELETE ON subscription_package_orders
BEGIN SELECT RAISE(ABORT,'v144_package_order_retention_required'); END;

-- Immutable paid period evidence, not a second money ledger or current access
-- projection. Refund/chargeback state comes from the original compensation
-- ledger. A boundary adapter in Part 2 is required before activating its plan.
CREATE TABLE IF NOT EXISTS subscription_package_periods (
 period_id TEXT PRIMARY KEY CHECK(length(period_id)=36),
 order_id TEXT NOT NULL UNIQUE REFERENCES subscription_package_orders(order_id),
 payment_ledger_entry_id TEXT NOT NULL UNIQUE REFERENCES payment_ledger(ledger_entry_id),
 telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),
 plan_code TEXT NOT NULL CHECK(plan_code IN ('professional','dragon')),
 price_id TEXT NOT NULL REFERENCES price_book(price_id),
 price_version INTEGER NOT NULL CHECK(typeof(price_version)='integer' AND price_version>0),
 billing_mode TEXT NOT NULL CHECK(billing_mode='prepaid'),
 starts_at INTEGER NOT NULL CHECK(typeof(starts_at)='integer' AND starts_at>0),
 ends_at INTEGER NOT NULL CHECK(typeof(ends_at)='integer' AND ends_at=starts_at+period_seconds),
 period_seconds INTEGER NOT NULL CHECK(typeof(period_seconds)='integer' AND period_seconds IN (2592000,7776000,15552000,31104000)),
 transition_id TEXT REFERENCES subscription_plan_transitions(transition_id),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at>0)
);
CREATE INDEX IF NOT EXISTS idx_v144_package_period_own ON subscription_package_periods(telegram_id,starts_at,period_id);
CREATE TRIGGER IF NOT EXISTS v144_package_period_binding BEFORE INSERT ON subscription_package_periods
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
 OR EXISTS(SELECT 1 FROM subscription_package_periods pp WHERE pp.telegram_id=NEW.telegram_id
  AND pp.starts_at<NEW.ends_at AND pp.ends_at>NEW.starts_at
  AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=pp.payment_ledger_entry_id AND r.entry_type IN ('refund','chargeback')))
 OR (NEW.transition_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_plan_transitions t
  WHERE t.transition_id=NEW.transition_id AND t.telegram_id=NEW.telegram_id AND t.state='scheduled'
  AND t.to_plan=NEW.plan_code AND t.to_billing_mode=NEW.billing_mode AND t.target_price_id=NEW.price_id
  AND t.target_price_version=NEW.price_version AND t.period_seconds=NEW.period_seconds AND t.effective_at<=NEW.starts_at))
BEGIN SELECT RAISE(ABORT,'v144_package_period_binding_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v144_package_period_no_update BEFORE UPDATE ON subscription_package_periods
BEGIN SELECT RAISE(ABORT,'v144_package_period_immutable'); END;
CREATE TRIGGER IF NOT EXISTS v144_package_period_no_delete BEFORE DELETE ON subscription_package_periods
BEGIN SELECT RAISE(ABORT,'v144_package_period_retention_required'); END;

-- Scheduling is an unpaid intent. Cancelling this intent never cancels or
-- refunds an existing charge, and cannot erase a committed future paid period.
CREATE TABLE IF NOT EXISTS subscription_plan_transitions (
 transition_id TEXT PRIMARY KEY CHECK(length(transition_id)=36),
 telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 160),
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
 contract_version TEXT NOT NULL CHECK(length(contract_version) BETWEEN 8 AND 96),
 source_subscription_id TEXT REFERENCES subscriptions(subscription_id),
 source_package_period_id TEXT REFERENCES subscription_package_periods(period_id),
 source_payment_ledger_entry_id TEXT NOT NULL REFERENCES payment_ledger(ledger_entry_id),
 source_revision INTEGER NOT NULL CHECK(typeof(source_revision)='integer' AND source_revision>0),
 source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint)=64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
 from_plan TEXT NOT NULL CHECK(from_plan IN ('professional','dragon')),
 from_billing_mode TEXT NOT NULL CHECK(from_billing_mode IN ('prepaid','recurring')),
 to_plan TEXT NOT NULL CHECK(to_plan IN ('professional','dragon')),
 to_billing_mode TEXT NOT NULL CHECK(to_billing_mode IN ('prepaid','recurring')),
 target_package_code TEXT NOT NULL CHECK(target_package_code IN ('30d','3m','6m','12m')),
 target_price_id TEXT NOT NULL REFERENCES price_book(price_id),
 target_price_version INTEGER NOT NULL CHECK(typeof(target_price_version)='integer' AND target_price_version>0),
 period_seconds INTEGER NOT NULL CHECK(typeof(period_seconds)='integer' AND period_seconds IN (2592000,7776000,15552000,31104000)),
 offer_version TEXT NOT NULL CHECK(length(offer_version) BETWEEN 8 AND 96),
 campaign_code TEXT CHECK(campaign_code IS NULL OR (length(campaign_code) BETWEEN 1 AND 64 AND campaign_code NOT GLOB '*[^A-Za-z0-9._:-]*')),
 source_paid_until INTEGER NOT NULL CHECK(typeof(source_paid_until)='integer' AND source_paid_until>0),
 effective_at INTEGER NOT NULL CHECK(typeof(effective_at)='integer' AND effective_at=source_paid_until),
 state TEXT NOT NULL DEFAULT 'scheduled' CHECK(state IN ('scheduled','cancelled','fulfilled')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>0),
 target_order_id TEXT REFERENCES subscription_package_orders(order_id),
 target_period_id TEXT REFERENCES subscription_package_periods(period_id),
 target_grant_id TEXT REFERENCES subscription_access_grants(grant_id),
 cancel_command_id TEXT CHECK(cancel_command_id IS NULL OR length(cancel_command_id)=36),
 cancel_idempotency_key TEXT CHECK(cancel_idempotency_key IS NULL OR length(cancel_idempotency_key) BETWEEN 16 AND 160),
 cancel_request_sha256 TEXT CHECK(cancel_request_sha256 IS NULL OR (length(cancel_request_sha256)=64 AND cancel_request_sha256 NOT GLOB '*[^0-9a-f]*')),
 cancelled_at INTEGER,
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0 AND effective_at>created_at),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=created_at),
 UNIQUE(telegram_id,idempotency_key),
 UNIQUE(telegram_id,cancel_idempotency_key),
 CHECK((source_subscription_id IS NOT NULL AND source_package_period_id IS NULL)
  OR (source_subscription_id IS NULL AND source_package_period_id IS NOT NULL)),
 CHECK((target_package_code='30d' AND period_seconds=2592000) OR (target_package_code='3m' AND period_seconds=7776000)
  OR (target_package_code='6m' AND period_seconds=15552000) OR (target_package_code='12m' AND period_seconds=31104000)),
 CHECK(to_billing_mode='prepaid' OR target_package_code='30d'),
 CHECK((state='scheduled' AND target_order_id IS NULL AND target_period_id IS NULL AND target_grant_id IS NULL AND cancel_command_id IS NULL
    AND cancel_idempotency_key IS NULL AND cancel_request_sha256 IS NULL AND cancelled_at IS NULL)
  OR (state='cancelled' AND target_order_id IS NULL AND target_period_id IS NULL AND target_grant_id IS NULL AND cancel_command_id IS NOT NULL
    AND cancel_idempotency_key IS NOT NULL AND cancel_request_sha256 IS NOT NULL AND typeof(cancelled_at)='integer' AND cancelled_at>=created_at)
  OR (state='fulfilled' AND target_order_id IS NOT NULL
    AND ((target_period_id IS NOT NULL AND target_grant_id IS NULL) OR (target_period_id IS NULL AND target_grant_id IS NOT NULL)) AND cancel_command_id IS NULL
    AND cancel_idempotency_key IS NULL AND cancel_request_sha256 IS NULL AND cancelled_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_v144_plan_transition_one_scheduled ON subscription_plan_transitions(telegram_id) WHERE state='scheduled';
CREATE INDEX IF NOT EXISTS idx_v144_plan_transition_own ON subscription_plan_transitions(telegram_id,created_at DESC,transition_id);
CREATE TRIGGER IF NOT EXISTS v144_plan_transition_insert BEFORE INSERT ON subscription_plan_transitions
WHEN NEW.state!='scheduled' OR NEW.revision!=1 OR NEW.updated_at!=NEW.created_at
 OR NOT EXISTS(SELECT 1 FROM price_book p WHERE p.price_id=NEW.target_price_id AND p.price_version=NEW.target_price_version
  AND p.plan_code=NEW.to_plan AND p.billing_mode=NEW.to_billing_mode AND p.access_seconds=NEW.period_seconds
  AND p.publication_state='approved' AND p.valid_from<=NEW.created_at AND (p.valid_until IS NULL OR p.valid_until>NEW.created_at))
 OR (NEW.source_subscription_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscriptions s
  JOIN subscription_access_grants g ON g.subscription_id=s.subscription_id JOIN payment_ledger paid ON paid.ledger_entry_id=g.payment_ledger_entry_id
  WHERE s.subscription_id=NEW.source_subscription_id AND s.telegram_id=NEW.telegram_id AND s.plan_code=NEW.from_plan
  AND s.billing_mode=NEW.from_billing_mode AND s.revision=NEW.source_revision AND s.current_period_end=NEW.source_paid_until
  AND s.status IN ('active','cancel_at_period_end') AND g.status='active' AND g.payment_ledger_entry_id=NEW.source_payment_ledger_entry_id
  AND g.telegram_id=NEW.telegram_id AND paid.telegram_id=NEW.telegram_id
  AND paid.entry_type='payment' AND paid.direction='credit'
  AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=paid.ledger_entry_id AND r.entry_type IN ('refund','chargeback'))))
 OR (NEW.source_package_period_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_package_periods pp
  WHERE pp.period_id=NEW.source_package_period_id AND pp.telegram_id=NEW.telegram_id AND pp.plan_code=NEW.from_plan
  AND pp.billing_mode=NEW.from_billing_mode AND pp.ends_at=NEW.source_paid_until AND pp.payment_ledger_entry_id=NEW.source_payment_ledger_entry_id
  AND NEW.source_revision=1 AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=pp.payment_ledger_entry_id AND r.entry_type IN ('refund','chargeback'))))
BEGIN SELECT RAISE(ABORT,'v144_plan_transition_binding_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v144_plan_transition_update BEFORE UPDATE ON subscription_plan_transitions
WHEN NEW.transition_id IS NOT OLD.transition_id OR NEW.telegram_id IS NOT OLD.telegram_id OR NEW.idempotency_key IS NOT OLD.idempotency_key
 OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.contract_version IS NOT OLD.contract_version
 OR NEW.source_subscription_id IS NOT OLD.source_subscription_id OR NEW.source_package_period_id IS NOT OLD.source_package_period_id
 OR NEW.source_payment_ledger_entry_id IS NOT OLD.source_payment_ledger_entry_id OR NEW.source_revision IS NOT OLD.source_revision
 OR NEW.source_fingerprint IS NOT OLD.source_fingerprint OR NEW.from_plan IS NOT OLD.from_plan OR NEW.from_billing_mode IS NOT OLD.from_billing_mode
 OR NEW.to_plan IS NOT OLD.to_plan OR NEW.to_billing_mode IS NOT OLD.to_billing_mode OR NEW.target_package_code IS NOT OLD.target_package_code
 OR NEW.target_price_id IS NOT OLD.target_price_id OR NEW.target_price_version IS NOT OLD.target_price_version OR NEW.period_seconds IS NOT OLD.period_seconds
 OR NEW.offer_version IS NOT OLD.offer_version OR NEW.campaign_code IS NOT OLD.campaign_code OR NEW.source_paid_until IS NOT OLD.source_paid_until
 OR NEW.effective_at IS NOT OLD.effective_at OR NEW.created_at IS NOT OLD.created_at OR NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at
 OR OLD.state!='scheduled' OR NEW.state NOT IN ('cancelled','fulfilled')
 OR (NEW.state='cancelled' AND (NEW.cancelled_at!=NEW.updated_at
  OR EXISTS(SELECT 1 FROM subscription_package_periods pp WHERE pp.transition_id=OLD.transition_id)
  OR EXISTS(SELECT 1 FROM subscription_access_grants g JOIN subscription_package_orders m ON m.order_id=g.order_id WHERE m.transition_id=OLD.transition_id)))
 OR (NEW.state='fulfilled' AND NEW.target_period_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_package_periods pp
  WHERE pp.period_id=NEW.target_period_id AND pp.order_id=NEW.target_order_id AND pp.telegram_id=NEW.telegram_id
  AND pp.transition_id=NEW.transition_id AND pp.plan_code=NEW.to_plan AND pp.billing_mode=NEW.to_billing_mode
  AND pp.price_id=NEW.target_price_id AND pp.price_version=NEW.target_price_version AND pp.period_seconds=NEW.period_seconds
  AND pp.starts_at>=NEW.effective_at AND pp.recorded_at<=NEW.updated_at
  AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=pp.payment_ledger_entry_id AND r.entry_type IN ('refund','chargeback'))))
 OR (NEW.state='fulfilled' AND NEW.target_grant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_access_grants g
  JOIN subscription_package_orders m ON m.order_id=g.order_id JOIN subscription_orders o ON o.order_id=g.order_id
  JOIN payment_ledger paid ON paid.ledger_entry_id=g.payment_ledger_entry_id
  WHERE g.grant_id=NEW.target_grant_id AND g.order_id=NEW.target_order_id AND g.telegram_id=NEW.telegram_id AND g.status='active'
  AND g.plan_code=NEW.to_plan AND g.access_seconds=NEW.period_seconds AND g.starts_at>=NEW.effective_at AND g.created_at<=NEW.updated_at
  AND m.transition_id=NEW.transition_id AND m.telegram_id=NEW.telegram_id AND m.plan_code=NEW.to_plan
  AND m.price_id=NEW.target_price_id AND m.price_version=NEW.target_price_version AND m.billing_mode=NEW.to_billing_mode
  AND o.order_state='applied' AND o.billing_mode=NEW.to_billing_mode AND paid.entry_type='payment' AND paid.direction='credit'
  AND paid.telegram_id=NEW.telegram_id AND paid.order_id=o.order_id AND paid.currency=o.currency AND paid.amount_stars=o.amount_stars
  AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=paid.ledger_entry_id AND r.entry_type IN ('refund','chargeback'))))
BEGIN SELECT RAISE(ABORT,'v144_plan_transition_state_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v144_plan_transition_no_delete BEFORE DELETE ON subscription_plan_transitions
BEGIN SELECT RAISE(ABORT,'v144_plan_transition_retention_required'); END;

INSERT OR IGNORE INTO re_schema_migrations(version) VALUES('1.4.4-package-contract');
