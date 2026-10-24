import {createServiceExecutor,readTrustedContext} from './trusted-context.mjs';
import {createRuntimeAuthorizer,readRuntimeAuthorization,requireRuntimeAuthorization} from './runtime-authorizer.mjs';
import {compileDecisionAssertions} from './entitlement-engine.mjs';
import {assertRuntimeBindingReady} from './runtime-binding.mjs';
import {createAiRecoveryExecutor} from './ai-recovery-journal.mjs';
import {readV141ReleaseConfig,V141_RELEASE_CONFIG_FIELDS} from './release-config.mjs';

const recoveryProviderFlags=Object.freeze(['FEATURE_RE_AI_SHELL','AI_PARTNER_ENABLED',
  'AI_PARTNER_OWNER_GENERATION_ENABLED','AI_PARTNER_EXTERNAL_PROVIDER_ENABLED']);
function aiCostServiceEnv(env) {
  if(env?.V141_AUTHORIZATION_ENABLED==='true')return env;
  // Only the compiled rollback mode can open this fixed cost-only service.
  // A physical env override or request payload cannot select recovery mode.
  const compiled=readV141ReleaseConfig();
  if(compiled?.V141_RELEASE_MODE!=='recovery'||
      V141_RELEASE_CONFIG_FIELDS.some(field=>env?.[field]!==compiled[field])||
      recoveryProviderFlags.some(flag=>env?.[flag]!=='false'))return null;
  // This local env is never returned/bound to a customer or a provider executor.
  return {...env,V141_AUTHORIZATION_ENABLED:'true'};
}

// Existing outbox has one fixed service purpose; a payload supplies only the
// canonical pending item selector. It cannot choose an actor, plan or purpose.
export async function prepareOutboxServiceFence(env,{kind,key}) {
  await assertRuntimeBindingReady({binding:env.DB,env});
  if(!['effect_outbox','effect_claim'].includes(kind)||typeof key!=='string'||key.length>256)throw new Error('invalid_outbox_source');
  const executor=createServiceExecutor({binding:env.DB,env,purpose:'outbox_drain'});
  const context=executor.createContext({requestPayload:{}});
  const bundle=requireRuntimeAuthorization(await createRuntimeAuthorizer().authorize(context,{kind,key}));
  const {decision}=readRuntimeAuthorization(bundle),proof=compileDecisionAssertions(decision),pieces=proof.assertions??[proof];
  if(!pieces.length||pieces.length>96)throw new Error('outbox_guard_limit');
  const keys=pieces.map(()=>`v141service_${crypto.randomUUID()}`);
  return Object.freeze({
    before:Object.freeze(pieces.map((p,i)=>Object.freeze({sql:`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN (${p.sql}) THEN 1 ELSE 0 END)`,params:Object.freeze([keys[i],...p.params])}))),
    after:Object.freeze(keys.map(key=>Object.freeze({sql:'DELETE FROM mini_app_atomic_guards WHERE guard_key=?',params:Object.freeze([key])}))),
    validUntil:readTrustedContext(context).expiresAt,
  });
}

// At most one expired durable operation per existing maintenance tick. This
// fixed executor records incurred costs and never retries a provider/output.
export async function drainRuntimeAiRecovery(env) {
  const serviceEnv=aiCostServiceEnv(env);
  if(!serviceEnv)return {status:'closed'};
  await assertRuntimeBindingReady({binding:serviceEnv.DB,env:serviceEnv});
  const db=serviceEnv.DB.withSession('first-primary');
  const result=await db.prepare(`SELECT j.request_id FROM ai_operation_journal j
    WHERE j.expires_at<=unixepoch() AND j.state!='terminal_succeeded'
      AND (j.state IN ('admitted','provider_started') OR EXISTS
        (SELECT 1 FROM ai_operation_receipts r WHERE r.request_id=j.request_id AND r.expense_location='pending'))
    ORDER BY j.expires_at,j.request_id LIMIT 1`).all();
  if(result?.success!==true||!Array.isArray(result.results))throw new Error('ai_recovery_source_unavailable');
  if(!result.results.length)return {status:'idle'};
  return createAiRecoveryExecutor({binding:serviceEnv.DB,env:serviceEnv}).run({requestId:result.results[0].request_id});
}
