import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { cabinetSubscriptionFixture, next, MONTH } from './helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import { SqliteD1 } from './helpers/v1.4.0-rebuild-sqlite.mjs';
import { authoritySeconds } from '../src/v1.4.1/authority-resolver.mjs';
import { buildStarsInvoicePayload } from '../src/v1.3.6/stars-core-foundation.mjs';
import { inspectLifecycleSchema } from '../src/v1.4.3/lifecycle-schema.mjs';
import { authorizeOwnStarsSubscriptionCommand } from '../src/v1.4.3/subscription-action-authority.mjs';
import { requestOwnStarsSubscriptionCommand } from '../src/v1.4.3/telegram-subscription-provider.mjs';
import { acceptStarsPurchaseTerms, issueStarsInvoice, handleStarsPreCheckoutQuery, recordStarsSuccessfulPayment } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsPaidAccess, applyStarsCompensation } from '../src/v1.3.6/stars-access-runtime.mjs';
import { PACKAGE_SCHEMA, inspectPackageSchema, packageSchemaAssertion } from '../src/v1.4.4/package-schema.mjs';

const migration=fs.readFileSync(new URL('../migrations/0072-v1.4.4-package-contract.sql',import.meta.url),'utf8');
const digest=value=>createHash('sha256').update(value).digest('hex');
const version='2026-10-06.v1.4.4.package-v1';
const fp=digest('offline-v144-source-fingerprint');
function fixture(t,{apply=true}={}){
 const f=cabinetSubscriptionFixture(t);
 f.sqlite.function('unixepoch',{deterministic:false,varargs:true},(...args)=>args.length===0||args[0]==='now'?Math.floor(Date.now()/1000):authoritySeconds(args[0]));
 for(const name of ['0069-v1.4.3-d1-compatibility.sql','0070-v1.4.3-refund-notification.sql','0071-v1.4.3-refund-contract-retirement.sql'])
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 if(apply)f.sqlite.exec(migration);
 return f;
}
function insert(db,table,row){const keys=Object.keys(row);return db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>row[key]));}
function seedPrice(f,{plan='professional',code='3m',days=90,amount=699}={}){
 const id=`${plan}-${code}-prepaid-v144-test`;
 insert(f.sqlite,'price_book',{price_id:id,price_version:1,plan_code:plan,currency:'XTR',amount_stars:amount,access_seconds:days*86400,
  billing_mode:'prepaid',publication_state:'approved',terms_revision:f.serverEnv.STARS_TERMS_REVISION,valid_from:f.now-600,created_at:f.now-600,created_by:'offline-v144-test'});
 return f.sqlite.prepare('SELECT * FROM price_book WHERE price_id=?').get(id);
}
async function order(f,price,{id=101,createdAt=f.now-50}={}){
 const orderId=randomUUID(),payload=await buildStarsInvoicePayload({invoiceSecret:f.serverEnv.STARS_INVOICE_SECRET,orderId,telegramId:id,priceId:price.price_id});
 insert(f.sqlite,'subscription_orders',{order_id:orderId,telegram_id:id,price_id:price.price_id,price_version:price.price_version,
  plan_code:price.plan_code,currency:'XTR',amount_stars:price.amount_stars,access_seconds:price.access_seconds,billing_mode:price.billing_mode,
  terms_revision:price.terms_revision,invoice_payload:payload,order_state:'created',created_at:createdAt,expires_at:f.now+600,updated_at:createdAt});
 return f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(orderId);
}
function metadata(f,o,{source=null,sourcePeriod=null,transition=null,quoteAt=f.now-10,start=source?.current_period_end??sourcePeriod?.ends_at??quoteAt,patch={}}={}){
 const row={order_id:o.order_id,telegram_id:o.telegram_id,contract_version:version,package_code:o.access_seconds===MONTH?'30d':o.access_seconds===MONTH*3?'3m':o.access_seconds===MONTH*6?'6m':'12m',
  duration_days:o.access_seconds/86400,period_seconds:o.access_seconds,price_id:o.price_id,price_version:o.price_version,plan_code:o.plan_code,billing_mode:o.billing_mode,currency:o.currency,amount_stars:o.amount_stars,
  offer_version:version,campaign_code:null,quoted_starts_at:start,quoted_ends_at:start+o.access_seconds,
  source_subscription_id:source?.subscription_id??null,source_package_period_id:sourcePeriod?.period_id??null,
  source_paid_until:source?.current_period_end??sourcePeriod?.ends_at??null,source_revision:source?.revision??(sourcePeriod?1:null),
  source_payment_ledger_entry_id:source?.last_ledger_entry_id??sourcePeriod?.payment_ledger_entry_id??null,source_fingerprint:fp,
  transition_id:transition?.transition_id??null,created_at:quoteAt,...patch};
 insert(f.sqlite,'subscription_package_orders',row);return row;
}
function pay(f,o,{at=f.now-5,charge='offline-v144-charge-'+next(),applied=false}={}){
 f.sqlite.prepare("UPDATE subscription_orders SET order_state='precheckout_ok',precheckout_approved_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=?").run(at-1,at-1,o.order_id);
 const ledger={ledger_entry_id:randomUUID(),idempotency_key:'offline-v144-payment:'+next(),order_id:o.order_id,telegram_id:o.telegram_id,entry_type:'payment',direction:'credit',currency:o.currency,
  amount_stars:o.amount_stars,telegram_payment_charge_id:charge,occurred_at:at,recorded_at:at};insert(f.sqlite,'payment_ledger',ledger);
 f.sqlite.prepare("UPDATE subscription_orders SET order_state='paid',paid_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=?").run(at,at,o.order_id);
 if(applied)f.sqlite.prepare("UPDATE subscription_orders SET order_state='applied',applied_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=?").run(at,at,o.order_id);
 return ledger;
}
function period(f,o,m,paid,{patch={}}={}){
 const starts=Math.max(m.quoted_starts_at,paid.occurred_at);
 const row={period_id:randomUUID(),order_id:o.order_id,payment_ledger_entry_id:paid.ledger_entry_id,telegram_id:o.telegram_id,plan_code:o.plan_code,
  price_id:o.price_id,price_version:o.price_version,billing_mode:'prepaid',starts_at:starts,ends_at:starts+o.access_seconds,period_seconds:o.access_seconds,
  transition_id:m.transition_id,recorded_at:f.now,...patch};insert(f.sqlite,'subscription_package_periods',row);return row;
}
function schedule(f,source,price,{patch={}}={}){
 const row={transition_id:randomUUID(),telegram_id:source.telegram_id,idempotency_key:'offline-v144-transition:'+next(),request_sha256:digest('request:'+next()),contract_version:version,
  source_subscription_id:source.subscription_id,source_package_period_id:null,source_payment_ledger_entry_id:source.last_ledger_entry_id,source_revision:source.revision,source_fingerprint:fp,
  from_plan:source.plan_code,from_billing_mode:source.billing_mode,to_plan:price.plan_code,to_billing_mode:price.billing_mode,target_package_code:price.access_seconds===MONTH?'30d':'3m',
  target_price_id:price.price_id,target_price_version:price.price_version,period_seconds:price.access_seconds,offer_version:version,campaign_code:null,
  source_paid_until:source.current_period_end,effective_at:source.current_period_end,state:'scheduled',revision:1,
  target_order_id:null,target_period_id:null,target_grant_id:null,cancel_command_id:null,cancel_idempotency_key:null,cancel_request_sha256:null,cancelled_at:null,created_at:f.now,updated_at:f.now,...patch};
 insert(f.sqlite,'subscription_plan_transitions',row);return row;
}
function refund(f,paid,{at=f.now}={}){insert(f.sqlite,'payment_ledger',{ledger_entry_id:randomUUID(),idempotency_key:'offline-v144-refund:'+next(),order_id:paid.order_id,telegram_id:paid.telegram_id,
 entry_type:'refund',direction:'debit',currency:paid.currency,amount_stars:paid.amount_stars,telegram_payment_charge_id:paid.telegram_payment_charge_id,related_ledger_entry_id:paid.ledger_entry_id,occurred_at:at,recorded_at:at});}
async function cancelRecurring(f){
 const c=f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE retired_at IS NULL').get(),calls=[];
 const token=await authorizeOwnStarsSubscriptionCommand(await f.auth({payload:{subscriptionAction:'cancel_renewal',contractId:c.contract_id,expectedRevision:c.revision}}));
 const result=await requestOwnStarsSubscriptionCommand(token,{telegramApi:async(_env,method,payload)=>{calls.push({method,payload});return true;}});
 assert.equal(result.status,'confirmed');assert.equal(calls.length,1);assert.equal(calls[0].method,'editUserStarSubscription');assert.equal(calls[0].payload.is_canceled,true);
 f.now=Math.max(f.now,Math.floor(Date.now()/1000));return result;
}
async function paidPrepaidMonth(f){
 await acceptStarsPurchaseTerms(f.serverEnv,{telegramId:101,telegramUpdateId:next()});
 const invoice=await issueStarsInvoice(f.serverEnv,{telegramId:101,requestedPlanCode:'dragon',telegramUpdateId:next()},{telegramApi:async()=>({message_id:next()})});
 const o=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(invoice.orderId);
 assert.equal((await handleStarsPreCheckoutQuery(f.serverEnv,{update_id:next(),pre_checkout_query:{id:'offline-v144-checkout-'+next(),from:{id:101,is_bot:false},currency:'XTR',total_amount:o.amount_stars,invoice_payload:o.invoice_payload}},{telegramApi:async()=>true})).approved,true);
 const charge='offline-v144-prepaid-'+next(),record=await recordStarsSuccessfulPayment(f.serverEnv,{update_id:next(),message:{message_id:next(),from:{id:101,is_bot:false},chat:{id:101,type:'private'},successful_payment:{currency:'XTR',total_amount:o.amount_stars,invoice_payload:o.invoice_payload,telegram_payment_charge_id:charge,provider_payment_charge_id:''}}});
 assert.equal((await applyStarsPaidAccess(f.serverEnv,{orderId:record.orderId})).accessApplied,true);return {o,record,charge};
}
const oldObjects=f=>f.sqlite.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name NOT IN ('subscription_package_orders','subscription_package_periods','subscription_plan_transitions') ORDER BY type,name").all();
function oldRows(f){return f.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('subscription_package_orders','subscription_package_periods','subscription_plan_transitions') ORDER BY name").all()
 .map(({name})=>({name,rows:f.sqlite.prepare(`SELECT * FROM "${name}"`).all().filter(row=>name!=='re_schema_migrations'||row.version!=='1.4.4-package-contract')}));}

test('additive migration preserves every old schema object and row on isolated copied snapshot; repeat application is identical',async t=>{
 const original=fixture(t,{apply:false});await original.paid();
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'v144-package-schema-'));let sqlite;
 t.after(()=>{sqlite?.close();fs.rmSync(directory,{recursive:true,force:true});});
 const snapshot=path.join(directory,'isolated.sqlite');original.sqlite.prepare('VACUUM INTO ?').run(snapshot);
 sqlite=new DatabaseSync(snapshot);const copy={sqlite,binding:new SqliteD1(sqlite)};
 const beforeObjects=oldObjects(copy),beforeRows=oldRows(copy),count=sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table'").get().n;
 sqlite.exec(migration);assert.deepEqual(oldObjects(copy),beforeObjects);assert.deepEqual(oldRows(copy),beforeRows);
 assert.equal(sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table'").get().n,count+3);
 const once=sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();sqlite.exec(migration);
 assert.deepEqual(sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),once);
 assert.deepEqual(oldRows(copy),beforeRows);assert.equal(sqlite.prepare("SELECT count(*) n FROM re_schema_migrations WHERE version='1.4.4-package-contract'").get().n,1);
 assert.equal(sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.equal((await inspectPackageSchema(copy.binding,{required:true})).metadataOnly,true);
});

test('schema inspector remains compatible with current lifecycle, binds exact structural assertions, and rejects incomplete or altered schema',async t=>{
 const absent=fixture(t,{apply:false});assert.equal((await inspectPackageSchema(absent.binding)).present,false);
 await assert.rejects(()=>inspectPackageSchema(absent.binding,{required:true}),/v144_package_schema_not_ready/u);
 const empty=packageSchemaAssertion({present:false});assert.equal(absent.sqlite.prepare(`SELECT (${empty.sql}) valid`).get(...empty.params).valid,1);
 absent.sqlite.exec(migration);assert.equal(absent.sqlite.prepare(`SELECT (${empty.sql}) valid`).get(...empty.params).valid,0);
 const present=await inspectPackageSchema(absent.binding,{required:true});assert.equal(present.schemaSha256,PACKAGE_SCHEMA.schemaSha256);
 const assertion=packageSchemaAssertion(present);assert.equal(absent.sqlite.prepare(`SELECT (${assertion.sql}) valid`).get(...assertion.params).valid,1);
 assert.equal((await inspectLifecycleSchema(absent.binding,{required:true})).ready,true);
 absent.sqlite.exec('DROP TRIGGER v144_package_period_binding');assert.equal(absent.sqlite.prepare(`SELECT (${assertion.sql}) valid`).get(...assertion.params).valid,0);
 await assert.rejects(()=>inspectPackageSchema(absent.binding),/v144_package_schema_not_ready/u);
 const partial=fixture(t,{apply:false});partial.sqlite.exec("CREATE TABLE subscription_package_orders(order_id TEXT)");await assert.rejects(()=>inspectPackageSchema(partial.binding),/v144_package_schema_not_ready/u);
 assert.equal(digest(migration),PACKAGE_SCHEMA.migrationSha256);
});

test('quote snapshot binds exact existing order price/mode/duration/owner; no retroactive metadata or price mutation',async t=>{
 const f=fixture(t),price=seedPrice(f),o=await order(f,price);
 for(const patch of [{telegram_id:202},{amount_stars:1},{price_version:2},{price_id:'professional-30d-prepaid-v1'},{period_seconds:MONTH},{billing_mode:'recurring'},{duration_days:180},{campaign_code:''},{quoted_ends_at:f.now}])
  assert.throws(()=>metadata(f,o,{patch}),/v144_package_order_binding_invalid|CHECK constraint failed/u);
 const m=metadata(f,o);assert.equal(m.campaign_code,null);
 for(const sql of ["UPDATE subscription_package_orders SET offer_version='future-repriced-v2'","UPDATE subscription_package_orders SET quoted_starts_at=quoted_starts_at+1","DELETE FROM subscription_package_orders"])
  assert.throws(()=>f.sqlite.exec(sql),/v144_package_order_immutable|v144_package_order_retention_required/u);
 assert.throws(()=>f.sqlite.exec("UPDATE price_book SET amount_stars=1"),/price book versions are immutable/u);
 const paid=pay(f,o,{applied:true});assert.throws(()=>metadata(f,o,{patch:{order_id:randomUUID()}}),/v144_package_order_binding_invalid/u);
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM subscription_package_periods').get().n,0);
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM subscriptions').get().n,0,'an unpaid quote creates no subscription');
 assert.equal(paid.amount_stars,699);
});

test('confirmed prepaid period keeps actual dates distinct from quote, binds one exact charge and rejects unpaid/foreign/shifted/duplicate records',async t=>{
 const f=fixture(t),price=seedPrice(f),o=await order(f,price),m=metadata(f,o);
 assert.throws(()=>period(f,o,m,{ledger_entry_id:randomUUID(),occurred_at:f.now}),/v144_package_period_binding_invalid/u);
 const paid=pay(f,o),starts=Math.max(m.quoted_starts_at,paid.occurred_at);
 for(const patch of [{telegram_id:202},{plan_code:'dragon'},{price_version:2},{payment_ledger_entry_id:randomUUID()},
  {starts_at:starts+1,ends_at:starts+1+o.access_seconds},{starts_at:starts-1,ends_at:starts-1+o.access_seconds},
  {period_seconds:MONTH,ends_at:starts+MONTH},{recorded_at:paid.recorded_at-1},{billing_mode:'recurring'}])
  assert.throws(()=>period(f,o,m,paid,{patch}),/v144_package_period_binding_invalid|CHECK constraint failed/u);
 const pp=period(f,o,m,paid);assert.equal(pp.starts_at,paid.occurred_at);assert.notEqual(pp.starts_at,m.quoted_starts_at);
 assert.equal(pp.ends_at-pp.starts_at,MONTH*3);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM subscriptions').get().n,0);
 assert.throws(()=>period(f,o,m,paid),/v144_package_period_binding_invalid|UNIQUE constraint failed/u);
 assert.throws(()=>f.sqlite.exec('UPDATE subscription_package_periods SET ends_at=ends_at+86400'),/v144_package_period_immutable/u);
 assert.throws(()=>f.sqlite.exec('DELETE FROM subscription_package_periods'),/v144_package_period_retention_required/u);
});

test('schedule/cancel is actor-bound, one open intent per user, stable retry identity and CAS; intent never modifies paid access',async t=>{
 const f=fixture(t);await f.paid();const source=f.sqlite.prepare('SELECT * FROM subscriptions').get(),price=seedPrice(f);
 const paidBefore=f.sqlite.prepare('SELECT * FROM payment_ledger').all(),grantsBefore=f.sqlite.prepare('SELECT * FROM subscription_access_grants').all();
 for(const patch of [{telegram_id:202},{source_revision:source.revision+1},{source_paid_until:source.current_period_end+1,effective_at:source.current_period_end+1},
  {source_payment_ledger_entry_id:randomUUID()},{from_plan:'professional'},{target_price_version:2},{state:'fulfilled'},{effective_at:f.now}])
  assert.throws(()=>schedule(f,source,price,{patch}),/v144_plan_transition_binding_invalid|CHECK constraint failed/u);
 const intent=schedule(f,source,price);assert.throws(()=>schedule(f,source,price),/UNIQUE constraint failed/u);
 assert.throws(()=>insert(f.sqlite,'subscription_plan_transitions',{...intent,transition_id:randomUUID()}),/UNIQUE constraint failed/u);
 assert.throws(()=>f.sqlite.prepare('UPDATE subscription_plan_transitions SET to_plan=?,revision=revision+1 WHERE transition_id=?').run('dragon',intent.transition_id),/v144_plan_transition_state_invalid/u);
 const cancel=[randomUUID(),'offline-v144-cancel:'+next(),digest('cancel:'+next()),f.now,intent.transition_id];
 const sql="UPDATE subscription_plan_transitions SET state='cancelled',revision=revision+1,cancel_command_id=?,cancel_idempotency_key=?,cancel_request_sha256=?,cancelled_at=?,updated_at=? WHERE transition_id=? AND telegram_id=? AND state='scheduled' AND revision=?";
 assert.equal(f.sqlite.prepare(sql).run(...cancel.slice(0,4),f.now,intent.transition_id,202,1).changes,0);
 assert.equal(f.sqlite.prepare(sql).run(...cancel.slice(0,4),f.now,intent.transition_id,101,2).changes,0);
 assert.equal(f.sqlite.prepare(sql).run(...cancel.slice(0,4),f.now,intent.transition_id,101,1).changes,1);
 assert.equal(f.sqlite.prepare(sql).run(...cancel.slice(0,4),f.now,intent.transition_id,101,1).changes,0,'same cancelled retry changes nothing');
 assert.throws(()=>f.sqlite.exec("UPDATE subscription_plan_transitions SET state='scheduled',revision=revision+1"),/v144_plan_transition_state_invalid/u);
 assert.throws(()=>f.sqlite.exec('DELETE FROM subscription_plan_transitions'),/v144_plan_transition_retention_required/u);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM payment_ledger').all(),paidBefore);assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_access_grants').all(),grantsBefore);
 const fresh=schedule(f,source,price);assert.notEqual(fresh.transition_id,intent.transition_id);
});

test('future different-plan paid period preserves old residue and refuses raced extension or cancellation of a paid package',async t=>{
 const f=fixture(t);await f.paid();const source=f.sqlite.prepare('SELECT * FROM subscriptions').get(),price=seedPrice(f),intent=schedule(f,source,price);
 const o=await order(f,price),m=metadata(f,o,{source,transition:intent}),paid=pay(f,o);
 const before=f.sqlite.prepare('SELECT * FROM subscriptions').get(),oldLedger=f.sqlite.prepare('SELECT * FROM payment_ledger').all(),oldGrants=f.sqlite.prepare('SELECT * FROM subscription_access_grants').all();
 f.sqlite.prepare('UPDATE subscriptions SET current_period_end=current_period_end+?,revision=revision+1 WHERE subscription_id=?').run(MONTH,source.subscription_id);
 assert.throws(()=>period(f,o,m,paid),/v144_package_period_binding_invalid/u);
 f.sqlite.prepare('UPDATE subscriptions SET current_period_end=?,revision=revision+1 WHERE subscription_id=?').run(source.current_period_end,source.subscription_id);
 assert.throws(()=>period(f,o,m,paid),/v144_package_period_binding_invalid/u,'unconfirmed recurring cancellation cannot create conflicting paid package');
 await cancelRecurring(f);
 const pp=period(f,o,m,paid);assert.equal(pp.starts_at,source.current_period_end);assert.equal(pp.plan_code,'professional');
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM payment_ledger').all(),oldLedger);assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_access_grants').all(),oldGrants);
 assert.equal(f.sqlite.prepare('SELECT plan_code FROM subscriptions').get().plan_code,before.plan_code,'paid future period is not current plan');
 assert.throws(()=>f.sqlite.prepare("UPDATE subscription_plan_transitions SET state='cancelled',revision=revision+1,cancel_command_id=?,cancel_idempotency_key=?,cancel_request_sha256=?,cancelled_at=?,updated_at=? WHERE transition_id=?")
  .run(randomUUID(),'offline-v144-cancel-paid:'+next(),digest('cancelpaid'),f.now,f.now,intent.transition_id),/v144_plan_transition_state_invalid/u);
 f.sqlite.prepare("UPDATE subscription_plan_transitions SET state='fulfilled',revision=revision+1,target_order_id=?,target_period_id=?,updated_at=? WHERE transition_id=?")
  .run(o.order_id,pp.period_id,f.now,intent.transition_id);
 assert.equal(f.sqlite.prepare('SELECT state FROM subscription_plan_transitions').get().state,'fulfilled');
});

test('overlapping future periods and compensated charge reuse are rejected; retained refund frees later interval without deleting evidence',async t=>{
 const f=fixture(t),price=seedPrice(f),first=await order(f,price),firstMeta=metadata(f,first),firstPaid=pay(f,first,{applied:true}),firstPeriod=period(f,first,firstMeta,firstPaid);
 const second=await order(f,price),secondMeta=metadata(f,second),secondPaid=pay(f,second,{applied:true});
 assert.throws(()=>period(f,second,secondMeta,secondPaid),/v144_package_period_binding_invalid/u);
 refund(f,firstPaid);assert.throws(()=>period(f,first,firstMeta,firstPaid),/v144_package_period_binding_invalid/u);
 const secondPeriod=period(f,second,secondMeta,secondPaid);assert.equal(secondPeriod.period_seconds,MONTH*3);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_package_periods WHERE period_id=?').get(firstPeriod.period_id),Object.assign(Object.create(null),firstPeriod));
 const secondCopy={...secondPeriod,period_id:randomUUID()};assert.throws(()=>insert(f.sqlite,'subscription_package_periods',secondCopy),/v144_package_period_binding_invalid|UNIQUE constraint failed/u);
 const third=await order(f,price,{id:202}),thirdMeta=metadata(f,third),thirdPaid=pay(f,third,{applied:true});assert.equal(period(f,third,thirdMeta,thirdPaid).telegram_id,202);
});

test('a paid future period can be the next source without minting a current subscription; terminal compensation invalidates source',async t=>{
 const f=fixture(t),price=seedPrice(f),o=await order(f,price),m=metadata(f,o),paid=pay(f,o,{applied:true}),pp=period(f,o,m,paid);
 const nextOrder=await order(f,price),nextMeta=metadata(f,nextOrder,{sourcePeriod:pp}),nextPaid=pay(f,nextOrder,{applied:true}),nextPeriod=period(f,nextOrder,nextMeta,nextPaid);
 assert.equal(nextPeriod.starts_at,pp.ends_at);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM subscriptions').get().n,0);
 const another=await order(f,price,{id:202});assert.throws(()=>metadata(f,another,{sourcePeriod:pp}),/v144_package_order_binding_invalid/u);
 refund(f,paid);const later=await order(f,price);assert.throws(()=>metadata(f,later,{sourcePeriod:pp}),/v144_package_order_binding_invalid/u);
});

test('old prepaid refund compacts surviving paid residue; original grant end does not falsely block next package boundary',async t=>{
 const f=fixture(t);
 // All writers sample the same causal fixture clock. Real second boundaries
 // must not make this explicit refund timestamp precede either paid purchase.
 t.mock.method(Date,'now',()=>f.now*1000);
 const first=await paidPrepaidMonth(f);
 f.now+=1;
 const second=await paidPrepaidMonth(f);
 const originalSecond=f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(second.record.ledgerEntryId);
 f.now+=1;
 assert.equal((await applyStarsCompensation(f.serverEnv,{telegramPaymentChargeId:first.charge,compensationType:'refund',occurredAt:f.now})).status,'applied');
 const source=f.sqlite.prepare('SELECT * FROM subscriptions').get(),survivor=f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(second.record.ledgerEntryId);
 assert.deepEqual(survivor,originalSecond);assert.ok(survivor.ends_at>source.current_period_end,'immutable raw grant is longer than effective compacted residue');
 const price=seedPrice(f),o=await order(f,price),m=metadata(f,o,{source,patch:{source_payment_ledger_entry_id:survivor.payment_ledger_entry_id}}),paid=pay(f,o),pp=period(f,o,m,paid);
 assert.equal(pp.starts_at,source.current_period_end);assert.equal(pp.plan_code,'professional');assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE grant_id=?').get(survivor.grant_id),survivor);
});

test('a committed monthly target grant fences cancelled intent after a writer crash before fulfillment',async t=>{
 const f=fixture(t);await f.paid();const source=f.sqlite.prepare('SELECT * FROM subscriptions').get(),price=f.sqlite.prepare("SELECT * FROM price_book WHERE price_id='professional-30d-prepaid-v1'").get(),intent=schedule(f,source,price);
 const o=await order(f,price),m=metadata(f,o,{source,transition:intent});f.now=source.current_period_end;
 const paid=pay(f,o,{at:f.now});f.sqlite.prepare("UPDATE subscriptions SET status='expired',revision=revision+1,updated_at=? WHERE subscription_id=?").run(f.now,source.subscription_id);
 const targetSub=randomUUID();insert(f.sqlite,'subscriptions',{subscription_id:targetSub,telegram_id:101,plan_code:'professional',billing_mode:'prepaid',source_order_id:o.order_id,
  telegram_payment_charge_id:paid.telegram_payment_charge_id,status:'active',current_period_start:f.now,current_period_end:f.now+MONTH,auto_renew:0,last_ledger_entry_id:paid.ledger_entry_id,created_at:f.now,updated_at:f.now});
 const grantId=randomUUID();insert(f.sqlite,'subscription_access_grants',{grant_id:grantId,grant_key:'offline-v144-monthly-target:'+next(),subscription_id:targetSub,order_id:o.order_id,
  payment_ledger_entry_id:paid.ledger_entry_id,telegram_id:101,plan_code:'professional',access_seconds:MONTH,starts_at:f.now,ends_at:f.now+MONTH,status:'active',created_at:f.now,updated_at:f.now});
 f.sqlite.prepare("UPDATE subscription_orders SET order_state='applied',applied_at=?,updated_at=?,state_revision=state_revision+1 WHERE order_id=?").run(f.now,f.now,o.order_id);
 assert.throws(()=>f.sqlite.prepare("UPDATE subscription_plan_transitions SET state='cancelled',revision=revision+1,cancel_command_id=?,cancel_idempotency_key=?,cancel_request_sha256=?,cancelled_at=?,updated_at=? WHERE transition_id=?")
  .run(randomUUID(),'offline-v144-paid-monthly-cancel:'+next(),digest('monthly-cancel'),f.now,f.now,intent.transition_id),/v144_plan_transition_state_invalid/u);
 f.sqlite.prepare("UPDATE subscription_plan_transitions SET state='fulfilled',revision=revision+1,target_order_id=?,target_grant_id=?,updated_at=? WHERE transition_id=?")
  .run(m.order_id,grantId,f.now,intent.transition_id);assert.equal(f.sqlite.prepare('SELECT state FROM subscription_plan_transitions').get().state,'fulfilled');
 assert.equal(f.sqlite.prepare('SELECT plan_code FROM subscriptions WHERE subscription_id=?').get(targetSub).plan_code,'professional');
});
