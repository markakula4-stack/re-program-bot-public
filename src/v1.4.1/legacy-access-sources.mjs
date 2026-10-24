import {readTrustedContext,isTrustedContext} from './trusted-context.mjs';
import {isTrustedActor,readActorFacts,readActorContext,authoritySeconds} from './authority-resolver.mjs';
import {readDragonPreviewConfig,DRAGON_PREVIEW_PROGRAM_CODE} from '../v1.3.5/dragon-preview-core.mjs';
import {readReferralRewardConfig,REFERRAL_REWARD_PROGRAM_CODE,REFERRAL_REWARD_SECONDS} from '../v1.3.7/referral-reward-foundation.mjs';
import {readPackageReferralBonusClaimDatabaseSource} from '../v1.4.4/package-referral-bonus-runtime.mjs';

const sources=new WeakMap();
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const fail=code=>{throw Object.assign(new Error(code),{code,status:403});};
const columns=freeze({
  user_access:'telegram_id access_tier trial_used trial_started_at trial_ends_at updated_at',
  user_plans:'telegram_id plan_code source_code effective_from effective_until revision updated_at',
  user_access_states:'telegram_id access_state source_code state_started_at state_ends_at revision updated_at',
  trial_eligibility_checks:'check_id telegram_id subject_fingerprint program_code outcome channel_status checked_at',
  trial_grants:'grant_id telegram_id subject_fingerprint program_code source_code status started_at ends_at retention_until workflow_state granted_at updated_at',
  bonus_access_grants:'bonus_grant_id grant_key reward_id program_code beneficiary_telegram_id delivery_mode plan_code bonus_seconds grant_status available_at claim_expires_at claimed_at applied_at starts_at ends_at target_subscription_id compensation_ledger_entry_id compensated_seconds last_transition_id revision created_at updated_at',
  referral_rewards:'reward_id candidate_id program_code beneficiary_telegram_id buyer_telegram_id reward_seconds reward_status confirm_after confirmed_at cancelled_at last_transition_id revision created_at updated_at',
  referral_reward_candidates:'candidate_id program_code buyer_telegram_id inviter_telegram_id source_order_id source_payment_ledger_entry_id source_access_grant_id buyer_plan_code amount_stars first_started_at inviter_bound_at paid_at eligible_until confirm_after selected_at',
  subscription_orders:'order_id telegram_id plan_code currency amount_stars access_seconds billing_mode order_state paid_at applied_at',
  payment_ledger:'ledger_entry_id order_id telegram_id entry_type direction currency amount_stars telegram_payment_charge_id related_ledger_entry_id occurred_at recorded_at',
  subscription_access_grants:'grant_id subscription_id order_id payment_ledger_entry_id telegram_id plan_code access_seconds starts_at ends_at status compensation_ledger_entry_id',
  referral_reward_transitions:'transition_id transition_scope reward_id bonus_grant_id from_status to_status from_revision to_revision reason_code actor_type actor_id related_payment_ledger_entry_id occurred_at recorded_at',
  bonus_access_effects:'effect_id bonus_grant_id reward_id beneficiary_telegram_id effect_kind applied_transition_id recorded_at',
});
const positive=v=>Number.isSafeInteger(v)&&v>0;
const explicit=t=>t.channel==='telegram_callback'&&t.requestPayload&&typeof t.requestPayload==='object'&&
  !Array.isArray(t.requestPayload)&&Object.keys(t.requestPayload).length===0;
async function previewFingerprint(secret,id){
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${DRAGON_PREVIEW_PROGRAM_CODE}:${id}`)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function resolveLegacyAccessSources({context,actor}={}){
  if(!isTrustedContext(context)||!isTrustedActor(actor)||readActorContext(actor)!==context)fail('untrusted_legacy_access_source');
  const trusted=readTrustedContext(context),a=readActorFacts(actor),{operation,telegramId,db,nowSeconds:now,env}=trusted;
  if(trusted.actorKind!=='customer'||!['preview.activate_own','referral.bonus.claim_own'].includes(operation))fail('legacy_access_operation_mismatch');
  const proofs=[],canonical={},domain={handlerUnavailable:true};let validUntil=Math.min(trusted.expiresAt,a.validUntil),queryCount=0;
  const read=async(table,where,params,{order='',limit=1}={})=>{
    if(++queryCount>12||!Object.hasOwn(columns,table)||!Array.isArray(params))fail('legacy_access_query_budget_exhausted');
    const names=columns[table].split(' '),tail=`FROM ${table} WHERE ${where}${order?' ORDER BY '+order:''} LIMIT ${limit}`;
    const result=await db.prepare(`SELECT ${names.join(',')} ${tail}`).bind(...params).all();
    if(result?.success!==true||!Array.isArray(result.results)||result.results.length>limit||JSON.stringify(result.results).length>64000)fail('legacy_access_source_unavailable');
    const rows=result.results.map(row=>({...row})),snapshot=JSON.stringify(rows.map(row=>names.map(name=>row[name])));
    proofs.push({sql:`(SELECT COALESCE(json_group_array(json(snapshot)), '[]') FROM (SELECT json_array(${names.join(',')}) AS snapshot ${tail}))=?`,params:[...params,snapshot]});
    return rows;
  };
  const one=async(...args)=>(await read(...args))[0]??null;
  const future=t=>{if(positive(t)&&t>now)validUntil=Math.min(validUntil,t);};
  const hard=a.account.exists&&a.account.acceptedTerms&&!a.account.isBlocked&&!a.account.pendingDeletion&&
    a.access?.status==='verified'&&a.access.effectivePlan==='free'&&a.canonical.user?.telegram_id===telegramId;
  const joinedAt=authoritySeconds(a.canonical.user?.joined_at);
  if(operation==='preview.activate_own'){
    const config=readDragonPreviewConfig(env,now);
    // Context copies primitives. The existing executor separately retains its
    // real Workflow binding check; no invented binding is passed to config.
    const primitiveConfigured=config.enabled&&config.problems.every(problem=>problem==='workflow_binding');
    const fingerprint=config.antiAbuseSecret.length>=32?await previewFingerprint(config.antiAbuseSecret,telegramId):null;
    const checks=await read('trial_eligibility_checks','telegram_id=? AND program_code=?',[telegramId,DRAGON_PREVIEW_PROGRAM_CODE],{order:'checked_at DESC,check_id DESC',limit:1});
    const prior=await read('trial_grants','program_code=? AND (telegram_id=? OR subject_fingerprint=?)',
      [DRAGON_PREVIEW_PROGRAM_CODE,telegramId,fingerprint],{order:'granted_at DESC,grant_id',limit:2});
    const check=checks[0]??null,legacy=await one('user_access','telegram_id=?',[telegramId]);
    canonical.previewEligibilityCheck=check;canonical.priorPreviewGrants=prior;canonical.legacyAccess=legacy;
    const checked=check?.checked_at;
    future(positive(checked)?checked+60:null);future(config.programEndsAt);
    const membership=Boolean(check&&check.subject_fingerprint===fingerprint&&check.outcome==='eligible'&&
      ['creator','administrator','member','restricted'].includes(check.channel_status)&&positive(checked)&&checked<=now&&
      checked+60>now&&joinedAt!==null&&checked>=joinedAt);
    const eligible=Boolean(hard&&primitiveConfigured&&prior.length===0&&membership&&legacy&&legacy.trial_used===0&&
      legacy.access_tier==='free'&&a.access.accessOverlay!=='dragon_preview'&&
      !['active','cancel_at_period_end','refunded','suspended'].includes(a.access.accessState));
    Object.assign(domain,{previewEligible:eligible,membershipVerified:membership,explicitActivation:explicit(trusted),
      handlerUnavailable:!(eligible&&explicit(trusted)),previewWorkflowBindingRequired:true});
  }else{
    const config=readReferralRewardConfig(env);
    // Match the released findUserGrant ordering exactly, including a newer
    // terminal row hiding an older claimable row.
    const grant=await one('bonus_access_grants','beneficiary_telegram_id=? AND program_code=?',
      [telegramId,REFERRAL_REWARD_PROGRAM_CODE],{order:'created_at DESC,bonus_grant_id'});
    canonical.bonusGrant=grant;
    if(grant){
      const legacy=await one('user_access','telegram_id=?',[telegramId]);
      const plan=await one('user_plans','telegram_id=?',[telegramId]);
      const state=await one('user_access_states','telegram_id=?',[telegramId]);
      const reward=await one('referral_rewards','reward_id=?',[grant.reward_id]);
      const candidate=reward?await one('referral_reward_candidates','candidate_id=?',[reward.candidate_id]):null;
      const credit=candidate?await one('payment_ledger','ledger_entry_id=?',[candidate.source_payment_ledger_entry_id]):null;
      const order=candidate?await one('subscription_orders','order_id=?',[candidate.source_order_id]):null;
      const issued=candidate?await one('subscription_access_grants','grant_id=?',[candidate.source_access_grant_id]):null;
      const confirmation=reward?await one('referral_reward_transitions','transition_id=?',[reward.last_transition_id]):null;
      const compensations=candidate?await read('payment_ledger',"related_ledger_entry_id=? AND entry_type IN ('refund','chargeback')",
        [candidate.source_payment_ledger_entry_id],{order:'recorded_at,ledger_entry_id',limit:2}):[];
      const effects=await read('bonus_access_effects','bonus_grant_id=?',[grant.bonus_grant_id],{order:'recorded_at,effect_id',limit:2});
      Object.assign(canonical,{legacyAccess:legacy,plan,accessState:state,reward,candidate,paymentCredit:credit,paidOrder:order,sourceAccessGrant:issued,confirmationTransition:confirmation,
        compensationRows:compensations,existingBonusEffects:effects});
      future(grant.available_at);future(positive(grant.claim_expires_at)?grant.claim_expires_at+1:null);
      const financial=Boolean(candidate&&credit&&order&&issued&&credit.entry_type==='payment'&&credit.direction==='credit'&&credit.currency==='XTR'&&
        credit.order_id===order.order_id&&credit.telegram_id===candidate.buyer_telegram_id&&credit.amount_stars===candidate.amount_stars&&
        credit.amount_stars===order.amount_stars&&['paid','applied'].includes(order.order_state)&&order.telegram_id===candidate.buyer_telegram_id&&
        issued.order_id===order.order_id&&issued.payment_ledger_entry_id===credit.ledger_entry_id&&issued.telegram_id===candidate.buyer_telegram_id&&
        issued.status==='active'&&issued.compensation_ledger_entry_id===null&&compensations.length===0);
      const confirmed=Boolean(reward&&candidate&&confirmation&&reward.program_code===REFERRAL_REWARD_PROGRAM_CODE&&
        reward.reward_status==='confirmed'&&reward.beneficiary_telegram_id===telegramId&&reward.buyer_telegram_id===candidate.buyer_telegram_id&&
        candidate.inviter_telegram_id===telegramId&&confirmation.transition_scope==='reward'&&confirmation.reward_id===reward.reward_id&&
        confirmation.from_status==='pending'&&confirmation.to_status==='confirmed'&&confirmation.reason_code==='hold_elapsed'&&
        confirmation.to_revision===reward.revision&&confirmation.related_payment_ledger_entry_id===candidate.source_payment_ledger_entry_id);
      const claimable=Boolean(hard&&config.bonusGrantsEnabled&&explicit(trusted)&&financial&&confirmed&&
        legacy&&legacy.access_tier!=='team'&&plan?.plan_code==='free'&&positive(plan.revision)&&positive(state?.revision)&&
        state.access_state===a.access.accessState&&
        grant.reward_id===reward.reward_id&&grant.delivery_mode==='manual_claim'&&grant.grant_status==='claimable'&&
        grant.plan_code==='professional'&&grant.bonus_seconds===REFERRAL_REWARD_SECONDS.bonusAccess&&
        positive(grant.revision)&&positive(grant.available_at)&&positive(grant.claim_expires_at)&&
        grant.available_at<=now&&grant.claim_expires_at>=now&&grant.compensation_ledger_entry_id===null&&effects.length===0&&
        joinedAt!==null&&grant.created_at>=joinedAt&&['none','trial','expired','refunded'].includes(a.access.accessState)&&
        ['none','dragon_preview'].includes(a.access.accessOverlay));
      Object.assign(domain,{referralClaimable:claimable,referralGrantId:grant.bonus_grant_id,
        referralRewardId:grant.reward_id,handlerUnavailable:!claimable});
    }
    if(!grant) {
      const packageBonus=await readPackageReferralBonusClaimDatabaseSource({db,env,telegramId,nowSec:now});
      if(!Array.isArray(packageBonus.captures)||packageBonus.captures.length>12)fail('legacy_access_source_unavailable');
      for(const capture of packageBonus.captures) {
        if(typeof capture.sql!=='string'||!Array.isArray(capture.params)||capture.params.length>98)fail('legacy_access_source_unavailable');
        proofs.push({sql:`(${capture.sql}) IS ?`,params:[...capture.params,capture.snapshot]});
      }
      validUntil=Math.min(validUntil,packageBonus.validUntil);
      const bonus=packageBonus.grant;
      if(bonus) {
        const claimable=Boolean(hard&&config.bonusGrantsEnabled&&explicit(trusted)&&packageBonus.claimableByEvidence&&
          joinedAt!==null&&bonus.created_at>=joinedAt&&['none','trial','expired','refunded'].includes(a.access.accessState)&&
          ['none','dragon_preview'].includes(a.access.accessOverlay));
        canonical.bonusGrant=bonus;canonical.packageReferralBonus=true;
        Object.assign(domain,{referralClaimable:claimable,referralGrantId:bonus.bonus_grant_id,
          referralRewardId:bonus.reward_id,handlerUnavailable:!claimable});
      }
    }
  }
  proofs.push({sql:'unixepoch() < ?',params:[validUntil]});
  const source=Object.freeze({version:1});sources.set(source,freeze({context,facts:{domain,canonical,validUntil},assertions:proofs}));return source;
}
export const isLegacyAccessSource=value=>Boolean(value&&sources.has(value));
const get=value=>{const source=sources.get(value);if(!source)fail('untrusted_legacy_access_source');return source;};
export const readLegacyAccessSourceFacts=value=>get(value).facts;
export const readLegacyAccessSourceContext=value=>get(value).context;
export const compileLegacyAccessSourceAssertions=value=>({assertions:get(value).assertions});
