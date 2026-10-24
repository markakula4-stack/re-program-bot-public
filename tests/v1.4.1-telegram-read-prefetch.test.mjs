import assert from 'node:assert/strict';
import test from 'node:test';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { createCustomerContext } from '../src/v1.4.1/trusted-context.mjs';
import { authorizeTelegramHandler } from '../src/v1.4.1/telegram-runtime.mjs';
import { createAuthorityResolver, readActorFacts, compileAuthorityAssertions } from '../src/v1.4.1/authority-resolver.mjs';
import { createRuntimeAuthorizer, runtimeAuthorizationDTO, assertRuntimeAuthorizationFresh } from '../src/v1.4.1/runtime-authorizer.mjs';

let sequence = 1417000;
const sourceBatch = statements => statements.length === 32 &&
  statements.every(statement => statement.sql.startsWith('SELECT COALESCE(json_group_array(json(authority_row))'));

function measuredBinding(raw) {
  const native = new WeakMap();
  const metrics = { first: 0, all: 0, batches: [], maxSqlBytes: 0, maxParams: 0, failure: null };
  const record = statement => {
    metrics.maxSqlBytes = Math.max(metrics.maxSqlBytes, new TextEncoder().encode(statement.sql).length);
    metrics.maxParams = Math.max(metrics.maxParams, statement.params.length);
  };
  const wrap = statement => {
    record(statement);
    const value = {
      sql: statement.sql, params: statement.params,
      bind: (...params) => wrap(statement.bind(...params)),
      first: (...args) => { metrics.first++; return statement.first(...args); },
      all: (...args) => { metrics.all++; return statement.all(...args); },
      run: (...args) => statement.run(...args),
    };
    native.set(value, statement);
    return value;
  };
  const binding = {
    prepare: sql => wrap(raw.prepare(sql)),
    withSession: mode => { raw.withSession(mode); return binding; },
    async batch(statements) {
      const values = statements.map(statement => native.get(statement));
      const isSource = sourceBatch(values);
      metrics.batches.push({ source: isSource, count: values.length });
      const failure = isSource ? metrics.failure : null;
      if (failure) metrics.failure = null;
      if (failure === 'throw') throw new Error('offline injected source batch failure');
      const result = await raw.batch(values);
      if (failure === 'missing_result') return result.slice(1);
      if (failure === 'failed_result') return result.map((row, index) => index === 0 ? { ...row, success: false } : row);
      if (failure === 'invalid_snapshot') {
        const key = Object.keys(result[0].results[0])[0];
        return result.map((row, index) => index === 0 ? { ...row, results: [{ [key]: null }] } : row);
      }
      return result;
    },
  };
  const reset = () => {
    Object.assign(metrics, { first: 0, all: 0, batches: [], maxSqlBytes: 0, maxParams: 0, failure: null });
    raw.audit.length = 0;
  };
  return { binding, metrics, reset };
}

async function telegramContext(f, binding, { selector = 'menu', operation = 'account.menu.read', id = 101,
  command = false } = {}) {
  const updateId = ++sequence, claim = 'offline-read-prefetch-claim-' + updateId;
  const env = { ...f.serverEnv, WEBHOOK_SECRET: 'offline-read-prefetch-webhook-secret' };
  const from = { id, is_bot: false, first_name: 'Offline' }, chat = { id, type: 'private' };
  const update = command ? { update_id: updateId, message: { message_id: updateId, date: f.now, from, chat, text: selector } }
    : { update_id: updateId, callback_query: { id: 'offline-callback-' + updateId, from, data: selector,
      message: { message_id: updateId, date: f.now, from: { id: 123456789, is_bot: true }, chat } } };
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,received_at,lease_expires_at)
    VALUES(?,?,?,'processing',?,?,?)`).run(updateId, command ? 'message' : 'callback_query', id, claim, f.now, f.now + 240);
  const request = new Request('https://cabinet.example/webhook', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.WEBHOOK_SECRET },
    body: JSON.stringify(update) });
  const context = await createCustomerContext({ binding, env, webhookRequest: request, receiptClaimToken: claim,
    channel: command ? 'telegram_command' : 'telegram_callback', operation, nowSeconds: f.now });
  return { context, update, updateId };
}

test('genuine menu/help/profile Telegram reads retain full proofs while batching 32 independent SELECTs', async t => {
  for (const [selector, operation, command] of [['menu', 'account.menu.read', false], ['/help', 'help.read', true],
    ['terms', 'terms.read', false], ['support', 'support.basic', false], ['/profile', 'profile.read_own', true]]) {
    await t.test(operation, async t => {
      const f = foundationFixture(t), measured = measuredBinding(f.binding);
      const { context, update } = await telegramContext(f, measured.binding, { selector, operation, command });
      measured.reset();
      const selected = await authorizeTelegramHandler(context, update);
      assert.equal(selected.handler.capability, operation);
      assert.equal(runtimeAuthorizationDTO(selected.authorization).allowed, true);
      // v1.4.4 keeps package/referral schema absence in the proof: one
      // package probe plus referral objects/marker add two first + one all.
      assert.equal(measured.metrics.first, 5);
      assert.equal(measured.metrics.all, 1);
      assert.deepEqual(measured.metrics.batches, [{ source: true, count: 32 }]);
      assert.equal(f.binding.audit.length, 38);
      assert.equal(f.binding.audit.every(row => row.mode === 'read'), true);
      assert.ok(measured.metrics.maxSqlBytes <= 100000);
      assert.ok(measured.metrics.maxParams <= 100);
      await assertRuntimeAuthorizationFresh(selected.authorization);
    });
  }
});

test('failed or malformed source batches fall back to byte-identical actor facts and every source assertion', async t => {
  for (const failure of ['throw', 'missing_result', 'failed_result', 'invalid_snapshot']) {
    await t.test(failure, async t => {
      const f = foundationFixture(t), measured = measuredBinding(f.binding);
      const { context } = await telegramContext(f, measured.binding);
      const resolver = createAuthorityResolver();
      const baseline = await resolver.resolveActor(context);
      measured.reset();
      measured.metrics.failure = failure;
      const fallback = await resolver.resolveActor(context);
      assert.deepEqual(readActorFacts(fallback), readActorFacts(baseline));
      assert.deepEqual(compileAuthorityAssertions(fallback), compileAuthorityAssertions(baseline));
      assert.equal(measured.metrics.first, 37);
      assert.equal(measured.metrics.all, 1);
      assert.deepEqual(measured.metrics.batches, [{ source: true, count: 32 }]);
    });
  }
});

test('new invocations reread an account changed after a completed source batch', async t => {
  const f = foundationFixture(t), measured = measuredBinding(f.binding);
  const { context } = await telegramContext(f, measured.binding);
  const resolver = createAuthorityResolver();
  const first = await resolver.resolveActor(context);
  assert.equal(readActorFacts(first).account.isBlocked, false);
  f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=101').run();
  measured.reset();
  const second = await resolver.resolveActor(context);
  assert.equal(readActorFacts(second).account.isBlocked, true);
  assert.notEqual(readActorFacts(second).sourceFingerprint, readActorFacts(first).sourceFingerprint);
  assert.deepEqual(measured.metrics.batches, [{ source: true, count: 32 }]);
});

test('blocking, role changes and privacy deletion after prefetch invalidate the original presentation', async t => {
  for (const [name, mutate] of [
    ['block', f => f.sqlite.exec('UPDATE users SET is_blocked=1 WHERE telegram_id=101')],
    ['role', f => f.sqlite.exec("UPDATE user_roles SET status='paused' WHERE telegram_id=101 AND role='user'")],
    ['privacy', f => f.sqlite.prepare(`INSERT INTO privacy_deletion_requests(request_id,telegram_id,confirmation_token,status,expires_at)
      VALUES('offline-read-race',101,'offline-read-race-confirm','pending',datetime(?,'unixepoch'))`).run(f.now + 300)],
  ]) {
    await t.test(name, async t => {
      const f = foundationFixture(t), measured = measuredBinding(f.binding);
      const { context } = await telegramContext(f, measured.binding);
      const authorizer = createRuntimeAuthorizer(), authorization = await authorizer.authorize(context);
      assert.equal(runtimeAuthorizationDTO(authorization).allowed, true);
      mutate(f);
      await assert.rejects(assertRuntimeAuthorizationFresh(authorization), { code: 'authority_stale' });
      const changed = await authorizer.authorize(context);
      assert.equal(runtimeAuthorizationDTO(changed).allowed, false);
    });
  }
});

test('lost Telegram receipt claims remain fenced after a batched read', async t => {
  const f = foundationFixture(t), measured = measuredBinding(f.binding);
  const { context, updateId } = await telegramContext(f, measured.binding);
  const authorization = await createRuntimeAuthorizer().authorize(context);
  f.sqlite.prepare("UPDATE telegram_update_receipts SET status='completed' WHERE update_id=?").run(updateId);
  await assert.rejects(assertRuntimeAuthorizationFresh(authorization), { code: 'authority_stale' });
});

test('late package or referral schema activation invalidates the prefetched authority',async t=>{
  for(const table of ['subscription_package_periods','package_referral_bonus_grants']) {
    await t.test(table,async t=>{
      const f=foundationFixture(t),measured=measuredBinding(f.binding);
      const {context}=await telegramContext(f,measured.binding);
      const authorization=await createRuntimeAuthorizer().authorize(context);
      assert.equal(runtimeAuthorizationDTO(authorization).allowed,true);
      f.sqlite.exec(`CREATE TABLE ${table}(offline_test_column TEXT)`);
      await assert.rejects(assertRuntimeAuthorizationFresh(authorization),{code:'authority_stale'});
    });
  }
});

test('batch failure preserves protected optional-source degradation and mandatory account failure', async t => {
  const f = foundationFixture(t), measured = measuredBinding(f.binding);
  const { context } = await telegramContext(f, measured.binding, { selector: '/help', operation: 'help.read', command: true });
  f.sqlite.exec('DROP TABLE entitlement_grants');
  const authorization = await createRuntimeAuthorizer().authorize(context);
  assert.equal(runtimeAuthorizationDTO(authorization).allowed, true);
  await assertRuntimeAuthorizationFresh(authorization);
  f.sqlite.exec('ALTER TABLE users RENAME TO offline_unavailable_users');
  await assert.rejects(createAuthorityResolver().resolveActor(context), { code: 'authority_unavailable' });
});

test('financial mutation and Mini App reads remain sequential with package schema guards', async t => {
  const f = foundationFixture(t), measured = measuredBinding(f.binding);
  const { context } = await telegramContext(f, measured.binding, { operation: 'billing.purchase_monthly' });
  measured.reset();
  await createAuthorityResolver().resolveActor(context);
  assert.equal(measured.metrics.first, 37);
  assert.equal(measured.metrics.all, 1);
  assert.deepEqual(measured.metrics.batches, []);
  const mini = await f.context(101, 'account.menu.read');
  f.binding.audit.length = 0;
  await createAuthorityResolver().resolveActor(mini);
  assert.equal(f.binding.audit.length, 38);
});
