import { readVerifiedOwnerSubscriptionReview, compileVerifiedOwnerSubscriptionReviewAssertions } from './subscription-action-authority.mjs';
import { readTrustedContext } from '../v1.4.1/trusted-context.mjs';
import { buildStarsInvoicePayload, verifyStarsInvoicePayload, STARS_MONTH_SECONDS } from '../v1.3.6/stars-core-foundation.mjs';
import { callStarsTelegram } from '../v1.3.6/stars-payment-runtime.mjs';
import { prepareStarsImportedAccessStatements, applyStarsCompensation } from '../v1.3.6/stars-access-runtime.mjs';
import { cancelConfirmedRefundFutureRenewal } from './refund-contract-lifecycle.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code,status:409});};
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(value))))]
  .map(byte=>byte.toString(16).padStart(2,'0')).join('');
const clock=()=>Math.floor(Date.now()/1000);
const asRows=result=>{if(result?.success!==true||!Array.isArray(result.results))fail('review_source_read_failed');return result.results;};
async function one(db,sql,params=[]){const rows=asRows(await db.prepare(sql).bind(...params).all());if(rows.length>1)fail('review_source_ambiguous');return rows[0]||null;}
async function atomic(db,proofs,writes){
  const id=crypto.randomUUID(),pieces=proofs.assertions||proofs;
  if(!Array.isArray(pieces)||!pieces.length||pieces.length>128)fail('review_guard_invalid');
  const keys=pieces.map((_,i)=>`v143_review_${id}_${i}`);
  const before=pieces.map((p,i)=>db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
    VALUES(?,CASE WHEN (${p.sql}) THEN 1 ELSE 0 END)`).bind(keys[i],...p.params));
  const after=keys.map(key=>db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key=?').bind(key));
  const result=await db.batch([...before,...writes,...after]);
  if(!Array.isArray(result)||result.length!==before.length+writes.length+after.length||result.some(r=>r?.success!==true))fail('review_transaction_failed');
  return result.slice(before.length,before.length+writes.length);
}
async function verifySource(identity,proof){
  const db=identity.db,ledger=await one(db,"SELECT * FROM payment_ledger WHERE ledger_entry_id=? LIMIT 2",[proof.ledgerEntryId]);
  const receipt=await one(db,"SELECT * FROM subscription_payment_review_receipts WHERE ledger_entry_id=? LIMIT 2",[proof.ledgerEntryId]);
  const origin=receipt&&await one(db,"SELECT * FROM subscription_orders WHERE order_id=? LIMIT 2",[receipt.origin_order_id]);
  if(!ledger||!receipt||!origin||ledger.entry_type!=='payment'||ledger.direction!=='credit'||ledger.currency!=='XTR'||
    ledger.reason_code!=='payment_review_retained'||ledger.order_id!==origin.order_id||ledger.telegram_id!==receipt.telegram_id||
    origin.telegram_id!==receipt.telegram_id||origin.plan_code!==receipt.plan_code||ledger.amount_stars!==origin.amount_stars||
    receipt.external_invoice_payload!==origin.invoice_payload||await hash(receipt.external_invoice_payload)!==receipt.external_payload_sha256)
    fail('review_payment_binding_invalid');
  await verifyStarsInvoicePayload({invoiceSecret:identity.env.STARS_INVOICE_SECRET,payload:receipt.external_invoice_payload,
    telegramId:receipt.telegram_id,priceId:origin.price_id});
  if(receipt.contract_id){
    if(origin.billing_mode!=='recurring'||receipt.provider_period_end-receipt.provider_period_start!==STARS_MONTH_SECONDS)
      fail('review_period_evidence_invalid');
  }else if(origin.billing_mode!=='prepaid'||receipt.provider_period_start!==null||receipt.provider_period_end!==null||receipt.is_first_recurring!==0)
    fail('review_period_evidence_invalid');
  return {ledger,receipt,origin};
}
async function captureApplyGuards(db,receipt){
  const jobs=[
    ['SELECT json_array(is_blocked) AS snapshot FROM users WHERE telegram_id=?',[receipt.telegram_id]],
    ["SELECT json_array(COUNT(*)) AS snapshot FROM user_moderation_blocks WHERE target_telegram_id=? AND status='active'",[receipt.telegram_id]],
    ["SELECT json_array(COUNT(*)) AS snapshot FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending' AND (unixepoch(expires_at) IS NULL OR unixepoch(expires_at)>unixepoch())",[receipt.telegram_id]],
    ["SELECT COALESCE(json_group_array(json(snapshot)),'[]') AS snapshot FROM (SELECT json_array(access_state,revision) snapshot FROM user_access_states WHERE telegram_id=? ORDER BY telegram_id)",[receipt.telegram_id]],
    ["SELECT COALESCE(json_group_array(json(snapshot)),'[]') AS snapshot FROM (SELECT json_array(subscription_id,status,revision,current_period_start,current_period_end,last_ledger_entry_id,source_order_id) snapshot FROM subscriptions WHERE telegram_id=? ORDER BY subscription_id LIMIT 129)",[receipt.telegram_id]],
  ];
  if(receipt.contract_id) jobs.push(
    ['SELECT json_array(contract_id,provider_state,auto_renew_confirmed,first_payment_ledger_entry_id,retired_at,revision) AS snapshot FROM subscription_billing_contracts WHERE contract_id=?',[receipt.contract_id]],
    ["SELECT COALESCE(json_group_array(json(snapshot)),'[]') AS snapshot FROM (SELECT json_array(contract_id) snapshot FROM subscription_billing_contracts WHERE telegram_id=? AND retired_at IS NULL AND contract_id!=? ORDER BY contract_id LIMIT 129)",[receipt.telegram_id,receipt.contract_id]],
    ["SELECT COALESCE(json_group_array(json(snapshot)),'[]') AS snapshot FROM (SELECT json_array(effect.ledger_entry_id,effect.related_ledger_entry_id) snapshot FROM subscription_payment_links paid JOIN payment_ledger effect ON effect.related_ledger_entry_id=paid.ledger_entry_id WHERE paid.contract_id=? AND paid.direction='incoming' AND effect.entry_type='chargeback' ORDER BY effect.ledger_entry_id LIMIT 129)",[receipt.contract_id]],
    ["SELECT COALESCE(json_group_array(json(snapshot)),'[]') AS snapshot FROM (SELECT json_array(command_id,state,revision) snapshot FROM subscription_provider_commands WHERE contract_id=? ORDER BY command_id LIMIT 129)",[receipt.contract_id]],
    ["SELECT COALESCE(json_group_array(json(snapshot)),'[]') AS snapshot FROM (SELECT json_array(event_id,event_type,provider_state) snapshot FROM subscription_provider_events WHERE contract_id=? AND event_type IN ('provider_control','renewal_failed') ORDER BY event_id LIMIT 129)",[receipt.contract_id]]);
  const guards=[],snapshots=[];
  for(const [sql,params] of jobs){
    const row=await one(db,sql,params),snapshot=row?.snapshot;
    if(typeof snapshot!=='string')fail('review_policy_unavailable');
    let parsed;try{parsed=JSON.parse(snapshot);}catch{fail('review_policy_unavailable');}
    if(!Array.isArray(parsed)||parsed.length>128)fail('review_policy_unavailable');
    snapshots.push(parsed);guards.push({sql:`(${sql}) IS ?`,params:[...params,snapshot]});
  }
  if(snapshots[0][0]!==0||snapshots[1][0]!==0||snapshots[2][0]!==0||snapshots[3].some(row=>row[0]==='suspended'))
    fail('paid_access_suspended');
  return guards;
}

// Only a server-issued owner-review admission reaches this executor. Ordinary
// admin read authorization, actor objects and serialized copies are rejected by
// the private reader. No user-selected amount, period, plan or subject is used.
export async function resolveRetainedStarsPaymentReview(verifiedReview,options={}){
  const proof=readVerifiedOwnerSubscriptionReview(verifiedReview),identity=readTrustedContext(proof.context);
  const key='v143-review:'+await hash(JSON.stringify([identity.botId,identity.telegramId,proof.idempotencyKey]));
  const requestHash=await hash(JSON.stringify(['v143.owner-review.v1',identity.payloadHash]));
  const prior=await one(identity.db,'SELECT request_hash,actor_telegram_id,bot_id,operation FROM mini_app_command_receipts WHERE idempotency_key=? LIMIT 2',[key]);
  if(prior&&(prior.request_hash!==requestHash||prior.actor_telegram_id!==identity.telegramId||prior.bot_id!==identity.botId||
    prior.operation!=='admin.cabinet.open'))fail('review_idempotency_conflict');
  const receiptWrites=prior?[]:[identity.db.prepare(`INSERT INTO mini_app_command_receipts
    (idempotency_key,request_hash,bot_id,actor_telegram_id,operation,commit_status,response_json,committed_at,precondition_ok)
    VALUES(?,?,?,?,'admin.cabinet.open','committed',?,?,1)`).bind(key,requestHash,identity.botId,identity.telegramId,
      JSON.stringify({reviewAction:proof.action,ledgerEntryId:proof.ledgerEntryId,requestAdmitted:true}),identity.nowSeconds)];
  const source=await verifySource(identity,proof),env={...identity.env,DB:identity.db};
  if(proof.action==='apply')return applyRetainedPayment(verifiedReview,proof,identity,env,source,receiptWrites);
  if(proof.action==='refund')return refundRetainedPayment(verifiedReview,proof,identity,env,source,options,receiptWrites);
  fail('review_action_invalid');
}

async function applyRetainedPayment(token,proof,identity,env,{ledger,receipt,origin},receiptWrites){
  const db=identity.db,at=identity.nowSeconds;
  const previous=await one(db,"SELECT * FROM subscription_payment_review_settlements WHERE ledger_entry_id=? LIMIT 2",[ledger.ledger_entry_id]);
  if(previous){
    const grant=await one(db,"SELECT grant_id,status FROM subscription_access_grants WHERE payment_ledger_entry_id=? AND order_id=? LIMIT 2",
      [ledger.ledger_entry_id,previous.applied_order_id]);
    if(!grant)fail('review_settlement_incomplete');
    await atomic(db,compileVerifiedOwnerSubscriptionReviewAssertions(token),receiptWrites);
    return Object.freeze({status:'duplicate',decision:'apply',ledgerEntryId:ledger.ledger_entry_id,accessApplied:grant.status==='active'});
  }
  const compensation=await one(db,"SELECT ledger_entry_id FROM payment_ledger WHERE related_ledger_entry_id=? AND entry_type IN ('refund','chargeback') LIMIT 2",[ledger.ledger_entry_id]);
  if(compensation)fail('review_payment_compensated');
  const contract=receipt.contract_id&&await one(db,"SELECT * FROM subscription_billing_contracts WHERE contract_id=? LIMIT 2",[receipt.contract_id]);
  if(contract && contract.retired_at!==null)fail('review_contract_retired');
  if(contract && receipt.is_first_recurring===1 && contract.first_payment_ledger_entry_id && contract.first_payment_ledger_entry_id!==ledger.ledger_entry_id)
    fail('review_first_payment_conflict');
  const applyGuards=await captureApplyGuards(db,receipt);
  const childId=crypto.randomUUID(),operationId=crypto.randomUUID();
  const child={...origin,order_id:childId,invoice_payload:await buildStarsInvoicePayload({invoiceSecret:identity.env.STARS_INVOICE_SECRET,
    orderId:childId,telegramId:receipt.telegram_id,priceId:origin.price_id})};
  const chargeHash=await hash(ledger.telegram_payment_charge_id);
  const link={operation_id:operationId,contract_id:receipt.contract_id,origin_order_id:origin.order_id,applied_order_id:childId,
    ledger_entry_id:ledger.ledger_entry_id,provider_charge_id:ledger.telegram_payment_charge_id,telegram_id:receipt.telegram_id,
    plan_code:receipt.plan_code,external_invoice_payload:receipt.external_invoice_payload,external_payload_sha256:receipt.external_payload_sha256,
    provider_period_start:receipt.provider_period_start,provider_period_end:receipt.provider_period_end};
  const prepared=await prepareStarsImportedAccessStatements(env,{order:child,ledgerEntryId:ledger.ledger_entry_id,
    chargeId:ledger.telegram_payment_charge_id,link,contract,isFirstRecurring:receipt.is_first_recurring===1,
    at:receipt.contract_id?at:ledger.occurred_at});
  const evidenceHash=await hash(JSON.stringify(['v143.payment-review.apply.v1',ledger.ledger_entry_id,receipt.evidence_sha256,
    childId,operationId,identity.telegramId,proof.reasonCode,proof.idempotencyKey]));
  const writes=[...receiptWrites,db.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,currency,
    amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,expires_at,
    precheckout_approved_at,paid_at,applied_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'applied',?,?,?,?,?,?)`)
    .bind(childId,origin.telegram_id,origin.price_id,origin.price_version,origin.plan_code,origin.currency,origin.amount_stars,
      origin.access_seconds,origin.billing_mode,origin.terms_revision,child.invoice_payload,origin.created_at,origin.expires_at,
      ledger.occurred_at,ledger.occurred_at,at,at),
    db.prepare(`INSERT INTO subscription_payment_review_settlements
      (ledger_entry_id,applied_order_id,operation_id,resolution_key,actor_id,reason_code,evidence_sha256,settled_at)
      VALUES(?,?,?,?,?,?,?,?)`).bind(ledger.ledger_entry_id,childId,operationId,proof.idempotencyKey,
        identity.telegramId,proof.reasonCode,evidenceHash,at),
    db.prepare(`INSERT INTO subscription_payment_links(operation_id,operation_key,provider_charge_id,provider_charge_sha256,
      direction,link_kind,contract_id,origin_order_id,applied_order_id,telegram_id,plan_code,external_invoice_payload,
      external_payload_sha256,ledger_entry_id,provider_period_start,provider_period_end,evidence_sha256,occurred_at,recorded_at)
      VALUES(?,?,?,?,'incoming',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(operationId,`incoming:${chargeHash}`,
        ledger.telegram_payment_charge_id,chargeHash,receipt.contract_id?'recurring_charge':'late_prepaid_charge',receipt.contract_id,
        origin.order_id,childId,receipt.telegram_id,receipt.plan_code,receipt.external_invoice_payload,receipt.external_payload_sha256,
        ledger.ledger_entry_id,receipt.provider_period_start,receipt.provider_period_end,receipt.evidence_sha256,ledger.occurred_at,at)];
  if(contract && receipt.is_first_recurring===1 && !contract.first_payment_ledger_entry_id){
    writes.push(db.prepare(`INSERT INTO subscription_first_recurring_receipts(contract_id,operation_id,evidence_sha256,verified_at)
      VALUES(?,?,?,?)`).bind(contract.contract_id,operationId,receipt.evidence_sha256,at),
      db.prepare(`UPDATE subscription_billing_contracts SET first_payment_ledger_entry_id=?,revision=revision+1,updated_at=?
        WHERE contract_id=? AND revision=? AND first_payment_ledger_entry_id IS NULL`)
        .bind(ledger.ledger_entry_id,at,contract.contract_id,contract.revision));
  }
  writes.push(...prepared.statements);
  const finalGuard=`v143_review_effect_${childId}`;
  writes.push(db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
    VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM subscription_payment_links l JOIN subscription_access_grants g
      ON g.payment_ledger_entry_id=l.ledger_entry_id JOIN subscription_payment_review_settlements s ON s.ledger_entry_id=l.ledger_entry_id
      WHERE l.operation_id=? AND l.direction='incoming' AND l.applied_order_id=? AND g.order_id=l.applied_order_id
      AND s.applied_order_id=l.applied_order_id AND s.operation_id=l.operation_id AND g.grant_id=? AND g.status='active') THEN 1 ELSE 0 END)`)
    .bind(finalGuard,operationId,childId,prepared.grantId),db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key=?').bind(finalGuard));
  await atomic(db,[...compileVerifiedOwnerSubscriptionReviewAssertions(token).assertions,...applyGuards],writes);
  return Object.freeze({status:'applied',decision:'apply',ledgerEntryId:ledger.ledger_entry_id,accessApplied:true});
}

async function refundRetainedPayment(token,proof,identity,env,{ledger,receipt,origin},options,receiptWrites){
  const db=identity.db,at=identity.nowSeconds;
  if(!/^(?:true|1|on|enabled)$/i.test(String(identity.env.STARS_REFUNDS_ENABLED||'')))fail('stars_refunds_disabled');
  const effect=await one(db,"SELECT ledger_entry_id FROM payment_ledger WHERE related_ledger_entry_id=? AND entry_type='refund' LIMIT 2",[ledger.ledger_entry_id]);
  if(effect){await atomic(db,compileVerifiedOwnerSubscriptionReviewAssertions(token),receiptWrites);
    const renewalCancellation=await cancelConfirmedRefundFutureRenewal(token,options);
    return Object.freeze({status:'duplicate',decision:'refund',refunded:true,renewalCancellation});}
  if(await one(db,"SELECT ledger_entry_id FROM payment_ledger WHERE related_ledger_entry_id=? AND entry_type='chargeback' LIMIT 2",[ledger.ledger_entry_id]))
    fail('review_compensation_conflict');
  const refundGuards=[...compileVerifiedOwnerSubscriptionReviewAssertions(token).assertions,
    {sql:"NOT EXISTS(SELECT 1 FROM payment_ledger WHERE related_ledger_entry_id=? AND entry_type IN ('refund','chargeback'))",params:[ledger.ledger_entry_id]}];
  let request=await one(db,"SELECT * FROM payment_refunds WHERE telegram_payment_charge_id=? LIMIT 2",[ledger.telegram_payment_charge_id]);
  if(request && (request.original_ledger_entry_id!==ledger.ledger_entry_id||request.order_id!==origin.order_id||request.telegram_id!==receipt.telegram_id))fail('review_refund_binding_invalid');
  if(request && request.status!=='confirmed') {
    await atomic(db,compileVerifiedOwnerSubscriptionReviewAssertions(token),receiptWrites);
    return Object.freeze({status:'manual_review',decision:'refund',refunded:false,reason:'provider_refund_result_unresolved'});
  }
  if(request?.status==='confirmed') await atomic(db,refundGuards,receiptWrites);
  if(!request){
    const refundId=crypto.randomUUID(),chargeHash=await hash(ledger.telegram_payment_charge_id);
    await atomic(db,refundGuards,[...receiptWrites,
      db.prepare(`INSERT INTO payment_refunds(refund_id,idempotency_key,order_id,original_ledger_entry_id,telegram_id,
        telegram_payment_charge_id,currency,amount_stars,reason_code,requested_by_type,requested_by,status,requested_at,updated_at)
        VALUES(?,?,?,?,?,?,'XTR',?,?,'admin',?,'requested',?,?)`).bind(refundId,`refund-request:${chargeHash}`,
        origin.order_id,ledger.ledger_entry_id,receipt.telegram_id,ledger.telegram_payment_charge_id,ledger.amount_stars,
        proof.reasonCode,identity.telegramId,at,at),
      db.prepare(`INSERT INTO payment_events(event_id,event_key,order_id,telegram_id,event_type,outcome,reason_code,occurred_at,received_at)
        VALUES(?,?,?,?,'refund_requested','accepted',?,?,?)`).bind(crypto.randomUUID(),`review:${proof.idempotencyKey}:refund-request`,
          origin.order_id,receipt.telegram_id,proof.reasonCode,at,at)]);
    request=await one(db,"SELECT * FROM payment_refunds WHERE refund_id=? LIMIT 2",[refundId]);
    if(!request)fail('review_refund_request_not_persisted');
    // One provider attempt per durable request. A restart cannot infer whether
    // the network call happened, so requested/manual_review never auto-repeat.
    let confirmed=false,errorCode='provider_refund_not_confirmed';
    await atomic(db,refundGuards,[]);
    try{const api=options.telegramApi||callStarsTelegram;confirmed=await api(env,'refundStarPayment',{
      user_id:receipt.telegram_id,telegram_payment_charge_id:ledger.telegram_payment_charge_id},
      {timeoutMs:8000,...(options.fetchImpl?{fetchImpl:options.fetchImpl}:{})})===true;
    }catch(error){errorCode=String(error?.code||'provider_refund_result_unknown').replace(/[^a-z0-9_]/gi,'_').slice(0,64);}
    const recordedAt=clock();
    // Accounting after a conclusively true provider response must survive an
    // owner session ending during the call. The exact admitted request and
    // immutable original payment remain the only accounting source.
    const result=await db.prepare(`UPDATE payment_refunds SET status=?,confirmed_at=?,error_code=?,revision=revision+1,updated_at=?
      WHERE refund_id=? AND status='requested' AND original_ledger_entry_id=? AND telegram_payment_charge_id=?`)
      .bind(confirmed?'confirmed':'manual_review',confirmed?recordedAt:null,confirmed?'':errorCode,recordedAt,
        request.refund_id,ledger.ledger_entry_id,ledger.telegram_payment_charge_id).run();
    if(result?.success!==true||(result.meta?.changes??result.changes)!==1)fail('review_refund_ack_not_persisted');
    if(!confirmed)return Object.freeze({status:'manual_review',decision:'refund',refunded:false,reason:errorCode});
  }
  const result=await applyStarsCompensation(env,{telegramPaymentChargeId:ledger.telegram_payment_charge_id,
    compensationType:'refund',refundId:request.refund_id,reasonCode:proof.reasonCode,occurredAt:clock()});
  const renewalCancellation=await cancelConfirmedRefundFutureRenewal(token,options);
  return Object.freeze({status:result.status,decision:'refund',refunded:true,accessChanged:result.accessChanged,renewalCancellation});
}
