import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { buildStarsInvoicePayload } from '../src/v1.3.6/stars-core-foundation.mjs';
import { acceptStarsPurchaseTerms, handleStarsPreCheckoutQuery, recordStarsSuccessfulPayment } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsPaidAccess, applyStarsCompensation } from '../src/v1.3.6/stars-access-runtime.mjs';
import { createAuthorityResolver, readLifecycleActorFacts, compileAuthorityAssertions, authoritySeconds,
  accountGenerationFingerprint, manualGrantSourceFingerprint } from '../src/v1.4.1/authority-resolver.mjs';
import { createRuntimeAuthorizer, projectRuntimeAccessAuthority, readRuntimeAuthorization,
  assertRuntimeAuthorizationFresh } from '../src/v1.4.1/runtime-authorizer.mjs';
import { projectSubscriptionAccess } from '../src/v1.4.2/subscription-access.mjs';
import { readSubscriptionData } from '../src/v1.4.2/subscription-read-model.mjs';
import { readSubscriptionCatalog } from '../src/v1.4.2/subscription-catalog.mjs';
import { FOUNDATION_POLICY_VERSION } from '../src/v1.4.1/capability-policy.mjs';

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
  f.serverEnv = { ...f.env, STARS_ROLLOUT_MODE:'allowlist', STARS_ROLLOUT_ALLOWLIST:'101' };
  f.sqlite.function('unixepoch',{deterministic:false,varargs:true},(...args)=> args.length===0 || args[0]==='now' ? f.now : authoritySeconds(args[0]));
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

const authorizer = createRuntimeAuthorizer(), resolver = createAuthorityResolver();
async function own(f) {
  const authorization = await authorizer.authorize(await f.context(101,'access.read_own'));
  const data = await readSubscriptionData({ authorization });
  await assertRuntimeAuthorizationFresh(authorization);
  return { authorization, data, runtime:projectRuntimeAccessAuthority(authorization), actor:readRuntimeAuthorization(authorization).actor };
}
function control(f, order, state) {
  f.sqlite.prepare(`INSERT INTO subscription_provider_events(event_id,event_key,contract_id,telegram_id,event_type,
    source,telegram_update_id,provider_state,actor_type,reason_code,evidence_sha256,received_at)
    VALUES(?,?,?,101,?,'telegram_update',?,?,'telegram','telegram_control_observed',?,?)`)
    .run(crypto.randomUUID(),'authority-control:'+next(),order.contractId,state==='failed'?'renewal_failed':'provider_control',
      next(),state,sha256('authenticated-test-control:'+state),f.now);
}

test('genuine recurring writer and own GET use one verified period through cancel, failure and read-time expiry',async t=>{
  for (const state of ['canceled','failed']) {
    const f=fixture(t), order=await recurring(f), end=f.now+500;
    await recordAndApply(f,successful(order,{expiration:end}));
    control(f,order,state);
    f.binding.audit.length=0;
    const view=await own(f);
    assert.equal(view.data.lifecycle.state,state==='failed'?'payment_failed':'cancel_at_period_end');
    assert.equal(view.data.lifecycle.paidAccess,true);assert.equal(view.data.lifecycle.paidUntil,end);
    assert.equal(view.data.access.current.accessState,view.data.lifecycle.state);
    assert.equal(view.runtime.paidCapabilitiesEnabled,true);assert.equal(view.runtime.lifecycle.state,view.data.lifecycle.state);
    assert.equal(view.data.access.current.activeDragon,true);assert.equal(view.data.access.current.remainingSeconds,500);
    assert.ok(f.binding.audit.every(row=>row.mode==='read'&&row.sql.startsWith('SELECT ')));
    const encoded=JSON.stringify(view.data);
    for(const secret of [order.payload,view.actor.sourceFingerprint,'provider_charge_id','external_invoice_payload']) assert.equal(encoded.includes(secret),false);
    f.now=end;
    const expired=await own(f);
    assert.equal(expired.data.lifecycle.state,'expired');assert.equal(expired.runtime.paidCapabilitiesEnabled,false);
    assert.equal(expired.data.access.current.planCode,'free');
    assert.equal(f.sqlite.prepare('SELECT status FROM subscriptions').get().status,'active');
  }
});

test('latest future provider head preserves current paid residue and grants no authority across an uncovered gap',async t=>{
  const f=fixture(t), order=await recurring(f), firstEnd=f.now+100, futureStart=firstEnd+MONTH, futureEnd=futureStart+MONTH;
  await recordAndApply(f,successful(order,{expiration:firstEnd}));
  await recordAndApply(f,successful(order,{expiration:futureEnd,first:false}),f.now+1);
  let view=await own(f);
  assert.equal(view.data.lifecycle.paidUntil,firstEnd);assert.equal(view.runtime.paidCapabilitiesEnabled,true);
  assert.equal(view.actor.validUntil,firstEnd);
  const guard=compileAuthorityAssertions(view.actor);
  f.now=firstEnd;
  assert.equal(f.sqlite.prepare(`SELECT (${guard.sql}) AS valid`).get(...guard.params).valid,0);
  view=await own(f);
  assert.equal(view.runtime.paidCapabilitiesEnabled,false);assert.equal(view.data.lifecycle.paidAccess,false);
  f.now=futureStart;
  view=await own(f);
  assert.equal(view.runtime.paidCapabilitiesEnabled,true);assert.equal(view.data.lifecycle.paidUntil,futureEnd);
});

test('verified first receipt begins the effective 31-day period immediately and expires at the unchanged provider boundary',async t=>{
  const f=fixture(t),order=await recurring(f,{plan:'professional'}),paidAt=f.now,end=paidAt+31*86400;
  await recordAndApply(f,successful(order,{expiration:end}));
  const immutable=()=>JSON.stringify({ledger:f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY rowid').all(),
    links:f.sqlite.prepare('SELECT * FROM subscription_payment_links ORDER BY rowid').all(),
    grants:f.sqlite.prepare('SELECT * FROM subscription_access_grants ORDER BY rowid').all()});
  const before=immutable(),stored=f.sqlite.prepare('SELECT starts_at,ends_at FROM subscription_access_grants').get();
  assert.equal(stored.starts_at,paidAt+86400);assert.equal(stored.ends_at,end);
  let view=await own(f);
  assert.equal(view.data.access.current.planCode,'professional');assert.equal(view.runtime.paidCapabilitiesEnabled,true);
  assert.equal(view.data.access.current.startsAt,paidAt);assert.equal(view.data.access.current.expiresAt,end);
  assert.equal(view.data.history.items[0].paidPeriod.startsAt,paidAt);
  f.now=end-1;view=await own(f);
  assert.equal(view.runtime.paidCapabilitiesEnabled,true);assert.equal(view.data.access.current.remainingSeconds,1);
  f.now=end;view=await own(f);
  assert.equal(view.data.access.current.planCode,'free');assert.equal(view.data.lifecycle.state,'expired');
  assert.equal(view.runtime.paidCapabilitiesEnabled,false);assert.equal(view.data.access.current.remainingSeconds,0);
  assert.equal(view.data.history.items[0].paidPeriod.endsAt,end);assert.equal(immutable(),before,
    'effective first-start projection never rewrites financial evidence at either boundary');
});

test('sidecar mutation invalidates accepted authority and mismatched provider period is never a paid source',async t=>{
  const f=fixture(t),order=await recurring(f);
  await recordAndApply(f,successful(order,{expiration:f.now+500}));
  const view=await own(f), priorFingerprint=view.actor.access.sourceFingerprint;
  control(f,order,'canceled');
  await assert.rejects(assertRuntimeAuthorizationFresh(view.authorization),{code:'authority_stale'});
  const after=await own(f);assert.notEqual(after.actor.access.sourceFingerprint,priorFingerprint);
  f.sqlite.exec('DROP TRIGGER v143_payment_link_no_update');
  f.sqlite.exec('UPDATE subscription_payment_links SET provider_period_start=provider_period_start+1,provider_period_end=provider_period_end+1');
  const broken=await own(f);
  assert.equal(broken.data.lifecycle.reviewRequired,true);assert.equal(broken.runtime.paidCapabilitiesEnabled,false);
  assert.equal(broken.data.access.current.status,'review_required');
  assert.throws(()=>readLifecycleActorFacts({...broken.actor}),{code:'untrusted_actor'});
});

test('late genuine first recurring charge through a recovery child remains an own verified paid source',async t=>{
  const f=fixture(t),order=await recurring(f,{state:'cancelled',expiresAt:f.now-1});
  const payment=await recordAndApply(f,successful(order,{expiration:f.now+500}));
  assert.notEqual(payment.recorded.orderId,order.orderId);
  const view=await own(f);
  assert.equal(view.data.lifecycle.paidAccess,true);assert.equal(view.data.lifecycle.paidUntil,f.now+500);
  assert.equal(view.data.access.current.planCode,'dragon');assert.equal(view.runtime.paidCapabilitiesEnabled,true);
  const first=f.sqlite.prepare('SELECT first_payment_ledger_entry_id FROM subscription_billing_contracts').get();
  assert.equal(first.first_payment_ledger_entry_id,payment.recorded.ledgerEntryId);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_first_recurring_receipts').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(order.orderId).order_state,'cancelled');
});

test('a specific old recurring refund leaves a genuine later period available at its own server start',async t=>{
  const f=fixture(t),order=await recurring(f),firstEnd=f.now+500,futureStart=firstEnd+MONTH,futureEnd=futureStart+MONTH;
  const first=successful(order,{expiration:firstEnd});
  await recordAndApply(f,first);
  await recordAndApply(f,successful(order,{expiration:futureEnd,first:false}),f.now+10);
  await applyStarsCompensation({...f.env,STARS_REFUNDS_ENABLED:'true'},
    {telegramPaymentChargeId:first.message.successful_payment.telegram_payment_charge_id,compensationType:'refund',occurredAt:f.now+20});
  let view=await own(f);
  assert.equal(view.runtime.paidCapabilitiesEnabled,false,JSON.stringify(view.data.lifecycle));assert.equal(view.data.lifecycle.reviewRequired,false,
    JSON.stringify({lifecycle:view.data.lifecycle,sub:f.sqlite.prepare('SELECT status,current_period_start,current_period_end FROM subscriptions').get(),
      plan:f.sqlite.prepare('SELECT plan_code,source_code,effective_from,effective_until FROM user_plans WHERE telegram_id=101').get(),
      state:f.sqlite.prepare('SELECT access_state,source_code,state_started_at,state_ends_at FROM user_access_states WHERE telegram_id=101').get()}));
  f.now=futureStart;
  view=await own(f);
  assert.equal(view.runtime.paidCapabilitiesEnabled,true);assert.equal(view.data.lifecycle.paidUntil,futureEnd);
});

test('chargeback of a genuine money-only payment and a suspended current row keep paid capabilities off',async t=>{
  const f=fixture(t),order=await recurring(f);
  await recordAndApply(f,successful(order,{expiration:f.now+500}));
  const other=await seedOrder(f,{state:'precheckout_ok',plan:'professional'}), receipt=successful(other);
  const money=await recordStarsSuccessfulPayment(f.env,receipt,{receivedAt:f.now});
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(money.ledgerEntryId).n,0);
  await applyStarsCompensation({...f.env,STARS_REFUNDS_ENABLED:'true'},
    {telegramPaymentChargeId:receipt.message.successful_payment.telegram_payment_charge_id,compensationType:'chargeback',occurredAt:f.now});
  let view=await own(f);
  assert.equal(view.data.lifecycle.state,'chargeback');assert.equal(view.runtime.paidCapabilitiesEnabled,false);
  assert.equal(f.sqlite.prepare('SELECT status FROM subscriptions').get().status,'suspended');
  f.sqlite.prepare("UPDATE user_access_states SET access_state='active',source_code='stars_payment',revision=revision+1 WHERE telegram_id=101").run();
  view=await own(f);
  assert.equal(view.data.lifecycle.state,'suspended');assert.equal(view.runtime.paidCapabilitiesEnabled,false);
});

test('refunding a retained money-only renewal preserves its shared origin and the original paid authority',async t=>{
  const f=fixture(t),order=await recurring(f),end=f.now+500;
  const initial=await recordAndApply(f,successful(order,{expiration:end}));
  await seedOrder(f,{state:'created'});
  f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=101').run();
  const retainedReceipt=successful(order,{expiration:end+MONTH,first:false});
  const retained=await recordStarsSuccessfulPayment(f.env,retainedReceipt,{receivedAt:f.now});
  assert.equal(retained.status,'manual_review');assert.notEqual(retained.ledgerEntryId,initial.recorded.ledgerEntryId);
  f.sqlite.prepare('UPDATE users SET is_blocked=0 WHERE telegram_id=101').run();
  const before=await own(f);
  assert.equal(before.runtime.paidCapabilitiesEnabled,true);assert.equal(before.data.lifecycle.paidUntil,end);
  assert.equal(before.data.lifecycle.reviewRequired,true);
  assert.throws(()=>f.sqlite.prepare(`INSERT INTO payment_ledger(ledger_entry_id,idempotency_key,order_id,telegram_id,entry_type,direction,currency,
    amount_stars,telegram_payment_charge_id,related_ledger_entry_id,reason_code,occurred_at,recorded_at)
    VALUES(?,?,?,101,'refund','debit','XTR',1,?,?,'offline_invalid_compensation',?,?)`)
    .run(crypto.randomUUID(),'invalid-related:'+next(),order.orderId,'unrelated-charge:'+next(),retained.ledgerEntryId,f.now,f.now),
    /ledger compensation does not match original payment/u);
  const malformed=await own(f);
  assert.equal(malformed.data.lifecycle.reviewRequired,true,'a rejected compensation cannot settle the financial observation');
  assert.equal(malformed.runtime.paidCapabilitiesEnabled,true);
  const refunded=await applyStarsCompensation({...f.env,STARS_REFUNDS_ENABLED:'true'},
    {telegramPaymentChargeId:retainedReceipt.message.successful_payment.telegram_payment_charge_id,compensationType:'refund',occurredAt:f.now});
  assert.equal(refunded.status,'applied');
  const after=await own(f);
  assert.equal(after.runtime.paidCapabilitiesEnabled,true);assert.equal(after.data.lifecycle.paidUntil,end);
  assert.equal(after.data.lifecycle.reviewRequired,false);
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(order.orderId).order_state,'applied');
  assert.equal(f.sqlite.prepare('SELECT status FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(initial.recorded.ledgerEntryId).status,'active');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(retained.ledgerEntryId).n,0);
  assert.equal(f.sqlite.prepare("SELECT related_ledger_entry_id FROM payment_ledger WHERE entry_type='refund' AND telegram_payment_charge_id=?")
    .get(retainedReceipt.message.successful_payment.telegram_payment_charge_id).related_ledger_entry_id,retained.ledgerEntryId);
});

test('expired precheckout GET frees the same purchase slot exactly at expiry while durable paid remains locked',async t=>{
  for(const state of ['created','precheckout_ok']) {
    const f=fixture(t);
    await seedOrder(f,{state,expiresAt:f.now,createdAt:f.now-60});
    const authorization=await authorizer.authorize(await f.context(101,'access.read_own'));
    const catalog=await readSubscriptionCatalog({authorization});
    assert.ok(catalog.offers.filter(row=>row.planCode!=='free').every(row=>row.purchaseEligibility.reasonCode!=='payment_order_in_progress'));
    assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders').get().order_state,state);
  }
});

test('malformed required recurring sidecar preserves independent canonical owner and genuine manual capability grant',async t=>{
  const f=fixture(t),order=await recurring(f);
  await recordAndApply(f,successful(order,{expiration:f.now+500}));
  const fingerprint=await accountGenerationFingerprint(f.sqlite.prepare('SELECT * FROM users WHERE telegram_id=101').get());
  const row={grant_id:crypto.randomUUID(),idempotency_key:sha256('manual-authority:'+next()),policy_version:FOUNDATION_POLICY_VERSION,
    capability:'application.create',subject_telegram_id:101,scope_kind:'actor',scope_key:'actor:101',source_kind:'manual_capability',
    source_ref:null,source_revision:1,issued_by:900,reason:'independent manual access',starts_at:f.now-1,expires_at:f.now+200,
    revision:1,created_at:f.now-1,updated_at:f.now-1,retention_until:f.now+1000};
  row.source_ref='manual:'+row.grant_id;row.source_fingerprint=await manualGrantSourceFingerprint(row,fingerprint);
  const keys=Object.keys(row);f.sqlite.prepare(`INSERT INTO entitlement_grants(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>row[key]));
  f.sqlite.exec('PRAGMA foreign_keys=OFF;DROP TABLE subscription_provider_commands;CREATE TABLE subscription_provider_commands(command_id TEXT,telegram_id INTEGER)');
  const actor=await resolver.resolveActor(await f.context(101,'access.read_own'));
  assert.equal(actor.access.status,'review_required');assert.equal(actor.grants.length,1);
  assert.equal(actor.financialSourceAvailable,true);
  const owner=await resolver.resolveActor(await f.context(900,'access.read_own'));
  assert.equal(owner.canonicalOwner,true);
});
