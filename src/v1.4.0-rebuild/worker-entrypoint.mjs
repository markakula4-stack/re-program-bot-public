import stableWorker, {
  DragonPreviewWorkflow, ReferralRewardProtectionWorkflow,
} from "../v1.3.9/worker-entrypoint.mjs";
import { createRebuildWorker } from "./worker-router.mjs";
import { reviewedRepositoryFactory } from './storage-factory.mjs';
import { installRebuildPrivacyRuntime } from './privacy-runtime.mjs';
import {installAdminCabinetMenuRuntime} from './admin-cabinet-menu.mjs';
import {installV141WorkerRuntime} from '../v1.4.1/worker-runtime.mjs';
import {v141AiRuntime} from '../v1.4.1/ai-runtime.mjs';
import {prepareV141PrivacyDeletion} from '../v1.4.1/privacy-maintenance.mjs';

export { DragonPreviewWorkflow, ReferralRewardProtectionWorkflow, createRebuildWorker };
installRebuildPrivacyRuntime();
installAdminCabinetMenuRuntime();
installV141WorkerRuntime({aiRuntime:v141AiRuntime,privacyRuntime:{prepareV141PrivacyDeletion}});
// Separate storage switch, exact reviewed DDL, finite owner window and signed
// owner session are all required. The production configuration stays closed.
export default createRebuildWorker(stableWorker,{repositoryFactory:reviewedRepositoryFactory});
