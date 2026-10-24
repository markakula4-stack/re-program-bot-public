import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { createDemoEngine, DEMO_MONTH_SECONDS as MONTH } from '../src/v1.4.3-demo/engine.mjs';

function setup(t){
 const f=foundationFixture(t);
 for(const file of ['0026-v1.3.6-stars-core-foundation.sql','0027-v1.3.6-stars-access-and-reconciliation.sql','0066-v1.4.3-subscription-lifecycle-foundation.sql','0067-v1.4.3-lifecycle-engine-binding.sql','0068-v1.4.3-provider-and-review-binding.sql'])f.sqlite.exec(fs.readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 f.sqlite.exec(fs.readFileSync(new URL('../src/v1.4.3-demo/schema.sql',import.meta.url),'utf8'));
 const engine=createDemoEngine({db:f.binding,ownerId:900,invoiceSecret:'offline-demo-invoice-secret-at-least-32-characters',wallNowSeconds:()=>Math.floor(Date.now()/1000)});
 const count=table=>f.sqlite.prepare('SELECT COUNT(*) n FROM '+table).get().n;
 let seq=0;const act=(action,planCode)=>engine.act({action,operationId:'offline-demo-operation-'+(++seq),...(planCode?{planCode}:{})});
 return {f,engine,count,act};
}
async function nextProviderSecond(f){const last=f.sqlite.prepare('SELECT MAX(attempted_at) n FROM subscription_provider_commands').get().n;const wait=Math.max(0,(last+1)*1000-Date.now()+15);if(wait)await new Promise(resolve=>setTimeout(resolve,wait));}

test('isolated virtual purchase, renewal, duplicate and reset use the actual financial writer and retain history',async t=>{
 const {f,engine,count,act}=setup(t),beforeNow=Date.now;
 const initial=await engine.read();assert.equal(initial.balance,1000);assert.equal(initial.subscription.paidAccess,false);
 const buy=await act('buy','professional');assert.equal(buy.balance,751);assert.equal(buy.subscription.paidAccess,true);assert.equal(buy.receipts.length,1);assert.equal(count('payment_ledger'),1);assert.equal(count('subscription_access_grants'),1);
 const renewal=await act('advance_30d');assert.equal(renewal.balance,502);assert.equal(renewal.nowSec,buy.nowSec+MONTH);assert.equal(renewal.subscription.paidAccess,true);assert.equal(renewal.receipts.length,2);assert.equal(count('payment_ledger'),2);
 const duplicate=await act('duplicate');assert.equal(duplicate.balance,502);assert.equal(duplicate.receipts.length,2);assert.equal(count('payment_ledger'),2);
 const reset=await act('reset');assert.equal(reset.generation,2);assert.equal(reset.balance,1000);assert.equal(reset.receipts.length,0);assert.equal(reset.subscription.paidAccess,false);assert.equal(count('payment_ledger'),2);assert.equal(count('re_demo_generations'),2);
 assert.equal(Date.now,beforeNow,'no process-global clock replacement');assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('operation replay, mismatched IDs and simulated lost answer cannot debit twice',async t=>{
 const {engine,count}=setup(t),request={action:'lost_response',planCode:'dragon',operationId:'same-demo-operation-id'};
 const first=await engine.act(request);assert.equal(first.feedback.status,'unknown');assert.equal(first.balance,501);assert.equal(first.subscription.paidAccess,true);
 const replay=await engine.act(request);assert.equal(replay.replayed,true);assert.equal(replay.balance,501);assert.equal(count('payment_ledger'),1);
 await assert.rejects(engine.act({...request,planCode:'professional'}),/demo_operation_collision/);assert.equal(count('payment_ledger'),1);
});

test('cancel preserves paid residue; no-funds advance expires access with no phantom receipt',async t=>{
 const {act,count}=setup(t);
 const bought=await act('buy','professional');
 const canceled=await act('cancel');assert.equal(canceled.subscription.autoRenew,false);assert.equal(canceled.subscription.paidAccess,true);assert.equal(canceled.subscription.paidUntil,bought.subscription.paidUntil);
 const expired=await act('advance_30d');assert.equal(expired.balance,751);assert.equal(expired.subscription.paidAccess,false);assert.equal(count('payment_ledger'),1);
});

test('insufficient fake balance never creates new money or a paid period',async t=>{
 const {act,count}=setup(t);await act('buy','dragon');await act('low_funds');
 const denied=await act('advance_30d');assert.equal(denied.balance,0);assert.equal(denied.feedback.code,'insufficient_funds');assert.equal(denied.subscription.paidAccess,false);assert.equal(denied.receipts.length,1);assert.equal(count('payment_ledger'),1);
});

test('resume uses the real command adapter and preserves its pending-provider semantics',async t=>{
 const {act,count,f}=setup(t);await act('buy','professional');await act('cancel');await nextProviderSecond(f);
 const resumed=await act('resume');assert.equal(resumed.subscription.autoRenew,true);assert.equal(resumed.subscription.renewalState,'unknown');assert.equal(count('subscription_provider_commands'),2);
 const renewed=await act('advance_30d');assert.equal(renewed.balance,502);assert.equal(renewed.subscription.paidAccess,true);assert.equal(count('payment_ledger'),2);
});

test('rapid control toggles are rejected before admission and can retry without a permanent operation lock',async t=>{
 const {engine,act,f,count}=setup(t);await act('buy','professional');await act('cancel');
 const request={action:'resume',operationId:'demo-control-cooldown-operation'};
 // Reuse the real last command's wall second only for the demo admission clock.
 const last=f.sqlite.prepare('SELECT MAX(attempted_at) n FROM subscription_provider_commands').get().n;
 const sameSecond=createDemoEngine({db:f.binding,ownerId:900,invoiceSecret:'offline-demo-invoice-secret-at-least-32-characters',wallNowSeconds:last});
 const before=count('re_demo_operations');await assert.rejects(sameSecond.act(request),error=>error.code==='demo_control_cooldown'&&error.status===429);
 assert.equal(count('re_demo_operations'),before);assert.equal((await engine.read()).pendingOperation,null);
 await nextProviderSecond(f);const resumed=await engine.act(request);assert.equal(resumed.subscription.autoRenew,true);assert.equal(resumed.pendingOperation,null);
 assert.equal(count('subscription_provider_commands'),2);assert.equal(count('payment_ledger'),1);
});

test('interrupted financial commit resumes the admitted operation once and blocks a different writer',async t=>{
 const {f,engine,count}=setup(t),request={action:'buy',planCode:'professional',operationId:'demo-recovery-operation'};
 f.binding.failStatement=sql=>/INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+payment_ledger\b/i.test(sql);
 await assert.rejects(engine.act(request));
 const pending=await engine.read();assert.equal(pending.balance,751);assert.deepEqual(pending.pendingOperation,request);assert.equal(count('payment_ledger'),0);
 await assert.rejects(engine.act({action:'reset',operationId:'other-recovery-operation'}),/demo_operation_pending/);
 const recovered=await engine.act(request);assert.equal(recovered.balance,751);assert.equal(recovered.pendingOperationId,null);assert.equal(recovered.receipts.length,1);assert.equal(count('payment_ledger'),1);
 const again=await engine.act(request);assert.equal(again.replayed,true);assert.equal(count('payment_ledger'),1);
});

test('same concurrent wallet intent consumes at most one debit and calls no network',async t=>{
 const {engine,count}=setup(t),originalFetch=globalThis.fetch;
 globalThis.fetch=()=>{throw new Error('demo must not call network');};t.after(()=>{globalThis.fetch=originalFetch;});
 const request={action:'buy',planCode:'professional',operationId:'concurrent-demo-operation'};
 const results=await Promise.allSettled([engine.act(request),engine.act(request)]);
 assert.ok(results.some(r=>r.status==='fulfilled'));const recovered=await engine.act(request);
 assert.equal(recovered.balance,751);assert.equal(count('payment_ledger'),1);assert.equal(count('subscription_access_grants'),1);
});

test('a lagging retry cannot resurrect auto renewal after the winning operation and later cancellation',async t=>{
 const {f,engine,count,act}=setup(t),request={action:'buy',planCode:'professional',operationId:'demo-lagging-retry-operation'};
 f.binding.failStatement=sql=>/INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+payment_ledger\b/i.test(sql);
 await assert.rejects(engine.act(request));
 const nativeBatch=f.binding.batch.bind(f.binding);let writes=0,release,reached;
 const barrier=new Promise(resolve=>{reached=resolve;});const hold=new Promise(resolve=>{release=resolve;});t.after(()=>release());
 f.binding.batch=async statements=>{
  if(statements.some(s=>s.sql.startsWith('UPDATE re_demo_generations SET plan_code='))&&++writes===2){reached();await hold;}
  return nativeBatch(statements);
 };
 const a=engine.act(request),b=engine.act(request);await barrier;await Promise.race([a,b]);
 const canceled=await act('cancel');assert.equal(canceled.subscription.autoRenew,false);
 release();await Promise.all([a,b]);
 const final=await engine.read();assert.equal(final.subscription.autoRenew,false);assert.equal(final.balance,751);assert.equal(count('payment_ledger'),1);
});

test('native D1 raw query method is preserved when native and fenced statements share a financial batch',async t=>{
 const {f,engine,count}=setup(t),prepare=f.binding.prepare.bind(f.binding);let rawCalls=0;
 const native=statement=>{
  const bind=statement.bind.bind(statement);
  statement.raw=async()=>{rawCalls++;return [];};
  statement.bind=(...params)=>native(bind(...params));
  return statement;
 };
 f.binding.prepare=sql=>native(prepare(sql));
 assert.equal((await engine.read()).balance,1000);
 const bought=await engine.act({action:'buy',planCode:'professional',operationId:'native-d1-raw-query-method'});
 assert.equal(bought.balance,751);assert.equal(bought.subscription.paidAccess,true);assert.equal(bought.receipts.length,1);
 assert.equal(count('payment_ledger'),1);assert.equal(rawCalls,0,'batch must receive statements, not invoke their native raw methods');
 const renewed=await engine.act({action:'advance_30d',operationId:'native-d1-raw-query-renewal'});
 assert.equal(renewed.balance,502);assert.equal(count('payment_ledger'),2);
});

test('an old admitted purchase recovers past invoice TTL without replacing its intent or debiting again',async t=>{
 const {f,count}=setup(t),ownerId=900,invoiceSecret='offline-demo-invoice-secret-at-least-32-characters';
 const paymentAt=Math.floor(Date.now()/1000)-3600;
 const oldRequestEngine=createDemoEngine({db:f.binding,ownerId,invoiceSecret,wallNowSeconds:paymentAt});
 const request={action:'buy',planCode:'professional',operationId:'demo-delayed-original-purchase'};
 f.binding.failStatement=sql=>sql.includes('INSERT OR IGNORE INTO terms_acceptances');
 await assert.rejects(oldRequestEngine.act(request));
 const original=f.sqlite.prepare('SELECT work_json FROM re_demo_operations WHERE owner_id=? AND operation_id=?').get(ownerId,request.operationId).work_json;
 assert.equal(count('subscription_orders'),0);assert.equal(count('subscription_billing_contracts'),0);assert.equal(count('payment_ledger'),0);
 const currentEngine=createDemoEngine({db:f.binding,ownerId,invoiceSecret});
 const recovered=await currentEngine.act(request);
 assert.equal(recovered.balance,751);assert.equal(recovered.nowSec,paymentAt);assert.equal(recovered.pendingOperation,null);
 assert.equal(recovered.subscription.paidAccess,true);assert.equal(recovered.subscription.reviewRequired,false);assert.equal(recovered.receipts.length,1);
 assert.deepEqual(recovered.receipts[0].paidPeriod,{startsAt:paymentAt,endsAt:paymentAt+MONTH});
 assert.equal(f.sqlite.prepare('SELECT work_json FROM re_demo_operations WHERE owner_id=? AND operation_id=?').get(ownerId,request.operationId).work_json,original);
 const order=f.sqlite.prepare('SELECT created_at,expires_at,paid_at,applied_at FROM subscription_orders').get();
 assert.deepEqual({...order},{created_at:paymentAt,expires_at:paymentAt+600,paid_at:paymentAt,applied_at:paymentAt});
 assert.ok(order.expires_at<Math.floor(Date.now()/1000));
 const ledger=f.sqlite.prepare('SELECT occurred_at,recorded_at FROM payment_ledger').get();
 assert.equal(ledger.occurred_at,paymentAt);assert.ok(ledger.recorded_at>=paymentAt+3600);
 const replay=await currentEngine.act(request);assert.equal(replay.replayed,true);assert.equal(replay.balance,751);assert.equal(count('payment_ledger'),1);
});
