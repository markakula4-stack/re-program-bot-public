import { isTrustedContext, readTrustedContext } from './trusted-context.mjs';
import { createAuthorityResolver, readActorFacts } from './authority-resolver.mjs';
import { createResourceResolver } from './resource-resolver.mjs';
import { can, readDecisionFacts, compileDecisionAssertions } from './entitlement-engine.mjs';
import { compileProofReadQueries, proofReadResultsValid } from './proof-queries.mjs';

// Fixed transport adapters create the context. This boundary never accepts an
// actor, capability, source proof, SQL producer, or an authorization callback.
export const RUNTIME_AUTHORIZER_VERSION = '2026-10-02.v1.4.1.p04';
const authorizations = new WeakMap();
export class RuntimeAuthorizationError extends Error {
  constructor(code, status = 403) {
    super(code); this.name = 'RuntimeAuthorizationError'; this.code = code; this.status = status;
  }
}
const fail = (code, status) => { throw new RuntimeAuthorizationError(code, status); };
export const isRuntimeAuthorization = value => Boolean(value && authorizations.has(value));
export function readRuntimeAuthorization(value) {
  const facts = authorizations.get(value);
  if (!facts) fail('untrusted_runtime_authorization');
  return facts;
}
export function runtimeAuthorizationDTO(value) {
  return readDecisionFacts(readRuntimeAuthorization(value).decision).publicDTO;
}
export function requireRuntimeAuthorization(value) {
  const dto = runtimeAuthorizationDTO(value);
  if (dto.allowed !== true) fail(dto.reasonCode ?? 'capability_denied');
  return value;
}

export function createRuntimeAuthorizer() {
  return Object.freeze({ version: RUNTIME_AUTHORIZER_VERSION,
    async authorize(context, resourceRef = null) {
      if (!isTrustedContext(context)) fail('untrusted_context');
      const identity = readTrustedContext(context);
      // Construct at invocation, after the module graph is initialized. Fixed
      // AI adapters may hold this factory across its import cycle; no canonical
      // facts or reader options are cached by that lifetime.
      const authority = createAuthorityResolver(), resources = createResourceResolver();
      const actor = await authority.resolveActor(context);
      const resource = await resources.resolve(context, actor, resourceRef);
      const decision = can(actor, identity.operation, resource);
      const bundle = Object.freeze({ version: 1 });
      authorizations.set(bundle, Object.freeze({ context, actor, resource, decision }));
      return bundle;
    },
  });
}

// Read responses and async provider phases reassert the same captured canonical
// facts immediately before their effect. Mutation executors put these same
// assertions in their effect batch instead of relying on this read check.
export async function assertRuntimeAuthorizationFresh(value) {
  await assertRuntimeAuthorizationsFresh([value]);
  return value;
}

// A read page may show one separately authorized action. Compose authentic
// sibling contexts on the same primary session and retain every distinct
// assertion; byte-identical identity reads need not run twice.
export async function assertRuntimeAuthorizationsFresh(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) fail('untrusted_runtime_authorization');
  const bundles = [...values], inputs = bundles.map(readRuntimeAuthorization);
  const identity = readTrustedContext(inputs[0].context), unique = new Map();
  for (const input of inputs) {
    const other = readTrustedContext(input.context);
    if (other.db !== identity.db || other.actorKind !== identity.actorKind || other.telegramId !== identity.telegramId ||
        other.botId !== identity.botId || other.nowSeconds !== identity.nowSeconds || other.expiresAt !== identity.expiresAt) fail('proof_context_mismatch');
    const proof = compileDecisionAssertions(input.decision);
    for (const piece of proof.assertions ?? [proof]) unique.set(JSON.stringify([piece.sql,piece.params]),piece);
  }
  const pieces = [...unique.values()];
  if (!pieces.length || pieces.length > 96) fail('authority_check_failed', 503);
  let checked, queries;
  try {
    queries = compileProofReadQueries(pieces);
    // All statements share one D1 batch transaction. Splitting on platform
    // limits does not split the snapshot or omit any freshness assertion.
    checked = await identity.db.batch(queries.map(query => identity.db.prepare(query.sql).bind(...query.params)));
  } catch { fail('authority_check_failed', 503); }
  if (!proofReadResultsValid(checked, queries.length)) fail('authority_stale', 409);
  return Object.freeze(bundles);
}

export function projectRuntimeAccessAuthority(value) {
  const { context, actor } = readRuntimeAuthorization(value);
  const identity = readTrustedContext(context), facts = readActorFacts(actor);
  if (identity.actorKind !== 'customer' || !facts.access) fail('customer_projection_required');
  const access = facts.access, verified = access.status === 'verified';
  const preview = verified && access.effectivePlan === 'free' && access.accessOverlay === 'dragon_preview';
  const plans = new Set(['free', 'professional', 'dragon']);
  const states = new Set(['none', 'trial', 'active', 'cancel_at_period_end', 'payment_failed', 'expired', 'refunded', 'chargeback', 'suspended']);
  return Object.freeze({ authority: 'worker', decisionVersion: 2,
    telegramId: identity.telegramId,
    systemRole: facts.roles.includes('admin') ? 'admin' : facts.roles.includes('partner') ? 'partner' : 'user',
    planCode: plans.has(access.effectivePlan) ? access.effectivePlan : 'free',
    accessState: preview ? 'trial' : states.has(access.accessState) ? access.accessState : 'none',
    comparisonStatus: preview ? 'dragon_preview_active' : verified ? 'matched' : 'manual_review',
    reviewRequired: !verified, resolved: verified,
    readPath: preview ? 'preview_overlay' : 'canonical',
    paidCapabilitiesEnabled: verified && (preview || ['professional', 'dragon'].includes(access.effectivePlan)),
    lifecycle:access.lifecycle ?? null,
  });
}
