import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {SqliteD1} from './helpers/v1.4.0-rebuild-sqlite.mjs';

test('P05 exact bundled probe has closed auth and one complete fictional schema/HTTP/AI journey',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'p05-bundle-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const output=path.join(directory,'probe.mjs'),sha='a'.repeat(40);
  const built=spawnSync(process.execPath,['scripts/v1.4.1-p05-build-probe.mjs',output],{env:{...process.env,GITHUB_SHA:sha},encoding:'utf8'});
  assert.equal(built.status,0,built.stderr);
  const config=JSON.parse(fs.readFileSync(output+'.config.json','utf8'));
  const fingerprint=createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const {default:worker}=await import(pathToFileURL(output));
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');t.after(()=>sqlite.close());
  const binding=new SqliteD1(sqlite);binding.withSession=()=>({prepare:binding.prepare.bind(binding),batch:binding.batch.bind(binding),getBookmark:()=>null});const env={DB:binding,PROBE_TOKEN:'p05-offline-private-token',PROBE_CANDIDATE_SHA:sha,PROBE_EXPIRES_AT:String(Math.floor(Date.now()/1000)+600)};
  const invoke=async(input,token=env.PROBE_TOKEN)=>worker.fetch(new Request('https://p05.example/probe',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(input)}),env);
  const wrong=await invoke({kind:'seed',index:0},'wrong');assert.equal(wrong.status,404);assert.equal(binding.audit.length,0);
  const stale=await invoke({kind:'seed',index:0,expectedCompiledConfigSha256:'0'.repeat(64)});assert.equal((await stale.json()).status,409);assert.equal(binding.audit.length,0);
  const ready=await invoke({kind:'ready',actor:101});assert.equal((await ready.json()).result.compiledConfigSha256,fingerprint);
  const call=async(input)=>{const response=await invoke({...input,expectedCompiledConfigSha256:fingerprint});const body=await response.json();assert.equal(body.status,200,JSON.stringify(body));return body;};
  const seed=await call({kind:'seed',index:0});
  for(let index=1;index<seed.result.batches;index++)await call({kind:'seed',index});
  const http=await call({kind:'http'});assert.ok(Object.values(http.result.assertions).every(value=>value===true));
  const ai=[];for(const phase of ['seed_public','partner_known','partner_unknown','privacy_recovery']){const stage=await call({kind:'ai',phase});assert.ok(stage.metrics.statements<=1000);ai.push(stage);}
  assert.equal(ai[2].result.replayProviderCalls,0);assert.equal(ai[3].result.privacy.subjectDeleted,true);
  const audit=await call({kind:'audit'});assert.equal(audit.result.integrity,'ok');assert.equal(audit.result.foreignKeyErrors,0);assert.equal(audit.result.guards,0);
  fs.writeFileSync(path.join(directory,'journey-metrics.json'),JSON.stringify({http:http.metrics,ai:ai.map(stage=>stage.metrics)}));
  console.log(JSON.stringify({p05BundleMetrics:{http:http.metrics.statements,ai:ai.map(stage=>stage.metrics.statements)}}));
});
