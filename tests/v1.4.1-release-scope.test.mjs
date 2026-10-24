import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {foundationFixture,signedInitData} from './helpers/v1.4.1-fixtures.mjs';
import {ORIGIN} from './helpers/v1.4.0-rebuild-sqlite.mjs';
import {createCabinetHttp} from '../src/v1.4.0-rebuild/cabinet-http.mjs';
import {createTelegramCabinet} from '../src/v1.4.0-rebuild/telegram-cabinet.mjs';
import {scopeV141ReleaseActor} from '../src/v1.4.1/release-scope.mjs';
import {resolveTelegramHandler} from '../src/v1.4.1/handler-registry.mjs';

function setup(t,{runtimeSchema=false}={}) {
  const f=foundationFixture(t),candidate='a'.repeat(40),issued=f.now-1,expires=f.now+600;
  if(runtimeSchema) f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  f.sqlite.prepare(`INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,
    owner_telegram_id,issued_at,expires_at,updated_at) VALUES(1,?,1,'open',1,101,?,?,?)`).run(candidate,issued,expires,f.now);
  const env={...f.serverEnv,V141_RELEASE_MODE:'owner_only',V141_AUTHORIZATION_ENABLED:'true',
    V141_LEGACY_COMPATIBILITY_ENABLED:'true',REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',
    REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',REBUILD_V140_RC_SHA:candidate,REBUILD_V140_RELEASE_REVISION:'1',
    REBUILD_V140_OWNER_TELEGRAM_ID:'101',REBUILD_V140_OWNER_WINDOW:`true:${issued}:${expires}`,
    REBUILD_V140_TELEGRAM_ENABLED:'true',WEBHOOK_SECRET:'synthetic-owner-release-webhook-secret'};
  const calls=[];
  const http=createCabinetHttp({clock:()=>f.now,repositoryFactory:(scoped,options)=>{
    calls.push({env:scoped,readOnly:options.readOnly});return f.repositoryFactory(scoped,options);
  }});
  const call=async(path,{token,payload,key='p06_owner_scope_fixed'}={})=>{
    const response=await http(new Request(ORIGIN+'/api/v1.4.0/cabinet/'+path,{
      method:payload===undefined?'GET':'POST',headers:{...(payload===undefined?{}:{Origin:ORIGIN,
        'Content-Type':'application/json','Idempotency-Key':key}),...(token?{Authorization:'Bearer '+token}:{})},
      ...(payload===undefined?{}:{body:JSON.stringify(payload)})}),env);
    return {status:response.status,data:await response.json()};
  };
  return {...f,env,calls,call};
}

test('release scope only narrows server flags and cannot create owner authority',()=>{
  const env={ADMIN_ID:'900',OWNER_TELEGRAM_ID:'900',V141_RELEASE_MODE:'owner_only',
    V141_AUTHORIZATION_ENABLED:'true',V141_LEGACY_COMPATIBILITY_ENABLED:'true'};
  assert.equal(scopeV141ReleaseActor(env,{telegramId:900}),env);
  for(const actor of [101,null,{id:900},{telegramId:'900'}]) {
    const scoped=scopeV141ReleaseActor(env,actor);
    assert.equal(scoped.V141_AUTHORIZATION_ENABLED,'false');assert.equal(scoped.V141_LEGACY_COMPATIBILITY_ENABLED,'false');
    assert.equal(scoped.ADMIN_ID,'900');assert.equal(scoped.OWNER_TELEGRAM_ID,'900');
  }
  assert.equal(env.V141_AUTHORIZATION_ENABLED,'true');
  assert.equal(scopeV141ReleaseActor({...env,V141_AUTHORIZATION_ENABLED:'false'},900).V141_AUTHORIZATION_ENABLED,'false');
  assert.equal(scopeV141ReleaseActor({...env,OWNER_TELEGRAM_ID:'101'},900).V141_AUTHORIZATION_ENABLED,'false');
  assert.equal(scopeV141ReleaseActor({...env,V141_RELEASE_MODE:'default_off'},900).V141_AUTHORIZATION_ENABLED,'false');
  assert.equal(scopeV141ReleaseActor({...env,V141_RELEASE_MODE:'enabled'},101).V141_AUTHORIZATION_ENABLED,'true');
  assert.throws(()=>scopeV141ReleaseActor({...env,V141_RELEASE_MODE:'invented'},900),/v141_release_scope_invalid/u);
});

test('actual nonowner initData scopes session registration before opening a repository and keeps accepted writes available',async t=>{
  const f=setup(t);
  const opened=await f.call('session',{payload:{initData:signedInitData(101,f.now)}});
  assert.equal(opened.status,200,JSON.stringify(opened.data));assert.equal(opened.data.authorizationVersion,undefined);
  assert.equal(opened.data.features.mutationsEnabled,true);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].env.V141_AUTHORIZATION_ENABLED,'false');
  assert.equal(f.calls[0].env.V141_LEGACY_COMPATIBILITY_ENABLED,'false');
  const applied=await f.call('partner/application',{token:opened.data.sessionToken,
    payload:{displayName:'Тест',contact:'@synthetic',ageConfirmed:true}});
  assert.equal(applied.status,200,JSON.stringify(applied.data));assert.equal(applied.data.authorization,undefined);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM partner_applications WHERE telegram_id=101').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM entitlement_decision_audit').get().n,0);
  assert.deepEqual(f.sqlite.prepare('SELECT role FROM user_roles WHERE telegram_id=101').all().map(r=>r.role),['user']);
  assert.equal(f.env.V141_AUTHORIZATION_ENABLED,'true');
});

test('actual bearer authentication rebuilds the request repository with nonowner scope before service construction',async t=>{
  const f=setup(t),opened=await f.call('session',{payload:{initData:signedInitData(101,f.now)}});
  assert.equal(opened.status,200,JSON.stringify(opened.data));f.calls.length=0;
  const profile=await f.call('profile',{token:opened.data.sessionToken});
  assert.equal(profile.status,200,JSON.stringify(profile.data));assert.equal(profile.data.authorization,undefined);
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].env.V141_AUTHORIZATION_ENABLED,'true');
  assert.equal(f.calls[1].env.V141_AUTHORIZATION_ENABLED,'false');assert.equal(f.calls[1].readOnly,true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM entitlement_decision_audit').get().n,0);
});

test('invalid initData and an owner ID in raw session body cannot choose the owner scope',async t=>{
  const f=setup(t),before=f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_sessions').get().n;
  const signed=signedInitData(900,f.now),forged=signed.replace(/hash=[a-f0-9]+/u,'hash='+'0'.repeat(64));
  assert.notEqual(forged,signed);
  const bad=await f.call('session',{payload:{initData:forged}});assert.equal(bad.status,401);
  const body=await f.call('session',{payload:{initData:signedInitData(101,f.now),telegramId:900}});
  assert.equal(body.status,400);assert.equal(f.calls.length,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_sessions').get().n,before);
});

test('verified canonical owner keeps runtime authority and permanent access, while loss of the actual role denies',async t=>{
  const f=setup(t,{runtimeSchema:true});
  f.env.REBUILD_V140_OWNER_WINDOW='false';f.env.REBUILD_V140_OWNER_TELEGRAM_ID='0';
  f.sqlite.prepare("UPDATE mini_app_release_control SET state='closed',beta_enabled=0,owner_telegram_id=NULL,issued_at=NULL,expires_at=NULL").run();
  const opened=await f.call('session',{payload:{initData:signedInitData(900,f.now)}});
  assert.equal(opened.status,200,JSON.stringify(opened.data));assert.equal(opened.data.authorizationVersion,1);
  assert.equal(opened.data.features.mutationsEnabled,true);assert.equal(f.calls[0].env,f.env);
  const profile=await f.call('profile',{token:opened.data.sessionToken});
  assert.equal(profile.status,200,JSON.stringify(profile.data));assert.equal(profile.data.systemRole,'admin');
  assert.equal(profile.data.authorization.allowed,true);
  f.sqlite.prepare("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'").run();
  const denied=await f.call('profile',{token:opened.data.sessionToken});assert.ok([403,503].includes(denied.status));
  assert.equal(denied.data.authorization,undefined);
});

test('both cabinet command spellings reach the same actual verified permanent-owner cabinet',async t=>{
  const f=setup(t,{runtimeSchema:true}),delivered=[];
  f.env.REBUILD_V140_OWNER_WINDOW='false';f.env.REBUILD_V140_OWNER_TELEGRAM_ID='0';
  f.sqlite.prepare("UPDATE mini_app_release_control SET state='closed',beta_enabled=0,owner_telegram_id=NULL,issued_at=NULL,expires_at=NULL").run();
  const cabinet=createTelegramCabinet({clock:()=>f.now,fetchImpl:async(url,init)=>{
    delivered.push(JSON.parse(init.body));return Response.json({ok:true});
  }});
  let updateId=1_416_100;
  for(const text of ['/cabinet_admin','/cabine_admin@RE_Program_Bot']) {
    assert.equal(resolveTelegramHandler({message:{text}}).capability,'admin.cabinet.open');
    const update={update_id:++updateId,message:{date:f.now,from:{id:900,is_bot:false},chat:{id:900,type:'private'},text}};
    const result=await cabinet(new Request(ORIGIN+'/webhook',{method:'POST',headers:{'Content-Type':'application/json',
      'X-Telegram-Bot-Api-Secret-Token':f.env.WEBHOOK_SECRET},body:JSON.stringify(update)}),f.env);
    assert.equal(result.response.status,200);
  }
  assert.equal(delivered.length,2);assert.equal(delivered[0].chat_id,900);
  assert.equal(delivered[0].text,delivered[1].text);assert.match(delivered[0].text,/Кабинет · модерация/u);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM telegram_update_receipts WHERE status='completed'").get().n,2);
});

test('claimed nonowner cabinet transport narrows both switches before runtime creation, without needing new runtime schema',async t=>{
  const f=setup(t),delivered=[],scopes=[];
  const cabinet=createTelegramCabinet({clock:()=>f.now,repositoryFactory:(env,options)=>{
    scopes.push(env);return f.repositoryFactory(env,options);
  },fetchImpl:async(url,init)=>{delivered.push(JSON.parse(init.body));return Response.json({ok:true});}});
  const update={update_id:1_416_200,message:{date:f.now,from:{id:101,is_bot:false},chat:{id:101,type:'private'},text:'/cabinet'}};
  const result=await cabinet(new Request(ORIGIN+'/webhook',{method:'POST',headers:{'Content-Type':'application/json',
    'X-Telegram-Bot-Api-Secret-Token':f.env.WEBHOOK_SECRET},body:JSON.stringify(update)}),f.env);
  assert.equal(result.response.status,200);assert.equal(scopes.length,2);
  assert.equal(scopes[0].V141_AUTHORIZATION_ENABLED,'true');assert.equal(scopes[1].V141_AUTHORIZATION_ENABLED,'false');
  assert.equal(scopes[1].V141_LEGACY_COMPATIBILITY_ENABLED,'false');
  assert.equal(delivered.length,1);assert.equal(delivered[0].chat_id,101);assert.equal(delivered[0].text,'Ваш кабинет');
  assert.equal(f.sqlite.prepare("SELECT status FROM telegram_update_receipts WHERE update_id=1416200").get().status,'completed');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM entitlement_decision_audit').get().n,0);
});
