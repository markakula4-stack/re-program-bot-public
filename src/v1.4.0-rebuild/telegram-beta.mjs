import {authorityError} from './cabinet-authority.mjs';
import {databaseSeconds} from './d1-cabinet-repository.mjs';
import {canonicalCabinetOwnerId,loadCabinetWindowActor} from './cabinet-participants.mjs';
import {isVerifiedTelegramCommandContext} from './telegram-command-authority.mjs';
import {readRuntimeAuthorization,requireRuntimeAuthorization,assertRuntimeAuthorizationFresh} from '../v1.4.1/runtime-authorizer.mjs';
import {readTrustedContext} from '../v1.4.1/trusted-context.mjs';
import {createTelegramMutationFence} from '../v1.4.1/telegram-runtime.mjs';
import {readActorFacts} from '../v1.4.1/authority-resolver.mjs';
import {readDecisionFacts} from '../v1.4.1/entitlement-engine.mjs';
import {FOUNDATION_POLICY_VERSION} from '../v1.4.1/capability-policy.mjs';
// Explicit admin button only. This finite grant uses the accepted canonical
// Beta tables. It cannot enable global Beta, repair roles, resume a paused
// grant, declare age/legal status or edit the partner's offer.
export async function grantTelegramPartnerBeta({repo,env,context,gate,profileId,updateId,nowSeconds,authorization}){
  let runtimeIdentity=null;
  if(env.V141_AUTHORIZATION_ENABLED==='true') {
    requireRuntimeAuthorization(authorization);
    const runtime=readRuntimeAuthorization(authorization);runtimeIdentity=readTrustedContext(runtime.context);
    if(runtimeIdentity.operation!=='admin.partner.beta.manage'||runtimeIdentity.telegramId!==context?.telegramId||
        runtimeIdentity.requestPayload?.action!=='grant'||runtimeIdentity.requestPayload.durationSeconds!==3600||
        runtimeIdentity.transportBinding?.updateId!==updateId)authorityError('admin_required');
  }
  const platform=isVerifiedTelegramCommandContext(context);
  const permanentGrant=gate?.accessScope==='admin'&&env.REBUILD_V140_ADMIN_BETA_GRANTS_ENABLED==='true';
  if((env.REBUILD_V140_BETA_ENABLED!=='true'&&!permanentGrant)||!Number.isSafeInteger(profileId)||profileId<1||
    context?.telegramId!==canonicalCabinetOwnerId(env)||(!platform&&context.authoritySource!=='database_session'))authorityError('admin_required');
  if(platform){
    if(context.candidateSha!==env.REBUILD_V140_RC_SHA||context.revision!==Number(env.REBUILD_V140_RELEASE_REVISION))authorityError('admin_required');
    const receipt=await repo.one('telegram_update_receipts','update_id=?',[context.updateId]);
    if(receipt?.actorId!==context.telegramId||receipt.status!=='processing'||receipt.claimToken!==context.claimToken||
      receipt.leaseExpiresAt<=nowSeconds||context.expiresAt>receipt.leaseExpiresAt)authorityError('admin_required');
  }
  await repo.assertCandidateSchema();
  await loadCabinetWindowActor({repo,env,gate,telegramId:context.telegramId,nowSeconds});
  const profile=await repo.one('partner_profiles','id=?',[profileId]);if(!profile)authorityError('not_found',404);
  const targetSql=`EXISTS(SELECT 1 FROM partner_profiles p JOIN partner_applications a ON a.id=p.application_id
    JOIN users u ON u.telegram_id=p.telegram_id JOIN user_roles r ON r.telegram_id=p.telegram_id
    WHERE p.id=? AND p.status='active' AND a.telegram_id=p.telegram_id AND a.status='approved' AND a.age_confirmed=1
    AND u.is_blocked=0 AND r.role='partner' AND r.status='active'
    AND NOT EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=p.telegram_id AND role='admin' AND status='active')
    AND NOT EXISTS(SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=p.telegram_id AND status='pending' AND unixepoch(expires_at)>unixepoch()))`;
  if((await repo.readQuery('SELECT '+targetSql+' AS eligible',[profileId],['eligible']))[0]?.eligible!==1)authorityError('partner_beta_required');
  const existing=await repo.one('partner_beta_access','partner_profile_id=?',[profileId]);
  const expiry=databaseSeconds(existing?.expiresAt);
  if(existing&&existing.accessStatus!=='active')authorityError('partner_beta_required');
  if(existing&&(existing.expiresAt==null||(expiry!==null&&expiry>nowSeconds))){
    await repo.assertReadFence({context,gate});if(authorization)await assertRuntimeAuthorizationFresh(authorization);return {alreadyGranted:true,expiresAt:expiry};
  }
  if(existing&&expiry===null)authorityError('authority_inconsistent',503);
  const key='p12_beta_'+env.REBUILD_V140_RC_SHA.slice(0,12)+'_'+updateId,guard='beta_'+crypto.randomUUID();
  const until=nowSeconds+3600,reason='P12: explicit owner grant, expires in 60 minutes';
  const sessionSql=platform
    ? "EXISTS(SELECT 1 FROM telegram_update_receipts WHERE update_id=? AND actor_id=? AND status='processing' AND claim_token=? AND lease_expires_at>unixepoch())"
    : "EXISTS(SELECT 1 FROM mini_app_sessions WHERE session_id=? AND telegram_id=? AND bot_id=? AND token_version=1 AND status='active' AND revoked_at IS NULL AND issued_at<=unixepoch() AND expires_at>unixepoch())";
  const sessionParams=platform?[context.updateId,context.telegramId,context.claimToken]:[context.sessionId,context.telegramId,gate.botId];
  const statements=[
    repo.db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN
      EXISTS(SELECT 1 FROM users u JOIN user_roles r ON r.telegram_id=u.telegram_id WHERE u.telegram_id=? AND u.is_blocked=0 AND u.accepted_terms=1 AND r.role='admin' AND r.status='active')
      AND NOT EXISTS(SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending' AND unixepoch(expires_at)>unixepoch())
      AND ${sessionSql}
      AND ${targetSql}
      AND (NOT EXISTS(SELECT 1 FROM partner_beta_access WHERE partner_profile_id=?) OR EXISTS
        (SELECT 1 FROM partner_beta_access WHERE partner_profile_id=? AND access_status='active' AND expires_at IS NOT NULL AND unixepoch(expires_at)<=unixepoch()))
      THEN 1 ELSE 0 END)`).bind(guard,context.telegramId,context.telegramId,...sessionParams,profileId,profileId,profileId),
    repo.db.prepare(`INSERT INTO partner_beta_access_events(partner_profile_id,action,from_status,to_status,actor_id,actor_role,reason,expires_at,event_key)
      VALUES(?,'granted',?,'active',?,'admin',?,datetime(?,'unixepoch'),?)`).bind(profileId,existing?.accessStatus??'',context.telegramId,reason,until,key),
    repo.db.prepare(`INSERT INTO partner_beta_access(partner_profile_id,access_status,can_create_private_offers,can_submit_offers,granted_by,expires_at,reason)
      VALUES(?,'active',1,1,?,datetime(?,'unixepoch'),?) ON CONFLICT(partner_profile_id) DO UPDATE SET
      can_create_private_offers=1,can_submit_offers=1,expires_at=excluded.expires_at,reason=excluded.reason,
      status_changed_by=excluded.granted_by,status_changed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`).bind(profileId,context.telegramId,until,reason),
    repo.db.prepare("INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,details) VALUES(?,'partner_beta_granted','partner_beta_access',?,?)").bind(context.telegramId,String(profileId),reason),
    repo.db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key=?').bind(guard),
  ];
  if(runtimeIdentity) {
    // The reviewed legacy target/session checks and central policy predicates
    // share the same effect transaction and primary request session.
    const fence=createTelegramMutationFence(authorization);
    const runtime=readRuntimeAuthorization(authorization),decision=readDecisionFacts(runtime.decision),actor=readActorFacts(runtime.actor);
    const eventKey=runtimeIdentity.operationId;
    if(!/^[0-9a-f]{64}$/u.test(eventKey??''))authorityError('invalid_request',400);
    const audit=runtimeIdentity.db.prepare(`INSERT INTO entitlement_decision_audit(audit_id,event_key,policy_version,capability,actor_kind,
      subject_telegram_id,actor_telegram_id,resource_ref,decision,reason_code,source_fingerprint,operation_ref,evaluated_at,valid_until)
      VALUES(?,?,?,'admin.partner.beta.manage','customer',?,?,?,'allow','telegram_beta_granted',?,?,?,?)`)
      .bind('v141beta_'+eventKey,eventKey,FOUNDATION_POLICY_VERSION,profile.telegramId,context.telegramId,'partner_profile:'+profileId,
        actor.sourceFingerprint,eventKey,decision.evaluatedAt,decision.validUntil);
    const batch=[...fence.before,...statements.map(statement=>statement.native??statement),audit,...fence.after];
    const result=await runtimeIdentity.db.batch(batch);
    if(!Array.isArray(result)||result.length!==batch.length||result.some(row=>row?.success!==true)||
        result[fence.before.length+statements.length]?.meta?.changes!==1)authorityError('authority_outcome_unverified',503);
  } else await repo.commitTrustedBatch({context,gate,statements});
  return {granted:true,expiresAt:until};
}
