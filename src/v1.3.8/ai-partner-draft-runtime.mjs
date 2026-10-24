import {
  AI_PARTNER_DRAFT_TYPES,
  AI_PARTNER_MODEL_ALIASES,
  AI_PARTNER_POLICY_VERSION,
  AI_PARTNER_PROMPT_VERSION,
  assertAiPartnerOwnerScope,
  isAllowedAiPartnerReadTool,
  normalizeAiPartnerDraftType,
} from "./ai-partner-foundation.mjs";

export const AI_PARTNER_DRAFT_SCHEMA_VERSION = 1;
export const AI_PARTNER_DRAFT_NOTICE_RU =
  "Черновик RE AI: перед отправкой проверьте формулировки и условия.";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const FACT_PATH =
  /^(?:[A-Za-z_][A-Za-z0-9_]{0,63}|[0-9]{1,2})(?:\.(?:[A-Za-z_][A-Za-z0-9_]{0,63}|[0-9]{1,2})){0,7}$/;
const FACT_PLACEHOLDER =
  /\{\{fact:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):((?:[A-Za-z_][A-Za-z0-9_]{0,63}|[0-9]{1,2})(?:\.(?:[A-Za-z_][A-Za-z0-9_]{0,63}|[0-9]{1,2})){0,7})\}\}/g;
const SHA_256 = /^[0-9a-f]{64}$/;
const MODEL_ALIASES = new Set([
  AI_PARTNER_MODEL_ALIASES.safe,
  AI_PARTNER_MODEL_ALIASES.dragon,
  AI_PARTNER_MODEL_ALIASES.humanEdit,
]);
const PLAN_CODES = new Set(["free", "professional", "dragon"]);
const ACCESS_STATES = new Set([
  "none",
  "trial",
  "active",
  "cancel_at_period_end",
  "expired",
  "refunded",
  "suspended",
]);
const MUTATING_TOOL_WORDS = new Set([
  "save",
  "archive",
  "restore",
  "share",
  "send",
  "publish",
  "delete",
  "grant",
  "refund",
  "moderate",
  "write",
  "update",
  "insert",
  "raw_sql",
]);
const MAX_FACT_SOURCES = 32;
const MAX_ALLOWED_OFFERS = 25;
const MAX_APPLICATION_ROWS = 20;
const MAX_PROMPT_CHARS = 4_000;
const MAX_CONTENT_CHARS = 12_000;
const TEXT_ENCODER = new TextEncoder();
const TRUSTED_FACT_BUNDLE = Symbol("trustedAiPartnerFactBundle");

const FORMAT_SCHEMAS = Object.freeze({
  telegram_post: Object.freeze({
    requiredStrings: Object.freeze(["title", "body", "cta"]),
    optionalStringArrays: Object.freeze({ bullets: Object.freeze([0, 8]) }),
  }),
  private_message: Object.freeze({
    requiredStrings: Object.freeze(["greeting", "body", "cta"]),
    optionalStringArrays: Object.freeze({}),
  }),
  short_card: Object.freeze({
    requiredStrings: Object.freeze(["headline", "body", "cta"]),
    optionalStringArrays: Object.freeze({}),
  }),
  promotion_idea: Object.freeze({
    requiredStrings: Object.freeze(["title", "audience", "concept", "cta"]),
    optionalStringArrays: Object.freeze({ steps: Object.freeze([1, 8]) }),
  }),
  short_video_script: Object.freeze({
    requiredStrings: Object.freeze(["hook", "cta"]),
    optionalStringArrays: Object.freeze({}),
    scenes: Object.freeze([1, 8]),
  }),
  offer_explanation: Object.freeze({
    requiredStrings: Object.freeze(["title", "summary", "cta"]),
    optionalStringArrays: Object.freeze({ conditions: Object.freeze([1, 10]) }),
  }),
});

const PROMPT_INJECTION_RULES = Object.freeze([
  Object.freeze({
    code: "prompt_override_instructions",
    pattern:
      /(?:ignore|forget|disregard|override|игнорир[\p{L}\p{M}-]*|забуд[\p{L}\p{M}-]*|отмен[\p{L}\p{M}-]*)[\s\S]{0,80}(?:system|developer|previous|instruction|rule|систем[\p{L}\p{M}-]*|предыдущ[\p{L}\p{M}-]*|инструкц[\p{L}\p{M}-]*|правил[\p{L}\p{M}-]*)/iu,
  }),
  Object.freeze({
    code: "prompt_role_injection",
    pattern: /(?:^|\n)\s*(?:system|developer|assistant|система|разработчик)\s*:/iu,
  }),
  Object.freeze({
    code: "prompt_raw_database",
    pattern:
      /(?:raw[_ -]?sql|\bselect\b[\s\S]{0,80}\bfrom\b|\b(?:drop|alter|pragma)\s+(?:table|database)|сыр\w*\s+sql)/iu,
  }),
  Object.freeze({
    code: "prompt_secret_request",
    pattern:
      /(?:api[_ -]?key|bot[_ -]?token|private[_ -]?key|парол[\p{L}\p{M}-]*|секрет[\p{L}\p{M}-]*|токен[\p{L}\p{M}-]*)/iu,
  }),
  Object.freeze({
    code: "prompt_mutation_request",
    pattern:
      /(?:(?:refund|grant|change|set|выда[\p{L}\p{M}-]*|верн[\p{L}\p{M}-]*|измени[\p{L}\p{M}-]*)[\s\S]{0,45}(?:payment|entitlement|role|admin|access|оплат[\p{L}\p{M}-]*|доступ[\p{L}\p{M}-]*|роль[\p{L}\p{M}-]*|админ[\p{L}\p{M}-]*)|(?:publish|send|post|отправ[\p{L}\p{M}-]*|опублику[\p{L}\p{M}-]*)[\s\S]{0,45}(?:automatically|without confirmation|now|автомат[\p{L}\p{M}-]*|без подтвержден[\p{L}\p{M}-]*|сейчас))/iu,
  }),
]);

const OUTPUT_POLICY_RULES = Object.freeze([
  Object.freeze({
    code: "unsupported_income_guarantee",
    pattern:
      /(?:гарант[\p{L}\p{M}-]*\s+(?:доход|заработ|прибыл)|(?:доход|заработ|прибыл)[\s\S]{0,30}гарант[\p{L}\p{M}-]*|guaranteed\s+(?:income|earnings?|profit)|risk[- ]?free\s+(?:income|profit))/iu,
  }),
  Object.freeze({
    code: "unsupported_compliance_bypass",
    pattern:
      /(?:обойт[\p{L}\p{M}-]*[\s\S]{0,40}(?:модерац|маркировк|рекламн[\p{L}\p{M}-]*\s+правил)|bypass[\s\S]{0,40}(?:moderation|disclosure|advertising rules?))/iu,
  }),
  Object.freeze({
    code: "unsupported_automatic_action",
    pattern:
      /(?:(?:опублику[\p{L}\p{M}-]*|отправ[\p{L}\p{M}-]*)[\s\S]{0,40}(?:автомат[\p{L}\p{M}-]*|без подтвержден[\p{L}\p{M}-]*)|(?:publish|send)[\s\S]{0,40}(?:automatically|without confirmation))/iu,
  }),
]);

function draftError(code, cause) {
  const error = new Error("AI Partner draft operation rejected");
  error.name = "AiPartnerDraftError";
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export function safeAiPartnerDraftErrorCode(
  error,
  fallback = "ai_partner_draft_error",
) {
  return String(error?.code || error?.name || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 80);
}

function requireDatabase(env) {
  if (!env?.DB?.prepare || !env?.DB?.batch) {
    throw draftError("ai_partner_database_not_ready");
  }
  return env.DB;
}

function normalizeTelegramId(value, code = "ai_partner_owner_invalid") {
  const normalized =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw draftError(code);
  }
  return normalized;
}

function requireOwnerScope(actorTelegramId, ownerTelegramId) {
  const actor = normalizeTelegramId(
    actorTelegramId,
    "ai_partner_actor_invalid",
  );
  const owner = normalizeTelegramId(ownerTelegramId);
  try {
    return assertAiPartnerOwnerScope(actor, owner);
  } catch (cause) {
    throw draftError("ai_partner_owner_scope_denied", cause);
  }
}

function normalizeKey(value, { code, minimum = 16, maximum = 96 } = {}) {
  const normalized = String(value || "").trim();
  if (
    normalized.length < minimum ||
    normalized.length > maximum ||
    !SAFE_KEY.test(normalized)
  ) {
    throw draftError(code || "ai_partner_key_invalid");
  }
  return normalized;
}

function normalizeUuid(value, code) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!UUID_V4.test(normalized)) throw draftError(code);
  return normalized;
}

function normalizeClock(value = Math.floor(Date.now() / 1_000)) {
  const normalized = Number(value);
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 1_600_000_000 ||
    normalized > 9_999_999_999
  ) {
    throw draftError("ai_partner_clock_invalid");
  }
  return normalized;
}

function normalizeModelAlias(value) {
  const normalized = String(value || "").trim();
  if (!MODEL_ALIASES.has(normalized)) {
    throw draftError("ai_partner_model_alias_invalid");
  }
  return normalized;
}

function plainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

async function sha256(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw draftError("ai_partner_crypto_unavailable");
  const digest = await cryptoImpl.subtle.digest(
    "SHA-256",
    TEXT_ENCODER.encode(String(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function safeText(value, {
  code = "ai_partner_schema_rejected",
  maximum = 4_000,
  allowEmpty = false,
} = {}) {
  if (typeof value !== "string") throw draftError(code);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if ((!allowEmpty && !normalized) || normalized.length > maximum) {
    throw draftError(code);
  }
  if (
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized) ||
    /<\/?[A-Za-z][^>]*>/u.test(normalized)
  ) {
    throw draftError(code);
  }
  return normalized;
}

function findPromptInjectionRule(text) {
  for (const rule of PROMPT_INJECTION_RULES) {
    if (rule.pattern.test(text)) return rule.code;
  }
  return null;
}

function safeToolText(value, maximum = 160) {
  const normalized = safeText(String(value || ""), { maximum });
  if (findPromptInjectionRule(normalized)) {
    throw draftError("ai_partner_tool_data_unsafe");
  }
  return normalized;
}

function validateFactTree(value, depth = 0) {
  if (depth > 8) throw draftError("ai_partner_fact_json_invalid");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw draftError("ai_partner_fact_json_invalid");
    return value;
  }
  if (typeof value === "string") {
    const normalized = safeText(value, {
      code: "ai_partner_fact_json_invalid",
      maximum: 2_000,
      allowEmpty: true,
    });
    if (findPromptInjectionRule(normalized)) {
      throw draftError("ai_partner_fact_content_unsafe");
    }
    return normalized;
  }
  if (Array.isArray(value)) {
    if (value.length > 32) throw draftError("ai_partner_fact_json_invalid");
    return value.map((item) => validateFactTree(item, depth + 1));
  }
  if (!plainObject(value)) throw draftError("ai_partner_fact_json_invalid");
  const entries = Object.entries(value);
  if (entries.length > 64) throw draftError("ai_partner_fact_json_invalid");
  return Object.fromEntries(entries.map(([key, item]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
      throw draftError("ai_partner_fact_json_invalid");
    }
    return [key, validateFactTree(item, depth + 1)];
  }));
}

export function scanAiPartnerPrompt(value) {
  if (typeof value !== "string") {
    return Object.freeze({ allowed: false, ruleCode: "prompt_not_text" });
  }
  const prompt = value.replace(/\r\n?/g, "\n").trim();
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
    return Object.freeze({ allowed: false, ruleCode: "prompt_size_invalid" });
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(prompt)) {
    return Object.freeze({ allowed: false, ruleCode: "prompt_control_chars" });
  }
  const injectionRule = findPromptInjectionRule(prompt);
  if (injectionRule) {
    return Object.freeze({ allowed: false, ruleCode: injectionRule });
  }
  return Object.freeze({ allowed: true, ruleCode: "prompt_allowed" });
}

export function assertSafeAiPartnerPrompt(value) {
  const decision = scanAiPartnerPrompt(value);
  if (!decision.allowed) throw draftError(decision.ruleCode);
  return safeText(value, { maximum: MAX_PROMPT_CHARS });
}

function normalizeFactIds(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_FACT_SOURCES) {
    throw draftError("ai_partner_fact_ids_invalid");
  }
  const normalized = values.map((value) =>
    normalizeUuid(value, "ai_partner_fact_id_invalid"));
  if (new Set(normalized).size !== normalized.length) {
    throw draftError("ai_partner_fact_ids_duplicate");
  }
  return normalized.sort();
}

function parseFactRows(rows, ownerTelegramId) {
  return rows.map((row) => {
    const id = normalizeUuid(row.fact_source_id, "ai_partner_fact_id_invalid");
    if (
      row.source_status !== "approved" ||
      !["public", "private"].includes(row.visibility) ||
      (row.visibility === "private" &&
        Number(row.owner_telegram_id) !== ownerTelegramId)
    ) {
      throw draftError("ai_partner_fact_source_denied");
    }
    let facts;
    try {
      facts = JSON.parse(String(row.facts_json || ""));
    } catch (cause) {
      throw draftError("ai_partner_fact_json_invalid", cause);
    }
    if (!plainObject(facts)) {
      throw draftError("ai_partner_fact_json_invalid");
    }
    facts = validateFactTree(facts);
    if (canonicalJson(facts).length > 16_000) {
      throw draftError("ai_partner_fact_json_invalid");
    }
    if (!SHA_256.test(String(row.snapshot_hash || ""))) {
      throw draftError("ai_partner_fact_hash_invalid");
    }
    const approvedAt = Number(row.approved_at);
    if (!Number.isSafeInteger(approvedAt) || approvedAt <= 0) {
      throw draftError("ai_partner_fact_approval_invalid");
    }
    return {
      factSourceId: id,
      sourceKey: safeText(row.source_key, { maximum: 160 }),
      visibility: row.visibility,
      subjectType: safeText(row.subject_type, { maximum: 40 }),
      subjectKey: safeText(row.subject_key, { maximum: 160 }),
      sourceKind: safeText(row.source_kind, { maximum: 40 }),
      sourceVersion: safeText(row.source_version, { maximum: 80 }),
      snapshotHash: String(row.snapshot_hash),
      approvedAt,
      facts,
    };
  });
}

export async function loadApprovedAiPartnerFactBundle(
  env,
  {
    actorTelegramId,
    ownerTelegramId,
    factSourceIds,
    generatedAt,
    cryptoImpl = globalThis.crypto,
  } = {},
) {
  const database = requireDatabase(env);
  const owner = requireOwnerScope(actorTelegramId, ownerTelegramId);
  const ids = normalizeFactIds(factSourceIds);
  const placeholders = ids.map(() => "?").join(", ");
  const result = await database.prepare(
    `SELECT fact_source_id, source_key, visibility, owner_telegram_id,
            subject_type, subject_key, source_kind, source_version,
            snapshot_hash, facts_json, source_status, approved_at
     FROM content_fact_sources
     WHERE fact_source_id IN (${placeholders})
       AND source_status = 'approved'
       AND (visibility = 'public' OR owner_telegram_id = ?)
     ORDER BY fact_source_id ASC`,
  ).bind(...ids, owner).all();
  const rows = result?.results || [];
  if (rows.length !== ids.length) {
    throw draftError("ai_partner_fact_source_denied");
  }
  const sources = parseFactRows(rows, owner).sort((left, right) =>
    left.factSourceId.localeCompare(right.factSourceId));
  for (const source of sources) {
    const actualHash = await sha256(canonicalJson(source.facts), cryptoImpl);
    if (actualHash !== source.snapshotHash) {
      throw draftError("ai_partner_fact_snapshot_hash_mismatch");
    }
  }
  const bundleMaterial = sources.map((source) => ({
    factSourceId: source.factSourceId,
    sourceKey: source.sourceKey,
    visibility: source.visibility,
    subjectType: source.subjectType,
    subjectKey: source.subjectKey,
    sourceKind: source.sourceKind,
    sourceVersion: source.sourceVersion,
    snapshotHash: source.snapshotHash,
    approvedAt: source.approvedAt,
    facts: source.facts,
  }));
  const bundle = {
    schemaVersion: AI_PARTNER_DRAFT_SCHEMA_VERSION,
    generatedAt: normalizeClock(generatedAt),
    bundleHash: await sha256(canonicalJson(bundleMaterial), cryptoImpl),
    sources: bundleMaterial,
  };
  Object.defineProperty(bundle, TRUSTED_FACT_BUNDLE, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return deepFreeze(bundle);
}

async function readOwnProfile(database, owner) {
  const row = await database.prepare(
    `SELECT users.joined_at,
            COALESCE(NULLIF(profile.display_name, ''),
                     NULLIF(application.display_name, ''), '') AS display_name,
            COALESCE(profile.status, 'not_partner') AS partner_status,
            COALESCE(application.status, 'not_submitted') AS application_status
     FROM users
     LEFT JOIN partner_applications application
       ON application.telegram_id = users.telegram_id
     LEFT JOIN partner_profiles profile
       ON profile.telegram_id = users.telegram_id
     WHERE users.telegram_id = ?
     LIMIT 1`,
  ).bind(owner).first();
  if (!row) throw draftError("ai_partner_profile_not_found");
  return {
    displayName: safeToolText(row.display_name || "Партнёр", 160),
    partnerStatus: String(row.partner_status || "not_partner"),
    applicationStatus: String(row.application_status || "not_submitted"),
    joinedAt: String(row.joined_at || ""),
  };
}

async function readOwnAccess(database, owner) {
  const row = await database.prepare(
    `SELECT plans.plan_code, states.access_state,
            legacy.access_tier AS legacy_tier,
            legacy.ai_enabled AS legacy_ai_enabled
     FROM users
     LEFT JOIN user_plans plans ON plans.telegram_id = users.telegram_id
     LEFT JOIN user_access_states states
       ON states.telegram_id = users.telegram_id
     LEFT JOIN user_access legacy ON legacy.telegram_id = users.telegram_id
     WHERE users.telegram_id = ?
     LIMIT 1`,
  ).bind(owner).first();
  if (!row) throw draftError("ai_partner_access_not_found");
  const canonicalPlanCode = String(row.plan_code || "").trim().toLowerCase();
  const canonicalAccessState = String(row.access_state || "")
    .trim()
    .toLowerCase();
  const canonicalComplete =
    PLAN_CODES.has(canonicalPlanCode) && ACCESS_STATES.has(canonicalAccessState);
  const legacyTier = String(row.legacy_tier || "free").trim().toLowerCase();
  const legacyFree = !canonicalComplete && legacyTier === "free";
  return {
    planCode: canonicalComplete ? canonicalPlanCode : legacyFree ? "free" : null,
    accessState: canonicalComplete
      ? canonicalAccessState
      : legacyFree
        ? "none"
        : null,
    readPath: canonicalComplete ? "canonical" : legacyFree ? "legacy_free" : "review_required",
    reviewRequired: !canonicalComplete && !legacyFree,
    aiEnabledLegacy: Number(row.legacy_ai_enabled || 0) === 1,
  };
}

async function readOwnApplications(database, owner) {
  const [application, leadResult] = await Promise.all([
    database.prepare(
      `SELECT status, submitted_at, updated_at, reviewed_at
       FROM partner_applications
       WHERE telegram_id = ?
       LIMIT 1`,
    ).bind(owner).first(),
    database.prepare(
      `SELECT offer_code, status, created_at, updated_at, reviewed_at
       FROM lead_requests
       WHERE telegram_id = ?
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    ).bind(owner, MAX_APPLICATION_ROWS).all(),
  ]);
  return {
    partnerApplication: application
      ? {
          status: String(application.status),
          submittedAt: String(application.submitted_at || ""),
          updatedAt: String(application.updated_at || ""),
          reviewedAt: application.reviewed_at
            ? String(application.reviewed_at)
            : null,
        }
      : null,
    leadRequests: (leadResult?.results || []).map((row) => ({
      offerCode: String(row.offer_code || ""),
      status: String(row.status || ""),
      createdAt: String(row.created_at || ""),
      updatedAt: String(row.updated_at || ""),
      reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    })),
  };
}

async function readOwnAllowedOffers(database, owner) {
  const result = await database.prepare(
    `SELECT fact_source_id, subject_type, subject_key, source_version,
            snapshot_hash, approved_at, visibility
     FROM content_fact_sources
     WHERE source_status = 'approved'
       AND subject_type IN ('offer', 'partner_offer')
       AND (visibility = 'public' OR owner_telegram_id = ?)
     ORDER BY approved_at DESC, fact_source_id ASC
     LIMIT ?`,
  ).bind(owner, MAX_ALLOWED_OFFERS).all();
  return {
    offers: (result?.results || []).map((row) => ({
      factSourceId: String(row.fact_source_id),
      subjectType: String(row.subject_type),
      subjectKey: String(row.subject_key),
      sourceVersion: String(row.source_version),
      snapshotHash: String(row.snapshot_hash),
      approvedAt: Number(row.approved_at),
      visibility: String(row.visibility),
    })),
  };
}

async function readOwnExistingAnalytics(database, owner) {
  const [traffic, audience, leads] = await Promise.all([
    database.prepare(
      `SELECT COALESCE(SUM(link_clicks), 0) AS link_clicks,
              COALESCE(SUM(registrations), 0) AS registrations
       FROM partner_stats_daily
       WHERE partner_telegram_id = ?`,
    ).bind(owner).first(),
    database.prepare(
      `SELECT COUNT(*) AS joined_users,
              SUM(CASE WHEN EXISTS (
                SELECT 1 FROM user_activity activity
                WHERE activity.telegram_id = users.telegram_id
                  AND datetime(activity.last_active_at) >= datetime('now', '-30 days')
              ) THEN 1 ELSE 0 END) AS active_users
       FROM users
       WHERE inviter_id = ?`,
    ).bind(owner).first(),
    database.prepare(
      `WITH unified_leads AS (
         SELECT telegram_id, inviter_id, offer_code, status
         FROM lead_requests
         UNION ALL
         SELECT conversion.telegram_id, conversion.inviter_id,
                conversion.offer_code, conversion.status
         FROM conversions conversion
         WHERE NOT EXISTS (
           SELECT 1 FROM lead_requests request
           WHERE request.telegram_id = conversion.telegram_id
             AND request.offer_code = conversion.offer_code
         )
       )
       SELECT COUNT(*) AS applications,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid
       FROM unified_leads
       WHERE inviter_id = ?`,
    ).bind(owner).first(),
  ]);
  return {
    linkClicks: Number(traffic?.link_clicks || 0),
    registrations: Number(traffic?.registrations || 0),
    joinedUsers: Number(audience?.joined_users || 0),
    activeUsers: Number(audience?.active_users || 0),
    applications: Number(leads?.applications || 0),
    pending: Number(leads?.pending || 0),
    confirmed: Number(leads?.confirmed || 0),
    rejected: Number(leads?.rejected || 0),
    paid: Number(leads?.paid || 0),
  };
}

export async function runAiPartnerReadTool(
  env,
  {
    toolName,
    actorTelegramId,
    ownerTelegramId,
    args = {},
    generatedAt,
    cryptoImpl = globalThis.crypto,
  } = {},
) {
  const normalizedTool = String(toolName || "").trim();
  if (!isAllowedAiPartnerReadTool(normalizedTool)) {
    throw draftError("ai_partner_tool_denied");
  }
  if (!plainObject(args)) throw draftError("ai_partner_tool_args_invalid");
  const database = requireDatabase(env);
  const owner = requireOwnerScope(actorTelegramId, ownerTelegramId);
  let data;
  switch (normalizedTool) {
    case "read_own_profile":
      if (Object.keys(args).length) throw draftError("ai_partner_tool_args_invalid");
      data = await readOwnProfile(database, owner);
      break;
    case "read_own_access":
      if (Object.keys(args).length) throw draftError("ai_partner_tool_args_invalid");
      data = await readOwnAccess(database, owner);
      break;
    case "read_own_applications":
      if (Object.keys(args).length) throw draftError("ai_partner_tool_args_invalid");
      data = await readOwnApplications(database, owner);
      break;
    case "read_own_allowed_offers":
      if (Object.keys(args).length) throw draftError("ai_partner_tool_args_invalid");
      data = await readOwnAllowedOffers(database, owner);
      break;
    case "read_own_existing_analytics":
      if (Object.keys(args).length) throw draftError("ai_partner_tool_args_invalid");
      data = await readOwnExistingAnalytics(database, owner);
      break;
    case "read_approved_fact_sources":
      if (
        Object.keys(args).length !== 1 ||
        !Object.hasOwn(args, "factSourceIds")
      ) {
        throw draftError("ai_partner_tool_args_invalid");
      }
      data = await loadApprovedAiPartnerFactBundle(env, {
        actorTelegramId: owner,
        ownerTelegramId: owner,
        factSourceIds: args.factSourceIds,
        generatedAt,
        cryptoImpl,
      });
      break;
    default:
      throw draftError("ai_partner_tool_denied");
  }
  return deepFreeze({ tool: normalizedTool, data });
}

export function isAiPartnerModelToolAllowed(toolName) {
  const normalized = String(toolName || "").trim().toLowerCase();
  if (!normalized || MUTATING_TOOL_WORDS.has(normalized)) return false;
  return isAllowedAiPartnerReadTool(normalized);
}

function assertExactObjectKeys(value, allowedKeys) {
  if (!plainObject(value)) throw draftError("ai_partner_schema_rejected");
  const actual = Object.keys(value).sort();
  const expected = [...allowedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw draftError("ai_partner_schema_rejected");
  }
}

function normalizeStringArray(value, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw draftError("ai_partner_schema_rejected");
  }
  return value.map((item) => safeText(item, { maximum: 800 }));
}

function normalizeDraftTemplate(draftType, output) {
  const type = normalizeAiPartnerDraftType(draftType);
  const schema = FORMAT_SCHEMAS[type];
  if (!plainObject(output) || output.format !== type) {
    throw draftError("ai_partner_schema_rejected");
  }
  const requiredKeys = ["format", ...schema.requiredStrings];
  const optionalArrayEntries = Object.entries(schema.optionalStringArrays);
  for (const [key, [minimum]] of optionalArrayEntries) {
    if (minimum > 0 || Object.hasOwn(output, key)) requiredKeys.push(key);
  }
  if (schema.scenes) requiredKeys.push("scenes");
  assertExactObjectKeys(output, requiredKeys);
  const normalized = { format: type };
  for (const key of schema.requiredStrings) {
    const maximum = ["title", "headline", "greeting", "hook", "audience"].includes(key)
      ? 240
      : key === "cta"
        ? 600
        : 4_000;
    normalized[key] = safeText(output[key], { maximum });
  }
  for (const [key, [minimum, maximum]] of optionalArrayEntries) {
    if (Object.hasOwn(output, key)) {
      normalized[key] = normalizeStringArray(output[key], minimum, maximum);
    }
  }
  if (schema.scenes) {
    const [minimum, maximum] = schema.scenes;
    if (
      !Array.isArray(output.scenes) ||
      output.scenes.length < minimum ||
      output.scenes.length > maximum
    ) {
      throw draftError("ai_partner_schema_rejected");
    }
    normalized.scenes = output.scenes.map((scene) => {
      assertExactObjectKeys(scene, ["visual", "voiceover"]);
      return {
        visual: safeText(scene.visual, { maximum: 800 }),
        voiceover: safeText(scene.voiceover, { maximum: 1_200 }),
      };
    });
  }
  return normalized;
}

function collectStrings(value, target = []) {
  if (typeof value === "string") target.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, target);
  } else if (plainObject(value)) {
    for (const item of Object.values(value)) collectStrings(item, target);
  }
  return target;
}

function collectFactReferences(template) {
  const references = [];
  for (const text of collectStrings(template)) {
    const stripped = text.replace(FACT_PLACEHOLDER, (_match, factSourceId, path) => {
      references.push({ factSourceId, path });
      return "";
    });
    if (/\{\{|\}\}/u.test(stripped)) {
      throw draftError("ai_partner_fact_placeholder_invalid");
    }
    if (/\d/u.test(stripped) || /(?:[$€₽¥£]|\b(?:USD|EUR|RUB|XTR)\b)/iu.test(stripped)) {
      throw draftError("ai_partner_unsupported_claim");
    }
    if (/(?:https?:\/\/|\bt\.me\/|\bwww\.)/iu.test(stripped)) {
      throw draftError("ai_partner_unsupported_link");
    }
  }
  if (!references.length) throw draftError("ai_partner_fact_reference_required");
  return references;
}

function getFactValue(facts, path) {
  if (!FACT_PATH.test(path)) throw draftError("ai_partner_fact_path_invalid");
  let current = facts;
  for (const segment of path.split(".")) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, segment)
    ) {
      throw draftError("ai_partner_fact_path_missing");
    }
    current = current[segment];
  }
  if (!["string", "number", "boolean"].includes(typeof current)) {
    throw draftError("ai_partner_fact_value_not_scalar");
  }
  if (typeof current === "number" && !Number.isFinite(current)) {
    throw draftError("ai_partner_fact_value_invalid");
  }
  return safeText(String(current), { maximum: 500 });
}

function expandFactReferences(template, bundle) {
  const sourceMap = new Map(
    bundle.sources.map((source) => [source.factSourceId, source]),
  );
  const seen = new Map();
  const expand = (value) => {
    if (typeof value === "string") {
      return value.replace(FACT_PLACEHOLDER, (_match, factSourceId, path) => {
        const source = sourceMap.get(factSourceId);
        if (!source) throw draftError("ai_partner_fact_source_denied");
        const renderedValue = getFactValue(source.facts, path);
        seen.set(`${factSourceId}:${path}`, {
          factSourceId,
          path,
          sourceVersion: source.sourceVersion,
          snapshotHash: source.snapshotHash,
          approvedAt: source.approvedAt,
          renderedValue,
        });
        return renderedValue;
      });
    }
    if (Array.isArray(value)) return value.map(expand);
    if (plainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, expand(item)]),
      );
    }
    return value;
  };
  return {
    expanded: expand(template),
    references: [...seen.values()].sort((left, right) =>
      `${left.factSourceId}:${left.path}`.localeCompare(
        `${right.factSourceId}:${right.path}`,
      )),
  };
}

function scanOutputPolicy(template) {
  const text = collectStrings(template).join("\n");
  for (const rule of OUTPUT_POLICY_RULES) {
    if (rule.pattern.test(text)) throw draftError(rule.code);
  }
  const injectionRule = findPromptInjectionRule(text);
  if (injectionRule) throw draftError(injectionRule);
}

function renderDraftContent(type, output) {
  let sections;
  switch (type) {
    case "telegram_post":
      sections = [output.title, output.body];
      if (output.bullets?.length) {
        sections.push(output.bullets.map((item) => `• ${item}`).join("\n"));
      }
      sections.push(output.cta);
      break;
    case "private_message":
      sections = [output.greeting, output.body, output.cta];
      break;
    case "short_card":
      sections = [output.headline, output.body, output.cta];
      break;
    case "promotion_idea":
      sections = [output.title, output.audience, output.concept];
      sections.push(output.steps.map((item) => `• ${item}`).join("\n"));
      sections.push(output.cta);
      break;
    case "short_video_script":
      sections = [output.hook];
      sections.push(
        output.scenes
          .map((scene) => `Кадр: ${scene.visual}\nТекст: ${scene.voiceover}`)
          .join("\n\n"),
      );
      sections.push(output.cta);
      break;
    case "offer_explanation":
      sections = [output.title, output.summary];
      sections.push(output.conditions.map((item) => `• ${item}`).join("\n"));
      sections.push(output.cta);
      break;
    default:
      throw draftError("ai_partner_schema_rejected");
  }
  const content = [...sections, AI_PARTNER_DRAFT_NOTICE_RU]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (!content || content.length > MAX_CONTENT_CHARS) {
    throw draftError("ai_partner_content_size_invalid");
  }
  return content;
}

export function validateAiPartnerModelOutput({
  draftType,
  output,
  factBundle,
} = {}) {
  const type = normalizeAiPartnerDraftType(draftType);
  if (
    !plainObject(factBundle) ||
    factBundle[TRUSTED_FACT_BUNDLE] !== true ||
    factBundle.schemaVersion !== AI_PARTNER_DRAFT_SCHEMA_VERSION ||
    !SHA_256.test(String(factBundle.bundleHash || "")) ||
    !Array.isArray(factBundle.sources)
  ) {
    throw draftError("ai_partner_fact_bundle_invalid");
  }
  const template = normalizeDraftTemplate(type, output);
  scanOutputPolicy(template);
  const requestedReferences = collectFactReferences(template);
  const requestedIds = [...new Set(
    requestedReferences.map((reference) => reference.factSourceId),
  )].sort();
  const bundleIds = factBundle.sources
    .map((source) => source.factSourceId)
    .sort();
  if (
    requestedIds.length !== bundleIds.length ||
    requestedIds.some((id, index) => id !== bundleIds[index])
  ) {
    throw draftError("ai_partner_fact_bundle_scope_mismatch");
  }
  const { expanded, references } = expandFactReferences(template, factBundle);
  scanOutputPolicy(expanded);
  const content = renderDraftContent(type, expanded);
  return deepFreeze({
    content,
    factSourceIds: requestedIds,
    structuredPayload: {
      schemaVersion: AI_PARTNER_DRAFT_SCHEMA_VERSION,
      format: type,
      factBundleHash: factBundle.bundleHash,
      templateFields: template,
      fields: expanded,
      factReferences: references,
      notice: AI_PARTNER_DRAFT_NOTICE_RU,
    },
  });
}

async function loadDraftById(database, draftId) {
  return database.prepare(
    `SELECT draft_id, request_key, owner_telegram_id, draft_type,
            draft_state, title, current_version_no, policy_version,
            created_at, updated_at, deleted_at
     FROM ai_drafts
     WHERE draft_id = ?
     LIMIT 1`,
  ).bind(draftId).first();
}

async function loadDraftByRequestKey(database, requestKey) {
  return database.prepare(
    `SELECT draft_id, request_key, owner_telegram_id, draft_type,
            draft_state, title, current_version_no, policy_version,
            created_at, updated_at, deleted_at
     FROM ai_drafts
     WHERE request_key = ?
     LIMIT 1`,
  ).bind(requestKey).first();
}

async function loadVersionByRequestId(database, requestId) {
  return database.prepare(
    `SELECT version.version_id, version.version_key, version.request_id,
            version.draft_id, version.version_no, version.version_origin,
            version.generation_state, version.content,
            version.structured_payload_json, version.fact_source_ids_json,
            version.warnings_json, version.content_hash,
            version.model_alias, version.prompt_version,
            version.schema_version, version.policy_version,
            version.created_at, draft.owner_telegram_id, draft.draft_type
     FROM ai_draft_versions version
     JOIN ai_drafts draft ON draft.draft_id = version.draft_id
     WHERE version.request_id = ?
     LIMIT 1`,
  ).bind(requestId).first();
}

function freezeStoredVersion(row, replayed) {
  if (!row) throw draftError("ai_partner_version_not_found");
  return deepFreeze({
    draftId: String(row.draft_id),
    versionId: String(row.version_id),
    versionNo: Number(row.version_no),
    requestId: String(row.request_id),
    draftType: String(row.draft_type),
    generationState: String(row.generation_state),
    content: String(row.content),
    structuredPayload: JSON.parse(String(row.structured_payload_json)),
    factSourceIds: JSON.parse(String(row.fact_source_ids_json)),
    contentHash: String(row.content_hash),
    modelAlias: String(row.model_alias),
    createdAt: Number(row.created_at),
    replayed: Boolean(replayed),
  });
}

function storedRequestFingerprint(row) {
  try {
    const payload = JSON.parse(String(row?.structured_payload_json || ""));
    return SHA_256.test(String(payload?.requestFingerprint || ""))
      ? String(payload.requestFingerprint)
      : null;
  } catch {
    return null;
  }
}

function assertDraftOwnerAndType(row, owner, draftType) {
  if (!row) throw draftError("ai_partner_draft_not_found");
  if (Number(row.owner_telegram_id) !== owner) {
    throw draftError("ai_partner_owner_scope_denied");
  }
  if (String(row.draft_type) !== draftType) {
    throw draftError("ai_partner_draft_type_conflict");
  }
  if (row.draft_state !== "draft") {
    throw draftError(
      row.draft_state === "deleted"
        ? "ai_partner_draft_deleted"
        : "ai_partner_draft_archived",
    );
  }
}

function defaultIdFactory() {
  if (!globalThis.crypto?.randomUUID) {
    throw draftError("ai_partner_random_uuid_unavailable");
  }
  return globalThis.crypto.randomUUID();
}

async function maybeRecordPolicyBlock(database, {
  actorTelegramId,
  requestId,
  draftId,
  modelAlias,
  error,
  createdAt,
  idFactory,
  cryptoImpl,
}) {
  const code = safeAiPartnerDraftErrorCode(error);
  const eventType = code.includes("owner_scope")
    ? "owner_scope_denied"
    : code.includes("tool")
      ? "tool_denied"
      : code.includes("fact")
        ? "fact_source_denied"
        : code.includes("unsupported")
          ? "unsupported_claim"
          : code.includes("prompt")
            ? "prompt_injection"
            : "schema_rejected";
  try {
    const eventId = normalizeUuid(
      idFactory(),
      "ai_partner_policy_event_id_invalid",
    );
    const eventHash = await sha256(`${requestId}:${code}`, cryptoImpl);
    await database.prepare(
      `INSERT OR IGNORE INTO ai_policy_events (
         event_id, event_key, request_id, actor_telegram_id, draft_id,
         event_type, decision, rule_code, detail_code, model_alias,
         provider_code, policy_version, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'block', ?, '', ?, 'none', ?, ?)`,
    ).bind(
      eventId,
      `ai-policy:${eventHash.slice(0, 48)}`,
      requestId,
      actorTelegramId,
      draftId || null,
      eventType,
      code,
      MODEL_ALIASES.has(modelAlias) && modelAlias !== AI_PARTNER_MODEL_ALIASES.humanEdit
        ? modelAlias
        : "none",
      AI_PARTNER_POLICY_VERSION,
      createdAt,
    ).run();
  } catch {
    // A policy denial must remain fail-closed even when best-effort telemetry fails.
  }
}

export async function saveAiPartnerDraftVersion(
  env,
  {
    actorTelegramId,
    ownerTelegramId,
    draftId = null,
    requestKey = null,
    requestId,
    draftType,
    title = "",
    output,
    expectedCurrentVersionNo = null,
    modelAlias = AI_PARTNER_MODEL_ALIASES.safe,
    createdAt,
    idFactory = defaultIdFactory,
    cryptoImpl = globalThis.crypto,
  } = {},
) {
  const database = requireDatabase(env);
  const timestamp = normalizeClock(createdAt);
  const normalizedRequestId = normalizeKey(requestId, {
    code: "ai_partner_request_id_invalid",
    minimum: 16,
    maximum: 96,
  });
  const normalizedModelAlias = normalizeModelAlias(modelAlias);
  const expectedVersionNo = expectedCurrentVersionNo === null
    ? null
    : Number(expectedCurrentVersionNo);
  if (
    expectedVersionNo !== null &&
    (!Number.isSafeInteger(expectedVersionNo) || expectedVersionNo < 0)
  ) {
    throw draftError("ai_partner_expected_version_invalid");
  }
  let owner = null;
  let normalizedDraftId = null;
  try {
    owner = requireOwnerScope(actorTelegramId, ownerTelegramId);
    const type = normalizeAiPartnerDraftType(draftType);
    const template = normalizeDraftTemplate(type, output);
    const references = collectFactReferences(template);
    const factSourceIds = [...new Set(
      references.map((reference) => reference.factSourceId),
    )].sort();
    const requestFingerprint = await sha256(canonicalJson({
      schemaVersion: AI_PARTNER_DRAFT_SCHEMA_VERSION,
      draftType: type,
      modelAlias: normalizedModelAlias,
      template,
    }), cryptoImpl);

    const replay = await loadVersionByRequestId(database, normalizedRequestId);
    if (replay) {
      if (
        Number(replay.owner_telegram_id) !== owner ||
        String(replay.draft_type) !== type ||
        replay.model_alias !== normalizedModelAlias ||
        storedRequestFingerprint(replay) !== requestFingerprint
      ) {
        throw draftError("ai_partner_request_replay_conflict");
      }
      return freezeStoredVersion(replay, true);
    }

    const factBundle = await loadApprovedAiPartnerFactBundle(env, {
      actorTelegramId: owner,
      ownerTelegramId: owner,
      factSourceIds,
      generatedAt: timestamp,
      cryptoImpl,
    });
    const validated = validateAiPartnerModelOutput({
      draftType: type,
      output,
      factBundle,
    });
    const structuredPayloadJson = canonicalJson({
      ...validated.structuredPayload,
      requestFingerprint,
    });
    const contentHash = await sha256(validated.content, cryptoImpl);

    let draft;
    let createDraft = false;
    let normalizedRequestKey = null;
    if (draftId) {
      normalizedDraftId = normalizeUuid(
        draftId,
        "ai_partner_draft_id_invalid",
      );
      draft = await loadDraftById(database, normalizedDraftId);
      assertDraftOwnerAndType(draft, owner, type);
      if (
        expectedVersionNo !== null &&
        Number(draft.current_version_no) !== expectedVersionNo
      ) {
        throw draftError("ai_partner_stale_draft_version");
      }
    } else {
      normalizedRequestKey = normalizeKey(requestKey, {
        code: "ai_partner_request_key_invalid",
        minimum: 16,
        maximum: 160,
      });
      draft = await loadDraftByRequestKey(database, normalizedRequestKey);
      if (draft) {
        normalizedDraftId = String(draft.draft_id);
        assertDraftOwnerAndType(draft, owner, type);
        throw draftError("ai_partner_request_key_conflict");
      } else {
        if (expectedVersionNo !== null && expectedVersionNo !== 0) {
          throw draftError("ai_partner_stale_draft_version");
        }
        normalizedDraftId = normalizeUuid(
          idFactory(),
          "ai_partner_draft_id_invalid",
        );
        createDraft = true;
        draft = { current_version_no: 0 };
      }
    }

    const normalizedTitle = safeText(title || "Черновик", {
      maximum: 160,
    });
    const versionNo = Number(draft.current_version_no || 0) + 1;
    if (!Number.isSafeInteger(versionNo) || versionNo < 1) {
      throw draftError("ai_partner_version_sequence_invalid");
    }
    const versionId = normalizeUuid(
      idFactory(),
      "ai_partner_version_id_invalid",
    );
    const versionKey = normalizeKey(
      `draft-version:${normalizedDraftId}:${versionNo}`,
      {
        code: "ai_partner_version_key_invalid",
        minimum: 16,
        maximum: 160,
      },
    );
    const statements = [];
    if (createDraft) {
      statements.push(database.prepare(
        `INSERT INTO ai_drafts (
           draft_id, request_key, owner_telegram_id, draft_type, draft_state,
           title, current_version_no, policy_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'draft', ?, 0, ?, ?, ?)`,
      ).bind(
        normalizedDraftId,
        normalizedRequestKey,
        owner,
        type,
        normalizedTitle,
        AI_PARTNER_POLICY_VERSION,
        timestamp,
        timestamp,
      ));
    }
    statements.push(database.prepare(
      `INSERT INTO ai_draft_versions (
         version_id, version_key, request_id, draft_id, version_no,
         version_origin, generation_state, content, structured_payload_json,
         fact_source_ids_json, warnings_json, content_hash, model_alias,
         prompt_version, schema_version, policy_version, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      versionId,
      versionKey,
      normalizedRequestId,
      normalizedDraftId,
      versionNo,
      normalizedModelAlias === AI_PARTNER_MODEL_ALIASES.humanEdit ? "user" : "ai",
      validated.content,
      structuredPayloadJson,
      JSON.stringify(validated.factSourceIds),
      contentHash,
      normalizedModelAlias,
      AI_PARTNER_PROMPT_VERSION,
      AI_PARTNER_DRAFT_SCHEMA_VERSION,
      AI_PARTNER_POLICY_VERSION,
      timestamp,
    ));

    try {
      await database.batch(statements);
    } catch (cause) {
      const concurrentReplay = await loadVersionByRequestId(
        database,
        normalizedRequestId,
      );
      if (
        concurrentReplay &&
        Number(concurrentReplay.owner_telegram_id) === owner &&
        String(concurrentReplay.draft_type) === type &&
        concurrentReplay.model_alias === normalizedModelAlias &&
        storedRequestFingerprint(concurrentReplay) === requestFingerprint
      ) {
        return freezeStoredVersion(concurrentReplay, true);
      }
      throw draftError("ai_partner_concurrent_write_rejected", cause);
    }
    const stored = await loadVersionByRequestId(database, normalizedRequestId);
    if (!stored || stored.content_hash !== contentHash) {
      throw draftError("ai_partner_write_verification_failed");
    }
    return freezeStoredVersion(stored, false);
  } catch (error) {
    await maybeRecordPolicyBlock(database, {
      actorTelegramId: Number(actorTelegramId) || null,
      requestId: normalizedRequestId,
      draftId: normalizedDraftId,
      modelAlias: normalizedModelAlias,
      error,
      createdAt: timestamp,
      idFactory,
      cryptoImpl,
    });
    throw error;
  }
}

export async function setAiPartnerDraftArchived(
  env,
  {
    actorTelegramId,
    ownerTelegramId,
    draftId,
    archived,
    updatedAt,
  } = {},
) {
  const database = requireDatabase(env);
  const owner = requireOwnerScope(actorTelegramId, ownerTelegramId);
  const normalizedDraftId = normalizeUuid(
    draftId,
    "ai_partner_draft_id_invalid",
  );
  if (typeof archived !== "boolean") {
    throw draftError("ai_partner_archive_action_invalid");
  }
  const timestamp = normalizeClock(updatedAt);
  const fromState = archived ? "draft" : "archived";
  const toState = archived ? "archived" : "draft";
  const result = await database.prepare(
    `UPDATE ai_drafts
     SET draft_state = ?, updated_at = ?
     WHERE draft_id = ? AND owner_telegram_id = ? AND draft_state = ?`,
  ).bind(toState, timestamp, normalizedDraftId, owner, fromState).run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    const existing = await loadDraftById(database, normalizedDraftId);
    if (!existing || Number(existing.owner_telegram_id) !== owner) {
      throw draftError("ai_partner_owner_scope_denied");
    }
    if (existing.draft_state === toState) {
      return deepFreeze({
        draftId: normalizedDraftId,
        draftState: toState,
        replayed: true,
      });
    }
    throw draftError("ai_partner_archive_transition_rejected");
  }
  return deepFreeze({
    draftId: normalizedDraftId,
    draftState: toState,
    replayed: false,
  });
}

export function listAiPartnerDraftFormats() {
  return deepFreeze(
    AI_PARTNER_DRAFT_TYPES.map((draftType) => ({
      draftType,
      schemaVersion: AI_PARTNER_DRAFT_SCHEMA_VERSION,
      schema: FORMAT_SCHEMAS[draftType],
    })),
  );
}
