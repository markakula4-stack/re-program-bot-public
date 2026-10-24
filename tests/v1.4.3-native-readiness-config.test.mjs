import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {V143_NATIVE_READINESS_CONFIG_GLOBAL as GLOBAL,V143_NATIVE_READINESS_FRAME as FRAME,V143_NATIVE_OWNER_CHECKOUT_FRAME as CHECKOUT,
  validateV143NativeReadinessConfig,readV143NativeReadinessConfig,
  assertV143NativeReadinessCompiledDescriptors,
  assertV143NativeReadinessRuntimeData,
  assertV143NativeReadinessSourcePair,isV143NativeReadinessEnvelope,isV143NativeOwnerCheckoutEnvelope,
  materializeV143NativeReadinessEnv,v143NativeReadinessHealthProjection} from '../src/v1.4.3/native-readiness-config.mjs';

const source='a'.repeat(40),invalid=/v143_native_readiness_config_invalid/u;
const capsule=(mode='owner_only')=>Object.freeze({version:'1.4.3',sourceSha:source,mode,...FRAME,recurringEnabled:mode==='owner_acceptance'});
function pair(mode='owner_only'){
  const rebuild=Object.freeze({MINI_APP_ORIGIN:'https://re-program-bot.markakula4.workers.dev',
    REBUILD_V140_OWNER_WINDOW:'false',REBUILD_V140_OWNER_TELEGRAM_ID:'0',
    REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',REBUILD_V140_ADMIN_BETA_GRANTS_ENABLED:'false',
    REBUILD_V140_RC_SHA:source,REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',REBUILD_V140_RELEASE_REVISION:'40',
    REBUILD_V140_BOT_ID:String(FRAME.botId),REBUILD_V140_CONTROL_ISSUED_AT:'1000000000',
    REBUILD_V140_CONTROL_EXPIRES_AT:'1000000001',REBUILD_V140_CONTROL_SECRET_SHA256:'b'.repeat(64),
    ...Object.fromEntries(['STORAGE','WRITES','OFFER_ACTIONS','EFFECTS','RETENTION','TELEGRAM','BETA','RESULT_ACTIONS']
      .map(flag=>['REBUILD_V140_'+flag+'_ENABLED',['STORAGE','WRITES','TELEGRAM'].includes(flag)?'true':'false']))});
  const legacy=Object.freeze({V141_RELEASE_MODE:'owner_only',V141_SOURCE_SHA:source,
    V141_AUTHORIZATION_ENABLED:'true',V141_LEGACY_COMPATIBILITY_ENABLED:'true'});
  const admin=Object.freeze({version:'1.4.1.1',sourceSha:source,mode:'owner_only',
    supportBridgeKey:'c'.repeat(64),supportCandidateSha:source});
  const product=Object.freeze({version:'1.4.2',sourceSha:source,mode:'owner_only',dragonEmojiEnabled:true});
  const release=Object.freeze({version:'1.4.3',sourceSha:source,mode:mode==='owner_acceptance'?'owner_only':mode,
    recurringEnabled:mode==='owner_acceptance',paidNotificationsEnabled:false});
  const env={...rebuild,...legacy,ADMIN_ID:String(FRAME.ownerId),OWNER_TELEGRAM_ID:String(FRAME.ownerId),
    BOT_TOKEN:FRAME.botId+':offline-native-readiness-secret-more-than32',
    V141_ADMIN_MINI_APP_ENABLED:'true',V141_ADMIN_SUPPORT_CANDIDATE_SHA:source,
    V141_ADMIN_SUPPORT_BRIDGE_KEY:admin.supportBridgeKey,V141_ADMIN_PRODUCT_VERSION:'1.4.1.1',
    V142_DRAGON_EMOJI_ENABLED:mode==='recovery'?'false':'true',
    STARS_PAYMENTS_ENABLED:mode==='owner_acceptance'?'true':'false',STARS_REFUNDS_ENABLED:'false',
    STARS_RECURRING_ENABLED:mode==='owner_acceptance'?'true':'false',STARS_PAID_NOTIFICATIONS_ENABLED:'false',
    STARS_ROLLOUT_MODE:'admin',STARS_RECURRING_PRICE_VERSION:'1',STARS_RECURRING_TERMS_REVISION:CHECKOUT.termsRevision,
    STARS_INVOICE_SECRET:'offline-native-invoice-secret-more-than32'};
  return {env,rebuild,release,legacy,admin,product};
}
test('readiness capsule admits exactly closed39 to closed40 lineage and both OFF modes',()=>{
  assert.equal(Object.isFrozen(FRAME),true);
  for(const mode of ['owner_only','recovery']){
    const config=capsule(mode),p=pair(mode);
    assert.equal(validateV143NativeReadinessConfig(config),config);
    assert.equal(assertV143NativeReadinessSourcePair(config,p),source);
    assert.equal(assertV143NativeReadinessSourcePair(config,{...p,env:{...p.env,REBUILD_V140_WRITES_ENABLED:'false'}}),source);
  }
  for(const patch of [{sourceSha:FRAME.parentLeaseSourceSha},{sourceSha:'A'.repeat(40)},{mode:'disabled'},
    {recurringEnabled:true},{paidNotificationsEnabled:true},{parentRevision:38},{preparedRevision:39},
    {ownerId:101},{botId:123},{schemaSha256:'d'.repeat(64)},{ledgerSha256:'d'.repeat(64)},
    {parentLeaseSourceSha:'d'.repeat(40)},{installedReceiptSha256:'e'.repeat(64)},{allowOverride:true}])
    assert.throws(()=>validateV143NativeReadinessConfig(Object.freeze({...capsule(),...patch})),invalid,JSON.stringify(patch));
  assert.throws(()=>validateV143NativeReadinessConfig({...capsule()}),invalid);
});
test('capsule, linked config and runtime property accessors are rejected without execution',()=>{
  let getters=0;
  assert.equal(assertV143NativeReadinessRuntimeData({}),true,'raw env checks no source or identity fields');
  for(const field of ['ADMIN_ID','BOT_TOKEN','DB','unrelatedPhysicalBinding']){
    const raw={};Object.defineProperty(raw,field,{enumerable:true,get(){getters++;throw Error('getter executed');}});
    assert.throws(()=>assertV143NativeReadinessRuntimeData(raw),invalid,field);
    assert.throws(()=>assertV143NativeReadinessRuntimeData(raw,{allowOverride:true}),invalid,field+' extra args');
  }
  for(const raw of [null,[],Object.create(null),new (class ForeignEnv {})()])
    assert.throws(()=>assertV143NativeReadinessRuntimeData(raw),invalid);
  assert.throws(()=>assertV143NativeReadinessRuntimeData({},{allowOverride:true}),invalid);
  for(const field of Object.keys(capsule())){
    const value={...capsule()};Object.defineProperty(value,field,{enumerable:true,get(){getters++;return capsule()[field];}});
    Object.freeze(value);assert.throws(()=>validateV143NativeReadinessConfig(value),invalid);
  }
  const p=pair();
  for(const kind of ['rebuild','release','legacy','admin','product']){
    const value={...p[kind]},field=Object.keys(value)[0];
    Object.defineProperty(value,field,{enumerable:true,get(){getters++;return p[kind][field];}});Object.freeze(value);
    assert.throws(()=>assertV143NativeReadinessSourcePair(capsule(),{...p,[kind]:value}),invalid);
  }
  const executable={toString(){getters++;return 'c'.repeat(64);}};
  for(const field of ['sourceSha','supportBridgeKey'])assert.throws(()=>assertV143NativeReadinessSourcePair(capsule(),
    {...p,admin:Object.freeze({...p.admin,[field]:executable})}),invalid);
  const env={...p.env};Object.defineProperty(env,'ADMIN_ID',{enumerable:true,get(){getters++;return String(FRAME.ownerId);}});
  assert.throws(()=>assertV143NativeReadinessSourcePair(capsule(),{...p,env}),invalid);
  assert.equal(getters,0);
});
test('source pair rejects wrong identity, epochs, source layers, feature expansion and overrides',()=>{
  const p=pair();
  for(const patch of [{REBUILD_V140_RC_SHA:FRAME.parentLeaseSourceSha},{REBUILD_V140_RELEASE_REVISION:'39'},
    {REBUILD_V140_OWNER_WINDOW:'true:1790000000:1790001200'},{REBUILD_V140_OWNER_TELEGRAM_ID:String(FRAME.ownerId)},
    {REBUILD_V140_ADMIN_BETA_GRANTS_ENABLED:'true'},{REBUILD_V140_ADMIN_ACCESS_ENABLED:'false'},
    {REBUILD_V140_RELEASE_LEASE_REQUIRED:'false'},{REBUILD_V140_BOT_ID:'123'},
    {REBUILD_V140_EFFECTS_ENABLED:'true'},{REBUILD_V140_OFFER_ACTIONS_ENABLED:'true'},
    {REBUILD_V140_RETENTION_ENABLED:'true'},{REBUILD_V140_RESULT_ACTIONS_ENABLED:'true'},
    {REBUILD_V140_CONTROL_ISSUED_AT:'0999999999'},{REBUILD_V140_CONTROL_EXPIRES_AT:'1000000002'},
    {ADMIN_ID:'101'},{OWNER_TELEGRAM_ID:'101'},{BOT_TOKEN:'123:offline-other-bot'},
    {MINI_APP_ORIGIN:'https://example.test'},{V141_SOURCE_SHA:'d'.repeat(40)},
    {V141_RELEASE_MODE:'recovery'},{V141_AUTHORIZATION_ENABLED:'false'},
    {V141_ADMIN_SUPPORT_CANDIDATE_SHA:'d'.repeat(40)},{V141_ADMIN_SUPPORT_BRIDGE_KEY:'d'.repeat(64)},
    {V141_ADMIN_MINI_APP_ENABLED:'false'},{V141_ADMIN_PRODUCT_VERSION:'1.4.1'},
    {V142_DRAGON_EMOJI_ENABLED:'unknown'}])
    assert.throws(()=>assertV143NativeReadinessSourcePair(capsule(),{...p,env:{...p.env,...patch}}),invalid,JSON.stringify(patch));
  for(const [kind,patch]of [['rebuild',{REBUILD_V140_RC_SHA:'d'.repeat(40)}],['rebuild',{REBUILD_V140_WRITES_ENABLED:'false'}],
    ['rebuild',{REBUILD_V140_ADMIN_BETA_GRANTS_ENABLED:'true'}],['release',{recurringEnabled:true}],
    ['rebuild',{REBUILD_V140_CONTROL_ISSUED_AT:'0999999999'}],['rebuild',{REBUILD_V140_CONTROL_EXPIRES_AT:'1000000002'}],
    ['release',{mode:'recovery'}],['legacy',{V141_SOURCE_SHA:'d'.repeat(40)}],
    ['admin',{supportCandidateSha:'d'.repeat(40)}],['product',{sourceSha:'d'.repeat(40)}]])
    assert.throws(()=>assertV143NativeReadinessSourcePair(capsule(),{...p,[kind]:Object.freeze({...p[kind],...patch})}),invalid,kind+JSON.stringify(patch));
  assert.throws(()=>assertV143NativeReadinessSourcePair(capsule(),{...p,skipSourceFence:true}),invalid);
});

const moduleUrl=new URL('../src/v1.4.3/native-readiness-config.mjs',import.meta.url).href;
function child(variant,mode='owner_only'){
  const p=pair(mode),program=`
    import {V143_NATIVE_READINESS_CONFIG_GLOBAL as GLOBAL,readV143NativeReadinessConfig as read,
      isV143NativeReadinessEnvelope as envelope,isV143NativeOwnerCheckoutEnvelope as checkout,materializeV143NativeReadinessEnv as materialize,
      v143NativeReadinessHealthProjection as health,assertV143NativeReadinessCompiledDescriptors as preflight} from ${JSON.stringify(moduleUrl)};
    const variant=${JSON.stringify(variant)},p=${JSON.stringify(p)},value=${JSON.stringify(capsule(mode))};
    let getters=0,reads=0,calls=0;
    p.env.DB={prepare(){reads++;throw Error('unexpected database');}};
    globalThis.fetch=()=>{calls++;throw Error('unexpected provider');};
    if(variant==='capsule_getter')Object.defineProperty(value,'sourceSha',{enumerable:true,get(){getters++;return ${JSON.stringify(source)};}});
    if(variant==='extra_field')value.allowOverride=true;
    if(variant!=='mutable_value')Object.freeze(value);
    if(!variant.startsWith('absent'))Object.defineProperty(globalThis,GLOBAL,variant==='global_getter'?{get(){getters++;return value;},configurable:false}:
      {value,writable:variant==='mutable_global',configurable:variant==='configurable_global'});
    const names={rebuild:'__RE_PROGRAM_V140_RELEASE_CONFIG__',release:'__RE_PROGRAM_V143_RELEASE_CONFIG__',
      legacy:'__RE_PROGRAM_V141_RELEASE_CONFIG__',admin:'__RE_PROGRAM_V1411_ADMIN_CONFIG__',product:'__RE_PROGRAM_V142_RELEASE_CONFIG__'};
    for(const [kind,name]of Object.entries(names)){
      if(variant==='linked_field_getter'&&kind==='release')Object.defineProperty(p[kind],'sourceSha',{enumerable:true,get(){getters++;return ${JSON.stringify(source)};}});
      if(variant==='linked_wrong_source'&&kind==='release')p[kind].sourceSha='d'.repeat(40);
      if(variant==='linked_compile_on'&&kind==='release')p[kind].recurringEnabled=true;
      if(variant==='linked_control_times'&&kind==='rebuild'){
        p[kind].REBUILD_V140_CONTROL_ISSUED_AT='1790000000';p[kind].REBUILD_V140_CONTROL_EXPIRES_AT='1790001800';
      }
      if(variant==='linked_hidden_extra'&&kind==='rebuild')Object.defineProperty(p[kind],'allowOverride',{value:true,enumerable:false});
      Object.freeze(p[kind]);
      Object.defineProperty(globalThis,name,['linked_global_getter','absent_linked_getter'].includes(variant)&&kind==='release'?{get(){getters++;return p[kind];},configurable:false}:
        {value:p[kind],writable:variant==='linked_mutable_global'&&kind==='release',configurable:false});
    }
    if(variant==='performance')Object.defineProperty(globalThis,'__RE_PROGRAM_V143_PERFORMANCE_CONFIG__',{get(){getters++;return {};},configurable:false});
    const conflicts={install_conflict:'__RE_PROGRAM_V143_INSTALL_CONFIG__',
      readiness_install_conflict:'__RE_PROGRAM_V143_READINESS_INSTALL_CONFIG__',receipt_forward_conflict:'__RE_PROGRAM_V143_RECEIPT_FORWARD_CONFIG__'};
    if(conflicts[variant])Object.defineProperty(globalThis,conflicts[variant],{get(){getters++;return {};},configurable:false});
    if(variant==='bad_source')p.env.REBUILD_V140_RC_SHA='d'.repeat(40);
    if(variant==='effective_on')p.env.STARS_RECURRING_ENABLED='true';
    const switches={payment_off:{STARS_PAYMENTS_ENABLED:'false'},recurring_off:{STARS_RECURRING_ENABLED:'false'},
      physical_all_on:{STARS_PAYMENTS_ENABLED:'true',STARS_RECURRING_ENABLED:'true'},
      physical_bool:{STARS_RECURRING_ENABLED:true},rollout_all:{STARS_ROLLOUT_MODE:'all'},
      wrong_quote_version:{STARS_RECURRING_PRICE_VERSION:'2'},wrong_terms:{STARS_RECURRING_TERMS_REVISION:'wrong-terms'},
      no_secret:{STARS_INVOICE_SECRET:undefined}};
    Object.assign(p.env,switches[variant]??{});
    if(variant==='untrusted_secret')p.env.STARS_INVOICE_SECRET={toString(){getters++;return 'unsafe-secret'.repeat(4);}};
    if(variant==='identity_getter')Object.defineProperty(p.env,'ADMIN_ID',{enumerable:true,get(){getters++;return '8987576334';}});
    let accepted=false,materialized=false,projected=null,error=null,preflightAccepted=false,ownerCheckout=false,effective=null;
    try{preflightAccepted=preflight();const observed=read();accepted=observed!==null;const env=materialize(p.env);materialized=envelope(env);ownerCheckout=checkout(env);effective=Object.fromEntries(['STARS_PAYMENTS_ENABLED','STARS_REFUNDS_ENABLED','STARS_RECURRING_ENABLED','STARS_PAID_NOTIFICATIONS_ENABLED','REBUILD_V140_WRITES_ENABLED'].map(k=>[k,env[k]]));projected=health(p.env);}
    catch(e){error=e.message;}
    p.env.REBUILD_V140_WRITES_ENABLED='false';
    const originalEnvelope=envelope(p.env);
    process.stdout.write(JSON.stringify({accepted,materialized,projected,error,originalEnvelope,getters,reads,calls,preflightAccepted,ownerCheckout,effective}));`;
  const result=spawnSync(process.execPath,['--no-warnings','--input-type=module','--eval',program],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
test('runtime materialization keeps permanent owner lineage while closing every producer without D1/provider calls',()=>{
  for(const mode of ['owner_only','recovery']){
    const result=child('valid',mode);
    assert.equal(result.accepted,true);assert.equal(result.materialized,true);assert.equal(result.originalEnvelope,true);
    assert.equal(result.preflightAccepted,true);
    assert.deepEqual(result.projected,{nativeReadiness:true,nativeReadinessMode:mode,leaseSourceSha:source,leaseRevision:40,
      recurringEnabled:false,paidNotificationsEnabled:false,newFinancialProducersEnabled:false,nativeCheckoutEnabled:false});
    assert.deepEqual([result.error,result.getters,result.reads,result.calls],[null,0,0,0]);
    const effectiveOn=child('effective_on',mode);
    assert.equal(effectiveOn.originalEnvelope,false);assert.equal(effectiveOn.materialized,true,'materializer closes inherited physical opt-ins');
  }
});
test('owner acceptance requires compiled intent and every independent physical checkout prerequisite',()=>{
  assert.deepEqual(CHECKOUT,{ownerId:8987576334,botId:8562951985,planCode:'professional',currency:'XTR',
    amountStars:249,periodSeconds:2592000,priceVersion:1,termsRevision:'2026-10-03.stars-recurring-v1'});
  assert.equal(Object.isFrozen(CHECKOUT),true);
  const config=capsule('owner_acceptance');assert.equal(validateV143NativeReadinessConfig(config),config);
  assert.throws(()=>validateV143NativeReadinessConfig(Object.freeze({...config,recurringEnabled:false})),invalid);
  for(const mode of ['owner_only','recovery','owner_acceptance']){
    const result=child('valid',mode);
    assert.equal(result.ownerCheckout,mode==='owner_acceptance');
    assert.equal(result.effective.REBUILD_V140_WRITES_ENABLED,'false');
    assert.equal(result.effective.STARS_REFUNDS_ENABLED,'false');assert.equal(result.effective.STARS_PAID_NOTIFICATIONS_ENABLED,'false');
    if(mode==='owner_acceptance'){
      assert.equal(result.projected.nativeCheckoutCompiled,true);assert.equal(result.projected.nativeCheckoutEnabled,true);
      assert.equal(result.projected.nativeCheckoutAmountStars,249);assert.equal(result.projected.nativeCheckoutPlanCode,'professional');
    }
  }
  for(const mode of ['owner_only','recovery']){
    const result=child('physical_all_on',mode);assert.equal(result.ownerCheckout,false);
    assert.equal(result.effective.STARS_PAYMENTS_ENABLED,'false');assert.equal(result.effective.STARS_RECURRING_ENABLED,'false');
  }
  for(const variant of ['payment_off','recurring_off','physical_bool','rollout_all','wrong_quote_version','wrong_terms','no_secret']){
    const result=child(variant,'owner_acceptance');assert.equal(result.ownerCheckout,false,variant);
    assert.equal(result.materialized,true,variant+' still retains OFF financial recovery');
    assert.equal(result.projected.nativeCheckoutEnabled,false,variant);
    assert.deepEqual([result.getters,result.reads,result.calls],[0,0,0],variant);
  }
  const hostile=child('untrusted_secret','owner_acceptance');assert.equal(hostile.materialized,false);
  assert.deepEqual([hostile.getters,hostile.reads,hostile.calls],[0,0,0]);
  assert.equal(isV143NativeOwnerCheckoutEnvelope(pair().env),false);
  assert.equal(isV143NativeOwnerCheckoutEnvelope(pair().env,{override:true}),false);
});
test('global capsules and linked globals must be immutable data, never executable substitutions',()=>{
  for(const variant of ['global_getter','mutable_global','configurable_global','mutable_value','capsule_getter','extra_field',
    'linked_global_getter','linked_field_getter','linked_mutable_global','linked_wrong_source','linked_compile_on',
    'linked_control_times','linked_hidden_extra','performance','install_conflict','readiness_install_conflict','receipt_forward_conflict','bad_source','identity_getter']){
    const result=child(variant);
    assert.equal(result.materialized,false,variant);assert.equal(result.originalEnvelope,false,variant);
    assert.equal(result.error,'v143_native_readiness_config_invalid',variant);
    assert.deepEqual([result.getters,result.reads,result.calls],[0,0,0],variant);
    if(!['bad_source','identity_getter'].includes(variant))assert.equal(result.preflightAccepted,false,variant);
  }
});
test('absence preserves the existing non-native path and no helper accepts a config override',()=>{
  assert.equal(readV143NativeReadinessConfig(),null);assert.equal(isV143NativeReadinessEnvelope(pair().env),false);
  assert.equal(assertV143NativeReadinessCompiledDescriptors(),false);
  const env=pair().env;assert.equal(materializeV143NativeReadinessEnv(env),env);
  assert.deepEqual(v143NativeReadinessHealthProjection(),{});
  assert.throws(()=>readV143NativeReadinessConfig(capsule()),invalid);
  assert.throws(()=>materializeV143NativeReadinessEnv(env,capsule()),invalid);
  assert.throws(()=>v143NativeReadinessHealthProjection(env,capsule()),invalid);
  assert.throws(()=>assertV143NativeReadinessCompiledDescriptors(capsule()),invalid);
  assert.equal(isV143NativeReadinessEnvelope(env,{override:true}),false);
  const absent=child('absent');assert.equal(absent.accepted,false);assert.equal(absent.materialized,false);
  assert.deepEqual([absent.error,absent.getters,absent.reads,absent.calls],[null,0,0,0]);
  const absentWithGetter=child('absent_linked_getter');assert.equal(absentWithGetter.preflightAccepted,false);
  assert.deepEqual([absentWithGetter.error,absentWithGetter.getters,absentWithGetter.reads,absentWithGetter.calls],[null,0,0,0]);
});
