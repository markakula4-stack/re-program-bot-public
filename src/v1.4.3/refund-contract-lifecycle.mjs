import { readConfirmedStarsRefundEvidence } from '../v1.3.6/stars-access-runtime.mjs';
import {telegramCommandReason,telegramCommandDiagnosticStatement} from './telegram-command-error.mjs';
import { readVerifiedOwnerSubscriptionReview, authorizeOwnerSubscriptionPaymentReview,
  compileVerifiedOwnerSubscriptionReviewAssertions } from './subscription-action-authority.mjs';
import { readTrustedContext, refreshTrustedContext } from '../v1.4.1/trusted-context.mjs';
import { createRuntimeAuthorizer, readRuntimeAuthorization, requireRuntimeAuthorization } from '../v1.4.1/runtime-authorizer.mjs';
import { readLegacyCompatibilityEnv } from '../v1.4.1/telegram-legacy-compatibility.mjs';
import { createAuthorityResolver, readActorFacts, compileAuthorityAssertions } from '../v1.4.1/authority-resolver.mjs';
import { readStarsRecurringConfig } from './recurring-provider-config.mjs';
import { inspectLifecycleSchema, lifecycleSchemaAssertion } from './lifecycle-schema.mjs';
import { verifyStarsInvoicePayload } from '../v1.3.6/stars-core-foundation.mjs';
import { callStarsTelegram } from '../v1.3.6/stars-payment-runtime.mjs';
import { compileDecisionAssertions } from '../v1.4.1/entitlement-engine.mjs';
import { readResourceFacts } from '../v1.4.1/resource-resolver.mjs';
import {authorizeV143NativeCancellationContext,compileV143NativeCancellationAssertions} from './native-recovery-authority.mjs';
import {readV143NativeReadinessConfig} from './native-readiness-config.mjs';
import {readV143NativeOwnerRefundAdmission,refreshV143NativeOwnerRefundAdmission,
  compileV143NativeOwnerRefundAssertions} from './native-owner-refund-authority.mjs';

const MARKER='1.4.3-refund-contract-retirement';
const completions=new WeakMap();
const fail=code=>{throw Object.assign(new Error(code),{code,status:409});};
const clock=()=>Math.floor(Date.now()/1000);
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(value))))]
  .map(n=>n.toString(16).padStart(2,'0')).join('');
async function rows(db,sql,params=[],limit=128){
  const r=await db.prepare(sql).bind(...params).all();
  if(r?.success!==true||!Array.isArray(r.results)||r.results.length>limit)fail('refund_lifecycle_read_failed');
  return r.results;
}
const one=async(db,sql,params=[])=>{const r=await rows(db,sql,params,1);return r[0]||null;};
async function atomic(db,assertions,writes){
  const prefix='refund_lifecycle_'+crypto.randomUUID(),keys=assertions.map((_,i)=>prefix+'_'+i);
  const statements=[...assertions.map((p,i)=>db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
    VALUES(?,CASE WHEN (${p.sql}) THEN 1 ELSE 0 END)`).bind(keys[i],...p.params)),...writes,
    ...keys.map(key=>db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key=?').bind(key))];
  const result=await db.batch(statements);
  if(!Array.isArray(result)||result.length!==statements.length||result.some(r=>r?.success!==true))fail('refund_lifecycle_commit_unverified');
}
// A process restart loses the original refund admission. This separate, fixed
// completion admission reads only a durable, fully applied owner self-canary;
// it cannot admit another refund or select a different customer/charge.
export async function authorizeOwnerRefundCancellationCompletion(authorization){
  requireRuntimeAuthorization(authorization);
  const bundle=readRuntimeAuthorization(authorization),identity=readTrustedContext(bundle.context);
  const facts=readActorFacts(bundle.actor),resource=readResourceFacts(bundle.resource),payload=identity.requestPayload;
  const nativeCancellation=readV143NativeReadinessConfig()
    ?await authorizeV143NativeCancellationContext(authorization):null,
    nativeAssertions=nativeCancellation?compileV143NativeCancellationAssertions(nativeCancellation,authorization,'applied_owner_self_refund_cancel').assertions:[];
  if(identity.operation!=='admin.cabinet.open'||identity.actorKind!=='customer'||identity.channel!=='mini_app'||
    !identity.verifiedSessionId||identity.transportBinding?.kind!=='http'||identity.transportBinding.actor!==identity.telegramId||
    !identity.operationId||typeof identity.transportBinding.idempotencyKey!=='string'||
    (identity.env.REBUILD_V140_WRITES_ENABLED!=='true'&&!nativeCancellation)||!facts.canonicalOwner||resource.kind!=='admin_surface'||resource.ref!=='cabinet'||
    !payload||Object.keys(payload).length!==1||typeof payload.refundCompletionId!=='string'||
    !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(payload.refundCompletionId))fail('refund_completion_authority_required');
  const refund=await one(identity.db,`SELECT r.* FROM payment_refunds r
    JOIN payment_ledger paid ON paid.ledger_entry_id=r.original_ledger_entry_id
    JOIN payment_ledger effect ON effect.related_ledger_entry_id=paid.ledger_entry_id
    WHERE r.refund_id=? AND r.status='applied' AND r.requested_by_type='admin' AND r.requested_by=? AND r.telegram_id=?
      AND r.reason_code='admin_canary_validation' AND r.confirmed_at IS NOT NULL AND r.applied_at IS NOT NULL
      AND paid.entry_type='payment' AND paid.direction='credit' AND paid.telegram_id=r.telegram_id
      AND paid.order_id=r.order_id AND paid.currency=r.currency AND paid.amount_stars=r.amount_stars
      AND paid.telegram_payment_charge_id=r.telegram_payment_charge_id
      AND effect.entry_type='refund' AND effect.direction='debit' AND effect.telegram_id=r.telegram_id
      AND effect.order_id=r.order_id AND effect.currency=r.currency AND effect.amount_stars=r.amount_stars`,
    [payload.refundCompletionId,identity.telegramId,identity.telegramId]);
  if(!refund)fail('refund_completion_source_required');
  const token=Object.freeze({version:1,authority:'owner_confirmed_refund_completion'});
  completions.set(token,Object.freeze({context:bundle.context,refundId:refund.refund_id,
    ledgerId:refund.original_ledger_entry_id,subjectId:refund.telegram_id,actorId:identity.telegramId,
    nativeCompletion:nativeCancellation!==null,nativeAssertions}));
  return token;
}
async function authority(token){
  // A separate fixed producer authenticates the owner's signed canary refund.
  // This genuine private brand cannot be replaced with a copied actor/env.
  if(readV143NativeOwnerRefundAdmission(token)){
    const admission=await refreshV143NativeOwnerRefundAdmission(token);
    if(admission.body.action!=='refund'||admission.facts.refund?.status!=='applied')fail('confirmed_refund_binding_required');
    return {env:{...admission.env,DB:admission.db},db:admission.db,actorId:admission.actorId,
      refundId:admission.refundId,ledgerId:admission.ledgerId,subjectId:admission.subjectId,
      nativeCompletion:true,assertions:compileV143NativeOwnerRefundAssertions(token).assertions};
  }
  if(completions.has(token)){
    const prior=completions.get(token),context=await refreshTrustedContext(prior.context);
    const auth=await createRuntimeAuthorizer().authorize(context,{kind:'admin_surface',key:'cabinet'});
    const fresh=await authorizeOwnerRefundCancellationCompletion(auth),current=completions.get(fresh);
    if(['refundId','ledgerId','subjectId','actorId'].some(key=>current[key]!==prior[key]))fail('refund_completion_source_changed');
    const bundle=readRuntimeAuthorization(auth),identity=readTrustedContext(context);
    return {env:{...identity.env,DB:identity.db},db:identity.db,...current,
      assertions:[...compileDecisionAssertions(bundle.decision).assertions,...current.nativeAssertions,{sql:`EXISTS(SELECT 1 FROM payment_refunds
        WHERE refund_id=? AND original_ledger_entry_id=? AND telegram_id=? AND requested_by_type='admin'
        AND requested_by=? AND reason_code='admin_canary_validation' AND status='applied'
        AND confirmed_at IS NOT NULL AND applied_at IS NOT NULL)`,
        params:[current.refundId,current.ledgerId,current.subjectId,current.actorId]}]};
  }
  const evidence=readConfirmedStarsRefundEvidence(token);
  if(evidence){
    if(!evidence.env?.DB||!evidence.actorId)fail('refund_lifecycle_authority_required');
    let env=evidence.env,assertions=[];
    if(evidence.context){
      const compatibility=readLegacyCompatibilityEnv(evidence.env);
      const context=await refreshTrustedContext(compatibility.context),identity=readTrustedContext(context);
      if(compatibility.family!=='admin.stars.refund'||compatibility.originalBinding!==evidence.originalBinding||
        compatibility.accountingOnly||identity.operation!=='admin.stars.refund'||
        identity.telegramId!==evidence.actorId||evidence.telegramId!==evidence.actorId||
        compatibility.resourceRef?.kind!=='payment'||compatibility.resourceRef.key!==evidence.orderId||
        identity.requestPayload?.action!=='refund'||identity.requestPayload.orderId!==evidence.orderId||
        identity.requestPayload.reasonCode!=='admin_canary_validation')fail('refund_lifecycle_authority_required');
      // The admitted refund is complete, so its original refundable-resource
      // predicate must now be false. This private completion is not another
      // refund admission: retain that exact request and compile the current
      // owner's authentic context/actor facts before each fixed cancel effect.
      const actor=await createAuthorityResolver().resolveActor(context),facts=readActorFacts(actor);
      if(!facts.canonicalOwner||!facts.policyReady||!facts.financialSourceAvailable||facts.protectedAuthorityFallback||facts.degradedTables.length||
        !facts.account.exists||!facts.account.acceptedTerms||facts.account.isBlocked||facts.account.pendingDeletion)
        fail('refund_lifecycle_authority_required');
      assertions=[...compileAuthorityAssertions(actor).assertions,{sql:`EXISTS(SELECT 1 FROM payment_refunds WHERE refund_id=? AND original_ledger_entry_id=?
        AND order_id=? AND telegram_id=? AND requested_by_type='admin' AND requested_by=? AND reason_code='admin_canary_validation'
        AND status='applied')`,params:[evidence.refundId,evidence.originalLedgerEntryId,evidence.orderId,evidence.telegramId,evidence.actorId]}];
      env={...identity.env,DB:identity.db};
    }else if(env.V141_AUTHORIZATION_ENABLED==='true')fail('refund_lifecycle_authority_required');
    return {env,db:env.DB,actorId:evidence.actorId,refundId:evidence.refundId,
      ledgerId:evidence.originalLedgerEntryId,subjectId:evidence.telegramId,assertions};
  }
  // A copied owner/actor object is not an admission. Re-authorize the original
  // fixed refund intent after accounting; session expiry stops provider effects.
  const prior=readVerifiedOwnerSubscriptionReview(token);
  if(prior.action!=='refund')fail('refund_lifecycle_authority_required');
  const context=await refreshTrustedContext(prior.context);
  const auth=await createRuntimeAuthorizer().authorize(context,{kind:'admin_surface',key:'cabinet'});
  const current=await authorizeOwnerSubscriptionPaymentReview(auth),proof=readVerifiedOwnerSubscriptionReview(current);
  const identity=readTrustedContext(proof.context);
  return {env:{...identity.env,DB:identity.db},db:identity.db,actorId:identity.telegramId,ledgerId:proof.ledgerEntryId,
    subjectId:proof.receipt.telegram_id,assertions:compileVerifiedOwnerSubscriptionReviewAssertions(current).assertions};
}

// Fixed financial predicate shared by fresh invoice admission and 0071's
// retirement guard. A future period is excluded only by an exact full refund;
// inactive/suspended grants alone do not mean that money was returned.
export const REFUND_RETIREMENT_FINANCIAL_SQL=`
 NOT EXISTS(SELECT 1 FROM subscription_provider_commands pending WHERE pending.contract_id=c.contract_id
   AND pending.state IN ('admitted','attempted','unknown'))
 AND NOT EXISTS(SELECT 1 FROM subscription_payment_links l JOIN subscription_orders o ON o.order_id=l.applied_order_id
   JOIN payment_ledger paid ON paid.ledger_entry_id=l.ledger_entry_id
   WHERE l.contract_id=c.contract_id AND l.direction='incoming'
   AND (l.provider_period_end>? OR o.order_state='paid')
   AND NOT EXISTS(SELECT 1 FROM payment_ledger refund WHERE refund.related_ledger_entry_id=paid.ledger_entry_id
     AND refund.entry_type='refund' AND refund.direction='debit' AND refund.telegram_id=paid.telegram_id
     AND refund.currency=paid.currency AND refund.amount_stars=paid.amount_stars))
 AND NOT EXISTS(SELECT 1 FROM subscription_access_grants g JOIN subscription_payment_links l
   ON l.ledger_entry_id=g.payment_ledger_entry_id WHERE l.contract_id=c.contract_id AND g.status='active' AND g.ends_at>?)
 AND NOT EXISTS(SELECT 1 FROM subscription_payment_review_receipts r JOIN payment_ledger paid ON paid.ledger_entry_id=r.ledger_entry_id
   WHERE r.contract_id=c.contract_id AND NOT EXISTS(SELECT 1 FROM subscription_payment_review_settlements settled
     WHERE settled.ledger_entry_id=paid.ledger_entry_id)
   AND NOT EXISTS(SELECT 1 FROM payment_ledger refund WHERE refund.related_ledger_entry_id=paid.ledger_entry_id
     AND refund.entry_type='refund' AND refund.direction='debit' AND refund.telegram_id=paid.telegram_id
     AND refund.currency=paid.currency AND refund.amount_stars=paid.amount_stars))`;

export const REFUND_RETIREMENT_ACK_SQL=`EXISTS(SELECT 1 FROM subscription_provider_commands cmd
 JOIN subscription_provider_events ack ON ack.event_id=cmd.acknowledgement_event_id
 JOIN subscription_refund_cancellations linked ON linked.command_id=cmd.command_id
 WHERE cmd.contract_id=c.contract_id AND cmd.telegram_id=c.telegram_id AND cmd.action='cancel_renewal'
 AND cmd.desired_auto_renew=0 AND cmd.state='confirmed' AND cmd.attempted_count=1
 AND cmd.first_payment_ledger_entry_id=c.first_payment_ledger_entry_id AND cmd.expected_contract_revision=c.revision
 AND ack.command_id=cmd.command_id AND ack.contract_id=c.contract_id AND ack.telegram_id=c.telegram_id
 AND ack.event_type='command_confirmed' AND ack.source='provider_response' AND ack.provider_state IS NULL
 AND linked.contract_id=c.contract_id AND linked.telegram_id=c.telegram_id
 AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands other WHERE other.contract_id=c.contract_id
   AND other.state='confirmed' AND other.command_id!=cmd.command_id AND other.attempted_at>=cmd.attempted_at)
 AND NOT EXISTS(SELECT 1 FROM subscription_provider_events later WHERE later.contract_id=c.contract_id
   AND ((later.source='telegram_update' AND later.received_at>=cmd.attempted_at
       AND NOT (later.event_id IS c.last_provider_event_id AND later.received_at<=cmd.attempted_at))
     OR later.event_type='review_observed')))`;

async function source(scope){
  const {db}=scope;
  const schema=await inspectLifecycleSchema(db,{required:true});
  if(schema.marker!==MARKER)fail('refund_lifecycle_not_ready');
  const refund=await one(db,`SELECT r.*,effect.ledger_entry_id refund_ledger_entry_id FROM payment_refunds r
    JOIN payment_ledger paid ON paid.ledger_entry_id=r.original_ledger_entry_id
    JOIN payment_ledger effect ON effect.related_ledger_entry_id=paid.ledger_entry_id
    WHERE r.original_ledger_entry_id=? AND r.telegram_id=? AND r.status='applied'
      AND effect.entry_type='refund' AND effect.direction='debit' AND effect.telegram_id=r.telegram_id
      AND effect.currency=r.currency AND effect.amount_stars=r.amount_stars
      AND paid.entry_type='payment' AND paid.direction='credit' AND paid.telegram_id=r.telegram_id
      AND paid.currency=r.currency AND paid.amount_stars=r.amount_stars
      AND paid.telegram_payment_charge_id=r.telegram_payment_charge_id`,[scope.ledgerId,scope.subjectId]);
  if(!refund||scope.refundId&&scope.refundId!==refund.refund_id||refund.requested_by_type!=='admin')fail('confirmed_refund_binding_required');
  const links=await rows(db,`SELECT contract_id FROM subscription_payment_links WHERE ledger_entry_id=? AND direction='incoming'
    UNION SELECT contract_id FROM subscription_payment_review_receipts WHERE ledger_entry_id=?`,[scope.ledgerId,scope.ledgerId],2);
  const ids=[...new Set(links.map(r=>r.contract_id).filter(Boolean))];
  if(!ids.length)return {refund,schema,contract:null};
  if(ids.length!==1)fail('refund_contract_ambiguous');
  const contract=await one(db,'SELECT * FROM subscription_billing_contracts WHERE contract_id=? AND telegram_id=?',[ids[0],scope.subjectId]);
  if(!contract?.first_payment_ledger_entry_id)return {refund,schema,contract:null};
  const first=await one(db,`SELECT paid.*,l.external_invoice_payload,l.external_payload_sha256,l.origin_order_id,
    l.contract_id,l.evidence_sha256,receipt.evidence_sha256 receipt_sha256
    FROM subscription_first_recurring_receipts receipt JOIN subscription_payment_links l ON l.operation_id=receipt.operation_id
    JOIN payment_ledger paid ON paid.ledger_entry_id=l.ledger_entry_id
    WHERE receipt.contract_id=? AND l.contract_id=? AND l.direction='incoming' AND l.link_kind='recurring_charge'
    AND paid.ledger_entry_id=? AND paid.telegram_id=? AND paid.entry_type='payment' AND paid.direction='credit'
    AND paid.currency=? AND paid.amount_stars=? AND paid.telegram_payment_charge_id=l.provider_charge_id`,
    [contract.contract_id,contract.contract_id,contract.first_payment_ledger_entry_id,scope.subjectId,contract.currency,contract.amount_stars]);
  if(!first||first.origin_order_id!==contract.origin_order_id||first.external_invoice_payload!==contract.external_invoice_payload||
    first.external_payload_sha256!==contract.external_payload_sha256||first.evidence_sha256!==first.receipt_sha256)
    fail('refund_first_charge_unverified');
  const parsed=await verifyStarsInvoicePayload({invoiceSecret:scope.env.STARS_INVOICE_SECRET,payload:contract.external_invoice_payload,
    telegramId:scope.subjectId,priceId:contract.price_id});
  if(parsed.orderId!==contract.origin_order_id)fail('refund_first_charge_unverified');
  const assertions=[...scope.assertions,lifecycleSchemaAssertion(schema),
    {sql:`EXISTS(SELECT 1 FROM payment_refunds r JOIN payment_ledger effect ON effect.related_ledger_entry_id=r.original_ledger_entry_id
      WHERE r.refund_id=? AND r.original_ledger_entry_id=? AND r.telegram_id=? AND r.status='applied'
      AND effect.ledger_entry_id=? AND effect.entry_type='refund' AND effect.direction='debit'
      AND effect.telegram_id=r.telegram_id AND effect.currency=r.currency AND effect.amount_stars=r.amount_stars)`,
      params:[refund.refund_id,scope.ledgerId,scope.subjectId,refund.refund_ledger_entry_id]},
    {sql:'EXISTS(SELECT 1 FROM subscription_billing_contracts WHERE contract_id=? AND telegram_id=? AND revision=? AND first_payment_ledger_entry_id=? AND retired_at IS NULL)',
      params:[contract.contract_id,scope.subjectId,contract.revision,first.ledger_entry_id]}];
  return {refund,schema,contract,first,assertions};
}
const dto=row=>Object.freeze({status:row?.state||'manual_review',confirmed:row?.state==='confirmed',
  reviewRequired:!row||['admitted','attempted','unknown','rejected'].includes(row.state)});

// Only private existing refund admissions reach this function. One durable
// command is linked to its exact confirmed refund; a lost response is never
// converted into cancellation or automatically sent again after restart.
export async function cancelConfirmedRefundFutureRenewal(refundAuthority,options={}){
  try{
    let scope=await authority(refundAuthority);
    if(!readStarsRecurringConfig(scope.env).ready&&!scope.nativeCompletion)return Object.freeze({status:'disabled',confirmed:false,reviewRequired:true});
    let actual=await source(scope);
    if(!actual.contract)return Object.freeze({status:'not_applicable',confirmed:false,reviewRequired:false});
    const {db}=scope,{refund,contract,first}=actual,key='refund-cancel:'+refund.refund_id;
    let command=await one(db,`SELECT cmd.* FROM subscription_refund_cancellations linked
      JOIN subscription_provider_commands cmd ON cmd.command_id=linked.command_id WHERE linked.refund_id=?`,[refund.refund_id]);
    if(command&&command.state!=='admitted')return dto(command);
    if(!command){
      if(contract.retired_at!==null)return Object.freeze({status:'retired',confirmed:true,reviewRequired:false});
      // An already verified refund cancellation remains sufficient for another
      // compensated period on this same immutable contract/first-charge epoch.
      if(await one(db,`SELECT c.contract_id FROM subscription_billing_contracts c WHERE c.contract_id=? AND ${REFUND_RETIREMENT_ACK_SQL}`,[contract.contract_id]))
        return Object.freeze({status:'confirmed',confirmed:true,reviewRequired:false});
      if(await one(db,"SELECT command_id FROM subscription_provider_commands WHERE contract_id=? AND state IN ('admitted','attempted','unknown')",[contract.contract_id]))
        return Object.freeze({status:'manual_review',confirmed:false,reviewRequired:true});
      if((await rows(db,"SELECT command_id FROM subscription_provider_commands WHERE contract_id=? AND state='confirmed' AND attempted_at>=?",[contract.contract_id,clock()])).length)
        return Object.freeze({status:'cooldown',confirmed:false,reviewRequired:true});
      const at=clock(),commandId=crypto.randomUUID(),requestHash=await hash(JSON.stringify(['confirmed-refund-cancel.v1',
        refund.refund_id,refund.refund_ledger_entry_id,contract.contract_id,first.ledger_entry_id,scope.actorId]));
      await atomic(db,[...actual.assertions,{sql:"NOT EXISTS(SELECT 1 FROM subscription_provider_commands WHERE contract_id=? AND state IN ('admitted','attempted','unknown'))",params:[contract.contract_id]}],
        [db.prepare(`INSERT INTO subscription_provider_commands(command_id,idempotency_key,contract_id,telegram_id,action,
          desired_auto_renew,expected_contract_revision,first_payment_ledger_entry_id,request_sha256,created_at,updated_at)
          VALUES(?,?,?,?,'cancel_renewal',0,?,?,?,?,?)`).bind(commandId,key,contract.contract_id,scope.subjectId,
            contract.revision,first.ledger_entry_id,requestHash,at,at),
        db.prepare(`INSERT INTO subscription_refund_cancellations(refund_id,refund_ledger_entry_id,contract_id,telegram_id,
          command_id,actor_id,recorded_at) VALUES(?,?,?,?,?,?,?)`).bind(refund.refund_id,refund.refund_ledger_entry_id,
            contract.contract_id,scope.subjectId,commandId,scope.actorId,at)]);
      command=await one(db,'SELECT * FROM subscription_provider_commands WHERE command_id=?',[commandId]);
    }
    // New admission is read again before marking the single network attempt.
    scope=await authority(refundAuthority);actual=await source(scope);
    if(actual.contract.revision!==command.expected_contract_revision)fail('refund_cancel_source_changed');
    const at=clock();
    await atomic(db,[...actual.assertions,{sql:"EXISTS(SELECT 1 FROM subscription_provider_commands WHERE command_id=? AND state='admitted' AND attempted_count=0)",params:[command.command_id]}],
      [db.prepare(`UPDATE subscription_provider_commands SET state='attempted',attempted_count=1,attempted_at=?,
        revision=revision+1,updated_at=MAX(updated_at,?) WHERE command_id=? AND state='admitted' AND attempted_count=0`)
        .bind(at,at,command.command_id)]);
    let state='unknown',errorCode='refund_cancel_outcome_unknown',diagnosticError=null;
    try{
      scope=await authority(refundAuthority);actual=await source(scope);
      await atomic(db,actual.assertions,[]);
      const api=options.telegramApi||((env,method,payload)=>callStarsTelegram(env,method,payload,
        {timeoutMs:8000,...(options.fetchImpl?{fetchImpl:options.fetchImpl}:{})}));
      const result=await api(scope.env,'editUserStarSubscription',{user_id:scope.subjectId,
        telegram_payment_charge_id:actual.first.telegram_payment_charge_id,is_canceled:true});
      state=result===true?'confirmed':'rejected';errorCode=result===true?'':'refund_cancel_not_confirmed';
    }catch(error){state=error?.ambiguous===false?'rejected':'unknown';errorCode=telegramCommandReason(error);diagnosticError=error;}
    const recordedAt=clock(),eventId=crypto.randomUUID();
    const diagnostic=telegramCommandDiagnosticStatement(db,command,diagnosticError,scope.actorId);
    await atomic(db,[{sql:"EXISTS(SELECT 1 FROM subscription_provider_commands WHERE command_id=? AND state='attempted' AND attempted_count=1)",params:[command.command_id]}],
      [db.prepare(`INSERT INTO subscription_provider_events(event_id,event_key,contract_id,command_id,telegram_id,event_type,
        source,actor_type,reason_code,evidence_sha256,received_at) VALUES(?,?,?,?,?,?,?,'system',?,?,?)`)
        .bind(eventId,key+':'+state,command.contract_id,command.command_id,scope.subjectId,
          state==='confirmed'?'command_confirmed':state==='rejected'?'command_rejected':'command_unknown',
          state==='unknown'?'system':'provider_response',errorCode||'telegram_command_acknowledged',
          await hash(JSON.stringify([command.command_id,command.action,state,errorCode])),recordedAt),
      db.prepare(`UPDATE subscription_provider_commands SET state=?,acknowledgement_event_id=?,error_code=?,revision=revision+1,
        updated_at=MAX(updated_at,?) WHERE command_id=? AND state='attempted' AND attempted_count=1`)
        .bind(state,state==='confirmed'?eventId:null,errorCode,recordedAt,command.command_id),...(diagnostic?[diagnostic]:[])]);
    return dto(await one(db,'SELECT * FROM subscription_provider_commands WHERE command_id=?',[command.command_id]));
  }catch{return Object.freeze({status:'manual_review',confirmed:false,reviewRequired:true});}
}

// This effect is available only to an actual fresh invoice authorization. It
// neither cancels a provider nor clears paid time. The separate provider ack
// and every exact remaining financial period must permit historical retirement.
export async function retireRefundedContractsForInvoice(authorization){
  requireRuntimeAuthorization(authorization);
  const bundle=readRuntimeAuthorization(authorization),identity=readTrustedContext(bundle.context),db=identity.db;
  const payload=identity.requestPayload,config=readStarsRecurringConfig(identity.env);
  const quote=readResourceFacts(bundle.resource).canonical?.serverPrice;
  if(identity.operation!=='billing.purchase_monthly'||identity.actorKind!=='customer'||identity.channel!=='mini_app'||
    !identity.verifiedSessionId||identity.transportBinding?.kind!=='http'||identity.transportBinding.actor!==identity.telegramId||
    !config.ready||!payload||Object.keys(payload).length!==6||payload.action!=='accept'||payload.billingMode!=='recurring'||
    payload.recurringConsent!==true||payload.termsRevision!==config.termsRevision||payload.priceVersion!==config.priceVersion||
    !['professional','dragon'].includes(payload.requestedPlanCode)||quote?.billingMode!=='recurring'||
    quote?.planCode!==payload.requestedPlanCode||quote?.termsRevision!==config.termsRevision||quote?.priceVersion!==config.priceVersion)
    fail('refund_retirement_authority_required');
  const schema=await inspectLifecycleSchema(db,{required:true});
  if(schema.marker!==MARKER)return false;
  const at=clock();
  const candidates=await rows(db,`SELECT c.* FROM subscription_billing_contracts c WHERE c.telegram_id=? AND c.retired_at IS NULL
    AND ${REFUND_RETIREMENT_ACK_SQL} AND ${REFUND_RETIREMENT_FINANCIAL_SQL}`,[identity.telegramId,at,at]);
  if(!candidates.length)return false;
  const writes=[],assertions=[...compileDecisionAssertions(bundle.decision).assertions,lifecycleSchemaAssertion(schema)];
  for(const c of candidates){
    assertions.push({sql:`EXISTS(SELECT 1 FROM subscription_billing_contracts c WHERE c.contract_id=? AND c.telegram_id=?
      AND c.revision=? AND c.retired_at IS NULL AND ${REFUND_RETIREMENT_ACK_SQL} AND ${REFUND_RETIREMENT_FINANCIAL_SQL})`,
      params:[c.contract_id,identity.telegramId,c.revision,at,at]});
    const eventId=crypto.randomUUID();
    writes.push(db.prepare(`INSERT INTO subscription_provider_events(event_id,event_key,contract_id,telegram_id,event_type,
      source,actor_type,reason_code,evidence_sha256,received_at) VALUES(?,?,?,?,'contract_retired','system','system',
      'confirmed_refund_contract_retired',?,?)`).bind(eventId,'refund-retirement:'+c.contract_id,c.contract_id,identity.telegramId,
        await hash(JSON.stringify(['refund-retirement.v1',c.contract_id,c.revision,at])),at),
      db.prepare(`UPDATE subscription_billing_contracts SET retired_at=?,retirement_event_id=?,revision=revision+1,
        updated_at=MAX(updated_at,?) WHERE contract_id=? AND telegram_id=? AND revision=? AND retired_at IS NULL`)
        .bind(at,eventId,at,c.contract_id,identity.telegramId,c.revision));
  }
  await atomic(db,assertions,writes);return true;
}
