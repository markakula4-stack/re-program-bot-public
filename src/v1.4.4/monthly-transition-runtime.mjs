import { readTrustedContext, deriveTrustedOperationContext, refreshTrustedContext, compileContextAssertions } from '../v1.4.1/trusted-context.mjs';
import { createAuthorityResolver, readActorFacts, compileAuthorityAssertions } from '../v1.4.1/authority-resolver.mjs';
import { createRuntimeAuthorizer, readRuntimeAuthorization, requireRuntimeAuthorization } from '../v1.4.1/runtime-authorizer.mjs';
import { compileDecisionAssertions } from '../v1.4.1/entitlement-engine.mjs';
import { buildStarsInvoicePayload, verifyStarsInvoicePayload, STARS_MONTH_SECONDS, STARS_ORDER_TTL_SECONDS } from '../v1.3.6/stars-core-foundation.mjs';
import { expireStarsPaidAccess } from '../v1.3.6/stars-access-runtime.mjs';
import { STARS_PURCHASE_LOCK_SQL } from '../v1.4.3/payment-evidence.mjs';
import { inspectLifecycleSchema, lifecycleSchemaAssertion } from '../v1.4.3/lifecycle-schema.mjs';
import { issueStarsRecurringInvoice } from '../v1.4.3/telegram-subscription-provider.mjs';
import { readStarsRecurringConfig } from '../v1.4.3/recurring-provider-config.mjs';
import { inspectPackageSchema, packageSchemaAssertion } from './package-schema.mjs';
import { PACKAGE_CANONICAL_PRICES, planScheduledPackageTransition, resolveOwnPackagePeriodAuthority,
  projectPackagePaidBoundary, compilePackagePeriodAssertions, readPackageContractConfig } from './package-contract.mjs';

const admissions=new WeakMap(),resolver=createAuthorityResolver();
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
async function atomic(identity,assertions,writes){
  const prefix='v144m_'+crypto.randomUUID(),keys=assertions.map((_,i)=>prefix+'_'+i);
  const statements=[...assertions.map((p,i)=>identity.db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
    VALUES(?,CASE WHEN (${p.sql}) THEN 1 ELSE 0 END)`).bind(keys[i],...p.params)),...writes,
    identity.db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key LIKE ?').bind(prefix+'_%')];
  const results=await identity.db.batch(statements);
  if(!Array.isArray(results)||results.length!==statements.length||results.some(r=>r?.success!==true))fail('monthly_transition_commit_unverified',503);
  return results.slice(assertions.length,assertions.length+writes.length);
}
function own(identity,actor){
  const facts=readActorFacts(actor);
  if(identity.actorKind!=='customer'||identity.operation!=='access.read_own'||identity.channel!=='mini_app'||
    !identity.verifiedSessionId||identity.transportBinding?.kind!=='http'||identity.transportBinding.actor!==identity.telegramId||
    !identity.operationId||!identity.payloadHash||!facts.canonicalOwner||!facts.account.exists||!facts.account.acceptedTerms||
    facts.account.isBlocked||facts.account.pendingDeletion||!facts.financialSourceAvailable)fail('monthly_transition_authority_required',403);
  return facts;
}

// Reservation is an unpaid order with an immutable quote, not a Telegram
// invoice or a billing contract. Its authentic creation time precedes the
// paid boundary, as required by the original 0072 metadata contract.
export async function prepareMonthlyReservation({context,actor,quote,transition,nowSeconds}={}){
  const identity=readTrustedContext(context);own(identity,actor);
  if(quote?.packageCode!=='30d'||quote.billingMode!=='recurring'||nowSeconds!==quote.createdAt||
    transition?.telegramId!==identity.telegramId||transition.requestHash!==identity.payloadHash||
    transition.idempotencyKey!==identity.transportBinding.idempotencyKey)fail('monthly_reservation_invalid');
  const planned=planScheduledPackageTransition({quote,actor,nowSec:nowSeconds,transitionId:transition.transitionId,
    idempotencyKey:transition.idempotencyKey,requestHash:transition.requestHash});
  if(JSON.stringify(planned.transition)!==JSON.stringify(transition))fail('monthly_reservation_invalid');
  const orderId=crypto.randomUUID(),payload=await buildStarsInvoicePayload({invoiceSecret:identity.env.STARS_INVOICE_SECRET,
    orderId,telegramId:identity.telegramId,priceId:quote.priceId});
  const metadata={order_id:orderId,telegram_id:identity.telegramId,contract_version:transition.contractVersion,
    package_code:'30d',duration_days:30,period_seconds:STARS_MONTH_SECONDS,price_id:quote.priceId,price_version:quote.priceVersion,
    plan_code:quote.planCode,billing_mode:'recurring',currency:'XTR',amount_stars:quote.amountStars,
    offer_version:quote.offerVersion,campaign_code:quote.campaignCode,quoted_starts_at:transition.effectiveAt,
    quoted_ends_at:transition.effectiveAt+STARS_MONTH_SECONDS,source_subscription_id:quote.sourceSubscriptionId,
    source_package_period_id:quote.sourcePackagePeriodId,source_paid_until:quote.sourcePaidUntil,source_revision:quote.sourceRevision,
    source_payment_ledger_entry_id:quote.sourcePaymentLedgerEntryId,source_fingerprint:quote.sourceFingerprint,
    transition_id:transition.transitionId,created_at:nowSeconds};
  return {orderId,assertions:[{sql:`NOT EXISTS(SELECT 1 FROM subscription_orders WHERE telegram_id=? AND ${STARS_PURCHASE_LOCK_SQL})`,
    params:[identity.telegramId,nowSeconds]}],statements:[
    identity.db.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,currency,amount_stars,
      access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,expires_at,updated_at)
      VALUES(?,?,?,?,?,'XTR',?,2592000,'recurring',?,?,'created',?,?,?)`).bind(orderId,identity.telegramId,quote.priceId,
      quote.priceVersion,quote.planCode,quote.amountStars,quote.termsRevision,payload,nowSeconds,
      transition.effectiveAt+STARS_ORDER_TTL_SECONDS,nowSeconds),
    identity.db.prepare(`INSERT INTO subscription_package_orders(${Object.keys(metadata).join(',')})
      VALUES(${Object.keys(metadata).map(()=>'?').join(',')})`).bind(...Object.values(metadata))]};
}

export async function prepareMonthlyReservationCancellation({context,transition,nowSeconds}={}){
  const identity=readTrustedContext(context);
  if(transition?.toBillingMode!=='recurring'||transition.targetPackageCode!=='30d')return {assertions:[],statements:[]};
  if(identity.actorKind!=='customer'||transition.telegramId!==identity.telegramId)fail('monthly_transition_authority_required',403);
  const pending=await identity.db.prepare(`SELECT r.state,o.order_state FROM subscription_package_orders m
    JOIN subscription_orders o ON o.order_id=m.order_id JOIN subscription_invoice_requests r ON r.origin_order_id=o.order_id
    WHERE m.transition_id=? AND m.telegram_id=?`).bind(transition.transitionId,identity.telegramId).first();
  if(pending&&['admitted','attempted','unknown'].includes(pending.state))fail('monthly_transition_invoice_review_required');
  if(pending?.order_state==='precheckout_ok')fail('monthly_transition_payment_pending');
  const proof={sql:`NOT EXISTS(SELECT 1 FROM subscription_package_orders m JOIN subscription_billing_contracts c ON c.origin_order_id=m.order_id
      WHERE m.transition_id=? AND m.telegram_id=? AND NOT(c.provider_state='unconfirmed' AND c.first_payment_ledger_entry_id IS NULL
        AND c.retired_at IS NULL AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands cmd WHERE cmd.contract_id=c.contract_id)
        AND EXISTS(SELECT 1 FROM subscription_invoice_requests request WHERE request.contract_id=c.contract_id
          AND request.origin_order_id=m.order_id AND request.telegram_id=m.telegram_id AND request.attempted_count=1
          AND request.state IN ('confirmed','rejected'))
        AND NOT EXISTS(SELECT 1 FROM payment_events e WHERE e.order_id=m.order_id AND e.outcome='accepted'
          AND e.event_type IN ('precheckout_received','precheckout_approved','successful_payment_received','payment_recorded','access_applied'))))
    AND NOT EXISTS(SELECT 1 FROM subscription_package_orders m JOIN subscription_orders o ON o.order_id=m.order_id
      WHERE m.transition_id=? AND m.telegram_id=? AND o.order_state NOT IN ('created','cancelled','failed'))
    AND NOT EXISTS(SELECT 1 FROM subscription_package_orders m JOIN payment_ledger paid ON paid.order_id=m.order_id
      WHERE m.transition_id=? AND m.telegram_id=? AND paid.entry_type='payment')`,
    params:[transition.transitionId,identity.telegramId,transition.transitionId,identity.telegramId,transition.transitionId,identity.telegramId]};
  const row=await identity.db.prepare(`SELECT (${proof.sql}) AS allowed`).bind(...proof.params).first();
  if(row?.allowed!==1)fail('package_transition_already_paid');
  return {assertions:[proof],statements:[identity.db.prepare(`UPDATE subscription_orders SET order_state='cancelled',closed_at=?,
    state_revision=state_revision+1,updated_at=MAX(updated_at,?) WHERE telegram_id=? AND order_state='created'
    AND order_id IN(SELECT order_id FROM subscription_package_orders WHERE transition_id=? AND billing_mode='recurring')`)
    .bind(nowSeconds,nowSeconds,identity.telegramId,transition.transitionId)]};
}

const CANCELED_RETIREMENT_SQL=`c.provider_state='canceled' AND c.first_payment_ledger_entry_id IS NOT NULL
 AND EXISTS(SELECT 1 FROM subscription_provider_events e WHERE e.event_id=c.last_provider_event_id AND e.contract_id=c.contract_id
   AND e.telegram_id=c.telegram_id AND e.provider_state='canceled' AND e.source='telegram_update')
 AND EXISTS(SELECT 1 FROM subscription_payment_links l WHERE l.contract_id=c.contract_id AND l.direction='incoming'
   AND l.ledger_entry_id=c.first_payment_ledger_entry_id AND l.provider_period_end<=?)
 AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands cmd WHERE cmd.contract_id=c.contract_id AND cmd.state IN ('admitted','attempted','unknown'))
 AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands cmd JOIN subscription_provider_events observed ON observed.event_id=c.last_provider_event_id
   WHERE cmd.contract_id=c.contract_id AND cmd.state='confirmed' AND cmd.action='reenable_renewal' AND cmd.attempted_at>=observed.received_at)
 AND NOT EXISTS(SELECT 1 FROM subscription_payment_links l JOIN subscription_orders o ON o.order_id=l.applied_order_id
   WHERE l.contract_id=c.contract_id AND l.direction='incoming' AND (l.provider_period_end>? OR o.order_state='paid'))
 AND NOT EXISTS(SELECT 1 FROM subscription_access_grants g JOIN subscription_payment_links l ON l.ledger_entry_id=g.payment_ledger_entry_id
   WHERE l.contract_id=c.contract_id AND g.status='active' AND g.ends_at>?)
 AND NOT EXISTS(SELECT 1 FROM subscription_payment_review_receipts r WHERE r.contract_id=c.contract_id
   AND NOT EXISTS(SELECT 1 FROM subscription_payment_review_settlements settled WHERE settled.ledger_entry_id=r.ledger_entry_id)
   AND NOT EXISTS(SELECT 1 FROM payment_ledger compensation WHERE compensation.related_ledger_entry_id=r.ledger_entry_id
     AND compensation.entry_type IN ('refund','chargeback')))`;

async function retireCanceledContract(context,actor,at){
  const identity=readTrustedContext(context),open=await identity.db.prepare(`SELECT * FROM subscription_billing_contracts
    WHERE telegram_id=? AND retired_at IS NULL`).bind(identity.telegramId).all();
  if(open?.success!==true||!Array.isArray(open.results)||open.results.length>1)fail('monthly_old_contract_conflict');
  if(!open.results.length)return false;
  const c=open.results[0],predicate={sql:`EXISTS(SELECT 1 FROM subscription_billing_contracts c WHERE c.contract_id=? AND c.telegram_id=?
    AND c.revision=? AND c.retired_at IS NULL AND ${CANCELED_RETIREMENT_SQL})`,params:[c.contract_id,identity.telegramId,c.revision,at,at,at]};
  if((await identity.db.prepare(`SELECT (${predicate.sql}) AS allowed`).bind(...predicate.params).first())?.allowed!==1)
    fail('monthly_old_contract_provider_confirmation_required');
  const schema=await inspectLifecycleSchema(identity.db,{required:true}),eventId=crypto.randomUUID();
  await atomic(identity,[...compileAuthorityAssertions(actor).assertions,lifecycleSchemaAssertion(schema),predicate],[
    identity.db.prepare(`INSERT INTO subscription_provider_events(event_id,event_key,contract_id,telegram_id,event_type,source,
      actor_type,reason_code,evidence_sha256,received_at) VALUES(?,?,?,?,'contract_retired','system','system',
      'confirmed_canceled_monthly_boundary',?,?)`).bind(eventId,'monthly-boundary-retirement:'+c.contract_id,c.contract_id,
      identity.telegramId,await hash(JSON.stringify(['monthly-boundary.v1',c.contract_id,c.revision,at])),at),
    identity.db.prepare(`UPDATE subscription_billing_contracts SET retired_at=?,retirement_event_id=?,revision=revision+1,
      updated_at=MAX(updated_at,?) WHERE contract_id=? AND telegram_id=? AND revision=? AND retired_at IS NULL`)
      .bind(at,eventId,at,c.contract_id,identity.telegramId,c.revision)]);
  return true;
}

const UNCHARGED_MONTHLY_RETIREMENT_SQL=`c.provider_state='unconfirmed' AND c.first_payment_ledger_entry_id IS NULL
 AND EXISTS(SELECT 1 FROM subscription_package_orders m JOIN subscription_plan_transitions t ON t.transition_id=m.transition_id
   JOIN subscription_orders o ON o.order_id=m.order_id JOIN subscription_invoice_requests request ON request.origin_order_id=o.order_id
   WHERE m.order_id=c.origin_order_id AND m.telegram_id=c.telegram_id AND m.billing_mode='recurring' AND m.package_code='30d'
   AND t.telegram_id=c.telegram_id AND t.to_billing_mode='recurring' AND t.target_package_code='30d' AND t.state='cancelled'
   AND o.order_state IN ('failed','cancelled') AND o.expires_at<=? AND o.precheckout_approved_at IS NULL
   AND request.contract_id=c.contract_id AND request.telegram_id=c.telegram_id AND request.attempted_count=1
   AND request.state IN ('confirmed','rejected'))
 AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands cmd WHERE cmd.contract_id=c.contract_id)
 AND NOT EXISTS(SELECT 1 FROM payment_events e WHERE e.order_id=c.origin_order_id AND e.outcome='accepted'
   AND e.event_type IN ('precheckout_received','precheckout_approved','successful_payment_received','payment_recorded','access_applied'))
 AND NOT EXISTS(SELECT 1 FROM payment_ledger paid WHERE paid.order_id=c.origin_order_id AND paid.entry_type='payment')
 AND NOT EXISTS(SELECT 1 FROM subscription_payment_links l WHERE l.contract_id=c.contract_id AND l.direction='incoming')
 AND NOT EXISTS(SELECT 1 FROM subscription_payment_review_receipts r WHERE r.contract_id=c.contract_id)`;

// 0071 already permits this exact expired, never-charged retirement. Closing
// the canceled reservation never asserts a Telegram cancellation or refunds
// money. Only a fresh genuine recurring invoice admission invokes the helper.
export async function retireExpiredUnchargedMonthlyReservation(authorization){
  let bundle=readRuntimeAuthorization(requireRuntimeAuthorization(authorization)),identity=readTrustedContext(bundle.context);
  const
    payload=identity.requestPayload,config=readStarsRecurringConfig(identity.env);
  if(identity.actorKind!=='customer'||identity.operation!=='billing.purchase_monthly'||identity.channel!=='mini_app'||
    !identity.verifiedSessionId||identity.transportBinding?.kind!=='http'||identity.transportBinding.actor!==identity.telegramId||
    !exact(payload,['action','requestedPlanCode','billingMode','recurringConsent','termsRevision','priceVersion'])||
    payload.action!=='accept'||payload.billingMode!=='recurring'||payload.recurringConsent!==true||
    payload.termsRevision!==config.termsRevision||payload.priceVersion!==config.priceVersion||!config.ready)
    fail('monthly_retirement_authority_required',403);
  if(!readActorFacts(bundle.actor).canonicalOwner)return false;
  const present=await identity.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='subscription_package_orders'").first();
  if(!present)return false;
  const at=Math.floor(Date.now()/1000),expired=await identity.db.prepare(`SELECT m.order_id FROM subscription_package_orders m
    JOIN subscription_plan_transitions t ON t.transition_id=m.transition_id JOIN subscription_orders o ON o.order_id=m.order_id
    WHERE m.telegram_id=? AND m.billing_mode='recurring' AND m.package_code='30d' AND t.state='cancelled'
      AND o.order_state IN ('cancelled','failed') AND o.expires_at<=? LIMIT 1`).bind(identity.telegramId,at).first();
  if(!expired)return false;
  const schema=await inspectPackageSchema(identity.db,{required:true});
  const paid=await resolveOwnPackagePeriodAuthority({actor:bundle.actor,nowSec:at}),boundary=projectPackagePaidBoundary({
    actor:bundle.actor,verifiedPackagePeriods:paid,nowSec:at});
  if(boundary.nextAvailableAt>at)fail('monthly_transition_paid_residue_remaining');
  // An overdue reservation may have been canceled before any invoice existed.
  // Clear its genuinely expired old projection through the same guarded
  // boundary writer so the fresh ordinary invoice can pass the old checkout.
  const expiry=await expireStarsPaidAccess({...identity.env,DB:{prepare:identity.db.prepare.bind(identity.db),
    batch:statements=>atomic(identity,[...compileDecisionAssertions(bundle.decision).assertions,
      ...compilePackagePeriodAssertions(paid).assertions],statements)}},{telegramId:identity.telegramId,at});
  if(expiry.changed){
    authorization=requireRuntimeAuthorization(await createRuntimeAuthorizer().authorize(await refreshTrustedContext(bundle.context),null));
    bundle=readRuntimeAuthorization(authorization);identity=readTrustedContext(bundle.context);
  }
  const lifecycle=await inspectLifecycleSchema(identity.db,{required:true}),
    result=await identity.db.prepare(`SELECT c.* FROM subscription_billing_contracts c WHERE c.telegram_id=? AND c.retired_at IS NULL
      AND ${UNCHARGED_MONTHLY_RETIREMENT_SQL}`).bind(identity.telegramId,at).all();
  if(result?.success!==true||!Array.isArray(result.results)||result.results.length>1)fail('monthly_retirement_source_unavailable',503);
  if(!result.results.length)return expiry.changed;
  const c=result.results[0],eventId=crypto.randomUUID();
  await atomic(identity,[...compileDecisionAssertions(bundle.decision).assertions,packageSchemaAssertion(schema),lifecycleSchemaAssertion(lifecycle),{
    sql:`EXISTS(SELECT 1 FROM subscription_billing_contracts c WHERE c.contract_id=? AND c.telegram_id=? AND c.revision=?
      AND c.retired_at IS NULL AND ${UNCHARGED_MONTHLY_RETIREMENT_SQL})`,params:[c.contract_id,identity.telegramId,c.revision,at]}],[
    identity.db.prepare(`INSERT INTO subscription_provider_events(event_id,event_key,contract_id,telegram_id,event_type,source,
      actor_type,reason_code,evidence_sha256,received_at) VALUES(?,?,?,?,'contract_retired','system','system',
      'expired_uncharged_monthly_reservation',?,?)`).bind(eventId,'monthly-unpaid-retirement:'+c.contract_id,c.contract_id,
      identity.telegramId,await hash(JSON.stringify(['monthly-unpaid-retirement.v1',c.contract_id,c.revision,at])),at),
    identity.db.prepare(`UPDATE subscription_billing_contracts SET retired_at=?,retirement_event_id=?,revision=revision+1,
      updated_at=MAX(updated_at,?) WHERE contract_id=? AND telegram_id=? AND revision=? AND retired_at IS NULL`)
      .bind(at,eventId,at,c.contract_id,identity.telegramId,c.revision)]);
  return true;
}

// The provider recognizes only this private admission. Copies, raw actor DTOs,
// arbitrary reserved order IDs, and options flags cannot select a reservation.
export function readMonthlyTransitionInvoiceAdmission(token,authorization){
  if(token===undefined||token===null)return null;
  const value=admissions.get(token);if(!value)fail('monthly_invoice_admission_untrusted',403);
  const bundle=readRuntimeAuthorization(requireRuntimeAuthorization(authorization)),identity=readTrustedContext(bundle.context);
  if(identity.db!==value.db||identity.telegramId!==value.telegramId||identity.operation!=='billing.purchase_monthly'||
    identity.operationId!==value.operationId||identity.payloadHash!==value.payloadHash||identity.verifiedSessionId!==value.sessionId)
    fail('monthly_invoice_admission_mismatch',403);
  return value;
}
export async function compileMonthlyTransitionInvoiceAssertions(token,authorization){
  const value=readMonthlyTransitionInvoiceAdmission(token,authorization);if(!value)return {assertions:[]};
  const bundle=readRuntimeAuthorization(authorization),actor=await resolver.resolveActor(bundle.context),facts=readActorFacts(actor),
    paid=await resolveOwnPackagePeriodAuthority({actor,nowSec:facts.nowSeconds}),
    boundary=projectPackagePaidBoundary({actor,verifiedPackagePeriods:paid,nowSec:facts.nowSeconds});
  if(boundary.nextAvailableAt>facts.nowSeconds)fail('monthly_transition_paid_residue_remaining');
  return {assertions:[packageSchemaAssertion(value.schema),compileContextAssertions(value.context),
    {sql:`EXISTS(SELECT 1 FROM subscription_plan_transitions t JOIN subscription_package_orders m ON m.transition_id=t.transition_id
      JOIN subscription_orders o ON o.order_id=m.order_id WHERE t.transition_id=? AND t.telegram_id=? AND t.state='scheduled'
      AND t.revision=? AND t.target_package_code='30d' AND t.to_billing_mode='recurring' AND t.effective_at<=unixepoch()
      AND m.order_id=? AND o.invoice_payload=? AND o.order_state='created' AND o.expires_at>unixepoch()
      AND t.to_plan=o.plan_code AND t.target_price_id=o.price_id AND t.target_price_version=o.price_version
      AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=t.source_payment_ledger_entry_id
        AND r.entry_type IN ('refund','chargeback')))`,params:[value.transitionId,value.telegramId,value.revision,value.orderId,value.invoicePayload]},
    ...compilePackagePeriodAssertions(paid).assertions]};
}

export async function executeMonthlyTransitionCommand(context,options={}){
  context=await refreshTrustedContext(context);let identity=readTrustedContext(context),actor=await resolver.resolveActor(context);
  const facts=own(identity,actor),payload=identity.requestPayload,now=facts.nowSeconds;
  if(!exact(payload,['transitionId','expectedRevision','recurringConsent','termsRevision','priceVersion'])||payload.recurringConsent!==true)
    fail('monthly_transition_consent_required',400);
  if(!readPackageContractConfig(identity.env).enabled)fail('package_disabled');
  const schema=await inspectPackageSchema(identity.db,{required:true});
  const t=await identity.db.prepare('SELECT * FROM subscription_plan_transitions WHERE transition_id=? AND telegram_id=?')
    .bind(payload.transitionId,identity.telegramId).first();
  if(!t)fail('package_transition_unavailable',404);
  if(t.target_package_code!=='30d'||t.to_billing_mode!=='recurring'||
    !((t.state==='scheduled'&&t.revision===payload.expectedRevision)||(t.state==='fulfilled'&&t.revision===payload.expectedRevision+1)))
    fail('monthly_transition_revision_changed');
  if(now<t.effective_at)fail('package_monthly_invoice_not_due');
  const o=await identity.db.prepare(`SELECT o.* FROM subscription_orders o JOIN subscription_package_orders m ON m.order_id=o.order_id
    WHERE m.transition_id=? AND m.telegram_id=? AND m.billing_mode='recurring'`).bind(t.transition_id,identity.telegramId).first();
  if(!o)fail('monthly_reservation_expired_or_closed');
  const compensated=await identity.db.prepare(`SELECT ledger_entry_id FROM payment_ledger WHERE related_ledger_entry_id=?
    AND entry_type IN ('refund','chargeback') LIMIT 1`).bind(t.source_payment_ledger_entry_id).first();
  if(compensated)fail('monthly_transition_source_compensated');
  const config=readStarsRecurringConfig(identity.env);
  if(!config.ready||payload.termsRevision!==config.termsRevision||payload.priceVersion!==config.priceVersion||
    o.price_version!==config.priceVersion||o.terms_revision!==config.termsRevision||o.price_id!==t.target_price_id||
    o.amount_stars!==PACKAGE_CANONICAL_PRICES[t.to_plan]['30d'])fail('monthly_transition_price_changed');
  const verified=await verifyStarsInvoicePayload({invoiceSecret:identity.env.STARS_INVOICE_SECRET,payload:o.invoice_payload,
    telegramId:identity.telegramId,priceId:o.price_id});if(verified.orderId!==o.order_id)fail('monthly_reservation_unverified');
  const derived=await deriveTrustedOperationContext(context,{operation:'billing.purchase_monthly',requestPayload:{action:'accept',
    requestedPlanCode:t.to_plan,billingMode:'recurring',recurringConsent:true,termsRevision:payload.termsRevision,priceVersion:payload.priceVersion}}),
    derivedIdentity=readTrustedContext(derived);
  const retained=await identity.db.prepare('SELECT * FROM subscription_invoice_requests WHERE origin_order_id=? AND telegram_id=?')
    .bind(o.order_id,identity.telegramId).first();
  if(retained){
    if(retained.idempotency_key!=='stars-invoice:'+derivedIdentity.operationId||retained.request_sha256!==derivedIdentity.payloadHash)
      fail('monthly_transition_invoice_idempotency_collision');
    if(retained.state!=='admitted'){
      await atomic(identity,[...compileAuthorityAssertions(actor).assertions,packageSchemaAssertion(schema),{
      sql:`EXISTS(SELECT 1 FROM subscription_invoice_requests WHERE request_id=? AND origin_order_id=? AND telegram_id=?
        AND idempotency_key=? AND request_sha256=? AND state=? AND revision=?)`,params:[retained.request_id,o.order_id,identity.telegramId,
        retained.idempotency_key,retained.request_sha256,retained.state,retained.revision]}],[]);
    return {status:retained.state==='attempted'?'pending':retained.state,requestId:retained.request_id,contractId:retained.contract_id,
      orderId:o.order_id,transitionId:t.transition_id,billingMode:'recurring',periodSeconds:STARS_MONTH_SECONDS,
      invoiceUrl:retained.state==='confirmed'?retained.invoice_url:null,reviewRequired:['attempted','unknown'].includes(retained.state),
        accessApplied:false,replayed:true,transitionFulfilled:t.state==='fulfilled'};
    }
  }
  if(t.state!=='scheduled'||o.order_state!=='created'||o.expires_at<=now)fail('monthly_reservation_expired_or_closed');
  let paid=await resolveOwnPackagePeriodAuthority({actor,nowSec:now}),boundary=projectPackagePaidBoundary({actor,verifiedPackagePeriods:paid,nowSec:now});
  if(boundary.nextAvailableAt>now)fail('monthly_transition_paid_residue_remaining');
  // Invoke the existing expiry writer only through this fixed own boundary
  // adapter. The exact genuine paid timeline is reasserted inside its batch,
  // so a renewal/package race cannot clear a paid plan after the read.
  const expiry=await expireStarsPaidAccess({...identity.env,DB:{
    prepare:identity.db.prepare.bind(identity.db),
    batch:statements=>atomic(identity,compilePackagePeriodAssertions(paid).assertions,statements),
  }},{telegramId:identity.telegramId,at:now});
  if(expiry.changed){
    context=await refreshTrustedContext(context);identity=readTrustedContext(context);actor=await resolver.resolveActor(context);
    own(identity,actor);paid=await resolveOwnPackagePeriodAuthority({actor,nowSec:now});
  }
  if(!retained&&await retireCanceledContract(context,actor,now)){
    context=await refreshTrustedContext(context);identity=readTrustedContext(context);actor=await resolver.resolveActor(context);
    own(identity,actor);paid=await resolveOwnPackagePeriodAuthority({actor,nowSec:now});
    boundary=projectPackagePaidBoundary({actor,verifiedPackagePeriods:paid,nowSec:now});
    if(boundary.nextAvailableAt>now)fail('monthly_transition_paid_residue_remaining');
  }
  const freshDerived=await deriveTrustedOperationContext(context,{operation:'billing.purchase_monthly',requestPayload:readTrustedContext(derived).requestPayload});
  const authorization=requireRuntimeAuthorization(await createRuntimeAuthorizer().authorize(freshDerived,null));
  const token=Object.freeze({version:1});
  admissions.set(token,Object.freeze({context,db:identity.db,telegramId:identity.telegramId,sessionId:identity.verifiedSessionId,
    operationId:derivedIdentity.operationId,payloadHash:derivedIdentity.payloadHash,transitionId:t.transition_id,revision:t.revision,
    orderId:o.order_id,invoicePayload:o.invoice_payload,schema}));
  return {...await issueStarsRecurringInvoice(authorization,{...options,monthlyTransitionAdmission:token}),transitionId:t.transition_id};
}

// A fixed service executor can complete only a transition whose genuine old
// recurring producer already committed its incoming payment and active grant.
// This writes no money, grant, current projection, or provider control state.
export async function fulfillMonthlyTransitionFromAppliedPayment(serviceContext,{orderId}={}){
  const identity=readTrustedContext(serviceContext);
  if(identity.actorKind!=='service'||identity.executorPurpose!=='stars_process_event'||identity.operation!=='service.stars.process_event')
    fail('monthly_transition_service_required',403);
  const schema=await inspectPackageSchema(identity.db);if(!schema.present)return {fulfilled:false};
  const row=await identity.db.prepare(`SELECT t.*,g.grant_id,g.created_at AS grant_created_at FROM subscription_plan_transitions t
    JOIN subscription_package_orders m ON m.transition_id=t.transition_id JOIN subscription_orders o ON o.order_id=m.order_id
    JOIN subscription_access_grants g ON g.order_id=o.order_id JOIN payment_ledger paid ON paid.ledger_entry_id=g.payment_ledger_entry_id
    WHERE o.order_id=? AND t.to_billing_mode='recurring' AND t.target_package_code='30d' AND o.order_state='applied'
    AND g.status='active' AND g.telegram_id=t.telegram_id AND g.plan_code=t.to_plan AND g.access_seconds=t.period_seconds
    AND g.starts_at>=t.effective_at AND paid.entry_type='payment' AND paid.direction='credit'
    AND paid.telegram_id=t.telegram_id AND paid.order_id=o.order_id AND paid.currency=o.currency AND paid.amount_stars=o.amount_stars
    AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=paid.ledger_entry_id AND r.entry_type IN ('refund','chargeback'))`)
    .bind(orderId).first();
  if(!row)return {fulfilled:false};
  if(row.state==='fulfilled')return {fulfilled:true,replayed:true,transitionId:row.transition_id};
  if(row.state!=='scheduled')fail('monthly_transition_state_changed');
  const at=identity.nowSeconds;if(at<row.grant_created_at)fail('monthly_transition_clock_invalid');
  await atomic(identity,[compileContextAssertions(serviceContext),packageSchemaAssertion(schema)],
    [identity.db.prepare(`UPDATE subscription_plan_transitions SET state='fulfilled',target_order_id=?,target_grant_id=?,
      revision=revision+1,updated_at=? WHERE transition_id=? AND state='scheduled' AND revision=?`)
      .bind(orderId,row.grant_id,at,row.transition_id,row.revision)]);
  const persisted=await identity.db.prepare('SELECT state,target_order_id,target_grant_id FROM subscription_plan_transitions WHERE transition_id=?')
    .bind(row.transition_id).first();
  if(persisted?.state!=='fulfilled'||persisted.target_order_id!==orderId||persisted.target_grant_id!==row.grant_id)fail('monthly_transition_commit_unverified',503);
  return {fulfilled:true,replayed:false,transitionId:row.transition_id};
}
