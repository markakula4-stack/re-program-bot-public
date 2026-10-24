import {readV143ReleaseConfig} from './release-config.mjs';
export const V143_RECEIPT_FORWARD_CONFIG_GLOBAL='__RE_PROGRAM_V143_RECEIPT_FORWARD_CONFIG__';
export const V143_RECEIPT_FORWARD_FRAME=Object.freeze({parentSourceSha:'0347fe4de0840179b165e82855482099e96c4f24',
 parentRevision:37,preparedRevision:38,ownerId:8987576334,botId:8562951985,
 mainDatabaseId:'ccb1ed58-0665-46d3-a201-6f1a03e41a80',supportDatabaseId:'892773cb-c305-4e2e-b0a0-fa214a41bae7',
 schemaSha256:'7d535021e242f924ce894aaa3cabe25e308b7bba487b4dfc6c240a54fe5fcc77'});
const fields=['version','candidateSha','stage',...Object.keys(V143_RECEIPT_FORWARD_FRAME)];
export function validateV143ReceiptForwardConfig(config){
 if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).length!==fields.length||
  fields.some(key=>!Object.hasOwn(config,key))||Object.keys(config).some(key=>!fields.includes(key))||
  config.version!=='1.4.3'||!/^[a-f0-9]{40}$/u.test(config.candidateSha??'')||
  config.candidateSha===V143_RECEIPT_FORWARD_FRAME.parentSourceSha||!['prepare','owner_only','recovery'].includes(config.stage)||
  Object.entries(V143_RECEIPT_FORWARD_FRAME).some(([k,v])=>config[k]!==v))throw new Error('v143_receipt_forward_config_invalid');
 return config;
}
export function readV143ReceiptForwardConfig(config=globalThis[V143_RECEIPT_FORWARD_CONFIG_GLOBAL]){
 return config===undefined?null:validateV143ReceiptForwardConfig(config);
}
export function assertV143ReceiptForwardMode(config,releaseConfig=readV143ReleaseConfig()){
 if(!releaseConfig||releaseConfig.sourceSha!==config.candidateSha||releaseConfig.mode!==(config.stage==='prepare'?'disabled':config.stage)||
  releaseConfig.recurringEnabled!==false||releaseConfig.paidNotificationsEnabled!==false)throw new Error('v143_receipt_forward_release_mode_invalid');
 return true;
}
export function v143ReceiptForwardWebhookFence(request,config=globalThis[V143_RECEIPT_FORWARD_CONFIG_GLOBAL]){
 if(readV143ReceiptForwardConfig(config)?.stage==='prepare'&&request.method==='POST'&&new URL(request.url).pathname==='/webhook')
  return new Response('Installation in progress',{status:503,headers:{'Retry-After':'5','Cache-Control':'no-store'}});
 return null;
}
