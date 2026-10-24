import { createCabinetCustomerContext,createFinancialCustomerContext,readTrustedContext } from '../v1.4.1/trusted-context.mjs';
import { createAuthorityResolver,readActorFacts,compileAuthorityAssertions,compileAuthorityReplayAssertions } from '../v1.4.1/authority-resolver.mjs';
import { assertMiniAppRequest,extractBearerSessionToken,MINI_APP_SECURITY_HEADERS } from '../v1.4.0-rebuild/mini-app-security.mjs';
import { readCabinetAdminGate } from '../v1.4.0-rebuild/cabinet-participants.mjs';
import { resolveOwnPackagePeriodAuthority,createServerPackageQuote,createServerMonthlyTransitionQuote,
  planScheduledPackageTransition,cancelScheduledPackageTransition,compilePackagePeriodAssertions,readVerifiedPackagePeriods } from './package-contract.mjs';
import { inspectPackageSchema,packageSchemaAssertion } from './package-schema.mjs';
import { issuePackageInvoice,isStoredPackageFinancialInvoice } from './package-payment-runtime.mjs';
import { executeMonthlyTransitionCommand,prepareMonthlyReservation,prepareMonthlyReservationCancellation } from './monthly-transition-runtime.mjs';
import { requestOwnPackageRefund } from './package-settlement-runtime.mjs';
import { createRuntimeAuthorizer } from '../v1.4.1/runtime-authorizer.mjs';
import { readOwnPackageSupportRecovery } from './package-support-recovery.mjs';
import { readPackagePurchaseRequest, assertConfirmedPackageOffer, confirmedPackageTermsStatement,
  projectPublicPackageQuote } from './package-confirmation.mjs';

export const PACKAGE_COMMERCE_API_PREFIX='/api/v1.4.0/cabinet/packages/';
const resolver=createAuthorityResolver();
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))fail('package_request_invalid',400);return value;};
const columns='transition_id telegram_id idempotency_key request_sha256 contract_version source_subscription_id source_package_period_id source_payment_ledger_entry_id source_revision source_fingerprint from_plan from_billing_mode to_plan to_billing_mode target_package_code target_price_id target_price_version period_seconds offer_version campaign_code source_paid_until effective_at state revision target_order_id target_period_id target_grant_id cancel_command_id cancel_idempotency_key cancel_request_sha256 cancelled_at created_at updated_at'.split(' ');
const mapping={transition_id:'transitionId',telegram_id:'telegramId',idempotency_key:'idempotencyKey',request_sha256:'requestHash',
  contract_version:'contractVersion',source_subscription_id:'sourceSubscriptionId',source_package_period_id:'sourcePackagePeriodId',
  source_payment_ledger_entry_id:'sourcePaymentLedgerEntryId',source_revision:'sourceRevision',source_fingerprint:'sourceFingerprint',
  from_plan:'fromPlan',from_billing_mode:'fromBillingMode',to_plan:'toPlan',to_billing_mode:'toBillingMode',target_package_code:'targetPackageCode',
  target_price_id:'targetPriceId',target_price_version:'targetPriceVersion',period_seconds:'periodSeconds',offer_version:'offerVersion',campaign_code:'campaignCode',
  source_paid_until:'sourcePaidUntil',effective_at:'effectiveAt',state:'state',revision:'revision',target_order_id:'targetOrderId',
  target_period_id:'targetPeriodId',target_grant_id:'targetGrantId',cancel_command_id:'cancelCommandId',cancel_idempotency_key:'cancelIdempotencyKey',
  cancel_request_sha256:'cancelRequestHash',cancelled_at:'cancelledAt',created_at:'createdAt',updated_at:'updatedAt'};
const model=row=>Object.fromEntries(columns.map(key=>[mapping[key],row[key]??null]));
const publicTransition=row=>Object.freeze({transitionId:row.transitionId,fromPlan:row.fromPlan,toPlan:row.toPlan,
  packageCode:row.targetPackageCode,billingMode:row.toBillingMode,effectiveAt:row.effectiveAt,state:row.state,revision:row.revision,
  periodSeconds:row.periodSeconds,priceVersion:row.targetPriceVersion,offerVersion:row.offerVersion,campaignCode:row.campaignCode,
  accessApplied:false,refundApplied:false});
function snapshotSql(){
  const pieces=[];
  for(let i=0;i<columns.length;i+=16)pieces.push('json_object('+columns.slice(i,i+16).map(key=>`'${key}',${key}`).join(',')+')');
  const row=pieces.reduce((a,b)=>`json_patch(${a},${b})`);
  return `SELECT COALESCE(json_group_array(json(snapshot)),'[]') AS snapshot FROM
    (SELECT ${row} AS snapshot FROM subscription_plan_transitions WHERE telegram_id=? ORDER BY transition_id LIMIT 129)`;
}
async function captureTransitions(identity){
  const sql=snapshotSql(),params=[identity.telegramId],result=await identity.db.prepare(sql).bind(...params).all();
  if(result?.success!==true||result.results?.length!==1||typeof result.results[0].snapshot!=='string')fail('package_transition_source_unavailable',503);
  let rows;try{rows=JSON.parse(result.results[0].snapshot);}catch{fail('package_transition_source_unavailable',503);}
  if(!Array.isArray(rows)||rows.length>128)fail('package_transition_source_overflow',503);
  return {rows:rows.map(model),assertion:{sql:`(${sql}) = ?`,params:[...params,result.results[0].snapshot]}};
}
function ownActor(actor){const facts=readActorFacts(actor);if(facts.actorKind!=='customer'||!facts.canonicalOwner||
  !facts.account.exists||!facts.account.acceptedTerms||facts.account.isBlocked||facts.account.pendingDeletion)fail('package_owner_authority_required',403);return facts;}
async function guardedBatch(identity,assertions,effects){
  const key='v144p_'+crypto.randomUUID().replaceAll('-',''),guard=proof=>identity.db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
    VALUES(?,CASE WHEN (${proof.sql}) THEN 1 ELSE 0 END)`).bind(key+':'+crypto.randomUUID(),...proof.params);
  const statements=assertions.map(guard),guardKeys=statements.length;
  const cleanup=identity.db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key LIKE ?').bind(key+':%');
  const results=await identity.db.batch([...statements,...effects,cleanup]);
  if(!Array.isArray(results)||results.length!==guardKeys+effects.length+1||results.some(r=>r?.success!==true))fail('package_atomic_persistence_unconfirmed',503);
  return results.slice(guardKeys,-1);
}
async function replay(identity,actor,transition,captured){
  const proof=compileAuthorityReplayAssertions(actor);
  // Private replay checks identity and the exact stored command atomically.
  // Independent guards remain split to obey D1's parameter limit.
  await guardedBatch(identity,[...proof.assertions,captured.assertion],[]);
  return {transition:publicTransition(transition),replayed:true,accessApplied:false};
}

// This receipt is a server read model, never a capability. The historical
// accessApplied field belongs to the legacy grant/referral pipeline; package
// activation is reported separately from freshly verified canonical authority.
export async function buildVerifiedPackagePaymentResult(context,payment){
  const identity=readTrustedContext(context),actor=await resolver.resolveActor(context),facts=ownActor(actor),now=facts.nowSeconds;
  if(identity.actorKind!=='customer'||identity.operation!=='access.read_own'||identity.transportBinding?.kind!=='telegram'||
      !/^[a-f0-9]{64}$/u.test(identity.transportBinding.financialUpdateSha256??'')||!identity.requestPayload?.update?.message?.successful_payment)
    fail('package_receipt_context_invalid',403);
  const token=await resolveOwnPackagePeriodAuthority({actor,nowSec:now});
  const period=readVerifiedPackagePeriods(token).find(row=>row.periodId===payment.periodId&&row.orderId===payment.orderId&&
    row.ledgerEntryId===payment.ledgerEntryId);
  if(!period||period.planCode!==payment.planCode||period.amountStars!==payment.amountStars||
      period.startsAt!==payment.periodStartsAt||period.endsAt!==payment.periodEndsAt||
      period.endsAt-period.startsAt!==payment.accessSeconds)fail('package_receipt_source_invalid');
  await guardedBatch(identity,[...compileAuthorityAssertions(actor).assertions,...compilePackagePeriodAssertions(token).assertions],[]);
  const currentAccessApplied=period.status==='active'&&period.startsAt<=now&&period.endsAt>now&&facts.access.status==='verified'&&
    facts.access.sourceKind==='package_payment'&&facts.access.sourceRef==='package:'+period.periodId&&facts.access.effectivePlan===period.planCode;
  const state=period.status!=='active'?period.status:period.startsAt>now?'scheduled':period.endsAt<=now?'expired':
    currentAccessApplied?'active':'review_required';
  const date=value=>new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',
    hour:'2-digit',minute:'2-digit'}).format(new Date(value*1000));
  const label=period.planCode==='dragon'?'Dragon 🔴':'Professional 🔵',reference=period.orderId.slice(-8).toUpperCase();
  const stateText=state==='active'?'Доступ активен.':state==='scheduled'?'Доступ начнётся после окончания текущего оплаченного периода.':
    state==='expired'?'Оплаченный период завершён.':state==='refunded'?'Возврат учтён; этот платёж больше не предоставляет доступ.':
    state==='chargeback'?'Компенсация учтена; этот платёж больше не предоставляет доступ.':'Статус доступа требует проверки в /paysupport.';
  const text='<b>✅ Оплата подтверждена</b>\n\n'+`Тариф: <b>${label}</b>\nОплачено: <b>${period.amountStars} ⭐</b>\n`+
    `Период: <b>${(period.endsAt-period.startsAt)/86400} дней</b>\nНачало: <b>${date(period.startsAt)} МСК</b>\n`+
    `Окончание: <b>${date(period.endsAt)} МСК</b>\nКвитанция: <code>${reference}</code>\n\n${stateText}\n`+
    'Автосписания нет. По вопросам покупки — /paysupport.';
  return Object.freeze({...payment,accessApplied:false,currentAccessApplied,currentAccess:Object.freeze({verified:facts.access.status==='verified',
    effectivePlan:facts.access.effectivePlan,sourceKind:facts.access.sourceKind,validUntil:facts.access.validUntil}),
    packageReceipt:Object.freeze({state,orderReference:reference,planCode:period.planCode,packageCode:period.packageCode,
      amountStars:period.amountStars,startsAt:period.startsAt,endsAt:period.endsAt,currentAccessApplied}),
    receipt:Object.freeze({text,orderReference:reference})});
}

// Server command adapter consumes only an authenticated private context. Raw
// requested plan/package codes select a fixed price; no body supplies money,
// dates, actor, period authority, source row, provider or ledger facts.
export async function executePackageCommerceCommand(context,operation,options={}){
  if(operation==='recovery'){
    exact(readTrustedContext(context).requestPayload??{},[]);
    return readOwnPackageSupportRecovery({authorization:await createRuntimeAuthorizer().authorize(context)});
  }
  if(operation==='monthly-invoice')return executeMonthlyTransitionCommand(context,options);
  if(operation==='refund')return requestOwnPackageRefund(context,readTrustedContext(context).requestPayload,options);
  const identity=readTrustedContext(context),actor=await resolver.resolveActor(context),facts=ownActor(actor);
  if(identity.actorKind!=='customer'||identity.operation!=='access.read_own')fail('package_command_context_invalid',403);
  const now=facts.nowSeconds,payload=identity.requestPayload??{};
  if(operation==='invoice'){
    readPackagePurchaseRequest(payload);
    return issuePackageInvoice({actor,request:payload,createdAt:now},options);
  }
  if(operation==='quote'){
    exact(payload,['requestedPlanCode','packageCode']);
    const verifiedPackagePeriods=await resolveOwnPackagePeriodAuthority({actor,nowSec:now});
    const quote=payload.packageCode==='30d'?createServerMonthlyTransitionQuote({actor,verifiedPackagePeriods,nowSec:now,
      request:{requestedPlanCode:payload.requestedPlanCode}}):createServerPackageQuote({actor,verifiedPackagePeriods,nowSec:now,request:payload});
    await guardedBatch(identity,[...compileAuthorityAssertions(actor).assertions,...compilePackagePeriodAssertions(verifiedPackagePeriods).assertions],[]);
    return {quote:projectPublicPackageQuote(quote),accessApplied:false};
  }
  const schema=await inspectPackageSchema(identity.db,{required:true}),captured=await captureTransitions(identity);
  if(operation==='transitions'){exact(payload,[]);await guardedBatch(identity,[...compileAuthorityAssertions(actor).assertions,
    packageSchemaAssertion(schema),captured.assertion],[]);return {transitions:captured.rows.map(publicTransition),accessApplied:false};}
  if(!['schedule','cancel'].includes(operation)||!identity.transportBinding?.idempotencyKey||!identity.payloadHash)
    fail('package_command_context_invalid',403);
  const key=identity.transportBinding.idempotencyKey,requestHash=identity.payloadHash;
  if(operation==='schedule'){
    const {request,confirmation}=readPackagePurchaseRequest(payload);
    const prior=captured.rows.find(row=>row.idempotencyKey===key);
    if(prior){if(prior.requestHash!==requestHash||prior.toPlan!==payload.requestedPlanCode||prior.targetPackageCode!==payload.packageCode)
      fail('package_schedule_idempotency_collision');return replay(identity,actor,prior,captured);}
    const previous=captured.rows.find(row=>row.state==='scheduled')??null;
    const verifiedPackagePeriods=await resolveOwnPackagePeriodAuthority({actor,nowSec:now});
    const quote=payload.packageCode==='30d'?createServerMonthlyTransitionQuote({actor,verifiedPackagePeriods,nowSec:now,
      request:{requestedPlanCode:payload.requestedPlanCode}}):createServerPackageQuote({actor,verifiedPackagePeriods,nowSec:now,request});
    assertConfirmedPackageOffer(identity,quote,confirmation);
    const planned=planScheduledPackageTransition({quote,actor,nowSec:now,transitionId:crypto.randomUUID(),idempotencyKey:key,requestHash,previous});
    const raw=Object.fromEntries(columns.map(name=>[name,planned.transition[mapping[name]]]));
    const authority=compileAuthorityAssertions(actor),paid=compilePackagePeriodAssertions(verifiedPackagePeriods);
    const reservation=quote.billingMode==='recurring'?await prepareMonthlyReservation({context,actor,quote,
      transition:planned.transition,nowSeconds:now}):{assertions:[],statements:[]};
    await guardedBatch(identity,[...authority.assertions,...paid.assertions,packageSchemaAssertion(schema),captured.assertion,...reservation.assertions],[
      ...confirmedPackageTermsStatement(identity,quote,confirmation,now),
      identity.db.prepare(`INSERT INTO subscription_plan_transitions(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...columns.map(c=>raw[c])),
      ...reservation.statements]);
    const persisted=await identity.db.prepare('SELECT * FROM subscription_plan_transitions WHERE transition_id=? AND telegram_id=?')
      .bind(planned.transition.transitionId,identity.telegramId).first();
    if(!persisted)fail('package_atomic_persistence_unconfirmed',503);
    return {transition:publicTransition(model(persisted)),replayed:false,accessApplied:false};
  }
  exact(payload,['transitionId','expectedRevision']);
  const prior=captured.rows.find(row=>row.transitionId===payload.transitionId);
  if(!prior)fail('package_transition_unavailable',404);
  if(prior.state==='cancelled'){
    if(prior.cancelIdempotencyKey!==key||prior.cancelRequestHash!==requestHash||prior.revision!==payload.expectedRevision+1)
      fail('package_cancel_idempotency_collision');return replay(identity,actor,prior,captured);
  }
  const planned=cancelScheduledPackageTransition({actor,nowSec:now,transition:prior,expectedRevision:payload.expectedRevision,
    commandId:crypto.randomUUID(),idempotencyKey:key,requestHash}),authority=compileAuthorityAssertions(actor);
  const reservation=prior.toBillingMode==='recurring'?await prepareMonthlyReservationCancellation({context,transition:prior,nowSeconds:now}):{assertions:[],statements:[]};
  const effects=await guardedBatch(identity,[...authority.assertions,packageSchemaAssertion(schema),captured.assertion,...reservation.assertions],[
    identity.db.prepare(`UPDATE subscription_plan_transitions SET state='cancelled',revision=revision+1,cancel_command_id=?,
      cancel_idempotency_key=?,cancel_request_sha256=?,cancelled_at=?,updated_at=? WHERE transition_id=? AND telegram_id=? AND state='scheduled' AND revision=?`)
      .bind(planned.transition.cancelCommandId,key,requestHash,now,now,prior.transitionId,identity.telegramId,payload.expectedRevision),...reservation.statements]);
  if(effects[0]?.meta?.changes!==1)fail('package_cancel_revision_changed');
  return {transition:publicTransition(planned.transition),replayed:false,accessApplied:false,refundApplied:false};
}

const json=(data,status=200)=>Response.json(data,{status,headers:{...MINI_APP_SECURITY_HEADERS,'Cache-Control':'no-store'}});
export async function handlePackageCommerceRequest(request,env,options={}){
  const url=new URL(request.url);if(!url.pathname.startsWith(PACKAGE_COMMERCE_API_PREFIX))return null;
  const operation=url.pathname.slice(PACKAGE_COMMERCE_API_PREFIX.length);
  if(!['quote','invoice','monthly-invoice','refund','schedule','cancel','transitions','recovery'].includes(operation)||url.search||
      request.method!==(['transitions','recovery'].includes(operation)?'GET':'POST'))return json({error:'invalid_request'},400);
  try{
    const now=Math.floor(Date.now()/1000),gate=readCabinetAdminGate(env,now);if(!gate)fail('package_owner_authority_required',403);
    let payload={},size=0;
    if(request.method==='POST'){
      const reader=request.body?.getReader();if(!reader)fail('package_request_invalid',400);
      const chunks=[];let timer;
      try{const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('body_timeout')),5000);});
        for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;size+=part.value.byteLength;
          if(size>16384)fail('payload_too_large',413);chunks.push(part.value);}
        const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
        payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      }catch(error){if(error.code)throw error;fail('package_request_invalid',400);}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
    }
    assertMiniAppRequest({method:request.method,url:request.url,expectedOrigin:gate.origin,origin:request.headers.get('Origin'),
      contentType:request.headers.get('Content-Type')??undefined,contentLength:size,idempotencyKey:request.headers.get('Idempotency-Key')??undefined,
      secFetchSite:request.headers.get('Sec-Fetch-Site')??undefined});
    const context=await createCabinetCustomerContext({binding:env.DB,env,sessionToken:extractBearerSessionToken(request.headers.get('Authorization')),
      sessionScope:{candidateSha:gate.candidateSha,revision:gate.revision},channel:'mini_app',operation:operation==='refund'?'admin.stars.refund':'access.read_own',
      requestPayload:payload,...(request.method==='POST'?{idempotencyKey:request.headers.get('Idempotency-Key')}:{})});
    return json(await executePackageCommerceCommand(context,operation,options));
  }catch(error){const status=Number.isInteger(error.status)&&error.status>=400&&error.status<500?error.status:503;
    if(status>=500)console.error('Package commerce request error',
      [error?.code,error?.message,error?.name].find(value=>typeof value==='string'&&/^[a-zA-Z][a-zA-Z0-9_.-]{1,95}$/u.test(value))??'package_unavailable');
    return json({error:status<500&&/^[a-z][a-z0-9_]{1,95}$/u.test(error.code??'')?error.code:'package_unavailable'},status);}
}

// Used only by the existing fixed Stars dispatcher. Missing schema or no own
// metadata preserves the legacy route. Real package payments remain recordable
// when a customer is unavailable; only automatic future access needs an actor.
export async function preparePackageFinancialIngress(env,update,options={}){
  const empty=()=>({packageActor:null,packageFinancialContext:null});
  if(!update?.pre_checkout_query&&!update?.message?.successful_payment)return empty();
  const payload=update.pre_checkout_query?.invoice_payload??update.message.successful_payment.invoice_payload;
  if(!await isStoredPackageFinancialInvoice(env,payload))return empty();
  if(!(options.originalWebhookRequest instanceof Request))fail('untrusted_financial_transport',403);
  const original=await options.originalWebhookRequest.clone().json();
  if(JSON.stringify(original)!==JSON.stringify(update))fail('untrusted_financial_transport',403);
  // An unconfirmed original transport/receipt must never turn a genuine
  // observation into an acknowledged event without a financial record.
  const context=await createFinancialCustomerContext({binding:env.DB,env,webhookRequest:options.originalWebhookRequest,
    receiptClaimToken:options.receiptClaimToken,nowSeconds:options.nowSeconds});
  let actor=null;
  try{actor=await resolver.resolveActor(context);}catch(error){
    if(!error?.code||/^(?:D1_|SQLITE_)/u.test(error.code))throw error;
  }
  return {packageActor:actor,packageFinancialContext:context};
}
