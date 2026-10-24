import candidate,{DragonPreviewWorkflow,ReferralRewardProtectionWorkflow} from './released-entrypoint.mjs';
import {assertV143NativeReadinessCompiledDescriptors,assertV143NativeReadinessRuntimeData,
  readV143NativeReadinessConfig,v143NativeReadinessHealthProjection} from './native-readiness-config.mjs';
import {createNativeStageControl,readV143NativeStageConfig,NATIVE_STAGE_CONTROL_PATH,
  v143NativeStageWebhookFence} from './native-stage-control.mjs';
import {createNativeOwnerRefundControl,NATIVE_OWNER_REFUND_PATH} from './native-owner-refund-control.mjs';
import {materializeReleaseEnv} from '../v1.4.0-rebuild/release-config.mjs';
import {materializeV141ReleaseEnv} from '../v1.4.1/release-config.mjs';
import {materializeV1411AdminEnv} from '../v1.4.1/admin-release-config.mjs';
import {materializeV142ReleaseEnv} from '../v1.4.2/release-config.mjs';
import {materializeV143ReleaseEnv} from './release-config.mjs';
import {handlePackageCommerceRequest,PACKAGE_COMMERCE_API_PREFIX} from '../v1.4.4/package-commerce-runtime.mjs';
export {DragonPreviewWorkflow,ReferralRewardProtectionWorkflow};

// Validate data descriptors before any historical materializer evaluates a
// default global argument. This native wrapper never installs the OFF-only
// performance exception or exposes a lease/migration control endpoint.
const preflight=env=>{
  if(!assertV143NativeReadinessCompiledDescriptors())throw new Error('v143_native_readiness_config_required');
  assertV143NativeReadinessRuntimeData(env);
  const stage=readV143NativeStageConfig(),native=readV143NativeReadinessConfig();
  if(stage&&(stage.candidateSha!==native.sourceSha||native.mode!=='owner_only'||native.recurringEnabled!==false))
    throw new Error('v143_native_stage_source_pair_invalid');
};
const stageControl=createNativeStageControl();
const ownerRefundControl=createNativeOwnerRefundControl();
// The physical inventory intentionally omits some release switches. Use the
// same sealed source-paired effective environment as ordinary public requests;
// this neither changes a physical binding nor supplies financial authority.
const scopedOwnerRefundEnv=async env=>materializeV143ReleaseEnv(materializeV142ReleaseEnv(materializeV1411AdminEnv(
  materializeV141ReleaseEnv(await materializeReleaseEnv(env)))));
const historicalControls=new Set(['/__rebuild/v1.4.1/release','/__rebuild/v1.4.3/release',
  '/__rebuild/v1.4.3/receipt-forward','/__rebuild/v1.4.3/readiness-install']);
export default Object.freeze({...candidate,async fetch(request,env,ctx){
  preflight(env);
  const url=new URL(request.url);
  if(url.pathname.startsWith(PACKAGE_COMMERCE_API_PREFIX))return await handlePackageCommerceRequest(request,await scopedOwnerRefundEnv(env))??new Response('Not found',{status:404});
  if(url.pathname===NATIVE_OWNER_REFUND_PATH)return await ownerRefundControl(request,await scopedOwnerRefundEnv(env))??new Response('Not found',{status:404});
  if(url.pathname===NATIVE_STAGE_CONTROL_PATH)return await stageControl(request,env)??new Response('Not found',{status:404});
  if(historicalControls.has(url.pathname))return new Response('Not found',{status:404});
  const stageFence=v143NativeStageWebhookFence(request);if(stageFence)return stageFence;
  const response=await candidate.fetch(request,env,ctx);
  if(request.method==='GET'&&!url.search&&['/','/health'].includes(url.pathname)&&response.ok&&
      response.headers.get('Content-Type')?.includes('application/json')){
    const body=await response.json(),headers=new Headers(response.headers);
    headers.delete('Content-Length');headers.delete('Content-Encoding');headers.set('Cache-Control','no-store');
    return Response.json({...body,...v143NativeReadinessHealthProjection(env)},{status:response.status,headers});
  }
  return response;
},async scheduled(event,env,ctx){
  preflight(env);
  if(readV143NativeStageConfig())return;
  return candidate.scheduled(event,env,ctx);
}});
