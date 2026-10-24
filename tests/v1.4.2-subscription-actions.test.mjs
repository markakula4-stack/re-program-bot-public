import test from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionFixture, subscriptionServerDTO } from './helpers/v1.4.2-subscription-fixtures.mjs';
import { approvedPartner } from './helpers/v1.4.0-rebuild-sqlite.mjs';
import { createRuntimeAuthorizer, runtimeAuthorizationDTO } from '../src/v1.4.1/runtime-authorizer.mjs';
import { savePreparedOwnReferralMessage, REFERRAL_SHARE_RELEASED_TEXT } from '../src/v1.4.2/telegram-native-provider.mjs';
import { MiniAppClient, readSubscriptionDTO, readPreparedReferralDTO } from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';

const ORIGIN = 'https://cabinet.example', TOKEN = 'rpms1_' + 'a'.repeat(43);
const response = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject }; };
const authorizer = createRuntimeAuthorizer();

async function fixture(t) {
  const f = subscriptionFixture(t, { envPatch: { STARS_ROLLOUT_ALLOWLIST: '101,202' } });
  await approvedPartner(f, 202);
  const authorization = await authorizer.authorize(await f.context(202, 'referral.link.read_own'));
  // Real provider projection against an offline Bot API response. No Telegram
  // call is made and a receipt is never represented as message delivery.
  const provider = await savePreparedOwnReferralMessage({ authorization, nowSeconds: f.now,
    fetchImpl: async () => response({ ok: true, result: { id: 'offline-prepared_202:message', expiration_date: f.now + 1800 } }) });
  const prepared = { version: 1, authority: 'worker', preparedMessageId: provider.preparedMessageId,
    expiresAt: provider.expiresAt, ownUrl: 'https://t.me/RE_Program_Bot?start=partner_synthetic_202',
    releasedText: REFERRAL_SHARE_RELEASED_TEXT, prepared: true, sent: false,
    authorization: runtimeAuthorizationDTO(authorization) };
  return { ...f, prepared, subscription: await subscriptionServerDTO(f, 202) };
}
function browser(f, handler) {
  const calls = [], clock = { now: f.now * 1000 };
  const client = new MiniAppClient({ origin: ORIGIN, now: () => clock.now,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return url.endsWith('/session') ? response({ sessionToken: TOKEN, tokenType: 'Bearer', expiresAt: f.now + 300,
        features: { version: 1, mutationsEnabled: true, offerActionsEnabled: false } }) : handler(url, init);
    } });
  return { client, calls, clock };
}

test('selected-plan links use the real server admission and never create an invoice or access', async t => {
  const f = await fixture(t), writesBefore = f.sqlite.prepare('SELECT total_changes() AS n').get().n;
  const dto = readSubscriptionDTO(await subscriptionServerDTO(f));
  for (const plan of ['professional', 'dragon']) {
    const offer = dto.catalog.offers.find(row => row.planCode === plan);
    assert.equal(offer.checkout.available, true);
    assert.equal(offer.checkout.url, `https://t.me/RE_Program_Bot?start=subscribe_${plan}`);
    assert.equal(offer.checkout.hintIsAuthority, false);
    assert.equal(offer.purchaseEligibility.invoiceRequiresConfirmedTerms, true);
  }
  assert.equal(dto.access.current.planCode, 'free');
  assert.equal(f.sqlite.prepare('SELECT total_changes() AS n').get().n, writesBefore);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_orders').get().n, 0);
  const initial = await subscriptionServerDTO(f);
  for (const edit of [
    x => { x.catalog.offers[1].checkout.url = 'https://t.me/RE_Program_Bot?start=subscribe_dragon'; },
    x => { x.catalog.offers[1].checkout.url += '&amount=1'; },
    x => { x.catalog.offers[1].checkout.url = 'https://t.me.evil.example/RE_Program_Bot?start=subscribe_professional'; },
    x => { x.catalog.offers[1].checkout.url = 'https://secret@t.me/RE_Program_Bot?start=subscribe_professional'; },
    x => { x.catalog.offers[1].checkout.acceptanceCallback = 'stars_accept:professional:1:249:invented'; },
    x => { x.catalog.offers[1].checkout.hintIsAuthority = true; },
  ]) { const bad = structuredClone(initial); edit(bad); assert.throws(() => readSubscriptionDTO(bad), { code: 'invalid_response' }); }
  f.serverEnv.STARS_PAYMENTS_ENABLED = 'false';
  const closed = readSubscriptionDTO(await subscriptionServerDTO(f));
  assert.equal(closed.catalog.offers[1].checkout.available, false);
  assert.equal(closed.catalog.offers[1].checkout.url, null);
  assert.equal(closed.catalog.offers[1].checkout.reasonCode, 'stars_payments_disabled');
  const forged = structuredClone(closed); forged.catalog.offers[1].checkout.available = true;
  forged.catalog.offers[1].checkout.url = 'https://t.me/RE_Program_Bot?start=subscribe_professional';
  assert.throws(() => readSubscriptionDTO(forged), { code: 'invalid_response' });
});

test('own referral metadata is genuine, bounded and unavailable to an ordinary unapproved user', async t => {
  const f = await fixture(t), dto = readSubscriptionDTO(f.subscription);
  assert.equal(dto.catalog.nativeDependencies.referralShare.available, true);
  assert.equal(dto.catalog.nativeDependencies.referralShare.ownUrl, f.prepared.ownUrl);
  assert.equal(dto.catalog.nativeDependencies.referralShare.preparationRequired, true);
  assert.equal(dto.catalog.nativeDependencies.referralShare.preparedMessageId, null);
  assert.equal(readSubscriptionDTO(await subscriptionServerDTO(f)).catalog.nativeDependencies.referralShare.available, false);
  for (const edit of [
    x => { x.catalog.nativeDependencies.referralShare.ownUrl += '&session_token=private'; },
    x => { x.catalog.nativeDependencies.referralShare.ownUrl = 'https://t.me/OTHER?start=partner_synthetic_202'; },
    x => { x.catalog.nativeDependencies.referralShare.releasedText = 'Invented promotion'; },
    x => { x.catalog.nativeDependencies.referralShare.preparedMessageId = 'client-invented'; },
    x => { x.catalog.nativeDependencies.dragonEmoji.available = true; },
  ]) { const bad = structuredClone(f.subscription); edit(bad); assert.throws(() => readSubscriptionDTO(bad), { code: 'invalid_response' }); }
});

test('preparation posts the fixed empty own request with bound Bearer, origin and a single click key', async t => {
  const f = await fixture(t), pending = deferred();
  const { client, calls } = browser(f, url => url.endsWith('/subscription') ? response(f.subscription) : pending.promise);
  await client.authenticate('signed-offline'); await client.read('subscription');
  const first = client.prepareOwnReferralMessage(), second = client.prepareOwnReferralMessage();
  assert.equal(first, second); assert.equal(calls.length, 3);
  const { url, init } = calls.at(-1);
  assert.equal(url, ORIGIN + '/api/v1.4.0/cabinet/referral/prepared');
  assert.equal(init.method, 'POST'); assert.equal(init.body, '{}');
  assert.equal(init.headers.Authorization, 'Bearer ' + TOKEN); assert.equal(init.headers.Origin, ORIGIN);
  assert.match(init.headers['Idempotency-Key'], /^[a-f0-9]{48}$/u);
  assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
  pending.resolve(response(f.prepared));
  const result = await first;
  assert.equal(result.prepared, true); assert.equal(result.sent, false); assert.equal(result.commitStatus, undefined);
  assert.equal(result.authorization.capability, 'referral.link.read_own'); assert.ok(Object.isFrozen(result.authorization));
  await assert.rejects(client.prepareOwnReferralMessage({ telegramId: 101, ownUrl: 'https://evil.example' }), { code: 'invalid_request' });
  assert.equal(calls.length, 3); assert.equal(client.uncertain, false);
});

test('malformed prepared IDs, URLs, expiry and foreign authorization never reach a native share call', async t => {
  const f = await fixture(t), options = { nowSeconds: f.now, sessionExpiresAt: f.now + 300, expectedOwnUrl: f.prepared.ownUrl };
  assert.equal(readPreparedReferralDTO(f.prepared, options).preparedMessageId, f.prepared.preparedMessageId);
  for (const edit of [
    x => { x.preparedMessageId = ''; }, x => { x.preparedMessageId = 'line\nbreak'; }, x => { x.preparedMessageId = 'a'.repeat(257); },
    x => { x.expiresAt = f.now; }, x => { x.expiresAt = f.now + 86401; },
    x => { x.ownUrl = 'javascript:alert(1)'; }, x => { x.ownUrl = 'https://t.me/RE_Program_Bot?start=partner_foreign'; },
    x => { x.ownUrl += '&token=private'; }, x => { x.releasedText = 'Changed text'; }, x => { x.sent = true; },
    x => { x.commitStatus = 'committed'; }, x => { x.authorization.allowed = false; },
    x => { x.authorization.capability = 'profile.read_own'; }, x => { x.authorization.actor = { telegramId: 202 }; },
    x => { x.authorization.validUntil = f.now; },
  ]) { const bad = structuredClone(f.prepared); edit(bad); assert.throws(() => readPreparedReferralDTO(bad, options), { code: 'invalid_response' }); }
});

test('a lost external preparation is uncertain once and does not freeze unrelated account mutations', async t => {
  const f = await fixture(t);
  const { client, calls } = browser(f, url => url.endsWith('/referral/prepared')
    ? Promise.reject(new TypeError('connection lost')) : response({ commitStatus: 'committed' }));
  await client.authenticate('signed-offline');
  await assert.rejects(client.prepareOwnReferralMessage(), { code: 'prepared_message_effect_unknown' });
  assert.equal(client.referralPreparationUncertain, true); assert.equal(client.uncertain, false);
  await assert.rejects(client.prepareOwnReferralMessage(), { code: 'prepared_message_effect_unknown' });
  assert.equal(calls.length, 2);
  assert.equal((await client.mutate('offer.create', {})).commitStatus, 'committed');
  assert.equal(calls.length, 3);
});

test('malformed successful preparations and server failures are unknown but a valid Telegram rejection is a known failure', async t => {
  const f = await fixture(t);
  for (const returned of [response({ ...f.prepared, sent: true }), response({ error: 'provider_error' }, 502),
    response({ error: 'referral_share_not_allowed', authorization: { ...f.prepared.authorization, capability: 'profile.read_own' } }, 403),
    new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } })]) {
    const { client, calls } = browser(f, () => returned);
    await client.authenticate('signed-offline');
    await assert.rejects(client.prepareOwnReferralMessage(), { code: 'prepared_message_effect_unknown' });
    assert.equal(client.referralPreparationUncertain, true); assert.equal(client.uncertain, false);
    await assert.rejects(client.prepareOwnReferralMessage(), { code: 'prepared_message_effect_unknown' });
    assert.equal(calls.length, 2);
  }
  const { client } = browser(f, () => response({ error: 'prepared_message_rejected' }, 502));
  await client.authenticate('signed-offline');
  await assert.rejects(client.prepareOwnReferralMessage(), { code: 'prepared_message_rejected' });
  assert.equal(client.referralPreparationUncertain, false); assert.equal(client.uncertain, false);
});

test('session expiry erases the pending prepared response and never leaks a late message ID', async t => {
  const f = await fixture(t), pending = deferred(), { client, calls, clock } = browser(f, () => pending.promise);
  await client.authenticate('signed-offline');
  const request = client.prepareOwnReferralMessage();
  clock.now = (f.now + 301) * 1000;
  pending.resolve(response(f.prepared));
  await assert.rejects(request, { code: 'session_expired' });
  assert.equal(client.authenticated, false); assert.equal(client.referralPreparationUncertain, true);
  assert.equal(client.uncertain, false); assert.equal(calls.length, 2);
});
