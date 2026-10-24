import {V143_READINESS_INSTALL_PLAN as PLAN} from './readiness-install-plan.mjs';
import {readV143ReleaseConfig} from './release-config.mjs';

export const READINESS_INSTALL_CONFIG_GLOBAL='__RE_PROGRAM_V143_READINESS_INSTALL_CONFIG__';
export const READINESS_INSTALL_FRAME=Object.freeze({parentSourceSha:PLAN.parentSourceSha,parentRevision:38,
  preparedRevision:39,ownerId:8987576334,botId:8562951985,
  mainDatabaseId:'ccb1ed58-0665-46d3-a201-6f1a03e41a80',supportDatabaseId:'892773cb-c305-4e2e-b0a0-fa214a41bae7',
  baselineDdlSha256:PLAN.baselineDdlSha256,preparedDdlSha256:PLAN.preparedDdlSha256});
const fields=['version','candidateSha','stage','backupReceiptSha256',...Object.keys(READINESS_INSTALL_FRAME)];
export function validateReadinessInstallConfig(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||
    fields.some(key=>!Object.hasOwn(value,key))||value.version!=='1.4.3'||!/^[a-f0-9]{40}$/u.test(value.candidateSha??'')||
    value.candidateSha===PLAN.parentSourceSha||!/^[a-f0-9]{64}$/u.test(value.backupReceiptSha256??'')||
    !['prepare','owner_only','recovery'].includes(value.stage)||
    Object.entries(READINESS_INSTALL_FRAME).some(([key,expected])=>value[key]!==expected))
    throw new Error('readiness_install_config_invalid');
  return value;
}
export function readReadinessInstallConfig(value=globalThis[READINESS_INSTALL_CONFIG_GLOBAL]){
  return value===undefined?null:validateReadinessInstallConfig(value);
}
export function assertReadinessInstallMode(config,release=readV143ReleaseConfig()){
  if(!release||release.sourceSha!==config.candidateSha||release.mode!==(config.stage==='prepare'?'disabled':config.stage)||
    release.recurringEnabled!==false||release.paidNotificationsEnabled!==false)throw new Error('readiness_install_flags_not_off');
  return true;
}
export function readinessInstallWebhookFence(request,value=globalThis[READINESS_INSTALL_CONFIG_GLOBAL]){
  if(['prepare','recovery'].includes(readReadinessInstallConfig(value)?.stage)&&request.method==='POST'&&new URL(request.url).pathname==='/webhook')
    return new Response('Installation in progress',{status:503,headers:{'Retry-After':'5','Cache-Control':'no-store'}});
  return null;
}
