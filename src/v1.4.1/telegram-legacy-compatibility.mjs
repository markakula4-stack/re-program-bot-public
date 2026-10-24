import { createRuntimeAuthorizer, readRuntimeAuthorization, requireRuntimeAuthorization,
  assertRuntimeAuthorizationFresh } from './runtime-authorizer.mjs';
import { readDecisionFacts, compileDecisionAssertions } from './entitlement-engine.mjs';
import { compileProofReadQueries, proofReadResultsValid } from './proof-queries.mjs';
import { readTrustedContext, refreshTrustedContext, releaseConsumedTelegramFlowContext,
  restrictTrustedContextForWrapper } from './trusted-context.mjs';
import { readActorFacts, compileAuthorityAssertions } from './authority-resolver.mjs';
import { readResourceFacts, compileResourceAssertions } from './resource-resolver.mjs';
import { readConfirmedStarsRefundEvidence } from '../v1.3.6/stars-access-runtime.mjs';

// This facade is issued only to a selected, genuinely allowed server handler.
// Its SQL surface is the existing static domain executor, never a request API.
const permits=new WeakMap(), environments=new WeakMap(), statements=new WeakMap(),facades=new WeakSet();
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){
  for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const fail=code=>{throw Object.assign(new Error(code),{code,status:403});};
const housekeeping=['admin_audit_log','notifications','notification_settings','bot_error_log'];
const access=['user_plans','user_access_states','access_status_history','trial_grants','notification_jobs','trial_funnel_events','user_access'];
const bonus=['referral_reward_transitions','bonus_access_grants','bonus_access_effects','bonus_access_reversals',
  'bonus_access_expiry_events','referral_reward_protection_checks','referral_reward_protection_jobs','referral_reward_notice_jobs'];
const financial=['payment_refunds','payment_events','payment_ledger','subscription_orders','subscriptions',
  'subscription_access_grants','subscription_status_history',...access];
const definitions={
  'admin.catalog.manage':{writes:['offers','offer_owners','offer_versions','offer_visibility_rules','offer_moderation_decisions',
    'offer_visibility_assignments','partner_offer_links','offer_favorites','recent_offer_views'],sessions:['admin_sessions']},
  'admin.settings.manage':{writes:['ai_runtime_settings','official_web_settings','official_sources','official_source_paths',
    'official_source_checks','official_source_errors','official_source_cache_meta','ai_source_snapshots','partner_beta_settings',
    'analytics_v2_settings','analytics_v139_owner_runtime','analytics_v139_partner_pilot','plan_compatibility_settings'],sessions:['admin_sessions']},
  'admin.partner_link.review':{writes:['partner_links'],sessions:['admin_sessions']},
  'admin.broadcast.send':{writes:['admin_broadcasts','admin_broadcast_deliveries','admin_broadcast_delivery_claims','users'],sessions:['admin_sessions']},
  'admin.result.repair':{writes:['lead_requests','conversions','referral_reward_candidates','referral_rewards','subscriptions',...access,...bonus],sessions:['admin_sessions']},
  'admin.user.moderation':{writes:['users','user_moderation_blocks','user_moderation_events','admin_moderation_sessions'],sessions:['admin_sessions']},
  'admin.stars.refund':{writes:financial,sessions:['admin_sessions']},
  'admin.stars.reconcile':{writes:[...financial,'payment_reconciliation_runs','payment_reconciliation_items',
    'subscription_payment_links','subscription_payment_review_receipts','payment_review_resolutions',
    'referral_reward_candidates','referral_rewards',...bonus],sessions:['admin_sessions']},
  'partner.link.manage_own':{writes:['partner_links','funnel_events'],sessions:['partner_sessions']},
  'preview.activate_own':{writes:['trial_eligibility_checks',...access],sessions:[]},
  'referral.bonus.claim_own':{writes:['subscriptions',...access,...bonus],sessions:[]},
  'billing.purchase_monthly':{writes:['terms_acceptances','subscription_orders','payment_events','subscriptions',
    'subscription_status_history',...access],sessions:[]},
  'offer.open_action':{writes:['offer_clicks','recent_offer_views','partner_link_clicks','funnel_events'],sessions:[]},
  'channel.check_membership':{writes:['funnel_events','trial_eligibility_checks'],sessions:[]},
};
export const LEGACY_COMPATIBILITY_FAMILIES=freeze(Object.fromEntries(Object.entries(definitions).map(([key,row])=>
  [key,{capability:key,writeTables:[...new Set(row.writes)],finalizationTables:[...housekeeping,...row.sessions]}])));
const aliases={stars_purchase:'billing.purchase_monthly',stars_refund:'admin.stars.refund'};
const scopes=['kind','ref','ownerTelegramId','subjectTelegramId','partnerProfileId','tenantKey'];
const PACKAGE_RECONCILIATION_TABLES = ['payment_ledger','payment_events','subscription_orders','subscription_package_payment_reviews'];
const facts=permit=>{const value=permits.get(permit);if(!value)fail('untrusted_legacy_compatibility');return value;};
const envFacts=env=>{const value=environments.get(env);if(!value)fail('untrusted_legacy_compatibility_env');return value;};

// Quoted strings/identifiers and comments cannot introduce another statement.
// Only SELECT, INSERT, UPDATE and DELETE are admitted; DDL/PRAGMA/CTEs are closed.
function tokenize(sql){
  if(typeof sql!=='string'||!sql.trim()||sql.length>65536)fail('legacy_sql_unsupported');
  const tokens=[];let p=0,parameter=0;
  while(p<sql.length){const c=sql[p];if(/\s/u.test(c)){p++;continue;}
    if(sql.startsWith('--',p)){const end=sql.indexOf('\n',p);p=end<0?sql.length:end+1;continue;}
    if(sql.startsWith('/*',p)){const end=sql.indexOf('*/',p+2);if(end<0)fail('legacy_sql_unsupported');p=end+2;continue;}
    if(c==="'"||c==='"'||c==='`'||c==='['){const endChar=c==='['?']':c;let value='',closed=false;p++;
      while(p<sql.length){if(sql[p]===endChar){if(c!=='['&&sql[p+1]===endChar){value+=endChar;p+=2;continue;}p++;closed=true;break;}value+=sql[p++];}
      if(!closed)fail('legacy_sql_unsupported');tokens.push({text:value,type:c==="'"?'literal':'identifier'});continue;}
    if(c==='?'){if(/[0-9]/u.test(sql[p+1]??''))fail('legacy_sql_unsupported');tokens.push({text:'?',type:'parameter',index:parameter++});p++;continue;}
    if(/[A-Za-z_]/u.test(c)){const start=p++;while(/[A-Za-z0-9_]/u.test(sql[p]??''))p++;tokens.push({text:sql.slice(start,p).toLowerCase(),type:'word'});continue;}
    if(/[0-9]/u.test(c)){const start=p++;while(/[0-9.]/u.test(sql[p]??''))p++;tokens.push({text:sql.slice(start,p),type:'number'});continue;}
    if(c===':'||c==='@'||c==='$')fail('legacy_sql_unsupported');tokens.push({text:c,type:'symbol'});p++;
  }
  if(tokens.at(-1)?.text===';')tokens.pop();if(tokens.some(t=>t.text===';'))fail('legacy_sql_multiple_statements');
  const word=t=>t?.type==='word'?t.text:null;
  if(tokens.some(t=>['pragma','attach','detach','vacuum','create','alter','drop'].includes(word(t))))fail('legacy_sql_unsupported');
  const verb=word(tokens[0]);if(verb==='select'){
    if(tokens.some(t=>['insert','update','delete'].includes(word(t))))fail('legacy_sql_unsupported');
    return {sql,tokens,verb,table:null,write:false,parameterCount:parameter};}
  let index=1;if(verb==='insert'){
    if(word(tokens[index])==='or'&&['ignore','abort','fail','rollback','replace'].includes(word(tokens[index+1])))index+=2;
    if(word(tokens[index])!=='into')fail('legacy_sql_unsupported');index++;
  }else if(verb==='delete'){if(word(tokens[index])!=='from')fail('legacy_sql_unsupported');index++;}
  else if(verb!=='update')fail('legacy_sql_unsupported');
  const target=tokens[index];if(!target||!['word','identifier'].includes(target.type)||!/^[_a-z][_a-z0-9]*$/u.test(target.text))fail('legacy_sql_unsupported');
  if(tokens[index+1]?.text==='.')fail('legacy_sql_unsupported');
  if(verb==='insert'){
    const values=tokens.findIndex(t=>t.type==='word'&&t.text==='values');
    if(values>=0){let depth=0;for(let i=values+1;i<tokens.length;i++){
      if(tokens[i].text==='(')depth++;else if(tokens[i].text===')'&&--depth===0){
        if(tokens[i+1]?.text===',')fail('legacy_sql_unsupported');break;}}}
  }
  return {sql,tokens,verb,table:target.text,tableIndex:index,write:true,parameterCount:parameter};
}
const valueOf=(token,params)=>token?.type==='parameter'?params[token.index]:token?.type==='literal'?token.text:
  token?.type==='number'?Number(token.text):undefined;
function hasBoundKey(parsed,params,names,expected){
  const ts=parsed.tokens;
  let start=0;
  if(parsed.verb==='update'||parsed.verb==='delete'){
    let depth=0;start=-1;
    for(let i=parsed.tableIndex+1;i<ts.length;i++){if(ts[i].text==='(')depth++;if(ts[i].text===')')depth--;
      if(depth===0&&ts[i].type==='word'&&ts[i].text==='where'){start=i+1;break;}}
    if(start<0)return false;
    if(ts.slice(start).some(t=>t.type==='word'&&t.text==='or'))return false;
  }
  for(let i=start;i<ts.length-2;i++)if(names.includes(ts[i].text)&&['word','identifier'].includes(ts[i].type)&&ts[i+1].text==='='&&
    valueOf(ts[i+2],params)===expected)return true;
  if(parsed.verb==='insert'&&ts[parsed.tableIndex+1]?.text==='('){
    const end=ts.findIndex((t,i)=>i>parsed.tableIndex+1&&t.text===')');
    const columns=ts.slice(parsed.tableIndex+2,end).filter(t=>t.text!==',');
    const values=ts.findIndex((t,i)=>i>end&&t.type==='word'&&t.text==='values');
    if(values>=0&&ts[values+1]?.text==='('){
      const row=[];let depth=0,start=values+2;
      for(let i=start;i<ts.length;i++){if(ts[i].text==='(')depth++;if(ts[i].text===')'){if(depth===0){row.push(ts.slice(start,i));break;}depth--;}
        if(ts[i].text===','&&depth===0){row.push(ts.slice(start,i));start=i+1;}}
      for(let i=0;i<columns.length;i++)if(names.includes(columns[i].text)&&row[i]?.length===1&&valueOf(row[i][0],params)===expected)return true;
    }
  }
  return false;
}
function verifyWriteScope(state,parsed,params,batchPreviewGrantId=null){
  if(state.packageReconciliation)return verifyPackageReconciliationScope(state,parsed,params);
  if(state.accounting)return verifyAccountingScope(state,parsed,params);
  const {table}=parsed,r=state.resourceFacts,id=state.identity.telegramId,p=state.identity.requestPayload??{};
  const row=LEGACY_COMPATIBILITY_FAMILIES[state.family];
  if(!row.writeTables.includes(table)&&!row.finalizationTables.includes(table))fail('legacy_write_table_forbidden');
  if(['admin_sessions','partner_sessions'].includes(table)&&!hasBoundKey(parsed,params,['telegram_id'],id))fail('legacy_write_scope_mismatch');
  if(table==='admin_moderation_sessions'&&!hasBoundKey(parsed,params,['admin_telegram_id'],id))fail('legacy_write_scope_mismatch');
  if(table==='notification_settings'){
    const lead=r.canonical?.existingLead??r.canonical?.target;
    const recipientIds=[id,r.ownerTelegramId,r.subjectTelegramId,lead?.telegramId,lead?.telegram_id,
      lead?.inviterId,lead?.inviter_id,r.canonical?.partnerProfile?.telegramId,Number(state.identity.env.ADMIN_ID)];
    if(!recipientIds.some(target=>Number.isSafeInteger(target)&&target>0&&hasBoundKey(parsed,params,['telegram_id'],target)))fail('legacy_write_scope_mismatch');
  }
  if(table==='admin_audit_log'&&parsed.verb==='insert'&&!hasBoundKey(parsed,params,['actor_id'],id))fail('legacy_write_scope_mismatch');
  if(state.family==='admin.catalog.manage'&&row.writeTables.includes(table)){
    const creation=r.kind==='admin_surface'&&r.ref==='catalog_creation'&&p.action==='create'&&table==='offers'&&parsed.verb==='insert';
    const code=creation?p.offerCode:r.kind==='offer'?r.ref:null;
    if(!code||!hasBoundKey(parsed,params,table==='offers'?['code']:['offer_code'],code))fail('legacy_write_scope_mismatch');
  }
  if(table==='partner_links'){
    if(r.kind==='partner_link'){if(!hasBoundKey(parsed,params,['id'],r.ref))fail('legacy_write_scope_mismatch');}
    else if(state.family==='partner.link.manage_own'&&state.actorFacts.partner?.profileId){
      if(!hasBoundKey(parsed,params,['partner_profile_id'],state.actorFacts.partner.profileId))fail('legacy_write_scope_mismatch');
    }else fail('legacy_write_scope_mismatch');
  }
  if(state.family==='admin.user.moderation'&&['users','user_moderation_blocks','user_moderation_events'].includes(table)&&
    (r.kind!=='user'||!hasBoundKey(parsed,params,['telegram_id','target_telegram_id'],r.ref)))fail('legacy_write_scope_mismatch');
  if(state.family==='admin.result.repair'&&['lead_requests','conversions'].includes(table)){
    const lead=r.canonical?.existingLead??r.canonical?.target;
    if(!lead||!hasBoundKey(parsed,params,['id','lead_id'],lead.id)&&
      !(hasBoundKey(parsed,params,['telegram_id'],lead.telegramId??lead.telegram_id)&&hasBoundKey(parsed,params,['offer_code'],lead.offerCode??lead.offer_code)))fail('legacy_write_scope_mismatch');
  }
  if(state.family==='admin.result.repair'&&row.writeTables.includes(table)&&!['lead_requests','conversions'].includes(table))
    verifyMaintenanceScope(state,parsed,params);
  if(state.family==='admin.broadcast.send'&&row.writeTables.includes(table)){
    if(table==='admin_broadcasts'&&parsed.verb==='insert'){if(!hasBoundKey(parsed,params,['actor_id'],id))fail('legacy_write_scope_mismatch');}
    else if(table==='users')fail('legacy_write_scope_mismatch');
    else if(!Number.isSafeInteger(p.broadcastId)||!hasBoundKey(parsed,params,table==='admin_broadcasts'?['id']:['broadcast_id'],p.broadcastId))fail('legacy_write_scope_mismatch');
  }
  const previewSelect=state.family==='preview.activate_own'&&parsed.verb==='insert'&&batchPreviewGrantId&&
    /\bfrom\s+trial_grants\s+where\s+grant_id\s*=\s*\?/iu.test(parsed.sql)&&
    !parsed.tokens.some((t,i)=>i>parsed.tableIndex+1&&t.type==='word'&&t.text==='or')&&hasBoundKey(parsed,params,['grant_id'],batchPreviewGrantId);
  if(['preview.activate_own','referral.bonus.claim_own','billing.purchase_monthly','offer.open_action','channel.check_membership'].includes(state.family)&&
    row.writeTables.includes(table)&&['user_access','user_plans','user_access_states','terms_acceptances','offer_clicks','recent_offer_views','partner_link_clicks','funnel_events','trial_eligibility_checks'].includes(table)&&
    !hasBoundKey(parsed,params,['telegram_id'],id)&&!previewSelect)fail('legacy_write_scope_mismatch');
  if(state.family==='offer.open_action'&&['offer_clicks','recent_offer_views'].includes(table)){
    const code=r.canonical?.offer?.code??(r.kind==='offer'?r.ref:null);
    if(!code||!hasBoundKey(parsed,params,['offer_code'],code))fail('legacy_write_scope_mismatch');
  }
  if(state.family==='offer.open_action'&&table==='partner_link_clicks'){
    const link=r.canonical?.currentRoute?.partnerLinkId;
    if(!link||!hasBoundKey(parsed,params,['partner_link_id'],link))fail('legacy_write_scope_mismatch');
  }
  if(state.family==='channel.check_membership'&&table==='trial_eligibility_checks'&&
    (p.action!=='preview_check'||Object.keys(p).length!==1||parsed.verb!=='insert'))fail('legacy_write_scope_mismatch');
  if(state.family==='referral.bonus.claim_own'&&row.writeTables.includes(table)){
    const grant=r.canonical?.bonusGrant;
    if(!grant||grant.beneficiary_telegram_id!==id)fail('legacy_write_scope_mismatch');
    if(bonus.includes(table)&&(!hasBoundKey(parsed,params,['bonus_grant_id'],grant.bonus_grant_id)||
      parsed.verb==='insert'&&!hasBoundKey(parsed,params,['reward_id'],grant.reward_id)))fail('legacy_write_scope_mismatch');
    if(['subscriptions','trial_grants','notification_jobs','access_status_history','trial_funnel_events'].includes(table)&&
      !hasBoundKey(parsed,params,['telegram_id'],id))fail('legacy_write_scope_mismatch');
  }
  if(state.family==='preview.activate_own'&&table==='trial_grants'){
    if(parsed.verb==='insert'){
      const fingerprint=r.canonical?.previewEligibilityCheck?.subject_fingerprint;
      if(!fingerprint||!hasBoundKey(parsed,params,['telegram_id'],id)||!hasBoundKey(parsed,params,['subject_fingerprint'],fingerprint)||
        !hasBoundKey(parsed,params,['program_code'],'dragon_preview'))fail('legacy_write_scope_mismatch');
    }else if(!isPreviewFinalizer(state,{parsed,params}))fail('legacy_write_scope_mismatch');
  }
}
function maintenanceRows(state){
  const r=state.resourceFacts,p=state.identity.requestPayload;
  if(r.kind!=='admin_surface'||r.ref!=='result_repair'||p?.action!=='referral_repair'||Object.keys(p).length!==1||
    !r.canonical?.maintenanceQueues)fail('legacy_write_scope_mismatch');
  return Object.values(r.canonical.maintenanceQueues).flat();
}
function expiredNoticeBulk(state,parsed,params){
  if(parsed.table!=='referral_reward_notice_jobs'||parsed.verb!=='update')return false;
  const text=parsed.sql.replace(/\s+/gu,' ').trim().toLowerCase();
  return text==="update referral_reward_notice_jobs set delivery_state = 'manual_review', lease_token = null, lease_expires_at = null, last_error_code = 'delivery_lease_outcome_unknown', updated_at = ? where delivery_state = 'processing' and lease_expires_at < ?"&&
    params.length===2&&positiveTime(params[0])&&params[0]===params[1];
}
function verifyMaintenanceScope(state,parsed,params){
  const rows=maintenanceRows(state),need=(names,field)=>rows.some(row=>row[field]!==null&&row[field]!==undefined&&hasBoundKey(parsed,params,names,row[field]));
  const table=parsed.table;
  if(table==='referral_reward_notice_jobs'){
    if(expiredNoticeBulk(state,parsed,params))return;
    if(!need(['notice_key'],'notice_key'))fail('legacy_write_scope_mismatch');return;
  }
  if(['user_plans','user_access_states','access_status_history','user_access','subscriptions','trial_grants','notification_jobs','trial_funnel_events'].includes(table)){
    if(!need(['telegram_id'],'beneficiary_telegram_id'))fail('legacy_write_scope_mismatch');return;
  }
  if(table==='bonus_access_grants'&&parsed.verb==='insert'){
    if(!rows.some(row=>hasBoundKey(parsed,params,['reward_id'],row.reward_id)&&
      hasBoundKey(parsed,params,['beneficiary_telegram_id'],row.beneficiary_telegram_id)))fail('legacy_write_scope_mismatch');return;
  }
  if(table==='referral_reward_candidates'){
    if(!need(['candidate_id'],'candidate_id'))fail('legacy_write_scope_mismatch');return;
  }
  if(['referral_rewards','referral_reward_protection_jobs','referral_reward_protection_checks','referral_reward_transitions'].includes(table)){
    if(!need(['reward_id'],'reward_id'))fail('legacy_write_scope_mismatch');return;
  }
  if(!need(['bonus_grant_id'],'bonus_grant_id')&&!need(['reward_id'],'reward_id'))fail('legacy_write_scope_mismatch');
}
function maintenanceAssertions(state,items){
  if(state.family!=='admin.result.repair'||!items.some(item=>expiredNoticeBulk(state,item.parsed,item.params)))return [];
  maintenanceRows(state);
  const keys=state.resourceFacts.canonical.maintenanceQueues.expiredNotices.map(row=>row.notice_key);
  return items.filter(item=>expiredNoticeBulk(state,item.parsed,item.params)).map(item=>({
    sql:`NOT EXISTS(SELECT 1 FROM referral_reward_notice_jobs WHERE delivery_state='processing' AND lease_expires_at<?${keys.length?' AND notice_key NOT IN ('+keys.map(()=>'?').join(',')+')':''})`,
    params:[item.params[1],...keys]}));
}
function insertedValue(item,name){return item.params.find(value=>hasBoundKey(item.parsed,item.params,[name],value));}
function isPreviewFinalizer(state,item){
  const g=state.createdPreviewGrant;if(!g||state.family!=='preview.activate_own')return false;
  const {parsed,params}=item;
  if(parsed.table==='trial_grants'&&parsed.verb==='update'){
    const text=parsed.sql.replace(/\s+/gu,' ').trim().toLowerCase();
    return /^update trial_grants set workflow_state = \?, workflow_error_code = \?, updated_at = \? where grant_id = \?;?$/u.test(text)&&
      ['pending','started','start_failed','completed'].includes(params[0])&&typeof params[1]==='string'&&params[1].length<=64&&
      positiveTime(params[2])&&params[3]===g.id;
  }
  return parsed.table==='trial_eligibility_checks'&&parsed.verb==='insert'&&
    hasBoundKey(parsed,params,['telegram_id'],state.identity.telegramId)&&hasBoundKey(parsed,params,['subject_fingerprint'],g.fingerprint)&&
    hasBoundKey(parsed,params,['program_code'],'dragon_preview')&&
    ['granted','already_used'].some(value=>hasBoundKey(parsed,params,['outcome'],value));
}
const positiveTime=value=>Number.isSafeInteger(value)&&value>0;
function sealedPreviewGuard(state){const g=state.createdPreviewGrant;return {
  sql:"EXISTS(SELECT 1 FROM trial_grants WHERE grant_id=? AND telegram_id=? AND subject_fingerprint=? AND program_code='dragon_preview' AND source_code='dragon_preview:v1.3.5-hotfix.1' AND status='active' AND started_at=? AND ends_at=? AND ends_at=started_at+604800 AND ends_at>unixepoch() AND workflow_instance_id=?)",
  params:[g.id,state.identity.telegramId,g.fingerprint,g.startedAt,g.endsAt,g.workflowInstanceId]};}
function completionProofs(state,bundle){
  const b=readRuntimeAuthorization(bundle),actor=readActorFacts(b.actor),resource=readResourceFacts(b.resource),old=state.actorFacts;
  if(!actor.account.exists||!actor.account.acceptedTerms||actor.account.isBlocked||actor.account.pendingDeletion||
    actor.accountFingerprint!==old.accountFingerprint||JSON.stringify(actor.roles)!==JSON.stringify(old.roles)||
    scopes.some(key=>resource[key]!==state.resourceFacts[key]))fail('legacy_finalization_scope_changed');
  return [...proofPieces(compileAuthorityAssertions(b.actor)),...proofPieces(compileResourceAssertions(b.resource)),sealedPreviewGuard(state)];
}
function validateEnvironment(state,env){
  for(const [key,value]of Object.entries(state.identity.env))if(key!=='V141_AUTHORIZATION_ENABLED'&&env[key]!==value)fail('legacy_configuration_changed');
  if(env.DB!==state.facade||env.V141_AUTHORIZATION_ENABLED!=='false')fail('legacy_configuration_changed');
}
function resourceRef(f,capability){
  if(['preview.activate_own','referral.bonus.claim_own','billing.purchase_monthly','channel.check_membership'].includes(capability))return null;
  if(capability==='partner.link.manage_own'&&f.kind==='partner_profile')return null;
  if(f.kind==='actor'||f.kind==='admin_surface')return null;
  return freeze({kind:f.kind,key:f.ref});
}
async function currentBundle(state){
  const context=await refreshTrustedContext(state.context);
  return createRuntimeAuthorizer().authorize(context,state.resourceRef);
}
function proofPieces(proof){return proof.assertions??[proof];}
async function proofsFor(state,items){
  if(state.packageReconciliation)return {bundle:null,pieces:state.packageReconciliation.assertions};
  if(state.accounting)return {bundle:null,pieces:state.accounting.assertions};
  if(!state.primaryCommitted&&!state.forceRefresh)return {bundle:state.authorization,pieces:proofPieces(compileDecisionAssertions(readRuntimeAuthorization(state.authorization).decision))};
  const bundle=await currentBundle(state),b=readRuntimeAuthorization(bundle),decision=readDecisionFacts(b.decision);
  if(items.length&&items.every(item=>isPreviewFinalizer(state,item)))return {bundle,pieces:completionProofs(state,bundle)};
  if(decision.publicDTO.allowed===true)return {bundle,pieces:proofPieces(compileDecisionAssertions(b.decision))};
  if(!state.primaryCommitted)fail(decision.publicDTO.reasonCode??'capability_denied');
  const row=LEGACY_COMPATIBILITY_FAMILIES[state.family];
  if(!['state_conflict','prerequisite_required','resource_unavailable'].includes(decision.publicDTO.reasonCode))
    fail(decision.publicDTO.reasonCode??'capability_denied');
  if(items.some(item=>!row.finalizationTables.includes(item.parsed.table)))fail(decision.publicDTO.reasonCode??'capability_denied');
  const actor=readActorFacts(b.actor),resource=readResourceFacts(b.resource),old=state.actorFacts;
  if(!actor.account.exists||!actor.account.acceptedTerms||actor.account.isBlocked||actor.account.pendingDeletion||
    actor.accountFingerprint!==old.accountFingerprint||JSON.stringify(actor.roles)!==JSON.stringify(old.roles)||
    old.canonicalOwner&&!actor.canonicalOwner||scopes.some(key=>resource[key]!==state.resourceFacts[key]))fail('legacy_finalization_scope_changed');
  return {bundle,pieces:[...proofPieces(compileAuthorityAssertions(b.actor)),...proofPieces(compileResourceAssertions(b.resource))]};
}
async function executeWrites(state,items){
  const insertedPreview=state.family==='preview.activate_own'?items.find(item=>item.parsed.table==='trial_grants'&&item.parsed.verb==='insert'):null;
  const pendingPreviewId=insertedPreview?insertedValue(insertedPreview,'grant_id'):null;
  // The owner/HMAC of the primary INSERT is checked first. Its dependent
  // INSERT SELECT statements may reference only that same in-batch grant.
  if(insertedPreview)verifyWriteScope(state,insertedPreview.parsed,insertedPreview.params);
  for(const item of items)if(item.parsed.write)verifyWriteScope(state,item.parsed,item.params,pendingPreviewId);
  const {bundle,pieces:sourcePieces}=await proofsFor(state,items.filter(item=>item.parsed.write));
  const pieces=[...sourcePieces,...maintenanceAssertions(state,items)];
  if(pieces.length+items.length+1>96)fail('legacy_query_budget_exhausted');
  const guardRoot='v141_legacy:'+crypto.randomUUID(),guards=[];
  const batch=pieces.map((piece,index)=>{const key=guardRoot+':'+index;guards.push(key);
    if(piece.params.length>99)fail('legacy_query_budget_exhausted');
    return state.db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN (${piece.sql}) THEN 1 ELSE 0 END)`).bind(key,...piece.params);});
  batch.push(...items.map(item=>state.db.prepare(item.parsed.sql).bind(...item.params)));
  batch.push(state.db.prepare(`DELETE FROM mini_app_atomic_guards WHERE guard_key IN (${guards.map(()=>'?').join(',')})`).bind(...guards));
  const results=await state.db.batch(batch);
  if(!Array.isArray(results)||results.length!==batch.length||results.some(result=>result?.success!==true))fail('legacy_write_outcome_unknown');
  if(bundle)state.context=readRuntimeAuthorization(bundle).context;
  const original=results.slice(pieces.length,pieces.length+items.length);
  for(let i=0;i<items.length;i++)if(state.family==='preview.activate_own'&&items[i].parsed.table==='trial_grants'&&items[i].parsed.verb==='insert'&&
    (Number(original[i]?.meta?.changes)>0||original[i]?.results?.length>0)){
    const item=items[i];state.createdPreviewGrant=Object.freeze({id:insertedValue(item,'grant_id'),fingerprint:insertedValue(item,'subject_fingerprint'),
      startedAt:insertedValue(item,'started_at'),endsAt:insertedValue(item,'ends_at'),workflowInstanceId:insertedValue(item,'workflow_instance_id')});
  }
  if(items.some((item,index)=>item.parsed.write&&LEGACY_COMPATIBILITY_FAMILIES[state.family].writeTables.includes(item.parsed.table)&&
    (Number(original[index]?.meta?.changes)>0||original[index]?.results?.length>0)))state.primaryCommitted=true;
  // A captured own flow can only be released after its fenced actual mutation.
  for(let i=0;i<items.length;i++)if(['admin_sessions','partner_sessions'].includes(items[i].parsed.table)&&
    items[i].parsed.write&&Number(original[i]?.meta?.changes)>0)
    state.context=releaseConsumedTelegramFlowContext(state.context,{kind:items[i].parsed.table==='admin_sessions'?'admin':'partner'});
  return original;
}
function facadeFor(state){
  const facade={prepare(sql){const parsed=tokenize(sql);
    if(parsed.write&&state.packageReconciliation&&!PACKAGE_RECONCILIATION_TABLES.includes(parsed.table))fail('legacy_write_table_forbidden');
    if(parsed.write&&state.accounting&&!ACCOUNTING_TABLES.includes(parsed.table))fail('legacy_write_table_forbidden');
    if(parsed.write&&!state.accounting&&!state.packageReconciliation&&!LEGACY_COMPATIBILITY_FAMILIES[state.family].writeTables.includes(parsed.table)&&
      !LEGACY_COMPATIBILITY_FAMILIES[state.family].finalizationTables.includes(parsed.table))fail('legacy_write_table_forbidden');
    const create=params=>{const item={state,parsed,params:Object.freeze([...params])};
      const underlying=()=>state.db.prepare(sql).bind(...params);
      const effect=async mode=>{if(!parsed.write)return underlying()[mode]();
        const results=await executeWrites(state,[item]);return results[0];};
      const statement=Object.freeze({bind(...values){if(values.length!==parsed.parameterCount||values.length>100)fail('legacy_sql_binding_mismatch');return create(values);},
        run:()=>effect('run'),all:()=>effect('all'),async first(column){if(!parsed.write)return underlying().first(column);
          const result=await effect('all'),row=result.results?.[0]??null;return column===undefined?row:row?.[column]??null;},
        async raw(options){if(parsed.write)fail('legacy_sql_unsupported');return underlying().raw(options);}});
      statements.set(statement,item);return statement;};return create([]);},
    async batch(values){if(!Array.isArray(values)||!values.length||values.length>96)fail('legacy_batch_invalid');
      const items=values.map(value=>{const item=statements.get(value);if(!item||item.state!==state||item.params.length!==item.parsed.parameterCount)fail('legacy_batch_invalid');return item;});
      if(items.some(item=>item.parsed.write))return executeWrites(state,items);
      return state.db.batch(items.map(item=>state.db.prepare(item.parsed.sql).bind(...item.params)));},
    withSession(){return facade;}};facades.add(facade);return Object.freeze(facade);
}
export async function prepareLegacyCompatibility(authorization,{family}={}){
  const b=readRuntimeAuthorization(authorization),identity=readTrustedContext(b.context),d=readDecisionFacts(b.decision);
  if(!Object.hasOwn(LEGACY_COMPATIBILITY_FAMILIES,family)||family!==d.capability||identity.operation!==family||
    identity.actorKind!=='customer'||!['telegram_command','telegram_callback'].includes(identity.channel))fail('legacy_family_mismatch');
  requireRuntimeAuthorization(authorization);await assertRuntimeAuthorizationFresh(authorization);
  const state={authorization,context:b.context,identity,actorFacts:readActorFacts(b.actor),resourceFacts:readResourceFacts(b.resource),
    family,resourceRef:resourceRef(readResourceFacts(b.resource),family),db:identity.db,primaryCommitted:false};
  state.facade=facadeFor(state);const permit=Object.freeze({version:1});permits.set(permit,state);return permit;
}
// One fixed Mini App financial adapter. It cannot broaden the existing legacy
// channel gate or select another SQL family: the private resource must already
// prove the canonical owner's exact stored package charge.
export async function prepareOwnPackageRefundCompatibility(authorization) {
  const b = readRuntimeAuthorization(authorization), identity = readTrustedContext(b.context);
  const actor = readActorFacts(b.actor), resource = readResourceFacts(b.resource);
  const decision = readDecisionFacts(b.decision);
  if (identity.actorKind !== 'customer' || identity.channel !== 'mini_app' || identity.operation !== 'admin.stars.refund' ||
      decision.capability !== 'admin.stars.refund' || !actor.canonicalOwner ||
      resource.kind !== 'payment' || resource.ownerTelegramId !== identity.telegramId ||
      resource.domain?.ownPackageChargeRefundVerified !== true) fail('package_refund_family_mismatch');
  requireRuntimeAuthorization(authorization); await assertRuntimeAuthorizationFresh(authorization);
  const family = 'admin.stars.refund';
  const state = { authorization, context: b.context, identity, actorFacts: actor, resourceFacts: resource, ownPackageRefund: true,
    family, resourceRef: resourceRef(resource, family), db: identity.db, primaryCommitted: false };
  state.facade = facadeFor(state); const permit = Object.freeze({ version: 1 }); permits.set(permit, state); return permit;
}
export function hasOwnPackageRefundCompatibilityEnv(env) {
  return Boolean(environments.get(env)?.ownPackageRefund);
}

function verifyPackageReconciliationScope(state, parsed, params) {
  const proof = state.packageReconciliation, transaction = proof.transaction;
  const need = (names, value) => { if (!hasBoundKey(parsed, params, names, value)) fail('package_reconciliation_scope_mismatch'); };
  if (!PACKAGE_RECONCILIATION_TABLES.includes(parsed.table)) fail('legacy_write_table_forbidden');
  if (parsed.table === 'payment_events' && parsed.verb === 'insert' &&
      /^INSERT INTO payment_events\(event_id,event_key,event_type,outcome,occurred_at,received_at\) SELECT lower\(hex\(randomblob\(16\)\)\),NULL,'payment_recorded','error',[1-9][0-9]*,[1-9][0-9]* WHERE NOT \(/u
        .test(parsed.sql.replace(/\s+/gu, ' ').trim())) return;
  need(['order_id'], proof.orderId);
  if (parsed.table === 'subscription_orders') {
    if (parsed.verb !== 'update' || !/SET\s+order_state\s*=\s*'failed'/iu.test(parsed.sql)) fail('package_reconciliation_scope_mismatch');
    return;
  }
  if (parsed.verb !== 'insert') fail('package_reconciliation_scope_mismatch');
  need(['telegram_id'], transaction.source.user.id);
  if (parsed.table === 'payment_ledger') {
    need(['entry_type'], 'payment'); need(['direction'], 'credit'); need(['currency'], 'XTR');
    need(['amount_stars'], transaction.amount); need(['telegram_payment_charge_id'], transaction.id);
    need(['reason_code'], 'package_payment_review_retained');
    if (!hasBoundKey(parsed, params, ['related_ledger_entry_id'], null) &&
        !hasInsertedLiteralNull(parsed, 'related_ledger_entry_id')) fail('package_reconciliation_scope_mismatch');
  } else if (parsed.table === 'payment_events') {
    need(['event_type'], 'payment_recorded'); need(['outcome'], 'accepted');
    need(['reason_code'], 'package_payment_review_retained');
  } else {
    need(['external_invoice_payload'], transaction.source.invoice_payload);
    need(['reconciliation_run_id'], proof.runId); need(['provider_page_sha256'], proof.providerPageSha256);
    need(['provider_transaction_sha256'], proof.transactionSha256);
  }
}
function hasInsertedLiteralNull(parsed, column) {
  const tokens = parsed.tokens, end = tokens.findIndex((t, i) => i > parsed.tableIndex + 1 && t.text === ')');
  const columns = tokens.slice(parsed.tableIndex + 2, end).filter(t => t.text !== ',');
  const target = columns.findIndex(t => t.text === column), values = tokens.findIndex((t, i) => i > end && t.type === 'word' && t.text === 'values');
  if (target < 0 || values < 0 || tokens[values + 1]?.text !== '(') return false;
  let depth = 0, start = values + 2, index = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].text === '(') depth++;
    if (tokens[i].text === ')' && depth > 0) { depth--; continue; }
    if (depth === 0 && [',', ')'].includes(tokens[i].text)) {
      if (index === target) return i === start + 1 && tokens[start].type === 'word' && tokens[start].text === 'null';
      if (tokens[i].text === ')') break;
      index++; start = i + 1;
    }
  }
  return false;
}

// This completion scope is issued only from a fixed genuine reconciliation
// observation. It writes exact retained cash after the provider page arrived;
// it cannot grant access, mutate a charge or make another provider request.
export async function bindPackageReconciliationAccountingEnv(env, observation) {
  const s = envFacts(env); validateEnvironment(s, env);
  const { readPackageReconciliationObservationEvidence } = await import('../v1.4.4/package-payment-runtime.mjs');
  const { parseStarsInvoicePayload } = await import('../v1.3.6/stars-core-foundation.mjs');
  const proof = readPackageReconciliationObservationEvidence(observation);
  if (s.family !== 'admin.stars.reconcile' || !proof || proof.identity.actorKind !== 'service' ||
      proof.identity.purpose !== 'Stars_reconciliation' || proof.identity.db !== env.DB ||
      proof.identity.env.STARS_INVOICE_SECRET !== env.STARS_INVOICE_SECRET || !Array.isArray(proof.assertions))
    fail('untrusted_package_reconciliation_observation');
  let transaction; try { transaction = JSON.parse(proof.encoded); } catch { fail('untrusted_package_reconciliation_observation'); }
  const orderId = parseStarsInvoicePayload(transaction.source?.invoice_payload).orderId;
  if (!Number.isSafeInteger(transaction.amount) || transaction.amount <= 0 || transaction.source?.type !== 'user' ||
      transaction.source.transaction_type !== 'invoice_payment' || !Number.isSafeInteger(transaction.source.user?.id) ||
      transaction.source.user.id <= 0) fail('untrusted_package_reconciliation_observation');
  const scoped = { ...s, packageReconciliation: Object.freeze({ ...proof, transaction, orderId }) };
  scoped.facade = facadeFor(scoped);
  const result = { ...env, DB: scoped.facade }; environments.set(result, scoped); return result;
}
export function readLegacyCompatibility(permit){const s=facts(permit);return Object.freeze({binding:s.facade,context:s.context,family:s.family,capability:s.family,resourceRef:s.resourceRef});}
export function bindLegacyCompatibilityEnv(permit,originalEnv){const s=facts(permit);
  for(const [key,value]of Object.entries(s.identity.env))if(originalEnv[key]!==value)fail('legacy_configuration_changed');
  const env={...originalEnv,DB:s.facade,V141_AUTHORIZATION_ENABLED:'false'};s.originalBinding=originalEnv.DB;
  environments.set(env,s);return env;}
export const isLegacyCompatibilityEnv=env=>Boolean(env&&environments.has(env));
export const hasLegacyCompatibilityEnv=isLegacyCompatibilityEnv;
export const isLegacyCompatibilityBinding=binding=>Boolean(binding&&facades.has(binding));
export function readLegacyCompatibilityEnv(env){const s=envFacts(env);validateEnvironment(s,env);
  return Object.freeze({binding:s.facade,context:s.context,family:s.family,capability:s.family,resourceRef:s.resourceRef,
    originalBinding:s.originalBinding,accountingOnly:Boolean(s.accounting)});}
// One fixed claim executor. The raw binding is used only after fresh genuine
// own capability/resource authorization; its predicates fence the same atomic
// bonus transaction. The general legacy SQL facade gains no additional tables.
export async function executeOwnPackageReferralBonusClaim(env,{telegramId,bonusGrantId}={}) {
  const s=envFacts(env);validateEnvironment(s,env);
  if(s.family!=='referral.bonus.claim_own'||s.accounting||s.packageReconciliation||s.identity.telegramId!==telegramId)
    fail('package_bonus_claim_scope_mismatch');
  const bundle=await currentBundle(s),b=readRuntimeAuthorization(bundle),identity=readTrustedContext(b.context),
    resource=readResourceFacts(b.resource),grant=resource.canonical?.bonusGrant;
  requireRuntimeAuthorization(bundle);await assertRuntimeAuthorizationFresh(bundle);
  if(identity.actorKind!=='customer'||identity.channel!=='telegram_callback'||identity.operation!=='referral.bonus.claim_own'||
      identity.telegramId!==telegramId||identity.db!==s.db||resource.canonical?.packageReferralBonus!==true||
      resource.domain?.referralClaimable!==true||grant?.bonus_grant_id!==bonusGrantId||grant.beneficiary_telegram_id!==telegramId)
    fail('package_bonus_claim_scope_mismatch');
  const {claimPackageReferralBonusGrant}=await import('../v1.4.4/package-referral-bonus-runtime.mjs');
  const result=await claimPackageReferralBonusGrant({...env,DB:s.db,V141_AUTHORIZATION_ENABLED:identity.env.V141_AUTHORIZATION_ENABLED},
    {telegramId,bonusGrantId,claimedAt:identity.nowSeconds},{additionalAssertions:proofPieces(compileDecisionAssertions(b.decision))});
  s.context=b.context;
  if(['applied','duplicate'].includes(result.status))s.primaryCommitted=true;
  return result;
}
export function inheritLegacyCompatibilityEnv(source,target){const s=envFacts(source);validateEnvironment(s,source);
  if(target.DB!==s.facade||target.V141_AUTHORIZATION_ENABLED!=='false')fail('legacy_configuration_changed');
  const actual=restrictTrustedContextForWrapper(s.context,{...target,V141_AUTHORIZATION_ENABLED:s.identity.env.V141_AUTHORIZATION_ENABLED});
  const identity=readTrustedContext(actual),narrow={...s,context:actual,identity,forceRefresh:true};
  // The facade itself closes over the original state. A lowered wrapper gets
  // its own facade so effects cannot accidentally keep the broader context.
  if(actual!==s.context){narrow.facade=facadeFor(narrow);target.DB=narrow.facade;}
  environments.set(target,actual===s.context?s:narrow);return target;}
export function getLegacyCompatibilityBinding(env){const s=envFacts(env);validateEnvironment(s,env);return s.facade;}
export async function assertLegacyCompatibilityFresh(env,scope={}){const s=envFacts(env);validateEnvironment(s,env);
  if(s.accounting||s.packageReconciliation)fail('accounting_scope_cannot_request_provider');
  if(scope.family!==undefined&&(aliases[scope.family]??scope.family)!==s.family||scope.actorId!==undefined&&scope.actorId!==s.identity.telegramId||
    scope.resourceRef!==undefined&&JSON.stringify(scope.resourceRef)!==JSON.stringify(s.resourceRef))fail('legacy_family_mismatch');
  const bundle=s.primaryCommitted||s.forceRefresh?await currentBundle(s):s.authorization;
  requireRuntimeAuthorization(bundle);await assertRuntimeAuthorizationFresh(bundle);s.context=readRuntimeAuthorization(bundle).context;return env;}

export async function assertLegacyBroadcastDeliveryFresh(env,{actorId,broadcastId,recipientId,claimToken}={}){
  const s=envFacts(env);validateEnvironment(s,env);
  if(s.accounting||s.family!=='admin.broadcast.send'||actorId!==s.identity.telegramId||
    s.identity.requestPayload?.broadcastId!==broadcastId||!Number.isSafeInteger(recipientId)||recipientId<1||
    typeof claimToken!=='string'||!claimToken||claimToken.length>128)fail('legacy_family_mismatch');
  const bundle=await currentBundle(s),b=readRuntimeAuthorization(bundle);requireRuntimeAuthorization(bundle);
  const pieces=[...proofPieces(compileDecisionAssertions(b.decision))];
  pieces.push({sql:"EXISTS(SELECT 1 FROM admin_broadcast_delivery_claims c JOIN admin_broadcast_deliveries d ON d.broadcast_id=c.broadcast_id AND d.telegram_id=c.telegram_id JOIN admin_broadcasts b ON b.id=c.broadcast_id WHERE c.broadcast_id=? AND c.telegram_id=? AND c.claim_token=? AND c.status='processing' AND c.lease_expires_at>unixepoch() AND d.status='pending' AND b.status='sending' AND b.actor_id=?)",
    params:[broadcastId,recipientId,claimToken,actorId]});
  // D1 batch is one transaction, so authority and the exact delivery claim
  // are checked against the same snapshot even when parameters exceed 100.
  const queries=compileProofReadQueries(pieces);
  const results=await s.db.batch(queries.map(query=>s.db.prepare(query.sql).bind(...query.params)));
  if(!proofReadResultsValid(results,queries.length))fail('broadcast_delivery_authority_stale');
  s.context=b.context;return env;
}

export async function assertLegacyPreviewWorkflowFresh(env,{grantId,warningAt,endsAt}={}){
  const s=envFacts(env);validateEnvironment(s,env);const g=s.createdPreviewGrant;
  if(!g||s.family!=='preview.activate_own'||grantId!==g.id||endsAt!==g.endsAt||warningAt!==g.endsAt-86400)fail('preview_workflow_scope_mismatch');
  const bundle=await currentBundle(s),pieces=completionProofs(s,bundle);
  pieces.push({sql:"EXISTS(SELECT 1 FROM notification_jobs WHERE job_key=? AND telegram_id=? AND related_grant_id=? AND job_type='preview_warning' AND status='pending' AND scheduled_for=?) AND EXISTS(SELECT 1 FROM notification_jobs WHERE job_key=? AND telegram_id=? AND related_grant_id=? AND job_type='preview_ended' AND status='pending' AND scheduled_for=?)",
    params:['preview-warning:'+g.id,s.identity.telegramId,g.id,warningAt,'preview-ended:'+g.id,s.identity.telegramId,g.id,endsAt]});
  const result=await s.db.batch(pieces.map(piece=>s.db.prepare(`SELECT CASE WHEN (${piece.sql}) THEN 1 ELSE 0 END AS valid`).bind(...piece.params)));
  if(result.length!==pieces.length||result.some(row=>row?.success!==true||row.results?.[0]?.valid!==1))fail('preview_workflow_authority_stale');
  s.context=readRuntimeAuthorization(bundle).context;return env;
}

const ACCOUNTING_TABLES=Object.freeze(['payment_refunds','payment_events','payment_ledger','subscription_orders',
  'subscription_access_grants','subscriptions','subscription_status_history','user_plans','user_access_states','access_status_history']);
function verifyAccountingScope(state,parsed,params){
  const e=state.accounting,table=parsed.table;
  if(!ACCOUNTING_TABLES.includes(table))fail('legacy_write_table_forbidden');
  const need=(names,value)=>{if(value===null||value===undefined||!hasBoundKey(parsed,params,names,value))fail('refund_accounting_scope_mismatch');};
  if(table==='payment_refunds')need(['refund_id'],e.refundId);
  else if(table==='payment_ledger'){if(parsed.verb!=='insert')fail('refund_accounting_scope_mismatch');
    need(['order_id'],e.orderId);need(['telegram_id'],e.telegramId);need(['telegram_payment_charge_id'],e.chargeId);
    need(['related_ledger_entry_id'],e.originalLedgerEntryId);need(['entry_type'],'refund');need(['direction'],'debit');need(['amount_stars'],e.amountStars);}
  else if(table==='subscription_orders')need(['order_id'],e.orderId);
  else if(table==='subscription_access_grants')need(['grant_id'],e.grantId);
  else if(table==='subscriptions')need(['subscription_id'],e.subscriptionId);
  else if(table==='subscription_status_history'){need(['subscription_id'],e.subscriptionId);need(['order_id'],e.orderId);need(['telegram_id'],e.telegramId);}
  else if(table==='payment_events'){need(['order_id'],e.orderId);need(['telegram_id'],e.telegramId);need(['event_type'],'refund_confirmed');}
  else need(['telegram_id'],e.telegramId);
}

// Actual Stars runtime creates this evidence only after refundStarPayment=true.
// Accounting is a separate scope; it cannot issue another provider request.
export function bindConfirmedStarsRefundAccountingEnv(env,evidence){
  const s=envFacts(env);validateEnvironment(s,env);const e=readConfirmedStarsRefundEvidence(evidence);
  if(s.family!=='admin.stars.refund'||!e||e.originalBinding!==s.originalBinding||e.context!==s.context||
    e.orderId!==s.resourceFacts.ref||!Array.isArray(e.assertions)||!e.assertions.length)fail('untrusted_refund_accounting');
  if(e.assertions.some(piece=>typeof piece.sql!=='string'||!Array.isArray(piece.params)||piece.params.length>99))fail('untrusted_refund_accounting');
  const accounting={...s,accounting:e};accounting.facade=facadeFor(accounting);
  const scoped={...env,DB:accounting.facade};environments.set(scoped,accounting);return scoped;
}
