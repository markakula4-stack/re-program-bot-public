import test from 'node:test';
import assert from 'node:assert/strict';
import { cabinetSubscriptionFixture,invoiceIntent,invoiceStatusIntent,next } from './helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import { readOwnSubscriptionOperationStatus,normalizeSubscriptionOperationStatusIntent } from '../src/v1.4.3/subscription-operation-status.mjs';
import { issueStarsRecurringInvoice,requestOwnStarsSubscriptionCommand } from '../src/v1.4.3/telegram-subscription-provider.mjs';
import { authorizeOwnStarsSubscriptionCommand } from '../src/v1.4.3/subscription-action-authority.mjs';

const status=(f,body,key,id=101)=>f.auth({id,payload:{subscriptionOperationStatus:body},key})
  .then(authorization=>readOwnSubscriptionOperationStatus({authorization}));
const money=f=>({ledger:f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY ledger_entry_id').all(),
  grants:f.sqlite.prepare('SELECT * FROM subscription_access_grants ORDER BY grant_id').all(),
  commands:f.sqlite.prepare('SELECT * FROM subscription_provider_commands ORDER BY command_id').all(),
  invoices:f.sqlite.prepare('SELECT * FROM subscription_invoice_requests ORDER BY request_id').all()});

test('lost confirmed invoice response reopens through exact own readonly status without another producer effect',async t=>{
  const f=cabinetSubscriptionFixture(t),key='lost-confirmed-invoice-'+next();let calls=0;
  const result=await issueStarsRecurringInvoice(await f.auth({operation:'billing.purchase_monthly',payload:invoiceIntent,key}),
    {telegramApi:async()=>{calls++;return 'https://t.me/$recoverOwnSavedInvoice';}});
  const before=money(f),auditAt=f.binding.audit.length;
  f.serverEnv={...f.serverEnv,REBUILD_V140_WRITES_ENABLED:'false'};
  const recovered=await status(f,invoiceStatusIntent,key);
  assert.equal(recovered.state,'confirmed');assert.equal(recovered.kind,'invoice');assert.equal(recovered.attemptId,result.requestId);
  assert.equal(recovered.invoiceUrl,'https://t.me/$recoverOwnSavedInvoice');assert.equal(recovered.contractId,result.contractId);
  assert.equal(recovered.effectRecorded,true);assert.equal(recovered.accessApplied,false);assert.equal(calls,1);
  assert.equal(recovered.actionAdmissionRequired,true);assert.deepEqual(money(f),before);
  assert.ok(f.binding.audit.slice(auditAt).every(row=>row.mode==='read'),'recovery uses only SELECT source checks');
  assert.deepEqual(await status(f,invoiceStatusIntent,key),recovered);
  for(const hidden of ['origin_order_id','request_sha256','telegram_id','external_invoice_payload','telegram_payment_charge_id'])
    assert.ok(!JSON.stringify(recovered).includes(hidden));
});

test('unknown provider outcome remains unknown on reopen and other own key or foreign principal receives no journal',async t=>{
  const f=cabinetSubscriptionFixture(t),key='unknown-invoice-'+next();let calls=0;
  const result=await issueStarsRecurringInvoice(await f.auth({operation:'billing.purchase_monthly',payload:invoiceIntent,key}),
    {telegramApi:async()=>{calls++;throw new Error('connection lost after possible effect');}});
  assert.equal(result.status,'unknown');
  const recovered=await status(f,invoiceStatusIntent,key);
  assert.equal(recovered.state,'unknown');assert.equal(recovered.invoiceUrl,null);assert.equal(recovered.reviewRequired,true);
  assert.equal(recovered.effectRecorded,true);assert.equal(recovered.accessApplied,false);assert.equal(calls,1);
  for(const [id,otherKey] of [[202,key],[101,'different-invoice-'+next()]]) {
    const missing=await status(f,invoiceStatusIntent,otherKey,id);assert.equal(missing.state,'missing');
    assert.equal(missing.attemptId,null);assert.equal(missing.contractId,null);assert.equal(missing.effectRecorded,false);
  }
});

test('confirmed own cancel status is bound to exact original intent and never claims a paid-time effect',async t=>{
  const f=cabinetSubscriptionFixture(t),paid=await f.paid(),key='lost-cancel-response-'+next();let calls=0;
  const intent={contractId:paid.contract.contract_id,expectedRevision:paid.contract.revision};
  const token=await authorizeOwnStarsSubscriptionCommand(await f.auth({key,payload:{subscriptionAction:'cancel_renewal',...intent}}));
  const command=await requestOwnStarsSubscriptionCommand(token,{telegramApi:async()=>{calls++;return true;}}),before=money(f);
  const recovered=await status(f,{kind:'cancel',intent},key);
  assert.equal(recovered.state,'confirmed');assert.equal(recovered.kind,'cancel');assert.equal(recovered.attemptId,command.commandId);
  assert.equal(recovered.invoiceUrl,null);assert.equal(recovered.accessApplied,false);assert.equal(calls,1);assert.deepEqual(money(f),before);
  await assert.rejects(status(f,{kind:'enable',intent},key),{code:'operation_status_intent_conflict'});
  await assert.rejects(status(f,{kind:'cancel',intent:{...intent,expectedRevision:intent.expectedRevision+1}},key),
    {code:'operation_status_intent_conflict'});
});

test('operation status rejects fabricated authorization and unbounded or mutable original intent',async t=>{
  const f=cabinetSubscriptionFixture(t);
  await assert.rejects(readOwnSubscriptionOperationStatus({authorization:{allowed:true}}),{code:'untrusted_runtime_authorization'});
  const auth=await f.auth({payload:{subscriptionOperationStatus:invoiceStatusIntent}});
  await assert.rejects(readOwnSubscriptionOperationStatus({authorization:{...auth}}),{code:'untrusted_runtime_authorization'});
  for(const body of [{...invoiceStatusIntent,telegramId:202},{kind:'invoice',intent:{...invoiceStatusIntent.intent,amountStars:1}},
    {kind:'invoice',intent:{...invoiceStatusIntent.intent,recurringConsent:false}},{kind:'cancel',intent:{contractId:'../foreign',expectedRevision:1}}])
    assert.throws(()=>normalizeSubscriptionOperationStatusIntent(body),{code:'invalid_operation_status'});
  await assert.rejects(readOwnSubscriptionOperationStatus({authorization:await f.auth()}),{code:'operation_status_principal_invalid'});
});
