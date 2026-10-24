import ownerWorker, {
  DragonPreviewWorkflow,
  ReferralRewardProtectionWorkflow,
} from "../v1.3.6-owner/worker-entrypoint.mjs";

export const V137_OWNER_RUNTIME_VERSION =
  "1.3.7-owner-reacceptance-part3";
export const V137_OWNER_RUNTIME_MODE = "persistent_admin_only";

export { DragonPreviewWorkflow, ReferralRewardProtectionWorkflow };
export default ownerWorker;
