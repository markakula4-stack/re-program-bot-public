import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { authoritySeconds, createAuthorityResolver } from '../src/v1.4.1/authority-resolver.mjs';
import { buildStarsInvoicePayload, selectServerPrice } from '../src/v1.3.6/stars-core-foundation.mjs';
import { acceptStarsPurchaseTerms, recordStarsSuccessfulPayment } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsPaidAccess } from '../src/v1.3.6/stars-access-runtime.mjs';
import { PACKAGE_CONTRACT_VERSION, PACKAGE_DURATIONS, PACKAGE_CANONICAL_PRICES,
  readPackageContractConfig, normalizeServerPackagePrice, selectServerPackagePrice,
  resolveOwnPackagePeriodAuthority, readVerifiedPackagePeriods, compilePackagePeriodAssertions,
  projectPackagePaidBoundary, createServerPackageQuote, createServerMonthlyTransitionQuote,
  assertPackageQuoteAdmissible, assertRecurringExitConfirmed, monthlyTransitionEligibility,
  planScheduledPackageTransition, cancelScheduledPackageTransition } from '../src/v1.4.4/package-contract.mjs';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const stamp = seconds => new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
const resolver = createAuthorityResolver();
let sequence = 1440000;
const rejected = (fn, code) => assert.throws(fn, error => error.code === code);
const rejectedAsync = (fn, code) => assert.rejects(fn, error => error.code === code);

function fixture(t, patch = {}) {
  const f = foundationFixture(t);
  f.sqlite.function('current_timestamp', { deterministic: false }, () => stamp(f.now));
  f.sqlite.function('unixepoch', { deterministic: false, varargs: true }, (...args) =>
    !args.length || args[0] === 'now' ? f.now : authoritySeconds(args[0]));
  for (const name of ['0026-v1.3.6-stars-core-foundation.sql', '0027-v1.3.6-stars-access-and-reconciliation.sql',
    '0066-v1.4.3-subscription-lifecycle-foundation.sql', '0067-v1.4.3-lifecycle-engine-binding.sql',
    '0068-v1.4.3-provider-and-review-binding.sql', '0069-v1.4.3-d1-compatibility.sql',
    '0070-v1.4.3-refund-notification.sql', '0071-v1.4.3-refund-contract-retirement.sql', '0072-v1.4.4-package-contract.sql',
    '0073-v1.4.4-package-payment-review.sql'])
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  f.serverEnv = { ...f.serverEnv, STARS_PAYMENTS_ENABLED: 'true', STARS_BILLING_MODE: 'prepaid',
    STARS_PRICE_VERSION: '1', STARS_TERMS_REVISION: '2026-09-10.stars-v1', STARS_RECURRING_ENABLED: 'true',
    STARS_INVOICE_SECRET: 'synthetic-v144-offline-only-secret-longer-than-thirty-two-characters',
    STARS_ROLLOUT_MODE: 'allowlist', STARS_ROLLOUT_ALLOWLIST: '900',
    STARS_PACKAGES_ENABLED: 'true', STARS_PACKAGE_3M_ENABLED: 'true', ...patch };
  for (const plan of ['professional', 'dragon']) for (const [code, period] of Object.entries(PACKAGE_DURATIONS))
    f.sqlite.prepare(`INSERT INTO price_book(price_id,price_version,plan_code,currency,amount_stars,
      access_seconds,billing_mode,publication_state,terms_revision,valid_from,created_at)
      VALUES(?,1,?,'XTR',?,?,'prepaid','approved',?,?,?)`).run(`${plan}-${period.durationDays}d-prepaid-v1`,
      plan, PACKAGE_CANONICAL_PRICES[plan][code], period.periodSeconds,
      f.serverEnv.STARS_TERMS_REVISION, f.now - 10000, f.now - 10000);
  for (const actorId of [101, 900]) {
    f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(actorId);
    f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(actorId);
  }
  return f;
}
async function own(f, actorId = 900) {
  const actor = await resolver.resolveActor(await f.context(actorId, 'access.read_own'));
  const verifiedPackagePeriods = await resolveOwnPackagePeriodAuthority({ actor, nowSec: f.now });
  return { actor, verifiedPackagePeriods, nowSec: f.now };
}
const quote = (scope, plan = 'professional', code = '3m') => createServerPackageQuote({ ...scope,
  request: { requestedPlanCode: plan, packageCode: code } });

async function seedOrder(f, { plan = 'professional', mode = 'prepaid', days = 30, createdAt = f.now - 100,
  prepaidState = 'precheckout_ok' } = {}) {
  const price = f.sqlite.prepare('SELECT * FROM price_book WHERE price_id=?').get(`${plan}-${days}d-${mode}-v1`);
  await acceptStarsPurchaseTerms({ ...f.serverEnv, STARS_TERMS_REVISION: price.terms_revision },
    { telegramId: 900, telegramUpdateId: ++sequence, acceptedAt: createdAt - 1 });
  const orderId = crypto.randomUUID();
  const payload = await buildStarsInvoicePayload({ invoiceSecret: f.serverEnv.STARS_INVOICE_SECRET,
    orderId, telegramId: 900, priceId: price.price_id });
  f.sqlite.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,
    currency,amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,
    expires_at,precheckout_approved_at,updated_at) VALUES(?,900,?,1,?,'XTR',?,?,?,?,?,?,?,?,?,?)`)
    .run(orderId, price.price_id, plan, price.amount_stars, price.access_seconds, mode, price.terms_revision,
      payload, prepaidState, createdAt, f.now + 600, prepaidState === 'precheckout_ok' ? createdAt + 1 : null, createdAt + 1);
  return { orderId, payload, price, createdAt };
}
async function seedCurrent(f, { plan = 'professional', mode = 'prepaid' } = {}) {
  const order = await seedOrder(f, { plan, mode });
  if (mode === 'recurring') {
    const acceptance = f.sqlite.prepare('SELECT acceptance_id FROM terms_acceptances WHERE telegram_id=900 AND terms_revision=?')
      .get(order.price.terms_revision);
    order.contractId = crypto.randomUUID();
    f.sqlite.prepare(`INSERT INTO subscription_billing_contracts(contract_id,telegram_id,plan_code,price_id,
      origin_order_id,external_invoice_payload,external_payload_sha256,terms_revision,terms_acceptance_id,
      billing_mode,period_seconds,currency,amount_stars,created_at,updated_at)
      VALUES(?,900,?,?,?,?,?,?,?,'recurring',2592000,'XTR',?,?,?)`).run(order.contractId, plan,
      order.price.price_id, order.orderId, order.payload, hash(order.payload), order.price.terms_revision,
      acceptance.acceptance_id, order.price.amount_stars, order.createdAt, order.createdAt);
  }
  const paidAt = f.now - 10, end = paidAt + 2592000;
  const recorded = await recordStarsSuccessfulPayment(f.serverEnv, { update_id: ++sequence, message: {
    message_id: ++sequence, date: paidAt, from: { id: 900, is_bot: false }, chat: { id: 900, type: 'private' },
    successful_payment: { currency: 'XTR', total_amount: order.price.amount_stars, invoice_payload: order.payload,
      telegram_payment_charge_id: 'synthetic-v144-monthly-' + sequence, provider_payment_charge_id: '',
      ...(mode === 'recurring' ? { is_recurring: true, is_first_recurring: true, subscription_expiration_date: end } : {}) } } },
  { receivedAt: paidAt });
  const applied = await applyStarsPaidAccess(f.serverEnv, { orderId: recorded.orderId, appliedAt: paidAt });
  assert.equal(applied.accessApplied, true);
  return { ...order, recorded, applied, paidAt, end };
}

// Explicitly synthetic future facts in an isolated SQLite database. Part 2
// supplies the genuine webhook producer; this helper does not assert one ran.
async function seedFuture(f, offered, { paidAt = f.now, start = Math.max(offered.quotedStartsAt, paidAt),
  opaqueCharge = 'synthetic-v144-package-charge-' + ++sequence } = {}) {
  const order = await seedOrder(f, { plan: offered.planCode, days: offered.durationDays,
    createdAt: offered.createdAt, prepaidState: 'created' });
  const data = { order_id: order.orderId, telegram_id: 900, contract_version: offered.contractVersion,
    package_code: offered.packageCode, duration_days: offered.durationDays, period_seconds: offered.periodSeconds,
    price_id: offered.priceId, price_version: offered.priceVersion, plan_code: offered.planCode,
    billing_mode: offered.billingMode, currency: offered.currency, amount_stars: offered.amountStars,
    offer_version: offered.offerVersion, campaign_code: offered.campaignCode,
    quoted_starts_at: offered.quotedStartsAt, quoted_ends_at: offered.quotedEndsAt,
    source_subscription_id: offered.sourceSubscriptionId, source_package_period_id: offered.sourcePackagePeriodId,
    source_paid_until: offered.sourcePaidUntil, source_revision: offered.sourceRevision,
    source_payment_ledger_entry_id: offered.sourcePaymentLedgerEntryId, source_fingerprint: offered.sourceFingerprint,
    transition_id: null, created_at: offered.createdAt };
  f.sqlite.prepare(`INSERT INTO subscription_package_orders(${Object.keys(data).join(',')}) VALUES(${Object.keys(data).map(() => '?').join(',')})`)
    .run(...Object.values(data));
  f.sqlite.prepare("UPDATE subscription_orders SET order_state='precheckout_ok',precheckout_approved_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=?")
    .run(f.now, f.now, order.orderId);
  const ledgerId = 'synthetic-v144-paid-' + crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO payment_ledger(ledger_entry_id,idempotency_key,order_id,telegram_id,entry_type,
    direction,currency,amount_stars,telegram_payment_charge_id,reason_code,occurred_at,recorded_at)
    VALUES(?,?,?,900,'payment','credit','XTR',? ,?,'successful_payment',?,?)`)
    .run(ledgerId, 'synthetic-v144-ledger:' + ledgerId, order.orderId, offered.amountStars, opaqueCharge, paidAt, paidAt);
  f.sqlite.prepare("UPDATE subscription_orders SET order_state='paid',paid_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=?")
    .run(paidAt, paidAt, order.orderId);
  const periodId = crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO subscription_package_periods(period_id,order_id,payment_ledger_entry_id,telegram_id,
    plan_code,price_id,price_version,billing_mode,starts_at,ends_at,period_seconds,recorded_at)
    VALUES(?,?,?,900,?,?,1,'prepaid',?,?,?,?)`).run(periodId, order.orderId, ledgerId,
      offered.planCode, offered.priceId, start, start + offered.periodSeconds, offered.periodSeconds, paidAt);
  return { ...order, periodId, ledgerId, paidAt, start, end: start + offered.periodSeconds, opaqueCharge };
}

function cancellation(f, current, { state = 'confirmed' } = {}) {
  const contract = f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(current.contractId);
  const commandId = crypto.randomUUID(), eventId = crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO subscription_provider_commands(command_id,idempotency_key,contract_id,telegram_id,
    action,desired_auto_renew,expected_contract_revision,first_payment_ledger_entry_id,request_sha256,created_at,updated_at)
    VALUES(?,?,?,900,'cancel_renewal',0,?,?,?,?,?)`).run(commandId, 'synthetic-v144-cancel:' + commandId,
      current.contractId, contract.revision, contract.first_payment_ledger_entry_id, hash('synthetic cancellation'), f.now, f.now);
  f.sqlite.prepare(`UPDATE subscription_provider_commands SET state='attempted',attempted_count=1,attempted_at=?,revision=revision+1,
    updated_at=? WHERE command_id=?`).run(f.now, f.now, commandId);
  f.sqlite.prepare(`INSERT INTO subscription_provider_events(event_id,event_key,contract_id,command_id,telegram_id,
    event_type,source,actor_type,reason_code,evidence_sha256,received_at) VALUES(?,?,?,?,900,?,?,'system',?,?,?)`)
    .run(eventId, 'synthetic-v144-ack:' + commandId, current.contractId, commandId,
      state === 'confirmed' ? 'command_confirmed' : 'command_unknown', state === 'confirmed' ? 'provider_response' : 'system',
      state === 'confirmed' ? 'telegram_command_acknowledged' : 'telegram_provider_unknown',
      hash(JSON.stringify([commandId, 'cancel_renewal', state, ''])), f.now);
  f.sqlite.prepare(`UPDATE subscription_provider_commands SET state=?,acknowledgement_event_id=?,revision=revision+1,
    updated_at=? WHERE command_id=?`).run(state, state === 'confirmed' ? eventId : null, f.now, commandId);
  return { commandId, eventId };
}

test('canonical package prices, exact UTC days and closed defaults', () => {
  assert.deepEqual(Object.values(PACKAGE_DURATIONS).map(row => row.durationDays), [90, 180, 360]);
  assert.deepEqual(PACKAGE_CANONICAL_PRICES.professional, { '30d': 249, '3m': 699, '6m': 1299, '12m': 2299 });
  assert.deepEqual(PACKAGE_CANONICAL_PRICES.dragon, { '30d': 499, '3m': 1399, '6m': 2599, '12m': 4499 });
  const config = readPackageContractConfig();
  assert.equal(config.enabled, false); assert.deepEqual(config.packages, { '3m': false, '6m': false, '12m': false });
  assert.equal(config.campaignCode, null); assert.equal(config.ownerOnly, true);
  assert.equal(readPackageContractConfig({ STARS_PACKAGES_ENABLED: 'yes' }).enabled, false);
  rejected(() => readPackageContractConfig({ STARS_PACKAGE_CAMPAIGN_CODE: '../fake' }), 'package_config_invalid');
});

for (const plan of ['professional', 'dragon']) for (const code of ['3m', '6m', '12m'])
  test(`server-selected immutable ${plan}/${code}; synthetic evidence gates only`, async t => {
    const f = fixture(t, { STARS_PACKAGE_6M_ENABLED: 'true', STARS_PACKAGE_12M_ENABLED: 'true',
      STARS_PACKAGE_ECONOMICS_EVIDENCE_SHA256: hash('synthetic-only-economics'),
      STARS_PACKAGE_REFUND_EVIDENCE_SHA256: hash('synthetic-only-refund') });
    const scope = await own(f), result = quote(scope, plan, code);
    assert.equal(result.amountStars, PACKAGE_CANONICAL_PRICES[plan][code]);
    assert.equal(result.quotedStartsAt, f.now); assert.equal(result.quotedEndsAt - result.quotedStartsAt, PACKAGE_DURATIONS[code].periodSeconds);
    assert.equal(result.billingMode, 'prepaid'); assert.equal(result.campaignCode, null);
    assert.equal(result.accessApplied, false); assert.equal(result.recurringConsentTransferred, false);
    assert.equal(result.sourceSubscriptionId, null); assert.equal(result.sourcePaidUntil, null);
    assert.equal(Object.isFrozen(result), true);
  });

test('client cannot alter actor, flags, amount, duration, catalog or price ID', async t => {
  const f = fixture(t), scope = await own(f);
  rejected(() => quote(scope, 'professional', '6m'), 'package_disabled');
  rejected(() => createServerPackageQuote({ ...scope, env: { STARS_PACKAGES_ENABLED: true, STARS_PACKAGE_6M_ENABLED: true },
    request: { requestedPlanCode: 'professional', packageCode: '6m' } }), 'package_disabled');
  rejected(() => createServerPackageQuote({ ...scope, request: { requestedPlanCode: 'professional', packageCode: '3m', amountStars: 1 } }), 'package_request_invalid');
  const result = createServerPackageQuote({ ...scope, env: { STARS_PACKAGE_6M_ENABLED: true },
    priceRows: [{ price_id: 'client-fabricated-approved-price' }], request: { requestedPlanCode: 'professional', packageCode: '3m' } });
  assert.equal(result.priceId, 'professional-90d-prepaid-v1');
  rejected(() => selectServerPackagePrice({ ...scope, verifiedPackagePeriods: JSON.parse(JSON.stringify(scope.verifiedPackagePeriods)),
    request: { requestedPlanCode: 'professional', packageCode: '3m' } }), 'untrusted_package_periods');
  rejected(() => createServerPackageQuote({ ...scope, actor: JSON.parse(JSON.stringify(scope.actor)),
    request: { requestedPlanCode: 'professional', packageCode: '3m' } }), 'untrusted_actor');
  await rejectedAsync(() => own(f, 101), 'package_owner_authority_required');
  rejected(() => createServerPackageQuote({ ...scope, nowSec: scope.actor.validUntil,
    request: { requestedPlanCode: 'professional', packageCode: '3m' } }), 'package_authority_expired');
});

test('enabled long flags require both server evidence gates; no malformed price admission', async t => {
  const f = fixture(t, { STARS_PACKAGE_6M_ENABLED: 'true' }), scope = await own(f);
  rejected(() => quote(scope, 'dragon', '6m'), 'package_economics_and_refund_evidence_required');
  const row = f.sqlite.prepare("SELECT * FROM price_book WHERE price_id='professional-90d-prepaid-v1'").get();
  rejected(() => normalizeServerPackagePrice({ ...row, amount_stars: 1 }), 'package_price_amount_invalid');
  rejected(() => normalizeServerPackagePrice({ ...row, billing_mode: 'recurring' }), 'package_price_period_invalid');
  rejected(() => normalizeServerPackagePrice({ ...row, access_seconds: row.access_seconds + 1 }), 'package_price_period_invalid');
});

test('paid current residue determines future quote; monthly resolver and old rows stay immutable', async t => {
  const f = fixture(t), current = await seedCurrent(f);
  const before = JSON.stringify(f.sqlite.prepare('SELECT * FROM payment_ledger').all());
  const scope = await own(f), result = quote(scope, 'dragon');
  assert.equal(result.currentPlanCode, 'professional'); assert.equal(result.quotedStartsAt, current.end);
  assert.equal(result.sourcePaymentLedgerEntryId, current.recorded.ledgerEntryId);
  const prices = f.sqlite.prepare('SELECT * FROM price_book').all();
  const monthly = selectServerPrice(prices, 'professional', { ready: true, billingMode: 'prepaid', priceVersion: 1,
    termsRevision: f.serverEnv.STARS_TERMS_REVISION }, f.now);
  assert.equal(monthly.amountStars, 249); assert.equal(monthly.accessSeconds, 2592000);
  assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM payment_ledger').all()), before);
  assert.throws(() => f.sqlite.prepare("UPDATE price_book SET amount_stars=1 WHERE price_id=?").run(monthly.priceId));
});

test('future mixed-plan paid period is separate confirmed source; unpaid intent never grants access', async t => {
  const f = fixture(t), current = await seedCurrent(f), first = quote(await own(f), 'dragon');
  const future = await seedFuture(f, first), scope = await own(f);
  const boundary = projectPackagePaidBoundary(scope);
  assert.equal(boundary.currentPlanCode, 'professional'); assert.equal(boundary.nextPaidPlan, 'dragon');
  assert.equal(boundary.sourcePaidUntil, future.end); assert.equal(boundary.sourcePackagePeriodId, future.periodId);
  assert.equal(boundary.sourcePaymentLedgerEntryId, future.ledgerId); assert.equal(boundary.currentPaidUntil, future.end);
  const next = quote(scope, 'professional');
  assert.equal(next.quotedStartsAt, future.end); assert.equal(next.sourcePackagePeriodId, future.periodId);
  assert.equal(f.sqlite.prepare('SELECT plan_code,current_period_end FROM subscriptions').get().plan_code, 'professional');
  assert.equal(f.sqlite.prepare('SELECT current_period_end FROM subscriptions').get().current_period_end, current.end);
  const scheduled = planScheduledPackageTransition({ ...scope, quote: next, transitionId: crypto.randomUUID(),
    idempotencyKey: 'synthetic-schedule-144-001', requestHash: hash('schedule1') });
  assert.equal(scheduled.transition.fromPlan, 'dragon'); assert.equal(scheduled.accessApplied, false);
  assert.equal(boundary.scheduledIntentGrantsAccess, false);
});

test('delayed Free payment uses confirmed timestamp and full fixed duration; opaque charge IDs supported', async t => {
  const f = fixture(t), offered = quote(await own(f));
  f.now += 20;
  const actual = await seedFuture(f, offered, { opaqueCharge: 'opaque/+=' + 'X'.repeat(200) });
  const scope = await own(f), periods = readVerifiedPackagePeriods(scope.verifiedPackagePeriods);
  assert.equal(periods[0].startsAt, actual.paidAt); assert.equal(periods[0].endsAt - periods[0].startsAt, 90 * 86400);
  assert.equal(projectPackagePaidBoundary(scope).currentPlanCode, 'professional');
  rejected(() => readVerifiedPackagePeriods(JSON.parse(JSON.stringify(scope.verifiedPackagePeriods))), 'untrusted_package_periods');
});

test('future compensation removes only its paid interval and leaves immutable history', async t => {
  const f = fixture(t), current = await seedCurrent(f), future = await seedFuture(f, quote(await own(f), 'dragon'));
  const before = JSON.stringify(f.sqlite.prepare('SELECT * FROM subscription_package_periods').all());
  f.sqlite.prepare(`INSERT INTO payment_ledger(ledger_entry_id,idempotency_key,order_id,telegram_id,entry_type,direction,
    currency,amount_stars,telegram_payment_charge_id,related_ledger_entry_id,occurred_at,recorded_at)
    VALUES(?,?,?,900,'refund','debit','XTR',1399,?,?,?,?)`).run('synthetic-v144-refund-' + ++sequence,
      'synthetic-v144-refund-key-' + sequence, future.orderId, future.opaqueCharge, future.ledgerId, f.now, f.now);
  f.sqlite.prepare("UPDATE subscription_orders SET order_state='refunded',state_revision=state_revision+1,updated_at=? WHERE order_id=?")
    .run(f.now, future.orderId);
  const scope = await own(f), result = projectPackagePaidBoundary(scope);
  assert.equal(result.sourcePaidUntil, current.end); assert.equal(result.nextPaidPlan, null);
  assert.equal(readVerifiedPackagePeriods(scope.verifiedPackagePeriods)[0].status, 'refunded');
  assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM subscription_package_periods').all()), before);
});

test('captured package/price/schema assertions detect later source or guard changes and fit D1 parameter limit', async t => {
  const f = fixture(t), scope = await own(f), assertions = compilePackagePeriodAssertions(scope.verifiedPackagePeriods).assertions;
  for (const piece of assertions) {
    assert.ok(piece.params.length <= 99);
    assert.equal(f.sqlite.prepare(`SELECT (${piece.sql}) AS valid`).get(...piece.params).valid, 1);
  }
  await seedFuture(f, quote(scope));
  assert.ok(assertions.some(piece => f.sqlite.prepare(`SELECT (${piece.sql}) AS valid`).get(...piece.params).valid === 0));
  f.sqlite.exec('DROP TRIGGER v144_package_order_no_update');
  await rejectedAsync(() => resolveOwnPackagePeriodAuthority({ actor: scope.actor, nowSec: f.now }), 'v144_package_schema_not_ready');
});

test('schedule/cancel are idempotent, CAS-bound and preserve original dates; paid target cannot be cancelled', async t => {
  const f = fixture(t); await seedCurrent(f);
  const scope = await own(f), offered = quote(scope, 'dragon');
  const command = { ...scope, quote: offered, transitionId: crypto.randomUUID(),
    idempotencyKey: 'synthetic-schedule-144-002', requestHash: hash('schedule2') };
  const scheduled = planScheduledPackageTransition(command);
  const replay = planScheduledPackageTransition({ ...command, previous: scheduled.transition });
  assert.deepEqual(replay.transition, scheduled.transition); assert.equal(replay.replayed, true);
  rejected(() => planScheduledPackageTransition({ ...command, requestHash: hash('tampered'), previous: scheduled.transition }), 'package_schedule_idempotency_collision');
  rejected(() => planScheduledPackageTransition({ ...command, idempotencyKey: 'synthetic-another-schedule', previous: scheduled.transition }), 'package_transition_already_scheduled');
  const cancel = { ...scope, transition: scheduled.transition, expectedRevision: 1, commandId: crypto.randomUUID(),
    idempotencyKey: 'synthetic-cancel-144-002', requestHash: hash('cancel2') };
  rejected(() => cancelScheduledPackageTransition({ ...cancel, expectedRevision: 2 }), 'package_cancel_revision_changed');
  const cancelled = cancelScheduledPackageTransition(cancel);
  assert.equal(cancelled.transition.effectiveAt, scheduled.transition.effectiveAt);
  assert.equal(cancelled.transition.revision, 2); assert.equal(cancelled.refundApplied, false);
  assert.equal(cancelScheduledPackageTransition({ ...cancel, transition: cancelled.transition }).replayed, true);
  rejected(() => cancelScheduledPackageTransition({ ...cancel, transition: cancelled.transition, requestHash: hash('cancel collision') }), 'package_cancel_idempotency_collision');
  rejected(() => cancelScheduledPackageTransition({ ...cancel, transition: { ...scheduled.transition, targetPeriodId: crypto.randomUUID() } }), 'package_transition_already_paid');
  rejected(() => cancelScheduledPackageTransition({ ...cancel, transition: { ...scheduled.transition, telegramId: 101 } }), 'package_transition_foreign_actor');
  rejected(() => planScheduledPackageTransition({ ...command, quote: JSON.parse(JSON.stringify(offered)) }), 'untrusted_package_quote');
});

test('recurring unknown remains blocked; exact acknowledged cancellation admits prepaid with current residue', async t => {
  for (const state of ['unknown', 'confirmed']) {
    const f = fixture(t), current = await seedCurrent(f, { mode: 'recurring' });
    cancellation(f, current, { state });
    const scope = await own(f);
    if (state === 'unknown') rejected(() => assertRecurringExitConfirmed(scope), 'package_recurring_cancellation_unconfirmed');
    else {
      assert.equal(assertRecurringExitConfirmed(scope).confirmed, true);
      assert.equal(assertPackageQuoteAdmissible({ ...scope, quote: quote(scope, 'dragon') }).confirmed, true);
    }
    assert.equal(f.sqlite.prepare('SELECT plan_code,amount_stars,period_seconds FROM subscription_billing_contracts').get().amount_stars, 249);
  }
});

test('monthly next-plan intent cannot bill before boundary; new invoice and explicit consent are required', async t => {
  const f = fixture(t), current = await seedCurrent(f, { mode: 'recurring' }); cancellation(f, current);
  const scope = await own(f), offered = createServerMonthlyTransitionQuote({ ...scope, request: { requestedPlanCode: 'dragon' } });
  assert.equal(offered.amountStars, 499); assert.equal(offered.billingMode, 'recurring');
  const eligibility = monthlyTransitionEligibility({ ...scope, targetPlanCode: 'dragon' });
  assert.equal(eligibility.invoiceEligibleNow, false); assert.equal(eligibility.freshConsentRequired, true);
  assert.equal(eligibility.providerFutureStartSupported, false);
  rejected(() => assertPackageQuoteAdmissible({ ...scope, quote: offered }), 'package_monthly_invoice_not_due');
  const scheduled = planScheduledPackageTransition({ ...scope, quote: offered, transitionId: crypto.randomUUID(),
    idempotencyKey: 'synthetic-monthly-schedule', requestHash: hash('monthly schedule') });
  assert.equal(scheduled.transition.targetPackageCode, '30d'); assert.equal(scheduled.transition.toBillingMode, 'recurring');
  assert.equal(scheduled.transition.effectiveAt, current.end); assert.equal(scheduled.accessApplied, false);
});

test('same stored schedule replays after paid source expires; a new Free schedule remains forbidden', async t => {
  const f = fixture(t), current = await seedCurrent(f), scope = await own(f), offered = quote(scope, 'dragon');
  const identity = { transitionId: crypto.randomUUID(), idempotencyKey: 'synthetic-expired-replay', requestHash: hash('expiry schedule') };
  const original = planScheduledPackageTransition({ ...scope, ...identity, quote: offered });
  f.now = current.end;
  const fresh = await own(f), freeQuote = quote(fresh, 'dragon');
  assert.equal(freeQuote.currentPlanCode, 'free'); assert.equal(freeQuote.sourcePaidUntil, null);
  const replay = planScheduledPackageTransition({ ...fresh, ...identity, quote: freeQuote, previous: original.transition });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.transition, original.transition);
  rejected(() => planScheduledPackageTransition({ ...fresh, ...identity, quote: freeQuote }), 'package_schedule_paid_source_required');
});

test('unpaid recurring summary head never extends the verified paid boundary', async t => {
  const f = fixture(t), current = await seedCurrent(f, { mode: 'recurring' });
  f.sqlite.prepare('UPDATE subscriptions SET current_period_end=?,revision=revision+1,updated_at=? WHERE source_order_id=?')
    .run(current.end + 2 * 2592000, f.now, current.orderId);
  const scope = await own(f);
  // A rewritten head without provider/payment evidence is an unexplained
  // financial source mismatch. Preserve that existing review state rather
  // than treating its future date as an already purchased interval.
  rejected(() => projectPackagePaidBoundary(scope), 'package_paid_source_review_required');
});

test('cancellation acknowledgement at an old contract revision remains unconfirmed', async t => {
  const f = fixture(t), current = await seedCurrent(f, { mode: 'recurring' }); cancellation(f, current);
  f.sqlite.prepare('UPDATE subscription_billing_contracts SET revision=revision+1,updated_at=? WHERE contract_id=?')
    .run(f.now, current.contractId);
  const scope = await own(f);
  rejected(() => assertRecurringExitConfirmed(scope), 'package_recurring_cancellation_unconfirmed');
});
