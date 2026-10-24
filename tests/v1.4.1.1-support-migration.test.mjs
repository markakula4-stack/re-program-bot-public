import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {ADMIN_RELEASE_FRAME,assertAdminReleaseFrameReady} from '../src/v1.4.1.1/admin-release-frame.mjs';
import {prepareSupportAdminBridge,supportAdminBridgeSchemaStatus,SUPPORT_ADMIN_SCHEMA_SQL} from '../support-bot/src/admin-bridge-migration.mjs';
assertAdminReleaseFrameReady();
const frame=ADMIN_RELEASE_FRAME.support,candidate='e'.repeat(40);
const configuration={enabled:true,key:'f'.repeat(64),ownerId:8987576334,sourceSha:candidate};
const envelope={sourceSha:candidate,actorId:8987576334,action:'prepare',params:{}};
function setup(t,{rowTransport=rows=>rows}={}) {
  const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec('PRAGMA foreign_keys=ON');
  for(const row of JSON.parse(frame.schemaSnapshotJson))sqlite.exec(row[3]);
  sqlite.exec("INSERT INTO support_people VALUES(202,'Synthetic support user',NULL,0,100)");
  sqlite.exec("INSERT INTO support_tickets(id,user_id,status,created_at,updated_at) VALUES(7,202,'open',100,100)");
  sqlite.exec("INSERT INTO support_messages(id,ticket_id,update_id,direction,body,created_at) VALUES(9,7,1100,'user','Synthetic message',100)");
  sqlite.exec("INSERT INTO support_outbox(event_key,chat_id,kind,payload,ticket_id,message_id,state,attempts,ready_at,created_at) VALUES('synthetic:unknown',202,'staff_message','{}',7,9,'unknown',1,100,100)");
  const db={prepare(sql){return {sql,args:[],bind(...args){return {...this,args};},async all(){return {success:true,results:rowTransport(sqlite.prepare(sql).all(...this.args))};}};},
    withSession(mode){assert.equal(mode,'first-primary');return this;},async batch(statements){sqlite.exec('BEGIN');
      try{const output=statements.map(s=>{const query=sqlite.prepare(s.sql);if(query.columns().length)return {success:true,results:query.all(...s.args),meta:{changes:0}};
        const changes=query.run(...s.args);return {success:true,results:[],meta:{changes:Number(changes.changes)}};});sqlite.exec('COMMIT');return output;}
      catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  return {sqlite,db,env:{SUPPORT_DB:db,SUPPORT_ADMIN_ID:'8987576334'}};
}
const retained=f=>JSON.stringify(JSON.parse(frame.schemaSnapshotJson).filter(row=>row[0]==='table')
  .map(row=>[row[1],f.sqlite.prepare('SELECT * FROM "'+row[1]+'"').all()]));
test('real SQLite support preparation changes only two additive schema objects and preserves unknown outbox rows',async t=>{
  const f=setup(t),before=retained(f),raw=f.sqlite.prepare(SUPPORT_ADMIN_SCHEMA_SQL).all();
  assert.equal(createHash('sha256').update(JSON.stringify(raw)).digest('hex'),frame.rawSchemaSha256);
  const sizes=[],batch=f.db.batch.bind(f.db);f.db.batch=async statements=>{sizes.push(statements.length);return batch(statements);};
  const prepared=await prepareSupportAdminBridge({env:f.env,envelope,configuration});
  assert.equal(prepared.prepared,true);assert.equal(prepared.liveMigrationsApplied,1);assert.deepEqual(sizes,[3]);
  assert.equal(prepared.businessRowsChanged,0);assert.equal(prepared.outboxReplays,0);assert.equal(prepared.oldMigrationsReplayed,0);
  assert.equal(retained(f),before);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM support_admin_commands').get().n,0);
  const state=await supportAdminBridgeSchemaStatus({env:f.env});assert.equal(state.ready,true);assert.equal(state.phase,'prepared');
  assert.equal(state.rawSchemaSha256,frame.preparedRawSchemaSha256);
  await assert.rejects(prepareSupportAdminBridge({env:f.env,envelope,configuration}),/prepare_baseline_mismatch/u);
  assert.deepEqual(sizes,[3]);
});
test('D1 transport property ordering preserves the exact baseline, native migration guard and prepared readiness',async t=>{
  const reordered=rows=>rows.map(row=>({sql:row.sql,tbl_name:row.tbl_name,name:row.name,type:row.type}));
  const f=setup(t,{rowTransport:reordered}),before=retained(f);
  const nativeHash=()=>createHash('sha256').update(JSON.stringify(reordered(f.sqlite.prepare(SUPPORT_ADMIN_SCHEMA_SQL).all()))).digest('hex');
  const original=await supportAdminBridgeSchemaStatus({env:f.env});
  assert.equal(original.phase,'accepted_base');assert.equal(original.ready,false);
  assert.equal(original.rawSchemaSha256,frame.rawSchemaSha256);
  assert.equal(original.nativeRawSchemaSha256,nativeHash());
  assert.notEqual(original.nativeRawSchemaSha256,original.rawSchemaSha256);
  assert.deepEqual(original.nativeRowPropertyOrder,['sql','tbl_name','name','type']);
  let effects=0;const batch=f.db.batch.bind(f.db);
  f.db.batch=async statements=>{effects++;assert.equal(statements.length,3);
    assert.deepEqual(statements[0].args,[frame.schemaSnapshotJson]);return batch(statements);};
  const prepared=await prepareSupportAdminBridge({env:f.env,envelope,configuration});
  assert.equal(prepared.prepared,true);assert.equal(prepared.rawSchemaSha256,frame.preparedRawSchemaSha256);
  assert.equal(retained(f),before);assert.equal(effects,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM support_admin_commands').get().n,0);
  const current=await supportAdminBridgeSchemaStatus({env:f.env});
  assert.equal(current.ready,true);assert.equal(current.phase,'prepared');
  assert.equal(current.rawSchemaSha256,frame.preparedRawSchemaSha256);
  assert.equal(current.nativeRawSchemaSha256,nativeHash());
  assert.notEqual(current.nativeRawSchemaSha256,current.rawSchemaSha256);
  assert.deepEqual(current.nativeRowPropertyOrder,['sql','tbl_name','name','type']);
  assert.equal(Object.hasOwn(prepared,'nativeRawSchemaSha256'),false);
  assert.equal(Object.hasOwn(prepared,'nativeRowPropertyOrder'),false);
  assert.equal(JSON.stringify(current).includes('CREATE TABLE'),false);
});
test('support schema transport rejects extra fields and invalid row types before migration effects',async t=>{
  for(const change of [row=>({...row,unexpected:'field'}),row=>({...row,sql:null}),
    row=>({...row,name:7}),row=>({...row,type:'unknown'}),()=>null]) {
    const f=setup(t,{rowTransport:rows=>rows.map((row,index)=>index===0?change(row):row)});
    f.db.batch=async()=>assert.fail('invalid schema transport cannot reach migration');
    await assert.rejects(supportAdminBridgeSchemaStatus({env:f.env}),/support_admin_schema_unverified/u);
    await assert.rejects(prepareSupportAdminBridge({env:f.env,envelope,configuration}),/support_admin_schema_unverified/u);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='support_admin_commands'").get().n,0);
  }
});
test('support schema guard detects a race inside the effect batch and rolls all0004 effects back',async t=>{
  const f=setup(t),batch=f.db.batch.bind(f.db);let effects=0;
  f.db.batch=async statements=>{effects++;f.sqlite.exec('CREATE TABLE synthetic_schema_race(id INTEGER PRIMARY KEY)');return batch(statements);};
  await assert.rejects(prepareSupportAdminBridge({env:f.env,envelope,configuration}),/prepare_outcome_unverified/u);
  assert.equal(effects,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='support_admin_commands'").get().n,0);
  assert.equal((await supportAdminBridgeSchemaStatus({env:f.env})).phase,'unrecognized');
});
test('lost committed support preparation acknowledgment is observed and never replays the migration',async t=>{
  const f=setup(t),batch=f.db.batch.bind(f.db);let effects=0;
  f.db.batch=async statements=>{effects++;await batch(statements);throw new Error('fictional lost acknowledgment');};
  await assert.rejects(prepareSupportAdminBridge({env:f.env,envelope,configuration}),/prepare_outcome_unverified/u);
  assert.equal((await supportAdminBridgeSchemaStatus({env:f.env})).ready,true);
  await assert.rejects(prepareSupportAdminBridge({env:f.env,envelope,configuration}),/prepare_baseline_mismatch/u);
  assert.equal(effects,1);
});
test('support preparation refuses changed owner, candidate, source and extra parameters before effects',async t=>{
  const f=setup(t);f.db.batch=async()=>assert.fail('no effects allowed');
  for(const patch of [{actorId:7000355122},{sourceSha:'a'.repeat(40)},{params:{parent:'arbitrary'}},{action:'reply'}])
    await assert.rejects(prepareSupportAdminBridge({env:f.env,envelope:{...envelope,...patch},configuration}),/prepare_identity_invalid/u);
  await assert.rejects(prepareSupportAdminBridge({env:{...f.env,SUPPORT_ADMIN_ID:'7000355122'},envelope,configuration}),/prepare_identity_invalid/u);
});
