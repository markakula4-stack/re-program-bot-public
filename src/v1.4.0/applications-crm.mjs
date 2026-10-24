import {
  CABINET_PLAN_QUOTAS,
  deriveIdempotencyKey,
  evaluateCabinetCapability,
  resolveCabinetQuota,
  sha256Hex,
} from "./cabinet-foundation.mjs";

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

export const APPLICATION_POLICY_VERSION =
  "2026-09-14.cabinet-v1-part3";
export const APPLICATION_TRANSITION_CONTRACT_VERSION = 1;

export const APPLICATION_STATUSES = deepFreeze({
  submitted: { active: true, terminal: false },
  accepted: { active: true, terminal: false },
  in_progress: { active: true, terminal: false },
  waiting_user: { active: true, terminal: false },
  completed: { active: false, terminal: true },
  rejected: { active: false, terminal: true },
  cancelled: { active: false, terminal: true },
  archived: { active: false, terminal: true },
});

export const APPLICATION_TRANSITIONS = deepFreeze({
  submitted: ["accepted", "rejected", "cancelled"],
  accepted: ["in_progress", "waiting_user", "rejected", "cancelled"],
  in_progress: ["waiting_user", "completed", "rejected", "cancelled"],
  waiting_user: ["in_progress", "completed", "rejected", "cancelled"],
  completed: ["archived"],
  rejected: ["archived"],
  cancelled: ["archived"],
  archived: [],
});

export const APPLICATION_RESULT_BY_STATUS = deepFreeze({
  completed: "successful",
  rejected: "unsuccessful",
  cancelled: "cancelled",
});

const HEX_64 = /^[0-9a-f]{64}$/u;
const SAFE_CODE = /^[a-z][a-z0-9_]{1,63}$/u;
const OFFER_CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/u;
const IDS = {
  application: /^app_[0-9a-f]{64}$/u,
  create: /^acr_[0-9a-f]{64}$/u,
  event: /^aev_[0-9a-f]{64}$/u,
  transition: /^atr_[0-9a-f]{64}$/u,
  note: /^ant_[0-9a-f]{64}$/u,
  assignment: /^aas_[0-9a-f]{64}$/u,
  result: /^ars_[0-9a-f]{64}$/u,
  resource: /^res_[0-9a-f]{64}$/u,
  publication: /^pub_[0-9a-f]{64}$/u,
};
const PLAN_SET = new Set(["free", "professional", "dragon"]);
const ROLE_SET = new Set(["user", "partner", "admin"]);
const ACTION_SOURCE_SET = new Set(["mini_app", "worker", "admin", "system"]);
const ACTIVE_STATUS_SET = new Set(Object.entries(APPLICATION_STATUSES)
  .filter(([, value]) => value.active).map(([key]) => key));
const TERMINAL_STATUS_SET = new Set(Object.entries(APPLICATION_STATUSES)
  .filter(([, value]) => value.terminal).map(([key]) => key));
const CLIENT_ALLOWED_FIELDS = new Set(["sourceLeadId"]);
const CLIENT_PROHIBITED_FIELDS = new Set([
  "applicationId", "resourceId", "offerCycleId", "publicationId",
  "offerCode", "offerVersionId", "ownerPartnerProfileId",
  "ownerTelegramId", "partnerLinkId", "programCode", "plan", "planCode",
  "quota", "quotaLimit", "used", "remaining", "status", "revision",
  "assignment", "result", "reward", "payment", "access",
]);

export class ApplicationPolicyError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ApplicationPolicyError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new ApplicationPolicyError(code, message);
};

const record = (value, code = "invalid_record") => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
};

const field = (value, camel, snake) => value?.[camel] ?? value?.[snake];

const positiveInteger = (value, code = "invalid_integer") => {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
};

const nonNegativeInteger = (value, code = "invalid_integer") => {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
};

const exactText = (value, code, min = 1, max = 512) => {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    fail(code);
  }
  return value;
};

const digest = (value, code = "invalid_hash") => {
  const normalized = String(value || "").toLowerCase().replace(/^sha256:/u, "");
  if (!HEX_64.test(normalized)) fail(code);
  return normalized;
};

const opaqueId = (value, kind, code = "invalid_id") => {
  const normalized = String(value || "");
  if (!IDS[kind]?.test(normalized)) fail(code);
  return normalized;
};

const canonicalize = (value) => {
  if (value === null || typeof value === "string" ||
      typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_canonical_value");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      canonicalize(value[key]),
    ]));
  }
  fail("invalid_canonical_value");
};

export const stableApplicationJson = (value) =>
  JSON.stringify(canonicalize(value));

const hashRecord = (value) => sha256Hex(stableApplicationJson(value));

const deterministicId = async (prefix, domain, key) =>
  `${prefix}${await sha256Hex(`${domain}:${key}`)}`;

const normalizeActor = (value) => {
  const actor = record(value, "invalid_actor");
  const telegramId = positiveInteger(
    field(actor, "telegramId", "telegram_id"),
    "invalid_actor",
  );
  const systemRole = field(actor, "systemRole", "system_role");
  if (!ROLE_SET.has(systemRole) || actor.active !== true) fail("invalid_actor");
  const partnerProfileId = field(
    actor,
    "partnerProfileId",
    "partner_profile_id",
  );
  if (systemRole === "partner") {
    positiveInteger(partnerProfileId, "invalid_actor");
  } else if (partnerProfileId !== undefined && partnerProfileId !== null) {
    positiveInteger(partnerProfileId, "invalid_actor");
  }
  return { telegramId, systemRole, partnerProfileId: partnerProfileId ?? null };
};

const normalizeActionSource = (value, actor) => {
  const source = value ?? (actor.systemRole === "admin" ? "admin" : "mini_app");
  if (!ACTION_SOURCE_SET.has(source) ||
      (actor.systemRole !== "admin" && new Set(["admin", "system"]).has(source))) {
    fail("invalid_action_source");
  }
  return source;
};

const normalizeGate = (value) => {
  const settings = record(value, "invalid_settings");
  return {
    configurationAligned: settings.configurationAligned === true,
    rolloutMode: field(settings, "rolloutMode", "rollout_mode"),
    cabinetMasterEnabled: field(
      settings,
      "cabinetMasterEnabled",
      "cabinet_master_enabled",
    ) === true,
    cabinetApplicationEnabled: field(
      settings,
      "cabinetApplicationEnabled",
      "cabinet_application_enabled",
    ) === true,
    part3Enabled: field(settings, "part3Enabled", "part3_enabled") === true,
    lifecycleEnabled: field(
      settings,
      "lifecycleEnabled",
      "lifecycle_enabled",
    ) === true,
    crmEnabled: field(settings, "crmEnabled", "crm_enabled") === true,
    contactsEnabled: field(
      settings,
      "contactsEnabled",
      "contacts_enabled",
    ) === true,
    notesEnabled: field(settings, "notesEnabled", "notes_enabled") === true,
    assignmentEnabled: field(
      settings,
      "assignmentEnabled",
      "assignment_enabled",
    ) === true,
    resultEnabled: field(settings, "resultEnabled", "result_enabled") === true,
  };
};

const featureEnabled = (settings, feature) => {
  const gate = normalizeGate(settings);
  return gate.configurationAligned && gate.rolloutMode === "admin_shadow" &&
    gate.cabinetMasterEnabled && gate.cabinetApplicationEnabled &&
    gate.part3Enabled && gate.lifecycleEnabled && gate.crmEnabled &&
    (feature === "lifecycle" || gate[`${feature}Enabled`] === true);
};

const requireFeature = (settings, feature) => {
  if (!featureEnabled(settings, feature)) fail("feature_off");
};

const foundationSettings = (settings) => {
  const gate = normalizeGate(settings);
  return {
    gateVersion: 1,
    configurationAligned: gate.configurationAligned,
    rolloutMode: gate.rolloutMode,
    masterEnabled: gate.cabinetMasterEnabled,
    profileEnabled: false,
    offerEnabled: false,
    applicationEnabled: gate.cabinetApplicationEnabled,
    exportEnabled: false,
  };
};

const normalizeApplication = (value) => {
  const application = record(value, "invalid_application_authority");
  if (field(application, "authoritySource", "authority_source") !== "database") {
    fail("untrusted_application_authority");
  }
  const currentStatus = field(application, "currentStatus", "current_status");
  if (!Object.hasOwn(APPLICATION_STATUSES, currentStatus)) {
    fail("unknown_status");
  }
  const contractVersion = positiveInteger(
    field(
      application,
      "transitionContractVersion",
      "transition_contract_version",
    ),
    "invalid_transition_contract",
  );
  if (contractVersion !== APPLICATION_TRANSITION_CONTRACT_VERSION) {
    fail("invalid_transition_contract");
  }
  return {
    applicationId: opaqueId(
      field(application, "applicationId", "application_id"),
      "application",
      "invalid_application",
    ),
    resourceId: opaqueId(
      field(application, "resourceId", "resource_id"),
      "resource",
      "invalid_application",
    ),
    subjectTelegramId: positiveInteger(
      field(application, "subjectTelegramId", "subject_telegram_id"),
      "invalid_application",
    ),
    ownerPartnerProfileId: positiveInteger(
      field(
        application,
        "ownerPartnerProfileId",
        "owner_partner_profile_id",
      ),
      "invalid_application",
    ),
    ownerTelegramId: positiveInteger(
      field(application, "ownerTelegramId", "owner_telegram_id"),
      "invalid_application",
    ),
    currentStatus,
    revision: positiveInteger(application.revision, "invalid_revision"),
    transitionContractVersion: contractVersion,
    resultRecorded: field(
      application,
      "resultRecorded",
      "result_recorded",
    ) === true,
  };
};

const resourceForActor = (application, actor) => ({
  resourceId: application.resourceId,
  resourceKind: "application",
  ownerTelegramId: actor.systemRole === "user"
    ? application.subjectTelegramId
    : application.ownerTelegramId,
  ownerPartnerProfileId: application.ownerPartnerProfileId,
  visibility: "private",
  visibilityAuthority: "database",
});

export function authorizeApplicationAction({
  settings,
  actor: actorValue,
  application: applicationValue,
  capability,
  grants = [],
  revokedGrantIds = [],
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const actor = normalizeActor(actorValue);
  const application = normalizeApplication(applicationValue);
  if (!new Set([
    "application.read",
    "application.create",
    "application.update",
  ]).has(capability)) fail("invalid_capability");
  if (!featureEnabled(settings, "lifecycle")) {
    return deepFreeze({
      allowed: false,
      decision: "deny",
      reason: "feature_off",
      capability,
      resourceKind: "application",
      resourceId: application.resourceId,
      scopeRule: "none",
    });
  }
  const scoped = capability === "application.create"
    ? (actor.systemRole === "admin" ||
      (actor.systemRole === "user" &&
        actor.telegramId === application.subjectTelegramId))
    : capability === "application.read"
      ? (actor.systemRole === "admin" ||
        (actor.systemRole === "user" &&
          actor.telegramId === application.subjectTelegramId) ||
        (actor.systemRole === "partner" &&
          actor.telegramId === application.ownerTelegramId &&
          actor.partnerProfileId === application.ownerPartnerProfileId))
      : (actor.systemRole === "admin" ||
        (actor.systemRole === "partner" &&
          actor.telegramId === application.ownerTelegramId &&
          actor.partnerProfileId === application.ownerPartnerProfileId));
  if (!scoped) {
    const roleDenied =
      (capability === "application.create" && actor.systemRole === "partner") ||
      (capability === "application.update" && actor.systemRole === "user");
    return deepFreeze({
      allowed: false,
      decision: "deny",
      reason: roleDenied ? "role_denied" : "scope_denied",
      capability,
      resourceKind: "application",
      resourceId: application.resourceId,
      scopeRule: "none",
    });
  }
  return evaluateCabinetCapability({
    settings: foundationSettings(settings),
    actor: actorValue,
    capability,
    resource: resourceForActor(application, actor),
    grants,
    revokedGrantIds,
    nowSeconds,
  });
}

const requireAuthorization = (input) => {
  const authorization = authorizeApplicationAction(input);
  if (!authorization.allowed) fail(authorization.reason);
  return authorization;
};

export function assertApplicationClientPayload(payload) {
  const value = record(payload, "invalid_client_payload");
  for (const key of Object.keys(value)) {
    if (CLIENT_PROHIBITED_FIELDS.has(key) || !CLIENT_ALLOWED_FIELDS.has(key)) {
      fail("client_authority_field");
    }
  }
  positiveInteger(value.sourceLeadId, "invalid_source_lead");
  return deepFreeze({ sourceLeadId: value.sourceLeadId });
}

const normalizeSourceLead = (value) => {
  const lead = record(value, "invalid_source_lead");
  if (field(lead, "authoritySource", "authority_source") !== "database" ||
      field(lead, "sourceKind", "source_kind") !== "lead_request") {
    fail("untrusted_source_lead");
  }
  const offerCode = field(lead, "offerCode", "offer_code");
  if (!OFFER_CODE.test(offerCode)) fail("invalid_offer_code");
  if (lead.status !== "pending") fail("source_lead_not_pending");
  return {
    sourceKind: "lead_request",
    sourceLeadId: positiveInteger(field(lead, "id", "id"), "invalid_source_lead"),
    subjectTelegramId: positiveInteger(
      field(lead, "telegramId", "telegram_id"),
      "invalid_source_lead",
    ),
    offerCode,
    status: lead.status,
  };
};

const normalizeOfferCycle = (value) => {
  const cycle = record(value, "invalid_offer_cycle");
  if (field(cycle, "authoritySource", "authority_source") !== "database") {
    fail("untrusted_offer_cycle");
  }
  const offerCode = field(cycle, "offerCode", "offer_code");
  if (!OFFER_CODE.test(offerCode)) fail("invalid_offer_code");
  if (field(cycle, "moderationStatus", "moderation_status") !== "approved" ||
      cycle.visibility !== "public" ||
      field(cycle, "currentPublication", "current_publication") !== true) {
    fail("offer_cycle_not_public");
  }
  return {
    offerCycleId: opaqueId(
      field(cycle, "publicationId", "publication_id"),
      "publication",
      "invalid_offer_cycle",
    ),
    offerCode,
    offerVersionId: positiveInteger(
      field(cycle, "offerVersionId", "offer_version_id"),
      "invalid_offer_cycle",
    ),
    ownerPartnerProfileId: positiveInteger(
      field(cycle, "ownerPartnerProfileId", "owner_partner_profile_id"),
      "invalid_offer_cycle",
    ),
    ownerTelegramId: positiveInteger(
      field(cycle, "ownerTelegramId", "owner_telegram_id"),
      "invalid_offer_cycle",
    ),
    partnerLinkId: positiveInteger(
      field(cycle, "partnerLinkId", "partner_link_id"),
      "invalid_offer_cycle",
    ),
    programCode: exactText(
      field(cycle, "programCode", "program_code"),
      "invalid_offer_cycle",
      1,
      64,
    ),
    authorityHash: digest(
      field(cycle, "authorityHash", "authority_hash"),
      "invalid_offer_authority_hash",
    ),
  };
};

const normalizePlanAuthority = (value, subjectTelegramId) => {
  const plan = record(value, "invalid_plan_authority");
  if (field(plan, "authoritySource", "authority_source") !== "database") {
    fail("untrusted_plan_authority");
  }
  const planSubject = positiveInteger(
    field(plan, "subjectTelegramId", "subject_telegram_id"),
    "invalid_plan_authority",
  );
  const planCode = field(plan, "planCode", "plan_code");
  if (planSubject !== subjectTelegramId) fail("foreign_plan_authority");
  if (!PLAN_SET.has(planCode)) fail("invalid_plan");
  return {
    planCode,
    planAuthorityKeyHash: digest(
      field(plan, "authorityKeyHash", "authority_key_hash"),
      "invalid_plan_authority",
    ),
  };
};

const normalizeQuotaAuthority = (value, planCode) => {
  const quota = record(value, "invalid_quota_authority");
  if (field(quota, "authoritySource", "authority_source") !== "database" ||
      field(quota, "quotaCode", "quota_code") !== "active_applications" ||
      field(quota, "windowKind", "window_kind") !== "concurrent" ||
      field(quota, "planCode", "plan_code") !== planCode) {
    fail("untrusted_quota_authority");
  }
  const quotaLimit = positiveInteger(
    field(quota, "limit", "limit_value"),
    "invalid_quota_authority",
  );
  if (quotaLimit !== CABINET_PLAN_QUOTAS.active_applications[planCode]) {
    fail("quota_authority_mismatch");
  }
  return { quotaLimit };
};

export async function buildApplicationCreateReceipt({
  settings,
  actor: actorValue,
  sourceLead: sourceLeadValue,
  offerCycle: offerCycleValue,
  planAuthority: planAuthorityValue,
  quotaAuthority: quotaAuthorityValue,
  rawIdempotencyKey,
  idempotencySecret,
  actionSource,
  grants = [],
  revokedGrantIds = [],
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  requireFeature(settings, "contacts");
  const actor = normalizeActor(actorValue);
  const normalizedActionSource = normalizeActionSource(actionSource, actor);
  if (!new Set(["user", "admin"]).has(actor.systemRole)) fail("role_denied");
  const source = normalizeSourceLead(sourceLeadValue);
  const cycle = normalizeOfferCycle(offerCycleValue);
  if (source.offerCode !== cycle.offerCode) fail("foreign_offer_cycle");
  const plan = normalizePlanAuthority(
    planAuthorityValue,
    source.subjectTelegramId,
  );
  const quota = normalizeQuotaAuthority(quotaAuthorityValue, plan.planCode);
  const provisionalApplication = {
    authoritySource: "database",
    applicationId: `app_${"0".repeat(64)}`,
    resourceId: `res_${"0".repeat(64)}`,
    subjectTelegramId: source.subjectTelegramId,
    ownerPartnerProfileId: cycle.ownerPartnerProfileId,
    ownerTelegramId: cycle.ownerTelegramId,
    currentStatus: "submitted",
    revision: 1,
    transitionContractVersion: APPLICATION_TRANSITION_CONTRACT_VERSION,
  };
  requireAuthorization({
    settings,
    actor: actorValue,
    application: provisionalApplication,
    capability: "application.create",
    grants,
    revokedGrantIds,
    nowSeconds,
  });
  const idempotencyKey = await deriveIdempotencyKey({
    secret: idempotencySecret,
    operation: "application.create",
    rawKey: rawIdempotencyKey,
  });
  const applicationId = await deterministicId(
    "app_",
    "application",
    idempotencyKey,
  );
  const createReceiptId = await deterministicId(
    "acr_",
    "application-create",
    idempotencyKey,
  );
  const resourceId = await deterministicId(
    "res_",
    "application-resource",
    applicationId,
  );
  const eventId = await deterministicId(
    "aev_",
    "application-created-event",
    idempotencyKey,
  );
  const sourceAuthorityHash = await hashRecord(source);
  const resourceAuthorityHash = await sha256Hex(
    `lead_request:${source.sourceLeadId}:publication:${cycle.offerCycleId}`,
  );
  const contactHash = await hashRecord({
    kind: "telegram_id",
    value: String(source.subjectTelegramId),
  });
  const actorKeyHash = await sha256Hex(`telegram:${actor.telegramId}`);
  const request = {
    actorKeyHash,
    actorRole: actor.systemRole,
    actionSource: normalizedActionSource,
    sourceKind: source.sourceKind,
    sourceLeadId: source.sourceLeadId,
    subjectTelegramId: source.subjectTelegramId,
    offerCycleId: cycle.offerCycleId,
    offerCode: cycle.offerCode,
    offerVersionId: cycle.offerVersionId,
    ownerPartnerProfileId: cycle.ownerPartnerProfileId,
    planCode: plan.planCode,
    quotaLimit: quota.quotaLimit,
  };
  const after = {
    applicationId,
    resourceId,
    currentStatus: "submitted",
    revision: 1,
  };
  return deepFreeze({
    createReceiptId,
    applicationId,
    resourceId,
    eventId,
    sourceKind: source.sourceKind,
    sourceLeadId: source.sourceLeadId,
    subjectTelegramId: source.subjectTelegramId,
    offerCycleId: cycle.offerCycleId,
    offerCode: cycle.offerCode,
    offerVersionId: cycle.offerVersionId,
    ownerPartnerProfileId: cycle.ownerPartnerProfileId,
    ownerTelegramId: cycle.ownerTelegramId,
    partnerLinkId: cycle.partnerLinkId,
    programCode: cycle.programCode,
    planCode: plan.planCode,
    quotaLimit: quota.quotaLimit,
    planAuthoritySource: "database",
    planAuthorityKeyHash: plan.planAuthorityKeyHash,
    sourceAuthorityHash,
    resourceAuthorityHash,
    offerAuthorityHash: cycle.authorityHash,
    contactHash,
    actorTelegramId: actor.telegramId,
    actorRole: actor.systemRole,
    actionSource: normalizedActionSource,
    actorKeyHash,
    initialStatus: "submitted",
    transitionContractVersion: APPLICATION_TRANSITION_CONTRACT_VERSION,
    initialRevision: 1,
    idempotencyKey,
    requestHash: await hashRecord(request),
    beforeHash: await hashRecord({ application: null }),
    afterHash: await hashRecord(after),
    createdAt: positiveInteger(nowSeconds, "invalid_time"),
  });
}

const CREATE_COLUMNS = [
  "create_receipt_id", "application_id", "resource_id", "event_id",
  "source_kind", "source_lead_id", "subject_telegram_id", "offer_cycle_id",
  "offer_code", "offer_version_id", "owner_partner_profile_id",
  "owner_telegram_id", "partner_link_id", "program_code", "plan_code",
  "quota_limit", "plan_authority_source", "plan_authority_key_hash",
  "source_authority_hash", "resource_authority_hash", "offer_authority_hash",
  "contact_hash", "actor_telegram_id", "actor_role", "actor_key_hash",
  "action_source",
  "initial_status", "transition_contract_version", "initial_revision",
  "idempotency_key", "request_hash", "before_hash", "after_hash", "created_at",
];

const CREATE_PROPERTIES = [
  "createReceiptId", "applicationId", "resourceId", "eventId", "sourceKind",
  "sourceLeadId", "subjectTelegramId", "offerCycleId", "offerCode",
  "offerVersionId", "ownerPartnerProfileId", "ownerTelegramId",
  "partnerLinkId", "programCode", "planCode", "quotaLimit",
  "planAuthoritySource", "planAuthorityKeyHash", "sourceAuthorityHash",
  "resourceAuthorityHash", "offerAuthorityHash", "contactHash",
  "actorTelegramId", "actorRole", "actorKeyHash", "actionSource",
  "initialStatus",
  "transitionContractVersion", "initialRevision", "idempotencyKey",
  "requestHash", "beforeHash", "afterHash", "createdAt",
];

export function buildApplicationCreateMutation(receiptValue) {
  const receipt = record(receiptValue, "invalid_create_receipt");
  for (const property of CREATE_PROPERTIES) {
    if (receipt[property] === undefined) fail("invalid_create_receipt");
  }
  return deepFreeze({
    sql: `INSERT OR IGNORE INTO cabinet_application_create_receipts (${CREATE_COLUMNS.join(", ")}) VALUES (${CREATE_COLUMNS.map(() => "?").join(", ")})`,
    bindings: CREATE_PROPERTIES.map((property) => receipt[property]),
    atomicBoundary: "single_d1_statement_with_database_trigger",
  });
}

export function buildActiveApplicationQuotaState({
  planAuthority: planAuthorityValue,
  quotaAuthority: quotaAuthorityValue,
  subjectTelegramId,
  applications = [],
}) {
  const subject = positiveInteger(subjectTelegramId, "invalid_subject");
  const plan = normalizePlanAuthority(planAuthorityValue, subject);
  normalizeQuotaAuthority(quotaAuthorityValue, plan.planCode);
  if (!Array.isArray(applications)) fail("invalid_applications");
  let used = 0;
  for (const value of applications) {
    const application = record(value, "invalid_application_authority");
    if (field(application, "authoritySource", "authority_source") !== "database") {
      fail("untrusted_application_authority");
    }
    if (field(application, "subjectTelegramId", "subject_telegram_id") !== subject) {
      fail("foreign_application");
    }
    const status = field(application, "currentStatus", "current_status");
    if (!Object.hasOwn(APPLICATION_STATUSES, status)) fail("unknown_status");
    if (ACTIVE_STATUS_SET.has(status)) used += 1;
  }
  return resolveCabinetQuota({
    planCode: plan.planCode,
    quotaCode: "active_applications",
    used,
  });
}

const operationContext = ({
  settings,
  actor,
  application,
  capability = "application.update",
  feature = "lifecycle",
  grants = [],
  revokedGrantIds = [],
  nowSeconds,
}) => {
  requireFeature(settings, feature);
  const normalizedActor = normalizeActor(actor);
  const normalizedApplication = normalizeApplication(application);
  requireAuthorization({
    settings,
    actor,
    application,
    capability,
    grants,
    revokedGrantIds,
    nowSeconds,
  });
  return { actor: normalizedActor, application: normalizedApplication };
};

export async function buildApplicationTransitionReceipt({
  settings,
  actor: actorValue,
  application: applicationValue,
  toStatus,
  reasonCode = "status_changed",
  rawIdempotencyKey,
  idempotencySecret,
  actionSource,
  grants = [],
  revokedGrantIds = [],
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const { actor, application } = operationContext({
    settings,
    actor: actorValue,
    application: applicationValue,
    feature: "lifecycle",
    grants,
    revokedGrantIds,
    nowSeconds,
  });
  const normalizedActionSource = normalizeActionSource(actionSource, actor);
  if (!Object.hasOwn(APPLICATION_STATUSES, toStatus)) fail("unknown_status");
  if (!APPLICATION_TRANSITIONS[application.currentStatus].includes(toStatus)) {
    fail("transition_denied");
  }
  if (toStatus === "archived" && !application.resultRecorded) {
    fail("result_required_before_archive");
  }
  if (!SAFE_CODE.test(reasonCode)) fail("invalid_reason_code");
  const idempotencyKey = await deriveIdempotencyKey({
    secret: idempotencySecret,
    operation: "application.transition",
    rawKey: rawIdempotencyKey,
  });
  const transitionId = await deterministicId(
    "atr_",
    "application-transition",
    idempotencyKey,
  );
  const eventId = await deterministicId(
    "aev_",
    "application-transition-event",
    idempotencyKey,
  );
  const actorKeyHash = await sha256Hex(`telegram:${actor.telegramId}`);
  const before = {
    applicationId: application.applicationId,
    status: application.currentStatus,
    revision: application.revision,
  };
  const after = {
    applicationId: application.applicationId,
    status: toStatus,
    revision: application.revision + 1,
  };
  return deepFreeze({
    transitionId,
    eventId,
    applicationId: application.applicationId,
    ownerPartnerProfileId: application.ownerPartnerProfileId,
    contractVersion: application.transitionContractVersion,
    expectedRevision: application.revision,
    revisionAfter: application.revision + 1,
    fromStatus: application.currentStatus,
    toStatus,
    actorTelegramId: actor.telegramId,
    actorRole: actor.systemRole,
    actionSource: normalizedActionSource,
    actorKeyHash,
    reasonCode,
    idempotencyKey,
    requestHash: await hashRecord({
      ...before,
      toStatus,
      reasonCode,
      actorKeyHash,
      actorRole: actor.systemRole,
      actionSource: normalizedActionSource,
    }),
    beforeHash: await hashRecord(before),
    afterHash: await hashRecord(after),
    occurredAt: positiveInteger(nowSeconds, "invalid_time"),
  });
}

export async function buildApplicationNoteRecord({
  settings,
  actor: actorValue,
  application: applicationValue,
  note,
  rawIdempotencyKey,
  idempotencySecret,
  actionSource,
  grants = [],
  revokedGrantIds = [],
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const { actor, application } = operationContext({
    settings,
    actor: actorValue,
    application: applicationValue,
    feature: "notes",
    grants,
    revokedGrantIds,
    nowSeconds,
  });
  const normalizedActionSource = normalizeActionSource(actionSource, actor);
  const noteText = exactText(note, "invalid_note", 1, 4_000);
  if (noteText.trim().length === 0) fail("invalid_note");
  const idempotencyKey = await deriveIdempotencyKey({
    secret: idempotencySecret,
    operation: "application.note",
    rawKey: rawIdempotencyKey,
  });
  const noteId = await deterministicId("ant_", "application-note", idempotencyKey);
  const eventId = await deterministicId(
    "aev_",
    "application-note-event",
    idempotencyKey,
  );
  const noteHash = await sha256Hex(noteText);
  const actorKeyHash = await sha256Hex(`telegram:${actor.telegramId}`);
  return deepFreeze({
    noteId,
    eventId,
    applicationId: application.applicationId,
    ownerPartnerProfileId: application.ownerPartnerProfileId,
    authorTelegramId: actor.telegramId,
    authorRole: actor.systemRole,
    actionSource: normalizedActionSource,
    actorKeyHash,
    note: noteText,
    noteHash,
    applicationRevision: application.revision,
    idempotencyKey,
    requestHash: await hashRecord({
      applicationId: application.applicationId,
      applicationRevision: application.revision,
      noteHash,
      actorKeyHash,
      authorRole: actor.systemRole,
      actionSource: normalizedActionSource,
    }),
    occurredAt: positiveInteger(nowSeconds, "invalid_time"),
  });
}

export async function buildApplicationAssignmentReceipt({
  settings,
  actor: actorValue,
  application: applicationValue,
  assignment: assignmentValue,
  assigneeTelegramId,
  rawIdempotencyKey,
  idempotencySecret,
  actionSource,
  grants = [],
  revokedGrantIds = [],
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const { actor, application } = operationContext({
    settings,
    actor: actorValue,
    application: applicationValue,
    feature: "assignment",
    grants,
    revokedGrantIds,
    nowSeconds,
  });
  const normalizedActionSource = normalizeActionSource(actionSource, actor);
  const assignment = record(assignmentValue, "invalid_assignment_authority");
  if (field(assignment, "authoritySource", "authority_source") !== "database" ||
      field(assignment, "applicationId", "application_id") !==
        application.applicationId) {
    fail("untrusted_assignment_authority");
  }
  const assignmentRevision = nonNegativeInteger(
    assignment.revision,
    "invalid_assignment_revision",
  );
  const currentAssignee = field(
    assignment,
    "assigneeTelegramId",
    "assignee_telegram_id",
  ) ?? null;
  if (currentAssignee !== null) {
    positiveInteger(currentAssignee, "invalid_assignee");
  }
  const nextAssignee = assigneeTelegramId ?? null;
  if (nextAssignee !== null) positiveInteger(nextAssignee, "invalid_assignee");
  if (nextAssignee !== null && nextAssignee !== application.ownerTelegramId) {
    fail("foreign_assignee");
  }
  if (currentAssignee === nextAssignee) fail("assignment_noop");
  const idempotencyKey = await deriveIdempotencyKey({
    secret: idempotencySecret,
    operation: "application.assignment",
    rawKey: rawIdempotencyKey,
  });
  const assignmentReceiptId = await deterministicId(
    "aas_",
    "application-assignment",
    idempotencyKey,
  );
  const eventId = await deterministicId(
    "aev_",
    "application-assignment-event",
    idempotencyKey,
  );
  const actorKeyHash = await sha256Hex(`telegram:${actor.telegramId}`);
  const before = {
    applicationId: application.applicationId,
    assigneeTelegramId: currentAssignee,
    revision: assignmentRevision,
  };
  const after = {
    applicationId: application.applicationId,
    assigneeTelegramId: nextAssignee,
    revision: assignmentRevision + 1,
  };
  return deepFreeze({
    assignmentReceiptId,
    eventId,
    applicationId: application.applicationId,
    ownerPartnerProfileId: application.ownerPartnerProfileId,
    expectedRevision: assignmentRevision,
    revisionAfter: assignmentRevision + 1,
    fromAssigneeTelegramId: currentAssignee,
    toAssigneeTelegramId: nextAssignee,
    actorTelegramId: actor.telegramId,
    actorRole: actor.systemRole,
    actionSource: normalizedActionSource,
    actorKeyHash,
    idempotencyKey,
    requestHash: await hashRecord({
      ...after,
      actorKeyHash,
      actorRole: actor.systemRole,
      actionSource: normalizedActionSource,
    }),
    beforeHash: await hashRecord(before),
    afterHash: await hashRecord(after),
    occurredAt: positiveInteger(nowSeconds, "invalid_time"),
  });
}

export async function buildApplicationResultReceipt({
  settings,
  actor: actorValue,
  application: applicationValue,
  resultCode,
  reasonCode = "result_recorded",
  rawIdempotencyKey,
  idempotencySecret,
  actionSource,
  grants = [],
  revokedGrantIds = [],
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const { actor, application } = operationContext({
    settings,
    actor: actorValue,
    application: applicationValue,
    feature: "result",
    grants,
    revokedGrantIds,
    nowSeconds,
  });
  const normalizedActionSource = normalizeActionSource(actionSource, actor);
  const requiredResult = APPLICATION_RESULT_BY_STATUS[application.currentStatus];
  if (!requiredResult || resultCode !== requiredResult) {
    fail("result_status_mismatch");
  }
  if (!SAFE_CODE.test(reasonCode)) fail("invalid_reason_code");
  const idempotencyKey = await deriveIdempotencyKey({
    secret: idempotencySecret,
    operation: "application.result",
    rawKey: rawIdempotencyKey,
  });
  const resultId = await deterministicId("ars_", "application-result", idempotencyKey);
  const eventId = await deterministicId(
    "aev_",
    "application-result-event",
    idempotencyKey,
  );
  const actorKeyHash = await sha256Hex(`telegram:${actor.telegramId}`);
  const result = {
    applicationId: application.applicationId,
    applicationRevision: application.revision,
    terminalStatus: application.currentStatus,
    resultCode,
    reasonCode,
  };
  const beforeHash = await hashRecord({ result: null });
  const afterHash = await hashRecord(result);
  return deepFreeze({
    resultId,
    eventId,
    applicationId: application.applicationId,
    ownerPartnerProfileId: application.ownerPartnerProfileId,
    applicationRevision: application.revision,
    terminalStatus: application.currentStatus,
    resultCode,
    reasonCode,
    actorTelegramId: actor.telegramId,
    actorRole: actor.systemRole,
    actionSource: normalizedActionSource,
    actorKeyHash,
    resultHash: afterHash,
    idempotencyKey,
    requestHash: await hashRecord({
      ...result,
      actorKeyHash,
      actorRole: actor.systemRole,
      actionSource: normalizedActionSource,
    }),
    beforeHash,
    afterHash,
    occurredAt: positiveInteger(nowSeconds, "invalid_time"),
  });
}

export function projectApplicationForActor({
  settings,
  actor,
  application,
  contact = null,
  notes = [],
  assignment = null,
  result = null,
  history = [],
  grants = [],
  revokedGrantIds = [],
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const normalizedActor = normalizeActor(actor);
  const normalizedApplication = normalizeApplication(application);
  const authorization = requireAuthorization({
    settings,
    actor,
    application,
    capability: "application.read",
    grants,
    revokedGrantIds,
    nowSeconds,
  });
  if (!Array.isArray(notes) || !Array.isArray(history)) fail("invalid_projection");
  const ownerView = normalizedActor.systemRole === "partner" ||
    normalizedActor.systemRole === "admin";
  let safeContact = null;
  if (contact !== null && contact !== undefined) {
    const row = record(contact, "invalid_private_projection");
    if (field(row, "applicationId", "application_id") !==
        normalizedApplication.applicationId ||
        field(row, "subjectTelegramId", "subject_telegram_id") !==
          normalizedApplication.subjectTelegramId ||
        field(row, "ownerPartnerProfileId", "owner_partner_profile_id") !==
          normalizedApplication.ownerPartnerProfileId) {
      fail("foreign_private_projection");
    }
    const contactKind = field(row, "contactKind", "contact_kind");
    const contactValue = field(row, "contactValue", "contact_value");
    if (contactKind !== "telegram_id" ||
        typeof contactValue !== "string" || !/^[0-9]{1,32}$/u.test(contactValue)) {
      fail("invalid_private_projection");
    }
    safeContact = {
      kind: contactKind,
      value: contactValue,
    };
  }
  const safeNotes = notes.map((entryValue) => {
    const entry = record(entryValue, "invalid_private_projection");
    if (field(entry, "applicationId", "application_id") !==
        normalizedApplication.applicationId ||
        field(entry, "ownerPartnerProfileId", "owner_partner_profile_id") !==
          normalizedApplication.ownerPartnerProfileId) {
      fail("foreign_private_projection");
    }
    return {
      noteId: field(entry, "noteId", "note_id"),
      note: entry.note,
      occurredAt: field(entry, "occurredAt", "occurred_at"),
    };
  });
  let safeAssignment = null;
  if (assignment !== null && assignment !== undefined) {
    const row = record(assignment, "invalid_private_projection");
    if (field(row, "applicationId", "application_id") !==
        normalizedApplication.applicationId ||
        field(row, "ownerPartnerProfileId", "owner_partner_profile_id") !==
          normalizedApplication.ownerPartnerProfileId) {
      fail("foreign_private_projection");
    }
    safeAssignment = row;
  }
  let safeResult = null;
  if (result !== null && result !== undefined) {
    const row = record(result, "invalid_private_projection");
    if (field(row, "applicationId", "application_id") !==
        normalizedApplication.applicationId ||
        field(row, "ownerPartnerProfileId", "owner_partner_profile_id") !==
          normalizedApplication.ownerPartnerProfileId) {
      fail("foreign_private_projection");
    }
    safeResult = {
      resultId: field(row, "resultId", "result_id"),
      terminalStatus: field(row, "terminalStatus", "terminal_status"),
      resultCode: field(row, "resultCode", "result_code"),
      reasonCode: field(row, "reasonCode", "reason_code"),
      occurredAt: field(row, "occurredAt", "occurred_at"),
    };
  }
  const safeHistory = history.map((entryValue) => {
    const entry = record(entryValue, "invalid_history");
    if (field(entry, "applicationId", "application_id") !==
        normalizedApplication.applicationId) {
      fail("foreign_history");
    }
    return deepFreeze({
      eventId: field(entry, "eventId", "event_id"),
      eventKind: field(entry, "eventKind", "event_kind"),
      actionSource: field(entry, "actionSource", "action_source"),
      statusFrom: field(entry, "statusFrom", "status_from") ?? null,
      statusTo: field(entry, "statusTo", "status_to") ?? null,
      revisionBefore: field(entry, "revisionBefore", "revision_before"),
      revisionAfter: field(entry, "revisionAfter", "revision_after"),
      occurredAt: field(entry, "occurredAt", "occurred_at"),
    });
  });
  return deepFreeze({
    authorization,
    application: {
      applicationId: normalizedApplication.applicationId,
      currentStatus: normalizedApplication.currentStatus,
      revision: normalizedApplication.revision,
      active: ACTIVE_STATUS_SET.has(normalizedApplication.currentStatus),
      terminal: TERMINAL_STATUS_SET.has(normalizedApplication.currentStatus),
    },
    contact: safeContact,
    notes: ownerView ? safeNotes : [],
    assignment: ownerView ? safeAssignment : safeAssignment
      ? { assigned: field(
        safeAssignment,
        "assigneeTelegramId",
        "assignee_telegram_id",
      ) !== null }
      : null,
    result: safeResult,
    history: safeHistory,
  });
}

export function isApplicationStatusActive(status) {
  if (!Object.hasOwn(APPLICATION_STATUSES, status)) fail("unknown_status");
  return ACTIVE_STATUS_SET.has(status);
}
