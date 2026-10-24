// Owner memory data boundary. No Worker imports this module until the later
// policy, Telegram UX and persistent owner-only rollout parts are accepted.
export const AI_PARTNER_OWNER_MEMORY_CONSENT_VERSION =
  "2026-09-23.owner-memory-opt-in-v1";

const MAX_EXCHANGES = 5;
const RETENTION_SECONDS = 30 * 24 * 60 * 60;
const BLOCKED_SUMMARY_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\b(?:sk|ds)-[A-Za-z0-9_-]{20,}\b/u,
  /\bbot\d{6,}:[A-Za-z0-9_-]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}\b/iu,
  /(?:https?:\/\/|www\.|t\.me\/|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b)/iu,
  /(?:^|\s)@[A-Za-z0-9_]{5,}\b/u,
  /(?:\+?\d[\d\s()\-]{8,}\d)/u,
  /[\u0000-\u001f\u007f]/u,
]);

function memoryError(code) {
  const error = new Error("AI Partner owner memory operation rejected");
  error.name = "AiPartnerOwnerMemoryError";
  error.code = code;
  return error;
}

function inputShape(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw memoryError("memory_input_invalid");
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw memoryError("memory_input_field_denied");
  }
  return input;
}

function ownerContext(env, actorTelegramId) {
  const actor = Number(actorTelegramId);
  const owner = Number(env?.ADMIN_ID);
  if (
    !Number.isSafeInteger(actor) || actor <= 0 ||
    !Number.isSafeInteger(owner) || owner <= 0 ||
    actor !== owner
  ) {
    throw memoryError("memory_owner_only");
  }
  if (!env?.DB?.prepare || !env?.DB?.batch) {
    throw memoryError("memory_database_not_ready");
  }
  return { owner, db: env.DB };
}

function requireFeature(env) {
  if (env?.AI_PARTNER_OWNER_MEMORY_ENABLED !== "true") {
    throw memoryError("memory_feature_disabled");
  }
}

function timestamp(value) {
  const at = value === undefined ? Math.floor(Date.now() / 1_000) : value;
  if (!Number.isSafeInteger(at) || at < 1_600_000_000 || at > 9_999_999_999) {
    throw memoryError("memory_clock_invalid");
  }
  return at;
}

function summary(value) {
  if (typeof value !== "string" || value !== value.trim() ||
    value.length < 1 || value.length > 800 ||
    BLOCKED_SUMMARY_PATTERNS.some((pattern) => pattern.test(value))) {
    throw memoryError("memory_summary_rejected");
  }
  return value;
}

function exchangeKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9:_-]{16,160}$/.test(value)) {
    throw memoryError("memory_exchange_key_invalid");
  }
  return value;
}

function uuid() {
  if (!globalThis.crypto?.randomUUID) throw memoryError("memory_crypto_not_ready");
  return globalThis.crypto.randomUUID();
}

async function currentSettings(db, owner) {
  return db.prepare(
    `SELECT enabled, revision, updated_at
     FROM ai_partner_memory_settings WHERE owner_telegram_id = ?`,
  ).bind(owner).first();
}

export async function readOwnerMemoryState(env, input) {
  inputShape(input, ["actorTelegramId", "at"]);
  const { owner, db } = ownerContext(env, input.actorTelegramId);
  const at = timestamp(input.at);
  const settings = await currentSettings(db, owner);
  const enabled = Number(settings?.enabled || 0) === 1;
  const count = enabled
    ? await db.prepare(
      `SELECT COUNT(*) AS total FROM ai_partner_memory_exchanges
       WHERE owner_telegram_id = ? AND consent_revision = ?
         AND expires_at > ?`,
    ).bind(owner, Number(settings.revision), at).first()
    : null;
  return Object.freeze({
    enabled,
    available: env?.AI_PARTNER_OWNER_MEMORY_ENABLED === "true",
    revision: settings ? Number(settings.revision) : 0,
    exchanges: Number(count?.total || 0),
    limit: MAX_EXCHANGES,
  });
}

export async function setOwnerMemoryConsent(env, input) {
  inputShape(input, ["actorTelegramId", "enabled", "at"]);
  const { owner, db } = ownerContext(env, input.actorTelegramId);
  const at = timestamp(input.at);
  if (typeof input.enabled !== "boolean") throw memoryError("memory_consent_invalid");
  if (input.enabled) requireFeature(env);
  const before = await currentSettings(db, owner);
  if (before && at < Number(before.updated_at)) {
    throw memoryError("memory_clock_stale");
  }
  if ((!before && !input.enabled) || Number(before?.enabled || 0) === Number(input.enabled)) {
    return readOwnerMemoryState(env, { actorTelegramId: owner, at });
  }
  const revision = before ? Number(before.revision) + 1 : 1;
  const change = before
    ? db.prepare(
      `UPDATE ai_partner_memory_settings
       SET enabled = ?, revision = ?, enabled_at = ?, disabled_at = ?,
           consent_version = ?, updated_at = ?
       WHERE owner_telegram_id = ? AND revision = ? AND enabled = ?`,
    ).bind(
      Number(input.enabled), revision, input.enabled ? at : null,
      input.enabled ? null : at, AI_PARTNER_OWNER_MEMORY_CONSENT_VERSION,
      at, owner, Number(before.revision), Number(before.enabled),
    )
    : db.prepare(
      `INSERT INTO ai_partner_memory_settings (
         owner_telegram_id, enabled, consent_version, revision,
         enabled_at, disabled_at, updated_at
       ) VALUES (?, 1, ?, 1, ?, NULL, ?)`,
    ).bind(owner, AI_PARTNER_OWNER_MEMORY_CONSENT_VERSION, at, at);
  const [changed] = await db.batch([
    change,
    db.prepare(
      `INSERT INTO ai_partner_memory_events (
         event_id, owner_telegram_id, event_type, consent_revision, occurred_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(uuid(), owner, input.enabled ? "grant" : "revoke", revision, at),
    db.prepare(
      `DELETE FROM ai_partner_memory_exchanges
       WHERE owner_telegram_id = ? AND consent_revision < ?`,
    ).bind(owner, revision),
  ]);
  if (Number(changed?.meta?.changes) !== 1) {
    throw memoryError("memory_consent_conflict");
  }
  return readOwnerMemoryState(env, { actorTelegramId: owner, at });
}

export async function listOwnerMemoryExchanges(env, input) {
  inputShape(input, ["actorTelegramId", "at"]);
  const { owner, db } = ownerContext(env, input.actorTelegramId);
  const at = timestamp(input.at);
  const result = await db.prepare(
    `SELECT exchange_id, user_summary, assistant_summary, created_at, expires_at
     FROM ai_partner_memory_exchanges
     WHERE owner_telegram_id = ? AND expires_at > ?
       AND consent_revision = (
         SELECT revision FROM ai_partner_memory_settings
         WHERE owner_telegram_id = ? AND enabled = 1
       )
     ORDER BY created_at DESC, exchange_id DESC LIMIT 5`,
  ).bind(owner, at, owner).all();
  return Object.freeze((result?.results || []).map((row) => Object.freeze({
    exchangeId: String(row.exchange_id),
    userSummary: String(row.user_summary),
    assistantSummary: String(row.assistant_summary),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  })));
}

export async function recordOwnerMemoryExchange(env, input) {
  inputShape(input, [
    "actorTelegramId", "exchangeKey", "userSummary", "assistantSummary", "at",
  ]);
  const { owner, db } = ownerContext(env, input.actorTelegramId);
  requireFeature(env);
  const at = timestamp(input.at);
  const key = exchangeKey(input.exchangeKey);
  const user = summary(input.userSummary);
  const assistant = summary(input.assistantSummary);
  const settings = await currentSettings(db, owner);
  if (Number(settings?.enabled || 0) !== 1 || at < Number(settings.updated_at)) {
    throw memoryError("memory_opt_in_required");
  }
  const existing = await db.prepare(
    `SELECT owner_telegram_id, consent_revision, user_summary, assistant_summary,
            exchange_id, expires_at
     FROM ai_partner_memory_exchanges WHERE exchange_key = ?`,
  ).bind(key).first();
  if (existing) {
    if (Number(existing.owner_telegram_id) !== owner ||
      Number(existing.consent_revision) !== Number(settings.revision) ||
      existing.user_summary !== user || existing.assistant_summary !== assistant ||
      Number(existing.expires_at) <= at) {
      throw memoryError("memory_exchange_key_conflict");
    }
    return Object.freeze({ exchangeId: String(existing.exchange_id), replayed: true });
  }
  const exchangeId = uuid();
  await db.batch([
    db.prepare(
      `DELETE FROM ai_partner_memory_exchanges
       WHERE owner_telegram_id = ? AND
         (expires_at <= ? OR consent_revision != ?)`,
    ).bind(owner, at, Number(settings.revision)),
    db.prepare(
      `DELETE FROM ai_partner_memory_exchanges WHERE exchange_id IN (
         SELECT exchange_id FROM ai_partner_memory_exchanges
         WHERE owner_telegram_id = ? AND consent_revision = ?
         ORDER BY created_at DESC, exchange_id DESC LIMIT -1 OFFSET 4
       )`,
    ).bind(owner, Number(settings.revision)),
    db.prepare(
      `INSERT INTO ai_partner_memory_exchanges (
         exchange_id, exchange_key, owner_telegram_id, consent_revision,
         user_summary, assistant_summary, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      exchangeId, key, owner, Number(settings.revision), user, assistant,
      at, at + RETENTION_SECONDS,
    ),
  ]);
  return Object.freeze({ exchangeId, replayed: false });
}

export async function clearOwnerMemoryExchanges(env, input) {
  inputShape(input, ["actorTelegramId", "at"]);
  const { owner, db } = ownerContext(env, input.actorTelegramId);
  const at = timestamp(input.at);
  const before = await currentSettings(db, owner);
  if (!before || Number(before.enabled) !== 1) {
    // Revoking consent already purges old exchanges; deleting remains available
    // even when the feature flag has since been switched off.
    const result = await db.prepare(
      `DELETE FROM ai_partner_memory_exchanges WHERE owner_telegram_id = ?`,
    ).bind(owner).run();
    return Object.freeze({ removed: Number(result?.meta?.changes || 0) });
  }
  if (at < Number(before.updated_at)) throw memoryError("memory_clock_stale");
  const revision = Number(before.revision) + 1;
  const [changed, , deleted] = await db.batch([
    db.prepare(
      `UPDATE ai_partner_memory_settings
       SET revision = ?, updated_at = ?
       WHERE owner_telegram_id = ? AND revision = ? AND enabled = 1`,
    ).bind(revision, at, owner, Number(before.revision)),
    db.prepare(
      `INSERT INTO ai_partner_memory_events (
         event_id, owner_telegram_id, event_type, consent_revision, occurred_at
       ) VALUES (?, ?, 'clear', ?, ?)`,
    ).bind(uuid(), owner, revision, at),
    db.prepare(
      `DELETE FROM ai_partner_memory_exchanges
       WHERE owner_telegram_id = ? AND consent_revision < ?`,
    ).bind(owner, revision),
  ]);
  if (Number(changed?.meta?.changes) !== 1) {
    throw memoryError("memory_clear_conflict");
  }
  return Object.freeze({ removed: Number(deleted?.meta?.changes || 0) });
}
