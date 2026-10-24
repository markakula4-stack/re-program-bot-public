import {readV141ReleaseConfig,V141_RELEASE_CONFIG_GLOBAL} from '../v1.4.1/release-config.mjs';
import {readV1411AdminConfig,V1411_ADMIN_CONFIG_GLOBAL} from '../v1.4.1/admin-release-config.mjs';

// Product identity and the Dragon switch are compiled into the Worker. No
// physical binding, actor, tariff or credential is introduced by this layer.
export const V142_RELEASE_CONFIG_GLOBAL='__RE_PROGRAM_V142_RELEASE_CONFIG__';
export const V142_RELEASE_CONFIG_FIELDS=Object.freeze(['version','sourceSha','mode','dragonEmojiEnabled']);
const fail=()=>{throw new Error('v142_release_compiled_config_invalid');};
export function validateCompiledV142ReleaseConfig(config) {
  if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).length!==V142_RELEASE_CONFIG_FIELDS.length||
    V142_RELEASE_CONFIG_FIELDS.some(field=>!Object.hasOwn(config,field))||
    Object.keys(config).some(field=>!V142_RELEASE_CONFIG_FIELDS.includes(field))||
    config.version!=='1.4.2'||typeof config.sourceSha!=='string'||!/^[a-f0-9]{40}$/u.test(config.sourceSha)||
    !['owner_only','recovery','disabled'].includes(config.mode)||
    typeof config.dragonEmojiEnabled!=='boolean'||config.dragonEmojiEnabled!==(config.mode==='owner_only'))fail();
  return config;
}
export function readV142ReleaseConfig(config=globalThis[V142_RELEASE_CONFIG_GLOBAL]) {
  return config===undefined?null:validateCompiledV142ReleaseConfig(config);
}
export function materializeV142ReleaseEnv(env,config=globalThis[V142_RELEASE_CONFIG_GLOBAL],
  v141Config=globalThis[V141_RELEASE_CONFIG_GLOBAL],adminConfig=globalThis[V1411_ADMIN_CONFIG_GLOBAL]) {
  const compiled=readV142ReleaseConfig(config),legacy=readV141ReleaseConfig(v141Config),admin=readV1411AdminConfig(adminConfig);
  const enabled=compiled?.mode==='owner_only'&&compiled.dragonEmojiEnabled===true&&
    legacy?.V141_RELEASE_MODE==='owner_only'&&legacy.V141_SOURCE_SHA===compiled.sourceSha&&
    legacy.V141_AUTHORIZATION_ENABLED==='true'&&legacy.V141_LEGACY_COMPATIBILITY_ENABLED==='true'&&
    admin?.mode==='owner_only'&&admin.sourceSha===compiled.sourceSha&&admin.supportCandidateSha===compiled.sourceSha&&
    env.V141_RELEASE_MODE==='owner_only'&&env.V141_SOURCE_SHA===compiled.sourceSha&&
    env.V141_AUTHORIZATION_ENABLED==='true'&&env.V141_LEGACY_COMPATIBILITY_ENABLED==='true'&&
    env.V141_ADMIN_MINI_APP_ENABLED==='true'&&env.V141_ADMIN_SUPPORT_CANDIDATE_SHA===compiled.sourceSha&&
    env.V141_ADMIN_PRODUCT_VERSION==='1.4.1.1';
  return {...env,V142_DRAGON_EMOJI_ENABLED:enabled?'true':'false'};
}
export function v142ReleaseHealthProjection(config=globalThis[V142_RELEASE_CONFIG_GLOBAL]) {
  const compiled=readV142ReleaseConfig(config),mode=compiled?.mode??'disabled';
  return Object.freeze({version:'1.4.2',sourceSha:compiled?.sourceSha??null,releaseMode:mode,
    compatibilityBase:'1.4.1',administratorProduct:'1.4.1.1',acceptanceStatus:mode==='owner_only'?'pending':'disabled'});
}
