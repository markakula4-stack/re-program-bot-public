import stableWorker, {
  DragonPreviewWorkflow,
  ReferralRewardProtectionWorkflow,
} from "../v1.3.8-hotfix.1/worker-entrypoint.mjs";
import {
  CABINET_V140_WIRING_RUNTIME_KEY,
  CABINET_V140_WIRING_VERSION,
  createCabinetV140ClosedWorker,
  getCabinetV140ClosedWiringSnapshot,
} from "./cabinet-worker-wiring.mjs";

globalThis[CABINET_V140_WIRING_RUNTIME_KEY] = Object.freeze({
  version: CABINET_V140_WIRING_VERSION,
  mode: "closed",
  getSnapshot: getCabinetV140ClosedWiringSnapshot,
});

export { DragonPreviewWorkflow, ReferralRewardProtectionWorkflow };
export {
  CABINET_V140_WIRING_RUNTIME_KEY,
  CABINET_V140_WIRING_VERSION,
  getCabinetV140ClosedWiringSnapshot,
};

export default createCabinetV140ClosedWorker(stableWorker);
