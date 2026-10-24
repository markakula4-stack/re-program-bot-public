import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { cabinetSubscriptionFixture } from './helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import { createCustomerContext,createServiceExecutor } from '../src/v1.4.1/trusted-context.mjs';
import { createRuntimeAuthorizer,requireRuntimeAuthorization } from '../src/v1.4.1/runtime-authorizer.mjs';
import { authoritySeconds } from '../src/v1.4.1/authority-resolver.mjs';
import { authorizeOwnStarsSubscriptionCommand } from '../src/v1.4.3/subscription-action-authority.mjs';
import { issueStarsRecurringInvoice,requestOwnStarsSubscriptionCommand } from '../src/v1.4.3/telegram-subscription-provider.mjs';
import { STARS_RECURRING_TERMS_REVISION as TERMS } from '../src/v1.4.3/recurring-provider-config.mjs';
import { recordStarsSuccessfulPayment,handleStarsPreCheckoutQuery } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsPaidAccess,applyStarsCompensation,requestStarsRefund } from '../src/v1.3.6/stars-access-runtime.mjs';
import { handleVerifiedTelegramSubscriptionUpdate } from '../src/v1.4.3/provider-subscription-events.mjs';
import { runPaidSubscriptionNotifications } from '../src/v1.4.3/subscription-notifications.mjs';

const MONTH=2592000;let sequence=1434000;const next=()=>++sequence;const clocks=new WeakSet();
function fixture(t,{refundNotifications=true}={}) {
  const f=foundationFixture(t);if(!clocks.has(t)){t.mock.timers.enable({apis:['Date'],now:f.now*1000});clocks.add(t);}
  f.sqlite.function('unixepoch',{varargs:true},(...args)=>args.length===0||args[0]==='now'?Math.floor(Date.now()/1000):authoritySeconds(args[0]));
  f.sqlite.function('current_timestamp',()=>new Date().toISOString().slice(0,19).replace('T',' '));
  for(const name of ['0026-v1.3.6-stars-core-foundation.sql','0027-v1.3.6-stars-access-and-reconciliation.sql',
    '0066-v1.4.3-subscription-lifecycle-foundation.sql','0067-v1.4.3-lifecycle-engine-binding.sql',
    '0068-v1.4.3-provider-and-review-binding.sql',...(refundNotifications?[
      '0069-v1.4.3-d1-compatibility.sql','0070-v1.4.3-refund-notification.sql']:[])])
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  f.serverEnv={...f.serverEnv,STARS_PAYMENTS_ENABLED:'true',STARS_BILLING_MODE:'prepaid',STARS_RECURRING_ENABLED:'true',
    STARS_RECURRING_TERMS_REVISION:TERMS,STARS_RECURRING_PRICE_VERSION:'1',STARS_ROLLOUT_MODE:'all',
    STARS_PAID_NOTIFICATIONS_ENABLED:'true',STARS_REFUNDS_ENABLED:'true',STARS_INVOICE_SECRET:'offline-v143-paid-notification-secret-more-than-32-characters',
    WEBHOOK_SECRET:'offline-v143-paid-notification-webhook-secret'};
  for(const id of [101,202,303,404]) {
    f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(id);
    f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(id);
  }
  f.advance=seconds=>{f.now+=seconds;t.mock.timers.setTime(f.now*1000);};
  f.service=(purpose='notification_deliver_historical')=>createServiceExecutor({binding:f.binding,env:f.serverEnv,purpose}).createContext();
  return f;
}
async function auth(f,{id=101,operation='billing.purchase_monthly',payload={action:'accept',requestedPlanCode:'dragon',
  billingMode:'recurring',recurringConsent:true,termsRevision:TERMS,priceVersion:1}}={}) {
  if(!f.tokens.has(id))await f.session(id);
  const context=await createCustomerContext({binding:f.binding,env:f.serverEnv,sessionToken:f.tokens.get(id),channel:'mini_app',operation,
    requestPayload:payload,idempotencyKey:'paid-notification-test-'+next()});
  return requireRuntimeAuthorization(await createRuntimeAuthorizer().authorize(context));
}
async function paid(f,{id=101,expiration=f.now+3600}={}) {
  const invoice=await issueStarsRecurringInvoice(await auth(f,{id}),{telegramApi:async()=> 'https://t.me/$paidNotificationOffline'});
  assert.equal(invoice.status,'confirmed');const order=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(invoice.orderId);
  const checked=await handleStarsPreCheckoutQuery(f.serverEnv,{update_id:next(),pre_checkout_query:{id:'paid-notice-query-'+next(),
    from:{id,is_bot:false},currency:'XTR',total_amount:499,invoice_payload:order.invoice_payload}},{telegramApi:async()=>true});
  assert.equal(checked.approved,true);
  const charge='paid-notification-first-'+next(),update={update_id:next(),message:{message_id:next(),from:{id,is_bot:false},
    chat:{id,type:'private'},date:f.now,successful_payment:{currency:'XTR',total_amount:499,invoice_payload:order.invoice_payload,
      telegram_payment_charge_id:charge,provider_payment_charge_id:'',is_recurring:true,is_first_recurring:true,subscription_expiration_date:expiration}}};
  const record=await recordStarsSuccessfulPayment(f.serverEnv,update);await applyStarsPaidAccess(f.serverEnv,{orderId:record.orderId});
  const subscription=f.sqlite.prepare('SELECT * FROM subscriptions WHERE telegram_id=?').get(id);
  const contract=f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(invoice.contractId);
  return {id,invoice,order,record,subscription,contract,charge,expiration};
}
async function cancel(f,p) {
  const authorization=await auth(f,{id:p.id,operation:'access.read_own',payload:{subscriptionAction:'cancel_renewal',
    contractId:p.contract.contract_id,expectedRevision:p.contract.revision}});
  const result=await requestOwnStarsSubscriptionCommand(await authorizeOwnStarsSubscriptionCommand(authorization),{telegramApi:async()=>true});
  assert.equal(result.status,'confirmed');
}
async function provider(f,p,state='failed') {
  const updateId=next(),claimToken='paid-notification-claim-'+next();
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,lease_expires_at,received_at)
    VALUES(?,'unsupported',?,'processing',?,?,?)`).run(updateId,p.id,claimToken,f.now+60,f.now);
  const request=new Request('https://offline.example/webhook',{method:'POST',headers:{'Content-Type':'application/json',
    'X-Telegram-Bot-Api-Secret-Token':f.serverEnv.WEBHOOK_SECRET},body:JSON.stringify({update_id:updateId,
      subscription:{user:{id:p.id,is_bot:false},invoice_payload:p.order.invoice_payload,state}})});
  const result=await handleVerifiedTelegramSubscriptionUpdate({webhookRequest:request,serviceContext:f.service('stars_process_event'),receiptClaimToken:claimToken});
  assert.ok(['recorded','duplicate'].includes(result.status));return result;
}
function transport(f,{response='sent',beforeSend}={}) {
  const calls=[];
  return {calls,fetchImpl:async(url,options)=>{
    const payload=JSON.parse(options.body);calls.push({url,payload});await beforeSend?.(payload);
    if(response==='lost')throw new Error('connection lost after possible send');
    if(response==='blocked')return new Response(JSON.stringify({ok:false,error_code:403,description:'Forbidden'}),{status:403});
    return new Response(JSON.stringify({ok:true,result:{message_id:next(),chat:{id:payload.chat_id,type:'private'}}}),{status:200});
  }};
}
const count=(f,table)=>f.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const jobs=f=>f.sqlite.prepare('SELECT * FROM paid_subscription_notification_jobs ORDER BY job_type').all();
async function renew(f,p,{expiration=p.expiration+MONTH}={}) {
  const update={update_id:next(),message:{message_id:next(),date:f.now,from:{id:p.id,is_bot:false},chat:{id:p.id,type:'private'},
    successful_payment:{currency:'XTR',total_amount:499,invoice_payload:p.order.invoice_payload,
      telegram_payment_charge_id:'paid-notification-renewal-'+next(),provider_payment_charge_id:'',is_recurring:true,
      is_first_recurring:false,subscription_expiration_date:expiration}}};
  const record=await recordStarsSuccessfulPayment(f.serverEnv,update);await applyStarsPaidAccess(f.serverEnv,{orderId:record.orderId});
  return record;
}

test('near-end and expired notifications use actual paid evidence, one durable attempt and native sendMessage transport',async t=>{
  const f=fixture(t),p=await paid(f),tx=transport(f,{beforeSend:()=>{
    const job=jobs(f).find(row=>row.status==='processing');assert.ok(job);assert.equal(job.attempt_count,1);
  }});
  const first=await runPaidSubscriptionNotifications(f.service(),tx);
  assert.equal(first.sent,1);assert.equal(tx.calls.length,1);assert.ok(tx.calls[0].url.endsWith('/sendMessage'));
  assert.equal(tx.calls[0].payload.chat_id,p.id);assert.match(tx.calls[0].payload.text,/Оплаченный период заканчивается/);
  assert.equal(jobs(f)[0].status,'sent');assert.equal(count(f,'payment_ledger'),1);assert.equal(count(f,'subscription_access_grants'),1);
  await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(tx.calls.length,1);
  f.advance(3600);const expired=await runPaidSubscriptionNotifications(f.service(),tx);
  assert.equal(expired.sent,1);assert.equal(tx.calls.length,2);assert.match(tx.calls[1].payload.text,/период завершился/);
  assert.equal(count(f,'payment_ledger'),1);assert.equal(count(f,'subscription_access_grants'),1);
});

test('confirmed own cancellation sends once after restart and keeps the paid remainder',async t=>{
  const f=fixture(t),p=await paid(f,{expiration:f.now+MONTH});await cancel(f,p);const before=f.sqlite.prepare('SELECT * FROM subscriptions').get(),tx=transport(f);
  assert.equal((await runPaidSubscriptionNotifications(f.service(),tx)).sent,1);
  assert.match(tx.calls[0].payload.text,/Автопродление отменено/);await runPaidSubscriptionNotifications(f.service(),tx);
  assert.equal(tx.calls.length,1);assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscriptions').get(),before);
});

test('two distinct consistent provider failure updates create one semantic-period notification',async t=>{
  const f=fixture(t),p=await paid(f,{expiration:f.now+MONTH});f.advance(1);await provider(f,p);f.advance(1);await provider(f,p);
  const tx=transport(f),result=await runPaidSubscriptionNotifications(f.service(),tx);
  assert.equal(result.sent,1);assert.equal(tx.calls.length,1);assert.match(tx.calls[0].payload.text,/ошибке продления/);
  assert.equal(count(f,'paid_subscription_notification_jobs'),1);assert.equal(count(f,'payment_ledger'),1);
  await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(tx.calls.length,1);
});

test('distinct consistent cancellation updates also share one period notification',async t=>{
  const f=fixture(t),p=await paid(f,{expiration:f.now+MONTH});f.advance(1);await provider(f,p,'canceled');f.advance(1);await provider(f,p,'canceled');
  const tx=transport(f);assert.equal((await runPaidSubscriptionNotifications(f.service(),tx)).sent,1);
  assert.equal(tx.calls.length,1);assert.equal(count(f,'paid_subscription_notification_jobs'),1);
});

test('renewal or refund after a durable claim suppresses the old paid notice before any send',async t=>{
  for(const change of ['renew','refund']) {
    const f=fixture(t),p=await paid(f),tx=transport(f),batch=f.binding.batch.bind(f.binding);let changed=false;
    f.binding.batch=async statements=>{const result=await batch(statements);
      if(!changed&&statements.some(statement=>statement.sql.includes("SET status='processing',attempt_count=1"))) {
        changed=true;if(change==='renew')await renew(f,p);
        else await applyStarsCompensation(f.serverEnv,{telegramPaymentChargeId:p.charge,compensationType:'refund',telegramUpdateId:next()});
      }return result;};
    await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(changed,true);assert.equal(tx.calls.length,0);
    assert.equal(jobs(f)[0].status,'suppressed');assert.equal(jobs(f)[0].attempt_count,1);
    assert.equal(count(f,'payment_ledger'),2);
  }
});

test('final atomic recipient fence catches block or settings changes after admission and cannot send',async t=>{
  for(const change of ['blocked','settings']) {
    const f=fixture(t);await paid(f);const tx=transport(f),batch=f.binding.batch.bind(f.binding);let changed=false;
    f.binding.batch=async statements=>{
      if(!changed&&statements.some(statement=>statement.sql.includes("WHERE job_key=? AND revision=? AND status='processing' AND attempt_count=1"))) {
        changed=true;if(change==='blocked')f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=101').run();
        else f.sqlite.prepare('INSERT INTO notification_settings(telegram_id,telegram_enabled) VALUES(101,0)').run();
      }return batch(statements);};
    await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(changed,true);assert.equal(tx.calls.length,0);
    assert.equal(jobs(f)[0].status,'unknown');await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(tx.calls.length,0);
  }
});

test('lost response remains unknown after restart and Telegram bot block becomes terminal suppressed',async t=>{
  for(const response of ['lost','blocked']) {
    const f=fixture(t);await paid(f);const tx=transport(f,{response});await runPaidSubscriptionNotifications(f.service(),tx);
    assert.equal(jobs(f)[0].status,response==='lost'?'unknown':'suppressed');assert.equal(jobs(f)[0].attempt_count,1);
    await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(tx.calls.length,1);
    assert.equal(count(f,'payment_ledger'),1);assert.equal(count(f,'subscription_access_grants'),1);
  }
});

test('racing cron and restart consume one CAS attempt; interrupted committed claim is never automatically resent',async t=>{
  const f=fixture(t);await paid(f);const tx=transport(f);
  await Promise.all([runPaidSubscriptionNotifications(f.service(),tx),runPaidSubscriptionNotifications(f.service(),tx)]);
  assert.equal(tx.calls.length,1);assert.equal(count(f,'paid_subscription_notification_jobs'),1);assert.equal(jobs(f)[0].attempt_count,1);
  await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(tx.calls.length,1);
  const g=fixture(t);await paid(g);const interrupted=transport(g),batch=g.binding.batch.bind(g.binding);let lost=false;
  g.binding.batch=async statements=>{const result=await batch(statements);
    if(!lost&&statements.some(statement=>statement.sql.includes("SET status='processing',attempt_count=1"))) {
      lost=true;throw new Error('claim response lost after COMMIT');}return result;};
  await runPaidSubscriptionNotifications(g.service(),interrupted);assert.equal(jobs(g)[0].status,'processing');assert.equal(interrupted.calls.length,0);
  g.advance(301);await runPaidSubscriptionNotifications(g.service(),interrupted);
  assert.equal(jobs(g)[0].status,'unknown');assert.equal(jobs(g)[0].attempt_count,1);assert.equal(interrupted.calls.length,0);
});

test('zero affected claim and a rolled back claim transaction cannot reach provider transport',async t=>{
  for(const failure of ['zero','throw']) {
    const f=fixture(t);await paid(f);const tx=transport(f);
    if(failure==='throw')f.binding.failStatement=sql=>sql.includes("SET status='processing',attempt_count=1");
    else {const prepare=f.binding.prepare.bind(f.binding);f.binding.prepare=sql=>prepare(sql.includes("SET status='processing',attempt_count=1")?sql+' AND 0':sql);}
    await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(tx.calls.length,0);assert.equal(jobs(f)[0].status,'pending');
    assert.equal(jobs(f)[0].attempt_count,0);
  }
});

test('source principal is fixed and opt-out recipient jobs terminate without sending',async t=>{
  const f=fixture(t);await paid(f);const tx=transport(f);
  await assert.rejects(runPaidSubscriptionNotifications({version:1,actorKind:'service'},tx),/untrusted_context/);
  await assert.rejects(runPaidSubscriptionNotifications(f.service('stars_process_event'),tx),/paid_notification_service_required/);
  const customer=await auth(f,{operation:'access.read_own',payload:{}});
  await assert.rejects(runPaidSubscriptionNotifications(customer,tx),/untrusted_context/);
  f.sqlite.prepare('INSERT INTO notification_settings(telegram_id,telegram_enabled) VALUES(101,0)').run();
  await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(tx.calls.length,0);assert.equal(jobs(f)[0].status,'suppressed');
  assert.equal(jobs(f)[0].attempt_count,0);await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(tx.calls.length,0);
  f.serverEnv={...f.serverEnv,STARS_PAID_NOTIFICATIONS_ENABLED:'false'};
  assert.equal((await runPaidSubscriptionNotifications(f.service(),tx)).enabled,false);
});

test('future separated recurring head does not hide the current expiry or dedupe away the later paid warning',async t=>{
  const f=fixture(t),p=await paid(f);await renew(f,p,{expiration:p.expiration+2*MONTH});const head=f.sqlite.prepare('SELECT current_period_end FROM subscriptions').get();
  assert.equal(head.current_period_end,p.expiration+2*MONTH);const tx=transport(f);
  await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(tx.calls.length,1);
  assert.equal(jobs(f)[0].expected_period_end,head.current_period_end);assert.ok(tx.calls[0].payload.text.includes(new Date(p.expiration*1000).toISOString().slice(0,16).replace('T',' ')));
  f.advance(3600);await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(tx.calls.length,2);
  assert.match(tx.calls[1].payload.text,/период завершился/);
  f.advance(2*MONTH-3600);await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(tx.calls.length,3);
  assert.match(tx.calls[2].payload.text,/период заканчивается/);assert.equal(count(f,'subscription_access_grants'),2);assert.equal(count(f,'payment_ledger'),2);
});

test('bounded durable job progress serves recipients beyond the first batch',async t=>{
  const f=fixture(t);for(const id of [101,202,303])await paid(f,{id});const tx=transport(f);
  for(let i=0;i<3;i++) {const result=await runPaidSubscriptionNotifications(f.service(),{...tx,limit:1});assert.ok(result.planned<=1);assert.ok(result.sent<=1);}
  assert.deepEqual(tx.calls.map(call=>call.payload.chat_id).sort((a,b)=>a-b),[101,202,303]);
  await runPaidSubscriptionNotifications(f.service(),{...tx,limit:1});assert.equal(tx.calls.length,3);
});

test('a failure cleared by genuine renewal cannot reserve the current period key against a later real failure',async t=>{
  const f=fixture(t),p=await paid(f,{expiration:f.now+MONTH});f.advance(1);await provider(f,p);f.advance(1);await renew(f,p);
  const tx=transport(f);await runPaidSubscriptionNotifications(f.service(),tx);
  assert.equal(tx.calls.length,0);const stale=jobs(f).filter(job=>job.job_type==='renewal_failed');
  assert.equal(stale.length,1);assert.equal(stale[0].status,'suppressed');assert.match(stale[0].job_key,/:stale-/);
  f.advance(1);await provider(f,p);await runPaidSubscriptionNotifications(f.service(),tx);
  assert.equal(tx.calls.length,1);assert.match(tx.calls[0].payload.text,/ошибке продления/);
  const current=jobs(f).filter(job=>job.job_type==='renewal_failed'&&job.status==='sent');
  assert.equal(current.length,1);assert.ok(current[0].job_key.endsWith(String(p.expiration+MONTH)));
  await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(tx.calls.length,1);
  assert.equal(count(f,'payment_ledger'),2);assert.equal(count(f,'subscription_access_grants'),2);
});

test('confirmed exact refund notifies its current recipient once without asserting access or renewal state',async t=>{
  const f=fixture(t),p=await paid(f,{expiration:f.now+MONTH});
  await paid(f,{id:202,expiration:f.now+MONTH});
  const refunded=await applyStarsCompensation(f.serverEnv,{telegramPaymentChargeId:p.charge,compensationType:'refund',telegramUpdateId:next()});
  assert.equal(refunded.status,'applied');
  const before={subscriptions:f.sqlite.prepare('SELECT * FROM subscriptions').all(),grants:f.sqlite.prepare('SELECT * FROM subscription_access_grants').all(),
    ledger:f.sqlite.prepare('SELECT * FROM payment_ledger').all()},tx=transport(f);
  const result=await runPaidSubscriptionNotifications(f.service(),tx);
  assert.equal(result.errors,0);assert.equal(result.sent,1);assert.equal(tx.calls.length,1);
  assert.equal(tx.calls[0].payload.chat_id,p.id);assert.match(tx.calls[0].payload.text,/Возврат платежа подтверждён/);
  assert.match(tx.calls[0].payload.text,/499 Telegram Stars/);
  assert.doesNotMatch(tx.calls[0].payload.text,/доступ сохранён|доступ прекращён|Автопродление отменено|до \d/u);
  const refundJobs=jobs(f).filter(job=>job.job_type==='refund_confirmed');
  assert.equal(refundJobs.length,1);assert.equal(refundJobs[0].status,'sent');assert.ok(refundJobs[0].job_key.endsWith(refunded.ledgerEntryId));
  assert.equal((await applyStarsCompensation(f.serverEnv,{telegramPaymentChargeId:p.charge,compensationType:'refund',telegramUpdateId:next()})).status,'duplicate');
  await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(tx.calls.length,1);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscriptions').all(),before.subscriptions);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_access_grants').all(),before.grants);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM payment_ledger').all(),before.ledger);
});

test('provider false or unknown refund cannot create a confirmed-refund notification',async t=>{
  for(const outcome of ['false','unknown']) {
    const f=fixture(t),p=await paid(f,{expiration:f.now+MONTH});
    const result=await requestStarsRefund(f.serverEnv,{adminTelegramId:900,telegramPaymentChargeId:p.charge,
      reasonCode:'customer_requested_refund'},{telegramApi:async()=>{if(outcome==='unknown')throw new Error('lost response');return false;}});
    assert.equal(result.refunded,false);assert.equal(result.status,'manual_review');
    const tx=transport(f);await runPaidSubscriptionNotifications(f.service(),tx);
    assert.equal(tx.calls.length,0);assert.equal(jobs(f).filter(job=>job.job_type==='refund_confirmed').length,0);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM payment_ledger WHERE entry_type='refund'").get().n,0);
  }
});

test('confirmed refund notice does not revoke or describe another genuine paid grant',async t=>{
  const f=fixture(t),p=await paid(f,{expiration:f.now+MONTH});await renew(f,p);
  await applyStarsCompensation(f.serverEnv,{telegramPaymentChargeId:p.charge,compensationType:'refund',telegramUpdateId:next()});
  const before=f.sqlite.prepare("SELECT * FROM subscription_access_grants WHERE status='active'").all();assert.equal(before.length,1);
  const subscription=f.sqlite.prepare('SELECT * FROM subscriptions').get(),tx=transport(f);
  await runPaidSubscriptionNotifications(f.service(),tx);
  assert.equal(tx.calls.length,1);assert.match(tx.calls[0].payload.text,/Возврат платежа подтверждён/);
  assert.doesNotMatch(tx.calls[0].payload.text,/доступ сохранён|доступ прекращён|Автопродление отменено/u);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM subscription_access_grants WHERE status='active'").all(),before);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscriptions').get(),subscription);
});

test('two confirmed refunded charges in the same subscription retain distinct durable notifications',async t=>{
  const f=fixture(t),p=await paid(f,{expiration:f.now+MONTH}),second=await renew(f,p);
  const secondCharge=f.sqlite.prepare("SELECT telegram_payment_charge_id FROM payment_ledger WHERE order_id=? AND entry_type='payment'").get(second.orderId).telegram_payment_charge_id;
  const firstRefund=await applyStarsCompensation(f.serverEnv,{telegramPaymentChargeId:p.charge,compensationType:'refund',telegramUpdateId:next()});
  const secondRefund=await applyStarsCompensation(f.serverEnv,{telegramPaymentChargeId:secondCharge,compensationType:'refund',telegramUpdateId:next()});
  const tx=transport(f);await runPaidSubscriptionNotifications(f.service(),tx);
  const notices=jobs(f).filter(row=>row.job_type==='refund_confirmed');
  assert.equal(tx.calls.length,2);assert.equal(notices.length,2);assert.equal(new Set(notices.map(row=>row.event_id)).size,2);
  assert.equal(new Set(notices.map(row=>row.expected_period_end)).size,1);
  assert.deepEqual(notices.map(row=>row.job_key.split(':').at(-1)).sort(),[firstRefund.ledgerEntryId,secondRefund.ledgerEntryId].sort());
  await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(tx.calls.length,2);
});

test('retained credit without an applied grant is explicitly outside the subscription notification outbox',async t=>{
  const f=cabinetSubscriptionFixture(t),retained=await f.retained();
  for(const name of ['0069-v1.4.3-d1-compatibility.sql','0070-v1.4.3-refund-notification.sql'])
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const charge=retained.retainedUpdate.message.successful_payment.telegram_payment_charge_id;
  await applyStarsCompensation(f.serverEnv,{telegramPaymentChargeId:charge,compensationType:'refund',telegramUpdateId:next()});
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(retained.retained.ledgerEntryId).n,0);
  const env={...f.serverEnv,STARS_PAID_NOTIFICATIONS_ENABLED:'true'},context=createServiceExecutor({binding:f.binding,env,
    purpose:'notification_deliver_historical'}).createContext(),tx=transport(f);
  await runPaidSubscriptionNotifications(context,tx);assert.equal(tx.calls.length,0);
  assert.equal(jobs(f).filter(row=>row.job_type==='refund_confirmed').length,0);
  assert.equal(count(f,'subscription_access_grants'),1);
});

test('confirmed refunds stay behind the existing OFF flag and recipient opt-out fences',async t=>{
  for(const fence of ['flag','settings','blocked','deletion']) {
    const f=fixture(t),p=await paid(f,{expiration:f.now+MONTH});
    await applyStarsCompensation(f.serverEnv,{telegramPaymentChargeId:p.charge,compensationType:'refund',telegramUpdateId:next()});
    if(fence==='flag')f.serverEnv={...f.serverEnv,STARS_PAID_NOTIFICATIONS_ENABLED:'false'};
    if(fence==='settings')f.sqlite.prepare('INSERT INTO notification_settings(telegram_id,telegram_enabled) VALUES(101,0)').run();
    if(fence==='blocked')f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=101').run();
    if(fence==='deletion')f.sqlite.prepare('UPDATE users SET accepted_terms=0 WHERE telegram_id=101').run();
    const tx=transport(f),result=await runPaidSubscriptionNotifications(f.service(),tx);
    assert.equal(tx.calls.length,0);
    if(fence==='flag'){assert.equal(result.enabled,false);assert.equal(jobs(f).length,0);}
    else {const [job]=jobs(f).filter(row=>row.job_type==='refund_confirmed');assert.equal(job.status,'suppressed');assert.equal(job.attempt_count,0);}
  }
});

test('a current-recipient change after refund claim suppresses delivery before transport',async t=>{
  const f=fixture(t),p=await paid(f,{expiration:f.now+MONTH});
  await applyStarsCompensation(f.serverEnv,{telegramPaymentChargeId:p.charge,compensationType:'refund',telegramUpdateId:next()});
  const tx=transport(f),batch=f.binding.batch.bind(f.binding);let changed=false;
  f.binding.batch=async statements=>{const result=await batch(statements);
    if(!changed&&statements.some(statement=>statement.sql.includes("SET status='processing',attempt_count=1"))) {
      changed=true;f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=101').run();
    }return result;};
  await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(changed,true);assert.equal(tx.calls.length,0);
  const [job]=jobs(f).filter(row=>row.job_type==='refund_confirmed');assert.equal(job.status,'suppressed');assert.equal(job.attempt_count,1);
});

test('a genuine later payment after refund claim invalidates the old subscription snapshot before transport',async t=>{
  const f=fixture(t),p=await paid(f,{expiration:f.now+MONTH});
  await applyStarsCompensation(f.serverEnv,{telegramPaymentChargeId:p.charge,compensationType:'refund',telegramUpdateId:next()});
  const tx=transport(f),batch=f.binding.batch.bind(f.binding);let changed=false;
  f.binding.batch=async statements=>{const result=await batch(statements);
    if(!changed&&statements.some(statement=>statement.sql.includes("SET status='processing',attempt_count=1"))) {
      changed=true;f.advance(1);await renew(f,p);
    }return result;};
  await runPaidSubscriptionNotifications(f.service(),tx);assert.equal(changed,true);assert.equal(tx.calls.length,0);
  const [job]=jobs(f).filter(row=>row.job_type==='refund_confirmed');assert.equal(job.status,'suppressed');assert.equal(job.attempt_count,1);
  assert.match(job.last_error_code,/^(?:paid_notification_source_changed|financial_source_unverified)$/u);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM subscription_access_grants WHERE status='active'").get().n,1);
});

test('refund notification migration preserves old jobs and fences and rolls back atomically',async t=>{
  const f=fixture(t,{refundNotifications:false});await paid(f);const tx=transport(f);
  await runPaidSubscriptionNotifications(f.service(),tx);const before=jobs(f);assert.equal(before.length,1);
  const sql=fs.readFileSync(new URL('../migrations/0070-v1.4.3-refund-notification.sql',import.meta.url),'utf8');
  const objects=f.sqlite.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='paid_subscription_notification_jobs' AND type IN ('index','trigger') ORDER BY type,name").all();
  f.sqlite.exec('BEGIN IMMEDIATE');
  try{f.sqlite.exec(sql);f.sqlite.exec('SELECT * FROM forced_migration_failure');assert.fail('injected failure must abort');}
  catch(error){assert.match(error.message,/forced_migration_failure/);f.sqlite.exec('ROLLBACK');}
  assert.deepEqual(jobs(f),before);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM re_schema_migrations WHERE version='1.4.3-refund-notification'").get().n,0);
  assert.doesNotMatch(f.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='paid_subscription_notification_jobs'").get().sql,/refund_confirmed/);
  f.sqlite.exec('BEGIN IMMEDIATE');f.sqlite.exec(sql);f.sqlite.exec('COMMIT');
  assert.deepEqual(jobs(f),before);
  assert.deepEqual(f.sqlite.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='paid_subscription_notification_jobs' AND type IN ('index','trigger') ORDER BY type,name").all(),objects);
  assert.throws(()=>f.sqlite.prepare('DELETE FROM paid_subscription_notification_jobs').run(),/retention_required/);
  assert.throws(()=>f.sqlite.prepare("UPDATE paid_subscription_notification_jobs SET status='pending',revision=revision+1").run(),/transition_invalid/);
  f.sqlite.exec('BEGIN IMMEDIATE');f.sqlite.exec(sql);f.sqlite.exec('COMMIT');assert.deepEqual(jobs(f),before);
});
