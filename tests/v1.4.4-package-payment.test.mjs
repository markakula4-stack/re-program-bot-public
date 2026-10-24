import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { foundationFixture, signedInitData } from './helpers/v1.4.1-fixtures.mjs';
import { createCustomerContext, createFinancialCustomerContext } from '../src/v1.4.1/trusted-context.mjs';
import { authoritySeconds, createAuthorityResolver } from '../src/v1.4.1/authority-resolver.mjs';
import { buildStarsInvoicePayload } from '../src/v1.3.6/stars-core-foundation.mjs';
import { acceptStarsPurchaseTerms, recordStarsSuccessfulPayment, handleStarsPreCheckoutQuery } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsPaidAccess } from '../src/v1.3.6/stars-access-runtime.mjs';
import { PACKAGE_DURATIONS, PACKAGE_CANONICAL_PRICES, resolveOwnPackagePeriodAuthority,
  createServerPackageQuote, projectPackagePaidBoundary } from '../src/v1.4.4/package-contract.mjs';
import { issuePackageInvoice, applyVerifiedPackagePaidAccess, readPackageRetainedReview,
  isStoredPackageInvoice, isStoredPackageFinancialInvoice } from '../src/v1.4.4/package-payment-runtime.mjs';
import { inspectPackagePaymentReviewSchema, PACKAGE_SCHEMA, PACKAGE_PAYMENT_REVIEW_SCHEMA } from '../src/v1.4.4/package-schema.mjs';
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const stamp = seconds => new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
const resolver=createAuthorityResolver();let sequence=2440000;
function fixture(t, patch = {}) {
  const f = foundationFixture(t);
  f.sqlite.function('current_timestamp', { deterministic: false }, () => stamp(f.now));
  f.sqlite.function('unixepoch', { deterministic: false, varargs: true }, (...args) =>
    !args.length || args[0] === 'now' ? f.now : authoritySeconds(args[0]));
  for (const name of ['0026-v1.3.6-stars-core-foundation.sql', '0027-v1.3.6-stars-access-and-reconciliation.sql',
    '0066-v1.4.3-subscription-lifecycle-foundation.sql', '0067-v1.4.3-lifecycle-engine-binding.sql',
    '0068-v1.4.3-provider-and-review-binding.sql', '0069-v1.4.3-d1-compatibility.sql',
    '0070-v1.4.3-refund-notification.sql', '0071-v1.4.3-refund-contract-retirement.sql', '0072-v1.4.4-package-contract.sql', '0073-v1.4.4-package-payment-review.sql'])
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  f.serverEnv = { ...f.serverEnv, STARS_PAYMENTS_ENABLED: 'true', STARS_BILLING_MODE: 'prepaid',
    STARS_PRICE_VERSION: '1', STARS_TERMS_REVISION: '2026-09-10.stars-v1', STARS_RECURRING_ENABLED: 'true',
    STARS_INVOICE_SECRET: 'synthetic-v144-offline-only-secret-longer-than-thirty-two-characters',
    STARS_ROLLOUT_MODE: 'allowlist', STARS_ROLLOUT_ALLOWLIST: '900',
    STARS_PACKAGES_ENABLED: 'true', STARS_PACKAGE_3M_ENABLED: 'true', WEBHOOK_SECRET:'synthetic-v144-webhook-secret', ...patch };
  for (const plan of ['professional', 'dragon']) for (const [code, period] of Object.entries(PACKAGE_DURATIONS))
    f.sqlite.prepare(`INSERT INTO price_book(price_id,price_version,plan_code,currency,amount_stars,
      access_seconds,billing_mode,publication_state,terms_revision,valid_from,created_at)
      VALUES(?,1,?,'XTR',?,?,'prepaid','approved',?,?,?)`).run(`${plan}-${period.durationDays}d-prepaid-v1`,
      plan, PACKAGE_CANONICAL_PRICES[plan][code], period.periodSeconds,
      f.serverEnv.STARS_TERMS_REVISION, f.now - 10000, f.now - 10000);
  for (const actorId of [101, 900]) {
    f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(actorId);
    f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(actorId);
  }
  return f;
}
async function own(f, actorId = 900) {
  const actor = await resolver.resolveActor(await f.context(actorId, 'access.read_own'));
  const verifiedPackagePeriods = await resolveOwnPackagePeriodAuthority({ actor, nowSec: f.now });
  return { actor, verifiedPackagePeriods, nowSec: f.now };
}
const quote = (scope, plan = 'professional', code = '3m') => createServerPackageQuote({ ...scope,
  request: { requestedPlanCode: plan, packageCode: code } });

async function seedOrder(f, { plan = 'professional', mode = 'prepaid', days = 30, createdAt = f.now - 100,
  prepaidState = 'precheckout_ok' } = {}) {
  const price = f.sqlite.prepare('SELECT * FROM price_book WHERE price_id=?').get(`${plan}-${days}d-${mode}-v1`);
  await acceptStarsPurchaseTerms({ ...f.serverEnv, STARS_TERMS_REVISION: price.terms_revision },
    { telegramId: 900, telegramUpdateId: ++sequence, acceptedAt: createdAt - 1 });
  const orderId = crypto.randomUUID();
  const payload = await buildStarsInvoicePayload({ invoiceSecret: f.serverEnv.STARS_INVOICE_SECRET,
    orderId, telegramId: 900, priceId: price.price_id });
  f.sqlite.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,
    currency,amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,
    expires_at,precheckout_approved_at,updated_at) VALUES(?,900,?,1,?,'XTR',?,?,?,?,?,?,?,?,?,?)`)
    .run(orderId, price.price_id, plan, price.amount_stars, price.access_seconds, mode, price.terms_revision,
      payload, prepaidState, createdAt, f.now + 600, prepaidState === 'precheckout_ok' ? createdAt + 1 : null, createdAt + 1);
  return { orderId, payload, price, createdAt };
}
async function seedCurrent(f, { plan = 'professional', mode = 'prepaid' } = {}) {
  const order = await seedOrder(f, { plan, mode });
  if (mode === 'recurring') {
    const acceptance = f.sqlite.prepare('SELECT acceptance_id FROM terms_acceptances WHERE telegram_id=900 AND terms_revision=?')
      .get(order.price.terms_revision);
    order.contractId = crypto.randomUUID();
    f.sqlite.prepare(`INSERT INTO subscription_billing_contracts(contract_id,telegram_id,plan_code,price_id,
      origin_order_id,external_invoice_payload,external_payload_sha256,terms_revision,terms_acceptance_id,
      billing_mode,period_seconds,currency,amount_stars,created_at,updated_at)
      VALUES(?,900,?,?,?,?,?,?,?,'recurring',2592000,'XTR',?,?,?)`).run(order.contractId, plan,
      order.price.price_id, order.orderId, order.payload, hash(order.payload), order.price.terms_revision,
      acceptance.acceptance_id, order.price.amount_stars, order.createdAt, order.createdAt);
  }
  const paidAt = f.now - 10, end = paidAt + 2592000;
  const recorded = await recordStarsSuccessfulPayment(f.serverEnv, { update_id: ++sequence, message: {
    message_id: ++sequence, date: paidAt, from: { id: 900, is_bot: false }, chat: { id: 900, type: 'private' },
    successful_payment: { currency: 'XTR', total_amount: order.price.amount_stars, invoice_payload: order.payload,
      telegram_payment_charge_id: 'synthetic-v144-monthly-' + sequence, provider_payment_charge_id: '',
      ...(mode === 'recurring' ? { is_recurring: true, is_first_recurring: true, subscription_expiration_date: end } : {}) } } },
  { receivedAt: paidAt });
  const applied = await applyStarsPaidAccess(f.serverEnv, { orderId: recorded.orderId, appliedAt: paidAt });
  assert.equal(applied.accessApplied, true);
  return { ...order, recorded, applied, paidAt, end };
}


function cancellation(f, current, { state = 'confirmed' } = {}) {
  const contract = f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(current.contractId);
  const commandId = crypto.randomUUID(), eventId = crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO subscription_provider_commands(command_id,idempotency_key,contract_id,telegram_id,
    action,desired_auto_renew,expected_contract_revision,first_payment_ledger_entry_id,request_sha256,created_at,updated_at)
    VALUES(?,?,?,900,'cancel_renewal',0,?,?,?,?,?)`).run(commandId, 'synthetic-v144-cancel:' + commandId,
      current.contractId, contract.revision, contract.first_payment_ledger_entry_id, hash('synthetic cancellation'), f.now, f.now);
  f.sqlite.prepare(`UPDATE subscription_provider_commands SET state='attempted',attempted_count=1,attempted_at=?,revision=revision+1,
    updated_at=? WHERE command_id=?`).run(f.now, f.now, commandId);
  f.sqlite.prepare(`INSERT INTO subscription_provider_events(event_id,event_key,contract_id,command_id,telegram_id,
    event_type,source,actor_type,reason_code,evidence_sha256,received_at) VALUES(?,?,?,?,900,?,?,'system',?,?,?)`)
    .run(eventId, 'synthetic-v144-ack:' + commandId, current.contractId, commandId,
      state === 'confirmed' ? 'command_confirmed' : 'command_unknown', state === 'confirmed' ? 'provider_response' : 'system',
      state === 'confirmed' ? 'telegram_command_acknowledged' : 'telegram_provider_unknown',
      hash(JSON.stringify([commandId, 'cancel_renewal', state, ''])), f.now);
  f.sqlite.prepare(`UPDATE subscription_provider_commands SET state=?,acknowledgement_event_id=?,revision=revision+1,
    updated_at=? WHERE command_id=?`).run(state, state === 'confirmed' ? eventId : null, f.now, commandId);
  return { commandId, eventId };
}

async function accepted(f){await acceptStarsPurchaseTerms(f.serverEnv,{telegramId:900,telegramUpdateId:++sequence,acceptedAt:f.now-1});}
function transport(f){const calls=[];return {calls,telegramApi:async(_env,method,payload)=>{calls.push({method,payload});return method==='createInvoiceLink'?'https://t.me/$synthetic-v144-invoice-'+ ++sequence:{message_id:++sequence};}};}
async function issue(f,{plan='professional',code='3m',actor=null,provider=transport(f)}={}){
 await accepted(f);actor??=(await own(f)).actor;
 const result=await issuePackageInvoice({actor,request:{requestedPlanCode:plan,packageCode:code},telegramUpdateId:++sequence,createdAt:f.now},provider);
 const order=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(result.orderId);
 return {result,order,provider,actor};
}
async function financial(f,event){
 const token='synthetic-financial-claim-'+event.update_id;
 f.sqlite.prepare(`INSERT OR IGNORE INTO telegram_update_receipts(update_id,update_type,actor_id,claim_token,received_at,lease_expires_at)
  VALUES(?,'message',900,?,?,?)`).run(event.update_id,token,f.now,f.now+300);
 const request=new Request(f.serverEnv.MINI_APP_ORIGIN+'/webhook',{method:'POST',headers:{'Content-Type':'application/json',
  'X-Telegram-Bot-Api-Secret-Token':f.serverEnv.WEBHOOK_SECRET},body:JSON.stringify(event)});
 const context=await createFinancialCustomerContext({binding:f.binding,env:f.serverEnv,webhookRequest:request,receiptClaimToken:token,nowSeconds:f.now});
 return {packageFinancialContext:context,packageActor:await resolver.resolveActor(context)};
}
async function record(f,event,{withoutActor=false}={}){
 const options=await financial(f,event);if(withoutActor)options.packageActor=null;
 return recordStarsSuccessfulPayment(f.serverEnv,event,{receivedAt:f.now,...options});
}
async function precheck(f,issued,{provider=issued.provider}={}){
 const event={update_id:++sequence,pre_checkout_query:{id:'synthetic-v144-query-'+sequence,
  from:{id:900,is_bot:false},currency:'XTR',total_amount:issued.order.amount_stars,invoice_payload:issued.order.invoice_payload}};
 return handleStarsPreCheckoutQuery(f.serverEnv,event,{nowSeconds:f.now,...await financial(f,event),...provider});
}

function payment(f,issued,{charge='synthetic-v144-charge-'+ ++sequence,at=f.now,amount=issued.order.amount_stars}={}){
 return {update_id:++sequence,message:{message_id:++sequence,date:at,from:{id:900,is_bot:false},chat:{id:900,type:'private'},
 successful_payment:{currency:'XTR',total_amount:amount,invoice_payload:issued.order.invoice_payload,
 telegram_payment_charge_id:charge,provider_payment_charge_id:''}}};
}
async function pay(f,issued,patch={}){return record(f,payment(f,issued,patch));}

test('actual old invoice/precheckout/payment delegation creates one package and replay never extends it',async t=>{
 const f=fixture(t),i=await issue(f);assert.equal(i.provider.calls[0].method,'createInvoiceLink');assert.match(i.result.invoiceURL,/^https:\/\/t\.me\/\$/u);
 assert.equal(i.provider.calls[0].payload.prices[0].amount,699);assert.equal(i.provider.calls[0].payload.subscription_period,undefined);
 assert.equal((await precheck(f,i)).approved,true);
 const event=payment(f,i),first=await record(f,event);
 assert.equal(first.status,'recorded');assert.equal(first.packagePayment,true);assert.equal(first.periodEndsAt-first.periodStartsAt,7776000);
 const second=await record(f,{...event,update_id:++sequence});
 assert.equal(second.status,'duplicate');assert.equal(second.periodId,first.periodId);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM payment_ledger WHERE entry_type='payment'").get().n,1);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_package_periods').get().n,1);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_access_grants').get().n,0);
 assert.equal(f.sqlite.prepare("SELECT plan_code FROM user_plans WHERE telegram_id=900").get().plan_code,'free');
 const state=await applyVerifiedPackagePaidAccess(f.serverEnv,{orderId:first.orderId,appliedAt:f.now});assert.equal(state.status,'active');
});

test('Professional paid residue remains unchanged; Dragon package starts exactly after it',async t=>{
 const f=fixture(t),current=await seedCurrent(f),before=f.sqlite.prepare('SELECT * FROM subscriptions WHERE subscription_id=?').get(current.applied.subscriptionId);
 const i=await issue(f,{plan:'dragon'});assert.equal(i.result.periodStartsAt,current.end);assert.equal((await precheck(f,i)).approved,true);
 const first=await pay(f,i);assert.equal(first.status,'recorded');assert.equal(first.periodStartsAt,current.end);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscriptions WHERE subscription_id=?').get(current.applied.subscriptionId),before);
 assert.equal(f.sqlite.prepare("SELECT plan_code FROM user_plans WHERE telegram_id=900").get().plan_code,'professional');
 const state=await applyVerifiedPackagePaidAccess(f.serverEnv,{orderId:first.orderId,appliedAt:f.now});assert.equal(state.status,'scheduled');assert.equal(state.accessApplied,false);
});

test('client amount, actor clones, foreign customer and economic closed packages cannot create invoice',async t=>{
 const f=fixture(t);await accepted(f);const actor=(await own(f)).actor,provider=transport(f);
 for(const request of [{requestedPlanCode:'professional',packageCode:'3m',amountStars:1},{requestedPlanCode:'dragon',packageCode:'6m'}])
  await assert.rejects(()=>issuePackageInvoice({actor,request,telegramUpdateId:++sequence,createdAt:f.now},provider));
 await assert.rejects(()=>issuePackageInvoice({actor:JSON.parse(JSON.stringify(actor)),request:{requestedPlanCode:'professional',packageCode:'3m'},telegramUpdateId:++sequence,createdAt:f.now},provider));
 const foreign=await resolver.resolveActor(await f.context(101,'access.read_own'));
 await assert.rejects(()=>issuePackageInvoice({actor:foreign,request:{requestedPlanCode:'professional',packageCode:'3m'},telegramUpdateId:++sequence,createdAt:f.now},provider));
 assert.equal(provider.calls.length,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_orders').get().n,0);
});

test('precheckout revalidates blocked own account and sends negative answer without charging',async t=>{
 const f=fixture(t),i=await issue(f);f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=900').run();
 const result=await precheck(f,i);assert.equal(result.approved,false);assert.equal(i.provider.calls.at(-1).payload.ok,false);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_ledger').get().n,0);
});

test('genuine payment after flag disable is retained once with no period',async t=>{
 const f=fixture(t),i=await issue(f);assert.equal((await precheck(f,i)).approved,true);
 f.serverEnv.STARS_PACKAGES_ENABLED='false';const actor=await resolver.resolveActor(await f.context(900,'access.read_own'));
 const event=payment(f,i),first=await record(f,event);
 assert.equal(first.status,'manual_review');assert.equal(first.reason,'package_disabled');
 const repeat=await record(f,event,{withoutActor:true});assert.equal(repeat.duplicate,true);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_package_periods').get().n,0);
 const credit=f.sqlite.prepare("SELECT * FROM payment_ledger WHERE entry_type='payment'").get();
 assert.equal(credit.reason_code,'package_payment_review_retained');assert.ok(await readPackageRetainedReview(f.serverEnv,credit));
});

test('late expired payment records genuine immutable charge rather than arbitrary fresh interval',async t=>{
 const f=fixture(t),i=await issue(f);assert.equal((await precheck(f,i)).approved,true);
 f.now=i.order.expires_at+1;const first=await pay(f,i,{at:i.order.expires_at-1});
 assert.equal(first.status,'manual_review');assert.equal(first.reason,'package_payment_late_or_closed');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_package_periods').get().n,0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_package_payment_reviews').get().n,1);
});

test('source changes inside payment batch roll back period and retain real credit',async t=>{
 const f=fixture(t),current=await seedCurrent(f),i=await issue(f,{plan:'dragon'});assert.equal((await precheck(f,i)).approved,true);
 const race=({statements})=>{if(!statements.some(row=>row.sql.includes('INSERT INTO payment_ledger'))){f.binding.beforeBatch=race;return;}
  f.sqlite.prepare('UPDATE subscriptions SET current_period_end=current_period_end+1,revision=revision+1 WHERE subscription_id=?').run(current.applied.subscriptionId);};f.binding.beforeBatch=race;
 const first=await pay(f,i);assert.equal(first.status,'manual_review');assert.equal(first.reason,'package_atomic_source_changed');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_package_periods').get().n,0);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM payment_ledger WHERE entry_type='payment'").get().n,2);
});

test('database failure is retryable and cannot fabricate retained success or a half paid period',async t=>{
 const f=fixture(t),i=await issue(f);assert.equal((await precheck(f,i)).approved,true);const event=payment(f,i);
 f.binding.failStatement=sql=>sql.includes('INSERT INTO subscription_package_periods');
 await assert.rejects(()=>record(f,event),/injected SQL failure/u);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_ledger').get().n,0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_package_periods').get().n,0);
 assert.equal((await record(f,event)).status,'recorded');
});

test('distinct genuine second charge is retained separately without overwriting first period',async t=>{
 const f=fixture(t),i=await issue(f);assert.equal((await precheck(f,i)).approved,true);const first=await pay(f,i);
 const second=await pay(f,i);assert.equal(second.status,'manual_review');assert.notEqual(second.ledgerEntryId,first.ledgerEntryId);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_package_periods').get().n,1);
 assert.equal(f.sqlite.prepare("SELECT order_state FROM subscription_orders WHERE order_id=?").get(i.order.order_id).order_state,'applied');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_package_payment_reviews').get().n,1);
});

test('signed payload actor or amount mismatch never creates financial evidence',async t=>{
 const f=fixture(t),i=await issue(f);assert.equal((await precheck(f,i)).approved,true);
 await assert.rejects(()=>pay(f,i,{amount:1}),error=>error.code==='successful_payment_product_mismatch');
 const altered=payment(f,i);altered.message.successful_payment.invoice_payload=altered.message.successful_payment.invoice_payload.slice(0,-1)+'x';
 await assert.rejects(()=>record(f,altered));
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_ledger').get().n,0);
});

test('HTTP invoice replay uses trusted operation identity, survives later flag closure and never resends',async t=>{
 const f=fixture(t);await accepted(f);const request={packageCode:'3m',requestedPlanCode:'professional'},provider=transport(f);
 const ctx=()=>createCustomerContext({binding:f.binding,env:f.serverEnv,initData:signedInitData(900,f.now),nowSeconds:f.now,
   operation:'access.read_own',channel:'http',idempotencyKey:'synthetic-v144-http-invoice-idempotency',requestPayload:request});
 let actor=await resolver.resolveActor(await ctx());const first=await issuePackageInvoice({actor,request,createdAt:f.now},provider);
 f.serverEnv.STARS_PACKAGES_ENABLED='false';actor=await resolver.resolveActor(await ctx());
 const repeat=await issuePackageInvoice({actor,request,createdAt:f.now},provider);assert.equal(repeat.orderId,first.orderId);
 assert.equal(repeat.duplicate,true);assert.equal(provider.calls.length,1);
});

test('review migration is additive, repeatable and exact; tampered schema is not ready',async t=>{
 const f=fixture(t),sql=fs.readFileSync(new URL('../migrations/0073-v1.4.4-package-payment-review.sql',import.meta.url),'utf8');
 const before=f.sqlite.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name NOT IN ('subscription_package_payment_reviews','subscription_package_invoice_requests') ORDER BY type,name").all();
 f.sqlite.exec(sql);assert.equal((await inspectPackagePaymentReviewSchema(f.binding,{required:true})).present,true);
 assert.deepEqual(f.sqlite.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name NOT IN ('subscription_package_payment_reviews','subscription_package_invoice_requests') ORDER BY type,name").all(),before);
 assert.equal(PACKAGE_PAYMENT_REVIEW_SCHEMA.objects.length,13);
 f.sqlite.exec('DROP TRIGGER v144_package_payment_review_no_delete');await assert.rejects(()=>inspectPackagePaymentReviewSchema(f.binding,{required:true}));
});

test('ordinary authenticated HTTP actor cannot forge a package financial observation',async t=>{
 const f=fixture(t),i=await issue(f);assert.equal((await precheck(f,i)).approved,true);
 const event=payment(f,i);
 await assert.rejects(()=>recordStarsSuccessfulPayment(f.serverEnv,event,{receivedAt:f.now,packageActor:i.actor}),
  error=>error.code==='untrusted_package_financial_observation');
 await assert.rejects(()=>recordStarsSuccessfulPayment(f.serverEnv,event,{receivedAt:f.now}));
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_ledger').get().n,0);
 const options=await financial(f,event);const forged=structuredClone(event);forged.message.successful_payment.telegram_payment_charge_id='forged-new-charge';
 await assert.rejects(()=>recordStarsSuccessfulPayment(f.serverEnv,forged,{receivedAt:f.now,...options}),
  error=>error.code==='untrusted_package_financial_observation');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_ledger').get().n,0);
});

test('uncertain createInvoiceLink call is retained and HTTP replay never resends the provider request',async t=>{
 const f=fixture(t);await accepted(f);const request={packageCode:'3m',requestedPlanCode:'professional'};
 const context=()=>createCustomerContext({binding:f.binding,env:f.serverEnv,initData:signedInitData(900,f.now),nowSeconds:f.now,
   operation:'access.read_own',channel:'http',idempotencyKey:'synthetic-v144-http-unknown-request',requestPayload:request});
 let attempts=0;const provider={telegramApi:async()=>{attempts++;throw Object.assign(new Error('lost response'),{code:'telegram_transport_failure',ambiguous:true});}};
 let actor=await resolver.resolveActor(await context());await assert.rejects(()=>issuePackageInvoice({actor,request,createdAt:f.now},provider));
 actor=await resolver.resolveActor(await context());const repeat=await issuePackageInvoice({actor,request,createdAt:f.now},provider);
 assert.equal(repeat.status,'manual_review');assert.equal(repeat.reason,'package_invoice_issuance_unknown');assert.equal(attempts,1);
 const receipt=f.sqlite.prepare('SELECT * FROM subscription_package_invoice_requests').get();assert.equal(receipt.state,'unknown');assert.equal(receipt.attempted_count,1);
});

for(const plan of ['professional','dragon'])for(const code of ['3m','6m','12m'])
 test(`actual admitted ${plan}/${code} producer records canonical amount, full fixed period and one replay`,async t=>{
 const f=fixture(t,{STARS_PACKAGE_6M_ENABLED:'true',STARS_PACKAGE_12M_ENABLED:'true',
  STARS_PACKAGE_ECONOMICS_EVIDENCE_SHA256:hash('synthetic-only-offline-economics'),STARS_PACKAGE_REFUND_EVIDENCE_SHA256:hash('synthetic-only-offline-refund')}),
  i=await issue(f,{plan,code});assert.equal(i.result.amountStars,PACKAGE_CANONICAL_PRICES[plan][code]);
 assert.equal(i.provider.calls[0].payload.subscription_period,undefined);assert.equal((await precheck(f,i)).approved,true);
 const event=payment(f,i),first=await record(f,event),second=await record(f,{...event,update_id:++sequence});
 assert.equal(first.status,'recorded');assert.equal(first.periodEndsAt-first.periodStartsAt,PACKAGE_DURATIONS[code].periodSeconds);
 assert.equal(second.periodId,first.periodId);assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM payment_ledger WHERE entry_type='payment'").get().n,1);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_package_periods').get().n,1);
});

test('confirmed old recurring cancellation survives package becoming current and a second package quote',async t=>{
 const f=fixture(t),current=await seedCurrent(f,{mode:'recurring'});cancellation(f,current);
 const i=await issue(f,{plan:'dragon'});assert.equal((await precheck(f,i)).approved,true);const paid=await pay(f,i);assert.equal(paid.status,'recorded');
 f.now=current.end+1;const next=await issue(f,{plan:'professional'});assert.equal(next.result.periodStartsAt,paid.periodEndsAt);
 assert.equal(next.result.amountStars,699);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n,1);
});

test('late recurring reenable command after package precheckout retains charge without granting future period',async t=>{
 const f=fixture(t),current=await seedCurrent(f,{mode:'recurring'});cancellation(f,current);
 const i=await issue(f,{plan:'dragon'});assert.equal((await precheck(f,i)).approved,true);
 const contract=f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(current.contractId);
 f.sqlite.prepare(`INSERT INTO subscription_provider_commands(command_id,idempotency_key,contract_id,telegram_id,action,desired_auto_renew,
  expected_contract_revision,first_payment_ledger_entry_id,request_sha256,created_at,updated_at)
  VALUES(?,?,?,900,'reenable_renewal',1,?,?,?,?,?)`).run(crypto.randomUUID(),'synthetic-v144-late-reenable-'+ ++sequence,current.contractId,
   contract.revision,contract.first_payment_ledger_entry_id,hash('synthetic late control'),f.now,f.now);
 const result=await pay(f,i);assert.equal(result.status,'manual_review');assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_package_periods').get().n,0);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM payment_ledger WHERE reason_code='package_payment_review_retained'").get().n,1);
});

test('duplicate precheckout query has the same durable positive answer without a second event',async t=>{
 const f=fixture(t),i=await issue(f),event={update_id:++sequence,pre_checkout_query:{id:'synthetic-v144-query-dupe',
  from:{id:900,is_bot:false},currency:'XTR',total_amount:i.order.amount_stars,invoice_payload:i.order.invoice_payload}};
 const first=await handleStarsPreCheckoutQuery(f.serverEnv,event,{nowSeconds:f.now,...await financial(f,event),...i.provider});
 const second=await handleStarsPreCheckoutQuery(f.serverEnv,event,{nowSeconds:f.now,...await financial(f,event),...i.provider});
 assert.equal(first.approved,true);assert.equal(second.approved,true);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM payment_events WHERE event_type='precheckout_approved'").get().n,1);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_ledger').get().n,0);
});

test('genuine financial context anchors both precheckout and payment to its original DB and configuration',async t=>{
 const f=fixture(t),other=fixture(t),i=await issue(f),fakeEnv={...f.serverEnv,DB:other.binding,BOT_TOKEN:'987654321:substituted-token'};
 const query={update_id:++sequence,pre_checkout_query:{id:'synthetic-original-db-query',from:{id:900,is_bot:false},currency:'XTR',
  total_amount:i.order.amount_stars,invoice_payload:i.order.invoice_payload}},queryOptions=await financial(f,query);
 let observedToken=null;const pre=await handleStarsPreCheckoutQuery(fakeEnv,query,{nowSeconds:f.now,...queryOptions,
  telegramApi:async(env)=>{observedToken=env.BOT_TOKEN;return true;}});
 assert.equal(pre.approved,true);assert.equal(observedToken,f.serverEnv.BOT_TOKEN);
 const event=payment(f,i),result=await recordStarsSuccessfulPayment(fakeEnv,event,{receivedAt:f.now,...await financial(f,event)});
 assert.equal(result.status,'recorded');assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_package_periods').get().n,1);
 assert.equal(other.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_ledger').get().n,0);
 assert.equal(other.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_orders').get().n,0);
});

for(const missing of ['metadata row','metadata table'])test(`signed long order with missing package ${missing} keeps its genuine payment retryable`,async t=>{
 const f=fixture(t),i=await issue(f),event=payment(f,i),options=await financial(f,event);
 f.sqlite.exec('PRAGMA foreign_keys=OFF');
 if(missing==='metadata row') {
  const trigger=f.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='v144_package_order_no_delete'").get().sql;
  f.sqlite.exec('DROP TRIGGER v144_package_order_no_delete');
  f.sqlite.prepare('DELETE FROM subscription_package_orders WHERE order_id=?').run(i.order.order_id);
  f.sqlite.exec(trigger);
 } else f.sqlite.exec('DROP TABLE subscription_package_orders');
 f.sqlite.exec('PRAGMA foreign_keys=ON');
 const retryable=error=>error.code==='v144_package_schema_not_ready'&&error.status===503;
 await assert.rejects(isStoredPackageFinancialInvoice(f.serverEnv,i.order.invoice_payload),retryable);
 await assert.rejects(isStoredPackageInvoice(f.serverEnv,i.order.invoice_payload),retryable);
 await assert.rejects(recordStarsSuccessfulPayment(f.serverEnv,event,{receivedAt:f.now,...options}),retryable);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_ledger').get().n,0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_package_periods').get().n,0);
 assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(i.order.order_id).order_state,'created');
 // A shaped but invalid signature cannot acquire package retry authority.
 const forged=i.order.invoice_payload.slice(0,-1)+(i.order.invoice_payload.endsWith('A')?'B':'A');
 assert.equal(await isStoredPackageFinancialInvoice(f.serverEnv,forged),false);
});

test('ordinary signed 30-day order without package schema still uses its existing real payment writer',async t=>{
 const f=fixture(t),ordinary=await seedOrder(f),i={order:f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(ordinary.orderId)};
 f.sqlite.exec('PRAGMA foreign_keys=OFF');
 for(const table of [...PACKAGE_PAYMENT_REVIEW_SCHEMA.tables,...PACKAGE_SCHEMA.tables])f.sqlite.exec('DROP TABLE '+table);
 f.sqlite.prepare('DELETE FROM re_schema_migrations WHERE version IN (?,?)').run(PACKAGE_SCHEMA.marker,PACKAGE_PAYMENT_REVIEW_SCHEMA.marker);
 f.sqlite.exec('PRAGMA foreign_keys=ON');
 assert.equal(await isStoredPackageInvoice(f.serverEnv,ordinary.payload),false);
 assert.equal(await isStoredPackageFinancialInvoice(f.serverEnv,ordinary.payload),false);
 const result=await recordStarsSuccessfulPayment(f.serverEnv,payment(f,i),{receivedAt:f.now});
 assert.equal(result.status,'recorded');assert.equal(result.orderId,ordinary.orderId);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_ledger').get().n,1);
 assert.equal(f.sqlite.prepare('SELECT amount_stars FROM payment_ledger').get().amount_stars,ordinary.price.amount_stars);
});
