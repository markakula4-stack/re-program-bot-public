import './helpers/v1.4.3-p05-offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,seedOrder,recurring,successful,recordAndApply,MONTH} from './helpers/audit-paid-access-fixture.mjs';
import {expireStarsPaidAccess,applyStarsPaidAccess,applyStarsCompensation} from '../src/v1.3.6/stars-access-runtime.mjs';
import {recordStarsSuccessfulPayment} from '../src/v1.3.6/stars-payment-runtime.mjs';
import {createAuthorityResolver,compileAuthorityAssertions} from '../src/v1.4.1/authority-resolver.mjs';

function setup(t) {const f=fixture(t);f.serverEnv=f.env;return f;}
async function paid(f,mode='prepaid') {
  if(mode==='recurring') f.env.STARS_TERMS_REVISION=f.sqlite.prepare(
    "SELECT terms_revision FROM price_book WHERE price_id='dragon-30d-recurring-v1'").get().terms_revision;
  const order=mode==='recurring'?await recurring(f,{createdAt:f.now-60}):await seedOrder(f,{state:'precheckout_ok'});
  const payment=await recordAndApply(f,successful(order,mode==='recurring'?{expiration:f.now+MONTH}:{}));
  return {order,...payment};
}
function state(f) {return f.sqlite.prepare(`SELECT s.status,s.current_period_end,s.revision,
  p.plan_code,p.source_code,p.revision AS plan_revision,a.access_state,a.revision AS access_revision
  FROM subscriptions s JOIN user_plans p USING(telegram_id) JOIN user_access_states a USING(telegram_id)
  WHERE s.telegram_id=101 ORDER BY s.current_period_end DESC LIMIT 1`).get();}
function histories(f) {return {
  subscription:f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_status_history').get().n,
  access:f.sqlite.prepare('SELECT COUNT(*) AS n FROM access_status_history').get().n,
};}
async function resolve(f) {return createAuthorityResolver().resolveActor(await f.context(101,'access.read_own'));}

test('due expiry updates every projection exactly once; future and duplicate expiry do nothing',async t=>{
  const f=setup(t);await paid(f);const before=state(f),counts=histories(f);
  assert.equal((await expireStarsPaidAccess(f.env,{telegramId:101,at:before.current_period_end-1})).reason,'not_due');
  assert.deepEqual(state(f),before);assert.deepEqual(histories(f),counts);
  const result=await expireStarsPaidAccess(f.env,{telegramId:101,at:before.current_period_end});
  assert.equal(result.changed,true);assert.equal(result.reason,'expired');
  const expired=state(f);assert.equal(expired.status,'expired');assert.equal(expired.plan_code,'free');
  assert.equal(expired.access_state,'expired');assert.equal(expired.revision,before.revision+1);
  assert.equal(expired.plan_revision,before.plan_revision+1);assert.equal(expired.access_revision,before.access_revision+1);
  assert.deepEqual(histories(f),{subscription:counts.subscription+1,access:counts.access+1});
  assert.equal((await expireStarsPaidAccess(f.env,{telegramId:101,at:before.current_period_end})).changed,false);
  assert.deepEqual(state(f),expired);assert.deepEqual(histories(f),{subscription:counts.subscription+1,access:counts.access+1});
});

test('a prepaid renewal winning the commit race makes stale expiry a complete no-op',async t=>{
  const f=setup(t);await paid(f);const end=state(f).current_period_end;
  f.now=end-1;
  const order=await seedOrder(f,{state:'precheckout_ok',createdAt:end-60,expiresAt:end+600});
  const recorded=await recordStarsSuccessfulPayment(f.env,successful(order),{receivedAt:end-1});
  let preparedRenewal,preparedExpiry,releaseRenewal,releaseExpiry;
  const renewalReady=new Promise(r=>preparedRenewal=r),expiryReady=new Promise(r=>preparedExpiry=r);
  const renewalGate=new Promise(r=>releaseRenewal=r),expiryGate=new Promise(r=>releaseExpiry=r);
  const base=f.binding.batch.bind(f.binding);
  f.binding.batch=async statements=>{
    if(statements.some(s=>s.sql.includes("SET status = 'expired'")&&s.sql.includes('WHERE subscription_id = ? AND revision = ?'))){preparedExpiry();await expiryGate;}
    else if(statements.some(s=>s.sql.includes("SET status = 'active', current_period_end = ?"))){preparedRenewal();await renewalGate;}
    return base(statements);
  };
  const renewing=applyStarsPaidAccess(f.env,{orderId:recorded.orderId,appliedAt:end-1});
  await renewalReady;
  const expiring=expireStarsPaidAccess(f.env,{telegramId:101,at:end});
  await expiryReady;releaseRenewal();assert.equal((await renewing).accessApplied,true);
  const renewed=state(f),counts=histories(f);releaseExpiry();const result=await expiring;
  assert.equal(result.changed,false);assert.equal(result.reason,'stale');
  assert.deepEqual(state(f),renewed);assert.deepEqual(histories(f),counts);
  assert.equal(renewed.status,'active');assert.equal(renewed.current_period_end,end+MONTH);
  assert.equal(renewed.plan_code,'dragon');assert.equal(renewed.access_state,'active');
  f.now=end;const access=(await resolve(f)).access;
  assert.equal(access.effectivePlan,'dragon');assert.equal(access.status,'verified');
});

test('failure after claiming expiry rolls back the claim, all projections and all history',async t=>{
  const f=setup(t);await paid(f);const before=state(f),counts=histories(f);
  f.binding.failStatement=sql=>sql.startsWith('UPDATE user_access_states');
  await assert.rejects(expireStarsPaidAccess(f.env,{telegramId:101,at:before.current_period_end}),/injected SQL failure/);
  assert.deepEqual(state(f),before);assert.deepEqual(histories(f),counts);
  assert.equal((await expireStarsPaidAccess(f.env,{telegramId:101,at:before.current_period_end})).changed,true);
});

function abandoned(f,original,count,{state='cancelled',expired=true}={}) {
  const row=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(original.orderId);
  const insert=f.sqlite.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,
    currency,amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,expires_at,
    closed_at,updated_at) VALUES(?,101,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ids=[];
  for(let i=0;i<count;i++) {
    const id=crypto.randomUUID(),created=f.now-60,expires=expired?f.now-30:f.now+300;
    insert.run(id,row.price_id,row.price_version,row.plan_code,'XTR',row.amount_stars,row.access_seconds,
      row.billing_mode,row.terms_revision,'offline-unused-'+id,state,created,expires,
      ['cancelled','failed'].includes(state)?f.now-20:null,f.now-20);ids.push(id);
  }
  return ids;
}

test('128,129 and 1001 total orders including abandoned invoices retain genuine paid authority',async t=>{
  const f=setup(t),p=await paid(f,'recurring');
  for(const n of [127,1,872]) {
    abandoned(f,p.order,n);
    const a=await resolve(f);assert.equal(a.access.effectivePlan,'dragon');assert.equal(a.access.status,'verified');
    assert.equal(a.financialSourceAvailable,true);assert.deepEqual(a.degradedTables,[]);
  }
  // The schema permits at most one open invoice, even after its deadline.
  abandoned(f,p.order,1,{state:'created'});abandoned(f,p.order,150,{state:'failed'});
  assert.equal((await resolve(f)).access.effectivePlan,'dragon');
});

test('abandoned history never grants a Free account paid authority',async t=>{
  const f=setup(t),order=await seedOrder(f,{state:'cancelled'});
  abandoned(f,order,150);const a=await resolve(f);
  assert.equal(a.access.effectivePlan,'free');assert.equal(a.financialSourceAvailable,true);
});

test('abandoned rows do not invalidate financial proofs, but a newly live invoice does',async t=>{
  const f=setup(t),p=await paid(f);
  const proof=compileAuthorityAssertions(await resolve(f));
  const orderPieces=proof.assertions.filter(piece=>piece.sql.includes('FROM subscription_orders WHERE')&&piece.sql.includes('expires_at>?'));
  assert.equal(orderPieces.length,2);
  const valid=()=>orderPieces.every(piece=>f.sqlite.prepare(`SELECT (${piece.sql}) AS ok`).get(...piece.params).ok===1);
  assert.equal(valid(),true);abandoned(f,p.order,150);assert.equal(valid(),true);
  await seedOrder(f,{state:'precheckout_ok'});assert.equal(valid(),false);
});

test('financial-looking evidence overflow still fails closed instead of silently truncating paid claims',async t=>{
  const f=setup(t),p=await paid(f,'recurring');
  const insert=f.sqlite.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,
    currency,amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,expires_at,
    paid_at,applied_at,closed_at,updated_at)
    SELECT ?,telegram_id,price_id,price_version,plan_code,currency,amount_stars,access_seconds,billing_mode,
    terms_revision,?,'applied',created_at,expires_at,paid_at,applied_at,closed_at,updated_at
    FROM subscription_orders WHERE order_id=?`);
  for(let i=0;i<128;i++){const id=crypto.randomUUID();insert.run(id,'offline-unbacked-'+id,p.order.orderId);}
  const a=await resolve(f);assert.equal(a.access.effectivePlan,'free');
  assert.equal(a.financialSourceAvailable,false);
  assert.ok(a.degradedTables.some(r=>r.table==='subscription_orders'&&r.code==='authority_source_overflow'));
});

test('a refunded paid source remains captured among hundreds of abandoned orders and cannot grant access',async t=>{
  const f=setup(t),p=await paid(f);abandoned(f,p.order,150);
  const payment=f.sqlite.prepare("SELECT telegram_payment_charge_id FROM payment_ledger WHERE entry_type='payment'").get();
  await applyStarsCompensation(f.env,{telegramPaymentChargeId:payment.telegram_payment_charge_id,
    compensationType:'refund',reasonCode:'audit_test_refund',occurredAt:f.now+1});
  f.now+=1;const a=await resolve(f);assert.equal(a.access.effectivePlan,'free');
  assert.equal(a.financialSourceAvailable,true);assert.deepEqual(a.degradedTables,[]);
});
