import v138Worker, {
  DragonPreviewWorkflow,
  ReferralRewardProtectionWorkflow,
} from "../v1.3.8/worker-entrypoint.mjs";
import {
  ADMIN_SAFETY_HOTFIX_VERSION,
  ADMIN_SAFETY_RUNTIME_KEY,
  adminSafetyRuntime,
} from "../v1.3.8/admin-safety-chat-hotfix.mjs";
import {
  AI_PARTNER_OWNER_WORKER_RUNTIME_KEY,
  aiPartnerOwnerWorkerRuntimePart5,
} from "../v1.3.8/ai-partner-owner-worker-runtime-part5.mjs";
import {
  AI_PARTNER_OWNER_CANARY_PATH,
  handleAiPartnerOwnerCanaryProbe,
} from "../v1.3.8/ai-partner-owner-canary-probe-part5.mjs";

const PUBLIC_RELEASE_RUNTIME_KEY = "__RE_PROGRAM_PUBLIC_RELEASE_RUNTIME__";

globalThis[PUBLIC_RELEASE_RUNTIME_KEY] = Object.freeze({
  version: ADMIN_SAFETY_HOTFIX_VERSION,
  acceptanceRevision: "admin-safety-chat-hotfix.1",
});
globalThis[ADMIN_SAFETY_RUNTIME_KEY] = adminSafetyRuntime;
globalThis[AI_PARTNER_OWNER_WORKER_RUNTIME_KEY] =
  aiPartnerOwnerWorkerRuntimePart5;

export { DragonPreviewWorkflow, ReferralRewardProtectionWorkflow };

async function hotfixHealth(response) {
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
    version: ADMIN_SAFETY_HOTFIX_VERSION,
    acceptanceRevision: "admin-safety-chat-hotfix.1",
  }, { status: response.status, headers });
}

const hotfixWorker = {
  ...v138Worker,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      url.pathname === AI_PARTNER_OWNER_CANARY_PATH &&
      !url.search
    ) {
      return handleAiPartnerOwnerCanaryProbe(request, env);
    }
    const response = await v138Worker.fetch(request, env, ctx);
    if (
      request.method === "GET" &&
      !url.search &&
      (url.pathname === "/" || url.pathname === "/health")
    ) {
      return hotfixHealth(response);
    }
    return response;
  },
};

export default hotfixWorker;
