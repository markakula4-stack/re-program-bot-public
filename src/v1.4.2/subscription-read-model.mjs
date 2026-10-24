import { requireRuntimeAuthorization, readRuntimeAuthorization } from '../v1.4.1/runtime-authorizer.mjs';
import { readTrustedContext } from '../v1.4.1/trusted-context.mjs';
import { projectSubscriptionAccess } from './subscription-access.mjs';
import { readOwnSubscriptionQuotas } from './subscription-quotas.mjs';
import { readSubscriptionCatalog } from './subscription-catalog.mjs';
import { projectOwnSubscriptionRenewalActions } from '../v1.4.3/subscription-api.mjs';
import { projectOwnSubscriptionHistory } from '../v1.4.3/subscription-history.mjs';
import { readOwnPackageSubscription } from '../v1.4.4/package-read-model.mjs';

export const SUBSCRIPTION_READ_MODEL_VERSION = '2026-10-03.v1.4.2.p01';

// This function takes a server-minted authorization, never a requested user,
// plan, SQL producer or entitlement callback. HTTP retains its accepted source
// fence and performs one final canonical authorization check before replying.
export async function readSubscriptionData({ authorization } = {}) {
  requireRuntimeAuthorization(authorization);
  const { context } = readRuntimeAuthorization(authorization);
  const identity = readTrustedContext(context);
  if (identity.actorKind !== 'customer' || identity.operation !== 'access.read_own') {
    throw Object.assign(new Error('subscription_context_required'), {
      code: 'subscription_context_required', status: 403,
    });
  }
  const access = projectSubscriptionAccess(authorization);
  const quotas = await readOwnSubscriptionQuotas({ authorization });
  const catalog = await readSubscriptionCatalog({ authorization });
  return Object.freeze({
    readModelVersion: 1,
    subscriptionModelVersion: SUBSCRIPTION_READ_MODEL_VERSION,
    authority: 'worker',
    observedAt: identity.nowSeconds,
    access, lifecycle:access.lifecycle, quotas, catalog,
    renewalActions:projectOwnSubscriptionRenewalActions(authorization),
    history:await projectOwnSubscriptionHistory(authorization),
    packages:await readOwnPackageSubscription({ authorization }),
  });
}
