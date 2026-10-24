import { readAiPartnerConfig } from "./ai-partner-foundation.mjs";
import { getAiPartnerOwnerWorkerDecision } from "./ai-partner-owner-worker-runtime-confirmed-part3.mjs";

export const OWNER_ONLY_PROBE_PATH = "/health/ai-partner-owner-only-part5";
export const OWNER_ONLY_PROBE_VERSION = "2026-09-23.owner-only-part5-v1";
const encoder = new TextEncoder();
const headers = {
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};

function positiveId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

async function authorized(request, env, at, cryptoImpl) {
  const timestamp = request.headers.get("X-AI-Partner-Owner-Timestamp") || "";
  const signature = request.headers.get("X-AI-Partner-Owner-Signature") || "";
  if (!/^\d{10}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature) ||
      Math.abs(at - Number(timestamp)) > 60 ||
      typeof env?.AI_PARTNER_CANARY_PROBE_SECRET !== "string" ||
      env.AI_PARTNER_CANARY_PROBE_SECRET.length < 32) return false;
  const key = await cryptoImpl.subtle.importKey("raw",
    encoder.encode(env.AI_PARTNER_CANARY_PROBE_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await cryptoImpl.subtle.sign("HMAC", key, encoder.encode([
    "ai-partner-owner-only-part5:v1", "GET", OWNER_ONLY_PROBE_PATH, timestamp,
  ].join("\n")));
  const actual = Uint8Array.from(signature.match(/../g), pair => parseInt(pair, 16));
  let mismatch = 0;
  new Uint8Array(signed).forEach((byte, index) => { mismatch |= byte ^ actual[index]; });
  return mismatch === 0;
}

export async function handleOwnerOnlyPart5Probe(request, env, {
  at = Math.floor(Date.now() / 1000),
  cryptoImpl = globalThis.crypto,
  getDecision = getAiPartnerOwnerWorkerDecision,
} = {}) {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== OWNER_ONLY_PROBE_PATH ||
      url.search || (request.headers.has("Content-Length") &&
      request.headers.get("Content-Length") !== "0")) {
    return new Response("Not Found", { status: 404, headers });
  }
  let allowed = false;
  try { allowed = await authorized(request, env, at, cryptoImpl); } catch {}
  if (!allowed) return new Response("Not Found", { status: 404, headers });

  try {
    const owner = positiveId(env.ADMIN_ID);
    if (!owner) throw new Error("owner not configured");
    const [decision, outsider] = await Promise.all([
      getDecision(env, owner, { at }),
      getDecision(env, owner === 1 ? 2 : 1, { at }),
    ]);
    const config = readAiPartnerConfig(env);
    const outsiderBlocked = outsider.eligible === false &&
      outsider.reason === "non_admin_blocked";
    const acceptedLayers = [
      "STARS_PAYMENTS_ENABLED", "STARS_REFUNDS_ENABLED",
      "STARS_RECONCILIATION_ENABLED", "REFERRAL_REWARDS_ENABLED",
      "REFERRAL_REWARD_CANDIDATES_ENABLED",
      "REFERRAL_REWARD_CONFIRMATIONS_ENABLED", "REFERRAL_BONUS_GRANTS_ENABLED",
      "ADMIN_MODERATION_ENABLED", "ADMIN_AI_CHAT_ENABLED",
      "ADMIN_DEEPSEEK_CHAT_ENABLED",
    ].every(key => env[key] === "true") &&
      env.STARS_ROLLOUT_MODE === "admin" &&
      env.REFERRAL_REWARD_ROLLOUT_MODE === "admin";
    const ownerReady = decision.eligible &&
      decision.reason === "owner_only_enabled" &&
      decision.schema?.triggers === 42 &&
      env.AI_PARTNER_OWNER_ONLY_ENABLED === "true" &&
      env.AI_PARTNER_OWNER_CONFIRMATION_UX_ENABLED === "true" &&
      env.AI_PARTNER_OWNER_WRITE_TOOLS_ENABLED === "true" &&
      env.AI_PARTNER_OWNER_MEMORY_ENABLED === "true" &&
      env.AI_PARTNER_OWNER_MODEL_POLICY === "qwen_safe" &&
      !config.externalProviderEnabled;
    const closed = !config.masterEnabled && config.rolloutMode === "off" &&
      env.AI_PARTNER_OWNER_ONLY_ENABLED === "false" &&
      decision.reason === "feature_off";
    const status = outsiderBlocked && acceptedLayers && ownerReady
      ? "owner_only_enabled"
      : outsiderBlocked && acceptedLayers && closed ? "closed" : "not_ready";
    return Response.json({
      version: "1.3.8",
      acceptanceRevision: OWNER_ONLY_PROBE_VERSION,
      status,
      nonAdminBlocked: outsiderBlocked,
      acceptedLayers,
      ownerEligible: ownerReady === true,
      schemaReady: decision.schema?.triggers === 42,
      externalProviderEnabled: config.externalProviderEnabled,
      memoryRequiresConsent: true,
      publicRollout: false,
    }, { status: status === "not_ready" ? 503 : 200, headers });
  } catch {
    return Response.json({ version: "1.3.8", status: "not_ready" },
      { status: 503, headers });
  }
}
