import {V141_RELEASE_MIGRATIONS as PLAN} from './release-migrations.mjs';
import {P04_SCHEMA,inspectP04Schema} from './privacy-schema.mjs';
import {canonicalCabinetOwnerId} from '../v1.4.0-rebuild/cabinet-participants.mjs';
import {REVOKE_RELEASE_SESSIONS_SQL} from '../v1.4.0-rebuild/release-lease.mjs';
import {ADMIN_RELEASE_FRAME} from '../v1.4.1.1/admin-release-frame.mjs';

const PATH='/__rebuild/v1.4.1/release',ORIGIN='https://re-program-bot.markakula4.workers.dev';
// Only these deployed owner-only checkpoints may be replaced by a reviewed
// repair. The controller cannot rotate an arbitrary release lineage.
const REPAIR_PARENTS=Object.freeze([
  Object.freeze({sha:'b0b34ddb0115a71aed3aeedf293bc5cccb4980df',revision:27}),
  Object.freeze({sha:'1913fe3e41a45cd96c816a90b36f760f11bf3b6e',revision:28}),
  Object.freeze({sha:'ccb2a2c322ac97f528cc0b428034b2f3e2958ac3',revision:29}),
  Object.freeze({sha:'a623731ab9f052b214850008f5ac30c48c28d8dc',revision:30}),
  Object.freeze({sha:ADMIN_RELEASE_FRAME.main.sourceSha,revision:31}),
  Object.freeze({sha:'e6d5e339a3774824010ba83158bc28f20eaa7d17',revision:32}),
  Object.freeze({sha:'4ca462abd4b38a425f2bbfdc73e25f20f46802b0',revision:33}),
  Object.freeze({sha:'d8e93642192ce91ec42aa26dff563de6e92d5e25',revision:34}),
  Object.freeze({sha:'a5b73c3ffb88b656010c01d0af43971cc40c225b',revision:35}),
]);
const SCHEMA_SQL="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name";
const SCHEMA_SNAPSHOT=`(SELECT json_group_array(json_array(type,name,tbl_name,sql)) FROM (${SCHEMA_SQL}))`;
const LEDGER_SQL='SELECT version FROM re_schema_migrations ORDER BY version';
const LEDGER_SNAPSHOT=`(SELECT json_group_array(version) FROM (${LEDGER_SQL}))`;
const OWNER_SQL=`EXISTS(SELECT 1 FROM users WHERE telegram_id=? AND accepted_terms=1 AND is_blocked=0)
 AND EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=? AND role='admin' AND status='active')
 AND NOT EXISTS(SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending'
   AND (unixepoch(expires_at) IS NULL OR unixepoch(expires_at)>unixepoch()))
 AND NOT EXISTS(SELECT 1 FROM user_moderation_blocks WHERE target_telegram_id=? AND status='active')`;
const BASE_LEASE_SQL=`EXISTS(SELECT 1 FROM mini_app_release_control WHERE id=1 AND candidate_sha=? AND revision=?
 AND state='closed' AND beta_enabled=0 AND owner_telegram_id IS NULL AND issued_at IS NULL AND expires_at IS NULL)`;
const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/u.test(s);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;};
const hash=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function rows(db,sql,params=[]) {
  const r=await db.prepare(sql).bind(...params).all();
  if(r?.success!==true||!Array.isArray(r.results))fail('v141_release_read_unverified');
  return r.results;
}
async function one(db,sql,params=[]) {
  const r=await rows(db,sql,params);if(r.length!==1)fail('v141_release_read_unverified');return r[0];
}
async function body(request) {
  const reader=request.body?.getReader();if(!reader)fail('v141_release_input_invalid');
  const pieces=[];let size=0,timer;
  try {
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('deadline')),5000);});
    for(;;){const r=await Promise.race([reader.read(),deadline]);if(r.done)break;size+=r.value.length;
      if(size>2048)fail('v141_release_input_invalid');pieces.push(r.value);}
    const value=new Uint8Array(size);let offset=0;for(const part of pieces){value.set(part,offset);offset+=part.length;}
    const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(value));
    if(!result||typeof result!=='object'||Array.isArray(result))fail('v141_release_input_invalid');return result;
  } catch {fail('v141_release_input_invalid');}
  finally {clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
function leaseProjection(lease) {
  return lease===null?null:{candidateSha:lease.candidate_sha,revision:lease.revision,state:lease.state,
    betaEnabled:lease.beta_enabled,ownerAbsent:lease.owner_telegram_id===null,
    issuedAbsent:lease.issued_at===null,expiryAbsent:lease.expires_at===null};
}
function exactClosed(lease,candidate,revision) {
  return lease?.candidate_sha===candidate&&lease.revision===revision&&lease.state==='closed'&&lease.beta_enabled===0&&
    lease.owner_telegram_id===null&&lease.issued_at===null&&lease.expires_at===null;
}
function preparedRevision(env,candidateSha) {
  const parent=env.REBUILD_V140_RC_SHA,revision=Number(env.REBUILD_V140_RELEASE_REVISION);
  if(!sha(parent)||!['26','27','28','29','30','31','32','33','34','35','36'].includes(env.REBUILD_V140_RELEASE_REVISION))return null;
  if(parent===candidateSha&&[27,28,29,30,31,32,33,34,35,36].includes(revision))return revision;
  if(parent===PLAN.acceptedCandidateSha&&revision===PLAN.acceptedRevision&&candidateSha!==parent)return revision+1;
  if(REPAIR_PARENTS.some(frame=>parent===frame.sha&&revision===frame.revision)&&candidateSha!==parent)return revision+1;
  return null;
}
function repairParent(env) {
  return REPAIR_PARENTS.find(frame=>env.REBUILD_V140_RC_SHA===frame.sha&&
    env.REBUILD_V140_RELEASE_REVISION===String(frame.revision))??null;
}
function preparedMarkers(versions) {
  return PLAN.markers.every(marker=>versions.includes(marker))&&
    !versions.some(version=>/v?1\.4\.1|^006[2-5](?:-|$)/iu.test(version)&&!PLAN.markers.includes(version));
}
async function snapshot(db,ownerId) {
  const objects=await rows(db,SCHEMA_SQL+' LIMIT 2001');
  const ledger=await rows(db,LEDGER_SQL+' LIMIT 257');
  if(objects.length>2000||!objects.length||ledger.length>256||!ledger.length||ledger.some(r=>typeof r.version!=='string'))fail('v141_release_metadata_invalid');
  const schemaJson=JSON.stringify(objects.map(r=>[r.type,r.name,r.tbl_name,r.sql])),ledgerJson=JSON.stringify(ledger.map(r=>r.version));
  const owners=await one(db,`SELECT (${OWNER_SQL}) owner_ready`,[ownerId,ownerId,ownerId,ownerId]);
  const leases=await rows(db,'SELECT * FROM mini_app_release_control WHERE id=1');
  if(leases.length>1)fail('v141_release_metadata_invalid');
  return {schemaJson,ledgerJson,versions:ledger.map(r=>r.version),schemaSha256:await hash(schemaJson),ownerReady:owners.owner_ready===1,lease:leases[0]??null};
}
async function readiness(db) {try{return await inspectP04Schema(db);}catch{return {ready:false};}}

// This controller cannot activate customer access. It only observes, prepares
// the exact additive schema, or rotates a fixed recovery lineage while
// the participant surface remains closed.
export function createV141ReleaseControl({clock=()=>Math.floor(Date.now()/1000),allowTestOrigin=false}={}) {
  return async(request,env)=>{
    const url=new URL(request.url);if(url.pathname!==PATH)return null;
    const now=clock(),issued=Number(env.REBUILD_V140_CONTROL_ISSUED_AT),until=Number(env.REBUILD_V140_CONTROL_EXPIRES_AT);
    if(request.method!=='POST'||(!allowTestOrigin&&url.origin!==ORIGIN)||url.search||!Number.isSafeInteger(now)||
      !/^[0-9]{10}$/u.test(env.REBUILD_V140_CONTROL_ISSUED_AT??'')||!/^[0-9]{10}$/u.test(env.REBUILD_V140_CONTROL_EXPIRES_AT??'')||
      !Number.isSafeInteger(issued)||!Number.isSafeInteger(until)||until<=issued||until-issued>1800||issued>now+30||now>=until||
      !/^application\/json(?:\s*;|$)/iu.test(request.headers.get('Content-Type')??''))return new Response('Not found',{status:404});
    const provided=/^Bearer ([A-Za-z0-9_-]{32,128})$/u.exec(request.headers.get('Authorization')??'')?.[1];
    if(!provided||!/^[a-f0-9]{64}$/u.test(env.REBUILD_V140_CONTROL_SECRET_SHA256??'')||
      !equal(await hash(provided),env.REBUILD_V140_CONTROL_SECRET_SHA256))return new Response('Not found',{status:404});
    try {
      const input=await body(request);
      if(Object.keys(input).length!==2||Object.keys(input).some(k=>!['action','candidateSha'].includes(k))||
        !['status','prepare','rotate'].includes(input.action)||!sha(input.candidateSha)||input.candidateSha!==env.V141_SOURCE_SHA)fail('v141_release_input_invalid');
      const ownerId=canonicalCabinetOwnerId(env),botId=Number(String(env.BOT_TOKEN??'').split(':')[0]);
      if(!ownerId||!Number.isSafeInteger(botId)||botId<1||!env.DB?.withSession)fail('v141_release_identity_unavailable');
      const db=env.DB.withSession('first-primary'),before=await snapshot(db,ownerId);
      const mode=env.V141_RELEASE_MODE??'default_off',off=mode==='default_off'&&
        (env.V141_AUTHORIZATION_ENABLED===undefined||env.V141_AUTHORIZATION_ENABLED==='false');
      const base=before.schemaSha256===PLAN.baseDdlSha256&&exactClosed(before.lease,PLAN.acceptedCandidateSha,PLAN.acceptedRevision)&&
        !before.versions.some(version=>/v?1\.4\.1|^006[2-5](?:-|$)/iu.test(version));
      if(input.action==='status') {
        const expectedRevision=preparedRevision(env,input.candidateSha),p04=await readiness(db),
          prepared=p04.ready===true&&before.schemaSha256===PLAN.preparedDdlSha256&&
          expectedRevision!==null&&exactClosed(before.lease,input.candidateSha,expectedRevision)&&preparedMarkers(before.versions);
        return json({ok:true,action:'status',candidateSha:input.candidateSha,mode,phase:prepared?'prepared':base?'accepted_base':'unrecognized',
          canPrepare:off&&base&&before.ownerReady,owner:{eligible:before.ownerReady},lease:leaseProjection(before.lease),
          p04Ready:p04.ready===true,schemaSha256:before.schemaSha256,controllerExpiresAt:until});
      }
      if(input.action==='rotate') {
        if(mode!=='recovery'||env.V141_AUTHORIZATION_ENABLED!=='false'||env.V141_LEGACY_COMPATIBILITY_ENABLED!=='false')fail('v141_release_rotate_mode_invalid');
        const parent=repairParent(env);
        if(!parent||input.candidateSha===parent.sha)fail('v141_release_rotate_parent_invalid');
        if(!before.ownerReady)fail('v141_release_owner_not_ready');
        const p04=await readiness(db);
        if(!p04.ready||before.schemaSha256!==PLAN.preparedDdlSha256||!preparedMarkers(before.versions)||
          !exactClosed(before.lease,parent.sha,parent.revision))fail('v141_release_rotate_baseline_mismatch');
        const initial='v141_rotate_'+crypto.randomUUID(),casGuard=initial+'_cas';
        const statements=[db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN
          ${SCHEMA_SNAPSHOT}=? AND ${LEDGER_SNAPSHOT}=? AND (${OWNER_SQL}) AND (${BASE_LEASE_SQL})
          AND unixepoch()>=?-30 AND unixepoch()<? THEN 1 ELSE 0 END)`)
          .bind(initial,before.schemaJson,before.ledgerJson,ownerId,ownerId,ownerId,ownerId,
            parent.sha,parent.revision,issued,until),
          db.prepare(`UPDATE mini_app_release_control SET candidate_sha=?,revision=?,updated_at=unixepoch()
            WHERE id=1 AND candidate_sha=? AND revision=? AND state='closed' AND beta_enabled=0
            AND owner_telegram_id IS NULL AND issued_at IS NULL AND expires_at IS NULL`)
            .bind(input.candidateSha,parent.revision+1,parent.sha,parent.revision),
          db.prepare('INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)').bind(casGuard),
          db.prepare(REVOKE_RELEASE_SESSIONS_SQL),
          db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key IN (?,?)').bind(initial,casGuard)];
        let committed;
        try {committed=await db.batch(statements);}catch{fail('v141_release_rotate_outcome_unverified');}
        if(!Array.isArray(committed)||committed.length!==5||committed.some(result=>result?.success!==true)||
          committed[0].meta?.changes!==1||committed[1].meta?.changes!==1||committed[2].meta?.changes!==1||
          committed[4].meta?.changes!==2)fail('v141_release_rotate_outcome_unverified');
        const after=await snapshot(db,ownerId),afterP04=await readiness(db);
        const active=await one(db,'SELECT COUNT(*) active_sessions FROM mini_app_sessions WHERE revoked_at IS NULL');
        if(!afterP04.ready||after.schemaSha256!==before.schemaSha256||after.ledgerJson!==before.ledgerJson||
          !exactClosed(after.lease,input.candidateSha,parent.revision+1)||active.active_sessions!==0)fail('v141_release_rotate_outcome_unverified');
        return json({ok:true,action:'rotate',candidateSha:input.candidateSha,mode,phase:'prepared',p04Ready:true,
          schemaSha256:after.schemaSha256,lease:leaseProjection(after.lease),addedTables:0,addedMigrations:0,
          activeSessions:0,statements:5,businessBackfill:0,grantsBackfill:0,rolesChanged:0,financialBackfill:0,
          customerAccessActivated:false});
      }
      if(!off)fail('v141_release_prepare_mode_invalid');
      if(!before.ownerReady)fail('v141_release_owner_not_ready');
      if(!base)fail('v141_release_prepare_baseline_mismatch');
      const initial='v141_prepare_'+crypto.randomUUID(),casGuard=initial+'_cas';
      const statements=[db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN
        ${SCHEMA_SNAPSHOT}=? AND ${LEDGER_SNAPSHOT}=? AND (${OWNER_SQL}) AND (${BASE_LEASE_SQL})
        AND unixepoch()>=?-30 AND unixepoch()<? THEN 1 ELSE 0 END)`)
        .bind(initial,before.schemaJson,before.ledgerJson,ownerId,ownerId,ownerId,ownerId,
          PLAN.acceptedCandidateSha,PLAN.acceptedRevision,issued,until),...PLAN.statements.map(sql=>db.prepare(sql))];
      const casIndex=statements.length;
      statements.push(db.prepare(`UPDATE mini_app_release_control SET candidate_sha=?,revision=?,state='closed',beta_enabled=0,
        owner_telegram_id=NULL,issued_at=NULL,expires_at=NULL,updated_at=unixepoch() WHERE id=1 AND candidate_sha=? AND revision=?
        AND state='closed' AND beta_enabled=0 AND owner_telegram_id IS NULL AND issued_at IS NULL AND expires_at IS NULL`)
        .bind(input.candidateSha,PLAN.acceptedRevision+1,PLAN.acceptedCandidateSha,PLAN.acceptedRevision),
        db.prepare('INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)').bind(casGuard),
        db.prepare(REVOKE_RELEASE_SESSIONS_SQL),db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key IN (?,?)').bind(initial,casGuard));
      let committed;
      try {committed=await db.batch(statements);}catch{fail('v141_release_prepare_outcome_unverified');}
      if(!Array.isArray(committed)||committed.length!==statements.length||committed.some(r=>r?.success!==true)||
        committed[0].meta?.changes!==1||committed[casIndex].meta?.changes!==1||committed[casIndex+1].meta?.changes!==1||
        committed.at(-1).meta?.changes!==2)fail('v141_release_prepare_outcome_unverified');
      const after=await snapshot(db,ownerId),p04=await readiness(db);
      const expected=[...new Set([...before.versions,...PLAN.markers])].sort();
      const counts=await one(db,`SELECT (SELECT COUNT(*) FROM capability_catalog) capability_rows,
        (SELECT COUNT(*) FROM plan_capabilities) plan_rows,
        (SELECT COUNT(*) FROM mini_app_sessions WHERE revoked_at IS NULL) active_sessions`);
      if(!p04.ready||after.schemaSha256!==PLAN.preparedDdlSha256||!exactClosed(after.lease,input.candidateSha,PLAN.acceptedRevision+1)||
        JSON.stringify(after.versions)!==JSON.stringify(expected)||counts.capability_rows!==PLAN.capabilityRows||
        counts.plan_rows!==PLAN.planRows||counts.active_sessions!==0)fail('v141_release_prepare_outcome_unverified');
      return json({ok:true,action:'prepare',candidateSha:input.candidateSha,mode,phase:'prepared',p04Ready:true,
        schemaSha256:after.schemaSha256,lease:leaseProjection(after.lease),addedTables:PLAN.addedTables,addedMigrations:PLAN.addedMigrations,
        capabilityRows:counts.capability_rows,planRows:counts.plan_rows,activeSessions:0,statements:statements.length,businessBackfill:0,
        grantsBackfill:0,rolesChanged:0,financialBackfill:0,customerAccessActivated:false});
    } catch(error) {
      const code=/^v141_release_[a-z0-9_]+$/u.test(error?.code??'')?error.code:'v141_release_action_unverified';
      return json({ok:false,code,retrySafe:false,observeAction:'status'},
        ['v141_release_prepare_outcome_unverified','v141_release_rotate_outcome_unverified'].includes(code)?503:409);
    }
  };
}
