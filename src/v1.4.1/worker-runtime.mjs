import { createCustomerContext, deriveTrustedOperationContext, readTrustedContext,
  captureTelegramFlowContext, releaseConsumedTelegramFlowContext } from './trusted-context.mjs';
import { assertRuntimeBindingReady, runtimeBindingEnabled, bindRuntimeContext,
  inheritRuntimeContext, runtimeContext } from './runtime-binding.mjs';
import { createRuntimeAuthorizer, readRuntimeAuthorization, requireRuntimeAuthorization,
  assertRuntimeAuthorizationFresh } from './runtime-authorizer.mjs';
import { createAtomicAdmission } from './atomic-admission.mjs';
import { readResourceFacts } from './resource-resolver.mjs';
import { registerRuntimeAccount, rememberRuntimeOwnHelp } from './account-runtime.mjs';
import { authorizeTelegramHandler, assertTelegramPresentationFresh,
  executeLegacyTelegramMutation, executeTelegramFlowState, compileTelegramMutationFence,
  authorizeLegacyTelegramFlow,claimedTelegramRegistrationHandler } from './telegram-runtime.mjs';
import {prepareLegacyCompatibility,bindLegacyCompatibilityEnv,isLegacyCompatibilityEnv,
  inheritLegacyCompatibilityEnv,assertLegacyBroadcastDeliveryFresh} from './telegram-legacy-compatibility.mjs';
import {scopeV141ReleaseActor} from './release-scope.mjs';

export const V141_WORKER_RUNTIME_KEY='__RE_PROGRAM_V141_AUTHORIZATION_RUNTIME__';
// Existing fixed domain producers require a genuine centrally allowed permit
// and a same-batch write fence before compatibility execution can begin.
export const P04_DEFERRED_TELEGRAM_CAPABILITIES=Object.freeze([
  'admin.catalog.manage','admin.settings.manage','admin.partner_link.review','admin.broadcast.send',
  'admin.result.repair','admin.user.moderation','admin.stars.refund','admin.stars.reconcile',
  'partner.link.manage_own','preview.activate_own','referral.bonus.claim_own','billing.purchase_monthly',
  'offer.open_action','channel.check_membership',
]);
const deferred=new Set(P04_DEFERRED_TELEGRAM_CAPABILITIES);
const deferredFlows=new Set(['submit_partner_link','review_partner_link_reject','create_offer','edit_offer','compose_broadcast']);
const fail=code=>{throw Object.assign(new Error(code),{code,status:503});};
export function installV141WorkerRuntime({aiRuntime,telegramRuntime,privacyRuntime}={}) {
  const authorizer=createRuntimeAuthorizer(),atomic=createAtomicAdmission();
  const executionContexts=new WeakMap();
  const consumedFlows=new WeakMap();
  const contextForEnv=env=>consumedFlows.get(env)??runtimeContext(env);
  const operationContext=async(env,operation,requestPayload)=>{
    runtimeContext(env); // Current primitive configuration must still match.
    const original=contextForEnv(env);
    return deriveTrustedOperationContext(original,{operation,...(requestPayload===undefined?{}:{requestPayload})});
  };
  const authorize=async(env,operation,requestPayload,ref=null)=>{
    const bundle=await authorizer.authorize(await operationContext(env,operation,requestPayload),ref);
    requireRuntimeAuthorization(bundle);
    return bundle;
  };
  const runtime=Object.freeze({
    version:1,isEnabled:runtimeBindingEnabled,
    scopeActor:scopeV141ReleaseActor,
    async guardBroadcastDelivery(env,{actorId,broadcastId,recipientId,claimToken}) {
      if(!isLegacyCompatibilityEnv(env))return;
      await assertLegacyBroadcastDeliveryFresh(env,{actorId,broadcastId,recipientId,claimToken});
    },
    inheritCompatible(source,target) {
      return isLegacyCompatibilityEnv(source)?inheritLegacyCompatibilityEnv(source,target):runtime.inherit(source,target);
    },
    inherit(source,target) {
      inheritRuntimeContext(source,target);
      const ctx=executionContexts.get(source);if(ctx)executionContexts.set(target,ctx);
      const flow=consumedFlows.get(source);if(flow)consumedFlows.set(target,flow);
      return target;
    },
    assertReady:env=>assertRuntimeBindingReady({binding:env.DB,env}),operationContext,
    async enterTelegram({env,request,receiptClaimToken,update,executionContext}) {
      if(update.pre_checkout_query) {
        // The outer actual webhook has verified secret/body and claimed the
        // processing receipt. The fixed Stars processor separately validates
        // its existing order/payment source; no customer principal is minted.
        return {...env};
      }
      const context=await createCustomerContext({binding:env.DB,env,webhookRequest:request,
        receiptClaimToken,channel:update.callback_query?'telegram_callback':'telegram_command',operation:'account.register'});
      const scoped=bindRuntimeContext({...env},context);
      if(executionContext?.waitUntil)executionContexts.set(scoped,executionContext);
      return scoped;
    },
    async read(env,operation,requestPayload,ref=null) {
      const bundle=await authorize(env,operation,requestPayload,ref);
      await assertRuntimeAuthorizationFresh(bundle);return bundle;
    },
    async guardDispatch(env,update) {
      const registration=claimedTelegramRegistrationHandler(runtimeContext(env),update);
      if(registration)return registration;
      const selected=await authorizeTelegramHandler(runtimeContext(env),update)??
        await authorizeLegacyTelegramFlow(contextForEnv(env),update);
      if(selected&&selected.handler.effect!=='read'&&deferred.has(selected.handler.capability)) {
        if(env.V141_LEGACY_COMPATIBILITY_ENABLED!=='true')fail('v141_adapter_pending');
        const permit=await prepareLegacyCompatibility(selected.authorization,{family:selected.handler.capability});
        return Object.freeze({...selected,executionEnv:bindLegacyCompatibilityEnv(permit,env)});
      }
      if(selected?.handler.effect==='read')await assertTelegramPresentationFresh(selected.authorization);
      return selected;
    },
    async readFlow(env,userId,kind) {
      if(readTrustedContext(runtimeContext(env)).telegramId!==userId)fail('runtime_subject_mismatch');
      const captured=await captureTelegramFlowContext(contextForEnv(env),{kind});
      if(captured.row&&deferredFlows.has(captured.row.action)&&env.V141_LEGACY_COMPATIBILITY_ENABLED!=='true')fail('v141_adapter_pending');
      consumedFlows.set(env,captured.context);return captured.row;
    },
    async stageFlow(env,userId,kind,mode,session) {
      if(readTrustedContext(runtimeContext(env)).telegramId!==userId)fail('runtime_subject_mismatch');
      if(mode==='set'&&deferredFlows.has(session?.action)&&env.V141_LEGACY_COMPATIBILITY_ENABLED!=='true')fail('v141_adapter_pending');
      await assertRuntimeBindingReady({binding:env.DB,env});
      const result=await executeTelegramFlowState(contextForEnv(env),{kind,mode,...(session===undefined?{}:{session})});
      consumedFlows.set(env,releaseConsumedTelegramFlowContext(contextForEnv(env),{kind}));
      return result;
    },
    async registerAccount(env,userId,referralCode,referralKind='legacy') {
      if(readTrustedContext(runtimeContext(env)).telegramId!==userId)fail('runtime_subject_mismatch');
      await assertRuntimeBindingReady({binding:env.DB,env});
      return registerRuntimeAccount(contextForEnv(env),{referralCode,referralKind});
    },
    async rememberOwnHelp(env,userId,userText,answer) {
      if(readTrustedContext(runtimeContext(env)).telegramId!==userId)fail('runtime_subject_mismatch');
      await assertRuntimeBindingReady({binding:env.DB,env});
      return rememberRuntimeOwnHelp(contextForEnv(env),{userText,answer});
    },
    async legacy(env,userId,operation,requestPayload,ref=null) {
      if(readTrustedContext(runtimeContext(env)).telegramId!==userId)fail('runtime_subject_mismatch');
      const bundle=await authorizer.authorize(await operationContext(env,operation,requestPayload),ref);
      const result=await executeLegacyTelegramMutation(bundle);
      if(operation==='flow.cancel_own') {
        let context=contextForEnv(env);
        for(const kind of ['admin','partner'])context=releaseConsumedTelegramFlowContext(context,{kind});
        consumedFlows.set(env,context);
      }
      return result;
    },
    async mutate(env,operation,requestPayload,ref=null) {
      await assertRuntimeBindingReady({binding:env.DB,env});
      const bundle=await authorizer.authorize(await operationContext(env,operation,requestPayload),ref);
      return atomic.admit({decision:readRuntimeAuthorization(bundle).decision});
    },
    async mutateOffer(env,userId,offerCode,change) {
      const identity=readTrustedContext(runtimeContext(env));
      if(identity.telegramId!==userId)fail('runtime_subject_mismatch');
      let operation,intent,ref=null;
      if(change.type==='create') {operation='offer.create_private';intent={};}
      else {
        const current=await identity.db.prepare(`SELECT r.current_version_id AS id FROM offer_visibility_rules r
          JOIN offer_owners o ON o.offer_code=r.offer_code JOIN partner_profiles p ON p.id=o.partner_profile_id
          WHERE r.offer_code=? AND o.owner_kind='partner' AND p.telegram_id=?`).bind(offerCode,userId).all();
        if(current?.success!==true||current.results?.length!==1||!Number.isSafeInteger(current.results[0].id))fail('offer_unavailable');
        const expectedVersionId=change.expectedVersionId ?? current.results[0].id;
        ref={kind:'offer',key:offerCode};
        const operations={field:'offer.edit_own',route:'offer.edit_own',activate:'offer.activate_own',
          pause:'offer.pause_own',archive:'offer.archive_own',submit:'offer.submit_moderation'};
        operation=operations[change.type];if(!operation)fail('unsupported_atomic_operation');
        intent={expectedVersionId};
        if(change.type==='field')intent.patch={[String(change.field).replace(/_([a-z])/gu,(_,v)=>v.toUpperCase())]:change.value};
        if(change.type==='route')intent.patch={partnerLinkId:change.partnerLinkId};
      }
      const ack=await runtime.mutate(env,operation,intent,ref);
      const code=ack.offerCode??offerCode;
      const bundle=await runtime.read(env,'offer.read_own',undefined,{kind:'offer',key:code});
      const resource=readResourceFacts(readRuntimeAuthorization(bundle).resource);
      return {ok:true,status:ack.commitStatus==='unchanged'?'unchanged':change.type==='create'?'created':'updated',
        code,versionId:resource.version.currentId,versionNumber:resource.version.number,
        contentHash:resource.canonical.currentVersion.contentHash};
    },
    async submitApplication(env,userId,offerCode,existing) {
      if(readTrustedContext(runtimeContext(env)).telegramId!==userId)fail('runtime_subject_mismatch');
      return runtime.mutate(env,existing?.status==='rejected'?'application.resubmit':'application.create',
        {offerCode},{kind:'offer',key:offerCode});
    },
    async adminMutation(env,actorId,operation,intent,ref) {
      if(readTrustedContext(runtimeContext(env)).telegramId!==actorId)fail('runtime_subject_mismatch');
      return runtime.mutate(env,operation,intent,ref);
    },
    async prepareBeta(env,actorId,profileId,action,reason) {
      if(readTrustedContext(runtimeContext(env)).telegramId!==actorId)fail('runtime_subject_mismatch');
      await assertRuntimeBindingReady({binding:env.DB,env});
      return compileTelegramMutationFence(await authorize(env,'admin.partner.beta.manage',
        {action,...(reason?{reason}:{})},{kind:'partner_profile',key:profileId}));
    },
    async preparePrivacyControl(env,userId) {
      if(readTrustedContext(runtimeContext(env)).telegramId!==userId)fail('runtime_subject_mismatch');
      return compileTelegramMutationFence(await authorize(env,'privacy.request_delete_own',{},null));
    },
    async beginPublic(env,userId,prompt) {
      await assertRuntimeBindingReady({binding:env.DB,env});
      const context=await operationContext(env,'ai.public_chat',{prompt});
      if(readTrustedContext(context).telegramId!==userId)fail('runtime_subject_mismatch');
      if(typeof aiRuntime?.beginPublicAiExecution!=='function')fail('ai_runtime_unavailable');
      return aiRuntime.beginPublicAiExecution(env,context);
    },
    invokePublic:(execution,request)=>aiRuntime.invokePublicAi(execution,request),
    completePublic:(execution,output)=>aiRuntime.completePublicAi(execution,output),
    failPublic:(execution,error)=>aiRuntime.failPublicAi(execution,error),
    assertAiDeliveryFresh:execution=>aiRuntime.assertAiDeliveryFresh(execution),
    drainAiRecovery:execution=>aiRuntime.drainAiRecovery(execution),
    retainAiRecovery(env,execution) {
      const ctx=executionContexts.get(env);
      if(ctx?.waitUntil&&execution)ctx.waitUntil(aiRuntime.drainAiRecovery(execution));
    },
    async preparePrivacy(env,userId,requestId) {
      await assertRuntimeBindingReady({binding:env.DB,env});
      if(typeof privacyRuntime?.prepareV141PrivacyDeletion!=='function')fail('privacy_runtime_unavailable');
      return privacyRuntime.prepareV141PrivacyDeletion(env,userId,requestId);
    },
    telegramRuntime,
  });
  globalThis[V141_WORKER_RUNTIME_KEY]=runtime;
  return runtime;
}
