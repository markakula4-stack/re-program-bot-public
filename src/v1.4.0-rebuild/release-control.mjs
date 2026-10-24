import {RELEASE_MIGRATIONS} from './release-migrations.mjs';
import {readCabinetOwnerGate} from './cabinet-http.mjs';
import {reviewedRepositoryFactory} from './storage-factory.mjs';
import {canonicalCabinetOwnerId} from './cabinet-participants.mjs';
import {CLOSE_RELEASE_LEASE_SQL,REVOKE_RELEASE_SESSIONS_SQL} from './release-lease.mjs';
const PATH='/__rebuild/v1.4.0/release';
const ORIGIN='https://re-program-bot.markakula4.workers.dev';
const flags=['STORAGE','WRITES','OFFER_ACTIONS','EFFECTS','RETENTION','TELEGRAM','BETA','RESULT_ACTIONS'];
const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/u.test(s);
const id=n=>Number.isSafeInteger(n)&&n>0;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;};
const hash=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export async function releaseSchemaDigest(db){
  const result=await db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL
    AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name`).all();
  if(result.success!==true||!Array.isArray(result.results))fail('release_schema_unavailable');
  return hash(JSON.stringify(result.results.map(r=>[r.type,r.name,r.tbl_name,r.sql])));
}
async function releaseLease(db){
  const present=await db.prepare("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mini_app_release_control') present").first();
  return present?.present===1?db.prepare('SELECT * FROM mini_app_release_control WHERE id=1').first():null;
}
function closed(env){return env.REBUILD_V140_ADMIN_ACCESS_ENABLED!=='true'&&env.REBUILD_V140_ADMIN_BETA_GRANTS_ENABLED!=='true'&&env.REBUILD_V140_OWNER_WINDOW==='false'&&flags.every(f=>env['REBUILD_V140_'+f+'_ENABLED']==='false');}
function accessStatus(env,lease,owner,now){
  const canonical=canonicalCabinetOwnerId(env),matched=lease?.candidate_sha===env.REBUILD_V140_RC_SHA&&lease?.revision===Number(env.REBUILD_V140_RELEASE_REVISION),
    gate=readCabinetOwnerGate(env,now),ownerEnabled=env.REBUILD_V140_ADMIN_ACCESS_ENABLED==='true'&&env.REBUILD_V140_RELEASE_LEASE_REQUIRED==='true'&&
      Number(env.REBUILD_V140_BOT_ID)===Number(String(env.BOT_TOKEN??'').split(':')[0])&&
      ['STORAGE','WRITES','TELEGRAM'].every(f=>env['REBUILD_V140_'+f+'_ENABLED']==='true')&&matched&&canonical&&owner?.telegramId===canonical&&
      owner.registered===true&&owner.acceptedTerms===true&&owner.blocked===false&&owner.deleting===false&&owner.roles?.includes('admin')===true,
    participantClosed=!(matched&&gate&&lease.state==='open'&&lease.owner_telegram_id===gate.ownerTelegramId&&lease.issued_at===gate.issuedAt&&lease.expires_at===gate.expiresAt);
  return {ownerEnabled:Boolean(ownerEnabled),participantClosed,allClosed:participantClosed&&!ownerEnabled};
}
async function boundedBody(request){
  const reader=request.body?.getReader();if(!reader)fail('release_input_invalid');let size=0;const parts=[];let timer;
  try{const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('deadline')),5000);});
    for(;;){const {value,done}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.length;if(size>2048)fail('release_input_invalid');parts.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
    const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!input||typeof input!=='object'||Array.isArray(input))fail('release_input_invalid');return input;
  }catch{fail('release_input_invalid');}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
async function participant(db,telegramId){
  if(!id(telegramId))fail('release_participant_invalid');
  const row=await db.prepare(`SELECT u.telegram_id,u.accepted_terms,u.is_blocked,
    EXISTS(SELECT 1 FROM privacy_deletion_requests d WHERE d.telegram_id=u.telegram_id AND d.status='pending' AND unixepoch(d.expires_at)>unixepoch()) deleting,
    (SELECT json_group_array(role) FROM user_roles WHERE telegram_id=u.telegram_id AND status='active') roles,
    (SELECT age_confirmed FROM partner_applications WHERE telegram_id=u.telegram_id) age_confirmed,
    (SELECT status FROM partner_profiles WHERE telegram_id=u.telegram_id) partner_status,
    (SELECT b.access_status FROM partner_beta_access b JOIN partner_profiles p ON p.id=b.partner_profile_id WHERE p.telegram_id=u.telegram_id) beta_status
    FROM users u WHERE telegram_id=?`).bind(telegramId).first();
  return row?{telegramId:row.telegram_id,registered:true,acceptedTerms:row.accepted_terms===1,blocked:row.is_blocked===1,
    deleting:row.deleting===1,roles:JSON.parse(row.roles),ageConfirmed:row.age_confirmed===1,partnerStatus:row.partner_status??null,betaStatus:row.beta_status??null}
    :{telegramId,registered:false};
}
export function createReleaseControl({clock=()=>Math.floor(Date.now()/1000),allowTestOrigin=false}={}){
  return async(request,env)=>{
    const url=new URL(request.url);if(url.pathname!==PATH)return null;
    const now=clock(),issued=Number(env.REBUILD_V140_CONTROL_ISSUED_AT),until=Number(env.REBUILD_V140_CONTROL_EXPIRES_AT);
    if(request.method!=='POST'||(!allowTestOrigin&&url.origin!==ORIGIN)||url.search||
      !/^[0-9]{10}$/u.test(env.REBUILD_V140_CONTROL_ISSUED_AT??'')||!Number.isSafeInteger(until)||until<=issued||until-issued>1800||issued>now+30||now>=until||
      !/^application\/json(?:\s*;|$)/iu.test(request.headers.get('Content-Type')??''))return new Response('Not found',{status:404});
    const provided=/^Bearer ([A-Za-z0-9_-]{32,128})$/u.exec(request.headers.get('Authorization')??'')?.[1];
    const expectedHash=env.REBUILD_V140_CONTROL_SECRET_SHA256,token=env.REBUILD_V140_CONTROL_SECRET;
    const authorized=provided!==undefined&&(expectedHash!==undefined
      ?/^[a-f0-9]{64}$/u.test(expectedHash)&&equal(await hash(provided),expectedHash)
      :typeof token==='string'&&token.length>=32&&token.length<=128&&equal(provided,token));
    if(!authorized)return new Response('Not found',{status:404});
    try{
      const input=await boundedBody(request),action=input.action;
      const keys={status:['action','candidateSha','participantIds'],expand:['action','candidateSha'],close:['action','candidateSha'],open:['action','candidateSha','previousRevision','participantRole'],enable_admin:['action','candidateSha','previousRevision','previousCandidateSha']};
      if(!keys[action]||Object.keys(input).some(k=>!keys[action].includes(k))||!sha(input.candidateSha)||input.candidateSha!==env.REBUILD_V140_RC_SHA)fail('release_input_invalid');
      const db=env.DB.withSession('first-primary'),botId=Number(String(env.BOT_TOKEN??'').split(':')[0]),adminId=Number(env.ADMIN_ID);
      if(!id(botId)||!id(adminId))fail('release_identity_unavailable');
      if(action==='status'){
        const ids=input.participantIds??[];if(!Array.isArray(ids)||ids.length>2||new Set(ids).size!==ids.length||ids.some(n=>!id(n)))fail('release_participant_invalid');
        const participants=[];for(const n of [adminId,...ids.filter(n=>n!==adminId)])participants.push(await participant(db,n));
        const lease=await releaseLease(db),owner=participants.find(p=>p.telegramId===adminId);
        return json({ok:true,candidateSha:input.candidateSha,botId,adminId,canonicalOwnerId:canonicalCabinetOwnerId(env),closed:closed(env),schemaSha256:await releaseSchemaDigest(db),
          ...accessStatus(env,lease,owner,now),lease,participants,publicVersion:globalThis.__RE_PROGRAM_PUBLIC_RELEASE_RUNTIME__?.version??'1.3.9',controllerExpiresAt:until});
      }
      if(action==='close'){
        // ABORT must remain usable even if an unrelated schema object drifts.
        // It never restores or drops business data, and works before expand.
        const present=await db.prepare("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='mini_app_release_control' AND type='table') present").first();
        if(present?.present!==1)return json({ok:true,action,lease:null});
        // Bump even an already closed revision, or install the first tombstone.
        // An open request still in flight cannot later use its old CAS revision.
        const sessions=await db.prepare("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='mini_app_sessions' AND type='table') present").first();
        await db.batch([db.prepare(CLOSE_RELEASE_LEASE_SQL).bind(input.candidateSha),
          ...(sessions?.present===1?[db.prepare(REVOKE_RELEASE_SESSIONS_SQL)]:[])]);
        const lease=await releaseLease(db);if(lease&&lease.state!=='closed')fail('release_close_unverified');
        return json({ok:true,action,lease});
      }
      if(action==='expand'){
        if(!closed(env))fail('release_expand_gates_open');
        const before=await releaseSchemaDigest(db);if(before!==RELEASE_MIGRATIONS.baseDdlSha256)fail('release_expand_baseline_mismatch');
        const markersBefore=(await db.prepare('SELECT version FROM re_schema_migrations ORDER BY version').all()).results.map(r=>r.version);
        await db.batch(RELEASE_MIGRATIONS.statements.map(sql=>db.prepare(sql)));
        const after=await releaseSchemaDigest(db);if(after!==RELEASE_MIGRATIONS.expandedDdlSha256)fail('release_expand_schema_unverified');
        const markersAfter=(await db.prepare('SELECT version FROM re_schema_migrations ORDER BY version').all()).results.map(r=>r.version);
        if(JSON.stringify(markersAfter)!==JSON.stringify([...new Set([...markersBefore,...RELEASE_MIGRATIONS.markers])].sort()))fail('release_expand_markers_unverified');
        if(await releaseLease(db))fail('release_expand_unexpected_lease');
        return json({ok:true,action,schemaSha256:after,addedMigrations:5,addedTables:12,statements:RELEASE_MIGRATIONS.statements.length,businessBackfill:0});
      }
      if(action==='enable_admin'){
        const previous=input.previousRevision,revision=Number(env.REBUILD_V140_RELEASE_REVISION);
        if(canonicalCabinetOwnerId(env)!==adminId||env.REBUILD_V140_ADMIN_ACCESS_ENABLED!=='true'||env.REBUILD_V140_OWNER_WINDOW!=='false'||
          env.REBUILD_V140_OWNER_TELEGRAM_ID!=='0'||Number(env.REBUILD_V140_BOT_ID)!==botId||env.REBUILD_V140_RELEASE_LEASE_REQUIRED!=='true'||
          !Number.isSafeInteger(previous)||previous<1||revision!==previous+1||!sha(input.previousCandidateSha)||
          flags.some(f=>env['REBUILD_V140_'+f+'_ENABLED']!==(['STORAGE','WRITES','TELEGRAM'].includes(f)?'true':'false')))fail('release_admin_enable_invalid');
        await reviewedRepositoryFactory({...env,REBUILD_V140_RELEASE_LEASE_REQUIRED:'false'},{readOnly:true}).assertCandidateSchema();
        const key='p12_admin_'+crypto.randomUUID();
        await db.batch([
          db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN
            EXISTS(SELECT 1 FROM users WHERE telegram_id=? AND is_blocked=0 AND accepted_terms=1)
            AND EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=? AND role='admin' AND status='active')
            AND NOT EXISTS(SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending' AND unixepoch(expires_at)>unixepoch())
            AND EXISTS(SELECT 1 FROM mini_app_release_control WHERE id=1 AND state='closed' AND revision=? AND candidate_sha=?) THEN 1 ELSE 0 END)`)
            .bind(key,adminId,adminId,adminId,previous,input.previousCandidateSha),
          db.prepare(`UPDATE mini_app_release_control SET candidate_sha=?,revision=?,state='closed',beta_enabled=0,
            owner_telegram_id=NULL,issued_at=NULL,expires_at=NULL,updated_at=unixepoch() WHERE id=1`).bind(input.candidateSha,revision),
          db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key=?').bind(key),
        ]);
        return json({ok:true,action,lease:await releaseLease(db)});
      }
      const gate=readCabinetOwnerGate(env,now),revision=Number(env.REBUILD_V140_RELEASE_REVISION),previous=input.previousRevision,role=input.participantRole;
      if(!gate||env.REBUILD_V140_RELEASE_LEASE_REQUIRED!=='true'||env.REBUILD_V140_STORAGE_ENABLED!=='true'||
        env.REBUILD_V140_WRITES_ENABLED!=='true'||env.REBUILD_V140_TELEGRAM_ENABLED!=='true'||
        gate.botId!==botId||!Number.isSafeInteger(previous)||previous<0||revision!==previous+1||!['owner','partner','ordinary'].includes(role))fail('release_open_invalid');
      await reviewedRepositoryFactory({...env,REBUILD_V140_RELEASE_LEASE_REQUIRED:'false'},{readOnly:true}).assertCandidateSchema();
      const roleSql=role==='owner'?"EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=? AND role='admin' AND status='active')":
        "EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=? AND role='user' AND status='active') AND NOT EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=? AND role='admin' AND status='active')"+
        (role==='ordinary'?" AND NOT EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=? AND role='partner' AND status='active')":'');
      if(role==='owner'&&gate.ownerTelegramId!==adminId)fail('release_owner_invalid');
      const roleParams=role==='owner'?[gate.ownerTelegramId]:[gate.ownerTelegramId,gate.ownerTelegramId,...(role==='ordinary'?[gate.ownerTelegramId]:[])];
      const key='p12_open_'+crypto.randomUUID();
      await db.batch([
        db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN
          EXISTS(SELECT 1 FROM users WHERE telegram_id=? AND is_blocked=0 AND accepted_terms=1) AND ${roleSql}
          AND NOT EXISTS(SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending' AND unixepoch(expires_at)>unixepoch())
          AND ((?=0 AND NOT EXISTS(SELECT 1 FROM mini_app_release_control)) OR EXISTS(SELECT 1 FROM mini_app_release_control WHERE id=1 AND state='closed' AND revision=?))
          THEN 1 ELSE 0 END)`).bind(key,gate.ownerTelegramId,...roleParams,gate.ownerTelegramId,previous,previous),
        db.prepare(`INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,owner_telegram_id,issued_at,expires_at,updated_at)
          VALUES(1,?,?,'open',?,?,?, ?,unixepoch()) ON CONFLICT(id) DO UPDATE SET candidate_sha=excluded.candidate_sha,
          revision=excluded.revision,state=excluded.state,beta_enabled=excluded.beta_enabled,owner_telegram_id=excluded.owner_telegram_id,
          issued_at=excluded.issued_at,expires_at=excluded.expires_at,updated_at=excluded.updated_at`).bind(input.candidateSha,revision,env.REBUILD_V140_BETA_ENABLED==='true'?1:0,gate.ownerTelegramId,gate.issuedAt,gate.expiresAt),
        db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key=?').bind(key),
      ]);
      return json({ok:true,action,lease:await releaseLease(db)});
    }catch(error){return json({ok:false,code:/^release_[a-z0-9_]+$/u.test(error.code??'')?error.code:'release_action_unverified'},409);}
  };
}
