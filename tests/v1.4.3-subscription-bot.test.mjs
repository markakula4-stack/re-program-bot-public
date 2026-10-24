import test from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionFixture, MONTH } from './helpers/v1.4.3-provider-subscription-fixture.mjs';
import { createCustomerContext } from '../src/v1.4.1/trusted-context.mjs';
import { createRuntimeAuthorizer } from '../src/v1.4.1/runtime-authorizer.mjs';
import { readSubscriptionData } from '../src/v1.4.2/subscription-read-model.mjs';
import { readOwnSubscriptionBotView, renderOwnSubscriptionBotView,
  subscriptionBotViewForCallback, SUBSCRIPTION_BOT_CALLBACKS } from '../src/v1.4.3/subscription-bot.mjs';
import { handleVerifiedTelegramSubscriptionUpdate } from '../src/v1.4.3/provider-subscription-events.mjs';
import { acceptStarsPurchaseTerms, recordStarsSuccessfulPayment } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsPaidAccess, applyStarsCompensation } from '../src/v1.3.6/stars-access-runtime.mjs';
import { buildStarsInvoicePayload } from '../src/v1.3.6/stars-core-foundation.mjs';

let nextUpdate = 1434800;
async function botContext(f, view = 'status', subject = 101) {
  const update = { update_id: ++nextUpdate, callback_query: { id: 'offline-bot-callback-' + nextUpdate,
    from: { id: subject, is_bot: false, first_name: 'Offline' }, data: 'sub143:' + view,
    message: { message_id: nextUpdate, date: f.now, from: { id: 123456789, is_bot: true },
      chat: { id: subject, type: 'private' } } } };
  const token = crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,
    received_at,lease_expires_at) VALUES(?,'callback_query',?,'processing',?,?,?)`)
    .run(update.update_id, subject, token, f.now, f.now + 60);
  const context = await createCustomerContext({ binding: f.binding, env: f.serverEnv,
    webhookRequest: f.request(update), receiptClaimToken: token, nowSeconds: f.now,
    channel: 'telegram_callback', operation: 'access.read_own', requestPayload: {} });
  return { context, update, token };
}
async function control(f, state) {
  const update = f.update(state), token = f.claim(update);
  return handleVerifiedTelegramSubscriptionUpdate({ webhookRequest: f.request(update),
    serviceContext: f.serviceContext(), receiptClaimToken: token });
}
const money = f => ({ ledger: f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY ledger_entry_id').all(),
  grants: f.sqlite.prepare('SELECT * FROM subscription_access_grants ORDER BY grant_id').all(),
  contracts: f.sqlite.prepare('SELECT * FROM subscription_billing_contracts ORDER BY contract_id').all(),
  subscriptions: f.sqlite.prepare('SELECT * FROM subscriptions ORDER BY subscription_id').all(),
  commands: f.sqlite.prepare('SELECT * FROM subscription_provider_commands ORDER BY command_id').all() });
function noProvider(t) {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async () => { calls.push('unexpected provider request'); throw new Error('offline bot read forbids provider transport'); };
  t.after(() => globalThis.fetch = previous);
  return calls;
}
async function prepaidPayment(f, subject = 202) {
  const orderId = crypto.randomUUID(), created = f.now - 100, priceId = 'professional-30d-prepaid-v1';
  await acceptStarsPurchaseTerms(f.serverEnv, { telegramId: subject, telegramUpdateId: ++nextUpdate, acceptedAt: created - 1 });
  const payload = await buildStarsInvoicePayload({ invoiceSecret: f.serverEnv.STARS_INVOICE_SECRET,
    orderId, telegramId: subject, priceId });
  f.sqlite.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,currency,
    amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,expires_at,
    precheckout_approved_at,updated_at) VALUES(?,?,?,1,'professional','XTR',249,?,'prepaid',?,?,'precheckout_ok',?,?,?,?)`)
    .run(orderId, subject, priceId, MONTH, f.serverEnv.STARS_TERMS_REVISION, payload, created, f.now + 600, created + 1, created + 1);
  const paid = await recordStarsSuccessfulPayment(f.serverEnv, { update_id: ++nextUpdate, message: {
    message_id: nextUpdate, from: { id: subject, is_bot: false }, chat: { id: subject, type: 'private' },
    successful_payment: { currency: 'XTR', total_amount: 249, invoice_payload: payload,
      telegram_payment_charge_id: 'offline-bot-prepaid-' + nextUpdate, provider_payment_charge_id: '' } } },
  { receivedAt: f.now - 10 });
  assert.equal((await applyStarsPaidAccess(f.serverEnv, { orderId: paid.orderId, appliedAt: f.now - 10 })).accessApplied, true);
}

test('genuine own Telegram status matches the shared server result after cancel, failure, and read-time expiry', async t => {
  const calls = noProvider(t), f = await subscriptionFixture(t);
  await control(f, 'canceled');
  const before = money(f), { context } = await botContext(f);
  const view = await readOwnSubscriptionBotView({ context });
  const same = await readSubscriptionData({ authorization: await createRuntimeAuthorizer().authorize(context, null) });
  assert.equal(view.lifecycleState, same.lifecycle.state); assert.equal(view.paidUntil, same.lifecycle.paidUntil);
  assert.equal(view.planCode, same.access.current.planCode); assert.equal(view.planCode, 'professional');
  assert.match(view.text, /Тариф: <b>Professional<\/b>/u);
  assert.equal(view.paidAccess, true); assert.equal(view.paidUntil, f.paidUntil);
  assert.match(view.text, /Продление отменено|Оплаченный остаток сохраняется/u);
  assert.match(view.text, /Дата следующего списания: не подтверждена/u);
  assert.doesNotMatch(view.text, /вручную, без автосписания/iu); assert.deepEqual(money(f), before);
  f.now = f.paidUntil;
  const expired = await readOwnSubscriptionBotView({ context: (await botContext(f)).context });
  assert.equal(expired.lifecycleState, 'expired'); assert.equal(expired.paidAccess, false);
  assert.equal(expired.planCode, 'free'); assert.match(expired.text, /Тариф: <b>Free<\/b>/u);
  assert.match(expired.text, /Срок завершён/u); assert.match(expired.text, /Платный доступ: <b>выключен/u);
  const failed = await subscriptionFixture(t); await control(failed, 'failed');
  const failure = await readOwnSubscriptionBotView({ context: (await botContext(failed)).context });
  assert.equal(failure.lifecycleState, 'payment_failed'); assert.equal(failure.paidAccess, true);
  assert.equal(failure.planCode, 'professional'); assert.match(failure.text, /Тариф: <b>Professional<\/b>/u);
  assert.match(failure.text, /Оплаченный остаток действует/u); assert.deepEqual(calls, []);
});

test('short own history and finite receipt show safe fields, exclude foreign operations, and cannot accept fabricated authority', async t => {
  const calls = noProvider(t), f = await subscriptionFixture(t), before = money(f);
  const history = await readOwnSubscriptionBotView({ context: (await botContext(f, 'history')).context, view: 'history' });
  assert.match(history.text, /249 ⭐|Оплата учтена/u);
  assert.ok(history.keyboard.flat().some(button => button.callback_data === 'sub143:receipt:0'));
  const receiptView = await readOwnSubscriptionBotView({ context: (await botContext(f, 'receipt:0')).context, view: 'receipt:0' });
  assert.match(receiptView.text, /Квитанция|Оплаченный период|Номер квитанции/u);
  const payment = f.sqlite.prepare("SELECT * FROM payment_ledger WHERE entry_type='payment'").get();
  for (const sensitive of [f.payload, f.orderId, f.contractId, payment.ledger_entry_id, payment.telegram_payment_charge_id])
    assert.ok(!receiptView.text.includes(sensitive), 'safe receipt omits private financial/provider identifiers');
  const foreign = await readOwnSubscriptionBotView({ context: (await botContext(f, 'history', 202)).context, view: 'history' });
  assert.match(foreign.text, /Учтённых оплат пока нет/u); assert.doesNotMatch(foreign.text, /249/u);
  const unavailable = await readOwnSubscriptionBotView({ context: (await botContext(f, 'receipt:4')).context, view: 'receipt:4' });
  assert.match(unavailable.text, /сейчас недоступна/u);
  await assert.rejects(readOwnSubscriptionBotView({ context: { trusted: true, telegramId: 101 } }), { code: 'untrusted_context' });
  await assert.rejects(renderOwnSubscriptionBotView({ authorization: { allowed: true, lifecycle: { state: 'active' } } }),
    { code: 'untrusted_runtime_authorization' });
  assert.deepEqual(money(f), before); assert.deepEqual(calls, []);
});

test('recurring management and opt-in views navigate to the actual own cabinet without provider commands or paid writes', async t => {
  const calls = noProvider(t), f = await subscriptionFixture(t), before = money(f);
  for (const viewName of ['status', 'cancel', 'enable', 'optin']) {
    const view = await readOwnSubscriptionBotView({ context: (await botContext(f, viewName)).context, view: viewName });
    const button = view.keyboard.flat().find(item => item.web_app);
    assert.equal(button.web_app.url, f.serverEnv.MINI_APP_ORIGIN + '/v1.4.0/cabinet/#subscription');
    assert.equal(Object.keys(button).join(','), 'text,web_app');
    assert.equal(view.paidUntil, f.paidUntil); assert.equal(view.paidAccess, true);
  }
  for (const selector of SUBSCRIPTION_BOT_CALLBACKS) {
    assert.equal(subscriptionBotViewForCallback(selector), selector.slice('sub143:'.length));
    assert.ok(Buffer.byteLength(selector) <= 64);
  }
  for (const invalid of ['sub143:receipt:5', 'sub143:status:202', 'sub143:confirm', 'sub143:cancel:foreign'])
    assert.equal(subscriptionBotViewForCallback(invalid), null);
  await assert.rejects(readOwnSubscriptionBotView({ context: (await botContext(f)).context, view: ['receipt:0'] }),
    { code: 'subscription_bot_view_invalid' });
  await assert.rejects(readOwnSubscriptionBotView({ context: await f.context(101, 'access.read_own') }),
    { code: 'subscription_bot_context_required' });
  assert.deepEqual(money(f), before); assert.deepEqual(calls, []);
});

test('genuine prepaid bot status keeps manual renewal and safe receipts distinct from another user recurring contract', async t => {
  const calls = noProvider(t), f = await subscriptionFixture(t, { paid: false });
  await prepaidPayment(f); const before = money(f);
  const view = await readOwnSubscriptionBotView({ context: (await botContext(f, 'status', 202)).context });
  assert.equal(view.lifecycleState, 'active'); assert.equal(view.paidAccess, true);
  assert.equal(view.planCode, 'professional'); assert.match(view.text, /Тариф: <b>Professional<\/b>/u);
  assert.match(view.text, /Вручную, без автосписания/u); assert.doesNotMatch(view.text, /Автопродление подтверждено|Дата следующего списания/u);
  assert.ok(!view.keyboard.flat().some(button => button.callback_data === 'sub143:cancel'));
  const receiptView = await readOwnSubscriptionBotView({ context: (await botContext(f, 'receipt:0', 202)).context, view: 'receipt:0' });
  assert.match(receiptView.text, /Разовая предоплата/u); assert.equal(receiptView.paidAccess, true);
  assert.deepEqual(money(f), before); assert.deepEqual(calls, []);
});

test('refunded prepaid status presents current Free access while historical Professional remains in history and receipt', async t => {
  const calls = noProvider(t), f = await subscriptionFixture(t, { paid: false });
  await prepaidPayment(f);
  const payment = f.sqlite.prepare("SELECT * FROM payment_ledger WHERE telegram_id=202 AND entry_type='payment'").get();
  const compensated = await applyStarsCompensation(f.serverEnv, {
    telegramPaymentChargeId: payment.telegram_payment_charge_id, compensationType: 'refund',
    telegramUpdateId: ++nextUpdate, occurredAt: f.now,
  });
  assert.equal(compensated.status, 'applied');
  const before = money(f), { context } = await botContext(f, 'status', 202);
  const shared = await readSubscriptionData({ authorization: await createRuntimeAuthorizer().authorize(context, null) });
  assert.equal(shared.access.current.status, 'verified'); assert.equal(shared.access.current.planCode, 'free');
  assert.equal(shared.lifecycle.planCode, 'professional'); assert.equal(shared.lifecycle.state, 'refunded');
  const view = await readOwnSubscriptionBotView({ context });
  assert.equal(view.planCode, shared.access.current.planCode); assert.equal(view.paidAccess, false);
  assert.equal(view.lifecycleState, 'refunded'); assert.equal(view.paidUntil, shared.lifecycle.paidUntil);
  assert.match(view.text, /Тариф: <b>Free<\/b>/u); assert.match(view.text, /Возврат учтён/u);
  assert.match(view.text, /Платный доступ: <b>выключен<\/b>/u);
  assert.match(view.text, /Вручную, без автосписания/u);
  const history = await readOwnSubscriptionBotView({ context: (await botContext(f, 'history', 202)).context, view: 'history' });
  assert.match(history.text, /Professional · 249 ⭐/u); assert.match(history.text, /Возврат учтён/u);
  const receipt = await readOwnSubscriptionBotView({ context: (await botContext(f, 'receipt:0', 202)).context, view: 'receipt:0' });
  assert.match(receipt.text, /Тариф: <b>Professional<\/b>/u); assert.match(receipt.text, /Возврат учтён/u);
  assert.equal(receipt.planCode, 'free'); assert.equal(receipt.paidAccess, false);
  assert.deepEqual(money(f), before); assert.deepEqual(calls, []);
});

test('current tariff keeps Dragon Preview and canonical owner access separate from a paid plan', async t => {
  const calls = noProvider(t), f = await subscriptionFixture(t, { paid: false });
  f.serverEnv = { ...f.serverEnv, DRAGON_PREVIEW_ENABLED: 'true' };
  const start = f.now - 5, end = start + 604800, source = 'dragon_preview:v1.3.5-hotfix.1';
  const time = seconds => new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
  f.sqlite.prepare("INSERT INTO user_plans(telegram_id,plan_code,source_code,effective_from) VALUES(101,'free',?,?)")
    .run(source, time(start));
  f.sqlite.prepare("INSERT INTO user_access_states(telegram_id,access_state,source_code,state_started_at,state_ends_at) VALUES(101,'trial',?,?,?)")
    .run(source, time(start), time(end));
  f.sqlite.prepare(`INSERT INTO trial_grants(grant_id,telegram_id,subject_fingerprint,program_code,source_code,
    status,started_at,ends_at,retention_until,workflow_instance_id,workflow_state,granted_at,updated_at)
    VALUES(?,101,?,'dragon_preview',?,'active',?,?,?,?,'started',?,?)`)
    .run(crypto.randomUUID(), 'c'.repeat(64), source, start, end, end + 86400, crypto.randomUUID(), start, start);
  f.sqlite.prepare("UPDATE user_access SET access_tier='trial',trial_used=1,trial_started_at=?,trial_ends_at=? WHERE telegram_id=101")
    .run(time(start), time(end));
  const before = money(f), previewContext = (await botContext(f)).context;
  const previewData = await readSubscriptionData({ authorization: await createRuntimeAuthorizer().authorize(previewContext, null) });
  assert.equal(previewData.access.current.previewActive, true);
  const preview = await readOwnSubscriptionBotView({ context: previewContext });
  assert.equal(preview.planCode, 'free'); assert.equal(preview.paidAccess, false);
  assert.match(preview.text, /Тариф: <b>Free<\/b>/u); assert.match(preview.text, /Dragon Preview действует отдельно/u);
  const ownerContext = (await botContext(f, 'status', 900)).context;
  const ownerData = await readSubscriptionData({ authorization: await createRuntimeAuthorizer().authorize(ownerContext, null) });
  assert.equal(ownerData.access.ownerException.applies, true); assert.equal(ownerData.access.ownerException.isPaidPlan, false);
  const owner = await readOwnSubscriptionBotView({ context: ownerContext });
  assert.equal(owner.planCode, ownerData.access.current.planCode); assert.equal(owner.planCode, 'free');
  assert.equal(owner.paidAccess, false); assert.match(owner.text, /Тариф: <b>Free<\/b>/u);
  assert.doesNotMatch(owner.text, /Dragon Preview действует отдельно/u);
  assert.deepEqual(money(f), before); assert.deepEqual(calls, []);
});
