import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foundationFixture, signedInitData } from './helpers/v1.4.1-fixtures.mjs';
import { ORIGIN } from './helpers/v1.4.0-rebuild-sqlite.mjs';
import { createCabinetHttp, CABINET_API_PREFIX } from '../src/v1.4.0-rebuild/cabinet-http.mjs';
import { STARS_RECURRING_TERMS_REVISION as TERMS } from '../src/v1.4.3/recurring-provider-config.mjs';
import { acceptStarsPurchaseTerms, handleStarsPreCheckoutQuery,
  recordStarsSuccessfulPayment } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { buildStarsInvoicePayload } from '../src/v1.3.6/stars-core-foundation.mjs';
import { applyStarsPaidAccess } from '../src/v1.3.6/stars-access-runtime.mjs';

const MONTH = 2_592_000;
let sequence = 1_433_000;
const next = () => ++sequence;
const invoiceBody = () => ({ planCode: 'dragon', recurringConsent: true, termsRevision: TERMS, priceVersion: 1 });
const count = (f, table) => f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const orderFor = (f, id) => f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(id);
const grantFor = (f, id) => f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(id);
const snapshot = (f, tables) => JSON.stringify(tables.map(table => [table,
  f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const cashTables = ['payment_ledger', 'subscriptions', 'subscription_access_grants', 'user_plans', 'user_access_states', 'user_access'];
const intentTables = ['subscription_orders', 'subscription_billing_contracts', 'subscription_invoice_requests',
  'subscription_provider_events', 'subscription_provider_commands', 'terms_acceptances', ...cashTables];

function fixture(t, nativeProviderFetch) {
  const f = foundationFixture(t);
  for (const name of ['0065-v1.4.1-privacy-ai-journal.sql', '0026-v1.3.6-stars-core-foundation.sql',
    '0027-v1.3.6-stars-access-and-reconciliation.sql', '0066-v1.4.3-subscription-lifecycle-foundation.sql',
    '0067-v1.4.3-lifecycle-engine-binding.sql', '0068-v1.4.3-provider-and-review-binding.sql']) {
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  const candidate = 'a'.repeat(40), issued = f.now - 1, expires = f.now + 600;
  f.sqlite.prepare(`INSERT INTO mini_app_release_control
    (id,candidate_sha,revision,state,beta_enabled,owner_telegram_id,issued_at,expires_at,updated_at)
    VALUES(1,?,1,'open',1,101,?,?,?) ON CONFLICT(id) DO UPDATE SET
      candidate_sha=excluded.candidate_sha,revision=1,state='open',beta_enabled=1,
      owner_telegram_id=101,issued_at=excluded.issued_at,expires_at=excluded.expires_at,
      updated_at=excluded.updated_at`).run(candidate, issued, expires, f.now);
  f.serverEnv = { ...f.serverEnv, V141_AUTHORIZATION_ENABLED: 'true', V141_ADMIN_MINI_APP_ENABLED: 'true',
    REBUILD_V140_ADMIN_ACCESS_ENABLED: 'true', REBUILD_V140_RELEASE_LEASE_REQUIRED: 'true',
    REBUILD_V140_RC_SHA: candidate, REBUILD_V140_RELEASE_REVISION: '1',
    REBUILD_V140_OWNER_TELEGRAM_ID: '101', REBUILD_V140_OWNER_WINDOW: `true:${issued}:${expires}`,
    STARS_PAYMENTS_ENABLED: 'true', STARS_BILLING_MODE: 'prepaid', STARS_PRICE_VERSION: '1',
    STARS_TERMS_REVISION: '2026-09-10.stars-v1', STARS_ROLLOUT_MODE: 'allowlist', STARS_ROLLOUT_ALLOWLIST: '101',
    STARS_RECURRING_ENABLED: 'true', STARS_RECURRING_PRICE_VERSION: '1', STARS_RECURRING_TERMS_REVISION: TERMS,
    STARS_REFUNDS_ENABLED: 'true',
    STARS_INVOICE_SECRET: 'offline-v143-http-routing-invoice-secret-more-than-thirty-two-characters' };
  for (const id of [101, 202, 303, 404, 900]) {
    f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(id);
    f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(id);
  }
  // foundationFixture selects the real reviewedRepositoryFactory for its exact accepted schema.
  f.http = createCabinetHttp({ repositoryFactory: f.repositoryFactory, clock: () => f.now, nativeProviderFetch });
  f.restart = () => { f.http = createCabinetHttp({ repositoryFactory: f.repositoryFactory, clock: () => f.now, nativeProviderFetch }); };
  f.request = async (path, { token, method = 'GET', body, key = 'v143_http_request_' + next(),
    headers = {}, env = f.serverEnv } = {}) => {
    // The native financial producers use the actual server clock. Keep the HTTP
    // context in that same epoch when the exact-schema fixture spans a second.
    f.now = Math.max(f.now, Math.floor(Date.now() / 1000));
    const requestHeaders = new Headers(token ? { Authorization: 'Bearer ' + token } : {});
    if (method === 'POST') {
      requestHeaders.set('Origin', ORIGIN);
      requestHeaders.set('Sec-Fetch-Site', 'same-origin');
      requestHeaders.set('Content-Type', 'application/json');
      if (key !== null) requestHeaders.set('Idempotency-Key', key);
    }
    for (const [name, value] of Object.entries(headers)) {
      if (value === null) requestHeaders.delete(name); else requestHeaders.set(name, value);
    }
    const response = await f.http(new Request(ORIGIN + CABINET_API_PREFIX + path, {
      method, headers: requestHeaders, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    }), env);
    return { status: response.status, data: await response.json() };
  };
  f.open = async (id = 101, env = f.serverEnv) => {
    f.now = Math.max(f.now, Math.floor(Date.now() / 1000));
    const result = await f.request('session', { method: 'POST', body: { initData: signedInitData(id, f.now) }, env });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.features.mutationsEnabled, true);
    return result.data.sessionToken;
  };
  return f;
}

function payment(order, expiration, first = true) {
  return { update_id: next(), message: { message_id: next(), from: { id: order.telegram_id, is_bot: false },
    chat: { id: order.telegram_id, type: 'private' }, successful_payment: { currency: 'XTR',
      total_amount: order.amount_stars, invoice_payload: order.invoice_payload,
      telegram_payment_charge_id: 'offline-v143-http-charge-' + next(), provider_payment_charge_id: '',
      is_recurring: true, is_first_recurring: first, subscription_expiration_date: expiration } } };
}
async function approvedCheckout(f, order) {
  const result = await handleStarsPreCheckoutQuery(f.serverEnv, { update_id: next(), pre_checkout_query: {
    id: 'offline-v143-http-checkout-' + next(), from: { id: order.telegram_id, is_bot: false }, currency: 'XTR',
    total_amount: order.amount_stars, invoice_payload: order.invoice_payload } }, { telegramApi: async () => true });
  assert.equal(result.approved, true);
}

test('actual recurring invoice and own renewal routes journal native effects, replay across restart and preserve paid residue', async t => {
  let f, createCalls = 0, cancelCalls = 0, enableCalls = 0;
  f = fixture(t, async (url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(options.method, 'POST');
    if (new URL(url).pathname.endsWith('/createInvoiceLink')) {
      createCalls++;
      assert.equal(payload.currency, 'XTR');
      assert.equal(payload.provider_token, '');
      assert.equal(payload.subscription_period, MONTH);
      assert.deepEqual(payload.prices, [{ label: '30 дней подписки', amount: 499 }]);
      const journal = f.sqlite.prepare('SELECT * FROM subscription_invoice_requests').get();
      assert.equal(journal.state, 'attempted');
      assert.equal(journal.attempted_count, 1);
      assert.equal(count(f, 'payment_ledger'), 0);
      assert.equal(count(f, 'subscription_access_grants'), 0);
      return Response.json({ ok: true, result: 'https://t.me/$offlineHttpInvoice' });
    }
    assert.ok(new URL(url).pathname.endsWith('/editUserStarSubscription'));
    const charge = f.sqlite.prepare('SELECT telegram_payment_charge_id FROM payment_ledger').get().telegram_payment_charge_id;
    assert.deepEqual(payload, { user_id: 101, telegram_payment_charge_id: charge, is_canceled: payload.is_canceled });
    if (payload.is_canceled === true) { cancelCalls++; return Response.json({ ok: true, result: true }); }
    assert.equal(payload.is_canceled, false);
    enableCalls++;
    throw new Error('offline response lost after provider may accept');
  });
  const token = await f.open(), key = 'I'.repeat(16), beforeInvoice = snapshot(f, cashTables);
  const issue = await f.request('subscription/recurring-invoice', { token, method: 'POST', body: invoiceBody(), key });
  assert.equal(issue.status, 200, JSON.stringify(issue.data));
  assert.equal(issue.data.status, 'confirmed');
  assert.equal(issue.data.invoiceUrl, 'https://t.me/$offlineHttpInvoice');
  assert.equal(issue.data.accessApplied, false);
  assert.equal(issue.data.authorization.allowed, true);
  assert.equal(issue.data.authorization.capability, 'billing.purchase_monthly');
  assert.equal(snapshot(f, cashTables), beforeInvoice);
  assert.equal(count(f, 'subscription_invoice_requests'), 1);
  assert.equal(orderFor(f, issue.data.orderId).billing_mode, 'recurring');
  assert.equal(f.sqlite.prepare('SELECT terms_revision FROM terms_acceptances WHERE telegram_id=101').get().terms_revision, TERMS);
  f.restart();
  const freshToken = await f.open();
  const replay = await f.request('subscription/recurring-invoice', { token: freshToken, method: 'POST', body: invoiceBody(), key });
  assert.equal(replay.status, 200, JSON.stringify(replay.data));
  for (const field of ['invoiceUrl', 'orderId', 'contractId', 'requestId']) assert.equal(replay.data[field], issue.data[field]);
  assert.equal(createCalls, 1);
  assert.equal(snapshot(f, cashTables), beforeInvoice);

  const order = orderFor(f, issue.data.orderId);
  await approvedCheckout(f, order);
  const captured = await recordStarsSuccessfulPayment(f.serverEnv, payment(order, f.now + MONTH));
  assert.equal((await applyStarsPaidAccess(f.serverEnv, { orderId: captured.orderId })).accessApplied, true);
  const period = snapshot(f, cashTables), contract = f.sqlite.prepare('SELECT * FROM subscription_billing_contracts').get();
  const commandBody = { contractId: contract.contract_id, expectedRevision: contract.revision };
  const cancelKey = 'C'.repeat(128);
  const cancel = await f.request('subscription/renewal/cancel', { token: freshToken, method: 'POST', body: commandBody, key: cancelKey });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
  assert.equal(cancel.data.cancellationConfirmed, true);
  assert.equal(cancel.data.paidPeriodChanged, false);
  assert.equal(snapshot(f, cashTables), period);
  f.restart();
  const resumed = await f.open();
  const current = await f.request('subscription', { token: resumed });
  assert.equal(current.status, 200, JSON.stringify(current.data));
  assert.equal(current.data.lifecycle.state, 'cancel_at_period_end');
  assert.equal(current.data.lifecycle.paidAccess, true);
  assert.equal(current.data.renewalActions.enable.available, true);
  const cancelReplay = await f.request('subscription/renewal/cancel', { token: resumed, method: 'POST', body: commandBody, key: cancelKey });
  assert.equal(cancelReplay.status, 200, JSON.stringify(cancelReplay.data));
  assert.equal(cancelReplay.data.commandId, cancel.data.commandId);
  assert.equal(cancelCalls, 1);
  const enableKey = 'v143_http_enable_unknown_' + next();
  const enable = await f.request('subscription/renewal/enable', { token: resumed, method: 'POST', body: commandBody, key: enableKey });
  assert.equal(enable.status, 202, JSON.stringify(enable.data));
  assert.equal(enable.data.status, 'unknown');
  assert.equal(enable.data.reenableAllowed, false);
  f.restart();
  const enableReplay = await f.request('subscription/renewal/enable', { token: await f.open(), method: 'POST', body: commandBody, key: enableKey });
  assert.equal(enableReplay.status, 202, JSON.stringify(enableReplay.data));
  assert.equal(enableReplay.data.commandId, enable.data.commandId);
  assert.equal(enableCalls, 1);
  assert.equal(snapshot(f, cashTables), period);
});

test('actual invoice route preserves an unknown native result across a refreshed session without another attempt or access', async t => {
  for (const outcome of ['lost', 'malformed']) {
    let calls = 0;
    const f = fixture(t, async () => {
      calls++;
      if (outcome === 'lost') throw new Error('offline lost native result');
      return new Response('invalid JSON', { status: 200 });
    });
    const before = snapshot(f, cashTables), key = 'v143_http_unknown_' + outcome + '_' + next();
    const result = await f.request('subscription/recurring-invoice', { token: await f.open(), method: 'POST', body: invoiceBody(), key });
    assert.equal(result.status, 202, JSON.stringify(result.data));
    assert.equal(result.data.status, 'unknown');
    assert.equal(result.data.reviewRequired, true);
    assert.equal(result.data.invoiceUrl, null);
    f.restart();
    const replay = await f.request('subscription/recurring-invoice', { token: await f.open(), method: 'POST', body: invoiceBody(), key });
    assert.equal(replay.status, 202, JSON.stringify(replay.data));
    assert.equal(replay.data.requestId, result.data.requestId);
    assert.equal(replay.data.invoiceUrl, null);
    assert.equal(calls, 1);
    assert.equal(f.sqlite.prepare('SELECT state,attempted_count FROM subscription_invoice_requests').get().attempted_count, 1);
    assert.equal(count(f, 'subscription_invoice_requests'), 1);
    assert.equal(snapshot(f, cashTables), before);
  }
});

test('fixed own routes reject hostile transport, selected subjects, absent quote and closed write or recurring gates before a native call', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return Response.json({ ok: true, result: 'https://t.me/$mustNotCall' }); });
  const token = await f.open(), before = snapshot(f, intentTables);
  const missingPrice = invoiceBody(); delete missingPrice.priceVersion;
  const cases = [
    { headers: { Origin: 'https://foreign.example' }, status: 403 },
    { headers: { Origin: null }, status: 403 },
    { key: null, status: 400 },
    { key: 'short', status: 400 },
    { key: 'K'.repeat(129), status: 400 },
    { path: 'subscription/recurring-invoice?telegramId=202', status: 400 },
    { method: 'GET', status: 405 },
    { token: null, status: 401 },
    { body: missingPrice, status: 400 },
    { body: { ...invoiceBody(), telegramId: 202 }, status: 400 },
    { body: { ...invoiceBody(), amountStars: 1 }, status: 400 },
    { body: { ...invoiceBody(), recurringConsent: false }, status: 400 },
    { env: { ...f.serverEnv, REBUILD_V140_WRITES_ENABLED: 'false' }, status: 403 },
    { env: { ...f.serverEnv, STARS_RECURRING_ENABLED: 'false' }, status: 403 },
    { env: { ...f.serverEnv, STARS_ROLLOUT_MODE: 'off' }, status: 403 },
  ];
  for (const item of cases) {
    const { path = 'subscription/recurring-invoice', status, ...patch } = item;
    const result = await f.request(path, { token, method: 'POST', body: invoiceBody(), ...patch });
    assert.equal(result.status, status, JSON.stringify({ path, patch, data: result.data }));
    assert.equal(result.data.invoiceUrl, undefined);
    assert.equal(snapshot(f, intentTables), before);
  }
  for (const path of ['subscription/renewal/cancel', 'subscription/renewal/enable']) {
    assert.equal((await f.request(path, { token })).status, 405);
    assert.equal((await f.request(path + '?contractId=foreign', { token, method: 'POST', body: {} })).status, 400);
    assert.equal((await f.request(path, { token, method: 'POST', body: {},
      env: { ...f.serverEnv, REBUILD_V140_WRITES_ENABLED: 'false' } })).status, 403);
  }
  assert.equal(calls, 0);
  assert.equal(snapshot(f, intentTables), before);
});

test('canonical owner HTTP review reads retained cash and applies then refunds its exact credit once; all review gates remain enforced', async t => {
  let f, invoiceCalls = 0, refundCalls = 0, retainedCharge;
  f = fixture(t, async (url, options) => {
    const payload = JSON.parse(options.body);
    if (new URL(url).pathname.endsWith('/createInvoiceLink')) {
      invoiceCalls++; return Response.json({ ok: true, result: 'https://t.me/$offlineReviewInvoice' });
    }
    assert.ok(new URL(url).pathname.endsWith('/refundStarPayment'));
    assert.deepEqual(payload, { user_id: 101, telegram_payment_charge_id: retainedCharge });
    assert.equal(f.sqlite.prepare('SELECT status FROM payment_refunds').get().status, 'requested');
    refundCalls++; return Response.json({ ok: true, result: true });
  });
  const ownToken = await f.open();
  const invoice = await f.request('subscription/recurring-invoice', { token: ownToken, method: 'POST', body: invoiceBody() });
  assert.equal(invoice.status, 200, JSON.stringify(invoice.data));
  const origin = orderFor(f, invoice.data.orderId);
  await approvedCheckout(f, origin);
  f.now = Math.max(f.now, Math.floor(Date.now() / 1000));
  f.sqlite.prepare("UPDATE subscription_orders SET order_state='cancelled',closed_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=?")
    .run(f.now, f.now, origin.order_id);
  await acceptStarsPurchaseTerms(f.serverEnv, { telegramId: 101, telegramUpdateId: next() });
  // A pre-existing newer prepaid invoice occupies the unchanged public open
  // order slot. Its real server price, consent, signature and SQL guards remain
  // active; the HTTP routes under test never select its amount or subject.
  const newerId = crypto.randomUUID(), price = f.sqlite.prepare("SELECT * FROM price_book WHERE price_id='dragon-30d-prepaid-v1'").get();
  const newerPayload = await buildStarsInvoicePayload({ invoiceSecret: f.serverEnv.STARS_INVOICE_SECRET,
    orderId: newerId, telegramId: 101, priceId: price.price_id });
  f.sqlite.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,currency,
    amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,created_at,expires_at,updated_at)
    VALUES(?,101,?,?,?,?,?,?,?,?,?,?,?,?)`).run(newerId, price.price_id, price.price_version, price.plan_code,
      price.currency, price.amount_stars, price.access_seconds, price.billing_mode, price.terms_revision,
      newerPayload, f.now, f.now + 600, f.now);
  assert.equal(orderFor(f, newerId).order_state, 'created');
  const newerOrder = orderFor(f, newerId);
  f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=101').run();
  const update = payment(origin, f.now + MONTH);
  retainedCharge = update.message.successful_payment.telegram_payment_charge_id;
  const recorded = await recordStarsSuccessfulPayment(f.serverEnv, update, { receivedAt: f.now });
  assert.equal(recorded.status, 'manual_review');
  f.sqlite.prepare('UPDATE users SET is_blocked=0 WHERE telegram_id=101').run();
  assert.equal(count(f, 'payment_ledger'), 1);
  assert.equal(count(f, 'subscription_access_grants'), 0);
  const originalLedger = f.sqlite.prepare('SELECT * FROM payment_ledger').get();
  const originalOrder = orderFor(f, origin.order_id);
  let ownerToken = await f.open(900);
  const beforeRead = snapshot(f, ['payment_ledger', 'subscription_payment_review_receipts',
    'subscription_payment_review_settlements', 'subscription_orders', 'subscriptions', 'subscription_access_grants']);
  const list = await f.request('admin/subscription-review', { token: ownerToken });
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.equal(list.data.authorization.allowed, true);
  assert.equal(list.data.authorization.capability, 'admin.cabinet.open');
  assert.equal(list.data.items.length, 1);
  assert.equal(list.data.items[0].ledgerEntryId, recorded.ledgerEntryId);
  assert.equal(list.data.items[0].status, 'pending_review');
  assert.equal(list.data.items[0].amountStars, 499);
  assert.equal(list.data.items[0].endsAt - list.data.items[0].startsAt, MONTH);
  for (const privateField of ['BOT_TOKEN', 'STARS_INVOICE_SECRET', 'invoice_payload',
    'external_invoice_payload', 'telegram_payment_charge_id', 'evidence_sha256']) {
    assert.ok(!JSON.stringify(list.data).includes('"' + privateField + '"'), privateField);
  }
  assert.equal(snapshot(f, ['payment_ledger', 'subscription_payment_review_receipts',
    'subscription_payment_review_settlements', 'subscription_orders', 'subscriptions', 'subscription_access_grants']), beforeRead);
  const body = { ledgerEntryId: recorded.ledgerEntryId, reasonCode: 'owner_payment_confirmed' };
  const guards = [
    ['admin/subscription-review', { token: ownToken }, 404],
    ['admin/subscription-review?telegramId=101', { token: ownerToken }, 400],
    ['admin/subscription-review', { token: ownerToken, method: 'POST', body }, 405],
    ['admin/subscription-review/apply', { token: ownerToken }, 405],
    ['admin/subscription-review/refund', { token: ownerToken }, 405],
    ['admin/subscription-review/apply', { token: ownToken, method: 'POST', body }, 404],
    ['admin/subscription-review/refund', { token: ownerToken, method: 'POST', body, key: null }, 400],
    ['admin/subscription-review/apply', { token: ownerToken, method: 'POST', body: { ...body, amountStars: 1 } }, 400],
    ['admin/subscription-review', { token: ownerToken, env: { ...f.serverEnv, V141_ADMIN_MINI_APP_ENABLED: 'false' } }, 404],
    ...['apply', 'refund'].map(action => ['admin/subscription-review/' + action,
      { token: ownerToken, method: 'POST', body, env: { ...f.serverEnv, REBUILD_V140_WRITES_ENABLED: 'false' } }, 403]),
  ];
  for (const [path, options, status] of guards) {
    const result = await f.request(path, options);
    assert.equal(result.status, status, JSON.stringify({ path, data: result.data }));
    assert.equal(count(f, 'payment_ledger'), 1);
    assert.equal(count(f, 'subscription_payment_review_settlements'), 0);
    assert.equal(count(f, 'subscription_access_grants'), 0);
  }
  // The canonical owner surface survives a closed participant lease. Opening
  // that surface still does not create any paid authority for the owner.
  f.sqlite.prepare("UPDATE mini_app_release_control SET state='closed',beta_enabled=0,owner_telegram_id=NULL,issued_at=NULL,expires_at=NULL").run();
  f.serverEnv = { ...f.serverEnv, REBUILD_V140_OWNER_WINDOW: 'false' };
  ownerToken = await f.open(900);
  const closedRead = await f.request('admin/subscription-review', { token: ownerToken,
    env: { ...f.serverEnv, REBUILD_V140_WRITES_ENABLED: 'false' } });
  assert.equal(closedRead.status, 200, JSON.stringify(closedRead.data));
  assert.equal(closedRead.data.items[0].status, 'pending_review');
  assert.equal(f.sqlite.prepare('SELECT plan_code FROM user_plans WHERE telegram_id=900').get().plan_code, 'free');
  assert.equal(count(f, 'subscription_access_grants'), 0);
  const applyKey = 'v143_http_owner_apply_' + next();
  const applied = await f.request('admin/subscription-review/apply', { token: ownerToken, method: 'POST', body, key: applyKey });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.status, 'applied');
  assert.equal(applied.data.accessApplied, true);
  assert.equal(count(f, 'payment_ledger'), 1);
  assert.equal(count(f, 'subscription_access_grants'), 1);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM payment_ledger').get(), originalLedger);
  assert.deepEqual(orderFor(f, origin.order_id), originalOrder);
  assert.deepEqual(orderFor(f, newerId), newerOrder);
  const settlement = f.sqlite.prepare('SELECT * FROM subscription_payment_review_settlements').get();
  assert.equal(settlement.actor_id, 900);
  assert.notEqual(settlement.applied_order_id, origin.order_id);
  const grant = grantFor(f, recorded.ledgerEntryId);
  assert.equal(grant.order_id, settlement.applied_order_id);
  assert.equal(grant.status, 'active');
  assert.equal(grant.ends_at - grant.starts_at, MONTH);
  const receipt = f.sqlite.prepare('SELECT * FROM subscription_payment_review_receipts WHERE ledger_entry_id=?').get(recorded.ledgerEntryId);
  assert.equal(grant.starts_at, receipt.provider_period_start);
  assert.equal(grant.ends_at, receipt.provider_period_end);
  assert.equal((await f.request('admin/subscription-review/apply', { token: ownerToken, method: 'POST', body, key: applyKey })).data.status, 'duplicate');
  assert.equal(count(f, 'subscription_payment_review_settlements'), 1);
  const refundKey = 'v143_http_owner_refund_' + next();
  const refund = await f.request('admin/subscription-review/refund', { token: ownerToken, method: 'POST', body, key: refundKey });
  assert.equal(refund.status, 200, JSON.stringify(refund.data));
  assert.equal(refund.data.refunded, true);
  assert.equal(refundCalls, 1);
  assert.equal(count(f, 'payment_ledger'), 2);
  const debit = f.sqlite.prepare("SELECT * FROM payment_ledger WHERE entry_type='refund'").get();
  assert.equal(debit.order_id, origin.order_id);
  assert.equal(debit.related_ledger_entry_id, recorded.ledgerEntryId);
  assert.equal(debit.amount_stars, originalLedger.amount_stars);
  assert.equal(debit.telegram_payment_charge_id, retainedCharge);
  assert.equal(grantFor(f, recorded.ledgerEntryId).status, 'refunded');
  assert.equal(orderFor(f, settlement.applied_order_id).order_state, 'refunded');
  assert.deepEqual(orderFor(f, origin.order_id), originalOrder);
  assert.deepEqual(orderFor(f, newerId), newerOrder);
  f.restart();
  const refreshedOwner = await f.open(900);
  const refundReplay = await f.request('admin/subscription-review/refund', { token: refreshedOwner, method: 'POST', body, key: refundKey });
  assert.equal(refundReplay.status, 200, JSON.stringify(refundReplay.data));
  assert.equal(refundReplay.data.status, 'duplicate');
  assert.equal(refundCalls, 1);
  assert.equal(invoiceCalls, 1);
  assert.equal(count(f, 'payment_ledger'), 2);
  assert.equal((await f.request('admin/subscription-review', { token: refreshedOwner })).data.items[0].status, 'refunded');
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(f.sqlite.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
