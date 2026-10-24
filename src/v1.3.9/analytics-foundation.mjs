const TEXT_ENCODER = new TextEncoder();

export const ANALYTICS_V2_POLICY_VERSION =
  "2026-09-13.analytics-v2-part1";

export const ANALYTICS_V2_DEFAULTS = Object.freeze({
  eventRegistryVersion: 1,
  metricDictionaryVersion: 1,
  pseudonymKeyVersion: 1,
  rawRetentionDays: 180,
  smallSegmentThreshold: 5,
});

const EVENT_DEFINITIONS = [
  ["start_received", "acquisition", "bot_start"],
  ["account_created", "acquisition", "users"],
  ["terms_accepted", "product", "terms"],
  ["menu_opened", "product", "funnel"],
  ["offer_opened", "product", "funnel"],
  ["lead_submitted", "product", "leads"],
  ["notification_opened", "product", "funnel"],
  ["partner_program_opened", "partner", "partner_program"],
  ["partner_link_submitted", "partner", "partner_link"],
  ["partner_link_opened", "partner", "partner_link"],
  ["ambassador_profile_activated", "partner", "partner_program"],
  ["campaign_touch_recorded", "partner", "partner_link"],
  ["registration_attributed", "partner", "partner_link"],
  ["lead_attributed", "partner", "leads"],
  ["paid_access_attributed", "partner", "stars_access"],
  ["referral_reward_confirmed", "partner", "referral_v1_3_7"],
  ["payment_succeeded", "commerce", "stars_payment"],
  ["access_activated", "commerce", "stars_access"],
  ["access_expired", "commerce", "stars_access"],
  ["payment_refunded", "commerce", "stars_payment"],
  ["ai_opened", "ai", "ai_v1_3_8"],
  ["ai_consent_accepted", "ai", "ai_v1_3_8"],
  ["ai_generation_succeeded", "ai", "ai_v1_3_8"],
  ["ai_generation_failed", "ai", "ai_v1_3_8"],
  ["ai_limit_hit", "ai", "ai_v1_3_8"],
  ["ai_draft_shared", "ai", "ai_v1_3_8"],
  ["analytics_event_corrected", "system", "analytics_v2"],
];

export const ANALYTICS_V2_EVENT_REGISTRY = Object.freeze(
  EVENT_DEFINITIONS.map(([eventName, category, authoritySource]) =>
    Object.freeze({
      eventName,
      eventVersion: 1,
      category,
      authoritySource,
      privacyClass: "pseudonymous",
      correctionPolicy: eventName === "analytics_event_corrected"
        ? "append_only"
        : "append_correction",
    })
  ),
);

export const ANALYTICS_V2_DIMENSION_VALUES = Object.freeze({
  role: Object.freeze(["user", "partner", "admin"]),
  legal_profile: Object.freeze([
    "individual",
    "self_employed",
    "individual_entrepreneur",
    "unknown",
  ]),
  plan: Object.freeze(["free", "professional", "dragon", "unknown"]),
  access_state: Object.freeze([
    "none",
    "trial",
    "active",
    "cancel_at_period_end",
    "expired",
    "refunded",
    "suspended",
    "unknown",
  ]),
  source_family: Object.freeze([
    "direct",
    "referral",
    "partner_link",
    "campaign",
    "telegram",
    "admin",
    "system",
    "backfill",
  ]),
  object_type: Object.freeze([
    "bot_start",
    "account",
    "terms",
    "menu",
    "offer",
    "lead",
    "notification",
    "partner_program",
    "partner_link",
    "ambassador_profile",
    "campaign_touch",
    "registration",
    "paid_access",
    "referral_reward",
    "payment",
    "subscription_access",
    "ai_session",
    "ai_draft",
    "analytics_event",
  ]),
});

export const ANALYTICS_V2_SOURCE_KINDS = Object.freeze([
  "users",
  "terms",
  "bot_start",
  "legacy_funnel",
  "partner_program",
  "partner_link",
  "lead",
  "stars_payment",
  "stars_access",
  "referral_reward",
  "ai_partner",
  "analytics_system",
]);

const AUTHORITY_TO_SOURCE_KIND = Object.freeze({
  users: "users",
  terms: "terms",
  bot_start: "bot_start",
  funnel: "legacy_funnel",
  partner_program: "partner_program",
  partner_link: "partner_link",
  leads: "lead",
  stars_payment: "stars_payment",
  stars_access: "stars_access",
  referral_v1_3_7: "referral_reward",
  ai_v1_3_8: "ai_partner",
  analytics_v2: "analytics_system",
});

const EVENT_BY_NAME = new Map(
  ANALYTICS_V2_EVENT_REGISTRY.map((definition) => [
    `${definition.eventName}:${definition.eventVersion}`,
    definition,
  ]),
);

const DIMENSION_NAMES = Object.freeze(
  Object.keys(ANALYTICS_V2_DIMENSION_VALUES).sort(),
);
const ORIGINS = new Set(["live", "backfill", "reconciliation", "system"]);
const CORRECTION_KINDS = new Set(["none", "retract", "replace"]);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const EVENT_KEY_PATTERN = /^evt_[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function unique(values) {
  return [...new Set(values)];
}

function strictFlag(value, name, problems) {
  if (value === undefined || value === null || value === "" || value === false || value === 0) {
    return false;
  }
  if (value === true || value === 1 || value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") return false;
  problems.push(`${name}_invalid`);
  return false;
}

function configuredInteger(value, fallback, { minimum, maximum, name, problems }) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    problems.push(`${name}_invalid`);
    return fallback;
  }
  return parsed;
}

function requiredInteger(value, name, { minimum = 1 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return parsed;
}

function requiredString(value, name, { minimum = 1, maximum = 512 } = {}) {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new TypeError(`${name} length is invalid`);
  }
  return normalized;
}

function assertExactKeys(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length > 0) {
    throw new TypeError(`${name} contains unsupported fields: ${extras.sort().join(", ")}`);
  }
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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

async function sha256Hex(value, cryptoImpl) {
  return bytesToHex(await cryptoImpl.subtle.digest(
    "SHA-256",
    TEXT_ENCODER.encode(value),
  ));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeDimensions(dimensions) {
  assertExactKeys(dimensions, new Set(DIMENSION_NAMES), "analytics dimensions");
  const supplied = Object.keys(dimensions).sort();
  if (
    supplied.length !== DIMENSION_NAMES.length ||
    supplied.some((name, index) => name !== DIMENSION_NAMES[index])
  ) {
    throw new TypeError("all canonical analytics dimensions are required");
  }
  return Object.freeze(Object.fromEntries(DIMENSION_NAMES.map((name) => {
    const value = requiredString(dimensions[name], `dimension ${name}`, {
      maximum: 48,
    }).toLowerCase();
    if (!ANALYTICS_V2_DIMENSION_VALUES[name].includes(value)) {
      throw new TypeError(`unsupported analytics dimension ${name}:${value}`);
    }
    return [name, value];
  })));
}

function normalizeCorrection(eventName, correction) {
  if (eventName !== "analytics_event_corrected") {
    if (correction !== undefined && correction !== null) {
      throw new TypeError("correction metadata is only valid for correction events");
    }
    return Object.freeze({
      kind: "none",
      targetEventKey: null,
      replacementEventKey: null,
    });
  }
  assertExactKeys(
    correction,
    new Set(["kind", "targetEventKey", "replacementEventKey"]),
    "analytics correction",
  );
  const kind = requiredString(correction.kind, "correction kind", { maximum: 16 });
  if (!CORRECTION_KINDS.has(kind) || kind === "none") {
    throw new TypeError("correction kind must be retract or replace");
  }
  const targetEventKey = requiredString(
    correction.targetEventKey,
    "correction target event key",
    { minimum: 68, maximum: 68 },
  );
  if (!EVENT_KEY_PATTERN.test(targetEventKey)) {
    throw new TypeError("correction target event key is invalid");
  }
  const replacementEventKey = correction.replacementEventKey === null ||
      correction.replacementEventKey === undefined
    ? null
    : requiredString(
      correction.replacementEventKey,
      "replacement event key",
      { minimum: 68, maximum: 68 },
    );
  if (kind === "retract" && replacementEventKey !== null) {
    throw new TypeError("retract correction cannot name a replacement");
  }
  if (
    kind === "replace" &&
    (!replacementEventKey || !EVENT_KEY_PATTERN.test(replacementEventKey) ||
      replacementEventKey === targetEventKey)
  ) {
    throw new TypeError("replace correction requires a distinct replacement event key");
  }
  return Object.freeze({ kind, targetEventKey, replacementEventKey });
}

export function readAnalyticsV2Config(env = {}) {
  const problems = [];
  const requestedMode = String(env.ANALYTICS_V2_ROLLOUT_MODE || "off")
    .trim()
    .toLowerCase();
  const rolloutMode = ["off", "admin_shadow"].includes(requestedMode)
    ? requestedMode
    : "off";
  if (requestedMode !== rolloutMode) problems.push("analytics_rollout_mode_invalid");

  const masterRequested = strictFlag(
    env.ANALYTICS_V2_ENABLED,
    "analytics_master",
    problems,
  );
  const ingestRequested = strictFlag(
    env.ANALYTICS_V2_INGEST_ENABLED,
    "analytics_ingest",
    problems,
  );
  const projectionsRequested = strictFlag(
    env.ANALYTICS_V2_PROJECTIONS_ENABLED,
    "analytics_projections",
    problems,
  );
  const ambassadorRequested = strictFlag(
    env.AMBASSADOR_V2_ENABLED,
    "ambassador_v2",
    problems,
  );
  const rawRetentionDays = configuredInteger(
    env.ANALYTICS_V2_RAW_RETENTION_DAYS,
    ANALYTICS_V2_DEFAULTS.rawRetentionDays,
    { minimum: 1, maximum: 180, name: "analytics_retention_days", problems },
  );
  const smallSegmentThreshold = configuredInteger(
    env.ANALYTICS_V2_SMALL_SEGMENT_THRESHOLD,
    ANALYTICS_V2_DEFAULTS.smallSegmentThreshold,
    { minimum: 5, maximum: 20, name: "analytics_small_segment", problems },
  );

  if (masterRequested && rolloutMode !== "admin_shadow") {
    problems.push("analytics_admin_shadow_required");
  }
  if ((ingestRequested || projectionsRequested || ambassadorRequested) && !masterRequested) {
    problems.push("analytics_master_required");
  }
  if (projectionsRequested && !ingestRequested) {
    problems.push("analytics_ingest_required_for_projections");
  }
  if (ambassadorRequested && !projectionsRequested) {
    problems.push("analytics_projections_required_for_ambassador");
  }

  const configurationProblems = Object.freeze(unique(problems));
  const configurationValid = configurationProblems.length === 0;
  const masterEnabled = configurationValid && masterRequested &&
    rolloutMode === "admin_shadow";
  const ingestEnabled = masterEnabled && ingestRequested;
  const projectionsEnabled = ingestEnabled && projectionsRequested;
  const ambassadorEnabled = projectionsEnabled && ambassadorRequested;

  return Object.freeze({
    policyVersion: ANALYTICS_V2_POLICY_VERSION,
    configurationValid,
    configurationProblems,
    rolloutMode: masterEnabled ? "admin_shadow" : "off",
    masterEnabled,
    ingestEnabled,
    projectionsEnabled,
    ambassadorEnabled,
    eventRegistryVersion: ANALYTICS_V2_DEFAULTS.eventRegistryVersion,
    metricDictionaryVersion: ANALYTICS_V2_DEFAULTS.metricDictionaryVersion,
    pseudonymKeyVersion: ANALYTICS_V2_DEFAULTS.pseudonymKeyVersion,
    rawRetentionDays,
    smallSegmentThreshold,
  });
}

export async function createAnalyticsActorPseudonym({
  telegramId,
  secret,
  keyVersion = ANALYTICS_V2_DEFAULTS.pseudonymKeyVersion,
  cryptoImpl = globalThis.crypto,
} = {}) {
  const subject = requiredInteger(telegramId, "Telegram subject");
  const normalizedSecret = requiredString(secret, "analytics pseudonym secret", {
    minimum: 32,
    maximum: 512,
  });
  const version = requiredInteger(keyVersion, "pseudonym key version");
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto is required");
  return hmacHex(
    normalizedSecret,
    `re-analytics:subject:v${version}:${subject}`,
    cryptoImpl,
  );
}

export async function buildCanonicalAnalyticsEvent(input = {}, {
  cryptoImpl = globalThis.crypto,
} = {}) {
  assertExactKeys(input, new Set([
    "eventId",
    "eventName",
    "eventVersion",
    "occurredAt",
    "recordedAt",
    "origin",
    "actorTelegramId",
    "pseudonymSecret",
    "pseudonymKeyVersion",
    "sourceKind",
    "sourceIdentity",
    "dimensions",
    "retentionDays",
    "correction",
  ]), "canonical analytics input");
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto is required");

  const eventId = requiredString(input.eventId, "event id", {
    minimum: 36,
    maximum: 36,
  }).toLowerCase();
  if (!UUID_PATTERN.test(eventId)) throw new TypeError("event id must be a UUIDv4");

  const eventName = requiredString(input.eventName, "event name", {
    maximum: 80,
  }).toLowerCase();
  const eventVersion = requiredInteger(input.eventVersion ?? 1, "event version");
  const definition = EVENT_BY_NAME.get(`${eventName}:${eventVersion}`);
  if (!definition) throw new TypeError("event is absent from analytics registry");

  const occurredAt = requiredInteger(input.occurredAt, "occurred at");
  const recordedAt = requiredInteger(input.recordedAt, "recorded at");
  if (recordedAt < occurredAt) {
    throw new TypeError("recorded at cannot precede occurred at");
  }
  const origin = requiredString(input.origin, "event origin", { maximum: 24 })
    .toLowerCase();
  if (!ORIGINS.has(origin)) throw new TypeError("unsupported analytics origin");

  const sourceKind = requiredString(input.sourceKind, "source kind", {
    maximum: 32,
  }).toLowerCase();
  if (!ANALYTICS_V2_SOURCE_KINDS.includes(sourceKind)) {
    throw new TypeError("unsupported analytics source kind");
  }
  if (AUTHORITY_TO_SOURCE_KIND[definition.authoritySource] !== sourceKind) {
    throw new TypeError("analytics event authority/source mismatch");
  }
  const sourceIdentity = requiredString(input.sourceIdentity, "source identity", {
    maximum: 512,
  });
  const pseudonymSecret = requiredString(
    input.pseudonymSecret,
    "analytics pseudonym secret",
    { minimum: 32, maximum: 512 },
  );
  const pseudonymKeyVersion = requiredInteger(
    input.pseudonymKeyVersion ?? ANALYTICS_V2_DEFAULTS.pseudonymKeyVersion,
    "pseudonym key version",
  );
  const retentionDays = requiredInteger(
    input.retentionDays ?? ANALYTICS_V2_DEFAULTS.rawRetentionDays,
    "retention days",
  );
  if (retentionDays > ANALYTICS_V2_DEFAULTS.rawRetentionDays) {
    throw new TypeError("analytics retention exceeds the approved maximum");
  }
  const dimensions = normalizeDimensions(input.dimensions);
  const correction = normalizeCorrection(eventName, input.correction);
  const actorPseudonym = await createAnalyticsActorPseudonym({
    telegramId: input.actorTelegramId,
    secret: pseudonymSecret,
    keyVersion: pseudonymKeyVersion,
    cryptoImpl,
  });
  const sourceKeyHash = await hmacHex(
    pseudonymSecret,
    `re-analytics:source:v1:${sourceKind}:${sourceIdentity}`,
    cryptoImpl,
  );
  const eventKey = `evt_${await hmacHex(
    pseudonymSecret,
    `re-analytics:event:v1:${eventName}:${eventVersion}:${sourceKind}:${sourceIdentity}`,
    cryptoImpl,
  )}`;
  const correctionOfEventKeyHash = correction.targetEventKey
    ? await sha256Hex(correction.targetEventKey, cryptoImpl)
    : null;
  const replacementEventKeyHash = correction.replacementEventKey
    ? await sha256Hex(correction.replacementEventKey, cryptoImpl)
    : null;
  const payloadHash = await sha256Hex(canonicalJson({
    actorPseudonym,
    correctionKind: correction.kind,
    correctionOfEventKeyHash,
    dimensions,
    eventName,
    eventVersion,
    occurredAt,
    origin,
    privacyClass: definition.privacyClass,
    pseudonymKeyVersion,
    replacementEventKeyHash,
    sourceKeyHash,
    sourceKind,
  }), cryptoImpl);
  const retentionUntil = recordedAt + retentionDays * 86_400;

  const event = Object.freeze({
    event_id: eventId,
    event_key: eventKey,
    event_name: eventName,
    event_version: eventVersion,
    occurred_at: occurredAt,
    recorded_at: recordedAt,
    origin,
    actor_pseudonym: actorPseudonym,
    pseudonym_key_version: pseudonymKeyVersion,
    source_kind: sourceKind,
    source_key_hash: sourceKeyHash,
    payload_hash: payloadHash,
    privacy_class: definition.privacyClass,
    correction_kind: correction.kind,
    correction_of_event_key_hash: correctionOfEventKeyHash,
    replacement_event_key_hash: replacementEventKeyHash,
    retention_until: retentionUntil,
    created_at: recordedAt,
  });
  const dimensionRows = Object.freeze(DIMENSION_NAMES.map((name) =>
    Object.freeze({
      event_id: eventId,
      dimension_name: name,
      dimension_value: dimensions[name],
      created_at: recordedAt,
    })
  ));
  return validateCanonicalAnalyticsStorageRecord({ event, dimensions: dimensionRows });
}

export function validateCanonicalAnalyticsStorageRecord(record) {
  assertExactKeys(record, new Set(["event", "dimensions"]), "analytics storage record");
  const expectedEventKeys = new Set([
    "event_id",
    "event_key",
    "event_name",
    "event_version",
    "occurred_at",
    "recorded_at",
    "origin",
    "actor_pseudonym",
    "pseudonym_key_version",
    "source_kind",
    "source_key_hash",
    "payload_hash",
    "privacy_class",
    "correction_kind",
    "correction_of_event_key_hash",
    "replacement_event_key_hash",
    "retention_until",
    "created_at",
  ]);
  assertExactKeys(record.event, expectedEventKeys, "canonical analytics event");
  if (!UUID_PATTERN.test(record.event.event_id)) throw new TypeError("stored event id is invalid");
  if (!EVENT_KEY_PATTERN.test(record.event.event_key)) throw new TypeError("stored event key is invalid");
  for (const field of ["actor_pseudonym", "source_key_hash", "payload_hash"]) {
    if (!HASH_PATTERN.test(record.event[field])) {
      throw new TypeError(`stored ${field} is invalid`);
    }
  }
  if (!Array.isArray(record.dimensions) || record.dimensions.length !== DIMENSION_NAMES.length) {
    throw new TypeError("stored analytics dimensions are incomplete");
  }
  const seen = new Set();
  for (const row of record.dimensions) {
    assertExactKeys(
      row,
      new Set(["event_id", "dimension_name", "dimension_value", "created_at"]),
      "analytics dimension row",
    );
    if (row.event_id !== record.event.event_id || row.created_at !== record.event.recorded_at) {
      throw new TypeError("analytics dimension/event binding is invalid");
    }
    if (
      seen.has(row.dimension_name) ||
      !ANALYTICS_V2_DIMENSION_VALUES[row.dimension_name]?.includes(row.dimension_value)
    ) {
      throw new TypeError("stored analytics dimension is invalid");
    }
    seen.add(row.dimension_name);
  }
  return Object.freeze({
    event: Object.freeze({ ...record.event }),
    dimensions: Object.freeze(record.dimensions.map((row) => Object.freeze({ ...row }))),
  });
}
