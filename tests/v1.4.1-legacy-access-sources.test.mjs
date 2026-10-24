import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {foundationFixture} from './helpers/v1.4.1-fixtures.mjs';
import {createCustomerContext} from '../src/v1.4.1/trusted-context.mjs';
import {createAuthorityResolver,authoritySeconds} from '../src/v1.4.1/authority-resolver.mjs';
import {resolveLegacyAccessSources,readLegacyAccessSourceFacts,readLegacyAccessSourceContext,
  compileLegacyAccessSourceAssertions,isLegacyAccessSource} from '../src/v1.4.1/legacy-access-sources.mjs';

import {acceptStarsPurchaseTerms,issueStarsPurchase,handleStarsCommerceUpdate} from '../src/v1.3.6/stars-commerce-runtime.mjs';
import {createReferralRewardCandidate} from '../src/v1.3.7/referral-reward-candidate-runtime.mjs';
import {settleReferralRewardProtection} from '../src/v1.3.7/referral-reward-protection-runtime.mjs';
import {ensureReferralBonusGrant,claimReferralBonusAccess,runReferralBonusMaintenance} from '../src/v1.3.7/referral-bonus-access-runtime.mjs';
import {createRuntimeAuthorizer,runtimeAuthorizationDTO} from '../src/v1.4.1/runtime-authorizer.mjs';
import {prepareLegacyCompatibility,bindLegacyCompatibilityEnv} from '../src/v1.4.1/telegram-legacy-compatibility.mjs';
import {authorizeTelegramHandler} from '../src/v1.4.1/telegram-runtime.mjs';

let sequence=1_416_900;
const config={DRAGON_PREVIEW_ENABLED:'true',DRAGON_PREVIEW_CHANNEL_ID:'@official_preview',DRAGON_PREVIEW_CHANNEL_URL:'https://t.me/official_preview',
  DRAGON_PREVIEW_PROGRAM_END_AT:'2027-10-01T00:00:00Z',DRAGON_PREVIEW_ANTI_ABUSE_RETENTION_DAYS:'90',
  DRAGON_PREVIEW_ANTI_ABUSE_SECRET:'offline-access-source-secret-with-at-least-32-characters'};
async function callback(f,operation,id=101,patch={}){
  const env={...f.serverEnv,...config,...patch,WEBHOOK_SECRET:'offline-access-source-webhook-secret'};
  const update={update_id:++sequence,callback_query:{id:'access_source_'+sequence,from:{id,is_bot:false},
    message:{from:{id:123456789,is_bot:true},chat:{id,type:'private'}},data:operation==='preview.activate_own'?'dragon_preview_check':'referral_bonus_claim'}};
  const claim='access_source_claim_'+sequence;
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,attempt_count,received_at,lease_expires_at)
    VALUES(?,'callback_query',?,'processing',?,1,?,?)`).run(update.update_id,id,claim,f.now,f.now+300);
  return createCustomerContext({binding:f.binding,env,webhookRequest:new Request('https://bot.example/webhook',{method:'POST',
    headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET},body:JSON.stringify(update)}),
    receiptClaimToken:claim,channel:'telegram_callback',operation,requestPayload:{},nowSeconds:f.now});
}
async function fingerprint(id){
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(config.DRAGON_PREVIEW_ANTI_ABUSE_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('dragon_preview:'+id)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
async function source(f,context){const actor=await createAuthorityResolver().resolveActor(context);return resolveLegacyAccessSources({context,actor});}
async function assertSource(f,value,expected){for(const p of compileLegacyAccessSourceAssertions(value).assertions){
  const row=await f.binding.prepare(`SELECT CASE WHEN (${p.sql}) THEN 1 ELSE 0 END AS valid`).bind(...p.params).first();
  if(row.valid!==1){assert.equal(expected,0);return;}}assert.equal(expected,1);}

test('Preview requires a real current stored eligible membership check and captured absence; source module is read-only',async t=>{
  const f=foundationFixture(t);f.sqlite.function('unixepoch',{deterministic:false,varargs:true},(...args)=>args.length===0||args[0]==='now'?f.now:authoritySeconds(args[0]));
  f.sqlite.prepare('UPDATE users SET joined_at=? WHERE telegram_id=101').run(new Date((f.now-1)*1000).toISOString().slice(0,19).replace('T',' '));
  const context=await callback(f,'preview.activate_own');const absent=await source(f,context);
  assert.equal(readLegacyAccessSourceFacts(absent).domain.handlerUnavailable,true);
  const fp=await fingerprint(101);
  f.sqlite.prepare(`INSERT INTO trial_eligibility_checks(check_id,telegram_id,subject_fingerprint,program_code,outcome,channel_status,checked_at)
    VALUES('offline_actual_eligibility',101,?,'dragon_preview','eligible','member',?)`).run(fp,f.now);
  f.binding.audit.length=0;const eligible=await source(f,context),facts=readLegacyAccessSourceFacts(eligible);
  assert.equal(facts.domain.previewEligible,true);assert.equal(facts.domain.membershipVerified,true);assert.equal(facts.domain.explicitActivation,true);
  assert.equal(facts.domain.handlerUnavailable,false);assert.equal(facts.validUntil,f.now+60);
  assert.equal(isLegacyAccessSource(eligible),true);assert.equal(isLegacyAccessSource({...eligible}),false);
  assert.equal(readLegacyAccessSourceContext(eligible),context);assert.ok(f.binding.audit.every(item=>item.mode==='read'));
  await assertSource(f,eligible,1);
  f.sqlite.exec("UPDATE trial_eligibility_checks SET outcome='not_member' WHERE check_id='offline_actual_eligibility'");
  await assertSource(f,eligible,0);assert.equal(readLegacyAccessSourceFacts(await source(f,context)).domain.handlerUnavailable,true);
  f.sqlite.exec("UPDATE trial_eligibility_checks SET outcome='eligible',subject_fingerprint='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE check_id='offline_actual_eligibility'");
  assert.equal(readLegacyAccessSourceFacts(await source(f,context)).domain.membershipVerified,false);
  f.sqlite.prepare("UPDATE trial_eligibility_checks SET subject_fingerprint=?,checked_at=? WHERE check_id='offline_actual_eligibility'").run(fp,f.now-61);
  assert.equal(readLegacyAccessSourceFacts(await source(f,context)).domain.handlerUnavailable,true);
});

test('raw/fake actor and foreign context cannot produce access sources; absent referral source stays closed with exact absence proof',async t=>{
  const f=foundationFixture(t),context=await callback(f,'referral.bonus.claim_own'),actor=await createAuthorityResolver().resolveActor(context);
  await assert.rejects(resolveLegacyAccessSources({context,actor:{...actor}}),/untrusted_legacy_access_source/u);
  const foreign=await callback(f,'referral.bonus.claim_own',202);
  await assert.rejects(resolveLegacyAccessSources({context:foreign,actor}),/untrusted_legacy_access_source/u);
  const value=await resolveLegacyAccessSources({context,actor});assert.equal(readLegacyAccessSourceFacts(value).domain.handlerUnavailable,true);
  assert.equal(readLegacyAccessSourceFacts(value).canonical.bonusGrant,null);await assertSource(f,value,1);
  assert.throws(()=>readLegacyAccessSourceFacts({version:1}),/untrusted_legacy_access_source/u);
});


const DAY=86400,next=()=>++sequence,uuid=()=>crypto.randomUUID(),sqlTime=n=>new Date(n*1000).toISOString().slice(0,19).replace('T',' ');
function freeProjections(f, id = 101) {
  f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(id);
  f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(id);
}
function finance(f) {
  f.sqlite.function('current_timestamp',{deterministic:true},()=>sqlTime(f.now));
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0026-v1.3.6-stars-core-foundation.sql', import.meta.url),'utf8'));
  f.commerceEnv = { ...f.serverEnv, STARS_PAYMENTS_ENABLED:'true',STARS_BILLING_MODE:'prepaid',STARS_PRICE_VERSION:'1',
    STARS_TERMS_REVISION:'2026-09-10.stars-v1', STARS_INVOICE_SECRET:'offline-foundation-stars-secret-more-than-32-characters',
    STARS_REFUNDS_ENABLED:'true',STARS_RECONCILIATION_ENABLED:'true',REFERRAL_REWARDS_ENABLED:'true',
    REFERRAL_REWARD_ROLLOUT_MODE:'public',REFERRAL_REWARD_CANDIDATES_ENABLED:'true',REFERRAL_REWARD_CONFIRMATIONS_ENABLED:'true',
    REFERRAL_BONUS_GRANTS_ENABLED:'true',REFERRAL_REWARD_PROGRAM_STARTED_AT:String(f.now - 60 * DAY) };
}
async function purchase(f, id = 101, at = f.now - 10, planCode = 'professional') {
  freeProjections(f,id);
  await acceptStarsPurchaseTerms(f.commerceEnv,{telegramId:id,telegramUpdateId:next(),acceptedAt:at-1});
  const calls = [];
  const telegramApi = async (_env, method, payload) => { calls.push({method,payload}); return method === 'sendInvoice' ? {message_id:next()} : true; };
  const orderId = uuid(), chargeId = 'offline-authority-charge-' + next();
  const issued = await issueStarsPurchase(f.commerceEnv,{telegramId:id,requestedPlanCode:planCode,telegramUpdateId:next(),orderId,createdAt:at},{telegramApi});
  const payload = calls.find(c=>c.method === 'sendInvoice').payload.payload;
  const pre = await handleStarsCommerceUpdate(f.commerceEnv,{update_id:next(),pre_checkout_query:{id:'checkout-' + next(),from:{id,is_bot:false},currency:'XTR',total_amount:issued.amountStars,invoice_payload:payload}},{nowSeconds:at+1,telegramApi});
  assert.equal(pre.approved,true);
  const result = await handleStarsCommerceUpdate(f.commerceEnv,{update_id:next(),message:{message_id:next(),from:{id,is_bot:false},chat:{id,type:'private'},successful_payment:{currency:'XTR',total_amount:issued.amountStars,invoice_payload:payload,telegram_payment_charge_id:chargeId,provider_payment_charge_id:''}}},{nowSeconds:at+2});
  assert.equal(result.accessApplied,true,JSON.stringify(result));
  return {...result,orderId,chargeId,paidAt:at+2,amountStars:issued.amountStars};
}
async function seedReward(f, { ageDays = 0 } = {}) {
  finance(f);
  if(ageDays){
    f.sqlite.prepare("INSERT INTO price_book(price_id,price_version,plan_code,currency,amount_stars,access_seconds,billing_mode,publication_state,terms_revision,valid_from,created_at,created_by) SELECT price_id||'-offline-v2',2,plan_code,currency,amount_stars,access_seconds,billing_mode,publication_state,terms_revision,?,?,created_by FROM price_book WHERE price_version=1").run(f.now-90*DAY,f.now-90*DAY);
    f.commerceEnv.STARS_PRICE_VERSION='2';
  }
  const firstStart = f.now - (22+ageDays) * DAY, at = f.now - (21+ageDays) * DAY - 40;
  f.sqlite.prepare('UPDATE users SET inviter_id=101,inviter_bound_at=?,joined_at=? WHERE telegram_id=202').run(sqlTime(firstStart),sqlTime(firstStart));
  f.sqlite.prepare("INSERT INTO bot_start_events(telegram_id,source_code,is_new_user,started_at) VALUES(202,'referral',1,?)").run(sqlTime(firstStart));
  f.sqlite.prepare('UPDATE users SET joined_at=? WHERE telegram_id=101').run(sqlTime(firstStart));
  freeProjections(f);
  const payment = await purchase(f,202,at);
  const candidate = await createReferralRewardCandidate(f.commerceEnv,{orderId:payment.orderId,selectedAt:payment.paidAt+1});
  assert.equal(candidate.status,'created',JSON.stringify(candidate));
  const runId = uuid();
  f.sqlite.prepare("INSERT INTO payment_reconciliation_runs(run_id,run_source,status,started_at,finished_at,updated_at) VALUES(?,'scheduled','completed',?,?,?)").run(runId,candidate.confirmAfter,candidate.confirmAfter,candidate.confirmAfter);
  const ledger = f.sqlite.prepare('SELECT ledger_entry_id FROM payment_ledger WHERE order_id=? AND entry_type=\'payment\'').get(payment.orderId);
  f.sqlite.prepare("INSERT INTO payment_reconciliation_items(item_id,item_key,transaction_id_sha256,run_id,observation_side,transaction_direction,telegram_id,amount_stars,transaction_date,local_state,ledger_entry_id,observed_at) VALUES(?,?,?,?,'telegram','incoming',202,?,?,'matched',?,?)").run(uuid(),'offline-reconciliation-'+next(),'a'.repeat(64),runId,payment.amountStars,payment.paidAt,ledger.ledger_entry_id,candidate.confirmAfter);
  const settled = await settleReferralRewardProtection(f.commerceEnv,{rewardId:candidate.rewardId,reconciliationRunId:runId,checkedAt:candidate.confirmAfter});
  assert.equal(settled.outcome,'confirmed',JSON.stringify(settled));
  const grant = await ensureReferralBonusGrant(f.commerceEnv,{rewardId:candidate.rewardId,deliveredAt:f.now-ageDays*DAY-4});
  assert.equal(grant.status,'claimable',JSON.stringify(grant));
  return {payment,grant,candidate};
}

test('actual confirmed paid referral source admits only its own claim and scoped legacy repair expires an actual due claim',async t=>{
  const f=foundationFixture(t);f.sqlite.function('unixepoch',{deterministic:false,varargs:true},(...args)=>args.length===0||args[0]==='now'?f.now:authoritySeconds(args[0]));
  const reward=await seedReward(f);
  const context=await callback(f,'referral.bonus.claim_own',101,f.commerceEnv);
  const actual=await source(f,context);assert.equal(readLegacyAccessSourceFacts(actual).domain.referralClaimable,true);
  await assertSource(f,actual,1);
  const authorization=await createRuntimeAuthorizer().authorize(context,null);
  assert.equal(runtimeAuthorizationDTO(authorization).allowed,true);
  const env=bindLegacyCompatibilityEnv(await prepareLegacyCompatibility(authorization,{family:'referral.bonus.claim_own'}),{...f.serverEnv,...config,...f.commerceEnv,WEBHOOK_SECRET:'offline-access-source-webhook-secret'});
  await assert.rejects(env.DB.prepare('UPDATE bonus_access_grants SET updated_at=? WHERE bonus_grant_id=?').bind(f.now,'foreign_grant').run(),/legacy_write_scope_mismatch/u);
  const claimed=await claimReferralBonusAccess(env,{telegramId:101,bonusGrantId:reward.grant.bonusGrantId,claimedAt:f.now});
  assert.equal(claimed.status,'applied');assert.equal(f.sqlite.prepare('SELECT plan_code FROM user_plans WHERE telegram_id=101').get().plan_code,'professional');

  const g=foundationFixture(t);g.sqlite.function('unixepoch',{deterministic:false,varargs:true},(...args)=>args.length===0||args[0]==='now'?g.now:authoritySeconds(args[0]));
  const due=await seedReward(g,{ageDays:31});
  g.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  const rawEnv={...g.serverEnv,...g.commerceEnv,WEBHOOK_SECRET:'offline-access-source-webhook-secret',V141_AUTHORIZATION_ENABLED:'true'};
  const update={update_id:++sequence,callback_query:{id:'repair_'+sequence,from:{id:900,is_bot:false},message:{from:{id:123456789,is_bot:true},chat:{id:900,type:'private'}},data:'admin_referral_repair'}};
  const claim='repair_claim_'+sequence;
  g.sqlite.prepare("INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,attempt_count,received_at,lease_expires_at) VALUES(?,'callback_query',900,'processing',?,1,?,?)").run(update.update_id,claim,g.now,g.now+300);
  const base=await createCustomerContext({binding:g.binding,env:rawEnv,webhookRequest:new Request('https://bot.example/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':rawEnv.WEBHOOK_SECRET},body:JSON.stringify(update)}),receiptClaimToken:claim,channel:'telegram_callback',operation:'account.menu.read',nowSeconds:g.now});
  const selected=await authorizeTelegramHandler(base,update);assert.equal(runtimeAuthorizationDTO(selected.authorization).allowed,true);
  const repairEnv=bindLegacyCompatibilityEnv(await prepareLegacyCompatibility(selected.authorization,{family:'admin.result.repair'}),rawEnv);
  await assert.rejects(repairEnv.DB.prepare('UPDATE user_plans SET updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?').bind(404).run(),/legacy_write_scope_mismatch/u);
  const repaired=await runReferralBonusMaintenance(repairEnv,{recordedAt:g.now});
  assert.equal(repaired.attempted,1);assert.equal(g.sqlite.prepare('SELECT grant_status FROM bonus_access_grants WHERE bonus_grant_id=?').get(due.grant.bonusGrantId).grant_status,'expired');
});
