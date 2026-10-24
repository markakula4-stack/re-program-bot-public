import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHmac} from 'node:crypto';
import {cabinetSubscriptionFixture,next,MONTH,invoiceIntent} from './helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import {createCustomerContext} from '../src/v1.4.1/trusted-context.mjs';
import {createRuntimeAuthorizer,requireRuntimeAuthorization} from '../src/v1.4.1/runtime-authorizer.mjs';
import {authoritySeconds,createAuthorityResolver,readLifecycleActorFacts,isVerifiedProviderInactiveExit} from '../src/v1.4.1/authority-resolver.mjs';
import {readVerifiedLifecycleFacts,compileVerifiedLifecycleAssertions} from '../src/v1.4.3/lifecycle-authority.mjs';
import {projectVerifiedRecurringControl} from '../src/v1.4.3/lifecycle-engine.mjs';
import {authorizeOwnStarsSubscriptionCommand} from '../src/v1.4.3/subscription-action-authority.mjs';
import {issueStarsRecurringInvoice,requestOwnStarsSubscriptionCommand} from '../src/v1.4.3/telegram-subscription-provider.mjs';
import {handleStarsPreCheckoutQuery,recordStarsSuccessfulPayment} from '../src/v1.3.6/stars-payment-runtime.mjs';
import {applyStarsPaidAccess,requestStarsRefund} from '../src/v1.3.6/stars-access-runtime.mjs';
import {authorizeTelegramHandler} from '../src/v1.4.1/telegram-runtime.mjs';
import {prepareLegacyCompatibility,bindLegacyCompatibilityEnv} from '../src/v1.4.1/telegram-legacy-compatibility.mjs';
import {assertRecurringExitConfirmed} from '../src/v1.4.4/package-contract.mjs';
import {validateUnifiedPackageTimeline} from '../src/v1.4.4/package-access-runtime.mjs';
import {describeTelegramCommandError} from '../src/v1.4.3/telegram-command-error.mjs';

const OWNER=8987576334,BOT=8562951985,BOT_TOKEN=BOT+':offline-inactive-exit-token-over32',SECRET='offline-inactive-exit-webhook';
const resolver=createAuthorityResolver();
function signed(now){
 const data={auth_date:String(now),user:JSON.stringify({id:OWNER,first_name:'Offline inactive exit'})};
 const check=Object.entries(data).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n');
 const key=createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
 return new URLSearchParams({...data,hash:createHmac('sha256',key).update(check).digest('hex')}).toString();
}
async function fixture(t){
 const realNow=Date.now;Date.now=()=>1791483000*1000;
 const f=cabinetSubscriptionFixture(t);f.now=1791483000;
 Date.now=()=>f.now*1000;t.after(()=>{Date.now=realNow;});
 f.sqlite.function('unixepoch',{deterministic:false,varargs:true},(...args)=>{
  const value=!args.length||args[0]==='now'?f.now:authoritySeconds(args[0]);return value===null?null:BigInt(value);
 });
 f.sqlite.function('current_timestamp',{deterministic:false},()=>new Date(f.now*1000).toISOString().slice(0,19).replace('T',' '));
 for(const name of ['0069-v1.4.3-d1-compatibility.sql','0070-v1.4.3-refund-notification.sql','0071-v1.4.3-refund-contract-retirement.sql',
   '0072-v1.4.4-package-contract.sql','0073-v1.4.4-package-payment-review.sql','0074-v1.4.4-package-referral-compatibility.sql','0075-v1.4.4-provider-inactive-exit.sql'])
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 f.sqlite.prepare('INSERT INTO re_schema_migrations(version) VALUES(?)').run('1.4.4-provider-inactive-exit');
 f.sqlite.prepare('INSERT INTO users(telegram_id,referral_code,accepted_terms) VALUES(?,?,1)').run(OWNER,'offline-inactive-exit');
 for(const role of ['user','admin'])f.sqlite.prepare("INSERT INTO user_roles(telegram_id,role,status) VALUES(?,?,'active')").run(OWNER,role);
 f.sqlite.prepare("INSERT INTO user_access(telegram_id,access_tier) VALUES(?,'free')").run(OWNER);
 f.sqlite.prepare("INSERT INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(OWNER);
 f.sqlite.prepare("INSERT INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(OWNER);
 f.serverEnv={...f.serverEnv,ADMIN_ID:String(OWNER),OWNER_TELEGRAM_ID:String(OWNER),BOT_TOKEN,REBUILD_V140_BOT_ID:String(BOT),WEBHOOK_SECRET:SECRET};
 const opened=await f.call(OWNER,'session',{method:'POST',token:null,payload:{initData:signed(f.now)},customEnv:f.serverEnv});
 assert.equal(opened.status,200,JSON.stringify(opened.data));
 f.context=(payload={},env=f.serverEnv)=>createCustomerContext({binding:f.binding,env,sessionToken:opened.data.sessionToken,nowSeconds:f.now,
  channel:'mini_app',operation:payload.action?'billing.purchase_monthly':'access.read_own',requestPayload:payload,idempotencyKey:'offline-inactive-'+next()});
 f.authorize=async payload=>requireRuntimeAuthorization(await createRuntimeAuthorizer().authorize(await f.context(payload),null));
 const invoice=await issueStarsRecurringInvoice(await f.authorize({...invoiceIntent,requestedPlanCode:'professional'}),{telegramApi:async()=> 'https://t.me/$offlineInactive'});
 const order=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(invoice.orderId);
 assert.equal((await handleStarsPreCheckoutQuery(f.serverEnv,{update_id:next(),pre_checkout_query:{id:'offline-'+next(),from:{id:OWNER},currency:'XTR',total_amount:249,invoice_payload:order.invoice_payload}},
  {telegramApi:async()=>true})).approved,true);
 const update={update_id:next(),message:{message_id:next(),date:f.now,from:{id:OWNER,is_bot:false},chat:{id:OWNER,type:'private'},
  successful_payment:{currency:'XTR',total_amount:249,invoice_payload:order.invoice_payload,telegram_payment_charge_id:'offline-inactive-charge-'+next(),
   provider_payment_charge_id:'',is_recurring:true,is_first_recurring:true,subscription_expiration_date:f.now+MONTH}}};
 const record=await recordStarsSuccessfulPayment(f.serverEnv,update);assert.equal((await applyStarsPaidAccess(f.serverEnv,{orderId:record.orderId})).accessApplied,true);
 f.contract=f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(invoice.contractId);
 f.command=async(action,telegramApi)=>requestOwnStarsSubscriptionCommand(await authorizeOwnStarsSubscriptionCommand(await f.authorize(
  {subscriptionAction:action,contractId:f.contract.contract_id,expectedRevision:f.contract.revision})),{telegramApi});
 f.now++;assert.equal((await f.command('cancel_renewal',async()=>true)).status,'confirmed');
 f.now++;assert.equal((await f.command('reenable_renewal',async()=>true)).status,'confirmed');
 f.now++;const updateId=next(),claim=crypto.randomUUID(),refundUpdate={update_id:updateId,callback_query:{id:'offline-inactive-refund-'+next(),from:{id:OWNER,is_bot:false},
  message:{from:{id:BOT,is_bot:true},chat:{id:OWNER,type:'private'}},data:'admin_stars_refund_confirm:'+record.orderId}};
 f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,attempt_count,received_at,lease_expires_at)
  VALUES(?,'callback_query',?,'processing',?,1,?,?)`).run(updateId,OWNER,claim,f.now,f.now+300);
 const context=await createCustomerContext({binding:f.binding,env:f.serverEnv,webhookRequest:new Request(f.serverEnv.MINI_APP_ORIGIN+'/webhook',{
  method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':SECRET},body:JSON.stringify(refundUpdate)}),receiptClaimToken:claim,
  channel:'telegram_callback',operation:'account.menu.read',nowSeconds:f.now});
 const {authorization,handler}=await authorizeTelegramHandler(context,refundUpdate),admitted=bindLegacyCompatibilityEnv(
  await prepareLegacyCompatibility(authorization,{family:handler.capability}),{...f.serverEnv,DB:f.binding});
 const refunded=await requestStarsRefund(admitted,{adminTelegramId:OWNER,telegramPaymentChargeId:update.message.successful_payment.telegram_payment_charge_id,reasonCode:'admin_canary_validation'},
  {telegramApi:async(_env,method)=>{assert.equal(method,'refundStarPayment');f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=?').run(OWNER);return true;}});
 assert.equal(refunded.refunded,true);assert.equal(refunded.renewalCancellation.confirmed,false);
 f.sqlite.prepare('UPDATE users SET is_blocked=0 WHERE telegram_id=?').run(OWNER);
 f.now++;const rejected=await f.command('cancel_renewal',async()=>{throw Object.assign(Error('telegram_400'),{code:'telegram_400',method:'editUserStarSubscription',ambiguous:false},
  await describeTelegramCommandError('editUserStarSubscription',{error_code:400,description:'Bad Request: SUBSCRIPTION_NOT_ACTIVE'},400));});
 assert.equal(rejected.status,'rejected');assert.equal(rejected.cancellationConfirmed,false);f.rejected=rejected;
 f.audit=f.sqlite.prepare("SELECT * FROM admin_audit_log WHERE action='subscription_provider_diagnostic' AND entity_id=?").get(rejected.commandId);
 f.resolve=async(env=f.serverEnv)=>{const actor=await resolver.resolveActor(await f.context({},env)),token=readLifecycleActorFacts(actor),facts=readVerifiedLifecycleFacts(token);
  return {actor,token,facts,control:projectVerifiedRecurringControl({verifiedFacts:token,contractId:f.contract.contract_id,nowSec:f.now})};};
 return f;
}

test('inactive exit requires exact private refunded-owner evidence and preserves historical paid source',async t=>{
 const f=await fixture(t),initial=await f.resolve(),proof=initial.facts.providerInactiveExits[0],contract=initial.facts.contracts[0];
 await t.test('exact rejected observation permits inactive exit without fabricating cancellation ACK',()=>{
  assert.equal(initial.control.renewalState,'inactive');assert.equal(initial.control.pendingOperations,0);assert.deepEqual(initial.control.reviewReasons,[]);
  assert.equal(isVerifiedProviderInactiveExit(proof,contract,f.now),true);
  assert.deepEqual(assertRecurringExitConfirmed({actor:initial.actor,nowSec:f.now}),{required:true,confirmed:false,inactive:true,contractId:contract.contract_id,revision:contract.revision});
  const row=f.sqlite.prepare('SELECT * FROM subscription_provider_commands WHERE command_id=?').get(f.rejected.commandId);
  assert.equal(row.state,'rejected');assert.equal(row.acknowledgement_event_id,null);assert.equal(f.sqlite.prepare('SELECT retired_at FROM subscription_billing_contracts').get().retired_at,null);
 });
 await t.test('copied JSON and mismatched contract cannot become private exit proof',()=>{
  assert.equal(isVerifiedProviderInactiveExit(JSON.parse(JSON.stringify(proof)),contract,f.now),false);
  assert.equal(isVerifiedProviderInactiveExit(proof,{...contract},f.now),false);
 });
 await t.test('a second raw current own contract cannot bypass the unchanged recurring period guard',()=>{
  const migration=fs.readFileSync(new URL('../migrations/0075-v1.4.4-provider-inactive-exit.sql',import.meta.url),'utf8');
  const start=migration.indexOf(' OR EXISTS(SELECT 1 FROM subscription_billing_contracts c WHERE');
  const end=migration.indexOf('\n OR EXISTS(SELECT 1 FROM subscription_package_periods pp WHERE',start);
  const guard=migration.slice(start+4,end).replaceAll('NEW.telegram_id',String(OWNER)).replaceAll('NEW.recorded_at',String(f.now));
  const blocked=()=>f.sqlite.prepare('SELECT ('+guard+') n').get().n;
  assert.equal(blocked(),0,'the sole exact inactive refunded contract opens only this recurring guard');
  const foreignKeys=f.sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys;
  f.sqlite.exec('PRAGMA foreign_keys=OFF; SAVEPOINT invalid_second_contract');
  try{
   // Model corrupt raw evidence in an isolated rollback, before schema attestation.
   f.sqlite.exec('DROP INDEX idx_v143_billing_contract_one_open; DROP TRIGGER v143_contract_insert_binding');
   const source=f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(contract.contract_id);
   const row={...source,contract_id:crypto.randomUUID(),origin_order_id:crypto.randomUUID(),external_invoice_payload:'offline-second-current-'+next()};
   const columns=Object.keys(row);
   f.sqlite.prepare('INSERT INTO subscription_billing_contracts ('+columns.join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')').run(...columns.map(key=>row[key]));
   assert.equal(blocked(),1,'no single-contract inactive proof may suppress another current contract');
  }finally{
   f.sqlite.exec('ROLLBACK TO invalid_second_contract; RELEASE invalid_second_contract');
   f.sqlite.exec('PRAGMA foreign_keys='+foreignKeys);
  }
  assert.equal(blocked(),0);
 });
 await t.test('changing the bounded description invalidates the captured atomic predicate and the next quote authority',async()=>{
  const guards=compileVerifiedLifecycleAssertions(initial.token).assertions,guard=guards.find(row=>row.sql.includes('FROM admin_audit_log'));
  assert.ok(guard);assert.equal(f.sqlite.prepare('SELECT ('+guard.sql+') n').get(...guard.params).n,1);
  const changed={...JSON.parse(f.audit.details),descriptionSafe:'Bad Request: SUBSCRIPTION_NOT_FOUND'};
  f.sqlite.prepare('UPDATE admin_audit_log SET details=? WHERE id=?').run(JSON.stringify(changed),f.audit.id);
  assert.equal(f.sqlite.prepare('SELECT ('+guard.sql+') n').get(...guard.params).n,0);
  assert.notEqual((await f.resolve()).control.renewalState,'inactive');
  f.sqlite.prepare('UPDATE admin_audit_log SET details=? WHERE id=?').run(f.audit.details,f.audit.id);
 });
 await t.test('wrong HTTP status and malformed audit clock fail closed',async()=>{
  f.sqlite.prepare('UPDATE admin_audit_log SET details=? WHERE id=?').run(JSON.stringify({...JSON.parse(f.audit.details),httpStatus:200}),f.audit.id);
  assert.notEqual((await f.resolve()).control.renewalState,'inactive');
  f.sqlite.prepare("UPDATE admin_audit_log SET details=?,created_at='not-a-date' WHERE id=?").run(f.audit.details,f.audit.id);
  assert.notEqual((await f.resolve()).control.renewalState,'inactive');
  f.sqlite.prepare('UPDATE admin_audit_log SET created_at=? WHERE id=?').run(f.audit.created_at,f.audit.id);
 });
 await t.test('a different bot cannot inherit the own inactive exception',async()=>{
  const other=await f.resolve({...f.serverEnv,REBUILD_V140_BOT_ID:'123456789',BOT_TOKEN:'123456789:offline-inactive-other-token-over32'}).catch(()=>null);
  assert.ok(!other||other.control.renewalState!=='inactive');
 });
 await t.test('new schema without its exact marker cannot admit the inactive exception',async()=>{
  f.sqlite.prepare('DELETE FROM re_schema_migrations WHERE version=?').run('1.4.4-provider-inactive-exit');
  const missing=await f.resolve().catch(()=>null);assert.ok(!missing||missing.control.renewalState!=='inactive');
  f.sqlite.prepare('INSERT INTO re_schema_migrations(version) VALUES(?)').run('1.4.4-provider-inactive-exit');
 });
 await t.test('a new pending command closes current exit but retains a period paid before that command',async()=>{
  const recordedAt=f.now;f.now+=10;
  const c=contract,id=crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO subscription_provider_commands(command_id,idempotency_key,contract_id,telegram_id,action,desired_auto_renew,
   expected_contract_revision,first_payment_ledger_entry_id,request_sha256,state,attempted_count,revision,created_at,updated_at)
   VALUES(?,?,?,?,'reenable_renewal',1,?,?,?,'admitted',0,1,?,?)`).run(id,'offline-new-command-'+next(),c.contract_id,OWNER,c.revision,c.first_payment_ledger_entry_id,'a'.repeat(64),f.now,f.now);
  const later=await f.resolve(),historical=later.facts.providerInactiveExits[0],actual=later.facts.contracts[0];
  assert.notEqual(later.control.renewalState,'inactive');assert.throws(()=>assertRecurringExitConfirmed({actor:later.actor,nowSec:f.now}));
  assert.equal(isVerifiedProviderInactiveExit(historical,actual,f.now),false);assert.equal(isVerifiedProviderInactiveExit(historical,actual,recordedAt,true),true);
  const period={ledgerEntryId:'offline-new-paid-ledger',chargeId:'offline-new-paid-charge',status:'active',startsAt:recordedAt,endsAt:recordedAt+3*MONTH,occurredAt:recordedAt,recordedAt};
  assert.equal(validateUnifiedPackageTimeline({source:{periods:[period],subscriptions:[]},ordinaryPeriods:[],contracts:later.facts.contracts,
   commands:later.facts.commands,providerEvents:later.facts.providerEvents,providerInactiveExits:later.facts.providerInactiveExits,nowSec:f.now}).periods.length,1);
  assert.throws(()=>validateUnifiedPackageTimeline({source:{periods:[period],subscriptions:[]},ordinaryPeriods:[],contracts:later.facts.contracts,
   commands:later.facts.commands,providerEvents:later.facts.providerEvents,providerInactiveExits:[{...historical}],nowSec:f.now}),{code:'package_access_recurring_exit_unconfirmed'});
 });
});
