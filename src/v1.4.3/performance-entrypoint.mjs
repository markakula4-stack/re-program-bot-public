import accepted,{DragonPreviewWorkflow,ReferralRewardProtectionWorkflow} from './released-entrypoint.mjs';
import {readV143PerformanceConfig} from './performance-config.mjs';
export {DragonPreviewWorkflow,ReferralRewardProtectionWorkflow};
export default Object.freeze({...accepted,async fetch(request,env,ctx){
  const config=readV143PerformanceConfig();
  if(!config)return new Response('Release unavailable',{status:503});
  const response=await accepted.fetch(request,env,ctx),url=new URL(request.url);
  if(request.method==='GET'&&url.pathname==='/health'&&!url.search&&response.ok&&
    response.headers.get('Content-Type')?.includes('application/json')){
    const body=await response.json(),headers=new Headers(response.headers);headers.delete('Content-Length');
    return Response.json({...body,performanceHotfix:true,leaseSourceSha:config.parentSourceSha,
      leaseRevision:config.parentRevision,recurringEnabled:false,paidNotificationsEnabled:false},{status:response.status,headers});
  }
  return response;
},async scheduled(event,env,ctx){
  if(!readV143PerformanceConfig())throw new Error('v143_performance_config_unavailable');
  return accepted.scheduled(event,env,ctx);
}});
