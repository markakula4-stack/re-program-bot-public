import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {foundationFixture} from './helpers/v1.4.1-fixtures.mjs';
import {runP05AiScenarios} from './helpers/v1.4.1-p05-ai-scenarios.mjs';
import {beginPublicAiExecution,invokePublicAi} from '../src/v1.4.1/ai-runtime.mjs';
import {drainRuntimeAiRecovery} from '../src/v1.4.1/service-runtime.mjs';
import {prepareV141PrivacyDeletion} from '../src/v1.4.1/privacy-maintenance.mjs';
import {loadAiJournalBudgetObligations} from '../src/v1.4.1/ai-recovery-journal.mjs';
import {V141_RELEASE_CONFIG_GLOBAL,materializeV141ReleaseEnv} from '../src/v1.4.1/release-config.mjs';

test('compiled recovery settles a deleted-owner pending receipt, preserves anonymous unknown hold, and invokes no provider',async t=>{
  const f=foundationFixture(t);
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  // Reuse the actual already-reviewed executors/privacy fixture to create an
  // anonymous Partner unknown obligation. Every transport is fictional.
  await runP05AiScenarios({binding:f.binding,env:{...f.serverEnv,V141_P05_ISOLATED_PROBE:'true'}});
  const unknown=f.sqlite.prepare("SELECT request_id,global_cycle_start_at,usage_date,reserved_cost_microusd,reserved_billed_tokens FROM ai_operation_journal WHERE namespace='partner' AND state='unknown'").get();
  assert.ok(unknown);
  let setupProviderCalls=0;
  f.serverEnv={...f.serverEnv,DB:f.binding,V141_AUTHORIZATION_ENABLED:'true',FEATURE_RE_AI_SHELL:'true',
    AI:{async run(){setupProviderCalls++;return {response:'Проверенный ответ.',usage:{prompt_tokens:10,completion_tokens:10}};}}};
  f.sqlite.exec(`UPDATE user_access SET ai_enabled=1 WHERE telegram_id=101;
    INSERT INTO ai_user_consents(telegram_id,consent_version,consented_at) VALUES(101,'1.3.0-2026-08-27',CURRENT_TIMESTAMP)`);
  const context=await f.context(101,'ai.public_chat','mini_app',{idempotencyKey:'rollback-pending-public-0001',requestPayload:{prompt:'Как пользоваться ботом?'}});
  const execution=await beginPublicAiExecution(f.serverEnv,context);
  await invokePublicAi(execution,{messages:[{role:'system',content:'Помогай пользоваться ботом.'},
    {role:'user',content:'Как пользоваться ботом?\n/no_think'}],max_tokens:192,temperature:0.4,top_p:0.85,repetition_penalty:1.05});
  assert.equal(setupProviderCalls,1);
  const pending=f.sqlite.prepare("SELECT j.request_id,j.expires_at FROM ai_operation_journal j JOIN ai_operation_receipts r ON r.request_id=j.request_id WHERE j.namespace='public' AND r.expense_location='pending'").get();
  assert.ok(pending);
  const deletionId=crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO privacy_deletion_requests(request_id,telegram_id,confirmation_token,status,summary_json,expires_at)
    VALUES(?,101,?,'pending','{}',datetime(?,'unixepoch'))`).run(deletionId,crypto.randomUUID(),f.now+300);
  const deletion=await prepareV141PrivacyDeletion(f.serverEnv,101,deletionId);
  await f.binding.batch([...deletion.prefix,
    f.binding.prepare('DELETE FROM ai_quota_reservations WHERE telegram_id=101'),
    f.binding.prepare('DELETE FROM ai_usage_events WHERE telegram_id=101'),
    f.binding.prepare('DELETE FROM user_roles WHERE telegram_id=101'),
    f.binding.prepare('DELETE FROM user_access WHERE telegram_id=101'),
    f.binding.prepare('DELETE FROM users WHERE telegram_id=101'),
    f.binding.prepare("UPDATE privacy_deletion_requests SET telegram_id=NULL,status='completed',completed_at=CURRENT_TIMESTAMP,confirmation_token=request_id,summary_json='{}' WHERE request_id=? AND telegram_id=101 AND status='pending'").bind(deletionId),...deletion.suffix]);
  assert.equal(f.sqlite.prepare('SELECT subject_telegram_id FROM ai_operation_journal WHERE request_id=?').get(pending.request_id).subject_telegram_id,null);
  assert.equal(f.sqlite.prepare('SELECT expense_location FROM ai_operation_receipts WHERE request_id=?').get(pending.request_id).expense_location,'pending');

  const originalConfig=globalThis[V141_RELEASE_CONFIG_GLOBAL],originalClock=Date.now;
  t.after(()=>{Date.now=originalClock;if(originalConfig===undefined)delete globalThis[V141_RELEASE_CONFIG_GLOBAL];else globalThis[V141_RELEASE_CONFIG_GLOBAL]=originalConfig;});
  const recoveryClock=pending.expires_at+1;
  Date.now=()=>recoveryClock*1000;f.sqlite.function('unixepoch',()=>recoveryClock);
  const compiled={V141_RELEASE_MODE:'recovery',V141_SOURCE_SHA:'a'.repeat(40),
    V141_AUTHORIZATION_ENABLED:'false',V141_LEGACY_COMPATIBILITY_ENABLED:'false'};
  let recoveryProviderCalls=0;
  const raw={...f.serverEnv,AI:{async run(){recoveryProviderCalls++;throw new Error('provider forbidden in rollback recovery');}},
    AI_PARTNER_ENABLED:'true',AI_PARTNER_OWNER_GENERATION_ENABLED:'true',AI_PARTNER_EXTERNAL_PROVIDER_ENABLED:'true'};
  const obligations=()=>loadAiJournalBudgetObligations(f.binding,{namespace:'partner',usageDate:unknown.usage_date,bucket:'admin',
    cycleStart:unknown.global_cycle_start_at,subjectId:900,accountGenerationHash:'0'.repeat(64)});
  const before=await obligations();
  // A physical override cannot open a service while compiled mode is off.
  delete globalThis[V141_RELEASE_CONFIG_GLOBAL];
  const attemptedOverride={...raw,...compiled,FEATURE_RE_AI_SHELL:'false',AI_PARTNER_ENABLED:'false',
    AI_PARTNER_OWNER_GENERATION_ENABLED:'false',AI_PARTNER_EXTERNAL_PROVIDER_ENABLED:'false'};
  assert.equal((await drainRuntimeAiRecovery(attemptedOverride)).status,'closed');
  globalThis[V141_RELEASE_CONFIG_GLOBAL]=compiled;
  const env=materializeV141ReleaseEnv(raw);
  assert.equal(env.V141_AUTHORIZATION_ENABLED,'false');
  assert.equal((await drainRuntimeAiRecovery({...env,AI_PARTNER_ENABLED:'true'})).status,'closed');
  const result=await drainRuntimeAiRecovery(env);
  assert.equal(result.outcome,'failed');assert.equal(result.appliedReceipts,1);assert.equal(result.deliverAllowed,false);
  assert.equal(recoveryProviderCalls,0);
  const expense=f.sqlite.prepare('SELECT status,telegram_id,neurons_milli FROM ai_usage_events WHERE request_id=?').get(pending.request_id);
  assert.equal(expense.status,'failed');assert.equal(expense.telegram_id,0);assert.equal(expense.neurons_milli,351);
  assert.equal(f.sqlite.prepare('SELECT state FROM ai_operation_journal WHERE request_id=?').get(pending.request_id).state,'terminal_failed');
  assert.equal(f.sqlite.prepare('SELECT expense_location FROM ai_operation_receipts WHERE request_id=?').get(pending.request_id).expense_location,'anonymous');
  assert.equal(f.sqlite.prepare('SELECT state FROM ai_operation_journal WHERE request_id=?').get(unknown.request_id).state,'unknown');
  const after=await obligations();assert.equal(after.globalCost,before.globalCost);assert.equal(after.globalTokens,before.globalTokens);
  assert.equal(after.globalCost,unknown.reserved_cost_microusd);assert.equal(after.globalTokens,unknown.reserved_billed_tokens);
  assert.equal((await drainRuntimeAiRecovery(env)).status,'idle');assert.equal(recoveryProviderCalls,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM ai_conversation_messages WHERE telegram_id=101').get().n,0);
  assert.equal(env.V141_AUTHORIZATION_ENABLED,'false','the service scope never escapes into the materialized provider env');
});
