import test from 'node:test';
import assert from 'node:assert/strict';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { createCabinetCustomerContext, deriveTrustedOperationContext, refreshTrustedContext,
  readTrustedContext, compileContextAssertions } from '../src/v1.4.1/trusted-context.mjs';
import { bindRuntimeContext, inheritRuntimeContext, runtimeContext, assertRuntimeBindingReady } from '../src/v1.4.1/runtime-binding.mjs';

const evaluate = (f, context) => { const p=compileContextAssertions(context); return f.sqlite.prepare(`SELECT (${p.sql}) AS ok`).get(...p.params).ok; };
test('derived receipt matches direct compiled operation while immutable identity and original deadline survive', async t => {
  const f=foundationFixture(t), extra={idempotencyKey:'derive_operation_test_001',requestPayload:{prompt:'hello'}};
  const original=await f.context(101,'ai.public_chat','mini_app',extra), facts=readTrustedContext(original);
  const derived=await deriveTrustedOperationContext(original,{operation:'ai.memory.read_own',requestPayload:{count:1}});
  const direct=await f.context(101,'ai.memory.read_own','mini_app',{...extra,requestPayload:{count:1}});
  const next=readTrustedContext(derived);
  assert.equal(next.operationId,readTrustedContext(direct).operationId);
  assert.equal(next.telegramId,101); assert.equal(next.db,facts.db); assert.equal(next.expiresAt,facts.expiresAt);
  assert.notEqual(next.payloadHash,facts.payloadHash); assert.equal(facts.requestPayload.prompt,'hello');
  await assert.rejects(deriveTrustedOperationContext(JSON.parse(JSON.stringify(original)),{operation:'admin.partner.review'}),/untrusted_context/u);
  await assert.rejects(deriveTrustedOperationContext(original,{operation:'admin.fake'}),/invalid_derived_operation/u);
});
test('refresh preserves original deadline, rejects actual revoked session, and cannot refresh serialized proof',async t=>{
  const f=foundationFixture(t); await f.session(101);
  const args={initData:undefined,sessionToken:f.tokens.get(101),idempotencyKey:'refresh_operation_test_001',requestPayload:{}};
  const original=await f.context(101,'profile.read_own','mini_app',args), before=readTrustedContext(original);
  const refreshed=await refreshTrustedContext(original), after=readTrustedContext(refreshed);
  assert.equal(after.expiresAt,before.expiresAt); assert.equal(after.operationId,before.operationId);
  assert.equal(after.db,before.db); assert.ok(after.nowSeconds>=before.nowSeconds);
  f.sqlite.exec("UPDATE mini_app_sessions SET revoked_at=unixepoch(),status='revoked' WHERE telegram_id=101");
  await assert.rejects(refreshTrustedContext(original),/authentication_changed/u);
  await assert.rejects(refreshTrustedContext({...original}),/untrusted_context/u);
});
test('permanent canonical cabinet admin does not inherit expired participant window but is fenced by release epoch',async t=>{
  const f=foundationFixture(t), env={...f.serverEnv,REBUILD_V140_STORAGE_ENABLED:'true',
    REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',
    REBUILD_V140_RC_SHA:'a'.repeat(40),REBUILD_V140_RELEASE_REVISION:'1',
    REBUILD_V140_OWNER_WINDOW:`true:${f.now-1200}:${f.now-1}`};
  f.sqlite.prepare("INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,updated_at) VALUES(1,?,1,'closed',0,unixepoch())").run('a'.repeat(40));
  const context=await createCabinetCustomerContext({binding:f.binding,env,channel:'mini_app',operation:'admin.partner.review',
    initData:(await import('./helpers/v1.4.1-fixtures.mjs')).signedInitData(900,f.now),nowSeconds:f.now});
  assert.equal(evaluate(f,context),1); assert.equal(readTrustedContext(context).expiresAt,f.now+300);
  f.sqlite.exec('UPDATE mini_app_release_control SET revision=revision+1 WHERE id=1');
  assert.equal(evaluate(f,context),0);
});
test('participant cabinet identity cannot borrow another actor lease or permanent admin fence',async t=>{
  const f=foundationFixture(t), env={...f.serverEnv,REBUILD_V140_STORAGE_ENABLED:'true',REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',
    REBUILD_V140_RC_SHA:'a'.repeat(40),REBUILD_V140_RELEASE_REVISION:'1',REBUILD_V140_OWNER_TELEGRAM_ID:'202',
    REBUILD_V140_OWNER_WINDOW:`true:${f.now-10}:${f.now+200}`};
  await assert.rejects(createCabinetCustomerContext({binding:f.binding,env,channel:'mini_app',operation:'profile.read_own',
    initData:(await import('./helpers/v1.4.1-fixtures.mjs')).signedInitData(101,f.now),nowSeconds:f.now}),/cabinet_participant_mismatch/u);
});
test('request-local env propagation is privately branded and readiness rejects old schema before effects',async t=>{
  const f=foundationFixture(t), env={...f.serverEnv,V141_AUTHORIZATION_ENABLED:'true'}, ctx=await f.context();
  bindRuntimeContext(env,ctx); const copy=inheritRuntimeContext(env,{...env}); assert.equal(runtimeContext(copy),ctx);
  assert.throws(()=>runtimeContext({...env}),/runtime_context_unavailable/u);
  assert.throws(()=>runtimeContext(inheritRuntimeContext(env,{...env,BOT_TOKEN:'different'})),/runtime_binding_changed/u);
  await assert.rejects(assertRuntimeBindingReady({binding:f.binding,env}),/v141_schema_not_ready/u);
  assert.equal(f.binding.audit.filter(x=>x.mode==='write').length,0);
});
