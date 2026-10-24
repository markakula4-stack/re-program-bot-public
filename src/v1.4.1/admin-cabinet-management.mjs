import {readRuntimeAuthorization,requireRuntimeAuthorization} from './runtime-authorizer.mjs';
import {readTrustedContext,compileContextAssertions} from './trusted-context.mjs';
import {readActorFacts,compileAuthorityReplayAssertions} from './authority-resolver.mjs';
import {readResourceFacts} from './resource-resolver.mjs';
import {compileDecisionAssertions} from './entitlement-engine.mjs';
import {FOUNDATION_POLICY_VERSION} from './capability-policy.mjs';
import {canonicalCabinetOwnerId} from '../v1.4.0-rebuild/cabinet-participants.mjs';
import {AI_PUBLIC_SOURCE_READINESS_SQL,projectPublicAiEnablement} from './ai-rollout-readiness.mjs';

// Fixed management domains only. No caller supplies SQL, actor, capability,
// table, provider executor or a policy proof.
export const ADMIN_MANAGEMENT_ACTIONS=Object.freeze({
  'admin.user.moderation':'admin.user.moderation',
  'admin.settings.update':'admin.settings.manage',
});
export const ADMIN_SETTING_KEYS=Object.freeze(['ai_rollout_mode','official_web_enabled','official_web_stale_enabled']);
const settingKeys=new Set(ADMIN_SETTING_KEYS),HASH=/^[0-9a-f]{64}$/u;
const positive=value=>Number.isSafeInteger(value)&&value>0;
const nonnegative=value=>Number.isSafeInteger(value)&&value>=0;
const fail=(code,status=403)=>{throw Object.assign(new Error(code),{code,status});};
const exact=(value,fields)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||
      fields.some(field=>!Object.hasOwn(value,field)))fail('invalid_request',400);
};
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
const statement=(db,sql,params=[])=>{
  if(params.length>100||new TextEncoder().encode(sql).length>100000)fail('management_unavailable',503);
  return db.prepare(sql).bind(...params);
};
async function fixedRead(db,sql,params=[],maximum=50) {
  const result=await statement(db,sql,params).all();
  if(result?.success!==true||!Array.isArray(result.results)||result.results.length>maximum)fail('management_unavailable',503);
  return result.results;
}
export function normalizeAdminManagementIntent(capability,payload) {
  if(capability==='admin.user.moderation') {
    exact(payload,['action','targetTelegramId','expectedRevision','reason','confirmed']);
    if(!['block','unblock'].includes(payload.action)||!positive(payload.targetTelegramId)||
        !nonnegative(payload.expectedRevision)||payload.confirmed!==true||typeof payload.reason!=='string'||
        payload.reason.trim()!==payload.reason||Array.from(payload.reason).length<3||Array.from(payload.reason).length>300||
        payload.action==='unblock'&&!positive(payload.expectedRevision))fail('invalid_request',400);
  } else if(capability==='admin.settings.manage') {
    exact(payload,['action','key','value','expectedValue','confirmed']);
    if(payload.action!=='update_setting'||!settingKeys.has(payload.key)||payload.confirmed!==true||
        (payload.key==='ai_rollout_mode'?!['off','admin','all'].includes(payload.value)||!['off','admin','all'].includes(payload.expectedValue):
          typeof payload.value!=='boolean'||typeof payload.expectedValue!=='boolean'))fail('invalid_request',400);
  } else fail('not_found',404);
  return Object.freeze({...payload});
}

const paging=params=>{
  const limit=Number(params.limit??20),offset=Number(params.offset??0);
  if(!Number.isSafeInteger(limit)||limit<1||limit>50||!nonnegative(offset)||offset>100000)fail('invalid_request',400);
  return {limit,offset};
};
export async function readAdminAuxiliarySection({repo,env,section,params={}}) {
  if(section==='users') {
    const {limit,offset}=paging(params),status=params.status??'all',q=params.query??'';
    if(Object.keys(params).some(key=>!['limit','offset','status','query'].includes(key))||
        !['all','blocked'].includes(status)||typeof q!=='string'||q.length>80)fail('invalid_request',400);
    const fields=['telegram_id','joined_at','accepted_terms','delivery_unavailable','username','partner_status','plan_code','roles',
      'moderation_status','moderation_revision','moderation_reason'];
    const where=["(?='all' OR m.status='active')","(?='' OR CAST(u.telegram_id AS TEXT)=? OR lower(COALESCE(p.telegram_username,''))=lower(?))"];
    const search=q.trim().replace(/^@/u,''),bound=[status,search,search,search];
    const from=`FROM users u LEFT JOIN partner_profiles p ON p.telegram_id=u.telegram_id
      LEFT JOIN user_plans plan ON plan.telegram_id=u.telegram_id
      LEFT JOIN user_moderation_blocks m ON m.target_telegram_id=u.telegram_id WHERE ${where.join(' AND ')}`;
    const total=(await repo.readQuery(`SELECT COUNT(*) AS n ${from}`,bound,['n']))[0]?.n;
    if(!nonnegative(total))fail('management_unavailable',503);
    const rows=await repo.readQuery(`SELECT u.telegram_id,u.joined_at,u.accepted_terms,u.is_blocked AS delivery_unavailable,
      p.telegram_username AS username,p.status AS partner_status,COALESCE(plan.plan_code,'free') AS plan_code,
      (SELECT COALESCE(json_group_array(role),'[]') FROM user_roles WHERE telegram_id=u.telegram_id AND status='active') AS roles,
      m.status AS moderation_status,COALESCE(m.revision,0) AS moderation_revision,m.reason AS moderation_reason
      ${from} ORDER BY u.telegram_id DESC LIMIT ? OFFSET ?`,[...bound,limit,offset],fields);
    const settings=(await repo.readQuery('SELECT moderation_enabled FROM admin_safety_runtime_settings WHERE id=1',[],['moderation_enabled']))[0];
    const canModerate=env.ADMIN_MODERATION_ENABLED==='true'&&settings?.moderationEnabled===1;
    const items=rows.map(row=>({telegramId:row.telegramId,username:row.username,joinedAt:row.joinedAt,
      acceptedTerms:row.acceptedTerms===1,isBlocked:row.moderationStatus==='active',deliveryUnavailable:row.deliveryUnavailable===1,
      roles:JSON.parse(row.roles),partnerStatus:row.partnerStatus,planCode:row.planCode,
      moderation:row.moderationStatus?{status:row.moderationStatus,revision:row.moderationRevision,reason:row.moderationReason}:null,
      canModerate:canModerate&&row.telegramId!==canonicalCabinetOwnerId(env)}));
    return {readModelVersion:1,section,items,total,limit,offset,hasMore:offset+items.length<total};
  }
  if(section==='settings') {
    if(Object.keys(params).some(key=>!['limit','offset'].includes(key)))fail('invalid_request',400);
    const ai=(await repo.readQuery('SELECT rollout_mode,updated_at FROM ai_runtime_settings WHERE id=1',[],['rollout_mode','updated_at']))[0]??null;
    const official=(await repo.readQuery('SELECT enabled,admin_only,stale_enabled,updated_at FROM official_web_settings WHERE id=1',[],['enabled','admin_only','stale_enabled','updated_at']))[0]??null;
    const publicEnablement=projectPublicAiEnablement(typeof env.AI?.run==='function',(await repo.readQuery(AI_PUBLIC_SOURCE_READINESS_SQL,[],['active','approved']))[0]);
    const items=[
      {key:'ai_rollout_mode',label:'Доступ к RE AI',value:ai?.rolloutMode??null,allowedValues:['off','admin','all'],editable:Boolean(ai)},
      {key:'official_web_enabled',label:'Официальные источники',value:official?official.enabled===1:null,allowedValues:[false,true],editable:Boolean(official)},
      {key:'official_web_stale_enabled',label:'Устаревший кеш источников',value:official?official.staleEnabled===1:null,allowedValues:[false,true],editable:Boolean(official)},
    ];
    return {readModelVersion:1,section,items,total:items.length,limit:items.length,offset:0,hasMore:false,publicEnablement,
      effective:{releaseMode:env.V141_RELEASE_MODE,partnerBetaEnabled:env.PARTNER_BETA_ENABLED==='true',
        officialWebAdminOnly:official?official.adminOnly===1:null,authorizationEnabled:env.V141_AUTHORIZATION_ENABLED==='true'}};
  }
  fail('not_found',404);
}

function epochProof(identity) {
  const source=identity.env.REBUILD_V140_RC_SHA,revision=Number(identity.env.REBUILD_V140_RELEASE_REVISION);
  if(!/^[0-9a-f]{40}$/u.test(source??'')||!positive(revision))fail('management_unavailable',503);
  return {sql:"EXISTS(SELECT 1 FROM mini_app_release_control WHERE id=1 AND candidate_sha=? AND revision=? AND state='closed' AND beta_enabled=0)",params:[source,revision]};
}
function replayProofs(context,actor,identity) {
  const proof=compileAuthorityReplayAssertions(actor);
  return [compileContextAssertions(context),...(proof.assertions??[proof]),epochProof(identity),
    {sql:"EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=? AND role='admin' AND status='active')",params:[identity.telegramId]}];
}
async function checkProofs(db,proofs) {
  const result=await db.batch(proofs.map(p=>statement(db,`SELECT CASE WHEN (${p.sql}) THEN 1 ELSE 0 END AS valid`,p.params)));
  if(!Array.isArray(result)||result.length!==proofs.length||result.some(r=>r?.success!==true||r.results?.[0]?.valid!==1))fail('authority_stale',409);
}

// This exact executor consumes a branded canonical decision. It stores its
// receipt, domain change and audit with the decision's captured guards in one
// transaction. Replays acknowledge a previous commit without toggling twice.
export async function executeAdminManagementMutation(authorization) {
  const {context,actor,resource,decision}=readRuntimeAuthorization(authorization);
  const identity=readTrustedContext(context),facts=readActorFacts(actor),canonical=readResourceFacts(resource),payload=normalizeAdminManagementIntent(identity.operation,identity.requestPayload);
  if(identity.actorKind!=='customer'||identity.channel!=='mini_app'||typeof identity.verifiedSessionId!=='string'||
      identity.env.V141_ADMIN_MINI_APP_ENABLED!=='true'||identity.env.V141_RELEASE_MODE!=='owner_only'||
      facts.canonicalOwner!==true||!facts.roles.includes('admin')||identity.telegramId!==canonicalCabinetOwnerId(identity.env)||
      !HASH.test(identity.operationId??'')||!HASH.test(identity.payloadHash??'')||!HASH.test(facts.accountFingerprint??''))fail('admin_required');
  const secret=identity.env.MINI_APP_IDEMPOTENCY_SECRET;
  if(typeof secret!=='string'||secret.length<32)fail('management_unavailable',503);
  const hmac=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const key='mikey_'+Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',hmac,new TextEncoder().encode(JSON.stringify([
    'v1.4.1.1.admin-management',identity.botId,identity.telegramId,facts.accountFingerprint,identity.operation,identity.operationId])))),x=>x.toString(16).padStart(2,'0')).join('');
  const requestHash=await digest(JSON.stringify([identity.operation,identity.payloadHash]));
  const db=identity.db;
  const prior=(await fixedRead(db,'SELECT request_hash,actor_telegram_id,bot_id,operation,commit_status,response_json,precondition_ok FROM mini_app_command_receipts WHERE idempotency_key=?',[key],1))[0];
  if(prior) {
    if(prior.request_hash!==requestHash||prior.actor_telegram_id!==identity.telegramId||prior.bot_id!==identity.botId||
        prior.operation!==identity.operation||prior.commit_status!=='committed'||prior.precondition_ok!==1)fail('idempotency_conflict',409);
    let ack;try{ack=JSON.parse(prior.response_json);}catch{fail('management_unavailable',503);}
    if(ack?.capability!==identity.operation||!['committed','unchanged'].includes(ack.commitStatus))fail('management_unavailable',503);
    await checkProofs(db,replayProofs(context,actor,identity));
    return {...ack,commitStatus:'unchanged'};
  }
  requireRuntimeAuthorization(authorization);
  if(!canonical.exists||canonical.capability!==identity.operation||canonical.subjectTelegramId!==identity.telegramId)fail('admin_required');
  const writes=[],guards=[],before=[...compileDecisionAssertions(decision).assertions,epochProof(identity)];
  const write=(sql,params)=>writes.push({sql,params});
  let ack,entityType,entityId,domainAction;
  if(identity.operation==='admin.user.moderation') {
    const target=canonical.canonical?.target,previous=canonical.canonical?.previousBlock;
    if(canonical.kind!=='user'||canonical.ref!==payload.targetTelegramId||target?.telegramId!==payload.targetTelegramId||
        payload.targetTelegramId===identity.telegramId||(previous?.revision??0)!==payload.expectedRevision)fail('state_conflict',409);
    const revision=payload.expectedRevision+1,eventKey=`moderation:${payload.action}:${payload.targetTelegramId}:r${revision}`;
    if(payload.action==='block') {
      if(previous&&previous.status!=='revoked')fail('state_conflict',409);
      write(`INSERT INTO user_moderation_blocks(target_telegram_id,status,reason,blocked_by,blocked_at,unblocked_by,unblocked_at,last_notice_at,revision)
        VALUES(?,'active',?,?,?,NULL,NULL,NULL,?) ON CONFLICT(target_telegram_id) DO UPDATE SET
        status='active',reason=excluded.reason,blocked_by=excluded.blocked_by,blocked_at=excluded.blocked_at,
        unblocked_by=NULL,unblocked_at=NULL,last_notice_at=NULL,revision=excluded.revision
        WHERE user_moderation_blocks.status='revoked' AND user_moderation_blocks.revision=?`,
        [payload.targetTelegramId,payload.reason,identity.telegramId,identity.nowSeconds,revision,payload.expectedRevision]);
    } else {
      if(previous?.status!=='active')fail('state_conflict',409);
      write("UPDATE user_moderation_blocks SET status='revoked',unblocked_by=?,unblocked_at=?,revision=? WHERE target_telegram_id=? AND status='active' AND revision=?",
        [identity.telegramId,identity.nowSeconds,revision,payload.targetTelegramId,payload.expectedRevision]);
    }
    write(`INSERT INTO user_moderation_events(event_key,target_telegram_id,actor_telegram_id,action,reason,resulting_revision,created_at)
      VALUES(?,?,?,?,?,?,?)`,[eventKey,payload.targetTelegramId,identity.telegramId,payload.action,payload.reason,revision,identity.nowSeconds]);
    ack={commitStatus:'committed',capability:identity.operation,targetTelegramId:payload.targetTelegramId,revision,
      status:payload.action==='block'?'active':'revoked'};
    entityType='telegram_user';entityId=String(payload.targetTelegramId);domainAction=payload.action==='block'?'user_moderation_blocked':'user_moderation_unblocked';
    guards.push({sql:'EXISTS(SELECT 1 FROM user_moderation_blocks WHERE target_telegram_id=? AND status=? AND revision=?)',
      params:[payload.targetTelegramId,ack.status,revision]});
  } else {
    const row=canonical.canonical?.settingsTarget;
    if(!row)fail('state_conflict',409);
    const current=payload.key==='ai_rollout_mode'?row.rolloutMode:payload.key==='official_web_enabled'?row.enabled===1:row.staleEnabled===1;
    if(current!==payload.expectedValue)fail('state_conflict',409);
    if(current!==payload.value) {
      if(payload.key==='ai_rollout_mode')write('UPDATE ai_runtime_settings SET rollout_mode=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=1 AND rollout_mode=?',
        [payload.value,identity.telegramId,payload.expectedValue]);
      else {
        const field=payload.key==='official_web_enabled'?'enabled':'stale_enabled';
        write(`UPDATE official_web_settings SET ${field}=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=1 AND ${field}=?`,
          [Number(payload.value),identity.telegramId,Number(payload.expectedValue)]);
      }
    }
    ack={commitStatus:writes.length?'committed':'unchanged',capability:identity.operation,key:payload.key,value:payload.value};
    entityType='runtime_setting';entityId=payload.key;domainAction='admin_runtime_setting_updated';
  }
  const keys=[],batch=[];
  const guard=p=>{
    const k=key+':management:'+keys.length;keys.push(k);
    batch.push(statement(db,`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN (${p.sql}) THEN 1 ELSE 0 END)`,[k,...p.params]));
  };
  const changed=(sql,params)=>{batch.push(statement(db,sql,params));guard({sql:'changes()=1',params:[]});};
  for(const p of before)guard(p);
  changed(`INSERT INTO mini_app_command_receipts(idempotency_key,request_hash,actor_telegram_id,bot_id,operation,commit_status,response_json,committed_at,precondition_ok)
    VALUES(?,?,?,?,?,'committed',?,unixepoch(),1)`,[key,requestHash,identity.telegramId,identity.botId,identity.operation,JSON.stringify(ack)]);
  for(const w of writes)changed(w.sql,w.params);
  if(writes.length)changed('INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',
    [identity.telegramId,domainAction,entityType,entityId,JSON.stringify(identity.operation==='admin.user.moderation'?{revision:ack.revision,reason:payload.reason}:{value:payload.value}).slice(0,1000)]);
  const auditKey=await digest('v1.4.1.1.management.audit\n'+key);
  changed(`INSERT INTO entitlement_decision_audit(audit_id,event_key,policy_version,capability,actor_kind,subject_telegram_id,
    actor_telegram_id,resource_ref,decision,reason_code,source_fingerprint,operation_ref,evaluated_at,valid_until,retention_until)
    VALUES(?,?,?,?,'customer',?,?,?,'allow',?,?,?,?,?,NULL)`,
    ['v141_'+auditKey,auditKey,FOUNDATION_POLICY_VERSION,identity.operation,payload.targetTelegramId??identity.telegramId,
      identity.telegramId,entityType+':'+entityId,writes.length?'admin_management_committed':'admin_management_unchanged',facts.sourceFingerprint,key,identity.nowSeconds,identity.expiresAt]);
  for(const p of guards)guard(p);
  batch.push(statement(db,`DELETE FROM mini_app_atomic_guards WHERE guard_key IN (${keys.map(()=>'?').join(',')})`,keys));
  if(batch.length>96)fail('management_unavailable',503);
  try {
    const results=await db.batch(batch);
    if(!Array.isArray(results)||results.length!==batch.length||results.some(r=>r?.success!==true))fail('management_outcome_unknown',503);
  } catch(error) {
    if(error?.code==='management_outcome_unknown')throw error;
    if(/CHECK constraint failed|UNIQUE constraint failed|requires|immutable/iu.test(String(error?.message)))fail('state_conflict',409);
    fail('management_outcome_unknown',503);
  }
  return ack;
}
