// A replacement of the already prepared owner-only administrator product.
// Original stage4 and support0004 frames remain immutable in their own module.
export const ADMIN_REMOTE_RELEASE_FRAME=Object.freeze({
  repository:'markakula4-stack/re-program-bot',
  branch:'codex/v1.4.1.1-admin-miniapp-20261002',
  ownerId:8987576334,
  main:Object.freeze({worker:'re-program-bot',databaseId:'ccb1ed58-0665-46d3-a201-6f1a03e41a80',
    origin:'https://re-program-bot.markakula4.workers.dev',sourceSha:'e6d5e339a3774824010ba83158bc28f20eaa7d17',
    versionId:'d0458a41-ef80-467f-900b-9bf205830d12',deploymentId:'033c92ad-5fdd-444e-9b31-6c87e823d99d',
    parentRevision:32,releaseRevision:33,healthVersion:'1.4.1.1',
    schemaSha256:'73adf30ab1fbf46521d54df388422ceac174dc15a266a8b52299555cfb038132'}),
  support:Object.freeze({worker:'re-program-support',databaseId:'892773cb-c305-4e2e-b0a0-fa214a41bae7',
    origin:'https://re-program-support.markakula4.workers.dev',sourceSha:'e6d5e339a3774824010ba83158bc28f20eaa7d17',
    versionId:'ca9a625b-ce89-4ed5-b2c8-93d7a8c1d254',deploymentId:'aeefcd37-d6d9-41b8-b8e6-57766a84da02',
    moduleSetSha256:'3d7588f611139fd15f020c81677b0d285e2f92d7c905ca8deb9c1f07209cda2f',healthVersion:'0.2.1',
    schemaSha256:'7f1b3c6747c573474b8e87800a199ae1bc4b413899e44c719b3f701abc451253',
    rawSchemaSha256:'eba0744f6a751e2d9567b3fb18f916070d0b74800da6189b2e123842a0e31f15'}),
  serviceBinding:Object.freeze({name:'ADMIN_SUPPORT',type:'service',service:'re-program-support'}),
});
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/u.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
export function assertAdminRemoteReleaseFrameReady() {
  const f=ADMIN_REMOTE_RELEASE_FRAME;
  if(!/^codex\/[a-z0-9./_-]+$/u.test(f.branch)||!sha(f.main.sourceSha)||!uuid(f.main.versionId)||
    !uuid(f.main.deploymentId)||!uuid(f.support.versionId)||!uuid(f.support.deploymentId)||
    !digest(f.support.moduleSetSha256)||!digest(f.main.schemaSha256)||!digest(f.support.schemaSha256)||
    !digest(f.support.rawSchemaSha256)||f.support.sourceSha!==f.main.sourceSha||
    f.main.parentRevision!==32||f.main.releaseRevision!==33||f.ownerId!==8987576334)
    throw new Error('admin_remote_release_literal_frame_not_ready');
  return f;
}
