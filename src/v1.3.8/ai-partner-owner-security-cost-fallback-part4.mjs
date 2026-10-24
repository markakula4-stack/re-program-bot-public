import {
  AI_PARTNER_MODEL_ALIASES,
  AI_PARTNER_POLICY_VERSION,
  readAiPartnerConfig,
} from "./ai-partner-foundation.mjs";
import {
  AI_GATEWAY_PROVIDER_CONSENT_VERSION,
  createAiGatewayBudgetProfile,
  createVerifiedAdminGatewayContext,
  getAiGatewayBudgetSnapshot,
} from "./ai-partner-gateway.mjs";
import {
  AI_PARTNER_DEEPSEEK_CHAT_URL,
  AI_PARTNER_DEEPSEEK_FLASH_PRICING,
  buildDeepSeekFlashRequest,
  createAiPartnerProviderTransports,
} from "./ai-partner-provider-transports.mjs";

export const AI_PARTNER_OWNER_SECURITY_COST_FALLBACK_VERSION =
  "2026-09-19.owner-security-cost-fallback-v1";
export const AI_PARTNER_OWNER_EXTERNAL_CONSENT_TOKEN_VERSION =
  "2026-09-19.owner-external-consent-token-v1";
export const AI_PARTNER_OWNER_MEMORY_POLICY_VERSION =
  "2026-09-19.owner-memory-disabled-v1";

export const AI_PARTNER_OWNER_PART4_LIMITS = Object.freeze({
  consentTokenTtlSeconds: 600,
  maximumPromptCharacters: 4_000,
  maximumOutputCharacters: 16_000,
  maximumStreamCharacters: 40_000,
  maximumSseBufferCharacters: 80_000,
  maximumSseEvents: 8_192,
});

export const AI_PARTNER_OWNER_FAILURE_MATRIX = Object.freeze({
  provider_timeout: Object.freeze({ retryExternal: true, fallbackToSafe: true }),
  provider_unavailable: Object.freeze({ retryExternal: true, fallbackToSafe: true }),
  provider_http_408: Object.freeze({ retryExternal: true, fallbackToSafe: true }),
  provider_http_425: Object.freeze({ retryExternal: true, fallbackToSafe: true }),
  provider_http_429: Object.freeze({ retryExternal: true, fallbackToSafe: true }),
  provider_http_500: Object.freeze({ retryExternal: true, fallbackToSafe: true }),
  provider_http_502: Object.freeze({ retryExternal: true, fallbackToSafe: true }),
  provider_http_503: Object.freeze({ retryExternal: true, fallbackToSafe: true }),
  provider_http_504: Object.freeze({ retryExternal: true, fallbackToSafe: true }),
  provider_auth_failed: Object.freeze({ retryExternal: false, fallbackToSafe: true }),
  provider_request_rejected: Object.freeze({ retryExternal: false, fallbackToSafe: true }),
  shared_output_policy_rejected: Object.freeze({ retryExternal: false, fallbackToSafe: true }),
  generation_stopped: Object.freeze({ retryExternal: false, fallbackToSafe: false }),
  secret_material_blocked: Object.freeze({ retryExternal: false, fallbackToSafe: false }),
  prompt_injection_blocked: Object.freeze({ retryExternal: false, fallbackToSafe: false }),
  budget_denied: Object.freeze({ retryExternal: false, fallbackToSafe: false }),
});

const VERIFIED_POLICIES = new WeakSet();
const STREAM_TERMINAL_OUTCOMES = new WeakMap();
const streamTerminal = (value, usage, statusCode, invoked = true) => {
  STREAM_TERMINAL_OUTCOMES.set(value, Object.freeze({ invoked, usageKnown:true,
    usage:Object.freeze({...usage}), statusCode,status:value instanceof Error?'failed':'success',estimatedUsage:null }));
  return value;
};
export const readAiPartnerStreamTerminalOutcome = value => STREAM_TERMINAL_OUTCOMES.get(value) ?? null;
export function preserveAiPartnerStreamTerminalOutcome(error, source) {
  const outcome=STREAM_TERMINAL_OUTCOMES.get(source);
  if(outcome && error && typeof error==='object') STREAM_TERMINAL_OUTCOMES.set(error,outcome);
  return error;
}
function streamUsageKnown(value) {
  if(!value || typeof value!=='object') return false;
  const input=value.prompt_tokens ?? value.input_tokens ?? value.inputTokens;
  const output=value.completion_tokens ?? value.output_tokens ?? value.outputTokens;
  const cached=value.prompt_cache_hit_tokens ?? value.prompt_tokens_details?.cached_tokens ??
    value.cached_input_tokens ?? value.cachedInputTokens ?? 0;
  return [input,output,cached].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=10_000_000)&&cached<=input;
}
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const CONSENT_TOKEN = /^a138c\.([A-Za-z0-9_-]{20,560})\.([A-Za-z0-9_-]{22})$/;
const MODEL_POLICIES = new Set(["auto", "qwen_safe", "deepseek_flash_dragon"]);
const CONSENT_ACTIONS = new Set(["grant", "revoke"]);
const ALLOWED_POLICY_INPUTS = new Set(["actorTelegramId", "at"]);
const ALLOWED_CONSENT_INPUTS = new Set(["actorTelegramId", "action", "at"]);
const ALLOWED_CONSUME_INPUTS = new Set(["actorTelegramId", "token", "at"]);
const BLOCKED_PROMPT_RULES = Object.freeze([
  Object.freeze({
    code: "instruction_override",
    pattern: /(?:ignore|forget|disregard|override|bypass|игнорируй|забудь|отмени|обойди)[\s\S]{0,80}(?:instruction|policy|rule|system|developer|инструкц|правил|политик|системн)/iu,
  }),
  Object.freeze({
    code: "prompt_disclosure",
    pattern: /(?:system prompt|developer message|hidden instruction|раскрой|покажи|выведи)[\s\S]{0,80}(?:system|developer|prompt|секретн|скрыт|системн|инструкц)/iu,
  }),
  Object.freeze({
    code: "secret_exfiltration",
    pattern: /(?:api[ _-]?key|bot[ _-]?token|authorization|cookie|cloudflare secret|deepseek secret|секрет|токен бота|ключ api|парол)/iu,
  }),
  Object.freeze({
    code: "tool_escalation",
    pattern: /(?:call|invoke|enable|use|вызови|включи|используй)[\s\S]{0,60}(?:tool|function|sql|database|d1|browser|internet|fetch|инструмент|функц|баз[ау] данных|интернет)/iu,
  }),
  Object.freeze({
    code: "privilege_escalation",
    pattern: /(?:change|grant|set|выдай|измени|назначь)[\s\S]{0,70}(?:admin|role|tariff|subscription|inviter|owner|админ|роль|тариф|подписк|пригласител)/iu,
  }),
  Object.freeze({
    code: "financial_action",
    pattern: /(?:refund|chargeback|invoice|pay|transfer|верни stars|возврат|сч[её]т на оплату|оплати|переведи)/iu,
  }),
  Object.freeze({
    code: "arbitrary_network",
    pattern: /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|169\.254\.|file:\/\/|javascript:|data:text\/html|открой произвольн|перейди по url)/iu,
  }),
  Object.freeze({
    code: "mass_delivery",
    pattern: /(?:mass send|bulk send|send to all|массов[аяую]+ рассыл|разошли всем|отправь всем)/iu,
  }),
]);
const BLOCKING_SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\bbot\d{6,}:[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:sk|ds)-[A-Za-z0-9_-]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}\b/iu,
]);
const BLOCKED_OUTPUT_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\bbot\d{6,}:[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:sk|ds)-[A-Za-z0-9_-]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}\b/iu,
  /(?:system prompt|developer message|hidden instruction|системн(?:ый|ого) промпт|скрыт(?:ая|ые) инструкц)/iu,
  /(?:javascript:|file:\/\/|data:text\/html|localhost|127\.0\.0\.1|169\.254\.)/iu,
]);

function part4Error(code, cause = null) {
  const error = new Error("AI Partner owner Part 4 policy rejected");
  error.name = "AiPartnerOwnerPart4Error";
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function plainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

function exactFields(value, allowed, invalidCode, deniedCode) {
  if (!plainObject(value)) throw part4Error(invalidCode);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw part4Error(deniedCode);
  }
}

function strictFlag(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function positiveTelegramId(value, code) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw part4Error(code);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw part4Error(code);
  return parsed;
}

function clock(value = Math.floor(Date.now() / 1_000)) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1_600_000_000 ||
    parsed > 9_999_999_999
  ) {
    throw part4Error("ai_partner_part4_clock_invalid");
  }
  return parsed;
}

function requireDatabase(env) {
  if (!env?.DB?.prepare || !env?.DB?.batch) {
    throw part4Error("ai_partner_part4_database_not_ready");
  }
  return env.DB;
}

function requireOwner(env, actorTelegramId) {
  requireDatabase(env);
  const actor = positiveTelegramId(
    actorTelegramId,
    "ai_partner_part4_actor_invalid",
  );
  const owner = positiveTelegramId(
    env?.ADMIN_ID,
    "ai_partner_part4_admin_not_configured",
  );
  if (actor !== owner) throw part4Error("ai_partner_part4_owner_only");
  return owner;
}

function requirePart4Enabled(env) {
  if (!strictFlag(env?.AI_PARTNER_OWNER_SECURITY_COST_FALLBACK_ENABLED)) {
    throw part4Error("ai_partner_part4_disabled");
  }
  if (strictFlag(env?.AI_PARTNER_OWNER_MEMORY_ENABLED)) {
    throw part4Error("ai_partner_part4_memory_must_remain_disabled");
  }
}

function parseSqliteEpoch(value) {
  if (value === null || value === undefined || value === "") return null;
  if (/^\d{10}$/.test(String(value))) return Number(value);
  const normalized = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)
    ? `${normalized.replace(" ", "T")}Z`
    : normalized;
  const milliseconds = Date.parse(iso);
  return Number.isFinite(milliseconds)
    ? Math.floor(milliseconds / 1_000)
    : null;
}

function base64UrlEncode(value) {
  const bytes = value instanceof Uint8Array
    ? value
    : TEXT_ENCODER.encode(String(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = typeof btoa === "function"
    ? btoa(binary)
    : globalThis.Buffer?.from(bytes)?.toString("base64");
  if (!encoded) throw part4Error("ai_partner_part4_base64_unavailable");
  return encoded.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value) {
  const text = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = text + "=".repeat((4 - (text.length % 4 || 4)) % 4);
  const binary = typeof atob === "function"
    ? atob(padded)
    : globalThis.Buffer?.from(padded, "base64")?.toString("binary");
  if (binary === undefined) {
    throw part4Error("ai_partner_part4_base64_unavailable");
  }
  return new Uint8Array([...binary].map((character) => character.charCodeAt(0)));
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

async function hmac(secret, domain, payload, cryptoImpl = globalThis.crypto) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw part4Error("ai_partner_part4_consent_secret_invalid");
  }
  if (!cryptoImpl?.subtle) {
    throw part4Error("ai_partner_part4_crypto_unavailable");
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
    TEXT_ENCODER.encode(`${domain}\n${payload}`),
  );
  return new Uint8Array(signature);
}

async function readExternalConsent(db, ownerTelegramId, at) {
  const row = await db.prepare(
    `SELECT consent_version, consented_at, revoked_at
     FROM ai_user_consents
     WHERE telegram_id = ?
     LIMIT 1`,
  ).bind(ownerTelegramId).first();
  if (!row) return null;
  const consentedAt = parseSqliteEpoch(row.consented_at);
  const revokedAt = parseSqliteEpoch(row.revoked_at);
  if (
    String(row.consent_version || "") !==
      AI_GATEWAY_PROVIDER_CONSENT_VERSION ||
    !Number.isSafeInteger(consentedAt) ||
    consentedAt > at ||
    revokedAt !== null
  ) {
    return null;
  }
  return Object.freeze({
    version: AI_GATEWAY_PROVIDER_CONSENT_VERSION,
    consentedAt,
    revokedAt: null,
  });
}

function configuredModelPolicy(env) {
  const value = String(env?.AI_PARTNER_OWNER_MODEL_POLICY || "auto")
    .trim()
    .toLowerCase();
  if (!MODEL_POLICIES.has(value)) {
    throw part4Error("ai_partner_part4_model_policy_invalid");
  }
  return value;
}

function effectiveEnvironment(env, externalProviderEnabled) {
  return Object.freeze({
    ...env,
    AI_PARTNER_EXTERNAL_PROVIDER_ENABLED:
      externalProviderEnabled ? "true" : "false",
    AI_PARTNER_RICH_MESSAGES_ENABLED: "true",
  });
}

function validateEffectiveConfig(config) {
  if (
    !config?.configurationValid ||
    !config.masterEnabled ||
    config.rolloutMode !== "admin" ||
    config.primaryModelAlias !== AI_PARTNER_MODEL_ALIASES.safe ||
    config.dragonModelAlias !== AI_PARTNER_MODEL_ALIASES.dragon ||
    config.fallbackModelAlias !== AI_PARTNER_MODEL_ALIASES.safe ||
    config.thinkingEnabled !== false
  ) {
    throw part4Error("ai_partner_part4_configuration_invalid");
  }
}

export async function createAiPartnerOwnerPart4Policy(
  env,
  input = {},
) {
  exactFields(
    input,
    ALLOWED_POLICY_INPUTS,
    "ai_partner_part4_policy_input_invalid",
    "ai_partner_part4_policy_field_denied",
  );
  requirePart4Enabled(env);
  const owner = requireOwner(env, input.actorTelegramId);
  const at = clock(input.at);
  const modelPolicy = configuredModelPolicy(env);
  const configured = readAiPartnerConfig(env);
  if (
    !configured.configurationValid ||
    !configured.masterEnabled ||
    configured.rolloutMode !== "admin"
  ) {
    throw part4Error("ai_partner_part4_configuration_invalid");
  }
  const externalConsent = await readExternalConsent(env.DB, owner, at);
  const externalProviderEnabled = Boolean(
    modelPolicy !== "qwen_safe" &&
      configured.externalProviderEnabled &&
      externalConsent,
  );
  const policyEnv = effectiveEnvironment(env, externalProviderEnabled);
  const effectiveConfig = readAiPartnerConfig(policyEnv);
  validateEffectiveConfig(effectiveConfig);
  const policy = Object.freeze({
    version: AI_PARTNER_OWNER_SECURITY_COST_FALLBACK_VERSION,
    ownerTelegramId: owner,
    createdAt: at,
    modelPolicy,
    externalProviderEnabled,
    externalConsent,
    allowedModelAliases: Object.freeze(
      externalProviderEnabled
        ? [AI_PARTNER_MODEL_ALIASES.dragon, AI_PARTNER_MODEL_ALIASES.safe]
        : [AI_PARTNER_MODEL_ALIASES.safe],
    ),
    primaryModelAlias: externalProviderEnabled
      ? AI_PARTNER_MODEL_ALIASES.dragon
      : AI_PARTNER_MODEL_ALIASES.safe,
    fallbackModelAlias: AI_PARTNER_MODEL_ALIASES.safe,
    memoryPolicyVersion: AI_PARTNER_OWNER_MEMORY_POLICY_VERSION,
    memoryMode: "disabled",
    memoryExchanges: 0,
    cacheAllowed: false,
    config: effectiveConfig,
    budget: Object.freeze({
      pricing: AI_PARTNER_DEEPSEEK_FLASH_PRICING,
      dailySuccessLimit: effectiveConfig.dailyBurst,
      cycleSuccessLimit: effectiveConfig.cycleSuccess,
      pilotUsers: effectiveConfig.pilotUsers,
      userCostCeilingMicrousd:
        effectiveConfig.userCostCeilingMicrousd,
      globalCostCeilingMicrousd:
        effectiveConfig.globalCostCeilingMicrousd,
    }),
  });
  VERIFIED_POLICIES.add(policy);
  return policy;
}

export function assertAiPartnerOwnerPart4Policy(
  policy,
  {
    ownerTelegramId,
    at,
  } = {},
) {
  if (!policy || !VERIFIED_POLICIES.has(policy)) {
    throw part4Error("ai_partner_part4_verified_policy_required");
  }
  if (
    ownerTelegramId !== undefined &&
    policy.ownerTelegramId !== positiveTelegramId(
      ownerTelegramId,
      "ai_partner_part4_policy_owner_invalid",
    )
  ) {
    throw part4Error("ai_partner_part4_policy_owner_mismatch");
  }
  if (at !== undefined) {
    const timestamp = clock(at);
    if (
      timestamp < policy.createdAt ||
      timestamp - policy.createdAt >
        AI_PARTNER_OWNER_PART4_LIMITS.consentTokenTtlSeconds
    ) {
      throw part4Error("ai_partner_part4_policy_expired");
    }
  }
  return policy;
}

export function applyAiPartnerOwnerPart4Policy(env, policy) {
  const verified = assertAiPartnerOwnerPart4Policy(policy);
  const owner = positiveTelegramId(
    env?.ADMIN_ID,
    "ai_partner_part4_admin_not_configured",
  );
  if (owner !== verified.ownerTelegramId) {
    throw part4Error("ai_partner_part4_policy_owner_mismatch");
  }
  return effectiveEnvironment(env, verified.externalProviderEnabled);
}

export function createAiPartnerOwnerPart4GatewayContext(
  policy,
  {
    dataClass,
    at,
  } = {},
) {
  const timestamp = clock(at);
  const verified = assertAiPartnerOwnerPart4Policy(policy, { at: timestamp });
  const cycleStart = Math.floor(timestamp / (30 * 24 * 60 * 60)) *
    (30 * 24 * 60 * 60);
  return createVerifiedAdminGatewayContext({
    actorTelegramId: verified.ownerTelegramId,
    ownerTelegramId: verified.ownerTelegramId,
    isAdmin: true,
    purpose: "admin_chat",
    at: timestamp,
    userCycleStartAt: cycleStart,
    userCycleEndAt: cycleStart + 30 * 24 * 60 * 60,
    globalCycleStartAt: cycleStart,
    globalCycleEndAt: cycleStart + 30 * 24 * 60 * 60,
    externalConsent: verified.externalProviderEnabled
      ? verified.externalConsent
      : null,
    dataClass,
    cacheAllowed: false,
  });
}

export function scanAiPartnerOwnerPart4Prompt(value) {
  const prompt = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (
    !prompt ||
    prompt.length > AI_PARTNER_OWNER_PART4_LIMITS.maximumPromptCharacters ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(prompt)
  ) {
    return Object.freeze({
      allowed: false,
      reason: "prompt_invalid",
      ruleCodes: Object.freeze(["prompt_invalid"]),
    });
  }
  const ruleCodes = [];
  for (const rule of BLOCKED_PROMPT_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(prompt)) ruleCodes.push(rule.code);
  }
  for (const pattern of BLOCKING_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(prompt)) ruleCodes.push("secret_material");
  }
  return Object.freeze({
    allowed: ruleCodes.length === 0,
    reason: ruleCodes.length ? "prompt_injection_blocked" : "allowed",
    ruleCodes: Object.freeze([...new Set(ruleCodes)]),
    prompt: ruleCodes.length ? null : prompt,
  });
}

export function assertAiPartnerOwnerPart4Prompt(policy, value) {
  assertAiPartnerOwnerPart4Policy(policy);
  const scan = scanAiPartnerOwnerPart4Prompt(value);
  if (!scan.allowed) {
    throw part4Error(scan.reason);
  }
  return scan.prompt;
}

function scanOutputValue(value, state, depth = 0) {
  if (depth > 20) throw part4Error("ai_partner_part4_output_depth_invalid");
  if (typeof value === "string") {
    state.characters += value.length;
    for (const pattern of BLOCKED_OUTPUT_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) state.blocked = true;
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) scanOutputValue(entry, state, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (new Set(["__proto__", "prototype", "constructor"]).has(key)) {
      throw part4Error("ai_partner_part4_output_key_denied");
    }
    scanOutputValue(child, state, depth + 1);
  }
}

export function assertAiPartnerOwnerPart4Output(policy, output) {
  assertAiPartnerOwnerPart4Policy(policy);
  if (!plainObject(output)) {
    throw part4Error("ai_partner_part4_output_invalid");
  }
  const state = { characters: 0, blocked: false };
  scanOutputValue(output, state);
  if (
    state.characters < 1 ||
    state.characters > AI_PARTNER_OWNER_PART4_LIMITS.maximumOutputCharacters
  ) {
    throw part4Error("ai_partner_part4_output_size_invalid");
  }
  if (state.blocked) {
    throw part4Error("ai_partner_part4_output_dlp_blocked");
  }
  return output;
}

export function assertAiPartnerOwnerPart4ProviderPayload(policy, payload) {
  assertAiPartnerOwnerPart4Policy(policy);
  if (
    !plainObject(payload) ||
    Object.keys(payload).length !== 1 ||
    !Array.isArray(payload.messages) ||
    payload.messages.length !== 2
  ) {
    throw part4Error("ai_partner_part4_provider_payload_invalid");
  }
  const roles = payload.messages.map((message) => String(message?.role || ""));
  if (roles[0] !== "system" || roles[1] !== "user" || roles.includes("assistant")) {
    throw part4Error("ai_partner_part4_memory_or_role_escalation_denied");
  }
  for (const message of payload.messages) {
    if (
      !plainObject(message) ||
      Object.keys(message).sort().join(",") !== "content,role" ||
      typeof message.content !== "string" ||
      !message.content.trim()
    ) {
      throw part4Error("ai_partner_part4_provider_message_invalid");
    }
    for (const pattern of BLOCKING_SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(message.content)) {
        throw part4Error("ai_partner_part4_provider_secret_blocked");
      }
    }
  }
  const userContent = payload.messages[1].content;
  const taskPrefix = "Задача владельца:";
  const taskLine = userContent
    .split(String.fromCharCode(10))
    .find((line) => line.startsWith(taskPrefix));
  const promptCandidate = taskLine
    ? taskLine.slice(taskPrefix.length).trim()
    : userContent;
  const promptScan = scanAiPartnerOwnerPart4Prompt(promptCandidate);
  if (!promptScan.allowed) {
    throw part4Error("ai_partner_part4_provider_prompt_blocked");
  }
  return payload;
}

export async function prepareAiPartnerOwnerExternalConsent(
  env,
  input = {},
  dependencies = {},
) {
  exactFields(
    input,
    ALLOWED_CONSENT_INPUTS,
    "ai_partner_part4_consent_input_invalid",
    "ai_partner_part4_consent_field_denied",
  );
  requirePart4Enabled(env);
  const owner = requireOwner(env, input.actorTelegramId);
  const action = String(input.action || "").trim().toLowerCase();
  if (!CONSENT_ACTIONS.has(action)) {
    throw part4Error("ai_partner_part4_consent_action_invalid");
  }
  const issuedAt = clock(input.at);
  const expiresAt =
    issuedAt + AI_PARTNER_OWNER_PART4_LIMITS.consentTokenTtlSeconds;
  const payload = base64UrlEncode(canonicalJson({
    v: 1,
    tokenVersion: AI_PARTNER_OWNER_EXTERNAL_CONSENT_TOKEN_VERSION,
    consentVersion: AI_GATEWAY_PROVIDER_CONSENT_VERSION,
    ownerTelegramId: owner,
    action,
    issuedAt,
    expiresAt,
  }));
  const signature = await hmac(
    String(env.AI_PARTNER_PRIVATE_CACHE_SECRET || ""),
    "a138c",
    payload,
    dependencies.cryptoImpl || globalThis.crypto,
  );
  return Object.freeze({
    action,
    issuedAt,
    expiresAt,
    token: `a138c.${payload}.${base64UrlEncode(signature.slice(0, 16))}`,
  });
}

async function verifyConsentToken(env, actorTelegramId, token, at, cryptoImpl) {
  const owner = requireOwner(env, actorTelegramId);
  const match = String(token || "").match(CONSENT_TOKEN);
  if (!match) throw part4Error("ai_partner_part4_consent_token_invalid");
  const expected = await hmac(
    String(env.AI_PARTNER_PRIVATE_CACHE_SECRET || ""),
    "a138c",
    match[1],
    cryptoImpl,
  );
  const actual = base64UrlDecode(match[2]);
  if (actual.length !== 16) {
    throw part4Error("ai_partner_part4_consent_token_invalid");
  }
  let mismatch = 0;
  for (let index = 0; index < 16; index += 1) {
    mismatch |= actual[index] ^ expected[index];
  }
  if (mismatch !== 0) {
    throw part4Error("ai_partner_part4_consent_token_invalid");
  }
  let payload;
  try {
    payload = JSON.parse(TEXT_DECODER.decode(base64UrlDecode(match[1])));
  } catch (cause) {
    throw part4Error("ai_partner_part4_consent_token_invalid", cause);
  }
  const timestamp = clock(at);
  if (
    !plainObject(payload) ||
    payload.v !== 1 ||
    payload.tokenVersion !== AI_PARTNER_OWNER_EXTERNAL_CONSENT_TOKEN_VERSION ||
    payload.consentVersion !== AI_GATEWAY_PROVIDER_CONSENT_VERSION ||
    payload.ownerTelegramId !== owner ||
    !CONSENT_ACTIONS.has(payload.action) ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt !==
      payload.issuedAt + AI_PARTNER_OWNER_PART4_LIMITS.consentTokenTtlSeconds ||
    timestamp < payload.issuedAt ||
    timestamp >= payload.expiresAt
  ) {
    throw part4Error(
      Number.isSafeInteger(payload?.expiresAt) && timestamp >= payload.expiresAt
        ? "ai_partner_part4_consent_token_expired"
        : "ai_partner_part4_consent_token_invalid",
    );
  }
  return Object.freeze(payload);
}

export async function consumeAiPartnerOwnerExternalConsent(
  env,
  input = {},
  dependencies = {},
) {
  exactFields(
    input,
    ALLOWED_CONSUME_INPUTS,
    "ai_partner_part4_consent_consume_invalid",
    "ai_partner_part4_consent_consume_field_denied",
  );
  requirePart4Enabled(env);
  const at = clock(input.at);
  const payload = await verifyConsentToken(
    env,
    input.actorTelegramId,
    input.token,
    at,
    dependencies.cryptoImpl || globalThis.crypto,
  );
  if (payload.action === "grant") {
    await env.DB.prepare(
      `INSERT INTO ai_user_consents (
         telegram_id, consent_version, consented_at, revoked_at, updated_at
       ) VALUES (?, ?, datetime(?, 'unixepoch'), NULL, datetime(?, 'unixepoch'))
       ON CONFLICT(telegram_id) DO UPDATE SET
         consent_version = excluded.consent_version,
         consented_at = excluded.consented_at,
         revoked_at = NULL,
         updated_at = excluded.updated_at`,
    ).bind(
      payload.ownerTelegramId,
      AI_GATEWAY_PROVIDER_CONSENT_VERSION,
      at,
      at,
    ).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO ai_user_consents (
         telegram_id, consent_version, consented_at, revoked_at, updated_at
       ) VALUES (?, ?, NULL, datetime(?, 'unixepoch'), datetime(?, 'unixepoch'))
       ON CONFLICT(telegram_id) DO UPDATE SET
         consent_version = excluded.consent_version,
         revoked_at = excluded.revoked_at,
         updated_at = excluded.updated_at`,
    ).bind(
      payload.ownerTelegramId,
      AI_GATEWAY_PROVIDER_CONSENT_VERSION,
      at,
      at,
    ).run();
  }
  return Object.freeze({
    ownerTelegramId: payload.ownerTelegramId,
    action: payload.action,
    consentVersion: AI_GATEWAY_PROVIDER_CONSENT_VERSION,
    changedAt: at,
  });
}

export async function readAiPartnerOwnerExternalConsentState(
  env,
  {
    actorTelegramId,
    at = Math.floor(Date.now() / 1_000),
  } = {},
) {
  const owner = requireOwner(env, actorTelegramId);
  const timestamp = clock(at);
  const current = await readExternalConsent(env.DB, owner, timestamp);
  return Object.freeze({
    ownerTelegramId: owner,
    consentVersion: AI_GATEWAY_PROVIDER_CONSENT_VERSION,
    active: Boolean(current),
    consentedAt: current?.consentedAt || null,
  });
}

export async function getAiPartnerOwnerPart4BudgetStatus(
  env,
  {
    actorTelegramId,
    at = Math.floor(Date.now() / 1_000),
  } = {},
) {
  const policy = await createAiPartnerOwnerPart4Policy(env, {
    actorTelegramId,
    at,
  });
  const context = createAiPartnerOwnerPart4GatewayContext(policy, {
    dataClass: "public",
    at,
  });
  const profile = createAiGatewayBudgetProfile(policy.budget);
  const snapshot = await getAiGatewayBudgetSnapshot(env.DB, {
    context,
    profile,
  });
  return Object.freeze({
    ownerTelegramId: policy.ownerTelegramId,
    modelPolicy: policy.modelPolicy,
    externalProviderEnabled: policy.externalProviderEnabled,
    memoryMode: policy.memoryMode,
    cacheAllowed: policy.cacheAllowed,
    usageDate: snapshot.usageDate,
    dailySuccesses: snapshot.dailySuccesses,
    cycleSuccesses: snapshot.cycleSuccesses,
    activeRequests: snapshot.activeRequests,
    userCostMicrousd: snapshot.userCostMicrousd,
    userReservedCostMicrousd: snapshot.userReservedCostMicrousd,
    userCostCeilingMicrousd: profile.userCostCeilingMicrousd,
    globalCostMicrousd: snapshot.globalCostMicrousd,
    globalReservedCostMicrousd: snapshot.globalReservedCostMicrousd,
    globalCostCeilingMicrousd: profile.globalCostCeilingMicrousd,
  });
}

export function classifyAiPartnerOwnerProviderFailure(value) {
  const code = String(value?.code || value || "provider_unavailable")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 80);
  if (AI_PARTNER_OWNER_FAILURE_MATRIX[code]) {
    return Object.freeze({ code, ...AI_PARTNER_OWNER_FAILURE_MATRIX[code] });
  }
  const status = Number(value?.statusCode ?? value?.status);
  if (Number.isInteger(status)) {
    if (status === 401 || status === 403) {
      return Object.freeze({
        code: "provider_auth_failed",
        ...AI_PARTNER_OWNER_FAILURE_MATRIX.provider_auth_failed,
      });
    }
    if (status >= 500) {
      return Object.freeze({
        code: `provider_http_${status}`,
        retryExternal: true,
        fallbackToSafe: true,
      });
    }
    if (status >= 400) {
      return Object.freeze({
        code: `provider_http_${status}`,
        retryExternal: false,
        fallbackToSafe: true,
      });
    }
  }
  return Object.freeze({
    code: code || "provider_unavailable",
    retryExternal: false,
    fallbackToSafe: true,
  });
}

function streamError(
  code,
  statusCode = null,
  usage = null,
  cause = null,
) {
  const error = new Error("DeepSeek streaming transport failed");
  error.code = code;
  if (Number.isInteger(statusCode)) error.statusCode = statusCode;
  if (usage) error.usage = usage;
  if (cause) error.cause = cause;
  return error;
}

function nonNegativeInteger(value) {
  const parsed = Number(value || 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeUsage(value = {}) {
  const inputTokens = nonNegativeInteger(
    value.prompt_tokens ?? value.input_tokens ?? value.inputTokens,
  );
  return Object.freeze({
    inputTokens,
    cachedInputTokens: Math.min(
      inputTokens,
      nonNegativeInteger(
        value.prompt_cache_hit_tokens ??
          value.prompt_tokens_details?.cached_tokens ??
          value.cached_input_tokens ??
          value.cachedInputTokens,
      ),
    ),
    outputTokens: nonNegativeInteger(
      value.completion_tokens ?? value.output_tokens ?? value.outputTokens,
    ),
  });
}

async function shouldContinueGeneration(callback) {
  if (typeof callback !== "function") return true;
  try {
    return (await callback()) !== false;
  } catch {
    return false;
  }
}

function parseSseEvent(raw) {
  const data = raw
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data) return null;
  if (data === "[DONE]") return Object.freeze({ done: true });
  let payload;
  try {
    payload = JSON.parse(data);
  } catch (cause) {
    throw streamError("provider_stream_json_invalid", 200, null, cause);
  }
  return Object.freeze({ done: false, payload });
}

async function readDeepSeekSse(response, {
  signal,
  shouldContinue,
} = {}) {
  if (!response?.body?.getReader) {
    throw streamError("provider_stream_body_missing", response?.status || null);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage = normalizeUsage();
  let usageKnown = false;
  let finishReason = "";
  let doneSeen = false;
  let eventCount = 0;
  try {
    while (true) {
      if (signal?.aborted || !(await shouldContinueGeneration(shouldContinue))) {
        if(doneSeen && finishReason==='stop' && usageKnown) break;
        await reader.cancel().catch(() => {});
        throw streamError("generation_stopped");
      }
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n?/g, "\n");
      if (
        buffer.length >
        AI_PARTNER_OWNER_PART4_LIMITS.maximumSseBufferCharacters
      ) {
        throw streamError("provider_stream_buffer_too_large", 200, usage);
      }
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseEvent(raw);
        if (!event) continue;
        eventCount += 1;
        if (eventCount > AI_PARTNER_OWNER_PART4_LIMITS.maximumSseEvents) {
          throw streamError("provider_stream_event_limit", 200, usage);
        }
        if (event.done) {
          doneSeen = true;
          continue;
        }
        const delta = event.payload?.choices?.[0]?.delta || {};
        if (String(delta.reasoning_content || "").trim()) {
          throw streamError(
            "provider_thinking_contract_violation",
            200,
            normalizeUsage(event.payload?.usage),
          );
        }
        if (typeof delta.content === "string") content += delta.content;
        if (
          content.length >
          AI_PARTNER_OWNER_PART4_LIMITS.maximumStreamCharacters
        ) {
          throw streamError("provider_stream_response_too_large", 200, usage);
        }
        for (const pattern of BLOCKED_OUTPUT_PATTERNS) {
          pattern.lastIndex = 0;
          if (pattern.test(content)) {
            throw streamError("provider_stream_dlp_blocked", 200, usage);
          }
        }
        const candidateFinish = event.payload?.choices?.[0]?.finish_reason;
        if (candidateFinish !== null && candidateFinish !== undefined) {
          finishReason = String(candidateFinish);
        }
        if (event.payload?.usage) {usage = normalizeUsage(event.payload.usage);usageKnown=streamUsageKnown(event.payload.usage);}
        if (signal?.aborted || !(await shouldContinueGeneration(shouldContinue))) {
          await reader.cancel().catch(() => {});
          throw streamError("generation_stopped", 200, usage);
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = parseSseEvent(buffer.trim());
      if (event?.done) doneSeen = true;
      else if (event) {
        const delta = event.payload?.choices?.[0]?.delta || {};
        if (typeof delta.content === "string") content += delta.content;
        if (event.payload?.usage) {usage = normalizeUsage(event.payload.usage);usageKnown=streamUsageKnown(event.payload.usage);}
        const candidateFinish = event.payload?.choices?.[0]?.finish_reason;
        if (candidateFinish !== null && candidateFinish !== undefined) {
          finishReason = String(candidateFinish);
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  if (!doneSeen) throw streamError("provider_stream_done_missing", 200, usage);
  if (!usageKnown) throw streamError("provider_usage_unknown", 200);
  if (finishReason !== "stop") {
    throw streamTerminal(streamError("provider_finish_rejected", 200, usage),usage,response.status);
  }
  if (!content.trim()) {
    throw streamTerminal(streamError("provider_empty_response", 200, usage),usage,response.status);
  }
  return streamTerminal(Object.freeze({
    content: content.trim(),
    usage,
    statusCode: response.status,
  }),usage,response.status);
}

export function createAiPartnerOwnerPart4DeepSeekTransport(
  env,
  {
    policy,
    fetchImpl = globalThis.fetch,
    shouldContinue = null,
  } = {},
) {
  const verified = assertAiPartnerOwnerPart4Policy(policy);
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetch transport is required");
  }
  return async function deepseekFlash(envelope, { signal } = {}) {
    if (!verified.externalProviderEnabled) {
      throw streamError("external_provider_not_allowed");
    }
    const apiKey = String(env?.DEEPSEEK_API_KEY || "").trim();
    if (apiKey.length < 20) throw streamError("deepseek_secret_missing");
    const body = {
      ...buildDeepSeekFlashRequest(envelope),
      stream: true,
      stream_options: Object.freeze({ include_usage: true }),
    };
    let response;
    try {
      response = await fetchImpl(AI_PARTNER_DEEPSEEK_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      if (signal?.aborted || cause?.name === "AbortError") {
        throw streamError("provider_timeout");
      }
      throw streamError("provider_unavailable");
    }
    if (!response.ok) {
      let usage = normalizeUsage();
      let usageKnown=false;
      try {
        const payload = await response.json();
        usage = normalizeUsage(payload?.usage);
        usageKnown=streamUsageKnown(payload?.usage);
      } catch {
        // Error bodies are intentionally not retained or logged.
      }
      const code = response.status === 401 || response.status === 403
        ? "provider_auth_failed"
        : `provider_http_${response.status}`;
      const error=streamError(code,response.status,usage);
      throw usageKnown?streamTerminal(error,usage,response.status):error;
    }
    const contentType = String(response.headers?.get?.("content-type") || "")
      .toLowerCase();
    if (!contentType.includes("text/event-stream")) {
      throw streamError("provider_stream_content_type_invalid", response.status);
    }
    return readDeepSeekSse(response, { signal, shouldContinue });
  };
}

export function createAiPartnerOwnerPart4ProviderTransports(
  env,
  {
    policy,
    fetchImpl = globalThis.fetch,
    shouldContinue = null,
  } = {},
) {
  const verified = assertAiPartnerOwnerPart4Policy(policy);
  const base = createAiPartnerProviderTransports(
    applyAiPartnerOwnerPart4Policy(env, verified),
    { fetchImpl },
  );
  return Object.freeze({
    qwenSafe: base.qwenSafe,
    deepseekFlash: createAiPartnerOwnerPart4DeepSeekTransport(env, {
      policy: verified,
      fetchImpl,
      shouldContinue,
    }),
  });
}

export function buildAiPartnerOwnerPart4SecurityReport(policy) {
  const verified = assertAiPartnerOwnerPart4Policy(policy);
  return Object.freeze({
    version: verified.version,
    ownerOnly: true,
    modelPolicy: verified.modelPolicy,
    primaryModelAlias: verified.primaryModelAlias,
    fallbackModelAlias: verified.fallbackModelAlias,
    externalProviderEnabled: verified.externalProviderEnabled,
    externalConsentVersion: verified.externalConsent?.version || null,
    cacheAllowed: false,
    memoryMode: verified.memoryMode,
    memoryExchanges: 0,
    toolsAllowed: 0,
    internetAllowed: false,
    thinkingAllowed: false,
    pricingVersion: verified.budget.pricing.version,
    policyVersion: AI_PARTNER_POLICY_VERSION,
  });
}
