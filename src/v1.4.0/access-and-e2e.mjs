import {
  CABINET_PLAN_QUOTAS,
  TARIFF_CAPACITY_PERCENT,
  deriveIdempotencyKey,
  sha256Hex,
} from "./cabinet-foundation.mjs";
import { buildApplicationCreateMutation } from "./applications-crm.mjs";

export const ACCESS_E2E_POLICY_VERSION =
  "2026-09-14.cabinet-v1-part4";
export const ACCESS_RESOLUTION_VERSION = 1;
export const ACCESS_RESOLUTION_TTL_SECONDS = 300;
export const ACCESS_E2E_RETENTION_SECONDS = 15_552_000;

export const APPLICATION_ANALYTICS_EVENT_BY_RESULT = Object.freeze({
  successful: "application_succeeded",
  unsuccessful: "application_unsuccessful",
  cancelled: "application_cancelled",
});

export const APPLICATION_ANALYTICS_METRIC_BY_RESULT = Object.freeze({
  successful: "applications_successful",
  unsuccessful: "applications_unsuccessful",
  cancelled: "applications_cancelled",
});

const encoder = new TextEncoder();
const PLAN_SET = new Set(["free", "professional", "dragon"]);
const ACCESS_STATE_SET = new Set([
  "none", "trial", "active", "cancel_at_period_end", "expired",
  "refunded", "suspended",
]);
const FREE_ACCESS_STATE_SET = new Set(["none", "expired", "refunded"]);
const PAID_STATUS_SET = new Set(["active", "cancel_at_period_end"]);
const RESULT_STATUS = Object.freeze({
  successful: "completed",
  unsuccessful: "rejected",
  cancelled: "cancelled",
});
const HEX_64 = /^[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPAQUE_ID = /^[a-z]{3}_[0-9a-f]{64}$/;

export class AccessE2EPolicyError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "AccessE2EPolicyError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new AccessE2EPolicyError(code);
};

const field = (value, camel, snake) => value && Object.hasOwn(value, camel)
  ? value[camel]
  : value?.[snake];

const record = (value, code) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
};

const databaseRecord = (value, code) => {
  const row = record(value, code);
  if (field(row, "authoritySource", "authority_source") !== "database") {
    fail(`untrusted_${code}`);
  }
  return row;
};

const positiveInteger = (value, code) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
};

const optionalPositiveInteger = (value, code) => {
  if (value === null || value === undefined || value === "") return null;
  return positiveInteger(value, code);
};

const exactText = (value, code, minimum = 1, maximum = 160) => {
  if (typeof value !== "string") fail(code);
  const text = value.trim();
  if (text.length < minimum || text.length > maximum) fail(code);
  return text;
};

const digest = (value, code) => {
  const text = String(value || "").toLowerCase();
  if (!HEX_64.test(text)) fail(code);
  return text;
};

const opaqueId = (value, prefix, code) => {
  const text = String(value || "").toLowerCase();
  if (!OPAQUE_ID.test(text) || !text.startsWith(prefix)) fail(code);
  return text;
};

const uuid = (value, code) => {
  const text = String(value || "").toLowerCase();
  if (!UUID_V4.test(text)) fail(code);
  return text;
};

const optionalUuid = (value, code) => {
  if (value === null || value === undefined || value === "") return null;
  return uuid(value, code);
};

const time = (value, code, { optional = false } = {}) => {
  if (optional && (value === null || value === undefined || value === "")) {
    return null;
  }
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string") fail(code);
  const normalized = value.trim();
  let iso;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)) {
    iso = `${normalized.replace(" ", "T")}Z`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(normalized)) {
    iso = normalized;
  } else {
    fail(code);
  }
  const milliseconds = Date.parse(iso);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) fail(code);
  return Math.floor(milliseconds / 1000);
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      canonicalize(value[key]),
    ]));
  }
  return value;
};

export const stableAccessE2EJson = (value) =>
  JSON.stringify(canonicalize(value));

const hashRecord = (value) => sha256Hex(stableAccessE2EJson(value));

const bytesToHex = (buffer) => [...new Uint8Array(buffer)]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");

const hmacHex = async (secret, value, cryptoImpl = globalThis.crypto) => {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 512) {
    fail("invalid_pseudonym_secret");
  }
  if (!cryptoImpl?.subtle) fail("web_crypto_required");
  const key = await cryptoImpl.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(await cryptoImpl.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value),
  ));
};

const deterministicOpaqueId = async (prefix, domain, value) =>
  `${prefix}${await sha256Hex(`${domain}\n${value}`)}`;

const deterministicUuidV4 = async (domain, value) => {
  const hex = await sha256Hex(`${domain}\n${value}`);
  const bytes = Uint8Array.from(
    hex.slice(0, 32).match(/.{2}/g),
    (part) => Number.parseInt(part, 16),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const normalized = bytesToHex(bytes);
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
};

const freeze = (value) => Object.freeze(value);

const normalizeSettings = (value) => {
  const settings = record(value, "invalid_part4_settings");
  const enabled = (camel, snake) => field(settings, camel, snake) === true ||
    field(settings, camel, snake) === 1;
  return {
    gateVersion: Number(field(settings, "gateVersion", "gate_version")),
    configurationAligned: field(
      settings,
      "configurationAligned",
      "configuration_aligned",
    ) === true,
    analyticsAligned: field(
      settings,
      "analyticsAligned",
      "analytics_aligned",
    ) === true,
    rolloutMode: field(settings, "rolloutMode", "rollout_mode"),
    masterEnabled: enabled("masterEnabled", "master_enabled"),
    accessProjectionEnabled: enabled(
      "accessProjectionEnabled",
      "access_projection_enabled",
    ),
    applicationBindingEnabled: enabled(
      "applicationBindingEnabled",
      "application_binding_enabled",
    ),
    analyticsBridgeEnabled: enabled(
      "analyticsBridgeEnabled",
      "analytics_bridge_enabled",
    ),
  };
};

const requireGate = (settingsValue, feature) => {
  const settings = normalizeSettings(settingsValue);
  const flag = {
    access: "accessProjectionEnabled",
    binding: "applicationBindingEnabled",
    analytics: "analyticsBridgeEnabled",
  }[feature];
  if (!flag) fail("invalid_part4_feature");
  if (
    settings.gateVersion !== 1 || !settings.configurationAligned ||
    settings.rolloutMode !== "admin_shadow" || !settings.masterEnabled ||
    !settings[flag] || (feature === "analytics" && !settings.analyticsAligned)
  ) {
    fail("feature_off");
  }
};

const normalizeUserPlan = (value, subject, at) => {
  const row = databaseRecord(value, "plan_authority");
  if (positiveInteger(field(row, "telegramId", "telegram_id"), "invalid_plan_authority") !== subject) {
    fail("foreign_plan_authority");
  }
  const planCode = field(row, "planCode", "plan_code");
  if (!PLAN_SET.has(planCode)) fail("invalid_plan_authority");
  const effectiveFrom = time(
    field(row, "effectiveFrom", "effective_from"),
    "invalid_plan_authority",
  );
  const effectiveUntil = time(
    field(row, "effectiveUntil", "effective_until"),
    "invalid_plan_authority",
    { optional: true },
  );
  if (effectiveFrom > at || (effectiveUntil !== null && effectiveUntil <= effectiveFrom)) {
    fail("invalid_plan_authority");
  }
  return {
    planCode,
    revision: positiveInteger(row.revision, "invalid_plan_authority"),
    effectiveFrom,
    effectiveUntil,
    sourceCode: exactText(
      field(row, "sourceCode", "source_code"),
      "invalid_plan_authority",
      3,
      64,
    ),
  };
};

const normalizeAccessState = (value, subject) => {
  const row = databaseRecord(value, "access_state_authority");
  if (positiveInteger(field(row, "telegramId", "telegram_id"), "invalid_access_state_authority") !== subject) {
    fail("foreign_access_state_authority");
  }
  const accessState = field(row, "accessState", "access_state");
  if (!ACCESS_STATE_SET.has(accessState)) fail("invalid_access_state_authority");
  const startedAt = time(
    field(row, "stateStartedAt", "state_started_at"),
    "invalid_access_state_authority",
    { optional: true },
  );
  const endsAt = time(
    field(row, "stateEndsAt", "state_ends_at"),
    "invalid_access_state_authority",
    { optional: true },
  );
  if (startedAt !== null && endsAt !== null && endsAt <= startedAt) {
    fail("invalid_access_state_authority");
  }
  return {
    accessState,
    revision: positiveInteger(row.revision, "invalid_access_state_authority"),
    startedAt,
    endsAt,
    sourceCode: exactText(
      field(row, "sourceCode", "source_code"),
      "invalid_access_state_authority",
      3,
      64,
    ),
  };
};

const normalizeSubscription = (value, subject) => {
  if (value === null || value === undefined) return null;
  const row = databaseRecord(value, "subscription_authority");
  const telegramId = positiveInteger(
    field(row, "telegramId", "telegram_id"),
    "invalid_subscription_authority",
  );
  const planCode = field(row, "planCode", "plan_code");
  const status = row.status;
  if (telegramId !== subject || !new Set(["professional", "dragon"]).has(planCode) ||
      !new Set([
        "active", "cancel_at_period_end", "expired", "refunded",
        "chargeback", "suspended",
      ]).has(status)) {
    fail("invalid_subscription_authority");
  }
  return {
    subscriptionId: uuid(
      field(row, "subscriptionId", "subscription_id"),
      "invalid_subscription_authority",
    ),
    telegramId,
    planCode,
    status,
    startsAt: time(
      field(row, "currentPeriodStart", "current_period_start"),
      "invalid_subscription_authority",
    ),
    endsAt: time(
      field(row, "currentPeriodEnd", "current_period_end"),
      "invalid_subscription_authority",
    ),
    revision: positiveInteger(row.revision, "invalid_subscription_authority"),
  };
};

const normalizeAccessGrant = (value, subject) => {
  if (value === null || value === undefined) return null;
  const row = databaseRecord(value, "access_grant_authority");
  const telegramId = positiveInteger(
    field(row, "telegramId", "telegram_id"),
    "invalid_access_grant_authority",
  );
  const planCode = field(row, "planCode", "plan_code");
  const status = row.status;
  if (telegramId !== subject || !new Set(["professional", "dragon"]).has(planCode) ||
      !new Set(["active", "refunded", "chargeback"]).has(status)) {
    fail("invalid_access_grant_authority");
  }
  return {
    accessGrantId: uuid(
      field(row, "grantId", "grant_id"),
      "invalid_access_grant_authority",
    ),
    subscriptionId: uuid(
      field(row, "subscriptionId", "subscription_id"),
      "invalid_access_grant_authority",
    ),
    telegramId,
    planCode,
    status,
    startsAt: time(field(row, "startsAt", "starts_at"), "invalid_access_grant_authority"),
    endsAt: time(field(row, "endsAt", "ends_at"), "invalid_access_grant_authority"),
  };
};

const normalizeTrialGrant = (value, subject) => {
  if (value === null || value === undefined) return null;
  const row = databaseRecord(value, "trial_grant_authority");
  const telegramId = optionalPositiveInteger(
    field(row, "telegramId", "telegram_id"),
    "invalid_trial_grant_authority",
  );
  const programCode = field(row, "programCode", "program_code");
  const status = row.status;
  if (telegramId !== subject || programCode !== "dragon_preview" ||
      !new Set(["active", "expired", "revoked"]).has(status)) {
    fail("invalid_trial_grant_authority");
  }
  const startsAt = time(
    field(row, "startedAt", "started_at"),
    "invalid_trial_grant_authority",
  );
  const endsAt = time(
    field(row, "endsAt", "ends_at"),
    "invalid_trial_grant_authority",
  );
  if (endsAt !== startsAt + 604_800) fail("invalid_trial_grant_authority");
  return {
    trialGrantId: uuid(
      field(row, "grantId", "grant_id"),
      "invalid_trial_grant_authority",
    ),
    subjectFingerprint: digest(
      field(row, "subjectFingerprint", "subject_fingerprint"),
      "invalid_trial_grant_authority",
    ),
    telegramId,
    programCode,
    status,
    startsAt,
    endsAt,
  };
};

export async function resolveCabinetAccessAuthority({
  subjectTelegramId,
  userPlan,
  accessState,
  subscription = null,
  accessGrant = null,
  trialGrant = null,
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  const subject = positiveInteger(subjectTelegramId, "invalid_subject");
  const now = positiveInteger(nowSeconds, "invalid_time");
  const plan = normalizeUserPlan(userPlan, subject, now);
  const state = normalizeAccessState(accessState, subject);
  const paid = normalizeSubscription(subscription, subject);
  const paidGrant = normalizeAccessGrant(accessGrant, subject);
  const preview = normalizeTrialGrant(trialGrant, subject);

  if (paid?.status === "suspended" && paid.startsAt <= now && paid.endsAt > now) {
    fail("access_suspended");
  }
  const paidCandidate = paid && PAID_STATUS_SET.has(paid.status) &&
    paid.startsAt <= now && paid.endsAt > now;
  const paidEvidence = paidCandidate && paidGrant && paidGrant.status === "active" &&
    paidGrant.subscriptionId === paid.subscriptionId &&
    paidGrant.telegramId === subject && paidGrant.planCode === paid.planCode &&
    paidGrant.startsAt <= now && paidGrant.endsAt === paid.endsAt;
  if (paidCandidate && !paidEvidence) fail("paid_access_evidence_mismatch");
  if (paidGrant?.status === "active" && !paidEvidence && paidGrant.endsAt > now) {
    fail("orphan_access_grant");
  }

  const previewLive = preview?.status === "active" &&
    preview.startsAt <= now && preview.endsAt > now;
  if (paidEvidence && previewLive) fail("access_authority_conflict");

  let authority;
  if (paidEvidence) {
    if (plan.planCode !== paid.planCode || state.accessState !== paid.status ||
        plan.effectiveUntil !== paid.endsAt || state.endsAt !== paid.endsAt) {
      fail("paid_projection_mismatch");
    }
    authority = {
      subjectTelegramId: subject,
      basePlanCode: paid.planCode,
      planCode: paid.planCode,
      accessState: paid.status,
      sourceKind: "stars_subscription",
      sourceStartsAt: paid.startsAt,
      sourceEndsAt: paid.endsAt,
      subscriptionId: paid.subscriptionId,
      accessGrantId: paidGrant.accessGrantId,
      trialGrantId: null,
    };
  } else if (previewLive) {
    if (plan.planCode !== "free" || state.accessState !== "trial" ||
        state.startedAt !== preview.startsAt ||
        state.endsAt !== preview.endsAt) {
      fail("preview_projection_mismatch");
    }
    authority = {
      subjectTelegramId: subject,
      basePlanCode: "free",
      planCode: "dragon",
      accessState: "trial",
      sourceKind: "dragon_preview",
      sourceStartsAt: preview.startsAt,
      sourceEndsAt: preview.endsAt,
      subscriptionId: null,
      accessGrantId: null,
      trialGrantId: preview.trialGrantId,
    };
  } else {
    if (plan.planCode !== "free" || !FREE_ACCESS_STATE_SET.has(state.accessState)) {
      fail("stale_access_projection");
    }
    if (plan.effectiveUntil !== null && plan.effectiveUntil <= now) {
      fail("stale_access_projection");
    }
    authority = {
      subjectTelegramId: subject,
      basePlanCode: "free",
      planCode: "free",
      accessState: state.accessState,
      sourceKind: "free_default",
      sourceStartsAt: Math.max(plan.effectiveFrom, state.startedAt || plan.effectiveFrom),
      sourceEndsAt: null,
      subscriptionId: null,
      accessGrantId: null,
      trialGrantId: null,
    };
  }

  const limit = CABINET_PLAN_QUOTAS.active_applications[authority.planCode];
  const capacityPercent = TARIFF_CAPACITY_PERCENT[authority.planCode];
  const validUntil = Math.min(
    now + ACCESS_RESOLUTION_TTL_SECONDS,
    authority.sourceEndsAt || Number.MAX_SAFE_INTEGER,
  );
  if (validUntil <= now) fail("access_expired");
  const authorityPayload = {
    ...authority,
    userPlanRevision: plan.revision,
    accessStateRevision: state.revision,
    capacityPercent,
    activeApplicationLimit: limit,
    resolvedAt: now,
    validUntil,
  };
  return freeze({
    authoritySource: "database",
    resolutionVersion: ACCESS_RESOLUTION_VERSION,
    ...authorityPayload,
    authorityKeyHash: await hashRecord(authorityPayload),
  });
}

export async function buildCabinetAccessResolutionReceipt({
  settings,
  authority,
  rawIdempotencyKey,
  idempotencySecret,
} = {}) {
  requireGate(settings, "access");
  const row = databaseRecord(authority, "resolved_access_authority");
  const resolutionVersion = Number(field(
    row,
    "resolutionVersion",
    "resolution_version",
  ));
  const subjectTelegramId = positiveInteger(
    field(row, "subjectTelegramId", "subject_telegram_id"),
    "invalid_subject",
  );
  const basePlanCode = field(row, "basePlanCode", "base_plan_code");
  const planCode = field(row, "planCode", "plan_code");
  const accessState = field(row, "accessState", "access_state");
  const sourceKind = field(row, "sourceKind", "source_kind");
  if (resolutionVersion !== ACCESS_RESOLUTION_VERSION ||
      !PLAN_SET.has(planCode) || !PLAN_SET.has(basePlanCode) ||
      !ACCESS_STATE_SET.has(accessState) || !new Set([
        "free_default", "dragon_preview", "stars_subscription",
      ]).has(sourceKind)) {
    fail("invalid_resolved_access_authority");
  }
  const createdAt = positiveInteger(
    field(row, "resolvedAt", "resolved_at"),
    "invalid_resolved_access_authority",
  );
  const validUntil = positiveInteger(
    field(row, "validUntil", "valid_until"),
    "invalid_resolved_access_authority",
  );
  if (validUntil <= createdAt || validUntil > createdAt + ACCESS_RESOLUTION_TTL_SECONDS) {
    fail("invalid_resolved_access_authority");
  }
  const sourceStartsAt = positiveInteger(
    field(row, "sourceStartsAt", "source_starts_at"),
    "invalid_resolved_access_authority",
  );
  const sourceEndsAt = optionalPositiveInteger(
    field(row, "sourceEndsAt", "source_ends_at"),
    "invalid_resolved_access_authority",
  );
  const subscriptionId = optionalUuid(
    field(row, "subscriptionId", "subscription_id"),
    "invalid_resolved_access_authority",
  );
  const accessGrantId = optionalUuid(
    field(row, "accessGrantId", "access_grant_id"),
    "invalid_resolved_access_authority",
  );
  const trialGrantId = optionalUuid(
    field(row, "trialGrantId", "trial_grant_id"),
    "invalid_resolved_access_authority",
  );
  const userPlanRevision = positiveInteger(
    field(row, "userPlanRevision", "user_plan_revision"),
    "invalid_resolved_access_authority",
  );
  const accessStateRevision = positiveInteger(
    field(row, "accessStateRevision", "access_state_revision"),
    "invalid_resolved_access_authority",
  );
  const capacityPercent = positiveInteger(
    field(row, "capacityPercent", "capacity_percent"),
    "invalid_resolved_access_authority",
  );
  const activeApplicationLimit = positiveInteger(
    field(row, "activeApplicationLimit", "active_application_limit"),
    "invalid_resolved_access_authority",
  );
  if (capacityPercent !== TARIFF_CAPACITY_PERCENT[planCode] ||
      activeApplicationLimit !== CABINET_PLAN_QUOTAS.active_applications[planCode]) {
    fail("invalid_resolved_access_authority");
  }
  const authorityPayload = {
    subjectTelegramId,
    basePlanCode,
    planCode,
    accessState,
    sourceKind,
    sourceStartsAt,
    sourceEndsAt,
    subscriptionId,
    accessGrantId,
    trialGrantId,
    userPlanRevision,
    accessStateRevision,
    capacityPercent,
    activeApplicationLimit,
    resolvedAt: createdAt,
    validUntil,
  };
  const authorityKeyHash = digest(
    field(row, "authorityKeyHash", "authority_key_hash"),
    "invalid_resolved_access_authority",
  );
  if (authorityKeyHash !== await hashRecord(authorityPayload)) {
    fail("resolved_access_authority_hash_mismatch");
  }
  const idempotencyKey = await deriveIdempotencyKey({
    secret: idempotencySecret,
    operation: "cabinet.access.resolve",
    rawKey: rawIdempotencyKey,
  });
  const resolutionId = await deterministicOpaqueId(
    "axr_",
    "cabinet-access-resolution",
    idempotencyKey,
  );
  const request = {
    subjectTelegramId,
    basePlanCode,
    planCode,
    accessState,
    sourceKind,
    subscriptionId,
    accessGrantId,
    trialGrantId,
    userPlanRevision,
    accessStateRevision,
    authorityKeyHash,
    createdAt,
  };
  return freeze({
    authoritySource: "database",
    resolutionId,
    subjectTelegramId,
    basePlanCode,
    planCode,
    accessState,
    sourceKind,
    sourceStartsAt,
    sourceEndsAt,
    subscriptionId,
    accessGrantId,
    trialGrantId,
    userPlanRevision,
    accessStateRevision,
    capacityPercent,
    activeApplicationLimit,
    resolutionVersion: ACCESS_RESOLUTION_VERSION,
    authorityKeyHash,
    idempotencyKey,
    requestHash: await hashRecord(request),
    createdAt,
    validUntil,
    retentionUntil: createdAt + ACCESS_E2E_RETENTION_SECONDS,
  });
}

const ACCESS_RESOLUTION_COLUMNS = [
  "resolution_id", "subject_telegram_id", "base_plan_code", "plan_code",
  "access_state", "source_kind", "source_starts_at", "source_ends_at",
  "subscription_id", "access_grant_id", "trial_grant_id",
  "user_plan_revision", "access_state_revision", "capacity_percent",
  "active_application_limit", "resolution_version", "authority_key_hash",
  "idempotency_key", "request_hash", "created_at", "valid_until",
  "retention_until",
];
const ACCESS_RESOLUTION_PROPERTIES = [
  "resolutionId", "subjectTelegramId", "basePlanCode", "planCode",
  "accessState", "sourceKind", "sourceStartsAt", "sourceEndsAt",
  "subscriptionId", "accessGrantId", "trialGrantId", "userPlanRevision",
  "accessStateRevision", "capacityPercent", "activeApplicationLimit",
  "resolutionVersion", "authorityKeyHash", "idempotencyKey", "requestHash",
  "createdAt", "validUntil", "retentionUntil",
];

const mutation = (table, columns, properties, value, code) => {
  const row = record(value, code);
  for (const property of properties) {
    if (row[property] === undefined) fail(code);
  }
  return freeze({
    sql: `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    bindings: properties.map((property) => row[property]),
  });
};

export const buildAccessResolutionMutation = (receipt) => freeze({
  ...mutation(
    "cabinet_access_resolution_receipts",
    ACCESS_RESOLUTION_COLUMNS,
    ACCESS_RESOLUTION_PROPERTIES,
    receipt,
    "invalid_access_resolution_receipt",
  ),
  atomicBoundary: "single_d1_statement_with_database_validation",
});

export function asApplicationPlanAuthority(receiptValue, {
  at = Math.floor(Date.now() / 1000),
} = {}) {
  const receipt = databaseRecord(receiptValue, "access_resolution_receipt");
  const timestamp = positiveInteger(at, "invalid_time");
  if (Number(field(receipt, "resolutionVersion", "resolution_version")) !== ACCESS_RESOLUTION_VERSION ||
      positiveInteger(field(receipt, "createdAt", "created_at"), "invalid_access_resolution_receipt") > timestamp ||
      positiveInteger(field(receipt, "validUntil", "valid_until"), "invalid_access_resolution_receipt") < timestamp) {
    fail("stale_access_resolution");
  }
  const planCode = field(receipt, "planCode", "plan_code");
  const accessState = field(receipt, "accessState", "access_state");
  if (!PLAN_SET.has(planCode) || !ACCESS_STATE_SET.has(accessState)) {
    fail("invalid_access_resolution_receipt");
  }
  return freeze({
    authoritySource: "database",
    subjectTelegramId: positiveInteger(
      field(receipt, "subjectTelegramId", "subject_telegram_id"),
      "invalid_subject",
    ),
    planCode,
    authorityKeyHash: digest(
      field(receipt, "authorityKeyHash", "authority_key_hash"),
      "invalid_access_resolution_receipt",
    ),
    accessState,
    accessResolutionId: opaqueId(
      field(receipt, "resolutionId", "resolution_id"),
      "axr_",
      "invalid_access_resolution_receipt",
    ),
  });
}

export function asApplicationQuotaAuthority(receiptValue, options = {}) {
  const plan = asApplicationPlanAuthority(receiptValue, options);
  return freeze({
    authoritySource: "database",
    planCode: plan.planCode,
    quotaCode: "active_applications",
    windowKind: "concurrent",
    limit: CABINET_PLAN_QUOTAS.active_applications[plan.planCode],
  });
}

export async function buildApplicationAccessBinding({
  settings,
  accessResolution,
  applicationCreateReceipt,
  rawIdempotencyKey,
  idempotencySecret,
} = {}) {
  requireGate(settings, "binding");
  const access = databaseRecord(accessResolution, "access_resolution_receipt");
  const application = record(applicationCreateReceipt, "invalid_application_create_receipt");
  const applicationId = opaqueId(
    field(application, "applicationId", "application_id"),
    "app_",
    "invalid_application_create_receipt",
  );
  const createdAt = positiveInteger(
    field(application, "createdAt", "created_at"),
    "invalid_application_create_receipt",
  );
  const subjectTelegramId = positiveInteger(
    field(application, "subjectTelegramId", "subject_telegram_id"),
    "invalid_subject",
  );
  const accessSubjectTelegramId = positiveInteger(
    field(access, "subjectTelegramId", "subject_telegram_id"),
    "invalid_subject",
  );
  const applicationPlanCode = field(application, "planCode", "plan_code");
  const accessPlanCode = field(access, "planCode", "plan_code");
  const applicationAuthorityHash = field(
    application,
    "planAuthorityKeyHash",
    "plan_authority_key_hash",
  );
  const accessAuthorityHash = field(
    access,
    "authorityKeyHash",
    "authority_key_hash",
  );
  const accessCreatedAt = positiveInteger(
    field(access, "createdAt", "created_at"),
    "invalid_access_resolution_receipt",
  );
  const accessValidUntil = positiveInteger(
    field(access, "validUntil", "valid_until"),
    "invalid_access_resolution_receipt",
  );
  if (
    subjectTelegramId !== accessSubjectTelegramId ||
    applicationPlanCode !== accessPlanCode ||
    applicationAuthorityHash !== accessAuthorityHash ||
    createdAt < accessCreatedAt || createdAt > accessValidUntil
  ) {
    fail("application_access_mismatch");
  }
  const idempotencyKey = await deriveIdempotencyKey({
    secret: idempotencySecret,
    operation: "cabinet.application.bind_access",
    rawKey: rawIdempotencyKey,
  });
  const bindingId = await deterministicOpaqueId(
    "axb_",
    "cabinet-application-access-binding",
    idempotencyKey,
  );
  const request = {
    applicationId,
    createReceiptId: field(application, "createReceiptId", "create_receipt_id"),
    sourceLeadId: field(application, "sourceLeadId", "source_lead_id"),
    offerCycleId: field(application, "offerCycleId", "offer_cycle_id"),
    subjectTelegramId,
    accessResolutionId: field(access, "resolutionId", "resolution_id"),
    planCode: accessPlanCode,
    accessState: field(access, "accessState", "access_state"),
    planAuthorityKeyHash: accessAuthorityHash,
  };
  return freeze({
    bindingId,
    applicationId,
    createReceiptId: opaqueId(
      field(application, "createReceiptId", "create_receipt_id"),
      "acr_",
      "invalid_application_create_receipt",
    ),
    sourceLeadId: positiveInteger(
      field(application, "sourceLeadId", "source_lead_id"),
      "invalid_application_create_receipt",
    ),
    offerCycleId: opaqueId(
      field(application, "offerCycleId", "offer_cycle_id"),
      "pub_",
      "invalid_application_create_receipt",
    ),
    subjectTelegramId,
    accessResolutionId: opaqueId(
      field(access, "resolutionId", "resolution_id"),
      "axr_",
      "invalid_access_resolution_receipt",
    ),
    planCode: accessPlanCode,
    accessState: field(access, "accessState", "access_state"),
    planAuthorityKeyHash: digest(accessAuthorityHash, "invalid_access_resolution_receipt"),
    idempotencyKey,
    requestHash: await hashRecord(request),
    createdAt,
  });
}

const ACCESS_BINDING_COLUMNS = [
  "binding_id", "application_id", "create_receipt_id", "source_lead_id",
  "offer_cycle_id", "subject_telegram_id", "access_resolution_id",
  "plan_code", "access_state", "plan_authority_key_hash",
  "idempotency_key", "request_hash", "created_at",
];
const ACCESS_BINDING_PROPERTIES = [
  "bindingId", "applicationId", "createReceiptId", "sourceLeadId",
  "offerCycleId", "subjectTelegramId", "accessResolutionId", "planCode",
  "accessState", "planAuthorityKeyHash", "idempotencyKey", "requestHash",
  "createdAt",
];

export const buildApplicationAccessBindingMutation = (binding) => freeze({
  ...mutation(
    "cabinet_application_access_bindings",
    ACCESS_BINDING_COLUMNS,
    ACCESS_BINDING_PROPERTIES,
    binding,
    "invalid_application_access_binding",
  ),
  atomicBoundary: "d1_batch_before_application_create",
});

export function buildAccessBoundApplicationMutations({ binding, createReceipt }) {
  return freeze([
    buildApplicationAccessBindingMutation(binding),
    buildApplicationCreateMutation(createReceipt),
  ]);
}

const normalizeJourneyRow = (value, name) => databaseRecord(value, name);

export async function buildApplicationAnalyticsBridge({
  settings,
  application: applicationValue,
  result: resultValue,
  accessBinding: bindingValue,
  accessResolution: accessValue,
  lead: leadValue,
  attribution: attributionValue,
  publication: publicationValue,
  rawIdempotencyKey,
  idempotencySecret,
  pseudonymSecret,
  recordedAt = Math.floor(Date.now() / 1000),
  pseudonymKeyVersion = 1,
} = {}) {
  requireGate(settings, "analytics");
  const application = normalizeJourneyRow(applicationValue, "application_authority");
  const result = normalizeJourneyRow(resultValue, "result_authority");
  const binding = normalizeJourneyRow(bindingValue, "access_binding_authority");
  const access = normalizeJourneyRow(accessValue, "access_resolution_authority");
  const lead = normalizeJourneyRow(leadValue, "lead_authority");
  const attribution = normalizeJourneyRow(attributionValue, "attribution_authority");
  const publication = normalizeJourneyRow(publicationValue, "publication_authority");
  const now = positiveInteger(recordedAt, "invalid_time");

  const applicationId = opaqueId(
    field(application, "applicationId", "application_id"),
    "app_",
    "invalid_application_authority",
  );
  const resultId = opaqueId(field(result, "resultId", "result_id"), "ars_", "invalid_result_authority");
  const resultCode = field(result, "resultCode", "result_code");
  const terminalStatus = field(result, "terminalStatus", "terminal_status");
  const occurredAt = positiveInteger(field(result, "occurredAt", "occurred_at"), "invalid_result_authority");
  const sourceLeadId = positiveInteger(
    field(application, "sourceLeadId", "source_lead_id"),
    "invalid_application_authority",
  );
  const subjectTelegramId = positiveInteger(
    field(application, "subjectTelegramId", "subject_telegram_id"),
    "invalid_application_authority",
  );
  const offerCycleId = opaqueId(
    field(application, "offerCycleId", "offer_cycle_id"),
    "pub_",
    "invalid_application_authority",
  );
  const offerCode = exactText(
    field(application, "offerCode", "offer_code"),
    "invalid_application_authority",
    1,
    64,
  );
  const ownerPartnerProfileId = positiveInteger(
    field(application, "ownerPartnerProfileId", "owner_partner_profile_id"),
    "invalid_application_authority",
  );
  const planCode = field(application, "planCodeAtCreation", "plan_code_at_creation");
  const accessState = field(access, "accessState", "access_state");
  const accessAuthorityHash = field(
    access,
    "authorityKeyHash",
    "authority_key_hash",
  );
  if (
    field(result, "applicationId", "application_id") !== applicationId ||
    field(result, "ownerPartnerProfileId", "owner_partner_profile_id") !== ownerPartnerProfileId ||
    RESULT_STATUS[resultCode] !== terminalStatus ||
    field(application, "currentStatus", "current_status") !== terminalStatus ||
    field(binding, "applicationId", "application_id") !== applicationId ||
    field(binding, "sourceLeadId", "source_lead_id") !== sourceLeadId ||
    field(binding, "offerCycleId", "offer_cycle_id") !== offerCycleId ||
    field(binding, "subjectTelegramId", "subject_telegram_id") !== subjectTelegramId ||
    field(binding, "accessResolutionId", "access_resolution_id") !== field(access, "resolutionId", "resolution_id") ||
    field(binding, "planCode", "plan_code") !== planCode ||
    field(binding, "accessState", "access_state") !== accessState ||
    field(binding, "planAuthorityKeyHash", "plan_authority_key_hash") !== accessAuthorityHash ||
    field(access, "subjectTelegramId", "subject_telegram_id") !== subjectTelegramId ||
    field(access, "planCode", "plan_code") !== planCode ||
    field(lead, "id", "id") !== sourceLeadId ||
    field(lead, "telegramId", "telegram_id") !== subjectTelegramId ||
    field(lead, "offerCode", "offer_code") !== offerCode ||
    field(attribution, "leadId", "lead_id") !== sourceLeadId ||
    field(attribution, "partnerProfileId", "partner_profile_id") !== ownerPartnerProfileId ||
    field(publication, "publicationId", "publication_id") !== offerCycleId ||
    field(publication, "offerCode", "offer_code") !== offerCode ||
    field(publication, "offerVersionId", "offer_version_id") !==
      field(application, "offerVersionId", "offer_version_id") ||
    field(publication, "ownerPartnerProfileId", "owner_partner_profile_id") !== ownerPartnerProfileId
  ) {
    fail("journey_authority_mismatch");
  }
  if (!PLAN_SET.has(planCode) || now < occurredAt || now - occurredAt > ACCESS_E2E_RETENTION_SECONDS) {
    fail("invalid_journey_time");
  }
  if (!ACCESS_STATE_SET.has(accessState)) fail("invalid_access_state_authority");
  if (pseudonymKeyVersion !== 1) fail("invalid_pseudonym_key_version");
  const resultHash = digest(
    field(result, "resultHash", "result_hash"),
    "invalid_result_authority",
  );
  const idempotencyKey = await deriveIdempotencyKey({
    secret: idempotencySecret,
    operation: "cabinet.application.analytics",
    rawKey: rawIdempotencyKey,
  });
  const bridgeId = await deterministicOpaqueId(
    "aab_",
    "cabinet-application-analytics-bridge",
    idempotencyKey,
  );
  const eventName = APPLICATION_ANALYTICS_EVENT_BY_RESULT[resultCode];
  if (!eventName) fail("invalid_result_authority");
  const eventId = await deterministicUuidV4("application-analytics-event", idempotencyKey);
  const sourceIdentity = `lead:${sourceLeadId}:application:${applicationId}:result:${resultId}`;
  const actorPseudonym = await hmacHex(
    pseudonymSecret,
    `re-analytics:subject:v${pseudonymKeyVersion}:${subjectTelegramId}`,
  );
  const sourceKeyHash = await hmacHex(
    pseudonymSecret,
    `re-analytics:source:v1:lead:${sourceIdentity}`,
  );
  const eventKey = `evt_${await hmacHex(
    pseudonymSecret,
    `re-analytics:event:v1:${eventName}:1:lead:${sourceIdentity}`,
  )}`;
  const dimensions = {
    role: "user",
    legal_profile: "unknown",
    plan: planCode,
    access_state: accessState,
    source_family: "partner_link",
    object_type: "lead",
  };
  const payloadHash = await hashRecord({
    actorPseudonym,
    correctionKind: "none",
    correctionOfEventKeyHash: null,
    dimensions,
    eventName,
    eventVersion: 1,
    occurredAt,
    origin: "live",
    privacyClass: "pseudonymous",
    pseudonymKeyVersion,
    replacementEventKeyHash: null,
    sourceKeyHash,
    sourceKind: "lead",
  });
  const authorityHash = await hashRecord({
    applicationId,
    resultId,
    resultHash,
    sourceLeadId,
    subjectTelegramId,
    offerCycleId,
    offerCode,
    ownerPartnerProfileId,
    accessResolutionId: field(access, "resolutionId", "resolution_id"),
    planCode,
    accessState,
    terminalStatus,
    resultCode,
  });
  const requestHash = await hashRecord({
    authorityHash,
    eventId,
    eventKey,
    eventName,
    payloadHash,
  });
  return freeze({
    bridgeId,
    applicationId,
    resultId,
    sourceLeadId,
    offerCycleId,
    offerCode,
    ownerPartnerProfileId,
    accessResolutionId: opaqueId(
      field(access, "resolutionId", "resolution_id"),
      "axr_",
      "invalid_access_resolution_authority",
    ),
    planCode,
    accessState,
    terminalStatus,
    resultCode,
    resultHash,
    eventId,
    eventKey,
    eventName,
    actorPseudonym,
    pseudonymKeyVersion: positiveInteger(pseudonymKeyVersion, "invalid_pseudonym_key_version"),
    sourceKeyHash,
    payloadHash,
    roleDimension: dimensions.role,
    legalProfileDimension: dimensions.legal_profile,
    sourceFamilyDimension: dimensions.source_family,
    objectTypeDimension: dimensions.object_type,
    authorityHash,
    idempotencyKey,
    requestHash,
    occurredAt,
    recordedAt: now,
    retentionUntil: now + ACCESS_E2E_RETENTION_SECONDS,
  });
}

const ANALYTICS_BRIDGE_COLUMNS = [
  "bridge_id", "application_id", "result_id", "source_lead_id",
  "offer_cycle_id", "offer_code", "owner_partner_profile_id",
  "access_resolution_id", "plan_code", "access_state", "terminal_status",
  "result_code", "result_hash", "event_id", "event_key", "event_name",
  "actor_pseudonym", "pseudonym_key_version", "source_key_hash",
  "payload_hash", "role_dimension", "legal_profile_dimension",
  "source_family_dimension", "object_type_dimension", "authority_hash",
  "idempotency_key", "request_hash", "occurred_at", "recorded_at",
  "retention_until",
];
const ANALYTICS_BRIDGE_PROPERTIES = [
  "bridgeId", "applicationId", "resultId", "sourceLeadId", "offerCycleId",
  "offerCode", "ownerPartnerProfileId", "accessResolutionId", "planCode",
  "accessState", "terminalStatus", "resultCode", "resultHash", "eventId",
  "eventKey", "eventName", "actorPseudonym", "pseudonymKeyVersion",
  "sourceKeyHash", "payloadHash", "roleDimension", "legalProfileDimension",
  "sourceFamilyDimension", "objectTypeDimension", "authorityHash",
  "idempotencyKey", "requestHash", "occurredAt", "recordedAt",
  "retentionUntil",
];

export const buildApplicationAnalyticsMutation = (bridge) => freeze({
  ...mutation(
    "cabinet_application_analytics_bridges",
    ANALYTICS_BRIDGE_COLUMNS,
    ANALYTICS_BRIDGE_PROPERTIES,
    bridge,
    "invalid_application_analytics_bridge",
  ),
  atomicBoundary: "single_d1_statement_creates_canonical_event",
});

export function projectCabinetAccessSummary(receiptValue) {
  const receipt = databaseRecord(receiptValue, "access_resolution_receipt");
  return freeze({
    planCode: field(receipt, "planCode", "plan_code"),
    accessState: field(receipt, "accessState", "access_state"),
    capacityPercent: field(receipt, "capacityPercent", "capacity_percent"),
    activeApplicationsLimit: field(
      receipt,
      "activeApplicationLimit",
      "active_application_limit",
    ),
    preview: field(receipt, "sourceKind", "source_kind") === "dragon_preview",
    expiresAt: field(receipt, "sourceEndsAt", "source_ends_at"),
  });
}
