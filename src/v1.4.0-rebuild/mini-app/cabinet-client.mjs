// Browser transport. Entry defaults stay closed; P09 session features may
// enable controls only after a real, atomic server authentication response.
export const CABINET_UI_VERSION = "2026-10-01.v1.4.0-rebuild-p12-kaspload";
const API = "/api/v1.4.0/cabinet/";
const MAX_BODY = 32_768;
const TOKEN = /^rpms1_[A-Za-z0-9_-]{43}$/u;
const CODE = /^[a-z0-9_-]{3,24}$/u;
const SECTIONS = ["profile", "offers", "applications", "analytics", "subscription"];
const REFERRAL_TEXT = "Откройте RE Program: проверенные партнёрские программы и предложения.";
const ownReferralUrl = value => typeof value === "string" &&
  /^https:\/\/t\.me\/RE_Program_Bot\?start=partner_[A-Za-z0-9_-]{1,56}$/u.test(value);
const OFFER_FIELDS = ["buttonText", "title", "description", "provider", "category",
  "payoutText", "requiredAction", "minAge", "maxAge", "geo", "holdDays",
  "trafficSources", "sourceName", "startsAt", "expiresAt", "partnerLinkId"];

export class CabinetClientError extends Error {
  constructor(code, status = 0, authorization = null) {
    super(code);
    this.name = "CabinetClientError";
    this.code = code;
    this.status = status;
    this.authorization = authorization;
  }
}
const fail = (code, status, authorization) => { throw new CabinetClientError(code, status, authorization); };
const positive = (value) => {
  if (!Number.isSafeInteger(value) || value <= 0) fail("invalid_request");
  return value;
};
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const subscriptionPrincipal = value => object(value) && Object.keys(value).length === 2 &&
  ['telegramId', 'botId'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0)
  ? Object.freeze({ telegramId: value.telegramId, botId: value.botId }) : null;
const sameSubscriptionPrincipal = (a, b) => a !== null && b !== null &&
  a.telegramId === b.telegramId && a.botId === b.botId;
const cancellationPredecessor = marker => {
  const value = marker?.reconfirm;
  return marker?.kind === 'cancel' && object(value) && Object.keys(value).length === 3 &&
    ['originalKey', 'originalStartedAt', 'stage'].every(key => Object.hasOwn(value, key)) &&
    /^[a-f0-9]{48}$/u.test(value.originalKey) && value.originalKey !== marker.key &&
    Number.isSafeInteger(value.originalStartedAt) && value.originalStartedAt > 0 && value.originalStartedAt <= marker.startedAt &&
    ['handoff', 'admitted', 'producer'].includes(value.stage) && subscriptionPrincipal(marker.principal)
    ? Object.freeze({ ...value }) : null;
};
const readClientFeatures = value => {
  const fields = ["version", "mutationsEnabled", "offerActionsEnabled", "existingRenewalCancellationEnabled", "nativeOwnerInvoiceOnly"];
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key)) || value.version !== 1 ||
      typeof value.mutationsEnabled !== "boolean" || typeof value.offerActionsEnabled !== "boolean" ||
      Object.hasOwn(value, "existingRenewalCancellationEnabled") && typeof value.existingRenewalCancellationEnabled !== "boolean" ||
      Object.hasOwn(value, "nativeOwnerInvoiceOnly") && typeof value.nativeOwnerInvoiceOnly !== "boolean")
    fail("invalid_response");
  return value;
};
const exact = (payload, fields) => {
  if (!object(payload) || Object.keys(payload).some(key => !fields.includes(key))) {
    fail("invalid_request");
  }
  return structuredClone(payload);
};
const offerCode = value => { if (!CODE.test(value)) fail("invalid_request"); return value; };

// Server decisions explain an operation; they never confer client authority.
// Keep this independent of private policy/source facts and reject extra fields.
export function readAuthorizationDTO(value, expectedCapability = null) {
  const fields = ["version", "capability", "allowed", "reasonCode", "policyVersion",
    "effectivePlan", "accessState", "validUntil", "quota", "actionPolicy"];
  const text = (item, max = 96) => typeof item === "string" && item.length <= max &&
    /^[a-zA-Z0-9_.:-]+$/u.test(item);
  const time = item => item === null || Number.isSafeInteger(item) && item > 0;
  const count = item => Number.isSafeInteger(item) && item >= 0 && item <= 1_000_000_000;
  if (!object(value) || Object.keys(value).length !== fields.length ||
      fields.some(key => !Object.hasOwn(value, key)) || value.version !== 1 ||
      !text(value.capability) || expectedCapability !== null && value.capability !== expectedCapability ||
      typeof value.allowed !== "boolean" || !text(value.reasonCode) || !text(value.policyVersion, 128) ||
      ![null, "free", "preview", "professional", "dragon"].includes(value.effectivePlan) ||
      !(value.accessState === null || text(value.accessState, 64)) || !time(value.validUntil) ||
      !text(value.actionPolicy, 64)) fail("invalid_response");
  let quota = null;
  if (value.quota !== null) {
    const q = value.quota;
    if (!object(q) || Object.keys(q).length !== 5 ||
        ["limit", "used", "remaining", "resetsAt", "scope"].some(key => !Object.hasOwn(q, key)) ||
        !count(q.limit) || !count(q.used) || !count(q.remaining) ||
        q.remaining !== Math.max(0, q.limit - q.used) || !time(q.resetsAt) || !text(q.scope, 128)) {
      fail("invalid_response");
    }
    quota = Object.freeze({ ...q });
  }
  return Object.freeze({ ...value, quota });
}

// This own presentation descriptor never grants an action. Fixed commands
// independently compare consent with their fresh server price and authority.
export function readPackageSubscriptionDTO(value, { observedAt, validUntil, current = null } = {}) {
  const check = condition => { if (!condition) fail('invalid_response'); };
  const shape = (item, fields) => { const keys = fields.split(' '); check(object(item) && Object.keys(item).length === keys.length && keys.every(key => Object.hasOwn(item, key))); return item; };
  const positive = item => Number.isSafeInteger(item) && item > 0 && item <= 253_402_300_799;
  const code = item => typeof item === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(item);
  const reason = item => item === null || code(item);
  const bool = item => typeof item === 'boolean';
  const id = item => typeof item === 'string' && /^[a-f0-9-]{36}$/u.test(item);
  const plans = ['professional', 'dragon'], days = { '30d': 30, '3m': 90, '6m': 180, '12m': 360 };
  const action = (item, name, fields = '') => { shape(item, 'available reasonCode route actionAdmissionRequired' + fields);
    check(bool(item.available) && reason(item.reasonCode) && (item.available ? item.reasonCode === null : item.reasonCode !== null) &&
      item.route === '/packages/' + name && item.actionAdmissionRequired === true); };
  shape(value, 'version modelVersion authority accessAuthority observedAt validUntil canWrite available reasonCode offers paidPeriods transitions pendingInvoices terms');
  check(value.version === 1 && value.modelVersion === '2026-10-07.v1.4.4.p03' && value.authority === 'worker' && value.accessAuthority === false &&
    value.observedAt === observedAt && positive(value.validUntil) && value.validUntil > observedAt && value.validUntil <= validUntil &&
    bool(value.canWrite) && bool(value.available) && reason(value.reasonCode) && Array.isArray(value.offers) && value.offers.length <= 8 &&
    Array.isArray(value.paidPeriods) && value.paidPeriods.length <= 128 && Array.isArray(value.transitions) && value.transitions.length <= 128 &&
    Array.isArray(value.pendingInvoices) && value.pendingInvoices.length <= 128);
  const seenOffers = new Set();
  for (const item of value.offers) {
    shape(item, 'planCode packageCode durationDays periodSeconds published available reasonCode amountStars currency billingMode automaticRenewal freshConsentRequired priceVersion offerVersion campaignCode termsRevision terms priceComparison preview invoice schedule');
    const monthly = item.packageCode === '30d', key = item.planCode + ':' + item.packageCode;
    check(plans.includes(item.planCode) && Object.hasOwn(days, item.packageCode) && !seenOffers.has(key) && item.durationDays === days[item.packageCode] &&
      item.periodSeconds === item.durationDays * 86400 && bool(item.published) && item.available === item.published && reason(item.reasonCode) &&
      item.currency === 'XTR' && item.billingMode === (monthly ? 'recurring' : 'prepaid') && item.automaticRenewal === monthly && item.freshConsentRequired === monthly);
    seenOffers.add(key);
    check(item.published ? positive(item.amountStars) && positive(item.priceVersion) && code(item.offerVersion) && code(item.termsRevision) && item.reasonCode === null
      : item.amountStars === null && item.priceVersion === null && item.offerVersion === null && item.termsRevision === null && item.reasonCode !== null);
    check(item.campaignCode === null || typeof item.campaignCode === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(item.campaignCode));
    shape(item.terms, 'revision available accepted text telegramCommand');
    check(item.terms.revision === item.termsRevision && bool(item.terms.available) && bool(item.terms.accepted) &&
      item.terms.telegramCommand === '/terms');
    check(item.published ? typeof item.terms.text === 'string' && item.terms.text.length > 0 && item.terms.text.length <= 16384
      : item.terms.text === null && item.terms.available === false && item.terms.accepted === false);
    if (item.preview !== null) { shape(item.preview, 'startsAt endsAt datesAreEstimate validUntil');
      check(item.published && positive(item.preview.startsAt) && item.preview.startsAt >= observedAt &&
        item.preview.endsAt === item.preview.startsAt + item.periodSeconds && item.preview.datesAreEstimate === true &&
        positive(item.preview.validUntil) && item.preview.validUntil > observedAt && item.preview.validUntil <= value.validUntil); }
    else check(!item.published);
    if (item.priceComparison !== null) { shape(item.priceComparison, 'amountStars monthlyAmountStars periodCount basis currency');
      check(!monthly && item.published && positive(item.priceComparison.monthlyAmountStars) && item.priceComparison.periodCount === item.durationDays / 30 &&
        item.priceComparison.amountStars === item.priceComparison.monthlyAmountStars * item.priceComparison.periodCount &&
        item.priceComparison.basis === 'same_plan_monthly_equivalent' && item.priceComparison.currency === 'XTR'); }
    action(item.invoice, 'invoice'); action(item.schedule, 'schedule');
    if (item.invoice.available || item.schedule.available) check(value.canWrite && item.published && value.available);
    if (item.invoice.available) check(!monthly && item.terms.available);
  }
  const receipts = new Set();
  for (const item of value.paidPeriods) {
    shape(item, 'packageCode durationDays accessState startsAt endsAt receiptId planCode amountStars currency billingMode state grantsCurrentAccess');
    check(['3m', '6m', '12m'].includes(item.packageCode) && item.durationDays === days[item.packageCode] && plans.includes(item.planCode) && positive(item.amountStars) &&
      item.currency === 'XTR' && item.billingMode === 'prepaid' && /^stars-[a-f0-9]{16,64}$/u.test(item.receiptId) && !receipts.has(item.receiptId) &&
      positive(item.startsAt) && item.endsAt === item.startsAt + item.durationDays * 86400 && item.accessState === item.state &&
      ['current', 'future', 'expired', 'refunded', 'chargeback'].includes(item.state) && bool(item.grantsCurrentAccess));
    receipts.add(item.receiptId);
    check(item.state !== 'current' || item.startsAt <= observedAt && item.endsAt > observedAt);
    check(item.state !== 'future' || item.startsAt > observedAt); check(item.state !== 'expired' || item.endsAt <= observedAt);
    if (item.grantsCurrentAccess) check(item.state === 'current' && current?.status === 'verified' && current.sourceKind === 'package_payment' &&
      current.planCode === item.planCode && current.startsAt === item.startsAt && current.expiresAt === item.endsAt);
  }
  const transitions = new Set();
  for (const item of value.transitions) {
    shape(item, 'transitionId revision fromPlan toPlan packageCode billingMode durationDays effectiveAt state status sourceCompensated grantsAccess cancel monthlyCheckout');
    check(id(item.transitionId) && !transitions.has(item.transitionId) && positive(item.revision) && plans.includes(item.fromPlan) && plans.includes(item.toPlan) &&
      Object.hasOwn(days, item.packageCode) && item.durationDays === days[item.packageCode] && item.billingMode === (item.packageCode === '30d' ? 'recurring' : 'prepaid') &&
      positive(item.effectiveAt) && ['scheduled', 'cancelled', 'fulfilled'].includes(item.state) &&
      ['scheduled', 'cancelled', 'fulfilled', 'source_compensated', 'payment_recorded', 'manual_review', 'awaiting_payment', 'expired_reservation', 'ready_for_consent'].includes(item.status) &&
      bool(item.sourceCompensated) && item.grantsAccess === false); transitions.add(item.transitionId);
    action(item.cancel, 'cancel'); action(item.monthlyCheckout, 'monthly-invoice', ' freshConsentRequired amountStars currency termsRevision priceVersion invoiceUrl expiresAt');
    const checkout = item.monthlyCheckout;
    check(checkout.freshConsentRequired === true && checkout.currency === 'XTR' && (checkout.amountStars === null || positive(checkout.amountStars)) &&
      (checkout.termsRevision === null || code(checkout.termsRevision)) && (checkout.priceVersion === null || positive(checkout.priceVersion)) &&
      (checkout.expiresAt === null || positive(checkout.expiresAt)) && (checkout.invoiceUrl === null || safeStarsInvoiceUrl(checkout.invoiceUrl)));
    if (checkout.invoiceUrl !== null) check(item.billingMode === 'recurring' && checkout.expiresAt > observedAt && !item.sourceCompensated);
    if (checkout.available) check(value.canWrite && item.state === 'scheduled' && item.billingMode === 'recurring' && item.effectiveAt <= observedAt &&
      positive(checkout.amountStars) && code(checkout.termsRevision) && positive(checkout.priceVersion) && checkout.expiresAt > observedAt);
    if (item.cancel.available) check(value.canWrite && item.state === 'scheduled');
  }
  for (const item of value.pendingInvoices) {
    shape(item, 'planCode packageCode durationDays amountStars currency billingMode state priceVersion offerVersion campaignCode termsRevision startsAt endsAt datesAreEstimate expiresAt invoiceUrl grantsAccess');
    check(plans.includes(item.planCode) && ['3m', '6m', '12m'].includes(item.packageCode) && item.durationDays === days[item.packageCode] &&
      positive(item.amountStars) && item.currency === 'XTR' && item.billingMode === 'prepaid' && ['issued', 'pending', 'manual_review', 'expired'].includes(item.state) &&
      positive(item.priceVersion) && code(item.offerVersion) && code(item.termsRevision) && (item.campaignCode === null ||
        typeof item.campaignCode === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(item.campaignCode)) && positive(item.startsAt) &&
      item.endsAt === item.startsAt + item.durationDays * 86400 && item.datesAreEstimate === true && positive(item.expiresAt) && item.grantsAccess === false &&
      (item.state === 'issued' ? safeStarsInvoiceUrl(item.invoiceUrl) && item.expiresAt > observedAt : item.invoiceUrl === null));
    if (item.state === 'expired') check(item.expiresAt <= observedAt);
  }
  if (value.terms !== null) { shape(value.terms, 'revision available accepted telegramCommand'); check(code(value.terms.revision) && bool(value.terms.available) && bool(value.terms.accepted) && value.terms.telegramCommand === '/terms'); }
  return value;
}

// This is a presentation schema for the authenticated fixed GET response.
// Parsing a decision never mints a policy brand or authorizes a later action.
export function readSubscriptionDTO(value, { sessionExpiresAt = null, nowSeconds = null } = {}) {
  const check = condition => { if (!condition) fail("invalid_response"); };
  const shape = (item, fields) => {
    const names = fields.split(" ");
    check(object(item) && Object.keys(item).length === names.length && names.every(key => Object.hasOwn(item, key)));
    return item;
  };
  const text = (item, max = 128) => typeof item === "string" && item.length > 0 && item.length <= max;
  const code = item => text(item) && /^[a-zA-Z0-9_.:-]+$/u.test(item);
  const integer = item => Number.isSafeInteger(item) && item >= 0 && item <= 1_000_000_000;
  const nullableCount = item => item === null || integer(item);
  const time = item => Number.isSafeInteger(item) && item > 0 && item <= 253_402_300_799;
  const nullableTime = item => item === null || time(item);
  const codes = (items, max = 16) => Array.isArray(items) && items.length <= max && items.every(code);
  const bool = item => typeof item === "boolean";
  const version = "2026-10-03.v1.4.2.p01";
  const planCodes = ["free", "professional", "dragon"];
  const quotaScopes = { active_applications: "own_applicant_visible_offer", own_working_offers: "own_partner_profile",
    active_campaigns: "own_ambassador_profile" };
  const lifecycleModel = Object.hasOwn(value ?? {}, "lifecycle");
  shape(value, "readModelVersion subscriptionModelVersion authority observedAt access quotas catalog authorization" +
    (lifecycleModel ? " lifecycle renewalActions" : "") + (Object.hasOwn(value ?? {}, "history") ? " history" : "") +
    (Object.hasOwn(value ?? {}, "features") ? " features" : "") + (Object.hasOwn(value ?? {}, "packages") ? " packages" : ""));
  if (Object.hasOwn(value, "features")) readClientFeatures(value.features);
  check(value.readModelVersion === 1 && value.subscriptionModelVersion === version && value.authority === "worker" && time(value.observedAt));
  const authorization = readAuthorizationDTO(value.authorization, "access.read_own");
  check(authorization.allowed === true && authorization.quota === null && authorization.actionPolicy === "allow");
  const access = shape(value.access, "version authority policyVersion observedAt sessionExpiresAt current preview ownerException" + (lifecycleModel ? " lifecycle" : ""));
  check(access.version === 1 && access.authority === "worker" && access.policyVersion === authorization.policyVersion &&
    access.observedAt === value.observedAt && time(access.sessionExpiresAt) && access.sessionExpiresAt > value.observedAt &&
    time(authorization.validUntil) && authorization.validUntil > value.observedAt && authorization.validUntil <= access.sessionExpiresAt);
  check(sessionExpiresAt === null || time(sessionExpiresAt) && access.sessionExpiresAt <= sessionExpiresAt);
  check(nowSeconds === null || time(nowSeconds) && authorization.validUntil > nowSeconds);
  const current = shape(access.current, "planCode accessState accessOverlay status reasonCode sourceKind startsAt expiresAt remainingSeconds durationKind activeDragon previewActive");
  check([null, ...planCodes].includes(current.planCode) && [null, "none", "trial", "active", "cancel_at_period_end", "payment_failed", "expired", "refunded", "chargeback", "suspended"].includes(current.accessState) &&
    [null, "none", "dragon_preview"].includes(current.accessOverlay) && ["verified", "review_required"].includes(current.status) && code(current.reasonCode) &&
    [null, "free", "stars", "package_payment", "referral_bonus", "preview"].includes(current.sourceKind) && nullableTime(current.startsAt) && nullableTime(current.expiresAt) &&
    nullableCount(current.remainingSeconds) && ["finite", "ended", "free_unlimited", "unknown"].includes(current.durationKind) && bool(current.activeDragon) && bool(current.previewActive));
  if (["finite", "ended"].includes(current.durationKind)) {
    check(current.status === "verified" && time(current.startsAt) && time(current.expiresAt) && current.startsAt < current.expiresAt &&
      current.remainingSeconds === Math.max(0, current.expiresAt - value.observedAt) &&
      (current.durationKind === "finite") === (current.expiresAt > value.observedAt) && ["stars", "package_payment", "referral_bonus", "preview"].includes(current.sourceKind));
  } else check(current.startsAt === null && current.expiresAt === null && current.remainingSeconds === null);
  if (current.status === "review_required") check(current.planCode === null && current.accessOverlay === null &&
    current.sourceKind === null && current.durationKind === "unknown" && !current.activeDragon && !current.previewActive);
  else check(planCodes.includes(current.planCode) && current.accessOverlay !== null &&
    authorization.effectivePlan === (current.previewActive ? "preview" : current.planCode));
  if (current.durationKind === "free_unlimited") check(current.status === "verified" && current.planCode === "free" &&
    current.accessOverlay === "none" && current.sourceKind === "free" && !current.previewActive);
  check(current.previewActive === (current.status === "verified" && current.planCode === "free" && current.accessOverlay === "dragon_preview"));
  if (current.previewActive) check(current.sourceKind === "preview" && current.durationKind === "finite" && !current.activeDragon);
  if (current.activeDragon) check(current.status === "verified" && current.planCode === "dragon" && current.durationKind === "finite" &&
    ["active", "cancel_at_period_end", "payment_failed"].includes(current.accessState) && !current.previewActive);
  const preview = shape(access.preview, "historyUsed historyStatus startsAt expiresAt canRequestActivation reasonCode eligibility membershipCheckRequired durationSeconds oneTime");
  check([true, false, null].includes(preview.historyUsed) && preview.historyStatus ===
    (preview.historyUsed === true ? "used" : preview.historyUsed === false ? "not_used" : "unknown") && nullableTime(preview.startsAt) && nullableTime(preview.expiresAt) &&
    bool(preview.canRequestActivation) && code(preview.reasonCode) && ["check_required", "unavailable"].includes(preview.eligibility) &&
    preview.membershipCheckRequired === true && preview.durationSeconds === 604800 && preview.oneTime === true);
  check(preview.startsAt === null ? preview.expiresAt === null : time(preview.expiresAt) &&
    preview.expiresAt - preview.startsAt === preview.durationSeconds && preview.historyUsed === true);
  check(preview.canRequestActivation === (preview.eligibility === "check_required"));
  if (preview.canRequestActivation) check(preview.historyUsed === false && preview.reasonCode === "membership_check_required" &&
    current.status === "verified" && current.planCode === "free" && !current.previewActive);
  const owner = shape(access.ownerException, "applies source isPaidPlan");
  check(bool(owner.applies) && owner.source === (owner.applies ? "canonical_owner" : null) && owner.isPaidPlan === false);

  const quotaData = shape(value.quotas, "version actionAdmissionRequired quotas");
  check(quotaData.version === 1 && quotaData.actionAdmissionRequired === true && Array.isArray(quotaData.quotas) && quotaData.quotas.length === 3);
  const seenQuotas = new Set();
  for (const row of quotaData.quotas) {
    shape(row, "key used limit remaining planLimit betaLimit scope status reasonCode restrictions actionAdmissionRequired");
    check(Object.hasOwn(quotaScopes, row.key) && !seenQuotas.has(row.key) && row.scope === quotaScopes[row.key] &&
      [row.used, row.limit, row.remaining, row.planLimit, row.betaLimit].every(nullableCount) &&
      row.remaining === (row.used === null || row.limit === null ? null : Math.max(0, row.limit - row.used)) &&
      row.status === (row.used !== null && row.limit !== null ? "available" : "unavailable") && code(row.reasonCode) &&
      codes(row.restrictions) && row.actionAdmissionRequired === true);
    check(row.key === "own_working_offers" || row.betaLimit === null);
    seenQuotas.add(row.key);
  }

  const catalog = shape(value.catalog, "version generatedAt priceVersion termsRevision paymentsEnabled paymentsReady catalogReady problems rollout billing offers terms support nativeDependencies comparison" + (Object.hasOwn(value.catalog ?? {}, "recurring") ? " recurring" : ""));
  check(catalog.version === version && catalog.generatedAt === value.observedAt && nullableCount(catalog.priceVersion) &&
    code(catalog.termsRevision) && [catalog.paymentsEnabled, catalog.paymentsReady, catalog.catalogReady].every(bool) && codes(catalog.problems));
  const rollout = shape(catalog.rollout, "mode eligible reasonCode");
  check(["off", "admin", "allowlist", "percent", "all"].includes(rollout.mode) && bool(rollout.eligible) && code(rollout.reasonCode));
  const billing = shape(catalog.billing, "mode releasedMode periodSeconds renewal automaticRenewal");
  check(billing.mode === "prepaid" && bool(billing.releasedMode) && billing.periodSeconds === 2592000 && billing.renewal === "manual" && billing.automaticRenewal === false);
  check(Array.isArray(catalog.offers) && catalog.offers.length === 3);
  const seenPlans = new Set();
  for (const offer of catalog.offers) {
    shape(offer, "planCode name amountStars currency published priceVersion accessSeconds billingMode autoRenew matchesInitialPrice purchaseEligibility checkout");
    check(planCodes.includes(offer.planCode) && !seenPlans.has(offer.planCode) && text(offer.name, 80) && nullableCount(offer.amountStars) && offer.currency === "XTR" &&
      bool(offer.published) && nullableCount(offer.priceVersion) && nullableCount(offer.accessSeconds) && [null, "free", "prepaid"].includes(offer.billingMode) &&
      offer.autoRenew === false && [true, false, null].includes(offer.matchesInitialPrice));
    const free = offer.planCode === "free";
    const eligibility = shape(offer.purchaseEligibility, free ? "eligible reasonCode mode" : "eligible reasonCode mode termsAcceptanceRequired invoiceRequiresConfirmedTerms");
    check(bool(eligibility.eligible) && code(eligibility.reasonCode) && [null, "new_period", "renewal"].includes(eligibility.mode));
    if (free) check(offer.published && offer.amountStars === 0 && offer.priceVersion === null && offer.accessSeconds === null && offer.billingMode === "free" &&
      offer.matchesInitialPrice === true && !eligibility.eligible && eligibility.mode === null && offer.checkout === null);
    else {
      check(bool(eligibility.termsAcceptanceRequired) && eligibility.invoiceRequiresConfirmedTerms === true);
      if (offer.published) check(integer(offer.amountStars) && offer.amountStars > 0 && integer(offer.priceVersion) && offer.priceVersion > 0 &&
        offer.accessSeconds === billing.periodSeconds && offer.billingMode === "prepaid" && bool(offer.matchesInitialPrice));
      else check(offer.amountStars === null && offer.priceVersion === null && offer.accessSeconds === null && offer.billingMode === null && offer.matchesInitialPrice === null && !eligibility.eligible);
      if (eligibility.eligible) check(offer.published && catalog.paymentsEnabled && catalog.paymentsReady && catalog.catalogReady &&
        billing.releasedMode && rollout.eligible && catalog.terms?.available === true && ["new_period", "renewal"].includes(eligibility.mode));
      const checkout = shape(offer.checkout, "available reasonCode kind url botUsername menuCommand menuCallback termsCallback acceptanceCallback hintIsAuthority");
      const checkoutAvailable = eligibility.eligible && catalog.terms?.available === true;
      check(checkout.available === checkoutAvailable && checkout.reasonCode === (checkoutAvailable ? null : eligibility.reasonCode) &&
        checkout.kind === "telegram_deep_link" && checkout.url === (checkoutAvailable
          ? `https://t.me/RE_Program_Bot?start=subscribe_${offer.planCode}` : null) &&
        checkout.botUsername === "RE_Program_Bot" && checkout.menuCommand === "/plans" && checkout.menuCallback === "plans" &&
        checkout.termsCallback === `stars_buy:${offer.planCode}` && checkout.acceptanceCallback === `stars_accept:${offer.planCode}` && checkout.hintIsAuthority === false);
    }
    seenPlans.add(offer.planCode);
  }
  const terms = shape(catalog.terms, "revision publishedRevision available accepted scope acceptanceRequiredBeforeInvoice text textFormat reasonCode telegramCommand telegramCallback");
  check(terms.revision === catalog.termsRevision && code(terms.publishedRevision) && bool(terms.available) && bool(terms.accepted) && terms.scope === "stars_purchase" &&
    terms.acceptanceRequiredBeforeInvoice === true && terms.textFormat === "plain" && terms.telegramCommand === "/terms" && terms.telegramCallback === "stars_buy:terms" &&
    (terms.available ? text(terms.text, 16384) && terms.reasonCode === null : terms.text === null && code(terms.reasonCode)));
  const support = shape(catalog.support, "available paymentCommand paymentCallback url text refundTermsRevision refundAutomatic");
  check(support.available === true && support.paymentCommand === "/paysupport" && support.paymentCallback === "paysupport" &&
    support.url === "https://t.me/RE_Program_Support_Bot?start=paysupport" && text(support.text, 8192) && code(support.refundTermsRevision) && support.refundAutomatic === false);
  const native = shape(catalog.nativeDependencies, "referralShare dragonEmoji");
  const referral = shape(native.referralShare, "available reasonCode ownUrl releasedText preparationRequired preparedMessageId");
  check(bool(referral.available) && code(referral.reasonCode) && referral.releasedText === REFERRAL_TEXT &&
    referral.preparationRequired === true && referral.preparedMessageId === null && (referral.available
      ? referral.reasonCode === "eligible" && ownReferralUrl(referral.ownUrl)
      : referral.reasonCode !== "eligible" && referral.ownUrl === null));
  const emoji = shape(native.dragonEmoji, "available reasonCode customEmojiId");
  check(bool(emoji.available) && code(emoji.reasonCode) && (emoji.available
    ? emoji.reasonCode === "eligible" && typeof emoji.customEmojiId === "string" && /^[1-9][0-9]{0,19}$/u.test(emoji.customEmojiId) &&
      current.status === "verified" && current.planCode === "dragon" && current.activeDragon === true &&
      current.previewActive === false && current.accessOverlay === "none" && current.durationKind === "finite" &&
      ["active", "cancel_at_period_end", "payment_failed"].includes(current.accessState) && ["stars", "package_payment", "referral_bonus"].includes(current.sourceKind) &&
      time(current.expiresAt) && current.expiresAt > (nowSeconds ?? value.observedAt) &&
      integer(current.remainingSeconds) && current.remainingSeconds > 0
    : emoji.reasonCode !== "eligible" && emoji.customEmojiId === null));
  const comparison = shape(catalog.comparison, "version authority policyVersion publishedPolicyOnly grantsRoles rows previewLimits baseline support");
  check(comparison.version === 1 && comparison.authority === "worker" && comparison.policyVersion === access.policyVersion &&
    comparison.publishedPolicyOnly === true && comparison.grantsRoles === false && Array.isArray(comparison.rows) && comparison.rows.length === 3 && codes(comparison.baseline));
  shape(comparison.previewLimits, "active_applications own_working_offers active_campaigns");
  check(Object.values(comparison.previewLimits).every(integer));
  const seenRows = new Set();
  for (const row of comparison.rows) {
    shape(row, "key label unit limits roleRequirement additionalRestrictions");
    shape(row.limits, "free professional dragon");
    check(Object.hasOwn(quotaScopes, row.key) && !seenRows.has(row.key) && text(row.label, 100) && code(row.unit) &&
      Object.values(row.limits).every(integer) && ["user", "active_partner"].includes(row.roleRequirement) && codes(row.additionalRestrictions));
    seenRows.add(row.key);
  }
  const supportLevels = shape(comparison.support, "basic paymentHelp priority founderLine");
  check(supportLevels.basic === "included" && supportLevels.paymentHelp === "included" && supportLevels.priority === "not_released" && supportLevels.founderLine === "not_released");
  if (lifecycleModel) {
    const lifecycle = shape(value.lifecycle, "schemaVersion state renewalState paidAccess subscriptionId planCode billingMode startsAt paidUntil accessUntil contractId reasonCode reviewRequired reviewReasons graceSeconds gracePolicyVersion pendingOperations nextChargeAt");
    check(JSON.stringify(lifecycle) === JSON.stringify(access.lifecycle) && lifecycle.schemaVersion === 1 &&
      [null, "active", "cancel_at_period_end", "payment_failed", "expired", "refunded", "chargeback", "suspended"].includes(lifecycle.state) &&
      ["active", "canceled", "failed", "unknown", "inactive", "not_applicable"].includes(lifecycle.renewalState) && bool(lifecycle.paidAccess) &&
      [null, "professional", "dragon"].includes(lifecycle.planCode) && [null, "prepaid", "recurring"].includes(lifecycle.billingMode) &&
      [lifecycle.startsAt, lifecycle.paidUntil, lifecycle.accessUntil].every(nullableTime) &&
      [lifecycle.subscriptionId, lifecycle.contractId].every(item => item === null || text(item, 128)) && code(lifecycle.reasonCode) &&
      bool(lifecycle.reviewRequired) && codes(lifecycle.reviewReasons, 32) && lifecycle.graceSeconds === 0 && code(lifecycle.gracePolicyVersion) &&
      integer(lifecycle.pendingOperations) && lifecycle.nextChargeAt === null);
    check(lifecycle.paidAccess ? time(lifecycle.accessUntil) && lifecycle.accessUntil === lifecycle.paidUntil &&
      lifecycle.accessUntil > value.observedAt && ["active", "cancel_at_period_end", "payment_failed"].includes(lifecycle.state)
      : lifecycle.accessUntil === null);
    const actions = shape(value.renewalActions, "contractId expectedRevision renewalState pendingOperations cancel enable actionAdmissionRequired");
    check(actions.contractId === lifecycle.contractId && actions.renewalState === lifecycle.renewalState &&
      nullableCount(actions.expectedRevision) && integer(actions.pendingOperations) && actions.pendingOperations === lifecycle.pendingOperations &&
      actions.actionAdmissionRequired === true);
    for (const action of ["cancel", "enable"]) {
      shape(actions[action], "available route");
      check(bool(actions[action].available) && actions[action].route === `/subscription/renewal/${action}` &&
        (!actions[action].available || lifecycle.billingMode === "recurring" && text(actions.contractId) && integer(actions.expectedRevision)));
    }
  }
  if (catalog.recurring !== undefined) {
    const recurring = shape(catalog.recurring, "enabled ready billingMode automaticRenewal periodSeconds priceVersion terms offers" +
      (Object.hasOwn(catalog.recurring ?? {}, "reasonCode") ? " reasonCode" : ""));
    check(bool(recurring.enabled) && bool(recurring.ready) && recurring.billingMode === "recurring" && recurring.automaticRenewal === true &&
      recurring.periodSeconds === 2592000 && nullableCount(recurring.priceVersion) && (!recurring.ready || recurring.enabled) &&
      (recurring.reasonCode === undefined || code(recurring.reasonCode)));
    shape(recurring.terms, "revision available accepted scope explicitConsentRequired text");
    check(code(recurring.terms.revision) && bool(recurring.terms.available) && bool(recurring.terms.accepted) &&
      recurring.terms.scope === "stars_purchase" && recurring.terms.explicitConsentRequired === true && text(recurring.terms.text, 16384));
    check(Array.isArray(recurring.offers) && recurring.offers.length <= 2 && (!recurring.ready || recurring.offers.length === 2));
    const seen = new Set();
    for (const offer of recurring.offers) {
      shape(offer, "planCode amountStars currency priceVersion termsRevision accessSeconds billingMode recurringConsentRequired purchaseEligibility checkout");
      shape(offer.purchaseEligibility, "eligible reasonCode"); shape(offer.checkout, "available kind route actionAdmissionRequired");
      check(["professional", "dragon"].includes(offer.planCode) && !seen.has(offer.planCode) && integer(offer.amountStars) && offer.amountStars > 0 &&
        offer.currency === "XTR" && offer.priceVersion === recurring.priceVersion && offer.termsRevision === recurring.terms.revision &&
        offer.accessSeconds === recurring.periodSeconds && offer.billingMode === "recurring" && offer.recurringConsentRequired === true &&
        bool(offer.purchaseEligibility.eligible) && code(offer.purchaseEligibility.reasonCode) && bool(offer.checkout.available) &&
        offer.checkout.available === offer.purchaseEligibility.eligible && offer.checkout.kind === "authenticated_own_post" &&
        offer.checkout.route === "/subscription/recurring-invoice" && offer.checkout.actionAdmissionRequired === true &&
        (!offer.checkout.available || recurring.ready && recurring.terms.available)); seen.add(offer.planCode);
    }
  }
  if (value.history !== undefined) {
    const history = shape(value.history, "version available reasonCode items hasMore observedAt limit authority accessAuthority");
    check(history.version === 1 && history.limit === 20 && history.authority === "worker" && history.accessAuthority === false &&
      bool(history.available) && (history.reasonCode === null || code(history.reasonCode)) && bool(history.hasMore) &&
      history.observedAt === value.observedAt && Array.isArray(history.items) && history.items.length <= 20 && (history.available || !history.items.length));
    const receipts = new Set();
    for (const item of history.items) {
      const fields = "receiptId planCode amountStars currency occurredAt status billingMode paidPeriod reviewRequired" + (Object.hasOwn(item, 'package') ? ' package' : '');
      shape(item, fields + " receipt"); shape(item.receipt, fields);
      check(/^stars-[a-f0-9]{16,64}$/u.test(item.receiptId) && !receipts.has(item.receiptId) && ["professional", "dragon"].includes(item.planCode) &&
        integer(item.amountStars) && item.amountStars > 0 && item.currency === "XTR" && time(item.occurredAt) &&
        ["paid", "retained", "refunded", "chargeback", "review", "recorded"].includes(item.status) && ["prepaid", "recurring"].includes(item.billingMode) && bool(item.reviewRequired));
      if (item.paidPeriod !== null) {
        shape(item.paidPeriod, "startsAt endsAt"); check(time(item.paidPeriod.startsAt) && time(item.paidPeriod.endsAt) && item.paidPeriod.endsAt > item.paidPeriod.startsAt);
      }
      if (Object.hasOwn(item, 'package')) {
        const packagePeriod = shape(item.package, 'packageCode durationDays accessState startsAt endsAt');
        check(['3m', '6m', '12m'].includes(packagePeriod.packageCode) && packagePeriod.durationDays === { '3m': 90, '6m': 180, '12m': 360 }[packagePeriod.packageCode] &&
          ['current', 'future', 'expired', 'refunded', 'chargeback'].includes(packagePeriod.accessState) && time(packagePeriod.startsAt) &&
          packagePeriod.endsAt === packagePeriod.startsAt + packagePeriod.durationDays * 86400 && item.billingMode === 'prepaid' &&
          packagePeriod.startsAt === item.paidPeriod?.startsAt && packagePeriod.endsAt === item.paidPeriod?.endsAt);
        check(packagePeriod.accessState !== 'current' || packagePeriod.startsAt <= value.observedAt && packagePeriod.endsAt > value.observedAt);
        check(packagePeriod.accessState !== 'future' || packagePeriod.startsAt > value.observedAt);
        check(packagePeriod.accessState !== 'expired' || packagePeriod.endsAt <= value.observedAt);
        check(!['refunded', 'chargeback'].includes(packagePeriod.accessState) || item.status === packagePeriod.accessState);
      }
      check(fields.split(" ").every(key => JSON.stringify(item[key]) === JSON.stringify(item.receipt[key]))); receipts.add(item.receiptId);
    }
  }
  if (Object.hasOwn(value, 'packages')) readPackageSubscriptionDTO(value.packages, { observedAt: value.observedAt, validUntil: authorization.validUntil, current });
  const result = structuredClone({ ...value, authorization });
  const freeze = item => {
    if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); }
    return item;
  };
  return freeze(result);
}

// Telegram prepares the message; this response never asserts that it was sent
// or that any account mutation was committed. The ID is opaque and short-lived.
export function readPreparedReferralDTO(value, { nowSeconds = Math.floor(Date.now() / 1000),
  sessionExpiresAt = null, expectedOwnUrl = null } = {}) {
  const fields = ["version", "authority", "preparedMessageId", "expiresAt", "ownUrl", "releasedText", "prepared", "sent", "authorization"];
  const time = item => Number.isSafeInteger(item) && item > 0 && item <= 253_402_300_799;
  if (!object(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)) ||
      value.version !== 1 || value.authority !== "worker" || value.prepared !== true || value.sent !== false ||
      typeof value.preparedMessageId !== "string" || !/^[\x21-\x7E]{1,256}$/u.test(value.preparedMessageId) ||
      !time(nowSeconds) || !time(value.expiresAt) || value.expiresAt <= nowSeconds || value.expiresAt > nowSeconds + 86400 ||
      !ownReferralUrl(value.ownUrl) || value.releasedText !== REFERRAL_TEXT ||
      expectedOwnUrl !== null && (!ownReferralUrl(expectedOwnUrl) || value.ownUrl !== expectedOwnUrl)) fail("invalid_response");
  const authorization = readAuthorizationDTO(value.authorization, "referral.link.read_own");
  if (authorization.allowed !== true || authorization.actionPolicy !== "allow" || authorization.quota !== null ||
      !time(authorization.validUntil) || authorization.validUntil <= nowSeconds || sessionExpiresAt !== null &&
      (!time(sessionExpiresAt) || authorization.validUntil > sessionExpiresAt)) fail("invalid_response");
  return Object.freeze({ ...value, authorization });
}

export const authorizationMessage = authorization => {
  const messages = {
    quota_exceeded: "Лимит достигнут. Можно просматривать сохранённые данные и уменьшать число активных объектов.",
    plan_required: "Для этого действия нужен другой тариф.",
    authority_review_required: "Доступ требует проверки. Сохранённые данные доступны в разрешённых разделах.",
    feature_unavailable: "Это действие сейчас недоступно.",
    prerequisite_required: "Сначала выполните условия доступа в профиле.",
    role_required: "Для этого действия нет необходимой роли.",
    account_blocked: "Доступ ограничен. Обратитесь в поддержку.",
    account_deleting: "Запланировано удаление аккаунта. Это действие недоступно.",
    resource_unavailable: "Объект недоступен. Обновите данные.",
    not_found: "Объект недоступен или больше не существует.",
    access_required: "Для этого действия нет доступа. Проверьте тариф и условия в профиле.",
    account_restricted: "Это действие ограничено. Обратитесь в поддержку.",
    state_conflict: "Данные или доступ изменились. Обновите экран.",
  };
  const message = messages[authorization?.reasonCode] ?? "Это действие сейчас недоступно. Обновите данные.";
  const quota = authorization?.quota;
  return quota ? `${message} Использовано ${quota.used} из ${quota.limit}; осталось ${quota.remaining}.` : message;
};

const actionCapability = Object.freeze({ "partner.apply": "partner.apply",
  "partner.legal": "partner.legal_declare_own", "partner.username": "partner.public_username.update_own",
  "offer.create": "offer.create_private", "offer.edit": "offer.edit_own",
  "offer.submit": "offer.submit_moderation", "lead.submit": "application.create" });
const readCapability = (resource, data) => ["bootstrap", "profile"].includes(resource) ? "profile.read_own"
  : resource === "subscription" ? "access.read_own"
  : resource === "offers" ? data.view === "mine" ? "offer.read_own" : "offer.read_public"
    : resource === "applications" || resource === "application" ? data.view === "attributed"
      ? "application.read_attributed" : "application.read_own"
      : resource === "analytics" ? "analytics.read_personal" : null;
const readDecisions = value => {
  if (!object(value) || Object.keys(value).length > 8) fail("invalid_response");
  const visible = new Set(Object.values(actionCapability));
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([capability, decision]) => {
    if (!visible.has(capability)) fail("invalid_response");
    return [capability, readAuthorizationDTO(decision, capability)];
  })));
};

export function buildReadPath(resource, params = {}) {
  exact(params, resource === "offers" || resource === "applications"
    ? ["view", "limit", "cursor"] : resource === "analytics" ? ["period"]
      : resource === "application" ? ["leadId"] : []);
  if (resource === "application") return `${API}applications/${positive(params.leadId)}`;
  if (["bootstrap", "profile", "subscription"].includes(resource)) return `${API}${resource}`;
  const query = new URLSearchParams();
  if (["offers", "applications"].includes(resource)) {
    const views = resource === "offers" ? ["catalog", "mine"] : ["mine", "attributed"];
    const view = params.view ?? views[0];
    if (!views.includes(view)) fail("invalid_request");
    const limit = positive(params.limit ?? 20);
    if (limit > 50) fail("invalid_request");
    query.set("view", view);
    query.set("limit", String(limit));
    if (params.cursor !== undefined && params.cursor !== null) {
      if (typeof params.cursor !== "string" || !/^[A-Za-z0-9_.-]{1,2048}$/u.test(params.cursor)) {
        fail("invalid_request");
      }
      query.set("cursor", params.cursor);
    }
  } else if (resource === "analytics") {
    if (!["7d", "30d"].includes(params.period ?? "7d")) fail("invalid_request");
    query.set("period", params.period ?? "7d");
  } else fail("invalid_request");
  return `${API}${resource}?${query}`;
}

// Proposed P09 HTTP adapters, NOT live routes or client authority. Version is a
// precondition: P09 must resolve the canonical version ID and pass it to P05 CAS.
export function buildActionRequest(action, payload = {}, target = {}) {
  exact(target, ["code", "version"]);
  let path;
  let body;
  if (action === "partner.apply") {
    path = "partner/application";
    body = exact(payload, ["displayName", "contact", "ageConfirmed"]);
    if (typeof body.displayName !== "string" || body.displayName.trim().length < 2 ||
        body.displayName.length > 80 || typeof body.contact !== "string" ||
        body.contact.length > 120 || body.ageConfirmed !== true) fail("invalid_request");
  } else if (action === "partner.legal") {
    path = "partner/legal-profile";
    body = exact(payload, ["profileKind", "selfDeclarationAccepted"]);
    if (!["individual", "self_employed", "individual_entrepreneur"].includes(body.profileKind) ||
        body.selfDeclarationAccepted !== true) fail("invalid_request");
  } else if (action === "partner.username") {
    path = "partner/public-username";
    body = exact(payload, ["enabled"]);
    if (typeof body.enabled !== "boolean") fail("invalid_request");
  } else if (action === "lead.submit") {
    path = "applications";
    body = exact(payload, ["offerCode"]);
    offerCode(body.offerCode);
  } else if (action === "offer.create") {
    path = "offers";
    body = exact(payload, []); // P05 creates only the server-owned empty draft.
  } else if (["offer.edit", "offer.submit"].includes(action)) {
    const code = offerCode(target.code);
    const version = positive(target.version);
    path = `offers/${code}/${action === "offer.edit" ? "version" : "submit"}`;
    body = action === "offer.edit"
      ? { version, patch: exact(payload, OFFER_FIELDS) }
      : { version, ...exact(payload, []) };
    if (action === "offer.edit" && !Object.keys(body.patch).length) fail("invalid_request");
  } else fail("invalid_request");
  return Object.freeze({ path: API + path, body: JSON.stringify(body) });
}

export const errorMessage = error => error?.authorization ? authorizationMessage(error.authorization) : ({
  session_expired: "Сессия завершилась. Закройте кабинет и откройте его снова из Telegram.",
  unauthorized: "Откройте кабинет заново из Telegram.",
  telegram_required: "Откройте кабинет через кнопку Mini App в Telegram-боте.",
  replayed_init_data: "Этот запуск уже использован. Закройте кабинет и откройте его снова.",
  blocked: "Доступ ограничен. Обратитесь в поддержку.",
  terms_required: "Сначала примите условия в меню бота.",
  partner_required: "Раздел доступен активным партнёрам.",
  beta_required: "Для этого действия нужен действующий доступ Partner Beta.",
  partner_beta_required: "Для этого действия нужен действующий доступ Partner Beta.",
  actor_blocked: "Доступ ограничен. Обратитесь в поддержку.",
  public_username_missing: "Сначала задайте Telegram username в настройках Telegram.",
  offer_limit_reached: "Достигнут лимит офферов. Проверьте существующие офферы.",
  invalid_route: "Партнёрская ссылка недоступна или ещё не одобрена.",
  incomplete_offer: "Заполните обязательные условия оффера перед отправкой.",
  offer_not_public: "Предложение больше недоступно. Обновите каталог.",
  not_found: "Объект недоступен или больше не существует.",
  version_conflict: "Оффер изменился. Обновите данные перед редактированием.",
  invalid_cursor: "Список устарел. Обновите его с первой страницы.",
  state_conflict: "Данные или доступ изменились. Обновите экран перед новым действием.",
  idempotency_conflict: "Содержимое запроса изменилось. Проверьте сохранённые данные.",
  writes_unavailable: "Отправка из кабинета пока недоступна. Воспользуйтесь меню бота.",
  outcome_unknown: "Ответ не получен. Действие могло выполниться. Обновите данные; не отправляйте его повторно вслепую.",
  prepared_message_effect_unknown: "Ответ о подготовке сообщения не получен. Сообщение не отправлено; не повторяйте подготовку вслепую.",
  prepared_message_rejected: "Telegram не смог подготовить сообщение. Можно воспользоваться своей ссылкой.",
  package_outcome_unknown: "Ответ уточняется. Проверьте тот же сохранённый запрос; новый счёт пока не создаётся.",
  pending_principal_mismatch: "Сохранённый запрос относится к другому аккаунту или боту. Откройте исходный аккаунт либо передайте диагностику в поддержку.",
  package_confirmation_changed: "Цена или условия изменились. Выберите пакет заново и подтвердите обновлённые условия.",
  package_monthly_invoice_not_due: "Новый месячный счёт будет доступен с даты перехода.",
  monthly_reservation_expired_or_closed: "Срок этого счёта завершён. Отмените изменение и обновите доступные действия.",
  package_recurring_cancellation_unconfirmed: "Сначала требуется подтверждение отмены прежнего продления. Оплаченный срок сохраняется.",
  invalid_request: "Проверьте введённые данные.",
  rate_limited: "Слишком много запросов. Попробуйте позже.",
  request_in_progress: "Дождитесь результата текущего действия.",
  invalid_response: "Не удалось прочитать ответ сервера. Обновите данные.",
  network_error: "Не удалось загрузить данные. Проверьте соединение и повторите загрузку.",
})[error?.code] ?? "Сервис временно недоступен. Попробуйте позже.";

export class MiniAppClient {
  #fetch; #now; #crypto; #token = null; #expires = 0; #epoch = 0;
  #authAttempted = false; #requests = new Set(); #pending = null; #uncertain = false;
  #referralPending = null; #referralUncertain = false; #referralOwnUrl = null;
  #onExpired;
  #origin;
  #authorizationVersion = 0;
  #existingRenewalCancellationEnabled = false;
  #nativeOwnerInvoiceOnly = false;
  #nativeOwnerRenewalPermissionTarget = null;
  #nativeOwnerRenewalPermissionReadGeneration = 0;
  #recoveredRenewalPermission = null;
  #subscriptionPending = null; #subscriptionMarker = null; #pendingStorage; #subscriptionRecovery = null; #recoveredInvoice = null;
  #subscriptionStorageNeedsRecovery = false; #subscriptionRecoveryState = null;
  #subscriptionRecoveryFailure = null;
  #subscriptionRecoveryTransport = null;
  #subscriptionCancellationFailure = null;
  #subscriptionCancellationTransport = null;
  #subscriptionReconfirmation = null; #subscriptionReconfirmationReceipt = null;
  #verifiedSubscriptionOutcome = null;
  #subscriptionPrincipal = null;
  #packageDescriptor = null; #packageReadGeneration = 0; #packagePending = null; #packageMarker = null; #recoveredPackageInvoice = null;
  #packageStorageNeedsRecovery = false;
  constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), now = () => Date.now(),
    cryptoImpl = globalThis.crypto, origin = globalThis.location?.origin,
    mutationsEnabled = false, offerActionsEnabled = false, onExpired = () => {}, pendingStorage = undefined } = {}) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin) fail("invalid_origin");
    if (typeof fetchImpl !== "function" || !cryptoImpl?.getRandomValues) fail("unavailable");
    this.#origin = origin;
    this.canMutate = mutationsEnabled === true;
    this.canOpenOffers = offerActionsEnabled === true;
    this.#fetch = fetchImpl; this.#now = now; this.#crypto = cryptoImpl;
    this.#onExpired = onExpired;
    try {
      this.#pendingStorage = pendingStorage === undefined ? globalThis.localStorage : pendingStorage;
      const saved = this.#pendingStorage?.getItem("re-subscription-pending-v1");
      if (saved) {
        const marker = JSON.parse(saved);
        if (object(marker) && ["invoice", "cancel", "enable"].includes(marker.kind) &&
            /^[a-f0-9]{48}$/u.test(marker.key) && Number.isSafeInteger(marker.startedAt) &&
            Object.keys(marker).every(field => ["kind", "key", "startedAt", "intent", "principal", "reconfirm"].includes(field)) &&
            (!Object.hasOwn(marker, 'principal') || subscriptionPrincipal(marker.principal)) &&
            (!Object.hasOwn(marker, 'reconfirm') || cancellationPredecessor(marker))) this.#subscriptionMarker = marker;
        else this.#subscriptionMarker = { kind: "invoice", key: "", startedAt: 0 };
      }
    } catch { this.#subscriptionMarker = { kind: "invoice", key: "", startedAt: 0 }; }
    try {
      const saved = this.#pendingStorage?.getItem('re-package-pending-v1');
      if (saved) {
        const marker = JSON.parse(saved);
        if (!object(marker) || Object.keys(marker).length !== (Object.hasOwn(marker, 'principal') ? 5 : 4) ||
            Object.keys(marker).some(field => !['kind', 'key', 'startedAt', 'intent', 'principal'].includes(field)) ||
            Object.hasOwn(marker, 'principal') && !subscriptionPrincipal(marker.principal) ||
            !['invoice', 'schedule', 'cancel', 'monthly-invoice'].includes(marker.kind) ||
            !/^[a-f0-9]{48}$/u.test(marker.key) || !Number.isSafeInteger(marker.startedAt) || marker.startedAt <= 0 || !object(marker.intent)) throw new Error('invalid_marker');
        this.#packageMarker = marker;
      }
    } catch { this.#packageMarker = { kind: 'unknown', key: '', startedAt: 0 }; }
  }
  get origin() { return this.#origin; }
  #key() {
    return [...this.#crypto.getRandomValues(new Uint8Array(24))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  get authenticated() { return this.#token !== null && this.#expires * 1000 > this.#now(); }
  get expiresAt() { return this.#expires; }
  get uncertain() { return this.#uncertain; }
  get referralPreparationUncertain() { return this.#referralUncertain; }
  get subscriptionOutcomePending() { return this.#subscriptionMarker !== null; }
  get subscriptionStorageNeedsRecovery() { return this.#subscriptionStorageNeedsRecovery; }
  get pendingSubscriptionRecoveryAvailable() {
    const marker = this.#subscriptionMarker;
    return this.authenticated && !this.#subscriptionPending && !this.#subscriptionRecovery && !this.#subscriptionReconfirmation &&
      this.#subscriptionRecoveryState?.state === 'missing' && this.#recoverableSubscriptionMarker(marker) &&
      !Object.hasOwn(marker, 'reconfirm') && ['cancel', 'enable'].includes(marker.kind) && (!Object.hasOwn(marker, 'principal') ||
        sameSubscriptionPrincipal(subscriptionPrincipal(marker.principal), this.#subscriptionPrincipal));
  }
  get pendingCancellationReconfirmationMode() {
    const marker = this.#subscriptionMarker;
    if (!this.authenticated || this.#subscriptionStorageNeedsRecovery || !(this.canMutate || this.#existingRenewalCancellationEnabled) ||
        this.#subscriptionPending || this.#subscriptionRecovery || this.#subscriptionReconfirmation || this.#pending ||
        this.#packagePending || this.#packageMarker || this.#uncertain || marker?.kind !== 'cancel' ||
        !this.#recoverableSubscriptionMarker(marker) || !/^[a-f0-9-]{36}$/u.test(marker.intent.contractId) ||
        !sameSubscriptionPrincipal(subscriptionPrincipal(marker.principal), this.#subscriptionPrincipal)) return null;
    if (cancellationPredecessor(marker)) return this.#subscriptionReconfirmationReceipt?.marker === marker &&
      this.#subscriptionReconfirmationReceipt.data.state === 'admitted' ? 'continue' : null;
    return ['pending', 'unknown'].includes(this.#subscriptionRecoveryState?.state) &&
      Math.floor(this.#now() / 1000) - marker.startedAt >= 300 ? 'new' : null;
  }
  get subscriptionRecoveryState() {
    if (!this.#subscriptionMarker) return null;
    if (!this.#recoverableSubscriptionMarker(this.#subscriptionMarker)) return Object.freeze({
      state: 'unrecoverable', reasonCode: 'saved_operation_identity_unavailable', readOnly: true });
    return this.#subscriptionRecoveryState ?? Object.freeze({ state: 'not_checked', reasonCode: null, readOnly: true });
  }
  get verifiedSubscriptionOutcome() { return this.#verifiedSubscriptionOutcome; }
  get pendingSubscriptionDiagnostics() {
    // Export only validated operation identifiers and intent. Never export
    // storage verbatim, authentication inputs, session tokens or server secrets.
    const exportMarker = (marker, packageMarker = false) => {
      if (!marker) return null;
      let valid = this.#recoverableSubscriptionMarker(marker);
      if (packageMarker) {
        try { this.#validatePackageIntent(marker.kind, marker.intent);
          valid = /^[a-f0-9]{48}$/u.test(marker.key) && Number.isSafeInteger(marker.startedAt) && marker.startedAt > 0; }
        catch { valid = false; }
      }
      const principal = subscriptionPrincipal(marker.principal);
      const scope = !principal ? 'legacy_unbound' : !this.#subscriptionPrincipal ? 'principal_unverified'
        : sameSubscriptionPrincipal(principal, this.#subscriptionPrincipal) ? 'matched' : 'principal_mismatch';
      // A historical marker may have a usable key but no original intent.
      // Retain those validated identifiers for support; never export an invalid
      // intent object merely to make the diagnostic look complete.
      const allowedKinds = packageMarker ? ['invoice', 'schedule', 'cancel', 'monthly-invoice'] : ['invoice', 'cancel', 'enable'];
      return Object.freeze({ kind: allowedKinds.includes(marker.kind) ? marker.kind : null,
        key: /^[a-f0-9]{48}$/u.test(marker.key) ? marker.key : null,
        startedAt: Number.isSafeInteger(marker.startedAt) && marker.startedAt > 0 ? marker.startedAt : null,
        intent: valid ? structuredClone(marker.intent) : null, principal, scope,
        ...(!packageMarker && cancellationPredecessor(marker) ? { reconfirm: cancellationPredecessor(marker) } : {}),
        ...(!valid ? { recoverable: false } : {}) });
    };
    return Object.freeze({ schemaVersion: 1, kind: 'RE_SUBSCRIPTION_PENDING_DIAGNOSTICS',
      capturedAt: Math.floor(this.#now() / 1000), currentPrincipal: this.#subscriptionPrincipal,
      subscription: exportMarker(this.#subscriptionMarker), package: exportMarker(this.#packageMarker, true),
      operationStatus: this.subscriptionRecoveryState, lastRecoveryFailure: this.#subscriptionRecoveryFailure,
      lastCancellationFailure: this.#subscriptionCancellationFailure, readOnly: true });
  }
  get packageOutcomePending() { return this.#packageMarker !== null; }
  get packageStorageNeedsRecovery() { return this.#packageStorageNeedsRecovery; }
  get recoveredPackageInvoice() { return this.#recoveredPackageInvoice; }
  get recoveredSubscriptionInvoiceUrl() { return this.#recoveredInvoice; }
  get recoveredSubscriptionRenewalPermission() { return this.#recoveredRenewalPermission; }
  get existingRenewalCancellationEnabled() { return this.#existingRenewalCancellationEnabled; }
  checkSession() {
    if (!this.authenticated) { this.clearSession(); fail("session_expired", 401); }
  }
  clearSession() {
    const hadSession = this.#token !== null;
    // Losing a live session does not prove that its pending POST was rejected.
    // Set this before notifying the view so expiry can show the honest outcome.
    if (this.#pending) this.#uncertain = true;
    if (this.#referralPending) this.#referralUncertain = true;
    this.#token = null; this.#expires = 0; this.#epoch++;
    this.#subscriptionPrincipal = null;
    this.#subscriptionReconfirmationReceipt = null;
    this.#verifiedSubscriptionOutcome = null;
    for (const controller of this.#requests) controller.abort();
    this.#requests.clear();
    this.canMutate = false; this.canOpenOffers = false;
    this.#authorizationVersion = 0;
    this.#existingRenewalCancellationEnabled = false; this.#nativeOwnerInvoiceOnly = false;
    this.#nativeOwnerRenewalPermissionTarget = null; this.#recoveredRenewalPermission = null;
    this.#referralOwnUrl = null;
    this.#packageDescriptor = null; this.#packageReadGeneration++; this.#recoveredPackageInvoice = null;
    this.#recoveredInvoice = null;
    if (hadSession) this.#onExpired();
  }
  async #request(path, { method = "GET", body, key, signal, auth = true, externalPreparation = false } = {}) {
    if (auth) this.checkSession();
    if (method === "POST" && new TextEncoder().encode(body).length > MAX_BODY) fail("invalid_request");
    const epoch = this.#epoch;
    const unknownCode = externalPreparation ? "prepared_message_effect_unknown" : "outcome_unknown";
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    this.#requests.add(controller);
    const headers = { Accept: "application/json" };
    if (auth) headers.Authorization = `Bearer ${this.#token}`;
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = key;
      // A same-origin browser also supplies this header itself. Explicitly
      // retain the bound origin in non-browser adapters used for validation.
      if (externalPreparation || path.startsWith(`${API}subscription/`) || path.startsWith(`${API}packages/`)) headers.Origin = this.#origin;
    }
    // Bound every request. A timed-out POST is still an unknown outcome.
    const ownRecovery = method === 'POST' && path === `${API}subscription/recover`;
    const ownCancellation = method === 'POST' && path === `${API}subscription/renewal/cancel`;
    const diagnosticRequest = ownRecovery || ownCancellation;
    const startedAt = diagnosticRequest ? this.#now() : 0;
    const transport = diagnosticRequest ? { httpStatus: 0, phase: 'fetch', durationMs: 0, timedOut: false } : null;
    const timer = setTimeout(() => {
      if (transport) transport.timedOut = true;
      controller.abort();
    }, diagnosticRequest ? 45_000 : 15_000);
    try {
      const response = await this.#fetch(new URL(path, this.origin).href, {
        method, headers, body, signal: controller.signal, cache: "no-store",
        credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
      });
      if (transport) transport.httpStatus = Number.isSafeInteger(response.status) && response.status >= 0 && response.status <= 599 ? response.status : 0;
      if (epoch !== this.#epoch || (auth && !this.authenticated)) {
        this.clearSession(); fail("session_expired", 401);
      }
      if (auth && response.status === 401) { this.clearSession(); fail("session_expired", 401); }
      if (response.status === 429) fail("rate_limited", 429);
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        if (transport) transport.phase = 'non_json';
        fail(method === "POST" ? unknownCode : "invalid_response");
      }
      let data;
      if (transport) transport.phase = 'json_body';
      try { data = await response.json(); }
      catch { fail(method === "POST" ? unknownCode : "invalid_response"); }
      if (transport) transport.phase = 'json';
      if (epoch !== this.#epoch || (auth && !this.authenticated)) {
        this.clearSession(); fail("session_expired", 401);
      }
      if (!response.ok) {
        // A server error cannot prove whether an upstream commit happened.
        if (method === "POST" && response.status >= 500 && !(externalPreparation && data?.error === "prepared_message_rejected"))
          fail(unknownCode, response.status);
        const authorization = data?.authorization === undefined ? null : readAuthorizationDTO(data.authorization,
          externalPreparation ? "referral.link.read_own" : null);
        fail(typeof data?.error === "string" ? data.error : "unavailable", response.status, authorization);
      }
      if (!object(data)) fail(method === "POST" ? unknownCode : "invalid_response");
      return data;
    } catch (error) {
      if (error instanceof CabinetClientError) throw error;
      if (epoch !== this.#epoch) fail("session_expired", 401);
      if (signal?.aborted) throw error;
      fail(method === "POST" ? unknownCode : "network_error");
    } finally {
      if (transport) {
        const elapsed = this.#now() - startedAt;
        transport.durationMs = Number.isFinite(elapsed) ? Math.min(60_000, Math.max(0, Math.floor(elapsed))) : 0;
        if (ownRecovery) this.#subscriptionRecoveryTransport = Object.freeze(transport);
        else this.#subscriptionCancellationTransport = Object.freeze(transport);
      }
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      this.#requests.delete(controller);
    }
  }
  async authenticate(initData) {
    this.#existingRenewalCancellationEnabled = false; this.#nativeOwnerInvoiceOnly = false;
    this.#nativeOwnerRenewalPermissionTarget = null; this.#recoveredRenewalPermission = null;
    if (this.#authAttempted) fail("replayed_init_data", 409);
    if (typeof initData !== "string" || !initData ||
        new TextEncoder().encode(initData).length > 8192) fail("telegram_required");
    this.#authAttempted = true;
    const session = await this.#request(`${API}session`, { method: "POST", auth: false,
      body: JSON.stringify({ initData }), key: this.#key() });
    const now = Math.floor(this.#now() / 1000);
    if (!TOKEN.test(session.sessionToken) || session.tokenType !== "Bearer" ||
        !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= now ||
        session.expiresAt > now + 300) fail("invalid_response");
    let canMutate = this.canMutate, canOpenOffers = this.canOpenOffers;
    let existingRenewalCancellationEnabled = false, nativeOwnerInvoiceOnly = false;
    if (session.features !== undefined) {
      const features = readClientFeatures(session.features);
      canMutate = features.mutationsEnabled;
      canOpenOffers = features.offerActionsEnabled;
      existingRenewalCancellationEnabled = features.existingRenewalCancellationEnabled === true;
      nativeOwnerInvoiceOnly = features.nativeOwnerInvoiceOnly === true;
    }
    if (session.authorizationVersion !== undefined && session.authorizationVersion !== 1) fail("invalid_response");
    if ((existingRenewalCancellationEnabled || nativeOwnerInvoiceOnly) && session.authorizationVersion !== 1) fail("invalid_response");
    const principal = session.principal === undefined ? null : subscriptionPrincipal(session.principal);
    if (session.principal !== undefined && !principal) fail('invalid_response');
    this.#authorizationVersion = session.authorizationVersion ?? 0;
    this.#token = session.sessionToken; this.#expires = session.expiresAt;
    this.canMutate = canMutate; this.canOpenOffers = canOpenOffers;
    this.#existingRenewalCancellationEnabled = existingRenewalCancellationEnabled;
    this.#nativeOwnerInvoiceOnly = nativeOwnerInvoiceOnly;
    this.#subscriptionPrincipal = principal;
  }
  async read(resource, params = {}, options = {}) {
    // A native permission POST needs this session's latest validated own
    // subscription descriptor. A different read or a failed refresh closes it.
    this.#nativeOwnerRenewalPermissionTarget = null;
    const permissionReadGeneration = ++this.#nativeOwnerRenewalPermissionReadGeneration;
    this.#packageDescriptor = null;
    const packageReadGeneration = ++this.#packageReadGeneration;
    try {
      const data = await this.#request(buildReadPath(resource, params), { signal: options.signal });
      if (data.readModelVersion !== 1) fail("invalid_response");
      const features = data.features === undefined ? null : readClientFeatures(data.features);
      // Only authentication can negotiate cancellation transport availability.
      // Reads may close it, including an older response that omits the feature.
      this.#existingRenewalCancellationEnabled = this.#existingRenewalCancellationEnabled &&
        features?.existingRenewalCancellationEnabled === true;
      this.#nativeOwnerInvoiceOnly = this.#nativeOwnerInvoiceOnly && features?.nativeOwnerInvoiceOnly === true;
      if (features) {
        if (!features.mutationsEnabled) this.canMutate = false;
        if (!features.offerActionsEnabled) this.canOpenOffers = false;
      }
      if (resource === "subscription") {
        const subscription = readSubscriptionDTO(data, {
          sessionExpiresAt: this.#expires, nowSeconds: Math.floor(this.#now() / 1000),
        });
        const actions = subscription.renewalActions, lifecycle = subscription.lifecycle;
        if (permissionReadGeneration === this.#nativeOwnerRenewalPermissionReadGeneration &&
            this.#nativeOwnerInvoiceOnly && actions?.enable.available === true &&
            lifecycle?.paidAccess === true && lifecycle.billingMode === "recurring" &&
            actions.contractId === lifecycle.contractId && actions.pendingOperations === 0 &&
            lifecycle.pendingOperations === 0 && !lifecycle.reviewRequired &&
            this.#recoveredRenewalPermission?.contractId !== actions.contractId)
          this.#nativeOwnerRenewalPermissionTarget = Object.freeze({ contractId: actions.contractId,
            expectedRevision: actions.expectedRevision, validUntil: subscription.authorization.validUntil });
        this.#referralOwnUrl = subscription.catalog.nativeDependencies.referralShare.ownUrl;
        if (packageReadGeneration === this.#packageReadGeneration && subscription.packages?.canWrite === true)
          this.#packageDescriptor = subscription.packages;
        if (this.#subscriptionMarker && !this.#subscriptionPending) {
          try { await this.recoverSubscriptionAction({ signal: options.signal }); }
          catch (error) { if (error.code === "session_expired") throw error; }
        }
        return subscription;
      }
      if (this.#authorizationVersion === 1 || data.authorization !== undefined) {
        data.authorization = readAuthorizationDTO(data.authorization, readCapability(resource, data));
      }
      if (data.decisions !== undefined) data.decisions = readDecisions(data.decisions);
      if (["offers", "applications"].includes(resource) &&
          (data.collection !== resource || data.view !== (params.view ?? (resource === "offers" ? "catalog" : "mine")) ||
          !Array.isArray(data.items) || (data.nextCursor !== null && typeof data.nextCursor !== "string"))) {
        fail("invalid_response");
      }
      return data;
    } catch (error) { this.#existingRenewalCancellationEnabled = false; this.#nativeOwnerInvoiceOnly = false;
      this.#nativeOwnerRenewalPermissionTarget = null; throw error; }
  }
  async resolveOfferAction(code) {
    if (!this.canOpenOffers) fail("writes_unavailable");
    const canonicalCode = offerCode(code);
    // P09 must re-project P05's current approved route on EVERY target click.
    const data = await this.#request(`${API}offers/${canonicalCode}/action`);
    if (this.#authorizationVersion === 1 || data.authorization !== undefined) {
      data.authorization = readAuthorizationDTO(data.authorization, "offer.open_action");
    }
    const url = safeActionUrl(data.offer?.actionUrl);
    if (data.projectionVersion !== 1 || !["public", "assigned"].includes(data.visibility) ||
        data.offer?.code !== canonicalCode || !url) fail("offer_not_public", 404);
    return url;
  }
  prepareOwnReferralMessage(...args) {
    if (args.length) return Promise.reject(new CabinetClientError("invalid_request"));
    if (this.#referralUncertain) return Promise.reject(new CabinetClientError("prepared_message_effect_unknown"));
    if (this.#referralPending) return this.#referralPending;
    try { this.checkSession(); } catch (error) { return Promise.reject(error); }
    const expectedOwnUrl = this.#referralOwnUrl;
    const promise = this.#request(`${API}referral/prepared`, {
      method: "POST", body: "{}", key: this.#key(), externalPreparation: true,
    }).then(data => {
      try { return readPreparedReferralDTO(data, { nowSeconds: Math.floor(this.#now() / 1000),
        sessionExpiresAt: this.#expires, expectedOwnUrl }); }
      catch { fail("prepared_message_effect_unknown"); }
    }).catch(error => {
      if (error.code === "invalid_response") {
        this.#referralUncertain = true;
        fail("prepared_message_effect_unknown", error.status);
      }
      if (error.code === "prepared_message_effect_unknown") this.#referralUncertain = true;
      throw error;
    }).finally(() => { this.#referralPending = null; });
    this.#referralPending = promise;
    return promise;
  }
  subscriptionAction(kind, payload) {
    if (this.#packagePending || this.#packageMarker) return Promise.reject(new CabinetClientError('package_outcome_unknown'));
    const permissionTarget = this.#nativeOwnerRenewalPermissionTarget;
    const nativePermission = kind === "enable" && this.#nativeOwnerInvoiceOnly && permissionTarget !== null &&
      permissionTarget.validUntil * 1000 > this.#now() && permissionTarget.contractId === payload?.contractId &&
      permissionTarget.expectedRevision === payload?.expectedRevision;
    if (!this.canMutate && !(kind === "cancel" && this.#existingRenewalCancellationEnabled) &&
        !(kind === "invoice" && this.#nativeOwnerInvoiceOnly) && !nativePermission)
      return Promise.reject(new CabinetClientError("writes_unavailable"));
    const fields = kind === "invoice" ? ["planCode", "recurringConsent", "termsRevision", "priceVersion"] : ["contractId", "expectedRevision"];
    let body;
    try {
      if (!["invoice", "cancel", "enable"].includes(kind)) fail("invalid_request");
      const request = exact(payload, fields);
      if (Object.keys(request).length !== fields.length) fail("invalid_request");
      if (kind === "invoice") {
        if (this.#nativeOwnerInvoiceOnly && (!["professional", "dragon"].includes(request.planCode) || request.priceVersion !== 1)) fail("writes_unavailable");
        if (!["professional", "dragon"].includes(request.planCode) || request.recurringConsent !== true ||
            request.termsRevision !== "2026-10-03.stars-recurring-v1" || !Number.isSafeInteger(request.priceVersion) || request.priceVersion < 1) fail("invalid_request");
      } else if (typeof request.contractId !== "string" || !/^[a-f0-9-]{36}$/u.test(request.contractId) ||
          !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) fail("invalid_request");
      body = JSON.stringify(request); this.checkSession();
    } catch (error) { return Promise.reject(error); }
    if (this.#subscriptionPending || this.#subscriptionReconfirmation || this.#pending) return Promise.reject(new CabinetClientError("request_in_progress"));
    if (this.#subscriptionMarker || this.#uncertain) return Promise.reject(new CabinetClientError("subscription_outcome_unknown"));
    if (!this.#subscriptionPrincipal) return Promise.reject(new CabinetClientError('writes_unavailable'));
    const marker = { kind, key: this.#key(), startedAt: Math.floor(this.#now() / 1000), intent: JSON.parse(body), principal: this.#subscriptionPrincipal };
    try { this.#pendingStorage?.setItem("re-subscription-pending-v1", JSON.stringify(marker)); }
    catch { return Promise.reject(new CabinetClientError("writes_unavailable")); }
    this.#subscriptionStorageNeedsRecovery = false;
    this.#subscriptionRecoveryState = null;
    this.#subscriptionMarker = marker;
    return this.#sendSubscriptionMarker(marker);
  }
  #sendSubscriptionMarker(marker) {
    const { kind, intent: payload } = marker, body = JSON.stringify(payload);
    if (kind === 'cancel') { this.#subscriptionCancellationFailure = null; this.#subscriptionCancellationTransport = null; }
    if (kind === "enable") this.#nativeOwnerRenewalPermissionTarget = null;
    const path = `${API}subscription/${kind === "invoice" ? "recurring-invoice" : `renewal/${kind}`}`;
    const clear = () => {
      if (this.#subscriptionMarker !== marker) return;
      try { this.#pendingStorage?.removeItem("re-subscription-pending-v1"); this.#subscriptionStorageNeedsRecovery = false; }
      catch { this.#subscriptionStorageNeedsRecovery = true; }
      // A validated terminal server result remains terminal if browser storage fails.
      // Reload recovers the retained original intent/key through a read-only lookup.
      this.#subscriptionMarker = null;
      this.#subscriptionRecoveryState = null;
    };
    const promise = this.#request(path, { method: "POST", body, key: marker.key }).then(data => {
      const authorization = readAuthorizationDTO(data.authorization, kind === "invoice" ? "billing.purchase_monthly" : "access.read_own");
      if (!authorization.allowed || !["admitted", "pending", "confirmed", "rejected", "unknown"].includes(data.status) || data.accessApplied !== false) fail("outcome_unknown");
      if (kind === "invoice") {
        if (data.billingMode !== "recurring" || data.periodSeconds !== 2592000 ||
            data.status === "confirmed" && !safeStarsInvoiceUrl(data.invoiceUrl) || data.status !== "confirmed" && data.invoiceUrl !== null) fail("outcome_unknown");
      } else if (data.contractId !== payload.contractId || data.action !== (kind === "cancel" ? "cancel_renewal" : "reenable_renewal") ||
          data.paidPeriodChanged !== false || data.providerState !== null ||
          data.cancellationConfirmed !== (kind === "cancel" && data.status === "confirmed") ||
          data.reenableAllowed !== (kind === "enable" && data.status === "confirmed")) fail("outcome_unknown");
      if (kind === "enable" && data.status === "confirmed") this.#recoveredRenewalPermission =
        Object.freeze({ contractId: marker.intent.contractId, expectedRevision: marker.intent.expectedRevision });
      if (kind === "cancel" && data.status === "confirmed" &&
          this.#recoveredRenewalPermission?.contractId === marker.intent.contractId) this.#recoveredRenewalPermission = null;
      if (["confirmed", "rejected"].includes(data.status)) clear();
      return Object.freeze({ ...data, authorization });
    }).catch(error => {
      if (kind === 'cancel') this.#subscriptionCancellationFailure = Object.freeze({
        code: typeof error?.code === 'string' && /^[a-z0-9_]{1,96}$/u.test(error.code) ? error.code : 'unavailable',
        status: Number.isSafeInteger(error?.status) && error.status >= 0 && error.status <= 599 ? error.status : 0,
        ...(this.#subscriptionCancellationTransport ?? { httpStatus: 0, phase: 'fetch', durationMs: 0, timedOut: false }) });
      if (!marker.reconfirm && error.code !== "outcome_unknown" && error.code !== "session_expired" && error.status >= 400 && error.status < 500) clear();
      if (this.#subscriptionMarker) throw new CabinetClientError("subscription_outcome_unknown", error.status);
      throw error;
    }).finally(() => { this.#subscriptionPending = null; });
    this.#subscriptionPending = promise;
    return promise;
  }
  packageAction(kind, payload) {
    try {
      this.checkSession();
      if (!['invoice', 'schedule', 'cancel', 'monthly-invoice'].includes(kind) || !(this.canMutate || this.#nativeOwnerInvoiceOnly) ||
          !this.#packageDescriptor?.canWrite || this.#packageDescriptor.validUntil * 1000 <= this.#now()) fail('writes_unavailable');
      const intent = this.#validatePackageIntent(kind, payload);
      const descriptor = this.#packageDescriptor;
      if (['invoice', 'schedule'].includes(kind)) {
        const offer = descriptor.offers.find(item => item.planCode === intent.requestedPlanCode && item.packageCode === intent.packageCode);
        if (!offer?.[kind]?.available || ['amountStars', 'currency', 'priceVersion', 'offerVersion', 'campaignCode', 'termsRevision']
          .some(field => intent.confirmation[field] !== offer[field])) fail('package_confirmation_changed');
      } else {
        const transition = descriptor.transitions.find(item => item.transitionId === intent.transitionId && item.revision === intent.expectedRevision);
        const action = kind === 'cancel' ? transition?.cancel : transition?.monthlyCheckout;
        if (action?.available !== true || kind === 'monthly-invoice' &&
            (intent.priceVersion !== action.priceVersion || intent.termsRevision !== action.termsRevision)) fail('state_conflict');
      }
      if (this.#packagePending || this.#pending || this.#subscriptionPending) fail('request_in_progress');
      if (this.#packageMarker || this.#subscriptionMarker || this.#uncertain) fail('package_outcome_unknown');
      if (!this.#subscriptionPrincipal) fail('writes_unavailable');
      const marker = { kind, key: this.#key(), startedAt: Math.floor(this.#now() / 1000), intent, principal: this.#subscriptionPrincipal };
      this.#pendingStorage?.setItem('re-package-pending-v1', JSON.stringify(marker));
      this.#packageStorageNeedsRecovery = false; this.#packageMarker = marker;
      return this.#sendPackageMarker(marker);
    } catch (error) { return Promise.reject(error instanceof CabinetClientError ? error : new CabinetClientError('writes_unavailable')); }
  }
  #validatePackageIntent(kind, payload) {
    if (!['invoice', 'schedule', 'cancel', 'monthly-invoice'].includes(kind)) fail('invalid_request');
    const positive = value => Number.isSafeInteger(value) && value > 0;
    const id = value => typeof value === 'string' && /^[a-f0-9-]{36}$/u.test(value);
    const version = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value);
    const fields = ['invoice', 'schedule'].includes(kind) ? ['requestedPlanCode', 'packageCode', 'confirmation']
      : kind === 'cancel' ? ['transitionId', 'expectedRevision'] : ['transitionId', 'expectedRevision', 'recurringConsent', 'termsRevision', 'priceVersion'];
    const intent = exact(payload, fields);
    if (Object.keys(intent).length !== fields.length) fail('invalid_request');
    if (['invoice', 'schedule'].includes(kind)) {
      if (!['professional', 'dragon'].includes(intent.requestedPlanCode) || !['30d', '3m', '6m', '12m'].includes(intent.packageCode) ||
          kind === 'invoice' && intent.packageCode === '30d') fail('invalid_request');
      const keys = ['acceptedTerms', 'amountStars', 'currency', 'priceVersion', 'offerVersion', 'campaignCode', 'termsRevision'];
      const confirmation = exact(intent.confirmation, keys);
      if (Object.keys(confirmation).length !== keys.length || confirmation.acceptedTerms !== true || !positive(confirmation.amountStars) ||
          confirmation.currency !== 'XTR' || !positive(confirmation.priceVersion) || !version(confirmation.offerVersion) || !version(confirmation.termsRevision) ||
          !(confirmation.campaignCode === null || typeof confirmation.campaignCode === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(confirmation.campaignCode))) fail('invalid_request');
    } else if (!id(intent.transitionId) || !positive(intent.expectedRevision) || kind === 'monthly-invoice' &&
        (intent.recurringConsent !== true || !version(intent.termsRevision) || !positive(intent.priceVersion))) fail('invalid_request');
    return intent;
  }
  recoverPackageAction() {
    try {
      this.checkSession();
      const marker = this.#packageMarker;
      if (!marker) return Promise.resolve(null);
      if (Object.hasOwn(marker, 'principal') && !sameSubscriptionPrincipal(subscriptionPrincipal(marker.principal), this.#subscriptionPrincipal))
        fail('pending_principal_mismatch');
      if (!(this.canMutate || this.#nativeOwnerInvoiceOnly) || !/^[a-f0-9]{48}$/u.test(marker.key)) fail('package_outcome_unknown');
      this.#validatePackageIntent(marker.kind, marker.intent);
      if (this.#packagePending || this.#pending || this.#subscriptionPending) fail('request_in_progress');
      return this.#sendPackageMarker(marker, { recovering: true });
    } catch (error) { return Promise.reject(error); }
  }
  #sendPackageMarker(marker, { recovering = false } = {}) {
    const clear = () => {
      try { this.#pendingStorage?.removeItem('re-package-pending-v1'); this.#packageStorageNeedsRecovery = false; }
      catch { this.#packageStorageNeedsRecovery = true; }
      // Terminal server evidence clears the live guard even if browser cleanup
      // fails. Keep the original durable identity for explicit recovery on reload;
      // an own subscription read must never resend a package producer.
      this.#packageMarker = null;
    };
    const promise = this.#request(`${API}packages/${marker.kind}`, { method: 'POST', body: JSON.stringify(marker.intent), key: marker.key }).then(data => {
      if (data.accessApplied !== false) fail('package_outcome_unknown');
      if (['invoice', 'monthly-invoice'].includes(marker.kind)) {
        const monthly = marker.kind === 'monthly-invoice', url = monthly ? data.invoiceUrl : data.invoiceURL;
        const confirmed = monthly ? data.status === 'confirmed' : data.status === 'issued';
        if (!(monthly ? ['admitted', 'pending', 'confirmed', 'rejected', 'unknown'].includes(data.status) && data.billingMode === 'recurring' &&
          data.periodSeconds === 2592000 && data.transitionId === marker.intent.transitionId
          : ['issued', 'manual_review'].includes(data.status) && data.packagePayment === true && data.planCode === marker.intent.requestedPlanCode &&
            data.packageCode === marker.intent.packageCode && data.amountStars === marker.intent.confirmation.amountStars &&
            data.accessSeconds === { '3m': 90, '6m': 180, '12m': 360 }[data.packageCode] * 86400 &&
            Number.isSafeInteger(data.periodStartsAt) && data.periodStartsAt > 0 && data.periodEndsAt === data.periodStartsAt + data.accessSeconds &&
            Number.isSafeInteger(data.expiresAt) && data.expiresAt > 0) || (confirmed ? !safeStarsInvoiceUrl(url) : url !== null)) fail('package_outcome_unknown');
        if (confirmed) {
          this.#recoveredPackageInvoice = Object.freeze({ url: safeStarsInvoiceUrl(url), planCode: monthly ? null : data.planCode,
            packageCode: monthly ? '30d' : data.packageCode, expiresAt: monthly ? this.#packageDescriptor?.transitions.find(item => item.transitionId === marker.intent.transitionId)?.monthlyCheckout?.expiresAt ?? null : data.expiresAt });
          clear();
        } else if (data.status === 'rejected') clear();
      } else {
        const transition = data.transition;
        if (!object(transition) || typeof data.replayed !== 'boolean' || transition.accessApplied !== false || transition.refundApplied !== false ||
            !/^[a-f0-9-]{36}$/u.test(transition.transitionId ?? '') || !Number.isSafeInteger(transition.revision) || transition.revision < 1 ||
            marker.kind === 'schedule' && (transition.toPlan !== marker.intent.requestedPlanCode || transition.packageCode !== marker.intent.packageCode || !['scheduled', 'fulfilled', 'cancelled'].includes(transition.state)) ||
            marker.kind === 'cancel' && (transition.transitionId !== marker.intent.transitionId || transition.state !== 'cancelled' || transition.revision !== marker.intent.expectedRevision + 1)) fail('package_outcome_unknown');
        clear();
      }
      this.#packageDescriptor = null; return Object.freeze(data);
    }).catch(error => {
      if (!recovering && error.code !== 'outcome_unknown' && error.code !== 'package_outcome_unknown' && error.code !== 'session_expired' && error.status >= 400 && error.status < 500) clear();
      if (this.#packageMarker) throw new CabinetClientError('package_outcome_unknown', error.status);
      throw error;
    }).finally(() => { this.#packagePending = null; });
    this.#packagePending = promise; return promise;
  }
  #recoverableSubscriptionMarker(marker) {
    if (!object(marker) || !['invoice', 'cancel', 'enable'].includes(marker.kind) ||
        !/^[a-f0-9]{48}$/u.test(marker.key) || !Number.isSafeInteger(marker.startedAt) || marker.startedAt <= 0 || !object(marker.intent)) return false;
    const intent = marker.intent, fields = marker.kind === 'invoice'
      ? ['planCode', 'recurringConsent', 'termsRevision', 'priceVersion'] : ['contractId', 'expectedRevision'];
    if (Object.keys(intent).length !== fields.length || fields.some(field => !Object.hasOwn(intent, field))) return false;
    return marker.kind === 'invoice'
      ? ['professional', 'dragon'].includes(intent.planCode) && intent.recurringConsent === true &&
        typeof intent.termsRevision === 'string' && intent.termsRevision.length > 0 && intent.termsRevision.length <= 128 &&
        Number.isSafeInteger(intent.priceVersion) && intent.priceVersion > 0
      : typeof intent.contractId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(intent.contractId) &&
        Number.isSafeInteger(intent.expectedRevision) && intent.expectedRevision > 0;
  }
  recoverSubscriptionAction({ signal } = {}) {
    return this.#readSubscriptionOperation({ signal });
  }
  recoverMissingSubscriptionAction() {
    if (!this.pendingSubscriptionRecoveryAvailable) return Promise.reject(new CabinetClientError('state_conflict'));
    // This explicit recovery endpoint records a server tombstone before any
    // delayed producer can run. It never replays the original financial POST.
    return this.#readSubscriptionOperation({ path: 'recover' });
  }
  #persistReconfirmationMarker(marker) {
    const serialized = JSON.stringify(marker);
    try {
      if (typeof this.#pendingStorage?.setItem !== 'function' || typeof this.#pendingStorage?.getItem !== 'function') fail('writes_unavailable');
      this.#pendingStorage.setItem('re-subscription-pending-v1', serialized);
      if (this.#pendingStorage.getItem('re-subscription-pending-v1') !== serialized) fail('writes_unavailable');
    } catch { this.#subscriptionStorageNeedsRecovery = true; fail('writes_unavailable'); }
    this.#subscriptionMarker = marker; this.#subscriptionStorageNeedsRecovery = false;
  }
  #reconfirmationBody(marker) {
    return JSON.stringify({ kind: 'cancel', intent: marker.intent, originalKey: marker.reconfirm.originalKey });
  }
  #readReconfirmationDTO(data, marker) {
    const fields = ['authority', 'kind', 'state', 'originalAttemptId', 'attemptId', 'contractId',
      'expectedRevision', 'originalState', 'accessApplied', 'financialCalls', 'authorization'];
    const id = value => typeof value === 'string' && /^[a-f0-9-]{36}$/u.test(value);
    const authorization = readAuthorizationDTO(data.authorization, 'access.read_own');
    if (!cancellationPredecessor(marker) || Object.keys(data).length !== fields.length ||
        fields.some(field => !Object.hasOwn(data, field)) || !authorization.allowed || data.authority !== 'worker' ||
        data.kind !== 'cancel' || data.contractId !== marker.intent.contractId || data.expectedRevision !== marker.intent.expectedRevision ||
        data.accessApplied !== false || data.financialCalls !== 0 || !id(data.originalAttemptId) ||
        !['missing', 'admitted', 'pending', 'confirmed', 'rejected', 'unknown'].includes(data.state) ||
        (data.state === 'missing' ? data.attemptId !== null || !['pending', 'unknown', 'confirmed', 'rejected'].includes(data.originalState)
          : !id(data.attemptId) || data.attemptId === data.originalAttemptId || data.originalState !== 'superseded') ||
        this.#subscriptionMarker !== marker) fail('invalid_response');
    return Object.freeze({ ...data, authorization });
  }
  #applyReconfirmationReceipt(marker, data, { readOnly = false } = {}) {
    this.#subscriptionReconfirmationReceipt = null;
    if (data.state === 'missing') {
      if (!readOnly) fail('invalid_response');
      // Only the own read-only endpoint proves there is no new row/link.
      // Preserve the original uncertain command, even if it has now completed.
      const previous = { kind: 'cancel', key: marker.reconfirm.originalKey, startedAt: marker.reconfirm.originalStartedAt,
        intent: marker.intent, principal: marker.principal };
      this.#persistReconfirmationMarker(previous);
      this.#subscriptionRecoveryState = Object.freeze({ state: 'not_checked', reasonCode: null, readOnly: true });
    } else if (['confirmed', 'rejected'].includes(data.state)) {
      if (readOnly) this.#verifiedSubscriptionOutcome = Object.freeze({ key: marker.key, kind: marker.kind, state: data.state });
      try { this.#pendingStorage?.removeItem('re-subscription-pending-v1'); this.#subscriptionStorageNeedsRecovery = false; }
      catch { this.#subscriptionStorageNeedsRecovery = true; }
      if (data.state === 'confirmed' && this.#recoveredRenewalPermission?.contractId === marker.intent.contractId)
        this.#recoveredRenewalPermission = null;
      this.#subscriptionMarker = null; this.#subscriptionRecoveryState = null;
    } else {
      this.#subscriptionRecoveryState = Object.freeze({ state: data.state, reasonCode: null, readOnly: true });
      if (readOnly && data.state === 'admitted') this.#subscriptionReconfirmationReceipt = { marker, data };
    }
  }
  reconfirmSubscriptionCancellation() {
    const mode = this.pendingCancellationReconfirmationMode;
    if (!mode) return Promise.reject(new CabinetClientError('state_conflict'));
    const previous = this.#subscriptionMarker;
    const promise = (async () => {
      this.checkSession();
      let marker = previous;
      if (mode === 'new') {
        const key = this.#key(); if (key === previous.key) fail('writes_unavailable');
        marker = { kind: 'cancel', key, startedAt: Math.floor(this.#now() / 1000), intent: previous.intent, principal: previous.principal,
          reconfirm: { originalKey: previous.key, originalStartedAt: previous.startedAt, stage: 'handoff' } };
        this.#persistReconfirmationMarker(marker); // Persist predecessor BEFORE the first handoff POST.
        this.#subscriptionRecoveryState = Object.freeze({ state: 'checking', reasonCode: null, readOnly: true });
        const data = this.#readReconfirmationDTO(await this.#request(`${API}subscription/renewal/reconfirm-cancel`, {
          method: 'POST', body: this.#reconfirmationBody(marker), key: marker.key }), marker);
        this.#applyReconfirmationReceipt(marker, data);
        if (data.state !== 'admitted') return data;
      }
      this.checkSession();
      // This producer is part of this explicit confirmation only. Reopening
      // reads the linked status; an admitted result requires another consent.
      marker = { ...marker, reconfirm: { ...marker.reconfirm, stage: 'producer' } };
      this.#persistReconfirmationMarker(marker);
      this.#subscriptionReconfirmationReceipt = null;
      return await this.#sendSubscriptionMarker(marker);
    })().catch(error => {
      this.#subscriptionReconfirmationReceipt = null;
      if (this.#subscriptionMarker?.reconfirm) this.#subscriptionRecoveryState = Object.freeze({ state: 'lookup_failed',
        reasonCode: error?.code === 'invalid_response' ? 'operation_status_invalid' : 'operation_status_unavailable', readOnly: true });
      throw error;
    }).finally(() => { this.#subscriptionReconfirmation = null; });
    this.#subscriptionReconfirmation = promise; return promise;
  }
  #readCancellationReconfirmation(marker, { signal } = {}) {
    this.#subscriptionReconfirmationReceipt = null;
    this.#subscriptionRecoveryState = Object.freeze({ state: 'checking', reasonCode: null, readOnly: true });
    const promise = this.#request(`${API}subscription/renewal/reconfirm-cancel-status`, {
      method: 'POST', signal, body: this.#reconfirmationBody(marker), key: marker.key }).then(value => {
      const data = this.#readReconfirmationDTO(value, marker);
      this.#applyReconfirmationReceipt(marker, data, { readOnly: true }); return data;
    }).catch(error => {
      if (this.#subscriptionMarker === marker) this.#subscriptionRecoveryState = Object.freeze({ state: 'lookup_failed',
        reasonCode: error?.code === 'invalid_response' ? 'operation_status_invalid' : 'operation_status_unavailable', readOnly: true });
      throw error;
    }).finally(() => { this.#subscriptionRecovery = null; });
    this.#subscriptionRecovery = promise; return promise;
  }
  #readSubscriptionOperation({ signal, path = 'operation-status' } = {}) {
    const marker = this.#subscriptionMarker;
    if (!marker || !this.#recoverableSubscriptionMarker(marker)) return Promise.resolve(null);
    if (Object.hasOwn(marker, 'principal') && !sameSubscriptionPrincipal(subscriptionPrincipal(marker.principal), this.#subscriptionPrincipal)) {
      this.#subscriptionRecoveryState = Object.freeze({ state: 'principal_mismatch', reasonCode: 'saved_operation_principal_mismatch', readOnly: true });
      return Promise.reject(new CabinetClientError('pending_principal_mismatch'));
    }
    if (this.#subscriptionPending || this.#subscriptionReconfirmation) return Promise.reject(new CabinetClientError("request_in_progress"));
    if (this.#subscriptionRecovery) return this.#subscriptionRecovery;
    if (Object.hasOwn(marker, 'reconfirm')) {
      if (path !== 'operation-status' || !cancellationPredecessor(marker)) return Promise.reject(new CabinetClientError('state_conflict'));
      return this.#readCancellationReconfirmation(marker, { signal });
    }
    if (path === 'recover') { this.#subscriptionRecoveryFailure = null; this.#subscriptionRecoveryTransport = null; }
    this.#subscriptionRecoveryState = Object.freeze({ state: 'checking', reasonCode: null, readOnly: true });
    const promise = this.#request(`${API}subscription/${path}`, { method: "POST", signal,
      body: JSON.stringify({ kind: marker.kind, intent: marker.intent }), key: marker.key }).then(data => {
      const authorization = readAuthorizationDTO(data.authorization, "access.read_own");
      const superseded = path === 'recover' && marker.kind !== 'invoice' && data.resolution === 'superseded_before_admission';
      const fields = ["authority", "kind", "state", "attemptId", "contractId", "invoiceUrl", "effectRecorded", "accessApplied", "reviewRequired", "actionAdmissionRequired", "authorization", ...(superseded ? ['resolution'] : [])];
      if (Object.keys(data).length !== fields.length || fields.some(field => !Object.hasOwn(data, field)) || !authorization.allowed ||
          data.authority !== "worker" || data.kind !== marker.kind || data.accessApplied !== false || data.actionAdmissionRequired !== true ||
          !["missing", "admitted", "pending", "confirmed", "rejected", "unknown"].includes(data.state) ||
          typeof data.effectRecorded !== "boolean" || typeof data.reviewRequired !== "boolean" ||
          (superseded ? data.state !== 'rejected' || data.effectRecorded !== false || data.attemptId !== null ||
            data.contractId !== marker.intent.contractId || data.reviewRequired !== false
            : data.effectRecorded !== (data.state !== "missing") ||
              (data.state === "missing" ? data.attemptId !== null || data.contractId !== null : typeof data.attemptId !== "string" || typeof data.contractId !== "string")) ||
          (marker.kind === "invoice" && data.state === "confirmed" ? !safeStarsInvoiceUrl(data.invoiceUrl) : data.invoiceUrl !== null)) fail("invalid_response");
      if (marker.kind !== "invoice" && data.effectRecorded && data.contractId !== marker.intent.contractId) fail("invalid_response");
      if (this.#subscriptionMarker !== marker) fail("invalid_response");
      this.#subscriptionRecoveryState = Object.freeze({ state: data.state,
        reasonCode: data.state === 'missing' ? 'saved_operation_not_found' : null, readOnly: true });
      if (["confirmed", "rejected"].includes(data.state)) {
        this.#verifiedSubscriptionOutcome = Object.freeze({ key: marker.key, kind: marker.kind, state: data.state });
        try { this.#pendingStorage?.removeItem("re-subscription-pending-v1"); this.#subscriptionStorageNeedsRecovery = false; }
        catch { this.#subscriptionStorageNeedsRecovery = true; }
        if (data.state === "confirmed" && marker.kind === "invoice") this.#recoveredInvoice = safeStarsInvoiceUrl(data.invoiceUrl);
        if (data.state === "confirmed" && marker.kind === "enable") this.#recoveredRenewalPermission =
          Object.freeze({ contractId: marker.intent.contractId, expectedRevision: marker.intent.expectedRevision });
        if (data.state === "confirmed" && marker.kind === "enable") this.#nativeOwnerRenewalPermissionTarget = null;
        if (data.state === "confirmed" && marker.kind === "cancel" &&
            this.#recoveredRenewalPermission?.contractId === marker.intent.contractId) this.#recoveredRenewalPermission = null;
        this.#subscriptionMarker = null;
        this.#subscriptionRecoveryState = null;
      }
      return Object.freeze({ ...data, authorization });
    }).catch(error => {
      if (path === 'recover') this.#subscriptionRecoveryFailure = Object.freeze({
        code: typeof error?.code === 'string' && /^[a-z0-9_]{1,96}$/u.test(error.code) ? error.code : 'unavailable',
        status: Number.isSafeInteger(error?.status) && error.status >= 0 && error.status <= 599 ? error.status : 0,
        ...(this.#subscriptionRecoveryTransport ?? { httpStatus: 0, phase: 'fetch', durationMs: 0, timedOut: false }) });
      if (this.#subscriptionMarker === marker) this.#subscriptionRecoveryState = Object.freeze({
        state: 'lookup_failed', reasonCode: error?.code === 'invalid_response' ? 'operation_status_invalid' : 'operation_status_unavailable', readOnly: true });
      throw error;
    }).finally(() => { this.#subscriptionRecovery = null; });
    this.#subscriptionRecovery = promise; return promise;
  }
  mutate(action, payload, target) {
    if (this.#packagePending || this.#packageMarker) return Promise.reject(new CabinetClientError('package_outcome_unknown'));
    if (!this.canMutate) return Promise.reject(new CabinetClientError("writes_unavailable"));
    if (this.#subscriptionPending) return Promise.reject(new CabinetClientError("request_in_progress"));
    if (this.#uncertain) return Promise.reject(new CabinetClientError("outcome_unknown"));
    const request = buildActionRequest(action, payload, target);
    const signature = `${request.path}\n${request.body}`;
    if (this.#pending) {
      return this.#pending.signature === signature ? this.#pending.promise
        : Promise.reject(new CabinetClientError("request_in_progress"));
    }
    const promise = this.#request(request.path, { method: "POST", body: request.body, key: this.#key() })
      .then(data => {
        if (!["committed", "unchanged"].includes(data.commitStatus)) fail("outcome_unknown");
        if (this.#authorizationVersion === 1 || data.authorization !== undefined) {
          try { data.authorization = readAuthorizationDTO(data.authorization, actionCapability[action]); }
          catch { fail("outcome_unknown"); }
        }
        return data;
      })
      .catch(error => { if (error.code === "outcome_unknown") this.#uncertain = true; throw error; })
      .finally(() => { this.#pending = null; });
    this.#pending = { signature, promise };
    return promise;
  }
}

export function safeStarsInvoiceUrl(value) {
  try {
    const url = new URL(value);
    return typeof value === "string" && value.length <= 2048 && url.protocol === "https:" && url.hostname === "t.me" &&
      !url.port && !url.username && !url.password && !url.search && !url.hash && /^\/\$[A-Za-z0-9_-]+$/u.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

// Only the latest navigation can commit UI data, including across logout.
export class CabinetNavigator {
  #client; #generation = 0; #controller = null; #publish;
  constructor(client, publish) { this.#client = client; this.#publish = publish; }
  cancel() { this.#generation++; this.#controller?.abort(); }
  async load(section, { view, period = "7d", cursor, leadId } = {}) {
    if (!SECTIONS.includes(section)) fail("invalid_request");
    this.cancel();
    const generation = this.#generation;
    this.#controller = new AbortController();
    this.#publish({ status: "loading", section, view, period, cursor, leadId });
    const resource = leadId ? "application" : section;
    const params = leadId ? { leadId } : ["offers", "applications"].includes(section)
      ? { view, ...(cursor ? { cursor } : {}) } : section === "analytics" ? { period } : {};
    try {
      const data = await this.#client.read(resource, params, { signal: this.#controller.signal });
      if (generation === this.#generation) this.#publish({ status: "ready", section, view, period, cursor, leadId, data });
    } catch (error) {
      if (generation === this.#generation) this.#publish({ status: "error", section, view, period, cursor, leadId, error });
    }
  }
}

export function safeActionUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || value.length > 1000 ||
        host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost") ||
        host.includes(":") || /^\d+(?:\.\d+){0,3}$/u.test(host)) return null;
    for (const key of url.searchParams.keys()) {
      if (["token", "initdata", "init_data", "session", "session_token", "authorization", "api_key"].includes(key.toLowerCase())) return null;
    }
    return url.href;
  } catch { return null; }
}

export function privacyValue(cell) {
  if (!cell || cell.available !== true) return "Недоступно";
  if (cell.suppressed === true) return "Скрыто для приватности";
  return Number.isSafeInteger(cell.value) && cell.value >= 0 ? String(cell.value) : "Недоступно";
}
export function formatDate(value) {
  if (value === null || value === undefined || value === "") return "Не указана";
  const normalized = typeof value === "number" ? value * 1000
    : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value) ? value.replace(" ", "T") + "Z" : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? "Не указана"
    : new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Moscow" }).format(date);
}
export function formatMoney(kopecks) {
  return Number.isSafeInteger(kopecks) && kopecks >= 0
    ? new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(kopecks / 100) : "Недоступно";
}


export function formatAge(minAge, maxAge) {
  const valid = value => value === null || value === undefined ||
    (Number.isSafeInteger(value) && value >= 0 && value <= 100);
  if (!valid(minAge) || !valid(maxAge) || (minAge != null && maxAge != null && minAge > maxAge)) return "Не указан";
  if (minAge == null && maxAge == null) return "Не указан";
  const genitive = value => value % 10 === 1 && value % 100 !== 11 ? "года" : "лет";
  if (maxAge == null) return `От ${minAge} ${genitive(minAge)}`;
  if (minAge == null) return `До ${maxAge} ${genitive(maxAge)}`;
  const ending = maxAge % 100;
  const unit = ending >= 11 && ending <= 14 ? "лет"
    : maxAge % 10 === 1 ? "год" : [2, 3, 4].includes(maxAge % 10) ? "года" : "лет";
  return `${minAge === maxAge ? minAge : `${minAge}–${maxAge}`} ${unit}`;
}

export function formatUtcPeriod({ start, endExclusive } = {}) {
  const date = value => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? parsed : null;
  };
  const first = date(start), end = date(endExclusive);
  if (!first || !end || end <= first) return "Период недоступен";
  // Read-model periods are half-open UTC days; present their last included day.
  const last = new Date(end.getTime() - 86_400_000);
  const formatter = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const period = first.getTime() === last.getTime() ? formatter.format(first)
    : typeof formatter.formatRange === "function" ? formatter.formatRange(first, last)
      : `${formatter.format(first)} — ${formatter.format(last)}`;
  return `${period} · UTC`;
}


// Persist only this allowlisted appearance preference. Identity, session and
// account permissions never belong to this key. The head bootstrap uses the
// same key before the loading screen can paint.
export const CABINET_THEME_STORAGE_KEY = "re-program.cabinet.theme.v1";
export function mountThemeSelector({ document, telegram = null,
  media = globalThis.matchMedia?.("(prefers-color-scheme: dark)") ?? null, storage } = {}) {
  const modes = ["light", "dark", "system"];
  if (storage === undefined) {
    try { storage = document.defaultView?.localStorage ?? null; } catch { storage = null; }
  }
  const buttons = [...document.querySelectorAll('#theme-switcher button[data-theme-value]')];
  let mode = document.documentElement.getAttribute("data-theme-mode");
  if (!modes.includes(mode)) mode = "light";
  try {
    const saved = storage?.getItem(CABINET_THEME_STORAGE_KEY);
    if (modes.includes(saved)) mode = saved;
  } catch {}
  const apply = () => {
    const host = ["light", "dark"].includes(telegram?.colorScheme)
      ? telegram.colorScheme : media?.matches ? "dark" : "light";
    document.documentElement.setAttribute("data-theme-mode", mode);
    document.documentElement.setAttribute("data-color-theme", mode === "system" ? host : mode);
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-theme-value") === mode));
    }
  };
  const handlers = buttons.map(button => {
    const handler = () => {
      const next = button.getAttribute("data-theme-value");
      if (modes.includes(next)) {
        mode = next;
        try { storage?.setItem(CABINET_THEME_STORAGE_KEY, mode); } catch {}
        apply();
      }
    };
    button.addEventListener("click", handler); return [button, handler];
  });
  telegram?.onEvent?.("themeChanged", apply);
  media?.addEventListener?.("change", apply);
  apply();
  const bar = document.getElementById("theme-bar"); if (bar) bar.hidden = false;
  return {
    get mode() { return mode; },
    destroy() {
      telegram?.offEvent?.("themeChanged", apply); media?.removeEventListener?.("change", apply);
      for (const [button, handler] of handlers) button.removeEventListener("click", handler);
      if (bar) bar.hidden = true;
    },
  };
}
