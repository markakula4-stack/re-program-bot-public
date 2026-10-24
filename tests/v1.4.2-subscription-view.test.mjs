import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { renderSubscriptionScreen } from '../src/v1.4.0-rebuild/mini-app/subscription-view.mjs';

const requireDom = createRequire(process.env.CABINET_UI_DOM_ROOT
  ? `${process.env.CABINET_UI_DOM_ROOT}/package.json` : new URL('./p08-ui/package.json', import.meta.url));
const { parseHTML } = requireDom('linkedom');
const now = 1791021600;
const keys = ['active_applications', 'own_working_offers', 'active_campaigns'];
const date = value => `${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short',
  year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value * 1000))} МСК`;

function dataFixture() {
  return {
    readModelVersion: 1, authority: 'worker', observedAt: now,
    access: {
      current: { planCode: 'free', accessState: 'none', accessOverlay: null, status: 'verified', sourceKind: 'free',
        startsAt: null, expiresAt: null, remainingSeconds: null, durationKind: 'free_unlimited', activeDragon: false, previewActive: false },
      sessionExpiresAt: now + 300,
      preview: { historyUsed: false, canRequestActivation: true, reasonCode: 'membership_check_required', durationSeconds: 604800, oneTime: true },
      ownerException: { applies: false, source: null, isPaidPlan: false },
    },
    quotas: { actionAdmissionRequired: true, quotas: keys.map((key, index) => ({ key, used: index, limit: [5, 1, 2][index],
      remaining: [5, 0, 0][index], planLimit: [5, 1, 2][index], betaLimit: null, status: 'available', restrictions: [], actionAdmissionRequired: true })) },
    catalog: {
      offers: ['free', 'professional', 'dragon'].map((planCode, index) => ({ planCode, published: true,
        amountStars: [0, 299, 599][index], accessSeconds: index ? 2592000 : null, matchesInitialPrice: !index,
        purchaseEligibility: { eligible: !!index, reasonCode: index ? 'eligible' : 'free_plan_no_purchase', mode: 'new_period' },
        checkout: index ? { available: false, reasonCode: 'mini_app_checkout_not_wired' } : null })),
      comparison: { version: 1, authority: 'worker', publishedPolicyOnly: true, grantsRoles: false,
        rows: keys.map((key, index) => ({ key, limits: { free: [5, 1, 2][index], professional: [27, 6, 11][index], dragon: [51, 12, 22][index] },
          roleRequirement: index ? 'active_partner' : 'user', additionalRestrictions: [] })),
        support: { basic: 'included', paymentHelp: 'included', priority: 'not_released', founderLine: 'not_released' } },
      terms: { available: true, accepted: false, revision: '2026-09-10.stars-v1', text: 'Предоплата Telegram Stars.\nВозврат рассматривается по обстоятельствам.' },
      support: { url: 'https://t.me/RE_Program_Support_Bot?start=paysupport' },
    },
  };
}
function render(data = dataFixture(), callbacks = {}) {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const root = renderSubscriptionScreen({ document, data, ...callbacks }); document.body.append(root);
  return { document, root, current: root.querySelector('.subscription-current') };
}
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

test('current Free is unlimited, while source-backed prices and comparison are never UI constants', () => {
  const { root, current } = render();
  assert.equal(current.getAttribute('data-current-plan'), 'free');
  assert.match(current.textContent, /Бесплатно · без даты окончания/);
  assert.doesNotMatch(current.textContent, new RegExp(date(now + 300)));
  const professional = root.querySelector('[data-plan="professional"]');
  assert.match(professional.textContent, /299 Stars/);
  assert.match(professional.textContent, /Активные заявки27/);
  assert.match(professional.textContent, /Свои рабочие офферы6/);
  assert.match(professional.textContent, /Активные кампании11/);
  assert.doesNotMatch(professional.textContent, /249 Stars|499 Stars/);
  assert.match(root.textContent, /не выдаёт роль партнёра или администратора/);
  assert.match(root.textContent, /действует также допуск Beta/);
  assert.match(root.textContent, /Обычная поддержка и помощь с оплатой доступны на всех/);
  assert.doesNotMatch(root.textContent, /CRM|приоритетная поддержка|линия основателя|ИИ.*25/);
});

test('paid expiration uses the subscription timeline, not the session deadline', () => {
  const data = dataFixture();
  Object.assign(data.access.current, { planCode: 'professional', accessState: 'cancel_at_period_end', sourceKind: 'stars',
    startsAt: now - 86400, expiresAt: now + 3660, remainingSeconds: 3660, durationKind: 'finite' });
  const { current } = render(data);
  assert.match(current.textContent, /Professional/);
  assert.match(current.textContent, /До конца оплаченного периода/);
  assert.match(current.textContent, /Осталось 1 ч\. 1 мин\./);
  assert.ok(current.textContent.includes(date(now + 3660)));
  assert.ok(!current.textContent.includes(date(now + 300)));
  assert.match(current.textContent, /Оплата Telegram Stars/);
});

test('refunded and suspended states never describe the preserved period as active access', () => {
  for (const state of ['refunded', 'suspended']) {
    const data = dataFixture();
    Object.assign(data.access.current, { planCode: 'dragon', accessState: state, sourceKind: 'stars',
      expiresAt: now + 10000, remainingSeconds: 10000, durationKind: 'finite' });
    const { current } = render(data);
    assert.match(current.textContent, /Сохранённый период до/);
    assert.doesNotMatch(current.textContent, /Осталось|Действует до/);
    assert.match(current.textContent, state === 'refunded' ? /платный доступ закрыт/ : /Доступ приостановлен/);
  }
});

test('unknown source or period stays unknown and owner access is never promoted to paid Dragon', () => {
  for (const changes of [{ planCode: null, status: 'review_required', sourceKind: null, durationKind: 'unknown' },
    { planCode: 'dragon', sourceKind: 'stars', durationKind: 'unknown', expiresAt: null }]) {
    const data = dataFixture(); Object.assign(data.access.current, changes);
    data.access.ownerException = { applies: true, source: 'canonical_owner', isPaidPlan: false };
    const { root, current } = render(data);
    assert.equal(current.getAttribute('data-current-plan'), 'unknown');
    assert.match(current.textContent, /Нужно проверить доступ/);
    assert.match(current.textContent, /Не удалось подтвердить тариф и срок доступа/);
    assert.match(current.textContent, /не является купленным тарифом/);
    assert.doesNotMatch(current.textContent, /Бесплатно · без даты окончания|Действует до/);
    assert.ok([...root.querySelectorAll('[data-purchase-plan]')].every(button => button.disabled));
  }
});

test('Preview is a separate Free overlay with its own history and no implied channel verification', () => {
  const data = dataFixture();
  Object.assign(data.access.current, { accessState: 'trial', sourceKind: 'preview', accessOverlay: 'dragon_preview',
    previewActive: true, startsAt: now - 100, expiresAt: now + 604700, remainingSeconds: 604700, durationKind: 'finite' });
  Object.assign(data.access.preview, { historyUsed: true, startsAt: now - 100, expiresAt: now + 604700,
    canRequestActivation: false, reasonCode: 'preview_active' });
  const { root, current } = render(data);
  assert.equal(current.getAttribute('data-current-plan'), 'free');
  assert.match(current.textContent, /Dragon Preview/);
  assert.match(current.textContent, /не платная подписка Dragon/);
  assert.match(root.querySelector('.subscription-preview').textContent, /Уже использован/);
  assert.ok(!root.querySelector('.subscription-preview-action'));
  assert.equal(root.querySelector('[data-plan="free"] .badge'), null);
  const fresh = render();
  assert.ok(fresh.root.querySelector('.subscription-preview-action').disabled);
  assert.match(fresh.root.querySelector('.subscription-preview').textContent, /на этой странице ещё не проверена/);
});

test('unknown quota values are explicit and over-limit records remain visible', () => {
  const data = dataFixture();
  Object.assign(data.quotas.quotas[0], { used: null, limit: null, remaining: null, status: 'unavailable', reasonCode: 'quota_counter_unavailable' });
  Object.assign(data.quotas.quotas[1], { used: 7, limit: 2, remaining: 0, planLimit: 6, betaLimit: 2,
    restrictions: ['active_partner_required', 'active_partner_required', 'legal_declaration_required'] });
  const { root } = render(data);
  const unknown = root.querySelector('[data-quota="active_applications"]');
  assert.ok(unknown.classList.contains('subscription-quota-unknown'));
  assert.deepEqual([...unknown.querySelectorAll('dd')].map(node => node.textContent), ['Неизвестно', 'Неизвестно', 'Неизвестно']);
  assert.equal(unknown.querySelector('progress'), null);
  const over = root.querySelector('[data-quota="own_working_offers"]');
  assert.deepEqual([...over.querySelectorAll('dd')].map(node => node.textContent), ['7', '2', '0']);
  assert.equal(over.querySelector('progress').value, 2);
  assert.match(over.textContent, /Действующий предел Beta: 2/);
  assert.match(over.textContent, /Существующие записи сохраняются/);
  assert.equal(over.textContent.match(/Нужен активный профиль партнёра/g)?.length, 1);
  assert.match(root.querySelector('.subscription-capacity').textContent, /проверяется отдельно/);
});

test('purchase and activation remain disabled without a genuine available handoff', () => {
  let purchases = 0, previews = 0;
  const { root } = render(dataFixture(), { onPurchase: () => purchases++, onRequestPreview: () => previews++ });
  for (const node of root.querySelectorAll('[data-purchase-plan]')) { assert.ok(node.disabled); node.click(); }
  assert.equal(purchases, 0);
  assert.match(root.querySelector('[data-plan="professional"]').textContent, /Покупка в Mini App пока недоступна/);
  const noCallbacks = render(); noCallbacks.root.querySelector('.subscription-preview-action').click();
  assert.equal(previews, 0);
  assert.doesNotMatch(root.textContent, /3\/4|следующий этап|реализация|инфраструктура/);
  const data = dataFixture();
  data.catalog.offers[1].checkout.available = true;
  data.catalog.offers[1].purchaseEligibility.eligible = false;
  data.catalog.offers[1].purchaseEligibility.reasonCode = 'paid_plan_transition_not_released';
  const denied = render(data, { onPurchase: () => purchases++ });
  denied.root.querySelector('[data-purchase-plan="professional"]').click();
  assert.equal(purchases, 0);
  assert.match(denied.root.querySelector('[data-plan="professional"]').textContent, /Смена оплаченного тарифа пока недоступна/);
});

test('missing published comparison or price is not replaced by initial tariff assumptions', () => {
  const data = dataFixture(); delete data.catalog.comparison;
  data.catalog.offers[1].published = false; data.catalog.offers[1].amountStars = null;
  const { root } = render(data);
  const professional = root.querySelector('[data-plan="professional"]');
  assert.match(professional.textContent, /Цена недоступна/);
  assert.match(professional.textContent, /Точные пределы сравнения пока недоступны/);
  assert.ok(professional.querySelector('button').disabled);
  assert.doesNotMatch(professional.textContent, /249|25|499/);
});

test('terms stay plain text, canonical support is usable, and unsafe destinations are rejected', () => {
  const data = dataFixture(); data.catalog.terms.text = '<img src=x onerror=alert(1)>\nВозврат по обстоятельствам.';
  const { root } = render(data);
  assert.equal(root.querySelector('img'), null);
  assert.ok(root.querySelector('.subscription-terms-text').textContent.includes('<img src=x onerror=alert(1)>'));
  const links = [...root.querySelectorAll('a')];
  assert.deepEqual(links.map(node => node.href), ['https://t.me/RE_Program_Bot', 'https://t.me/RE_Program_Support_Bot?start=paysupport']);
  assert.ok(links.every(node => node.target === '_blank' && node.rel === 'noopener noreferrer'));
  for (const url of ['javascript:alert(1)', 'https://evil.test', 'https://t.me/RE_Program_Support_Bot?start=other',
    'https://user:password@t.me/RE_Program_Support_Bot', 'https://t.me/RE_Program_Support_Bot#token']) {
    const invalid = dataFixture(); invalid.catalog.support.url = url;
    const result = render(invalid).root;
    assert.equal(result.querySelector('.subscription-payment-help a'), null);
    assert.match(result.querySelector('.subscription-payment-help').textContent, /Откройте \/paysupport в боте/);
  }
});

test('rendering is passive and refresh remains available for failed DTOs', () => {
  const data = freeze(dataFixture()); const before = JSON.stringify(data);
  render(data); assert.equal(JSON.stringify(data), before);
  let refreshes = 0;
  const { root } = render({ authority: 'client', readModelVersion: 1 }, { onRefresh: () => refreshes++ });
  assert.match(root.textContent, /Не удалось получить условия/);
  assert.equal(root.querySelector('.subscription-current'), null);
  root.querySelector('button').click(); assert.equal(refreshes, 1);
  assert.equal(root.querySelector('a').href, 'https://t.me/RE_Program_Support_Bot?start=paysupport');
});
