import {createCabinetCustomerContext} from './trusted-context.mjs';
import {createRuntimeAuthorizer,readRuntimeAuthorization,runtimeAuthorizationDTO,
  requireRuntimeAuthorization,assertRuntimeAuthorizationFresh} from './runtime-authorizer.mjs';
import {createAtomicAdmission} from './atomic-admission.mjs';
import {normalizeRuntimeMutationIntent} from './mutation-adapters.mjs';
import {assertRuntimeBindingReady} from './runtime-binding.mjs';
import {budgetBinding} from '../v1.4.0-rebuild/storage-factory.mjs';
import {canonicalCabinetOwnerId} from '../v1.4.0-rebuild/cabinet-participants.mjs';
import {executeAdminManagementMutation,normalizeAdminManagementIntent} from './admin-cabinet-management.mjs';
import {callAdminSupportBridge} from './admin-support-bridge.mjs';
import {readOwnerSubscriptionPaymentReviewQueue,executeOwnerSubscriptionPaymentReview} from '../v1.4.3/subscription-api.mjs';
import {authorizeOwnerRefundCancellationCompletion,cancelConfirmedRefundFutureRenewal} from '../v1.4.3/refund-contract-lifecycle.mjs';

const reads=new Set(['overview','partners','offers','users','settings','support','journal']);
const operations=Object.freeze({
  'admin.partner.review':{kind:'partner_application',target:'applicationId'},
  'admin.offer.moderate':{kind:'offer',target:'code'},
  'admin.offer.visibility':{kind:'offer',target:'code'},
  'admin.user.moderation':{kind:'user',target:'telegramId',management:true,capability:'admin.user.moderation'},
  'admin.settings.update':{kind:'admin_surface',key:'settings',management:true,capability:'admin.settings.manage'},
});
const failures=new WeakMap();
const fail=(code,status=403)=>{throw Object.assign(new Error(code),{code,status});};
export const adminCabinetErrorAuthorization=error=>failures.get(error)??null;

// Fixed owner transport mapping. No request selects an actor, capability, SQL
// producer or authorization callback, and no privileged legacy bridge is used.
export function createAdminCabinetHttpRuntime({env,sessionToken,sessionScope,context,nowSeconds}) {
  if(env.V141_AUTHORIZATION_ENABLED!=='true' || env.V141_ADMIN_MINI_APP_ENABLED!=='true' ||
      context?.telegramId!==canonicalCabinetOwnerId(env)) fail('admin_required');
  const authorizationBudget={limit:160,used:0};
  const binding=budgetBinding(env.DB,authorizationBudget);
  const authorizer=createRuntimeAuthorizer(),atomic=createAtomicAdmission();
  let readiness;
  const ready=()=>readiness??=assertRuntimeBindingReady({binding,env});
  const authorize=async(operation,ref,requestPayload,idempotencyKey)=>{
    await ready();
    const verified=await createCabinetCustomerContext({binding,env,sessionToken,sessionScope,
      channel:'mini_app',operation,nowSeconds,
      ...(requestPayload===undefined?{}:{requestPayload}),
      ...(idempotencyKey===undefined?{}:{idempotencyKey})});
    return authorizer.authorize(verified,ref);
  };
  const remember=(error,bundle)=>{
    if(bundle) {
      const dto=runtimeAuthorizationDTO(bundle);
      if(dto.allowed===false) failures.set(error,dto);
    }
    return error;
  };
  return Object.freeze({
    ready,
    async subscriptionReviewList(params={}) {
      if(!params||Object.keys(params).length) fail('invalid_request',400);
      const bundle=await authorize('admin.cabinet.open',{kind:'admin_surface',key:'cabinet'},
        {subscriptionReviewAction:'list'});
      try {return {...await readOwnerSubscriptionPaymentReviewQueue(bundle,params),authorization:runtimeAuthorizationDTO(bundle)};}
      catch(error) {throw remember(error,bundle);}
    },
    async subscriptionReviewMutate(action,body,clientKey,options={}) {
      authorizationBudget.limit=320;
      if(!['apply','refund'].includes(action)||!body||typeof body!=='object'||Array.isArray(body)||
          Object.keys(body).length!==2||!Object.hasOwn(body,'ledgerEntryId')||!Object.hasOwn(body,'reasonCode')) fail('invalid_request',400);
      const bundle=await authorize('admin.cabinet.open',{kind:'admin_surface',key:'cabinet'},
        {subscriptionReviewAction:action,ledgerEntryId:body.ledgerEntryId,reasonCode:body.reasonCode},clientKey);
      try {return {...await executeOwnerSubscriptionPaymentReview(bundle,options),authorization:runtimeAuthorizationDTO(bundle)};}
      catch(error) {throw remember(error,bundle);}
    },
    async completeRefundRenewal(body,clientKey,options={}) {
      // Admission, single-attempt fencing and provider preflight each refresh
      // the exact owner/session and applied-refund facts on the primary.
      authorizationBudget.limit=640;
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||
        !Object.hasOwn(body,'refundId'))fail('invalid_request',400);
      const bundle=await authorize('admin.cabinet.open',{kind:'admin_surface',key:'cabinet'},
        {refundCompletionId:body.refundId},clientKey);
      try {
        const admission=await authorizeOwnerRefundCancellationCompletion(bundle);
        return {...await cancelConfirmedRefundFutureRenewal(admission,options),authorization:runtimeAuthorizationDTO(bundle)};
      }catch(error){throw remember(error,bundle);}
    },
    async read(section,result) {
      if(!reads.has(section)) fail('not_found',404);
      const bundle=await authorize('admin.cabinet.open',{kind:'admin_surface',key:'cabinet'});
      try {
        requireRuntimeAuthorization(bundle);
        await assertRuntimeAuthorizationFresh(bundle);
      } catch(error) {throw remember(error,bundle);}
      return {...result,authorization:runtimeAuthorizationDTO(bundle),
        features:{mutationsEnabled:env.REBUILD_V140_WRITES_ENABLED==='true'}};
    },
    async supportRead(action,params) {
      if(!['list','ticket'].includes(action)) fail('not_found',404);
      const bundle=await authorize('admin.cabinet.open',{kind:'admin_surface',key:'cabinet'},
        {supportAction:action,supportParams:params});
      try {
        const result=await callAdminSupportBridge({env,authorization:bundle,action,params});
        // The fixed bridge checks this same genuine authorization immediately
        // before and after its RPC. Preserve that proof in the read response
        // instead of performing a second independent authorization afterward.
        return {...result,authorization:runtimeAuthorizationDTO(bundle),
          features:{mutationsEnabled:env.REBUILD_V140_WRITES_ENABLED==='true'}};
      }
      catch(error) {throw remember(error,bundle);}
    },
    async supportMutate(action,payload,target,clientKey) {
      if(!['reply','close'].includes(action)||!target||Object.keys(target).length!==1||
          !Number.isSafeInteger(target.ticketId)||target.ticketId<1) fail('invalid_request',400);
      if(env.REBUILD_V140_WRITES_ENABLED!=='true') fail('writes_unavailable');
      const allowed=action==='reply'?['text','expectedLastMessageId','idempotencyKey']:['expectedLastMessageId','idempotencyKey'];
      if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!allowed.includes(key))||
          !Object.hasOwn(payload,'expectedLastMessageId')||payload.idempotencyKey!==undefined&&payload.idempotencyKey!==clientKey||
          !(payload.expectedLastMessageId===null||Number.isSafeInteger(payload.expectedLastMessageId)&&payload.expectedLastMessageId>0)||
          action==='reply'&&(typeof payload.text!=='string'||!payload.text.trim()||payload.text.length>2000)) fail('invalid_request',400);
      const params={ticketId:target.ticketId,...(action==='reply'?{text:payload.text}:{}),
        expectedLastMessageId:payload.expectedLastMessageId,idempotencyKey:clientKey};
      const bundle=await authorize('admin.cabinet.open',{kind:'admin_surface',key:'cabinet'},
        {supportAction:action,supportParams:params},clientKey);
      try {
        const data=await callAdminSupportBridge({env,authorization:bundle,action,params});
        if(!['completed','rejected'].includes(data.receiptStatus)||data.ticketId!==target.ticketId||
            !Number.isSafeInteger(data.commandId)||data.commandId<1||typeof data.duplicate!=='boolean'||
            ![null,'queued','sending','sent','failed','unknown'].includes(data.deliveryState)||
            data.messageId!==null&&(!Number.isSafeInteger(data.messageId)||data.messageId<1)) fail('support_outcome_unknown',503);
        return {...data,commitStatus:data.receiptStatus==='rejected'?'rejected':data.duplicate?'unchanged':'committed',
          ...(data.receiptStatus==='rejected'?{error:'state_conflict'}:{}),authorization:runtimeAuthorizationDTO(bundle)};
      } catch(error) {throw remember(error,bundle);}
    },
    async mutate(action,payload,target,clientKey) {
      const mapping=operations[action];
      if(!mapping) fail('not_found',404);
      if(!target || Object.keys(target).length!==(mapping.target?1:0) || mapping.target&&!Object.hasOwn(target,mapping.target)) fail('invalid_request',400);
      const key=mapping.key??target[mapping.target];
      if(mapping.kind==='offer'?typeof key!=='string'||!/^[a-z0-9_-]{3,24}$/u.test(key):mapping.kind!=='admin_surface'&&(!Number.isSafeInteger(key)||key<1)) fail('invalid_request',400);
      const capability=mapping.capability??action;
      if(['admin.offer.moderate','admin.offer.visibility'].includes(action)&&
          (!payload || !Object.hasOwn(payload,'expectedVersionId') || Object.hasOwn(payload,'version'))) fail('invalid_request',400);
      const intent=mapping.management?normalizeAdminManagementIntent(capability,payload):normalizeRuntimeMutationIntent(action,payload);
      if(mapping.kind==='user'&&intent.targetTelegramId!==key) fail('invalid_request',400);
      const ref={kind:mapping.kind,key};
      let bundle=await authorize(capability,ref,intent,clientKey);
      try {
        const result=mapping.management?await executeAdminManagementMutation(bundle):
          await atomic.admit({decision:readRuntimeAuthorization(bundle).decision});
        return {...result,authorization:runtimeAuthorizationDTO(bundle)};
      } catch(error) {
        if(!mapping.management&&error?.code==='receipt_race') {
          bundle=await authorize(capability,ref,intent,clientKey);
          try {
            const result=await atomic.admit({decision:readRuntimeAuthorization(bundle).decision});
            return {...result,authorization:runtimeAuthorizationDTO(bundle)};
          } catch(replayError) {throw remember(replayError,bundle);}
        }
        throw remember(error,bundle);
      }
    },
  });
}
