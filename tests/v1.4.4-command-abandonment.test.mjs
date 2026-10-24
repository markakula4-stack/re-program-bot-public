import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {cabinetSubscriptionFixture,next} from './helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import {authorizeOwnStarsSubscriptionCommand,authorizeOwnStarsSubscriptionRecovery} from '../src/v1.4.3/subscription-action-authority.mjs';
import {abandonOwnStarsSubscriptionCommandBeforeAttempt,requestOwnStarsSubscriptionCommand} from '../src/v1.4.3/telegram-subscription-provider.mjs';
import {readOwnSubscriptionOperationStatus} from '../src/v1.4.3/subscription-operation-status.mjs';
import {requestStarsRefund} from '../src/v1.3.6/stars-access-runtime.mjs';
import {authoritySeconds} from '../src/v1.4.1/authority-resolver.mjs';
import {createRuntimeAuthorizer,readRuntimeAuthorization,assertRuntimeAuthorizationFresh} from '../src/v1.4.1/runtime-authorizer.mjs';
import {compileDecisionAssertions} from '../src/v1.4.1/entitlement-engine.mjs';

const intent=p=>({contractId:p.contract.contract_id,expectedRevision:p.contract.revision});
const token=(f,p,key,id=101,action='cancel_renewal')=>f.auth({id,key,payload:{subscriptionAction:action,...intent(p)}})
  .then(authorizeOwnStarsSubscriptionCommand);
const recoveryToken=(f,p,key,id=101,action='cancel_renewal')=>f.auth({id,key,payload:{subscriptionAction:action,...intent(p)}})
  .then(authorizeOwnStarsSubscriptionRecovery);
const status=(f,p,key,id=101)=>f.auth({id,key,payload:{subscriptionOperationStatus:{kind:'cancel',intent:intent(p)}}})
  .then(authorization=>readOwnSubscriptionOperationStatus({authorization}));
const money=f=>JSON.stringify({subscriptions:f.sqlite.prepare('SELECT * FROM subscriptions').all(),
  grants:f.sqlite.prepare('SELECT * FROM subscription_access_grants').all(),
  ledger:f.sqlite.prepare('SELECT * FROM payment_ledger').all()});
function httpEnv(f,id=101){
  const candidate='d'.repeat(40),prior=f.sqlite.prepare('SELECT revision FROM mini_app_release_control WHERE id=1').get(),revision=(prior?.revision??0)+1;
  f.sqlite.prepare(`INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,owner_telegram_id,issued_at,expires_at,updated_at)
    VALUES(1,?,?,'open',0,?,?,?,?) ON CONFLICT(id) DO UPDATE SET candidate_sha=excluded.candidate_sha,
    revision=excluded.revision,state='open',owner_telegram_id=excluded.owner_telegram_id,
    issued_at=excluded.issued_at,expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
    .run(candidate,revision,id,f.now-1,f.now+600,f.now);
  return {...f.serverEnv,OWNER_TELEGRAM_ID:String(id),V141_AUTHORIZATION_ENABLED:'true',
    REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',REBUILD_V140_RC_SHA:candidate,REBUILD_V140_RELEASE_REVISION:String(revision)};
}
function refundFixture(t){
  const f=cabinetSubscriptionFixture(t);
  f.sqlite.function('unixepoch',{deterministic:false,varargs:true},(...args)=>
    args.length===0||args[0]==='now'?Math.floor(Date.now()/1000):authoritySeconds(args[0]));
  for(const name of ['0069-v1.4.3-d1-compatibility.sql','0070-v1.4.3-refund-notification.sql',
    '0071-v1.4.3-refund-contract-retirement.sql'])
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  return f;
}

test('Mini App own-access prefetch retains every captured assertion and safely falls back from malformed acknowledgements',async t=>{
  const f=cabinetSubscriptionFixture(t);await f.paid();
  const context=await f.context(101,'access.read_own'),authorizer=createRuntimeAuthorizer(),batch=f.binding.batch.bind(f.binding);
  let mode='valid',prefetches=0;
  const isPrefetch=statements=>statements.length===32&&statements.some(statement=>statement.sql.includes('FROM capability_catalog'));
  f.binding.batch=async statements=>{
    if(!isPrefetch(statements))return batch(statements);
    prefetches++;
    if(mode==='lost')throw Error('offline read acknowledgement lost');
    const result=await batch(statements);
    return mode==='malformed'?[{success:true,results:[{snapshot:7}]},...result.slice(1)]:result;
  };
  const batched=await authorizer.authorize(context,null);
  assert.equal(prefetches,1);
  const captures=compileDecisionAssertions(readRuntimeAuthorization(batched).decision).assertions;
  await assertRuntimeAuthorizationFresh(batched);
  for(mode of ['malformed','lost']){
    const fallback=await authorizer.authorize(context,null);
    assert.deepEqual(compileDecisionAssertions(readRuntimeAuthorization(fallback).decision).assertions,captures);
    await assertRuntimeAuthorizationFresh(fallback);
  }
  assert.equal(prefetches,3);
  mode='valid';
  for(const operation of ['profile.read_own','billing.purchase_monthly'])
    await authorizer.authorize(await f.context(101,operation),null);
  assert.equal(prefetches,3,'only mini_app/access.read_own gains the new prefetch');
  f.sqlite.prepare('UPDATE users SET accepted_terms=0 WHERE telegram_id=101').run();
  await assert.rejects(assertRuntimeAuthorizationFresh(batched),{code:'authority_stale'});
});

test('own-access prefetch cannot hide a missing mandatory table or a changed captured package schema',async t=>{
  {
    const f=cabinetSubscriptionFixture(t),p=await f.paid(),before=money(f);
    f.sqlite.exec('DROP TABLE user_roles');
    await assert.rejects(recoveryToken(f,p,'missing-role-source-'+next()),{code:'authority_unavailable'});
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM subscription_provider_commands').get().n,0);
    assert.equal(money(f),before);
  }
  {
    const f=refundFixture(t);await f.paid();
    for(const name of ['0072-v1.4.4-package-contract.sql','0073-v1.4.4-package-payment-review.sql',
      '0074-v1.4.4-package-referral-compatibility.sql'])
      f.sqlite.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
    const bundle=await f.auth(),before=money(f);
    await assertRuntimeAuthorizationFresh(bundle);
    f.sqlite.exec('DROP TABLE subscription_package_periods');
    await assert.rejects(assertRuntimeAuthorizationFresh(bundle),{code:'authority_check_failed',status:503});
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM subscription_provider_commands').get().n,0);
    assert.equal(money(f),before);
  }
});

test('explicit missing recovery fences the original delayed POST with a never-attempted rejected tombstone',async t=>{
  const f=cabinetSubscriptionFixture(t),p=await f.paid(),key='abandon-original-'+next(),before=money(f);
  const delayed=await token(f,p,key);
  assert.equal((await status(f,p,key)).state,'missing');
  const result=await abandonOwnStarsSubscriptionCommandBeforeAttempt(await recoveryToken(f,p,key));
  assert.equal(result.status,'rejected');assert.equal(result.cancellationConfirmed,false);
  const row=f.sqlite.prepare('SELECT * FROM subscription_provider_commands').get();
  assert.equal(row.state,'rejected');assert.equal(row.attempted_count,0);assert.equal(row.attempted_at,null);
  let calls=0;
  try{await requestOwnStarsSubscriptionCommand(delayed,{telegramApi:async()=>{calls++;return true;}});}catch{}
  assert.equal(calls,0);
  assert.equal((await requestOwnStarsSubscriptionCommand(await token(f,p,key),{telegramApi:async()=>{calls++;return true;}})).status,'rejected');
  assert.equal(calls,0);assert.equal((await status(f,p,key)).state,'rejected');assert.equal(money(f),before);
});

test('an in-flight attempted provider command wins: recovery preserves it and does not create a tombstone',async t=>{
  const f=cabinetSubscriptionFixture(t),p=await f.paid(),key='attempt-wins-'+next(),before=money(f);
  let started,finish,calls=0;
  const startedPromise=new Promise(resolve=>{started=resolve;});
  const response=new Promise(resolve=>{finish=resolve;});
  const original=requestOwnStarsSubscriptionCommand(await token(f,p,key),{telegramApi:async()=>{calls++;started();return response;}});
  await startedPromise;
  const row=f.sqlite.prepare('SELECT * FROM subscription_provider_commands').get();
  const recovery=await abandonOwnStarsSubscriptionCommandBeforeAttempt(await recoveryToken(f,p,key));
  assert.equal(recovery.status,'pending');
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_provider_commands').get(),row);
  assert.equal((await status(f,p,key)).state,'pending');assert.equal(calls,1);
  finish(true);assert.equal((await original).status,'confirmed');
  assert.equal((await status(f,p,key)).state,'confirmed');assert.equal(money(f),before);
});

test('abandonment wins the actual admission race and the delayed original transaction cannot dispatch',async t=>{
  const f=cabinetSubscriptionFixture(t),p=await f.paid(),key='abandon-racing-admission-'+next(),before=money(f);
  const originalToken=await token(f,p,key);let hookCalls=0,providerCalls=0;
  f.binding.beforeBatch=async()=>{
    hookCalls++;
    assert.equal((await abandonOwnStarsSubscriptionCommandBeforeAttempt(await recoveryToken(f,p,key))).status,'rejected');
  };
  const original=await requestOwnStarsSubscriptionCommand(originalToken,{telegramApi:async()=>{providerCalls++;return true;}});
  assert.equal(hookCalls,1);assert.equal(providerCalls,0);assert.equal(original.status,'rejected');
  const rows=f.sqlite.prepare('SELECT * FROM subscription_provider_commands').all();
  assert.equal(rows.length,1);assert.equal(rows[0].attempted_count,0);assert.equal(money(f),before);
});

test('a previously admitted command can be rejected atomically before its attempted fence; provider is never called',async t=>{
  const f=cabinetSubscriptionFixture(t),p=await f.paid(),key='abandon-admitted-'+next(),before=money(f);
  const batch=f.binding.batch.bind(f.binding);let intercepted=false,calls=0;
  f.binding.batch=async statements=>{
    if(!intercepted&&statements.some(statement=>statement.sql.includes("SET state='attempted',attempted_count=1"))){
      intercepted=true;
      assert.equal(f.sqlite.prepare('SELECT state FROM subscription_provider_commands').get().state,'admitted');
      assert.equal((await abandonOwnStarsSubscriptionCommandBeforeAttempt(await recoveryToken(f,p,key))).status,'rejected');
    }
    return batch(statements);
  };
  const result=await requestOwnStarsSubscriptionCommand(await token(f,p,key),{telegramApi:async()=>{calls++;return true;}});
  assert.equal(intercepted,true);assert.equal(result.status,'rejected');assert.equal(calls,0);
  assert.equal(f.sqlite.prepare('SELECT attempted_count FROM subscription_provider_commands').get().attempted_count,0);
  assert.equal(money(f),before);
});

test('unknown outcomes and foreign actors cannot be abandoned or retried by recovery',async t=>{
  const f=cabinetSubscriptionFixture(t),p=await f.paid(),key='unknown-preserved-'+next();
  await requestOwnStarsSubscriptionCommand(await token(f,p,key),{telegramApi:async()=>{throw Error('response lost');}});
  const before=f.sqlite.prepare('SELECT * FROM subscription_provider_commands').get();
  assert.equal((await abandonOwnStarsSubscriptionCommandBeforeAttempt(await recoveryToken(f,p,key))).status,'unknown');
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_provider_commands').get(),before);
  await assert.rejects(recoveryToken(f,p,'foreign-abandonment-'+next(),202),{code:'subscription_contract_unavailable'});
});

test('refunded current revision with latest confirmed reenable recovers without granting producer eligibility',async t=>{
  const f=refundFixture(t),p=await f.paid(),realNow=Date.now;
  try{
    const confirmedAt=realNow();Date.now=()=>confirmedAt;
    assert.equal((await requestOwnStarsSubscriptionCommand(await token(f,p,'confirmed-cancel-'+next()),
      {telegramApi:async()=>true})).status,'confirmed');
    Date.now=()=>confirmedAt+2000;
    assert.equal((await requestOwnStarsSubscriptionCommand(await token(f,p,'confirmed-enable-'+next(),101,'reenable_renewal'),
      {telegramApi:async()=>true})).status,'confirmed');
    const refund=await requestStarsRefund(f.serverEnv,{adminTelegramId:900,
      telegramPaymentChargeId:p.update.message.successful_payment.telegram_payment_charge_id,
      reasonCode:'confirmed_customer_refund'},{telegramApi:async(_env,method)=>{
        assert.equal(method,'refundStarPayment');return true;
      }});
    assert.equal(refund.refunded,true);assert.equal(refund.renewalCancellation.status,'cooldown');
  }finally{Date.now=realNow;}
  const contract=f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(p.contract.contract_id);
  assert.equal(contract.revision,2);assert.equal(contract.retired_at,null);
  assert.equal(f.sqlite.prepare('SELECT status FROM subscription_access_grants').get().status,'refunded');
  const history=f.sqlite.prepare('SELECT * FROM subscription_provider_commands ORDER BY attempted_at').all();
  assert.equal(history.length,2);assert.equal(history.at(-1).action,'reenable_renewal');
  const key='refunded-enable-recovery-'+next(),before=money(f);
  await assert.rejects(token(f,p,key,101,'reenable_renewal'),{code:'subscription_bot_cancel_unverified'});
  const recovery=await recoveryToken(f,p,key,101,'reenable_renewal');let calls=0;
  await assert.rejects(requestOwnStarsSubscriptionCommand(recovery,{telegramApi:async()=>{calls++;return true;}}),
    {code:'untrusted_subscription_command'});
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM subscription_provider_commands').get().n,2);
  assert.equal((await abandonOwnStarsSubscriptionCommandBeforeAttempt(recovery)).status,'rejected');
  const row=f.sqlite.prepare('SELECT * FROM subscription_provider_commands WHERE state=\'rejected\'').get();
  assert.equal(row.action,'reenable_renewal');assert.equal(row.attempted_count,0);assert.equal(row.attempted_at,null);
  assert.equal(row.expected_contract_revision,2);
  assert.equal((await abandonOwnStarsSubscriptionCommandBeforeAttempt(await recoveryToken(f,p,key,101,'reenable_renewal'))).commandId,row.command_id);
  assert.equal((await requestOwnStarsSubscriptionCommand(await token(f,p,key,101,'reenable_renewal'),
    {telegramApi:async()=>{calls++;return true;}})).status,'rejected');
  assert.equal(calls,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM subscription_provider_commands').get().n,3);
  assert.equal(money(f),before);assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(p.contract.contract_id),contract);
});

test('admitted enable remains recoverable after refund invalidates producer eligibility, before attempted CAS',async t=>{
  const f=refundFixture(t),p=await f.paid(),key='refunded-admitted-enable-'+next();
  assert.equal((await requestOwnStarsSubscriptionCommand(await token(f,p,'prior-cancel-'+next()),
    {telegramApi:async()=>true})).status,'confirmed');
  const original=await token(f,p,key,101,'reenable_renewal'),batch=f.binding.batch.bind(f.binding);
  let intercepted=false,providerCalls=0,before;
  f.binding.batch=async statements=>{
    if(!intercepted&&statements.some(statement=>statement.sql.includes("SET state='attempted',attempted_count=1"))){
      intercepted=true;
      const refund=await requestStarsRefund(f.serverEnv,{adminTelegramId:900,
        telegramPaymentChargeId:p.update.message.successful_payment.telegram_payment_charge_id,
        reasonCode:'confirmed_customer_refund'},{telegramApi:async(_env,method)=>{
          assert.equal(method,'refundStarPayment');return true;
        }});
      assert.equal(refund.refunded,true);assert.equal(refund.renewalCancellation.status,'manual_review');
      before=money(f);
      await assert.rejects(token(f,p,key,101,'reenable_renewal'),{code:'subscription_reenable_unavailable'});
      assert.equal((await abandonOwnStarsSubscriptionCommandBeforeAttempt(await recoveryToken(f,p,key,101,'reenable_renewal'))).status,'rejected');
    }
    return batch(statements);
  };
  assert.equal((await requestOwnStarsSubscriptionCommand(original,{telegramApi:async()=>{providerCalls++;return true;}})).status,'rejected');
  assert.equal(intercepted,true);assert.equal(providerCalls,0);assert.equal(money(f),before);
  const rows=f.sqlite.prepare('SELECT * FROM subscription_provider_commands').all();
  assert.equal(rows.length,2);
  const abandoned=rows.find(row=>row.action==='reenable_renewal');
  assert.equal(abandoned.state,'rejected');assert.equal(abandoned.attempted_count,0);assert.equal(abandoned.attempted_at,null);
});

test('HTTP recover validates own principal, rejects invoice recovery and returns a terminal status without provider transport',async t=>{
  const f=cabinetSubscriptionFixture(t),p=await f.paid(),key='http-abandon-'+next();
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  const session=await f.session(101);
  assert.deepEqual(session.data.principal,{telegramId:101,botId:123456789});
  const env=httpEnv(f);
  const recovered=await f.call(101,'subscription/recover',{method:'POST',key,
    payload:{kind:'cancel',intent:intent(p)},customEnv:env});
  assert.equal(recovered.status,200,JSON.stringify(recovered.data));
  assert.equal(recovered.data.state,'rejected');assert.equal(recovered.data.authority,'worker');
  assert.equal(recovered.data.accessApplied,false);assert.equal(recovered.data.authorization.allowed,true);
  const invoice=await f.call(101,'subscription/recover',{method:'POST',key:'invalid-invoice-'+next(),customEnv:env,
    payload:{kind:'invoice',intent:{planCode:'dragon',recurringConsent:true,termsRevision:'2026-10-03.stars-recurring-v1',priceVersion:1}}});
  assert.equal(invoice.status,400);
  await f.session(202);
  const foreign=await f.call(202,'subscription/recover',{method:'POST',key:'foreign-http-'+next(),
    payload:{kind:'cancel',intent:intent(p)},customEnv:httpEnv(f,202)});
  assert.equal(foreign.status,409);
  assert.ok(['subscription_contract_unavailable','authority_stale'].includes(foreign.data.error));
  const rows=f.sqlite.prepare('SELECT telegram_id FROM subscription_provider_commands').all();
  assert.equal(rows.length,1);assert.equal(rows[0].telegram_id,101);
});

test('HTTP explicit recovery resolves an absent old revision without a fake attempt and fences a delayed original producer',async t=>{
  const f=cabinetSubscriptionFixture(t),p=await f.paid(),key='superseded-old-intent-'+next(),before=money(f);
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  const originalToken=await token(f,p,key);
  f.sqlite.prepare('UPDATE subscription_billing_contracts SET revision=revision+1,updated_at=MAX(updated_at,?) WHERE contract_id=?')
    .run(f.now,p.contract.contract_id);
  const env=httpEnv(f),body={kind:'cancel',intent:intent(p)};
  const recovered=await f.call(101,'subscription/recover',{method:'POST',key,payload:body,customEnv:env});
  assert.equal(recovered.status,200,JSON.stringify(recovered.data));
  assert.equal(recovered.data.state,'rejected');assert.equal(recovered.data.resolution,'superseded_before_admission');
  assert.equal(recovered.data.effectRecorded,false);assert.equal(recovered.data.attemptId,null);
  assert.equal(recovered.data.contractId,p.contract.contract_id);assert.equal(recovered.data.reviewRequired,false);
  let calls=0;
  await assert.rejects(requestOwnStarsSubscriptionCommand(originalToken,{telegramApi:async()=>{calls++;return true;}}));
  assert.equal(calls,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_provider_commands').get().n,0);
  assert.equal((await status(f,p,key)).state,'missing');assert.equal(money(f),before);
});
