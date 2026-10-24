import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../re-program-bot-worker.js', import.meta.url), 'utf8');
const section = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'actual worker function boundaries');
  return source.slice(from, to);
};
const actualFunctions = [
  section('function createCallbackAcknowledgementEnvironment(', 'async function allowPrivacyChatAction('),
  section('function isPrivateUserCallback(', 'async function ensureUser('),
  section('function answerCallback(', 'async function telegramApi('),
].join('\n');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const callback = (id = 'offline-callback', user = 101) => ({
  update_id: 1001, callback_query: { id, data: 'menu', from: { id: user, is_bot: false },
    message: { message_id: 30, chat: { id: user, type: 'private' } } },
});
function actualDispatcher({ guard, provider = async () => true, inherit } = {}) {
  const calls = [], effects = [], logs = [], background = [];
  let functions;
  const runtime = {
    inheritCompatible: inherit ?? ((_source, target) => target),
    guardDispatch: guard ?? (async () => null),
  };
  const values = {
    getV141Runtime: () => runtime,
    telegramApi: async (env, method, payload) => { calls.push({ method, payload }); return provider(env, method, payload); },
    safelyRecordBotError: async (_env, code) => { logs.push(code); },
    isStarsCommerceUpdate: () => false,
    handleAdminSafetyUpdate: async () => ({ handled: false }),
    handleDirectSupportUpdate: async () => false,
    handleAnalyticsAdminProductUpdate: async () => ({ handled: false }),
    safelyEnsureTelegramCommandMenu: async () => {},
    getTelegramUpdateActorId: update => update.callback_query?.from?.id,
    safelyTouchUserActivity: async () => {},
    handleAiPartnerUpdate: async () => ({ handled: false }),
    handleMessage: async () => { effects.push('message'); },
    createSingleScreenCallbackEnvironment: env => ({ ...env }),
    handleCallback: async (query, env) => {
      await functions.answerCallback(env, query.id);
      effects.push('authorized-screen');
    },
    console: { error() {} },
  };
  functions = new Function(...Object.keys(values),
    'const CALLBACK_ACK_STATE = Symbol("callbackAcknowledgementState");\n' + actualFunctions +
    '\nreturn { handleUpdate, answerCallback, createCallbackAcknowledgementEnvironment };')(...Object.values(values));
  const ctx = { waitUntil: promise => { background.push(promise); } };
  return { ...functions, runtime, calls, effects, logs, background, ctx };
}

test('actual dispatcher sends one neutral ACK before a delayed authorization; screen still waits for authority', async () => {
  const authority = deferred(), provider = deferred();
  const f = actualDispatcher({ guard: async (_env, _update) => { await authority.promise; return null; },
    provider: () => provider.promise });
  const work = f.handleUpdate(callback(), {}, f.ctx);
  assert.deepEqual(f.calls, [{ method: 'answerCallbackQuery', payload: { callback_query_id: 'offline-callback' } }]);
  assert.deepEqual(f.effects, []);
  authority.resolve(); provider.resolve(true);
  await work; await Promise.all(f.background);
  assert.equal(f.calls.length, 1, 'existing callback handler reuses the original ACK');
  assert.deepEqual(f.effects, ['authorized-screen']);
});

test('denied current authority still gets only a neutral ACK and no business effect', async () => {
  const denied = Object.assign(new Error('capability_denied'), { code: 'capability_denied' });
  const f = actualDispatcher({ guard: async () => { throw denied; } });
  await assert.rejects(f.handleUpdate(callback(), {}, f.ctx), error => error === denied);
  await Promise.all(f.background);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.effects, []);
  assert.deepEqual(f.calls[0].payload, { callback_query_id: 'offline-callback' });
});

test('concurrent updates sharing an outer env keep separate ACKs; scoped copies reuse their own promise', async () => {
  const f = actualDispatcher(), outer = { DB: {} };
  const first = f.createCallbackAcknowledgementEnvironment(outer, callback('one').callback_query, f.runtime);
  const second = f.createCallbackAcknowledgementEnvironment(outer, callback('two', 202).callback_query, f.runtime);
  assert.notEqual(first, outer); assert.notEqual(second, first);
  const one = f.answerCallback(first, 'one'), oneAgain = f.answerCallback({ ...first }, 'one');
  const two = f.answerCallback(second, 'two');
  assert.equal(one, oneAgain);
  await Promise.all([one, oneAgain, two]);
  assert.deepEqual(f.calls.map(row => row.payload.callback_query_id), ['one', 'two']);
  assert.deepEqual(Reflect.ownKeys(outer), ['DB']);
  const nonPrivate = callback().callback_query; nonPrivate.message.chat.type = 'group';
  assert.equal(f.createCallbackAcknowledgementEnvironment(outer, nonPrivate, f.runtime), outer);
  for (const data of ['h138:ai:clear', 'a38:hub', 'a38p:select', 'a38o:budget', 'ai_hub', 'r14:pa:fixed']) {
    const owned = callback().callback_query; owned.data = data;
    assert.equal(f.createCallbackAcknowledgementEnvironment(outer, owned, f.runtime), outer,
      'separate native runtime keeps its own sole ACK: ' + data);
  }
});

test('context inheritance precedes ACK, and failed provider ACK is never retried by later scoped handlers', async () => {
  const rejected = actualDispatcher({ inherit: () => { throw new Error('untrusted_runtime_context'); } });
  await assert.rejects(rejected.handleUpdate(callback(), {}, rejected.ctx), /untrusted_runtime_context/);
  assert.equal(rejected.calls.length, 0);
  const f = actualDispatcher({ provider: async () => { throw new Error('offline provider rejected'); } });
  const env = f.createCallbackAcknowledgementEnvironment({}, callback().callback_query, f.runtime);
  await f.answerCallback(env, 'offline-callback');
  await f.answerCallback({ ...env }, 'offline-callback');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.logs, ['answer_callback']);
});
