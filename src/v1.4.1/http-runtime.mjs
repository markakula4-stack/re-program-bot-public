import { createCabinetCustomerContext, deriveTrustedOperationContext } from './trusted-context.mjs';
import { createRuntimeAuthorizer, readRuntimeAuthorization, runtimeAuthorizationDTO,
  requireRuntimeAuthorization, assertRuntimeAuthorizationFresh, assertRuntimeAuthorizationsFresh,
  projectRuntimeAccessAuthority } from './runtime-authorizer.mjs';
import { createAtomicAdmission } from './atomic-admission.mjs';
import { budgetBinding } from '../v1.4.0-rebuild/storage-factory.mjs';
import { exactPayload } from '../v1.4.0-rebuild/cabinet-service.mjs';
import { assertRuntimeBindingReady, runtimeBindingEnabled } from './runtime-binding.mjs';
import { bindCabinetEmptyCatalogProof } from './cabinet-empty-catalog.mjs';
import { readSubscriptionData } from '../v1.4.2/subscription-read-model.mjs';
import { prepareOwnReferralMessage } from '../v1.4.2/referral-share.mjs';
import { issueOwnRecurringSubscriptionInvoice, executeOwnSubscriptionRenewalCommand } from '../v1.4.3/subscription-api.mjs';
import { normalizeSubscriptionOperationStatusIntent,readOwnSubscriptionOperationStatus } from '../v1.4.3/subscription-operation-status.mjs';
import {authorizeOwnStarsSubscriptionRecovery} from '../v1.4.3/subscription-action-authority.mjs';
import {abandonOwnStarsSubscriptionCommandBeforeAttempt,resolveSupersededOwnStarsSubscriptionCommand,
  prepareOwnCancelReconfirmation,readOwnCancelReconfirmation} from '../v1.4.3/telegram-subscription-provider.mjs';

// Fixed existing cabinet routes only. No payload chooses an actor or capability.
export const CABINET_AUTHORIZATION_VERSION = 1;
export const isCabinetAuthorizationEnabled = runtimeBindingEnabled;
const capabilities = Object.freeze({
  'partner.apply':'partner.apply', 'partner.legal':'partner.legal_declare_own',
  'partner.username':'partner.public_username.update_own', 'offer.create':'offer.create_private',
  'offer.edit':'offer.edit_own', 'offer.submit':'offer.submit_moderation', 'lead.submit':'application.create',
});
const code = value => typeof value === 'string' && /^[a-z0-9_-]{3,24}$/u.test(value);
const offerPatch=['buttonText','title','description','provider','category','payoutText',
  'requiredAction','minAge','maxAge','geo','holdDays','trafficSources','sourceName','startsAt','expiresAt','partnerLinkId'];
const positive = value => Number.isSafeInteger(value) && value > 0;
const protectedReads=new Set(['profile.read_own','access.read_own','offer.read_own',
  'application.read_own','application.read_attributed']);
const fail = (error, status = 400) => { throw Object.assign(new Error(error),{code:error,status}); };
const publicFailures=new WeakMap();
export const cabinetErrorAuthorization = error => publicFailures.get(error) ?? null;
const publicFailure = (error, bundle) => {
  if (bundle) {
    const dto=runtimeAuthorizationDTO(bundle);
    // A later failed freshness/CAS check supersedes an earlier allow. It must
    // not advertise that earlier allow as the failed operation's admission.
    if(dto.allowed===false) publicFailures.set(error,dto);
  }
  return error;
};

export function createCabinetHttpRuntime({env,sessionToken,sessionScope,context:legacyContext,nowSeconds}) {
  if (!isCabinetAuthorizationEnabled(env)) fail('authorization_unavailable',503);
  // One independent finite request budget; the accepted repository retains its
  // separate 50-query budget and its existing read/source fence.
  const authorizationBudget={limit:160,used:0};
  const binding=budgetBinding(env.DB,authorizationBudget);
  const authorizer=createRuntimeAuthorizer(), atomic=createAtomicAdmission();
  let accessBundle=null;
  let readiness=null;
  const ready=()=>readiness ??= assertRuntimeBindingReady({binding,env});
  const contextFor=async(operation,requestPayload,idempotencyKey,contextBinding=binding)=>{
    try {await ready();}
    catch(error){if(!protectedReads.has(operation)) throw error;}
    return createCabinetCustomerContext({
    binding:contextBinding,env,sessionToken,sessionScope,channel:'mini_app',operation,nowSeconds,
    ...(requestPayload===undefined?{}:{requestPayload}),
    ...(idempotencyKey===undefined?{}:{idempotencyKey}),
    });
  };
  const authorize=async(operation,ref=null,requestPayload,idempotencyKey,readFrame)=>{
    const context=await contextFor(operation,requestPayload,idempotencyKey);
    if(readFrame) bindCabinetEmptyCatalogProof({context,legacyContext,...readFrame});
    return authorizer.authorize(context,ref);
  };
  const fresh=async bundle=>{
    try {requireRuntimeAuthorization(bundle);await assertRuntimeAuthorizationFresh(bundle);return bundle;}
    catch(error){throw publicFailure(error,bundle);}
  };
  const readBinding=(route,result)=>{
    const {routeCode,params={}}=route;
    if(['cabinet.bootstrap','cabinet.profile'].includes(routeCode)) return {capability:'profile.read_own',ref:null};
    if(routeCode==='cabinet.offer_action') return {capability:'offer.open_action',ref:{kind:'offer',key:params.code}};
    if(routeCode==='cabinet.offers') {
      if(result.view!==params.view || !Array.isArray(result.items) || result.items.length>50) fail('invalid_response',503);
      const selectedKeys=result.items.map(item=>item.code ?? item.offer?.code);
      if(selectedKeys.some(key=>!code(key))) fail('invalid_response',503);
      return {capability:params.view==='mine'?'offer.read_own':'offer.read_public',
        ref:{kind:'offer_collection',key:params.view},requestPayload:{routeCode,view:params.view,selectedKeys}};
    }
    if(routeCode==='cabinet.applications') {
      if(result.view!==params.view || !Array.isArray(result.items) || result.items.length>50) fail('invalid_response',503);
      const selectedKeys=result.items.map(item=>item.leadId);
      if(selectedKeys.some(key=>!positive(key))) fail('invalid_response',503);
      return {capability:params.view==='attributed'?'application.read_attributed':'application.read_own',
        ref:{kind:'application_collection',key:params.view},requestPayload:{routeCode,view:params.view,selectedKeys}};
    }
    if(routeCode==='cabinet.application_detail') return {capability:result.view==='attributed'
      ?'application.read_attributed':'application.read_own',ref:{kind:'application',key:params.leadId}};
    if(routeCode==='cabinet.analytics') return {capability:'analytics.read_personal',ref:null};
    fail('not_found',404);
  };
  const mutationBinding=async(action,payload,target)=>{
    if(!Object.hasOwn(capabilities,action)) fail('not_found',404);
    payload=structuredClone(payload);target=structuredClone(target);
    let intent,ref=null;
    if(action==='partner.apply') intent=exactPayload(payload,['displayName','contact','ageConfirmed']);
    else if(action==='partner.legal') intent=exactPayload(payload,['profileKind','selfDeclarationAccepted']);
    else if(action==='partner.username') intent=exactPayload(payload,['enabled']);
    else if(action==='offer.create') intent=exactPayload(payload,[]);
    else if(action==='lead.submit') {
      intent=exactPayload(payload,['offerCode']);if(!code(intent.offerCode)) fail('invalid_request');
      ref={kind:'offer',key:intent.offerCode};
    } else {
      exactPayload(payload,action==='offer.edit'?['version','patch']:['version']);
      if(action==='offer.edit') {
        exactPayload(payload.patch,offerPatch);
        if(!Object.keys(payload.patch).length) fail('invalid_request');
      }
      if(!positive(payload.version) || !code(target?.code) || !positive(legacyContext?.telegramId)) fail('invalid_request');
      // Immutable visible version -> canonical ID. Use historical version IDs
      // so a lost-response replay survives the version created by its commit.
      const result=await binding.withSession('first-primary').prepare(`SELECT v.id FROM offer_versions v
        JOIN offer_owners own ON own.offer_code=v.offer_code
        JOIN partner_profiles p ON p.id=own.partner_profile_id
        WHERE v.offer_code=? AND v.version_number=? AND own.owner_kind='partner' AND p.telegram_id=?
        ORDER BY v.id LIMIT 2`).bind(target.code,payload.version,legacyContext.telegramId).all();
      if(result?.success!==true || !Array.isArray(result.results)) fail('storage_unavailable',503);
      if(result.results.length!==1 || !positive(result.results[0].id)) fail('not_found',404);
      intent={expectedVersionId:result.results[0].id,...(action==='offer.edit'?{patch:payload.patch}:{})};
      ref={kind:'offer',key:target.code};
    }
    return {capability:capabilities[action],intent,ref};
  };
  return Object.freeze({
    ready,
    async readAccessAuthority(){
      accessBundle ??= await authorize('profile.read_own');
      return projectRuntimeAccessAuthority(accessBundle);
    },
    async readSubscription(){
      const bundle = await authorize('access.read_own');
      const result = await readSubscriptionData({ authorization: bundle });
      await fresh(bundle);
      return { ...result, authorization: runtimeAuthorizationDTO(bundle) };
    },
    async readSubscriptionOperationStatus(body,clientKey) {
      normalizeSubscriptionOperationStatusIntent(body);
      const bundle=await authorize('access.read_own',null,{subscriptionOperationStatus:body},clientKey);
      try {return {...await readOwnSubscriptionOperationStatus({authorization:bundle}),authorization:runtimeAuthorizationDTO(bundle)};}
      catch(error) {throw publicFailure(error,bundle);}
    },
    async recoverSubscriptionCommand(body,clientKey) {
      authorizationBudget.limit=512;
      const original=normalizeSubscriptionOperationStatusIntent(body);
      if(!['cancel','enable'].includes(body.kind))fail('invalid_operation_status');
      let bundle=await authorize('access.read_own',null,{subscriptionOperationStatus:body},clientKey);
      try{
        const current=await readOwnSubscriptionOperationStatus({authorization:bundle});
        if(['missing','admitted'].includes(current.state)){
          const commandBundle=await authorize(original.operation,null,original.requestPayload,clientKey);
          if(current.state==='missing'){
            const superseded=await resolveSupersededOwnStarsSubscriptionCommand(commandBundle);
            if(superseded)return {...superseded,authorization:runtimeAuthorizationDTO(commandBundle)};
          }
          await abandonOwnStarsSubscriptionCommandBeforeAttempt(await authorizeOwnStarsSubscriptionRecovery(commandBundle));
          bundle=await authorize('access.read_own',null,{subscriptionOperationStatus:body},clientKey);
        }
        return {...await readOwnSubscriptionOperationStatus({authorization:bundle}),authorization:runtimeAuthorizationDTO(bundle)};
      }catch(error){throw publicFailure(error,bundle);}
    },
    async reconfirmSubscriptionCancellation(body,clientKey,{readOnly=false}={}){
      exactPayload(body,['kind','intent','originalKey']);
      const key=value=>typeof value==='string'&&/^[a-f0-9]{48}$/u.test(value);
      if(Object.keys(body).length!==3||body.kind!=='cancel'||!key(body.originalKey)||!key(clientKey)||body.originalKey===clientKey)
        fail('invalid_cancel_reconfirmation');
      const original=normalizeSubscriptionOperationStatusIntent({kind:body.kind,intent:body.intent});
      if(!readOnly)authorizationBudget.limit=512;
      // Both independent authenticated intents use one primary D1 session.
      // This preserves an exact private DB identity and the finite budget.
      const session=binding.withSession('first-primary'),pairedBinding={
        prepare:session.prepare.bind(session),batch:session.batch.bind(session),withSession:()=>session};
      const originalContext=await contextFor(original.operation,original.requestPayload,body.originalKey,pairedBinding);
      let bundle;
      try{
        const recovery=readOnly?null:await authorizeOwnStarsSubscriptionRecovery(await authorizer.authorize(originalContext,null));
        bundle=await authorizer.authorize(await contextFor(original.operation,original.requestPayload,clientKey,pairedBinding),null);
        const result=readOnly?await readOwnCancelReconfirmation({originalContext,authorization:bundle}):
          await prepareOwnCancelReconfirmation({originalRecovery:recovery,authorization:bundle});
        return {...result,authorization:runtimeAuthorizationDTO(bundle)};
      }catch(error){throw publicFailure(error,bundle);}
    },
    async issueRecurringInvoice(body,clientKey,options={}) {
      authorizationBudget.limit=512;
      exactPayload(body,['planCode','recurringConsent','termsRevision','priceVersion']);
      if(Object.keys(body).length!==4||!['professional','dragon'].includes(body.planCode)||body.recurringConsent!==true||
          typeof body.termsRevision!=='string'||!positive(body.priceVersion)) fail('invalid_request');
      const bundle=await authorize('billing.purchase_monthly',null,{action:'accept',requestedPlanCode:body.planCode,
        billingMode:'recurring',recurringConsent:true,termsRevision:body.termsRevision,priceVersion:body.priceVersion},clientKey);
      try {
        const result=await issueOwnRecurringSubscriptionInvoice(bundle,options);
        return {...result,authorization:runtimeAuthorizationDTO(bundle)};
      } catch(error) {throw publicFailure(error,bundle);}
    },
    async controlSubscriptionRenewal(action,body,clientKey,options={}) {
      authorizationBudget.limit=512;
      exactPayload(body,['contractId','expectedRevision']);
      if(!['cancel','enable'].includes(action)||Object.keys(body).length!==2||typeof body.contractId!=='string'||
          !positive(body.expectedRevision)) fail('invalid_request');
      const bundle=await authorize('access.read_own',null,{subscriptionAction:action==='cancel'?'cancel_renewal':'reenable_renewal',
        contractId:body.contractId,expectedRevision:body.expectedRevision},clientKey);
      try {
        const result=await executeOwnSubscriptionRenewalCommand(bundle,options);
        return {...result,authorization:runtimeAuthorizationDTO(bundle)};
      } catch(error) {throw publicFailure(error,bundle);}
    },
    async prepareReferral(body, clientKey, { assertFence, nowSeconds: clock, fetchImpl } = {}) {
      exactPayload(body, []);
      const bundle = await authorize('referral.link.read_own', null, {}, clientKey);
      try {
        const result = await prepareOwnReferralMessage({ authorization: bundle, body,
          assertFence, nowSeconds: clock, fetchImpl });
        await fresh(bundle);
        return { ...result, authorization: runtimeAuthorizationDTO(bundle) };
      } catch (error) { throw publicFailure(error, bundle); }
    },
    async read(route,result){
      const request=readBinding(route,result);
      const bundle=request.capability==='profile.read_own' && accessBundle ? accessBundle
        :await authorize(request.capability,request.ref,request.requestPayload,undefined,{route,result});
      const projected={...result,authorization:runtimeAuthorizationDTO(bundle)};
      const readyForActions=await ready().then(()=>true,()=>false);
      if(!readyForActions) projected.features={version:1,mutationsEnabled:false,offerActionsEnabled:false};
      if(route.routeCode==='cabinet.offers' && route.params.view==='mine' &&
          readyForActions) {
        const derived=await deriveTrustedOperationContext(readRuntimeAuthorization(bundle).context,
          {operation:'offer.create_private',requestPayload:{}});
        const create=await authorizer.authorize(derived);
        try {requireRuntimeAuthorization(bundle);await assertRuntimeAuthorizationsFresh([bundle,create]);}
        catch(error){throw publicFailure(error,bundle);}
        projected.decisions={'offer.create_private':runtimeAuthorizationDTO(create)};
      } else await fresh(bundle);
      return projected;
    },
    async mutate(action,payload,target={},clientKey){
      const request=await mutationBinding(action,payload,target);
      let bundle=await authorize(request.capability,request.ref,request.intent,clientKey);
      try {
        // Atomic handles a genuine previous receipt before applying current
        // growth entitlement. Never turn a preflight into mutation authority.
        const ack=await atomic.admit({decision:readRuntimeAuthorization(bundle).decision});
        return {...ack,authorization:runtimeAuthorizationDTO(bundle)};
      } catch(error){
        if(error?.code==='receipt_race') {
          bundle=await authorize(request.capability,request.ref,request.intent,clientKey);
          try {
            const ack=await atomic.admit({decision:readRuntimeAuthorization(bundle).decision});
            return {...ack,authorization:runtimeAuthorizationDTO(bundle)};
          } catch(replayError){throw publicFailure(replayError,bundle);}
        }
        throw publicFailure(error,bundle);
      }
    },
  });
}
