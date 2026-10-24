import test from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionFixture, MONTH } from './helpers/v1.4.3-provider-subscription-fixture.mjs';
import { createRuntimeAuthorizer } from '../src/v1.4.1/runtime-authorizer.mjs';
import { createServiceExecutor } from '../src/v1.4.1/trusted-context.mjs';
import { resolveServiceSubscriptionFinancialFacts } from '../src/v1.4.1/authority-resolver.mjs';
import { readOwnSubscriptionHistory } from '../src/v1.4.3/subscription-history.mjs';
import { projectSubscriptionAccess } from '../src/v1.4.2/subscription-access.mjs';
import { projectVerifiedSubscriptionLifecycle } from '../src/v1.4.3/lifecycle-engine.mjs';
import { recordStarsSuccessfulPayment } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsPaidAccess, applyStarsCompensation } from '../src/v1.3.6/stars-access-runtime.mjs';

let nextUpdate = 1435100;
const authorize = (f, subject = 101, operation = 'access.read_own') =>
  f.context(subject, operation).then(context => createRuntimeAuthorizer().authorize(context, null));
const payment = f => f.sqlite.prepare("SELECT * FROM payment_ledger WHERE entry_type='payment' ORDER BY occurred_at,ledger_entry_id LIMIT 1").get();
const money = f => ({ ledger: f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY ledger_entry_id').all(),
  grants: f.sqlite.prepare('SELECT * FROM subscription_access_grants ORDER BY grant_id').all(),
  subscriptions: f.sqlite.prepare('SELECT * FROM subscriptions ORDER BY subscription_id').all() });
async function renewal(f, expiration) {
  const record = await recordStarsSuccessfulPayment(f.serverEnv, { update_id: ++nextUpdate, message: {
    message_id: nextUpdate, from: { id: 101, is_bot: false }, chat: { id: 101, type: 'private' },
    successful_payment: { currency: 'XTR', total_amount: 249, invoice_payload: f.payload,
      telegram_payment_charge_id: 'offline-history-renewal-' + nextUpdate, provider_payment_charge_id: '',
      is_recurring: true, is_first_recurring: false, subscription_expiration_date: expiration } } }, { receivedAt: f.now });
  assert.equal((await applyStarsPaidAccess(f.serverEnv, { orderId: record.orderId, appliedAt: f.now })).accessApplied, true);
  return record;
}
const refund = f => applyStarsCompensation({ ...f.serverEnv, STARS_REFUNDS_ENABLED: 'true' }, {
  telegramPaymentChargeId: payment(f).telegram_payment_charge_id, compensationType: 'refund',
  telegramUpdateId: ++nextUpdate, occurredAt: f.now });
function service(f, purpose = 'notification_deliver_historical') {
  return createServiceExecutor({ binding: f.binding, env: f.serverEnv, purpose, clockSeconds: () => f.now }).createContext();
}
async function validGuards(f, source) {
  const results = await f.binding.batch(source.sourceAssertions.assertions.map(piece =>
    f.binding.prepare(`SELECT CASE WHEN (${piece.sql}) THEN 1 ELSE 0 END AS valid`).bind(...piece.params)));
  return results.every(result => result.success === true && result.results.length === 1 && result.results[0].valid === 1);
}

test('actual own paid history masks provider identity and shares the exact verified paid interval without writes', async t => {
  const f = await subscriptionFixture(t), authorization = await authorize(f), before = money(f);
  f.binding.audit.length = 0;
  const history = await readOwnSubscriptionHistory({ authorization }), access = projectSubscriptionAccess(authorization);
  assert.equal(history.available, true); assert.equal(history.accessAuthority, false); assert.equal(history.items.length, 1);
  const item = history.items[0]; assert.equal(item.status, 'paid'); assert.equal(item.amountStars, 249);
  assert.equal(item.currency, 'XTR'); assert.equal(item.planCode, 'professional'); assert.equal(item.billingMode, 'recurring');
  assert.deepEqual(item.paidPeriod, { startsAt: f.paidUntil - MONTH, endsAt: access.lifecycle.paidUntil });
  assert.deepEqual(item.receipt.paidPeriod, item.paidPeriod); assert.match(item.receiptId, /^stars-[a-f0-9]{24}$/u);
  const encoded = JSON.stringify(history), original = payment(f);
  for (const sensitive of [original.ledger_entry_id, original.telegram_payment_charge_id, f.orderId, f.contractId, f.payload])
    assert.equal(encoded.includes(sensitive), false);
  assert.ok(f.binding.audit.every(row => row.mode === 'read' && row.sql.startsWith('SELECT ')));
  assert.deepEqual(money(f), before);
});

test('genuine refund changes its safe receipt and a stale standalone history proof cannot report the old payment', async t => {
  const f = await subscriptionFixture(t), stale = await authorize(f), original = { ...payment(f) };
  assert.equal((await readOwnSubscriptionHistory({ authorization: stale })).items[0].status, 'paid');
  await refund(f);
  await assert.rejects(readOwnSubscriptionHistory({ authorization: stale }), { code: 'authority_stale' });
  const fresh = await authorize(f), history = await readOwnSubscriptionHistory({ authorization: fresh });
  assert.equal(history.items[0].status, 'refunded'); assert.equal(history.items[0].receipt.status, 'refunded');
  assert.equal(projectSubscriptionAccess(fresh).lifecycle.paidAccess, false);
  assert.deepEqual({ ...f.sqlite.prepare('SELECT * FROM payment_ledger WHERE ledger_entry_id=?').get(original.ledger_entry_id) }, original,
    'the original cash credit is immutable after its real compensation');
});

test('real disconnected renewal remains visible with its exact future interval and cannot bridge an unpaid gap', async t => {
  const f = await subscriptionFixture(t), firstEnd = f.paidUntil, futureStart = firstEnd + MONTH, futureEnd = futureStart + MONTH;
  await renewal(f, futureEnd);
  let authorization = await authorize(f), history = await readOwnSubscriptionHistory({ authorization });
  assert.equal(history.items.length, 2);
  assert.ok(history.items.some(item => item.paidPeriod?.startsAt === futureStart && item.paidPeriod.endsAt === futureEnd));
  assert.equal(projectSubscriptionAccess(authorization).lifecycle.paidUntil, firstEnd);
  f.now = firstEnd;
  authorization = await authorize(f); history = await readOwnSubscriptionHistory({ authorization });
  assert.equal(history.items.length, 2); assert.equal(projectSubscriptionAccess(authorization).lifecycle.paidAccess, false);
  f.now = futureStart;
  authorization = await authorize(f);
  assert.equal(projectSubscriptionAccess(authorization).lifecycle.paidAccess, true);
  assert.equal(projectSubscriptionAccess(authorization).lifecycle.paidUntil, futureEnd);
});

test('own history rejects copied authorizations, a supplied subject and unrelated capabilities; foreign own reads stay empty', async t => {
  const f = await subscriptionFixture(t), own = await authorize(f), foreign = await authorize(f, 202, 'billing.read_history_own');
  assert.deepEqual((await readOwnSubscriptionHistory({ authorization: foreign })).items, []);
  await assert.rejects(readOwnSubscriptionHistory({ authorization: JSON.parse(JSON.stringify(own)) }),
    { code: 'untrusted_runtime_authorization' });
  await assert.rejects(readOwnSubscriptionHistory({ authorization: own, telegramId: 202 }), { code: 'subscription_history_scope_mismatch' });
  await assert.rejects(readOwnSubscriptionHistory({ authorization: await authorize(f, 101, 'profile.read_own') }),
    { code: 'subscription_history_scope_mismatch' });
});

test('fixed historical-notification service uses the same financial verifier and its proof guards account and financial changes', async t => {
  const f = await subscriptionFixture(t), subscription = f.sqlite.prepare('SELECT * FROM subscriptions').get();
  const source = await resolveServiceSubscriptionFinancialFacts({ context: service(f), subscriptionId: subscription.subscription_id });
  assert.equal(source.recipient, 101); assert.equal(source.subscription.subscription_id, subscription.subscription_id);
  assert.equal(source.account.exists, true); assert.equal(source.account.financialSourceAvailable, true);
  const own = projectSubscriptionAccess(await authorize(f)).lifecycle;
  const projected = projectVerifiedSubscriptionLifecycle({ verifiedFacts: source.verifiedFacts, nowSec: f.now });
  assert.equal(projected.paidAccess, own.paidAccess); assert.equal(projected.paidUntil, own.paidUntil);
  assert.equal(await validGuards(f, source), true);
  f.sqlite.exec('UPDATE users SET is_blocked=1 WHERE telegram_id=101');
  assert.equal(await validGuards(f, source), false);
  const blocked = await resolveServiceSubscriptionFinancialFacts({ context: service(f), subscriptionId: subscription.subscription_id });
  assert.equal(blocked.account.isBlocked, true); assert.equal(await validGuards(f, blocked), true);
  await refund(f); assert.equal(await validGuards(f, blocked), false);
  const refunded = await resolveServiceSubscriptionFinancialFacts({ context: service(f), subscriptionId: subscription.subscription_id });
  assert.equal(projectVerifiedSubscriptionLifecycle({ verifiedFacts: refunded.verifiedFacts, nowSec: f.now }).paidAccess, false);
  await assert.rejects(resolveServiceSubscriptionFinancialFacts({ context: { purpose: 'historical_notification', trusted: true },
    subscriptionId: subscription.subscription_id }), { code: 'untrusted_context' });
  await assert.rejects(resolveServiceSubscriptionFinancialFacts({ context: service(f, 'stars_process_event'),
    subscriptionId: subscription.subscription_id }), { code: 'subscription_notification_service_required' });
  await assert.rejects(resolveServiceSubscriptionFinancialFacts({ context: service(f) }), { code: 'subscription_notification_service_required' });
  await assert.rejects(resolveServiceSubscriptionFinancialFacts({ context: service(f), subscriptionId: 'missing-offline-subscription' }),
    { code: 'subscription_notification_source_unavailable' });
});

test('real distinct renewal receipts return only newest twenty and a bounded hasMore marker', async t => {
  const f = await subscriptionFixture(t), firstEnd = f.paidUntil;
  for (let index = 1; index <= 21; index++) { f.now++; await renewal(f, firstEnd + index * MONTH); }
  const before = money(f), history = await readOwnSubscriptionHistory({ authorization: await authorize(f, 101, 'billing.read_history_own') });
  assert.equal(history.items.length, 20); assert.equal(history.hasMore, true); assert.equal(history.limit, 20);
  assert.equal(new Set(history.items.map(item => item.receiptId)).size, 20);
  assert.ok(history.items.every((item, index) => index === 0 || item.occurredAt <= history.items[index - 1].occurredAt));
  assert.equal(history.items[0].paidPeriod.endsAt, firstEnd + 21 * MONTH); assert.deepEqual(money(f), before);
});
