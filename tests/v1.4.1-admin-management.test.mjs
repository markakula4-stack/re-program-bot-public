import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {foundationFixture,signedInitData} from './helpers/v1.4.1-fixtures.mjs';
import {createCabinetCustomerContext} from '../src/v1.4.1/trusted-context.mjs';
import {createRuntimeAuthorizer,runtimeAuthorizationDTO} from '../src/v1.4.1/runtime-authorizer.mjs';
import {executeAdminManagementMutation,readAdminAuxiliarySection} from '../src/v1.4.1/admin-cabinet-management.mjs';

async function setup(t) {
  const f=foundationFixture(t);
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  f.sqlite.exec(`INSERT OR IGNORE INTO admin_safety_runtime_settings(id,updated_at) VALUES(1,unixepoch());
    INSERT OR IGNORE INTO ai_runtime_settings(id) VALUES(1);
    INSERT OR IGNORE INTO official_web_settings(id) VALUES(1);
    UPDATE partner_beta_settings SET enabled=0,private_offers_enabled=0,submissions_enabled=0,public_visibility_enabled=0`);
  const candidate='d'.repeat(40),revision=32;
  f.sqlite.prepare("INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,updated_at) VALUES(1,?,?,'closed',0,?)").run(candidate,revision,f.now);
  const env={...f.serverEnv,V141_RELEASE_MODE:'owner_only',V141_AUTHORIZATION_ENABLED:'true',V141_ADMIN_MINI_APP_ENABLED:'true',
    REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',REBUILD_V140_OWNER_WINDOW:'false',
    REBUILD_V140_RC_SHA:candidate,REBUILD_V140_RELEASE_REVISION:String(revision),ADMIN_MODERATION_ENABLED:'true',
    PARTNER_BETA_ENABLED:'false',PARTNER_PRIVATE_OFFERS_ENABLED:'false',PARTNER_OFFER_SUBMISSIONS_ENABLED:'false',PARTNER_OFFER_PUBLIC_VISIBILITY_ENABLED:'false'};
  const opened=await f.call(900,'session',{method:'POST',token:null,payload:{initData:signedInitData(900,f.now)},customEnv:env});
  assert.equal(opened.status,200,JSON.stringify(opened.data));
  const token=opened.data.sessionToken;
  const authorize=async(operation,payload,key,customEnv=env)=>{
    const context=await createCabinetCustomerContext({binding:f.binding,env:customEnv,sessionToken:token,
      sessionScope:{candidateSha:candidate,revision},channel:'mini_app',operation,requestPayload:payload,idempotencyKey:key,nowSeconds:f.now});
    return createRuntimeAuthorizer().authorize(context,operation==='admin.user.moderation'?{kind:'user',key:payload.targetTelegramId}:{kind:'admin_surface',key:'settings'});
  };
  return {...f,env,authorize};
}
const moderation=(action,expectedRevision,targetTelegramId=101)=>({action,targetTelegramId,expectedRevision,reason:action==='block'?'Спам и вредительство':'Проверка завершена',confirmed:true});
const setting=(key,value,expectedValue)=>({action:'update_setting',key,value,expectedValue,confirmed:true});
const counts=f=>({receipts:f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_command_receipts').get().n,
  events:f.sqlite.prepare('SELECT COUNT(*) n FROM user_moderation_events').get().n,
  audit:f.sqlite.prepare('SELECT COUNT(*) n FROM entitlement_decision_audit').get().n,
  guards:f.sqlite.prepare('SELECT COUNT(*) n FROM mini_app_atomic_guards').get().n});

test('canonical owner moderation blocks and unblocks one target, exact replay never repeats an event and Telegram delivery state is preserved',async t=>{
  const f=await setup(t),payload=moderation('block',0),key='admin_miniapp_block_exact';
  const first=await executeAdminManagementMutation(await f.authorize('admin.user.moderation',payload,key));
  assert.equal(first.commitStatus,'committed');assert.equal(first.revision,1);
  assert.equal(f.sqlite.prepare('SELECT status FROM user_moderation_blocks WHERE target_telegram_id=101').get().status,'active');
  assert.equal(f.sqlite.prepare('SELECT is_blocked FROM users WHERE telegram_id=101').get().is_blocked,0,'delivery-health flag is separate from moderator ban');
  const replay=await executeAdminManagementMutation(await f.authorize('admin.user.moderation',payload,key));
  assert.equal(replay.commitStatus,'unchanged');assert.deepEqual(counts(f),{receipts:1,events:1,audit:1,guards:0});
  await assert.rejects(executeAdminManagementMutation(await f.authorize('admin.user.moderation',{...payload,reason:'Другая причина'},key)),/idempotency_conflict/u);
  const unblocked=await executeAdminManagementMutation(await f.authorize('admin.user.moderation',moderation('unblock',1),'admin_miniapp_unblock_exact'));
  assert.equal(unblocked.status,'revoked');assert.equal(unblocked.revision,2);
  assert.deepEqual(counts(f),{receipts:2,events:2,audit:2,guards:0});
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM users').get().n,5,'no account is deleted');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM user_moderation_blocks WHERE target_telegram_id<>101').get().n,0);
});

test('moderation rejects canonical owner target, unconfirmed intent, stale revision, disabled source and copied authorization',async t=>{
  const f=await setup(t);
  for(const [payload,key,env] of [
    [moderation('block',0,900),'admin_miniapp_self_block',f.env],
    [{...moderation('block',0),confirmed:false},'admin_miniapp_unconfirmed',f.env],
    [moderation('block',4),'admin_miniapp_stale_block',f.env],
    [moderation('block',0),'admin_miniapp_disabled_block',{...f.env,ADMIN_MODERATION_ENABLED:'false'}],
  ]) await assert.rejects(executeAdminManagementMutation(await f.authorize('admin.user.moderation',payload,key,env)));
  const genuine=await f.authorize('admin.user.moderation',moderation('block',0),'admin_miniapp_copied_bundle');
  await assert.rejects(executeAdminManagementMutation({...genuine}),/untrusted_runtime_authorization/u);
  assert.deepEqual(counts(f),{receipts:0,events:0,audit:0,guards:0});
});

for(const revoke of ['role','epoch','target']) {
  test('same-batch moderation rolls back receipt, target change and audit after '+revoke+' changes',async t=>{
    const f=await setup(t),bundle=await f.authorize('admin.user.moderation',moderation('block',0),'admin_miniapp_race_'+revoke);
    f.binding.beforeBatch=({sqlite})=>sqlite.exec({
      role:"UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'",
      epoch:'UPDATE mini_app_release_control SET revision=revision+1',
      target:"UPDATE users SET accepted_terms=0 WHERE telegram_id=101",
    }[revoke]);
    await assert.rejects(executeAdminManagementMutation(bundle),/state_conflict/u);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM user_moderation_blocks').get().n,0);
    assert.deepEqual(counts(f),{receipts:0,events:0,audit:0,guards:0});
  });
}

test('fixed settings changes persist, unchanged values do not add a domain event and receipt replay cannot overwrite a newer value',async t=>{
  const f=await setup(t),key='admin_miniapp_setting_off',payload=setting('ai_rollout_mode','off','admin');
  const first=await executeAdminManagementMutation(await f.authorize('admin.settings.manage',payload,key));
  assert.equal(first.commitStatus,'committed');assert.equal(f.sqlite.prepare('SELECT rollout_mode FROM ai_runtime_settings WHERE id=1').get().rollout_mode,'off');
  const replay=await executeAdminManagementMutation(await f.authorize('admin.settings.manage',payload,key));
  assert.equal(replay.commitStatus,'unchanged');assert.equal(counts(f).receipts,1);
  const same=await executeAdminManagementMutation(await f.authorize('admin.settings.manage',setting('ai_rollout_mode','off','off'),'admin_miniapp_setting_noop'));
  assert.equal(same.commitStatus,'unchanged');
  await assert.rejects(executeAdminManagementMutation(await f.authorize('admin.settings.manage',setting('ai_rollout_mode','all','off'),'admin_miniapp_setting_public')),/prerequisite_required/u);
  await assert.rejects(executeAdminManagementMutation(await f.authorize('admin.settings.manage',setting('ai_rollout_mode','admin','admin'),'admin_miniapp_setting_stale')));
  const official=await executeAdminManagementMutation(await f.authorize('admin.settings.manage',setting('official_web_enabled',true,false),'admin_miniapp_setting_official'));
  assert.equal(official.commitStatus,'committed');
  assert.equal(f.sqlite.prepare('SELECT enabled,admin_only FROM official_web_settings WHERE id=1').get().admin_only,1,'public expansion is not an editable key');
  assert.equal(counts(f).guards,0);
  assert.deepEqual({...f.sqlite.prepare('SELECT state,beta_enabled,revision FROM mini_app_release_control WHERE id=1').get()},{state:'closed',beta_enabled:0,revision:32});
});

test('settings compare-and-swap preserves a concurrent actual setting and rolls back its own receipt and audit',async t=>{
  const f=await setup(t),bundle=await f.authorize('admin.settings.manage',setting('official_web_enabled',true,false),'admin_miniapp_setting_race');
  f.binding.beforeBatch=({sqlite})=>sqlite.exec('UPDATE official_web_settings SET stale_enabled=1 WHERE id=1');
  await assert.rejects(executeAdminManagementMutation(bundle),/state_conflict/u);
  assert.deepEqual({...f.sqlite.prepare('SELECT enabled,stale_enabled FROM official_web_settings WHERE id=1').get()},{enabled:0,stale_enabled:1});
  assert.deepEqual(counts(f),{receipts:0,events:0,audit:0,guards:0});
});

test('lost commit response is reported as unknown and a fresh same-key acknowledgement cannot duplicate moderator events',async t=>{
  const f=await setup(t),payload=moderation('block',0),key='admin_miniapp_unknown_block';
  const bundle=await f.authorize('admin.user.moderation',payload,key),original=f.binding.batch.bind(f.binding);
  let lost=false;
  f.binding.batch=async statements=>{
    const result=await original(statements);
    if(!lost&&statements.some(s=>s.sql.startsWith('INSERT INTO mini_app_command_receipts'))) {
      lost=true;throw new Error('Connection lost after actual commit');
    }
    return result;
  };
  await assert.rejects(executeAdminManagementMutation(bundle),error=>error.code==='management_outcome_unknown'&&error.status===503);
  assert.equal(lost,true);assert.deepEqual(counts(f),{receipts:1,events:1,audit:1,guards:0});
  const fresh=await f.authorize('admin.user.moderation',payload,key);
  const replay=await executeAdminManagementMutation(fresh);
  assert.equal(replay.commitStatus,'unchanged');assert.deepEqual(counts(f),{receipts:1,events:1,audit:1,guards:0});
});

test('user list/search uses real moderator state, preserves delivery-health distinction and settings project only fixed editable keys',async t=>{
  const f=await setup(t);
  await executeAdminManagementMutation(await f.authorize('admin.user.moderation',moderation('block',0),'admin_miniapp_list_block'));
  f.sqlite.exec('UPDATE users SET is_blocked=1 WHERE telegram_id=303');
  const repo=f.repositoryFactory(f.env,{readOnly:true,accessScope:'admin'});
  const before=f.binding.audit.length;
  const blocked=await readAdminAuxiliarySection({repo,env:f.env,section:'users',params:{status:'blocked',limit:20,offset:0}});
  assert.equal(blocked.total,1);assert.equal(blocked.items[0].telegramId,101);assert.equal(blocked.items[0].isBlocked,true);
  const delivery=await readAdminAuxiliarySection({repo,env:f.env,section:'users',params:{query:'303',limit:20,offset:0}});
  assert.equal(delivery.total,1);assert.equal(delivery.items[0].isBlocked,false);assert.equal(delivery.items[0].deliveryUnavailable,true);
  const owner=await readAdminAuxiliarySection({repo,env:f.env,section:'users',params:{query:'900',limit:20,offset:0}});
  assert.equal(owner.items[0].canModerate,false);
  const settings=await readAdminAuxiliarySection({repo,env:f.env,section:'settings'});
  assert.deepEqual(settings.items.map(row=>row.key),['ai_rollout_mode','official_web_enabled','official_web_stale_enabled']);
  assert.ok(f.binding.audit.slice(before).every(row=>row.mode==='read'));
});

const approvedSources=f=>{
  f.env.AI={run:async()=>{throw new Error('Settings must never call the AI provider');}};
  f.sqlite.prepare(`INSERT INTO partner_programs(code,name,allowed_domains,official_url,status)
    VALUES('remote_program','Remote program','remote.example','https://remote.example/official','active')`).run();
  f.sqlite.prepare(`INSERT INTO ai_source_snapshots(program_code,source_url,content_hash,excerpt,status)
    VALUES('remote_program','https://remote.example/official',?,'Approved test source','approved')`).run('sha256:'+'a'.repeat(64));
};

test('public RE AI setting commits once with approved exact sources and replays remain acknowledgements after source loss',async t=>{
  const f=await setup(t);approvedSources(f);
  const before=f.sqlite.prepare('SELECT * FROM ai_runtime_settings WHERE id=1').get();
  const payload=setting('ai_rollout_mode','all','admin'),key='admin_remote_all_once';
  const changed=await executeAdminManagementMutation(await f.authorize('admin.settings.manage',payload,key));
  assert.equal(changed.commitStatus,'committed');assert.equal(changed.value,'all');
  const after=f.sqlite.prepare('SELECT * FROM ai_runtime_settings WHERE id=1').get();
  for(const field of ['model_name','public_daily_neurons_milli','admin_daily_neurons_milli','reserve_daily_neurons_milli',
    'user_daily_success_limit','response_character_limit'])assert.equal(after[field],before[field],field);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM admin_audit_log WHERE action='admin_runtime_setting_updated'").get().n,1);
  const unchanged=await executeAdminManagementMutation(await f.authorize('admin.settings.manage',setting('ai_rollout_mode','all','all'),'admin_remote_all_noop'));
  assert.equal(unchanged.commitStatus,'unchanged');
  f.sqlite.exec("UPDATE ai_source_snapshots SET status='stale';UPDATE ai_runtime_settings SET rollout_mode='off'");
  const replay=await executeAdminManagementMutation(await f.authorize('admin.settings.manage',payload,key));
  assert.equal(replay.commitStatus,'unchanged');assert.equal(replay.value,'all');
  assert.equal(f.sqlite.prepare('SELECT rollout_mode FROM ai_runtime_settings WHERE id=1').get().rollout_mode,'off','replay never re-enables a later disabled mode');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM admin_audit_log WHERE action='admin_runtime_setting_updated'").get().n,1);
  assert.deepEqual(counts(f),{receipts:2,events:0,audit:2,guards:0});
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ai_operation_journal').get().n,0);
  assert.deepEqual({...f.sqlite.prepare('SELECT state,beta_enabled,revision FROM mini_app_release_control').get()},
    {state:'closed',beta_enabled:0,revision:32});
});

for(const blocker of ['provider','no_programs','unapproved','wrong_url','second_program'])test('public RE AI expansion refuses '+blocker+' and still permits disabling',async t=>{
  const f=await setup(t);
  if(blocker==='no_programs')f.env.AI={run:async()=>{throw new Error('Unexpected provider call');}};
  else approvedSources(f);
  if(blocker==='provider') {
    delete f.env.AI;
    f.env.publicAiProviderConnected=true; // A primitive assertion never substitutes for the actual binding.
  }
  if(blocker==='unapproved')f.sqlite.exec("UPDATE ai_source_snapshots SET status='pending'");
  if(blocker==='wrong_url')f.sqlite.exec("UPDATE partner_programs SET official_url='https://remote.example/changed'");
  if(blocker==='second_program')f.sqlite.exec("INSERT INTO partner_programs(code,name,allowed_domains,official_url,status) VALUES('other_program','Other','other.example','https://other.example','active')");
  const repo=f.repositoryFactory(f.env,{readOnly:true,accessScope:'admin'}),settings=await readAdminAuxiliarySection({repo,env:f.env,section:'settings'});
  assert.equal(settings.publicEnablement.ready,false);
  assert.equal(settings.publicEnablement.reasonCode,{provider:'provider_unavailable',no_programs:'no_active_programs',
    unapproved:'sources_not_approved',wrong_url:'sources_not_approved',second_program:'sources_not_approved'}[blocker]);
  assert.deepEqual(settings.items.find(item=>item.key==='ai_rollout_mode').allowedValues,['off','admin','all']);
  await assert.rejects(executeAdminManagementMutation(await f.authorize('admin.settings.manage',setting('ai_rollout_mode','all','admin'),'admin_remote_refuse_'+blocker)),/prerequisite_required/u);
  assert.deepEqual(counts(f),{receipts:0,events:0,audit:0,guards:0});
  const off=await executeAdminManagementMutation(await f.authorize('admin.settings.manage',setting('ai_rollout_mode','off','admin'),'admin_remote_disable_'+blocker));
  assert.equal(off.commitStatus,'committed');assert.equal(off.value,'off');
});

for(const change of ['source_status','source_url','active_program','setting'])test('public RE AI expansion atomically rolls back after late '+change+' change',async t=>{
  const f=await setup(t);approvedSources(f);
  const bundle=await f.authorize('admin.settings.manage',setting('ai_rollout_mode','all','admin'),'admin_remote_all_race_'+change);
  assert.equal(runtimeAuthorizationDTO(bundle).allowed,true);
  f.binding.beforeBatch=({sqlite})=>sqlite.exec({
    source_status:"UPDATE ai_source_snapshots SET status='rejected'",
    source_url:"UPDATE partner_programs SET official_url='https://remote.example/changed'",
    active_program:"INSERT INTO partner_programs(code,name,allowed_domains,official_url,status) VALUES('later_program','Later','later.example','https://later.example','active')",
    setting:"UPDATE ai_runtime_settings SET rollout_mode='off'",
  }[change]);
  await assert.rejects(executeAdminManagementMutation(bundle),/state_conflict/u);
  assert.equal(f.sqlite.prepare('SELECT rollout_mode FROM ai_runtime_settings WHERE id=1').get().rollout_mode,change==='setting'?'off':'admin');
  assert.deepEqual(counts(f),{receipts:0,events:0,audit:0,guards:0});
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM admin_audit_log').get().n,0);
});

test('public RE AI expansion does not admit a non-owner role or an unconfirmed setting',async t=>{
  const f=await setup(t);approvedSources(f);
  for(const [payload,customEnv,key] of [
    [{...setting('ai_rollout_mode','all','admin'),confirmed:false},f.env,'admin_remote_all_unconfirmed'],
    [setting('ai_rollout_mode','all','admin'),{...f.env,OWNER_TELEGRAM_ID:'101',ADMIN_ID:'900'},'admin_remote_all_nonowner'],
  ])await assert.rejects(async()=>executeAdminManagementMutation(await f.authorize('admin.settings.manage',payload,key,customEnv)));
  assert.equal(f.sqlite.prepare('SELECT rollout_mode FROM ai_runtime_settings WHERE id=1').get().rollout_mode,'admin');
  assert.deepEqual(counts(f),{receipts:0,events:0,audit:0,guards:0});
});
