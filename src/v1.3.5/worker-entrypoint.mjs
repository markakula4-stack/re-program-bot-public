import worker from "../../re-program-bot-worker.js";
import {
  DragonPreviewWorkflow,
  buildDragonPreviewPrivacyStatements,
  getDragonPreviewAiDailyLimit,
  getDragonPreviewPlanAddon,
  getDragonPreviewScreen,
  reconcileDragonPreviewAccess,
  runDragonPreviewMaintenance,
  verifyDragonPreviewChannel,
} from "./dragon-preview.mjs";

globalThis.__RE_PROGRAM_DRAGON_PREVIEW_RUNTIME__ = Object.freeze({
  buildDragonPreviewPrivacyStatements,
  getDragonPreviewAiDailyLimit,
  getDragonPreviewPlanAddon,
  getDragonPreviewScreen,
  reconcileDragonPreviewAccess,
  runDragonPreviewMaintenance,
});

export { DragonPreviewWorkflow };

async function secureProbeMatches(supplied, expected) {
  const encoder = new TextEncoder();
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(supplied || ""))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(expected || ""))),
  ]);
  const left = new Uint8Array(suppliedHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return String(expected || "").length >= 32 && difference === 0;
}

function probeResponse(payload, status) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function handleDragonPreviewProbe(request, env) {
  const supplied = request.headers.get("X-Dragon-Preview-Probe");
  if (!(await secureProbeMatches(supplied, env.DRAGON_PREVIEW_PROBE_SECRET))) {
    return new Response("Not found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }
  try {
    const result = await verifyDragonPreviewChannel(env);
    return probeResponse({ status: "ready", ...result }, 200);
  } catch (error) {
    const allowedCodes = new Set([
      "preview_config_not_ready",
      "preview_bot_identity_mismatch",
      "preview_channel_identity_mismatch",
      "preview_bot_not_channel_admin",
      "bot_token_missing",
      "telegram_timeout",
      "telegram_transport_ambiguous",
      "telegram_400",
      "telegram_401",
      "telegram_403",
      "telegram_429",
      "telegram_500",
      "telegram_502",
      "telegram_503",
      "telegram_504",
    ]);
    const code = String(error?.code || "preview_probe_failed");
    return probeResponse({
      status: "not_ready",
      reason: allowedCodes.has(code) ? code : "preview_probe_failed",
    }, 503);
  }
}

const previewAwareWorker = {
  ...worker,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      url.pathname === "/health/dragon-preview" &&
      !url.search
    ) {
      return handleDragonPreviewProbe(request, env);
    }
    return worker.fetch(request, env, ctx);
  },
};

export default previewAwareWorker;
