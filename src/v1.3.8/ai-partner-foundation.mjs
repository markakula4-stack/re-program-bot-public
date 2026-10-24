export const AI_PARTNER_POLICY_VERSION = "2026-09-12.ai-partner-v1";
export const AI_PARTNER_PROMPT_VERSION = "2026-09-12.ai-partner-prompt-v1";

export const AI_PARTNER_MODEL_ALIASES = Object.freeze({
  safe: "qwen_safe",
  dragon: "deepseek_flash_dragon",
  humanEdit: "human_edit",
});

export const AI_PARTNER_LIMITS = Object.freeze({
  dailyBurst: 100,
  cycleSuccess: 900,
  cycleDays: 30,
  cycleCarryoverEnabled: false,
  maxConcurrentPerUser: 1,
  maxProviderRetries: 1,
  pilotUsers: 10,
  userCycleCostCeilingMicrousd: 2_000_000,
  globalCycleCostCeilingMicrousd: 20_000_000,
  memoryExchanges: 5,
  confirmationTtlSeconds: 600,
  telemetryRetentionDays: 90,
});

export const AI_PARTNER_DRAFT_TYPES = Object.freeze([
  "telegram_post",
  "private_message",
  "short_card",
  "promotion_idea",
  "short_video_script",
  "offer_explanation",
]);

export const AI_PARTNER_READ_TOOLS = Object.freeze([
  "read_own_profile",
  "read_own_access",
  "read_own_applications",
  "read_own_allowed_offers",
  "read_own_existing_analytics",
  "read_approved_fact_sources",
]);

const DRAFT_TYPE_SET = new Set(AI_PARTNER_DRAFT_TYPES);
const READ_TOOL_SET = new Set(AI_PARTNER_READ_TOOLS);
const ROLLOUT_MODES = new Set(["off", "admin"]);
const TEXT_ENCODER = new TextEncoder();

function strictFlag(value) {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

function rolloutMode(value) {
  const normalized = String(value || "off").trim().toLowerCase();
  return ROLLOUT_MODES.has(normalized) ? normalized : "off";
}

function configuredPositiveInteger(value, fallback, maximum, problemCode, problems) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    problems.push(problemCode);
    return fallback;
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    problems.push(problemCode);
    return fallback;
  }
  return parsed;
}

export function normalizeAiPartnerDraftType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!DRAFT_TYPE_SET.has(normalized)) {
    throw new TypeError("unsupported AI Partner draft type");
  }
  return normalized;
}

export function isAllowedAiPartnerReadTool(value) {
  return READ_TOOL_SET.has(String(value || "").trim());
}

export function assertAiPartnerOwnerScope(actorTelegramId, ownerTelegramId) {
  const actor = Number(actorTelegramId);
  const owner = Number(ownerTelegramId);
  if (
    !Number.isSafeInteger(actor) || actor <= 0 ||
    !Number.isSafeInteger(owner) || owner <= 0 ||
    actor !== owner
  ) {
    throw new Error("AI Partner owner scope denied");
  }
  return owner;
}

export function readAiPartnerConfig(env = {}) {
  const problems = [];
  const requestedMode = String(env.AI_PARTNER_ROLLOUT_MODE || "off")
    .trim()
    .toLowerCase();
  const mode = rolloutMode(requestedMode);
  if (requestedMode !== mode) problems.push("ai_partner_rollout_invalid");

  const masterRequested = strictFlag(env.AI_PARTNER_ENABLED);
  const externalRequested = strictFlag(
    env.AI_PARTNER_EXTERNAL_PROVIDER_ENABLED,
  );
  const richMessagesRequested = strictFlag(
    env.AI_PARTNER_RICH_MESSAGES_ENABLED,
  );

  const dailyBurst = configuredPositiveInteger(
    env.AI_PARTNER_DRAGON_DAILY_BURST_LIMIT,
    AI_PARTNER_LIMITS.dailyBurst,
    AI_PARTNER_LIMITS.dailyBurst,
    "ai_partner_daily_burst_limit_invalid",
    problems,
  );
  const cycleSuccess = configuredPositiveInteger(
    env.AI_PARTNER_DRAGON_CYCLE_SUCCESS_LIMIT,
    AI_PARTNER_LIMITS.cycleSuccess,
    AI_PARTNER_LIMITS.cycleSuccess,
    "ai_partner_cycle_limit_invalid",
    problems,
  );
  const userCostCeilingMicrousd = configuredPositiveInteger(
    env.AI_PARTNER_USER_CYCLE_COST_CEILING_MICROUSD,
    AI_PARTNER_LIMITS.userCycleCostCeilingMicrousd,
    AI_PARTNER_LIMITS.userCycleCostCeilingMicrousd,
    "ai_partner_user_cost_ceiling_invalid",
    problems,
  );
  const globalCostCeilingMicrousd = configuredPositiveInteger(
    env.AI_PARTNER_GLOBAL_CYCLE_COST_CEILING_MICROUSD,
    AI_PARTNER_LIMITS.globalCycleCostCeilingMicrousd,
    AI_PARTNER_LIMITS.globalCycleCostCeilingMicrousd,
    "ai_partner_global_cost_ceiling_invalid",
    problems,
  );

  if (cycleSuccess < dailyBurst) {
    problems.push("ai_partner_quota_relationship_invalid");
  }
  if (globalCostCeilingMicrousd < userCostCeilingMicrousd) {
    problems.push("ai_partner_cost_relationship_invalid");
  }
  if (masterRequested && mode !== "admin") {
    problems.push("ai_partner_admin_rollout_required");
  }
  if (externalRequested && (!masterRequested || mode !== "admin")) {
    problems.push("ai_partner_external_provider_requires_admin");
  }
  const hasExternalSecret =
    typeof env.DEEPSEEK_API_KEY === "string" &&
    env.DEEPSEEK_API_KEY.trim().length >= 20;
  if (externalRequested && !hasExternalSecret) {
    problems.push("ai_partner_external_provider_secret_missing");
  }

  const configurationValid = problems.length === 0;
  const masterEnabled =
    configurationValid && masterRequested && mode === "admin";
  const externalProviderEnabled =
    masterEnabled && externalRequested && hasExternalSecret;

  return Object.freeze({
    policyVersion: AI_PARTNER_POLICY_VERSION,
    rolloutMode: masterEnabled ? mode : "off",
    configurationProblems: Object.freeze([...new Set(problems)]),
    configurationValid,
    masterEnabled,
    externalProviderEnabled,
    richMessagesEnabled: masterEnabled && richMessagesRequested,
    thinkingEnabled: false,
    primaryModelAlias: AI_PARTNER_MODEL_ALIASES.safe,
    dragonModelAlias: AI_PARTNER_MODEL_ALIASES.dragon,
    fallbackModelAlias: AI_PARTNER_MODEL_ALIASES.safe,
    externalModelName: "deepseek-flash",
    dailyBurst,
    cycleSuccess,
    cycleDays: AI_PARTNER_LIMITS.cycleDays,
    cycleCarryoverEnabled: AI_PARTNER_LIMITS.cycleCarryoverEnabled,
    maxConcurrentPerUser: AI_PARTNER_LIMITS.maxConcurrentPerUser,
    maxProviderRetries: AI_PARTNER_LIMITS.maxProviderRetries,
    pilotUsers: AI_PARTNER_LIMITS.pilotUsers,
    userCostCeilingMicrousd,
    globalCostCeilingMicrousd,
    memoryExchanges: AI_PARTNER_LIMITS.memoryExchanges,
    confirmationTtlSeconds: AI_PARTNER_LIMITS.confirmationTtlSeconds,
    telemetryRetentionDays: AI_PARTNER_LIMITS.telemetryRetentionDays,
  });
}

export function resolveAiPartnerModel(config, { isAdmin = false } = {}) {
  if (!config?.masterEnabled || config.rolloutMode !== "admin" || !isAdmin) {
    return Object.freeze({
      enabled: false,
      modelAlias: AI_PARTNER_MODEL_ALIASES.safe,
      provider: "cloudflare",
      modelName: null,
      thinkingEnabled: false,
    });
  }
  if (config.externalProviderEnabled) {
    return Object.freeze({
      enabled: true,
      modelAlias: AI_PARTNER_MODEL_ALIASES.dragon,
      provider: "deepseek",
      modelName: "deepseek-flash",
      thinkingEnabled: false,
    });
  }
  return Object.freeze({
    enabled: true,
    modelAlias: AI_PARTNER_MODEL_ALIASES.safe,
    provider: "cloudflare",
    modelName: null,
    thinkingEnabled: false,
  });
}

export async function createProviderScopedUserId({
  telegramId,
  secret,
  cryptoImpl = globalThis.crypto,
} = {}) {
  const owner = Number(telegramId);
  if (!Number.isSafeInteger(owner) || owner <= 0) {
    throw new TypeError("valid Telegram owner is required");
  }
  if (typeof secret !== "string" || secret.length < 32) {
    throw new TypeError("provider user-id secret must be at least 32 characters");
  }
  if (!cryptoImpl?.subtle) {
    throw new Error("Web Crypto is required");
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
    TEXT_ENCODER.encode(`re-ai-partner:v1:${owner}`),
  );
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `reai_${hex.slice(0, 40)}`;
}
