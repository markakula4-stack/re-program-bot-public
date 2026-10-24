import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { runPublicPython } from './helpers/public-python.mjs';
import { createHash } from 'node:crypto';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { prepareV141PrivacyDeletion } from '../src/v1.4.1/privacy-maintenance.mjs';
import { assertP04SchemaReady, inspectP04Schema, P04_SCHEMA } from '../src/v1.4.1/privacy-schema.mjs';
import { createFoundationRepository } from '../src/v1.4.1/foundation-repository.mjs';
import { FOUNDATION_POLICY_VERSION } from '../src/v1.4.1/capability-policy.mjs';

const migration=fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const setup=t=>{const f=foundationFixture(t);f.sqlite.exec('BEGIN;'+migration+';COMMIT;');
  f.privacyEnv={...f.serverEnv,DB:f.binding,V141_AUTHORIZATION_ENABLED:'true'};return f;};
const insert=(f,table,row)=>{const keys=Object.keys(row);f.sqlite.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>row[key]));};
const request=(f,id=101)=>{const key=crypto.randomUUID();f.sqlite.prepare(`INSERT INTO privacy_deletion_requests
  (request_id,telegram_id,confirmation_token,status,summary_json,expires_at) VALUES(?,?,?,'pending','{}',datetime(?,'unixepoch'))`)
  .run(key,id,crypto.randomUUID(),f.now+300);return key;};
const completion=(f,id,key)=>f.binding.prepare(`UPDATE privacy_deletion_requests SET telegram_id=NULL,status='completed',completed_at=CURRENT_TIMESTAMP,
  confirmation_token=request_id,summary_json='{}' WHERE request_id=? AND telegram_id=? AND status='pending'`).bind(key,id);
const finish=async(f,id,key,prepared)=>f.binding.batch([...prepared.prefix,
  f.binding.prepare('DELETE FROM ai_quota_reservations WHERE telegram_id=?').bind(id),
  f.binding.prepare('DELETE FROM ai_usage_events WHERE telegram_id=?').bind(id),
  ...['user_roles','user_access'].map(table=>f.binding.prepare(`DELETE FROM ${table} WHERE telegram_id=?`).bind(id)),
  f.binding.prepare('DELETE FROM users WHERE telegram_id=?').bind(id),completion(f,id,key),...prepared.suffix]);
const common=(f,key,subject=202)=>({idempotency_key:hash(key),policy_version:FOUNDATION_POLICY_VERSION,capability:'application.create',
  subject_telegram_id:subject,scope_kind:'actor',scope_key:'actor:'+subject,issued_by:101,reason:'Synthetic author metadata',
  starts_at:f.now-20,expires_at:f.now+600,revision:1,created_at:f.now-20,updated_at:f.now-20});
const grant=(f,key,subject=202)=>({...common(f,key,subject),grant_id:key,source_kind:'manual_capability',source_ref:'manual:'+key,
  source_revision:1,source_fingerprint:hash('source:'+key)});

test('P04 migration changes only reviewed new foundations and adds journal, with exact primary readiness',async t=>{
  const f=foundationFixture(t),before=f.sqlite.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  f.sqlite.exec('BEGIN;'+migration+';COMMIT;');
  const allowed=new Set(P04_SCHEMA.tables);
  const after=f.sqlite.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  assert.deepEqual(after.filter(row=>!allowed.has(row.tbl_name)),before.filter(row=>!allowed.has(row.tbl_name)));
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(await assertP04SchemaReady({binding:f.binding}),f.binding);
  assert.equal((await inspectP04Schema(f.binding)).schemaSha256,P04_SCHEMA.schemaSha256);
  assert.equal((await createFoundationRepository(f.binding).inspectFoundation({policyVersion:FOUNDATION_POLICY_VERSION})).status,'ready');
  assert.ok(f.binding.sessions.every(mode=>mode==='first-primary'));
  assert.throws(()=>f.sqlite.exec('BEGIN;'+migration+';COMMIT;'),/CHECK/u);f.sqlite.exec('ROLLBACK');
});
test('exact readiness rejects a missing constraint trigger or ledger even when all columns exist',async t=>{
  for(const damage of ['trigger','ledger']) {
    const f=setup(t);
    f.sqlite.exec(damage==='trigger'?'DROP TRIGGER v141_ai_journal_active_attempt':"DELETE FROM re_schema_migrations WHERE version='1.4.1-privacy-ai-journal'");
    await assert.rejects(assertP04SchemaReady({binding:f.binding}),/v141_schema_not_ready/u);
    assert.equal((await createFoundationRepository(f.binding).inspectFoundation({policyVersion:FOUNDATION_POLICY_VERSION})).status,'denied');
  }
});
test('confirmed subject cleanup erases actor audits and all author/revoker references while preserving foreign rows',async t=>{
  const f=setup(t),key=request(f);
  insert(f,'entitlement_grants',grant(f,'foreign_grant'));insert(f,'entitlement_grants',grant(f,'subject_grant',101));
  insert(f,'entitlement_overrides',{...common(f,'foreign_override'),override_id:'foreign_override',subject_source_fingerprint:hash('generation'),effect:'deny'});
  insert(f,'feature_flags',{flag_key:'synthetic.flag',policy_version:FOUNDATION_POLICY_VERSION,updated_by:101,reason:'Synthetic author',updated_at:f.now-20});
  insert(f,'feature_flag_assignments',{assignment_id:'foreign_assignment',idempotency_key:hash('assignment'),flag_key:'synthetic.flag',
    subject_kind:'actor',subject_key:'actor:202',subject_telegram_id:202,subject_source_fingerprint:hash('generation'),assigned_by:101,reason:'Synthetic assigner',
    starts_at:f.now-20,expires_at:f.now+600,created_at:f.now-20,updated_at:f.now-20});
  f.sqlite.exec(`UPDATE entitlement_grants SET revoked_at=unixepoch(),revoked_by=101,revocation_reason='Synthetic revoker',revision=2,
    updated_at=unixepoch() WHERE grant_id='foreign_grant'`);
  insert(f,'entitlement_decision_audit',{audit_id:'foreign_subject_audit',event_key:hash('audit'),policy_version:FOUNDATION_POLICY_VERSION,
    capability:'application.create',actor_kind:'customer',subject_telegram_id:202,actor_telegram_id:101,resource_ref:'actor:202',decision:'allow',
    reason_code:'synthetic',source_fingerprint:hash('source'),evaluated_at:f.now-20,valid_until:f.now+100});
  await finish(f,101,key,await prepareV141PrivacyDeletion(f.privacyEnv,101,key));
  const row=f.sqlite.prepare("SELECT * FROM entitlement_grants WHERE grant_id='foreign_grant'").get();
  assert.equal(row.issued_by,null);assert.equal(row.revoked_by,null);assert.equal(row.issuer_anonymized,1);assert.equal(row.revoker_anonymized,1);
  assert.equal(row.reason,'author_deleted');assert.equal(row.revision,2);assert.equal(row.authority_seal,null,'cleanup cannot mint unsigned authority');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM entitlement_grants WHERE subject_telegram_id=101').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT issued_by FROM entitlement_overrides').get().issued_by,null);
  assert.equal(f.sqlite.prepare('SELECT assigned_by FROM feature_flag_assignments').get().assigned_by,null);
  assert.equal(f.sqlite.prepare('SELECT updated_by FROM feature_flags').get().updated_by,null);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM entitlement_decision_audit').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_privacy_guard').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_atomic_guards').get().n,0);
});
test('wrong subject, expired confirmation and new active admin or application fail atomically before cleanup',async t=>{
  for(const damage of ['wrong_subject','expiry','admin','application']) {
    const f=setup(t),key=request(f);insert(f,'entitlement_grants',grant(f,'foreign_grant'));
    const prepared=await prepareV141PrivacyDeletion(f.privacyEnv,101,key);
    if(damage==='wrong_subject')f.sqlite.prepare('UPDATE privacy_deletion_requests SET telegram_id=202 WHERE request_id=?').run(key);
    if(damage==='expiry')f.sqlite.prepare("UPDATE privacy_deletion_requests SET expires_at=datetime(?,'unixepoch') WHERE request_id=?").run(f.now-1,key);
    if(damage==='admin')f.sqlite.exec("INSERT INTO user_roles(telegram_id,role,status) VALUES(101,'admin','active')");
    if(damage==='application')f.sqlite.exec("INSERT INTO partner_applications(telegram_id,display_name,telegram_username,contact,age_confirmed,status) VALUES(101,'Synthetic','','',1,'pending')");
    await assert.rejects(finish(f,101,key,prepared),/CHECK/u);
    assert.equal(f.sqlite.prepare('SELECT issued_by FROM entitlement_grants').get().issued_by,101);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM users WHERE telegram_id=101').get().n,1);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_privacy_guard').get().n,0);
  }
});
test('zero-row final completion rolls back earlier redaction and account erasure',async t=>{
  const f=setup(t),key=request(f);insert(f,'entitlement_grants',grant(f,'foreign_grant'));
  const prepared=await prepareV141PrivacyDeletion(f.privacyEnv,101,key);
  f.sqlite.exec(`CREATE TEMP TRIGGER skip_privacy_completion BEFORE UPDATE ON privacy_deletion_requests
    WHEN NEW.status='completed' BEGIN SELECT RAISE(IGNORE); END`);
  await assert.rejects(finish(f,101,key,prepared),/CHECK/u);
  assert.equal(f.sqlite.prepare('SELECT issued_by FROM entitlement_grants').get().issued_by,101);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM users WHERE telegram_id=101').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT status FROM privacy_deletion_requests WHERE request_id=?').get(key).status,'pending');
});
test('actual old owned cost and unresolved budget hold survive old quota/user FK deletion anonymously',async t=>{
  for(const unresolved of [false,true]) {
    const f=setup(t),key=request(f),oldRequest='legacy_actual_'+crypto.randomUUID(),date=new Date(f.now*1000).toISOString().slice(0,10),cycle=f.now-100;
    f.sqlite.prepare(`INSERT INTO ai_quota_reservations(request_id,telegram_id,usage_date,bucket,reserved_milli,status,completed_at)
      VALUES(?,101,?,'admin',1,?,?)`).run(oldRequest,date,unresolved?'released':'consumed',new Date(f.now*1000).toISOString());
    f.sqlite.prepare(`INSERT INTO ai_gateway_budget_reservations(request_id,owner_telegram_id,usage_date,user_cycle_start_at,user_cycle_end_at,
      global_cycle_start_at,global_cycle_end_at,reserved_billed_tokens,reserved_cost_microusd,reservation_state,policy_version,pricing_version,created_at,completed_at)
      VALUES(?,101,?,?,?, ?,?,100,15,?,'synthetic.policy','synthetic.pricing',?,?)`).run(oldRequest,date,cycle,cycle+2592000,
        cycle,cycle+2592000,unresolved?'reserved':'consumed',cycle,unresolved?null:f.now);
    if(!unresolved)f.sqlite.prepare(`INSERT INTO ai_gateway_attempts(attempt_id,request_id,attempt_no,route_step,model_alias,provider_code,
      attempt_status,input_tokens,output_tokens,cost_microusd,latency_ms,created_at) VALUES(?,?,1,'primary','deepseek_flash_dragon','deepseek','success',10,10,15,1,?)`)
      .run(crypto.randomUUID(),oldRequest,cycle+1);
    await finish(f,101,key,await prepareV141PrivacyDeletion(f.privacyEnv,101,key));
    const journal=f.sqlite.prepare('SELECT * FROM ai_operation_journal').get();
    assert.equal(journal.subject_telegram_id,null);assert.equal(journal.account_generation_hash,null);assert.equal(journal.settlement_kind,'anonymous');
    assert.equal(journal.state,unresolved?'unknown':'terminal_failed');assert.equal(journal.reserved_cost_microusd,15);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ai_gateway_budget_reservations').get().n,0);
    if(!unresolved) {
      assert.equal(f.sqlite.prepare('SELECT expense_location FROM ai_operation_receipts').get().expense_location,'anonymous');
      assert.equal(f.sqlite.prepare('SELECT SUM(cost_microusd) n FROM ai_gateway_daily_aggregates').get().n,15);
    }
  }
});
test('P04 manifest is reproducible from immutable prior migrations plus reviewed0065',()=>{
  const result=runPublicPython(['scripts/v1.4.1-build-privacy-schema.py','--check'],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
