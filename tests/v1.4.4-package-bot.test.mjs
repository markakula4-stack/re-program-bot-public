import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { authoritySeconds, createAuthorityResolver } from '../src/v1.4.1/authority-resolver.mjs';
import { createCustomerContext, createFinancialCustomerContext } from '../src/v1.4.1/trusted-context.mjs';
import { acceptStarsPurchaseTerms, handleStarsPreCheckoutQuery, recordStarsSuccessfulPayment } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsCompensation } from '../src/v1.3.6/stars-access-runtime.mjs';
import { issuePackageInvoice } from '../src/v1.4.4/package-payment-runtime.mjs';
import { executePackageCommerceCommand } from '../src/v1.4.4/package-commerce-runtime.mjs';
import { PACKAGE_DURATIONS, PACKAGE_CANONICAL_PRICES } from '../src/v1.4.4/package-contract.mjs';
import { readOwnSubscriptionBotView, subscriptionBotViewForCallback } from '../src/v1.4.3/subscription-bot.mjs';

const resolver = createAuthorityResolver();
const realDateNow = Date.now;
let sequence = 2446000;
const next = () => ++sequence;
const stamp = seconds => new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
function fixture(t, patch = {}) {
  const f = foundationFixture(t);
  // Financial writes and authority reads must share the synthetic clock.
  // A slow host must not make recorded_at appear to be in the fixture's future.
  Date.now = () => f.now * 1000;
  t.after(() => { Date.now = realDateNow; });
  f.sqlite.function('current_timestamp', { deterministic: false }, () => stamp(f.now));
  f.sqlite.function('unixepoch', { deterministic: false, varargs: true }, (...args) =>
    !args.length || args[0] === 'now' ? f.now : authoritySeconds(args[0]));
  for (const name of ['0026-v1.3.6-stars-core-foundation.sql', '0027-v1.3.6-stars-access-and-reconciliation.sql',
    '0066-v1.4.3-subscription-lifecycle-foundation.sql', '0067-v1.4.3-lifecycle-engine-binding.sql',
    '0068-v1.4.3-provider-and-review-binding.sql', '0069-v1.4.3-d1-compatibility.sql',
    '0070-v1.4.3-refund-notification.sql', '0071-v1.4.3-refund-contract-retirement.sql',
    '0072-v1.4.4-package-contract.sql', '0073-v1.4.4-package-payment-review.sql'])
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  f.serverEnv = { ...f.serverEnv, WEBHOOK_SECRET: 'offline-v144-bot-transport-secret', STARS_PAYMENTS_ENABLED: 'true',
    STARS_BILLING_MODE: 'prepaid', STARS_PRICE_VERSION: '1', STARS_TERMS_REVISION: '2026-09-10.stars-v1',
    STARS_RECURRING_ENABLED: 'true', STARS_INVOICE_SECRET: 'offline-v144-bot-invoice-secret-longer-than-32-characters',
    STARS_ROLLOUT_MODE: 'allowlist', STARS_ROLLOUT_ALLOWLIST: '900', STARS_PACKAGES_ENABLED: 'true',
    STARS_PACKAGE_3M_ENABLED: 'true', ...patch };
  for (const plan of ['professional', 'dragon']) for (const [code, period] of Object.entries(PACKAGE_DURATIONS))
    f.sqlite.prepare(`INSERT INTO price_book(price_id,price_version,plan_code,currency,amount_stars,
      access_seconds,billing_mode,publication_state,terms_revision,valid_from,created_at)
      VALUES(?,1,?,'XTR',?,?,'prepaid','approved',?,?,?)`).run(`${plan}-${period.durationDays}d-prepaid-v1`,
        plan, PACKAGE_CANONICAL_PRICES[plan][code], period.periodSeconds, f.serverEnv.STARS_TERMS_REVISION,
        f.now - 10000, f.now - 10000);
  for (const id of [101, 900]) {
    f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(id);
    f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(id);
  }
  return f;
}
async function bot(f, view = 'status', id = 900) {
  const update = { update_id: next(), callback_query: { id: 'offline-package-bot-' + sequence,
    from: { id, is_bot: false, first_name: 'Offline' }, data: 'sub143:' + view,
    message: { message_id: next(), date: f.now, from: { id: 123456789, is_bot: true }, chat: { id, type: 'private' } } } };
  const token = crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,
    received_at,lease_expires_at) VALUES(?,'callback_query',?,'processing',?,?,?)`)
    .run(update.update_id, id, token, f.now, f.now + 60);
  const context = await createCustomerContext({ binding: f.binding, env: f.serverEnv, webhookRequest: new Request(
    f.serverEnv.MINI_APP_ORIGIN + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': f.serverEnv.WEBHOOK_SECRET }, body: JSON.stringify(update) }),
    receiptClaimToken: token, nowSeconds: f.now, channel: 'telegram_callback', operation: 'access.read_own', requestPayload: {} });
  return readOwnSubscriptionBotView({ context, view });
}
async function financial(f, update) {
  const token = 'offline-v144-financial-claim-' + update.update_id;
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,
    received_at,lease_expires_at) VALUES(?,'message',900,'processing',?,?,?)`)
    .run(update.update_id, token, f.now, f.now + 60);
  const context = await createFinancialCustomerContext({ binding: f.binding, env: f.serverEnv,
    webhookRequest: new Request(f.serverEnv.MINI_APP_ORIGIN + '/webhook', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': f.serverEnv.WEBHOOK_SECRET }, body: JSON.stringify(update) }),
    receiptClaimToken: token, nowSeconds: f.now });
  return { packageFinancialContext: context, packageActor: await resolver.resolveActor(context) };
}
async function paidPackage(f, plan = 'professional', code = '3m') {
  await acceptStarsPurchaseTerms(f.serverEnv, { telegramId: 900, telegramUpdateId: next(), acceptedAt: f.now - 1 });
  const actor = await resolver.resolveActor(await f.context(900, 'access.read_own'));
  const telegramApi = async (_env, method) => method === 'createInvoiceLink' ? 'https://t.me/$offlinePackageBot-' + next() : true;
  const invoice = await issuePackageInvoice({ actor, request: { requestedPlanCode: plan, packageCode: code },
    telegramUpdateId: next(), createdAt: f.now }, { telegramApi });
  const order = f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(invoice.orderId);
  const checkout = { update_id: next(), pre_checkout_query: { id: 'offline-package-query-' + sequence,
    from: { id: 900, is_bot: false }, currency: 'XTR', total_amount: order.amount_stars, invoice_payload: order.invoice_payload } };
  assert.equal((await handleStarsPreCheckoutQuery(f.serverEnv, checkout, {
    nowSeconds: f.now, ...await financial(f, checkout), telegramApi })).approved, true);
  const update = { update_id: next(), message: { message_id: next(), date: f.now, from: { id: 900, is_bot: false },
    chat: { id: 900, type: 'private' }, successful_payment: { currency: 'XTR', total_amount: order.amount_stars,
      invoice_payload: order.invoice_payload, telegram_payment_charge_id: 'offline-package-bot-charge-' + next(), provider_payment_charge_id: '' } } };
  const payment = await recordStarsSuccessfulPayment(f.serverEnv, update, { receivedAt: f.now, ...await financial(f, update) });
  assert.equal(payment.status, 'recorded');
  return { order, payment, charge: update.message.successful_payment.telegram_payment_charge_id };
}
async function command(f, operation, payload) {
  if (!f.tokens.has(900)) await f.session(900);
  const context = await createCustomerContext({ binding: f.binding, env: f.serverEnv, sessionToken: f.tokens.get(900),
    nowSeconds: f.now, operation: 'access.read_own', channel: 'mini_app', requestPayload: payload,
    idempotencyKey: 'offline-package-bot-command-' + next() });
  return executePackageCommerceCommand(context, operation);
}
function money(f) {
  return JSON.stringify(['payment_ledger', 'subscription_orders', 'subscription_package_periods',
    'subscription_plan_transitions', 'subscription_billing_contracts', 'subscription_provider_commands']
    .map(table => f.sqlite.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()));
}
function noProvider(t) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async () => { calls.push('unexpected'); throw new Error('bot read forbids provider transport'); };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
function noEconomy(text) { assert.doesNotMatch(text, /эконом|\b48\s*(?:⭐|звёзд)/iu); }

test('actual gated own bot catalog shows 747 comparison and 699 full price, no economy line or closed 6/12', async t => {
  const f = fixture(t), before = money(f), calls = noProvider(t), view = await bot(f, 'packages');
  assert.match(view.text, /<s>747 ⭐<\/s> → <b>699 ⭐<\/b>/u);
  assert.match(view.text, /Professional · 90 дней/u);
  assert.match(view.text, /Разовая оплата, без автосписания/u);
  assert.doesNotMatch(view.text, /180 дней|360 дней|1299|2299|Акция/u);
  noEconomy(view.text); assert.equal(subscriptionBotViewForCallback('sub143:packages'), 'packages');
  assert.equal(subscriptionBotViewForCallback('sub143:packages:900'), null);
  assert.ok(view.keyboard.flat().some(item => item.web_app?.url === f.serverEnv.MINI_APP_ORIGIN + '/v1.4.0/cabinet/#subscription'));
  assert.ok(view.keyboard.flat().some(item => item.callback_data === 'stars_buy:terms'));
  assert.deepEqual(calls, []); assert.equal(money(f), before);
});

test('real paid package and future package stay distinct in own bot until exact boundary with safe receipts', async t => {
  const f = fixture(t), current = await paidPackage(f); f.now += 1;
  const future = await paidPackage(f, 'dragon');
  const before = money(f), calls = noProvider(t), status = await bot(f);
  assert.equal(status.planCode, 'professional'); assert.equal(status.paidAccess, true);
  assert.match(status.text, /Тариф: <b>Professional<\/b>/u);
  assert.match(status.text, /Пакет: <b>90 дней · разовая оплата<\/b>/u);
  assert.match(status.text, /Следующий оплаченный тариф: <b>Dragon<\/b>/u);
  const receipt = await bot(f, 'receipt:0');
  assert.match(receipt.text, /Пакет: <b>90 дней<\/b>/u);
  assert.match(receipt.text, /Доступ по квитанции: Оплачен, ожидает начала/u);
  assert.match(receipt.text, /Текущий тариф действует до начала/u);
  for (const privateValue of [future.order.order_id, future.charge, future.order.invoice_payload, future.payment.ledgerEntryId])
    assert.ok(!receipt.text.includes(privateValue));
  f.now = current.payment.periodEndsAt;
  const switched = await bot(f); assert.equal(switched.planCode, 'dragon'); assert.equal(switched.paidAccess, true);
  assert.doesNotMatch(switched.text, /Следующий оплаченный тариф: <b>Dragon/u);
  const activeReceipt = await bot(f, 'receipt:0'); assert.match(activeReceipt.text, /Доступ по квитанции: Доступ активен/u);
  f.now = future.payment.periodEndsAt;
  const expired = await bot(f); assert.equal(expired.planCode, 'free'); assert.equal(expired.paidAccess, false);
  assert.match((await bot(f, 'receipt:0')).text, /Доступ по квитанции: Оплаченный период завершён/u);
  noEconomy(receipt.text); assert.deepEqual(calls, []); assert.equal(money(f), before);
});

test('unpaid genuine scheduled change never claims access and canceled intent is rendered without refund promise', async t => {
  const f = fixture(t); await paidPackage(f);
  const scheduled = await command(f, 'schedule', { requestedPlanCode: 'dragon', packageCode: '3m' });
  const calls = noProvider(t), before = money(f), status = await bot(f);
  assert.equal(status.planCode, 'professional'); assert.match(status.text, /Запланированная смена: <b>Dragon<\/b>/u);
  assert.match(status.text, /До подтверждённой оплаты новый тариф не включится/u);
  assert.match(status.text, /Проверить отмену неоплаченного изменения можно в кабинете/u);
  assert.doesNotMatch(status.text, /Следующий оплаченный тариф/u); assert.equal(money(f), before);
  await command(f, 'cancel', { transitionId: scheduled.transition.transitionId, expectedRevision: scheduled.transition.revision });
  const canceledMoney = money(f), canceled = await bot(f, 'packages');
  assert.match(canceled.text, /Dragon · Изменение отменено/u);
  assert.doesNotMatch(canceled.text, /Возврат выполнен|автопродление отменено/u);
  assert.equal(money(f), canceledMoney); assert.deepEqual(calls, []);
});

test('future exact refund and disabled new flags preserve current plan and readable historical package in bot', async t => {
  const f = fixture(t), current = await paidPackage(f); f.now += 1;
  const future = await paidPackage(f, 'dragon');
  const refund = await applyStarsCompensation(f.serverEnv, { telegramPaymentChargeId: future.charge,
    compensationType: 'refund', telegramUpdateId: next(), occurredAt: f.now });
  assert.equal(refund.status, 'applied');
  f.serverEnv = { ...f.serverEnv, STARS_PACKAGES_ENABLED: 'false', STARS_PACKAGE_3M_ENABLED: 'false' };
  const before = money(f), calls = noProvider(t), status = await bot(f), receipt = await bot(f, 'receipt:0');
  assert.equal(status.planCode, 'professional', JSON.stringify(status)); assert.equal(status.paidUntil, current.payment.periodEndsAt);
  assert.doesNotMatch(status.text, /Следующий оплаченный тариф/u);
  assert.match(receipt.text, /Тариф: <b>Dragon<\/b>/u); assert.match(receipt.text, /Пакет: <b>90 дней<\/b>/u);
  assert.match(receipt.text, /Возврат учтён; этот платёж больше не предоставляет доступ/u);
  assert.match((await bot(f, 'packages')).text, /Новые пакеты сейчас недоступны/u);
  const foreign = await bot(f, 'history', 101); assert.match(foreign.text, /Учтённых оплат пока нет/u);
  assert.doesNotMatch(foreign.text, /699|1399/u);
  assert.equal(money(f), before); assert.deepEqual(calls, []);
});

test('monthly scheduled change explicitly requires fresh consent at boundary and keeps all bot controls read-only', async t => {
  const f = fixture(t); await paidPackage(f);
  await command(f, 'schedule', { requestedPlanCode: 'dragon', packageCode: '30d' });
  const before = money(f), calls = noProvider(t), view = await bot(f);
  assert.equal(view.planCode, 'professional'); assert.match(view.text, /На границе периода нужны новый счёт и отдельное согласие/u);
  const selectors = view.keyboard.flat().map(button => button.callback_data).filter(Boolean);
  assert.ok(selectors.every(selector => !/invoice|refund|confirm|charge/u.test(selector)));
  assert.equal(money(f), before); assert.deepEqual(calls, []);
});
