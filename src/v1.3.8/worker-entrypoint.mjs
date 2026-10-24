import stableWorker, {
  DragonPreviewWorkflow,
  ReferralRewardProtectionWorkflow,
} from "../v1.3.7/worker-entrypoint.mjs";
import {
  AI_PARTNER_ACCEPTANCE_REVISION,
  AI_PARTNER_CANARY_PATH,
  AI_PARTNER_RELEASE_VERSION,
  handleAiPartnerCanaryProbe,
} from "./ai-partner-release-runtime.mjs";
import {
  AI_PARTNER_RUNTIME_KEY,
  aiPartnerWorkerRuntime,
} from "./ai-partner-worker-runtime.mjs";
import {
  AI_PARTNER_SMOKE_PATH,
  handleAiPartnerLiveSmoke,
} from "./ai-partner-live-smoke.mjs";

const PUBLIC_RELEASE_RUNTIME_KEY = "__RE_PROGRAM_PUBLIC_RELEASE_RUNTIME__";

globalThis[PUBLIC_RELEASE_RUNTIME_KEY] = Object.freeze({
  version: AI_PARTNER_RELEASE_VERSION,
  acceptanceRevision: AI_PARTNER_ACCEPTANCE_REVISION,
});
globalThis[AI_PARTNER_RUNTIME_KEY] = aiPartnerWorkerRuntime;

export { DragonPreviewWorkflow, ReferralRewardProtectionWorkflow };

async function releaseHealth(response) {
  if (response.status !== 200) return response;
  const contentType = String(response.headers.get("content-type") || "");
  if (!contentType.toLowerCase().includes("application/json")) return response;
  const payload = await response.json();
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  return Response.json({
    ...payload,
    version: AI_PARTNER_RELEASE_VERSION,
    acceptanceRevision: AI_PARTNER_ACCEPTANCE_REVISION,
  }, { status: response.status, headers });
}

const aiPartnerAwareWorker = {
  ...stableWorker,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      url.pathname === AI_PARTNER_CANARY_PATH &&
      !url.search
    ) {
      return handleAiPartnerCanaryProbe(request, env);
    }
    if (
      request.method === "POST" &&
      url.pathname === AI_PARTNER_SMOKE_PATH &&
      !url.search
    ) {
      return handleAiPartnerLiveSmoke(request, env);
    }
    const response = await stableWorker.fetch(request, env, ctx);
    if (
      request.method === "GET" &&
      !url.search &&
      (url.pathname === "/" || url.pathname === "/health")
    ) {
      return releaseHealth(response);
    }
    return response;
  },
};

export default aiPartnerAwareWorker;
