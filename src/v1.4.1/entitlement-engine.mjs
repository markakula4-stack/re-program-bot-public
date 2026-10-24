import { CAPABILITY_DEFINITIONS, FOUNDATION_POLICY_VERSION, FIXED_OPERATION_ALIASES,
  AUDIT_NAME_ALIASES, QUOTA_DEFINITIONS } from './capability-policy.mjs';
import { isTrustedContext, readTrustedContext, compileContextAssertions } from './trusted-context.mjs';
import { isTrustedActor, readActorFacts, readActorContext, compileAuthorityAssertions,
  compileAuthorityReplayAssertions } from './authority-resolver.mjs';
import { isTrustedResource, readResourceFacts, readResourceContext,
  compileResourceAssertions } from './resource-resolver.mjs';

// The engine reads only private, canonical request-local brands. It performs no
// IO, grants, reconciliation, provisioning, reservation or financial mutation.
export const ENTITLEMENT_ENGINE_VERSION = '2026-10-02.v1.4.1.p03';
const definitions = new Map(CAPABILITY_DEFINITIONS.map(row => [row.capability, row]));
const decisions = new WeakMap();
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
};
const positive = value => Number.isSafeInteger(value) && value > 0;
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
// These are authenticated transports, not caller-supplied policy channels.
// Existing AI tools reuse their customer's authenticated originating context.
const channels = new Set(['telegram_command','telegram_callback','mini_app','http','service']);
const normalizeOperation = key => Object.hasOwn(FIXED_OPERATION_ALIASES,key) ? FIXED_OPERATION_ALIASES[key] :
  Object.hasOwn(AUDIT_NAME_ALIASES,key) ? AUDIT_NAME_ALIASES[key] : key;
const epoch = value => {
  if (value === null || value === undefined) return null;
  if (positive(value)) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d(?:T| )\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z)?$/u.test(value)) return NaN;
  const parsed = Date.parse(value.replace(' ', 'T').replace(/(?<!Z)$/u, 'Z'));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : NaN;
};
const bit = value => value === true || value === 1;
const policyPlan = facts => facts.access?.status === 'verified' && facts.access.effectivePlan === 'free' &&
  facts.access.accessOverlay === 'dragon_preview' ? 'preview' : facts.access?.effectivePlan;

// These are existing non-commercial operations, not a caller-selected bypass.
const reviewProtected = new Set([
  'account.register', 'terms.read', 'terms.accept', 'profile.read_own', 'profile.update_own',
  'access.read_own', 'referral.link.read_own', 'referral.stats.read_own', 'referral.bonus.claim_own',
  'notification.read_own', 'notification.settings.update_own', 'partner.apply',
  'partner.legal_declare_own', 'partner.public_username.update_own', 'partner.link.manage_own',
  'offer.read_own', 'application.read_own', 'application.read_attributed', 'campaign.read_own',
  'analytics.read_personal', 'privacy.read_own', 'privacy.export_own', 'privacy.clear_ai_own',
  'privacy.request_delete_own', 'billing.read_history_own', 'billing.payment_help',
  'billing.request_refund_own', 'support.basic', 'ai.settings.update_own', 'ai.consent.manage_own',
  'ai.memory.read_own', 'ai.memory.clear_own', 'catalog.preference.read_own',
  'catalog.preference.update_own', 'notification.manage_own', 'account.menu.read',
  'help.read', 'flow.cancel_own', 'channel.check_membership',
]);
const privacyExceptions = new Set(['privacy.read_own', 'privacy.export_own', 'privacy.clear_ai_own',
  'privacy.request_delete_own']);
const preregistration = new Set(['account.register', 'terms.accept']);
const safePublic = new Set(['terms.read', 'help.read']);
const metadataFallback = new Set(['terms.read','terms.accept','help.read','support.basic',
  'privacy.read_own','privacy.export_own','privacy.clear_ai_own','privacy.request_delete_own',
  'billing.payment_help','billing.read_history_own','billing.request_refund_own',
  'profile.read_own','access.read_own','notification.read_own','offer.read_own',
  'application.read_own','application.read_attributed','campaign.read_own']);
const essentialMaintenance = new Set(['service.preview.expire','service.stars.reconcile',
  'service.stars.expire','service.stars.process_event','service.referral.settle',
  'service.privacy.cleanup','service.ai.settle_cost']);
const offerWrites = new Set(['offer.create_private', 'offer.edit_own', 'offer.submit_moderation',
  'offer.pause_own', 'offer.archive_own', 'offer.activate_own']);
const campaignWrites = new Set(['campaign.create_draft', 'campaign.edit_draft', 'campaign.activate',
  'campaign.resume', 'campaign.pause', 'campaign.archive', 'campaign.tracking_code.issue',
  'campaign.tracking_code.revoke']);
const reducing = new Set(['offer.pause_own', 'offer.archive_own', 'campaign.pause', 'campaign.archive']);
const visibleOffer = new Set(['offer.read_public', 'offer.read_assigned', 'offer.open_action']);
const resourceRequired = definition => /^(?:offer\.|application\.|campaign\.|admin\.|service\.)/u.test(definition.capability) ||
  ['partner.legal_declare_own', 'partner.link.manage_own', 'notification.manage_own',
    'ai.public_chat', 'ai.official_source.read', 'ai.partner_draft', 'ai.partner_draft.read',
    'ai.partner_draft.edit', 'ai.partner_draft.prepare_share', 'ai.provider.external.use',
    'billing.purchase_monthly', 'preview.activate_own','analytics.compare_periods'].includes(definition.capability);

const denied = (capability, reasonCode, details = {}) => freeze({version:1, capability,
  allowed:false, reasonCode, policyVersion:FOUNDATION_POLICY_VERSION, effectivePlan:null,
  accessState:null, validUntil:null, quota:null, actionPolicy:'deny', ...details});
const scopedMetadata = (row, capability, actor, resource, context) => {
  if (row?.capability !== capability || row.policy_version !== FOUNDATION_POLICY_VERSION ||
      row.sourceVerified !== true || row.subject_telegram_id !== context.telegramId) return false;
  const start = row.startsAt ?? row.starts_at, end = row.expiresAt ?? row.expires_at;
  if (!positive(start) || start > context.nowSeconds || end !== null && end !== undefined &&
      (!positive(end) || end <= context.nowSeconds) || (row.revokedAt ?? row.revoked_at) != null) return false;
  const kind = row.scopeKind ?? row.scope_kind, key = row.scopeKey ?? row.scope_key;
  if (kind === 'actor') return key === `actor:${context.telegramId}`;
  if (kind === 'tenant') return key === `bot:${context.botId}`;
  return Boolean(resource && kind === 'resource' && key === `${resource.kind}:${resource.ref}`);
};

function resourceScope(definition, facts, resource, context) {
  if (!resource) return resourceRequired(definition) ? false : true;
  if (resource.exists !== true || resource.subjectTelegramId !== context.telegramId) return false;
  if (['offer_collection','application_collection'].includes(resource.kind)) {
    const members = resource.canonical?.members, domain = resource.domain ?? {}, payload = context.requestPayload;
    const view = domain.collectionView, capability = definition.capability;
    const expected = resource.kind === 'offer_collection' ?
      { mine:'offer.read_own', catalog:'offer.read_public' } :
      { mine:'application.read_own', attributed:'application.read_attributed' };
    if (domain.collectionScopeVerified !== true || expected[view] !== capability || resource.ref !== view ||
        !Array.isArray(members) || members.length > 50 || !Array.isArray(payload?.selectedKeys) ||
        payload.selectedKeys.length !== members.length || new Set(payload.selectedKeys).size !== members.length ||
        members.some(member => !payload.selectedKeys.includes(member.key))) return false;
    if (!members.length) return view === 'catalog' ? domain.emptyVisibleCollectionVerified === true : domain.emptyOwnCollectionVerified === true;
    if (resource.kind === 'offer_collection' && view === 'mine') return positive(facts.partner?.profileId) &&
      members.every(member => member.ownerKind === 'partner' && member.ownerTelegramId === context.telegramId && member.partnerProfileId === facts.partner.profileId);
    if (resource.kind === 'offer_collection') return domain.allMembersVisible === true && members.every(member =>
      member.publicEligible === true && member.windowValid === true &&
      (member.visibility === 'public' || member.visibility === 'assigned' && member.assignedTelegramId === context.telegramId));
    if (view === 'mine') return members.every(member => member.ownerTelegramId === context.telegramId);
    return positive(facts.partner?.profileId) && members.every(member => member.attributedPartnerProfileId === facts.partner.profileId);
  }
  const scope = definition.resource_scope;
  if (scope === 'public_document') return ['actor','public_document','public_help'].includes(resource.kind);
  if (scope === 'public_or_own_safe_help' || scope === 'own_ticket_or_public_help') {
    return resource.ownerTelegramId === context.telegramId || resource.kind === 'public_help';
  }
  if (scope === 'public_approved') return resource.visibility === 'public' && resource.publicEligible === true;
  if (scope === 'exact_assignment') return resource.assignedTelegramId === context.telegramId && resource.publicEligible === true;
  if (scope === 'own_applicant_visible_offer') return resource.ownerTelegramId === context.telegramId && resource.publicEligible === true;
  if (scope === 'current_visible_approved_route') {
    return resource.publicEligible === true && (resource.visibility === 'public' || resource.assignedTelegramId === context.telegramId);
  }
  if (scope === 'exact_partner_attribution') return positive(facts.partner?.profileId) &&
    (resource.attribution?.partnerProfileId ?? resource.attributedPartnerProfileId) === facts.partner.profileId;
  if (scope === 'explicit_verified_admin_target') return facts.canonicalOwner === true && resource.domain?.targetVerified === true;
  if (scope === 'canonical_resource_for_exact_trusted_purpose') return resource.domain?.canonicalServiceResource === true;
  if (scope === 'approved_allowlisted_source') return resource.domain?.approvedAllowlistedSource === true;
  if (scope === 'own_or_existing_partner_projection' || scope === 'own_partner_projection') {
    return resource.ownerTelegramId === context.telegramId && (scope !== 'own_partner_projection' ||
      positive(facts.partner?.profileId) && resource.partnerProfileId === facts.partner.profileId);
  }
  if (scope.includes('partner_profile') || scope === 'own_existing_partner_offer') {
    return positive(facts.partner?.profileId) && resource.partnerProfileId === facts.partner.profileId &&
      resource.ownerTelegramId === context.telegramId;
  }
  if (scope === 'own_ambassador_profile') return resource.ownerTelegramId === context.telegramId &&
    positive(facts.partner?.profileId) && resource.partnerProfileId === facts.partner.profileId;
  return resource.ownerTelegramId === context.telegramId;
}

function betaAllowed(facts, capability, context) {
  const settings = facts.partner?.betaSettings, access = facts.partner?.betaAccess;
  const end = epoch(access?.expires_at ?? access?.expiresAt);
  if (context.env.PARTNER_BETA_ENABLED !== 'true' || context.env.PARTNER_PRIVATE_OFFERS_ENABLED !== 'true' ||
      !settings || !access || !bit(settings.enabled) || !bit(settings.private_offers_enabled ?? settings.privateOffersEnabled) ||
      (access.access_status ?? access.accessStatus) !== 'active' || Number.isNaN(end) || end !== null && end <= context.nowSeconds) return false;
  if (capability === 'offer.submit_moderation') return context.env.PARTNER_OFFER_SUBMISSIONS_ENABLED === 'true' &&
    bit(settings.submissions_enabled ?? settings.submissionsEnabled) &&
    bit(access.can_submit_offers ?? access.canSubmitOffers);
  return bit(access.can_create_private_offers ?? access.canCreatePrivateOffers);
}

function domainFailure(definition, facts, resource, context) {
  const capability = definition.capability, domain = resource?.domain ?? {};
  if (domain.emergencyDisabled === true || domain.handlerUnavailable === true) return 'feature_unavailable';
  if (preregistration.has(capability)) {
    if (domain.fixedPreregistrationAction === false || domain.antiAbuseAllowed === false) return 'prerequisite_required';
  }
  if (capability === 'partner.apply' && domain.ageConfirmedIntent !== true &&
      context.requestPayload?.ageConfirmed !== true) return 'prerequisite_required';
  if (['partner.legal_declare_own','partner.link.manage_own'].includes(capability) &&
      (facts.partner?.status !== 'active' || !positive(facts.partner.profileId))) return 'prerequisite_required';
  if (capability === 'partner.public_username.update_own' && domain.enablingUsername === true &&
      domain.usernameExists !== true) return 'prerequisite_required';
  if (visibleOffer.has(capability)) {
    if (resource.windowValid !== true || resource.publicEligible !== true) return 'resource_unavailable';
    if (domain.ownerKind === 'partner' && (context.env.PARTNER_BETA_ENABLED !== 'true' ||
        context.env.PARTNER_PRIVATE_OFFERS_ENABLED !== 'true' || resource.visibility === 'public' &&
        context.env.PARTNER_OFFER_PUBLIC_VISIBILITY_ENABLED !== 'true')) return 'feature_unavailable';
  }
  if (offerWrites.has(capability)) {
    if (facts.roles.includes('admin')) return 'role_required';
    if (context.env.REBUILD_V140_ALL_ACCESS_DISABLED === 'true') return 'feature_unavailable';
    if (capability !== 'offer.archive_own' && (facts.partner?.status !== 'active' ||
        facts.partner.ageConfirmed !== true || facts.partner.approvedApplication !== true)) return 'prerequisite_required';
    // Archive has its own reducing contour, preserving emergency/domain guards
    // while not requiring permission to create or submit commercial content.
    if (capability !== 'offer.archive_own' && (!facts.legalProfile ||
        facts.legalProfile.verificationState !== 'self_declared' || !betaAllowed(facts,capability,context))) {
      return 'prerequisite_required';
    }
    if (capability !== 'offer.create_private' && (!resource.version || !positive(resource.version.currentId) ||
        resource.version.hashValid !== true)) return 'state_conflict';
    if (domain.transitionValid === false) return 'state_conflict';
    if (capability !== 'offer.create_private' && domain.moderationPending === true) return 'state_conflict';
    if (domain.expectedVersionMismatch === true || resource.expectedVersionId != null &&
        resource.expectedVersionId !== resource.version?.currentId) return 'state_conflict';
    // Existing business activation appends a private version. Public release is
    // a separate admin moderation/visibility operation, never implied here.
    if (capability === 'offer.activate_own' && (resource.status === 'archived' ||
        !(resource.route?.approved === true && resource.route.domainAllowed === true && resource.route.ownerMatches === true))) return 'state_conflict';
    const statuses = { 'offer.edit_own':['draft','paused','active'], 'offer.submit_moderation':['draft','paused','active'],
      'offer.pause_own':['active','paused'], 'offer.archive_own':['draft','active','paused','archived'],
      'offer.activate_own':['draft','paused','active'] };
    if (statuses[capability] && !statuses[capability].includes(resource.status)) return 'state_conflict';
  }
  if (capability === 'application.create' || capability === 'application.resubmit') {
    if (resource.publicEligible !== true || resource.selfApplication === true || domain.attributionConflict === true ||
        domain.attributionMatches === false) return 'prerequisite_required';
    if (capability === 'application.resubmit' && resource.status !== 'rejected' &&
        resource.operationFacts?.replayAcknowledgement !== true) return 'state_conflict';
  }
  if (campaignWrites.has(capability)) {
    if (domain.approvedIssuerRoute !== true || domain.scopeEligible !== true) return 'prerequisite_required';
    const states = {'campaign.edit_draft':['draft'], 'campaign.activate':['draft'], 'campaign.resume':['paused'],
      'campaign.pause':['active','paused'], 'campaign.archive':['draft','active','paused','archived']};
    if (states[capability] && !states[capability].includes(resource.status)) return 'state_conflict';
    if (domain.expectedVersionMismatch === true || domain.transitionInvalid === true) return 'state_conflict';
  }
  if (definition.capability.startsWith('admin.')) {
    if (facts.canonicalOwner !== true) return 'role_required';
    if (domain.targetVerified !== true) return 'resource_unavailable';
    if (capability !== 'admin.cabinet.open' && (domain.actionConfirmed !== true || domain.reasonPresent !== true ||
        domain.domainAuthorityValid !== true)) return 'prerequisite_required';
    if (['admin.entitlement.manage','admin.feature_flags.manage'].includes(capability) &&
        (domain.internalWriterReleased !== true || domain.publishedPolicyBoundaries !== true ||
          domain.temporaryExpiryValid !== true || domain.authenticatedIssuer !== true)) return 'feature_unavailable';
  }
  if (capability === 'preview.activate_own' && (facts.access?.effectivePlan !== 'free' ||
      domain.previewEligible !== true || domain.membershipVerified !== true || domain.explicitActivation !== true)) return 'prerequisite_required';
  if (privacyExceptions.has(capability) && ['privacy.clear_ai_own','privacy.request_delete_own'].includes(capability) &&
      domain.destructiveConfirmation !== true) return 'prerequisite_required';
  if (capability === 'billing.purchase_monthly' && (domain.starsPurchaseReleased !== true ||
      domain.pricebookVerified !== true || domain.actionConfirmed !== true)) return 'feature_unavailable';
  return null;
}

function quotaDecision(definition, facts, resource, effectivePlan, context, limitOverride = null) {
  const key = definition.quota_observe_key ?? definition.quota_key;
  if (!key || !['active_applications','own_working_offers','active_campaigns'].includes(key)) {
    return {key:null, limit:null, delta:0, quota:null, actionPolicy:'allow'};
  }
  const used = resource?.usage?.[key], limit = limitOverride ?? QUOTA_DEFINITIONS[key]?.limits?.[effectivePlan];
  if (!count(used) || !count(limit)) return {reason:'unavailable'};
  const replay = resource.operationFacts?.replayAcknowledgement === true && resource.operationFacts?.receiptVerified === true;
  let delta = 0;
  if (!replay) {
    if (['offer.create_private','application.create','application.resubmit','campaign.activate','campaign.resume'].includes(definition.capability)) delta = 1;
    if (definition.capability === 'application.create' && ['pending','confirmed'].includes(resource.status) &&
        resource.ownerTelegramId === context.telegramId && resource.domain?.existingIdenticalApplication === true) delta = 0;
    if (definition.capability === 'offer.archive_own' && resource.status !== 'archived') delta = -1;
    if (['campaign.pause','campaign.archive'].includes(definition.capability) && resource.status === 'active') delta = -1;
  }
  if (resource.quotaDelta != null && resource.quotaDelta !== delta) return {reason:'state_conflict'};
  const createsOffer = definition.capability === 'offer.create_private';
  const betaLimit = createsOffer ? facts.partner?.betaSettings?.max_active_offers_per_partner ??
    facts.partner?.betaSettings?.maxActiveOffersPerPartner : null;
  if (createsOffer && !positive(betaLimit)) return {reason:'unavailable'};
  const publicLimit = createsOffer ? Math.min(limit,betaLimit) : limit;
  const quota = freeze({limit:publicLimit,used,remaining:Math.max(0,publicLimit-used),resetsAt:null,scope:definition.resource_scope});
  if (replay) return {key,limit,delta:0,quota,actionPolicy:'replay_acknowledgement'};
  if (reducing.has(definition.capability)) return {key,limit,delta,quota,actionPolicy:'fixed_reduction'};
  if (definition.capability === 'campaign.create_draft') return {key,limit,delta:0,quota,actionPolicy:'no_active_slot_charge'};
  // Preserve the separate existing Beta cap, including draft/paused objects.
  if (createsOffer && used + delta > betaLimit) return {reason:'quota_exceeded',key,limit,delta,quota,actionPolicy:'beta_cap'};
  if (delta > 0 && used + delta > limit || delta === 0 && used > limit) return {reason:'quota_exceeded',key,limit,delta,quota,actionPolicy:'read_only'};
  return {key,limit,delta,quota,actionPolicy:'allow'};
}

function manualQuotaLimit(definition, rules) {
  const numeric = rules.filter(row => row.effect === 'allow' && row.limit_value != null);
  if (!numeric.length) return {limit:null};
  const key = definition.quota_observe_key ?? definition.quota_key;
  const published = QUOTA_DEFINITIONS[key]?.limits;
  if (!published || !['active_applications','own_working_offers','active_campaigns'].includes(key)) return {invalid:true};
  const max = Math.max(...Object.values(published));
  if (numeric.some(row => !count(row.limit_value) || row.limit_value > max)) return {invalid:true};
  const rank = {actor:1,tenant:2,resource:3};
  const highest = Math.max(...numeric.map(row => rank[row.scopeKind ?? row.scope_kind] ?? 0));
  const selected = numeric.filter(row => rank[row.scopeKind ?? row.scope_kind] === highest);
  const values = new Set(selected.map(row => row.limit_value));
  return values.size === 1 ? {limit:selected[0].limit_value} : {invalid:true};
}

function flagFailure(facts, capability, context) {
  const rows = (facts.currentFlags ?? []).filter(flag =>
    flag.flag_key === 'v1.4.1.global' || flag.flag_key === `capability:${capability}`);
  for (const flag of rows) {
    if (flag.sourceVerified !== true || flag.policy_version !== FOUNDATION_POLICY_VERSION || flag.emergency_disabled !== 0 || flag.enabled !== 1) return true;
    let rule;
    try { rule = JSON.parse(flag.rollout_json); } catch { return true; }
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) ||
        Object.keys(rule).some(key => key !== 'mode')) return true;
    const mode = Object.hasOwn(rule,'mode') ? rule.mode : 'all';
    if (mode === 'all') continue;
    if (mode === 'admin' && facts.canonicalOwner === true) continue;
    if (mode === 'selected_actors' && (facts.verifiedAssignments ?? []).some(row =>
      row.sourceVerified === true && row.flag_key === flag.flag_key && row.subject_kind === 'actor' &&
      row.subject_key === `actor:${context.telegramId}` && row.subject_telegram_id === context.telegramId &&
      row.starts_at <= context.nowSeconds && row.expires_at > context.nowSeconds && row.revoked_at === null)) continue;
    return true;
  }
  return false;
}

function aiFailure(definition, facts, resource, effectivePlan) {
  const capability = definition.capability;
  if (!['ai.public_chat','ai.official_source.read','ai.partner_draft','ai.partner_draft.read',
    'ai.partner_draft.edit','ai.partner_draft.prepare_share','ai.provider.external.use'].includes(capability)) return null;
  const ai = resource?.ai ?? resource?.domain?.ai;
  if (!ai) return {reason:'feature_unavailable'};
  if (capability === 'ai.official_source.read') {
    if (ai.rolloutAllowed !== true || ai.sourceAllowlisted !== true || ai.contentTimeoutGuards !== true) return {reason:'feature_unavailable'};
    if (ai.technicalThrottleAllowed !== true) return {reason:'quota_exceeded'};
    return null;
  }
  if (ai.rolloutAllowed !== true || ai.masterEnabled !== true || ai.schemaReady !== true) return {reason:'feature_unavailable'};
  if (ai.consentValid !== true || ai.modelAllowed !== true || facts.ai?.consent == null) return {reason:'prerequisite_required'};
  if (capability === 'ai.public_chat' && (ai.dlpPassed !== true || ai.confirmationSatisfied !== true)) return {reason:'prerequisite_required'};
  if (capability !== 'ai.public_chat' && (facts.canonicalOwner !== true || ai.closedOwnerMatches !== true ||
      ai.dlpPassed !== true || ai.confirmationSatisfied !== true)) return {reason:'prerequisite_required'};
  if (ai.inFlight === true) return {reason:'in_progress'};
  const invokesProvider = ['ai.public_chat','ai.partner_draft','ai.provider.external.use'].includes(capability);
  if (invokesProvider && (ai.providerBudgetAvailable !== true || ai.costCeilingAllowed !== true)) return {reason:'provider_budget_exhausted'};
  const q = ai.quota;
  if (capability === 'ai.public_chat') {
    if (facts.ai?.enabledPreference !== true || ai.toggleEnabled !== true) return {reason:'prerequisite_required'};
    if (facts.canonicalOwner === true) return null;
    const limit = effectivePlan === 'preview' ? 30 : q?.publicSuccessLimit;
    if (!count(limit) || !count(q?.publicSuccessUsed)) return {reason:'unavailable'};
    const quota = {limit,used:q.publicSuccessUsed,remaining:Math.max(0,limit-q.publicSuccessUsed),
      resetsAt:positive(q.resetsAt) ? q.resetsAt : null,scope:'own_chat'};
    return {reason:q.publicSuccessUsed >= limit ? 'quota_exceeded' : null,quota,
      key:'public_ai_success_daily',limit,delta:1};
  } else if (['ai.partner_draft','ai.provider.external.use'].includes(capability)) {
    if (![q?.partnerDailyUsed,q?.partnerDailyLimit,q?.partnerCycleUsed,q?.partnerCycleLimit].every(count)) return {reason:'unavailable'};
    if (q.partnerDailyUsed >= q.partnerDailyLimit || q.partnerCycleUsed >= q.partnerCycleLimit) return {reason:'quota_exceeded'};
  }
  return null;
}

export function can(actor, requestedCapability, resource = null) {
  const capability = typeof requestedCapability === 'string' ? normalizeOperation(requestedCapability) : null;
  const definition = definitions.get(capability);
  if (!definition) return denied(capability && capability.length <= 128 ? capability : null,'feature_unavailable');
  if (!isTrustedActor(actor)) return denied(capability,'unauthorized');
  const contextHandle = readActorContext(actor), context = readTrustedContext(contextHandle), facts = readActorFacts(actor);
  if (!isTrustedContext(contextHandle) || !context || !facts || !channels.has(context.channel) ||
      !positive(context.nowSeconds) || !positive(context.telegramId) && !['trusted_service','service'].includes(facts.actorKind) ||
      normalizeOperation(context.operation) !== capability) return denied(capability,'unauthorized');
  const resourceFacts = resource == null ? null : isTrustedResource(resource) && readResourceContext(resource) === contextHandle
    ? readResourceFacts(resource) : null;
  const resourceDeadline = resourceFacts ? compileResourceAssertions(resource).validUntil : null;
  const validUntil = Math.min(...[context.expiresAt,facts.validUntil,resourceDeadline]
    .filter(positive));
  let numeric = {key:null,limit:null,delta:0,quota:null,actionPolicy:'allow'};
  const finish = (allowed, reasonCode, extra = {}, redact = false) => {
    const dto = freeze({version:1,capability,allowed,reasonCode,policyVersion:FOUNDATION_POLICY_VERSION,
      effectivePlan:redact ? null : policyPlan(facts) ?? null,
      accessState:redact ? null : facts.access?.accessState ?? null,
      validUntil:redact || !Number.isFinite(validUntil) ? null : validUntil,
      quota:redact ? null : numeric.quota,actionPolicy:allowed ? numeric.actionPolicy : 'deny',...extra});
    const privateFacts = freeze({publicDTO:dto,actor,resource,context:contextHandle,capability,
      quotaKey:numeric.key,quotaLimit:numeric.limit,quotaDelta:numeric.delta,
      overcapActionPolicy:definition.overcap_action_policy ?? null,operation:context.operation,
      evaluatedAt:context.nowSeconds,validUntil:Number.isFinite(validUntil) ? validUntil : context.nowSeconds,
      retentionUntil:null});
    decisions.set(dto,privateFacts);
    return dto;
  };
  if (definition.availability === 'future_disabled') return finish(false,'feature_unavailable',{},true);
  if (facts.policyVersion !== FOUNDATION_POLICY_VERSION || facts.nowSeconds !== context.nowSeconds ||
      !Number.isFinite(validUntil) || validUntil <= context.nowSeconds) return finish(false,'authority_review_required',{},true);
  const protectedFallback = facts.protectedAuthorityFallback === true && metadataFallback.has(capability) ||
    facts.essentialServiceAuthorityFallback === true && essentialMaintenance.has(capability);
  if (facts.policyCapability !== capability || facts.policyReady !== true && !protectedFallback) return finish(false,'authority_review_required',{},true);
  if (resource !== null && !resourceFacts || resourceRequired(definition) && !resourceFacts || resourceFacts &&
      (resourceFacts.capability !== capability || normalizeOperation(resourceFacts.operation) !== capability ||
        resourceFacts.requestId !== context.requestId || resourceFacts.observedAt !== context.nowSeconds)) {
    return finish(false,'resource_unavailable',{},true);
  }
  const service = definition.actor_kind === 'trusted_service';
  if (service) {
    if (!['trusted_service','service'].includes(facts.actorKind) || context.actorKind !== 'service' ||
        context.purpose !== definition.trusted_purpose || resourceFacts.domain?.trustedPurpose !== context.purpose ||
        resourceFacts.domain?.canonicalServiceResource !== true || resourceFacts.domain?.sourceReceiptVerified !== true) {
      return finish(false,'unauthorized',{},true);
    }
    if (!essentialMaintenance.has(capability) && flagFailure(facts,capability,context)) return finish(false,'feature_unavailable');
    return finish(true,'allowed');
  }
  if (['trusted_service','service'].includes(facts.actorKind) || context.actorKind === 'service') return finish(false,'unauthorized',{},true);
  if (!resourceScope(definition,facts,resourceFacts,context)) return finish(false,'resource_unavailable',{},true);
  const account = facts.account;
  if (!account || account.isBlocked === true || account.pendingDeletion === true) {
    if (!privacyExceptions.has(capability) && !safePublic.has(capability) && resourceFacts?.domain?.existingAccountException !== capability) {
      return finish(false,'account_restricted');
    }
  }
  if (!preregistration.has(capability) && !safePublic.has(capability) && !privacyExceptions.has(capability) &&
      (account.exists !== true || account.acceptedTerms !== true)) return finish(false,'prerequisite_required');
  const roles = Array.isArray(facts.roles) ? facts.roles : [];
  if (!preregistration.has(capability) && !safePublic.has(capability) && !privacyExceptions.has(capability) &&
      !definition.roles.some(role => roles.includes(role))) return finish(false,'role_required');
  const domainReason = domainFailure(definition,facts,resourceFacts,context);
  if (domainReason) return finish(false,domainReason);
  if (flagFailure(facts,capability,context)) return finish(false,'feature_unavailable');
  const rules = [...(facts.overrides ?? []),...(facts.grants ?? [])]
    .filter(row => scopedMetadata(row,capability,facts,resourceFacts,context));
  if (rules.some(row => row.effect === 'deny' || row.effect_kind === 'deny' || row.decision === 'deny')) return finish(false,'access_required');
  const manualAllow = rules.some(row => row.effect === 'allow' || row.effect_kind === 'allow' || row.decision === 'allow' ||
    ['manual_capability','verified_existing_source'].includes(row.source_kind));
  const limitOverride = manualQuotaLimit(definition,rules);
  if (limitOverride.invalid) return finish(false,'authority_review_required');
  const replay = resourceFacts?.operationFacts?.replayAcknowledgement === true && resourceFacts.operationFacts.receiptVerified === true;
  const effectivePlan = policyPlan(facts);
  if (!['free','preview','professional','dragon'].includes(effectivePlan)) return finish(false,'authority_review_required');
  const closedAdminAi = capability.startsWith('ai.partner_draft') || capability === 'ai.provider.external.use';
  if ((facts.access.storedState === 'suspended' || facts.access.accessState === 'suspended') &&
      !reviewProtected.has(capability) && !reducing.has(capability) && !capability.startsWith('admin.') &&
      !(closedAdminAi && facts.canonicalOwner === true)) return finish(false,'account_restricted');
  if (facts.access.status !== 'verified' && !reviewProtected.has(capability) && !capability.startsWith('admin.') &&
      !(closedAdminAi && facts.canonicalOwner === true) &&
      !reducing.has(capability) && !replay && !manualAllow) return finish(false,'authority_review_required');
  if (definition.plan_allow[effectivePlan] !== true && !manualAllow && !replay) return finish(false,'access_required');
  numeric = quotaDecision(definition,facts,resourceFacts,effectivePlan,context,limitOverride.limit);
  if (numeric.reason) return finish(false,numeric.reason,{quota:numeric.quota ?? null,actionPolicy:numeric.actionPolicy ?? 'deny'});
  const ai = aiFailure(definition,facts,resourceFacts,effectivePlan);
  if (ai?.reason) return finish(false,ai.reason,{quota:ai.quota ? freeze(ai.quota) : numeric.quota});
  if (ai?.quota) numeric = {...numeric,key:ai.key,limit:ai.limit,delta:ai.delta,quota:freeze(ai.quota)};
  return finish(true,'allowed');
}

export const isTrustedDecision = value => Boolean(value && decisions.has(value));
export const readDecisionFacts = value => decisions.get(value) ?? null;
export const readDecisionContext = value => decisions.get(value)?.context ?? null;

export function compileDecisionAssertions(decision) {
  const facts = decisions.get(decision);
  if (!facts || !isTrustedActor(facts.actor) || !isTrustedContext(facts.context)) throw new Error('untrusted_decision');
  const replay = facts.publicDTO.actionPolicy === 'replay_acknowledgement';
  const producers = [compileContextAssertions(facts.context),
    (replay ? compileAuthorityReplayAssertions : compileAuthorityAssertions)(facts.actor)];
  if (facts.resource) producers.push(compileResourceAssertions(facts.resource));
  const assertions = [];
  for (const producer of producers) {
    const pieces = Array.isArray(producer?.assertions) ? producer.assertions : [producer];
    for (const piece of pieces) {
      if (typeof piece?.sql !== 'string' || !piece.sql || !Array.isArray(piece.params) || piece.params.length > 99) {
        throw new Error('invalid_decision_assertion');
      }
      assertions.push(freeze({sql:piece.sql,params:[...piece.params]}));
    }
  }
  const params = assertions.flatMap(piece => piece.params);
  return freeze({sql:params.length <= 99 ? assertions.map(piece => `(${piece.sql})`).join(' AND ') : null,
    params:params.length <= 99 ? params : [],assertions});
}
