import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foundationFixture, signedInitData } from './helpers/v1.4.1-fixtures.mjs';
import { createCabinetHttp } from '../src/v1.4.0-rebuild/cabinet-http.mjs';

const ORIGIN = 'https://cabinet.example';
let sequence = 0;
function fixture(t, { partner = true, provider, beforeFence } = {}) {
  const f = foundationFixture(t);
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql', import.meta.url), 'utf8'));
  const candidate = 'a'.repeat(40), issued = f.now - 1, expires = f.now + 600;
  f.sqlite.prepare(`INSERT INTO mini_app_release_control
    (id,candidate_sha,revision,state,beta_enabled,owner_telegram_id,issued_at,expires_at,updated_at)
    VALUES(1,?,1,'open',1,101,?,?,?) ON CONFLICT(id) DO UPDATE SET
      candidate_sha=excluded.candidate_sha,revision=1,state='open',beta_enabled=1,
      owner_telegram_id=101,issued_at=excluded.issued_at,expires_at=excluded.expires_at,
      updated_at=excluded.updated_at`).run(candidate, issued, expires, f.now);
  if (partner) {
    const application = f.sqlite.prepare(`INSERT INTO partner_applications
      (telegram_id,display_name,contact,age_confirmed,status,reviewed_by,reviewed_at)
      VALUES(101,'Offline','@synthetic',1,'approved',900,datetime('now'))`).run();
    f.sqlite.prepare(`INSERT INTO partner_profiles(telegram_id,application_id,display_name,contact,status,approved_by)
      VALUES(101,?,'Offline','@synthetic','active',900)`).run(Number(application.lastInsertRowid));
    f.sqlite.exec("INSERT INTO user_roles(telegram_id,role,status) VALUES(101,'partner','active')");
  }
  const env = { ...f.serverEnv, V141_AUTHORIZATION_ENABLED: 'true',
    REBUILD_V140_ADMIN_ACCESS_ENABLED: 'true', REBUILD_V140_RELEASE_LEASE_REQUIRED: 'true',
    REBUILD_V140_RC_SHA: candidate, REBUILD_V140_RELEASE_REVISION: '1',
    REBUILD_V140_OWNER_TELEGRAM_ID: '101', REBUILD_V140_OWNER_WINDOW: `true:${issued}:${expires}`,
    REBUILD_V140_WRITES_ENABLED: 'false' };
  let now = f.now, fenceCalled = false;
  const calls = [], repositoryModes = [];
  const http = createCabinetHttp({ clock: () => now,
    repositoryFactory: async (scopedEnv, options) => {
      repositoryModes.push(options.readOnly);
      const repo = await f.repositoryFactory(scopedEnv, options);
      return { ...repo, assertReadFence: async input => {
        if (!fenceCalled && beforeFence) { fenceCalled = true; await beforeFence(f); }
        return repo.assertReadFence(input);
      } };
    },
    nativeProviderFetch: async (url, options) => {
      const call = { url, options, payload: JSON.parse(options.body) }; calls.push(call);
      if (provider) return provider(f, { setNow: value => { now = value; }, call });
      return Response.json({ ok: true, result: { id: 'offline-http-provider-ID', expiration_date: f.now + 3600 } });
    },
  });
  const request = async (path, { method = 'POST', payload = {}, token, headers = {}, customEnv = env } = {}) => {
    const response = await http(new Request(`${ORIGIN}/api/v1.4.0/cabinet/${path}`, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(method === 'POST' ? { Origin: ORIGIN, 'Content-Type': 'application/json',
          'Idempotency-Key': `offline_v142_native_share_${++sequence}`, 'Sec-Fetch-Site': 'same-origin' } : {}), ...headers },
      ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
    }), customEnv);
    return { status: response.status, data: await response.json() };
  };
  const open = async (id = 101) => {
    const result = await request('session', { payload: { initData: signedInitData(id, f.now) } });
    assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.sessionToken;
  };
  return { ...f, env, calls, repositoryModes, request, open };
}
const businessSnapshot = f => JSON.stringify(['user_plans', 'user_access_states', 'user_access', 'trial_grants',
  'subscriptions', 'subscription_orders', 'payment_ledger', 'subscription_access_grants',
  'mini_app_command_receipts', 'entitlement_decision_audit', 'mini_app_effect_outbox']
  .map(table => [table, f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

test('authenticated own preparation uses real provider response and SELECT-only storage, never delivery or purchase', async t => {
  const f = fixture(t), token = await f.open();
  f.repositoryModes.length = 0; f.binding.audit.length = 0;
  const before = businessSnapshot(f);
  const read = await f.request('subscription', { method: 'GET', token });
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.equal(f.calls.length, 0, 'opening subscription cannot prepare or send a message');
  f.binding.audit.length = 0;
  const result = await f.request('referral/prepared', { token });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.authorization.capability, 'referral.link.read_own');
  assert.equal(result.data.authorization.allowed, true);
  assert.equal(result.data.preparedMessageId, 'offline-http-provider-ID');
  assert.equal(result.data.prepared, true); assert.equal(result.data.sent, false);
  assert.equal(result.data.ownUrl, 'https://t.me/RE_Program_Bot?start=partner_synthetic_101');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].payload.user_id, 101);
  assert.ok(f.repositoryModes.length && f.repositoryModes.every(Boolean));
  assert.ok(f.binding.audit.length && f.binding.audit.every(row => row.mode === 'read'));
  const reads = f.binding.audit.filter(row => row.mode === 'read').length;
  assert.ok(reads <= 160, 'preparation must finish inside the original query budget after the provider returns');
  t.diagnostic(`referral preparation SQL count=${reads}, budget=160`);
  assert.equal(businessSnapshot(f), before);
  assert.ok(!JSON.stringify(result.data).includes(f.env.BOT_TOKEN));
});

test('query, hash, selected actor/content, cross origin and missing idempotency reject before provider', async t => {
  const f = fixture(t), token = await f.open();
  for (const [path, options] of [
    ['referral/prepared?telegramId=202', {}], ['referral/prepared#other', {}],
    ['referral/prepared', { payload: { userId: 202 } }],
    ['referral/prepared', { payload: { ownUrl: 'https://evil.example', text: 'Injected' } }],
    ['referral/prepared', { headers: { Origin: 'https://evil.example' } }],
    ['referral/prepared', { headers: { 'Idempotency-Key': '' } }],
    ['referral/prepared', { method: 'GET' }], ['referral/prepared/', {}],
  ]) {
    const result = await f.request(path, { token, ...options });
    assert.notEqual(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.preparedMessageId, undefined);
  }
  assert.equal(f.calls.length, 0);
});

test('ordinary user and permanent admin without approved adult partner cannot prepare a referral', async t => {
  const f = fixture(t, { partner: false });
  for (const id of [101, 900]) {
    const token = await f.open(id), result = await f.request('referral/prepared', { token });
    assert.notEqual(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.preparedMessageId, undefined);
  }
  assert.equal(f.calls.length, 0);
});

test('source changes between authorization and effect block preparation with zero provider calls', async t => {
  const f = fixture(t, { beforeFence: f => f.sqlite.exec("UPDATE users SET is_blocked=1 WHERE telegram_id=101") });
  const token = await f.open(), result = await f.request('referral/prepared', { token });
  assert.notEqual(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.preparedMessageId, undefined); assert.equal(f.calls.length, 0);
});

test('session revocation or expired real clock during preparation discards returned provider id', async t => {
  for (const mode of ['revoked', 'expired']) {
    const f = fixture(t, { provider: (f, { setNow }) => {
      if (mode === 'revoked') f.sqlite.exec("UPDATE mini_app_sessions SET status='revoked' WHERE telegram_id=101");
      else setNow(f.now + 301);
      return Response.json({ ok: true, result: { id: 'discard-this-provider-ID', expiration_date: f.now + 3600 } });
    } });
    const token = await f.open(), result = await f.request('referral/prepared', { token });
    assert.notEqual(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.preparedMessageId, undefined); assert.equal(f.calls.length, 1);
    assert.ok(!JSON.stringify(result.data).includes('discard-this-provider-ID'));
  }
});

test('lost provider response is unknown with one attempt and no access grant or token leak', async t => {
  const f = fixture(t, { provider: () => { throw new Error('private provider details'); } });
  const token = await f.open(), before = businessSnapshot(f);
  const result = await f.request('referral/prepared', { token });
  assert.equal(result.status, 502);
  assert.equal(result.data.error, 'prepared_message_effect_unknown');
  assert.equal(result.data.preparedMessageId, undefined); assert.equal(f.calls.length, 1);
  assert.equal(businessSnapshot(f), before);
  assert.ok(!JSON.stringify(result.data).includes('private provider details'));
});

test('missing or wrong-bot provider token is unavailable and cannot trigger an API request', async t => {
  const f = fixture(t), token = await f.open();
  const result = await f.request('referral/prepared', { token,
    customEnv: { ...f.env, BOT_TOKEN: '777777777:synthetic-other-bot-token' } });
  assert.notEqual(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.preparedMessageId, undefined); assert.equal(f.calls.length, 0);
});
