import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { signedInitData, approvedPartner, publishedOffer } from './helpers/v1.4.0-rebuild-sqlite.mjs';

const applyRuntimeSchema=f=>f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
const envFor=(f,id=101)=>{
  const candidate='a'.repeat(40),issued=f.now-1,expires=f.now+600;
  f.sqlite.prepare(`INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,owner_telegram_id,issued_at,expires_at,updated_at)
    VALUES(1,?,1,'open',1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET candidate_sha=excluded.candidate_sha,
    state=excluded.state,beta_enabled=1,owner_telegram_id=excluded.owner_telegram_id,issued_at=excluded.issued_at,
    expires_at=excluded.expires_at,updated_at=excluded.updated_at`).run(candidate,id,issued,expires,f.now);
  return {...f.serverEnv,V141_AUTHORIZATION_ENABLED:'true',REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',
    REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',REBUILD_V140_RC_SHA:candidate,REBUILD_V140_RELEASE_REVISION:'1',
    REBUILD_V140_OWNER_TELEGRAM_ID:String(id),REBUILD_V140_OWNER_WINDOW:`true:${issued}:${expires}`};
};
async function session(f,env,id=101){
  const result=await f.call(id,'session',{method:'POST',token:null,payload:{initData:signedInitData(id,f.now)},customEnv:env});
  assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.authorizationVersion,1);
  return result.data.sessionToken;
}
const call=(f,env,token,path,options={})=>f.call(Number(env.REBUILD_V140_OWNER_TELEGRAM_ID),path,{customEnv:env,token,...options});
const legal=async(f,id=202)=>{
  const p=await approvedPartner(f,id);
  f.sqlite.prepare(`INSERT INTO partner_legal_profiles(partner_profile_id,profile_kind,verification_state,revision,declared_by,declared_at,updated_at)
    VALUES(?,'individual','self_declared',1,?,datetime(?,'unixepoch'),datetime(?,'unixepoch'))`).run(p.profileId,id,f.now,f.now);
  return p;
};
const preview=(f,id)=>{
  const start=f.now-5,end=start+604800,source='dragon_preview:v1.3.5-hotfix.1';
  f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(id);
  f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(id);
  f.sqlite.prepare(`INSERT INTO trial_grants(grant_id,telegram_id,subject_fingerprint,program_code,source_code,status,started_at,ends_at,retention_until,workflow_instance_id,workflow_state,granted_at,updated_at)
    VALUES(?,?,?,'dragon_preview',?,'active',?,?,?,?,'started',?,?)`).run(crypto.randomUUID(),id,'a'.repeat(64),source,start,end,end+86400,'offline-http-preview-'+id,start,start);
  f.sqlite.prepare("UPDATE user_plans SET source_code=?,effective_from=datetime(?,'unixepoch'),revision=revision+1 WHERE telegram_id=?").run(source,start,id);
  f.sqlite.prepare("UPDATE user_access_states SET access_state='trial',source_code=?,state_started_at=datetime(?,'unixepoch'),state_ends_at=datetime(?,'unixepoch'),revision=revision+1 WHERE telegram_id=?").run(source,start,end,id);
  f.sqlite.prepare("UPDATE user_access SET access_tier='trial',trial_used=1,trial_started_at=datetime(?,'unixepoch'),trial_ends_at=datetime(?,'unixepoch') WHERE telegram_id=?").run(start,end,id);
};

test('protected session transport remains available without runtime schema; effects never fall back',async t=>{
  const f=foundationFixture(t),env=envFor(f);
  const before=f.sqlite.prepare('SELECT COUNT(*) AS n FROM partner_applications').get().n;
  const opened=await f.call(101,'session',{method:'POST',token:null,payload:{initData:signedInitData(101,f.now)},customEnv:env});
  assert.equal(opened.status,200);assert.equal(opened.data.features.mutationsEnabled,false);
  const token=opened.data.sessionToken;
  assert.equal((await call(f,env,token,'profile')).status,200);
  assert.equal((await call(f,env,token,'applications?view=mine')).status,200);
  const denied=await call(f,env,token,'partner/application',{method:'POST',payload:{displayName:'Партнёр',contact:'',ageConfirmed:true}});
  assert.equal(denied.status,503);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM partner_applications').get().n,before);
});
test('signed scoped HTTP session returns canonical access and safe ten-key decision; GET is read-only',async t=>{
  const f=foundationFixture(t);applyRuntimeSchema(f);const env=envFor(f),token=await session(f,env);
  const before=f.binding.audit.length,result=await call(f,env,token,'bootstrap');
  assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.readModelVersion,1);
  assert.equal(result.data.access.readPath,'canonical');assert.equal(result.data.access.planCode,'free');
  assert.equal(result.data.authorization.capability,'profile.read_own');assert.equal(result.data.authorization.allowed,true);
  assert.equal(Object.keys(result.data.authorization).length,10);
  assert.ok(f.binding.audit.slice(before).every(row=>row.mode==='read'));
});
test('owned offer creation uses one canonical receipt/audit; at-limit create denies and edit remains atomic',async t=>{
  const f=foundationFixture(t);await legal(f);applyRuntimeSchema(f);const env=envFor(f,202),token=await session(f,env,202);
  const create=await call(f,env,token,'offers',{method:'POST',payload:{},key:'p04_http_create_fixed_key'});
  assert.equal(create.status,200,JSON.stringify(create.data));assert.equal(create.data.commitStatus,'committed');
  assert.equal(create.data.authorization.capability,'offer.create_private');
  const code=create.data.offerCode;
  const denied=await call(f,env,token,'offers',{method:'POST',payload:{},key:'p04_http_create_other_key'});
  assert.equal(denied.status,403,JSON.stringify(denied.data));assert.equal(denied.data.error,'quota_exceeded');
  assert.equal(denied.data.authorization.quota.limit,1);assert.equal(denied.data.authorization.quota.remaining,0);
  const edit=await call(f,env,token,`offers/${code}/version`,{method:'POST',payload:{version:1,patch:{title:'Изменённый оффер'}},key:'p04_http_edit_fixed_key'});
  assert.equal(edit.status,200,JSON.stringify(edit.data));assert.equal(edit.data.authorization.capability,'offer.edit_own');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM entitlement_decision_audit WHERE capability LIKE 'offer.%'").get().n,2);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM mini_app_atomic_guards').get().n,0);
});
test('same edit key replays its historical version identity without a second effect',async t=>{
  const f=foundationFixture(t),p=await legal(f),offer=await publishedOffer(f,202,p);applyRuntimeSchema(f);
  const env=envFor(f,202),token=await session(f,env,202),path=`offers/${offer.code}/version`;
  const options={method:'POST',payload:{version:3,patch:{title:'Проверенная новая версия'}},key:'p04_same_edit_historical'};
  const first=await call(f,env,token,path,options);assert.equal(first.status,200,JSON.stringify(first.data));
  const n=f.sqlite.prepare('SELECT COUNT(*) AS n FROM offer_versions WHERE offer_code=?').get(offer.code).n;
  const replay=await call(f,env,token,path,options);assert.equal(replay.status,200,JSON.stringify(replay.data));
  assert.equal(replay.data.commitStatus,'unchanged');assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM offer_versions WHERE offer_code=?').get(offer.code).n,n);
});
test('public catalog/action and own empty history are genuinely authorized and redacted',async t=>{
  const f=foundationFixture(t),p=await legal(f),offer=await publishedOffer(f,202,p);applyRuntimeSchema(f);
  const env=envFor(f),token=await session(f,env);
  const catalog=await call(f,env,token,'offers?view=catalog');assert.equal(catalog.status,200,JSON.stringify(catalog.data));
  assert.equal(catalog.data.authorization.capability,'offer.read_public');assert.equal(catalog.data.items[0].offer.code,offer.code);
  const action=await call(f,env,token,`offers/${offer.code}/action`);assert.equal(action.status,200,JSON.stringify(action.data));
  assert.equal(action.data.authorization.capability,'offer.open_action');
  const empty=await call(f,env,token,'applications?view=mine');assert.equal(empty.status,200,JSON.stringify(empty.data));
  assert.deepEqual(empty.data.items,[]);assert.equal(empty.data.authorization.capability,'application.read_own');
  for(const field of ['sourceFingerprint','source_ref','accountFingerprint','issuer','assertions','canonical']) {
    assert.ok(!JSON.stringify(catalog.data.authorization).includes(field),field);
  }
});
test('release revocation during atomic batch rolls back receipt, offer and entitlement audit',async t=>{
  const f=foundationFixture(t);await legal(f);applyRuntimeSchema(f);const env=envFor(f,202),token=await session(f,env,202);
  const receipts=f.sqlite.prepare('SELECT COUNT(*) AS n FROM mini_app_command_receipts').get().n;
  const audit=f.sqlite.prepare('SELECT COUNT(*) AS n FROM entitlement_decision_audit').get().n;
  const revoke=({sqlite,statements})=>{
    if(statements.some(s=>/^INSERT INTO mini_app_command_receipts/u.test(s.sql))) {
      sqlite.prepare("UPDATE mini_app_release_control SET state='closed',beta_enabled=0,owner_telegram_id=NULL,issued_at=NULL,expires_at=NULL,revision=revision+1").run();
    } else f.binding.beforeBatch=revoke;
  };
  f.binding.beforeBatch=revoke;
  const denied=await call(f,env,token,'offers',{method:'POST',payload:{},key:'p04_release_race_owned'});
  assert.equal(denied.status,409,JSON.stringify(denied.data));assert.equal(denied.data.commitStatus,undefined);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM offer_owners WHERE owner_kind='partner'").get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM mini_app_command_receipts').get().n,receipts);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM entitlement_decision_audit').get().n,audit);
});
test('canonical administrator remains available after participant lease expires and forged admin is rejected',async t=>{
  const f=foundationFixture(t);applyRuntimeSchema(f);const env=envFor(f),token=await session(f,env,900);
  const expired={...env,REBUILD_V140_OWNER_WINDOW:`true:${f.now-601}:${f.now-1}`};
  f.sqlite.prepare("UPDATE mini_app_release_control SET state='closed',beta_enabled=0,owner_telegram_id=NULL,issued_at=NULL,expires_at=NULL").run();
  const owner=await call(f,expired,token,'profile');assert.equal(owner.status,200,JSON.stringify(owner.data));
  assert.equal(owner.data.systemRole,'admin');assert.equal(owner.data.authorization.allowed,true);
  f.sqlite.prepare("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'").run();
  const denied=await call(f,expired,token,'profile');assert.ok([403,503].includes(denied.status));
  assert.equal(denied.data.authorization,undefined);
});
test('partner application uses fixed canonical plan and rejects changed-body reuse of the same key',async t=>{
  const f=foundationFixture(t);applyRuntimeSchema(f);const env=envFor(f),token=await session(f,env);
  const options={method:'POST',key:'p04_http_partner_apply_fixed',payload:{displayName:'Партнёр',contact:'@contact',ageConfirmed:true}};
  const first=await call(f,env,token,'partner/application',options);assert.equal(first.status,200,JSON.stringify(first.data));
  const replay=await call(f,env,token,'partner/application',options);assert.equal(replay.status,200,JSON.stringify(replay.data));assert.equal(replay.data.commitStatus,'unchanged');
  const conflict=await call(f,env,token,'partner/application',{...options,payload:{...options.payload,contact:'@changed'}});
  assert.equal(conflict.status,409,JSON.stringify(conflict.data));assert.equal(conflict.data.error,'idempotency_conflict');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM partner_applications WHERE telegram_id=101').get().n,1);
});
test('legal declaration persists after a new signed session; exact replay does not increment revision',async t=>{
  const f=foundationFixture(t),p=await approvedPartner(f);applyRuntimeSchema(f);const env=envFor(f,202),token=await session(f,env,202);
  const options={method:'POST',key:'p04_http_legal_declaration_fixed',payload:{profileKind:'self_employed',selfDeclarationAccepted:true}};
  const first=await call(f,env,token,'partner/legal-profile',options);assert.equal(first.status,200,JSON.stringify(first.data));
  assert.equal(first.data.authorization.capability,'partner.legal_declare_own');
  const replay=await call(f,env,token,'partner/legal-profile',options);assert.equal(replay.status,200,JSON.stringify(replay.data));assert.equal(replay.data.commitStatus,'unchanged');
  const conflict=await call(f,env,token,'partner/legal-profile',{...options,payload:{profileKind:'individual',selfDeclarationAccepted:true}});
  assert.equal(conflict.status,409,JSON.stringify(conflict.data));assert.equal(conflict.data.error,'idempotency_conflict');
  const fresh=await session(f,env,202),profile=await call(f,env,fresh,'profile');assert.equal(profile.status,200,JSON.stringify(profile.data));
  assert.equal(profile.data.partner.legalProfile.profileKind,'self_employed');assert.equal(profile.data.partner.legalProfile.verificationState,'self_declared');
  assert.equal(f.sqlite.prepare('SELECT revision FROM partner_legal_profiles WHERE partner_profile_id=?').get(p.profileId).revision,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM partner_legal_profile_events WHERE partner_profile_id=?').get(p.profileId).n,1);
});
test('own username privacy preference uses fixed plan and survives a fresh profile read',async t=>{
  const f=foundationFixture(t),p=await approvedPartner(f);f.sqlite.prepare("UPDATE partner_profiles SET telegram_username='visible_partner' WHERE id=?").run(p.profileId);
  applyRuntimeSchema(f);const env=envFor(f,202),token=await session(f,env,202);
  const result=await call(f,env,token,'partner/public-username',{method:'POST',payload:{enabled:true},key:'p04_public_username_fixed'});
  assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.authorization.capability,'partner.public_username.update_own');
  const profile=await call(f,env,token,'profile');assert.equal(profile.status,200,JSON.stringify(profile.data));
  assert.equal(profile.data.partner.profile.publicUsernameEnabled,true);assert.equal(profile.data.partner.profile.telegramUsername,'visible_partner');
});
test('own offer list shows actual min of Preview10 and Beta3 without private source facts',async t=>{
  const f=foundationFixture(t),p=await legal(f);await publishedOffer(f,202,p);await publishedOffer(f,202,p);preview(f,202);applyRuntimeSchema(f);
  const env=envFor(f,202),token=await session(f,env,202),result=await call(f,env,token,'offers?view=mine&limit=50');
  assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.items.length,2);
  const dto=result.data.decisions['offer.create_private'];assert.equal(dto.allowed,true);assert.equal(dto.effectivePlan,'preview');
  assert.deepEqual(dto.quota,{limit:3,used:2,remaining:1,resetsAt:null,scope:'own_partner_profile'});
  assert.equal(Object.keys(dto).length,10);
  for(const field of ['sourceFingerprint','ownerTelegramId','source_ref','assertions','canonical','issued_by']) assert.ok(!JSON.stringify(dto).includes(field),field);
});
test('paused commercial profile keeps exact own offer history visible while growth remains closed',async t=>{
  const f=foundationFixture(t),p=await legal(f),offer=await publishedOffer(f,202,p);
  f.sqlite.prepare("UPDATE partner_profiles SET status='paused' WHERE id=?").run(p.profileId);
  applyRuntimeSchema(f);const env=envFor(f,202),token=await session(f,env,202),result=await call(f,env,token,'offers?view=mine');
  assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.items[0].code,offer.code);
  assert.equal(result.data.authorization.allowed,true);assert.equal(result.data.decisions['offer.create_private'].allowed,false);
});
test('damaged optional runtime guard preserves own profile/history but closes commercial reads and effects',async t=>{
  const f=foundationFixture(t);await legal(f);applyRuntimeSchema(f);const env=envFor(f,202),token=await session(f,env,202);
  f.sqlite.exec('DROP TRIGGER v141_ai_journal_initial');
  assert.equal((await call(f,env,token,'profile')).status,200);
  assert.equal((await call(f,env,token,'applications?view=mine')).status,200);
  const owned=await call(f,env,token,'offers?view=mine');assert.equal(owned.status,200,JSON.stringify(owned.data));
  assert.equal(owned.data.decisions,undefined);
  const before=f.sqlite.prepare("SELECT COUNT(*) AS n FROM offer_owners WHERE owner_kind='partner'").get().n;
  const denied=await call(f,env,token,'offers',{method:'POST',payload:{}});assert.equal(denied.status,503);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM offer_owners WHERE owner_kind='partner'").get().n,before);
  assert.equal((await call(f,env,token,'offers?view=catalog')).status,503);
});
test('foreign private offer action and missing offer action have the same public response',async t=>{
  const f=foundationFixture(t);await legal(f);
  const created=await f.call(202,'offers',{method:'POST',payload:{}});assert.equal(created.status,200);
  applyRuntimeSchema(f);const env=envFor(f),token=await session(f,env);
  const existing=await call(f,env,token,`offers/${created.data.offerCode}/action`),missing=await call(f,env,token,'offers/missing_offer/action');
  assert.equal(existing.status,404);assert.equal(missing.status,404);assert.deepEqual(existing.data,missing.data);
});
test('canonical public route revoked during final authorization cannot return the earlier URL',async t=>{
  const f=foundationFixture(t),p=await legal(f),offer=await publishedOffer(f,202,p);applyRuntimeSchema(f);
  const env=envFor(f),token=await session(f,env);
  let revoked=false;
  const revoke=({sqlite,statements})=>{
    if(statements.length>0 && statements.every(s=>s.sql.startsWith('SELECT CASE WHEN') && s.sql.endsWith('AS valid'))) {
      revoked=true;
      sqlite.prepare("UPDATE partner_links SET status='paused' WHERE id=?").run(offer.linkId);
    } else f.binding.beforeBatch=revoke;
  };
  f.binding.beforeBatch=revoke;
  const denied=await call(f,env,token,`offers/${offer.code}/action`);
  assert.equal(revoked,true);assert.equal(denied.status,409,JSON.stringify(denied.data));assert.equal(denied.data.offer,undefined);
  assert.equal(denied.data.authorization,undefined);
});
