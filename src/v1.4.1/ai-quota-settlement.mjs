import { readTrustedContext, isTrustedContext, compileContextAssertions } from './trusted-context.mjs';
import { createAuthorityResolver, isTrustedActor, readActorFacts, readActorContext,
  compileAuthorityAssertions } from './authority-resolver.mjs';
import { isTrustedDecision, readDecisionFacts, readDecisionContext,
  compileDecisionAssertions } from './entitlement-engine.mjs';
import { readAiPartnerConfig, AI_PARTNER_POLICY_VERSION, createProviderScopedUserId } from '../v1.3.8/ai-partner-foundation.mjs';
import { loadApprovedAiPartnerFactBundle } from '../v1.3.8/ai-partner-draft-runtime.mjs';
import { createAiGatewayBudgetProfile, calculateAiGatewayReservation, createVerifiedAdminGatewayContext,
  reserveAiGatewayBudget, calculateAiGatewayCostMicrousd, AI_GATEWAY_PROVIDER_CONSENT_VERSION,
  AI_GATEWAY_HARD_LIMITS, summarizeAiGatewayAttempts, getAiGatewayBudgetSnapshot } from '../v1.3.8/ai-partner-gateway.mjs';
import { AI_PARTNER_DEEPSEEK_FLASH_PRICING } from '../v1.3.8/ai-partner-provider-transports.mjs';
import { listAiPartnerOwnerDraftFormats } from '../v1.3.8/ai-partner-owner-generation-core-part2.mjs';
import { compileAiJournalAdmission, loadAiJournalSettlement, compileAiJournalSettlement, loadAiJournalBudgetObligations } from './ai-recovery-journal.mjs';

// Isolated server executor. Part4 owns routing; this module never invokes a
// model, Telegram, a grant writer, or a payment/role mutation.
export const AI_QUOTA_RUNTIME_WIRED = false;
export const AI_QUOTA_SETTLEMENT_VERSION = '2026-10-02.v1.4.1.p03';
const CONSENT_VERSION = '1.3.0-2026-08-27';
const MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
const RESERVATION = 20_000, FAILED_ESTIMATE = 5_000, LEASE_SECONDS = 300;
const tickets = new WeakMap(), quotaProofs = new WeakMap();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const integer = (n, max = 10_000_000) => {
  if (!Number.isSafeInteger(n) || n < 0 || n > max) fail('invalid_ai_usage');
  return n;
};
const frozen = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
};
const commit=async(db,statements)=>{const result=await db.batch(statements);if(!Array.isArray(result)||result.length!==statements.length||result.some(r=>r?.success!==true))fail('ai_commit_unverified');return result;};
const dateAt = at => new Date(at * 1000).toISOString().slice(0, 10);
const sha256 = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(text))),byte=>byte.toString(16).padStart(2,'0')).join('');
const enabled = value => !['false','0','off','no'].includes(String(value ?? 'true').toLowerCase());
const consentValid = row => row?.consent_version === CONSENT_VERSION && Boolean(row.consented_at) && !row.revoked_at;
const publicWhere = "NOT EXISTS(SELECT 1 FROM ai_gateway_budget_reservations b WHERE b.request_id=u.request_id)";
const positivePolicy = row => row && ['public_daily_neurons_milli','admin_daily_neurons_milli',
  'reserve_daily_neurons_milli','user_daily_success_limit','response_character_limit'].every(key =>
  Number.isSafeInteger(row[key]) && row[key] > 0);
const strictReads = db => ({prepare(sql) {return {bind(...params) {
  const statement=db.prepare(sql).bind(...params);
  return {async first() {const row=await statement.first();if(!row || typeof row!=='object')fail('ai_usage_unavailable');return row;},
    async all() {const result=await statement.all();if(result?.success!==true || !Array.isArray(result.results))fail('ai_usage_unavailable');return result;}};
}};}});

function promptSafe(value) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value.trim()).length > 700) return false;
  const text = value.toLowerCase().replaceAll('ё','е').replace(/[‐‑‒–—−]/gu,'-').replace(/\s+/gu,' ').trim();
  if (/(?:^|\D)(?:\d[ -]?){13,19}(?:\D|$)/u.test(text) ||
      /(?:cvv|cvc|код\s*(?:из\s*)?(?:смс|sms)|паспорт(?:ные)?\s*(?:данные|номер)?)[^\d]{0,24}\d{3,}/iu.test(text)) return false;
  return ![/игнорир\S*.{0,50}(?:инструкц|правил|ограничен|системн)/u,
    /(?:покаж|раскро|вывед)\S*.{0,50}(?:системн|скрыт).{0,25}(?:промпт|инструкц|правил)/u,
    /(?:отключ|обойд|сним)\S*.{0,40}(?:защит|фильтр|ограничен|правил)/u,
    /(?:отвечай|работай|действуй).{0,30}без (?:встроенн\S* )?(?:правил|ограничен\S*)/u,
    /(?:будь|стань|притворись).{0,50}(?:друг\S* (?:ии|ai)|(?:ии|ai).{0,20}без ограничен)/u,
    /ignore.{0,30}(?:previous|system|developer).{0,30}instructions?/u,
    /(?:reveal|show|print).{0,25}(?:system prompt|hidden instructions?)/u,
    /(?:enable|enter|activate).{0,20}(?:developer mode|jailbreak|dan mode)/u,
    /(?:bypass|disable).{0,25}(?:safety|guardrail|filter|restriction)/u,
    /you are now.{0,50}(?:unrestricted|developer|dan)/u].some(pattern => pattern.test(text));
}
const safeAnswer = (value, limit) => {
  if (typeof value !== 'string') fail('invalid_ai_answer');
  const answer = value.replace(/<think>[\s\S]*?<\/think>/giu,'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu,'').trim();
  if (!answer || Array.from(answer).length > limit) fail('invalid_ai_answer');
  return answer;
};
const jsonExpression = names => names.length <= 10
  ? `json_object(${names.map(name => `'${name}',${name}`).join(',')})`
  : `json_patch(${jsonExpression(names.slice(0,10))},${jsonExpression(names.slice(10))})`;

async function loadRow(db, table, where, params, checks) {
  // Tables/columns are selected by this module, never by a caller.
  const columns = table === 'ai_generation_sessions'
    ? ['generation_id','owner_telegram_id','draft_type','model_alias','fact_source_ids_json','fact_bundle_hash','prompt_hash','generation_state','created_at','updated_at','revision']
    : table === 'ai_partner_runtime_settings'
    ? ['id','rollout_mode','master_enabled','external_provider_enabled','dragon_daily_burst_limit',
      'dragon_cycle_success_limit','user_cycle_cost_ceiling_microusd','global_cycle_cost_ceiling_microusd',
      'pilot_user_limit','policy_version','updated_at']
    : ['admin_telegram_id','active_model','external_consent_version','external_consented_at','external_revoked_at','updated_at'];
  const sql = `SELECT ${jsonExpression(columns)} AS snapshot FROM ${table} WHERE ${where}`;
  const response = await db.prepare(sql).bind(...params).all();
  if (response?.success !== true || !Array.isArray(response.results) || response.results.length > 1) fail('ai_settings_unavailable');
  const snapshot = response.results[0]?.snapshot ?? null;
  checks.push({ sql:`(${sql}) IS ?`, params:[...params,snapshot] });
  return snapshot === null ? null : JSON.parse(snapshot);
}

// Canonical, read-only factual producer for the resource resolver. It does not
// assert prepared source/DLP context, authorise a provider, or manufacture a can().
export async function loadAiQuotaFacts(actor) {
  if (!isTrustedActor(actor)) fail('untrusted_actor');
  const context = readActorContext(actor), identity = readTrustedContext(context), facts = readActorFacts(actor);
  const { db, nowSeconds:at, telegramId:id } = identity, settings = facts.ai?.settings;
  if (!positivePolicy(settings)) fail('ai_settings_unavailable');
  const namespace = identity.operation === 'ai.partner_draft' ? 'partner' : 'public';
  const usageDate = dateAt(at), admin = facts.canonicalOwner === true;
  const checks = [], prompt = identity.requestPayload?.prompt ?? identity.requestPayload?.text;
  const row = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM ai_usage_events u WHERE u.telegram_id=? AND u.usage_date=? AND u.request_id!=? AND u.status='success' AND ${publicWhere}) AS used,
    (SELECT COUNT(*) FROM ai_quota_reservations q WHERE telegram_id=? AND request_id!=? AND status='reserved' AND
      (CAST(strftime('%s',created_at) AS INTEGER)+300>? OR EXISTS(SELECT 1 FROM ai_gateway_budget_reservations b WHERE b.request_id=q.request_id))) AS active,
    (SELECT COALESCE(SUM(neurons_milli),0) FROM ai_usage_events WHERE usage_date=? AND bucket=?) AS spent,
    (SELECT COALESCE(SUM(reserved_milli),0) FROM ai_quota_reservations q WHERE usage_date=? AND bucket=? AND request_id!=? AND status='reserved'
      AND NOT EXISTS(SELECT 1 FROM ai_gateway_budget_reservations b WHERE b.request_id=q.request_id)) AS held,
    (SELECT COALESCE(SUM(neurons_milli),0) FROM ai_usage_events WHERE usage_date=? AND bucket='reserve') AS reserveSpent,
    EXISTS(SELECT 1 FROM ai_usage_events WHERE request_id=? AND status='success') AS ownSuccess`)
    .bind(id,usageDate,identity.operationId??'',id,identity.operationId??'',at,usageDate,admin?'admin':'public',
      usageDate,admin?'admin':'public',identity.operationId??'',usageDate,identity.operationId??'').first();
  if (!row || Object.values(row).some(value=>!Number.isSafeInteger(value)||value<0) || row.ownSuccess>1) fail('ai_usage_unavailable');
  const personalLimit = facts.access?.accessOverlay === 'dragon_preview' || facts.access?.effectivePlan === 'preview'
    ? 30 : settings.user_daily_success_limit;
  const limit = admin ? settings.admin_daily_neurons_milli : settings.public_daily_neurons_milli;
  const dto = {namespace,rolloutAllowed:settings.rollout_mode==='all' || settings.rollout_mode==='admin' && admin,
    masterEnabled:enabled(identity.env.FEATURE_RE_AI_SHELL),schemaReady:true,
    consentValid:consentValid(facts.ai?.consent),toggleEnabled:facts.ai?.enabledPreference===true,
    modelAllowed:settings.model_name===MODEL,dlpPassed:promptSafe(prompt),
    confirmationSatisfied:consentValid(facts.ai?.consent),closedOwnerMatches:admin,
    inFlight:row.active>0,providerBudgetAvailable:row.spent+row.held+(row.ownSuccess?0:RESERVATION)<=limit && row.reserveSpent<settings.reserve_daily_neurons_milli,
    costCeilingAllowed:row.spent+row.held+(row.ownSuccess?0:RESERVATION)<=limit,
    quota:{publicSuccessUsed:row.used,publicSuccessLimit:personalLimit,resetsAt:(Math.floor(at/86400)+1)*86400}};
  const journalObligations=identity.env.V141_AUTHORIZATION_ENABLED==='true'?await loadAiJournalBudgetObligations(db,{namespace,usageDate,bucket:admin?'admin':'public',
    cycleStart:Math.floor(at/AI_GATEWAY_HARD_LIMITS.cycleSeconds)*AI_GATEWAY_HARD_LIMITS.cycleSeconds,subjectId:id,
    accountGenerationHash:facts.account.accountFingerprint,excludeRequestId:identity.operationId??''}):{globalCost:0,globalTokens:0,userCost:0,userTokens:0,neurons:0,inFlight:false,overflow:false};
  if(journalObligations.assertion)checks.push(journalObligations.assertion);
  dto.inFlight=dto.inFlight||journalObligations.inFlight;
  if(namespace==='public'){dto.providerBudgetAvailable=dto.providerBudgetAvailable&&row.spent+row.held+journalObligations.neurons+(row.ownSuccess?0:RESERVATION)<=limit;dto.costCeilingAllowed=dto.providerBudgetAvailable;}
  let profile = null, partnerSettings = null, chatState = null, config = null, generation = null, sizing = null;
  if (namespace === 'partner') {
    partnerSettings = await loadRow(db,'ai_partner_runtime_settings','id=1',[],checks);
    chatState = await loadRow(db,'admin_ai_chat_state','admin_telegram_id=?',[id],checks);
    config = readAiPartnerConfig(identity.env);
    const generationId = identity.requestPayload?.generationId;
    if (typeof generationId==='string' && /^[0-9a-f-]{36}$/u.test(generationId)) {
      generation=await loadRow(db,'ai_generation_sessions','generation_id=? AND owner_telegram_id=?',[generationId,id],checks);
    }
    let approvedFacts=false;
    if (generation && ['streaming','finalizing'].includes(generation.generation_state) && generation.created_at<=at && at-generation.created_at<600) {
      try {
        const ids=JSON.parse(generation.fact_source_ids_json);
        const bundle=await loadApprovedAiPartnerFactBundle({DB:db},{actorTelegramId:id,ownerTelegramId:id,factSourceIds:ids,generatedAt:at});
        approvedFacts=bundle.bundleHash===generation.fact_bundle_hash && generation.prompt_hash===await sha256(prompt);
        const format=listAiPartnerOwnerDraftFormats().find(row=>row.draftType===generation.draft_type);
        if (format) sizing={estimatedInputTokens:Math.max(32,Math.min(AI_GATEWAY_HARD_LIMITS.maxInputTokens,
          // Conservative fixed current owner-template envelope, plus real
          // canonical prompt/facts. No client/model option can lower this hold.
          4096+new TextEncoder().encode(prompt+JSON.stringify(bundle.sources)).length)),maxOutputTokens:format.maxOutputTokens};
        for (const factId of ids) {
          const sql=`SELECT json_object('fact_source_id',fact_source_id,'snapshot_hash',snapshot_hash,'facts_json',facts_json,
            'source_status',source_status,'approved_at',approved_at,'owner_telegram_id',owner_telegram_id,'visibility',visibility)
            FROM content_fact_sources WHERE fact_source_id=?`;
          const snapshot=await db.prepare(sql).bind(factId).first();
          checks.push({sql:`(${sql}) IS ?`,params:[factId,Object.values(snapshot)[0]]});
        }
      } catch {approvedFacts=false;}
    }
    if (partnerSettings) profile = createAiGatewayBudgetProfile({pricing:AI_PARTNER_DEEPSEEK_FLASH_PRICING,
      dailySuccessLimit:Math.min(config.dailyBurst,partnerSettings.dragon_daily_burst_limit),
      cycleSuccessLimit:Math.min(config.cycleSuccess,partnerSettings.dragon_cycle_success_limit),
      pilotUsers:Math.min(config.pilotUsers,partnerSettings.pilot_user_limit),
      userCostCeilingMicrousd:Math.min(config.userCostCeilingMicrousd,partnerSettings.user_cycle_cost_ceiling_microusd),
      globalCostCeilingMicrousd:Math.min(config.globalCostCeilingMicrousd,partnerSettings.global_cycle_cost_ceiling_microusd)});
    const cycleStart = Math.floor(at/AI_GATEWAY_HARD_LIMITS.cycleSeconds)*AI_GATEWAY_HARD_LIMITS.cycleSeconds;
    const counts = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM ai_usage_events u JOIN ai_gateway_budget_reservations b ON b.request_id=u.request_id
       WHERE b.owner_telegram_id=? AND u.usage_date=? AND u.request_id!=? AND u.status='success') AS daily,
      (SELECT COUNT(*) FROM ai_usage_events u JOIN ai_gateway_budget_reservations b ON b.request_id=u.request_id
       WHERE b.owner_telegram_id=? AND b.user_cycle_start_at=? AND u.request_id!=? AND u.status='success') AS cycle`)
      .bind(id,usageDate,identity.operationId??'',id,cycleStart,identity.operationId??'').first();
    if(!counts || !Number.isSafeInteger(counts.daily)||counts.daily<0 || !Number.isSafeInteger(counts.cycle)||counts.cycle<0)fail('ai_usage_unavailable');
    const externalAllowed=chatState?.active_model==='deepseek' && config.externalProviderEnabled && partnerSettings?.external_provider_enabled===1 &&
      chatState.external_consent_version===AI_GATEWAY_PROVIDER_CONSENT_VERSION && chatState.external_consented_at>0 && !chatState.external_revoked_at;
    const modelAllowed=chatState?.active_model==='qwen' && generation?.model_alias==='qwen_safe' ||
      externalAllowed && generation?.model_alias==='deepseek_flash_dragon';
    let partnerBudgetAvailable=false;
    if (admin && profile && sizing) {
      const gatewayContext=createVerifiedAdminGatewayContext({actorTelegramId:id,isAdmin:true,purpose:'admin_chat',at,
        userCycleStartAt:cycleStart,userCycleEndAt:cycleStart+AI_GATEWAY_HARD_LIMITS.cycleSeconds,
        globalCycleStartAt:cycleStart,globalCycleEndAt:cycleStart+AI_GATEWAY_HARD_LIMITS.cycleSeconds,dataClass:'private',cacheAllowed:false});
      const budget=await getAiGatewayBudgetSnapshot(strictReads(db),{context:gatewayContext,profile});
      for (const [key,value] of Object.entries(budget)) if (key!=='usageDate' && key!=='profile' &&
          (!Number.isSafeInteger(value) || value<0)) fail('ai_usage_unavailable');
      const reservation=calculateAiGatewayReservation({...sizing,pricing:profile.pricing,externalPrimary:generation?.model_alias==='deepseek_flash_dragon'});
      const own=await db.prepare(`SELECT
        COALESCE((SELECT MAX(reserved_billed_tokens-COALESCE((SELECT SUM(input_tokens+output_tokens) FROM ai_gateway_attempts a WHERE a.request_id=b.request_id),0),0)
          FROM ai_gateway_budget_reservations b WHERE b.request_id=? AND b.reservation_state='reserved'),0) AS tokens,
        COALESCE((SELECT MAX(reserved_cost_microusd-COALESCE((SELECT SUM(cost_microusd) FROM ai_gateway_attempts a WHERE a.request_id=b.request_id),0),0)
          FROM ai_gateway_budget_reservations b WHERE b.request_id=? AND b.reservation_state='reserved'),0) AS cost`)
        .bind(identity.operationId??'',identity.operationId??'').first();
      if(!own || !Number.isSafeInteger(own.tokens)||own.tokens<0 || !Number.isSafeInteger(own.cost)||own.cost<0)fail('ai_usage_unavailable');
      const additionalTokens=row.ownSuccess?0:reservation.reservedBilledTokens;
      const additionalCost=row.ownSuccess?0:reservation.reservedCostMicrousd;
      const anonymous=await db.prepare('SELECT COALESCE(SUM(cost_microusd),0) AS cost,COALESCE(SUM(input_tokens+output_tokens),0) AS tokens FROM ai_gateway_daily_aggregates WHERE usage_date>=? AND usage_date<?')
        .bind(dateAt(cycleStart),dateAt(cycleStart+AI_GATEWAY_HARD_LIMITS.cycleSeconds)).first();
      if (!anonymous || !Number.isSafeInteger(anonymous.cost) || anonymous.cost<0 || !Number.isSafeInteger(anonymous.tokens) || anonymous.tokens<0) fail('ai_usage_unavailable');
      const enrolled=await db.prepare('SELECT request_id FROM ai_gateway_budget_reservations WHERE owner_telegram_id=? AND global_cycle_start_at=? LIMIT 1').bind(id,cycleStart).first();
      const heldRequest=await db.prepare("SELECT request_id FROM ai_gateway_budget_reservations WHERE owner_telegram_id=? AND request_id!=? AND reservation_state='reserved' LIMIT 1").bind(id,identity.operationId??'').first();
      const overflowBarrier=await db.prepare(`SELECT b.request_id FROM ai_gateway_budget_reservations b JOIN ai_usage_events u ON u.request_id=b.request_id
        WHERE b.owner_telegram_id=? AND b.user_cycle_start_at=? AND u.status='failed' AND u.error_code='provider_cost_overflow' LIMIT 1`).bind(id,cycleStart).first();
      dto.inFlight=dto.inFlight || heldRequest!==null;
      partnerBudgetAvailable=overflowBarrier===null && !journalObligations.overflow && budget.pricingMismatches===0 && (enrolled!==null || budget.pilotUsers<profile.pilotUsers) &&
        budget.userBilledTokens+budget.userReservedTokens-own.tokens+journalObligations.userTokens+additionalTokens<=profile.userTokenCeiling &&
        budget.globalBilledTokens+budget.globalReservedTokens-own.tokens+anonymous.tokens+journalObligations.globalTokens+additionalTokens<=profile.globalTokenCeiling &&
        budget.userCostMicrousd+budget.userReservedCostMicrousd-own.cost+journalObligations.userCost+additionalCost<=profile.userCostCeilingMicrousd &&
        budget.globalCostMicrousd+budget.globalReservedCostMicrousd-own.cost+anonymous.cost+journalObligations.globalCost+additionalCost<=profile.globalCostCeilingMicrousd;
    }
    Object.assign(dto,{rolloutAllowed:admin && config.masterEnabled && partnerSettings?.master_enabled===1 && partnerSettings.rollout_mode==='admin',
      masterEnabled:config.masterEnabled,modelAllowed,
      schemaReady:typeof identity.env.AI_PARTNER_PROVIDER_USER_ID_SECRET==='string' && identity.env.AI_PARTNER_PROVIDER_USER_ID_SECRET.length>=32,
      confirmationSatisfied:modelAllowed && approvedFacts && consentValid(facts.ai?.consent),
      providerBudgetAvailable:partnerBudgetAvailable,costCeilingAllowed:partnerBudgetAvailable,
      quota:{...dto.quota,partnerDailyUsed:counts.daily,partnerDailyLimit:profile?.dailySuccessLimit ?? 0,
        partnerCycleUsed:counts.cycle,partnerCycleLimit:profile?.cycleSuccessLimit ?? 0}});
  }
  frozen(dto); quotaProofs.set(dto,{actor,context,settings,checks,profile,partnerSettings,chatState,config,generation,sizing,usageDate});
  return dto;
}
export function compileAiQuotaFactsAssertions(dto) {
  const proof = quotaProofs.get(dto); if (!proof) fail('untrusted_ai_facts');
  return frozen({sql:proof.checks.length ? proof.checks.map(check=>`(${check.sql})`).join(' AND ') : '1',
    params:proof.checks.flatMap(check=>check.params),assertions:proof.checks.length?proof.checks:[{sql:'1',params:[]}]});
}
const proofGuard = (actor, decision, ai) => {
  const context = readActorContext(actor);
  const proofs = [compileContextAssertions(context),compileAuthorityAssertions(actor),compileDecisionAssertions(decision),compileAiQuotaFactsAssertions(ai)];
  const pieces=proofs.flatMap(proof=>proof.assertions ?? [proof]);
  return [...new Map(pieces.map(proof=>[JSON.stringify([proof.sql,proof.params]),proof])).values()];
};
function batchBuilder(db) {
  const statements = [], key = 'ai_' + crypto.randomUUID();
  return {statements,add(sql,params=[],min=1,max=min) {
    statements.push(db.prepare(sql).bind(...params));
    statements.push(db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
      VALUES (?,CASE WHEN changes() BETWEEN ? AND ? THEN 1 ELSE 0 END)`).bind(key+'_'+statements.length,min,max));
  },assert(sql,params=[]) {
    statements.push(db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES (?,CASE WHEN (${sql}) THEN 1 ELSE 0 END)`)
      .bind(key+'_'+statements.length,...params));
  },finish() {statements.push(db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key LIKE ?').bind(key+'_%')); return statements;}};
}
const identityPredicate = ticket => ({sql:`EXISTS(SELECT 1 FROM users u WHERE u.telegram_id=? AND u.joined_at IS ? AND u.referral_code IS ?)
  AND NOT EXISTS(SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending'
    AND (CAST(strftime('%s',expires_at) AS INTEGER)>unixepoch() OR strftime('%s',expires_at) IS NULL))
  AND EXISTS(SELECT 1 FROM ai_user_consents WHERE telegram_id=? AND consent_version=? AND consented_at IS NOT NULL AND revoked_at IS NULL)`,
  params:[ticket.identity.telegramId,ticket.user.joined_at,ticket.user.referral_code,ticket.identity.telegramId,ticket.identity.telegramId,CONSENT_VERSION]});
const rowFingerprint = ticket => ({sql:'request_id=? AND telegram_id=? AND usage_date=? AND bucket=? AND reserved_milli=? AND created_at=datetime(?,\'unixepoch\')',
  params:[ticket.requestId,ticket.identity.telegramId,ticket.usageDate,ticket.bucket,ticket.reservedMilli,ticket.at]});

// Read-only projection for the fixed runtime/recovery journal. A copied ticket
// cannot obtain this scope or replace its pricing/window/account generation.
export function readAiAdmissionTicket(ticket) {
  const t=tickets.get(ticket);if(!t)fail('untrusted_ai_ticket');
  const policy=t.namespace==='partner'?{namespace:'partner',profile:t.policy.profile,
    primaryModel:t.policy.generation.model_alias,sizing:t.policy.sizing}:{namespace:'public',
    settings:Object.fromEntries(['model_name','user_daily_success_limit','public_daily_neurons_milli',
      'admin_daily_neurons_milli','reserve_daily_neurons_milli','response_character_limit'].map(k=>[k,t.policy.settings[k]])),
    personalLimit:t.ai.quota.publicSuccessLimit};
  return Object.freeze({requestId:t.requestId,namespace:t.namespace,context:t.context,db:t.identity.db,
    subjectId:t.identity.telegramId,accountGenerationHash:readActorFacts(t.actor).account.accountFingerprint,
    usageDate:t.usageDate,bucket:t.bucket,admittedAt:t.at,expiresAt:t.expiresAt,
    userCycleStartAt:t.namespace==='partner'?t.cycleStart:null,userCycleEndAt:t.namespace==='partner'?t.cycleStart+AI_GATEWAY_HARD_LIMITS.cycleSeconds:null,
    globalCycleStartAt:t.namespace==='partner'?t.cycleStart:null,globalCycleEndAt:t.namespace==='partner'?t.cycleStart+AI_GATEWAY_HARD_LIMITS.cycleSeconds:null,
    reservedMilli:t.reservedMilli,reservedBilledTokens:t.reservation?.reservedBilledTokens??0,
    reservedCostMicrousd:t.reservation?.reservedCostMicrousd??0,
    policyVersion:t.namespace==='partner'?AI_PARTNER_POLICY_VERSION:AI_QUOTA_SETTLEMENT_VERSION,
    pricingVersion:t.namespace==='partner'?t.policy.profile.pricing.version:'existing-qwen-neurons-v1',
    policyJson:JSON.stringify(policy),primaryModelAlias:t.namespace==='partner'?t.policy.generation.model_alias:'qwen_safe',
    generationId:t.namespace==='partner'?t.policy.generation.generation_id:null,
    runtimeEnabled:t.identity.env.V141_AUTHORIZATION_ENABLED==='true'});
}

export function createAiQuotaSettlement() {
  return frozen({
    async admit(actor,decision,options={}) {
      if (!options || typeof options!=='object' || Array.isArray(options) || Object.keys(options).length) fail('invalid_ai_admission_options');
      if (!isTrustedActor(actor) || !isTrustedDecision(decision)) fail('untrusted_ai_admission');
      const context = readActorContext(actor), facts = readActorFacts(actor), d = readDecisionFacts(decision);
      if (!isTrustedContext(context) || readDecisionContext(decision)!==context || d.actor!==actor ||
          !(d.publicDTO ?? decision).allowed || !['ai.public_chat','ai.partner_draft'].includes(d.capability)) fail('ai_admission_denied');
      const identity = readTrustedContext(context);
      if (identity.operation!==d.capability || typeof identity.operationId!=='string' || !/^[A-Za-z0-9_.:-]{16,96}$/u.test(identity.operationId)) fail('stable_ai_operation_required');
      const ai = await loadAiQuotaFacts(actor), p = quotaProofs.get(ai);
      if (!ai.dlpPassed || !ai.consentValid || !ai.modelAllowed || !ai.rolloutAllowed || !ai.masterEnabled ||
          !ai.toggleEnabled || !ai.confirmationSatisfied) fail('ai_admission_denied');
      const db = identity.db, requestId = identity.operationId;
      if (await db.prepare('SELECT request_id FROM ai_quota_reservations WHERE request_id=? UNION SELECT request_id FROM ai_usage_events WHERE request_id=?').bind(requestId,requestId).first())
        return frozen({ok:false,reason:'operation_already_seen',replay:true});
      const t = {actor,decision,context,identity,user:facts.canonical.user,at:identity.nowSeconds,
        requestId,usageDate:p.usageDate,bucket:facts.canonicalOwner?'admin':'public',reservedMilli:RESERVATION,
        expiresAt:Math.min(identity.expiresAt,identity.nowSeconds+LEASE_SECONDS),ai,policy:p,namespace:ai.namespace};
      const ticket=frozen({version:1,namespace:t.namespace,requestId});tickets.set(ticket,t);
      const guard = proofGuard(actor,decision,ai);
      if (ai.namespace==='partner') {
        t.bucket='admin'; t.reservedMilli=1;
        const cycle = Math.floor(t.at/AI_GATEWAY_HARD_LIMITS.cycleSeconds)*AI_GATEWAY_HARD_LIMITS.cycleSeconds;
        t.cycleStart=cycle;
        t.gatewayContext=createVerifiedAdminGatewayContext({actorTelegramId:identity.telegramId,isAdmin:facts.canonicalOwner===true,
          purpose:'admin_chat',at:t.at,userCycleStartAt:cycle,userCycleEndAt:cycle+AI_GATEWAY_HARD_LIMITS.cycleSeconds,
          globalCycleStartAt:cycle,globalCycleEndAt:cycle+AI_GATEWAY_HARD_LIMITS.cycleSeconds,dataClass:'private',cacheAllowed:false});
        t.providerUserId=await createProviderScopedUserId({telegramId:identity.telegramId,secret:identity.env.AI_PARTNER_PROVIDER_USER_ID_SECRET});
        t.externalPrimary=p.generation.model_alias==='deepseek_flash_dragon';
        if (!p.sizing) fail('ai_admission_denied');
        t.reservation=calculateAiGatewayReservation({...p.sizing,pricing:p.profile.pricing,externalPrimary:t.externalPrimary});
        // Reuse canonical old budget arithmetic, but pair each of its actual
        // ledger writes with exact in-transaction assertions and private guards.
        const guardedDb={prepare:sql=>db.prepare(sql),async batch(original) {
          const b=batchBuilder(db); for (const proof of guard) b.assert(proof.sql,proof.params);
          b.assert(`NOT EXISTS(SELECT 1 FROM ai_gateway_budget_reservations g JOIN ai_usage_events u ON u.request_id=g.request_id
            WHERE g.owner_telegram_id=? AND g.user_cycle_start_at=? AND u.status='failed' AND u.error_code='provider_cost_overflow')`,[identity.telegramId,cycle]);
          // Current-cycle expenses anonymised after account deletion still
          // consume the global technical ceiling. The old ledger arithmetic
          // did not previously have such current-cycle aggregate entries.
          b.assert(`(SELECT COALESCE(SUM(a.cost_microusd),0) FROM ai_gateway_attempts a JOIN ai_gateway_budget_reservations g ON g.request_id=a.request_id WHERE g.global_cycle_start_at=?)
            +(SELECT COALESCE(SUM(MAX(g.reserved_cost_microusd-COALESCE((SELECT SUM(a.cost_microusd) FROM ai_gateway_attempts a WHERE a.request_id=g.request_id),0),0)),0)
              FROM ai_gateway_budget_reservations g WHERE g.global_cycle_start_at=? AND g.reservation_state='reserved')
            +(SELECT COALESCE(SUM(cost_microusd),0) FROM ai_gateway_daily_aggregates WHERE usage_date>=? AND usage_date<?)+?<=?`,
            [cycle,cycle,dateAt(cycle),dateAt(cycle+AI_GATEWAY_HARD_LIMITS.cycleSeconds),t.reservation.reservedCostMicrousd,p.profile.globalCostCeilingMicrousd]);
          b.assert(`(SELECT COALESCE(SUM(a.input_tokens+a.output_tokens),0) FROM ai_gateway_attempts a JOIN ai_gateway_budget_reservations g ON g.request_id=a.request_id WHERE g.global_cycle_start_at=?)
            +(SELECT COALESCE(SUM(MAX(g.reserved_billed_tokens-COALESCE((SELECT SUM(a.input_tokens+a.output_tokens) FROM ai_gateway_attempts a WHERE a.request_id=g.request_id),0),0)),0)
              FROM ai_gateway_budget_reservations g WHERE g.global_cycle_start_at=? AND g.reservation_state='reserved')
            +(SELECT COALESCE(SUM(input_tokens+output_tokens),0) FROM ai_gateway_daily_aggregates WHERE usage_date>=? AND usage_date<?)+?<=?`,
            [cycle,cycle,dateAt(cycle),dateAt(cycle+AI_GATEWAY_HARD_LIMITS.cycleSeconds),t.reservation.reservedBilledTokens,p.profile.globalTokenCeiling]);
          for (const statement of original) {b.statements.push(statement); b.statements.push(db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
            VALUES (?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)`).bind('ai_gateway_'+crypto.randomUUID()));}
          if(identity.env.V141_AUTHORIZATION_ENABLED==='true'){const journal=await compileAiJournalAdmission(ticket);b.add(journal.sql,journal.params);}
          b.statements.push(db.prepare("DELETE FROM mini_app_atomic_guards WHERE guard_key LIKE 'ai_gateway_%'"));
          const results=await commit(db,b.finish()); return original.map((_,i)=>results[guard.length+3+i*2]);
        }};
        const result=await reserveAiGatewayBudget(guardedDb,{context:t.gatewayContext,requestId,reservation:t.reservation,profile:p.profile,policyVersion:AI_PARTNER_POLICY_VERSION});
        if (!result.ok || result.replay) return frozen({ok:false,reason:result.reason ?? 'operation_already_seen',replay:result.replay});
      } else {
        const b=batchBuilder(db);
        // Expired unknown provider operations retain their provisional spend;
        // cleanup never frees a budget and then lets a late answer count.
        b.add(`INSERT OR IGNORE INTO ai_usage_events(request_id,telegram_id,usage_date,bucket,status,neurons_milli,error_code)
          SELECT q.request_id,0,q.usage_date,q.bucket,'failed',q.reserved_milli,'provider_unknown'
          FROM ai_quota_reservations q WHERE q.status='reserved' AND CAST(strftime('%s',q.created_at) AS INTEGER)+300<=unixepoch()
          AND NOT EXISTS(SELECT 1 FROM ai_gateway_budget_reservations g WHERE g.request_id=q.request_id)${identity.env.V141_AUTHORIZATION_ENABLED==='true'?" AND NOT EXISTS(SELECT 1 FROM ai_operation_journal j WHERE j.request_id=q.request_id)":''}`,[],0,1_000_000_000);
        b.add(`UPDATE ai_quota_reservations SET status='released',completed_at=CURRENT_TIMESTAMP WHERE status='reserved'
          AND CAST(strftime('%s',created_at) AS INTEGER)+300<=unixepoch()
          AND NOT EXISTS(SELECT 1 FROM ai_gateway_budget_reservations g WHERE g.request_id=ai_quota_reservations.request_id)${identity.env.V141_AUTHORIZATION_ENABLED==='true'?" AND NOT EXISTS(SELECT 1 FROM ai_operation_journal j WHERE j.request_id=ai_quota_reservations.request_id)":''}`,[],0,1_000_000_000);
        for (const proof of guard) b.assert(proof.sql,proof.params);
        b.add(`INSERT OR IGNORE INTO ai_quota_reservations(request_id,telegram_id,usage_date,bucket,reserved_milli,status,created_at)
          SELECT ?,?,?,?,?,'reserved',datetime(?,'unixepoch') WHERE
          NOT EXISTS(SELECT 1 FROM ai_quota_reservations WHERE telegram_id=? AND status='reserved')
          AND NOT EXISTS(SELECT 1 FROM ai_usage_events WHERE request_id=?)
          AND (?='admin' OR (SELECT COUNT(*) FROM ai_usage_events u WHERE telegram_id=? AND usage_date=? AND status='success' AND ${publicWhere})<?)
          AND (SELECT COALESCE(SUM(neurons_milli),0) FROM ai_usage_events WHERE usage_date=? AND bucket=?) +
          (SELECT COALESCE(SUM(reserved_milli),0) FROM ai_quota_reservations q WHERE usage_date=? AND bucket=? AND status='reserved'
           AND NOT EXISTS(SELECT 1 FROM ai_gateway_budget_reservations g WHERE g.request_id=q.request_id))+?<=?
          AND (SELECT COALESCE(SUM(neurons_milli),0) FROM ai_usage_events WHERE usage_date=? AND bucket='reserve')<?`,
          [requestId,identity.telegramId,t.usageDate,t.bucket,RESERVATION,t.at,identity.telegramId,requestId,t.bucket,identity.telegramId,t.usageDate,ai.quota.publicSuccessLimit,
            t.usageDate,t.bucket,t.usageDate,t.bucket,RESERVATION,t.bucket==='admin'?p.settings.admin_daily_neurons_milli:p.settings.public_daily_neurons_milli,t.usageDate,p.settings.reserve_daily_neurons_milli]);
        if(identity.env.V141_AUTHORIZATION_ENABLED==='true'){const journal=await compileAiJournalAdmission(ticket);b.add(journal.sql,journal.params);}
        try {await commit(db,b.finish());} catch(error) {
          if (/CHECK constraint failed: precondition_ok/u.test(error.message)) return frozen({ok:false,reason:'admission_conflict',replay:false});
          throw error;
        }
      }
      return frozen({ok:true,replay:false,ticket});
    },
    async settle(ticket,{outcome,usage={},answer,sourceCount=0,remember=false,attempts=[]}={}) {
      const t=tickets.get(ticket); if (!t) fail('untrusted_ai_ticket');
      if (!['success','failed','unknown'].includes(outcome)) fail('invalid_ai_outcome');
      const journal=t.identity.env.V141_AUTHORIZATION_ENABLED==='true'?await loadAiJournalSettlement(ticket):null;
      if(journal){usage=journal.usage;attempts=journal.attempts.filter((_,i)=>journal.receipts[i].expense_location==='pending');if(outcome==='success'&&!journal.conclusive)outcome='unknown';}
      const input=integer(usage.inputTokens ?? 0),output=integer(usage.outputTokens ?? 0);
      if (!Array.isArray(attempts) || attempts.length>3) fail('invalid_ai_attempts');
      attempts=attempts.map(a=>({...a}));
      integer(sourceCount,32);
      let text=null,invalidAnswer=false;
      if (outcome==='success') {try {text=safeAnswer(answer,t.namespace==='partner'?3500:t.policy.settings.response_character_limit);}
        catch(error) {if (error.code!=='invalid_ai_answer') throw error; invalidAnswer=true;}}
      const db=t.identity.db;
      const existing=await db.prepare('SELECT status FROM ai_usage_events WHERE request_id=?').bind(t.requestId).first();
      if (existing && existing.status==='success') return frozen({ok:true,replay:true,outcome:'success',deliverAllowed:false});
      let sameGeneration=false;
      try {const freshActor=await createAuthorityResolver().resolveActor(t.context);
        sameGeneration=readActorFacts(freshActor).account?.accountFingerprint===readActorFacts(t.actor).account?.accountFingerprint;}
      catch {sameGeneration=false;}
      const guard=proofGuard(t.actor,t.decision,t.ai), fingerprint=rowFingerprint(t), identity=identityPredicate(t);
      let success=outcome==='success' && !invalidAnswer && sameGeneration && !existing && (!journal||journal.journal.state!=='terminal_failed'&&journal.receipts.some(r=>r.attempt_status==='success'));
      const cost=t.namespace==='partner'||(journal?.journal.terminal_reason==='local_not_started'||journal&&journal.journal.attempted_count===0)?0:outcome==='unknown'?Math.max(RESERVATION,Math.ceil((input*4625+output*30475)/1000)):
        input+output>0?Math.max(1,Math.ceil((input*4625+output*30475)/1000)):FAILED_ESTIMATE;
      const failureBucket=t.namespace==='partner'?'admin':outcome==='failed' && input+output===0?'reserve':t.bucket;
      const partnerCosts=t.namespace==='partner'?await preparePartnerCosts(t,attempts,outcome):null;
      const summary=partnerCosts?.summary ?? null;
      success=success && !partnerCosts?.overflow && (t.namespace!=='partner' || summary.attemptCount>0 && summary.attempts.some(a=>a.status==='success'));
      if(partnerCosts?.anonymous) success=false;
      if (success) {
        const b=batchBuilder(db); for (const proof of guard) b.assert(proof.sql,proof.params); b.assert(identity.sql,identity.params);
        if(partnerCosts) appendPartnerCosts(b,t,partnerCosts);
        if (t.namespace==='public') b.assert(`(SELECT COALESCE(SUM(neurons_milli),0) FROM ai_usage_events WHERE usage_date=? AND bucket=?)
          +(SELECT COALESCE(SUM(reserved_milli),0) FROM ai_quota_reservations q WHERE usage_date=? AND bucket=? AND status='reserved' AND request_id!=?
            AND NOT EXISTS(SELECT 1 FROM ai_gateway_budget_reservations g WHERE g.request_id=q.request_id))+?<=?`,
          [t.usageDate,t.bucket,t.usageDate,t.bucket,t.requestId,cost,t.bucket==='admin'?t.policy.settings.admin_daily_neurons_milli:t.policy.settings.public_daily_neurons_milli]);
        else {
          b.assert(`(SELECT COUNT(*) FROM ai_usage_events u JOIN ai_gateway_budget_reservations g ON g.request_id=u.request_id
            WHERE g.owner_telegram_id=? AND u.usage_date=? AND u.status='success')<?
            AND (SELECT COUNT(*) FROM ai_usage_events u JOIN ai_gateway_budget_reservations g ON g.request_id=u.request_id
            WHERE g.owner_telegram_id=? AND g.user_cycle_start_at=? AND u.status='success')<?`,
            [t.identity.telegramId,t.usageDate,t.policy.profile.dailySuccessLimit,t.identity.telegramId,t.cycleStart,t.policy.profile.cycleSuccessLimit]);
          b.assert(`(SELECT COALESCE(SUM(a.cost_microusd),0) FROM ai_gateway_attempts a JOIN ai_gateway_budget_reservations g ON g.request_id=a.request_id
            WHERE g.owner_telegram_id=? AND g.user_cycle_start_at=?)<=?
            AND (SELECT COALESCE(SUM(a.cost_microusd),0) FROM ai_gateway_attempts a JOIN ai_gateway_budget_reservations g ON g.request_id=a.request_id
            WHERE g.global_cycle_start_at=?)+(SELECT COALESCE(SUM(cost_microusd),0) FROM ai_gateway_daily_aggregates WHERE usage_date>=? AND usage_date<?)<=?`,
            [t.identity.telegramId,t.cycleStart,t.policy.profile.userCostCeilingMicrousd,t.cycleStart,dateAt(t.cycleStart),
              dateAt(t.cycleStart+AI_GATEWAY_HARD_LIMITS.cycleSeconds),t.policy.profile.globalCostCeilingMicrousd]);
        }
        b.add(`UPDATE ai_quota_reservations SET status='consumed',completed_at=CURRENT_TIMESTAMP WHERE ${fingerprint.sql}
          AND status='reserved' AND unixepoch()<? AND (?='admin' OR
          (SELECT COUNT(*) FROM ai_usage_events u WHERE telegram_id=? AND usage_date=? AND status='success' AND ${publicWhere})<?)`,
          [...fingerprint.params,t.expiresAt,t.bucket,t.identity.telegramId,t.usageDate,t.ai.quota.publicSuccessLimit]);
        if (t.namespace==='partner') addPartnerCas(b,t,'consumed');
        b.add(`INSERT INTO ai_usage_events(request_id,telegram_id,usage_date,bucket,status,input_tokens,output_tokens,neurons_milli,source_count)
          VALUES(?,?,?,?,'success',?,?,?,?)`,[t.requestId,t.identity.telegramId,t.usageDate,t.bucket,input,output,cost,sourceCount]);
        if (summary) addPartnerMetadata(b,t,summary,'success');
        if(journal)for(const q of await compileAiJournalSettlement(ticket,{outcome:'success'}))b.add(q.sql,q.params,q.min,q.max);
        if (remember && t.namespace==='public') {
          const prompt=t.identity.requestPayload?.prompt ?? t.identity.requestPayload?.text;
          if (!promptSafe(prompt)) fail('invalid_ai_prompt');
          b.add("INSERT INTO ai_conversation_messages(telegram_id,role,content) VALUES(?,'user',?)",[t.identity.telegramId,prompt]);
          b.add("INSERT INTO ai_conversation_messages(telegram_id,role,content) VALUES(?,'assistant',?)",[t.identity.telegramId,text]);
          b.add(`DELETE FROM ai_conversation_messages WHERE telegram_id=? AND id NOT IN
            (SELECT id FROM ai_conversation_messages WHERE telegram_id=? ORDER BY id DESC LIMIT 10)`,[t.identity.telegramId,t.identity.telegramId],0,1_000_000_000);
        }
        try {
          await commit(db,b.finish());
          // Database commit establishes success before Telegram delivery. A
          // revocation observed after commit suppresses the outbound content
          // without refunding the committed count or restarting the provider.
          let deliverAllowed=true;
          for(const proof of [...guard,identity]) {
            try {const currentProof=await db.prepare(`SELECT (${proof.sql}) AS ok`).bind(...proof.params).first();
              if(currentProof?.ok!==1){deliverAllowed=false;break;}}
            catch {deliverAllowed=false;break;}
          }
          return frozen({ok:true,replay:false,outcome:'success',deliverAllowed,...(deliverAllowed?{answer:text}:{})});
        }
        catch(error) {if (!/CHECK constraint failed: precondition_ok|no such table|no such column|database schema has changed/iu.test(error.message)) throw error; success=false;}
      }
      // Terminal lost/released/expired authorization can settle actual expense,
      // but can never reopen a reservation or persist a sensitive answer.
      const current=await db.prepare('SELECT status FROM ai_usage_events WHERE request_id=?').bind(t.requestId).first();
      if (current?.status==='success') return frozen({ok:true,replay:true,outcome:'success',deliverAllowed:false});
      const ownedJournalStatements=journal?await compileAiJournalSettlement(ticket,{outcome:outcome==='unknown'?'unknown':'failed',anonymous:partnerCosts?.anonymous===true}):[];
      const anonymousJournalStatements=journal?await compileAiJournalSettlement(ticket,{outcome:outcome==='unknown'?'unknown':'failed',anonymous:true}):[];
      const failureBatch=anonymous=>{const b=batchBuilder(db);
      if(partnerCosts) appendPartnerCosts(b,t,partnerCosts,anonymous);
      b.add(`UPDATE ai_quota_reservations SET status='released',completed_at=CURRENT_TIMESTAMP WHERE ${fingerprint.sql} AND status='reserved'`,fingerprint.params,0,1);
      if (t.namespace==='partner' && outcome!=='unknown') addPartnerCas(b,t,'released',0);
      b.add(`INSERT OR IGNORE INTO ai_usage_events(request_id,telegram_id,usage_date,bucket,status,input_tokens,output_tokens,neurons_milli,source_count,error_code)
        VALUES(?,CASE WHEN (${identity.sql}) THEN ? ELSE 0 END,?,?,'failed',?,?,?,?,?)`,
        [t.requestId,...identity.params,t.identity.telegramId,t.usageDate,failureBucket,input,output,cost,sourceCount,partnerCosts?.overflow?'provider_cost_overflow':outcome==='unknown'?'provider_unknown':outcome==='success'?'authorization_lost':'provider_failed'],0,1);
      if(partnerCosts?.overflow) b.add("UPDATE ai_usage_events SET error_code='provider_cost_overflow' WHERE request_id=? AND status='failed'",[t.requestId],1);
      if (summary?.attemptCount && outcome!=='unknown' && !anonymous && !partnerCosts?.overflow) addPartnerMetadata(b,t,summary,'failed',0);
      // A late actual cost may only increase a previously conservative/failed
      // event. It cannot change its fixed day, identity, outcome or namespace.
      if (t.namespace==='public') b.add(`UPDATE ai_usage_events SET neurons_milli=MAX(neurons_milli,?),input_tokens=MAX(input_tokens,?),output_tokens=MAX(output_tokens,?)
        WHERE request_id=? AND status='failed'`,[cost,input,output,t.requestId],1);
      b.assert("EXISTS(SELECT 1 FROM ai_usage_events WHERE request_id=? AND status='failed')",[t.requestId]);
      for(const q of anonymous?anonymousJournalStatements:ownedJournalStatements)b.add(q.sql,q.params,q.min,q.max);
      return b.finish();};
      try {await commit(db,failureBatch(partnerCosts?.anonymous===true));}
      catch(error) {
        if (!partnerCosts || !/CHECK constraint failed: precondition_ok/u.test(error.message)) throw error;
        const budget=await db.prepare('SELECT request_id FROM ai_gateway_budget_reservations WHERE request_id=?').bind(t.requestId).first();
        if(budget) throw error;
        await commit(db,failureBatch(true));
      }
      return frozen({ok:true,replay:Boolean(current),outcome:'failed',deliverAllowed:false,reason:outcome==='unknown'?'provider_unknown':outcome==='success'?'authorization_lost':'provider_failed'});
    },
  });
}

function addPartnerCas(b,t,state,min=1) {
  b.add(`UPDATE ai_gateway_budget_reservations SET reservation_state=?,completed_at=MAX(created_at,unixepoch())
    WHERE request_id=? AND owner_telegram_id=? AND reservation_state='reserved'`,[state,t.requestId,t.identity.telegramId],min,1);
}
function addPartnerMetadata(b,t,summary,outcome,min=1) {
  const successes=summary.attempts.filter(a=>a.status==='success');
  b.add(`INSERT OR IGNORE INTO ai_gateway_usage_metadata(request_id,provider_user_id,data_class,primary_model_alias,final_model_alias,
    attempt_count,retry_count,fallback_used,total_latency_ms,cached_input_tokens,billed_tokens,cost_microusd,
    cache_scope,cache_key_hash,pricing_version,policy_version,created_at)
    VALUES(?,?,'private',?,?,?,?,?,?,?,?,?,'none',NULL,?,?,MAX(?,unixepoch()))`,
    [t.requestId,t.providerUserId,summary.attempts[0].modelAlias,outcome==='success'?successes.at(-1).modelAlias:'none',
      summary.attemptCount,summary.retryCount,summary.fallbackUsed?1:0,summary.totalLatencyMs,summary.cachedInputTokens,
      summary.billedTokens,summary.costMicrousd,t.policy.profile.pricing.version,AI_PARTNER_POLICY_VERSION,t.at],min,1);
}
async function preparePartnerCosts(t,attempts,outcome) {
  if (!Array.isArray(attempts) || attempts.length>3 || outcome==='success' && attempts.length===0) fail('invalid_ai_attempts');
  const previous=await summarizeAiGatewayAttempts(strictReads(t.identity.db),t.requestId);
  const records=previous.attempts.map(a=>({...a})),receipts=[];
  for(const a of attempts) {
    const input=integer(a.inputTokens??0),output=integer(a.outputTokens??0),cached=integer(a.cachedInputTokens??0,input);
    if (!['qwen_safe','deepseek_flash_dragon'].includes(a.modelAlias) || !t.externalPrimary && a.modelAlias!=='qwen_safe' ||
        a.routeStep==='primary' && a.modelAlias!==t.policy.generation.model_alias) fail('ai_model_not_admitted');
    const cost=a.modelAlias==='qwen_safe'?0:calculateAiGatewayCostMicrousd({inputTokens:input,outputTokens:output,cachedInputTokens:cached,pricing:t.policy.profile.pricing});
    const no=integer(a.attemptNo,3),latency=integer(a.latencyMs??0,300_000);
    if(no<1 || !['success','failed','timeout'].includes(a.status) || !['primary','retry','fallback'].includes(a.routeStep) ||
      typeof a.attemptId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(a.attemptId)) fail('invalid_ai_attempts');
    if (!(a.routeStep==='primary' && no===1 || a.routeStep==='retry' && no===2 && a.modelAlias==='deepseek_flash_dragon' ||
      a.routeStep==='fallback' && no>=2 && a.modelAlias==='qwen_safe')) fail('invalid_ai_attempts');
    const statusCode=a.statusCode??null;if(statusCode!==null && (!Number.isSafeInteger(statusCode)||statusCode<100||statusCode>599))fail('invalid_ai_attempts');
    const entry={attemptId:a.attemptId,attemptNo:no,routeStep:a.routeStep,modelAlias:a.modelAlias,
      providerCode:a.modelAlias==='qwen_safe'?'cloudflare':'deepseek',status:a.status,inputTokens:input,cachedInputTokens:cached,
      outputTokens:output,costMicrousd:cost,latencyMs:latency,statusCode,errorCode:a.status==='success'?'':a.status==='timeout'?'provider_timeout':'provider_failed'};
    const prior=records.find(r=>r.attemptNo===no || r.routeStep===a.routeStep);
    if(prior) {for(const key of Object.keys(entry))if(prior[key]!==entry[key])fail('ai_attempt_replay_conflict');}
    else records.push(entry);
    receipts.push({...entry,costReceiptHash:'cost_receipt_'+await sha256(JSON.stringify(entry))});
  }
  records.sort((a,b)=>a.attemptNo-b.attemptNo);
  if(records.length>3)fail('invalid_ai_attempts');
  const summary={attempts:records,attemptCount:records.length,retryCount:records.filter(a=>a.routeStep==='retry').length,
    fallbackUsed:records.some(a=>a.routeStep==='fallback'),totalLatencyMs:records.reduce((n,a)=>n+a.latencyMs,0),
    cachedInputTokens:records.reduce((n,a)=>n+a.cachedInputTokens,0),billedTokens:records.reduce((n,a)=>n+a.inputTokens+a.outputTokens,0),
    costMicrousd:records.reduce((n,a)=>n+a.costMicrousd,0)};
  const budget=await t.identity.db.prepare('SELECT request_id FROM ai_gateway_budget_reservations WHERE request_id=?').bind(t.requestId).first();
  const overflow=records.some(a=>a.costMicrousd>2_000_000) || summary.costMicrousd>2_000_000 || summary.billedTokens>30_000_000;
  return {summary,receipts,previous:previous.attempts,overflow,anonymous:budget===null || overflow};
}
function appendPartnerCosts(b,t,plan,forceAnonymous=false) {
  if(forceAnonymous || plan.anonymous) {
    if(!plan.receipts.length)return;
    const receipts=plan.receipts.filter(a=>!plan.previous.some(p=>p.attemptId===a.attemptId));
    for(const a of receipts) {
      const marker=t.requestId+':cost:'+a.attemptNo,claim='ai_cost_'+crypto.randomUUID();
      b.assert('NOT EXISTS(SELECT 1 FROM ai_usage_events WHERE request_id=?) OR EXISTS(SELECT 1 FROM ai_usage_events WHERE request_id=? AND error_code=?)',
        [marker,marker,a.costReceiptHash]);
      b.add(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
        SELECT ?,1 WHERE NOT EXISTS(SELECT 1 FROM ai_usage_events WHERE request_id=?)`,[claim,marker],0,1);
      b.add(`INSERT INTO ai_gateway_daily_aggregates(usage_date,model_alias,provider_code,attempt_status,
        request_count,attempt_count,input_tokens,cached_input_tokens,output_tokens,cost_microusd,latency_ms,aggregated_at)
        SELECT ?,?,?,?, ?,1,?,?,?,?,?,unixepoch() FROM mini_app_atomic_guards WHERE guard_key=?
        ON CONFLICT(usage_date,model_alias,provider_code,attempt_status) DO UPDATE SET
        request_count=request_count+excluded.request_count,attempt_count=attempt_count+1,input_tokens=input_tokens+excluded.input_tokens,
        cached_input_tokens=cached_input_tokens+excluded.cached_input_tokens,output_tokens=output_tokens+excluded.output_tokens,
        cost_microusd=cost_microusd+excluded.cost_microusd,latency_ms=latency_ms+excluded.latency_ms,aggregated_at=unixepoch()`,
        [t.usageDate,a.modelAlias,a.providerCode,a.status,a.attemptNo===1?1:0,a.inputTokens,a.cachedInputTokens,a.outputTokens,a.costMicrousd,a.latencyMs,claim],0,1);
      b.add(`INSERT OR IGNORE INTO ai_usage_events(request_id,telegram_id,usage_date,bucket,status,error_code)
        SELECT ?,0,?,'admin','failed',? FROM mini_app_atomic_guards WHERE guard_key=?`,
        [marker,t.usageDate,a.costReceiptHash,claim],0,1);
      b.assert("EXISTS(SELECT 1 FROM ai_usage_events WHERE request_id=? AND telegram_id=0 AND status='failed' AND error_code=?)",[marker,a.costReceiptHash]);
      b.add('DELETE FROM mini_app_atomic_guards WHERE guard_key=?',[claim],0,1);
    }
    return;
  }
  for(const a of plan.receipts) {
    b.add(`INSERT OR IGNORE INTO ai_gateway_attempts(attempt_id,request_id,attempt_no,route_step,model_alias,provider_code,attempt_status,
      input_tokens,cached_input_tokens,output_tokens,cost_microusd,latency_ms,status_code,error_code,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,MAX(created_at,unixepoch()) FROM ai_gateway_budget_reservations g WHERE request_id=?
      AND ?=COALESCE((SELECT MAX(attempt_no)+1 FROM ai_gateway_attempts WHERE request_id=g.request_id),1)`,
      [a.attemptId,t.requestId,a.attemptNo,a.routeStep,a.modelAlias,a.providerCode,a.status,a.inputTokens,a.cachedInputTokens,a.outputTokens,
        a.costMicrousd,a.latencyMs,a.statusCode,a.errorCode,t.requestId,a.attemptNo],0,1);
    b.assert(`EXISTS(SELECT 1 FROM ai_gateway_attempts WHERE request_id=? AND attempt_id=? AND attempt_no=? AND model_alias=?
      AND attempt_status=? AND input_tokens=? AND cached_input_tokens=? AND output_tokens=? AND cost_microusd=?)`,
      [t.requestId,a.attemptId,a.attemptNo,a.modelAlias,a.status,a.inputTokens,a.cachedInputTokens,a.outputTokens,a.costMicrousd]);
  }
}
