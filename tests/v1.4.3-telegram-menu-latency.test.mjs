import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../re-program-bot-worker.js', import.meta.url), 'utf8');
const section = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'actual worker function boundaries');
  return source.slice(from, to);
};
const actualFunctions = [
  section('async function showMainMenu(', 'async function showAIHub('),
  section('async function getPartnerApplicationByUser(', 'async function getPartnerApplicationById('),
  section('async function getPartnerProfileByUser(', 'async function ensureApprovedPartnerProfile('),
  section('async function getUnreadNotificationCount(', 'function notificationEventLabel('),
].join('\n');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ rows = {}, hold = false, repairResult = null, referral = null } = {}) {
  const calls = [], effects = [], screens = [], gates = {};
  const env = { DB: { prepare(sql) {
    assert.match(sql, /^SELECT\s/u, 'menu inputs are pure reads');
    const table = /FROM\s+(partner_applications|partner_profiles|notifications)\b/u.exec(sql)?.[1];
    assert.ok(table, 'only the three reviewed own-account queries are prefetched');
    return { bind(...params) { return { first() {
      assert.deepEqual(params, [101], 'existing own-account SQL parameters are preserved');
      calls.push({ table, sql, params });
      if (!hold) return Promise.resolve(rows[table] ?? null);
      const gate = gates[table] = deferred();
      return gate.promise;
    } }; } };
  } } };
  const values = {
    safelyRecordFunnelEvent: async (_env, id, event) => { effects.push({ event, id }); },
    ensureApprovedPartnerProfile: async (_env, application) => {
      effects.push({ event: 'repair', application });
      return repairResult;
    },
    getReferralRewardMenuButton: async (_env, parameters) => {
      effects.push({ event: 'referral', parameters });
      return referral;
    },
    safelyRecordBotError: async (_env, code) => { effects.push({ event: 'error', code }); },
    isAdmin: () => false,
    isSingleScreenUXEnabled: () => true,
    sendOrEditMessage: async (_env, ...parameters) => { screens.push(parameters); },
    getPublicVersion: () => '1.4.3',
  };
  const showMainMenu = new Function(...Object.keys(values), actualFunctions + '\nreturn showMainMenu;')(...Object.values(values));
  return { env, calls, effects, screens, gates, run: () => showMainMenu(env, 101, 30) };
}

function expectedScreen(partnerText, badge = '', active = false, referral = null) {
  const keyboard = [
    [{ text: '🤖 RE AI', callback_data: 'ai_hub' }],
    [{ text: '🤝 Партнёрские программы', callback_data: 'partner_programs' }],
    [{ text: '📋 Мои заявки', callback_data: 'my_leads' }],
    [{ text: '🔔 Уведомления' + badge, callback_data: 'notifications' }],
    [{ text: partnerText, callback_data: 'partner' }],
    [{ text: '💎 Тарифы и мой доступ', callback_data: 'plans' }],
  ];
  if (referral) keyboard.push([referral]);
  keyboard.push(active ? [
    { text: '🔗 Моя ссылка на бот', callback_data: 'my_link' },
    { text: '👥 Статистика', callback_data: 'stats' },
  ] : [{ text: '🔒 Моя ссылка партнёра', callback_data: 'my_link' }]);
  keyboard.push(
    [{ text: 'ℹ️ Как это работает', callback_data: 'single_how_it_works' }, { text: '📜 Условия', callback_data: 'terms' }],
    [{ text: '🔐 Приватность и данные', callback_data: 'privacy' }],
    [{ text: '📢 Канал RE Program', callback_data: 'channel' }],
    [{ text: '🛟 Поддержка', callback_data: 'support' }],
  );
  return [101, 30, '<b>RE Program · v1.4.3</b>\n\nВыберите, что хотите сделать:', keyboard, 'single_screen.menu'];
}

test('actual menu starts all three own-account reads together and waits before repair, referral or delivery', async () => {
  const application = { id: 42, telegram_id: 101, status: 'approved' };
  const f = fixture({ hold: true, repairResult: { status: 'active' } });
  const work = f.run();
  await tick();
  assert.deepEqual(f.calls.map(row => row.table), ['partner_applications', 'partner_profiles', 'notifications']);
  assert.deepEqual(f.effects, [{ event: 'menu_opened', id: 101 }]);
  assert.deepEqual(f.screens, []);
  f.gates.partner_applications.resolve(application);
  f.gates.partner_profiles.resolve(null);
  await tick();
  assert.equal(f.effects.length, 1, 'optional repair and referral stay after the read barrier');
  assert.deepEqual(f.screens, []);
  f.gates.notifications.resolve({ total: 7 });
  await work;
  assert.deepEqual(f.effects, [
    { event: 'menu_opened', id: 101 },
    { event: 'repair', application },
    { event: 'referral', parameters: { telegramId: 101 } },
  ]);
  assert.deepEqual(f.screens, [expectedScreen('🤝 Профиль партнёра', ' · 🔴 7', true)]);
});

for (const scenario of [
  { name: 'new account', application: null, profile: null, total: 0, text: '🤝 Стать партнёром' },
  { name: 'pending application', application: { status: 'pending' }, total: 2, text: '⏳ Заявка партнёра', badge: ' · 🔴 2' },
  { name: 'rejected application', application: { status: 'rejected' }, total: 100, text: '🔁 Заявка партнёра', badge: ' · 🔴 99+' },
  { name: 'approved existing profile', application: { status: 'approved' }, profile: { status: 'active' }, total: 0, text: '🤝 Профиль партнёра', active: true },
  { name: 'inactive profile with referral', application: { status: 'approved' }, profile: { status: 'inactive' }, total: 0, text: '🤝 Профиль партнёра', referral: { text: '🎁 Моя награда', callback_data: 'referral_reward' } },
]) {
  test('actual menu preserves the full screen for ' + scenario.name, async () => {
    const f = fixture({ rows: { partner_applications: scenario.application, partner_profiles: scenario.profile,
      notifications: { total: scenario.total } }, referral: scenario.referral });
    await f.run();
    assert.equal(f.calls.length, 3);
    assert.equal(f.effects.some(effect => effect.event === 'repair'), false, 'existing profile or unapproved account needs no repair');
    assert.deepEqual(f.screens, [expectedScreen(scenario.text, scenario.badge, scenario.active, scenario.referral)]);
  });
}

test('a failed menu read does not repair profiles, load referral rewards or deliver a partial screen', async () => {
  const f = fixture({ hold: true, repairResult: { status: 'active' } });
  const work = f.run();
  const rejected = assert.rejects(work, /offline read failure/u);
  await tick();
  f.gates.partner_applications.resolve({ status: 'approved' });
  f.gates.partner_profiles.resolve(null);
  f.gates.notifications.reject(new Error('offline read failure'));
  await rejected;
  assert.deepEqual(f.effects, [{ event: 'menu_opened', id: 101 }]);
  assert.deepEqual(f.screens, []);
});
