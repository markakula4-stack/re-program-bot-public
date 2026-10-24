import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {gunzipSync} from 'node:zlib';
import {createHash,webcrypto} from 'node:crypto';
import {createV141StartupReadiness,V141_STARTUP_RUNTIME_KEY} from '../src/v1.4.1/startup-readiness.mjs';
import {V143_STARTUP_SCHEMA} from '../src/v1.4.3/startup-schema-manifest.mjs';

const schema=JSON.parse(gunzipSync(Buffer.from(fs.readFileSync(new URL(
  './fixtures/v1.4.4-startup-schema-exact365.json.gz.b64',import.meta.url),'utf8').trim(),'base64')));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const source='d66c61516062d50321892f7b021a3eb147454e47';
const release={V141_RELEASE_MODE:'owner_only',V141_SOURCE_SHA:source,
  V141_AUTHORIZATION_ENABLED:'true',V141_LEGACY_COMPATIBILITY_ENABLED:'true'};
const rebuild={MINI_APP_ORIGIN:'https://re-program-bot.markakula4.workers.dev',
  REBUILD_V140_OWNER_WINDOW:'false',REBUILD_V140_OWNER_TELEGRAM_ID:'0',
  REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',REBUILD_V140_ADMIN_BETA_GRANTS_ENABLED:'false',
  REBUILD_V140_RC_SHA:source,REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',REBUILD_V140_RELEASE_REVISION:'40',
  REBUILD_V140_BOT_ID:'8562951985',REBUILD_V140_CONTROL_ISSUED_AT:'1000000000',
  REBUILD_V140_CONTROL_EXPIRES_AT:'1000000001',REBUILD_V140_CONTROL_SECRET_SHA256:'a'.repeat(64),
  ...Object.fromEntries(['STORAGE','WRITES','OFFER_ACTIONS','EFFECTS','RETENTION','TELEGRAM','BETA','RESULT_ACTIONS']
    .map(key=>['REBUILD_V140_'+key+'_ENABLED',['STORAGE','WRITES','TELEGRAM'].includes(key)?'true':'false']))};
const quotaMessage="D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
const core=fs.readFileSync(new URL('../re-program-bot-worker.js',import.meta.url),'utf8');

// Execute the real historical initializer/cache in an isolated VM. Only ESM
// syntax is adapted in memory; no source file, database or provider is changed.
function harness({snapshot=structuredClone(schema),quota=null,historicalMiss=false}={}){
  const calls=[];
  const record=(method,statements,kind='fallback')=>calls.push({method,statements,kind});
  const binding={withSession(mode){assert.equal(mode,'first-primary');return this;},prepare(sql){
    const statement={sql,params:[],bind(...params){return {...this,params};},
      async all(){
        if(sql.includes('schema_json')&&sql.includes('ledger_json')){
          record('all',[sql],'metadata');
          assert.deepEqual(this.params,[source,40]);
          if(quota)throw quota;
          return {success:true,results:[{schema_json:JSON.stringify(snapshot.objects),
            ledger_json:JSON.stringify(snapshot.versions),lease_ready:snapshot.leaseReady}]};
        }
        record('all',[sql]);
        return {success:true,results:/PRAGMA table_info\(users\)/u.test(sql)?[{name:'inviter_bound_at'}]:
          /PRAGMA table_info\(partner_programs\)/u.test(sql)?[{name:'allowed_domains'}]:[]};
      },
      async first(){
        if(sql.startsWith('INSERT INTO telegram_update_receipts')){
          record('first',[sql],'receipt');return {update_id:this.params[0]};
        }
        record('first',[sql]);
        return /re_schema_migrations/u.test(sql)?{version:'already-installed'}:null;
      },
      async run(){record('run',[sql]);return {success:true,meta:{changes:0}};}};
    return statement;
  },async batch(statements){
    const sqls=statements.map(s=>s.sql);
    const retention=sqls[0]?.includes("SELECT 'bot_start'")===true;
    record('batch',sqls,retention?'retention':'fallback');
    return statements.map(()=>({success:true,results:[],meta:{changes:0}}));
  }};
  const readiness=createV141StartupReadiness({readRelease:()=>release,readRebuild:()=>rebuild});
  const runtime=historicalMiss?{...readiness,async isPrepared(env){
    await readiness.isPrepared(env);return false;
  }}:readiness;
  assert.equal((core.match(/^import .*;$/gmu)??[]).length,6);
  assert.equal(core.split('export default {').length,2);
  const executable=core.replace(/^import .*;\n/gmu,'').replace('export default {','const diagnosedWorker = {');
  const scope=vm.createContext({console,crypto:webcrypto,TextEncoder,TextDecoder,URL,Response,Request,Headers,
    fetch(){throw new Error('offline_provider_forbidden');},[V141_STARTUP_RUNTIME_KEY]:runtime});
  vm.runInContext(executable,scope);
  const env={DB:binding,...release,...rebuild},pending=[];
  scope.env=env;scope.ctx={waitUntil:p=>pending.push(p)};
  const prepare=()=>vm.runInContext('ensureOfferSchema(env,ctx)',scope);
  const claim=async id=>{scope.update={update_id:id,message:{from:{id:8987576334},text:'/start'}};
    return vm.runInContext('claimTelegramUpdate(env,update)',scope);};
  const count=kind=>({sdk:calls.filter(c=>c.kind===kind).length,
    sql:calls.filter(c=>c.kind===kind).reduce((n,c)=>n+c.statements.length,0)});
  return {calls,count,prepare,claim,ready:()=>readiness.isPrepared(env),settle:()=>Promise.all(pending)};
}

test('exact Main365 schema avoids cold historical bootstrap and warm startup is cached',async()=>{
  assert.equal(schema.objects.length,1254);assert.equal(schema.versions.length,70);
  assert.equal(hash(schema.objects),'11772521447867efa55f59e165522f27d95e5789c09cbb3de73d42d91b0973d9');
  assert.equal(hash(schema.versions),'c226575640162cfed4d60c10269d1729eea90c5bb25e4d039200240d4951e025');
  const f=harness();await f.prepare();
  assert.deepEqual(f.count('metadata'),{sdk:1,sql:1});
  assert.deepEqual(f.count('fallback'),{sdk:0,sql:0});
  assert.equal(f.count('receipt').sql,0,'schema readiness precedes receipt claim');
  assert.equal((await f.claim(7001)).claimed,true);await f.settle();
  assert.deepEqual(f.count('retention'),{sdk:1,sql:28},'existing retention still runs once');
  const before=f.calls.length;await f.prepare();assert.equal(f.calls.length,before);
  assert.equal((await f.claim(7002)).claimed,true);
  assert.deepEqual(f.count('metadata'),{sdk:1,sql:1});
  assert.deepEqual(f.count('fallback'),{sdk:0,sql:0});
});

test('historical manifest miss records 210 unnecessary bootstrap SQL before receipt claim',async()=>{
  assert.equal(V143_STARTUP_SCHEMA.profiles.some(p=>p.schemaSha256===hash(schema.objects)),false);
  const f=harness({historicalMiss:true});await f.prepare();await f.settle();
  assert.deepEqual(f.count('metadata'),{sdk:1,sql:1});
  assert.deepEqual(f.count('fallback'),{sdk:29,sql:210});
  const types={};for(const call of f.calls.filter(c=>c.kind==='fallback'))for(const sql of call.statements){
    const type=sql.replace(/--[^\n]*/gu,'').trim().match(/^\w+/u)[0];types[type]=(types[type]??0)+1;
  }
  assert.deepEqual(types,{CREATE:147,SELECT:9,INSERT:39,PRAGMA:2,UPDATE:13});
  assert.equal(f.count('receipt').sql,0);
  assert.equal((await f.claim(7003)).claimed,true);
});

for(const [name,mutate] of [
  ['changed old guard',s=>{const row=s.objects.find(r=>r[0]==='trigger'&&r[1]==='trg_users_first_inviter_immutable');assert.ok(row);row[3]+=' ';}],
  ['missing table',s=>{const index=s.objects.findIndex(r=>r[0]==='table'&&r[1]==='users');assert.ok(index>=0);s.objects.splice(index,1);}],
  ['extra ledger marker',s=>s.versions.push('unreviewed-startup-marker')],
  ['open source epoch',s=>{s.leaseReady=0;}],
])test('exact package startup rejects '+name,async()=>{
  const snapshot=structuredClone(schema);mutate(snapshot);const f=harness({snapshot});
  assert.equal(await f.ready(),false);assert.deepEqual(f.count('metadata'),{sdk:1,sql:1});
  assert.deepEqual(f.count('fallback'),{sdk:0,sql:0});assert.equal(f.count('receipt').sql,0);
});

test('depleted D1 daily read quota propagates before bootstrap and receipt claim',async()=>{
  const quota=new Error(quotaMessage),f=harness({quota});
  await assert.rejects(f.prepare(),error=>error===quota);
  assert.deepEqual(f.count('metadata'),{sdk:1,sql:1});
  assert.deepEqual(f.count('fallback'),{sdk:0,sql:0});
  assert.equal(f.count('retention').sql,0);assert.equal(f.count('receipt').sql,0);
});
