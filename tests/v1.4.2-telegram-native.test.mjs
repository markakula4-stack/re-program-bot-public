import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramNativeAdapter, safeOwnReferralUrl, safeTelegramActionUrl } from '../src/v1.4.0-rebuild/mini-app/telegram-native.mjs';

const now = 1791000000;
function harness(overrides = {}) {
  const events = new Map(), pendingTimers = new Map(), css = new Map(), calls = [];
  let timerId = 0, shareCallback, emojiCallback, checkCallback;
  const telegram = {
    version: '8.0', isVersionAtLeast: version => version === '8.0' || version === '6.1', isFullscreen: false,
    safeAreaInset: { top: 24, right: 0, bottom: 16, left: 0 }, contentSafeAreaInset: { top: 48, right: 1, bottom: 0, left: 1 },
    onEvent(name, callback) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); },
    offEvent(name, callback) { events.get(name)?.delete(callback); },
    requestFullscreen() { calls.push(['requestFullscreen']); }, exitFullscreen() { calls.push(['exitFullscreen']); },
    checkHomeScreenStatus(callback) { calls.push(['checkHomeScreenStatus']); checkCallback = callback; },
    addToHomeScreen() { calls.push(['addToHomeScreen']); },
    shareMessage(id, callback) { calls.push(['shareMessage', id]); shareCallback = callback; },
    setEmojiStatus(id, params, callback) { calls.push(['setEmojiStatus', id, params]); emojiCallback = callback; },
    openTelegramLink(url) { calls.push(['openTelegramLink', url]); }, ...overrides,
  };
  const adapter = createTelegramNativeAdapter({ telegram,
    document: { documentElement: { style: { getPropertyValue: key => css.get(key) ?? '', setProperty: (key, value) => css.set(key, value), removeProperty: key => css.delete(key) } } },
    nowSeconds: () => now, timeoutMs: 10,
    clipboard: { writeText: async value => { calls.push(['writeText', value]); } },
    timers: { setTimeout(fn) { const id = ++timerId; pendingTimers.set(id, fn); return id; }, clearTimeout(id) { pendingTimers.delete(id); } },
  });
  return { adapter, telegram, calls, css, events,
    emit(name, value) { for (const callback of [...events.get(name) ?? []]) callback(value); },
    tick() { const entries = [...pendingTimers.values()]; pendingTimers.clear(); entries.forEach(fn => fn()); },
    shareResult(value) { shareCallback(value); }, emojiResult(value) { emojiCallback(value); }, checkResult(value) { checkCallback(value); },
  };
}
const prepared = () => ({ authority: 'worker', preparedMessageId: 'actual-provider:message', expiresAt: now + 100 });
const dragon = () => ({ authority: 'worker', activeDragon: true, planCode: 'dragon', accessState: 'active', previewActive: false,
  expiresAt: now + 86400, remainingSeconds: 3600, customEmojiId: '5412300012345000012' });

test('modern methods require a declared supported version as well as real methods', async () => {
  for (const version of ['7.10', 'unknown', '']) {
    const h = harness({ version });
    assert.equal(h.adapter.capabilities().shareMessage, false);
    assert.equal((await h.adapter.sharePreparedMessage(prepared())).status, 'unsupported');
    assert.equal(h.calls.length, 0); h.adapter.destroy();
  }
  const h = harness({ shareMessage: undefined, isVersionAtLeast: () => false });
  assert.equal(h.adapter.capabilities().emojiStatus, false); h.adapter.destroy();
});

test('safe-area values are bounded, event driven and removed together with listeners', () => {
  const h = harness();
  assert.equal(h.css.get('--re-safe-area-inset-top'), '24px');
  assert.equal(h.css.get('--re-content-safe-area-inset-top'), '48px');
  h.telegram.safeAreaInset = { top: 1.2, right: -3, bottom: Infinity, left: 5000 };
  h.emit('safeAreaChanged');
  assert.equal(h.css.get('--re-safe-area-inset-top'), '2px');
  for (const side of ['right', 'bottom', 'left']) assert.equal(h.css.get(`--re-safe-area-inset-${side}`), '0px');
  h.adapter.destroy(); assert.equal(h.css.size, 0);
  assert.equal([...h.events.values()].reduce((count, set) => count + set.size, 0), 0);
});

test('fullscreen is confirmed by actual target state, not merely any change event', async () => {
  const h = harness(), pending = h.adapter.requestFullscreen();
  h.emit('fullscreenChanged'); assert.equal(h.adapter.snapshot().busy.fullscreen, true);
  h.telegram.isFullscreen = true; h.emit('fullscreenChanged');
  assert.equal((await pending).status, 'confirmed'); assert.equal(h.adapter.snapshot().fullscreen, true);
  const leaving = h.adapter.exitFullscreen(); h.telegram.isFullscreen = false; h.emit('fullscreenChanged');
  assert.equal((await leaving).status, 'confirmed'); h.adapter.destroy();
});

test('a home shortcut is offered only after a useful action and unknown never means installed', async () => {
  const h = harness();
  assert.equal((await h.adapter.addToHomeScreen()).reasonCode, 'useful_action_required');
  assert.equal(h.adapter.markUsefulAction('screen_displayed'), false);
  assert.equal(h.adapter.markUsefulAction('committed_form'), true);
  const check = h.adapter.checkHomeScreenStatus(); h.checkResult('unknown');
  assert.equal((await check).status, 'unknown'); assert.equal(h.adapter.snapshot().homeScreenStatus, 'unknown');
  const adding = h.adapter.addToHomeScreen(); h.tick(); assert.equal((await adding).status, 'unknown');
  assert.equal(h.adapter.snapshot().homeScreenStatus, 'unknown');
  assert.equal((await h.adapter.addToHomeScreen()).status, 'busy');
  h.emit('homeScreenAdded'); assert.equal(h.adapter.snapshot().homeScreenStatus, 'added');
  assert.equal((await h.adapter.addToHomeScreen()).status, 'confirmed'); h.adapter.destroy();
});

test('only server-produced unexpired prepared IDs reach shareMessage; preparing never sends', async () => {
  const h = harness();
  for (const bad of [{ ...prepared(), authority: 'browser' }, { ...prepared(), expiresAt: now },
    { ...prepared(), expiresAt: now + 86401 }, { ...prepared(), preparedMessageId: 'with whitespace' }])
    assert.equal((await h.adapter.sharePreparedMessage(bad)).status, 'unavailable');
  assert.equal(h.calls.length, 0);
  const sharing = h.adapter.sharePreparedMessage(prepared());
  assert.deepEqual(h.calls[0], ['shareMessage', 'actual-provider:message']);
  h.shareResult(true); assert.equal((await sharing).status, 'confirmed'); h.adapter.destroy();
});

test('callback false and timeout remain unknown and block a second uncorrelated dialog', async () => {
  const h = harness();
  const first = h.adapter.sharePreparedMessage(prepared()); h.shareResult(false);
  assert.equal((await first).status, 'unknown');
  assert.equal((await h.adapter.sharePreparedMessage(prepared())).status, 'busy');
  assert.equal(h.calls.filter(row => row[0] === 'shareMessage').length, 1);
  h.adapter.clearPrivate(); h.shareResult(true);
  assert.equal((await h.adapter.sharePreparedMessage(prepared())).status, 'cleared');
  assert.equal(h.adapter.snapshot().privateCleared, true); h.adapter.destroy();
  const timed = harness(), unresolved = timed.adapter.sharePreparedMessage(prepared()); timed.tick();
  assert.equal((await unresolved).status, 'unknown'); assert.equal((await timed.adapter.sharePreparedMessage(prepared())).status, 'busy'); timed.adapter.destroy();
});

test('only explicit USER_DECLINED is classified as cancellation', async () => {
  const h = harness(), pending = h.adapter.sharePreparedMessage(prepared());
  h.emit('shareMessageFailed', { error: 'USER_DECLINED' });
  assert.equal((await pending).status, 'cancelled'); assert.equal(h.adapter.snapshot().busy.share, undefined);
  const next = h.adapter.sharePreparedMessage(prepared()); h.emit('shareMessageFailed', { error: 'UNKNOWN_ERROR' });
  assert.equal((await next).status, 'unknown'); assert.equal(h.adapter.snapshot().busy.share, true); h.adapter.destroy();
});

test('Dragon native consent uses a valid emoji and duration bounded by server remaining time', async () => {
  const h = harness();
  for (const bad of [{ ...dragon(), previewActive: true }, { ...dragon(), planCode: 'free' },
    { ...dragon(), accessState: 'refunded' }, { ...dragon(), expiresAt: now },
    { ...dragon(), remainingSeconds: null }, { ...dragon(), customEmojiId: '🔴' }])
    assert.equal((await h.adapter.setDragonEmoji(bad)).status, 'unavailable');
  assert.equal(h.calls.length, 0);
  const setting = h.adapter.setDragonEmoji(dragon());
  assert.deepEqual(h.calls[0], ['setEmojiStatus', dragon().customEmojiId, { duration: 3600 }]);
  assert.equal(h.telegram.requestEmojiStatusAccess, undefined);
  h.emojiResult(true); assert.equal((await setting).status, 'confirmed');
  const next = h.adapter.setDragonEmoji({ ...dragon(), expiresAt: now + 10 });
  assert.equal(h.calls[1][2].duration, 10); h.emit('emojiStatusFailed', { error: 'USER_DECLINED' });
  assert.equal((await next).status, 'cancelled'); h.adapter.destroy();
});

test('copy fallback accepts only canonical own referral URLs; Telegram links cannot escape the bot allowlist', async () => {
  const h = harness(), ownUrl = 'https://t.me/RE_Program_Bot?start=partner_abC123';
  assert.equal((await h.adapter.copyOwnReferral({ authority: 'worker', ownUrl })).status, 'copied');
  assert.deepEqual(h.calls[0], ['writeText', ownUrl]);
  for (const bad of ['javascript:alert(1)', `${ownUrl}&account=other`, 'https://t.me/evil?start=partner_abC123', 'https://t.me/RE_Program_Bot?start=ref_123']) {
    assert.equal(safeOwnReferralUrl(bad), null);
    assert.equal((await h.adapter.copyOwnReferral({ authority: 'worker', ownUrl: bad })).status, 'unavailable');
  }
  assert.equal(safeTelegramActionUrl('https://t.me/RE_Program_Bot?start=sub_dragon'), 'https://t.me/RE_Program_Bot?start=sub_dragon');
  assert.equal(safeTelegramActionUrl('https://t.me/RE_Program_Bot?start=sub_dragon#x'), null);
  assert.equal(h.adapter.openTelegramLink('https://t.me/RE_Program_Support_Bot?start=paysupport').status, 'opened'); h.adapter.destroy();
});

test('clearPrivate settles outstanding work and destroy removes all subscriptions and timers', async () => {
  const h = harness(); let notices = 0; const stop = h.adapter.subscribe(() => notices++);
  const share = h.adapter.sharePreparedMessage(prepared()); assert.ok(notices > 0);
  h.adapter.clearPrivate(); assert.equal((await share).status, 'cleared');
  const before = notices; stop(); h.emit('safeAreaChanged'); assert.equal(notices, before);
  h.adapter.destroy(); h.shareResult(true); h.tick();
  assert.equal(h.adapter.capabilities().shareMessage, false); assert.equal(h.adapter.snapshot().usefulAction, false);
});
