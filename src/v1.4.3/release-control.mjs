import {V143_RELEASE_MIGRATIONS as PLAN} from './release-migrations.mjs';
import {canonicalCabinetOwnerId} from '../v1.4.0-rebuild/cabinet-participants.mjs';
import {REVOKE_RELEASE_SESSIONS_SQL} from '../v1.4.0-rebuild/release-lease.mjs';
import {readV143InstallConfig,assertV143InstallMode} from './install-config.mjs';
import {readV143ReleaseConfig} from './release-config.mjs';

export const V143_RELEASE_CONTROL_PATH='/__rebuild/v1.4.3/release';
const ORIGIN='https://re-program-bot.markakula4.workers.dev';
const SCHEMA_SQL="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name";
const SCHEMA_SNAPSHOT=`(SELECT json_group_array(json_array(type,name,tbl_name,sql)) FROM (${SCHEMA_SQL}))`;
const LEDGER_SQL='SELECT version FROM re_schema_migrations ORDER BY version';
const LEDGER_SNAPSHOT=`(SELECT json_group_array(version) FROM (${LEDGER_SQL}))`;
const OWNER_SQL=`EXISTS(SELECT 1 FROM users WHERE telegram_id=? AND accepted_terms=1 AND is_blocked=0)
 AND EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=? AND role='admin' AND status='active')
 AND NOT EXISTS(SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending'
  AND (unixepoch(expires_at) IS NULL OR unixepoch(expires_at)>unixepoch()))
 AND NOT EXISTS(SELECT 1 FROM user_moderation_blocks WHERE target_telegram_id=? AND status='active')`;
const LEASE_SQL=`EXISTS(SELECT 1 FROM mini_app_release_control WHERE id=1 AND candidate_sha=? AND revision=?
 AND state='closed' AND beta_enabled=0 AND owner_telegram_id IS NULL AND issued_at IS NULL AND expires_at IS NULL)`;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const hash=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;};
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function rows(db,sql,params=[]) {
  const result=await db.prepare(sql).bind(...params).all();
  if(result?.success!==true||!Array.isArray(result.results))fail('v143_release_read_unverified');
  return result.results;
}
async function one(db,sql,params=[]) {
  const result=await rows(db,sql,params);if(result.length!==1)fail('v143_release_read_unverified');return result[0];
}
async function body(request) {
  const reader=request.body?.getReader();if(!reader)fail('v143_release_input_invalid');
  let timer,size=0;const parts=[];
  try {
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('deadline')),5000);});
    for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;
      size+=part.value.length;if(size>2048)fail('v143_release_input_invalid');parts.push(part.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!value||typeof value!=='object'||Array.isArray(value))fail('v143_release_input_invalid');return value;
  }catch{fail('v143_release_input_invalid');}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
const closed=(lease,sha,revision)=>lease?.candidate_sha===sha&&lease.revision===revision&&lease.state==='closed'&&
  lease.beta_enabled===0&&lease.owner_telegram_id===null&&lease.issued_at===null&&lease.expires_at===null;
const leaseProjection=lease=>lease===null?null:{candidateSha:lease.candidate_sha,revision:lease.revision,state:lease.state,
  betaEnabled:lease.beta_enabled,ownerAbsent:lease.owner_telegram_id===null,issuedAbsent:lease.issued_at===null,
  expiryAbsent:lease.expires_at===null};
async function snapshot(db,ownerId) {
  const objects=await rows(db,SCHEMA_SQL+' LIMIT 2001'),ledger=await rows(db,LEDGER_SQL+' LIMIT 257');
  if(!objects.length||objects.length>2000||!ledger.length||ledger.length>256||
    ledger.some(row=>typeof row.version!=='string'))fail('v143_release_metadata_invalid');
  const schemaJson=JSON.stringify(objects.map(row=>[row.type,row.name,row.tbl_name,row.sql])),
    ledgerJson=JSON.stringify(ledger.map(row=>row.version)),leases=await rows(db,'SELECT * FROM mini_app_release_control WHERE id=1');
  if(leases.length>1)fail('v143_release_metadata_invalid');
  const owner=await one(db,`SELECT (${OWNER_SQL}) owner_ready`,[ownerId,ownerId,ownerId,ownerId]);
  return {schemaJson,ledgerJson,versions:ledger.map(row=>row.version),schemaSha256:await hash(schemaJson),
    ownerReady:owner.owner_ready===1,lease:leases[0]??null};
}
const markerVersions=versions=>versions.filter(version=>/^1\.4\.3(?:-|$)|^006[678](?:-|$)/iu.test(version));
const preparedMarkers=versions=>JSON.stringify(markerVersions(versions).sort())===JSON.stringify([...PLAN.markers].sort());

// Private expand/CAS only. It cannot activate participant access, issue money,
// alter a role, replace accounting history, or retry an uncertain mutation.
export function createV143ReleaseControl({clock=()=>Math.floor(Date.now()/1000),allowTestOrigin=false,
  installConfig,releaseConfig}={}) {
  return async(request,env)=>{
    const url=new URL(request.url);if(url.pathname!==V143_RELEASE_CONTROL_PATH)return null;
    let compiled,release;try{compiled=readV143InstallConfig(installConfig);release=readV143ReleaseConfig(releaseConfig);
      if(!compiled)return new Response('Not found',{status:404});assertV143InstallMode(compiled,release);
    }catch{return new Response('Not found',{status:404});}
    const now=clock(),issued=Number(env.REBUILD_V140_CONTROL_ISSUED_AT),until=Number(env.REBUILD_V140_CONTROL_EXPIRES_AT);
    if(request.method!=='POST'||(!allowTestOrigin&&url.origin!==ORIGIN)||url.search||!Number.isSafeInteger(now)||
      !/^[0-9]{10}$/u.test(env.REBUILD_V140_CONTROL_ISSUED_AT??'')||!/^[0-9]{10}$/u.test(env.REBUILD_V140_CONTROL_EXPIRES_AT??'')||
      !Number.isSafeInteger(issued)||!Number.isSafeInteger(until)||until<=issued||until-issued>1800||issued>now+30||now>=until||
      !/^application\/json(?:\s*;|$)/iu.test(request.headers.get('Content-Type')??''))return new Response('Not found',{status:404});
    const token=/^Bearer ([A-Za-z0-9_-]{32,128})$/u.exec(request.headers.get('Authorization')??'')?.[1];
    if(!token||!/^[a-f0-9]{64}$/u.test(env.REBUILD_V140_CONTROL_SECRET_SHA256??'')||
      !equal(await hash(token),env.REBUILD_V140_CONTROL_SECRET_SHA256))return new Response('Not found',{status:404});
    try {
      const input=await body(request);
      if(Object.keys(input).length!==2||Object.keys(input).some(key=>!['action','candidateSha'].includes(key))||
        !['status','prepare'].includes(input.action)||input.candidateSha!==compiled.candidateSha)fail('v143_release_input_invalid');
      const ownerId=canonicalCabinetOwnerId(env),botId=Number(String(env.BOT_TOKEN??'').split(':')[0]);
      if(ownerId!==compiled.ownerId||!Number.isSafeInteger(botId)||botId!==compiled.botId||
        env.REBUILD_V140_BOT_ID!==String(compiled.botId)||!env.DB?.withSession)
        fail('v143_release_identity_unavailable');
      const staging=compiled.stage==='prepare'&&env.REBUILD_V140_RC_SHA===compiled.parentSourceSha&&
        env.REBUILD_V140_RELEASE_REVISION===String(compiled.parentRevision),
        finalFrame=compiled.stage!=='prepare'&&env.REBUILD_V140_RC_SHA===compiled.candidateSha&&
          env.REBUILD_V140_RELEASE_REVISION===String(compiled.preparedRevision);
      if(!staging&&!finalFrame)fail('v143_release_runtime_frame_unverified');
      const db=env.DB.withSession('first-primary'),before=await snapshot(db,ownerId),
        base=before.schemaSha256===PLAN.baselineDdlSha256&&closed(before.lease,compiled.parentSourceSha,compiled.parentRevision)&&
          markerVersions(before.versions).length===0,
        prepared=before.schemaSha256===PLAN.preparedDdlSha256&&preparedMarkers(before.versions)&&
          closed(before.lease,compiled.candidateSha,compiled.preparedRevision);
      if(input.action==='status')return json({ok:true,action:'status',candidateSha:compiled.candidateSha,
        stage:compiled.stage,phase:prepared?'prepared':base?'accepted_base':'unrecognized',canPrepare:staging&&base&&before.ownerReady,
        owner:{eligible:before.ownerReady},lease:leaseProjection(before.lease),schemaSha256:before.schemaSha256,
        lifecycleReady:prepared,controllerExpiresAt:until,customerAccessActivated:false});
      if(!staging)fail('v143_release_prepare_mode_invalid');
      if(!before.ownerReady)fail('v143_release_owner_not_ready');
      if(!base)fail('v143_release_prepare_baseline_mismatch');
      const initial='v143_prepare_'+crypto.randomUUID(),casGuard=initial+'_cas';
      const statements=[db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN
        ${SCHEMA_SNAPSHOT}=? AND ${LEDGER_SNAPSHOT}=? AND (${OWNER_SQL}) AND (${LEASE_SQL})
        AND unixepoch()>=?-30 AND unixepoch()<? THEN 1 ELSE 0 END)`)
        .bind(initial,before.schemaJson,before.ledgerJson,ownerId,ownerId,ownerId,ownerId,
          compiled.parentSourceSha,compiled.parentRevision,issued,until),...PLAN.statements.map(sql=>db.prepare(sql))];
      const casIndex=statements.length;
      statements.push(db.prepare(`UPDATE mini_app_release_control SET candidate_sha=?,revision=?,updated_at=unixepoch()
        WHERE id=1 AND candidate_sha=? AND revision=? AND state='closed' AND beta_enabled=0
        AND owner_telegram_id IS NULL AND issued_at IS NULL AND expires_at IS NULL`)
        .bind(compiled.candidateSha,compiled.preparedRevision,compiled.parentSourceSha,compiled.parentRevision),
        db.prepare('INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)').bind(casGuard),
        db.prepare(REVOKE_RELEASE_SESSIONS_SQL),db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key IN (?,?)').bind(initial,casGuard));
      let committed;try{committed=await db.batch(statements);}catch{fail('v143_release_prepare_outcome_unverified');}
      if(!Array.isArray(committed)||committed.length!==statements.length||committed.some(result=>result?.success!==true)||
        committed[0].meta?.changes!==1||committed[casIndex].meta?.changes!==1||committed[casIndex+1].meta?.changes!==1||
        committed.at(-1).meta?.changes!==2)fail('v143_release_prepare_outcome_unverified');
      const after=await snapshot(db,ownerId),expected=[...before.versions,...PLAN.markers].sort(),
        sessions=await one(db,'SELECT COUNT(*) active_sessions FROM mini_app_sessions WHERE revoked_at IS NULL');
      if(after.schemaSha256!==PLAN.preparedDdlSha256||!closed(after.lease,compiled.candidateSha,compiled.preparedRevision)||
        JSON.stringify(after.versions)!==JSON.stringify(expected)||sessions.active_sessions!==0)
        fail('v143_release_prepare_outcome_unverified');
      return json({ok:true,action:'prepare',candidateSha:compiled.candidateSha,stage:compiled.stage,phase:'prepared',
        lifecycleReady:true,schemaSha256:after.schemaSha256,lease:leaseProjection(after.lease),addedTables:PLAN.addedTables,
        addedMigrations:PLAN.addedMigrations,statements:statements.length,activeSessions:0,businessBackfill:0,
        grantsBackfill:0,rolesChanged:0,financialBackfill:0,customerAccessActivated:false});
    }catch(error){const code=/^v143_release_[a-z0-9_]+$/u.test(error?.code??'')?error.code:'v143_release_action_unverified';
      return json({ok:false,code,retrySafe:false,observeAction:'status'},code==='v143_release_prepare_outcome_unverified'?503:409);}
  };
}
