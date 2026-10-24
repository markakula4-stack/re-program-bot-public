import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {foundationFixture} from './helpers/v1.4.1-fixtures.mjs';
import {ORIGIN} from './helpers/v1.4.0-rebuild-sqlite.mjs';
import {installV141WorkerRuntime} from '../src/v1.4.1/worker-runtime.mjs';
import {claimedTelegramRegistrationHandler} from '../src/v1.4.1/telegram-runtime.mjs';
import {runtimeContext} from '../src/v1.4.1/runtime-binding.mjs';

let sequence=1_420_000;
async function setup(t,id=900,text='/start') {
  const f=foundationFixture(t),sha='a'.repeat(40);
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  f.sqlite.prepare("INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,owner_telegram_id,issued_at,expires_at,updated_at) VALUES(1,?,28,'closed',0,NULL,NULL,NULL,?)").run(sha,f.now);
  const env={...f.serverEnv,V141_AUTHORIZATION_ENABLED:'true',REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',
    REBUILD_V140_RC_SHA:sha,REBUILD_V140_RELEASE_REVISION:'28',WEBHOOK_SECRET:'synthetic-start-admission-secret'};
  const runtime=installV141WorkerRuntime(),update={update_id:++sequence,message:{date:f.now,from:{id,is_bot:false},chat:{id,type:'private'},text}};
  const claim='synthetic-start-admission-claim-'+update.update_id;
  f.sqlite.prepare("INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,attempt_count,received_at,lease_expires_at) VALUES(?,'message',?,'processing',?,1,?,?)").run(update.update_id,id,claim,f.now,f.now+300);
  const request=new Request(ORIGIN+'/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET},body:JSON.stringify(update)});
  const scoped=await runtime.enterTelegram({env,request,receiptClaimToken:claim,update});
  return {f,env,runtime,update,scoped};
}

test('claimed /start dispatch makes no authority roundtrip and genuine registration reads one bounded canonical batch',async t=>{
  const {f,runtime,update,scoped}=await setup(t,555);
  f.binding.audit.length=0;
  const selected=await runtime.guardDispatch(scoped,update);
  assert.equal(selected.handler.capability,'account.register');assert.equal(selected.authorization,null);
  assert.equal(f.binding.audit.length,0,'dispatch retains transport binding without resolving the same registration twice');
  const original=f.binding.batch.bind(f.binding),batches=[];
  f.binding.batch=async statements=>{batches.push(statements.map(s=>s.sql));return original(statements);};
  const result=await runtime.registerAccount(scoped,555,null);
  assert.equal(result.isNew,true);assert.equal(result.user.accepted_terms,0);
  assert.deepEqual(f.sqlite.prepare('SELECT role,status FROM user_roles WHERE telegram_id=555').all().map(r=>({...r})),[{role:'user',status:'active'}]);
  assert.equal(f.sqlite.prepare('SELECT access_tier FROM user_access WHERE telegram_id=555').get().access_tier,'free');
  const snapshotBatches=batches.filter(statements=>statements.length>20&&statements.every(sql=>sql.startsWith('SELECT COALESCE(json_group_array')));
  assert.equal(snapshotBatches.length,1);assert.ok(snapshotBatches[0].length<=40);
  assert.equal(batches.filter(statements=>statements.some(sql=>sql.startsWith('INSERT INTO mini_app_atomic_guards'))).length,1,'fresh original assertions remain in the same registration effect batch');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_atomic_guards').get().n,0);
});

test('registration selector cannot transfer its claimed update, actor or context, and admin entry never uses the shortcut',async t=>{
  const {f,runtime,update,scoped}=await setup(t);
  const context=runtimeContext(scoped);
  assert.throws(()=>claimedTelegramRegistrationHandler(context,{...update,update_id:update.update_id+1}),/telegram_operation_binding_mismatch/u);
  assert.throws(()=>claimedTelegramRegistrationHandler(context,{...update,message:{...update.message,from:{id:101}}}),/telegram_operation_binding_mismatch/u);
  assert.throws(()=>claimedTelegramRegistrationHandler({},update),/untrusted_context/u);
  assert.equal(claimedTelegramRegistrationHandler(context,{...update,message:{...update.message,text:'/cabinet_admin'}}),null);
  f.sqlite.exec("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'");
  await assert.rejects(runtime.guardDispatch(scoped,{...update,message:{...update.message,text:'/cabinet_admin'}}),/role_required|prerequisite_required|resource_unavailable/u);
});

test('blocking after /start dispatch prevents registration before any account or role effect',async t=>{
  const {f,runtime,update,scoped}=await setup(t,101);
  await runtime.guardDispatch(scoped,update);
  f.sqlite.exec('UPDATE users SET is_blocked=1 WHERE telegram_id=101');
  await assert.rejects(runtime.registerAccount(scoped,101,null),/account_restricted/u);
  assert.equal(f.sqlite.prepare('SELECT is_blocked FROM users WHERE telegram_id=101').get().is_blocked,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_atomic_guards').get().n,0);
});

test('same write-batch claim revocation rolls registration back while paused roles remain paused',async t=>{
  const {f,runtime,update,scoped}=await setup(t,101);
  f.sqlite.exec("UPDATE user_roles SET status='paused' WHERE telegram_id=101 AND role='user'");
  await runtime.guardDispatch(scoped,update);
  await runtime.registerAccount(scoped,101,null);
  assert.equal(f.sqlite.prepare("SELECT status FROM user_roles WHERE telegram_id=101 AND role='user'").get().status,'paused');
  const original=f.binding.batch.bind(f.binding);
  f.binding.batch=async statements=>{
    if(statements.some(s=>s.sql.startsWith('INSERT INTO mini_app_atomic_guards')))f.sqlite.prepare("UPDATE telegram_update_receipts SET claim_token='revoked-claim' WHERE update_id=?").run(update.update_id);
    return original(statements);
  };
  await assert.rejects(runtime.registerAccount(scoped,101,null));
  assert.equal(f.sqlite.prepare("SELECT status FROM user_roles WHERE telegram_id=101 AND role='user'").get().status,'paused');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_atomic_guards').get().n,0);
});

test('malformed read-only batch acknowledgement falls back to actual mandatory reads without issuing authority',async t=>{
  const {f,runtime,scoped}=await setup(t,555);
  const original=f.binding.batch.bind(f.binding);let truncated=false;
  f.binding.batch=async statements=>{
    const results=await original(statements);
    if(statements.length>20&&statements.every(s=>s.sql.startsWith('SELECT COALESCE(json_group_array'))&&!truncated){truncated=true;return results.slice(0,-1);}
    return results;
  };
  const result=await runtime.registerAccount(scoped,555,null);
  assert.equal(truncated,true);assert.equal(result.user.accepted_terms,0);
  assert.deepEqual(f.sqlite.prepare('SELECT role FROM user_roles WHERE telegram_id=555').all().map(r=>r.role),['user']);
});
