import { readRuntimeAuthorization,requireRuntimeAuthorization,assertRuntimeAuthorizationFresh } from '../v1.4.1/runtime-authorizer.mjs';
import { readTrustedContext,deriveTrustedOperationContext } from '../v1.4.1/trusted-context.mjs';

const fail=(code,status=403)=>{throw Object.assign(new Error(code),{code,status});};
const positive=value=>Number.isSafeInteger(value)&&value>0;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&
  keys.every(key=>Object.hasOwn(value,key));
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/u.test(value);

export function normalizeSubscriptionOperationStatusIntent(body) {
  if(!exact(body,['kind','intent'])||!['invoice','cancel','enable'].includes(body.kind)) fail('invalid_operation_status',400);
  const intent=body.intent;
  if(body.kind==='invoice') {
    if(!exact(intent,['planCode','recurringConsent','termsRevision','priceVersion'])||
        !['professional','dragon'].includes(intent.planCode)||intent.recurringConsent!==true||
        typeof intent.termsRevision!=='string'||intent.termsRevision.length<1||intent.termsRevision.length>128||!positive(intent.priceVersion))
      fail('invalid_operation_status',400);
    return {operation:'billing.purchase_monthly',requestPayload:{action:'accept',requestedPlanCode:intent.planCode,
      billingMode:'recurring',recurringConsent:true,termsRevision:intent.termsRevision,priceVersion:intent.priceVersion}};
  }
  if(!exact(intent,['contractId','expectedRevision'])||!identifier(intent.contractId)||!positive(intent.expectedRevision))
    fail('invalid_operation_status',400);
  return {operation:'access.read_own',requestPayload:{subscriptionAction:body.kind==='cancel'?'cancel_renewal':'reenable_renewal',
    contractId:intent.contractId,expectedRevision:intent.expectedRevision}};
}

function invoiceUrl(value) {
  try {const url=new URL(value);return typeof value==='string'&&value.length<=2048&&url.protocol==='https:'&&url.hostname==='t.me'&&
    !url.username&&!url.password&&!url.search&&!url.hash&&/^\/\$[A-Za-z0-9_-]+$/u.test(url.pathname);}catch{return false;}
}

// Read-only recovery of one exact original attempt. Deriving its fixed sibling
// context recovers only the server's private operation/hash mapping; no purchase
// decision, command admission, producer or provider is invoked here.
export async function readOwnSubscriptionOperationStatus({authorization}={}) {
  requireRuntimeAuthorization(authorization);
  const input=readRuntimeAuthorization(authorization),identity=readTrustedContext(input.context),payload=identity.requestPayload;
  if(identity.actorKind!=='customer'||identity.operation!=='access.read_own'||identity.channel!=='mini_app'||
      !identity.verifiedSessionId||identity.transportBinding?.kind!=='http'||identity.transportBinding.actor!==identity.telegramId||
      !exact(payload,['subscriptionOperationStatus'])) fail('operation_status_principal_invalid');
  const body=payload.subscriptionOperationStatus,original=normalizeSubscriptionOperationStatusIntent(body);
  const prior=readTrustedContext(await deriveTrustedOperationContext(input.context,original));
  const invoice=body.kind==='invoice';
  const columns=invoice?'request_id,contract_id,origin_order_id,telegram_id,idempotency_key,request_sha256,state,invoice_url':
    'command_id,contract_id,telegram_id,idempotency_key,action,expected_contract_revision,request_sha256,state';
  const table=invoice?'subscription_invoice_requests':'subscription_provider_commands';
  const key=(invoice?'stars-invoice:':'stars-command:')+prior.operationId;
  const sql=`SELECT ${columns} FROM ${table} WHERE idempotency_key=? AND telegram_id=? LIMIT 2`;
  const read=async()=>{
    let result;try {result=await identity.db.prepare(sql).bind(key,identity.telegramId).all();}
    catch {fail('operation_status_unavailable',503);}
    if(result?.success!==true||!Array.isArray(result.results)||result.results.length>1) fail('operation_status_unavailable',503);
    return result.results;
  };
  const rows=await read(),row=rows[0]??null;
  if(row&&(row.idempotency_key!==key||row.telegram_id!==identity.telegramId||row.request_sha256!==prior.payloadHash||
      !invoice&&(row.contract_id!==body.intent.contractId||row.expected_contract_revision!==body.intent.expectedRevision||
        row.action!==original.requestPayload.subscriptionAction))) fail('operation_status_intent_conflict',409);
  if(row&&!['admitted','attempted','confirmed','rejected','unknown','superseded'].includes(row.state)) fail('operation_status_unavailable',503);
  if(invoice&&row?.state==='confirmed'&&!invoiceUrl(row.invoice_url)) fail('operation_status_unavailable',503);
  await assertRuntimeAuthorizationFresh(authorization);
  if(JSON.stringify(rows)!==JSON.stringify(await read())) fail('operation_status_source_changed',409);
  return Object.freeze({authority:'worker',kind:body.kind,state:row?.state==='attempted'?'pending':row?.state==='superseded'?'unknown':row?.state??'missing',
    attemptId:row?(invoice?row.request_id:row.command_id):null,contractId:row?.contract_id??null,
    invoiceUrl:invoice&&row?.state==='confirmed'?row.invoice_url:null,effectRecorded:Boolean(row),accessApplied:false,
    reviewRequired:Boolean(row&&['attempted','unknown','superseded'].includes(row.state)),actionAdmissionRequired:true});
}
