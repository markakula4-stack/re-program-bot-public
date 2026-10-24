import {callStarsTelegram} from '../v1.3.6/stars-payment-runtime.mjs';
import {applyStarsCompensation} from '../v1.3.6/stars-access-runtime.mjs';
import {cancelConfirmedRefundFutureRenewal} from './refund-contract-lifecycle.mjs';
import {NATIVE_OWNER_REFUND_PATH,V143_NATIVE_OWNER_REFUND_FRAME as FRAME,
  authorizeV143NativeOwnerRefund,readV143NativeOwnerRefundAdmission,
  refreshV143NativeOwnerRefundAdmission,compileV143NativeOwnerRefundAssertions,
  signV143NativeOwnerRefundResponse} from './native-owner-refund-authority.mjs';
export {NATIVE_OWNER_REFUND_PATH};
const fail=code=>{throw Object.assign(new Error('native_owner_refund_'+code),{code:'native_owner_refund_'+code});};
const confirmedOutcomes=new WeakSet();
const changes=result=>Number(result?.meta?.changes??result?.changes??0);
async function guardedBatch(db,assertions,writes,{requiredChanges=[]}={}){
  const prefix='native_owner_refund_'+crypto.randomUUID(),keys=assertions.map((_,i)=>prefix+'_'+i),
    statements=[...assertions.map((proof,i)=>db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
      VALUES(?,CASE WHEN (${proof.sql}) THEN 1 ELSE 0 END)`).bind(keys[i],...proof.params)),...writes,
      ...keys.map(key=>db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key=?').bind(key))];
  const result=await db.batch(statements);
  if(!Array.isArray(result)||result.length!==statements.length||result.some(item=>item?.success!==true))fail('commit_unverified');
  const effects=result.slice(assertions.length,assertions.length+writes.length);
  if(requiredChanges.some(([index,count])=>changes(effects[index])!==count))fail('commit_unverified');
  return effects;
}
const facts=token=>{const admission=readV143NativeOwnerRefundAdmission(token);if(!admission)fail('authority_required');return admission;};
const assertions=token=>compileV143NativeOwnerRefundAssertions(token).assertions;
function outcomeAssertions(source,refundId){
  const paid=source.payment;
  // These immutable identities record the result of an already admitted
  // network attempt. A later role/clock change cannot erase a strict true ack.
  // They grant neither another provider attempt nor access/accounting effects.
  return [
    {sql:`EXISTS(SELECT 1 FROM payment_ledger WHERE ledger_entry_id=? AND order_id=? AND telegram_id=?
      AND entry_type='payment' AND direction='credit' AND currency='XTR' AND amount_stars=249
      AND telegram_payment_charge_id=? AND related_ledger_entry_id IS NULL)`,
      params:[paid.ledger_entry_id,paid.order_id,FRAME.ownerId,paid.telegram_payment_charge_id]},
    {sql:`EXISTS(SELECT 1 FROM payment_refunds WHERE refund_id=? AND idempotency_key=? AND original_ledger_entry_id=?
      AND order_id=? AND telegram_id=? AND telegram_payment_charge_id=? AND currency='XTR' AND amount_stars=249
      AND reason_code='admin_canary_validation' AND requested_by_type='admin' AND requested_by=?
      AND status='requested' AND revision=1)`,
      params:[refundId,'native-owner-refund:'+FRAME.receiptId,paid.ledger_entry_id,paid.order_id,FRAME.ownerId,
        paid.telegram_payment_charge_id,FRAME.ownerId]}
  ];
}
function publicStatus(token,{cancellation=null}={}){
  const {facts:source}=facts(token),refund=source.refund,applied=refund?.status==='applied',
    confirmed=applied||refund?.status==='confirmed',unknown=refund&&['requested','manual_review'].includes(refund.status),
    linked=source.cancellations[0],command=linked&&source.commands.find(row=>row.command_id===linked.command_id),
    cancellationConfirmed=cancellation?.confirmed===true||command?.state==='confirmed';
  return Object.freeze({ok:true,receiptId:FRAME.receiptId,amountStars:FRAME.amountStars,
    status:applied?'applied':confirmed?'confirmed':unknown?'unknown':refund?.status==='failed'?'failed':'ready',
    refunded:confirmed,accountingApplied:applied,cancellationConfirmed,
    reviewRequired:unknown||refund?.status==='failed'||confirmed&&(!applied||!cancellationConfirmed),
    acceptanceSha256:FRAME.acceptanceSha256,schemaSha256:FRAME.schemaSha256,
    ledgerSha256:FRAME.ledgerSha256,selectedSha256:source.selectedSha256});
}
async function response(token,value,status=200){
  const body=JSON.stringify(value),signature=await signV143NativeOwnerRefundResponse(token,body);
  return new Response(body,{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff','X-Native-Owner-Refund-Signature':signature}});
}
// Every accounting batch/run receives fresh genuine admission predicates. The
// unchanged compensation routine receives only this exact verified charge and
// the first-primary binding; its transaction also checks the selected snapshot.
function accountingEnv(token){
  const prior=facts(token),db=prior.db;
  const commit=async statements=>{
    const fresh=await refreshV143NativeOwnerRefundAdmission(token);
    if(fresh.body.action!=='refund'||!['confirmed','applied'].includes(fresh.facts.refund?.status))fail('confirmed_refund_required');
    return guardedBatch(db,assertions(token),statements);
  };
  const wrap=statement=>({
    bind(...values){return wrap(statement.bind(...values));},
    first(...values){return statement.first(...values);},all(...values){return statement.all(...values);},
    async run(){return (await commit([statement]))[0];},
    __statement:statement
  });
  const binding=Object.freeze({prepare(sql){return wrap(db.prepare(sql));},
    batch(statements){return commit(statements.map(statement=>statement.__statement??statement));}});
  return {...prior.env,DB:binding};
}
async function perform(token,{clock,telegramApi,compensate}){
  let current=await refreshV143NativeOwnerRefundAdmission(token);
  if(current.body.action!=='refund')fail('refund_intent_required');
  let refund=current.facts.refund;
  // A requested row is the durable reservation of the sole provider attempt.
  // A duplicate/restart cannot determine whether that request reached Telegram.
  if(refund&&['requested','manual_review','failed'].includes(refund.status))return publicStatus(token);
  if(!refund){
    const payment=current.facts.payment,at=clock(),refundId=crypto.randomUUID();
    await guardedBatch(current.db,assertions(token),[
      current.db.prepare(`INSERT INTO payment_refunds(refund_id,idempotency_key,order_id,original_ledger_entry_id,
        telegram_id,telegram_payment_charge_id,currency,amount_stars,reason_code,requested_by_type,requested_by,
        status,requested_at,updated_at) VALUES(?,?,?,?,?,?,'XTR',249,'admin_canary_validation','admin',?,'requested',?,?)`)
        .bind(refundId,'native-owner-refund:'+FRAME.receiptId,payment.order_id,payment.ledger_entry_id,
          FRAME.ownerId,payment.telegram_payment_charge_id,FRAME.ownerId,at,at)
    ],{requiredChanges:[[0,1]]});
    // No provider invocation can precede a committed selected journal row.
    current=await refreshV143NativeOwnerRefundAdmission(token);refund=current.facts.refund;
    if(refund?.refund_id!==refundId||refund.status!=='requested'||refund.revision!==1)fail('attempt_unverified');
    await guardedBatch(current.db,assertions(token),[]);
    let outcome='manual_review',errorCode='native_owner_refund_outcome_unknown';
    try{
      const result=await telegramApi({...current.env,DB:current.db},'refundStarPayment',{
        user_id:FRAME.ownerId,telegram_payment_charge_id:current.facts.payment.telegram_payment_charge_id});
      if(result===true){outcome='confirmed';errorCode='';}
      else if(result===false){outcome='failed';errorCode='native_owner_refund_not_confirmed';}
      // A truthy object/string is not Telegram's strict boolean acknowledgement.
    }catch(error){
      if(error?.ambiguous===false){outcome='failed';errorCode='native_owner_refund_not_confirmed';}
    }
    // Journal the real provider outcome before the accounting facade runs.
    // A failure to record a true acknowledgement leaves an unknown request.
    const atConfirmed=clock();
    await guardedBatch(current.db,outcomeAssertions(current.facts,refundId),[
      current.db.prepare(`UPDATE payment_refunds SET status=?,confirmed_at=CASE WHEN ?='confirmed' THEN ? ELSE confirmed_at END,
        error_code=?,revision=revision+1,updated_at=MAX(updated_at,?)
        WHERE refund_id=? AND status='requested' AND revision=1`)
        .bind(outcome,outcome,atConfirmed,errorCode,atConfirmed,refundId)
    ],{requiredChanges:[[0,1]]});
    if(outcome==='confirmed')confirmedOutcomes.add(token);
    current=await refreshV143NativeOwnerRefundAdmission(token);refund=current.facts.refund;
    if(outcome!=='confirmed')return publicStatus(token);
  }
  // A durable strict true acknowledgement can resume accounting after restart;
  // it never sends refundStarPayment again.
  if(refund.status==='confirmed'){
    await compensate(accountingEnv(token),{telegramPaymentChargeId:current.facts.payment.telegram_payment_charge_id,
      compensationType:'refund',occurredAt:refund.confirmed_at,refundId:refund.refund_id,reasonCode:'admin_canary_validation'});
    current=await refreshV143NativeOwnerRefundAdmission(token);
    if(current.facts.refund?.status!=='applied')fail('accounting_unverified');
  }
  const cancellation=await cancelConfirmedRefundFutureRenewal(token,{telegramApi});
  await refreshV143NativeOwnerRefundAdmission(token);
  return publicStatus(token,{cancellation});
}
export function createNativeOwnerRefundControl({clock=()=>Math.floor(Date.now()/1000),
  telegramApi=(env,method,payload)=>callStarsTelegram(env,method,payload,{timeoutMs:8000}),
  compensate=applyStarsCompensation}={}){
  return async(request,env)=>{
    if(new URL(request.url).pathname!==NATIVE_OWNER_REFUND_PATH)return null;
    let token;
    try{token=await authorizeV143NativeOwnerRefund(request,env,{clock});}
    catch{return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});}
    if(facts(token).body.action==='status')return response(token,publicStatus(token));
    try{return response(token,await perform(token,{clock,telegramApi,compensate}));}
    catch{
      // Read-only observation may recover a completed accounting transaction.
      // It never retries either provider method after an uncertain outcome.
      try{await refreshV143NativeOwnerRefundAdmission(token);return response(token,{...publicStatus(token),
        ok:false,reviewRequired:true,code:'native_owner_refund_outcome_unverified'},409);}
      catch{
        const observed=publicStatus(token),confirmed=confirmedOutcomes.has(token)||observed.refunded;
        return response(token,{...observed,ok:false,status:observed.accountingApplied?'applied':confirmed?'confirmed':'unknown',
          refunded:confirmed,reviewRequired:true,code:'native_owner_refund_outcome_unverified'},409);
      }
    }
  };
}
