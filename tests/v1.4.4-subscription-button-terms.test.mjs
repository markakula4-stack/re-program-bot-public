import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import './helpers/v1.4.3-p05-offline-network.mjs';
import { createPart3VisualDescriptor } from '../scripts/v1.4.4-part3-visual-preview.mjs';
import { mountCabinet } from '../src/v1.4.0-rebuild/mini-app/cabinet-view.mjs';

const requireDom = createRequire(process.env.CABINET_UI_DOM_ROOT ? `${process.env.CABINET_UI_DOM_ROOT}/package.json` : new URL('./p08-ui/package.json', import.meta.url));
const { parseHTML } = requireDom('linkedom');
const html = fs.readFileSync(new URL('../src/v1.4.0-rebuild/mini-app/partner-cabinet.html', import.meta.url), 'utf8');
const NOW = 1791327600;
const tick = () => new Promise(resolve => setImmediate(resolve));
const offer = data => data.catalog.recurring.offers.find(row => row.planCode === 'professional');
const closeButton = document => [...document.querySelectorAll('.subscription-dialog button')].find(node => node.textContent === 'Назад');
async function mount(t, { blocked = false, pending = false, missingTerms = false, missingAction = false } = {}) {
  const data = structuredClone(await createPart3VisualDescriptor('professional-offer'));
  const actualNow = Date.now; Date.now = () => NOW * 1000; t.after(() => { Date.now = actualNow; });
  data.access.sessionExpiresAt = NOW + 300;
  if (blocked) { offer(data).purchaseEligibility.eligible = false; offer(data).purchaseEligibility.reasonCode = 'subscription_contract_in_progress'; offer(data).checkout.available = false; }
  if (missingTerms) data.catalog.recurring.terms.available = false;
  const { document, window } = parseHTML(html); window.location = { hash: '#subscription' };
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => document._focused ?? document.body });
  window.HTMLElement.prototype.focus = function () { document._focused = this; };
  window.scrollTo = () => {}; window.scrollY = 42;
  window.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const reads = [], actions = [];
  const client = { authenticated: true, expiresAt: NOW + 300, canMutate: false, canOpenOffers: false,
    subscriptionOutcomePending: pending, packageOutcomePending: false,
    async read(resource) {
      reads.push(resource);
      return resource === 'bootstrap' ? { readModelVersion: 1, authorization: { ...data.authorization, capability: 'profile.read_own' },
        systemRole: 'user', partner: { state: 'no_application', application: null, profile: null, legalProfile: null, beta: null, actions: {} },
        navigation: ['profile', 'offers', 'applications', 'analytics', 'subscription'].map(section => ({ section, enabled: section !== 'analytics', reason: null })),
        counts: { visibleOffers: 0, ownOffers: 0, ownApplications: 0, attributedApplications: 0 } } : structuredClone(data);
    },
    async subscriptionAction(kind, intent) { actions.push({ kind, intent }); return { status: 'confirmed', invoiceUrl: 'https://t.me/$offline_terms_test' }; },
    clearSession() { this.authenticated = false; },
  };
  if (missingAction) delete client.subscriptionAction;
  const app = mountCabinet({ document, client }); t.after(() => app.destroy()); await app.start();
  const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };
  return { app, client, data, document, window, reads, actions, flush };
}

test('blocked recurring checkout still opens actual terms after a fresh read, with no consent or invoice action, and returns focus', async t => {
  const h = await mount(t, { blocked: true });
  const button = h.document.querySelector('[data-recurring-plan="professional"]');
  assert.equal(button.disabled, false);
  const before = h.reads.length; button.focus(); button.click(); await h.flush();
  assert.equal(h.reads.length, before + 1);
  const dialog = h.document.querySelector('.subscription-dialog'); assert.ok(dialog);
  assert.match(dialog.textContent, /249 Stars каждые 30 дней/);
  assert.ok(dialog.textContent.includes(h.data.catalog.recurring.terms.text));
  assert.ok(dialog.querySelector('.subscription-terms').hasAttribute('open'));
  assert.equal(dialog.querySelector('input'), null); assert.equal(dialog.querySelector('[data-subscription-confirm]'), null);
  assert.equal(h.actions.length, 0);
  closeButton(h.document).click(); assert.equal(h.document.querySelector('.subscription-dialog'), null); assert.equal(h.document.activeElement, button);
});

test('unknown financial outcome permits only terms reading and never creates a new consent or invoice', async t => {
  const h = await mount(t, { pending: true });
  const button = h.document.querySelector('[data-recurring-plan="professional"]'); assert.equal(button.disabled, false);
  button.click(); await h.flush(); const dialog = h.document.querySelector('.subscription-dialog'); assert.ok(dialog);
  assert.match(dialog.textContent, /В браузере сохранено предыдущее действие; его результат ещё не проверен/);
  assert.match(dialog.textContent, /Условия можно прочитать; новый счёт пока недоступен/);
  assert.equal(dialog.querySelector('input'), null); assert.equal(dialog.querySelector('[data-subscription-confirm]'), null);
  assert.equal(h.actions.length, 0); assert.equal(h.client.subscriptionOutcomePending, true);
});

test('eligible recurring consent retains confirmation and rejects purchase eligibility lost before final fresh read', async t => {
  const h = await mount(t); h.document.querySelector('[data-recurring-plan="professional"]').click(); await h.flush();
  const panel = h.document.querySelector('[data-subscription-confirmation]'), checkbox = panel.querySelector('input');
  const submit = panel.querySelector('[data-subscription-confirm]'); assert.ok(checkbox); assert.equal(submit.disabled, true);
  checkbox.checked = true; checkbox.dispatchEvent(new h.window.Event('change')); assert.equal(submit.disabled, false);
  offer(h.data).purchaseEligibility.eligible = false; offer(h.data).checkout.available = false;
  submit.click(); await h.flush(); assert.equal(h.actions.length, 0);
  assert.match(h.document.getElementById('notice').textContent, /Условия или состояние изменились/);
});

test('missing actual recurring terms disables the view action; missing invoice transport still permits read-only terms', async t => {
  const unavailable = await mount(t, { missingTerms: true });
  const disabled = unavailable.document.querySelector('[data-recurring-plan="professional"]'); assert.equal(disabled.disabled, true);
  disabled.click(); await unavailable.flush(); assert.equal(unavailable.document.querySelector('.subscription-dialog'), null);
  assert.equal(unavailable.actions.length, 0);
  const reader = await mount(t, { missingAction: true }); reader.document.querySelector('[data-recurring-plan="professional"]').click(); await reader.flush();
  assert.ok(reader.document.querySelector('.subscription-dialog')); assert.equal(reader.document.querySelector('[data-subscription-confirm]'), null);
  assert.equal(reader.actions.length, 0);
});
