import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { renderTelegramActions } from '../src/v1.4.0-rebuild/mini-app/telegram-actions-view.mjs';
const requireDom = createRequire(process.env.CABINET_UI_DOM_ROOT
  ? `${process.env.CABINET_UI_DOM_ROOT}/package.json` : new URL('./p08-ui/package.json', import.meta.url));
const { parseHTML } = requireDom('linkedom');
const now = 1791000000, ownUrl = 'https://t.me/RE_Program_Bot?start=partner_ACTUAL1';
const fixture = () => ({ readModelVersion: 1, authority: 'worker', access: { sessionExpiresAt: now + 300,
  current: { status: 'verified', planCode: 'dragon', activeDragon: true, accessState: 'active', previewActive: false,
    sourceKind: 'stars', expiresAt: now + 3600, remainingSeconds: 3600 } },
  catalog: { nativeDependencies: {
    referralShare: { available: true, ownUrl, releasedText: 'Утверждённый текст.', preparationRequired: true, preparedMessageId: null },
    dragonEmoji: { available: true, customEmojiId: '5412300012345000012' },
  } } });
const flush = async () => { for (let step = 0; step < 8; step++) await Promise.resolve(); };
function render({ data = fixture(), snapshot = {}, onReadNative, onPrepareReferral } = {}) {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>'), subscribers = new Set(), calls = [];
  const state = { capabilities: { shareMessage: true, emojiStatus: true, clipboard: true, homeScreen: true },
    busy: {}, usefulAction: false, homeScreenStatus: 'unknown', privateCleared: false, ...snapshot };
  const native = {
    snapshot: () => state, subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
    copyOwnReferral: async value => { calls.push(['copy', value]); return { status: 'copied' }; },
    sharePreparedMessage: async value => { calls.push(['share', value]); return { status: 'confirmed' }; },
    setDragonEmoji: async value => { calls.push(['emoji', value]); return { status: 'confirmed' }; },
    addToHomeScreen: async () => { calls.push(['home']); return { status: 'unknown' }; },
  };
  const view = renderTelegramActions({ document, data, native, nowSeconds: () => now,
    onReadNative: onReadNative ?? (async () => structuredClone(data)),
    onPrepareReferral: onPrepareReferral ?? (async () => ({ version: 1, authority: 'worker', prepared: true, sent: false,
      ownUrl, releasedText: data.catalog.nativeDependencies.referralShare.releasedText, preparedMessageId: 'actual:message', expiresAt: now + 100 })) });
  document.body.append(view.element);
  return { ...view, document, calls, state, subscribers,
    button: key => view.element.querySelector(`[data-telegram-action="${key}"]`),
    click(key) { this.button(key).dispatchEvent(new window.Event('click')); },
    update(values) { Object.assign(state, values); for (const callback of subscribers) callback(state); },
  };
}

test('old-client fallback shows only the own link, refreshes it before copy and never offers home on first display', async () => {
  const data = fixture(), fresh = fixture(); fresh.catalog.nativeDependencies.referralShare.ownUrl = ownUrl.replace('ACTUAL1', 'ACTUAL2');
  const h = render({ data, snapshot: { capabilities: { shareMessage: false, emojiStatus: false, clipboard: true, homeScreen: false } },
    onReadNative: async () => fresh });
  assert.equal(h.button('share').disabled, true); assert.equal(h.button('copy').disabled, false);
  assert.match(h.element.textContent, /Скопируйте свою ссылку/);
  assert.equal(h.button('home').closest('section').hidden, true);
  h.click('copy'); await flush();
  assert.deepEqual(h.calls[0], ['copy', { authority: 'worker', ownUrl: fresh.catalog.nativeDependencies.referralShare.ownUrl }]);
  assert.match(h.element.textContent, /Ваша ссылка скопирована/); h.destroy();
});

test('share has a fresh read, a real preparation and only then native chat choice', async () => {
  const order = [];
  const h = render({ onReadNative: async () => { order.push('read'); return fixture(); },
    onPrepareReferral: async () => { order.push('prepare'); return { authority: 'worker', prepared: true, sent: false,
      ownUrl, releasedText: fixture().catalog.nativeDependencies.referralShare.releasedText,
      preparedMessageId: 'real:prepared', expiresAt: now + 100 }; } });
  assert.match(h.element.textContent, /Подготовка сообщения ничего не отправляет/);
  h.click('share'); await flush();
  assert.deepEqual(order, ['read', 'prepare']); assert.equal(h.calls[0][0], 'share');
  assert.equal(h.calls[0][1].preparedMessageId, 'real:prepared');
  assert.match(h.element.textContent, /отправлено в выбранный вами чат/); h.destroy();
});

test('duplicate clicks cannot prepare twice and a detached component cannot open a dialog from a late response', async () => {
  let resolvePrepare, preparations = 0;
  const h = render({ onPrepareReferral: () => { preparations++; return new Promise(resolve => { resolvePrepare = resolve; }); } });
  h.click('share'); await flush(); h.click('share'); await flush(); assert.equal(preparations, 1);
  h.destroy();
  resolvePrepare({ authority: 'worker', prepared: true, sent: false, ownUrl, releasedText: 'Утверждённый текст.', preparedMessageId: 'late', expiresAt: now + 100 });
  await flush(); assert.equal(h.calls.length, 0); assert.equal(h.element.textContent, ''); assert.equal(h.subscribers.size, 0);
});

test('a preparation with another link or an unapproved text never reaches native share', async () => {
  const h = render({ onPrepareReferral: async () => ({ authority: 'worker', prepared: true, sent: false,
    ownUrl: 'https://t.me/RE_Program_Bot?start=partner_OTHER', releasedText: 'Другой текст.', preparedMessageId: 'bad', expiresAt: now + 100 }) });
  h.click('share'); await flush(); assert.equal(h.calls.length, 0);
  assert.match(h.element.textContent, /Не удалось проверить действие/); h.destroy();
});

test('fresh refunded state, Preview and an unconfigured emoji cannot set a Dragon status', async () => {
  const fresh = fixture(); fresh.access.current.accessState = 'refunded'; fresh.catalog.nativeDependencies.dragonEmoji.available = false;
  const h = render({ onReadNative: async () => fresh }); h.click('emoji'); await flush();
  assert.equal(h.calls.length, 0); assert.equal(h.button('emoji').disabled, true); h.destroy();
  const preview = fixture(); Object.assign(preview.access.current, { planCode: 'free', previewActive: true, sourceKind: 'preview' });
  const p = render({ data: preview }); assert.equal(p.button('emoji').disabled, true); p.destroy();
  const unconfigured = fixture(); unconfigured.catalog.nativeDependencies.dragonEmoji = {
    available: false, customEmojiId: null, reasonCode: 'dragon_custom_emoji_not_configured' };
  const u = render({ data: unconfigured }); assert.equal(u.button('emoji').disabled, true);
  assert.match(u.element.textContent, /Значок Dragon пока недоступен/); u.destroy();
});

test('home offer responds to useful-use state and unknown outcome is described without installation success', async () => {
  const h = render(); assert.equal(h.button('home').closest('section').hidden, true);
  h.update({ usefulAction: true }); assert.equal(h.button('home').closest('section').hidden, false);
  assert.match(h.element.textContent, /не может определить, установлен ли уже значок/);
  h.click('home'); await flush(); assert.deepEqual(h.calls, [['home']]);
  assert.match(h.element.textContent, /Результат не подтверждён/);
  assert.doesNotMatch(h.element.textContent, /приложения добавлен/); h.destroy();
});

test('session clearing erases the private link and disables every native private action', () => {
  const h = render(); assert.equal(h.element.querySelector('[data-own-referral]').textContent, ownUrl);
  h.update({ privateCleared: true });
  assert.equal(h.element.querySelector('[data-own-referral]').textContent, '');
  for (const key of ['share', 'copy', 'emoji', 'home']) assert.equal(h.button(key).disabled, true);
  h.destroy();
});

test('a lost preparation response is described as unknown and cannot be repeated while copy stays available', async () => {
  let preparations = 0;
  const h = render({ onPrepareReferral: async () => { preparations++; throw { code: 'prepared_message_effect_unknown' }; } });
  h.click('share'); await flush();
  assert.match(h.element.textContent, /Неизвестно, удалось ли подготовить сообщение/);
  assert.equal(h.button('share').disabled, true); assert.equal(h.button('copy').disabled, false);
  h.click('share'); await flush(); assert.equal(preparations, 1); assert.equal(h.calls.length, 0); h.destroy();
});
