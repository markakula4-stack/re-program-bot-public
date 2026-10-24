import {RELEASE_CONFIG_GLOBAL,validateCompiledReleaseConfig} from '../v1.4.0-rebuild/release-config.mjs';
import {readV141ReleaseConfig,V141_RELEASE_CONFIG_GLOBAL} from '../v1.4.1/release-config.mjs';
import {readV1411AdminConfig,V1411_ADMIN_CONFIG_GLOBAL} from '../v1.4.1/admin-release-config.mjs';
import {readV142ReleaseConfig,V142_RELEASE_CONFIG_GLOBAL} from '../v1.4.2/release-config.mjs';
import {canonicalCabinetOwnerId} from '../v1.4.0-rebuild/cabinet-participants.mjs';
import {readV143PerformanceConfig,assertV143PerformanceSourcePair,V143_PERFORMANCE_CONFIG_GLOBAL,
  V143_PERFORMANCE_FRAME} from './performance-config.mjs';
import {readV143NativeReadinessConfig,isV143NativeReadinessEnvelope,
  materializeV143NativeReadinessEnv,assertV143NativeReadinessCompiledDescriptors} from './native-readiness-config.mjs';

// Identity is compiled. Existing physical rollout switches remain independent;
// this layer cannot enable billing or messages merely by upgrading the code.
export const V143_RELEASE_CONFIG_GLOBAL='__RE_PROGRAM_V143_RELEASE_CONFIG__';
export const V143_RELEASE_CONFIG_FIELDS=Object.freeze(['version','sourceSha','mode','recurringEnabled','paidNotificationsEnabled']);
const fail=()=>{throw new Error('v143_release_compiled_config_invalid');};
export function validateCompiledV143ReleaseConfig(config) {
  if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).length!==V143_RELEASE_CONFIG_FIELDS.length||
    V143_RELEASE_CONFIG_FIELDS.some(field=>!Object.hasOwn(config,field))||
    Object.keys(config).some(field=>!V143_RELEASE_CONFIG_FIELDS.includes(field))||
    config.version!=='1.4.3'||typeof config.sourceSha!=='string'||!/^[a-f0-9]{40}$/u.test(config.sourceSha)||
    !['owner_only','recovery','disabled'].includes(config.mode)||
    typeof config.recurringEnabled!=='boolean'||typeof config.paidNotificationsEnabled!=='boolean'||
    (config.mode!=='owner_only'&&(config.recurringEnabled||config.paidNotificationsEnabled)))fail();
  return config;
}
export function readV143ReleaseConfig(config) {
  const native=assertV143NativeReadinessCompiledDescriptors();
  if(native&&config!==undefined&&config!==Object.getOwnPropertyDescriptor(globalThis,V143_RELEASE_CONFIG_GLOBAL)?.value)fail();
  if(config===undefined)config=globalThis[V143_RELEASE_CONFIG_GLOBAL];
  return config===undefined?null:validateCompiledV143ReleaseConfig(config);
}
// Financial observations retain their accounting/retry path when a sealed
// source-only performance successor uses the exact existing closed39 lease.
// This selects no payer or payment effect and cannot open a purchase switch.
export function isV143FinancialIngressSourcePaired(env) {
  try {
    const release=readV143ReleaseConfig();
    if(!['owner_only','recovery'].includes(release?.mode)||env?.V141_SOURCE_SHA!==release.sourceSha||
      env.V141_RELEASE_MODE!=='owner_only'||env.V141_AUTHORIZATION_ENABLED!=='true'||
      env.V141_LEGACY_COMPATIBILITY_ENABLED!=='true')return false;
    if(readV143NativeReadinessConfig())return isV143NativeReadinessEnvelope(env);
    const descriptor=Object.getOwnPropertyDescriptor(globalThis,V143_PERFORMANCE_CONFIG_GLOBAL);
    if(descriptor===undefined)return env.REBUILD_V140_RC_SHA===release.sourceSha;
    const fields=['version','sourceSha',...Object.keys(V143_PERFORMANCE_FRAME)],value=descriptor.value;
    // Check data descriptors before the capsule reader: even a frozen getter
    // is executable state, and must never substitute a compiled source epoch.
    if(!Object.hasOwn(descriptor,'value')||descriptor.writable!==false||descriptor.configurable!==false||
      !value||typeof value!=='object'||!Object.isFrozen(value)||Reflect.ownKeys(value).length!==fields.length||
      fields.some(field=>!Object.hasOwn(Object.getOwnPropertyDescriptor(value,field)??{},'value'))||
      typeof value.sourceSha!=='string')return false;
    const performance=readV143PerformanceConfig(),rebuild=validateCompiledReleaseConfig(globalThis[RELEASE_CONFIG_GLOBAL]);
    if(canonicalCabinetOwnerId(env)!==performance.ownerId||typeof env.BOT_TOKEN!=='string'||
      env.BOT_TOKEN.split(':')[0]!==String(performance.botId))return false;
    return assertV143PerformanceSourcePair(performance,{env,rebuild,release})===env.REBUILD_V140_RC_SHA;
  }catch{return false;}
}
export function materializeV143ReleaseEnv(env,config,legacyConfig,adminConfig,productConfig,rebuildConfig) {
  if(assertV143NativeReadinessCompiledDescriptors()&&arguments.length>1)fail();
  if(config===undefined)config=globalThis[V143_RELEASE_CONFIG_GLOBAL];
  if(legacyConfig===undefined)legacyConfig=globalThis[V141_RELEASE_CONFIG_GLOBAL];
  if(adminConfig===undefined)adminConfig=globalThis[V1411_ADMIN_CONFIG_GLOBAL];
  if(productConfig===undefined)productConfig=globalThis[V142_RELEASE_CONFIG_GLOBAL];
  if(rebuildConfig===undefined)rebuildConfig=globalThis[RELEASE_CONFIG_GLOBAL];
  const compiled=readV143ReleaseConfig(config),legacy=readV141ReleaseConfig(legacyConfig),
    admin=readV1411AdminConfig(adminConfig),product=readV142ReleaseConfig(productConfig),
    rebuild=rebuildConfig===undefined?null:validateCompiledReleaseConfig(rebuildConfig);
  const performance=readV143PerformanceConfig(),leaseSource=performance?
    assertV143PerformanceSourcePair(performance,{env,rebuild,release:compiled}):compiled?.sourceSha;
  const paired=Boolean(compiled)&&env.REBUILD_V140_RC_SHA===leaseSource&&
    (rebuild===null||rebuild.REBUILD_V140_RC_SHA===leaseSource)&&legacy?.V141_RELEASE_MODE==='owner_only'&&
    legacy.V141_SOURCE_SHA===compiled.sourceSha&&legacy.V141_AUTHORIZATION_ENABLED==='true'&&
    legacy.V141_LEGACY_COMPATIBILITY_ENABLED==='true'&&admin?.mode==='owner_only'&&
    admin.sourceSha===compiled.sourceSha&&admin.supportCandidateSha===compiled.sourceSha&&
    product?.mode==='owner_only'&&product.sourceSha===compiled.sourceSha&&product.dragonEmojiEnabled===true&&
    env.V141_RELEASE_MODE==='owner_only'&&env.V141_SOURCE_SHA===compiled.sourceSha&&
    env.V141_AUTHORIZATION_ENABLED==='true'&&env.V141_LEGACY_COMPATIBILITY_ENABLED==='true'&&
    env.V141_ADMIN_MINI_APP_ENABLED==='true'&&env.V141_ADMIN_SUPPORT_CANDIDATE_SHA===compiled.sourceSha&&
    env.V141_ADMIN_PRODUCT_VERSION==='1.4.1.1'&&env.V142_DRAGON_EMOJI_ENABLED==='true';
  // Recovery retains the genuine143 financial reader/writer and trusted141
  // authority; closing that readiness would lose already-live receipts.
  if(compiled?.mode==='recovery'&&!paired)throw new Error('v143_recovery_source_pair_unavailable');
  const ready=compiled?.mode==='owner_only'&&paired;
  const effective={...env,...(!ready?{STARS_PAYMENTS_ENABLED:'false',STARS_REFUNDS_ENABLED:'false',
      REBUILD_V140_WRITES_ENABLED:'false',V142_DRAGON_EMOJI_ENABLED:'false'}:{}),STARS_RECURRING_ENABLED:ready&&compiled.recurringEnabled&&env.STARS_RECURRING_ENABLED==='true'?'true':'false',
    STARS_PAID_NOTIFICATIONS_ENABLED:ready&&compiled.paidNotificationsEnabled&&env.STARS_PAID_NOTIFICATIONS_ENABLED==='true'?'true':'false'};
  // Native recipes derive their narrow effective switches from the original
  // physical data. Ordinary product readiness must not silently consume or
  // manufacture either independent checkout switch.
  return readV143NativeReadinessConfig()?materializeV143NativeReadinessEnv(env):effective;
}
export function v143ReleaseHealthProjection(config) {
  const compiled=readV143ReleaseConfig(config),mode=compiled?.mode??'disabled';
  return Object.freeze({version:'1.4.3',sourceSha:compiled?.sourceSha??null,releaseMode:mode,
    compatibilityBase:'1.4.1',administratorProduct:'1.4.1.1',acceptanceStatus:mode==='owner_only'?'pending':'disabled'});
}
