import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createCabinetHttp} from '../src/v1.4.0-rebuild/cabinet-http.mjs';
import {signedInitData} from './helpers/v1.4.1-fixtures.mjs';
import {authoritySeconds} from '../src/v1.4.1/authority-resolver.mjs';
import {createCustomerContext,createServiceExecutor} from '../src/v1.4.1/trusted-context.mjs';
import {createRuntimeAuthorizer} from '../src/v1.4.1/runtime-authorizer.mjs';
import {authorizeTelegramHandler} from '../src/v1.4.1/telegram-runtime.mjs';
import {prepareLegacyCompatibility,bindLegacyCompatibilityEnv} from '../src/v1.4.1/telegram-legacy-compatibility.mjs';
import {handleVerifiedTelegramSubscriptionUpdate} from '../src/v1.4.3/provider-subscription-events.mjs';
import {readSubscriptionData} from '../src/v1.4.2/subscription-read-model.mjs';
import {cabinetSubscriptionFixture,invoiceIntent,next,MONTH} from './helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import {requestStarsRefund,applyStarsPaidAccess} from '../src/v1.3.6/stars-access-runtime.mjs';
import {recordStarsSuccessfulPayment} from '../src/v1.3.6/stars-payment-runtime.mjs';
import {handleStarsPreCheckoutQuery} from '../src/v1.3.6/stars-payment-runtime.mjs';
import {callStarsTelegram} from '../src/v1.3.6/stars-payment-runtime.mjs';
import {issueStarsRecurringInvoice} from '../src/v1.4.3/telegram-subscription-provider.mjs';
import {resolveRetainedStarsPaymentReview} from '../src/v1.4.3/subscription-review-runtime.mjs';
import {cancelConfirmedRefundFutureRenewal,retireRefundedContractsForInvoice} from '../src/v1.4.3/refund-contract-lifecycle.mjs';
import {readSubscriptionCatalog} from '../src/v1.4.2/subscription-catalog.mjs';

function fixture(t){
  const f=cabinetSubscriptionFixture(t);
  f.sqlite.function('unixepoch',{deterministic:false,varargs:true},(...args)=>
    args.length===0||args[0]==='now'?Math.floor(Date.now()/1000):authoritySeconds(args[0]));
  for(const file of ['0069-v1.4.3-d1-compatibility.sql','0070-v1.4.3-refund-notification.sql',
    '0071-v1.4.3-refund-contract-retirement.sql']) f.sqlite.exec(fs.readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  return f;
}
const count=(f,table)=>f.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const contract=(f,id)=>f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(id);
const request=paid=>({adminTelegramId:900,telegramPaymentChargeId:paid.record.telegramPaymentChargeId||paid.update.message.successful_payment.telegram_payment_charge_id,
  reasonCode:'confirmed_customer_refund'});
const invoice=async f=>issueStarsRecurringInvoice(await f.auth({operation:'billing.purchase_monthly',payload:invoiceIntent}),
  {telegramApi:async()=> 'https://t.me/$newAfterRefund'});
const catalog=async f=>readSubscriptionCatalog({authorization:await f.auth()});
const state=async f=>readSubscriptionData({authorization:await f.auth()});

function capture(f,t){
  const directory=process.env.V143_REFUND_NATIVE_CAPTURE_DIR;if(!directory)return;
  fs.mkdirSync(directory,{recursive:true});
  const baseline=path.join(directory,'baseline.sqlite');fs.rmSync(baseline,{force:true});f.sqlite.prepare('VACUUM INTO ?').run(baseline);
  f.binding.audit.length=0;const push=f.binding.audit.push.bind(f.binding.audit);
  f.binding.audit.push=(...items)=>push(...items.map(item=>({...item,executedAtSec:Math.floor(Date.now()/1000)})));
  const batch=f.binding.batch.bind(f.binding);
  f.binding.batch=async statements=>{f.binding.audit.push({sql:'BEGIN IMMEDIATE',params:[],mode:'transaction'});
    try{const result=await batch(statements);f.binding.audit.push({sql:'COMMIT',params:[],mode:'transaction'});return result;}
    catch(error){f.binding.audit.push({sql:'ROLLBACK',params:[],mode:'transaction'});throw error;}};
  t.after(()=>fs.writeFileSync(path.join(directory,'trace.json'),JSON.stringify(f.binding.audit)));
}

async function activeObservation(f,paid){
  f.now=Math.max(f.now,Math.floor(Date.now()/1000));
  const secret='offline-refund-native-webhook-secret';f.serverEnv.WEBHOOK_SECRET=secret;
  const update={update_id:next(),subscription:{user:{id:101,is_bot:false},invoice_payload:paid.order.invoice_payload,state:'active'}},claim=crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,received_at,lease_expires_at)
    VALUES(?,'unsupported',101,'processing',?,?,?)`).run(update.update_id,claim,f.now,f.now+60);
  const executor=createServiceExecutor({binding:f.binding,env:f.serverEnv,purpose:'stars_process_event',clockSeconds:()=>f.now});
  await handleVerifiedTelegramSubscriptionUpdate({webhookRequest:new Request('https://bot.example/webhook',{method:'POST',
    headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(update)}),
    serviceContext:await executor.createContext(),receiptClaimToken:claim});
}
async function adminPaid(f){
  f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(900,'free','system_default')").run();
  f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(900,'none','system_default')").run();
  const invoice=await issueStarsRecurringInvoice(await f.auth({id:900,operation:'billing.purchase_monthly',payload:invoiceIntent}),
    {telegramApi:async()=> 'https://t.me/$legacySelfCanary'});
  const order=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(invoice.orderId);
  assert.equal((await handleStarsPreCheckoutQuery(f.serverEnv,{update_id:next(),pre_checkout_query:{id:'self-checkout-'+next(),
    from:{id:900,is_bot:false},currency:'XTR',total_amount:order.amount_stars,invoice_payload:order.invoice_payload}},
    {telegramApi:async()=>true})).approved,true);
  const update={update_id:next(),message:{message_id:next(),from:{id:900,is_bot:false},chat:{id:900,type:'private'},
    successful_payment:{currency:'XTR',total_amount:order.amount_stars,invoice_payload:order.invoice_payload,
      telegram_payment_charge_id:'self-canary-charge-'+next(),provider_payment_charge_id:'',is_recurring:true,
      is_first_recurring:true,subscription_expiration_date:Math.floor(Date.now()/1000)+MONTH}}};
  const record=await recordStarsSuccessfulPayment(f.serverEnv,update);await applyStarsPaidAccess(f.serverEnv,{orderId:record.orderId});
  return {invoice,order,record,update,contract:contract(f,invoice.contractId)};
}
async function legacyRefundEnv(f,paid){
  f.now=Math.max(f.now,Math.floor(Date.now()/1000));
  const secret='offline-refund-legacy-webhook-secret';
  f.serverEnv={...f.serverEnv,V141_AUTHORIZATION_ENABLED:'true',WEBHOOK_SECRET:secret};
  const updateId=next(),claim=crypto.randomUUID(),body={update_id:updateId,callback_query:{id:'refund-callback-'+next(),
    from:{id:900,is_bot:false},message:{from:{id:123456789,is_bot:true},chat:{id:900,type:'private'}},
    data:'admin_stars_refund_confirm:'+paid.record.orderId}};
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,
    attempt_count,received_at,lease_expires_at) VALUES(?,'callback_query',900,'processing',?,1,?,?)`).run(updateId,claim,f.now,f.now+300);
  const context=await createCustomerContext({binding:f.binding,env:f.serverEnv,
    webhookRequest:new Request('https://bot.example/webhook',{method:'POST',headers:{'Content-Type':'application/json',
      'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(body)}),receiptClaimToken:claim,
    channel:'telegram_callback',operation:'account.menu.read',nowSeconds:f.now});
  const {authorization,handler}=await authorizeTelegramHandler(context,body);
  return bindLegacyCompatibilityEnv(await prepareLegacyCompatibility(authorization,{family:handler.capability}),
    {...f.serverEnv,DB:f.binding});
}

test('confirmed refund cancels exact first charge once; authenticated catalog then admits a new immutable contract',async t=>{
  const f=fixture(t),paid=await f.paid(),first=paid.update.message.successful_payment.telegram_payment_charge_id,calls=[];
  capture(f,t);
  const result=await requestStarsRefund(f.serverEnv,request(paid),{telegramApi:async(_env,method,payload)=>{
    calls.push({method,payload});return true;
  }});
  assert.equal(result.refunded,true);assert.equal(result.renewalCancellation.confirmed,true);
  assert.equal((await state(f)).lifecycle.renewalState,'canceled');
  assert.deepEqual(calls.map(c=>c.method),['refundStarPayment','editUserStarSubscription']);
  assert.deepEqual(calls[1].payload,{user_id:101,telegram_payment_charge_id:first,is_canceled:true});
  const journal=f.sqlite.prepare('SELECT * FROM subscription_refund_cancellations').get();
  assert.equal(journal.telegram_id,101);assert.equal(journal.actor_id,900);
  const oldGrant=f.sqlite.prepare('SELECT * FROM subscription_access_grants').get();assert.equal(oldGrant.status,'refunded');
  const before=f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY ledger_entry_id').all();
  const offer=(await catalog(f)).recurring.offers.find(row=>row.planCode==='dragon');
  assert.equal(offer.checkout.available,true);assert.equal(contract(f,paid.invoice.contractId).retired_at,null,'GET has no effects');
  const fresh=await invoice(f);assert.equal(fresh.status,'confirmed');assert.notEqual(fresh.contractId,paid.invoice.contractId);
  assert.notEqual(fresh.orderId,paid.invoice.orderId);assert.notEqual(contract(f,fresh.contractId).external_invoice_payload,paid.contract.external_invoice_payload);
  const old=contract(f,paid.invoice.contractId);assert.ok(old.retired_at);assert.equal(old.first_payment_ledger_entry_id,paid.record.ledgerEntryId);
  assert.equal(old.origin_order_id,paid.order.order_id);assert.deepEqual(f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY ledger_entry_id').all(),before);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_access_grants').get(),oldGrant);
  const repeated=await requestStarsRefund(f.serverEnv,request(paid),{telegramApi:async()=>assert.fail('refund/cancel repeated')});
  assert.equal(repeated.refunded,true);assert.equal(repeated.renewalCancellation.confirmed,true);assert.equal(count(f,'subscription_provider_commands'),1);
});

for(const outcome of ['false','lost_response'])test(`confirmed money refund with ${outcome} cancel stays reviewable, keeps contract open and never repeats the attempt`,async t=>{
  const f=fixture(t),paid=await f.paid();let refunds=0,cancels=0;
  const api=async(_env,method)=>{if(method==='refundStarPayment'){refunds++;return true;}cancels++;
    if(outcome==='lost_response')throw Object.assign(new Error('network response lost'),{ambiguous:true});return false;};
  const result=await requestStarsRefund(f.serverEnv,request(paid),{telegramApi:api});
  assert.equal(result.refunded,true);assert.equal(result.renewalCancellation.confirmed,false);
  assert.equal(result.renewalCancellation.status,outcome==='false'?'rejected':'unknown');
  assert.equal((await state(f)).lifecycle.renewalState,'unknown');
  const repeated=await requestStarsRefund(f.serverEnv,request(paid),{telegramApi:api});assert.equal(repeated.refunded,true);
  assert.equal(refunds,1);assert.equal(cancels,1);assert.equal(count(f,'payment_ledger'),2);assert.equal(count(f,'subscription_refund_cancellations'),1);
  assert.equal(contract(f,paid.invoice.contractId).retired_at,null);
  assert.equal((await catalog(f)).recurring.offers.find(row=>row.planCode==='dragon').checkout.available,false);
  await assert.rejects(invoice(f));assert.equal(count(f,'subscription_billing_contracts'),1);assert.equal(count(f,'mini_app_atomic_guards'),0);
});

test('unknown refund never debits, cancels, retires or grants another purchase',async t=>{
  const f=fixture(t),paid=await f.paid(),grant=f.sqlite.prepare('SELECT * FROM subscription_access_grants').get();let calls=0;
  const api=async(_env,method)=>{calls++;assert.equal(method,'refundStarPayment');throw new Error('unknown refund result');};
  const result=await requestStarsRefund(f.serverEnv,request(paid),{telegramApi:api});assert.equal(result.refunded,false);
  const repeated=await requestStarsRefund(f.serverEnv,request(paid),{telegramApi:api});assert.equal(repeated.refunded,false);
  assert.equal(calls,1);assert.equal(count(f,'payment_ledger'),1);assert.equal(count(f,'subscription_provider_commands'),0);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_access_grants').get(),grant);assert.equal(contract(f,paid.invoice.contractId).retired_at,null);
});

test('refunding a later month cancels via the first charge and preserves another paid slice until its exact expiry',async t=>{
  const f=fixture(t),paid=await f.paid(),firstCharge=paid.update.message.successful_payment.telegram_payment_charge_id;
  const renewal=f.successful(paid.order,{expiration:f.now+MONTH*2,first:false});
  const recorded=await recordStarsSuccessfulPayment(f.serverEnv,renewal);await applyStarsPaidAccess(f.serverEnv,{orderId:recorded.orderId});
  const firstGrant=f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(paid.record.ledgerEntryId);
  let cancel;
  const result=await requestStarsRefund(f.serverEnv,{adminTelegramId:900,telegramPaymentChargeId:renewal.message.successful_payment.telegram_payment_charge_id,
    reasonCode:'later_month_refund'},{telegramApi:async(_env,method,payload)=>{if(method==='editUserStarSubscription')cancel=payload;return true;}});
  assert.equal(result.refunded,true);assert.equal(result.renewalCancellation.confirmed,true);assert.equal(cancel.telegram_payment_charge_id,firstCharge);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(paid.record.ledgerEntryId),firstGrant);
  const view=await state(f);assert.equal(view.lifecycle.renewalState,'canceled');assert.equal(view.lifecycle.paidUntil,firstGrant.ends_at);
  assert.equal(f.sqlite.prepare('SELECT status FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(recorded.ledgerEntryId).status,'refunded');
  assert.equal(contract(f,paid.invoice.contractId).retired_at,null);await assert.rejects(invoice(f));
  const then=firstGrant.ends_at+1;t.mock.method(Date,'now',()=>then*1000);f.now=then;f.tokens.delete(101);
  f.serverEnv.REBUILD_V140_OWNER_WINDOW=`true:${then-1}:${then+600}`;
  const http=createCabinetHttp({repositoryFactory:f.repositoryFactory,clock:()=>then});
  const response=await http(new Request('https://cabinet.example/api/v1.4.0/cabinet/session',{method:'POST',
    headers:{Origin:'https://cabinet.example','Content-Type':'application/json','Idempotency-Key':'later-session-'+next()},
    body:JSON.stringify({initData:signedInitData(101,then)})}),{...f.serverEnv,OWNER_TELEGRAM_ID:'101'});
  const session=await response.json();assert.equal(response.status,200,JSON.stringify(session));f.tokens.set(101,session.sessionToken);
  const offer=(await catalog(f)).recurring.offers.find(row=>row.planCode==='dragon');assert.equal(offer.checkout.available,true);
  const fresh=await invoice(f);assert.equal(fresh.status,'confirmed');assert.notEqual(fresh.contractId,paid.invoice.contractId);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(paid.record.ledgerEntryId),firstGrant);
});

test('owner retained refund uses its private exact payment admission, retains independent first-period access and deduplicates cancellation',async t=>{
  const f=fixture(t),paid=await f.retained(),mint=await f.owner();let refunds=0,cancels=0;
  const firstGrant=f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(paid.record.ledgerEntryId);
  const options={telegramApi:async(_env,method,payload)=>{if(method==='refundStarPayment')refunds++;else{
    cancels++;assert.equal(method,'editUserStarSubscription');assert.equal(payload.telegram_payment_charge_id,paid.update.message.successful_payment.telegram_payment_charge_id);
  }return true;}};
  const result=await resolveRetainedStarsPaymentReview(await mint(paid.retained.ledgerEntryId,'refund'),options);
  assert.equal(result.refunded,true);assert.equal(result.renewalCancellation.confirmed,true);
  const repeated=await resolveRetainedStarsPaymentReview(await mint(paid.retained.ledgerEntryId,'refund'),options);
  assert.equal(repeated.refunded,true);assert.equal(refunds,1);assert.equal(cancels,1);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(paid.record.ledgerEntryId),firstGrant);
  assert.equal(contract(f,paid.invoice.contractId).retired_at,null);
  const forged=await cancelConfirmedRefundFutureRenewal({refundId:f.sqlite.prepare('SELECT refund_id FROM payment_refunds').get().refund_id},options);
  assert.equal(forged.confirmed,false);assert.equal(cancels,1);
});

test('a concurrent pending provider control rolls back retirement and new invoice without touching historical refund',async t=>{
  const f=fixture(t),paid=await f.paid();
  await requestStarsRefund(f.serverEnv,request(paid),{telegramApi:async()=>true});
  const before=f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY ledger_entry_id').all(),c=contract(f,paid.invoice.contractId);
  f.binding.beforeBatch=()=>{f.sqlite.prepare(`INSERT INTO subscription_provider_commands(command_id,idempotency_key,contract_id,telegram_id,
    action,desired_auto_renew,expected_contract_revision,first_payment_ledger_entry_id,request_sha256,created_at,updated_at)
    VALUES(?,?,?,101,'cancel_renewal',0,?,?,?, ?,?)`).run(crypto.randomUUID(),'concurrent-foreign-intent-'+next(),c.contract_id,
      c.revision,c.first_payment_ledger_entry_id,'a'.repeat(64),f.now,f.now);};
  await assert.rejects(invoice(f));assert.equal(contract(f,c.contract_id).retired_at,null);assert.equal(count(f,'subscription_billing_contracts'),1);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY ledger_entry_id').all(),before);assert.equal(count(f,'mini_app_atomic_guards'),0);
});

test('genuine active observation followed by lost cancel response exposes unknown renewal and exact preserved paid remainder',async t=>{
  const f=fixture(t),paid=await f.paid();await activeObservation(f,paid);
  assert.equal((await state(f)).lifecycle.renewalState,'active');
  const renewal=f.successful(paid.order,{expiration:f.now+MONTH*2,first:false});
  const recorded=await recordStarsSuccessfulPayment(f.serverEnv,renewal);await applyStarsPaidAccess(f.serverEnv,{orderId:recorded.orderId});
  const end=f.sqlite.prepare('SELECT ends_at FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(paid.record.ledgerEntryId).ends_at;
  await requestStarsRefund(f.serverEnv,{adminTelegramId:900,telegramPaymentChargeId:renewal.message.successful_payment.telegram_payment_charge_id,
    reasonCode:'provider_unknown_test'},{telegramApi:async(_env,method)=>{if(method==='refundStarPayment')return true;throw new Error('lost cancel response');}});
  const view=await state(f);assert.equal(view.lifecycle.renewalState,'unknown');assert.equal(view.lifecycle.paidUntil,end);
  assert.equal(view.lifecycle.paidAccess,true);assert.equal(view.lifecycle.pendingOperations,1);assert.equal(view.lifecycle.reviewRequired,true);
});

test('known active observation within cancellation epoch does not permanently block a fully refunded new purchase',async t=>{
  const f=fixture(t),paid=await f.paid();await activeObservation(f,paid);
  const result=await requestStarsRefund(f.serverEnv,request(paid),{telegramApi:async()=>true});assert.equal(result.renewalCancellation.confirmed,true);
  assert.equal((await state(f)).lifecycle.renewalState,'canceled');
  assert.equal((await catalog(f)).recurring.offers.find(row=>row.planCode==='dragon').checkout.available,true);
  const fresh=await invoice(f);assert.notEqual(fresh.contractId,paid.invoice.contractId);assert.ok(contract(f,paid.invoice.contractId).retired_at);
});

for(const phase of ['after_refund_response','revoked_role_after_response','expired_transport_after_response','before_cancel_admission'])test(`fresh branded legacy refund authority ${phase} blocks revoked actor cancellation but still settles confirmed refund`,async t=>{
  const f=fixture(t),paid=await adminPaid(f),env=await legacyRefundEnv(f,paid);let calls=0;
  const result=await requestStarsRefund(env,{...request(paid),reasonCode:'admin_canary_validation'},{telegramApi:async(_env,method)=>{
    calls++;assert.equal(method,'refundStarPayment');
    if(phase==='after_refund_response')f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=900').run();
    else if(phase==='revoked_role_after_response')f.sqlite.prepare("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'").run();
    else if(phase==='expired_transport_after_response')f.sqlite.prepare("UPDATE telegram_update_receipts SET status='completed',lease_expires_at=0,completed_at=? WHERE actor_id=900 AND update_type='callback_query' AND status='processing'").run(Math.floor(Date.now()/1000));
    else{const batch=f.binding.batch.bind(f.binding);f.binding.batch=async statements=>{
      if(statements.some(s=>s.sql.includes('INSERT INTO subscription_provider_commands'))){f.binding.batch=batch;
        f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=900').run();}
      return batch(statements);};}
    return true;
  }});
  assert.equal(result.refunded,true);assert.equal(result.renewalCancellation.confirmed,false);assert.equal(calls,1);
  assert.equal(count(f,'subscription_provider_commands'),0);assert.equal(count(f,'subscription_refund_cancellations'),0);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM payment_ledger WHERE entry_type='refund'").get().n,1);
  assert.equal(contract(f,paid.invoice.contractId).retired_at,null);assert.equal(count(f,'mini_app_atomic_guards'),0);
});

test('fresh branded legacy refund uses current allowed authority to cancel the exact customer contract',async t=>{
  const f=fixture(t),paid=await adminPaid(f),env=await legacyRefundEnv(f,paid),methods=[];
  const result=await requestStarsRefund(env,{...request(paid),reasonCode:'admin_canary_validation'},{telegramApi:async(_env,method,payload)=>{
    methods.push(method);assert.equal(payload.user_id,900);return true;}});
  assert.equal(result.refunded,true);assert.equal(result.renewalCancellation.confirmed,true);
  assert.deepEqual(methods,['refundStarPayment','editUserStarSubscription']);
});

test('a genuine denied invoice authorization cannot retire a compensated contract through the exported effect',async t=>{
  const f=fixture(t),paid=await f.paid();await requestStarsRefund(f.serverEnv,request(paid),{telegramApi:async()=>true});
  const readOnly=await f.auth();
  await assert.rejects(retireRefundedContractsForInvoice(readOnly),{code:'refund_retirement_authority_required'});
  assert.equal(contract(f,paid.invoice.contractId).retired_at,null,'an allowed read is not a recurring invoice admission');
  f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=101').run();
  const context=await createCustomerContext({binding:f.binding,env:f.serverEnv,sessionToken:f.tokens.get(101),
    channel:'mini_app',operation:'billing.purchase_monthly',requestPayload:invoiceIntent,idempotencyKey:'denied-invoice-'+next()});
  const denied=await createRuntimeAuthorizer().authorize(context,null),before=count(f,'subscription_provider_events');
  await assert.rejects(retireRefundedContractsForInvoice(denied));assert.equal(contract(f,paid.invoice.contractId).retired_at,null);
  assert.equal(count(f,'subscription_provider_events'),before);assert.equal(count(f,'subscription_billing_contracts'),1);
});

test('fresh owner HTTP boot completes a durable applied self-canary refund without its lost legacy admission or another refund call',async t=>{
  const f=fixture(t),paid=await adminPaid(f);
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  const priorEnv=await legacyRefundEnv(f,paid);
  const applied=await requestStarsRefund(priorEnv,{...request(paid),reasonCode:'admin_canary_validation'},
    {telegramApi:async(_env,method)=>{assert.equal(method,'refundStarPayment');
      f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=900').run();return true;}});
  assert.equal(applied.refunded,true);assert.equal(applied.renewalCancellation.confirmed,false);
  const refund=f.sqlite.prepare('SELECT * FROM payment_refunds').get();assert.equal(refund.status,'applied');
  assert.equal(count(f,'subscription_provider_commands'),0);
  f.sqlite.prepare('UPDATE users SET is_blocked=0 WHERE telegram_id=900').run();
  await assert.rejects(legacyRefundEnv(f,paid),'a new ordinary refund admission stays denied on compensated payment');
  f.now=Math.max(f.now,Math.floor(Date.now()/1000));const candidate='e'.repeat(40),revision=33;
  f.sqlite.prepare(`INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,updated_at)
    VALUES(1,?,?,'closed',0,?)`).run(candidate,revision,f.now);
  const env={...f.serverEnv,V141_RELEASE_MODE:'owner_only',V141_AUTHORIZATION_ENABLED:'true',V141_ADMIN_MINI_APP_ENABLED:'true',
    REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',REBUILD_V140_OWNER_WINDOW:'false',
    REBUILD_V140_RC_SHA:candidate,REBUILD_V140_RELEASE_REVISION:String(revision),REBUILD_V140_WRITES_ENABLED:'true'};
  let calls=0,http;
  const boot=()=>{http=createCabinetHttp({repositoryFactory:f.repositoryFactory,clock:()=>f.now,nativeProviderFetch:async(url,options)=>{
    assert.equal(new URL(url).pathname.endsWith('/editUserStarSubscription'),true);calls++;
    assert.deepEqual(JSON.parse(options.body),{user_id:900,telegram_payment_charge_id:paid.update.message.successful_payment.telegram_payment_charge_id,is_canceled:true});
    return new Response(JSON.stringify({ok:true,result:true}),{headers:{'Content-Type':'application/json'}});
  }});};
  const send=async(path,body,token)=>{f.now=Math.max(f.now,Math.floor(Date.now()/1000));
    const response=await http(new Request(env.MINI_APP_ORIGIN+'/api/v1.4.0/cabinet/'+path,{method:'POST',headers:{
      Origin:env.MINI_APP_ORIGIN,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json',
      'Idempotency-Key':'fresh-completion-'+next(),...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)}),env);
    return {status:response.status,data:await response.json()};};
  boot();const opened=await send('session',{initData:signedInitData(900,f.now)});
  assert.equal(opened.status,200,JSON.stringify(opened.data));const token=opened.data.sessionToken;
  const before=f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY ledger_entry_id').all();
  const originalBatch=f.binding.batch.bind(f.binding);f.binding.batch=async statements=>{
    if(statements.some(s=>s.sql.includes('INSERT INTO subscription_provider_commands'))){
      f.binding.batch=originalBatch;f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=900').run();
    }return originalBatch(statements);};
  const stale=await send('admin/refund-renewal/complete',{refundId:refund.refund_id},token);
  assert.equal(stale.data.confirmed,false);assert.equal(calls,0);assert.equal(count(f,'subscription_provider_commands'),0);
  assert.equal(count(f,'subscription_refund_cancellations'),0);assert.equal(count(f,'mini_app_atomic_guards'),0);
  f.sqlite.prepare('UPDATE users SET is_blocked=0 WHERE telegram_id=900').run();boot();
  const completed=await send('admin/refund-renewal/complete',{refundId:refund.refund_id},token);
  assert.equal(completed.status,200,JSON.stringify(completed.data));assert.equal(completed.data.confirmed,true);assert.equal(calls,1);
  boot();const replay=await send('admin/refund-renewal/complete',{refundId:refund.refund_id},token);
  assert.equal(replay.data.confirmed,true);assert.equal(calls,1);assert.equal(count(f,'subscription_provider_commands'),1);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY ledger_entry_id').all(),before);
  assert.equal((await send('admin/refund-renewal/complete',{refundId:refund.refund_id,userId:101},token)).status,400);
  f.sqlite.prepare("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'").run();
  const denied=await send('admin/refund-renewal/complete',{refundId:refund.refund_id},token);
  assert.ok([403,404,503].includes(denied.status),JSON.stringify(denied));assert.equal(calls,1);
  f.sqlite.prepare("UPDATE user_roles SET status='active' WHERE telegram_id=900 AND role='admin'").run();
  f.now+=301;
  assert.equal((await send('admin/refund-renewal/complete',{refundId:refund.refund_id},token)).status,401);assert.equal(calls,1);
});

test('refund cancellation rejection persists the actual Telegram response without another refund or cancellation',async t=>{
  const f=fixture(t),paid=await f.paid();let refunds=0,cancels=0;
  const result=await requestStarsRefund(f.serverEnv,request(paid),{telegramApi:async(env,method,payload)=>{
    if(method==='refundStarPayment'){refunds++;return true;}
    cancels++;return callStarsTelegram(env,method,payload,{fetchImpl:async()=>Response.json({ok:false,error_code:400,
      description:'Bad Request: CHARGE_ID_INVALID'},{status:400})});
  }});
  assert.equal(result.refunded,true);assert.equal(result.renewalCancellation.confirmed,false);
  const command=f.sqlite.prepare('SELECT * FROM subscription_provider_commands').get();
  assert.equal(command.state,'rejected');assert.equal(command.error_code,'telegram_400_charge_id_invalid');
  const audit=f.sqlite.prepare("SELECT details FROM admin_audit_log WHERE action='subscription_provider_diagnostic' AND entity_id=?").get(command.command_id);
  const detail=JSON.parse(audit.details);assert.equal(detail.httpStatus,400);assert.equal(detail.apiErrorCode,400);
  assert.equal(detail.descriptionCode,'charge_id_invalid');assert.equal(detail.descriptionSafe,'Bad Request: CHARGE_ID_INVALID');
  assert.equal(contract(f,paid.contract.contract_id).retired_at,null);
  await requestStarsRefund(f.serverEnv,request(paid),{telegramApi:async()=>assert.fail('refund/provider replay')});
  assert.equal(refunds,1);assert.equal(cancels,1);
});
