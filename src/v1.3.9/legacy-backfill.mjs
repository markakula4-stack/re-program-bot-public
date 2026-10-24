import {
  adaptAnalyticsSourceRecord,
} from "./analytics-ingestion.mjs";
import {
  buildAnalyticsEventContext,
  validateAnalyticsEventContext,
} from "./event-context.mjs";
import {
  createAnalyticsActorPseudonym,
  validateCanonicalAnalyticsStorageRecord,
} from "./analytics-foundation.mjs";

// These columns and keys come from initializeOfferSchema/initializePartnerRoutingSchema
// in re-program-bot-worker.js and terms_acceptances in migration 0026.
// No SQL identifiers are supplied by the caller.
const QUERIES = Object.freeze({
  users: `SELECT u.telegram_id, u.joined_at,
    COALESCE(a.first_source_code, 'direct') AS source_code
    FROM users u LEFT JOIN user_attribution a ON a.telegram_id = u.telegram_id
    WHERE u.telegram_id > ? ORDER BY u.telegram_id LIMIT ?`,
  terms: `SELECT t.acceptance_id, t.telegram_id, t.accepted_at
    FROM terms_acceptances t JOIN users u ON u.telegram_id = t.telegram_id
    WHERE t.acceptance_id > ?
    ORDER BY t.acceptance_id LIMIT ?`,
  bot_start: `SELECT s.id, s.telegram_id, s.source_code, s.started_at
    FROM bot_start_events s JOIN users u ON u.telegram_id = s.telegram_id
    WHERE s.id > ? ORDER BY s.id LIMIT ?`,
  legacy_funnel: `SELECT f.telegram_id, f.event_name, f.source_code, f.created_at
    FROM funnel_events f JOIN users u ON u.telegram_id = f.telegram_id
    WHERE f.telegram_id > ? OR (f.telegram_id = ? AND f.event_name > ?)
    ORDER BY f.telegram_id, f.event_name LIMIT ?`,
  lead: `WITH unified AS (
    SELECT l.id AS authority_id, 'lead_requests' AS authority_table,
      l.telegram_id, l.offer_code,
      CASE WHEN c.created_at IS NOT NULL AND
        unixepoch(c.created_at) < unixepoch(l.created_at)
        THEN c.created_at ELSE l.created_at END AS created_at,
      lpa.lead_id AS attribution_lead_id,
      CASE WHEN lpa.lead_id IS NOT NULL AND
        lpa.partner_profile_id = pl.partner_profile_id AND
        lpa.program_code = po.program_code AND
        po.offer_code = l.offer_code AND
        pp.id = lpa.partner_profile_id
        THEN pp.telegram_id ELSE NULL END AS verified_owner_id,
      CASE WHEN o.code IS NOT NULL THEN o.code ELSE NULL END AS verified_offer_code
    FROM lead_requests l
    LEFT JOIN conversions c ON c.telegram_id = l.telegram_id
      AND c.offer_code = l.offer_code
    LEFT JOIN lead_partner_attribution lpa ON lpa.lead_id = l.id
    LEFT JOIN partner_links pl ON pl.id = lpa.partner_link_id
    LEFT JOIN partner_profiles pp ON pp.id = lpa.partner_profile_id
    LEFT JOIN program_offers po ON po.id = pl.catalog_offer_id
    LEFT JOIN offers o ON o.code = l.offer_code
    UNION ALL
    SELECT c.id, 'conversions', c.telegram_id, c.offer_code,
      c.created_at, NULL, NULL,
      CASE WHEN o.code IS NOT NULL THEN o.code ELSE NULL END
    FROM conversions c
    LEFT JOIN offers o ON o.code = c.offer_code
    WHERE NOT EXISTS (
      SELECT 1 FROM lead_requests l
      WHERE l.telegram_id = c.telegram_id AND l.offer_code = c.offer_code
    )
  )
  SELECT u.*, COALESCE(a.first_source_code, 'direct') AS source_code
  FROM unified u
  JOIN users actor ON actor.telegram_id = u.telegram_id
  LEFT JOIN user_attribution a ON a.telegram_id = u.telegram_id
  WHERE u.telegram_id > ? OR (u.telegram_id = ? AND u.offer_code > ?)
  ORDER BY u.telegram_id, u.offer_code LIMIT ?`,
});

const DEFAULT_PROFILE = Object.freeze({
  role: "user", legalProfile: "unknown", plan: "unknown", accessState: "unknown",
});
const ENCODER = new TextEncoder();
const EVENT_COLUMNS = [
  "event_id", "event_key", "event_name", "event_version", "occurred_at",
  "recorded_at", "origin", "actor_pseudonym", "pseudonym_key_version",
  "source_kind", "source_key_hash", "payload_hash", "privacy_class",
  "correction_kind", "correction_of_event_key_hash",
  "replacement_event_key_hash", "retention_until", "created_at",
];
const CONTEXT_COLUMNS = [
  "event_id", "event_key", "canonical_payload_hash", "context_version",
  "owner_scope_kind", "owner_pseudonym", "correlation_key_hash",
  "offer_key_hash", "context_hash", "recorded_at",
];

function integer(value, label, min = 1) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`${label} must be a safe integer >= ${min}`);
  }
  return value;
}

function cursorFor(source, row) {
  if (source === "users") return row.telegram_id;
  if (source === "terms") return row.acceptance_id;
  if (source === "bot_start") return row.id;
  if (source === "legacy_funnel") return [row.telegram_id, row.event_name];
  return [row.telegram_id, row.offer_code];
}

function bindCursor(source, cursor, limit) {
  if (source === "terms") {
    if (typeof cursor !== "string" || cursor.length > 96) throw new TypeError("invalid cursor");
    return [cursor, limit];
  }
  if (source === "users" || source === "bot_start") {
    return [integer(cursor, "cursor", 0), limit];
  }
  if (!Array.isArray(cursor) || cursor.length !== 2 ||
      !Number.isSafeInteger(cursor[0]) || cursor[0] < 0 ||
      typeof cursor[1] !== "string" || cursor[1].length > 128) {
    throw new TypeError("invalid composite cursor");
  }
  return [cursor[0], cursor[0], cursor[1], limit];
}

function sqlTime(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  const iso = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(text)
    ? `${text.replace(" ", "T")}Z` : text;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(iso)) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}

async function fingerprint(secret, value, cryptoImpl) {
  const key = await cryptoImpl.subtle.importKey("raw", ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await cryptoImpl.subtle.sign("HMAC", key,
    ENCODER.encode(JSON.stringify(value)));
  return [...new Uint8Array(signature)].map((byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

function sourceInput(source, row) {
  const telegramId = integer(row.telegram_id, "legacy actor");
  const profile = DEFAULT_PROFILE; // No historical plan/role snapshot exists.
  if (source === "users") return {
    record: { telegramId, joinedAt: row.joined_at,
      sourceCode: row.source_code, profile },
    correlationIdentity: `users:${telegramId}`, offerIdentity: null,
    ownerScopeKind: "actor", ownerTelegramId: null,
  };
  if (source === "terms") return {
    record: { telegramId, acceptanceId: row.acceptance_id,
      acceptedAt: row.accepted_at, sourceCode: "telegram", profile },
    correlationIdentity: `terms:${row.acceptance_id}`, offerIdentity: null,
    ownerScopeKind: "actor", ownerTelegramId: null,
  };
  if (source === "bot_start") return {
    record: { telegramId, startId: String(row.id), startedAt: row.started_at,
      sourceCode: row.source_code, profile },
    correlationIdentity: `bot_start:${row.id}`, offerIdentity: null,
    ownerScopeKind: "actor", ownerTelegramId: null,
  };
  if (source === "legacy_funnel") return {
    record: { telegramId, eventName: row.event_name,
      createdAt: row.created_at, sourceCode: row.source_code, profile },
    correlationIdentity: `funnel:${JSON.stringify([telegramId, row.event_name])}`,
    offerIdentity: null, ownerScopeKind: "actor", ownerTelegramId: null,
  };
  if (row.attribution_lead_id != null &&
      (!Number.isSafeInteger(row.verified_owner_id) || row.verified_owner_id <= 0)) {
    throw new Error("lead attribution has no verified partner authority");
  }
  const naturalKey = JSON.stringify([telegramId, row.offer_code]);
  return {
    record: { telegramId, recordId: naturalKey, recordType: "submitted",
      occurredAt: row.created_at, sourceCode: row.source_code, profile },
    correlationIdentity: `lead:${naturalKey}`,
    offerIdentity: row.verified_offer_code === null ? null
      : `offers:${row.verified_offer_code}`,
    ownerScopeKind: row.attribution_lead_id == null ? "actor" : "partner",
    ownerTelegramId: row.attribution_lead_id == null ? null : row.verified_owner_id,
  };
}

function authorityTime(source, row) {
  return sqlTime(source === "users" ? row.joined_at
    : source === "terms" ? row.accepted_at
    : source === "bot_start" ? row.started_at : row.created_at);
}

async function page(db, { source, cursor, limit }) {
  if (!db?.prepare || !Object.hasOwn(QUERIES, source)) {
    throw new TypeError("unknown legacy source or missing D1");
  }
  const result = await db.prepare(QUERIES[source])
    .bind(...bindCursor(source, cursor, integer(limit, "limit"))).all();
  return result?.results ?? [];
}

// No writes. The digest binds the exact bounded page, cursor, source and time.
async function inspectLegacyPage({
  db, source, cursor = source === "terms" ? "" :
    source === "users" || source === "bot_start" ? 0 : [0, ""],
  limit = 100, highWatermarkAt, pseudonymSecret,
  cryptoImpl = globalThis.crypto,
} = {}) {
  integer(limit, "limit");
  if (limit > 100) throw new RangeError("legacy page must have at most 100 rows");
  const highWatermark = integer(highWatermarkAt, "high watermark");
  if (highWatermark > Math.floor(Date.now() / 1000)) {
    throw new RangeError("legacy high watermark is in the future");
  }
  if (typeof pseudonymSecret !== "string" || pseudonymSecret.length < 32 ||
      !cryptoImpl?.subtle) throw new TypeError("analytics HMAC secret is required");
  const rows = await page(db, { source, cursor, limit });
  const counts = { seen: rows.length, mapped: 0, excluded: 0,
    invalid: 0, outOfWindow: 0 };
  for (const [index, row] of rows.entries()) {
    const occurredAt = authorityTime(source, row);
    if (occurredAt === null) counts.invalid++;
    else if (occurredAt > highWatermark) counts.outOfWindow++;
    else if (source === "legacy_funnel" &&
      !["menu_opened", "offer_opened", "notifications_opened"].includes(row.event_name)) {
      counts.excluded++;
    } else {
      try {
        const input = sourceInput(source, row);
        const adapted = await adaptAnalyticsSourceRecord({
          sourceKind: source, record: input.record,
          eventId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          recordedAt: highWatermark, highWatermarkAt: highWatermark,
          origin: "backfill", pseudonymSecret, cryptoImpl,
        });
        if (adapted.kind !== "event") {
          counts[adapted.classification === "invalid" ? "invalid" : "excluded"]++;
        } else {
          await buildAnalyticsEventContext({
            storageRecord: adapted.storageRecord, actorTelegramId: row.telegram_id,
            ownerScopeKind: input.ownerScopeKind,
            ownerTelegramId: input.ownerTelegramId,
            correlationIdentity: input.correlationIdentity,
            offerIdentity: input.offerIdentity, pseudonymSecret, cryptoImpl,
          });
          counts.mapped++;
        }
      } catch {
        counts.invalid++;
      }
    }
  }
  const nextCursor = rows.length ? cursorFor(source, rows.at(-1)) : cursor;
  const digest = await fingerprint(pseudonymSecret,
    ["v1.3.9-p02", source, cursor, limit, highWatermark, rows], cryptoImpl);
  return {
    preview: Object.freeze({ source, cursor, nextCursor, limit,
      highWatermarkAt: highWatermark, digest, counts: Object.freeze(counts) }),
    rows,
  };
}

export async function previewLegacyBackfill(options) {
  return (await inspectLegacyPage(options)).preview;
}

function equivalentContext(actual, proposed, eventId) {
  // recorded_at/context_hash belong to the first accepted backfill window.
  // A later window must reuse that event without changing immutable context.
  return actual && CONTEXT_COLUMNS.filter((field) =>
    field !== "recorded_at" && field !== "context_hash").every((field) =>
    actual[field] === (field === "event_id" ? eventId : proposed[field]));
}

// D1 batch is transactional: event, all dimensions, and context succeed or
// roll back together. Callers cannot separately commit a naked new event.
export function createD1LegacyContextStore(db) {
  if (!db?.prepare || !db?.batch) throw new TypeError("D1 batch is required");
  return Object.freeze({
    async write(storageRecord, contextRow) {
      const { event, dimensions } = validateCanonicalAnalyticsStorageRecord(storageRecord);
      const context = validateAnalyticsEventContext(contextRow);
      if (event.event_id !== context.event_id ||
          event.event_key !== context.event_key ||
          event.payload_hash !== context.canonical_payload_hash) {
        throw new TypeError("event/context mismatch");
      }
      const denied = await db.prepare(`SELECT 1 FROM analytics_privacy_denials
        WHERE subject_pseudonym IN (?, ?) LIMIT 1`)
        .bind(event.actor_pseudonym, context.owner_pseudonym).first();
      if (denied) throw new Error("analytics subject was deleted");
      const existing = await db.prepare(
        "SELECT event_id, payload_hash FROM canonical_analytics_events WHERE event_key = ?",
      ).bind(event.event_key).first();
      if (existing) {
        const actual = await db.prepare(
          "SELECT * FROM analytics_event_context WHERE event_id = ?",
        ).bind(existing.event_id).first();
        if (existing.payload_hash !== event.payload_hash ||
            !equivalentContext(actual, context, existing.event_id)) {
          return "conflict";
        }
        const found = await db.prepare(
          "SELECT dimension_name, dimension_value FROM analytics_event_dimensions WHERE event_id = ? ORDER BY dimension_name",
        ).bind(existing.event_id).all();
        const expected = dimensions.map((d) =>
          [d.dimension_name, d.dimension_value].join(":" )).sort();
        if (JSON.stringify((found?.results ?? []).map((d) =>
          [d.dimension_name, d.dimension_value].join(":" )).sort()) !== JSON.stringify(expected)) {
          return "conflict";
        }
        return "duplicate";
      }
      const statements = [db.prepare(`INSERT INTO canonical_analytics_events
        (${EVENT_COLUMNS.join(", ")}) VALUES (${EVENT_COLUMNS.map(() => "?").join(", ")})
        ON CONFLICT(event_key) DO NOTHING`).bind(...EVENT_COLUMNS.map((key) => event[key]))];
      for (const dimension of dimensions) {
        statements.push(db.prepare(`INSERT INTO analytics_event_dimensions
          (event_id, dimension_name, dimension_value, created_at)
          VALUES (?, ?, ?, ?)`).bind(dimension.event_id, dimension.dimension_name,
          dimension.dimension_value, dimension.created_at));
      }
      statements.push(db.prepare(`INSERT INTO analytics_event_context
        (${CONTEXT_COLUMNS.join(", ")})
        VALUES (${CONTEXT_COLUMNS.map(() => "?").join(", ")})`)
        .bind(...CONTEXT_COLUMNS.map((key) => context[key])));
      const results = await db.batch(statements);
      if (Number(results?.[0]?.meta?.changes ?? results?.[0]?.changes) !== 1) {
        throw new Error("analytics event collision; transactional insert aborted");
      }
      return "inserted";
    },
  });
}

// Append this statement to the same D1 batch as the guarded user deletion.
// The maintenance guard must be installed earlier in that batch. P05 wires
// the existing Worker deletion path after reviewing key-version history.
export async function prepareAnalyticsPrivacyDenial(db, {
  telegramId, pseudonymSecret, keyVersion = 1, deniedAt,
  cryptoImpl = globalThis.crypto,
} = {}) {
  if (!db?.prepare) throw new TypeError("D1 prepare is required");
  integer(deniedAt, "denial time");
  const subject = await createAnalyticsActorPseudonym({
    telegramId: integer(telegramId, "deletion subject"),
    secret: pseudonymSecret, keyVersion: integer(keyVersion, "key version"),
    cryptoImpl,
  });
  return db.prepare(`INSERT OR IGNORE INTO analytics_privacy_denials
    (subject_pseudonym, pseudonym_key_version, denied_at) VALUES (?, ?, ?)`)
    .bind(subject, keyVersion, deniedAt);
}

// The caller must first show a preview with this exact digest. Re-read and
// verify the page before writes; a changed source requires a new preview.
export async function applyLegacyBackfill({
  db, preview, expectedDigest, pseudonymSecret, config,
  cryptoImpl = globalThis.crypto,
  idFactory = () => cryptoImpl.randomUUID(),
} = {}) {
  if (config?.configurationValid !== true || config.rolloutMode !== "admin_shadow" ||
      config.masterEnabled !== true || config.ingestEnabled !== true) {
    throw new Error("analytics ingestion is closed");
  }
  if (!preview || expectedDigest !== preview.digest) {
    throw new Error("dry run digest is required");
  }
  const { preview: fresh, rows } = await inspectLegacyPage({ db, source: preview.source,
    cursor: preview.cursor, limit: preview.limit,
    highWatermarkAt: preview.highWatermarkAt, pseudonymSecret, cryptoImpl });
  if (fresh.digest !== expectedDigest) throw new Error("legacy page changed since dry run");
  const store = createD1LegacyContextStore(db);
  const counts = { ...fresh.counts, inserted: 0, duplicate: 0, conflict: 0 };
  for (const row of rows) {
    const occurredAt = authorityTime(fresh.source, row);
    if (occurredAt === null || occurredAt > fresh.highWatermarkAt ||
        (fresh.source === "legacy_funnel" &&
          !["menu_opened", "offer_opened", "notifications_opened"].includes(row.event_name))) continue;
    let input;
    try {
      input = sourceInput(fresh.source, row);
    } catch {
      continue; // The dry run already counted this as invalid.
    }
    const adapted = await adaptAnalyticsSourceRecord({
      sourceKind: fresh.source, record: input.record,
      eventId: idFactory(), recordedAt: fresh.highWatermarkAt,
      highWatermarkAt: fresh.highWatermarkAt, origin: "backfill",
      pseudonymSecret, cryptoImpl,
    });
    if (adapted.kind !== "event") continue;
    let context;
    try {
      context = await buildAnalyticsEventContext({
        storageRecord: adapted.storageRecord, actorTelegramId: row.telegram_id,
        ownerScopeKind: input.ownerScopeKind,
        ownerTelegramId: input.ownerTelegramId,
        correlationIdentity: input.correlationIdentity,
        offerIdentity: input.offerIdentity, pseudonymSecret, cryptoImpl,
      });
    } catch {
      continue; // The dry run already counted invalid context authority.
    }
    const outcome = await store.write(adapted.storageRecord, context);
    counts[outcome]++;
  }
  if (counts.inserted + counts.duplicate + counts.conflict !== counts.mapped) {
    throw new Error("legacy backfill count mismatch");
  }
  return Object.freeze({ source: fresh.source, digest: fresh.digest,
    nextCursor: fresh.nextCursor, counts: Object.freeze(counts) });
}
