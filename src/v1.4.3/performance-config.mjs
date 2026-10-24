// One sealed source-only successor of the installed closed39 release. The
// cabinet's revocable lease stays at its existing source/epoch; this cannot
// admit another parent, open a participant window, or enable recurring Stars.
export const V143_PERFORMANCE_CONFIG_GLOBAL='__RE_PROGRAM_V143_PERFORMANCE_CONFIG__';
export const V143_PERFORMANCE_FRAME=Object.freeze({
  parentSourceSha:'82b3650632563788c4c1053e8801adebe7062918',parentRevision:39,
  installedReceiptSha256:'1a2ac8b62b5e09bdee1b4eb6731cdd52e99b9d0c1f1a3252d4a06dd3346a2bb5',
  schemaSha256:'b1e4d7d80f33a7f58cd2ef74c8950d869d8fde1ede69a882ed0f5a4d9614a540',
  ledgerSha256:'a7021a761aae8db54301b7a4142354a9967cddf2eee4a4352085d47cfb551a78',
  ownerId:8987576334,botId:8562951985,recurringEnabled:false,paidNotificationsEnabled:false
});
const fields=['version','sourceSha',...Object.keys(V143_PERFORMANCE_FRAME)];
const fail=()=>{throw new Error('v143_performance_config_invalid');};
export function validateV143PerformanceConfig(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||
    fields.some(key=>!Object.hasOwn(value,key))||value.version!=='1.4.3'||
    !/^[a-f0-9]{40}$/u.test(value.sourceSha??'')||value.sourceSha===V143_PERFORMANCE_FRAME.parentSourceSha||
    Object.entries(V143_PERFORMANCE_FRAME).some(([key,expected])=>value[key]!==expected))fail();
  return value;
}
export function readV143PerformanceConfig(){
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,V143_PERFORMANCE_CONFIG_GLOBAL);
  if(descriptor===undefined)return null;
  if(!Object.hasOwn(descriptor,'value')||descriptor.writable!==false||descriptor.configurable!==false||
    !Object.isFrozen(descriptor.value))fail();
  return validateV143PerformanceConfig(descriptor.value);
}
export function assertV143PerformanceSourcePair(value,{env,rebuild,release}){
  const config=validateV143PerformanceConfig(value),flags=['STORAGE','WRITES','OFFER_ACTIONS','EFFECTS','RETENTION','TELEGRAM','BETA','RESULT_ACTIONS'];
  if(!rebuild||!release||release.sourceSha!==config.sourceSha||release.mode!=='owner_only'||
    release.recurringEnabled!==false||release.paidNotificationsEnabled!==false||
    rebuild.REBUILD_V140_RC_SHA!==config.parentSourceSha||env.REBUILD_V140_RC_SHA!==config.parentSourceSha||
    rebuild.REBUILD_V140_RELEASE_REVISION!==String(config.parentRevision)||env.REBUILD_V140_RELEASE_REVISION!==String(config.parentRevision)||
    rebuild.REBUILD_V140_BOT_ID!==String(config.botId)||env.REBUILD_V140_BOT_ID!==String(config.botId)||
    rebuild.REBUILD_V140_OWNER_WINDOW!=='false'||env.REBUILD_V140_OWNER_WINDOW!=='false'||
    rebuild.REBUILD_V140_OWNER_TELEGRAM_ID!=='0'||env.REBUILD_V140_OWNER_TELEGRAM_ID!=='0'||
    rebuild.REBUILD_V140_RELEASE_LEASE_REQUIRED!=='true'||env.REBUILD_V140_RELEASE_LEASE_REQUIRED!=='true'||
    rebuild.REBUILD_V140_ADMIN_ACCESS_ENABLED!=='true'||env.REBUILD_V140_ADMIN_ACCESS_ENABLED!=='true'||
    rebuild.REBUILD_V140_ADMIN_BETA_GRANTS_ENABLED!=='true'||env.REBUILD_V140_ADMIN_BETA_GRANTS_ENABLED!=='true'||
    flags.some(flag=>rebuild['REBUILD_V140_'+flag+'_ENABLED']!==(['STORAGE','WRITES','TELEGRAM'].includes(flag)?'true':'false')||
      env['REBUILD_V140_'+flag+'_ENABLED']!==rebuild['REBUILD_V140_'+flag+'_ENABLED']))fail();
  return config.parentSourceSha;
}
