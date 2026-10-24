import { readTrustedContext } from '../v1.4.1/trusted-context.mjs';
import { readActorFacts, readActorContext, readSubscriptionActorFacts } from '../v1.4.1/authority-resolver.mjs';
import { readRuntimeAuthorization, requireRuntimeAuthorization, assertRuntimeAuthorizationFresh,
  RuntimeAuthorizationError } from '../v1.4.1/runtime-authorizer.mjs';

const PLANS = new Set(['free','professional','dragon']);
const STATES = new Set(['none','trial','active','cancel_at_period_end','payment_failed','expired','refunded','chargeback','suspended']);
const fail = code => { throw new RuntimeAuthorizationError(code); };
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

// A projection accepts the genuine own-access decision, never a serialized
// actor, a client-selected subject or a caller-selected clock. Aggregate reads
// reassert all their proofs once immediately before returning the response.
export function projectSubscriptionAccess(authorization) {
  const { context, actor } = readRuntimeAuthorization(requireRuntimeAuthorization(authorization));
  const identity = readTrustedContext(context), facts = readActorFacts(actor);
  if (identity.actorKind !== 'customer' || identity.operation !== 'access.read_own' ||
    facts.actorKind !== 'customer' || readActorContext(actor) !== context ||
    identity.telegramId !== facts.telegramId || identity.botId !== facts.botId ||
    identity.nowSeconds !== facts.nowSeconds || !facts.access) fail('subscription_access_scope_mismatch');
  const privateFacts = readSubscriptionActorFacts(actor), access = facts.access;
  const verified = access.status === 'verified' && facts.financialSourceAvailable === true;
  if (verified && (!PLANS.has(access.effectivePlan) || !STATES.has(access.accessState)))
    fail('subscription_access_source_invalid');
  const timeline = privateFacts.timeline;
  const finite = verified && timeline.verified === true;
  const previewActive = verified && access.effectivePlan === 'free' && access.accessOverlay === 'dragon_preview';
  const activeDragon = verified && access.effectivePlan === 'dragon' &&
    ['active','cancel_at_period_end','payment_failed'].includes(access.accessState) && finite && timeline.expiresAt > identity.nowSeconds;
  const expiresAt = finite ? timeline.expiresAt : null;
  return freeze({ version:1, authority:'worker', policyVersion:facts.policyVersion,
    observedAt:identity.nowSeconds, sessionExpiresAt:identity.expiresAt,
    current:{ planCode:verified ? access.effectivePlan : null,
      accessState:STATES.has(access.accessState) ? access.accessState : null,
      accessOverlay:verified ? access.accessOverlay : null,
      status:verified ? 'verified' : 'review_required', reasonCode:access.reasonCode,
      sourceKind:finite ? timeline.sourceKind : verified && access.effectivePlan === 'free' ? 'free' : null,
      startsAt:finite ? timeline.startsAt : null, expiresAt,
      remainingSeconds:expiresAt === null ? null : Math.max(0, expiresAt - identity.nowSeconds),
      durationKind:finite ? expiresAt > identity.nowSeconds ? 'finite' : 'ended' :
        verified && access.effectivePlan === 'free' && !previewActive ? 'free_unlimited' : 'unknown',
      activeDragon, previewActive },
    lifecycle:privateFacts.lifecycle,
    preview:{ ...privateFacts.preview },
    ownerException:{ applies:facts.canonicalOwner === true,
      source:facts.canonicalOwner === true ? 'canonical_owner' : null, isPaidPlan:false },
  });
}

export async function readSubscriptionAccess(authorization) {
  const result = projectSubscriptionAccess(authorization);
  await assertRuntimeAuthorizationFresh(authorization);
  return result;
}
