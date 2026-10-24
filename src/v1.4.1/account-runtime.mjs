import {readTrustedContext,deriveTrustedOperationContext} from './trusted-context.mjs';
import {createRuntimeAuthorizer,readRuntimeAuthorization,requireRuntimeAuthorization} from './runtime-authorizer.mjs';
import {compileDecisionAssertions} from './entitlement-engine.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code,status:409});};
const read=async(db,sql,params=[])=>{const r=await db.prepare(sql).bind(...params).all();if(r?.success!==true||!Array.isArray(r.results)||r.results.length>100)fail('account_read_failed');return r.results;};
const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,'0')).join('');

// Fixed existing /start account effect. It can create only an ordinary Free
// account and never restores paused roles or grants partner/admin authority.
export async function registerRuntimeAccount(original,{referralCode=null,referralKind='legacy'}={}) {
  if(referralCode!==null&&!(typeof referralCode==='string'&&/^[A-Za-z0-9_-]{1,96}$/u.test(referralCode)))fail('invalid_referral');
  if(!['legacy','partner'].includes(referralKind))fail('invalid_referral');
  const context=await deriveTrustedOperationContext(original,{operation:'account.register',requestPayload:{referralCode,referralKind}});
  const identity=readTrustedContext(context),db=identity.db,subject=identity.telegramId;
  const bundle=requireRuntimeAuthorization(await createRuntimeAuthorizer().authorize(context));
  const {decision}=readRuntimeAuthorization(bundle),proof=compileDecisionAssertions(decision),pieces=[...(proof.assertions??[proof])];
  const before=(await read(db,'SELECT * FROM users WHERE telegram_id=?',[subject]))[0]??null;
  let inviterId=before?.inviter_id??null,status=referralCode?'invalid':'none',attach=false;
  if(referralCode) {
    const sql=`SELECT json_array(u.telegram_id,u.referral_code,u.is_blocked,p.status,
      (SELECT COUNT(*) FROM user_roles WHERE telegram_id=u.telegram_id AND role='partner' AND status='active')) AS snapshot
      FROM users u LEFT JOIN partner_profiles p ON p.telegram_id=u.telegram_id WHERE u.referral_code=?`;
    const parent=(await read(db,sql,[referralCode]))[0]?.snapshot??null;
    pieces.push({sql:`(${sql}) IS ?`,params:[referralCode,parent]});
    const row=parent===null?null:JSON.parse(parent);
    if(row) {
      if(row[0]===subject)status='self';
      else if(row[2]!==0||referralKind==='partner'&&(row[3]!=='active'||row[4]!==1))status='inactive_partner';
      else if(inviterId)status=inviterId===row[0]?'already_linked':'bound_elsewhere';
      else if(before?.inviter_bound_at)status='locked';
      else if(before&&referralKind!=='partner')status='locked';
      else {
        const cycle=`WITH RECURSIVE chain(telegram_id) AS (SELECT ? UNION SELECT u.inviter_id FROM users u JOIN chain c ON u.telegram_id=c.telegram_id WHERE u.inviter_id IS NOT NULL) SELECT COUNT(*) FROM chain WHERE telegram_id=?`;
        if(Number((await read(db,cycle,[row[0],subject]))[0]?.['COUNT(*)'])!==0)status='cycle';
        else {inviterId=row[0];attach=true;status='attached';pieces.push({sql:`(${cycle})=0`,params:[row[0],subject]});}
      }
    }
  }
  if(pieces.length>96)fail('account_guard_limit');
  const keys=pieces.map(()=>`v141account_${crypto.randomUUID()}`),batch=pieces.map((p,i)=>db.prepare(
    `INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN (${p.sql}) THEN 1 ELSE 0 END)`).bind(keys[i],...p.params));
  if(!before) {
    const bytes=new Uint8Array(9);crypto.getRandomValues(bytes);
    const code=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
    batch.push(db.prepare('INSERT INTO users(telegram_id,referral_code,inviter_id,inviter_bound_at) VALUES(?,?,?,CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END)').bind(subject,code,inviterId,inviterId));
  } else if(attach) batch.push(db.prepare('UPDATE users SET inviter_id=?,inviter_bound_at=CURRENT_TIMESTAMP WHERE telegram_id=? AND inviter_id IS NULL AND inviter_bound_at IS NULL').bind(inviterId,subject));
  // INSERT OR IGNORE preserves any existing role status and user settings.
  batch.push(db.prepare("INSERT OR IGNORE INTO user_roles(telegram_id,role) VALUES(?,'user')").bind(subject),
    db.prepare("INSERT OR IGNORE INTO user_access(telegram_id,access_tier) VALUES(?,'free')").bind(subject),
    db.prepare('INSERT OR IGNORE INTO notification_settings(telegram_id) VALUES(?)').bind(subject));
  batch.push(...keys.map(key=>db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key=?').bind(key)));
  const results=await db.batch(batch);
  if(!Array.isArray(results)||results.length!==batch.length||results.some(r=>r?.success!==true))fail('account_commit_unknown');
  const user=(await read(db,'SELECT * FROM users WHERE telegram_id=?',[subject]))[0];
  if(!user)fail('account_commit_unknown');
  return Object.freeze({user,isNew:before===null,inviterId:user.inviter_id,inviterAttached:attach,referralStatus:status});
}

// Deterministic own-help exchanges retain current consent/identity guards but
// consume no provider success slot. Their memory effect is one fixed batch.
export async function rememberRuntimeOwnHelp(original,{userText,answer}={}) {
  if(typeof userText!=='string'||userText.length>700||typeof answer!=='string'||Array.from(answer).length>250||!answer.trim())fail('invalid_ai_memory');
  const context=await deriveTrustedOperationContext(original,{operation:'ai.memory.read_own',requestPayload:{}});
  const identity=readTrustedContext(context),db=identity.db;
  const bundle=requireRuntimeAuthorization(await createRuntimeAuthorizer().authorize(context));
  const proof=compileDecisionAssertions(readRuntimeAuthorization(bundle).decision),pieces=proof.assertions??[proof];
  const keys=pieces.map(()=>`v141memory_${crypto.randomUUID()}`),batch=pieces.map((p,i)=>db.prepare(
    `INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN (${p.sql}) THEN 1 ELSE 0 END)`).bind(keys[i],...p.params));
  batch.push(db.prepare("INSERT INTO ai_conversation_messages(telegram_id,role,content) VALUES(?,'user',?)").bind(identity.telegramId,userText),
    db.prepare("INSERT INTO ai_conversation_messages(telegram_id,role,content) VALUES(?,'assistant',?)").bind(identity.telegramId,answer),
    db.prepare('DELETE FROM ai_conversation_messages WHERE telegram_id=? AND id NOT IN(SELECT id FROM ai_conversation_messages WHERE telegram_id=? ORDER BY id DESC LIMIT 10)').bind(identity.telegramId,identity.telegramId));
  batch.push(...keys.map(key=>db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key=?').bind(key)));
  const results=await db.batch(batch);if(!Array.isArray(results)||results.length!==batch.length||results.some(r=>r?.success!==true))fail('ai_memory_commit_unknown');
}
