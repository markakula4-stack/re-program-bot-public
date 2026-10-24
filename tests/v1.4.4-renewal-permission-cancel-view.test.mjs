import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import './helpers/v1.4.3-p05-offline-network.mjs';
import { cabinetSubscriptionFixture, next } from './helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import { readSubscriptionData } from '../src/v1.4.2/subscription-read-model.mjs';
import { runtimeAuthorizationDTO } from '../src/v1.4.1/runtime-authorizer.mjs';
import { authorizeOwnStarsSubscriptionCommand } from '../src/v1.4.3/subscription-action-authority.mjs';
import { requestOwnStarsSubscriptionCommand } from '../src/v1.4.3/telegram-subscription-provider.mjs';
import { applyStarsCompensation } from '../src/v1.3.6/stars-access-runtime.mjs';
import { MiniAppClient } from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';
import { mountCabinet } from '../src/v1.4.0-rebuild/mini-app/cabinet-view.mjs';
import { isNativeRenewalPermissionPending } from '../src/v1.4.0-rebuild/mini-app/subscription-view.mjs';

const requireDom = createRequire(process.env.CABINET_UI_DOM_ROOT ? `${process.env.CABINET_UI_DOM_ROOT}/package.json` : new URL('./p08-ui/package.json', import.meta.url));
const { parseHTML } = requireDom('linkedom');
const html = fs.readFileSync(new URL('../src/v1.4.0-rebuild/mini-app/partner-cabinet.html', import.meta.url), 'utf8');
const flags = { version: 1, mutationsEnabled: false, offerActionsEnabled: false, existingRenewalCancellationEnabled: true, nativeOwnerInvoiceOnly: true };
const tick = () => new Promise(resolve => setImmediate(resolve));
const actualNow = Date.now;
const money = f => ({ ledger: f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY ledger_entry_id').all(),
  grants: f.sqlite.prepare('SELECT * FROM subscription_access_grants ORDER BY grant_id').all() });

async function fixture(t, { refund = true, edit = null, changeAt = 0, change = null, unknownClient = false, packageUnknown = false, realUnknown = false } = {}) {
  Date.now = actualNow;
  const f = cabinetSubscriptionFixture(t); f.now = Math.floor(actualNow() / 1000);
  Date.now = () => f.now * 1000; t.after(() => { Date.now = actualNow; });
  const paid = await f.paid(), target = { contractId: paid.contract.contract_id, expectedRevision: paid.contract.revision };
  const setupCommand = async action => {
    f.now++;
    return requestOwnStarsSubscriptionCommand(await authorizeOwnStarsSubscriptionCommand(await f.auth({
      payload: { subscriptionAction: action, ...target } })), { telegramApi: async () => true });
  };
  assert.equal((await setupCommand('cancel_renewal')).status, 'confirmed');
  assert.equal((await setupCommand('reenable_renewal')).status, 'confirmed');
  if (refund) {
    f.now++;
    await applyStarsCompensation(f.serverEnv, { telegramPaymentChargeId: paid.update.message.successful_payment.telegram_payment_charge_id,
      compensationType: 'refund', telegramUpdateId: next(), occurredAt: f.now });
  }
  if (realUnknown) {
    f.now++;
    const unknown = await requestOwnStarsSubscriptionCommand(await authorizeOwnStarsSubscriptionCommand(await f.auth({
      payload: { subscriptionAction: 'cancel_renewal', ...target } })), { telegramApi: async () => { throw new Error('offline provider outcome genuinely unknown'); } });
    assert.equal(unknown.status, 'unknown');
  }
  const descriptor = async () => {
    const authorization = await f.auth();
    return { ...await readSubscriptionData({ authorization }), authorization: runtimeAuthorizationDTO(authorization), features: flags };
  };
  const source = await descriptor();
  if (!realUnknown) assert.deepEqual(source.lifecycle.reviewReasons, ['provider_reenable_permission_pending']);
  else assert.ok(source.lifecycle.reviewReasons.includes('provider_command_unknown'));
  assert.equal(source.lifecycle.pendingOperations, realUnknown ? 2 : 1); assert.equal(source.renewalActions.cancel.available, true);
  assert.equal(source.renewalActions.enable.available, false);
  const initial = structuredClone(source); edit?.(initial); initial.access.lifecycle = structuredClone(initial.lifecycle);
  const profileAuthorization = runtimeAuthorizationDTO(await f.auth({ operation: 'profile.read_own' }));
  const bootstrap = { readModelVersion: 1, authorization: profileAuthorization, features: flags, systemRole: 'user',
    partner: { state: 'no_application', application: null, profile: null, legalProfile: null, beta: null, actions: {} },
    navigation: ['profile', 'offers', 'applications', 'analytics', 'subscription'].map(section => ({ section, enabled: section !== 'analytics', reason: null })),
    counts: { visibleOffers: 0, ownOffers: 0, ownApplications: 0, attributedApplications: 0 } };
  const values = new Map(), calls = []; let subscriptionReads = 0, app;
  if (unknownClient) values.set('re-subscription-pending-v1', JSON.stringify({ kind: 'cancel', key: 'f'.repeat(48), startedAt: f.now, intent: target }));
  const client = new MiniAppClient({ origin: 'https://cabinet.example', now: () => f.now * 1000,
    pendingStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    onExpired: () => app?.expire(), fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/session')) return Response.json({ sessionToken: 'rpms1_' + 'a'.repeat(43), tokenType: 'Bearer', expiresAt: f.now + 300,
        principal: { telegramId: 101, botId: 123456789 }, authorizationVersion: 1, features: flags });
      if (init.method === 'GET') {
        if (url.endsWith('/bootstrap')) return Response.json(bootstrap);
        assert.ok(url.endsWith('/subscription')); subscriptionReads++;
        const current = structuredClone(initial); if (change && subscriptionReads >= changeAt) change(current); return Response.json(current);
      }
      if (url.endsWith('/operation-status')) return Response.json({ error: 'offline_pending_outcome_unknown' }, { status: 503 });
      assert.ok(url.endsWith('/subscription/renewal/cancel')); assert.deepEqual(JSON.parse(init.body), target);
      // A modeled REJECTED transport reply cannot fabricate provider ACK or paid facts.
      return Response.json({ status: 'rejected', contractId: target.contractId, action: 'cancel_renewal', cancellationConfirmed: false,
        reenableAllowed: false, providerState: null, paidPeriodChanged: false, accessApplied: false, authorization: initial.authorization });
    } });
  await client.authenticate('offline-cancel-after-permission');
  if (packageUnknown) Object.defineProperty(client, 'packageOutcomePending', { get: () => true });
  const { document, window } = parseHTML(html); window.location = { hash: '#subscription' };
  window.HTMLElement.prototype.focus = function () {}; window.HTMLElement.prototype.reportValidity = function () { return true; };
  app = mountCabinet({ document, client }); t.after(() => app.destroy()); await app.start();
  const flush = async () => { for (let i = 0; i < 16; i++) await tick(); };
  return { f, paid, target, source, initial, client, document, window, calls, values, app, flush,
    cancel: () => document.querySelector('[data-renewal-action="cancel"]'), panel: () => document.querySelector('[data-subscription-confirmation]'),
    posts: () => calls.filter(call => call.url.endsWith('/renewal/cancel')), beforeMoney: money(f),
    get subscriptionReads() { return subscriptionReads; } };
}

for (const refund of [false, true]) test(`confirmed reenable permission permits explicit cancel after two fresh reads; refund=${refund}`, async t => {
  const h = await fixture(t, { refund }); assert.equal(isNativeRenewalPermissionPending(h.initial), true);
  assert.ok(h.cancel()); assert.equal(h.cancel().disabled, false); assert.equal(h.posts().length, 0);
  assert.equal(h.document.querySelector('[data-renewal-action="enable"]'), null);
  h.cancel().click(); await h.flush(); assert.ok(h.panel()); assert.equal(h.posts().length, 0); assert.equal(h.subscriptionReads, 2);
  const back = [...h.panel().querySelectorAll('button')].find(node => node.textContent === 'Назад'); back.click(); assert.equal(h.panel(), null); assert.equal(h.posts().length, 0);
  h.cancel().click(); await h.flush(); const submit = h.panel().querySelector('[data-subscription-confirm]'); submit.click(); await h.flush();
  assert.equal(h.posts().length, 1); assert.deepEqual(JSON.parse(h.posts()[0].init.body), h.target);
  const firstPost = h.calls.findIndex(call => call.url.endsWith('/renewal/cancel'));
  assert.equal(h.calls.slice(0, firstPost).filter(call => call.url.endsWith('/subscription')).length, 4, 'both dialog openings and final confirmation read fresh state');
  assert.match(h.posts()[0].init.headers['Idempotency-Key'], /^[a-f0-9]{48}$/u);
  assert.deepEqual(money(h.f), h.beforeMoney); assert.match(h.document.getElementById('notice').textContent, /Telegram не подтвердил действие/);
  assert.equal(h.document.querySelector('[data-featured-receipt]') !== null, !refund);
  if (refund) { assert.equal(h.source.lifecycle.paidAccess, false); assert.ok(h.source.history.items.every(item => item.status === 'refunded'));
    assert.equal(h.f.sqlite.prepare("SELECT COUNT(*) AS n FROM subscription_provider_commands WHERE action='cancel_renewal' AND state='confirmed'").get().n, 1, 'UI transport did not invent a second provider acknowledgement'); }
});

test('additional unresolved command, another review reason, unavailable own cancel or mismatched epoch never receives the permission exception', async t => {
  for (const edit of [data => { data.lifecycle.pendingOperations = 2; data.renewalActions.pendingOperations = 2; },
    data => { data.lifecycle.reviewReasons.push('provider_command_unknown'); }, data => { data.renewalActions.cancel.available = false; },
    data => { data.renewalActions.contractId = null; data.lifecycle.contractId = null; }, data => { data.renewalActions.expectedRevision = 0; }]) {
    const h = await fixture(t, { edit }); assert.equal(isNativeRenewalPermissionPending(h.initial), false);
    const cancel = h.cancel(); if (cancel) { assert.equal(cancel.disabled, true); cancel.click(); await h.flush(); }
    assert.equal(h.panel(), null); assert.equal(h.posts().length, 0); assert.deepEqual(money(h.f), h.beforeMoney); h.app.destroy();
  }
});

test('changed exact contract or revision, or a real unknown command at either fresh check blocks cancel transport', async t => {
  for (const [changeAt, change] of [[2, data => data.renewalActions.expectedRevision++], [3, data => data.renewalActions.expectedRevision++],
    [3, data => { data.lifecycle.contractId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; data.renewalActions.contractId = data.lifecycle.contractId; }],
    [3, data => { data.lifecycle.pendingOperations = 2; data.renewalActions.pendingOperations = 2; data.lifecycle.reviewReasons.push('provider_command_unknown'); }]]) {
    const h = await fixture(t, { changeAt, change: data => { change(data); data.access.lifecycle = structuredClone(data.lifecycle); } });
    h.cancel().click(); await h.flush(); if (changeAt === 3) { assert.ok(h.panel()); h.panel().querySelector('[data-subscription-confirm]').click(); await h.flush(); }
    else assert.equal(h.panel(), null);
    assert.equal(h.posts().length, 0); assert.deepEqual(money(h.f), h.beforeMoney); h.app.destroy();
  }
});

test('genuine unknown client outcome and package outcome locks keep explicit cancellation closed', async t => {
  for (const options of [{ unknownClient: true }, { packageUnknown: true }]) {
    const h = await fixture(t, options), marker = h.values.get('re-subscription-pending-v1'); assert.ok(h.cancel()); assert.equal(h.cancel().disabled, true);
    h.cancel().click(); await h.flush(); assert.equal(h.panel(), null); assert.equal(h.posts().length, 0);
    assert.equal(h.values.get('re-subscription-pending-v1'), marker); assert.deepEqual(money(h.f), h.beforeMoney); h.app.destroy();
  }
});

test('permission-pending lifecycle never opens enable or a new recurring invoice even when an offer advertises checkout', async t => {
  const h = await fixture(t);
  assert.equal(h.document.querySelector('[data-renewal-action="enable"]'), null);
  for (const candidate of h.initial.catalog.recurring.offers) { candidate.purchaseEligibility.eligible = true; candidate.checkout.available = true; }
  await h.app.navigate('subscription'); h.document.querySelector('[data-recurring-plan="dragon"]').click(); await h.flush();
  assert.ok(h.panel()); assert.equal(h.panel().querySelector('input'), null); assert.equal(h.panel().querySelector('[data-subscription-confirm]'), null);
  assert.equal(h.posts().length, 0); assert.equal(h.calls.filter(call => call.url.endsWith('/recurring-invoice')).length, 0); assert.deepEqual(money(h.f), h.beforeMoney);
});


test('genuine admitted native cancellation with unknown provider outcome stays closed beside the confirmed permission', async t => {
  const h = await fixture(t, { realUnknown: true });
  assert.equal(h.source.lifecycle.pendingOperations, 2); assert.equal(isNativeRenewalPermissionPending(h.source), false);
  assert.ok(h.cancel()); assert.equal(h.cancel().disabled, true); h.cancel().click(); await h.flush();
  assert.equal(h.panel(), null); assert.equal(h.posts().length, 0); assert.deepEqual(money(h.f), h.beforeMoney);
  assert.equal(h.f.sqlite.prepare("SELECT COUNT(*) AS n FROM subscription_provider_commands WHERE state='unknown'").get().n, 1);
});
