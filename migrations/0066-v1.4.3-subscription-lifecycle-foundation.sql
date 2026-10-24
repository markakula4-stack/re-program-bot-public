-- v1.4.3 Part 1: additive, CLOSED subscription lifecycle foundations.
-- Six new evidence/control tables and two bounded-read indexes only.
-- No old table/trigger is rebuilt; no user, ledger, order or rollout row is changed.
-- Apply only through a later reviewed expand controller, not to production in Part 1.

CREATE TABLE IF NOT EXISTS subscription_billing_contracts (
  contract_id TEXT PRIMARY KEY CHECK(length(contract_id)=36),
  telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),
  plan_code TEXT NOT NULL CHECK(plan_code IN ('professional','dragon')),
  price_id TEXT NOT NULL REFERENCES price_book(price_id),
  origin_order_id TEXT NOT NULL UNIQUE REFERENCES subscription_orders(order_id),
  external_invoice_payload TEXT NOT NULL UNIQUE CHECK(length(external_invoice_payload) BETWEEN 1 AND 128),
  external_payload_sha256 TEXT NOT NULL CHECK(length(external_payload_sha256)=64 AND external_payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  terms_revision TEXT NOT NULL CHECK(length(terms_revision) BETWEEN 8 AND 64),
  terms_acceptance_id TEXT NOT NULL REFERENCES terms_acceptances(acceptance_id),
  billing_mode TEXT NOT NULL CHECK(billing_mode='recurring'),
  period_seconds INTEGER NOT NULL CHECK(period_seconds=2592000),
  currency TEXT NOT NULL CHECK(currency='XTR'),
  amount_stars INTEGER NOT NULL CHECK(typeof(amount_stars)='integer' AND amount_stars BETWEEN 1 AND 10000),
  -- Raw BotSubscription states use canceled, with one l. Unconfirmed is local.
  provider_state TEXT NOT NULL DEFAULT 'unconfirmed' CHECK(provider_state IN ('unconfirmed','active','canceled','failed')),
  auto_renew_confirmed INTEGER CHECK(auto_renew_confirmed IS NULL OR (typeof(auto_renew_confirmed)='integer' AND auto_renew_confirmed IN (0,1))),
  first_payment_ledger_entry_id TEXT REFERENCES payment_ledger(ledger_entry_id),
  last_provider_event_id TEXT REFERENCES subscription_provider_events(event_id),
  retired_at INTEGER,
  retirement_event_id TEXT REFERENCES subscription_provider_events(event_id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>0),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=created_at),
  CHECK((retired_at IS NULL AND retirement_event_id IS NULL) OR (typeof(retired_at)='integer' AND retired_at>=created_at AND retirement_event_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_v143_billing_contract_own ON subscription_billing_contracts(telegram_id,created_at DESC,contract_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_v143_billing_contract_one_open ON subscription_billing_contracts(telegram_id) WHERE retired_at IS NULL;
CREATE TRIGGER IF NOT EXISTS v143_contract_insert_binding BEFORE INSERT ON subscription_billing_contracts
WHEN NEW.provider_state!='unconfirmed' OR NEW.auto_renew_confirmed IS NOT NULL OR NEW.first_payment_ledger_entry_id IS NOT NULL OR NEW.last_provider_event_id IS NOT NULL OR NEW.retired_at IS NOT NULL OR NEW.retirement_event_id IS NOT NULL OR NEW.revision!=1 OR NOT EXISTS(
 SELECT 1 FROM subscription_orders o JOIN terms_acceptances t ON t.acceptance_id=NEW.terms_acceptance_id
 WHERE o.order_id=NEW.origin_order_id AND o.telegram_id=NEW.telegram_id AND o.plan_code=NEW.plan_code
 AND o.price_id=NEW.price_id AND o.invoice_payload=NEW.external_invoice_payload AND o.terms_revision=NEW.terms_revision
 AND o.billing_mode='recurring' AND o.access_seconds=NEW.period_seconds AND o.amount_stars=NEW.amount_stars AND o.currency=NEW.currency
 AND t.telegram_id=NEW.telegram_id AND t.terms_revision=NEW.terms_revision AND t.acceptance_scope='stars_purchase'
 AND t.accepted_at<=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'v143_contract_binding_invalid'); END;
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
  SELECT 1 FROM payment_ledger p JOIN subscription_orders o ON o.order_id=p.order_id
  WHERE p.ledger_entry_id=NEW.first_payment_ledger_entry_id AND p.order_id=NEW.origin_order_id
  AND p.telegram_id=NEW.telegram_id AND p.entry_type='payment' AND p.direction='credit'
  AND p.currency=NEW.currency AND p.amount_stars=NEW.amount_stars AND o.billing_mode='recurring'))
BEGIN SELECT RAISE(ABORT,'v143_contract_update_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v143_contract_no_delete BEFORE DELETE ON subscription_billing_contracts
BEGIN SELECT RAISE(ABORT,'v143_contract_retains_evidence'); END;

-- This is an operation identity/link, NOT an independent money ledger.
-- A provider charge can have an incoming payment AND an outgoing observation.
CREATE TABLE IF NOT EXISTS subscription_payment_links (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=36),
  operation_key TEXT NOT NULL UNIQUE CHECK(length(operation_key) BETWEEN 16 AND 160),
  provider_charge_id TEXT NOT NULL CHECK(length(provider_charge_id) BETWEEN 1 AND 256),
  provider_charge_sha256 TEXT NOT NULL CHECK(length(provider_charge_sha256)=64 AND provider_charge_sha256 NOT GLOB '*[^0-9a-f]*'),
  direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
  link_kind TEXT NOT NULL CHECK(link_kind IN ('recurring_charge','late_prepaid_charge','outgoing_observation')),
  contract_id TEXT REFERENCES subscription_billing_contracts(contract_id),
  origin_order_id TEXT REFERENCES subscription_orders(order_id),
  applied_order_id TEXT REFERENCES subscription_orders(order_id),
  telegram_id INTEGER CHECK(telegram_id IS NULL OR (typeof(telegram_id)='integer' AND telegram_id>0)),
  plan_code TEXT CHECK(plan_code IS NULL OR plan_code IN ('professional','dragon')),
  external_invoice_payload TEXT CHECK(external_invoice_payload IS NULL OR length(external_invoice_payload) BETWEEN 1 AND 128),
  external_payload_sha256 TEXT CHECK(external_payload_sha256 IS NULL OR (length(external_payload_sha256)=64 AND external_payload_sha256 NOT GLOB '*[^0-9a-f]*')),
  ledger_entry_id TEXT REFERENCES payment_ledger(ledger_entry_id),
  original_payment_ledger_entry_id TEXT REFERENCES payment_ledger(ledger_entry_id),
  provider_period_start INTEGER,
  provider_period_end INTEGER,
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  occurred_at INTEGER CHECK(occurred_at IS NULL OR (typeof(occurred_at)='integer' AND occurred_at>0)),
  recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at>0),
  UNIQUE(provider_charge_id,direction),
  CHECK((direction='incoming' AND link_kind IN ('recurring_charge','late_prepaid_charge')
    AND origin_order_id IS NOT NULL AND applied_order_id IS NOT NULL AND telegram_id IS NOT NULL AND plan_code IS NOT NULL
    AND external_invoice_payload IS NOT NULL AND external_payload_sha256 IS NOT NULL AND ledger_entry_id IS NOT NULL
    AND original_payment_ledger_entry_id IS NULL)
   OR (direction='outgoing' AND link_kind='outgoing_observation' AND applied_order_id IS NULL)),
  CHECK((link_kind='recurring_charge' AND contract_id IS NOT NULL AND typeof(provider_period_start)='integer'
    AND provider_period_start>0 AND provider_period_end=provider_period_start+2592000)
   OR (link_kind!='recurring_charge' AND provider_period_start IS NULL AND provider_period_end IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_v143_payment_link_effect ON subscription_payment_links(ledger_entry_id) WHERE ledger_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_v143_payment_link_own ON subscription_payment_links(telegram_id,recorded_at DESC,operation_id);
CREATE INDEX IF NOT EXISTS idx_v143_payment_link_contract ON subscription_payment_links(contract_id,direction,recorded_at DESC,operation_id);
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
   AND origin.invoice_payload=NEW.external_invoice_payload AND child.invoice_payload!=NEW.external_invoice_payload)))
BEGIN SELECT RAISE(ABORT,'v143_payment_link_binding_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v143_payment_link_outgoing_binding BEFORE INSERT ON subscription_payment_links
WHEN NEW.direction='outgoing' AND (
 (NEW.contract_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_billing_contracts c
  WHERE c.contract_id=NEW.contract_id AND c.telegram_id=NEW.telegram_id AND c.plan_code=NEW.plan_code AND c.origin_order_id=NEW.origin_order_id
  AND (NEW.external_invoice_payload IS NULL OR NEW.external_invoice_payload=c.external_invoice_payload)
  AND (NEW.external_payload_sha256 IS NULL OR NEW.external_payload_sha256=c.external_payload_sha256)))
 OR (NEW.origin_order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_orders o
  WHERE o.order_id=NEW.origin_order_id AND o.telegram_id=NEW.telegram_id AND o.plan_code=NEW.plan_code
  AND (NEW.external_invoice_payload IS NULL OR NEW.external_invoice_payload=o.invoice_payload)))
 OR (NEW.original_payment_ledger_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_ledger p
  WHERE p.ledger_entry_id=NEW.original_payment_ledger_entry_id AND p.entry_type='payment' AND p.direction='credit'
  AND p.telegram_id=NEW.telegram_id AND p.telegram_payment_charge_id=NEW.provider_charge_id
  AND (NEW.origin_order_id IS NULL OR p.order_id=NEW.origin_order_id OR EXISTS(SELECT 1 FROM subscription_payment_links incoming
   WHERE incoming.direction='incoming' AND incoming.ledger_entry_id=p.ledger_entry_id AND incoming.origin_order_id=NEW.origin_order_id))
  AND (NEW.contract_id IS NULL OR EXISTS(SELECT 1 FROM subscription_payment_links incoming
   WHERE incoming.direction='incoming' AND incoming.ledger_entry_id=p.ledger_entry_id AND incoming.contract_id=NEW.contract_id))))
 OR (NEW.ledger_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_ledger p
  WHERE p.ledger_entry_id=NEW.ledger_entry_id AND p.direction='debit' AND p.entry_type IN ('refund','chargeback')
  AND p.related_ledger_entry_id=NEW.original_payment_ledger_entry_id AND p.telegram_id=NEW.telegram_id
  AND p.telegram_payment_charge_id=NEW.provider_charge_id)))
BEGIN SELECT RAISE(ABORT,'v143_outgoing_link_binding_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v143_payment_link_no_update BEFORE UPDATE ON subscription_payment_links
BEGIN SELECT RAISE(ABORT,'v143_operation_identity_append_only'); END;
CREATE TRIGGER IF NOT EXISTS v143_payment_link_no_delete BEFORE DELETE ON subscription_payment_links
BEGIN SELECT RAISE(ABORT,'v143_operation_identity_append_only'); END;

CREATE TABLE IF NOT EXISTS subscription_provider_events (
  event_id TEXT PRIMARY KEY CHECK(length(event_id)=36),
  event_key TEXT NOT NULL UNIQUE CHECK(length(event_key) BETWEEN 16 AND 160),
  contract_id TEXT REFERENCES subscription_billing_contracts(contract_id),
  operation_id TEXT REFERENCES subscription_payment_links(operation_id),
  command_id TEXT REFERENCES subscription_provider_commands(command_id),
  telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),
  event_type TEXT NOT NULL CHECK(event_type IN ('contract_created','contract_retired','consent_recorded','provider_control','renewal_failed',
    'command_confirmed','command_rejected','command_unknown','lifecycle_transition','review_observed')),
  source TEXT NOT NULL CHECK(source IN ('user','telegram_update','telegram_reconciliation','provider_response','system')),
  telegram_update_id INTEGER CHECK(telegram_update_id IS NULL OR (typeof(telegram_update_id)='integer' AND telegram_update_id>=0)),
  provider_state TEXT CHECK(provider_state IS NULL OR provider_state IN ('active','canceled','failed')),
  from_state TEXT CHECK(from_state IS NULL OR from_state IN ('active','cancel_at_period_end','payment_failed','expired','refunded','chargeback','suspended')),
  to_state TEXT CHECK(to_state IS NULL OR to_state IN ('active','cancel_at_period_end','payment_failed','expired','refunded','chargeback','suspended')),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user','telegram','system','owner')),
  actor_id INTEGER,
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 3 AND 64),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  provider_occurred_at INTEGER CHECK(provider_occurred_at IS NULL OR (typeof(provider_occurred_at)='integer' AND provider_occurred_at>0)),
  received_at INTEGER NOT NULL CHECK(typeof(received_at)='integer' AND received_at>0),
  CHECK((actor_type IN ('user','owner') AND typeof(actor_id)='integer' AND actor_id>0) OR (actor_type IN ('telegram','system') AND actor_id IS NULL)),
  CHECK(actor_type!='user' OR actor_id=telegram_id),
  CHECK(event_type NOT IN ('provider_control','renewal_failed') OR (contract_id IS NOT NULL AND source='telegram_update')),
  CHECK(event_type!='provider_control' OR provider_state IS NOT NULL),
  CHECK(event_type!='renewal_failed' OR provider_state='failed'),
  CHECK(event_type NOT IN ('command_confirmed','command_rejected','command_unknown') OR command_id IS NOT NULL),
  CHECK(event_type!='command_confirmed' OR source IN ('telegram_update','provider_response')),
  CHECK(event_type!='lifecycle_transition' OR to_state IS NOT NULL),
  CHECK(event_type!='contract_retired' OR (contract_id IS NOT NULL AND source='system' AND actor_type='system'))
);
CREATE INDEX IF NOT EXISTS idx_v143_provider_event_own ON subscription_provider_events(telegram_id,received_at DESC,event_id);
CREATE INDEX IF NOT EXISTS idx_v143_provider_event_contract ON subscription_provider_events(contract_id,received_at DESC,event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_v143_provider_event_update ON subscription_provider_events(telegram_update_id,event_type) WHERE telegram_update_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS v143_provider_event_binding BEFORE INSERT ON subscription_provider_events
WHEN (NEW.contract_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_billing_contracts c WHERE c.contract_id=NEW.contract_id AND c.telegram_id=NEW.telegram_id))
 OR (NEW.operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_payment_links p WHERE p.operation_id=NEW.operation_id AND p.telegram_id=NEW.telegram_id AND p.contract_id IS NEW.contract_id))
 OR (NEW.command_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands c WHERE c.command_id=NEW.command_id AND c.telegram_id=NEW.telegram_id AND c.contract_id IS NEW.contract_id))
BEGIN SELECT RAISE(ABORT,'v143_provider_event_binding_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v143_provider_event_no_update BEFORE UPDATE ON subscription_provider_events
BEGIN SELECT RAISE(ABORT,'v143_provider_event_append_only'); END;
CREATE TRIGGER IF NOT EXISTS v143_provider_event_no_delete BEFORE DELETE ON subscription_provider_events
BEGIN SELECT RAISE(ABORT,'v143_provider_event_append_only'); END;

CREATE TABLE IF NOT EXISTS subscription_provider_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 16 AND 160),
  contract_id TEXT NOT NULL REFERENCES subscription_billing_contracts(contract_id),
  telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),
  action TEXT NOT NULL CHECK(action IN ('cancel_renewal','reenable_renewal')),
  desired_auto_renew INTEGER NOT NULL CHECK(typeof(desired_auto_renew)='integer' AND desired_auto_renew IN (0,1)),
  expected_contract_revision INTEGER NOT NULL CHECK(typeof(expected_contract_revision)='integer' AND expected_contract_revision>0),
  first_payment_ledger_entry_id TEXT NOT NULL REFERENCES payment_ledger(ledger_entry_id),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL DEFAULT 'admitted' CHECK(state IN ('admitted','attempted','confirmed','rejected','unknown','superseded')),
  attempted_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempted_count)='integer' AND attempted_count IN (0,1)),
  attempted_at INTEGER,
  acknowledgement_event_id TEXT REFERENCES subscription_provider_events(event_id),
  error_code TEXT NOT NULL DEFAULT '' CHECK(length(error_code)<=64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>0),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=created_at),
  CHECK((action='cancel_renewal' AND desired_auto_renew=0) OR (action='reenable_renewal' AND desired_auto_renew=1)),
  CHECK((attempted_count=0 AND attempted_at IS NULL) OR (attempted_count=1 AND typeof(attempted_at)='integer' AND attempted_at>=created_at)),
  CHECK(state!='confirmed' OR acknowledgement_event_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_v143_provider_command_open ON subscription_provider_commands(contract_id) WHERE state IN ('admitted','attempted','unknown');
CREATE INDEX IF NOT EXISTS idx_v143_provider_command_own ON subscription_provider_commands(telegram_id,created_at DESC,command_id);
CREATE INDEX IF NOT EXISTS idx_v143_provider_command_review ON subscription_provider_commands(state,updated_at,command_id);
CREATE TRIGGER IF NOT EXISTS v143_provider_command_insert BEFORE INSERT ON subscription_provider_commands
WHEN NEW.state!='admitted' OR NEW.attempted_count!=0 OR NEW.acknowledgement_event_id IS NOT NULL OR NEW.revision!=1 OR NOT EXISTS(
 SELECT 1 FROM subscription_billing_contracts c JOIN payment_ledger p ON p.ledger_entry_id=c.first_payment_ledger_entry_id
 WHERE c.contract_id=NEW.contract_id AND c.telegram_id=NEW.telegram_id AND c.revision=NEW.expected_contract_revision
 AND p.ledger_entry_id=NEW.first_payment_ledger_entry_id AND p.telegram_id=NEW.telegram_id AND p.order_id=c.origin_order_id
 AND p.entry_type='payment' AND p.direction='credit')
BEGIN SELECT RAISE(ABORT,'v143_provider_command_admission_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v143_provider_command_update BEFORE UPDATE ON subscription_provider_commands
WHEN NEW.command_id IS NOT OLD.command_id OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.contract_id IS NOT OLD.contract_id
 OR NEW.telegram_id IS NOT OLD.telegram_id OR NEW.action IS NOT OLD.action OR NEW.desired_auto_renew IS NOT OLD.desired_auto_renew
 OR NEW.expected_contract_revision IS NOT OLD.expected_contract_revision OR NEW.first_payment_ledger_entry_id IS NOT OLD.first_payment_ledger_entry_id
 OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.created_at IS NOT OLD.created_at OR NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at
 OR NOT ((OLD.state='admitted' AND NEW.state IN ('attempted','rejected','superseded'))
  OR (OLD.state='attempted' AND NEW.state IN ('confirmed','rejected','unknown'))
  OR (OLD.state='unknown' AND NEW.state IN ('confirmed','rejected','superseded')))
 OR (NEW.state IN ('attempted','confirmed','unknown') AND NEW.attempted_count!=1)
 OR (OLD.attempted_count=1 AND (NEW.attempted_count!=1 OR NEW.attempted_at IS NOT OLD.attempted_at))
 OR (NEW.state='confirmed' AND NOT EXISTS(SELECT 1 FROM subscription_provider_events e WHERE e.event_id=NEW.acknowledgement_event_id
  AND e.command_id=NEW.command_id AND e.contract_id=NEW.contract_id AND e.telegram_id=NEW.telegram_id AND e.event_type='command_confirmed'
  AND ((e.source='provider_response' AND e.provider_state IS NULL) OR (e.source='telegram_update'
   AND e.provider_state=CASE WHEN NEW.desired_auto_renew=1 THEN 'active' ELSE 'canceled' END))))
BEGIN SELECT RAISE(ABORT,'v143_provider_command_transition_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v143_provider_command_no_delete BEFORE DELETE ON subscription_provider_commands
BEGIN SELECT RAISE(ABORT,'v143_provider_command_retains_unknown'); END;

-- Existing notification_jobs CHECK is Preview-only and is left untouched.
CREATE TABLE IF NOT EXISTS paid_subscription_notification_jobs (
  job_key TEXT PRIMARY KEY CHECK(length(job_key) BETWEEN 16 AND 160),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(subscription_id),
  telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),
  event_id TEXT REFERENCES subscription_provider_events(event_id),
  job_type TEXT NOT NULL CHECK(job_type IN ('renewal_canceled','renewal_failed','period_expiring','period_expired')),
  expected_subscription_revision INTEGER NOT NULL CHECK(typeof(expected_subscription_revision)='integer' AND expected_subscription_revision>0),
  expected_period_end INTEGER NOT NULL CHECK(typeof(expected_period_end)='integer' AND expected_period_end>0),
  expected_lifecycle_state TEXT NOT NULL CHECK(expected_lifecycle_state IN ('active','cancel_at_period_end','payment_failed','expired','refunded','chargeback','suspended')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed','suppressed','unknown')),
  scheduled_for INTEGER NOT NULL CHECK(typeof(scheduled_for)='integer' AND scheduled_for>0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempt_count)='integer' AND attempt_count BETWEEN 0 AND 3),
  delivery_started_at INTEGER,
  telegram_message_id INTEGER,
  delivery_receipt_sha256 TEXT CHECK(delivery_receipt_sha256 IS NULL OR (length(delivery_receipt_sha256)=64 AND delivery_receipt_sha256 NOT GLOB '*[^0-9a-f]*')),
  sent_at INTEGER,
  last_error_code TEXT NOT NULL DEFAULT '' CHECK(length(last_error_code)<=64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>0),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=created_at),
  CHECK(status!='sent' OR (typeof(telegram_message_id)='integer' AND telegram_message_id>0 AND delivery_receipt_sha256 IS NOT NULL AND typeof(sent_at)='integer' AND sent_at>=created_at)),
  CHECK(attempt_count=0 OR (typeof(delivery_started_at)='integer' AND delivery_started_at>=created_at))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_v143_paid_notification_dedupe ON paid_subscription_notification_jobs(subscription_id,job_type,expected_period_end,COALESCE(event_id,''));
CREATE INDEX IF NOT EXISTS idx_v143_paid_notification_due ON paid_subscription_notification_jobs(status,scheduled_for,job_key);
CREATE INDEX IF NOT EXISTS idx_v143_paid_notification_own ON paid_subscription_notification_jobs(telegram_id,created_at DESC,job_key);
CREATE TRIGGER IF NOT EXISTS v143_paid_notification_insert BEFORE INSERT ON paid_subscription_notification_jobs
WHEN NEW.status!='pending' OR NEW.attempt_count!=0 OR NEW.revision!=1 OR NOT EXISTS(SELECT 1 FROM subscriptions s
 WHERE s.subscription_id=NEW.subscription_id AND s.telegram_id=NEW.telegram_id
 AND s.revision=NEW.expected_subscription_revision AND s.current_period_end=NEW.expected_period_end)
 OR (NEW.event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_provider_events e WHERE e.event_id=NEW.event_id AND e.telegram_id=NEW.telegram_id))
BEGIN SELECT RAISE(ABORT,'v143_paid_notification_binding_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v143_paid_notification_update BEFORE UPDATE ON paid_subscription_notification_jobs
WHEN NEW.job_key IS NOT OLD.job_key OR NEW.subscription_id IS NOT OLD.subscription_id OR NEW.telegram_id IS NOT OLD.telegram_id
 OR NEW.event_id IS NOT OLD.event_id OR NEW.job_type IS NOT OLD.job_type OR NEW.expected_subscription_revision IS NOT OLD.expected_subscription_revision
 OR NEW.expected_period_end IS NOT OLD.expected_period_end OR NEW.expected_lifecycle_state IS NOT OLD.expected_lifecycle_state
 OR NEW.scheduled_for IS NOT OLD.scheduled_for OR NEW.created_at IS NOT OLD.created_at OR NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at
 OR NOT ((OLD.status='pending' AND NEW.status IN ('processing','suppressed'))
  OR (OLD.status='processing' AND NEW.status IN ('sent','failed','suppressed','unknown'))
  OR (OLD.status='failed' AND NEW.status IN ('processing','suppressed'))
  OR (OLD.status='unknown' AND NEW.status IN ('sent','suppressed')))
 OR (NEW.status='processing' AND (NEW.attempt_count!=OLD.attempt_count+1 OR
  (OLD.status='failed' AND OLD.last_error_code NOT IN ('telegram_rate_limited','retry_after')) OR NOT EXISTS(SELECT 1 FROM subscriptions s
  WHERE s.subscription_id=NEW.subscription_id AND s.telegram_id=NEW.telegram_id AND s.revision=NEW.expected_subscription_revision
  AND s.current_period_end=NEW.expected_period_end)))
 OR (NEW.status!='processing' AND (NEW.attempt_count!=OLD.attempt_count OR NEW.delivery_started_at IS NOT OLD.delivery_started_at))
BEGIN SELECT RAISE(ABORT,'v143_paid_notification_transition_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v143_paid_notification_no_delete BEFORE DELETE ON paid_subscription_notification_jobs
BEGIN SELECT RAISE(ABORT,'v143_paid_notification_retention_required'); END;

-- Review decisions link genuine existing money evidence; they do not create money.
CREATE TABLE IF NOT EXISTS payment_review_resolutions (
  resolution_id TEXT PRIMARY KEY CHECK(length(resolution_id)=36),
  resolution_key TEXT NOT NULL UNIQUE CHECK(length(resolution_key) BETWEEN 16 AND 160),
  operation_id TEXT NOT NULL REFERENCES subscription_payment_links(operation_id),
  reconciliation_item_id TEXT REFERENCES payment_reconciliation_items(item_id),
  original_payment_ledger_entry_id TEXT REFERENCES payment_ledger(ledger_entry_id),
  financial_effect_ledger_entry_id TEXT REFERENCES payment_ledger(ledger_entry_id),
  decision TEXT NOT NULL CHECK(decision IN ('review_required','no_financial_effect','confirmed_refund','confirmed_chargeback','confirmed_adjustment')),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('owner','system')),
  actor_id INTEGER,
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 3 AND 64),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  supersedes_resolution_id TEXT REFERENCES payment_review_resolutions(resolution_id),
  recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at>0),
  CHECK((actor_type='owner' AND typeof(actor_id)='integer' AND actor_id>0) OR (actor_type='system' AND actor_id IS NULL)),
  CHECK(decision!='confirmed_chargeback' OR actor_type='owner'),
  CHECK((decision IN ('review_required','no_financial_effect') AND financial_effect_ledger_entry_id IS NULL)
   OR (decision IN ('confirmed_refund','confirmed_chargeback','confirmed_adjustment') AND original_payment_ledger_entry_id IS NOT NULL AND financial_effect_ledger_entry_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_v143_review_financial_effect ON payment_review_resolutions(financial_effect_ledger_entry_id) WHERE financial_effect_ledger_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_v143_review_one_outgoing_classification ON payment_review_resolutions(operation_id) WHERE decision IN ('confirmed_refund','confirmed_chargeback');
CREATE INDEX IF NOT EXISTS idx_v143_review_operation ON payment_review_resolutions(operation_id,recorded_at,resolution_id);
CREATE INDEX IF NOT EXISTS idx_v143_review_queue ON payment_review_resolutions(decision,recorded_at,resolution_id);
CREATE TRIGGER IF NOT EXISTS v143_review_resolution_binding BEFORE INSERT ON payment_review_resolutions
WHEN (NEW.supersedes_resolution_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_review_resolutions r WHERE r.resolution_id=NEW.supersedes_resolution_id AND r.operation_id=NEW.operation_id))
 OR (NEW.reconciliation_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_reconciliation_items r JOIN subscription_payment_links l ON l.operation_id=NEW.operation_id
  WHERE r.item_id=NEW.reconciliation_item_id AND r.transaction_direction=l.direction AND r.transaction_id_sha256=l.provider_charge_sha256
  AND (r.telegram_id IS NULL OR l.telegram_id IS NULL OR r.telegram_id=l.telegram_id)))
 OR (NEW.original_payment_ledger_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_ledger p JOIN subscription_payment_links l ON l.operation_id=NEW.operation_id
  WHERE p.ledger_entry_id=NEW.original_payment_ledger_entry_id AND p.entry_type='payment' AND p.direction='credit'
  AND (l.telegram_id IS NULL OR p.telegram_id=l.telegram_id) AND p.telegram_payment_charge_id=l.provider_charge_id))
 OR (NEW.financial_effect_ledger_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_ledger e JOIN payment_ledger p ON p.ledger_entry_id=NEW.original_payment_ledger_entry_id
  JOIN subscription_payment_links l ON l.operation_id=NEW.operation_id
  WHERE e.ledger_entry_id=NEW.financial_effect_ledger_entry_id AND e.related_ledger_entry_id=p.ledger_entry_id
  AND e.telegram_id=p.telegram_id AND e.order_id=p.order_id AND e.currency=p.currency AND (l.telegram_id IS NULL OR p.telegram_id=l.telegram_id)
  AND p.telegram_payment_charge_id=l.provider_charge_id
  AND ((NEW.decision='confirmed_refund' AND l.direction='outgoing' AND e.entry_type='refund' AND e.direction='debit' AND e.telegram_payment_charge_id=l.provider_charge_id)
   OR (NEW.decision='confirmed_chargeback' AND l.direction='outgoing' AND e.entry_type='chargeback' AND e.direction='debit' AND e.telegram_payment_charge_id=l.provider_charge_id)
   OR (NEW.decision='confirmed_adjustment' AND e.entry_type='adjustment'))))
BEGIN SELECT RAISE(ABORT,'v143_review_resolution_binding_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v143_review_resolution_no_update BEFORE UPDATE ON payment_review_resolutions
BEGIN SELECT RAISE(ABORT,'v143_review_resolution_append_only'); END;
CREATE TRIGGER IF NOT EXISTS v143_review_resolution_no_delete BEFORE DELETE ON payment_review_resolutions
BEGIN SELECT RAISE(ABORT,'v143_review_resolution_append_only'); END;

CREATE INDEX IF NOT EXISTS idx_v143_ledger_related_type ON payment_ledger(related_ledger_entry_id,entry_type,ledger_entry_id);
CREATE INDEX IF NOT EXISTS idx_v143_reconciliation_review ON payment_reconciliation_items(local_state,observed_at,item_id);
INSERT OR IGNORE INTO re_schema_migrations(version) VALUES('1.4.3-subscription-lifecycle-foundation');
