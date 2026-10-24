import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture} from './helpers/v1.4.0-rebuild-sqlite.mjs';
import {createV141ReleaseControl} from '../src/v1.4.1/release-control.mjs';
import {V141_RELEASE_MIGRATIONS as PLAN} from '../src/v1.4.1/release-migrations.mjs';
import {ADMIN_RELEASE_FRAME} from '../src/v1.4.1.1/admin-release-frame.mjs';

const candidate='a'.repeat(40),token='p06_offline_control_token_with_32_characters';
const repairParent='b0b34ddb0115a71aed3aeedf293bc5cccb4980df';
const latencyParent='1913fe3e41a45cd96c816a90b36f760f11bf3b6e';
const miniappParent='ccb2a2c322ac97f528cc0b428034b2f3e2958ac3';
const profileParent='a623731ab9f052b214850008f5ac30c48c28d8dc';
const adminParent=ADMIN_RELEASE_FRAME.main.sourceSha;
const remoteParent='e6d5e339a3774824010ba83158bc28f20eaa7d17';
const uiParent='4ca462abd4b38a425f2bbfdc73e25f20f46802b0';
const path='https://cabinet.example/__rebuild/v1.4.1/release';
function setup(t) {
  const f=fixture({exactSchema:true});t.after(()=>f.close());
  f.sqlite.exec('PRAGMA foreign_keys=ON');
  f.sqlite.prepare(`INSERT INTO mini_app_release_control
    (id,candidate_sha,revision,state,beta_enabled,owner_telegram_id,issued_at,expires_at,updated_at)
    VALUES(1,?,26,'closed',0,NULL,NULL,NULL,?)`).run(PLAN.acceptedCandidateSha,f.now);
  const env={...f.baseEnv,ADMIN_ID:'900',OWNER_TELEGRAM_ID:'900',V141_SOURCE_SHA:candidate,
    V141_RELEASE_MODE:'default_off',V141_AUTHORIZATION_ENABLED:'false',
    V141_LEGACY_COMPATIBILITY_ENABLED:'false',REBUILD_V140_RC_SHA:PLAN.acceptedCandidateSha,
    REBUILD_V140_RELEASE_REVISION:String(PLAN.acceptedRevision),
    REBUILD_V140_CONTROL_ISSUED_AT:String(f.now-1),REBUILD_V140_CONTROL_EXPIRES_AT:String(f.now+900),
    REBUILD_V140_CONTROL_SECRET_SHA256:createHash('sha256').update(token).digest('hex')};
  const controller=createV141ReleaseControl({clock:()=>f.now,allowTestOrigin:true});
  const call=async(action='status',{customEnv={},payload={action,candidateSha:candidate},headers={},url=path}={})=>{
    const response=await controller(new Request(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,...headers},body:JSON.stringify(payload)}),{...env,...customEnv});
    return {status:response.status,data:response.headers.get('Content-Type')?.includes('json')?await response.json():await response.text()};
  };
  const count=table=>f.sqlite.prepare('SELECT COUNT(*) n FROM '+table).get().n;
  const exists=table=>f.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE type='table' AND name=?").get(table).n===1;
  const lease=()=>f.sqlite.prepare('SELECT * FROM mini_app_release_control WHERE id=1').get();
  return {...f,env,call,count,exists,lease};
}
const publicSchema=sqlite=>sqlite.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name").all();
const snapshotOldRows=f=>JSON.stringify({users:f.sqlite.prepare('SELECT * FROM users ORDER BY telegram_id').all(),
  roles:f.sqlite.prepare('SELECT * FROM user_roles ORDER BY telegram_id,role').all(),
  purchases:f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY 1').all()});

test('fixed authenticated status is read-only and exposes no principal or secret',async t=>{
  const f=setup(t),old=snapshotOldRows(f);f.binding.audit.length=0;
  const result=await f.call();assert.equal(result.status,200);assert.equal(result.data.phase,'accepted_base');
  assert.equal(result.data.schemaSha256,PLAN.baseDdlSha256);assert.equal(result.data.owner.eligible,true);
  assert.equal(result.data.canPrepare,true);assert.equal(result.data.p04Ready,false);
  assert.deepEqual(result.data.lease,{candidateSha:PLAN.acceptedCandidateSha,revision:26,state:'closed',betaEnabled:0,ownerAbsent:true,issuedAbsent:true,expiryAbsent:true});
  assert.ok(f.binding.audit.every(r=>r.mode==='read'));assert.equal(snapshotOldRows(f),old);
  const text=JSON.stringify(result.data);assert.ok(!text.includes(token));assert.ok(!text.includes('telegram_id'));
  assert.equal(f.exists('capability_catalog'),false);
  f.sqlite.exec("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'");
  const restricted=await f.call();assert.equal(restricted.data.owner.eligible,false);assert.equal(restricted.data.canPrepare,false);
});

test('token deadline, source, action, extra input and activation mode cannot enter prepare',async t=>{
  const f=setup(t);f.binding.audit.length=0;
  for(const options of [{headers:{Authorization:'Bearer '+'z'.repeat(40)}},
    {customEnv:{REBUILD_V140_CONTROL_EXPIRES_AT:String(f.now)}},
    {customEnv:{REBUILD_V140_CONTROL_EXPIRES_AT:String(f.now+1801)}},
    {customEnv:{REBUILD_V140_CONTROL_SECRET_SHA256:undefined,REBUILD_V140_CONTROL_SECRET:token}}]) {
    assert.equal((await f.call('prepare',options)).status,404);
  }
  assert.equal(f.binding.audit.length,0);
  for(const options of [{payload:{action:'activate',candidateSha:candidate}},
    {payload:{action:'prepare',candidateSha:'b'.repeat(40)}},
    {payload:{action:'prepare',candidateSha:candidate,sql:'DELETE FROM users'}},
    {customEnv:{V141_RELEASE_MODE:'owner_only'}},
    {customEnv:{V141_AUTHORIZATION_ENABLED:'true'}},
    {customEnv:{OWNER_TELEGRAM_ID:'101'}}]) assert.equal((await f.call('prepare',options)).status,409);
  assert.equal(f.exists('capability_catalog'),false);assert.equal(f.lease().revision,26);
  assert.ok(f.binding.audit.every(r=>r.mode==='read'));
});

test('single atomic preparation preserves old rows and objects, closes epoch 27 and revokes old sessions',async t=>{
  const f=setup(t),old=snapshotOldRows(f),objects=publicSchema(f.sqlite);
  // A real existing session represents the old owner participant surface.
  f.sqlite.prepare(`INSERT INTO mini_app_init_data_receipts
    (init_data_fingerprint,receipt_id,bot_id,telegram_id,auth_date,received_at,expires_at)
    VALUES(?,?,123456789,900,?,?,?)`).run('d'.repeat(64),'p06_old_receipt',f.now-10,f.now-10,f.now+290);
  f.sqlite.prepare(`INSERT INTO mini_app_sessions
    (session_id,session_token_hash,init_data_fingerprint,bot_id,telegram_id,token_version,status,issued_at,expires_at)
    VALUES(?,?,?,123456789,900,1,'active',?,?)`).run('p06_old_session','c'.repeat(64),'d'.repeat(64),f.now-10,f.now+290);
  const batch=f.binding.batch.bind(f.binding),effectSizes=[];
  f.binding.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO mini_app_atomic_guards'))effectSizes.push(statements.length);return batch(statements);};
  const result=await f.call('prepare');assert.equal(result.status,200,JSON.stringify(result.data));
  assert.deepEqual(effectSizes,[631]);assert.equal(result.data.statements,631);
  assert.equal(result.data.schemaSha256,PLAN.preparedDdlSha256);assert.equal(result.data.p04Ready,true);
  assert.equal(result.data.capabilityRows,104);assert.equal(result.data.planRows,416);
  assert.equal(result.data.customerAccessActivated,false);assert.equal(result.data.activeSessions,0);
  assert.equal(f.lease().candidate_sha,candidate);assert.equal(f.lease().revision,27);
  assert.equal(f.lease().state,'closed');assert.equal(f.lease().beta_enabled,0);assert.equal(f.lease().owner_telegram_id,null);
  assert.equal(f.count('mini_app_atomic_guards'),0);assert.equal(f.count('entitlement_grants'),0);
  assert.equal(snapshotOldRows(f),old);
  const next=publicSchema(f.sqlite),byName=new Map(next.map(r=>[r.name,r]));
  for(const row of objects)assert.deepEqual(byName.get(row.name),row,'old schema object changed '+row.name);
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal((await f.call()).data.phase,'prepared');
});

test('concurrent owner demotion is checked within the effect batch and rolls preparation back',async t=>{
  const f=setup(t);f.binding.beforeBatch=()=>f.sqlite.exec("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'");
  const result=await f.call('prepare');assert.equal(result.status,503);assert.equal(result.data.retrySafe,false);
  assert.equal(f.exists('capability_catalog'),false);assert.equal(f.lease().revision,26);assert.equal(f.count('mini_app_atomic_guards'),0);
});

test('concurrent ledger change and a mid-migration failure cannot leave a partial schema',async t=>{
  const f=setup(t);
  f.binding.beforeBatch=()=>f.sqlite.prepare('INSERT INTO re_schema_migrations(version) VALUES(?)').run('p06_concurrent_fixture');
  assert.equal((await f.call('prepare')).status,503);assert.equal(f.exists('capability_catalog'),false);assert.equal(f.lease().revision,26);
  f.sqlite.prepare('DELETE FROM re_schema_migrations WHERE version=?').run('p06_concurrent_fixture');
  f.binding.failStatement=sql=>/CREATE TABLE(?: IF NOT EXISTS)? entitlement_grants/u.test(sql);
  assert.equal((await f.call('prepare')).status,503);assert.equal(f.exists('capability_catalog'),false);assert.equal(f.exists('entitlement_grants'),false);
  assert.equal(f.lease().revision,26);assert.equal(f.count('mini_app_atomic_guards'),0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM re_schema_migrations WHERE version LIKE '1.4.1-%'").get().n,0);
});

test('lost committed reply returns unknown and status observes preparation without a migration retry',async t=>{
  const f=setup(t),batch=f.binding.batch.bind(f.binding);let effectCalls=0;
  f.binding.batch=async statements=>{
    const result=await batch(statements);
    if(statements[0]?.sql.startsWith('INSERT INTO mini_app_atomic_guards')){effectCalls++;throw new Error('synthetic lost commit reply');}
    return result;
  };
  const result=await f.call('prepare');assert.equal(result.status,503);assert.equal(result.data.observeAction,'status');assert.equal(result.data.retrySafe,false);
  assert.equal(f.lease().revision,27);assert.equal(f.count('capability_catalog'),104);
  const status=await f.call();assert.equal(status.status,200);assert.equal(status.data.phase,'prepared');assert.equal(status.data.canPrepare,false);
  assert.equal((await f.call('prepare')).status,409);assert.equal(effectCalls,1);assert.equal(f.count('mini_app_atomic_guards'),0);
});

test('short committed SDK result and partial prior migration are never reported as a successful prepare',async t=>{
  const f=setup(t),batch=f.binding.batch.bind(f.binding);
  f.binding.batch=async statements=>{const result=await batch(statements);return statements[0]?.sql.startsWith('INSERT INTO mini_app_atomic_guards')?result.slice(0,-1):result;};
  assert.equal((await f.call('prepare')).status,503);assert.equal((await f.call()).data.phase,'prepared');
  // A different baseline with only 0062 applied must be observed, never repaired by this controller.
  const g=setup(t);for(const sql of PLAN.statements.slice(0,532))g.sqlite.exec(sql);
  assert.equal((await g.call('prepare')).status,409);assert.equal(g.exists('entitlement_grants'),false);assert.equal(g.lease().revision,26);
});

async function repairSetup(t) {
  const f=setup(t);
  const prepared=await f.call('prepare',{payload:{action:'prepare',candidateSha:repairParent},
    customEnv:{V141_SOURCE_SHA:repairParent}});
  assert.equal(prepared.status,200,JSON.stringify(prepared.data));
  f.recoveryEnv={V141_RELEASE_MODE:'recovery',V141_AUTHORIZATION_ENABLED:'false',
    V141_LEGACY_COMPATIBILITY_ENABLED:'false',REBUILD_V140_RC_SHA:repairParent,REBUILD_V140_RELEASE_REVISION:'27'};
  f.rotate=options=>f.call('rotate',{customEnv:f.recoveryEnv,...options});
  return f;
}
async function latencySetup(t) {
  const f=await repairSetup(t);
  const repaired=await f.rotate({payload:{action:'rotate',candidateSha:latencyParent},
    customEnv:{...f.recoveryEnv,V141_SOURCE_SHA:latencyParent}});
  assert.equal(repaired.status,200,JSON.stringify(repaired.data));
  f.recoveryEnv={...f.recoveryEnv,REBUILD_V140_RC_SHA:latencyParent,REBUILD_V140_RELEASE_REVISION:'28'};
  return f;
}
async function miniappSetup(t) {
  const f=await latencySetup(t);
  const repaired=await f.rotate({payload:{action:'rotate',candidateSha:miniappParent},
    customEnv:{...f.recoveryEnv,V141_SOURCE_SHA:miniappParent}});
  assert.equal(repaired.status,200,JSON.stringify(repaired.data));
  f.recoveryEnv={...f.recoveryEnv,REBUILD_V140_RC_SHA:miniappParent,REBUILD_V140_RELEASE_REVISION:'29'};
  return f;
}
async function profileSetup(t) {
  const f=await miniappSetup(t);
  const repaired=await f.rotate({payload:{action:'rotate',candidateSha:profileParent},
    customEnv:{...f.recoveryEnv,V141_SOURCE_SHA:profileParent}});
  assert.equal(repaired.status,200,JSON.stringify(repaired.data));
  f.recoveryEnv={...f.recoveryEnv,REBUILD_V140_RC_SHA:profileParent,REBUILD_V140_RELEASE_REVISION:'30'};
  return f;
}
async function adminSetup(t) {
  const f=await profileSetup(t);
  const repaired=await f.rotate({payload:{action:'rotate',candidateSha:adminParent},
    customEnv:{...f.recoveryEnv,V141_SOURCE_SHA:adminParent}});
  assert.equal(repaired.status,200,JSON.stringify(repaired.data));
  f.recoveryEnv={...f.recoveryEnv,REBUILD_V140_RC_SHA:adminParent,REBUILD_V140_RELEASE_REVISION:'31'};
  return f;
}
async function remoteSetup(t) {
  const f=await adminSetup(t);
  const updated=await f.rotate({payload:{action:'rotate',candidateSha:remoteParent},
    customEnv:{...f.recoveryEnv,V141_SOURCE_SHA:remoteParent}});
  assert.equal(updated.status,200,JSON.stringify(updated.data));
  f.recoveryEnv={...f.recoveryEnv,REBUILD_V140_RC_SHA:remoteParent,REBUILD_V140_RELEASE_REVISION:'32'};
  return f;
}
async function uiSetup(t) {
  const f=await remoteSetup(t);
  const updated=await f.rotate({payload:{action:'rotate',candidateSha:uiParent},
    customEnv:{...f.recoveryEnv,V141_SOURCE_SHA:uiParent}});
  assert.equal(updated.status,200,JSON.stringify(updated.data));
  f.recoveryEnv={...f.recoveryEnv,REBUILD_V140_RC_SHA:uiParent,REBUILD_V140_RELEASE_REVISION:'33'};
  return f;
}
function retainedRows(f) {
  const excluded=new Set(['mini_app_release_control','mini_app_sessions','mini_app_atomic_guards']);
  return JSON.stringify(f.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
    .all().filter(row=>!excluded.has(row.name)).map(({name})=>[name,f.sqlite.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all()]));
}

test('fixed recovery rotation uses five statements, preserves all retained rows and DDL, revokes sessions and is never replayed',async t=>{
  const f=await repairSetup(t);
  f.sqlite.prepare(`INSERT INTO mini_app_init_data_receipts
    (init_data_fingerprint,receipt_id,bot_id,telegram_id,auth_date,received_at,expires_at)
    VALUES(?,?,123456789,900,?,?,?)`).run('d'.repeat(64),'p06_rotate_receipt',f.now-10,f.now-10,f.now+290);
  f.sqlite.prepare(`INSERT INTO mini_app_sessions
    (session_id,session_token_hash,init_data_fingerprint,bot_id,telegram_id,token_version,status,issued_at,expires_at)
    VALUES(?,?,?,123456789,900,1,'active',?,?)`).run('p06_rotate_session','c'.repeat(64),'d'.repeat(64),f.now-10,f.now+290);
  const retained=retainedRows(f),objects=publicSchema(f.sqlite),batch=f.binding.batch.bind(f.binding),sizes=[];
  f.binding.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO mini_app_atomic_guards'))sizes.push(statements.length);return batch(statements);};
  const result=await f.rotate();assert.equal(result.status,200,JSON.stringify(result.data));
  assert.deepEqual(sizes,[5]);assert.equal(result.data.statements,5);assert.equal(result.data.action,'rotate');
  assert.equal(result.data.mode,'recovery');assert.equal(result.data.phase,'prepared');assert.equal(result.data.p04Ready,true);
  assert.equal(result.data.schemaSha256,PLAN.preparedDdlSha256);assert.equal(result.data.addedMigrations,0);assert.equal(result.data.addedTables,0);
  assert.equal(result.data.rolesChanged,0);assert.equal(result.data.grantsBackfill,0);assert.equal(result.data.financialBackfill,0);
  assert.equal(result.data.customerAccessActivated,false);assert.equal(result.data.activeSessions,0);
  assert.deepEqual(result.data.lease,{candidateSha:candidate,revision:28,state:'closed',betaEnabled:0,ownerAbsent:true,issuedAbsent:true,expiryAbsent:true});
  assert.equal(retainedRows(f),retained);assert.deepEqual(publicSchema(f.sqlite),objects);assert.equal(f.count('mini_app_atomic_guards'),0);
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  const intermediate=await f.call('status',{customEnv:f.recoveryEnv});assert.equal(intermediate.data.phase,'prepared');
  const final=await f.call('status',{customEnv:{V141_RELEASE_MODE:'owner_only',V141_AUTHORIZATION_ENABLED:'true',
    V141_LEGACY_COMPATIBILITY_ENABLED:'true',REBUILD_V140_RC_SHA:candidate,REBUILD_V140_RELEASE_REVISION:'28'}});
  assert.equal(final.data.phase,'prepared');assert.equal(final.data.lease.revision,28);
  assert.equal((await f.rotate()).status,409);assert.deepEqual(sizes,[5]);
  const unknown=await f.call('status',{customEnv:{...f.recoveryEnv,REBUILD_V140_RC_SHA:'f'.repeat(40)}});
  assert.equal(unknown.data.phase,'unrecognized');
});

test('rotation refuses copied parent input, unknown lineage, enabled mode, partial markers and an open participant lease',async t=>{
  const f=await repairSetup(t);f.binding.audit.length=0;
  for(const patch of [{V141_RELEASE_MODE:'owner_only'},{V141_AUTHORIZATION_ENABLED:'true'},
    {V141_LEGACY_COMPATIBILITY_ENABLED:'true'},{REBUILD_V140_RC_SHA:'f'.repeat(40)},
    {REBUILD_V140_RELEASE_REVISION:'26'},{REBUILD_V140_RELEASE_REVISION:'28'},
    {V141_SOURCE_SHA:repairParent}]) {
    const options={customEnv:{...f.recoveryEnv,...patch}};
    if(patch.V141_SOURCE_SHA)options.payload={action:'rotate',candidateSha:repairParent};
    assert.equal((await f.rotate(options)).status,409);
  }
  assert.equal((await f.rotate({payload:{action:'rotate',candidateSha:candidate,parentSha:repairParent}})).status,409);
  assert.equal((await f.rotate({payload:{action:'rotate',candidateSha:'f'.repeat(40)}})).status,409);
  f.sqlite.prepare("UPDATE mini_app_release_control SET state='open',beta_enabled=1,owner_telegram_id=900,issued_at=?,expires_at=?")
    .run(f.now,f.now+300);
  assert.equal((await f.rotate()).status,409);
  f.sqlite.exec("UPDATE mini_app_release_control SET state='closed',beta_enabled=0,owner_telegram_id=NULL,issued_at=NULL,expires_at=NULL");
  f.sqlite.prepare('DELETE FROM re_schema_migrations WHERE version=?').run(PLAN.markers[0]);
  assert.equal((await f.rotate()).status,409);
  assert.ok(f.binding.audit.every(row=>row.mode==='read'));assert.equal(f.lease().candidate_sha,repairParent);assert.equal(f.lease().revision,27);
});

test('rotation rechecks owner, schema and ledger within the same effect batch and observes a lost committed reply',async t=>{
  for(const mutate of [
    f=>f.sqlite.exec("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'"),
    f=>f.sqlite.prepare('INSERT INTO re_schema_migrations(version) VALUES(?)').run('p06_rotation_race'),
    f=>f.sqlite.exec('CREATE TABLE p06_rotation_race(id INTEGER PRIMARY KEY)'),
  ]) {
    const f=await repairSetup(t),batch=f.binding.batch.bind(f.binding);let effects=0;
    f.binding.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO mini_app_atomic_guards')){effects++;mutate(f);}return batch(statements);};
    const result=await f.rotate();assert.equal(result.status,503);assert.equal(result.data.code,'v141_release_rotate_outcome_unverified');
    assert.equal(result.data.retrySafe,false);assert.equal(f.lease().candidate_sha,repairParent);assert.equal(f.lease().revision,27);
    assert.equal(f.count('mini_app_atomic_guards'),0);assert.equal(effects,1);
  }
  const f=await repairSetup(t),batch=f.binding.batch.bind(f.binding);let effects=0;
  f.binding.batch=async statements=>{const result=await batch(statements);if(statements[0]?.sql.startsWith('INSERT INTO mini_app_atomic_guards')){effects++;throw new Error('fictional lost rotation reply');}return result;};
  const lost=await f.rotate();assert.equal(lost.status,503);assert.equal(lost.data.retrySafe,false);assert.equal(lost.data.observeAction,'status');
  assert.equal(f.lease().candidate_sha,candidate);assert.equal(f.lease().revision,28);
  assert.equal((await f.call('status',{customEnv:f.recoveryEnv})).data.phase,'prepared');
  assert.equal((await f.rotate()).status,409);assert.equal(effects,1);assert.equal(f.count('mini_app_atomic_guards'),0);
});

for(const frame of [
  {name:'latency',parent:latencyParent,revision:28,setup:latencySetup},
  {name:'miniapp read',parent:miniappParent,revision:29,setup:miniappSetup},
  {name:'profile UI',parent:profileParent,revision:30,setup:profileSetup},
  {name:'full admin',parent:adminParent,revision:31,setup:adminSetup},
  {name:'owner remote',parent:remoteParent,revision:32,setup:remoteSetup},
  {name:'owner UI',parent:uiParent,revision:33,setup:uiSetup},
]) {
test(`fixed ${frame.name} checkpoint rotates epoch${frame.revision} to${frame.revision+1} without migrations or changes to retained data`,async t=>{
  const f=await frame.setup(t),retained=retainedRows(f),objects=publicSchema(f.sqlite),batch=f.binding.batch.bind(f.binding),sizes=[];
  f.binding.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO mini_app_atomic_guards'))sizes.push(statements.length);return batch(statements);};
  const result=await f.rotate();assert.equal(result.status,200,JSON.stringify(result.data));
  assert.deepEqual(sizes,[5]);assert.equal(result.data.statements,5);
  assert.equal(result.data.addedMigrations,0);assert.equal(result.data.addedTables,0);
  assert.equal(result.data.rolesChanged,0);assert.equal(result.data.grantsBackfill,0);assert.equal(result.data.financialBackfill,0);
  assert.equal(result.data.customerAccessActivated,false);assert.equal(result.data.activeSessions,0);
  assert.deepEqual(result.data.lease,{candidateSha:candidate,revision:frame.revision+1,state:'closed',betaEnabled:0,ownerAbsent:true,issuedAbsent:true,expiryAbsent:true});
  assert.equal(retainedRows(f),retained);assert.deepEqual(publicSchema(f.sqlite),objects);
  assert.equal(f.count('mini_app_atomic_guards'),0);assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal((await f.call('status',{customEnv:f.recoveryEnv})).data.phase,'prepared');
  const final=await f.call('status',{customEnv:{V141_RELEASE_MODE:'owner_only',V141_AUTHORIZATION_ENABLED:'true',
    V141_LEGACY_COMPATIBILITY_ENABLED:'true',REBUILD_V140_RC_SHA:candidate,REBUILD_V140_RELEASE_REVISION:String(frame.revision+1)}});
  assert.equal(final.data.phase,'prepared');assert.equal(final.data.lease.revision,frame.revision+1);
  assert.equal((await f.rotate()).status,409);assert.deepEqual(sizes,[5]);
});

test(`${frame.name} rotation refuses mismatched known frames, copied candidate, owner ineligibility, partial markers and schema races`,async t=>{
  const f=await frame.setup(t);f.binding.audit.length=0;
  for(const patch of [{REBUILD_V140_RC_SHA:repairParent},{REBUILD_V140_RELEASE_REVISION:'27'},
    {REBUILD_V140_RELEASE_REVISION:String(frame.revision+1)},{REBUILD_V140_RC_SHA:'f'.repeat(40)},
    {V141_RELEASE_MODE:'owner_only'},{V141_AUTHORIZATION_ENABLED:'true'},{V141_LEGACY_COMPATIBILITY_ENABLED:'true'}])
    assert.equal((await f.rotate({customEnv:{...f.recoveryEnv,...patch}})).status,409);
  assert.equal((await f.rotate({payload:{action:'rotate',candidateSha:frame.parent},
    customEnv:{...f.recoveryEnv,V141_SOURCE_SHA:frame.parent}})).status,409);
  assert.equal((await f.rotate({payload:{action:'rotate',candidateSha:candidate,parentSha:frame.parent}})).status,409);
  f.sqlite.exec("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'");
  assert.equal((await f.rotate()).status,409);
  f.sqlite.exec("UPDATE user_roles SET status='active' WHERE telegram_id=900 AND role='admin'");
  f.sqlite.prepare('DELETE FROM re_schema_migrations WHERE version=?').run(PLAN.markers[0]);
  assert.equal((await f.rotate()).status,409);assert.ok(f.binding.audit.every(row=>row.mode==='read'));
  assert.equal(f.lease().candidate_sha,frame.parent);assert.equal(f.lease().revision,frame.revision);
  const race=await frame.setup(t),batch=race.binding.batch.bind(race.binding);let effects=0;
  race.binding.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO mini_app_atomic_guards')){effects++;race.sqlite.exec('CREATE TABLE latency_rotation_race(id INTEGER PRIMARY KEY)');}return batch(statements);};
  const result=await race.rotate();assert.equal(result.status,503);assert.equal(result.data.retrySafe,false);
  assert.equal(race.lease().candidate_sha,frame.parent);assert.equal(race.lease().revision,frame.revision);
  assert.equal(race.count('mini_app_atomic_guards'),0);assert.equal(effects,1);
});

test(`${frame.name} lost committed reply is observed at epoch${frame.revision+1} with no second mutation`,async t=>{
  const f=await frame.setup(t),batch=f.binding.batch.bind(f.binding);let effects=0;
  f.binding.batch=async statements=>{const result=await batch(statements);if(statements[0]?.sql.startsWith('INSERT INTO mini_app_atomic_guards')){effects++;throw new Error('fictional lost latency rotation reply');}return result;};
  const lost=await f.rotate();assert.equal(lost.status,503);assert.equal(lost.data.retrySafe,false);assert.equal(lost.data.observeAction,'status');
  assert.equal(f.lease().candidate_sha,candidate);assert.equal(f.lease().revision,frame.revision+1);
  assert.equal((await f.call('status',{customEnv:f.recoveryEnv})).data.phase,'prepared');
  assert.equal((await f.rotate()).status,409);assert.equal(effects,1);assert.equal(f.count('mini_app_atomic_guards'),0);
});
}
