import test from 'node:test';
import assert from 'node:assert/strict';
import { foundationFixture, signedInitData } from './helpers/v1.4.1-fixtures.mjs';
import { createCustomerContext, createServiceExecutor, readTrustedContext,
  compileContextAssertions, isTrustedContext, SERVICE_PURPOSES, SERVICE_CANONICAL_PURPOSES } from '../src/v1.4.1/trusted-context.mjs';
import { FIXED_OPERATION_ALIASES } from '../src/v1.4.1/capability-policy.mjs';

test('actual signed init data creates immutable request-local customer provenance on primary session', async t => {
  const f = foundationFixture(t);
  const a = await f.context(), b = await f.context();
  assert.equal(isTrustedContext(a), true); assert.equal(isTrustedContext(JSON.parse(JSON.stringify(a))), false);
  assert.throws(() => readTrustedContext({ actorKind: 'customer', telegramId: 900 }), /untrusted_context/u);
  const facts = readTrustedContext(a);
  assert.equal(facts.telegramId, 101); assert.equal(facts.env.ADMIN_ID, '900');
  assert.ok(Object.isFrozen(a) && Object.isFrozen(facts) && Object.isFrozen(facts.env));
  assert.notEqual(a, b); assert.notEqual(a.requestId, b.requestId);
  assert.equal(f.binding.sessions.at(-1), 'first-primary');
  assert.equal(f.binding.audit.filter(x => x.mode === 'write').length, 0);
});
test('forged identity, stale authentication, ambiguous transport, serialized Telegram privilege all fail', async t => {
  const f = foundationFixture(t);
  const forged = new URLSearchParams(signedInitData(900, f.now));
  const originalHash = forged.get('hash');
  forged.set('hash', (originalHash[0] === '0' ? '1' : '0') + originalHash.slice(1));
  await assert.rejects(f.context(101, 'application.create', 'mini_app', { initData: forged.toString() }));
  await assert.rejects(f.context(101, 'application.create', 'mini_app', { initData: signedInitData(101, f.now - 301) }), /stale_init_data/u);
  await assert.rejects(f.context(101, 'application.create', 'mini_app', { sessionToken: 'rpms1_' + 'a'.repeat(43) }), /ambiguous_authentication/u);
  await assert.rejects(createCustomerContext({ binding: f.binding, env: f.serverEnv,
    channel: 'telegram_command', operation: 'admin.cabinet', nowSeconds: f.now,
    telegramContext: { authoritySource: 'verified_telegram_update', telegramId: 900 } }), /untrusted_telegram_context/u);
});
test('session authority comes from exact database row and is fenced against revoke/replacement', async t => {
  const f = foundationFixture(t); await f.session(101);
  const context = await createCustomerContext({ binding: f.binding, env: f.serverEnv,
    sessionToken: f.tokens.get(101), channel: 'mini_app', operation: 'application.create', nowSeconds: f.now });
  const proof = compileContextAssertions(context);
  assert.equal(f.sqlite.prepare(`SELECT (${proof.sql}) AS ok`).get(...proof.params).ok, 1);
  f.sqlite.exec("UPDATE mini_app_sessions SET status='revoked', revoked_at=unixepoch() WHERE telegram_id=101");
  assert.equal(f.sqlite.prepare(`SELECT (${proof.sql}) AS ok`).get(...proof.params).ok, 0);
  await assert.rejects(createCustomerContext({ binding: f.binding, env: f.serverEnv,
    sessionToken: f.tokens.get(101), channel: 'mini_app', operation: 'application.create', nowSeconds: f.now }), /invalid_session/u);
});
test('all ten service purposes are fixed by server executor and never mutable job authority', t => {
  const f = foundationFixture(t);
  for (const [purpose, capability] of Object.entries(SERVICE_PURPOSES)) {
    const executor = createServiceExecutor({ binding: f.binding, env: f.serverEnv, purpose, clockSeconds: () => f.now });
    const facts = readTrustedContext(executor.createContext({ purpose: 'stars_process_event', telegramId: 900 }));
    assert.equal(facts.actorKind, 'service'); assert.equal(facts.executorPurpose, purpose);
    assert.equal(facts.purpose, SERVICE_CANONICAL_PURPOSES[purpose]);
    assert.equal(facts.capability, capability); assert.equal(facts.telegramId, null);
  }
  assert.throws(() => createServiceExecutor({ binding: f.binding, env: f.serverEnv, purpose: 'arbitrary' }), /unknown_service_purpose/u);
});
test('failed canonical session read cannot mint provenance from cached-looking rows', async t => {
  const f = foundationFixture(t); await f.session(101);
  const original = f.binding.prepare.bind(f.binding);
  f.binding.prepare = sql => {
    const statement = original(sql);
    if (!sql.includes('FROM mini_app_sessions WHERE session_token_hash=')) return statement;
    return { bind(...params) {
      const bound = statement.bind(...params);
      return { async all() { const result = await bound.all(); return { ...result, success: false }; } };
    } };
  };
  await assert.rejects(createCustomerContext({ binding: f.binding, env: f.serverEnv,
    sessionToken: f.tokens.get(101), channel: 'mini_app', operation: 'application.create',
    nowSeconds: f.now }), /session_read_failed/u);
});
test('normal Telegram message/callback identity requires real webhook secret and current processing claim', async t => {
  const f = foundationFixture(t), claim = 'synthetic-processing-claim-0001';
  const env = { ...f.serverEnv, WEBHOOK_SECRET: 'synthetic-webhook-secret-only-for-tests' };
  for (const [updateId, channel] of [[10, 'telegram_command'], [11, 'telegram_callback']]) {
    const callback = channel === 'telegram_callback';
    f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,claim_token,received_at,lease_expires_at)
      VALUES(?,?,?,?,?,?)`).run(updateId, callback ? 'callback_query' : 'message', 101, claim, f.now, f.now + 120);
    const message = { date: f.now, chat: { id: 101, type: 'private' },
      from: { id: callback ? 123456789 : 101, is_bot: callback }, text: '/offers' };
    const update = callback ? { update_id: updateId, callback_query: { id: 'synthetic_callback',
      from: { id: 101, is_bot: false }, message, data: 'existing_route' } } : { update_id: updateId, message };
    const request = secret => new Request('https://bot.example/webhook', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update) });
    const build = (secret = env.WEBHOOK_SECRET, token = claim) => createCustomerContext({ binding: f.binding, env,
      webhookRequest: request(secret), receiptClaimToken: token, channel, operation: 'offer.read_own', nowSeconds: f.now });
    const context = await build();
    assert.equal(readTrustedContext(context).telegramId, 101);
    assert.equal(readTrustedContext(context).channel, channel);
    const proof = compileContextAssertions(context);
    assert.equal(f.sqlite.prepare(`SELECT (${proof.sql}) AS ok`).get(...proof.params).ok, 1);
    await assert.rejects(build('invalid_secret'), /untrusted_telegram_update/u);
    await assert.rejects(build(env.WEBHOOK_SECRET, 'another-synthetic-claim'), /invalid_telegram_receipt/u);
    f.sqlite.prepare('UPDATE telegram_update_receipts SET lease_expires_at=? WHERE update_id=?').run('garbage', updateId);
    await assert.rejects(build(), /invalid_telegram_receipt/u);
    f.sqlite.prepare('UPDATE telegram_update_receipts SET lease_expires_at=? WHERE update_id=?').run(f.now + 120, updateId);
    f.sqlite.prepare("UPDATE telegram_update_receipts SET status='abandoned' WHERE update_id=?").run(updateId);
    assert.equal(f.sqlite.prepare(`SELECT (${proof.sql}) AS ok`).get(...proof.params).ok, 0);
    await assert.rejects(build(), /invalid_telegram_receipt/u);
  }
});
test('stable operation identity binds authenticated subject and operation; payload hash detects key reuse', async t => {
  const f = foundationFixture(t), key = 'synthetic_operation_key_0001';
  const build = (id, operation, requestPayload) => f.context(id, operation, 'mini_app', { idempotencyKey: key, requestPayload });
  const a = readTrustedContext(await build(101, 'ai.public.answer', { b: 2, a: 'hello' }));
  const b = readTrustedContext(await build(101, 'ai.public.answer', { a: 'hello', b: 2 }));
  const altered = readTrustedContext(await build(101, 'ai.public.answer', { a: 'changed', b: 2 }));
  assert.equal(a.operationId, b.operationId); assert.equal(a.payloadHash, b.payloadHash);
  assert.equal(a.operationId, altered.operationId); assert.notEqual(a.payloadHash, altered.payloadHash);
  assert.notEqual(a.operationId, readTrustedContext(await build(202, 'ai.public.answer', { b: 2, a: 'hello' })).operationId);
  assert.notEqual(a.operationId, readTrustedContext(await build(101, 'ai.public.history', { b: 2, a: 'hello' })).operationId);
  assert.equal(readTrustedContext(await f.context()).operationId, null);
  await assert.rejects(f.context(101, 'ai.public.answer', 'mini_app', { idempotencyKey: key }), /missing_operation_payload/u);
});
test('only compiled operation aliases are normalized before canonical readers and stable receipt binding', async t => {
  const f = foundationFixture(t), pair = Object.entries(FIXED_OPERATION_ALIASES)[0];
  assert.ok(pair);
  const patch = { idempotencyKey: 'synthetic_alias_request_001', requestPayload: {} };
  const alias = readTrustedContext(await f.context(101, pair[0], 'mini_app', patch));
  const canonical = readTrustedContext(await f.context(101, pair[1], 'mini_app', patch));
  assert.equal(alias.operation, pair[1]); assert.equal(alias.operationId, canonical.operationId);
  await assert.rejects(f.context(101, '/invented_admin_route'), /invalid_transport/u);
});
