import stableWorker, {
  DragonPreviewWorkflow,
  ReferralRewardProtectionWorkflow,
} from "../v1.4.0/worker-entrypoint.mjs";
import { callStarsTelegram } from "../v1.3.6/stars-payment-runtime.mjs";

export const OWNER_WEBHOOK_INFO_PATH = "/ops/stars-owner/webhook-info";
export const OWNER_WEBHOOK_INFO_SIGNATURE_VERSION =
  "stars-owner:webhook-info:v1";
export const OWNER_WEBHOOK_ALLOWED_UPDATES = Object.freeze([
  "message",
  "callback_query",
  "pre_checkout_query",
  "stopped_message_generation",
]);

function concealedResponse() {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function safeJson(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function secureOwnerProbeMatches(request, env) {
  const timestampText = String(
    request.headers.get("X-Stars-Canary-Timestamp") || "",
  );
  const timestamp = Number(timestampText);
  const now = Math.floor(Date.now() / 1_000);
  const supplied = String(
    request.headers.get("X-Stars-Canary-Signature") || "",
  ).toLowerCase();
  const secret = String(env?.STARS_CANARY_PROBE_SECRET || "");

  if (
    !/^\d{10}$/.test(timestampText) ||
    !Number.isSafeInteger(timestamp) ||
    Math.abs(now - timestamp) > 90 ||
    !/^[a-f0-9]{64}$/.test(supplied) ||
    secret.length < 32
  ) {
    return false;
  }

  const pathname = new URL(request.url).pathname;
  const material = [
    OWNER_WEBHOOK_INFO_SIGNATURE_VERSION,
    request.method,
    pathname,
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
  let difference = expected.length ^ actual.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ (actual[index] ?? 0);
  }
  return difference === 0;
}

export function summarizeOwnerWebhookInfo(webhook, expectedUrl) {
  const actualUrl = String(webhook?.url || "");
  if (actualUrl !== expectedUrl) {
    const error = new Error("Telegram webhook identity mismatch");
    error.code = "stars_webhook_identity_mismatch";
    throw error;
  }

  const actualUpdates = Array.isArray(webhook?.allowed_updates)
    ? [...new Set(webhook.allowed_updates.map(String))].sort()
    : [];
  const expectedUpdates = [...OWNER_WEBHOOK_ALLOWED_UPDATES].sort();
  if (JSON.stringify(actualUpdates) !== JSON.stringify(expectedUpdates)) {
    const error = new Error("Telegram webhook update set mismatch");
    error.code = "stars_webhook_updates_mismatch";
    throw error;
  }

  return Object.freeze({
    status: "verified",
    webhookConfigured: true,
    messageEnabled: true,
    callbackEnabled: true,
    preCheckoutEnabled: true,
    pendingUpdates: Number(webhook?.pending_update_count || 0),
    lastErrorPresent: Boolean(webhook?.last_error_date),
  });
}

async function handleOwnerWebhookInfo(request, env) {
  if (!(await secureOwnerProbeMatches(request, env))) {
    return concealedResponse();
  }
  if (!env?.BOT_TOKEN) {
    return safeJson({
      status: "not_ready",
      reason: "telegram_bot_not_configured",
    }, 503);
  }

  try {
    const webhook = await callStarsTelegram(env, "getWebhookInfo", {});
    const expectedUrl = `${new URL(request.url).origin}/webhook`;
    return safeJson(summarizeOwnerWebhookInfo(webhook, expectedUrl));
  } catch (error) {
    const allowedReasons = new Set([
      "telegram_400",
      "telegram_401",
      "telegram_403",
      "telegram_429",
      "telegram_500",
      "telegram_502",
      "telegram_503",
      "telegram_504",
      "telegram_transport_failure",
      "telegram_transport_timeout",
      "stars_webhook_identity_mismatch",
      "stars_webhook_updates_mismatch",
    ]);
    const reason = String(error?.code || "stars_webhook_info_failed");
    return safeJson({
      status: "not_ready",
      reason: allowedReasons.has(reason)
        ? reason
        : "stars_webhook_info_failed",
    }, 503);
  }
}

export function createOwnerStarsWorker(stable = stableWorker) {
  if (!stable || typeof stable.fetch !== "function") {
    throw new TypeError("Stable Worker fetch handler is required");
  }
  return Object.freeze({
    ...stable,
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (
        request.method === "GET" &&
        url.pathname === OWNER_WEBHOOK_INFO_PATH &&
        !url.search
      ) {
        return handleOwnerWebhookInfo(request, env);
      }
      return stable.fetch(request, env, ctx);
    },
  });
}

export { DragonPreviewWorkflow, ReferralRewardProtectionWorkflow };
export default createOwnerStarsWorker(stableWorker);
