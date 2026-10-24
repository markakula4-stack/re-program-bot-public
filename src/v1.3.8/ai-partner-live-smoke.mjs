import {
  AI_PARTNER_MODEL_ALIASES,
  readAiPartnerConfig,
} from "./ai-partner-foundation.mjs";
import {
  AI_GATEWAY_HARD_LIMITS,
  createVerifiedAdminGatewayContext,
  runAiPartnerGateway,
} from "./ai-partner-gateway.mjs";
import {
  AI_PARTNER_ACCEPTANCE_REVISION,
  AI_PARTNER_ADMIN_CANARY_WINDOW_SECONDS,
  AI_PARTNER_RELEASE_VERSION,
  getAiPartnerRolloutDecision,
} from "./ai-partner-release-runtime.mjs";
import {
  AI_PARTNER_DEEPSEEK_FLASH_PRICING,
  createAiPartnerProviderTransports,
} from "./ai-partner-provider-transports.mjs";

export const AI_PARTNER_SMOKE_PATH = "/health/ai-partner-smoke";
export const AI_PARTNER_SMOKE_RESPONSE = "RE_AI_PARTNER_SMOKE_OK";

const SMOKE_ID = /^smoke-[a-z0-9_-]{16,72}$/;
const HEX_SIGNATURE = /^[0-9a-f]{64}$/;
const TEXT_ENCODER = new TextEncoder();
const SAFE_FAILURES = new Set([
  "daily_success_limit",
  "cycle_success_limit",
  "global_cost_ceiling",
  "global_token_ceiling",
  "pricing_cycle_mismatch",
  "provider_empty_response",
  "provider_finish_rejected",
  "provider_http_400",
  "provider_http_401",
  "provider_http_402",
  "provider_http_403",
  "provider_http_404",
  "provider_http_408",
  "provider_http_429",
  "provider_http_500",
  "provider_http_502",
  "provider_http_503",
  "provider_http_504",
  "provider_thinking_contract_violation",
  "provider_timeout",
  "provider_unavailable",
  "request_already_completed",
  "request_in_progress",
  "shared_output_policy_rejected",
  "user_cost_ceiling",
  "user_token_ceiling",
]);

function positiveTelegramId(value) {
  const text = String(value || "").trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function tenDigitEpoch(value) {
  const text = String(value || "").trim();
  return /^\d{10}$/.test(text) ? Number(text) : null;
}

async function hmacHex(secret, material, cryptoImpl) {
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
    TEXT_ENCODER.encode(material),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value, cryptoImpl) {
  const digest = await cryptoImpl.subtle.digest(
    "SHA-256",
    TEXT_ENCODER.encode(String(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeHexEqual(left, right) {
  if (!HEX_SIGNATURE.test(left) || !HEX_SIGNATURE.test(right)) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function emptySignedSmokeBody(request, contentLength) {
  if (request.body === null) return true;
  if (contentLength !== "0") return false;
  let reader;
  try {
    reader = request.body.getReader();
    for (let readCount = 0; readCount < 2; readCount += 1) {
      const { done, value } = await reader.read();
      if (done) return true;
      if (Number(value?.byteLength || 0) > 0) return false;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // The body boundary remains denied when cancellation is unavailable.
      }
      try {
        reader.releaseLock();
      } catch {
        // A consumed stream cannot widen the signed smoke boundary.
      }
    }
  }
}

function smokeMaterial(method, pathname, timestamp, smokeId) {
  return [
    "ai-partner-smoke:v1",
    method,
    pathname,
    timestamp,
    smokeId,
  ].join("\n");
}

export async function secureAiPartnerSmokeRequestMatches(
  request,
  env,
  {
    at = Math.floor(Date.now() / 1_000),
    cryptoImpl = globalThis.crypto,
  } = {},
) {
  if (!cryptoImpl?.subtle) return false;
  const url = new URL(request.url);
  const timestampText = String(
    request.headers.get("X-AI-Partner-Smoke-Timestamp") || "",
  );
  const smokeId = String(
    request.headers.get("X-AI-Partner-Smoke-Id") || "",
  ).trim().toLowerCase();
  const supplied = String(
    request.headers.get("X-AI-Partner-Smoke-Signature") || "",
  ).trim().toLowerCase();
  const secret = String(env?.AI_PARTNER_CANARY_PROBE_SECRET || "");
  const timestamp = Number(timestampText);
  const contentLength = request.headers.get("Content-Length");
  if (
    request.method !== "POST" ||
    url.pathname !== AI_PARTNER_SMOKE_PATH ||
    url.search ||
    !/^\d{10}$/.test(timestampText) ||
    !Number.isSafeInteger(timestamp) ||
    Math.abs(at - timestamp) > 90 ||
    !SMOKE_ID.test(smokeId) ||
    !HEX_SIGNATURE.test(supplied) ||
    secret.length < 32 ||
    ![null, "", "0"].includes(contentLength)
  ) {
    return false;
  }
  const expected = await hmacHex(
    secret,
    smokeMaterial(request.method, url.pathname, timestampText, smokeId),
    cryptoImpl,
  );
  if (!timingSafeHexEqual(expected, supplied)) return false;
  return emptySignedSmokeBody(request, contentLength);
}

function cycleWindow(at) {
  const startAt = Math.floor(at / AI_GATEWAY_HARD_LIMITS.cycleSeconds) *
    AI_GATEWAY_HARD_LIMITS.cycleSeconds;
  return Object.freeze({
    startAt,
    endAt: startAt + AI_GATEWAY_HARD_LIMITS.cycleSeconds,
  });
}

function concealedResponse() {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}

function smokeJson(payload, status) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function safeFailureReason(value) {
  const reason = String(value || "");
  return SAFE_FAILURES.has(reason) ? reason : "ai_partner_live_smoke_failed";
}

function oneShotSmokeTransports(transports) {
  const deepseekFlash = transports?.deepseekFlash;
  let externalCalls = 0;
  return Object.freeze({
    async deepseekFlash(envelope, options) {
      if (externalCalls >= 1 || typeof deepseekFlash !== "function") {
        const error = new Error("AI Partner smoke provider re-entry denied");
        error.code = "provider_smoke_reentry_denied";
        throw error;
      }
      externalCalls += 1;
      return deepseekFlash(envelope, options);
    },
    async qwenSafe() {
      const error = new Error("AI Partner smoke fallback denied");
      error.code = "provider_smoke_fallback_denied";
      throw error;
    },
  });
}

export async function runAiPartnerLiveSmoke(env, {
  smokeId,
  at = Math.floor(Date.now() / 1_000),
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  transports = null,
} = {}) {
  const normalizedSmokeId = String(smokeId || "").trim().toLowerCase();
  const adminId = positiveTelegramId(env?.ADMIN_ID);
  if (!SMOKE_ID.test(normalizedSmokeId) || !adminId || !env?.DB?.prepare) {
    throw new Error("AI Partner live smoke precondition failed");
  }
  const decision = await getAiPartnerRolloutDecision(env, adminId, { at });
  if (
    !decision.eligible ||
    decision.reason !== "admin_canary" ||
    decision.modelAlias !== AI_PARTNER_MODEL_ALIASES.dragon ||
    decision.provider !== "deepseek" ||
    decision.thinkingEnabled !== false
  ) {
    const error = new Error("AI Partner live smoke gate is closed");
    error.code = decision.reason || "ai_partner_live_smoke_gate_closed";
    throw error;
  }
  const approvedAt = tenDigitEpoch(env.AI_PARTNER_ADMIN_CANARY_APPROVED_AT);
  const expiresAt = tenDigitEpoch(env.AI_PARTNER_ADMIN_CANARY_APPROVED_UNTIL);
  if (
    !approvedAt ||
    !expiresAt ||
    approvedAt > at ||
    expiresAt <= at ||
    expiresAt - approvedAt > AI_PARTNER_ADMIN_CANARY_WINDOW_SECONDS
  ) {
    throw new Error("AI Partner live smoke approval is invalid");
  }
  const cycle = cycleWindow(at);
  const approvalIdHash = await sha256Hex(
    `ai-partner-smoke-approval:v1:${normalizedSmokeId}`,
    cryptoImpl,
  );
  const context = createVerifiedAdminGatewayContext({
    actorTelegramId: adminId,
    isAdmin: true,
    purpose: "closed_benchmark",
    at,
    userCycleStartAt: cycle.startAt,
    userCycleEndAt: cycle.endAt,
    globalCycleStartAt: cycle.startAt,
    globalCycleEndAt: cycle.endAt,
    benchmarkApproval: {
      approvalIdHash,
      approvedAt,
      expiresAt,
      scope: AI_PARTNER_MODEL_ALIASES.dragon,
    },
    dataClass: "public",
    cacheAllowed: false,
  });
  const providerTransports = transports || createAiPartnerProviderTransports(
    env,
    { fetchImpl },
  );
  const result = await runAiPartnerGateway({
    db: env.DB,
    context,
    config: readAiPartnerConfig(env),
    request: {
      requestId: normalizedSmokeId,
      dataClass: "public",
      estimatedInputTokens: 96,
      maxOutputTokens: 24,
      sourceCount: 0,
      allowCache: false,
      payload: {
        messages: [
          {
            role: "system",
            content:
              "Закрытая техническая проверка RE AI Partner. Не используй " +
              "инструменты и интернет. Ответь только указанным маркером, без " +
              "кавычек, форматирования и пояснений.",
          },
          {
            role: "user",
            content: `Верни ровно: ${AI_PARTNER_SMOKE_RESPONSE}`,
          },
        ],
      },
    },
    pricing: AI_PARTNER_DEEPSEEK_FLASH_PRICING,
    transports: oneShotSmokeTransports(providerTransports),
    providerUserIdSecret: env.AI_PARTNER_PROVIDER_USER_ID_SECRET,
    cacheScopeSecret: env.AI_PARTNER_PRIVATE_CACHE_SECRET,
    validateOutput: async (content) => {
      if (String(content || "").trim() !== AI_PARTNER_SMOKE_RESPONSE) {
        const error = new Error("AI Partner live smoke marker mismatch");
        error.code = "smoke_marker_mismatch";
        throw error;
      }
      return Object.freeze({ accepted: true });
    },
    cryptoImpl,
  });
  if (!result.ok) {
    const error = new Error("AI Partner live smoke provider failed");
    error.code = safeFailureReason(result.reason);
    throw error;
  }
  if (
    result.modelAlias !== AI_PARTNER_MODEL_ALIASES.dragon ||
    result.fallbackUsed !== false
  ) {
    const error = new Error("AI Partner live smoke did not use Flash primary");
    error.code = "deepseek_primary_not_proven";
    throw error;
  }
  return Object.freeze({
    status: "passed",
    version: AI_PARTNER_RELEASE_VERSION,
    acceptanceRevision: AI_PARTNER_ACCEPTANCE_REVISION,
    rollout: "admin",
    provider: "deepseek",
    modelAlias: result.modelAlias,
    thinkingEnabled: false,
    fallbackUsed: false,
    attemptCount: result.telemetry.attemptCount,
    retryCount: result.telemetry.retryCount,
    billedTokens: result.telemetry.billedTokens,
    cachedInputTokens: result.telemetry.cachedInputTokens,
    costMicrousd: result.telemetry.costMicrousd,
    totalLatencyMs: result.telemetry.totalLatencyMs,
    pricingVersion: AI_PARTNER_DEEPSEEK_FLASH_PRICING.version,
  });
}

export async function handleAiPartnerLiveSmoke(request, env, options = {}) {
  const at = options.at ?? Math.floor(Date.now() / 1_000);
  if (!(await secureAiPartnerSmokeRequestMatches(request, env, {
    at,
    cryptoImpl: options.cryptoImpl || globalThis.crypto,
  }))) {
    return concealedResponse();
  }
  const smokeId = String(
    request.headers.get("X-AI-Partner-Smoke-Id") || "",
  ).trim().toLowerCase();
  try {
    const result = await runAiPartnerLiveSmoke(env, {
      ...options,
      smokeId,
      at,
    });
    return smokeJson(result, 200);
  } catch (error) {
    return smokeJson({
      status: "failed",
      version: AI_PARTNER_RELEASE_VERSION,
      acceptanceRevision: AI_PARTNER_ACCEPTANCE_REVISION,
      rollout: "admin",
      reason: safeFailureReason(error?.code),
    }, 503);
  }
}
