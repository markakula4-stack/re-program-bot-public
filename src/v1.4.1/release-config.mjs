// Versioned server configuration is compiled into the release bundle. It adds
// no physical binding and never supplies an actor, role, tariff or permission.
export const V141_RELEASE_CONFIG_GLOBAL='__RE_PROGRAM_V141_RELEASE_CONFIG__';
export const V141_RELEASE_CONFIG_FIELDS=Object.freeze(['V141_RELEASE_MODE','V141_SOURCE_SHA',
  'V141_AUTHORIZATION_ENABLED','V141_LEGACY_COMPATIBILITY_ENABLED']);
const modes=Object.freeze({default_off:['false','false'],owner_only:['true','true'],enabled:['true','true'],recovery:['false','false']});
const fail=()=>{throw new Error('v141_release_compiled_config_invalid');};
export function validateCompiledV141ReleaseConfig(config) {
  if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).length!==4||
    V141_RELEASE_CONFIG_FIELDS.some(field=>!Object.hasOwn(config,field)||typeof config[field]!=='string')||
    Object.keys(config).some(field=>!V141_RELEASE_CONFIG_FIELDS.includes(field))||
    !Object.hasOwn(modes,config.V141_RELEASE_MODE)||!/^[a-f0-9]{40}$/u.test(config.V141_SOURCE_SHA)||
    config.V141_AUTHORIZATION_ENABLED!==modes[config.V141_RELEASE_MODE][0]||
    config.V141_LEGACY_COMPATIBILITY_ENABLED!==modes[config.V141_RELEASE_MODE][1])fail();
  return config;
}
export function readV141ReleaseConfig(config=globalThis[V141_RELEASE_CONFIG_GLOBAL]) {
  return config===undefined?null:validateCompiledV141ReleaseConfig(config);
}
export function materializeV141ReleaseEnv(env,config=globalThis[V141_RELEASE_CONFIG_GLOBAL]) {
  const compiled=readV141ReleaseConfig(config);
  return {...env,...(compiled??{V141_RELEASE_MODE:'default_off',V141_SOURCE_SHA:undefined,
    V141_AUTHORIZATION_ENABLED:'false',V141_LEGACY_COMPATIBILITY_ENABLED:'false'}),
    ...(compiled?.V141_RELEASE_MODE==='recovery'?{FEATURE_RE_AI_SHELL:'false',AI_PARTNER_ENABLED:'false',
      AI_PARTNER_OWNER_GENERATION_ENABLED:'false',AI_PARTNER_EXTERNAL_PROVIDER_ENABLED:'false'}:{})};
}
export function releaseHealthProjection(config=globalThis[V141_RELEASE_CONFIG_GLOBAL]) {
  const compiled=readV141ReleaseConfig(config),mode=compiled?.V141_RELEASE_MODE??'default_off';
  return Object.freeze({version:'1.4.1',sourceSha:compiled?.V141_SOURCE_SHA??null,releaseMode:mode,
    compatibilityBase:'1.4.0',acceptanceStatus:mode==='enabled'?'accepted':mode==='owner_only'?'pending':'disabled'});
}
