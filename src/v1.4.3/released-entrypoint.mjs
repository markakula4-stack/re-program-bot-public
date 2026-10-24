import candidate,{DragonPreviewWorkflow,ReferralRewardProtectionWorkflow} from '../v1.4.0-rebuild/worker-entrypoint.mjs';
import {materializeReleaseEnv} from '../v1.4.0-rebuild/release-config.mjs';
import {createV141ReleaseControl} from '../v1.4.1/release-control.mjs';
import {materializeV141ReleaseEnv} from '../v1.4.1/release-config.mjs';
import {installV141StartupReadiness} from '../v1.4.1/startup-readiness.mjs';
import {materializeV1411AdminEnv} from '../v1.4.1/admin-release-config.mjs';
import {materializeV142ReleaseEnv} from '../v1.4.2/release-config.mjs';
import {materializeV143ReleaseEnv,v143ReleaseHealthProjection} from './release-config.mjs';
import {createV143ReleaseControl,V143_RELEASE_CONTROL_PATH} from './release-control.mjs';
import {readV143InstallConfig,v143InstallWebhookFence} from './install-config.mjs';
import {createV143ReceiptForwardControl,V143_RECEIPT_FORWARD_CONTROL_PATH} from './receipt-forward-control.mjs';
import {readV143ReceiptForwardConfig,v143ReceiptForwardWebhookFence} from './receipt-forward-config.mjs';
export {DragonPreviewWorkflow,ReferralRewardProtectionWorkflow};

globalThis.__RE_PROGRAM_PUBLIC_RELEASE_RUNTIME__=Object.freeze({version:'1.4.3',acceptanceRevision:'v143-candidate'});
installV141StartupReadiness();
const control=createV141ReleaseControl();
const installControl=createV143ReleaseControl();
const receiptForwardControl=createV143ReceiptForwardControl();
const scopedEnv=async env=>materializeV143ReleaseEnv(materializeV142ReleaseEnv(materializeV1411AdminEnv(
  materializeV141ReleaseEnv(await materializeReleaseEnv(env)))));
export default Object.freeze({...candidate,async fetch(request,env,ctx) {
  if(new URL(request.url).pathname===V143_RECEIPT_FORWARD_CONTROL_PATH)
    return receiptForwardControl(request,await materializeReleaseEnv(env));
  const receiptFence=v143ReceiptForwardWebhookFence(request);if(receiptFence)return receiptFence;
  if(new URL(request.url).pathname===V143_RELEASE_CONTROL_PATH)
    return installControl(request,await materializeReleaseEnv(env));
  const installationFence=v143InstallWebhookFence(request);if(installationFence)return installationFence;
  const scoped=await scopedEnv(env),controlled=await control(request,scoped);if(controlled)return controlled;
  const response=await candidate.fetch(request,scoped,ctx),url=new URL(request.url);
  if(request.method==='GET'&&!url.search&&['/','/health'].includes(url.pathname)&&response.ok&&
    response.headers.get('Content-Type')?.includes('application/json')) {
    const body=await response.json(),headers=new Headers(response.headers);
    headers.delete('Content-Length');headers.delete('Content-Encoding');headers.set('Cache-Control','no-store');
    return Response.json({...body,...v143ReleaseHealthProjection()},{status:response.status,headers});
  }
  return response;
},async scheduled(event,env,ctx) {
  if(readV143InstallConfig()?.stage==='prepare'||readV143ReceiptForwardConfig()?.stage==='prepare')return;
  return candidate.scheduled(event,await scopedEnv(env),ctx);
}});
