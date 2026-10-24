import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { buildStarsInvoicePayload, parseStarsInvoicePayload } from '../src/v1.3.6/stars-core-foundation.mjs';
import { acceptStarsPurchaseTerms, issueStarsInvoice, handleStarsPreCheckoutQuery, recordStarsSuccessfulPayment } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsPaidAccess, applyStarsCompensation, handleStarsRefundedPaymentUpdate } from '../src/v1.3.6/stars-access-runtime.mjs';
import { handleStarsCommerceUpdate } from '../src/v1.3.6/stars-commerce-runtime.mjs';

const MONTH = 2_592_000;
let sequence = 1_430_000;
const next = () => ++sequence;
const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const sqlTime = value => new Date(value * 1000).toISOString().slice(0, 19).replace('T', ' ');

function fixture(t) {
  const f = foundationFixture(t);
  f.sqlite.function('current_timestamp', { deterministic: true }, () => sqlTime(f.now));
  for (const name of ['0026-v1.3.6-stars-core-foundation.sql', '0027-v1.3.6-stars-access-and-reconciliation.sql',
    '0066-v1.4.3-subscription-lifecycle-foundation.sql', '0067-v1.4.3-lifecycle-engine-binding.sql']) {
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  f.env = { ...f.serverEnv, STARS_PAYMENTS_ENABLED: 'true', STARS_BILLING_MODE: 'prepaid',
    STARS_PRICE_VERSION: '1', STARS_TERMS_REVISION: '2026-09-10.stars-v1',
    STARS_INVOICE_SECRET: 'offline-v143-payment-writer-secret-more-than-32-characters' };
  for (const id of [101, 202, 303, 404]) {
    f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(id);
    f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(id);
  }
  return f;
}

async function seedOrder(f, { id = 101, plan = 'dragon', mode = 'prepaid', state = 'created',
  createdAt = f.now - 60, expiresAt = f.now + 600 } = {}) {
  await acceptStarsPurchaseTerms(f.env, { telegramId: id, telegramUpdateId: next(), acceptedAt: createdAt - 1 });
  const priceId = `${plan}-30d-${mode}-v1`, amount = plan === 'dragon' ? 499 : 249;
  if (mode === 'recurring') {
    f.sqlite.prepare(`INSERT OR IGNORE INTO price_book(price_id,price_version,plan_code,currency,amount_stars,
      access_seconds,billing_mode,publication_state,terms_revision,valid_from,created_at,created_by)
      VALUES(?,1,?,'XTR',?,?,'recurring','approved',?,?,?,'offline-v143-fixture')`)
      .run(priceId, plan, amount, MONTH, f.env.STARS_TERMS_REVISION, createdAt - 100, createdAt - 100);
  }
  const orderId = crypto.randomUUID();
  const payload = await buildStarsInvoicePayload({ invoiceSecret: f.env.STARS_INVOICE_SECRET,
    orderId, telegramId: id, priceId });
  f.sqlite.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,currency,
    amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,expires_at,
    precheckout_approved_at,closed_at,updated_at) VALUES(?,?,?,1,?,'XTR',?,?,?,?,?,?,?,?,?,?,?)`)
    .run(orderId, id, priceId, plan, amount, MONTH, mode, f.env.STARS_TERMS_REVISION, payload, state,
      createdAt, expiresAt, state === 'precheckout_ok' ? createdAt + 1 : null,
      ['failed', 'cancelled'].includes(state) ? expiresAt : null, Math.max(createdAt, Math.min(f.now, expiresAt)));
  return { orderId, payload, id, plan, mode, amount, createdAt, expiresAt };
}

function checkout(order, { queryId = 'offline-v143-checkout-' + next(), updateId = next() } = {}) {
  return { update_id: updateId, pre_checkout_query: { id: queryId, from: { id: order.id, is_bot: false },
    currency: 'XTR', total_amount: order.amount, invoice_payload: order.payload } };
}

async function precheckout(f, order, { update = checkout(order), at = f.now } = {}) {
  const calls = [];
  const result = await handleStarsPreCheckoutQuery(f.env, update, { nowSeconds: at,
    telegramApi: async (_env, method, payload) => { calls.push({ method, payload }); return true; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'answerPreCheckoutQuery');
  assert.equal(calls[0].payload.ok, result.approved);
  return { result, answer: calls[0].payload, update };
}

function successful(order, { charge = 'offline-v143-charge-' + next(), expiration, first = true, updateId = next() } = {}) {
  return { update_id: updateId, message: { message_id: next(), from: { id: order.id, is_bot: false },
    chat: { id: order.id, type: 'private' }, successful_payment: { currency: 'XTR', total_amount: order.amount,
      invoice_payload: order.payload, telegram_payment_charge_id: charge, provider_payment_charge_id: '',
      ...(order.mode === 'recurring' ? { is_recurring: true, is_first_recurring: first,
        subscription_expiration_date: expiration } : {}) } } };
}

async function recordAndApply(f, update, at = f.now) {
  const recorded = await recordStarsSuccessfulPayment(f.env, update, { receivedAt: at });
  const applied = await applyStarsPaidAccess(f.env, { orderId: recorded.orderId, appliedAt: at });
  assert.equal(applied.accessApplied, true);
  return { recorded, applied };
}

async function recurring(f, options = {}) {
  const order = await seedOrder(f, { mode: 'recurring', state: 'precheckout_ok', createdAt: f.now - 2 * MONTH, ...options });
  const contractId = crypto.randomUUID();
  const acceptance = f.sqlite.prepare(`SELECT acceptance_id FROM terms_acceptances
    WHERE telegram_id=? AND terms_revision=? AND acceptance_scope='stars_purchase'`).get(order.id, f.env.STARS_TERMS_REVISION);
  f.sqlite.prepare(`INSERT INTO subscription_billing_contracts(contract_id,telegram_id,plan_code,price_id,
    origin_order_id,external_invoice_payload,external_payload_sha256,terms_revision,terms_acceptance_id,billing_mode,
    period_seconds,currency,amount_stars,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'recurring',?,'XTR',?,?,?)`)
    .run(contractId, order.id, order.plan, `${order.plan}-30d-recurring-v1`, order.orderId, order.payload,
      sha256(order.payload), f.env.STARS_TERMS_REVISION, acceptance.acceptance_id, MONTH, order.amount,
      order.createdAt, order.createdAt);
  return { ...order, contractId };
}

const count = (f, table) => f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const ownApproved = (f, orderId) => f.sqlite.prepare(`SELECT COUNT(*) AS n FROM payment_events
  WHERE order_id=? AND event_type='precheckout_approved' AND outcome='accepted'`).get(orderId).n;
const grantFor = (f, orderId) => f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE order_id=?').get(orderId);
const projection = f => f.sqlite.prepare(`SELECT subscription_id,source_order_id,status,current_period_start,
  current_period_end,last_ledger_entry_id,auto_renew FROM subscriptions ORDER BY current_period_end DESC`).get();
function assertExactSlice(f, result, start, end) {
  const grant = grantFor(f, result.recorded.orderId);
  assert.ok(grant);
  assert.equal(grant.starts_at, start);
  assert.equal(grant.ends_at, end);
  assert.equal(result.applied.periodStartsAt, start);
  assert.equal(result.applied.periodEndsAt, end);
  assert.equal(grant.payment_ledger_entry_id, result.recorded.ledgerEntryId);
}

test('precheckout never approves after a thrown transaction or an explicitly unsuccessful batch', async t => {
  for (const failure of ['throw', 'unsuccessful']) {
    const f = fixture(t), order = await seedOrder(f);
    f.binding.batch = async () => {
      if (failure === 'throw') throw new Error('offline transaction failure');
      return [{ success: false, meta: { changes: 0 } }, { success: false, meta: { changes: 0 } }, { success: false, meta: { changes: 0 } }];
    };
    const { result } = await precheckout(f, order);
    assert.equal(result.approved, false, failure);
    assert.equal(f.sqlite.prepare('SELECT order_state,precheckout_approved_at FROM subscription_orders WHERE order_id=?').get(order.orderId).order_state, 'created');
    assert.equal(f.sqlite.prepare('SELECT precheckout_approved_at FROM subscription_orders WHERE order_id=?').get(order.orderId).precheckout_approved_at, null);
    assert.equal(ownApproved(f, order.orderId), 0);
  }
});

test('precheckout requires an actual eligible order update when a cancellation races the batch', async t => {
  const f = fixture(t), order = await seedOrder(f);
  f.binding.beforeBatch = ({ sqlite }) => sqlite.prepare(`UPDATE subscription_orders SET order_state='cancelled',
    closed_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=?`).run(f.now, f.now, order.orderId);
  const { result } = await precheckout(f, order);
  assert.equal(result.approved, false);
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(order.orderId).order_state, 'cancelled');
  assert.equal(ownApproved(f, order.orderId), 0);
});

test('an accepted approval event for another order or payload cannot authorize a checkout', async t => {
  for (const collision of ['order', 'payload']) {
    const f = fixture(t), order = await seedOrder(f), other = await seedOrder(f, { id: 202 });
    const update = checkout(order), key = `precheckout:${sha256(update.pre_checkout_query.id).slice(0, 32)}:approved`;
    f.sqlite.prepare(`INSERT INTO payment_events(event_id,event_key,order_id,telegram_id,event_type,outcome,
      reason_code,payload_sha256,occurred_at,received_at) VALUES(?,?,?,?,'precheckout_approved','accepted','snapshot_verified',?,?,?)`)
      .run(crypto.randomUUID(), key, collision === 'order' ? other.orderId : order.orderId,
        collision === 'order' ? other.id : order.id, sha256(other.payload), f.now - 1, f.now - 1);
    const { result } = await precheckout(f, order, { update });
    assert.equal(result.approved, false, collision);
    const retained = f.sqlite.prepare('SELECT order_id,payload_sha256 FROM payment_events WHERE event_key=?').get(key);
    assert.equal(retained.order_id, collision === 'order' ? other.orderId : order.orderId);
    assert.equal(retained.payload_sha256, sha256(other.payload));
  }
});

test('expired created and approved orders are cancelled so the next prepaid purchase can proceed', async t => {
  for (const state of ['created', 'precheckout_ok']) {
    const f = fixture(t), old = await seedOrder(f, { state, createdAt: f.now - 60, expiresAt: f.now - 1 });
    const calls = [];
    const issued = await issueStarsInvoice(f.env, { telegramId: old.id, requestedPlanCode: old.plan,
      telegramUpdateId: next(), orderId: crypto.randomUUID(), createdAt: f.now }, {
      telegramApi: async (_env, method, payload) => { calls.push({ method, payload }); return { message_id: next() }; },
    });
    assert.equal(issued.status, 'issued');
    const closed = f.sqlite.prepare('SELECT order_state,closed_at,invoice_payload FROM subscription_orders WHERE order_id=?').get(old.orderId);
    assert.equal(closed.order_state, 'cancelled');
    assert.equal(closed.closed_at, f.now);
    assert.equal(closed.invoice_payload, old.payload);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'sendInvoice');
    assert.equal(calls[0].payload.subscription_period, undefined);
    assert.equal(count(f, 'payment_ledger'), 0);
  }
});

test('a verified late prepaid charge creates one recovery child while retaining the terminal invoice', async t => {
  for (const state of ['failed', 'cancelled']) {
    const f = fixture(t), order = await seedOrder(f, { expiresAt: f.now - 1 });
    assert.equal((await precheckout(f, order, { at: f.now - 20 })).result.approved, true);
    f.sqlite.prepare(`UPDATE subscription_orders SET order_state=?,closed_at=?,state_revision=state_revision+1,
      updated_at=? WHERE order_id=?`).run(state, f.now - 1, f.now - 1, order.orderId);
    const payment = successful(order);
    for (const invalid of ['signature', 'user', 'amount']) {
      const altered = structuredClone(payment); altered.update_id = next();
      if (invalid === 'user') { altered.message.from.id = 202; altered.message.chat.id = 202; }
      if (invalid === 'amount') altered.message.successful_payment.total_amount++;
      const runtimeEnv = invalid === 'signature' ? { ...f.env,
        STARS_INVOICE_SECRET: 'offline-v143-wrong-invoice-secret-more-than-32-characters' } : f.env;
      await assert.rejects(recordStarsSuccessfulPayment(runtimeEnv, altered, { receivedAt: f.now }), {
        code: { signature: 'invoice_signature_invalid', user: 'successful_payment_user_mismatch',
          amount: 'successful_payment_amount_mismatch' }[invalid],
      }, invalid);
      assert.equal(count(f, 'payment_ledger'), 0);
      assert.equal(count(f, 'subscription_orders'), 1);
    }
    const result = await recordAndApply(f, payment);
    assert.notEqual(result.recorded.orderId, order.orderId);
    assertExactSlice(f, result, f.now, f.now + MONTH);
    const child = f.sqlite.prepare('SELECT invoice_payload,order_state FROM subscription_orders WHERE order_id=?').get(result.recorded.orderId);
    assert.notEqual(child.invoice_payload, order.payload);
    assert.equal(parseStarsInvoicePayload(child.invoice_payload).orderId, result.recorded.orderId);
    assert.deepEqual({ ...f.sqlite.prepare('SELECT order_state,invoice_payload FROM subscription_orders WHERE order_id=?').get(order.orderId) },
      { order_state: state, invoice_payload: order.payload });
    const link = f.sqlite.prepare("SELECT * FROM subscription_payment_links WHERE direction='incoming'").get();
    assert.equal(link.link_kind, 'late_prepaid_charge');
    assert.equal(link.origin_order_id, order.orderId);
    assert.equal(link.applied_order_id, result.recorded.orderId);
    assert.equal(link.external_invoice_payload, order.payload);
    const replay = structuredClone(payment); replay.update_id = next();
    const duplicate = await recordAndApply(f, replay, f.now + 1);
    assert.equal(duplicate.recorded.status, 'duplicate');
    assert.equal(duplicate.applied.status, 'duplicate');
    assert.equal(duplicate.recorded.orderId, result.recorded.orderId);
    assert.equal(count(f, 'subscription_orders'), 2);
    assert.equal(count(f, 'payment_ledger'), 1);
    assert.equal(count(f, 'subscription_payment_links'), 1);
    assert.equal(count(f, 'subscription_access_grants'), 1);
  }
});

test('recurring first payment uses the origin; each later charge gets a distinct exact provider slice', async t => {
  const f = fixture(t), order = await recurring(f), firstEnd = f.now + 500;
  const firstUpdate = successful(order, { expiration: firstEnd });
  const first = await recordAndApply(f, firstUpdate);
  assert.equal(first.recorded.orderId, order.orderId);
  assertExactSlice(f, first, firstEnd - MONTH, firstEnd);
  assert.equal(count(f, 'subscription_first_recurring_receipts'), 1);
  assert.equal(f.sqlite.prepare('SELECT first_payment_ledger_entry_id FROM subscription_billing_contracts WHERE contract_id=?').get(order.contractId).first_payment_ledger_entry_id, first.recorded.ledgerEntryId);
  const latestUpdate = successful(order, { expiration: firstEnd + 2 * MONTH, first: false });
  const latest = await recordAndApply(f, latestUpdate, f.now + 2);
  assert.notEqual(latest.recorded.orderId, order.orderId);
  assertExactSlice(f, latest, firstEnd + MONTH, firstEnd + 2 * MONTH);
  const before = projection(f);
  const earlierUpdate = successful(order, { expiration: firstEnd + MONTH, first: false });
  const earlier = await recordAndApply(f, earlierUpdate, f.now + 10);
  assert.notEqual(earlier.recorded.orderId, order.orderId);
  assert.notEqual(earlier.recorded.orderId, latest.recorded.orderId);
  assertExactSlice(f, earlier, firstEnd, firstEnd + MONTH);
  assert.deepEqual(projection(f), before, 'an out-of-order older period must not replace current access');
  assert.notEqual(grantFor(f, earlier.recorded.orderId).ends_at, f.now + 10 + MONTH);
  const replay = structuredClone(earlierUpdate); replay.update_id = next();
  const duplicate = await recordAndApply(f, replay, f.now + 20);
  assert.equal(duplicate.recorded.status, 'duplicate');
  assert.equal(duplicate.recorded.orderId, earlier.recorded.orderId);
  for (const mismatch of ['expiration', 'first']) {
    const collision = structuredClone(firstUpdate); collision.update_id = next();
    if (mismatch === 'expiration') collision.message.successful_payment.subscription_expiration_date++;
    else collision.message.successful_payment.is_first_recurring = false;
    await assert.rejects(recordStarsSuccessfulPayment(f.env, collision, { receivedAt: f.now + 30 }), { code: 'payment_charge_collision' });
  }
  assert.equal(count(f, 'payment_ledger'), 3);
  assert.equal(count(f, 'subscription_payment_links'), 3);
  assert.equal(count(f, 'subscription_access_grants'), 3);
  assert.equal(count(f, 'subscription_orders'), 3);
  assert.equal(projection(f).current_period_end, firstEnd + 2 * MONTH);
  assert.equal(projection(f).last_ledger_entry_id, latest.recorded.ledgerEntryId);
});

test('a genuine first recurring charge after terminal closure uses one recovery child and its first marker', async t => {
  for (const state of ['failed', 'cancelled']) {
    const f = fixture(t), order = await recurring(f, { state, expiresAt: f.now - 1 }), end = f.now + 987;
    const update = successful(order, { expiration: end });
    const first = await recordAndApply(f, update);
    assert.notEqual(first.recorded.orderId, order.orderId);
    assertExactSlice(f, first, end - MONTH, end);
    assert.equal(f.sqlite.prepare('SELECT order_state,invoice_payload FROM subscription_orders WHERE order_id=?').get(order.orderId).order_state, state);
    const marker = f.sqlite.prepare(`SELECT r.operation_id,l.applied_order_id FROM subscription_first_recurring_receipts r
      JOIN subscription_payment_links l ON l.operation_id=r.operation_id WHERE r.contract_id=?`).get(order.contractId);
    assert.equal(marker.applied_order_id, first.recorded.orderId);
    assert.equal(f.sqlite.prepare('SELECT first_payment_ledger_entry_id FROM subscription_billing_contracts WHERE contract_id=?').get(order.contractId).first_payment_ledger_entry_id, first.recorded.ledgerEntryId);
    const replay = structuredClone(update); replay.update_id = next();
    assert.equal((await recordAndApply(f, replay, f.now + 1)).recorded.status, 'duplicate');
    const renewal = await recordAndApply(f, successful(order, { expiration: end + MONTH, first: false }), f.now + 2);
    assert.notEqual(renewal.recorded.orderId, first.recorded.orderId);
    assertExactSlice(f, renewal, end, end + MONTH);
    assert.equal(count(f, 'subscription_first_recurring_receipts'), 1);
    assert.equal(count(f, 'payment_ledger'), 2);
    assert.equal(count(f, 'subscription_access_grants'), 2);
  }
});

test('same-charge concurrent recovery imports resolve to the committed winner without duplicate evidence', async t => {
  for (const mode of ['prepaid', 'recurring']) {
    const f = fixture(t), seed = { state: 'cancelled', expiresAt: f.now - 1 };
    const order = mode === 'recurring' ? await recurring(f, seed) : await seedOrder(f, seed);
    const update = successful(order, { expiration: f.now + 500 });
    const winnerUpdate = structuredClone(update); winnerUpdate.update_id = next();
    let winner;
    f.binding.beforeBatch = async () => { winner = await recordAndApply(f, winnerUpdate, f.now); };
    const outer = await recordStarsSuccessfulPayment(f.env, update, { receivedAt: f.now });
    assert.ok(winner, 'the other delivery commits after the outer lookup but before its transaction');
    assert.equal(outer.status, 'duplicate', mode);
    assert.equal(outer.orderId, winner.recorded.orderId);
    assert.equal(outer.ledgerEntryId, winner.recorded.ledgerEntryId);
    assert.equal((await applyStarsPaidAccess(f.env, { orderId: outer.orderId, appliedAt: f.now })).status, 'duplicate');
    assert.equal(count(f, 'subscription_orders'), 2, mode);
    assert.equal(count(f, 'payment_ledger'), 1, mode);
    assert.equal(count(f, 'subscription_payment_links'), 1, mode);
    assert.equal(count(f, 'subscription_access_grants'), 1, mode);
    assert.equal(count(f, 'subscriptions'), 1, mode);
    assert.equal(count(f, 'subscription_first_recurring_receipts'), mode === 'recurring' ? 1 : 0);
    assert.equal(f.sqlite.prepare('SELECT order_state,invoice_payload FROM subscription_orders WHERE order_id=?').get(order.orderId).order_state, 'cancelled');
  }
});

test('a newer different charge winning an access-head race cannot be rewound by the older receipt', async t => {
  const f = fixture(t), order = await recurring(f), firstEnd = f.now + 500;
  await recordAndApply(f, successful(order, { expiration: firstEnd }));
  const olderUpdate = successful(order, { expiration: firstEnd + MONTH, first: false });
  const newerUpdate = successful(order, { expiration: firstEnd + 2 * MONTH, first: false });
  let winner, outer;
  f.binding.beforeBatch = async () => { winner = await recordAndApply(f, newerUpdate, f.now + 2); };
  try {
    outer = await recordStarsSuccessfulPayment(f.env, olderUpdate, { receivedAt: f.now + 1 });
  } catch (error) {
    assert.ok(error, 'an optimistic conflict may reject conservatively');
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM payment_ledger WHERE entry_type='payment' AND telegram_payment_charge_id=?")
      .get(olderUpdate.message.successful_payment.telegram_payment_charge_id).n, 0, 'the losing import leaves no partial money row');
    assert.equal(projection(f).current_period_end, firstEnd + 2 * MONTH);
    outer = await recordStarsSuccessfulPayment(f.env, olderUpdate, { receivedAt: f.now + 10 });
  }
  assert.ok(winner);
  const applied = await applyStarsPaidAccess(f.env, { orderId: outer.orderId, appliedAt: f.now + 10 });
  assertExactSlice(f, { recorded: outer, applied }, firstEnd, firstEnd + MONTH);
  assert.equal(projection(f).current_period_end, firstEnd + 2 * MONTH);
  assert.equal(projection(f).last_ledger_entry_id, winner.recorded.ledgerEntryId);
  assert.equal(count(f, 'payment_ledger'), 3);
  assert.equal(count(f, 'subscription_payment_links'), 3);
  assert.equal(count(f, 'subscription_access_grants'), 3);
  assert.equal(count(f, 'subscription_orders'), 3);
});

test('failure to persist an imported access slice rolls back its child, ledger, link and first-payment marker', async t => {
  for (const mode of ['prepaid', 'recurring']) {
    const f = fixture(t), seed = { state: 'cancelled', expiresAt: f.now - 1 };
    const order = mode === 'recurring' ? await recurring(f, seed) : await seedOrder(f, seed);
    const before = { ...f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(order.orderId) };
    f.binding.failStatement = sql => /INSERT\s+INTO\s+subscription_access_grants\b/iu.test(sql);
    await assert.rejects(recordStarsSuccessfulPayment(f.env, successful(order, { expiration: f.now + 500 }), { receivedAt: f.now }),
      /injected SQL failure/u);
    assert.equal(count(f, 'subscription_orders'), 1, mode);
    assert.equal(count(f, 'payment_ledger'), 0, mode);
    assert.equal(count(f, 'subscription_payment_links'), 0, mode);
    assert.equal(count(f, 'subscription_access_grants'), 0, mode);
    assert.equal(count(f, 'subscription_first_recurring_receipts'), 0, mode);
    assert.equal(count(f, 'subscriptions'), 0, mode);
    assert.deepEqual({ ...f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(order.orderId) }, before);
  }
});

test('an imported late charge preserves a newer created invoice without leaving a second open order', async t => {
  for (const mode of ['prepaid', 'recurring']) {
    const f = fixture(t), seed = { state: 'cancelled', expiresAt: f.now - 1 };
    const old = mode === 'recurring' ? await recurring(f, seed) : await seedOrder(f, seed);
    const newer = await seedOrder(f, { createdAt: f.now - 5 });
    const before = { ...f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(newer.orderId) };
    const recorded = await recordStarsSuccessfulPayment(f.env, successful(old, { expiration: f.now + 500 }), { receivedAt: f.now });
    assert.notEqual(recorded.orderId, old.orderId);
    assert.notEqual(recorded.orderId, newer.orderId);
    assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(recorded.orderId).order_state, 'applied',
      'the recovery import commits payment and access together before a separate access call');
    assert.ok(grantFor(f, recorded.orderId));
    assert.equal((await applyStarsPaidAccess(f.env, { orderId: recorded.orderId, appliedAt: f.now })).status, 'duplicate');
    assert.deepEqual({ ...f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(newer.orderId) }, before);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM subscription_orders WHERE order_state IN ('created','precheckout_ok','paid')").get().n, 1);
    assert.equal(count(f, 'payment_ledger'), 1);
    assert.equal(count(f, 'subscription_payment_links'), 1);
    assert.equal(count(f, 'subscription_access_grants'), 1);
  }
});

test('a successful batch row without the imported grant cannot commit partial recovery evidence', async t => {
  const f = fixture(t), order = await recurring(f, { state: 'cancelled', expiresAt: f.now - 1 });
  const batch = f.binding.batch.bind(f.binding);
  f.binding.batch = async statements => {
    for (const statement of statements) {
      if (/INSERT\s+INTO\s+subscription_access_grants\b/iu.test(statement.sql)) {
        statement.execute = () => ({ success: true, results: [], meta: { changes: 0 } });
      }
    }
    return batch(statements);
  };
  await assert.rejects(recordStarsSuccessfulPayment(f.env, successful(order, { expiration: f.now + 500 }), { receivedAt: f.now }));
  assert.equal(count(f, 'subscription_orders'), 1);
  assert.equal(count(f, 'payment_ledger'), 0);
  assert.equal(count(f, 'subscription_payment_links'), 0);
  assert.equal(count(f, 'subscription_access_grants'), 0);
  assert.equal(count(f, 'subscription_first_recurring_receipts'), 0);
  assert.equal(count(f, 'subscriptions'), 0);
});

test('a renewal without authenticated first-payment evidence retains money without fabricating access', async t => {
  const f = fixture(t), order = await recurring(f);
  const payment = await recordStarsSuccessfulPayment(f.env, successful(order, { expiration: f.now + 500, first: false }), { receivedAt: f.now });
  assert.equal(payment.status, 'recorded');
  await assert.rejects(applyStarsPaidAccess(f.env, { orderId: payment.orderId, appliedAt: f.now }), { code: 'recurring_first_payment_unverified' });
  assert.equal(count(f, 'payment_ledger'), 1);
  assert.equal(count(f, 'subscription_access_grants'), 0);
  assert.equal(count(f, 'subscription_first_recurring_receipts'), 0);
  assert.equal(count(f, 'subscriptions'), 0);
});

test('a genuine first payment arriving after its renewal unlocks both exact periods without treating the renewal as first', async t => {
  const f = fixture(t), origin = await recurring(f), firstEnd = f.now + MONTH, renewalEnd = f.now + 2 * MONTH;
  const renewalUpdate = successful(origin, { expiration: renewalEnd, first: false });
  const earlyRenewal = await recordStarsSuccessfulPayment(f.env, renewalUpdate, { receivedAt: f.now + 10 });
  assert.equal(earlyRenewal.status, 'recorded');
  assert.equal(earlyRenewal.orderId, origin.orderId);
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(origin.orderId).order_state, 'paid');
  await assert.rejects(applyStarsPaidAccess(f.env, { orderId: earlyRenewal.orderId, appliedAt: f.now + 10 }), { code: 'recurring_first_payment_unverified' });
  assert.equal(count(f, 'subscription_payment_links'), 1);
  assert.equal(count(f, 'subscription_first_recurring_receipts'), 0);
  assert.equal(count(f, 'subscription_access_grants'), 0);
  const firstUpdate = successful(origin, { expiration: firstEnd, first: true });
  const genuineFirst = await recordAndApply(f, firstUpdate, f.now + 20);
  assert.notEqual(genuineFirst.recorded.orderId, origin.orderId);
  assertExactSlice(f, genuineFirst, firstEnd - MONTH, firstEnd);
  const pending = grantFor(f, origin.orderId);
  assert.ok(pending, 'the durable first marker permits the previously recorded renewal to be applied');
  assert.equal(pending.payment_ledger_entry_id, earlyRenewal.ledgerEntryId);
  assert.equal(pending.starts_at, firstEnd);
  assert.equal(pending.ends_at, renewalEnd);
  assert.equal(f.sqlite.prepare('SELECT first_payment_ledger_entry_id FROM subscription_billing_contracts WHERE contract_id=?').get(origin.contractId).first_payment_ledger_entry_id,
    genuineFirst.recorded.ledgerEntryId, 'the real first charge remains the provider command identity');
  assert.equal(projection(f).current_period_end, renewalEnd);
  for (const update of [renewalUpdate, firstUpdate]) {
    const replay = structuredClone(update); replay.update_id = next();
    const duplicate = await recordAndApply(f, replay, f.now + 30);
    assert.equal(duplicate.recorded.status, 'duplicate');
    assert.equal(duplicate.applied.status, 'duplicate');
  }
  assert.equal(count(f, 'payment_ledger'), 2);
  assert.equal(count(f, 'subscription_payment_links'), 2);
  assert.equal(count(f, 'subscription_access_grants'), 2);
  assert.equal(count(f, 'subscription_first_recurring_receipts'), 1);
  const ordinary = fixture(t), normalOrigin = await recurring(ordinary);
  await recordAndApply(ordinary, successful(normalOrigin, { expiration: firstEnd, first: true }), f.now + 10);
  await recordAndApply(ordinary, successful(normalOrigin, { expiration: renewalEnd, first: false }), f.now + 20);
  const periods = subject => subject.sqlite.prepare('SELECT starts_at,ends_at,status FROM subscription_access_grants ORDER BY starts_at')
    .all().map(row => ({ ...row }));
  assert.deepEqual(periods(f), periods(ordinary), 'delivery order does not change the genuine paid intervals');
  assert.equal(projection(f).current_period_start, projection(ordinary).current_period_start);
  assert.equal(projection(f).current_period_end, projection(ordinary).current_period_end);
});

test('an overlapping alleged first period retains its charge for review without inventing first-payment authority', async t => {
  const f = fixture(t), origin = await recurring(f), renewalEnd = f.now + 2 * MONTH;
  const renewal = await recordStarsSuccessfulPayment(f.env, successful(origin, { expiration: renewalEnd, first: false }), { receivedAt: f.now + 10 });
  const firstEnd = f.now + MONTH + 1;
  const conflicting = successful(origin, { expiration: firstEnd, first: true });
  const result = await recordStarsSuccessfulPayment(f.env, conflicting, { receivedAt: f.now + 20 });
  assert.equal(result.status, 'manual_review');
  assert.equal(result.reason, 'recurring_first_charge_conflict');
  assert.equal(result.accessApplied, false);
  assert.equal(result.orderId, origin.orderId);
  assert.notEqual(result.ledgerEntryId, renewal.ledgerEntryId);
  const money = f.sqlite.prepare('SELECT reason_code,amount_stars FROM payment_ledger WHERE ledger_entry_id=?').get(result.ledgerEntryId);
  assert.equal(money.reason_code, 'payment_review_retained');
  assert.equal(money.amount_stars, origin.amount);
  const metadata = f.sqlite.prepare('SELECT provider_period_start,provider_period_end,is_first_recurring FROM subscription_payment_review_receipts WHERE ledger_entry_id=?').get(result.ledgerEntryId);
  assert.equal(metadata.provider_period_start, firstEnd - MONTH);
  assert.equal(metadata.provider_period_end, firstEnd);
  assert.equal(metadata.is_first_recurring, 1);
  assert.equal(count(f, 'payment_ledger'), 2, 'both authentic charges remain in the financial ledger');
  assert.equal(count(f, 'subscription_payment_links'), 1);
  assert.equal(count(f, 'subscription_payment_review_receipts'), 1);
  assert.equal(count(f, 'subscription_orders'), 1);
  assert.equal(count(f, 'subscription_access_grants'), 0);
  assert.equal(count(f, 'subscription_first_recurring_receipts'), 0);
  assert.equal(count(f, 'subscriptions'), 0);
});

test('provider refunds of imported children authenticate the original external invoice and compensate only that charge', async t => {
  for (const mode of ['prepaid', 'recurring']) {
    const f = fixture(t), seed = { state: 'cancelled', expiresAt: f.now - 1 };
    const origin = mode === 'recurring' ? await recurring(f, seed) : await seedOrder(f, seed);
    const paidUpdate = successful(origin, { expiration: f.now + 500 });
    const purchase = await recordAndApply(f, paidUpdate);
    const childPayload = f.sqlite.prepare('SELECT invoice_payload FROM subscription_orders WHERE order_id=?').get(purchase.recorded.orderId).invoice_payload;
    const update = { update_id: next(), message: { message_id: next(), from: { id: origin.id, is_bot: false },
      chat: { id: origin.id, type: 'private' }, refunded_payment: { currency: 'XTR', total_amount: origin.amount,
        invoice_payload: origin.payload, telegram_payment_charge_id: paidUpdate.message.successful_payment.telegram_payment_charge_id,
        provider_payment_charge_id: '' } } };
    const foreignPayload = await buildStarsInvoicePayload({ invoiceSecret: f.env.STARS_INVOICE_SECRET,
      orderId: crypto.randomUUID(), telegramId: 202, priceId: 'dragon-30d-prepaid-v1' });
    for (const invalid of ['user', 'foreign_payload', 'internal_child']) {
      const altered = structuredClone(update); altered.update_id = next();
      if (invalid === 'user') { altered.message.from.id = 202; altered.message.chat.id = 202; }
      if (invalid === 'foreign_payload') altered.message.refunded_payment.invoice_payload = foreignPayload;
      if (invalid === 'internal_child') altered.message.refunded_payment.invoice_payload = childPayload;
      await assert.rejects(handleStarsRefundedPaymentUpdate(f.env, altered, { receivedAt: f.now + 10 }), { code: 'refunded_payment_mismatch' });
      assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM payment_ledger WHERE direction='debit'").get().n, 0, invalid);
      assert.equal(count(f, 'payment_refunds'), 0, invalid);
      assert.equal(grantFor(f, purchase.recorded.orderId).status, 'active');
    }
    const refund = await handleStarsRefundedPaymentUpdate(f.env, update, { receivedAt: f.now + 10 });
    assert.equal(refund.status, 'applied');
    assert.equal(refund.orderId, purchase.recorded.orderId);
    const debit = f.sqlite.prepare("SELECT * FROM payment_ledger WHERE direction='debit'").get();
    assert.equal(debit.entry_type, 'refund');
    assert.equal(debit.order_id, purchase.recorded.orderId);
    assert.equal(debit.related_ledger_entry_id, purchase.recorded.ledgerEntryId);
    assert.equal(debit.telegram_payment_charge_id, paidUpdate.message.successful_payment.telegram_payment_charge_id);
    assert.equal(debit.amount_stars, origin.amount);
    const compensated = grantFor(f, purchase.recorded.orderId);
    assert.equal(compensated.status, 'refunded');
    assert.equal(compensated.compensation_ledger_entry_id, debit.ledger_entry_id);
    assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(origin.orderId).order_state, 'cancelled');
    const replay = structuredClone(update); replay.update_id = next();
    assert.equal((await handleStarsRefundedPaymentUpdate({ ...f.env }, replay, { receivedAt: f.now + 20 })).status, 'duplicate');
    assert.equal(count(f, 'payment_ledger'), 2);
    assert.equal(count(f, 'payment_refunds'), 1);
    assert.equal(count(f, 'subscription_access_grants'), 1);
  }
});

async function assertRenewalStopped(f, order, firstEnd, code) {
  const before = projection(f), grants = count(f, 'subscription_access_grants');
  const payment = await recordStarsSuccessfulPayment(f.env, successful(order, { expiration: firstEnd + MONTH, first: false }), { receivedAt: f.now + 10 });
  assert.equal(payment.status, 'recorded', 'financial evidence remains recorded even while access needs review');
  await assert.rejects(applyStarsPaidAccess(f.env, { orderId: payment.orderId, appliedAt: f.now + 10 }), { code });
  assert.equal(count(f, 'subscription_access_grants'), grants);
  assert.deepEqual(projection(f), before);
}

test('refunding the first charge does not deny a later genuine recurring paid period', async t => {
  const f = fixture(t), order = await recurring(f), end = f.now + 500;
  const update = successful(order, { expiration: end });
  const first = await recordAndApply(f, update);
  await applyStarsCompensation(f.env, { telegramPaymentChargeId: update.message.successful_payment.telegram_payment_charge_id,
    compensationType: 'refund', telegramUpdateId: next(), occurredAt: f.now + 1 });
  const later = await recordAndApply(f, successful(order, { expiration: end + MONTH, first: false }), f.now + 10);
  assertExactSlice(f, later, end, end + MONTH);
  assert.equal(grantFor(f, first.recorded.orderId).status, 'refunded');
  assert.equal(grantFor(f, later.recorded.orderId).status, 'active');
  assert.equal(count(f, 'subscription_access_grants'), 2);
});

test('refunding an older first charge preserves an unrelated later paid slice across a provider gap', async t => {
  const f = fixture(t), order = await recurring(f), end = f.now + 500;
  const update = successful(order, { expiration: end });
  const first = await recordAndApply(f, update);
  const later = await recordAndApply(f, successful(order, { expiration: end + 2 * MONTH, first: false }), f.now + 10);
  const before = { ...grantFor(f, later.recorded.orderId) };
  await applyStarsCompensation(f.env, { telegramPaymentChargeId: update.message.successful_payment.telegram_payment_charge_id,
    compensationType: 'refund', telegramUpdateId: next(), occurredAt: f.now + 20 });
  assert.equal(grantFor(f, first.recorded.orderId).status, 'refunded');
  assert.deepEqual({ ...grantFor(f, later.recorded.orderId) }, before);
  assert.equal(projection(f).current_period_end, end + 2 * MONTH,
    'a debit for an older period cannot blindly subtract 30 days from a later real period');
  const debit = f.sqlite.prepare("SELECT related_ledger_entry_id FROM payment_ledger WHERE entry_type='refund'").get();
  assert.equal(debit.related_ledger_entry_id, first.recorded.ledgerEntryId);
});

test('unresolved chargeback policy retains a later financial receipt without automatic access activation', async t => {
  const f = fixture(t), order = await recurring(f), end = f.now + 500;
  const update = successful(order, { expiration: end });
  await recordAndApply(f, update);
  await applyStarsCompensation(f.env, { telegramPaymentChargeId: update.message.successful_payment.telegram_payment_charge_id,
    compensationType: 'chargeback', telegramUpdateId: next(), occurredAt: f.now + 1 });
  await assertRenewalStopped(f, order, end, 'paid_access_suspended');
});

test('an unknown renewal-control command remains unknown while a genuine paid period is preserved', async t => {
  const f = fixture(t), order = await recurring(f), end = f.now + 500;
  const first = await recordAndApply(f, successful(order, { expiration: end }));
  const contract = f.sqlite.prepare('SELECT revision FROM subscription_billing_contracts WHERE contract_id=?').get(order.contractId);
  const commandId = crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO subscription_provider_commands(command_id,idempotency_key,contract_id,telegram_id,
    action,desired_auto_renew,expected_contract_revision,first_payment_ledger_entry_id,request_sha256,created_at,updated_at)
    VALUES(?,?,?,?,'cancel_renewal',0,?,?,?,?,?)`).run(commandId, 'offline-v143-unknown-' + next(), order.contractId,
    order.id, contract.revision, first.recorded.ledgerEntryId, sha256(commandId), f.now + 1, f.now + 1);
  f.sqlite.prepare(`UPDATE subscription_provider_commands SET state='attempted',attempted_count=1,attempted_at=?,
    revision=revision+1,updated_at=? WHERE command_id=?`).run(f.now + 2, f.now + 2, commandId);
  f.sqlite.prepare(`UPDATE subscription_provider_commands SET state='unknown',revision=revision+1,updated_at=?
    WHERE command_id=?`).run(f.now + 3, commandId);
  const control = { ...f.sqlite.prepare(`SELECT provider_state,auto_renew_confirmed,last_provider_event_id
    FROM subscription_billing_contracts WHERE contract_id=?`).get(order.contractId) };
  const later = await recordAndApply(f, successful(order, { expiration: end + MONTH, first: false }), f.now + 10);
  assertExactSlice(f, later, end, end + MONTH);
  assert.equal(f.sqlite.prepare('SELECT state,attempted_count FROM subscription_provider_commands WHERE command_id=?').get(commandId).state, 'unknown');
  assert.deepEqual({ ...f.sqlite.prepare(`SELECT provider_state,auto_renew_confirmed,last_provider_event_id
    FROM subscription_billing_contracts WHERE contract_id=?`).get(order.contractId) }, control);
});

test('a blocked or suspended subject does not receive another recurring access slice', async t => {
  for (const policy of ['blocked', 'suspended']) {
    const f = fixture(t), order = await recurring(f), end = f.now + 500;
    await recordAndApply(f, successful(order, { expiration: end }));
    if (policy === 'blocked') f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=?').run(order.id);
    else {
      f.sqlite.prepare("UPDATE subscriptions SET status='suspended',revision=revision+1 WHERE telegram_id=?").run(order.id);
      f.sqlite.prepare("UPDATE user_access_states SET access_state='suspended',revision=revision+1 WHERE telegram_id=?").run(order.id);
    }
    await assertRenewalStopped(f, order, end, 'paid_access_suspended');
  }
});

test('an active subscription for another plan is not replaced by the old recurring contract', async t => {
  const f = fixture(t), order = await recurring(f), end = f.now + 500;
  await recordAndApply(f, successful(order, { expiration: end }));
  f.sqlite.prepare("UPDATE subscriptions SET status='expired',revision=revision+1 WHERE telegram_id=?").run(order.id);
  const prepaid = await seedOrder(f, { plan: 'professional', state: 'precheckout_ok', createdAt: f.now + 1 });
  await recordAndApply(f, successful(prepaid), f.now + 2);
  await assertRenewalStopped(f, order, end, 'recurring_contract_conflict');
  assert.equal(f.sqlite.prepare('SELECT plan_code FROM user_plans WHERE telegram_id=?').get(order.id).plan_code, 'professional');
});

test('a closed first receipt under review retains its money and exact metadata without disturbing a newer invoice', async t => {
  for (const scenario of ['recurring_blocked', 'recurring_first_unverified', 'prepaid_blocked']) {
    const f = fixture(t), recurringMode = scenario !== 'prepaid_blocked';
    const seed = { state: 'cancelled', expiresAt: f.now - 1 };
    const origin = recurringMode ? await recurring(f, seed) : await seedOrder(f, seed);
    const newer = await seedOrder(f, { createdAt: f.now - 5 });
    if (scenario.endsWith('blocked')) f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=?').run(origin.id);
    const originBefore = { ...f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(origin.orderId) };
    const newerBefore = { ...f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(newer.orderId) };
    const end = f.now + 500, first = scenario !== 'recurring_first_unverified';
    const update = successful(origin, { expiration: end, first });
    update.message.date = f.now - 300;
    const result = await recordStarsSuccessfulPayment(f.env, update, { receivedAt: f.now + 10 });
    assert.equal(result.status, 'manual_review', scenario);
    assert.equal(result.accessApplied, false);
    assert.equal(result.reviewRequired, true);
    assert.equal(result.orderId, origin.orderId);
    const ledger = f.sqlite.prepare('SELECT * FROM payment_ledger WHERE ledger_entry_id=?').get(result.ledgerEntryId);
    assert.equal(ledger.order_id, origin.orderId);
    assert.equal(ledger.reason_code, 'payment_review_retained');
    assert.equal(ledger.amount_stars, origin.amount);
    const metadata = f.sqlite.prepare('SELECT * FROM subscription_payment_review_receipts WHERE ledger_entry_id=?').get(result.ledgerEntryId);
    assert.equal(metadata.origin_order_id, origin.orderId);
    assert.equal(metadata.contract_id, recurringMode ? origin.contractId : null);
    assert.equal(metadata.external_invoice_payload, origin.payload);
    assert.equal(metadata.external_payload_sha256, sha256(origin.payload));
    assert.equal(metadata.provider_period_start, recurringMode ? end - MONTH : null);
    assert.equal(metadata.provider_period_end, recurringMode ? end : null);
    assert.equal(metadata.is_first_recurring, recurringMode && first ? 1 : 0);
    assert.equal(metadata.telegram_update_id, update.update_id);
    assert.ok(metadata.recorded_at >= ledger.recorded_at);
    const accepted = f.sqlite.prepare(`SELECT outcome,reason_code,payload_sha256,occurred_at,received_at FROM payment_events
      WHERE telegram_update_id=? AND event_type='payment_recorded'`).get(update.update_id);
    assert.equal(accepted.outcome, 'accepted');
    assert.equal(accepted.reason_code, 'payment_review_retained');
    assert.equal(accepted.payload_sha256, metadata.evidence_sha256);
    assert.equal(metadata.recorded_at, ledger.recorded_at);
    assert.equal(accepted.received_at, ledger.recorded_at);
    assert.ok(ledger.recorded_at >= ledger.occurred_at);
    assert.ok(accepted.received_at >= accepted.occurred_at);
    assert.equal(count(f, 'subscription_orders'), 2);
    assert.equal(count(f, 'payment_ledger'), 1);
    assert.equal(count(f, 'subscription_payment_review_receipts'), 1);
    for (const table of ['subscription_payment_links', 'subscription_access_grants', 'subscription_first_recurring_receipts', 'subscriptions']) assert.equal(count(f, table), 0, table);
    assert.deepEqual({ ...f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(origin.orderId) }, originBefore);
    assert.deepEqual({ ...f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(newer.orderId) }, newerBefore);
    const replay = structuredClone(update); replay.update_id = next();
    const duplicate = await recordStarsSuccessfulPayment({ ...f.env }, replay, { receivedAt: f.now + 20 });
    assert.equal(duplicate.status, 'manual_review');
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.accessApplied, false);
    assert.equal(duplicate.ledgerEntryId, result.ledgerEntryId);
    assert.equal(count(f, 'payment_ledger'), 1);
    assert.equal(count(f, 'subscription_payment_review_receipts'), 1);
    if (recurringMode) for (const mismatch of ['expiration', 'first']) {
      const collision = structuredClone(update); collision.update_id = next();
      if (mismatch === 'expiration') collision.message.successful_payment.subscription_expiration_date++;
      else collision.message.successful_payment.is_first_recurring = !first;
      await assert.rejects(recordStarsSuccessfulPayment({ ...f.env }, collision, { receivedAt: f.now + 30 }), { code: 'payment_charge_collision' });
    }
  }
});

test('retained renewal review never returns the old origin grant or receipt through the commerce facade', async t => {
  for (const policy of ['blocked', 'chargeback', 'conflict']) {
    const f = fixture(t), origin = await recurring(f), end = f.now + 500;
    const firstUpdate = successful(origin, { expiration: end });
    await recordAndApply(f, firstUpdate);
    if (policy === 'chargeback') await applyStarsCompensation(f.env, {
      telegramPaymentChargeId: firstUpdate.message.successful_payment.telegram_payment_charge_id,
      compensationType: 'chargeback', telegramUpdateId: next(), occurredAt: f.now + 1,
    });
    if (policy === 'conflict') {
      f.sqlite.prepare("UPDATE subscriptions SET status='expired',revision=revision+1 WHERE telegram_id=?").run(origin.id);
      const other = await seedOrder(f, { plan: 'professional', state: 'precheckout_ok', createdAt: f.now + 1 });
      await recordAndApply(f, successful(other), f.now + 2);
    }
    const newer = await seedOrder(f, { createdAt: f.now + 3 });
    if (policy === 'blocked') f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=?').run(origin.id);
    const before = Object.fromEntries(['subscription_orders', 'payment_ledger', 'subscription_payment_links',
      'subscription_access_grants', 'subscription_first_recurring_receipts'].map(table => [table, count(f, table)]));
    const originBefore = { ...f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(origin.orderId) };
    const newerBefore = { ...f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(newer.orderId) };
    const update = successful(origin, { expiration: end + MONTH, first: false });
    const retained = await recordStarsSuccessfulPayment(f.env, update, { receivedAt: f.now + 10 });
    assert.equal(retained.status, 'manual_review', policy);
    assert.equal(retained.accessApplied, false);
    assert.equal(retained.orderId, origin.orderId);
    const replay = structuredClone(update); replay.update_id = next();
    const commerce = await handleStarsCommerceUpdate({ ...f.env }, replay, { nowSeconds: f.now + 20 });
    assert.equal(commerce.handled, true);
    assert.equal(commerce.status, 'manual_review');
    assert.equal(commerce.accessApplied, false);
    assert.equal(commerce.duplicate, true);
    assert.equal(commerce.ledgerEntryId, retained.ledgerEntryId);
    for (const field of ['grantId', 'subscriptionId', 'receipt']) assert.equal(Object.hasOwn(commerce, field), false, field);
    assert.equal(count(f, 'payment_ledger'), before.payment_ledger + 1);
    for (const table of ['subscription_orders', 'subscription_payment_links', 'subscription_access_grants', 'subscription_first_recurring_receipts']) assert.equal(count(f, table), before[table], table);
    assert.equal(count(f, 'subscription_payment_review_receipts'), 1);
    const metadata = f.sqlite.prepare('SELECT * FROM subscription_payment_review_receipts WHERE ledger_entry_id=?').get(retained.ledgerEntryId);
    assert.equal(metadata.provider_period_start, end);
    assert.equal(metadata.provider_period_end, end + MONTH);
    assert.equal(metadata.is_first_recurring, 0);
    assert.deepEqual({ ...f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(origin.orderId) }, originBefore);
    assert.deepEqual({ ...f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(newer.orderId) }, newerBefore);
  }
});
