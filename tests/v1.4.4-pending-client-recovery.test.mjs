import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import './helpers/v1.4.3-p05-offline-network.mjs';
import { MiniAppClient } from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';
import { mountCabinet } from '../src/v1.4.0-rebuild/mini-app/cabinet-view.mjs';
import { createCabinetHttp } from '../src/v1.4.0-rebuild/cabinet-http.mjs';
import { handlePackageCommerceRequest } from '../src/v1.4.4/package-commerce-runtime.mjs';
import { signedInitData } from './helpers/v1.4.1-fixtures.mjs';
import { packageSubscriptionHttpFixture } from './helpers/v1.4.4-package-subscription-http-fixture.mjs';
import { ORIGIN } from './helpers/v1.4.0-rebuild-sqlite.mjs';

const requireDom = createRequire(process.env.CABINET_UI_DOM_ROOT ? `${process.env.CABINET_UI_DOM_ROOT}/package.json`
  : new URL('./p08-ui/package.json', import.meta.url));
const { parseHTML } = requireDom('linkedom');
const html = fs.readFileSync(new URL('../src/v1.4.0-rebuild/mini-app/partner-cabinet.html', import.meta.url), 'utf8');
const SUBSCRIPTION_KEY = 're-subscription-pending-v1', PACKAGE_KEY = 're-package-pending-v1';
const TERMS = '2026-10-03.stars-recurring-v1';
const intent = { planCode: 'professional', recurringConsent: true, termsRevision: TERMS, priceVersion: 1 };
const financialSnapshot = f => JSON.stringify(Object.fromEntries(['payment_ledger', 'payment_refunds', 'subscription_provider_commands',
  'subscription_provider_events', 'subscription_access_grants', 'subscription_package_periods'].map(table =>
  [table, f.sqlite.prepare(`SELECT * FROM ${table}`).all()])));

async function fixture(t, { removeFails = false, providerOutcome = 'confirmed', loseResponse = false, saved = null,
  corruptLookup = false, lookupUnavailable = false } = {}) {
  const f = await packageSubscriptionHttpFixture(t), issued = f.now - 1, expires = f.now + 600;
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql', import.meta.url), 'utf8'));
  f.sqlite.prepare(`UPDATE mini_app_release_control SET state='open',beta_enabled=1,owner_telegram_id=900,
    issued_at=?,expires_at=? WHERE id=1`).run(issued, expires);
  f.serverEnv = { ...f.serverEnv, REBUILD_V140_OWNER_WINDOW: `true:${issued}:${expires}`, REBUILD_V140_OWNER_TELEGRAM_ID: '900',
    STARS_RECURRING_PRICE_VERSION: '1', STARS_RECURRING_TERMS_REVISION: TERMS };
  for (const [plan, amount] of [['professional', 249], ['dragon', 499]])
    f.sqlite.prepare(`INSERT OR IGNORE INTO price_book(price_id,price_version,plan_code,currency,amount_stars,
      access_seconds,billing_mode,publication_state,terms_revision,valid_from,created_at)
      VALUES(?,1,?,'XTR',?,2592000,'recurring','approved',?,?,?)`).run(`${plan}-30d-recovery-v1`, plan, amount, TERMS, f.now - 10000, f.now - 10000);
  const values = new Map(saved ? [[SUBSCRIPTION_KEY, typeof saved === 'string' ? saved : JSON.stringify(saved)]] : []);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: key => { if (removeFails) throw new Error('offline browser storage removal denied'); values.delete(key); } };
  const providerCalls = [], calls = [], control = { loseResponse };
  let started, release;
  const providerStarted = new Promise(resolve => { started = resolve; });
  const http = createCabinetHttp({ repositoryFactory: f.repositoryFactory, clock: () => f.now,
    nativeProviderFetch: async (url, init) => {
      const method = new URL(url).pathname.split('/').at(-1); providerCalls.push({ method, body: JSON.parse(init.body) });
      started();
      if (providerOutcome === 'pending') await new Promise(resolve => { release = resolve; });
      if (providerOutcome === 'unknown') throw new TypeError('offline ambiguous provider transport');
      if (providerOutcome === 'rejected') return Response.json({ ok: false, error_code: 400, description: 'Bad Request: offline invoice rejected' }, { status: 400 });
      return Response.json({ ok: true, result: 'https://t.me/$offlinePendingRecoveryInvoice' });
    } });
  const makeClient = () => new MiniAppClient({ origin: ORIGIN, now: () => f.now * 1000, pendingStorage: storage,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const headers = new Headers(init.headers);
      if (init.method === 'POST') { headers.set('Sec-Fetch-Site', 'same-origin'); headers.set('Origin', ORIGIN); }
      const request = new Request(url, { ...init, headers });
      const response = url.includes('/packages/') ? await handlePackageCommerceRequest(request, f.serverEnv, {
        telegramApi: async (_env, method, body) => {
          providerCalls.push({ method, body }); return 'https://t.me/$offlinePendingRecoveryInvoice';
        } }) : await http(request, f.serverEnv);
      if (url.endsWith('/recurring-invoice') && control.loseResponse) {
        control.loseResponse = false; throw new TypeError('offline response lost after the actual in-memory server operation');
      }
      if (url.endsWith('/operation-status') && lookupUnavailable) return Response.json({ error: 'operation_status_unavailable' }, { status: 503 });
      if (url.endsWith('/operation-status') && corruptLookup) {
        const body = await response.json(); return Response.json({ ...body, accessApplied: true });
      }
      return response;
    } });
  const mount = async client => {
    await client.authenticate(signedInitData(900, f.now));
    const { document, window } = parseHTML(html); window.location = { hash: '#subscription' };
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => document._focused ?? document.body });
    window.HTMLElement.prototype.focus = function () { document._focused = this; };
    window.scrollTo = () => {}; window.scrollY = 0; window.localStorage = storage;
    const app = mountCabinet({ document, client }); t.after(() => app.destroy()); await app.start();
    assert.ok(document.querySelector('[data-subscription-screen]'), document.getElementById('screen').textContent);
    return { client, app, document };
  };
  return { f, makeClient, mount, storage, values, calls, providerCalls, providerStarted, releaseProvider: () => release?.() };
}

for (const state of ['confirmed', 'rejected']) test(`mounted own HTTP read clears a genuine ${state} saved invoice using only its original read-only status`, async t => {
  const h = await fixture(t, { providerOutcome: state, loseResponse: true, removeFails: true });
  const first = h.makeClient(); await first.authenticate(signedInitData(900, h.f.now));
  await assert.rejects(first.subscriptionAction('invoice', intent), { code: 'subscription_outcome_unknown' });
  const saved = JSON.parse(h.values.get(SUBSCRIPTION_KEY)), snapshot = financialSnapshot(h.f), before = h.calls.length;
  first.clearSession(); const reopened = h.makeClient();
  const view = await h.mount(reopened);
  assert.equal(reopened.subscriptionOutcomePending, false); assert.equal(reopened.subscriptionRecoveryState, null);
  assert.equal(reopened.subscriptionStorageNeedsRecovery, true); assert.deepEqual(JSON.parse(h.values.get(SUBSCRIPTION_KEY)), saved);
  assert.equal(reopened.recoveredSubscriptionInvoiceUrl, state === 'confirmed' ? 'https://t.me/$offlinePendingRecoveryInvoice' : null);
  assert.equal(view.document.querySelector('[data-current-plan]').getAttribute('data-current-plan'), 'free');
  assert.equal(h.providerCalls.length, 1); assert.equal(financialSnapshot(h.f), snapshot);
  const lookup = h.calls.slice(before).filter(call => call.url.endsWith('/operation-status')); assert.equal(lookup.length, 1);
  assert.equal(lookup[0].init.headers['Idempotency-Key'], saved.key);
  assert.deepEqual(JSON.parse(lookup[0].init.body), { kind: 'invoice', intent });
  assert.equal(h.calls.filter(call => call.url.endsWith('/recurring-invoice')).length, 1);
  // The retained durable marker can survive another browser reopening without
  // changing the original intent or replaying its producer/provider request.
  await h.mount(h.makeClient()); assert.equal(h.providerCalls.length, 1);
});

test('a genuine unknown invoice and a genuine missing saved operation remain guarded after mounted read-only recovery', async t => {
  for (const state of ['unknown', 'missing']) await t.test(state, async tt => {
    const saved = { kind: 'invoice', key: 'a'.repeat(48), startedAt: 1791327599, intent };
    const h = await fixture(tt, { providerOutcome: 'unknown', loseResponse: true, saved: state === 'missing' ? saved : null });
    if (state === 'unknown') {
      const first = h.makeClient(); await first.authenticate(signedInitData(900, h.f.now));
      await assert.rejects(first.subscriptionAction('invoice', intent), { code: 'subscription_outcome_unknown' }); first.clearSession();
    }
    const marker = h.values.get(SUBSCRIPTION_KEY), snapshot = financialSnapshot(h.f), client = h.makeClient(); await h.mount(client);
    assert.equal(client.subscriptionOutcomePending, true); assert.equal(client.subscriptionRecoveryState.state, state);
    assert.equal(client.subscriptionRecoveryState.readOnly, true); assert.equal(h.values.get(SUBSCRIPTION_KEY), marker);
    await assert.rejects(client.subscriptionAction('invoice', intent), { code: 'subscription_outcome_unknown' });
    assert.equal(h.calls.filter(call => call.url.endsWith('/recurring-invoice')).length, state === 'unknown' ? 1 : 0);
    assert.equal(financialSnapshot(h.f), snapshot);
  });
});

test('a genuine server attempt still pending is read through its exact key and remains guarded without a second producer', async t => {
  const h = await fixture(t, { providerOutcome: 'pending', loseResponse: true });
  const first = h.makeClient(); await first.authenticate(signedInitData(900, h.f.now));
  const original = first.subscriptionAction('invoice', intent);
  // Attach rejection handling before allowing the synthetic provider to finish.
  const completion = assert.rejects(original, { code: 'subscription_outcome_unknown' });
  await h.providerStarted;
  try {
    const saved = h.values.get(SUBSCRIPTION_KEY), client = h.makeClient(); await h.mount(client);
    assert.equal(client.subscriptionOutcomePending, true); assert.equal(client.subscriptionRecoveryState.state, 'pending');
    assert.equal(client.subscriptionRecoveryState.readOnly, true); assert.equal(h.values.get(SUBSCRIPTION_KEY), saved);
    assert.equal(h.providerCalls.length, 1); assert.equal(h.calls.filter(call => call.url.endsWith('/recurring-invoice')).length, 1);
  } finally { h.releaseProvider(); await completion; }
});

test('legacy or malformed browser identities remain local unknown guards, without guessing a current contract or issuing a lookup', async t => {
  for (const saved of [
    { kind: 'cancel', key: 'a'.repeat(48), startedAt: 1791327599 },
    { kind: 'cancel', key: 'a'.repeat(48), startedAt: 1791327599, intent: { contractId: 'not-a-canonical-id', expectedRevision: 0 } },
    '{broken json',
  ]) await t.test(typeof saved === 'string' ? 'malformed JSON' : saved.intent ? 'malformed intent' : 'legacy missing intent', async tt => {
    const h = await fixture(tt, { saved }), client = h.makeClient(), marker = h.values.get(SUBSCRIPTION_KEY); await h.mount(client);
    assert.equal(client.subscriptionOutcomePending, true);
    assert.deepEqual(client.subscriptionRecoveryState, { state: 'unrecoverable', reasonCode: 'saved_operation_identity_unavailable', readOnly: true });
    assert.equal(h.values.get(SUBSCRIPTION_KEY), marker); assert.equal(h.calls.filter(call => call.url.endsWith('/operation-status')).length, 0);
    assert.equal(h.providerCalls.length, 0);
  });
});

test('malformed or failed terminal lookup is reported separately from a provider pending result and cannot clear the guard', async t => {
  for (const option of ['corruptLookup', 'lookupUnavailable']) await t.test(option, async tt => {
    const h = await fixture(tt, { providerOutcome: 'confirmed', loseResponse: true, [option]: true });
    const first = h.makeClient(); await first.authenticate(signedInitData(900, h.f.now));
    await assert.rejects(first.subscriptionAction('invoice', intent), { code: 'subscription_outcome_unknown' }); first.clearSession();
    const marker = h.values.get(SUBSCRIPTION_KEY), client = h.makeClient(); await h.mount(client);
    assert.equal(client.subscriptionOutcomePending, true); assert.equal(client.subscriptionRecoveryState.state, 'lookup_failed');
    assert.equal(client.subscriptionRecoveryState.reasonCode, option === 'corruptLookup' ? 'operation_status_invalid' : 'operation_status_unavailable');
    assert.equal(h.values.get(SUBSCRIPTION_KEY), marker); assert.equal(h.providerCalls.length, 1);
  });
});

test('genuine package invoice terminal response clears live memory when browser cleanup fails; reopening never automatically replays the producer', async t => {
  const h = await fixture(t, { removeFails: true }), client = h.makeClient(); await client.authenticate(signedInitData(900, h.f.now));
  const data = await client.read('subscription'), offer = data.packages.offers.find(item => item.planCode === 'professional' && item.packageCode === '3m');
  const confirmation = Object.fromEntries([['acceptedTerms', true], ...['amountStars', 'currency', 'priceVersion', 'offerVersion', 'campaignCode', 'termsRevision'].map(field => [field, offer[field]])]);
  const result = await client.packageAction('invoice', { requestedPlanCode: 'professional', packageCode: '3m', confirmation });
  assert.equal(result.status, 'issued'); assert.equal(client.packageOutcomePending, false); assert.equal(client.packageStorageNeedsRecovery, true);
  const saved = h.values.get(PACKAGE_KEY); assert.ok(saved); assert.equal(h.providerCalls.length, 1);
  client.clearSession(); const reopened = h.makeClient(); await h.mount(reopened);
  assert.equal(reopened.packageOutcomePending, true); assert.equal(h.values.get(PACKAGE_KEY), saved);
  assert.equal(h.calls.filter(call => call.url.endsWith('/packages/invoice')).length, 1);
  assert.equal(h.providerCalls.length, 1); assert.equal(h.f.sqlite.prepare('SELECT COUNT(*) n FROM payment_ledger').get().n, 0);
});
