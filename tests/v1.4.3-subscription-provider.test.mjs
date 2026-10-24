import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { createCustomerContext } from '../src/v1.4.1/trusted-context.mjs';
import { createRuntimeAuthorizer, requireRuntimeAuthorization } from '../src/v1.4.1/runtime-authorizer.mjs';
import { authorizeOwnStarsSubscriptionCommand } from '../src/v1.4.3/subscription-action-authority.mjs';
import { issueStarsRecurringInvoice, requestOwnStarsSubscriptionCommand } from '../src/v1.4.3/telegram-subscription-provider.mjs';
import { STARS_RECURRING_TERMS_REVISION as TERMS } from '../src/v1.4.3/recurring-provider-config.mjs';
import { handleStarsPreCheckoutQuery, recordStarsSuccessfulPayment, issueStarsInvoice,
  acceptStarsPurchaseTerms } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsPaidAccess, applyStarsCompensation } from '../src/v1.3.6/stars-access-runtime.mjs';
import { readSubscriptionData } from '../src/v1.4.2/subscription-read-model.mjs';

const MONTH=2592000; let seq=1433000; const next=()=>++seq;
function fixture(t) {
  const f=foundationFixture(t);
  for(const name of ['0026-v1.3.6-stars-core-foundation.sql','0027-v1.3.6-stars-access-and-reconciliation.sql',
    '0066-v1.4.3-subscription-lifecycle-foundation.sql','0067-v1.4.3-lifecycle-engine-binding.sql',
    '0068-v1.4.3-provider-and-review-binding.sql']) f.sqlite.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  f.serverEnv={...f.serverEnv,STARS_PAYMENTS_ENABLED:'true',STARS_BILLING_MODE:'prepaid',
    STARS_RECURRING_ENABLED:'true',STARS_RECURRING_PRICE_VERSION:'1',STARS_RECURRING_TERMS_REVISION:TERMS,
    STARS_PRICE_VERSION:'1',STARS_TERMS_REVISION:'2026-09-10.stars-v1',STARS_ROLLOUT_MODE:'all',
    STARS_INVOICE_SECRET:'offline-v143-subscription-provider-secret-more-than-32-characters'};
  for(const id of [101,202,303,404]) {
    f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(id);
    f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(id);
  }
  return f;
}
const invoiceIntent=(patch={})=>({action:'accept',requestedPlanCode:'dragon',billingMode:'recurring',
  recurringConsent:true,termsRevision:TERMS,priceVersion:1,...patch});
async function auth(f,{id=101,operation='billing.purchase_monthly',payload=invoiceIntent(),key='provider-offline-key-'+next()}={}) {
  if(!f.tokens.has(id))await f.session(id);
  const context=await createCustomerContext({binding:f.binding,env:f.serverEnv,sessionToken:f.tokens.get(id),
    channel:'mini_app',operation,requestPayload:payload,idempotencyKey:key});
  return requireRuntimeAuthorization(await createRuntimeAuthorizer().authorize(context,null));
}
const count=(f,table)=>f.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const ownOrder=(f,id)=>f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(id);
async function paid(f,{late=false}={}) {
  const invoice=await issueStarsRecurringInvoice(await auth(f),{telegramApi:async()=> 'https://t.me/$offlineInvoice'});
  assert.equal(invoice.status,'confirmed'); const order=ownOrder(f,invoice.orderId);
  const update={update_id:next(),pre_checkout_query:{id:'offline-query-'+next(),from:{id:101,is_bot:false},
    currency:'XTR',total_amount:order.amount_stars,invoice_payload:order.invoice_payload}};
  if(late) {const at=Math.max(Math.floor(Date.now()/1000),order.created_at);
    f.sqlite.prepare("UPDATE subscription_orders SET order_state='cancelled',closed_at=?,updated_at=?,state_revision=state_revision+1 WHERE order_id=?")
      .run(at,at,order.order_id);}
  else { const checkout=await handleStarsPreCheckoutQuery(f.serverEnv,update,{telegramApi:async()=>true});assert.equal(checkout.approved,true); }
  const charge='offline-first-charge-'+next(),expiration=f.now+MONTH;
  const payment={update_id:next(),message:{message_id:next(),from:{id:101,is_bot:false},chat:{id:101,type:'private'},
    successful_payment:{currency:'XTR',total_amount:order.amount_stars,invoice_payload:order.invoice_payload,
      telegram_payment_charge_id:charge,provider_payment_charge_id:'',is_recurring:true,is_first_recurring:true,
      subscription_expiration_date:expiration}}};
  const record=await recordStarsSuccessfulPayment(f.serverEnv,payment);
  const grant=await applyStarsPaidAccess(f.serverEnv,{orderId:record.orderId}); assert.equal(grant.accessApplied,true);
  const contract=f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(invoice.contractId);
  return {invoice,order,charge,expiration,contract,record};
}
async function command(f,contract,action='cancel_renewal',patch={}) {
  return authorizeOwnStarsSubscriptionCommand(await auth(f,{operation:'access.read_own',
    payload:{subscriptionAction:action,contractId:contract.contract_id,expectedRevision:contract.revision},...patch}));
}

test('recurring producer sends real fixed Telegram invoice arguments only after durable intent, without paid access',async t=>{
  const f=fixture(t); let calls=0;
  const result=await issueStarsRecurringInvoice(await auth(f),{telegramApi:async(_env,method,payload)=>{
    calls++; assert.equal(method,'createInvoiceLink'); assert.equal(payload.currency,'XTR');
    assert.equal(payload.subscription_period,MONTH); assert.deepEqual(payload.prices,[{label:'30 дней подписки',amount:499}]);
    assert.equal(payload.provider_token,''); assert.equal(count(f,'subscription_invoice_requests'),1);
    const journal=f.sqlite.prepare('SELECT * FROM subscription_invoice_requests').get();
    assert.equal(journal.state,'attempted'); assert.equal(journal.attempted_count,1);
    assert.equal(count(f,'subscription_billing_contracts'),1); assert.equal(count(f,'payment_ledger'),0);
    assert.equal(count(f,'subscription_access_grants'),0); return 'https://t.me/$offlineInvoice';
  }});
  assert.equal(result.status,'confirmed');assert.equal(result.accessApplied,false);assert.equal(calls,1);
  assert.equal(ownOrder(f,result.orderId).billing_mode,'recurring');
  assert.equal(f.sqlite.prepare('SELECT terms_revision FROM terms_acceptances').get().terms_revision,TERMS);
});

test('a genuine first recurring receipt enables own cancel with exact first charge and unchanged paid period',async t=>{
  const f=fixture(t), p=await paid(f), before=f.sqlite.prepare('SELECT * FROM subscriptions').get(); let calls=0;
  const result=await requestOwnStarsSubscriptionCommand(await command(f,p.contract),{telegramApi:async(_env,method,payload)=>{
    calls++;assert.equal(method,'editUserStarSubscription');assert.deepEqual(payload,{user_id:101,telegram_payment_charge_id:p.charge,is_canceled:true});
    assert.equal(f.sqlite.prepare('SELECT state FROM subscription_provider_commands').get().state,'attempted');return true;
  }});
  assert.equal(result.status,'confirmed');assert.equal(result.cancellationConfirmed,true);assert.equal(result.providerState,null);
  assert.equal(result.paidPeriodChanged,false);assert.equal(calls,1);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscriptions').get(),before);
  assert.equal(count(f,'payment_ledger'),1);assert.equal(count(f,'subscription_access_grants'),1);
});

test('native transport creates the professional product and original prepaid producer remains prepaid',async t=>{
  const f=fixture(t); let call;
  const result=await issueStarsRecurringInvoice(await auth(f,{payload:invoiceIntent({requestedPlanCode:'professional'})}),
    {fetchImpl:async(url,options)=>{call={url,payload:JSON.parse(options.body)};return new Response(JSON.stringify({ok:true,result:'https://t.me/$nativeOffline'}),{status:200});}});
  assert.equal(result.status,'confirmed');assert.ok(call.url.endsWith('/createInvoiceLink'));
  assert.equal(call.payload.prices[0].amount,249);assert.equal(call.payload.subscription_period,MONTH);
  await acceptStarsPurchaseTerms(f.serverEnv,{telegramId:202,telegramUpdateId:next()});let prepaidPayload;
  const prepaid=await issueStarsInvoice(f.serverEnv,{telegramId:202,requestedPlanCode:'professional',telegramUpdateId:next()},
    {telegramApi:async(_env,method,payload)=>{assert.equal(method,'sendInvoice');prepaidPayload=payload;return {message_id:next()};}});
  assert.equal(ownOrder(f,prepaid.orderId).billing_mode,'prepaid');assert.equal(prepaidPayload.subscription_period,undefined);
});

test('invoice duplicate, refreshed restart and simultaneous same intent consume a single provider attempt',async t=>{
  const f=fixture(t), key='same-invoice-operation-'+next(), a=await auth(f,{key}), b=await auth(f,{key}); let calls=0;
  const options={telegramApi:async()=>{calls++;return 'https://t.me/$singleInvoice';}};
  const results=await Promise.all([issueStarsRecurringInvoice(a,options),issueStarsRecurringInvoice(b,options)]);
  assert.equal(calls,1);assert.equal(count(f,'subscription_invoice_requests'),1);assert.equal(count(f,'subscription_billing_contracts'),1);
  const restart=await issueStarsRecurringInvoice(await auth(f,{key}),options);
  assert.equal(restart.status,'confirmed');assert.equal(restart.invoiceUrl,'https://t.me/$singleInvoice');
  assert.equal(results[0].requestId,restart.requestId);assert.equal(results[1].requestId,restart.requestId);assert.equal(calls,1);
});

test('invoice lost or malformed response is durable unknown across restart, while provider rejection is durable rejected',async t=>{
  for(const failure of ['lost','malformed','rejected']) {
    const f=fixture(t),key='invoice-outcome-'+failure+'-'+next();let calls=0;
    const options={fetchImpl:async()=>{calls++;if(failure==='lost')throw new Error('connection lost after Telegram may accept');
      return new Response(failure==='malformed'?'invalid-json':JSON.stringify({ok:false,error_code:400}),{status:failure==='rejected'?400:200});}};
    const result=await issueStarsRecurringInvoice(await auth(f,{key}),options);
    assert.equal(result.status,failure==='rejected'?'rejected':'unknown');assert.equal(result.invoiceUrl,null);
    const again=await issueStarsRecurringInvoice(await auth(f,{key}),options);assert.equal(again.status,result.status);assert.equal(calls,1);
    assert.equal(count(f,'payment_ledger'),0);assert.equal(count(f,'subscription_access_grants'),0);
  }
});

// Actual parser and durable command settlement, with no provider replay.
test('numeric Telegram rejection preserves HTTP and safe detail in the exact private command audit',async t=>{
  const f=fixture(t),p=await paid(f),key='private-command-diagnostic-'+next(),token=await command(f,p.contract,'cancel_renewal',{key});
  let calls=0;
  const result=await requestOwnStarsSubscriptionCommand(token,{fetchImpl:async()=>{calls++;return Response.json({ok:false,error_code:400,
    description:'Bad Request: subscription cannot be canceled for '+p.charge+' user 101 https://private.example/token'},{status:502});}});
  assert.equal(result.status,'rejected');assert.equal(result.cancellationConfirmed,false);assert.equal(calls,1);
  const row=f.sqlite.prepare('SELECT * FROM subscription_provider_commands').get(),audit=f.sqlite.prepare(
    "SELECT * FROM admin_audit_log WHERE action='subscription_provider_diagnostic' AND entity_id=?").get(row.command_id);
  const detail=JSON.parse(audit.details);assert.equal(detail.httpStatus,502);assert.equal(detail.apiErrorCode,400);
  assert.match(detail.descriptionSafe,/subscription cannot be canceled/);assert.ok(detail.descriptionSha256.length===64);
  assert.ok(!audit.details.includes(p.charge));assert.ok(!audit.details.includes('private.example'));
  const repeat=await requestOwnStarsSubscriptionCommand(await command(f,p.contract,'cancel_renewal',{key}),{telegramApi:async()=>assert.fail('provider replay')});
  assert.equal(repeat.status,'rejected');assert.equal(f.sqlite.prepare(
    "SELECT count(*) n FROM admin_audit_log WHERE action='subscription_provider_diagnostic' AND entity_id=?").get(row.command_id).n,1);
});


test('invoice effect guard rejects stale actor and failed attempt transaction before any external call',async t=>{
  for(const failure of ['stale','transaction']) {
    const f=fixture(t),authorization=await auth(f);let calls=0;
    if(failure==='stale') f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=101').run();
    else f.binding.failStatement=sql=>sql.includes("SET state='attempted',attempted_count=1");
    await assert.rejects(issueStarsRecurringInvoice(authorization,{telegramApi:async()=>{calls++;return 'https://t.me/$mustNotCall';}}));
    assert.equal(calls,0);assert.equal(count(f,'payment_ledger'),0);
    if(failure==='transaction')assert.equal(f.sqlite.prepare('SELECT state,attempted_count FROM subscription_invoice_requests').get().attempted_count,0);
  }
});

test('recurring producer rejects copied authority, absent consent, unreleased quote and disabled own rollout',async t=>{
  const f=fixture(t);await assert.rejects(issueStarsRecurringInvoice({version:1}),/untrusted_runtime_authorization/);
  for(const payload of [invoiceIntent({recurringConsent:false}),invoiceIntent({termsRevision:'2026-09-10.stars-v1'}),
    invoiceIntent({priceVersion:2}),invoiceIntent({amountStars:1})]) await assert.rejects(auth(f,{payload}));
  f.serverEnv={...f.serverEnv,STARS_RECURRING_ENABLED:'false'};await assert.rejects(auth(f));
  f.serverEnv={...f.serverEnv,STARS_RECURRING_ENABLED:'true',STARS_ROLLOUT_MODE:'off'};await assert.rejects(auth(f));
  assert.equal(count(f,'subscription_invoice_requests'),0);
});

test('cancel duplicate clicks and restart share one exact confirmed first-charge command',async t=>{
  const f=fixture(t),p=await paid(f),key='cancel-same-operation-'+next();
  const tokens=await Promise.all([command(f,p.contract,'cancel_renewal',{key}),command(f,p.contract,'cancel_renewal',{key})]);let calls=0;
  const options={telegramApi:async()=>{calls++;return true;}};
  const results=await Promise.all(tokens.map(token=>requestOwnStarsSubscriptionCommand(token,options)));
  const again=await requestOwnStarsSubscriptionCommand(await command(f,p.contract,'cancel_renewal',{key}),options);
  assert.equal(again.status,'confirmed');assert.equal(results[0].commandId,again.commandId);assert.equal(results[1].commandId,again.commandId);
  assert.equal(count(f,'subscription_provider_commands'),1);assert.equal(calls,1);
  const journal=f.sqlite.prepare('SELECT * FROM subscription_provider_commands').get();
  const ack=f.sqlite.prepare('SELECT * FROM subscription_provider_events WHERE event_id=?').get(journal.acknowledgement_event_id);
  assert.equal(ack.command_id,journal.command_id);assert.equal(ack.event_type,'command_confirmed');
  assert.equal(ack.source,'provider_response');assert.equal(ack.provider_state,null);assert.equal(journal.first_payment_ledger_entry_id,p.record.ledgerEntryId);
});

test('a terminal command replay refreshes a token captured before the original provider attempt',async t=>{
  const f=fixture(t),p=await paid(f),key='cancel-captured-before-attempt-'+next(),
    paidBefore=f.sqlite.prepare('SELECT * FROM subscriptions').get();
  const tokens=await Promise.all([command(f,p.contract,'cancel_renewal',{key}),command(f,p.contract,'cancel_renewal',{key})]);
  let calls=0;const options={telegramApi:async()=>{calls++;return true;}};
  const first=await requestOwnStarsSubscriptionCommand(tokens[0],options);
  assert.equal(first.status,'confirmed');
  const replay=await requestOwnStarsSubscriptionCommand(tokens[1],options);
  assert.deepEqual(replay,first);assert.equal(calls,1);assert.equal(count(f,'subscription_provider_commands'),1);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscriptions').get(),paidBefore);
  assert.equal(count(f,'payment_ledger'),1);assert.equal(count(f,'subscription_access_grants'),1);
});

test('control lost response and acknowledged SQL failure remain unknown and cannot automatically repeat',async t=>{
  for(const failure of ['lost','ack-write']) {
    const f=fixture(t),p=await paid(f),key='cancel-unknown-'+failure+'-'+next();let calls=0;
    const options={telegramApi:async()=>{calls++;if(failure==='lost')throw Object.assign(new Error('lost'),{ambiguous:true});
      f.binding.failStatement=sql=>sql.includes('INSERT INTO subscription_provider_events');return true;}};
    const result=await requestOwnStarsSubscriptionCommand(await command(f,p.contract,'cancel_renewal',{key}),options);
    assert.equal(result.status,'unknown');assert.equal(result.cancellationConfirmed,false);
    const again=await requestOwnStarsSubscriptionCommand(await command(f,p.contract,'cancel_renewal',{key}),options);
    assert.equal(again.status,'unknown');assert.equal(calls,1);assert.equal(count(f,'payment_ledger'),1);
  }
});

test('control admission rejects foreign user, ordinary access authorization and JSON copy',async t=>{
  const f=fixture(t),p=await paid(f);
  await assert.rejects(command(f,p.contract,'cancel_renewal',{id:202}),/subscription_contract_unavailable/);
  const authorization=await auth(f,{operation:'access.read_own',payload:{subscriptionAction:'cancel_renewal',contractId:p.contract.contract_id,expectedRevision:p.contract.revision}});
  await assert.rejects(requestOwnStarsSubscriptionCommand(authorization),/untrusted_subscription_command/);
  const token=await authorizeOwnStarsSubscriptionCommand(authorization);
  await assert.rejects(requestOwnStarsSubscriptionCommand(JSON.parse(JSON.stringify(token))),/untrusted_subscription_command/);
  assert.equal(count(f,'subscription_provider_commands'),0);
});

test('a terminal-origin genuine first charge uses the immutable imported charge for own cancellation',async t=>{
  const f=fixture(t),p=await paid(f,{late:true});assert.notEqual(p.record.orderId,p.order.order_id);let payload;
  const result=await requestOwnStarsSubscriptionCommand(await command(f,p.contract),{telegramApi:async(_env,_method,body)=>{payload=body;return true;}});
  assert.equal(result.status,'confirmed');assert.equal(payload.telegram_payment_charge_id,p.charge);
  assert.equal(count(f,'payment_ledger'),1);assert.equal(count(f,'subscription_access_grants'),1);
});

test('cancel is allowed for a blocked owner while re-enable preserves strict account and own bot-cancel proof',async t=>{
  const f=fixture(t),p=await paid(f);await assert.rejects(command(f,p.contract,'reenable_renewal'));
  f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=101').run();
  const cancelled=await requestOwnStarsSubscriptionCommand(await command(f,p.contract),{telegramApi:async()=>true});
  assert.equal(cancelled.status,'confirmed');await assert.rejects(command(f,p.contract,'reenable_renewal'));
  f.sqlite.prepare('UPDATE users SET is_blocked=0 WHERE telegram_id=101').run();
  const before=f.sqlite.prepare('SELECT * FROM subscriptions').get();let body;
  const allowed=await requestOwnStarsSubscriptionCommand(await command(f,p.contract,'reenable_renewal'),{telegramApi:async(_env,_method,payload)=>{body=payload;return true;}});
  assert.equal(allowed.status,'confirmed');assert.equal(allowed.reenableAllowed,true);assert.equal(allowed.cancellationConfirmed,false);
  assert.equal(body.is_canceled,false);assert.equal(allowed.providerState,null);assert.equal(allowed.paidPeriodChanged,false);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscriptions').get(),before);assert.equal(count(f,'payment_ledger'),1);
});

test('own GET after confirmed cancel and restart preserves paid residue; enable acknowledgement remains permission only',async t=>{
  const f=fixture(t),p=await paid(f);
  await requestOwnStarsSubscriptionCommand(await command(f,p.contract),{telegramApi:async()=>true});
  const read=()=>auth(f,{operation:'access.read_own',payload:{}}).then(authorization=>readSubscriptionData({authorization}));
  const first=await read(),restart=await read();
  for(const data of [first,restart]) {
    assert.equal(data.lifecycle.renewalState,'canceled');assert.equal(data.lifecycle.state,'cancel_at_period_end');
    assert.equal(data.lifecycle.paidAccess,true);assert.equal(data.access.current.planCode,'dragon');
    assert.equal(data.access.current.expiresAt,p.expiration);
  }
  await requestOwnStarsSubscriptionCommand(await command(f,p.contract,'reenable_renewal'),{telegramApi:async()=>true});
  const enabled=await read();assert.equal(enabled.lifecycle.renewalState,'unknown');assert.equal(enabled.lifecycle.paidAccess,true);
  assert.equal(enabled.access.current.expiresAt,p.expiration);assert.equal(enabled.lifecycle.nextChargeAt,null);
});

test('later recurring charge never replaces the immutable first charge used by provider control',async t=>{
  const f=fixture(t),p=await paid(f),laterCharge='offline-renewal-charge-'+next();
  const payment={update_id:next(),message:{message_id:next(),from:{id:101,is_bot:false},chat:{id:101,type:'private'},
    successful_payment:{currency:'XTR',total_amount:499,invoice_payload:p.order.invoice_payload,
      telegram_payment_charge_id:laterCharge,provider_payment_charge_id:'',is_recurring:true,is_first_recurring:false,
      subscription_expiration_date:p.expiration+MONTH}}};
  const renewed=await recordStarsSuccessfulPayment(f.serverEnv,payment);await applyStarsPaidAccess(f.serverEnv,{orderId:renewed.orderId});
  const before=f.sqlite.prepare('SELECT current_period_end FROM subscriptions').get();let body;
  const result=await requestOwnStarsSubscriptionCommand(await command(f,p.contract),{telegramApi:async(_env,_method,payload)=>{body=payload;return true;}});
  assert.equal(result.status,'confirmed');assert.equal(body.telegram_payment_charge_id,p.charge);assert.notEqual(body.telegram_payment_charge_id,laterCharge);
  assert.deepEqual(f.sqlite.prepare('SELECT current_period_end FROM subscriptions').get(),before);assert.equal(count(f,'payment_ledger'),2);
});

test('zero affected attempt updates and real transaction failure cannot dispatch a subscription control',async t=>{
  for(const failure of ['zero','throw']) {
    const f=fixture(t),p=await paid(f),token=await command(f,p.contract);let calls=0;
    if(failure==='throw')f.binding.failStatement=sql=>sql.includes("SET state='attempted',attempted_count=1");
    else {const prepare=f.binding.prepare.bind(f.binding);f.binding.prepare=sql=>prepare(sql.includes("UPDATE subscription_provider_commands SET state='attempted'")?sql+' AND 0':sql);}
    await assert.rejects(requestOwnStarsSubscriptionCommand(token,{telegramApi:async()=>{calls++;return true;}}));
    assert.equal(calls,0);const row=f.sqlite.prepare('SELECT state,attempted_count FROM subscription_provider_commands').get();
    assert.equal(row.state,'admitted');assert.equal(row.attempted_count,0);
  }
});

test('reenable effect rechecks compensation after its own durable admission',async t=>{
  const f=fixture(t),p=await paid(f);await requestOwnStarsSubscriptionCommand(await command(f,p.contract),{telegramApi:async()=>true});
  const token=await command(f,p.contract,'reenable_renewal'),batch=f.binding.batch.bind(f.binding);let calls=0,changed=false;
  f.binding.batch=async statements=>{
    const result=await batch(statements);
    if(!changed&&statements.some(statement=>statement.sql.includes('INSERT INTO subscription_provider_commands'))) {
      changed=true;await applyStarsCompensation(f.serverEnv,{telegramPaymentChargeId:p.charge,compensationType:'refund',telegramUpdateId:next()});
    }
    return result;
  };
  let outcome;
  try {outcome=await requestOwnStarsSubscriptionCommand(token,{telegramApi:async()=>{calls++;return true;}});}catch {}
  assert.equal(calls,0);assert.equal(changed,true);assert.equal(count(f,'payment_ledger'),2);
  assert.equal(f.sqlite.prepare('SELECT status FROM subscription_access_grants').get().status,'refunded');
  if(outcome) {assert.equal(outcome.cancellationConfirmed,false);assert.equal(outcome.reenableAllowed,false);
    assert.ok(['unknown','pending','admitted'].includes(outcome.status));}
});

test('existing dedicated terms acceptance is reused only with explicit consent for a new quote',async t=>{
  const f=fixture(t),acceptanceId='offline-existing-dedicated-acceptance';
  f.sqlite.prepare("INSERT INTO terms_acceptances VALUES(?,?,?,'stars_purchase',?,NULL,?)")
    .run(acceptanceId,101,TERMS,'a'.repeat(64),f.now-1);
  const result=await issueStarsRecurringInvoice(await auth(f),{telegramApi:async()=> 'https://t.me/$existingTerms'});
  assert.equal(result.status,'confirmed');assert.equal(count(f,'terms_acceptances'),1);
  assert.equal(f.sqlite.prepare('SELECT terms_acceptance_id FROM subscription_billing_contracts').get().terms_acceptance_id,acceptanceId);
});

test('control checks the same contract epoch immediately before provider dispatch',async t=>{
  const f=fixture(t),p=await paid(f),token=await command(f,p.contract),batch=f.binding.batch.bind(f.binding);let calls=0,changed=false;
  f.binding.batch=async statements=>{
    const result=await batch(statements);
    if(!changed&&statements.some(statement=>statement.sql.includes("UPDATE subscription_provider_commands SET state='attempted'"))) {
      changed=true;f.sqlite.prepare('UPDATE subscription_billing_contracts SET revision=revision+1 WHERE contract_id=?').run(p.contract.contract_id);
    }
    return result;
  };
  const result=await requestOwnStarsSubscriptionCommand(token,{telegramApi:async()=>{calls++;return true;}});
  assert.equal(changed,true);assert.equal(calls,0);assert.equal(result.status,'unknown');assert.equal(result.cancellationConfirmed,false);
});

test('terminal invoice and command replay recheck the authenticated session before exposing the own receipt',async t=>{
  for(const kind of ['invoice','command']) {
    const f=fixture(t),key='replay-session-fence-'+kind+'-'+next();let calls=0,replay;
    if(kind==='invoice') {
      const options={telegramApi:async()=>{calls++;return 'https://t.me/$receiptFence';}};
      await issueStarsRecurringInvoice(await auth(f,{key}),options);const captured=await auth(f,{key});
      replay=()=>issueStarsRecurringInvoice(captured,options);
    } else {
      const p=await paid(f),options={telegramApi:async()=>{calls++;return true;}};
      await requestOwnStarsSubscriptionCommand(await command(f,p.contract,'cancel_renewal',{key}),options);
      const captured=await command(f,p.contract,'cancel_renewal',{key});replay=()=>requestOwnStarsSubscriptionCommand(captured,options);
    }
    f.binding.beforeBatch=()=>f.sqlite.prepare("UPDATE mini_app_sessions SET status='revoked',revoked_at=? WHERE telegram_id=101")
      .run(Math.floor(Date.now()/1000));
    await assert.rejects(replay());assert.equal(calls,1);
  }
});
