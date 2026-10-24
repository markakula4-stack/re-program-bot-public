import test from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionFixture } from './helpers/v1.4.3-provider-subscription-fixture.mjs';
import { handleVerifiedTelegramSubscriptionUpdate } from '../src/v1.4.3/provider-subscription-events.mjs';
import { createAuthorityResolver } from '../src/v1.4.1/authority-resolver.mjs';
import { createServiceExecutor } from '../src/v1.4.1/trusted-context.mjs';

const count = (f, table) => f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const ingest = (f, update, token, request = f.request(update), serviceContext = f.serviceContext()) =>
  handleVerifiedTelegramSubscriptionUpdate({ webhookRequest: request, serviceContext, receiptClaimToken: token });
const own = async f => (await createAuthorityResolver().resolveActor(await f.context(101, 'access.read_own'))).access.lifecycle;
const money = f => ({ ledger: f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY ledger_entry_id').all(),
  grants: f.sqlite.prepare('SELECT * FROM subscription_access_grants ORDER BY grant_id').all(),
  subscriptions: f.sqlite.prepare('SELECT * FROM subscriptions ORDER BY subscription_id').all() });

test('actual authenticated subscription-only webhook binds own signed origin; cancel preserves paid facts and read-time expiry', async t => {
  const f = await subscriptionFixture(t), before = money(f), update = f.update('canceled'), token = f.claim(update);
  const result = await ingest(f, update, token);
  assert.equal(result.status, 'recorded'); assert.equal(result.renewalState, 'canceled'); assert.equal(result.paidTimeChanged, false);
  assert.deepEqual(money(f), before);
  const event = f.sqlite.prepare('SELECT * FROM subscription_provider_events WHERE event_id=?').get(result.eventId);
  assert.equal(event.provider_occurred_at, null); assert.equal(event.received_at, f.now); assert.equal(event.telegram_update_id, update.update_id);
  assert.equal(event.event_type, 'provider_control'); assert.equal(event.evidence_sha256.length, 64);
  const lifecycle = await own(f);
  assert.equal(lifecycle.state, 'cancel_at_period_end'); assert.equal(lifecycle.paidAccess, true); assert.equal(lifecycle.paidUntil, f.paidUntil);
  f.now = f.paidUntil;
  assert.equal((await own(f)).state, 'expired'); assert.equal((await own(f)).paidAccess, false);
});

test('control active and failure do not grant money; genuine failed renewal preserves all paid remainder', async t => {
  const pending = await subscriptionFixture(t, { paid: false }), active = pending.update('active'), activeToken = pending.claim(active);
  const result = await ingest(pending, active, activeToken);
  assert.equal(result.renewalState, 'active'); assert.equal(count(pending, 'payment_ledger'), 0); assert.equal(count(pending, 'subscription_access_grants'), 0);
  assert.equal((await own(pending)).paidAccess, false);
  const f = await subscriptionFixture(t), failed = f.update('failed'), token = f.claim(failed), before = money(f);
  const failure = await ingest(f, failed, token);
  assert.equal(failure.renewalState, 'failed'); assert.deepEqual(money(f), before);
  assert.equal((await own(f)).state, 'payment_failed'); assert.equal((await own(f)).paidAccess, true);
});

test('forged service/raw booleans, transport secret, foreign subjects, altered payloads and invented dates never become provider facts', async t => {
  const f = await subscriptionFixture(t), update = f.update(), token = f.claim(update);
  await assert.rejects(ingest(f, update, token, f.request(update), { actorKind: 'service', trusted: true }), { code: 'untrusted_context' });
  const wrongPurpose = createServiceExecutor({ binding: f.binding, env: f.serverEnv, purpose: 'stars_expire', clockSeconds: () => f.now }).createContext();
  await assert.rejects(ingest(f, update, token, f.request(update), wrongPurpose), { code: 'subscription_service_required' });
  for (const patch of [{ headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' } },
    { headers: { 'Content-Type': 'text/plain' } }, { url: 'https://worker.example/other' },
    { url: 'https://worker.example/webhook?trusted=true' }])
    await assert.rejects(ingest(f, update, token, f.request(update, patch)), { code: 'subscription_transport_untrusted' });
  await assert.rejects(ingest(f, update, token, f.request(update, { headers: { 'Content-Length': '70000' } })), { code: 'subscription_body_invalid' });
  for (const modified of [{ ...update, subscription: { ...update.subscription, date: f.now } },
    { ...update, subscription: { ...update.subscription, state: 'cancelled' } },
    { ...update, subscription: { ...update.subscription, user: { id: '101', is_bot: false } } },
    { ...update, message: { from: { id: 101 } } }])
    await assert.rejects(ingest(f, modified, token), { code: 'subscription_update_invalid' });
  const foreign = f.update('active', update.update_id + 1, 202); const foreignToken = f.claim(foreign);
  assert.equal((await ingest(f, foreign, foreignToken)).status, 'ignored');
  const unrelatedPayload = f.update('active', update.update_id + 2, 101, f.payload.slice(0, -1) + 'x');
  assert.equal((await ingest(f, unrelatedPayload, f.claim(unrelatedPayload))).status, 'ignored');
  assert.equal(count(f, 'subscription_provider_events'), 0);
});

test('durable duplicates do not revise contract; out-of-order/reset state conflicts survive fresh own GET as unknown review', async t => {
  const f = await subscriptionFixture(t), update = f.update('canceled', 900000), token = f.claim(update);
  const recorded = await ingest(f, update, token);
  const revision = f.sqlite.prepare('SELECT revision FROM subscription_billing_contracts').get().revision;
  const duplicate = await ingest(f, update, token);
  assert.equal(duplicate.status, 'duplicate'); assert.equal(duplicate.eventId, recorded.eventId);
  assert.equal(f.sqlite.prepare('SELECT revision FROM subscription_billing_contracts').get().revision, revision);
  const reset = f.update('active', 3), resetToken = f.claim(reset);
  assert.equal((await ingest(f, reset, resetToken)).renewalState, 'unknown');
  const fresh = await own(f);
  assert.equal(fresh.renewalState, 'unknown'); assert.equal(fresh.reviewRequired, true); assert.equal(fresh.paidAccess, true);
  assert.equal(fresh.paidUntil, f.paidUntil);
  assert.equal(f.sqlite.prepare('SELECT provider_state FROM subscription_billing_contracts').get().provider_state, 'canceled');
});

test('terminal receipt permits exact duplicate or durable identity review, with no summary/paid effect or guessed command settlement', async t => {
  const f = await subscriptionFixture(t), update = f.update('active'), token = f.claim(update);
  const contract = f.sqlite.prepare('SELECT * FROM subscription_billing_contracts').get(), commandId = crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO subscription_provider_commands(command_id,idempotency_key,contract_id,telegram_id,
    action,desired_auto_renew,expected_contract_revision,first_payment_ledger_entry_id,request_sha256,created_at,updated_at)
    VALUES(?,?,?,101,'cancel_renewal',0,?,?,?,?,?)`).run(commandId, 'offline-unknown-cancel:' + commandId,
    f.contractId, contract.revision, contract.first_payment_ledger_entry_id, 'a'.repeat(64), f.now, f.now);
  f.sqlite.prepare(`UPDATE subscription_provider_commands SET state='attempted',attempted_count=1,
    attempted_at=?,revision=revision+1 WHERE command_id=?`).run(f.now, commandId);
  f.sqlite.prepare(`UPDATE subscription_provider_commands SET state='unknown',error_code='provider_timeout',
    revision=revision+1 WHERE command_id=?`).run(commandId);
  const recorded = await ingest(f, update, token);
  assert.equal(recorded.reviewRequired, true); assert.equal(recorded.pendingOperations, 1);
  assert.equal(f.sqlite.prepare('SELECT auto_renew_confirmed FROM subscription_billing_contracts').get().auto_renew_confirmed, null);
  f.sqlite.prepare("UPDATE telegram_update_receipts SET status='completed',completed_at=?,lease_expires_at=0 WHERE update_id=?").run(f.now, update.update_id);
  assert.equal((await ingest(f, update, undefined)).status, 'duplicate');
  const before = money(f), revision = f.sqlite.prepare('SELECT revision FROM subscription_billing_contracts').get().revision;
  const conflicting = { ...update, subscription: { ...update.subscription, state: 'failed' } };
  const review = await ingest(f, conflicting, undefined);
  assert.equal(review.status, 'review_required'); assert.equal(review.renewalState, 'unknown');
  assert.equal(review.reasonCode, 'provider_update_identity_conflict'); assert.deepEqual(money(f), before);
  assert.equal(f.sqlite.prepare('SELECT revision FROM subscription_billing_contracts').get().revision, revision);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM subscription_provider_events WHERE event_type='review_observed'").get().n, 1);
  await ingest(f, conflicting, undefined);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM subscription_provider_events WHERE event_type='review_observed'").get().n, 1);
  const fresh = await own(f);
  assert.equal(fresh.renewalState, 'unknown'); assert.equal(fresh.reviewRequired, true); assert.equal(fresh.paidAccess, true);
  assert.ok(fresh.reviewReasons.includes('provider_update_identity_conflict'));
  assert.equal(f.sqlite.prepare('SELECT state FROM subscription_provider_commands WHERE command_id=?').get(commandId).state, 'unknown');
  assert.equal(f.sqlite.prepare('SELECT evidence_sha256 FROM subscription_provider_events WHERE event_id=?').get(recorded.eventId).evidence_sha256.length, 64);
  for (const state of ['failed', 'abandoned']) {
    const terminal = f.update('canceled'); f.claim(terminal, { state });
    const closedReview = await ingest(f, terminal, undefined);
    assert.equal(closedReview.status, 'review_required'); assert.equal(closedReview.reasonCode, 'provider_update_receipt_without_fact');
    assert.equal(f.sqlite.prepare('SELECT revision FROM subscription_billing_contracts').get().revision, revision);
  }
});

test('concurrent delivery acknowledges the same durable event and revises the contract only once', async t => {
  const f = await subscriptionFixture(t), update = f.update('active'), token = f.claim(update);
  const beforeRevision = f.sqlite.prepare('SELECT revision FROM subscription_billing_contracts').get().revision;
  const results = await Promise.all([ingest(f, update, token), ingest(f, update, token)]);
  assert.deepEqual(results.map(result => result.status).sort(), ['duplicate', 'recorded']);
  assert.equal(results[0].eventId, results[1].eventId);
  assert.equal(count(f, 'subscription_provider_events'), 1);
  assert.equal(f.sqlite.prepare('SELECT revision FROM subscription_billing_contracts').get().revision, beforeRevision + 1);
  assert.equal(count(f, 'mini_app_atomic_guards'), 0);
});

test('missing/wrong/stale receipt and failed batch reject; rollback and retry cannot double event or paid time', async t => {
  const f = await subscriptionFixture(t), missing = f.update();
  await assert.rejects(ingest(f, missing, crypto.randomUUID()), { code: 'subscription_receipt_untrusted' });
  const expired = f.update(); await assert.rejects(ingest(f, expired, f.claim(expired, { lease: f.now })), { code: 'subscription_receipt_untrusted' });
  const foreign = f.update(); await assert.rejects(ingest(f, foreign, f.claim(foreign, { actor: 202 })), { code: 'subscription_receipt_untrusted' });
  const update = f.update('failed'), token = f.claim(update), before = money(f);
  f.binding.failStatement = sql => sql.startsWith('INSERT INTO subscription_provider_events');
  await assert.rejects(ingest(f, update, token), { code: 'subscription_event_persistence_failed', status: 503 });
  assert.equal(count(f, 'subscription_provider_events'), 0); assert.equal(count(f, 'mini_app_atomic_guards'), 0);
  assert.deepEqual(money(f), before);
  assert.equal((await ingest(f, update, token)).status, 'recorded');
  assert.equal((await ingest(f, update, token)).status, 'duplicate');
  assert.equal(count(f, 'subscription_provider_events'), 1); assert.deepEqual(money(f), before);
  const stale = f.update('canceled'), staleToken = f.claim(stale), batch = f.binding.batch.bind(f.binding);
  f.binding.batch = async statements => {
    if (statements.some(statement => statement.sql.startsWith('INSERT INTO subscription_provider_events'))) {
      f.binding.batch = batch;
      f.sqlite.prepare('UPDATE telegram_update_receipts SET lease_expires_at=0 WHERE update_id=?').run(stale.update_id);
    }
    return batch(statements);
  };
  await assert.rejects(ingest(f, stale, staleToken), { code: 'subscription_event_source_stale', status: 503 });
  assert.equal(count(f, 'subscription_provider_events'), 1); assert.equal(count(f, 'mini_app_atomic_guards'), 0);
  assert.deepEqual(money(f), before);
});
