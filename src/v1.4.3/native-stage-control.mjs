import {REVOKE_RELEASE_SESSIONS_SQL} from '../v1.4.0-rebuild/release-lease.mjs';
import {canonicalCabinetOwnerId} from '../v1.4.0-rebuild/cabinet-participants.mjs';
import {buildReadinessRetainedQueries} from './readiness-retained-query.mjs';

export const NATIVE_STAGE_CONTROL_PATH='/__rebuild/v1.4.3/native-stage';
export const V143_NATIVE_STAGE_CONFIG_GLOBAL='__RE_PROGRAM_V143_NATIVE_STAGE_CONFIG__';
export const V143_NATIVE_STAGE_FRAME=Object.freeze({
 versionHostSuffix:'-re-program-bot.markakula4.workers.dev',
 parentReceiptSha256:'2c352f3d82389b28b64728abee5700e8f91f0c88971a4c5cc77139e5a39aa704',parentReceiptBytes:960717,
 parentSourceSha:'164e79ec300b10e22f1c3bd4663f81b82ccbe6ab',parentSourceTree:'a9a0302369f76cae27a253cde649fa408a9872db',
 parentMainVersionId:'d261d15e-3c4d-4403-9c7f-0fef1ccb7272',parentMainDeploymentId:'36acaaf5-0a77-47c9-886f-e0193af6d29b',
 parentSupportVersionId:'7c1a0268-7895-4a55-bf9a-19147698246f',parentSupportDeploymentId:'aee953d5-7791-47ef-932f-053b6aa54f2e',
 parentLeaseSourceSha:'82b3650632563788c4c1053e8801adebe7062918',parentRevision:39,preparedRevision:40,parentLeaseUpdatedAt:1791187071,
 schemaSha256:'b1e4d7d80f33a7f58cd2ef74c8950d869d8fde1ede69a882ed0f5a4d9614a540',
 ledgerSha256:'a7021a761aae8db54301b7a4142354a9967cddf2eee4a4352085d47cfb551a78',
 objectCount:1149,tableCount:257,ownerId:8987576334,botId:8562951985,
 recurringEnabled:false,paidNotificationsEnabled:false
});
const FRAME=V143_NATIVE_STAGE_FRAME,fields=['version',...Object.keys(FRAME),'candidateSha','issuedAt','expiresAt','tokenSha256','backupReceiptSha256','retainedRowsSha256'];
const fail=code=>{throw Object.assign(new Error('native_stage_'+code),{code:'native_stage_'+code});};
const hex=(value,n)=>typeof value==='string'&&new RegExp('^[a-f0-9]{'+n+'}$','u').test(value);
function data(value,frozen=false){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||frozen&&!Object.isFrozen(value))fail('config_invalid');
 for(const key of Reflect.ownKeys(value))if(typeof key!=='string'||(!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value')||frozen&&Object.getOwnPropertyDescriptor(value,key).enumerable!==true))fail('config_invalid');
 return value;
}
export function validateV143NativeStageConfig(value){
 data(value,true);
 const keys=Reflect.ownKeys(value);
 if(keys.length!==fields.length||keys.some(k=>!fields.includes(k))||value.version!=='1.4.3'||
   Object.entries(FRAME).some(([k,v])=>value[k]!==v)||!hex(value.candidateSha,40)||
   [FRAME.parentLeaseSourceSha,FRAME.parentSourceSha].includes(value.candidateSha)||
   !hex(value.tokenSha256,64)||!hex(value.backupReceiptSha256,64)||!hex(value.retainedRowsSha256,64)||
   !Number.isSafeInteger(value.issuedAt)||!Number.isSafeInteger(value.expiresAt)||value.issuedAt<1000000000||
   value.expiresAt<=value.issuedAt||value.expiresAt-value.issuedAt>1800)fail('config_invalid');
 return value;
}
export function readV143NativeStageConfig(...args){
 if(args.length)fail('config_invalid');
 const d=Object.getOwnPropertyDescriptor(globalThis,V143_NATIVE_STAGE_CONFIG_GLOBAL);
 if(!d)return null;
 if(!Object.hasOwn(d,'value')||d.writable!==false||d.configurable!==false)fail('config_invalid');
 return validateV143NativeStageConfig(d.value);
}
const encoder=new TextEncoder(),bytes=value=>encoder.encode(value).byteLength;
const sha=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;};
async function reply(value,status,token){
 const body=JSON.stringify(value),key=await crypto.subtle.importKey('raw',encoder.encode(token),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=[...new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(body)))].map(v=>v.toString(16).padStart(2,'0')).join('');
 return new Response(body,{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Native-Stage-Signature':signature}});
}
const SCHEMA_SQL="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name";
const LEDGER_SQL='SELECT version FROM re_schema_migrations ORDER BY version';
const snapshot=sql=>`(SELECT json_group_array(${sql===SCHEMA_SQL?'json_array(type,name,tbl_name,sql)':'version'}) FROM (${sql}))`;
const OWNER_SQL=`EXISTS(SELECT 1 FROM users WHERE telegram_id=? AND accepted_terms=1 AND is_blocked=0)
 AND EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=? AND role='admin' AND status='active')
 AND NOT EXISTS(SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending' AND (unixepoch(expires_at) IS NULL OR unixepoch(expires_at)>unixepoch()))
 AND NOT EXISTS(SELECT 1 FROM user_moderation_blocks WHERE target_telegram_id=? AND status='active')`;
const LEASE_SQL="id=1 AND candidate_sha=? AND revision=39 AND updated_at=? AND state='closed' AND beta_enabled=0 AND owner_telegram_id IS NULL AND issued_at IS NULL AND expires_at IS NULL";
function statement(db,sql,params=[]){
 if(params.length>100||bytes(sql)>100000||params.some(v=>typeof v==='string'&&bytes(v)>=2*1024*1024))fail('d1_limit');
 return db.prepare(sql).bind(...params);
}
async function rows(db,sql,params=[]){const r=await statement(db,sql,params).all();if(r?.success!==true||!Array.isArray(r.results))fail('read_unverified');return r.results;}
async function metadata(db){
 const schema=await rows(db,SCHEMA_SQL+' LIMIT 1150'),ledger=await rows(db,LEDGER_SQL+' LIMIT 257');
 const lease=await rows(db,'SELECT * FROM mini_app_release_control WHERE id=1');
 if(schema.length>1149||ledger.length>256||lease.length!==1)fail('metadata_unverified');
 const schemaJson=JSON.stringify(schema.map(r=>[r.type,r.name,r.tbl_name,r.sql])),ledgerJson=JSON.stringify(ledger.map(r=>r.version));
 const owner=FRAME.ownerId,eligibility=await rows(db,`SELECT (${OWNER_SQL}) ready`,[owner,owner,owner,owner]);
 return {schemaJson,ledgerJson,schemaSha256:await sha(schemaJson),ledgerSha256:await sha(ledgerJson),
  objectCount:schema.length,tableCount:schema.filter(r=>r.type==='table').length,lease:lease[0],ownerReady:eligibility.length===1&&eligibility[0].ready===1};
}
const closed=(lease,candidate,revision,updated)=>lease.candidate_sha===candidate&&lease.revision===revision&&lease.state==='closed'&&lease.beta_enabled===0&&
 lease.owner_telegram_id===null&&lease.issued_at===null&&lease.expires_at===null&&(updated===undefined||lease.updated_at===updated);
const exact=m=>m.schemaSha256===FRAME.schemaSha256&&m.ledgerSha256===FRAME.ledgerSha256&&m.objectCount===FRAME.objectCount&&m.tableCount===FRAME.tableCount;
const leaseDTO=l=>({candidateSha:l.candidate_sha,revision:l.revision,state:l.state,betaEnabled:l.beta_enabled,
 ownerAbsent:l.owner_telegram_id===null,issuedAbsent:l.issued_at===null,expiryAbsent:l.expires_at===null,updatedAt:l.updated_at});
async function retained(db){
 const {entries,combined}=buildReadinessRetainedQueries(),result=await rows(db,combined),assertions=[],proof=[];
 if(entries.length!==20||result.length!==20)fail('retained_unverified');let total=0;
 for(const [i,{table,sql}]of entries.entries()){
  const {table_name:name,value}=result[i];if(name!==table||typeof value!=='string'||bytes(value)>=2*1024*1024||(total+=bytes(value))>8*1024*1024)fail('retained_limit');
  let parsed;try{parsed=JSON.parse(value);}catch{fail('retained_unverified');}
  if(!Array.isArray(parsed)||parsed.length>16384)fail('retained_limit');
  assertions.push({sql:`(${sql}) IS ?`,params:[value]});proof.push([table,parsed.length,await sha(value)]);
 }
 return {sha256:await sha(JSON.stringify(proof)),assertions};
}
async function input(request){
 const reader=request.body?.getReader();if(!reader)fail('input_invalid');let timer,total=0;const chunks=[];
 try{const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('deadline')),5000);});
  for(;;){const result=await Promise.race([reader.read(),deadline]);if(result.done)break;if((total+=result.value.length)>256)fail('input_invalid');chunks.push(result.value);}
  const buffer=new Uint8Array(total);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length;}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));data(value);
  if(Object.keys(value).length!==1||!['status','prepare','quota_probe'].includes(value.action))fail('input_invalid');return value;
 }catch{fail('input_invalid');}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
// Optional only in one OFF staging Main. A final readiness/recovery/checkout
// bundle has no capsule and therefore cannot acquire this capability.
export function createNativeStageControl({clock=()=>Math.floor(Date.now()/1000)}={}){
 return async(request,env)=>{
  const url=new URL(request.url);if(url.pathname!==NATIVE_STAGE_CONTROL_PATH)return null;
  let config;try{config=readV143NativeStageConfig();if(!config)return new Response('Not found',{status:404});data(env);}catch{return new Response('Not found',{status:404});}
  const token=/^Bearer ([A-Za-z0-9_-]{32,128})$/u.exec(request.headers.get('Authorization')??'')?.[1],now=clock();
  if(request.method!=='POST'||url.search||url.hash||url.protocol!=='https:'||url.port||
   !/^[a-f0-9]{8}-re-program-bot\.markakula4\.workers\.dev$/u.test(url.hostname)||
   !/^application\/json(?:\s*;|$)/iu.test(request.headers.get('Content-Type')??'')||!Number.isSafeInteger(now)||
   now<config.issuedAt-30||now>=config.expiresAt||!token||!equal(await sha(token),config.tokenSha256))return new Response('Not found',{status:404});
  let requestAction=null;
  try{
   const {action}=await input(request);requestAction=action;
   if(!['string','number'].includes(typeof env.ADMIN_ID)||env.OWNER_TELEGRAM_ID!==undefined&&!['string','number'].includes(typeof env.OWNER_TELEGRAM_ID)||
    canonicalCabinetOwnerId(env)!==config.ownerId||typeof env.BOT_TOKEN!=='string'||env.BOT_TOKEN.split(':')[0]!==String(config.botId)||
    !env.DB?.withSession)fail('runtime_unverified');
   const db=env.DB.withSession('first-primary'),before=await metadata(db),base=exact(before)&&closed(before.lease,config.parentLeaseSourceSha,39,config.parentLeaseUpdatedAt),
    prepared=exact(before)&&closed(before.lease,config.candidateSha,40),dataBefore=base||prepared?await retained(db):null,baselineRetainedMatches=dataBefore?.sha256===config.retainedRowsSha256;
   const status={ok:true,action,candidateSha:config.candidateSha,phase:prepared?'prepared':base?'accepted_base':'unrecognized',canPrepare:base&&before.ownerReady&&baselineRetainedMatches,baselineRetainedMatches,
    schemaSha256:before.schemaSha256,ledgerSha256:before.ledgerSha256,lease:leaseDTO(before.lease),owner:{eligible:before.ownerReady},
    retainedRowsSha256:dataBefore?.sha256??null,retainedTables:dataBefore?20:0,backupReceiptSha256:config.backupReceiptSha256,
    recurringEnabled:false,paidNotificationsEnabled:false,customerAccessActivated:false,
    physicalReadiness:{paymentEnabled:env.STARS_PAYMENTS_ENABLED==='true',recurringEnabled:env.STARS_RECURRING_ENABLED==='true',
     ownerIdentityMatches:canonicalCabinetOwnerId(env)===config.ownerId,botIdentityMatches:env.BOT_TOKEN.split(':')[0]===String(config.botId),
     invoiceSecretReady:typeof env.STARS_INVOICE_SECRET==='string'&&env.STARS_INVOICE_SECRET.length>=32,
     rolloutAdmin:env.STARS_ROLLOUT_MODE==='admin',priceVersionReady:env.STARS_RECURRING_PRICE_VERSION==='1',
     termsRevisionReady:env.STARS_RECURRING_TERMS_REVISION==='2026-10-03.stars-recurring-v1'}};
   if(action==='status')return reply(status,200,token);
   // A separately requested, read-only runtime quota measurement. This is
   // deliberately above50 D1 calls and never runs for prepare or status.
   if(action==='quota_probe'){
    if(!base||!before.ownerReady||!baselineRetainedMatches)fail('quota_probe_unverified');
    let successfulReadInvocations=0;
    try{
     for(let i=0;i<500;i++){
      const probe=await rows(db,'SELECT 1 AS native_quota_probe');
      if(probe.length!==1||probe[0].native_quota_probe!==1)fail('quota_probe_unverified');
      successfulReadInvocations++;
     }
     const after=await metadata(db),preserved=await retained(db);
     if(JSON.stringify(after)!==JSON.stringify(before)||preserved.sha256!==dataBefore.sha256)fail('quota_probe_unverified');
    }catch{fail('quota_probe_unverified');}
    return reply({...status,quotaProbeVerified:true,successfulReadInvocations,databaseWrites:0,paymentAuthorized:false,baselineUnchanged:true},200,token);
   }
   if(!baselineRetainedMatches)fail('retained_baseline_mismatch');
   if(prepared)return reply({...status,noOp:true,statements:0},200,token);
   if(!base||!before.ownerReady)fail('baseline_mismatch');
   const owner=config.ownerId,key='native40_'+crypto.randomUUID();
   const assertions=[{sql:`${snapshot(SCHEMA_SQL)}=? AND ${snapshot(LEDGER_SQL)}=? AND (${OWNER_SQL}) AND EXISTS(SELECT 1 FROM mini_app_release_control WHERE ${LEASE_SQL}) AND unixepoch()>=?-30 AND unixepoch()<?`,
    params:[before.schemaJson,before.ledgerJson,owner,owner,owner,owner,config.parentLeaseSourceSha,config.parentLeaseUpdatedAt,config.issuedAt,config.expiresAt]},...dataBefore.assertions];
   const keys=assertions.map((_,i)=>key+'_'+i),cas=key+'_cas';
   const statements=[statement(db,'INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES '+assertions.map(a=>`(?,CASE WHEN (${a.sql}) THEN 1 ELSE 0 END)`).join(','),assertions.flatMap((a,i)=>[keys[i],...a.params])),
    statement(db,`UPDATE mini_app_release_control SET candidate_sha=?,revision=40,updated_at=unixepoch() WHERE ${LEASE_SQL}`,[config.candidateSha,config.parentLeaseSourceSha,config.parentLeaseUpdatedAt]),
    statement(db,'INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)',[cas]),
    statement(db,REVOKE_RELEASE_SESSIONS_SQL),statement(db,'DELETE FROM mini_app_atomic_guards WHERE guard_key IN ('+[...keys,cas].map(()=>'?').join(',')+')',[...keys,cas])];
   let results;try{results=await db.batch(statements);}catch{fail('outcome_unverified');}
   if(!Array.isArray(results)||results.length!==5||results.some(r=>r?.success!==true)||results[1].meta?.changes!==1||results[2].meta?.changes!==1)fail('outcome_unverified');
   const after=await metadata(db),preserved=await retained(db),sessions=await rows(db,'SELECT COUNT(*) n FROM mini_app_sessions WHERE revoked_at IS NULL');
   if(!exact(after)||!closed(after.lease,config.candidateSha,40)||!after.ownerReady||preserved.sha256!==dataBefore.sha256||sessions.length!==1||sessions[0].n!==0)fail('outcome_unverified');
   return reply({...status,phase:'prepared',canPrepare:false,lease:leaseDTO(after.lease),statements:5,activeSessions:0,retainedRowsUnchanged:true},200,token);
  }catch(error){const code=requestAction==='quota_probe'?'native_stage_quota_probe_unverified':/^native_stage_[a-z0-9_]+$/u.test(error?.code??'')?error.code:'native_stage_unverified';
   return reply({ok:false,code,retrySafe:false,observeAction:'status'},['native_stage_outcome_unverified','native_stage_quota_probe_unverified'].includes(code)?503:409,token);}
 };
}

export function v143NativeStageWebhookFence(request){
 if(readV143NativeStageConfig()&&request.method==='POST'&&new URL(request.url).pathname==='/webhook')
  return new Response('Native staging inactive',{status:503,headers:{'Cache-Control':'no-store','Retry-After':'5'}});
 return null;
}
