import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {loadApprovedAiPartnerFactBundle} from '../src/v1.3.8/ai-partner-draft-runtime.mjs';
import {createAiPartnerProviderTransports} from '../src/v1.3.8/ai-partner-provider-transports.mjs';
import {createAiRecoveryExecutor} from '../src/v1.4.1/ai-recovery-journal.mjs';
import {foundationFixture} from './helpers/v1.4.1-fixtures.mjs';
import {beginPublicAiExecution,invokePublicAi,completePublicAi,assertAiDeliveryFresh,failPublicAi,runAuthorizedAiPartnerGateway} from '../src/v1.4.1/ai-runtime.mjs';

let seq=0;
function fixture(t){const f=foundationFixture(t);f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  f.serverEnv.V141_AUTHORIZATION_ENABLED='true';
  f.clock=f.now;f.sqlite.function('unixepoch',()=>f.clock);
  f.sqlite.exec(`INSERT OR IGNORE INTO ai_runtime_settings(id) VALUES(1);UPDATE ai_runtime_settings SET rollout_mode='all';
    UPDATE user_access SET ai_enabled=1;INSERT INTO ai_user_consents(telegram_id,consent_version,consented_at)
    SELECT telegram_id,'1.3.0-2026-08-27',CURRENT_TIMESTAMP FROM users;`);
  f.calls=0;f.serverEnv.AI={run:async()=>{f.calls++;return {response:'Откройте меню.',usage:{prompt_tokens:10,completion_tokens:10}};}};
  f.contextFor=()=>f.context(101,'ai.public_chat','mini_app',{idempotencyKey:'runtime-ai-operation-'+String(++seq).padStart(8,'0'),requestPayload:{prompt:'Как пользоваться ботом?'}});
  f.request={messages:[{role:'system',content:'Помогай пользоваться ботом.'},{role:'user',content:'Как пользоваться ботом?\n/no_think'}],max_tokens:192,temperature:0.4,top_p:0.85,repetition_penalty:1.05};return f;
}
test('enabled actual public executor durably claims one transport, settles receipt with count/history and fresh last-slot delivery',async t=>{
  const f=fixture(t),date=new Date(f.now*1000).toISOString().slice(0,10);
  for(let i=0;i<29;i++)f.sqlite.prepare("INSERT INTO ai_usage_events(request_id,telegram_id,usage_date,bucket,status,neurons_milli)VALUES(?,101,?,'public','success',1)").run('runtime-prior-'+i,date);
  const e=await beginPublicAiExecution(f.serverEnv,await f.contextFor());
  const raw=await invokePublicAi(e,f.request);assert.equal(raw.response,'Откройте меню.');
  const result=await completePublicAi(e,{answer:raw.response,remember:true});assert.equal(result.deliverAllowed,true);
  assert.equal(await assertAiDeliveryFresh(e),true);assert.equal(f.calls,1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ai_usage_events WHERE telegram_id=101 AND status='success'").get().n,30);
  assert.equal(f.sqlite.prepare('SELECT state FROM ai_operation_journal').get().state,'terminal_succeeded');
  assert.equal(f.sqlite.prepare('SELECT expense_location FROM ai_operation_receipts').get().expense_location,'owned');
  assert.equal((await completePublicAi(e,{answer:'Снова'})).deliverAllowed,false);assert.equal(f.calls,1);
});
test('failed durable provider-start claim never invokes the actual transport',async t=>{
  const f=fixture(t),e=await beginPublicAiExecution(f.serverEnv,await f.contextFor());
  const original=f.binding.batch.bind(f.binding);
  f.binding.batch=async statements=>statements.some(s=>s.sql?.includes('active_attempt_no=?'))?statements.map(()=>({success:false,results:[]})):original(statements);
  await assert.rejects(invokePublicAi(e,f.request));assert.equal(f.calls,0);
});
test('real provider reply followed by consent revocation preserves actual expense and suppresses memory/delivery',async t=>{
  const f=fixture(t),e=await beginPublicAiExecution(f.serverEnv,await f.contextFor());
  const raw=await invokePublicAi(e,f.request);
  f.sqlite.exec("UPDATE ai_user_consents SET revoked_at=CURRENT_TIMESTAMP WHERE telegram_id=101");
  const r=await completePublicAi(e,{answer:raw.response,remember:true});assert.equal(r.deliverAllowed,false);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ai_conversation_messages').get().n,0);
  assert.equal(f.sqlite.prepare("SELECT neurons_milli FROM ai_usage_events WHERE status='failed'").get().neurons_milli,351);
  assert.equal(f.sqlite.prepare('SELECT state FROM ai_operation_journal').get().state,'terminal_failed');
});

const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>value&&typeof value==='object'&&!Array.isArray(value)?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':Array.isArray(value)?'['+value.map(canonical).join(',')+']':JSON.stringify(value);
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
    .run(factId,'offline-fact-source-'+seq,hash(canonical(facts)),JSON.stringify(facts),f.now,f.now,f.now);
  const bundle=await loadApprovedAiPartnerFactBundle({DB:f.binding},{actorTelegramId:900,ownerTelegramId:900,factSourceIds:[factId],generatedAt:f.now});
  const prompt='Создай спокойный пост по утверждённым данным.';
  f.sqlite.prepare(`INSERT INTO ai_generation_sessions(generation_id,generation_key,owner_telegram_id,draft_request_key,version_request_id,
    draft_type,model_alias,fact_source_ids_json,fact_bundle_hash,prompt_hash,request_fingerprint,generation_state,created_at,updated_at)
    VALUES(?,?,900,?,?,'telegram_post',?,?,?,?,?,'streaming',?,?)`)
    .run(generationId,'generation-key-'+generationId,'draft-key-'+generationId,'version-key-'+generationId,
      external?'deepseek_flash_dragon':'qwen_safe',JSON.stringify([factId]),bundle.bundleHash,hash(prompt),hash('fixed-request'),f.now,f.now);
  return {generationId,prompt,factId};
}

test('enabled closed Partner uses actual transport receipt and both canonical terminal ledgers',async t=>{
  const f=fixture(t),payload=await partner(f);
  const context=await f.context(900,'ai.partner_draft','mini_app',{idempotencyKey:'runtime-partner-operation-00000001',requestPayload:payload});
  const result=await runAuthorizedAiPartnerGateway({env:f.serverEnv,context,
    request:{payload:{messages:[{role:'user',content:payload.prompt}]},maxOutputTokens:192,sourceCount:1},
    transports:createAiPartnerProviderTransports(f.serverEnv),validateOutput:async content=>({validated:{content},template:{content}})});
  assert.equal(result.ok,true);assert.equal(f.calls,1);
  assert.equal(f.sqlite.prepare('SELECT reservation_state FROM ai_gateway_budget_reservations').get().reservation_state,'consumed');
  assert.equal(f.sqlite.prepare('SELECT state FROM ai_operation_journal').get().state,'terminal_succeeded');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ai_gateway_attempts').get().n,1);
});
test('restart recovers durable pending actual public receipt as cost only without calling provider again',async t=>{
  const f=fixture(t),e=await beginPublicAiExecution(f.serverEnv,await f.contextFor());
  await invokePublicAi(e,f.request);
  const requestId=f.sqlite.prepare('SELECT request_id FROM ai_operation_journal').get().request_id;
  const result=await createAiRecoveryExecutor({binding:f.binding,env:f.serverEnv}).run({requestId});
  assert.equal(result.outcome,'failed');assert.equal(f.calls,1);
  assert.equal(f.sqlite.prepare('SELECT state FROM ai_operation_journal').get().state,'terminal_failed');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ai_conversation_messages').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT neurons_milli FROM ai_usage_events').get().neurons_milli,351);
  const replay=await createAiRecoveryExecutor({binding:f.binding,env:f.serverEnv}).run({requestId});assert.equal(replay.appliedReceipts,0);assert.equal(f.calls,1);
});
