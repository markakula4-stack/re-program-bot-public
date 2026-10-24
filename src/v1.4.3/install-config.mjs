import {V143_RELEASE_MIGRATIONS as PLAN} from './release-migrations.mjs';
import {readV143ReleaseConfig} from './release-config.mjs';

export const V143_INSTALL_CONFIG_GLOBAL='__RE_PROGRAM_V143_INSTALL_CONFIG__';
export const V143_INSTALL_FRAME=Object.freeze({parentSourceSha:PLAN.acceptedCandidateSha,parentRevision:36,
  preparedRevision:37,ownerId:8987576334,botId:8562951985,mainDatabaseId:'ccb1ed58-0665-46d3-a201-6f1a03e41a80',
  supportDatabaseId:'892773cb-c305-4e2e-b0a0-fa214a41bae7'});
const fields=Object.freeze(['version','candidateSha','parentSourceSha','parentRevision','preparedRevision',
  'ownerId','botId','mainDatabaseId','supportDatabaseId','stage']);
export function validateCompiledV143InstallConfig(config) {
  if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).length!==fields.length||
    fields.some(field=>!Object.hasOwn(config,field))||Object.keys(config).some(field=>!fields.includes(field))||
    config.version!=='1.4.3'||!/^[a-f0-9]{40}$/u.test(config.candidateSha??'')||
    config.candidateSha===PLAN.acceptedCandidateSha||
    !['prepare','owner_only','recovery'].includes(config.stage)||
    Object.entries(V143_INSTALL_FRAME).some(([field,value])=>config[field]!==value))
    throw new Error('v143_install_compiled_config_invalid');
  return config;
}
export function readV143InstallConfig(config=globalThis[V143_INSTALL_CONFIG_GLOBAL]) {
  return config===undefined?null:validateCompiledV143InstallConfig(config);
}
export function assertV143InstallMode(config,releaseConfig=readV143ReleaseConfig()) {
  const expected=config.stage==='prepare'?'disabled':config.stage;
  if(!releaseConfig||releaseConfig.sourceSha!==config.candidateSha||releaseConfig.mode!==expected||
    releaseConfig.recurringEnabled!==false||releaseConfig.paidNotificationsEnabled!==false)
    throw new Error('v143_install_release_mode_unverified');
  return true;
}
// A preparation worker cannot swallow a genuine receipt while its schema and
// release fence are between versions. Telegram retries the untouched update.
export function v143InstallWebhookFence(request,config=globalThis[V143_INSTALL_CONFIG_GLOBAL]) {
  const compiled=readV143InstallConfig(config);
  if(compiled?.stage==='prepare'&&request.method==='POST'&&new URL(request.url).pathname==='/webhook')
    return new Response('Installation in progress',{status:503,headers:{'Retry-After':'5','Cache-Control':'no-store'}});
  return null;
}
