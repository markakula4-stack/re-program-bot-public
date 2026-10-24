import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foundationFixture, signedInitData } from './helpers/v1.4.1-fixtures.mjs';
import { resolveCabinetReadRoute } from '../src/v1.4.0-rebuild/cabinet-read-model.mjs';

function envFor(f) {
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql', import.meta.url), 'utf8'));
  const candidate = 'a'.repeat(40), issued = f.now - 1, expires = f.now + 600;
  f.sqlite.prepare(`INSERT INTO mini_app_release_control
    (id,candidate_sha,revision,state,beta_enabled,owner_telegram_id,issued_at,expires_at,updated_at)
    VALUES(1,?,1,'open',1,101,?,?,?) ON CONFLICT(id) DO UPDATE SET
      candidate_sha=excluded.candidate_sha,revision=1,state='open',beta_enabled=1,
      owner_telegram_id=101,issued_at=excluded.issued_at,expires_at=excluded.expires_at,
      updated_at=excluded.updated_at`).run(candidate, issued, expires, f.now);
  return { ...f.serverEnv, V141_AUTHORIZATION_ENABLED: 'true',
    REBUILD_V140_ADMIN_ACCESS_ENABLED: 'true', REBUILD_V140_RELEASE_LEASE_REQUIRED: 'true',
    REBUILD_V140_RC_SHA: candidate, REBUILD_V140_RELEASE_REVISION: '1',
    REBUILD_V140_OWNER_TELEGRAM_ID: '101',
    REBUILD_V140_OWNER_WINDOW: `true:${issued}:${expires}` };
}
async function open(f, env, id = 101) {
  const response = await f.call(id, 'session', { method: 'POST', token: null,
    payload: { initData: signedInitData(id, f.now) }, customEnv: env });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data.sessionToken;
}
const call = (f, env, token, path = 'subscription', options = {}) =>
  f.call(101, path, { token, customEnv: env, ...options });
function businessSnapshot(f) {
  return JSON.stringify(['user_plans', 'user_access_states', 'user_access', 'trial_grants',
    'subscriptions', 'subscription_orders', 'payment_ledger', 'subscription_access_grants',
    'mini_app_command_receipts', 'entitlement_decision_audit', 'mini_app_effect_outbox']
    .map(table => [table, f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test('subscription is one fixed GET route; actor and plan cannot be selected by URL', () => {
  assert.deepEqual(resolveCabinetReadRoute({ method: 'GET',
    url: 'https://cabinet.example/api/v1.4.0/cabinet/subscription' }),
  { routeCode: 'cabinet.subscription', params: {} });
  for (const query of ['telegramId=202', 'plan=dragon', 'view=other', '']) {
    if (!query) continue;
    assert.throws(() => resolveCabinetReadRoute({ method: 'GET',
      url: `https://cabinet.example/api/v1.4.0/cabinet/subscription?${query}` }),
    error => error.code === 'bad_request');
  }
  assert.throws(() => resolveCabinetReadRoute({ method: 'POST',
    url: 'https://cabinet.example/api/v1.4.0/cabinet/subscription' }),
  error => error.code === 'method_not_allowed');
});

test('signed own subscription GET has real authorization and leaves business state unchanged', async t => {
  const f = foundationFixture(t), env = envFor(f), token = await open(f, env);
  const before = businessSnapshot(f), auditStart = f.binding.audit.length;
  const response = await call(f, env, token);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const dto = response.data;
  assert.equal(dto.authority, 'worker');
  assert.equal(dto.authorization.capability, 'access.read_own');
  assert.equal(dto.authorization.allowed, true);
  assert.equal(dto.access.current.planCode, 'free');
  assert.equal(dto.access.current.expiresAt, null);
  assert.equal(dto.quotas.quotas.length, 3);
  assert.equal(dto.quotas.actionAdmissionRequired, true);
  assert.equal(businessSnapshot(f), before);
  const reads = f.binding.audit.slice(auditStart);
  assert.ok(reads.length > 0);
  assert.ok(reads.every(row => row.mode === 'read'));
  assert.ok(reads.length < 220, `unbounded subscription reads: ${reads.length}`);
  const serialized = JSON.stringify(dto);
  for (const privateField of ['sourceFingerprint', 'accountFingerprint', 'subject_fingerprint',
    'telegram_payment_charge_id', 'BOT_TOKEN', 'STARS_INVOICE_SECRET', 'assertions', 'canonical']) {
    assert.ok(!serialized.includes(`\"${privateField}\"`), privateField);
  }
});

test('forged query, expired or revoked session and nonparticipant receive no subscription DTO', async t => {
  const f = foundationFixture(t), env = envFor(f), token = await open(f, env);
  const query = await call(f, env, token, 'subscription?telegramId=202');
  assert.equal(query.status, 400);
  assert.equal(query.data.access, undefined);
  const participant = await f.call(303, 'session', { method: 'POST', token: null,
    payload: { initData: signedInitData(303, f.now) }, customEnv: env });
  assert.notEqual(participant.status, 200);
  f.sqlite.prepare("UPDATE mini_app_sessions SET status='revoked',revoked_at=? WHERE telegram_id=101").run(f.now);
  const revoked = await call(f, env, token);
  assert.ok([401, 403, 503].includes(revoked.status), JSON.stringify(revoked.data));
  assert.equal(revoked.data.access, undefined);
  const another = await open(f, env);
  f.sqlite.prepare('UPDATE mini_app_sessions SET issued_at=?,expires_at=? WHERE telegram_id=101')
    .run(f.now - 301, f.now - 1);
  const expired = await call(f, env, another);
  assert.ok([401, 403, 503].includes(expired.status), JSON.stringify(expired.data));
  assert.equal(expired.data.access, undefined);
});

test('subscription has no legacy authority fallback and opening it cannot accept terms', async t => {
  const f = foundationFixture(t), env = envFor(f), token = await open(f, env);
  const disabled = await call(f, { ...env, V141_AUTHORIZATION_ENABLED: 'false' }, token);
  assert.equal(disabled.status, 503);
  assert.equal(disabled.data.access, undefined);
  const post = await call(f, env, token, 'subscription', { method: 'POST', payload: {},
    key: 'v142_forbidden_subscription_write' });
  assert.equal(post.status, 404);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_orders').get().n, 0);
});

test('closing participant lease keeps the permanent owner entry separate from paid Dragon', async t => {
  const f = foundationFixture(t), env = envFor(f);
  const ownerToken = await open(f, env, 900), pilotToken = await open(f, env);
  f.sqlite.prepare("UPDATE mini_app_release_control SET state='closed',beta_enabled=0,owner_telegram_id=NULL,issued_at=NULL,expires_at=NULL").run();
  const closedEnv = { ...env, REBUILD_V140_OWNER_WINDOW: `true:${f.now - 601}:${f.now - 1}` };
  const owner = await call(f, closedEnv, ownerToken);
  assert.equal(owner.status, 200, JSON.stringify(owner.data));
  assert.equal(owner.data.access.current.planCode, 'free');
  assert.equal(owner.data.access.current.activeDragon, false);
  assert.equal(owner.data.access.ownerException.isPaidPlan, false);
  const pilot = await call(f, closedEnv, pilotToken);
  assert.notEqual(pilot.status, 200);
  assert.equal(pilot.data.access, undefined);
});
