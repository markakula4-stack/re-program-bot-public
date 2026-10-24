import {hasLegacyCompatibilityEnv,isLegacyCompatibilityBinding,readLegacyCompatibilityEnv,assertLegacyCompatibilityFresh,
  prepareLegacyCompatibility,bindLegacyCompatibilityEnv} from './telegram-legacy-compatibility.mjs';
import {readTrustedContext,deriveTrustedOperationContext,refreshTrustedContext} from './trusted-context.mjs';
import {createRuntimeAuthorizer} from './runtime-authorizer.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code,status:403});};
function preflight(env,telegramId){
  if(!hasLegacyCompatibilityEnv(env)){
    if(env?.V141_AUTHORIZATION_ENABLED==='true'||isLegacyCompatibilityBinding(env?.DB))fail('preview_compatibility_required');
    return null;
  }
  const scoped=readLegacyCompatibilityEnv(env),trusted=readTrustedContext(scoped.context),payload=trusted.requestPayload;
  if(scoped.accountingOnly||scoped.family!=='channel.check_membership'||trusted.operation!=='channel.check_membership'||
    trusted.channel!=='telegram_callback'||trusted.telegramId!==telegramId||!payload||Object.keys(payload).length!==1||
    payload.action!=='preview_check')fail('preview_preflight_scope_mismatch');
  return {scoped,trusted};
}
export async function assertLegacyPreviewMembershipFresh(env,telegramId){
  if(preflight(env,telegramId))await assertLegacyCompatibilityFresh(env,{family:'channel.check_membership',actorId:telegramId});
  return env;
}
export async function upgradeLegacyPreviewActivation(env,telegramId){
  const p=preflight(env,telegramId);if(!p)return env;
  const fresh=await refreshTrustedContext(p.scoped.context);
  const context=await deriveTrustedOperationContext(fresh,{operation:'preview.activate_own',requestPayload:{}});
  const authorization=await createRuntimeAuthorizer().authorize(context);
  const permit=await prepareLegacyCompatibility(authorization,{family:'preview.activate_own'});
  const original={...env,DB:p.scoped.originalBinding,V141_AUTHORIZATION_ENABLED:p.trusted.env.V141_AUTHORIZATION_ENABLED};
  return bindLegacyCompatibilityEnv(permit,original);
}
