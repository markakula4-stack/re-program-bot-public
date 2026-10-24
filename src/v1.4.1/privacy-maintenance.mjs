import { inspectP04Schema, P04_SCHEMA } from './privacy-schema.mjs';
import { prepareAiJournalPrivacyTransfer } from './ai-recovery-journal.mjs';
import { inspectLifecyclePrivacyRetention, lifecycleRetentionAssertion } from '../v1.4.3/privacy-retention.mjs';

const positive=value=>Number.isSafeInteger(value)&&value>0;
const fail=code=>{throw Object.assign(new Error(code),{code,status:409});};
const prepare=(db,sql,args=[])=>db.prepare(sql).bind(...args);
// This is a fixed extension of the existing confirmed deletion transaction.
// It never runs a standalone batch or accepts a mutation/callback from callers.
export async function prepareV141PrivacyDeletion(env,subjectId,requestId) {
  const db=env?.DB;
  if(!db?.prepare||!db?.batch||!positive(subjectId)||typeof requestId!=='string'||
      requestId.length<16||requestId.length>128) fail('privacy_authority_invalid');
  if(env.V141_AUTHORIZATION_ENABLED!=='true') fail('v141_runtime_disabled');
  if(String(env.ADMIN_ID??'')===String(subjectId)||String(env.OWNER_TELEGRAM_ID??'')===String(subjectId)) fail('privacy_admin_blocked');
  await inspectP04Schema(db);
  const lifecycle=await inspectLifecyclePrivacyRetention(db,subjectId);
  if(lifecycle.retainedFinancial)fail('privacy_financial_evidence_retained');
  const guardKey='v141_privacy_'+crypto.randomUUID();
  const checks=[];
  const assert=(sql,args=[])=>{
    const key=guardKey+'_check'+checks.length;checks.push(key);
    return prepare(db,`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
      VALUES(?,CASE WHEN (${sql}) THEN 1 ELSE 0 END)`,[key,...args]);
  };
  const prefix=[assert(`(SELECT COALESCE(json_group_array(json(object)),'[]') FROM
    (SELECT json_object('type',type,'name',name,'table_name',tbl_name,'sql',sql) AS object FROM sqlite_schema
      WHERE tbl_name IN (${P04_SCHEMA.tables.map(()=>'?').join(',')}) ORDER BY type,name)) IS ?
    AND (SELECT COUNT(*) FROM re_schema_migrations WHERE version=?)=1`,
    [...P04_SCHEMA.tables,JSON.stringify(P04_SCHEMA.objects),P04_SCHEMA.ledgerVersion]),prepare(db,`INSERT INTO mini_app_privacy_guard
    (guard_key,subject_id,reason,request_id,subject_lead_ids_json,expires_at,precondition_ok)
    VALUES(?,?,'subject_deletion',?,(SELECT json_group_array(id) FROM lead_requests WHERE telegram_id=? OR inviter_id=?),
      unixepoch()+300,CASE WHEN EXISTS(SELECT 1 FROM privacy_deletion_requests
        WHERE request_id=? AND telegram_id=? AND status='pending' AND unixepoch(expires_at)>unixepoch())
      AND EXISTS(SELECT 1 FROM users WHERE telegram_id=?)
      AND NOT EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=? AND role='admin' AND status='active')
      AND NOT EXISTS(SELECT 1 FROM lead_requests WHERE telegram_id=? AND status IN ('pending','confirmed'))
      AND NOT EXISTS(SELECT 1 FROM conversions WHERE telegram_id=? AND status IN ('pending','confirmed'))
      AND NOT EXISTS(SELECT 1 FROM partner_applications WHERE telegram_id=? AND status IN ('pending','approved'))
      AND NOT EXISTS(SELECT 1 FROM partner_profiles WHERE telegram_id=?)
      AND NOT EXISTS(SELECT 1 FROM terms_acceptances WHERE telegram_id=?)
      AND NOT EXISTS(SELECT 1 FROM subscription_orders WHERE telegram_id=?)
      AND NOT EXISTS(SELECT 1 FROM payment_ledger WHERE telegram_id=?)
      AND NOT EXISTS(SELECT 1 FROM subscriptions WHERE telegram_id=?)
      AND NOT EXISTS(SELECT 1 FROM payment_refunds WHERE telegram_id=?) THEN 1 ELSE 0 END)`,
    [guardKey,subjectId,requestId,subjectId,subjectId,requestId,...Array(12).fill(subjectId)])];
  const lifecycleGuard=lifecycleRetentionAssertion(lifecycle.state,subjectId);
  prefix.push(assert(lifecycleGuard.sql,lifecycleGuard.params));
  // Source rows and unresolved provider holds move before either old quota FK
  // or the user is removed. The AI compiler is fixed server code, not input.
  prefix.push(...await prepareAiJournalPrivacyTransfer(env,subjectId,requestId,guardKey));
  for(const table of ['entitlement_grants','entitlement_overrides','feature_flag_assignments']) {
    prefix.push(prepare(db,`DELETE FROM ${table} WHERE subject_telegram_id=?`,[subjectId]));
    const author=table==='feature_flag_assignments'?'assigned_by':'issued_by';
    const marker=table==='feature_flag_assignments'?'assigner_anonymized':'issuer_anonymized';
    prefix.push(prepare(db,`UPDATE ${table} SET
      ${author}=CASE WHEN ${author}=? THEN NULL ELSE ${author} END,
      ${marker}=CASE WHEN ${author}=? THEN 1 ELSE ${marker} END,
      reason=CASE WHEN ${author}=? THEN 'author_deleted' ELSE reason END,
      revoked_by=CASE WHEN revoked_by=? THEN NULL ELSE revoked_by END,
      revoker_anonymized=CASE WHEN revoked_by=? THEN 1 ELSE revoker_anonymized END,
      revocation_reason=CASE WHEN revoked_by=? THEN 'author_deleted' ELSE revocation_reason END
      WHERE ${author}=? OR revoked_by=?`,Array(8).fill(subjectId)));
  }
  // Existing authentic seals remain byte-for-byte unchanged; all seal core
  // columns stay immutable. Unsigned or invalid rows acquire no authority.
  prefix.push(prepare(db,`UPDATE feature_flags SET updated_by=NULL,updater_anonymized=1,reason='author_deleted'
    WHERE updated_by=?`,[subjectId]));
  prefix.push(prepare(db,'DELETE FROM entitlement_decision_audit WHERE subject_telegram_id=? OR actor_telegram_id=?',[subjectId,subjectId]));
  prefix.push(assert(`NOT EXISTS(SELECT 1 FROM entitlement_grants WHERE subject_telegram_id=? OR issued_by=? OR revoked_by=?)
    AND NOT EXISTS(SELECT 1 FROM entitlement_overrides WHERE subject_telegram_id=? OR issued_by=? OR revoked_by=?)
    AND NOT EXISTS(SELECT 1 FROM feature_flag_assignments WHERE subject_telegram_id=? OR assigned_by=? OR revoked_by=?)
    AND NOT EXISTS(SELECT 1 FROM feature_flags WHERE updated_by=?)
    AND NOT EXISTS(SELECT 1 FROM entitlement_decision_audit WHERE subject_telegram_id=? OR actor_telegram_id=?)
    AND NOT EXISTS(SELECT 1 FROM ai_operation_journal WHERE subject_telegram_id=?)`,Array(13).fill(subjectId)));
  // The existing Worker MUST place this immediately after its exact pending ->
  // completed UPDATE. A zero-row completion rolls back every earlier effect.
  const suffix=[assert(`changes()=1 AND EXISTS(SELECT 1 FROM privacy_deletion_requests
    WHERE request_id=? AND telegram_id IS NULL AND status='completed' AND completed_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM users WHERE telegram_id=?)`,[requestId,subjectId]),
    prepare(db,'DELETE FROM mini_app_privacy_guard WHERE guard_key=?',[guardKey])];
  suffix.push(prepare(db,`DELETE FROM mini_app_atomic_guards WHERE guard_key IN (${checks.map(()=>'?').join(',')})`,checks));
  return Object.freeze({prefix:Object.freeze(prefix),suffix:Object.freeze(suffix)});
}

export const privacyRuntime=Object.freeze({
  prepareV141PrivacyDeletion,
  prepareConfirmedPrivacyCleanup({env,subjectId,requestId}={}) {
    return prepareV141PrivacyDeletion(env,subjectId,requestId);
  },
});
