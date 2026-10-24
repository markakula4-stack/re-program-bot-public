import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { createAuthorityResolver } from '../src/v1.4.1/authority-resolver.mjs';
import { createResourceResolver, readResourceFacts } from '../src/v1.4.1/resource-resolver.mjs';
import { can } from '../src/v1.4.1/entitlement-engine.mjs';
import { createAiQuotaSettlement, AI_QUOTA_RUNTIME_WIRED } from '../src/v1.4.1/ai-quota-settlement.mjs';
import { loadApprovedAiPartnerFactBundle } from '../src/v1.3.8/ai-partner-draft-runtime.mjs';
import { AI_GATEWAY_PROVIDER_CONSENT_VERSION } from '../src/v1.3.8/ai-partner-gateway.mjs';

const day=at=>new Date(at*1000).toISOString().slice(0,10);
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>value && typeof value==='object' && !Array.isArray(value)
  ? '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}'
  : Array.isArray(value)?'['+value.map(canonical).join(',')+']':JSON.stringify(value);
let sequence=0;
function fixture(t) {
  const f=foundationFixture(t);
  f.clock=f.now; f.sqlite.function('unixepoch',()=>f.clock);
  f.sqlite.exec(`INSERT OR IGNORE INTO ai_runtime_settings(id) VALUES(1);
    UPDATE ai_runtime_settings SET rollout_mode='all';
    UPDATE user_access SET ai_enabled=1;
    INSERT INTO ai_user_consents(telegram_id,consent_version,consented_at)
    SELECT telegram_id,'1.3.0-2026-08-27',CURRENT_TIMESTAMP FROM users;`);
  f.module=createAiQuotaSettlement();
  f.proof=async(id=101,cap='ai.public_chat',patch={})=>{
    const context=await f.context(id,cap,'mini_app',{idempotencyKey:'ai-offline-operation-'+String(++sequence).padStart(8,'0'),
      requestPayload:{prompt:'Как пользоваться ботом?'},...patch});
    const actor=await createAuthorityResolver().resolveActor(context);
    const resource=await createResourceResolver().resolve(context,actor);
    return {actor,resource,decision:can(actor,cap,resource),context};
  };
  f.admit=async(id=101,cap='ai.public_chat',patch={})=>{
    const proof=await f.proof(id,cap,patch); assert.equal(proof.decision.allowed,true,JSON.stringify({decision:proof.decision,ai:readResourceFacts(proof.resource).ai}));
    return {...proof,...await f.module.admit(proof.actor,proof.decision)};
  };
  f.complete=(ticket,patch={})=>f.module.settle(ticket,{outcome:'success',answer:'Откройте меню бота.',
    usage:{inputTokens:10,outputTokens:10},remember:true,...patch});
  return f;
}
const count=(f,table,where='1',params=[])=>f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params).n;
function successes(f,n,id=101,date=day(f.now),bucket='public') {
  const insert=f.sqlite.prepare(`INSERT INTO ai_usage_events(request_id,telegram_id,usage_date,bucket,status,neurons_milli)
    VALUES(?,?,?,?,'success',1)`);
  for(let i=0;i<n;i++) insert.run('prior-success-'+id+'-'+(++sequence),id,date,bucket);
}

test('actual private brands, stable operation ID and closed module reject JSON authority before writes',async t=>{
  const f=fixture(t), p=await f.proof(); const writes=f.binding.audit.filter(x=>x.mode==='write').length;
  await assert.rejects(f.module.admit({...p.actor},p.decision),/untrusted_ai_admission/u);
  await assert.rejects(f.module.admit(p.actor,{...p.decision}),/untrusted_ai_admission/u);
  const missing=await f.proof(101,'ai.public_chat',{idempotencyKey:undefined});
  await assert.rejects(f.module.admit(missing.actor,missing.decision),/stable_ai_operation_required/u);
  await assert.rejects(f.module.settle({requestId:'pretend-ticket'},{outcome:'failed'}),/untrusted_ai_ticket/u);
  assert.equal(f.binding.audit.filter(x=>x.mode==='write').length,writes);
  assert.equal(AI_QUOTA_RUNTIME_WIRED,false);
});
test('success means validated answer before delivery; event, CAS and five-exchange history commit together once',async t=>{
  const f=fixture(t), a=await f.admit(); assert.equal(a.ok,true);
  const result=await f.complete(a.ticket); assert.equal(result.deliverAllowed,true);
  assert.equal(count(f,'ai_usage_events',"status='success'"),1); assert.equal(count(f,'ai_conversation_messages'),2);
  assert.equal(count(f,'ai_quota_reservations',"status='consumed'"),1);
  assert.equal(count(f,'mini_app_atomic_guards'),0);
  const replay=await f.complete(a.ticket);assert.equal(replay.replay,true);assert.equal(replay.deliverAllowed,false);
  const retry=await f.module.admit(a.actor,a.decision);assert.equal(retry.ok,false);assert.equal(retry.replay,true);
  for(let i=0;i<6;i++){const x=await f.admit();await f.complete(x.ticket);}
  assert.equal(count(f,'ai_conversation_messages'),10);
});
test('offline original 29→31 reproducer now yields30: legacy released A cannot count or save, late spend survives',async t=>{
  const f=fixture(t);successes(f,29);
  const a=await f.admit();assert.equal(a.ok,true);
  f.sqlite.prepare("UPDATE ai_quota_reservations SET status='released',completed_at=CURRENT_TIMESTAMP WHERE request_id=?").run(a.ticket.requestId);
  f.now+=301;f.clock=f.now;
  const b=await f.admit();assert.equal(b.ok,true);
  const late=await f.complete(a.ticket);assert.equal(late.deliverAllowed,false);
  const event=f.sqlite.prepare('SELECT * FROM ai_usage_events WHERE request_id=?').get(a.ticket.requestId);
  assert.equal(event.status,'failed');assert.equal(event.neurons_milli,351);
  assert.equal(count(f,'ai_conversation_messages'),0);
  assert.equal((await f.complete(b.ticket)).deliverAllowed,true);
  assert.equal(count(f,'ai_usage_events',"telegram_id=101 AND status='success'"),30);
  assert.equal(count(f,'ai_quota_reservations',"status='consumed'"),1);
});
test('concurrent last slot, separate module instances and same-operation replay admit at most one',async t=>{
  const f=fixture(t);successes(f,29);const p=await f.proof(),q=await f.proof(),other=createAiQuotaSettlement();
  const results=await Promise.all([f.module.admit(p.actor,p.decision),other.admit(q.actor,q.decision)]);
  assert.equal(results.filter(r=>r.ok).length,1);assert.equal(count(f,'ai_quota_reservations',"status='reserved'"),1);
  const winner=results.find(r=>r.ok);const owner=results[0].ok?f.module:other;
  await owner.settle(winner.ticket,{outcome:'success',answer:'Готово.',usage:{inputTokens:1,outputTokens:1}});
  assert.equal(count(f,'ai_usage_events',"telegram_id=101 AND status='success'"),30);
  assert.equal((await f.proof()).decision.reasonCode,'quota_exceeded');
});
test('fixed admission date survives UTC midnight and active owner cannot start a second window request',async t=>{
  const f=fixture(t);f.now=Math.floor(f.now/86400)*86400+86390;f.clock=f.now;
  const a=await f.admit();const admissionDay=day(f.now);f.now+=20;f.clock=f.now;
  const p=await f.proof();assert.equal(p.decision.reasonCode,'in_progress');
  assert.equal((await f.complete(a.ticket)).deliverAllowed,true);
  assert.equal(f.sqlite.prepare('SELECT usage_date FROM ai_usage_events WHERE request_id=?').get(a.ticket.requestId).usage_date,admissionDay);
});
test('expired unknown cleanup retains provisional budget before releasing and never permits late success',async t=>{
  const f=fixture(t),a=await f.admit();f.now+=301;f.clock=f.now;
  const b=await f.admit();assert.equal(b.ok,true);
  const expense=f.sqlite.prepare('SELECT status,neurons_milli FROM ai_usage_events WHERE request_id=?').get(a.ticket.requestId);
  assert.equal(expense.status,'failed');assert.equal(expense.neurons_milli,20_000);
  assert.equal((await f.complete(a.ticket)).deliverAllowed,false);
  assert.equal(count(f,'ai_usage_events',"status='success'"),0);
});
test('provider failure costs once; unknown provider outcome cannot restart with same verified operation',async t=>{
  const f=fixture(t),a=await f.admit();
  await f.module.settle(a.ticket,{outcome:'failed'});assert.equal(count(f,'ai_usage_events',"status='success'"),0);
  assert.equal(f.sqlite.prepare('SELECT bucket,neurons_milli FROM ai_usage_events WHERE request_id=?').get(a.ticket.requestId).neurons_milli,5000);
  const b=await f.admit();await f.module.settle(b.ticket,{outcome:'unknown'});
  assert.equal((await f.module.admit(b.actor,b.decision)).reason,'operation_already_seen');
  assert.equal((await f.complete(b.ticket)).deliverAllowed,false);
  assert.equal(count(f,'ai_usage_events',"status='success'"),0);assert.equal(count(f,'ai_conversation_messages'),0);
});
test('invalid or empty validated output still settles supplied actual expense without success or memory',async t=>{
  const f=fixture(t);
  for (const answer of ['', '<think>hidden</think>', 'x'.repeat(251)]) {
    const a=await f.admit();const r=await f.complete(a.ticket,{answer});assert.equal(r.deliverAllowed,false);
    assert.equal(f.sqlite.prepare('SELECT status,neurons_milli FROM ai_usage_events WHERE request_id=?').get(a.ticket.requestId).neurons_milli,351);
  }
  assert.equal(count(f,'ai_usage_events',"status='success'"),0);assert.equal(count(f,'ai_conversation_messages'),0);
  assert.equal(count(f,'ai_quota_reservations',"status='reserved'"),0);
});
test('configured response length and personal quota remain actual policy; no700-output or hardcoded30 reset',async t=>{
  const f=fixture(t);f.sqlite.exec('UPDATE ai_runtime_settings SET response_character_limit=1200,user_daily_success_limit=37');
  successes(f,30);const p=await f.proof();assert.equal(p.decision.quota.limit,37);
  const a=await f.module.admit(p.actor,p.decision);assert.equal(a.ok,true);
  assert.equal((await f.complete(a.ticket,{answer:'а'.repeat(701)})).deliverAllowed,true);
});
test('canonical active Dragon Preview keeps30 with runtime37 and cannot spend a31st success',async t=>{
  const f=fixture(t),start=f.now-5,end=start+604800,source='dragon_preview:v1.3.5-hotfix.1',time=n=>new Date(n*1000).toISOString().slice(0,19).replace('T',' ');
  f.sqlite.exec("UPDATE ai_runtime_settings SET user_daily_success_limit=37; INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(101,'free','system_default'); INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(101,'none','system_default')");
  f.sqlite.prepare(`INSERT INTO trial_grants(grant_id,telegram_id,subject_fingerprint,program_code,source_code,status,started_at,ends_at,retention_until,workflow_instance_id,workflow_state,granted_at,updated_at)
    VALUES(?,101,?,'dragon_preview',?,'active',?,?,?,?,'started',?,?)`)
    .run(crypto.randomUUID(),'a'.repeat(64),source,start,end,end+86400,'offline-ai-preview-'+(++sequence),start,start);
  f.sqlite.prepare('UPDATE user_plans SET source_code=?,effective_from=?,revision=revision+1 WHERE telegram_id=101').run(source,time(start));
  f.sqlite.prepare("UPDATE user_access_states SET access_state='trial',source_code=?,state_started_at=?,state_ends_at=?,revision=revision+1 WHERE telegram_id=101").run(source,time(start),time(end));
  f.sqlite.prepare("UPDATE user_access SET access_tier='trial',trial_used=1,trial_started_at=?,trial_ends_at=? WHERE telegram_id=101").run(time(start),time(end));
  successes(f,29);const a=await f.admit();assert.equal(a.actor.access.accessOverlay,'dragon_preview');assert.equal(a.decision.quota.limit,30);
  await f.complete(a.ticket);assert.equal((await f.proof()).decision.reasonCode,'quota_exceeded');
});
test('admin personal exemption retains its own provider pool; public/reserve budgets deny even with personal room',async t=>{
  const f=fixture(t);successes(f,50,900,day(f.now),'admin');
  const a=await f.admit(900);assert.equal(a.ok,true);await f.complete(a.ticket);
  f.sqlite.exec('UPDATE ai_runtime_settings SET admin_daily_neurons_milli=20000,public_daily_neurons_milli=20000');
  assert.equal((await f.proof(900)).decision.reasonCode,'provider_budget_exhausted');
  const b=await f.admit(101);await f.complete(b.ticket);assert.equal((await f.proof(101)).decision.reasonCode,'provider_budget_exhausted');
  f.sqlite.exec('UPDATE ai_runtime_settings SET public_daily_neurons_milli=8500000,reserve_daily_neurons_milli=1');
  f.sqlite.prepare("INSERT INTO ai_usage_events(request_id,telegram_id,usage_date,bucket,status,neurons_milli,error_code) VALUES(?,0,?,'reserve','failed',1,'provider_failed')").run('reserve-cost-0000001',day(f.now));
  assert.equal((await f.proof(101)).decision.reasonCode,'provider_budget_exhausted');
});
test('consent revoked immediately before success batch forbids delivery/history, anonymises actual cost',async t=>{
  const f=fixture(t),a=await f.admit();
  f.binding.beforeBatch=()=>f.sqlite.exec("UPDATE ai_user_consents SET revoked_at=CURRENT_TIMESTAMP WHERE telegram_id=101");
  const r=await f.complete(a.ticket);assert.equal(r.deliverAllowed,false);
  const event=f.sqlite.prepare('SELECT * FROM ai_usage_events WHERE request_id=?').get(a.ticket.requestId);
  assert.equal(event.telegram_id,0);assert.equal(event.status,'failed');assert.equal(event.neurons_milli,351);
  assert.equal(count(f,'ai_conversation_messages'),0);
});
test('blocked or recreated generation cannot save late output or attach expense to a new account',async t=>{
  const f=fixture(t),a=await f.admit();
  f.sqlite.exec("UPDATE users SET referral_code='new-generation-101',joined_at=datetime(joined_at,'+1 second') WHERE telegram_id=101");
  const r=await f.complete(a.ticket);assert.equal(r.deliverAllowed,false);
  assert.equal(f.sqlite.prepare('SELECT telegram_id FROM ai_usage_events WHERE request_id=?').get(a.ticket.requestId).telegram_id,0);
  assert.equal(count(f,'ai_conversation_messages'),0);
});
test('actual block or pending deletion activated after admission denies new success but settles cost',async t=>{
  for(const mode of ['block','deletion']) {
    const f=fixture(t),a=await f.admit();
    if(mode==='block') f.sqlite.exec('UPDATE users SET is_blocked=1 WHERE telegram_id=101');
    else f.sqlite.prepare("INSERT INTO privacy_deletion_requests(request_id,telegram_id,confirmation_token,status,expires_at) VALUES(?,101,?,'pending',datetime(?,'unixepoch'))")
      .run(crypto.randomUUID(),'delete-confirmation-'+(++sequence),f.now+300);
    assert.equal((await f.complete(a.ticket)).deliverAllowed,false);
    assert.equal(count(f,'ai_usage_events',"status='success'"),0);assert.equal(count(f,'ai_conversation_messages'),0);
    assert.equal(f.sqlite.prepare('SELECT neurons_milli FROM ai_usage_events WHERE request_id=?').get(a.ticket.requestId).neurons_milli,351);
  }
});
test('mid-batch history failure rolls back reservation CAS and success/cost, retry settles without another provider call',async t=>{
  const f=fixture(t),a=await f.admit();
  f.binding.failStatement=sql=>sql.includes("'assistant'");
  await assert.rejects(f.complete(a.ticket),/injected SQL failure/u);
  assert.equal(count(f,'ai_usage_events'),0);assert.equal(count(f,'ai_conversation_messages'),0);
  assert.equal(count(f,'ai_quota_reservations',"status='reserved'"),1);
  assert.equal((await f.complete(a.ticket)).deliverAllowed,true);
});
test('optional capability metadata missing after admission cannot suppress actual provider cost settlement',async t=>{
  const f=fixture(t),a=await f.admit();f.sqlite.exec('DROP TABLE feature_flags');
  const result=await f.complete(a.ticket);assert.equal(result.deliverAllowed,false);
  const expense=f.sqlite.prepare('SELECT status,neurons_milli FROM ai_usage_events WHERE request_id=?').get(a.ticket.requestId);
  assert.equal(expense.status,'failed');assert.equal(expense.neurons_milli,351);
  assert.equal(count(f,'ai_quota_reservations',"status='reserved'"),0);assert.equal(count(f,'ai_conversation_messages'),0);
});
test('lost response after COMMIT keeps success; settlement replay cannot refund or repeat delivery',async t=>{
  const f=fixture(t),a=await f.admit(),original=f.binding.batch.bind(f.binding);let lose=true;
  f.binding.batch=async statements=>{const result=await original(statements);if(lose){lose=false;throw Error('ambiguous delivery after COMMIT');}return result;};
  await assert.rejects(f.complete(a.ticket),/ambiguous delivery/u);
  assert.equal(count(f,'ai_usage_events',"status='success'"),1);
  const r=await f.complete(a.ticket);assert.equal(r.replay,true);assert.equal(r.deliverAllowed,false);
});
test('post-COMMIT revocation suppresses outbound answer while retaining committed success and actual expense',async t=>{
  const f=fixture(t),a=await f.admit(),original=f.binding.batch.bind(f.binding);
  f.binding.batch=async statements=>{const result=await original(statements);
    f.sqlite.exec("UPDATE ai_user_consents SET revoked_at=CURRENT_TIMESTAMP WHERE telegram_id=101");return result;};
  const result=await f.complete(a.ticket);assert.equal(result.deliverAllowed,false);assert.equal(Object.hasOwn(result,'answer'),false);
  assert.equal(count(f,'ai_usage_events',"status='success'"),1);
  assert.equal(f.sqlite.prepare('SELECT neurons_milli FROM ai_usage_events WHERE request_id=?').get(a.ticket.requestId).neurons_milli,351);
  assert.equal((await f.complete(a.ticket)).replay,true);
});

async function partner(f,{external=false}={}) {
  Object.assign(f.serverEnv,{AI_PARTNER_ENABLED:'true',AI_PARTNER_ROLLOUT_MODE:'admin',
    AI_PARTNER_PROVIDER_USER_ID_SECRET:'offline-provider-user-id-secret-at-least32characters',
    ...(external?{AI_PARTNER_EXTERNAL_PROVIDER_ENABLED:'true',DEEPSEEK_API_KEY:'offline-deepseek-secret-no-network-000'}:{})});
  f.sqlite.exec(`INSERT OR IGNORE INTO ai_partner_runtime_settings(id,updated_at) VALUES(1,${f.now}); UPDATE ai_partner_runtime_settings SET master_enabled=1,rollout_mode='admin',external_provider_enabled=${external?1:0};
    INSERT INTO admin_ai_chat_state(admin_telegram_id,active_model,external_consent_version,external_consented_at,updated_at)
    VALUES(900,'${external?'deepseek':'qwen'}','${external?AI_GATEWAY_PROVIDER_CONSENT_VERSION:''}',${external?f.now:'NULL'},${f.now});`);
  const factId=crypto.randomUUID(),generationId=crypto.randomUUID(),facts={title:'Проверенный оффер',payoutText:'1000 ₽'};
  f.sqlite.prepare(`INSERT INTO content_fact_sources(fact_source_id,source_key,visibility,owner_telegram_id,subject_type,subject_key,
    source_kind,source_version,snapshot_hash,facts_json,source_status,approved_by,approved_at,created_at,updated_at)
    VALUES(?,?,'private',900,'offer','offline-offer','admin_verified','offline-source-v1',?,?,'approved',900,?,?,?)`)
    .run(factId,'offline-fact-source-'+sequence,hash(canonical(facts)),JSON.stringify(facts),f.now,f.now,f.now);
  const bundle=await loadApprovedAiPartnerFactBundle({DB:f.binding},{actorTelegramId:900,ownerTelegramId:900,factSourceIds:[factId],generatedAt:f.now});
  const prompt='Создай спокойный пост по утверждённым данным.';
  f.sqlite.prepare(`INSERT INTO ai_generation_sessions(generation_id,generation_key,owner_telegram_id,draft_request_key,version_request_id,
    draft_type,model_alias,fact_source_ids_json,fact_bundle_hash,prompt_hash,request_fingerprint,generation_state,created_at,updated_at)
    VALUES(?,?,900,?,?,'telegram_post',?,?,?,?,?,'streaming',?,?)`)
    .run(generationId,'generation-key-'+generationId,'draft-key-'+generationId,'version-key-'+generationId,
      external?'deepseek_flash_dragon':'qwen_safe',JSON.stringify([factId]),bundle.bundleHash,hash(prompt),hash('fixed-request'),f.now,f.now);
  return {generationId,prompt,factId};
}
function partnerLedger(f,{n=1,owner=900,date=day(f.now),cost=0,status='success'}={}) {
  const cycle=Math.floor(f.now/2592000)*2592000;
  if(!f.sqlite.prepare('SELECT telegram_id FROM users WHERE telegram_id=?').get(owner))
    f.sqlite.prepare('INSERT INTO users(telegram_id,referral_code,accepted_terms) VALUES(?,?,1)').run(owner,'offline-owner-'+owner);
  for(let i=0;i<n;i++) {
    const id='closed-ledger-seed-'+(++sequence);
    f.sqlite.prepare("INSERT INTO ai_quota_reservations(request_id,telegram_id,usage_date,bucket,reserved_milli,status,completed_at) VALUES(?,?,?,'admin',1,'consumed',CURRENT_TIMESTAMP)").run(id,owner,date);
    f.sqlite.prepare(`INSERT INTO ai_gateway_budget_reservations(request_id,owner_telegram_id,usage_date,user_cycle_start_at,user_cycle_end_at,
      global_cycle_start_at,global_cycle_end_at,reserved_billed_tokens,reserved_cost_microusd,reservation_state,policy_version,pricing_version,created_at,completed_at)
      VALUES(?,?,?,?,?,?,?,10000,?,'consumed','2026-09-12.ai-partner-v1','2026-09-12.deepseek-v4.1-flash-peak-v1',?,?)`)
      .run(id,owner,date,cycle,cycle+2592000,cycle,cycle+2592000,cost,f.now,f.now);
    f.sqlite.prepare("INSERT INTO ai_usage_events(request_id,telegram_id,usage_date,bucket,status,error_code) VALUES(?,?,?,'admin',?,?)").run(id,owner,date,status,status==='success'?'':'provider_failed');
    if(cost) f.sqlite.prepare(`INSERT INTO ai_gateway_attempts(attempt_id,request_id,attempt_no,route_step,model_alias,provider_code,attempt_status,
      input_tokens,output_tokens,cost_microusd,latency_ms,error_code,created_at) VALUES(?,?,1,'primary','deepseek_flash_dragon','deepseek','success',10,10,?,1,'',?)`)
      .run(crypto.randomUUID(),id,cost,f.now);
  }
}
test('actual closed Partner producer preserves100/day900/cycle and consumes both existing ledgers exactly once',async t=>{
  const f=fixture(t),payload=await partner(f),a=await f.admit(900,'ai.partner_draft',{requestPayload:payload});
  assert.equal(a.ok,true);const ai=readResourceFacts(a.resource).ai;
  assert.equal(ai.quota.partnerDailyLimit,100);assert.equal(ai.quota.partnerCycleLimit,900);
  const attempt={attemptId:crypto.randomUUID(),attemptNo:1,routeStep:'primary',modelAlias:'qwen_safe',status:'success',inputTokens:10,outputTokens:10,latencyMs:1};
  assert.equal((await f.complete(a.ticket,{remember:false,attempts:[attempt]})).deliverAllowed,true);
  assert.equal(count(f,'ai_gateway_budget_reservations',"reservation_state='consumed'"),1);
  assert.equal(count(f,'ai_quota_reservations',"status='consumed'"),1);
  assert.equal(count(f,'ai_gateway_attempts'),1);assert.equal(count(f,'ai_gateway_usage_metadata'),1);
  assert.equal((await f.complete(a.ticket,{remember:false,attempts:[attempt]})).replay,true);
  assert.equal(count(f,'ai_gateway_attempts'),1);
});
test('null actual SDK budget aggregate never becomes a zero-spend snapshot or an admission',async t=>{
  const f=fixture(t),payload=await partner(f,{external:true}),p=await f.proof(900,'ai.partner_draft',{requestPayload:payload});
  assert.equal(p.decision.allowed,true);partnerLedger(f,{cost:2_000_000});
  const prepare=f.binding.prepare.bind(f.binding);let reads=0;
  f.binding.prepare=sql=>{const statement=prepare(sql);if(sql.includes('user_attempts AS (')) {
    const bind=statement.bind.bind(statement);statement.bind=(...params)=>{const bound=bind(...params);
      bound.first=async()=>{reads++;return null;};return bound;};}return statement;};
  await assert.rejects(f.proof(900,'ai.partner_draft',{requestPayload:payload}),/ai_usage_unavailable/u);
  await assert.rejects(f.module.admit(p.actor,p.decision),/ai_usage_unavailable/u);
  assert.equal(reads,2);assert.equal(count(f,'ai_quota_reservations'),1);
  assert.equal(count(f,'ai_gateway_budget_reservations'),1);assert.equal(count(f,'mini_app_atomic_guards'),0);
  assert.equal(f.sqlite.prepare('SELECT SUM(cost_microusd) AS cost FROM ai_gateway_attempts').get().cost,2_000_000);
});
test('failed actual SDK attempt read cannot drop prior expense; restored read settles a late real retry once',async t=>{
  const f=fixture(t),payload=await partner(f,{external:true}),a=await f.admit(900,'ai.partner_draft',{requestPayload:payload});
  const primary={attemptId:crypto.randomUUID(),attemptNo:1,routeStep:'primary',modelAlias:'deepseek_flash_dragon',status:'failed',inputTokens:10,outputTokens:10,latencyMs:1};
  await f.complete(a.ticket,{outcome:'failed',remember:false,attempts:[primary]});
  const retry={...primary,attemptId:crypto.randomUUID(),attemptNo:2,routeStep:'retry',inputTokens:20,outputTokens:20};
  const prepare=f.binding.prepare.bind(f.binding);let reads=0;
  f.binding.prepare=sql=>{const statement=prepare(sql);if(sql.includes('ORDER BY attempt_no, attempt_id')) {
    const bind=statement.bind.bind(statement);statement.bind=(...params)=>{const bound=bind(...params);
      bound.all=async()=>{reads++;return {success:false,results:[]};};return bound;};}return statement;};
  await assert.rejects(f.complete(a.ticket,{outcome:'failed',remember:false,attempts:[retry]}),/ai_usage_unavailable/u);
  assert.equal(reads,1);assert.equal(count(f,'ai_gateway_attempts'),1);
  assert.equal(f.sqlite.prepare('SELECT SUM(cost_microusd) AS cost FROM ai_gateway_attempts').get().cost,15);
  assert.equal(count(f,'ai_usage_events',"status='success'"),0);
  f.binding.prepare=prepare;
  assert.equal((await f.complete(a.ticket,{outcome:'failed',remember:false,attempts:[retry]})).deliverAllowed,false);
  assert.equal(count(f,'ai_gateway_attempts'),2);
  assert.equal(f.sqlite.prepare('SELECT SUM(cost_microusd) AS cost FROM ai_gateway_attempts').get().cost,45);
  await f.complete(a.ticket,{outcome:'failed',remember:false,attempts:[retry]});
  assert.equal(count(f,'ai_gateway_attempts'),2);assert.equal(count(f,'ai_quota_reservations',"status='released'"),1);
});
test('Partner late released reservation retains real external cost but neither ledger resurrects nor answer delivers',async t=>{
  const f=fixture(t),payload=await partner(f,{external:true}),a=await f.admit(900,'ai.partner_draft',{requestPayload:payload});
  f.sqlite.prepare("UPDATE ai_quota_reservations SET status='released',completed_at=CURRENT_TIMESTAMP WHERE request_id=?").run(a.ticket.requestId);
  f.sqlite.prepare("UPDATE ai_gateway_budget_reservations SET reservation_state='released',completed_at=? WHERE request_id=?").run(f.now,a.ticket.requestId);
  const attempt={attemptId:crypto.randomUUID(),attemptNo:1,routeStep:'primary',modelAlias:'deepseek_flash_dragon',status:'success',inputTokens:10,outputTokens:10,latencyMs:1};
  const result=await f.complete(a.ticket,{remember:false,attempts:[attempt]});assert.equal(result.deliverAllowed,false);
  assert.equal(count(f,'ai_usage_events',"status='success'"),0);
  assert.equal(f.sqlite.prepare('SELECT cost_microusd FROM ai_gateway_attempts').get().cost_microusd,15);
  assert.equal(count(f,'ai_gateway_budget_reservations',"reservation_state='released'"),1);
  assert.equal(count(f,'ai_conversation_messages'),0);
});
test('closed external route denies missing current consent or generation/fact confirmation',async t=>{
  const f=fixture(t),payload=await partner(f,{external:true});
  f.sqlite.exec('UPDATE admin_ai_chat_state SET external_revoked_at=unixepoch()');
  assert.equal((await f.proof(900,'ai.partner_draft',{requestPayload:payload})).decision.allowed,false);
  f.sqlite.exec('UPDATE admin_ai_chat_state SET external_revoked_at=NULL');
  assert.equal((await f.proof(900,'ai.partner_draft',{requestPayload:{prompt:payload.prompt}})).decision.allowed,false);
  assert.equal(count(f,'ai_quota_reservations'),0);
});
test('Partner real last daily and cycle slot serializes concurrent requests and closes at100/900',async t=>{
  const f=fixture(t),payload=await partner(f);
  partnerLedger(f,{n:99});partnerLedger(f,{n:800,date:day(f.now-86400)});
  const p=await f.proof(900,'ai.partner_draft',{requestPayload:payload}),q=await f.proof(900,'ai.partner_draft',{requestPayload:payload});
  assert.equal(p.decision.allowed,true);const other=createAiQuotaSettlement();
  const results=await Promise.all([f.module.admit(p.actor,p.decision),other.admit(q.actor,q.decision)]);
  assert.equal(results.filter(r=>r.ok).length,1);
  const winner=results.find(r=>r.ok),owner=results[0].ok?f.module:other;
  await owner.settle(winner.ticket,{outcome:'success',answer:'Готово.',usage:{inputTokens:10,outputTokens:10},
    attempts:[{attemptId:crypto.randomUUID(),attemptNo:1,routeStep:'primary',modelAlias:'qwen_safe',status:'success',inputTokens:10,outputTokens:10,latencyMs:1}]});
  assert.equal((await f.proof(900,'ai.partner_draft',{requestPayload:payload})).decision.reasonCode,'quota_exceeded');
  assert.equal(count(f,'ai_usage_events',"telegram_id=900 AND status='success'"),900);
});
test('Partner user2USD and global20USD existing ceilings reject further reservation without increasing either limit',async t=>{
  const user=fixture(t),userPayload=await partner(user,{external:true});
  partnerLedger(user,{cost:1_999_500});const up=await user.proof(900,'ai.partner_draft',{requestPayload:userPayload});
  assert.equal(up.decision.reasonCode,'provider_budget_exhausted');await assert.rejects(user.module.admit(up.actor,up.decision),/ai_admission_denied/u);
  assert.equal(count(user,'ai_quota_reservations',"status='reserved'"),0);
  const global=fixture(t),globalPayload=await partner(global,{external:true});
  for(let i=0;i<9;i++) partnerLedger(global,{owner:1000+i,cost:2_000_000});
  partnerLedger(global,{owner:1009,cost:1_999_500});
  const gp=await global.proof(900,'ai.partner_draft',{requestPayload:globalPayload});assert.equal(gp.decision.reasonCode,'provider_budget_exhausted');
  await assert.rejects(global.module.admit(gp.actor,gp.decision),/ai_admission_denied/u);assert.equal(count(global,'ai_quota_reservations',"status='reserved'"),0);
});
test('Partner actual token overrun is recorded truthfully; a lost lease remains released',async t=>{
  const f=fixture(t),payload=await partner(f,{external:true}),a=await f.admit(900,'ai.partner_draft',{requestPayload:payload});
  f.sqlite.prepare("UPDATE ai_quota_reservations SET status='released',completed_at=CURRENT_TIMESTAMP WHERE request_id=?").run(a.ticket.requestId);
  f.sqlite.prepare("UPDATE ai_gateway_budget_reservations SET reservation_state='released',completed_at=? WHERE request_id=?").run(f.now,a.ticket.requestId);
  const attempt={attemptId:crypto.randomUUID(),attemptNo:1,routeStep:'primary',modelAlias:'deepseek_flash_dragon',status:'success',inputTokens:30000,outputTokens:2048,latencyMs:1};
  assert.equal((await f.complete(a.ticket,{attempts:[attempt],remember:false})).deliverAllowed,false);
  const cost=f.sqlite.prepare('SELECT input_tokens,output_tokens,cost_microusd FROM ai_gateway_attempts').get();
  assert.equal(cost.input_tokens,30000);assert.equal(cost.output_tokens,2048);assert.equal(cost.cost_microusd,11458);
});
test('Partner physical account deletion preserves anonymous actual expense and cannot revive the deleted owner',async t=>{
  const f=fixture(t),payload=await partner(f,{external:true}),a=await f.admit(900,'ai.partner_draft',{requestPayload:payload});
  // Actual old FK cascade; no fabricated tombstone or new metadata authority.
  f.sqlite.exec('DELETE FROM users WHERE telegram_id=900');
  const attempt={attemptId:crypto.randomUUID(),attemptNo:1,routeStep:'primary',modelAlias:'deepseek_flash_dragon',status:'success',inputTokens:10,outputTokens:10,latencyMs:1};
  const r=await f.complete(a.ticket,{attempts:[attempt],remember:false});assert.equal(r.deliverAllowed,false);
  assert.equal(count(f,'users','telegram_id=900'),0);assert.equal(count(f,'ai_gateway_budget_reservations'),0);
  assert.equal(f.sqlite.prepare('SELECT cost_microusd FROM ai_gateway_daily_aggregates').get().cost_microusd,15);
  assert.equal(f.sqlite.prepare('SELECT telegram_id,status FROM ai_usage_events WHERE request_id=?').get(a.ticket.requestId).telegram_id,0);
  await f.complete(a.ticket,{attempts:[attempt],remember:false});
  assert.equal(f.sqlite.prepare('SELECT cost_microusd FROM ai_gateway_daily_aggregates').get().cost_microusd,15);
});
test('unknown Partner outcome holds real budget, then late real attempt1 truthfully settles higher cost without success or retry',async t=>{
  const f=fixture(t),payload=await partner(f,{external:true}),a=await f.admit(900,'ai.partner_draft',{requestPayload:payload});
  await f.module.settle(a.ticket,{outcome:'unknown'});
  assert.equal(count(f,'ai_quota_reservations',"status='released'"),1);
  assert.equal(count(f,'ai_gateway_budget_reservations',"reservation_state='reserved'"),1);
  assert.equal(count(f,'ai_gateway_attempts'),0);assert.equal(count(f,'ai_gateway_usage_metadata'),0);
  assert.equal((await f.module.admit(a.actor,a.decision)).reason,'operation_already_seen');
  assert.equal((await f.proof(900,'ai.partner_draft',{requestPayload:payload})).decision.reasonCode,'in_progress');
  const attempt={attemptId:crypto.randomUUID(),attemptNo:1,routeStep:'primary',modelAlias:'deepseek_flash_dragon',status:'success',
    inputTokens:30000,outputTokens:2048,latencyMs:1};
  const result=await f.complete(a.ticket,{remember:false,attempts:[attempt]});assert.equal(result.deliverAllowed,false);
  assert.equal(f.sqlite.prepare('SELECT cost_microusd FROM ai_gateway_attempts').get().cost_microusd,11458);
  assert.equal(count(f,'ai_gateway_budget_reservations',"reservation_state='released'"),1);
  assert.equal(count(f,'ai_usage_events',"status='success'"),0);
  await f.complete(a.ticket,{remember:false,attempts:[attempt]});assert.equal(count(f,'ai_gateway_attempts'),1);
});
test('Partner truthful cost above old2USD attempt CHECK is aggregated once and closes owner admission for current cycle',async t=>{
  const f=fixture(t),payload=await partner(f,{external:true}),a=await f.admit(900,'ai.partner_draft',{requestPayload:payload});
  const attempt={attemptId:crypto.randomUUID(),attemptNo:1,routeStep:'primary',modelAlias:'deepseek_flash_dragon',status:'success',
    inputTokens:10_000_000,outputTokens:10_000_000,latencyMs:1};
  const result=await f.complete(a.ticket,{remember:false,attempts:[attempt]});assert.equal(result.deliverAllowed,false);
  assert.equal(count(f,'ai_gateway_attempts'),0);assert.equal(count(f,'ai_gateway_usage_metadata'),0);
  assert.equal(f.sqlite.prepare('SELECT cost_microusd FROM ai_gateway_daily_aggregates').get().cost_microusd,15_000_000);
  assert.equal(count(f,'ai_quota_reservations',"status='released'"),1);assert.equal(count(f,'ai_gateway_budget_reservations',"reservation_state='released'"),1);
  assert.equal((await f.proof(900,'ai.partner_draft',{requestPayload:payload})).decision.reasonCode,'provider_budget_exhausted');
  await f.complete(a.ticket,{remember:false,attempts:[attempt]});
  assert.equal(f.sqlite.prepare('SELECT cost_microusd FROM ai_gateway_daily_aggregates').get().cost_microusd,15_000_000);
  await assert.rejects(f.complete(a.ticket,{remember:false,attempts:[{...attempt,outputTokens:9_000_000}]}));
  assert.equal(f.sqlite.prepare('SELECT cost_microusd FROM ai_gateway_daily_aggregates').get().cost_microusd,15_000_000);
});
test('Partner attempt cost, successful usage, both CAS rows and metadata belong to one atomic batch',async t=>{
  const f=fixture(t),payload=await partner(f,{external:true}),a=await f.admit(900,'ai.partner_draft',{requestPayload:payload});
  const original=f.binding.batch.bind(f.binding),batches=[];
  f.binding.batch=async statements=>{batches.push(statements.map(s=>s.sql));return original(statements);};
  const attempt={attemptId:crypto.randomUUID(),attemptNo:1,routeStep:'primary',modelAlias:'deepseek_flash_dragon',status:'success',inputTokens:10,outputTokens:10,latencyMs:1};
  assert.equal((await f.complete(a.ticket,{remember:false,attempts:[attempt]})).deliverAllowed,true);
  assert.equal(batches.length,1);
  for(const needle of ['INSERT OR IGNORE INTO ai_gateway_attempts','INSERT INTO ai_usage_events','UPDATE ai_quota_reservations',
    'UPDATE ai_gateway_budget_reservations','INSERT OR IGNORE INTO ai_gateway_usage_metadata'])assert.ok(batches[0].some(sql=>sql.includes(needle)),needle);
});
test('physical owner deletion at exact settlement batch edge preserves actual cost and denies result',async t=>{
  const f=fixture(t),payload=await partner(f,{external:true}),a=await f.admit(900,'ai.partner_draft',{requestPayload:payload});
  f.binding.beforeBatch=()=>f.sqlite.exec('DELETE FROM users WHERE telegram_id=900');
  const attempt={attemptId:crypto.randomUUID(),attemptNo:1,routeStep:'primary',modelAlias:'deepseek_flash_dragon',status:'success',inputTokens:10,outputTokens:10,latencyMs:1};
  assert.equal((await f.complete(a.ticket,{remember:false,attempts:[attempt]})).deliverAllowed,false);
  assert.equal(count(f,'users','telegram_id=900'),0);assert.equal(count(f,'ai_gateway_attempts'),0);
  assert.equal(f.sqlite.prepare('SELECT cost_microusd FROM ai_gateway_daily_aggregates').get().cost_microusd,15);
  assert.equal(count(f,'ai_usage_events',"status='success'"),0);assert.equal(count(f,'ai_conversation_messages'),0);
});
test('anonymous late real retry has its own immutable receipt and adds expense once after owner deletion',async t=>{
  const f=fixture(t),payload=await partner(f,{external:true}),a=await f.admit(900,'ai.partner_draft',{requestPayload:payload});
  f.sqlite.exec('DELETE FROM users WHERE telegram_id=900');
  const first={attemptId:crypto.randomUUID(),attemptNo:1,routeStep:'primary',modelAlias:'deepseek_flash_dragon',status:'failed',inputTokens:10,outputTokens:10,latencyMs:1};
  await f.module.settle(a.ticket,{outcome:'failed',attempts:[first],usage:{inputTokens:10,outputTokens:10}});
  const second={...first,attemptId:crypto.randomUUID(),attemptNo:2,routeStep:'retry',status:'success',inputTokens:20,outputTokens:20};
  await f.complete(a.ticket,{remember:false,attempts:[second]});
  assert.equal(f.sqlite.prepare('SELECT SUM(cost_microusd) AS cost FROM ai_gateway_daily_aggregates').get().cost,45);
  await f.complete(a.ticket,{remember:false,attempts:[second]});
  assert.equal(f.sqlite.prepare('SELECT SUM(cost_microusd) AS cost FROM ai_gateway_daily_aggregates').get().cost,45);
  await assert.rejects(f.complete(a.ticket,{remember:false,attempts:[{...second,inputTokens:30}]}));
  assert.equal(f.sqlite.prepare('SELECT SUM(cost_microusd) AS cost FROM ai_gateway_daily_aggregates').get().cost,45);
});
