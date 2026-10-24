import test from 'node:test';
import assert from 'node:assert/strict';
import {foundationFixture} from './helpers/v1.4.1-fixtures.mjs';
import {ORIGIN,publishedOffer} from './helpers/v1.4.0-rebuild-sqlite.mjs';
import {createCustomerContext} from '../src/v1.4.1/trusted-context.mjs';
import {createRuntimeAuthorizer,runtimeAuthorizationDTO} from '../src/v1.4.1/runtime-authorizer.mjs';
import {LEGACY_COMPATIBILITY_FAMILIES,prepareLegacyCompatibility,bindLegacyCompatibilityEnv,
  hasLegacyCompatibilityEnv,readLegacyCompatibilityEnv,inheritLegacyCompatibilityEnv,
  assertLegacyCompatibilityFresh,bindConfirmedStarsRefundAccountingEnv} from '../src/v1.4.1/telegram-legacy-compatibility.mjs';

let sequence=1_416_000;
async function openScope(t){
  const f=foundationFixture(t),offer=await publishedOffer(f);
  const env={...f.serverEnv,V141_AUTHORIZATION_ENABLED:'true',WEBHOOK_SECRET:'offline-compatibility-webhook-secret'};
  const update={update_id:++sequence,callback_query:{id:'compat_'+sequence,from:{id:101,is_bot:false},
    message:{from:{id:123456789,is_bot:true},chat:{id:101,type:'private'}},data:'open:'+offer.code}};
  const claim='compat_claim_'+sequence;
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,attempt_count,received_at,lease_expires_at)
    VALUES(?,'callback_query',101,'processing',?,1,?,?)`).run(update.update_id,claim,f.now,f.now+300);
  const context=await createCustomerContext({binding:f.binding,env,webhookRequest:new Request(ORIGIN+'/webhook',{
    method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET},body:JSON.stringify(update)}),
    receiptClaimToken:claim,channel:'telegram_callback',operation:'offer.open_action',nowSeconds:f.now,requestPayload:{}});
  const authorization=await createRuntimeAuthorizer().authorize(context,{kind:'offer',key:offer.code});
  assert.equal(runtimeAuthorizationDTO(authorization).allowed,true);
  const permit=await prepareLegacyCompatibility(authorization,{family:'offer.open_action'});
  return {f,offer,authorization,env:bindLegacyCompatibilityEnv(permit,env)};
}
const count=(f,table)=>f.sqlite.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;

test('closed compatibility preserves D1 results and primary session, rejects fake/cross-family/foreign SQL scopes',async t=>{
  const {f,offer,authorization,env}=await openScope(t);
  assert.equal(Object.keys(LEGACY_COMPATIBILITY_FAMILIES).length,14);
  assert.equal(hasLegacyCompatibilityEnv(env),true);assert.equal(hasLegacyCompatibilityEnv({...env}),false);
  assert.throws(()=>readLegacyCompatibilityEnv({...env}),/untrusted_legacy_compatibility_env/u);
  await assert.rejects(prepareLegacyCompatibility({}, {family:'offer.open_action'}),/untrusted_runtime_authorization/u);
  await assert.rejects(prepareLegacyCompatibility(authorization,{family:'admin.catalog.manage'}),/legacy_family_mismatch/u);
  assert.equal(env.DB.withSession('first-primary').withSession(),env.DB);
  const copied=inheritLegacyCompatibilityEnv(env,{...env});assert.equal(hasLegacyCompatibilityEnv(copied),true);
  assert.throws(()=>inheritLegacyCompatibilityEnv(env,{...env,ADMIN_ID:'101'}),/runtime_binding_changed/u);
  assert.throws(()=>env.DB.prepare('UPDATE users SET is_blocked=0 WHERE telegram_id=101'),/legacy_write_table_forbidden/u);
  assert.throws(()=>env.DB.prepare('SELECT 1; DELETE FROM users'),/legacy_sql_multiple_statements/u);
  assert.throws(()=>env.DB.prepare('WITH x AS (SELECT 1) SELECT * FROM x'),/legacy_sql_unsupported/u);
  await assert.rejects(env.DB.batch([f.binding.prepare('SELECT 1')]),/legacy_batch_invalid/u);
  await assert.rejects(env.DB.prepare('INSERT INTO offer_clicks(telegram_id,offer_code) VALUES(?,?)').bind(303,offer.code).run(),/legacy_write_scope_mismatch/u);
  await assert.rejects(env.DB.prepare('INSERT INTO offer_clicks(telegram_id,offer_code) VALUES(?,?)').bind(101,'another_offer').run(),/legacy_write_scope_mismatch/u);
  await assert.rejects(env.DB.prepare('DELETE FROM offer_clicks WHERE telegram_id=? OR 1=1').bind(101).run(),/legacy_write_scope_mismatch/u);
  await assert.rejects(Promise.resolve().then(()=>bindConfirmedStarsRefundAccountingEnv(env,{confirmed:true})),/untrusted_refund_accounting/u);
  f.binding.audit.length=0;
  let actualBatch;f.binding.beforeBatch=({statements})=>{actualBatch=statements;};
  const result=await env.DB.prepare('INSERT INTO offer_clicks(telegram_id,offer_code) VALUES(?,?) RETURNING id').bind(101,offer.code).first('id');
  assert.ok(Number.isSafeInteger(result));assert.equal(count(f,'offer_clicks'),1);assert.equal(count(f,'mini_app_atomic_guards'),0);
  assert.ok(actualBatch.some(statement=>statement.sql.includes('INSERT INTO mini_app_atomic_guards'))&&
    actualBatch.some(statement=>statement.sql.includes('INSERT INTO offer_clicks'))&&
    actualBatch.at(-1).sql.startsWith('DELETE FROM mini_app_atomic_guards'));
  const batch=await env.DB.batch([env.DB.prepare('SELECT 7 AS x'),env.DB.prepare('INSERT INTO offer_clicks(telegram_id,offer_code) VALUES(?,?)').bind(101,offer.code)]);
  assert.equal(batch.length,2);assert.equal(batch[0].results[0].x,7);assert.equal(batch[1].meta.changes,1);
  assert.equal(count(f,'offer_clicks'),2);assert.equal(count(f,'mini_app_atomic_guards'),0);
  await assertLegacyCompatibilityFresh(env);
});

test('same-batch source guards roll back both effects when an active role is removed before commit',async t=>{
  const {f,offer,env}=await openScope(t);f.binding.beforeBatch=()=>f.sqlite.exec("UPDATE user_roles SET status='paused' WHERE telegram_id=101 AND role='user'");
  await assert.rejects(env.DB.batch([
    env.DB.prepare('INSERT INTO offer_clicks(telegram_id,offer_code) VALUES(?,?)').bind(101,offer.code),
    env.DB.prepare('INSERT INTO recent_offer_views(telegram_id,offer_code,viewed_at) VALUES(?,?,CURRENT_TIMESTAMP)').bind(101,offer.code),
  ]),/CHECK constraint failed/u);
  assert.equal(count(f,'offer_clicks'),0);assert.equal(count(f,'recent_offer_views'),0);assert.equal(count(f,'mini_app_atomic_guards'),0);
  f.binding.beforeBatch=null;await assert.rejects(assertLegacyCompatibilityFresh(env),/authority_stale/u);
});
