import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import './helpers/v1.4.3-p05-offline-network.mjs';
import { MiniAppClient, readSubscriptionDTO } from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';
import { mountCabinet } from '../src/v1.4.0-rebuild/mini-app/cabinet-view.mjs';
import { createPart3VisualDescriptor } from '../scripts/v1.4.4-part3-visual-preview.mjs';
import { packageSubscriptionHttpFixture } from './helpers/v1.4.4-package-subscription-http-fixture.mjs';

const NOW = 1791327600, ORIGIN = 'https://package-client.example';
const features = { version: 1, mutationsEnabled: false, offerActionsEnabled: false, nativeOwnerInvoiceOnly: true, existingRenewalCancellationEnabled: true };
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
const offer = dto => dto.packages.offers.find(item => item.planCode === 'professional' && item.packageCode === '3m');
const payload = dto => ({ requestedPlanCode: 'professional', packageCode: '3m', confirmation: Object.fromEntries([
  ['acceptedTerms', true], ...['amountStars', 'currency', 'priceVersion', 'offerVersion', 'campaignCode', 'termsRevision'].map(key => [key, offer(dto)[key]])]) });
const invoice = (extra = {}) => ({ status: 'issued', packagePayment: true, orderId: '14400000-0000-4000-8000-000000000011',
  planCode: 'professional', packageCode: '3m', amountStars: 699, accessSeconds: 7776000, periodStartsAt: NOW,
  periodEndsAt: NOW + 7776000, expiresAt: NOW + 900, invoiceURL: 'https://t.me/$offlinePackageClientInvoice', accessApplied: false, ...extra });
async function browser({ dto = null, handler = () => Response.json(invoice()), pendingStorage = storage(),
  principal = { telegramId: 900, botId: 123456789 } } = {}) {
  dto ??= await createPart3VisualDescriptor('professional-offer'); dto = structuredClone(dto); dto.features = features;
  const calls = [], clock = { now: NOW * 1000 };
  const client = new MiniAppClient({ origin: ORIGIN, now: () => clock.now, pendingStorage, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/session')) return Response.json({ sessionToken: 'rpms1_' + 'x'.repeat(43), tokenType: 'Bearer', expiresAt: NOW + 300,
      ...(principal === null ? {} : { principal }), authorizationVersion: 1, features });
    if (url.endsWith('/subscription') && init.method === 'GET') return Response.json(dto);
    return handler(url, init);
  } });
  await client.authenticate('offline-package-client'); await client.read('subscription');
  return { client, dto, calls, clock, pendingStorage };
}
const writes = h => h.calls.filter(call => call.init.method === 'POST' && !call.url.endsWith('/session'));

test('genuine owner HTTP descriptor with disabled six and twelve month terms parses without opening their actions', async t => {
  const f = await packageSubscriptionHttpFixture(t), data = await f.read('subscription');
  const parsed = readSubscriptionDTO(data, { sessionExpiresAt: f.session.expiresAt, nowSeconds: f.now });
  const unavailable = parsed.packages.offers.filter(item => ['6m', '12m'].includes(item.packageCode));
  assert.equal(unavailable.length, 4);
  for (const item of unavailable) {
    assert.equal(item.published, false); assert.equal(item.available, false); assert.equal(item.amountStars, null);
    assert.deepEqual(item.terms, { revision: null, available: false, accepted: false, text: null, telegramCommand: '/terms' });
    assert.equal(item.invoice.available, false); assert.equal(item.schedule.available, false);
  }
  assert.equal(parsed.packages.offers.find(item => item.planCode === 'professional' && item.packageCode === '3m').amountStars, 699);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM subscription_orders').get().count, 0);
});

test('actual mounted subscription navigation consumes genuine HTTP data and keeps unavailable invoice actions closed', async t => {
  const f = await packageSubscriptionHttpFixture(t, { paymentsEnabled: false });
  const requireDom = createRequire(process.env.CABINET_UI_DOM_ROOT ? `${process.env.CABINET_UI_DOM_ROOT}/package.json`
    : new URL('./p08-ui/package.json', import.meta.url));
  const { parseHTML } = requireDom('linkedom'), { document, window } = parseHTML(fs.readFileSync(
    new URL('../src/v1.4.0-rebuild/mini-app/partner-cabinet.html', import.meta.url), 'utf8'));
  window.location = { hash: '' }; window.HTMLElement.prototype.focus = function () {};
  let subscriptionReceived;
  const subscriptionRead = new Promise(resolve => { subscriptionReceived = resolve; });
  const calls = [], client = new MiniAppClient({ origin: ORIGIN, now: () => f.now * 1000, pendingStorage: storage(),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/session')) return Response.json(f.session);
      assert.equal(init.method, 'GET', 'opening a section must not perform a producer action');
      const response = Response.json(await f.read(new URL(url).pathname.split('/').at(-1)));
      if (url.endsWith('/subscription')) subscriptionReceived();
      return response;
    } });
  await client.authenticate('offline-genuine-owner-session');
  const app = mountCabinet({ document, client }); t.after(() => app.destroy()); await app.start();
  assert.equal(document.querySelector('[data-subscription-screen]'), null);
  document.querySelector('[data-section="subscription"]').click();
  await subscriptionRead; await new Promise(resolve => setImmediate(resolve));
  const page = document.querySelector('[data-subscription-screen]');
  assert.ok(page, document.getElementById('screen').textContent);
  assert.equal(document.querySelector('[data-section="subscription"]').getAttribute('aria-current'), 'page');
  assert.equal(document.getElementById('screen').getAttribute('aria-busy'), 'false');
  assert.ok(calls.some(call => call.url.endsWith('/subscription'))); assert.equal(writes({ calls }).length, 0);
  assert.equal(page.querySelector('[data-package-duration="6m"]'), null);
  assert.equal(page.querySelector('[data-package-duration="12m"]'), null);
  for (const button of page.querySelectorAll('[data-purchase-plan], [data-recurring-plan]'))
    assert.equal(button.disabled, true);
  const purchase = page.querySelector('[data-package-purchase="professional:3m"]');
  assert.ok(purchase); assert.equal(purchase.disabled, false, 'published package conditions remain readable while invoice admission is closed');
  const beforeConditions = calls.length;
  const conditionsRead = new Promise(resolve => { subscriptionReceived = resolve; });
  purchase.click(); await conditionsRead;
  for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.length > beforeConditions, 'reading conditions rechecks the current own server descriptor');
  const dialog = document.querySelector('.subscription-dialog'); assert.ok(dialog, document.getElementById('notice').textContent);
  const ownDescriptor = await f.read('subscription');
  const packageTerms = ownDescriptor.packages.offers.find(item => item.planCode === 'professional' && item.packageCode === '3m');
  assert.equal(packageTerms.invoice.available, false);
  assert.ok(dialog.textContent.includes(packageTerms.terms.text));
  assert.match(dialog.textContent, /699 Stars/u); assert.match(dialog.textContent, /90 дней/u);
  assert.ok(!dialog.querySelector('input'), 'blocked invoice cannot present purchase consent');
  assert.ok(!dialog.querySelector('[data-subscription-confirm]'), 'conditions cannot submit an unavailable invoice');
  assert.equal(writes({ calls }).length, 0);
  await assert.rejects(client.packageAction('invoice', { requestedPlanCode: 'professional', packageCode: '6m', confirmation: {} }),
    { code: 'writes_unavailable' });
  assert.equal(writes({ calls }).length, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM subscription_orders').get().count, 0);
});

test('actual old read plus exact additive descriptor preserves closed durations and published comparison without invented savings', async () => {
  const dto = await createPart3VisualDescriptor('professional-offer'), parsed = readSubscriptionDTO(dto);
  assert.equal(offer(parsed).amountStars, 699); assert.equal(offer(parsed).priceComparison.amountStars, 747);
  assert.equal(offer(parsed).priceComparison.basis, 'same_plan_monthly_equivalent');
  assert.equal(parsed.packages.offers.find(item => item.packageCode === '12m').published, false);
  assert.equal(parsed.packages.offers.find(item => item.packageCode === '12m').amountStars, null);
  assert.doesNotMatch(JSON.stringify(parsed.packages), /savings|эконом|ledgerEntryId|telegramId|sourceFingerprint/u);
  assert.ok(Object.isFrozen(parsed.packages.offers[0].preview));
});

test('public descriptor rejects malformed comparison, private source fields, stale time and executable invoice', async () => {
  const source = await createPart3VisualDescriptor('professional-offer');
  for (const edit of [
    dto => { offer(dto).priceComparison.amountStars = 999; }, dto => { offer(dto).priceComparison.savings = 48; },
    dto => { offer(dto).sourceFingerprint = 'a'.repeat(64); }, dto => { dto.packages.validUntil = dto.authorization.validUntil + 1; },
    dto => { offer(dto).preview.endsAt++; }, dto => { offer(dto).invoice.route = '/admin/refund'; },
    dto => { dto.packages.offers.find(item => item.packageCode === '6m').invoice.available = true; },
    dto => { offer(dto).terms.text = null; }, dto => { offer(dto).terms.text = ''; },
    dto => { offer(dto).terms.text = 'x'.repeat(16385); },
    dto => { dto.packages.offers.find(item => item.packageCode === '6m').terms.text = 'Invented unavailable terms'; },
    dto => { dto.packages.offers.find(item => item.packageCode === '6m').terms.available = true; },
    dto => { dto.packages.offers.find(item => item.packageCode === '6m').terms.accepted = true; },
  ]) { const dto = structuredClone(source); edit(dto); assert.throws(() => readSubscriptionDTO(dto), { code: 'invalid_response' }); }
  const dto = structuredClone(source); dto.packages.pendingInvoices = [{ planCode: 'professional', packageCode: '3m', durationDays: 90,
    amountStars: 699, currency: 'XTR', billingMode: 'prepaid', state: 'issued', priceVersion: 1, offerVersion: 'offer-v1', campaignCode: null,
    termsRevision: 'terms-v1', startsAt: NOW, endsAt: NOW + 7776000, datesAreEstimate: true, expiresAt: NOW + 900,
    invoiceUrl: 'javascript:alert(1)', grantsAccess: false }];
  assert.throws(() => readSubscriptionDTO(dto), { code: 'invalid_response' });
});

test('verified current paid Dragon package retains emoji eligibility while future, Preview and reversed states do not gain it', async () => {
  const dto = structuredClone(await createPart3VisualDescriptor('paid-package'));
  dto.access.current.planCode = dto.lifecycle.planCode = dto.access.lifecycle.planCode = 'dragon'; dto.access.current.activeDragon = true;
  dto.authorization.effectivePlan = 'dragon'; dto.packages.paidPeriods[0].planCode = 'dragon';
  dto.catalog.nativeDependencies.dragonEmoji = { available: true, reasonCode: 'eligible', customEmojiId: '123456789' };
  assert.equal(readSubscriptionDTO(dto).catalog.nativeDependencies.dragonEmoji.available, true);
  for (const edit of [data => { data.access.current.previewActive = true; }, data => { data.access.current.accessState = 'refunded'; },
    data => { data.access.current.activeDragon = false; }, data => { data.access.current.sourceKind = 'preview'; }]) {
    const invalid = structuredClone(dto); edit(invalid); assert.throws(() => readSubscriptionDTO(invalid), { code: 'invalid_response' });
  }
});

test('package checkout sends only confirmed selection and immutable displayed offer with authenticated origin and one nonce', async () => {
  const h = await browser(); const result = await h.client.packageAction('invoice', payload(h.dto));
  assert.equal(result.accessApplied, false); assert.equal(result.status, 'issued'); assert.equal(h.client.packageOutcomePending, false);
  const [call] = writes(h); assert.equal(writes(h).length, 1); assert.equal(call.url, ORIGIN + '/api/v1.4.0/cabinet/packages/invoice');
  assert.equal(call.init.headers.Origin, ORIGIN); assert.match(call.init.headers.Authorization, /^Bearer rpms1_/u);
  assert.match(call.init.headers['Idempotency-Key'], /^[a-f0-9]{48}$/u); assert.deepEqual(JSON.parse(call.init.body), payload(h.dto));
  assert.equal(h.client.recoveredPackageInvoice.url, result.invoiceURL);
  assert.equal(h.dto.access.current.planCode, 'free', 'invoice response never changes local access');
});

test('session without a server principal cannot create a package invoice', async () => {
  const h = await browser({ principal: null });
  await assert.rejects(h.client.packageAction('invoice', payload(h.dto)), { code: 'writes_unavailable' });
  assert.equal(writes(h).length, 0);
});

test('unchecked consent, client actor/date additions, changed price and an expired descriptor produce no POST', async () => {
  for (const edit of [
    value => { value.confirmation.acceptedTerms = false; }, value => { value.confirmation.telegramId = 900; },
    value => { value.startsAt = NOW; }, value => { value.confirmation.amountStars = 499; },
    value => { value.confirmation.priceVersion++; }, value => { value.confirmation.termsRevision = 'other-terms'; },
  ]) { const h = await browser(), body = payload(h.dto); edit(body); await assert.rejects(h.client.packageAction('invoice', body)); assert.equal(writes(h).length, 0); }
  const h = await browser(); h.clock.now = (NOW + 61) * 1000;
  await assert.rejects(h.client.packageAction('invoice', payload(h.dto)), { code: 'writes_unavailable' }); assert.equal(writes(h).length, 0);
});

test('different or failed read closes the previous package descriptor', async () => {
  const h = await browser({ handler: () => Response.json({ readModelVersion: 1, error: 'unavailable' }, { status: 503 }) });
  await assert.rejects(h.client.read('profile')); await assert.rejects(h.client.packageAction('invoice', payload(h.dto)), { code: 'writes_unavailable' });
  assert.equal(writes(h).length, 0);
});

test('lost result survives reopening and recovery replays the exact body/key without a second provider invoice attempt', async () => {
  const pendingStorage = storage(), seen = new Map(); let providerAttempts = 0, lose = true;
  const handler = (_url, init) => { const key = init.headers['Idempotency-Key']; if (!seen.has(key)) { providerAttempts++; seen.set(key, init.body); }
    assert.equal(seen.get(key), init.body); if (lose) { lose = false; throw new TypeError('response lost after commit'); } return Response.json(invoice({ duplicate: true })); };
  const first = await browser({ handler, pendingStorage });
  await assert.rejects(first.client.packageAction('invoice', payload(first.dto)), { code: 'package_outcome_unknown' });
  assert.equal(first.client.packageOutcomePending, true); assert.ok(pendingStorage.getItem('re-package-pending-v1'));
  await assert.rejects(first.client.subscriptionAction('invoice', {}), { code: 'package_outcome_unknown' });
  const second = await browser({ handler, pendingStorage }); const result = await second.client.recoverPackageAction();
  assert.equal(result.status, 'issued'); assert.equal(providerAttempts, 1); assert.equal(second.client.packageOutcomePending, false);
  assert.equal(pendingStorage.getItem('re-package-pending-v1'), null);
  assert.equal(writes(first)[0].init.headers['Idempotency-Key'], writes(second)[0].init.headers['Idempotency-Key']);
  assert.equal(writes(first)[0].init.body, writes(second)[0].init.body);
});

test('manual review and malformed successful result remain unknown and block a new operation', async () => {
  for (const result of [invoice({ status: 'manual_review', invoiceURL: null, reason: 'package_invoice_issuance_unknown' }),
    invoice({ amountStars: 1 }), invoice({ accessApplied: true }), invoice({ invoiceURL: 'https://t.me.evil.example/$invoice' })]) {
    const h = await browser({ handler: () => Response.json(result) });
    if (result.status === 'manual_review') assert.equal((await h.client.packageAction('invoice', payload(h.dto))).status, 'manual_review');
    else await assert.rejects(h.client.packageAction('invoice', payload(h.dto)), { code: 'package_outcome_unknown' });
    assert.equal(h.client.packageOutcomePending, true); await assert.rejects(h.client.packageAction('invoice', payload(h.dto)));
    assert.equal(writes(h).length, 1);
  }
});

test('an unresolved recovered conflict remains locked instead of issuing a fresh nonce', async () => {
  let attempt = 0; const h = await browser({ handler: () => ++attempt === 1 ? Promise.reject(new TypeError('lost'))
    : Response.json({ error: 'package_transition_source_changed' }, { status: 409 }) });
  await assert.rejects(h.client.packageAction('invoice', payload(h.dto))); await assert.rejects(h.client.recoverPackageAction(), { code: 'package_outcome_unknown' });
  assert.equal(h.client.packageOutcomePending, true); assert.equal(writes(h)[0].init.headers['Idempotency-Key'], writes(h)[1].init.headers['Idempotency-Key']);
});

test('a corrupted persistent operation cannot choose another route or produce a recovery POST', async () => {
  for (const kind of ['../refund', 'quote', 'refund', 'monthly-invoice/../../admin']) {
    const pendingStorage = storage(); pendingStorage.setItem('re-package-pending-v1', JSON.stringify({ kind, key: 'a'.repeat(48), startedAt: NOW,
      intent: { transitionId: '14400000-0000-4000-8000-000000000014', expectedRevision: 1, recurringConsent: true, termsRevision: 'terms-v1', priceVersion: 1 } }));
    const h = await browser({ pendingStorage }); await assert.rejects(h.client.recoverPackageAction()); assert.equal(writes(h).length, 0);
    assert.equal(h.client.packageOutcomePending, true);
  }
});

test('cancellation is a revision-bound intent action and makes no refund or paid-access claim', async () => {
  const dto = await createPart3VisualDescriptor('future-transition'), transition = dto.packages.transitions[0];
  const h = await browser({ dto, handler: () => Response.json({ transition: { transitionId: transition.transitionId, revision: 2, state: 'cancelled',
    accessApplied: false, refundApplied: false }, replayed: false, accessApplied: false, refundApplied: false }) });
  const result = await h.client.packageAction('cancel', { transitionId: transition.transitionId, expectedRevision: 1 });
  assert.equal(result.refundApplied, false); assert.deepEqual(JSON.parse(writes(h)[0].init.body), { transitionId: transition.transitionId, expectedRevision: 1 });
  assert.equal(h.dto.access.current.planCode, 'professional'); assert.equal(h.client.packageOutcomePending, false);
});

test('monthly transition requires its fresh boundary descriptor and new recurring consent', async () => {
  const dto = await createPart3VisualDescriptor('professional-offer'), template = (await createPart3VisualDescriptor('future-transition')).packages.transitions[0];
  const transition = { ...structuredClone(template), effectiveAt: NOW, status: 'ready_for_consent', monthlyCheckout: {
    ...template.monthlyCheckout, available: true, reasonCode: null, expiresAt: NOW + 900 } }; dto.packages.transitions = [transition];
  const h = await browser({ dto, handler: () => Response.json({ status: 'confirmed', requestId: '14400000-0000-4000-8000-000000000015',
    contractId: '14400000-0000-4000-8000-000000000016', orderId: '14400000-0000-4000-8000-000000000017', transitionId: transition.transitionId,
    billingMode: 'recurring', periodSeconds: 2592000, invoiceUrl: 'https://t.me/$offlineMonthlyTransitionInvoice', reviewRequired: false, accessApplied: false }) });
  const intent = { transitionId: transition.transitionId, expectedRevision: 1, recurringConsent: true, termsRevision: transition.monthlyCheckout.termsRevision, priceVersion: 1 };
  await assert.rejects(h.client.packageAction('monthly-invoice', { ...intent, recurringConsent: false }), { code: 'invalid_request' });
  const result = await h.client.packageAction('monthly-invoice', intent); assert.equal(result.accessApplied, false);
  assert.equal(writes(h).length, 1); assert.equal(writes(h)[0].url, ORIGIN + '/api/v1.4.0/cabinet/packages/monthly-invoice');
});
