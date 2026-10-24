import worker from '../../src/v1.4.0-rebuild/worker-entrypoint.mjs';

// Only an isolated, explicitly marked fixture may seed these fictional actors.
// The caller supplies reviewed DDL, the exact catalog, and 1000 synthetic users.
export const P05_HTTP_FIXTURE_MARKER='v1.4.1-p05-synthetic-isolated';
const PROFILE_ID=920202;
const check=(condition,code)=>{if(!condition)throw new Error('p05_http_'+code);};
const encoder=new TextEncoder();
const hmac=async(key,message)=>{
  const imported=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC',imported,encoder.encode(message)));
};
async function signedInitData(actor,botToken) {
  const fields={auth_date:String(Math.floor(Date.now()/1000)),query_id:'p05_'+crypto.randomUUID(),
    user:JSON.stringify({id:actor,first_name:'Synthetic P05'})};
  const text=Object.entries(fields).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>key+'='+value).join('\n');
  const secret=await hmac(encoder.encode('WebAppData'),botToken);
  const bytes=await hmac(secret,text);
  const hash=[...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  return new URLSearchParams({...fields,hash}).toString();
}

// Count executions without replacing native D1 statement/batch behavior. Each
// request gets its own counters, including all same-batch proof statements.
function countedBinding(native,counts) {
  const statements=new WeakMap();
  const statement=actual=>{
    const wrapped={
      bind(...values){return statement(actual.bind(...values));},
      async first(...args){counts.queries++;return actual.first(...args);},
      async all(...args){counts.queries++;return actual.all(...args);},
      async run(...args){counts.queries++;return actual.run(...args);},
      async raw(...args){counts.queries++;return actual.raw(...args);},
    };
    statements.set(wrapped,actual);return wrapped;
  };
  const wrapper={
    prepare(sql){return statement(native.prepare(sql));},
    async batch(items){
      check(Array.isArray(items)&&items.length<=96,'batch_bound');
      counts.queries+=items.length;counts.batches++;counts.maxBatch=Math.max(counts.maxBatch,items.length);
      return native.batch(items.map(item=>{check(statements.has(item),'foreign_statement');return statements.get(item);}));
    },
    withSession(mode){return countedBinding(native.withSession(mode),counts);},
  };
  if(typeof native.getBookmark==='function')wrapper.getBookmark=()=>native.getBookmark();
  return wrapper;
}

export async function runP05HttpScenarios({binding,env}) {
  check(env?.V141_P05_ISOLATED_PROBE==='true'&&env.V141_P05_FIXTURE_MARKER===P05_HTTP_FIXTURE_MARKER,
    'isolated_marker_required');
  check(env.V141_AUTHORIZATION_ENABLED==='true'&&env.ADMIN_ID==='900'&&env.OWNER_TELEGRAM_ID==='900',
    'fictional_candidate_required');
  check(binding&&typeof binding.prepare==='function'&&typeof binding.batch==='function'&&
    typeof binding.withSession==='function','native_binding_required');
  check(typeof env.BOT_TOKEN==='string'&&env.BOT_TOKEN.startsWith('123456789:')&&
    /synthetic|offline|fixture|test/iu.test(env.BOT_TOKEN),'synthetic_bot_required');
  check(/^[0-9a-f]{40}$/u.test(env.REBUILD_V140_RC_SHA??''),'candidate_required');
  let origin;
  try{origin=new URL(env.MINI_APP_ORIGIN);}catch{check(false,'origin_required');}
  check(origin.protocol==='https:'&&origin.origin===env.MINI_APP_ORIGIN,'origin_required');
  const db=binding.withSession('first-primary'),now=Math.floor(Date.now()/1000);
  const single=async(sql,params=[])=>db.prepare(sql).bind(...params).first();
  const scalar=async(sql,params=[])=>{
    const row=await single(sql,params);check(Number.isSafeInteger(row?.n)&&row.n>=0,'count_invalid');return row.n;
  };
  const fixtureUsers=await scalar('SELECT COUNT(*) AS n FROM users');
  check(fixtureUsers>=1000,'thousand_user_fixture_required');
  check(await scalar('SELECT COUNT(*) AS n FROM partner_profiles WHERE telegram_id=202')===0,
    'pristine_partner_required');
  // These fixtures represent an existing canonical admin-approved application,
  // age attestation, self-declared legal profile, role, and finite Beta grant.
  await db.batch([
    ...[101,202,303,900].flatMap(id=>[
      db.prepare("INSERT OR IGNORE INTO users(telegram_id,referral_code,accepted_terms) VALUES(?,?,1)").bind(id,'p05_fixture_'+id),
      db.prepare("INSERT OR IGNORE INTO user_roles(telegram_id,role,status) VALUES(?,'user','active')").bind(id),
      db.prepare("INSERT OR IGNORE INTO user_access(telegram_id,access_tier) VALUES(?,'free')").bind(id),
      db.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").bind(id),
      db.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").bind(id),
    ]),
    db.prepare("INSERT OR IGNORE INTO user_roles(telegram_id,role,status,assigned_by) VALUES(900,'admin','active',900)"),
    db.prepare("INSERT INTO user_roles(telegram_id,role,status,assigned_by) VALUES(202,'partner','active',900)"),
    db.prepare(`INSERT INTO partner_applications(id,telegram_id,display_name,contact,age_confirmed,status,reviewed_by,reviewed_at)
      VALUES(?,202,'Synthetic P05 Partner','@synthetic_p05',1,'approved',900,datetime(?,'unixepoch'))`).bind(PROFILE_ID,now),
    db.prepare(`INSERT INTO partner_profiles(id,telegram_id,application_id,display_name,contact,status,approved_by,approved_at)
      VALUES(?,202,?,'Synthetic P05 Partner','@synthetic_p05','active',900,datetime(?,'unixepoch'))`).bind(PROFILE_ID,PROFILE_ID,now),
    db.prepare("INSERT INTO partner_public_settings(telegram_id,public_username_enabled) VALUES(202,0)"),
    db.prepare(`INSERT INTO partner_legal_profiles(partner_profile_id,profile_kind,verification_state,revision,declared_by,declared_at,updated_at)
      VALUES(?,'individual','self_declared',1,202,datetime(?,'unixepoch'),datetime(?,'unixepoch'))`).bind(PROFILE_ID,now,now),
    db.prepare(`INSERT INTO partner_beta_access(partner_profile_id,access_status,can_create_private_offers,can_submit_offers,granted_by,expires_at,reason)
      VALUES(?,'active',1,1,900,datetime(?,'unixepoch'),'Synthetic P05 fixture')`).bind(PROFILE_ID,now+600),
    db.prepare(`UPDATE partner_beta_settings SET enabled=1,private_offers_enabled=1,submissions_enabled=1,
      public_visibility_enabled=1,max_active_offers_per_partner=3,updated_by=900 WHERE id=1`),
    db.prepare(`INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,owner_telegram_id,issued_at,expires_at,updated_at)
      VALUES(1,?,1,'open',1,202,?,?,?) ON CONFLICT(id) DO UPDATE SET candidate_sha=excluded.candidate_sha,
      revision=1,state='open',beta_enabled=1,owner_telegram_id=202,issued_at=excluded.issued_at,
      expires_at=excluded.expires_at,updated_at=excluded.updated_at`).bind(env.REBUILD_V140_RC_SHA,now-1,now+600,now),
  ]);
  const identities=await db.prepare('SELECT telegram_id,accepted_terms,is_blocked,referral_code FROM users WHERE telegram_id IN(101,202,303,900)').all();
  check(identities.success===true&&identities.results?.length===4&&identities.results.every(row=>
    row.accepted_terms===1&&row.is_blocked===0&&/^(synthetic_|p05_)/u.test(row.referral_code)),'fictional_actors_required');
  const candidateEnv={...env,DB:binding,REBUILD_V140_RELEASE_REVISION:'1',REBUILD_V140_OWNER_TELEGRAM_ID:'202',
    REBUILD_V140_OWNER_WINDOW:`true:${now-1}:${now+600}`,REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',
    REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',REBUILD_V140_STORAGE_ENABLED:'true',REBUILD_V140_WRITES_ENABLED:'true',
    PARTNER_BETA_ENABLED:'true',PARTNER_PRIVATE_OFFERS_ENABLED:'true',PARTNER_OFFER_SUBMISSIONS_ENABLED:'true',
    PARTNER_OFFER_PUBLIC_VISIBILITY_ENABLED:'true',REBUILD_V140_EFFECTS_ENABLED:'false'};
  const calls=[];
  const call=async(scenario,path,{token,payload,key='p05_http_default_request',customEnv=candidateEnv}={})=>{
    const counts={queries:0,batches:0,maxBatch:0};
    const response=await worker.fetch(new Request(origin.origin+'/api/v1.4.0/cabinet/'+path,{
      method:payload===undefined?'GET':'POST',headers:{...(payload===undefined?{}:{Origin:origin.origin,'Content-Type':'application/json',
        'Idempotency-Key':key,'Sec-Fetch-Site':'same-origin'}),...(token?{Authorization:'Bearer '+token}:{})},
      ...(payload===undefined?{}:{body:JSON.stringify(payload)})}),{...customEnv,DB:countedBinding(binding,counts)},{});
    const data=await response.json();
    check(counts.queries<=210,'request_query_budget');
    calls.push({scenario,status:response.status,...counts});return {status:response.status,data};
  };
  const session=async(scenario,actor,customEnv=candidateEnv)=>{
    const response=await call(scenario,'session',{payload:{initData:await signedInitData(actor,env.BOT_TOKEN)},customEnv});
    check(response.status===200&&typeof response.data.sessionToken==='string'&&response.data.authorizationVersion===1,
      scenario+'_session_failed');return response.data.sessionToken;
  };
  const token=await session('partner_session',202);
  const bootstrap=await call('thousand_rows_bootstrap','bootstrap',{token});
  check(bootstrap.status===200,'bootstrap_status_'+bootstrap.status+'_'+
    (/^[a-z0-9_]{1,64}$/u.test(bootstrap.data.error??'')?bootstrap.data.error:'projection'));
  check(bootstrap.status===200&&bootstrap.data.access?.planCode==='free'&&
    bootstrap.data.authorization?.allowed===true,'bootstrap_projection_failed');
  const beforeReceipts=await scalar("SELECT COUNT(*) AS n FROM mini_app_command_receipts WHERE actor_telegram_id=202 AND operation='offer.create_private'");
  const beforeAudit=await scalar("SELECT COUNT(*) AS n FROM entitlement_decision_audit WHERE subject_telegram_id=202 AND capability='offer.create_private'");
  const keys=['p05_last_free_slot_first','p05_last_free_slot_second'];
  const burst=await Promise.all(keys.map((key,index)=>call('last_slot_'+index,'offers',{token,payload:{},key})));
  const winner=burst.findIndex(result=>result.status===200&&result.data.commitStatus==='committed');
  check(winner>=0&&burst.filter(result=>result.status===200).length===1,'exactly_one_slot_required');
  check(burst.every((result,index)=>index===winner||[403,409].includes(result.status)),'loser_not_closed');
  const offerCode=burst[winner].data.offerCode;
  check(typeof offerCode==='string'&&/^[a-z0-9_-]{3,24}$/u.test(offerCode),'offer_ack_failed');
  check(await scalar('SELECT COUNT(*) AS n FROM offer_owners WHERE partner_profile_id=?',[PROFILE_ID])===1,
    'single_object_required');
  const replay=await call('same_key_replay','offers',{token,payload:{},key:keys[winner]});
  check(replay.status===200&&replay.data.commitStatus==='unchanged'&&replay.data.offerCode===offerCode,'replay_failed');
  const owned=await call('thousand_rows_own_projection','offers?view=mine&limit=50',{token});
  check(owned.status===200&&owned.data.items?.length===1&&owned.data.decisions?.['offer.create_private']?.quota?.remaining===0,
    'own_projection_failed');
  const foreignEnv={...candidateEnv,REBUILD_V140_OWNER_TELEGRAM_ID:'303'};
  await db.prepare('UPDATE mini_app_release_control SET owner_telegram_id=303 WHERE id=1').run();
  const foreignToken=await session('foreign_session',303,foreignEnv);
  const foreign=await call('foreign_owner_edit',`offers/${offerCode}/version`,{token:foreignToken,
    payload:{version:1,patch:{title:'Foreign fixture edit'}},key:'p05_foreign_edit_request',customEnv:foreignEnv});
  check(foreign.status===404&&foreign.data.authorization===undefined,'foreign_owner_not_redacted');
  const foreignRole=await call('foreign_role_read','applications?view=attributed',{token:foreignToken,customEnv:foreignEnv});
  check(foreignRole.status===403,'foreign_role_not_denied');
  await db.prepare('UPDATE mini_app_release_control SET issued_at=?,expires_at=? WHERE id=1').bind(now-1202,now-2).run();
  const expiredEnv={...foreignEnv,REBUILD_V140_OWNER_WINDOW:`true:${now-1202}:${now-2}`};
  const adminToken=await session('permanent_admin_session',900,expiredEnv);
  const admin=await call('permanent_admin_profile','profile',{token:adminToken,customEnv:expiredEnv});
  check(admin.status===200&&admin.data.systemRole==='admin'&&admin.data.authorization?.allowed===true,
    'permanent_admin_failed');
  const expired=await call('expired_participant_session','session',{
    payload:{initData:await signedInitData(303,env.BOT_TOKEN)},customEnv:expiredEnv});
  check([401,403,404,503].includes(expired.status)&&typeof expired.data.sessionToken!=='string','expired_participant_not_closed');
  check(await scalar("SELECT COUNT(*) AS n FROM mini_app_command_receipts WHERE actor_telegram_id=202 AND operation='offer.create_private'")-beforeReceipts===1,
    'single_receipt_required');
  check(await scalar("SELECT COUNT(*) AS n FROM entitlement_decision_audit WHERE subject_telegram_id=202 AND capability='offer.create_private'")-beforeAudit===1,
    'single_audit_required');
  check(await scalar('SELECT COUNT(*) AS n FROM offer_versions WHERE offer_code=?',[offerCode])===1,'foreign_or_replay_effect');
  check(await scalar('SELECT COUNT(*) AS n FROM mini_app_atomic_guards')===0,'temporary_guards_left');
  // Never return credentials, source hashes, raw actor IDs or resource codes.
  return Object.freeze({fixtureUsers,burstSize:2,assertions:Object.freeze({singleObject:true,singleReceipt:true,
    singleAudit:true,sameKeyReplay:true,foreignOwnerRedacted:true,foreignRoleDenied:true,permanentAdmin:true,
    expiredParticipantDenied:true,noExtraVersion:true,noTemporaryGuards:true}),
    maxQueries:Math.max(...calls.map(row=>row.queries)),calls:Object.freeze(calls.map(row=>Object.freeze(row)))});
}
