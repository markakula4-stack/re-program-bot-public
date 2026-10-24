// Nonsecret configuration is compiled into each fenced release version. This
// preserves the accepted Worker's complete 64-variable binding inventory.
export const RELEASE_CONFIG_GLOBAL='__RE_PROGRAM_V140_RELEASE_CONFIG__';
export const RELEASE_FLAGS=Object.freeze(['STORAGE','WRITES','OFFER_ACTIONS','EFFECTS','RETENTION','TELEGRAM','BETA','RESULT_ACTIONS']);
const ORIGIN='https://re-program-bot.markakula4.workers.dev';
const fields=Object.freeze(['MINI_APP_ORIGIN','REBUILD_V140_OWNER_WINDOW','REBUILD_V140_OWNER_TELEGRAM_ID','REBUILD_V140_ADMIN_ACCESS_ENABLED','REBUILD_V140_ADMIN_BETA_GRANTS_ENABLED',
  'REBUILD_V140_RC_SHA','REBUILD_V140_RELEASE_LEASE_REQUIRED','REBUILD_V140_RELEASE_REVISION','REBUILD_V140_BOT_ID',
  'REBUILD_V140_CONTROL_ISSUED_AT','REBUILD_V140_CONTROL_EXPIRES_AT','REBUILD_V140_CONTROL_SECRET_SHA256',
  ...RELEASE_FLAGS.map(f=>'REBUILD_V140_'+f+'_ENABLED')]);
const reject=()=>{throw new Error('release_compiled_config_invalid');};
export function validateCompiledReleaseConfig(config){
  if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).length!==fields.length||
    fields.some(f=>!Object.hasOwn(config,f)||typeof config[f]!=='string')||Object.keys(config).some(f=>!fields.includes(f)))reject();
  if(config.MINI_APP_ORIGIN!==ORIGIN||!/^[a-f0-9]{40}$/u.test(config.REBUILD_V140_RC_SHA)||
    !/^[a-f0-9]{64}$/u.test(config.REBUILD_V140_CONTROL_SECRET_SHA256)||config.REBUILD_V140_RELEASE_LEASE_REQUIRED!=='true'||
    !/^(?:0|[1-9][0-9]{0,15})$/u.test(config.REBUILD_V140_RELEASE_REVISION)||!Number.isSafeInteger(Number(config.REBUILD_V140_RELEASE_REVISION))||
    ['REBUILD_V140_OWNER_TELEGRAM_ID','REBUILD_V140_BOT_ID'].some(f=>!/^(?:0|[1-9][0-9]{0,15})$/u.test(config[f])||!Number.isSafeInteger(Number(config[f])))||
    ['REBUILD_V140_ADMIN_ACCESS_ENABLED','REBUILD_V140_ADMIN_BETA_GRANTS_ENABLED'].some(f=>!['true','false'].includes(config[f]))||
    (config.REBUILD_V140_ADMIN_BETA_GRANTS_ENABLED==='true'&&config.REBUILD_V140_ADMIN_ACCESS_ENABLED!=='true')||
    RELEASE_FLAGS.some(f=>!['true','false'].includes(config['REBUILD_V140_'+f+'_ENABLED'])))reject();
  const issued=Number(config.REBUILD_V140_CONTROL_ISSUED_AT),expires=Number(config.REBUILD_V140_CONTROL_EXPIRES_AT);
  if(!/^[0-9]{10}$/u.test(config.REBUILD_V140_CONTROL_ISSUED_AT)||!/^[0-9]{10}$/u.test(config.REBUILD_V140_CONTROL_EXPIRES_AT)||expires<=issued||expires-issued>1800)reject();
  const window=config.REBUILD_V140_OWNER_WINDOW;
  if(window==='false'){
    if(config.REBUILD_V140_OWNER_TELEGRAM_ID!=='0')reject();
    if(config.REBUILD_V140_ADMIN_ACCESS_ENABLED==='true'){
      if(Number(config.REBUILD_V140_BOT_ID)<1||Number(config.REBUILD_V140_RELEASE_REVISION)<1||
        RELEASE_FLAGS.some(f=>config['REBUILD_V140_'+f+'_ENABLED']!==(['STORAGE','WRITES','TELEGRAM'].includes(f)?'true':'false')))reject();
    }else if(RELEASE_FLAGS.some(f=>config['REBUILD_V140_'+f+'_ENABLED']!=='false')||config.REBUILD_V140_BOT_ID!=='0'||config.REBUILD_V140_RELEASE_REVISION!=='0')reject();
  }else{
    const match=/^true:([0-9]{10}):([0-9]{10})$/u.exec(window);
    if(!match||Number(match[2])<=Number(match[1])||Number(match[2])-Number(match[1])>1200||
      Number(config.REBUILD_V140_OWNER_TELEGRAM_ID)<1||Number(config.REBUILD_V140_BOT_ID)<1||Number(config.REBUILD_V140_RELEASE_REVISION)<1)reject();
  }
  return config;
}
async function derivedKey(botToken,purpose){
  if(typeof botToken!=='string'||botToken.length<32||botToken.length>256)throw new Error('release_signing_source_unavailable');
  const utf8=new TextEncoder(),key=await crypto.subtle.importKey('raw',utf8.encode(botToken),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,utf8.encode('re-program/v1.4.0/'+purpose+'/v1')));
  return [...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');
}
export async function materializeReleaseEnv(env,config=globalThis[RELEASE_CONFIG_GLOBAL]){
  if(config===undefined)return env;
  validateCompiledReleaseConfig(config);
  const result={...env,...config};
  // Existing keys are never rotated. Missing keys are derived inside Worker
  // memory from the inherited bot secret, with independent purpose labels.
  if(env.MINI_APP_CURSOR_SECRET===undefined)result.MINI_APP_CURSOR_SECRET=await derivedKey(env.BOT_TOKEN,'cursor');
  if(env.MINI_APP_IDEMPOTENCY_SECRET===undefined)result.MINI_APP_IDEMPOTENCY_SECRET=await derivedKey(env.BOT_TOKEN,'idempotency');
  return result;
}
