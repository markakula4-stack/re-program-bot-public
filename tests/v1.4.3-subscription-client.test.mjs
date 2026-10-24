import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foundationFixture, signedInitData } from './helpers/v1.4.1-fixtures.mjs';
import { ORIGIN } from './helpers/v1.4.0-rebuild-sqlite.mjs';
import { createCabinetHttp } from '../src/v1.4.0-rebuild/cabinet-http.mjs';
import { MiniAppClient, readSubscriptionDTO, safeStarsInvoiceUrl } from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';
import { STARS_RECURRING_TERMS_REVISION as TERMS } from '../src/v1.4.3/recurring-provider-config.mjs';
import { handleStarsPreCheckoutQuery, recordStarsSuccessfulPayment } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsPaidAccess } from '../src/v1.3.6/stars-access-runtime.mjs';
import { authoritySeconds } from '../src/v1.4.1/authority-resolver.mjs';

let sequence=1_434_300;
const key='re-subscription-pending-v1';
const storage=()=>{const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};};
function setup(t,{loseInvoiceResponse=false}={}) {
  const f=foundationFixture(t);
  // Keep the synthetic HTTP context and native adapter in one clock epoch;
  // crossing a real wall-clock second is not the failure under test here.
  f.now=Math.floor(Date.now()/1000);
  const actualNow=Date.now;Date.now=()=>f.now*1000;t.after(()=>{Date.now=actualNow;});
  f.sqlite.function('current_timestamp',{deterministic:false},()=>new Date(f.now*1000).toISOString().slice(0,19).replace('T',' '));
  f.sqlite.function('unixepoch',{deterministic:false,varargs:true},(...args)=>args.length===0||args[0]==='now'?f.now:authoritySeconds(args[0]));
  for(const name of ['0065-v1.4.1-privacy-ai-journal.sql','0026-v1.3.6-stars-core-foundation.sql',
    '0027-v1.3.6-stars-access-and-reconciliation.sql','0066-v1.4.3-subscription-lifecycle-foundation.sql',
    '0067-v1.4.3-lifecycle-engine-binding.sql','0068-v1.4.3-provider-and-review-binding.sql'])
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const candidate='a'.repeat(40),issued=f.now-1,expires=f.now+600;
  f.sqlite.prepare(`INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,owner_telegram_id,issued_at,expires_at,updated_at)
    VALUES(1,?,1,'open',1,101,?,?,?)`).run(candidate,issued,expires,f.now);
  f.serverEnv={...f.serverEnv,V141_AUTHORIZATION_ENABLED:'true',REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',
    REBUILD_V140_RC_SHA:candidate,REBUILD_V140_RELEASE_REVISION:'1',REBUILD_V140_OWNER_TELEGRAM_ID:'101',
    REBUILD_V140_OWNER_WINDOW:`true:${issued}:${expires}`,STARS_PAYMENTS_ENABLED:'true',STARS_BILLING_MODE:'prepaid',
    STARS_PRICE_VERSION:'1',STARS_TERMS_REVISION:'2026-09-10.stars-v1',STARS_ROLLOUT_MODE:'allowlist',
    STARS_ROLLOUT_ALLOWLIST:'101',STARS_RECURRING_ENABLED:'true',STARS_RECURRING_PRICE_VERSION:'1',
    STARS_RECURRING_TERMS_REVISION:TERMS,STARS_INVOICE_SECRET:'offline-v143-p04-client-invoice-secret-more-than-32-characters'};
  for(const id of [101,202,900]) {
    f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(id);
    f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(id);
  }
  const providerCalls=[];
  f.http=createCabinetHttp({repositoryFactory:f.repositoryFactory,clock:()=>f.now,nativeProviderFetch:async(url,init)=>{
    const method=new URL(url).pathname.split('/').at(-1);providerCalls.push({method,body:JSON.parse(init.body)});
    return Response.json({ok:true,result:method==='createInvoiceLink'?'https://t.me/$offline_p04_client_invoice':true});
  }});
  const transportCalls=[],pendingStorage=storage(),control={loseInvoiceResponse};
  const makeClient=()=>new MiniAppClient({origin:ORIGIN,now:()=>f.now*1000,pendingStorage,
    fetchImpl:async(url,init)=>{transportCalls.push({url,init});const headers=new Headers(init.headers);
      if(init.method==='POST'){headers.set('Origin',ORIGIN);headers.set('Sec-Fetch-Site','same-origin');}
      const response=await f.http(new Request(url,{...init,headers}),f.serverEnv);
      if(url.endsWith('/recurring-invoice')&&control.loseInvoiceResponse){control.loseInvoiceResponse=false;throw new TypeError('offline response lost after actual commit');}
      return response;}});
  return {...f,client:makeClient(),makeClient,providerCalls,transportCalls,pendingStorage,advanceWallSecond:()=>{f.now++;}};
}

test('real authenticated HTTP GET parses lifecycle, independent recurring quotes, own history and safe controls; invoice response never grants access',async t=>{
  const f=setup(t);await f.client.authenticate(signedInitData(101,f.now));
  const before=await f.client.read('subscription');
  assert.equal(before.access.current.planCode,'free');assert.equal(before.lifecycle.paidAccess,false);
  assert.equal(before.catalog.billing.automaticRenewal,false);assert.equal(before.catalog.recurring.terms.explicitConsentRequired,true);
  assert.equal(before.catalog.recurring.offers.find(o=>o.planCode==='dragon').amountStars,499);
  assert.equal(before.history.authority,'worker');assert.equal(before.history.accessAuthority,false);assert.equal(before.history.items.length,0);
  const invoice=await f.client.subscriptionAction('invoice',{planCode:'dragon',recurringConsent:true,termsRevision:TERMS,priceVersion:1});
  assert.equal(invoice.status,'confirmed');assert.equal(invoice.accessApplied,false);assert.equal(f.client.subscriptionOutcomePending,false);
  assert.equal(f.providerCalls.length,1);assert.equal(f.providerCalls[0].method,'createInvoiceLink');
  const after=await f.client.read('subscription');assert.equal(after.lifecycle.paidAccess,false);assert.equal(after.history.items.length,0);
  const post=f.transportCalls.find(row=>row.url.endsWith('/recurring-invoice'));
  assert.equal(post.init.headers.Origin,ORIGIN);assert.match(post.init.headers['Idempotency-Key'],/^[a-f0-9]{48}$/);
  assert.equal(JSON.parse(post.init.body).recurringConsent,true);
  await assert.rejects(f.client.subscriptionAction('invoice',{planCode:'dragon',recurringConsent:true,termsRevision:TERMS,priceVersion:1}));
  assert.equal(f.providerCalls.length,1,'existing contract blocks a second provider invoice');
});

test('real paid receipt, cancel and native reenable permission keep exact paidUntil and own receipt without claiming renewal active',async t=>{
  const f=setup(t);await f.client.authenticate(signedInitData(101,f.now));
  const issued=await f.client.subscriptionAction('invoice',{planCode:'professional',recurringConsent:true,termsRevision:TERMS,priceVersion:1});
  const order=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(issued.orderId);
  const checkout=await handleStarsPreCheckoutQuery(f.serverEnv,{update_id:++sequence,pre_checkout_query:{id:'offline_p04_'+sequence,
    from:{id:101,is_bot:false},currency:'XTR',total_amount:249,invoice_payload:order.invoice_payload}}, {telegramApi:async()=>true});
  assert.equal(checkout.approved,true);
  const paidUntil=f.now+2592000;
  const payment=await recordStarsSuccessfulPayment(f.serverEnv,{update_id:++sequence,message:{from:{id:101,is_bot:false},chat:{id:101,type:'private'},successful_payment:{
    currency:'XTR',total_amount:249,invoice_payload:order.invoice_payload,telegram_payment_charge_id:'offline_p04_charge_'+sequence,
    provider_payment_charge_id:'',is_recurring:true,is_first_recurring:true,subscription_expiration_date:paidUntil}}});
  await applyStarsPaidAccess(f.serverEnv,{orderId:payment.orderId});
  const paid=await f.client.read('subscription');assert.equal(paid.lifecycle.paidUntil,paidUntil);assert.equal(paid.lifecycle.paidAccess,true);
  const result=await f.client.subscriptionAction('cancel',{contractId:paid.renewalActions.contractId,expectedRevision:paid.renewalActions.expectedRevision});
  assert.equal(result.cancellationConfirmed,true);assert.equal(result.paidPeriodChanged,false);
  const canceled=await f.client.read('subscription');assert.equal(canceled.lifecycle.state,'cancel_at_period_end');assert.equal(canceled.lifecycle.paidUntil,paidUntil);
  assert.equal(canceled.history.items.length,1);assert.equal(canceled.history.items[0].status,'paid');
  assert.match(canceled.history.items[0].receiptId,/^stars-[a-f0-9]{24}$/);assert.ok(Object.isFrozen(canceled.history.items[0].receipt));
  const serialized=JSON.stringify(canceled.history);assert.doesNotMatch(serialized,/telegram_payment_charge_id|offline_p04_charge_|invoice_payload|ledger_entry_id/);
  for(const change of [d=>{d.lifecycle.nextChargeAt=paidUntil;},d=>{d.history.items[0].receipt.chargeId='private';},
    d=>{d.renewalActions.cancel.route='/admin/refund';},d=>{d.catalog.recurring.offers[0].checkout.actionAdmissionRequired=false;}]) {
    const malformed=structuredClone(canceled);change(malformed);assert.throws(()=>readSubscriptionDTO(malformed),{code:'invalid_response'});
  }
  f.advanceWallSecond();
  const allowed=await f.client.subscriptionAction('enable',{contractId:canceled.renewalActions.contractId,expectedRevision:canceled.renewalActions.expectedRevision});
  assert.equal(allowed.status,'confirmed');assert.equal(allowed.reenableAllowed,true);assert.equal(allowed.providerState,null);
  assert.equal(allowed.paidPeriodChanged,false);assert.equal(allowed.accessApplied,false);assert.equal(f.client.subscriptionOutcomePending,false);
  const waiting=await f.client.read('subscription');
  assert.equal(waiting.lifecycle.renewalState,'unknown');assert.ok(waiting.lifecycle.reviewReasons.includes('provider_reenable_permission_pending'));
  assert.equal(waiting.lifecycle.pendingOperations,1);assert.equal(waiting.lifecycle.paidUntil,paidUntil);assert.equal(waiting.lifecycle.paidAccess,true);
  assert.deepEqual(waiting.history.items,canceled.history.items,'permission does not add a receipt or paid period');
  f.client.clearSession();const reopened=f.makeClient();await reopened.authenticate(signedInitData(101,f.now));
  const restored=await reopened.read('subscription');assert.equal(restored.lifecycle.renewalState,'unknown');
  assert.ok(restored.lifecycle.reviewReasons.includes('provider_reenable_permission_pending'));assert.equal(restored.lifecycle.paidUntil,paidUntil);
  assert.equal(f.providerCalls.filter(call=>call.method==='editUserStarSubscription').length,2,'reload never resends cancel or permission');
});

test('lost financial response persists one immutable key across reopen, has no automatic retry, and rejects racing or unconfirmed consent',async()=>{
  const saved=storage(),calls=[];let finish;
  const session=()=>Response.json({sessionToken:'rpms1_'+'a'.repeat(43),tokenType:'Bearer',expiresAt:1791060000+300,
    principal:{telegramId:900,botId:123456789},authorizationVersion:1,features:{version:1,mutationsEnabled:true,offerActionsEnabled:false}});
  const make=()=>new MiniAppClient({origin:'https://cabinet.example',now:()=>1791060000*1000,pendingStorage:saved,
    fetchImpl:async(url,init)=>{calls.push({url,init});if(url.endsWith('/session'))return session();return new Promise((_yes,no)=>{finish=no;});}});
  const client=make();await client.authenticate('offline-signed');
  await assert.rejects(client.subscriptionAction('invoice',{planCode:'dragon',recurringConsent:false,termsRevision:TERMS,priceVersion:1}),{code:'invalid_request'});
  const pending=client.subscriptionAction('invoice',{planCode:'dragon',recurringConsent:true,termsRevision:TERMS,priceVersion:1});
  await assert.rejects(client.subscriptionAction('cancel',{contractId:crypto.randomUUID(),expectedRevision:1}),{code:'request_in_progress'});
  const marker=JSON.parse(saved.getItem(key));assert.match(marker.key,/^[a-f0-9]{48}$/);assert.deepEqual(Object.keys(marker),['kind','key','startedAt','intent','principal']);
  assert.deepEqual(marker.principal,{telegramId:900,botId:123456789},'pending operation remains bound to its authenticated account and bot');
  finish(new TypeError('offline lost response'));await assert.rejects(pending,{code:'subscription_outcome_unknown'});
  const reopened=make();await reopened.authenticate('offline-fresh-signed');assert.equal(reopened.subscriptionOutcomePending,true);
  await assert.rejects(reopened.subscriptionAction('invoice',{planCode:'dragon',recurringConsent:true,termsRevision:TERMS,priceVersion:1}),{code:'subscription_outcome_unknown'});
  assert.equal(calls.filter(row=>row.url.endsWith('/recurring-invoice')).length,1);assert.equal(JSON.parse(saved.getItem(key)).key,marker.key);
  for(const value of ['javascript:alert(1)','https://evil.test/$x','https://t.me/$x?token=private','https://u:p@t.me/$x','https://t.me:8443/$x'])assert.equal(safeStarsInvoiceUrl(value),null);
});

test('real lost HTTP invoice response recovers exact saved invoice after reopen through read-only same-key status; provider is not retried',async t=>{
  const f=setup(t,{loseInvoiceResponse:true});await f.client.authenticate(signedInitData(101,f.now));
  const intent={planCode:'dragon',recurringConsent:true,termsRevision:TERMS,priceVersion:1};
  await assert.rejects(f.client.subscriptionAction('invoice',intent),{code:'subscription_outcome_unknown'});
  assert.equal(f.providerCalls.length,1);assert.equal(f.client.subscriptionOutcomePending,true);
  const marker=JSON.parse(f.pendingStorage.getItem(key)),originalRequest=f.transportCalls.find(row=>row.url.endsWith('/recurring-invoice'));
  assert.equal(originalRequest.init.headers['Idempotency-Key'],marker.key);assert.deepEqual(marker.intent,intent);
  f.client.clearSession();const reopened=f.makeClient();await reopened.authenticate(signedInitData(101,f.now));
  const dto=await reopened.read('subscription');assert.equal(dto.lifecycle.paidAccess,false);assert.equal(dto.history.items.length,0);
  assert.equal(reopened.subscriptionOutcomePending,false);assert.equal(reopened.recoveredSubscriptionInvoiceUrl,'https://t.me/$offline_p04_client_invoice');
  assert.equal(f.pendingStorage.getItem(key),null);assert.equal(f.providerCalls.length,1);
  const lookups=f.transportCalls.filter(row=>row.url.endsWith('/operation-status'));assert.equal(lookups.length,1);
  assert.equal(lookups[0].init.headers['Idempotency-Key'],marker.key);assert.deepEqual(JSON.parse(lookups[0].init.body),{kind:'invoice',intent});
  assert.equal(f.transportCalls.filter(row=>row.url.endsWith('/recurring-invoice')).length,1);
});
