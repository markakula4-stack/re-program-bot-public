import {
  AI_PARTNER_LIMITS,
  AI_PARTNER_MODEL_ALIASES,
  AI_PARTNER_POLICY_VERSION,
  readAiPartnerConfig,
  resolveAiPartnerModel,
} from "./ai-partner-foundation.mjs";

export const AI_PARTNER_RELEASE_VERSION = "1.3.8";
export const AI_PARTNER_ACCEPTANCE_REVISION =
  "2026-09-12.ai-partner-rc1";
export const AI_PARTNER_CANARY_PATH = "/health/ai-partner-canary";
export const AI_PARTNER_ADMIN_CANARY_WINDOW_SECONDS = 10 * 60;

const AI_PARTNER_TABLES = Object.freeze([
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
]);

export const AI_PARTNER_SCHEMA_EXPECTATIONS = Object.freeze({
  tables: 13,
  indexes: 17,
  triggers: 35,
  reusedLedgers: 4,
});

const REUSED_AI_LEDGERS = Object.freeze([
  "ai_user_consents",
  "ai_usage_events",
  "ai_quota_reservations",
  "ai_conversation_messages",
]);
const TEXT_ENCODER = new TextEncoder();

function positiveTelegramId(value) {
  const normalized =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value;
  return Number.isSafeInteger(normalized) && normalized > 0
    ? normalized
    : null;
}

function canaryError(code) {
  const error = new Error("AI Partner canary is not ready");
  error.code = code;
  return error;
}

function requireDatabase(env) {
  if (!env?.DB?.prepare) throw canaryError("ai_partner_database_not_ready");
  return env.DB;
}

function secretReady(value, minimum = 32) {
  return typeof value === "string" && value.trim().length >= minimum;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseApproval(env, at) {
  const approvedAtText = String(
    env?.AI_PARTNER_ADMIN_CANARY_APPROVED_AT || "",
  ).trim();
  const expiresAtText = String(
    env?.AI_PARTNER_ADMIN_CANARY_APPROVED_UNTIL || "",
  ).trim();
  const approvedAt = /^\d{10}$/.test(approvedAtText)
    ? Number(approvedAtText)
    : null;
  const expiresAt = /^\d{10}$/.test(expiresAtText)
    ? Number(expiresAtText)
    : null;
  const windowValid =
    Number.isSafeInteger(approvedAt) &&
    Number.isSafeInteger(expiresAt) &&
    approvedAt <= at &&
    at < expiresAt &&
    expiresAt > approvedAt &&
    expiresAt - approvedAt <= AI_PARTNER_ADMIN_CANARY_WINDOW_SECONDS;
  return Object.freeze({
    ready: windowValid,
    approvedAt: windowValid ? approvedAt : null,
    expiresAt: windowValid ? expiresAt : null,
    expiresInSeconds: windowValid ? expiresAt - at : 0,
  });
}

async function readSchemaObjects(database) {
  const tablePlaceholders = AI_PARTNER_TABLES.map(() => "?").join(",");
  const reusedPlaceholders = REUSED_AI_LEDGERS.map(() => "?").join(",");
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
    ...AI_PARTNER_TABLES,
    ...AI_PARTNER_TABLES,
    ...AI_PARTNER_TABLES,
    ...REUSED_AI_LEDGERS,
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
  if (!row) throw canaryError("ai_partner_settings_not_ready");
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

async function readAggregateState(database) {
  const row = await database.prepare(
    `SELECT
       (SELECT COUNT(*) FROM content_fact_sources
          WHERE source_status = 'approved') AS approved_fact_sources,
       (SELECT COUNT(*) FROM ai_generation_sessions
          WHERE generation_state IN ('streaming', 'finalizing'))
         AS active_generations,
       (SELECT COUNT(*) FROM ai_share_intents
          WHERE intent_state = 'pending') AS pending_shares,
       (SELECT COUNT(*) FROM ai_gateway_budget_reservations
          WHERE reservation_state = 'reserved') AS active_reservations,
       (SELECT COUNT(*) FROM ai_gateway_attempts) AS provider_attempts,
       (SELECT COUNT(*) FROM ai_policy_events
          WHERE decision = 'block') AS policy_blocks
     LIMIT 1`,
  ).first();
  return Object.freeze({
    approvedFactSources: Number(row?.approved_fact_sources || 0),
    activeGenerations: Number(row?.active_generations || 0),
    pendingShares: Number(row?.pending_shares || 0),
    activeReservations: Number(row?.active_reservations || 0),
    providerAttempts: Number(row?.provider_attempts || 0),
    policyBlocks: Number(row?.policy_blocks || 0),
  });
}

function schemaIsReady(schema) {
  return Object.entries(AI_PARTNER_SCHEMA_EXPECTATIONS).every(
    ([key, expected]) => schema[key] === expected,
  );
}

function secretBoundary(env, config) {
  return Object.freeze({
    providerUserIdSecret:
      !config.masterEnabled ||
      secretReady(env?.AI_PARTNER_PROVIDER_USER_ID_SECRET),
    privateCacheSecret:
      !config.masterEnabled ||
      secretReady(env?.AI_PARTNER_PRIVATE_CACHE_SECRET),
    externalProviderSecret:
      !config.externalProviderEnabled || secretReady(env?.DEEPSEEK_API_KEY, 20),
  });
}

function decideActor({
  env,
  actorTelegramId,
  config,
  settings,
  approval,
  secrets,
  schemaReady,
}) {
  const actor = positiveTelegramId(actorTelegramId);
  const adminId = positiveTelegramId(env?.ADMIN_ID);
  const model = resolveAiPartnerModel(config, {
    isAdmin: Boolean(actor && adminId && actor === adminId),
  });
  const settingsReady = settingsMatchContract(settings, config);
  const secretsReady = Object.values(secrets).every(Boolean);
  const eligible = Boolean(
    actor &&
    adminId &&
    actor === adminId &&
    config.masterEnabled &&
    config.rolloutMode === "admin" &&
    config.configurationValid &&
    model.enabled &&
    approval.ready &&
    settingsReady &&
    schemaReady &&
    secretsReady
  );
  return Object.freeze({
    eligible,
    reason: eligible
      ? "admin_canary"
      : !config.masterEnabled
        ? "feature_off"
        : !actor || !adminId || actor !== adminId
          ? "non_admin_blocked"
          : !approval.ready
            ? "approval_missing_or_expired"
            : !settingsReady
              ? "database_settings_mismatch"
              : !schemaReady
                ? "schema_not_ready"
              : !secretsReady
                ? "secret_boundary_not_ready"
                : "configuration_invalid",
    modelAlias: model.modelAlias,
    provider: model.provider,
    thinkingEnabled: false,
  });
}

export async function getAiPartnerRolloutDecision(
  env,
  actorTelegramId,
  { at = Math.floor(Date.now() / 1_000) } = {},
) {
  const database = requireDatabase(env);
  const [settings, schema] = await Promise.all([
    readRuntimeSettings(database),
    readSchemaObjects(database),
  ]);
  const config = readAiPartnerConfig(env);
  const approval = parseApproval(env, at);
  const secrets = secretBoundary(env, config);
  return decideActor({
    env,
    actorTelegramId,
    config,
    settings,
    approval,
    secrets,
    schemaReady: schemaIsReady(schema),
  });
}

export async function getAiPartnerCanarySnapshot(
  env,
  { at = Math.floor(Date.now() / 1_000) } = {},
) {
  const adminId = positiveTelegramId(env?.ADMIN_ID);
  if (!adminId) throw canaryError("ai_partner_admin_not_configured");
  const nonAdminId = adminId === 1 ? 2 : 1;
  const database = requireDatabase(env);
  const config = readAiPartnerConfig(env);
  const approval = parseApproval(env, at);
  const secrets = secretBoundary(env, config);
  const [settings, schema, aggregate] = await Promise.all([
    readRuntimeSettings(database),
    readSchemaObjects(database),
    readAggregateState(database),
  ]);
  const settingsReady = settingsMatchContract(settings, config);
  const schemaReady = schemaIsReady(schema);
  const admin = decideActor({
    env,
    actorTelegramId: adminId,
    config,
    settings,
    approval,
    secrets,
    schemaReady,
  });
  const nonAdmin = decideActor({
    env,
    actorTelegramId: nonAdminId,
    config,
    settings,
    approval,
    secrets,
    schemaReady,
  });
  const configurationProblems = [...config.configurationProblems];
  if (!schemaReady) configurationProblems.push("ai_partner_schema_not_ready");
  if (!settingsReady) {
    configurationProblems.push("ai_partner_database_settings_mismatch");
  }
  if (config.masterEnabled && !approval.ready) {
    configurationProblems.push("ai_partner_admin_approval_missing_or_expired");
  }
  if (!secrets.providerUserIdSecret) {
    configurationProblems.push("ai_partner_provider_user_secret_missing");
  }
  if (!secrets.privateCacheSecret) {
    configurationProblems.push("ai_partner_private_cache_secret_missing");
  }
  if (!secrets.externalProviderSecret) {
    configurationProblems.push("ai_partner_external_provider_secret_missing");
  }
  const problems = Object.freeze(unique(configurationProblems).slice(0, 12));
  const closed =
    !config.masterEnabled &&
    config.rolloutMode === "off" &&
    !settings.masterEnabled &&
    settings.rolloutMode === "off" &&
    !settings.externalProviderEnabled &&
    !admin.eligible &&
    !nonAdmin.eligible &&
    schemaReady &&
    settingsReady &&
    problems.length === 0;
  const adminCanary =
    config.masterEnabled &&
    config.rolloutMode === "admin" &&
    admin.eligible &&
    !nonAdmin.eligible &&
    nonAdmin.reason === "non_admin_blocked" &&
    schemaReady &&
    settingsReady &&
    problems.length === 0;

  return Object.freeze({
    service: "re-program-bot",
    version: AI_PARTNER_RELEASE_VERSION,
    acceptanceRevision: AI_PARTNER_ACCEPTANCE_REVISION,
    status: closed ? "closed" : adminCanary ? "admin_canary" : "not_ready",
    switches: Object.freeze({
      masterEnabled: config.masterEnabled,
      externalProviderEnabled: config.externalProviderEnabled,
      richMessagesEnabled: config.richMessagesEnabled,
      thinkingEnabled: false,
    }),
    rollout: Object.freeze({
      mode: config.rolloutMode,
      adminEligible: admin.eligible,
      nonAdminBlocked: !nonAdmin.eligible,
      approvalReady: approval.ready,
      approvalExpiresInSeconds: approval.expiresInSeconds,
    }),
    provider: Object.freeze({
      adminModelAlias: admin.modelAlias,
      providerCode: admin.provider,
      externalModelName: config.externalModelName,
      secretBoundaryReady: Object.values(secrets).every(Boolean),
    }),
    database: Object.freeze({
      ready: schemaReady && settingsReady,
      schemaTables: schema.tables,
      expectedSchemaTables: AI_PARTNER_SCHEMA_EXPECTATIONS.tables,
      schemaIndexes: schema.indexes,
      expectedSchemaIndexes: AI_PARTNER_SCHEMA_EXPECTATIONS.indexes,
      schemaTriggers: schema.triggers,
      expectedSchemaTriggers: AI_PARTNER_SCHEMA_EXPECTATIONS.triggers,
      reusedLedgers: schema.reusedLedgers,
      expectedReusedLedgers: AI_PARTNER_SCHEMA_EXPECTATIONS.reusedLedgers,
      approvedFactSources: aggregate.approvedFactSources,
      activeGenerations: aggregate.activeGenerations,
      pendingShares: aggregate.pendingShares,
      activeReservations: aggregate.activeReservations,
      providerAttempts: aggregate.providerAttempts,
      policyBlocks: aggregate.policyBlocks,
    }),
    configurationProblems: problems,
  });
}

export async function secureAiPartnerCanaryRequestMatches(request, env) {
  const timestampText = String(
    request.headers.get("X-AI-Partner-Canary-Timestamp") || "",
  );
  const timestamp = Number(timestampText);
  const supplied = String(
    request.headers.get("X-AI-Partner-Canary-Signature") || "",
  ).toLowerCase();
  const secret = String(env?.AI_PARTNER_CANARY_PROBE_SECRET || "");
  const now = Math.floor(Date.now() / 1_000);
  if (
    !/^\d{10}$/.test(timestampText) ||
    !Number.isSafeInteger(timestamp) ||
    Math.abs(now - timestamp) > 90 ||
    !/^[a-f0-9]{64}$/.test(supplied) ||
    secret.length < 32
  ) {
    return false;
  }
  const url = new URL(request.url);
  const material = [
    "ai-partner-canary:v1",
    request.method,
    url.pathname,
    timestampText,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    TEXT_ENCODER.encode(material),
  ));
  const actual = Uint8Array.from(
    supplied.match(/.{2}/g).map((value) => Number.parseInt(value, 16)),
  );
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ actual[index];
  }
  return difference === 0;
}

function concealedResponse() {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}

function canaryJson(payload, status) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function handleAiPartnerCanaryProbe(request, env) {
  if (!(await secureAiPartnerCanaryRequestMatches(request, env))) {
    return concealedResponse();
  }
  try {
    const snapshot = await getAiPartnerCanarySnapshot(env);
    return canaryJson(snapshot, snapshot.status === "not_ready" ? 503 : 200);
  } catch (error) {
    const allowed = new Set([
      "ai_partner_admin_not_configured",
      "ai_partner_database_not_ready",
      "ai_partner_settings_not_ready",
    ]);
    const reason = String(error?.code || "ai_partner_canary_probe_failed");
    return canaryJson({
      service: "re-program-bot",
      version: AI_PARTNER_RELEASE_VERSION,
      acceptanceRevision: AI_PARTNER_ACCEPTANCE_REVISION,
      status: "not_ready",
      reason: allowed.has(reason) ? reason : "ai_partner_canary_probe_failed",
    }, 503);
  }
}
