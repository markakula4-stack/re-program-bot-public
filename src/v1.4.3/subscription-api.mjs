import { readRuntimeAuthorization, requireRuntimeAuthorization, assertRuntimeAuthorizationFresh } from '../v1.4.1/runtime-authorizer.mjs';
import { readTrustedContext } from '../v1.4.1/trusted-context.mjs';
import { readActorFacts, readLifecycleActorFacts } from '../v1.4.1/authority-resolver.mjs';
import { readVerifiedLifecycleFacts } from './lifecycle-authority.mjs';
import { authorizeOwnStarsSubscriptionCommand, authorizeOwnerSubscriptionPaymentReview } from './subscription-action-authority.mjs';
import { issueStarsRecurringInvoice, requestOwnStarsSubscriptionCommand } from './telegram-subscription-provider.mjs';
import { resolveRetainedStarsPaymentReview } from './subscription-review-runtime.mjs';
import { readV143NativeReadinessConfig, isV143NativeOwnerCheckoutEnvelope, V143_NATIVE_READINESS_FRAME } from './native-readiness-config.mjs';
import { readStarsRecurringConfig } from './recurring-provider-config.mjs';

const fail = (code, status = 403) => { throw Object.assign(new Error(code), { code, status }); };

export async function issueOwnRecurringSubscriptionInvoice(authorization, options = {}) {
  // The provider adapter verifies the actual released server quote and explicit
  // recurring consent from the immutable purchase context, then journals one
  // provider attempt. No invoice response is treated as paid access.
  requireRuntimeAuthorization(authorization);
  return issueStarsRecurringInvoice(authorization, options);
}

export async function executeOwnSubscriptionRenewalCommand(authorization, options = {}) {
  const admission = await authorizeOwnStarsSubscriptionCommand(authorization);
  return requestOwnStarsSubscriptionCommand(admission, options);
}

export async function executeOwnerSubscriptionPaymentReview(authorization, options = {}) {
  const admission = await authorizeOwnerSubscriptionPaymentReview(authorization);
  return resolveRetainedStarsPaymentReview(admission, options);
}

// This read descriptor helps the client choose a fixed route. The private
// command bridge independently admits the exact action at its effect boundary.
export function projectOwnSubscriptionRenewalActions(authorization) {
  requireRuntimeAuthorization(authorization);
  const { context, actor } = readRuntimeAuthorization(authorization), identity = readTrustedContext(context), facts = readActorFacts(actor);
  if (identity.operation !== 'access.read_own' || identity.actorKind !== 'customer') fail('subscription_context_required');
  const source = readVerifiedLifecycleFacts(readLifecycleActorFacts(actor)), lifecycle = facts.access.lifecycle;
  const contract = source.contracts.find(row => row.contract_id === lifecycle?.contractId);
  const inactive=lifecycle?.renewalState==='inactive';
  const own = Boolean(contract && contract.telegram_id === identity.telegramId && contract.retired_at === null &&
    contract.first_payment_ledger_entry_id && source.periods.some(period => period.ledgerEntryId === contract.first_payment_ledger_entry_id));
  const acknowledged=source.commands.filter(command=>command.contract_id===contract?.contract_id&&command.state==='confirmed'&&
    source.providerEvents.some(event=>event.event_id===command.acknowledgement_event_id&&event.source==='provider_response'));
  const lastAttempt=acknowledged.length?Math.max(...acknowledged.map(command=>command.attempted_at)):null;
  const latest=acknowledged.filter(command=>command.attempted_at===lastAttempt);
  const native=readV143NativeReadinessConfig(), nativeEnable=native?.mode==='owner_acceptance' &&
    isV143NativeOwnerCheckoutEnvelope(identity.env) && facts.canonicalOwner &&
    identity.telegramId===V143_NATIVE_READINESS_FRAME.ownerId && lifecycle?.paidAccess===true &&
    ['active','cancel_at_period_end'].includes(lifecycle?.state) &&
    source.periods.some(period=>period.contractId===contract?.contract_id && period.status==='active' &&
      period.startsAt<=identity.nowSeconds && period.endsAt>identity.nowSeconds);
  return Object.freeze({ contractId:contract?.contract_id ?? null, expectedRevision:contract?.revision ?? null,
    renewalState:lifecycle?.renewalState ?? 'unknown', pendingOperations:lifecycle?.pendingOperations ?? [],
    cancel:Object.freeze({ available:own&&!inactive, route:'/subscription/renewal/cancel' }),
    enable:Object.freeze({ available:!inactive&&(native?.mode !== 'owner_acceptance' || identity.env.REBUILD_V140_WRITES_ENABLED === 'true' || nativeEnable) && readStarsRecurringConfig(identity.env).ready && own && latest.length===1 && latest[0].action==='cancel_renewal' && latest[0].desired_auto_renew===0 && latest[0].expected_contract_revision===contract?.revision && facts.account.acceptedTerms && !facts.account.isBlocked && !facts.account.pendingDeletion &&
      !['suspended','chargeback'].includes(lifecycle?.state) && !lifecycle?.reviewRequired,
    route:'/subscription/renewal/enable' }), actionAdmissionRequired:true });
}

export async function readOwnerSubscriptionPaymentReviewQueue(authorization, params = {}) {
  requireRuntimeAuthorization(authorization);
  const { context, actor } = readRuntimeAuthorization(authorization), identity = readTrustedContext(context), facts = readActorFacts(actor);
  if (identity.operation !== 'admin.cabinet.open' || identity.actorKind !== 'customer' || !identity.verifiedSessionId ||
      !facts.canonicalOwner || !identity.requestPayload || Object.keys(identity.requestPayload).length !== 1 ||
      identity.requestPayload.subscriptionReviewAction !== 'list' || !params || Object.keys(params).length !== 0)
    fail('subscription_review_principal_invalid');
  const sql = `SELECT r.ledger_entry_id AS ledgerEntryId,r.telegram_id AS telegramId,r.plan_code AS planCode,
    p.currency,p.amount_stars AS amountStars,r.provider_period_start AS startsAt,r.provider_period_end AS endsAt,
    r.reason_code AS reasonCode,r.recorded_at AS recordedAt,
    CASE WHEN EXISTS(SELECT 1 FROM payment_ledger reversal WHERE reversal.related_ledger_entry_id=p.ledger_entry_id
      AND reversal.entry_type='chargeback' AND reversal.direction='debit' AND reversal.telegram_id=p.telegram_id
      AND reversal.order_id=p.order_id AND reversal.currency=p.currency AND reversal.amount_stars=p.amount_stars
      AND reversal.telegram_payment_charge_id=p.telegram_payment_charge_id) THEN 'chargeback'
      WHEN EXISTS(SELECT 1 FROM payment_ledger reversal WHERE reversal.related_ledger_entry_id=p.ledger_entry_id
      AND reversal.entry_type='refund' AND reversal.direction='debit' AND reversal.telegram_id=p.telegram_id
      AND reversal.order_id=p.order_id AND reversal.currency=p.currency AND reversal.amount_stars=p.amount_stars
      AND reversal.telegram_payment_charge_id=p.telegram_payment_charge_id) THEN 'refunded'
      WHEN EXISTS(SELECT 1 FROM payment_refunds refund WHERE refund.original_ledger_entry_id=p.ledger_entry_id
        AND refund.telegram_id=p.telegram_id AND refund.order_id=p.order_id AND refund.currency=p.currency
        AND refund.amount_stars=p.amount_stars AND refund.telegram_payment_charge_id=p.telegram_payment_charge_id
        AND refund.status='manual_review') THEN 'unknown'
      WHEN EXISTS(SELECT 1 FROM payment_refunds refund WHERE refund.original_ledger_entry_id=p.ledger_entry_id
        AND refund.telegram_id=p.telegram_id AND refund.order_id=p.order_id AND refund.currency=p.currency
        AND refund.amount_stars=p.amount_stars AND refund.telegram_payment_charge_id=p.telegram_payment_charge_id
        AND refund.status IN ('requested','confirmed')) THEN 'pending'
      WHEN EXISTS(SELECT 1 FROM subscription_payment_review_settlements s WHERE s.ledger_entry_id=p.ledger_entry_id)
        THEN 'applied' ELSE 'pending_review' END AS status
    FROM subscription_payment_review_receipts r JOIN payment_ledger p ON p.ledger_entry_id=r.ledger_entry_id
    JOIN subscription_orders origin ON origin.order_id=r.origin_order_id
    WHERE p.entry_type='payment' AND p.direction='credit' AND p.currency='XTR' AND p.reason_code='payment_review_retained'
      AND p.order_id=origin.order_id AND p.telegram_id=r.telegram_id AND origin.telegram_id=r.telegram_id
      AND origin.plan_code=r.plan_code AND p.amount_stars=origin.amount_stars
    ORDER BY (status IN ('pending_review','pending','unknown')) DESC,r.recorded_at DESC,r.ledger_entry_id LIMIT 51`;
  const read = async () => {
    let result;
    try { result = await identity.db.prepare(sql).all(); } catch { fail('subscription_review_unavailable',503); }
    if (result?.success !== true || !Array.isArray(result.results) || result.results.length > 51)
      fail('subscription_review_unavailable',503);
    return result.results;
  };
  const items = await read();
  await assertRuntimeAuthorizationFresh(authorization);
  if (JSON.stringify(items) !== JSON.stringify(await read())) fail('subscription_review_source_changed',409);
  return Object.freeze({ authority:'worker', observedAt:identity.nowSeconds, items:Object.freeze(items.slice(0,50).map(Object.freeze)),
    hasMore:items.length>50, actionAdmissionRequired:true });
}
