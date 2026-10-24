import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { mountThemeSelector, CABINET_THEME_STORAGE_KEY } from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';
import { createOfflineSubscriptionVisual } from '../scripts/v1.4.3-native40-ui-preview.mjs';
import { authorizeOwnStarsSubscriptionCommand } from '../src/v1.4.3/subscription-action-authority.mjs';
import { requestOwnStarsSubscriptionCommand } from '../src/v1.4.3/telegram-subscription-provider.mjs';
import { handleStarsRefundedPaymentUpdate } from '../src/v1.3.6/stars-access-runtime.mjs';

const requireDom = createRequire(process.env.CABINET_UI_DOM_ROOT
  ? `${process.env.CABINET_UI_DOM_ROOT}/package.json` : new URL('./p08-ui/package.json', import.meta.url));
const { parseHTML } = requireDom('linkedom');
const html = fs.readFileSync(new URL('../src/v1.4.0-rebuild/mini-app/partner-cabinet.html', import.meta.url), 'utf8');
const bootstrap = fs.readFileSync(new URL('../src/v1.4.0-rebuild/mini-app/cabinet-theme-bootstrap.js', import.meta.url), 'utf8');
const storageFixture = (value = null) => {
  const values = new Map(value === null ? [] : [[CABINET_THEME_STORAGE_KEY, value]]), reads = [], writes = [];
  return { values, reads, writes, getItem(key) { reads.push(key); return values.get(key) ?? null; },
    setItem(key, next) { writes.push([key, next]); values.set(key, next); } };
};
const themeButton = (document, mode) => document.querySelector(`[data-theme-value="${mode}"]`);
const runBootstrap = ({ value = null, dark = false, denied = false } = {}) => {
  const { document } = parseHTML(html), storage = storageFixture(value);
  const window = { matchMedia: () => ({ matches: dark }) };
  if (denied) Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  else window.localStorage = storage;
  vm.runInNewContext(bootstrap, { document, window });
  return { document, window, storage };
};
const themeFor = (t, h, storage = storageFixture()) => {
  const controller = mountThemeSelector({ document: h.document, storage, media: null });
  t.after(() => controller.destroy());
  return { controller, storage };
};
const financialPosts = h => h.calls.filter(call => call.init.method === 'POST' && !call.url.endsWith('/session'));

test('saved dark preference colours the existing loader before stylesheet and module execution', () => {
  const { document, storage } = runBootstrap({ value: 'dark' });
  assert.equal(document.documentElement.getAttribute('data-launch-state'), 'loading');
  assert.equal(document.documentElement.getAttribute('data-color-theme'), 'dark');
  assert.equal(document.documentElement.getAttribute('data-theme-mode'), 'dark');
  const scripts = [...document.head.children];
  const script = scripts.find(node => node.getAttribute('src') === './cabinet-theme-bootstrap.js');
  assert.ok(scripts.indexOf(script) < scripts.findIndex(node => node.getAttribute('rel') === 'stylesheet'));
  assert.equal(script.hasAttribute('defer'), false); assert.equal(script.hasAttribute('async'), false);
  assert.equal(script.hasAttribute('type'), false);
  assert.deepEqual(storage.reads, [CABINET_THEME_STORAGE_KEY]); assert.deepEqual(storage.writes, []);
});

test('pre-paint system mode uses device colour scheme and corrupt storage has the normal light fallback', () => {
  for (const dark of [false, true]) {
    const { document } = runBootstrap({ value: 'system', dark });
    assert.equal(document.documentElement.getAttribute('data-theme-mode'), 'system');
    assert.equal(document.documentElement.getAttribute('data-color-theme'), dark ? 'dark' : 'light');
  }
  for (const value of ['professional', '{"sessionToken":"invalid"}', '', 'DARK']) {
    const { document } = runBootstrap({ value, dark: true });
    assert.equal(document.documentElement.getAttribute('data-theme-mode'), 'light');
    assert.equal(document.documentElement.getAttribute('data-color-theme'), 'light');
  }
});

test('storage access or writes denied leave working theme selection and do not block the cabinet', () => {
  const { document } = runBootstrap({ denied: true });
  Object.defineProperty(document, 'defaultView', { configurable: true, value: { get localStorage() { throw new Error('denied'); } } });
  const controller = mountThemeSelector({ document, media: null });
  themeButton(document, 'dark').click();
  assert.equal(controller.mode, 'dark'); assert.equal(document.documentElement.getAttribute('data-color-theme'), 'dark');
  controller.destroy();
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const next = mountThemeSelector({ document, media: null, storage: throwing });
  assert.equal(next.mode, 'dark', 'a restored in-document choice also survives remount without storage');
  themeButton(document, 'light').click(); assert.equal(next.mode, 'light'); next.destroy();
});

test('selector persists only an appearance word and remount keeps its active button', () => {
  const { document } = parseHTML(html), storage = storageFixture();
  let controller = mountThemeSelector({ document, media: null, storage });
  themeButton(document, 'dark').click(); controller.destroy();
  controller = mountThemeSelector({ document, media: null, storage });
  assert.equal(controller.mode, 'dark');
  assert.equal(themeButton(document, 'dark').getAttribute('aria-pressed'), 'true');
  assert.equal(themeButton(document, 'light').getAttribute('aria-pressed'), 'false');
  assert.deepEqual([...storage.values], [[CABINET_THEME_STORAGE_KEY, 'dark']]);
  assert.deepEqual(storage.writes, [[CABINET_THEME_STORAGE_KEY, 'dark']]); controller.destroy();
});

test('explicit saved theme ignores host changes; saved system follows them without writing account state', () => {
  const { document } = parseHTML(html), callbacks = new Map(), storage = storageFixture('dark');
  const telegram = { colorScheme: 'light', onEvent: (key, callback) => callbacks.set(key, callback),
    offEvent: key => callbacks.delete(key) };
  const controller = mountThemeSelector({ document, telegram, media: null, storage });
  callbacks.get('themeChanged')(); assert.equal(document.documentElement.getAttribute('data-color-theme'), 'dark');
  themeButton(document, 'system').click(); assert.equal(document.documentElement.getAttribute('data-color-theme'), 'light');
  telegram.colorScheme = 'dark'; callbacks.get('themeChanged')();
  assert.equal(document.documentElement.getAttribute('data-color-theme'), 'dark');
  assert.deepEqual(storage.writes, [[CABINET_THEME_STORAGE_KEY, 'system']]);
  controller.destroy(); assert.equal(callbacks.size, 0);
});

test('subscription status refresh retains dark selection, open terms/receipt, focus and scroll with GET only', async t => {
  const h = await createOfflineSubscriptionVisual({ after: callback => t.after(callback) }); themeFor(t, h);
  const navigation = [...h.document.querySelectorAll('#navigation button')];
  themeButton(h.document, 'dark').click();
  const terms = h.document.querySelector('.subscription-payment-help details.subscription-terms');
  const receipt = h.document.querySelector('details[data-receipt-id]');
  terms.setAttribute('open', ''); receipt.setAttribute('open', '');
  const receiptId = receipt.getAttribute('data-receipt-id'); receipt.querySelector('summary').focus();
  let scroll = 777;
  Object.defineProperty(h.window, 'scrollY', { configurable: true, get: () => scroll });
  h.window.scrollTo = ({ top }) => { scroll = top; };
  await h.app.navigate('subscription', { preserveScroll: true });
  const nextReceipt = [...h.document.querySelectorAll('details[data-receipt-id]')].find(node => node.getAttribute('data-receipt-id') === receiptId);
  assert.notEqual(nextReceipt, receipt); assert.equal(nextReceipt.hasAttribute('open'), true);
  assert.equal(h.document.querySelector('.subscription-payment-help details.subscription-terms').hasAttribute('open'), true);
  assert.equal(h.document.activeElement, nextReceipt.querySelector('summary'));
  assert.equal(scroll, 777); assert.equal(h.document.documentElement.getAttribute('data-color-theme'), 'dark');
  assert.equal(themeButton(h.document, 'dark').getAttribute('aria-pressed'), 'true');
  assert.equal(h.document.querySelector('nav [data-section="subscription"]').getAttribute('aria-current'), 'page');
  assert.deepEqual([...h.document.querySelectorAll('#navigation button')], navigation,
    'an in-place status read must retain the controls whose active surface is animating');
  assert.deepEqual(financialPosts(h), []);
});

test('rapid theme and navigation clicks retain controls and the latest selection despite a late old read', async t => {
  const h = await createOfflineSubscriptionVisual({ after: callback => t.after(callback) });
  const { storage } = themeFor(t, h), buttons = [...h.document.querySelectorAll('#navigation button')];
  const offers = h.document.querySelector('#navigation [data-section="offers"]');
  const subscription = h.document.querySelector('#navigation [data-section="subscription"]');
  const read = h.client.read.bind(h.client);
  let release;
  const late = new Promise(resolve => { release = resolve; });
  h.client.read = (section, ...args) => section === 'offers' ? late : read(section, ...args);
  offers.click();
  for (const mode of ['dark', 'light', 'system', 'dark']) themeButton(h.document, mode).click();
  subscription.click(); await h.flush();
  release({ view: 'catalog', items: [], page: { hasMore: false } }); await h.flush();
  assert.deepEqual([...h.document.querySelectorAll('#navigation button')], buttons);
  assert.equal(h.document.querySelectorAll('#navigation [aria-current="page"]').length, 1);
  assert.equal(subscription.getAttribute('aria-current'), 'page');
  assert.equal(h.document.querySelectorAll('#theme-switcher [aria-pressed="true"]').length, 1);
  assert.equal(themeButton(h.document, 'dark').getAttribute('aria-pressed'), 'true');
  assert.equal(storage.values.get(CABINET_THEME_STORAGE_KEY), 'dark');
  assert.equal(h.document.documentElement.getAttribute('data-color-theme'), 'dark');
  assert.ok(h.document.querySelector('.subscription-current'));
  subscription.focus(); await h.app.navigate('subscription', { preserveScroll: true });
  assert.equal(h.document.activeElement, subscription, 'in-place refresh retains focus on the existing navigation control');
  assert.deepEqual(financialPosts(h), []);
});

test('theme button selected during a pending refresh keeps keyboard focus and highlight', async t => {
  const h = await createOfflineSubscriptionVisual({ after: callback => t.after(callback) }); themeFor(t, h);
  h.document.querySelector('.subscription-payment-help summary').focus();
  let release;
  const wait = new Promise(resolve => { release = resolve; }), read = h.client.read.bind(h.client);
  h.client.read = async (...args) => { if (args[0] === 'subscription') await wait; return read(...args); };
  const refreshing = h.app.navigate('subscription', { preserveScroll: true });
  const button = themeButton(h.document, 'dark'); button.focus(); button.click(); release(); await refreshing;
  assert.equal(h.document.activeElement, button); assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(h.document.documentElement.getAttribute('data-color-theme'), 'dark');
  assert.deepEqual(financialPosts(h), []);
});

test('canonical refund recalculates Free access without resetting appearance or concealing unconfirmed remote renewal', async t => {
  const h = await createOfflineSubscriptionVisual({ after: callback => t.after(callback) }); themeFor(t, h);
  themeButton(h.document, 'dark').click();
  const oldPaidAction = h.document.querySelector('[data-renewal-action="cancel"]');
  assert.ok(oldPaidAction); oldPaidAction.focus();
  const payment = h.f.sqlite.prepare("SELECT ledger.*, link.external_invoice_payload AS invoice_payload FROM payment_ledger ledger JOIN subscription_payment_links link ON link.ledger_entry_id=ledger.ledger_entry_id WHERE ledger.entry_type='payment'").get();
  const result = await handleStarsRefundedPaymentUpdate(h.f.serverEnv, { update_id: 143991001,
    message: { from: { id: 101, is_bot: false }, chat: { id: 101, type: 'private' },
      refunded_payment: { currency: 'XTR', total_amount: payment.amount_stars, invoice_payload: payment.invoice_payload,
        telegram_payment_charge_id: payment.telegram_payment_charge_id, provider_payment_charge_id: '' } } },
    { receivedAt: h.f.now });
  assert.equal(result.status, 'applied');
  await h.app.navigate('subscription', { preserveScroll: true });
  assert.equal(h.document.querySelector('.subscription-current').getAttribute('data-current-plan'), 'free');
  assert.equal(h.document.querySelector('.subscription-current h3').textContent, 'Free');
  assert.ok(h.document.querySelector('[data-renewal-action="cancel"]'), 'an unconfirmed remote renewal remains cancellable despite Free access');
  assert.equal(oldPaidAction.isConnected, false); assert.notEqual(h.document.activeElement, oldPaidAction);
  assert.equal(h.document.documentElement.getAttribute('data-color-theme'), 'dark');
  assert.equal(themeButton(h.document, 'dark').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(financialPosts(h), []);
});


test('refresh after canonical cancellation does not restore focus to a removed cancellation action', async t => {
  const h = await createOfflineSubscriptionVisual({ after: callback => t.after(callback) }); themeFor(t, h);
  themeButton(h.document, 'dark').click();
  const old = h.document.querySelector('[data-renewal-action="cancel"]'); old.focus();
  const contract = h.f.sqlite.prepare('SELECT * FROM subscription_billing_contracts').get();
  const acknowledgement = await requestOwnStarsSubscriptionCommand(await authorizeOwnStarsSubscriptionCommand(await h.f.auth({
    payload: { subscriptionAction: 'cancel_renewal', contractId: contract.contract_id, expectedRevision: contract.revision },
  })), { telegramApi: async () => true });
  assert.equal(acknowledgement.cancellationConfirmed, true);
  await h.app.navigate('subscription', { preserveScroll: true });
  assert.equal(h.document.querySelector('[data-renewal-action="cancel"]') === null, true);
  assert.equal(h.document.activeElement === old, false); assert.equal(old.isConnected, false);
  assert.equal(h.document.activeElement === h.document.getElementById('screen'), true);
  assert.equal(h.document.documentElement.getAttribute('data-color-theme'), 'dark');
  assert.deepEqual(financialPosts(h), []);
});
