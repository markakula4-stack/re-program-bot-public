import {
  AI_PARTNER_LIMITS,
  AI_PARTNER_MODEL_ALIASES,
  AI_PARTNER_POLICY_VERSION,
  readAiPartnerConfig,
} from "./ai-partner-foundation.mjs";
import {
  AI_PARTNER_OWNER_WORKER_SCHEMA,
  getAiPartnerOwnerWorkerDecision,
} from "./ai-partner-owner-worker-runtime-part5.mjs";

export const AI_PARTNER_OWNER_CANARY_PROBE_VERSION =
  "2026-09-19.owner-controlled-deploy-part5-step4";
export const AI_PARTNER_OWNER_CANARY_PATH =
  "/health/ai-partner-owner-part5";
export const AI_PARTNER_OWNER_CANARY_SIGNATURE_HEADER =
  "X-AI-Partner-Owner-Signature";
export const AI_PARTNER_OWNER_CANARY_TIMESTAMP_HEADER =
  "X-AI-Partner-Owner-Timestamp";
export const AI_PARTNER_OWNER_CANARY_MAX_SKEW_SECONDS = 60;

const TEXT_ENCODER = new TextEncoder();
const SAFE_SIGNATURE = /^[0-9a-f]{64}$/;
const TEN_DIGIT_EPOCH = /^\d{10}$/;
const REQUIRED_PRESERVED_FLAGS = Object.freeze({
  STARS_PAYMENTS_ENABLED: "true",
  STARS_REFUNDS_ENABLED: "true",
  STARS_RECONCILIATION_ENABLED: "true",
  STARS_ROLLOUT_MODE: "admin",
  REFERRAL_REWARDS_ENABLED: "true",
  REFERRAL_REWARD_CANDIDATES_ENABLED: "true",
  REFERRAL_REWARD_CONFIRMATIONS_ENABLED: "true",
  REFERRAL_BONUS_GRANTS_ENABLED: "true",
  REFERRAL_REWARD_ROLLOUT_MODE: "admin",
  ADMIN_MODERATION_ENABLED: "true",
  ADMIN_AI_CHAT_ENABLED: "true",
  ADMIN_DEEPSEEK_CHAT_ENABLED: "true",
});

function flag(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function positiveTelegramId(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeClock(value = Math.floor(Date.now() / 1_000)) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1_600_000_000 ||
    parsed > 9_999_999_999
  ) {
    throw new Error("ai_partner_owner_probe_clock_invalid");
  }
  return parsed;
}

function secretReady(value, minimum = 32) {
  return typeof value === "string" && value.trim().length >= minimum;
}

function bytesToHex(bytes) {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(value) {
  if (!SAFE_SIGNATURE.test(String(value || ""))) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function constantTimeEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

async function hmacSha256(secret, value, cryptoImpl = globalThis.crypto) {
  if (!secretReady(secret)) {
    throw new Error("ai_partner_owner_probe_secret_invalid");
  }
  if (!cryptoImpl?.subtle) {
    throw new Error("ai_partner_owner_probe_crypto_unavailable");
  }
  const key = await cryptoImpl.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await cryptoImpl.subtle.sign(
    "HMAC",
    key,
    TEXT_ENCODER.encode(value),
  );
  return new Uint8Array(signature);
}

export async function signAiPartnerOwnerCanaryRequest({
  timestamp,
  secret,
  cryptoImpl = globalThis.crypto,
} = {}) {
  const timestampText = String(timestamp ?? "").trim();
  if (!TEN_DIGIT_EPOCH.test(timestampText)) {
    throw new Error("ai_partner_owner_probe_timestamp_invalid");
  }
  const payload = [
    "ai-partner-owner-part5-probe:v1",
    "GET",
    AI_PARTNER_OWNER_CANARY_PATH,
    timestampText,
  ].join("\n");
  return bytesToHex(await hmacSha256(secret, payload, cryptoImpl));
}

async function requestAuthorized(
  request,
  env,
  {
    at = Math.floor(Date.now() / 1_000),
    cryptoImpl = globalThis.crypto,
  } = {},
) {
  const timestampText = String(
    request.headers.get(AI_PARTNER_OWNER_CANARY_TIMESTAMP_HEADER) || "",
  ).trim();
  if (!TEN_DIGIT_EPOCH.test(timestampText)) return false;
  const timestamp = Number(timestampText);
  const now = normalizeClock(at);
  if (Math.abs(now - timestamp) > AI_PARTNER_OWNER_CANARY_MAX_SKEW_SECONDS) {
    return false;
  }
  const actual = hexToBytes(
    String(
      request.headers.get(AI_PARTNER_OWNER_CANARY_SIGNATURE_HEADER) || "",
    ).trim().toLowerCase(),
  );
  if (!actual) return false;
  let expected;
  try {
    expected = hexToBytes(await signAiPartnerOwnerCanaryRequest({
      timestamp,
      secret: env?.AI_PARTNER_CANARY_PROBE_SECRET,
      cryptoImpl,
    }));
  } catch {
    return false;
  }
  return constantTimeEqual(actual, expected);
}

function noStoreHeaders() {
  return {
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
}

function concealed() {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function requireDatabase(env) {
  if (!env?.DB?.prepare) {
    throw new Error("ai_partner_owner_probe_database_not_ready");
  }
  return env.DB;
}

async function readSchemaState(database) {
  const tableNames = Object.freeze([
    "ai_partner_runtime_settings",
    "content_fact_sources",
    "ai_drafts",
    "ai_draft_versions",
    "ai_policy_events",
    "ai_generation_sessions",
    "ai_generation_actions",
    "ai_share_intents",
    "ai_gateway_budget_reservations",
    "ai_gateway_attempts",
    "ai_gateway_usage_metadata",
    "ai_gateway_daily_aggregates",
    "ai_gateway_policy_daily_aggregates",
    "ai_generation_provider_evidence",
  ]);
  const reusedNames = Object.freeze([
    "ai_user_consents",
    "ai_usage_events",
    "ai_quota_reservations",
    "ai_conversation_messages",
  ]);
  const tablePlaceholders = tableNames.map(() => "?").join(",");
  const reusedPlaceholders = reusedNames.map(() => "?").join(",");
  const row = await database.prepare(
    `SELECT
       (SELECT COUNT(*) FROM sqlite_schema
          WHERE type = 'table' AND name IN (${tablePlaceholders}))
         AS schema_tables,
       (SELECT COUNT(*) FROM sqlite_schema
          WHERE type = 'index'
            AND name NOT LIKE 'sqlite_autoindex_%'
            AND tbl_name IN (${tablePlaceholders}))
         AS schema_indexes,
       (SELECT COUNT(*) FROM sqlite_schema
          WHERE type = 'trigger'
            AND (
              tbl_name IN (${tablePlaceholders})
              OR name LIKE 'trg_content_fact_sources_%'
            ))
         AS schema_triggers,
       (SELECT COUNT(*) FROM sqlite_schema
          WHERE type = 'table' AND name IN (${reusedPlaceholders}))
         AS reused_ledgers
     LIMIT 1`,
  ).bind(
    ...tableNames,
    ...tableNames,
    ...tableNames,
    ...reusedNames,
  ).first();
  return Object.freeze({
    tables: Number(row?.schema_tables || 0),
    indexes: Number(row?.schema_indexes || 0),
    triggers: Number(row?.schema_triggers || 0),
    reusedLedgers: Number(row?.reused_ledgers || 0),
  });
}

async function readRuntimeSettings(database) {
  const row = await database.prepare(
    `SELECT rollout_mode, master_enabled, external_provider_enabled,
            primary_model_alias, dragon_model_alias, fallback_model_alias,
            external_model_name, thinking_enabled,
            dragon_daily_burst_limit, dragon_cycle_success_limit,
            quota_cycle_days, quota_cycle_carryover_enabled,
            max_concurrent_per_user, max_provider_retries,
            pilot_user_limit, user_cycle_cost_ceiling_microusd,
            global_cycle_cost_ceiling_microusd, memory_exchange_limit,
            confirmation_ttl_seconds, telemetry_retention_days,
            policy_version
     FROM ai_partner_runtime_settings
     WHERE id = 1
     LIMIT 1`,
  ).first();
  if (!row) return null;
  return Object.freeze({
    rolloutMode: String(row.rollout_mode || "off"),
    masterEnabled: Number(row.master_enabled) === 1,
    externalProviderEnabled: Number(row.external_provider_enabled) === 1,
    primaryModelAlias: String(row.primary_model_alias || ""),
    dragonModelAlias: String(row.dragon_model_alias || ""),
    fallbackModelAlias: String(row.fallback_model_alias || ""),
    externalModelName: String(row.external_model_name || ""),
    thinkingEnabled: Number(row.thinking_enabled) === 1,
    dailyBurst: Number(row.dragon_daily_burst_limit),
    cycleSuccess: Number(row.dragon_cycle_success_limit),
    cycleDays: Number(row.quota_cycle_days),
    cycleCarryoverEnabled:
      Number(row.quota_cycle_carryover_enabled) === 1,
    maxConcurrentPerUser: Number(row.max_concurrent_per_user),
    maxProviderRetries: Number(row.max_provider_retries),
    pilotUsers: Number(row.pilot_user_limit),
    userCostCeilingMicrousd:
      Number(row.user_cycle_cost_ceiling_microusd),
    globalCostCeilingMicrousd:
      Number(row.global_cycle_cost_ceiling_microusd),
    memoryExchanges: Number(row.memory_exchange_limit),
    confirmationTtlSeconds: Number(row.confirmation_ttl_seconds),
    telemetryRetentionDays: Number(row.telemetry_retention_days),
    policyVersion: String(row.policy_version || ""),
  });
}

function settingsMatchContract(settings, config) {
  return Boolean(
    settings &&
      settings.rolloutMode === config.rolloutMode &&
      settings.masterEnabled === config.masterEnabled &&
      settings.externalProviderEnabled === config.externalProviderEnabled &&
      settings.primaryModelAlias === AI_PARTNER_MODEL_ALIASES.safe &&
      settings.dragonModelAlias === AI_PARTNER_MODEL_ALIASES.dragon &&
      settings.fallbackModelAlias === AI_PARTNER_MODEL_ALIASES.safe &&
      settings.externalModelName === "deepseek-flash" &&
      settings.thinkingEnabled === false &&
      settings.dailyBurst === config.dailyBurst &&
      settings.cycleSuccess === config.cycleSuccess &&
      settings.cycleDays === AI_PARTNER_LIMITS.cycleDays &&
      settings.cycleCarryoverEnabled === false &&
      settings.maxConcurrentPerUser === 1 &&
      settings.maxProviderRetries === 1 &&
      settings.pilotUsers === config.pilotUsers &&
      settings.userCostCeilingMicrousd === config.userCostCeilingMicrousd &&
      settings.globalCostCeilingMicrousd ===
        config.globalCostCeilingMicrousd &&
      settings.memoryExchanges === AI_PARTNER_LIMITS.memoryExchanges &&
      settings.confirmationTtlSeconds ===
        AI_PARTNER_LIMITS.confirmationTtlSeconds &&
      settings.telemetryRetentionDays ===
        AI_PARTNER_LIMITS.telemetryRetentionDays &&
      settings.policyVersion === AI_PARTNER_POLICY_VERSION
  );
}

function preservedLayers(env) {
  const result = {};
  for (const [key, expected] of Object.entries(REQUIRED_PRESERVED_FLAGS)) {
    result[key] = String(env?.[key] ?? "") === expected;
  }
  return Object.freeze({
    starsOwnerOnly: Boolean(
      result.STARS_PAYMENTS_ENABLED &&
      result.STARS_REFUNDS_ENABLED &&
      result.STARS_RECONCILIATION_ENABLED &&
      result.STARS_ROLLOUT_MODE
    ),
    referralOwnerOnly: Boolean(
      result.REFERRAL_REWARDS_ENABLED &&
      result.REFERRAL_REWARD_CANDIDATES_ENABLED &&
      result.REFERRAL_REWARD_CONFIRMATIONS_ENABLED &&
      result.REFERRAL_BONUS_GRANTS_ENABLED &&
      result.REFERRAL_REWARD_ROLLOUT_MODE
    ),
    adminSafety: Boolean(
      result.ADMIN_MODERATION_ENABLED &&
      result.ADMIN_AI_CHAT_ENABLED &&
      result.ADMIN_DEEPSEEK_CHAT_ENABLED
    ),
  });
}

async function defaultReadState(env) {
  const database = requireDatabase(env);
  const [schema, settings] = await Promise.all([
    readSchemaState(database),
    readRuntimeSettings(database),
  ]);
  return Object.freeze({ schema, settings });
}

function schemaReady(schema) {
  return Object.entries(AI_PARTNER_OWNER_WORKER_SCHEMA)
    .every(([key, expected]) => schema?.[key] === expected);
}

function exactClosedFlags(env) {
  return Boolean(
    !flag(env?.AI_PARTNER_ENABLED) &&
      String(env?.AI_PARTNER_ROLLOUT_MODE || "off") === "off" &&
      !flag(env?.AI_PARTNER_EXTERNAL_PROVIDER_ENABLED) &&
      !flag(env?.AI_PARTNER_RICH_MESSAGES_ENABLED) &&
      !flag(env?.AI_PARTNER_OWNER_GENERATION_ENABLED) &&
      !flag(env?.AI_PARTNER_OWNER_SECURITY_COST_FALLBACK_ENABLED) &&
      !flag(env?.AI_PARTNER_OWNER_MEMORY_ENABLED) &&
      String(env?.AI_PARTNER_OWNER_MODEL_POLICY || "auto") === "auto"
  );
}

function exactAdminFlags(env) {
  return Boolean(
    flag(env?.AI_PARTNER_ENABLED) &&
      String(env?.AI_PARTNER_ROLLOUT_MODE || "") === "admin" &&
      flag(env?.AI_PARTNER_EXTERNAL_PROVIDER_ENABLED) &&
      flag(env?.AI_PARTNER_RICH_MESSAGES_ENABLED) &&
      flag(env?.AI_PARTNER_OWNER_GENERATION_ENABLED) &&
      flag(env?.AI_PARTNER_OWNER_SECURITY_COST_FALLBACK_ENABLED) &&
      !flag(env?.AI_PARTNER_OWNER_MEMORY_ENABLED) &&
      String(env?.AI_PARTNER_OWNER_MODEL_POLICY || "auto") === "auto"
  );
}

export async function buildAiPartnerOwnerCanarySnapshot(
  env,
  {
    at = Math.floor(Date.now() / 1_000),
    readState = defaultReadState,
    getDecision = getAiPartnerOwnerWorkerDecision,
  } = {},
) {
  const timestamp = normalizeClock(at);
  const owner = positiveTelegramId(env?.ADMIN_ID);
  if (!owner) throw new Error("ai_partner_owner_probe_admin_not_configured");
  const nonAdmin = owner === 1 ? 2 : 1;
  const config = readAiPartnerConfig(env);
  const [state, ownerDecision, nonAdminDecision] = await Promise.all([
    readState(env),
    getDecision(env, owner, { at: timestamp }),
    getDecision(env, nonAdmin, { at: timestamp }),
  ]);
  const preserved = preservedLayers(env);
  const schemaIsReady = schemaReady(state.schema);
  const settingsReady = settingsMatchContract(state.settings, config);
  const preservationReady = Object.values(preserved).every(Boolean);
  const closed = Boolean(
    exactClosedFlags(env) &&
      schemaIsReady &&
      settingsReady &&
      ownerDecision?.eligible === false &&
      ownerDecision?.reason === "feature_off" &&
      nonAdminDecision?.eligible === false &&
      nonAdminDecision?.reason === "non_admin_blocked" &&
      preservationReady
  );
  const adminCanary = Boolean(
    exactAdminFlags(env) &&
      schemaIsReady &&
      settingsReady &&
      ownerDecision?.eligible === true &&
      ownerDecision?.reason === "admin_canary" &&
      nonAdminDecision?.eligible === false &&
      nonAdminDecision?.reason === "non_admin_blocked" &&
      preservationReady
  );
  const status = closed ? "closed" : adminCanary ? "admin_canary" : "not_ready";
  const problems = [];
  if (!schemaIsReady) problems.push("schema_not_ready");
  if (!settingsReady) problems.push("database_settings_mismatch");
  if (!preservationReady) problems.push("accepted_owner_layer_not_preserved");
  if (!closed && !adminCanary) {
    problems.push(ownerDecision?.reason || "owner_runtime_not_ready");
  }
  return Object.freeze({
    service: "re-program-bot",
    version: "1.3.8",
    acceptanceRevision: AI_PARTNER_OWNER_CANARY_PROBE_VERSION,
    status,
    switches: Object.freeze({
      masterEnabled: config.masterEnabled,
      externalProviderEnabled: config.externalProviderEnabled,
      richMessagesEnabled: config.richMessagesEnabled,
      ownerGenerationEnabled: flag(env?.AI_PARTNER_OWNER_GENERATION_ENABLED),
      ownerSecurityCostFallbackEnabled:
        flag(env?.AI_PARTNER_OWNER_SECURITY_COST_FALLBACK_ENABLED),
      ownerMemoryEnabled: flag(env?.AI_PARTNER_OWNER_MEMORY_ENABLED),
      modelPolicy: String(env?.AI_PARTNER_OWNER_MODEL_POLICY || "auto"),
      thinkingEnabled: false,
    }),
    rollout: Object.freeze({
      mode: config.rolloutMode,
      ownerEligible: ownerDecision?.eligible === true,
      nonAdminBlocked:
        nonAdminDecision?.eligible === false &&
        nonAdminDecision?.reason === "non_admin_blocked",
      approvalReady: Boolean(ownerDecision?.approval?.ready),
      approvalExpiresInSeconds:
        Number(ownerDecision?.approval?.expiresInSeconds || 0),
    }),
    database: Object.freeze({
      ready: schemaIsReady && settingsReady,
      schemaTables: state.schema?.tables || 0,
      expectedSchemaTables: AI_PARTNER_OWNER_WORKER_SCHEMA.tables,
      schemaIndexes: state.schema?.indexes || 0,
      expectedSchemaIndexes: AI_PARTNER_OWNER_WORKER_SCHEMA.indexes,
      schemaTriggers: state.schema?.triggers || 0,
      expectedSchemaTriggers: AI_PARTNER_OWNER_WORKER_SCHEMA.triggers,
      reusedLedgers: state.schema?.reusedLedgers || 0,
      expectedReusedLedgers: AI_PARTNER_OWNER_WORKER_SCHEMA.reusedLedgers,
      settingsMatch: settingsReady,
    }),
    preserved,
    provider: Object.freeze({
      configured: config.externalProviderEnabled,
      routeRequiresSignedOwnerConsent: true,
      primaryWithoutConsent: "qwen_safe",
      externalModelName: "deepseek-flash",
      memoryMode: "disabled",
      cacheAllowed: false,
    }),
    configurationProblems: Object.freeze([...new Set([
      ...config.configurationProblems,
      ...problems,
    ])].slice(0, 12)),
  });
}

export function createAiPartnerOwnerCanaryProbe({
  now = () => Math.floor(Date.now() / 1_000),
  cryptoImpl = globalThis.crypto,
  readState = defaultReadState,
  getDecision = getAiPartnerOwnerWorkerDecision,
} = {}) {
  if (
    typeof now !== "function" ||
    typeof readState !== "function" ||
    typeof getDecision !== "function"
  ) {
    throw new TypeError("AI Partner owner probe dependencies are required");
  }
  return Object.freeze({
    async handle(request, env) {
      const url = new URL(request.url);
      if (
        request.method !== "GET" ||
        url.pathname !== AI_PARTNER_OWNER_CANARY_PATH ||
        url.search ||
        request.headers.has("Content-Length") &&
          String(request.headers.get("Content-Length")) !== "0"
      ) {
        return concealed();
      }
      const at = normalizeClock(now());
      if (!(await requestAuthorized(request, env, { at, cryptoImpl }))) {
        return concealed();
      }
      let snapshot;
      try {
        snapshot = await buildAiPartnerOwnerCanarySnapshot(env, {
          at,
          readState,
          getDecision,
        });
      } catch {
        return Response.json({
          service: "re-program-bot",
          version: "1.3.8",
          acceptanceRevision: AI_PARTNER_OWNER_CANARY_PROBE_VERSION,
          status: "not_ready",
          configurationProblems: ["probe_runtime_not_ready"],
        }, { status: 503, headers: noStoreHeaders() });
      }
      return Response.json(snapshot, {
        status: snapshot.status === "not_ready" ? 503 : 200,
        headers: noStoreHeaders(),
      });
    },
  });
}

export const aiPartnerOwnerCanaryProbe = createAiPartnerOwnerCanaryProbe();

export async function handleAiPartnerOwnerCanaryProbe(request, env) {
  return aiPartnerOwnerCanaryProbe.handle(request, env);
}
