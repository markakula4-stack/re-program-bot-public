// Shared isolated D1/SQLite proof. All actors, authentication and transports are
// fictional; this helper imports no Node APIs and never calls a real service.
import {createCustomerContext,readTrustedContext} from '../../src/v1.4.1/trusted-context.mjs';
import {CAPABILITY_CATALOG,PLAN_CAPABILITIES,canonicalPolicyJson} from '../../src/v1.4.1/capability-policy.mjs';
import {beginPublicAiExecution,invokePublicAi,completePublicAi,assertAiDeliveryFresh,runAuthorizedAiPartnerGateway} from '../../src/v1.4.1/ai-runtime.mjs';
import {createAiRecoveryExecutor,loadAiJournalBudgetObligations} from '../../src/v1.4.1/ai-recovery-journal.mjs';
import {prepareV141PrivacyDeletion} from '../../src/v1.4.1/privacy-maintenance.mjs';
import {loadApprovedAiPartnerFactBundle} from '../../src/v1.3.8/ai-partner-draft-runtime.mjs';
import {createAiPartnerProviderTransports} from '../../src/v1.3.8/ai-partner-provider-transports.mjs';
import {AI_GATEWAY_PROVIDER_CONSENT_VERSION} from '../../src/v1.3.8/ai-partner-gateway.mjs';

const PUBLIC_ACTOR=910014101,PARTNER_ACTOR=910014103,REPLACEMENT_OWNER=910014109;
const BOT_TOKEN='14105001:fictional_ai_probe_token_no_real_bot_000000';
const PROMPT='Как пользоваться ботом?';
const bytes=new TextEncoder();
const hex=buffer=>Array.from(new Uint8Array(buffer),n=>n.toString(16).padStart(2,'0')).join('');
const hash=async text=>hex(await crypto.subtle.digest('SHA-256',bytes.encode(text)));
const ensure=(ok,code)=>{if(!ok)throw Object.assign(new Error('p05_ai_'+code),{code:'p05_ai_'+code});};
async function hmac(key,value){const k=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);return crypto.subtle.sign('HMAC',k,bytes.encode(value));}
async function initData(actor,now,key){const data={auth_date:String(now),query_id:'p05_ai_'+key,user:JSON.stringify({id:actor,first_name:'Fictional AI probe'})};
  const check=Object.entries(data).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+'='+v).join('\n');
  const secret=await hmac(bytes.encode('WebAppData'),BOT_TOKEN);return new URLSearchParams({...data,hash:hex(await hmac(secret,check))}).toString();}
async function checkedBatch(db,statements){const result=await db.batch(statements);ensure(Array.isArray(result)&&result.length===statements.length&&result.every(r=>r?.success===true),'fixture_batch_unverified');return result;}
async function all(db,sql,args=[]){const r=await db.prepare(sql).bind(...args).all();ensure(r?.success===true&&Array.isArray(r.results),'read_unavailable');return r.results;}
async function first(db,sql,args=[]){const rows=await all(db,sql,args);ensure(rows.length===1,'expected_one_row');return rows[0];}
const publicRequest=()=>({messages:[{role:'system',content:'Помогай пользоваться ботом.'},{role:'user',content:PROMPT+'\n/no_think'}],max_tokens:192,temperature:0.4,top_p:0.85,repetition_penalty:1.05});

async function seed(db,now){
  // Fixed catalog rows are the reviewed foundation; no grants/roles are inferred
  // from supplied payload. The sole admin is an explicitly fictional actor.
  const catalogCounts=await first(db,'SELECT (SELECT COUNT(*) FROM capability_catalog) capabilities,(SELECT COUNT(*) FROM plan_capabilities) plans');
  for(const [table,rows,count] of [['capability_catalog',CAPABILITY_CATALOG,catalogCounts.capabilities],['plan_capabilities',PLAN_CAPABILITIES,catalogCounts.plans]]) {
    ensure(count===0||count===rows.length,'fixture_catalog_count');
    if(count===rows.length)continue;
    for(let offset=0;offset<rows.length;offset+=40)await checkedBatch(db,rows.slice(offset,offset+40).map(row=>{const keys=Object.keys(row);return db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')}) ON CONFLICT DO NOTHING`).bind(...keys.map(k=>row[k]));}));
  }
  await checkedBatch(db,[PUBLIC_ACTOR,PARTNER_ACTOR,REPLACEMENT_OWNER].flatMap(id=>[
    db.prepare('INSERT INTO users(telegram_id,referral_code,accepted_terms) VALUES(?,?,1)').bind(id,'p05_fictional_'+id),
    db.prepare("INSERT INTO user_roles(telegram_id,role,status) VALUES(?,'user','active')").bind(id),
    db.prepare("INSERT INTO user_access(telegram_id,access_tier,ai_enabled) VALUES(?,'free',1)").bind(id),
    db.prepare("INSERT INTO ai_user_consents(telegram_id,consent_version,consented_at) VALUES(?,'1.3.0-2026-08-27',CURRENT_TIMESTAMP)").bind(id),
  ]).concat([
    db.prepare("INSERT INTO user_roles(telegram_id,role,status) VALUES(?,'admin','active')").bind(PARTNER_ACTOR),
    db.prepare('INSERT OR IGNORE INTO ai_runtime_settings(id) VALUES(1)'),
    db.prepare("UPDATE ai_runtime_settings SET rollout_mode='all' WHERE id=1"),
    db.prepare('INSERT OR IGNORE INTO ai_partner_runtime_settings(id,updated_at) VALUES(1,?)').bind(now),
    db.prepare("UPDATE ai_partner_runtime_settings SET master_enabled=1,rollout_mode='admin',external_provider_enabled=1 WHERE id=1"),
    db.prepare("INSERT INTO admin_ai_chat_state(admin_telegram_id,active_model,external_consent_version,external_consented_at,updated_at) VALUES(?,'qwen','',NULL,?)").bind(PARTNER_ACTOR,now),
  ]));
}
async function partnerPayload(db,now,prompt,external){
  const factId=crypto.randomUUID(),generationId=crypto.randomUUID(),facts={title:'Fictional approved offer',payoutText:'1000 fictional units'};
  await checkedBatch(db,[db.prepare(`INSERT INTO content_fact_sources(fact_source_id,source_key,visibility,owner_telegram_id,subject_type,subject_key,
    source_kind,source_version,snapshot_hash,facts_json,source_status,approved_by,approved_at,created_at,updated_at)
    VALUES(?,?,'private',?,'offer',?,'admin_verified','p05-fictional-v1',?,?,'approved',?,?,?,?)`)
    .bind(factId,'p05_ai_fact_'+factId,PARTNER_ACTOR,'p05_fictional_offer_'+factId,await hash(canonicalPolicyJson(facts)),JSON.stringify(facts),PARTNER_ACTOR,now,now,now),
    db.prepare('UPDATE admin_ai_chat_state SET active_model=?,external_consent_version=?,external_consented_at=?,updated_at=? WHERE admin_telegram_id=?')
      .bind(external?'deepseek':'qwen',external?AI_GATEWAY_PROVIDER_CONSENT_VERSION:'',external?now:null,now,PARTNER_ACTOR)]);
  const bundle=await loadApprovedAiPartnerFactBundle({DB:db},{actorTelegramId:PARTNER_ACTOR,ownerTelegramId:PARTNER_ACTOR,factSourceIds:[factId],generatedAt:now});
  await checkedBatch(db,[db.prepare(`INSERT INTO ai_generation_sessions(generation_id,generation_key,owner_telegram_id,draft_request_key,version_request_id,
    draft_type,model_alias,fact_source_ids_json,fact_bundle_hash,prompt_hash,request_fingerprint,generation_state,created_at,updated_at)
    VALUES(?,?,?,?,?,'telegram_post',?,?,?,?,?,'streaming',?,?)`).bind(generationId,'p05_generation_'+generationId,PARTNER_ACTOR,
      'p05_draft_'+generationId,'p05_version_'+generationId,external?'deepseek_flash_dragon':'qwen_safe',JSON.stringify([factId]),
      bundle.bundleHash,await hash(prompt),await hash('p05 fixed '+generationId),now,now)]);
  return {generationId,prompt};
}
async function confirmedDeletion(db,env,now){
  // This is a fictional former administrator. The existing real deletion guard
  // still blocks active administrators; demotion is explicit fixture setup.
  const requestId=crypto.randomUUID();
  await checkedBatch(db,[db.prepare("DELETE FROM user_roles WHERE telegram_id=? AND role='admin'").bind(PARTNER_ACTOR),
    db.prepare("INSERT INTO privacy_deletion_requests(request_id,telegram_id,confirmation_token,status,summary_json,expires_at) VALUES(?,?,?,'pending','{}',datetime(?,'unixepoch'))")
      .bind(requestId,PARTNER_ACTOR,crypto.randomUUID(),now+300)]);
  const deletionEnv={...env,ADMIN_ID:String(REPLACEMENT_OWNER),OWNER_TELEGRAM_ID:String(REPLACEMENT_OWNER)};
  const plan=await prepareV141PrivacyDeletion(deletionEnv,PARTNER_ACTOR,requestId);
  await checkedBatch(db,[...plan.prefix,
    db.prepare('DELETE FROM ai_quota_reservations WHERE telegram_id=?').bind(PARTNER_ACTOR),
    db.prepare('DELETE FROM ai_usage_events WHERE telegram_id=?').bind(PARTNER_ACTOR),
    db.prepare('DELETE FROM user_roles WHERE telegram_id=?').bind(PARTNER_ACTOR),
    db.prepare('DELETE FROM user_access WHERE telegram_id=?').bind(PARTNER_ACTOR),
    db.prepare('DELETE FROM users WHERE telegram_id=?').bind(PARTNER_ACTOR),
    db.prepare("UPDATE privacy_deletion_requests SET telegram_id=NULL,status='completed',completed_at=CURRENT_TIMESTAMP,confirmation_token=request_id,summary_json='{}' WHERE request_id=? AND telegram_id=? AND status='pending'")
      .bind(requestId,PARTNER_ACTOR),...plan.suffix]);
  return deletionEnv;
}

// Native probes call these fixed phases sequentially on the same isolated DB.
// Stable operation identities are the existing root context derivation, not a
// new fixture state table, receipt or authority backfill.
export const P05_AI_PHASES=Object.freeze(['seed_public','partner_known','partner_unknown','privacy_recovery']);
const operationId=key=>hash('v1.4.1.operation\nhttp:14105001:'+PARTNER_ACTOR+':ai.partner_draft:'+key);

export async function runP05AiScenarios({binding,env,phase='all'}={}) {
  ensure(env?.V141_P05_ISOLATED_PROBE==='true','isolated_probe_required');
  ensure(binding?.withSession&&binding?.prepare&&binding?.batch,'d1_binding_required');
  ensure(phase==='all'||P05_AI_PHASES.includes(phase),'phase_invalid');
  if(phase==='all') {
    const stages=[];for(const fixedPhase of P05_AI_PHASES)stages.push(await runP05AiScenarios({binding,env,phase:fixedPhase}));
    return Object.freeze({version:'p05-ai-native-2',fictionalActorsOnly:true,syntheticTransportsOnly:true,
      public:stages[0].public,partnerKnown:stages[3].partnerKnown,
      unknown:{...stages[3].unknown,providerCalls:stages[1].providerCalls+stages[2].providerCalls,replayProviderCalls:stages[2].replayProviderCalls},
      privacy:stages[3].privacy});
  }
  const now=Math.floor(Date.now()/1000);let qwenCalls=0,externalCalls=0;
  const probeEnv={...env,DB:binding,BOT_TOKEN,REBUILD_V140_BOT_ID:'14105001',ADMIN_ID:String(PARTNER_ACTOR),OWNER_TELEGRAM_ID:String(PARTNER_ACTOR),
    V141_AUTHORIZATION_ENABLED:'true',FEATURE_RE_AI_SHELL:'true',AI_PARTNER_ENABLED:'true',AI_PARTNER_ROLLOUT_MODE:'admin',
    AI_PARTNER_EXTERNAL_PROVIDER_ENABLED:'true',AI_PARTNER_PROVIDER_USER_ID_SECRET:'p05-fictional-provider-user-secret-at-least32',
    DEEPSEEK_API_KEY:'p05-fictional-deepseek-key-no-real-provider',
    AI:{async run(){qwenCalls++;return {response:'Fictional validated answer.',usage:{prompt_tokens:10,completion_tokens:10}};}}};
  const context=async(actor,operation,key,payload)=>createCustomerContext({binding,env:probeEnv,
    initData:await initData(actor,now,key),nowSeconds:now,operation,channel:'mini_app',idempotencyKey:key,requestPayload:payload});
  const knownId=await operationId('p05-ai-partner-known-0001'),unknownId=await operationId('p05-ai-partner-unknown-0001');
  if(phase==='seed_public') {
    await seed(binding,now);
    const publicContext=await context(PUBLIC_ACTOR,'ai.public_chat','p05-ai-public-success-0001',{prompt:PROMPT});
    const execution=await beginPublicAiExecution(probeEnv,publicContext),raw=await invokePublicAi(execution,publicRequest());
    const complete=await completePublicAi(execution,{answer:raw.response,remember:true});await assertAiDeliveryFresh(execution);
    const publicJournal=await first(binding,'SELECT state,attempted_count FROM ai_operation_journal WHERE request_id=?',[readTrustedContext(publicContext).operationId]);
    ensure(complete.outcome==='success'&&complete.deliverAllowed&&publicJournal.state==='terminal_succeeded'&&publicJournal.attempted_count===1&&qwenCalls===1,'public_success');
    return Object.freeze({phase,public:{state:publicJournal.state,attemptedCount:publicJournal.attempted_count,providerCalls:qwenCalls}});
  }
  const partnerFetch=async()=>{externalCalls++;if(phase==='partner_unknown')throw new Error('fictional ambiguous network termination');
    return Response.json({choices:[{finish_reason:'stop',message:{content:'Fictional external validated answer.'}}],usage:{prompt_tokens:10,completion_tokens:10,prompt_cache_hit_tokens:0}});};
  const transports=createAiPartnerProviderTransports(probeEnv,{fetchImpl:partnerFetch});
  const partnerRequest=payload=>({payload:{messages:[{role:'user',content:payload.prompt}]},maxOutputTokens:192,sourceCount:1});
  const validateOutput=async content=>({validated:{content},template:{content}});
  if(phase==='partner_known') {
    const payload=await partnerPayload(binding,now,'Создай проверенный вымышленный пост.',true);
    const ctx=await context(PARTNER_ACTOR,'ai.partner_draft','p05-ai-partner-known-0001',payload);
    const known=await runAuthorizedAiPartnerGateway({env:probeEnv,context:ctx,request:partnerRequest(payload),transports,validateOutput});
    ensure(known.ok===true&&readTrustedContext(ctx).operationId===knownId&&externalCalls===1,'partner_known');
    // Fixture releases the presentation slot without inventing a persisted
    // completed draft/version. The actual gateway's cost/success is untouched.
    await checkedBatch(binding,[binding.prepare("UPDATE ai_generation_sessions SET generation_state='failed',failure_code='p05_fixture_closed',revision=revision+1,updated_at=MAX(updated_at,?) WHERE generation_id=? AND generation_state='streaming'").bind(now,payload.generationId)]);
    const receipt=await first(binding,'SELECT cost_microusd,expense_location FROM ai_operation_receipts WHERE request_id=?',[knownId]);
    ensure(receipt.cost_microusd===15&&receipt.expense_location==='owned','known_owned_receipt');
    return Object.freeze({phase,providerCalls:externalCalls,costMicrousd:receipt.cost_microusd,expenseLocation:receipt.expense_location});
  }
  if(phase==='partner_unknown') {
    const payload=await partnerPayload(binding,now,'Создай второй проверенный вымышленный пост.',true);
    const ctx=await context(PARTNER_ACTOR,'ai.partner_draft','p05-ai-partner-unknown-0001',payload);let ambiguousError;
    try{await runAuthorizedAiPartnerGateway({env:probeEnv,context:ctx,request:partnerRequest(payload),transports,validateOutput});}
    catch(error){ambiguousError=error.code;await error.aiRecovery;}
    const held=await first(binding,"SELECT j.state,b.reservation_state FROM ai_operation_journal j JOIN ai_gateway_budget_reservations b ON b.request_id=j.request_id WHERE j.request_id=?",[unknownId]);
    const restart=await createAiRecoveryExecutor({binding,env:probeEnv}).run({requestId:unknownId});
    ensure(ambiguousError&&held.state==='unknown'&&held.reservation_state==='reserved'&&restart.outcome==='unknown','unknown_restart_hold');
    try{await runAuthorizedAiPartnerGateway({env:probeEnv,context:ctx,request:partnerRequest(payload),transports,validateOutput});}catch{}
    ensure(externalCalls===1,'no_provider_replay');
    return Object.freeze({phase,providerCalls:externalCalls,replayProviderCalls:0,state:held.state,restartOutcome:restart.outcome});
  }
  const before=await first(binding,"SELECT j.state,j.global_cycle_start_at,b.reservation_state,b.reserved_cost_microusd,b.reserved_billed_tokens FROM ai_operation_journal j JOIN ai_gateway_budget_reservations b ON b.request_id=j.request_id WHERE j.request_id=?",[unknownId]);
  ensure(before.state==='unknown'&&before.reservation_state==='reserved','privacy_unknown_source');
  const deletionEnv=await confirmedDeletion(binding,probeEnv,now);
  const transferred=await all(binding,'SELECT request_id,state,subject_telegram_id,account_generation_hash,settlement_kind,reserved_cost_microusd FROM ai_operation_journal WHERE request_id IN (?,?) ORDER BY request_id',[knownId,unknownId]);
  const expense=await first(binding,'SELECT cost_microusd,expense_location FROM ai_operation_receipts WHERE request_id=?',[knownId]);
  const aggregate=await first(binding,'SELECT COALESCE(SUM(cost_microusd),0) cost FROM ai_gateway_daily_aggregates');
  const deleted=await first(binding,'SELECT COUNT(*) n FROM users WHERE telegram_id=?',[PARTNER_ACTOR]);
  const obligations=await loadAiJournalBudgetObligations(binding,{namespace:'partner',usageDate:new Date(now*1000).toISOString().slice(0,10),bucket:'admin',cycleStart:before.global_cycle_start_at,subjectId:REPLACEMENT_OWNER,accountGenerationHash:'0'.repeat(64)});
  ensure(deleted.n===0&&transferred.length===2&&transferred.every(r=>r.subject_telegram_id===null&&r.account_generation_hash===null&&r.settlement_kind==='anonymous'),'identity_transfer');
  ensure(expense.expense_location==='anonymous'&&expense.cost_microusd>0&&aggregate.cost===expense.cost_microusd,'known_expense_transfer');
  ensure(transferred.find(r=>r.request_id===unknownId).state==='unknown'&&obligations.globalCost===before.reserved_cost_microusd&&obligations.globalTokens===before.reserved_billed_tokens,'anonymous_unknown_hold');
  const recovery=await createAiRecoveryExecutor({binding,env:deletionEnv}).run({requestId:unknownId});
  ensure(recovery.outcome==='unknown'&&externalCalls===0&&qwenCalls===0,'anonymous_no_replay');
  return Object.freeze({phase,providerCalls:0,partnerKnown:{costMicrousd:expense.cost_microusd,expenseLocation:expense.expense_location},
    unknown:{state:before.state,restartOutcome:'unknown',anonymousRestartOutcome:recovery.outcome,heldCostMicrousd:obligations.globalCost,heldTokens:obligations.globalTokens},
    privacy:{subjectDeleted:true,anonymousJournalCount:transferred.length,aggregateCostMicrousd:aggregate.cost}});
}
