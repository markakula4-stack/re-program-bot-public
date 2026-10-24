import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { MiniAppClient, readSubscriptionDTO } from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';
import { mountCabinet } from '../src/v1.4.0-rebuild/mini-app/cabinet-view.mjs';
import { subscriptionUIFixture } from './helpers/v1.4.3-subscription-ui-fixture.mjs';

// The public toolchain pins the official package and integrity in package-lock.
const requireDom = createRequire(new URL('./p08-ui/package.json', import.meta.url));
assert.equal(requireDom('linkedom/package.json').version, '0.18.12', 'pinned DOM dependency changed');
const { parseHTML } = requireDom('linkedom');
const CONTRACT = '22222222-2222-4222-8222-222222222222', KEY = 'a'.repeat(48), STORAGE = 're-subscription-pending-v1';
const auth = (capability, now) => ({ version: 1, capability, allowed: true, reasonCode: 'allowed', policyVersion: 'v1',
  effectivePlan: 'professional', accessState: 'active', validUntil: now + 300, quota: null, actionPolicy: 'allow' });
function subscription(now, cancelProducer = false) {
  const data = subscriptionUIFixture({ now }); delete data.history;
  if (!cancelProducer) { delete data.lifecycle; delete data.renewalActions; delete data.access.lifecycle; }
  else { data.lifecycle.renewalState = 'active'; data.renewalActions.renewalState = 'active'; data.renewalActions.expectedRevision = 3; }
  delete data.catalog.recurring;
  data.subscriptionModelVersion = '2026-10-03.v1.4.2.p01'; data.authorization = auth('access.read_own', now);
  Object.assign(data.access, { version: 1, authority: 'worker', policyVersion: 'v1', observedAt: now });
  Object.assign(data.access.preview, { historyStatus: 'not_used', startsAt: null, expiresAt: null,
    eligibility: 'unavailable', membershipCheckRequired: true });
  data.quotas.version = 1;
  const scopes = ['own_applicant_visible_offer', 'own_partner_profile', 'own_ambassador_profile'];
  data.quotas.quotas.forEach((row, i) => Object.assign(row, { scope: scopes[i], reasonCode: 'available' }));
  Object.assign(data.catalog, { version: data.subscriptionModelVersion, generatedAt: now, priceVersion: 1,
    paymentsEnabled: true, paymentsReady: true, catalogReady: true, problems: [],
    rollout: { mode: 'allowlist', eligible: true, reasonCode: 'eligible' },
    billing: { mode: 'prepaid', releasedMode: true, periodSeconds: 2592000, renewal: 'manual', automaticRenewal: false } });
  for (const offer of data.catalog.offers) {
    const free = offer.planCode === 'free'; Object.assign(offer, { name: offer.planCode, currency: 'XTR',
      billingMode: free ? 'free' : 'prepaid', autoRenew: false, matchesInitialPrice: true });
    if (free) offer.purchaseEligibility.mode = null;
    else {
      Object.assign(offer.purchaseEligibility, { termsAcceptanceRequired: true, invoiceRequiresConfirmedTerms: true });
      Object.assign(offer.checkout, { reasonCode: null, kind: 'telegram_deep_link', botUsername: 'RE_Program_Bot',
        menuCommand: '/plans', menuCallback: 'plans', termsCallback: 'stars_buy:' + offer.planCode,
        acceptanceCallback: 'stars_accept:' + offer.planCode, hintIsAuthority: false });
    }
  }
  Object.assign(data.catalog.terms, { publishedRevision: data.catalog.termsRevision, scope: 'stars_purchase',
    acceptanceRequiredBeforeInvoice: true, textFormat: 'plain', reasonCode: null, telegramCommand: '/terms', telegramCallback: 'stars_buy:terms' });
  Object.assign(data.catalog.support, { available: true, paymentCommand: '/paysupport', paymentCallback: 'paysupport',
    text: 'Помощь с оплатой', refundTermsRevision: 'v1', refundAutomatic: false });
  Object.assign(data.catalog.nativeDependencies.referralShare, { releasedText: 'Откройте RE Program: проверенные партнёрские программы и предложения.',
    preparationRequired: true, preparedMessageId: null });
  Object.assign(data.catalog.comparison, { policyVersion: 'v1', previewLimits: { active_applications: 50, own_working_offers: 10, active_campaigns: 20 }, baseline: [] });
  data.catalog.comparison.rows.forEach(row => Object.assign(row, { label: row.key, unit: 'count', roleRequirement: 'user', additionalRestrictions: [] }));
  Object.assign(data.catalog.comparison.support, { priority: 'not_released', founderLine: 'not_released' });
  readSubscriptionDTO(data, { nowSeconds: now, sessionExpiresAt: now + 300 });
  return data;
}
function inactiveSubscription(now, invoiceAvailable = false) {
  const data = subscription(now, true);
  Object.assign(data.lifecycle, { state: 'refunded', renewalState: 'inactive', paidAccess: false, accessUntil: null,
    pendingOperations: 0, reviewRequired: false, reviewReasons: [] });
  Object.assign(data.renewalActions, { renewalState: 'inactive', pendingOperations: 0 });
  data.renewalActions.cancel.available = false; data.renewalActions.enable.available = false;
  Object.assign(data.access.current, { planCode: 'free', accessState: 'none', sourceKind: 'free', startsAt: null,
    expiresAt: null, remainingSeconds: null, durationKind: 'free_unlimited' });
  Object.assign(data.authorization, { effectivePlan: 'free', accessState: 'none' });
  data.packages = { version: 1, modelVersion: '2026-10-07.v1.4.4.p03', authority: 'worker', accessAuthority: false,
    observedAt: now, validUntil: now + 200, canWrite: true, available: true, reasonCode: null,
    offers: [{ planCode: 'professional', packageCode: '3m', durationDays: 90, periodSeconds: 7776000,
      published: true, available: true, reasonCode: null, amountStars: 699, currency: 'XTR', billingMode: 'prepaid',
      automaticRenewal: false, freshConsentRequired: false, priceVersion: 2, offerVersion: 'package-v1', campaignCode: null,
      termsRevision: '2026-09-10.stars-v1', terms: { revision: '2026-09-10.stars-v1', available: true,
        accepted: false, text: 'Разовая оплата 90 дней.', telegramCommand: '/terms' }, priceComparison: null,
      preview: { startsAt: now, endsAt: now + 7776000, datesAreEstimate: true, validUntil: now + 200 },
      invoice: { available: invoiceAvailable, reasonCode: invoiceAvailable ? null : 'package_recurring_cancellation_unconfirmed',
        route: '/packages/invoice', actionAdmissionRequired: true },
      schedule: { available: false, reasonCode: 'package_transition_unavailable', route: '/packages/schedule', actionAdmissionRequired: true } }],
    paidPeriods: [], transitions: [], pendingInvoices: [], terms: null };
  readSubscriptionDTO(data, { nowSeconds: now, sessionExpiresAt: now + 300 }); return data;
}
const PACKAGE_INVOICE = 'https://t.me/$FictionalOwnerTest250';
function packageSubscription(now, state) {
  const data = inactiveSubscription(now, !state.invoiceIssued), offer = data.packages.offers[0];
  if (!state.invoiceIssued) Object.assign(offer, { amountStars: 250, priceVersion: 3,
    offerVersion: '2026-10-08.owner-test-250-v1', campaignCode: 'owner-test-250-20261008' });
  if (state.invoiceIssued && !state.invoiceMissing) data.packages.pendingInvoices = [{ planCode: 'professional', packageCode: '3m', durationDays: 90,
    amountStars: 250, currency: 'XTR', billingMode: 'prepaid', state: state.invoiceExpired ? 'expired' : 'issued', priceVersion: 3,
    offerVersion: '2026-10-08.owner-test-250-v1', campaignCode: 'owner-test-250-20261008', termsRevision: '2026-09-10.stars-v1',
    startsAt: now, endsAt: now + 7776000, datesAreEstimate: true, expiresAt: state.invoiceExpired ? now - 1 : now + 900,
    invoiceUrl: state.invoiceExpired ? null : PACKAGE_INVOICE, grantsAccess: false }];
  readSubscriptionDTO(data, { nowSeconds: now, sessionExpiresAt: now + 300 }); return data;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const untilAbort = signal => new Promise((resolve, reject) => {
  const abort = () => reject(new DOMException('request aborted', 'AbortError'));
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
});
async function mounted(t, { recoverError = false, holdRecovery = false, recoverTimeout = false,
  recoverTerminal = false, timeoutStatusAfterRecovery = false, cancelProducer = false,
  cancelTimeout = false, holdCancel = false, reconfirm = false, reconfirmStatus = 'pending', packageInvoice = false } = {}) {
  const now = Math.floor(Date.now() / 1000), clock = { now }, calls = [], values = new Map(cancelProducer || packageInvoice ? [] : [[STORAGE,
    JSON.stringify({ kind: 'cancel', key: KEY, startedAt: now - (reconfirm ? 301 : 10), intent: { contractId: CONTRACT, expectedRevision: 3 },
      ...(reconfirm ? { principal: { telegramId: 101, botId: 789 } } : {}) })]]);
  const readState = { inactive: false, invoiceAvailable: false, state: 'pending', reconfirmState: reconfirmStatus,
    invoiceIssued: false, invoiceExpired: false, invoiceMissing: false, sessionError: false, nativeCalls: [] };
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const html = '<html><body><div id="cabinet"><p id="notice" role="status"></p><nav id="navigation"></nav><main id="screen"></main></div></body></html>';
  const { document, window } = parseHTML(html);
  const noticeHistory = [], notice = document.getElementById('notice');
  const setNoticeAttribute = notice.setAttribute.bind(notice);
  notice.setAttribute = (name, value) => {
    if (name === 'data-status') noticeHistory.push({ text: notice.textContent, status: value });
    return setNoticeAttribute(name, value);
  };
  window.HTMLElement.prototype.focus = function () {};
  window.HTMLElement.prototype.scrollIntoView = function () { this.revealed = true; };
  Object.defineProperty(window, 'location', { configurable: true, value: { hash: '#subscription' } });
  window.scrollY = 900; window.scrollTo = ({ top }) => { window.scrollY = top; };
  let release; const released = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const client = new MiniAppClient({ origin: 'https://example.test', now: () => clock.now * 1000, pendingStorage: storage,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/session')) return Response.json({ sessionToken: 'rpms1_' + 's'.repeat(43), tokenType: 'Bearer', expiresAt: now + 300,
        authorizationVersion: 1, principal: { telegramId: 101, botId: 789 }, features: { version: 1, mutationsEnabled: true, offerActionsEnabled: false } });
      if (url.endsWith('/bootstrap')) return Response.json({ readModelVersion: 1, generatedAt: now, systemRole: 'user',
        partner: { state: 'no_application', legalProfile: null, profile: null, beta: null }, authorization: auth('profile.read_own', now),
        navigation: ['profile', 'offers', 'applications', 'analytics', 'subscription'].map(section => ({ section, enabled: true, reason: null })) });
      if (url.endsWith('/subscription') && packageInvoice) return readState.sessionError
        ? Response.json({ error: 'session_expired' }, { status: 401 }) : Response.json(packageSubscription(now, readState));
      if (url.endsWith('/subscription')) return Response.json(readState.inactive
        ? inactiveSubscription(now, readState.invoiceAvailable) : subscription(now, cancelProducer || reconfirm));
      const body = JSON.parse(init.body);
      if (url.endsWith('/packages/invoice') && packageInvoice) {
        assert.equal(body.confirmation.amountStars, 250); assert.equal(body.confirmation.priceVersion, 3);
        readState.invoiceIssued = true;
        return Response.json({ status: 'issued', packagePayment: true, planCode: 'professional', packageCode: '3m', amountStars: 250,
          accessSeconds: 7776000, periodStartsAt: now, periodEndsAt: now + 7776000, expiresAt: now + 900,
          invoiceURL: PACKAGE_INVOICE, accessApplied: false });
      }
      if (url.endsWith('/subscription/renewal/reconfirm-cancel') || url.endsWith('/subscription/renewal/reconfirm-cancel-status')) {
        const saved = JSON.parse(values.get(STORAGE));
        assert.equal(init.headers['Idempotency-Key'], saved.key); assert.notEqual(saved.key, KEY);
        assert.deepEqual(body, { kind: 'cancel', intent: { contractId: CONTRACT, expectedRevision: 3 }, originalKey: KEY });
        return Response.json({ authority: 'worker', kind: 'cancel', state: url.endsWith('/reconfirm-cancel') ? 'admitted' : readState.reconfirmState,
          originalAttemptId: '44444444-4444-4444-8444-444444444444', attemptId: '55555555-5555-4555-8555-555555555555',
          contractId: CONTRACT, expectedRevision: 3, originalState: 'superseded', accessApplied: false, financialCalls: 0,
          authorization: auth('access.read_own', now) });
      }
      if (url.endsWith('/subscription/renewal/cancel')) {
        if (cancelTimeout) return untilAbort(init.signal);
        if (holdCancel) await released;
        return Response.json({ status: 'confirmed', contractId: CONTRACT, action: 'cancel_renewal',
          paidPeriodChanged: false, providerState: null, cancellationConfirmed: true, reenableAllowed: false,
          accessApplied: false, authorization: auth('access.read_own', now) });
      }
      if (url.endsWith('/subscription/recover')) {
        if (recoverTimeout) return untilAbort(init.signal);
        if (holdRecovery) await released;
        if (recoverError) return Response.json({ error: 'state_conflict' }, { status: 409 });
        if (recoverTerminal) return Response.json({ authority: 'worker', kind: body.kind, state: 'rejected',
          attemptId: 'own-terminal-attempt', contractId: CONTRACT, invoiceUrl: null, effectRecorded: true,
          accessApplied: false, reviewRequired: false, actionAdmissionRequired: true, authorization: auth('access.read_own', now) });
      }
      if (timeoutStatusAfterRecovery && url.endsWith('/subscription/operation-status') &&
          calls.some(call => call.url.endsWith('/subscription/recover'))) return untilAbort(init.signal);
      if ((cancelProducer || reconfirm) && url.endsWith('/subscription/operation-status')) return Response.json({ authority: 'worker',
        kind: body.kind, state: readState.state, attemptId: 'already-attempted', contractId: CONTRACT, invoiceUrl: null,
        effectRecorded: true, accessApplied: false, reviewRequired: true, actionAdmissionRequired: true,
        authorization: auth('access.read_own', now) });
      return Response.json({ authority: 'worker', kind: body.kind, state: 'missing', attemptId: null, contractId: null,
        invoiceUrl: null, effectRecorded: false, accessApplied: false, reviewRequired: false, actionAdmissionRequired: true,
        authorization: auth('access.read_own', now) });
    } });
  await client.authenticate('private-test-init');
  const app = mountCabinet({ document, client, telegram: packageInvoice ? { version: '6.1',
    openInvoice(url, done) { readState.nativeCalls.push(url); done('cancelled'); } } : null });
  t.after(() => app.destroy()); await app.start();
  assert.ok(document.querySelector(packageInvoice ? '[data-package-purchase="professional:3m"]' : reconfirm ? '[data-reconfirm-pending-cancellation]' : cancelProducer ? '[data-renewal-action="cancel"]'
    : '[data-recover-pending-subscription]'), document.getElementById('screen').textContent);
  return { app, client, document, clock, calls, values, release, noticeHistory, readState, button: () => document.querySelector('[data-recover-pending-subscription]'),
    feedback: () => document.querySelector('[data-pending-recovery-status]') };
}

async function startCancellation(f) {
  f.document.querySelector('[data-renewal-action="cancel"]').click(); for (let i = 0; i < 5; i++) await tick();
  const submit = f.document.querySelector('[data-subscription-confirm]'); assert.ok(submit);
  submit.click(); for (let i = 0; i < 5; i++) await tick();
}

async function startReconfirmation(f) {
  assert.equal(f.document.querySelector('[data-renewal-action="cancel"]').disabled, true);
  assert.equal(f.document.querySelector('[data-recover-pending-subscription]'), null);
  f.document.querySelector('[data-reconfirm-pending-cancellation]').click(); for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.calls.filter(call => call.url.endsWith('/reconfirm-cancel') || call.url.endsWith('/renewal/cancel')).length, 0);
  const submit = f.document.querySelector('[data-subscription-confirm]'); assert.ok(submit);
  assert.match(f.document.querySelector('.subscription-dialog').textContent, /Оплаченный срок сохранится/);
  submit.click(); submit.click(); for (let i = 0; i < 5; i++) await tick();
}
async function createPackageInvoice(f) {
  f.document.querySelector('[data-package-purchase="professional:3m"]').click(); for (let i = 0; i < 5; i++) await tick();
  assert.match(f.document.querySelector('.subscription-dialog').textContent, /250 Stars/);
  const consent = f.document.querySelector('.subscription-consent input'); consent.checked = true;
  consent.dispatchEvent(new f.document.defaultView.Event('change'));
  f.document.querySelector('[data-subscription-confirm]').click(); for (let i = 0; i < 8; i++) await tick();
}

test('mounted package invoice250 is revealed above newquote699 options; explicit Open uses the freshly verified same own invoice', async t => {
  const f = await mounted(t, { packageInvoice: true }); await createPackageInvoice(f);
  const page = f.document.querySelector('[data-subscription-screen]'), ownCard = page.querySelector('[data-package-invoice]');
  assert.ok(ownCard); assert.equal(ownCard.previousElementSibling.hasAttribute('data-current-plan'), true);
  assert.equal(ownCard.nextElementSibling.classList.contains('subscription-catalog-details'), true);
  assert.match(ownCard.textContent, /Professional · 250 Stars · 90 дней/); assert.equal(ownCard.revealed, true);
  assert.match(page.querySelector('[data-plan="professional"]').textContent, /699/);
  assert.equal(f.readState.nativeCalls.length, 0); assert.equal(f.values.has('re-package-pending-v1'), false);
  assert.equal(f.calls.filter(c => c.url.endsWith('/packages/invoice')).length, 1);
  const reads = f.calls.filter(c => c.url.endsWith('/subscription')).length;
  ownCard.querySelector('[data-native-invoice-open]').click(); for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(f.readState.nativeCalls, [PACKAGE_INVOICE]);
  assert.equal(f.calls.filter(c => c.url.endsWith('/subscription')).length, reads + 2, 'fresh own check and post-close refresh');
  assert.equal(f.calls.filter(c => c.url.endsWith('/packages/invoice')).length, 1);
});

test('mounted package fresh-open fails closed for expired, unavailable or session-rejected own invoice with zero additional POST', async t => {
  for (const failure of ['invoiceExpired', 'invoiceMissing', 'sessionError']) {
    const f = await mounted(t, { packageInvoice: true }); await createPackageInvoice(f);
    f.readState[failure] = true;
    f.document.querySelector('[data-package-invoice] [data-native-invoice-open]').click(); for (let i = 0; i < 6; i++) await tick();
    assert.equal(f.readState.nativeCalls.length, 0, failure); assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 2, 'session plus one creation only');
    if (failure === 'invoiceExpired') {
      const expired = f.document.querySelector('[data-package-invoice-state="expired"]'); assert.ok(expired);
      assert.equal(expired.previousElementSibling.hasAttribute('data-current-plan'), true);
      assert.equal(expired.nextElementSibling.classList.contains('subscription-catalog-details'), true);
      assert.match(expired.textContent, /250 Stars · 90 дней/); assert.equal(expired.querySelector('[data-native-invoice-open]'), null);
    }
    if (failure === 'invoiceMissing') assert.equal(f.document.querySelector('[data-package-invoice]'), null);
    if (failure === 'sessionError') assert.equal(f.client.authenticated, false);
  }
});

test('inactive DTO accepts the matching server state and still rejects unsupported or mismatched renewal state', () => {
  const now = Math.floor(Date.now() / 1000), data = inactiveSubscription(now);
  assert.equal(data.lifecycle.state, 'refunded'); assert.equal(data.lifecycle.renewalState, 'inactive');
  for (const mismatch of ['unsupported', 'canceled']) {
    const invalid = structuredClone(data);
    if (mismatch === 'unsupported') invalid.lifecycle.renewalState = mismatch;
    else invalid.renewalActions.renewalState = mismatch;
    assert.throws(() => readSubscriptionDTO(invalid, { nowSeconds: now, sessionExpiresAt: now + 300 }), { code: 'invalid_response' });
  }
});

test('inactive server state removes old renewal controls and reminder; prepaid availability follows the actual quote', async t => {
  const f = await mounted(t, { cancelProducer: true }); f.readState.inactive = true;
  f.document.querySelector('.screen-head button').click(); for (let i = 0; i < 5; i++) await tick();
  const card = f.document.querySelector('[data-current-plan]');
  assert.equal(card.getAttribute('data-current-plan'), 'free'); assert.match(card.textContent, /Прежняя подписка неактивна/);
  assert.match(card.textContent, /Возврат учтён/); assert.doesNotMatch(card.textContent, /ПродлениеОтменено/);
  assert.doesNotMatch(card.textContent, /Разрешение получено|Месячное продление|Новый разовый пакет доступен/);
  assert.equal(f.document.querySelector('[data-native-renewal-permission]'), null);
  assert.equal(f.document.querySelector('[data-renewal-action]'), null);
  assert.match(f.document.getElementById('screen').textContent, /Сначала подтвердите отмену прежнего продления/);
  f.readState.invoiceAvailable = true;
  f.document.querySelector('.screen-head button').click(); for (let i = 0; i < 5; i++) await tick();
  assert.match(f.document.querySelector('[data-current-plan]').textContent, /Новый разовый пакет доступен по условиям ниже/);
  assert.equal(f.calls.filter(call => /\/renewal\/|\/packages\//.test(call.url)).length, 0);
});

for (const reconfirm of [false, true]) test((reconfirm ? 'linked' : 'normal') +
  ' terminal status replaces stale uncertainty only after exact own read; inactive alone preserves marker', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await mounted(t, { cancelProducer: !reconfirm, reconfirm, cancelTimeout: true });
  if (reconfirm) await startReconfirmation(f); else await startCancellation(f);
  const original = f.values.get(STORAGE), marker = JSON.parse(original);
  f.clock.now += 45; t.mock.timers.tick(45000); for (let i = 0; i < 5; i++) await tick();
  assert.match(f.feedback().textContent, /Ответ не подтверждён/);
  f.readState.inactive = true; f.readState.invoiceAvailable = true;
  f.readState.state = 'unknown'; f.readState.reconfirmState = 'unknown';
  f.document.querySelector('.screen-head button').click(); for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.values.get(STORAGE), original); assert.equal(f.client.subscriptionOutcomePending, true);
  assert.equal(f.client.verifiedSubscriptionOutcome, null); assert.match(f.feedback().textContent, /Ответ не подтверждён/);
  assert.doesNotMatch(f.document.querySelector('[data-current-plan]').textContent, /Новый разовый пакет доступен/);
  f.readState.state = 'rejected'; f.readState.reconfirmState = 'rejected';
  f.document.querySelector('.screen-head button').click(); for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.values.has(STORAGE), false); assert.equal(f.client.subscriptionOutcomePending, false);
  assert.deepEqual(f.client.verifiedSubscriptionOutcome, { key: marker.key, kind: 'cancel', state: 'rejected' });
  assert.match(f.feedback().textContent, /Сохранённое действие отклонено/);
  assert.doesNotMatch(f.feedback().textContent, /Ответ не подтверждён|могло выполниться/);
  assert.doesNotMatch(f.document.getElementById('notice').textContent, /Ответ не подтверждён|могло выполниться/);
  assert.match(f.document.querySelector('[data-current-plan]').textContent, /Новый разовый пакет доступен по условиям ниже/);
  assert.equal(f.document.querySelector('[data-copy-pending-diagnostics]'), null);
  assert.equal(f.calls.filter(call => call.url.endsWith('/renewal/cancel')).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/reconfirm-cancel')).length, reconfirm ? 1 : 0);
  const read = f.calls.filter(call => call.url.endsWith(reconfirm ? '/reconfirm-cancel-status' : '/operation-status')).at(-1);
  assert.equal(read.init.headers['Idempotency-Key'], marker.key);
  if (reconfirm) assert.equal(JSON.parse(read.init.body).originalKey, KEY);
});

test('mounted reconfirm cancel requires separate consent and one new linked producer completes at 20s without replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await mounted(t, { reconfirm: true, holdCancel: true }); await startReconfirmation(f);
  const saved = JSON.parse(f.values.get(STORAGE)); assert.equal(saved.reconfirm.originalKey, KEY);
  assert.equal(saved.reconfirm.stage, 'producer'); assert.notEqual(saved.key, KEY);
  f.clock.now += 15; t.mock.timers.tick(15000); await tick();
  assert.equal(f.calls.find(call => call.url.endsWith('/renewal/cancel')).init.signal.aborted, false);
  f.clock.now += 5; t.mock.timers.tick(5000); f.release(); for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.client.subscriptionOutcomePending, false); assert.equal(f.values.has(STORAGE), false);
  assert.equal(f.calls.filter(call => call.url.endsWith('/reconfirm-cancel')).length, 1);
  const producer = f.calls.filter(call => call.url.endsWith('/renewal/cancel'));
  assert.equal(producer.length, 1); assert.equal(producer[0].init.headers['Idempotency-Key'], saved.key);
});

test('mounted reconfirm cancel 45s uncertainty keeps card and predecessor Copy; refresh reads link without producer or Recover', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await mounted(t, { reconfirm: true, cancelTimeout: true });
  const card = f.document.querySelector('[data-current-plan]'); await startReconfirmation(f);
  const saved = f.values.get(STORAGE), reads = f.calls.filter(call => call.url.endsWith('/subscription')).length;
  f.clock.now += 45; t.mock.timers.tick(45000); for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.document.querySelector('[data-current-plan]') === card, true);
  assert.match(f.feedback().textContent, /Действие могло выполниться/);
  assert.equal(f.document.getElementById('screen').getAttribute('aria-busy'), 'false');
  assert.equal(f.document.querySelector('.subscription-dialog'), null);
  assert.equal(f.document.querySelector('[data-reconfirm-pending-cancellation]').disabled, true);
  assert.equal(f.values.get(STORAGE), saved); assert.equal(f.client.subscriptionOutcomePending, true);
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription')).length, reads);
  f.document.querySelector('[data-copy-pending-diagnostics]').click(); await tick();
  const copied = JSON.parse(f.document.querySelector('[data-subscription-diagnostics]').value);
  assert.deepEqual(copied.subscription.reconfirm, { originalKey: KEY, originalStartedAt: f.clock.now - 346, stage: 'producer' });
  assert.equal(copied.lastCancellationFailure.timedOut, true); assert.equal(copied.lastCancellationFailure.durationMs, 45000);
  assert.doesNotMatch(JSON.stringify(copied), /private-test-init|rpms1_|Authorization|initData|https:/);
  f.document.querySelector('.screen-head button').click(); for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.client.subscriptionRecoveryState.state, 'pending'); assert.equal(f.client.pendingCancellationReconfirmationMode, null);
  assert.equal(f.document.querySelector('[data-recover-pending-subscription]'), null);
  assert.equal(f.calls.filter(call => call.url.endsWith('/reconfirm-cancel-status')).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/reconfirm-cancel')).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/renewal/cancel')).length, 1);
  assert.equal(f.values.get(STORAGE), saved);
});

test('cancel producer waits past 15s and clears bound marker only on a validated terminal response at 20s', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await mounted(t, { cancelProducer: true, holdCancel: true }); await startCancellation(f);
  const original = f.values.get(STORAGE), saved = JSON.parse(original);
  assert.deepEqual(saved.principal, { telegramId: 101, botId: 789 });
  f.clock.now += 15; t.mock.timers.tick(15000); await tick();
  const request = f.calls.find(call => call.url.endsWith('/subscription/renewal/cancel'));
  assert.equal(request.init.signal.aborted, false); assert.equal(f.values.get(STORAGE), original);
  assert.equal(request.init.headers['Idempotency-Key'], saved.key);
  f.clock.now += 5; t.mock.timers.tick(5000); f.release(); for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.client.subscriptionOutcomePending, false); assert.equal(f.values.has(STORAGE), false);
  assert.equal(f.client.pendingSubscriptionDiagnostics.lastCancellationFailure, null);
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription/renewal/cancel')).length, 1);
});

test('cancel producer 45s uncertainty retains original card and copy without auto read or retry; attempted lookup has no Recover', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await mounted(t, { cancelProducer: true, cancelTimeout: true });
  const card = f.document.querySelector('[data-current-plan]'); await startCancellation(f);
  const original = f.values.get(STORAGE), reads = f.calls.filter(call => call.url.endsWith('/subscription')).length;
  f.clock.now += 15; t.mock.timers.tick(15000); await tick();
  assert.equal(f.calls.find(call => call.url.endsWith('/subscription/renewal/cancel')).init.signal.aborted, false);
  f.clock.now += 30; t.mock.timers.tick(30000); for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.document.querySelector('[data-current-plan]') === card, true);
  assert.match(f.feedback().textContent, /Ответ не подтверждён/);
  assert.equal(f.document.getElementById('screen').getAttribute('aria-busy'), 'false');
  assert.equal(f.document.querySelector('.subscription-dialog'), null);
  assert.equal(f.document.querySelector('[data-renewal-action="cancel"]').disabled, true);
  assert.equal(f.values.get(STORAGE), original); assert.equal(f.client.subscriptionOutcomePending, true);
  const failure = { code: 'outcome_unknown', status: 0, httpStatus: 0, phase: 'fetch', durationMs: 45000, timedOut: true };
  assert.deepEqual(f.client.pendingSubscriptionDiagnostics.lastCancellationFailure, failure);
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription')).length, reads);
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription/operation-status')).length, 0);
  f.document.querySelector('[data-copy-pending-diagnostics]').click(); await tick();
  const copied = JSON.parse(f.document.querySelector('[data-subscription-diagnostics]').value);
  assert.deepEqual(copied.lastCancellationFailure, failure);
  assert.doesNotMatch(JSON.stringify(copied), /private-test-init|rpms1_|Authorization|initData|https:/);
  f.document.querySelector('.screen-head button').click(); for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.client.subscriptionRecoveryState.state, 'pending');
  assert.equal(f.client.pendingSubscriptionRecoveryAvailable, false);
  assert.equal(f.document.querySelector('[data-recover-pending-subscription]'), null);
  assert.equal(f.values.get(STORAGE), original);
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription/renewal/cancel')).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription/recover')).length, 0);
});

test('mounted rendered recovery button explains expiry without POST instead of silently returning', async t => {
  const f = await mounted(t), initial = f.values.get(STORAGE); f.clock.now += 301;
  f.button().click(); await tick();
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription/recover')).length, 0);
  assert.equal(f.values.get(STORAGE), initial);
  assert.match(f.feedback()?.textContent ?? '', /Сессия завершилась/);
  assert.equal(f.feedback().getAttribute('aria-live'), 'polite');
});

test('mounted real recovery HTTP failure keeps card and feedback without an automatic refresh', async t => {
  const f = await mounted(t, { recoverError: true, holdRecovery: true }), original = f.values.get(STORAGE);
  f.button().click(); await tick();
  const loadingText = f.feedback()?.textContent ?? '', loadingDisabled = f.button().disabled;
  f.button().click(); await tick();
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription/recover')).length, 1);
  f.release(); for (let i = 0; i < 5; i++) await tick();
  assert.ok(f.noticeHistory.some(row => row.status === 'error' && /Данные или доступ изменились/.test(row.text)),
    'mounted handler received the real HTTP error');
  assert.match(f.feedback()?.textContent ?? '', /Данные или доступ изменились/);
  assert.match(f.feedback().textContent, /Обновите/);
  assert.equal(f.feedback().getAttribute('aria-live'), 'polite');
  assert.match(loadingText, /Проверяем сохранённое действие/); assert.equal(loadingDisabled, true);
  assert.deepEqual(f.client.pendingSubscriptionDiagnostics.lastRecoveryFailure, { code: 'state_conflict', status: 409,
    httpStatus: 409, phase: 'json', durationMs: 0, timedOut: false });
  assert.equal(f.values.get(STORAGE), original); assert.equal(f.client.subscriptionOutcomePending, true);
  assert.equal(f.calls.filter(call => /\/renewal\//.test(call.url)).length, 0);
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription')).length, 1);
});

test('mounted 45s recovery timeout keeps diagnostic card; explicit read-only refresh still has 15s deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await mounted(t, { recoverTimeout: true, timeoutStatusAfterRecovery: true }), original = f.values.get(STORAGE);
  const card = f.document.querySelector('[data-copy-pending-diagnostics]').parentElement;
  const screen = f.document.getElementById('screen');
  f.button().click(); for (let i = 0; i < 5; i++) await tick();
  f.clock.now += 15; t.mock.timers.tick(15000); for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.calls.find(call => call.url.endsWith('/subscription/recover')).init.signal.aborted, false);
  assert.equal(f.client.pendingSubscriptionDiagnostics.lastRecoveryFailure, null);
  f.clock.now += 29; t.mock.timers.tick(29999); await tick();
  assert.equal(f.button().disabled, true); assert.match(f.feedback().textContent, /Проверяем/);
  f.clock.now += 1; t.mock.timers.tick(1); for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.document.querySelector('[data-copy-pending-diagnostics]')?.parentElement === card, true);
  assert.match(f.feedback().textContent, /Действие могло выполниться/);
  assert.doesNotMatch(screen.textContent, /Обновляем данные/);
  assert.equal(screen.getAttribute('aria-busy'), 'false');
  assert.equal(f.button().getAttribute('aria-busy'), 'false');
  assert.equal(f.button().disabled, true); assert.equal(f.client.pendingSubscriptionRecoveryAvailable, false);
  assert.equal(f.values.get(STORAGE), original); assert.equal(f.client.subscriptionOutcomePending, true);
  const failure = { code: 'outcome_unknown', status: 0, httpStatus: 0, phase: 'fetch', durationMs: 45000, timedOut: true };
  assert.deepEqual(f.client.pendingSubscriptionDiagnostics.lastRecoveryFailure, failure);
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription')).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription/operation-status')).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription/recover')).length, 1);
  assert.equal(f.calls.filter(call => /\/renewal\//.test(call.url)).length, 0);
  f.document.querySelector('[data-copy-pending-diagnostics]').click(); await tick();
  const copied = JSON.parse(f.document.querySelector('[data-subscription-diagnostics]').value);
  assert.deepEqual(copied.lastRecoveryFailure, failure);
  assert.equal(copied.subscription.key, KEY); assert.equal(copied.subscription.intent.contractId, CONTRACT);
  assert.equal(JSON.stringify(copied).includes('private-test-init'), false);
  const refresh = screen.querySelector('.screen-head button'); assert.equal(refresh.textContent, 'Обновить');
  refresh.click(); for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription')).length, 2);
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription/operation-status')).length, 2);
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription/recover')).length, 1);
  assert.equal(f.values.get(STORAGE), original);
  const statusRequest = f.calls.filter(call => call.url.endsWith('/subscription/operation-status')).at(-1);
  f.clock.now += 14; t.mock.timers.tick(14999); await tick();
  assert.equal(statusRequest.init.signal.aborted, false);
  f.clock.now += 1; t.mock.timers.tick(1); for (let i = 0; i < 5; i++) await tick();
  assert.equal(statusRequest.init.signal.aborted, true);
  assert.deepEqual(f.client.pendingSubscriptionDiagnostics.lastRecoveryFailure, failure);
});

test('mounted recover remains pending at 15s and accepts a validated own terminal receipt at 20s exactly once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await mounted(t, { holdRecovery: true, recoverTerminal: true }), original = f.values.get(STORAGE);
  f.button().click(); await tick();
  f.clock.now += 15; t.mock.timers.tick(15000); for (let i = 0; i < 5; i++) await tick();
  const request = f.calls.find(call => call.url.endsWith('/subscription/recover'));
  assert.equal(request.init.signal.aborted, false); assert.equal(f.values.get(STORAGE), original);
  assert.equal(f.client.subscriptionOutcomePending, true); assert.equal(f.button().disabled, true);
  f.clock.now += 5; t.mock.timers.tick(5000); f.release(); for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.client.subscriptionOutcomePending, false); assert.equal(f.values.has(STORAGE), false);
  assert.equal(f.client.pendingSubscriptionDiagnostics.lastRecoveryFailure, null);
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription/recover')).length, 1);
  assert.equal(f.calls.filter(call => /\/renewal\//.test(call.url)).length, 0);
  assert.match(f.feedback().textContent, /Сохранённое действие проверено/);
});
