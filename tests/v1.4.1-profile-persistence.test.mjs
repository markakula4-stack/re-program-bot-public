import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {foundationFixture,signedInitData} from './helpers/v1.4.1-fixtures.mjs';
import {approvedPartner} from './helpers/v1.4.0-rebuild-sqlite.mjs';

function closedOwnerEnv(f,id=900) {
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  f.sqlite.exec('UPDATE partner_beta_settings SET enabled=0,private_offers_enabled=0,submissions_enabled=0,public_visibility_enabled=0');
  const candidate='f'.repeat(40),revision=30;
  f.sqlite.prepare(`INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,updated_at)
    VALUES(1,?,?,'closed',0,?)`).run(candidate,revision,f.now);
  return {...f.serverEnv,ADMIN_ID:String(id),OWNER_TELEGRAM_ID:String(id),
    V141_RELEASE_MODE:'owner_only',V141_AUTHORIZATION_ENABLED:'true',
    REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',
    REBUILD_V140_RC_SHA:candidate,REBUILD_V140_RELEASE_REVISION:String(revision),
    REBUILD_V140_OWNER_WINDOW:'false',PARTNER_BETA_ENABLED:'false',
    PARTNER_PRIVATE_OFFERS_ENABLED:'false',PARTNER_OFFER_SUBMISSIONS_ENABLED:'false',
    PARTNER_OFFER_PUBLIC_VISIBILITY_ENABLED:'false'};
}
async function ownerPartner(f) {
  const partner=await approvedPartner(f,202);
  f.sqlite.exec("INSERT INTO user_roles(telegram_id,role,status) VALUES(202,'admin','active')");
  f.sqlite.prepare("UPDATE partner_profiles SET telegram_username='saved_partner' WHERE id=?").run(partner.profileId);
  return {partner,env:closedOwnerEnv(f,202)};
}
async function session(f,env) {
  const id=Number(env.ADMIN_ID);
  const result=await f.call(id,'session',{method:'POST',token:null,
    payload:{initData:signedInitData(id,f.now)},customEnv:env});
  assert.equal(result.status,200,JSON.stringify(result.data));
  return result.data.sessionToken;
}
const call=(f,env,token,route,options={})=>f.call(Number(env.ADMIN_ID),route,{token,customEnv:env,...options});
const legalRow=(f,profileId)=>f.sqlite.prepare('SELECT profile_kind,verification_state,revision FROM partner_legal_profiles WHERE partner_profile_id=?').get(profileId);
const legalEvents=(f,profileId)=>f.sqlite.prepare('SELECT COUNT(*) n FROM partner_legal_profile_events WHERE partner_profile_id=?').get(profileId).n;
const lease=f=>({...f.sqlite.prepare('SELECT state,beta_enabled,revision FROM mini_app_release_control WHERE id=1').get()});

test('closed owner Mini App persists legal declarations and changed status without converting self declaration into verification',async t=>{
  const f=foundationFixture(t),{partner,env}=await ownerPartner(f),token=await session(f,env);
  const options={method:'POST',key:'profile_legal_individual_first',payload:{profileKind:'individual',selfDeclarationAccepted:true}};
  const first=await call(f,env,token,'partner/legal-profile',options);
  assert.equal(first.status,200,JSON.stringify(first.data));assert.equal(first.data.commitStatus,'committed');
  const replay=await call(f,env,token,'partner/legal-profile',options);
  assert.equal(replay.status,200,JSON.stringify(replay.data));assert.equal(replay.data.commitStatus,'unchanged');
  const same=await call(f,env,token,'partner/legal-profile',{...options,key:'profile_legal_individual_noop'});
  assert.equal(same.status,200,JSON.stringify(same.data));assert.equal(same.data.commitStatus,'unchanged');
  assert.deepEqual({...legalRow(f,partner.profileId)},{profile_kind:'individual',verification_state:'self_declared',revision:1});
  assert.equal(legalEvents(f,partner.profileId),1);

  const changed=await call(f,env,token,'partner/legal-profile',{method:'POST',key:'profile_legal_kind_changed',
    payload:{profileKind:'self_employed',selfDeclarationAccepted:true}});
  assert.equal(changed.status,200,JSON.stringify(changed.data));assert.equal(changed.data.commitStatus,'committed');
  const fresh=await session(f,env),profile=await call(f,env,fresh,'profile');
  assert.equal(profile.status,200,JSON.stringify(profile.data));
  assert.equal(profile.data.systemRole,'admin');
  assert.equal(profile.data.partner.legalProfile.profileKind,'self_employed');
  assert.equal(profile.data.partner.legalProfile.verificationState,'self_declared');
  assert.deepEqual({...legalRow(f,partner.profileId)},{profile_kind:'self_employed',verification_state:'self_declared',revision:2});
  assert.equal(legalEvents(f,partner.profileId),2);
  assert.equal(f.sqlite.prepare('SELECT verified_by,verified_at FROM partner_legal_profiles WHERE partner_profile_id=?').get(partner.profileId).verified_by,null);
  assert.deepEqual(lease(f),{state:'closed',beta_enabled:0,revision:30});
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_atomic_guards').get().n,0);
});

test('closed owner username privacy save distinguishes unchanged values, persists both toggle directions and rejects changed-body key reuse',async t=>{
  const f=foundationFixture(t),{partner,env}=await ownerPartner(f),token=await session(f,env);
  const route='partner/public-username';
  const unchanged=await call(f,env,token,route,{method:'POST',key:'profile_privacy_false_noop',payload:{enabled:false}});
  assert.equal(unchanged.status,200,JSON.stringify(unchanged.data));assert.equal(unchanged.data.commitStatus,'unchanged');
  const enable={method:'POST',key:'profile_privacy_enabled_first',payload:{enabled:true}};
  const saved=await call(f,env,token,route,enable);
  assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.commitStatus,'committed');
  const repeated=await call(f,env,token,route,{...enable,key:'profile_privacy_enabled_noop'});
  assert.equal(repeated.status,200,JSON.stringify(repeated.data));assert.equal(repeated.data.commitStatus,'unchanged');
  const profile=await call(f,env,await session(f,env),'profile');
  assert.equal(profile.status,200,JSON.stringify(profile.data));
  assert.equal(profile.data.partner.profile.publicUsernameEnabled,true);
  assert.equal(profile.data.partner.profile.telegramUsername,'saved_partner');
  const conflict=await call(f,env,token,route,{...enable,payload:{enabled:false}});
  assert.equal(conflict.status,409,JSON.stringify(conflict.data));assert.equal(conflict.data.error,'idempotency_conflict');
  assert.equal(f.sqlite.prepare('SELECT public_username_enabled FROM partner_public_settings WHERE telegram_id=202').get().public_username_enabled,1);
  const disabled=await call(f,env,token,route,{method:'POST',key:'profile_privacy_disabled_next',payload:{enabled:false}});
  assert.equal(disabled.status,200,JSON.stringify(disabled.data));assert.equal(disabled.data.commitStatus,'committed');
  const freshProfile=await call(f,env,await session(f,env),'profile');
  assert.equal(freshProfile.status,200,JSON.stringify(freshProfile.data));
  assert.equal(freshProfile.data.partner.profile.publicUsernameEnabled,false);
  assert.equal(f.sqlite.prepare('SELECT status FROM partner_profiles WHERE id=?').get(partner.profileId).status,'active');
  assert.deepEqual(lease(f),{state:'closed',beta_enabled:0,revision:30});
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_atomic_guards').get().n,0);
});

test('canonical admin without partner profile can open own profile but partner-only saves do not manufacture profile or legal authority',async t=>{
  const f=foundationFixture(t),env=closedOwnerEnv(f),token=await session(f,env);
  const profile=await call(f,env,token,'profile');
  assert.equal(profile.status,200,JSON.stringify(profile.data));assert.equal(profile.data.systemRole,'admin');
  assert.equal(profile.data.partner.profile,null);
  const before=f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_command_receipts').get().n;
  for(const [route,payload,key] of [
    ['partner/legal-profile',{profileKind:'individual',selfDeclarationAccepted:true},'profile_admin_no_partner_legal'],
    ['partner/public-username',{enabled:false},'profile_admin_no_partner_privacy'],
  ]) {
    const denied=await call(f,env,token,route,{method:'POST',payload,key});
    assert.equal(denied.status,403,JSON.stringify(denied.data));assert.equal(denied.data.commitStatus,undefined);
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM partner_profiles WHERE telegram_id=900').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM partner_legal_profiles').get().n,0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM user_roles WHERE telegram_id=900 AND role='partner'").get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_command_receipts').get().n,before);
  assert.deepEqual(lease(f),{state:'closed',beta_enabled:0,revision:30});
});
