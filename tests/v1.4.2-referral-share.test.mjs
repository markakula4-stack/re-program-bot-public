import test from 'node:test';
import assert from 'node:assert/strict';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { createRuntimeAuthorizer } from '../src/v1.4.1/runtime-authorizer.mjs';
import { readOwnReferralDescriptor, prepareOwnReferralMessage } from '../src/v1.4.2/referral-share.mjs';
import { REFERRAL_SHARE_RELEASED_TEXT } from '../src/v1.4.2/telegram-native-provider.mjs';

const authorizer = createRuntimeAuthorizer(); let sequence = 0;
const sqlTime = value => new Date(value * 1000).toISOString().slice(0, 19).replace('T', ' ');
function partner(f, id = 202) {
  const application = f.sqlite.prepare(`INSERT INTO partner_applications(telegram_id,display_name,contact,
    age_confirmed,status,reviewed_by,reviewed_at) VALUES(?,'Synthetic','@synthetic',1,'approved',900,?)`)
    .run(id, sqlTime(f.now));
  const profile = f.sqlite.prepare(`INSERT INTO partner_profiles(telegram_id,application_id,display_name,
    contact,status,approved_by) VALUES(?,?,'Synthetic','@synthetic','active',900)`)
    .run(id, Number(application.lastInsertRowid));
  f.sqlite.prepare("INSERT INTO user_roles(telegram_id,role,status) VALUES(?,'partner','active')").run(id);
  return { profileId: Number(profile.lastInsertRowid), applicationId: Number(application.lastInsertRowid) };
}
async function authorization(f, { id = 202, operation = 'referral.link.read_own', body = {}, http = true } = {}) {
  if (http && !f.tokens.has(id)) await f.session(id);
  return authorizer.authorize(await f.context(id, operation, 'mini_app', http
    ? { initData: undefined, sessionToken: f.tokens.get(id), requestPayload: body,
      idempotencyKey: `offline_referral_${++sequence}` }
    : { requestPayload: body }));
}
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
function provider(f, hook) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, options, payload: JSON.parse(options.body) });
    if (hook) return hook(calls.at(-1));
    return json({ ok: true, result: { id: 'offline-real-provider-response-ID', expiration_date: f.now + 3600 } });
  } };
}
const prepare = (f, auth, transport, patch = {}) => prepareOwnReferralMessage({ authorization: auth,
  body: {}, assertFence: async () => {}, nowSeconds: () => f.now, fetchImpl: transport.fetchImpl, ...patch });

test('catalog descriptor derives only a canonical approved adult partner URL and requires no paid tier', async t => {
  const f = foundationFixture(t); partner(f);
  const auth = await authorization(f, { operation: 'access.read_own' });
  f.binding.audit.length = 0;
  assert.deepEqual(readOwnReferralDescriptor(auth), { available: true, reasonCode: 'eligible',
    ownUrl: 'https://t.me/RE_Program_Bot?start=partner_synthetic_202', releasedText: REFERRAL_SHARE_RELEASED_TEXT,
    preparationRequired: true, preparedMessageId: null });
  assert.equal(f.binding.audit.length, 0, 'projection performs no SQL, provider or provisioning');
  const user = readOwnReferralDescriptor(await authorization(f, { id: 101, operation: 'access.read_own' }));
  assert.equal(user.available, false); assert.equal(user.ownUrl, null);
  assert.equal(user.reasonCode, 'approved_adult_partner_required');
  const owner = readOwnReferralDescriptor(await authorization(f, { id: 900, operation: 'access.read_own' }));
  assert.equal(owner.available, false, 'admin status never creates a partner profile');
});

test('inactive, unapproved, missing age or role and invalid start codes cannot prepare a referral', async t => {
  for (const sql of ["UPDATE partner_profiles SET status='paused' WHERE telegram_id=202",
    "UPDATE partner_applications SET status='pending' WHERE telegram_id=202",
    'UPDATE partner_applications SET age_confirmed=0 WHERE telegram_id=202',
    "UPDATE user_roles SET status='paused' WHERE telegram_id=202 AND role='partner'",
    "UPDATE users SET referral_code='bad code/?target=303' WHERE telegram_id=202"] ) {
    const f = foundationFixture(t); partner(f); f.sqlite.exec(sql);
    const auth = await authorization(f), transport = provider(f), descriptor = readOwnReferralDescriptor(auth);
    assert.equal(descriptor.available, false); assert.equal(descriptor.ownUrl, null);
    await assert.rejects(prepare(f, auth, transport), error =>
      ['approved_adult_partner_required', 'own_referral_code_unavailable'].includes(error.code));
    assert.equal(transport.calls.length, 0);
  }
});

test('the real fixed Bot API payload is own-scoped; preparation returns no sent or token claim', async t => {
  const f = foundationFixture(t); partner(f);
  const auth = await authorization(f), transport = provider(f); f.binding.audit.length = 0;
  let fences = 0;
  const dto = await prepare(f, auth, transport, { assertFence: async () => { fences++; } });
  assert.equal(fences, 2); assert.equal(transport.calls.length, 1);
  const { url, options, payload } = transport.calls[0];
  assert.equal(url, `https://api.telegram.org/bot${f.serverEnv.BOT_TOKEN}/savePreparedInlineMessage`);
  assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
  assert.equal(payload.user_id, 202); assert.equal(payload.result.type, 'article');
  assert.equal(payload.result.input_message_content.message_text,
    `${REFERRAL_SHARE_RELEASED_TEXT}\n\nhttps://t.me/RE_Program_Bot?start=partner_synthetic_202`);
  assert.deepEqual(payload.result.reply_markup.inline_keyboard,
    [[{ text: 'Открыть RE Program', url: 'https://t.me/RE_Program_Bot?start=partner_synthetic_202' }]]);
  assert.deepEqual([payload.allow_user_chats, payload.allow_bot_chats,
    payload.allow_group_chats, payload.allow_channel_chats], [true, false, true, true]);
  assert.deepEqual(dto, { version: 1, authority: 'worker', preparedMessageId: 'offline-real-provider-response-ID',
    expiresAt: f.now + 3600, ownUrl: 'https://t.me/RE_Program_Bot?start=partner_synthetic_202',
    releasedText: REFERRAL_SHARE_RELEASED_TEXT, prepared: true, sent: false });
  assert.ok(Object.isFrozen(dto));
  assert.ok(f.binding.audit.length > 0 && f.binding.audit.every(row => row.mode === 'read'));
  assert.equal(JSON.stringify(dto).includes(f.serverEnv.BOT_TOKEN), false);
  assert.equal(JSON.stringify(dto).includes('202,'), false);
});

test('fabricated authority, wrong operations, caller result/identity/content and unbound transport cause zero effects', async t => {
  const f = foundationFixture(t); partner(f);
  const auth = await authorization(f), transport = provider(f);
  await assert.rejects(prepare(f, { ...auth }, transport), { code: 'untrusted_runtime_authorization' });
  const access = await authorization(f, { operation: 'access.read_own' });
  await assert.rejects(prepare(f, access, transport), { code: 'referral_share_scope_mismatch' });
  assert.throws(() => readOwnReferralDescriptor({ version: 1 }), { code: 'untrusted_runtime_authorization' });
  for (const body of [{ userId: 303 }, { ownUrl: 'https://evil.example' }, { text: 'Injected' },
    { preparedMessageId: 'fake-id' }, { result: {} }, [], null]) {
    await assert.rejects(prepare(f, auth, transport, { body }), { code: 'invalid_referral_share_payload' });
  }
  const unbound = await authorization(f, { http: false });
  await assert.rejects(prepare(f, unbound, transport), { code: 'referral_share_transport_required' });
  const mismatchedBody = await authorization(f, { body: { ownUrl: 'https://evil.example' } });
  await assert.rejects(prepare(f, mismatchedBody, transport), { code: 'invalid_referral_share_payload' });
  await assert.rejects(prepare(f, auth, transport, { assertFence: undefined }), { code: 'referral_share_transport_required' });
  assert.equal(transport.calls.length, 0);
});

test('canonical revocation or changed own referral source before the provider causes zero calls', async t => {
  for (const sql of ['UPDATE users SET is_blocked=1 WHERE telegram_id=202',
    "UPDATE users SET referral_code='rotated_202' WHERE telegram_id=202",
    "UPDATE partner_profiles SET status='paused' WHERE telegram_id=202",
    "UPDATE mini_app_sessions SET status='revoked',revoked_at=unixepoch() WHERE telegram_id=202"] ) {
    const f = foundationFixture(t); partner(f);
    const auth = await authorization(f), transport = provider(f);
    await assert.rejects(prepare(f, auth, transport, { assertFence: async () => { f.sqlite.exec(sql); } }),
      { code: 'authority_stale' });
    assert.equal(transport.calls.length, 0);
  }
});

test('revocation or source rotation during preparation suppresses the prepared ID after the one provider effect', async t => {
  for (const sql of ["UPDATE users SET referral_code='rotated_202' WHERE telegram_id=202",
    "UPDATE mini_app_sessions SET status='revoked',revoked_at=unixepoch() WHERE telegram_id=202"] ) {
    const f = foundationFixture(t); partner(f);
    const auth = await authorization(f), transport = provider(f, () => {
      f.sqlite.exec(sql);
      return json({ ok: true, result: { id: 'must-not-be-returned', expiration_date: f.now + 3600 } });
    });
    await assert.rejects(prepare(f, auth, transport), { code: 'authority_stale' });
    assert.equal(transport.calls.length, 1);
  }
});

test('captured release fence is rechecked immediately before and after the external effect', async t => {
  const f = foundationFixture(t); partner(f); const auth = await authorization(f);
  const before = provider(f);
  await assert.rejects(prepare(f, auth, before, { assertFence: async () => {
    throw Object.assign(new Error('release_lease_unavailable'), { code: 'release_lease_unavailable' });
  } }), { code: 'release_lease_unavailable' });
  assert.equal(before.calls.length, 0);
  let checks = 0; const after = provider(f);
  await assert.rejects(prepare(f, auth, after, { assertFence: async () => {
    if (++checks === 2) throw Object.assign(new Error('release_source_changed'), { code: 'release_source_changed' });
  } }), { code: 'release_source_changed' });
  assert.equal(after.calls.length, 1);
});

test('wall clock expiry before a request prevents the effect; expiry during it prevents any ID response', async t => {
  const f = foundationFixture(t); partner(f); const auth = await authorization(f), transport = provider(f);
  await assert.rejects(prepare(f, auth, transport, { nowSeconds: () => f.now + 300 }), { code: 'expired_authentication' });
  assert.equal(transport.calls.length, 0);
  let current = f.now;
  const delayed = provider(f, () => { current += 300; return json({ ok: true,
    result: { id: 'expired-own-session', expiration_date: f.now + 3600 } }); });
  await assert.rejects(prepare(f, auth, delayed, { nowSeconds: () => current }), { code: 'expired_authentication' });
  assert.equal(delayed.calls.length, 1);
});

test('provider rejection is sanitized and network loss is unknown without automatic retries', async t => {
  const f = foundationFixture(t); partner(f); const auth = await authorization(f);
  const rejected = provider(f, () => json({ ok: false, description: `secret=${f.serverEnv.BOT_TOKEN}` }, 400));
  await assert.rejects(prepare(f, auth, rejected), error => error.code === 'prepared_message_rejected'
    && error.message === 'prepared_message_rejected' && !JSON.stringify(error).includes(f.serverEnv.BOT_TOKEN));
  assert.equal(rejected.calls.length, 1);
  const lost = provider(f, () => { throw new Error(`network failed at bot${f.serverEnv.BOT_TOKEN}`); });
  await assert.rejects(prepare(f, auth, lost), error => error.code === 'prepared_message_effect_unknown'
    && error.message === 'prepared_message_effect_unknown');
  assert.equal(lost.calls.length, 1);
});

test('provider timeout aborts the single effect even if a transport ignores AbortSignal', async t => {
  const f = foundationFixture(t); partner(f); const auth = await authorization(f);
  const transport = provider(f, () => new Promise(() => {}));
  await assert.rejects(prepare(f, auth, transport, { timeoutMs: 10 }), { code: 'prepared_message_effect_unknown' });
  assert.equal(transport.calls.length, 1); assert.equal(transport.calls[0].options.signal.aborted, true);
});

test('invalid, expired, overlong or non-JSON provider output never becomes a prepared DTO', async t => {
  const f = foundationFixture(t); partner(f); const auth = await authorization(f);
  const replies = [() => json({ ok: true, result: { id: 'made up id', expiration_date: f.now + 3600 } }),
    () => json({ ok: true, result: { id: 'valid-id', expiration_date: f.now } }),
    () => json({ ok: true, result: { id: 'valid-id', expiration_date: f.now + 86401 } }),
    () => json({ ok: true, result: { id: 'valid-id', expiration_date: String(f.now + 3600) } }),
    () => new Response('<html>failed</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{bad json', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(JSON.stringify({ ok: true, result: { id: 'valid-id', expiration_date: f.now + 3600 },
      padding: 'x'.repeat(17000) }), { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('', { status: 302, headers: { 'Content-Type': 'application/json', Location: 'https://evil.example' } })];
  for (const reply of replies) {
    const transport = provider(f, reply);
    await assert.rejects(prepare(f, auth, transport), { code: 'prepared_message_effect_unknown' });
    assert.equal(transport.calls.length, 1);
  }
});
