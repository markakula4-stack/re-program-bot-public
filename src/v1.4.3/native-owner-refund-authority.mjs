import {assertV143NativeReadinessCompiledDescriptors,assertV143NativeReadinessRuntimeData,
  readV143NativeReadinessConfig,V143_NATIVE_READINESS_FRAME} from './native-readiness-config.mjs';
import {canonicalCabinetOwnerId} from '../v1.4.0-rebuild/cabinet-participants.mjs';
import {verifyStarsInvoicePayload} from '../v1.3.6/stars-core-foundation.mjs';
import {V143_READINESS_INSTALL_PLAN as PLAN} from './readiness-install-plan.mjs';

// This is one selected, already-paid owner canary. It is independent of the
// public refund switch and cannot select an amount, customer or provider charge.
export const NATIVE_OWNER_REFUND_PATH='/__rebuild/v1.4.3/native-owner-refund';
export const NATIVE_OWNER_REFUND_ORIGIN='https://re-program-bot.markakula4.workers.dev';
export const NATIVE_OWNER_REFUND_DOMAIN='re-native-owner-refund/v1';
export const V143_NATIVE_OWNER_REFUND_FRAME=Object.freeze({
  ownerId:8987576334,botId:8562951985,receiptId:'stars-34eb77624cd088e1455319e3',
  planCode:'professional',currency:'XTR',amountStars:249,periodSeconds:2592000,
  leaseSourceSha:'d66c61516062d50321892f7b021a3eb147454e47',leaseRevision:40,
  deadlineUnix:1791298740,acceptanceSha256:'49a4491848804272087a42916e1c2b04b7aaa59e0c431198509b9efa2d88783d',
  schemaSha256:V143_NATIVE_READINESS_FRAME.schemaSha256,
  ledgerSha256:V143_NATIVE_READINESS_FRAME.ledgerSha256
});
const FRAME=V143_NATIVE_OWNER_REFUND_FRAME,admissions=new WeakMap(),encoder=new TextEncoder();
const fail=code=>{throw Object.assign(new Error('native_owner_refund_'+code),{code:'native_owner_refund_'+code,status:409});};
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(value))&&
  Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))&&
  Object.values(Object.getOwnPropertyDescriptors(value)).every(d=>Object.hasOwn(d,'value')&&d.enumerable===true);
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){
  Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export const hashNativeOwnerRefund=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(String(value))))]
  .map(n=>n.toString(16).padStart(2,'0')).join('');
const hmac=async(key,value)=>{
  const imported=await crypto.subtle.importKey('raw',encoder.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',imported,encoder.encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
};
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;
  let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;};
export function v143NativeOwnerRefundSigningInput(body){
  return NATIVE_OWNER_REFUND_DOMAIN+'\nPOST\n'+NATIVE_OWNER_REFUND_ORIGIN+NATIVE_OWNER_REFUND_PATH+'\n'+
    JSON.stringify([body.action,body.operationKey,body.issuedAt,body.expiresAt]);
}
function compiledKey(env){
  // Descriptor validation precedes every read/spread of historical capsules.
  if(!assertV143NativeReadinessCompiledDescriptors())fail('compiled_frame_required');
  assertV143NativeReadinessRuntimeData(env);
  const native=readV143NativeReadinessConfig(),descriptor=Object.getOwnPropertyDescriptor(globalThis,'__RE_PROGRAM_V1411_ADMIN_CONFIG__');
  if(native?.sourceSha!==FRAME.leaseSourceSha||native.mode!=='owner_acceptance'||native.recurringEnabled!==true||
    !digest(FRAME.acceptanceSha256)||!descriptor||!Object.hasOwn(descriptor,'value')||
    descriptor.writable!==false||descriptor.configurable!==false)fail('compiled_frame_required');
  const admin=descriptor.value;
  if(admin.sourceSha!==FRAME.leaseSourceSha||admin.supportCandidateSha!==FRAME.leaseSourceSha||
    admin.mode!=='owner_only'||!digest(admin.supportBridgeKey)||canonicalCabinetOwnerId(env)!==FRAME.ownerId||
    typeof env.BOT_TOKEN!=='string'||env.BOT_TOKEN.split(':')[0]!==String(FRAME.botId)||
    env.STARS_REFUNDS_ENABLED!=='false'||env.STARS_PAID_NOTIFICATIONS_ENABLED!=='false'||
    env.REBUILD_V140_WRITES_ENABLED!=='false'||typeof env.STARS_INVOICE_SECRET!=='string'||env.STARS_INVOICE_SECRET.length<32)
    fail('runtime_frame_required');
  return admin.supportBridgeKey;
}
function bodyValid(body,now){
  if(!exact(body,['action','operationKey','issuedAt','expiresAt','signature'])||
    !['refund','status'].includes(body.action)||body.operationKey!==FRAME.receiptId||!digest(body.signature)||
    !positive(body.issuedAt)||!positive(body.expiresAt)||!positive(now)||
    body.expiresAt<=body.issuedAt||body.expiresAt-body.issuedAt>300||
    body.issuedAt>now||now>=body.expiresAt||body.expiresAt>FRAME.deadlineUnix||now>=FRAME.deadlineUnix)
    fail('request_required');
}
async function readBody(request){
  const reader=request.body?.getReader();if(!reader)fail('request_required');
  let timer,total=0;const chunks=[];
  try{
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('deadline')),5000);});
    for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;
      if((total+=part.value.length)>768)fail('request_required');chunks.push(part.value);}
    const raw=new Uint8Array(total);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  }catch{fail('request_required');}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
async function rows(db,sql,params=[],maximum=128){
  let result;try{result=await db.prepare(sql).bind(...params).all();}catch{fail('source_unavailable');}
  if(result?.success!==true||!Array.isArray(result.results)||result.results.length>maximum)fail('source_unavailable');
  return result.results;
}
const SCHEMA_SQL="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name";
const LEDGER_SQL='SELECT version FROM re_schema_migrations ORDER BY version';
const LEASE_COLUMNS='id,candidate_sha,revision,state,beta_enabled,owner_telegram_id,issued_at,expires_at,updated_at';
const OWNER_SQL=`EXISTS(SELECT 1 FROM users WHERE telegram_id=? AND accepted_terms=1 AND is_blocked=0)
  AND EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=? AND role='admin' AND status='active')
  AND NOT EXISTS(SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending'
    AND (unixepoch(expires_at) IS NULL OR unixepoch(expires_at)>unixepoch()))
  AND NOT EXISTS(SELECT 1 FROM user_moderation_blocks WHERE target_telegram_id=? AND status='active')`;
async function frame(db,now){
  const schema=await rows(db,SCHEMA_SQL+' LIMIT 1150',[],1149),ledger=await rows(db,LEDGER_SQL+' LIMIT 257',[],256),
    leases=await rows(db,`SELECT ${LEASE_COLUMNS} FROM mini_app_release_control WHERE id=1 LIMIT 2`,[],1),
    eligible=await rows(db,`SELECT (${OWNER_SQL}) ready`,[FRAME.ownerId,FRAME.ownerId,FRAME.ownerId,FRAME.ownerId],1);
  if(schema.length!==1149||schema.filter(row=>row.type==='table').length!==257||!ledger.length||leases.length!==1||
    eligible.length!==1||eligible[0].ready!==1||schema.some(row=>!exact(row,['type','name','tbl_name','sql'])||
      Object.values(row).some(value=>typeof value!=='string'))||ledger.some(row=>!exact(row,['version'])||typeof row.version!=='string'))
    fail('frame_unverified');
  const schemaJson=JSON.stringify(schema.map(row=>[row.type,row.name,row.tbl_name,row.sql])),
    ledgerJson=JSON.stringify(ledger.map(row=>row.version)),lease=leases[0],
    leaseJson=JSON.stringify(LEASE_COLUMNS.split(',').map(key=>lease[key]));
  if(await hashNativeOwnerRefund(schemaJson)!==FRAME.schemaSha256||await hashNativeOwnerRefund(ledgerJson)!==FRAME.ledgerSha256||
    lease.id!==1||lease.candidate_sha!==FRAME.leaseSourceSha||lease.revision!==FRAME.leaseRevision||
    lease.state!=='closed'||lease.beta_enabled!==0||lease.owner_telegram_id!==null||lease.issued_at!==null||
    lease.expires_at!==null||!positive(lease.updated_at))fail('frame_unverified');
  return [
    {sql:`(SELECT json_group_array(json_array(type,name,tbl_name,sql)) FROM (${SCHEMA_SQL})) IS ?`,params:[schemaJson]},
    {sql:`(SELECT json_group_array(version) FROM (${LEDGER_SQL})) IS ?`,params:[ledgerJson]},
    {sql:`(SELECT json_array(${LEASE_COLUMNS}) FROM mini_app_release_control WHERE id=1) IS ?`,params:[leaseJson]},
    {sql:OWNER_SQL,params:[FRAME.ownerId,FRAME.ownerId,FRAME.ownerId,FRAME.ownerId]},
    {sql:'unixepoch()>=? AND unixepoch()<?',params:[now,FRAME.deadlineUnix]}
  ];
}
function recordedReader(db,assertions){
  const extra={subscription_refund_cancellations:['refund_id','refund_ledger_entry_id','contract_id','telegram_id','command_id','actor_id','recorded_at']};
  return async(table,where,params=[],maximum=1)=>{
    const columns=PLAN.retainedColumns[table]??extra[table];if(!columns)fail('source_unavailable');
    const sql=`SELECT COALESCE(json_group_array(json(snapshot)),'[]') value FROM
      (SELECT json_array(${columns.join(',')}) snapshot FROM ${table} WHERE ${where} ORDER BY ${columns[0]} LIMIT ${maximum+1})`;
    const result=await rows(db,sql,params,1),snapshot=result[0]?.value;
    if(typeof snapshot!=='string'||encoder.encode(snapshot).length>=1024*1024)fail('source_unavailable');
    let raw;try{raw=JSON.parse(snapshot);}catch{fail('source_unavailable');}
    if(!Array.isArray(raw)||raw.length>maximum||raw.some(row=>!Array.isArray(row)||row.length!==columns.length))fail('source_unavailable');
    assertions.push({sql:`(${sql}) IS ?`,params:[...params,snapshot]});
    return raw.map(row=>Object.fromEntries(columns.map((key,i)=>[key,row[i]])));
  };
}
async function selected(db,env,now,body){
  const assertions=await frame(db,now),read=recordedReader(db,assertions),owner=FRAME.ownerId;
  assertions.push({sql:'unixepoch()>=? AND unixepoch()<?',params:[body.issuedAt,body.expiresAt]});
  const candidates=await rows(db,"SELECT ledger_entry_id FROM payment_ledger WHERE telegram_id=? AND entry_type='payment' AND direction='credit' ORDER BY ledger_entry_id LIMIT 129",[owner],128);
  const matches=[];for(const row of candidates){
    if(typeof row.ledger_entry_id!=='string')fail('selected_payment_unverified');
    if('stars-'+(await hashNativeOwnerRefund('v1.4.3.own-receipt\n'+owner+'\n'+row.ledger_entry_id)).slice(0,24)===FRAME.receiptId)matches.push(row.ledger_entry_id);
  }
  if(matches.length!==1)fail('selected_payment_unverified');
  const [payment]=await read('payment_ledger','ledger_entry_id=?',[matches[0]]),
    [order]=await read('subscription_orders','order_id=?',[payment?.order_id??'']),
    grants=await read('subscription_access_grants','payment_ledger_entry_id=?',[payment?.ledger_entry_id??'']),grant=grants[0],
    [subscription]=await read('subscriptions','subscription_id=?',[grant?.subscription_id??'']),
    links=await read('subscription_payment_links',"ledger_entry_id=? AND direction='incoming'",[payment?.ledger_entry_id??'']),link=links[0],
    [contract]=await read('subscription_billing_contracts','contract_id=?',[link?.contract_id??'']),
    [first]=await read('subscription_first_recurring_receipts','contract_id=?',[contract?.contract_id??'']),
    [price]=await read('price_book','price_id=? AND price_version=?',[order?.price_id??'',order?.price_version??0]),
    [terms]=await read('terms_acceptances','acceptance_id=?',[contract?.terms_acceptance_id??'']),
    refundRows=await read('payment_refunds','original_ledger_entry_id=? OR telegram_payment_charge_id=?',
      [payment?.ledger_entry_id??'',payment?.telegram_payment_charge_id??'']),refund=refundRows[0]??null,
    effects=await read('payment_ledger',"related_ledger_entry_id=? AND entry_type IN ('refund','chargeback')",[payment?.ledger_entry_id??'']),
    contractLinks=await read('subscription_payment_links',"contract_id=? AND direction='incoming'",[contract?.contract_id??'']),
    subscriptionGrants=await read('subscription_access_grants','subscription_id=?',[subscription?.subscription_id??'']),
    chargePayments=await read('payment_ledger',"telegram_payment_charge_id=? AND entry_type='payment'",[payment?.telegram_payment_charge_id??'']),
    commands=await read('subscription_provider_commands','contract_id=?',[contract?.contract_id??''],128),
    cancellations=await read('subscription_refund_cancellations','refund_id=?',[refund?.refund_id??'']),
    [userPlan]=await read('user_plans','telegram_id=?',[owner]),[userAccess]=await read('user_access_states','telegram_id=?',[owner]);
  if(!payment||!order||!grant||!subscription||!link||!contract||!first||!price||!terms||!userPlan||!userAccess||
    grants.length!==1||links.length!==1||contractLinks.length!==1||subscriptionGrants.length!==1||chargePayments.length!==1||
    payment.telegram_id!==owner||payment.entry_type!=='payment'||payment.direction!=='credit'||payment.currency!==FRAME.currency||
    payment.amount_stars!==FRAME.amountStars||payment.related_ledger_entry_id!==null||!payment.telegram_payment_charge_id||
    payment.reason_code==='payment_review_retained'||!positive(payment.occurred_at)||!positive(payment.recorded_at)||
    order.telegram_id!==owner||order.plan_code!==FRAME.planCode||order.currency!==FRAME.currency||order.amount_stars!==FRAME.amountStars||
    order.access_seconds!==FRAME.periodSeconds||order.billing_mode!=='recurring'||!['paid','applied','refunded'].includes(order.order_state)||
    grant.order_id!==order.order_id||grant.telegram_id!==owner||grant.plan_code!==FRAME.planCode||grant.access_seconds!==FRAME.periodSeconds||
    grant.starts_at!==link.provider_period_start||grant.ends_at!==link.provider_period_end||
    link.provider_period_end!==link.provider_period_start+FRAME.periodSeconds||!positive(link.provider_period_start)||
    subscription.telegram_id!==owner||subscription.plan_code!==FRAME.planCode||subscription.billing_mode!=='recurring'||
    subscription.source_order_id!==order.order_id||subscription.telegram_payment_charge_id!==payment.telegram_payment_charge_id||
    subscription.current_period_start!==grant.starts_at||subscription.current_period_end!==grant.ends_at||
    contract.telegram_id!==owner||contract.plan_code!==FRAME.planCode||contract.currency!==FRAME.currency||contract.amount_stars!==FRAME.amountStars||
    contract.period_seconds!==FRAME.periodSeconds||contract.billing_mode!=='recurring'||contract.retired_at!==null||
    contract.first_payment_ledger_entry_id!==payment.ledger_entry_id||contract.origin_order_id!==order.order_id||contract.price_id!==order.price_id||
    contract.terms_revision!==order.terms_revision||contract.external_invoice_payload!==order.invoice_payload||
    !digest(contract.external_payload_sha256)||await hashNativeOwnerRefund(order.invoice_payload)!==contract.external_payload_sha256||
    link.telegram_id!==owner||link.plan_code!==FRAME.planCode||link.link_kind!=='recurring_charge'||
    link.applied_order_id!==order.order_id||link.origin_order_id!==order.order_id||link.provider_charge_id!==payment.telegram_payment_charge_id||
    link.external_invoice_payload!==order.invoice_payload||link.external_payload_sha256!==contract.external_payload_sha256||
    !digest(link.evidence_sha256)||link.provider_charge_sha256!==await hashNativeOwnerRefund(payment.telegram_payment_charge_id)||
    first.operation_id!==link.operation_id||first.evidence_sha256!==link.evidence_sha256||!positive(first.verified_at)||
    first.verified_at<link.recorded_at||
    ['plan_code','currency','amount_stars','access_seconds','billing_mode','terms_revision'].some(key=>price[key]!==order[key])||
    !['approved','retired'].includes(price.publication_state)||price.valid_from>order.created_at||
    price.valid_until!==null&&price.valid_until<=order.created_at||terms.telegram_id!==owner||terms.terms_revision!==order.terms_revision||
    terms.acceptance_scope!=='stars_purchase'||terms.accepted_at>order.created_at||!digest(terms.evidence_sha256))fail('selected_payment_unverified');
  const verified=await verifyStarsInvoicePayload({invoiceSecret:env.STARS_INVOICE_SECRET,payload:order.invoice_payload,
    telegramId:owner,priceId:order.price_id});
  if(verified.orderId!==order.order_id)fail('selected_payment_unverified');
  if(refund&&(refund.idempotency_key!=='native-owner-refund:'+FRAME.receiptId||refund.order_id!==order.order_id||
    refund.telegram_id!==owner||refund.telegram_payment_charge_id!==payment.telegram_payment_charge_id||refund.currency!==FRAME.currency||
    refund.amount_stars!==FRAME.amountStars||refund.reason_code!=='admin_canary_validation'||refund.requested_by_type!=='admin'||
    refund.requested_by!==owner||!['requested','manual_review','failed','confirmed','applied'].includes(refund.status)))fail('refund_journal_unverified');
  if(!refund){
    if(effects.length||grant.status!=='active'||grant.compensation_ledger_entry_id!==null||
      !['active','cancel_at_period_end'].includes(subscription.status)||!['paid','applied'].includes(order.order_state)||
      subscription.last_ledger_entry_id!==payment.ledger_entry_id||userPlan.plan_code!==FRAME.planCode||
      !['active','cancel_at_period_end'].includes(userAccess.access_state)||commands.some(row=>['admitted','attempted','unknown'].includes(row.state)))
      fail('selected_payment_unavailable');
  }else if(refund.status==='applied'){
    const effect=effects[0];
    if(effects.length!==1||effect.entry_type!=='refund'||effect.direction!=='debit'||effect.telegram_id!==owner||
      effect.order_id!==order.order_id||effect.currency!==FRAME.currency||effect.amount_stars!==FRAME.amountStars||
      effect.telegram_payment_charge_id!==payment.telegram_payment_charge_id||grant.status!=='refunded'||
      grant.compensation_ledger_entry_id!==effect.ledger_entry_id||subscription.status!=='refunded'||
      subscription.last_ledger_entry_id!==effect.ledger_entry_id||order.order_state!=='refunded'||
      userPlan.plan_code!=='free'||userAccess.access_state!=='refunded'||!positive(refund.confirmed_at)||!positive(refund.applied_at))
      fail('refund_accounting_unverified');
  }else if(effects.length||grant.status!=='active'||grant.compensation_ledger_entry_id!==null||
    !['active','cancel_at_period_end'].includes(subscription.status)||!['paid','applied'].includes(order.order_state)||
    subscription.last_ledger_entry_id!==payment.ledger_entry_id||userPlan.plan_code!==FRAME.planCode||
    !['active','cancel_at_period_end'].includes(userAccess.access_state))fail('refund_accounting_unverified');
  return freeze({payment,order,grant,subscription,contract,first,link,refund,commands,cancellations,userPlan,userAccess,
    assertions,selectedSha256:await hashNativeOwnerRefund(JSON.stringify([payment,order,grant,subscription,contract,first,link,refund]))});
}
export async function authorizeV143NativeOwnerRefund(request,env,{clock=()=>Math.floor(Date.now()/1000)}={}){
  const url=new URL(request.url);
  if(request.method!=='POST'||url.origin!==NATIVE_OWNER_REFUND_ORIGIN||url.pathname!==NATIVE_OWNER_REFUND_PATH||url.search||url.hash||url.port||url.username||url.password||
    !/^application\/json(?:\s*;|$)/iu.test(request.headers.get('Content-Type')??''))fail('request_required');
  const key=compiledKey(env),body=await readBody(request),now=clock();bodyValid(body,now);
  if(!equal(await hmac(key,v143NativeOwnerRefundSigningInput(body)),body.signature))fail('signature_required');
  if(typeof env.DB?.withSession!=='function')fail('primary_database_required');
  const db=env.DB.withSession('first-primary');if(!db?.prepare||!db?.batch)fail('primary_database_required');
  const facts=await selected(db,env,now,body),token=Object.freeze({version:1,authority:'native_owner_selected_refund'});
  admissions.set(token,{env,db,key,body:freeze(body),clock,facts});return token;
}
export function readV143NativeOwnerRefundAdmission(token){
  const admission=token&&typeof token==='object'?admissions.get(token):null;
  if(!admission)return null;
  return Object.freeze({env:admission.env,db:admission.db,body:admission.body,facts:admission.facts,
    actorId:FRAME.ownerId,subjectId:FRAME.ownerId,ledgerId:admission.facts.payment.ledger_entry_id,
    refundId:admission.facts.refund?.refund_id??null,nativeCompletion:true});
}
export async function refreshV143NativeOwnerRefundAdmission(token){
  const admission=admissions.get(token);if(!admission)fail('authority_required');
  const key=compiledKey(admission.env),now=admission.clock();bodyValid(admission.body,now);
  if(!equal(key,admission.key)||!equal(await hmac(key,v143NativeOwnerRefundSigningInput(admission.body)),admission.body.signature))
    fail('authority_required');
  admission.facts=await selected(admission.db,admission.env,now,admission.body);return readV143NativeOwnerRefundAdmission(token);
}
export function compileV143NativeOwnerRefundAssertions(token){
  const admission=admissions.get(token);if(!admission)fail('authority_required');
  return Object.freeze({assertions:admission.facts.assertions});
}
export async function signV143NativeOwnerRefundResponse(token,body){
  const admission=admissions.get(token);if(!admission)fail('authority_required');
  return hmac(admission.key,'re-native-owner-refund-response/v1\n'+body);
}
