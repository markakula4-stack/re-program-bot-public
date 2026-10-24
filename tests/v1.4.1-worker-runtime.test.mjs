import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../src/v1.4.0-rebuild/worker-entrypoint.mjs';
import {foundationFixture,signedInitData} from './helpers/v1.4.1-fixtures.mjs';
import {approvedPartner,publishedOffer,ORIGIN} from './helpers/v1.4.0-rebuild-sqlite.mjs';
import {drainRebuildOutbox} from '../src/v1.4.0-rebuild/effect-outbox.mjs';
import {V141_WORKER_RUNTIME_KEY} from '../src/v1.4.1/worker-runtime.mjs';
import {readTrustedContext} from '../src/v1.4.1/trusted-context.mjs';
import {runtimeContext} from '../src/v1.4.1/runtime-binding.mjs';

function ready(f,id=101) {
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  const sha='a'.repeat(40),issued=f.now-1,expires=f.now+600;
  f.sqlite.prepare(`INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,
    owner_telegram_id,issued_at,expires_at,updated_at) VALUES(1,?,1,'open',1,?,?,?,?)`).run(sha,id,issued,expires,f.now);
  return {...f.serverEnv,V141_AUTHORIZATION_ENABLED:'true',REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',
    REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',REBUILD_V140_RC_SHA:sha,REBUILD_V140_RELEASE_REVISION:'1',
    REBUILD_V140_OWNER_TELEGRAM_ID:String(id),REBUILD_V140_OWNER_WINDOW:`true:${issued}:${expires}`,
    WEBHOOK_SECRET:'synthetic-p04-worker-secret'};
}
async function call(env,path,{token,payload,key='p04_actual_worker_operation'}={}) {
  const response=await worker.fetch(new Request(ORIGIN+'/api/v1.4.0/cabinet/'+path,{
    method:payload===undefined?'GET':'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json',
      'Idempotency-Key':key,...(token?{Authorization:'Bearer '+token}:{})},
    ...(payload===undefined?{}:{body:JSON.stringify(payload)})}),env,{});
  return {status:response.status,data:await response.json()};
}
function webhook(f,env,id,updateId,text='/start') {
  const update={update_id:updateId,message:{date:f.now,from:{id,is_bot:false},chat:{id,type:'private'},text}};
  const claim='synthetic-p04-worker-claim-'+updateId;
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,claim_token,received_at,lease_expires_at)
    VALUES(?,'message',?,?,?,?)`).run(updateId,id,claim,f.now,f.now+120);
  return {update,receiptClaimToken:claim,request:new Request(ORIGIN+'/webhook',{method:'POST',headers:{
    'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET},body:JSON.stringify(update)})};
}
test('actual Worker HTTP entry commits one own offer, replays once, and enforces the next Free slot',async t=>{
  const f=foundationFixture(t),p=await approvedPartner(f,202);
  f.sqlite.prepare(`INSERT INTO partner_legal_profiles(partner_profile_id,profile_kind,verification_state,
    revision,declared_by,declared_at,updated_at) VALUES(?,'individual','self_declared',1,202,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run(p.profileId);
  const env=ready(f,202),s=await call(env,'session',{payload:{initData:signedInitData(202,f.now)}});
  assert.equal(s.status,200,JSON.stringify(s.data));const token=s.data.sessionToken;
  const first=await call(env,'offers',{token,payload:{},key:'p04_actual_worker_create_fixed'});
  assert.equal(first.status,200,JSON.stringify(first.data));
  const replay=await call(env,'offers',{token,payload:{},key:'p04_actual_worker_create_fixed'});
  assert.equal(replay.status,200,JSON.stringify(replay.data));assert.equal(replay.data.offerCode,first.data.offerCode);
  const denied=await call(env,'offers',{token,payload:{},key:'p04_actual_worker_next_create'});
  assert.equal(denied.status,403);assert.equal(denied.data.error,'quota_exceeded');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM entitlement_decision_audit WHERE capability='offer.create_private'").get().n,1);
});
test('verified webhook account adapter creates only ordinary Free role and request wrappers cannot broaden configuration',async t=>{
  const f=foundationFixture(t),env=ready(f),runtime=globalThis[V141_WORKER_RUNTIME_KEY];
  const transport=webhook(f,env,555,90001);
  const scoped=await runtime.enterTelegram({env,...transport});
  const result=await runtime.registerAccount(scoped,555,null);
  assert.equal(result.isNew,true);assert.equal(result.user.telegram_id,555);
  assert.deepEqual(f.sqlite.prepare('SELECT role,status FROM user_roles WHERE telegram_id=555').all().map(r=>({...r})),[{role:'user',status:'active'}]);
  assert.equal(f.sqlite.prepare('SELECT access_tier FROM user_access WHERE telegram_id=555').get().access_tier,'free');
  const narrow=runtime.inherit(scoped,{...scoped,AI_PARTNER_EXTERNAL_PROVIDER_ENABLED:'false'});
  assert.equal(readTrustedContext(runtimeContext(narrow)).env.AI_PARTNER_EXTERNAL_PROVIDER_ENABLED,'false');
  assert.throws(()=>runtime.inherit(scoped,{...scoped,OWNER_TELEGRAM_ID:'555'}),/runtime_binding_changed/u);
});
test('captured actual flow cancellation invalidates a later stale edit before any domain effect',async t=>{
  const f=foundationFixture(t),env=ready(f),runtime=globalThis[V141_WORKER_RUNTIME_KEY];
  f.sqlite.exec("INSERT INTO partner_sessions(telegram_id,action,step,payload_json) VALUES(101,'edit_partner_offer','title','{}')");
  const scoped=await runtime.enterTelegram({env,...webhook(f,env,101,90002)});
  assert.equal((await runtime.readFlow(scoped,101,'partner')).action,'edit_partner_offer');
  f.sqlite.exec('DELETE FROM partner_sessions WHERE telegram_id=101');
  await assert.rejects(runtime.legacy(scoped,101,'ai.memory.clear_own',{}));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_command_receipts').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM entitlement_decision_audit').get().n,0);
});
test('actual outbox maintenance durably claims one canonical notification before its sole send',async t=>{
  const f=foundationFixture(t),offer=await publishedOffer(f),env={...ready(f),REBUILD_V140_EFFECTS_ENABLED:'true',REBUILD_V140_ADMIN_ACCESS_ENABLED:'false'};
  const s=await call(env,'session',{payload:{initData:signedInitData(101,f.now)}});
  const created=await call(env,'applications',{token:s.data.sessionToken,payload:{offerCode:offer.code}});
  assert.equal(created.status,200,JSON.stringify(created.data));let sends=0;
  const fetchImpl=async()=>{
    sends++;
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM mini_app_effect_claims WHERE delivery_state='attempted'").get().n,1);
    return Response.json({ok:true,result:{message_id:77}});
  };
  await drainRebuildOutbox(env,{fetchImpl});await drainRebuildOutbox(env,{fetchImpl});
  assert.equal(sends,1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM mini_app_effect_claims WHERE delivery_state='delivered'").get().n,1);
});
