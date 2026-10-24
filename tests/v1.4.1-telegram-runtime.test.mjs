import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {foundationFixture} from './helpers/v1.4.1-fixtures.mjs';
import {ORIGIN,approvedPartner} from './helpers/v1.4.0-rebuild-sqlite.mjs';
import {createCustomerContext,deriveTrustedOperationContext,readTrustedContext} from '../src/v1.4.1/trusted-context.mjs';
import {createRuntimeAuthorizer,readRuntimeAuthorization,runtimeAuthorizationDTO} from '../src/v1.4.1/runtime-authorizer.mjs';
import {resolveTelegramHandler,TELEGRAM_HANDLER_REGISTRY} from '../src/v1.4.1/handler-registry.mjs';
import {authorizeTelegramHandler,executeLegacyTelegramMutation,executeTelegramFlowState,assertTelegramPresentationFresh} from '../src/v1.4.1/telegram-runtime.mjs';
import {createTelegramCabinet} from '../src/v1.4.0-rebuild/telegram-cabinet.mjs';
import {readResourceFacts} from '../src/v1.4.1/resource-resolver.mjs';

let sequence=1_415_000;
const secret='offline-telegram-webhook-secret-more-than-sixteen';
const setup=t=>{const f=foundationFixture(t);f.serverEnv={...f.serverEnv,WEBHOOK_SECRET:secret,V141_AUTHORIZATION_ENABLED:'true'};return f;};
const update=(f,id,selector,command=false)=>({update_id:++sequence,...(command?{message:{date:f.now,from:{id,is_bot:false},chat:{id,type:'private'},text:selector}}:
  {callback_query:{id:'offline_callback_'+sequence,from:{id,is_bot:false},message:{from:{id:123456789,is_bot:true},chat:{id,type:'private'}},data:selector}})});
const request=body=>new Request(ORIGIN+'/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(body)});
async function authorization(f,id,selector,command=false) {
  const body=update(f,id,selector,command),claim='offline_claim_'+body.update_id;
  f.sqlite.prepare("INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,attempt_count,received_at,lease_expires_at) VALUES(?,?,?,'processing',?,1,?,?)")
    .run(body.update_id,command?'message':'callback_query',id,claim,f.now,f.now+300);
  const context=await createCustomerContext({binding:f.binding,env:f.serverEnv,webhookRequest:request(body),receiptClaimToken:claim,
    channel:command?'telegram_command':'telegram_callback',operation:'account.menu.read',nowSeconds:f.now});
  const selected=await authorizeTelegramHandler(context,body);
  return {...selected,context,body};
}
const receipts=f=>f.sqlite.prepare('SELECT COUNT(*) AS n FROM mini_app_command_receipts').get().n;
const audits=f=>f.sqlite.prepare('SELECT COUNT(*) AS n FROM entitlement_decision_audit').get().n;
const guards=f=>f.sqlite.prepare('SELECT COUNT(*) AS n FROM mini_app_atomic_guards').get().n;

test('compiled registry preserves real selectors, distinguishes read confirmations and never grants unknown namespaces',()=>{
  const callback=data=>resolveTelegramHandler({callback_query:{data}});
  for(const selector of ['admin_analytics_v2','admin_ambassadors_v2','offers_cat:all:0','stars_buy:terms','admin_pbg_ask:2']) assert.ok(callback(selector),selector);
  assert.equal(callback('stars_buy:terms').capability,'billing.payment_help');
  assert.equal(callback('admin_pbg_ask:2').capability,'admin.cabinet.open');
  assert.equal(callback('admin_offer_status:abc:paused').capability,'admin.catalog.manage');
  for(const selector of ['admin_future_write','admin_poq:invented:0','a139r:future','crm.create','offer.create_private','admin_entitlement_manage','r14:future:abc:0:0:abcdefghijklmnop']) assert.equal(callback(selector),null,selector);
  assert.ok(TELEGRAM_HANDLER_REGISTRY.length>=190);
  assert.equal(resolveTelegramHandler({message:{text:'/cabinet_result 9007199254740993 mark_paid'}}),null);
});

test('actual verified webhook claim is mandatory; different update, actor and copied context cannot authorize a compiled selector',async t=>{
  const f=setup(t),a=await authorization(f,101,'menu');
  assert.equal(runtimeAuthorizationDTO(a.authorization).allowed,true);
  await assert.rejects(authorizeTelegramHandler(a.context,{...a.body,update_id:a.body.update_id+1}),/telegram_operation_binding_mismatch/u);
  await assert.rejects(authorizeTelegramHandler(a.context,{...a.body,callback_query:{...a.body.callback_query,from:{id:303}}}),/telegram_operation_binding_mismatch/u);
  await assert.rejects(authorizeTelegramHandler(JSON.parse(JSON.stringify(a.context)),a.body),/untrusted_context/u);
  f.sqlite.prepare("UPDATE telegram_update_receipts SET status='completed' WHERE update_id=?").run(a.body.update_id);
  await assert.rejects(assertTelegramPresentationFresh(a.authorization),/authority_stale/u);
  assert.equal(receipts(f),0);assert.equal(audits(f),0);
});

test('terms acceptance uses actual preregistration exception and commits one policy audit and stable receipt',async t=>{
  const f=setup(t);f.sqlite.prepare('UPDATE users SET accepted_terms=0 WHERE telegram_id=101').run();
  const a=await authorization(f,101,'accept_terms');
  const result=await executeLegacyTelegramMutation(a.authorization);
  assert.equal(result.committed,true);assert.equal(f.sqlite.prepare('SELECT accepted_terms AS n FROM users WHERE telegram_id=101').get().n,1);
  assert.equal(receipts(f),1);assert.equal(audits(f),1);assert.equal(guards(f),0);
  const fresh=await authorizeTelegramHandler(a.context,a.body);
  assert.equal((await executeLegacyTelegramMutation(fresh.authorization)).replayed,true);
  assert.equal(receipts(f),1);assert.equal(audits(f),1);
});

test('own notification single and bulk mutations retain recipient boundaries and do not touch foreign notifications',async t=>{
  const f=setup(t);
  f.sqlite.exec("INSERT INTO notifications(id,recipient_id,event_type,message_html) VALUES(1,101,'notice','own'),(2,303,'notice','foreign');");
  const foreign=update(f,101,'notification_archive:2');
  await assert.rejects(authorization(f,101,'notification_archive:2'),/resource_unavailable/u);
  const own=await authorization(f,101,'notification_archive:1');await executeLegacyTelegramMutation(own.authorization);
  assert.equal(f.sqlite.prepare('SELECT is_read AS n FROM notifications WHERE id=1').get().n,1);
  assert.ok(f.sqlite.prepare('SELECT archived_at AS value FROM notifications WHERE id=1').get().value);
  const bulk=await authorization(f,101,'notifications_read_all');await executeLegacyTelegramMutation(bulk.authorization);
  assert.deepEqual({...f.sqlite.prepare('SELECT is_read,archived_at FROM notifications WHERE id=2').get()},{is_read:0,archived_at:null});
  assert.equal(receipts(f),2);assert.equal(audits(f),2);assert.equal(guards(f),0);
  assert.ok(foreign.update_id);
});

for(const change of ['actor_block','claim_replaced','target_recipient','policy_flag']) {
  test('same-batch notification proof rolls back effect, receipt and audit after '+change,async t=>{
    const f=setup(t);f.sqlite.exec("INSERT INTO notifications(id,recipient_id,event_type,message_html) VALUES(1,101,'notice','own')");
    const a=await authorization(f,101,'notification_archive:1');
    const sql={actor_block:'UPDATE users SET is_blocked=1 WHERE telegram_id=101',
      claim_replaced:"UPDATE telegram_update_receipts SET claim_token='new_claim'",
      target_recipient:'UPDATE notifications SET recipient_id=303 WHERE id=1',
      policy_flag:"INSERT INTO feature_flags(flag_key,policy_version,enabled,emergency_disabled,reason,updated_at) SELECT 'capability:notification.manage_own',policy_version,0,1,'offline emergency change',unixepoch() FROM capability_catalog WHERE capability='notification.manage_own'"}[change];
    f.binding.beforeBatch=()=>f.sqlite.exec(sql);
    await assert.rejects(executeLegacyTelegramMutation(a.authorization));
    assert.equal(f.sqlite.prepare('SELECT is_read AS n FROM notifications WHERE id=1').get().n,0);
    assert.equal(f.sqlite.prepare('SELECT archived_at AS value FROM notifications WHERE id=1').get().value,null);
    assert.equal(receipts(f),0);assert.equal(audits(f),0);assert.equal(guards(f),0);
  });
}

test('push toggle is based on the actual current setting, rejects a concurrent setting change, and replay cannot toggle twice',async t=>{
  const f=setup(t);f.sqlite.exec('INSERT INTO notification_settings(telegram_id,telegram_enabled) VALUES(101,1),(303,1)');
  const a=await authorization(f,101,'notifications_toggle_push');await executeLegacyTelegramMutation(a.authorization);
  assert.equal(f.sqlite.prepare('SELECT telegram_enabled AS n FROM notification_settings WHERE telegram_id=101').get().n,0);
  const fresh=await authorizeTelegramHandler(a.context,a.body);await executeLegacyTelegramMutation(fresh.authorization);
  assert.equal(f.sqlite.prepare('SELECT telegram_enabled AS n FROM notification_settings WHERE telegram_id=101').get().n,0);
  const second=await authorization(f,101,'notifications_toggle_push');
  f.binding.beforeBatch=()=>f.sqlite.prepare('UPDATE notification_settings SET telegram_enabled=1 WHERE telegram_id=101').run();
  await assert.rejects(executeLegacyTelegramMutation(second.authorization));
  assert.equal(f.sqlite.prepare('SELECT telegram_enabled AS n FROM notification_settings WHERE telegram_id=101').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT telegram_enabled AS n FROM notification_settings WHERE telegram_id=303').get().n,1);
  assert.equal(receipts(f),1);assert.equal(audits(f),1);
});

test('local AI consent/settings/memory plans never invoke a model or use a model quota',async t=>{
  const f=setup(t);
  const enabled=await authorization(f,101,'ai_enable');await assert.rejects(executeLegacyTelegramMutation(enabled.authorization),/consent_required/u);
  const consent=await authorization(f,101,'ai_consent_accept');await executeLegacyTelegramMutation(consent.authorization);
  assert.equal(f.sqlite.prepare('SELECT ai_enabled AS n FROM user_access WHERE telegram_id=101').get().n,1);
  f.sqlite.exec("INSERT INTO ai_conversation_messages(telegram_id,role,content) VALUES(101,'user','own'),(303,'user','foreign')");
  const revoke=await authorization(f,101,'ai_consent_revoke');await executeLegacyTelegramMutation(revoke.authorization);
  assert.equal(f.sqlite.prepare('SELECT ai_enabled AS n FROM user_access WHERE telegram_id=101').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM ai_conversation_messages WHERE telegram_id=101').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM ai_conversation_messages WHERE telegram_id=303').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM ai_usage_events').get().n,0);
  assert.equal(receipts(f),2);assert.equal(audits(f),2);
});

test('flow cancellation clears only the authenticated subject and rejects forged SQL/capability fields',async t=>{
  const f=setup(t);f.sqlite.exec("INSERT INTO partner_sessions(telegram_id,action,step) VALUES(101,'offer_edit','title'),(303,'partner_link','url')");
  const a=await authorization(f,101,'/cancel',true);await executeLegacyTelegramMutation(a.authorization);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM partner_sessions WHERE telegram_id=101').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM partner_sessions WHERE telegram_id=303').get().n,1);
  const next=await authorization(f,101,'/cancel',true);
  const context=await deriveTrustedOperationContext(next.context,{operation:'flow.cancel_own',requestPayload:{sql:'DELETE FROM users'}});
  const bundle=await createRuntimeAuthorizer().authorize(context);
  await assert.rejects(executeLegacyTelegramMutation(bundle),/invalid_intent/u);
  await assert.rejects(executeLegacyTelegramMutation({...bundle}),/untrusted_runtime_authorization/u);
});

test('short SDK batch response is an unverified outcome and a fresh stable receipt prevents a duplicate effect',async t=>{
  const f=setup(t);const a=await authorization(f,101,'notifications_toggle_push');
  const original=f.binding.batch.bind(f.binding);
  f.binding.batch=async statements=>(await original(statements)).slice(0,-1);
  await assert.rejects(executeLegacyTelegramMutation(a.authorization),/authority_outcome_unverified/u);
  f.binding.batch=original;
  assert.equal(receipts(f),1);assert.equal(audits(f),1);assert.equal(guards(f),0);
  const refreshed=await authorizeTelegramHandler(a.context,a.body);
  assert.equal((await executeLegacyTelegramMutation(refreshed.authorization)).replayed,true);
  assert.equal(f.sqlite.prepare('SELECT telegram_enabled AS n FROM notification_settings WHERE telegram_id=101').get().n,0);
});

test('existing permanent admin cabinet reaches central authorization and preserves its actual signed Beta effect',async t=>{
  const f=setup(t);f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  await approvedPartner(f,303);
  const profile=f.sqlite.prepare('SELECT id FROM partner_profiles WHERE telegram_id=303').get();
  f.sqlite.prepare('DELETE FROM partner_beta_access WHERE partner_profile_id=?').run(profile.id);
  const source='a'.repeat(40);
  const env={...f.serverEnv,REBUILD_V140_TELEGRAM_ENABLED:'true',REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',
    REBUILD_V140_ADMIN_BETA_GRANTS_ENABLED:'true',REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',REBUILD_V140_RC_SHA:source,
    REBUILD_V140_RELEASE_REVISION:'5',REBUILD_V140_OWNER_WINDOW:'false',REBUILD_V140_OWNER_TELEGRAM_ID:'0',REBUILD_V140_BETA_ENABLED:'false'};
  f.sqlite.prepare("INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,updated_at) VALUES(1,?,5,'closed',0,?)").run(source,f.now);
  const calls=[],handle=createTelegramCabinet({clock:()=>f.now,fetchImpl:async(url,options)=>{calls.push({method:url.split('/').at(-1),body:JSON.parse(options.body)});return Response.json({ok:true});}});
  const opened=update(f,900,'/cabinet_admin',true);await handle(request(opened),env);
  const menu=calls.find(row=>row.method==='sendMessage');assert.ok(menu,'actual enabled admin menu');
  const callback=menu.body.reply_markup.inline_keyboard.flat().find(row=>row.text.includes('Выдать Beta'))?.callback_data;assert.ok(callback);
  const granted=update(f,900,callback);await handle(request(granted),env);
  assert.equal(f.sqlite.prepare('SELECT access_status AS status FROM partner_beta_access WHERE partner_profile_id=?').get(profile.id)?.status,'active');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM partner_beta_access_events WHERE partner_profile_id=?').get(profile.id).n,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM mini_app_sessions').get().n,2,'existing partner fixture sessions only, no admin session minted');
  assert.ok(f.binding.audit.some(row=>row.sql.includes('capability_catalog')),'actual central policy read');
  assert.equal(f.sqlite.prepare('SELECT status FROM telegram_update_receipts WHERE update_id=?').get(granted.update_id).status,'completed');
  const count=calls.length;await handle(request(granted),env);assert.equal(calls.length,count);
});

test('fixed existing admin flow stages only the current canonical administrator and a changed own row rolls back',async t=>{
  const f=setup(t),admin=await authorization(f,900,'/admin',true);
  const session={action:'review_lead_reject',step:'reason',offerCode:'abc',payload:{leadId:1}};
  await executeTelegramFlowState(admin.context,{kind:'admin',mode:'set',session});
  assert.equal(f.sqlite.prepare('SELECT action FROM admin_sessions WHERE telegram_id=900').get().action,'review_lead_reject');
  const user=await authorization(f,101,'menu');
  await assert.rejects(executeTelegramFlowState(user.context,{kind:'admin',mode:'set',session}),/role_required|resource_unavailable/u);
  const next=await authorization(f,900,'/admin',true);
  let injected=false;
  const concurrentChange=({statements})=>{
    if(!statements.some(statement=>statement.sql==='DELETE FROM admin_sessions WHERE telegram_id=?')) {
      f.binding.beforeBatch=concurrentChange;return;
    }
    injected=true;
    f.sqlite.prepare("UPDATE admin_sessions SET step='concurrent' WHERE telegram_id=900").run();
  };
  f.binding.beforeBatch=concurrentChange;
  await assert.rejects(executeTelegramFlowState(next.context,{kind:'admin',mode:'clear'}));
  assert.equal(injected,true,'concurrent change occurs immediately before the guarded write batch');
  assert.equal(f.sqlite.prepare('SELECT step FROM admin_sessions WHERE telegram_id=900').get().step,'concurrent');
  assert.equal(receipts(f),1);assert.equal(audits(f),1);assert.equal(guards(f),0);
  await assert.rejects(executeTelegramFlowState(admin.context,{kind:'admin',mode:'set',session:{...session,action:'future_grant'}}),/unknown_flow_action/u);
});

test('partner edit staging uses actual owned offer capability and cannot stage a foreign offer or an arbitrary table',async t=>{
  const f=setup(t);await approvedPartner(f,202);
  await f.call(202,'partner/legal-profile',{method:'POST',payload:{profileKind:'individual',selfDeclarationAccepted:true}});
  const created=await f.call(202,'offers',{method:'POST',payload:{}});assert.equal(created.status,200);
  const before=receipts(f);
  const owner=await authorization(f,202,'menu'),session={action:'edit_partner_offer',step:'title',payload:{offerCode:created.data.offerCode,alias:'ti'}};
  await executeTelegramFlowState(owner.context,{kind:'partner',mode:'set',session});
  assert.equal(f.sqlite.prepare('SELECT action FROM partner_sessions WHERE telegram_id=202').get().action,'edit_partner_offer');
  const foreign=await authorization(f,303,'menu');
  await assert.rejects(executeTelegramFlowState(foreign.context,{kind:'partner',mode:'set',session}),/role_required|resource_unavailable/u);
  await assert.rejects(executeTelegramFlowState(owner.context,{kind:'users',mode:'clear'}),/invalid_flow_state/u);
  assert.equal(receipts(f),before+1);
  assert.equal(guards(f),0);
});
