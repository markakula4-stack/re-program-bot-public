import { assertClientPayloadAllowed } from "./data-contract.mjs";
import { sha256Hex, isVerifiedTelegramCommandContext } from "./mini-app-security.mjs";

const deepFreeze = (value) => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
};

export const LEAD_LIFECYCLE_VERSION =
  "2026-09-29.v1.4.0-rebuild-p06";

export const LEAD_STATES = deepFreeze([
  "pending",
  "confirmed",
  "rejected",
  "paid",
]);

export const LEAD_TRANSITIONS = deepFreeze({
  missing: { submit: "pending" },
  pending: { confirm: "confirmed", reject: "rejected" },
  rejected: { resubmit: "pending" },
  confirmed: { mark_paid: "paid" },
  paid: {},
});

export const LEAD_REPOSITORY_CONTRACT = deepFreeze({
  version: 1,
  reads: [
    "users",
    "user_roles",
    "offers",
    "offer_owners",
    "offer_versions",
    "offer_visibility_rules",
    "offer_visibility_assignments",
    "partner_offer_links",
    "partner_links",
    "partner_profiles",
    "partner_programs",
    "program_offers",
    "lead_requests",
    "lead_partner_attribution",
    "lead_request_events",
    "conversions",
  ],
  writes: {
    submit: [
      "lead_requests",
      "lead_partner_attribution",
      "lead_request_events",
    ],
    transition: [
      "lead_requests",
      "lead_request_events",
      "conversions",
      "admin_audit_log",
    ],
  },
  canonicalApplicationTable: "lead_requests",
  compatibilityMirrorTable: "conversions",
  compatibilityMirrorMayAuthorize: false,
  compatibilityMirrorStates: ["confirmed", "paid"],
  attributionImmutableAfterFirstWrite: true,
  historyTable: "lead_request_events",
  historyMode: "planned_additive",
  earliestNewMigration: 57,
  liveSchemaInventoryRequired: true,
  everyCommandAtomic: true,
  compareAndSwapRequired: true,
  eventKeyUnique: true,
  crmIncluded: false,
  dormantWritePrefix: "cabinet_",
});

const STATES = new Set(LEAD_STATES);
const ROLES = new Set(["user", "partner", "admin"]);
const SOURCE_KINDS = new Set(["partner_offer", "program_offer"]);
const DECISIONS = new Set(["confirm", "reject", "mark_paid"]);
const ADMIN_DECISIONS_BY_STATUS = Object.freeze({
  pending: Object.freeze(["confirm", "reject"]),
  confirmed: Object.freeze(["mark_paid"]),
  rejected: Object.freeze([]),
  paid: Object.freeze([]),
});
const SERVER_KEY = /^mikey_[0-9a-f]{64}$/u;
const EVENT_KEY = /^lle_[0-9a-f]{64}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const OFFER_CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/u;
const PROGRAM_CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/u;
const DB_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z)?$/u;
const MAX_REWARD_KOPECKS = 1_000_000_000_000;

const STATUS_BY_CODE = Object.freeze({
  invalid_payload: 400,
  invalid_offer: 400,
  invalid_lead: 400,
  invalid_reason: 400,
  invalid_reward: 400,
  unauthorized: 401,
  actor_blocked: 403,
  user_required: 403,
  partner_required: 403,
  admin_required: 403,
  self_application_forbidden: 403,
  self_review_forbidden: 403,
  cross_owner: 403,
  offer_not_available: 404,
  lead_not_found: 404,
  lead_conflict: 409,
  attribution_conflict: 409,
  transition_conflict: 409,
  compatibility_conflict: 409,
  idempotency_conflict: 409,
  event_state_conflict: 409,
});

export class LeadLifecycleError extends Error {
  constructor(code, status = STATUS_BY_CODE[code] ?? 400) {
    super(code);
    this.name = "LeadLifecycleError";
    this.code = code;
    this.status = status;
  }
}

const fail = (code, status) => {
  throw new LeadLifecycleError(code, status);
};

const positiveInteger = (value, code = "invalid_payload") => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
};

const nullablePositiveInteger = (value, code = "invalid_payload") =>
  value === null || value === undefined
    ? null
    : positiveInteger(value, code);

const nonNegativeInteger = (value, maximum, code = "invalid_payload") => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    fail(code);
  }
  return number;
};

const timestamp = (value, code = "invalid_time") => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
};

const databaseTimestamp = (value, code = "invalid_authority") => {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string" || !DB_TIME.test(value.trim())) fail(code);
  return value.trim();
};

const databaseBoolean = (value, code = "invalid_authority") => {
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

const normalizeText = (value, {
  minimum = 0,
  maximum,
  allowEmpty = minimum === 0,
  code = "invalid_payload",
} = {}) => {
  if (typeof value !== "string") fail(code);
  const text = value.normalize("NFKC").trim();
  const length = Array.from(text).length;
  if (/\p{Cc}/u.test(text) || length > maximum ||
      (!allowEmpty && length < minimum) ||
      (allowEmpty && length !== 0 && length < minimum)) fail(code);
  return text;
};

const offerCode = (value) => {
  if (typeof value !== "string" || !OFFER_CODE.test(value)) {
    fail("invalid_offer");
  }
  return value;
};

const canonicalize = (value) => {
  if (value === null || typeof value === "string" ||
      typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_payload");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      canonicalize(value[key]),
    ]));
  }
  fail("invalid_payload");
};

const stableJson = (value) => JSON.stringify(canonicalize(value));

const verifiedSession = (value) => {
  if (isVerifiedTelegramCommandContext(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.contextVersion !== 1 ||
      value.authoritySource !== "database_session" ||
      !Number.isSafeInteger(value.telegramId) || value.telegramId <= 0 ||
      !Number.isSafeInteger(value.botId) || value.botId <= 0 ||
      typeof value.sessionId !== "string") fail("unauthorized");
  return value;
};

const normalizeRoleRows = (roleRows, telegramId) => {
  if (!Array.isArray(roleRows)) fail("invalid_role_authority");
  const roles = new Set();
  for (const value of roleRows) {
    const row = databaseRow(value, "role_authority");
    if (positiveInteger(row.telegramId, "invalid_role_authority") !== telegramId ||
        !ROLES.has(row.role) ||
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
  return {
    telegramId,
    roles: normalizeRoleRows(roleRows, telegramId),
  };
};

const requireRole = (actor, role, code) => {
  if (!actor.roles.has(role)) fail(code);
};

const serverKey = (value) => {
  if (typeof value !== "string" || !SERVER_KEY.test(value)) {
    fail("invalid_idempotency_key");
  }
  return value;
};

const eventKeyFor = async (operation, idempotencyKey) =>
  `lle_${await sha256Hex(
    `${LEAD_LIFECYCLE_VERSION}\n${operation}\n${serverKey(idempotencyKey)}`,
  )}`;

const commandIdFor = async (eventKey) =>
  `llc_${await sha256Hex(`${LEAD_LIFECYCLE_VERSION}\n${eventKey}`)}`;

const requestHashFor = async (value) => sha256Hex(stableJson(value));

const normalizeSubmitPayload = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_payload");
  }
  try {
    assertClientPayloadAllowed("leadApplication", value);
  } catch {
    fail("invalid_payload");
  }
  return { offerCode: offerCode(value.offerCode) };
};

const normalizeResultPayload = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_payload");
  }
  try {
    assertClientPayloadAllowed("result", value);
  } catch {
    fail("invalid_payload");
  }
  const leadId = positiveInteger(value.leadId, "invalid_lead");
  if (!DECISIONS.has(value.decision)) fail("invalid_payload");
  if (value.decision === "confirm") {
    if (!Object.hasOwn(value, "rewardKopecks") ||
        Object.hasOwn(value, "reason")) fail("invalid_payload");
    return {
      leadId,
      decision: value.decision,
      rewardKopecks: nonNegativeInteger(
        value.rewardKopecks,
        MAX_REWARD_KOPECKS,
        "invalid_reward",
      ),
      reason: "",
    };
  }
  if (value.decision === "reject") {
    if (Object.hasOwn(value, "rewardKopecks")) fail("invalid_payload");
    return {
      leadId,
      decision: value.decision,
      rewardKopecks: 0,
      reason: normalizeText(value.reason, {
        minimum: 1,
        maximum: 300,
        allowEmpty: false,
        code: "invalid_reason",
      }),
    };
  }
  if (Object.hasOwn(value, "rewardKopecks") ||
      Object.hasOwn(value, "reason")) fail("invalid_payload");
  return {
    leadId,
    decision: value.decision,
    rewardKopecks: null,
    reason: "",
  };
};

const normalizeEligibleOffer = (value, actorTelegramId, expectedOfferCode) => {
  const row = databaseRow(value, "eligible_offer");
  const code = offerCode(row.offerCode);
  if (code !== expectedOfferCode || !SOURCE_KINDS.has(row.sourceKind)) {
    fail("offer_not_available");
  }
  const commonAvailable = row.partnerLinkStatus === "approved" &&
    row.ownerProfileStatus === "active" &&
    databaseBoolean(row.ownershipConfirmed, "invalid_offer_authority") &&
    databaseBoolean(row.trafficConfirmed, "invalid_offer_authority") &&
    databaseBoolean(row.destinationAvailable, "invalid_offer_authority");
  if (!commonAvailable) fail("offer_not_available");

  const partnerLinkId = positiveInteger(
    row.partnerLinkId,
    "invalid_offer_authority",
  );
  const partnerProfileId = positiveInteger(
    row.partnerProfileId,
    "invalid_offer_authority",
  );
  const inviterId = positiveInteger(row.inviterId, "invalid_offer_authority");
  const ownerTelegramId = positiveInteger(
    row.ownerTelegramId,
    "invalid_offer_authority",
  );
  if (ownerTelegramId !== inviterId) fail("invalid_offer_authority");
  if (inviterId === actorTelegramId ||
      databaseBoolean(row.isOwnerPreview, "invalid_offer_authority")) {
    fail("self_application_forbidden");
  }
  const programCode = normalizeText(row.programCode, {
    minimum: 2,
    maximum: 64,
    allowEmpty: false,
    code: "invalid_offer_authority",
  });
  if (!PROGRAM_CODE.test(programCode)) fail("invalid_offer_authority");

  let sourceVersionId;
  let audience;
  if (row.sourceKind === "partner_offer") {
    sourceVersionId = positiveInteger(
      row.currentVersionId,
      "invalid_offer_authority",
    );
    if (row.businessStatus !== "active" ||
        row.moderationStatus !== "approved" ||
        positiveInteger(row.submittedVersionId, "invalid_offer_authority") !==
          sourceVersionId ||
        positiveInteger(row.approvedVersionId, "invalid_offer_authority") !==
          sourceVersionId ||
        !new Set(["public", "assigned"]).has(row.visibility)) {
      fail("offer_not_available");
    }
    audience = row.visibility;
    if (audience === "assigned") {
      if (!databaseBoolean(row.assignmentActive, "invalid_offer_authority") ||
          positiveInteger(
            row.assignedTelegramId,
            "invalid_offer_authority",
          ) !== actorTelegramId) fail("offer_not_available");
    }
  } else {
    sourceVersionId = positiveInteger(
      row.catalogOfferId,
      "invalid_offer_authority",
    );
    if (row.catalogOfferStatus !== "active" ||
        row.catalogBusinessStatus !== "active" ||
        row.programStatus !== "active" ||
        positiveInteger(
          row.resolvedForTelegramId,
          "invalid_offer_authority",
        ) !== actorTelegramId) fail("offer_not_available");
    audience = "resolved_user";
  }

  return {
    row,
    offerCode: code,
    sourceKind: row.sourceKind,
    sourceVersionId,
    audience,
    partnerLinkId,
    partnerProfileId,
    inviterId,
    programCode,
  };
};

const normalizeLead = (value, { optional = false } = {}) => {
  const row = databaseRow(value, "lead", { optional });
  if (row === null) return null;
  const status = row.status;
  if (!STATES.has(status)) fail("invalid_lead");
  const reason = normalizeText(String(row.rejectionReason ?? ""), {
    maximum: 300,
    allowEmpty: true,
    code: "invalid_lead",
  });
  const normalized = {
    row,
    id: positiveInteger(row.id, "invalid_lead"),
    telegramId: positiveInteger(row.telegramId, "invalid_lead"),
    inviterId: nullablePositiveInteger(row.inviterId, "invalid_lead"),
    offerCode: offerCode(row.offerCode),
    status,
    rewardKopecks: nonNegativeInteger(
      row.rewardKopecks,
      MAX_REWARD_KOPECKS,
      "invalid_lead",
    ),
    rejectionReason: reason,
    reviewedBy: nullablePositiveInteger(row.reviewedBy, "invalid_lead"),
    createdAt: databaseTimestamp(row.createdAt, "invalid_lead"),
    updatedAt: databaseTimestamp(row.updatedAt, "invalid_lead"),
    reviewedAt: row.reviewedAt === null || row.reviewedAt === undefined
      ? null
      : databaseTimestamp(row.reviewedAt, "invalid_lead"),
  };
  if (status === "pending" &&
      (normalized.rewardKopecks !== 0 || reason !== "")) fail("invalid_lead");
  if (status === "rejected" && normalized.rewardKopecks !== 0) {
    fail("invalid_lead");
  }
  return normalized;
};

const normalizeAttribution = (value, { optional = false } = {}) => {
  const row = databaseRow(value, "lead_attribution", { optional });
  if (row === null) return null;
  const programCode = normalizeText(row.programCode, {
    minimum: 2,
    maximum: 64,
    allowEmpty: false,
    code: "invalid_attribution",
  });
  if (!PROGRAM_CODE.test(programCode)) fail("invalid_attribution");
  return {
    row,
    leadId: positiveInteger(row.leadId, "invalid_attribution"),
    partnerLinkId: positiveInteger(
      row.partnerLinkId,
      "invalid_attribution",
    ),
    partnerProfileId: positiveInteger(
      row.partnerProfileId,
      "invalid_attribution",
    ),
    inviterId: positiveInteger(row.inviterId, "invalid_attribution"),
    programCode,
    attributedAt: databaseTimestamp(row.attributedAt, "invalid_attribution"),
  };
};

const normalizeConversion = (value, lead) => {
  const row = databaseRow(value, "conversion", { optional: true });
  if (row === null) return null;
  const normalized = {
    row,
    id: positiveInteger(row.id, "invalid_conversion"),
    telegramId: positiveInteger(row.telegramId, "invalid_conversion"),
    inviterId: nullablePositiveInteger(row.inviterId, "invalid_conversion"),
    offerCode: offerCode(row.offerCode),
    status: row.status,
    rewardKopecks: nonNegativeInteger(
      row.rewardKopecks,
      MAX_REWARD_KOPECKS,
      "invalid_conversion",
    ),
  };
  if (!STATES.has(normalized.status) ||
      normalized.telegramId !== lead.telegramId ||
      normalized.inviterId !== lead.inviterId ||
      normalized.offerCode !== lead.offerCode) fail("compatibility_conflict");
  return normalized;
};

const normalizeExistingEvent = (value, expected) => {
  const row = databaseRow(value, "lead_event", { optional: true });
  if (row === null) return null;
  if (!EVENT_KEY.test(row.eventKey) || !HASH.test(row.requestHash) ||
      row.eventKey !== expected.eventKey ||
      row.requestHash !== expected.requestHash ||
      row.operation !== expected.operation) fail("idempotency_conflict");
  return {
    row,
    leadId: positiveInteger(row.leadId, "invalid_lead_event"),
  };
};

const validateLeadIdentity = (lead, actorTelegramId, code) => {
  if (lead.telegramId !== actorTelegramId) fail("cross_owner");
  if (lead.offerCode !== code) fail("lead_conflict");
};

const validateAttributionForLead = (attribution, lead) => {
  if (attribution === null) return;
  if (attribution.leadId !== lead.id ||
      attribution.inviterId !== lead.inviterId) fail("attribution_conflict");
};

const noChange = ({ operation, outcome, lead, eventKey = null, extra = {} }) =>
  deepFreeze({
    commandVersion: 1,
    operation,
    outcome,
    leadId: lead?.id ?? null,
    eventKey,
    transactionRequired: false,
    writes: [],
    ...extra,
  });

const eventWrite = ({
  eventKey,
  requestHash,
  leadId,
  operation,
  eventKind,
  fromStatus,
  toStatus,
  actor,
  offerCode: code,
  rewardKopecks,
  reason,
  now,
}) => ({
  table: "lead_request_events",
  action: "append_unique_event",
  values: {
    eventKey,
    requestHash,
    leadId,
    operation,
    eventKind,
    statusFrom: fromStatus,
    statusTo: toStatus,
    actorTelegramId: actor.telegramId,
    actorRole: actor.roles.has("admin") ? "admin" : "user",
    offerCode: code,
    rewardKopecks,
    reason,
    occurredAt: now,
  },
});

const submitEffects = (eventKey, leadId, inviterId) => deepFreeze([
  {
    kind: "notification",
    recipient: "subject",
    leadId,
    dedupeKey: `${eventKey}:subject`,
  },
  {
    kind: "notification",
    recipientTelegramId: inviterId,
    leadId,
    dedupeKey: `${eventKey}:partner`,
  },
  {
    kind: "analytics_adapter",
    sourceKind: "lead",
    leadId,
    dedupeKey: `${eventKey}:analytics`,
  },
]);

export async function buildLeadSubmitCommand({
  context,
  user,
  roleRows,
  payload,
  eligibleOffer,
  existingLead = null,
  existingAttribution = null,
  existingEvent = null,
  idempotencyKey,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const now = timestamp(nowSeconds);
  const actor = resolveActor({ context, user, roleRows });
  requireRole(actor, "user", "user_required");
  const input = normalizeSubmitPayload(payload);
  const offer = normalizeEligibleOffer(
    eligibleOffer,
    actor.telegramId,
    input.offerCode,
  );
  const lead = normalizeLead(existingLead, { optional: true });
  const attribution = normalizeAttribution(existingAttribution, {
    optional: true,
  });
  if (lead === null && attribution !== null) fail("attribution_conflict");
  if (lead !== null) {
    validateLeadIdentity(lead, actor.telegramId, offer.offerCode);
    validateAttributionForLead(attribution, lead);
  }

  const operation = lead?.status === "rejected"
    ? "lead.resubmit"
    : "lead.submit";
  const eventKey = await eventKeyFor(operation, idempotencyKey);
  const requestHash = await requestHashFor({
    operation,
    actorTelegramId: actor.telegramId,
    offerCode: offer.offerCode,
    sourceKind: offer.sourceKind,
    sourceVersionId: offer.sourceVersionId,
    audience: offer.audience,
    partnerLinkId: offer.partnerLinkId,
    partnerProfileId: offer.partnerProfileId,
    inviterId: offer.inviterId,
    programCode: offer.programCode,
  });
  const priorEvent = normalizeExistingEvent(existingEvent, {
    eventKey,
    requestHash,
    operation,
  });

  if (lead !== null && lead.status !== "rejected") {
    if (priorEvent !== null && priorEvent.leadId !== lead.id) {
      fail("event_state_conflict");
    }
    return noChange({
      operation,
      outcome: `already_${lead.status}`,
      lead,
      eventKey,
    });
  }
  if (priorEvent !== null) fail("event_state_conflict");

  if (lead === null) {
    const leadReference = "inserted_lead_id";
    return deepFreeze({
      commandVersion: 1,
      commandId: await commandIdFor(eventKey),
      operation,
      outcome: "create_pending",
      leadId: leadReference,
      eventKey,
      transactionRequired: true,
      idempotency: {
        eventKey,
        uniqueSubjectOffer: [actor.telegramId, offer.offerCode],
        conflictResult: "reload_existing_subject_offer",
      },
      compareAndSwap: { fromStatus: "missing", toStatus: "pending" },
      writes: [
        {
          table: "lead_requests",
          action: "insert_unique_subject_offer",
          reference: leadReference,
          values: {
            telegramId: actor.telegramId,
            inviterId: offer.inviterId,
            offerCode: offer.offerCode,
            status: "pending",
            rewardKopecks: 0,
            rejectionReason: "",
            reviewedBy: null,
            reviewedAt: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          table: "lead_partner_attribution",
          action: "insert_once_for_inserted_lead",
          values: {
            leadId: leadReference,
            partnerLinkId: offer.partnerLinkId,
            partnerProfileId: offer.partnerProfileId,
            programCode: offer.programCode,
            attributedAt: now,
          },
        },
        eventWrite({
          eventKey,
          requestHash,
          leadId: leadReference,
          operation,
          eventKind: "submitted",
          fromStatus: null,
          toStatus: "pending",
          actor,
          offerCode: offer.offerCode,
          rewardKopecks: 0,
          reason: "",
          now,
        }),
      ],
      postCommitEffects: submitEffects(
        eventKey,
        leadReference,
        offer.inviterId,
      ),
      forbiddenSideEffects: [
        "submit_external_bank_application",
        "guarantee_approval",
        "change_inviter",
        "grant_reward",
      ],
    });
  }

  if (lead.inviterId === null) fail("attribution_conflict");
  const attributionWrite = attribution === null
    ? (() => {
      if (lead.inviterId !== offer.inviterId) fail("attribution_conflict");
      return {
        table: "lead_partner_attribution",
        action: "backfill_once_if_absent_and_inviter_matches",
        values: {
          leadId: lead.id,
          partnerLinkId: offer.partnerLinkId,
          partnerProfileId: offer.partnerProfileId,
          programCode: offer.programCode,
          attributedAt: now,
        },
      };
    })()
    : null;
  const writes = [
    {
      table: "lead_requests",
      action: "compare_and_swap_rejected_to_pending",
      values: {
        id: lead.id,
        telegramId: lead.telegramId,
        offerCode: lead.offerCode,
        status: "pending",
        rewardKopecks: 0,
        rejectionReason: "",
        reviewedBy: null,
        reviewedAt: null,
        updatedAt: now,
      },
      immutable: {
        inviterId: lead.inviterId,
        createdAt: lead.createdAt,
      },
    },
  ];
  if (attributionWrite) writes.push(attributionWrite);
  writes.push(eventWrite({
    eventKey,
    requestHash,
    leadId: lead.id,
    operation,
    eventKind: "resubmitted",
    fromStatus: "rejected",
    toStatus: "pending",
    actor,
    offerCode: lead.offerCode,
    rewardKopecks: 0,
    reason: "",
    now,
  }));
  return deepFreeze({
    commandVersion: 1,
    commandId: await commandIdFor(eventKey),
    operation,
    outcome: "resubmit_pending",
    leadId: lead.id,
    eventKey,
    transactionRequired: true,
    idempotency: { eventKey, conflictResult: "reload_existing_subject_offer" },
    compareAndSwap: {
      leadId: lead.id,
      fromStatus: "rejected",
      toStatus: "pending",
    },
    writes,
    postCommitEffects: submitEffects(eventKey, lead.id, lead.inviterId),
    forbiddenSideEffects: [
      "rewrite_inviter",
      "rewrite_created_at",
      "rewrite_existing_attribution",
      "grant_reward",
    ],
  });
}

const targetStatusFor = (decision) => ({
  confirm: "confirmed",
  reject: "rejected",
  mark_paid: "paid",
})[decision];

const expectedStatusFor = (decision) => ({
  confirm: "pending",
  reject: "pending",
  mark_paid: "confirmed",
})[decision];

const sameFinalDecision = (lead, input) => {
  const target = targetStatusFor(input.decision);
  if (lead.status !== target) return false;
  if (target === "confirmed") {
    return lead.rewardKopecks === input.rewardKopecks &&
      lead.rejectionReason === "";
  }
  if (target === "rejected") {
    return lead.rewardKopecks === 0 &&
      lead.rejectionReason === input.reason;
  }
  return true;
};

const validateCompatibilityBeforeTransition = (conversion, lead, decision) => {
  if (conversion === null) return;
  if (decision === "mark_paid") {
    if (conversion.status !== "confirmed" ||
        conversion.rewardKopecks !== lead.rewardKopecks) {
      fail("compatibility_conflict");
    }
    return;
  }
  if (new Set(["confirmed", "paid"]).has(conversion.status)) {
    fail("compatibility_conflict");
  }
};

const validateCompatibilityAtTarget = (conversion, lead) => {
  if (!new Set(["confirmed", "paid"]).has(lead.status)) {
    if (conversion && new Set(["confirmed", "paid"]).has(conversion.status)) {
      fail("compatibility_conflict");
    }
    return { reconciliationRequired: false };
  }
  if (conversion === null) return { reconciliationRequired: true };
  if (conversion.status !== lead.status ||
      conversion.rewardKopecks !== lead.rewardKopecks) {
    fail("compatibility_conflict");
  }
  return { reconciliationRequired: false };
};

const resultEffects = (eventKey, lead, targetStatus) => {
  const effects = [
    {
      kind: "notification",
      recipientTelegramId: lead.telegramId,
      leadId: lead.id,
      dedupeKey: `${eventKey}:subject`,
    },
    {
      kind: "analytics_adapter",
      sourceKind: "lead",
      leadId: lead.id,
      dedupeKey: `${eventKey}:analytics`,
    },
  ];
  if (lead.inviterId !== null && new Set(["confirmed", "paid"]).has(targetStatus)) {
    effects.splice(1, 0, {
      kind: "notification",
      recipientTelegramId: lead.inviterId,
      leadId: lead.id,
      dedupeKey: `${eventKey}:partner`,
    });
  }
  return deepFreeze(effects);
};

export async function buildLeadResultCommand({
  context,
  user,
  roleRows,
  payload,
  lead: leadValue,
  attribution: attributionValue = null,
  compatibilityConversion = null,
  existingEvent = null,
  idempotencyKey,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const now = timestamp(nowSeconds);
  const actor = resolveActor({ context, user, roleRows });
  requireRole(actor, "admin", "admin_required");
  const input = normalizeResultPayload(payload);
  const lead = normalizeLead(leadValue);
  if (lead.id !== input.leadId) fail("lead_not_found");
  if (lead.telegramId === actor.telegramId) fail("self_review_forbidden");
  const attribution = normalizeAttribution(attributionValue, { optional: true });
  validateAttributionForLead(attribution, lead);
  const conversion = normalizeConversion(compatibilityConversion, lead);
  const targetStatus = targetStatusFor(input.decision);
  const operation = `lead.${input.decision}`;
  const eventKey = await eventKeyFor(
    `${operation}.${lead.id}`,
    idempotencyKey,
  );
  const rewardKopecks = input.decision === "mark_paid"
    ? lead.rewardKopecks
    : input.rewardKopecks;
  const requestHash = await requestHashFor({
    operation,
    leadId: lead.id,
    actorTelegramId: actor.telegramId,
    fromStatus: expectedStatusFor(input.decision),
    toStatus: targetStatus,
    rewardKopecks,
    reason: input.reason,
  });
  const priorEvent = normalizeExistingEvent(existingEvent, {
    eventKey,
    requestHash,
    operation,
  });

  if (sameFinalDecision(lead, input)) {
    if (priorEvent !== null && priorEvent.leadId !== lead.id) {
      fail("event_state_conflict");
    }
    const compatibility = validateCompatibilityAtTarget(conversion, lead);
    return noChange({
      operation,
      outcome: `already_${targetStatus}`,
      lead,
      eventKey,
      extra: { compatibility },
    });
  }
  if (priorEvent !== null) fail("event_state_conflict");
  if (lead.status !== expectedStatusFor(input.decision)) {
    fail("transition_conflict");
  }
  validateCompatibilityBeforeTransition(conversion, lead, input.decision);

  const writes = [
    {
      table: "lead_requests",
      action: "compare_and_swap_result",
      values: {
        id: lead.id,
        status: targetStatus,
        rewardKopecks,
        rejectionReason: input.reason,
        reviewedBy: actor.telegramId,
        reviewedAt: now,
        updatedAt: now,
      },
      immutable: {
        telegramId: lead.telegramId,
        inviterId: lead.inviterId,
        offerCode: lead.offerCode,
        createdAt: lead.createdAt,
      },
    },
    eventWrite({
      eventKey,
      requestHash,
      leadId: lead.id,
      operation,
      eventKind: input.decision,
      fromStatus: lead.status,
      toStatus: targetStatus,
      actor,
      offerCode: lead.offerCode,
      rewardKopecks,
      reason: input.reason,
      now,
    }),
  ];
  if (new Set(["confirmed", "paid"]).has(targetStatus)) {
    writes.push({
      table: "conversions",
      action: "upsert_compatibility_after_canonical_cas",
      authority: false,
      values: {
        telegramId: lead.telegramId,
        inviterId: lead.inviterId,
        offerCode: lead.offerCode,
        status: targetStatus,
        rewardKopecks,
        updatedAt: now,
      },
    });
  }
  writes.push({
    table: "admin_audit_log",
    action: "append_after_canonical_cas",
    values: {
      actorId: actor.telegramId,
      action: `lead_${targetStatus}`,
      entityType: "lead_request",
      entityId: String(lead.id),
      details: `from=${lead.status};to=${targetStatus};event=${eventKey}`,
      createdAt: now,
    },
  });
  return deepFreeze({
    commandVersion: 1,
    commandId: await commandIdFor(eventKey),
    operation,
    outcome: targetStatus,
    leadId: lead.id,
    eventKey,
    transactionRequired: true,
    idempotency: {
      eventKey,
      conflictResult: "reload_lead_and_compare_exact_result",
    },
    compareAndSwap: {
      leadId: lead.id,
      fromStatus: lead.status,
      toStatus: targetStatus,
    },
    writes,
    postCommitEffects: resultEffects(eventKey, lead, targetStatus),
    forbiddenSideEffects: [
      "rewrite_inviter",
      "rewrite_attribution",
      "external_payment",
      "activate_plan",
      "grant_partner_role",
    ],
  });
}

const leadSummary = (lead) => ({
  leadId: lead.id,
  offerCode: lead.offerCode,
  status: lead.status,
  createdAt: lead.createdAt,
  updatedAt: lead.updatedAt,
});

export function projectLeadForUser({
  context,
  user,
  roleRows,
  lead: leadValue,
} = {}) {
  const actor = resolveActor({ context, user, roleRows });
  requireRole(actor, "user", "user_required");
  const lead = normalizeLead(leadValue);
  if (lead.telegramId !== actor.telegramId) fail("lead_not_found");
  return deepFreeze({
    ...leadSummary(lead),
    result: {
      confirmed: new Set(["confirmed", "paid"]).has(lead.status),
      paid: lead.status === "paid",
      rejectionReason: lead.status === "rejected"
        ? lead.rejectionReason
        : null,
    },
    canResubmit: lead.status === "rejected",
  });
}

const normalizePartnerProfile = (value, actorTelegramId) => {
  const row = databaseRow(value, "partner_profile");
  const id = positiveInteger(row.id, "invalid_partner_profile");
  if (positiveInteger(row.telegramId, "invalid_partner_profile") !==
      actorTelegramId || row.status !== "active") fail("cross_owner");
  return { id };
};

export function projectLeadForPartner({
  context,
  user,
  roleRows,
  partnerProfile,
  lead: leadValue,
  attribution: attributionValue,
} = {}) {
  const actor = resolveActor({ context, user, roleRows });
  requireRole(actor, "partner", "partner_required");
  const profile = normalizePartnerProfile(partnerProfile, actor.telegramId);
  const lead = normalizeLead(leadValue);
  const attribution = normalizeAttribution(attributionValue);
  validateAttributionForLead(attribution, lead);
  if (attribution.partnerProfileId !== profile.id) fail("lead_not_found");
  return deepFreeze({
    ...leadSummary(lead),
    result: {
      confirmed: new Set(["confirmed", "paid"]).has(lead.status),
      paid: lead.status === "paid",
      rewardKopecks: new Set(["confirmed", "paid"]).has(lead.status)
        ? lead.rewardKopecks
        : 0,
    },
    attribution: {
      programCode: attribution.programCode,
      partnerLinkId: attribution.partnerLinkId,
    },
  });
}

export function projectLeadForAdmin({
  context,
  user,
  roleRows,
  lead: leadValue,
  attribution: attributionValue = null,
} = {}) {
  const actor = resolveActor({ context, user, roleRows });
  requireRole(actor, "admin", "admin_required");
  const lead = normalizeLead(leadValue);
  const attribution = normalizeAttribution(attributionValue, { optional: true });
  validateAttributionForLead(attribution, lead);
  return deepFreeze({
    ...leadSummary(lead),
    subjectTelegramId: lead.telegramId,
    inviterId: lead.inviterId,
    rewardKopecks: lead.rewardKopecks,
    rejectionReason: lead.rejectionReason,
    reviewedBy: lead.reviewedBy,
    reviewedAt: lead.reviewedAt,
    attribution: attribution === null
      ? null
      : {
        partnerProfileId: attribution.partnerProfileId,
        partnerLinkId: attribution.partnerLinkId,
        programCode: attribution.programCode,
      },
    allowedDecisions: ADMIN_DECISIONS_BY_STATUS[lead.status],
  });
}

export function leadLifecycleHttpError(error) {
  const code = error instanceof LeadLifecycleError
    ? error.code
    : "request_failed";
  const status = error instanceof LeadLifecycleError ? error.status : 500;
  const publicCode = new Set([
    "offer_not_available",
    "lead_not_found",
    "cross_owner",
  ]).has(code)
    ? "not_found"
    : status >= 500 ? "request_failed" : code;
  return deepFreeze({ status: publicCode === "not_found" ? 404 : status,
    body: { error: publicCode } });
}
