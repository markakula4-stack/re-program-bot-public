// Part 3 has its own entrypoint so the sealed Part 5 runtime and hotfix entrypoint
// remain exact historical evidence. Part 5 may select this file for a closed
// owner-only deployment after schema and feature-flag checks.
import hotfixWorker, {
  DragonPreviewWorkflow,
  ReferralRewardProtectionWorkflow,
} from "../v1.3.8-hotfix.1/worker-entrypoint.mjs";
import { AI_PARTNER_RUNTIME_KEY } from "../v1.3.8/ai-partner-worker-runtime.mjs";
import {
  aiPartnerOwnerWorkerRuntimePart5 as confirmedOwnerRuntime,
} from "../v1.3.8/ai-partner-owner-worker-runtime-confirmed-part3.mjs";
import {
  handleOwnerOnlyPart5Probe,
  OWNER_ONLY_PROBE_PATH,
} from "../v1.3.8/ai-partner-owner-only-probe.mjs";

globalThis[AI_PARTNER_RUNTIME_KEY] = confirmedOwnerRuntime;

export { DragonPreviewWorkflow, ReferralRewardProtectionWorkflow };
export default {
  ...hotfixWorker,
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === OWNER_ONLY_PROBE_PATH) {
      return handleOwnerOnlyPart5Probe(request, env);
    }
    return hotfixWorker.fetch(request, env, ctx);
  },
};
