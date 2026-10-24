import {V143_READINESS_INSTALL_PLAN as PLAN} from './readiness-install-plan.mjs';
import {readReadinessInstallConfig,assertReadinessInstallMode} from './readiness-install-config.mjs';
import {canonicalCabinetOwnerId} from '../v1.4.0-rebuild/cabinet-participants.mjs';
import {REVOKE_RELEASE_SESSIONS_SQL} from '../v1.4.0-rebuild/release-lease.mjs';
import {buildReadinessRetainedQueries} from './readiness-retained-query.mjs';

export const READINESS_INSTALL_CONTROL_PATH='/__rebuild/v1.4.3/readiness-install';
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
// These rows are compared inside the DDL batch and after COMMIT. They never
// leave the Worker; the response contains only their aggregate digest/counts.
const retainedTables=Object.freeze(['payment_ledger','payment_refunds','subscription_orders','subscriptions',
 'subscription_access_grants','subscription_billing_contracts','subscription_payment_links','subscription_first_recurring_receipts',
 'subscription_provider_events','subscription_provider_commands','subscription_invoice_requests',
 'subscription_payment_review_receipts','subscription_payment_review_settlements','payment_review_resolutions',
 'paid_subscription_notification_jobs','user_plans','user_access_states','user_access','terms_acceptances','price_book']);
const fail=code=>{throw Object.assign(new Error('readiness_install_'+code),{code:'readiness_install_'+code});};
const diagnosticStages=new Set(['input','identity','runtime','metadata_schema','metadata_ledger','metadata_lease','metadata_owner',
 'retained_read','retained_parse','prepare_batch','postcondition']);
const errorCategories=new Set(['D1_ERROR','D1_TYPE_ERROR','Error','TypeError','RangeError','unknown']);
function errorCategory(error){
 for(let current=error,depth=0;current&&typeof current==='object'&&depth<3;current=current.cause,depth++){
  const prefix=/^(D1_ERROR|D1_TYPE_ERROR):/u.exec(typeof current.message==='string'?current.message:'')?.[1];
  if(prefix)return prefix;
 }
 return ['Error','TypeError','RangeError'].includes(error?.name)?error.name:'unknown';
}
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;
  let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;};
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function rows(db,sql,params=[]){const r=await db.prepare(sql).bind(...params).all();
  if(r?.success!==true||!Array.isArray(r.results))fail('read_unverified');return r.results;}
async function one(db,sql,params=[]){const r=await rows(db,sql,params);if(r.length!==1)fail('read_unverified');return r[0];}
const closed=(lease,sha,revision)=>lease?.candidate_sha===sha&&lease.revision===revision&&lease.state==='closed'&&lease.beta_enabled===0&&
  lease.owner_telegram_id===null&&lease.issued_at===null&&lease.expires_at===null;
const leaseDTO=lease=>lease?{candidateSha:lease.candidate_sha,revision:lease.revision,state:lease.state,betaEnabled:lease.beta_enabled,
  ownerAbsent:lease.owner_telegram_id===null,issuedAbsent:lease.issued_at===null,expiryAbsent:lease.expires_at===null}:null;
async function metadata(db,owner,diagnostic){
  diagnostic.stage='metadata_schema';const schema=await rows(db,SCHEMA_SQL+' LIMIT 2001');
  diagnostic.stage='metadata_ledger';const ledger=await rows(db,LEDGER_SQL+' LIMIT 257');
  diagnostic.stage='metadata_lease';const leases=await rows(db,'SELECT * FROM mini_app_release_control WHERE id=1');
  if(!schema.length||schema.length>2000||!ledger.length||ledger.length>256||leases.length!==1||ledger.some(r=>typeof r.version!=='string'))fail('metadata_invalid');
  const schemaJson=JSON.stringify(schema.map(r=>[r.type,r.name,r.tbl_name,r.sql])),ledgerJson=JSON.stringify(ledger.map(r=>r.version));
  diagnostic.stage='metadata_owner';
  return {schemaJson,ledgerJson,schemaSha256:await hash(schemaJson),ledgerSha256:await hash(ledgerJson),versions:ledger.map(r=>r.version),
    objectCount:schema.length,tableCount:schema.filter(r=>r.type==='table').length,lease:leases[0],
    ownerReady:(await one(db,`SELECT (${OWNER_SQL}) ready`,[owner,owner,owner,owner])).ready===1};
}
async function retained(db,diagnostic){
  diagnostic.stage='retained_read';
  const proofs=[],values=[];let totalBytes=0;
  if(JSON.stringify(Object.keys(PLAN.retainedColumns??{}))!==JSON.stringify(retainedTables))fail('retained_columns_unverified');
  for(const table of retainedTables){
    const columns=PLAN.retainedColumns[table];
    if(!Array.isArray(columns)||!columns.length||columns.length>128||columns.some(v=>typeof v!=='string'||!v.length))fail('retained_rows_unavailable');
  }
  const {entries:queries,combined}=buildReadinessRetainedQueries();
  // One call returns20 separate bounded rows, avoiding D1's2MB row limit
  // for an aggregate row containing the entire financial history.
  const result=await rows(db,combined);
  if(result.length!==queries.length||result.some((row,i)=>row.table_name!==queries[i].table))fail('retained_rows_unavailable');
  diagnostic.stage='retained_parse';
  for(const [i,{table,sql}]of queries.entries()){
    const value=result[i].value;
    if(typeof value!=='string'||value.length>1024*1024)fail('retained_rows_limit');
    let parsed;try{parsed=JSON.parse(value);}catch{fail('retained_rows_unavailable');}
    if(!Array.isArray(parsed)||parsed.length>16384||(totalBytes+=value.length)>8*1024*1024)fail('retained_rows_limit');
    proofs.push({sql:`(${sql}) IS ?`,params:[value]});values.push([table,parsed.length,await hash(value)]);
  }
  return {assertions:proofs,sha256:await hash(JSON.stringify(values)),tableCount:values.length};
}

async function body(request){
  const reader=request.body?.getReader();if(!reader)fail('input_invalid');let timer,size=0;const chunks=[];
  try{const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('deadline')),5000);});
    for(;;){const r=await Promise.race([reader.read(),deadline]);if(r.done)break;
      if((size+=r.value.length)>2048)fail('input_invalid');chunks.push(r.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!value||typeof value!=='object'||Array.isArray(value))fail('input_invalid');return value;
  }catch{fail('input_invalid');}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}

// Only a compiled source/bundle that follows verified backup collection exposes
// this short-lived capability. There is no financial transport or SQL input.
export function createReadinessInstallControl({clock=()=>Math.floor(Date.now()/1000),allowTestOrigin=false,installConfig,releaseConfig}={}){
  return async(request,env)=>{
    const url=new URL(request.url);if(url.pathname!==READINESS_INSTALL_CONTROL_PATH)return null;
    let config;try{config=readReadinessInstallConfig(installConfig);if(!config)return new Response('Not found',{status:404});
      assertReadinessInstallMode(config,releaseConfig);}catch{return new Response('Not found',{status:404});}
    const now=clock(),issued=Number(env.REBUILD_V140_CONTROL_ISSUED_AT),until=Number(env.REBUILD_V140_CONTROL_EXPIRES_AT);
    const token=/^Bearer ([A-Za-z0-9_-]{32,128})$/u.exec(request.headers.get('Authorization')??'')?.[1];
    if(request.method!=='POST'||url.search||url.hash||(!allowTestOrigin&&url.origin!==ORIGIN)||
      !/^application\/json(?:\s*;|$)/iu.test(request.headers.get('Content-Type')??'')||
      !Number.isSafeInteger(now)||!Number.isSafeInteger(issued)||!Number.isSafeInteger(until)||
      !/^[0-9]{10}$/u.test(env.REBUILD_V140_CONTROL_ISSUED_AT??'')||!/^[0-9]{10}$/u.test(env.REBUILD_V140_CONTROL_EXPIRES_AT??'')||
      issued>now+30||now>=until||until<=issued||until-issued>1800||!token||
      !/^[a-f0-9]{64}$/u.test(env.REBUILD_V140_CONTROL_SECRET_SHA256??'')||!equal(await hash(token),env.REBUILD_V140_CONTROL_SECRET_SHA256))
      return new Response('Not found',{status:404});
    const diagnostic={stage:'input',category:null};
    try{
      const input=await body(request);
      if(Object.keys(input).length!==2||!['status','prepare'].includes(input.action)||input.candidateSha!==config.candidateSha||
        Object.keys(input).some(k=>!['action','candidateSha'].includes(k)))fail('input_invalid');
      diagnostic.stage='identity';
      const owner=canonicalCabinetOwnerId(env),bot=Number(String(env.BOT_TOKEN??'').split(':')[0]);
      if(owner!==config.ownerId||bot!==config.botId||env.REBUILD_V140_BOT_ID!==String(config.botId)||!env.DB?.withSession)fail('identity_unavailable');
      diagnostic.stage='runtime';
      const staging=config.stage==='prepare'&&env.REBUILD_V140_RC_SHA===config.parentSourceSha&&env.REBUILD_V140_RELEASE_REVISION===String(config.parentRevision);
      const final=config.stage!=='prepare'&&env.REBUILD_V140_RC_SHA===config.candidateSha&&env.REBUILD_V140_RELEASE_REVISION===String(config.preparedRevision);
      if(!staging&&!final)fail('runtime_frame_unverified');
      const db=env.DB.withSession('first-primary'),before=await metadata(db,owner,diagnostic);
      const base=before.schemaSha256===PLAN.baselineDdlSha256&&before.ledgerSha256===PLAN.baselineLedgerSha256&&
        before.objectCount===PLAN.objectCounts.baseline&&before.tableCount===PLAN.tableCounts.baseline&&closed(before.lease,config.parentSourceSha,38);
      const prepared=before.schemaSha256===PLAN.preparedDdlSha256&&before.ledgerSha256===PLAN.preparedLedgerSha256&&
        before.objectCount===PLAN.objectCounts.prepared&&before.tableCount===PLAN.tableCounts.prepared&&closed(before.lease,config.candidateSha,39);
      const status=()=>({ok:true,candidateSha:config.candidateSha,stage:config.stage,phase:prepared?'prepared':base?'accepted_base':'unrecognized',
        canPrepare:staging&&base&&before.ownerReady,owner:{eligible:before.ownerReady},schemaSha256:before.schemaSha256,
        ledgerSha256:before.ledgerSha256,lease:leaseDTO(before.lease),lifecycleReady:prepared,recurringEnabled:false,
        paidNotificationsEnabled:false,backupReceiptSha256:config.backupReceiptSha256,customerAccessActivated:false});
      if(input.action==='status'){const snapshot=(base||prepared)?await retained(db,diagnostic):null;
        return json({...status(),action:'status',retainedRowsSha256:snapshot?.sha256??null,retainedTables:snapshot?.tableCount??0});}
      if(!before.ownerReady)fail('owner_not_ready');
      if(prepared)return json({...status(),action:'prepare',noOp:true,addedMigrations:0,statements:0});
      if(!staging||!base)fail('baseline_mismatch');
      const data=await retained(db,diagnostic),key='readiness_'+crypto.randomUUID(),cas=key+'_cas';
      const assertions=[{sql:`${SCHEMA_SNAPSHOT}=? AND ${LEDGER_SNAPSHOT}=? AND (${OWNER_SQL}) AND (${LEASE_SQL})
        AND unixepoch()>=?-30 AND unixepoch()<?`,params:[before.schemaJson,before.ledgerJson,owner,owner,owner,owner,
          config.parentSourceSha,38,issued,until]},...data.assertions];
      const keys=assertions.map((_,i)=>key+'_'+i);
      //21 CHECK-fenced rows in one statement keep the complete invocation
      // below Free D1's50-query limit, even counting individual batch SQL.
      const statements=[db.prepare('INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES '+
        assertions.map(p=>`(?,CASE WHEN (${p.sql}) THEN 1 ELSE 0 END)`).join(','))
        .bind(...assertions.flatMap((p,i)=>[keys[i],...p.params]))];
      statements.push(...PLAN.statements.map(sql=>db.prepare(sql)));
      const casIndex=statements.length;
      const cleanupKeys=keys.concat(cas);
      statements.push(db.prepare(`UPDATE mini_app_release_control SET candidate_sha=?,revision=39,updated_at=unixepoch()
        WHERE id=1 AND candidate_sha=? AND revision=38 AND state='closed' AND beta_enabled=0
        AND owner_telegram_id IS NULL AND issued_at IS NULL AND expires_at IS NULL`).bind(config.candidateSha,config.parentSourceSha),
        db.prepare('INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)').bind(cas),
        db.prepare(REVOKE_RELEASE_SESSIONS_SQL),db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key IN ('+
          cleanupKeys.map(()=>'?').join(',')+')').bind(...cleanupKeys));

      diagnostic.stage='prepare_batch';
      let results;try{results=await db.batch(statements);}catch(error){diagnostic.category=errorCategory(error);fail('outcome_unverified');}
      if(!Array.isArray(results)||results.length!==statements.length||results.some(r=>r?.success!==true)||
        results[casIndex].meta?.changes!==1||results[casIndex+1].meta?.changes!==1)fail('outcome_unverified');
      const after=await metadata(db,owner,diagnostic),preserved=await retained(db,diagnostic);
      diagnostic.stage='postcondition';const sessions=await one(db,'SELECT COUNT(*) n FROM mini_app_sessions WHERE revoked_at IS NULL');
      if(after.schemaSha256!==PLAN.preparedDdlSha256||after.ledgerSha256!==PLAN.preparedLedgerSha256||
        after.objectCount!==PLAN.objectCounts.prepared||after.tableCount!==PLAN.tableCounts.prepared||
        !closed(after.lease,config.candidateSha,39)||preserved.sha256!==data.sha256||sessions.n!==0||
        (await one(db,'SELECT COUNT(*) n FROM subscription_refund_cancellations')).n!==0)fail('outcome_unverified');
      return json({ok:true,action:'prepare',candidateSha:config.candidateSha,stage:config.stage,phase:'prepared',lifecycleReady:true,
        schemaSha256:after.schemaSha256,ledgerSha256:after.ledgerSha256,lease:leaseDTO(after.lease),addedMigrations:3,
        addedTables:1,statements:statements.length,activeSessions:0,retainedRowsUnchanged:true,retainedRowsSha256:data.sha256,
        retainedTables:data.tableCount,recurringEnabled:false,paidNotificationsEnabled:false,customerAccessActivated:false,
        backupReceiptSha256:config.backupReceiptSha256});
    }catch(error){const code=/^readiness_install_[a-z0-9_]+$/u.test(error?.code??'')?error.code:'readiness_install_unverified';
      const diagnosticStage=diagnosticStages.has(diagnostic.stage)?diagnostic.stage:'input',category=diagnostic.category??errorCategory(error);
      return json({ok:false,code,retrySafe:false,observeAction:'status',diagnosticStage,
        errorCategory:errorCategories.has(category)?category:'unknown'},code==='readiness_install_outcome_unverified'?503:409);}
  };
}
