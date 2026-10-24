import { readRuntimeAuthorization, requireRuntimeAuthorization } from '../v1.4.1/runtime-authorizer.mjs';
import { readTrustedContext } from '../v1.4.1/trusted-context.mjs';
import { readActorFacts, readLifecycleActorFacts } from '../v1.4.1/authority-resolver.mjs';
import { readResourceFacts } from '../v1.4.1/resource-resolver.mjs';
import { compileDecisionAssertions } from '../v1.4.1/entitlement-engine.mjs';
import { readVerifiedLifecycleFacts } from './lifecycle-authority.mjs';
import { readStarsRecurringConfig } from './recurring-provider-config.mjs';
import { verifyStarsInvoicePayload } from '../v1.3.6/stars-core-foundation.mjs';
import { getStarsRolloutDecision } from '../v1.3.6/stars-rollout.mjs';
import { sha256Hex } from '../v1.4.0-rebuild/mini-app-security.mjs';
import {authorizeV143NativeCancellationContext,compileV143NativeCancellationAssertions} from './native-recovery-authority.mjs';
import {readV143NativeReadinessConfig} from './native-readiness-config.mjs';

// These tokens are fixed action admission proofs. An allowed read/admin bundle
// proves its principal, but is never itself permission to call a provider.
const commands = new WeakMap(), recoveries = new WeakMap(), reviews = new WeakMap();
const fail = (code, status = 403) => { throw Object.assign(new Error(code), { code, status }); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value);
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
const columns = Object.freeze({
  subscription_billing_contracts: 'contract_id telegram_id plan_code price_id origin_order_id external_invoice_payload external_payload_sha256 terms_revision terms_acceptance_id billing_mode period_seconds currency amount_stars provider_state auto_renew_confirmed first_payment_ledger_entry_id last_provider_event_id retired_at retirement_event_id revision created_at updated_at',
  subscription_payment_links: 'operation_id operation_key provider_charge_id provider_charge_sha256 direction link_kind contract_id origin_order_id applied_order_id telegram_id plan_code external_invoice_payload external_payload_sha256 ledger_entry_id original_payment_ledger_entry_id provider_period_start provider_period_end evidence_sha256 occurred_at recorded_at',
  subscription_first_recurring_receipts: 'contract_id operation_id evidence_sha256 verified_at',
  subscription_provider_commands: 'command_id idempotency_key contract_id telegram_id action desired_auto_renew expected_contract_revision first_payment_ledger_entry_id request_sha256 state attempted_count attempted_at acknowledgement_event_id error_code revision created_at updated_at',
  subscription_payment_review_receipts: 'ledger_entry_id origin_order_id contract_id telegram_id plan_code external_invoice_payload external_payload_sha256 provider_period_start provider_period_end is_first_recurring evidence_sha256 telegram_update_id reason_code recorded_at',
  subscription_payment_review_settlements: 'ledger_entry_id applied_order_id operation_id resolution_key actor_id reason_code evidence_sha256 settled_at',
  payment_ledger: 'ledger_entry_id idempotency_key order_id telegram_id entry_type direction currency amount_stars telegram_payment_charge_id provider_payment_charge_id telegram_update_id related_ledger_entry_id reason_code occurred_at recorded_at',
  subscription_orders: 'order_id telegram_id price_id price_version plan_code currency amount_stars access_seconds billing_mode terms_revision invoice_payload order_state state_revision created_at expires_at precheckout_approved_at paid_at applied_at closed_at updated_at',
  price_book: 'price_id price_version plan_code currency amount_stars access_seconds billing_mode publication_state terms_revision valid_from valid_until created_at created_by',
  terms_acceptances: 'acceptance_id telegram_id terms_revision acceptance_scope telegram_update_id evidence_sha256 accepted_at',
  payment_refunds: 'refund_id idempotency_key order_id original_ledger_entry_id telegram_id telegram_payment_charge_id currency amount_stars reason_code requested_by_type requested_by status requested_at confirmed_at applied_at error_code revision updated_at',
});

function recordedReader(db) {
  const assertions = [], cache = new Map();
  const read = async (table, where, params, max = 1) => {
    if (!Object.hasOwn(columns, table)) fail('subscription_action_source_invalid');
    const keys = columns[table].split(' '), sql = `SELECT COALESCE(json_group_array(json(snapshot)),'[]') FROM
      (SELECT json_array(${keys.join(',')}) AS snapshot FROM ${table} WHERE ${where} ORDER BY ${keys[0]} LIMIT ${max + 1})`;
    const cacheKey = JSON.stringify([sql, params]);
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    let result;
    try { result = await db.prepare(sql).bind(...params).first(); }
    catch { fail('subscription_action_source_unavailable', 503); }
    const snapshot = Object.values(result ?? {})[0];
    if (typeof snapshot !== 'string' || snapshot.length > 262144) fail('subscription_action_source_unavailable', 503);
    let raw;
    try { raw = JSON.parse(snapshot); } catch { fail('subscription_action_source_unavailable', 503); }
    if (!Array.isArray(raw) || raw.length > max || raw.some(row => !Array.isArray(row) || row.length !== keys.length))
      fail('subscription_action_source_unavailable', 503);
    assertions.push({ sql: `(${sql}) IS ?`, params: [...params, snapshot] });
    const rows = freeze(raw.map(row => Object.fromEntries(keys.map((key, index) => [key, row[index]]))));
    cache.set(cacheKey, rows);
    return rows;
  };
  return { read, assertions };
}

function principal(authorization, operation, nativeCancellation=null) {
  requireRuntimeAuthorization(authorization);
  const { context, actor, decision, resource } = readRuntimeAuthorization(authorization);
  const identity = readTrustedContext(context), facts = readActorFacts(actor);
  if (identity.actorKind !== 'customer' || facts.telegramId !== identity.telegramId || identity.operation !== operation ||
      identity.channel !== 'mini_app' || !identity.verifiedSessionId || identity.transportBinding?.kind !== 'http' ||
      identity.transportBinding.actor !== identity.telegramId || !identity.operationId || !digest(identity.payloadHash) ||
      typeof identity.transportBinding.idempotencyKey !== 'string' ||
      (identity.env.REBUILD_V140_WRITES_ENABLED !== 'true' && nativeCancellation===null))
    fail('subscription_action_principal_invalid');
  return { context, actor, decision, resource, identity, facts };
}

function proof(input, extra) {
  const decision = compileDecisionAssertions(input.decision);
  return freeze({ assertions: [...(decision.assertions ?? [decision]), ...extra] });
}

async function authorizeOwnStarsSubscriptionCommandScope(authorization, recoveryOnly) {
  requireRuntimeAuthorization(authorization);
  const nativeCancellation=readV143NativeReadinessConfig()
      ?await authorizeV143NativeCancellationContext(authorization):null,
    nativeAssertions=nativeCancellation?compileV143NativeCancellationAssertions(nativeCancellation,authorization,
      readTrustedContext(readRuntimeAuthorization(authorization).context).requestPayload.subscriptionAction==='reenable_renewal'
        ?'existing_own_enable':'existing_own_cancel').assertions:[];
  const input = principal(authorization, 'access.read_own',nativeCancellation), { identity, facts } = input, payload = identity.requestPayload;
  if (!payload || Object.keys(payload).length !== 3 || !['cancel_renewal','reenable_renewal'].includes(payload.subscriptionAction) ||
      !identifier(payload.contractId) || !positive(payload.expectedRevision)) fail('invalid_subscription_command', 400);
  const lifecycle = readVerifiedLifecycleFacts(readLifecycleActorFacts(input.actor));
  const contract = lifecycle.contracts.find(row => row.contract_id === payload.contractId);
  if (!contract || contract.telegram_id !== identity.telegramId || !contract.first_payment_ledger_entry_id)
    fail('subscription_contract_unavailable', 409);
  const source = recordedReader(identity.db), read = source.read;
  const [actual] = await read('subscription_billing_contracts','contract_id=? AND telegram_id=?',[contract.contract_id,identity.telegramId]);
  if (JSON.stringify(actual) !== JSON.stringify(contract)) fail('subscription_action_source_changed', 409);
  const [firstPayment] = await read('payment_ledger','ledger_entry_id=? AND telegram_id=?',[contract.first_payment_ledger_entry_id,identity.telegramId]);
  const [firstReceipt] = await read('subscription_first_recurring_receipts','contract_id=?',[contract.contract_id]);
  const [link] = await read('subscription_payment_links','operation_id=? AND telegram_id=?',[firstReceipt?.operation_id ?? '',identity.telegramId]);
  if (!firstPayment || firstPayment.entry_type !== 'payment' || firstPayment.direction !== 'credit' ||
      firstPayment.currency !== contract.currency || firstPayment.amount_stars !== contract.amount_stars ||
      firstPayment.related_ledger_entry_id !== null || !firstReceipt || !digest(firstReceipt.evidence_sha256) ||
      !positive(firstReceipt.verified_at) || !link || link.contract_id !== contract.contract_id ||
      link.direction !== 'incoming' || link.link_kind !== 'recurring_charge' ||
      link.ledger_entry_id !== firstPayment.ledger_entry_id || link.origin_order_id !== contract.origin_order_id ||
      link.external_invoice_payload !== contract.external_invoice_payload || link.external_payload_sha256 !== contract.external_payload_sha256 ||
      link.provider_charge_id !== firstPayment.telegram_payment_charge_id || link.evidence_sha256 !== firstReceipt.evidence_sha256 ||
      !positive(link.provider_period_start) || link.provider_period_end !== link.provider_period_start + contract.period_seconds ||
      link.recorded_at > firstReceipt.verified_at) fail('subscription_first_charge_unverified', 409);
  // The canonical lifecycle verifier checks the signed origin/price/consent;
  // the captured first marker also has to refer to a verified financial period.
  if (!lifecycle.periods.some(period => period.ledgerEntryId === firstPayment.ledger_entry_id && period.contractId === contract.contract_id))
    fail('subscription_first_charge_unverified', 409);
  const open = await read('subscription_provider_commands',"contract_id=? AND state IN ('admitted','attempted','unknown')",[contract.contract_id],128);
  const idempotencyKey = identity.transportBinding.idempotencyKey;
  const [previous]=await read('subscription_provider_commands','idempotency_key=? AND telegram_id=?',
    ['stars-command:'+identity.operationId,identity.telegramId]);
  if(previous&&(previous.contract_id!==contract.contract_id||previous.action!==payload.subscriptionAction||
      previous.expected_contract_revision!==payload.expectedRevision||previous.first_payment_ledger_entry_id!==firstPayment.ledger_entry_id||
      previous.request_sha256!==identity.payloadHash)) fail('subscription_command_idempotency_collision',409);
  if((!previous||previous.state==='admitted')&&(contract.retired_at!==null||contract.revision!==payload.expectedRevision))
    fail('subscription_contract_unavailable',409);
  if ((!previous||previous.state==='admitted')&&open.some(command => command.idempotency_key !== 'stars-command:'+identity.operationId ||
      command.action !== payload.subscriptionAction || command.expected_contract_revision !== payload.expectedRevision ||
      command.first_payment_ledger_entry_id !== firstPayment.ledger_entry_id || command.request_sha256 !== identity.payloadHash))
    fail('subscription_command_pending', 409);
  if (!recoveryOnly&&payload.subscriptionAction === 'reenable_renewal'&&(!previous||['admitted','attempted'].includes(previous.state))) {
    const acknowledged=lifecycle.commands.filter(command=>command.contract_id===contract.contract_id&&command.state==='confirmed'&&
      lifecycle.providerEvents.some(event=>event.event_id===command.acknowledgement_event_id&&event.command_id===command.command_id&&
        event.event_type==='command_confirmed'&&event.source==='provider_response'));
    const latestTime=acknowledged.length?Math.max(...acknowledged.map(command=>command.attempted_at)):null;
    const latest=acknowledged.filter(command=>command.attempted_at===latestTime);
    if(latest.length!==1||latest[0].action!=='cancel_renewal'||latest[0].desired_auto_renew!==0||
        latest[0].expected_contract_revision!==contract.revision)
      fail('subscription_bot_cancel_unverified',409);
    const config = readStarsRecurringConfig(identity.env);
    if (!config.ready || !facts.account.acceptedTerms || facts.account.isBlocked || facts.account.pendingDeletion ||
        ['suspended','chargeback'].includes(facts.access?.lifecycle?.state) ||
        facts.access?.storedState === 'suspended' || lifecycle.reviewRequired ||
        lifecycle.reviewReasons.some(reason => !['provider_command_unknown'].includes(reason)))
      fail('subscription_reenable_unavailable', 409);
    // This owner exception only changes future provider renewal control of
    // the current paid contract. It cannot revive an expired or refunded plan.
    if (nativeCancellation && (facts.access?.lifecycle?.paidAccess !== true ||
        facts.access.lifecycle.contractId !== contract.contract_id ||
        !['active','cancel_at_period_end'].includes(facts.access.lifecycle.state) ||
        facts.access.lifecycle.reviewRequired ||
        !lifecycle.periods.some(period => period.contractId === contract.contract_id && period.status === 'active' &&
          period.startsAt <= identity.nowSeconds && period.endsAt > identity.nowSeconds)))
      fail('subscription_reenable_unavailable',409);
    const compensations = await read('payment_ledger',"related_ledger_entry_id=? AND entry_type IN ('refund','chargeback')",[firstPayment.ledger_entry_id],128);
    if (compensations.length) fail('subscription_reenable_unavailable', 409);
    const rollout = await getStarsRolloutDecision({ ...identity.env, DB:identity.db },identity.telegramId);
    if (!rollout.eligible) fail('subscription_reenable_unavailable', 403);
  }
  const token = Object.freeze({ version:1, authority:recoveryOnly?'own_subscription_command_recovery':'own_subscription_command' });
  (recoveryOnly?recoveries:commands).set(token, { facts:freeze({ context:input.context, decision:input.decision, actor:input.actor,
    contract:actual, firstPayment, firstReceipt, action:payload.subscriptionAction,
    expectedRevision:payload.expectedRevision, idempotencyKey, operationId:identity.operationId }), assertions:proof(input,[...source.assertions,...nativeAssertions]) });
  return token;
}

export function authorizeOwnStarsSubscriptionCommand(authorization) {
  return authorizeOwnStarsSubscriptionCommandScope(authorization,false);
}

// Own contract/first-charge proof is retained, but no provider eligibility is
// granted by this separate private brand. It can only reject before attempt.
export function authorizeOwnStarsSubscriptionRecovery(authorization) {
  return authorizeOwnStarsSubscriptionCommandScope(authorization,true);
}
export function readVerifiedOwnStarsSubscriptionRecovery(token) {
  if (!recoveries.has(token)) fail('untrusted_subscription_command_recovery');
  return recoveries.get(token).facts;
}
export function compileVerifiedOwnStarsSubscriptionRecoveryAssertions(token) {
  if (!recoveries.has(token)) fail('untrusted_subscription_command_recovery');
  return recoveries.get(token).assertions;
}

export function readVerifiedOwnStarsSubscriptionCommand(token) {
  if (!commands.has(token)) fail('untrusted_subscription_command');
  return commands.get(token).facts;
}
export function compileVerifiedOwnStarsSubscriptionCommandAssertions(token) {
  if (!commands.has(token)) fail('untrusted_subscription_command');
  return commands.get(token).assertions;
}

export async function authorizeOwnerSubscriptionPaymentReview(authorization) {
  const input = principal(authorization, 'admin.cabinet.open'), { identity, facts } = input;
  const resource = readResourceFacts(input.resource), payload = identity.requestPayload;
  if (!facts.canonicalOwner || resource.kind !== 'admin_surface' || resource.ref !== 'cabinet' ||
      !payload || Object.keys(payload).length !== 3 || !['apply','refund'].includes(payload.subscriptionReviewAction) ||
      !identifier(payload.ledgerEntryId) || typeof payload.reasonCode !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/u.test(payload.reasonCode))
    fail('subscription_review_principal_invalid');
  const source = recordedReader(identity.db), read = source.read;
  const [receipt] = await read('subscription_payment_review_receipts','ledger_entry_id=?',[payload.ledgerEntryId]);
  const [firstPayment] = await read('payment_ledger','ledger_entry_id=?',[payload.ledgerEntryId]);
  const [originOrder] = await read('subscription_orders','order_id=?',[receipt?.origin_order_id ?? '']);
  if (!receipt || !firstPayment || !originOrder || firstPayment.entry_type !== 'payment' || firstPayment.direction !== 'credit' ||
      firstPayment.reason_code !== 'payment_review_retained' || firstPayment.related_ledger_entry_id !== null ||
      firstPayment.order_id !== originOrder.order_id || firstPayment.telegram_id !== receipt.telegram_id ||
      originOrder.telegram_id !== receipt.telegram_id || firstPayment.currency !== 'XTR' || originOrder.currency !== 'XTR' ||
      firstPayment.amount_stars !== originOrder.amount_stars || originOrder.plan_code !== receipt.plan_code ||
      receipt.external_invoice_payload !== originOrder.invoice_payload || !digest(receipt.external_payload_sha256) ||
      await sha256Hex(receipt.external_invoice_payload) !== receipt.external_payload_sha256 || !digest(receipt.evidence_sha256) ||
      !positive(receipt.recorded_at) || !positive(firstPayment.recorded_at) || !firstPayment.telegram_payment_charge_id)
    fail('subscription_review_payment_unverified', 409);
  const parsed = await verifyStarsInvoicePayload({ invoiceSecret:identity.env.STARS_INVOICE_SECRET,
    payload:originOrder.invoice_payload, telegramId:receipt.telegram_id, priceId:originOrder.price_id });
  if (parsed.orderId !== originOrder.order_id) fail('subscription_review_payment_unverified', 409);
  const [price] = await read('price_book','price_id=? AND price_version=?',[originOrder.price_id,originOrder.price_version]);
  const [termsAcceptance] = await read('terms_acceptances',"telegram_id=? AND terms_revision=? AND acceptance_scope='stars_purchase'",
    [receipt.telegram_id,originOrder.terms_revision]);
  if (!price || ['plan_code','currency','amount_stars','access_seconds','billing_mode','terms_revision'].some(key => price[key] !== originOrder[key]) ||
      !['approved','retired'].includes(price.publication_state) || price.valid_from > originOrder.created_at ||
      price.valid_until !== null && price.valid_until <= originOrder.created_at || !termsAcceptance ||
      termsAcceptance.accepted_at > originOrder.created_at || !digest(termsAcceptance.evidence_sha256))
    fail('subscription_review_payment_unverified', 409);
  if (originOrder.billing_mode === 'recurring' && (!positive(receipt.provider_period_start) ||
      receipt.provider_period_end !== receipt.provider_period_start + originOrder.access_seconds || !receipt.contract_id))
    fail('subscription_review_payment_unverified', 409);
  if (payload.subscriptionReviewAction === 'apply') {
    const settlements = await read('subscription_payment_review_settlements','ledger_entry_id=?',[firstPayment.ledger_entry_id]);
    const refunds = await read('payment_refunds',
      'original_ledger_entry_id=? AND order_id=? AND telegram_id=? AND currency=? AND amount_stars=? AND telegram_payment_charge_id=?',
      [firstPayment.ledger_entry_id,firstPayment.order_id,firstPayment.telegram_id,firstPayment.currency,
        firstPayment.amount_stars,firstPayment.telegram_payment_charge_id],128);
    // A durable refund attempt can already have refunded money even when its
    // accounting debit is still missing. Capture absence in the apply batch;
    // an existing settled grant may only be returned as a truthful duplicate.
    if (!settlements.length && refunds.some(refund => ['requested','manual_review','confirmed'].includes(refund.status)))
      fail('subscription_review_refund_pending',409);
  }
  const token = Object.freeze({ version:1, authority:'owner_subscription_review' });
  reviews.set(token, { facts:freeze({ context:input.context, decision:input.decision, actor:input.actor,
    ledgerEntryId:payload.ledgerEntryId, action:payload.subscriptionReviewAction, reasonCode:payload.reasonCode,
    idempotencyKey:identity.transportBinding.idempotencyKey, operationId:identity.operationId,
    receipt, firstPayment, originOrder, price, termsAcceptance }), assertions:proof(input,source.assertions) });
  return token;
}

export function readVerifiedOwnerSubscriptionReview(token) {
  if (!reviews.has(token)) fail('untrusted_subscription_review');
  return reviews.get(token).facts;
}
export function compileVerifiedOwnerSubscriptionReviewAssertions(token) {
  if (!reviews.has(token)) fail('untrusted_subscription_review');
  return reviews.get(token).assertions;
}
