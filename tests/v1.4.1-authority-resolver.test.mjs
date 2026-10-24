import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foundationFixture, signedInitData } from './helpers/v1.4.1-fixtures.mjs';
import { approvedPartner } from './helpers/v1.4.0-rebuild-sqlite.mjs';
import { createCustomerContext, createServiceExecutor, SERVICE_PURPOSES, readTrustedContext } from '../src/v1.4.1/trusted-context.mjs';
import { createAuthorityResolver, isTrustedActor, readActorFacts, readActorContext, compileAuthorityAssertions,
  compileAuthorityReplayAssertions, accountGenerationFingerprint, manualGrantSourceFingerprint, authoritySeconds } from '../src/v1.4.1/authority-resolver.mjs';
import { createResourceResolver } from '../src/v1.4.1/resource-resolver.mjs';
import { can } from '../src/v1.4.1/entitlement-engine.mjs';
import { FOUNDATION_POLICY_VERSION } from '../src/v1.4.1/capability-policy.mjs';
import { acceptStarsPurchaseTerms, issueStarsPurchase, handleStarsCommerceUpdate } from '../src/v1.3.6/stars-commerce-runtime.mjs';
import { applyStarsCompensation } from '../src/v1.3.6/stars-access-runtime.mjs';
import { createReferralRewardCandidate } from '../src/v1.3.7/referral-reward-candidate-runtime.mjs';
import { settleReferralRewardProtection } from '../src/v1.3.7/referral-reward-protection-runtime.mjs';
import { ensureReferralBonusGrant, claimReferralBonusAccess } from '../src/v1.3.7/referral-bonus-access-runtime.mjs';

const resolver = createAuthorityResolver(), DAY = 86400;
function clockFixture(t) {
  const f=foundationFixture(t);
  f.sqlite.function('unixepoch',{deterministic:false,varargs:true},(...args)=>args.length===0 || args[0]==='now' ? f.now : authoritySeconds(args[0]));
  return f;
}
let seq = 400000;
const next = () => ++seq;
const uuid = () => crypto.randomUUID();
const sqlTime = seconds => new Date(seconds * 1000).toISOString().slice(0,19).replace('T',' ');
const resolve = async (f, id = 101, patch = {}) => resolver.resolveActor(await f.context(id, 'application.create', 'mini_app', patch));
const assertGuard = async (f, actor, expected = 1, replay = false) => {
  const guard = (replay ? compileAuthorityReplayAssertions : compileAuthorityAssertions)(actor);
  assert.ok(Array.isArray(guard.assertions) && guard.assertions.length > 0);
  const statements=guard.assertions.map(piece=>{
    assert.ok(piece.params.length<=99);
    return f.binding.prepare(`SELECT (${piece.sql}) AS ok`).bind(...piece.params);
  });
  const results=await f.binding.batch(statements);
  assert.equal(results.length,statements.length);
  results.forEach(row=>assert.equal(row.success,true));
  assert.equal(Number(results.every(row=>row.results.length===1&&row.results[0].ok===1)),expected);return guard;
};
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
async function bonus(f, { extension = false } = {}) {
  finance(f);
  const firstStart = f.now - 22 * DAY, at = f.now - 21 * DAY - 40;
  f.sqlite.prepare('UPDATE users SET inviter_id=101,inviter_bound_at=?,joined_at=? WHERE telegram_id=202').run(sqlTime(firstStart),sqlTime(firstStart));
  f.sqlite.prepare("INSERT INTO bot_start_events(telegram_id,source_code,is_new_user,started_at) VALUES(202,'referral',1,?)").run(sqlTime(firstStart));
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
  if(extension) await purchase(f,101,f.now-8);
  const grant = await ensureReferralBonusGrant(f.commerceEnv,{rewardId:candidate.rewardId,deliveredAt:f.now-4});
  if(!extension) { assert.equal(grant.status,'claimable',JSON.stringify(grant)); const claimed = await claimReferralBonusAccess(f.commerceEnv,{telegramId:101,bonusGrantId:grant.bonusGrantId,claimedAt:f.now}); assert.equal(claimed.status,'applied',JSON.stringify(claimed)); }
  else assert.equal(grant.status,'applied',JSON.stringify(grant));
  return {payment,grant,candidate};
}
function preview(f, { start = f.now-5, end = start+604800 } = {}) {
  freeProjections(f);
  const grantId=uuid(), source='dragon_preview:v1.3.5-hotfix.1';
  f.sqlite.prepare("INSERT INTO trial_grants(grant_id,telegram_id,subject_fingerprint,program_code,source_code,status,started_at,ends_at,retention_until,workflow_instance_id,workflow_state,granted_at,updated_at) VALUES(?,101,?,'dragon_preview',?,'active',?,?,?,?,'started',?,?)").run(grantId,'a'.repeat(64),source,start,end,end+DAY,'offline-authority-preview-'+next(),start,start);
  f.sqlite.prepare("UPDATE user_plans SET source_code=?,effective_from=?,effective_until=NULL,revision=revision+1 WHERE telegram_id=101").run(source,sqlTime(start));
  f.sqlite.prepare("UPDATE user_access_states SET access_state='trial',source_code=?,state_started_at=?,state_ends_at=?,revision=revision+1 WHERE telegram_id=101").run(source,sqlTime(start),sqlTime(end));
  f.sqlite.prepare("UPDATE user_access SET access_tier='trial',trial_used=1,trial_started_at=?,trial_ends_at=? WHERE telegram_id=101").run(sqlTime(start),sqlTime(end));
  return grantId;
}
async function metadataGrant(f, {start=f.now-1,end=f.now+120,sourceFingerprint}={}) {
  const user=f.sqlite.prepare('SELECT * FROM users WHERE telegram_id=101').get();
  const fingerprint=await accountGenerationFingerprint(user), grantId=uuid();
  const row={grant_id:grantId,idempotency_key:String(next()).padStart(64,'0'),policy_version:FOUNDATION_POLICY_VERSION,capability:'application.create',subject_telegram_id:101,
    scope_kind:'actor',scope_key:'actor:101',source_kind:'manual_capability',source_ref:'manual:'+grantId,source_revision:1,issued_by:900,reason:'offline controlled issuance',starts_at:start,expires_at:end,revision:1,created_at:f.now-1,updated_at:f.now-1,retention_until:end+DAY};
  row.source_fingerprint=sourceFingerprint??await manualGrantSourceFingerprint(row,fingerprint);
  const keys=Object.keys(row);f.sqlite.prepare(`INSERT INTO entitlement_grants(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));
  return row;
}
function denyOverride(f, fingerprint, start=f.now-1, end=f.now+120) {
  const row={override_id:uuid(),idempotency_key:String(next()).padStart(64,'0'),policy_version:FOUNDATION_POLICY_VERSION,capability:'application.create',subject_telegram_id:101,
    subject_source_fingerprint:fingerprint,scope_kind:'actor',scope_key:'actor:101',effect:'deny',issued_by:900,reason:'offline denial',starts_at:start,expires_at:end,revision:1,created_at:f.now-1,updated_at:f.now-1,retention_until:end+DAY};
  const keys=Object.keys(row);f.sqlite.prepare(`INSERT INTO entitlement_overrides(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));return row;
}

test('source boundary rejects client principal/actor copies and performs primary reads only',async t=>{
  const f=clockFixture(t);const context=await f.context();f.binding.audit.length=0;
  await assert.rejects(resolver.resolveActor({telegramId:101,authoritySource:'database',role:'admin',plan:'dragon'}),{code:'untrusted_context'});
  const actor=await resolver.resolveActor(context);assert.ok(isTrustedActor(actor));assert.equal(readActorFacts(actor),actor);assert.equal(readActorContext(actor),context);
  assert.ok(Object.isFrozen(actor.account));assert.deepEqual(actor.roles,['user']);assert.equal(actor.access.effectivePlan,'free');assert.equal(actor.access.status,'verified');
  assert.equal(isTrustedActor(JSON.parse(JSON.stringify(actor))),false);assert.throws(()=>readActorFacts({...actor}),{code:'untrusted_actor'});assert.throws(()=>compileAuthorityAssertions({...actor}),{code:'untrusted_actor'});
  assert.ok(f.binding.audit.length>20);assert.ok(f.binding.audit.every(r=>r.mode==='read'&&r.sql.startsWith('SELECT ')));assert.ok(f.binding.sessions.every(s=>s==='first-primary'));await assertGuard(f,actor);
});
test('missing user retains authenticated identity and no private authority; role SET exact canonical owner',async t=>{
  const f=clockFixture(t);const missing=await resolve(f,999);assert.equal(missing.account.exists,false);assert.deepEqual(missing.roles,[]);assert.equal(missing.access.effectivePlan,'free');
  f.sqlite.exec("INSERT INTO user_roles(telegram_id,role,status) VALUES(900,'partner','active')");const admin=await resolve(f,900);assert.deepEqual(new Set(admin.roles),new Set(['admin','partner','user']));assert.equal(admin.canonicalOwner,true);
  const conflicting=await resolve(f,900,{env:{...f.serverEnv,OWNER_TELEGRAM_ID:'101'}});assert.equal(conflicting.canonicalOwner,false);
  f.sqlite.exec('UPDATE users SET accepted_terms=0 WHERE telegram_id=900');assert.equal((await resolve(f,900)).canonicalOwner,false);await assertGuard(f,admin,0);
});
test('all fixed service executors produce branded purpose-scoped service facts',async t=>{
  const f=clockFixture(t);for(const purpose of Object.keys(SERVICE_PURPOSES)){const executor=createServiceExecutor({binding:f.binding,env:f.serverEnv,purpose,clockSeconds:()=>f.now});const context=executor.createContext();const actor=await resolver.resolveActor(context);assert.equal(actor.actorKind,'service');assert.equal(actor.purpose,readTrustedContext(context).purpose);assert.equal(actor.capability,SERVICE_PURPOSES[purpose]);assert.equal(actor.access,null);assert.deepEqual(actor.roles,[]);await assertGuard(f,actor);}
});
test('Preview verifies exact canonical overlay, retains Free plan, and expires before maintenance',async t=>{
  const f=clockFixture(t);preview(f);const actor=await resolve(f);assert.equal(actor.access.reasonCode,'preview_source_verified');assert.equal(actor.access.effectivePlan,'free');assert.equal(actor.access.accessOverlay,'dragon_preview');assert.equal(actor.ai.previewDailyLimit,30);await assertGuard(f,actor);
  f.sqlite.exec("UPDATE user_access SET trial_ends_at='2030-01-01 00:00:00' WHERE telegram_id=101");assert.equal((await resolve(f)).access.status,'review_required');await assertGuard(f,actor,0);
  const g=clockFixture(t);preview(g,{start:g.now-604801});assert.equal((await resolve(g)).access.reasonCode,'access_expired');assert.equal((await resolve(g)).access.accessOverlay,'none');
});
test('Team stays review; preview cannot supersede refunded or suspended canonical source',async t=>{
  const f=clockFixture(t);f.sqlite.exec("UPDATE user_access SET access_tier='team' WHERE telegram_id=101");assert.equal((await resolve(f)).access.reasonCode,'legacy_team_requires_manual_review');
  const g=clockFixture(t);preview(g);g.sqlite.exec("UPDATE user_access_states SET access_state='suspended' WHERE telegram_id=101");assert.equal((await resolve(g)).access.reasonCode,'paid_access_suspended');g.sqlite.exec("UPDATE user_access_states SET access_state='refunded' WHERE telegram_id=101");assert.equal((await resolve(g)).access.accessOverlay,'none');
});
test('Stars actual purchase, renewal and partial refund retain surviving verified paid source',async t=>{
  const f=clockFixture(t);finance(f);const first=await purchase(f,101,f.now-20);const renewal=await purchase(f,101,f.now-10);
  const actor=await resolve(f);assert.equal(actor.access.reasonCode,'stars_source_verified');assert.equal(actor.access.effectivePlan,'professional');await assertGuard(f,actor);
  await applyStarsCompensation(f.commerceEnv,{telegramPaymentChargeId:first.chargeId,compensationType:'refund',occurredAt:f.now-1});
  const survived=await resolve(f);assert.equal(survived.access.reasonCode,'stars_source_verified');assert.equal(survived.access.effectivePlan,'professional');await assertGuard(f,actor,0);await assertGuard(f,survived);
  await applyStarsCompensation(f.commerceEnv,{telegramPaymentChargeId:renewal.chargeId,compensationType:'refund',occurredAt:f.now});assert.equal((await resolve(f)).access.effectivePlan,'free');
});
test('Stars cancel keeps paid until end; missing ledger, coherent arbitrary end, expiry and chargeback do not',async t=>{
  const f=clockFixture(t);finance(f);const payment=await purchase(f);
  f.sqlite.exec("UPDATE subscriptions SET status='cancel_at_period_end',revision=revision+1;UPDATE user_access_states SET access_state='cancel_at_period_end',revision=revision+1 WHERE telegram_id=101");assert.equal((await resolve(f)).access.effectivePlan,'professional');
  const actor=await resolve(f);await applyStarsCompensation(f.commerceEnv,{telegramPaymentChargeId:payment.chargeId,compensationType:'chargeback',occurredAt:f.now});assert.equal((await resolve(f)).access.reasonCode,'paid_access_suspended');await assertGuard(f,actor,0);
  const g=clockFixture(t);finance(g);await purchase(g);g.sqlite.exec("UPDATE subscriptions SET current_period_end=current_period_end+86400;UPDATE user_plans SET effective_until=datetime(effective_until,'+1 day') WHERE telegram_id=101;UPDATE user_access_states SET state_ends_at=datetime(state_ends_at,'+1 day') WHERE telegram_id=101");assert.equal((await resolve(g)).access.status,'review_required');
  const h=clockFixture(t);finance(h);await purchase(h);for(const row of h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='payment_ledger'").all())h.sqlite.exec('DROP TRIGGER '+row.name);h.sqlite.exec("PRAGMA foreign_keys=OFF;DELETE FROM payment_ledger WHERE entry_type='payment'");assert.equal((await resolve(h)).access.status,'review_required');
});
test('manual referral72h uses real confirmed reward/effect/transition and needs no subscription',async t=>{
  const f=clockFixture(t);const b=await bonus(f);assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM subscriptions WHERE telegram_id=101').get().n,0);
  const actor=await resolve(f);assert.equal(actor.access.reasonCode,'referral_bonus_source_verified');assert.equal(actor.access.effectivePlan,'professional');await assertGuard(f,actor);
  await applyStarsCompensation(f.commerceEnv,{telegramPaymentChargeId:b.payment.chargeId,compensationType:'refund',occurredAt:f.now});assert.equal((await resolve(f)).access.status,'review_required');await assertGuard(f,actor,0);
});
test('applied referral extension with future starts is real current paid duration',async t=>{
  const f=clockFixture(t);await bonus(f,{extension:true});const actor=await resolve(f);assert.equal(actor.access.reasonCode,'stars_source_verified');const grant=f.sqlite.prepare("SELECT starts_at FROM bonus_access_grants WHERE beneficiary_telegram_id=101").get();assert.ok(grant.starts_at>f.now);await assertGuard(f,actor);
});
test('age and legal facts come from actual approved application and self-declared profile',async t=>{
  const f=clockFixture(t);await approvedPartner(f,202);const actor=await resolve(f,202);assert.equal(actor.partner.approvedApplication,true);assert.equal(actor.partner.ageConfirmed,true);assert.ok(actor.roles.includes('partner'));assert.equal(actor.legalProfile,null);
  f.sqlite.prepare("INSERT INTO partner_legal_profiles(partner_profile_id,profile_kind,verification_state,revision,declared_by,declared_at,updated_at) VALUES(?,'individual','self_declared',1,202,?,?)").run(actor.partner.profileId,sqlTime(f.now),sqlTime(f.now));const legal=await resolve(f,202);assert.equal(legal.legalProfile.verificationState,'self_declared');assert.equal(legal.access.effectivePlan,'free');
});
test('manual grants and overrides require real current issuer and generation; forged hashes and recreated account fail',async t=>{
  const f=clockFixture(t);await metadataGrant(f);const actor=await resolve(f);assert.equal(actor.grants.length,1);denyOverride(f,actor.accountFingerprint);assert.equal((await resolve(f)).overrides.length,1);await assertGuard(f,actor,0);
  f.sqlite.exec("UPDATE users SET referral_code='recreated-random-generation' WHERE telegram_id=101");const recreated=await resolve(f);assert.notEqual(recreated.accountFingerprint,actor.accountFingerprint);assert.equal(recreated.grants.length,0);assert.equal(recreated.overrides.length,0);await assertGuard(f,actor,0,true);
  const g=clockFixture(t);await metadataGrant(g,{sourceFingerprint:'f'.repeat(64)});assert.equal((await resolve(g)).grants.length,0);g.sqlite.exec("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'");assert.equal((await resolve(g)).grants.length,0);
});
test('future deny start and expiry fence same-batch commit without any database mutation',async t=>{
  const f=clockFixture(t);const initial=await resolve(f);denyOverride(f,initial.accountFingerprint,f.now+2,f.now+40);const actor=await resolve(f);assert.equal(actor.overrides.length,0);assert.equal(actor.validUntil,f.now+2);await assertGuard(f,actor);
  f.sqlite.function('unixepoch',{deterministic:true,varargs:true},()=>f.now+2);await assertGuard(f,actor,0);await assertGuard(f,actor,1,true);
});
test('fresh identity guard notices block/terms/delete/role changes; source expiry does not block identity-only receipt acknowledgement',async t=>{
  const f=clockFixture(t);await metadataGrant(f,{end:f.now+2});const actor=await resolve(f);f.sqlite.function('unixepoch',{deterministic:true,varargs:true},()=>f.now+3);await assertGuard(f,actor,0);await assertGuard(f,actor,1,true);
  f.sqlite.exec('UPDATE users SET is_blocked=1 WHERE telegram_id=101');await assertGuard(f,actor,0,true);assert.equal((await resolve(f)).account.isBlocked,true);
});
test('source overflow/read failure reject rather than provision; strict timestamp parser rejects rollover',async t=>{
  const f=clockFixture(t);for(let i=0;i<65;i++)await metadataGrant(f);await assert.rejects(resolve(f),{code:'authority_source_overflow'});
  const g=clockFixture(t);const context=await g.context();const prepare=g.binding.prepare.bind(g.binding);g.binding.prepare=sql=>{if(sql.includes('FROM user_plans '))throw new Error('offline read failure');return prepare(sql);};await assert.rejects(resolver.resolveActor(context),{code:'authority_unavailable'});
  assert.equal(authoritySeconds('2026-02-30 00:00:00'),null);assert.equal(authoritySeconds('2026-10-02'),null);assert.equal(authoritySeconds('2026-10-02T00:00:00Z'),1790899200);
});
test('AI policy reads live configured settings and consent; missing row never invents new5/25/50 policy',async t=>{
  const f=clockFixture(t);assert.equal((await resolve(f)).ai.settings,null);
  f.sqlite.exec("INSERT INTO ai_runtime_settings(id,rollout_mode,model_name,public_daily_neurons_milli,admin_daily_neurons_milli,reserve_daily_neurons_milli,user_daily_success_limit,response_character_limit,updated_by,updated_at) VALUES(1,'admin','configured-live-model',120000,220000,30000,37,2100,900,1)");
  f.sqlite.exec("INSERT INTO ai_user_consents(telegram_id,consent_version,consented_at,updated_at) VALUES(101,'2026-09-ai',1,1);UPDATE user_access SET ai_enabled=1 WHERE telegram_id=101");const actor=await resolve(f);assert.equal(actor.ai.settings.user_daily_success_limit,37);assert.equal(actor.ai.settings.model_name,'configured-live-model');assert.equal(actor.ai.enabledPreference,true);assert.equal(actor.ai.consent.consent_version,'2026-09-ai');await assertGuard(f,actor);
});


test('legacy malformed restriction bits fail closed and freshly restricted replay cannot acknowledge',async t=>{
  for (const [column,value] of [['is_blocked','garbage'],['accepted_terms',2]]) {
    const f=clockFixture(t);f.sqlite.prepare('UPDATE users SET '+column+'=? WHERE telegram_id=101').run(value);
    await assert.rejects(resolve(f),{code:'authority_identity_restriction_invalid'});
  }
  const f=clockFixture(t);f.sqlite.exec('UPDATE users SET is_blocked=1 WHERE telegram_id=101');const actor=await resolve(f);assert.equal(actor.account.isBlocked,true);await assertGuard(f,actor,0,true);
  const g=clockFixture(t);g.sqlite.exec('UPDATE users SET accepted_terms=0 WHERE telegram_id=101');await assertGuard(g,await resolve(g),0,true);
  const h=clockFixture(t);h.sqlite.prepare("INSERT INTO privacy_deletion_requests(request_id,telegram_id,confirmation_token,status,summary_json,expires_at) VALUES(?,101,?,'pending','{}',?)").run(uuid(),'offline-confirmation',sqlTime(h.now+60));const deleting=await resolve(h);assert.equal(deleting.account.pendingDeletion,true);await assertGuard(h,deleting,0,true);
});
test('requested policy uses exact actual104/416 foundation projection and captures missing rows',async t=>{
  const f=clockFixture(t);const actor=await resolve(f);assert.equal(actor.policyReady,true);assert.equal(actor.policyCapability,'application.create');assert.equal(actor.canonical.capabilityCatalog.length,1);assert.equal(actor.canonical.planCapabilities.length,4);
  for(const row of f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='plan_capabilities'").all())f.sqlite.exec('DROP TRIGGER '+row.name);
  f.sqlite.prepare("DELETE FROM plan_capabilities WHERE capability='application.create' AND plan_code='dragon'").run();const missing=await resolve(f);assert.equal(missing.policyReady,false);await assertGuard(f,actor,0);
  const unknown=await resolve(f,101,{operation:'unknown.client.claim'});assert.equal(unknown.policyReady,false);assert.equal(unknown.currentFlags.length,0);
});
test('fixed rollout flags and generation-bound assignments are fresh evidence and cannot invent a release',async t=>{
  const f=clockFixture(t);const initial=await resolve(f);assert.deepEqual(initial.currentFlags,[]);assert.deepEqual(initial.verifiedAssignments,[]);
  f.sqlite.prepare("INSERT INTO feature_flags(flag_key,policy_version,enabled,emergency_disabled,revision,rollout_json,updated_by,reason,updated_at) VALUES('capability:application.create',?,0,1,1,'{}',900,'offline emergency',?)").run(FOUNDATION_POLICY_VERSION,f.now);
  const row={assignment_id:uuid(),idempotency_key:String(next()).padStart(64,'0'),flag_key:'capability:application.create',subject_kind:'actor',subject_key:'actor:101',subject_telegram_id:101,subject_source_fingerprint:initial.accountFingerprint,assigned_by:900,reason:'offline assignment',starts_at:f.now+2,expires_at:f.now+90,revision:1,created_at:f.now,updated_at:f.now};
  const keys=Object.keys(row);f.sqlite.prepare(`INSERT INTO feature_flag_assignments(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));
  const actor=await resolve(f);assert.equal(actor.currentFlags[0].emergency_disabled,1);assert.equal(actor.verifiedAssignments.length,0);assert.equal(actor.validUntil,f.now+2);await assertGuard(f,initial,0);
  const context=await f.context(101,'application.create','mini_app',{initData:signedInitData(101,f.now+3),nowSeconds:f.now+3});const live=await resolver.resolveActor(context);assert.equal(live.verifiedAssignments.length,1);assert.equal(live.currentFlags[0].enabled,0);
  f.sqlite.exec("UPDATE users SET referral_code='new-generation-after-deletion' WHERE telegram_id=101");assert.equal((await resolver.resolveActor(context)).verifiedAssignments.length,0);
});

test('Beta effective facts preserve existing hard environment AND database switches',async t=>{
  const f=clockFixture(t);await approvedPartner(f,202);const actor=await resolve(f,202);assert.equal(actor.partner.betaSettings.enabled,1);assert.equal(actor.partner.betaSettings.private_offers_enabled,1);
  const disabled=await resolve(f,202,{env:{...f.serverEnv,PARTNER_BETA_ENABLED:'false',PARTNER_PRIVATE_OFFERS_ENABLED:'false',PARTNER_OFFER_SUBMISSIONS_ENABLED:'false',PARTNER_OFFER_PUBLIC_VISIBILITY_ENABLED:'false'}});
  assert.equal(disabled.canonical.rawBetaSettings.enabled,1);assert.equal(disabled.partner.betaSettings.enabled,0);assert.equal(disabled.canonical.betaSettings.private_offers_enabled,0);assert.equal(disabled.partner.betaSettings.submissions_enabled,0);assert.equal(disabled.partner.betaSettings.public_visibility_enabled,0);
  await assertGuard(f,disabled);
});

test('actual129 financial renewal rows degrade only fixed protected own contours',async t=>{
  const f=clockFixture(t);finance(f);
  for(let i=0;i<129;i++)await purchase(f,101,f.now-400+2*i);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM subscription_access_grants WHERE telegram_id=101').get().n,129);
  for(const operation of ['help.read','privacy.read_own','billing.read_history_own','profile.read_own','access.read_own']) {
    const actor=await resolve(f,101,{operation});assert.equal(actor.financialSourceAvailable,false);assert.equal(actor.protectedAuthorityFallback,true);
    assert.equal(actor.access.effectivePlan,'free');assert.equal(actor.access.status,'review_required');assert.deepEqual(actor.grants,[]);assert.ok(actor.degradedTables.some(r=>r.code==='authority_source_overflow'));await assertGuard(f,actor);
    const resource=await createResourceResolver().resolve(readActorContext(actor),actor);assert.equal(can(actor,operation,resource).allowed,true,operation);
  }
  await assert.rejects(resolve(f,101,{operation:'ai.partner_draft'}),{code:'authority_source_overflow'});
});
test('missing optional new metadata retains protected source facts; commercial or identity failure stays closed',async t=>{
  const f=clockFixture(t);f.sqlite.exec('PRAGMA foreign_keys=OFF;DROP TABLE entitlement_grants;DROP TABLE entitlement_overrides;DROP TABLE feature_flag_assignments;DROP TABLE feature_flags;DROP TABLE plan_capabilities;DROP TABLE capability_catalog');
  for(const operation of ['terms.read','help.read','privacy.read_own','billing.payment_help','profile.read_own','access.read_own']) {
    const actor=await resolve(f,101,{operation});assert.equal(actor.policyReady,false);assert.equal(actor.foundationMetadataAvailable,false);assert.equal(actor.protectedAuthorityFallback,true);
    assert.equal(actor.account.exists,true);assert.deepEqual(actor.grants,[]);assert.deepEqual(actor.overrides,[]);await assertGuard(f,actor);
    const resource=await createResourceResolver().resolve(readActorContext(actor),actor);assert.equal(can(actor,operation,resource).allowed,true,operation);
  }
  await assert.rejects(resolve(f,101,{operation:'application.create'}),{code:'authority_unavailable'});
  const context=await f.context(101,'privacy.read_own');const prepare=f.binding.prepare.bind(f.binding);f.binding.prepare=sql=>{if(sql.includes('FROM user_roles '))throw new Error('actual identity unavailable');return prepare(sql);};await assert.rejects(resolver.resolveActor(context),{code:'authority_unavailable'});
});

test('fixed incurred-cost maintenance retains exact canonical resource proof after new metadata disappears',async t=>{
  const f=clockFixture(t), requestId='offline-existing-incurred-cost', date=new Date(f.now*1000).toISOString().slice(0,10), cycle=Math.floor(f.now/2592000)*2592000;
  f.sqlite.prepare("INSERT INTO ai_quota_reservations(request_id,telegram_id,usage_date,bucket,reserved_milli,status,completed_at) VALUES(?,900,?,'admin',1,'consumed',CURRENT_TIMESTAMP)").run(requestId,date);
  f.sqlite.prepare("INSERT INTO ai_gateway_budget_reservations(request_id,owner_telegram_id,usage_date,user_cycle_start_at,user_cycle_end_at,global_cycle_start_at,global_cycle_end_at,reserved_billed_tokens,reserved_cost_microusd,reservation_state,policy_version,pricing_version,created_at,completed_at) VALUES(?,900,?,?,?,?,?,10000,5000,'consumed','2026-09-12.ai-partner-v1','2026-09-12.deepseek-v4.1-flash-peak-v1',?,?)").run(requestId,date,cycle,cycle+2592000,cycle,cycle+2592000,f.now,f.now);
  f.sqlite.exec('PRAGMA foreign_keys=OFF;DROP TABLE capability_catalog;DROP TABLE plan_capabilities;DROP TABLE feature_flag_assignments;DROP TABLE feature_flags');
  const context=createServiceExecutor({binding:f.binding,env:f.serverEnv,purpose:'ai_settle_cost',clockSeconds:()=>f.now}).createContext();
  const actor=await resolver.resolveActor(context);assert.equal(actor.policyReady,false);assert.equal(actor.essentialServiceAuthorityFallback,true);assert.deepEqual(actor.roles,[]);
  const resource=await createResourceResolver().resolve(context,actor,{kind:'ai_budget_reservation',key:requestId});assert.equal(can(actor,'service.ai.settle_cost',resource).allowed,true);await assertGuard(f,actor);
  const missing=await createResourceResolver().resolve(context,actor,{kind:'ai_budget_reservation',key:'unknown-incurred-cost'});assert.equal(can(actor,'service.ai.settle_cost',missing).allowed,false);
  f.sqlite.exec('DROP TABLE ai_gateway_budget_reservations');await assert.rejects(createResourceResolver().resolve(context,actor,{kind:'ai_budget_reservation',key:requestId}),{code:'resource_unavailable'});
  const nonessential=createServiceExecutor({binding:f.binding,env:f.serverEnv,purpose:'analytics_ingest',clockSeconds:()=>f.now}).createContext();await assert.rejects(resolver.resolveActor(nonessential),{code:'authority_unavailable'});
});

test('safe own refund request survives new metadata absence without gaining admin refund execution or other payment scope',async t=>{
  const f=clockFixture(t);finance(f);const own=await purchase(f,101,f.now-10), other=await purchase(f,202,f.now-8);
  f.sqlite.exec('PRAGMA foreign_keys=OFF;DROP TABLE capability_catalog;DROP TABLE plan_capabilities;DROP TABLE feature_flag_assignments;DROP TABLE feature_flags;DROP TABLE entitlement_grants;DROP TABLE entitlement_overrides');
  const actor=await resolve(f,101,{operation:'billing.request_refund_own'});assert.equal(actor.protectedAuthorityFallback,true);assert.equal(actor.foundationMetadataAvailable,false);
  const owned=await createResourceResolver().resolve(readActorContext(actor),actor,{kind:'payment',key:own.orderId});assert.equal(can(actor,'billing.request_refund_own',owned).allowed,true);await assertGuard(f,actor);
  const foreign=await createResourceResolver().resolve(readActorContext(actor),actor,{kind:'payment',key:other.orderId});assert.equal(can(actor,'billing.request_refund_own',foreign).allowed,false);
  assert.equal(can(actor,'admin.stars.refund',owned).allowed,false);
  const badContext=await f.context(101,'billing.request_refund_own');const prepare=f.binding.prepare.bind(f.binding);f.binding.prepare=sql=>{if(sql.includes('FROM subscription_orders ')&&sql.includes('AND telegram_id=?'))throw new Error('actual owned refund source unavailable');return prepare(sql);};await assert.rejects(createResourceResolver().resolve(badContext,await resolver.resolveActor(badContext),{kind:'payment',key:own.orderId}),{code:'resource_unavailable'});
});
