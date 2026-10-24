// Server-only product configuration. The browser receives no bridge key and
// this configuration grants no actor, role or target authority.
export const V1411_ADMIN_CONFIG_GLOBAL='__RE_PROGRAM_V1411_ADMIN_CONFIG__';
const fields=['version','sourceSha','mode','supportBridgeKey','supportCandidateSha'];
const invalid=()=>{throw new Error('v1411_admin_compiled_config_invalid');};
export function validateCompiledV1411AdminConfig(config) {
  if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).length!==fields.length||
    fields.some(key=>!Object.hasOwn(config,key))||Object.keys(config).some(key=>!fields.includes(key))||
    config.version!=='1.4.1.1'||!/^[a-f0-9]{40}$/u.test(config.sourceSha??'')||
    !['owner_only','recovery','disabled'].includes(config.mode)||
    config.supportCandidateSha!==config.sourceSha||
    !(config.mode==='owner_only'?/^[a-f0-9]{64}$/u.test(config.supportBridgeKey??''):config.supportBridgeKey===''))invalid();
  return config;
}
export function readV1411AdminConfig(config=globalThis[V1411_ADMIN_CONFIG_GLOBAL]) {
  return config===undefined?null:validateCompiledV1411AdminConfig(config);
}
export function materializeV1411AdminEnv(env,config=globalThis[V1411_ADMIN_CONFIG_GLOBAL]) {
  const compiled=readV1411AdminConfig(config);
  const enabled=compiled?.mode==='owner_only'&&env.V141_RELEASE_MODE==='owner_only'&&
    env.V141_SOURCE_SHA===compiled.sourceSha&&env.V141_AUTHORIZATION_ENABLED==='true';
  return {...env,V141_ADMIN_MINI_APP_ENABLED:enabled?'true':'false',
    V141_ADMIN_SUPPORT_BRIDGE_KEY:enabled?compiled.supportBridgeKey:undefined,
    V141_ADMIN_SUPPORT_CANDIDATE_SHA:enabled?compiled.supportCandidateSha:undefined,
    V141_ADMIN_PRODUCT_VERSION:compiled?.version??null};
}
export function adminReleaseHealthProjection(config=globalThis[V1411_ADMIN_CONFIG_GLOBAL]) {
  const compiled=readV1411AdminConfig(config);
  return compiled?Object.freeze({version:compiled.version,administratorProduct:'1.4.1.1'}):Object.freeze({});
}
