import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { createAuthorityResolver, readLifecycleActorFacts, authoritySeconds } from '../src/v1.4.1/authority-resolver.mjs';
import { createLifecycleAuthorityBridge, readVerifiedLifecycleFacts } from '../src/v1.4.3/lifecycle-authority.mjs';
import { projectVerifiedSubscriptionLifecycle } from '../src/v1.4.3/lifecycle-engine.mjs';
import { readOwnLifecycleFacts } from '../src/v1.4.3/lifecycle-facts.mjs';
import { appendLifecycleProjectionFact } from '../src/v1.4.3/lifecycle-events.mjs';
import { createServiceExecutor } from '../src/v1.4.1/trusted-context.mjs';
import { buildStarsInvoicePayload } from '../src/v1.3.6/stars-core-foundation.mjs';
import { applyStarsCompensation } from '../src/v1.3.6/stars-access-runtime.mjs';

const MONTH = 2592000;
const hash = text => createHash('sha256').update(text).digest('hex');
const stamp = sec => new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ');
const insert = (f, table, row) => {
  const columns = Object.keys(row);
  f.sqlite.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
    .run(...columns.map(column => row[column]));
};
function setup(t) {
  const f = foundationFixture(t);
  f.sqlite.function('unixepoch', { deterministic: false, varargs: true }, (...args) =>
    args.length === 0 || args[0] === 'now' ? f.now : authoritySeconds(args[0]));
  f.sqlite.function('current_timestamp', { deterministic: false }, () => stamp(f.now));
  for (const migration of ['0026-v1.3.6-stars-core-foundation.sql', '0027-v1.3.6-stars-access-and-reconciliation.sql',
    '0066-v1.4.3-subscription-lifecycle-foundation.sql', '0067-v1.4.3-lifecycle-engine-binding.sql'])
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/' + migration, import.meta.url), 'utf8'));
  f.serverEnv.STARS_INVOICE_SECRET = 'offline-engine-proof-secret-greater-than-32-characters';
  f.env = { ...f.serverEnv, STARS_REFUNDS_ENABLED: 'true', STARS_RECONCILIATION_ENABLED: 'true' };
  return f;
}
async function projection(f, nowSec = f.now) {
  const actor = await createAuthorityResolver().resolveActor(await f.context(101, 'access.read_own'));
  const verifiedFacts = readLifecycleActorFacts(actor);
  return { actor, verifiedFacts, result: projectVerifiedSubscriptionLifecycle({ verifiedFacts, nowSec }) };
}
function setCanonical(f, { start, end, status = 'active', source = 'stars_payment' }) {
  f.sqlite.prepare(`INSERT INTO user_plans(telegram_id,plan_code,source_code,effective_from,effective_until)
    VALUES(101,'professional',?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET
    plan_code='professional',source_code=excluded.source_code,effective_from=excluded.effective_from,
    effective_until=excluded.effective_until,revision=user_plans.revision+1`).run(source, stamp(start), stamp(end));
  f.sqlite.prepare(`INSERT INTO user_access_states(telegram_id,access_state,source_code,state_started_at,state_ends_at)
    VALUES(101,?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET access_state=excluded.access_state,
    source_code=excluded.source_code,state_started_at=excluded.state_started_at,
    state_ends_at=excluded.state_ends_at,revision=user_access_states.revision+1`).run(status, source, stamp(start), stamp(end));
}
function addControl(f, seed, state, updateId, receivedAt = f.now - 1) {
  const eventId = crypto.randomUUID();
  insert(f, 'subscription_provider_events', { event_id: eventId, event_key: 'engine-control:' + updateId,
    contract_id: seed.contractId, telegram_id: 101, event_type: state === 'failed' ? 'renewal_failed' : 'provider_control',
    source: 'telegram_update', telegram_update_id: updateId, provider_state: state, actor_type: 'telegram',
    reason_code: 'telegram_control_observed', evidence_sha256: hash('offline-control:' + updateId), received_at: receivedAt });
  return eventId;
}
// Synthetic existing financial evidence exercises the actual SQL verifier. No
// provider endpoint or generic in-memory proof mint is used by these tests.
async function seedRecurring(f, { state = 'active', paid = true, start = f.now - 100 } = {}) {
  const createdAt = Math.min(start - 100, f.now - 200), orderId = crypto.randomUUID(), contractId = crypto.randomUUID();
  const priceId = 'engine-professional-recurring-v1', terms = '2026-09-10.stars-v1';
  insert(f, 'price_book', { price_id: priceId, price_version: 1, plan_code: 'professional', currency: 'XTR', amount_stars: 249,
    access_seconds: MONTH, billing_mode: 'recurring', terms_revision: terms, valid_from: createdAt - 100,
    created_at: createdAt - 100 });
  const acceptanceId = crypto.randomUUID();
  insert(f, 'terms_acceptances', { acceptance_id: acceptanceId, telegram_id: 101, terms_revision: terms,
    acceptance_scope: 'stars_purchase', evidence_sha256: hash('offline-explicit-recurring-consent'), accepted_at: createdAt - 1 });
  const payload = await buildStarsInvoicePayload({ invoiceSecret: f.serverEnv.STARS_INVOICE_SECRET,
    orderId, telegramId: 101, priceId });
  insert(f, 'subscription_orders', { order_id: orderId, telegram_id: 101, price_id: priceId, price_version: 1,
    plan_code: 'professional', currency: 'XTR', amount_stars: 249, access_seconds: MONTH, billing_mode: 'recurring',
    terms_revision: terms, invoice_payload: payload, order_state: paid ? 'paid' : 'precheckout_ok', state_revision: 2,
    created_at: createdAt, expires_at: createdAt + 900, precheckout_approved_at: createdAt + 1,
    paid_at: paid ? start : null, updated_at: paid ? Math.max(start, createdAt) : createdAt + 1 });
  insert(f, 'subscription_billing_contracts', { contract_id: contractId, telegram_id: 101, plan_code: 'professional',
    price_id: priceId, origin_order_id: orderId, external_invoice_payload: payload, external_payload_sha256: hash(payload),
    terms_revision: terms, terms_acceptance_id: acceptanceId, billing_mode: 'recurring', period_seconds: MONTH,
    currency: 'XTR', amount_stars: 249, created_at: createdAt, updated_at: createdAt });
  const seed = { orderId, contractId, payload, createdAt, priceId, terms, start, end: start + MONTH,
    subscriptionId: null, ledgerId: null, chargeId: null };
  if (paid) {
    seed.subscriptionId = crypto.randomUUID(); seed.ledgerId = crypto.randomUUID(); seed.chargeId = 'engine-charge:' + crypto.randomUUID();
    insert(f, 'payment_ledger', { ledger_entry_id: seed.ledgerId, idempotency_key: 'engine-payment:' + seed.ledgerId,
      order_id: orderId, telegram_id: 101, entry_type: 'payment', direction: 'credit', currency: 'XTR', amount_stars: 249,
      telegram_payment_charge_id: seed.chargeId, related_ledger_entry_id: null, occurred_at: start, recorded_at: f.now - 2 });
    insert(f, 'subscriptions', { subscription_id: seed.subscriptionId, telegram_id: 101, plan_code: 'professional',
      billing_mode: 'recurring', source_order_id: orderId, telegram_payment_charge_id: seed.chargeId, status: 'active',
      current_period_start: start, current_period_end: seed.end, auto_renew: 1, last_ledger_entry_id: seed.ledgerId,
      created_at: start, updated_at: Math.max(start, f.now - 2) });
    const operationId = crypto.randomUUID();
    insert(f, 'subscription_payment_links', { operation_id: operationId, operation_key: 'engine-incoming:' + operationId,
      provider_charge_id: seed.chargeId, provider_charge_sha256: hash(seed.chargeId), direction: 'incoming',
      link_kind: 'recurring_charge', contract_id: contractId, origin_order_id: orderId, applied_order_id: orderId,
      telegram_id: 101, plan_code: 'professional', external_invoice_payload: payload, external_payload_sha256: hash(payload),
      ledger_entry_id: seed.ledgerId, provider_period_start: start, provider_period_end: seed.end,
      evidence_sha256: hash('offline-genuine-charge'), occurred_at: start, recorded_at: f.now - 2 });
    insert(f, 'subscription_first_recurring_receipts', { contract_id: contractId, operation_id: operationId,
      evidence_sha256: hash('offline-genuine-charge'), verified_at: f.now - 2 });
    insert(f, 'subscription_access_grants', { grant_id: crypto.randomUUID(), grant_key: 'engine-grant:' + seed.ledgerId,
      subscription_id: seed.subscriptionId, order_id: orderId, payment_ledger_entry_id: seed.ledgerId,
      telegram_id: 101, plan_code: 'professional', access_seconds: MONTH, starts_at: start, ends_at: seed.end,
      status: 'active', created_at: start, updated_at: Math.max(start, f.now - 2) });
    f.sqlite.prepare("UPDATE subscription_orders SET order_state='applied',applied_at=?,state_revision=state_revision+1 WHERE order_id=?").run(f.now - 2, orderId);
    setCanonical(f, seed);
  }
  const eventId = addControl(f, seed, state, 700001, f.now - 1);
  f.sqlite.prepare(`UPDATE subscription_billing_contracts SET provider_state=?,auto_renew_confirmed=?,
    first_payment_ledger_entry_id=?,last_provider_event_id=?,revision=revision+1,updated_at=? WHERE contract_id=?`)
    .run(state, state === 'active' ? 1 : 0, seed.ledgerId, eventId, f.now - 1, contractId);
  return seed;
}

async function seedPrepaidRenewal(f) {
  const start = f.now - 100, subscriptionId = crypto.randomUUID(), payments = [];
  for (let index = 0; index < 2; index++) {
    const orderId = crypto.randomUUID(), ledgerId = crypto.randomUUID(), chargeId = 'engine-prepaid:' + crypto.randomUUID();
    const occurredAt = f.now - 80 + index * 20, createdAt = occurredAt - 10;
    const priceId = 'professional-30d-prepaid-v1';
    const payload = await buildStarsInvoicePayload({ invoiceSecret: f.serverEnv.STARS_INVOICE_SECRET, orderId, telegramId: 101, priceId });
    insert(f, 'subscription_orders', { order_id: orderId, telegram_id: 101, price_id: priceId, price_version: 1,
      plan_code: 'professional', currency: 'XTR', amount_stars: 249, access_seconds: MONTH, billing_mode: 'prepaid',
      terms_revision: '2026-09-10.stars-v1', invoice_payload: payload, order_state: 'paid', state_revision: 2,
      created_at: createdAt, expires_at: createdAt + 900, precheckout_approved_at: createdAt + 1,
      paid_at: occurredAt, updated_at: occurredAt });
    insert(f, 'payment_ledger', { ledger_entry_id: ledgerId, idempotency_key: 'engine-prepaid-payment:' + ledgerId,
      order_id: orderId, telegram_id: 101, entry_type: 'payment', direction: 'credit', currency: 'XTR', amount_stars: 249,
      telegram_payment_charge_id: chargeId, related_ledger_entry_id: null, occurred_at: occurredAt, recorded_at: occurredAt });
    const end = start + (index + 1) * MONTH;
    if (index === 0) insert(f, 'subscriptions', { subscription_id: subscriptionId, telegram_id: 101, plan_code: 'professional',
      billing_mode: 'prepaid', source_order_id: orderId, telegram_payment_charge_id: chargeId, status: 'active',
      current_period_start: start, current_period_end: end, auto_renew: 0, last_ledger_entry_id: ledgerId,
      created_at: start, updated_at: occurredAt });
    else f.sqlite.prepare('UPDATE subscriptions SET current_period_end=?,last_ledger_entry_id=?,revision=revision+1,updated_at=? WHERE subscription_id=?')
      .run(end, ledgerId, occurredAt, subscriptionId);
    insert(f, 'subscription_access_grants', { grant_id: crypto.randomUUID(), grant_key: 'engine-prepaid-grant:' + ledgerId,
      subscription_id: subscriptionId, order_id: orderId, payment_ledger_entry_id: ledgerId,
      telegram_id: 101, plan_code: 'professional', access_seconds: MONTH, starts_at: start + index * MONTH, ends_at: end,
      status: 'active', created_at: occurredAt, updated_at: occurredAt });
    f.sqlite.prepare("UPDATE subscription_orders SET order_state='applied',applied_at=?,state_revision=state_revision+1 WHERE order_id=?").run(occurredAt + 1, orderId);
    setCanonical(f, { start, end }); payments.push({ chargeId, ledgerId, orderId });
  }
  return { start, subscriptionId, payments };
}

test('projector accepts only actual recorded financial authority; expires at the read-time boundary without cron', async t => {
  const f = setup(t), seed = await seedRecurring(f);
  const { verifiedFacts, result } = await projection(f);
  assert.equal(result.state, 'active'); assert.equal(result.paidAccess, true); assert.equal(result.paidUntil, seed.end);
  assert.ok(Object.isFrozen(result)); assert.equal(result.graceSeconds, 0); assert.equal(result.nextChargeAt, null);
  for (const forged of [{ periods: [{ startsAt: 1, endsAt: f.now + MONTH }] }, { ...verifiedFacts }, JSON.parse(JSON.stringify(verifiedFacts))])
    assert.throws(() => projectVerifiedSubscriptionLifecycle({ verifiedFacts: forged, nowSec: f.now }), { code: 'untrusted_lifecycle_facts' });
  const realContext = await f.context();
  assert.throws(() => createLifecycleAuthorityBridge().verify(realContext), { code: 'untrusted_lifecycle_source' });
  assert.throws(() => createLifecycleAuthorityBridge().verify({ telegramId: 101, periods: [] }), { code: 'untrusted_lifecycle_source' });
  const expired = projectVerifiedSubscriptionLifecycle({ verifiedFacts, nowSec: seed.end });
  assert.equal(expired.state, 'expired'); assert.equal(expired.paidAccess, false); assert.equal(expired.accessUntil, null);
  const futureOnly = projectVerifiedSubscriptionLifecycle({ verifiedFacts, nowSec: seed.start - 1 });
  assert.equal(futureOnly.state, null); assert.equal(futureOnly.paidAccess, false);
  assert.equal(futureOnly.reasonCode, 'verified_paid_period_not_started');
  assert.equal(f.sqlite.prepare('SELECT status FROM subscriptions').get().status, 'active');
});

test('cancel and confirmed failure preserve every paid second; contradictory reset/stale control is review, not last-wins', async t => {
  const f = setup(t), seed = await seedRecurring(f, { state: 'canceled' });
  let view = await projection(f);
  assert.equal(view.result.state, 'cancel_at_period_end'); assert.equal(view.result.paidAccess, true); assert.equal(view.result.paidUntil, seed.end);
  addControl(f, seed, 'active', 5, f.now); // update_id reset is not a universal clock.
  view = await projection(f);
  assert.equal(view.result.renewalState, 'unknown'); assert.equal(view.result.state, 'active'); assert.equal(view.result.paidAccess, true);
  assert.ok(view.result.reviewReasons.includes('control_order_ambiguous'));
  const failed = setup(t); await seedRecurring(failed, { state: 'failed' });
  const failure = (await projection(failed)).result;
  assert.equal(failure.state, 'payment_failed'); assert.equal(failure.paidAccess, true);
  const failureExpired = (await projection(failed, failure.paidUntil)).result;
  assert.equal(failureExpired.state, 'expired'); assert.equal(failureExpired.paidAccess, false);
});

test('precheckout plus renewal active cannot synthesize a paid period; duplicate incoming operation cannot double a grant', async t => {
  const pending = setup(t); await seedRecurring(pending, { paid: false });
  const pendingResult = (await projection(pending)).result;
  assert.equal(pendingResult.state, null); assert.equal(pendingResult.paidAccess, false); assert.equal(pendingResult.paidUntil, null);
  assert.equal(pendingResult.renewalState, 'active');
  const f = setup(t), seed = await seedRecurring(f);
  const before = (await projection(f)).result;
  const link = f.sqlite.prepare('SELECT * FROM subscription_payment_links').get();
  assert.throws(() => insert(f, 'subscription_payment_links', { ...link, operation_id: crypto.randomUUID(), operation_key: 'engine-duplicate:' + crypto.randomUUID() }), /UNIQUE/);
  assert.deepEqual((await projection(f)).result, before);
  assert.equal(readVerifiedLifecycleFacts((await projection(f)).verifiedFacts).periods.length, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) count FROM payment_ledger').get().count, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) count FROM subscription_access_grants').get().count, 1);
  assert.equal(before.paidUntil, seed.end);
});

test('specific refund preserves unrelated verified paid source, while compensation and policy never turn into renewal payment', async t => {
  const prepaid = setup(t), prepaidSeed = await seedPrepaidRenewal(prepaid);
  assert.equal((await projection(prepaid)).result.paidUntil, prepaidSeed.start + MONTH * 2);
  await applyStarsCompensation(prepaid.env, { telegramPaymentChargeId: prepaidSeed.payments[0].chargeId,
    compensationType: 'refund', occurredAt: prepaid.now });
  const surviving = (await projection(prepaid)).result;
  assert.equal(surviving.state, 'active'); assert.equal(surviving.paidAccess, true);
  assert.equal(surviving.paidUntil, prepaidSeed.start + MONTH);
  assert.equal(prepaid.sqlite.prepare("SELECT COUNT(*) count FROM subscription_access_grants WHERE status='active'").get().count, 1);
  const f = setup(t), seed = await seedRecurring(f);
  await applyStarsCompensation(f.env, { telegramPaymentChargeId: seed.chargeId, compensationType: 'refund', occurredAt: f.now });
  const refunded = (await projection(f)).result;
  assert.equal(refunded.state, 'refunded'); assert.equal(refunded.paidAccess, false); assert.equal(refunded.paidUntil, null);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) count FROM payment_ledger WHERE entry_type='refund'").get().count, 1);
  await applyStarsCompensation(f.env, { telegramPaymentChargeId: seed.chargeId, compensationType: 'refund', occurredAt: f.now });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) count FROM payment_ledger WHERE entry_type='refund'").get().count, 1);
  const suspended = setup(t), paidSeed = await seedRecurring(suspended);
  suspended.sqlite.prepare("UPDATE subscriptions SET status='suspended',revision=revision+1 WHERE subscription_id=?").run(paidSeed.subscriptionId);
  setCanonical(suspended, { ...paidSeed, status: 'suspended' });
  const off = (await projection(suspended)).result;
  assert.equal(off.state, 'suspended'); assert.equal(off.paidAccess, false); assert.equal(off.paidUntil, paidSeed.end);
  const disputed = setup(t), disputedSeed = await seedRecurring(disputed);
  await applyStarsCompensation(disputed.env, { telegramPaymentChargeId: disputedSeed.chargeId, compensationType: 'chargeback', occurredAt: disputed.now });
  const dispute = (await projection(disputed)).result;
  assert.equal(dispute.state, 'chargeback'); assert.equal(dispute.paidAccess, false); assert.equal(dispute.reviewRequired, true);
});

test('append-only projector journal validates own trusted service, durable dedupe and fresh financial facts atomically', async t => {
  const f = setup(t), seed = await seedRecurring(f);
  const { verifiedFacts } = await projection(f);
  const context = createServiceExecutor({ binding: f.binding, env: f.serverEnv,
    purpose: 'stars_process_event', clockSeconds: () => f.now }).createContext();
  const appended = await appendLifecycleProjectionFact({ context, verifiedFacts });
  assert.equal(appended.status, 'appended');
  const duplicate = await appendLifecycleProjectionFact({ context, verifiedFacts });
  assert.equal(duplicate.status, 'duplicate'); assert.equal(duplicate.eventId, appended.eventId);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) count FROM subscription_provider_events WHERE event_type='lifecycle_transition'").get().count, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) count FROM mini_app_atomic_guards').get().count, 0);
  assert.throws(() => f.sqlite.prepare("DELETE FROM subscription_provider_events WHERE event_id=?").run(appended.eventId), /append_only/);
  await assert.rejects(appendLifecycleProjectionFact({ context: await f.context(), verifiedFacts }), { code: 'lifecycle_event_service_required' });
  await applyStarsCompensation(f.env, { telegramPaymentChargeId: seed.chargeId, compensationType: 'refund', occurredAt: f.now });
  await assert.rejects(appendLifecycleProjectionFact({ context, verifiedFacts }), { code: 'lifecycle_event_source_stale' });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) count FROM subscription_provider_events WHERE event_type='lifecycle_transition'").get().count, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) count FROM mini_app_atomic_guards').get().count, 0);
});

test('own sidecar reader is bounded, records own predicates and keeps failed persistence from reporting success', async t => {
  const calls = [];
  const read = async (...args) => { calls.push(args); return []; };
  await readOwnLifecycleFacts({ telegramId: 101, read, schemaPresent: true, firstReceiptSchemaPresent: true,
    reviewReceiptSchemaPresent: true });
  assert.equal(calls.length, 7);
  assert.ok(calls.every(([, , params, , identity, max]) => params.length === 1 && params[0] === 101 && identity === false && max === 128));
  assert.match(calls.find(call => call[0] === 'payment_review_resolutions')[1], /telegram_id=\?/);
  assert.equal(calls.find(call => call[0] === 'subscription_payment_review_receipts')[1], 'telegram_id=?');
  await assert.rejects(readOwnLifecycleFacts({ telegramId: 101, schemaPresent: true, read: async () => Array.from({ length: 129 }, () => ({})) }), { code: 'lifecycle_own_source_overflow' });
  const f = setup(t); await seedRecurring(f);
  const { verifiedFacts } = await projection(f);
  const context = createServiceExecutor({ binding: f.binding, env: f.serverEnv, purpose: 'stars_process_event', clockSeconds: () => f.now }).createContext();
  f.binding.failStatement = sql => sql.startsWith('INSERT INTO subscription_provider_events');
  await assert.rejects(appendLifecycleProjectionFact({ context, verifiedFacts }), { code: 'lifecycle_event_persistence_failed' });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) count FROM subscription_provider_events WHERE event_type='lifecycle_transition'").get().count, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) count FROM mini_app_atomic_guards').get().count, 0);
});
