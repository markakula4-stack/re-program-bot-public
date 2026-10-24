import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {cabinetSubscriptionFixture,next,MONTH,TERMS_REVISION} from './helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import {signedInitData} from './helpers/v1.4.1-fixtures.mjs';
import {authoritySeconds} from '../src/v1.4.1/authority-resolver.mjs';
import {createCustomerContext,createFinancialCustomerContext,createServiceExecutor} from '../src/v1.4.1/trusted-context.mjs';
import {createCabinetHttp} from '../src/v1.4.0-rebuild/cabinet-http.mjs';
import {createRuntimeAuthorizer,projectRuntimeAccessAuthority} from '../src/v1.4.1/runtime-authorizer.mjs';
import {acceptStarsPurchaseTerms,issueStarsInvoice,handleStarsPreCheckoutQuery,recordStarsSuccessfulPayment} from '../src/v1.3.6/stars-payment-runtime.mjs';
import {applyStarsPaidAccess,assertStarsPurchaseAllowed,requestStarsRefund} from '../src/v1.3.6/stars-access-runtime.mjs';
import {issueStarsRecurringInvoice,requestOwnStarsSubscriptionCommand} from '../src/v1.4.3/telegram-subscription-provider.mjs';
import {authorizeOwnStarsSubscriptionCommand} from '../src/v1.4.3/subscription-action-authority.mjs';
import {handleVerifiedTelegramSubscriptionUpdate} from '../src/v1.4.3/provider-subscription-events.mjs';
import {executePackageCommerceCommand} from '../src/v1.4.4/package-commerce-runtime.mjs';
import {executeMonthlyTransitionCommand,fulfillMonthlyTransitionFromAppliedPayment,readMonthlyTransitionInvoiceAdmission} from '../src/v1.4.4/monthly-transition-runtime.mjs';
import {requestOwnPackageRefund} from '../src/v1.4.4/package-settlement-runtime.mjs';

const stamp=seconds=>new Date(seconds*1000).toISOString().slice(0,19).replace('T',' ');
async function fixture(t,{recurring=false,sourcePlan='professional',targetPlan='dragon'}={}){
  const f=cabinetSubscriptionFixture(t);
  t.mock.timers.enable({apis:['Date'],now:f.now*1000});
  f.sqlite.function('current_timestamp',{deterministic:false},()=>stamp(f.now));
  f.sqlite.function('unixepoch',{deterministic:false,varargs:true},(...args)=>!args.length||args[0]==='now'?f.now:authoritySeconds(args[0]));
  for(const file of ['0069-v1.4.3-d1-compatibility.sql','0070-v1.4.3-refund-notification.sql','0071-v1.4.3-refund-contract-retirement.sql',
    '0072-v1.4.4-package-contract.sql','0073-v1.4.4-package-payment-review.sql'])
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  f.serverEnv={...f.serverEnv,STARS_PACKAGES_ENABLED:'true',STARS_PACKAGE_3M_ENABLED:'true',WEBHOOK_SECRET:'monthly-transition-offline-webhook-secret'};
  for(const table of ['user_plans','user_access_states'])f.sqlite.prepare(table==='user_plans'?
    "INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(900,'free','system_default')":
    "INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(900,'none','system_default')").run();
  f.login=async(id=900)=>{
    const http=createCabinetHttp({repositoryFactory:f.repositoryFactory,clock:()=>f.now});
    const env={...f.serverEnv,OWNER_TELEGRAM_ID:String(id),REBUILD_V140_OWNER_WINDOW:`true:${f.now-1}:${f.now+600}`};
    const response=await http(new Request('https://cabinet.example/api/v1.4.0/cabinet/session',{method:'POST',headers:{
      Origin:'https://cabinet.example','Content-Type':'application/json','Idempotency-Key':'monthly-login-'+next(),'Sec-Fetch-Site':'same-origin'},
      body:JSON.stringify({initData:signedInitData(id,f.now)})}),env);
    const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));f.tokens.set(id,body.sessionToken);
  };
  f.context=async(payload,key='monthly-command-'+next(),id=900)=>createCustomerContext({binding:f.binding,env:f.serverEnv,
    sessionToken:f.tokens.get(id),channel:'mini_app',operation:'access.read_own',requestPayload:payload,idempotencyKey:key});
  f.move=async(at)=>{f.now=at;t.mock.timers.setTime(at*1000);await f.login();};
  f.service=()=>createServiceExecutor({binding:f.binding,env:f.serverEnv,purpose:'stars_process_event',clockSeconds:()=>f.now}).createContext();
  const claims=new Map();
  f.financial=async update=>{
    let claim=claims.get(update.update_id);
    if(!claim){claim=crypto.randomUUID();claims.set(update.update_id,claim);
      f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,received_at,lease_expires_at)
        VALUES(?,'unsupported',900,'processing',?,?,?)`).run(update.update_id,claim,f.now,f.now+60);}
    return createFinancialCustomerContext({binding:f.binding,env:f.serverEnv,receiptClaimToken:claim,nowSeconds:f.now,
      webhookRequest:new Request(f.serverEnv.MINI_APP_ORIGIN+'/webhook',{method:'POST',headers:{'Content-Type':'application/json',
        'X-Telegram-Bot-Api-Secret-Token':f.serverEnv.WEBHOOK_SECRET},body:JSON.stringify(update)})});
  };
  await f.login();
  let invoice;
  if(recurring){
    const context=await createCustomerContext({binding:f.binding,env:f.serverEnv,sessionToken:f.tokens.get(900),channel:'mini_app',
      operation:'billing.purchase_monthly',requestPayload:{action:'accept',requestedPlanCode:sourcePlan,billingMode:'recurring',
      recurringConsent:true,termsRevision:TERMS_REVISION,priceVersion:1},idempotencyKey:'old-monthly-'+next()});
    invoice=await issueStarsRecurringInvoice(await createRuntimeAuthorizer().authorize(context),{telegramApi:async()=> 'https://t.me/$oldMonthly'});
  }else{
    await acceptStarsPurchaseTerms(f.serverEnv,{telegramId:900,telegramUpdateId:next()});
    invoice=await issueStarsInvoice(f.serverEnv,{telegramId:900,requestedPlanCode:sourcePlan,telegramUpdateId:next()},
      {telegramApi:async()=>({message_id:next()})});
  }
  const order=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(invoice.orderId);
  await handleStarsPreCheckoutQuery(f.serverEnv,{update_id:next(),pre_checkout_query:{id:'old-query-'+next(),from:{id:900,is_bot:false},
    currency:'XTR',total_amount:order.amount_stars,invoice_payload:order.invoice_payload}},{telegramApi:async()=>true});
  const oldUpdate=payment(f,order,{recurring,expiration:f.now+MONTH}),old=await recordStarsSuccessfulPayment(f.serverEnv,oldUpdate);
  assert.equal((await applyStarsPaidAccess(f.serverEnv,{orderId:old.orderId})).accessApplied,true);
  f.old={invoice,order,payment:old,end:f.now+MONTH};
  if(recurring){
    const contract=f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(invoice.contractId);
    const context=await f.context({subscriptionAction:'cancel_renewal',contractId:contract.contract_id,expectedRevision:contract.revision});
    const token=await authorizeOwnStarsSubscriptionCommand(await createRuntimeAuthorizer().authorize(context));
    assert.equal((await requestOwnStarsSubscriptionCommand(token,{telegramApi:async()=>true})).cancellationConfirmed,true);
  }
  f.schedule=async()=>executePackageCommerceCommand(await f.context({requestedPlanCode:targetPlan,packageCode:'30d'}),'schedule');
  f.consent=transition=>({transitionId:transition.transitionId,expectedRevision:transition.revision,recurringConsent:true,
    termsRevision:TERMS_REVISION,priceVersion:1});
  return f;
}
function payment(f,order,{recurring=true,expiration=f.now+MONTH,first=true}={}){
  return {update_id:next(),message:{message_id:next(),date:f.now,from:{id:900,is_bot:false},chat:{id:900,type:'private'},
    successful_payment:{currency:'XTR',total_amount:order.amount_stars,invoice_payload:order.invoice_payload,
      telegram_payment_charge_id:'monthly-charge-'+next(),provider_payment_charge_id:'',...(recurring?{
        is_recurring:true,is_first_recurring:first,subscription_expiration_date:expiration}:{})}}};
}
async function control(f,state='canceled'){
  f.serverEnv.WEBHOOK_SECRET='monthly-transition-offline-webhook-secret';
  const update={update_id:next(),subscription:{user:{id:900,is_bot:false},invoice_payload:f.old.order.invoice_payload,state}},claim=crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,received_at,lease_expires_at)
    VALUES(?,'unsupported',900,'processing',?,?,?)`).run(update.update_id,claim,f.now,f.now+60);
  return handleVerifiedTelegramSubscriptionUpdate({webhookRequest:new Request('https://worker.example/webhook',{method:'POST',headers:{
    'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':f.serverEnv.WEBHOOK_SECRET},body:JSON.stringify(update)}),
    serviceContext:await f.service(),receiptClaimToken:claim});
}
const count=(f,table)=>f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
async function freshOrdinaryInvoice(f,plan='professional'){
  const context=await createCustomerContext({binding:f.binding,env:f.serverEnv,sessionToken:f.tokens.get(900),channel:'mini_app',
    operation:'billing.purchase_monthly',requestPayload:{action:'accept',requestedPlanCode:plan,billingMode:'recurring',
      recurringConsent:true,termsRevision:TERMS_REVISION,priceVersion:1},idempotencyKey:'fresh-ordinary-monthly-'+next()});
  return issueStarsRecurringInvoice(await createRuntimeAuthorizer().authorize(context),{telegramApi:async()=> 'https://t.me/$freshOrdinaryMonthly'});
}
async function ownRetainedRefund(f,ledgerEntryId,options={}){
  f.serverEnv={...f.serverEnv,STARS_REFUNDS_ENABLED:'false',STARS_PACKAGE_REFUNDS_ENABLED:'true'};
  const payload={ledgerEntryId},context=await createCustomerContext({binding:f.binding,env:f.serverEnv,sessionToken:f.tokens.get(900),
    channel:'mini_app',operation:'admin.stars.refund',requestPayload:payload,idempotencyKey:'own-monthly-refund-'+next()});
  return requestOwnPackageRefund(context,payload,options);
}

test('monthly intent reserves compatible metadata without provider call or transferred consent; early invoice cannot charge',async t=>{
  const f=await fixture(t),before=f.sqlite.prepare('SELECT * FROM subscriptions').all(),scheduled=await f.schedule();
  const metadata=f.sqlite.prepare('SELECT * FROM subscription_package_orders').get(),order=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(metadata.order_id);
  assert.equal(metadata.created_at,f.now);assert.ok(metadata.created_at<metadata.source_paid_until);
  assert.equal(metadata.quoted_starts_at,f.old.end);assert.equal(order.expires_at,f.old.end+900);
  assert.equal(order.order_state,'created');assert.equal(count(f,'subscription_billing_contracts'),0);
  assert.equal(count(f,'subscription_invoice_requests'),0);assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscriptions').all(),before);
  await assert.rejects(async()=>executeMonthlyTransitionCommand(await f.context(f.consent(scheduled.transition)),{telegramApi:async()=>assert.fail('early provider call')}),
    error=>error.code==='package_monthly_invoice_not_due');
  const earlyCheckout={update_id:next(),pre_checkout_query:{id:'reserved-early-'+next(),
    from:{id:900,is_bot:false},currency:'XTR',total_amount:499,invoice_payload:order.invoice_payload}};
  const precheck=await handleStarsPreCheckoutQuery(f.serverEnv,earlyCheckout,{telegramApi:async()=>true,
    packageFinancialContext:await f.financial(earlyCheckout)});
  assert.equal(precheck.approved,false);assert.equal(count(f,'payment_ledger'),1);
});

test('boundary fresh consent uses real recurring invoice and old payment/access producer, then fulfills once and frees intent slot',async t=>{
  const f=await fixture(t),scheduled=await f.schedule(),before=f.sqlite.prepare('SELECT * FROM subscriptions').all(),calls=[];
  await f.move(f.old.end);
  const context=await f.context(f.consent(scheduled.transition),'boundary-fixed-idempotency-'+next());
  const invoice=await executeMonthlyTransitionCommand(context,{telegramApi:async(_env,method,payload)=>{calls.push({method,payload});return 'https://t.me/$freshDragonMonthly';}});
  assert.equal(invoice.status,'confirmed');assert.equal(calls.length,1);assert.equal(calls[0].method,'createInvoiceLink');
  assert.equal(calls[0].payload.prices[0].amount,499);assert.equal(calls[0].payload.subscription_period,MONTH);
  assert.equal(calls[0].payload.future_start,undefined);
  const expired=f.sqlite.prepare('SELECT * FROM subscriptions').get();assert.equal(expired.status,'expired');
  assert.equal(expired.current_period_start,before[0].current_period_start);assert.equal(expired.current_period_end,before[0].current_period_end);
  assert.equal(expired.last_ledger_entry_id,before[0].last_ledger_entry_id);assert.equal(count(f,'payment_ledger'),1);
  const replay=await executeMonthlyTransitionCommand(context,{telegramApi:async()=>assert.fail('invoice replay called provider')});
  assert.equal(replay.replayed,true);assert.equal(replay.orderId,invoice.orderId);
  const order=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(invoice.orderId);
  const checkout={update_id:next(),pre_checkout_query:{id:'boundary-'+next(),
    from:{id:900,is_bot:false},currency:'XTR',total_amount:499,invoice_payload:order.invoice_payload}};
  assert.equal((await handleStarsPreCheckoutQuery(f.serverEnv,checkout,
    {telegramApi:async()=>true,purchaseGuard:assertStarsPurchaseAllowed,packageFinancialContext:await f.financial(checkout)})).approved,true);
  const update=payment(f,order),paid=await recordStarsSuccessfulPayment(f.serverEnv,update,{packageFinancialContext:await f.financial(update)}),
    applied=await applyStarsPaidAccess(f.serverEnv,{orderId:paid.orderId});
  assert.equal(applied.accessApplied,true);assert.equal(paid.packagePayment,undefined);
  const fulfilled=await fulfillMonthlyTransitionFromAppliedPayment(await f.service(),{orderId:paid.orderId});assert.equal(fulfilled.fulfilled,true);
  const transition=f.sqlite.prepare('SELECT * FROM subscription_plan_transitions').get();assert.equal(transition.state,'fulfilled');
  assert.equal(transition.target_order_id,order.order_id);assert.equal(transition.target_grant_id,applied.grantId);assert.equal(transition.revision,2);
  assert.equal((await fulfillMonthlyTransitionFromAppliedPayment(await f.service(),{orderId:paid.orderId})).replayed,true);
  assert.equal(f.sqlite.prepare('SELECT revision FROM subscription_plan_transitions').get().revision,2);
  const fulfilledReplay=await executeMonthlyTransitionCommand(context,{telegramApi:async()=>assert.fail('fulfilled replay called provider')});
  assert.equal(fulfilledReplay.transitionFulfilled,true);assert.equal(fulfilledReplay.orderId,invoice.orderId);
  const duplicate=await recordStarsSuccessfulPayment(f.serverEnv,update,{packageFinancialContext:await f.financial(update)});assert.equal(duplicate.status,'duplicate');
  assert.equal(count(f,'subscription_access_grants'),2);assert.equal(count(f,'payment_ledger'),2);
  const nextIntent=await f.schedule();assert.equal(nextIntent.transition.state,'scheduled');assert.notEqual(nextIntent.transition.transitionId,transition.transition_id);
});

test('cancel ACK alone keeps old contract open; genuine canceled provider observation permits safe retirement and new monthly invoice',async t=>{
  const f=await fixture(t,{recurring:true}),scheduled=await f.schedule(),oldContract=f.sqlite.prepare('SELECT * FROM subscription_billing_contracts').get();
  await f.move(f.old.end);
  await assert.rejects(async()=>executeMonthlyTransitionCommand(await f.context(f.consent(scheduled.transition)),{telegramApi:async()=>assert.fail('ACK-only invoice')}),
    error=>error.code==='monthly_old_contract_provider_confirmation_required');
  assert.equal(f.sqlite.prepare('SELECT retired_at FROM subscription_billing_contracts').get().retired_at,null);
  await control(f);const recorded=f.sqlite.prepare('SELECT * FROM subscription_billing_contracts').get();assert.equal(recorded.provider_state,'canceled');
  const invoice=await executeMonthlyTransitionCommand(await f.context(f.consent(scheduled.transition)),{telegramApi:async()=> 'https://t.me/$afterRealCanceledControl'});
  assert.equal(invoice.status,'confirmed');const retired=f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(oldContract.contract_id);
  assert.ok(retired.retired_at);assert.equal(retired.first_payment_ledger_entry_id,oldContract.first_payment_ledger_entry_id);
  assert.equal(retired.external_invoice_payload,oldContract.external_invoice_payload);assert.equal(count(f,'payment_ledger'),1);
});

test('unpaid reservation and confirmed uncharged monthly invoice can be canceled without erasing the contract',async t=>{
  const f=await fixture(t),scheduled=await f.schedule();
  const canceled=await executePackageCommerceCommand(await f.context({transitionId:scheduled.transition.transitionId,expectedRevision:1}),'cancel');
  assert.equal(canceled.transition.state,'cancelled');assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE billing_mode=\'recurring\'').get().order_state,'cancelled');
  const nextIntent=await f.schedule();await f.move(f.old.end);
  const invoice=await executeMonthlyTransitionCommand(await f.context(f.consent(nextIntent.transition)),{telegramApi:async()=> 'https://t.me/$confirmedUncharged'});
  const result=await executePackageCommerceCommand(await f.context({transitionId:nextIntent.transition.transitionId,expectedRevision:1}),'cancel');
  assert.equal(result.transition.state,'cancelled');
  const order=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(invoice.orderId);assert.equal(order.order_state,'cancelled');
  const contract=f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(invoice.contractId);
  assert.equal(contract.first_payment_ledger_entry_id,null);assert.equal(contract.retired_at,null);assert.equal(contract.provider_state,'unconfirmed');
  const canceledCheckout={update_id:next(),pre_checkout_query:{id:'canceled-monthly-'+next(),
    from:{id:900,is_bot:false},currency:'XTR',total_amount:499,invoice_payload:order.invoice_payload}};
  assert.equal((await handleStarsPreCheckoutQuery(f.serverEnv,canceledCheckout,
    {telegramApi:async()=>true,purchaseGuard:assertStarsPurchaseAllowed,packageFinancialContext:await f.financial(canceledCheckout)})).approved,false);
  assert.equal(count(f,'payment_ledger'),1);assert.equal(count(f,'subscription_access_grants'),1);
  const update=payment(f,order),late=await recordStarsSuccessfulPayment(f.serverEnv,update,{packageFinancialContext:await f.financial(update)});
  assert.equal(late.status,'manual_review');assert.equal(late.reason,'package_monthly_transition_cancelled');
  assert.equal(count(f,'payment_ledger'),2);assert.equal(count(f,'subscription_access_grants'),1);
  assert.equal((await fulfillMonthlyTransitionFromAppliedPayment(await f.service(),{orderId:late.orderId})).fulfilled,false);
  const repeated=await recordStarsSuccessfulPayment(f.serverEnv,update,{packageFinancialContext:await f.financial(update)});
  assert.equal(repeated.duplicate,true);assert.equal(count(f,'payment_ledger'),2);
  const sourceGrant=f.sqlite.prepare('SELECT * FROM subscription_access_grants').get(),calls=[];
  const refunded=await ownRetainedRefund(f,late.ledgerEntryId,{telegramApi:async(_env,method,payload)=>{calls.push({method,payload});return true;}});
  assert.equal(refunded.refunded,true);assert.deepEqual(calls.map(call=>call.method),['refundStarPayment']);
  assert.equal(calls[0].payload.telegram_payment_charge_id,update.message.successful_payment.telegram_payment_charge_id);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_access_grants').get(),sourceGrant);
  assert.equal((await ownRetainedRefund(f,late.ledgerEntryId,{telegramApi:async()=>assert.fail('retained refund repeated')})).refunded,true);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM payment_ledger WHERE entry_type='refund'").get().n,1);
});

test('copied admission and raw context cannot select an invoice or fulfill transition',async t=>{
  const f=await fixture(t),scheduled=await f.schedule();
  assert.throws(()=>readMonthlyTransitionInvoiceAdmission({version:1},{}),/untrusted/u);
  await assert.rejects(()=>executeMonthlyTransitionCommand({telegramId:900,requestPayload:f.consent(scheduled.transition)}));
  await assert.rejects(()=>fulfillMonthlyTransitionFromAppliedPayment({actorKind:'service',executorPurpose:'stars_process_event'},{orderId:f.old.order.order_id}));
  assert.equal(count(f,'subscription_billing_contracts'),0);
});

test('unknown monthly invoice remains one durable attempt; fresh key cannot create another contract',async t=>{
  const f=await fixture(t),scheduled=await f.schedule();await f.move(f.old.end);let calls=0;
  const context=await f.context(f.consent(scheduled.transition),'unknown-monthly-fixed-'+next());
  const first=await executeMonthlyTransitionCommand(context,{telegramApi:async()=>{calls++;throw Object.assign(new Error('lost provider response'),{ambiguous:true});}});
  assert.equal(first.status,'unknown');assert.equal(first.invoiceUrl,null);assert.equal(first.reviewRequired,true);
  const second=await executeMonthlyTransitionCommand(context,{telegramApi:async()=>assert.fail('unknown attempt repeated')});assert.equal(second.status,'unknown');
  await assert.rejects(async()=>executeMonthlyTransitionCommand(await f.context(f.consent(scheduled.transition)),{telegramApi:async()=>assert.fail('fresh conflicting provider call')}),
    error=>error.code==='monthly_transition_invoice_idempotency_collision');
  assert.equal(calls,1);assert.equal(count(f,'subscription_billing_contracts'),1);assert.equal(count(f,'subscription_invoice_requests'),1);
  assert.equal(f.sqlite.prepare('SELECT state FROM subscription_plan_transitions').get().state,'scheduled');
  await assert.rejects(async()=>executePackageCommerceCommand(await f.context({transitionId:scheduled.transition.transitionId,expectedRevision:1}),'cancel'),
    error=>error.code==='monthly_transition_invoice_review_required');
});

test('fresh consent rejects client economics, missing consent, foreign owner, and expired reservation',async t=>{
  const f=await fixture(t),scheduled=await f.schedule();await f.move(f.old.end);
  for(const payload of [{...f.consent(scheduled.transition),amountStars:1},{...f.consent(scheduled.transition),recurringConsent:false}])
    await assert.rejects(async()=>executeMonthlyTransitionCommand(await f.context(payload),{telegramApi:async()=>assert.fail('invalid consent provider call')}),
      error=>error.code==='monthly_transition_consent_required');
  await f.login(101);await assert.rejects(async()=>executeMonthlyTransitionCommand(await f.context(f.consent(scheduled.transition),undefined,101),
    {telegramApi:async()=>assert.fail('foreign invoice')}),error=>error.code==='monthly_transition_authority_required');
  await f.move(f.old.end+901);await assert.rejects(async()=>executeMonthlyTransitionCommand(await f.context(f.consent(scheduled.transition)),
    {telegramApi:async()=>assert.fail('expired invoice')}),error=>error.code==='monthly_reservation_expired_or_closed');
  assert.equal(count(f,'subscription_billing_contracts'),0);assert.equal(count(f,'subscription_invoice_requests'),0);
});

test('a genuine compensation of the scheduled source prevents a fresh monthly contract without erasing refund history',async t=>{
  const f=await fixture(t),scheduled=await f.schedule();
  const original=f.sqlite.prepare("SELECT * FROM payment_ledger WHERE entry_type='payment'").get();
  const refunded=await requestStarsRefund(f.serverEnv,{adminTelegramId:900,telegramPaymentChargeId:original.telegram_payment_charge_id,
    reasonCode:'confirmed_customer_refund'},{telegramApi:async()=>true});assert.equal(refunded.refunded,true);
  await f.move(f.old.end);
  await assert.rejects(async()=>executeMonthlyTransitionCommand(await f.context(f.consent(scheduled.transition)),
    {telegramApi:async()=>assert.fail('compensated source invoice')}),error=>error.code==='monthly_transition_source_compensated');
  assert.equal(count(f,'subscription_billing_contracts'),0);assert.equal(count(f,'subscription_invoice_requests'),0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM payment_ledger WHERE entry_type='refund'").get().n,1);
  assert.equal(f.sqlite.prepare('SELECT state FROM subscription_plan_transitions').get().state,'scheduled');
});

test('a genuine old renewal inside boundary expiry rolls back new invoice admission and preserves the new incoming credit',async t=>{
  const f=await fixture(t,{recurring:true}),scheduled=await f.schedule();await f.move(f.old.end);await control(f);
  const context=await f.context(f.consent(scheduled.transition)),renewal=payment(f,f.old.order,{first:false,expiration:f.old.end+MONTH});
  let retained;
  const beforeExpiry=async({statements})=>{
    // Actor resolution now uses a read-only batch before the expiry write.
    // Keep the one-shot hook armed until the intended interleaving occurs.
    if (!statements.some(statement=>statement.sql.includes('UPDATE subscriptions'))) {
      f.binding.beforeBatch=beforeExpiry;
      return;
    }
    retained=await recordStarsSuccessfulPayment(f.serverEnv,renewal,{packageFinancialContext:await f.financial(renewal)});
  };
  f.binding.beforeBatch=beforeExpiry;
  await assert.rejects(()=>executeMonthlyTransitionCommand(context,{telegramApi:async()=>assert.fail('renewal race created invoice')}));
  assert.ok(retained, 'renewal must actually be injected at the expiry write');
  assert.ok(['recorded','manual_review'].includes(retained.status));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM payment_ledger WHERE entry_type='payment'").get().n,2);
  assert.equal(count(f,'subscription_invoice_requests'),1,'only original recurring invoice exists');
  assert.equal(count(f,'subscription_billing_contracts'),1);assert.equal(f.sqlite.prepare('SELECT retired_at FROM subscription_billing_contracts').get().retired_at,null);
  assert.equal(f.sqlite.prepare('SELECT state FROM subscription_plan_transitions').get().state,'scheduled');
  assert.equal(count(f,'mini_app_atomic_guards'),0);
});

test('a real later re-enable command keeps a scheduled monthly change in review without creating another contract',async t=>{
  const f=await fixture(t,{recurring:true}),scheduled=await f.schedule();
  const contract=f.sqlite.prepare('SELECT * FROM subscription_billing_contracts').get();
  const context=await f.context({subscriptionAction:'reenable_renewal',contractId:contract.contract_id,expectedRevision:contract.revision});
  const token=await authorizeOwnStarsSubscriptionCommand(await createRuntimeAuthorizer().authorize(context));
  const command=await requestOwnStarsSubscriptionCommand(token,{telegramApi:async()=>true});assert.equal(command.reenableAllowed,true);
  await f.move(f.old.end);
  await assert.rejects(async()=>executeMonthlyTransitionCommand(await f.context(f.consent(scheduled.transition)),
    {telegramApi:async()=>assert.fail('re-enabled source created invoice')}));
  assert.equal(count(f,'subscription_billing_contracts'),1);assert.equal(f.sqlite.prepare('SELECT retired_at FROM subscription_billing_contracts').get().retired_at,null);
  assert.equal(count(f,'payment_ledger'),1);
});

test('Dragon to Professional monthly uses server 249 Stars and retains old paid financial evidence',async t=>{
  const f=await fixture(t,{recurring:true,sourcePlan:'dragon',targetPlan:'professional'}),scheduled=await f.schedule();
  const oldPaid=f.sqlite.prepare("SELECT * FROM payment_ledger WHERE entry_type='payment'").get(),oldGrant=f.sqlite.prepare('SELECT * FROM subscription_access_grants').get();
  await f.move(f.old.end);await control(f);const calls=[];
  const invoice=await executeMonthlyTransitionCommand(await f.context(f.consent(scheduled.transition)),{telegramApi:async(_env,method,payload)=>{
    calls.push({method,payload});return 'https://t.me/$professionalMonthly249';}});
  assert.equal(invoice.status,'confirmed');assert.equal(calls[0].payload.prices[0].amount,249);
  assert.equal(calls[0].payload.subscription_period,MONTH);assert.equal(f.sqlite.prepare('SELECT plan_code FROM subscription_orders WHERE order_id=?').get(invoice.orderId).plan_code,'professional');
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM payment_ledger WHERE ledger_entry_id=?').get(oldPaid.ledger_entry_id),oldPaid);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE grant_id=?').get(oldGrant.grant_id),oldGrant);
});

test('overdue reservation can be canceled and replaced by a fresh ordinary consent/invoice with a standard TTL',async t=>{
  const f=await fixture(t),scheduled=await f.schedule();await f.move(f.old.end+901);
  await assert.rejects(async()=>executeMonthlyTransitionCommand(await f.context(f.consent(scheduled.transition)),
    {telegramApi:async()=>assert.fail('overdue reservation invoice')}),error=>error.code==='monthly_reservation_expired_or_closed');
  await executePackageCommerceCommand(await f.context({transitionId:scheduled.transition.transitionId,expectedRevision:1}),'cancel');
  const fresh=await freshOrdinaryInvoice(f,'dragon'),order=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(fresh.orderId);
  assert.equal(fresh.status,'confirmed');assert.equal(order.created_at,f.now);assert.equal(order.expires_at,f.now+900);
  assert.equal(order.amount_stars,499);assert.equal(f.sqlite.prepare('SELECT status FROM subscriptions').get().status,'expired');
  assert.equal((await handleStarsPreCheckoutQuery(f.serverEnv,{update_id:next(),pre_checkout_query:{id:'overdue-replaced-'+next(),
    from:{id:900,is_bot:false},currency:'XTR',total_amount:499,invoice_payload:order.invoice_payload}},
    {telegramApi:async()=>true,purchaseGuard:assertStarsPurchaseAllowed})).approved,true);
});

test('confirmed uncharged cancellation waits for its existing expiry, safely retires, and a late old charge leaves new paid access intact',async t=>{
  const f=await fixture(t),scheduled=await f.schedule();await f.move(f.old.end);
  const canceledInvoice=await executeMonthlyTransitionCommand(await f.context(f.consent(scheduled.transition)),
    {telegramApi:async()=> 'https://t.me/$laterCanceledUncharged'}),canceledOrder=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(canceledInvoice.orderId);
  await executePackageCommerceCommand(await f.context({transitionId:scheduled.transition.transitionId,expectedRevision:1}),'cancel');
  await assert.rejects(()=>freshOrdinaryInvoice(f));
  assert.equal(f.sqlite.prepare('SELECT retired_at FROM subscription_billing_contracts').get().retired_at,null);
  await f.move(canceledOrder.expires_at);
  const fresh=await freshOrdinaryInvoice(f),freshOrder=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(fresh.orderId);
  assert.equal(fresh.status,'confirmed');const retired=f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(canceledInvoice.contractId);
  assert.ok(retired.retired_at);assert.equal(retired.first_payment_ledger_entry_id,null);assert.equal(retired.provider_state,'unconfirmed');
  assert.equal((await handleStarsPreCheckoutQuery(f.serverEnv,{update_id:next(),pre_checkout_query:{id:'replacement-professional-'+next(),
    from:{id:900,is_bot:false},currency:'XTR',total_amount:249,invoice_payload:freshOrder.invoice_payload}},
    {telegramApi:async()=>true,purchaseGuard:assertStarsPurchaseAllowed})).approved,true);
  const current=await recordStarsSuccessfulPayment(f.serverEnv,payment(f,freshOrder));
  assert.equal((await applyStarsPaidAccess(f.serverEnv,{orderId:current.orderId})).accessApplied,true);
  const projection=f.sqlite.prepare('SELECT * FROM user_plans WHERE telegram_id=900').get();assert.equal(projection.plan_code,'professional');
  const lateUpdate=payment(f,canceledOrder),late=await recordStarsSuccessfulPayment(f.serverEnv,lateUpdate,{packageFinancialContext:await f.financial(lateUpdate)});
  assert.equal(late.status,'manual_review');assert.equal(late.reason,'package_monthly_transition_cancelled');
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM user_plans WHERE telegram_id=900').get(),projection);
  const access=projectRuntimeAccessAuthority(await createRuntimeAuthorizer().authorize(await f.context({})));
  assert.equal(access.planCode,'professional');assert.equal(access.paidCapabilitiesEnabled,true);
  assert.equal(count(f,'subscription_access_grants'),2);assert.equal(count(f,'payment_ledger'),3);
  assert.equal(f.sqlite.prepare('SELECT state FROM subscription_plan_transitions').get().state,'cancelled');
  const grants=f.sqlite.prepare('SELECT * FROM subscription_access_grants ORDER BY grant_id').all();
  assert.equal((await ownRetainedRefund(f,late.ledgerEntryId,{telegramApi:async()=>true})).refunded,true);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_access_grants ORDER BY grant_id').all(),grants);
  const afterRefund=projectRuntimeAccessAuthority(await createRuntimeAuthorizer().authorize(await f.context({})));
  assert.equal(afterRefund.planCode,'professional');assert.equal(afterRefund.paidCapabilitiesEnabled,true);
});

for(const stage of ['before_checkout','after_checkout','inside_payment_batch'])test(`source compensation ${stage} denies checkout or retains a genuine new monthly charge without fulfillment`,async t=>{
  const f=await fixture(t),scheduled=await f.schedule(),oldPaid=f.sqlite.prepare("SELECT * FROM payment_ledger WHERE entry_type='payment'").get();
  await f.move(f.old.end);
  const invoice=await executeMonthlyTransitionCommand(await f.context(f.consent(scheduled.transition)),{telegramApi:async()=> 'https://t.me/$sourceCompensationScenario'}),
    order=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(invoice.orderId);
  const refund=()=>requestStarsRefund(f.serverEnv,{adminTelegramId:900,telegramPaymentChargeId:oldPaid.telegram_payment_charge_id,
    reasonCode:'confirmed_customer_refund'},{telegramApi:async()=>true});
  if(stage==='before_checkout')assert.equal((await refund()).refunded,true);
  const checkout={update_id:next(),pre_checkout_query:{id:'source-freshness-'+next(),from:{id:900,is_bot:false},currency:'XTR',
    total_amount:499,invoice_payload:order.invoice_payload}};
  const precheck=await handleStarsPreCheckoutQuery(f.serverEnv,checkout,{telegramApi:async()=>true,purchaseGuard:assertStarsPurchaseAllowed,
    packageFinancialContext:await f.financial(checkout)});
  assert.equal(precheck.approved,stage!=='before_checkout');
  if(stage==='after_checkout')assert.equal((await refund()).refunded,true);
  const update=payment(f,order),financialContext=await f.financial(update);
  if(stage==='inside_payment_batch')f.binding.beforeBatch=async()=>{assert.equal((await refund()).refunded,true);};
  const paid=await recordStarsSuccessfulPayment(f.serverEnv,update,{packageFinancialContext:financialContext});
  assert.equal(paid.status,'manual_review');assert.equal(paid.reason,'package_monthly_transition_source_compensated');
  assert.equal(count(f,'subscription_access_grants'),1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM payment_ledger WHERE entry_type='payment'").get().n,2);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM payment_ledger WHERE entry_type='refund'").get().n,1);
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(order.order_id).order_state,'failed');
  assert.equal((await fulfillMonthlyTransitionFromAppliedPayment(await f.service(),{orderId:order.order_id})).fulfilled,false);
  assert.equal(f.sqlite.prepare('SELECT state FROM subscription_plan_transitions').get().state,'scheduled');
  const repeated=await recordStarsSuccessfulPayment(f.serverEnv,update,{packageFinancialContext:financialContext});assert.equal(repeated.duplicate,true);
  assert.equal(count(f,'mini_app_atomic_guards'),0);
  await assert.rejects(async()=>executePackageCommerceCommand(await f.context({transitionId:scheduled.transition.transitionId,expectedRevision:1}),'cancel'));
  const oldSourceGrant=f.sqlite.prepare('SELECT * FROM subscription_access_grants').get();
  assert.equal((await ownRetainedRefund(f,paid.ledgerEntryId,{telegramApi:async()=>true})).refunded,true);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_access_grants').get(),oldSourceGrant);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM payment_ledger WHERE entry_type='refund'").get().n,2);
});

test('source compensated retained charge remains owner refundable when the unpaid intent is canceled during its payment batch',async t=>{
  const f=await fixture(t),scheduled=await f.schedule(),oldPaid=f.sqlite.prepare("SELECT * FROM payment_ledger WHERE entry_type='payment'").get();
  await f.move(f.old.end);
  const invoice=await executeMonthlyTransitionCommand(await f.context(f.consent(scheduled.transition)),
    {telegramApi:async()=> 'https://t.me/$sourceCompensatedCancellationRace'}),
    order=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(invoice.orderId);
  assert.equal((await requestStarsRefund(f.serverEnv,{adminTelegramId:900,telegramPaymentChargeId:oldPaid.telegram_payment_charge_id,
    reasonCode:'confirmed_customer_refund'},{telegramApi:async()=>true})).refunded,true);
  const checkout={update_id:next(),pre_checkout_query:{id:'source-cancel-race-'+next(),from:{id:900,is_bot:false},currency:'XTR',
    total_amount:499,invoice_payload:order.invoice_payload}};
  assert.equal((await handleStarsPreCheckoutQuery(f.serverEnv,checkout,{telegramApi:async()=>true,purchaseGuard:assertStarsPurchaseAllowed,
    packageFinancialContext:await f.financial(checkout)})).approved,false);
  const update=payment(f,order),financialContext=await f.financial(update),
    cancelContext=await f.context({transitionId:scheduled.transition.transitionId,expectedRevision:1});
  f.binding.beforeBatch=async()=>{
    const canceled=await executePackageCommerceCommand(cancelContext,'cancel');
    assert.equal(canceled.transition.state,'cancelled');
  };
  const paid=await recordStarsSuccessfulPayment(f.serverEnv,update,{packageFinancialContext:financialContext});
  assert.equal(paid.status,'manual_review');assert.equal(paid.reason,'package_monthly_transition_source_compensated');
  assert.equal(f.sqlite.prepare('SELECT state FROM subscription_plan_transitions').get().state,'cancelled');
  assert.equal(count(f,'subscription_access_grants'),1);
  const sourceGrant=f.sqlite.prepare('SELECT * FROM subscription_access_grants').get(),calls=[];
  const refunded=await ownRetainedRefund(f,paid.ledgerEntryId,{telegramApi:async(_env,method,payload)=>{calls.push({method,payload});return true;}});
  assert.equal(refunded.refunded,true);assert.equal(calls.length,1);assert.equal(calls[0].method,'refundStarPayment');
  assert.equal(calls[0].payload.telegram_payment_charge_id,update.message.successful_payment.telegram_payment_charge_id);
  assert.equal((await ownRetainedRefund(f,paid.ledgerEntryId,{telegramApi:async()=>assert.fail('retained refund replay called provider')})).refunded,true);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_access_grants').get(),sourceGrant);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM payment_ledger WHERE entry_type='refund'").get().n,2);
  assert.equal((await recordStarsSuccessfulPayment(f.serverEnv,update,{packageFinancialContext:financialContext})).duplicate,true);
  assert.equal((await fulfillMonthlyTransitionFromAppliedPayment(await f.service(),{orderId:order.order_id})).fulfilled,false);
});
