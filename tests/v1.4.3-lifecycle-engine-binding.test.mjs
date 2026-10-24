import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { runPublicPython } from './helpers/public-python.mjs';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { inspectLifecycleSchema } from '../src/v1.4.3/lifecycle-schema.mjs';
import { inspectLifecyclePrivacyRetention } from '../src/v1.4.3/privacy-retention.mjs';
import { prepareV141PrivacyDeletion } from '../src/v1.4.1/privacy-maintenance.mjs';
import { getStarsUserPrivacySummary, getStarsPrivacyDeletionBlockers } from '../src/v1.3.6/stars-access-runtime.mjs';

const foundationMigration=fs.readFileSync(new URL('../migrations/0066-v1.4.3-subscription-lifecycle-foundation.sql',import.meta.url),'utf8');
const bindingMigration=fs.readFileSync(new URL('../migrations/0067-v1.4.3-lifecycle-engine-binding.sql',import.meta.url),'utf8');
const digest=value=>createHash('sha256').update(String(value)).digest('hex');
const uid=()=>randomUUID();
const tables=['subscription_billing_contracts','subscription_payment_links','subscription_provider_events',
 'subscription_provider_commands','paid_subscription_notification_jobs','payment_review_resolutions'];
const insert=(f,table,row)=>{const keys=Object.keys(row);return f.sqlite.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));};
function fixture(t,{apply=true}={}){
 const f=foundationFixture(t);
 for(const name of ['0026-v1.3.6-stars-core-foundation.sql','0027-v1.3.6-stars-access-and-reconciliation.sql','0065-v1.4.1-privacy-ai-journal.sql'])
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 f.sqlite.exec('PRAGMA foreign_keys=ON');
 // Recurring prices exist ONLY in this offline fixture, never in 0066.
 insert(f,'price_book',{price_id:'professional-30d-recurring-v143-test',price_version:1,plan_code:'professional',currency:'XTR',amount_stars:249,
  access_seconds:2592000,billing_mode:'recurring',publication_state:'approved',terms_revision:'2026-10-03.recurring-test',valid_from:f.now-9000000,created_at:f.now-9000000,created_by:'offline-test'});
 if(apply){f.sqlite.exec(foundationMigration);f.sqlite.exec(bindingMigration);}return f;
}
function order(f,{subject=101,billing='recurring',state='created',payload,at=f.now-100}={}){
 const id=uid(),external=payload??'offline:'+id;
 const row={order_id:id,telegram_id:subject,price_id:billing==='recurring'?'professional-30d-recurring-v143-test':'professional-30d-prepaid-v1',
 price_version:1,plan_code:'professional',currency:'XTR',amount_stars:249,access_seconds:2592000,billing_mode:billing,
 terms_revision:billing==='recurring'?'2026-10-03.recurring-test':'2026-09-10.stars-v1',invoice_payload:external,
 order_state:'created',created_at:at,expires_at:at+900,updated_at:at};
 insert(f,'subscription_orders',row);
 if(state==='cancelled')f.sqlite.prepare("UPDATE subscription_orders SET order_state='cancelled',closed_at=? WHERE order_id=?").run(at+1,id);
 return {...row,order_state:state};
}
function pay(f,o,{charge='offline_charge_'+uid(),at=f.now-50,subscription=false}={}){
 f.sqlite.prepare("UPDATE subscription_orders SET order_state='precheckout_ok',precheckout_approved_at=? WHERE order_id=?").run(at,o.order_id);
 const ledger={ledger_entry_id:uid(),idempotency_key:'payment:'+digest(charge),order_id:o.order_id,telegram_id:o.telegram_id,
 entry_type:'payment',direction:'credit',currency:'XTR',amount_stars:249,telegram_payment_charge_id:charge,reason_code:'offline_payment',occurred_at:at,recorded_at:at};
 insert(f,'payment_ledger',ledger);
 f.sqlite.prepare("UPDATE subscription_orders SET order_state='paid',paid_at=? WHERE order_id=?").run(at,o.order_id);
 if(!subscription)return ledger;
 const sub={subscription_id:uid(),telegram_id:o.telegram_id,plan_code:'professional',billing_mode:o.billing_mode,source_order_id:o.order_id,
 telegram_payment_charge_id:charge,status:'active',current_period_start:at,current_period_end:at+2592000,last_ledger_entry_id:ledger.ledger_entry_id,
 created_at:at,updated_at:at};insert(f,'subscriptions',sub);
 insert(f,'subscription_access_grants',{grant_id:uid(),grant_key:'access:'+ledger.ledger_entry_id,subscription_id:sub.subscription_id,order_id:o.order_id,
 payment_ledger_entry_id:ledger.ledger_entry_id,telegram_id:o.telegram_id,plan_code:'professional',access_seconds:2592000,starts_at:at,ends_at:at+2592000,
 status:'active',created_at:at,updated_at:at});
 f.sqlite.prepare("UPDATE subscription_orders SET order_state='applied',applied_at=? WHERE order_id=?").run(at,o.order_id);
 return {...ledger,sub};
}
function contractRow(f,o,patch={}){
 const terms={acceptance_id:uid(),telegram_id:o.telegram_id,terms_revision:o.terms_revision,acceptance_scope:'stars_purchase',evidence_sha256:digest('consent:'+o.order_id),accepted_at:o.created_at};
 const prior=f.sqlite.prepare('SELECT acceptance_id FROM terms_acceptances WHERE telegram_id=? AND terms_revision=?').get(o.telegram_id,o.terms_revision);
 if(!prior)insert(f,'terms_acceptances',terms);
 return {contract_id:uid(),telegram_id:o.telegram_id,plan_code:o.plan_code,price_id:o.price_id,origin_order_id:o.order_id,
 external_invoice_payload:o.invoice_payload,external_payload_sha256:digest(o.invoice_payload),terms_revision:o.terms_revision,
 terms_acceptance_id:prior?.acceptance_id??terms.acceptance_id,billing_mode:'recurring',period_seconds:2592000,currency:'XTR',amount_stars:249,
 created_at:f.now-10,updated_at:f.now-10,...patch};
}
function makeContract(f,o){const c=contractRow(f,o);insert(f,'subscription_billing_contracts',c);return c;}
function linkRow(f,o,p,{origin=o,contract=null,kind=contract?'recurring_charge':'late_prepaid_charge',direction='incoming',patch={}}={}){
 return {operation_id:uid(),operation_key:'op:'+digest(p.telegram_payment_charge_id+':'+direction),provider_charge_id:p.telegram_payment_charge_id,
 provider_charge_sha256:digest(p.telegram_payment_charge_id),direction,link_kind:kind,contract_id:contract?.contract_id??null,
 origin_order_id:origin.order_id,applied_order_id:direction==='incoming'?o.order_id:null,telegram_id:o.telegram_id,plan_code:o.plan_code,
 external_invoice_payload:origin.invoice_payload,external_payload_sha256:digest(origin.invoice_payload),
 ledger_entry_id:direction==='incoming'?p.ledger_entry_id:null,original_payment_ledger_entry_id:direction==='outgoing'?p.ledger_entry_id:null,
 provider_period_start:contract&&direction==='incoming'?f.now-2592100:null,provider_period_end:contract&&direction==='incoming'?f.now-100:null,
 evidence_sha256:digest('verified-provider-evidence:'+p.telegram_payment_charge_id),recorded_at:f.now,...patch};
}
const firstReceipt=(f,c,l,patch={})=>({contract_id:c.contract_id,operation_id:l.operation_id,evidence_sha256:l.evidence_sha256,verified_at:f.now,...patch});
function projection(f,o,p,{start=f.now-50,end=start+2592000,status='active'}={}) {
 const row={subscription_id:uid(),telegram_id:o.telegram_id,plan_code:o.plan_code,billing_mode:o.billing_mode,source_order_id:o.order_id,
  telegram_payment_charge_id:p.telegram_payment_charge_id,status,current_period_start:start,current_period_end:end,last_ledger_entry_id:p.ledger_entry_id,
  created_at:f.now,updated_at:f.now};insert(f,'subscriptions',row);return row;
}
const grant=(f,o,p,sub,{start=f.now-50,end=start+2592000,...patch}={})=>({grant_id:uid(),grant_key:'access:'+p.ledger_entry_id,subscription_id:sub.subscription_id,
 order_id:o.order_id,payment_ledger_entry_id:p.ledger_entry_id,telegram_id:o.telegram_id,plan_code:o.plan_code,access_seconds:2592000,
 starts_at:start,ends_at:end,status:'active',created_at:f.now,updated_at:f.now,...patch});
function appliedRecovery(f,origin,{at=f.now-50}={}) {
 const row={...origin,order_id:uid(),invoice_payload:'internal-recovery:'+uid(),order_state:'applied',paid_at:at,applied_at:f.now,updated_at:f.now};
 insert(f,'subscription_orders',row);
 const p={ledger_entry_id:uid(),idempotency_key:'payment:'+uid(),order_id:row.order_id,telegram_id:row.telegram_id,entry_type:'payment',direction:'credit',
  currency:'XTR',amount_stars:249,telegram_payment_charge_id:'real_late_charge_'+uid(),reason_code:'verified_late_payment',occurred_at:at,recorded_at:f.now};
 insert(f,'payment_ledger',p);return {child:row,p};
}
const command=(f,c,p,patch={})=>({command_id:uid(),idempotency_key:'own-control:'+uid(),contract_id:c.contract_id,telegram_id:c.telegram_id,
 action:'cancel_renewal',desired_auto_renew:0,expected_contract_revision:2,first_payment_ledger_entry_id:p.ledger_entry_id,
 request_sha256:digest('own-control'),created_at:f.now,updated_at:f.now,...patch});
const assertIntegrity=f=>{assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(f.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');};

test('0067 twice applies; 0066 and business rows stay frozen, only three reviewed guards change',t=>{
 const f=fixture(t,{apply:false}),o=order(f,{billing:'prepaid'});pay(f,o,{subscription:true});f.sqlite.exec(foundationMigration);
 const names=f.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name);
 const rows=Object.fromEntries(names.filter(n=>n!=='re_schema_migrations').map(n=>[n,f.sqlite.prepare('SELECT * FROM '+n).all()]));
 const before=f.sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
 f.sqlite.exec(bindingMigration);const after=f.sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
 const replaced=new Set(['v143_contract_update_binding','v143_provider_command_insert','trg_subscription_access_grants_payment_guard']);
 for(const row of before)if(!replaced.has(row.name))assert.deepEqual(after.find(candidate=>candidate.name===row.name),row);
 for(const [name,values]of Object.entries(rows))assert.deepEqual(f.sqlite.prepare('SELECT * FROM '+name).all(),values);
 f.sqlite.exec(bindingMigration);assert.deepEqual(f.sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),after);
 const old=fs.readFileSync(new URL('../migrations/0027-v1.3.6-stars-access-and-reconciliation.sql',import.meta.url),'utf8');
 const predicate=old.slice(old.indexOf('NOT EXISTS ('),old.indexOf('\nBEGIN',old.indexOf('NOT EXISTS (')));
 assert.ok(bindingMigration.includes(predicate+' OR NOT EXISTS(SELECT 1 FROM subscription_orders prepaid_order'),'exact accepted predicate remains scoped prepaid arm');
 assert.equal(digest(foundationMigration),'64ff4e7aff6042077c7bd3730112287381acd10051e1fdaa4f2c36b0edb036cb');assertIntegrity(f);
});

test('terminal origin late first recurring child admits own cancel and reenable only with real first receipt',t=>{
 const f=fixture(t),origin=order(f,{state:'cancelled'}),c=makeContract(f,origin),newer=order(f),{child,p}=appliedRecovery(f,origin);
 const l=linkRow(f,child,p,{origin,contract:c,patch:{provider_period_start:f.now-50,provider_period_end:f.now-50+2592000}});insert(f,'subscription_payment_links',l);
 const update=()=>f.sqlite.prepare('UPDATE subscription_billing_contracts SET first_payment_ledger_entry_id=?,revision=revision+1 WHERE contract_id=?').run(p.ledger_entry_id,c.contract_id);
 assert.throws(update,/v143_contract_update_invalid/u);
 assert.throws(()=>insert(f,'subscription_first_recurring_receipts',firstReceipt(f,c,l,{evidence_sha256:digest('wrong-authenticated-fact')})),/receipt_invalid/u);
 insert(f,'subscription_first_recurring_receipts',firstReceipt(f,c,l));update();
 const sub=projection(f,child,p),g=grant(f,child,p,sub);insert(f,'subscription_access_grants',g);
 for(const action of ['cancel_renewal','reenable_renewal']){
  const cmd=command(f,c,p,{action,desired_auto_renew:action==='cancel_renewal'?0:1});
  assert.throws(()=>insert(f,'subscription_provider_commands',{...cmd,telegram_id:202}),/admission_invalid/u);
  insert(f,'subscription_provider_commands',cmd);
  f.sqlite.prepare("UPDATE subscription_provider_commands SET state='superseded',revision=revision+1 WHERE command_id=?").run(cmd.command_id);
 }
 assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(origin.order_id).order_state,'cancelled');
 assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(newer.order_id).order_state,'created');
 assert.throws(()=>f.sqlite.prepare('UPDATE subscription_first_recurring_receipts SET verified_at=verified_at+1').run(),/append_only/u);assertIntegrity(f);
});

test('foreign first-charge links and non-first renewal cannot become contract first payment or command',t=>{
 const f=fixture(t),origin=order(f),c=makeContract(f,origin),first=pay(f,origin),l=linkRow(f,origin,first,{contract:c});insert(f,'subscription_payment_links',l);
 const foreign=order(f,{subject:202}),fc=makeContract(f,foreign),fp=pay(f,foreign),fl=linkRow(f,foreign,fp,{contract:fc});insert(f,'subscription_payment_links',fl);
 assert.throws(()=>insert(f,'subscription_first_recurring_receipts',firstReceipt(f,c,fl)),/receipt_invalid/u);
 f.sqlite.prepare("UPDATE subscription_orders SET order_state='applied',applied_at=? WHERE order_id=?").run(f.now,origin.order_id);
 const child=order(f),renewal=pay(f,child),rl=linkRow(f,child,renewal,{origin,contract:c});insert(f,'subscription_payment_links',rl);
 assert.throws(()=>insert(f,'subscription_first_recurring_receipts',firstReceipt(f,c,rl)),/receipt_invalid/u);
 assert.throws(()=>f.sqlite.prepare('UPDATE subscription_billing_contracts SET first_payment_ledger_entry_id=?,revision=revision+1 WHERE contract_id=?').run(renewal.ledger_entry_id,c.contract_id),/update_invalid/u);
 insert(f,'subscription_first_recurring_receipts',firstReceipt(f,c,l));
 f.sqlite.prepare('UPDATE subscription_billing_contracts SET first_payment_ledger_entry_id=?,revision=revision+1 WHERE contract_id=?').run(first.ledger_entry_id,c.contract_id);
 assert.throws(()=>insert(f,'subscription_provider_commands',command(f,c,renewal)),/admission_invalid/u);assertIntegrity(f);
});

test('historical recurring slice uses exact same-contract provider period without replacing current projection',t=>{
 const f=fixture(t),origin=order(f,{at:f.now-6000000}),c=makeContract(f,origin),head=pay(f,origin),headLink=linkRow(f,origin,head,{contract:c,
  patch:{provider_period_start:f.now-100,provider_period_end:f.now-100+2592000}});insert(f,'subscription_payment_links',headLink);
 const sub=projection(f,origin,head,{start:headLink.provider_period_start,end:headLink.provider_period_end});
 insert(f,'subscription_access_grants',grant(f,origin,head,sub,{start:headLink.provider_period_start,end:headLink.provider_period_end}));
 f.sqlite.prepare("UPDATE subscription_orders SET order_state='applied',applied_at=? WHERE order_id=?").run(f.now,origin.order_id);
 const {child,p}=appliedRecovery(f,origin,{at:f.now-3000000}),l=linkRow(f,child,p,{origin,contract:c});insert(f,'subscription_payment_links',l);
 const before=f.sqlite.prepare('SELECT * FROM subscriptions WHERE subscription_id=?').get(sub.subscription_id);
 const exact=grant(f,child,p,sub,{start:l.provider_period_start,end:l.provider_period_end});
 assert.throws(()=>insert(f,'subscription_access_grants',{...exact,starts_at:exact.starts_at+1,ends_at:exact.ends_at+1}),/not backed/u);
 assert.throws(()=>insert(f,'subscription_access_grants',{...exact,telegram_id:202}),/not backed/u);
 const unrelated=order(f),unrelatedPayment=pay(f,unrelated);f.sqlite.prepare("UPDATE subscription_orders SET order_state='applied',applied_at=? WHERE order_id=?").run(f.now,unrelated.order_id);
 const other=projection(f,unrelated,unrelatedPayment,{status:'expired'});
 assert.throws(()=>insert(f,'subscription_access_grants',{...exact,subscription_id:other.subscription_id}),/not backed/u);
 const wrongSourceCharge={...sub,subscription_id:uid(),status:'expired',telegram_payment_charge_id:'unrelated_projection_charge_'+uid()};
 // A projection with the same source order cannot exist twice; use a linked
 // internal source from this contract with a mismatching immutable charge.
 const sourceChild={...origin,order_id:uid(),invoice_payload:'internal-source:'+uid(),order_state:'applied',paid_at:f.now,applied_at:f.now,updated_at:f.now};
 insert(f,'subscription_orders',sourceChild);
 const sourcePayment={...p,ledger_entry_id:uid(),idempotency_key:'payment:'+uid(),order_id:sourceChild.order_id,telegram_payment_charge_id:'source_charge_'+uid()};
 insert(f,'payment_ledger',sourcePayment);insert(f,'subscription_payment_links',linkRow(f,sourceChild,sourcePayment,{origin,contract:c}));
 insert(f,'subscriptions',{...wrongSourceCharge,source_order_id:sourceChild.order_id});
 assert.throws(()=>insert(f,'subscription_access_grants',{...exact,subscription_id:wrongSourceCharge.subscription_id}),/not backed/u);
 insert(f,'subscription_access_grants',exact);assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscriptions WHERE subscription_id=?').get(sub.subscription_id),before);
 assertIntegrity(f);
});

test('old prepaid acceptance and rejection hold; applied late prepaid child preserves current open invoice',t=>{
 const f=fixture(t),o=order(f,{billing:'prepaid'}),p=pay(f,o),sub=projection(f,o,p),g=grant(f,o,p,sub);
 assert.throws(()=>insert(f,'subscription_access_grants',{...g,starts_at:g.starts_at+1,ends_at:g.ends_at+1}),/not backed/u);
 insert(f,'subscription_access_grants',g);f.sqlite.prepare("UPDATE subscription_orders SET order_state='applied',applied_at=? WHERE order_id=?").run(f.now,o.order_id);
 f.sqlite.prepare("UPDATE subscriptions SET status='expired' WHERE subscription_id=?").run(sub.subscription_id);
 const origin=order(f,{billing:'prepaid',state:'cancelled'}),newer=order(f,{billing:'prepaid'}),{child,p:late}=appliedRecovery(f,origin);
 const l=linkRow(f,child,late,{origin});insert(f,'subscription_payment_links',l);const lateSub=projection(f,child,late);
 insert(f,'subscription_access_grants',grant(f,child,late,lateSub));
 assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(newer.order_id).order_state,'created');assertIntegrity(f);
});

test('current-head recurring grant cannot bypass exact contract/link evidence through the old prepaid predicate',t=>{
 const f=fixture(t),o=order(f),c=makeContract(f,o),p=pay(f,o),sub=projection(f,o,p),g=grant(f,o,p,sub);
 assert.equal(sub.last_ledger_entry_id,g.payment_ledger_entry_id);assert.equal(sub.current_period_end,g.ends_at);
 assert.throws(()=>insert(f,'subscription_access_grants',g),/not backed/u);
 const l=linkRow(f,o,p,{contract:c,patch:{provider_period_start:g.starts_at,provider_period_end:g.ends_at}});insert(f,'subscription_payment_links',l);
 insert(f,'subscription_access_grants',g);assertIntegrity(f);
});

test('exact optional lifecycle readiness recognizes 0065,0066,0067 and rejects drift/partial extension',async t=>{
 const base=fixture(t,{apply:false});assert.equal((await inspectLifecycleSchema(base.binding)).present,false);
 base.sqlite.exec(foundationMigration);assert.equal((await inspectLifecycleSchema(base.binding)).marker,'1.4.3-subscription-lifecycle-foundation');
 base.sqlite.exec(bindingMigration);assert.equal((await inspectLifecycleSchema(base.binding)).marker,'1.4.3-lifecycle-engine-binding');
 base.sqlite.exec('DROP TRIGGER v143_first_recurring_receipt_binding');await assert.rejects(inspectLifecycleSchema(base.binding),/schema_not_ready/u);
 const partial=fixture(t,{apply:false});partial.sqlite.exec("INSERT INTO re_schema_migrations(version)VALUES('1.4.3-subscription-lifecycle-foundation')");
 await assert.rejects(inspectLifecycleSchema(partial.binding),/schema_not_ready/u);
 const generated=runPublicPython(['scripts/v1.4.3-build-lifecycle-schema.py','--check'],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
 assert.equal(generated.status,0,generated.stdout+generated.stderr);
});

test('actual Stars privacy summary/export and confirmed deletion retain lifecycle-only evidence',async t=>{
 const f=fixture(t),e={event_id:uid(),event_key:'privacy-own-control:'+uid(),telegram_id:101,event_type:'review_observed',source:'system',
  actor_type:'system',actor_id:null,reason_code:'authenticated_unknown_charge',evidence_sha256:digest('financial-observation'),received_at:f.now};
 insert(f,'subscription_provider_events',e);
 const own=await inspectLifecyclePrivacyRetention(f.binding,101);assert.equal(own.retainedFinancial,true);assert.equal(own.summary.providerEvents,1);
 const foreign=await inspectLifecyclePrivacyRetention(f.binding,202);assert.equal(foreign.retainedFinancial,false);
 const summary=await getStarsUserPrivacySummary({...f.serverEnv,DB:f.binding},101);assert.equal(summary.providerEvents,1);
 const blockers=await getStarsPrivacyDeletionBlockers({...f.serverEnv,DB:f.binding},101);assert.equal(blockers.blockers.length,1);
 await assert.rejects(prepareV141PrivacyDeletion({...f.serverEnv,DB:f.binding,V141_AUTHORIZATION_ENABLED:'true'},101,uid()),/financial_evidence_retained/u);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM subscription_provider_events').get().n,1);assertIntegrity(f);
});

test('atomic deletion fence rejects newly arrived lifecycle evidence after preparation',async t=>{
 const f=fixture(t),key=uid();f.sqlite.prepare(`INSERT INTO privacy_deletion_requests
  (request_id,telegram_id,confirmation_token,status,summary_json,expires_at) VALUES(?,101,?,'pending','{}',datetime(?,'unixepoch'))`).run(key,uid(),f.now+300);
 const prepared=await prepareV141PrivacyDeletion({...f.serverEnv,DB:f.binding,V141_AUTHORIZATION_ENABLED:'true'},101,key);
 insert(f,'subscription_provider_events',{event_id:uid(),event_key:'concurrent-financial:'+uid(),telegram_id:101,event_type:'review_observed',source:'system',
  actor_type:'system',actor_id:null,reason_code:'unknown_charge_receipt',evidence_sha256:digest('financial'),received_at:f.now});
 await assert.rejects(f.binding.batch(prepared.prefix),/CHECK/u);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM users WHERE telegram_id=101').get().n,1);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_privacy_guard').get().n,0);assertIntegrity(f);
});

test('0065 deletion preparation cannot erase a subject after lifecycle schema arrives',async t=>{
 const f=fixture(t,{apply:false}),key=uid();f.sqlite.prepare(`INSERT INTO privacy_deletion_requests
  (request_id,telegram_id,confirmation_token,status,summary_json,expires_at) VALUES(?,101,?,'pending','{}',datetime(?,'unixepoch'))`).run(key,uid(),f.now+300);
 const baseline=await getStarsUserPrivacySummary({...f.serverEnv,DB:f.binding},101);
 assert.deepEqual(Object.keys(baseline).sort(),['termsAcceptances','orders','ledgerEntries','subscriptions','refunds','openOrders','liveSubscriptions'].sort());
 const prepared=await prepareV141PrivacyDeletion({...f.serverEnv,DB:f.binding,V141_AUTHORIZATION_ENABLED:'true'},101,key);
 f.sqlite.exec(foundationMigration);
 await assert.rejects(f.binding.batch(prepared.prefix),/CHECK/u);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM users WHERE telegram_id=101').get().n,1);assertIntegrity(f);
});

test('policy-blocked genuine payment retains own existing ledger and review receipt; foreign binding grants nothing',async t=>{
 for(const billing of ['recurring','prepaid']){
  const f=fixture(t),origin=order(f,{billing,state:'cancelled'}),c=billing==='recurring'?makeContract(f,origin):null,newer=order(f,{billing});
  const evidence=digest('verified-policy-blocked-charge:'+uid()),updateId=70000;
  const p={ledger_entry_id:uid(),idempotency_key:'retained-real-payment:'+uid(),order_id:origin.order_id,telegram_id:origin.telegram_id,
   entry_type:'payment',direction:'credit',currency:'XTR',amount_stars:origin.amount_stars,telegram_payment_charge_id:'retained_charge_'+uid(),
   reason_code:'payment_review_retained',occurred_at:f.now-50,recorded_at:f.now};insert(f,'payment_ledger',p);
  insert(f,'payment_events',{event_id:uid(),event_key:'retained-receipt:'+uid(),order_id:origin.order_id,telegram_id:origin.telegram_id,
   telegram_update_id:updateId,event_type:'payment_recorded',outcome:'accepted',reason_code:'payment_review_retained',payload_sha256:evidence,
   occurred_at:f.now-50,received_at:f.now});
  const receipt={ledger_entry_id:p.ledger_entry_id,origin_order_id:origin.order_id,contract_id:c?.contract_id??null,
   telegram_id:origin.telegram_id,plan_code:origin.plan_code,external_invoice_payload:origin.invoice_payload,external_payload_sha256:digest(origin.invoice_payload),
   provider_period_start:c?f.now-50:null,provider_period_end:c?f.now-50+2592000:null,is_first_recurring:c?1:0,
   evidence_sha256:evidence,telegram_update_id:updateId,reason_code:'recovery_order_in_progress',recorded_at:f.now};
  assert.throws(()=>insert(f,'subscription_payment_review_receipts',{...receipt,telegram_id:202}),/review_receipt_invalid/u);
  assert.throws(()=>insert(f,'subscription_payment_review_receipts',{...receipt,evidence_sha256:digest('foreign-receipt')}),/review_receipt_invalid/u);
  insert(f,'subscription_payment_review_receipts',receipt);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM payment_ledger').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM subscription_payment_links').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM subscription_access_grants').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM subscriptions').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(origin.order_id).order_state,'cancelled');
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(newer.order_id).order_state,'created');
  assert.equal((await inspectLifecyclePrivacyRetention(f.binding,101)).summary.paymentReviewReceipts,1);
  assert.equal((await inspectLifecyclePrivacyRetention(f.binding,202)).summary.paymentReviewReceipts,0);
  await assert.rejects(prepareV141PrivacyDeletion({...f.serverEnv,DB:f.binding,V141_AUTHORIZATION_ENABLED:'true'},101,uid()),/financial_evidence_retained/u);
  assert.throws(()=>f.sqlite.prepare('DELETE FROM subscription_payment_review_receipts').run(),/append_only/u);assertIntegrity(f);
 }
});

test('genuine first after verified paid-origin renewal requires own prior charge and strictly earlier non-overlapping period',t=>{
 const f=fixture(t),origin=order(f,{at:f.now-6000000}),c=makeContract(f,origin),renewal=pay(f,origin);
 const prior=linkRow(f,origin,renewal,{contract:c}),{child,p}=appliedRecovery(f,origin);
 const first=linkRow(f,child,p,{origin,contract:c,patch:{provider_period_start:prior.provider_period_start-2592000,provider_period_end:prior.provider_period_start}});
 insert(f,'subscription_payment_links',first);
 assert.throws(()=>insert(f,'subscription_first_recurring_receipts',firstReceipt(f,c,first)),/receipt_invalid/u,'a paid origin alone is insufficient');
 const foreign=order(f,{subject:202}),fc=makeContract(f,foreign),fp=pay(f,foreign),fl=linkRow(f,foreign,fp,{contract:fc});insert(f,'subscription_payment_links',fl);
 assert.throws(()=>insert(f,'subscription_first_recurring_receipts',firstReceipt(f,c,first)),/receipt_invalid/u,'foreign later renewal is insufficient');
 insert(f,'subscription_payment_links',prior);
 for(const end of [prior.provider_period_start+1,prior.provider_period_end,prior.provider_period_end+2592000]){
  const candidate=appliedRecovery(f,origin),bad=linkRow(f,candidate.child,candidate.p,{origin,contract:c,
   patch:{provider_period_start:end-2592000,provider_period_end:end}});insert(f,'subscription_payment_links',bad);
  assert.throws(()=>insert(f,'subscription_first_recurring_receipts',firstReceipt(f,c,bad)),/receipt_invalid/u,'overlapping/equal/later period cannot become the genuine first');
 }
 insert(f,'subscription_first_recurring_receipts',firstReceipt(f,c,first));
 f.sqlite.prepare('UPDATE subscription_billing_contracts SET first_payment_ledger_entry_id=?,revision=revision+1 WHERE contract_id=?').run(p.ledger_entry_id,c.contract_id);
 const sub=projection(f,child,p,{start:first.provider_period_start,end:first.provider_period_end});
 insert(f,'subscription_access_grants',grant(f,child,p,sub,{start:first.provider_period_start,end:first.provider_period_end}));
 const firstGrant=f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE payment_ledger_entry_id=?').get(p.ledger_entry_id);
 assert.equal(firstGrant.starts_at,first.provider_period_start);assert.equal(firstGrant.ends_at,prior.provider_period_start);
 assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(origin.order_id).order_state,'paid');
 assert.equal(f.sqlite.prepare('SELECT first_payment_ledger_entry_id FROM subscription_billing_contracts WHERE contract_id=?').get(c.contract_id).first_payment_ledger_entry_id,p.ledger_entry_id);
 assertIntegrity(f);
});
