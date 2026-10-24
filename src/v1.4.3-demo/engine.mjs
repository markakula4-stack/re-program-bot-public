// Owner-only isolated simulator. The real Stars ingestion/access/lifecycle
// modules operate against demo D1, never a production binding or real invoice.
import { buildStarsInvoicePayload } from '../v1.3.6/stars-core-foundation.mjs';
import { recordStarsSuccessfulPayment } from '../v1.3.6/stars-payment-runtime.mjs';
import { applyStarsPaidAccess, expireStarsPaidAccess } from '../v1.3.6/stars-access-runtime.mjs';
import { createCustomerContext } from '../v1.4.1/trusted-context.mjs';
import { createRuntimeAuthorizer, readRuntimeAuthorization } from '../v1.4.1/runtime-authorizer.mjs';
import { readLifecycleActorFacts } from '../v1.4.1/authority-resolver.mjs';
import { projectVerifiedSubscriptionLifecycle } from '../v1.4.3/lifecycle-engine.mjs';
import { projectOwnSubscriptionHistory } from '../v1.4.3/subscription-history.mjs';
import { authorizeOwnStarsSubscriptionCommand } from '../v1.4.3/subscription-action-authority.mjs';
import { requestOwnStarsSubscriptionCommand } from '../v1.4.3/telegram-subscription-provider.mjs';
import { STARS_RECURRING_TERMS_REVISION as TERMS } from '../v1.4.3/recurring-provider-config.mjs';
import { createDemoExecutionDb } from './db-adapter.mjs';

export const DEMO_MONTH_SECONDS = 2592000;
const PRICES = Object.freeze({ professional:249, dragon:499 });
const ACTIONS = new Set(['buy','advance_30d','cancel','resume','reset','duplicate','low_funds','lost_response']);
const fail = (code,status=409) => { throw Object.assign(new Error(code),{code,status}); };
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const realNow = () => Math.floor(Date.now()/1000);
const token = () => 'rpms1_'+btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const messages = {
 ready:'Это симуляция. Реальные Stars не используются.', purchased:'Тестовая покупка проведена.', renewed:'Тестовый период продлён на 30 дней.',
 advanced:'Виртуальное время переведено на 30 дней.', canceled:'Автопродление в симуляторе отключено. Оплаченный срок сохранён.',
 resumed:'Автопродление симулятора включено. Реальный движок ожидает следующую запись оплаты.', reset:'Новая симуляция: 1000 условных единиц.',
 duplicate:'Событие повторено. Повторного списания и квитанции нет.', low_funds:'Тестовый баланс обнулён. Следующее продление проверит нехватку средств.',
 insufficient_funds:'Недостаточно тестовых средств. Новый оплаченный период не предоставлен.', lost_response:'Ответ об оплате условно потерян. Оплата записана; повтор события не спишет средства снова.',
 pending:'Операция восстанавливается по сохранённому идентификатору.',
};
const feedback = (code,status='completed') => ({code,status,message:messages[code]??messages.ready});

export function createDemoEngine({db,ownerId,invoiceSecret,wallNowSeconds}={}) {
 if(!db?.prepare||!db?.batch||!Number.isSafeInteger(ownerId)||ownerId<=0||ownerId>99999999999||typeof invoiceSecret!=='string'||invoiceSecret.length<32) fail('demo_configuration_invalid',503);
 const wall = () => { const n=typeof wallNowSeconds==='function'?wallNowSeconds():wallNowSeconds??realNow(); if(!Number.isSafeInteger(n)||n<=0) fail('demo_clock_invalid',503);return n; };
 const one = async(sql,...params) => db.prepare(sql).bind(...params).first();
 const batch = async statements => {const r=await db.batch(statements);if(!Array.isArray(r)||r.length!==statements.length||r.some(v=>v?.success!==true))fail('demo_commit_unverified',503);return r;};
 const sql = (text,...params) => db.prepare(text).bind(...params);
 const subject = generation => 1000000000000000 + ownerId*10000 + generation;
 async function seed(generation) {
  const id=subject(generation),at=Math.max(wall(),1791049765);
  await batch([
   sql('INSERT OR IGNORE INTO re_demo_generations(owner_id,generation,subject_id,now_sec) VALUES(?,?,?,?)',ownerId,generation,id,at),
   sql('INSERT OR IGNORE INTO users(telegram_id,referral_code,accepted_terms) VALUES(?,?,1)',id,'demo_'+ownerId+'_'+generation),
   sql("INSERT OR IGNORE INTO user_roles(telegram_id,role,status) VALUES(?,'user','active')",id),
   sql("INSERT OR IGNORE INTO user_access(telegram_id,access_tier) VALUES(?,'free')",id),
   sql("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')",id),
   sql("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')",id),
  ]);
 }
 async function current() {
  await db.prepare('INSERT OR IGNORE INTO re_demo_accounts(owner_id) VALUES(?)').bind(ownerId).run();
  const a=await one('SELECT generation FROM re_demo_accounts WHERE owner_id=?',ownerId);
  if(!a)fail('demo_account_unavailable',503);
  await seed(a.generation);
  return one('SELECT * FROM re_demo_generations WHERE owner_id=? AND generation=?',ownerId,a.generation);
 }
 const envFor = (g,binding=db) => ({DB:binding,BOT_TOKEN:'1:demo-internal-never-network',REBUILD_V140_BOT_ID:'1',REBUILD_V140_WRITES_ENABLED:'true',OWNER_TELEGRAM_ID:String(g.subject_id),ADMIN_ID:String(g.subject_id),
  STARS_PAYMENTS_ENABLED:'true',STARS_BILLING_MODE:'prepaid',STARS_PRICE_VERSION:'1',STARS_TERMS_REVISION:TERMS,STARS_INVOICE_SECRET:invoiceSecret,
  STARS_RECURRING_ENABLED:'true',STARS_RECURRING_PRICE_VERSION:'1',STARS_RECURRING_TERMS_REVISION:TERMS,STARS_ROLLOUT_MODE:'allowlist',STARS_ROLLOUT_ALLOWLIST:String(g.subject_id)});
 async function authorization(g,payload={},idempotencyKey='demo-internal-'+crypto.randomUUID(),binding=db) {
  // Internal principal comes only from the authenticated owner's persisted
  // generation. Its short-lived authority context uses wall time, not demo time.
  const at=wall(),sessionToken=token(),digest=await hash(sessionToken),fingerprint=await hash('demo-session\n'+crypto.randomUUID());
  await batch([
   sql('INSERT INTO mini_app_init_data_receipts(init_data_fingerprint,receipt_id,bot_id,telegram_id,auth_date,received_at,expires_at) VALUES(?,?,1,?,?,?,?)',fingerprint,crypto.randomUUID(),g.subject_id,at,at,at+300),
   sql("INSERT INTO mini_app_sessions(session_id,session_token_hash,init_data_fingerprint,bot_id,telegram_id,token_version,status,issued_at,expires_at) VALUES(?,?,?,1,?,1,'active',?,?)",'mss_'+await hash('mini-app-session-v1:'+sessionToken),digest,fingerprint,g.subject_id,at,at+300),
  ]);
  const context=await createCustomerContext({binding,env:envFor(g,binding),sessionToken,channel:'mini_app',operation:'access.read_own',nowSeconds:at,requestPayload:payload,idempotencyKey});
  return createRuntimeAuthorizer().authorize(context,null);
 }
 async function view(g,f=feedback(g.locked_operation_id?'pending':'ready',g.locked_operation_id?'pending':'completed'),diagnostic) {
  if(diagnostic)diagnostic.stage='project_view';
  const auth=await authorization(g),actor=readRuntimeAuthorization(auth).actor;
  const lifecycle=projectVerifiedSubscriptionLifecycle({verifiedFacts:readLifecycleActorFacts(actor),nowSec:g.now_sec});
  const history=await projectOwnSubscriptionHistory(auth);
  const pending=g.locked_operation_id?await one('SELECT action,operation_id,work_json FROM re_demo_operations WHERE owner_id=? AND operation_id=?',ownerId,g.locked_operation_id):null;
  return {demo:true,generation:g.generation,balance:g.balance,nowSec:g.now_sec,pendingOperationId:g.locked_operation_id,
   pendingOperation:pending?{operationId:pending.operation_id,action:pending.action,planCode:JSON.parse(pending.work_json).requestedPlanCode}:null,
   subscription:{planCode:lifecycle.planCode??g.plan_code,state:lifecycle.state,paidAccess:lifecycle.paidAccess,renewalState:lifecycle.renewalState,paidUntil:lifecycle.paidUntil,autoRenew:g.auto_renew===1,reviewRequired:lifecycle.reviewRequired},
   receipts:history.items.map(item=>({...item.receipt,demo:true})),feedback:f,
   engineEvidence:{syntheticTransport:true,realCurrencyTransfer:false,actualPaymentWriter:true,actualAccessWriter:true,actualLifecycleProjector:true,actualReceiptProjector:true}};
 }
 async function preparePurchase(g,work,first,executionDb) {
  if(!first)return;
  const at=work.paymentAt,plan=work.planCode,priceId=plan+'-30d-recurring-v1',acceptance='demo-consent-'+g.subject_id;
  const payload=await buildStarsInvoicePayload({invoiceSecret,orderId:work.orderId,telegramId:g.subject_id,priceId});
  work.payload=payload;
  await executionDb.batch([
   sql("INSERT OR IGNORE INTO terms_acceptances(acceptance_id,telegram_id,terms_revision,acceptance_scope,evidence_sha256,accepted_at) VALUES(?,?,?,'stars_purchase',?,?)",acceptance,g.subject_id,TERMS,await hash('demo-explicit-consent\n'+g.subject_id+'\n'+work.operationId),at),
   sql("INSERT OR IGNORE INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,currency,amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,expires_at,precheckout_approved_at,updated_at) VALUES(?,?,?,1,?,'XTR',?,2592000,'recurring',?,?,'precheckout_ok',?,?,?,?)",work.orderId,g.subject_id,priceId,plan,PRICES[plan],TERMS,payload,at,at+600,at,at),
   sql("INSERT OR IGNORE INTO subscription_billing_contracts(contract_id,telegram_id,plan_code,price_id,origin_order_id,external_invoice_payload,external_payload_sha256,terms_revision,terms_acceptance_id,billing_mode,period_seconds,currency,amount_stars,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'recurring',2592000,'XTR',?,?,?)",work.contractId,g.subject_id,plan,priceId,work.orderId,payload,await hash(payload),TERMS,acceptance,PRICES[plan],at,at),
  ]);
 }
 async function payment(g,work,executionDb,diagnostic) {
  if(diagnostic)diagnostic.stage='prepare_purchase';
  await preparePurchase(g,work,work.first,executionDb);
  const origin=await one('SELECT invoice_payload FROM subscription_orders WHERE order_id=?',work.orderId);
  if(!origin)fail('demo_origin_missing',503);
  const update={update_id:work.updateId,message:{message_id:work.updateId,from:{id:g.subject_id,is_bot:false},chat:{id:g.subject_id,type:'private'},successful_payment:{currency:'XTR',total_amount:PRICES[work.planCode],invoice_payload:origin.invoice_payload,telegram_payment_charge_id:work.chargeId,provider_payment_charge_id:'',is_recurring:true,is_first_recurring:work.first,subscription_expiration_date:work.paidUntil}}};
  if(diagnostic)diagnostic.stage='record_payment';
  const recorded=await recordStarsSuccessfulPayment(envFor(g,executionDb),update,{receivedAt:work.paymentAt});
  if(diagnostic)diagnostic.stage='apply_access';
  const applied=await applyStarsPaidAccess(envFor(g,executionDb),{orderId:recorded.orderId,appliedAt:work.paymentAt});
  if(!applied.accessApplied)fail('demo_access_not_applied',503);
  return update;
 }
 async function control(g,action,operationId,executionDb) {
  const c=await one('SELECT revision FROM subscription_billing_contracts WHERE contract_id=?',g.contract_id);
  if(!c)fail('demo_contract_missing',503);
  const admission=await authorizeOwnStarsSubscriptionCommand(await authorization(g,{subscriptionAction:action==='cancel'?'cancel_renewal':'reenable_renewal',contractId:g.contract_id,expectedRevision:c.revision},'demo-control-'+await hash(operationId),executionDb));
  const result=await requestOwnStarsSubscriptionCommand(admission,{telegramApi:async(_env,method)=>{if(method!=='editUserStarSubscription')fail('demo_financial_network_forbidden',503);return true;}});
  if(result.status!=='confirmed')fail('demo_control_unconfirmed',503);
 }
 async function runAct(input={},diagnostic={}) {
  const {action,operationId}=input,planCode=input.planCode??null;
  if(!ACTIONS.has(action)||typeof operationId!=='string'||! /^[A-Za-z0-9._:-]{8,128}$/.test(operationId)||planCode!==null&&!Object.hasOwn(PRICES,planCode)||Object.keys(input).some(k=>!['action','operationId','planCode'].includes(k)))fail('demo_action_invalid',400);
  const requestHash=await hash(JSON.stringify({action,planCode}));
  let op=await one('SELECT * FROM re_demo_operations WHERE owner_id=? AND operation_id=?',ownerId,operationId);
  if(op){if(op.request_hash!==requestHash)fail('demo_operation_collision');if(op.state==='completed')return {...JSON.parse(op.result_json),replayed:true};}
  let g=op?await one('SELECT * FROM re_demo_generations WHERE owner_id=? AND generation=?',ownerId,op.generation):await current();
  if(!g)fail('demo_generation_missing',503);
  if(!op){
   if(g.locked_operation_id)fail('demo_operation_pending');
   const first=action==='buy'||action==='lost_response'&&!g.plan_code;
   if(first&&!planCode)fail('demo_plan_required',400);
   if(first&&g.plan_code)fail('demo_subscription_exists');
   if(['cancel','resume','duplicate'].includes(action)&&!g.plan_code)fail('demo_subscription_required');
   if(action==='resume'&&g.auto_renew===1)fail('demo_already_enabled');
   if(action==='cancel'||action==='resume') {
    // The real provider journals have one-second chronology. Rapid synthetic
    // toggles must not fabricate an ambiguous acknowledged order and strand
    // a pending operation; this check runs BEFORE admission and wallet changes.
    const last=await one('SELECT MAX(attempted_at) AS attemptedAt FROM subscription_provider_commands WHERE contract_id=?',g.contract_id);
    if(last?.attemptedAt>=wall())throw Object.assign(new Error('demo_control_cooldown'),{code:'demo_control_cooldown',status:429,retryAfterSeconds:last.attemptedAt-wall()+1});
   }
   const advances=action==='advance_30d'||action==='lost_response'&&!first;
   const now=g.now_sec+(advances?DEMO_MONTH_SECONDS:0);
   const paying=first||advances&&g.auto_renew===1;
   const plan=first?planCode:g.plan_code,amount=paying?PRICES[plan]:0,insufficient=paying&&g.balance<amount;
   const work={operationId,first,paying:paying&&!insufficient,insufficient,planCode:plan,requestedPlanCode:planCode,nowSec:now,paymentAt:now,
    paidUntil:Math.max(now,g.paid_until??now)+DEMO_MONTH_SECONDS,orderId:first?crypto.randomUUID():g.origin_order_id,contractId:first?crypto.randomUUID():g.contract_id,
    updateId:Math.floor(Math.random()*900000000000000)+100000000000000,chargeId:'demo-charge-'+crypto.randomUUID()};
   const guard='demo-admit-'+crypto.randomUUID();
   await batch([
    sql('INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM re_demo_generations WHERE owner_id=? AND generation=? AND revision=? AND locked_operation_id IS NULL) THEN 1 ELSE 0 END)',guard,ownerId,g.generation,g.revision),
    sql("INSERT INTO re_demo_operations(owner_id,operation_id,generation,action,request_hash,state,work_json,created_at) VALUES(?,?,?,?,?,'pending',?,?)",ownerId,operationId,g.generation,action,requestHash,JSON.stringify(work),wall()),
    sql('UPDATE re_demo_generations SET locked_operation_id=?,balance=balance-?,now_sec=?,revision=revision+1 WHERE owner_id=? AND generation=?',operationId,work.paying?amount:0,now,ownerId,g.generation),
    sql('DELETE FROM mini_app_atomic_guards WHERE guard_key=?',guard),
   ]);
   op=await one('SELECT * FROM re_demo_operations WHERE owner_id=? AND operation_id=?',ownerId,operationId);
  }
  const executionDb=createDemoExecutionDb({db,ownerId,generation:g.generation,operationId});
  const work=JSON.parse(op.work_json);let code=work.insufficient?'insufficient_funds':action==='buy'?'purchased':action==='advance_30d'?'advanced':action==='cancel'?'canceled':action==='resume'?'resumed':action;
  if(work.paying){
   const update=await payment(g,work,executionDb,diagnostic);
   await executionDb.prepare('UPDATE re_demo_generations SET plan_code=?,auto_renew=1,origin_order_id=?,contract_id=?,paid_until=?,last_payment_json=? WHERE owner_id=? AND generation=?').bind(work.planCode,work.orderId,work.contractId,work.paidUntil,JSON.stringify({update,paymentAt:work.paymentAt}),ownerId,g.generation).run();
   if(action==='advance_30d')code='renewed';
  } else if(action==='duplicate') {
   if(!g.last_payment_json)fail('demo_payment_required');const old=JSON.parse(g.last_payment_json);
   diagnostic.stage='record_payment';
   const recorded=await recordStarsSuccessfulPayment(envFor(g,executionDb),old.update,{receivedAt:old.paymentAt});
   diagnostic.stage='apply_access';
   await applyStarsPaidAccess(envFor(g,executionDb),{orderId:recorded.orderId,appliedAt:old.paymentAt});
  } else if(action==='cancel'||action==='resume') {
   // On recovery, a completed command has already changed the generation flag.
   if(g.auto_renew!==Number(action==='resume'))await control(g,action,operationId,executionDb);
   await executionDb.prepare('UPDATE re_demo_generations SET auto_renew=? WHERE owner_id=? AND generation=?').bind(Number(action==='resume'),ownerId,g.generation).run();
  } else if(action==='low_funds')await executionDb.prepare('UPDATE re_demo_generations SET balance=0 WHERE owner_id=? AND generation=?').bind(ownerId,g.generation).run();
  if(action==='advance_30d'||action==='lost_response')await expireStarsPaidAccess(envFor(g,executionDb),{telegramId:g.subject_id,at:work.nowSec});
  if(action==='reset') {
   if(g.generation>=9999)fail('demo_generation_limit');
   await seed(g.generation+1);
   await executionDb.batch([
    sql('UPDATE re_demo_generations SET locked_operation_id=? WHERE owner_id=? AND generation=?',operationId,ownerId,g.generation+1),
    sql('UPDATE re_demo_accounts SET generation=? WHERE owner_id=? AND generation=?',g.generation+1,ownerId,g.generation),
   ]);
  }
  diagnostic.stage='project_view';
  const result=await view({...await current(),locked_operation_id:null},feedback(code,action==='lost_response'?'unknown':'completed'),diagnostic);
  diagnostic.stage='finalize';
  await executionDb.batch([
   sql("UPDATE re_demo_operations SET state='completed',result_json=? WHERE owner_id=? AND operation_id=? AND state='pending'",JSON.stringify(result),ownerId,operationId),
   sql('UPDATE re_demo_generations SET locked_operation_id=NULL,revision=revision+1 WHERE owner_id=? AND locked_operation_id=?',ownerId,operationId),
  ]);
  return result;
 }
 async function act(input){const diagnostic={stage:null};try{return await runAct(input,diagnostic);}catch(error){
  if(error&&typeof error==='object')try{error.demoStage=diagnostic.stage;}catch{}
  if(error?.code!=='demo_execution_obsolete')throw error;
  const completed=await one("SELECT result_json FROM re_demo_operations WHERE owner_id=? AND operation_id=? AND state='completed'",ownerId,input.operationId);
  if(!completed?.result_json)throw error;return {...JSON.parse(completed.result_json),replayed:true};
 }}
 return Object.freeze({read:async()=>view(await current()),act});
}
