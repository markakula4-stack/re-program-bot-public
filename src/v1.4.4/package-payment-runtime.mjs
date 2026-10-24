import { buildStarsInvoicePayload, parseStarsInvoicePayload, verifyStarsInvoicePayload,
  readStarsCoreConfig } from '../v1.3.6/stars-core-foundation.mjs';
import { callStarsTelegram } from '../v1.3.6/stars-payment-runtime.mjs';
import { createAuthorityResolver, readActorContext, readActorFacts, compileAuthorityReplayAssertions } from '../v1.4.1/authority-resolver.mjs';
import { readTrustedContext, compileContextAssertions } from '../v1.4.1/trusted-context.mjs';
import { STARS_PURCHASE_LOCK_SQL } from '../v1.4.3/payment-evidence.mjs';
import { PACKAGE_CONTRACT_VERSION, PACKAGE_DURATIONS, normalizeServerPackagePrice,
  readPackageContractConfig, resolveOwnPackagePeriodAuthority, createServerPackageQuote,
  compilePackagePeriodAssertions, projectPackagePaidBoundary, assertPackageQuoteAdmissible,
  assertRecurringExitConfirmed, PACKAGE_OWNER_TEST_OFFER, normalizeStoredServerPackagePrice, readOwnerTestInvoiceRetry } from './package-contract.mjs';
import { inspectPackageSchema, inspectPackagePaymentReviewSchema, packagePaymentReviewSchemaAssertion } from './package-schema.mjs';
import { readPackagePurchaseRequest, assertConfirmedPackageOffer, confirmedPackageTermsStatement } from './package-confirmation.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const positive = n => Number.isSafeInteger(n) && n > 0;
const clock = value => { const n = value ?? Math.floor(Date.now() / 1000); if (!positive(n)) fail('payment_clock_invalid'); return n; };
const updateId = n => { if (!Number.isSafeInteger(n) || n < 0) fail('telegram_update_id_invalid'); return n; };
const uuid = id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id);
const safeReason = error => String(error?.code || 'package_source_unavailable').replace(/[^a-z0-9_.-]/gu, '_').slice(0,64);
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2,'0')).join('');
const database = env => { if (!env?.DB?.prepare || !env?.DB?.batch) fail('stars_database_not_ready'); return env.DB; };
const api = options => typeof options?.telegramApi === 'function' ? options.telegramApi : callStarsTelegram;
const changes = result => Number(result?.meta?.changes ?? result?.changes ?? 0);

function assertion(db, condition, params, now) {
  // The impossible NOT NULL event key aborts the WHOLE D1 transaction when a
  // captured source changes. A successful zero-row optimistic write is never
  // enough to approve an external payment.
  return db.prepare(`INSERT INTO payment_events(event_id,event_key,event_type,outcome,occurred_at,received_at)
    SELECT lower(hex(randomblob(16))),NULL,'payment_recorded','error',${now},${now} WHERE NOT (${condition})`)
    .bind(...params);
}
function assertions(db, proof, now) {
  return proof.assertions.map(item => assertion(db,item.sql,item.params,now));
}
async function batch(db, statements) {
  const results = await db.batch(statements);
  if (!Array.isArray(results) || results.length !== statements.length || results.some(r => r?.success !== true || r.error))
    fail('package_payment_persistence_invariant');
  return results;
}
function event(db,{ key, order, type, outcome='accepted', reason, evidence, occurredAt, receivedAt, telegramUpdateId=null, ignore=false }) {
  return db.prepare(`INSERT${ignore?' OR IGNORE':''} INTO payment_events(event_id,event_key,order_id,telegram_id,telegram_update_id,
    event_type,outcome,reason_code,payload_sha256,occurred_at,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(),key,order.order_id,order.telegram_id,telegramUpdateId,type,outcome,reason,evidence,occurredAt,receivedAt);
}
async function freshScope(actor, now) {
  const context = readActorContext(actor), identity = readTrustedContext(context);
  const fresh = await createAuthorityResolver().resolveActor(context);
  const proof = await resolveOwnPackagePeriodAuthority({actor:fresh,nowSec:now});
  return {actor:fresh,verifiedPackagePeriods:proof,identity,nowSec:now};
}
async function terms(db, id, revision, now) {
  const row=await db.prepare(`SELECT users.telegram_id FROM users WHERE telegram_id=? AND accepted_terms=1 AND is_blocked=0
    AND EXISTS(SELECT 1 FROM terms_acceptances WHERE telegram_id=users.telegram_id AND terms_revision=?
      AND acceptance_scope='stars_purchase' AND accepted_at<=?)`).bind(id,revision,now).first();
  if (!row) fail('stars_terms_not_accepted');
}

const canonical = value => {
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
 return value;
};
async function financialObservation(env,update,context,actor,now) {
 if(!context&&actor)context=readActorContext(actor);
 const identity=readTrustedContext(context),transport=identity.transportBinding;
 if(identity.actorKind!=='customer'||identity.channel!=='telegram_command'||transport?.kind!=='telegram'||
   typeof transport.financialUpdateSha256!=='string'||identity.telegramId!==(update.pre_checkout_query?.from?.id??update.message?.from?.id)||
   transport.updateId!==update.update_id||now<identity.issuedAt||now>=identity.expiresAt||
   transport.financialUpdateSha256!==await hash(JSON.stringify(canonical(update)))||
   JSON.stringify(identity.requestPayload?.update)!==JSON.stringify(canonical(update))||
   identity.env.STARS_INVOICE_SECRET!==env.STARS_INVOICE_SECRET)fail('untrusted_package_financial_observation');
 if(actor&&readActorContext(actor)!==context)fail('package_financial_actor_context_mismatch');
 return {identity,assertion:compileContextAssertions(context)};
}

async function storedPackageInvoice(env,payload,longOnly) {
  let parsed; try { parsed=parseStarsInvoicePayload(payload); } catch { return false; }
  const db=database(env);
  const order=await db.prepare('SELECT * FROM subscription_orders WHERE order_id=? AND invoice_payload=? LIMIT 1').bind(parsed.orderId,payload).first();
  if(order?.billing_mode==='prepaid' && Object.values(PACKAGE_DURATIONS).some(period=>period.periodSeconds===order.access_seconds)) {
    // The original signed order survives a partial package migration rollback.
    // Missing metadata must keep its financial update retryable, rather than
    // routing an actual long charge to the old 30-day validation path.
    try {
      const verified=await verifyStarsInvoicePayload({invoiceSecret:env.STARS_INVOICE_SECRET,payload,
        telegramId:order.telegram_id,priceId:order.price_id});
      if(verified.orderId!==order.order_id) return false;
    } catch(error) {
      if(!error?.code) throw error;
      return false;
    }
    const price=await db.prepare('SELECT * FROM price_book WHERE price_id=? LIMIT 1').bind(order.price_id).first();
    const promo=price?.price_id===PACKAGE_OWNER_TEST_OFFER.priceId;
    const readMetadata=packageCode=>db.prepare(`SELECT * FROM subscription_package_orders
      WHERE order_id=? AND telegram_id=? AND billing_mode='prepaid' AND package_code=? AND period_seconds=? LIMIT 1`)
      .bind(order.order_id,order.telegram_id,packageCode,order.access_seconds).first();
    let metadata;
    if(promo){
      await inspectPackageSchema(db,{required:true});metadata=await readMetadata(PACKAGE_OWNER_TEST_OFFER.packageCode);
      if(!metadata)throw Object.assign(new Error('v144_package_schema_not_ready'),{code:'v144_package_schema_not_ready',status:503});
    }
    let normalized;try { normalized=promo?normalizeStoredServerPackagePrice(price,{order,metadata,
      botId:Number(env.BOT_TOKEN?.split(':')[0])}):normalizeServerPackagePrice(price); } catch { return false; }
    if(!positive(order.telegram_id)||!positive(order.created_at)||
      [['plan_code','planCode'],['price_id','priceId'],['price_version','priceVersion'],['currency','currency'],
        ['amount_stars','amountStars'],['access_seconds','periodSeconds'],['billing_mode','billingMode'],['terms_revision','termsRevision']]
        .some(([key,target])=>order[key]!==normalized[target]) || normalized.validFrom>order.created_at ||
      normalized.validUntil!==null && normalized.validUntil<=order.created_at) return false;
    if(!promo){await inspectPackageSchema(db,{required:true});metadata=await readMetadata(normalized.packageCode);}
    if(!metadata) throw Object.assign(new Error('v144_package_schema_not_ready'),{code:'v144_package_schema_not_ready',status:503});
    return true;
  }
  const schema=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='subscription_package_orders'").first();
  if (!schema) return false;
  return Boolean(await db.prepare(`SELECT m.order_id FROM subscription_package_orders m JOIN subscription_orders o ON o.order_id=m.order_id
    WHERE m.order_id=? AND o.invoice_payload=? ${longOnly?"AND m.billing_mode='prepaid' AND m.package_code IN ('3m','6m','12m')":''} LIMIT 1`).bind(parsed.orderId,payload).first());
}
export const isStoredPackageInvoice=(env,payload)=>storedPackageInvoice(env,payload,true);
export const isStoredPackageFinancialInvoice=(env,payload)=>storedPackageInvoice(env,payload,false);
export const verifyPackageFinancialIngress=(env,update,{context,actor,nowSec}={})=>financialObservation(env,update,context,actor,clock(nowSec));

async function loadOrder(env,payload) {
  const parsed=parseStarsInvoicePayload(payload), db=database(env);
  const order=await db.prepare('SELECT * FROM subscription_orders WHERE order_id=? LIMIT 1').bind(parsed.orderId).first();
  const metadata=await db.prepare('SELECT * FROM subscription_package_orders WHERE order_id=? LIMIT 1').bind(parsed.orderId).first();
  if (!order || !metadata || order.invoice_payload!==payload) fail('package_order_not_found');
  const verified=await verifyStarsInvoicePayload({invoiceSecret:env.STARS_INVOICE_SECRET,payload,
    telegramId:order.telegram_id,priceId:order.price_id});
  if (verified.orderId!==order.order_id) fail('package_order_signature_invalid');
  const price=await db.prepare('SELECT * FROM price_book WHERE price_id=? LIMIT 1').bind(order.price_id).first();
  const normalized=normalizeStoredServerPackagePrice(price,{order,metadata,botId:Number(env.BOT_TOKEN?.split(':')[0])});
  const fields=[['telegram_id','telegramId'],['plan_code','planCode'],['price_id','priceId'],['price_version','priceVersion'],
    ['currency','currency'],['amount_stars','amountStars'],['access_seconds','periodSeconds'],['billing_mode','billingMode'],['terms_revision','termsRevision']];
  if (fields.some(([key,target])=>key==='telegram_id' ? order[key]!==metadata.telegram_id : order[key]!==normalized[target]) ||
    metadata.contract_version!==PACKAGE_CONTRACT_VERSION || metadata.plan_code!==order.plan_code || metadata.price_id!==order.price_id ||
    metadata.price_version!==order.price_version || metadata.amount_stars!==order.amount_stars || metadata.currency!=='XTR' ||
    metadata.billing_mode!=='prepaid' || metadata.period_seconds!==order.access_seconds || metadata.package_code!==normalized.packageCode ||
    metadata.duration_days!==normalized.durationDays || metadata.quoted_ends_at!==metadata.quoted_starts_at+order.access_seconds ||
    metadata.created_at!==order.created_at || price.valid_from>order.created_at || price.valid_until!==null && price.valid_until<=order.created_at)
    fail('package_order_snapshot_invalid');
  return {order,metadata,price,normalized};
}
async function storedTransition(db,id,expected) {
 const row=await db.prepare("SELECT * FROM subscription_plan_transitions WHERE telegram_id=? AND state='scheduled' LIMIT 1").bind(id).first();
 if(!row){
  if(expected.transition_id!==null&&expected.transition_id!==undefined)fail('package_transition_source_changed');
  return {transitionId:null,assertion:{sql:"NOT EXISTS(SELECT 1 FROM subscription_plan_transitions WHERE telegram_id=? AND state='scheduled')",params:[id]}};
 }
 const matches=[['to_plan','plan_code'],['target_package_code','package_code'],['target_price_id','price_id'],['target_price_version','price_version'],
  ['to_billing_mode','billing_mode'],['period_seconds','period_seconds'],['offer_version','offer_version'],['campaign_code','campaign_code'],
  ['effective_at','quoted_starts_at'],['source_subscription_id','source_subscription_id'],['source_package_period_id','source_package_period_id'],
  ['source_revision','source_revision'],['source_payment_ledger_entry_id','source_payment_ledger_entry_id'],['source_fingerprint','source_fingerprint']];
 if(expected.transition_id!==undefined&&expected.transition_id!==row.transition_id || matches.some(([left,right])=>row[left]!==expected[right]))
  fail('package_transition_source_changed');
 const keys=Object.keys(row);
 return {transitionId:row.transition_id,assertion:{sql:`EXISTS(SELECT 1 FROM subscription_plan_transitions WHERE ${keys.map(key=>key+' IS ?').join(' AND ')})`,params:keys.map(key=>row[key])}};
}
function scopeAssertions(scope) {
 const proof=compilePackagePeriodAssertions(scope.verifiedPackagePeriods);
 return {assertions:[...proof.assertions,...[scope.transitionAssertion,scope.invoiceAssertion,scope.reviewSchemaAssertion].filter(Boolean)]};
}

const SOURCE_FIELDS=[['sourceSubscriptionId','source_subscription_id'],['sourcePackagePeriodId','source_package_period_id'],
  ['sourcePaidUntil','source_paid_until'],['sourceRevision','source_revision'],['sourcePaymentLedgerEntryId','source_payment_ledger_entry_id'],
  ['sourceFingerprint','source_fingerprint']];
async function validateOwnOrderSource(env, actor, loaded, now, {allowAdmitted=false}={}) {
  const scope=await freshScope(actor,now), principal=readActorFacts(scope.actor);
  const reviewSchema=await inspectPackagePaymentReviewSchema(scope.identity.db,{required:true});
  const invoiceRequest=await scope.identity.db.prepare('SELECT * FROM subscription_package_invoice_requests WHERE order_id=? AND telegram_id=?').bind(loaded.order.order_id,loaded.order.telegram_id).first();
  if(!invoiceRequest||!(allowAdmitted&&invoiceRequest.state==='admitted'||invoiceRequest.attempted_count===1&&['attempted','confirmed','unknown'].includes(invoiceRequest.state)))
    fail('package_invoice_attempt_unverified');
  const invoiceKeys=Object.keys(invoiceRequest),invoiceAssertion={sql:`EXISTS(SELECT 1 FROM subscription_package_invoice_requests WHERE ${invoiceKeys.map(key=>key+' IS ?').join(' AND ')})`,params:invoiceKeys.map(key=>invoiceRequest[key])};
  if (principal.telegramId!==loaded.order.telegram_id) fail('package_payment_foreign_actor');
  if (scope.identity.env.STARS_INVOICE_SECRET!==env.STARS_INVOICE_SECRET) fail('package_payment_binding_mismatch');
  // Price/gates are fresh, while the original immutable offer snapshot is
  // never repriced or silently replaced by a client field.
  const quote=createServerPackageQuote({...scope,request:{requestedPlanCode:loaded.order.plan_code,packageCode:loaded.metadata.package_code},
    ...(loaded.order.price_id===PACKAGE_OWNER_TEST_OFFER.priceId?{retainedOrderId:loaded.order.order_id}:{})});
  const boundary=projectPackagePaidBoundary(scope);
  if (quote.priceId!==loaded.order.price_id || quote.priceVersion!==loaded.order.price_version ||
    quote.offerVersion!==loaded.metadata.offer_version || quote.campaignCode!==loaded.metadata.campaign_code ||
    SOURCE_FIELDS.some(([camel,snake])=>boundary[camel]!==loaded.metadata[snake]) ||
    boundary.nextAvailableAt>Math.max(loaded.metadata.quoted_starts_at,now)) fail('package_quote_source_changed');
  assertRecurringExitConfirmed(scope);
  await terms(scope.identity.db,principal.telegramId,loaded.order.terms_revision,now);
  if (!readStarsCoreConfig(scope.identity.env).ready) fail('stars_payments_not_ready');
  const transition=await storedTransition(scope.identity.db,loaded.order.telegram_id,loaded.metadata);
  return {...scope,transitionAssertion:transition.assertion,invoiceAssertion,reviewSchemaAssertion:packagePaymentReviewSchemaAssertion(reviewSchema)};
}

export async function issuePackageInvoice({actor,request,telegramUpdateId,orderId,createdAt}={},options={}) {
  const now=clock(createdAt), context=readTrustedContext(readActorContext(actor)), principal=readActorFacts(actor);
  if (principal.actorKind!=='customer' || !principal.canonicalOwner || !principal.account?.exists || !principal.account.acceptedTerms ||
      principal.account.isBlocked || principal.account.pendingDeletion || principal.telegramId!==context.telegramId || now>=principal.validUntil)
    fail('package_owner_authority_required');
  const purchase=readPackagePurchaseRequest(request);
  if(context.requestPayload && JSON.stringify(context.requestPayload)!==JSON.stringify(canonical(request)))
    fail('package_request_transport_mismatch');
  const transportUpdate=context.transportBinding?.kind==='telegram'?context.transportBinding.updateId:null;
  const uid=telegramUpdateId===undefined?transportUpdate:updateId(telegramUpdateId);
  if(context.operationId){
    const digest=context.operationId;
    const stable=`${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
    if(orderId!==undefined&&orderId!==stable)fail('package_order_transport_mismatch');orderId=stable;
  }else orderId??=crypto.randomUUID();
  if (!uuid(orderId)) fail('order_id_invalid');
  const prior=await context.db.prepare('SELECT * FROM subscription_orders WHERE order_id=?').bind(orderId).first();
  if(prior){
    const stored=await loadOrder({...context.env,DB:context.db},prior.invoice_payload);
    if(prior.telegram_id!==context.telegramId||prior.plan_code!==request.requestedPlanCode||stored.metadata.package_code!==request.packageCode)
      fail('package_invoice_idempotency_collision');
    const journal=await context.db.prepare('SELECT * FROM subscription_package_invoice_requests WHERE order_id=?').bind(orderId).first();
    const oldPayloadHash=await hash(prior.invoice_payload);
    if(!journal || (purchase.confirmation || journal.request_sha256!==oldPayloadHash) && journal.request_sha256!==context.payloadHash)
      throw Object.assign(new Error('package_invoice_idempotency_collision'),{code:'package_invoice_idempotency_collision',status:409});
    const journalKeys=Object.keys(journal);
    await batch(context.db,[...assertions(context.db,compileAuthorityReplayAssertions(actor),now),
      assertion(context.db,`EXISTS(SELECT 1 FROM subscription_package_invoice_requests WHERE ${journalKeys.map(key=>key+' IS ?').join(' AND ')})`,
        journalKeys.map(key=>journal[key]),now)]);
    const issued=journal.state==='confirmed'&&journal.attempted_count===1?journal:null;
    return Object.freeze({status:issued?'issued':'manual_review',reason:issued?'invoice_replayed':'package_invoice_issuance_unknown',
      packagePayment:true,duplicate:true,orderId,planCode:prior.plan_code,packageCode:stored.metadata.package_code,amountStars:prior.amount_stars,
      accessSeconds:prior.access_seconds,periodStartsAt:stored.metadata.quoted_starts_at,periodEndsAt:stored.metadata.quoted_ends_at,
      expiresAt:prior.expires_at,invoiceURL:issued?.invoice_url??null,accessApplied:false});
  }
  const scope=await freshScope(actor,now), quote=createServerPackageQuote({...scope,request:purchase.request});
  assertPackageQuoteAdmissible({quote,actor:scope.actor,nowSec:now});
  assertConfirmedPackageOffer(scope.identity,quote,purchase.confirmation);
  if (!readStarsCoreConfig(scope.identity.env).ready) fail('stars_payments_not_ready');
  // A clean expired test invoice must not keep the one-open-order slot when
  // the owner returns to the canonical offer. The existing captured proof and
  // atomic assertions still exclude payments, pre-checkout and unknown results.
  const db=scope.identity.db,env={...scope.identity.env,DB:db},
    retry=quote.planCode===PACKAGE_OWNER_TEST_OFFER.planCode&&quote.packageCode===PACKAGE_OWNER_TEST_OFFER.packageCode?
      readOwnerTestInvoiceRetry(scope):null;
  if(!purchase.confirmation)await terms(db,quote.telegramId,quote.termsRevision,now);
  const existing=await db.prepare(`SELECT order_id FROM subscription_orders WHERE telegram_id=? AND ${STARS_PURCHASE_LOCK_SQL} LIMIT 1`)
    .bind(quote.telegramId,now).first();
  if (existing) fail('payment_order_in_progress');
  const invoicePayload=await buildStarsInvoicePayload({invoiceSecret:env.STARS_INVOICE_SECRET,orderId,telegramId:quote.telegramId,priceId:quote.priceId});
  const order={order_id:orderId,telegram_id:quote.telegramId}, expiresAt=now+900,requestId=crypto.randomUUID();
  const reviewSchema=await inspectPackagePaymentReviewSchema(db,{required:true}),reviewAssertion=packagePaymentReviewSchemaAssertion(reviewSchema);
  const metadata={order_id:orderId,telegram_id:quote.telegramId,contract_version:quote.contractVersion,
    package_code:quote.packageCode,duration_days:quote.durationDays,period_seconds:quote.periodSeconds,price_id:quote.priceId,
    price_version:quote.priceVersion,plan_code:quote.planCode,billing_mode:quote.billingMode,currency:quote.currency,amount_stars:quote.amountStars,
    offer_version:quote.offerVersion,campaign_code:quote.campaignCode,quoted_starts_at:quote.quotedStartsAt,quoted_ends_at:quote.quotedEndsAt,
    source_subscription_id:quote.sourceSubscriptionId,source_package_period_id:quote.sourcePackagePeriodId,source_paid_until:quote.sourcePaidUntil,
    source_revision:quote.sourceRevision,source_payment_ledger_entry_id:quote.sourcePaymentLedgerEntryId,source_fingerprint:quote.sourceFingerprint,
    transition_id:null,created_at:now};
  const transition=await storedTransition(db,quote.telegramId,{...metadata,transition_id:undefined});
  metadata.transition_id=transition.transitionId;scope.transitionAssertion=transition.assertion;
  await batch(db,[...assertions(db,scopeAssertions(scope),now),
    assertion(db,reviewAssertion.sql,reviewAssertion.params,now),
    assertion(db,`NOT EXISTS(SELECT 1 FROM subscription_orders WHERE telegram_id=? AND ${STARS_PURCHASE_LOCK_SQL})`,[quote.telegramId,now],now),
    ...confirmedPackageTermsStatement(scope.identity,quote,purchase.confirmation,now),
    ...(retry?[db.prepare("UPDATE subscription_orders SET order_state='cancelled',closed_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=? AND telegram_id=? AND order_state='created' AND state_revision=1 AND expires_at<=? AND precheckout_approved_at IS NULL AND paid_at IS NULL AND applied_at IS NULL AND closed_at IS NULL")
      .bind(now,now,retry.order.order_id,quote.telegramId,now),
      assertion(db,"EXISTS(SELECT 1 FROM subscription_orders WHERE order_id=? AND telegram_id=? AND order_state='cancelled' AND state_revision=2 AND closed_at=? AND updated_at=?)",[retry.order.order_id,quote.telegramId,now,now],now)]:[]),
    db.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,currency,amount_stars,access_seconds,
      billing_mode,terms_revision,invoice_payload,order_state,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'created',?,?,?)`)
      .bind(orderId,quote.telegramId,quote.priceId,quote.priceVersion,quote.planCode,'XTR',quote.amountStars,quote.periodSeconds,'prepaid',quote.termsRevision,invoicePayload,now,expiresAt,now),
    db.prepare(`INSERT INTO subscription_package_orders(${Object.keys(metadata).join(',')}) VALUES(${Object.keys(metadata).map(()=>'?').join(',')})`).bind(...Object.values(metadata)),
    db.prepare("INSERT INTO subscription_package_invoice_requests(request_id,order_id,telegram_id,request_sha256,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(requestId,orderId,quote.telegramId,purchase.confirmation?context.payloadHash:await hash(invoicePayload),now,now),
    event(db,{key:`package:${orderId}:created`,order,type:'order_created',reason:'server_package_snapshot',evidence:await hash(invoicePayload),occurredAt:now,receivedAt:now,telegramUpdateId:uid})]);
  // Persist exactly one attempt after a final captured source admission.
  const last=await validateOwnOrderSource(env,actor,await loadOrder(env,invoicePayload),now,{allowAdmitted:true});
  await batch(db,[...assertions(db,scopeAssertions(last),now),
    assertion(db,reviewAssertion.sql,reviewAssertion.params,now),
    db.prepare("UPDATE subscription_package_invoice_requests SET state='attempted',attempted_count=1,attempted_at=?,revision=revision+1,updated_at=? WHERE request_id=? AND state='admitted' AND revision=1").bind(now,now,requestId),
    assertion(db,"EXISTS(SELECT 1 FROM subscription_package_invoice_requests WHERE request_id=? AND state='attempted' AND attempted_count=1 AND revision=2)",[requestId],now)]);
  const label=`${quote.planCode==='dragon'?'Dragon':'Professional'} · ${quote.durationDays} дней`;
  let result;
  try { result=await api(options)(env,'createInvoiceLink',{title:`RE Program ${quote.planCode==='dragon'?'Dragon':'Professional'}`,
    description:`${label}. Разовая оплата без автосписания.`,payload:invoicePayload,provider_token:'',currency:'XTR',prices:[{label,amount:quote.amountStars}]});
    if(typeof result!=='string' || !/^https:\/\/t\.me\/\$[A-Za-z0-9_-]{8,256}$/u.test(result))
      throw Object.assign(new Error('package_invoice_url_invalid'),{code:'package_invoice_url_invalid',ambiguous:true});
  } catch(error) {
    const reason=safeReason(error),uncertain=error?.ambiguous!==false;
    const updates=[db.prepare("UPDATE subscription_package_invoice_requests SET state=?,error_code=?,revision=revision+1,updated_at=? WHERE request_id=? AND state='attempted'").bind(uncertain?'unknown':'rejected',reason,now,requestId)];
    if(!uncertain)updates.push(db.prepare("UPDATE subscription_orders SET order_state='failed',closed_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=? AND order_state='created'").bind(now,now,orderId));
    await batch(db,updates);throw error;
  }
  await batch(db,[db.prepare("UPDATE subscription_package_invoice_requests SET state='confirmed',invoice_url=?,provider_result_sha256=?,revision=revision+1,updated_at=? WHERE request_id=? AND state='attempted' AND attempted_count=1").bind(result,await hash(JSON.stringify(result)),now,requestId),
    assertion(db,"EXISTS(SELECT 1 FROM subscription_package_invoice_requests WHERE request_id=? AND state='confirmed' AND attempted_count=1 AND invoice_url=?)",[requestId,result],now),
    event(db,{key:`package:${orderId}:issued`,order,type:'invoice_issued',reason:'telegram_package_invoice',evidence:await hash(invoicePayload),occurredAt:now,receivedAt:now})]);
  return Object.freeze({status:'issued',packagePayment:true,orderId,planCode:quote.planCode,packageCode:quote.packageCode,
    amountStars:quote.amountStars,accessSeconds:quote.periodSeconds,periodStartsAt:quote.quotedStartsAt,periodEndsAt:quote.quotedEndsAt,
    expiresAt,invoiceURL:result,accessApplied:false});
}

export async function handlePackagePreCheckoutQuery(env,update,options={}) {
  const query=update?.pre_checkout_query,now=clock(options.nowSeconds),uid=updateId(update?.update_id);
  if (typeof query?.id!=='string' || !query.id.length || query.id.length>256) fail('precheckout_query_id_invalid');
  const queryHash=await hash(query.id); let loaded,approved=false,reason='precheckout_approved';
  try {
    await financialObservation(env,update,options.packageFinancialContext,options.packageActor,now);
    loaded=await loadOrder(env,query.invoice_payload);
    if (query.from?.is_bot || query.from?.id!==loaded.order.telegram_id) fail('precheckout_user_mismatch');
    if (query.currency!=='XTR' || query.total_amount!==loaded.order.amount_stars) fail('precheckout_amount_mismatch');
    if (!['created','precheckout_ok'].includes(loaded.order.order_state) || loaded.order.expires_at<=now) fail('precheckout_order_expired');
    const scope=await validateOwnOrderSource(env,options.packageActor,loaded,now),db=scope.identity.db;
    const proof=scopeAssertions(scope),evidence=await hash(query.invoice_payload);
    const results=await batch(db,[...assertions(db,proof,now),
      db.prepare(`UPDATE subscription_orders SET order_state='precheckout_ok',precheckout_approved_at=COALESCE(precheckout_approved_at,?),
        state_revision=CASE WHEN order_state='created' THEN state_revision+1 ELSE state_revision END,updated_at=?
        WHERE order_id=? AND telegram_id=? AND order_state IN ('created','precheckout_ok') AND expires_at>?`)
        .bind(now,now,loaded.order.order_id,loaded.order.telegram_id,now),
      assertion(db,"EXISTS(SELECT 1 FROM subscription_orders WHERE order_id=? AND order_state='precheckout_ok' AND precheckout_approved_at IS NOT NULL AND expires_at>?)",[loaded.order.order_id,now],now),
      event(db,{key:`pkg-precheckout:${queryHash}:approved`,order:loaded.order,type:'precheckout_approved',reason:'package_snapshot_verified',evidence,occurredAt:now,receivedAt:now,telegramUpdateId:uid,ignore:true}),
      assertion(db,"EXISTS(SELECT 1 FROM payment_events WHERE event_key=? AND order_id=? AND telegram_id=? AND event_type='precheckout_approved' AND outcome='accepted' AND payload_sha256=?)",[`pkg-precheckout:${queryHash}:approved`,loaded.order.order_id,loaded.order.telegram_id,evidence],now)]);
    if (changes(results[proof.assertions.length])!==1) fail('precheckout_approval_not_durable');
    // Repeat the source read after the durable admission and before Telegram.
    await validateOwnOrderSource(env,options.packageActor,await loadOrder(env,query.invoice_payload),now);
    approved=true;
  } catch(error) { reason=safeReason(error); }
  try { await api(options)(env,'answerPreCheckoutQuery',approved?{pre_checkout_query_id:query.id,ok:true}:
    {pre_checkout_query_id:query.id,ok:false,error_message:'Не удалось безопасно проверить счёт. Stars не списаны — создайте новый.'}); }
  catch(error) { return Object.freeze({handled:true,packagePayment:true,approved,answerDelivered:false,reason:safeReason(error)}); }
  return Object.freeze({handled:true,packagePayment:true,approved,answerDelivered:true,reason,orderId:loaded?.order.order_id??null});
}

function providerPayment(update,now) {
  const message=update?.message,payment=message?.successful_payment;
  if (!payment || !positive(message.from?.id) || message.from?.is_bot || message.chat?.type!=='private' || message.chat.id!==message.from.id)
    fail('successful_payment_actor_invalid');
  if (!positive(message.date) || message.date>now || typeof payment.telegram_payment_charge_id!=='string' ||
    !payment.telegram_payment_charge_id.length || payment.telegram_payment_charge_id.length>256 || /[\u0000-\u001f\u007f]/u.test(payment.telegram_payment_charge_id))
    fail('successful_payment_receipt_invalid');
  return {payment,telegramId:message.from.id,occurredAt:message.date,telegramUpdateId:updateId(update.update_id)};
}
function validatePayment(loaded,receipt) {
  const {payment}=receipt,order=loaded.order;
  if (receipt.telegramId!==order.telegram_id || payment.currency!=='XTR' || payment.total_amount!==order.amount_stars ||
    payment.is_recurring===true || payment.is_first_recurring===true || payment.subscription_expiration_date!==undefined || receipt.occurredAt<order.created_at)
    fail('successful_payment_product_mismatch');
}
async function paymentEvidence(receipt) {
  return hash(JSON.stringify({currency:receipt.payment.currency,total_amount:receipt.payment.total_amount,
    invoice_payload_sha256:await hash(receipt.payment.invoice_payload),telegram_payment_charge_sha256:await hash(receipt.payment.telegram_payment_charge_id),
    is_recurring:false,is_first_recurring:false,subscription_expiration_date:null}));
}
async function existingPayment(env,loaded,receipt,evidence) {
  const db=database(env),payment=await db.prepare("SELECT * FROM payment_ledger WHERE telegram_payment_charge_id=? AND entry_type='payment' LIMIT 1").bind(receipt.payment.telegram_payment_charge_id).first();
  if (!payment) return null;
  if (payment.order_id!==loaded.order.order_id || payment.telegram_id!==receipt.telegramId || payment.direction!=='credit' ||
    payment.currency!=='XTR' || payment.amount_stars!==loaded.order.amount_stars) fail('payment_charge_collision');
  if (payment.reason_code==='package_payment_review_retained') {
    const retained=await db.prepare('SELECT * FROM subscription_package_payment_reviews WHERE ledger_entry_id=?').bind(payment.ledger_entry_id).first();
    if (!retained || retained.order_id!==loaded.order.order_id || retained.telegram_id!==receipt.telegramId ||
      retained.external_invoice_payload!==receipt.payment.invoice_payload || retained.evidence_sha256!==evidence) fail('payment_charge_collision');
    return Object.freeze({status:'manual_review',packagePayment:true,duplicate:true,reason:retained.reason_code,
      reviewRequired:true,orderId:loaded.order.order_id,ledgerEntryId:payment.ledger_entry_id,accessApplied:false});
  }
  if(payment.reason_code!=='successful_payment')fail('package_payment_receipt_invalid');
  const period=await db.prepare('SELECT * FROM subscription_package_periods WHERE payment_ledger_entry_id=? AND order_id=?').bind(payment.ledger_entry_id,loaded.order.order_id).first();
  if (!period || period.telegram_id!==receipt.telegramId || period.plan_code!==loaded.order.plan_code ||
    period.starts_at!==Math.max(loaded.metadata.quoted_starts_at,payment.occurred_at) || period.ends_at!==period.starts_at+loaded.order.access_seconds)
    fail('package_payment_persistence_invariant');
  const compensations=await db.prepare("SELECT ledger_entry_id FROM payment_ledger WHERE related_ledger_entry_id=? AND entry_type IN ('refund','chargeback')").bind(payment.ledger_entry_id).all();
  return Object.freeze({status:'duplicate',packagePayment:true,duplicate:true,orderId:loaded.order.order_id,ledgerEntryId:payment.ledger_entry_id,
    periodId:period.period_id,planCode:period.plan_code,amountStars:loaded.order.amount_stars,accessSeconds:period.period_seconds,
    periodStartsAt:period.starts_at,periodEndsAt:period.ends_at,accessApplied:false,compensated:Boolean(compensations.results?.length)});
}
function creditStatements(db,loaded,receipt,ledgerId,chargeHash,evidence,now,retained) {
  const order=loaded.order;
  return [db.prepare(`INSERT INTO payment_ledger(ledger_entry_id,idempotency_key,order_id,telegram_id,entry_type,direction,currency,
    amount_stars,telegram_payment_charge_id,provider_payment_charge_id,telegram_update_id,related_ledger_entry_id,reason_code,occurred_at,recorded_at)
    VALUES(?,?,?,?,'payment','credit','XTR',?,?,?,?,NULL,?,?,?)`).bind(ledgerId,`payment:${chargeHash}`,order.order_id,order.telegram_id,
      order.amount_stars,receipt.payment.telegram_payment_charge_id,String(receipt.payment.provider_payment_charge_id??'').slice(0,256),receipt.telegramUpdateId,
      retained?'package_payment_review_retained':'successful_payment',receipt.occurredAt,now),
    event(db,{key:`pkg-payment:${chargeHash}:recorded`,order,type:'payment_recorded',reason:retained?'package_payment_review_retained':'append_only_package_ledger',
      evidence,occurredAt:receipt.occurredAt,receivedAt:now,telegramUpdateId:receipt.telegramUpdateId})];
}
async function retainPayment(env,loaded,receipt,evidence,now,reason,financialProof=null,reconciliation=null) {
  const existing=await existingPayment(env,loaded,receipt,evidence); if (existing) return existing;
  const db=database(env),ledgerId=crypto.randomUUID(),chargeHash=await hash(receipt.payment.telegram_payment_charge_id);
  const reviewSchema=await inspectPackagePaymentReviewSchema(db,{required:true});
  const reviewAssertion=packagePaymentReviewSchemaAssertion(reviewSchema);
  const statements=[...(financialProof?[assertion(db,financialProof.sql,financialProof.params,now)]:[]),assertion(db,reviewAssertion.sql,reviewAssertion.params,now),db.prepare(`UPDATE subscription_orders SET order_state='failed',closed_at=?,state_revision=state_revision+1,updated_at=?
    WHERE order_id=? AND order_state IN ('created','precheckout_ok')`).bind(now,now,loaded.order.order_id),
    ...creditStatements(db,loaded,receipt,ledgerId,chargeHash,evidence,now,true),
    db.prepare(`INSERT INTO subscription_package_payment_reviews(ledger_entry_id,order_id,telegram_id,plan_code,
      external_invoice_payload,external_payload_sha256,evidence_sha256,telegram_update_id,reason_code,reconciliation_run_id,provider_page_sha256,provider_transaction_sha256,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(ledgerId,loaded.order.order_id,receipt.telegramId,loaded.order.plan_code,receipt.payment.invoice_payload,await hash(receipt.payment.invoice_payload),
        evidence,receipt.telegramUpdateId,reason,reconciliation?.runId??null,reconciliation?.providerPageSha256??null,reconciliation?.transactionSha256??null,now)];
  try { await batch(db,statements); }
  catch(error) { const replay=await existingPayment(env,loaded,receipt,evidence); if(replay)return replay; throw error; }
  const replay=await existingPayment(env,loaded,receipt,evidence);
  if(!replay) fail('package_payment_persistence_invariant');
  return Object.freeze({...replay,duplicate:false});
}

export async function recordPackageSuccessfulPayment(env,update,{packageActor,packageFinancialContext,receivedAt}={}) {
  const now=clock(receivedAt),observed=await financialObservation(env,update,packageFinancialContext,packageActor,now);
  env={...observed.identity.env,DB:observed.identity.db};
  const receipt=providerPayment(update,now),loaded=await loadOrder(env,receipt.payment.invoice_payload);
  validatePayment(loaded,receipt); const evidence=await paymentEvidence(receipt);
  const previous=await existingPayment(env,loaded,receipt,evidence); if(previous)return previous;
  let scope;
  try {
    if(loaded.order.order_state!=='precheckout_ok' || loaded.order.expires_at<=now) fail('package_payment_late_or_closed');
    scope=await validateOwnOrderSource(env,packageActor,loaded,now);
  } catch(error) { return retainPayment(env,loaded,receipt,evidence,now,safeReason(error),observed.assertion); }
  const db=scope.identity.db,ledgerId=crypto.randomUUID(),periodId=crypto.randomUUID(),chargeHash=await hash(receipt.payment.telegram_payment_charge_id);
  const start=Math.max(loaded.metadata.quoted_starts_at,receipt.occurredAt),end=start+loaded.order.access_seconds;
  const statements=[...assertions(db,scopeAssertions(scope),now),
    assertion(db,"EXISTS(SELECT 1 FROM subscription_orders WHERE order_id=? AND telegram_id=? AND order_state='precheckout_ok' AND expires_at>? AND state_revision=?)",
      [loaded.order.order_id,receipt.telegramId,now,loaded.order.state_revision],now),
    ...creditStatements(db,loaded,receipt,ledgerId,chargeHash,evidence,now,false),
    db.prepare("UPDATE subscription_orders SET order_state='paid',paid_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=? AND order_state='precheckout_ok'").bind(receipt.occurredAt,now,loaded.order.order_id),
    db.prepare(`INSERT INTO subscription_package_periods(period_id,order_id,payment_ledger_entry_id,telegram_id,plan_code,price_id,price_version,
      billing_mode,starts_at,ends_at,period_seconds,transition_id,recorded_at) VALUES(?,?,?,?,?,?,?,'prepaid',?,?,?,?,?)`)
      .bind(periodId,loaded.order.order_id,ledgerId,receipt.telegramId,loaded.order.plan_code,loaded.order.price_id,loaded.order.price_version,
        start,end,loaded.order.access_seconds,loaded.metadata.transition_id,now),
    db.prepare("UPDATE subscription_orders SET order_state='applied',applied_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=? AND order_state='paid'").bind(now,now,loaded.order.order_id),
    assertion(db,`EXISTS(SELECT 1 FROM subscription_package_periods p JOIN subscription_orders o ON o.order_id=p.order_id
      WHERE p.period_id=? AND p.payment_ledger_entry_id=? AND o.order_state='applied' AND p.starts_at=? AND p.ends_at=?)`,[periodId,ledgerId,start,end],now)];
  if(loaded.metadata.transition_id!==null) statements.splice(-1,0,
    db.prepare(`UPDATE subscription_plan_transitions SET state='fulfilled',target_order_id=?,target_period_id=?,revision=revision+1,updated_at=?
      WHERE transition_id=? AND telegram_id=? AND state='scheduled'`).bind(loaded.order.order_id,periodId,now,loaded.metadata.transition_id,receipt.telegramId),
    assertion(db,"EXISTS(SELECT 1 FROM subscription_plan_transitions WHERE transition_id=? AND state='fulfilled' AND target_period_id=?)",[loaded.metadata.transition_id,periodId],now));
  try { await batch(db,statements); }
  catch(error) {
    const replay=await existingPayment(env,loaded,receipt,evidence); if(replay)return replay;
    // Changed source/cancel/overlap is a policy race: preserve the genuine
    // charge in review. Persistence/injected failures are retried upstream.
    if (/v144_|NOT NULL constraint failed: payment_events.event_key|UNIQUE constraint failed: subscription_/u.test(String(error?.message)))
      return retainPayment(env,loaded,receipt,evidence,now,'package_atomic_source_changed',observed.assertion);
    throw error;
  }
  const persisted=await existingPayment(env,loaded,receipt,evidence);
  if(!persisted) fail('package_payment_persistence_invariant');
  return Object.freeze({...persisted,status:'recorded',duplicate:false});
}

export async function applyVerifiedPackagePaidAccess(env,{orderId,appliedAt}={}) {
  const now=clock(appliedAt),db=database(env);
  const order=await db.prepare('SELECT * FROM subscription_orders WHERE order_id=?').bind(orderId).first();
  if(!order) fail('package_order_not_found');
  const loaded=await loadOrder(env,order.invoice_payload);
  const period=await db.prepare(`SELECT pp.*,paid.telegram_payment_charge_id FROM subscription_package_periods pp
    JOIN payment_ledger paid ON paid.ledger_entry_id=pp.payment_ledger_entry_id WHERE pp.order_id=?`).bind(orderId).first();
  if(!period) fail('package_payment_review_required');
  const result=await existingPayment(env,loaded,{telegramId:order.telegram_id,payment:{telegram_payment_charge_id:period.telegram_payment_charge_id}},'');
  if(!result || result.compensated) return Object.freeze({...result,status:'compensated',accessApplied:false});
  return Object.freeze({...result,status:period.starts_at>now?'scheduled':'active',accessApplied:period.starts_at<=now && period.ends_at>now});
}

export async function readPackageRetainedReview(env,original) {
  if(original?.reason_code!=='package_payment_review_retained')return null;
  const db=database(env);await inspectPackagePaymentReviewSchema(db,{required:true});
  const row=await db.prepare('SELECT * FROM subscription_package_payment_reviews WHERE ledger_entry_id=?').bind(original.ledger_entry_id).first();
  if(!row || row.order_id!==original.order_id || row.telegram_id!==original.telegram_id)fail('package_retained_review_invalid');
  const loaded=await loadOrder(env,row.external_invoice_payload);
  if(loaded.order.order_id!==original.order_id || loaded.order.telegram_id!==original.telegram_id || row.plan_code!==loaded.order.plan_code ||
    original.entry_type!=='payment' || original.direction!=='credit' || original.currency!=='XTR' || original.amount_stars!==loaded.order.amount_stars ||
    original.related_ledger_entry_id!==null || !positive(original.occurred_at) || !positive(original.recorded_at) ||
    original.occurred_at<loaded.order.created_at || original.recorded_at>row.recorded_at ||
    row.external_payload_sha256!==await hash(row.external_invoice_payload) ||
    row.evidence_sha256!==await hash(JSON.stringify({currency:'XTR',total_amount:original.amount_stars,
      invoice_payload_sha256:row.external_payload_sha256,telegram_payment_charge_sha256:await hash(original.telegram_payment_charge_id),
      is_recurring:false,is_first_recurring:false,subscription_expiration_date:null})))fail('package_retained_review_invalid');
  const recorded=await db.prepare(`SELECT event_id FROM payment_events WHERE order_id=? AND telegram_id=? AND telegram_update_id IS ?
    AND event_type='payment_recorded' AND outcome='accepted' AND reason_code='package_payment_review_retained'
    AND payload_sha256=? AND received_at<=? LIMIT 1`).bind(row.order_id,row.telegram_id,row.telegram_update_id,row.evidence_sha256,row.recorded_at).first();
  if(!recorded)fail('package_retained_review_invalid');
  return Object.freeze({...row});
}

const reconciliationObservations=new WeakMap();
export async function capturePackageReconciliationObservation({context,runId,providerPage,transaction,observedAt}={}) {
  const now=clock(observedAt),identity=readTrustedContext(context);
  if(identity.actorKind!=='service' || identity.purpose!=='Stars_reconciliation' || now<identity.issuedAt || now>=identity.expiresAt ||
    typeof runId!=='string' || !Array.isArray(providerPage?.transactions) || providerPage.transactions.length>100)
    fail('untrusted_package_reconciliation_observation');
  const encoded=JSON.stringify(canonical(transaction)),page=JSON.stringify(canonical(providerPage));
  if(encoded.length>65536 || page.length>2000000 || !providerPage.transactions.some(row=>JSON.stringify(canonical(row))===encoded))
    fail('untrusted_package_reconciliation_observation');
  const run=await identity.db.prepare('SELECT * FROM payment_reconciliation_runs WHERE run_id=?').bind(runId).first();
  if(!run || run.status!=='running' || run.started_at>now || !['admin','scheduled','release'].includes(run.run_source))
    fail('untrusted_package_reconciliation_observation');
  const columns=Object.keys(run),runAssertion={sql:`EXISTS(SELECT 1 FROM payment_reconciliation_runs WHERE ${columns.map(key=>key+' IS ?').join(' AND ')})`,params:columns.map(key=>run[key])};
  const token=Object.freeze({version:1,kind:'package_reconciliation_observation'});
  reconciliationObservations.set(token,Object.freeze({identity,encoded,runId,providerPageSha256:await hash(page),transactionSha256:await hash(encoded),
    assertions:Object.freeze([compileContextAssertions(context),Object.freeze({...runAssertion,params:Object.freeze(runAssertion.params)})])}));return token;
}
export async function recordReconciledPackagePayment(env,transaction,timestamp,observation) {
  const now=clock(timestamp),captured=reconciliationObservations.get(observation);
  if(!captured || captured.encoded!==JSON.stringify(canonical(transaction)) || now<captured.identity.issuedAt || now>=captured.identity.expiresAt ||
    captured.identity.env.STARS_INVOICE_SECRET!==env.STARS_INVOICE_SECRET)fail('untrusted_package_reconciliation_observation');
  const compatibility=await import('../v1.4.1/telegram-legacy-compatibility.mjs');
  if(compatibility.hasLegacyCompatibilityEnv(env))env=await compatibility.bindPackageReconciliationAccountingEnv(env,observation);
  else env={...captured.identity.env,DB:captured.identity.db};
  if(transaction?.receiver || transaction.source?.type!=='user' || transaction.source?.transaction_type!=='invoice_payment' ||
    !positive(transaction.source.user?.id) || !positive(transaction.amount) || !positive(transaction.date) || transaction.date>now ||
    transaction.nanostar_amount!=null && transaction.nanostar_amount!==0 || typeof transaction.id!=='string' ||
    !transaction.id.length || transaction.id.length>256 || /[\u0000-\u001f\u007f]/u.test(transaction.id))fail('package_reconciliation_payment_invalid');
  const receipt={payment:{currency:'XTR',total_amount:transaction.amount,invoice_payload:transaction.source.invoice_payload,
    telegram_payment_charge_id:transaction.id,provider_payment_charge_id:''},telegramId:transaction.source.user.id,
    occurredAt:transaction.date,telegramUpdateId:null};
  const loaded=await loadOrder(env,receipt.payment.invoice_payload);validatePayment(loaded,receipt);const evidence=await paymentEvidence(receipt);
  const previous=await existingPayment(env,loaded,receipt,evidence);if(previous)return Object.freeze({...previous,recovered:false});
  const db=database(env),keys=captured.assertions.map((proof,i)=>({sql:proof.sql,params:proof.params}));
  // Check both captured service/run sources inside the receipt transaction.
  const financialProof={sql:keys.map(proof=>'('+proof.sql+')').join(' AND '),params:keys.flatMap(proof=>proof.params)};
  const result=await retainPayment(env,loaded,receipt,evidence,now,'package_reconciliation_missing_webhook',financialProof,captured);
  return Object.freeze({...result,recovered:!result.duplicate,reviewRequired:true,accessApplied:false});
}

export function readPackageReconciliationObservationEvidence(token) { return reconciliationObservations.get(token)??null; }
