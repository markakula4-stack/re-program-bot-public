import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { approvedPartner } from './helpers/v1.4.0-rebuild-sqlite.mjs';
import { createControlledMetadataWriter } from '../src/v1.4.1/controlled-metadata-writer.mjs';
import { createRuntimeAuthorizer, readRuntimeAuthorization } from '../src/v1.4.1/runtime-authorizer.mjs';
import { verifyAuthoritySeal } from '../src/v1.4.1/authority-resolver.mjs';
const migration = fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8');
const setup = t => { const f=foundationFixture(t); f.sqlite.exec('BEGIN;' + migration + ';COMMIT;'); return f; };
const payload = (f,patch={}) => ({subjectTelegramId:101,capability:'profile.read_own',scopeKind:'actor',scopeKey:'actor:101',expiresAt:f.now+3600,reason:'Synthetic authorized grant',...patch});
async function issuance(f,input=payload(f),{enabled=true,id=900,key='controlled-operation-0001'}={}) {
  const context=await f.context(id,'admin.entitlement.manage','mini_app',{requestPayload:input,idempotencyKey:key,
    env:{...f.serverEnv,...(enabled?{V141_INTERNAL_METADATA_WRITER_ENABLED:'true'}:{})}});
  return readRuntimeAuthorization(await createRuntimeAuthorizer().authorize(context,{kind:'entitlement_subject',key:input.subjectTelegramId}));
}
test('actual default-off controlled issuer rejects copies, nonowner and unknown/future/provider/financial authority',async t=>{
  const f=setup(t),writer=createControlledMetadataWriter();
  const closed=await issuance(f,payload(f),{enabled:false});assert.equal(closed.decision.allowed,false);
  await assert.rejects(writer.issueManualCapabilityGrant(closed.decision),/controlled_issuer_unavailable/u);
  const nonowner=await issuance(f,payload(f),{id:404});await assert.rejects(writer.issueManualCapabilityGrant(nonowner.decision));
  for(const capability of ['unknown.capability','admin.feature_flags.manage','crm.basic','billing.purchase_monthly','ai.provider.external.use']) {
    const rejected=await issuance(f,payload(f,{capability}));assert.equal(rejected.decision.allowed,false,capability);
    await assert.rejects(writer.issueManualCapabilityGrant(rejected.decision));
  }
  const valid=await issuance(f);await assert.rejects(writer.issueManualCapabilityGrant(JSON.parse(JSON.stringify(valid.decision))),/untrusted_decision/u);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM entitlement_grants').get().n,0);
});
test('genuine fixed canonical-admin writer issues one sealed row and audit/receipt atomically; account/role/age/plan stay independent',async t=>{
  const f=setup(t),writer=createControlledMetadataWriter(),valid=await issuance(f);
  assert.equal(valid.decision.allowed,true);const ack=await writer.issueManualCapabilityGrant(valid.decision);
  const row=f.sqlite.prepare('SELECT * FROM entitlement_grants WHERE grant_id=?').get(ack.grantId);
  assert.equal(await verifyAuthoritySeal('entitlement_grants',row,f.serverEnv),true);
  assert.equal(await verifyAuthoritySeal('entitlement_overrides',row,f.serverEnv),false);
  assert.equal(await verifyAuthoritySeal('entitlement_grants',row,{...f.serverEnv,BOT_TOKEN:'different-server-secret'}),false);
  assert.equal(await verifyAuthoritySeal('entitlement_grants',{...row,capability:'offer.create_private'},f.serverEnv),false);
  assert.deepEqual(await writer.issueManualCapabilityGrant(valid.decision),ack);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM entitlement_grants').get().n,1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM entitlement_decision_audit WHERE reason_code='controlled_manual_grant_issued'").get().n,1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM user_roles WHERE telegram_id=101 AND role!='user'").get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM partner_applications WHERE telegram_id=101').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM user_plans WHERE telegram_id=101').get().n,0);
  f.sqlite.exec("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'");
  const beneficiary=readRuntimeAuthorization(await createRuntimeAuthorizer().authorize(await f.context(101,'profile.read_own')));
  assert.equal(beneficiary.actor.grants.length,1);assert.equal(beneficiary.decision.allowed,true);
  f.sqlite.exec("UPDATE users SET referral_code='recreated-account-generation' WHERE telegram_id=101");
  const recreated=readRuntimeAuthorization(await createRuntimeAuthorizer().authorize(await f.context(101,'profile.read_own')));
  assert.equal(recreated.actor.grants.length,0,'old sealed authority never survives recipient recreation');
});
test('current issuer or target restriction between approval and issuance rolls back grant, receipt and audit',async t=>{
  for(const sql of ["UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'",'UPDATE users SET is_blocked=1 WHERE telegram_id=101']) {
    const f=setup(t),valid=await issuance(f);f.binding.beforeBatch=()=>f.sqlite.exec(sql);
    await assert.rejects(createControlledMetadataWriter().issueManualCapabilityGrant(valid.decision));
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM entitlement_grants').get().n,0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_command_receipts').get().n,0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM entitlement_decision_audit').get().n,0);
  }
});
test('actual sealed issuance, issuer demotion and confirmed privacy cleanup preserve foreign capability beyond Free without reviving unsigned sources',async t=>{
  const f=setup(t),partner=await approvedPartner(f,202);
  const ambassador=crypto.randomUUID();
  f.sqlite.prepare("INSERT INTO ambassador_profiles_v2(ambassador_id,partner_profile_id,owner_pseudonym,pseudonym_key_version,eligibility_evidence_hash,created_at,updated_at) VALUES(?,?,?,1,?,?,?)")
    .run(ambassador,partner.profileId,'e'.repeat(64),'a'.repeat(64),f.now-100,f.now-100);
  f.sqlite.prepare("INSERT INTO ambassador_profile_transitions(transition_id,transition_key,ambassador_id,profile_revision,from_status,to_status,reason_code,actor_kind,evidence_hash,occurred_at,created_at) VALUES(?,?,?,2,'draft','active','activation_approved','admin',?,?,?)")
    .run(crypto.randomUUID(),'b'.repeat(64),ambassador,'a'.repeat(64),f.now-90,f.now-90);
  f.sqlite.prepare("INSERT INTO analytics_v2_settings(id,rollout_mode,master_enabled,ingest_enabled,projections_enabled,ambassador_enabled,updated_at) VALUES(1,'admin_shadow',1,1,1,1,?)").run(f.now);
  f.sqlite.prepare("INSERT INTO analytics_v139_owner_runtime(id,audience_mode,enabled,updated_at) VALUES(1,'owner_only',1,?)").run(f.now);
  f.sqlite.prepare('INSERT INTO analytics_v139_partner_pilot(telegram_id,enabled,admitted_at,expires_at) VALUES(202,1,?,?)').run(f.now-1,f.now+600);
  const controls={ANALYTICS_V2_ROLLOUT_MODE:'admin_shadow',ANALYTICS_V2_ENABLED:'true',ANALYTICS_V2_INGEST_ENABLED:'true',ANALYTICS_V2_PROJECTIONS_ENABLED:'true',AMBASSADOR_V2_ENABLED:'true'};
  const compare=async()=>readRuntimeAuthorization(await createRuntimeAuthorizer().authorize(await f.context(202,'analytics.compare_periods','mini_app',{env:{...f.serverEnv,...controls}})));
  assert.equal((await compare()).decision.reasonCode,'access_required');
  const valid=await issuance(f,payload(f,{subjectTelegramId:202,scopeKey:'actor:202',capability:'analytics.compare_periods'}));
  const ack=await createControlledMetadataWriter().issueManualCapabilityGrant(valid.decision);
  assert.equal((await compare()).decision.allowed,true);
  const issued=f.sqlite.prepare('SELECT * FROM entitlement_grants WHERE grant_id=?').get(ack.grantId);
  const invalid={...issued,grant_id:'invalid_unsigned_source',idempotency_key:'f'.repeat(64),source_ref:'manual:invalid_unsigned_source',source_fingerprint:'f'.repeat(64),authority_seal:null,seal_version:null};
  const names=Object.keys(invalid);f.sqlite.prepare(`INSERT INTO entitlement_grants(${names.join(',')}) VALUES(${names.map(()=>'?').join(',')})`).run(...names.map(name=>invalid[name]));
  f.sqlite.prepare("INSERT INTO feature_flags(flag_key,policy_version,enabled,emergency_disabled,revision,rollout_json,updated_by,reason,updated_at) VALUES('capability:profile.read_own',?,1,0,1,'{}',900,'Unsigned current issuer',?)").run(issued.policy_version,f.now);
  f.sqlite.exec("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'");
  const requestId=crypto.randomUUID();
  f.sqlite.prepare("INSERT INTO privacy_deletion_requests(request_id,telegram_id,confirmation_token,status,summary_json,expires_at) VALUES(?,900,?,'pending','{}',datetime(?,'unixepoch'))")
    .run(requestId,crypto.randomUUID(),f.now+300);
  const {prepareV141PrivacyDeletion}=await import('../src/v1.4.1/privacy-maintenance.mjs');
  const cleanup=await prepareV141PrivacyDeletion({...f.serverEnv,ADMIN_ID:'404',OWNER_TELEGRAM_ID:'404',V141_AUTHORIZATION_ENABLED:'true'},900,requestId);
  await f.binding.batch([...cleanup.prefix,...['user_roles','user_access'].map(table=>f.binding.prepare(`DELETE FROM ${table} WHERE telegram_id=900`)),
    f.binding.prepare('DELETE FROM users WHERE telegram_id=900'),
    f.binding.prepare("UPDATE privacy_deletion_requests SET telegram_id=NULL,status='completed',completed_at=CURRENT_TIMESTAMP,confirmation_token=request_id,summary_json='{}' WHERE request_id=? AND telegram_id=900 AND status='pending'").bind(requestId),...cleanup.suffix]);
  const row=f.sqlite.prepare('SELECT * FROM entitlement_grants WHERE grant_id=?').get(ack.grantId);
  assert.equal(row.issued_by,null);assert.equal(row.issuer_anonymized,1);assert.equal(row.reason,'author_deleted');
  assert.equal(await verifyAuthoritySeal('entitlement_grants',row,f.serverEnv),true);
  const after=await compare();assert.equal(after.actor.grants.length,1);assert.equal(after.decision.allowed,true);assert.equal(after.actor.access.effectivePlan,'free');
  const invalidAfter=f.sqlite.prepare("SELECT issued_by,issuer_anonymized,authority_seal FROM entitlement_grants WHERE grant_id='invalid_unsigned_source'").get();
  assert.equal(invalidAfter.issued_by,null);assert.equal(invalidAfter.issuer_anonymized,1);assert.equal(invalidAfter.authority_seal,null);
  const invalidFlag=readRuntimeAuthorization(await createRuntimeAuthorizer().authorize(await f.context(101,'profile.read_own')));
  assert.equal(invalidFlag.actor.currentFlags.length,1);assert.equal(invalidFlag.actor.currentFlags[0].sourceVerified,false);
  assert.equal(invalidFlag.decision.allowed,false);assert.equal(invalidFlag.decision.reasonCode,'feature_unavailable');
  const corrupted={...row,authority_seal:'f'.repeat(64)};assert.equal(await verifyAuthoritySeal('entitlement_grants',corrupted,f.serverEnv),false);
});
