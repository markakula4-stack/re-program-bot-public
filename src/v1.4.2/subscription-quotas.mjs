import { CAPABILITY_DEFINITIONS, QUOTA_DEFINITIONS } from '../v1.4.1/capability-policy.mjs';
import { RESOURCE_QUOTA_PREDICATES } from '../v1.4.1/resource-resolver.mjs';
import { readActorFacts } from '../v1.4.1/authority-resolver.mjs';
import { readTrustedContext } from '../v1.4.1/trusted-context.mjs';
import { readRuntimeAuthorization, requireRuntimeAuthorization } from '../v1.4.1/runtime-authorizer.mjs';

// Capacity is a read projection, never an authorization to create a resource.
// The caller reasserts the same authorization immediately before responding.
// No caller-selected subject, SQL, resource or alternative authority is read.
const keys = Object.freeze(['active_applications', 'own_working_offers', 'active_campaigns']);
const capabilities = Object.freeze({ active_applications: 'application.create',
  own_working_offers: 'offer.create_private', active_campaigns: 'campaign.activate' });
const admissionCapabilities = Object.freeze({ active_applications: ['application.create', 'application.resubmit'],
  own_working_offers: ['offer.create_private'], active_campaigns: ['campaign.activate', 'campaign.resume'] });
const definitions = new Map(CAPABILITY_DEFINITIONS.map(row => [row.capability, row]));
const positive = value => Number.isSafeInteger(value) && value > 0;
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
const bit = value => value === true || value === 1;
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
const epoch = value => {
  if (value === null || value === undefined) return null;
  if (positive(value)) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d(?:T| )\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z)?$/u.test(value)) return NaN;
  const parsed = Date.parse(value.replace(' ', 'T').replace(/(?<!Z)$/u, 'Z'));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : NaN;
};

function applicableRules(facts, context, capability) {
  return [...(facts.overrides ?? []), ...(facts.grants ?? [])].filter(row => {
    if (row.sourceVerified !== true || row.capability !== capability || row.subject_telegram_id !== context.telegramId) return false;
    const kind = row.scopeKind ?? row.scope_kind, key = row.scopeKey ?? row.scope_key;
    if (kind === 'actor') return key === `actor:${context.telegramId}`;
    if (kind === 'tenant') return key === `bot:${context.botId}`;
    // A collection cannot claim a specific application/campaign admission.
    // Offer creation alone has the fixed own partner-profile resource.
    return kind === 'resource' && (capability !== 'offer.create_private' ||
      positive(facts.partner?.profileId) && key === `partner_profile:${facts.partner.profileId}`);
  });
}

function restrictionsFor(key, facts, context, rules) {
  const reasons = [], capability = capabilities[key], definition = definitions.get(capability);
  if (!definition.roles.some(role => facts.roles.includes(role)) ||
      key === 'own_working_offers' && facts.roles.includes('admin')) reasons.push('role_required');
  if (facts.access?.storedState === 'suspended' || facts.access?.accessState === 'suspended') reasons.push('account_restricted');
  if (rules.some(row => (row.scopeKind ?? row.scope_kind) !== 'resource' &&
      (row.effect === 'deny' || row.effect_kind === 'deny' || row.decision === 'deny'))) reasons.push('access_required');
  if (key !== 'active_applications' && (!positive(facts.partner?.profileId) || facts.partner.status !== 'active')) reasons.push('active_partner_required');
  if (key === 'own_working_offers') {
    if (facts.partner?.approvedApplication !== true || facts.partner?.ageConfirmed !== true) reasons.push('age_confirmation_required');
    if (!facts.legalProfile || facts.legalProfile.verificationState !== 'self_declared') reasons.push('legal_declaration_required');
    const settings = facts.partner?.betaSettings, access = facts.partner?.betaAccess;
    if (context.env.REBUILD_V140_ALL_ACCESS_DISABLED === 'true' ||
        context.env.PARTNER_BETA_ENABLED !== 'true' || context.env.PARTNER_PRIVATE_OFFERS_ENABLED !== 'true' ||
        !settings || !bit(settings.enabled) || !bit(settings.private_offers_enabled ?? settings.privateOffersEnabled)) reasons.push('partner_beta_disabled');
    const end = epoch(access?.expires_at ?? access?.expiresAt);
    if (!access || (access.access_status ?? access.accessStatus) !== 'active' ||
        !bit(access.can_create_private_offers ?? access.canCreatePrivateOffers) || Number.isNaN(end) ||
        end !== null && end <= context.nowSeconds) reasons.push('partner_beta_access_required');
  }
  // Campaign issuer approval, rollout, transition, window and actual offer
  // visibility are checked only by can() on the concrete action resource.
  return reasons;
}

/** Three own counters with published capacity, not canCreate/canActivate.
 * Manual numeric rules remain action-specific: their limit is not a paid plan.
 * Capability flags outside access.read_own are intentionally not inferred.
 */
export async function readOwnSubscriptionQuotas({ authorization } = {}) {
  requireRuntimeAuthorization(authorization);
  const { context: handle, actor } = readRuntimeAuthorization(authorization);
  const context = readTrustedContext(handle), facts = readActorFacts(actor);
  if (context.actorKind !== 'customer' || context.operation !== 'access.read_own' ||
      !facts || facts.telegramId !== context.telegramId) {
    throw Object.assign(new Error('subscription_own_access_required'), { code: 'subscription_own_access_required' });
  }
  const degraded = new Set((facts.degradedTables ?? []).map(row => row.table));
  const profileAvailable = !degraded.has('partner_profiles');
  const profileId = profileAvailable && positive(facts.partner?.profileId) ? facts.partner.profileId : -1;
  let result;
  try {
    result = await context.db.batch(keys.map(key => context.db.prepare(RESOURCE_QUOTA_PREDICATES[key])
      .bind(key === 'active_applications' ? context.telegramId : profileId)));
  } catch { result = null; }
  const verified = facts.access?.status === 'verified' && facts.financialSourceAvailable === true;
  const effectivePlan = verified && facts.access.effectivePlan === 'free' && facts.access.accessOverlay === 'dragon_preview'
    ? 'preview' : verified ? facts.access.effectivePlan : null;
  const betaValue = facts.partner?.betaSettings?.max_active_offers_per_partner ?? facts.partner?.betaSettings?.maxActiveOffersPerPartner;
  const quotas = keys.map((key, index) => {
    const row = Array.isArray(result) && result.length === keys.length ? result[index] : null;
    const scopeAvailable = key === 'active_applications' || profileAvailable;
    const used = scopeAvailable && row?.success === true && Array.isArray(row.results) && row.results.length === 1 &&
      count(row.results[0]?.n) ? row.results[0].n : null;
    const published = QUOTA_DEFINITIONS[key].limits[effectivePlan];
    const planLimit = count(published) ? published : null;
    const betaLimit = key === 'own_working_offers' && positive(betaValue) ? betaValue : null;
    const rules = applicableRules(facts, context, capabilities[key]);
    const actionSpecificLimit = admissionCapabilities[key].some(capability =>
      applicableRules(facts, context, capability).some(rule => rule.effect === 'allow' && rule.limit_value != null));
    let limit = planLimit;
    let reasonCode = null;
    if (planLimit === null || facts.foundationMetadataAvailable !== true) { limit = null; reasonCode = 'authority_review_required'; }
    else if (actionSpecificLimit) { limit = null; reasonCode = 'action_specific_limit'; }
    else if (key === 'own_working_offers' && betaLimit === null) { limit = null; reasonCode = 'quota_limit_unavailable'; }
    else if (key === 'own_working_offers') limit = Math.min(planLimit, betaLimit);
    if (used === null) reasonCode = scopeAvailable ? 'quota_counter_unavailable' : 'quota_scope_unavailable';
    const remaining = used !== null && limit !== null ? Math.max(0, limit - used) : null;
    const restrictions = restrictionsFor(key, facts, context, rules);
    if (remaining === 0) restrictions.push('quota_exceeded');
    return { key, used, limit, remaining, planLimit, betaLimit,
      scope: definitions.get(capabilities[key]).resource_scope,
      status: used !== null && limit !== null ? 'available' : 'unavailable',
      reasonCode: reasonCode ?? restrictions[0] ?? 'capacity_available', restrictions,
      actionAdmissionRequired: true };
  });
  return freeze({ version: 1, actionAdmissionRequired: true, quotas });
}
