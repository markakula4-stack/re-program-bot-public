import {readTrustedContext,refreshTrustedContext} from './trusted-context.mjs';
import {createRuntimeAuthorizer,readRuntimeAuthorization,requireRuntimeAuthorization,assertRuntimeAuthorizationFresh} from './runtime-authorizer.mjs';
import {assertRuntimeBindingReady} from './runtime-binding.mjs';
import {createAiQuotaSettlement} from './ai-quota-settlement.mjs';
import {startAiJournalAttempt,recordAiJournalResult,markAiJournalUnknown,loadAiJournalSettlement} from './ai-recovery-journal.mjs';
import {createProviderScopedUserId} from '../v1.3.8/ai-partner-foundation.mjs';
import {buildAiGatewayProviderEnvelope} from '../v1.3.8/ai-partner-gateway.mjs';
import {createPublicAiQwenTransport} from '../v1.3.8/ai-partner-provider-transports.mjs';

const executions=new WeakMap();
let authorizerInstance,settlementInstance;
const authorizer={authorize(...args){return (authorizerInstance??=createRuntimeAuthorizer()).authorize(...args);}};
const settlement={admit(...args){return (settlementInstance??=createAiQuotaSettlement()).admit(...args);},settle(...args){return (settlementInstance??=createAiQuotaSettlement()).settle(...args);}};
const fail=code=>{throw Object.assign(new Error(code),{code,status:403});};
const read=execution=>{const value=executions.get(execution);if(!value)fail('untrusted_ai_execution');return value;};
async function fresh(e) {
  const context=await refreshTrustedContext(e.context);
  const authorization=requireRuntimeAuthorization(await authorizer.authorize(context));
  await assertRuntimeAuthorizationFresh(authorization);return authorization;
}
export async function beginPublicAiExecution(env,context) {
  const identity=readTrustedContext(context);
  if(identity.operation!=='ai.public_chat')fail('ai_operation_mismatch');
  await assertRuntimeBindingReady({binding:env.DB,env});
  const authorization=requireRuntimeAuthorization(await authorizer.authorize(context)),a=readRuntimeAuthorization(authorization);
  const admitted=await settlement.admit(a.actor,a.decision);
  if(!admitted.ok)fail(admitted.reason);
  const execution=Object.freeze({version:1});
  executions.set(execution,{env,context,ticket:admitted.ticket,phase:'admitted',attempt:null,recovery:Promise.resolve(),terminal:null});return execution;
}
export async function invokePublicAi(execution,request) {
  const e=read(execution);if(e.phase!=='admitted')fail('ai_execution_already_started');
  const identity=readTrustedContext(e.context),prompt=identity.requestPayload?.prompt??identity.requestPayload?.text;
  if(typeof prompt!=='string'||request?.messages?.at(-1)?.role!=='user'||request.messages.at(-1).content!==`${prompt}\n/no_think`)fail('ai_prompt_binding_mismatch');
  const authorization=await fresh(e);
  e.attempt=await startAiJournalAttempt(e.ticket,authorization,{attemptNo:1,routeStep:'primary',modelAlias:'qwen_safe'});
  e.phase='provider_started';
  const transport=createPublicAiQwenTransport(e.env);
  // A timeout does not replace the genuine transport promise. Its later real
  // receipt is drained as cost only; it can never deliver or revive success.
  const provider=Promise.resolve().then(()=>transport(request));
  const recorded=provider.then(async result=>{e.providerTerminal=result;const r=await recordAiJournalResult(e.attempt,result);e.receipt=r;return result;},
    async error=>{e.providerTerminal=error;e.receipt=await recordAiJournalResult(e.attempt,error);throw error;});
  let timeout;
  const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Object.assign(new Error('provider_unknown'),{code:'provider_unknown'})),30_000);});
  e.recovery=recorded.then(async()=>{if(e.phase==='unknown')return settlement.settle(e.ticket,{outcome:'failed'});},
    async()=>{if(e.phase==='unknown'&&e.providerTerminal){e.receipt=await recordAiJournalResult(e.attempt,e.providerTerminal);if(e.receipt.known)return settlement.settle(e.ticket,{outcome:'failed'});}});
  try {const result=await Promise.race([recorded,deadline]);clearTimeout(timeout);
    if(!e.receipt?.known) {await markAiJournalUnknown(e.attempt);e.phase='unknown';await settlement.settle(e.ticket,{outcome:'unknown'});fail('provider_unknown');}
    e.phase='provider_completed';return result;
  } catch(error) {clearTimeout(timeout);
    if(!e.receipt?.known){await markAiJournalUnknown(e.attempt);e.phase='unknown';await settlement.settle(e.ticket,{outcome:'unknown'});e.recovery=e.recovery.then(async()=>{if(!e.receipt?.known&&e.providerTerminal)e.receipt=await recordAiJournalResult(e.attempt,e.providerTerminal);const late=await loadAiJournalSettlement(e.ticket);if(late.conclusive&&late.receipts.length)return settlement.settle(e.ticket,{outcome:'failed'});});}
    else e.phase='provider_completed';throw error;
  }
}
export async function completePublicAi(execution,{answer,sourceCount=0,remember=false}={}) {
  const e=read(execution);if(e.terminal)return Object.freeze({...e.terminal,replay:true,deliverAllowed:false});
  if(e.phase!=='provider_completed'||!e.receipt?.known)fail('ai_attempts_unresolved');
  // Refresh immediately before settlement; loss suppresses the user effect,
  // while the fixed ticket still authorizes genuine incurred-cost accounting.
  let permitted=true;try {await fresh(e);}catch {permitted=false;}
  e.terminal=await settlement.settle(e.ticket,{outcome:permitted?'success':'failed',answer,sourceCount,remember});
  e.phase='terminal';return e.terminal;
}
export async function failPublicAi(execution,error) {
  const e=read(execution);if(e.terminal)return Object.freeze({...e.terminal,replay:true,deliverAllowed:false});
  const state=await loadAiJournalSettlement(e.ticket),unknown=e.phase==='unknown'||!state.conclusive;
  e.terminal=await settlement.settle(e.ticket,{outcome:unknown?'unknown':'failed'});
  if(!unknown)e.phase='terminal';return e.terminal;
}
export async function assertAiDeliveryFresh(execution) {
  const e=read(execution);if(e.terminal?.outcome!=='success'||!e.terminal.deliverAllowed)fail('ai_delivery_denied');
  await fresh(e);return true;
}
export function drainAiRecovery(execution){return read(execution).recovery;}
export const v141AiRuntime=Object.freeze({beginPublicAiExecution,invokePublicAi,completePublicAi,failPublicAi,assertAiDeliveryFresh,drainAiRecovery});

// Existing closed owner executor calls this only after its actual generation,
// approved fact bundle and fixed provider request have been prepared.
export async function runAuthorizedAiPartnerGateway({env,context,request,transports,validateOutput,timeoutMs=30_000}={}) {
  const identity=readTrustedContext(context);if(identity.operation!=='ai.partner_draft')fail('ai_operation_mismatch');
  await assertRuntimeBindingReady({binding:env.DB,env});
  const authorization=requireRuntimeAuthorization(await authorizer.authorize(context)),a=readRuntimeAuthorization(authorization);
  const admission=await settlement.admit(a.actor,a.decision);if(!admission.ok)return Object.freeze({...admission,requestId:identity.operationId});
  const e={env,context,ticket:admission.ticket,phase:'admitted',attempt:null,recovery:Promise.resolve(),terminal:null};
  const execution=Object.freeze({version:1});executions.set(execution,e);
  const scope=(await loadAiJournalSettlement(e.ticket)).journal,model=scope.primary_model_alias;
  if(request.maxOutputTokens>JSON.parse(scope.policy_json).sizing.maxOutputTokens)fail('ai_output_limit_not_admitted');
  const auth=await fresh(e);e.attempt=await startAiJournalAttempt(e.ticket,auth,{attemptNo:1,routeStep:'primary',modelAlias:model});e.phase='provider_started';
  const transport=model==='deepseek_flash_dragon'?transports?.deepseekFlash:transports?.qwenSafe;
  let timer;
  const controller=new AbortController();
  const providerUserId=await createProviderScopedUserId({telegramId:identity.telegramId,secret:identity.env.AI_PARTNER_PROVIDER_USER_ID_SECRET});
  const envelope=buildAiGatewayProviderEnvelope({modelAlias:model,payload:request.payload,providerUserId,maxOutputTokens:request.maxOutputTokens});
  const actual=Promise.resolve().then(()=>{if(typeof transport!=='function')fail('provider_unavailable');return transport(envelope,{signal:controller.signal});});
  const conclusive=actual.then(async r=>{e.providerTerminal=r;e.receipt=await recordAiJournalResult(e.attempt,r);return r;},async error=>{e.providerTerminal=error;e.receipt=await recordAiJournalResult(e.attempt,error);throw error;});
  e.recovery=conclusive.then(async()=>{if(e.phase==='unknown')return settlement.settle(e.ticket,{outcome:'failed'});},
    async()=>{if(e.phase==='unknown'&&e.providerTerminal){e.receipt=await recordAiJournalResult(e.attempt,e.providerTerminal);if(e.receipt.known)return settlement.settle(e.ticket,{outcome:'failed'});}});
  try {
    const result=await Promise.race([conclusive,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error('provider_unknown'),{code:'provider_unknown'}));},Math.max(100,Math.min(30_000,timeoutMs)));})]);clearTimeout(timer);
    if(!e.receipt?.known)fail('provider_unknown');
    const output=await validateOutput(result.content);
    await fresh(e);
    const receiptState=await loadAiJournalSettlement(e.ticket);
    const completed=await settlement.settle(e.ticket,{outcome:'success',answer:output?.validated?.content??'Проверенный черновик готов.',sourceCount:request.sourceCount??0});
    e.terminal=completed;e.phase='terminal';if(!completed.deliverAllowed)return Object.freeze({ok:false,requestId:identity.operationId,reason:completed.reason??'authorization_lost'});
    const rs=receiptState.receipts;
    return Object.freeze({ok:true,requestId:identity.operationId,modelAlias:model,fallbackUsed:false,output,
      telemetry:Object.freeze({attemptCount:rs.length,retryCount:0,billedTokens:rs.reduce((n,r)=>n+r.input_tokens+r.output_tokens,0),
        cachedInputTokens:rs.reduce((n,r)=>n+r.cached_input_tokens,0),costMicrousd:rs.reduce((n,r)=>n+r.cost_microusd,0),totalLatencyMs:rs.reduce((n,r)=>n+r.latency_ms,0)}),execution});
  } catch(error) {clearTimeout(timer);const state=await loadAiJournalSettlement(e.ticket);
    const unknown=!state.conclusive;e.phase=unknown?'unknown':'provider_completed';
    if(unknown)await markAiJournalUnknown(e.attempt);
    await settlement.settle(e.ticket,{outcome:unknown?'unknown':'failed'});
    // Drain a reply that won the transport race during the unknown-state CAS.
    if(unknown)e.recovery=e.recovery.then(async()=>{if(!e.receipt?.known&&e.providerTerminal)e.receipt=await recordAiJournalResult(e.attempt,e.providerTerminal);const late=await loadAiJournalSettlement(e.ticket);if(late.conclusive&&late.receipts.length)return settlement.settle(e.ticket,{outcome:'failed'});});
    error.aiRecovery=e.recovery;throw error;
  }
}

// Only the already released owner draft writer receives this fixed binding.
// Each existing batch carries fresh canonical generation/privacy/source guards;
// no caller-provided actor or SQL attestation can replace those guards.
export function createAiPartnerPersistenceBinding(execution) {
  const e=read(execution),db=readTrustedContext(e.context).db;
  if(readTrustedContext(e.context).operation!=='ai.partner_draft'||e.terminal?.outcome!=='success')fail('ai_persistence_denied');
  return Object.freeze({prepare:sql=>db.prepare(sql),async batch(statements) {
    const authorization=await fresh(e),{compileDecisionAssertions}=await import('./entitlement-engine.mjs');
    const proof=compileDecisionAssertions(readRuntimeAuthorization(authorization).decision),key='ai_save_'+crypto.randomUUID();
    const checks=proof.assertions.map((p,i)=>db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
      VALUES(?,CASE WHEN (${p.sql}) THEN 1 ELSE 0 END)`).bind(key+'_'+i,...p.params));
    const all=[...checks,...statements,db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key LIKE ?').bind(key+'_%')];
    const result=await db.batch(all);if(!Array.isArray(result)||result.length!==all.length||result.some(r=>r?.success!==true))fail('ai_persistence_commit_unverified');
    return result.slice(checks.length,-1);
  }});
}
