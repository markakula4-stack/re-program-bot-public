import {
  assertClientPayloadAllowed,
} from "./data-contract.mjs";
import { sha256Hex, isVerifiedTelegramCommandContext } from "./mini-app-security.mjs";

const deepFreeze = (value) => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
};

export const PARTNER_IDENTITY_VERSION =
  "2026-09-29.v1.4.0-rebuild-p04";

export const PARTNER_APPLICATION_STATES = deepFreeze([
  "pending",
  "approved",
  "rejected",
]);

export const PARTNER_APPLICATION_TRANSITIONS = deepFreeze({
  missing: { submit: "pending" },
  pending: { approve: "approved", reject: "rejected" },
  rejected: { resubmit: "pending" },
  approved: {},
});

export const LEGAL_PROFILE_KINDS = deepFreeze([
  "individual",
  "self_employed",
  "individual_entrepreneur",
]);

export const PARTNER_IDENTITY_REPOSITORY_CONTRACT = deepFreeze({
  version: 1,
  reads: [
    "users",
    "user_roles",
    "partner_applications",
    "partner_application_decisions",
    "partner_profiles",
    "partner_public_settings",
    "partner_beta_access",
    "partner_legal_profiles",
    "partner_legal_profile_events",
  ],
  writes: {
    submitApplication: [
      "partner_applications",
      "partner_application_decisions",
    ],
    approveApplication: [
      "partner_applications",
      "partner_profiles",
      "user_roles",
      "partner_public_settings",
      "partner_application_decisions",
    ],
    rejectApplication: [
      "partner_applications",
      "partner_application_decisions",
    ],
    declareLegalProfile: [
      "partner_legal_profiles",
      "partner_legal_profile_events",
    ],
    setPublicUsername: ["partner_public_settings"],
  },
  everyCommandAtomic: true,
  compareAndSwapRequired: true,
  eventKeyUnique: true,
  partnerBetaAutoGrant: false,
  dormantWritePrefix: "cabinet_",
  earliestNewMigration: 57,
  liveSchemaInventoryRequired: true,
});

const APPLICATION_STATUS = new Set(PARTNER_APPLICATION_STATES);
const PROFILE_STATUS = new Set(["active", "paused"]);
const BETA_STATUS = new Set(["active", "paused", "revoked"]);
const LEGAL_KIND = new Set(LEGAL_PROFILE_KINDS);
const LEGAL_VERIFICATION = new Set(["self_declared", "verified", "rejected"]);
const ACTIVE_ROLE = new Set(["user", "partner", "admin"]);
const SERVER_KEY = /^mikey_[0-9a-f]{64}$/u;
const USERNAME = /^[A-Za-z0-9_]{5,32}$/u;
const EVENT_KEY = /^[a-z0-9_.:-]{16,180}$/u;
const SQLITE_UTC_TIME =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/u;
const RFC3339_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;

const STATUS_BY_CODE = Object.freeze({
  invalid_payload: 400,
  age_confirmation_required: 400,
  terms_required: 403,
  actor_blocked: 403,
  partner_required: 403,
  admin_required: 403,
  self_review_forbidden: 403,
  cross_owner: 403,
  application_conflict: 409,
  profile_conflict: 409,
  legal_profile_conflict: 409,
});

export class PartnerIdentityError extends Error {
  constructor(code, status = STATUS_BY_CODE[code] ?? 400) {
    super(code);
    this.name = "PartnerIdentityError";
    this.code = code;
    this.status = status;
  }
}

const fail = (code, status) => {
  throw new PartnerIdentityError(code, status);
};

const positiveInteger = (value, code = "invalid_authority") => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
};

const timestamp = (value, code = "invalid_time") => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
};

const databaseTimeSeconds = (value, code) => {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string") fail(code);
  const text = value.trim();
  const canonical = SQLITE_UTC_TIME.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  if (!SQLITE_UTC_TIME.test(text) && !RFC3339_TIME.test(text)) fail(code);
  const milliseconds = Date.parse(canonical);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) fail(code);
  return Math.floor(milliseconds / 1_000);
};

const databaseBoolean = (value, code) => {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  fail(code);
};

const databaseRow = (value, code, { optional = false } = {}) => {
  if (optional && (value === null || value === undefined)) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.authoritySource !== "database") fail(`untrusted_${code}`);
  return value;
};

const verifiedSession = (value) => {
  if (isVerifiedTelegramCommandContext(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.contextVersion !== 1 ||
      value.authoritySource !== "database_session" ||
      !Number.isSafeInteger(value.telegramId) || value.telegramId <= 0 ||
      !Number.isSafeInteger(value.botId) || value.botId <= 0 ||
      typeof value.sessionId !== "string") fail("invalid_session", 401);
  return value;
};

const exactBoolean = (value, code = "invalid_payload") => {
  if (value !== true && value !== false) fail(code);
  return value;
};

const normalizeText = (value, {
  code = "invalid_payload",
  minimum = 0,
  maximum,
  allowEmpty = minimum === 0,
} = {}) => {
  if (typeof value !== "string") fail(code);
  const text = value.normalize("NFKC").trim();
  if (/\p{Cc}/u.test(text) || text.length > maximum ||
      (!allowEmpty && text.length < minimum) ||
      (allowEmpty && text.length !== 0 && text.length < minimum)) fail(code);
  return text;
};

const serverKey = (value) => {
  if (!SERVER_KEY.test(value)) fail("invalid_idempotency_key");
  return value;
};

const normalizeRoleRows = (roleRows, telegramId) => {
  if (!Array.isArray(roleRows)) fail("invalid_role_authority");
  const roles = new Set();
  for (const value of roleRows) {
    const row = databaseRow(value, "role_authority");
    if (positiveInteger(row.telegramId, "invalid_role_authority") !== telegramId ||
        !ACTIVE_ROLE.has(row.role) ||
        !new Set(["active", "paused"]).has(row.status)) {
      fail("invalid_role_authority");
    }
    if (row.status === "active") roles.add(row.role);
  }
  return roles;
};

const resolveActor = ({ context, user, roleRows }) => {
  const session = verifiedSession(context);
  const authority = databaseRow(user, "user_authority");
  const telegramId = positiveInteger(authority.telegramId, "invalid_user_authority");
  if (telegramId !== session.telegramId) fail("cross_owner");
  if (authority.isBlocked === true || authority.isBlocked === 1) {
    fail("actor_blocked");
  }
  const acceptedTerms = authority.acceptedTerms === true ||
    authority.acceptedTerms === 1;
  const roles = normalizeRoleRows(roleRows, telegramId);
  return { session, telegramId, acceptedTerms, roles };
};

const normalizeApplication = (value, { optional = false } = {}) => {
  const row = databaseRow(value, "application", { optional });
  if (row === null) return null;
  const id = positiveInteger(row.id, "invalid_application");
  const telegramId = positiveInteger(row.telegramId, "invalid_application");
  if (!APPLICATION_STATUS.has(row.status)) fail("invalid_application");
  return {
    row,
    id,
    telegramId,
    status: row.status,
    ageConfirmed: row.ageConfirmed === true || row.ageConfirmed === 1,
  };
};

const normalizeProfile = (value, { optional = false } = {}) => {
  const row = databaseRow(value, "profile", { optional });
  if (row === null) return null;
  const id = positiveInteger(row.id, "invalid_profile");
  const telegramId = positiveInteger(row.telegramId, "invalid_profile");
  const applicationId = positiveInteger(row.applicationId, "invalid_profile");
  if (!PROFILE_STATUS.has(row.status)) fail("invalid_profile");
  return { row, id, telegramId, applicationId, status: row.status };
};

const normalizeLegalProfile = (value, { optional = false } = {}) => {
  const row = databaseRow(value, "legal_profile", { optional });
  if (row === null) return null;
  const partnerProfileId = positiveInteger(
    row.partnerProfileId,
    "invalid_legal_profile",
  );
  const revision = positiveInteger(row.revision, "invalid_legal_profile");
  if (!LEGAL_KIND.has(row.profileKind) ||
      !LEGAL_VERIFICATION.has(row.verificationState)) {
    fail("invalid_legal_profile");
  }
  return { row, partnerProfileId, revision };
};

const eventKeyFor = async (operation, idempotencyKey) => {
  const key = serverKey(idempotencyKey);
  const digest = await sha256Hex(
    `${PARTNER_IDENTITY_VERSION}\n${operation}\n${key}`,
  );
  const eventKey = `partner-identity:${operation}:${digest}`;
  if (!EVENT_KEY.test(eventKey)) fail("invalid_event_key", 500);
  return eventKey;
};

const commandIdFor = async (operation, eventKey) =>
  `pic_${await sha256Hex(`${operation}\n${eventKey}`)}`;

const noChange = (operation, outcome, applicationId = null) => deepFreeze({
  commandVersion: 1,
  operation,
  transactionRequired: false,
  outcome,
  applicationId,
  writes: [],
});

export async function buildPartnerApplicationSubmitCommand({
  context,
  user,
  roleRows = [],
  existingApplication = null,
  payload,
  idempotencyKey,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const actor = resolveActor({ context, user, roleRows });
  if (!actor.acceptedTerms) fail("terms_required");
  try {
    assertClientPayloadAllowed("partnerApplication", payload);
  } catch {
    fail("invalid_payload");
  }
  if (payload.ageConfirmed !== true) fail("age_confirmation_required");
  const displayName = normalizeText(payload.displayName, {
    minimum: 2,
    maximum: 80,
    allowEmpty: false,
  });
  const contact = normalizeText(payload.contact, {
    minimum: 0,
    maximum: 120,
    allowEmpty: true,
  });
  const application = normalizeApplication(existingApplication, {
    optional: true,
  });
  if (application && application.telegramId !== actor.telegramId) {
    fail("cross_owner");
  }
  if (application?.status === "pending") {
    return noChange("partner_application.submit", "already_pending", application.id);
  }
  if (application?.status === "approved") {
    return noChange("partner_application.submit", "already_approved", application.id);
  }

  const operation = application === null ? "submit" : "resubmit";
  const expectedStatus = application === null ? "missing" : "rejected";
  const eventKey = await eventKeyFor(
    `application.${operation}`,
    idempotencyKey,
  );
  const now = timestamp(nowSeconds);
  const applicationRef = application?.id ?? "inserted_application_id";
  const writes = [
    {
      table: "partner_applications",
      action: application === null ? "insert_unique_telegram_id" : "compare_and_swap",
      expectedStatus,
      values: {
        telegramId: actor.telegramId,
        displayName,
        contact,
        ageConfirmed: true,
        status: "pending",
        rejectionReason: "",
        reviewedBy: null,
        reviewedAt: null,
        submittedAt: now,
        updatedAt: now,
      },
    },
    {
      table: "partner_application_decisions",
      action: "append_unique_event",
      values: {
        applicationId: applicationRef,
        decision: operation === "submit" ? "submitted" : "resubmitted",
        actorId: actor.telegramId,
        actorRole: "user",
        reason: "",
        eventKey,
        createdAt: now,
      },
    },
  ];
  return deepFreeze({
    commandVersion: 1,
    commandId: await commandIdFor(operation, eventKey),
    operation: `partner_application.${operation}`,
    transactionRequired: true,
    idempotency: { eventKey, conflictResult: "return_current_application" },
    compareAndSwap: { from: expectedStatus, to: "pending" },
    writes,
    forbiddenSideEffects: [
      "grant_partner_role",
      "create_partner_profile",
      "grant_partner_beta",
    ],
  });
}

const requireAdmin = (actor) => {
  if (!actor.roles.has("admin")) fail("admin_required");
};

export async function buildPartnerApplicationDecisionCommand({
  context,
  user,
  roleRows,
  application: applicationValue,
  existingProfile = null,
  decision,
  reason = "",
  idempotencyKey,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const actor = resolveActor({ context, user, roleRows });
  requireAdmin(actor);
  const application = normalizeApplication(applicationValue);
  if (application.telegramId === actor.telegramId) fail("self_review_forbidden");
  const profile = normalizeProfile(existingProfile, { optional: true });
  if (profile && (profile.telegramId !== application.telegramId ||
      profile.applicationId !== application.id)) fail("profile_conflict");
  if (decision !== "approve" && decision !== "reject") {
    fail("invalid_decision");
  }
  const targetStatus = decision === "approve" ? "approved" : "rejected";
  if (application.status === targetStatus) {
    return noChange(
      `partner_application.${decision}`,
      `already_${targetStatus}`,
      application.id,
    );
  }
  if (application.status !== "pending") fail("application_conflict");
  if (decision === "approve" && !application.ageConfirmed) {
    fail("age_confirmation_required");
  }
  const normalizedReason = decision === "reject"
    ? normalizeText(reason, {
      minimum: 1,
      maximum: 300,
      allowEmpty: false,
    })
    : "";
  const eventKey = await eventKeyFor(
    `application.${decision}`,
    idempotencyKey,
  );
  const now = timestamp(nowSeconds);
  const writes = [
    {
      table: "partner_applications",
      action: "compare_and_swap",
      key: application.id,
      expectedStatus: "pending",
      values: {
        status: targetStatus,
        rejectionReason: normalizedReason,
        reviewedBy: actor.telegramId,
        reviewedAt: now,
        updatedAt: now,
      },
    },
  ];

  if (decision === "approve") {
    writes.push(
      {
        table: "partner_profiles",
        action: "insert_if_absent_same_application",
        values: {
          telegramId: application.telegramId,
          applicationId: application.id,
          displayName: normalizeText(application.row.displayName, {
            minimum: 2,
            maximum: 80,
            allowEmpty: false,
          }),
          contact: normalizeText(application.row.contact ?? "", {
            minimum: 0,
            maximum: 120,
            allowEmpty: true,
          }),
          status: "active",
          approvedBy: actor.telegramId,
          approvedAt: now,
          updatedAt: now,
        },
      },
      {
        table: "user_roles",
        action: "upsert_exact_role",
        values: {
          telegramId: application.telegramId,
          role: "partner",
          status: "active",
          assignedBy: actor.telegramId,
          assignedAt: now,
          updatedAt: now,
        },
      },
      {
        table: "partner_public_settings",
        action: "insert_default_if_absent",
        values: {
          telegramId: application.telegramId,
          publicUsernameEnabled: false,
          updatedAt: now,
        },
      },
    );
  }

  writes.push({
    table: "partner_application_decisions",
    action: "append_unique_event",
    values: {
      applicationId: application.id,
      decision: targetStatus,
      actorId: actor.telegramId,
      actorRole: "admin",
      reason: normalizedReason,
      eventKey,
      createdAt: now,
    },
  });

  return deepFreeze({
    commandVersion: 1,
    commandId: await commandIdFor(decision, eventKey),
    operation: `partner_application.${decision}`,
    transactionRequired: true,
    idempotency: { eventKey, conflictResult: "return_current_application" },
    compareAndSwap: { from: "pending", to: targetStatus },
    writes,
    forbiddenSideEffects: ["grant_partner_beta", "change_plan", "change_access"],
  });
}

export async function buildApprovedPartnerProfileRepairCommand({
  context,
  user,
  roleRows,
  application: applicationValue,
  existingProfile = null,
  idempotencyKey,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const actor = resolveActor({ context, user, roleRows });
  requireAdmin(actor);
  const application = normalizeApplication(applicationValue);
  let reviewedBy;
  let reviewedAt;
  try {
    reviewedBy = positiveInteger(application.row.reviewedBy, "profile_conflict");
    databaseTimeSeconds(
      application.row.reviewedAt,
      "profile_conflict",
    );
    reviewedAt = application.row.reviewedAt;
  } catch {
    fail("profile_conflict");
  }
  if (application.status !== "approved" || !application.ageConfirmed) {
    fail("profile_conflict");
  }
  if (normalizeProfile(existingProfile, { optional: true })) {
    return noChange("partner_profile.repair", "profile_present", application.id);
  }
  const eventKey = await eventKeyFor("profile.repair", idempotencyKey);
  const now = timestamp(nowSeconds);
  return deepFreeze({
    commandVersion: 1,
    commandId: await commandIdFor("repair", eventKey),
    operation: "partner_profile.repair",
    transactionRequired: true,
    idempotency: { eventKey, conflictResult: "return_current_profile" },
    writes: [
      {
        table: "partner_profiles",
        action: "insert_if_absent_same_application",
        values: {
          telegramId: application.telegramId,
          applicationId: application.id,
          displayName: normalizeText(application.row.displayName, {
            minimum: 2,
            maximum: 80,
            allowEmpty: false,
          }),
          contact: normalizeText(application.row.contact ?? "", {
            minimum: 0,
            maximum: 120,
            allowEmpty: true,
          }),
          status: "active",
          approvedBy: reviewedBy,
          approvedAt: reviewedAt,
          updatedAt: now,
        },
      },
      {
        table: "user_roles",
        action: "upsert_exact_role",
        values: {
          telegramId: application.telegramId,
          role: "partner",
          status: "active",
          assignedBy: reviewedBy,
          assignedAt: reviewedAt,
          updatedAt: now,
        },
      },
      {
        table: "partner_public_settings",
        action: "insert_default_if_absent",
        values: {
          telegramId: application.telegramId,
          publicUsernameEnabled: false,
          updatedAt: now,
        },
      },
      {
        table: "partner_application_decisions",
        action: "append_unique_event",
        values: {
          applicationId: application.id,
          decision: "approved",
          actorId: reviewedBy,
          actorRole: "admin",
          reason: "legacy_profile_repair",
          eventKey,
          createdAt: now,
        },
      },
    ],
    forbiddenSideEffects: ["grant_partner_beta", "rewrite_application"],
  });
}

export async function buildLegalProfileDeclarationCommand({
  context,
  user,
  roleRows,
  partnerProfile: profileValue,
  existingLegalProfile = null,
  payload,
  idempotencyKey,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const actor = resolveActor({ context, user, roleRows });
  if (!actor.roles.has("partner")) fail("partner_required");
  const profile = normalizeProfile(profileValue);
  if (profile.telegramId !== actor.telegramId) fail("cross_owner");
  if (profile.status !== "active") fail("partner_required");
  try {
    assertClientPayloadAllowed("legalProfile", payload);
  } catch {
    fail("invalid_payload");
  }
  if (!LEGAL_KIND.has(payload.profileKind) ||
      payload.selfDeclarationAccepted !== true) fail("invalid_payload");
  const existing = normalizeLegalProfile(existingLegalProfile, {
    optional: true,
  });
  if (existing && existing.partnerProfileId !== profile.id) {
    fail("legal_profile_conflict");
  }
  if (existing?.row.profileKind === payload.profileKind &&
      existing.row.verificationState === "self_declared") {
    return noChange("partner_legal_profile.declare", "unchanged");
  }
  const eventKey = await eventKeyFor("legal-profile.declare", idempotencyKey);
  const now = timestamp(nowSeconds);
  const nextRevision = (existing?.revision ?? 0) + 1;
  return deepFreeze({
    commandVersion: 1,
    commandId: await commandIdFor("legal-profile", eventKey),
    operation: "partner_legal_profile.declare",
    transactionRequired: true,
    idempotency: { eventKey, conflictResult: "return_current_legal_profile" },
    compareAndSwap: {
      fromRevision: existing?.revision ?? 0,
      toRevision: nextRevision,
    },
    writes: [
      {
        table: "partner_legal_profiles",
        action: existing ? "compare_and_swap" : "insert_unique_profile",
        values: {
          partnerProfileId: profile.id,
          profileKind: payload.profileKind,
          verificationState: "self_declared",
          revision: nextRevision,
          declaredBy: actor.telegramId,
          declaredAt: now,
          verifiedBy: null,
          verifiedAt: null,
          updatedAt: now,
        },
      },
      {
        table: "partner_legal_profile_events",
        action: "append_unique_event",
        values: {
          partnerProfileId: profile.id,
          fromKind: existing?.row.profileKind ?? "unknown",
          toKind: payload.profileKind,
          fromRevision: existing?.revision ?? 0,
          toRevision: nextRevision,
          actorId: actor.telegramId,
          actorRole: "partner",
          eventKey,
          createdAt: now,
        },
      },
    ],
    forbiddenData: ["passport", "bankDetails", "documentScan"],
    forbiddenSideEffects: ["grant_partner_role", "grant_access", "verify_legal_status"],
  });
}

export async function buildPublicUsernameCommand({
  context,
  user,
  roleRows,
  partnerProfile: profileValue,
  currentSettings = null,
  enabled,
  idempotencyKey,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const actor = resolveActor({ context, user, roleRows });
  if (!actor.roles.has("partner")) fail("partner_required");
  const profile = normalizeProfile(profileValue);
  if (profile.telegramId !== actor.telegramId) fail("cross_owner");
  if (profile.status !== "active") fail("partner_required");
  const desired = exactBoolean(enabled);
  const username = normalizeText(profile.row.telegramUsername ?? "", {
    minimum: 0,
    maximum: 32,
    allowEmpty: true,
  });
  if (desired && !USERNAME.test(username)) fail("public_username_missing");
  const settings = databaseRow(currentSettings, "public_settings", {
    optional: true,
  });
  if (settings && positiveInteger(
    settings.telegramId,
    "invalid_public_settings",
  ) !== actor.telegramId) fail("cross_owner");
  const current = settings?.publicUsernameEnabled === true ||
    settings?.publicUsernameEnabled === 1;
  if (current === desired) {
    return noChange("partner_public_username.set", "unchanged");
  }
  const eventKey = await eventKeyFor("public-username.set", idempotencyKey);
  return deepFreeze({
    commandVersion: 1,
    commandId: await commandIdFor("public-username", eventKey),
    operation: "partner_public_username.set",
    transactionRequired: true,
    idempotency: { eventKey, conflictResult: "return_current_settings" },
    writes: [{
      table: "partner_public_settings",
      action: settings ? "compare_and_swap" : "insert_unique_telegram_id",
      values: {
        telegramId: actor.telegramId,
        publicUsernameEnabled: desired,
        updatedAt: timestamp(nowSeconds),
      },
    }],
  });
}

export const formatPartnerId = (profileId) =>
  `RE-P${String(positiveInteger(profileId, "invalid_profile")).padStart(6, "0")}`;

const publicSettingsFor = (value, telegramId) => {
  const row = databaseRow(value, "public_settings", { optional: true });
  if (row === null) return { enabled: false };
  if (positiveInteger(row.telegramId, "invalid_public_settings") !== telegramId) {
    fail("cross_owner");
  }
  return { enabled: row.publicUsernameEnabled === true ||
    row.publicUsernameEnabled === 1 };
};

export function projectOwnPartnerIdentity({
  context,
  user,
  roleRows = [],
  application: applicationValue = null,
  partnerProfile: profileValue = null,
  legalProfile: legalValue = null,
  betaAccess = null,
  publicSettings = null,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const actor = resolveActor({ context, user, roleRows });
  const now = timestamp(nowSeconds);
  const application = normalizeApplication(applicationValue, { optional: true });
  if (application && application.telegramId !== actor.telegramId) {
    fail("cross_owner");
  }
  const profile = normalizeProfile(profileValue, { optional: true });
  if (profile && (profile.telegramId !== actor.telegramId ||
      (application && profile.applicationId !== application.id))) {
    fail("cross_owner");
  }
  const legal = normalizeLegalProfile(legalValue, { optional: true });
  if (legal && (!profile || legal.partnerProfileId !== profile.id)) {
    fail("cross_owner");
  }
  const settings = publicSettingsFor(publicSettings, actor.telegramId);
  const beta = databaseRow(betaAccess, "beta_access", { optional: true });
  if (beta && (!profile || positiveInteger(
    beta.partnerProfileId,
    "invalid_beta_access",
  ) !== profile.id)) fail("cross_owner");
  if (beta && !BETA_STATUS.has(beta.accessStatus)) fail("invalid_beta_access");
  const betaCanCreate = beta
    ? databaseBoolean(beta.canCreatePrivateOffers, "invalid_beta_access")
    : false;
  const betaCanSubmit = beta
    ? databaseBoolean(beta.canSubmitOffers, "invalid_beta_access")
    : false;
  const betaExpiresAt = beta?.expiresAt === null || beta?.expiresAt === undefined
    ? null
    : databaseTimeSeconds(beta.expiresAt, "invalid_beta_access");
  const betaActive = Boolean(beta) && beta.accessStatus === "active" &&
    (betaExpiresAt === null || betaExpiresAt > now);

  let state = "no_application";
  if (application?.status === "pending") state = "pending_review";
  if (application?.status === "rejected") state = "rejected";
  if (application?.status === "approved" && !profile) state = "profile_repair_required";
  if (application?.status === "approved" && profile?.status === "active") {
    state = "active_partner";
  }
  if (application?.status === "approved" && profile?.status === "paused") {
    state = "paused_partner";
  }

  const actions = {
    submitApplication: state === "no_application" || state === "rejected",
    refreshStatus: state === "pending_review",
    declareLegalProfile: state === "active_partner" && actor.roles.has("partner"),
    manageOffers: state === "active_partner" && actor.roles.has("partner") &&
      !actor.roles.has("admin") && betaActive &&
      (betaCanCreate || betaCanSubmit),
    contactSupport: state === "profile_repair_required",
  };

  return deepFreeze({
    projectionVersion: 1,
    state,
    application: application ? {
      id: application.id,
      status: application.status,
      displayName: application.row.displayName,
      contact: application.row.contact ?? "",
      ageConfirmed: application.ageConfirmed,
      rejectionReason: application.status === "rejected"
        ? application.row.rejectionReason ?? ""
        : "",
      submittedAt: application.row.submittedAt ?? null,
      reviewedAt: application.row.reviewedAt ?? null,
    } : null,
    profile: profile ? {
      partnerId: formatPartnerId(profile.id),
      displayName: profile.row.displayName,
      status: profile.status,
      telegramUsername: settings.enabled
        ? profile.row.telegramUsername ?? ""
        : "",
      publicUsernameEnabled: settings.enabled,
    } : null,
    legalProfile: legal ? {
      profileKind: legal.row.profileKind,
      verificationState: legal.row.verificationState,
      revision: legal.revision,
    } : null,
    beta: beta ? {
      accessStatus: beta.accessStatus,
      canCreatePrivateOffers: betaCanCreate,
      canSubmitOffers: betaCanSubmit,
      expired: betaExpiresAt !== null && betaExpiresAt <= now,
    } : null,
    actions,
  });
}

export function projectPublicPartnerCard({
  partnerProfile: profileValue,
  publicSettings,
} = {}) {
  const profile = normalizeProfile(profileValue);
  if (profile.status !== "active") fail("partner_required");
  const settings = publicSettingsFor(publicSettings, profile.telegramId);
  const username = normalizeText(profile.row.telegramUsername ?? "", {
    minimum: 0,
    maximum: 32,
    allowEmpty: true,
  });
  return deepFreeze({
    projectionVersion: 1,
    partnerId: formatPartnerId(profile.id),
    displayName: normalizeText(profile.row.displayName, {
      minimum: 2,
      maximum: 80,
      allowEmpty: false,
    }),
    telegramUsername: settings.enabled && USERNAME.test(username)
      ? `@${username}`
      : null,
  });
}

export function projectAdminPartnerApplication({
  context,
  user,
  roleRows,
  application: applicationValue,
  partnerProfile: profileValue = null,
} = {}) {
  const actor = resolveActor({ context, user, roleRows });
  requireAdmin(actor);
  const application = normalizeApplication(applicationValue);
  const profile = normalizeProfile(profileValue, { optional: true });
  if (profile && (profile.telegramId !== application.telegramId ||
      profile.applicationId !== application.id)) fail("profile_conflict");
  return deepFreeze({
    projectionVersion: 1,
    id: application.id,
    telegramId: application.telegramId,
    displayName: application.row.displayName,
    contact: application.row.contact ?? "",
    ageConfirmed: application.ageConfirmed,
    status: application.status,
    rejectionReason: application.row.rejectionReason ?? "",
    submittedAt: application.row.submittedAt ?? null,
    reviewedAt: application.row.reviewedAt ?? null,
    partnerId: profile ? formatPartnerId(profile.id) : null,
    allowedDecisions: application.status === "pending"
      ? ["approve", "reject"]
      : [],
  });
}

export function publicPartnerIdentityError(error) {
  const status = error instanceof PartnerIdentityError ? error.status : 500;
  const publicCode = status === 409 ? "request_conflict"
    : status === 403 ? "forbidden"
      : status === 401 ? "unauthorized"
        : status === 400 ? "bad_request"
          : "internal_error";
  return deepFreeze({ status, body: { error: publicCode } });
}
