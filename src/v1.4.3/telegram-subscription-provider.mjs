import { readTrustedContext, refreshTrustedContext, compileContextAssertions } from '../v1.4.1/trusted-context.mjs';
import { readRuntimeAuthorization, requireRuntimeAuthorization, createRuntimeAuthorizer } from '../v1.4.1/runtime-authorizer.mjs';
import { compileDecisionAssertions } from '../v1.4.1/entitlement-engine.mjs';
import { readActorFacts } from '../v1.4.1/authority-resolver.mjs';
import { readV143NativeReadinessConfig, isV143NativeOwnerCheckoutEnvelope, selectV143NativeOwnerCheckoutQuote } from './native-readiness-config.mjs';
import { readResourceFacts } from '../v1.4.1/resource-resolver.mjs';
import { authorizeOwnStarsSubscriptionCommand, readVerifiedOwnStarsSubscriptionCommand,
  compileVerifiedOwnStarsSubscriptionCommandAssertions,authorizeOwnStarsSubscriptionRecovery,
  readVerifiedOwnStarsSubscriptionRecovery,compileVerifiedOwnStarsSubscriptionRecoveryAssertions } from './subscription-action-authority.mjs';
import { buildStarsInvoicePayload, STARS_MONTH_SECONDS, STARS_ORDER_TTL_SECONDS,
  normalizeServerPrice } from '../v1.3.6/stars-core-foundation.mjs';
import { callStarsTelegram } from '../v1.3.6/stars-payment-runtime.mjs';
import { telegramCommandReason,telegramCommandDiagnosticStatement } from './telegram-command-error.mjs';
import { readStarsRecurringConfig } from './recurring-provider-config.mjs';
import { STARS_PURCHASE_LOCK_SQL } from './payment-evidence.mjs';
import { authorizeV143NativeOwnerInvoiceContext, compileV143NativeOwnerInvoiceAssertions } from './native-recovery-authority.mjs';
import { retireRefundedContractsForInvoice } from './refund-contract-lifecycle.mjs';
import { readMonthlyTransitionInvoiceAdmission, compileMonthlyTransitionInvoiceAssertions,
  retireExpiredUnchargedMonthlyReservation } from '../v1.4.4/monthly-transition-runtime.mjs';

const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const clock = () => Math.floor(Date.now() / 1000);
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(String(value)))), n => n.toString(16).padStart(2, '0')).join('');
const reason = telegramCommandReason;

function builder(db) {
  // Full128 random bits;32 hex bytes keep the cleanup LIKE pattern at49,
  // below D1's50-byte limit. Only ephemeral guard keys use this identity.
  const random = crypto.getRandomValues(new Uint8Array(16));
  const statements = [], key = 'stars_provider_' + [...random].map(value => value.toString(16).padStart(2, '0')).join('');
  return { assert(sql, params = []) {
    statements.push(db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
      VALUES(?,CASE WHEN (${sql}) THEN 1 ELSE 0 END)`).bind(key + '_' + statements.length, ...params));
  }, add(sql, params = [], minimum = 1, maximum = minimum) {
    statements.push(db.prepare(sql).bind(...params));
    statements.push(db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
      VALUES(?,CASE WHEN changes() BETWEEN ? AND ? THEN 1 ELSE 0 END)`)
      .bind(key + '_' + statements.length, minimum, maximum));
  }, finish() {
    statements.push(db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key LIKE ?').bind(key + '_%'));
    return statements;
  } };
}
async function commit(db, statements) {
  const results = await db.batch(statements);
  if (!Array.isArray(results) || results.length !== statements.length || results.some(row => row?.success !== true)) {
    fail('subscription_provider_commit_unverified', 503);
  }
  return results;
}
async function one(db, sql, params = []) {
  const result = await db.prepare(sql).bind(...params).all();
  if (result?.success !== true || !Array.isArray(result.results) || result.results.length > 1) fail('subscription_provider_read_failed', 503);
  return result.results[0] || null;
}
const apiFor = options => typeof options?.telegramApi === 'function' ? options.telegramApi
  : (env, method, payload) => callStarsTelegram(env, method, payload, { fetchImpl: options?.fetchImpl ?? globalThis.fetch });
function invoiceURL(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 't.me' &&
    !url.username && !url.password && !url.search && !url.hash && /^\/\$[A-Za-z0-9_-]+$/.test(url.pathname); } catch { return false; }
}
function invoiceDTO(row) {
  return Object.freeze({ status: row.state === 'attempted' ? 'pending' : row.state,
    requestId: row.request_id, contractId: row.contract_id, orderId: row.origin_order_id,
    billingMode: 'recurring', periodSeconds: STARS_MONTH_SECONDS,
    invoiceUrl: row.state === 'confirmed' ? row.invoice_url : null,
    reviewRequired: ['attempted', 'unknown'].includes(row.state), accessApplied: false });
}
function commandDTO(row) {
  return Object.freeze({ status: row.state === 'attempted' ? 'pending' : row.state,
    commandId: row.command_id, contractId: row.contract_id, action: row.action,
    cancellationConfirmed: row.state === 'confirmed' && row.action === 'cancel_renewal',
    reenableAllowed: row.state === 'confirmed' && row.action === 'reenable_renewal',
    providerState: null, paidPeriodChanged: false, accessApplied: false,
    reviewRequired: ['attempted', 'unknown'].includes(row.state) });
}
function invoiceIdentity(authorization) {
  const bundle = readRuntimeAuthorization(requireRuntimeAuthorization(authorization));
  const identity = readTrustedContext(bundle.context), payload = identity.requestPayload;
  const config = readStarsRecurringConfig(identity.env);
  if (identity.actorKind !== 'customer' || identity.operation !== 'billing.purchase_monthly' ||
      identity.channel !== 'mini_app' || !identity.verifiedSessionId ||
      identity.transportBinding?.kind !== 'http' || identity.transportBinding.actor !== identity.telegramId ||
      !/^[a-f0-9]{64}$/.test(identity.operationId || '') || !/^[a-f0-9]{64}$/.test(identity.payloadHash || '') ||
      !config.ready || !payload || Object.keys(payload).length !== 6 || payload.action !== 'accept' ||
      payload.billingMode !== 'recurring' || payload.recurringConsent !== true ||
      payload.termsRevision !== config.termsRevision || payload.priceVersion !== config.priceVersion ||
      !['professional', 'dragon'].includes(payload.requestedPlanCode)) fail('recurring_invoice_authority_required', 403);
  const canonical = readResourceFacts(bundle.resource).canonical;
  const quote = canonical.serverPrice;
  const price = normalizeServerPrice({ price_id:quote?.priceId,price_version:quote?.priceVersion,
    plan_code:quote?.planCode,currency:quote?.currency,amount_stars:quote?.amountStars,
    access_seconds:quote?.accessSeconds,billing_mode:quote?.billingMode,
    publication_state:quote?.publicationState,terms_revision:quote?.termsRevision,
    valid_from:quote?.validFrom,valid_until:quote?.validUntil });
  if (price.billingMode !== 'recurring' || price.planCode !== payload.requestedPlanCode ||
      price.termsRevision !== config.termsRevision || price.priceVersion !== config.priceVersion ||
      price.publicationState !== 'approved' || price.accessSeconds !== STARS_MONTH_SECONDS) fail('recurring_invoice_price_unverified', 403);
  // The owner acceptance recipe narrows the existing financial authority.
  // Replayed requests and every fresh preflight pass through this same check.
  if (readV143NativeReadinessConfig()?.mode === 'owner_acceptance') {
    const frame = selectV143NativeOwnerCheckoutQuote(price), actor = readActorFacts(bundle.actor);
    if (!isV143NativeOwnerCheckoutEnvelope(identity.env) || !frame || identity.telegramId !== frame.ownerId ||
        !actor.canonicalOwner || payload.requestedPlanCode !== frame.planCode ||
        price.planCode !== frame.planCode || price.currency !== frame.currency ||
        price.amountStars !== frame.amountStars || price.accessSeconds !== frame.periodSeconds ||
        price.priceVersion !== frame.priceVersion || price.termsRevision !== frame.termsRevision)
      fail('native_owner_invoice_authority_required', 403);
  }
  return { bundle, identity, price, config, acceptance:canonical.starsTermsAcceptance,
    key: 'stars-invoice:' + identity.operationId };
}
async function addInvoiceAssertions(batch, scope, authorization, monthlyAdmission) {
  for (const piece of compileDecisionAssertions(scope.bundle.decision).assertions) batch.assert(piece.sql, piece.params);
  for (const piece of (await compileMonthlyTransitionInvoiceAssertions(monthlyAdmission, authorization)).assertions)
    batch.assert(piece.sql, piece.params);
  if (readV143NativeReadinessConfig()?.mode === 'owner_acceptance') {
    const token = await authorizeV143NativeOwnerInvoiceContext(authorization);
    for (const piece of compileV143NativeOwnerInvoiceAssertions(token, authorization).assertions)
      batch.assert(piece.sql, piece.params);
  }
}
async function freshInvoice(authorization) {
  const context = await refreshTrustedContext(readRuntimeAuthorization(authorization).context);
  return createRuntimeAuthorizer().authorize(context, null);
}
function verifyInvoiceReplay(row, scope) {
  if (row.telegram_id !== scope.identity.telegramId || row.idempotency_key !== scope.key ||
      row.request_sha256 !== scope.identity.payloadHash) fail('recurring_invoice_idempotency_collision');
}
async function invoiceRow(db, key) {
  return one(db, 'SELECT * FROM subscription_invoice_requests WHERE idempotency_key=?', [key]);
}
async function invoiceReplay(row,authorization,{refresh=false,monthlyAdmission}={}) {
  if(refresh)authorization=await freshInvoice(authorization);
  const scope=invoiceIdentity(authorization),b=builder(scope.identity.db);
  verifyInvoiceReplay(row,scope);
  await addInvoiceAssertions(b, scope, authorization, monthlyAdmission);
  await commit(scope.identity.db,b.finish());
  return invoiceDTO(row);
}
async function settleInvoice(db, row, state, { url = null, resultHash = null, errorCode = '' } = {}) {
  const b = builder(db), at = clock();
  b.add(`UPDATE subscription_invoice_requests SET state=?,invoice_url=?,provider_result_sha256=?,
    error_code=?,revision=revision+1,updated_at=MAX(updated_at,?)
    WHERE request_id=? AND telegram_id=? AND state='attempted' AND attempted_count=1`,
  [state, url, resultHash, errorCode, at, row.request_id, row.telegram_id]);
  if (state === 'rejected') b.add(`UPDATE subscription_orders SET order_state='failed',closed_at=COALESCE(closed_at,?),
    state_revision=state_revision+1,updated_at=MAX(updated_at,?) WHERE order_id=? AND telegram_id=? AND order_state='created'`,
  [at, at, row.origin_order_id, row.telegram_id], 0, 1);
  await commit(db, b.finish());
}

// Only a genuine existing RuntimeAuthorization with the captured recurring
// quote reaches this producer. No request body supplies an actor, price or DB.
export async function issueStarsRecurringInvoice(authorization, options = {}) {
  let scope = invoiceIdentity(authorization);
  const monthlyAdmission=options.monthlyTransitionAdmission;
  const reservation=readMonthlyTransitionInvoiceAdmission(monthlyAdmission,authorization);
  const { identity } = scope, db = identity.db;
  let row = await invoiceRow(db, scope.key);
  if(row&&reservation&&row.origin_order_id!==reservation.orderId)fail('monthly_transition_invoice_idempotency_collision');
  if (row) { verifyInvoiceReplay(row, scope); if (row.state !== 'admitted') return invoiceReplay(row,authorization,{monthlyAdmission}); }
  const monthlyRetired=!row&&await retireExpiredUnchargedMonthlyReservation(authorization);
  if(monthlyRetired){
    authorization=await freshInvoice(authorization);scope=invoiceIdentity(authorization);
  }
  // Bounded owner acceptance never retires historical refunded contracts.
  // Existing contracts remain subject to the normal purchase lock and review.
  if (!row && !monthlyRetired && readV143NativeReadinessConfig()?.mode !== 'owner_acceptance' &&
      await retireRefundedContractsForInvoice(authorization)) {
    authorization = await freshInvoice(authorization); scope = invoiceIdentity(authorization);
  }
  if (!row) {
    const at = clock(), requestId = crypto.randomUUID(), orderId = reservation?.orderId ?? crypto.randomUUID(), contractId = crypto.randomUUID();
    const acceptanceId = scope.acceptance?.acceptanceId ??
      'recurring:' + await hash(identity.telegramId + '\n' + scope.config.termsRevision);
    const externalPayload = reservation?.invoicePayload ?? await buildStarsInvoicePayload({ invoiceSecret: identity.env.STARS_INVOICE_SECRET,
      orderId, telegramId: identity.telegramId, priceId: scope.price.priceId });
    const payloadHash = await hash(externalPayload), b = builder(db);
    await addInvoiceAssertions(b, scope, authorization, monthlyAdmission);
    b.assert(`NOT EXISTS(SELECT 1 FROM subscription_billing_contracts WHERE telegram_id=? AND retired_at IS NULL)`,
    [identity.telegramId]);
    b.assert(`NOT EXISTS(SELECT 1 FROM subscription_orders WHERE telegram_id=? AND order_id!=? AND ${STARS_PURCHASE_LOCK_SQL})`,
    [identity.telegramId,reservation?.orderId ?? '',at]);
    b.add(`UPDATE subscription_orders SET order_state='cancelled',closed_at=COALESCE(closed_at,?),
      state_revision=state_revision+1,updated_at=MAX(updated_at,?)
      WHERE telegram_id=? AND order_state IN ('created','precheckout_ok') AND expires_at<=?`,
    [at,at,identity.telegramId,at],0,1);
    b.add(`INSERT OR IGNORE INTO terms_acceptances(acceptance_id,telegram_id,terms_revision,acceptance_scope,
      evidence_sha256,telegram_update_id,accepted_at) VALUES(?,?,?,'stars_purchase',?,NULL,?)`,
    [acceptanceId, identity.telegramId, scope.config.termsRevision, identity.payloadHash, at], 0, 1);
    if(!reservation)b.add(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,currency,
      amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,expires_at,updated_at)
      VALUES(?,?,?,?,?,'XTR',?,2592000,'recurring',?,?,'created',?,?,?)`,
    [orderId, identity.telegramId, scope.price.priceId, scope.price.priceVersion, scope.price.planCode,
      scope.price.amountStars, scope.config.termsRevision, externalPayload, at, at + STARS_ORDER_TTL_SECONDS, at]);
    b.add(`INSERT INTO subscription_billing_contracts(contract_id,telegram_id,plan_code,price_id,origin_order_id,
      external_invoice_payload,external_payload_sha256,terms_revision,terms_acceptance_id,billing_mode,
      period_seconds,currency,amount_stars,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'recurring',2592000,'XTR',?,?,?)`,
    [contractId, identity.telegramId, scope.price.planCode, scope.price.priceId, orderId, externalPayload,
      payloadHash, scope.config.termsRevision, acceptanceId, scope.price.amountStars, at, at]);
    for (const type of ['consent_recorded', 'contract_created']) b.add(`INSERT INTO subscription_provider_events
      (event_id,event_key,contract_id,telegram_id,event_type,source,actor_type,actor_id,reason_code,evidence_sha256,received_at)
      VALUES(?,?,?, ?,?,'user','user',?,'explicit_recurring_consent',?,?)`,
    [crypto.randomUUID(), 'invoice:' + requestId + ':' + type, contractId, identity.telegramId,
      type, identity.telegramId, identity.payloadHash, at]);
    b.add(`INSERT INTO subscription_invoice_requests(request_id,idempotency_key,contract_id,origin_order_id,
      telegram_id,expected_contract_revision,request_sha256,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?)`,
    [requestId, scope.key, contractId, orderId, identity.telegramId, identity.payloadHash, at, at]);
    try { await commit(db, b.finish()); } catch (error) {
      const winner = await invoiceRow(db, scope.key);
      if (!winner) throw error; verifyInvoiceReplay(winner, scope);
    }
    row = await invoiceRow(db, scope.key);
    if (!row) fail('recurring_invoice_admission_unverified', 503);
    verifyInvoiceReplay(row, scope);
    if (row.state !== 'admitted') return invoiceReplay(row,authorization,{refresh:true,monthlyAdmission});
  }
  authorization = await freshInvoice(authorization); scope = invoiceIdentity(authorization);
  const attempt = builder(db);
  await addInvoiceAssertions(attempt, scope, authorization, monthlyAdmission);
  attempt.add(`UPDATE subscription_invoice_requests SET state='attempted',attempted_count=1,attempted_at=?,
    revision=revision+1,updated_at=MAX(updated_at,?) WHERE request_id=? AND telegram_id=? AND state='admitted' AND attempted_count=0`,
  [clock(), clock(), row.request_id, identity.telegramId]);
  try { await commit(db, attempt.finish()); } catch (error) {
    const winner = await invoiceRow(db, scope.key);
    if (winner && winner.state !== 'admitted') return invoiceReplay(winner,authorization,{refresh:true,monthlyAdmission});
    throw error;
  }
  row = await invoiceRow(db, scope.key);
  try {
    authorization = await freshInvoice(authorization); scope = invoiceIdentity(authorization);
    const preflight = builder(db);
    await addInvoiceAssertions(preflight, scope, authorization, monthlyAdmission);
    preflight.assert(`EXISTS(SELECT 1 FROM subscription_invoice_requests WHERE request_id=? AND telegram_id=?
      AND state='attempted' AND attempted_count=1 AND request_sha256=?)`,
    [row.request_id, identity.telegramId, identity.payloadHash]);
    await commit(db, preflight.finish());
    const result = await apiFor(options)(identity.env, 'createInvoiceLink', {
      title: scope.price.planCode === 'dragon' ? 'Dragon — ежемесячная подписка' : 'Professional — подписка',
      description: `Регулярная оплата ${scope.price.amountStars} Telegram Stars каждые 30 дней. Оплаченный остаток сохраняется после отмены продления.`,
      payload: (await one(db, 'SELECT invoice_payload FROM subscription_orders WHERE order_id=?', [row.origin_order_id])).invoice_payload,
      provider_token: '', currency: 'XTR', prices: [{ label: '30 дней подписки', amount: scope.price.amountStars }],
      subscription_period: STARS_MONTH_SECONDS,
    });
    if (!invoiceURL(result)) fail('telegram_invoice_response_invalid');
    await settleInvoice(db, row, 'confirmed', { url: result, resultHash: await hash(result) });
  } catch (error) {
    const current = await invoiceRow(db, scope.key);
    if (current?.state === 'confirmed') return invoiceDTO(current);
    try { await settleInvoice(db, row, error?.ambiguous === false ? 'rejected' : 'unknown', { errorCode: reason(error) }); } catch {}
  }
  return invoiceDTO(await invoiceRow(db, scope.key));
}

async function freshCommand(token) {
  const context = await refreshTrustedContext(readVerifiedOwnStarsSubscriptionCommand(token).context);
  const authorization = await createRuntimeAuthorizer().authorize(context, null);
  return authorizeOwnStarsSubscriptionCommand(authorization);
}
async function freshRecovery(token) {
  const context = await refreshTrustedContext(readVerifiedOwnStarsSubscriptionRecovery(token).context);
  return authorizeOwnStarsSubscriptionRecovery(await createRuntimeAuthorizer().authorize(context,null));
}
const commandKey = scope => 'stars-command:' + scope.operationId;
async function commandRow(db, key) { return one(db, 'SELECT * FROM subscription_provider_commands WHERE idempotency_key=?', [key]); }
async function commandReplay(row,token,{refresh=false}={}) {
  if(refresh)token=await freshCommand(token);
  const scope=readVerifiedOwnStarsSubscriptionCommand(token),identity=readTrustedContext(scope.context),b=builder(identity.db);
  verifyCommandReplay(row,scope);
  for(const piece of compileVerifiedOwnStarsSubscriptionCommandAssertions(token).assertions)b.assert(piece.sql,piece.params);
  await commit(identity.db,b.finish());
  return commandDTO(row);
}
function verifyCommandReplay(row, scope) {
  const identity = readTrustedContext(scope.context);
  if (row.telegram_id !== identity.telegramId || row.contract_id !== scope.contract.contract_id ||
      row.action !== scope.action || row.expected_contract_revision !== scope.expectedRevision ||
      row.first_payment_ledger_entry_id !== scope.firstPayment.ledger_entry_id ||
      row.request_sha256 !== identity.payloadHash) fail('subscription_command_idempotency_collision');
}
async function settleCommand(db, row, state, errorCode = '', error = null) {
  const b = builder(db), at = clock(), eventId = crypto.randomUUID();
  const type = state === 'confirmed' ? 'command_confirmed' : state === 'rejected' ? 'command_rejected' : 'command_unknown';
  b.add(`INSERT INTO subscription_provider_events(event_id,event_key,contract_id,command_id,telegram_id,
    event_type,source,actor_type,reason_code,evidence_sha256,received_at)
    VALUES(?,?,?,?,?,?,?,'system',?,?,?)`, [eventId, 'command:' + row.command_id + ':' + state,
    row.contract_id, row.command_id, row.telegram_id, type, state === 'unknown' ? 'system' : 'provider_response',
    errorCode || 'telegram_command_acknowledged', await hash(JSON.stringify([row.command_id,row.action,state,errorCode])), at]);
  b.add(`UPDATE subscription_provider_commands SET state=?,acknowledgement_event_id=?,error_code=?,
    revision=revision+1,updated_at=MAX(updated_at,?) WHERE command_id=? AND telegram_id=?
    AND state='attempted' AND attempted_count=1`, [state, state === 'confirmed' ? eventId : null,
    errorCode, at, row.command_id, row.telegram_id]);
  const diagnostic=telegramCommandDiagnosticStatement(db,row,error);
  await commit(db,[...b.finish(),...(diagnostic?[diagnostic]:[])]);
}

// A monotonic contract revision is a durable admission barrier for an absent
// old intent. Recheck the verified principal, exact contract and absent key in
// one atomic batch; do not invent an attempt or a financial effect receipt.
export async function resolveSupersededOwnStarsSubscriptionCommand(authorization) {
  const bundle=readRuntimeAuthorization(requireRuntimeAuthorization(authorization)),
    identity=readTrustedContext(bundle.context),payload=identity.requestPayload;
  if(identity.actorKind!=='customer'||identity.operation!=='access.read_own'||identity.channel!=='mini_app'||
      !identity.verifiedSessionId||identity.transportBinding?.kind!=='http'||identity.transportBinding.actor!==identity.telegramId||
      !/^[a-f0-9]{64}$/u.test(identity.operationId??'')||!payload||Object.keys(payload).length!==3||
      !['cancel_renewal','reenable_renewal'].includes(payload.subscriptionAction)||
      typeof payload.contractId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/u.test(payload.contractId)||
      !Number.isSafeInteger(payload.expectedRevision)||payload.expectedRevision<=0)
    fail('subscription_recovery_principal_invalid',403);
  const key='stars-command:'+identity.operationId,db=identity.db;
  const contract=await one(db,'SELECT contract_id,telegram_id,revision FROM subscription_billing_contracts WHERE contract_id=? AND telegram_id=?',
    [payload.contractId,identity.telegramId]);
  if(!contract)fail('subscription_contract_unavailable');
  if(contract.revision<=payload.expectedRevision||await commandRow(db,key))return null;
  const b=builder(db);
  for(const piece of compileDecisionAssertions(bundle.decision).assertions)b.assert(piece.sql,piece.params);
  b.assert('EXISTS(SELECT 1 FROM subscription_billing_contracts WHERE contract_id=? AND telegram_id=? AND revision=? AND revision>?)',
    [payload.contractId,identity.telegramId,contract.revision,payload.expectedRevision]);
  b.assert('NOT EXISTS(SELECT 1 FROM subscription_provider_commands WHERE idempotency_key=?)',[key]);
  await commit(db,b.finish());
  return Object.freeze({authority:'worker',kind:payload.subscriptionAction==='cancel_renewal'?'cancel':'enable',
    state:'rejected',resolution:'superseded_before_admission',attemptId:null,contractId:payload.contractId,
    invoiceUrl:null,effectRecorded:false,accessApplied:false,reviewRequired:false,actionAdmissionRequired:true});
}

// An explicit user recovery rejects only a never-attempted original intent.
// The same durable key fences a delayed producer; no provider call is made.
export async function abandonOwnStarsSubscriptionCommandBeforeAttempt(token) {
  token=await freshRecovery(token);
  const scope=readVerifiedOwnStarsSubscriptionRecovery(token),identity=readTrustedContext(scope.context),
    db=identity.db,key=commandKey(scope);
  let row=await commandRow(db,key);
  if(row){verifyCommandReplay(row,scope);if(row.state!=='admitted')return commandDTO(row);}
  const b=builder(db),at=clock(),commandId=row?.command_id??crypto.randomUUID(),reasonCode='user_abandoned_before_provider_attempt';
  for(const piece of compileVerifiedOwnStarsSubscriptionRecoveryAssertions(token).assertions)b.assert(piece.sql,piece.params);
  if(!row)b.add(`INSERT INTO subscription_provider_commands(command_id,idempotency_key,contract_id,telegram_id,
    action,desired_auto_renew,expected_contract_revision,first_payment_ledger_entry_id,request_sha256,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[commandId,key,scope.contract.contract_id,identity.telegramId,scope.action,
    scope.action==='cancel_renewal'?0:1,scope.expectedRevision,scope.firstPayment.ledger_entry_id,identity.payloadHash,at,at]);
  b.add(`UPDATE subscription_provider_commands SET state='rejected',error_code=?,revision=revision+1,updated_at=MAX(updated_at,?)
    WHERE command_id=? AND telegram_id=? AND state='admitted' AND attempted_count=0 AND attempted_at IS NULL`,
    [reasonCode,at,commandId,identity.telegramId]);
  b.add(`INSERT INTO subscription_provider_events(event_id,event_key,contract_id,command_id,telegram_id,
    event_type,source,actor_type,actor_id,reason_code,evidence_sha256,received_at)
    VALUES(?,?,?,?,?,'command_rejected','user','user',?,?,?,?)`,[crypto.randomUUID(),'command:'+commandId+':abandoned',
    scope.contract.contract_id,commandId,identity.telegramId,identity.telegramId,reasonCode,identity.payloadHash,at]);
  try{await commit(db,b.finish());}catch(error){
    const winner=await commandRow(db,key);
    if(!winner||winner.state==='admitted')throw error;
    verifyCommandReplay(winner,scope);return commandDTO(winner);
  }
  row=await commandRow(db,key);
  if(!row)fail('subscription_command_abandonment_unverified',503);
  verifyCommandReplay(row,scope);return commandDTO(row);
}

const RECONFIRM_ACTION='subscription_cancel_reconfirmation';
function reconfirmPrincipal(originalContext,authorization){
  const input=readRuntimeAuthorization(requireRuntimeAuthorization(authorization)),
    original=readTrustedContext(originalContext),current=readTrustedContext(input.context),actor=readActorFacts(input.actor);
  const payload=current.requestPayload,key=value=>typeof value==='string'&&/^[a-f0-9]{48}$/u.test(value);
  if(!actor.canonicalOwner||original.actorKind!=='customer'||current.actorKind!=='customer'||
      original.channel!=='mini_app'||current.channel!=='mini_app'||original.operation!=='access.read_own'||current.operation!=='access.read_own'||
      original.db!==current.db||original.telegramId!==current.telegramId||original.botId!==current.botId||
      !original.verifiedSessionId||original.verifiedSessionId!==current.verifiedSessionId||
      original.transportBinding?.kind!=='http'||current.transportBinding?.kind!=='http'||
      original.transportBinding.actor!==current.telegramId||current.transportBinding.actor!==current.telegramId||
      !key(original.transportBinding.idempotencyKey)||!key(current.transportBinding.idempotencyKey)||
      original.transportBinding.idempotencyKey===current.transportBinding.idempotencyKey||
      !payload||Object.keys(payload).length!==3||payload.subscriptionAction!=='cancel_renewal'||
      typeof payload.contractId!=='string'||!Number.isSafeInteger(payload.expectedRevision)||payload.expectedRevision<1||
      JSON.stringify(original.requestPayload)!==JSON.stringify(payload)||original.payloadHash!==current.payloadHash||
      !/^[a-f0-9]{64}$/u.test(original.operationId??'')||!/^[a-f0-9]{64}$/u.test(current.operationId??''))
    fail('subscription_reconfirmation_principal_invalid',403);
  return {input,original,current,payload};
}
const reconfirmState=state=>state==='attempted'?'pending':state;
function reconfirmDTO(principal,old,row){
  return Object.freeze({authority:'worker',kind:'cancel',state:row?reconfirmState(row.state):'missing',
    originalAttemptId:old.command_id,attemptId:row?.command_id??null,contractId:old.contract_id,
    expectedRevision:old.expected_contract_revision,originalState:reconfirmState(old.state),accessApplied:false,financialCalls:0});
}

// Two exact-key reads with the current authenticated session/release fences.
// The retained original outcome is never inferred from a replacement's state.
export async function readOwnCancelReconfirmation({originalContext,authorization}={}){
  const principal=reconfirmPrincipal(originalContext,authorization),{original,current,payload}=principal,
    oldFence=compileContextAssertions(originalContext),newFence=compileContextAssertions(principal.input.context),
    columns='command_id,contract_id,telegram_id,action,desired_auto_renew,expected_contract_revision,first_payment_ledger_entry_id,request_sha256,state,attempted_count,attempted_at';
  const old=await one(current.db,`SELECT ${columns} FROM subscription_provider_commands
    WHERE idempotency_key=? AND telegram_id=? AND (${oldFence.sql})`,['stars-command:'+original.operationId,current.telegramId,...oldFence.params]);
  if(!old)fail('subscription_reconfirmation_original_missing',409);
  if(old.contract_id!==payload.contractId||old.expected_contract_revision!==payload.expectedRevision||old.action!=='cancel_renewal'||
      old.desired_auto_renew!==0||old.request_sha256!==original.payloadHash||old.attempted_count!==1||!Number.isSafeInteger(old.attempted_at))
    fail('subscription_reconfirmation_original_invalid',409);
  const row=await one(current.db,`SELECT q.*,a.details AS handoff_details FROM subscription_provider_commands q
    LEFT JOIN admin_audit_log a ON a.actor_id=q.telegram_id AND a.action=?
      AND a.entity_type='subscription_provider_command' AND a.entity_id=q.command_id
    WHERE q.idempotency_key=? AND q.telegram_id=? AND (${newFence.sql})`,
    [RECONFIRM_ACTION,'stars-command:'+current.operationId,current.telegramId,...newFence.params]);
  if(!row){
    if(!['attempted','unknown','confirmed','rejected'].includes(old.state))fail('subscription_reconfirmation_link_missing',409);
    return reconfirmDTO(principal,old,null);
  }
  let link;try{link=JSON.parse(row.handoff_details);}catch{fail('subscription_reconfirmation_link_invalid',409);}
  if(!link||link.version!==1||link.kind!=='cancel'||link.actorId!==current.telegramId||link.botId!==current.botId||
      link.originalAttemptId!==old.command_id||link.attemptId!==row.command_id||link.contractId!==payload.contractId||
      link.expectedRevision!==payload.expectedRevision||link.originalOperationId!==original.operationId||link.newOperationId!==current.operationId||
      link.requestSha256!==current.payloadHash||old.state!=='superseded'||row.contract_id!==old.contract_id||
      row.action!=='cancel_renewal'||row.desired_auto_renew!==0||row.expected_contract_revision!==old.expected_contract_revision||
      row.first_payment_ledger_entry_id!==old.first_payment_ledger_entry_id||row.request_sha256!==current.payloadHash||
      !['admitted','attempted','confirmed','rejected','unknown'].includes(row.state))fail('subscription_reconfirmation_link_invalid',409);
  return reconfirmDTO(principal,old,row);
}

// Explicit owner consent reserves a NEW cancellation. It does not resend the
// old effect or call Telegram; a later normal POST must use this reserved key.
export async function prepareOwnCancelReconfirmation({originalRecovery,authorization}={}){
  const scope=readVerifiedOwnStarsSubscriptionRecovery(originalRecovery),principal=reconfirmPrincipal(scope.context,authorization),
    {current,payload}=principal,db=current.db,observed=await readOwnCancelReconfirmation({originalContext:scope.context,authorization});
  if(observed.state!=='missing')return observed;
  const old=await commandRow(db,commandKey(scope)),at=clock();verifyCommandReplay(old,scope);
  if(scope.action!=='cancel_renewal'||scope.contract.retired_at!==null||scope.contract.revision!==payload.expectedRevision||
      !['attempted','unknown'].includes(old.state)||old.attempted_count!==1||!Number.isSafeInteger(old.attempted_at)||
      at-old.attempted_at<300)fail('subscription_reconfirmation_not_ready',409);
  const newKey='stars-command:'+current.operationId,newId=crypto.randomUUID(),link={version:1,kind:'cancel',
    actorId:current.telegramId,botId:current.botId,originalAttemptId:old.command_id,attemptId:newId,contractId:old.contract_id,
    expectedRevision:old.expected_contract_revision,originalOperationId:scope.operationId,newOperationId:current.operationId,
    requestSha256:current.payloadHash},evidence=await hash(JSON.stringify(link)),b=builder(db),unique=new Map();
  for(const piece of [...compileVerifiedOwnStarsSubscriptionRecoveryAssertions(originalRecovery).assertions,
      ...compileDecisionAssertions(principal.input.decision).assertions])unique.set(JSON.stringify([piece.sql,piece.params]),piece);
  for(const piece of unique.values())b.assert(piece.sql,piece.params);
  b.assert(`EXISTS(SELECT 1 FROM subscription_provider_commands WHERE command_id=? AND telegram_id=?
    AND state=? AND attempted_count=1 AND attempted_at=? AND attempted_at<=unixepoch()-300)
    AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands WHERE idempotency_key=?)
    AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands WHERE contract_id=? AND command_id!=? AND state IN ('admitted','attempted','unknown'))`,
    [old.command_id,current.telegramId,old.state,old.attempted_at,newKey,old.contract_id,old.command_id]);
  if(old.state==='attempted')b.add(`UPDATE subscription_provider_commands SET state='unknown',error_code='user_retained_cancel_outcome_unknown',
    revision=revision+1,updated_at=MAX(updated_at,?) WHERE command_id=? AND telegram_id=? AND state='attempted' AND attempted_count=1`,
    [at,old.command_id,current.telegramId]);
  b.add(`INSERT INTO subscription_provider_events(event_id,event_key,contract_id,command_id,telegram_id,event_type,source,actor_type,actor_id,reason_code,evidence_sha256,received_at)
    VALUES(?,?,?,?,?,'command_unknown','user','user',?,'user_retained_cancel_outcome_unknown',?,?)`,
    [crypto.randomUUID(),'command:'+old.command_id+':reconfirm:'+current.operationId,old.contract_id,old.command_id,current.telegramId,current.telegramId,evidence,at]);
  b.add(`UPDATE subscription_provider_commands SET state='superseded',error_code='user_retained_cancel_outcome_unknown',
    revision=revision+1,updated_at=MAX(updated_at,?) WHERE command_id=? AND telegram_id=? AND state='unknown' AND attempted_count=1`,
    [at,old.command_id,current.telegramId]);
  b.add(`INSERT INTO subscription_provider_commands(command_id,idempotency_key,contract_id,telegram_id,action,desired_auto_renew,
    expected_contract_revision,first_payment_ledger_entry_id,request_sha256,created_at,updated_at)
    VALUES(?,?,?,?,'cancel_renewal',0,?,?,?,?,?)`,[newId,newKey,old.contract_id,current.telegramId,old.expected_contract_revision,
    old.first_payment_ledger_entry_id,current.payloadHash,at,at]);
  b.add(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,details) VALUES(?,?,'subscription_provider_command',?,?)`,
    [current.telegramId,RECONFIRM_ACTION,newId,JSON.stringify(link)]);
  try{await commit(db,b.finish());}catch(error){
    const winner=await readOwnCancelReconfirmation({originalContext:scope.context,authorization});
    if(winner.state!=='missing')return winner;throw error;
  }
  return readOwnCancelReconfirmation({originalContext:scope.context,authorization});
}

// A principal-only access bundle is insufficient. The existing own authority
// mints this private, captured contract/first-charge/effect admission token.
export async function requestOwnStarsSubscriptionCommand(token, options = {}) {
  let scope = readVerifiedOwnStarsSubscriptionCommand(token);
  const identity = readTrustedContext(scope.context), db = identity.db, key = commandKey(scope);
  let row = await commandRow(db, key);
  if (row) { verifyCommandReplay(row, scope); if (row.state !== 'admitted') return commandReplay(row,token,{refresh:true}); }
  if (!row) {
    const b = builder(db), commandId = crypto.randomUUID(), at = clock();
    for (const piece of compileVerifiedOwnStarsSubscriptionCommandAssertions(token).assertions) b.assert(piece.sql, piece.params);
    b.add(`INSERT INTO subscription_provider_commands(command_id,idempotency_key,contract_id,telegram_id,
      action,desired_auto_renew,expected_contract_revision,first_payment_ledger_entry_id,request_sha256,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [commandId, key, scope.contract.contract_id, identity.telegramId,
      scope.action, scope.action === 'cancel_renewal' ? 0 : 1, scope.expectedRevision,
      scope.firstPayment.ledger_entry_id, identity.payloadHash, at, at]);
    try { await commit(db, b.finish()); } catch (error) {
      const winner = await commandRow(db, key); if (!winner) throw error; verifyCommandReplay(winner, scope);
    }
    row = await commandRow(db, key);
    if (!row) fail('subscription_command_admission_unverified', 503);
    if (row.state !== 'admitted') return commandReplay(row,token,{refresh:true});
  }
  token = await freshCommand(token); scope = readVerifiedOwnStarsSubscriptionCommand(token);
  const attempt = builder(db);
  for (const piece of compileVerifiedOwnStarsSubscriptionCommandAssertions(token).assertions) attempt.assert(piece.sql, piece.params);
  attempt.add(`UPDATE subscription_provider_commands SET state='attempted',attempted_count=1,attempted_at=?,
    revision=revision+1,updated_at=MAX(updated_at,?) WHERE command_id=? AND telegram_id=? AND state='admitted' AND attempted_count=0`,
  [clock(), clock(), row.command_id, identity.telegramId]);
  try { await commit(db, attempt.finish()); } catch (error) {
    const winner = await commandRow(db, key); if (winner && winner.state !== 'admitted') return commandReplay(winner,token,{refresh:true}); throw error;
  }
  row = await commandRow(db, key);
  try {
    token = await freshCommand(token); scope = readVerifiedOwnStarsSubscriptionCommand(token);
    const preflight = builder(db);
    for (const piece of compileVerifiedOwnStarsSubscriptionCommandAssertions(token).assertions) preflight.assert(piece.sql, piece.params);
    preflight.assert(`EXISTS(SELECT 1 FROM subscription_provider_commands WHERE command_id=? AND telegram_id=?
      AND state='attempted' AND attempted_count=1 AND first_payment_ledger_entry_id=?)`,
    [row.command_id,identity.telegramId,scope.firstPayment.ledger_entry_id]);
    preflight.assert(`EXISTS(SELECT 1 FROM subscription_billing_contracts WHERE contract_id=? AND telegram_id=?
      AND revision=? AND retired_at IS NULL AND first_payment_ledger_entry_id=?)`,
    [scope.contract.contract_id,identity.telegramId,scope.expectedRevision,scope.firstPayment.ledger_entry_id]);
    await commit(db,preflight.finish());
    const result = await apiFor(options)(identity.env,'editUserStarSubscription', {
      user_id: identity.telegramId, telegram_payment_charge_id: scope.firstPayment.telegram_payment_charge_id,
      is_canceled: scope.action === 'cancel_renewal',
    });
    if (result !== true) fail('telegram_subscription_response_invalid');
    await settleCommand(db,row,'confirmed');
  } catch (error) {
    const current = await commandRow(db,key);
    if (current?.state === 'confirmed') return commandDTO(current);
    try { await settleCommand(db,row,error?.ambiguous === false ? 'rejected' : 'unknown',reason(error),error); } catch {}
  }
  return commandDTO(await commandRow(db,key));
}
