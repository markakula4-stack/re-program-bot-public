import {
  ANALYTICS_V2_DEFAULTS,
  ANALYTICS_V2_SOURCE_KINDS,
  buildCanonicalAnalyticsEvent,
} from "./analytics-foundation.mjs";

const TEXT_ENCODER = new TextEncoder();
const DAY = 86_400;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const ANALYTICS_V2_INGESTION_POLICY_VERSION =
  "2026-09-13.analytics-v2-part2";
export const ANALYTICS_V2_INGESTION_MAX_ROWS = 100;
export const ANALYTICS_V2_INGESTION_MAX_ATTEMPTS = 2;

const INGESTION_SOURCE_KINDS = Object.freeze(
  ANALYTICS_V2_SOURCE_KINDS.filter((value) => value !== "analytics_system"),
);

const LEGACY_FUNNEL_ROWS = [
  ["start", "excluded", null, null, "authoritative_source_elsewhere"],
  ["welcome_opened", "unmapped", null, null, "not_in_v1_registry"],
  ["terms_accepted", "excluded", null, null, "authoritative_source_elsewhere"],
  ["menu_opened", "mapped", "menu_opened", "menu", "mapped_exact"],
  ["offers_opened", "ambiguous", null, null, "semantics_not_exact"],
  ["offer_opened", "mapped", "offer_opened", "offer", "mapped_exact"],
  ["lead_submitted", "excluded", null, null, "authoritative_source_elsewhere"],
  ["partner_applied", "unmapped", null, null, "not_in_v1_registry"],
  ["partner_programs_opened", "ambiguous", null, null, "semantics_not_exact"],
  ["partner_program_opened", "excluded", null, null, "authoritative_source_elsewhere"],
  ["partner_link_submitted", "excluded", null, null, "authoritative_source_elsewhere"],
  ["partner_beta_opened", "unmapped", null, null, "not_in_v1_registry"],
  ["partner_offer_created", "unmapped", null, null, "not_in_v1_registry"],
  ["partner_offer_submitted", "unmapped", null, null, "not_in_v1_registry"],
  ["notifications_opened", "mapped", "notification_opened", "notification", "mapped_exact"],
  ["stats_opened", "unmapped", null, null, "not_in_v1_registry"],
  ["channel_prompt_opened", "unmapped", null, null, "not_in_v1_registry"],
  ["ai_opened", "excluded", null, null, "authoritative_source_elsewhere"],
  ["ai_enabled", "unmapped", null, null, "not_in_v1_registry"],
  ["ai_disabled", "unmapped", null, null, "not_in_v1_registry"],
  ["ai_consent_accepted", "excluded", null, null, "authoritative_source_elsewhere"],
  ["ai_answered", "excluded", null, null, "authoritative_source_elsewhere"],
  ["ai_limit_hit", "excluded", null, null, "authoritative_source_elsewhere"],
];

export const ANALYTICS_V2_LEGACY_FUNNEL_MAP = Object.freeze(
  Object.fromEntries(LEGACY_FUNNEL_ROWS.map(([
    sourceEventName,
    disposition,
    eventName,
    objectType,
    reasonCode,
  ]) => [sourceEventName, Object.freeze({
    disposition,
    eventName,
    objectType,
    reasonCode,
  })])),
);

const TYPED_SOURCE_SPECS = Object.freeze({
  partner_program: Object.freeze({
    opened: Object.freeze(["partner_program_opened", "partner_program"]),
    ambassador_activated: Object.freeze([
      "ambassador_profile_activated",
      "ambassador_profile",
    ]),
  }),
  partner_link: Object.freeze({
    submitted: Object.freeze(["partner_link_submitted", "partner_link"]),
    opened: Object.freeze(["partner_link_opened", "partner_link"]),
    campaign_touch: Object.freeze(["campaign_touch_recorded", "campaign_touch"]),
    registration_attributed: Object.freeze([
      "registration_attributed",
      "registration",
    ]),
  }),
  lead: Object.freeze({
    submitted: Object.freeze(["lead_submitted", "lead"]),
    attributed: Object.freeze(["lead_attributed", "lead"]),
  }),
  stars_payment: Object.freeze({
    succeeded: Object.freeze(["payment_succeeded", "payment"]),
    refunded: Object.freeze(["payment_refunded", "payment"]),
  }),
  stars_access: Object.freeze({
    activated: Object.freeze(["access_activated", "subscription_access"]),
    expired: Object.freeze(["access_expired", "subscription_access"]),
    attributed: Object.freeze(["paid_access_attributed", "paid_access"]),
  }),
  referral_reward: Object.freeze({
    confirmed: Object.freeze(["referral_reward_confirmed", "referral_reward"]),
  }),
  ai_partner: Object.freeze({
    opened: Object.freeze(["ai_opened", "ai_session"]),
    consent_accepted: Object.freeze(["ai_consent_accepted", "ai_session"]),
    generation_succeeded: Object.freeze([
      "ai_generation_succeeded",
      "ai_session",
    ]),
    generation_failed: Object.freeze(["ai_generation_failed", "ai_session"]),
    limit_hit: Object.freeze(["ai_limit_hit", "ai_session"]),
    draft_shared: Object.freeze(["ai_draft_shared", "ai_draft"]),
  }),
});

export const ANALYTICS_V2_SOURCE_CONTRACTS = Object.freeze({
  users: Object.freeze({
    keys: Object.freeze(["joinedAt", "profile", "sourceCode", "telegramId"]),
    authorityTime: "joinedAt",
  }),
  terms: Object.freeze({
    keys: Object.freeze([
      "acceptanceId",
      "acceptedAt",
      "profile",
      "sourceCode",
      "telegramId",
    ]),
    authorityTime: "acceptedAt",
  }),
  bot_start: Object.freeze({
    keys: Object.freeze([
      "profile",
      "sourceCode",
      "startedAt",
      "startId",
      "telegramId",
    ]),
    authorityTime: "startedAt",
  }),
  legacy_funnel: Object.freeze({
    keys: Object.freeze([
      "createdAt",
      "eventName",
      "profile",
      "sourceCode",
      "telegramId",
    ]),
    authorityTime: "createdAt",
  }),
  partner_program: Object.freeze({ typed: true }),
  partner_link: Object.freeze({ typed: true }),
  lead: Object.freeze({ typed: true }),
  stars_payment: Object.freeze({ typed: true }),
  stars_access: Object.freeze({ typed: true }),
  referral_reward: Object.freeze({ typed: true }),
  ai_partner: Object.freeze({ typed: true }),
});

const PROFILE_KEYS = new Set(["accessState", "legalProfile", "plan", "role"]);
const TYPED_KEYS = new Set([
  "occurredAt",
  "profile",
  "recordId",
  "recordType",
  "sourceCode",
  "telegramId",
]);
const ORIGINS = new Set(["live", "backfill", "reconciliation"]);
const ISSUE_CLASSIFICATIONS = new Set([
  "unmapped",
  "invalid",
  "ambiguous",
  "excluded",
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value, cryptoImpl) {
  return bytesToHex(await cryptoImpl.subtle.digest(
    "SHA-256",
    TEXT_ENCODER.encode(value),
  ));
}

async function hmacHex(secret, value, cryptoImpl) {
  const key = await cryptoImpl.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(await cryptoImpl.subtle.sign(
    "HMAC",
    key,
    TEXT_ENCODER.encode(value),
  ));
}

function assertExactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`${name} shape is invalid`);
  }
}

function requiredString(value, name, { minimum = 1, maximum = 160 } = {}) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new TypeError(`${name} must be a string or integer`);
  }
  const normalized = String(value).trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new TypeError(`${name} length is invalid`);
  }
  return normalized;
}

function requiredInteger(value, name, { minimum = 1, maximum } = {}) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    (maximum !== undefined && parsed > maximum)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return parsed;
}

function normalizeUuid(value, name) {
  const normalized = requiredString(value, name, {
    minimum: 36,
    maximum: 36,
  }).toLowerCase();
  if (!UUID_V4_PATTERN.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function normalizeOrigin(value) {
  const origin = requiredString(value, "analytics origin", { maximum: 24 })
    .toLowerCase();
  if (!ORIGINS.has(origin)) throw new TypeError("analytics origin is invalid");
  return origin;
}

function normalizeAuthorityTime(value) {
  if (Number.isSafeInteger(value)) return requiredInteger(value, "authority time");
  if (typeof value !== "string") {
    throw new TypeError("authority time is invalid");
  }
  const normalized = value.trim();
  let iso;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)) {
    iso = `${normalized.replace(" ", "T")}Z`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(normalized)) {
    iso = normalized;
  } else {
    throw new TypeError("authority time is invalid");
  }
  const millis = Date.parse(iso);
  if (!Number.isFinite(millis) || millis <= 0) {
    throw new TypeError("authority time is invalid");
  }
  return Math.floor(millis / 1_000);
}

function normalizeProfile(profile) {
  assertExactKeys(profile, PROFILE_KEYS, "analytics profile snapshot");
  return Object.freeze({
    role: requiredString(profile.role, "profile role", { maximum: 32 })
      .toLowerCase(),
    legal_profile: requiredString(
      profile.legalProfile,
      "profile legal profile",
      { maximum: 48 },
    ).toLowerCase(),
    plan: requiredString(profile.plan, "profile plan", { maximum: 32 })
      .toLowerCase(),
    access_state: requiredString(
      profile.accessState,
      "profile access state",
      { maximum: 48 },
    ).toLowerCase(),
  });
}

function sourceFamilyFromCode(value) {
  const code = requiredString(value, "source code", { maximum: 64 })
    .toLowerCase();
  if (code === "direct" || code === "legacy") return "direct";
  if (code === "referral") return "referral";
  if (code === "partner_referral") return "partner_link";
  if (/^src_[a-z0-9_-]{2,48}$/.test(code)) return "campaign";
  if (["telegram", "admin", "system"].includes(code)) return code;
  throw new TypeError("source code is not allowlisted");
}

function sourceIdentity(parts) {
  const identity = canonicalJson(parts.map((value) => String(value)));
  if (identity.length > 512) throw new TypeError("source identity is too long");
  return identity;
}

function canonicalInput({
  eventId,
  eventName,
  objectType,
  sourceKind,
  identity,
  telegramId,
  occurredAt,
  profile,
  sourceCode,
  context,
}) {
  return {
    eventId,
    eventName,
    eventVersion: 1,
    occurredAt,
    recordedAt: context.recordedAt,
    origin: context.origin,
    actorTelegramId: telegramId,
    pseudonymSecret: context.pseudonymSecret,
    pseudonymKeyVersion: context.pseudonymKeyVersion,
    sourceKind,
    sourceIdentity: identity,
    dimensions: {
      ...normalizeProfile(profile),
      source_family: sourceFamilyFromCode(sourceCode),
      object_type: objectType,
    },
    retentionDays: context.retentionDays,
  };
}

function issue({
  classification,
  reasonCode,
  sourceKind,
  identity = null,
  observation,
}) {
  if (!ISSUE_CLASSIFICATIONS.has(classification)) {
    throw new TypeError("analytics issue classification is invalid");
  }
  return Object.freeze({
    kind: "issue",
    classification,
    reasonCode,
    sourceKind,
    sourceIdentity: identity,
    observation,
  });
}

function adaptUsers(record, context) {
  assertExactKeys(record, new Set(ANALYTICS_V2_SOURCE_CONTRACTS.users.keys), "users record");
  const telegramId = requiredInteger(record.telegramId, "users telegram id");
  const occurredAt = normalizeAuthorityTime(record.joinedAt);
  return canonicalInput({
    eventId: context.eventId,
    eventName: "account_created",
    objectType: "account",
    sourceKind: "users",
    identity: sourceIdentity(["users", telegramId, occurredAt]),
    telegramId,
    occurredAt,
    profile: record.profile,
    sourceCode: record.sourceCode,
    context,
  });
}

function adaptTerms(record, context) {
  assertExactKeys(record, new Set(ANALYTICS_V2_SOURCE_CONTRACTS.terms.keys), "terms record");
  const telegramId = requiredInteger(record.telegramId, "terms telegram id");
  const acceptanceId = requiredString(record.acceptanceId, "terms acceptance id");
  const occurredAt = normalizeAuthorityTime(record.acceptedAt);
  return canonicalInput({
    eventId: context.eventId,
    eventName: "terms_accepted",
    objectType: "terms",
    sourceKind: "terms",
    identity: sourceIdentity(["terms", acceptanceId]),
    telegramId,
    occurredAt,
    profile: record.profile,
    sourceCode: record.sourceCode,
    context,
  });
}

function adaptBotStart(record, context) {
  assertExactKeys(
    record,
    new Set(ANALYTICS_V2_SOURCE_CONTRACTS.bot_start.keys),
    "bot start record",
  );
  const telegramId = requiredInteger(record.telegramId, "bot start telegram id");
  const startId = requiredString(record.startId, "bot start id");
  const occurredAt = normalizeAuthorityTime(record.startedAt);
  return canonicalInput({
    eventId: context.eventId,
    eventName: "start_received",
    objectType: "bot_start",
    sourceKind: "bot_start",
    identity: sourceIdentity(["bot_start", startId]),
    telegramId,
    occurredAt,
    profile: record.profile,
    sourceCode: record.sourceCode,
    context,
  });
}

function adaptLegacyFunnel(record, context) {
  assertExactKeys(
    record,
    new Set(ANALYTICS_V2_SOURCE_CONTRACTS.legacy_funnel.keys),
    "legacy funnel record",
  );
  const telegramId = requiredInteger(record.telegramId, "funnel telegram id");
  const eventName = requiredString(record.eventName, "legacy funnel event", {
    maximum: 64,
  }).toLowerCase();
  const occurredAt = normalizeAuthorityTime(record.createdAt);
  const identity = sourceIdentity([
    "legacy_funnel",
    telegramId,
    eventName,
    occurredAt,
  ]);
  const mapping = ANALYTICS_V2_LEGACY_FUNNEL_MAP[eventName];
  if (!mapping) {
    return issue({
      classification: "unmapped",
      reasonCode: "unknown_legacy_event",
      sourceKind: "legacy_funnel",
      identity,
      observation: record,
    });
  }
  if (mapping.disposition !== "mapped") {
    return issue({
      classification: mapping.disposition,
      reasonCode: mapping.reasonCode,
      sourceKind: "legacy_funnel",
      identity,
      observation: record,
    });
  }
  return canonicalInput({
    eventId: context.eventId,
    eventName: mapping.eventName,
    objectType: mapping.objectType,
    sourceKind: "legacy_funnel",
    identity,
    telegramId,
    occurredAt,
    profile: record.profile,
    sourceCode: record.sourceCode,
    context,
  });
}

function adaptTypedSource(sourceKind, record, context) {
  assertExactKeys(record, TYPED_KEYS, `${sourceKind} record`);
  const specs = TYPED_SOURCE_SPECS[sourceKind];
  const recordType = requiredString(record.recordType, `${sourceKind} record type`, {
    maximum: 48,
  }).toLowerCase();
  const spec = specs?.[recordType];
  if (!spec) throw new TypeError(`${sourceKind} record type is unsupported`);
  const recordId = requiredString(record.recordId, `${sourceKind} record id`);
  const telegramId = requiredInteger(record.telegramId, `${sourceKind} telegram id`);
  const occurredAt = normalizeAuthorityTime(record.occurredAt);
  return canonicalInput({
    eventId: context.eventId,
    eventName: spec[0],
    objectType: spec[1],
    sourceKind,
    identity: sourceIdentity([sourceKind, recordType, recordId]),
    telegramId,
    occurredAt,
    profile: record.profile,
    sourceCode: record.sourceCode,
    context,
  });
}

const ADAPTERS = Object.freeze({
  users: adaptUsers,
  terms: adaptTerms,
  bot_start: adaptBotStart,
  legacy_funnel: adaptLegacyFunnel,
  partner_program: (record, context) =>
    adaptTypedSource("partner_program", record, context),
  partner_link: (record, context) =>
    adaptTypedSource("partner_link", record, context),
  lead: (record, context) => adaptTypedSource("lead", record, context),
  stars_payment: (record, context) =>
    adaptTypedSource("stars_payment", record, context),
  stars_access: (record, context) =>
    adaptTypedSource("stars_access", record, context),
  referral_reward: (record, context) =>
    adaptTypedSource("referral_reward", record, context),
  ai_partner: (record, context) =>
    adaptTypedSource("ai_partner", record, context),
});

function invalidIssue(sourceKind, record, reasonCode = "record_shape_invalid") {
  return issue({
    classification: "invalid",
    reasonCode,
    sourceKind,
    observation: record,
  });
}

export async function adaptAnalyticsSourceRecord({
  sourceKind,
  record,
  eventId,
  recordedAt,
  highWatermarkAt,
  origin,
  pseudonymSecret,
  pseudonymKeyVersion = ANALYTICS_V2_DEFAULTS.pseudonymKeyVersion,
  retentionDays = ANALYTICS_V2_DEFAULTS.rawRetentionDays,
  cryptoImpl = globalThis.crypto,
} = {}) {
  const normalizedSourceKind = String(sourceKind || "").trim().toLowerCase();
  if (!INGESTION_SOURCE_KINDS.includes(normalizedSourceKind)) {
    throw new TypeError("analytics source kind is not allowlisted");
  }
  const normalizedRecordedAt = requiredInteger(recordedAt, "recorded at");
  const normalizedHighWatermark = requiredInteger(
    highWatermarkAt,
    "high watermark",
  );
  const normalizedOrigin = normalizeOrigin(origin);
  const normalizedEventId = normalizeUuid(eventId, "event id");
  const secret = requiredString(pseudonymSecret, "analytics pseudonym secret", {
    minimum: 32,
    maximum: 512,
  });
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto is required");

  let adapted;
  try {
    adapted = ADAPTERS[normalizedSourceKind](record, {
      eventId: normalizedEventId,
      recordedAt: normalizedRecordedAt,
      origin: normalizedOrigin,
      pseudonymSecret: secret,
      pseudonymKeyVersion: requiredInteger(
        pseudonymKeyVersion,
        "pseudonym key version",
      ),
      retentionDays: requiredInteger(retentionDays, "retention days", {
        maximum: ANALYTICS_V2_DEFAULTS.rawRetentionDays,
      }),
    });
  } catch (error) {
    const message = String(error?.message || error);
    const reasonCode = message.includes("authority time")
      ? "authority_time_invalid"
      : "record_shape_invalid";
    return invalidIssue(normalizedSourceKind, record, reasonCode);
  }

  if (adapted.kind === "issue") return adapted;
  if (adapted.occurredAt > normalizedHighWatermark) {
    return invalidIssue(
      normalizedSourceKind,
      record,
      "high_watermark_exceeded",
    );
  }

  try {
    const storageRecord = await buildCanonicalAnalyticsEvent(adapted, {
      cryptoImpl,
    });
    return Object.freeze({ kind: "event", storageRecord });
  } catch {
    return invalidIssue(
      normalizedSourceKind,
      record,
      "event_contract_invalid",
    );
  }
}

async function createIssueRow(adaptedIssue, {
  issueId,
  detectedAt,
  origin,
  pseudonymSecret,
  retentionDays,
  cryptoImpl,
}) {
  const observationToken = await hmacHex(
    pseudonymSecret,
    `re-analytics:issue-observation:v1:${canonicalJson(adaptedIssue.observation)}`,
    cryptoImpl,
  );
  const sourceKeyHash = adaptedIssue.sourceIdentity
    ? await hmacHex(
      pseudonymSecret,
      `re-analytics:issue-source:v1:${adaptedIssue.sourceKind}:${adaptedIssue.sourceIdentity}`,
      cryptoImpl,
    )
    : null;
  const issueDigest = await hmacHex(
    pseudonymSecret,
    `re-analytics:issue:v1:${canonicalJson({
      classification: adaptedIssue.classification,
      observationToken,
      reasonCode: adaptedIssue.reasonCode,
      sourceKeyHash,
      sourceKind: adaptedIssue.sourceKind,
    })}`,
    cryptoImpl,
  );
  return Object.freeze({
    issue_id: normalizeUuid(issueId, "issue id"),
    issue_key: `issue_${issueDigest}`,
    classification: adaptedIssue.classification,
    reason_code: adaptedIssue.reasonCode,
    source_kind: adaptedIssue.sourceKind,
    source_key_hash: sourceKeyHash,
    observation_hash: observationToken,
    origin,
    detected_at: detectedAt,
    retention_until: detectedAt + retentionDays * DAY,
  });
}

async function createConflictRow({
  conflictId,
  event,
  existingPayloadHash,
  detectedAt,
  retentionDays,
  cryptoImpl,
}) {
  if (!HASH_PATTERN.test(existingPayloadHash)) {
    throw new TypeError("existing analytics payload hash is invalid");
  }
  const eventKeyHash = await sha256Hex(event.event_key, cryptoImpl);
  const digest = await sha256Hex(canonicalJson({
    eventKeyHash,
    existingPayloadHash,
    observedPayloadHash: event.payload_hash,
    reasonCode: "hash_mismatch",
    sourceKind: event.source_kind,
  }), cryptoImpl);
  return Object.freeze({
    conflict_id: normalizeUuid(conflictId, "conflict id"),
    conflict_key: `conflict_${digest}`,
    event_key_hash: eventKeyHash,
    existing_payload_hash: existingPayloadHash,
    observed_payload_hash: event.payload_hash,
    reason_code: "hash_mismatch",
    source_kind: event.source_kind,
    occurrence_count: 1,
    detected_at: detectedAt,
    retention_until: detectedAt + retentionDays * DAY,
  });
}

function changed(result) {
  return Number(result?.meta?.changes || result?.changes || 0);
}

function canonicalEventInsert(db, event) {
  return db.prepare(
    `INSERT INTO canonical_analytics_events (
       event_id, event_key, event_name, event_version, occurred_at,
       recorded_at, origin, actor_pseudonym, pseudonym_key_version,
       source_kind, source_key_hash, payload_hash, privacy_class,
       correction_kind, correction_of_event_key_hash,
       replacement_event_key_hash, retention_until, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_key) DO NOTHING`,
  ).bind(
    event.event_id,
    event.event_key,
    event.event_name,
    event.event_version,
    event.occurred_at,
    event.recorded_at,
    event.origin,
    event.actor_pseudonym,
    event.pseudonym_key_version,
    event.source_kind,
    event.source_key_hash,
    event.payload_hash,
    event.privacy_class,
    event.correction_kind,
    event.correction_of_event_key_hash,
    event.replacement_event_key_hash,
    event.retention_until,
    event.created_at,
  );
}

function canonicalDimensionInsert(db, event, dimension) {
  return db.prepare(
    `INSERT OR IGNORE INTO analytics_event_dimensions
       (event_id, dimension_name, dimension_value, created_at)
     SELECT ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM canonical_analytics_events
       WHERE event_id = ? AND event_key = ? AND payload_hash = ?
     )`,
  ).bind(
    dimension.event_id,
    dimension.dimension_name,
    dimension.dimension_value,
    dimension.created_at,
    event.event_id,
    event.event_key,
    event.payload_hash,
  );
}

async function readCanonicalEvent(db, eventKey) {
  return db.prepare(
    `SELECT event_id, event_key, payload_hash
     FROM canonical_analytics_events WHERE event_key = ? LIMIT 1`,
  ).bind(eventKey).first();
}

async function assertExactCanonicalDimensions(db, eventId, dimensions) {
  const response = await db.prepare(
    `SELECT dimension_name, dimension_value
     FROM analytics_event_dimensions
     WHERE event_id = ?
     ORDER BY dimension_name`,
  ).bind(eventId).all();
  const actual = (response?.results || []).map((row) => ({
    dimension_name: String(row.dimension_name),
    dimension_value: String(row.dimension_value),
  }));
  const expected = dimensions.map((row) => ({
    dimension_name: String(row.dimension_name),
    dimension_value: String(row.dimension_value),
  })).sort((left, right) =>
    left.dimension_name.localeCompare(right.dimension_name));
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("analytics duplicate dimension mismatch");
  }
}

export function createD1AnalyticsIngestionStore(db) {
  if (!db?.prepare || !db?.batch) {
    throw new TypeError("D1 analytics store requires prepare and batch");
  }
  return Object.freeze({
    async writeCanonical(storageRecord) {
      const { event, dimensions } = storageRecord;
      const before = await readCanonicalEvent(db, event.event_key);
      if (before) {
        if (before.payload_hash !== event.payload_hash) {
          return Object.freeze({
            outcome: "conflict",
            existingPayloadHash: String(before.payload_hash || ""),
          });
        }
        await assertExactCanonicalDimensions(db, before.event_id, dimensions);
        return Object.freeze({ outcome: "duplicate" });
      }

      const results = await db.batch([
        canonicalEventInsert(db, event),
        ...dimensions.map((dimension) =>
          canonicalDimensionInsert(db, event, dimension)),
      ]);
      const existing = await readCanonicalEvent(db, event.event_key);
      if (!existing) throw new Error("analytics event insert was not observable");

      if (changed(results?.[0]) === 1) {
        const dimensionChanges = (results || []).slice(1)
          .reduce((total, result) => total + changed(result), 0);
        if (
          existing.event_id !== event.event_id ||
          existing.payload_hash !== event.payload_hash ||
          dimensionChanges !== dimensions.length
        ) {
          throw new Error("analytics canonical insert is incomplete");
        }
        await assertExactCanonicalDimensions(db, existing.event_id, dimensions);
        return Object.freeze({ outcome: "inserted" });
      }
      if (existing.payload_hash === event.payload_hash) {
        await assertExactCanonicalDimensions(db, existing.event_id, dimensions);
        return Object.freeze({ outcome: "duplicate" });
      }
      return Object.freeze({
        outcome: "conflict",
        existingPayloadHash: String(existing.payload_hash || ""),
      });
    },

    async writeConflict(row) {
      return db.prepare(
        `INSERT OR IGNORE INTO analytics_ingestion_conflicts (
           conflict_id, conflict_key, event_key_hash, existing_payload_hash,
           observed_payload_hash, reason_code, source_kind, occurrence_count,
           detected_at, retention_until
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
          row.conflict_id,
          row.conflict_key,
          row.event_key_hash,
          row.existing_payload_hash,
          row.observed_payload_hash,
          row.reason_code,
          row.source_kind,
          row.occurrence_count,
          row.detected_at,
          row.retention_until,
        )
        .run();
    },

    async writeIssue(row) {
      return db.prepare(
        `INSERT OR IGNORE INTO analytics_ingestion_issues (
           issue_id, issue_key, classification, reason_code, source_kind,
           source_key_hash, observation_hash, origin, detected_at,
           retention_until
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        row.issue_id,
        row.issue_key,
        row.classification,
        row.reason_code,
        row.source_kind,
        row.source_key_hash,
        row.observation_hash,
        row.origin,
        row.detected_at,
        row.retention_until,
      ).run();
    },

    async getCheckpoint(sourceKind) {
      return db.prepare(
        `SELECT source_kind, status, cursor_hash, high_watermark_at,
                rows_seen, rows_inserted, rows_duplicate, rows_conflict,
                last_error_code, revision, created_at, updated_at
         FROM analytics_source_checkpoints
         WHERE source_kind = ? LIMIT 1`,
      ).bind(sourceKind).first();
    },

    async finalizeBatch({ checkpoint, receipt }) {
      const statements = [
        db.prepare(
          `UPDATE analytics_source_checkpoints
           SET status = ?, cursor_hash = ?, high_watermark_at = ?,
               rows_seen = rows_seen + ?,
               rows_inserted = rows_inserted + ?,
               rows_duplicate = rows_duplicate + ?,
               rows_conflict = rows_conflict + ?,
               last_error_code = '', revision = revision + 1, updated_at = ?
           WHERE source_kind = ? AND revision = ?`,
        ).bind(
          checkpoint.status,
          checkpoint.cursorHash,
          checkpoint.highWatermarkAt,
          checkpoint.rowsSeen,
          checkpoint.rowsInserted,
          checkpoint.rowsDuplicate,
          checkpoint.rowsConflict,
          checkpoint.updatedAt,
          checkpoint.sourceKind,
          checkpoint.expectedRevision,
        ),
        db.prepare(
          `INSERT INTO analytics_ingestion_receipts (
             receipt_id, batch_fingerprint, source_kind, origin,
             high_watermark_at, cursor_hash, checkpoint_revision,
             checkpoint_rows_seen, checkpoint_rows_inserted,
             checkpoint_rows_duplicate, checkpoint_rows_conflict,
             attempt_count, max_rows,
             rows_seen, rows_inserted, rows_duplicate, rows_conflict,
             rows_unmapped, rows_invalid, rows_ambiguous, rows_excluded,
             input_digest, result_digest, status, started_at, finished_at,
             retention_until
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          receipt.receipt_id,
          receipt.batch_fingerprint,
          receipt.source_kind,
          receipt.origin,
          receipt.high_watermark_at,
          receipt.cursor_hash,
          receipt.checkpoint_revision,
          receipt.checkpoint_rows_seen,
          receipt.checkpoint_rows_inserted,
          receipt.checkpoint_rows_duplicate,
          receipt.checkpoint_rows_conflict,
          receipt.attempt_count,
          receipt.max_rows,
          receipt.rows_seen,
          receipt.rows_inserted,
          receipt.rows_duplicate,
          receipt.rows_conflict,
          receipt.rows_unmapped,
          receipt.rows_invalid,
          receipt.rows_ambiguous,
          receipt.rows_excluded,
          receipt.input_digest,
          receipt.result_digest,
          receipt.status,
          receipt.started_at,
          receipt.finished_at,
          receipt.retention_until,
        ),
      ];
      const results = await db.batch(statements);
      if (changed(results?.[0]) !== 1 || changed(results?.[1]) !== 1) {
        throw new Error("analytics checkpoint finalization conflict");
      }
      return Object.freeze({ outcome: "finalized" });
    },
  });
}

function isRetryable(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || error).toLowerCase();
  return ["SQLITE_BUSY", "SQLITE_LOCKED", "D1_ERROR"].includes(code) ||
    message.includes("database is locked") ||
    message.includes("temporarily unavailable");
}

async function withBoundedRetry(operation, onAttempt) {
  let lastError;
  for (let attempt = 1; attempt <= ANALYTICS_V2_INGESTION_MAX_ATTEMPTS; attempt += 1) {
    onAttempt(attempt);
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === ANALYTICS_V2_INGESTION_MAX_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw lastError;
}

function assertIngestionConfig(config) {
  if (
    !config ||
    config.configurationValid !== true ||
    config.rolloutMode !== "admin_shadow" ||
    config.masterEnabled !== true ||
    config.ingestEnabled !== true
  ) {
    throw new Error("analytics ingestion is closed");
  }
}

function emptyCounts(rowsSeen) {
  return {
    rows_seen: rowsSeen,
    rows_inserted: 0,
    rows_duplicate: 0,
    rows_conflict: 0,
    rows_unmapped: 0,
    rows_invalid: 0,
    rows_ambiguous: 0,
    rows_excluded: 0,
  };
}

const COUNT_FIELDS = Object.freeze([
  "rows_seen",
  "rows_inserted",
  "rows_duplicate",
  "rows_conflict",
  "rows_unmapped",
  "rows_invalid",
  "rows_ambiguous",
  "rows_excluded",
]);

export function reconcileAnalyticsIngestionCounts(counts) {
  assertExactKeys(counts, new Set(COUNT_FIELDS), "analytics ingestion counts");
  const normalized = Object.fromEntries(COUNT_FIELDS.map((field) => [
    field,
    requiredInteger(counts[field], field, { minimum: 0 }),
  ]));
  const accounted = COUNT_FIELDS.slice(1)
    .reduce((total, field) => total + normalized[field], 0);
  const unexplainedDelta = normalized.rows_seen - accounted;
  return Object.freeze({
    rowsSeen: normalized.rows_seen,
    rowsAccounted: accounted,
    unexplainedDelta,
    exact: unexplainedDelta === 0,
  });
}

function incrementIssue(counts, classification) {
  const field = {
    unmapped: "rows_unmapped",
    invalid: "rows_invalid",
    ambiguous: "rows_ambiguous",
    excluded: "rows_excluded",
  }[classification];
  if (!field) throw new Error("analytics issue count is unsupported");
  counts[field] += 1;
}

export async function ingestAnalyticsBatch({
  config,
  store,
  sourceKind,
  records,
  origin,
  highWatermarkAt,
  pseudonymSecret,
  pseudonymKeyVersion = ANALYTICS_V2_DEFAULTS.pseudonymKeyVersion,
  retentionDays = ANALYTICS_V2_DEFAULTS.rawRetentionDays,
  maxRows = ANALYTICS_V2_INGESTION_MAX_ROWS,
  startedAt,
  finishedAt = startedAt,
  idFactory = () => globalThis.crypto.randomUUID(),
  cryptoImpl = globalThis.crypto,
} = {}) {
  assertIngestionConfig(config);
  if (!store?.writeCanonical || !store?.writeConflict || !store?.writeIssue ||
      !store?.getCheckpoint || !store?.finalizeBatch) {
    throw new TypeError("analytics ingestion store is incomplete");
  }
  const normalizedSourceKind = String(sourceKind || "").trim().toLowerCase();
  if (!INGESTION_SOURCE_KINDS.includes(normalizedSourceKind)) {
    throw new TypeError("analytics source kind is not allowlisted");
  }
  if (!Array.isArray(records)) throw new TypeError("analytics records must be an array");
  const normalizedMaxRows = requiredInteger(maxRows, "analytics max rows", {
    maximum: ANALYTICS_V2_INGESTION_MAX_ROWS,
  });
  if (records.length > normalizedMaxRows) {
    throw new RangeError("analytics batch exceeds its bounded row limit");
  }
  const normalizedOrigin = normalizeOrigin(origin);
  const normalizedHighWatermark = requiredInteger(
    highWatermarkAt,
    "analytics high watermark",
  );
  const normalizedStartedAt = requiredInteger(startedAt, "analytics batch start");
  const normalizedFinishedAt = requiredInteger(finishedAt, "analytics batch finish");
  if (normalizedFinishedAt < normalizedStartedAt) {
    throw new TypeError("analytics batch finish precedes its start");
  }
  const secret = requiredString(pseudonymSecret, "analytics pseudonym secret", {
    minimum: 32,
    maximum: 512,
  });
  const normalizedRetention = requiredInteger(retentionDays, "analytics retention", {
    maximum: ANALYTICS_V2_DEFAULTS.rawRetentionDays,
  });
  const keyVersion = requiredInteger(
    pseudonymKeyVersion,
    "analytics pseudonym key version",
  );
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto is required");

  const checkpoint = await store.getCheckpoint(normalizedSourceKind);
  if (!checkpoint) throw new Error("analytics source checkpoint is missing");
  if (
    Number(checkpoint.high_watermark_at || 0) > normalizedHighWatermark ||
    (checkpoint.status === "running" &&
      Number(checkpoint.high_watermark_at) !== normalizedHighWatermark)
  ) {
    throw new Error("analytics high watermark cannot move backward or mid-run");
  }

  const recordTokens = [];
  for (const record of records) {
    recordTokens.push(await hmacHex(
      secret,
      `re-analytics:batch-record:v1:${canonicalJson(record)}`,
      cryptoImpl,
    ));
  }
  const inputDigest = await hmacHex(
    secret,
    `re-analytics:batch-input:v1:${canonicalJson({
      highWatermarkAt: normalizedHighWatermark,
      origin: normalizedOrigin,
      recordTokens,
      sourceKind: normalizedSourceKind,
    })}`,
    cryptoImpl,
  );
  const batchFingerprint = await hmacHex(
    secret,
    `re-analytics:batch:v1:${normalizedSourceKind}:${normalizedOrigin}:${inputDigest}`,
    cryptoImpl,
  );
  const cursorHash = await hmacHex(
    secret,
    `re-analytics:cursor:v1:${normalizedSourceKind}:${normalizedHighWatermark}:${inputDigest}`,
    cryptoImpl,
  );

  const counts = emptyCounts(records.length);
  const outcomeTokens = [];
  let attemptCount = 1;
  const observeAttempt = (attempt) => {
    attemptCount = Math.max(attemptCount, attempt);
  };

  for (let index = 0; index < records.length; index += 1) {
    const adapted = await adaptAnalyticsSourceRecord({
      sourceKind: normalizedSourceKind,
      record: records[index],
      eventId: idFactory("event", index),
      recordedAt: normalizedStartedAt,
      highWatermarkAt: normalizedHighWatermark,
      origin: normalizedOrigin,
      pseudonymSecret: secret,
      pseudonymKeyVersion: keyVersion,
      retentionDays: normalizedRetention,
      cryptoImpl,
    });

    if (adapted.kind === "issue") {
      const row = await createIssueRow(adapted, {
        issueId: idFactory("issue", index),
        detectedAt: normalizedFinishedAt,
        origin: normalizedOrigin,
        pseudonymSecret: secret,
        retentionDays: normalizedRetention,
        cryptoImpl,
      });
      await withBoundedRetry(() => store.writeIssue(row), observeAttempt);
      incrementIssue(counts, adapted.classification);
      outcomeTokens.push(`${adapted.classification}:${row.issue_key}`);
      continue;
    }

    const result = await withBoundedRetry(
      () => store.writeCanonical(adapted.storageRecord),
      observeAttempt,
    );
    if (result.outcome === "inserted") {
      counts.rows_inserted += 1;
      outcomeTokens.push(`inserted:${adapted.storageRecord.event.event_key}`);
      continue;
    }
    if (result.outcome === "duplicate") {
      counts.rows_duplicate += 1;
      outcomeTokens.push(`duplicate:${adapted.storageRecord.event.event_key}`);
      continue;
    }
    if (result.outcome !== "conflict") {
      throw new Error("analytics store returned an invalid outcome");
    }
    const conflict = await createConflictRow({
      conflictId: idFactory("conflict", index),
      event: adapted.storageRecord.event,
      existingPayloadHash: result.existingPayloadHash,
      detectedAt: normalizedFinishedAt,
      retentionDays: normalizedRetention,
      cryptoImpl,
    });
    await withBoundedRetry(() => store.writeConflict(conflict), observeAttempt);
    counts.rows_conflict += 1;
    outcomeTokens.push(`conflict:${conflict.conflict_key}`);
  }

  const reconciliation = reconcileAnalyticsIngestionCounts(counts);
  if (!reconciliation.exact) {
    throw new Error("analytics ingestion has an unexplained count delta");
  }

  const resultDigest = await sha256Hex(canonicalJson({
    counts,
    outcomeTokens,
  }), cryptoImpl);
  const status = counts.rows_conflict + counts.rows_unmapped +
      counts.rows_invalid + counts.rows_ambiguous > 0
    ? "partial"
    : "complete";
  const nextCheckpoint = Object.freeze({
    revision: Number(checkpoint.revision) + 1,
    rows_seen: Number(checkpoint.rows_seen) + counts.rows_seen,
    rows_inserted: Number(checkpoint.rows_inserted) + counts.rows_inserted,
    rows_duplicate: Number(checkpoint.rows_duplicate) + counts.rows_duplicate,
    rows_conflict: Number(checkpoint.rows_conflict) + counts.rows_conflict,
  });
  const receipt = Object.freeze({
    receipt_id: normalizeUuid(idFactory("receipt", 0), "receipt id"),
    batch_fingerprint: batchFingerprint,
    source_kind: normalizedSourceKind,
    origin: normalizedOrigin,
    high_watermark_at: normalizedHighWatermark,
    cursor_hash: cursorHash,
    checkpoint_revision: nextCheckpoint.revision,
    checkpoint_rows_seen: nextCheckpoint.rows_seen,
    checkpoint_rows_inserted: nextCheckpoint.rows_inserted,
    checkpoint_rows_duplicate: nextCheckpoint.rows_duplicate,
    checkpoint_rows_conflict: nextCheckpoint.rows_conflict,
    max_rows: normalizedMaxRows,
    ...counts,
    input_digest: inputDigest,
    result_digest: resultDigest,
    status,
    started_at: normalizedStartedAt,
    finished_at: normalizedFinishedAt,
    retention_until: normalizedFinishedAt + normalizedRetention * DAY,
  });
  await withBoundedRetry((attempt) => store.finalizeBatch({
    checkpoint: {
      sourceKind: normalizedSourceKind,
      expectedRevision: Number(checkpoint.revision),
      status: "complete",
      cursorHash,
      highWatermarkAt: normalizedHighWatermark,
      rowsSeen: counts.rows_seen,
      rowsInserted: counts.rows_inserted,
      rowsDuplicate: counts.rows_duplicate,
      rowsConflict: counts.rows_conflict,
      updatedAt: normalizedFinishedAt,
    },
    receipt: {
      ...receipt,
      attempt_count: Math.max(attemptCount, attempt),
    },
  }), observeAttempt);

  return Object.freeze({
    policyVersion: ANALYTICS_V2_INGESTION_POLICY_VERSION,
    sourceKind: normalizedSourceKind,
    origin: normalizedOrigin,
    highWatermarkAt: normalizedHighWatermark,
    cursorHash,
    status,
    counts: Object.freeze({ ...counts }),
    reconciliation,
    receipt: Object.freeze({
      receiptId: receipt.receipt_id,
      batchFingerprint,
      inputDigest,
      resultDigest,
      attemptCount,
    }),
  });
}

export const ANALYTICS_V2_INGESTION_SOURCE_KINDS = INGESTION_SOURCE_KINDS;
