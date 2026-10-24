import { resolveTelegramHandler } from './handler-registry.mjs';
import { deriveTrustedOperationContext, readTrustedContext, captureTelegramFlowContext } from './trusted-context.mjs';
import { createRuntimeAuthorizer, readRuntimeAuthorization, requireRuntimeAuthorization,
  assertRuntimeAuthorizationFresh } from './runtime-authorizer.mjs';
import { compileDecisionAssertions,readDecisionFacts } from './entitlement-engine.mjs';
import { readActorFacts } from './authority-resolver.mjs';
import { readResourceFacts } from './resource-resolver.mjs';
import { FOUNDATION_POLICY_VERSION } from './capability-policy.mjs';
import { createAtomicAdmission, ATOMIC_OPERATIONS } from './atomic-admission.mjs';
import { RUNTIME_MUTATION_OPERATIONS } from './mutation-adapters.mjs';
import { parseCabinetCallback } from '../v1.4.0-rebuild/telegram-command-authority.mjs';
import { readCabinetOwnerGate } from '../v1.4.0-rebuild/cabinet-http.mjs';
import { readCabinetAdminGate } from '../v1.4.0-rebuild/cabinet-participants.mjs';
import { canonicalCabinetOwnerId } from '../v1.4.0-rebuild/cabinet-participants.mjs';

export const TELEGRAM_RUNTIME_VERSION='2026-10-02.v1.4.1.p04';
// Lazy construction avoids the accepted cabinet/http/service import cycle.
let authorizer,atomic;
const getAuthorizer=()=>authorizer??=createRuntimeAuthorizer();
const getAtomic=()=>atomic??=createAtomicAdmission();
const isAtomicOperation=operation=>ATOMIC_OPERATIONS.includes(operation)||RUNTIME_MUTATION_OPERATIONS.includes(operation);
const HASH=/^[0-9a-f]{64}$/u,positive=n=>Number.isSafeInteger(n)&&n>0;
const fail=(code,status=403)=>{throw Object.assign(new Error(code),{code,status});};
const exact=(payload,required,optional=[])=>{
  if(!payload || typeof payload!=='object' || Array.isArray(payload) ||
      required.some(key=>!Object.hasOwn(payload,key)) || Object.keys(payload).some(key=>!required.includes(key)&&!optional.includes(key))) fail('invalid_intent',400);
  return payload;
};
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
const safeCode=value=>typeof value==='string'&&/^[a-z0-9_-]{3,24}$/u.test(value);
const fixedRead=async(db,sql,params=[])=>{
  const result=await db.prepare(sql).bind(...params).all();
  if(result?.success!==true || !Array.isArray(result.results) || result.results.length>51) fail('resource_unavailable',503);
  return result.results;
};

// /start's existing executor builds the actual parsed referral intent and puts
// its complete fresh account decision in the registration write batch. Dispatch
// verifies only the fixed claimed transport selector here; it does not authorize
// an effect or reuse an actor snapshot captured before that intent existed.
export function claimedTelegramRegistrationHandler(context,update) {
  const handler=resolveTelegramHandler(update);
  if(handler?.id!=='command.start'||handler.capability!=='account.register'||
      handler.effect!=='existing_domain'||handler.flow!=='registration_attribution')return null;
  const identity=readTrustedContext(context),binding=identity.transportBinding;
  const actor=update?.message?.from?.id;
  if(binding?.kind!=='telegram'||binding.updateId!==update?.update_id||binding.actor!==actor||
      identity.telegramId!==actor||identity.channel!==handler.channel)fail('telegram_operation_binding_mismatch');
  return Object.freeze({handler,authorization:null});
}

// Select only a compiled handler on the already authenticated claimed update.
// The root context binds the actual webhook receipt and verified subject; raw
// selectors select a server operation and never confer account/role authority.
export async function authorizeTelegramHandler(context,update) {
  const identity=readTrustedContext(context),binding=identity.transportBinding;
  let handler=resolveTelegramHandler(update);
  if(!handler) return null;
  const actor=Number(update?.callback_query?.from?.id??update?.message?.from?.id);
  if(binding?.kind!=='telegram' || binding.updateId!==update?.update_id || binding.actor!==actor ||
      identity.telegramId!==actor || identity.channel!==handler.channel) fail('telegram_operation_binding_mismatch');
  let capability=handler.capability,ref=handler.resourceRef,payload=handler.requestPayload;
  const selector=handler.selector,db=identity.db;
  if(handler.flow==='legacy_conversion_repair') {
    const confirm=/^\/confirm ([1-9][0-9]*) ([a-z0-9_-]{3,24}) ([0-9]+(?:[.,][0-9]{1,2})?)$/u.exec(selector);
    const paid=/^\/paid ([1-9][0-9]*) ([a-z0-9_-]{3,24})$/u.exec(selector);
    const match=confirm??paid;
    if(!match||!positive(Number(match[1])))fail('invalid_intent',400);
    payload={decision:confirm?'confirm':'mark_paid',subjectTelegramId:Number(match[1]),offerCode:match[2]};
    if(confirm) {
      const [whole,cents='']=confirm[3].replace(',','.').split('.');
      const reward=Number(whole)*100+Number(cents.padEnd(2,'0'));
      if(!Number.isSafeInteger(reward)||reward<0||reward>100_000_000)fail('invalid_intent',400);
      payload.rewardKopecks=reward;
    }
    ref={kind:'legacy_conversion',key:`user:${match[1]}:offer:${match[2]}`};
  }
  if(handler.flow==='existing_typed_admin_command'&&capability==='admin.catalog.manage') {
    const text=update.message?.text??'';
    if(/^\/offer_add(?:@RE_Program_Bot)?\s/iu.test(text)) {
      const parts=text.replace(/^\/offer_add(?:@RE_Program_Bot)?\s+/iu,'').split('|').map(part=>part.trim());
      if(parts.length!==4||!safeCode(parts[0].toLowerCase()))fail('invalid_intent',400);
      ref={kind:'admin_surface',key:'catalog_creation'};
      payload={action:'create',offerCode:parts[0].toLowerCase(),buttonText:parts[1],title:parts[2],url:parts[3]==='-'?'':parts[3]};
    } else if(/^\/offer_set(?:@RE_Program_Bot)?\s/iu.test(text)) {
      const match=/^\/offer_set(?:@RE_Program_Bot)?\s+([a-z0-9_-]{3,24})\s+([a-z_]+)\s+([\s\S]+)$/iu.exec(text);
      if(!match)fail('invalid_intent',400);
      ref={kind:'offer',key:match[1].toLowerCase()};payload={action:'edit',field:match[2].toLowerCase(),value:match[3].trim()};
    } else {
      const match=/^\/offer_delete(?:@RE_Program_Bot)?\s+([a-z0-9_-]{3,24})\s+DELETE$/iu.exec(text);
      if(!match)fail('invalid_intent',400);ref={kind:'offer',key:match[1].toLowerCase()};payload={action:'delete'};
    }
  }
  if(handler.flow==='canonical_system_catalog') {
    const match=/^admin_(delete_confirm|offer_status|set_category):([a-z0-9_-]{3,24})(?::([a-z_]{1,32}))?$/u.exec(selector);
    if(match)payload=match[1]==='delete_confirm'?{action:'delete'}:{action:'edit',field:match[1]==='offer_status'?'status':'category',value:match[3]};
    else if(/^admin_new_category:/u.test(selector)) {
      const captured=await captureTelegramFlowContext(context,{kind:'admin'}),row=captured.row;
      if(row?.action!=='create_offer'||row.step!=='category')fail('invalid_flow_state',400);
      let staged;try{staged=JSON.parse(row.payload_json);}catch{fail('invalid_flow_state',400);}
      if(!safeCode(staged?.code)||row.offer_code!==staged.code)fail('invalid_flow_state',400);
      context=captured.context;ref={kind:'admin_surface',key:'catalog_creation'};
      payload={action:'create',offerCode:staged.code,flowAction:row.action,flowStep:row.step,value:selector.slice('admin_new_category:'.length)};
    }
  }
  if(handler.flow==='canonical_broadcast') {
    const match=/^admin_broadcast_(send|continue|cancel):([1-9][0-9]*)$/u.exec(selector);
    if(!match||!positive(Number(match[2])))fail('invalid_intent',400);
    payload={action:match[1],broadcastId:Number(match[2])};
  }
  if(handler.flow==='stars_invoice') {
    const match=/^stars_(buy|accept):(professional|dragon)(?::[A-Za-z0-9_.:-]{1,96})?$/u.exec(selector);
    if(!match)fail('invalid_intent',400);
    payload={action:match[1]==='buy'?'open':'accept',requestedPlanCode:match[2]};
  }
  if(handler.flow==='stars_refund_confirmation') {
    const match=/^admin_stars_refund_confirm:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.exec(selector);
    if(!match)fail('invalid_intent',400);
    payload={action:'refund',orderId:match[1],reasonCode:'admin_canary_validation'};
  }
  if(selector==='admin_stars_reconcile')payload={action:'reconcile'};
  if(selector==='admin_referral_repair'){ref={kind:'admin_surface',key:'result_repair'};payload={action:'referral_repair'};}
  if(selector==='dragon_preview_check') {
    capability='channel.check_membership';ref=null;payload={action:'preview_check'};
    handler=Object.freeze({...handler,capability});
  }
  if(selector==='referral_bonus_claim')payload={};
  if(handler.flow==='sync_menu')payload={action:'sync_menu'};
  if(handler.flow==='canonical_admin_settings')payload={action:'setting',selector};
  if(handler.flow==='canonical_moderation') {
    if(selector==='h138:block:confirm') {
      const row=(await fixedRead(db,'SELECT target_telegram_id,reason,step,expires_at FROM admin_moderation_sessions WHERE admin_telegram_id=?',[actor]))[0];
      if(row?.step!=='confirm'||!positive(row.target_telegram_id)||row.expires_at<=identity.nowSeconds)fail('invalid_flow_state',400);
      ref={kind:'user',key:row.target_telegram_id};payload={action:'block',targetTelegramId:row.target_telegram_id,reason:row.reason,sessionExpiresAt:row.expires_at};
    } else {
      const match=/^h138:unblock:ok:([1-9][0-9]*):([1-9][0-9]*)$/u.exec(selector);
      if(!match||!positive(Number(match[1]))||!positive(Number(match[2])))fail('invalid_intent',400);
      ref={kind:'user',key:Number(match[1])};payload={action:'unblock',targetTelegramId:Number(match[1]),expectedRevision:Number(match[2])};
    }
  }
  if(handler.flow==='partner_link_submission') {
    const program=/^partner_link_program:([a-z0-9_-]{2,32})$/u.exec(selector);
    const offer=/^partner_link_offer:([1-9][0-9]*)$/u.exec(selector);
    if(program)payload={action:'select_program',programCode:program[1]};
    else if(offer&&positive(Number(offer[1])))payload={action:'select_offer',catalogOfferId:Number(offer[1])};
    else if(selector==='partner_link_submit_confirm') {
      const captured=await captureTelegramFlowContext(context,{kind:'partner'}),row=captured.row;
      let staged;try{staged=JSON.parse(row?.payload_json);}catch{fail('invalid_flow_state',400);}
      if(row?.action!=='submit_partner_link'||row.step!=='confirm'||!positive(staged?.catalogOfferId)||
        typeof staged.url!=='string'||Object.keys(staged).some(key=>!['catalogOfferId','url'].includes(key)))fail('invalid_flow_state',400);
      context=captured.context;payload={action:'submit_link',catalogOfferId:staged.catalogOfferId,url:staged.url,
        flowAction:row.action,flowStep:row.step};
    } else fail('invalid_intent',400);
  }
  if(/^partner_link_(pause|resume|archive):/u.test(selector))payload={action:selector.split(':')[0].slice('partner_link_'.length)};
  if(handler.flow==='canonical_beta_action') {
    const action={g:'grant',p:'pause',r:'resume',x:'revoke'}[selector.match(/^admin_pb([gprx]):/u)?.[1]];
    if(['pause','revoke'].includes(action)) {
      capability='admin.cabinet.open';ref={kind:'admin_surface',key:'cabinet'};payload={};
    } else payload={action};
  }
  if(handler.effect==='sealed') {
    const gate=actor===canonicalCabinetOwnerId(identity.env)?readCabinetAdminGate(identity.env,identity.nowSeconds):readCabinetOwnerGate(identity.env,identity.nowSeconds);
    if(!gate) fail('release_lease_unavailable',503);
    const sealed=await parseCabinetCallback(selector,{actor,gate,secret:identity.env.MINI_APP_IDEMPOTENCY_SECRET,nowSeconds:identity.nowSeconds});
    if(['pa','pr'].includes(sealed.op)) {
      capability='admin.partner.review';ref={kind:'partner_application',key:Number(sealed.target)};
      payload={decision:sealed.op==='pa'?'approve':'reject',...(sealed.op==='pr'?{reason:'Не пройдена проверка заявки.'}:{})};
    } else if(sealed.op==='bg') {
      capability='admin.partner.beta.manage';ref={kind:'partner_profile',key:Number(sealed.target)};payload={action:'grant',durationSeconds:3600};
    } else if(['oa','op'].includes(sealed.op)) {
      capability=sealed.op==='oa'?'offer.activate_own':'offer.pause_own';ref={kind:'offer',key:sealed.target};
      const current=(await fixedRead(db,'SELECT id,version_number FROM offer_versions WHERE offer_code=? AND version_number=?',[sealed.target,sealed.version]))[0];
      if(!positive(current?.id)) fail('state_conflict',409);payload={expectedVersionId:current.id};
    } else {
      capability=sealed.op==='ov'?'admin.offer.visibility':'admin.offer.moderate';ref={kind:'offer',key:sealed.target};
      payload=sealed.op==='ov'?{version:sealed.version,visibility:'public'}:
        {version:sealed.version,decision:sealed.op==='om'?'approved':'changes_requested',...(sealed.op==='or'?{reason:'Исправьте условия и отправьте новую версию.'}:{})};
    }
  }
  if(handler.flow==='current_version') {
    const current=(await fixedRead(db,'SELECT current_version_id AS id FROM offer_visibility_rules WHERE offer_code=?',[ref.key]))[0];
    if(!positive(current?.id)) fail('state_conflict',409);payload={expectedVersionId:current.id};
  }
  if(handler.flow==='canonical_application_intent') {
    const code=ref.kind==='offer'?ref.key:(await fixedRead(db,'SELECT offer_code AS code FROM program_offers WHERE id=?',[ref.key]))[0]?.code;
    if(!safeCode(code)) fail('resource_unavailable',404);payload={offerCode:code};
  }
  if(ref?.kind==='offer_collection' || ref?.kind==='application_collection') {
    const offers=ref.kind==='offer_collection';
    const keys=await fixedRead(db,offers?
      "SELECT o.code AS key FROM offers o JOIN offer_owners w ON w.offer_code=o.code JOIN partner_profiles p ON p.id=w.partner_profile_id WHERE w.owner_kind='partner' AND p.telegram_id=? ORDER BY o.code LIMIT 50":
      'SELECT id AS key FROM lead_requests WHERE telegram_id=? ORDER BY id LIMIT 50',[actor]);
    payload={routeCode:offers?'cabinet.offers':'cabinet.applications',view:ref.key,selectedKeys:keys.map(row=>row.key)};
  }
  if(selector==='accept_terms') payload={};
  if(/^notification_(view|archive|restore):/u.test(selector)) payload={action:selector.split(':')[0].slice(13),notificationId:ref.key};
  if(selector==='notifications_read_all'||selector==='notifications_archive_read') payload={action:selector==='notifications_read_all'?'mark_all_read':'archive_read'};
  if(selector==='notifications_toggle_push') payload={action:'toggle'};
  if(['favorites_clear_do','recent_clear_do'].includes(selector)) payload={action:selector==='favorites_clear_do'?'clear_favorites':'clear_recent'};
  if(/^fav_(add|remove):/u.test(selector)) payload={action:selector.startsWith('fav_add:')?'add_favorite':'remove_favorite',offerCode:selector.split(':')[1]};
  if(['ai_enable','ai_disable'].includes(selector)) payload={enabled:selector==='ai_enable'};
  if(['ai_consent_accept','ai_consent_revoke'].includes(selector)) payload={action:selector==='ai_consent_accept'?'accept':'revoke'};
  if(selector==='ai_memory_clear_do') payload={};
  if(capability==='flow.cancel_own') payload={};
  const derived=await deriveTrustedOperationContext(context,{operation:capability,requestPayload:payload});
  const authorization=await getAuthorizer().authorize(derived,ref);
  if(!['atomic','sealed'].includes(handler.effect)) requireRuntimeAuthorization(authorization);
  return Object.freeze({authorization,handler});
}

// Plaintext completes only a captured fixed server flow. Both own session
// snapshots remain in the derived context, including absence of the other one.
export async function authorizeLegacyTelegramFlow(context,update) {
  const identity=readTrustedContext(context),binding=identity.transportBinding,text=update?.message?.text;
  if(typeof text!=='string'||text.startsWith('/')||resolveTelegramHandler(update))return null;
  if(binding?.kind!=='telegram'||binding.updateId!==update.update_id||binding.actor!==update.message.from?.id||
    identity.telegramId!==binding.actor||identity.channel!=='telegram_command'||identity.requestPayload?.prompt!==text)
    fail('telegram_operation_binding_mismatch');
  const admin=await captureTelegramFlowContext(context,{kind:'admin'});
  const partner=await captureTelegramFlowContext(admin.context,{kind:'partner'});
  const row=identity.telegramId===canonicalCabinetOwnerId(identity.env)&&admin.row?admin.row:partner.row;
  if(!row||!['submit_partner_link','review_partner_link_reject','create_offer','edit_offer','compose_broadcast'].includes(row.action))return null;
  let staged;try{staged=JSON.parse(row.payload_json);}catch{fail('invalid_flow_state',400);}
  if(!staged||typeof staged!=='object'||Array.isArray(staged))fail('invalid_flow_state',400);
  let capability,ref=null,payload;
  if(row.action==='submit_partner_link') {
    if(row.step!=='url'||!positive(staged.catalogOfferId)||Object.keys(staged).some(key=>key!=='catalogOfferId'))fail('invalid_flow_state',400);
    capability='partner.link.manage_own';payload={action:'stage_link',catalogOfferId:staged.catalogOfferId,url:text.trim(),flowAction:row.action,flowStep:row.step};
  } else if(row.action==='review_partner_link_reject') {
    if(row.step!=='reason'||!positive(staged.partnerLinkId)||Object.keys(staged).some(key=>key!=='partnerLinkId'))fail('invalid_flow_state',400);
    capability='admin.partner_link.review';ref={kind:'partner_link',key:staged.partnerLinkId};
    payload={decision:'reject',reason:text.trim()==='-'?'Ссылка не прошла ручную проверку.':text.trim()};
  } else if(row.action==='create_offer') {
    if(!['code','button_text','title','url'].includes(row.step))return null;
    const code=row.step==='code'?text.trim().toLowerCase():staged.code;
    if(!safeCode(code)||row.step!=='code'&&row.offer_code!==code)fail('invalid_flow_state',400);
    capability='admin.catalog.manage';ref={kind:'admin_surface',key:'catalog_creation'};
    payload={action:'create',offerCode:code,flowAction:row.action,flowStep:row.step,value:text.trim()};
  } else if(row.action==='edit_offer') {
    if(!safeCode(row.offer_code)||!editableFields.has(row.step))fail('invalid_flow_state',400);
    capability='admin.catalog.manage';ref={kind:'offer',key:row.offer_code};
    payload={action:'edit',field:row.step,value:text.trim(),flowAction:row.action,flowStep:row.step};
  } else {
    if(row.step!=='message'||Object.keys(staged).length)fail('invalid_flow_state',400);
    capability='admin.broadcast.send';ref={kind:'admin_surface',key:'broadcast'};
    payload={action:'prepare',messageText:text.trim(),flowAction:row.action,flowStep:row.step};
  }
  const derived=await deriveTrustedOperationContext(partner.context,{operation:capability,requestPayload:payload});
  const authorization=await getAuthorizer().authorize(derived,ref);requireRuntimeAuthorization(authorization);
  return Object.freeze({authorization,handler:Object.freeze({id:'flow.'+row.action,capability,effect:'existing_domain',
    channel:'telegram_command',flow:row.action,selector:'captured_plaintext'})});
}

export async function executeTelegramMutation(authorization) {
  requireRuntimeAuthorization(authorization);
  const {context,decision}=readRuntimeAuthorization(authorization),identity=readTrustedContext(context);
  if(!isAtomicOperation(identity.operation)) fail('unsupported_atomic_operation');
  return getAtomic().admit({decision});
}
export const assertTelegramPresentationFresh=assertRuntimeAuthorizationFresh;

// Fixed guard statements are installed inside an existing reviewed domain
// batch. No caller SQL, capability string, actor or predicate is accepted here.
// Each CHECK failure rolls back every effect in that same D1 batch.
export function compileTelegramMutationFence(authorization) {
  requireRuntimeAuthorization(authorization);
  const {context,decision}=readRuntimeAuthorization(authorization),identity=readTrustedContext(context);
  const proof=compileDecisionAssertions(decision),pieces=proof.assertions??[proof];
  if(!pieces.length||pieces.length>96) fail('authority_check_failed',503);
  const keys=pieces.map(()=>`v141tg_${crypto.randomUUID()}`);
  const before=pieces.map((piece,index)=>Object.freeze({sql:
    'INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN ('+piece.sql+') THEN 1 ELSE 0 END)',
    params:Object.freeze([keys[index],...piece.params])}));
  const after=keys.map(key=>Object.freeze({sql:'DELETE FROM mini_app_atomic_guards WHERE guard_key=?',params:Object.freeze([key])}));
  return Object.freeze({before:Object.freeze(before),after:Object.freeze(after)});
}
export function createTelegramMutationFence(authorization) {
  const {context}=readRuntimeAuthorization(authorization),db=readTrustedContext(context).db;
  const plan=compileTelegramMutationFence(authorization);
  return Object.freeze({before:Object.freeze(plan.before.map(row=>db.prepare(row.sql).bind(...row.params))),
    after:Object.freeze(plan.after.map(row=>db.prepare(row.sql).bind(...row.params)))});
}

export const LEGACY_TELEGRAM_MUTATION_OPERATIONS=Object.freeze([
  'terms.accept','notification.manage_own','notification.settings.update_own',
  'catalog.preference.update_own','ai.settings.update_own','ai.consent.manage_own',
  'ai.memory.clear_own','profile.update_own','flow.cancel_own',
]);

const editableFields=new Set(['button_text','title','description','provider','category','url','url_env_key','payout_text',
  'required_action','min_age','max_age','geo','hold_days','traffic_sources','source_name','starts_at','expires_at','sort_order','status']);
const adminFlowSteps=Object.freeze({review_lead_confirm:['reward'],review_lead_reject:['reason'],review_partner_reject:['reason'],
  partner_beta_pause:['reason'],partner_beta_revoke:['reason'],partner_offer_changes_requested:['reason'],partner_offer_rejected:['reason'],
  partner_offer_assign:['telegram_id'],review_partner_link_reject:['reason'],create_offer:['code','button_text','title','category','url'],
  edit_offer:[...editableFields],compose_broadcast:['message']});

// Only fixed existing flow tables/actions are selected here. These rows stage
// input; completion uses its separate current domain capability and cannot
// acquire a role, quota, paid plan, publication or target edit through staging.
export async function executeTelegramFlowState(original,input) {
  exact(input,['kind','mode'],['session']);
  if(!['partner','admin'].includes(input.kind)||!['set','clear'].includes(input.mode)||
      (input.mode==='set')!==(input.session!==undefined))fail('invalid_flow_state',400);
  const identity=readTrustedContext(original);
  if(identity.actorKind!=='customer'||!identity.transportBinding)fail('untrusted_flow_context');
  let capability,ref=null,session=null;
  if(input.mode==='clear')capability=input.kind==='admin'?'admin.cabinet.open':'profile.read_own';
  else {
    session=exact(input.session,['action','step','payload'],['offerCode']);
    if(typeof session.action!=='string'||typeof session.step!=='string'||!session.payload||typeof session.payload!=='object'||Array.isArray(session.payload)||
        JSON.stringify(session.payload).length>12_000)fail('invalid_flow_state',400);
    if(input.kind==='partner') {
      if(session.action==='edit_partner_offer'&&editableFields.has(session.step)&&safeCode(session.payload.offerCode)&&
          typeof session.payload.alias==='string'&&/^[a-z]{2}$/u.test(session.payload.alias)&&
          Object.keys(session.payload).every(key=>['offerCode','alias'].includes(key))) {
        capability='offer.edit_own';ref={kind:'offer',key:session.payload.offerCode};
      } else if(session.action==='submit_partner_link'&&['url','confirm'].includes(session.step)&&positive(session.payload.catalogOfferId)&&
          Object.keys(session.payload).every(key=>['catalogOfferId','url'].includes(key))&&
          (session.step==='url'?session.payload.url===undefined:typeof session.payload.url==='string'&&session.payload.url.length<=2048))capability='partner.link.manage_own';
      else fail('unknown_flow_action');
    } else {
      if(!adminFlowSteps[session.action]?.includes(session.step)||session.offerCode!==undefined&&session.offerCode!==null&&!safeCode(session.offerCode))fail('unknown_flow_action');
      capability='admin.cabinet.open';ref={kind:'admin_surface',key:'cabinet'};
    }
  }
  if(capability==='admin.cabinet.open')ref={kind:'admin_surface',key:'cabinet'};
  const payload={kind:input.kind,mode:input.mode,...(session?{session}: {})};
  const context=await deriveTrustedOperationContext(original,{operation:capability,requestPayload:payload});
  const authorization=await getAuthorizer().authorize(context,ref);requireRuntimeAuthorization(authorization);
  const runtime=readRuntimeAuthorization(authorization),facts=readTrustedContext(context),actor=readActorFacts(runtime.actor),decision=readDecisionFacts(runtime.decision);
  input=facts.requestPayload;session=input.session??null;
  if(input.kind==='admin'&&(!actor.canonicalOwner||!actor.roles.includes('admin')))fail('admin_required');
  const db=facts.db,table=input.kind==='admin'?'admin_sessions':'partner_sessions';
  const columns=input.kind==='admin'?'telegram_id,action,step,offer_code,payload_json,updated_at':'telegram_id,action,step,payload_json,updated_at';
  const sql=`SELECT json_array(${columns}) AS snapshot FROM ${table} WHERE telegram_id=? LIMIT 2`;
  const rows=await fixedRead(db,sql,[facts.telegramId]);if(rows.length>1)fail('state_conflict',409);
  const source=rows[0]?.snapshot??null,secret=facts.env.MINI_APP_IDEMPOTENCY_SECRET;
  if(typeof secret!=='string'||secret.length<32||!HASH.test(facts.operationId)||!HASH.test(facts.payloadHash)||!HASH.test(actor.accountFingerprint))fail('missing_operation_binding');
  const hmac=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('HMAC',hmac,new TextEncoder().encode(JSON.stringify([
    TELEGRAM_RUNTIME_VERSION,'flow',facts.botId,facts.telegramId,actor.accountFingerprint,facts.operationId,input.kind,input.mode,session?.action??null,session?.step??null])));
  const key='mikey_'+Array.from(new Uint8Array(signature),byte=>byte.toString(16).padStart(2,'0')).join('');
  const requestHash=facts.payloadHash,prior=(await fixedRead(db,'SELECT request_hash AS hash FROM mini_app_command_receipts WHERE idempotency_key=?',[key]))[0];
  if(prior) {
    if(prior.hash!==requestHash)fail('idempotency_conflict',409);await assertRuntimeAuthorizationFresh(authorization);
    return Object.freeze({committed:false,replayed:true});
  }
  const proofs=compileDecisionAssertions(runtime.decision),pieces=[...(proofs.assertions??[proofs]),{sql:`(${sql}) IS ?`,params:[facts.telegramId,source]}];
  if(pieces.length>96)fail('authority_check_failed',503);
  const guardKeys=pieces.map(()=>`v141flow_${crypto.randomUUID()}`);
  const before=pieces.map((piece,index)=>db.prepare('INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN ('+piece.sql+') THEN 1 ELSE 0 END)').bind(guardKeys[index],...piece.params));
  const write=input.mode==='clear'?db.prepare(`DELETE FROM ${table} WHERE telegram_id=?`).bind(facts.telegramId):
    input.kind==='admin'?db.prepare('INSERT INTO admin_sessions(telegram_id,action,step,offer_code,payload_json,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(telegram_id) DO UPDATE SET action=excluded.action,step=excluded.step,offer_code=excluded.offer_code,payload_json=excluded.payload_json,updated_at=CURRENT_TIMESTAMP')
      .bind(facts.telegramId,session.action,session.step,session.offerCode??null,JSON.stringify(session.payload)):
      db.prepare('INSERT INTO partner_sessions(telegram_id,action,step,payload_json,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(telegram_id) DO UPDATE SET action=excluded.action,step=excluded.step,payload_json=excluded.payload_json,updated_at=CURRENT_TIMESTAMP')
      .bind(facts.telegramId,session.action,session.step,JSON.stringify(session.payload));
  const receipt=db.prepare("INSERT INTO mini_app_command_receipts(idempotency_key,request_hash,bot_id,actor_telegram_id,operation,commit_status,response_json,committed_at,precondition_ok) VALUES(?,?,?,?,?,'committed',?,unixepoch(),1)")
    .bind(key,requestHash,facts.botId,facts.telegramId,capability,JSON.stringify({flowKind:input.kind,mode:input.mode}));
  const eventKey=await hash(`${TELEGRAM_RUNTIME_VERSION}\n${key}\n${requestHash}`);
  const audit=db.prepare("INSERT INTO entitlement_decision_audit(audit_id,event_key,policy_version,capability,actor_kind,subject_telegram_id,actor_telegram_id,resource_ref,decision,reason_code,source_fingerprint,operation_ref,evaluated_at,valid_until) VALUES(?,?,?,?,'customer',?,?,?,'allow','telegram_flow_committed',?,?,?,?)")
    .bind('v141flow_'+eventKey,eventKey,FOUNDATION_POLICY_VERSION,capability,facts.telegramId,facts.telegramId,`flow:${input.kind}`,actor.sourceFingerprint,key,decision.evaluatedAt,decision.validUntil);
  const after=guardKeys.map(key=>db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key=?').bind(key));
  const statements=[...before,receipt,write,audit,...after],result=await db.batch(statements);
  if(!Array.isArray(result)||result.length!==statements.length||result.some(row=>row?.success!==true)||result[before.length]?.meta?.changes!==1||result[before.length+2]?.meta?.changes!==1)fail('authority_outcome_unverified',503);
  return Object.freeze({committed:true,replayed:false});
}

// Closed compatibility plans preserve accepted old tables. Inputs are the
// private canonical transport payload selected by an existing server handler.
// A plan never accepts a SQL string, statement list or executable callback.
export async function executeLegacyTelegramMutation(authorization) {
  requireRuntimeAuthorization(authorization);
  const {context,actor,decision}=readRuntimeAuthorization(authorization),identity=readTrustedContext(context);
  const {db,telegramId:subject,operation,requestPayload:payload}=identity;
  if(!LEGACY_TELEGRAM_MUTATION_OPERATIONS.includes(operation)||identity.actorKind!=='customer'||
      !HASH.test(identity.operationId)||!HASH.test(identity.payloadHash)) fail('unsupported_legacy_operation');
  const actorFacts=readActorFacts(actor);
  if(!HASH.test(actorFacts.accountFingerprint)) fail('account_source_unavailable',503);
  const secret=identity.env.MINI_APP_IDEMPOTENCY_SECRET;
  if(typeof secret!=='string'||secret.length<32) fail('missing_operation_binding');
  const hmac=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('HMAC',hmac,new TextEncoder().encode(JSON.stringify([
    TELEGRAM_RUNTIME_VERSION,identity.botId,subject,actorFacts.accountFingerprint,operation,identity.operationId])));
  const key='mikey_'+Array.from(new Uint8Array(signature),byte=>byte.toString(16).padStart(2,'0')).join('');
  const requestHash=await hash(JSON.stringify([operation,identity.payloadHash]));
  const existing=(await fixedRead(db,'SELECT request_hash AS requestHash,actor_telegram_id AS actor,bot_id AS bot,operation,response_json AS responseJson FROM mini_app_command_receipts WHERE idempotency_key=?',[key]))[0];
  if(existing) {
    if(existing.requestHash!==requestHash||existing.actor!==subject||existing.bot!==identity.botId||existing.operation!==operation) fail('idempotency_conflict',409);
    await assertRuntimeAuthorizationFresh(authorization);return Object.freeze({committed:false,replayed:true,operation});
  }
  const effects=[],extra=[];
  const stmt=(sql,...params)=>effects.push(db.prepare(sql).bind(...params));
  const snapshot=async(table,names,where,params)=>{
    const sql=`SELECT json_array(${names.join(',')}) AS snapshot FROM ${table} WHERE ${where} LIMIT 2`;
    const rows=await fixedRead(db,sql,params);if(rows.length>1) fail('state_conflict',409);
    const value=rows[0]?.snapshot??null;
    extra.push({sql:`(${sql}) IS ?`,params:[...params,value]});
    return value===null?null:JSON.parse(value);
  };
  if(operation==='terms.accept') {exact(payload,[]);stmt('UPDATE users SET accepted_terms=1 WHERE telegram_id=?',subject);}
  else if(operation==='notification.manage_own') {
    exact(payload,['action'],['notificationId']);
    if(['view','archive','restore'].includes(payload.action)) {
      if(!positive(payload.notificationId)) fail('invalid_intent',400);
      const row=await snapshot('notifications',['id','recipient_id','is_read','archived_at'],'id=? AND recipient_id=?',[payload.notificationId,subject]);
      if(!row) fail('resource_unavailable',404);
      const statements={view:'UPDATE notifications SET is_read=1 WHERE id=? AND recipient_id=?',archive:'UPDATE notifications SET is_read=1,archived_at=CURRENT_TIMESTAMP WHERE id=? AND recipient_id=?',restore:'UPDATE notifications SET archived_at=NULL WHERE id=? AND recipient_id=?'};
      stmt(statements[payload.action],payload.notificationId,subject);
    } else if(payload.action==='mark_all_read'&&payload.notificationId===undefined) stmt('UPDATE notifications SET is_read=1 WHERE recipient_id=? AND archived_at IS NULL AND is_read=0',subject);
    else if(payload.action==='archive_read'&&payload.notificationId===undefined) stmt('UPDATE notifications SET archived_at=CURRENT_TIMESTAMP WHERE recipient_id=? AND archived_at IS NULL AND is_read=1',subject);
    else fail('invalid_intent',400);
  } else if(operation==='notification.settings.update_own') {
    exact(payload,['action']);if(payload.action!=='toggle') fail('invalid_intent',400);
    const row=await snapshot('notification_settings',['telegram_id','telegram_enabled','updated_at'],'telegram_id=?',[subject]);
    const enabled=row?row[1]===1?0:1:0;
    stmt('INSERT INTO notification_settings(telegram_id,telegram_enabled) VALUES(?,?) ON CONFLICT(telegram_id) DO UPDATE SET telegram_enabled=excluded.telegram_enabled,updated_at=CURRENT_TIMESTAMP',subject,enabled);
  } else if(operation==='catalog.preference.update_own') {
    exact(payload,['action'],['offerCode']);
    if(payload.action==='clear_favorites'&&payload.offerCode===undefined) stmt('DELETE FROM offer_favorites WHERE telegram_id=?',subject);
    else if(payload.action==='clear_recent'&&payload.offerCode===undefined) stmt('DELETE FROM recent_offer_views WHERE telegram_id=?',subject);
    else if(['add_favorite','remove_favorite'].includes(payload.action)&&safeCode(payload.offerCode)) {
      if(payload.action==='add_favorite') {
        const publicContext=await deriveTrustedOperationContext(context,{operation:'offer.read_public',requestPayload:{}});
        const visible=await getAuthorizer().authorize(publicContext,{kind:'offer',key:payload.offerCode});requireRuntimeAuthorization(visible);
        const check=compileDecisionAssertions(readRuntimeAuthorization(visible).decision);extra.push(...(check.assertions??[check]));
        stmt('INSERT OR IGNORE INTO offer_favorites(telegram_id,offer_code) VALUES(?,?)',subject,payload.offerCode);
      } else stmt('DELETE FROM offer_favorites WHERE telegram_id=? AND offer_code=?',subject,payload.offerCode);
    } else fail('invalid_intent',400);
  } else if(operation==='ai.settings.update_own') {
    exact(payload,['enabled']);if(typeof payload.enabled!=='boolean') fail('invalid_intent',400);
    if(payload.enabled && (actorFacts.ai?.consent?.consent_version!=='1.3.0-2026-08-27'||!actorFacts.ai.consent.consented_at||actorFacts.ai.consent.revoked_at)) fail('consent_required');
    stmt('INSERT INTO user_access(telegram_id,ai_enabled) VALUES(?,?) ON CONFLICT(telegram_id) DO UPDATE SET ai_enabled=excluded.ai_enabled,updated_at=CURRENT_TIMESTAMP',subject,payload.enabled?1:0);
  } else if(operation==='ai.consent.manage_own') {
    exact(payload,['action']);if(!['accept','revoke'].includes(payload.action)) fail('invalid_intent',400);
    if(payload.action==='accept') stmt("INSERT INTO ai_user_consents(telegram_id,consent_version,consented_at,revoked_at,updated_at) VALUES(?,'1.3.0-2026-08-27',CURRENT_TIMESTAMP,NULL,CURRENT_TIMESTAMP) ON CONFLICT(telegram_id) DO UPDATE SET consent_version=excluded.consent_version,consented_at=CURRENT_TIMESTAMP,revoked_at=NULL,updated_at=CURRENT_TIMESTAMP",subject);
    else {
      stmt("INSERT INTO ai_user_consents(telegram_id,consent_version,consented_at,revoked_at,updated_at) VALUES(?,'',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(telegram_id) DO UPDATE SET consent_version='',revoked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP",subject);
      stmt('DELETE FROM ai_conversation_messages WHERE telegram_id=?',subject);
    }
    stmt('INSERT INTO user_access(telegram_id,ai_enabled) VALUES(?,?) ON CONFLICT(telegram_id) DO UPDATE SET ai_enabled=excluded.ai_enabled,updated_at=CURRENT_TIMESTAMP',subject,payload.action==='accept'?1:0);
  } else if(operation==='ai.memory.clear_own') {exact(payload,[]);stmt('DELETE FROM ai_conversation_messages WHERE telegram_id=?',subject);}
  else if(operation==='profile.update_own') {
    exact(payload,['action','displayName','telegramUsername']);
    if(payload.action!=='sync_partner_contact'||typeof payload.displayName!=='string'||payload.displayName.trim().length<1||payload.displayName.length>120||
        payload.telegramUsername!==null&&!(typeof payload.telegramUsername==='string'&&/^[A-Za-z0-9_]{5,32}$/u.test(payload.telegramUsername))) fail('invalid_intent',400);
    const application=await snapshot('partner_applications',['id','telegram_id','display_name','telegram_username','contact','updated_at'],'telegram_id=?',[subject]);
    await snapshot('partner_profiles',['id','telegram_id','display_name','telegram_username','contact','updated_at'],'telegram_id=?',[subject]);
    if(!application) fail('resource_unavailable',404);
    if(payload.telegramUsername===null) stmt('UPDATE partner_public_settings SET public_username_enabled=0,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?',subject);
    else {
      const contact='@'+payload.telegramUsername;
      stmt('UPDATE partner_applications SET display_name=?,telegram_username=?,contact=?,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?',payload.displayName,payload.telegramUsername,contact,subject);
      stmt('UPDATE partner_profiles SET display_name=?,telegram_username=?,contact=?,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?',payload.displayName,payload.telegramUsername,contact,subject);
    }
  } else if(operation==='flow.cancel_own') {
    exact(payload,[]);stmt('DELETE FROM partner_sessions WHERE telegram_id=?',subject);stmt('DELETE FROM admin_sessions WHERE telegram_id=?',subject);
  }
  if(!effects.length) fail('unsupported_legacy_operation');
  const proof=compileDecisionAssertions(decision),pieces=[...(proof.assertions??[proof]),...extra];
  if(pieces.length>96) fail('authority_check_failed',503);
  const keys=pieces.map(()=>`v141tg_${crypto.randomUUID()}`);
  const before=pieces.map((piece,index)=>db.prepare('INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN ('+piece.sql+') THEN 1 ELSE 0 END)').bind(keys[index],...piece.params));
  const receipt=db.prepare("INSERT INTO mini_app_command_receipts(idempotency_key,request_hash,bot_id,actor_telegram_id,operation,commit_status,response_json,committed_at,precondition_ok) VALUES(?,?,?,?,?,'committed',?,unixepoch(),1)")
    .bind(key,requestHash,identity.botId,subject,operation,JSON.stringify({operation,committed:true}));
  const facts=readDecisionFacts(decision),resource=readResourceFacts(readRuntimeAuthorization(authorization).resource);
  const eventKey=await hash(`${TELEGRAM_RUNTIME_VERSION}\n${key}\n${requestHash}`);
  const audit=db.prepare(`INSERT INTO entitlement_decision_audit(audit_id,event_key,policy_version,capability,actor_kind,
    subject_telegram_id,actor_telegram_id,resource_ref,decision,reason_code,source_fingerprint,operation_ref,evaluated_at,valid_until,retention_until)
    VALUES(?,?,?,?,'customer',?,?,?,'allow','telegram_compatibility_committed',?,?,?,?,NULL)`)
    .bind(`v141tg_${eventKey}`,eventKey,FOUNDATION_POLICY_VERSION,operation,subject,subject,`${resource.kind}:${resource.ref}`,
      actorFacts.sourceFingerprint,key,facts.evaluatedAt,facts.validUntil);
  const after=keys.map(key=>db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key=?').bind(key));
  const statements=[...before,receipt,...effects,audit,...after],result=await db.batch(statements);
  if(!Array.isArray(result)||result.length!==statements.length||result.some(row=>row?.success!==true)||
      result[before.length]?.meta?.changes!==1||result[before.length+1+effects.length]?.meta?.changes!==1) fail('authority_outcome_unverified',503);
  return Object.freeze({committed:true,replayed:false,operation});
}
