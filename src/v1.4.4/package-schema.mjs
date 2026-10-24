// Exact reviewed additive schema. No automatic migration or financial writer.
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export const PACKAGE_SCHEMA=freeze({
  "marker": "1.4.4-package-contract",
  "tables": [
    "subscription_package_orders",
    "subscription_package_periods",
    "subscription_plan_transitions"
  ],
  "objects": [
    {
      "type": "index",
      "name": "idx_v144_package_order_own",
      "table_name": "subscription_package_orders",
      "sql": "CREATE INDEX idx_v144_package_order_own ON subscription_package_orders(telegram_id,created_at DESC,order_id)"
    },
    {
      "type": "index",
      "name": "idx_v144_package_period_own",
      "table_name": "subscription_package_periods",
      "sql": "CREATE INDEX idx_v144_package_period_own ON subscription_package_periods(telegram_id,starts_at,period_id)"
    },
    {
      "type": "index",
      "name": "idx_v144_plan_transition_one_scheduled",
      "table_name": "subscription_plan_transitions",
      "sql": "CREATE UNIQUE INDEX idx_v144_plan_transition_one_scheduled ON subscription_plan_transitions(telegram_id) WHERE state='scheduled'"
    },
    {
      "type": "index",
      "name": "idx_v144_plan_transition_own",
      "table_name": "subscription_plan_transitions",
      "sql": "CREATE INDEX idx_v144_plan_transition_own ON subscription_plan_transitions(telegram_id,created_at DESC,transition_id)"
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_subscription_package_orders_1",
      "table_name": "subscription_package_orders",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_subscription_package_periods_1",
      "table_name": "subscription_package_periods",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_subscription_package_periods_2",
      "table_name": "subscription_package_periods",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_subscription_package_periods_3",
      "table_name": "subscription_package_periods",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_subscription_plan_transitions_1",
      "table_name": "subscription_plan_transitions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_subscription_plan_transitions_2",
      "table_name": "subscription_plan_transitions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_subscription_plan_transitions_3",
      "table_name": "subscription_plan_transitions",
      "sql": null
    },
    {
      "type": "table",
      "name": "subscription_package_orders",
      "table_name": "subscription_package_orders",
      "sql": "CREATE TABLE subscription_package_orders (\n order_id TEXT PRIMARY KEY REFERENCES subscription_orders(order_id),\n telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),\n contract_version TEXT NOT NULL CHECK(length(contract_version) BETWEEN 8 AND 96),\n package_code TEXT NOT NULL CHECK(package_code IN ('30d','3m','6m','12m')),\n duration_days INTEGER NOT NULL CHECK(typeof(duration_days)='integer' AND duration_days IN (30,90,180,360)),\n period_seconds INTEGER NOT NULL CHECK(typeof(period_seconds)='integer' AND period_seconds=duration_days*86400),\n price_id TEXT NOT NULL REFERENCES price_book(price_id),\n price_version INTEGER NOT NULL CHECK(typeof(price_version)='integer' AND price_version>0),\n plan_code TEXT NOT NULL CHECK(plan_code IN ('professional','dragon')),\n billing_mode TEXT NOT NULL CHECK(billing_mode IN ('prepaid','recurring')),\n currency TEXT NOT NULL CHECK(currency='XTR'),\n amount_stars INTEGER NOT NULL CHECK(typeof(amount_stars)='integer' AND amount_stars BETWEEN 1 AND 10000),\n offer_version TEXT NOT NULL CHECK(length(offer_version) BETWEEN 8 AND 96),\n campaign_code TEXT CHECK(campaign_code IS NULL OR (length(campaign_code) BETWEEN 1 AND 64 AND campaign_code NOT GLOB '*[^A-Za-z0-9._:-]*')),\n quoted_starts_at INTEGER NOT NULL CHECK(typeof(quoted_starts_at)='integer' AND quoted_starts_at>0),\n quoted_ends_at INTEGER NOT NULL CHECK(typeof(quoted_ends_at)='integer' AND quoted_ends_at=quoted_starts_at+period_seconds),\n source_subscription_id TEXT REFERENCES subscriptions(subscription_id),\n source_package_period_id TEXT REFERENCES subscription_package_periods(period_id),\n source_paid_until INTEGER,\n source_revision INTEGER,\n source_payment_ledger_entry_id TEXT REFERENCES payment_ledger(ledger_entry_id),\n source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint)=64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),\n transition_id TEXT REFERENCES subscription_plan_transitions(transition_id),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0 AND quoted_starts_at>=created_at),\n CHECK((package_code='30d' AND duration_days=30) OR (package_code='3m' AND duration_days=90)\n  OR (package_code='6m' AND duration_days=180) OR (package_code='12m' AND duration_days=360)),\n CHECK(billing_mode='prepaid' OR package_code='30d'),\n CHECK((source_subscription_id IS NULL AND source_package_period_id IS NULL AND source_paid_until IS NULL\n    AND source_revision IS NULL AND source_payment_ledger_entry_id IS NULL)\n  OR (((source_subscription_id IS NOT NULL AND source_package_period_id IS NULL)\n     OR (source_subscription_id IS NULL AND source_package_period_id IS NOT NULL))\n    AND typeof(source_paid_until)='integer' AND source_paid_until>created_at\n    AND typeof(source_revision)='integer' AND source_revision>0 AND source_payment_ledger_entry_id IS NOT NULL\n    AND quoted_starts_at=source_paid_until))\n)"
    },
    {
      "type": "table",
      "name": "subscription_package_periods",
      "table_name": "subscription_package_periods",
      "sql": "CREATE TABLE subscription_package_periods (\n period_id TEXT PRIMARY KEY CHECK(length(period_id)=36),\n order_id TEXT NOT NULL UNIQUE REFERENCES subscription_package_orders(order_id),\n payment_ledger_entry_id TEXT NOT NULL UNIQUE REFERENCES payment_ledger(ledger_entry_id),\n telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),\n plan_code TEXT NOT NULL CHECK(plan_code IN ('professional','dragon')),\n price_id TEXT NOT NULL REFERENCES price_book(price_id),\n price_version INTEGER NOT NULL CHECK(typeof(price_version)='integer' AND price_version>0),\n billing_mode TEXT NOT NULL CHECK(billing_mode='prepaid'),\n starts_at INTEGER NOT NULL CHECK(typeof(starts_at)='integer' AND starts_at>0),\n ends_at INTEGER NOT NULL CHECK(typeof(ends_at)='integer' AND ends_at=starts_at+period_seconds),\n period_seconds INTEGER NOT NULL CHECK(typeof(period_seconds)='integer' AND period_seconds IN (2592000,7776000,15552000,31104000)),\n transition_id TEXT REFERENCES subscription_plan_transitions(transition_id),\n recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at>0)\n)"
    },
    {
      "type": "table",
      "name": "subscription_plan_transitions",
      "table_name": "subscription_plan_transitions",
      "sql": "CREATE TABLE subscription_plan_transitions (\n transition_id TEXT PRIMARY KEY CHECK(length(transition_id)=36),\n telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),\n idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 160),\n request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),\n contract_version TEXT NOT NULL CHECK(length(contract_version) BETWEEN 8 AND 96),\n source_subscription_id TEXT REFERENCES subscriptions(subscription_id),\n source_package_period_id TEXT REFERENCES subscription_package_periods(period_id),\n source_payment_ledger_entry_id TEXT NOT NULL REFERENCES payment_ledger(ledger_entry_id),\n source_revision INTEGER NOT NULL CHECK(typeof(source_revision)='integer' AND source_revision>0),\n source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint)=64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),\n from_plan TEXT NOT NULL CHECK(from_plan IN ('professional','dragon')),\n from_billing_mode TEXT NOT NULL CHECK(from_billing_mode IN ('prepaid','recurring')),\n to_plan TEXT NOT NULL CHECK(to_plan IN ('professional','dragon')),\n to_billing_mode TEXT NOT NULL CHECK(to_billing_mode IN ('prepaid','recurring')),\n target_package_code TEXT NOT NULL CHECK(target_package_code IN ('30d','3m','6m','12m')),\n target_price_id TEXT NOT NULL REFERENCES price_book(price_id),\n target_price_version INTEGER NOT NULL CHECK(typeof(target_price_version)='integer' AND target_price_version>0),\n period_seconds INTEGER NOT NULL CHECK(typeof(period_seconds)='integer' AND period_seconds IN (2592000,7776000,15552000,31104000)),\n offer_version TEXT NOT NULL CHECK(length(offer_version) BETWEEN 8 AND 96),\n campaign_code TEXT CHECK(campaign_code IS NULL OR (length(campaign_code) BETWEEN 1 AND 64 AND campaign_code NOT GLOB '*[^A-Za-z0-9._:-]*')),\n source_paid_until INTEGER NOT NULL CHECK(typeof(source_paid_until)='integer' AND source_paid_until>0),\n effective_at INTEGER NOT NULL CHECK(typeof(effective_at)='integer' AND effective_at=source_paid_until),\n state TEXT NOT NULL DEFAULT 'scheduled' CHECK(state IN ('scheduled','cancelled','fulfilled')),\n revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>0),\n target_order_id TEXT REFERENCES subscription_package_orders(order_id),\n target_period_id TEXT REFERENCES subscription_package_periods(period_id),\n target_grant_id TEXT REFERENCES subscription_access_grants(grant_id),\n cancel_command_id TEXT CHECK(cancel_command_id IS NULL OR length(cancel_command_id)=36),\n cancel_idempotency_key TEXT CHECK(cancel_idempotency_key IS NULL OR length(cancel_idempotency_key) BETWEEN 16 AND 160),\n cancel_request_sha256 TEXT CHECK(cancel_request_sha256 IS NULL OR (length(cancel_request_sha256)=64 AND cancel_request_sha256 NOT GLOB '*[^0-9a-f]*')),\n cancelled_at INTEGER,\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0 AND effective_at>created_at),\n updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=created_at),\n UNIQUE(telegram_id,idempotency_key),\n UNIQUE(telegram_id,cancel_idempotency_key),\n CHECK((source_subscription_id IS NOT NULL AND source_package_period_id IS NULL)\n  OR (source_subscription_id IS NULL AND source_package_period_id IS NOT NULL)),\n CHECK((target_package_code='30d' AND period_seconds=2592000) OR (target_package_code='3m' AND period_seconds=7776000)\n  OR (target_package_code='6m' AND period_seconds=15552000) OR (target_package_code='12m' AND period_seconds=31104000)),\n CHECK(to_billing_mode='prepaid' OR target_package_code='30d'),\n CHECK((state='scheduled' AND target_order_id IS NULL AND target_period_id IS NULL AND target_grant_id IS NULL AND cancel_command_id IS NULL\n    AND cancel_idempotency_key IS NULL AND cancel_request_sha256 IS NULL AND cancelled_at IS NULL)\n  OR (state='cancelled' AND target_order_id IS NULL AND target_period_id IS NULL AND target_grant_id IS NULL AND cancel_command_id IS NOT NULL\n    AND cancel_idempotency_key IS NOT NULL AND cancel_request_sha256 IS NOT NULL AND typeof(cancelled_at)='integer' AND cancelled_at>=created_at)\n  OR (state='fulfilled' AND target_order_id IS NOT NULL\n    AND ((target_period_id IS NOT NULL AND target_grant_id IS NULL) OR (target_period_id IS NULL AND target_grant_id IS NOT NULL)) AND cancel_command_id IS NULL\n    AND cancel_idempotency_key IS NULL AND cancel_request_sha256 IS NULL AND cancelled_at IS NULL))\n)"
    },
    {
      "type": "trigger",
      "name": "v144_package_order_binding",
      "table_name": "subscription_package_orders",
      "sql": "CREATE TRIGGER v144_package_order_binding BEFORE INSERT ON subscription_package_orders\nWHEN NOT EXISTS(SELECT 1 FROM subscription_orders o JOIN price_book p ON p.price_id=o.price_id\n WHERE o.order_id=NEW.order_id AND o.telegram_id=NEW.telegram_id AND o.plan_code=NEW.plan_code\n AND o.price_id=NEW.price_id AND o.price_version=NEW.price_version AND o.currency=NEW.currency\n AND o.amount_stars=NEW.amount_stars AND o.access_seconds=NEW.period_seconds AND o.billing_mode=NEW.billing_mode\n AND o.order_state IN ('created','precheckout_ok') AND o.created_at<=NEW.created_at AND o.expires_at>NEW.created_at\n AND p.price_version=NEW.price_version AND p.plan_code=NEW.plan_code AND p.currency=NEW.currency\n AND p.amount_stars=NEW.amount_stars AND p.access_seconds=NEW.period_seconds AND p.billing_mode=NEW.billing_mode)\n OR (NEW.source_subscription_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscriptions s\n  JOIN subscription_access_grants g ON g.subscription_id=s.subscription_id\n  JOIN payment_ledger paid ON paid.ledger_entry_id=g.payment_ledger_entry_id\n  WHERE s.subscription_id=NEW.source_subscription_id AND s.telegram_id=NEW.telegram_id\n  AND s.revision=NEW.source_revision AND s.current_period_end=NEW.source_paid_until\n  AND s.status IN ('active','cancel_at_period_end') AND g.telegram_id=NEW.telegram_id AND g.status='active'\n  AND g.payment_ledger_entry_id=NEW.source_payment_ledger_entry_id\n  AND paid.telegram_id=NEW.telegram_id AND paid.entry_type='payment' AND paid.direction='credit'\n  AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=paid.ledger_entry_id AND r.entry_type IN ('refund','chargeback'))))\n OR (NEW.source_package_period_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_package_periods pp\n  WHERE pp.period_id=NEW.source_package_period_id AND pp.telegram_id=NEW.telegram_id AND pp.ends_at=NEW.source_paid_until\n  AND pp.payment_ledger_entry_id=NEW.source_payment_ledger_entry_id AND NEW.source_revision=1\n  AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=pp.payment_ledger_entry_id AND r.entry_type IN ('refund','chargeback'))))\n OR (NEW.transition_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_plan_transitions t\n  WHERE t.transition_id=NEW.transition_id AND t.telegram_id=NEW.telegram_id AND t.state='scheduled'\n  AND t.to_plan=NEW.plan_code AND t.to_billing_mode=NEW.billing_mode AND t.target_package_code=NEW.package_code\n  AND t.target_price_id=NEW.price_id AND t.target_price_version=NEW.price_version AND t.period_seconds=NEW.period_seconds\n  AND t.offer_version=NEW.offer_version AND t.campaign_code IS NEW.campaign_code\n  AND t.effective_at=NEW.quoted_starts_at AND t.source_fingerprint=NEW.source_fingerprint\n  AND t.source_subscription_id IS NEW.source_subscription_id AND t.source_package_period_id IS NEW.source_package_period_id\n  AND t.source_revision IS NEW.source_revision AND t.source_payment_ledger_entry_id IS NEW.source_payment_ledger_entry_id))\nBEGIN SELECT RAISE(ABORT,'v144_package_order_binding_invalid'); END"
    },
    {
      "type": "trigger",
      "name": "v144_package_order_no_delete",
      "table_name": "subscription_package_orders",
      "sql": "CREATE TRIGGER v144_package_order_no_delete BEFORE DELETE ON subscription_package_orders\nBEGIN SELECT RAISE(ABORT,'v144_package_order_retention_required'); END"
    },
    {
      "type": "trigger",
      "name": "v144_package_order_no_update",
      "table_name": "subscription_package_orders",
      "sql": "CREATE TRIGGER v144_package_order_no_update BEFORE UPDATE ON subscription_package_orders\nBEGIN SELECT RAISE(ABORT,'v144_package_order_immutable'); END"
    },
    {
      "type": "trigger",
      "name": "v144_package_period_binding",
      "table_name": "subscription_package_periods",
      "sql": "CREATE TRIGGER v144_package_period_binding BEFORE INSERT ON subscription_package_periods\nWHEN NOT EXISTS(SELECT 1 FROM subscription_package_orders m JOIN subscription_orders o ON o.order_id=m.order_id\n JOIN price_book p ON p.price_id=o.price_id JOIN payment_ledger paid ON paid.order_id=o.order_id\n WHERE m.order_id=NEW.order_id AND o.telegram_id=NEW.telegram_id AND m.telegram_id=NEW.telegram_id\n AND o.plan_code=NEW.plan_code AND m.plan_code=NEW.plan_code AND o.billing_mode='prepaid' AND m.billing_mode='prepaid'\n AND o.order_state IN ('paid','applied') AND o.paid_at IS NOT NULL\n AND o.price_id=NEW.price_id AND m.price_id=NEW.price_id AND p.price_id=NEW.price_id\n AND o.price_version=NEW.price_version AND m.price_version=NEW.price_version AND p.price_version=NEW.price_version\n AND p.plan_code=NEW.plan_code AND p.billing_mode='prepaid' AND p.currency='XTR'\n AND p.amount_stars=o.amount_stars AND m.amount_stars=o.amount_stars\n AND p.access_seconds=NEW.period_seconds AND m.period_seconds=NEW.period_seconds AND o.access_seconds=NEW.period_seconds\n AND m.transition_id IS NEW.transition_id AND paid.ledger_entry_id=NEW.payment_ledger_entry_id\n AND paid.telegram_id=NEW.telegram_id AND paid.entry_type='payment' AND paid.direction='credit'\n AND paid.currency=o.currency AND paid.currency='XTR' AND paid.amount_stars=o.amount_stars\n AND paid.related_ledger_entry_id IS NULL AND paid.telegram_payment_charge_id IS NOT NULL\n AND paid.occurred_at>=o.created_at AND paid.recorded_at<=NEW.recorded_at AND o.paid_at<=NEW.recorded_at\n AND NEW.starts_at=MAX(m.quoted_starts_at,paid.occurred_at) AND NEW.recorded_at>=m.created_at\n AND (m.source_paid_until IS NULL OR NEW.starts_at>=m.source_paid_until)\n AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=paid.ledger_entry_id AND r.entry_type IN ('refund','chargeback')))\n -- Prepaid refunds can compact surviving old grants. The old current\n -- projection, verified alongside the source assertions, is the paid residue;\n -- checking raw historical grant intervals here would reject legitimate buys.\n OR EXISTS(SELECT 1 FROM subscriptions s WHERE s.telegram_id=NEW.telegram_id\n  AND s.status IN ('active','cancel_at_period_end','suspended') AND s.current_period_end>NEW.starts_at)\n OR EXISTS(SELECT 1 FROM subscription_access_grants g WHERE g.payment_ledger_entry_id=NEW.payment_ledger_entry_id OR g.order_id=NEW.order_id)\n -- An open recurring contract needs an exact acknowledgement of cancellation.\n -- A provider control state by itself is not an acknowledgement or a payment.\n -- Retired contracts remain governed by the existing retirement/refund proof.\n OR EXISTS(SELECT 1 FROM subscription_billing_contracts c WHERE c.telegram_id=NEW.telegram_id AND c.retired_at IS NULL\n  AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands cmd JOIN subscription_provider_events ack ON ack.event_id=cmd.acknowledgement_event_id\n   WHERE cmd.contract_id=c.contract_id AND cmd.telegram_id=NEW.telegram_id AND cmd.action='cancel_renewal' AND cmd.desired_auto_renew=0\n   AND cmd.state='confirmed' AND cmd.attempted_count=1 AND cmd.expected_contract_revision=c.revision\n   AND cmd.first_payment_ledger_entry_id=c.first_payment_ledger_entry_id AND c.first_payment_ledger_entry_id IS NOT NULL\n   AND ack.command_id=cmd.command_id AND ack.contract_id=c.contract_id AND ack.telegram_id=NEW.telegram_id\n   AND ack.event_type='command_confirmed' AND ack.source='provider_response' AND ack.received_at<=NEW.recorded_at\n   AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands pending WHERE pending.contract_id=c.contract_id AND pending.state IN ('admitted','attempted','unknown'))\n   AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands later WHERE later.contract_id=c.contract_id AND later.state='confirmed'\n    AND later.command_id!=cmd.command_id AND later.attempted_at>=cmd.attempted_at)\n   AND NOT EXISTS(SELECT 1 FROM subscription_provider_events later WHERE later.contract_id=c.contract_id\n    AND later.received_at>=cmd.attempted_at AND ((later.source='telegram_update' AND later.provider_state IN ('active','failed')) OR later.event_type='review_observed'))))\n OR EXISTS(SELECT 1 FROM subscription_package_periods pp WHERE pp.telegram_id=NEW.telegram_id\n  AND pp.starts_at<NEW.ends_at AND pp.ends_at>NEW.starts_at\n  AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=pp.payment_ledger_entry_id AND r.entry_type IN ('refund','chargeback')))\n OR (NEW.transition_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_plan_transitions t\n  WHERE t.transition_id=NEW.transition_id AND t.telegram_id=NEW.telegram_id AND t.state='scheduled'\n  AND t.to_plan=NEW.plan_code AND t.to_billing_mode=NEW.billing_mode AND t.target_price_id=NEW.price_id\n  AND t.target_price_version=NEW.price_version AND t.period_seconds=NEW.period_seconds AND t.effective_at<=NEW.starts_at))\nBEGIN SELECT RAISE(ABORT,'v144_package_period_binding_invalid'); END"
    },
    {
      "type": "trigger",
      "name": "v144_package_period_no_delete",
      "table_name": "subscription_package_periods",
      "sql": "CREATE TRIGGER v144_package_period_no_delete BEFORE DELETE ON subscription_package_periods\nBEGIN SELECT RAISE(ABORT,'v144_package_period_retention_required'); END"
    },
    {
      "type": "trigger",
      "name": "v144_package_period_no_update",
      "table_name": "subscription_package_periods",
      "sql": "CREATE TRIGGER v144_package_period_no_update BEFORE UPDATE ON subscription_package_periods\nBEGIN SELECT RAISE(ABORT,'v144_package_period_immutable'); END"
    },
    {
      "type": "trigger",
      "name": "v144_plan_transition_insert",
      "table_name": "subscription_plan_transitions",
      "sql": "CREATE TRIGGER v144_plan_transition_insert BEFORE INSERT ON subscription_plan_transitions\nWHEN NEW.state!='scheduled' OR NEW.revision!=1 OR NEW.updated_at!=NEW.created_at\n OR NOT EXISTS(SELECT 1 FROM price_book p WHERE p.price_id=NEW.target_price_id AND p.price_version=NEW.target_price_version\n  AND p.plan_code=NEW.to_plan AND p.billing_mode=NEW.to_billing_mode AND p.access_seconds=NEW.period_seconds\n  AND p.publication_state='approved' AND p.valid_from<=NEW.created_at AND (p.valid_until IS NULL OR p.valid_until>NEW.created_at))\n OR (NEW.source_subscription_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscriptions s\n  JOIN subscription_access_grants g ON g.subscription_id=s.subscription_id JOIN payment_ledger paid ON paid.ledger_entry_id=g.payment_ledger_entry_id\n  WHERE s.subscription_id=NEW.source_subscription_id AND s.telegram_id=NEW.telegram_id AND s.plan_code=NEW.from_plan\n  AND s.billing_mode=NEW.from_billing_mode AND s.revision=NEW.source_revision AND s.current_period_end=NEW.source_paid_until\n  AND s.status IN ('active','cancel_at_period_end') AND g.status='active' AND g.payment_ledger_entry_id=NEW.source_payment_ledger_entry_id\n  AND g.telegram_id=NEW.telegram_id AND paid.telegram_id=NEW.telegram_id\n  AND paid.entry_type='payment' AND paid.direction='credit'\n  AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=paid.ledger_entry_id AND r.entry_type IN ('refund','chargeback'))))\n OR (NEW.source_package_period_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_package_periods pp\n  WHERE pp.period_id=NEW.source_package_period_id AND pp.telegram_id=NEW.telegram_id AND pp.plan_code=NEW.from_plan\n  AND pp.billing_mode=NEW.from_billing_mode AND pp.ends_at=NEW.source_paid_until AND pp.payment_ledger_entry_id=NEW.source_payment_ledger_entry_id\n  AND NEW.source_revision=1 AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=pp.payment_ledger_entry_id AND r.entry_type IN ('refund','chargeback'))))\nBEGIN SELECT RAISE(ABORT,'v144_plan_transition_binding_invalid'); END"
    },
    {
      "type": "trigger",
      "name": "v144_plan_transition_no_delete",
      "table_name": "subscription_plan_transitions",
      "sql": "CREATE TRIGGER v144_plan_transition_no_delete BEFORE DELETE ON subscription_plan_transitions\nBEGIN SELECT RAISE(ABORT,'v144_plan_transition_retention_required'); END"
    },
    {
      "type": "trigger",
      "name": "v144_plan_transition_update",
      "table_name": "subscription_plan_transitions",
      "sql": "CREATE TRIGGER v144_plan_transition_update BEFORE UPDATE ON subscription_plan_transitions\nWHEN NEW.transition_id IS NOT OLD.transition_id OR NEW.telegram_id IS NOT OLD.telegram_id OR NEW.idempotency_key IS NOT OLD.idempotency_key\n OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.contract_version IS NOT OLD.contract_version\n OR NEW.source_subscription_id IS NOT OLD.source_subscription_id OR NEW.source_package_period_id IS NOT OLD.source_package_period_id\n OR NEW.source_payment_ledger_entry_id IS NOT OLD.source_payment_ledger_entry_id OR NEW.source_revision IS NOT OLD.source_revision\n OR NEW.source_fingerprint IS NOT OLD.source_fingerprint OR NEW.from_plan IS NOT OLD.from_plan OR NEW.from_billing_mode IS NOT OLD.from_billing_mode\n OR NEW.to_plan IS NOT OLD.to_plan OR NEW.to_billing_mode IS NOT OLD.to_billing_mode OR NEW.target_package_code IS NOT OLD.target_package_code\n OR NEW.target_price_id IS NOT OLD.target_price_id OR NEW.target_price_version IS NOT OLD.target_price_version OR NEW.period_seconds IS NOT OLD.period_seconds\n OR NEW.offer_version IS NOT OLD.offer_version OR NEW.campaign_code IS NOT OLD.campaign_code OR NEW.source_paid_until IS NOT OLD.source_paid_until\n OR NEW.effective_at IS NOT OLD.effective_at OR NEW.created_at IS NOT OLD.created_at OR NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at\n OR OLD.state!='scheduled' OR NEW.state NOT IN ('cancelled','fulfilled')\n OR (NEW.state='cancelled' AND (NEW.cancelled_at!=NEW.updated_at\n  OR EXISTS(SELECT 1 FROM subscription_package_periods pp WHERE pp.transition_id=OLD.transition_id)\n  OR EXISTS(SELECT 1 FROM subscription_access_grants g JOIN subscription_package_orders m ON m.order_id=g.order_id WHERE m.transition_id=OLD.transition_id)))\n OR (NEW.state='fulfilled' AND NEW.target_period_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_package_periods pp\n  WHERE pp.period_id=NEW.target_period_id AND pp.order_id=NEW.target_order_id AND pp.telegram_id=NEW.telegram_id\n  AND pp.transition_id=NEW.transition_id AND pp.plan_code=NEW.to_plan AND pp.billing_mode=NEW.to_billing_mode\n  AND pp.price_id=NEW.target_price_id AND pp.price_version=NEW.target_price_version AND pp.period_seconds=NEW.period_seconds\n  AND pp.starts_at>=NEW.effective_at AND pp.recorded_at<=NEW.updated_at\n  AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=pp.payment_ledger_entry_id AND r.entry_type IN ('refund','chargeback'))))\n OR (NEW.state='fulfilled' AND NEW.target_grant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_access_grants g\n  JOIN subscription_package_orders m ON m.order_id=g.order_id JOIN subscription_orders o ON o.order_id=g.order_id\n  JOIN payment_ledger paid ON paid.ledger_entry_id=g.payment_ledger_entry_id\n  WHERE g.grant_id=NEW.target_grant_id AND g.order_id=NEW.target_order_id AND g.telegram_id=NEW.telegram_id AND g.status='active'\n  AND g.plan_code=NEW.to_plan AND g.access_seconds=NEW.period_seconds AND g.starts_at>=NEW.effective_at AND g.created_at<=NEW.updated_at\n  AND m.transition_id=NEW.transition_id AND m.telegram_id=NEW.telegram_id AND m.plan_code=NEW.to_plan\n  AND m.price_id=NEW.target_price_id AND m.price_version=NEW.target_price_version AND m.billing_mode=NEW.to_billing_mode\n  AND o.order_state='applied' AND o.billing_mode=NEW.to_billing_mode AND paid.entry_type='payment' AND paid.direction='credit'\n  AND paid.telegram_id=NEW.telegram_id AND paid.order_id=o.order_id AND paid.currency=o.currency AND paid.amount_stars=o.amount_stars\n  AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=paid.ledger_entry_id AND r.entry_type IN ('refund','chargeback'))))\nBEGIN SELECT RAISE(ABORT,'v144_plan_transition_state_invalid'); END"
    }
  ],
  "schemaSha256": "2820f23541d24e720295d09f451b91742139a6c7bbbbda0d584cf2b700114ec6",
  "migrationSha256": "b84e6fcccb611a4b79679fabf64de9c68679a1647e202334578dbea9399f3f83"
});

const fail=()=>{throw Object.assign(new Error('v144_package_schema_not_ready'),{code:'v144_package_schema_not_ready',status:503});};
const rows=result=>{if(result?.success!==true||!Array.isArray(result.results))fail();return result.results;};
const slots=PACKAGE_SCHEMA.tables.map(()=>'?').join(',');
// D1 stored these six whole comment lines as one-space lines in this one
// trigger. Derive that reviewed alternative from the immutable source only;
// never strip or normalize SQL read from the database.
const d1CommentLines=freeze([
 ' -- Prepaid refunds can compact surviving old grants. The old current',
 ' -- projection, verified alongside the source assertions, is the paid residue;',
 ' -- checking raw historical grant intervals here would reject legitimate buys.',
 ' -- An open recurring contract needs an exact acknowledgement of cancellation.',
 ' -- A provider control state by itself is not an acknowledgement or a payment.',
 ' -- Retired contracts remain governed by the existing retirement/refund proof.'
]);
const d1CommentSpaceObjects=freeze(PACKAGE_SCHEMA.objects.map(object=>{
 if(object.name!=='v144_package_period_binding')return object;
 let sql=object.sql;
 for(const line of d1CommentLines){
  const exact=`\n${line}\n`;
  if(sql.indexOf(exact)===-1||sql.indexOf(exact)!==sql.lastIndexOf(exact))fail();
  sql=sql.replace(exact,'\n \n');
 }
 return {...object,sql};
}));

// Exact reviewed amendment derived from the immutable0072 trigger. Never normalize database SQL.
export const PACKAGE_PROVIDER_INACTIVE_EXIT_SCHEMA=freeze({
  "marker": "1.4.4-provider-inactive-exit",
  "triggerName": "v144_package_period_binding",
  "originalFragment": "er.source='telegram_update' AND later.provider_state IN ('active','failed')) OR later.event_type='review_observed'))))\n OR EXISTS(SELECT 1 FROM subscription_package_periods pp WHERE pp.telegram_id=NEW.telegram_id\n  AND pp.starts_at<NEW.ends",
  "additionFragment": "er.source='telegram_update' AND later.provider_state IN ('active','failed')) OR later.event_type='review_observed'))))\n AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands inactive\n  CROSS JOIN subscription_billing_contracts c\n  CROSS JOIN subscription_provider_events rejected\n  CROSS JOIN (SELECT id,actor_id,entity_id,created_at,\n   CASE WHEN json_valid(details) THEN details ELSE '{}' END AS diagnostic\n   FROM admin_audit_log WHERE action='subscription_provider_diagnostic' AND entity_type='subscription_provider_command') audit\n  CROSS JOIN payment_ledger first\n  CROSS JOIN subscription_orders origin\n  CROSS JOIN price_book original_price\n  CROSS JOIN terms_acceptances consent\n  CROSS JOIN subscription_first_recurring_receipts receipt\n  CROSS JOIN subscription_payment_links incoming\n  CROSS JOIN subscription_orders applied\n  CROSS JOIN payment_ledger reversal\n  CROSS JOIN payment_refunds refund\n  CROSS JOIN subscription_access_grants grant_row\n  WHERE (((((((c.telegram_id=NEW.telegram_id\n  AND c.retired_at IS NULL)\n  AND (rejected.command_id=inactive.command_id\n  AND audit.entity_id=inactive.command_id))\n  AND ((audit.actor_id=8987576334\n  AND first.ledger_entry_id=c.first_payment_ledger_entry_id)\n  AND (origin.order_id=c.origin_order_id\n  AND (original_price.price_id=origin.price_id\n  AND consent.acceptance_id=c.terms_acceptance_id))))\n  AND (((receipt.contract_id=c.contract_id\n  AND incoming.operation_id=receipt.operation_id)\n  AND (applied.order_id=incoming.applied_order_id\n  AND (reversal.related_ledger_entry_id=first.ledger_entry_id\n  AND refund.original_ledger_entry_id=first.ledger_entry_id)))\n  AND ((grant_row.payment_ledger_entry_id=first.ledger_entry_id\n  AND NEW.telegram_id=8987576334)\n  AND (c.telegram_id=8987576334\n  AND (c.billing_mode='recurring'\n  AND c.plan_code='professional')))))\n  AND ((((c.currency='XTR'\n  AND c.amount_stars=249)\n  AND (c.period_seconds=2592000\n  AND c.terms_revision='2026-10-03.stars-recurring-v1'))\n  AND ((origin.telegram_id=c.telegram_id\n  AND origin.plan_code=c.plan_code)\n  AND (origin.price_id=c.price_id\n  AND (origin.price_version=1\n  AND origin.currency=c.currency))))\n  AND (((origin.amount_stars=c.amount_stars\n  AND origin.access_seconds=c.period_seconds)\n  AND (origin.billing_mode='recurring'\n  AND (origin.terms_revision=c.terms_revision\n  AND origin.invoice_payload=c.external_invoice_payload)))\n  AND ((original_price.price_version=1\n  AND original_price.plan_code=c.plan_code)\n  AND (original_price.currency=c.currency\n  AND (original_price.amount_stars=c.amount_stars\n  AND original_price.access_seconds=c.period_seconds))))))\n  AND (((((original_price.billing_mode='recurring'\n  AND original_price.terms_revision=c.terms_revision)\n  AND (original_price.publication_state IN ('approved','retired')\n  AND original_price.valid_from<=origin.created_at))\n  AND (((original_price.valid_until IS NULL OR original_price.valid_until>origin.created_at)\n  AND consent.telegram_id=c.telegram_id)\n  AND (consent.acceptance_scope='stars_purchase'\n  AND (consent.terms_revision=c.terms_revision\n  AND consent.accepted_at<=origin.created_at))))\n  AND (((length(consent.evidence_sha256)=64\n  AND first.telegram_id=c.telegram_id)\n  AND (first.entry_type='payment'\n  AND (first.direction='credit'\n  AND first.currency='XTR')))\n  AND ((first.amount_stars=249\n  AND first.related_ledger_entry_id IS NULL)\n  AND (first.telegram_payment_charge_id IS NOT NULL\n  AND (incoming.contract_id=c.contract_id\n  AND incoming.telegram_id=c.telegram_id)))))\n  AND ((((incoming.origin_order_id=origin.order_id\n  AND incoming.direction='incoming')\n  AND (incoming.link_kind='recurring_charge'\n  AND incoming.ledger_entry_id=first.ledger_entry_id))\n  AND ((incoming.original_payment_ledger_entry_id IS NULL\n  AND incoming.plan_code=c.plan_code)\n  AND (incoming.provider_charge_id=first.telegram_payment_charge_id\n  AND (incoming.external_invoice_payload=c.external_invoice_payload\n  AND incoming.external_payload_sha256=c.external_payload_sha256))))\n  AND (((incoming.evidence_sha256=receipt.evidence_sha256\n  AND incoming.provider_period_start>0)\n  AND (incoming.provider_period_end=incoming.provider_period_start+c.period_seconds\n  AND (incoming.recorded_at<=receipt.verified_at\n  AND receipt.verified_at>0)))\n  AND ((length(receipt.evidence_sha256)=64\n  AND applied.telegram_id=c.telegram_id)\n  AND (applied.plan_code=c.plan_code\n  AND (applied.billing_mode='recurring'\n  AND applied.currency='XTR')))))))\n  AND ((((((applied.amount_stars=249\n  AND applied.access_seconds=2592000)\n  AND ((first.order_id=applied.order_id OR EXISTS(SELECT 1 FROM subscription_payment_review_receipts retained\n   JOIN subscription_payment_review_settlements settled ON settled.ledger_entry_id=retained.ledger_entry_id\n   WHERE retained.ledger_entry_id=first.ledger_entry_id AND retained.origin_order_id=first.order_id\n    AND retained.contract_id=c.contract_id AND retained.telegram_id=c.telegram_id AND retained.is_first_recurring=1\n    AND retained.evidence_sha256=incoming.evidence_sha256 AND settled.applied_order_id=applied.order_id\n    AND settled.operation_id=incoming.operation_id AND settled.actor_id=8987576334))\n  AND grant_row.telegram_id=c.telegram_id))\n  AND ((grant_row.order_id=applied.order_id\n  AND grant_row.plan_code=c.plan_code)\n  AND (grant_row.status='refunded'\n  AND (grant_row.compensation_ledger_entry_id=reversal.ledger_entry_id\n  AND reversal.telegram_id=c.telegram_id))))\n  AND (((reversal.order_id=first.order_id\n  AND reversal.entry_type='refund')\n  AND (reversal.direction='debit'\n  AND (reversal.currency='XTR'\n  AND reversal.amount_stars=249)))\n  AND ((reversal.telegram_payment_charge_id=first.telegram_payment_charge_id\n  AND reversal.recorded_at>=reversal.occurred_at)\n  AND (reversal.occurred_at>=first.occurred_at\n  AND ((SELECT COUNT(*) FROM payment_ledger r WHERE r.related_ledger_entry_id=first.ledger_entry_id AND r.entry_type IN ('refund','chargeback'))=1\n  AND refund.telegram_id=c.telegram_id)))))\n  AND ((((refund.order_id=first.order_id\n  AND refund.status='applied')\n  AND (refund.currency='XTR'\n  AND refund.amount_stars=249))\n  AND ((refund.telegram_payment_charge_id=first.telegram_payment_charge_id\n  AND refund.requested_by_type='admin')\n  AND (refund.requested_by=8987576334\n  AND (refund.reason_code='admin_canary_validation'\n  AND typeof(refund.applied_at)='integer'))))\n  AND (((refund.applied_at>0\n  AND inactive.contract_id=c.contract_id)\n  AND (inactive.telegram_id=c.telegram_id\n  AND (inactive.action='cancel_renewal'\n  AND inactive.desired_auto_renew=0)))\n  AND ((inactive.state='rejected'\n  AND inactive.attempted_count=1)\n  AND (inactive.expected_contract_revision=c.revision\n  AND (inactive.first_payment_ledger_entry_id=first.ledger_entry_id\n  AND inactive.acknowledgement_event_id IS NULL))))))\n  AND (((((inactive.error_code='telegram_400_detail_29b36909890ff6ff'\n  AND inactive.attempted_at>MAX(refund.applied_at,reversal.recorded_at))\n  AND (rejected.contract_id=c.contract_id\n  AND rejected.telegram_id=c.telegram_id))\n  AND ((rejected.event_type='command_rejected'\n  AND rejected.source='provider_response')\n  AND (rejected.actor_type='system'\n  AND (rejected.actor_id IS NULL\n  AND rejected.operation_id IS NULL))))\n  AND (((rejected.telegram_update_id IS NULL\n  AND rejected.provider_state IS NULL)\n  AND (rejected.provider_occurred_at IS NULL\n  AND (rejected.reason_code=inactive.error_code\n  AND rejected.received_at>=inactive.attempted_at)))\n  AND ((rejected.received_at<=NEW.recorded_at\n  AND inactive.updated_at=rejected.received_at)\n  AND ((SELECT COUNT(*) FROM subscription_provider_events e WHERE e.command_id=inactive.command_id AND e.event_type='command_rejected')=1\n  AND ((SELECT COUNT(*) FROM admin_audit_log a WHERE a.entity_id=inactive.command_id AND a.actor_id=8987576334\n   AND a.action='subscription_provider_diagnostic' AND a.entity_type='subscription_provider_command')=1\n  AND typeof(unixepoch(audit.created_at))='integer')))))\n  AND ((((unixepoch(audit.created_at)>=rejected.received_at\n  AND unixepoch(audit.created_at)<=NEW.recorded_at)\n  AND (json_extract(audit.diagnostic,'$.version')=1\n  AND (json_extract(audit.diagnostic,'$.method')='editUserStarSubscription'\n  AND json_extract(audit.diagnostic,'$.code')=inactive.error_code)))\n  AND ((json_extract(audit.diagnostic,'$.httpStatus')=400\n  AND json_extract(audit.diagnostic,'$.apiErrorCode')=400)\n  AND (json_extract(audit.diagnostic,'$.descriptionCode')='unclassified'\n  AND (json_extract(audit.diagnostic,'$.descriptionSafe')='Bad Request: SUBSCRIPTION_NOT_ACTIVE'\n  AND json_extract(audit.diagnostic,'$.descriptionSha256')='29b36909890ff6ffc0230f02a03f07eb00465af871a8ebbb21f9c222d61a0b0e'))))\n  AND (((json_type(audit.diagnostic,'$.descriptionTruncated')='false'\n  AND NOT EXISTS(SELECT 1 FROM subscription_billing_contracts other WHERE other.telegram_id=c.telegram_id AND other.retired_at IS NULL AND other.contract_id!=c.contract_id))\n  AND (NOT EXISTS(SELECT 1 FROM subscription_provider_commands newer WHERE newer.contract_id=c.contract_id AND newer.command_id!=inactive.command_id\n   AND (newer.created_at>=rejected.received_at OR newer.updated_at>rejected.received_at OR newer.state IN ('admitted','attempted','unknown')))\n  AND (NOT EXISTS(SELECT 1 FROM subscription_provider_commands enabled WHERE enabled.contract_id=c.contract_id AND enabled.state='confirmed' AND enabled.action='reenable_renewal'\n   AND (enabled.attempted_at>=inactive.attempted_at OR NOT EXISTS(SELECT 1 FROM subscription_provider_events enable_ack\n    WHERE enable_ack.event_id=enabled.acknowledgement_event_id AND enable_ack.command_id=enabled.command_id\n     AND enable_ack.source='provider_response' AND enable_ack.event_type='command_confirmed' AND enable_ack.received_at<inactive.attempted_at)))\n  AND NOT EXISTS(SELECT 1 FROM subscription_provider_events newer WHERE newer.contract_id=c.contract_id AND newer.event_id!=rejected.event_id\n   AND newer.event_type!='lifecycle_transition' AND newer.received_at>=rejected.received_at))))\n  AND ((NOT EXISTS(SELECT 1 FROM subscription_provider_events review WHERE review.contract_id=c.contract_id AND review.event_type='review_observed')\n  AND NOT EXISTS(SELECT 1 FROM payment_refunds unsettled WHERE unsettled.telegram_id=c.telegram_id AND unsettled.status IN ('requested','confirmed','manual_review')))\n  AND (NOT EXISTS(SELECT 1 FROM subscription_access_grants active_grant WHERE active_grant.telegram_id=c.telegram_id AND active_grant.status='active' AND active_grant.ends_at>rejected.received_at)\n  AND (NOT EXISTS(SELECT 1 FROM subscription_payment_links other_charge LEFT JOIN payment_ledger paid_charge ON paid_charge.ledger_entry_id=other_charge.ledger_entry_id\n   WHERE other_charge.contract_id=c.contract_id AND other_charge.direction='incoming' AND (paid_charge.ledger_entry_id IS NULL\n    OR paid_charge.recorded_at>rejected.received_at OR NOT EXISTS(SELECT 1 FROM payment_ledger refunded_charge\n     WHERE (((refunded_charge.related_ledger_entry_id=paid_charge.ledger_entry_id\n  AND refunded_charge.entry_type='refund')\n  AND (refunded_charge.direction='debit'\n  AND refunded_charge.telegram_id=c.telegram_id))\n  AND ((refunded_charge.order_id=paid_charge.order_id\n  AND refunded_charge.currency=paid_charge.currency)\n  AND (refunded_charge.amount_stars=paid_charge.amount_stars\n  AND (refunded_charge.telegram_payment_charge_id=paid_charge.telegram_payment_charge_id\n  AND refunded_charge.recorded_at<=rejected.received_at)))))))\n  AND NOT EXISTS(SELECT 1 FROM subscription_payment_review_receipts retained WHERE retained.contract_id=c.contract_id\n   AND (retained.recorded_at>rejected.received_at OR NOT EXISTS(SELECT 1 FROM payment_ledger retained_payment JOIN payment_ledger retained_refund\n    ON retained_refund.related_ledger_entry_id=retained_payment.ledger_entry_id WHERE (((retained_payment.ledger_entry_id=retained.ledger_entry_id\n  AND retained_refund.entry_type='refund')\n  AND (retained_refund.direction='debit'\n  AND retained_refund.telegram_id=c.telegram_id))\n  AND ((retained_refund.order_id=retained_payment.order_id\n  AND retained_refund.currency=retained_payment.currency)\n  AND (retained_refund.amount_stars=retained_payment.amount_stars\n  AND (retained_refund.telegram_payment_charge_id=retained_payment.telegram_payment_charge_id\n  AND retained_refund.recorded_at<=rejected.received_at))))))))))))))))\n OR EXISTS(SELECT 1 FROM subscription_package_periods pp WHERE pp.telegram_id=NEW.telegram_id\n  AND pp.starts_at<NEW.ends",
  "sqliteSchemaSha256": "b6f972d51dc6db01a93144cdfd7fd256b5ca84f54a19f4605a4066126d8f7999",
  "d1SchemaSha256": "8d651a3005b5e33bd23dfdec2fba59759196b45af3d973b5246bf6695ef8993c",
  "migrationSha256": "f68deeb4a72b2acc612e93c397d49472a2bcfedb2c29c67b3868a06ffb8f3c18"
});
const inactiveSqliteObjects=freeze(PACKAGE_SCHEMA.objects.map(object=>{
 if(object.name!==PACKAGE_PROVIDER_INACTIVE_EXIT_SCHEMA.triggerName)return object;
 const original=PACKAGE_PROVIDER_INACTIVE_EXIT_SCHEMA.originalFragment;
 if(object.sql.indexOf(original)===-1||object.sql.indexOf(original)!==object.sql.lastIndexOf(original))fail();
 return {...object,sql:object.sql.replace(original,PACKAGE_PROVIDER_INACTIVE_EXIT_SCHEMA.additionFragment)};
}));
const inactiveD1Objects=freeze(inactiveSqliteObjects.map(object=>{
 if(object.name!==PACKAGE_PROVIDER_INACTIVE_EXIT_SCHEMA.triggerName)return object;
 let sql=object.sql;for(const line of d1CommentLines){const exact='\n'+line+'\n';
 if(sql.indexOf(exact)===-1||sql.indexOf(exact)!==sql.lastIndexOf(exact))fail();sql=sql.replace(exact,'\n \n');}
 return {...object,sql};
}));
const packageSerializations=freeze({
 sqlite_inactive:{objects:inactiveSqliteObjects,sha256:PACKAGE_PROVIDER_INACTIVE_EXIT_SCHEMA.sqliteSchemaSha256},
 d1_inactive_spaces:{objects:inactiveD1Objects,sha256:PACKAGE_PROVIDER_INACTIVE_EXIT_SCHEMA.d1SchemaSha256},
 sqlite_source:{objects:PACKAGE_SCHEMA.objects,sha256:PACKAGE_SCHEMA.schemaSha256},
 d1_comment_spaces:{objects:d1CommentSpaceObjects,
  sha256:'98471a0dacb2a4a9f4c7ed40bbb0f6338a310c9ecc0f0948f7b016d7766b6c3f'}
});
export function matchPackageSchemaSerialization(actualObjects){
 const actual=JSON.stringify(actualObjects);
 for(const variant of Object.keys(packageSerializations)){
  if(actual===JSON.stringify(packageSerializations[variant].objects))return variant;
 }
 return null;
}
export function packageSchemaSerializationObjects(state){
 if(state?.present!==true||state.marker!==PACKAGE_SCHEMA.marker||
  state.schemaSha256!==PACKAGE_SCHEMA.schemaSha256||state.migrationSha256!==PACKAGE_SCHEMA.migrationSha256||
  !Object.hasOwn(packageSerializations,state.serializationVariant))fail();
 const amended=['sqlite_inactive','d1_inactive_spaces'].includes(state.serializationVariant);
 if((state.providerInactiveExitReady===true)!==amended)fail();
 if(amended&&(state.providerInactiveExitReady!==true||state.inactiveMigrationSha256!==PACKAGE_PROVIDER_INACTIVE_EXIT_SCHEMA.migrationSha256))fail();
 const serialization=packageSerializations[state.serializationVariant];
 if(state.serializationSha256!==serialization.sha256)fail();
 return serialization.objects;
}
// This assertion must be included in the same later D1 batch as its producer.
// Structural readiness is not payment verification and creates no access.
export function packageSchemaAssertion(state) {
 if(!state?.present)return freeze({sql:`NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE tbl_name IN (${slots}))
  AND NOT EXISTS(SELECT 1 FROM re_schema_migrations WHERE version IN (?,?))`,params:[...PACKAGE_SCHEMA.tables,PACKAGE_SCHEMA.marker,PACKAGE_PROVIDER_INACTIVE_EXIT_SCHEMA.marker]});
 const objects=packageSchemaSerializationObjects(state);
 return freeze({sql:`(SELECT COALESCE(json_group_array(json(object)),'[]') FROM
  (SELECT json_object('type',type,'name',name,'table_name',tbl_name,'sql',sql) AS object
   FROM sqlite_schema WHERE tbl_name IN (${slots}) ORDER BY type,name)) IS ?
  AND EXISTS(SELECT 1 FROM re_schema_migrations WHERE version=?)
  AND ${state.providerInactiveExitReady===true?'EXISTS':'NOT EXISTS'}(SELECT 1 FROM re_schema_migrations WHERE version=?)`,params:[...PACKAGE_SCHEMA.tables,JSON.stringify(objects),PACKAGE_SCHEMA.marker,PACKAGE_PROVIDER_INACTIVE_EXIT_SCHEMA.marker]});
}
export async function inspectPackageSchema(db,{required=false}={}) {
 if(!db?.prepare||!db?.batch)fail();
 let presence;
 try{presence=await db.prepare(`SELECT
  (SELECT COUNT(*) FROM sqlite_schema WHERE tbl_name IN (${slots})) AS object_count,
  (SELECT COUNT(*) FROM re_schema_migrations WHERE version=?) AS marker_count,
  (SELECT COUNT(*) FROM re_schema_migrations WHERE version=?) AS inactive_marker_count`).bind(...PACKAGE_SCHEMA.tables,PACKAGE_SCHEMA.marker,PACKAGE_PROVIDER_INACTIVE_EXIT_SCHEMA.marker).first();}catch{fail();}
 if(!presence||!Number.isSafeInteger(Number(presence.object_count))||!Number.isSafeInteger(Number(presence.marker_count))||
  Number(presence.object_count)<0||Number(presence.marker_count)<0||
 !Number.isSafeInteger(Number(presence.inactive_marker_count))||![0,1].includes(Number(presence.inactive_marker_count)))fail();
 if(Number(presence.object_count)===0&&Number(presence.marker_count)===0&&Number(presence.inactive_marker_count)===0){if(required)fail();return freeze({ready:true,present:false,metadataOnly:true});}
 let result;
 try{result=await db.prepare(`SELECT type,name,tbl_name AS table_name,sql FROM sqlite_schema
  WHERE tbl_name IN (${slots}) ORDER BY type,name`).bind(...PACKAGE_SCHEMA.tables).all();}catch{fail();}
 const actual=rows(result).map(({type,name,table_name,sql})=>({type,name,table_name,sql}));
 const serializationVariant=matchPackageSchemaSerialization(actual);
 const providerInactiveExitReady=['sqlite_inactive','d1_inactive_spaces'].includes(serializationVariant);
 if(Number(presence.marker_count)!==1||serializationVariant===null||Number(presence.inactive_marker_count)!==Number(providerInactiveExitReady))fail();
 return freeze({ready:true,present:true,metadataOnly:true,marker:PACKAGE_SCHEMA.marker,
  schemaSha256:PACKAGE_SCHEMA.schemaSha256,migrationSha256:PACKAGE_SCHEMA.migrationSha256,
  serializationVariant,serializationSha256:packageSerializations[serializationVariant].sha256,providerInactiveExitReady,
  ...(providerInactiveExitReady?{inactiveMigrationSha256:PACKAGE_PROVIDER_INACTIVE_EXIT_SCHEMA.migrationSha256}:{})});
}

// Separate additive review schema; original base23 objects remain exact.
export const PACKAGE_PAYMENT_REVIEW_SCHEMA=freeze({
  "marker": "1.4.4-package-payment-review",
  "tables": [
    "subscription_package_payment_reviews",
    "subscription_package_invoice_requests"
  ],
  "objects": [
    {
      "type": "index",
      "name": "idx_v144_package_invoice_own",
      "table_name": "subscription_package_invoice_requests",
      "sql": "CREATE INDEX idx_v144_package_invoice_own ON subscription_package_invoice_requests(telegram_id,created_at DESC,request_id)"
    },
    {
      "type": "index",
      "name": "idx_v144_package_payment_review_own",
      "table_name": "subscription_package_payment_reviews",
      "sql": "CREATE INDEX idx_v144_package_payment_review_own ON subscription_package_payment_reviews(telegram_id,recorded_at DESC,ledger_entry_id)"
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_subscription_package_invoice_requests_1",
      "table_name": "subscription_package_invoice_requests",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_subscription_package_invoice_requests_2",
      "table_name": "subscription_package_invoice_requests",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_subscription_package_payment_reviews_1",
      "table_name": "subscription_package_payment_reviews",
      "sql": null
    },
    {
      "type": "table",
      "name": "subscription_package_invoice_requests",
      "table_name": "subscription_package_invoice_requests",
      "sql": "CREATE TABLE subscription_package_invoice_requests (\n request_id TEXT PRIMARY KEY CHECK(length(request_id)=36),\n order_id TEXT NOT NULL UNIQUE REFERENCES subscription_package_orders(order_id),\n telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),\n request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),\n state TEXT NOT NULL DEFAULT 'admitted' CHECK(state IN ('admitted','attempted','confirmed','rejected','unknown')),\n attempted_count INTEGER NOT NULL DEFAULT 0 CHECK(attempted_count IN (0,1)),\n attempted_at INTEGER,\n invoice_url TEXT CHECK(invoice_url IS NULL OR length(invoice_url) BETWEEN 16 AND 512),\n provider_result_sha256 TEXT CHECK(provider_result_sha256 IS NULL OR (length(provider_result_sha256)=64 AND provider_result_sha256 NOT GLOB '*[^0-9a-f]*')),\n error_code TEXT NOT NULL DEFAULT '' CHECK(length(error_code)<=64),\n revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>0),\n created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0),\n updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=created_at),\n CHECK((attempted_count=0 AND attempted_at IS NULL) OR (attempted_count=1 AND typeof(attempted_at)='integer' AND attempted_at>=created_at)),\n CHECK((state='confirmed' AND invoice_url IS NOT NULL AND provider_result_sha256 IS NOT NULL) OR (state!='confirmed' AND invoice_url IS NULL))\n)"
    },
    {
      "type": "table",
      "name": "subscription_package_payment_reviews",
      "table_name": "subscription_package_payment_reviews",
      "sql": "CREATE TABLE subscription_package_payment_reviews (\n ledger_entry_id TEXT PRIMARY KEY REFERENCES payment_ledger(ledger_entry_id),\n order_id TEXT NOT NULL REFERENCES subscription_package_orders(order_id),\n telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),\n plan_code TEXT NOT NULL CHECK(plan_code IN ('professional','dragon')),\n external_invoice_payload TEXT NOT NULL CHECK(length(external_invoice_payload) BETWEEN 1 AND 128),\n external_payload_sha256 TEXT NOT NULL CHECK(length(external_payload_sha256)=64 AND external_payload_sha256 NOT GLOB '*[^0-9a-f]*'),\n evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),\n telegram_update_id INTEGER CHECK(telegram_update_id IS NULL OR (typeof(telegram_update_id)='integer' AND telegram_update_id>=0)),\n reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 3 AND 64),\n reconciliation_run_id TEXT REFERENCES payment_reconciliation_runs(run_id),\n provider_page_sha256 TEXT CHECK(provider_page_sha256 IS NULL OR (length(provider_page_sha256)=64 AND provider_page_sha256 NOT GLOB '*[^0-9a-f]*')),\n provider_transaction_sha256 TEXT CHECK(provider_transaction_sha256 IS NULL OR (length(provider_transaction_sha256)=64 AND provider_transaction_sha256 NOT GLOB '*[^0-9a-f]*')),\n recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at>0),\n CHECK((reconciliation_run_id IS NULL AND provider_page_sha256 IS NULL AND provider_transaction_sha256 IS NULL)\n  OR (reconciliation_run_id IS NOT NULL AND provider_page_sha256 IS NOT NULL AND provider_transaction_sha256 IS NOT NULL))\n)"
    },
    {
      "type": "trigger",
      "name": "v144_package_invoice_insert",
      "table_name": "subscription_package_invoice_requests",
      "sql": "CREATE TRIGGER v144_package_invoice_insert BEFORE INSERT ON subscription_package_invoice_requests\nWHEN NEW.state!='admitted' OR NEW.attempted_count!=0 OR NEW.attempted_at IS NOT NULL OR NEW.invoice_url IS NOT NULL\n OR NEW.provider_result_sha256 IS NOT NULL OR NEW.error_code!='' OR NEW.revision!=1 OR NEW.created_at!=NEW.updated_at\n OR NOT EXISTS(SELECT 1 FROM subscription_package_orders m JOIN subscription_orders o ON o.order_id=m.order_id\n  WHERE o.order_id=NEW.order_id AND o.telegram_id=NEW.telegram_id AND m.telegram_id=NEW.telegram_id\n  AND o.billing_mode='prepaid' AND o.order_state='created' AND o.created_at<=NEW.created_at AND o.expires_at>NEW.created_at)\nBEGIN SELECT RAISE(ABORT,'v144_package_invoice_admission_invalid'); END"
    },
    {
      "type": "trigger",
      "name": "v144_package_invoice_no_delete",
      "table_name": "subscription_package_invoice_requests",
      "sql": "CREATE TRIGGER v144_package_invoice_no_delete BEFORE DELETE ON subscription_package_invoice_requests\nBEGIN SELECT RAISE(ABORT,'v144_package_invoice_retains_attempt'); END"
    },
    {
      "type": "trigger",
      "name": "v144_package_invoice_update",
      "table_name": "subscription_package_invoice_requests",
      "sql": "CREATE TRIGGER v144_package_invoice_update BEFORE UPDATE ON subscription_package_invoice_requests\nWHEN NEW.request_id IS NOT OLD.request_id OR NEW.order_id IS NOT OLD.order_id OR NEW.telegram_id IS NOT OLD.telegram_id\n OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.created_at IS NOT OLD.created_at OR NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at\n OR NOT ((OLD.state='admitted' AND NEW.state IN ('attempted','rejected')) OR (OLD.state='attempted' AND NEW.state IN ('confirmed','rejected','unknown'))\n  OR (OLD.state='unknown' AND NEW.state IN ('confirmed','rejected')))\n OR (NEW.state IN ('attempted','confirmed','unknown') AND NEW.attempted_count!=1)\n OR (OLD.state='admitted' AND NEW.state='rejected' AND (NEW.attempted_count!=0 OR NEW.attempted_at IS NOT NULL))\n OR (NEW.attempted_count=1 AND NEW.updated_at<NEW.attempted_at)\n OR (OLD.attempted_count=1 AND (NEW.attempted_count!=1 OR NEW.attempted_at IS NOT OLD.attempted_at))\n OR (NEW.state='attempted' AND NOT EXISTS(SELECT 1 FROM subscription_orders o WHERE o.order_id=NEW.order_id\n  AND o.telegram_id=NEW.telegram_id AND o.order_state='created' AND o.expires_at>NEW.attempted_at))\nBEGIN SELECT RAISE(ABORT,'v144_package_invoice_transition_invalid'); END"
    },
    {
      "type": "trigger",
      "name": "v144_package_payment_review_binding",
      "table_name": "subscription_package_payment_reviews",
      "sql": "CREATE TRIGGER v144_package_payment_review_binding BEFORE INSERT ON subscription_package_payment_reviews\nWHEN NOT EXISTS(SELECT 1 FROM subscription_package_orders m JOIN subscription_orders o ON o.order_id=m.order_id\n JOIN payment_ledger p ON p.order_id=o.order_id\n WHERE m.order_id=NEW.order_id AND o.telegram_id=NEW.telegram_id AND m.telegram_id=NEW.telegram_id\n AND o.plan_code=NEW.plan_code AND o.billing_mode='prepaid' AND m.billing_mode='prepaid'\n AND o.invoice_payload=NEW.external_invoice_payload AND p.ledger_entry_id=NEW.ledger_entry_id\n AND p.telegram_id=NEW.telegram_id AND p.entry_type='payment' AND p.direction='credit' AND p.currency='XTR'\n AND p.amount_stars=o.amount_stars AND p.reason_code='package_payment_review_retained'\n AND p.related_ledger_entry_id IS NULL AND p.recorded_at<=NEW.recorded_at\n AND p.occurred_at>=o.created_at AND NOT EXISTS(SELECT 1 FROM subscription_package_periods pp WHERE pp.payment_ledger_entry_id=p.ledger_entry_id)\n AND EXISTS(SELECT 1 FROM payment_events e WHERE e.order_id=o.order_id AND e.telegram_id=NEW.telegram_id\n  AND e.telegram_update_id IS NEW.telegram_update_id AND e.event_type='payment_recorded' AND e.outcome='accepted'\n  AND e.reason_code='package_payment_review_retained' AND e.payload_sha256=NEW.evidence_sha256 AND e.received_at<=NEW.recorded_at))\nBEGIN SELECT RAISE(ABORT,'v144_package_payment_review_binding_invalid'); END"
    },
    {
      "type": "trigger",
      "name": "v144_package_payment_review_no_delete",
      "table_name": "subscription_package_payment_reviews",
      "sql": "CREATE TRIGGER v144_package_payment_review_no_delete BEFORE DELETE ON subscription_package_payment_reviews\nBEGIN SELECT RAISE(ABORT,'v144_package_payment_review_retention_required'); END"
    },
    {
      "type": "trigger",
      "name": "v144_package_payment_review_no_update",
      "table_name": "subscription_package_payment_reviews",
      "sql": "CREATE TRIGGER v144_package_payment_review_no_update BEFORE UPDATE ON subscription_package_payment_reviews\nBEGIN SELECT RAISE(ABORT,'v144_package_payment_review_immutable'); END"
    }
  ],
  "schemaSha256": "05b92b451de13622ce0ca40f183a07907e22ee5ea8f9cd669b60478d0398b746",
  "migrationSha256": "e5337969a107d3fe8e80fa6e2125deda1cb5989fbf332d41ec0e84ccb5b9f6af"
});
export async function inspectPackagePaymentReviewSchema(db,{required=false}={}) {
 const manifest=PACKAGE_PAYMENT_REVIEW_SCHEMA;
 if(!db?.prepare||!db?.batch)fail();
 let result;
 try{result=await db.prepare("SELECT type,name,tbl_name AS table_name,sql FROM sqlite_schema WHERE tbl_name IN (?,?) ORDER BY type,name").bind(...manifest.tables).all();}catch{fail();}
 const actual=rows(result).map(({type,name,table_name,sql})=>({type,name,table_name,sql}));
 const marker=await db.prepare("SELECT version FROM re_schema_migrations WHERE version=?").bind(manifest.marker).first();
 if(!actual.length&&!marker){if(required)fail();return freeze({ready:true,present:false,metadataOnly:true});}
 if(!marker||JSON.stringify(actual)!==JSON.stringify(manifest.objects))fail();
 return freeze({ready:true,present:true,metadataOnly:true,marker:manifest.marker,schemaSha256:manifest.schemaSha256,migrationSha256:manifest.migrationSha256});
}
export function packagePaymentReviewSchemaAssertion(state) {
 const manifest=PACKAGE_PAYMENT_REVIEW_SCHEMA;
 if(!state?.present||state.marker!==manifest.marker||state.schemaSha256!==manifest.schemaSha256)fail();
 return freeze({sql:`(SELECT COALESCE(json_group_array(json(object)),'[]') FROM
  (SELECT json_object('type',type,'name',name,'table_name',tbl_name,'sql',sql) AS object
   FROM sqlite_schema WHERE tbl_name IN (?,?) ORDER BY type,name)) IS ?
  AND EXISTS(SELECT 1 FROM re_schema_migrations WHERE version=?)`,params:[...manifest.tables,JSON.stringify(manifest.objects),manifest.marker]});
}
