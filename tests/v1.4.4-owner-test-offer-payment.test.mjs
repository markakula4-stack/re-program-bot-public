import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash,createHmac} from 'node:crypto';
import {foundationFixture} from './helpers/v1.4.1-fixtures.mjs';
import {createCustomerContext,createCabinetCustomerContext,createFinancialCustomerContext,createServiceExecutor} from '../src/v1.4.1/trusted-context.mjs';
import {verifyTelegramInitData,establishMiniAppSession} from '../src/v1.4.0-rebuild/mini-app-security.mjs';
import {authoritySeconds,createAuthorityResolver} from '../src/v1.4.1/authority-resolver.mjs';
import {createRuntimeAuthorizer} from '../src/v1.4.1/runtime-authorizer.mjs';
import {acceptStarsPurchaseTerms,handleStarsPreCheckoutQuery,recordStarsSuccessfulPayment} from '../src/v1.3.6/stars-payment-runtime.mjs';
import {buildStarsInvoicePayload} from '../src/v1.3.6/stars-core-foundation.mjs';
import {PACKAGE_OWNER_TEST_OFFER as OFFER,PACKAGE_CONTRACT_VERSION,resolveOwnPackagePeriodAuthority,createServerPackageQuote,
  normalizeServerPackagePrice,normalizeStoredServerPackagePrice} from '../src/v1.4.4/package-contract.mjs';
import {issuePackageInvoice,isStoredPackageFinancialInvoice,applyVerifiedPackagePaidAccess,
  capturePackageReconciliationObservation,recordReconciledPackagePayment,readPackageRetainedReview} from '../src/v1.4.4/package-payment-runtime.mjs';
import {readOwnPackageSubscription} from '../src/v1.4.4/package-read-model.mjs';

const OWNER=8987576334,BOT=8562951985,BOT_TOKEN=BOT+':synthetic-owner-offer-payment-token-over32',
  REQUEST=Object.freeze({requestedPlanCode:'professional',packageCode:'3m'}),resolver=createAuthorityResolver();
let sequence=2501000;
const next=()=>++sequence,count=(f,table)=>f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
function signed(id,now){
  const values={auth_date:String(now),user:JSON.stringify({id,first_name:'Offline owner offer'})};
  const checked=Object.entries(values).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n');
  const key=createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
  return new URLSearchParams({...values,hash:createHmac('sha256',key).update(checked).digest('hex')}).toString();
}
function fixture(t,{now=1791478860}={}){
  const f=foundationFixture(t);f.now=now;
  f.sqlite.function('current_timestamp',{deterministic:false},()=>new Date(f.now*1000).toISOString().slice(0,19).replace('T',' '));
  f.sqlite.function('unixepoch',{deterministic:false,varargs:true},(...args)=>!args.length||args[0]==='now'?f.now:authoritySeconds(args[0]));
  for(const name of ['0026-v1.3.6-stars-core-foundation.sql','0027-v1.3.6-stars-access-and-reconciliation.sql',
    '0066-v1.4.3-subscription-lifecycle-foundation.sql','0067-v1.4.3-lifecycle-engine-binding.sql',
    '0068-v1.4.3-provider-and-review-binding.sql','0069-v1.4.3-d1-compatibility.sql',
    '0070-v1.4.3-refund-notification.sql','0071-v1.4.3-refund-contract-retirement.sql',
    '0072-v1.4.4-package-contract.sql','0073-v1.4.4-package-payment-review.sql','0074-v1.4.4-package-referral-compatibility.sql'])
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  f.sqlite.prepare('INSERT INTO users(telegram_id,referral_code,accepted_terms) VALUES(?,?,1)').run(OWNER,'offline-owner-offer');
  for(const role of ['user','admin'])f.sqlite.prepare("INSERT INTO user_roles(telegram_id,role,status) VALUES(?,?,'active')").run(OWNER,role);
  f.sqlite.prepare("INSERT INTO user_access(telegram_id,access_tier) VALUES(?,'free')").run(OWNER);
  for(const id of [101,OWNER]){
    f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(id);
    f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(id);
  }
  f.serverEnv={...f.serverEnv,ADMIN_ID:String(OWNER),OWNER_TELEGRAM_ID:String(OWNER),BOT_TOKEN,REBUILD_V140_BOT_ID:String(BOT),
    STARS_PAYMENTS_ENABLED:'true',STARS_BILLING_MODE:'prepaid',STARS_PRICE_VERSION:'1',STARS_TERMS_REVISION:'2026-09-10.stars-v1',
    STARS_INVOICE_SECRET:'synthetic-owner-offer-payment-secret-more-than-thirty-two',STARS_ROLLOUT_MODE:'allowlist',
    STARS_ROLLOUT_ALLOWLIST:String(OWNER),STARS_PACKAGES_ENABLED:'true',STARS_PACKAGE_3M_ENABLED:'true',STARS_PACKAGE_PRICE_VERSION:'2',
    WEBHOOK_SECRET:'synthetic-owner-offer-financial-webhook-secret'};
  for(const price of [{priceId:'professional-90d-prepaid-v2',priceVersion:2,amountStars:699,validFrom:1791392780,validUntil:null},OFFER])
    f.sqlite.prepare(`INSERT INTO price_book(price_id,price_version,plan_code,currency,amount_stars,access_seconds,billing_mode,
      publication_state,terms_revision,valid_from,valid_until,created_at,created_by)
      VALUES(?,?,'professional','XTR',?,7776000,'prepaid','approved','2026-09-10.stars-v1',?,?,?,?)`)
      .run(price.priceId,price.priceVersion,price.amountStars,price.validFrom,price.validUntil,price.validFrom,OWNER);
  f.context=(id=OWNER)=>createCustomerContext({binding:f.binding,env:f.serverEnv,initData:signed(id,f.now),
    nowSeconds:f.now,operation:'access.read_own',channel:'mini_app'});
  return f;
}
async function own(f){
  const actor=await resolver.resolveActor(await f.context());
  return {actor,verifiedPackagePeriods:await resolveOwnPackagePeriodAuthority({actor,nowSec:f.now}),nowSec:f.now};
}
const quote=async f=>createServerPackageQuote({...await own(f),request:REQUEST});
const subscription=async f=>readOwnPackageSubscription({authorization:await createRuntimeAuthorizer().authorize(await f.context(),null)});
async function issue(f,{outcome='issued',providerBarrier}={}){
  await acceptStarsPurchaseTerms(f.serverEnv,{telegramId:OWNER,telegramUpdateId:next(),acceptedAt:f.now-1});
  const scope=await own(f),calls=[];
  const options={telegramApi:async(_env,method,payload)=>{
    calls.push({method,payload});assert.equal(method,'createInvoiceLink');
    if(providerBarrier)await providerBarrier();
    if(outcome!=='issued')throw Object.assign(Error('offline invoice result unavailable'),{code:'telegram_400',ambiguous:outcome==='unknown'});
    return 'https://t.me/$syntheticOwnerOfferInvoice';
  }};
  const result=await issuePackageInvoice({actor:scope.actor,request:REQUEST,telegramUpdateId:next(),createdAt:f.now},options);
  return {result,order:f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(result.orderId),calls};
}
async function financial(f,event){
  const id=event.pre_checkout_query?.from.id??event.message.from.id,claim='offline-owner-offer-'+event.update_id;
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,claim_token,received_at,lease_expires_at)
    VALUES(?,'message',?,?,?,?)`).run(event.update_id,id,claim,f.now,f.now+300);
  const webhookRequest=new Request(f.serverEnv.MINI_APP_ORIGIN+'/webhook',{method:'POST',headers:{'Content-Type':'application/json',
    'X-Telegram-Bot-Api-Secret-Token':f.serverEnv.WEBHOOK_SECRET},body:JSON.stringify(event)});
  const context=await createFinancialCustomerContext({binding:f.binding,env:f.serverEnv,webhookRequest,receiptClaimToken:claim,nowSeconds:f.now});
  return {packageFinancialContext:context,packageActor:await resolver.resolveActor(context)};
}
async function precheck(f,issued,{id=OWNER,amount=issued.order.amount_stars}={}){
  const event={update_id:next(),pre_checkout_query:{id:'offline-owner-offer-query-'+next(),from:{id,is_bot:false},currency:'XTR',
    total_amount:amount,invoice_payload:issued.order.invoice_payload}};
  let answer;
  const result=await handleStarsPreCheckoutQuery(f.serverEnv,event,{nowSeconds:f.now,...await financial(f,event),
    telegramApi:async(_env,method,payload)=>{assert.equal(method,'answerPreCheckoutQuery');answer=payload;return true;}});
  assert.equal(answer.ok,result.approved);return result;
}
function payment(f,issued,{id=OWNER,amount=issued.order.amount_stars,charge='offline-owner-offer-charge-'+next()}={}){
  return {update_id:next(),message:{message_id:next(),date:f.now,from:{id,is_bot:false},chat:{id,type:'private'},
    successful_payment:{currency:'XTR',total_amount:amount,invoice_payload:issued.order.invoice_payload,
      telegram_payment_charge_id:charge,provider_payment_charge_id:''}}};
}
const record=async(f,event)=>recordStarsSuccessfulPayment(f.serverEnv,event,{receivedAt:f.now,...await financial(f,event)});
const noAccess=f=>{assert.equal(count(f,'subscription_package_periods'),0);assert.equal(count(f,'payment_ledger'),0);
  assert.equal(count(f,'subscription_access_grants'),0);assert.equal(f.sqlite.prepare('SELECT plan_code FROM user_plans WHERE telegram_id=?').get(OWNER).plan_code,'free');};

const sha=value=>createHash('sha256').update(value).digest('hex');
// Reconstruct an already issued historical invoice through the real immutable
// tables, HMAC and admitted→attempted→confirmed SQL guards. No producer or
// authority override can create a new250 quote in this fixture.
async function retained250(f,{state='confirmed'}={}){
  await acceptStarsPurchaseTerms(f.serverEnv,{telegramId:OWNER,telegramUpdateId:next(),acceptedAt:f.now-1});
  const q=await quote(f),orderId=crypto.randomUUID(),requestId=crypto.randomUUID(),url='https://t.me/$offlineHistorical250Invoice',
    payload=await buildStarsInvoicePayload({invoiceSecret:f.serverEnv.STARS_INVOICE_SECRET,orderId,telegramId:OWNER,priceId:OFFER.priceId});
  const metadata={order_id:orderId,telegram_id:OWNER,contract_version:PACKAGE_CONTRACT_VERSION,
    package_code:OFFER.packageCode,duration_days:OFFER.durationDays,period_seconds:OFFER.periodSeconds,price_id:OFFER.priceId,
    price_version:OFFER.priceVersion,plan_code:OFFER.planCode,billing_mode:OFFER.billingMode,currency:OFFER.currency,amount_stars:OFFER.amountStars,
    offer_version:OFFER.offerVersion,campaign_code:OFFER.campaignCode,quoted_starts_at:q.quotedStartsAt,quoted_ends_at:q.quotedEndsAt,
    source_subscription_id:q.sourceSubscriptionId,source_package_period_id:q.sourcePackagePeriodId,source_paid_until:q.sourcePaidUntil,
    source_revision:q.sourceRevision,source_payment_ledger_entry_id:q.sourcePaymentLedgerEntryId,source_fingerprint:q.sourceFingerprint,
    transition_id:null,created_at:f.now};
  f.sqlite.exec('BEGIN');try{
    f.sqlite.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,currency,amount_stars,
      access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,expires_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'created',?,?,?)`).run(orderId,OWNER,OFFER.priceId,OFFER.priceVersion,OFFER.planCode,'XTR',250,
        OFFER.periodSeconds,'prepaid',OFFER.termsRevision,payload,f.now,f.now+900,f.now);
    const keys=Object.keys(metadata);f.sqlite.prepare(`INSERT INTO subscription_package_orders(${keys.join(',')}) VALUES(${keys.map(()=>'?')})`)
      .run(...Object.values(metadata));
    f.sqlite.prepare('INSERT INTO subscription_package_invoice_requests(request_id,order_id,telegram_id,request_sha256,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(requestId,orderId,OWNER,sha(payload),f.now,f.now);
    f.sqlite.prepare("UPDATE subscription_package_invoice_requests SET state='attempted',attempted_count=1,attempted_at=?,revision=2,updated_at=? WHERE request_id=?")
      .run(f.now,f.now,requestId);
    if(state==='confirmed')f.sqlite.prepare("UPDATE subscription_package_invoice_requests SET state='confirmed',invoice_url=?,provider_result_sha256=?,revision=3,updated_at=? WHERE request_id=?")
      .run(url,sha(JSON.stringify(url)),f.now,requestId);
    else {assert.equal(state,'unknown');f.sqlite.prepare("UPDATE subscription_package_invoice_requests SET state='unknown',error_code='offline_unknown',revision=3,updated_at=? WHERE request_id=?").run(f.now,requestId);}
    for(const [type,suffix,reason] of [['order_created','created','server_package_snapshot'],...(state==='confirmed'?[['invoice_issued','issued','telegram_package_invoice']]:[])])
      f.sqlite.prepare(`INSERT INTO payment_events(event_id,event_key,order_id,telegram_id,event_type,outcome,reason_code,payload_sha256,occurred_at,received_at)
        VALUES(?,?,?,?,?,'accepted',?,?,?,?)`).run(crypto.randomUUID(),`package:${orderId}:${suffix}`,orderId,OWNER,type,reason,sha(payload),f.now,f.now);
    f.sqlite.exec('COMMIT');
  }catch(error){f.sqlite.exec('ROLLBACK');throw error;}
  return {result:{status:state==='confirmed'?'issued':'manual_review',amountStars:250,orderId,invoiceURL:state==='confirmed'?url:null,accessApplied:false},
    order:f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(orderId)};
}
async function ownSession(f){
  const candidate='d'.repeat(40);Object.assign(f.serverEnv,{REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',
    REBUILD_V140_RC_SHA:candidate,REBUILD_V140_RELEASE_REVISION:'40',REBUILD_V140_OWNER_WINDOW:'false'});
  f.sqlite.prepare("INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,updated_at) VALUES(1,?,40,'closed',0,?)").run(candidate,f.now);
  const authentication=await verifyTelegramInitData({initData:signed(OWNER,f.now),botToken:BOT_TOKEN,expectedBotId:BOT,nowSeconds:f.now});
  const session=await establishMiniAppSession({authentication,nowSeconds:f.now,persistAtomically:async envelope=>{
    await f.binding.batch(Object.entries(envelope).map(([key,row])=>{const keys=Object.keys(row);return f.binding.prepare(
      `INSERT INTO ${key==='receipt'?'mini_app_init_data_receipts':'mini_app_sessions'}(${keys.map(k=>k.replace(/[A-Z]/gu,c=>'_'+c.toLowerCase())).join(',')}) VALUES(${keys.map(()=>'?')})`).bind(...Object.values(row));}));
    return {accepted:true};
  }});
  return extra=>createCabinetCustomerContext({binding:f.binding,env:f.serverEnv,sessionToken:session.sessionToken,nowSeconds:f.now,
    operation:'access.read_own',channel:'mini_app',...extra});
}
const confirmed=q=>({...REQUEST,confirmation:{acceptedTerms:true,...Object.fromEntries(
  ['amountStars','currency','priceVersion','offerVersion','campaignCode','termsRevision'].map(key=>[key,q[key]]))}});

test('saved signed250 invoice retains precheckout and one immutable90d receipt after campaign closure',async t=>{
  const f=fixture(t);assert.equal((await quote(f)).amountStars,699);
  const issued=await retained250(f);noAccess(f);
  const metadata=f.sqlite.prepare('SELECT * FROM subscription_package_orders WHERE order_id=?').get(issued.order.order_id),
    journal=f.sqlite.prepare('SELECT * FROM subscription_package_invoice_requests WHERE order_id=?').get(issued.order.order_id);
  const restored=await quote(f);assert.equal(restored.amountStars,699);assert.equal(restored.priceId,'professional-90d-prepaid-v2');
  const pending=await subscription(f);assert.equal(pending.pendingInvoices[0].amountStars,250);
  assert.equal(pending.offers.find(row=>row.planCode==='professional'&&row.packageCode==='3m').amountStars,699);
  assert.equal(await isStoredPackageFinancialInvoice(f.serverEnv,issued.order.invoice_payload),true);
  assert.equal((await precheck(f,issued)).approved,true);
  const event=payment(f,issued),first=await record(f,event),again=await record(f,{...event,update_id:next()});
  assert.equal(first.status,'recorded');assert.equal(first.amountStars,250);assert.equal(first.periodEndsAt-first.periodStartsAt,7776000);
  assert.equal(again.status,'duplicate');assert.equal(again.periodId,first.periodId);assert.equal(again.amountStars,250);
  assert.equal(count(f,'subscription_package_periods'),1);assert.equal(count(f,'payment_ledger'),1);
  assert.equal((await applyVerifiedPackagePaidAccess(f.serverEnv,{orderId:first.orderId,appliedAt:f.now})).status,'active');
  const history=await subscription(f);assert.equal(history.paidPeriods[0].amountStars,250);assert.equal(history.paidPeriods[0].durationDays,90);
  assert.equal(f.sqlite.prepare('SELECT amount_stars FROM payment_ledger').get().amount_stars,250);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_package_orders WHERE order_id=?').get(issued.order.order_id),metadata);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_package_invoice_requests WHERE order_id=?').get(issued.order.order_id),journal);
});

test('expiry of the offer window reprices only new quotes while an unexpired original250 invoice still settles',async t=>{
  const f=fixture(t,{now:OFFER.validUntil-5}),issued=await retained250(f);assert.equal(issued.result.amountStars,250);
  f.now=OFFER.validUntil+1;assert.equal((await quote(f)).amountStars,699);
  assert.equal(await isStoredPackageFinancialInvoice(f.serverEnv,issued.order.invoice_payload),true);
  assert.equal((await precheck(f,issued)).approved,true);
  const result=await record(f,payment(f,issued));assert.equal(result.status,'recorded');assert.equal(result.amountStars,250);
  assert.equal(result.periodEndsAt-result.periodStartsAt,7776000);await own(f);
});

test('spoofed amounts, foreign owner and foreign bot cannot turn the test snapshot into a valid payment',async t=>{
  const f=fixture(t),issued=await retained250(f),price=f.sqlite.prepare('SELECT * FROM price_book WHERE price_id=?').get(OFFER.priceId),
    metadata=f.sqlite.prepare('SELECT * FROM subscription_package_orders WHERE order_id=?').get(issued.order.order_id);
  assert.throws(()=>normalizeServerPackagePrice(price),{code:'package_price_amount_invalid'});
  assert.throws(()=>normalizeStoredServerPackagePrice(price,{order:{...issued.order,telegram_id:101},metadata,botId:BOT}));
  assert.equal(await isStoredPackageFinancialInvoice({...f.serverEnv,BOT_TOKEN:'123456789:synthetic-other-bot'},issued.order.invoice_payload),false);
  assert.equal((await precheck(f,issued,{amount:699})).approved,false);
  assert.equal((await precheck(f,issued,{id:101})).approved,false);
  await assert.rejects(record(f,payment(f,issued,{amount:699})),{code:'successful_payment_product_mismatch'});
  await assert.rejects(record(f,payment(f,issued,{id:101})),{code:'successful_payment_product_mismatch'});noAccess(f);
});

test('current verified owner session confirms699v2 invoice once and its payment grants90days',async t=>{
  const f=fixture(t);assert.equal((await quote(f)).amountStars,699);
  const session=await ownSession(f),q=await quote(f),request=confirmed(q),key='8'.repeat(48);let calls=0;
  const issueCurrent=async()=>issuePackageInvoice({actor:await resolver.resolveActor(await session({requestPayload:request,idempotencyKey:key})),
    request,createdAt:f.now},{telegramApi:async(_env,method,payload)=>{
      assert.equal(method,'createInvoiceLink');assert.equal(payload.currency,'XTR');assert.equal(payload.provider_token,'');
      assert.deepEqual(payload.prices,[{label:'Professional · 90 дней',amount:699}]);assert.equal(payload.subscription_period,undefined);
      calls++;return 'https://t.me/$offlineNormal699Invoice';
    }});
  const result=await issueCurrent(),issued={result,order:f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(result.orderId)};
  assert.equal(result.amountStars,699);assert.equal(result.accessApplied,false);assert.equal(issued.order.price_version,2);noAccess(f);
  const duplicate=await issueCurrent();assert.equal(duplicate.duplicate,true);assert.equal(duplicate.orderId,result.orderId);
  assert.equal(duplicate.invoiceURL,result.invoiceURL);assert.equal(calls,1);assert.equal(count(f,'subscription_orders'),1);
  assert.equal((await precheck(f,issued)).approved,true);const event=payment(f,issued),paid=await record(f,event),replay=await record(f,{...event,update_id:next()});
  assert.equal(paid.status,'recorded');assert.equal(paid.amountStars,699);assert.equal(paid.periodEndsAt-paid.periodStartsAt,7776000);
  assert.equal(replay.status,'duplicate');assert.equal(replay.periodId,paid.periodId);
  assert.equal(count(f,'subscription_package_periods'),1);assert.equal(count(f,'payment_ledger'),1);
  assert.equal(f.sqlite.prepare('SELECT amount_stars FROM price_book WHERE price_id=?').get('professional-90d-prepaid-v2').amount_stars,699);
});

test('service reconciliation retains an exact250 historical charge after the offer expires, without paid access',async t=>{
  const f=fixture(t),issued=await retained250(f),paidAt=f.now;f.now=OFFER.validUntil+1;
  const runId='offline-owner-test-reconciliation-'+next();
  f.sqlite.prepare("INSERT INTO payment_reconciliation_runs(run_id,run_source,started_at,updated_at) VALUES(?,'scheduled',?,?)").run(runId,f.now,f.now);
  const context=createServiceExecutor({binding:f.binding,env:f.serverEnv,purpose:'stars_reconcile',clockSeconds:()=>f.now}).createContext();
  const transaction={id:'offline-owner-test-reconciliation-charge-'+next(),amount:250,date:paidAt,source:{type:'user',
    transaction_type:'invoice_payment',user:{id:OWNER,is_bot:false},invoice_payload:issued.order.invoice_payload}},providerPage={transactions:[transaction]};
  const observation=await capturePackageReconciliationObservation({context,runId,providerPage,transaction,observedAt:f.now});
  const first=await recordReconciledPackagePayment(f.serverEnv,transaction,f.now,observation),
    again=await recordReconciledPackagePayment(f.serverEnv,transaction,f.now,observation);
  assert.equal(first.status,'manual_review');assert.equal(first.recovered,true);assert.equal(first.accessApplied,false);
  assert.equal(again.duplicate,true);assert.equal(count(f,'payment_ledger'),1);assert.equal(count(f,'subscription_package_periods'),0);
  const ledger=f.sqlite.prepare('SELECT * FROM payment_ledger').get();assert.equal(ledger.amount_stars,250);
  const retained=await readPackageRetainedReview(f.serverEnv,ledger);assert.equal(retained.order_id,issued.order.order_id);
});

test('expired clean historical250 is closed atomically only to admit a new canonical699 invoice',async t=>{
  const f=fixture(t),old=await retained250(f),metadata=f.sqlite.prepare('SELECT * FROM subscription_package_orders WHERE order_id=?').get(old.order.order_id),
    journal=f.sqlite.prepare('SELECT * FROM subscription_package_invoice_requests WHERE order_id=?').get(old.order.order_id);
  f.now=old.order.expires_at;const q=await quote(f);assert.equal(q.amountStars,699);const session=await ownSession(f);
  const read=await readOwnPackageSubscription({authorization:await createRuntimeAuthorizer().authorize(await session(),null)}),
    offer=read.offers.find(row=>row.planCode==='professional'&&row.packageCode==='3m');
  assert.equal(offer.amountStars,699);assert.equal(offer.available,true);assert.equal(offer.invoice.available,true);
  assert.equal(read.pendingInvoices[0].amountStars,250);assert.equal(read.pendingInvoices[0].state,'expired');
  const request=confirmed(q),actor=await resolver.resolveActor(await session({requestPayload:request,idempotencyKey:'9'.repeat(48)}));
  let calls=0;const result=await issuePackageInvoice({actor,request,createdAt:f.now},{telegramApi:async(_env,method,payload)=>{
    assert.equal(method,'createInvoiceLink');assert.equal(payload.prices[0].amount,699);calls++;return 'https://t.me/$offlineExpiredNormal699';
  }});
  assert.equal(result.amountStars,699);assert.equal(calls,1);assert.equal(count(f,'subscription_orders'),2);noAccess(f);
  assert.deepEqual({...f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(old.order.order_id)},
    {...old.order,order_state:'cancelled',state_revision:2,closed_at:f.now,updated_at:f.now});
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_package_orders WHERE order_id=?').get(old.order.order_id),metadata);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_package_invoice_requests WHERE order_id=?').get(old.order.order_id),journal);
  assert.equal(await isStoredPackageFinancialInvoice(f.serverEnv,old.order.invoice_payload),true);
  assert.equal((await quote(f)).amountStars,699);
});

test('unsafe historical250 evidence prevents closure and any new invoice provider attempt',async t=>{
  for(const variant of ['unknown','precheckout','late_evidence']){
    const f=fixture(t),old=await retained250(f,{state:variant==='unknown'?'unknown':'confirmed'});
    if(variant==='precheckout')assert.equal((await precheck(f,old)).approved,true);
    f.now=old.order.expires_at;
    if(variant==='late_evidence')f.sqlite.prepare(`INSERT INTO payment_events(event_id,event_key,order_id,telegram_id,event_type,outcome,reason_code,payload_sha256,occurred_at,received_at)
      VALUES(?,?,?,?,'successful_payment_received','accepted','offline_late_observation',?,?,?)`).run(crypto.randomUUID(),
        'offline-closed-campaign-late-'+next(),old.order.order_id,OWNER,sha(old.order.invoice_payload),f.now,f.now);
    const prior=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(old.order.order_id);let calls=0;
    await acceptStarsPurchaseTerms(f.serverEnv,{telegramId:OWNER,telegramUpdateId:next(),acceptedAt:f.now-1});
    await assert.rejects(async()=>issuePackageInvoice({actor:(await own(f)).actor,request:REQUEST,telegramUpdateId:next(),createdAt:f.now},
      {telegramApi:async()=>{calls++;return 'https://t.me/$offlineUnsafeMustNotIssue';}}));
    assert.equal(calls,0);assert.equal(count(f,'subscription_orders'),1);
    assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(old.order.order_id),prior);
    assert.equal(count(f,'subscription_package_periods'),0);
  }
});
