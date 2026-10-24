import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import './helpers/v1.4.3-p05-offline-network.mjs';
import { MiniAppClient, mountThemeSelector } from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';
import { mountCabinet } from '../src/v1.4.0-rebuild/mini-app/cabinet-view.mjs';
import { renderSubscriptionScreen } from '../src/v1.4.0-rebuild/mini-app/subscription-view.mjs';
import { createPart3VisualDescriptor } from '../scripts/v1.4.4-part3-visual-preview.mjs';

const requireDom = createRequire(process.env.CABINET_UI_DOM_ROOT ? `${process.env.CABINET_UI_DOM_ROOT}/package.json` : new URL('./p08-ui/package.json', import.meta.url));
const { parseHTML } = requireDom('linkedom');
const html = fs.readFileSync(new URL('../src/v1.4.0-rebuild/mini-app/partner-cabinet.html', import.meta.url), 'utf8');
const NOW = 1791327600, features = { version: 1, mutationsEnabled: false, offerActionsEnabled: false, nativeOwnerInvoiceOnly: true, existingRenewalCancellationEnabled: true };
const tick = () => new Promise(resolve => setImmediate(resolve));
const packageOffer = data => data.packages.offers.find(item => item.planCode === 'professional' && item.packageCode === '3m');
const invoiceDescriptor = () => ({ planCode: 'professional', packageCode: '3m', durationDays: 90, amountStars: 699, currency: 'XTR', billingMode: 'prepaid', state: 'issued',
  priceVersion: 1, offerVersion: '2026-10-06.packages-v1', campaignCode: null, termsRevision: '2026-10-06.packages-v1', startsAt: NOW,
  endsAt: NOW + 7776000, datesAreEstimate: true, expiresAt: NOW + 900, invoiceUrl: 'https://t.me/$offlineViewPackageInvoice', grantsAccess: false });
async function mount(t, { state = 'professional-offer', onPost = null, edit = null, nativeInvoice = null } = {}) {
  const data = structuredClone(await createPart3VisualDescriptor(state)); data.features = features; edit?.(data);
  const actualNow = Date.now; Date.now = () => NOW * 1000; t.after(() => { Date.now = actualNow; });
  const { document, window } = parseHTML(html); window.location = { hash: '#subscription' };
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => document._focused ?? document.body });
  window.HTMLElement.prototype.focus = function () { document._focused = this; };
  window.HTMLElement.prototype.reportValidity = () => true;
  const values = new Map([['re-subscription-receipt-seen-v1', JSON.stringify(data.history.items.map(item => item.receiptId))]]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  window.localStorage = storage; window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.scrollY = 127; window.scrollTo = (_x, y) => { window.scrollY = typeof _x === 'object' ? _x.top : y; };
  const calls = [], bootstrap = { readModelVersion: 1, authorization: { ...data.authorization, capability: 'profile.read_own' }, features, systemRole: 'user',
    partner: { state: 'no_application', application: null, profile: null, legalProfile: null, beta: null, actions: {} },
    navigation: ['profile', 'offers', 'applications', 'analytics', 'subscription'].map(section => ({ section, enabled: section !== 'analytics', reason: null })),
    counts: { visibleOffers: 0, ownOffers: 0, ownApplications: 0, attributedApplications: 0 } };
  const client = new MiniAppClient({ origin: 'https://package-view.example', now: () => NOW * 1000, pendingStorage: storage,
    fetchImpl: async (url, init) => { calls.push({ url, init });
      if (url.endsWith('/session')) return Response.json({ sessionToken: 'rpms1_' + 'v'.repeat(43), tokenType: 'Bearer', expiresAt: NOW + 300,
        principal: { telegramId: 900, botId: 123456789 }, authorizationVersion: 1, features });
      if (init.method === 'GET') return Response.json(url.endsWith('/bootstrap') ? bootstrap : data);
      return onPost ? onPost(url, init, data) : Response.json({ error: 'offline_producer_not_expected' }, { status: 409 });
    } });
  await client.authenticate('offline-view-session');
  const telegram = nativeInvoice ? { version: '8.0', isVersionAtLeast: () => true, openInvoice: nativeInvoice } : null;
  const app = mountCabinet({ document, client, telegram }), theme = mountThemeSelector({ document, storage, media: window.matchMedia() });
  await app.start(); const flush = async () => { for (let i = 0; i < 24; i++) await tick(); };
  t.after(() => { app.destroy(); theme.destroy(); });
  return { data, document, window, client, app, calls, flush, storage };
}
const writes = h => h.calls.filter(call => call.init.method === 'POST' && !call.url.endsWith('/session'));
const byText = (document, text) => [...document.querySelectorAll('button')].find(node => node.textContent === text);

test('package catalogue keeps full accepted sections, identities and noninteractive truthful 747 versus 699 comparison', async t => {
  const h = await mount(t), page = h.document.querySelector('[data-subscription-screen]');
  for (const selector of ['.subscription-catalog-details', '.subscription-monthly', '.subscription-history', '.subscription-capacity-details', '.subscription-preview-details', '.subscription-telegram-details']) {
    assert.ok(page.querySelector(selector)); assert.equal(page.querySelector(selector).closest('details'), null);
  }
  const professional = page.querySelector('[data-plan="professional"]');
  assert.equal(professional.querySelector('.subscription-price').textContent, '699 ⭐');
  assert.equal(professional.querySelector('.subscription-price-comparison s').textContent, '747 ⭐');
  assert.equal(professional.querySelector('.subscription-price-comparison s').closest('button,a'), null);
  assert.match(professional.querySelector('.subscription-price-comparison').textContent, /3 × 30 дней/u);
  assert.equal(page.querySelector('[data-package-duration="6m"]'), null); assert.equal(page.querySelector('[data-package-duration="12m"]'), null);
  assert.ok(page.querySelector('.subscription-plan-free')); assert.ok(page.querySelector('.subscription-plan-dragon'));
  assert.doesNotMatch(page.textContent, /эконом|48\s*(?:⭐|Stars)|999/u); assert.equal(writes(h).length, 0);
});

test('duration choice reuses chip nodes and preserves the accepted 30-day manual checkout', async t => {
  const h = await mount(t), selector = code => h.document.querySelector(`[data-package-plan="professional"][data-package-duration="${code}"]`);
  const long = selector('3m'), monthly = selector('30d'); monthly.focus(); monthly.click();
  assert.equal(selector('30d'), monthly); assert.equal(selector('3m'), long); assert.equal(monthly.getAttribute('aria-pressed'), 'true');
  assert.equal(h.document.querySelector('[data-plan="professional"] .subscription-price').textContent, '249 Stars');
  assert.ok(h.document.querySelector('[data-purchase-plan="professional"]')); assert.equal(h.document.querySelector('[data-plan="professional"] .subscription-price-comparison'), null);
  long.click(); assert.equal(long.getAttribute('aria-pressed'), 'true'); assert.equal(monthly.getAttribute('aria-pressed'), 'false');
  assert.equal(h.document.querySelector('[data-plan="professional"] .subscription-price').textContent, '699 ⭐'); assert.equal(writes(h).length, 0);
});

test('fresh own read keeps theme controls, selected duration, focus, scroll and expanded own receipt', async t => {
  const h = await mount(t, { state: 'paid-package' }), receipt = h.document.querySelector('.subscription-receipt'); receipt.setAttribute('open', '');
  const chip = h.document.querySelector('[data-package-plan="professional"][data-package-duration="30d"]'); chip.click(); chip.focus();
  const themeNode = h.document.getElementById('theme-switcher'), navigation = h.document.getElementById('navigation');
  const mode = h.document.documentElement.getAttribute('data-theme-mode'); h.window.scrollY = 321;
  await h.app.navigate('subscription', { preserveScroll: true });
  assert.equal(h.document.getElementById('theme-switcher'), themeNode); assert.equal(h.document.getElementById('navigation'), navigation);
  assert.equal(h.document.documentElement.getAttribute('data-theme-mode'), mode); assert.equal(h.window.scrollY, 321);
  const selected = h.document.querySelector('[data-package-plan="professional"][data-package-duration="30d"]');
  assert.equal(selected.getAttribute('aria-pressed'), 'true'); assert.equal(h.document.activeElement, selected);
  assert.equal(h.document.querySelector('.subscription-receipt').hasAttribute('open'), true); assert.equal(writes(h).length, 0);
});

test('package dialog starts with unchecked consent, retains its node on passive refresh and Back or Escape sends nothing', async t => {
  const h = await mount(t); h.document.querySelector('[data-package-purchase="professional:3m"]').click(); await h.flush();
  const dialog = h.document.querySelector('.subscription-dialog'), panel = dialog.querySelector('[data-subscription-confirmation]');
  assert.equal(panel.querySelector('input').checked, false); assert.equal(panel.querySelector('[data-subscription-confirm]').disabled, true);
  assert.match(panel.textContent, /90 дней/u); assert.match(panel.textContent, /699 Stars/u); assert.match(panel.textContent, /Без автосписаний/u); assert.match(panel.textContent, /МСК/u);
  panel.querySelector('[data-subscription-confirm]').click(); await h.flush(); assert.equal(writes(h).length, 0);
  const reads = h.calls.length; await h.app.navigate('subscription', { preserveScroll: true });
  assert.equal(h.calls.length, reads); assert.equal(h.document.querySelector('.subscription-dialog'), dialog); assert.equal(h.document.activeElement, panel);
  byText(h.document, 'Назад').click(); assert.equal(h.document.querySelector('.subscription-dialog'), null); assert.equal(writes(h).length, 0);
  h.document.querySelector('[data-package-purchase="professional:3m"]').click(); await h.flush();
  const event = new h.window.Event('keydown', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'key', { value: 'Escape' });
  h.document.querySelector('.subscription-dialog').dispatchEvent(event); assert.equal(h.document.querySelector('.subscription-dialog'), null);
});

test('price changes before opening or after consent close the stale dialog without a financial POST', async t => {
  const h = await mount(t); packageOffer(h.data).amountStars = 709;
  h.document.querySelector('[data-package-purchase="professional:3m"]').click(); await h.flush();
  assert.equal(h.document.querySelector('.subscription-dialog'), null); assert.equal(writes(h).length, 0);
  h.document.querySelector('[data-package-purchase="professional:3m"]').click(); await h.flush();
  const panel = h.document.querySelector('[data-subscription-confirmation]'), checkbox = panel.querySelector('input');
  checkbox.checked = true; checkbox.dispatchEvent(new h.window.Event('change')); packageOffer(h.data).termsRevision = 'changed-package-terms'; packageOffer(h.data).terms.revision = 'changed-package-terms';
  panel.querySelector('[data-subscription-confirm]').click(); await h.flush();
  assert.equal(h.document.querySelector('.subscription-dialog'), null); assert.equal(writes(h).length, 0);
});

test('explicit package confirmation creates a genuine-shaped saved invoice; SDK paid hint still leaves access Free until server confirmation', async t => {
  let opens = 0;
  const h = await mount(t, { nativeInvoice: (url, done) => { opens++; assert.equal(url, invoiceDescriptor().invoiceUrl); done('paid'); }, onPost: (_url, init, data) => {
    const body = JSON.parse(init.body); assert.equal(body.confirmation.acceptedTerms, true); assert.equal(body.confirmation.amountStars, 699);
    data.packages.pendingInvoices = [invoiceDescriptor()]; packageOffer(data).invoice = { ...packageOffer(data).invoice, available: false, reasonCode: 'payment_order_in_progress' };
    return Response.json({ status: 'issued', packagePayment: true, orderId: '14400000-0000-4000-8000-000000000014', planCode: 'professional', packageCode: '3m',
      amountStars: 699, accessSeconds: 7776000, periodStartsAt: NOW, periodEndsAt: NOW + 7776000, expiresAt: NOW + 900,
      invoiceURL: invoiceDescriptor().invoiceUrl, accessApplied: false });
  } });
  h.document.querySelector('[data-package-purchase="professional:3m"]').click(); await h.flush();
  const panel = h.document.querySelector('[data-subscription-confirmation]'), checkbox = panel.querySelector('input'); checkbox.checked = true; checkbox.dispatchEvent(new h.window.Event('change'));
  panel.querySelector('[data-subscription-confirm]').click(); await h.flush();
  assert.equal(writes(h).length, 1); assert.equal(h.document.querySelector('.subscription-dialog'), null);
  assert.ok(h.document.querySelector('[data-package-invoice]')); assert.equal(h.document.querySelector('[data-current-plan]').getAttribute('data-current-plan'), 'free');
  h.document.querySelector('[data-package-invoice] [data-native-invoice-open]').click(); await h.flush();
  assert.equal(opens, 1); assert.equal(writes(h).length, 1); assert.equal(h.document.querySelector('[data-current-plan]').getAttribute('data-current-plan'), 'free');
  assert.ok(h.document.querySelector('[data-pending-receipt]')); assert.equal(h.document.querySelector('.subscription-receipt-featured'), null);
});

test('cancel intent uses a separate confirmation, exact revision and preserves current paid access', async t => {
  const h = await mount(t, { state: 'future-transition', onPost: (url, init, data) => {
    assert.ok(url.endsWith('/packages/cancel')); const target = data.packages.transitions[0]; assert.deepEqual(JSON.parse(init.body), { transitionId: target.transitionId, expectedRevision: 1 });
    target.revision = 2; target.state = 'cancelled'; target.status = 'cancelled'; target.cancel.available = false; target.cancel.reasonCode = 'package_transition_closed';
    return Response.json({ transition: { transitionId: target.transitionId, revision: 2, state: 'cancelled', accessApplied: false, refundApplied: false }, replayed: false, accessApplied: false, refundApplied: false });
  } });
  h.document.querySelector('[data-transition-cancel]').click(); await h.flush(); const panel = h.document.querySelector('[data-subscription-confirmation]');
  assert.equal(panel.querySelector('input'), null); assert.match(panel.textContent, /не возвращает Stars/u); assert.equal(writes(h).length, 0);
  panel.querySelector('[data-subscription-confirm]').click(); await h.flush(); assert.equal(writes(h).length, 1);
  assert.equal(h.document.querySelector('[data-current-plan]').getAttribute('data-current-plan'), 'professional'); assert.equal(h.document.querySelector('[data-transition-cancel]'), null);
});

test('expired and retained monthly intents describe a recovery limit without promising refund-as-cancel', async t => {
  for (const status of ['expired_reservation', 'manual_review', 'payment_recorded']) {
    const data = await createPart3VisualDescriptor('future-transition'), { document } = parseHTML('<html><body></body></html>');
    const transition = data.packages.transitions[0]; transition.status = status; transition.cancel.available = status === 'expired_reservation';
    transition.monthlyCheckout.reasonCode = status === 'expired_reservation' ? 'monthly_reservation_expired_or_closed' : 'monthly_old_contract_provider_confirmation_required';
    const page = renderSubscriptionScreen({ document, data, onCancelTransition() {} });
    assert.equal(page.querySelector('[data-transition-monthly]'), null);
    assert.match(page.textContent, status === 'expired_reservation' ? /Отмените просроченное изменение/u : /Возврат Stars не подтверждает отмену/u);
    assert.doesNotMatch(page.textContent, /Продление включено|Автоматически освобод|Stars возвращены/u);
  }
});

test('a paid future package stays separate from the current plan and retains exact receipt dates', async t => {
  const data = await createPart3VisualDescriptor('paid-package'), { document } = parseHTML('<html><body></body></html>');
  const period = data.packages.paidPeriods[0]; period.state = period.accessState = 'future'; period.grantsCurrentAccess = false; period.startsAt = NOW + 2592000; period.endsAt = period.startsAt + 7776000;
  const receipt = { ...data.history.items[0].receipt, paidPeriod: { startsAt: period.startsAt, endsAt: period.endsAt } };
  const page = renderSubscriptionScreen({ document, data, receiptPresentation: { receipt, remainingCount: 0 } });
  assert.match(page.querySelector('[data-future-package]').textContent, /Оплачен · начнётся позже.*До этой даты действует/su);
  assert.match(page.querySelector('.subscription-receipt-paper').textContent, /Новый тариф начнёт действовать с указанной даты/u);
  assert.equal(page.querySelector('[data-current-plan]').getAttribute('data-current-plan'), 'professional');
});

test('reopening an own saved invoice rechecks source freshness and blocks an expired or removed invoice before native UI', async t => {
  let opens = 0; const h = await mount(t, { nativeInvoice: (_url, done) => { opens++; done('paid'); }, edit: data => { data.packages.pendingInvoices = [invoiceDescriptor()]; } });
  assert.ok(h.document.querySelector('[data-package-invoice]')); h.data.packages.pendingInvoices = [];
  h.document.querySelector('[data-package-invoice] [data-native-invoice-open]').click(); await h.flush(); assert.equal(opens, 0); assert.equal(writes(h).length, 0);
  assert.equal(h.document.querySelector('[data-package-invoice]'), null);
});
