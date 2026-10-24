import {
  AI_PARTNER_LIMITS,
  AI_PARTNER_MODEL_ALIASES,
  AI_PARTNER_POLICY_VERSION,
  createProviderScopedUserId,
} from "./ai-partner-foundation.mjs";

export const AI_GATEWAY_PROVIDER_CONSENT_VERSION =
  "2026-09-12.deepseek-flash-private-v1";
export const AI_GATEWAY_BENCHMARK_VERSION =
  "2026-09-12.re-ai-partner-benchmark-v1";
export const AI_GATEWAY_PRICING_SCHEMA_VERSION =
  "2026-09-12.microusd-per-million-v1";

export const AI_GATEWAY_HARD_LIMITS = Object.freeze({
  maxInputTokens: 8_192,
  maxOutputTokens: 2_048,
  maxExternalAttempts: 2,
  maxFallbackAttempts: 1,
  timeoutMs: 15_000,
  maximumTimeoutMs: 30_000,
  staleReservationSeconds: 5 * 60,
  maximumPayloadCharacters: 40_000,
  cycleSeconds: 30 * 24 * 60 * 60,
});

export const AI_GATEWAY_MODEL_ROUTES = Object.freeze({
  [AI_PARTNER_MODEL_ALIASES.dragon]: Object.freeze({
    providerCode: "deepseek",
    providerModel: "deepseek-flash",
    thinkingEnabled: false,
  }),
  [AI_PARTNER_MODEL_ALIASES.safe]: Object.freeze({
    providerCode: "cloudflare",
    providerModel: null,
    thinkingEnabled: false,
  }),
});

export const AI_GATEWAY_BENCHMARK_CASES_RU = Object.freeze([
  Object.freeze({
    caseId: "telegram_post_public_offer",
    draftType: "telegram_post",
    input: Object.freeze({
      instruction: "Подготовь короткий Telegram-пост только по утверждённым фактам.",
      factPlaceholders: Object.freeze(["{{fact:offer_title}}", "{{fact:offer_url}}"]),
    }),
    rubric: Object.freeze(["russian", "facts_only", "draft_notice", "no_income_guarantee"]),
  }),
  Object.freeze({
    caseId: "private_message_partner",
    draftType: "private_message",
    input: Object.freeze({
      instruction: "Подготовь вежливый личный черновик без обещаний результата.",
      factPlaceholders: Object.freeze(["{{fact:offer_title}}"]),
    }),
    rubric: Object.freeze(["russian", "facts_only", "no_auto_send", "no_income_guarantee"]),
  }),
  Object.freeze({
    caseId: "short_card_terms",
    draftType: "short_card",
    input: Object.freeze({
      instruction: "Собери краткую карточку утверждённых условий.",
      factPlaceholders: Object.freeze(["{{fact:terms_summary}}", "{{fact:terms_url}}"]),
    }),
    rubric: Object.freeze(["russian", "facts_only", "source_preserved"]),
  }),
  Object.freeze({
    caseId: "promotion_idea_safe",
    draftType: "promotion_idea",
    input: Object.freeze({
      instruction: "Предложи одну безопасную идею продвижения без автопубликации.",
      factPlaceholders: Object.freeze(["{{fact:offer_title}}"]),
    }),
    rubric: Object.freeze(["russian", "draft_only", "no_policy_bypass"]),
  }),
  Object.freeze({
    caseId: "short_video_script",
    draftType: "short_video_script",
    input: Object.freeze({
      instruction: "Сделай короткий сценарий Reels с проверяемым призывом.",
      factPlaceholders: Object.freeze(["{{fact:offer_title}}", "{{fact:offer_url}}"]),
    }),
    rubric: Object.freeze(["russian", "facts_only", "draft_notice"]),
  }),
  Object.freeze({
    caseId: "offer_explanation",
    draftType: "offer_explanation",
    input: Object.freeze({
      instruction: "Объясни утверждённые условия простыми словами.",
      factPlaceholders: Object.freeze(["{{fact:terms_summary}}", "{{fact:source_version}}"]),
    }),
    rubric: Object.freeze(["russian", "facts_only", "source_preserved"]),
  }),
]);

const VERIFIED_GATEWAY_CONTEXTS = new WeakSet();
const TEXT_ENCODER = new TextEncoder();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9:_-]{16,96}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const ROUTING_FIELDS = new Set([
  "model", "modelalias", "provider", "providercode", "thinking",
  "thinkingenabled", "tools", "toolchoice",
]);
const ALWAYS_REDACT_KEYS = new Set([
  "telegramid", "chatid", "userid", "orderid", "paymentid",
  "telegrampaymentchargeid", "providerpaymentchargeid", "apikey",
  "authorization", "cookie", "secret", "token",
]);
const BLOCKING_SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bbot\d{6,}:[A-Za-z0-9_-]{20,}\b/,
  /\b(?:sk|ds)-[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}\b/i,
]);
const REDACTION_PATTERNS = Object.freeze([
  Object.freeze({
    code: "telegram_id",
    pattern: /(?<![A-Za-zА-Яа-яЁё0-9_])(?:telegram(?:\s+id)?|tg\s*id|телеграм(?:\s+id)?|тг\s*id)\s*[:#№-]?\s*\d{5,15}\b/gi,
  }),
  Object.freeze({ code: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi }),
  Object.freeze({ code: "phone", pattern: /(?<!\d)(?:\+?\d[\s().-]*){10,15}(?!\d)/g }),
  Object.freeze({ code: "card", pattern: /(?<!\d)(?:\d[ -]*?){13,19}(?!\d)/g }),
  Object.freeze({ code: "telegram_username", pattern: /(^|\s)@[A-Za-z0-9_]{5,32}\b/g }),
]);

function integer(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = Number(value);
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < minimum ||
    normalized > maximum
  ) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function nonEmptyString(value, label, { minimum = 1, maximum = 160 } = {}) {
  const normalized = String(value || "").trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new TypeError(`${label} must contain ${minimum}-${maximum} characters`);
  }
  return normalized;
}

function normalizeRequestId(value) {
  const normalized = nonEmptyString(value, "request id", { minimum: 16, maximum: 96 });
  if (!REQUEST_ID_PATTERN.test(normalized)) {
    throw new TypeError("request id contains unsupported characters");
  }
  return normalized;
}

function normalizeUuid(value, label = "identifier") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new TypeError(`${label} must be a UUID`);
  return normalized;
}

function normalizeHash(value, label = "hash") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!HASH_PATTERN.test(normalized)) throw new TypeError(`${label} must be SHA-256 hex`);
  return normalized;
}

function normalizeErrorCode(value, fallback = "provider_failed") {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 80);
  return normalized.length >= 3 ? normalized : fallback;
}

function canonicalFieldName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function statementChanged(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0) > 0;
}

function unique(values) {
  return [...new Set(values)];
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

async function sha256Hex(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto is required");
  const digest = await cryptoImpl.subtle.digest(
    "SHA-256",
    TEXT_ENCODER.encode(String(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacHex(value, secret, cryptoImpl = globalThis.crypto) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new TypeError("cache scope secret must be at least 32 characters");
  }
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto is required");
  const key = await cryptoImpl.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await cryptoImpl.subtle.sign(
    "HMAC",
    key,
    TEXT_ENCODER.encode(String(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function usageDateFromEpoch(at) {
  return new Date(integer(at, "timestamp", { minimum: 1 }) * 1000)
    .toISOString()
    .slice(0, 10);
}

function normalizeCycleWindow(startAt, endAt, at, label) {
  const start = integer(startAt, `${label} start`, { minimum: 1 });
  const end = integer(endAt, `${label} end`, { minimum: 1 });
  if (end !== start + AI_GATEWAY_HARD_LIMITS.cycleSeconds) {
    throw new TypeError(`${label} must be exactly 30 days`);
  }
  if (at < start || at >= end) throw new Error(`${label} is not active`);
  return Object.freeze({ startAt: start, endAt: end });
}

function assertNoClientRoutingFields(value, path = "request") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoClientRoutingFields(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (ROUTING_FIELDS.has(canonicalFieldName(key))) {
      throw new Error(`client-selected AI capability denied at ${path}.${key}`);
    }
    assertNoClientRoutingFields(child, `${path}.${key}`);
  }
}

export function normalizeAiGatewayPricing(value = {}) {
  const version = nonEmptyString(value.version, "pricing version", {
    minimum: 8,
    maximum: 80,
  });
  const normalized = {
    version,
    inputMicrousdPerMillion: integer(
      value.inputMicrousdPerMillion,
      "input price",
      { minimum: 1, maximum: 50_000_000 },
    ),
    cachedInputMicrousdPerMillion: integer(
      value.cachedInputMicrousdPerMillion,
      "cached input price",
      { minimum: 1, maximum: 50_000_000 },
    ),
    outputMicrousdPerMillion: integer(
      value.outputMicrousdPerMillion,
      "output price",
      { minimum: 1, maximum: 50_000_000 },
    ),
  };
  if (normalized.cachedInputMicrousdPerMillion > normalized.inputMicrousdPerMillion) {
    throw new TypeError("cached input price cannot exceed input price");
  }
  return Object.freeze(normalized);
}

function billedComponent(tokens, rate) {
  const numerator = BigInt(tokens) * BigInt(rate);
  return Number((numerator + 999_999n) / 1_000_000n);
}

export function calculateAiGatewayCostMicrousd({
  inputTokens = 0,
  cachedInputTokens = 0,
  outputTokens = 0,
  pricing,
} = {}) {
  const rates = normalizeAiGatewayPricing(pricing);
  const input = integer(inputTokens, "input tokens", { maximum: 10_000_000 });
  const cached = integer(cachedInputTokens, "cached input tokens", {
    maximum: input,
  });
  const output = integer(outputTokens, "output tokens", { maximum: 10_000_000 });
  return (
    billedComponent(input - cached, rates.inputMicrousdPerMillion) +
    billedComponent(cached, rates.cachedInputMicrousdPerMillion) +
    billedComponent(output, rates.outputMicrousdPerMillion)
  );
}

export function createAiGatewayBudgetProfile({
  pricing,
  dailySuccessLimit = AI_PARTNER_LIMITS.dailyBurst,
  cycleSuccessLimit = AI_PARTNER_LIMITS.cycleSuccess,
  pilotUsers = AI_PARTNER_LIMITS.pilotUsers,
  userCostCeilingMicrousd = AI_PARTNER_LIMITS.userCycleCostCeilingMicrousd,
  globalCostCeilingMicrousd = AI_PARTNER_LIMITS.globalCycleCostCeilingMicrousd,
} = {}) {
  const rates = normalizeAiGatewayPricing(pricing);
  const daily = integer(dailySuccessLimit, "daily success limit", {
    minimum: 1,
    maximum: AI_PARTNER_LIMITS.dailyBurst,
  });
  const cycle = integer(cycleSuccessLimit, "cycle success limit", {
    minimum: daily,
    maximum: AI_PARTNER_LIMITS.cycleSuccess,
  });
  const users = integer(pilotUsers, "pilot users", {
    minimum: 1,
    maximum: AI_PARTNER_LIMITS.pilotUsers,
  });
  const userCost = integer(userCostCeilingMicrousd, "user cost ceiling", {
    minimum: 1,
    maximum: AI_PARTNER_LIMITS.userCycleCostCeilingMicrousd,
  });
  const globalCost = integer(globalCostCeilingMicrousd, "global cost ceiling", {
    minimum: userCost,
    maximum: AI_PARTNER_LIMITS.globalCycleCostCeilingMicrousd,
  });
  const minimumRate = Math.min(
    rates.inputMicrousdPerMillion,
    rates.cachedInputMicrousdPerMillion,
    rates.outputMicrousdPerMillion,
  );
  const userTokenCeiling = Math.floor((userCost * 1_000_000) / minimumRate);
  const globalTokenCeiling = Math.floor((globalCost * 1_000_000) / minimumRate);
  if (!Number.isSafeInteger(userTokenCeiling) || userTokenCeiling < 1) {
    throw new TypeError("user token ceiling cannot be derived safely");
  }
  if (!Number.isSafeInteger(globalTokenCeiling) || globalTokenCeiling < userTokenCeiling) {
    throw new TypeError("global token ceiling cannot be derived safely");
  }
  return Object.freeze({
    pricing: rates,
    dailySuccessLimit: daily,
    cycleSuccessLimit: cycle,
    pilotUsers: users,
    maxConcurrentPerUser: 1,
    maxProviderRetries: 1,
    userCostCeilingMicrousd: userCost,
    globalCostCeilingMicrousd: globalCost,
    userTokenCeiling,
    globalTokenCeiling,
    cycleDays: 30,
    cycleCarryoverEnabled: false,
  });
}

export function calculateAiGatewayReservation({
  estimatedInputTokens,
  maxOutputTokens,
  pricing,
  externalPrimary = true,
} = {}) {
  const input = integer(estimatedInputTokens, "estimated input tokens", {
    minimum: 1,
    maximum: AI_GATEWAY_HARD_LIMITS.maxInputTokens,
  });
  const output = integer(maxOutputTokens, "maximum output tokens", {
    minimum: 1,
    maximum: AI_GATEWAY_HARD_LIMITS.maxOutputTokens,
  });
  const rates = normalizeAiGatewayPricing(pricing);
  const externalAttempts = externalPrimary
    ? AI_GATEWAY_HARD_LIMITS.maxExternalAttempts
    : 0;
  const fallbackAttempts = 1;
  const tokensPerAttempt = input + output;
  const reservedBilledTokens = tokensPerAttempt * (externalAttempts + fallbackAttempts);
  const worstExternalAttemptCost = calculateAiGatewayCostMicrousd({
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: 0,
    pricing: rates,
  });
  return Object.freeze({
    estimatedInputTokens: input,
    maxOutputTokens: output,
    reservedBilledTokens,
    reservedCostMicrousd: worstExternalAttemptCost * externalAttempts,
    externalAttempts,
    fallbackAttempts,
  });
}

export function createVerifiedAdminGatewayContext({
  actorTelegramId,
  ownerTelegramId = actorTelegramId,
  isAdmin,
  purpose = "closed_benchmark",
  at,
  userCycleStartAt,
  userCycleEndAt,
  globalCycleStartAt,
  globalCycleEndAt,
  benchmarkApproval,
  externalConsent = null,
  dataClass = "public",
  cacheAllowed = true,
} = {}) {
  const timestamp = integer(at, "context timestamp", { minimum: 1 });
  const actor = integer(actorTelegramId, "actor Telegram id", { minimum: 1 });
  const owner = integer(ownerTelegramId, "owner Telegram id", { minimum: 1 });
  if (actor !== owner) throw new Error("AI Gateway owner scope denied");
  if (isAdmin !== true) throw new Error("AI Gateway is closed to non-admin users");
  if (purpose !== "closed_benchmark" && purpose !== "admin_chat") {
    throw new Error("AI Gateway public purpose is not available in v1.3.8");
  }
  const verifiedDataClass = String(dataClass || "").trim().toLowerCase();
  if (verifiedDataClass !== "public" && verifiedDataClass !== "private") {
    throw new TypeError("verified data class must be public or private");
  }
  if (typeof cacheAllowed !== "boolean") {
    throw new TypeError("verified cache permission must be boolean");
  }
  const userCycle = normalizeCycleWindow(
    userCycleStartAt,
    userCycleEndAt,
    timestamp,
    "user cycle",
  );
  const globalCycle = normalizeCycleWindow(
    globalCycleStartAt,
    globalCycleEndAt,
    timestamp,
    "global cycle",
  );
  const approval = benchmarkApproval && typeof benchmarkApproval === "object"
    ? Object.freeze({
      approvalIdHash: normalizeHash(
        benchmarkApproval.approvalIdHash,
        "benchmark approval hash",
      ),
      approvedAt: integer(benchmarkApproval.approvedAt, "approval timestamp", {
        minimum: 1,
        maximum: timestamp,
      }),
      expiresAt: integer(benchmarkApproval.expiresAt, "approval expiry", {
        minimum: timestamp + 1,
      }),
      scope: nonEmptyString(benchmarkApproval.scope, "approval scope", {
        minimum: 8,
        maximum: 80,
      }),
    })
    : null;
  if (
    approval &&
    (approval.scope !== AI_PARTNER_MODEL_ALIASES.dragon ||
      approval.expiresAt - approval.approvedAt > 3_600)
  ) {
    throw new Error("invalid closed benchmark approval");
  }
  const consent = externalConsent && typeof externalConsent === "object"
    ? Object.freeze({
      version: nonEmptyString(externalConsent.version, "external consent version", {
        minimum: 8,
        maximum: 80,
      }),
      consentedAt: integer(externalConsent.consentedAt, "external consent timestamp", {
        minimum: 1,
        maximum: timestamp,
      }),
      revokedAt: externalConsent.revokedAt === null || externalConsent.revokedAt === undefined
        ? null
        : integer(externalConsent.revokedAt, "external consent revocation", {
          minimum: 1,
          maximum: timestamp,
        }),
    })
    : null;
  const context = Object.freeze({
    actorTelegramId: actor,
    ownerTelegramId: owner,
    isAdmin: true,
    purpose,
    dataClass: verifiedDataClass,
    cacheAllowed,
    at: timestamp,
    usageDate: usageDateFromEpoch(timestamp),
    userCycle,
    globalCycle,
    benchmarkApproval: approval,
    externalConsent: consent,
  });
  VERIFIED_GATEWAY_CONTEXTS.add(context);
  return context;
}

function assertVerifiedGatewayContext(context, { requireExternalApproval = false } = {}) {
  if (!context || !VERIFIED_GATEWAY_CONTEXTS.has(context)) {
    throw new Error("verified AI Gateway context is required");
  }
  if (context.actorTelegramId !== context.ownerTelegramId || context.isAdmin !== true) {
    throw new Error("AI Gateway owner/admin boundary denied");
  }
  if (requireExternalApproval) {
    if (context.purpose === "admin_chat") {
      const consent = context.externalConsent;
      if (
        !consent ||
        consent.version !== AI_GATEWAY_PROVIDER_CONSENT_VERSION ||
        context.at < consent.consentedAt ||
        consent.revokedAt !== null
      ) {
        throw new Error("current admin chat external consent is required");
      }
    } else {
      const approval = context.benchmarkApproval;
      if (
        !approval ||
        approval.scope !== AI_PARTNER_MODEL_ALIASES.dragon ||
        context.at < approval.approvedAt ||
        context.at >= approval.expiresAt
      ) {
        throw new Error("separate closed benchmark approval is required");
      }
    }
  }
  return context;
}

export function hasCurrentExternalProviderConsent(context) {
  assertVerifiedGatewayContext(context);
  const consent = context.externalConsent;
  return Boolean(
    consent &&
    consent.version === AI_GATEWAY_PROVIDER_CONSENT_VERSION &&
    consent.consentedAt <= context.at &&
    consent.revokedAt === null,
  );
}

function redactString(value, redactions, ownerTelegramId) {
  let normalized = String(value);
  for (const blockingPattern of BLOCKING_SECRET_PATTERNS) {
    blockingPattern.lastIndex = 0;
    if (blockingPattern.test(normalized)) {
      redactions.push("secret_material");
      return { value: "[BLOCKED_SECRET]", blocked: true };
    }
  }
  const ownerText = String(ownerTelegramId || "");
  if (ownerText && new RegExp(`(^|\\D)${ownerText}(?=\\D|$)`).test(normalized)) {
    redactions.push("telegram_id");
    normalized = normalized.replace(
      new RegExp(`(^|\\D)${ownerText}(?=\\D|$)`, "g"),
      (_, prefix) => `${prefix}[REDACTED_TELEGRAM_ID]`,
    );
  }
  for (const { code, pattern } of REDACTION_PATTERNS) {
    pattern.lastIndex = 0;
    if (!pattern.test(normalized)) continue;
    pattern.lastIndex = 0;
    redactions.push(code);
    normalized = normalized.replace(pattern, (match, prefix = "") => {
      return code === "telegram_username" ? `${prefix}[REDACTED_USERNAME]` : `[REDACTED_${code.toUpperCase()}]`;
    });
  }
  return { value: normalized, blocked: false };
}

function redactValue(value, redactions, key = "", ownerTelegramId = null) {
  if (ALWAYS_REDACT_KEYS.has(canonicalFieldName(key))) {
    redactions.push(`field:${key}`);
    return "[REDACTED_FIELD]";
  }
  if (typeof value === "string") {
    return redactString(value, redactions, ownerTelegramId).value;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, redactions, "", ownerTelegramId));
  }
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      redactValue(child, redactions, childKey, ownerTelegramId),
    ]),
  );
}

export function redactAiGatewayPayload({
  payload,
  dataClass = "public",
  context,
  external = false,
} = {}) {
  assertVerifiedGatewayContext(context, { requireExternalApproval: external });
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("provider payload must be an object");
  }
  assertNoClientRoutingFields(payload);
  const classification = String(dataClass || "").trim().toLowerCase();
  if (classification !== "public" && classification !== "private") {
    throw new TypeError("data class must be public or private");
  }
  if (classification !== context.dataClass) {
    throw new Error("provider data classification is not server-verified");
  }
  if (external && classification === "private" && !hasCurrentExternalProviderConsent(context)) {
    return Object.freeze({
      allowed: false,
      reason: "external_private_consent_required",
      dataClass: classification,
      payload: null,
      redactionCodes: Object.freeze([]),
    });
  }
  const redactions = [];
  const redacted = redactValue(
    cloneJson(payload),
    redactions,
    "",
    context.ownerTelegramId,
  );
  const serialized = canonicalJson(redacted);
  if (serialized.length > AI_GATEWAY_HARD_LIMITS.maximumPayloadCharacters) {
    return Object.freeze({
      allowed: false,
      reason: "provider_payload_too_large",
      dataClass: classification,
      payload: null,
      redactionCodes: Object.freeze(unique(redactions)),
    });
  }
  if (redactions.includes("secret_material")) {
    return Object.freeze({
      allowed: false,
      reason: "secret_material_blocked",
      dataClass: classification,
      payload: null,
      redactionCodes: Object.freeze(unique(redactions)),
    });
  }
  return Object.freeze({
    allowed: true,
    reason: "allowed",
    dataClass: classification,
    payload: deepFreeze(redacted),
    redactionCodes: Object.freeze(unique(redactions)),
  });
}

export async function createAiGatewayCacheDescriptor({
  dataClass,
  payload,
  ownerTelegramId,
  modelAlias,
  policyVersion = AI_PARTNER_POLICY_VERSION,
  allowCache = true,
  cacheScopeSecret,
  cryptoImpl = globalThis.crypto,
} = {}) {
  const classification = String(dataClass || "").trim().toLowerCase();
  if (classification !== "public" && classification !== "private") {
    throw new TypeError("data class must be public or private");
  }
  if (!AI_GATEWAY_MODEL_ROUTES[modelAlias]) throw new TypeError("unsupported model alias");
  if (allowCache !== true) {
    return Object.freeze({ cacheScope: "none", cacheKeyHash: null, publicEligible: false });
  }
  const payloadHash = await sha256Hex(canonicalJson(payload), cryptoImpl);
  if (classification === "public") {
    const cacheKeyHash = await sha256Hex(
      `re-ai-public:v1:${policyVersion}:${modelAlias}:${payloadHash}`,
      cryptoImpl,
    );
    return Object.freeze({ cacheScope: "public", cacheKeyHash, publicEligible: true });
  }
  const owner = integer(ownerTelegramId, "cache owner", { minimum: 1 });
  const cacheKeyHash = await hmacHex(
    `re-ai-private:v1:${owner}:${policyVersion}:${modelAlias}:${payloadHash}`,
    cacheScopeSecret,
    cryptoImpl,
  );
  return Object.freeze({ cacheScope: "private", cacheKeyHash, publicEligible: false });
}

export function buildAiGatewayProviderEnvelope({
  modelAlias,
  payload,
  providerUserId,
  maxOutputTokens,
  cacheDescriptor,
} = {}) {
  const route = AI_GATEWAY_MODEL_ROUTES[modelAlias];
  if (!route) throw new TypeError("unsupported server-side model alias");
  if (!/^reai_[0-9a-f]{40}$/.test(String(providerUserId || ""))) {
    throw new TypeError("provider-scoped user id is required");
  }
  const outputLimit = integer(maxOutputTokens, "maximum output tokens", {
    minimum: 1,
    maximum: AI_GATEWAY_HARD_LIMITS.maxOutputTokens,
  });
  assertNoClientRoutingFields(payload);
  const cache = cacheDescriptor || {
    cacheScope: "none",
    cacheKeyHash: null,
    publicEligible: false,
  };
  if (cache.cacheScope === "public" && cache.publicEligible !== true) {
    throw new Error("private AI content cannot enter public cache");
  }
  return deepFreeze({
    modelAlias,
    providerCode: route.providerCode,
    providerModel: route.providerModel,
    thinkingEnabled: false,
    tools: Object.freeze([]),
    internetEnabled: false,
    providerUserId,
    maxOutputTokens: outputLimit,
    cache: Object.freeze({
      scope: cache.cacheScope,
      keyHash: cache.cacheKeyHash,
    }),
    payload: cloneJson(payload),
  });
}

async function readGatewayReservation(db, requestId) {
  return db.prepare(
    `SELECT q.request_id, q.telegram_id, q.usage_date, q.bucket,
            q.status AS legacy_state,
            b.owner_telegram_id, b.user_cycle_start_at, b.user_cycle_end_at,
            b.global_cycle_start_at, b.global_cycle_end_at,
            b.reserved_billed_tokens, b.reserved_cost_microusd,
            b.reservation_state, b.policy_version, b.pricing_version,
            b.created_at, b.completed_at
     FROM ai_quota_reservations q
     LEFT JOIN ai_gateway_budget_reservations b
       ON b.request_id = q.request_id
     WHERE q.request_id = ?
     LIMIT 1`,
  ).bind(requestId).first();
}

export async function getAiGatewayBudgetSnapshot(db, {
  context,
  profile,
} = {}) {
  const verified = assertVerifiedGatewayContext(context);
  const limits = createAiGatewayBudgetProfile(profile || {});
  const row = await db.prepare(
    `WITH
       user_attempts AS (
         SELECT
           COALESCE(SUM(a.input_tokens + a.output_tokens), 0) AS tokens,
           COALESCE(SUM(a.cost_microusd), 0) AS cost
         FROM ai_gateway_attempts a
         JOIN ai_gateway_budget_reservations b ON b.request_id = a.request_id
         WHERE b.owner_telegram_id = ? AND b.user_cycle_start_at = ?
       ),
       global_attempts AS (
         SELECT
           COALESCE(SUM(a.input_tokens + a.output_tokens), 0) AS tokens,
           COALESCE(SUM(a.cost_microusd), 0) AS cost
         FROM ai_gateway_attempts a
         JOIN ai_gateway_budget_reservations b ON b.request_id = a.request_id
         WHERE b.global_cycle_start_at = ?
       ),
       user_active AS (
         SELECT
           COALESCE(SUM(MAX(
             b.reserved_billed_tokens - COALESCE((
               SELECT SUM(a.input_tokens + a.output_tokens)
               FROM ai_gateway_attempts a WHERE a.request_id = b.request_id
             ), 0), 0
           )), 0) AS tokens,
           COALESCE(SUM(MAX(
             b.reserved_cost_microusd - COALESCE((
               SELECT SUM(a.cost_microusd)
               FROM ai_gateway_attempts a WHERE a.request_id = b.request_id
             ), 0), 0
           )), 0) AS cost,
           COUNT(*) AS requests
         FROM ai_gateway_budget_reservations b
         WHERE b.owner_telegram_id = ? AND b.user_cycle_start_at = ?
           AND b.reservation_state = 'reserved'
       ),
       global_active AS (
         SELECT
           COALESCE(SUM(MAX(
             b.reserved_billed_tokens - COALESCE((
               SELECT SUM(a.input_tokens + a.output_tokens)
               FROM ai_gateway_attempts a WHERE a.request_id = b.request_id
             ), 0), 0
           )), 0) AS tokens,
           COALESCE(SUM(MAX(
             b.reserved_cost_microusd - COALESCE((
               SELECT SUM(a.cost_microusd)
               FROM ai_gateway_attempts a WHERE a.request_id = b.request_id
             ), 0), 0
           )), 0) AS cost
         FROM ai_gateway_budget_reservations b
         WHERE b.global_cycle_start_at = ? AND b.reservation_state = 'reserved'
       )
     SELECT
       (SELECT COUNT(*) FROM ai_usage_events u
        JOIN ai_gateway_budget_reservations b ON b.request_id = u.request_id
        WHERE b.owner_telegram_id = ? AND u.usage_date = ?
          AND u.status = 'success') AS daily_successes,
       (SELECT COUNT(*) FROM ai_usage_events u
        JOIN ai_gateway_budget_reservations b ON b.request_id = u.request_id
        WHERE b.owner_telegram_id = ? AND b.user_cycle_start_at = ?
          AND u.status = 'success') AS cycle_successes,
       (SELECT COUNT(DISTINCT b.owner_telegram_id)
        FROM ai_gateway_budget_reservations b
        WHERE b.global_cycle_start_at = ?) AS pilot_users,
       (SELECT COUNT(*) FROM ai_gateway_budget_reservations b
        WHERE (
          (b.owner_telegram_id = ? AND b.user_cycle_start_at = ?)
          OR b.global_cycle_start_at = ?
        ) AND b.pricing_version != ?) AS pricing_mismatches,
       (SELECT COUNT(*) FROM ai_quota_reservations q
        WHERE q.telegram_id = ? AND q.status = 'reserved') AS all_active_requests,
       user_attempts.tokens AS user_billed_tokens,
       user_attempts.cost AS user_cost_microusd,
       user_active.tokens AS user_reserved_tokens,
       user_active.cost AS user_reserved_cost_microusd,
       user_active.requests AS user_gateway_active_requests,
       global_attempts.tokens AS global_billed_tokens,
       global_attempts.cost AS global_cost_microusd,
       global_active.tokens AS global_reserved_tokens,
       global_active.cost AS global_reserved_cost_microusd
     FROM user_attempts, global_attempts, user_active, global_active`,
  ).bind(
    verified.ownerTelegramId,
    verified.userCycle.startAt,
    verified.globalCycle.startAt,
    verified.ownerTelegramId,
    verified.userCycle.startAt,
    verified.globalCycle.startAt,
    verified.ownerTelegramId,
    verified.usageDate,
    verified.ownerTelegramId,
    verified.userCycle.startAt,
    verified.globalCycle.startAt,
    verified.ownerTelegramId,
    verified.userCycle.startAt,
    verified.globalCycle.startAt,
    limits.pricing.version,
    verified.ownerTelegramId,
  ).first();
  const snapshot = {
    usageDate: verified.usageDate,
    dailySuccesses: Number(row?.daily_successes || 0),
    cycleSuccesses: Number(row?.cycle_successes || 0),
    pilotUsers: Number(row?.pilot_users || 0),
    pricingMismatches: Number(row?.pricing_mismatches || 0),
    activeRequests: Number(row?.all_active_requests || 0),
    userBilledTokens: Number(row?.user_billed_tokens || 0),
    userReservedTokens: Number(row?.user_reserved_tokens || 0),
    userCostMicrousd: Number(row?.user_cost_microusd || 0),
    userReservedCostMicrousd: Number(row?.user_reserved_cost_microusd || 0),
    globalBilledTokens: Number(row?.global_billed_tokens || 0),
    globalReservedTokens: Number(row?.global_reserved_tokens || 0),
    globalCostMicrousd: Number(row?.global_cost_microusd || 0),
    globalReservedCostMicrousd: Number(row?.global_reserved_cost_microusd || 0),
  };
  return Object.freeze({ ...snapshot, profile: limits });
}

function budgetDenialReason(snapshot, reservation, profile) {
  if (snapshot.activeRequests >= 1) return "busy";
  if (snapshot.pricingMismatches > 0) return "pricing_cycle_mismatch";
  if (snapshot.dailySuccesses >= profile.dailySuccessLimit) return "daily_burst";
  if (snapshot.cycleSuccesses >= profile.cycleSuccessLimit) return "cycle_success_pool";
  if (
    snapshot.userBilledTokens + snapshot.userReservedTokens +
      reservation.reservedBilledTokens > profile.userTokenCeiling
  ) return "user_token_ceiling";
  if (
    snapshot.globalBilledTokens + snapshot.globalReservedTokens +
      reservation.reservedBilledTokens > profile.globalTokenCeiling
  ) return "global_token_ceiling";
  if (
    snapshot.userCostMicrousd + snapshot.userReservedCostMicrousd +
      reservation.reservedCostMicrousd > profile.userCostCeilingMicrousd
  ) return "user_cost_ceiling";
  if (
    snapshot.globalCostMicrousd + snapshot.globalReservedCostMicrousd +
      reservation.reservedCostMicrousd > profile.globalCostCeilingMicrousd
  ) return "global_cost_ceiling";
  if (snapshot.pilotUsers >= profile.pilotUsers) return "pilot_capacity";
  return "budget_unavailable";
}

export async function reserveAiGatewayBudget(db, {
  context,
  requestId,
  reservation,
  profile,
  policyVersion = AI_PARTNER_POLICY_VERSION,
} = {}) {
  const verified = assertVerifiedGatewayContext(context);
  const id = normalizeRequestId(requestId);
  const limits = createAiGatewayBudgetProfile(profile || {});
  const reservedTokens = integer(
    reservation?.reservedBilledTokens,
    "reserved billed tokens",
    { minimum: 1, maximum: 100_000_000 },
  );
  const reservedCost = integer(
    reservation?.reservedCostMicrousd,
    "reserved cost",
    { maximum: AI_PARTNER_LIMITS.userCycleCostCeilingMicrousd },
  );
  if (reservedTokens > limits.userTokenCeiling) {
    return Object.freeze({ ok: false, reason: "user_token_ceiling", replay: false });
  }
  if (reservedCost > limits.userCostCeilingMicrousd) {
    return Object.freeze({ ok: false, reason: "user_cost_ceiling", replay: false });
  }
  const existing = await readGatewayReservation(db, id);
  if (existing) {
    if (!existing.owner_telegram_id) {
      throw new Error("request id collides with a legacy AI reservation");
    }
    if (Number(existing.owner_telegram_id) !== verified.ownerTelegramId) {
      throw new Error("AI Gateway reservation replay owner mismatch");
    }
    return Object.freeze({
      ok: true,
      replay: true,
      requestId: id,
      state: String(existing.reservation_state),
      reservedBilledTokens: Number(existing.reserved_billed_tokens),
      reservedCostMicrousd: Number(existing.reserved_cost_microusd),
    });
  }

  const quotaInsert = db.prepare(
    `WITH
       user_attempts AS (
         SELECT
           COALESCE(SUM(a.input_tokens + a.output_tokens), 0) AS tokens,
           COALESCE(SUM(a.cost_microusd), 0) AS cost
         FROM ai_gateway_attempts a
         JOIN ai_gateway_budget_reservations b ON b.request_id = a.request_id
         WHERE b.owner_telegram_id = ? AND b.user_cycle_start_at = ?
       ),
       global_attempts AS (
         SELECT
           COALESCE(SUM(a.input_tokens + a.output_tokens), 0) AS tokens,
           COALESCE(SUM(a.cost_microusd), 0) AS cost
         FROM ai_gateway_attempts a
         JOIN ai_gateway_budget_reservations b ON b.request_id = a.request_id
         WHERE b.global_cycle_start_at = ?
       ),
       user_active AS (
         SELECT
           COALESCE(SUM(MAX(
             b.reserved_billed_tokens - COALESCE((
               SELECT SUM(a.input_tokens + a.output_tokens)
               FROM ai_gateway_attempts a WHERE a.request_id = b.request_id
             ), 0), 0
           )), 0) AS tokens,
           COALESCE(SUM(MAX(
             b.reserved_cost_microusd - COALESCE((
               SELECT SUM(a.cost_microusd)
               FROM ai_gateway_attempts a WHERE a.request_id = b.request_id
             ), 0), 0
           )), 0) AS cost
         FROM ai_gateway_budget_reservations b
         WHERE b.owner_telegram_id = ? AND b.user_cycle_start_at = ?
           AND b.reservation_state = 'reserved'
       ),
       global_active AS (
         SELECT
           COALESCE(SUM(MAX(
             b.reserved_billed_tokens - COALESCE((
               SELECT SUM(a.input_tokens + a.output_tokens)
               FROM ai_gateway_attempts a WHERE a.request_id = b.request_id
             ), 0), 0
           )), 0) AS tokens,
           COALESCE(SUM(MAX(
             b.reserved_cost_microusd - COALESCE((
               SELECT SUM(a.cost_microusd)
               FROM ai_gateway_attempts a WHERE a.request_id = b.request_id
             ), 0), 0
           )), 0) AS cost
         FROM ai_gateway_budget_reservations b
         WHERE b.global_cycle_start_at = ? AND b.reservation_state = 'reserved'
       )
     INSERT OR IGNORE INTO ai_quota_reservations
       (request_id, telegram_id, usage_date, bucket, reserved_milli,
        status, created_at, completed_at)
     SELECT ?, ?, ?, 'admin', 1, 'reserved', datetime(?, 'unixepoch'), NULL
     WHERE
       NOT EXISTS (
         SELECT 1 FROM ai_quota_reservations active
         WHERE active.telegram_id = ? AND active.status = 'reserved'
       )
       AND
       (SELECT COUNT(*) FROM ai_usage_events u
        JOIN ai_gateway_budget_reservations b ON b.request_id = u.request_id
        WHERE b.owner_telegram_id = ? AND u.usage_date = ?
          AND u.status = 'success') < ?
       AND
       (SELECT COUNT(*) FROM ai_usage_events u
        JOIN ai_gateway_budget_reservations b ON b.request_id = u.request_id
        WHERE b.owner_telegram_id = ? AND b.user_cycle_start_at = ?
          AND u.status = 'success') < ?
       AND (SELECT tokens FROM user_attempts)
         + (SELECT tokens FROM user_active) + ? <= ?
       AND (SELECT cost FROM user_attempts)
         + (SELECT cost FROM user_active) + ? <= ?
       AND (SELECT tokens FROM global_attempts)
         + (SELECT tokens FROM global_active) + ? <= ?
       AND (SELECT cost FROM global_attempts)
         + (SELECT cost FROM global_active) + ? <= ?
       AND NOT EXISTS (
         SELECT 1 FROM ai_gateway_budget_reservations b
         WHERE (
           (b.owner_telegram_id = ? AND b.user_cycle_start_at = ?)
           OR b.global_cycle_start_at = ?
         ) AND b.pricing_version != ?
       )
       AND (
         EXISTS (
           SELECT 1 FROM ai_gateway_budget_reservations b
           WHERE b.owner_telegram_id = ? AND b.global_cycle_start_at = ?
         )
         OR (SELECT COUNT(DISTINCT b.owner_telegram_id)
             FROM ai_gateway_budget_reservations b
             WHERE b.global_cycle_start_at = ?) < ?
       )`,
  ).bind(
    verified.ownerTelegramId,
    verified.userCycle.startAt,
    verified.globalCycle.startAt,
    verified.ownerTelegramId,
    verified.userCycle.startAt,
    verified.globalCycle.startAt,
    id,
    verified.ownerTelegramId,
    verified.usageDate,
    verified.at,
    verified.ownerTelegramId,
    verified.ownerTelegramId,
    verified.usageDate,
    limits.dailySuccessLimit,
    verified.ownerTelegramId,
    verified.userCycle.startAt,
    limits.cycleSuccessLimit,
    reservedTokens,
    limits.userTokenCeiling,
    reservedCost,
    limits.userCostCeilingMicrousd,
    reservedTokens,
    limits.globalTokenCeiling,
    reservedCost,
    limits.globalCostCeilingMicrousd,
    verified.ownerTelegramId,
    verified.userCycle.startAt,
    verified.globalCycle.startAt,
    limits.pricing.version,
    verified.ownerTelegramId,
    verified.globalCycle.startAt,
    verified.globalCycle.startAt,
    limits.pilotUsers,
  );
  const budgetInsert = db.prepare(
    `INSERT INTO ai_gateway_budget_reservations (
       request_id, owner_telegram_id, usage_date,
       user_cycle_start_at, user_cycle_end_at,
       global_cycle_start_at, global_cycle_end_at,
       reserved_billed_tokens, reserved_cost_microusd,
       reservation_state, policy_version, pricing_version, created_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?
     FROM ai_quota_reservations q
     WHERE q.request_id = ? AND q.telegram_id = ? AND q.status = 'reserved'`,
  ).bind(
    id,
    verified.ownerTelegramId,
    verified.usageDate,
    verified.userCycle.startAt,
    verified.userCycle.endAt,
    verified.globalCycle.startAt,
    verified.globalCycle.endAt,
    reservedTokens,
    reservedCost,
    nonEmptyString(policyVersion, "policy version", { minimum: 8, maximum: 80 }),
    limits.pricing.version,
    verified.at,
    id,
    verified.ownerTelegramId,
  );

  let results;
  try {
    results = await db.batch([quotaInsert, budgetInsert]);
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || error))) {
      const snapshot = await getAiGatewayBudgetSnapshot(db, {
        context: verified,
        profile: limits,
      });
      return Object.freeze({
        ok: false,
        reason: budgetDenialReason(snapshot, {
          reservedBilledTokens: reservedTokens,
          reservedCostMicrousd: reservedCost,
        }, limits),
        replay: false,
        snapshot,
      });
    }
    throw error;
  }
  if (statementChanged(results?.[1])) {
    return Object.freeze({
      ok: true,
      replay: false,
      requestId: id,
      state: "reserved",
      reservedBilledTokens: reservedTokens,
      reservedCostMicrousd: reservedCost,
    });
  }
  const snapshot = await getAiGatewayBudgetSnapshot(db, {
    context: verified,
    profile: limits,
  });
  return Object.freeze({
    ok: false,
    reason: budgetDenialReason(snapshot, {
      reservedBilledTokens: reservedTokens,
      reservedCostMicrousd: reservedCost,
    }, limits),
    replay: false,
    snapshot,
  });
}

export async function releaseStaleAiGatewayReservations(db, {
  beforeAt,
  at,
  ownerTelegramId,
} = {}) {
  const journalTable=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_operation_journal'").first();
  const journalFilter=journalTable?.name==='ai_operation_journal'?" AND NOT EXISTS(SELECT 1 FROM ai_operation_journal j WHERE COALESCE(json_extract(j.policy_json,'$.ledgerRequestId'),j.request_id)=b.request_id)":"";
  const plainJournalFilter=journalTable?.name==='ai_operation_journal'?" AND NOT EXISTS(SELECT 1 FROM ai_operation_journal j WHERE COALESCE(json_extract(j.policy_json,'$.ledgerRequestId'),j.request_id)=ai_gateway_budget_reservations.request_id)":"";
  const cutoff = integer(beforeAt, "stale reservation cutoff", { minimum: 1 });
  const timestamp = integer(at, "stale reservation release timestamp", {
    minimum: cutoff,
  });
  const owner = integer(ownerTelegramId, "stale reservation owner", { minimum: 1 });
  const stale = await db.prepare(
    `SELECT COUNT(*) AS candidates,
            COALESCE(SUM(CASE
              WHEN q.request_id IS NULL
                OR q.telegram_id != ?
                OR q.status != 'reserved'
              THEN 1 ELSE 0 END), 0) AS mismatches
     FROM ai_gateway_budget_reservations b
     LEFT JOIN ai_quota_reservations q ON q.request_id = b.request_id
     WHERE b.reservation_state = 'reserved'
       AND b.owner_telegram_id = ?
       AND b.created_at < ?${journalFilter}`,
  ).bind(owner, owner, cutoff).first();
  const candidates = Number(stale?.candidates || 0);
  const mismatches = Number(stale?.mismatches || 0);
  if (mismatches !== 0) {
    throw new Error("AI Gateway stale reservation ledger mismatch");
  }
  if (candidates === 0) return Object.freeze({ released: 0 });

  const quotaUpdate = db.prepare(
    `UPDATE ai_quota_reservations
     SET status = 'released', completed_at = datetime(?, 'unixepoch')
     WHERE status = 'reserved'
       AND telegram_id = ?
       AND request_id IN (
       SELECT request_id FROM ai_gateway_budget_reservations
       WHERE reservation_state = 'reserved'
         AND owner_telegram_id = ?
         AND created_at < ?${plainJournalFilter}
     )`,
  ).bind(timestamp, owner, owner, cutoff);
  const budgetUpdate = db.prepare(
    `UPDATE ai_gateway_budget_reservations
     SET reservation_state = 'released', completed_at = ?
     WHERE reservation_state = 'reserved'
       AND owner_telegram_id = ?
       AND created_at < ?${plainJournalFilter}`,
  ).bind(timestamp, owner, cutoff);
  const results = await db.batch([quotaUpdate, budgetUpdate]);
  const quotaReleased = Number(
    results?.[0]?.meta?.changes ?? results?.[0]?.changes ?? 0,
  );
  const budgetReleased = Number(
    results?.[1]?.meta?.changes ?? results?.[1]?.changes ?? 0,
  );
  if (quotaReleased !== budgetReleased) {
    throw new Error("AI Gateway stale reservation release was not atomic");
  }
  return Object.freeze({
    released: budgetReleased,
  });
}

export async function archiveAndPurgeAiGatewayTelemetry(db, { at } = {}) {
  const timestamp = integer(at, "telemetry retention timestamp", { minimum: 1 });
  const journalTable=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_operation_journal'").first();
  const journalFilter=journalTable?.name==='ai_operation_journal'?" AND NOT EXISTS(SELECT 1 FROM ai_operation_journal j WHERE COALESCE(json_extract(j.policy_json,'$.ledgerRequestId'),j.request_id)=b.request_id)":"";
  const plainJournalFilter=journalTable?.name==='ai_operation_journal'?" AND NOT EXISTS(SELECT 1 FROM ai_operation_journal j WHERE COALESCE(json_extract(j.policy_json,'$.ledgerRequestId'),j.request_id)=ai_gateway_budget_reservations.request_id)":"";
  const cutoff = timestamp - AI_PARTNER_LIMITS.telemetryRetentionDays * 24 * 60 * 60;
  if (cutoff <= 0) throw new TypeError("telemetry retention cutoff is invalid");
  const usageAggregate = db.prepare(
    `INSERT INTO ai_gateway_daily_aggregates (
       usage_date, model_alias, provider_code, attempt_status,
       request_count, attempt_count, input_tokens, cached_input_tokens,
       output_tokens, cost_microusd, latency_ms, aggregated_at
     )
     SELECT b.usage_date, a.model_alias, a.provider_code, a.attempt_status,
            COUNT(DISTINCT a.request_id), COUNT(*),
            COALESCE(SUM(a.input_tokens), 0),
            COALESCE(SUM(a.cached_input_tokens), 0),
            COALESCE(SUM(a.output_tokens), 0),
            COALESCE(SUM(a.cost_microusd), 0),
            COALESCE(SUM(a.latency_ms), 0), ?
     FROM ai_gateway_attempts a
     JOIN ai_gateway_budget_reservations b ON b.request_id = a.request_id
     WHERE b.reservation_state IN ('consumed', 'released')
       AND b.completed_at < ?${journalFilter}
     GROUP BY b.usage_date, a.model_alias, a.provider_code, a.attempt_status
     ON CONFLICT(usage_date, model_alias, provider_code, attempt_status)
     DO UPDATE SET
       request_count = request_count + excluded.request_count,
       attempt_count = attempt_count + excluded.attempt_count,
       input_tokens = input_tokens + excluded.input_tokens,
       cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cost_microusd = cost_microusd + excluded.cost_microusd,
       latency_ms = latency_ms + excluded.latency_ms,
       aggregated_at = excluded.aggregated_at`,
  ).bind(timestamp, cutoff);
  const policyAggregate = db.prepare(
    `INSERT INTO ai_gateway_policy_daily_aggregates (
       usage_date, event_type, decision, rule_code, event_count, aggregated_at
     )
     SELECT date(created_at, 'unixepoch'), event_type, decision, rule_code,
            COUNT(*), ?
     FROM ai_policy_events
     WHERE created_at < ?
     GROUP BY date(created_at, 'unixepoch'), event_type, decision, rule_code
     ON CONFLICT(usage_date, event_type, decision, rule_code)
     DO UPDATE SET
       event_count = event_count + excluded.event_count,
       aggregated_at = excluded.aggregated_at`,
  ).bind(timestamp, cutoff);
  const policyDelete = db.prepare(
    "DELETE FROM ai_policy_events WHERE created_at < ?",
  ).bind(cutoff);
  const usageDelete = db.prepare(
    `DELETE FROM ai_usage_events
     WHERE request_id IN (
       SELECT request_id FROM ai_gateway_budget_reservations
       WHERE reservation_state IN ('consumed', 'released')
         AND completed_at < ?${plainJournalFilter}
     )`,
  ).bind(cutoff);
  const reservationDelete = db.prepare(
    `DELETE FROM ai_quota_reservations
     WHERE request_id IN (
       SELECT request_id FROM ai_gateway_budget_reservations
       WHERE reservation_state IN ('consumed', 'released')
         AND completed_at < ?${plainJournalFilter}
     )`,
  ).bind(cutoff);
  const results = await db.batch([
    usageAggregate,
    policyAggregate,
    policyDelete,
    usageDelete,
    reservationDelete,
  ]);
  const changes = (index) => Number(
    results?.[index]?.meta?.changes ?? results?.[index]?.changes ?? 0,
  );
  return Object.freeze({
    retentionDays: AI_PARTNER_LIMITS.telemetryRetentionDays,
    cutoff,
    usageAggregateGroups: changes(0),
    policyAggregateGroups: changes(1),
    policyEventsDeleted: changes(2),
    usageEventsDeleted: changes(3),
    reservationsDeleted: changes(4),
  });
}

export async function recordAiGatewayAttempt(db, {
  requestId,
  attemptId,
  attemptNo,
  routeStep,
  modelAlias,
  status,
  inputTokens = 0,
  cachedInputTokens = 0,
  outputTokens = 0,
  costMicrousd = 0,
  latencyMs,
  statusCode = null,
  errorCode = "",
  at,
} = {}) {
  const id = normalizeRequestId(requestId);
  const attempt = normalizeUuid(attemptId, "attempt id");
  const number = integer(attemptNo, "attempt number", { minimum: 1, maximum: 3 });
  const route = String(routeStep || "").trim().toLowerCase();
  if (!new Set(["primary", "retry", "fallback"]).has(route)) {
    throw new TypeError("invalid AI Gateway route step");
  }
  const modelRoute = AI_GATEWAY_MODEL_ROUTES[modelAlias];
  if (!modelRoute) throw new TypeError("invalid AI Gateway model alias");
  const attemptStatus = String(status || "").trim().toLowerCase();
  if (!new Set(["success", "failed", "timeout"]).has(attemptStatus)) {
    throw new TypeError("invalid AI Gateway attempt status");
  }
  const input = integer(inputTokens, "attempt input tokens", { maximum: 10_000_000 });
  const cached = integer(cachedInputTokens, "attempt cached input tokens", {
    maximum: input,
  });
  const output = integer(outputTokens, "attempt output tokens", { maximum: 10_000_000 });
  const cost = integer(costMicrousd, "attempt cost", {
    maximum: AI_PARTNER_LIMITS.userCycleCostCeilingMicrousd,
  });
  const latency = integer(latencyMs, "attempt latency", { maximum: 300_000 });
  const httpStatus = statusCode === null || statusCode === undefined
    ? null
    : integer(statusCode, "provider status code", { minimum: 100, maximum: 599 });
  const safeError = attemptStatus === "success"
    ? ""
    : normalizeErrorCode(errorCode);
  const timestamp = integer(at, "attempt timestamp", { minimum: 1 });
  const existing = await db.prepare(
    `SELECT * FROM ai_gateway_attempts
     WHERE request_id = ? AND (attempt_no = ? OR route_step = ?)
     LIMIT 1`,
  ).bind(id, number, route).first();
  if (existing) {
    const exactReplay =
      existing.attempt_id === attempt &&
      existing.model_alias === modelAlias &&
      existing.attempt_status === attemptStatus;
    if (!exactReplay) throw new Error("AI Gateway attempt replay mismatch");
    return Object.freeze({ ok: true, replay: true, attemptId: attempt });
  }
  const result = await db.prepare(
    `INSERT INTO ai_gateway_attempts (
       attempt_id, request_id, attempt_no, route_step, model_alias,
       provider_code, attempt_status, input_tokens, cached_input_tokens,
       output_tokens, cost_microusd, latency_ms, status_code, error_code,
       created_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     FROM ai_gateway_budget_reservations b
     WHERE b.request_id = ? AND b.reservation_state = 'reserved'
       AND ? = COALESCE((
         SELECT MAX(existing.attempt_no) + 1
         FROM ai_gateway_attempts existing
         WHERE existing.request_id = b.request_id
       ), 1)
       AND COALESCE((
         SELECT SUM(existing.input_tokens + existing.output_tokens)
         FROM ai_gateway_attempts existing
         WHERE existing.request_id = b.request_id
       ), 0) + ? + ? <= b.reserved_billed_tokens
       AND COALESCE((
         SELECT SUM(existing.cost_microusd)
         FROM ai_gateway_attempts existing
         WHERE existing.request_id = b.request_id
       ), 0) + ? <= b.reserved_cost_microusd`,
  ).bind(
    attempt,
    id,
    number,
    route,
    modelAlias,
    modelRoute.providerCode,
    attemptStatus,
    input,
    cached,
    output,
    cost,
    latency,
    httpStatus,
    safeError,
    timestamp,
    id,
    number,
    input,
    output,
    cost,
  ).run();
  if (!statementChanged(result)) {
    throw new Error("AI Gateway attempt exceeded reservation or sequence");
  }
  return Object.freeze({ ok: true, replay: false, attemptId: attempt });
}

export async function summarizeAiGatewayAttempts(db, requestId) {
  const id = normalizeRequestId(requestId);
  const query = await db.prepare(
    `SELECT attempt_id, attempt_no, route_step, model_alias, provider_code,
            attempt_status, input_tokens, cached_input_tokens, output_tokens,
            cost_microusd, latency_ms, status_code, error_code, created_at
     FROM ai_gateway_attempts
     WHERE request_id = ?
     ORDER BY attempt_no, attempt_id`,
  ).bind(id).all();
  const attempts = (query?.results || []).map((row) => Object.freeze({
    attemptId: String(row.attempt_id),
    attemptNo: Number(row.attempt_no),
    routeStep: String(row.route_step),
    modelAlias: String(row.model_alias),
    providerCode: String(row.provider_code),
    status: String(row.attempt_status),
    inputTokens: Number(row.input_tokens || 0),
    cachedInputTokens: Number(row.cached_input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    costMicrousd: Number(row.cost_microusd || 0),
    latencyMs: Number(row.latency_ms || 0),
    statusCode: row.status_code === null ? null : Number(row.status_code),
    errorCode: String(row.error_code || ""),
    createdAt: Number(row.created_at),
  }));
  return Object.freeze({
    attempts: Object.freeze(attempts),
    attemptCount: attempts.length,
    retryCount: attempts.filter((entry) => entry.routeStep === "retry").length,
    fallbackUsed: attempts.some((entry) => entry.routeStep === "fallback"),
    inputTokens: attempts.reduce((sum, entry) => sum + entry.inputTokens, 0),
    cachedInputTokens: attempts.reduce((sum, entry) => sum + entry.cachedInputTokens, 0),
    outputTokens: attempts.reduce((sum, entry) => sum + entry.outputTokens, 0),
    billedTokens: attempts.reduce(
      (sum, entry) => sum + entry.inputTokens + entry.outputTokens,
      0,
    ),
    costMicrousd: attempts.reduce((sum, entry) => sum + entry.costMicrousd, 0),
    totalLatencyMs: attempts.reduce((sum, entry) => sum + entry.latencyMs, 0),
  });
}

export async function completeAiGatewayBudget(db, {
  context,
  requestId,
  outcome,
  providerUserId,
  dataClass,
  cacheDescriptor,
  sourceCount = 0,
  errorCode = "",
  at,
} = {}) {
  const verified = assertVerifiedGatewayContext(context);
  const id = normalizeRequestId(requestId);
  const resultState = String(outcome || "").trim().toLowerCase();
  if (resultState !== "success" && resultState !== "failed") {
    throw new TypeError("AI Gateway outcome must be success or failed");
  }
  if (!/^reai_[0-9a-f]{40}$/.test(String(providerUserId || ""))) {
    throw new TypeError("provider-scoped user id is required");
  }
  const classification = String(dataClass || "").trim().toLowerCase();
  if (classification !== "public" && classification !== "private") {
    throw new TypeError("data class must be public or private");
  }
  const timestamp = integer(at, "completion timestamp", {
    minimum: verified.at,
  });
  const reservation = await readGatewayReservation(db, id);
  if (!reservation?.owner_telegram_id) throw new Error("AI Gateway reservation not found");
  if (Number(reservation.owner_telegram_id) !== verified.ownerTelegramId) {
    throw new Error("AI Gateway completion owner mismatch");
  }
  if (reservation.reservation_state !== "reserved") {
    const metadata = await db.prepare(
      `SELECT m.*, u.status AS usage_status
       FROM ai_gateway_usage_metadata m
       JOIN ai_usage_events u ON u.request_id = m.request_id
       WHERE m.request_id = ?
       LIMIT 1`,
    ).bind(id).first();
    if (metadata) {
      const recordedOutcome = String(metadata.usage_status);
      const expectedReservationState = recordedOutcome === "success" ? "consumed" : "released";
      if (String(reservation.reservation_state) !== expectedReservationState) {
        throw new Error("AI Gateway completion replay state mismatch");
      }
      if (recordedOutcome !== resultState) {
        throw new Error("AI Gateway completion replay outcome mismatch");
      }
    }
    return Object.freeze({
      ok: true,
      replay: true,
      outcome: metadata ? String(metadata.usage_status) : String(reservation.reservation_state),
    });
  }
  const summary = await summarizeAiGatewayAttempts(db, id);
  if (summary.attemptCount < 1) throw new Error("AI Gateway completion requires an attempt");
  const successfulAttempts = summary.attempts.filter((entry) => entry.status === "success");
  if (resultState === "success" && successfulAttempts.length < 1) {
    throw new Error("successful AI Gateway completion requires provider success");
  }
  const primaryModelAlias = summary.attempts[0].modelAlias;
  const finalModelAlias = resultState === "success"
    ? successfulAttempts[successfulAttempts.length - 1].modelAlias
    : "none";
  const cacheScope = cacheDescriptor?.cacheScope || "none";
  const cacheKeyHash = cacheScope === "none"
    ? null
    : normalizeHash(cacheDescriptor?.cacheKeyHash, "cache key hash");
  if (classification === "private" && cacheScope === "public") {
    throw new Error("private AI response cannot enter public cache");
  }
  const safeError = resultState === "success" ? "" : normalizeErrorCode(errorCode);
  const legacyState = resultState === "success" ? "consumed" : "released";
  const usageInsert = db.prepare(
    `INSERT INTO ai_usage_events (
       request_id, telegram_id, usage_date, bucket, status,
       input_tokens, output_tokens, neurons_milli, source_count,
       error_code, created_at
     ) VALUES (?, ?, ?, 'admin', ?, ?, ?, 0, ?, ?, datetime(?, 'unixepoch'))`,
  ).bind(
    id,
    verified.ownerTelegramId,
    verified.usageDate,
    resultState,
    summary.inputTokens,
    summary.outputTokens,
    integer(sourceCount, "source count", { maximum: 32 }),
    safeError,
    timestamp,
  );
  const metadataInsert = db.prepare(
    `INSERT INTO ai_gateway_usage_metadata (
       request_id, provider_user_id, data_class, primary_model_alias,
       final_model_alias, attempt_count, retry_count, fallback_used,
       total_latency_ms, cached_input_tokens, billed_tokens, cost_microusd,
       cache_scope, cache_key_hash, pricing_version, policy_version, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    providerUserId,
    classification,
    primaryModelAlias,
    finalModelAlias,
    summary.attemptCount,
    summary.retryCount,
    summary.fallbackUsed ? 1 : 0,
    summary.totalLatencyMs,
    summary.cachedInputTokens,
    summary.billedTokens,
    summary.costMicrousd,
    cacheScope,
    cacheKeyHash,
    String(reservation.pricing_version),
    String(reservation.policy_version),
    timestamp,
  );
  const quotaUpdate = db.prepare(
    `UPDATE ai_quota_reservations
     SET status = ?, completed_at = datetime(?, 'unixepoch')
     WHERE request_id = ? AND telegram_id = ? AND status = 'reserved'`,
  ).bind(legacyState, timestamp, id, verified.ownerTelegramId);
  const budgetUpdate = db.prepare(
    `UPDATE ai_gateway_budget_reservations
     SET reservation_state = ?, completed_at = ?
     WHERE request_id = ? AND owner_telegram_id = ?
       AND reservation_state = 'reserved'`,
  ).bind(legacyState, timestamp, id, verified.ownerTelegramId);
  await db.batch([usageInsert, metadataInsert, quotaUpdate, budgetUpdate]);
  return Object.freeze({
    ok: true,
    replay: false,
    outcome: resultState,
    finalModelAlias,
    summary,
  });
}

export async function recordAiGatewayPolicyEvent(db, {
  eventId,
  eventKey,
  requestId,
  actorTelegramId,
  eventType,
  decision,
  ruleCode,
  detailCode = "",
  modelAlias = "none",
  providerCode = "none",
  at,
} = {}) {
  const allowedTypes = new Set([
    "consent_denied",
    "owner_scope_denied",
    "tool_denied",
    "prompt_injection",
    "unsupported_claim",
    "fact_source_denied",
    "content_redacted",
    "budget_denied",
    "provider_fallback",
    "generation_stopped",
    "schema_rejected",
  ]);
  const type = String(eventType || "").trim();
  if (!allowedTypes.has(type)) throw new TypeError("unsupported AI policy event type");
  const verdict = String(decision || "").trim();
  if (!new Set(["allow", "warn", "block", "fallback"]).has(verdict)) {
    throw new TypeError("unsupported AI policy decision");
  }
  const model = String(modelAlias || "none");
  if (!new Set([AI_PARTNER_MODEL_ALIASES.safe, AI_PARTNER_MODEL_ALIASES.dragon, "none"]).has(model)) {
    throw new TypeError("unsupported policy model alias");
  }
  const provider = String(providerCode || "none");
  if (!new Set(["cloudflare", "deepseek", "none"]).has(provider)) {
    throw new TypeError("unsupported policy provider");
  }
  const result = await db.prepare(
    `INSERT OR IGNORE INTO ai_policy_events (
       event_id, event_key, request_id, actor_telegram_id, draft_id,
       event_type, decision, rule_code, detail_code, model_alias,
       provider_code, policy_version, created_at
     ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    normalizeUuid(eventId, "policy event id"),
    nonEmptyString(eventKey, "policy event key", { minimum: 16, maximum: 160 }),
    normalizeRequestId(requestId),
    integer(actorTelegramId, "policy actor", { minimum: 1 }),
    type,
    verdict,
    nonEmptyString(ruleCode, "policy rule code", { minimum: 3, maximum: 80 }),
    String(detailCode || "").slice(0, 80),
    model,
    provider,
    AI_PARTNER_POLICY_VERSION,
    integer(at, "policy timestamp", { minimum: 1 }),
  ).run();
  return Object.freeze({ recorded: statementChanged(result) });
}

function defaultIdFactory() {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("crypto.randomUUID is required");
  }
  return globalThis.crypto.randomUUID();
}

function normalizeProviderUsage(value = {}) {
  const inputTokens = integer(value.inputTokens || value.promptTokens || 0, "provider input tokens", {
    maximum: 10_000_000,
  });
  const cachedInputTokens = integer(
    value.cachedInputTokens || value.cachedPromptTokens || 0,
    "provider cached input tokens",
    { maximum: inputTokens },
  );
  const outputTokens = integer(value.outputTokens || value.completionTokens || 0, "provider output tokens", {
    maximum: 10_000_000,
  });
  return Object.freeze({ inputTokens, cachedInputTokens, outputTokens });
}

function providerFailure(error) {
  const statusCode = Number(error?.statusCode ?? error?.status ?? 0);
  const timeout = error?.name === "TimeoutError" || error?.code === "provider_timeout";
  const safeStatus = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? statusCode
    : null;
  const retryable = timeout || safeStatus === 408 || safeStatus === 425 || safeStatus === 429 ||
    (safeStatus !== null && safeStatus >= 500) ||
    error?.code === "provider_unavailable";
  return Object.freeze({
    status: timeout ? "timeout" : "failed",
    statusCode: safeStatus,
    errorCode: timeout
      ? "provider_timeout"
      : normalizeErrorCode(error?.code, safeStatus ? `provider_http_${safeStatus}` : "provider_unavailable"),
    retryable,
    usage: normalizeProviderUsage(error?.usage || {}),
  });
}

async function invokeWithTimeout(invoke, envelope, timeoutMs) {
  if (typeof invoke !== "function") {
    const unavailable = new Error("provider transport unavailable");
    unavailable.code = "provider_unavailable";
    throw unavailable;
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      const error = new Error("provider request timed out");
      error.name = "TimeoutError";
      error.code = "provider_timeout";
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke(envelope, { signal: controller?.signal })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function invokeAndRecordGatewayAttempt({
  db,
  requestId,
  attemptNo,
  routeStep,
  modelAlias,
  envelope,
  invoke,
  pricing,
  timeoutMs,
  idFactory,
  at,
  monotonicNow,
}) {
  const started = Number(monotonicNow());
  let response;
  try {
    response = await invokeWithTimeout(invoke, envelope, timeoutMs);
  } catch (error) {
    const latencyMs = Math.max(0, Math.min(
      300_000,
      Math.round(Number(error?.latencyMs ?? (Number(monotonicNow()) - started))),
    ));
    const failure = providerFailure(error);
    const costMicrousd = modelAlias === AI_PARTNER_MODEL_ALIASES.dragon
      ? calculateAiGatewayCostMicrousd({ ...failure.usage, pricing })
      : 0;
    await recordAiGatewayAttempt(db, {
      requestId,
      attemptId: idFactory(),
      attemptNo,
      routeStep,
      modelAlias,
      status: failure.status,
      ...failure.usage,
      costMicrousd,
      latencyMs,
      statusCode: failure.statusCode,
      errorCode: failure.errorCode,
      at,
    });
    return Object.freeze({
      ok: false,
      ...failure,
      costMicrousd,
      latencyMs,
    });
  }
  const latencyMs = Math.max(0, Math.min(
    300_000,
    Math.round(Number(response?.latencyMs ?? (Number(monotonicNow()) - started))),
  ));
  const content = typeof response?.content === "string"
    ? response.content
    : typeof response?.response === "string"
      ? response.response
      : "";
  if (!content.trim()) {
    const failure = providerFailure({
      code: "provider_empty_response",
      status: response?.statusCode,
      usage: response?.usage,
    });
    const costMicrousd = modelAlias === AI_PARTNER_MODEL_ALIASES.dragon
      ? calculateAiGatewayCostMicrousd({ ...failure.usage, pricing })
      : 0;
    await recordAiGatewayAttempt(db, {
      requestId,
      attemptId: idFactory(),
      attemptNo,
      routeStep,
      modelAlias,
      status: failure.status,
      ...failure.usage,
      costMicrousd,
      latencyMs,
      statusCode: failure.statusCode,
      errorCode: failure.errorCode,
      at,
    });
    return Object.freeze({ ok: false, ...failure, costMicrousd, latencyMs });
  }
  const usage = normalizeProviderUsage(response?.usage || {});
  const costMicrousd = modelAlias === AI_PARTNER_MODEL_ALIASES.dragon
    ? calculateAiGatewayCostMicrousd({ ...usage, pricing })
    : 0;
  await recordAiGatewayAttempt(db, {
    requestId,
    attemptId: idFactory(),
    attemptNo,
    routeStep,
    modelAlias,
    status: "success",
    ...usage,
    costMicrousd,
    latencyMs,
    statusCode: response?.statusCode ?? 200,
    at,
  });
  return Object.freeze({
    ok: true,
    content,
    usage,
    costMicrousd,
    latencyMs,
  });
}

async function makeCacheDescriptor({
  context,
  dataClass,
  payload,
  modelAlias,
  allowCache,
  cacheScopeSecret,
  cryptoImpl,
}) {
  return createAiGatewayCacheDescriptor({
    dataClass,
    payload,
    ownerTelegramId: context.ownerTelegramId,
    modelAlias,
    allowCache,
    cacheScopeSecret,
    cryptoImpl,
  });
}

async function writeGatewayEvent({
  db,
  idFactory,
  requestId,
  context,
  suffix,
  eventType,
  decision,
  ruleCode,
  detailCode,
  modelAlias,
  providerCode,
}) {
  return recordAiGatewayPolicyEvent(db, {
    eventId: idFactory(),
    eventKey: `${requestId}:${suffix}`.slice(0, 160),
    requestId,
    actorTelegramId: context.ownerTelegramId,
    eventType,
    decision,
    ruleCode,
    detailCode,
    modelAlias,
    providerCode,
    at: context.at,
  });
}

const AI_GATEWAY_VALIDATION_FALLBACK_CODES = new Set([
  "ai_partner_owner_provider_json_invalid",
]);

function canFallbackAfterValidationError(error) {
  return AI_GATEWAY_VALIDATION_FALLBACK_CODES.has(
    normalizeErrorCode(error?.code, "policy_rejected"),
  );
}

function externalGatewayConfigured(config) {
  return Boolean(
    config?.configurationValid === true &&
    config?.masterEnabled === true &&
    config?.externalProviderEnabled === true &&
    config?.rolloutMode === "admin" &&
    config?.dragonModelAlias === AI_PARTNER_MODEL_ALIASES.dragon &&
    config?.fallbackModelAlias === AI_PARTNER_MODEL_ALIASES.safe &&
    config?.externalModelName === "deepseek-flash" &&
    config?.thinkingEnabled === false,
  );
}

function safeGatewayConfigured(config) {
  return Boolean(
    config?.configurationValid === true &&
    config?.masterEnabled === true &&
    config?.rolloutMode === "admin" &&
    config?.primaryModelAlias === AI_PARTNER_MODEL_ALIASES.safe &&
    config?.fallbackModelAlias === AI_PARTNER_MODEL_ALIASES.safe &&
    config?.thinkingEnabled === false,
  );
}

export async function runAiPartnerGateway({
  db,
  context,
  config,
  request,
  pricing,
  transports,
  providerUserIdSecret,
  cacheScopeSecret,
  validateOutput,
  idFactory = defaultIdFactory,
  timeoutMs = AI_GATEWAY_HARD_LIMITS.timeoutMs,
  monotonicNow = () => globalThis.performance?.now?.() ?? Date.now(),
  cryptoImpl = globalThis.crypto,
} = {}) {
  const verified = assertVerifiedGatewayContext(context);
  if (!safeGatewayConfigured(config)) {
    throw new Error("AI Gateway is disabled or misconfigured");
  }
  if (typeof validateOutput !== "function") {
    throw new TypeError("the shared AI output policy validator is required");
  }
  const id = normalizeRequestId(request?.requestId);
  const requestedDataClass = request?.dataClass === undefined
    ? verified.dataClass
    : String(request.dataClass || "").trim().toLowerCase();
  if (requestedDataClass !== verified.dataClass) {
    throw new Error("client-selected data classification denied");
  }
  const dataClass = verified.dataClass;
  assertNoClientRoutingFields(request);
  const outputLimit = integer(request?.maxOutputTokens, "maximum output tokens", {
    minimum: 1,
    maximum: AI_GATEWAY_HARD_LIMITS.maxOutputTokens,
  });
  const estimatedInputTokens = integer(
    request?.estimatedInputTokens,
    "estimated input tokens",
    { minimum: 1, maximum: AI_GATEWAY_HARD_LIMITS.maxInputTokens },
  );
  const timeout = integer(timeoutMs, "gateway timeout", {
    minimum: 100,
    maximum: AI_GATEWAY_HARD_LIMITS.maximumTimeoutMs,
  });
  const rates = normalizeAiGatewayPricing(pricing);
  const profile = createAiGatewayBudgetProfile({
    pricing: rates,
    dailySuccessLimit: config.dailyBurst,
    cycleSuccessLimit: config.cycleSuccess,
    pilotUsers: config.pilotUsers,
    userCostCeilingMicrousd: config.userCostCeilingMicrousd,
    globalCostCeilingMicrousd: config.globalCostCeilingMicrousd,
  });
  const providerUserId = await createProviderScopedUserId({
    telegramId: verified.ownerTelegramId,
    secret: providerUserIdSecret,
    cryptoImpl,
  });

  // A Worker termination after the budget insert but before terminal usage
  // accounting must not hold the single-owner concurrency lease forever.
  // Five minutes is longer than the maximum three-attempt provider window;
  // releasing only older reservations preserves every token and cost ceiling.
  await releaseStaleAiGatewayReservations(db, {
    beforeAt: Math.max(
      1,
      verified.at - AI_GATEWAY_HARD_LIMITS.staleReservationSeconds,
    ),
    at: verified.at,
    ownerTelegramId: verified.ownerTelegramId,
  });

  let useExternal = externalGatewayConfigured(config);
  if (useExternal) {
    assertVerifiedGatewayContext(verified, { requireExternalApproval: true });
  }
  let redaction = redactAiGatewayPayload({
    payload: request?.payload,
    dataClass,
    context: verified,
    external: useExternal,
  });
  if (!redaction.allowed && redaction.reason === "external_private_consent_required") {
    await writeGatewayEvent({
      db,
      idFactory,
      requestId: id,
      context: verified,
      suffix: "external-consent-denied",
      eventType: "consent_denied",
      decision: "fallback",
      ruleCode: "external_private_consent_required",
      detailCode: "qwen_safe_only",
      modelAlias: AI_PARTNER_MODEL_ALIASES.dragon,
      providerCode: "deepseek",
    });
    useExternal = false;
    redaction = redactAiGatewayPayload({
      payload: request?.payload,
      dataClass,
      context: verified,
      external: false,
    });
  }
  if (!redaction.allowed) {
    await writeGatewayEvent({
      db,
      idFactory,
      requestId: id,
      context: verified,
      suffix: `dlp-${redaction.reason}`,
      eventType: "content_redacted",
      decision: "block",
      ruleCode: redaction.reason,
      detailCode: redaction.redactionCodes.join(",").slice(0, 80),
      modelAlias: useExternal ? AI_PARTNER_MODEL_ALIASES.dragon : AI_PARTNER_MODEL_ALIASES.safe,
      providerCode: useExternal ? "deepseek" : "cloudflare",
    });
    return Object.freeze({ ok: false, requestId: id, reason: redaction.reason });
  }
  if (redaction.redactionCodes.length) {
    await writeGatewayEvent({
      db,
      idFactory,
      requestId: id,
      context: verified,
      suffix: "dlp-redacted",
      eventType: "content_redacted",
      decision: "warn",
      ruleCode: "provider_payload_redacted",
      detailCode: redaction.redactionCodes.join(",").slice(0, 80),
      modelAlias: useExternal ? AI_PARTNER_MODEL_ALIASES.dragon : AI_PARTNER_MODEL_ALIASES.safe,
      providerCode: useExternal ? "deepseek" : "cloudflare",
    });
  }

  let primaryAlias = useExternal
    ? AI_PARTNER_MODEL_ALIASES.dragon
    : AI_PARTNER_MODEL_ALIASES.safe;
  let reservationPlan = calculateAiGatewayReservation({
    estimatedInputTokens,
    maxOutputTokens: outputLimit,
    pricing: rates,
    externalPrimary: useExternal,
  });
  let reservation = await reserveAiGatewayBudget(db, {
    context: verified,
    requestId: id,
    reservation: reservationPlan,
    profile,
  });
  if (
    !reservation.ok &&
    useExternal &&
    new Set(["user_cost_ceiling", "global_cost_ceiling"]).has(reservation.reason)
  ) {
    await writeGatewayEvent({
      db,
      idFactory,
      requestId: id,
      context: verified,
      suffix: `fallback-${reservation.reason}`,
      eventType: "provider_fallback",
      decision: "fallback",
      ruleCode: reservation.reason,
      detailCode: "qwen_safe",
      modelAlias: AI_PARTNER_MODEL_ALIASES.dragon,
      providerCode: "deepseek",
    });
    useExternal = false;
    primaryAlias = AI_PARTNER_MODEL_ALIASES.safe;
    reservationPlan = calculateAiGatewayReservation({
      estimatedInputTokens,
      maxOutputTokens: outputLimit,
      pricing: rates,
      externalPrimary: false,
    });
    reservation = await reserveAiGatewayBudget(db, {
      context: verified,
      requestId: id,
      reservation: reservationPlan,
      profile,
    });
  }
  if (!reservation.ok) {
    await writeGatewayEvent({
      db,
      idFactory,
      requestId: id,
      context: verified,
      suffix: `budget-${reservation.reason}`,
      eventType: "budget_denied",
      decision: "block",
      ruleCode: reservation.reason,
      detailCode: "",
      modelAlias: primaryAlias,
      providerCode: AI_GATEWAY_MODEL_ROUTES[primaryAlias].providerCode,
    });
    return Object.freeze({ ok: false, requestId: id, reason: reservation.reason });
  }
  if (reservation.replay && reservation.state !== "reserved") {
    return Object.freeze({
      ok: false,
      requestId: id,
      reason: "request_already_completed",
      replay: true,
    });
  }
  if (reservation.replay) {
    return Object.freeze({
      ok: false,
      requestId: id,
      reason: "request_in_progress",
      replay: true,
    });
  }

  let cacheDescriptor = await makeCacheDescriptor({
    context: verified,
    dataClass,
    payload: redaction.payload,
    modelAlias: primaryAlias,
    allowCache: verified.cacheAllowed && request?.allowCache !== false,
    cacheScopeSecret,
    cryptoImpl,
  });
  let envelope = buildAiGatewayProviderEnvelope({
    modelAlias: primaryAlias,
    payload: redaction.payload,
    providerUserId,
    maxOutputTokens: outputLimit,
    cacheDescriptor,
  });
  let attemptNo = 1;
  let providerResult = await invokeAndRecordGatewayAttempt({
    db,
    requestId: id,
    attemptNo,
    routeStep: "primary",
    modelAlias: primaryAlias,
    envelope,
    invoke: primaryAlias === AI_PARTNER_MODEL_ALIASES.dragon
      ? transports?.deepseekFlash
      : transports?.qwenSafe,
    pricing: rates,
    timeoutMs: timeout,
    idFactory,
    at: verified.at,
    monotonicNow,
  });

  if (
    !providerResult.ok &&
    primaryAlias === AI_PARTNER_MODEL_ALIASES.dragon &&
    providerResult.retryable &&
    providerResult.errorCode !== "generation_stopped"
  ) {
    attemptNo = 2;
    providerResult = await invokeAndRecordGatewayAttempt({
      db,
      requestId: id,
      attemptNo,
      routeStep: "retry",
      modelAlias: AI_PARTNER_MODEL_ALIASES.dragon,
      envelope,
      invoke: transports?.deepseekFlash,
      pricing: rates,
      timeoutMs: timeout,
      idFactory,
      at: verified.at,
      monotonicNow,
    });
  }

  if (
    !providerResult.ok &&
    primaryAlias === AI_PARTNER_MODEL_ALIASES.dragon &&
    providerResult.errorCode !== "generation_stopped"
  ) {
    await writeGatewayEvent({
      db,
      idFactory,
      requestId: id,
      context: verified,
      suffix: "fallback-provider-unavailable",
      eventType: "provider_fallback",
      decision: "fallback",
      ruleCode: providerResult.errorCode,
      detailCode: "qwen_safe",
      modelAlias: AI_PARTNER_MODEL_ALIASES.dragon,
      providerCode: "deepseek",
    });
    attemptNo += 1;
    cacheDescriptor = await makeCacheDescriptor({
      context: verified,
      dataClass,
      payload: redaction.payload,
      modelAlias: AI_PARTNER_MODEL_ALIASES.safe,
      allowCache: verified.cacheAllowed && request?.allowCache !== false,
      cacheScopeSecret,
      cryptoImpl,
    });
    envelope = buildAiGatewayProviderEnvelope({
      modelAlias: AI_PARTNER_MODEL_ALIASES.safe,
      payload: redaction.payload,
      providerUserId,
      maxOutputTokens: outputLimit,
      cacheDescriptor,
    });
    providerResult = await invokeAndRecordGatewayAttempt({
      db,
      requestId: id,
      attemptNo,
      routeStep: "fallback",
      modelAlias: AI_PARTNER_MODEL_ALIASES.safe,
      envelope,
      invoke: transports?.qwenSafe,
      pricing: rates,
      timeoutMs: timeout,
      idFactory,
      at: verified.at,
      monotonicNow,
    });
  }

  if (!providerResult.ok) {
    await completeAiGatewayBudget(db, {
      context: verified,
      requestId: id,
      outcome: "failed",
      providerUserId,
      dataClass,
      cacheDescriptor,
      sourceCount: request?.sourceCount || 0,
      errorCode: providerResult.errorCode,
      at: verified.at,
    });
    return Object.freeze({
      ok: false,
      requestId: id,
      reason: providerResult.errorCode,
    });
  }

  const validateProviderOutput = async () => {
    try {
      const output = await validateOutput(providerResult.content, {
        requestId: id,
        modelAlias: envelope.modelAlias,
        policyVersion: AI_PARTNER_POLICY_VERSION,
      });
      if (output === undefined || output === null || output === false) {
        throw new Error("shared output policy rejected the response");
      }
      return Object.freeze({ ok: true, output });
    } catch (error) {
      return Object.freeze({ ok: false, error });
    }
  };

  let validation = await validateProviderOutput();
  if (
    !validation.ok &&
    envelope.modelAlias === AI_PARTNER_MODEL_ALIASES.dragon &&
    canFallbackAfterValidationError(validation.error)
  ) {
    await writeGatewayEvent({
      db,
      idFactory,
      requestId: id,
      context: verified,
      suffix: "fallback-validation-rejected",
      eventType: "schema_rejected",
      decision: "fallback",
      ruleCode: "shared_output_policy_rejected",
      detailCode: normalizeErrorCode(validation.error?.code, "policy_rejected"),
      modelAlias: AI_PARTNER_MODEL_ALIASES.dragon,
      providerCode: "deepseek",
    });
    await writeGatewayEvent({
      db,
      idFactory,
      requestId: id,
      context: verified,
      suffix: "fallback-validation-provider",
      eventType: "provider_fallback",
      decision: "fallback",
      ruleCode: "shared_output_policy_rejected",
      detailCode: "qwen_safe",
      modelAlias: AI_PARTNER_MODEL_ALIASES.dragon,
      providerCode: "deepseek",
    });
    attemptNo += 1;
    cacheDescriptor = await makeCacheDescriptor({
      context: verified,
      dataClass,
      payload: redaction.payload,
      modelAlias: AI_PARTNER_MODEL_ALIASES.safe,
      allowCache: verified.cacheAllowed && request?.allowCache !== false,
      cacheScopeSecret,
      cryptoImpl,
    });
    envelope = buildAiGatewayProviderEnvelope({
      modelAlias: AI_PARTNER_MODEL_ALIASES.safe,
      payload: redaction.payload,
      providerUserId,
      maxOutputTokens: outputLimit,
      cacheDescriptor,
    });
    providerResult = await invokeAndRecordGatewayAttempt({
      db,
      requestId: id,
      attemptNo,
      routeStep: "fallback",
      modelAlias: AI_PARTNER_MODEL_ALIASES.safe,
      envelope,
      invoke: transports?.qwenSafe,
      pricing: rates,
      timeoutMs: timeout,
      idFactory,
      at: verified.at,
      monotonicNow,
    });
    if (!providerResult.ok) {
      await completeAiGatewayBudget(db, {
        context: verified,
        requestId: id,
        outcome: "failed",
        providerUserId,
        dataClass,
        cacheDescriptor,
        sourceCount: request?.sourceCount || 0,
        errorCode: providerResult.errorCode,
        at: verified.at,
      });
      return Object.freeze({
        ok: false,
        requestId: id,
        reason: providerResult.errorCode,
      });
    }
    validation = await validateProviderOutput();
  }

  if (!validation.ok) {
    await writeGatewayEvent({
      db,
      idFactory,
      requestId: id,
      context: verified,
      suffix: "schema-policy-rejected",
      eventType: "schema_rejected",
      decision: "block",
      ruleCode: "shared_output_policy_rejected",
      detailCode: normalizeErrorCode(validation.error?.code, "policy_rejected"),
      modelAlias: envelope.modelAlias,
      providerCode: envelope.providerCode,
    });
    await completeAiGatewayBudget(db, {
      context: verified,
      requestId: id,
      outcome: "failed",
      providerUserId,
      dataClass,
      cacheDescriptor,
      sourceCount: request?.sourceCount || 0,
      errorCode: "shared_output_policy_rejected",
      at: verified.at,
    });
    return Object.freeze({
      ok: false,
      requestId: id,
      reason: "shared_output_policy_rejected",
    });
  }
  const validatedOutput = validation.output;

  const completion = await completeAiGatewayBudget(db, {
    context: verified,
    requestId: id,
    outcome: "success",
    providerUserId,
    dataClass,
    cacheDescriptor,
    sourceCount: request?.sourceCount || 0,
    at: verified.at,
  });
  return Object.freeze({
    ok: true,
    requestId: id,
    modelAlias: completion.finalModelAlias,
    fallbackUsed: completion.summary.fallbackUsed,
    output: validatedOutput,
    telemetry: Object.freeze({
      attemptCount: completion.summary.attemptCount,
      retryCount: completion.summary.retryCount,
      billedTokens: completion.summary.billedTokens,
      cachedInputTokens: completion.summary.cachedInputTokens,
      costMicrousd: completion.summary.costMicrousd,
      totalLatencyMs: completion.summary.totalLatencyMs,
    }),
  });
}

function normalizeBenchmarkScore(value) {
  const score = Number(value?.score ?? value);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new TypeError("benchmark score must be between 0 and 100");
  }
  return Object.freeze({
    score: Math.round(score * 100) / 100,
    policyPass: value?.policyPass !== false,
  });
}

export async function runClosedAiGatewayBenchmark({
  context,
  executeCase,
  scoreCase,
  benchmarkVersion = AI_GATEWAY_BENCHMARK_VERSION,
  cryptoImpl = globalThis.crypto,
} = {}) {
  assertVerifiedGatewayContext(context, { requireExternalApproval: true });
  if (typeof executeCase !== "function" || typeof scoreCase !== "function") {
    throw new TypeError("closed benchmark executor and scorer are required");
  }
  const version = nonEmptyString(benchmarkVersion, "benchmark version", {
    minimum: 8,
    maximum: 80,
  });
  const aliases = Object.freeze([
    AI_PARTNER_MODEL_ALIASES.safe,
    AI_PARTNER_MODEL_ALIASES.dragon,
  ]);
  const measurements = [];
  for (const benchmarkCase of AI_GATEWAY_BENCHMARK_CASES_RU) {
    const caseId = nonEmptyString(benchmarkCase?.caseId, "benchmark case id", {
      minimum: 3,
      maximum: 80,
    });
    const input = cloneJson(benchmarkCase?.input || {});
    assertNoClientRoutingFields(input, `benchmark.${caseId}`);
    const inputHash = await sha256Hex(canonicalJson(input), cryptoImpl);
    for (const modelAlias of aliases) {
      const route = AI_GATEWAY_MODEL_ROUTES[modelAlias];
      try {
        const result = await executeCase({
          benchmarkVersion: version,
          caseId,
          draftType: String(benchmarkCase?.draftType || ""),
          modelAlias,
          providerCode: route.providerCode,
          thinkingEnabled: false,
          input: deepFreeze(cloneJson(input)),
        });
        const evaluation = normalizeBenchmarkScore(await scoreCase({
          caseId,
          draftType: String(benchmarkCase?.draftType || ""),
          rubric: deepFreeze(cloneJson(benchmarkCase?.rubric || [])),
          modelAlias,
          output: result?.output,
        }));
        const usage = normalizeProviderUsage(result?.usage || {});
        measurements.push(Object.freeze({
          caseId,
          inputHash,
          modelAlias,
          providerCode: route.providerCode,
          status: evaluation.policyPass ? "success" : "policy_failed",
          score: evaluation.score,
          policyPass: evaluation.policyPass,
          latencyMs: integer(result?.latencyMs || 0, "benchmark latency", {
            maximum: 300_000,
          }),
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
          costMicrousd: integer(result?.costMicrousd || 0, "benchmark cost", {
            maximum: AI_PARTNER_LIMITS.userCycleCostCeilingMicrousd,
          }),
        }));
      } catch (error) {
        measurements.push(Object.freeze({
          caseId,
          inputHash,
          modelAlias,
          providerCode: route.providerCode,
          status: "failed",
          score: 0,
          policyPass: false,
          latencyMs: Math.max(0, Math.min(300_000, Number(error?.latencyMs || 0))),
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          costMicrousd: 0,
          errorCode: normalizeErrorCode(error?.code, "benchmark_case_failed"),
        }));
      }
    }
  }
  const summaries = Object.fromEntries(aliases.map((modelAlias) => {
    const entries = measurements.filter((entry) => entry.modelAlias === modelAlias);
    const successful = entries.filter((entry) => entry.status === "success");
    const average = (field) => successful.length
      ? Math.round(
        (successful.reduce((sum, entry) => sum + Number(entry[field] || 0), 0) /
          successful.length) * 100,
      ) / 100
      : 0;
    return [modelAlias, Object.freeze({
      cases: entries.length,
      successful: successful.length,
      policyFailed: entries.filter((entry) => entry.status === "policy_failed").length,
      failed: entries.filter((entry) => entry.status === "failed").length,
      averageScore: average("score"),
      averageLatencyMs: average("latencyMs"),
      billedTokens: entries.reduce(
        (sum, entry) => sum + entry.inputTokens + entry.outputTokens,
        0,
      ),
      cachedInputTokens: entries.reduce(
        (sum, entry) => sum + entry.cachedInputTokens,
        0,
      ),
      costMicrousd: entries.reduce((sum, entry) => sum + entry.costMicrousd, 0),
    })];
  }));
  const report = {
    benchmarkVersion: version,
    policyVersion: AI_PARTNER_POLICY_VERSION,
    rolloutMode: "admin",
    externalModel: "deepseek-flash",
    thinkingEnabled: false,
    caseCount: AI_GATEWAY_BENCHMARK_CASES_RU.length,
    measurements: Object.freeze(measurements),
    summaries: Object.freeze(summaries),
  };
  return deepFreeze(report);
}
