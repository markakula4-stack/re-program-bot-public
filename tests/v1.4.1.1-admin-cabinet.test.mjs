import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {foundationFixture,signedInitData} from './helpers/v1.4.1-fixtures.mjs';
import {approvedPartner,publishedOffer} from './helpers/v1.4.0-rebuild-sqlite.mjs';
import {resolveAdminCabinetRoute} from '../src/v1.4.1/admin-cabinet-service.mjs';
import {createAdminSupportFixture} from '../support-bot/tests/admin-bridge-fixture.mjs';
import {createCabinetCustomerContext} from '../src/v1.4.1/trusted-context.mjs';
import {createRuntimeAuthorizer} from '../src/v1.4.1/runtime-authorizer.mjs';
import {callAdminSupportBridge} from '../src/v1.4.1/admin-support-bridge.mjs';
import {sha256Hex} from '../src/v1.4.0-rebuild/mini-app-security.mjs';

const ready=(f,{participant=101,ownerOnly=false}={})=>{
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  const source='a'.repeat(40),issued=f.now-1,expires=f.now+600;
  f.sqlite.prepare(`INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,owner_telegram_id,issued_at,expires_at,updated_at)
    VALUES(1,?,1,'open',1,?,?,?,?)`).run(source,participant,issued,expires,f.now);
  if(ownerOnly) f.sqlite.exec("UPDATE mini_app_release_control SET state='closed',beta_enabled=0,owner_telegram_id=NULL,issued_at=NULL,expires_at=NULL");
  return {...f.serverEnv,V141_AUTHORIZATION_ENABLED:'true',V141_ADMIN_MINI_APP_ENABLED:'true',V141_RELEASE_MODE:ownerOnly?'owner_only':'enabled',
    REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',
    REBUILD_V140_RC_SHA:source,REBUILD_V140_RELEASE_REVISION:'1',REBUILD_V140_OWNER_TELEGRAM_ID:String(participant),
    REBUILD_V140_OWNER_WINDOW:ownerOnly?'false':`true:${issued}:${expires}`};
};
const session=async(f,env,id=900)=>{
  const result=await f.call(id,'session',{method:'POST',token:null,customEnv:env,payload:{initData:signedInitData(id,f.now)}});
  assert.equal(result.status,200,JSON.stringify(result.data));return result.data.sessionToken;
};
const call=(f,env,token,path,options={})=>f.call(900,'admin/'+path,{customEnv:env,token,...options});
const apply=(f,id,adult=true)=>f.sqlite.prepare(`INSERT INTO partner_applications(telegram_id,display_name,contact,age_confirmed,status)
  VALUES(?,'Заявитель','@example',?,'pending')`).run(id,adult?1:0).lastInsertRowid;
const capturedVersion=(f,code)=>f.sqlite.prepare(`SELECT v.* FROM offer_versions v JOIN offer_visibility_rules r
  ON r.current_version_id=v.id AND r.offer_code=v.offer_code WHERE v.offer_code=?`).get(code);
const appendCapturedVersion=async(f,code,{snapshotJson,schema=1,contentHash}={})=>{
  const previous=capturedVersion(f,code),json=snapshotJson??previous.snapshot_json;
  const inserted=f.sqlite.prepare(`INSERT INTO offer_versions(offer_code,version_number,snapshot_schema_version,snapshot_json,business_status,content_hash,created_by)
    VALUES(?,?,?,?,?,?,?)`).run(code,previous.version_number+1,schema,json,previous.business_status,
      contentHash??'sha256:'+await sha256Hex(json),previous.created_by);
  const id=Number(inserted.lastInsertRowid);
  f.sqlite.prepare(`UPDATE offer_visibility_rules SET current_version_id=?,moderation_status='not_submitted',visibility='private',
    submitted_version_id=NULL,approved_version_id=NULL,published_at=NULL WHERE offer_code=?`).run(id,code);
  return id;
};

test('signed owner detail exposes the full captured offer conditions with a fixed allowlist and SELECT-only reads under closed Beta',async t=>{
  const f=foundationFixture(t),p=await publishedOffer(f,202),env=ready(f,{ownerOnly:true}),token=await session(f,env);
  f.sqlite.exec('UPDATE partner_beta_settings SET enabled=0,private_offers_enabled=0,submissions_enabled=0,public_visibility_enabled=0');
  const queue=await call(f,env,token,'offers?status=all'),row=queue.data.items.find(item=>item.code===p.code);
  const before=f.binding.audit.length,detail=await call(f,env,token,`offers/${p.code}?expectedVersionId=${row.expectedVersionId}`);
  assert.equal(detail.status,200,JSON.stringify(detail.data));assert.equal(detail.data.readModelVersion,1);assert.equal(detail.data.section,'offers');
  assert.equal(detail.data.authorization.capability,'admin.cabinet.open');assert.equal(detail.data.authorization.allowed,true);
  const offer=detail.data.offer,snapshot=JSON.parse(capturedVersion(f,p.code).snapshot_json);
  assert.equal(offer.code,p.code);assert.equal(offer.expectedVersionId,row.expectedVersionId);assert.equal(offer.version,row.version);
  for(const [dto,source] of [['buttonText','button_text'],['title','title'],['description','description'],['provider','provider'],['category','category'],
    ['payoutText','payout_text'],['requiredAction','required_action'],['minAge','min_age'],['maxAge','max_age'],['geo','geo'],['holdDays','hold_days'],
    ['trafficSources','traffic_sources'],['sourceName','source_name'],['startsAt','starts_at'],['expiresAt','expires_at']]) assert.deepEqual(offer[dto],snapshot[source],dto);
  assert.equal(offer.publicVisibilityEnabled,false);assert.equal(offer.canModerate,false);assert.equal(offer.canChangeVisibility,true);
  assert.deepEqual(Object.keys(offer).sort(),['code','expectedVersionId','version','ownerProfileId','ownerName','businessStatus','moderationStatus','visibility',
    'buttonText','title','description','provider','category','payoutText','requiredAction','minAge','maxAge','geo','holdDays','trafficSources','sourceName',
    'startsAt','expiresAt','allowedDecisions','canModerate','canChangeVisibility','publicVisibilityEnabled'].sort());
  for(const sensitive of ['snapshotJson','snapshot_json','contentHash','content_hash','partner_link_url','partner_link_tracking_key','catalog_offer_id','program_code','contact','urlEnvKey','actionUrl']) assert.equal(Object.hasOwn(offer,sensitive),false,sensitive);
  assert.equal(JSON.stringify(detail.data).includes(snapshot.partner_link_tracking_key),false);
  assert.ok(f.binding.audit.slice(before).every(item=>item.mode==='read'));
});

test('offer detail rejects stale captured versions before rendering or moderation and does not substitute the current version',async t=>{
  const f=foundationFixture(t),p=await publishedOffer(f,202),env=ready(f,{ownerOnly:true}),token=await session(f,env);
  const captured=capturedVersion(f,p.code).id,next=await appendCapturedVersion(f,p.code);
  f.sqlite.prepare("UPDATE offer_visibility_rules SET moderation_status='pending',submitted_version_id=?,approved_version_id=NULL,visibility='private' WHERE offer_code=?").run(next,p.code);
  const stale=await call(f,env,token,`offers/${p.code}?expectedVersionId=${captured}`);
  assert.equal(stale.status,409,JSON.stringify(stale.data));assert.equal(stale.data.error,'state_conflict');assert.equal(stale.data.offer,undefined);
  const before=f.sqlite.prepare('SELECT COUNT(*) n FROM offer_moderation_decisions WHERE offer_code=?').get(p.code).n;
  const denied=await call(f,env,token,`offers/${p.code}/moderation`,{method:'POST',key:'admin_detail_stale_decision_0001',payload:{expectedVersionId:captured,decision:'approved'}});
  assert.deepEqual({status:denied.status,error:denied.data.error,reasonCode:denied.data.authorization?.reasonCode,
    capability:denied.data.authorization?.capability,allowed:denied.data.authorization?.allowed,actionPolicy:denied.data.authorization?.actionPolicy},
    {status:403,error:'prerequisite_required',reasonCode:'prerequisite_required',capability:'admin.offer.moderate',allowed:false,actionPolicy:'deny'},
    JSON.stringify(denied.data));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM offer_moderation_decisions WHERE offer_code=?').get(p.code).n,before);
  const fresh=await call(f,env,token,`offers/${p.code}?expectedVersionId=${next}`);
  assert.equal(fresh.status,200,JSON.stringify(fresh.data));assert.equal(fresh.data.offer.expectedVersionId,next);assert.equal(fresh.data.offer.canModerate,true);
});

for(const change of ['pointer','root_content','role','epoch']) test('offer detail final read fence withholds content and actions after late '+change+' change',async t=>{
  const f=foundationFixture(t),p=await publishedOffer(f,202),env=ready(f,{ownerOnly:true}),token=await session(f,env),id=capturedVersion(f,p.code).id;
  let injected=false;
  const mutate=async({statements})=>{
    if(statements.length===1&&statements[0].sql.startsWith('SELECT unixepoch() < ?')&&statements[0].sql.includes('offer_versions')) {
      injected=true;
      if(change==='pointer')await appendCapturedVersion(f,p.code);
      else f.sqlite.exec({root_content:"UPDATE offers SET description='Позднее изменение условий' WHERE code='"+p.code+"'",
        role:"UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'",epoch:'UPDATE mini_app_release_control SET revision=revision+1'}[change]);
    } else f.binding.beforeBatch=mutate;
  };
  f.binding.beforeBatch=mutate;
  const result=await call(f,env,token,`offers/${p.code}?expectedVersionId=${id}`);
  assert.equal(injected,true,'actual final repository fence was reached');assert.equal(result.status,409,JSON.stringify(result.data));
  assert.equal(result.data.offer,undefined);assert.equal(result.data.features,undefined);
});

for(const damage of ['hash','schema','snapshot','root_drift']) test('offer detail denies '+damage+' incoherence without returning a partially actionable offer',async t=>{
  const f=foundationFixture(t),p=await publishedOffer(f,202),env=ready(f,{ownerOnly:true}),token=await session(f,env);
  let id=capturedVersion(f,p.code).id;
  if(damage==='root_drift')f.sqlite.prepare("UPDATE offers SET payout_text='Иная выплата' WHERE code=?").run(p.code);
  else id=await appendCapturedVersion(f,p.code,damage==='hash'?{contentHash:'sha256:'+'0'.repeat(64)}:
    damage==='schema'?{schema:2}:{snapshotJson:'[]'});
  const result=await call(f,env,token,`offers/${p.code}?expectedVersionId=${id}`);
  assert.equal(result.status,409,JSON.stringify(result.data));assert.equal(result.data.error,'state_conflict');assert.equal(result.data.offer,undefined);
});

test('offer detail requires exact fixed query and genuine owner session while private system and missing codes remain unavailable',async t=>{
  const f=foundationFixture(t),p=await publishedOffer(f,202),env=ready(f),token=await session(f,env),participant=await session(f,env,101),id=capturedVersion(f,p.code).id;
  for(const path of [`offers/${p.code}`,`offers/${p.code}?expectedVersionId=0`,`offers/${p.code}?expectedVersionId=${id}&expectedVersionId=${id}`,
    `offers/${p.code}?expectedVersionId=${id}&actorId=900`,`offers/${p.code}?expectedVersionId=9007199254740993`]) assert.equal((await call(f,env,token,path)).status,400,path);
  assert.equal((await call(f,env,participant,`offers/${p.code}?expectedVersionId=${id}`)).status,404);
  assert.equal((await call(f,{...env,V141_ADMIN_MINI_APP_ENABLED:'false'},token,`offers/${p.code}?expectedVersionId=${id}`)).status,404);
  const missing=await call(f,env,token,`offers/missing_offer?expectedVersionId=${id}`),system=await call(f,env,token,`offers/bank_catalog?expectedVersionId=${id}`);
  assert.equal(missing.status,404);assert.equal(system.status,404);assert.deepEqual(system.data,missing.data);
});

test('canonical owner signed session loads actual core queues and private journal metadata with SELECT-only GET',async t=>{
  const f=foundationFixture(t),p=await publishedOffer(f,202),env=ready(f),token=await session(f,env);
  apply(f,303);
  f.sqlite.exec("INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,details) VALUES(900,'offer_review','offer','test','private-initData-token-body')");
  const before=f.binding.audit.length;
  const overview=await call(f,env,token,'overview');
  assert.equal(overview.status,200,JSON.stringify(overview.data));
  assert.equal(overview.data.counts.users,5);assert.equal(overview.data.counts.pendingPartners,1);assert.equal(overview.data.counts.approvedOffers,1);
  assert.equal(overview.data.authorization.capability,'admin.cabinet.open');
  const partners=await call(f,env,token,'partners?status=pending&limit=1&offset=0');
  assert.equal(partners.status,200,JSON.stringify(partners.data));assert.equal(partners.data.items[0].ageConfirmed,true);
  const offers=await call(f,env,token,'offers?status=all');
  assert.equal(offers.status,200,JSON.stringify(offers.data));assert.equal(offers.data.items[0].code,p.code);
  assert.equal(offers.data.items[0].expectedVersionId,f.sqlite.prepare('SELECT current_version_id FROM offer_visibility_rules WHERE offer_code=?').get(p.code).current_version_id);
  const journal=await call(f,env,token,'journal?limit=25');
  assert.equal(journal.status,200,JSON.stringify(journal.data));assert.equal(journal.data.items[0].actorLabel,'Вы');
  assert.equal(JSON.stringify(journal.data).includes('private-initData-token-body'),false);
  assert.ok(f.binding.audit.slice(before).every(row=>row.mode==='read'));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_atomic_guards').get().n,0);
});

test('admin route denies other accounts, another admin, disabled flag, expired session and source changes',async t=>{
  const f=foundationFixture(t),env=ready(f),ownerToken=await session(f,env);
  const participant=await session(f,env,101);
  assert.equal((await call(f,env,participant,'overview')).status,404);
  f.sqlite.exec("INSERT INTO user_roles(telegram_id,role,status) VALUES(101,'admin','active')");
  assert.equal((await call(f,env,participant,'partners')).status,404);
  assert.equal((await call(f,{...env,V141_ADMIN_MINI_APP_ENABLED:'false'},ownerToken,'overview')).status,404);
  f.sqlite.exec("UPDATE mini_app_sessions SET issued_at=issued_at-400,expires_at=expires_at-400 WHERE telegram_id=900");
  assert.equal((await call(f,env,ownerToken,'overview')).status,401);
  const fresh=await session(f,env);
  f.sqlite.exec('UPDATE mini_app_release_control SET revision=2');
  assert.notEqual((await call(f,env,fresh,'overview')).status,200);
});

test('partner review is a canonical atomic action with age guard, one history and duplicate receipt acknowledgment',async t=>{
  const f=foundationFixture(t),env=ready(f,{ownerOnly:true}),token=await session(f,env),id=Number(apply(f,303));
  const options={method:'POST',payload:{decision:'approve'},key:'admin_review_http_0001'};
  const approved=await call(f,env,token,`partners/${id}/review`,options);
  assert.equal(approved.status,200,JSON.stringify(approved.data));assert.equal(approved.data.commitStatus,'committed');
  assert.equal(approved.data.authorization.capability,'admin.partner.review');
  const duplicate=await call(f,env,token,`partners/${id}/review`,options);
  assert.equal(duplicate.status,200,JSON.stringify(duplicate.data));assert.equal(duplicate.data.commitStatus,'unchanged');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM partner_application_decisions WHERE application_id=?').get(id).n,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM partner_profiles WHERE telegram_id=303').get().n,1);
  const minor=Number(apply(f,404,false));
  const denied=await call(f,env,token,`partners/${minor}/review`,{method:'POST',payload:{decision:'approve'},key:'admin_review_minor_0001'});
  assert.notEqual(denied.status,200);assert.equal(f.sqlite.prepare('SELECT status FROM partner_applications WHERE id=?').get(minor).status,'pending');
  const forged=await call(f,env,token,`partners/${minor}/review`,{method:'POST',payload:{decision:'approve',actorId:900},key:'admin_review_forged_0001'});
  assert.equal(forged.status,400);
});

test('offer moderation and visibility use exact captured version and preserve content ownership',async t=>{
  const f=foundationFixture(t),p=await publishedOffer(f,202),env=ready(f,{ownerOnly:true}),token=await session(f,env);
  f.sqlite.prepare("UPDATE offer_visibility_rules SET moderation_status='pending',visibility='private',approved_version_id=NULL WHERE offer_code=?").run(p.code);
  const id=f.sqlite.prepare('SELECT current_version_id FROM offer_visibility_rules WHERE offer_code=?').get(p.code).current_version_id;
  const stale=await call(f,env,token,`offers/${p.code}/moderation`,{method:'POST',payload:{expectedVersionId:id+1000,decision:'approved'},key:'admin_offer_stale_0001'});
  assert.notEqual(stale.status,200);
  const approved=await call(f,env,token,`offers/${p.code}/moderation`,{method:'POST',payload:{expectedVersionId:id,decision:'approved'},key:'admin_offer_review_0001'});
  assert.equal(approved.status,200,JSON.stringify(approved.data));
  const visibility=await call(f,env,token,`offers/${p.code}/visibility`,{method:'POST',payload:{expectedVersionId:id,visibility:'public'},key:'admin_offer_visible_0001'});
  assert.equal(visibility.status,200,JSON.stringify(visibility.data));
  assert.equal(f.sqlite.prepare('SELECT title FROM offers WHERE code=?').get(p.code).title,'Проверенный оффер');
  assert.equal(f.sqlite.prepare('SELECT visibility FROM offer_visibility_rules WHERE offer_code=?').get(p.code).visibility,'public');
});

test('a late canonical data change rejects stale overview and late role removal rolls back a review',async t=>{
  const f=foundationFixture(t),env=ready(f),token=await session(f,env),id=Number(apply(f,303));
  let changed=false;
  const inject=({statements})=>{
    if(statements.length>0 && statements.every(row=>row.sql.startsWith('SELECT CASE WHEN') && row.sql.endsWith('AS valid'))) {
      changed=true;f.sqlite.exec("INSERT INTO users(telegram_id,referral_code,accepted_terms) VALUES(505,'late_user',1)");
    } else f.binding.beforeBatch=inject;
  };
  f.binding.beforeBatch=inject;
  const overview=await call(f,env,token,'overview');
  assert.equal(changed,true);assert.equal(overview.status,409,JSON.stringify(overview.data));assert.equal(overview.data.counts,undefined);
  const revoke=({statements})=>{
    if(statements.some(row=>row.sql.startsWith('INSERT INTO mini_app_command_receipts'))) f.sqlite.exec("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'");
    else f.binding.beforeBatch=revoke;
  };
  f.binding.beforeBatch=revoke;
  const denied=await call(f,env,token,`partners/${id}/review`,{method:'POST',payload:{decision:'approve'},key:'admin_review_race_0001'});
  assert.notEqual(denied.status,200);assert.equal(f.sqlite.prepare('SELECT status FROM partner_applications WHERE id=?').get(id).status,'pending');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM partner_profiles WHERE telegram_id=303').get().n,0);
});

test('admin route parser rejects arbitrary methods, targets, duplicate query fields and oversized pagination',()=>{
  const url=path=>'https://cabinet.example/api/v1.4.0/cabinet/admin/'+path;
  for(const path of ['overview?actorId=900','partners?limit=1&limit=2','offers?limit=999','partners?offset=-1','journal?status=pending','offers?status=anything']) {
    assert.throws(()=>resolveAdminCabinetRoute({method:'GET',url:url(path)}));
  }
  assert.throws(()=>resolveAdminCabinetRoute({method:'POST',url:url('users/900/role')}));
  assert.throws(()=>resolveAdminCabinetRoute({method:'POST',url:url('offers/test/moderation?actorId=900')}));
});

test('actual closed owner-only HTTP users/settings actions preserve target/version receipts and journal',async t=>{
  const f=foundationFixture(t),base=ready(f);
  f.sqlite.exec(`INSERT OR IGNORE INTO admin_safety_runtime_settings(id,updated_at) VALUES(1,unixepoch());
    INSERT OR IGNORE INTO ai_runtime_settings(id) VALUES(1);
    INSERT OR IGNORE INTO official_web_settings(id) VALUES(1);
    UPDATE mini_app_release_control SET state='closed',beta_enabled=0,owner_telegram_id=NULL,issued_at=NULL,expires_at=NULL`);
  const env={...base,V141_RELEASE_MODE:'owner_only',REBUILD_V140_OWNER_WINDOW:'false',ADMIN_MODERATION_ENABLED:'true'},token=await session(f,env);
  const users=await call(f,env,token,'users?query=101');
  assert.equal(users.status,200,JSON.stringify(users.data));assert.equal(users.data.items[0].telegramId,101);
  const blocked=await call(f,env,token,'users/101/moderation',{method:'POST',payload:{action:'block',targetTelegramId:101,
    expectedRevision:0,reason:'Повторный спам',confirmed:true},key:'admin_http_block_0001'});
  assert.equal(blocked.status,200,JSON.stringify(blocked.data));assert.equal(blocked.data.authorization.capability,'admin.user.moderation');
  const overview=await call(f,env,token,'overview');
  assert.equal(overview.status,200,JSON.stringify(overview.data));assert.equal(overview.data.counts.blockedUsers,1);
  assert.equal(f.sqlite.prepare('SELECT is_blocked FROM users WHERE telegram_id=101').get().is_blocked,0);
  const mismatched=await call(f,env,token,'users/303/moderation',{method:'POST',payload:{action:'block',targetTelegramId:404,
    expectedRevision:0,reason:'Другой человек',confirmed:true},key:'admin_http_wrong_target_0001'});
  assert.equal(mismatched.status,400);
  const settings=await call(f,env,token,'settings');
  assert.equal(settings.status,200,JSON.stringify(settings.data));
  const before=settings.data.items.find(item=>item.key==='ai_rollout_mode').value;
  const updated=await call(f,env,token,'settings',{method:'POST',payload:{action:'update_setting',key:'ai_rollout_mode',
    value:'off',expectedValue:before,confirmed:true},key:'admin_http_setting_0001'});
  assert.equal(updated.status,200,JSON.stringify(updated.data));assert.equal(updated.data.authorization.capability,'admin.settings.manage');
  const journal=await call(f,env,token,'journal');
  assert.equal(journal.status,200,JSON.stringify(journal.data));
  assert.ok(journal.data.items.some(item=>item.action==='admin_runtime_setting_updated'));
  assert.ok(journal.data.items.some(item=>item.action==='user_moderation_blocked'));
});

test('closed owner HTTP remote exposes genuine public readiness, persists all and refuses a blocked expansion while off still works',async t=>{
  const f=foundationFixture(t),base=ready(f,{ownerOnly:true});
  f.sqlite.exec(`INSERT OR IGNORE INTO ai_runtime_settings(id) VALUES(1);
    INSERT OR IGNORE INTO official_web_settings(id) VALUES(1);
    INSERT INTO partner_programs(code,name,allowed_domains,official_url,status)
      VALUES('remote_program','Remote program','remote.example','https://remote.example/official','active');
    INSERT INTO ai_source_snapshots(program_code,source_url,content_hash,excerpt,status)
      VALUES('remote_program','https://remote.example/official','synthetic-remote-source','Approved source','approved');`);
  const env={...base,AI:{run:async()=>{throw new Error('Remote must not invoke a provider');}}},token=await session(f,env);
  const settings=await call(f,env,token,'settings');
  assert.equal(settings.status,200,JSON.stringify(settings.data));
  assert.deepEqual(settings.data.publicEnablement,{providerConnected:true,activePrograms:1,approvedPrograms:1,ready:true,reasonCode:'ready'});
  assert.deepEqual(settings.data.items.find(item=>item.key==='ai_rollout_mode').allowedValues,['off','admin','all']);
  const payload=value=>({action:'update_setting',key:'ai_rollout_mode',value,expectedValue:value==='off'?'all':'admin',confirmed:true});
  const all=await call(f,env,token,'settings',{method:'POST',key:'admin_http_remote_all_0001',payload:payload('all')});
  assert.equal(all.status,200,JSON.stringify(all.data));assert.equal(all.data.value,'all');
  assert.equal(all.data.authorization.allowed,true);
  assert.equal((await call(f,env,token,'settings')).data.items.find(item=>item.key==='ai_rollout_mode').value,'all');
  f.sqlite.exec("UPDATE ai_source_snapshots SET status='stale'");
  const blockedRead=await call(f,env,token,'settings');
  assert.equal(blockedRead.data.publicEnablement.ready,false);assert.equal(blockedRead.data.publicEnablement.reasonCode,'sources_not_approved');
  const off=await call(f,env,token,'settings',{method:'POST',key:'admin_http_remote_off_0001',payload:payload('off')});
  assert.equal(off.status,200,JSON.stringify(off.data));assert.equal(off.data.value,'off');
  const blocked=await call(f,env,token,'settings',{method:'POST',key:'admin_http_remote_blocked_0001',payload:{...payload('all'),expectedValue:'off'}});
  assert.equal(blocked.status,403,JSON.stringify(blocked.data));assert.equal(blocked.data.authorization.allowed,false);
  assert.equal(f.sqlite.prepare('SELECT rollout_mode FROM ai_runtime_settings WHERE id=1').get().rollout_mode,'off');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_command_receipts').get().n,2);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ai_operation_journal').get().n,0);
  assert.deepEqual({...f.sqlite.prepare('SELECT state,beta_enabled FROM mini_app_release_control').get()},{state:'closed',beta_enabled:0});
});

test('unavailable support binding fails only its section, while fixed support paths and keys stay bounded',async t=>{
  const f=foundationFixture(t),env=ready(f),token=await session(f,env);
  const support=await call(f,env,token,'support');
  assert.equal(support.status,503);assert.equal(support.data.error,'unavailable');
  assert.equal((await call(f,env,token,'overview')).status,200);
  assert.equal((await call(f,env,token,'support/tickets/1?beforeMessageId=NaN')).status,400);
  assert.equal((await call(f,env,token,'support?status=anything')).status,400);
  const reply=await call(f,env,token,'support/tickets/1/reply',{method:'POST',key:'admin_support_key_header',
    payload:{text:'Ответ специалиста',expectedLastMessageId:null,idempotencyKey:'admin_support_different_key'}});
  assert.equal(reply.status,400);
});

const supportEnvironment=async(t,f)=>{
  const base=ready(f),support=await createAdminSupportFixture(t,{ownerId:900,sourceSha:base.REBUILD_V140_RC_SHA,now:f.now});
  f.sqlite.exec("UPDATE mini_app_release_control SET state='closed',beta_enabled=0,owner_telegram_id=NULL,issued_at=NULL,expires_at=NULL");
  const env={...base,V141_RELEASE_MODE:'owner_only',REBUILD_V140_OWNER_WINDOW:'false',V141_SOURCE_SHA:base.REBUILD_V140_RC_SHA,
    ADMIN_SUPPORT:support.binding,V141_ADMIN_SUPPORT_CANDIDATE_SHA:base.REBUILD_V140_RC_SHA,V141_ADMIN_SUPPORT_BRIDGE_KEY:support.configuration.key};
  return {env,support,token:await session(f,env)};
};

test('owner pagination stays bounded and consistent with 1000 fictional users offers and support tickets',async t=>{
  const f=foundationFixture(t),partner=await publishedOffer(f,202),{env,support,token}=await supportEnvironment(t,f);
  const previous=capturedVersion(f,partner.code),source=JSON.parse(previous.snapshot_json),seededOffers=[];
  const userInsert=f.sqlite.prepare("INSERT INTO users(telegram_id,referral_code,accepted_terms) VALUES(?,?,1)");
  const roleInsert=f.sqlite.prepare("INSERT INTO user_roles(telegram_id,role,status) VALUES(?,'user','active'),(?,'partner','active')");
  const applicationInsert=f.sqlite.prepare(`INSERT INTO partner_applications(telegram_id,display_name,contact,age_confirmed,status)
    VALUES(?,?,'@offline_scale',1,'approved')`);
  const profileInsert=f.sqlite.prepare(`INSERT INTO partner_profiles(telegram_id,application_id,display_name,telegram_username,contact,status,approved_by)
    VALUES(?,?,?,?,'@offline_scale','active',900)`);
  const approvalInsert=f.sqlite.prepare(`INSERT INTO partner_application_decisions(application_id,decision,actor_id,actor_role,event_key)
    VALUES(?,'approved',900,'admin',?)`);
  const betaInsert=f.sqlite.prepare('INSERT INTO partner_beta_access(partner_profile_id,granted_by) VALUES(?,900)');
  const routeSelection=f.sqlite.prepare('INSERT INTO partner_offer_links(offer_code,partner_link_id,selected_by) VALUES(?,?,?)');
  const blockInsert=f.sqlite.prepare(`INSERT INTO user_moderation_blocks(target_telegram_id,status,reason,blocked_by,blocked_at,revision)
    VALUES(?,'active','Синтетический спам',900,?,1)`);
  const blockEvent=f.sqlite.prepare(`INSERT INTO user_moderation_events(event_key,target_telegram_id,actor_telegram_id,action,reason,resulting_revision,created_at)
    VALUES(?, ?,900,'block','Синтетический спам',1,?)`);
  const offerInsert=f.sqlite.prepare(`INSERT INTO offers(code,button_text,title,description,provider,category,payout_text,required_action,
    min_age,max_age,geo,hold_days,traffic_sources,source_name,starts_at,expires_at,status,updated_at)
    SELECT ?,button_text,?,description,provider,category,payout_text,required_action,min_age,max_age,geo,hold_days,
      traffic_sources,source_name,starts_at,expires_at,status,? FROM offers WHERE code=?`);
  const ownerInsert=f.sqlite.prepare("INSERT INTO offer_owners(offer_code,owner_kind,partner_profile_id,created_by,updated_by) VALUES(?,'partner',?,?,?)");
  const versionInsert=f.sqlite.prepare(`INSERT INTO offer_versions(offer_code,version_number,snapshot_schema_version,snapshot_json,business_status,content_hash,created_by)
    VALUES(?,1,1,?,'active',?,?)`);
  const ruleInsert=f.sqlite.prepare(`INSERT INTO offer_visibility_rules(offer_code,moderation_status,visibility,current_version_id,submitted_version_id,updated_by)
    VALUES(?,?,'private',?,?,?)`);
  f.sqlite.exec('BEGIN');
  for(let i=0;i<1000;i++) {
    const telegramId=10000+i,code='scale_'+String(i).padStart(4,'0'),title='Синтетический оффер '+i,
      updatedAt='2026-08-01 00:00:0'+i%7,moderationStatus=i%2?'not_submitted':'pending';
    userInsert.run(telegramId,'scale_user_'+i);roleInsert.run(telegramId,telegramId);
    const displayName='Синтетический партнёр '+i,applicationId=Number(applicationInsert.run(telegramId,displayName).lastInsertRowid),
      profileId=Number(profileInsert.run(telegramId,applicationId,displayName,'scale_partner_'+i).lastInsertRowid);
    approvalInsert.run(applicationId,'scale_partner_approval_'+i);betaInsert.run(profileId);
    const linkId=f.seedRoute(profileId),link=f.sqlite.prepare('SELECT tracking_key,updated_at FROM partner_links WHERE id=?').get(linkId);
    if(i%10===0) {blockInsert.run(telegramId,f.now);blockEvent.run('scale_user_block_'+i,telegramId,f.now);}
    offerInsert.run(code,title,updatedAt,partner.code);ownerInsert.run(code,profileId,telegramId,telegramId);routeSelection.run(code,linkId,telegramId);
    const json=JSON.stringify({...source,code,title,partner_link_id:linkId,partner_link_tracking_key:link.tracking_key,partner_link_updated_at:link.updated_at}),
      id=Number(versionInsert.run(code,json,'sha256:'+await sha256Hex(json),telegramId).lastInsertRowid);
    ruleInsert.run(code,moderationStatus,id,moderationStatus==='pending'?id:null,telegramId);
    seededOffers.push({code,updatedAt,moderationStatus});
  }
  f.sqlite.exec("UPDATE partner_profiles SET telegram_username='scale_partner' WHERE telegram_id=202; "+
    'UPDATE partner_beta_settings SET enabled=0,private_offers_enabled=0,submissions_enabled=0,public_visibility_enabled=0; COMMIT');
  const seededTickets=[];
  const ticketUpdate=support.sqlite.prepare('UPDATE support_tickets SET status=?,created_at=?,updated_at=?,closed_at=? WHERE id=?');
  const messageUpdate=support.sqlite.prepare('UPDATE support_messages SET created_at=? WHERE id=?');
  support.sqlite.exec('BEGIN');
  for(let i=0;i<1000;i++) {
    const ticket=support.seedTicket(10000+i,'Синтетическое обращение '+i),status=['open','waiting','closed'][i%3],updatedAt=f.now-i%7;
    ticketUpdate.run(status,f.now-20,updatedAt,status==='closed'?updatedAt:null,ticket.ticketId);
    messageUpdate.run(f.now-10,ticket.lastMessageId);seededTickets.push({ticketId:ticket.ticketId,status,updatedAt});
  }
  support.sqlite.exec('COMMIT');
  const before=f.binding.audit.length;
  const get=async path=>{
    const result=await call(f,env,token,path);assert.equal(result.status,200,JSON.stringify(result.data));
    assert.equal(result.data.authorization.capability,'admin.cabinet.open');assert.equal(result.data.authorization.allowed,true);
    return result.data;
  };
  const verifyPage=(result,expected,total,offset,key)=>{
    assert.equal(result.total,total);assert.equal(result.limit,20);assert.equal(result.offset,offset);
    assert.deepEqual(result.items.map(item=>item[key]),expected.slice(offset,offset+20));
    assert.equal(result.hasMore,offset+result.items.length<total);assert.ok(result.items.length<=20);
  };
  const userIds=Array.from({length:1000},(_,i)=>10999-i).concat([900,404,303,202,101]);
  verifyPage(await get('users'),userIds,1005,0,'telegramId');
  verifyPage(await get('users?offset=20'),userIds,1005,20,'telegramId');
  verifyPage(await get('users?offset=1000'),userIds,1005,1000,'telegramId');
  const blockedIds=Array.from({length:100},(_,i)=>10990-i*10),blocked=await get('users?status=blocked&offset=20');
  verifyPage(blocked,blockedIds,100,20,'telegramId');assert.ok(blocked.items.every(item=>item.isBlocked&&item.moderation.revision===1));
  const byId=await get('users?query=10042');verifyPage(byId,[10042],1,0,'telegramId');
  verifyPage(await get('users?query=%40ScAlE_PaRtNeR'),[202],1,0,'telegramId');
  verifyPage(await get('users?query=100'),[],0,0,'telegramId');
  const baseUpdated=f.sqlite.prepare('SELECT updated_at FROM offers WHERE code=?').get(partner.code).updated_at;
  const allOffers=[...seededOffers,{code:partner.code,updatedAt:baseUpdated,moderationStatus:'approved'}].sort((a,b)=>
    b.updatedAt.localeCompare(a.updatedAt)||a.code.localeCompare(b.code));
  const allCodes=allOffers.map(item=>item.code),pendingCodes=allOffers.filter(item=>item.moderationStatus==='pending').map(item=>item.code);
  const firstOffers=await get('offers?status=all');verifyPage(firstOffers,allCodes,1001,0,'code');
  verifyPage(await get('offers?status=all&offset=20'),allCodes,1001,20,'code');
  verifyPage(await get('offers?status=all&offset=1000'),allCodes,1001,1000,'code');
  const pending=await get('offers?status=pending&offset=20');verifyPage(pending,pendingCodes,500,20,'code');
  assert.ok(pending.items.every(item=>item.moderationStatus==='pending'&&Number.isSafeInteger(item.expectedVersionId)&&!item.publicVisibilityEnabled));
  const detail=await get(`offers/${pending.items[0].code}?expectedVersionId=${pending.items[0].expectedVersionId}`);
  assert.equal(detail.offer.code,pending.items[0].code);assert.equal(detail.offer.description,source.description);assert.equal(detail.offer.publicVisibilityEnabled,false);
  const ticketIds=status=>seededTickets.filter(item=>item.status===status).sort((a,b)=>b.updatedAt-a.updatedAt||b.ticketId-a.ticketId).map(item=>item.ticketId);
  const open=ticketIds('open');verifyPage(await get('support'),open,334,0,'ticketId');
  verifyPage(await get('support?offset=20'),open,334,20,'ticketId');
  verifyPage(await get('support?offset=320'),open,334,320,'ticketId');
  const waiting=await get('support?status=waiting');verifyPage(waiting,ticketIds('waiting'),333,0,'ticketId');
  assert.ok(waiting.items.every(item=>item.status==='waiting'&&item.pendingMessages===1));
  const overview=await get('overview');assert.equal(overview.counts.users,1005);assert.equal(overview.counts.blockedUsers,100);
  assert.equal(overview.counts.pendingOffers,500);assert.equal(overview.counts.approvedOffers,1);assert.equal(overview.release.partnerBetaEnabled,false);
  for(const section of ['users','offers','support']) {
    const page25=await get(section+'?limit=25'+(section==='offers'?'&status=all':''));assert.equal(page25.items.length,25);assert.equal(page25.limit,25);
    assert.equal((await call(f,env,token,section+'?limit=26')).status,400);
  }
  assert.equal((await call(f,env,token,'support?offset=1001')).status,400);
  assert.ok(f.binding.audit.slice(before).every(item=>item.mode==='read'));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_atomic_guards').get().n,0);
  assert.equal(support.sqlite.prepare('SELECT COUNT(*) n FROM support_admin_commands').get().n,0);
  assert.equal(support.sqlite.prepare('SELECT COUNT(*) n FROM support_outbox').get().n,0);
});

test('actual main HTTP and signed support Worker compose real queues, reply receipt, delivery and close without fake Telegram updates',async t=>{
  const f=foundationFixture(t),{env,support,token}=await supportEnvironment(t,f),ticket=support.seedTicket(101);
  const list=await call(f,env,token,'support?status=open');
  assert.equal(list.status,200,JSON.stringify(list.data));assert.equal(list.data.items[0].ticketId,ticket.ticketId);
  const detail=await call(f,env,token,`support/tickets/${ticket.ticketId}?beforeMessageId=0&limit=20`);
  assert.equal(detail.status,200,JSON.stringify(detail.data));assert.equal(detail.data.messages[0].text,'Нужна помощь');
  const bad=await call(f,env,token,`support/tickets/${ticket.ticketId}/reply`,{method:'POST',key:'support_http_forged_actor_0001',
    payload:{text:'Неправильный запрос',expectedLastMessageId:ticket.lastMessageId,actorId:900}});
  assert.equal(bad.status,400);
  const options={method:'POST',key:'support_http_reply_exact_0001',payload:{text:'Поможем решить вопрос',expectedLastMessageId:ticket.lastMessageId}};
  const saved=await call(f,env,token,`support/tickets/${ticket.ticketId}/reply`,options);
  assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.commitStatus,'committed');
  assert.equal(saved.data.receiptStatus,'completed');assert.equal(saved.data.deliveryState,'queued');
  assert.equal(saved.data.authorization.capability,'admin.cabinet.open');
  const duplicate=await call(f,env,token,`support/tickets/${ticket.ticketId}/reply`,options);
  assert.equal(duplicate.status,200,JSON.stringify(duplicate.data));assert.equal(duplicate.data.commitStatus,'unchanged');
  assert.equal(support.sqlite.prepare("SELECT COUNT(*) n FROM support_messages WHERE direction='staff'").get().n,1);
  assert.equal(support.sqlite.prepare('SELECT COUNT(*) n FROM support_outbox').get().n,1);
  assert.equal(support.sqlite.prepare('SELECT COUNT(*) n FROM support_updates').get().n,0);
  let sent=0;
  // Drain the user reply; its genuine worker also queues a separate owner
  // delivery notice, which is outside this history/receipt assertion.
  await support.worker.drainOutbox(support.env,Math.floor(Date.now()/1000),async()=>{sent++;return {state:'sent',result:{message_id:77}};},1);
  assert.equal(sent,1);
  const fresh=await call(f,env,token,`support/tickets/${ticket.ticketId}`);
  assert.equal(fresh.status,200);assert.equal(fresh.data.messages.at(-1).deliveryState,'sent');
  const closed=await call(f,env,token,`support/tickets/${ticket.ticketId}/close`,{method:'POST',key:'support_http_close_exact_0001',
    payload:{expectedLastMessageId:fresh.data.ticket.lastMessageId}});
  assert.equal(closed.status,200,JSON.stringify(closed.data));assert.equal(closed.data.receiptStatus,'completed');
  assert.equal(support.sqlite.prepare('SELECT status FROM support_tickets WHERE id=?').get(ticket.ticketId).status,'closed');
  // A legitimate read authorization is not a permit for a different action.
  const params={status:'open',limit:20,offset:0};
  const context=await createCabinetCustomerContext({binding:f.binding,env,sessionToken:token,
    sessionScope:{candidateSha:env.REBUILD_V140_RC_SHA,revision:1},channel:'mini_app',operation:'admin.cabinet.open',
    requestPayload:{supportAction:'list',supportParams:params},nowSeconds:f.now});
  const authorization=await createRuntimeAuthorizer().authorize(context,{kind:'admin_surface',key:'cabinet'});
  await assert.rejects(callAdminSupportBridge({env,authorization,action:'close',params:{ticketId:ticket.ticketId,
    expectedLastMessageId:fresh.data.ticket.lastMessageId,idempotencyKey:'support_repurpose_read_0001'}}),/admin_required/u);
});

for(const revoke of ['role','epoch']) test('remote support commit followed by main '+revoke+' revoke reports unknown instead of a false rejection',async t=>{
  const f=foundationFixture(t),{env,support,token}=await supportEnvironment(t,f),ticket=support.seedTicket(101);
  const forwarded={...env,ADMIN_SUPPORT:{fetch:async request=>{
    const response=await support.binding.fetch(request);
    f.sqlite.exec(revoke==='role'?"UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'":
      'UPDATE mini_app_release_control SET revision=revision+1');
    return response;
  }}};
  const result=await call(f,forwarded,token,`support/tickets/${ticket.ticketId}/reply`,{method:'POST',key:'support_http_postcommit_'+revoke,
    payload:{text:'Этот ответ сохранён до изменения доступа',expectedLastMessageId:ticket.lastMessageId}});
  assert.equal(result.status,503,JSON.stringify(result.data));assert.equal(result.data.commitStatus,undefined);
  assert.equal(support.sqlite.prepare("SELECT COUNT(*) n FROM support_messages WHERE direction='staff'").get().n,1);
  assert.equal(support.sqlite.prepare('SELECT COUNT(*) n FROM support_outbox').get().n,1);
  assert.equal(support.sqlite.prepare("SELECT state FROM support_admin_commands").get().state,'accepted');
});
