import {
  createAnalyticsActorPseudonym,
  validateCanonicalAnalyticsStorageRecord,
} from "./analytics-foundation.mjs";

const ENCODER = new TextEncoder();
const HASH = /^[0-9a-f]{64}$/;
const EVENT_KEY = /^evt_[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCOPES = new Set(["actor", "partner", "system"]);
const FIELDS = Object.freeze([
  "event_id", "event_key", "canonical_payload_hash", "context_version",
  "owner_scope_kind", "owner_pseudonym", "correlation_key_hash",
  "offer_key_hash", "context_hash", "recorded_at",
]);

function exactKeys(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new TypeError(`${label} has invalid fields`);
  }
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw new TypeError(`${label} is invalid`);
  }
  return value.trim();
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret, value, cryptoImpl) {
  const key = await cryptoImpl.subtle.importKey(
    "raw", ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return hex(await cryptoImpl.subtle.sign("HMAC", key, ENCODER.encode(value)));
}

async function sha(value, cryptoImpl) {
  return hex(await cryptoImpl.subtle.digest("SHA-256", ENCODER.encode(value)));
}

function canonicalJson(value) {
  return JSON.stringify(Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, value[key]]),
  ));
}

export function validateAnalyticsEventContext(row) {
  exactKeys(row, FIELDS, "analytics event context");
  if (!UUID.test(row.event_id) || !EVENT_KEY.test(row.event_key) ||
      row.context_version !== 1 || !SCOPES.has(row.owner_scope_kind) ||
      !Number.isSafeInteger(row.recorded_at) || row.recorded_at <= 0) {
    throw new TypeError("analytics event context identity is invalid");
  }
  for (const field of [
    "canonical_payload_hash", "correlation_key_hash", "context_hash",
  ]) {
    if (!HASH.test(row[field])) throw new TypeError(`${field} is invalid`);
  }
  if (row.offer_key_hash !== null && !HASH.test(row.offer_key_hash)) {
    throw new TypeError("offer_key_hash is invalid");
  }
  if ((row.owner_scope_kind === "system" && row.owner_pseudonym !== null) ||
      (row.owner_scope_kind !== "system" &&
       !HASH.test(row.owner_pseudonym))) {
    throw new TypeError("analytics owner scope is invalid");
  }
  return Object.freeze({ ...row });
}

// correlationIdentity must be an immutable server-side flow identifier. An
// adapter must not infer it from a display label, URL, Telegram update, or time.
export async function buildAnalyticsEventContext({
  storageRecord,
  actorTelegramId,
  ownerScopeKind,
  ownerTelegramId = null,
  correlationIdentity,
  offerIdentity = null,
  pseudonymSecret,
  cryptoImpl = globalThis.crypto,
} = {}) {
  const { event } = validateCanonicalAnalyticsStorageRecord(storageRecord);
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto is required");
  const secret = requiredText(pseudonymSecret, "analytics pseudonym secret");
  if (secret.length < 32) throw new TypeError("analytics pseudonym secret is too short");
  const expectedActor = await createAnalyticsActorPseudonym({
    telegramId: actorTelegramId,
    secret,
    keyVersion: event.pseudonym_key_version,
    cryptoImpl,
  });
  if (expectedActor !== event.actor_pseudonym) {
    throw new TypeError("event actor does not match the context authority");
  }
  if (!SCOPES.has(ownerScopeKind)) throw new TypeError("owner scope is invalid");
  if ((ownerScopeKind === "system" && event.origin !== "system") ||
      (ownerScopeKind !== "partner" && ownerTelegramId !== null)) {
    throw new TypeError("owner scope does not match event authority");
  }
  if (ownerScopeKind === "partner" &&
      (!Number.isSafeInteger(ownerTelegramId) || ownerTelegramId <= 0)) {
    throw new TypeError("partner owner must come from server authority");
  }

  const ownerPseudonym = ownerScopeKind === "actor"
    ? event.actor_pseudonym
    : ownerScopeKind === "partner"
      ? await createAnalyticsActorPseudonym({
        telegramId: ownerTelegramId,
        secret,
        keyVersion: event.pseudonym_key_version,
        cryptoImpl,
      })
      : null;
  const correlationKeyHash = await hmac(
    secret, `re-analytics:correlation:v1:${requiredText(
      correlationIdentity, "correlation identity")}`,
    cryptoImpl,
  );
  const offerKeyHash = offerIdentity === null ? null : await hmac(
    secret,
    `re-analytics:offer:v1:${requiredText(offerIdentity, "offer identity")}`,
    cryptoImpl,
  );
  const content = {
    event_key: event.event_key,
    canonical_payload_hash: event.payload_hash,
    context_version: 1,
    owner_scope_kind: ownerScopeKind,
    owner_pseudonym: ownerPseudonym,
    correlation_key_hash: correlationKeyHash,
    offer_key_hash: offerKeyHash,
    recorded_at: event.recorded_at,
  };
  const contextHash = await sha(canonicalJson(content), cryptoImpl);
  return validateAnalyticsEventContext({
    event_id: event.event_id,
    ...content,
    context_hash: contextHash,
  });
}

const CONTENT_FIELDS = FIELDS.filter((field) => field !== "event_id");

function sameContext(existing, proposed) {
  return CONTENT_FIELDS.every((field) => existing[field] === proposed[field]);
}

// A repeat may use a new in-memory UUID; event_key resolves the persisted ID.
export function createD1AnalyticsEventContextStore(db) {
  if (!db?.prepare) throw new TypeError("analytics context store requires D1");
  return Object.freeze({
    async attach(row) {
      const proposed = validateAnalyticsEventContext(row);
      const parent = await db.prepare(
        `SELECT event_id, payload_hash, recorded_at
         FROM canonical_analytics_events WHERE event_key = ? LIMIT 1`,
      ).bind(proposed.event_key).first();
      if (!parent || parent.payload_hash !== proposed.canonical_payload_hash ||
          Number(parent.recorded_at) !== proposed.recorded_at) {
        return Object.freeze({ outcome: "conflict" });
      }
      const stored = { ...proposed, event_id: parent.event_id };
      const insert = await db.prepare(
        `INSERT INTO analytics_event_context (
           event_id, event_key, canonical_payload_hash, context_version,
           owner_scope_kind, owner_pseudonym, correlation_key_hash,
           offer_key_hash, context_hash, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      ).bind(...FIELDS.map((field) => stored[field])).run();
      const actual = await db.prepare(
        `SELECT * FROM analytics_event_context WHERE event_id = ? LIMIT 1`,
      ).bind(parent.event_id).first();
      if (!actual || !sameContext(actual, stored)) {
        return Object.freeze({ outcome: "conflict" });
      }
      return Object.freeze({
        outcome: Number(insert?.meta?.changes ?? insert?.changes ?? 0) === 1
          ? "inserted" : "duplicate",
      });
    },
  });
}
