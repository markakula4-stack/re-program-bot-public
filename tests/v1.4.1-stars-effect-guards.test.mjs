import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { createCustomerContext } from '../src/v1.4.1/trusted-context.mjs';
import { authorizeTelegramHandler } from '../src/v1.4.1/telegram-runtime.mjs';
import { prepareLegacyCompatibility, bindLegacyCompatibilityEnv,
  bindConfirmedStarsRefundAccountingEnv } from '../src/v1.4.1/telegram-legacy-compatibility.mjs';
import { acceptStarsPurchaseTerms, issueStarsPurchase,
  handleStarsCommerceUpdate } from '../src/v1.3.6/stars-commerce-runtime.mjs';
import { requestStarsRefund, readConfirmedStarsRefundEvidence } from '../src/v1.3.6/stars-access-runtime.mjs';

let sequence=1_416_000;
const orderId='14160000-0000-4000-8000-000000000001';
const chargeId='fictional-p06-stars-charge';
const secret='fictional-p06-webhook-secret-for-tests';
async function setup(t) {
  const f=foundationFixture(t);
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0026-v1.3.6-stars-core-foundation.sql',import.meta.url),'utf8'));
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  f.serverEnv={...f.serverEnv,V141_AUTHORIZATION_ENABLED:'true',WEBHOOK_SECRET:secret,
    STARS_PAYMENTS_ENABLED:'true',STARS_REFUNDS_ENABLED:'true',STARS_ROLLOUT_MODE:'admin',
    STARS_BILLING_MODE:'prepaid',STARS_PRICE_VERSION:'1',STARS_TERMS_REVISION:'2026-09-10.stars-v1',
    STARS_INVOICE_SECRET:'fictional-p06-stars-secret-more-than-thirty-two-characters'};
  f.legacyEnv={...f.serverEnv,DB:f.binding,V141_AUTHORIZATION_ENABLED:'false'};
  await acceptStarsPurchaseTerms(f.legacyEnv,{telegramId:900,telegramUpdateId:++sequence,acceptedAt:f.now});
  return f;
}
async function guardedEnv(f,selector) {
  const updateId=++sequence,claim='fictional_p06_claim_'+updateId;
  const body={update_id:updateId,callback_query:{id:'fictional_p06_callback_'+updateId,
    from:{id:900,is_bot:false},message:{from:{id:123456789,is_bot:true},chat:{id:900,type:'private'}},data:selector}};
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,
    attempt_count,received_at,lease_expires_at) VALUES(?,'callback_query',900,'processing',?,1,?,?)`)
    .run(updateId,claim,f.now,f.now+300);
  const webhookRequest=new Request('https://bot.example/webhook',{method:'POST',
    headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(body)});
  const context=await createCustomerContext({binding:f.binding,env:f.serverEnv,webhookRequest,receiptClaimToken:claim,
    channel:'telegram_callback',operation:'account.menu.read',nowSeconds:f.now});
  const {authorization,handler}=await authorizeTelegramHandler(context,body);
  return bindLegacyCompatibilityEnv(await prepareLegacyCompatibility(authorization,{family:handler.capability}),
    {...f.serverEnv,DB:f.binding});
}
async function paidOrder(f) {
  let invoice;
  const telegramApi=async(_env,method,payload)=>{
    if(method==='sendInvoice'){invoice=payload;return {message_id:++sequence};}return true;
  };
  const issue=await issueStarsPurchase(f.legacyEnv,{telegramId:900,requestedPlanCode:'professional',
    telegramUpdateId:++sequence,orderId,createdAt:f.now},{telegramApi});
  const checkout=await handleStarsCommerceUpdate(f.legacyEnv,{update_id:++sequence,
    pre_checkout_query:{id:'fictional_checkout',from:{id:900,is_bot:false},currency:'XTR',
      total_amount:issue.amountStars,invoice_payload:invoice.payload}},{nowSeconds:f.now,telegramApi});
  assert.equal(checkout.approved,true);
  const payment=await handleStarsCommerceUpdate(f.legacyEnv,{update_id:++sequence,message:{date:f.now,
    from:{id:900,is_bot:false},chat:{id:900,type:'private'},successful_payment:{currency:'XTR',
      total_amount:issue.amountStars,invoice_payload:invoice.payload,telegram_payment_charge_id:chargeId,
      provider_payment_charge_id:'fictional-p06-provider-charge'}}},{nowSeconds:f.now,telegramApi});
  assert.equal(payment.accessApplied,true);
}
function blockAfterWrite(f,needle) {
  const batch=f.binding.batch.bind(f.binding);
  f.binding.batch=async statements=>{
    const result=await batch(statements);
    if(statements.some(statement=>statement.sql.includes(needle))) {
      f.binding.batch=batch;
      f.sqlite.exec('UPDATE users SET is_blocked=1 WHERE telegram_id=900');
    }
    return result;
  };
}

test('actual invoice creation cannot send Telegram after the canonical actor is blocked at its commit boundary',async t=>{
  const f=await setup(t),env=await guardedEnv(f,'stars_accept:professional');let calls=0;
  blockAfterWrite(f,'INSERT INTO subscription_orders');
  await assert.rejects(issueStarsPurchase(env,{telegramId:900,requestedPlanCode:'professional',
    telegramUpdateId:++sequence,orderId,createdAt:f.now},{telegramApi:async()=>{calls++;return true;}}));
  assert.equal(calls,0);
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(orderId).order_state,'created');
});

for(const phase of ['before_request','before_provider']) test(`actual exact-payment refund denies a blocked owner ${phase}`,async t=>{
  const f=await setup(t);await paidOrder(f);
  const env=await guardedEnv(f,'admin_stars_refund_confirm:'+orderId);let calls=0;
  if(phase==='before_request')f.sqlite.exec('UPDATE users SET is_blocked=1 WHERE telegram_id=900');
  else blockAfterWrite(f,'INSERT OR IGNORE INTO payment_refunds');
  await assert.rejects(requestStarsRefund(env,{adminTelegramId:900,telegramPaymentChargeId:chargeId,
    reasonCode:'admin_canary_validation',requestedAt:f.now},{telegramApi:async()=>{calls++;return true;}}));
  assert.equal(calls,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_ledger WHERE entry_type=\'refund\'').get().n,0);
  const rows=f.sqlite.prepare('SELECT status FROM payment_refunds').all().map(row=>({...row}));
  assert.deepEqual(rows,phase==='before_request'?[]:[{status:'requested'}]);
});

test('actual confirmed refund settles once after actor revocation, and copied evidence cannot open financial accounting',async t=>{
  const f=await setup(t);await paidOrder(f);
  const env=await guardedEnv(f,'admin_stars_refund_confirm:'+orderId);let calls=0;
  assert.equal(readConfirmedStarsRefundEvidence({}),null);
  assert.throws(()=>bindConfirmedStarsRefundAccountingEnv(env,{orderId,chargeId,telegramId:900}),/untrusted_refund_accounting/u);
  const telegramApi=async(_env,method,payload)=>{
    assert.equal(method,'refundStarPayment');assert.deepEqual(payload,{user_id:900,telegram_payment_charge_id:chargeId});
    calls++;f.sqlite.exec('UPDATE users SET is_blocked=1 WHERE telegram_id=900');return true;
  };
  const request={adminTelegramId:900,telegramPaymentChargeId:chargeId,reasonCode:'admin_canary_validation',requestedAt:f.now};
  const result=await requestStarsRefund(env,request,{telegramApi});
  assert.equal(result.refunded,true);assert.equal(result.status,'applied');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_ledger WHERE entry_type=\'refund\'').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(orderId).order_state,'refunded');
  assert.equal(f.sqlite.prepare('SELECT status FROM payment_refunds').get().status,'applied');
  assert.equal((await requestStarsRefund(env,request,{telegramApi})).status,'duplicate');assert.equal(calls,1);
});
