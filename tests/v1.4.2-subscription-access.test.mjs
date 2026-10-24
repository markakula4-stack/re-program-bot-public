import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { authoritySeconds, readSubscriptionActorFacts } from '../src/v1.4.1/authority-resolver.mjs';
import { createRuntimeAuthorizer, readRuntimeAuthorization } from '../src/v1.4.1/runtime-authorizer.mjs';
import { projectSubscriptionAccess, readSubscriptionAccess } from '../src/v1.4.2/subscription-access.mjs';
import { acceptStarsPurchaseTerms, issueStarsPurchase, handleStarsCommerceUpdate } from '../src/v1.3.6/stars-commerce-runtime.mjs';
import { applyStarsCompensation } from '../src/v1.3.6/stars-access-runtime.mjs';

let sequence=810000;
const next=()=>++sequence;
const sqlTime=seconds=>new Date(seconds*1000).toISOString().slice(0,19).replace('T',' ');
const authorizer=createRuntimeAuthorizer();
function fixture(t) {
  const f=foundationFixture(t);
  f.sqlite.function('unixepoch',{deterministic:false,varargs:true},(...args)=>
    args.length===0 || args[0]==='now' ? f.now : authoritySeconds(args[0]));
  f.serverEnv={...f.serverEnv,DRAGON_PREVIEW_ENABLED:'true',
    DRAGON_PREVIEW_CHANNEL_ID:'@official_preview',DRAGON_PREVIEW_CHANNEL_URL:'https://t.me/official_preview',
    DRAGON_PREVIEW_PROGRAM_END_AT:new Date((f.now+30*86400)*1000).toISOString(),
    DRAGON_PREVIEW_ANTI_ABUSE_RETENTION_DAYS:'90',
    DRAGON_PREVIEW_ANTI_ABUSE_SECRET:'offline-subscription-preview-secret-more-than-32-characters',
    DRAGON_PREVIEW_WORKFLOW:{create(){throw new Error('workflow must not execute during read');}}};
  return f;
}
const authorize=async(f,id=101,operation='access.read_own')=>authorizer.authorize(await f.context(id,operation));
function free(f,id=101) {
  f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(id);
  f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(id);
}
async function fingerprint(secret,id) {
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`dragon_preview:${id}`)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
async function preview(f,{id=101,start=f.now-10,retained=false}={}) {
  free(f,id);
  const end=start+604800,source='dragon_preview:v1.3.5-hotfix.1',grantId=crypto.randomUUID();
  const subject=await fingerprint(f.serverEnv.DRAGON_PREVIEW_ANTI_ABUSE_SECRET,id);
  f.sqlite.prepare("INSERT INTO trial_grants(grant_id,telegram_id,subject_fingerprint,program_code,source_code,status,started_at,ends_at,retention_until,workflow_instance_id,workflow_state,granted_at,updated_at) VALUES(?,?,?,'dragon_preview',?, ?,?,?,?,?,'started',?,?)")
    .run(grantId,retained?null:id,subject,source,retained?'expired':'active',start,end,end+90*86400,'offline-subscription-'+next(),start,start);
  if(!retained){
    f.sqlite.prepare('UPDATE user_plans SET source_code=?,effective_from=?,effective_until=NULL,revision=revision+1 WHERE telegram_id=?').run(source,sqlTime(start),id);
    f.sqlite.prepare("UPDATE user_access_states SET access_state='trial',source_code=?,state_started_at=?,state_ends_at=?,revision=revision+1 WHERE telegram_id=?").run(source,sqlTime(start),sqlTime(end),id);
    f.sqlite.prepare("UPDATE user_access SET access_tier='trial',trial_used=1,trial_started_at=?,trial_ends_at=? WHERE telegram_id=?").run(sqlTime(start),sqlTime(end),id);
  }
  return {grantId,start,end};
}
function finance(f) {
  f.sqlite.function('current_timestamp',{deterministic:true},()=>sqlTime(f.now));
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0026-v1.3.6-stars-core-foundation.sql',import.meta.url),'utf8'));
  f.commerceEnv={...f.serverEnv,STARS_PAYMENTS_ENABLED:'true',STARS_BILLING_MODE:'prepaid',STARS_PRICE_VERSION:'1',
    STARS_TERMS_REVISION:'2026-09-10.stars-v1',STARS_INVOICE_SECRET:'offline-subscription-stars-secret-more-than-32-characters',
    STARS_REFUNDS_ENABLED:'true',STARS_RECONCILIATION_ENABLED:'true'};
}
async function paid(f,plan='dragon',{at=f.now-10,id=101}={}) {
  free(f,id);
  await acceptStarsPurchaseTerms(f.commerceEnv,{telegramId:id,telegramUpdateId:next(),acceptedAt:at-1});
  const calls=[];
  const telegramApi=async(_env,method,payload)=>{calls.push({method,payload});return method==='sendInvoice'?{message_id:next()}:true;};
  const orderId=crypto.randomUUID(),chargeId='offline-subscription-charge-'+next();
  const issued=await issueStarsPurchase(f.commerceEnv,{telegramId:id,requestedPlanCode:plan,telegramUpdateId:next(),orderId,createdAt:at},{telegramApi});
  const payload=calls.find(c=>c.method==='sendInvoice').payload.payload;
  const pre=await handleStarsCommerceUpdate(f.commerceEnv,{update_id:next(),pre_checkout_query:{id:'offline-checkout-'+next(),from:{id,is_bot:false},currency:'XTR',total_amount:issued.amountStars,invoice_payload:payload}},{nowSeconds:at+1,telegramApi});
  assert.equal(pre.approved,true);
  const result=await handleStarsCommerceUpdate(f.commerceEnv,{update_id:next(),message:{message_id:next(),from:{id,is_bot:false},chat:{id,type:'private'},successful_payment:{currency:'XTR',total_amount:issued.amountStars,invoice_payload:payload,telegram_payment_charge_id:chargeId,provider_payment_charge_id:''}}},{nowSeconds:at+2});
  assert.equal(result.accessApplied,true,JSON.stringify(result));
  return {...result,orderId,chargeId,paidAt:at+2};
}
const assertReads=f=>assert.ok(f.binding.audit.every(row=>row.mode==='read'&&row.sql.startsWith('SELECT ')),JSON.stringify(f.binding.audit));

test('Free uses genuine own authority, keeps session separate, and may request only a future membership check',async t=>{
  const f=fixture(t);free(f);f.binding.audit.length=0;
  const auth=await authorize(f),dto=await readSubscriptionAccess(auth);
  assert.equal(dto.current.planCode,'free');assert.equal(dto.current.sourceKind,'free');
  assert.equal(dto.current.durationKind,'free_unlimited');assert.equal(dto.current.expiresAt,null);
  assert.equal(dto.current.remainingSeconds,null);assert.equal(dto.sessionExpiresAt,f.now+300);
  assert.equal(dto.preview.historyUsed,false);assert.equal(dto.preview.canRequestActivation,true);
  assert.equal(dto.preview.eligibility,'check_required');assert.equal(dto.preview.reasonCode,'membership_check_required');
  assert.equal(dto.preview.membershipCheckRequired,true);assert.equal(dto.current.activeDragon,false);
  assert.ok(Object.isFrozen(dto.current));assertReads(f);
  const encoded=JSON.stringify(dto);
  for(const privateName of ['telegramId','grant_id','subscription_id','subject_fingerprint','accountFingerprint','BOT_TOKEN','sourceRef'])assert.equal(encoded.includes(privateName),false);
});

test('Paid Dragon and cancellation show exact verified period beyond the five-minute session without reconciliation writes',async t=>{
  const f=fixture(t);finance(f);const purchase=await paid(f);f.binding.audit.length=0;
  let dto=await readSubscriptionAccess(await authorize(f));
  assert.equal(dto.current.planCode,'dragon');assert.equal(dto.current.activeDragon,true);
  assert.equal(dto.current.previewActive,false);assert.equal(dto.current.sourceKind,'stars');
  assert.equal(dto.current.startsAt,purchase.paidAt);assert.equal(dto.current.expiresAt,purchase.paidAt+2592000);
  assert.equal(dto.current.remainingSeconds,purchase.paidAt+2592000-f.now);
  assert.ok(dto.current.expiresAt>dto.sessionExpiresAt);assertReads(f);
  f.sqlite.exec("UPDATE subscriptions SET status='cancel_at_period_end',revision=revision+1;UPDATE user_access_states SET access_state='cancel_at_period_end',revision=revision+1 WHERE telegram_id=101");
  f.binding.audit.length=0;dto=await readSubscriptionAccess(await authorize(f));
  assert.equal(dto.current.accessState,'cancel_at_period_end');assert.equal(dto.current.activeDragon,true);assertReads(f);
});

test('Preview remains Free with an overlay, exact seven-day expiry and no paid Dragon entitlement',async t=>{
  const f=fixture(t),grant=await preview(f);f.binding.audit.length=0;
  const dto=await readSubscriptionAccess(await authorize(f));
  assert.equal(dto.current.planCode,'free');assert.equal(dto.current.accessState,'trial');
  assert.equal(dto.current.previewActive,true);assert.equal(dto.current.activeDragon,false);
  assert.equal(dto.current.sourceKind,'preview');assert.equal(dto.current.startsAt,grant.start);
  assert.equal(dto.current.expiresAt,grant.end);assert.equal(dto.current.remainingSeconds,grant.end-f.now);
  assert.equal(dto.preview.historyUsed,true);assert.equal(dto.preview.reasonCode,'preview_active');
  assert.equal(dto.preview.canRequestActivation,false);assert.equal(dto.preview.durationSeconds,604800);assertReads(f);
});

test('Expiry is effective before maintenance, while refunded and suspended states never advertise active Dragon',async t=>{
  const f=fixture(t),expired=await preview(f,{start:f.now-604801});f.binding.audit.length=0;
  const dto=await readSubscriptionAccess(await authorize(f));
  assert.equal(dto.current.planCode,'free');assert.equal(dto.current.accessState,'expired');
  assert.equal(dto.current.expiresAt,expired.end);assert.equal(dto.current.remainingSeconds,0);
  assert.equal(dto.current.durationKind,'ended');assert.equal(dto.current.activeDragon,false);
  assert.equal(dto.current.previewActive,false);assert.equal(dto.preview.historyUsed,true);assertReads(f);
  const g=fixture(t);finance(g);const purchase=await paid(g);
  g.sqlite.exec("UPDATE subscriptions SET status='suspended',revision=revision+1;UPDATE user_access_states SET access_state='suspended',revision=revision+1 WHERE telegram_id=101");
  let stopped=await readSubscriptionAccess(await authorize(g));
  assert.equal(stopped.current.planCode,'free');assert.equal(stopped.current.accessState,'suspended');
  assert.equal(stopped.current.activeDragon,false);assert.equal(stopped.current.expiresAt,null);
  g.sqlite.exec("UPDATE subscriptions SET status='active',revision=revision+1;UPDATE user_access_states SET access_state='active',revision=revision+1 WHERE telegram_id=101");
  await applyStarsCompensation(g.commerceEnv,{telegramPaymentChargeId:purchase.chargeId,
    compensationType:'refund',telegramUpdateId:next(),occurredAt:g.now});
  stopped=await readSubscriptionAccess(await authorize(g));
  assert.equal(stopped.current.accessState,'refunded');assert.equal(stopped.current.planCode,'free');
  assert.equal(stopped.current.activeDragon,false);assert.equal(stopped.current.expiresAt,null);
});

test('Retained anonymous one-use marker prevents a new Preview and never grants active access',async t=>{
  const f=fixture(t),history=await preview(f,{start:f.now-604900,retained:true});f.binding.audit.length=0;
  const dto=await readSubscriptionAccess(await authorize(f));
  assert.equal(dto.current.planCode,'free');assert.equal(dto.current.previewActive,false);
  assert.equal(dto.current.expiresAt,null);assert.equal(dto.preview.historyUsed,true);
  assert.equal(dto.preview.startsAt,history.start);assert.equal(dto.preview.expiresAt,history.end);
  assert.equal(dto.preview.canRequestActivation,false);assert.equal(dto.preview.reasonCode,'preview_already_used');assertReads(f);
});

test('Missing financial authority yields an explicit review state instead of a guessed Free or dates',async t=>{
  const f=fixture(t);free(f);const prepare=f.binding.prepare.bind(f.binding);
  f.binding.prepare=sql=>{if(sql.includes('FROM user_plans '))throw new Error('offline unavailable');return prepare(sql);};
  const dto=await readSubscriptionAccess(await authorize(f));
  assert.equal(dto.current.status,'review_required');assert.equal(dto.current.planCode,null);
  assert.equal(dto.current.expiresAt,null);assert.equal(dto.current.remainingSeconds,null);
  assert.equal(dto.current.durationKind,'unknown');assert.equal(dto.current.activeDragon,false);
  assert.equal(dto.preview.canRequestActivation,false);assert.equal(dto.preview.historyUsed,null);
});

test('Forged DTOs, wrong operation and changed source proofs fail closed; canonical owner exception is separate from plan',async t=>{
  const f=fixture(t);free(f);const auth=await authorize(f);
  assert.throws(()=>projectSubscriptionAccess({...auth}),{code:'untrusted_runtime_authorization'});
  assert.throws(()=>readSubscriptionActorFacts({}),{code:'untrusted_actor'});
  const other=await authorize(f,101,'profile.read_own');
  assert.throws(()=>projectSubscriptionAccess(other),{code:'subscription_access_scope_mismatch'});
  f.sqlite.exec("UPDATE user_access SET trial_used=1 WHERE telegram_id=101");
  await assert.rejects(readSubscriptionAccess(auth),{code:'authority_stale'});
  const owner=fixture(t);free(owner,900);const ownerDto=await readSubscriptionAccess(await authorize(owner,900));
  assert.equal(ownerDto.ownerException.applies,true);assert.equal(ownerDto.ownerException.source,'canonical_owner');
  assert.equal(ownerDto.ownerException.isPaidPlan,false);assert.equal(ownerDto.current.planCode,'free');assert.equal(ownerDto.current.activeDragon,false);
  const ownerActor=readRuntimeAuthorization(await authorize(owner,900)).actor;
  assert.ok(Object.isFrozen(readSubscriptionActorFacts(ownerActor).preview));
});

test('Disabled, incomplete, closed or fake Workflow config never claims Preview activation is ready',async t=>{
  for(const patch of [{DRAGON_PREVIEW_ENABLED:'false'},{DRAGON_PREVIEW_WORKFLOW:undefined,previewWorkflowConnected:true},
    {DRAGON_PREVIEW_PROGRAM_END_AT:new Date((Date.now()-86400*1000)).toISOString()}]){
    const f=fixture(t);free(f);Object.assign(f.serverEnv,patch);
    const dto=await readSubscriptionAccess(await authorize(f));
    assert.equal(dto.preview.canRequestActivation,false);assert.equal(dto.preview.eligibility,'unavailable');
    assert.ok(['preview_disabled','preview_configuration_required','preview_program_closed'].includes(dto.preview.reasonCode));
  }
});
