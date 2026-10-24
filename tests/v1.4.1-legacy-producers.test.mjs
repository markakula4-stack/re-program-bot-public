import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {foundationFixture} from './helpers/v1.4.1-fixtures.mjs';
import {approvedPartner} from './helpers/v1.4.0-rebuild-sqlite.mjs';
import {createCustomerContext} from '../src/v1.4.1/trusted-context.mjs';
import {authorizeTelegramHandler,authorizeLegacyTelegramFlow} from '../src/v1.4.1/telegram-runtime.mjs';
import {runtimeAuthorizationDTO,assertRuntimeAuthorizationFresh} from '../src/v1.4.1/runtime-authorizer.mjs';
import {prepareLegacyCompatibility,readLegacyCompatibility,bindLegacyCompatibilityEnv} from '../src/v1.4.1/telegram-legacy-compatibility.mjs';
import {runReferralRewardAdminRepair} from '../src/v1.3.7/referral-reward-ux-admin-runtime.mjs';

let sequence=1_417_000;
const secret='fictional-p06-producer-webhook-secret';
function setup(t){
  const f=foundationFixture(t);
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  f.serverEnv={...f.serverEnv,V141_AUTHORIZATION_ENABLED:'true',WEBHOOK_SECRET:secret,STARS_RECONCILIATION_ENABLED:'true'};
  return f;
}
async function selected(f,id,selector,{message=false,flow=false}={}){
  const updateId=++sequence,claim='fictional_producer_claim_'+updateId;
  const update={update_id:updateId,...(message?{message:{date:f.now,from:{id,is_bot:false},chat:{id,type:'private'},text:selector}}:
    {callback_query:{id:'fictional_callback_'+updateId,from:{id,is_bot:false},message:{from:{id:123456789,is_bot:true},chat:{id,type:'private'}},data:selector}})};
  f.sqlite.prepare("INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,attempt_count,received_at,lease_expires_at) VALUES(?,?,?,'processing',?,1,?,?)")
    .run(updateId,message?'message':'callback_query',id,claim,f.now,f.now+300);
  const request=new Request('https://bot.example/webhook',{method:'POST',headers:{'Content-Type':'application/json',
    'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(update)});
  const context=await createCustomerContext({binding:f.binding,env:f.serverEnv,webhookRequest:request,receiptClaimToken:claim,
    channel:message?'telegram_command':'telegram_callback',operation:'account.menu.read',nowSeconds:f.now});
  const result=await (flow?authorizeLegacyTelegramFlow:authorizeTelegramHandler)(context,update);
  assert.ok(result);assert.equal(runtimeAuthorizationDTO(result.authorization).allowed,true);
  await assertRuntimeAuthorizationFresh(result.authorization);
  return result;
}
const adminFlow=(f,action,step,payload={},offerCode=null)=>f.sqlite.prepare(
  "INSERT INTO admin_sessions(telegram_id,action,step,offer_code,payload_json,updated_at) VALUES(900,?,?,?,?,datetime(?,'unixepoch')) ON CONFLICT(telegram_id) DO UPDATE SET action=excluded.action,step=excluded.step,offer_code=excluded.offer_code,payload_json=excluded.payload_json,updated_at=excluded.updated_at")
  .run(action,step,offerCode,JSON.stringify(payload),f.now);

test('typed system creation and actual existing system status/edit are reachable; partner content and nonowner stay denied',async t=>{
  const f=setup(t);
  const create=await selected(f,900,'/offer_add fictional_new | Открыть | Тест | https://bank.example/',{message:true});
  const permit=await prepareLegacyCompatibility(create.authorization,{family:'admin.catalog.manage'});
  await readLegacyCompatibility(permit).binding.prepare("INSERT INTO offers(code,button_text,title,url,status) VALUES(?,?,?,?,'draft')")
    .bind('fictional_new','Открыть','Тест','https://bank.example/').run();
  await selected(f,900,'admin_offer_status:fictional_new:paused');
  await selected(f,900,'/offer_set fictional_new title Новый заголовок',{message:true});
  const p=await approvedPartner(f,202);
  f.sqlite.exec("INSERT INTO offers(code,button_text,title,status) VALUES('fictional_partner','Тест','Тест','draft')");
  f.sqlite.prepare("INSERT INTO offer_owners(offer_code,owner_kind,partner_profile_id,created_by) VALUES('fictional_partner','partner',?,202)").run(p.profileId);
  await assert.rejects(selected(f,900,'admin_offer_status:fictional_partner:paused'));
  await assert.rejects(selected(f,101,'admin_offer_status:fictional_new:paused'));
});

test('system creation and edit plaintext take the actual own flow target and reject changed captured state',async t=>{
  const f=setup(t);
  adminFlow(f,'create_offer','url',{code:'fictional_flow',button_text:'Открыть',title:'Тест',category:'other'},'fictional_flow');
  const create=await selected(f,900,'https://bank.example/',{message:true,flow:true});
  f.sqlite.exec("UPDATE admin_sessions SET offer_code='different_code' WHERE telegram_id=900");
  await assert.rejects(assertRuntimeAuthorizationFresh(create.authorization),/authority_stale/u);
  f.sqlite.exec("INSERT INTO offers(code,button_text,title,status) VALUES('fictional_flow','Тест','Тест','draft')");
  adminFlow(f,'edit_offer','title',{},'fictional_flow');
  await selected(f,900,'Изменённый заголовок',{message:true,flow:true});
});

test('partner link actual own URL stage, confirm and admin review retain canonical target/domain and foreign ownership fences',async t=>{
  const f=setup(t),p=await approvedPartner(f,202);
  f.sqlite.prepare('DELETE FROM partner_links WHERE id=?').run(p.linkId);
  await selected(f,202,'partner_link_offer:17');
  f.sqlite.prepare("INSERT INTO partner_sessions(telegram_id,action,step,payload_json) VALUES(202,'submit_partner_link','url',?)")
    .run(JSON.stringify({catalogOfferId:17}));
  const url='https://go.bank.example/path?ref=fictional';
  await selected(f,202,url,{message:true,flow:true});
  await assert.rejects(selected(f,202,'https://foreign.example/',{message:true,flow:true}));
  f.sqlite.prepare("UPDATE partner_sessions SET step='confirm',payload_json=? WHERE telegram_id=202")
    .run(JSON.stringify({catalogOfferId:17,url}));
  await selected(f,202,'partner_link_submit_confirm');
  f.sqlite.prepare("INSERT INTO partner_links(id,partner_profile_id,catalog_offer_id,url,tracking_key,ownership_confirmed,traffic_confirmed,status) VALUES(1417,?,17,?,'fictional_new_link',1,1,'pending')")
    .run(p.profileId,url);
  await selected(f,900,'admin_partner_link_approve:1417');
  await assert.rejects(selected(f,303,'partner_link_pause:1417'));
  adminFlow(f,'review_partner_link_reject','reason',{partnerLinkId:1417});
  await selected(f,900,'Исправьте источник ссылки',{message:true,flow:true});
});

test('own broadcast preparation/send/continue and actual release pause are distinguished from a foreign actor draft',async t=>{
  const f=setup(t);
  f.sqlite.exec('INSERT OR IGNORE INTO admin_broadcast_release_gate(id,paused,updated_at) VALUES(1,0,0)');
  adminFlow(f,'compose_broadcast','message');
  await selected(f,900,'Тестовое сообщение',{message:true,flow:true});
  f.sqlite.exec("INSERT INTO admin_broadcasts(id,actor_id,message_text,status) VALUES(1417,900,'Тест','draft'),(1418,101,'Чужое','draft')");
  await selected(f,900,'admin_broadcast_send:1417');
  await assert.rejects(selected(f,900,'admin_broadcast_send:1418'));
  f.sqlite.exec("UPDATE admin_broadcasts SET status='sending' WHERE id=1417");
  await selected(f,900,'admin_broadcast_continue:1417');
  f.sqlite.exec('UPDATE admin_broadcast_release_gate SET paused=1 WHERE id=1');
  await assert.rejects(selected(f,900,'admin_broadcast_continue:1417'));
});

test('settings and Stars reconciliation use fixed current settings/source and hard off flags',async t=>{
  const f=setup(t);
  f.sqlite.exec("INSERT OR IGNORE INTO ai_runtime_settings(id) VALUES(1); INSERT OR IGNORE INTO official_web_settings(id) VALUES(1)");
  await selected(f,900,'admin_ai_mode:off');
  await selected(f,900,'admin_ow_toggle:enabled:0');
  await selected(f,900,'/sync_menu',{message:true});
  await selected(f,900,'admin_stars_reconcile');
  f.serverEnv.STARS_RECONCILIATION_ENABLED='false';
  await assert.rejects(selected(f,900,'admin_stars_reconcile'));
  f.sqlite.exec('UPDATE users SET is_blocked=1 WHERE telegram_id=900');
  await assert.rejects(selected(f,900,'admin_ai_mode:off'));
});

test('moderation confirmation uses exact own unexpired session and same target revision',async t=>{
  const f=setup(t);f.serverEnv.ADMIN_MODERATION_ENABLED='true';
  assert.equal((await selected(f,900,'/admin_block',{message:true})).handler.capability,'admin.cabinet.open');
  assert.equal((await selected(f,900,'/admin_blocks',{message:true})).handler.capability,'admin.cabinet.open');
  f.sqlite.exec('INSERT OR IGNORE INTO admin_safety_runtime_settings(id,updated_at) VALUES(1,1)');
  f.sqlite.prepare("INSERT INTO admin_moderation_sessions(admin_telegram_id,step,target_telegram_id,reason,expires_at,created_at,updated_at) VALUES(900,'confirm',101,'Причина проверки',?,?,?)")
    .run(f.now+300,f.now,f.now);
  await selected(f,900,'h138:block:confirm');
  f.sqlite.prepare("INSERT INTO user_moderation_blocks(target_telegram_id,status,reason,blocked_by,blocked_at,revision) VALUES(101,'active','Причина проверки',900,?,1)")
    .run(f.now);
  await selected(f,900,'h138:unblock:ok:101:1');
  await assert.rejects(selected(f,900,'h138:unblock:ok:101:2'));
  f.serverEnv.ADMIN_MODERATION_ENABLED='false';
  await assert.rejects(selected(f,900,'h138:unblock:ok:101:1'));
});

test('legacy confirm and paid bind a real user plus exact offer; missing target and nonowner cannot repair results',async t=>{
  const f=setup(t);
  f.sqlite.exec("INSERT INTO offers(code,button_text,title,status) VALUES('fictional_result','Тест','Тест','draft')");
  const a=await selected(f,900,'/confirm 101 fictional_result 12,50',{message:true});
  const permit=await prepareLegacyCompatibility(a.authorization,{family:'admin.result.repair'});
  await readLegacyCompatibility(permit).binding.prepare("INSERT INTO conversions(telegram_id,offer_code,status,reward_kopecks) VALUES(?,?,'confirmed',?)")
    .bind(101,'fictional_result',1250).run();
  await selected(f,900,'/paid 101 fictional_result',{message:true});
  await assert.rejects(selected(f,900,'/confirm 999 fictional_result 12',{message:true}));
  await assert.rejects(selected(f,303,'/paid 101 fictional_result',{message:true}));
});

test('fixed referral maintenance selects bounded real empty queues and rejects a nonowner',async t=>{
  const f=setup(t);
  const a=await selected(f,900,'admin_referral_repair');
  const permit=await prepareLegacyCompatibility(a.authorization,{family:'admin.result.repair'});
  const env=bindLegacyCompatibilityEnv(permit,{...f.serverEnv,DB:f.binding});
  const result=await runReferralRewardAdminRepair(env,{at:f.now});
  assert.equal(result.status,'completed');
  await assert.rejects(selected(f,101,'admin_referral_repair'));
});
