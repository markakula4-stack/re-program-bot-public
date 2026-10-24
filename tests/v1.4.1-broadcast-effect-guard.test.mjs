import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {foundationFixture} from './helpers/v1.4.1-fixtures.mjs';
import {ORIGIN} from './helpers/v1.4.0-rebuild-sqlite.mjs';
import {createCustomerContext} from '../src/v1.4.1/trusted-context.mjs';
import {authorizeTelegramHandler} from '../src/v1.4.1/telegram-runtime.mjs';
import {runtimeAuthorizationDTO} from '../src/v1.4.1/runtime-authorizer.mjs';
import {prepareLegacyCompatibility,bindLegacyCompatibilityEnv} from '../src/v1.4.1/telegram-legacy-compatibility.mjs';
import {installV141WorkerRuntime} from '../src/v1.4.1/worker-runtime.mjs';

let sequence=1_419_000;
async function deliveryFixture(t) {
  const f=foundationFixture(t);
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  const originalEnv={...f.serverEnv,V141_AUTHORIZATION_ENABLED:'true',V141_LEGACY_COMPATIBILITY_ENABLED:'true',
    WEBHOOK_SECRET:'fictional-broadcast-guard-webhook-secret'};
  f.sqlite.exec(`INSERT OR IGNORE INTO admin_broadcast_release_gate(id,paused,updated_at) VALUES(1,0,0);
    INSERT INTO admin_broadcasts(id,actor_id,message_text,status) VALUES(1419,900,'Тестовая рассылка','sending'),
      (1420,303,'Чужая рассылка','sending');
    INSERT INTO admin_broadcast_deliveries(broadcast_id,telegram_id,status) VALUES(1419,101,'pending'),(1420,101,'pending');`);
  const token='fictional-broadcast-current-claim',foreignToken='fictional-broadcast-foreign-claim';
  f.sqlite.prepare(`INSERT INTO admin_broadcast_delivery_claims(broadcast_id,telegram_id,status,claim_token,claimed_at,lease_expires_at)
    VALUES(1419,101,'processing',?,?,?)`).run(token,f.now,f.now+120);
  f.sqlite.prepare(`INSERT INTO admin_broadcast_delivery_claims(broadcast_id,telegram_id,status,claim_token,claimed_at,lease_expires_at)
    VALUES(1420,101,'processing',?,?,?)`).run(foreignToken,f.now,f.now+120);
  const updateId=++sequence,claim='fictional-broadcast-webhook-'+updateId;
  const update={update_id:updateId,callback_query:{id:'fictional_callback_'+updateId,from:{id:900,is_bot:false},
    message:{from:{id:123456789,is_bot:true},chat:{id:900,type:'private'}},data:'admin_broadcast_continue:1419'}};
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,attempt_count,received_at,lease_expires_at)
    VALUES(?,'callback_query',900,'processing',?,1,?,?)`).run(updateId,claim,f.now,f.now+300);
  const context=await createCustomerContext({binding:f.binding,env:originalEnv,webhookRequest:new Request(ORIGIN+'/webhook',{
    method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':originalEnv.WEBHOOK_SECRET},
    body:JSON.stringify(update)}),receiptClaimToken:claim,channel:'telegram_callback',operation:'account.menu.read',nowSeconds:f.now});
  const selected=await authorizeTelegramHandler(context,update);
  assert.equal(selected.handler.capability,'admin.broadcast.send');
  assert.equal(runtimeAuthorizationDTO(selected.authorization).allowed,true);
  const permit=await prepareLegacyCompatibility(selected.authorization,{family:'admin.broadcast.send'});
  const env=bindLegacyCompatibilityEnv(permit,originalEnv),runtime=installV141WorkerRuntime();
  const args={actorId:900,broadcastId:1419,recipientId:101,claimToken:token};
  let providerCalls=0;
  const provider=async()=>{providerCalls++;return {ok:true,messageId:1};};
  const deliver=async(input=args)=>{await runtime.guardBroadcastDelivery(env,input);return provider();};
  return {f,env,args,foreignToken,deliver,providerCalls:()=>providerCalls};
}

test('actual private compatibility permit and current joined own sending claim allow the sole mocked Telegram call',async t=>{
  const d=await deliveryFixture(t);
  const batch=d.f.binding.batch.bind(d.f.binding),finalBatches=[];
  d.f.binding.batch=async statements=>{
    if(statements.some(statement=>statement.sql.includes('JOIN admin_broadcast_deliveries')))
      finalBatches.push(statements);
    return batch(statements);
  };
  const result=await d.deliver();assert.equal(result.ok,true);assert.equal(d.providerCalls(),1);
  assert.equal(finalBatches.length,1,'authority and exact delivery claim share one transaction');
  assert.ok(finalBatches[0].length>1,'the actual proof exceeds one statement parameter budget');
  assert.ok(finalBatches[0].every(statement=>statement.params.length<=100));
  assert.equal(d.f.sqlite.prepare('SELECT status FROM admin_broadcast_delivery_claims WHERE broadcast_id=1419 AND telegram_id=101').get().status,'processing');
  assert.equal(d.f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_atomic_guards').get().n,0);
});

test('revocation immediately before the grouped final proof transaction stops the provider',async t=>{
  const d=await deliveryFixture(t),batch=d.f.binding.batch.bind(d.f.binding);
  let revoked=false;
  d.f.binding.batch=async statements=>{
    if(!revoked&&statements.some(statement=>statement.sql.includes('JOIN admin_broadcast_deliveries'))) {
      revoked=true;
      d.f.sqlite.prepare("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'").run();
    }
    return batch(statements);
  };
  await assert.rejects(d.deliver(),/broadcast_delivery_authority_stale/u);
  assert.equal(revoked,true);assert.equal(d.providerCalls(),0);
});

test('failed, empty and malformed final proof batches never reach the broadcast provider',async t=>{
  for(const mode of ['throws','empty','malformed']) {
    const d=await deliveryFixture(t),batch=d.f.binding.batch.bind(d.f.binding);
    let intercepted=0;
    d.f.binding.batch=async statements=>{
      if(!statements.some(statement=>statement.sql.includes('JOIN admin_broadcast_deliveries')))
        return batch(statements);
      intercepted++;
      if(mode==='throws') throw new Error('offline-final-proof-failure');
      if(mode==='empty') return [];
      const results=statements.map(()=>({success:true,results:[{valid:1}]}));
      results.at(-1).results=[null];
      return results;
    };
    await assert.rejects(d.deliver(),mode==='throws'?/offline-final-proof-failure/u:/broadcast_delivery_authority_stale/u);
    assert.equal(intercepted,1,mode);assert.equal(d.providerCalls(),0,mode);
    assert.equal(d.f.sqlite.prepare('SELECT status FROM admin_broadcast_deliveries WHERE broadcast_id=1419 AND telegram_id=101').get().status,'pending');
  }
});

test('expired, lost and foreign actual delivery claims stop the mocked provider',async t=>{
  const d=await deliveryFixture(t);
  d.f.sqlite.prepare('UPDATE admin_broadcast_delivery_claims SET lease_expires_at=? WHERE broadcast_id=1419 AND telegram_id=101').run(d.f.now-1);
  await assert.rejects(d.deliver(),/broadcast_delivery_(claim|authority)_stale/u);
  d.f.sqlite.prepare('DELETE FROM admin_broadcast_delivery_claims WHERE broadcast_id=1419 AND telegram_id=101').run();
  await assert.rejects(d.deliver(),/broadcast_delivery_(claim|authority)_stale/u);
  d.f.sqlite.prepare(`INSERT INTO admin_broadcast_delivery_claims(broadcast_id,telegram_id,status,claim_token,claimed_at,lease_expires_at)
    VALUES(1419,101,'processing',?,?,?)`).run(d.args.claimToken,d.f.now,d.f.now+120);
  await assert.rejects(d.deliver({...d.args,claimToken:d.foreignToken}),/broadcast_delivery_(claim|authority)_stale/u);
  assert.equal(d.providerCalls(),0);
  assert.equal(d.f.sqlite.prepare('SELECT status FROM admin_broadcast_deliveries WHERE broadcast_id=1419 AND telegram_id=101').get().status,'pending');
});

test('revoking the actual current owner admin role after claim stops delivery before the mocked provider',async t=>{
  const d=await deliveryFixture(t);
  d.f.sqlite.prepare("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'").run();
  await assert.rejects(d.deliver(),/authority_stale|role_required|capability_denied|resource_unavailable/u);
  assert.equal(d.providerCalls(),0);
  assert.equal(d.f.sqlite.prepare('SELECT status FROM admin_broadcast_delivery_claims WHERE broadcast_id=1419 AND telegram_id=101').get().status,'processing');
});

test('role revocation at the final joined claim read cannot pass a previously fresh owner proof',async t=>{
  const d=await deliveryFixture(t),prepare=d.f.binding.prepare.bind(d.f.binding);
  let revoked=false;
  d.f.binding.prepare=sql=>{
    if(!revoked&&sql.includes('JOIN admin_broadcast_deliveries')) {
      revoked=true;
      d.f.sqlite.prepare("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'").run();
    }
    return prepare(sql);
  };
  await assert.rejects(d.deliver(),/authority_stale|role_required|capability_denied|broadcast_delivery_claim_stale/u);
  assert.equal(revoked,true);assert.equal(d.providerCalls(),0);
});
