import test from 'node:test';
import assert from 'node:assert/strict';
import {foundationFixture} from './helpers/v1.4.1-fixtures.mjs';
import {createCustomerContext} from '../src/v1.4.1/trusted-context.mjs';
import {authorizeTelegramHandler} from '../src/v1.4.1/telegram-runtime.mjs';
import {prepareLegacyCompatibility,bindLegacyCompatibilityEnv} from '../src/v1.4.1/telegram-legacy-compatibility.mjs';
import {upgradeLegacyPreviewActivation} from '../src/v1.4.1/legacy-access-runtime.mjs';
import {activateDragonPreview} from '../src/v1.3.5/dragon-preview.mjs';

let sequence=1_417_300;
async function setup(t){
  const f=foundationFixture(t),env={...f.serverEnv,V141_AUTHORIZATION_ENABLED:'true',WEBHOOK_SECRET:'offline-preview-phase-webhook-secret',
    DRAGON_PREVIEW_ENABLED:'true',DRAGON_PREVIEW_CHANNEL_ID:'@official_preview',DRAGON_PREVIEW_CHANNEL_URL:'https://t.me/official_preview',
    DRAGON_PREVIEW_PROGRAM_END_AT:'2027-10-01T00:00:00Z',DRAGON_PREVIEW_ANTI_ABUSE_RETENTION_DAYS:'90',
    DRAGON_PREVIEW_ANTI_ABUSE_SECRET:'offline-preview-phase-secret-longer-than-32-characters',
    DRAGON_PREVIEW_WORKFLOW:{async create(){throw new Error('offline_fixed_workflow_start_failed');}}};
  const body={update_id:++sequence,callback_query:{id:'phase_'+sequence,from:{id:101,is_bot:false},
    message:{from:{id:123456789,is_bot:true},chat:{id:101,type:'private'}},data:'dragon_preview_check'}};
  const claim='preview_phase_claim_'+sequence;
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,attempt_count,received_at,lease_expires_at)
    VALUES(?,'callback_query',101,'processing',?,1,?,?)`).run(body.update_id,claim,f.now,f.now+300);
  const context=await createCustomerContext({binding:f.binding,env,webhookRequest:new Request('https://bot.example/webhook',{method:'POST',
    headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET},body:JSON.stringify(body)}),
    receiptClaimToken:claim,channel:'telegram_callback',operation:'account.menu.read',nowSeconds:f.now});
  const selected=await authorizeTelegramHandler(context,body);assert.equal(selected.handler.capability,'channel.check_membership');
  const scoped=bindLegacyCompatibilityEnv(await prepareLegacyCompatibility(selected.authorization,{family:'channel.check_membership'}),env);
  return {f,env:scoped};
}
const count=(f,table)=>f.sqlite.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;
test('actual Preview performs membership preflight, upgrades only from persisted proof, commits one grant and retains workflow failure metadata',async t=>{
  const {f,env}=await setup(t),previous=globalThis.fetch;let membershipCalls=0;
  globalThis.fetch=async(url,options)=>{assert.ok(String(url).endsWith('/getChatMember'));assert.equal(JSON.parse(options.body).user_id,101);membershipCalls++;
    return new Response(JSON.stringify({ok:true,result:{status:'member'}}),{status:200,headers:{'Content-Type':'application/json'}});};
  t.after(()=>{globalThis.fetch=previous;});
  await assert.rejects(upgradeLegacyPreviewActivation(env,101),/capability_denied|feature_unavailable|prerequisite_required/u);
  assert.equal(count(f,'trial_grants'),0);
  const result=await activateDragonPreview(env,101);assert.equal(result.state,'active');assert.equal(membershipCalls,1);
  assert.equal(count(f,'trial_grants'),1);assert.equal(count(f,'notification_jobs'),2);assert.equal(count(f,'mini_app_atomic_guards'),0);
  const grant=f.sqlite.prepare('SELECT * FROM trial_grants').get();assert.equal(grant.workflow_state,'start_failed');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM trial_eligibility_checks WHERE outcome='granted'").get().n,1);
  assert.equal((await activateDragonPreview(env,101)).state,'active');assert.equal(membershipCalls,1);assert.equal(count(f,'trial_grants'),1);
  await assert.rejects(upgradeLegacyPreviewActivation({...env},101),/preview_compatibility_required|untrusted|scope/u);
});
test('role loss after actual platform response prevents a new Preview grant',async t=>{
  const {f,env}=await setup(t),previous=globalThis.fetch;
  globalThis.fetch=async()=>{f.sqlite.exec("UPDATE user_roles SET status='paused' WHERE telegram_id=101 AND role='user'");
    return new Response(JSON.stringify({ok:true,result:{status:'member'}}),{status:200,headers:{'Content-Type':'application/json'}});};
  t.after(()=>{globalThis.fetch=previous;});
  await assert.rejects(activateDragonPreview(env,101));assert.equal(count(f,'trial_grants'),0);assert.equal(count(f,'notification_jobs'),0);
});
