// Test-only authenticated Worker on one newly created fictional D1 database.
import {P05_SCHEMA_BATCHES} from 'p05:probe-schema';
import {P04_SCHEMA,inspectP04Schema} from '../../src/v1.4.1/privacy-schema.mjs';
import {runP05HttpScenarios} from './v1.4.1-p05-http-scenarios.mjs';
import {runP05AiScenarios,P05_AI_PHASES} from './v1.4.1-p05-ai-scenarios.mjs';
export {DragonPreviewWorkflow,ReferralRewardProtectionWorkflow} from '../../src/v1.4.0-rebuild/worker-entrypoint.mjs';

const headers={'Cache-Control':'no-store','X-Re-Program-Probe':'v1'};
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');
function instrument(binding,metrics) {
  const record=result=>{metrics.statements++;metrics.rowsRead+=Number(result.meta?.rows_read??0);metrics.rowsWritten+=Number(result.meta?.rows_written??0);metrics.sqlDurationMs+=Number(result.meta?.duration??0);return result;};
  const session=raw=>{const wrapper={prepare(sql){const wrap=s=>({native:s,bind(...p){return wrap(s.bind(...p));},
    async first(column){const r=record(await s.all());const row=r.results?.[0]??null;return column?row?.[column]??null:row;},
    async all(){return record(await s.all());},async run(){return record(await s.run());}});return wrap(raw.prepare(sql));},
    async batch(s){const result=await raw.batch(s.map(v=>v.native));result.forEach(record);return result;},
    withSession(mode){return typeof raw.withSession==='function'?session(raw.withSession(mode)):wrapper;}};return wrapper;};
  return session(binding);
}
export default {async fetch(request,env) {
  const cfg=globalThis.__RE_PROGRAM_P05_CONFIG__;
  if(request.method!=='POST'||new URL(request.url).pathname!=='/probe'||typeof env.PROBE_TOKEN!=='string'||
    request.headers.get('Authorization')!=='Bearer '+env.PROBE_TOKEN||!cfg||cfg.candidateSha!==env.PROBE_CANDIDATE_SHA||
    Math.floor(Date.now()/1000)>=Number(env.PROBE_EXPIRES_AT))return new Response('Not found',{status:404,headers});
  const metrics={statements:0,rowsRead:0,rowsWritten:0,sqlDurationMs:0};
  try {
    if(Number(request.headers.get('Content-Length')??0)>4096)throw new Error('probe_input_limit');
    const text=await request.text();if(text.length>4096)throw new Error('probe_input_limit');const input=JSON.parse(text);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['kind','index','actor','phase','expectedCompiledConfigSha256'].includes(k))||
      input.actor!==undefined&&![101,900].includes(input.actor))throw new Error('probe_input_invalid');
    const fingerprint=await hash(JSON.stringify(cfg));
    if(input.kind==='ready')return Response.json({status:200,result:{ready:true,candidateSha:cfg.candidateSha,
      expiresAt:Number(env.PROBE_EXPIRES_AT),now:Math.floor(Date.now()/1000),compiledConfigSha256:fingerprint},metrics},{headers});
    if(input.expectedCompiledConfigSha256!==fingerprint)return Response.json({status:409,result:{error:'probe_compiled_config_unverified'},metrics},{headers});
    const db=instrument(env.DB,metrics).withSession('first-primary');let result;
    if(input.kind==='seed') {
      if(!Number.isSafeInteger(input.index)||input.index<0||input.index>=P05_SCHEMA_BATCHES.length)throw new Error('probe_seed_invalid');
      const batch=P05_SCHEMA_BATCHES[input.index];const rows=await db.batch(batch.map(sql=>db.prepare(sql)));
      if(rows.length!==batch.length||rows.some(r=>r.success!==true))throw new Error('probe_seed_failed');
      result={seedIndex:input.index,batches:P05_SCHEMA_BATCHES.length,statements:batch.length};
    } else {
      await inspectP04Schema(db);
      const count=await db.prepare('SELECT COUNT(*) n FROM users WHERE telegram_id BETWEEN 10000 AND 10999').first();
      if(count?.n!==1000)throw new Error('probe_population_invalid');
      const now=Math.floor(Date.now()/1000),scoped={DB:db,BOT_TOKEN:'123456789:p05-synthetic-token-never-production',ADMIN_ID:'900',OWNER_TELEGRAM_ID:'900',
        REBUILD_V140_BOT_ID:'123456789',MINI_APP_ORIGIN:new URL(request.url).origin,
        MINI_APP_CURSOR_SECRET:'p05-synthetic-cursor-secret-at-least-thirty-two-bytes',MINI_APP_IDEMPOTENCY_SECRET:'p05-synthetic-command-secret-at-least-thirty-two-bytes',
        V141_AUTHORIZATION_ENABLED:'true',V141_P05_ISOLATED_PROBE:'true',V141_P05_FIXTURE_MARKER:'v1.4.1-p05-synthetic-isolated',
        REBUILD_V140_STORAGE_ENABLED:'true',REBUILD_V140_WRITES_ENABLED:'true',REBUILD_V140_OFFER_ACTIONS_ENABLED:'true',
        REBUILD_V140_RC_SHA:cfg.candidateSha,REBUILD_V140_RELEASE_REVISION:'1',REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',
        REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',REBUILD_V140_OWNER_TELEGRAM_ID:'202',REBUILD_V140_OWNER_WINDOW:`true:${now-1}:${now+600}`,
        PARTNER_BETA_ENABLED:'true',PARTNER_PRIVATE_OFFERS_ENABLED:'true',PARTNER_OFFER_SUBMISSIONS_ENABLED:'true',PARTNER_OFFER_PUBLIC_VISIBILITY_ENABLED:'true',
        PLAN_COMPATIBILITY_DUAL_READ_ENABLED:'false',PLAN_CANONICAL_READ_ENABLED:'false',DRAGON_PREVIEW_ENABLED:'true'};
      if(input.kind==='http')result=await runP05HttpScenarios({binding:db,env:scoped});
      else if(input.kind==='ai'){if(!P05_AI_PHASES.includes(input.phase))throw new Error('probe_ai_phase_invalid');result=await runP05AiScenarios({binding:db,env:scoped,phase:input.phase});}
      else if(input.kind==='audit') {
        const auditTransports={},sessionDiagnostics={},safeMessage=error=>String(error?.message??'').replace(/Bearer\s+\S+/giu,'Bearer [redacted]').slice(0,300);
        const read=async(stage,sql)=>{
          const execute=async source=>{const value=await source.prepare(sql).all();if(value.success!==true||!Array.isArray(value.results))throw new Error('audit_sdk_result_invalid');return value.results;};
          try{const rows=await execute(db);auditTransports[stage]='primary_session';return rows;}
          catch(error){sessionDiagnostics[stage]=safeMessage(error);
            // One read-only observation using the root binding distinguishes
            // session/SDK limitations from database failures. SQL is fixed.
            try{const rows=await execute(instrument(env.DB,metrics));auditTransports[stage]='root_binding';return rows;}
            catch(rootError){throw Object.assign(new Error('probe_audit_'+stage),{p05AuditDiagnostic:sessionDiagnostics[stage]+'; root_binding: '+safeMessage(rootError)});}
          }
        };
        // A whole-schema quick_check returned SQLITE_NOMEM on native D1.
        // Check the candidate/access/quota/cost tables individually instead.
        const tables=[...P04_SCHEMA.tables,'users','user_roles','user_access','user_plans','user_access_states',
          'partner_profiles','partner_legal_profiles','partner_beta_access','mini_app_release_control',
          'mini_app_sessions','mini_app_command_receipts','mini_app_atomic_guards','offers','offer_owners','offer_versions',
          'ai_gateway_budget_reservations','ai_gateway_daily_aggregates','ai_generation_sessions'];
        let integrity='ok',foreignKeyErrors=0;
        for(const table of tables){const quick=await read('quick_'+table,`PRAGMA quick_check('${table}')`),foreign=await read('fk_'+table,`PRAGMA foreign_key_check('${table}')`);
          if(quick.length!==1||quick[0]?.quick_check!=='ok')integrity='failed';foreignKeyErrors+=foreign.length;}
        const guards=await read('guards','SELECT COUNT(*) n FROM mini_app_atomic_guards');
        result={users:count.n,integrity,foreignKeyErrors,checkedTables:tables.length,scope:'critical_tables_per_table',
          guards:guards[0]?.n,schemaSha256:P04_SCHEMA.schemaSha256,auditTransports,sessionDiagnostics};
      }
      else throw new Error('probe_kind_invalid');
    }
    return Response.json({status:200,result,metrics},{headers});
  } catch(error) {
    const code=/^[a-z0-9_]{1,96}$/u.test(error?.code??error?.message??'')?error.code??error.message:'probe_scenario_failed';
    return Response.json({status:500,result:{error:code,...(typeof error?.p05AuditDiagnostic==='string'?{auditDiagnostic:error.p05AuditDiagnostic}:{})},metrics},{headers});
  }
}};
