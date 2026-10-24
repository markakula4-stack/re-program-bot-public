import {CabinetStorageError} from './command-sql.mjs';
import {canonicalCabinetOwnerId} from './cabinet-participants.mjs';
export const CLOSE_RELEASE_LEASE_SQL="INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,updated_at) VALUES(1,?,1,'closed',0,unixepoch()) ON CONFLICT(id) DO UPDATE SET state='closed',beta_enabled=0,owner_telegram_id=NULL,issued_at=NULL,expires_at=NULL,revision=revision+1,updated_at=unixepoch()";
export const REVOKE_RELEASE_SESSIONS_SQL='UPDATE mini_app_sessions SET revoked_at=unixepoch() WHERE revoked_at IS NULL';
// Owner access uses the same singleton as a revocable source/epoch fence. It
// never inherits the finite participant identity or its deadline.
export function releaseAdminFence(env) {
  const owner=canonicalCabinetOwnerId(env),revision=Number(env.REBUILD_V140_RELEASE_REVISION);
  if(env.REBUILD_V140_RELEASE_LEASE_REQUIRED!=='true'||env.REBUILD_V140_ADMIN_ACCESS_ENABLED!=='true'||
    !/^[0-9a-f]{40}$/u.test(env.REBUILD_V140_RC_SHA??'')||!owner||!Number.isSafeInteger(revision)||revision<=0)
    throw new CabinetStorageError('release_lease_unavailable');
  return Object.freeze({sql:`EXISTS (SELECT 1 FROM mini_app_release_control WHERE id=1 AND candidate_sha=? AND revision=?)
    AND EXISTS (SELECT 1 FROM users WHERE telegram_id=? AND accepted_terms=1 AND is_blocked=0)
    AND EXISTS (SELECT 1 FROM user_roles WHERE telegram_id=? AND role='admin' AND status='active')
    AND NOT EXISTS (SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending' AND unixepoch(expires_at)>unixepoch())`,
    params:Object.freeze([env.REBUILD_V140_RC_SHA,revision,owner,owner,owner])});
}
export function releaseLeaseFence(env) {
  if(env.REBUILD_V140_RELEASE_LEASE_REQUIRED!=='true')return null;
  const match=/^true:([0-9]{10}):([0-9]{10})$/u.exec(env.REBUILD_V140_OWNER_WINDOW??'');
  const owner=Number(env.REBUILD_V140_OWNER_TELEGRAM_ID??env.OWNER_TELEGRAM_ID),revision=Number(env.REBUILD_V140_RELEASE_REVISION);
  if(!match||!/^[0-9a-f]{40}$/u.test(env.REBUILD_V140_RC_SHA??'')||
    !Number.isSafeInteger(owner)||owner<=0||!Number.isSafeInteger(revision)||revision<=0)
    throw new CabinetStorageError('release_lease_unavailable');
  const issued=Number(match[1]),expires=Number(match[2]);
  if(expires<=issued||expires-issued>1200)throw new CabinetStorageError('release_lease_unavailable');
  return Object.freeze({sql:`EXISTS (SELECT 1 FROM mini_app_release_control WHERE id=1 AND state='open'
    AND candidate_sha=? AND revision=? AND owner_telegram_id=? AND issued_at=? AND expires_at=? AND expires_at>unixepoch())`,
    params:Object.freeze([env.REBUILD_V140_RC_SHA,revision,owner,issued,expires])});
}
export async function assertReleaseLease(db,fence) {
  if(fence&&Number((await db.prepare(`SELECT ${fence.sql} AS allowed`).bind(...fence.params).first())?.allowed)!==1)
    throw new CabinetStorageError('release_lease_unavailable');
}
