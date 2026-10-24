import candidate,{DragonPreviewWorkflow,ReferralRewardProtectionWorkflow} from './release-entrypoint.mjs';
export {DragonPreviewWorkflow,ReferralRewardProtectionWorkflow};
// Fixed once per isolate, only in the bundle deployed after real owner PASS.
globalThis.__RE_PROGRAM_PUBLIC_RELEASE_RUNTIME__=Object.freeze({version:'1.4.0',acceptanceRevision:'p12-rebuild-accepted'});
export default Object.freeze({...candidate,async fetch(request,env,ctx){
  const response=await candidate.fetch(request,env,ctx),url=new URL(request.url);
  if(request.method==='GET'&&!url.search&&['/','/health'].includes(url.pathname)&&response.ok&&response.headers.get('Content-Type')?.includes('application/json')){
    const body=await response.json(),headers=new Headers(response.headers);headers.delete('Content-Length');headers.delete('Content-Encoding');headers.set('Cache-Control','no-store');
    return Response.json({...body,version:'1.4.0',acceptanceRevision:'p12-rebuild-accepted',compatibilityBase:'1.3.9'},{status:response.status,headers});
  }return response;
}});
