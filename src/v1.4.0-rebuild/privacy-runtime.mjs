import { analyticsPrivacyRuntime, ANALYTICS_PRIVACY_RUNTIME_KEY } from '../v1.3.9/privacy-deletion-runtime.mjs';

export async function prepareRebuildSubjectDeletion(env,subjectId,requestId) {
  if (!Number.isSafeInteger(subjectId)||subjectId<1||typeof requestId!=='string'||requestId.length<16||requestId.length>128) throw new Error('privacy_authority_invalid');
  const schema=await env.DB.prepare(`SELECT COUNT(*) AS n,
    EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mini_app_release_control') AS has_lease
    FROM sqlite_schema WHERE type='table' AND name IN ('mini_app_sessions','mini_app_effect_outbox','mini_app_privacy_guard')`).first();
  if (schema?.n===0) return [];
  if (schema?.n!==3) throw new Error('rebuild_privacy_schema_incomplete');
  const key=crypto.randomUUID(),db=env.DB;
  const originalLeads=await db.prepare(`SELECT json_group_array(id) AS ids FROM lead_requests
    WHERE telegram_id=? OR inviter_id=?`).bind(subjectId,subjectId).first();
  if(typeof originalLeads?.ids!=='string')throw new Error('rebuild_privacy_leads_unavailable');
  // The accepted deletion anonymizes canonical leads before the analytics
  // extension slot runs. Submission history still identifies all affected
  // leads inside that same batch, including result effects written by admins.
  const subjectLeads=`SELECT CAST(value AS INTEGER) FROM json_each
    ((SELECT subject_lead_ids_json FROM mini_app_privacy_guard WHERE guard_key=?))`;
  const related=`command_key IN (SELECT idempotency_key FROM mini_app_command_receipts WHERE actor_telegram_id=?)
    OR json_extract(payload_json,'$.recipientTelegramId')=?
    OR json_extract(payload_json,'$.leadId') IN (${subjectLeads})`;
  const args=[subjectId,subjectId,key];
  return [
    db.prepare(`INSERT INTO mini_app_privacy_guard(guard_key,subject_id,reason,request_id,subject_lead_ids_json,expires_at,precondition_ok)
      SELECT ?,?,'subject_deletion',?,(SELECT json_group_array(id) FROM
        (SELECT CAST(value AS INTEGER) AS id FROM json_each(?)
         UNION SELECT id FROM lead_requests WHERE telegram_id=? OR inviter_id=?
         UNION SELECT lead_id AS id FROM lead_request_events WHERE actor_telegram_id=? AND operation='lead.submit')),
        unixepoch()+60,CASE WHEN EXISTS
        (SELECT 1 FROM privacy_deletion_requests WHERE request_id=? AND telegram_id=? AND status='pending'
          AND unixepoch(expires_at)>unixepoch()) AND NOT EXISTS
        (SELECT 1 FROM partner_profiles WHERE telegram_id=?) THEN 1 ELSE 0 END`)
      .bind(key,subjectId,requestId,originalLeads.ids,subjectId,subjectId,subjectId,requestId,subjectId,subjectId),
    db.prepare(`INSERT INTO mini_app_privacy_denials(init_data_fingerprint,expires_at)
      SELECT init_data_fingerprint,expires_at FROM mini_app_init_data_receipts WHERE telegram_id=?
      ON CONFLICT(init_data_fingerprint) DO UPDATE SET expires_at=MAX(expires_at,excluded.expires_at)`).bind(subjectId),
    db.prepare('DELETE FROM mini_app_sessions WHERE telegram_id=?').bind(subjectId),
    db.prepare('DELETE FROM mini_app_init_data_receipts WHERE telegram_id=?').bind(subjectId),
    db.prepare(`DELETE FROM mini_app_effect_claims WHERE recipient_telegram_id=? OR dedupe_key IN
      (SELECT dedupe_key FROM mini_app_effect_outbox WHERE ${related})`).bind(subjectId,...args),
    db.prepare(`DELETE FROM mini_app_effect_outbox WHERE ${related}`).bind(...args),
    db.prepare('DELETE FROM mini_app_command_receipts WHERE actor_telegram_id=?').bind(subjectId),
    db.prepare(`DELETE FROM lead_request_events WHERE actor_telegram_id=? OR lead_id IN (${subjectLeads})`)
      .bind(subjectId,key),
    db.prepare(`DELETE FROM partner_legal_profile_events WHERE actor_id=? OR partner_profile_id IN
      (SELECT id FROM partner_profiles WHERE telegram_id=?)`).bind(subjectId,subjectId),
    db.prepare('DELETE FROM partner_legal_profiles WHERE declared_by=?').bind(subjectId),
    ...(schema.has_lease===1?[db.prepare(`UPDATE mini_app_release_control SET state='closed',beta_enabled=0,
      owner_telegram_id=NULL,issued_at=NULL,expires_at=NULL,revision=revision+1,updated_at=unixepoch()
      WHERE owner_telegram_id=? AND EXISTS(SELECT 1 FROM mini_app_privacy_guard WHERE guard_key=? AND precondition_ok=1)`)
      .bind(subjectId,key)]:[]),
    db.prepare('DELETE FROM mini_app_privacy_guard WHERE guard_key=?').bind(key),
  ];
}

export function installRebuildPrivacyRuntime() {
  // This entrypoint is the only installer. No request-specific state is global.
  globalThis[ANALYTICS_PRIVACY_RUNTIME_KEY]=Object.freeze({
    async prepareV139PrivacyDeletion(env,subjectId,requestId) {
      const stable=await analyticsPrivacyRuntime.prepareV139PrivacyDeletion(env,subjectId,requestId);
      const rebuild=await prepareRebuildSubjectDeletion(env,subjectId,requestId);
      return [...rebuild,...stable];
    },
  });
}

export async function runRebuildRetention(env) {
  if (env.REBUILD_V140_RETENTION_ENABLED!=='true') return {status:'closed'};
  const db=env.DB.withSession('first-primary');
  const present=await db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name='mini_app_privacy_guard'").first();
  if (present?.n!==1) return {status:'unavailable'};
  const key=crypto.randomUUID(),old='unixepoch()-15552000';
  const expired=`SELECT dedupe_key FROM mini_app_effect_outbox WHERE created_at<=${old} ORDER BY created_at,dedupe_key LIMIT 100`;
  const sqls=[
    ["INSERT INTO mini_app_privacy_guard(guard_key,reason,expires_at,precondition_ok) VALUES (?,'retention',unixepoch()+60,1)",[key]],
    [`DELETE FROM mini_app_effect_claims WHERE dedupe_key IN (${expired})`,[]],
    [`DELETE FROM mini_app_effect_outbox WHERE dedupe_key IN (${expired})`,[]],
    [`DELETE FROM mini_app_command_receipts WHERE idempotency_key IN
      (SELECT idempotency_key FROM mini_app_command_receipts WHERE committed_at<=${old}
       AND NOT EXISTS(SELECT 1 FROM mini_app_effect_outbox WHERE command_key=idempotency_key) ORDER BY committed_at LIMIT 100)`,[]],
    [`DELETE FROM lead_request_events WHERE id IN
      (SELECT id FROM lead_request_events WHERE unixepoch(occurred_at)<=${old} ORDER BY id LIMIT 100)`,[]],
    [`DELETE FROM partner_legal_profile_events WHERE id IN
      (SELECT id FROM partner_legal_profile_events WHERE unixepoch(created_at)<=${old} ORDER BY id LIMIT 100)`,[]],
    ["DELETE FROM mini_app_sessions WHERE session_id IN (SELECT session_id FROM mini_app_sessions WHERE expires_at<=unixepoch()-60 LIMIT 100)",[]],
    ["DELETE FROM mini_app_init_data_receipts WHERE init_data_fingerprint IN (SELECT init_data_fingerprint FROM mini_app_init_data_receipts r WHERE expires_at<=unixepoch()-60 AND NOT EXISTS(SELECT 1 FROM mini_app_sessions s WHERE s.init_data_fingerprint=r.init_data_fingerprint) LIMIT 100)",[]],
    ["DELETE FROM mini_app_privacy_denials WHERE init_data_fingerprint IN (SELECT init_data_fingerprint FROM mini_app_privacy_denials WHERE expires_at<=unixepoch()-60 LIMIT 100)",[]],
    ['DELETE FROM mini_app_privacy_guard WHERE guard_key=?',[key]],
  ];
  await db.batch(sqls.map(([sql,args])=>db.prepare(sql).bind(...args)));
  return {status:'completed',limitPerTable:100};
}
