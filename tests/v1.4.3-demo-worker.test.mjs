import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createDemoWorker, createDemoTelegramTransport, classifyDemoDiagnostic, redactDemoNativeDetail } from '../src/v1.4.3-demo/worker.mjs';
import { DEMO_JS, DEMO_CSS, renderDemoHtml } from '../src/v1.4.3-demo/ui.mjs';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { DEMO_GUARD_CODES, DEMO_GUARD_LOOKUP } from '../src/v1.4.3-demo/guard-diagnostics.mjs';

const ORIGIN = 'https://re-program-stars-demo.example';
const TOKEN = '123456789:offline_demo_token_material_only_123';
const NOW = 1791123000;
function initData({ id = 900, now = NOW, token = TOKEN } = {}) {
  const fields = { auth_date: String(now), query_id: 'demo_offline_01', user: JSON.stringify({ id, first_name: 'Offline owner' }) };
  const check = Object.entries(fields).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(token).digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', key).update(check).digest('hex') }).toString();
}
function receiptDatabase(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../src/v1.4.3-demo/schema.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const db = { prepare(sql) { return { bind(...params) { return {
    async run() { const result = sqlite.prepare(sql).run(...params); return { success: true, meta: { changes: Number(result.changes) } }; },
  }; } }; } };
  return { db, sqlite };
}
function fixture({ bot = { id: 123456789, is_bot: true, username: 'RE_TG_TEST_bot' }, actError, db,
  transportHook } = {}) {
  let now = NOW;
  const engineCalls = [], transportCalls = [];
  const state = { demo: true, balance: 1000, nowSec: NOW + 2592000 * 20, subscription: {}, receipts: [] };
  const env = { DEMO_MODE: 'virtual-stars-only', DEMO_DB: db ?? { prepare() { throw new Error('unexpected direct database call'); } },
    DEMO_BOT_ID: '123456789', DEMO_BOT_USERNAME: 'RE_TG_TEST_bot', DEMO_OWNER_ID: '900', DEMO_ORIGIN: ORIGIN,
    BOT_TOKEN: TOKEN, DEMO_SESSION_SECRET: 'offline_session_secret_32_characters',
    DEMO_WEBHOOK_SECRET: 'offline_webhook_secret_32_characters', DEMO_INVOICE_SECRET: 'offline_invoice_secret_32_characters',
    DEMO_SOURCE_SHA: 'a'.repeat(40) };
  const worker = createDemoWorker({ wallNowSeconds: () => now,
    engineFactory: async options => { engineCalls.push({ kind: 'construct', ...options }); return {
      async read() { engineCalls.push({ kind: 'read' }); return state; },
      async act(action) { engineCalls.push({ kind: 'act', ...action }); if (actError) throw actError; return state; },
    }; },
    fetchImpl: async (url, options) => { const method = new URL(url).pathname.split('/').at(-1); transportCalls.push({ method, body: JSON.parse(options.body) });
      if (transportHook) await transportHook(method, JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, result: method === 'getMe' ? bot : { message_id: 1 } }), { headers: { 'Content-Type': 'application/json' } }); },
  });
  const call = (path, { method = 'GET', body, cookie, headers = {}, environment = env } = {}) => worker.fetch(new Request(ORIGIN + path, {
    method, headers: { Origin: ORIGIN, 'X-Re-Demo': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), environment);
  const login = async (payload = initData()) => {
    const result = await call('/api/session', { method: 'POST', body: { initData: payload } });
    assert.equal(result.status, 200, await result.clone().text());
    return result.headers.get('set-cookie').split(';')[0];
  };
  return { worker, env, call, login, engineCalls, transportCalls, setNow(value) { now = value; } };
}

test('public shell and health reveal no owner data, ledger or simulation controls', async () => {
  const f = fixture();
  const page = await f.call('/demo'); assert.equal(page.status, 200);
  assert.match(await page.text(), /Песочница · оплаты нет/u);
  const health = await f.call('/health'); assert.deepEqual(await health.json(), { ok: true, service: 're-program-stars-demo', mode: 'virtual-stars-only', realPaymentsEnabled: false, sourceSha: 'a'.repeat(40) });
  for (const [path, method, body] of [['/api/state', 'GET'], ['/api/action', 'POST', { action: 'reset', operationId: 'offline_01' }]]) {
    assert.equal((await f.call(path, { method, body })).status, 401);
  }
  assert.equal(f.engineCalls.length, 0); assert.equal(f.transportCalls.length, 0);
});

test('forged, wrong-bot, stale, future and nonowner initData stop before any engine or Telegram call', async () => {
  const f = fixture();
  const forged = new URLSearchParams(initData()); forged.set('hash', '0'.repeat(64));
  for (const signed of [forged.toString(), initData({ token: '987654321:other_offline_token_material_123' }), initData({ now: NOW - 301 }), initData({ now: NOW + 61 }), initData({ id: 901 })]) {
    const result = await f.call('/api/session', { method: 'POST', body: { initData: signed } });
    assert.equal(result.status, 401); assert.equal(result.headers.get('set-cookie'), null);
    const text = await result.text(); assert.ok(!text.includes(signed)); assert.ok(!text.includes(TOKEN));
  }
  assert.equal(f.engineCalls.length, 0); assert.equal(f.transportCalls.length, 0);
});

test('fresh owner auth checks actual dedicated bot identity and issues secure cookie', async () => {
  const f = fixture(); const cookie = await f.login();
  assert.match(cookie, /^__Host-re_demo=/u);
  assert.deepEqual(f.transportCalls.map(call => call.method), ['getMe']);
  const response = await f.call('/api/state', { cookie }); assert.equal(response.status, 200);
  assert.equal((await response.json()).state.nowSec, NOW + 2592000 * 20);
  assert.equal(f.engineCalls[0].wallNowSeconds, NOW);
  const validSession = await f.call('/api/session', { method: 'POST', body: { initData: initData() } });
  assert.match(validSession.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=None/u);
});

test('wrong live getMe bot ID or username blocks owner session', async () => {
  for (const bot of [{ id: 987654321, is_bot: true, username: 'RE_TG_TEST_bot' }, { id: 123456789, is_bot: true, username: 'unexpected_bot' }, { id: 123456789, is_bot: false, username: 'RE_TG_TEST_bot' }]) {
    const f = fixture({ bot });
    const response = await f.call('/api/session', { method: 'POST', body: { initData: initData() } });
    assert.equal(response.status, 503); assert.equal(response.headers.get('set-cookie'), null); assert.equal(f.engineCalls.length, 0);
  }
});

test('cookie owner, signature and real-wall-clock expiration cannot be chosen by browser or virtual clock', async () => {
  const f = fixture(); const cookie = await f.login();
  assert.equal((await f.call('/api/state', { cookie: cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a') })).status, 401);
  assert.equal((await f.call('/api/state', { cookie, environment: { ...f.env, DEMO_OWNER_ID: '901' } })).status, 401);
  f.setNow(NOW + 3600);
  assert.equal((await f.call('/api/state', { cookie })).status, 401);
  assert.equal(f.engineCalls.length, 0);
});

test('cross-origin and non-JSON mutations are denied even with valid owner cookie', async () => {
  const f = fixture(); const cookie = await f.login();
  for (const headers of [{ Origin: 'https://other.example' }, { Origin: '' }, { 'X-Re-Demo': '' }]) {
    assert.equal((await f.call('/api/action', { method: 'POST', cookie, body: { action: 'reset', operationId: 'offline_01' }, headers })).status, 403);
  }
  const response = await f.call('/api/action', { method: 'POST', cookie, body: { action: 'reset', operationId: 'offline_01' }, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(response.status, 415); assert.equal(f.engineCalls.length, 0);
});

test('test purchase requires explicit consent; HTTP action payload cannot forge provider event or balance', async () => {
  const f = fixture(); const cookie = await f.login();
  for (const body of [
    { action: 'buy', planCode: 'professional', operationId: 'offline_01' },
    { action: 'buy', planCode: 'professional', operationId: 'offline_01', consent: false },
    { action: 'reset', operationId: 'offline_01', balance: 9999 },
    { action: 'refundStarPayment', operationId: 'offline_01' },
    { action: 'buy', planCode: 'invalid', operationId: 'offline_01', consent: true },
  ]) assert.equal((await f.call('/api/action', { method: 'POST', cookie, body })).status, 400);
  assert.equal(f.engineCalls.length, 0);
  const response = await f.call('/api/action', { method: 'POST', cookie, body: { action: 'buy', planCode: 'professional', operationId: 'offline_01', consent: true } });
  assert.equal(response.status, 200);
  assert.deepEqual(f.engineCalls.at(-1), { kind: 'act', action: 'buy', planCode: 'professional', operationId: 'offline_01' });
  assert.deepEqual(f.transportCalls.map(call => call.method), ['getMe']);
});

test('sandbox configuration fails closed for production DB, production token, mode and origin', async () => {
  const f = fixture();
  for (const patch of [{ DEMO_MODE: 'live' }, { DB: {} }, { DEMO_BOT_ID: '8562951985', BOT_TOKEN: '8562951985:offline_demo_token_material_only_123' },
    { DEMO_BOT_ID: '999999999' }, { DEMO_ORIGIN: 'https://re-program-bot.markakula4.workers.dev' }, { DEMO_SESSION_SECRET: 'short' }]) {
    assert.equal((await f.call('/health', { environment: { ...f.env, ...patch } })).status, 503);
  }
  assert.equal(f.engineCalls.length, 0); assert.equal(f.transportCalls.length, 0);
});

test('demo control cooldown exposes only bounded retry information and understandable UI message', async () => {
  for (const [input, bounded] of [[1, 1], [999999, 60], [-5, 1], ['private-error-details', 1]]) {
    const f = fixture({ actError: Object.assign(new Error('private SQL/token details'), { code: 'demo_control_cooldown', status: 429, retryAfterSeconds: input }) });
    const cookie = await f.login();
    const result = await f.call('/api/action', { method: 'POST', cookie, body: { action: 'resume', operationId: 'offline_cooldown_01' } });
    assert.equal(result.status, 429);
    assert.equal(result.headers.get('retry-after'), String(bounded));
    assert.deepEqual(await result.json(), { ok: false, error: 'demo_control_cooldown', retryAfterSeconds: bounded });
  }
  assert.match(DEMO_JS, /Подождите секунду и повторите запрос/u);
});

test('native diagnostic inspects bounded causes and exposes only fixed stages/categories/code', async () => {
  const cases = [
    ['Too many API requests by single Worker invocation', 'd1_query_limit'],
    ['Too many subrequests', 'd1_query_limit'],
    ['D1_TYPE_ERROR: Type object is not supported', 'binding_unsupported'],
    ['Wrong number of parameter bindings for SQL query', 'binding_unsupported'],
    ['Invalid type for parameter: undefined', 'binding_unsupported'],
    ['too many SQL variables', 'binding_unsupported'],
    ['D1_ERROR: FOREIGN KEY constraint failed', 'constraint'],
    ['D1_ERROR: no such table: private_table', 'schema'],
    ['D1_ERROR: near private_token syntax error: SQLITE_ERROR', 'schema'],
    ['D1_ERROR: not authorized', 'authorization_denied'],
    ['D1_ERROR: otherwise unspecified SQLITE_ERROR', 'sqlite_error'],
    ['D1_ERROR: database is unavailable', 'unavailable'],
    ['private SQL/token/unknown details', 'unknown'],
  ];
  for (const [message, category] of cases) {
    const cause = new Error(message);
    const error = Object.assign(new Error('private outer details'), { cause, demoStage: 'apply_access' });
    assert.deepEqual(classifyDemoDiagnostic(error), { stage: 'apply_access', category, engineCode: null, guardCode: null, errorName: 'Error' });
    const f = fixture({ actError: error }); const cookie = await f.login();
    const result = await f.call('/api/action', { method: 'POST', cookie, body: { action: 'duplicate', operationId: 'offline_diagnostic_01' } });
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { ok: false, error: 'demo_temporarily_unavailable', diagnostic: { stage: 'apply_access', category, engineCode: null, guardCode: null, errorName: 'Error' } });
  }
  assert.deepEqual(classifyDemoDiagnostic({ demoStage: 'private SQL', code: 'private-token', message: 'details' }), { stage: 'unknown', category: 'unknown', engineCode: null, guardCode: null, errorName: 'unknown' });
  assert.deepEqual(classifyDemoDiagnostic({ demoStage: 'apply_access', code: 'access_application_invariant_failed' }), { stage: 'apply_access', category: 'unknown', engineCode: 'access_application_invariant_failed', guardCode: null, errorName: 'unknown' });
  const f = fixture({ actError: Object.assign(new Error('private details'), { demoStage: 'apply_access' }) });
  const unauthorized = await f.call('/api/action', { method: 'POST', body: { action: 'duplicate', operationId: 'offline_diagnostic_01' } });
  assert.equal(unauthorized.status, 401); assert.equal(Object.hasOwn(await unauthorized.json(), 'diagnostic'), false);
});

test('fixed native RAISE guard at fourth-level primitive cause is identified without private details', async () => {
  const privateDetails = 'secret-token-order-id-SQL-do-not-return';
  const guard = DEMO_GUARD_LOOKUP.find(row => row.triggers.includes('trg_subscription_access_grants_payment_guard'));
  assert.ok(guard); assert.equal(DEMO_GUARD_CODES.includes(guard.guardCode), true);
  const deepest = new TypeError(privateDetails, { cause: 'D1_ERROR: access grant is not backed by an applied payment; ' + privateDetails });
  const error = Object.assign(new Error(privateDetails, { cause: new Error(privateDetails, { cause: deepest }) }), { demoStage: 'apply_access' });
  const expected = { stage: 'apply_access', category: 'constraint', engineCode: null, guardCode: guard.guardCode, errorName: 'TypeError' };
  assert.deepEqual(classifyDemoDiagnostic(error), expected);
  const f = fixture({ actError: error }); const cookie = await f.login();
  const response = await f.call('/api/action', { method: 'POST', cookie, body: { action: 'duplicate', operationId: 'offline_guard_01' } });
  const body = await response.text(); assert.equal(body.includes(privateDetails), false);
  assert.equal(body.includes('access grant is not backed'), false);
  assert.deepEqual(JSON.parse(body).diagnostic, expected);
  const beyondBudget = new Error('outer', { cause: new Error('middle', { cause: new Error('inner', { cause: new Error('fourth', { cause: 'access grant is not backed by an applied payment' }) }) }) });
  assert.equal(classifyDemoDiagnostic(beyondBudget).guardCode, null);
});

test('native detail requires owner session plus deployment-only key and redacts secrets before cutoff', async () => {
  const f = fixture();
  const secrets = [f.env.BOT_TOKEN, f.env.DEMO_SESSION_SECRET, f.env.DEMO_INVOICE_SECRET, f.env.DEMO_WEBHOOK_SECRET];
  const sql = 'SELECT '+secrets.join(' ')+' '+('private_identifier_with_opaque_value '.repeat(100))+' FROM private_table';
  const error = Object.assign(new Error('D1_ERROR: '+sql+': unsafe use of json_valid(): SQLITE_ERROR\n at private_stack '+secrets[0]), { demoStage: 'apply_access' });
  const g = fixture({ actError: error }); const cookie = await g.login();
  for (const headers of [{}, { 'X-Re-Demo-Diagnostics': 'wrong-deployment-key' }]) {
    const result = await g.call('/api/action', { method: 'POST', cookie, body: { action: 'duplicate', operationId: 'offline_private_diag_01' }, headers });
    const body = await result.json(); assert.equal(Object.hasOwn(body.diagnostic, 'nativeDetail'), false);
  }
  const result = await g.call('/api/action', { method: 'POST', cookie, body: { action: 'duplicate', operationId: 'offline_private_diag_01' }, headers: { 'X-Re-Demo-Diagnostics': g.env.DEMO_WEBHOOK_SECRET } });
  const detail = (await result.json()).diagnostic.nativeDetail;
  assert.ok(detail.length <= 240); assert.match(detail, /^D1_ERROR:/u); assert.match(detail, /unsafe use of json_valid/u);
  for (const secret of secrets) assert.equal(detail.includes(secret), false);
  assert.doesNotMatch(detail, /private_stack|private_table|private_identifier|SELECT|FROM|[\r\n]/u);
  const unauthorized = await g.call('/api/action', { method: 'POST', body: { action: 'duplicate', operationId: 'offline_private_diag_01' }, headers: { 'X-Re-Demo-Diagnostics': g.env.DEMO_WEBHOOK_SECRET } });
  assert.equal(unauthorized.status, 401); assert.equal(Object.hasOwn(await unauthorized.json(), 'diagnostic'), false);
  assert.equal(redactDemoNativeDetail(new Error('generic private details'), g.env), null);
  const unsafe = 'D1_ERROR: invalid bind '+secrets.join(' ')+' https://private.example/a secret@example.com "private literal" \x60private identifier\x60 '+('f'.repeat(64))+' 8987576334: SQLITE_ERROR';
  const primitive = new Error('outer', { cause: new Error('middle', { cause: new Error('inner', { cause: unsafe }) }) });
  const redacted = redactDemoNativeDetail(primitive, g.env);
  for (const secret of secrets) assert.equal(redacted.includes(secret), false);
  assert.doesNotMatch(redacted, /https?:|@|private literal|private identifier|8987576334|f{12}|[\r\n]/u);
});

test('native detail retains the native reason preceding a suffix SQLite marker', () => {
  const error = new Error('D1_ERROR: wrapper failure', { cause: new Error('parser stack overflow: SQLITE_ERROR') });
  assert.equal(redactDemoNativeDetail(error, fixture().env), 'D1_ERROR: parser stack overflow: SQLITE_ERROR');
});

test('native detail retains SQL words in English reasons and collapses actual query shapes', () => {
  const env = fixture().env;
  for (const reason of ['cannot commit - no transaction is active: SQLITE_ERROR', 'too many terms in compound SELECT: SQLITE_ERROR']) {
    assert.equal(redactDemoNativeDetail(new Error('D1_ERROR: wrapper', { cause: new Error(reason) }), env), 'D1_ERROR: '+reason);
  }
  for (const sql of ['INSERT OR IGNORE INTO private_table VALUES (1)', 'UPDATE private_table SET x=1', 'DELETE FROM private_table', 'CREATE TABLE private_table(x)', 'ALTER TABLE private_table ADD y', 'DROP TABLE private_table', 'WITH temp AS (SELECT 1) SELECT temp FROM temp', 'SELECT 1', 'SELECT x FROM private_table']) {
    const detail = redactDemoNativeDetail(new Error('D1_ERROR: '+sql+': native parser failure: SQLITE_ERROR'), env);
    assert.match(detail, /\[sql\]/u); assert.doesNotMatch(detail, /private_table/u); assert.match(detail, /native parser failure/u);
  }
});

test('native detail retains a multiline native trailer after a query dump without SQL or secrets', () => {
  const env = fixture().env;
  const message = 'D1_ERROR: query failed\nSELECT "'+env.DEMO_INVOICE_SECRET+'", '+env.BOT_TOKEN+'\nFROM private_table\nparser stack overflow: SQLITE_ERROR\n at private_stack';
  const error = new Error('D1_ERROR: wrapper', { cause: new Error(message) });
  const detail = redactDemoNativeDetail(error, env);
  assert.match(detail, /parser stack overflow: SQLITE_ERROR/u);
  assert.match(detail, /\[sql\]/u);
  assert.doesNotMatch(detail, /SELECT|FROM|private_table|private_stack|[\r\n]/u);
  assert.equal(detail.includes(env.DEMO_INVOICE_SECRET), false); assert.equal(detail.includes(env.BOT_TOKEN), false);
});

test('webhook requires independent secret and sends only owner private start/demo button', async t => {
  const { db, sqlite } = receiptDatabase(t), f = fixture({ db }); const headers = { 'X-Telegram-Bot-Api-Secret-Token': f.env.DEMO_WEBHOOK_SECRET };
  const message = { chat: { id: 900, type: 'private' }, from: { id: 900 }, text: '/start', date: NOW };
  assert.equal((await f.call('/webhook', { method: 'POST', body: { message } })).status, 401);
  for (const changed of [{ ...message, from: { id: 901 } }, { ...message, chat: { id: 901, type: 'private' } }, { ...message, chat: { id: 900, type: 'group' } }, { ...message, text: '/unknown' }]) {
    assert.equal((await f.call('/webhook', { method: 'POST', body: { message: changed }, headers })).status, 200);
  }
  assert.equal(f.transportCalls.length, 0);
  const response = await f.call('/webhook', { method: 'POST', body: { update_id: 77, message }, headers }); assert.equal(response.status, 200);
  assert.deepEqual(f.transportCalls.map(call => call.method), ['getMe', 'sendMessage']);
  assert.equal(f.transportCalls[1].body.chat_id, 900);
  assert.equal(f.transportCalls[1].body.reply_markup.inline_keyboard[0][0].web_app.url, ORIGIN + '/demo');
  assert.equal(f.engineCalls.length, 0);
  assert.equal(sqlite.prepare('SELECT state FROM re_demo_webhook_receipts').get().state, 'delivered');
});

test('oversized unknown-length bodies stop reading at the byte bound and cancel the stream', async () => {
  const f = fixture(); let pulled = 0, cancelled = false;
  const body = new ReadableStream({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array(4096)); if (pulled === 256) controller.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const result = await f.worker.fetch(new Request(ORIGIN + '/api/session', { method: 'POST', duplex: 'half', body,
    headers: { Origin: ORIGIN, 'X-Re-Demo': '1', 'Content-Type': 'application/json' } }), f.env);
  assert.equal(result.status, 413); assert.equal(pulled, 5); assert.equal(cancelled, true);
  assert.equal(f.engineCalls.length, 0); assert.equal(f.transportCalls.length, 0);
});

test('declared oversize and invalid UTF-8 stop before authentication', async () => {
  const f = fixture();
  for (const [body, extra, status] of [[new Uint8Array([123, 125]), { 'Content-Length': '16385' }, 413],
    [new Uint8Array([123, 34, 97, 34, 58, 34, 255, 34, 125]), {}, 400]]) {
    const result = await f.worker.fetch(new Request(ORIGIN + '/api/session', { method: 'POST', body,
      headers: { Origin: ORIGIN, 'X-Re-Demo': '1', 'Content-Type': 'application/json', ...extra } }), f.env);
    assert.equal(result.status, status);
  }
  assert.equal(f.transportCalls.length, 0);
});

test('body deadline returns even when the input and cancellation never finish', async t => {
  const f = fixture(); let cancelled = false;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const body = new ReadableStream({ pull() { return new Promise(() => {}); },
    cancel() { cancelled = true; return new Promise(() => {}); } }, { highWaterMark: 0 });
  const pending = f.worker.fetch(new Request(ORIGIN + '/api/session', { method: 'POST', duplex: 'half', body,
    headers: { Origin: ORIGIN, 'X-Re-Demo': '1', 'Content-Type': 'application/json' } }), f.env);
  t.mock.timers.tick(5000);
  const result = await pending;
  assert.equal(result.status, 400); assert.equal(cancelled, true); assert.equal(f.transportCalls.length, 0);
});

test('concurrent deliveries and a new worker instance share one durable webhook claim', async t => {
  const { db, sqlite } = receiptDatabase(t);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ db, transportHook: async method => { if (method === 'sendMessage') { entered(); await gate; } } });
  const g = fixture({ db }), headers = { 'X-Telegram-Bot-Api-Secret-Token': f.env.DEMO_WEBHOOK_SECRET };
  const body = { update_id: 78, message: { date: NOW, chat: { id: 900, type: 'private' }, from: { id: 900 }, text: '/demo' } };
  const first = f.call('/webhook', { method: 'POST', body, headers });
  await started;
  assert.equal((await g.call('/webhook', { method: 'POST', body, headers })).status, 200);
  release(); assert.equal((await first).status, 200);
  const freshWorker = fixture({ db });
  assert.equal((await freshWorker.call('/webhook', { method: 'POST', body, headers })).status, 200);
  assert.equal([...f.transportCalls, ...g.transportCalls, ...freshWorker.transportCalls].filter(call => call.method === 'sendMessage').length, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM re_demo_webhook_receipts').get().n, 1);
  assert.equal(sqlite.prepare('SELECT state FROM re_demo_webhook_receipts').get().state, 'delivered');
});

test('unknown provider outcome is durable and a different owner command can retry explicitly', async t => {
  const { db, sqlite } = receiptDatabase(t), f = fixture({ db, transportHook: method => { if (method === 'sendMessage') throw new Error('simulated lost response'); } });
  const headers = { 'X-Telegram-Bot-Api-Secret-Token': f.env.DEMO_WEBHOOK_SECRET };
  const body = { update_id: 79, message: { date: NOW, chat: { id: 900, type: 'private' }, from: { id: 900 }, text: '/start' } };
  assert.equal((await f.call('/webhook', { method: 'POST', body, headers })).status, 503);
  assert.equal(sqlite.prepare('SELECT state FROM re_demo_webhook_receipts').get().state, 'unknown');
  const g = fixture({ db });
  assert.equal((await g.call('/webhook', { method: 'POST', body, headers })).status, 200);
  assert.equal(g.transportCalls.filter(call => call.method === 'sendMessage').length, 0);
  assert.equal((await g.call('/webhook', { method: 'POST', body: { ...body, update_id: 80 }, headers })).status, 200);
  assert.equal(g.transportCalls.filter(call => call.method === 'sendMessage').length, 1);
});

test('expired commands cannot replay after receipt retention and invalid IDs never send', async t => {
  const { db, sqlite } = receiptDatabase(t), f = fixture({ db });
  sqlite.prepare("INSERT INTO re_demo_webhook_receipts(bot_id, update_id, state, received_at, finished_at) VALUES(123456789,1,'delivered',?,?)")
    .run(NOW - 8 * 86400, NOW - 8 * 86400);
  const headers = { 'X-Telegram-Bot-Api-Secret-Token': f.env.DEMO_WEBHOOK_SECRET };
  const message = { date: NOW, chat: { id: 900, type: 'private' }, from: { id: 900 }, text: '/start' };
  for (const update_id of [undefined, -1, 1.5, '77']) assert.equal((await f.call('/webhook', { method: 'POST', body: { update_id, message }, headers })).status, 400);
  for (const date of [undefined, NOW - 86401, NOW + 61])
    assert.equal((await f.call('/webhook', { method: 'POST', body: { update_id: 1, message: { ...message, date } }, headers })).status, 200);
  assert.equal(f.transportCalls.length, 0);
  assert.equal((await f.call('/webhook', { method: 'POST', body: { update_id: 2, message }, headers })).status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM re_demo_webhook_receipts WHERE update_id=1').get().n, 0);
  assert.equal((await f.call('/webhook', { method: 'POST', body: { update_id: 1, message: { ...message, date: NOW - 8 * 86400 } }, headers })).status, 200);
  assert.equal(f.transportCalls.filter(call => call.method === 'sendMessage').length, 1);
});

test('nonfinancial Telegram transport denies all monetary methods without making network request', async () => {
  let calls = 0;
  const transport = createDemoTelegramTransport({ token: TOKEN, fetchImpl: async () => { calls++; throw new Error('unexpected transport'); } });
  for (const method of ['createInvoiceLink', 'sendInvoice', 'refundStarPayment', 'editUserStarSubscription', 'getStarTransactions', 'setWebhook']) {
    await assert.rejects(transport(method), /telegram_method_denied/u);
  }
  assert.equal(calls, 0);
});

test('Mini App uses no stored credential, native payment popup, invoice URL or DOM HTML injection', () => {
  assert.doesNotMatch(DEMO_JS, /initDataUnsafe|localStorage|sessionStorage|openInvoice|sendInvoice|createInvoiceLink|\.innerHTML\s*=/u);
  assert.match(DEMO_JS, /if\(!webApp\?\.initData\)/u);
  assert.match(DEMO_JS, /operationId:crypto\.randomUUID\(\)/u);
  assert.match(DEMO_JS, /Повторите тот же запрос/u);
  const html = renderDemoHtml();
  assert.match(html, /Тестовые квитанции/u); assert.match(html, /Песочница · оплаты нет/u);
  assert.match(DEMO_CSS, /@media\(max-width:650px\)/u);
  assert.throws(() => renderDemoHtml({ botUsername: '<script>' }), /invalid_demo_username/u);
});

test('offline mobile/desktop browser exercises consent, double tap, exact retry and reload recovery', {
  skip: process.env.RUN_DEMO_BROWSER_TESTS !== '1', timeout: 60000,
}, async t => {
  const { chromium } = createRequire(new URL('./p11-runtime/package.json', import.meta.url))('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--disable-background-networking'],
    ...(process.env.P11_BROWSER_PATH ? { executablePath: process.env.P11_BROWSER_PATH } : {}) }); t.after(() => browser.close());
  const directory = process.env.DEMO_SCREENSHOT_DIR || 'tmp/demo-ui-qa';
  await fs.mkdir(directory, { recursive: true });
  const blank = { demo: true, balance: 1000, nowSec: NOW, subscription: {}, receipts: [], feedback: { message: 'Это симуляция. Реальные Stars не используются.' } };
  const populated = { demo: true, balance: 502, nowSec: NOW + 2592000, subscription: { planCode: 'professional', paidAccess: true, autoRenew: true, paidUntil: NOW + 2592000 * 2, renewalState: 'active' },
    receipts: [0, 1].map(index => ({ receiptId: 'stars-offline-visual-proof-' + index, planCode: 'professional', amountStars: 249, occurredAt: NOW + index * 2592000,
      paidPeriod: { startsAt: NOW + index * 2592000, endsAt: NOW + (index + 1) * 2592000 }, demo: true })), feedback: { status: 'completed', message: 'Тестовый период продлён на 30 дней.' } };
  for (const width of [390, 1100]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    t.after(() => context.close());
    await context.addInitScript(() => { window.Telegram = { WebApp: { initData: 'offline-visual-fixture-not-telegram-auth', ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {} } }; });
    const actions = []; let loseFirst = true, serverState = blank;
    await context.route('**/*', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.url() === 'https://telegram.org/js/telegram-web-app.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
      if (new URL(request.url()).origin !== ORIGIN) return route.abort('blockedbyclient');
      if (path === '/demo') return route.fulfill({ contentType: 'text/html', body: renderDemoHtml() });
      if (path === '/demo.css') return route.fulfill({ contentType: 'text/css', body: DEMO_CSS });
      if (path === '/demo.js') return route.fulfill({ contentType: 'text/javascript', body: DEMO_JS });
      if (path === '/api/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      if (path === '/api/state') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, state: serverState }) });
      if (path === '/api/action') {
        const payload = request.postDataJSON(); actions.push(payload);
        if (loseFirst) { loseFirst = false; return route.abort('failed'); }
        serverState = populated;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, state: serverState }) });
      }
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage(); await page.goto(ORIGIN + '/demo'); await page.locator('#workspace').waitFor({ state: 'visible' });
    await page.screenshot({ path: directory + '/demo-unpurchased-' + width + '.png', fullPage: true });
    assert.equal(await page.locator('#buy').isDisabled(), true);
    await page.locator('#consent').check(); assert.equal(await page.locator('#buy').isEnabled(), true);
    await page.evaluate(() => { document.getElementById('buy').click(); document.getElementById('buy').click(); });
    await page.locator('#retry').waitFor({ state: 'visible' }); assert.equal(actions.length, 1);
    assert.equal(actions[0].consent, true);
    await page.locator('#retry').click(); await page.locator('.receipt').first().waitFor();
    assert.equal(actions.length, 2); assert.deepEqual(actions[0], actions[1]);
    assert.equal(await page.locator('#buy').isDisabled(), true); assert.equal(await page.locator('.receipt').count(), 2);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, 'no horizontal overflow at ' + width);
    assert.equal(await page.locator('#cancel').isEnabled(), true);
    assert.equal(await page.locator('[data-action="advance_30d"]').isEnabled(), true);
    await page.screenshot({ path: directory + '/demo-' + width + '.png', fullPage: true });
    serverState = { ...blank, balance: 751, pendingOperationId: 'retained-offline-operation', pendingOperation: { operationId: 'retained-offline-operation', action: 'buy', planCode: 'professional' } };
    await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-action="advance_30d"]').isDisabled(), true);
    assert.equal(await page.locator('#reset').isDisabled(), true);
    assert.equal(await page.locator('#retry').isVisible(), true);
    await page.locator('#retry').click(); await page.locator('.receipt').first().waitFor();
    assert.deepEqual(actions.at(-1), { operationId: 'retained-offline-operation', action: 'buy', planCode: 'professional', consent: true });
    serverState = { ...populated, balance: 4, nowSec: NOW + 2592000 * 5,
      subscription: { ...populated.subscription, paidAccess: false, renewalState: 'failed' },
      feedback: { status: 'completed', code: 'insufficient_funds', message: 'Недостаточно тестовых средств. Новый оплаченный период не предоставлен.' } };
    await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' });
    await page.screenshot({ path: directory + '/demo-insufficient-' + width + '.png', fullPage: true });
  }
  const directContext = await browser.newContext({ serviceWorkers: 'block' }); t.after(() => directContext.close()); let directApiCalls = 0;
  await directContext.route('**/*', route => {
    if (new URL(route.request().url()).origin !== ORIGIN) return route.abort('blockedbyclient');
    const path = new URL(route.request().url()).pathname;
    if (path === '/demo') return route.fulfill({ contentType: 'text/html', body: renderDemoHtml() });
    if (path === '/demo.css') return route.fulfill({ contentType: 'text/css', body: DEMO_CSS });
    if (path === '/demo.js') return route.fulfill({ contentType: 'text/javascript', body: DEMO_JS });
    if (path.startsWith('/api/')) directApiCalls++;
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
  });
  await directContext.routeWebSocket('**/*', socket => socket.close());
  const directPage = await directContext.newPage(); await directPage.goto(ORIGIN + '/demo');
  await directPage.locator('#bot-link').waitFor({ state: 'visible' });
  assert.equal(await directPage.locator('#workspace').isVisible(), false); assert.equal(directApiCalls, 0);
});
