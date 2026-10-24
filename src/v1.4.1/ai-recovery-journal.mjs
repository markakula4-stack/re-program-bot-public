import { readAiAdmissionTicket } from './ai-quota-settlement.mjs';
import { readTrustedContext } from './trusted-context.mjs';
import { readActorFacts, accountGenerationFingerprint } from './authority-resolver.mjs';
import { readRuntimeAuthorization, requireRuntimeAuthorization } from './runtime-authorizer.mjs';
import { compileDecisionAssertions } from './entitlement-engine.mjs';
import { readAiProviderTerminalOutcome } from '../v1.3.8/ai-partner-provider-transports.mjs';
import { readAiPartnerStreamTerminalOutcome } from '../v1.3.8/ai-partner-owner-security-cost-fallback-part4.mjs';
import { calculateAiGatewayCostMicrousd } from '../v1.3.8/ai-partner-gateway.mjs';

export const AI_RECOVERY_JOURNAL_VERSION='2026-10-02.v1.4.1.p04';
const attempts=new WeakMap(),receipts=new WeakMap();
const fail=code=>{throw Object.assign(new Error(code),{code,status:409});};
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');
const integer=(n,max=10_000_000)=>{if(!Number.isSafeInteger(n)||n<0||n>max)fail('ai_receipt_invalid');return n;};
function builder(db) {
  const statements=[],key='ai_journal_'+crypto.randomUUID();
  return {add(sql,params=[],min=1,max=min){statements.push(db.prepare(sql).bind(...params));
    statements.push(db.prepare('INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN changes() BETWEEN ? AND ? THEN 1 ELSE 0 END)').bind(key+'_'+statements.length,min,max));},
    assert(sql,params=[]){statements.push(db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN (${sql}) THEN 1 ELSE 0 END)`).bind(key+'_'+statements.length,...params));},
    finish(){statements.push(db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key LIKE ?').bind(key+'_%'));return statements;}};
}
async function commit(db,statements){const result=await db.batch(statements);if(!Array.isArray(result)||result.length!==statements.length||result.some(r=>r?.success!==true))fail('ai_journal_commit_unverified');return result;}
const scopeFor=ticket=>{const scope=readAiAdmissionTicket(ticket);if(!scope.runtimeEnabled)fail('ai_journal_runtime_required');return scope;};
async function row(db,requestId) {
  const result=await db.prepare('SELECT * FROM ai_operation_journal WHERE request_id=?').bind(requestId).all();
  if(result?.success!==true||!Array.isArray(result.results)||result.results.length!==1)fail('ai_journal_unavailable');
  return result.results[0];
}

// A fixed compiler consumes an actual ticket's immutable scope. Callers cannot
// submit an actor, pricing, date or SQL callback as journal admission authority.
export async function compileAiJournalAdmission(ticket) {
  const s=scopeFor(ticket),policyHash=await hash(s.policyJson);
  return Object.freeze({sql:`INSERT INTO ai_operation_journal(request_id,namespace,subject_telegram_id,account_generation_hash,
    usage_date,bucket,admitted_at,expires_at,user_cycle_start_at,user_cycle_end_at,global_cycle_start_at,global_cycle_end_at,
    reserved_milli,reserved_billed_tokens,reserved_cost_microusd,policy_version,pricing_version,policy_json,policy_hash,
    primary_model_alias,generation_id,state,settlement_kind,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'admitted','owned',?)`,
    params:Object.freeze([s.requestId,s.namespace,s.subjectId,s.accountGenerationHash,s.usageDate,s.bucket,s.admittedAt,s.expiresAt,
      s.userCycleStartAt,s.userCycleEndAt,s.globalCycleStartAt,s.globalCycleEndAt,s.reservedMilli,s.reservedBilledTokens,
      s.reservedCostMicrousd,s.policyVersion,s.pricingVersion,s.policyJson,policyHash,s.primaryModelAlias,s.generationId,s.admittedAt])});
}

export async function startAiJournalAttempt(ticket,authorization,{attemptNo,routeStep,modelAlias}={}) {
  const s=scopeFor(ticket),auth=readRuntimeAuthorization(requireRuntimeAuthorization(authorization)),identity=readTrustedContext(auth.context);
  if(identity.operationId!==s.requestId || readActorFacts(auth.actor).account.accountFingerprint!==s.accountGenerationHash ||
      identity.operation!==(s.namespace==='public'?'ai.public_chat':'ai.partner_draft'))fail('ai_attempt_authority_mismatch');
  if(!(attemptNo===1&&routeStep==='primary'&&modelAlias===s.primaryModelAlias ||
      s.namespace==='partner'&&s.primaryModelAlias==='deepseek_flash_dragon'&&
      (attemptNo===2&&routeStep==='retry'&&modelAlias==='deepseek_flash_dragon' || [2,3].includes(attemptNo)&&routeStep==='fallback'&&modelAlias==='qwen_safe')))
    fail('ai_attempt_route_invalid');
  const attemptId=crypto.randomUUID(),proof=compileDecisionAssertions(auth.decision),b=builder(s.db);
  for(const p of proof.assertions??[proof])b.assert(p.sql,p.params);
  b.add(`UPDATE ai_operation_journal SET state='provider_started',active_attempt_no=?,active_attempt_id=?,active_route_step=?,
    active_model_alias=?,active_started_at=MAX(admitted_at,unixepoch()),provider_started_at=COALESCE(provider_started_at,MAX(admitted_at,unixepoch())),
    attempted_count=attempted_count+1,revision=revision+1,updated_at=MAX(updated_at,unixepoch()) WHERE request_id=?
    AND subject_telegram_id=? AND account_generation_hash=? AND state IN ('admitted','provider_started') AND active_attempt_no IS NULL
    AND unixepoch()<expires_at AND ?=COALESCE((SELECT MAX(attempt_no)+1 FROM ai_operation_receipts WHERE request_id=?),1)
    AND EXISTS(SELECT 1 FROM ai_quota_reservations WHERE request_id=? AND status='reserved')`,
    [attemptNo,attemptId,routeStep,modelAlias,s.requestId,s.subjectId,s.accountGenerationHash,attemptNo,s.requestId,s.requestId]);
  await commit(s.db,b.finish());
  const handle=Object.freeze({version:1});attempts.set(handle,{ticket,scope:s,attemptNo,attemptId,routeStep,modelAlias,startedAt:Date.now()});return handle;
}

export function readAiJournalAttempt(handle) {
  const a=attempts.get(handle);if(!a)fail('untrusted_ai_attempt');
  return Object.freeze({requestId:a.scope.requestId,attemptNo:a.attemptNo,attemptId:a.attemptId,routeStep:a.routeStep,modelAlias:a.modelAlias});
}
export function readAiJournalReceipt(receipt) {
  const r=receipts.get(receipt);if(!r)fail('untrusted_ai_receipt');return r;
}

// Proof originates in the actual fixed transport; a JSON result/error cannot
// declare itself terminal or provide a cheaper receipt after a local timeout.
export async function recordAiJournalResult(handle,result) {
  const a=attempts.get(handle);if(!a)fail('untrusted_ai_attempt');
  const outcome=readAiProviderTerminalOutcome(result)??readAiPartnerStreamTerminalOutcome(result);
  if(!outcome)return Object.freeze({known:false});
  const {scope:s}=a;
  if(!outcome.invoked) {
    const b=builder(s.db);
    b.add(`UPDATE ai_operation_journal SET state='terminal_failed',terminal_at=MAX(admitted_at,unixepoch()),terminal_reason='local_not_started',
      active_attempt_no=NULL,active_attempt_id=NULL,active_route_step=NULL,active_model_alias=NULL,active_started_at=NULL,
      revision=revision+1,updated_at=MAX(updated_at,unixepoch()) WHERE request_id=? AND state='provider_started' AND active_attempt_id=?`,[s.requestId,a.attemptId]);
    await commit(s.db,b.finish());return Object.freeze({known:true,invoked:false});
  }
  const u=outcome.usageKnown?outcome.usage:outcome.estimatedUsage;
  if(!u)return Object.freeze({known:false});
  const inputTokens=integer(u.inputTokens),outputTokens=integer(u.outputTokens),cachedInputTokens=integer(u.cachedInputTokens??0,inputTokens);
  const policy=JSON.parse(s.policyJson),costMicrousd=a.modelAlias==='deepseek_flash_dragon'
    ?calculateAiGatewayCostMicrousd({inputTokens,outputTokens,cachedInputTokens,pricing:policy.profile.pricing}):0;
  const normalized={attemptId:a.attemptId,attemptNo:a.attemptNo,routeStep:a.routeStep,modelAlias:a.modelAlias,
    providerCode:a.modelAlias==='deepseek_flash_dragon'?'deepseek':'cloudflare',status:outcome.status,
    inputTokens,cachedInputTokens,outputTokens,costMicrousd,
    latencyMs:a.receiptCandidate?.latencyMs??Math.max(0,Math.min(300_000,Date.now()-a.startedAt)),statusCode:outcome.statusCode,
    errorCode:outcome.status==='success'?'':'provider_failed'};
  const receiptHash=await hash(JSON.stringify(normalized));
  if(a.receiptCandidate && a.receiptCandidate.receiptHash!==receiptHash)fail('ai_receipt_conflict');
  a.receiptCandidate=Object.freeze({...normalized,receiptHash});
  const neuronsMilli=s.namespace==='public'
    ?Math.max(1,Math.ceil((inputTokens*4625+outputTokens*30475)/1000)):0;
  const j=await row(s.db,s.requestId),b=builder(s.db);
  b.assert(`EXISTS(SELECT 1 FROM ai_operation_journal WHERE request_id=? AND policy_hash=? AND
    (active_attempt_id=? OR EXISTS(SELECT 1 FROM ai_operation_receipts WHERE request_id=? AND attempt_no=? AND receipt_hash=?)))`,
    [s.requestId,await hash(s.policyJson),a.attemptId,s.requestId,a.attemptNo,receiptHash]);
  b.add(`INSERT OR IGNORE INTO ai_operation_receipts(request_id,attempt_no,attempt_id,route_step,model_alias,provider_code,attempt_status,
    input_tokens,cached_input_tokens,output_tokens,cost_microusd,neurons_milli,latency_ms,status_code,error_code,receipt_hash,expense_location,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',MAX(?,unixepoch()))`,
    [s.requestId,a.attemptNo,a.attemptId,a.routeStep,a.modelAlias,normalized.providerCode,outcome.status,inputTokens,cachedInputTokens,
      outputTokens,costMicrousd,neuronsMilli,normalized.latencyMs,normalized.statusCode,normalized.errorCode,receiptHash,s.admittedAt],0,1);
  b.assert('EXISTS(SELECT 1 FROM ai_operation_receipts WHERE request_id=? AND attempt_no=? AND receipt_hash=?)',[s.requestId,a.attemptNo,receiptHash]);
  if(j.active_attempt_id===a.attemptId)b.add(`UPDATE ai_operation_journal SET active_attempt_no=NULL,active_attempt_id=NULL,
    active_route_step=NULL,active_model_alias=NULL,active_started_at=NULL,revision=revision+1,updated_at=MAX(updated_at,unixepoch())
    WHERE request_id=? AND active_attempt_id=?`,[s.requestId,a.attemptId]);
  await commit(s.db,b.finish());
  const receipt=Object.freeze({...normalized,receiptHash,neuronsMilli});receipts.set(receipt,receipt);
  return Object.freeze({known:true,invoked:true,receipt});
}

export async function markAiJournalUnknown(handle) {
  const a=attempts.get(handle);if(!a)fail('untrusted_ai_attempt');const {scope:s}=a,b=builder(s.db);
  b.add(`UPDATE ai_operation_journal SET state='unknown',revision=revision+1,updated_at=MAX(updated_at,unixepoch())
    WHERE request_id=? AND state='provider_started' AND active_attempt_id=?`,[s.requestId,a.attemptId],0,1);
  await commit(s.db,b.finish());
  return Object.freeze({outcome:'unknown'});
}

export async function loadAiJournalSettlement(ticket) {
  const s=scopeFor(ticket),j=await row(s.db,s.requestId);
  const response=await s.db.prepare('SELECT * FROM ai_operation_receipts WHERE request_id=? ORDER BY attempt_no').bind(s.requestId).all();
  if(response?.success!==true||!Array.isArray(response.results))fail('ai_journal_unavailable');
  const rs=response.results;
  if(j.policy_hash!==await hash(s.policyJson))fail('ai_journal_policy_mismatch');
  return Object.freeze({journal:j,receipts:rs,conclusive:j.terminal_reason==='local_not_started'||j.active_attempt_no===null&&rs.length===j.attempted_count,
    usage:Object.freeze({inputTokens:rs.reduce((n,r)=>n+r.input_tokens,0),outputTokens:rs.reduce((n,r)=>n+r.output_tokens,0)}),
    attempts:Object.freeze(rs.map(r=>Object.freeze({attemptId:r.attempt_id,attemptNo:r.attempt_no,routeStep:r.route_step,
      modelAlias:r.model_alias,status:r.attempt_status,inputTokens:r.input_tokens,cachedInputTokens:r.cached_input_tokens,
      outputTokens:r.output_tokens,latencyMs:r.latency_ms,statusCode:r.status_code,errorCode:r.error_code}))) });
}

// The caller only receives closed statement descriptors from an actual ticket.
// Receipt application and expense/terminal writes are added to the same D1 batch.
export async function compileAiJournalSettlement(ticket,{outcome,anonymous=false}={}) {
  const s=scopeFor(ticket),state=await loadAiJournalSettlement(ticket),j=state.journal;
  if(!['success','failed','unknown'].includes(outcome))fail('invalid_ai_outcome');
  const list=[];
  const overflow=s.namespace==='partner'&&state.receipts.reduce((n,r)=>n+r.cost_microusd,0)>JSON.parse(s.policyJson).profile.userCostCeilingMicrousd;
  if(outcome==='success'&&!state.conclusive)fail('ai_attempts_unresolved');
  for(const r of state.receipts) if(r.expense_location==='pending')list.push({sql:`UPDATE ai_operation_receipts SET expense_location=?,applied_at=MAX(created_at,unixepoch())
    WHERE request_id=? AND attempt_no=? AND receipt_hash=? AND expense_location='pending'`,params:[anonymous||j.settlement_kind==='anonymous'?'anonymous':'owned',s.requestId,r.attempt_no,r.receipt_hash],min:1,max:1});
  if(j.state.startsWith('terminal_'))return Object.freeze(list);
  if(outcome==='unknown') {
    if(j.state==='provider_started')list.push({sql:"UPDATE ai_operation_journal SET state='unknown',revision=revision+1,updated_at=MAX(updated_at,unixepoch()) WHERE request_id=? AND state='provider_started'",params:[s.requestId],min:1,max:1});
  } else {
    if(!state.conclusive)fail('ai_attempts_unresolved');
    list.push({sql:`UPDATE ai_operation_journal SET state=?,terminal_at=MAX(admitted_at,unixepoch()),terminal_reason=?,
      revision=revision+1,updated_at=MAX(updated_at,unixepoch()) WHERE request_id=? AND state IN ('admitted','provider_started','unknown') AND active_attempt_no IS NULL`,
      params:[outcome==='success'?'terminal_succeeded':'terminal_failed',outcome==='success'?'validated_success':overflow?'provider_cost_overflow':'terminal_failure',s.requestId],min:1,max:1});
  }
  return Object.freeze(list.map(r=>Object.freeze({...r,params:Object.freeze(r.params)})));
}

// Called only inside the existing confirmed privacy transaction. Every source
// projection is reasserted on the primary in that transaction before erasure.
export async function prepareAiJournalPrivacyTransfer(env,subjectId,requestId,guardKey) {
  const db=env?.DB;
  if(env?.V141_AUTHORIZATION_ENABLED!=='true'||!db?.prepare||!Number.isSafeInteger(subjectId)||subjectId<1||
      typeof requestId!=='string'||typeof guardKey!=='string'||!guardKey.startsWith('v141_privacy_'))fail('ai_privacy_guard_invalid');
  const statements=[],checkKey='ai_privacy_'+crypto.randomUUID();let n=0;
  const add=(sql,params=[])=>statements.push(db.prepare(sql).bind(...params));
  const assert=(sql,params=[])=>add(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN (${sql}) THEN 1 ELSE 0 END)`,[checkKey+'_'+n++,...params]);
  assert(`EXISTS(SELECT 1 FROM mini_app_privacy_guard g JOIN privacy_deletion_requests p ON p.request_id=g.request_id
    WHERE g.guard_key=? AND g.subject_id=? AND g.request_id=? AND g.reason='subject_deletion' AND g.precondition_ok=1
      AND g.expires_at>unixepoch() AND p.telegram_id=? AND p.status='pending' AND unixepoch(p.expires_at)>unixepoch())`,[guardKey,subjectId,requestId,subjectId]);
  const changed=expected=>assert('changes()=?',[expected]);
  const capture=async(table,columns,where,args)=>{const chunks=[];for(let i=0;i<columns.length;i+=8)chunks.push(`json_object(${columns.slice(i,i+8).map(k=>`'${k}',${k}`).join(',')})`);const json=chunks.reduce((a,b)=>`json_patch(${a},${b})`);const sql=`SELECT json_group_array(json(${json})) FROM (SELECT * FROM ${table} WHERE ${where} ORDER BY request_id${table==='ai_gateway_attempts'?',attempt_no':''})`;const value=await db.prepare(`SELECT (${sql}) snapshot`).bind(...args).first();if(typeof value?.snapshot!=='string')fail('ai_privacy_source_unavailable');assert(`(${sql}) IS ?`,[...args,value.snapshot]);};
  await capture('ai_gateway_budget_reservations','request_id owner_telegram_id usage_date user_cycle_start_at user_cycle_end_at global_cycle_start_at global_cycle_end_at reserved_billed_tokens reserved_cost_microusd reservation_state policy_version pricing_version created_at completed_at'.split(' '),'owner_telegram_id=?',[subjectId]);
  const user=await db.prepare('SELECT telegram_id,joined_at,referral_code FROM users WHERE telegram_id=?').bind(subjectId).first();
  const generation=await accountGenerationFingerprint(user);if(!generation)fail('ai_privacy_source_missing');
  assert('EXISTS(SELECT 1 FROM users WHERE telegram_id=? AND joined_at=? AND referral_code=?)',[subjectId,user.joined_at,user.referral_code]);
  const response=await db.prepare('SELECT * FROM ai_gateway_budget_reservations WHERE owner_telegram_id=?').bind(subjectId).all();
  if(response?.success!==true||!Array.isArray(response.results)||response.results.length>100)fail('ai_privacy_source_unavailable');
  for(const old of response.results) {
    const journalId=await hash('v1.4.1.legacy.ai.cost\n'+old.request_id);
    const existing=await db.prepare('SELECT request_id FROM ai_operation_journal WHERE request_id=?').bind(old.request_id).first();
    const id=existing?old.request_id:journalId;
    const raw=await db.prepare('SELECT * FROM ai_gateway_attempts WHERE request_id=? ORDER BY attempt_no').bind(old.request_id).all();
    if(raw?.success!==true||!Array.isArray(raw.results)||raw.results.length>3)fail('ai_privacy_source_unavailable');
    await capture('ai_gateway_attempts','attempt_id request_id attempt_no route_step model_alias provider_code attempt_status input_tokens cached_input_tokens output_tokens cost_microusd latency_ms status_code error_code created_at'.split(' '),'request_id=?',[old.request_id]);
    assert(`EXISTS(SELECT 1 FROM ai_gateway_budget_reservations WHERE request_id=? AND owner_telegram_id=? AND
      reservation_state=? AND reserved_billed_tokens=? AND reserved_cost_microusd=?) AND
      (SELECT COUNT(*) FROM ai_gateway_attempts WHERE request_id=?)=?`,
      [old.request_id,subjectId,old.reservation_state,old.reserved_billed_tokens,old.reserved_cost_microusd,old.request_id,raw.results.length]);
    if(!existing) {
      const policyJson=JSON.stringify({legacyCostOnly:true,ledgerRequestId:old.request_id}),policyHash=await hash(policyJson);
      add(`INSERT INTO ai_operation_journal(request_id,namespace,subject_telegram_id,account_generation_hash,usage_date,bucket,
        admitted_at,expires_at,user_cycle_start_at,user_cycle_end_at,global_cycle_start_at,global_cycle_end_at,reserved_milli,
        reserved_billed_tokens,reserved_cost_microusd,policy_version,pricing_version,policy_json,policy_hash,primary_model_alias,state,settlement_kind,updated_at)
        VALUES(?,'partner',?,?,?,'admin',?,?,?,?,?,?,1,?,?,?,?,?,?,?,'unknown','owned',?)`,
        [id,subjectId,generation,old.usage_date,old.created_at,old.created_at+300,old.user_cycle_start_at,old.user_cycle_end_at,
          old.global_cycle_start_at,old.global_cycle_end_at,old.reserved_billed_tokens,old.reserved_cost_microusd,old.policy_version,
          old.pricing_version,policyJson,policyHash,raw.results[0]?.model_alias??'deepseek_flash_dragon',old.created_at]);changed(1);
      for(const a of raw.results) {
        const normalized={attemptId:a.attempt_id,attemptNo:a.attempt_no,routeStep:a.route_step,modelAlias:a.model_alias,
          providerCode:a.provider_code,status:a.attempt_status,inputTokens:a.input_tokens,cachedInputTokens:a.cached_input_tokens,
          outputTokens:a.output_tokens,costMicrousd:a.cost_microusd,latencyMs:a.latency_ms,statusCode:a.status_code,errorCode:a.error_code};
        add(`INSERT INTO ai_operation_receipts(request_id,attempt_no,attempt_id,route_step,model_alias,provider_code,attempt_status,
          input_tokens,cached_input_tokens,output_tokens,cost_microusd,neurons_milli,latency_ms,status_code,error_code,receipt_hash,
          expense_location,created_at,applied_at) SELECT ?,attempt_no,attempt_id,route_step,model_alias,provider_code,attempt_status,
          input_tokens,cached_input_tokens,output_tokens,cost_microusd,0,latency_ms,status_code,error_code,?,'owned',created_at,created_at
          FROM ai_gateway_attempts WHERE attempt_id=? AND request_id=?`,[id,await hash(JSON.stringify(normalized)),a.attempt_id,old.request_id]);changed(1);
      }
      if(old.reservation_state!=='reserved')add(`UPDATE ai_operation_journal SET state='terminal_failed',terminal_at=MAX(admitted_at,unixepoch()),
        terminal_reason='legacy_cost_only',revision=revision+1,updated_at=MAX(updated_at,unixepoch()) WHERE request_id=?`,[id]);
    }
  }
  // Preserve known owned attempts before their old FK cascade, then transfer
  // their immutable dedupe location. Pending real receipts remain pending.
  add(`INSERT INTO ai_gateway_daily_aggregates(usage_date,model_alias,provider_code,attempt_status,request_count,attempt_count,
    input_tokens,cached_input_tokens,output_tokens,cost_microusd,latency_ms,aggregated_at)
    SELECT j.usage_date,r.model_alias,r.provider_code,r.attempt_status,SUM(CASE WHEN r.attempt_no=1 THEN 1 ELSE 0 END),COUNT(*),
      SUM(r.input_tokens),SUM(r.cached_input_tokens),SUM(r.output_tokens),SUM(r.cost_microusd),SUM(r.latency_ms),unixepoch()
    FROM ai_operation_receipts r JOIN ai_operation_journal j ON j.request_id=r.request_id
    WHERE j.subject_telegram_id=? AND j.namespace='partner' AND r.expense_location='owned'
    GROUP BY j.usage_date,r.model_alias,r.provider_code,r.attempt_status
    ON CONFLICT(usage_date,model_alias,provider_code,attempt_status) DO UPDATE SET request_count=request_count+excluded.request_count,
      attempt_count=attempt_count+excluded.attempt_count,input_tokens=input_tokens+excluded.input_tokens,
      cached_input_tokens=cached_input_tokens+excluded.cached_input_tokens,output_tokens=output_tokens+excluded.output_tokens,
      cost_microusd=cost_microusd+excluded.cost_microusd,latency_ms=latency_ms+excluded.latency_ms,aggregated_at=unixepoch()`,[subjectId]);
  add(`UPDATE ai_operation_receipts SET expense_location='anonymous' WHERE expense_location='owned' AND request_id IN
    (SELECT request_id FROM ai_operation_journal WHERE subject_telegram_id=?)`,[subjectId]);
  add('UPDATE ai_usage_events SET telegram_id=0 WHERE telegram_id=?',[subjectId]);
  add(`UPDATE ai_operation_journal SET subject_telegram_id=NULL,account_generation_hash=NULL,generation_id=NULL,
    settlement_kind='anonymous',revision=revision+1,updated_at=MAX(updated_at,unixepoch()) WHERE subject_telegram_id=?`,[subjectId]);
  assert('NOT EXISTS(SELECT 1 FROM ai_operation_journal WHERE subject_telegram_id=?)',[subjectId]);
  add('DELETE FROM mini_app_atomic_guards WHERE guard_key LIKE ?',[checkKey+'_%']);
  return Object.freeze(statements);
}

// Additional durable obligations not already counted by the old reserved-row
// arithmetic. Pending truthful overruns and anonymous unresolved holds count
// once; already applied anonymous cost belongs to the aggregate ledger.
export async function loadAiJournalBudgetObligations(db,{namespace,usageDate,bucket,cycleStart,subjectId,accountGenerationHash,excludeRequestId=''}) {
  const sql=`SELECT j.*,
    COALESCE((SELECT SUM(cost_microusd) FROM ai_operation_receipts WHERE request_id=j.request_id AND expense_location='pending'),0) pending_cost,
    COALESCE((SELECT SUM(input_tokens+output_tokens) FROM ai_operation_receipts WHERE request_id=j.request_id AND expense_location='pending'),0) pending_tokens,
    COALESCE((SELECT SUM(cost_microusd) FROM ai_operation_receipts WHERE request_id=j.request_id AND expense_location!='pending'),0) applied_cost,
    COALESCE((SELECT SUM(input_tokens+output_tokens) FROM ai_operation_receipts WHERE request_id=j.request_id AND expense_location!='pending'),0) applied_tokens,
    COALESCE((SELECT SUM(neurons_milli) FROM ai_operation_receipts WHERE request_id=j.request_id),0) actual_neurons,
    (SELECT neurons_milli FROM ai_usage_events WHERE request_id=j.request_id) public_expense,
    (SELECT reservation_state FROM ai_gateway_budget_reservations WHERE request_id=COALESCE(json_extract(j.policy_json,'$.ledgerRequestId'),j.request_id)) old_state,
    COALESCE((SELECT MAX(b.reserved_cost_microusd-COALESCE((SELECT SUM(cost_microusd) FROM ai_gateway_attempts WHERE request_id=b.request_id),0),0)
      FROM ai_gateway_budget_reservations b WHERE b.request_id=COALESCE(json_extract(j.policy_json,'$.ledgerRequestId'),j.request_id) AND b.reservation_state='reserved'),0) old_cost_hold,
    COALESCE((SELECT MAX(b.reserved_billed_tokens-COALESCE((SELECT SUM(input_tokens+output_tokens) FROM ai_gateway_attempts WHERE request_id=b.request_id),0),0)
      FROM ai_gateway_budget_reservations b WHERE b.request_id=COALESCE(json_extract(j.policy_json,'$.ledgerRequestId'),j.request_id) AND b.reservation_state='reserved'),0) old_token_hold,
    EXISTS(SELECT 1 FROM ai_quota_reservations WHERE request_id=j.request_id AND status='reserved') old_public_hold
    FROM ai_operation_journal j WHERE namespace=? AND request_id!=? AND
      ((?='public' AND usage_date=? AND bucket=?) OR (?='partner' AND global_cycle_start_at=?))`;

  const args=[namespace,excludeRequestId,namespace,usageDate,bucket,namespace,cycleStart??0];
  const fields=['request_id','revision','namespace','state','subject_telegram_id','account_generation_hash','terminal_reason','reserved_milli','reserved_cost_microusd','reserved_billed_tokens','pending_cost','pending_tokens','applied_cost','applied_tokens','actual_neurons','public_expense','old_state','old_cost_hold','old_token_hold','old_public_hold'];
  const groups=fields.reduce((xs,k,i)=>{if(i%8===0)xs.push([]);xs.at(-1).push(k);return xs;},[]).map(xs=>`json_object(${xs.map(k=>`'${k}',${k}`).join(',')})`);
  const json=groups.reduce((a,b)=>`json_patch(${a},${b})`);
  const snapshotSql=`SELECT json_group_array(json(${json})) FROM (${sql} ORDER BY request_id)`;
  const result=await db.prepare(`SELECT (${snapshotSql}) AS snapshot`).bind(...args).all();
  if(result?.success!==true||result.results?.length!==1||typeof result.results[0].snapshot!=='string')fail('ai_journal_unavailable');
  const snapshot=result.results[0].snapshot,rows=JSON.parse(snapshot);
  const totals={globalCost:0,globalTokens:0,userCost:0,userTokens:0,neurons:0,inFlight:false,overflow:false};
  for(const j of rows) {
    for(const k of ['pending_cost','pending_tokens','applied_cost','applied_tokens','actual_neurons','old_cost_hold','old_token_hold','old_public_hold'])integer(j[k],Number.MAX_SAFE_INTEGER);
    const active=['admitted','provider_started','unknown'].includes(j.state);
    const sameOwner=j.subject_telegram_id===subjectId&&j.account_generation_hash===accountGenerationHash;
    if(active&&sameOwner)totals.inFlight=true;
    if(j.namespace==='public') {
      const obligation=Math.max(j.actual_neurons,active?j.reserved_milli:0);
      totals.neurons+=Math.max(0,obligation-(j.public_expense??0)-(j.old_public_hold?j.reserved_milli:0));
    } else {
      const cost=j.old_state==='reserved'?Math.max(0,j.pending_cost-j.old_cost_hold):
        Math.max(j.pending_cost,active?Math.max(0,j.reserved_cost_microusd-j.applied_cost):0);
      const tokens=j.old_state==='reserved'?Math.max(0,j.pending_tokens-j.old_token_hold):
        Math.max(j.pending_tokens,active?Math.max(0,j.reserved_billed_tokens-j.applied_tokens):0);
      totals.globalCost+=cost;totals.globalTokens+=tokens;
      if(sameOwner){totals.userCost+=cost;totals.userTokens+=tokens;
        if(j.terminal_reason==='provider_cost_overflow')totals.overflow=true;}
    }
  }
  for(const [k,v] of Object.entries(totals))if(typeof v==='number')integer(v,Number.MAX_SAFE_INTEGER);
  return Object.freeze({...totals,assertion:Object.freeze({sql:`(${snapshotSql}) IS ?`,params:Object.freeze([...args,snapshot])})});
}

// Restart recovery has a fixed service purpose and cannot call a provider,
// save a draft/history, deliver content, or convert a failed request to success.
export function createAiRecoveryExecutor({binding,env}={}) {
  if(env?.V141_AUTHORIZATION_ENABLED!=='true')fail('v141_runtime_disabled');
  return Object.freeze({async run({requestId}={}) {
    if(typeof requestId!=='string'||!/^[0-9a-f]{64}$/u.test(requestId))fail('ai_recovery_request_invalid');
    const [{createServiceExecutor},{createRuntimeAuthorizer},{assertRuntimeBindingReady}]=await Promise.all([
      import('./trusted-context.mjs'),import('./runtime-authorizer.mjs'),import('./runtime-binding.mjs')]);
    await assertRuntimeBindingReady({binding,env});
    const context=createServiceExecutor({binding,env,purpose:'ai_settle_cost'}).createContext({requestPayload:{requestId}});
    const auth=readRuntimeAuthorization(requireRuntimeAuthorization(await createRuntimeAuthorizer().authorize(context,{kind:'ai_operation_journal',key:requestId})));
    const identity=readTrustedContext(context),db=identity.db,j=await row(db,requestId);
    const response=await db.prepare('SELECT * FROM ai_operation_receipts WHERE request_id=? ORDER BY attempt_no').bind(requestId).all();
    if(response?.success!==true||!Array.isArray(response.results))fail('ai_journal_unavailable');
    if(j.state==='terminal_succeeded')return Object.freeze({ok:true,replay:true,outcome:'success',deliverAllowed:false});
    const rs=response.results,pending=rs.filter(r=>r.expense_location==='pending'),b=builder(db);
    for(const p of compileDecisionAssertions(auth.decision).assertions)b.assert(p.sql,p.params);
    const ledgerId=JSON.parse(j.policy_json).ledgerRequestId??requestId;
    const old=await db.prepare('SELECT * FROM ai_gateway_budget_reservations WHERE request_id=?').bind(ledgerId).first();
    const user=j.subject_telegram_id===null?null:await db.prepare('SELECT telegram_id,joined_at,referral_code FROM users WHERE telegram_id=?').bind(j.subject_telegram_id).first();
    const sameGeneration=user!==null&&await accountGenerationFingerprint(user)===j.account_generation_hash;
    const totalCost=rs.reduce((n,r)=>n+r.cost_microusd,0),totalTokens=rs.reduce((n,r)=>n+r.input_tokens+r.output_tokens,0);
    const overflow=j.namespace==='partner'&&(totalCost>2_000_000||totalTokens>30_000_000||rs.some(r=>r.cost_microusd>2_000_000));
    const anonymous=j.settlement_kind==='anonymous'||!sameGeneration||!old||overflow;
    for(const r of pending) {
      b.assert("EXISTS(SELECT 1 FROM ai_operation_receipts WHERE request_id=? AND attempt_no=? AND receipt_hash=? AND expense_location='pending')",[requestId,r.attempt_no,r.receipt_hash]);
      if(j.namespace==='partner') {
        if(anonymous)b.add(`INSERT INTO ai_gateway_daily_aggregates(usage_date,model_alias,provider_code,attempt_status,
          request_count,attempt_count,input_tokens,cached_input_tokens,output_tokens,cost_microusd,latency_ms,aggregated_at)
          VALUES(?,?,?,?,?,1,?,?,?,?,?,unixepoch()) ON CONFLICT(usage_date,model_alias,provider_code,attempt_status) DO UPDATE SET
          request_count=request_count+excluded.request_count,attempt_count=attempt_count+1,input_tokens=input_tokens+excluded.input_tokens,
          cached_input_tokens=cached_input_tokens+excluded.cached_input_tokens,output_tokens=output_tokens+excluded.output_tokens,
          cost_microusd=cost_microusd+excluded.cost_microusd,latency_ms=latency_ms+excluded.latency_ms,aggregated_at=unixepoch()`,
          [j.usage_date,r.model_alias,r.provider_code,r.attempt_status,r.attempt_no===1?1:0,r.input_tokens,r.cached_input_tokens,r.output_tokens,r.cost_microusd,r.latency_ms]);
        else {
          b.assert('EXISTS(SELECT 1 FROM users WHERE telegram_id=? AND joined_at=? AND referral_code=?)',[j.subject_telegram_id,user.joined_at,user.referral_code]);
          b.add(`INSERT INTO ai_gateway_attempts(attempt_id,request_id,attempt_no,route_step,model_alias,provider_code,attempt_status,
            input_tokens,cached_input_tokens,output_tokens,cost_microusd,latency_ms,status_code,error_code,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,MAX(?,unixepoch()))`,[r.attempt_id,ledgerId,r.attempt_no,r.route_step,r.model_alias,r.provider_code,
              r.attempt_status,r.input_tokens,r.cached_input_tokens,r.output_tokens,r.cost_microusd,r.latency_ms,r.status_code,r.error_code,j.admitted_at]);
        }
      }
      b.add("UPDATE ai_operation_receipts SET expense_location=?,applied_at=MAX(created_at,unixepoch()) WHERE request_id=? AND attempt_no=? AND expense_location='pending' AND receipt_hash=?",
        [anonymous?'anonymous':'owned',requestId,r.attempt_no,r.receipt_hash]);
    }
    const cost=j.namespace==='public'?Math.max(rs.reduce((n,r)=>n+r.neurons_milli,0),j.active_attempt_no!==null?j.reserved_milli:0):0;
    b.add(`INSERT OR IGNORE INTO ai_usage_events(request_id,telegram_id,usage_date,bucket,status,neurons_milli,error_code)
      VALUES(?,0,?,?,'failed',?,?)`,[ledgerId,j.usage_date,j.bucket,cost,overflow?'provider_cost_overflow':j.active_attempt_no!==null?'provider_unknown':'recovered_cost_only'],0,1);
    if(j.namespace==='public')b.add("UPDATE ai_usage_events SET neurons_milli=MAX(neurons_milli,?) WHERE request_id=? AND status='failed'",[cost,ledgerId],1);
    if(overflow)b.add("UPDATE ai_usage_events SET error_code='provider_cost_overflow' WHERE request_id=? AND status='failed'",[ledgerId],1);
    b.add("UPDATE ai_quota_reservations SET status='released',completed_at=CURRENT_TIMESTAMP WHERE request_id=? AND status='reserved'",[ledgerId],0,1);
    const conclusive=j.active_attempt_no===null&&!(JSON.parse(j.policy_json).legacyCostOnly===true&&j.state==='unknown');
    if(conclusive) {
      b.add("UPDATE ai_gateway_budget_reservations SET reservation_state='released',completed_at=MAX(created_at,unixepoch()) WHERE request_id=? AND reservation_state='reserved'",[ledgerId],0,1);
      if(!j.state.startsWith('terminal_'))b.add(`UPDATE ai_operation_journal SET state='terminal_failed',terminal_at=MAX(admitted_at,unixepoch()),terminal_reason=?,
        revision=revision+1,updated_at=MAX(updated_at,unixepoch()) WHERE request_id=? AND state IN ('admitted','provider_started','unknown') AND active_attempt_no IS NULL`,[overflow?'provider_cost_overflow':'recovered_cost_only',requestId]);
    } else if(j.state==='provider_started')b.add("UPDATE ai_operation_journal SET state='unknown',revision=revision+1,updated_at=MAX(updated_at,unixepoch()) WHERE request_id=? AND state='provider_started'",[requestId]);
    await commit(db,b.finish());return Object.freeze({ok:true,outcome:conclusive?'failed':'unknown',appliedReceipts:pending.length,deliverAllowed:false});
  }});
}
