import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../src/v1.4.0-rebuild/worker-entrypoint.mjs';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { ORIGIN } from './helpers/v1.4.0-rebuild-sqlite.mjs';
import { V141_WORKER_RUNTIME_KEY } from '../src/v1.4.1/worker-runtime.mjs';
import { runtimeContext } from '../src/v1.4.1/runtime-binding.mjs';
import { readTrustedContext } from '../src/v1.4.1/trusted-context.mjs';

test('actual verified webhook claims the menu callback before its sole ACK, inherits trusted identity, and deduplicates replay', async t => {
  const f = foundationFixture(t);
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql', import.meta.url), 'utf8'));
  f.sqlite.prepare('INSERT OR IGNORE INTO admin_safety_runtime_settings(id,updated_at) VALUES(1,?)').run(f.now);
  const sha = 'a'.repeat(40), issued = f.now - 1, expires = f.now + 600;
  f.sqlite.prepare(`INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,
    owner_telegram_id,issued_at,expires_at,updated_at) VALUES(1,?,1,'open',1,101,?,?,?)`).run(sha, issued, expires, f.now);
  const env = { ...f.serverEnv, V141_AUTHORIZATION_ENABLED: 'true', REBUILD_V140_ADMIN_ACCESS_ENABLED: 'true',
    REBUILD_V140_RELEASE_LEASE_REQUIRED: 'true', REBUILD_V140_RC_SHA: sha, REBUILD_V140_RELEASE_REVISION: '1',
    REBUILD_V140_OWNER_TELEGRAM_ID: '101', REBUILD_V140_OWNER_WINDOW: `true:${issued}:${expires}`,
    WEBHOOK_SECRET: 'offline-callback-entry-secret' };
  const update = { update_id: 1_434_910, callback_query: { id: 'offline-entry-callback', data: 'menu',
    from: { id: 101, is_bot: false }, message: { message_id: 30, date: f.now,
      from: { id: Number(env.BOT_TOKEN.split(':')[0]), is_bot: true }, chat: { id: 101, type: 'private' } } } };
  const request = () => new Request(ORIGIN + '/webhook', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.WEBHOOK_SECRET,
  }, body: JSON.stringify(update) });
  const savedFetch = globalThis.fetch, savedRuntime = globalThis[V141_WORKER_RUNTIME_KEY];
  t.after(() => { globalThis.fetch = savedFetch; globalThis[V141_WORKER_RUNTIME_KEY] = savedRuntime; });
  const calls = [], background = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(url).hostname, 'api.telegram.org', 'only synthetic Telegram transport');
    const method = new URL(url).pathname.split('/').at(-1), body = JSON.parse(init.body);
    calls.push({ method, body });
    if (method === 'answerCallbackQuery') {
      const receipt = f.sqlite.prepare('SELECT status,claim_token FROM telegram_update_receipts WHERE update_id=?').get(update.update_id);
      assert.equal(receipt?.status, 'processing'); assert.ok(receipt.claim_token);
      assert.deepEqual(body, { callback_query_id: update.callback_query.id });
    }
    return Response.json({ ok: true, result: ['sendMessage', 'editMessageText'].includes(method) ? { message_id: 77 } : true });
  };
  let releaseGuard, entered;
  const pendingGuard = new Promise(resolve => { releaseGuard = resolve; });
  const guardEntered = new Promise(resolve => { entered = resolve; });
  globalThis[V141_WORKER_RUNTIME_KEY] = { ...savedRuntime, async guardDispatch(scoped, actualUpdate) {
    const identity = readTrustedContext(runtimeContext(scoped));
    assert.equal(identity.telegramId, 101); assert.equal(identity.channel, 'telegram_callback');
    assert.equal(identity.transportBinding.updateId, update.update_id);
    assert.equal(calls.filter(row => row.method === 'answerCallbackQuery').length, 1, 'ACK has started before heavy authority reads');
    entered(); await pendingGuard;
    return savedRuntime.guardDispatch(scoped, actualUpdate);
  } };
  const ctx = { waitUntil: promise => { background.push(promise); } };
  const work = worker.fetch(request(), env, ctx);
  await Promise.race([guardEntered, work.then(async response => {
    throw new Error('webhook completed before guard: ' + response.status + ' ' + await response.clone().text());
  })]);
  assert.equal(calls.filter(row => ['sendMessage', 'editMessageText'].includes(row.method)).length, 0);
  releaseGuard();
  const response = await work; assert.equal(response.status, 200, await response.text());
  await Promise.all(background);
  assert.equal(calls.filter(row => row.method === 'answerCallbackQuery').length, 1);
  assert.ok(calls.some(row => ['sendMessage', 'editMessageText'].includes(row.method)), JSON.stringify({
    methods: calls.map(row => row.method), errors: f.sqlite.prepare('SELECT context,message FROM bot_error_log').all(),
  }));
  const replay = await worker.fetch(request(), env, ctx);
  assert.equal(replay.status, 200); assert.equal(calls.filter(row => row.method === 'answerCallbackQuery').length, 1);
  assert.equal(f.sqlite.prepare('SELECT status FROM telegram_update_receipts WHERE update_id=?').get(update.update_id).status, 'completed');
});
