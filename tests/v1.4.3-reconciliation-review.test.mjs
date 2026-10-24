import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { foundationFixture, signedInitData } from './helpers/v1.4.1-fixtures.mjs';
import { buildStarsInvoicePayload, parseStarsInvoicePayload } from '../src/v1.3.6/stars-core-foundation.mjs';
import { acceptStarsPurchaseTerms, issueStarsInvoice, handleStarsPreCheckoutQuery, recordStarsSuccessfulPayment } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { reconcileStarsTransactions, applyStarsPaidAccess, applyStarsCompensation, handleStarsRefundedPaymentUpdate } from '../src/v1.3.6/stars-access-runtime.mjs';
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
    '0066-v1.4.3-subscription-lifecycle-foundation.sql', '0067-v1.4.3-lifecycle-engine-binding.sql','0068-v1.4.3-provider-and-review-binding.sql']) {
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  f.env = { ...f.serverEnv, STARS_PAYMENTS_ENABLED: 'true', STARS_RECONCILIATION_ENABLED:'true', STARS_REFUNDS_ENABLED:'true', STARS_BILLING_MODE: 'prepaid',
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
  const priceId = mode==='recurring'?`${plan}-30d-recurring-offline-v9`:`${plan}-30d-prepaid-v1`, amount = plan === 'dragon' ? 499 : 249;
  if (mode === 'recurring') {
    f.sqlite.prepare(`INSERT OR IGNORE INTO price_book(price_id,price_version,plan_code,currency,amount_stars,
      access_seconds,billing_mode,publication_state,terms_revision,valid_from,created_at,created_by)
      VALUES(?,9,?,'XTR',?,?,'recurring','approved',?,?,?,'offline-v143-fixture')`)
      .run(priceId, plan, amount, MONTH, f.env.STARS_TERMS_REVISION, createdAt - 100, createdAt - 100);
  }
  const orderId = crypto.randomUUID();
  const payload = await buildStarsInvoicePayload({ invoiceSecret: f.env.STARS_INVOICE_SECRET,
    orderId, telegramId: id, priceId });
  f.sqlite.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,currency,
    amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,expires_at,
    precheckout_approved_at,closed_at,updated_at) VALUES(?,?,?,?,?,'XTR',?,?,?,?,?,?,?,?,?,?,?)`)
    .run(orderId, id, priceId, mode==='recurring'?9:1, plan, amount, MONTH, mode, f.env.STARS_TERMS_REVISION, payload, state,
      createdAt, expiresAt, state === 'precheckout_ok' ? createdAt + 1 : null,
      ['failed', 'cancelled'].includes(state) ? expiresAt : null, Math.max(createdAt, Math.min(f.now, expiresAt)));
  return { orderId, payload, id, plan, mode, amount, priceId, createdAt, expiresAt };
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
    .run(contractId, order.id, order.plan, order.priceId, order.orderId, order.payload,
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


import {createCabinetCustomerContext} from '../src/v1.4.1/trusted-context.mjs';
import {createRuntimeAuthorizer,projectRuntimeAccessAuthority} from '../src/v1.4.1/runtime-authorizer.mjs';
import {authorizeOwnerSubscriptionPaymentReview} from '../src/v1.4.3/subscription-action-authority.mjs';
import {resolveRetainedStarsPaymentReview} from '../src/v1.4.3/subscription-review-runtime.mjs';

async function owner(f){
  f.now=Math.max(f.now,Math.floor(Date.now()/1000));
  const candidate='d'.repeat(40),revision=32;
  f.sqlite.prepare("INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,updated_at) VALUES(1,?,?,'closed',0,?)").run(candidate,revision,f.now);
  const env={...f.env,V141_RELEASE_MODE:'owner_only',V141_AUTHORIZATION_ENABLED:'true',V141_ADMIN_MINI_APP_ENABLED:'true',
    REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',REBUILD_V140_OWNER_WINDOW:'false',
    REBUILD_V140_RC_SHA:candidate,REBUILD_V140_RELEASE_REVISION:String(revision),REBUILD_V140_WRITES_ENABLED:'true'};
  const opened=await f.call(900,'session',{method:'POST',token:null,payload:{initData:signedInitData(900,f.now)},customEnv:env});
  assert.equal(opened.status,200,JSON.stringify(opened.data));
  return async(ledgerEntryId,action='apply',key='owner_review_exact_'+next(),reasonCode='payment_support_review')=>{
    const context=await createCabinetCustomerContext({binding:f.binding,env,sessionToken:opened.data.sessionToken,
      sessionScope:{candidateSha:candidate,revision},channel:'mini_app',operation:'admin.cabinet.open',
      requestPayload:{subscriptionReviewAction:action,ledgerEntryId,reasonCode},idempotencyKey:key,nowSeconds:f.now});
    const authorization=await createRuntimeAuthorizer().authorize(context,{kind:'admin_surface',key:'cabinet'});
    return {authorization,token:await authorizeOwnerSubscriptionPaymentReview(authorization)};
  };
}
function transaction(order,charge,direction='incoming',patch={}){
  return {id:charge,date:Math.floor(Date.now()/1000),amount:direction==='incoming'?order.amount:-order.amount,
    [direction==='incoming'?'source':'receiver']:{type:'user',transaction_type:'invoice_payment',
      user:{id:order.id,is_bot:false},invoice_payload:order.payload,...(order.mode==='recurring'?{subscription_period:MONTH}:{})},...patch};
}
async function reconcile(f,rows,options={}){
  return reconcileStarsTransactions(f.env,{initiatedBy:900,startedAt:f.now,...options},{telegramApi:async(_env,method)=>{
    assert.equal(method,'getStarTransactions');return {transactions:rows};}});
}
async function retained(f,{mode='prepaid',firstRetained=false,expiration}={}){
  const order=mode==='recurring'?await recurring(f):await seedOrder(f);
  if(mode==='prepaid'){
    await precheckout(f,order,{at:f.now-20});
    f.sqlite.prepare("UPDATE subscription_orders SET order_state='cancelled',closed_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=?")
      .run(f.now-1,f.now-1,order.orderId);
  }else if(firstRetained){
    f.sqlite.prepare("UPDATE subscription_orders SET order_state='cancelled',closed_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=?").run(f.now-1,f.now-1,order.orderId);
  }else{
    await recordAndApply(f,successful(order,{expiration:f.now+300,first:true}));
  }
  await seedOrder(f,{state:'created'});
  f.sqlite.prepare("UPDATE users SET is_blocked=1 WHERE telegram_id=?").run(order.id);
  const update=successful(order,{expiration:expiration??(firstRetained?f.now+500:f.now+MONTH+300),first:firstRetained});
  const recorded=await recordStarsSuccessfulPayment(f.env,update,{receivedAt:f.now});
  assert.equal(recorded.status,'manual_review');
  f.sqlite.prepare("UPDATE users SET is_blocked=0 WHERE telegram_id=?").run(order.id);
  return {order,update,recorded};
}

test('an unclassified outgoing observation stays review, without invented chargeback or cash',async t=>{
  const f=fixture(t),order=await seedOrder(f),charge='unknown-outgoing-'+next();
  const result=await reconcile(f,[transaction(order,charge,'outgoing')]);
  assert.equal(result.status,'manual_review');assert.equal(count(f,'payment_ledger'),0);
  assert.equal(f.sqlite.prepare("SELECT direction FROM subscription_payment_links").get().direction,'outgoing');
  assert.equal(f.sqlite.prepare("SELECT decision FROM payment_review_resolutions").get().decision,'review_required');
});
test('known outgoing without a bound local refund preserves paid access and creates durable review',async t=>{
  const f=fixture(t),order=await seedOrder(f,{state:'precheckout_ok'}),charge='outgoing-review-'+next();
  const paid=await recordAndApply(f,successful(order,{charge}));
  const before=projection(f),result=await reconcile(f,[transaction(order,charge,'incoming'),transaction(order,charge,'outgoing')]);
  assert.equal(result.status,'manual_review');assert.deepEqual(projection(f),before);
  assert.equal(count(f,'payment_ledger'),1);assert.equal(grantFor(f,paid.recorded.orderId).status,'active');
  assert.equal(f.sqlite.prepare("SELECT reason_code FROM payment_reconciliation_items WHERE transaction_direction='outgoing'").get().reason_code,'outgoing_financial_type_unverified');
});
test('a direction-specific bound refund is reconciled once even with shared transaction IDs and replay',async t=>{
  const f=fixture(t),order=await seedOrder(f,{state:'precheckout_ok'}),charge='shared-id-'+next();
  const paid=await recordAndApply(f,successful(order,{charge}));
  f.sqlite.prepare(`INSERT INTO payment_refunds(refund_id,idempotency_key,order_id,original_ledger_entry_id,telegram_id,
    telegram_payment_charge_id,currency,amount_stars,reason_code,requested_by_type,requested_by,status,requested_at,updated_at)
    VALUES(?,?,?,?,?,?,'XTR',?,'payment_support_review','admin',900,'manual_review',?,?)`)
    .run(crypto.randomUUID(),'refund-request:'+sha256(charge),order.orderId,paid.recorded.ledgerEntryId,order.id,charge,order.amount,f.now,f.now);
  const rows=[transaction(order,charge),transaction(order,charge,'outgoing'),transaction(order,charge,'outgoing')];
  const result=await reconcile(f,rows);assert.equal(result.transactionsMatched,2);assert.equal(result.status,'completed');
  assert.equal(count(f,'payment_ledger'),2);assert.equal(count(f,'payment_review_resolutions'),1);
  assert.equal((await reconcile(f,rows)).status,'completed');assert.equal(count(f,'payment_ledger'),2);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM payment_ledger WHERE entry_type='chargeback'").get().n,0);
});
test('recurring history without exact expiration never fabricates a paid interval',async t=>{
  const f=fixture(t),order=await recurring(f),result=await reconcile(f,[transaction(order,'missing-recurring-'+next())]);
  assert.equal(result.status,'manual_review');assert.equal(count(f,'payment_ledger'),0);assert.equal(count(f,'subscription_access_grants'),0);
  assert.equal(f.sqlite.prepare('SELECT reason_code FROM payment_reconciliation_items').get().reason_code,'recurring_provider_period_evidence_missing');
});
test('renewal-before-first cash remains review and does not abort the page scan',async t=>{
  const f=fixture(t),order=await recurring(f),charge='pending-renewal-'+next();
  const paid=await recordStarsSuccessfulPayment(f.env,successful(order,{charge,expiration:f.now+MONTH,first:false}),{receivedAt:f.now});
  assert.equal(paid.status,'recorded');
  const result=await reconcile(f,[transaction(order,charge)]);assert.equal(result.status,'manual_review');
  assert.equal(count(f,'payment_ledger'),1);assert.equal(count(f,'subscription_access_grants'),0);
  assert.equal(f.sqlite.prepare('SELECT reason_code FROM payment_reconciliation_items').get().reason_code,'recurring_first_payment_unverified');
});
test('a later page failure preserves prior durable evidence and a usable restart offset',async t=>{
  const f=fixture(t),order=await seedOrder(f),charge='page-review-'+next();let calls=0;
  await assert.rejects(reconcileStarsTransactions(f.env,{initiatedBy:900,startedAt:f.now,pageLimit:1,maxPages:2},{telegramApi:async()=>{
    if(++calls===1)return {transactions:[transaction(order,charge,'outgoing')]};throw Object.assign(new Error('offline'),{code:'offline_page_failed'});
  }}));
  const row=f.sqlite.prepare('SELECT status,offset_end,transactions_seen FROM payment_reconciliation_runs').get();
  assert.deepEqual({...row},{status:'failed',offset_end:1,transactions_seen:1});assert.equal(count(f,'payment_reconciliation_items'),1);
});
test('malformed amount/date is represented honestly by the run, without invented financial fields',async t=>{
  const f=fixture(t),result=await reconcile(f,[{id:'invalid-'+next(),source:{type:'user'},amount:0}]);
  assert.equal(result.status,'manual_review');assert.equal(result.complete,false);assert.equal(count(f,'payment_reconciliation_items'),0);
  assert.equal(f.sqlite.prepare('SELECT error_code FROM payment_reconciliation_runs').get().error_code,'transaction_evidence_malformed');
});
test('owner retained prepaid apply reuses the immutable credit and has durable idempotency',async t=>{
  const f=fixture(t),{order,recorded,update}=await retained(f),mint=await owner(f),key='review_apply_same_key_'+next();
  const {token,authorization}=await mint(recorded.ledgerEntryId,'apply',key);
  await assert.rejects(resolveRetainedStarsPaymentReview(authorization),{code:'untrusted_subscription_review'});
  await assert.rejects(resolveRetainedStarsPaymentReview({...token}),{code:'untrusted_subscription_review'});
  const before=f.sqlite.prepare('SELECT * FROM payment_ledger WHERE ledger_entry_id=?').get(recorded.ledgerEntryId);
  const result=await resolveRetainedStarsPaymentReview(token);assert.equal(result.accessApplied,true);
  const replay=structuredClone(update);replay.update_id=next();
  const acknowledged=await recordStarsSuccessfulPayment(f.env,replay,{receivedAt:f.now});
  assert.equal(acknowledged.status,'duplicate');assert.equal(acknowledged.ownerReviewSettled,true);
  assert.equal(acknowledged.accessApplied,true);assert.equal(acknowledged.ledgerEntryId,recorded.ledgerEntryId);
  assert.notEqual(acknowledged.orderId,order.orderId);
  const commerceReplay=structuredClone(update);commerceReplay.update_id=next();
  const commerce=await handleStarsCommerceUpdate(f.env,commerceReplay,{nowSeconds:f.now,
    telegramApi:async()=>({message_id:next()})});
  assert.equal(commerce.status,'duplicate');assert.equal(commerce.accessApplied,true);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM payment_ledger WHERE ledger_entry_id=?').get(recorded.ledgerEntryId),before);
  assert.equal(count(f,'payment_ledger'),1);assert.equal(count(f,'subscription_payment_review_settlements'),1);
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(order.orderId).order_state,'cancelled');
  assert.equal((await resolveRetainedStarsPaymentReview((await mint(recorded.ledgerEntryId,'apply',key)).token)).status,'duplicate');
  await assert.rejects(resolveRetainedStarsPaymentReview((await mint(recorded.ledgerEntryId,'refund',key)).token),{code:'review_idempotency_conflict'});
  assert.equal(count(f,'subscription_access_grants'),1);assert.equal(count(f,'mini_app_atomic_guards'),0);
});
test('owner retained recurring apply uses its real provider period and one cash ledger',async t=>{
  const f=fixture(t),{recorded,update}=await retained(f,{mode:'recurring'}),mint=await owner(f);
  const before=count(f,'payment_ledger');await resolveRetainedStarsPaymentReview((await mint(recorded.ledgerEntryId)).token);
  const grant=f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(recorded.ledgerEntryId);
  assert.equal(grant.ends_at,update.message.successful_payment.subscription_expiration_date);
  assert.equal(grant.starts_at,grant.ends_at-MONTH);assert.equal(count(f,'payment_ledger'),before);
});
test('owner or subject policy races roll back retained apply completely',async t=>{
  for(const race of ['owner','subject']){
    const f=fixture(t),{recorded}=await retained(f),mint=await owner(f),token=(await mint(recorded.ledgerEntryId)).token;
    f.binding.beforeBatch=({sqlite})=>sqlite.exec(race==='owner'?"UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'":"UPDATE users SET is_blocked=1 WHERE telegram_id=101");
    await assert.rejects(resolveRetainedStarsPaymentReview(token));assert.equal(count(f,'subscription_access_grants'),0);
    assert.equal(count(f,'subscription_payment_review_settlements'),0);assert.equal(count(f,'payment_ledger'),1);assert.equal(count(f,'mini_app_atomic_guards'),0);
  }
});
test('unknown retained refund result is durable and is never retried after restart',async t=>{
  const f=fixture(t),{recorded}=await retained(f),mint=await owner(f);let calls=0;
  const first=await resolveRetainedStarsPaymentReview((await mint(recorded.ledgerEntryId,'refund')).token,{telegramApi:async()=>{calls++;throw Object.assign(new Error('offline'),{code:'network_unknown'});}});
  assert.equal(first.status,'manual_review');assert.equal(first.refunded,false);
  const retry=await resolveRetainedStarsPaymentReview((await mint(recorded.ledgerEntryId,'refund')).token,{telegramApi:async()=>{calls++;return true;}});
  assert.equal(retry.refunded,false);assert.equal(calls,1);assert.equal(count(f,'payment_ledger'),1);
});
test('true retained refund changes only its credit; refund after settlement targets the child grant',async t=>{
  for(const apply of [false,true]){
    const f=fixture(t),{order,recorded,update}=await retained(f),mint=await owner(f);
    if(apply)await resolveRetainedStarsPaymentReview((await mint(recorded.ledgerEntryId)).token);
    let calls=0;const result=await resolveRetainedStarsPaymentReview((await mint(recorded.ledgerEntryId,'refund')).token,{telegramApi:async(_env,method)=>{assert.equal(method,'refundStarPayment');calls++;return true;}});
    assert.equal(result.refunded,true);assert.equal(calls,1);assert.equal(count(f,'payment_ledger'),2);
    const replay=structuredClone(update);replay.update_id=next();
    const paymentAgain=await recordStarsSuccessfulPayment(f.env,replay,{receivedAt:f.now});
    assert.equal(paymentAgain.accessApplied,false);assert.equal(paymentAgain.status,'manual_review');
    assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(order.orderId).order_state,'cancelled');
    if(apply){const s=f.sqlite.prepare('SELECT applied_order_id FROM subscription_payment_review_settlements').get();
      assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(s.applied_order_id).order_state,'refunded');
      assert.equal(f.sqlite.prepare('SELECT status FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(recorded.ledgerEntryId).status,'refunded');}
    assert.equal((await resolveRetainedStarsPaymentReview((await mint(recorded.ledgerEntryId,'refund')).token,{telegramApi:async()=>{calls++;return true;}})).status,'duplicate');assert.equal(calls,1);
  }
  // The logical test clock does not advance between genuine provider-period
  // activation and confirmed refund. An empty refunded state needs no invented
  // extra second; ledger/history retain the actual same accounting clock.
  const sameSecond=Math.floor(Date.now()/1000);
  t.mock.method(Date,'now',()=>sameSecond*1000);
  const f=fixture(t),{recorded}=await retained(f,{mode:'recurring',firstRetained:true,expiration:sameSecond+MONTH}),mint=await owner(f);
  await resolveRetainedStarsPaymentReview((await mint(recorded.ledgerEntryId)).token);
  const result=await resolveRetainedStarsPaymentReview((await mint(recorded.ledgerEntryId,'refund')).token,{telegramApi:async()=>true});
  assert.equal(result.refunded,true);
  const state=f.sqlite.prepare('SELECT access_state,state_started_at,state_ends_at FROM user_access_states WHERE telegram_id=101').get();
  assert.equal(state.access_state,'refunded');assert.equal(state.state_started_at,sqlTime(sameSecond));assert.equal(state.state_ends_at,null);
  assert.equal(f.sqlite.prepare("SELECT occurred_at FROM payment_ledger WHERE entry_type='refund'").get().occurred_at,sameSecond);
  assert.equal(f.sqlite.prepare("SELECT occurred_at FROM access_status_history WHERE source_code='stars_refund'").get().occurred_at,sameSecond);
  assert.equal(count(f,'payment_ledger'),2);assert.equal(f.sqlite.prepare('SELECT plan_code FROM user_plans WHERE telegram_id=101').get().plan_code,'free');
});

test('an authentic retained first recurring payment settles its true first marker and own computed authority',async t=>{
  const f=fixture(t),{recorded,order}=await retained(f,{mode:'recurring',firstRetained:true}),mint=await owner(f);
  await resolveRetainedStarsPaymentReview((await mint(recorded.ledgerEntryId)).token);
  assert.equal(f.sqlite.prepare('SELECT first_payment_ledger_entry_id FROM subscription_billing_contracts WHERE contract_id=?').get(order.contractId).first_payment_ledger_entry_id,recorded.ledgerEntryId);
  assert.equal(count(f,'subscription_first_recurring_receipts'),1);assert.equal(count(f,'payment_ledger'),1);
  const context=await f.context(101,'access.read_own','mini_app',{env:{...f.env,STARS_ROLLOUT_MODE:'allowlist',STARS_ROLLOUT_ALLOWLIST:'101'}});
  const view=projectRuntimeAccessAuthority(await createRuntimeAuthorizer().authorize(context));
  assert.equal(view.planCode,'dragon');assert.equal(view.accessState,'active');assert.equal(view.lifecycle.paidUntil,f.sqlite.prepare('SELECT provider_period_end FROM subscription_payment_review_receipts WHERE ledger_entry_id=?').get(recorded.ledgerEntryId).provider_period_end);
});
test('a mismatching outgoing payload never settles a refund of another invoice',async t=>{
  const f=fixture(t),order=await seedOrder(f,{state:'precheckout_ok'}),charge='payload-out-'+next();
  const paid=await recordAndApply(f,successful(order,{charge}));
  f.sqlite.prepare(`INSERT INTO payment_refunds(refund_id,idempotency_key,order_id,original_ledger_entry_id,telegram_id,
    telegram_payment_charge_id,currency,amount_stars,reason_code,requested_by_type,requested_by,status,requested_at,updated_at)
    VALUES(?,?,?,?,?,?,'XTR',?,'payment_support_review','admin',900,'manual_review',?,?)`)
    .run(crypto.randomUUID(),'refund-request:'+sha256(charge),order.orderId,paid.recorded.ledgerEntryId,order.id,charge,order.amount,f.now,f.now);
  const outgoing=transaction(order,charge,'outgoing');outgoing.receiver.invoice_payload='foreign_invoice_payload';
  assert.equal((await reconcile(f,[transaction(order,charge),outgoing])).status,'manual_review');
  assert.equal(count(f,'payment_ledger'),1);assert.equal(grantFor(f,order.orderId).status,'active');
});
test('conflicting duplicates are retained as discrepancies instead of processing twice',async t=>{
  const f=fixture(t),order=await seedOrder(f),charge='duplicate-conflict-'+next(),a=transaction(order,charge,'outgoing'),b=structuredClone(a);b.amount--;
  const result=await reconcile(f,[a,b]);assert.equal(result.status,'manual_review');assert.equal(count(f,'payment_reconciliation_items'),2);
  assert.equal(count(f,'payment_ledger'),0);assert.equal(count(f,'subscription_payment_links'),1);
});
test('an empty remote page cannot create an unbounded local missing-entry scan',async t=>{
  const f=fixture(t),order=await seedOrder(f,{state:'precheckout_ok'});
  const insert=f.sqlite.prepare(`INSERT INTO payment_ledger(ledger_entry_id,idempotency_key,order_id,telegram_id,entry_type,
    direction,currency,amount_stars,telegram_payment_charge_id,reason_code,occurred_at,recorded_at)
    VALUES(?,?,?,?,'payment','credit','XTR',?,?,'offline_verified_payment',?,?)`);
  for(let i=0;i<2001;i++)insert.run(crypto.randomUUID(),'payment:local-overflow-'+i,order.orderId,order.id,order.amount,'local-overflow-'+i,f.now,f.now);
  const result=await reconcile(f,[]);assert.equal(result.complete,false);assert.equal(result.missingTelegram,2000);
  assert.equal(result.status,'manual_review');assert.equal(count(f,'payment_reconciliation_items'),2000);
  assert.equal(f.sqlite.prepare('SELECT error_code FROM payment_reconciliation_runs').get().error_code,'local_journal_scan_truncated');
});

test('fractional Stars cannot match or refund an integral invoice credit',async t=>{
  const f=fixture(t),order=await seedOrder(f,{state:'precheckout_ok'}),charge='fractional-out-'+next();
  await recordAndApply(f,successful(order,{charge}));
  const outgoing=transaction(order,charge,'outgoing',{nanostar_amount:500000000});
  const result=await reconcile(f,[transaction(order,charge),outgoing]);
  assert.equal(result.status,'manual_review');assert.equal(result.complete,false);assert.equal(count(f,'payment_ledger'),1);
  assert.equal(count(f,'payment_reconciliation_items'),1);assert.equal(grantFor(f,order.orderId).status,'active');
});
test('late prepaid transaction cash is retained against the terminal origin for owner settlement',async t=>{
  const f=fixture(t),order=await seedOrder(f,{state:'cancelled',expiresAt:f.now-1}),charge='recovered-late-'+next();
  const result=await reconcile(f,[transaction(order,charge)]);assert.equal(result.status,'manual_review');
  assert.equal(count(f,'payment_ledger'),1);assert.equal(count(f,'subscription_access_grants'),0);assert.equal(count(f,'subscription_payment_review_receipts'),1);
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(order.orderId).order_state,'cancelled');
  const ledger=f.sqlite.prepare('SELECT ledger_entry_id FROM payment_ledger').get().ledger_entry_id,mint=await owner(f);
  await resolveRetainedStarsPaymentReview((await mint(ledger)).token);assert.equal(count(f,'payment_ledger'),1);assert.equal(count(f,'subscription_access_grants'),1);
});
test('a failed local coverage read never produces a complete successful reconciliation',async t=>{
  const f=fixture(t),prepare=f.binding.prepare.bind(f.binding);
  f.binding.prepare=sql=>{
    const statement=prepare(sql);if(!sql.includes('ORDER BY occurred_at, ledger_entry_id LIMIT 2001'))return statement;
    return {all:async()=>({success:false,results:[]})};
  };
  await assert.rejects(reconcile(f,[]),{code:'reconciliation_local_read_failed'});
  assert.equal(f.sqlite.prepare('SELECT status FROM payment_reconciliation_runs').get().status,'failed');
});
test('an unpersisted page progress is rejected before another provider page is requested',async t=>{
  const f=fixture(t),order=await seedOrder(f),prepare=f.binding.prepare.bind(f.binding);let calls=0;
  f.binding.prepare=sql=>{
    const statement=prepare(sql);if(!sql.includes('SET offset_end=?'))return statement;
    return {bind:()=>({run:async()=>({success:true,meta:{changes:0}})})};
  };
  await assert.rejects(reconcileStarsTransactions(f.env,{initiatedBy:900,startedAt:f.now,pageLimit:1,maxPages:2},{telegramApi:async()=>{
    calls++;return {transactions:[transaction(order,'progress-failure-'+next(),'outgoing')]};
  }}),{code:'reconciliation_progress_not_persisted'});
  assert.equal(calls,1);assert.equal(f.sqlite.prepare('SELECT status FROM payment_reconciliation_runs').get().status,'failed');
});
test('a confirmed refund whose accounting failed recovers without another provider request',async t=>{
  const f=fixture(t),{recorded}=await retained(f),mint=await owner(f);let calls=0;
  f.binding.failStatement=sql=>sql.includes('INSERT INTO payment_ledger')&&sql.includes("'debit'");
  await assert.rejects(resolveRetainedStarsPaymentReview((await mint(recorded.ledgerEntryId,'refund')).token,{telegramApi:async()=>{calls++;return true;}}));
  assert.equal(f.sqlite.prepare('SELECT status FROM payment_refunds').get().status,'confirmed');assert.equal(count(f,'payment_ledger'),1);
  const result=await resolveRetainedStarsPaymentReview((await mint(recorded.ledgerEntryId,'refund')).token,{telegramApi:async()=>{calls++;return true;}});
  assert.equal(result.refunded,true);assert.equal(calls,1);assert.equal(count(f,'payment_ledger'),2);
});

test('a credit already reversed by genuine chargeback cannot trigger another refund attempt',async t=>{
  const f=fixture(t),{recorded,update}=await retained(f),mint=await owner(f);let calls=0;
  await applyStarsCompensation(f.env,{telegramPaymentChargeId:update.message.successful_payment.telegram_payment_charge_id,
    compensationType:'chargeback',occurredAt:f.now,reasonCode:'confirmed_dispute_review'});
  await assert.rejects(resolveRetainedStarsPaymentReview((await mint(recorded.ledgerEntryId,'refund')).token,{telegramApi:async()=>{calls++;return true;}}),{code:'review_compensation_conflict'});
  assert.equal(calls,0);assert.equal(count(f,'payment_ledger'),2);assert.equal(count(f,'payment_refunds'),0);
});
