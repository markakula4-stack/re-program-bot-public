import stableWorker, {
  DragonPreviewWorkflow,
  getStarsRolloutDecision,
} from "../v1.3.6/worker-entrypoint.mjs";
import {
  handleStarsCommerceUpdate,
} from "./stars-commerce-runtime.mjs";
import {
  ReferralRewardProtectionWorkflow,
} from "./referral-reward-protection-workflow.mjs";
import {
  getReferralRewardAdminRepairConfirmation,
  getReferralRewardAdminScreen,
  runReferralRewardAdminRepair,
  runReferralRewardMaintenance,
} from "./referral-reward-ux-admin-runtime.mjs";
import {
  claimReferralRewardForUser,
  getReferralRewardMenuButton,
  getReferralRewardUserScreen,
} from "./referral-reward-owner-ux-runtime.mjs";
import {
  REFERRAL_ACCEPTANCE_REVISION,
  REFERRAL_CANARY_PATH,
  REFERRAL_RELEASE_VERSION,
  handleReferralRewardCanaryProbe,
} from "./referral-reward-release-runtime.mjs";

const STARS_RUNTIME_KEY = "__RE_PROGRAM_STARS_RUNTIME__";
const REFERRAL_REWARD_RUNTIME_KEY = "__RE_PROGRAM_REFERRAL_REWARD_RUNTIME__";
const PUBLIC_RELEASE_RUNTIME_KEY = "__RE_PROGRAM_PUBLIC_RELEASE_RUNTIME__";

globalThis[PUBLIC_RELEASE_RUNTIME_KEY] = Object.freeze({
  version: REFERRAL_RELEASE_VERSION,
  acceptanceRevision: REFERRAL_ACCEPTANCE_REVISION,
});

function rolloutError(code) {
  const error = new Error("Telegram Stars rollout gate rejected the request");
  error.code = code;
  return error;
}

async function assertStarsRollout(env, { telegramId } = {}) {
  const decision = await getStarsRolloutDecision(env, telegramId);
  if (!decision.eligible) throw rolloutError(decision.reason);
  return decision;
}

const stableStarsRuntime = globalThis[STARS_RUNTIME_KEY];
if (stableStarsRuntime) {
  globalThis[STARS_RUNTIME_KEY] = Object.freeze({
    ...stableStarsRuntime,
    handleUpdate(env, update, options = {}) {
      return handleStarsCommerceUpdate(env, update, {
        ...options,
        purchaseGuard: assertStarsRollout,
      });
    },
  });
}

globalThis[REFERRAL_REWARD_RUNTIME_KEY] = Object.freeze({
  getMenuButton: getReferralRewardMenuButton,
  getUserScreen: getReferralRewardUserScreen,
  claimUserBonus: claimReferralRewardForUser,
  getAdminScreen: getReferralRewardAdminScreen,
  getAdminRepairConfirmation: getReferralRewardAdminRepairConfirmation,
  runAdminRepair: runReferralRewardAdminRepair,
  runMaintenance: runReferralRewardMaintenance,
});

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
    version: REFERRAL_RELEASE_VERSION,
    acceptanceRevision: REFERRAL_ACCEPTANCE_REVISION,
  }, { status: response.status, headers });
}

const releaseAwareWorker = {
  ...stableWorker,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      url.pathname === REFERRAL_CANARY_PATH &&
      !url.search
    ) {
      return handleReferralRewardCanaryProbe(request, env);
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

export default releaseAwareWorker;
