import {validateCompiledReleaseConfig} from '../v1.4.0-rebuild/release-config.mjs';
import {validateCompiledV141ReleaseConfig} from '../v1.4.1/release-config.mjs';
import {validateCompiledV1411AdminConfig} from '../v1.4.1/admin-release-config.mjs';
import {validateCompiledV142ReleaseConfig} from '../v1.4.2/release-config.mjs';

// One permanent owner cabinet epoch has two OFF recipes and one separately
// activated owner checkout recipe. A compiled recipe never proves D1 or
// supplies financial authority; physical payment switches remain independent.
export const V143_NATIVE_READINESS_CONFIG_GLOBAL='__RE_PROGRAM_V143_NATIVE_READINESS_CONFIG__';
export const V143_NATIVE_READINESS_FRAME=Object.freeze({
  parentLeaseSourceSha:'82b3650632563788c4c1053e8801adebe7062918',
  parentRevision:39,preparedRevision:40,ownerId:8987576334,botId:8562951985,
  schemaSha256:'b1e4d7d80f33a7f58cd2ef74c8950d869d8fde1ede69a882ed0f5a4d9614a540',
  ledgerSha256:'a7021a761aae8db54301b7a4142354a9967cddf2eee4a4352085d47cfb551a78',
  recurringEnabled:false,paidNotificationsEnabled:false
});
export const V143_NATIVE_OWNER_CHECKOUT_FRAME=Object.freeze({
  ownerId:8987576334,botId:8562951985,planCode:'professional',currency:'XTR',amountStars:249,
  periodSeconds:2592000,priceVersion:1,termsRevision:'2026-10-03.stars-recurring-v1'
});
// The owner rollout has two canonical monthly offers. Matching a trusted
// server quote only selects an offer; it never supplies payer authority.
export const V143_NATIVE_OWNER_CHECKOUT_QUOTES=Object.freeze([
  V143_NATIVE_OWNER_CHECKOUT_FRAME,
  Object.freeze({...V143_NATIVE_OWNER_CHECKOUT_FRAME,planCode:'dragon',amountStars:499})
]);
export function selectV143NativeOwnerCheckoutQuote(quote){
  if(!quote||quote.billingMode!=='recurring'||quote.publicationState!=='approved')return null;
  return V143_NATIVE_OWNER_CHECKOUT_QUOTES.find(frame=>quote.planCode===frame.planCode&&
    quote.currency===frame.currency&&quote.amountStars===frame.amountStars&&quote.accessSeconds===frame.periodSeconds&&
    quote.priceVersion===frame.priceVersion&&quote.termsRevision===frame.termsRevision)??null;
}
const ownerRecipe=config=>config.mode==='owner_acceptance';
const releaseMode=config=>ownerRecipe(config)?'owner_only':config.mode;
const fields=Object.freeze(['version','sourceSha','mode',...Object.keys(V143_NATIVE_READINESS_FRAME)]);
const globals=Object.freeze({
  rebuild:'__RE_PROGRAM_V140_RELEASE_CONFIG__',legacy:'__RE_PROGRAM_V141_RELEASE_CONFIG__',
  admin:'__RE_PROGRAM_V1411_ADMIN_CONFIG__',product:'__RE_PROGRAM_V142_RELEASE_CONFIG__',
  release:'__RE_PROGRAM_V143_RELEASE_CONFIG__',performance:'__RE_PROGRAM_V143_PERFORMANCE_CONFIG__'
});
const conflictingGlobals=Object.freeze([globals.performance,'__RE_PROGRAM_V143_INSTALL_CONFIG__',
  '__RE_PROGRAM_V143_READINESS_INSTALL_CONFIG__','__RE_PROGRAM_V143_RECEIPT_FORWARD_CONFIG__']);
const featureFlags=Object.freeze(['STORAGE','WRITES','OFFER_ACTIONS','EFFECTS','RETENTION','TELEGRAM','BETA','RESULT_ACTIONS']);
const off=Object.freeze({STARS_PAYMENTS_ENABLED:'false',STARS_REFUNDS_ENABLED:'false',
  STARS_RECURRING_ENABLED:'false',STARS_PAID_NOTIFICATIONS_ENABLED:'false',REBUILD_V140_WRITES_ENABLED:'false'});
const fail=()=>{throw new Error('v143_native_readiness_config_invalid');};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  Object.getPrototypeOf(value)===Object.prototype;
function dataObject(value,expected,{frozen=true}={}){
  if(!plain(value)||(frozen&&!Object.isFrozen(value)))fail();
  const keys=Reflect.ownKeys(value),descriptors=Object.getOwnPropertyDescriptors(value);
  if(keys.some(key=>typeof key!=='string')||expected&&
    (keys.length!==expected.length||keys.some(key=>!expected.includes(key))))fail();
  for(const key of keys)if(!Object.hasOwn(descriptors[key],'value')||
    expected&&descriptors[key].enumerable!==true)fail();
  return value;
}
function immutableGlobal(name,{optional=false}={}){
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,name);
  if(descriptor===undefined){if(optional)return null;fail();}
  if(!Object.hasOwn(descriptor,'value')||descriptor.writable!==false||descriptor.configurable!==false)fail();
  return dataObject(descriptor.value);
}
const noHistoricalCapsules=()=>{if(conflictingGlobals.some(name=>Object.getOwnPropertyDescriptor(globalThis,name)!==undefined))fail();};
export function validateV143NativeReadinessConfig(value){
  dataObject(value,fields);
  if(value.version!=='1.4.3'||typeof value.sourceSha!=='string'||!/^[a-f0-9]{40}$/u.test(value.sourceSha)||
    value.sourceSha===V143_NATIVE_READINESS_FRAME.parentLeaseSourceSha||!['owner_only','recovery','owner_acceptance'].includes(value.mode)||
    Object.entries(V143_NATIVE_READINESS_FRAME).some(([key,expected])=>value[key]!==
      (key==='recurringEnabled'?ownerRecipe(value):expected)))fail();
  return value;
}
export function readV143NativeReadinessConfig(...args){
  if(args.length)fail();
  const value=immutableGlobal(V143_NATIVE_READINESS_CONFIG_GLOBAL,{optional:true});
  if(value===null)return null;
  noHistoricalCapsules();
  return validateV143NativeReadinessConfig(value);
}
const linkedFields=Object.freeze({
  rebuild:['MINI_APP_ORIGIN','REBUILD_V140_OWNER_WINDOW','REBUILD_V140_OWNER_TELEGRAM_ID',
    'REBUILD_V140_ADMIN_ACCESS_ENABLED','REBUILD_V140_ADMIN_BETA_GRANTS_ENABLED','REBUILD_V140_RC_SHA',
    'REBUILD_V140_RELEASE_LEASE_REQUIRED','REBUILD_V140_RELEASE_REVISION','REBUILD_V140_BOT_ID',
    'REBUILD_V140_CONTROL_ISSUED_AT','REBUILD_V140_CONTROL_EXPIRES_AT','REBUILD_V140_CONTROL_SECRET_SHA256',
    ...featureFlags.map(flag=>'REBUILD_V140_'+flag+'_ENABLED')],
  legacy:['V141_RELEASE_MODE','V141_SOURCE_SHA','V141_AUTHORIZATION_ENABLED','V141_LEGACY_COMPATIBILITY_ENABLED'],
  admin:['version','sourceSha','mode','supportBridgeKey','supportCandidateSha'],
  product:['version','sourceSha','mode','dragonEmojiEnabled'],
  release:['version','sourceSha','mode','recurringEnabled','paidNotificationsEnabled']
});
function linkedConfig(kind,value){
  dataObject(value,linkedFields[kind]);
  if(Object.values(value).some(field=>!['string','boolean'].includes(typeof field)))fail();
  try{
    if(kind==='rebuild')validateCompiledReleaseConfig(value);
    if(kind==='legacy')validateCompiledV141ReleaseConfig(value);
    if(kind==='admin')validateCompiledV1411AdminConfig(value);
    if(kind==='product')validateCompiledV142ReleaseConfig(value);
  }catch{fail();}
  return value;
}
function environment(env){
  dataObject(env,null,{frozen:false});
  for(const key of ['STARS_PAYMENTS_ENABLED','STARS_REFUNDS_ENABLED','STARS_RECURRING_ENABLED',
    'STARS_PAID_NOTIFICATIONS_ENABLED','STARS_INVOICE_SECRET','STARS_BILLING_MODE','STARS_PRICE_VERSION',
    'STARS_TERMS_REVISION','STARS_RECURRING_PRICE_VERSION','STARS_RECURRING_TERMS_REVISION',
    'STARS_ROLLOUT_MODE','STARS_ROLLOUT_ALLOWLIST','STARS_ROLLOUT_SECRET','STARS_ROLLOUT_PERCENT'])
    if(env[key]!==undefined&&!['string','number','boolean'].includes(typeof env[key]))fail();
  return env;
}
// Validate raw physical env before a release layer spreads or reads it. This
// checks descriptors only; missing identity fields and binding values are not
// interpreted here, and a valid data object carries no effect authority.
export function assertV143NativeReadinessRuntimeData(env,...args){
  if(args.length)fail();
  environment(env);return true;
}
function ownerMatches(env){
  if(!['string','number'].includes(typeof env.ADMIN_ID)||String(env.ADMIN_ID)!==String(V143_NATIVE_READINESS_FRAME.ownerId))return false;
  return env.OWNER_TELEGRAM_ID===undefined||
    ['string','number'].includes(typeof env.OWNER_TELEGRAM_ID)&&String(env.OWNER_TELEGRAM_ID)===String(V143_NATIVE_READINESS_FRAME.ownerId);
}
function assertCompiledPair(config,{rebuild,release,legacy,admin,product}){
  for(const [kind,linked]of Object.entries({rebuild,release,legacy,admin,product}))linkedConfig(kind,linked);
  if(release.version!=='1.4.3'||release.sourceSha!==config.sourceSha||release.mode!==releaseMode(config)||
    release.recurringEnabled!==ownerRecipe(config)||release.paidNotificationsEnabled!==false||
    rebuild.REBUILD_V140_RC_SHA!==config.sourceSha||rebuild.REBUILD_V140_RELEASE_REVISION!=='40'||
    rebuild.REBUILD_V140_OWNER_WINDOW!=='false'||rebuild.REBUILD_V140_OWNER_TELEGRAM_ID!=='0'||
    rebuild.REBUILD_V140_BOT_ID!==String(config.botId)||rebuild.REBUILD_V140_RELEASE_LEASE_REQUIRED!=='true'||
    rebuild.REBUILD_V140_ADMIN_ACCESS_ENABLED!=='true'||rebuild.REBUILD_V140_ADMIN_BETA_GRANTS_ENABLED!=='false'||
    rebuild.REBUILD_V140_CONTROL_ISSUED_AT!=='1000000000'||rebuild.REBUILD_V140_CONTROL_EXPIRES_AT!=='1000000001'||
    featureFlags.some(flag=>rebuild['REBUILD_V140_'+flag+'_ENABLED']!==(['STORAGE','WRITES','TELEGRAM'].includes(flag)?'true':'false'))||
    legacy.V141_RELEASE_MODE!=='owner_only'||legacy.V141_SOURCE_SHA!==config.sourceSha||
    legacy.V141_AUTHORIZATION_ENABLED!=='true'||legacy.V141_LEGACY_COMPATIBILITY_ENABLED!=='true'||
    admin.mode!=='owner_only'||admin.sourceSha!==config.sourceSha||admin.supportCandidateSha!==config.sourceSha||
    product.mode!=='owner_only'||product.sourceSha!==config.sourceSha||product.dragonEmojiEnabled!==true)fail();
}
function compiledGlobals(){
  return Object.fromEntries(['rebuild','release','legacy','admin','product'].map(kind=>[kind,immutableGlobal(globals[kind])]));
}
// Must run before ordinary release readers/default arguments can touch any
// linked global. This preflight proves only compiled data, never D1 or a payer.
export function assertV143NativeReadinessCompiledDescriptors(...args){
  if(args.length)fail();
  const config=readV143NativeReadinessConfig();if(config===null)return false;
  assertCompiledPair(config,compiledGlobals());return true;
}
export function assertV143NativeReadinessSourcePair(value,options){
  const config=validateV143NativeReadinessConfig(value);noHistoricalCapsules();
  dataObject(options,['env','rebuild','release','legacy','admin','product'],{frozen:false});
  const {env,rebuild,release,legacy,admin,product}=options;
  environment(env);
  assertCompiledPair(config,{rebuild,release,legacy,admin,product});
  if(release.version!=='1.4.3'||release.sourceSha!==config.sourceSha||release.mode!==releaseMode(config)||
    release.recurringEnabled!==ownerRecipe(config)||release.paidNotificationsEnabled!==false||
    rebuild.REBUILD_V140_RC_SHA!==config.sourceSha||env.REBUILD_V140_RC_SHA!==config.sourceSha||
    rebuild.REBUILD_V140_RELEASE_REVISION!=='40'||env.REBUILD_V140_RELEASE_REVISION!=='40'||
    rebuild.REBUILD_V140_OWNER_WINDOW!=='false'||env.REBUILD_V140_OWNER_WINDOW!=='false'||
    rebuild.REBUILD_V140_OWNER_TELEGRAM_ID!=='0'||env.REBUILD_V140_OWNER_TELEGRAM_ID!=='0'||
    rebuild.REBUILD_V140_BOT_ID!==String(config.botId)||env.REBUILD_V140_BOT_ID!==String(config.botId)||
    rebuild.REBUILD_V140_RELEASE_LEASE_REQUIRED!=='true'||env.REBUILD_V140_RELEASE_LEASE_REQUIRED!=='true'||
    rebuild.REBUILD_V140_ADMIN_ACCESS_ENABLED!=='true'||env.REBUILD_V140_ADMIN_ACCESS_ENABLED!=='true'||
    rebuild.REBUILD_V140_ADMIN_BETA_GRANTS_ENABLED!=='false'||env.REBUILD_V140_ADMIN_BETA_GRANTS_ENABLED!=='false'||
    env.REBUILD_V140_CONTROL_ISSUED_AT!=='1000000000'||env.REBUILD_V140_CONTROL_EXPIRES_AT!=='1000000001'||
    env.MINI_APP_ORIGIN!==rebuild.MINI_APP_ORIGIN||!ownerMatches(env)||typeof env.BOT_TOKEN!=='string'||
    env.BOT_TOKEN.split(':')[0]!==String(config.botId)||
    featureFlags.some(flag=>rebuild['REBUILD_V140_'+flag+'_ENABLED']!==(['STORAGE','WRITES','TELEGRAM'].includes(flag)?'true':'false')||
      flag!=='WRITES'&&env['REBUILD_V140_'+flag+'_ENABLED']!==rebuild['REBUILD_V140_'+flag+'_ENABLED'])||
    !['true','false'].includes(env.REBUILD_V140_WRITES_ENABLED)||
    legacy.V141_RELEASE_MODE!=='owner_only'||legacy.V141_SOURCE_SHA!==config.sourceSha||
    legacy.V141_AUTHORIZATION_ENABLED!=='true'||legacy.V141_LEGACY_COMPATIBILITY_ENABLED!=='true'||
    env.V141_RELEASE_MODE!=='owner_only'||env.V141_SOURCE_SHA!==config.sourceSha||
    env.V141_AUTHORIZATION_ENABLED!=='true'||env.V141_LEGACY_COMPATIBILITY_ENABLED!=='true'||
    admin.mode!=='owner_only'||admin.sourceSha!==config.sourceSha||admin.supportCandidateSha!==config.sourceSha||
    env.V141_ADMIN_MINI_APP_ENABLED!=='true'||env.V141_ADMIN_SUPPORT_CANDIDATE_SHA!==config.sourceSha||
    env.V141_ADMIN_SUPPORT_BRIDGE_KEY!==admin.supportBridgeKey||env.V141_ADMIN_PRODUCT_VERSION!=='1.4.1.1'||
    product.mode!=='owner_only'||product.sourceSha!==config.sourceSha||product.dragonEmojiEnabled!==true||
    !['true','false'].includes(env.V142_DRAGON_EMOJI_ENABLED))fail();
  return config.sourceSha;
}
function currentPair(env){
  const value=readV143NativeReadinessConfig();if(value===null)return null;
  const options={env,...compiledGlobals()};
  assertV143NativeReadinessSourcePair(value,options);return value;
}
function ownerSwitches(env){
  return env.STARS_PAYMENTS_ENABLED==='true'&&env.STARS_RECURRING_ENABLED==='true'&&
    env.STARS_ROLLOUT_MODE==='admin'&&env.STARS_RECURRING_PRICE_VERSION==='1'&&
    env.STARS_RECURRING_TERMS_REVISION===V143_NATIVE_OWNER_CHECKOUT_FRAME.termsRevision&&
    typeof env.STARS_INVOICE_SECRET==='string'&&env.STARS_INVOICE_SECRET.length>=32;
}
// Routing only. The invoice producer must independently verify a genuine
// owner/session/decision and the exact canonical quote before every effect.
export function isV143NativeOwnerCheckoutEnvelope(env,...args){
  try{
    if(args.length)return false;
    const config=currentPair(env);
    return config!==null&&ownerRecipe(config)&&ownerSwitches(env)&&
      env.REBUILD_V140_WRITES_ENABLED==='false'&&env.STARS_REFUNDS_ENABLED==='false'&&
      env.STARS_PAID_NOTIFICATIONS_ENABLED==='false';
  }catch{return false;}
}
// Routing discriminator only: no database is queried and no authority token
// is minted. Effect code must separately authenticate and fence current D1.
export function isV143NativeReadinessEnvelope(env,...args){
  try{
    if(args.length||currentPair(env)===null)return false;
    return Object.entries(off).every(([key,expected])=>env[key]===expected)||
      isV143NativeOwnerCheckoutEnvelope(env);
  }catch{return false;}
}
export function materializeV143NativeReadinessEnv(env,...args){
  if(args.length)fail();
  const config=currentPair(env);if(config===null)return env;
  const enabled=ownerRecipe(config)&&ownerSwitches(env);
  // The reviewed package catalog correction is a new immutable price version.
  // Select it only in the genuine enabled owner recipe; ordinary deployments
  // and explicit package versions retain their own configuration. This lookup
  // default creates neither a physical binding nor purchase authority.
  const correctedPackageVersion=enabled&&env.STARS_PACKAGES_ENABLED==='true'&&
    env.STARS_PACKAGE_PRICE_VERSION===undefined?{STARS_PACKAGE_PRICE_VERSION:'2'}:{};
  return {...env,...off,...(enabled?{STARS_PAYMENTS_ENABLED:'true',STARS_RECURRING_ENABLED:'true'}:{}),
    ...correctedPackageVersion};
}
export function v143NativeReadinessHealthProjection(env,...args){
  if(args.length)fail();
  const config=readV143NativeReadinessConfig();if(config===null)return Object.freeze({});
  // Health receives the physical Worker env; source layers are sealed compiled
  // data here, while ordinary request materializers supply their runtime fields.
  // This projection reports switches, never current D1/payment eligibility.
  assertV143NativeReadinessCompiledDescriptors();
  if(env!==undefined)assertV143NativeReadinessRuntimeData(env);
  const nativeCheckoutEnabled=env!==undefined&&ownerRecipe(config)&&ownerSwitches(env)&&ownerMatches(env)&&
    typeof env.BOT_TOKEN==='string'&&env.BOT_TOKEN.split(':')[0]===String(config.botId);
  return Object.freeze({nativeReadiness:true,nativeReadinessMode:config.mode,
    leaseSourceSha:config.sourceSha,leaseRevision:config.preparedRevision,
    recurringEnabled:nativeCheckoutEnabled,paidNotificationsEnabled:false,newFinancialProducersEnabled:nativeCheckoutEnabled,
    nativeCheckoutEnabled,...(ownerRecipe(config)?{nativeCheckoutCompiled:true,nativeCheckoutOwnerId:config.ownerId,
      nativeCheckoutPlanCode:V143_NATIVE_OWNER_CHECKOUT_FRAME.planCode,
      nativeCheckoutAmountStars:V143_NATIVE_OWNER_CHECKOUT_FRAME.amountStars,
      nativeCheckoutPeriodSeconds:V143_NATIVE_OWNER_CHECKOUT_FRAME.periodSeconds}:{})});
}
