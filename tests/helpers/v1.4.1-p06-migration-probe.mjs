// Test-only Worker; the only input choices are seed/status/prepare/audit.
import {P06_SCHEMA_BATCHES} from 'p06:probe-schema';
import {createV141ReleaseControl} from '../../src/v1.4.1/release-control.mjs';
import {P04_SCHEMA} from '../../src/v1.4.1/privacy-schema.mjs';
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const headers={'Cache-Control':'no-store','X-Re-Program-Probe':'v1'};
export default {async fetch(request,env) {
  const cfg=globalThis.__RE_PROGRAM_P06_PROBE_CONFIG__;
  if(request.method!=='POST'||new URL(request.url).pathname!=='/probe'||!cfg||cfg.candidateSha!==env.PROBE_CANDIDATE_SHA||
    request.headers.get('Authorization')!=='Bearer '+env.PROBE_TOKEN||Date.now()/1000>=Number(env.PROBE_EXPIRES_AT))return new Response('Not found',{status:404,headers});
  const metrics={statements:0};
  try {
    const text=await request.text();if(text.length>4096)throw new Error('p06_probe_input_limit');
    const input=JSON.parse(text),fingerprint=await digest(JSON.stringify(cfg));
    if(!input||Object.keys(input).some(k=>!['kind','index','actor','expectedCompiledConfigSha256'].includes(k))||
      input.actor!==undefined&&(input.kind!=='ready'||input.actor!==101))throw new Error('p06_probe_input_invalid');
    if(input.kind==='ready')return Response.json({status:200,result:{ready:true,candidateSha:cfg.candidateSha,expiresAt:Number(env.PROBE_EXPIRES_AT),now:Math.floor(Date.now()/1000),compiledConfigSha256:fingerprint},metrics},{headers});
    if(input.expectedCompiledConfigSha256!==fingerprint)return Response.json({status:409,result:{error:'probe_compiled_config_unverified'},metrics},{headers});
    const db=env.DB.withSession('first-primary');let result;
    if(input.kind==='seed') {
      if(!Number.isSafeInteger(input.index)||!P06_SCHEMA_BATCHES[input.index])throw new Error('p06_probe_seed_invalid');
      const plan=P06_SCHEMA_BATCHES[input.index],rows=await db.batch(plan.map(sql=>db.prepare(sql)));metrics.statements+=plan.length;
      if(rows.length!==plan.length||rows.some(r=>r.success!==true))throw new Error('p06_probe_seed_failed');
      result={batches:P06_SCHEMA_BATCHES.length,index:input.index};
    } else if(['status','prepare'].includes(input.kind)) {
      const now=Math.floor(Date.now()/1000),scoped={DB:env.DB,BOT_TOKEN:'123456789:p06-only-fictional-not-production-token',ADMIN_ID:'900',OWNER_TELEGRAM_ID:'900',
        V141_SOURCE_SHA:cfg.candidateSha,V141_RELEASE_MODE:'default_off',V141_AUTHORIZATION_ENABLED:'false',V141_LEGACY_COMPATIBILITY_ENABLED:'false',
        REBUILD_V140_RC_SHA:'54fe39772c290c49a35ae4d259c8bb5c0883dbb9',REBUILD_V140_RELEASE_REVISION:'26',
        REBUILD_V140_CONTROL_ISSUED_AT:String(now-1),REBUILD_V140_CONTROL_EXPIRES_AT:String(now+600),REBUILD_V140_CONTROL_SECRET_SHA256:await digest(env.PROBE_TOKEN)};
      const response=await createV141ReleaseControl({allowTestOrigin:true})(new Request('https://p06.invalid/__rebuild/v1.4.1/release',{method:'POST',headers:{Authorization:'Bearer '+env.PROBE_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({action:input.kind,candidateSha:cfg.candidateSha})}),scoped);
      result=await response.json();if(!response.ok||result.ok!==true)throw Object.assign(new Error(result.code??'p06_native_control_failed'),{p06Result:result});
    } else if(input.kind==='audit') {
      let errors=0;
      for(const table of [...P04_SCHEMA.tables,'users','user_roles','user_access','mini_app_release_control','mini_app_atomic_guards']) {
        const quick=await db.prepare(`PRAGMA quick_check('${table}')`).all(),fk=await db.prepare(`PRAGMA foreign_key_check('${table}')`).all();metrics.statements+=2;
        if(quick.success!==true||quick.results?.length!==1||quick.results[0].quick_check!=='ok')throw new Error('p06_native_integrity_failed');
        if(fk.success!==true||!Array.isArray(fk.results))throw new Error('p06_native_foreign_key_result_unverified');
        errors+=fk.results.length;
      }
      const users=await db.prepare('SELECT COUNT(*) n FROM users').first(),guards=await db.prepare('SELECT COUNT(*) n FROM mini_app_atomic_guards').first();metrics.statements+=2;
      result={integrity:'ok',foreignKeyErrors:errors,fixtureUsers:users.n,guards:guards.n,checkedTables:14};
    } else throw new Error('p06_probe_kind_invalid');
    return Response.json({status:200,result,metrics},{headers});
  } catch(error) {
    return Response.json({status:500,result:{error:/^[a-z0-9_]{1,96}$/u.test(error.code??error.message??'')?error.code??error.message:'p06_probe_failed'},metrics},{headers});
  }
}};
