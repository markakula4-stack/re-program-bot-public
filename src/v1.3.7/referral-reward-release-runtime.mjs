import {
  readReferralRewardConfig,
} from "./referral-reward-foundation.mjs";
import {
  getReferralRewardRolloutDecision,
} from "./referral-reward-candidate-runtime.mjs";
import {
  getReferralRewardAdminDiagnostics,
} from "./referral-reward-ux-admin-runtime.mjs";

export const REFERRAL_RELEASE_VERSION = "1.3.7";
export const REFERRAL_ACCEPTANCE_REVISION =
  "2026-09-11.referral-reward-rc1";
export const REFERRAL_CANARY_PATH = "/health/referral-reward-canary";

const REFERRAL_TABLES = Object.freeze([
  "referral_reward_candidates",
  "referral_rewards",
  "bonus_access_grants",
  "referral_reward_transitions",
  "referral_reward_protection_jobs",
  "referral_reward_protection_checks",
  "bonus_access_effects",
  "bonus_access_expiry_events",
  "bonus_access_reversals",
  "referral_reward_notice_jobs",
]);

export const REFERRAL_SCHEMA_EXPECTATIONS = Object.freeze({
  tables: REFERRAL_TABLES.length,
  indexes: 20,
  triggers: 62,
});

function positiveTelegramId(value) {
  const normalized =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value;
  return Number.isSafeInteger(normalized) && normalized > 0
    ? normalized
    : null;
}

function allowlistSize(env) {
  return new Set(
    String(env?.REFERRAL_REWARD_ROLLOUT_ALLOWLIST || "")
      .split(/[\s,;]+/)
      .map(positiveTelegramId)
      .filter(Boolean)
      .slice(0, 500),
  ).size;
}

function canaryError(code) {
  const error = new Error("Referral reward canary is not ready");
  error.code = code;
  return error;
}

function requireDatabase(env) {
  if (!env?.DB?.prepare) throw canaryError("referral_database_not_ready");
  return env.DB;
}

async function readSchemaObjects(database) {
  const placeholders = REFERRAL_TABLES.map(() => "?").join(",");
  const row = await database.prepare(
    `SELECT
       (SELECT COUNT(*) FROM sqlite_schema
          WHERE type = 'table' AND name IN (${placeholders}))
         AS schema_tables,
       (SELECT COUNT(*) FROM sqlite_schema
          WHERE type = 'index'
            AND name NOT LIKE 'sqlite_autoindex_%'
            AND tbl_name IN (${placeholders}))
         AS schema_indexes,
       (SELECT COUNT(*) FROM sqlite_schema
          WHERE type = 'trigger'
            AND (
              name LIKE 'trg_referral_%'
              OR name LIKE 'trg_bonus_%'
              OR name = 'trg_subscriptions_referral_extension_guard'
            ))
         AS schema_triggers
     LIMIT 1`,
  ).bind(...REFERRAL_TABLES, ...REFERRAL_TABLES).first();
  return Object.freeze({
    tables: Number(row?.schema_tables || 0),
    indexes: Number(row?.schema_indexes || 0),
    triggers: Number(row?.schema_triggers || 0),
  });
}

function inspectWorkflowBinding(env) {
  const binding = env?.REFERRAL_REWARD_PROTECTION_WORKFLOW;
  const createAvailable = typeof binding?.create === "function";
  const getAvailable = typeof binding?.get === "function";
  return Object.freeze({
    ready: createAvailable && getAvailable,
    createAvailable,
    getAvailable,
  });
}

function safeCount(counts, key) {
  const value = Number(counts?.[key] || 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export async function getReferralRewardCanarySnapshot(
  env,
  { at = Math.floor(Date.now() / 1_000) } = {},
) {
  const adminId = positiveTelegramId(env?.ADMIN_ID);
  if (!adminId) throw canaryError("referral_admin_not_configured");
  const nonAdminId = adminId === 1 ? 2 : 1;
  const config = readReferralRewardConfig(env);
  const database = requireDatabase(env);
  const [diagnostics, objects, admin, nonAdmin] = await Promise.all([
    getReferralRewardAdminDiagnostics(env, { at }),
    readSchemaObjects(database),
    getReferralRewardRolloutDecision(env, adminId),
    getReferralRewardRolloutDecision(env, nonAdminId),
  ]);
  const workflow = inspectWorkflowBinding(env);
  const switches = Object.freeze({
    masterEnabled: config.masterEnabled,
    candidateWritesEnabled: config.candidateWritesEnabled,
    confirmationsEnabled: config.confirmationsEnabled,
    bonusGrantsEnabled: config.bonusGrantsEnabled,
  });
  const rollout = Object.freeze({
    mode: config.rolloutMode,
    adminEligible: Boolean(admin.eligible),
    nonAdminBlocked: !nonAdmin.eligible,
    allowlistSize: allowlistSize(env),
  });
  const schemaReady =
    objects.tables === REFERRAL_SCHEMA_EXPECTATIONS.tables &&
    objects.indexes === REFERRAL_SCHEMA_EXPECTATIONS.indexes &&
    objects.triggers === REFERRAL_SCHEMA_EXPECTATIONS.triggers;
  const databaseReady = diagnostics.ready && schemaReady;
  const databaseState = Object.freeze({
    ready: databaseReady,
    status: String(diagnostics.status || "not_ready"),
    attention: Number(diagnostics.attention || 0),
    schemaTables: objects.tables,
    expectedSchemaTables: REFERRAL_SCHEMA_EXPECTATIONS.tables,
    schemaIndexes: objects.indexes,
    expectedSchemaIndexes: REFERRAL_SCHEMA_EXPECTATIONS.indexes,
    schemaTriggers: objects.triggers,
    expectedSchemaTriggers: REFERRAL_SCHEMA_EXPECTATIONS.triggers,
    rewardsTotal: safeCount(diagnostics.counts, "rewards_total"),
    rewardsPending: safeCount(diagnostics.counts, "rewards_pending"),
    workflowManualReview: safeCount(
      diagnostics.counts,
      "protection_review",
    ),
    grantsManualReview: safeCount(diagnostics.counts, "grants_review"),
    noticesManualReview: safeCount(diagnostics.counts, "notices_review"),
  });
  const problems = [...config.configurationProblems];
  if (!workflow.ready) problems.push("referral_workflow_binding_not_ready");
  if (!databaseReady) problems.push("referral_schema_not_ready");
  if (databaseState.attention !== 0) problems.push("referral_attention_present");
  if (rollout.mode === "admin" && rollout.allowlistSize !== 0) {
    problems.push("referral_admin_canary_allowlist_not_empty");
  }
  const configurationProblems = Object.freeze([...new Set(problems)].slice(0, 10));
  const closed =
    !switches.masterEnabled &&
    !switches.candidateWritesEnabled &&
    !switches.confirmationsEnabled &&
    !switches.bonusGrantsEnabled &&
    rollout.mode === "off" &&
    !rollout.adminEligible &&
    rollout.nonAdminBlocked &&
    workflow.ready &&
    databaseReady &&
    databaseState.attention === 0 &&
    configurationProblems.length === 0;
  const adminCanary =
    switches.masterEnabled &&
    switches.candidateWritesEnabled &&
    switches.confirmationsEnabled &&
    switches.bonusGrantsEnabled &&
    rollout.mode === "admin" &&
    rollout.adminEligible &&
    rollout.nonAdminBlocked &&
    rollout.allowlistSize === 0 &&
    Number.isSafeInteger(config.programStartedAt) &&
    workflow.ready &&
    databaseReady &&
    databaseState.attention === 0 &&
    configurationProblems.length === 0;

  return Object.freeze({
    service: "re-program-bot",
    version: REFERRAL_RELEASE_VERSION,
    acceptanceRevision: REFERRAL_ACCEPTANCE_REVISION,
    status: closed ? "closed" : adminCanary ? "admin_canary" : "not_ready",
    switches,
    rollout,
    workflow,
    database: databaseState,
    configurationProblems,
  });
}

export async function secureReferralCanaryRequestMatches(request, env) {
  const timestampText = String(
    request.headers.get("X-Referral-Canary-Timestamp") || "",
  );
  const timestamp = Number(timestampText);
  const supplied = String(
    request.headers.get("X-Referral-Canary-Signature") || "",
  ).toLowerCase();
  const secret = String(env?.REFERRAL_REWARD_CANARY_PROBE_SECRET || "");
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
    "referral-reward-canary:v1",
    request.method,
    url.pathname,
    timestampText,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(material),
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

export async function handleReferralRewardCanaryProbe(request, env) {
  if (!(await secureReferralCanaryRequestMatches(request, env))) {
    return concealedResponse();
  }
  try {
    const snapshot = await getReferralRewardCanarySnapshot(env);
    return canaryJson(snapshot, snapshot.status === "not_ready" ? 503 : 200);
  } catch (error) {
    const allowed = new Set([
      "referral_admin_not_configured",
      "referral_database_not_ready",
    ]);
    const reason = String(error?.code || "referral_canary_probe_failed");
    return canaryJson({
      service: "re-program-bot",
      version: REFERRAL_RELEASE_VERSION,
      acceptanceRevision: REFERRAL_ACCEPTANCE_REVISION,
      status: "not_ready",
      reason: allowed.has(reason) ? reason : "referral_canary_probe_failed",
    }, 503);
  }
}
