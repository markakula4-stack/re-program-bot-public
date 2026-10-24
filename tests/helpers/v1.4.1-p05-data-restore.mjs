import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { foundationFixture, signedInitData } from './v1.4.1-fixtures.mjs';
import { approvedPartner, SqliteD1, ORIGIN } from './v1.4.0-rebuild-sqlite.mjs';
import { createControlledMetadataWriter } from '../../src/v1.4.1/controlled-metadata-writer.mjs';
import { createRuntimeAuthorizer, readRuntimeAuthorization } from '../../src/v1.4.1/runtime-authorizer.mjs';
import { prepareV141PrivacyDeletion } from '../../src/v1.4.1/privacy-maintenance.mjs';
import { prepareRebuildSubjectDeletion } from '../../src/v1.4.0-rebuild/privacy-runtime.mjs';
import { verifyAuthoritySeal } from '../../src/v1.4.1/authority-resolver.mjs';
import { inspectP04Schema, P04_SCHEMA } from '../../src/v1.4.1/privacy-schema.mjs';
import { runtimeBindingEnabled } from '../../src/v1.4.1/runtime-binding.mjs';
import worker from '../../src/v1.4.0-rebuild/worker-entrypoint.mjs';

// Offline drill only. Callers supply a local output directory, never D1 IDs,
// credentials, runtime authority rows, SQL callbacks or provider transports.
const digest=value=>createHash('sha256').update(value).digest('hex');
const json=value=>JSON.stringify(value);
const quote=value=>'"'+value.replaceAll('"','""')+'"';
const fingerprint=(db,tables=null)=>{
  const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
  const names=tables??schema.filter(row=>row.type==='table').map(row=>row.name).sort();
  return {schemaSha256:digest(json(schema)),tables:Object.fromEntries(names.map(table=>{
    const rows=db.prepare('SELECT * FROM '+quote(table)).all().map(json).sort();
    return [table,{rows:rows.length,sha256:digest(json(rows))}];
  }))};
};
const checkIntegrity=db=>{
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
};
async function cleanup(f,env,id) {
  const requestId=crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO privacy_deletion_requests(request_id,telegram_id,confirmation_token,status,summary_json,expires_at)
    VALUES(?,?,?,'pending','{}',datetime(?,'unixepoch'))`).run(requestId,id,crypto.randomUUID(),f.now+300);
  const prepared=await prepareV141PrivacyDeletion(env,id,requestId);
  const rebuild=await prepareRebuildSubjectDeletion(env,id,requestId);
  await f.binding.batch([...prepared.prefix,...rebuild,
    f.binding.prepare('DELETE FROM ai_quota_reservations WHERE telegram_id=?').bind(id),
    f.binding.prepare('DELETE FROM ai_usage_events WHERE telegram_id=?').bind(id),
    ...['user_roles','user_access'].map(table=>f.binding.prepare('DELETE FROM '+table+' WHERE telegram_id=?').bind(id)),
    f.binding.prepare('DELETE FROM users WHERE telegram_id=?').bind(id),
    f.binding.prepare(`UPDATE privacy_deletion_requests SET telegram_id=NULL,status='completed',completed_at=CURRENT_TIMESTAMP,
      confirmation_token=request_id,summary_json='{}' WHERE request_id=? AND telegram_id=? AND status='pending'`).bind(requestId,id),
    ...prepared.suffix]);
}
async function populate() {
  const f=foundationFixture();
  try {
    f.sqlite.exec('BEGIN;'+fs.readFileSync(new URL('../../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8')+';COMMIT;');
    f.serverEnv.V141_AUTHORIZATION_ENABLED='true';
    const partner=await approvedPartner(f,202),ambassador=crypto.randomUUID();
    f.sqlite.prepare(`INSERT INTO ambassador_profiles_v2(ambassador_id,partner_profile_id,owner_pseudonym,pseudonym_key_version,
      eligibility_evidence_hash,created_at,updated_at) VALUES(?,?,?,1,?,?,?)`).run(ambassador,partner.profileId,'e'.repeat(64),'a'.repeat(64),f.now-100,f.now-100);
    f.sqlite.prepare(`INSERT INTO ambassador_profile_transitions(transition_id,transition_key,ambassador_id,profile_revision,
      from_status,to_status,reason_code,actor_kind,evidence_hash,occurred_at,created_at)
      VALUES(?,?,?,2,'draft','active','activation_approved','admin',?,?,?)`).run(crypto.randomUUID(),'b'.repeat(64),ambassador,'a'.repeat(64),f.now-90,f.now-90);
    f.sqlite.prepare(`INSERT INTO analytics_v2_settings(id,rollout_mode,master_enabled,ingest_enabled,projections_enabled,ambassador_enabled,updated_at)
      VALUES(1,'admin_shadow',1,1,1,1,?)`).run(f.now);
    f.sqlite.prepare("INSERT INTO analytics_v139_owner_runtime(id,audience_mode,enabled,updated_at) VALUES(1,'owner_only',1,?)").run(f.now);
    f.sqlite.prepare('INSERT INTO analytics_v139_partner_pilot(telegram_id,enabled,admitted_at,expires_at) VALUES(202,1,?,?)').run(f.now-1,f.now+600);
    const controls={ANALYTICS_V2_ROLLOUT_MODE:'admin_shadow',ANALYTICS_V2_ENABLED:'true',ANALYTICS_V2_INGEST_ENABLED:'true',
      ANALYTICS_V2_PROJECTIONS_ENABLED:'true',AMBASSADOR_V2_ENABLED:'true'};
    // Resolve contexts before authorization; only the real private writer signs.
    const readCompare=async()=>readRuntimeAuthorization(await createRuntimeAuthorizer().authorize(await f.context(202,
      'analytics.compare_periods','mini_app',{env:{...f.serverEnv,...controls}})));
    assert.equal((await readCompare()).decision.reasonCode,'access_required');
    const payload={subjectTelegramId:202,capability:'analytics.compare_periods',scopeKind:'actor',scopeKey:'actor:202',
      expiresAt:f.now+3600,reason:'Synthetic restore proof grant'};
    const context=await f.context(900,'admin.entitlement.manage','mini_app',{requestPayload:payload,idempotencyKey:'p05_restore_sealed_grant',
      env:{...f.serverEnv,V141_INTERNAL_METADATA_WRITER_ENABLED:'true'}});
    const issuance=readRuntimeAuthorization(await createRuntimeAuthorizer().authorize(context,{kind:'entitlement_subject',key:202}));
    const grant=await createControlledMetadataWriter().issueManualCapabilityGrant(issuance.decision);
    assert.equal((await readCompare()).decision.allowed,true);
    f.sqlite.exec("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'");
    const privacyEnv={...f.serverEnv,ADMIN_ID:'404',OWNER_TELEGRAM_ID:'404'};
    await cleanup(f,privacyEnv,900);
    assert.equal((await readCompare()).decision.allowed,true);
    const grantRow=f.sqlite.prepare('SELECT * FROM entitlement_grants WHERE grant_id=?').get(grant.grantId);
    assert.equal(grantRow.issued_by,null);assert.equal(grantRow.issuer_anonymized,1);
    assert.equal(await verifyAuthoritySeal('entitlement_grants',grantRow,f.serverEnv),true);
    const date=new Date(f.now*1000).toISOString().slice(0,10),cycle=f.now-100;
    for(const unknown of [false,true]) {
      const requestId='p05_legacy_actual_'+crypto.randomUUID();
      f.sqlite.prepare(`INSERT INTO ai_quota_reservations(request_id,telegram_id,usage_date,bucket,reserved_milli,status,completed_at)
        VALUES(?,303,?,'admin',1,?,?)`).run(requestId,date,unknown?'released':'consumed',new Date(f.now*1000).toISOString());
      f.sqlite.prepare(`INSERT INTO ai_gateway_budget_reservations(request_id,owner_telegram_id,usage_date,user_cycle_start_at,user_cycle_end_at,
        global_cycle_start_at,global_cycle_end_at,reserved_billed_tokens,reserved_cost_microusd,reservation_state,policy_version,pricing_version,created_at,completed_at)
        VALUES(?,303,?,?,?,?,?,100,15,?,'synthetic.policy','synthetic.pricing',?,?)`).run(requestId,date,cycle,cycle+2592000,
          cycle,cycle+2592000,unknown?'reserved':'consumed',cycle,unknown?null:f.now);
      if(!unknown)f.sqlite.prepare(`INSERT INTO ai_gateway_attempts(attempt_id,request_id,attempt_no,route_step,model_alias,provider_code,
        attempt_status,input_tokens,output_tokens,cost_microusd,latency_ms,created_at)
        VALUES(?,?,1,'primary','deepseek_flash_dragon','deepseek','success',10,10,15,1,?)`).run(crypto.randomUUID(),requestId,cycle+1);
    }
    await cleanup(f,privacyEnv,303);
    assert.equal(f.sqlite.prepare('SELECT SUM(cost_microusd) n FROM ai_gateway_daily_aggregates').get().n,15);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ai_operation_journal WHERE state='unknown' AND settlement_kind='anonymous' AND reserved_cost_microusd=15").get().n,1);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ai_operation_journal WHERE subject_telegram_id IS NOT NULL').get().n,0);
    checkIntegrity(f.sqlite);
    return {f,grantId:grant.grantId,controls};
  } catch(error) {f.close();throw error;}
}

export async function runP05DataRestoreDrill({directory}={}) {
  if(typeof directory!=='string'||!path.isAbsolute(directory)) throw new Error('isolated_absolute_directory_required');
  fs.mkdirSync(directory,{recursive:true});
  const backup=path.join(directory,'synthetic-populated-0065.sqlite'),restoredPath=path.join(directory,'isolated-restored-0065.sqlite');
  if(fs.existsSync(backup)||fs.existsSync(restoredPath)) throw new Error('isolated_snapshot_already_exists');
  const {f,grantId,controls}=await populate();let restored;
  try {
    const original=fingerprint(f.sqlite);
    f.sqlite.prepare('VACUUM INTO ?').run(backup);
    fs.copyFileSync(backup,restoredPath,fs.constants.COPYFILE_EXCL);
    const backupSha256=digest(fs.readFileSync(backup));
    assert.equal(digest(fs.readFileSync(restoredPath)),backupSha256);
    restored=new DatabaseSync(restoredPath);restored.exec('PRAGMA foreign_keys=ON');
    assert.deepEqual(fingerprint(restored),original);checkIntegrity(restored);
    const binding=new SqliteD1(restored),env={...f.serverEnv,DB:binding};
    await inspectP04Schema(binding);
    const grant=restored.prepare('SELECT * FROM entitlement_grants WHERE grant_id=?').get(grantId);
    assert.equal(await verifyAuthoritySeal('entitlement_grants',grant,env),true);
    const context=await f.context(202,'analytics.compare_periods','mini_app',{binding,env:{...env,...controls}});
    assert.equal(readRuntimeAuthorization(await createRuntimeAuthorizer().authorize(context)).decision.allowed,true);
    const newBefore=fingerprint(restored,P04_SCHEMA.tables);
    let providerCalls=0;
    const defaultOff={...env,V141_AUTHORIZATION_ENABLED:'false',V141_INTERNAL_METADATA_WRITER_ENABLED:'false',
      OWNER_TELEGRAM_ID:'101',
      AI:{run(){providerCalls++;throw new Error('offline_provider_forbidden');}}};
    assert.equal(runtimeBindingEnabled(defaultOff),false);
    // Exercise the actual imported Worker with the candidate switch off, using
    // its accepted signed-session and GET path against the restored data.
    const response=await worker.fetch(new Request(ORIGIN+'/api/v1.4.0/cabinet/session',{method:'POST',
      headers:{Origin:ORIGIN,'Content-Type':'application/json','Idempotency-Key':'p05_restore_accepted_session'},
      body:json({initData:signedInitData(101,f.now)})}),defaultOff,{});
    const session=await response.json();assert.equal(response.status,200,json(session));
    const profile=await worker.fetch(new Request(ORIGIN+'/api/v1.4.0/cabinet/profile',{
      headers:{Authorization:'Bearer '+session.sessionToken}}),defaultOff,{});
    assert.equal(profile.status,200,await profile.text());
    assert.deepEqual(fingerprint(restored,P04_SCHEMA.tables),newBefore);checkIntegrity(restored);
    assert.equal(providerCalls,0);
    const proof={proofVersion:1,part:'5/6',status:'PASS',source:'synthetic_only_no_live_database',
      backupFile:path.basename(backup),restoredFile:path.basename(restoredPath),backupSha256,
      schemaSha256:original.schemaSha256,tableCount:Object.keys(original.tables).length,
      exactRowsAndSchemaRestored:true,integrity:'ok',foreignKeys:'ok',p04Schema:P04_SCHEMA.schemaSha256,
      sealedForeignGrantAfterIssuerDeletion:true,knownCostMicrousd:15,anonymousUnknownHoldMicrousd:15,
      defaultOffAcceptedWorkerRead:true,newDataPreservedAfterRuntimeRollback:true,providerCalls,
      production:{appliedMigrations:0,deployments:0,networkRequests:0},
      limits:['Binary local SQLite restore; root native isolated D1/Worker verification remains separate.',
        'Runtime rollback disables the candidate switch and preserves0065 data; no schema down migration.']};
    fs.writeFileSync(path.join(directory,'data-restore-proof.json'),json(proof)+'\n');
    return Object.freeze(proof);
  } finally {restored?.close();f.close();}
}
