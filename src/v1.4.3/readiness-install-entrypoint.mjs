import accepted,{DragonPreviewWorkflow,ReferralRewardProtectionWorkflow} from './released-entrypoint.mjs';
import {materializeReleaseEnv} from '../v1.4.0-rebuild/release-config.mjs';
import {readReadinessInstallConfig,readinessInstallWebhookFence,assertReadinessInstallMode} from './readiness-install-config.mjs';
import {createReadinessInstallControl,READINESS_INSTALL_CONTROL_PATH} from './readiness-install-control.mjs';
export {DragonPreviewWorkflow,ReferralRewardProtectionWorkflow};
const control=createReadinessInstallControl();
export default Object.freeze({...accepted,async fetch(request,env,ctx){
  const config=readReadinessInstallConfig(),url=new URL(request.url);
  if(config)assertReadinessInstallMode(config);
  if(url.pathname===READINESS_INSTALL_CONTROL_PATH)return control(request,await materializeReleaseEnv(env));
  const fence=readinessInstallWebhookFence(request);if(fence)return fence;
  const response=await accepted.fetch(request,env,ctx);
  if(config&&request.method==='GET'&&url.pathname==='/health'&&!url.search&&response.ok&&
    response.headers.get('Content-Type')?.includes('application/json')){
    const data=await response.json(),headers=new Headers(response.headers);headers.delete('Content-Length');
    return Response.json({...data,recurringEnabled:false,paidNotificationsEnabled:false,
      readinessInstallStage:config.stage},{status:response.status,headers});
  }return response;
},async scheduled(event,env,ctx){
  const config=readReadinessInstallConfig();if(config)assertReadinessInstallMode(config);
  if(['prepare','recovery'].includes(config?.stage))return;
  return accepted.scheduled(event,env,ctx);
}});
