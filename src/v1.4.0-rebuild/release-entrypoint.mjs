import candidate,{DragonPreviewWorkflow,ReferralRewardProtectionWorkflow} from './worker-entrypoint.mjs';
import {createReleaseControl} from './release-control.mjs';
import {materializeReleaseEnv} from './release-config.mjs';
export {DragonPreviewWorkflow,ReferralRewardProtectionWorkflow};
const control=createReleaseControl();
export default Object.freeze({...candidate,async fetch(request,env,ctx){
  const scoped=await materializeReleaseEnv(env);
  const response=await control(request,scoped);return response??candidate.fetch(request,scoped,ctx);
},async scheduled(event,env,ctx){return candidate.scheduled(event,await materializeReleaseEnv(env),ctx);}});
