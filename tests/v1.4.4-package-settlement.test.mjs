import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { cabinetSubscriptionFixture, next } from './helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import { authoritySeconds } from '../src/v1.4.1/authority-resolver.mjs';
import { buildStarsInvoicePayload } from '../src/v1.3.6/stars-core-foundation.mjs';
import { recordPackageSuccessfulPayment, capturePackageReconciliationObservation } from '../src/v1.4.4/package-payment-runtime.mjs';
import { recordStarsSuccessfulPayment, acceptStarsPurchaseTerms, issueStarsInvoice, handleStarsPreCheckoutQuery } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsCompensation, requestStarsRefund, handleStarsRefundedPaymentUpdate,
  getStarsUserAccessSummary, runStarsAccessMaintenance, assertStarsPurchaseAllowed, readStarsOperationsConfig, applyStarsPaidAccess } from '../src/v1.3.6/stars-access-runtime.mjs';
import { reconcileStarsTransactions } from '../src/v1.3.6/stars-access-runtime.mjs';
import { readPackageSettlementSource, requestOwnPackageRefund } from '../src/v1.4.4/package-settlement-runtime.mjs';
import { createCustomerContext, createFinancialCustomerContext, createServiceExecutor } from '../src/v1.4.1/trusted-context.mjs';
import { signedInitData } from './helpers/v1.4.1-fixtures.mjs';
import { authorizeTelegramHandler } from '../src/v1.4.1/telegram-runtime.mjs';
import { prepareLegacyCompatibility, bindLegacyCompatibilityEnv, bindPackageReconciliationAccountingEnv, assertLegacyCompatibilityFresh } from '../src/v1.4.1/telegram-legacy-compatibility.mjs';
import { authorizeOwnStarsSubscriptionCommand } from '../src/v1.4.3/subscription-action-authority.mjs';
import { requestOwnStarsSubscriptionCommand } from '../src/v1.4.3/telegram-subscription-provider.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const f = cabinetSubscriptionFixture(t);
  f.serverEnv = { ...f.serverEnv, STARS_PACKAGE_REFUNDS_ENABLED: 'true' };
  t.mock.method(Date, 'now', () => f.now * 1000);
  f.sqlite.function('unixepoch', { deterministic: false, varargs: true }, (...args) =>
    args.length === 0 || args[0] === 'now' ? Math.floor(Date.now() / 1000) : authoritySeconds(args[0]));
  for (const name of ['0069-v1.4.3-d1-compatibility.sql', '0070-v1.4.3-refund-notification.sql',
    '0071-v1.4.3-refund-contract-retirement.sql', '0072-v1.4.4-package-contract.sql',
    '0073-v1.4.4-package-payment-review.sql'])
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  for (const id of [101, 900]) {
    insert(f, 'terms_acceptances', { acceptance_id: randomUUID(), telegram_id: id,
      terms_revision: f.serverEnv.STARS_TERMS_REVISION, acceptance_scope: 'stars_purchase',
      evidence_sha256: hash('offline-package-refund-consent-' + id), accepted_at: f.now - 120 });
    f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(id);
    f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(id);
  }
  return f;
}
function insert(f, table, row) {
  const keys = Object.keys(row);
  f.sqlite.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
    .run(...keys.map(key => row[key]));
}
async function packagePayment(f, { plan = 'professional', source = null, period = true, settled = true, id = 101 } = {}) {
  const orderId = randomUUID(), priceId = `${plan}-3m-prepaid-offline-settlement-v1`, duration = 90 * 86400;
  const createdAt = f.now - 40, quoteAt = createdAt, paidAt = f.now - 20;
  if (!f.sqlite.prepare('SELECT price_id FROM price_book WHERE price_id=?').get(priceId))
    insert(f, 'price_book', { price_id: priceId, price_version: 1, plan_code: plan, currency: 'XTR',
      amount_stars: plan === 'professional' ? 699 : 1399, access_seconds: duration, billing_mode: 'prepaid',
      publication_state: 'approved', terms_revision: f.serverEnv.STARS_TERMS_REVISION, valid_from: createdAt,
      created_at: createdAt, created_by: 'offline-package-settlement-test' });
  const price = f.sqlite.prepare('SELECT * FROM price_book WHERE price_id=?').get(priceId);
  const payload = await buildStarsInvoicePayload({ invoiceSecret: f.serverEnv.STARS_INVOICE_SECRET,
    orderId, telegramId: id, priceId });
  insert(f, 'subscription_orders', { order_id: orderId, telegram_id: id, price_id: priceId,
    price_version: 1, plan_code: plan, currency: 'XTR', amount_stars: price.amount_stars, access_seconds: duration,
    billing_mode: 'prepaid', terms_revision: price.terms_revision, invoice_payload: payload, order_state: 'created',
    created_at: createdAt, expires_at: f.now + 600, updated_at: createdAt });
  const sourceEnd = source?.ends_at ?? source?.current_period_end ?? null;
  const start = sourceEnd ?? quoteAt;
  const metadata = { order_id: orderId, telegram_id: id, contract_version: '2026-10-06.v1.4.4.p01',
    package_code: '3m', duration_days: 90, period_seconds: duration, price_id: priceId, price_version: 1,
    plan_code: plan, billing_mode: 'prepaid', currency: 'XTR', amount_stars: price.amount_stars,
    offer_version: '2026-10-06.packages-v1', campaign_code: null, quoted_starts_at: start,
    quoted_ends_at: start + duration, source_subscription_id: source?.subscription_id ?? null, source_package_period_id: source?.period_id ?? null,
    source_paid_until: sourceEnd, source_revision: source?.revision ?? (source ? 1 : null),
    source_payment_ledger_entry_id: source?.payment_ledger_entry_id ?? source?.last_ledger_entry_id ?? null,
    source_fingerprint: hash('offline-settlement-source'), transition_id: null, created_at: quoteAt };
  insert(f, 'subscription_package_orders', metadata);
  if (!settled) return { payment: null, period: null, metadata, payload, orderId };
  f.sqlite.prepare("UPDATE subscription_orders SET order_state='precheckout_ok',precheckout_approved_at=?,updated_at=?,state_revision=state_revision+1 WHERE order_id=?")
    .run(paidAt - 1, paidAt - 1, orderId);
  const payment = { ledger_entry_id: randomUUID(), idempotency_key: 'offline-settlement-payment:' + next(),
    order_id: orderId, telegram_id: id, entry_type: 'payment', direction: 'credit', currency: 'XTR',
    amount_stars: price.amount_stars, telegram_payment_charge_id: 'offline-package-charge-' + next(),
    occurred_at: paidAt, recorded_at: paidAt, reason_code: 'successful_payment' };
  insert(f, 'payment_ledger', payment);
  f.sqlite.prepare("UPDATE subscription_orders SET order_state='paid',paid_at=?,updated_at=?,state_revision=state_revision+1 WHERE order_id=?")
    .run(paidAt, paidAt, orderId);
  const paidPeriod = { period_id: randomUUID(), order_id: orderId, payment_ledger_entry_id: payment.ledger_entry_id,
    telegram_id: id, plan_code: plan, price_id: priceId, price_version: 1, billing_mode: 'prepaid',
    starts_at: Math.max(start, paidAt), ends_at: Math.max(start, paidAt) + duration,
    period_seconds: duration, transition_id: null, recorded_at: f.now };
  if (period) insert(f, 'subscription_package_periods', paidPeriod);
  f.sqlite.prepare("UPDATE subscription_orders SET order_state='applied',applied_at=?,updated_at=?,state_revision=state_revision+1 WHERE order_id=?")
    .run(f.now, f.now, orderId);
  return { payment, period: period ? paidPeriod : null, proposedPeriod: paidPeriod, metadata, payload, orderId };
}
const all = (f, table) => f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
const refund = (f, paid) => ({ adminTelegramId: 900,
  telegramPaymentChargeId: paid.payment.telegram_payment_charge_id, requestedAt: f.now,
  reasonCode: 'offline_confirmed_package_refund' });
const update = (paid, patch = {}) => ({ update_id: next(), message: { message_id: next(),
  from: { id: 101, is_bot: false }, chat: { id: 101, type: 'private' }, refunded_payment: {
    currency: 'XTR', total_amount: paid.payment.amount_stars, invoice_payload: paid.payload,
    telegram_payment_charge_id: paid.payment.telegram_payment_charge_id, ...patch } } });
const successful = (f, paid) => ({ update_id: next(), message: { message_id: next(), date: f.now,
  from: { id: paid.metadata.telegram_id, is_bot: false }, chat: { id: paid.metadata.telegram_id, type: 'private' }, successful_payment: {
    currency: 'XTR', total_amount: paid.metadata.amount_stars, invoice_payload: paid.payload,
    telegram_payment_charge_id: 'offline-retained-package-charge-' + next(), provider_payment_charge_id: '' } } });
async function recordGenuinePackage(f, incoming) {
  const secret = 'offline-v144-settlement-financial-webhook-secret', claim = randomUUID();
  f.serverEnv = { ...f.serverEnv, WEBHOOK_SECRET: secret };
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,received_at,lease_expires_at)
    VALUES(?,'message',?,'processing',?,?,?)`).run(incoming.update_id, incoming.message.from.id, claim, f.now, f.now + 300);
  const context = await createFinancialCustomerContext({ binding: f.binding, env: f.serverEnv,
    webhookRequest: new Request(f.serverEnv.MINI_APP_ORIGIN + '/webhook', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(incoming) }),
    receiptClaimToken: claim, nowSeconds: f.now });
  return recordPackageSuccessfulPayment(f.serverEnv, incoming, { packageFinancialContext: context, receivedAt: f.now });
}
async function refundContext(f, payload, id = 900) {
  return createCustomerContext({ binding: f.binding, env: { ...f.serverEnv, V141_AUTHORIZATION_ENABLED: 'true' },
    initData: signedInitData(id, f.now), channel: 'mini_app', operation: 'admin.stars.refund',
    requestPayload: payload, idempotencyKey: 'offline-package-refund-' + next(), nowSeconds: f.now });
}
async function legacyReconciliationEnv(f) {
  const secret = 'offline-package-reconciliation-webhook-secret', claim = randomUUID();
  f.serverEnv = { ...f.serverEnv, WEBHOOK_SECRET: secret, V141_AUTHORIZATION_ENABLED: 'true', STARS_RECONCILIATION_ENABLED: 'true' };
  const body = { update_id: next(), callback_query: { id: 'package-reconcile-' + next(),
    from: { id: 900, is_bot: false }, message: { from: { id: 123456789, is_bot: true }, chat: { id: 900, type: 'private' } },
    data: 'admin_stars_reconcile' } };
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,attempt_count,received_at,lease_expires_at)
    VALUES(?,'callback_query',900,'processing',?,1,?,?)`).run(body.update_id, claim, f.now, f.now + 300);
  const context = await createCustomerContext({ binding: f.binding, env: f.serverEnv,
    webhookRequest: new Request(f.serverEnv.MINI_APP_ORIGIN + '/webhook', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(body) }),
    receiptClaimToken: claim, channel: 'telegram_callback', operation: 'account.menu.read', nowSeconds: f.now });
  const { authorization, handler } = await authorizeTelegramHandler(context, body);
  return bindLegacyCompatibilityEnv(await prepareLegacyCompatibility(authorization, { family: handler.capability }), f.serverEnv);
}

test('exact confirmed current package refund appends one debit, invalidates current access, and keeps every immutable interval', async t => {
  const f = fixture(t), first = await packagePayment(f), future = await packagePayment(f, { plan: 'dragon', source: first.period });
  const periods = all(f, 'subscription_package_periods'), metadata = all(f, 'subscription_package_orders');
  const source = await readPackageSettlementSource(f.serverEnv, first.payment);
  assert.equal(source.period.period_id, first.period.period_id);
  const calls = [], result = await requestStarsRefund(f.serverEnv, refund(f, first), { telegramApi: async (_env, method, payload) => {
    calls.push({ method, payload }); return true;
  } });
  assert.equal(result.refunded, true); assert.equal(result.accessChanged, true);
  assert.deepEqual(calls, [{ method: 'refundStarPayment', payload: { user_id: 101,
    telegram_payment_charge_id: first.payment.telegram_payment_charge_id } }]);
  assert.deepEqual(all(f, 'subscription_package_periods'), periods); assert.deepEqual(all(f, 'subscription_package_orders'), metadata);
  assert.equal(all(f, 'subscription_access_grants').length, 0); assert.equal(all(f, 'subscriptions').length, 0);
  const effect = f.sqlite.prepare("SELECT * FROM payment_ledger WHERE entry_type='refund'").get();
  assert.equal(effect.related_ledger_entry_id, first.payment.ledger_entry_id); assert.equal(effect.amount_stars, 699);
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(future.orderId).order_state, 'applied');
  const duplicate = await requestStarsRefund(f.serverEnv, refund(f, first), { telegramApi: async () => assert.fail('duplicate provider call') });
  assert.equal(duplicate.status, 'duplicate'); assert.equal(all(f, 'payment_ledger').length, 3);
});

test('refunding a future different-plan package does not revoke or compact the current paid package', async t => {
  const f = fixture(t), first = await packagePayment(f), future = await packagePayment(f, { plan: 'dragon', source: first.period });
  const before = all(f, 'subscription_package_periods');
  const result = await applyStarsCompensation(f.serverEnv, { telegramPaymentChargeId: future.payment.telegram_payment_charge_id,
    compensationType: 'refund', occurredAt: f.now });
  assert.equal(result.accessChanged, false); assert.deepEqual(all(f, 'subscription_package_periods'), before);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM payment_ledger WHERE related_ledger_entry_id=?").get(first.payment.ledger_entry_id).n, 0);
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(first.orderId).order_state, 'applied');
});

test('provider-shaped refund update must match exact owner, payload, amount and charge; duplicate events have one debit', async t => {
  const f = fixture(t), paid = await packagePayment(f);
  for (const patch of [{ total_amount: 1 }, { invoice_payload: 'foreign-invoice' }, { currency: 'USD' }])
    await assert.rejects(() => handleStarsRefundedPaymentUpdate(f.serverEnv, update(paid, patch)), error => error.code === 'refunded_payment_mismatch');
  const wrongOwner = update(paid); wrongOwner.message.from.id = 202; wrongOwner.message.chat.id = 202;
  await assert.rejects(() => handleStarsRefundedPaymentUpdate(f.serverEnv, wrongOwner), error => error.code === 'refunded_payment_mismatch');
  assert.equal(all(f, 'payment_ledger').length, 1);
  assert.equal((await handleStarsRefundedPaymentUpdate(f.serverEnv, update(paid), { receivedAt: f.now })).status, 'applied');
  assert.equal((await handleStarsRefundedPaymentUpdate(f.serverEnv, update(paid), { receivedAt: f.now })).status, 'duplicate');
  assert.equal(all(f, 'payment_ledger').length, 2); assert.equal(all(f, 'payment_refunds').length, 1);
});

test('unknown refund response preserves money/access and durable request prevents another provider attempt', async t => {
  const f = fixture(t), paid = await packagePayment(f), periods = all(f, 'subscription_package_periods'); let calls = 0;
  const api = async () => { calls++; throw new Error('synthetic lost refund response'); };
  assert.equal((await requestStarsRefund(f.serverEnv, refund(f, paid), { telegramApi: api })).refunded, false);
  assert.equal((await requestStarsRefund(f.serverEnv, refund(f, paid), { telegramApi: api })).refunded, false);
  assert.equal(calls, 1); assert.equal(all(f, 'payment_ledger').length, 1);
  assert.deepEqual(all(f, 'subscription_package_periods'), periods); assert.equal(all(f, 'payment_refunds')[0].status, 'manual_review');
});

test('package chargeback records the exact debit and existing suspension policy without rewriting package dates', async t => {
  const f = fixture(t), first = await packagePayment(f), future = await packagePayment(f, { plan: 'dragon', source: first.period });
  const before = all(f, 'subscription_package_periods');
  const result = await applyStarsCompensation(f.serverEnv, { telegramPaymentChargeId: first.payment.telegram_payment_charge_id,
    compensationType: 'chargeback', occurredAt: f.now });
  assert.equal(result.accessChanged, true); assert.deepEqual(all(f, 'subscription_package_periods'), before);
  assert.equal(f.sqlite.prepare('SELECT access_state FROM user_access_states WHERE telegram_id=101').get().access_state, 'suspended');
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(future.orderId).order_state, 'applied');
  assert.equal((await applyStarsCompensation(f.serverEnv, { telegramPaymentChargeId: first.payment.telegram_payment_charge_id,
    compensationType: 'chargeback', occurredAt: f.now })).status, 'duplicate');
});

test('disabling every new producer flag preserves accepted package refund/read compatibility', async t => {
  const f = fixture(t), paid = await packagePayment(f);
  f.serverEnv = { ...f.serverEnv, STARS_PACKAGES_ENABLED: 'false', STARS_PACKAGE_3M_ENABLED: 'false',
    STARS_PACKAGE_6M_ENABLED: 'false', STARS_PACKAGE_12M_ENABLED: 'false' };
  assert.equal((await readPackageSettlementSource(f.serverEnv, paid.payment)).period.period_id, paid.period.period_id);
  assert.equal((await requestStarsRefund(f.serverEnv, refund(f, paid), { telegramApi: async () => true })).refunded, true);
});

test('package source validates immutable HMAC and incomplete package schema fails before provider or ledger effects', async t => {
  const f = fixture(t), paid = await packagePayment(f);
  await assert.rejects(() => readPackageSettlementSource({ ...f.serverEnv, STARS_INVOICE_SECRET: 'different-offline-secret-more-than-32-characters' }, paid.payment));
  f.sqlite.exec('DROP TRIGGER v144_package_period_binding');
  await assert.rejects(() => requestStarsRefund(f.serverEnv, refund(f, paid), { telegramApi: async () => assert.fail('no provider on malformed schema') }), /v144_package_schema_not_ready/u);
  assert.equal(all(f, 'payment_ledger').length, 1); assert.equal(all(f, 'payment_refunds').length, 0);
});

test('confirmed unapplied package charge remains refundable without inventing an access period', async t => {
  const f = fixture(t), paid = await packagePayment(f, { period: false });
  assert.equal((await readPackageSettlementSource(f.serverEnv, paid.payment)).period, null);
  const result = await requestStarsRefund(f.serverEnv, refund(f, paid), { telegramApi: async () => true });
  assert.equal(result.refunded, true); assert.equal(result.accessChanged, false);
  assert.equal(all(f, 'subscription_package_periods').length, 0); assert.equal(all(f, 'payment_ledger').length, 2);
});

test('maintenance and advisory summary switch exactly at immutable mixed-plan boundary; old monthly purchase cannot overlap packages', async t => {
  const f = fixture(t), first = await packagePayment(f), future = await packagePayment(f, { plan: 'dragon', source: first.period });
  const periods = all(f, 'subscription_package_periods'), ledger = all(f, 'payment_ledger');
  assert.equal((await getStarsUserAccessSummary(f.serverEnv, 101, { at: f.now })).planCode, 'professional');
  await assert.rejects(() => assertStarsPurchaseAllowed(f.serverEnv, { telegramId: 101,
    requestedPlanCode: 'dragon', at: f.now }), error => error.code === 'paid_package_monthly_conflict');
  const boundary = first.period.ends_at;
  assert.equal((await getStarsUserAccessSummary(f.serverEnv, 101, { at: boundary - 1 })).planCode, 'professional');
  const switched = await getStarsUserAccessSummary(f.serverEnv, 101, { at: boundary });
  assert.equal(switched.planCode, 'dragon'); assert.equal(switched.periodEndsAt, future.period.ends_at); assert.equal(switched.autoRenew, false);
  const maintenance = await runStarsAccessMaintenance(f.serverEnv, { at: boundary });
  assert.equal(maintenance.packageSubjectsVerified, 1); assert.equal(maintenance.currentPackageSubjects, 1);
  assert.equal(maintenance.expired, 0); assert.deepEqual(all(f, 'subscription_package_periods'), periods);
  assert.deepEqual(all(f, 'payment_ledger'), ledger); assert.equal(all(f, 'subscriptions').length, 0);
  assert.equal((await getStarsUserAccessSummary(f.serverEnv, 101, { at: future.period.ends_at })).planCode, 'free');
  assert.equal((await assertStarsPurchaseAllowed(f.serverEnv, { telegramId: 101,
    requestedPlanCode: 'dragon', at: future.period.ends_at })).allowed, true);
});

test('refund of the old monthly source preserves a separately paid future package and its original boundary', async t => {
  const f = fixture(t), month = await f.paid();
  const c = f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE retired_at IS NULL').get();
  const token = await authorizeOwnStarsSubscriptionCommand(await f.auth({ payload: {
    subscriptionAction: 'cancel_renewal', contractId: c.contract_id, expectedRevision: c.revision } }));
  assert.equal((await requestOwnStarsSubscriptionCommand(token, { telegramApi: async () => true })).status, 'confirmed');
  f.now = Math.max(f.now, Math.floor(Date.now() / 1000));
  const source = f.sqlite.prepare('SELECT * FROM subscriptions').get();
  const future = await packagePayment(f, { plan: 'professional', source });
  const before = all(f, 'subscription_package_periods');
  const result = await requestStarsRefund(f.serverEnv, { adminTelegramId: 900,
    telegramPaymentChargeId: month.update.message.successful_payment.telegram_payment_charge_id,
    reasonCode: 'offline_old_month_refund', requestedAt: f.now }, { telegramApi: async () => true });
  assert.equal(result.refunded, true); assert.deepEqual(all(f, 'subscription_package_periods'), before);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM payment_ledger WHERE related_ledger_entry_id=?").get(future.payment.ledger_entry_id).n, 0);
  const summary = await getStarsUserAccessSummary(f.serverEnv, 101, { at: future.period.starts_at });
  assert.equal(summary.planCode, 'professional'); assert.equal(summary.periodEndsAt, future.period.ends_at);
});

test('refund of a retained second package charge does not close the original applied order or revoke its paid period', async t => {
  const f = fixture(t), paid = await packagePayment(f), incoming = successful(f, paid);
  const order = f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(paid.orderId);
  const result = await recordGenuinePackage(f, incoming);
  assert.equal(result.status, 'manual_review'); assert.equal(all(f, 'subscription_package_periods').length, 1);
  const chargeId = incoming.message.successful_payment.telegram_payment_charge_id;
  const retained = f.sqlite.prepare("SELECT * FROM payment_ledger WHERE telegram_payment_charge_id=? AND entry_type='payment'").get(chargeId);
  assert.equal(retained.reason_code, 'package_payment_review_retained');
  const effect = await requestStarsRefund(f.serverEnv, { adminTelegramId: 900,
    telegramPaymentChargeId: chargeId, reasonCode: 'offline_retained_second_refund', requestedAt: f.now }, { telegramApi: async () => true });
  assert.equal(effect.refunded, true); assert.equal(effect.accessChanged, false);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(paid.orderId), order);
  assert.equal((await getStarsUserAccessSummary(f.serverEnv, 101, { at: f.now })).planCode, 'professional');
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM payment_ledger WHERE related_ledger_entry_id=?").get(paid.payment.ledger_entry_id).n, 0);
  assert.equal((await requestStarsRefund(f.serverEnv, { adminTelegramId: 900,
    telegramPaymentChargeId: chargeId, reasonCode: 'offline_retained_second_refund', requestedAt: f.now },
    { telegramApi: async () => assert.fail('retained duplicate refund') })).status, 'duplicate');
});

test('genuine late package payment on failed origin is retained and exact-charge refund settles without reopening or granting', async t => {
  const f = fixture(t), origin = await packagePayment(f, { settled: false });
  f.sqlite.prepare("UPDATE subscription_orders SET order_state='failed',closed_at=?,updated_at=?,state_revision=state_revision+1 WHERE order_id=?")
    .run(f.now - 1, f.now - 1, origin.orderId);
  const incoming = successful(f, origin), result = await recordGenuinePackage(f, incoming);
  assert.equal(result.status, 'manual_review'); assert.equal(all(f, 'subscription_package_periods').length, 0);
  const chargeId = incoming.message.successful_payment.telegram_payment_charge_id;
  const effect = await requestStarsRefund(f.serverEnv, { adminTelegramId: 900,
    telegramPaymentChargeId: chargeId, reasonCode: 'offline_late_failed_origin_refund', requestedAt: f.now }, { telegramApi: async () => true });
  assert.equal(effect.refunded, true); assert.equal(effect.accessChanged, false);
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(origin.orderId).order_state, 'failed');
  assert.equal(all(f, 'payment_ledger').length, 2); assert.equal(all(f, 'subscription_access_grants').length, 0);
});

test('actual-shaped incoming/outgoing package reconciliation matches exact completed refund without another effect', async t => {
  const f = fixture(t), paid = await packagePayment(f);
  await requestStarsRefund(f.serverEnv, refund(f, paid), { telegramApi: async () => true });
  f.serverEnv = { ...f.serverEnv, STARS_RECONCILIATION_ENABLED: 'true' };
  const before = all(f, 'payment_ledger'), periods = all(f, 'subscription_package_periods');
  const partner = { type: 'user', user: { id: 101, is_bot: false }, transaction_type: 'invoice_payment', invoice_payload: paid.payload };
  const result = await reconcileStarsTransactions(f.serverEnv, { initiatedBy: 900, startedAt: f.now }, { telegramApi: async (_env, method) => {
    assert.equal(method, 'getStarTransactions'); return { transactions: [
      { id: paid.payment.telegram_payment_charge_id, amount: 699, date: paid.payment.occurred_at, source: partner },
      { id: paid.payment.telegram_payment_charge_id, amount: -699, date: f.now, receiver: partner },
    ] };
  } });
  assert.equal(result.status, 'completed'); assert.equal(result.transactionsMatched, 2); assert.equal(result.discrepancies, 0);
  assert.deepEqual(all(f, 'payment_ledger'), before); assert.deepEqual(all(f, 'subscription_package_periods'), periods);
});

test('historical provider refund reconciles after delayed access application without backdating mutable rows or changing surviving paid evidence', async t => {
  const f = fixture(t), paidAt = f.now, historicalRefundAt = paidAt + 5;
  async function ordinaryPayment() {
    await acceptStarsPurchaseTerms(f.serverEnv, { telegramId: 101, telegramUpdateId: next() });
    const issued = await issueStarsInvoice(f.serverEnv, { telegramId: 101, requestedPlanCode: 'dragon', telegramUpdateId: next() }, {
      telegramApi: async () => ({ message_id: next() }) });
    const order = f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(issued.orderId);
    assert.equal((await handleStarsPreCheckoutQuery(f.serverEnv, { update_id: next(), pre_checkout_query: {
      id: 'historical-checkout-' + next(), from: { id: 101, is_bot: false }, currency: 'XTR',
      total_amount: order.amount_stars, invoice_payload: order.invoice_payload } }, { telegramApi: async () => true })).approved, true);
    const charge = 'historical-charge-' + next(), incoming = { update_id: next(), message: {
      message_id: next(), date: f.now, from: { id: 101, is_bot: false }, chat: { id: 101, type: 'private' },
      successful_payment: { currency: 'XTR', total_amount: order.amount_stars, invoice_payload: order.invoice_payload,
        telegram_payment_charge_id: charge, provider_payment_charge_id: '' } } };
    const record = await recordStarsSuccessfulPayment(f.serverEnv, incoming, { receivedAt: f.now });
    return { order, record, charge, occurredAt: f.now };
  }
  const first = await ordinaryPayment(); let refundCalls = 0;
  f.now = paidAt + 4;
  const pending = await requestStarsRefund(f.serverEnv, { adminTelegramId: 900, telegramPaymentChargeId: first.charge,
    requestedAt: f.now, reasonCode: 'historical_refund_response_lost' }, { telegramApi: async (_env, method) => {
    assert.equal(method, 'refundStarPayment'); refundCalls++;
    throw Object.assign(new Error('offline refund response lost'), { ambiguous: true });
  } });
  assert.equal(pending.status, 'manual_review'); assert.equal(all(f, 'payment_ledger').length, 1);
  f.now = paidAt + 10;
  assert.equal((await applyStarsPaidAccess(f.serverEnv, { orderId: first.record.orderId, appliedAt: f.now })).accessApplied, true);
  f.now = paidAt + 11;
  const second = await ordinaryPayment();
  f.now = paidAt + 12;
  assert.equal((await applyStarsPaidAccess(f.serverEnv, { orderId: second.record.orderId, appliedAt: f.now })).accessApplied, true);
  const originalGrant = f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(first.record.ledgerEntryId);
  const survivor = f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(second.record.ledgerEntryId);
  const current = all(f, 'subscriptions')[0], credits = all(f, 'payment_ledger');
  assert.ok(historicalRefundAt < originalGrant.created_at); assert.ok(historicalRefundAt < current.updated_at);
  const partner = paid => ({ type: 'user', user: { id: 101, is_bot: false }, transaction_type: 'invoice_payment',
    invoice_payload: paid.order.invoice_payload });
  const page = { transactions: [
    { id: first.charge, amount: first.order.amount_stars, date: paidAt, source: partner(first) },
    { id: second.charge, amount: second.order.amount_stars, date: second.occurredAt, source: partner(second) },
    { id: first.charge, amount: -first.order.amount_stars, date: historicalRefundAt, receiver: partner(first) },
  ] };
  f.now = paidAt + 20;
  const env = await legacyReconciliationEnv(f), reconcile = () => reconcileStarsTransactions(env,
    { initiatedBy: 900, startedAt: f.now }, { telegramApi: async (_env, method) => {
      assert.equal(method, 'getStarTransactions'); return page;
    } });
  const result = await reconcile();
  assert.equal(result.status, 'completed', JSON.stringify(all(f, 'payment_reconciliation_items')));
  assert.equal(result.transactionsMatched, 3); assert.equal(result.discrepancies, 0);
  const debit = f.sqlite.prepare("SELECT * FROM payment_ledger WHERE entry_type='refund'").get();
  assert.equal(debit.related_ledger_entry_id, first.record.ledgerEntryId); assert.equal(debit.occurred_at, historicalRefundAt);
  assert.equal(debit.recorded_at, f.now); assert.deepEqual(all(f, 'payment_ledger').filter(row => row.entry_type === 'payment'), credits);
  const refundedGrant = f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE grant_id=?').get(originalGrant.grant_id);
  assert.equal(refundedGrant.status, 'refunded'); assert.equal(refundedGrant.updated_at, f.now);
  assert.ok(refundedGrant.updated_at >= refundedGrant.created_at);
  assert.equal(refundedGrant.starts_at, originalGrant.starts_at); assert.equal(refundedGrant.ends_at, originalGrant.ends_at);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE grant_id=?').get(survivor.grant_id), survivor);
  const shortened = all(f, 'subscriptions')[0];
  assert.equal(shortened.updated_at, f.now); assert.ok(shortened.updated_at >= current.updated_at);
  assert.equal(shortened.current_period_end, current.current_period_end - first.order.access_seconds);
  assert.equal(f.sqlite.prepare('SELECT updated_at FROM subscription_orders WHERE order_id=?').get(first.order.order_id).updated_at, f.now);
  const receipt = all(f, 'payment_refunds')[0];
  assert.equal(receipt.status, 'applied'); assert.equal(receipt.confirmed_at, historicalRefundAt);
  assert.equal(receipt.applied_at, historicalRefundAt); assert.equal(receipt.updated_at, f.now);
  const event = f.sqlite.prepare("SELECT * FROM payment_events WHERE event_type='refund_confirmed'").get();
  assert.equal(event.occurred_at, historicalRefundAt); assert.equal(event.received_at, f.now);
  const settledLedger = all(f, 'payment_ledger');
  f.now++;
  assert.equal((await reconcile()).status, 'completed'); assert.equal(refundCalls, 1);
  assert.deepEqual(all(f, 'payment_ledger'), settledLedger); assert.deepEqual(all(f, 'subscriptions'), [shortened]);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE grant_id=?').get(survivor.grant_id), survivor);
});

test('retained late package cash becomes reconciled after its exact confirmed refund while origin stays failed', async t => {
  const f = fixture(t), origin = await packagePayment(f, { settled: false });
  f.sqlite.prepare("UPDATE subscription_orders SET order_state='failed',closed_at=?,updated_at=?,state_revision=state_revision+1 WHERE order_id=?")
    .run(f.now - 1, f.now - 1, origin.orderId);
  const incoming = successful(f, origin);
  await recordGenuinePackage(f, incoming);
  const charge = incoming.message.successful_payment.telegram_payment_charge_id;
  await requestStarsRefund(f.serverEnv, { adminTelegramId: 900, telegramPaymentChargeId: charge,
    reasonCode: 'offline_reconcile_retained_refund', requestedAt: f.now }, { telegramApi: async () => true });
  f.serverEnv = { ...f.serverEnv, STARS_RECONCILIATION_ENABLED: 'true' };
  const before = all(f, 'payment_ledger'), partner = { type: 'user', user: { id: 101, is_bot: false },
    transaction_type: 'invoice_payment', invoice_payload: origin.payload };
  const result = await reconcileStarsTransactions(f.serverEnv, { initiatedBy: 900, startedAt: f.now }, { telegramApi: async () => ({ transactions: [
    { id: charge, amount: 699, date: f.now, source: partner }, { id: charge, amount: -699, date: f.now, receiver: partner },
  ] }) });
  assert.equal(result.status, 'completed'); assert.equal(result.transactionsMatched, 2); assert.equal(result.discrepancies, 0);
  assert.deepEqual(all(f, 'payment_ledger'), before); assert.equal(all(f, 'subscription_package_periods').length, 0);
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(origin.orderId).order_state, 'failed');
});

test('genuine owner Mini App exact-ledger refund uses the private fixed facade and idempotent confirmed accounting', async t => {
  const f = fixture(t), paid = await packagePayment(f, { id: 900 }), payload = { ledgerEntryId: paid.payment.ledger_entry_id };
  const calls = [], api = async (_env, method, body) => { calls.push({ method, body }); return true; };
  const result = await requestOwnPackageRefund(await refundContext(f, payload), payload, { telegramApi: api });
  assert.equal(result.refunded, true); assert.equal(result.accessChanged, true);
  assert.deepEqual(calls, [{ method: 'refundStarPayment', body: { user_id: 900,
    telegram_payment_charge_id: paid.payment.telegram_payment_charge_id } }]);
  const repeated = await requestOwnPackageRefund(await refundContext(f, payload), payload, { telegramApi: async () => assert.fail('duplicate own refund') });
  assert.equal(repeated.status, 'duplicate'); assert.equal(all(f, 'payment_ledger').length, 2);
});

test('owner Mini App can refund exact retained failed-origin cash through the fixed facade without reopening its invoice', async t => {
  const f = fixture(t), origin = await packagePayment(f, { id: 900, settled: false });
  f.sqlite.prepare("UPDATE subscription_orders SET order_state='failed',closed_at=?,updated_at=?,state_revision=state_revision+1 WHERE order_id=?")
    .run(f.now - 1, f.now - 1, origin.orderId);
  const incoming = successful(f, origin), retained = await recordGenuinePackage(f, incoming);
  const payload = { ledgerEntryId: retained.ledgerEntryId };
  const result = await requestOwnPackageRefund(await refundContext(f, payload), payload, { telegramApi: async () => true });
  assert.equal(result.refunded, true); assert.equal(all(f, 'payment_ledger').length, 2);
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(origin.orderId).order_state, 'failed');
  assert.equal(all(f, 'subscription_package_periods').length, 0);
});

test('own package refund rejects foreign charge, non-owner, raw context and client money fields before any provider effect', async t => {
  const f = fixture(t), member = await packagePayment(f), owner = await packagePayment(f, { id: 900 });
  const api = async () => assert.fail('denied package refund provider');
  const foreign = { ledgerEntryId: member.payment.ledger_entry_id };
  await assert.rejects(async () => requestOwnPackageRefund(await refundContext(f, foreign), foreign, { telegramApi: api }));
  await assert.rejects(async () => requestOwnPackageRefund(await refundContext(f, foreign, 101), foreign, { telegramApi: api }));
  const payload = { ledgerEntryId: owner.payment.ledger_entry_id };
  await assert.rejects(() => requestOwnPackageRefund({}, payload, { telegramApi: api }));
  const extended = { ...payload, amountStars: 1 };
  await assert.rejects(async () => requestOwnPackageRefund(await refundContext(f, extended), extended, { telegramApi: api }));
  assert.equal(all(f, 'payment_ledger').length, 2); assert.equal(all(f, 'payment_refunds').length, 0);
});

test('owner authority lost after conclusive provider refund still accounts exact cash and cannot repeat a provider operation', async t => {
  const f = fixture(t), paid = await packagePayment(f, { id: 900 }), payload = { ledgerEntryId: paid.payment.ledger_entry_id }; let calls = 0;
  const result = await requestOwnPackageRefund(await refundContext(f, payload), payload, { telegramApi: async (_env, method) => {
    calls++; assert.equal(method, 'refundStarPayment'); f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=900').run(); return true;
  } });
  assert.equal(result.refunded, true); assert.equal(calls, 1); assert.equal(all(f, 'payment_ledger').length, 2);
  assert.equal(all(f, 'payment_refunds')[0].status, 'applied');
  await assert.rejects(async () => requestOwnPackageRefund(await refundContext(f, payload), payload,
    { telegramApi: async () => assert.fail('blocked owner cannot retry') }));
  assert.equal(all(f, 'payment_ledger').length, 2);
});

test('package refund switch is default off and only its genuine owner facade can enable the fixed executor', async t => {
  const f = fixture(t), paid = await packagePayment(f, { id: 900 }), payload = { ledgerEntryId: paid.payment.ledger_entry_id };
  f.serverEnv = { ...f.serverEnv, STARS_REFUNDS_ENABLED: 'false', STARS_PACKAGE_REFUNDS_ENABLED: 'false' };
  const api = async () => assert.fail('disabled package refund provider');
  await assert.rejects(async () => requestOwnPackageRefund(await refundContext(f, payload), payload, { telegramApi: api }));
  f.serverEnv = { ...f.serverEnv, STARS_REFUNDS_ENABLED: 'true' };
  await assert.rejects(async () => requestOwnPackageRefund(await refundContext(f, payload), payload, { telegramApi: api }));
  f.serverEnv = { ...f.serverEnv, STARS_REFUNDS_ENABLED: 'false' };
  f.serverEnv = { ...f.serverEnv, STARS_PACKAGE_REFUNDS_ENABLED: 'true' };
  assert.equal(readStarsOperationsConfig(f.serverEnv).refundsEnabled, false);
  await assert.rejects(() => requestStarsRefund(f.serverEnv, refund(f, paid), { telegramApi: api }), error => error.code === 'stars_refunds_disabled');
  const result = await requestOwnPackageRefund(await refundContext(f, payload), payload, { telegramApi: async () => true });
  assert.equal(result.refunded, true); assert.equal(all(f, 'payment_ledger').length, 2);
});

test('package refund flag cannot admit an ordinary owner monthly payment outside package metadata', async t => {
  const f = fixture(t);
  await acceptStarsPurchaseTerms(f.serverEnv, { telegramId: 900, telegramUpdateId: next() });
  const invoice = await issueStarsInvoice(f.serverEnv, { telegramId: 900, requestedPlanCode: 'professional', telegramUpdateId: next() }, {
    telegramApi: async () => ({ message_id: next() }) });
  const order = f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(invoice.orderId);
  assert.equal((await handleStarsPreCheckoutQuery(f.serverEnv, { update_id: next(), pre_checkout_query: { id: 'ordinary-owner-' + next(),
    from: { id: 900, is_bot: false }, currency: 'XTR', total_amount: order.amount_stars, invoice_payload: order.invoice_payload } },
    { telegramApi: async () => true })).approved, true);
  const incoming = { update_id: next(), message: { message_id: next(), date: f.now, from: { id: 900, is_bot: false },
    chat: { id: 900, type: 'private' }, successful_payment: { currency: 'XTR', total_amount: order.amount_stars,
      invoice_payload: order.invoice_payload, telegram_payment_charge_id: 'ordinary-owner-charge-' + next(), provider_payment_charge_id: '' } } };
  const recorded = await recordStarsSuccessfulPayment(f.serverEnv, incoming);
  await applyStarsPaidAccess(f.serverEnv, { orderId: recorded.orderId, appliedAt: f.now });
  f.serverEnv = { ...f.serverEnv, STARS_REFUNDS_ENABLED: 'false', STARS_PACKAGE_REFUNDS_ENABLED: 'true' };
  const payload = { ledgerEntryId: recorded.ledgerEntryId }, before = all(f, 'payment_ledger');
  await assert.rejects(async () => requestOwnPackageRefund(await refundContext(f, payload), payload,
    { telegramApi: async () => assert.fail('package switch cannot refund ordinary monthly cash') }));
  assert.deepEqual(all(f, 'payment_ledger'), before); assert.equal(all(f, 'payment_refunds').length, 0);
  assert.equal((await getStarsUserAccessSummary(f.serverEnv, 900, { at: f.now })).planCode, 'professional');
});

test('actual provider page behind selected Telegram reconciliation facade retains missing package cash once without granting access', async t => {
  const f = fixture(t), origin = await packagePayment(f, { settled: false });
  const env = await legacyReconciliationEnv(f);
  const tx = { id: 'offline-package-reconciled-charge-' + next(), amount: 699, date: f.now,
    source: { type: 'user', user: { id: 101, is_bot: false }, transaction_type: 'invoice_payment', invoice_payload: origin.payload } };
  await assert.rejects(() => bindPackageReconciliationAccountingEnv(env, {}), /untrusted_package_reconciliation_observation/u);
  await assert.rejects(() => bindPackageReconciliationAccountingEnv({ ...env }, {}), /untrusted_legacy_compatibility_env/u);
  const result = await reconcileStarsTransactions(env, { initiatedBy: 900, startedAt: f.now }, { telegramApi: async (_env, method) => {
    assert.equal(method, 'getStarTransactions');
    const run = f.sqlite.prepare("SELECT run_id FROM payment_reconciliation_runs WHERE status='running'").get();
    const foreignContext = await createServiceExecutor({ binding: f.binding, env: f.serverEnv, purpose: 'stars_reconcile',
      clockSeconds: () => f.now }).createContext();
    const foreignToken = await capturePackageReconciliationObservation({ context: foreignContext, runId: run.run_id,
      providerPage: { transactions: [tx] }, transaction: tx, observedAt: f.now });
    await assert.rejects(() => bindPackageReconciliationAccountingEnv(env, foreignToken), /untrusted_package_reconciliation_observation/u);
    const serviceContext = await createServiceExecutor({ binding: env.DB, env, purpose: 'stars_reconcile', clockSeconds: () => f.now }).createContext();
    const token = await capturePackageReconciliationObservation({ context: serviceContext, runId: run.run_id,
      providerPage: { transactions: [tx] }, transaction: tx, observedAt: f.now });
    const accounting = await bindPackageReconciliationAccountingEnv(env, token);
    await assert.rejects(() => assertLegacyCompatibilityFresh(accounting), /accounting_scope_cannot_request_provider/u);
    await assert.rejects(() => accounting.DB.prepare(`INSERT INTO payment_ledger(ledger_entry_id,idempotency_key,order_id,telegram_id,
      entry_type,direction,currency,amount_stars,telegram_payment_charge_id,related_ledger_entry_id,reason_code,occurred_at,recorded_at)
      VALUES(?,?,?,?,'payment','credit','XTR',?,?,NULL,'package_payment_review_retained',?,?)`)
      .bind(randomUUID(), 'scope-negative-' + next(), origin.orderId, 900, 699, tx.id, f.now, f.now).run(), /package_reconciliation_scope_mismatch/u);
    return { transactions: [tx] };
  } });
  assert.equal(result.status, 'manual_review'); assert.equal(result.transactionsMatched, 0); assert.equal(result.discrepancies, 1);
  assert.equal(all(f, 'payment_ledger').length, 1, JSON.stringify(all(f, 'payment_reconciliation_items'))); assert.equal(all(f, 'subscription_package_periods').length, 0);
  assert.equal(all(f, 'subscription_access_grants').length, 0); assert.equal(all(f, 'subscriptions').length, 0);
  const credit = all(f, 'payment_ledger')[0], receipt = all(f, 'subscription_package_payment_reviews')[0];
  assert.equal(credit.reason_code, 'package_payment_review_retained'); assert.equal(credit.telegram_payment_charge_id, tx.id);
  assert.equal(receipt.ledger_entry_id, credit.ledger_entry_id); assert.equal(receipt.reconciliation_run_id, result.runId);
  assert.match(receipt.provider_page_sha256, /^[0-9a-f]{64}$/u); assert.match(receipt.provider_transaction_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(origin.orderId).order_state, 'failed');
  const repeated = await reconcileStarsTransactions(env, { initiatedBy: 900, startedAt: f.now }, {
    telegramApi: async () => ({ transactions: [tx] }) });
  assert.equal(repeated.status, 'manual_review'); assert.deepEqual(all(f, 'payment_ledger'), [credit]);
  assert.deepEqual(all(f, 'subscription_package_payment_reviews'), [receipt]);
});

for (const race of [false, true]) test(`genuine old recurring renewal ${race ? 'losing a package commit race' : 'after a paid future package'} retains real cash without an overlapping grant`, async t => {
  const f = fixture(t), month = await f.paid();
  const c = f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE retired_at IS NULL').get();
  const token = await authorizeOwnStarsSubscriptionCommand(await f.auth({ payload: {
    subscriptionAction: 'cancel_renewal', contractId: c.contract_id, expectedRevision: c.revision } }));
  await requestOwnStarsSubscriptionCommand(token, { telegramApi: async () => true });
  const source = f.sqlite.prepare('SELECT * FROM subscriptions').get();
  const future = await packagePayment(f, { plan: 'professional', source, period: !race });
  const grants = all(f, 'subscription_access_grants'), current = all(f, 'subscriptions');
  if (race) f.binding.beforeBatch = () => insert(f, 'subscription_package_periods', future.proposedPeriod);
  const renewal = f.successful(month.order, { expiration: source.current_period_end + 30 * 86400, first: false });
  const result = await recordStarsSuccessfulPayment(f.serverEnv, renewal);
  assert.equal(result.status, 'manual_review'); assert.equal(result.accessApplied, false);
  assert.deepEqual(all(f, 'subscription_access_grants'), grants); assert.deepEqual(all(f, 'subscriptions'), current);
  assert.equal(all(f, 'subscription_package_periods').length, 1); assert.equal(all(f, 'payment_ledger').length, 3);
  const retained = f.sqlite.prepare("SELECT * FROM payment_ledger WHERE telegram_payment_charge_id=? AND entry_type='payment'")
    .get(renewal.message.successful_payment.telegram_payment_charge_id);
  assert.equal(retained.reason_code, 'payment_review_retained'); assert.equal(retained.order_id, month.order.order_id);
  assert.equal((await getStarsUserAccessSummary(f.serverEnv, 101, { at: future.proposedPeriod.starts_at })).planCode, 'professional');
  const duplicate = await recordStarsSuccessfulPayment(f.serverEnv, renewal);
  assert.equal(duplicate.status, 'manual_review'); assert.equal(duplicate.duplicate, true); assert.equal(all(f, 'payment_ledger').length, 3);
});
