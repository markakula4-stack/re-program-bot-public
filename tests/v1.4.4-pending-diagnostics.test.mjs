import test from 'node:test';
import assert from 'node:assert/strict';
import { MiniAppClient } from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';
import { copyPendingSubscriptionDiagnostics } from '../src/v1.4.0-rebuild/mini-app/cabinet-view.mjs';
import { renderSubscriptionScreen } from '../src/v1.4.0-rebuild/mini-app/subscription-view.mjs';
import { subscriptionUIFixture } from './helpers/v1.4.3-subscription-ui-fixture.mjs';

const NOW = 1791464400, KEY = 'a'.repeat(48), STORAGE_KEY = 're-subscription-pending-v1';
const PRINCIPAL = { telegramId: 101, botId: 789 };
const CONTRACT = '22222222-2222-4222-8222-222222222222';
const intent = { contractId: CONTRACT, expectedRevision: 3 };
const marker = (kind = 'cancel', principal) => ({ kind, key: KEY, startedAt: NOW - 10,
  intent: kind === 'invoice' ? { planCode: 'professional', recurringConsent: true,
    termsRevision: '2026-10-03.stars-recurring-v1', priceVersion: 1 } : structuredClone(intent),
  ...(principal ? { principal } : {}) });
const auth = capability => ({ version: 1, capability, allowed: true, reasonCode: 'allowed',
  policyVersion: 'v1', effectivePlan: 'professional', accessState: 'active', validUntil: NOW + 300,
  quota: null, actionPolicy: 'default' });
function fixture({ saved = null, principal = PRINCIPAL, status = 'missing', recoverStatus = 'rejected',
  lookupResponse = null, recoverResponse = null, recoverTransport = null, cancelTransport = null, lookupTransport = null,
  reconfirmTransport = null, reconfirmStatusTransport = null } = {}) {
  const values = new Map(saved ? [[STORAGE_KEY, JSON.stringify(saved)]] : []), calls = [];
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const outcome = (body, state) => ({ authority: 'worker', kind: body.kind, state,
    attemptId: state === 'missing' ? null : 'attempt-1', contractId: state === 'missing' ? null : CONTRACT,
    invoiceUrl: body.kind === 'invoice' && state === 'confirmed' ? 'https://t.me/$TestInvoice' : null,
    effectRecorded: state !== 'missing', accessApplied: false, reviewRequired: ['unknown', 'pending'].includes(state),
    actionAdmissionRequired: true, authorization: auth('access.read_own') });
  const client = new MiniAppClient({ origin: 'https://example.test', now: () => NOW * 1000, pendingStorage: storage,
    fetchImpl: async (url, init) => {
      calls.push({ url, init }); const body = JSON.parse(init.body);
      if (url.endsWith('/session')) return Response.json({ sessionToken: 'rpms1_' + 's'.repeat(43), tokenType: 'Bearer', expiresAt: NOW + 300,
        authorizationVersion: 1, features: { version: 1, mutationsEnabled: true, offerActionsEnabled: false }, ...(principal === null ? {} : { principal }) });
      if (url.endsWith('/operation-status')) return lookupTransport ? lookupTransport(init) : Response.json(lookupResponse ?? outcome(body, status));
      if (url.endsWith('/subscription/recover')) return recoverTransport ? recoverTransport() : Response.json(recoverResponse ?? outcome(body, recoverStatus));
      if (url.endsWith('/subscription/renewal/reconfirm-cancel') && reconfirmTransport) return reconfirmTransport(init);
      if (url.endsWith('/subscription/renewal/reconfirm-cancel-status') && reconfirmStatusTransport) return reconfirmStatusTransport(init);
      if (url.endsWith('/subscription/renewal/cancel') && cancelTransport) return cancelTransport(init);
      return Response.json({ status: 'unknown', accessApplied: false, contractId: body.contractId,
        action: url.endsWith('/cancel') ? 'cancel_renewal' : 'reenable_renewal', paidPeriodChanged: false,
        providerState: null, cancellationConfirmed: false, reenableAllowed: false, authorization: auth('access.read_own') });
    } });
  return { client, values, calls, storage };
}

const staleCancellation = () => ({ ...marker('cancel', PRINCIPAL), startedAt: NOW - 301 });
const linkedCancellation = (state = 'admitted', extra = {}) => ({ authority: 'worker', kind: 'cancel', state,
  originalAttemptId: '44444444-4444-4444-8444-444444444444',
  attemptId: state === 'missing' ? null : '55555555-5555-4555-8555-555555555555', contractId: CONTRACT,
  expectedRevision: 3, originalState: state === 'missing' ? 'unknown' : 'superseded', accessApplied: false,
  financialCalls: 0, authorization: auth('access.read_own'), ...extra });
const cancellationConfirmed = () => Response.json({ status: 'confirmed', contractId: CONTRACT, action: 'cancel_renewal',
  paidPeriodChanged: false, providerState: null, cancellationConfirmed: true, reenableAllowed: false,
  accessApplied: false, authorization: auth('access.read_own') });

test('verified terminal feedback receipt requires the exact owned status and keeps invalid or nonterminal reconfirm markers', async () => {
  const saved = { ...staleCancellation(), key: 'b'.repeat(48),
    reconfirm: { originalKey: KEY, originalStartedAt: NOW - 301, stage: 'producer' } };
  for (const [state, extra, accepted] of [['unknown', {}, false], ['rejected', { contractId: '33333333-3333-4333-8333-333333333333' }, false],
    ['rejected', {}, true], ['confirmed', {}, true]]) {
    const f = fixture({ saved, reconfirmStatusTransport: () => Response.json(linkedCancellation(state, extra)) });
    await f.client.authenticate('private-init');
    await f.client.recoverSubscriptionAction().catch(error => assert.equal(error.code, 'invalid_response'));
    assert.equal(f.client.subscriptionOutcomePending, !accepted);
    assert.deepEqual(f.client.verifiedSubscriptionOutcome, accepted ? { key: saved.key, kind: 'cancel', state } : null);
    if (!accepted) assert.deepEqual(JSON.parse(f.values.get(STORAGE_KEY)), saved);
    assert.equal(f.calls.filter(call => call.url.endsWith('/renewal/cancel') || call.url.endsWith('/reconfirm-cancel')).length, 0);
    f.client.clearSession(); assert.equal(f.client.verifiedSubscriptionOutcome, null);
  }
});

test('reconfirm cancel durably binds predecessor before handoff and uses one new producer key only after verified admission', async () => {
  let f, release; const held = new Promise(resolve => { release = resolve; });
  f = fixture({ saved: staleCancellation(), status: 'pending', reconfirmTransport: async init => {
    const saved = JSON.parse(f.values.get(STORAGE_KEY)); assert.notEqual(saved.key, KEY);
    assert.equal(saved.reconfirm.originalKey, KEY); assert.equal(saved.reconfirm.stage, 'handoff');
    assert.deepEqual(saved.principal, PRINCIPAL); assert.equal(init.headers['Idempotency-Key'], saved.key);
    assert.deepEqual(JSON.parse(init.body), { kind: 'cancel', intent, originalKey: KEY });
    assert.equal(f.calls.filter(call => call.url.endsWith('/renewal/cancel')).length, 0);
    await held; return Response.json(linkedCancellation());
  }, cancelTransport: init => {
    const saved = JSON.parse(f.values.get(STORAGE_KEY)); assert.equal(saved.reconfirm.stage, 'producer');
    assert.equal(init.headers['Idempotency-Key'], saved.key); assert.deepEqual(JSON.parse(init.body), intent);
    return cancellationConfirmed();
  } });
  await f.client.authenticate('private-init'); await f.client.recoverSubscriptionAction();
  assert.equal(f.client.pendingCancellationReconfirmationMode, 'new');
  const pending = f.client.reconfirmSubscriptionCancellation();
  await assert.rejects(f.client.reconfirmSubscriptionCancellation(), { code: 'state_conflict' });
  release(); await pending;
  assert.equal(f.client.subscriptionOutcomePending, false); assert.equal(f.values.has(STORAGE_KEY), false);
  const handoff = f.calls.find(call => call.url.endsWith('/reconfirm-cancel'));
  const producer = f.calls.filter(call => call.url.endsWith('/renewal/cancel'));
  assert.equal(producer.length, 1); assert.equal(producer[0].init.headers['Idempotency-Key'], handoff.init.headers['Idempotency-Key']);
});

test('reconfirm cancel lost handoff reopens through linked read only; admitted needs explicit continuation and pending never replays', async () => {
  const f = fixture({ saved: staleCancellation(), status: 'unknown', reconfirmTransport: () => { throw new TypeError('lost'); } });
  await f.client.authenticate('private-init'); await f.client.recoverSubscriptionAction();
  await assert.rejects(f.client.reconfirmSubscriptionCancellation(), { code: 'outcome_unknown' });
  const saved = JSON.parse(f.values.get(STORAGE_KEY)); assert.equal(saved.reconfirm.stage, 'handoff');
  assert.equal(f.client.pendingCancellationReconfirmationMode, null);
  for (const state of ['admitted', 'pending', 'unknown', 'confirmed', 'rejected']) {
    const reopened = fixture({ saved, reconfirmStatusTransport: init => {
      assert.equal(init.headers['Idempotency-Key'], saved.key);
      assert.deepEqual(JSON.parse(init.body), { kind: 'cancel', intent, originalKey: KEY });
      return Response.json(linkedCancellation(state));
    }, cancelTransport: cancellationConfirmed });
    await reopened.client.authenticate('private-init'); await reopened.client.recoverSubscriptionAction();
    assert.equal(reopened.calls.filter(call => call.url.endsWith('/reconfirm-cancel-status')).length, 1);
    assert.equal(reopened.calls.filter(call => call.url.endsWith('/operation-status') || call.url.endsWith('/renewal/cancel') || call.url.endsWith('/reconfirm-cancel')).length, 0);
    assert.equal(reopened.client.subscriptionOutcomePending, !['confirmed', 'rejected'].includes(state));
    if (state === 'admitted') {
      assert.equal(reopened.client.pendingCancellationReconfirmationMode, 'continue');
      await reopened.client.reconfirmSubscriptionCancellation();
      assert.equal(reopened.calls.filter(call => call.url.endsWith('/renewal/cancel')).length, 1);
      assert.equal(reopened.calls.at(-1).init.headers['Idempotency-Key'], saved.key);
      assert.equal(reopened.client.subscriptionOutcomePending, false);
    } else assert.equal(reopened.client.pendingCancellationReconfirmationMode, null);
  }
  const rejectedTransport = fixture({ saved, reconfirmStatusTransport: () => Response.json(linkedCancellation()),
    cancelTransport: () => Response.json({ error: 'state_conflict' }, { status: 409 }) });
  await rejectedTransport.client.authenticate('private-init'); await rejectedTransport.client.recoverSubscriptionAction();
  await assert.rejects(rejectedTransport.client.reconfirmSubscriptionCancellation(), { code: 'subscription_outcome_unknown', status: 409 });
  assert.equal(rejectedTransport.client.subscriptionOutcomePending, true);
  assert.equal(JSON.parse(rejectedTransport.values.get(STORAGE_KEY)).reconfirm.originalKey, KEY);
  assert.equal(rejectedTransport.client.pendingCancellationReconfirmationMode, null);
});

test('reconfirm cancel missing requires own read proof to restore prior uncertain marker; invalid link never sends producer', async () => {
  for (const response of [linkedCancellation('missing'), linkedCancellation('admitted', { contractId: '33333333-3333-4333-8333-333333333333' }),
    linkedCancellation('admitted', { expectedRevision: 4 }), linkedCancellation('admitted', { financialCalls: 1 }),
    linkedCancellation('admitted', { originalState: 'unknown' }), linkedCancellation('admitted', { attemptId: '44444444-4444-4444-8444-444444444444' })]) {
    const f = fixture({ saved: staleCancellation(), status: 'pending', reconfirmTransport: () => Response.json(response) });
    await f.client.authenticate('private-init'); await f.client.recoverSubscriptionAction();
    await assert.rejects(f.client.reconfirmSubscriptionCancellation(), { code: 'invalid_response' });
    const saved = JSON.parse(f.values.get(STORAGE_KEY)); assert.notEqual(saved.key, KEY);
    assert.equal(f.calls.filter(call => call.url.endsWith('/renewal/cancel')).length, 0);
    const read = fixture({ saved, reconfirmStatusTransport: () => Response.json(linkedCancellation('missing', { originalState: 'confirmed' })) });
    await read.client.authenticate('private-init'); await read.client.recoverSubscriptionAction();
    assert.deepEqual(JSON.parse(read.values.get(STORAGE_KEY)), staleCancellation());
    assert.equal(read.client.subscriptionOutcomePending, true); assert.equal(read.client.subscriptionRecoveryState.state, 'not_checked');
    assert.equal(read.calls.filter(call => call.url.endsWith('/renewal/cancel')).length, 0);
  }
});

test('reconfirm cancel storage failures stop before handoff or producer and never lose predecessor', async () => {
  for (const failAt of [1, 2]) {
    const f = fixture({ saved: staleCancellation(), status: 'pending', reconfirmTransport: () => Response.json(linkedCancellation()) });
    await f.client.authenticate('private-init'); await f.client.recoverSubscriptionAction();
    const set = f.storage.setItem; let writes = 0;
    f.storage.setItem = (key, value) => { if (++writes === failAt) throw new Error('storage unavailable'); set(key, value); };
    await assert.rejects(f.client.reconfirmSubscriptionCancellation(), { code: 'writes_unavailable' });
    assert.equal(f.calls.filter(call => call.url.endsWith('/reconfirm-cancel')).length, failAt === 1 ? 0 : 1);
    assert.equal(f.calls.filter(call => call.url.endsWith('/renewal/cancel')).length, 0);
    const saved = JSON.parse(f.values.get(STORAGE_KEY));
    assert.equal(failAt === 1 ? saved.key : saved.reconfirm.originalKey, KEY);
    assert.equal(f.client.subscriptionOutcomePending, true); assert.equal(f.client.pendingCancellationReconfirmationMode, null);
  }
});

test('reconfirm cancel gate requires old pending cancellation, matched bound principal and 300s age', async () => {
  for (const [saved, principal, status] of [[marker(), PRINCIPAL, 'pending'], [marker('cancel', PRINCIPAL), PRINCIPAL, 'pending'],
    [staleCancellation(), { telegramId: 202, botId: 789 }, 'pending'], [staleCancellation(), PRINCIPAL, 'missing'],
    [{ ...staleCancellation(), kind: 'enable' }, PRINCIPAL, 'pending']]) {
    const f = fixture({ saved, principal, status }); await f.client.authenticate('private-init');
    await f.client.recoverSubscriptionAction().catch(() => {});
    assert.equal(f.client.pendingCancellationReconfirmationMode, null);
    await assert.rejects(f.client.reconfirmSubscriptionCancellation(), { code: 'state_conflict' });
    assert.equal(f.calls.filter(call => call.url.endsWith('/reconfirm-cancel') || call.url.endsWith('/renewal/cancel')).length, 0);
  }
});

test('legacy marker exports exact allowed identifiers and missing lookup preserves it without replay', async () => {
  const f = fixture({ saved: marker() }), original = f.values.get(STORAGE_KEY);
  await f.client.authenticate('private-init-data'); await f.client.recoverSubscriptionAction();
  assert.equal(f.client.subscriptionRecoveryState.state, 'missing'); assert.equal(f.client.subscriptionOutcomePending, true);
  assert.equal(f.values.get(STORAGE_KEY), original); assert.equal(f.calls.length, 2);
  const diagnostics = f.client.pendingSubscriptionDiagnostics;
  assert.deepEqual(diagnostics.subscription, { ...marker(), principal: null, scope: 'legacy_unbound' });
  assert.deepEqual(diagnostics.currentPrincipal, PRINCIPAL); assert.equal(diagnostics.operationStatus.state, 'missing');
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-init-data|rpms1_|sessionToken|Authorization|initData/);
  assert.equal(f.calls[1].init.headers['Idempotency-Key'], KEY);
});

for (const [label, phase, httpStatus, response] of [
  ['HTML503', 'non_json', 503, () => new Response('private-html-body', { status: 503, headers: { 'content-type': 'text/html' } })],
  ['malformed JSON', 'json_body', 200, () => new Response('{private-json-body', { headers: { 'content-type': 'application/json' } })],
  ['fetch rejection', 'fetch', 0, () => { throw new TypeError('private-fetch-message https://private.example/secret'); }],
]) test('cancel producer safe diagnostics retain uncertainty for ' + label, async () => {
  const f = fixture({ cancelTransport: response }); await f.client.authenticate('private-init');
  await assert.rejects(f.client.subscriptionAction('cancel', intent), { code: 'subscription_outcome_unknown', status: 0 });
  assert.equal(f.client.subscriptionOutcomePending, true); assert.equal(f.values.has(STORAGE_KEY), true);
  assert.deepEqual(f.client.pendingSubscriptionDiagnostics.lastCancellationFailure,
    { code: 'outcome_unknown', status: 0, httpStatus, phase, durationMs: 0, timedOut: false });
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription/renewal/cancel')).length, 1);
  assert.doesNotMatch(JSON.stringify(f.client.pendingSubscriptionDiagnostics), /private-init|private-html-body|private-json-body|private-fetch-message|https:|rpms1_|Authorization/);
});

test('cancel producer rejects a wrong-contract confirmed DTO and retains marker without inventing ACK', async () => {
  const f = fixture({ cancelTransport: () => Response.json({ status: 'confirmed', contractId: '33333333-3333-4333-8333-333333333333',
    action: 'cancel_renewal', cancellationConfirmed: true, reenableAllowed: false, providerState: null,
    paidPeriodChanged: false, accessApplied: false, authorization: auth('access.read_own') }) });
  await f.client.authenticate('private-init');
  await assert.rejects(f.client.subscriptionAction('cancel', intent), { code: 'subscription_outcome_unknown' });
  assert.equal(f.client.subscriptionOutcomePending, true); assert.equal(f.values.has(STORAGE_KEY), true);
  assert.equal(f.client.pendingSubscriptionDiagnostics.lastCancellationFailure.phase, 'json');
  assert.equal(f.client.pendingSubscriptionDiagnostics.lastCancellationFailure.httpStatus, 200);
});

test('cancel read-only operation status keeps 15s deadline and never uses cancellation producer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let signal;
  const f = fixture({ saved: marker('cancel', PRINCIPAL), lookupTransport: init => new Promise((resolve, reject) => {
    signal = init.signal; signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }) });
  await f.client.authenticate('private-init'); const pending = f.client.recoverSubscriptionAction();
  const rejected = assert.rejects(pending, { code: 'outcome_unknown' });
  t.mock.timers.tick(14999); assert.equal(signal.aborted, false);
  t.mock.timers.tick(1); await rejected; assert.equal(signal.aborted, true);
  assert.equal(f.client.subscriptionOutcomePending, true); assert.equal(f.values.has(STORAGE_KEY), true);
  assert.equal(f.client.pendingSubscriptionDiagnostics.lastCancellationFailure, null);
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription/renewal/cancel')).length, 0);
});

test('malformed stored intent cannot export injected authentication or arbitrary storage fields', () => {
  const saved = marker(); saved.intent.sessionToken = 'secret-session'; saved.intent.initData = 'secret-init';
  const f = fixture({ saved });
  assert.equal(f.client.pendingSubscriptionDiagnostics.subscription.recoverable, false);
  assert.equal(f.client.pendingSubscriptionDiagnostics.subscription.intent, null);
  assert.doesNotMatch(JSON.stringify(f.client.pendingSubscriptionDiagnostics), /secret-session|secret-init|sessionToken|initData/);
});

test('historical marker without intent retains safe key for phone diagnosis but cannot recover or replay', async () => {
  const saved = marker(); delete saved.intent;
  const f = fixture({ saved }); await f.client.authenticate('private-init'); await f.client.recoverSubscriptionAction();
  const exported = f.client.pendingSubscriptionDiagnostics.subscription;
  assert.equal(exported.key, KEY); assert.equal(exported.kind, 'cancel'); assert.equal(exported.startedAt, NOW - 10);
  assert.equal(exported.intent, null); assert.equal(exported.recoverable, false);
  assert.equal(f.client.pendingSubscriptionRecoveryAvailable, false); assert.equal(f.calls.length, 1);
});

test('new marker binds to verified principal and foreign principal cannot lookup or recover it', async () => {
  const f = fixture(); await f.client.authenticate('private-init'); await f.client.subscriptionAction('cancel', intent);
  const saved = JSON.parse(f.values.get(STORAGE_KEY)); assert.deepEqual(saved.principal, PRINCIPAL);
  const other = fixture({ saved, principal: { telegramId: 202, botId: 789 } }); await other.client.authenticate('other-init');
  await assert.rejects(other.client.recoverSubscriptionAction(), { code: 'pending_principal_mismatch' });
  await assert.rejects(other.client.recoverMissingSubscriptionAction(), { code: 'state_conflict' });
  assert.equal(other.calls.length, 1); assert.equal(other.client.subscriptionRecoveryState.state, 'principal_mismatch');
  assert.equal(other.client.pendingSubscriptionDiagnostics.subscription.scope, 'principal_mismatch');
  assert.equal(other.client.subscriptionOutcomePending, true);
});

test('unverified principal cannot create a new unbound marker', async () => {
  const f = fixture({ principal: null }); await f.client.authenticate('legacy-session');
  await assert.rejects(f.client.subscriptionAction('cancel', intent), { code: 'writes_unavailable' });
  assert.equal(f.values.has(STORAGE_KEY), false); assert.equal(f.calls.length, 1);
});

test('explicit recovery is admitted only for looked-up missing cancel or enable and uses exact original identity', async () => {
  for (const kind of ['cancel', 'enable']) {
    const f = fixture({ saved: marker(kind, PRINCIPAL) }); await f.client.authenticate('private-init');
    await assert.rejects(f.client.recoverMissingSubscriptionAction(), { code: 'state_conflict' });
    await f.client.recoverSubscriptionAction(); assert.equal(f.client.pendingSubscriptionRecoveryAvailable, true);
    await f.client.recoverMissingSubscriptionAction(); assert.equal(f.client.subscriptionOutcomePending, false);
    assert.equal(f.values.has(STORAGE_KEY), false); assert.equal(f.calls.length, 3);
    assert.ok(f.calls[2].url.endsWith('/subscription/recover'));
    assert.equal(f.calls[2].init.headers['Idempotency-Key'], KEY);
    assert.deepEqual(JSON.parse(f.calls[2].init.body), { kind, intent });
    assert.equal(f.calls.filter(x => /\/renewal\//.test(x.url)).length, 0);
  }
});

test('missing invoice and existing pending or unknown operations cannot use explicit recover', async () => {
  for (const [kind, status] of [['invoice', 'missing'], ['cancel', 'pending'], ['enable', 'unknown']]) {
    const f = fixture({ saved: marker(kind), status }); await f.client.authenticate('private-init'); await f.client.recoverSubscriptionAction();
    assert.equal(f.client.pendingSubscriptionRecoveryAvailable, false);
    await assert.rejects(f.client.recoverMissingSubscriptionAction(), { code: 'state_conflict' });
    assert.equal(f.client.subscriptionOutcomePending, true); assert.equal(f.calls.length, 2);
  }
});

test('validated terminal status clears marker; non-terminal recovery never clears it', async () => {
  for (const status of ['confirmed', 'rejected']) {
    const f = fixture({ saved: marker(), status }); await f.client.authenticate('private-init'); await f.client.recoverSubscriptionAction();
    assert.equal(f.client.subscriptionOutcomePending, false); assert.equal(f.values.has(STORAGE_KEY), false);
  }
  const f = fixture({ saved: marker(), recoverStatus: 'unknown' }); await f.client.authenticate('private-init');
  await f.client.recoverSubscriptionAction(); await f.client.recoverMissingSubscriptionAction();
  assert.equal(f.client.subscriptionOutcomePending, true); assert.equal(f.values.has(STORAGE_KEY), true);
});

let nonJsonBodyReads = 0;
for (const [label, phase, httpStatus, transport] of [
  ['HTML503 without reading its body', 'non_json', 503, () => ({ status: 503, ok: false,
    headers: new Headers({ 'content-type': 'text/html' }), json() { nonJsonBodyReads++; throw new Error('private-server-body'); },
    text() { nonJsonBodyReads++; throw new Error('private-server-body'); } })],
  ['malformed JSON', 'json_body', 200, () => new Response('{private-server-body', { status: 200, headers: { 'content-type': 'application/json' } })],
  ['immediate fetch rejection', 'fetch', 0, () => { throw new TypeError('private-fetch-message https://private.example/secret'); }],
]) test('own recover safe transport diagnostics distinguish ' + label + ' and preserve financial uncertainty', async () => {
  const f = fixture({ saved: marker(), recoverTransport: transport }), original = f.values.get(STORAGE_KEY);
  await f.client.authenticate('private-init'); await f.client.recoverSubscriptionAction();
  await assert.rejects(f.client.recoverMissingSubscriptionAction(), { code: 'outcome_unknown', status: 0 });
  assert.deepEqual(f.client.pendingSubscriptionDiagnostics.lastRecoveryFailure,
    { code: 'outcome_unknown', status: 0, httpStatus, phase, durationMs: 0, timedOut: false });
  assert.equal(f.values.get(STORAGE_KEY), original); assert.equal(f.client.subscriptionOutcomePending, true);
  assert.equal(f.calls.filter(call => call.url.endsWith('/subscription/recover')).length, 1);
  assert.equal(f.calls.filter(call => /\/renewal\//.test(call.url)).length, 0);
  assert.equal(nonJsonBodyReads, 0);
  assert.doesNotMatch(JSON.stringify(f.client.pendingSubscriptionDiagnostics),
    /private-init|rpms1_|private-server-body|private-fetch-message|https:|Authorization|initData|sessionToken/);
});

test('superseded before admission resolves only explicit cancel or enable recovery; wrong endpoint, invoice or contract retains marker', async t => {
  const superseded = kind => ({ authority: 'worker', kind, state: 'rejected', attemptId: null, contractId: CONTRACT,
    invoiceUrl: null, effectRecorded: false, accessApplied: false, reviewRequired: false,
    actionAdmissionRequired: true, resolution: 'superseded_before_admission', authorization: auth('access.read_own') });
  for (const kind of ['cancel', 'enable']) await t.test('explicit ' + kind, async () => {
    const f = fixture({ saved: marker(kind), recoverResponse: superseded(kind) }); await f.client.authenticate('private-init');
    await f.client.recoverSubscriptionAction(); await f.client.recoverMissingSubscriptionAction();
    assert.equal(f.client.subscriptionOutcomePending, false); assert.equal(f.values.has(STORAGE_KEY), false);
    assert.equal(f.calls.filter(call => /\/renewal\//.test(call.url)).length, 0);
    assert.equal(f.calls[2].init.headers['Idempotency-Key'], KEY);
  });
  for (const kind of ['cancel', 'invoice']) await t.test('operation-status rejects special ' + kind, async () => {
    const f = fixture({ saved: marker(kind), lookupResponse: superseded(kind) }), original = f.values.get(STORAGE_KEY);
    await f.client.authenticate('private-init');
    await assert.rejects(f.client.recoverSubscriptionAction(), { code: 'invalid_response' });
    assert.equal(f.client.subscriptionOutcomePending, true); assert.equal(f.values.get(STORAGE_KEY), original);
    assert.equal(f.client.pendingSubscriptionRecoveryAvailable, false);
    await assert.rejects(f.client.recoverMissingSubscriptionAction(), { code: 'state_conflict' });
    assert.equal(f.calls.length, 2);
  });
  await t.test('explicit recovery rejects a different contract', async () => {
    const f = fixture({ saved: marker(), recoverResponse: { ...superseded('cancel'), contractId: '33333333-3333-4333-8333-333333333333' } });
    const original = f.values.get(STORAGE_KEY); await f.client.authenticate('private-init'); await f.client.recoverSubscriptionAction();
    await assert.rejects(f.client.recoverMissingSubscriptionAction(), { code: 'invalid_response' });
    assert.equal(f.client.subscriptionOutcomePending, true); assert.equal(f.values.get(STORAGE_KEY), original);
  });
});

class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.childNodes = []; this.attrs = {}; this.listeners = {};
    this.isConnected = true; this.classList = { add: (...values) => { this.className = [this.className, ...values].filter(Boolean).join(' '); } }; }
  append(...nodes) { this.childNodes.push(...nodes); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  addEventListener(name, action) { this.listeners[name] = action; }
  querySelectorAll(selector) { const matches = [];
    for (const child of this.childNodes) { if (typeof child !== 'object') continue;
      if (selector.startsWith('[') ? Object.hasOwn(child.attrs, selector.slice(1, -1)) : child.tagName?.toLowerCase() === selector) matches.push(child);
      matches.push(...child.querySelectorAll(selector)); } return matches; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() { this.focused = true; } select() { this.selected = true; }
}
const documentFor = clipboard => ({ defaultView: { navigator: { clipboard } }, createElement: tag => new Node(tag) });

test('one-click copy uses sanitized legacy diagnostics with no network or producer request', async () => {
  const f = fixture({ saved: marker() }); let copied, status;
  const document = documentFor({ writeText: async text => { copied = text; } }), container = new Node('section');
  assert.equal(await copyPendingSubscriptionDiagnostics({ document, client: f.client, container, onStatus: text => { status = text; } }), true);
  assert.equal(JSON.parse(copied).subscription.key, KEY); assert.equal(f.calls.length, 0); assert.match(status, /скопирована/);
});

test('phone clipboard failure shows selectable read-only diagnostic field without clearing marker', async () => {
  const f = fixture({ saved: marker() }), document = documentFor({ writeText: async () => { throw new Error('denied'); } });
  const container = new Node('section'); let status;
  assert.equal(await copyPendingSubscriptionDiagnostics({ document, client: f.client, container, onStatus: text => { status = text; } }), false);
  const field = container.querySelector('[data-subscription-diagnostics]');
  assert.equal(field.readOnly, true); assert.equal(field.selected, true); assert.equal(JSON.parse(field.value).subscription.key, KEY);
  assert.match(status, /Удерживайте/); assert.equal(f.calls.length, 0); assert.equal(f.client.subscriptionOutcomePending, true);
});

test('pending UI provides copy button and explicit recovery only when client admits it; purchases stay guarded', () => {
  let copied = 0, recovered = 0;
  const document = documentFor(null), data = subscriptionUIFixture({ now: NOW });
  const screen = renderSubscriptionScreen({ document, data, actionPending: true, pendingActionRecoveryAvailable: true,
    onCopyPendingDiagnostics: () => { copied++; }, onRecoverPendingAction: () => { recovered++; }, onPurchase: () => {} });
  const copy = screen.querySelector('[data-copy-pending-diagnostics]'), recover = screen.querySelector('[data-recover-pending-subscription]');
  assert.equal(copy.disabled, false); copy.listeners.click(); recover.listeners.click(); assert.equal(copied, 1); assert.equal(recovered, 1);
  const locked = renderSubscriptionScreen({ document, data, actionPending: true, pendingActionRecoveryAvailable: false,
    onCopyPendingDiagnostics: () => {}, onRecoverPendingAction: () => {} });
  assert.equal(locked.querySelector('[data-recover-pending-subscription]'), null);
  assert.ok(locked.querySelector('[data-copy-pending-diagnostics]'));
});
