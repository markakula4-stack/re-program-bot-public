import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { runPublicPython } from './helpers/public-python.mjs';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { inspectLifecycleSchema } from '../src/v1.4.3/lifecycle-schema.mjs';
import { inspectLifecyclePrivacyRetention, lifecycleRetentionAssertion } from '../src/v1.4.3/privacy-retention.mjs';
import { prepareV141PrivacyDeletion } from '../src/v1.4.1/privacy-maintenance.mjs';
import { getStarsUserPrivacySummary, getStarsPrivacyDeletionBlockers } from '../src/v1.3.6/stars-access-runtime.mjs';

const foundationMigration=fs.readFileSync(new URL('../migrations/0066-v1.4.3-subscription-lifecycle-foundation.sql',import.meta.url),'utf8');
const providerMigration=fs.readFileSync(new URL('../migrations/0068-v1.4.3-provider-and-review-binding.sql',import.meta.url),'utf8');
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
 insert(f,'price_book',{price_id:'professional-30d-recurring-v143-test',price_version:9,plan_code:'professional',currency:'XTR',amount_stars:249,
  access_seconds:2592000,billing_mode:'recurring',publication_state:'approved',terms_revision:'2026-10-03.recurring-test',valid_from:f.now-9000000,created_at:f.now-9000000,created_by:'offline-test'});
 if(apply){f.sqlite.exec(foundationMigration);f.sqlite.exec(bindingMigration);}return f;
}
function order(f,{subject=101,billing='recurring',state='created',payload,at=f.now-100}={}){
 const id=uid(),external=payload??'offline:'+id;
 const row={order_id:id,telegram_id:subject,price_id:billing==='recurring'?'professional-30d-recurring-v143-test':'professional-30d-prepaid-v1',
 price_version:billing==='recurring'?9:1,plan_code:'professional',currency:'XTR',amount_stars:249,access_seconds:2592000,billing_mode:billing,
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


const providerFixture=t=>{const f=fixture(t);f.sqlite.exec(providerMigration);return f;};
function retained(f,{billing='recurring',subject=101,first=true}={}) {
 const origin=order(f,{billing,subject,state:'cancelled'}),c=billing==='recurring'?makeContract(f,origin):null;
 const p={ledger_entry_id:uid(),idempotency_key:'retained-payment:'+uid(),order_id:origin.order_id,telegram_id:subject,
  entry_type:'payment',direction:'credit',currency:'XTR',amount_stars:origin.amount_stars,telegram_payment_charge_id:'retained_'+uid(),
  reason_code:'payment_review_retained',occurred_at:f.now-50,recorded_at:f.now};insert(f,'payment_ledger',p);
 const evidence=digest('authenticated-successful-payment:'+uid()),updateId=subject;
 insert(f,'payment_events',{event_id:uid(),event_key:'retained-received:'+uid(),order_id:origin.order_id,telegram_id:subject,
  telegram_update_id:updateId,event_type:'payment_recorded',outcome:'accepted',reason_code:'payment_review_retained',payload_sha256:evidence,
  occurred_at:p.occurred_at,received_at:f.now});
 const r={ledger_entry_id:p.ledger_entry_id,origin_order_id:origin.order_id,contract_id:c?.contract_id??null,telegram_id:subject,
  plan_code:origin.plan_code,external_invoice_payload:origin.invoice_payload,external_payload_sha256:digest(origin.invoice_payload),
  provider_period_start:c?p.occurred_at:null,provider_period_end:c?p.occurred_at+2592000:null,is_first_recurring:c&&first?1:0,
  evidence_sha256:evidence,telegram_update_id:updateId,reason_code:'recovery_policy_review',recorded_at:f.now};
 insert(f,'subscription_payment_review_receipts',r);return {origin,c,p,r};
}
function settlementRows(f,source,{childPatch={}}={}){
 const {origin,p,r,c}=source;
 const child={...origin,order_id:uid(),invoice_payload:'internal-settled:'+uid(),order_state:'applied',
  precheckout_approved_at:p.occurred_at,paid_at:p.occurred_at,applied_at:f.now,updated_at:f.now,...childPatch};
 insert(f,'subscription_orders',child);
 const l=linkRow(f,child,p,{origin,contract:c,patch:{provider_period_start:r.provider_period_start,provider_period_end:r.provider_period_end,evidence_sha256:r.evidence_sha256}});
 const s={ledger_entry_id:p.ledger_entry_id,applied_order_id:child.order_id,operation_id:l.operation_id,resolution_key:'review-apply:'+uid(),
  actor_id:900,reason_code:'owner_verified_receipt',evidence_sha256:digest('owner-decision:'+uid()),settled_at:f.now};
 return {child,l,s};
}
function settle(f,source){
 const rows=settlementRows(f,source);insert(f,'subscription_payment_review_settlements',rows.s);insert(f,'subscription_payment_links',rows.l);
 if(source.c&&source.r.is_first_recurring){
  insert(f,'subscription_first_recurring_receipts',firstReceipt(f,source.c,rows.l));
  f.sqlite.prepare('UPDATE subscription_billing_contracts SET first_payment_ledger_entry_id=?,revision=revision+1 WHERE contract_id=?')
   .run(source.p.ledger_entry_id,source.c.contract_id);
 }
 const start=source.r.provider_period_start??source.p.occurred_at,end=source.r.provider_period_end??start+2592000;
 const sub=projection(f,rows.child,source.p,{start,end}),g=grant(f,rows.child,source.p,sub,{start,end});insert(f,'subscription_access_grants',g);
 return {...rows,sub,g};
}

test('0068 preserves frozen0066/0067, normal DDL and all business rows; twice apply seeds only separate same-price recurring products',async t=>{
 const f=fixture(t),o=order(f,{billing:'prepaid'});pay(f,o,{subscription:true});
 const before=f.sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
 const names=before.filter(row=>row.type==='table'&&!row.name.startsWith('sqlite_')).map(row=>row.name);
 const rows=Object.fromEntries(names.filter(name=>name!=='re_schema_migrations'&&name!=='price_book').map(name=>[name,f.sqlite.prepare('SELECT * FROM '+name).all()]));
 const prices=f.sqlite.prepare('SELECT * FROM price_book ORDER BY price_id').all();f.sqlite.exec(providerMigration);
 const after=f.sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
 const replaced=new Set(['v143_payment_link_incoming_binding','v143_first_recurring_receipt_binding','v143_contract_update_binding',
  'v143_provider_command_insert','trg_subscription_access_grants_payment_guard','trg_subscription_access_grants_compensation_guard']);
 for(const row of before)if(!replaced.has(row.name))assert.deepEqual(after.find(candidate=>candidate.name===row.name),row);
 for(const [name,values]of Object.entries(rows))assert.deepEqual(f.sqlite.prepare('SELECT * FROM '+name).all(),values);
 for(const price of prices)assert.deepEqual(f.sqlite.prepare('SELECT * FROM price_book WHERE price_id=?').get(price.price_id),price);
 const seeds=f.sqlite.prepare("SELECT price_id,plan_code,amount_stars,billing_mode,terms_revision,access_seconds FROM price_book WHERE price_id IN ('professional-30d-recurring-v1','dragon-30d-recurring-v1') ORDER BY amount_stars").all();
 assert.deepEqual(seeds.map(row=>[row.plan_code,row.amount_stars,row.billing_mode,row.access_seconds,row.terms_revision]),[
  ['professional',249,'recurring',2592000,'2026-10-03.stars-recurring-v1'],['dragon',499,'recurring',2592000,'2026-10-03.stars-recurring-v1']]);
 f.sqlite.exec(providerMigration);assert.deepEqual(f.sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),after);
 assert.equal((await inspectLifecycleSchema(f.binding)).marker,'1.4.3-provider-and-review-binding');
 assert.equal(digest(foundationMigration),'64ff4e7aff6042077c7bd3730112287381acd10051e1fdaa4f2c36b0edb036cb');
 assert.equal(digest(bindingMigration),'3f6c7992006005bd029c8d7b22dd9cfcb08bb98f0df657c5f9bf465418e15d09');assertIntegrity(f);
});

test('unknown recurring v1 price slot causes whole migration rollback instead of silent canonical seed reuse',t=>{
 const f=fixture(t);insert(f,'price_book',{price_id:'unreviewed-recurring-v1',price_version:1,plan_code:'professional',currency:'XTR',amount_stars:250,
  access_seconds:2592000,billing_mode:'recurring',publication_state:'approved',terms_revision:'unreviewed.recurring.v1',valid_from:f.now-100,created_at:f.now-100,created_by:'offline-test'});
 const before=f.sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
 assert.throws(()=>f.sqlite.exec('BEGIN;'+providerMigration+';COMMIT;'),/CHECK/u);f.sqlite.exec('ROLLBACK');
 assert.deepEqual(f.sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),before);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM price_book WHERE price_id IN ('professional-30d-recurring-v1','dragon-30d-recurring-v1')").get().n,0);
 assertIntegrity(f);
});

test('invoice journal binds own contract, persists one confirmed link and forbids repeating unknown/confirmed attempts',async t=>{
 const f=providerFixture(t),o=order(f),c=makeContract(f,o),request={request_id:uid(),idempotency_key:'invoice-request:'+uid(),contract_id:c.contract_id,
  origin_order_id:o.order_id,telegram_id:o.telegram_id,expected_contract_revision:1,request_sha256:digest('private-fixed-invoice'),created_at:f.now,updated_at:f.now};
 assert.throws(()=>insert(f,'subscription_invoice_requests',{...request,telegram_id:202}),/admission_invalid/u);insert(f,'subscription_invoice_requests',request);
 assert.throws(()=>f.sqlite.prepare("UPDATE subscription_invoice_requests SET state='rejected',attempted_count=1,attempted_at=?,revision=revision+1 WHERE request_id=?").run(f.now,request.request_id),/transition_invalid/u);
 f.sqlite.prepare("UPDATE subscription_invoice_requests SET state='attempted',attempted_count=1,attempted_at=?,revision=revision+1 WHERE request_id=?").run(f.now,request.request_id);
 f.sqlite.prepare("UPDATE subscription_invoice_requests SET state='unknown',error_code='provider_response_lost',revision=revision+1 WHERE request_id=?").run(request.request_id);
 assert.throws(()=>f.sqlite.prepare("UPDATE subscription_invoice_requests SET state='attempted',revision=revision+1 WHERE request_id=?").run(request.request_id),/transition_invalid/u);
 const url='https://t.me/$verified_invoice';f.sqlite.prepare("UPDATE subscription_invoice_requests SET state='confirmed',invoice_url=?,provider_result_sha256=?,error_code='',revision=revision+1 WHERE request_id=?").run(url,digest(url),request.request_id);
 assert.equal(f.sqlite.prepare('SELECT invoice_url FROM subscription_invoice_requests WHERE request_id=?').get(request.request_id).invoice_url,url);
 assert.throws(()=>f.sqlite.prepare("UPDATE subscription_invoice_requests SET invoice_url='https://t.me/$other',revision=revision+1 WHERE request_id=?").run(request.request_id),/transition_invalid/u);
 assert.throws(()=>insert(f,'subscription_invoice_requests',{...request,request_id:uid(),idempotency_key:'invoice-repeat:'+uid()}),/UNIQUE/u);
 assert.equal((await inspectLifecyclePrivacyRetention(f.binding,101)).summary.invoiceRequests,1);
 assert.equal((await inspectLifecyclePrivacyRetention(f.binding,202)).summary.invoiceRequests,0);
 assert.equal((await getStarsUserPrivacySummary({...f.serverEnv,DB:f.binding},101)).invoiceRequests,1);
 assert.throws(()=>f.sqlite.prepare('DELETE FROM subscription_invoice_requests').run(),/retains_attempt/u);assertIntegrity(f);
});

test('invoice attempt requires unchanged contract and unexpired own created order',t=>{
 const f=providerFixture(t),o=order(f),c=makeContract(f,o),request={request_id:uid(),idempotency_key:'invoice-request:'+uid(),contract_id:c.contract_id,
  origin_order_id:o.order_id,telegram_id:o.telegram_id,expected_contract_revision:1,request_sha256:digest('invoice'),created_at:f.now,updated_at:f.now};
 insert(f,'subscription_invoice_requests',request);
 f.sqlite.prepare('UPDATE subscription_billing_contracts SET revision=revision+1 WHERE contract_id=?').run(c.contract_id);
 assert.throws(()=>f.sqlite.prepare("UPDATE subscription_invoice_requests SET state='attempted',attempted_count=1,attempted_at=?,revision=revision+1 WHERE request_id=?").run(f.now,request.request_id),/transition_invalid/u);
 assert.equal(f.sqlite.prepare('SELECT attempted_count FROM subscription_invoice_requests').get().attempted_count,0);assertIntegrity(f);
});

test('owner retained settlement admits one real recurring slice/first charge/command without rewriting original ledger or origin',t=>{
 const f=providerFixture(t),source=retained(f),{origin,c,p,r}=source,{child,l,s}=settlementRows(f,source);
 const original=f.sqlite.prepare('SELECT * FROM payment_ledger WHERE ledger_entry_id=?').get(p.ledger_entry_id);
 assert.throws(()=>insert(f,'subscription_payment_links',l),/binding_invalid/u);
 const badChild=settlementRows(f,source,{childPatch:{telegram_id:202}});
 assert.throws(()=>insert(f,'subscription_payment_review_settlements',badChild.s),/settlement_invalid/u);
 insert(f,'subscription_payment_review_settlements',s);
 assert.throws(()=>insert(f,'subscription_payment_links',{...l,evidence_sha256:digest('wrong-source')}),/binding_invalid/u);
 assert.throws(()=>insert(f,'subscription_payment_links',{...l,provider_period_start:l.provider_period_start+1,provider_period_end:l.provider_period_end+1}),/binding_invalid/u);
 insert(f,'subscription_payment_links',l);insert(f,'subscription_first_recurring_receipts',firstReceipt(f,c,l));
 f.sqlite.prepare('UPDATE subscription_billing_contracts SET first_payment_ledger_entry_id=?,revision=revision+1 WHERE contract_id=?').run(p.ledger_entry_id,c.contract_id);
 const sub=projection(f,child,p,{start:r.provider_period_start,end:r.provider_period_end}),g=grant(f,child,p,sub,{start:r.provider_period_start,end:r.provider_period_end});
 assert.throws(()=>insert(f,'subscription_access_grants',{...g,telegram_id:202}),/not backed/u);insert(f,'subscription_access_grants',g);
 insert(f,'subscription_provider_commands',command(f,c,p));
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM payment_ledger WHERE ledger_entry_id=?').get(p.ledger_entry_id),original);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM payment_ledger').get().n,1);
 assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(origin.order_id).order_state,'cancelled');
 assert.throws(()=>f.sqlite.prepare('UPDATE subscription_payment_review_settlements SET actor_id=202').run(),/append_only/u);assertIntegrity(f);
});

test('retained renewal false marker never becomes a first charge; compensated retained money cannot be settled',t=>{
 const f=providerFixture(t),source=retained(f,{first:false}),rows=settlementRows(f,source);
 insert(f,'subscription_payment_review_settlements',rows.s);insert(f,'subscription_payment_links',rows.l);
 assert.throws(()=>insert(f,'subscription_first_recurring_receipts',firstReceipt(f,source.c,rows.l)),/receipt_invalid/u);
 const h=providerFixture(t),paid=retained(h),child=settlementRows(h,paid),comp={...paid.p,ledger_entry_id:uid(),idempotency_key:'refund:'+uid(),
  entry_type:'refund',direction:'debit',related_ledger_entry_id:paid.p.ledger_entry_id,reason_code:'verified_refund'};insert(h,'payment_ledger',comp);
 assert.throws(()=>insert(h,'subscription_payment_review_settlements',child.s),/settlement_invalid/u);assertIntegrity(f);assertIntegrity(h);
});

test('settled retained credit refund binds original debit to exact child; foreign compensation is rejected',t=>{
 for(const billing of ['recurring','prepaid']){
  const f=providerFixture(t),source=retained(f,{billing}),settled=settle(f,source);
  const other=retained(f,{billing,subject:202}),foreign={...other.p,ledger_entry_id:uid(),idempotency_key:'foreign-refund:'+uid(),
   entry_type:'refund',direction:'debit',related_ledger_entry_id:other.p.ledger_entry_id,reason_code:'verified_refund'};insert(f,'payment_ledger',foreign);
  const update=id=>f.sqlite.prepare("UPDATE subscription_access_grants SET status='refunded',compensation_ledger_entry_id=?,updated_at=? WHERE grant_id=?")
   .run(id,f.now,settled.g.grant_id);
  assert.throws(()=>update(foreign.ledger_entry_id),/compensation does not match/u);
  const comp={...source.p,ledger_entry_id:uid(),idempotency_key:'refund:'+uid(),entry_type:'refund',direction:'debit',
   related_ledger_entry_id:source.p.ledger_entry_id,reason_code:'verified_refund'};insert(f,'payment_ledger',comp);update(comp.ledger_entry_id);
  f.sqlite.prepare("UPDATE subscription_orders SET order_state='refunded',closed_at=? WHERE order_id=?").run(f.now,settled.child.order_id);
  assert.equal(f.sqlite.prepare('SELECT status FROM subscription_access_grants WHERE grant_id=?').get(settled.g.grant_id).status,'refunded');
  assert.equal(f.sqlite.prepare('SELECT order_id FROM payment_ledger WHERE ledger_entry_id=?').get(comp.ledger_entry_id).order_id,source.origin.order_id);
  assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(source.origin.order_id).order_state,'cancelled');assertIntegrity(f);
 }
});

test('ordinary prepaid payment, grant rejection and genuine refund keep accepted behavior after0068',t=>{
 const f=providerFixture(t),o=order(f,{billing:'prepaid'}),p=pay(f,o),sub=projection(f,o,p),g=grant(f,o,p,sub);
 assert.throws(()=>insert(f,'subscription_access_grants',{...g,starts_at:g.starts_at+1,ends_at:g.ends_at+1}),/not backed/u);
 insert(f,'subscription_access_grants',g);f.sqlite.prepare("UPDATE subscription_orders SET order_state='applied',applied_at=? WHERE order_id=?").run(f.now,o.order_id);
 const comp={...p,ledger_entry_id:uid(),idempotency_key:'ordinary-refund:'+uid(),entry_type:'refund',direction:'debit',related_ledger_entry_id:p.ledger_entry_id,
  reason_code:'verified_refund'};insert(f,'payment_ledger',comp);
 f.sqlite.prepare("UPDATE subscription_access_grants SET status='refunded',compensation_ledger_entry_id=?,updated_at=? WHERE grant_id=?").run(comp.ledger_entry_id,f.now,g.grant_id);
 assert.equal(f.sqlite.prepare('SELECT status FROM subscription_access_grants WHERE grant_id=?').get(g.grant_id).status,'refunded');assertIntegrity(f);
});

test('invoice/settlement financial metadata is counted for subject and owner and blocks ordinary deletion; third-stage drift fails closed',async t=>{
 const f=providerFixture(t),source=retained(f),settled=settle(f,source);
 const own=await inspectLifecyclePrivacyRetention(f.binding,101),owner=await inspectLifecyclePrivacyRetention(f.binding,900);
 assert.equal(own.summary.paymentReviewSettlements,1);assert.equal(owner.summary.paymentReviewSettlements,1);
 const foreign=await inspectLifecyclePrivacyRetention(f.binding,202);assert.equal(foreign.summary.paymentReviewSettlements,0);
 await assert.rejects(prepareV141PrivacyDeletion({...f.serverEnv,DB:f.binding,V141_AUTHORIZATION_ENABLED:'true'},101,uid()),/financial_evidence_retained/u);
 f.sqlite.exec('DROP TRIGGER v143_review_settlement_binding');await assert.rejects(inspectLifecycleSchema(f.binding),/schema_not_ready/u);
 const generated=runPublicPython(['scripts/v1.4.3-build-lifecycle-schema.py','--check'],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
 assert.equal(generated.status,0,generated.stdout+generated.stderr);assert.ok(settled.g.grant_id);assertIntegrity(f);
});

test('cumulative0069–0071 profiles retain invoice and settlement evidence with exact privacy assertions',async t=>{
 const f=providerFixture(t),source=retained(f);settle(f,source);
 const o=order(f,{subject:202}),c=makeContract(f,o);
 insert(f,'subscription_invoice_requests',{request_id:uid(),idempotency_key:'invoice-privacy:'+uid(),contract_id:c.contract_id,
  origin_order_id:o.order_id,telegram_id:o.telegram_id,expected_contract_revision:1,
  request_sha256:digest('invoice-privacy'),created_at:f.now,updated_at:f.now});
 for(const file of ['0069-v1.4.3-d1-compatibility.sql','0070-v1.4.3-refund-notification.sql','0071-v1.4.3-refund-contract-retirement.sql']){
  f.sqlite.exec('BEGIN;'+fs.readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8')+';COMMIT;');
  const own=await inspectLifecyclePrivacyRetention(f.binding,101),invoice=await inspectLifecyclePrivacyRetention(f.binding,202),owner=await inspectLifecyclePrivacyRetention(f.binding,900);
  assert.equal(own.summary.paymentReviewSettlements,1);assert.equal(owner.summary.paymentReviewSettlements,1);
  assert.equal(invoice.summary.invoiceRequests,1);assert.equal(invoice.summary.paymentReviewSettlements,0);
  const assertion=lifecycleRetentionAssertion(own.state,101);
  assert.match(assertion.sql,/NOT EXISTS\(SELECT 1 FROM subscription_invoice_requests WHERE telegram_id=\?\)/u);
  assert.match(assertion.sql,/NOT EXISTS\(SELECT 1 FROM subscription_payment_review_settlements s/u);
  if(file.startsWith('0071'))assert.match(assertion.sql,/NOT EXISTS\(SELECT 1 FROM subscription_refund_cancellations WHERE telegram_id=\? OR actor_id=\?\)/u);
  assert.equal(f.sqlite.prepare('SELECT CASE WHEN ('+assertion.sql+') THEN 1 ELSE 0 END ok').get(...assertion.params).ok,0);
 }
 assertIntegrity(f);
});
