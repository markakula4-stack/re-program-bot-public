import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture} from './helpers/v1.4.0-rebuild-sqlite.mjs';
import {createV141ReleaseControl} from '../src/v1.4.1/release-control.mjs';
import {V141_RELEASE_MIGRATIONS as PLAN} from '../src/v1.4.1/release-migrations.mjs';
const parent='d8e93642192ce91ec42aa26dff563de6e92d5e25',candidate='a'.repeat(40);
const token='v142_offline_control_token_with_32_characters';
function setup(t,{parentSha=parent,parentRevision=34}={}) {
  const f=fixture({exactSchema:true});t.after(()=>f.close());f.sqlite.exec('PRAGMA foreign_keys=ON');
  for(const sql of PLAN.statements)f.sqlite.exec(sql);
  f.sqlite.prepare(`INSERT INTO mini_app_release_control
    (id,candidate_sha,revision,state,beta_enabled,owner_telegram_id,issued_at,expires_at,updated_at)
    VALUES(1,?,?,'closed',0,NULL,NULL,NULL,?)`).run(parentSha,parentRevision,f.now);
  const env={...f.baseEnv,ADMIN_ID:'900',OWNER_TELEGRAM_ID:'900',V141_SOURCE_SHA:candidate,
    V141_RELEASE_MODE:'recovery',V141_AUTHORIZATION_ENABLED:'false',V141_LEGACY_COMPATIBILITY_ENABLED:'false',
    REBUILD_V140_RC_SHA:parentSha,REBUILD_V140_RELEASE_REVISION:String(parentRevision),REBUILD_V140_CONTROL_ISSUED_AT:String(f.now-1),
    REBUILD_V140_CONTROL_EXPIRES_AT:String(f.now+900),REBUILD_V140_CONTROL_SECRET_SHA256:createHash('sha256').update(token).digest('hex')};
  const controller=createV141ReleaseControl({clock:()=>f.now,allowTestOrigin:true});
  const call=async(action='rotate',patch={},payload={action,candidateSha:candidate})=>{
    const response=await controller(new Request('https://cabinet.example/__rebuild/v1.4.1/release',{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(payload)}),{...env,...patch});
    return {status:response.status,data:await response.json()};
  };
  const lease=()=>f.sqlite.prepare('SELECT * FROM mini_app_release_control WHERE id=1').get();
  const retained=()=>JSON.stringify(f.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
    .all().filter(({name})=>!['mini_app_release_control','mini_app_sessions','mini_app_atomic_guards'].includes(name))
    .map(({name})=>[name,f.sqlite.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all()]));
  return {...f,env,call,lease,retained};
}
test('exact accepted1.4.1.1 parent rotates closed34→35 without migrations, preserved-data changes or replay',async t=>{
  const f=setup(t);
  f.sqlite.prepare(`INSERT INTO mini_app_init_data_receipts
    (init_data_fingerprint,receipt_id,bot_id,telegram_id,auth_date,received_at,expires_at)
    VALUES(?,?,123456789,900,?,?,?)`).run('d'.repeat(64),'v142_old_receipt',f.now-10,f.now-10,f.now+290);
  f.sqlite.prepare(`INSERT INTO mini_app_sessions
    (session_id,session_token_hash,init_data_fingerprint,bot_id,telegram_id,token_version,status,issued_at,expires_at)
    VALUES(?,?,?,123456789,900,1,'active',?,?)`).run('v142_old_session','c'.repeat(64),'d'.repeat(64),f.now-10,f.now+290);
  const retained=f.retained(),ddl=f.sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
  const batch=f.binding.batch.bind(f.binding),sizes=[];
  f.binding.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO mini_app_atomic_guards'))sizes.push(statements.length);return batch(statements);};
  const result=await f.call();assert.equal(result.status,200,JSON.stringify(result.data));assert.deepEqual(sizes,[5]);
  assert.equal(result.data.addedTables,0);assert.equal(result.data.addedMigrations,0);assert.equal(result.data.customerAccessActivated,false);
  assert.equal(result.data.activeSessions,0);assert.equal(f.lease().candidate_sha,candidate);assert.equal(f.lease().revision,35);
  assert.equal(f.lease().state,'closed');assert.equal(f.lease().beta_enabled,0);assert.equal(f.retained(),retained);
  assert.deepEqual(f.sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),ddl);
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  const status=await f.call('status',{REBUILD_V140_RC_SHA:candidate,REBUILD_V140_RELEASE_REVISION:'35',
    V141_RELEASE_MODE:'owner_only',V141_AUTHORIZATION_ENABLED:'true',V141_LEGACY_COMPATIBILITY_ENABLED:'true'});
  assert.equal(status.data.phase,'prepared');assert.equal(status.data.lease.revision,35);
  assert.equal((await f.call()).status,409);assert.deepEqual(sizes,[5]);
});
test('34→35 refuses mismatched frame, open lease, lost owner and partial migration ledger without effects',async t=>{
  const f=setup(t);f.binding.audit.length=0;
  for(const patch of [{REBUILD_V140_RC_SHA:'f'.repeat(40)},{REBUILD_V140_RELEASE_REVISION:'33'},
    {REBUILD_V140_RELEASE_REVISION:'35'},{V141_RELEASE_MODE:'owner_only'},{V141_AUTHORIZATION_ENABLED:'true'}])
    assert.equal((await f.call('rotate',patch)).status,409);
  assert.equal((await f.call('rotate',{V141_SOURCE_SHA:parent},{action:'rotate',candidateSha:parent})).status,409);
  f.sqlite.exec("UPDATE mini_app_release_control SET state='open',beta_enabled=1,owner_telegram_id=900,issued_at=1,expires_at=2");
  assert.equal((await f.call()).status,409);
  f.sqlite.exec("UPDATE mini_app_release_control SET state='closed',beta_enabled=0,owner_telegram_id=NULL,issued_at=NULL,expires_at=NULL");
  f.sqlite.exec("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'");
  assert.equal((await f.call()).status,409);f.sqlite.exec("UPDATE user_roles SET status='active' WHERE telegram_id=900 AND role='admin'");
  f.sqlite.prepare('DELETE FROM re_schema_migrations WHERE version=?').run(PLAN.markers[0]);
  assert.equal((await f.call()).status,409);assert.ok(f.binding.audit.every(row=>row.mode==='read'));
  assert.equal(f.lease().candidate_sha,parent);assert.equal(f.lease().revision,34);
});
test('lost committed34→35 reply is observed by status, and the mutation cannot be repeated',async t=>{
  const f=setup(t),batch=f.binding.batch.bind(f.binding);let effects=0;
  f.binding.batch=async statements=>{const result=await batch(statements);
    if(statements[0]?.sql.startsWith('INSERT INTO mini_app_atomic_guards')){effects++;throw new Error('offline lost committed reply');}
    return result;};
  const result=await f.call();assert.equal(result.status,503);assert.equal(result.data.retrySafe,false);
  assert.equal(f.lease().candidate_sha,candidate);assert.equal(f.lease().revision,35);
  const observed=await f.call('status');assert.equal(observed.data.phase,'prepared');assert.equal(observed.data.lease.revision,35);
  assert.equal((await f.call()).status,409);assert.equal(effects,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_atomic_guards').get().n,0);
});

// A display-only correction may replace only the actually installed1.4.2
// source/epoch, preserving the existing data and closed admission state.
test('exact installed1.4.2 parent rotates closed35→36 once while initial34→35 remains recognized',async t=>{
 const current='a5b73c3ffb88b656010c01d0af43971cc40c225b',f=setup(t,{parentSha:current,parentRevision:35});
 const retained=f.retained(),ddl=f.sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
 const result=await f.call();assert.equal(result.status,200,JSON.stringify(result.data));
 assert.equal(result.data.statements,5);assert.equal(result.data.addedTables,0);assert.equal(result.data.addedMigrations,0);
 assert.equal(result.data.customerAccessActivated,false);assert.equal(f.lease().candidate_sha,candidate);assert.equal(f.lease().revision,36);
 assert.equal(f.lease().state,'closed');assert.equal(f.lease().beta_enabled,0);assert.equal(f.retained(),retained);
 assert.deepEqual(f.sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),ddl);
 const status=await f.call('status',{REBUILD_V140_RC_SHA:candidate,REBUILD_V140_RELEASE_REVISION:'36',
  V141_RELEASE_MODE:'owner_only',V141_AUTHORIZATION_ENABLED:'true',V141_LEGACY_COMPATIBILITY_ENABLED:'true'});
 assert.equal(status.data.phase,'prepared');assert.equal(status.data.lease.revision,36);assert.equal((await f.call()).status,409);
});
