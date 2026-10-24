import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import './helpers/v1.4.3-p05-offline-network.mjs';
import { MiniAppClient, mountThemeSelector, readSubscriptionDTO } from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';
import { mountCabinet } from '../src/v1.4.0-rebuild/mini-app/cabinet-view.mjs';
import { packageSubscriptionHttpFixture } from './helpers/v1.4.4-package-subscription-http-fixture.mjs';

const requireDom = createRequire(process.env.CABINET_UI_DOM_ROOT ? `${process.env.CABINET_UI_DOM_ROOT}/package.json`
  : new URL('./p08-ui/package.json', import.meta.url));
const { parseHTML } = requireDom('linkedom');
const html = fs.readFileSync(new URL('../src/v1.4.0-rebuild/mini-app/partner-cabinet.html', import.meta.url), 'utf8');
const TERMS = '2026-10-03.stars-recurring-v1';
const tick = () => new Promise(resolve => setImmediate(resolve));
const offer = h => h.data.catalog.recurring.offers.find(item => item.planCode === 'professional');
const chip = (h, code = '30d') => h.document.querySelector(`[data-package-plan="professional"][data-package-duration="${code}"]`);
const plan = h => h.document.querySelector('[data-plan="professional"]');
const purchase = h => plan(h).querySelector('[data-recurring-plan="professional"]');
const producers = h => h.calls.filter(call => call.init.method === 'POST' && !call.url.endsWith('/session') && !call.url.endsWith('/operation-status'));

async function mount(t, { pending = null, blocked = false, blockedPackage = false } = {}) {
  const f = await packageSubscriptionHttpFixture(t);
  // These are actual in-memory server prices, not a visual-fixture quote.
  for (const [planCode, amount] of [['professional', 249], ['dragon', 499]])
    f.sqlite.prepare(`INSERT OR IGNORE INTO price_book(price_id,price_version,plan_code,currency,amount_stars,
      access_seconds,billing_mode,publication_state,terms_revision,valid_from,created_at)
      VALUES(?,1,?,'XTR',?,2592000,'recurring','approved',?,?,?)`)
      .run(`${planCode}-30d-recurring-v1`, planCode, amount, TERMS, f.now - 10000, f.now - 10000);
  const data = structuredClone(await f.read('subscription'));
  assert.equal(data.catalog.recurring.ready, true);
  assert.equal(data.catalog.recurring.offers.find(item => item.planCode === 'professional').amountStars, 249);
  assert.ok(data.packages.offers.some(item => item.packageCode === '3m' && item.amountStars === 699));
  // Reproduce the independently tested compiled owner projection: legacy
  // prepaid is closed while the separately consented monthly offer is present.
  // The underlying subscription and package descriptor comes from real HTTP.
  for (const legacy of data.catalog.offers.filter(item => item.planCode !== 'free')) {
    legacy.purchaseEligibility.eligible = false; legacy.purchaseEligibility.reasonCode = 'purchase_unavailable';
    legacy.checkout.available = false; legacy.checkout.reasonCode = 'purchase_unavailable'; legacy.checkout.url = null;
  }
  if (blocked) for (const recurring of data.catalog.recurring.offers) {
    recurring.purchaseEligibility.eligible = false; recurring.purchaseEligibility.reasonCode = 'subscription_contract_in_progress';
    recurring.checkout.available = false;
  }
  if (blockedPackage) {
    const longer = data.packages.offers.find(item => item.planCode === 'professional' && item.packageCode === '3m');
    longer.invoice.available = false; longer.invoice.reasonCode = 'package_recurring_cancellation_unconfirmed';
  }
  const features = { version: 1, mutationsEnabled: false, offerActionsEnabled: false,
    nativeOwnerInvoiceOnly: true, existingRenewalCancellationEnabled: true };
  data.features = features;
  readSubscriptionDTO(data, { sessionExpiresAt: f.session.expiresAt, nowSeconds: f.now });
  const bootstrap = structuredClone(await f.read('bootstrap')); bootstrap.features = features;
  const { document, window } = parseHTML(html); window.location = { hash: '#subscription' };
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => document._focused ?? document.body });
  window.HTMLElement.prototype.focus = function () { document._focused = this; };
  window.scrollY = 123; window.scrollTo = (x, y) => { window.scrollY = typeof x === 'object' ? x.top : y; };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const values = new Map([['re-program.cabinet.theme.v1', 'dark']]);
  if (pending === 'subscription') values.set('re-subscription-pending-v1', JSON.stringify({ kind: 'invoice', key: '', startedAt: 0 }));
  if (pending === 'package') values.set('re-package-pending-v1', '{}');
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  window.localStorage = storage;
  const calls = [], nativeLinks = [];
  const client = new MiniAppClient({ origin: 'https://thirty-day-buttons.example', now: () => f.now * 1000, pendingStorage: storage,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/session')) return Response.json({ ...f.session, features });
      if (init.method === 'GET') return Response.json(url.endsWith('/bootstrap') ? bootstrap : data);
      assert.ok(url.endsWith('/subscription/recurring-invoice'), 'only the explicitly confirmed monthly invoice is a producer');
      return Response.json({ status: 'confirmed', billingMode: 'recurring', periodSeconds: 2592000,
        invoiceUrl: 'https://t.me/$offlineThirtyDayButtons', accessApplied: false,
        authorization: { ...data.authorization, capability: 'billing.purchase_monthly', allowed: true } });
    } });
  await client.authenticate('offline-thirty-day-buttons');
  const telegram = { version: '8.0', isVersionAtLeast: () => true, openTelegramLink: url => nativeLinks.push(url) };
  const app = mountCabinet({ document, client, telegram });
  const theme = mountThemeSelector({ document, storage, media: window.matchMedia() });
  await app.start();
  const flush = async () => { for (let i = 0; i < 18; i++) await tick(); };
  t.after(() => { app.destroy(); theme.destroy(); });
  return { f, data, document, window, client, app, calls, nativeLinks, flush, storage };
}

test('published monthly quote replaces the closed legacy30d purchase and still requires explicit separate consent', async t => {
  const h = await mount(t); assert.equal(chip(h).disabled, false); chip(h).click();
  assert.equal(chip(h).getAttribute('aria-pressed'), 'true');
  assert.match(plan(h).querySelector('.subscription-price').textContent, /249/u);
  assert.ok(!plan(h).querySelector('[data-purchase-plan]'));
  assert.equal(purchase(h).disabled, false); assert.match(plan(h).textContent, /автопродл|Автомат/iu);
  const before = h.calls.length; purchase(h).focus(); purchase(h).click(); await h.flush();
  assert.ok(h.calls.length > before, 'opening conditions performs a fresh own read');
  const panel = h.document.querySelector('[data-subscription-confirmation]'); assert.ok(panel);
  const checkbox = panel.querySelector('input'); assert.equal(checkbox.checked, false);
  const confirm = panel.querySelector('[data-subscription-confirm]'); assert.equal(confirm.disabled, true);
  confirm.click(); await h.flush(); assert.equal(producers(h).length, 0);
  checkbox.checked = true; checkbox.dispatchEvent(new h.window.Event('change')); confirm.click(); await h.flush();
  assert.equal(producers(h).length, 1); assert.deepEqual(JSON.parse(producers(h)[0].init.body), {
    planCode: 'professional', recurringConsent: true, termsRevision: TERMS, priceVersion: 1 });
  assert.equal(h.nativeLinks.length, 0, 'monthly does not open the closed legacy bot purchase');
  assert.equal(h.document.querySelector('[data-current-plan]').getAttribute('data-current-plan'), 'free');
  assert.equal(h.f.sqlite.prepare('SELECT COUNT(*) n FROM payment_ledger').get().n, 0);
});

for (const pending of ['subscription', 'package']) test(`passive30d selection and conditions remain responsive with ${pending} outcome pending`, async t => {
  const h = await mount(t, { pending }); const monthly = chip(h), longer = chip(h, '3m');
  const longPurchase = plan(h).querySelector('[data-package-purchase="professional:3m"]');
  assert.equal(longPurchase.disabled, false); longPurchase.click(); await h.flush();
  const longDialog = h.document.querySelector('.subscription-dialog'); assert.ok(longDialog);
  assert.ok(!longDialog.querySelector('input')); assert.ok(!longDialog.querySelector('[data-subscription-confirm]'));
  assert.match(longDialog.textContent, /699 Stars/u); assert.equal(producers(h).length, 0);
  [...longDialog.querySelectorAll('button')].find(node => node.textContent === 'Назад').click();
  assert.equal(monthly.disabled, false); monthly.focus(); monthly.click();
  assert.ok(chip(h) === monthly); assert.ok(chip(h, '3m') === longer); assert.equal(monthly.getAttribute('aria-pressed'), 'true');
  assert.equal(purchase(h).disabled, false); purchase(h).click(); await h.flush();
  const dialog = h.document.querySelector('.subscription-dialog'); assert.ok(dialog);
  assert.ok(!dialog.querySelector('input')); assert.ok(!dialog.querySelector('[data-subscription-confirm]'));
  assert.match(dialog.textContent, /уточняется|недоступен/u); assert.equal(producers(h).length, 0);
  if (pending === 'subscription') {
    assert.match(dialog.textContent, /В браузере.*данных для его проверки недостаточно/u);
    assert.ok(!dialog.textContent.includes('Сервер ещё не подтвердил'), 'a damaged browser marker is not a real pending server command');
  } else assert.match(dialog.textContent, /В браузере сохранён запрос пакета/u);
  assert.equal(pending === 'subscription' ? h.client.subscriptionOutcomePending : h.client.packageOutcomePending, true);
});

test('server-blocked prepaid purchase opens its actual package conditions without consent, invoice or changed access', async t => {
  const h = await mount(t, { blockedPackage: true });
  const buy = plan(h).querySelector('[data-package-purchase="professional:3m"]'); assert.equal(buy.disabled, false);
  buy.click(); await h.flush(); const dialog = h.document.querySelector('.subscription-dialog'); assert.ok(dialog);
  assert.match(dialog.textContent, /699 Stars/u); assert.match(dialog.textContent, /90 дней/u);
  assert.ok(dialog.textContent.includes(h.data.packages.offers.find(item => item.planCode === 'professional' && item.packageCode === '3m').terms.text));
  assert.ok(!dialog.querySelector('input')); assert.ok(!dialog.querySelector('[data-subscription-confirm]'));
  assert.equal(producers(h).length, 0); assert.equal(h.document.querySelector('[data-current-plan]').getAttribute('data-current-plan'), 'free');
});

test('server-blocked monthly offer opens actual conditions without presenting a purchase consent or issuing an invoice', async t => {
  const h = await mount(t, { blocked: true }); chip(h).click();
  assert.equal(purchase(h).disabled, false); purchase(h).click(); await h.flush();
  const dialog = h.document.querySelector('.subscription-dialog'); assert.ok(dialog);
  assert.ok(dialog.textContent.includes(h.data.catalog.recurring.terms.text));
  assert.ok(!dialog.querySelector('input')); assert.ok(!dialog.querySelector('[data-subscription-confirm]'));
  assert.equal(producers(h).length, 0);
});

test('monthly amount changed before conditions requires reselection and cannot silently issue an invoice', async t => {
  const h = await mount(t); chip(h).click(); offer(h).amountStars = 250; purchase(h).click(); await h.flush();
  assert.ok(!h.document.querySelector('.subscription-dialog')); assert.equal(producers(h).length, 0);
  assert.match(h.document.getElementById('notice').textContent, /изменились/u);
});

test('monthly eligibility lost after consent blocks final invoice and retains Free access', async t => {
  const h = await mount(t); chip(h).click(); purchase(h).click(); await h.flush();
  const panel = h.document.querySelector('[data-subscription-confirmation]'), checkbox = panel.querySelector('input');
  checkbox.checked = true; checkbox.dispatchEvent(new h.window.Event('change'));
  offer(h).purchaseEligibility.eligible = false; offer(h).purchaseEligibility.reasonCode = 'subscription_contract_in_progress'; offer(h).checkout.available = false;
  panel.querySelector('[data-subscription-confirm]').click(); await h.flush();
  assert.equal(producers(h).length, 0); assert.ok(!h.document.querySelector('.subscription-dialog'));
  assert.equal(h.document.querySelector('[data-current-plan]').getAttribute('data-current-plan'), 'free');
});

test('monthly selection and conditions preserve theme nodes, selected chip, scroll and return focus', async t => {
  const h = await mount(t); const theme = h.document.getElementById('theme-switcher'), nav = h.document.getElementById('navigation');
  const mode = h.document.documentElement.getAttribute('data-theme-mode'); assert.equal(mode, 'dark'); chip(h).click(); chip(h).focus(); h.window.scrollY = 321;
  await h.app.navigate('subscription', { preserveScroll: true });
  assert.ok(h.document.getElementById('theme-switcher') === theme); assert.ok(h.document.getElementById('navigation') === nav);
  assert.equal(h.document.documentElement.getAttribute('data-theme-mode'), mode); assert.equal(h.window.scrollY, 321);
  assert.equal(chip(h).getAttribute('aria-pressed'), 'true'); assert.ok(h.document.activeElement === chip(h));
  const origin = purchase(h); origin.focus(); origin.click(); await h.flush();
  [...h.document.querySelectorAll('.subscription-dialog button')].find(node => node.textContent === 'Назад').click();
  assert.ok(!h.document.querySelector('.subscription-dialog')); assert.ok(h.document.activeElement === origin);
  assert.equal(producers(h).length, 0);
});
