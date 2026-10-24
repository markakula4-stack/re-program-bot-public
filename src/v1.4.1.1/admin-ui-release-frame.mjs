// Corrected owner-only menu and UI replacement of the already prepared remote.
// Historical stage4 and32→33 controller frames remain immutable.
export const ADMIN_UI_RELEASE_FRAME=Object.freeze({
  repository:'markakula4-stack/re-program-bot',
  branch:'codex/v1.4.1.1-admin-miniapp-20261002',
  ownerId:8987576334,
  main:Object.freeze({worker:'re-program-bot',databaseId:'ccb1ed58-0665-46d3-a201-6f1a03e41a80',
    origin:'https://re-program-bot.markakula4.workers.dev',sourceSha:'4ca462abd4b38a425f2bbfdc73e25f20f46802b0',
    versionId:'a1558097-7f85-42ce-b48f-68c55998be6b',deploymentId:'9241d921-2fa3-4fc0-80b6-f1dee7b952e6',
    parentRevision:33,releaseRevision:34,healthVersion:'1.4.1.1',
    schemaSha256:'73adf30ab1fbf46521d54df388422ceac174dc15a266a8b52299555cfb038132'}),
  support:Object.freeze({worker:'re-program-support',databaseId:'892773cb-c305-4e2e-b0a0-fa214a41bae7',
    origin:'https://re-program-support.markakula4.workers.dev',sourceSha:'4ca462abd4b38a425f2bbfdc73e25f20f46802b0',
    versionId:'561908c4-19ca-4f03-9b12-15651e7a412f',deploymentId:'d2258154-66e9-4c24-9400-48964d226a8e',
    moduleSetSha256:'c383a21aa54afe1f0a09c8fe72f57cc6ebc3db852919aaf8fba575699e41ff62',healthVersion:'0.2.1',
    schemaSha256:'7f1b3c6747c573474b8e87800a199ae1bc4b413899e44c719b3f701abc451253',
    rawSchemaSha256:'eba0744f6a751e2d9567b3fb18f916070d0b74800da6189b2e123842a0e31f15'}),
  serviceBinding:Object.freeze({name:'ADMIN_SUPPORT',type:'service',service:'re-program-support'}),
});
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/u.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
export function assertAdminUiReleaseFrameReady() {
  const f=ADMIN_UI_RELEASE_FRAME;
  if(!/^codex\/[a-z0-9./_-]+$/u.test(f.branch)||!sha(f.main.sourceSha)||!uuid(f.main.versionId)||
    !uuid(f.main.deploymentId)||!uuid(f.support.versionId)||!uuid(f.support.deploymentId)||
    !digest(f.support.moduleSetSha256)||!digest(f.main.schemaSha256)||!digest(f.support.schemaSha256)||
    !digest(f.support.rawSchemaSha256)||f.support.sourceSha!==f.main.sourceSha||
    f.main.parentRevision!==33||f.main.releaseRevision!==34||f.ownerId!==8987576334)
    throw new Error('admin_ui_release_literal_frame_not_ready');
  return f;
}
