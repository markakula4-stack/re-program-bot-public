import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';

const migration=fs.readFileSync(new URL('../migrations/0066-v1.4.3-subscription-lifecycle-foundation.sql',import.meta.url),'utf8');
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
  access_seconds:2592000,billing_mode:'recurring',publication_state:'approved',terms_revision:'2026-10-03.recurring-test',valid_from:f.now-86400,created_at:f.now-86400,created_by:'offline-test'});
 if(apply)f.sqlite.exec(migration);return f;
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
const oldRows=f=>{const names=f.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'").all().map(r=>r.name).filter(n=>!tables.includes(n));
 return Object.fromEntries(names.map(name=>[name,f.sqlite.prepare('SELECT * FROM "'+name+'"').all().filter(r=>name!=='re_schema_migrations'||r.version!=='1.4.3-subscription-lifecycle-foundation')]));};
const oldDDL=f=>f.sqlite.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT LIKE 'idx_v143_%' AND name NOT LIKE 'v143_%' AND tbl_name NOT IN ("+tables.map(()=>'?').join(',')+") ORDER BY type,name").all(...tables);
const fk=f=>assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);

test('0066 is additive/idempotent and preserves accepted 0065 schema and all seeded old business rows',t=>{
 const f=fixture(t,{apply:false});const o=order(f,{billing:'prepaid'});pay(f,o,{subscription:true});
 const rows=oldRows(f),ddl=oldDDL(f);f.sqlite.exec(migration);const expanded=f.sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
 assert.deepEqual(oldRows(f),rows);assert.deepEqual(oldDDL(f),ddl);f.sqlite.exec(migration);
 assert.deepEqual(f.sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),expanded);
 assert.deepEqual(oldRows(f),rows);assert.deepEqual(oldDDL(f),ddl);fk(f);
 assert.equal(f.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 assert.deepEqual(f.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ("+tables.map(()=>'?').join(',')+") ORDER BY name").all(...tables).map(r=>r.name),[...tables].sort());
 assert.doesNotMatch(migration,/\b(?:ALTER|DROP|DELETE|UPDATE)\s+(?:TABLE\s+)?(?:payment_ledger|subscription_orders|subscriptions|users|notification_jobs)\b/iu);
});

test('contract binds own recurring order, distinct terms consent, plan and original provider payload',t=>{
 const f=fixture(t),o=order(f),row=contractRow(f,o),foreign=order(f,{subject:202}),foreignRow=contractRow(f,foreign);
 for(const patch of [{telegram_id:202},{plan_code:'dragon'},{external_invoice_payload:'forged-provider-payload'},{terms_acceptance_id:foreignRow.terms_acceptance_id}])
  assert.throws(()=>insert(f,'subscription_billing_contracts',{...row,contract_id:uid(),...patch}),/v143_contract_binding_invalid/u);
 insert(f,'subscription_billing_contracts',row);
 assert.throws(()=>f.sqlite.prepare("UPDATE subscription_billing_contracts SET provider_state='active',revision=revision+1 WHERE contract_id=?").run(row.contract_id),/v143_contract_update_invalid/u);
 assert.throws(()=>f.sqlite.prepare('DELETE FROM subscription_billing_contracts WHERE contract_id=?').run(row.contract_id),/retains_evidence/u);fk(f);
});

test('recurring charge has separate child order; historical paid-until is accepted without inventing access',t=>{
 const f=fixture(t),origin=order(f),c=makeContract(f,origin),first=pay(f,origin,{subscription:true});
 const firstLink=linkRow(f,origin,first,{contract:c});insert(f,'subscription_payment_links',firstLink);
 const child=order(f,{payload:'internal-child:'+uid()}),renewal=pay(f,child),row=linkRow(f,child,renewal,{origin,contract:c});
 insert(f,'subscription_payment_links',row);
 assert.equal(row.provider_period_end<f.now,true);
 assert.notEqual(child.invoice_payload,row.external_invoice_payload);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n,1);
 assert.throws(()=>insert(f,'subscription_payment_links',{...row,operation_id:uid(),operation_key:'collision:'+uid()}),/UNIQUE/u);
 const foreign=order(f,{subject:202}),foreignPayment=pay(f,foreign);
 assert.throws(()=>insert(f,'subscription_payment_links',linkRow(f,child,foreignPayment,{origin,contract:c})),/binding_invalid/u);
 assert.throws(()=>insert(f,'subscription_payment_links',{...row,operation_id:uid(),operation_key:'bad-payload:'+uid(),provider_charge_id:'unknown_charge',external_invoice_payload:child.invoice_payload}),/binding_invalid/u);
 fk(f);
});

test('late prepaid recovery preserves cancelled origin and immutable original snapshot',t=>{
 const f=fixture(t),origin=order(f,{billing:'prepaid',state:'cancelled'}),child=order(f,{billing:'prepaid',payload:'internal-late:'+uid()}),p=pay(f,child,{subscription:true});
 insert(f,'subscription_payment_links',linkRow(f,child,p,{origin}));
 assert.equal(f.sqlite.prepare('SELECT order_state FROM subscription_orders WHERE order_id=?').get(origin.order_id).order_state,'cancelled');
 assert.throws(()=>f.sqlite.prepare("UPDATE subscription_orders SET order_state='paid',paid_at=? WHERE order_id=?").run(f.now,origin.order_id),/invalid order state transition/u);
 const recurringChild=order(f),bad=pay(f,recurringChild);
 assert.throws(()=>insert(f,'subscription_payment_links',linkRow(f,recurringChild,bad,{origin})),/binding_invalid/u);fk(f);
});

test('same provider charge keeps separate incoming/outgoing identities; unknown outgoing creates no money',t=>{
 const f=fixture(t),o=order(f),c=makeContract(f,o),p=pay(f,o),incoming=linkRow(f,o,p,{contract:c});insert(f,'subscription_payment_links',incoming);
 const outgoing=linkRow(f,o,p,{contract:c,direction:'outgoing',kind:'outgoing_observation'});insert(f,'subscription_payment_links',outgoing);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_payment_links WHERE provider_charge_id=?').get(p.telegram_payment_charge_id).n,2);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_ledger').get().n,1);
 assert.equal(f.sqlite.prepare('SELECT ledger_entry_id FROM subscription_payment_links WHERE direction=\'outgoing\'').get().ledger_entry_id,null);
 assert.throws(()=>insert(f,'subscription_payment_links',{...outgoing,operation_id:uid(),operation_key:'another-key:'+uid()}),/UNIQUE/u);
 assert.throws(()=>f.sqlite.prepare("UPDATE subscription_payment_links SET direction='incoming' WHERE operation_id=?").run(outgoing.operation_id),/append_only/u);fk(f);
});

test('provider control is authenticated-source evidence with same contract and subject; commands acknowledge separately',t=>{
 const f=fixture(t),o=order(f),c=makeContract(f,o),p=pay(f,o);insert(f,'subscription_payment_links',linkRow(f,o,p,{contract:c}));
 f.sqlite.prepare('UPDATE subscription_billing_contracts SET first_payment_ledger_entry_id=?,revision=revision+1 WHERE contract_id=?').run(p.ledger_entry_id,c.contract_id);
 const cmd={command_id:uid(),idempotency_key:'own-control:'+uid(),contract_id:c.contract_id,telegram_id:101,action:'reenable_renewal',desired_auto_renew:1,
 expected_contract_revision:2,first_payment_ledger_entry_id:p.ledger_entry_id,request_sha256:digest('own_request'),created_at:f.now,updated_at:f.now};
 assert.throws(()=>insert(f,'subscription_provider_commands',{...cmd,command_id:uid(),telegram_id:202}),/admission_invalid/u);
 insert(f,'subscription_provider_commands',cmd);
 f.sqlite.prepare("UPDATE subscription_provider_commands SET state='attempted',attempted_count=1,attempted_at=?,revision=revision+1 WHERE command_id=?").run(f.now,cmd.command_id);
 f.sqlite.prepare("UPDATE subscription_provider_commands SET state='unknown',revision=revision+1 WHERE command_id=?").run(cmd.command_id);
 assert.throws(()=>f.sqlite.prepare("UPDATE subscription_provider_commands SET state='attempted',revision=revision+1 WHERE command_id=?").run(cmd.command_id),/transition_invalid/u);
 const ack={event_id:uid(),event_key:'acknowledgement:'+uid(),contract_id:c.contract_id,command_id:cmd.command_id,telegram_id:101,event_type:'command_confirmed',
 source:'provider_response',provider_state:null,actor_type:'system',actor_id:null,reason_code:'reenable_permitted',evidence_sha256:digest('true_response'),received_at:f.now};
 insert(f,'subscription_provider_events',ack);
 f.sqlite.prepare("UPDATE subscription_provider_commands SET state='confirmed',acknowledgement_event_id=?,revision=revision+1 WHERE command_id=?").run(ack.event_id,cmd.command_id);
 const current=f.sqlite.prepare('SELECT provider_state,auto_renew_confirmed FROM subscription_billing_contracts WHERE contract_id=?').get(c.contract_id);
 assert.deepEqual({...current},{provider_state:'unconfirmed',auto_renew_confirmed:null});
 const control={...ack,event_id:uid(),event_key:'real-control:'+uid(),command_id:null,event_type:'provider_control',source:'telegram_update',provider_state:'active',telegram_update_id:0,actor_type:'telegram',reason_code:'telegram_control'};
 assert.throws(()=>insert(f,'subscription_provider_events',{...control,event_id:uid(),source:'telegram_reconciliation'}),/CHECK/u);
 assert.throws(()=>insert(f,'subscription_provider_events',{...control,event_id:uid(),telegram_id:202}),/binding_invalid/u);
 insert(f,'subscription_provider_events',control);
 f.sqlite.prepare("UPDATE subscription_billing_contracts SET provider_state='active',auto_renew_confirmed=1,last_provider_event_id=?,revision=revision+1 WHERE contract_id=?").run(control.event_id,c.contract_id);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n,0);fk(f);
});

test('review stays append-only, rejects foreign money/item and references only existing compensation',t=>{
 const f=fixture(t),o=order(f),c=makeContract(f,o),p=pay(f,o);insert(f,'subscription_payment_links',linkRow(f,o,p,{contract:c}));
 const op=linkRow(f,o,p,{contract:c,direction:'outgoing',kind:'outgoing_observation'});insert(f,'subscription_payment_links',op);
 const row={resolution_id:uid(),resolution_key:'review:'+uid(),operation_id:op.operation_id,original_payment_ledger_entry_id:p.ledger_entry_id,
 decision:'review_required',actor_type:'owner',actor_id:900,reason_code:'outgoing_type_unproven',evidence_sha256:digest('provider_observation'),recorded_at:f.now};insert(f,'payment_review_resolutions',row);
 const run={run_id:uid(),run_source:'release',status:'running',started_at:f.now,updated_at:f.now};insert(f,'payment_reconciliation_runs',run);
 const item={item_id:uid(),item_key:'foreign-item:'+uid(),run_id:run.run_id,transaction_id_sha256:digest('other_charge'),observation_side:'telegram',
 transaction_direction:'outgoing',partner_type:'user',transaction_type:'invoice_payment',telegram_id:101,amount_stars:249,transaction_date:f.now,
 local_state:'manual_review',reason_code:'unknown_outgoing',observed_at:f.now};insert(f,'payment_reconciliation_items',item);
 assert.throws(()=>insert(f,'payment_review_resolutions',{...row,resolution_id:uid(),resolution_key:'wrong-provider-item:'+uid(),reconciliation_item_id:item.item_id}),/binding_invalid/u);
 const foreign=order(f,{subject:202}),fp=pay(f,foreign);
 assert.throws(()=>insert(f,'payment_review_resolutions',{...row,resolution_id:uid(),resolution_key:'foreign-review:'+uid(),original_payment_ledger_entry_id:fp.ledger_entry_id}),/binding_invalid/u);
 const comp={...p,ledger_entry_id:uid(),idempotency_key:'refund:'+digest(p.telegram_payment_charge_id),entry_type:'refund',direction:'debit',related_ledger_entry_id:p.ledger_entry_id,reason_code:'verified_refund'};
 insert(f,'payment_ledger',comp);
 const settled={...row,resolution_id:uid(),resolution_key:'confirmed-review:'+uid(),decision:'confirmed_refund',financial_effect_ledger_entry_id:comp.ledger_entry_id,supersedes_resolution_id:row.resolution_id};
 insert(f,'payment_review_resolutions',settled);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_ledger').get().n,3);
 assert.throws(()=>insert(f,'payment_review_resolutions',{...settled,resolution_id:uid(),resolution_key:'reclassify:'+uid(),decision:'confirmed_chargeback'}),/binding_invalid/u);
 assert.throws(()=>f.sqlite.prepare("UPDATE payment_review_resolutions SET decision='confirmed_chargeback' WHERE resolution_id=?").run(settled.resolution_id),/append_only/u);fk(f);
});

test('paid notification dedupe, own scope, stale revision and unknown delivery prevent wrong or repeated sends',t=>{
 const f=fixture(t),o=order(f,{billing:'prepaid'}),p=pay(f,o,{subscription:true});
 const job={job_key:'period-ending:'+uid(),subscription_id:p.sub.subscription_id,telegram_id:101,job_type:'period_expiring',expected_subscription_revision:1,
 expected_period_end:p.sub.current_period_end,expected_lifecycle_state:'active',scheduled_for:f.now,created_at:f.now,updated_at:f.now};
 assert.throws(()=>insert(f,'paid_subscription_notification_jobs',{...job,telegram_id:202}),/binding_invalid/u);insert(f,'paid_subscription_notification_jobs',job);
 assert.throws(()=>insert(f,'paid_subscription_notification_jobs',{...job,job_key:'duplicate-cron:'+uid()}),/UNIQUE/u);
 f.sqlite.prepare("UPDATE paid_subscription_notification_jobs SET status='processing',attempt_count=1,delivery_started_at=?,revision=revision+1 WHERE job_key=?").run(f.now,job.job_key);
 f.sqlite.prepare("UPDATE paid_subscription_notification_jobs SET status='unknown',revision=revision+1 WHERE job_key=?").run(job.job_key);
 assert.throws(()=>f.sqlite.prepare("UPDATE paid_subscription_notification_jobs SET status='processing',attempt_count=2,revision=revision+1 WHERE job_key=?").run(job.job_key),/transition_invalid/u);
 const stale={...job,job_key:'stale:'+uid(),job_type:'period_expired'};insert(f,'paid_subscription_notification_jobs',stale);
 f.sqlite.prepare('UPDATE subscriptions SET revision=revision+1,current_period_end=current_period_end+2592000 WHERE subscription_id=?').run(p.sub.subscription_id);
 assert.throws(()=>f.sqlite.prepare("UPDATE paid_subscription_notification_jobs SET status='processing',attempt_count=1,delivery_started_at=?,revision=revision+1 WHERE job_key=?").run(f.now,stale.job_key),/transition_invalid/u);
 assert.throws(()=>insert(f,'notification_jobs',{job_key:'invalid-paid-preview:'+uid(),telegram_id:101,related_grant_id:uid(),job_type:'renewal_failed',scheduled_for:f.now,created_at:f.now,updated_at:f.now}),/CHECK/u);
 fk(f);
});

test('1000-user representative own/due reads and reconciliation joins use bounded indexed searches',t=>{
 const f=fixture(t),count=1000;
 for(let i=0;i<count;i++){
  const o=order(f,{subject:10001+i,billing:'prepaid'}),p=pay(f,o,{subscription:true});
  insert(f,'paid_subscription_notification_jobs',{job_key:'synthetic-due:'+String(i).padStart(6,'0'),subscription_id:p.sub.subscription_id,telegram_id:o.telegram_id,
   job_type:'period_expiring',expected_subscription_revision:1,expected_period_end:p.sub.current_period_end,expected_lifecycle_state:'active',scheduled_for:f.now,
   created_at:f.now,updated_at:f.now});
 }
 const reads=[['own_payment_history','SELECT ledger_entry_id FROM payment_ledger WHERE telegram_id=? ORDER BY occurred_at DESC,ledger_entry_id DESC LIMIT 20',[10500]],
  ['own_notification_history','SELECT job_key FROM paid_subscription_notification_jobs WHERE telegram_id=? ORDER BY created_at DESC,job_key DESC LIMIT 20',[10500]],
  ['notification_due_batch',"SELECT job_key FROM paid_subscription_notification_jobs WHERE status='pending' AND scheduled_for<=? ORDER BY scheduled_for,job_key LIMIT 25",[f.now]],
  ['compensation_lookup',"SELECT ledger_entry_id FROM payment_ledger WHERE related_ledger_entry_id=? AND entry_type IN ('refund','chargeback') LIMIT 2",[uid()]],
  ['review_queue',"SELECT item_id FROM payment_reconciliation_items WHERE local_state='manual_review' ORDER BY observed_at,item_id LIMIT 25",[]]];
 const proof={status:'OFFLINE_REPRESENTATIVE_QUERY_AUDIT',productionAccess:false,concurrentLoadTest:false,usersDistinct:count,orders:count,ledgerPayments:count,subscriptions:count,paidNotificationJobs:count,queries:[]};
 for(const [name,sql,args] of reads){const plan=f.sqlite.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(r=>r.detail);
  assert.ok(plan.some(r=>r.startsWith('SEARCH ')),name+JSON.stringify(plan));assert.ok(!plan.some(r=>r.startsWith('SCAN ')),name+JSON.stringify(plan));
  proof.queries.push({name,sql,queryPlan:plan,resultCount:f.sqlite.prepare(sql).all(...args).length});}
 fk(f);proof.foreignKeyCheck=[];proof.integrityCheck=f.sqlite.prepare('PRAGMA integrity_check').get().integrity_check;
 const dir=new URL('../tmp/v143/',import.meta.url);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(new URL('schema-query-proof.json',dir),JSON.stringify(proof,null,2)+'\n');
});

test('local retirement preserves raw provider state and never treats approved-late or active/failed expiry as never paid',t=>{
 const retireEvent=(f,c)=>{const e={event_id:uid(),event_key:'local-retirement:'+uid(),contract_id:c.contract_id,telegram_id:101,event_type:'contract_retired',
  source:'system',actor_type:'system',actor_id:null,reason_code:'never_approved_terminal_order',evidence_sha256:digest('retirement-facts'),received_at:f.now};
  insert(f,'subscription_provider_events',e);return e;};
 const retire=(f,c,e)=>f.sqlite.prepare('UPDATE subscription_billing_contracts SET retired_at=?,retirement_event_id=?,revision=revision+1 WHERE contract_id=?').run(f.now,e.event_id,c.contract_id);
 const f=fixture(t),neverApproved=order(f,{at:f.now-1000,state:'cancelled'}),c=makeContract(f,neverApproved),e=retireEvent(f,c);retire(f,c,e);
 assert.deepEqual({...f.sqlite.prepare('SELECT provider_state,retired_at FROM subscription_billing_contracts WHERE contract_id=?').get(c.contract_id)},
  {provider_state:'unconfirmed',retired_at:f.now});
 makeContract(f,order(f));fk(f);
 const g=fixture(t),approved=order(g,{at:g.now-1000});
 g.sqlite.prepare("UPDATE subscription_orders SET order_state='precheckout_ok',precheckout_approved_at=? WHERE order_id=?").run(g.now-900,approved.order_id);
 g.sqlite.prepare("UPDATE subscription_orders SET order_state='cancelled',closed_at=? WHERE order_id=?").run(g.now-100,approved.order_id);
 const lateContract=makeContract(g,approved),lateEvent=retireEvent(g,lateContract);
 assert.throws(()=>retire(g,lateContract,lateEvent),/v143_contract_update_invalid/u);
 assert.throws(()=>makeContract(g,order(g)),/UNIQUE/u);
 assert.equal(g.sqlite.prepare('SELECT retired_at FROM subscription_billing_contracts WHERE contract_id=?').get(lateContract.contract_id).retired_at,null);
 // Active/failed with an elapsed local window remains provider control, not canceled.
 for(const providerState of ['active','failed']){
  const control={event_id:uid(),event_key:'control-for-retirement:'+uid(),contract_id:lateContract.contract_id,telegram_id:101,event_type:'provider_control',
   source:'telegram_update',provider_state:providerState,actor_type:'telegram',actor_id:null,reason_code:'actual_provider_control',evidence_sha256:digest(providerState),received_at:g.now};
  insert(g,'subscription_provider_events',control);
  g.sqlite.prepare('UPDATE subscription_billing_contracts SET provider_state=?,last_provider_event_id=?,revision=revision+1 WHERE contract_id=?').run(providerState,control.event_id,lateContract.contract_id);
  assert.throws(()=>retire(g,lateContract,lateEvent),/v143_contract_update_invalid/u);
 }
 fk(g);
});
