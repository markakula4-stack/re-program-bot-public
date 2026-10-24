import { createAnalyticsActorPseudonym } from "./analytics-foundation.mjs";
import { prepareAnalyticsPrivacyDenial } from "./legacy-backfill.mjs";

const HASH = /^[0-9a-f]{64}$/;
const DATASETS = Object.freeze({
  events: `SELECT event_id AS cursor, event_name, occurred_at, recorded_at,
      source_kind, retention_until FROM canonical_analytics_events
    WHERE actor_pseudonym = ? AND event_id > ?
      AND retention_until > unixepoch()
    ORDER BY event_id LIMIT ?`,
  contexts: `SELECT context.event_id AS cursor, context.owner_scope_kind,
      context.correlation_key_hash, context.offer_key_hash, context.recorded_at
    FROM analytics_event_context context
    JOIN canonical_analytics_events event ON event.event_id = context.event_id
    WHERE event.actor_pseudonym = ? AND context.event_id > ?
      AND event.retention_until > unixepoch()
    ORDER BY context.event_id LIMIT ?`,
  touchpoints: `SELECT touchpoint_id AS cursor, origin, occurred_at, valid_until,
      retention_until FROM analytics_attribution_touchpoints
    WHERE actor_pseudonym = ? AND touchpoint_id > ?
      AND retention_until > unixepoch()
    ORDER BY touchpoint_id LIMIT ?`,
  decisions: `SELECT decision_id AS cursor, attribution_kind, outcome,
      authority_kind, reason_code, occurred_at, decided_at, retention_until
    FROM analytics_attribution_decisions
    WHERE actor_pseudonym = ? AND decision_id > ?
      AND retention_until > unixepoch()
    ORDER BY decision_id LIMIT ?`,
  actor_facts: `SELECT snapshot_id || ':' || metric_date || ':' || event_name
      AS cursor, metric_date, event_name, event_count, retention_until
    FROM analytics_daily_actor_facts
    WHERE actor_pseudonym = ?
      AND (snapshot_id || ':' || metric_date || ':' || event_name) > ?
      AND retention_until > unixepoch()
    ORDER BY cursor LIMIT ?`,
  ambassador_profile: `SELECT ambassador.ambassador_id AS cursor,
      ambassador.status, ambassador.created_at, ambassador.activated_at
    FROM ambassador_profiles_v2 ambassador
    JOIN partner_profiles owner ON owner.id = ambassador.partner_profile_id
    WHERE owner.telegram_id = ? AND ambassador.ambassador_id > ?
    ORDER BY ambassador.ambassador_id LIMIT ?`,
  ambassador_campaigns: `SELECT campaign.campaign_id AS cursor,
      campaign.status, campaign.scope_kind, campaign.program_code,
      campaign.starts_at, campaign.ends_at
    FROM ambassador_campaigns campaign
    JOIN ambassador_profiles_v2 ambassador
      ON ambassador.ambassador_id = campaign.ambassador_id
    JOIN partner_profiles owner ON owner.id = ambassador.partner_profile_id
    WHERE owner.telegram_id = ? AND campaign.campaign_id > ?
    ORDER BY campaign.campaign_id LIMIT ?`,
});

function positive(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

async function pseudonym({ telegramId, secret, keyVersion, cryptoImpl }) {
  return createAnalyticsActorPseudonym({ telegramId,
    secret, keyVersion, cryptoImpl });
}

// Each page is a self export. A partner's aggregate report is in
// owner-analytics.mjs; other people's raw decisions are never exported.
export function createD1AnalyticsSubjectExporter(db, authenticate) {
  if (!db?.prepare || typeof authenticate !== "function") {
    throw new TypeError("D1 and server authentication are required");
  }
  return Object.freeze({
    async readPage({ dataset, after = "", limit = 100,
      pseudonymSecret, keyVersion = 1, cryptoImpl = globalThis.crypto } = {}) {
      if (!Object.hasOwn(DATASETS, dataset) ||
          typeof after !== "string" || after.length > 160 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError("subject export page is invalid");
      }
      const principal = await authenticate();
      if (principal?.verified !== true) {
        throw new Error("subject export session is unverified");
      }
      const actorId = positive(principal.telegramId, "authenticated actor");
      const version = positive(keyVersion, "pseudonym key version");
      const subject = await pseudonym({ telegramId: actorId,
        secret: pseudonymSecret, keyVersion: version, cryptoImpl });
      const ownerDataset = dataset.startsWith("ambassador_");
      const rows = (await db.prepare(DATASETS[dataset])
        .bind(ownerDataset ? actorId : subject, after, limit + 1).all())?.results ?? [];
      if (rows.some((row) => typeof row.cursor !== "string" ||
          row.cursor <= after)) {
        throw new Error("subject export cursor authority is invalid");
      }
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return Object.freeze({ dataset, items: Object.freeze(page.map(({ cursor, ...item }) =>
        Object.freeze({ cursor, ...item }))),
      nextCursor: hasMore ? page.at(-1).cursor : null });
    },
  });
}

async function tokenHash(value, cryptoImpl) {
  const digest = await cryptoImpl.subtle.digest("SHA-256",
    new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

// Supply these statements inside the SAME D1 batch as the already-confirmed
// Worker privacy request and the final users deletion. Caller supplies every
// live and historical pseudonym key version; P05 verifies this inventory.
export async function prepareAnalyticsSubjectDeletion(db, {
  telegramId, requestId, keyVersions, deniedAt,
  cryptoImpl = globalThis.crypto,
} = {}) {
  if (!db?.prepare || !db?.batch ||
      typeof requestId !== "string" || requestId.length < 16 ||
      requestId.length > 128 ||
      !Array.isArray(keyVersions) || keyVersions.length < 1 ||
      keyVersions.length > 8) {
    throw new TypeError("confirmed privacy request and key inventory are required");
  }
  const actorId = positive(telegramId, "deletion subject");
  positive(deniedAt, "deletion time");
  if (Math.abs(Math.floor(Date.now() / 1000) - deniedAt) > 300) {
    throw new RangeError("deletion time is outside current guard window");
  }
  const versions = new Set();
  const identities = [];
  for (const key of keyVersions) {
    const version = positive(key?.keyVersion, "pseudonym key version");
    if (versions.has(version)) throw new Error("duplicate pseudonym key version");
    versions.add(version);
    identities.push({ version, subject: await pseudonym({
      telegramId: actorId, secret: key.secret, keyVersion: version, cryptoImpl,
    }) });
  }
  const pending = await db.prepare(`SELECT request_id FROM privacy_deletion_requests
    WHERE request_id = ? AND telegram_id = ? AND status = 'pending'
      AND unixepoch(expires_at) > unixepoch()
      AND NOT EXISTS (SELECT 1 FROM partner_profiles WHERE telegram_id = ?)
      AND NOT EXISTS (SELECT 1 FROM user_roles WHERE telegram_id = ? AND role='admin' AND status='active')
    LIMIT 1`).bind(requestId, actorId, actorId, actorId).first();
  if (!pending) throw new Error("privacy deletion authority is unavailable");

  const statements = [];
  for (const { version, subject } of identities) {
    if (!HASH.test(subject)) throw new Error("subject pseudonym is invalid");
    const guardToken = await tokenHash(
      `analytics-p04-deletion:${requestId}:${version}:${subject}`, cryptoImpl);
    statements.push(db.prepare(`DELETE FROM analytics_privacy_maintenance_guard
      WHERE id = 1 AND expires_at <= unixepoch()`));
    statements.push(db.prepare(`INSERT INTO analytics_privacy_maintenance_guard
      (id, reason, subject_pseudonym, token_hash, created_by_kind,
        created_at, expires_at)
      VALUES(1, CASE WHEN EXISTS (SELECT 1 FROM privacy_deletion_requests
        WHERE request_id = ? AND telegram_id = ? AND status = 'pending'
          AND unixepoch(expires_at) > unixepoch())
        AND NOT EXISTS (SELECT 1 FROM partner_profiles WHERE telegram_id = ?)
        AND NOT EXISTS (SELECT 1 FROM user_roles WHERE telegram_id = ? AND role='admin' AND status='active')
        THEN 'user_deletion' ELSE 'rejected' END, ?, ?, 'system', unixepoch(), unixepoch() + 300)`)
      .bind(requestId, actorId, actorId, actorId, subject, guardToken));
    statements.push(db.prepare(`INSERT OR IGNORE INTO analytics_privacy_projection_fence
      (id, created_at) SELECT 1, unixepoch()
      WHERE EXISTS (SELECT 1 FROM analytics_privacy_maintenance_guard
        WHERE id = 1 AND reason = 'user_deletion'
          AND subject_pseudonym = ? AND token_hash = ?
          AND expires_at > unixepoch())`).bind(subject, guardToken));
    statements.push(await prepareAnalyticsPrivacyDenial(db, {
      telegramId: actorId, pseudonymSecret: keyVersions.find((k) =>
        k.keyVersion === version).secret, keyVersion: version, deniedAt,
      cryptoImpl }));
    statements.push(db.prepare(`DELETE FROM analytics_projection_snapshot_bindings
      WHERE binding_id IN (SELECT binding.binding_id
        FROM analytics_projection_attribution_bindings binding
        JOIN canonical_analytics_events event ON event.event_id = binding.event_id
        WHERE event.actor_pseudonym = ?)`).bind(subject));
    statements.push(db.prepare(`DELETE FROM analytics_projection_attribution_bindings
      WHERE event_id IN (SELECT event_id FROM canonical_analytics_events
        WHERE actor_pseudonym = ?)`).bind(subject));
    statements.push(db.prepare(`DELETE FROM analytics_attribution_decisions
      WHERE actor_pseudonym = ?`).bind(subject));
    statements.push(db.prepare(`DELETE FROM analytics_attribution_touchpoints
      WHERE actor_pseudonym = ?`).bind(subject));
    statements.push(db.prepare(`DELETE FROM analytics_daily_actor_facts
      WHERE actor_pseudonym = ?`).bind(subject));
    statements.push(db.prepare(`DELETE FROM analytics_event_context
      WHERE owner_pseudonym = ? AND event_id IN (
        SELECT event_id FROM canonical_analytics_events
        WHERE actor_pseudonym != ?)`).bind(subject, subject));
    statements.push(db.prepare(`DELETE FROM canonical_analytics_events
      WHERE actor_pseudonym = ?`).bind(subject));
    statements.push(db.prepare(`DELETE FROM analytics_privacy_maintenance_guard
      WHERE id = 1 AND token_hash = ?`).bind(guardToken));
  }
  return Object.freeze({ statements: Object.freeze(statements),
    pseudonymKeyVersions: Object.freeze([...versions].sort((a, b) => a - b)) });
}
