import stableWorker, {
  DragonPreviewWorkflow,
} from "../v1.3.5/worker-entrypoint.mjs";
import {
  normalizePositiveTelegramId,
  readStarsCoreConfig, STARS_TERMS_REVISION,
} from "./stars-core-foundation.mjs";
import {parseSubscriptionStartPayload,parseSubscriptionPurchaseQuote,
  createSubscriptionPurchaseQuote} from '../v1.4.2/subscription-handoff.mjs';
import { getStarsRolloutDecision, rolloutError, rolloutMode, rolloutAllowlist } from "./stars-rollout.mjs";
export { getStarsRolloutDecision } from "./stars-rollout.mjs";
import {
  acceptStarsPurchaseTerms,
  handleStarsCommerceUpdate,
  isStarsCommerceUpdate,
  issueStarsPurchase,
} from "./stars-commerce-runtime.mjs";
import {
  callStarsTelegram,
  getStarsPurchaseCatalog,
} from "./stars-payment-runtime.mjs";
import {
  buildStarsSupportText,
  buildStarsTermsText,
  getStarsPaymentDiagnostics,
  getStarsPrivacyDeletionBlockers,
  getStarsUserAccessSummary,
  getStarsUserPrivacySummary,
  listAdminStarsRefundCandidates,
  reconcileStarsTransactions,
  requestAdminOwnStarsRefund,
  requestStarsRefund,
  runStarsAccessMaintenance,
} from "./stars-access-runtime.mjs";

const STARS_RUNTIME_KEY = "__RE_PROGRAM_STARS_RUNTIME__";
const STARS_CANARY_ALLOWED_UPDATES = Object.freeze([
  "message",
  "callback_query",
  "pre_checkout_query",
  "subscription",
  "stopped_message_generation",
]);

async function assertStarsRollout(env, { telegramId } = {}) {
  const decision = await getStarsRolloutDecision(env, telegramId);
  if (!decision.eligible) throw rolloutError(decision.reason);
  return decision;
}

async function getCatalog(env, telegramId) {
  const [catalog, rollout] = await Promise.all([
    getStarsPurchaseCatalog(env),
    getStarsRolloutDecision(env, telegramId),
  ]);
  return Object.freeze({ ...catalog, rollout });
}

async function getDiagnostics(env) {
  const diagnostics = await getStarsPaymentDiagnostics(env);
  return Object.freeze({
    ...diagnostics,
    rollout: Object.freeze({
      mode: rolloutMode(env),
      percent: rolloutMode(env) === "percent"
        ? Number(env?.STARS_ROLLOUT_PERCENT || 0)
        : 0,
      allowlistSize: rolloutAllowlist(env).size,
    }),
  });
}

async function secureCanaryRequestMatches(request, env) {
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
  const url = new URL(request.url);
  const material = [
    "stars-canary:v1",
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
  const expectedBytes = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(material),
  ));
  const suppliedBytes = Uint8Array.from(
    supplied.match(/.{2}/g).map((value) => Number.parseInt(value, 16)),
  );
  let difference = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= expectedBytes[index] ^ suppliedBytes[index];
  }
  return difference === 0;
}

function concealedCanaryResponse() {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}

function canaryJson(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function getStarsCanarySnapshot(env) {
  const diagnostics = await getDiagnostics(env);
  const adminId = normalizePositiveTelegramId(env?.ADMIN_ID);
  if (!adminId) throw rolloutError("stars_admin_not_configured");
  const nonAdminId = adminId === 1 ? 2 : 1;
  const [admin, nonAdmin] = await Promise.all([
    getStarsRolloutDecision(env, adminId),
    getStarsRolloutDecision(env, nonAdminId),
  ]);
  const switches = Object.freeze({
    paymentsEnabled: Boolean(diagnostics?.switches?.paymentsEnabled),
    paymentsReady: Boolean(diagnostics?.switches?.paymentsReady),
    refundsEnabled: Boolean(diagnostics?.switches?.refundsEnabled),
    reconciliationEnabled: Boolean(
      diagnostics?.switches?.reconciliationEnabled,
    ),
  });
  const rollout = Object.freeze({
    mode: String(diagnostics?.rollout?.mode || "off"),
    percent: Number(diagnostics?.rollout?.percent || 0),
    allowlistSize: Number(diagnostics?.rollout?.allowlistSize || 0),
    adminEligible: Boolean(admin?.eligible),
    nonAdminBlocked: !nonAdmin?.eligible,
  });
  const database = Object.freeze({
    ready: Boolean(diagnostics?.ready),
    schemaTables: Number(diagnostics?.schemaTables || 0),
    expectedSchemaTables: Number(diagnostics?.expectedSchemaTables || 0),
    paidPending: Number(diagnostics?.orders?.paidPending || 0),
    refundManualReview: Number(diagnostics?.refunds?.manualReview || 0),
    refundUnsettled: Number(diagnostics?.refunds?.unsettled || 0),
    reconciliationStatus: diagnostics?.reconciliation?.status || null,
    reconciliationDiscrepancies: Number(
      diagnostics?.reconciliation?.discrepancies || 0,
    ),
  });
  const closed = !switches.paymentsEnabled &&
    !switches.paymentsReady &&
    !switches.refundsEnabled &&
    !switches.reconciliationEnabled &&
    rollout.mode === "off" &&
    !rollout.adminEligible && rollout.nonAdminBlocked;
  const adminCanary = switches.paymentsEnabled &&
    switches.paymentsReady &&
    switches.refundsEnabled &&
    switches.reconciliationEnabled &&
    rollout.mode === "admin" &&
    rollout.percent === 0 &&
    rollout.allowlistSize === 0 &&
    rollout.adminEligible && rollout.nonAdminBlocked &&
    database.ready && database.paidPending === 0 &&
    database.refundManualReview === 0 && database.refundUnsettled === 0 &&
    database.reconciliationDiscrepancies === 0;
  return Object.freeze({
    service: "re-program-bot",
    version: "1.3.6",
    acceptanceRevision: "2026-09-10.stars-core-rc1",
    status: closed ? "closed" : adminCanary ? "admin_canary" : "not_ready",
    switches,
    rollout,
    database,
    configurationProblems: Object.freeze(
      (diagnostics?.configurationProblems || []).map(String).slice(0, 10),
    ),
  });
}

async function handleStarsCanaryProbe(request, env) {
  if (!(await secureCanaryRequestMatches(request, env))) {
    return concealedCanaryResponse();
  }
  try {
    const snapshot = await getStarsCanarySnapshot(env);
    return canaryJson(snapshot, snapshot.status === "not_ready" ? 503 : 200);
  } catch {
    return canaryJson({
      service: "re-program-bot",
      version: "1.3.6",
      status: "not_ready",
      reason: "stars_canary_probe_failed",
    }, 503);
  }
}

async function configureStarsCanaryWebhook(request, env) {
  if (!(await secureCanaryRequestMatches(request, env))) {
    return concealedCanaryResponse();
  }
  const snapshot = await getStarsCanarySnapshot(env).catch(() => null);
  if (snapshot?.status !== "admin_canary") {
    return canaryJson({
      status: "rejected",
      reason: "admin_canary_not_ready",
    }, 409);
  }
  if (!env?.WEBHOOK_SECRET || !env?.BOT_TOKEN) {
    return canaryJson({
      status: "rejected",
      reason: "telegram_webhook_config_not_ready",
    }, 503);
  }
  const webhookUrl = `${new URL(request.url).origin}/webhook`;
  try {
    const configured = await callStarsTelegram(env, "setWebhook", {
      url: webhookUrl,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: [...STARS_CANARY_ALLOWED_UPDATES],
      drop_pending_updates: false,
    });
    if (configured !== true) throw rolloutError("stars_webhook_not_confirmed");
    const webhook = await callStarsTelegram(env, "getWebhookInfo", {});
    if (String(webhook?.url || "") !== webhookUrl) {
      throw rolloutError("stars_webhook_identity_mismatch");
    }
    const actualAllowedUpdates = Array.isArray(webhook?.allowed_updates)
      ? [...webhook.allowed_updates].map(String).sort()
      : [];
    const expectedAllowedUpdates = [...STARS_CANARY_ALLOWED_UPDATES].sort();
    if (
      JSON.stringify(actualAllowedUpdates) !==
      JSON.stringify(expectedAllowedUpdates)
    ) {
      throw rolloutError("stars_webhook_updates_mismatch");
    }
    return canaryJson({
      status: "configured",
      webhook: webhookUrl,
      allowedUpdates: [...STARS_CANARY_ALLOWED_UPDATES],
      pendingUpdates: Number(webhook?.pending_update_count || 0),
    });
  } catch (error) {
    const allowed = new Set([
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
      "stars_webhook_not_confirmed",
      "stars_webhook_identity_mismatch",
      "stars_webhook_updates_mismatch",
    ]);
    const reason = String(error?.code || "stars_webhook_setup_failed");
    return canaryJson({
      status: "not_ready",
      reason: allowed.has(reason) ? reason : "stars_webhook_setup_failed",
    }, 503);
  }
}

globalThis[STARS_RUNTIME_KEY] = Object.freeze({
  subscriptionHandoff: Object.freeze({parseStartPayload:parseSubscriptionStartPayload,
    parsePurchaseQuote:parseSubscriptionPurchaseQuote,createPurchaseQuote:createSubscriptionPurchaseQuote,
    readConfig:readStarsCoreConfig,termsRevision:STARS_TERMS_REVISION}),
  acceptPurchaseTerms: acceptStarsPurchaseTerms,
  buildSupportText: buildStarsSupportText,
  buildTermsText: buildStarsTermsText,
  getCatalog,
  getDiagnostics,
  getPrivacyDeletionBlockers: getStarsPrivacyDeletionBlockers,
  getUserAccessSummary: getStarsUserAccessSummary,
  getUserPrivacySummary: getStarsUserPrivacySummary,
  handleUpdate(env, update, options = {}) {
    return handleStarsCommerceUpdate(env, update, {
      ...options,
      purchaseGuard: assertStarsRollout,
    });
  },
  isUpdate: isStarsCommerceUpdate,
  issuePurchase(env, request, options = {}) {
    return issueStarsPurchase(env, request, {
      ...options,
      async purchaseGuard(runtimeEnv, purchase) {
        await assertStarsRollout(runtimeEnv, purchase);
        if (typeof options.purchaseGuard === "function") {
          await options.purchaseGuard(runtimeEnv, purchase);
        }
      },
    });
  },
  reconcileTransactions: reconcileStarsTransactions,
  listRefundCandidates: listAdminStarsRefundCandidates,
  requestOwnRefund: requestAdminOwnStarsRefund,
  requestRefund: requestStarsRefund,
  runMaintenance: runStarsAccessMaintenance,
});

export { DragonPreviewWorkflow };
const canaryAwareWorker = {
  ...stableWorker,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      url.pathname === "/health/stars-canary" &&
      !url.search
    ) {
      return handleStarsCanaryProbe(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/ops/stars-canary/webhook" &&
      !url.search
    ) {
      return configureStarsCanaryWebhook(request, env);
    }
    return stableWorker.fetch(request, env, ctx);
  },
};

export default canaryAwareWorker;
