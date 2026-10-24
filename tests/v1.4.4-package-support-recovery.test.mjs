import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cabinetSubscriptionFixture, next, MONTH, TERMS_REVISION } from './helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import { authoritySeconds } from '../src/v1.4.1/authority-resolver.mjs';
import { signedInitData } from './helpers/v1.4.1-fixtures.mjs';
import { createCabinetHttp } from '../src/v1.4.0-rebuild/cabinet-http.mjs';
import { createCustomerContext, createFinancialCustomerContext, createServiceExecutor } from '../src/v1.4.1/trusted-context.mjs';
import { createRuntimeAuthorizer } from '../src/v1.4.1/runtime-authorizer.mjs';
import { acceptStarsPurchaseTerms, issueStarsInvoice, handleStarsPreCheckoutQuery, recordStarsSuccessfulPayment } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsPaidAccess } from '../src/v1.3.6/stars-access-runtime.mjs';
import { issueStarsRecurringInvoice, requestOwnStarsSubscriptionCommand } from '../src/v1.4.3/telegram-subscription-provider.mjs';
import { authorizeOwnStarsSubscriptionCommand } from '../src/v1.4.3/subscription-action-authority.mjs';
import { handleVerifiedTelegramSubscriptionUpdate } from '../src/v1.4.3/provider-subscription-events.mjs';
import { executePackageCommerceCommand, handlePackageCommerceRequest } from '../src/v1.4.4/package-commerce-runtime.mjs';
import { executeMonthlyTransitionCommand } from '../src/v1.4.4/monthly-transition-runtime.mjs';
import { requestOwnPackageRefund } from '../src/v1.4.4/package-settlement-runtime.mjs';
import { readOwnPackageSupportRecovery, packageSupportRecoveryMessage } from '../src/v1.4.4/package-support-recovery.mjs';
import { installV141WorkerRuntime, V141_WORKER_RUNTIME_KEY } from '../src/v1.4.1/worker-runtime.mjs';
import worker from '../re-program-bot-worker.js';

const stamp = seconds => new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
async function fixture(t) {
  const f = cabinetSubscriptionFixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: f.now * 1000 });
  f.sqlite.function('current_timestamp', { deterministic: false }, () => stamp(f.now));
  f.sqlite.function('unixepoch', { deterministic: false, varargs: true }, (...args) =>
    !args.length || args[0] === 'now' ? f.now : authoritySeconds(args[0]));
  for (const name of ['0069-v1.4.3-d1-compatibility.sql', '0070-v1.4.3-refund-notification.sql',
    '0071-v1.4.3-refund-contract-retirement.sql', '0072-v1.4.4-package-contract.sql', '0073-v1.4.4-package-payment-review.sql'])
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  f.serverEnv = { ...f.serverEnv, WEBHOOK_SECRET: 'offline-package-support-transport-secret',
    STARS_PACKAGES_ENABLED: 'true', STARS_PACKAGE_3M_ENABLED: 'true' };
  f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(900,'free','system_default')").run();
  f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(900,'none','system_default')").run();
  await f.session(900);
  f.context = payload => createCustomerContext({ binding: f.binding, env: f.serverEnv, sessionToken: f.tokens.get(900),
    channel: 'mini_app', operation: 'access.read_own', nowSeconds: f.now, requestPayload: payload, idempotencyKey: 'support-context-' + next() });
  f.authOwn = async () => createRuntimeAuthorizer().authorize(await f.context({}));
  f.report = async () => readOwnPackageSupportRecovery({ authorization: await f.authOwn() });
  f.move = async at => {
    f.now = at; t.mock.timers.setTime(at * 1000);
    const http = createCabinetHttp({ repositoryFactory: f.repositoryFactory, clock: () => f.now }),
      env = { ...f.serverEnv, REBUILD_V140_OWNER_WINDOW: `true:${f.now - 1}:${f.now + 600}` };
    const response = await http(new Request('https://cabinet.example/api/v1.4.0/cabinet/session', { method: 'POST', headers: {
      Origin: 'https://cabinet.example', 'Content-Type': 'application/json', 'Idempotency-Key': 'support-login-' + next(), 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ initData: signedInitData(900, f.now) }) }), env);
    const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); f.tokens.set(900, data.sessionToken);
  };
  f.payment = order => ({ update_id: next(), message: { message_id: next(), date: f.now,
    from: { id: 900, is_bot: false }, chat: { id: 900, type: 'private' }, successful_payment: {
      currency: 'XTR', total_amount: order.amount_stars, invoice_payload: order.invoice_payload,
      telegram_payment_charge_id: 'offline-support-charge-' + next(), provider_payment_charge_id: '',
      ...(order.billing_mode === 'recurring' ? { is_recurring: true, is_first_recurring: true, subscription_expiration_date: f.now + MONTH } : {}) } } });
  f.financial = async update => {
    const claim = crypto.randomUUID();
    f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,received_at,lease_expires_at)
      VALUES(?,'unsupported',900,'processing',?,?,?)`).run(update.update_id, claim, f.now, f.now + 60);
    return createFinancialCustomerContext({ binding: f.binding, env: f.serverEnv, receiptClaimToken: claim, nowSeconds: f.now,
      webhookRequest: new Request(f.serverEnv.MINI_APP_ORIGIN + '/webhook', { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': f.serverEnv.WEBHOOK_SECRET }, body: JSON.stringify(update) }) });
  };
  f.control = async (order, state = 'canceled') => {
    const update = { update_id: next(), subscription: { user: { id: 900, is_bot: false }, invoice_payload: order.invoice_payload, state } },
      claim = crypto.randomUUID();
    f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,received_at,lease_expires_at)
      VALUES(?,'unsupported',900,'processing',?,?,?)`).run(update.update_id, claim, f.now, f.now + 60);
    const serviceContext = await createServiceExecutor({ binding: f.binding, env: f.serverEnv,
      purpose: 'stars_process_event', clockSeconds: () => f.now }).createContext();
    const result = await handleVerifiedTelegramSubscriptionUpdate({ serviceContext, receiptClaimToken: claim,
      webhookRequest: new Request('https://worker.example/webhook', { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': f.serverEnv.WEBHOOK_SECRET }, body: JSON.stringify(update) }) });
    return { result, update };
  };
  f.seedPaid = async (recurring = false) => {
    let invoice;
    if (recurring) {
      const context = await createCustomerContext({ binding: f.binding, env: f.serverEnv, sessionToken: f.tokens.get(900),
        channel: 'mini_app', operation: 'billing.purchase_monthly', nowSeconds: f.now, requestPayload: {
          action: 'accept', requestedPlanCode: 'professional', billingMode: 'recurring', recurringConsent: true,
          termsRevision: TERMS_REVISION, priceVersion: 1 }, idempotencyKey: 'support-recurring-' + next() });
      invoice = await issueStarsRecurringInvoice(await createRuntimeAuthorizer().authorize(context), { telegramApi: async () => 'https://t.me/$offlineSupportMonthly' });
    } else {
      await acceptStarsPurchaseTerms(f.serverEnv, { telegramId: 900, telegramUpdateId: next() });
      invoice = await issueStarsInvoice(f.serverEnv, { telegramId: 900, requestedPlanCode: 'professional', telegramUpdateId: next() }, { telegramApi: async () => ({ message_id: next() }) });
    }
    const order = f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(invoice.orderId);
    assert.equal((await handleStarsPreCheckoutQuery(f.serverEnv, { update_id: next(), pre_checkout_query: {
      id: 'support-checkout-' + next(), from: { id: 900, is_bot: false }, currency: 'XTR', total_amount: order.amount_stars,
      invoice_payload: order.invoice_payload } }, { telegramApi: async () => true })).approved, true);
    const update = f.payment(order), paid = await recordStarsSuccessfulPayment(f.serverEnv, update);
    assert.equal((await applyStarsPaidAccess(f.serverEnv, { orderId: paid.orderId })).accessApplied, true);
    return { order, invoice, paid, update, end: f.now + MONTH };
  };
  f.retainedFirstNull = async () => {
    const old = await f.seedPaid();
    const scheduled = await executePackageCommerceCommand(await f.context({ requestedPlanCode: 'dragon', packageCode: '30d' }), 'schedule');
    await f.move(old.end);
    const invoice = await executeMonthlyTransitionCommand(await f.context({ transitionId: scheduled.transition.transitionId,
      expectedRevision: 1, recurringConsent: true, termsRevision: TERMS_REVISION, priceVersion: 1 }),
    { telegramApi: async () => 'https://t.me/$offlineSupportReserved' });
    const order = f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(invoice.orderId);
    await executePackageCommerceCommand(await f.context({ transitionId: scheduled.transition.transitionId, expectedRevision: 1 }), 'cancel');
    const update = f.payment(order), paid = await recordStarsSuccessfulPayment(f.serverEnv, update, { packageFinancialContext: await f.financial(update) });
    assert.equal(paid.status, 'manual_review');
    return { old, scheduled, invoice, order, update, paid };
  };
  return f;
}
const snapshot = f => JSON.stringify(f.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all()
  .map(({ name }) => [name, f.sqlite.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));

test('empty genuine own support report is SELECT-only, private and cannot become payment authority', async t => {
  const f = await fixture(t), before = snapshot(f), auth = await f.authOwn(); f.binding.audit.length = 0;
  const report = await readOwnPackageSupportRecovery({ authorization: auth });
  assert.equal(report.available, true); assert.deepEqual(report.cases, []); assert.equal(report.readonly, true);
  assert.equal(report.providerAuthority, false); assert.equal(report.accessAuthority, false); assert.equal(report.sqlWrites, 0);
  assert.equal(packageSupportRecoveryMessage(report), null); assert.equal(snapshot(f), before);
  assert.ok(f.binding.audit.every(row => row.mode === 'read' && /^\s*SELECT\b/u.test(row.sql)));
  assert.throws(() => packageSupportRecoveryMessage(JSON.parse(JSON.stringify(report))), { code: 'package_recovery_report_untrusted' });
  assert.equal(report.referralQualification.newLongPackageRewardVerified, false);
});

test('actual cancel ACK remains separate from genuine Telegram canceled evidence and does not retire or resend', async t => {
  const f = await fixture(t), paid = await f.seedPaid(true);
  const contract = f.sqlite.prepare('SELECT * FROM subscription_billing_contracts').get();
  const token = await authorizeOwnStarsSubscriptionCommand(await createRuntimeAuthorizer().authorize(await f.context({
    subscriptionAction: 'cancel_renewal', contractId: contract.contract_id, expectedRevision: contract.revision })));
  assert.equal((await requestOwnStarsSubscriptionCommand(token, { telegramApi: async () => true })).cancellationConfirmed, true);
  const before = snapshot(f), report = await f.report(), row = report.cases[0];
  assert.equal(row.kind, 'cancel_ack_only'); assert.equal(row.provider.cancellationObserved, false);
  assert.equal(row.provider.commandAcknowledgements.length, 1); assert.equal(row.provider.commandAcknowledgements[0].providerState, null);
  assert.equal(row.contractId, paid.invoice.contractId); assert.equal(row.orderId, paid.order.order_id);
  assert.equal(row.firstPaymentLedgerEntryId, paid.paid.ledgerEntryId); assert.equal(row.automaticRetirementAllowed, false);
  assert.match(packageSupportRecoveryMessage(report).text, /Подтверждение состояния подписки ещё ожидается/u);
  assert.equal(snapshot(f), before);
  const observed = await f.control(paid.order); const after = snapshot(f), confirmed = await f.report();
  assert.equal(confirmed.cases[0].kind, 'provider_cancellation_observed');
  assert.equal(confirmed.cases[0].provider.controlEvents[0].eventId, observed.result.eventId);
  assert.equal(confirmed.cases[0].provider.controlEvents[0].updateId, observed.update.update_id);
  assert.equal(confirmed.cases[0].provider.cancellationObserved, true); assert.equal(confirmed.cases[0].newInvoiceAdmitted, false);
  assert.equal(snapshot(f), after); assert.equal(confirmed.cases[0].retiredAt, null);
});

test('retained first-NULL report binds exact monthly charge/transition and preserves all old paid rows and 0071', async t => {
  const f = await fixture(t), retained = await f.retainedFirstNull(), before = snapshot(f), report = await f.report(), row = report.cases[0];
  const charge = row.retainedCharges[0];
  assert.equal(row.kind, 'retained_first_null'); assert.equal(row.compatibleRecoveryRequired, true);
  assert.equal(row.firstPaymentLedgerEntryId, null); assert.equal(charge.ledgerEntryId, retained.paid.ledgerEntryId);
  assert.equal(charge.orderId, retained.order.order_id); assert.equal(charge.contractId, retained.invoice.contractId);
  assert.equal(charge.transitionId, retained.scheduled.transition.transitionId); assert.equal(charge.transitionState, 'cancelled');
  assert.equal(charge.telegramPaymentChargeId, retained.update.message.successful_payment.telegram_payment_charge_id);
  assert.equal(charge.amountStars, 499); assert.equal(charge.firstRecurringObserved, true);
  assert.equal(charge.fullRefundAccounted, false); assert.equal(charge.providerRefundConfirmed, false);
  assert.equal(row.newInvoiceAdmitted, false); assert.equal(row.automaticRetirementAllowed, false);
  assert.equal(snapshot(f), before); assert.match(packageSupportRecoveryMessage(report).text, /Возврат Stars сам по себе не отменяет/u);
  assert.doesNotMatch(packageSupportRecoveryMessage(report).text, new RegExp(charge.telegramPaymentChargeId));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM subscription_first_recurring_receipts').get().n, 0);
  assert.throws(() => f.sqlite.prepare(`UPDATE subscription_billing_contracts SET retired_at=?,revision=revision+1,updated_at=? WHERE contract_id=?`)
    .run(f.now, f.now, retained.invoice.contractId), /v143_contract_update_invalid/u);
});

test('exact full retained refund plus authenticated canceled observation still cannot fabricate first receipt or release 0071', async t => {
  const f = await fixture(t), retained = await f.retainedFirstNull();
  f.serverEnv = { ...f.serverEnv, STARS_REFUNDS_ENABLED: 'false', STARS_PACKAGE_REFUNDS_ENABLED: 'true' };
  const payload = { ledgerEntryId: retained.paid.ledgerEntryId }, context = await createCustomerContext({ binding: f.binding,
    env: f.serverEnv, sessionToken: f.tokens.get(900), channel: 'mini_app', operation: 'admin.stars.refund',
    nowSeconds: f.now, requestPayload: payload, idempotencyKey: 'support-retained-refund-' + next() });
  const calls = [];
  assert.equal((await requestOwnPackageRefund(context, payload, { telegramApi: async (_env, method, request) => { calls.push({ method, request }); return true; } })).refunded, true);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'refundStarPayment');
  const control = await f.control(retained.order), before = snapshot(f), report = await f.report(), row = report.cases[0], charge = row.retainedCharges[0];
  assert.equal(row.kind, 'retained_first_null'); assert.equal(row.firstPaymentLedgerEntryId, null);
  assert.equal(row.provider.cancellationObserved, true); assert.equal(row.provider.controlEvents[0].eventId, control.result.eventId);
  assert.equal(charge.fullRefundAccounted, true); assert.equal(charge.providerRefundConfirmed, true); assert.ok(charge.refundId);
  assert.equal(row.nextStep, 'compatible_reviewed_recovery_required_0071'); assert.equal(row.automaticRetirementAllowed, false);
  assert.equal(row.newInvoiceAdmitted, false); assert.equal(row.retiredAt, null); assert.equal(snapshot(f), before);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM subscription_first_recurring_receipts').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM subscription_provider_commands').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM subscription_access_grants').get().n, 1);
});

test('raw/copy/foreign-subject/boolean evidence and wrong operation cannot request support authority', async t => {
  const f = await fixture(t), owner = await f.authOwn();
  await assert.rejects(() => readOwnPackageSupportRecovery({ authorization: {} }), { code: 'untrusted_runtime_authorization' });
  await assert.rejects(() => readOwnPackageSupportRecovery({ authorization: owner, telegramId: 101 }), { code: 'package_recovery_scope_invalid' });
  await assert.rejects(() => readOwnPackageSupportRecovery({ authorization: owner, providerConfirmed: true }), { code: 'package_recovery_scope_invalid' });
  await assert.rejects(async () => readOwnPackageSupportRecovery({ authorization: await f.auth({ id: 101 }) }), { code: 'package_recovery_owner_authority_required' });
  await assert.rejects(async () => readOwnPackageSupportRecovery({ authorization: await f.auth({ id: 900, operation: 'profile.read_own' }) }), { code: 'package_recovery_owner_authority_required' });
});

test('conflicting genuine controls remain review with all original event identities retained', async t => {
  const f = await fixture(t), paid = await f.seedPaid(true), canceled = await f.control(paid.order), active = await f.control(paid.order, 'active'), before = snapshot(f);
  const row = (await f.report()).cases[0]; assert.equal(row.kind, 'provider_evidence_conflict');
  assert.equal(row.provider.cancellationObserved, false); assert.equal(row.provider.conflicted, true);
  assert.deepEqual(new Set(row.provider.controlEvents.map(event => event.eventId)), new Set([canceled.result.eventId, active.result.eventId]));
  assert.equal(row.newInvoiceAdmitted, false); assert.equal(snapshot(f), before);
});

test('original sources changing during final support read are rejected without a mutation or stale handoff', async t => {
  const f = await fixture(t), paid = await f.seedPaid(true), auth = await f.authOwn(), original = f.binding.batch.bind(f.binding);
  let changed = false;
  f.binding.batch = async statements => {
    if (!changed && statements.some(row => row.sql.includes('THEN 1 ELSE 0 END AS allowed'))) {
      changed = true; await f.control(paid.order);
    }
    return original(statements);
  };
  await assert.rejects(() => readOwnPackageSupportRecovery({ authorization: auth }), { code: 'package_recovery_stale' });
  assert.equal(changed, true); assert.equal(f.sqlite.prepare('SELECT retired_at FROM subscription_billing_contracts').get().retired_at, null);
});

test('damaged 0071 guard or unknown schema cannot be hidden by a support report', async t => {
  const f = await fixture(t); f.sqlite.exec('DROP TRIGGER v143_contract_update_binding');
  await assert.rejects(() => f.report(), error => ['v143_schema_not_ready', 'package_recovery_owner_authority_required'].includes(error.code));
});

async function closedCabinet(f) {
  const candidate = 'a'.repeat(40), revision = 47;
  f.sqlite.prepare("INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,updated_at) VALUES(1,?,?,'closed',0,?)")
    .run(candidate, revision, f.now);
  const env = { ...f.serverEnv, V141_AUTHORIZATION_ENABLED: 'true', REBUILD_V140_ADMIN_ACCESS_ENABLED: 'true',
    REBUILD_V140_RELEASE_LEASE_REQUIRED: 'true', REBUILD_V140_OWNER_WINDOW: 'false',
    REBUILD_V140_RC_SHA: candidate, REBUILD_V140_RELEASE_REVISION: String(revision),
    STARS_PACKAGES_ENABLED: 'false', STARS_PACKAGE_3M_ENABLED: 'false', STARS_RECURRING_ENABLED: 'false' };
  const opened = await f.call(900, 'session', { method: 'POST', token: null, payload: { initData: signedInitData(900, f.now) }, customEnv: env });
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  return { env, token: opened.data.sessionToken, scope: { candidateSha: candidate, revision } };
}
const request = (token, suffix = '', method = 'GET') => new Request('https://cabinet.example/api/v1.4.0/cabinet/packages/recovery' + suffix,
  { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
    ...(method === 'POST' ? { Origin: 'https://cabinet.example', 'Content-Type': 'application/json', 'Idempotency-Key': 'invalid-recovery-' + next() } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify({ providerConfirmed: true, telegramId: 101 }) } : {}) });

test('actual authenticated owner recovery GET remains available with all new producers disabled and commits no money or control writes', async t => {
  const f = await fixture(t), paid = await f.seedPaid(true), closed = await closedCabinet(f), before = snapshot(f);
  f.binding.audit.length = 0;
  const response = await handlePackageCommerceRequest(request(closed.token), closed.env,
    { telegramApi: async () => assert.fail('readonly recovery called provider') });
  assert.equal(response.status, 200, await response.clone().text()); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const report = await response.json(); assert.equal(report.available, true); assert.equal(report.cases[0].contractId, paid.invoice.contractId);
  assert.equal(report.cases[0].kind, 'provider_state_unresolved'); assert.equal(report.providerAuthority, false);
  assert.equal(report.providerCalls, 0); assert.equal(report.sqlWrites, 0); assert.equal(report.cases[0].newInvoiceAdmitted, false);
  assert.equal(report.cases[0].providerCallsAllowed, false); assert.equal(snapshot(f), before);
  assert.ok(f.binding.audit.every(row => row.mode === 'read' && /^\s*SELECT\b/u.test(row.sql)));
  assert.throws(() => packageSupportRecoveryMessage(report), { code: 'package_recovery_report_untrusted' });
});

test('actual recovery HTTP ignores no client subject/evidence and rejects missing or wrong session without returning private identities', async t => {
  const f = await fixture(t); await f.seedPaid(true); const closed = await closedCabinet(f), before = snapshot(f);
  for (const [token, suffix, method] of [[closed.token, '?telegramId=101', 'GET'], [closed.token, '?providerConfirmed=true', 'GET'],
    [closed.token, '', 'POST'], [null, '', 'GET'], ['invented-session', '', 'GET']]) {
    const response = await handlePackageCommerceRequest(request(token, suffix, method), closed.env);
    assert.ok(response.status >= 400 && response.status < 500); const body = await response.json();
    assert.equal(Object.hasOwn(body, 'cases'), false); assert.doesNotMatch(JSON.stringify(body), /contractId|telegramPaymentChargeId/u);
  }
  assert.equal(snapshot(f), before);
  const context = await f.context({ providerConfirmed: true });
  await assert.rejects(() => executePackageCommerceCommand(context, 'recovery'), { code: 'package_request_invalid' });
});

test('actual recovery HTTP fails closed for changed exact package schema rather than disabling recovery checks with producer flags', async t => {
  const f = await fixture(t), closed = await closedCabinet(f); f.sqlite.exec('DROP TRIGGER v144_package_order_no_delete');
  const savedError = console.error; console.error = () => {};
  try {
    const response = await handlePackageCommerceRequest(request(closed.token), closed.env);
    assert.ok([403, 503].includes(response.status), await response.clone().text());
    const body = await response.json(); assert.equal(Object.hasOwn(body, 'cases'), false);
    assert.ok(['package_recovery_owner_authority_required', 'package_unavailable'].includes(body.error));
  } finally { console.error = savedError; }
});

const financialSnapshot = f => JSON.stringify(f.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name LIKE 'subscription_%' OR name LIKE 'referral_%' OR name='user_paid_periods') ORDER BY name").all()
  .map(({ name }) => [name, f.sqlite.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
function supportTransport(t, f) {
  const savedRuntime = globalThis[V141_WORKER_RUNTIME_KEY], savedFetch = globalThis.fetch, savedError = console.error;
  const calls = [], errors = []; installV141WorkerRuntime();
  console.error = (...items) => errors.push(items);
  globalThis.fetch = async (url, options) => {
    const target = new URL(url); assert.equal(target.hostname, 'api.telegram.org');
    const method = target.pathname.split('/').at(-1); assert.equal(method, 'sendMessage', 'support has no payment or control provider effects');
    const payload = JSON.parse(options.body); calls.push({ method, payload });
    return Response.json({ ok: true, result: { message_id: next() } });
  };
  t.after(() => { globalThis[V141_WORKER_RUNTIME_KEY] = savedRuntime; globalThis.fetch = savedFetch; console.error = savedError; });
  const env = { ...f.serverEnv, V141_AUTHORIZATION_ENABLED: 'true', STARS_PACKAGES_ENABLED: 'false', STARS_PACKAGE_3M_ENABLED: 'false', STARS_RECURRING_ENABLED: 'false' };
  const invoke = async (id, command = '/paysupport', patch = {}, secret = env.WEBHOOK_SECRET) => {
    const pending = [], updateId = next(), update = { update_id: updateId, message: { message_id: next(), date: f.now,
      from: { id, is_bot: false }, chat: { id, type: 'private' }, text: command } };
    const response = await worker.fetch(new Request('https://cabinet.example/webhook', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update) }),
      { ...env, ...patch }, { waitUntil: promise => pending.push(promise) });
    await Promise.all(pending); return response;
  };
  return { calls, errors, env, invoke };
}

test('actual main webhook /paysupport appends only authenticated own safe recovery code and preserves payment history', async t => {
  const f = await fixture(t), retained = await f.retainedFirstNull(), transport = supportTransport(t, f), before = financialSnapshot(f);
  const response = await transport.invoke(900);
  assert.equal(response.status, 200); assert.equal(transport.calls.length, 1, JSON.stringify(transport.errors));
  const message = transport.calls[0].payload;
  assert.equal(message.chat_id, 900); assert.match(message.text, /Поддержка по оплате/u);
  assert.match(message.text, /Платёж сохранён для разбора/u); assert.match(message.text, /Код обращения: <code>recovery-[a-f0-9]{24}<\/code>/u);
  assert.match(message.text, /Telegram ID, профиль, тариф, реферальная ссылка/u);
  assert.equal(message.reply_markup.inline_keyboard[0][0].url, 'https://t.me/RE_Program_Support_Bot?start=paysupport');
  for (const secret of [retained.order.order_id, retained.invoice.contractId, retained.scheduled.transition.transitionId,
    retained.update.message.successful_payment.telegram_payment_charge_id]) assert.equal(message.text.includes(secret), false);
  assert.equal(financialSnapshot(f), before);
  assert.equal(f.sqlite.prepare('SELECT status FROM telegram_update_receipts ORDER BY update_id DESC LIMIT 1').get().status, 'completed');
});

test('actual main webhook keeps foreign and ordinary support help private and rejects a forged webhook secret', async t => {
  const f = await fixture(t); await f.retainedFirstNull(); const transport = supportTransport(t, f), before = financialSnapshot(f);
  assert.equal((await transport.invoke(202)).status, 200); assert.equal(transport.calls.length, 1, JSON.stringify(transport.errors));
  const foreign = transport.calls[0].payload;
  assert.equal(foreign.chat_id, 202); assert.match(foreign.text, /Поддержка по оплате/u);
  assert.doesNotMatch(foreign.text, /recovery-|Платёж сохранён для разбора|contractId|telegramPaymentChargeId/u);
  assert.equal((await transport.invoke(900, '/support')).status, 200); assert.equal(transport.calls.length, 2);
  const ordinary = transport.calls[1].payload;
  assert.match(ordinary.text, /Официальная поддержка/u); assert.doesNotMatch(ordinary.text, /recovery-/u);
  assert.equal(ordinary.reply_markup.inline_keyboard[0][0].url, 'https://t.me/RE_Program_Support_Bot?start=main_bot');
  const auditLength = f.binding.audit.length;
  assert.equal((await transport.invoke(900, '/paysupport', {}, 'forged-secret')).status, 404);
  assert.equal(transport.calls.length, 2); assert.equal(f.binding.audit.length, auditLength); assert.equal(financialSnapshot(f), before);
});

test('actual main webhook emergency /paysupport preserves existing help without manufacturing a scoped recovery context', async t => {
  const f = await fixture(t); await f.retainedFirstNull(); const transport = supportTransport(t, f), before = financialSnapshot(f);
  const unavailableBinding = { prepare() { throw new Error('offline support database unavailable'); } };
  const response = await transport.invoke(900, '/paysupport', { DB: unavailableBinding });
  assert.equal(response.status, 200); assert.equal(transport.calls.length, 1);
  const message = transport.calls[0].payload;
  assert.equal(message.chat_id, 900); assert.match(message.text, /Официальный адрес/u);
  assert.doesNotMatch(message.text, /recovery-|offline support database|contractId|telegramPaymentChargeId/u);
  assert.equal(message.reply_markup.inline_keyboard[0][0].url, 'https://t.me/RE_Program_Support_Bot?start=paysupport');
  assert.equal(financialSnapshot(f), before);
});
