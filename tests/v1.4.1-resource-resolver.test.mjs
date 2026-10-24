import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { acceptStarsPurchaseTerms, issueStarsPurchase, handleStarsCommerceUpdate } from '../src/v1.3.6/stars-commerce-runtime.mjs';
import { createReferralRewardCandidate } from '../src/v1.3.7/referral-reward-candidate-runtime.mjs';
import { createD1AnalyticsIngestionStore, ingestAnalyticsBatch } from '../src/v1.3.9/analytics-ingestion.mjs';
import { readAnalyticsV2Config } from '../src/v1.3.9/analytics-foundation.mjs';
import { FOUNDATION_POLICY_VERSION } from '../src/v1.4.1/capability-policy.mjs';
import { fixture, approvedPartner, publishedOffer, signedInitData } from './helpers/v1.4.0-rebuild-sqlite.mjs';
import { createCustomerContext, createServiceExecutor } from '../src/v1.4.1/trusted-context.mjs';
import { createAuthorityResolver } from '../src/v1.4.1/authority-resolver.mjs';
import { createResourceResolver, readResourceFacts, readResourceContext,
  isTrustedResource, compileResourceAssertions, compileResourceReplayAssertions,
  RESOURCE_QUOTA_PREDICATES } from '../src/v1.4.1/resource-resolver.mjs';

const setup=t=>{
  const f=fixture({exactSchema:true});t.after(f.close);
  for(const file of ['0062-v1.4.1-capability-policy.sql','0063-v1.4.1-grants-overrides.sql','0064-v1.4.1-audit-rollout.sql']) {
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  }
  return f;
};
const resolve=async(f,id,operation,ref=null,options={})=>{
  const context=await createCustomerContext({binding:f.binding,env:{...f.env(id),ADMIN_ID:'900'},
    initData:signedInitData(id,f.now),channel:'mini_app',operation,nowSeconds:f.now,...options});
  const actor=await createAuthorityResolver().resolveActor(context);
  const resource=await createResourceResolver().resolve(context,actor,ref);
  return {context,actor,resource,facts:readResourceFacts(resource)};
};
const serviceResource=async(f,purpose,ref)=>{
  const context=createServiceExecutor({binding:f.binding,env:{...f.baseEnv,ADMIN_ID:'900'},purpose,clockSeconds:()=>f.now}).createContext();
  const actor=await createAuthorityResolver().resolveActor(context);
  const resource=await createResourceResolver().resolve(context,actor,ref);
  return {context,actor,resource,facts:readResourceFacts(resource)};
};
const fresh=(f,resource)=>{
  const proof=compileResourceAssertions(resource);
  return f.sqlite.prepare(`SELECT CASE WHEN ${proof.sql} THEN 1 ELSE 0 END AS valid`).get(...proof.params).valid;
};
const replayFresh=(f,resource)=>{
  const proof=compileResourceReplayAssertions(resource);
  return f.sqlite.prepare(`SELECT CASE WHEN ${proof.sql} THEN 1 ELSE 0 END AS valid`).get(...proof.params).valid;
};
const readsOnly=f=>assert.ok(f.binding.audit.every(entry=>entry.mode==='read' &&
  !/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(entry.sql) && !/SELECT\s+\*/iu.test(entry.sql)));

// Accepted commerce/analytics producers establish the real source enums and
// relationships. Every external Telegram operation remains an offline stub.
let sourceSequence=910000;
const sourceNext=()=>++sourceSequence;
const sqlDate=seconds=>new Date(seconds*1000).toISOString().slice(0,19).replace('T',' ');
async function serviceSources(f) {
  const day=86400;
  for(const name of ['0026-v1.3.6-stars-core-foundation.sql','0037-v1.3.9-canonical-analytics-foundation.sql','0038-v1.3.9-analytics-ingestion.sql']) {
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  }
  const env={...f.baseEnv,STARS_PAYMENTS_ENABLED:'true',STARS_BILLING_MODE:'prepaid',STARS_PRICE_VERSION:'1',
    STARS_TERMS_REVISION:'2026-09-10.stars-v1',STARS_INVOICE_SECRET:'offline-all-services-stars-secret-more-than-thirty-two-characters',
    REFERRAL_REWARDS_ENABLED:'true',REFERRAL_REWARD_ROLLOUT_MODE:'public',REFERRAL_REWARD_CANDIDATES_ENABLED:'true',
    REFERRAL_REWARD_PROGRAM_STARTED_AT:String(f.now-60*day)};
  const first=f.now-22*day,at=f.now-21*day-40;
  f.sqlite.prepare('UPDATE users SET inviter_id=101,inviter_bound_at=?,joined_at=? WHERE telegram_id=202').run(sqlDate(first),sqlDate(first));
  f.sqlite.prepare("INSERT INTO bot_start_events(telegram_id,source_code,is_new_user,started_at) VALUES(202,'referral',1,?)").run(sqlDate(first));
  f.sqlite.exec("INSERT INTO user_plans(telegram_id,plan_code,source_code) VALUES(202,'free','system_default'); INSERT INTO user_access_states(telegram_id,access_state,source_code) VALUES(202,'none','system_default')");
  await acceptStarsPurchaseTerms(env,{telegramId:202,telegramUpdateId:sourceNext(),acceptedAt:at-1});
  const calls=[],telegramApi=async(_env,method,payload)=>{calls.push({method,payload});return method==='sendInvoice'?{message_id:sourceNext()}:true;};
  const orderId=crypto.randomUUID();
  const invoice=await issueStarsPurchase(env,{telegramId:202,requestedPlanCode:'professional',telegramUpdateId:sourceNext(),orderId,createdAt:at},{telegramApi});
  const payload=calls.find(call=>call.method==='sendInvoice').payload.payload;
  const checkout=await handleStarsCommerceUpdate(env,{update_id:sourceNext(),pre_checkout_query:{id:'offline-services-checkout-'+sourceNext(),from:{id:202,is_bot:false},currency:'XTR',total_amount:invoice.amountStars,invoice_payload:payload}},{nowSeconds:at+1,telegramApi});
  assert.equal(checkout.approved,true);
  const payment=await handleStarsCommerceUpdate(env,{update_id:sourceNext(),message:{message_id:sourceNext(),from:{id:202,is_bot:false},chat:{id:202,type:'private'},successful_payment:{currency:'XTR',total_amount:invoice.amountStars,invoice_payload:payload,telegram_payment_charge_id:'offline-services-charge-'+sourceNext(),provider_payment_charge_id:''}}},{nowSeconds:at+2,telegramApi});
  assert.equal(payment.accessApplied,true,JSON.stringify(payment));
  const candidate=await createReferralRewardCandidate(env,{orderId,selectedAt:at+3});
  assert.equal(candidate.status,'created',JSON.stringify(candidate));
  assert.ok(candidate.confirmAfter<=f.now);
  const subscription=f.sqlite.prepare('SELECT subscription_id,current_period_end FROM subscriptions WHERE source_order_id=?').get(orderId);
  const event=f.sqlite.prepare("SELECT event_id FROM payment_events WHERE order_id=? AND event_type='successful_payment_received' ORDER BY received_at DESC LIMIT 1").get(orderId);
  assert.ok(event);
  const reconciliation=crypto.randomUUID();
  f.sqlite.prepare("INSERT INTO payment_reconciliation_runs(run_id,run_source,status,started_at,finished_at,updated_at) VALUES(?,'scheduled','manual_review',?,?,?)").run(reconciliation,f.now-10,f.now-9,f.now-9);
  const trial=crypto.randomUUID(),expired=crypto.randomUUID(),retention=crypto.randomUUID();
  const insertTrial=(id,telegramId,status,end,retentionAt,anonymized=null)=>{
    const start=end-604800;
    f.sqlite.prepare("INSERT INTO trial_grants(grant_id,telegram_id,subject_fingerprint,program_code,source_code,status,started_at,ends_at,retention_until,workflow_instance_id,workflow_state,granted_at,ended_at,anonymized_at,updated_at) VALUES(?,?,?,'dragon_preview','dragon_preview:v1.3.5-hotfix.1',?,?,?,?,?,'completed',?,?,?,?)")
      .run(id,telegramId,createHash('sha256').update(id).digest('hex'),status,start,end,retentionAt,'offline-services-preview-'+id,start,status==='active'?null:end,anonymized,f.now);
  };
  insertTrial(trial,303,'active',f.now-1,f.now+day);
  insertTrial(expired,101,'expired',f.now-2,f.now+day);
  insertTrial(retention,null,'revoked',f.now-2*day,f.now-1,f.now-day);
  const notification='offline-service-notification-'+sourceNext();
  f.sqlite.prepare("INSERT INTO notification_jobs(job_key,telegram_id,related_grant_id,job_type,status,scheduled_for,created_at,updated_at) VALUES(?,101,?,'preview_ended','pending',?,?,?)")
    .run(notification,expired,f.now-1,f.now-10,f.now-10);
  const command='offline-services-command-'+sourceNext(),outbox='offline-services-effect-'+sourceNext();
  f.sqlite.prepare("INSERT INTO mini_app_command_receipts(idempotency_key,request_hash,bot_id,actor_telegram_id,operation,commit_status,response_json,committed_at,precondition_ok) VALUES(?,'hash','123456789',101,'cabinet.synthetic','committed','{}',?,1)").run(command,f.now-1);
  f.sqlite.prepare("INSERT INTO mini_app_effect_outbox(dedupe_key,command_key,effect_kind,payload_json,created_at) VALUES(?,?,'analytics_adapter','{}',?)").run(outbox,command,f.now-1);
  const controls={ANALYTICS_V2_ROLLOUT_MODE:'admin_shadow',ANALYTICS_V2_ENABLED:'true',ANALYTICS_V2_INGEST_ENABLED:'true'};
  const ingestionAt=Math.max(f.now,f.sqlite.prepare("SELECT created_at FROM analytics_source_checkpoints WHERE source_kind='users'").get().created_at);
  const ingested=await ingestAnalyticsBatch({config:readAnalyticsV2Config({...f.baseEnv,...controls}),
    store:createD1AnalyticsIngestionStore(f.binding),sourceKind:'users',records:[],origin:'reconciliation',
    highWatermarkAt:ingestionAt,pseudonymSecret:'offline-all-service-analytics-secret-more-than-32-characters',startedAt:ingestionAt,finishedAt:ingestionAt});
  assert.equal(ingested.status,'complete');
  const reservation='offline-existing-service-incurred-cost',date=new Date(f.now*1000).toISOString().slice(0,10),cycle=Math.floor(f.now/2592000)*2592000;
  f.sqlite.prepare("INSERT INTO ai_quota_reservations(request_id,telegram_id,usage_date,bucket,reserved_milli,status,completed_at) VALUES(?,900,?,'admin',1,'released',CURRENT_TIMESTAMP)").run(reservation,date);
  f.sqlite.prepare("INSERT INTO ai_gateway_budget_reservations(request_id,owner_telegram_id,usage_date,user_cycle_start_at,user_cycle_end_at,global_cycle_start_at,global_cycle_end_at,reserved_billed_tokens,reserved_cost_microusd,reservation_state,policy_version,pricing_version,created_at,completed_at) VALUES(?,900,?,?,?,?,?,10000,5000,'released','2026-09-12.ai-partner-v1','2026-09-12.deepseek-v4.1-flash-peak-v1',?,?)")
    .run(reservation,date,cycle,cycle+2592000,cycle,cycle+2592000,f.now-1,f.now);
  return {subscription,expired,cases:[
    ['preview_expire','service.preview.expire',{kind:'trial_grant',key:trial},true],
    ['stars_reconcile','service.stars.reconcile',{kind:'reconciliation_run',key:reconciliation},true],
    ['stars_expire','service.stars.expire',{kind:'subscription',key:subscription.subscription_id},true],
    ['stars_process_event','service.stars.process_event',{kind:'payment_event',key:event.event_id},true],
    ['referral_settle','service.referral.settle',{kind:'referral_reward',key:candidate.rewardId},true],
    ['privacy_cleanup','service.privacy.cleanup',{kind:'retention_trial_grant',key:retention},true],
    ['notification_deliver_historical','service.notification.deliver_historical',{kind:'notification_job',key:notification},false],
    ['outbox_drain','service.outbox.drain',{kind:'effect_outbox',key:outbox},false],
    ['analytics_ingest','service.analytics.ingest',{kind:'ingestion_receipt',key:ingested.receipt.receiptId},false],
    ['ai_settle_cost','service.ai.settle_cost',{kind:'ai_budget_reservation',key:reservation},true],
  ]};
}

test('only real context-bound actor reads mint a private resource brand; JSON and cross-context copies fail',async t=>{
  const f=setup(t);
  const one=await resolve(f,101,'profile.read_own');
  assert.equal(isTrustedResource(one.resource),true);
  assert.equal(isTrustedResource(JSON.parse(JSON.stringify(one.resource))),false);
  assert.throws(()=>readResourceFacts({...one.resource}),/untrusted_resource/);
  assert.throws(()=>compileResourceAssertions({...one.resource}),/untrusted_resource/);
  assert.equal(readResourceContext(one.resource),one.context);
  const other=await resolve(f,202,'profile.read_own');
  await assert.rejects(()=>createResourceResolver().resolve(other.context,one.actor),/untrusted_actor/);
  await assert.rejects(()=>createResourceResolver().resolve({...one.context},one.actor),/untrusted_context/);
  assert.ok(Object.isFrozen(one.facts));assert.ok(Object.isFrozen(one.facts.domain));
});

test('own preregistration, privacy and payment help are actor-scoped and create no role, plan or resource grants',async t=>{
  const f=setup(t);
  f.sqlite.exec("DELETE FROM user_roles WHERE telegram_id=404; DELETE FROM user_access WHERE telegram_id=404; DELETE FROM users WHERE telegram_id=404");
  for(const capability of ['terms.accept','account.register','privacy.read_own','billing.payment_help','help.read']) {
    const result=await resolve(f,404,capability);
    assert.equal(result.facts.exists,true);assert.equal(result.facts.subjectTelegramId,404);
    assert.equal(result.facts.partnerProfileId,null);
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM users WHERE telegram_id=404').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM entitlement_grants').get().n,0);
  await assert.rejects(()=>resolve(f,101,'privacy.read_own',{kind:'actor',key:202}),/invalid_resource_reference/);
});

test('own private draft and archived history need neither public moderation nor a link; foreign is indistinguishable from missing',async t=>{
  const f=setup(t);await approvedPartner(f,202);
  const created=await f.call(202,'offers',{method:'POST',payload:{}});
  assert.equal(created.status,200);const code=created.data.offerCode;
  const own=await resolve(f,202,'offer.read_own',{kind:'offer',key:code});
  assert.equal(own.facts.exists,true);assert.equal(own.facts.status,'draft');
  assert.equal(own.facts.publicEligible,false);assert.equal(own.facts.route.approved,false);
  f.sqlite.prepare("UPDATE offers SET status='archived' WHERE code=?").run(code);
  const archived=await resolve(f,202,'offer.read_own',{kind:'offer',key:code});
  assert.equal(archived.facts.exists,true);assert.equal(archived.facts.status,'archived');
  const foreign=await resolve(f,101,'offer.read_own',{kind:'offer',key:code});
  const missing=await resolve(f,101,'offer.read_own',{kind:'offer',key:'nonexistent'});
  for(const facts of [foreign.facts,missing.facts]) {
    assert.equal(facts.exists,false);assert.equal(facts.reasonCode,'not_found');
    for(const key of ['ownerTelegramId','partnerProfileId','tenantKey','status','visibility','version','route']) assert.equal(facts[key],null);
    assert.deepEqual(facts.usage,{});assert.deepEqual(facts.canonical,{});
  }
});

test('public partner offers require actual approved current snapshot, owner link, domain, visibility and window',async t=>{
  const f=setup(t);const published=await publishedOffer(f,202);
  const get=()=>resolve(f,101,'offer.read_public',{kind:'offer',key:published.code});
  const good=await get();assert.equal(good.facts.publicEligible,true);
  assert.equal(good.facts.version.hashValid,true);assert.equal(good.facts.route.domainAllowed,true);
  assert.equal(fresh(f,good.resource),1);
  const link=f.sqlite.prepare('SELECT url FROM partner_links WHERE id=?').get(published.linkId).url;
  f.sqlite.prepare("UPDATE partner_links SET url='https://unapproved.example/x' WHERE id=?").run(published.linkId);
  assert.equal(fresh(f,good.resource),0);assert.equal((await get()).facts.exists,false);
  f.sqlite.prepare('UPDATE partner_links SET url=? WHERE id=?').run(link,published.linkId);
  f.sqlite.prepare("UPDATE offer_visibility_rules SET visibility='private' WHERE offer_code=?").run(published.code);
  assert.equal((await get()).facts.exists,false);
  f.sqlite.prepare("UPDATE offer_visibility_rules SET visibility='public',approved_version_id=NULL WHERE offer_code=?").run(published.code);
  assert.equal((await get()).facts.exists,false);
});

test('assigned offer visibility belongs to the exact active recipient and survives no forged assignment facts',async t=>{
  const f=setup(t);const published=await publishedOffer(f,202);
  f.sqlite.prepare("UPDATE offer_visibility_rules SET visibility='assigned' WHERE offer_code=?").run(published.code);
  f.sqlite.prepare("INSERT INTO offer_visibility_assignments(offer_code,telegram_id,assigned_by) VALUES(?,101,900)").run(published.code);
  const own=await resolve(f,101,'offer.read_assigned',{kind:'offer',key:published.code});
  assert.equal(own.facts.exists,true);assert.equal(own.facts.assignedTelegramId,101);
  const foreign=await resolve(f,303,'offer.read_assigned',{kind:'offer',key:published.code});
  assert.equal(foreign.facts.exists,false);
  f.sqlite.prepare("UPDATE offer_visibility_assignments SET assignment_status='revoked' WHERE offer_code=? AND telegram_id=101").run(published.code);
  assert.equal(fresh(f,own.resource),0);
  assert.equal((await resolve(f,101,'offer.read_assigned',{kind:'offer',key:published.code})).facts.exists,false);
});

test('notification lookups expose only exact recipient and reject caller ownership JSON',async t=>{
  const f=setup(t);
  f.sqlite.exec("INSERT INTO notifications(id,recipient_id,event_type,message_html) VALUES(17,202,'synthetic','private text')");
  const own=await resolve(f,202,'notification.manage_own',{kind:'notification',key:17});
  assert.equal(own.facts.exists,true);assert.equal(own.facts.domain.recipientMatches,true);
  const foreign=await resolve(f,101,'notification.manage_own',{kind:'notification',key:17});
  const absent=await resolve(f,101,'notification.manage_own',{kind:'notification',key:18});
  assert.equal(foreign.facts.reasonCode,absent.facts.reasonCode);
  assert.equal(foreign.facts.ownerTelegramId,null);assert.deepEqual(foreign.facts.canonical,{});
  await assert.rejects(()=>resolve(f,101,'notification.manage_own',{kind:'notification',key:17,ownerTelegramId:101}),/invalid_resource_reference/);
});

test('application quota uses only own pending/confirmed leads, never mirrors or other applicants',async t=>{
  const f=setup(t);const published=await publishedOffer(f,202);
  for(const [index,status,owner] of [[1,'pending',101],[2,'confirmed',101],[3,'rejected',101],[4,'paid',101],[5,'pending',303]]) {
    f.sqlite.prepare("INSERT INTO offers(code,button_text,title) VALUES(?,?,?)").run('quota_offer_'+index,'Test','Synthetic');
    f.sqlite.prepare('INSERT INTO lead_requests(telegram_id,offer_code,status) VALUES(?,?,?)').run(owner,'quota_offer_'+index,status);
  }
  f.sqlite.prepare("INSERT INTO conversions(telegram_id,offer_code,status) VALUES(101,'quota_offer_1','pending')").run();
  const result=await resolve(f,101,'application.create',{kind:'offer',key:published.code});
  assert.equal(result.facts.usage.active_applications,2);assert.equal(result.facts.quotaDelta,1);
  assert.equal(result.facts.selfApplication,false);assert.equal(fresh(f,result.resource),1);
  f.sqlite.prepare('INSERT INTO lead_requests(telegram_id,offer_code) VALUES(101,?)').run(published.code);
  assert.equal(fresh(f,result.resource),0);assert.equal(replayFresh(f,result.resource),1);
  const duplicate=await resolve(f,101,'application.create',{kind:'offer',key:published.code});
  assert.equal(duplicate.facts.usage.active_applications,3);assert.equal(duplicate.facts.quotaDelta,0);
  assert.equal(duplicate.facts.canonical.existingLead.telegramId,101);
});

test('working offers count exact partner draft/active/paused, preserve independent Beta cap and paused activation delta zero',async t=>{
  const f=setup(t);const partner=await approvedPartner(f,202);const other=await approvedPartner(f,303);
  for(const [index,status,profile] of [[1,'draft',partner.profileId],[2,'active',partner.profileId],[3,'paused',partner.profileId],[4,'archived',partner.profileId],[5,'draft',other.profileId]]) {
    f.sqlite.prepare('INSERT INTO offers(code,button_text,title,status) VALUES(?,?,?,?)').run('working_'+index,'Test','Synthetic',status);
    f.sqlite.prepare("INSERT INTO offer_owners(offer_code,owner_kind,partner_profile_id,created_by) VALUES(?,'partner',?,900)").run('working_'+index,profile);
  }
  const create=await resolve(f,202,'offer.create_private');
  assert.equal(create.facts.usage.own_working_offers,3);assert.equal(create.facts.quotaDelta,1);
  assert.equal(create.facts.usage.betaOfferLimit,f.sqlite.prepare('SELECT max_active_offers_per_partner n FROM partner_beta_settings WHERE id=1').get().n);
  const resume=await resolve(f,202,'offer.activate_own',{kind:'offer',key:'working_3'});
  assert.equal(resume.facts.usage.own_working_offers,3);assert.equal(resume.facts.quotaDelta,0);
  const archived=await resolve(f,202,'offer.activate_own',{kind:'offer',key:'working_4'});
  assert.equal(archived.facts.domain.transitionAllowed,false);
});

test('active campaign counter uses actual current partner owner and no time predicate or nonactive rows',async t=>{
  const f=setup(t);const partner=await approvedPartner(f,202);const other=await approvedPartner(f,303);
  const owners=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
  for(const [index,p] of [partner,other].entries()) {
    f.sqlite.prepare("INSERT INTO ambassador_profiles_v2(ambassador_id,partner_profile_id,owner_pseudonym,pseudonym_key_version,eligibility_evidence_hash,created_at,updated_at) VALUES(?,?,?,1,?,?,?)")
      .run(owners[index],p.profileId,'a'.repeat(64), 'b'.repeat(64),f.now-400,f.now-400);
    f.sqlite.prepare("INSERT INTO ambassador_profile_transitions(transition_id,transition_key,ambassador_id,profile_revision,from_status,to_status,reason_code,actor_kind,evidence_hash,occurred_at,created_at) VALUES(?,?,?,2,'draft','active','activation_approved','admin',?,?,?)")
      .run(`33333333-3333-4333-8333-${String(index+1).padStart(12,'0')}`,String(index+1).repeat(64),owners[index],'b'.repeat(64),f.now-400,f.now-400);
  }
  for(const [index,status,owner,start,end] of [[1,'active',0,f.now-300,f.now-100],[2,'active',0,f.now+100,f.now+300],[3,'paused',0,f.now-51,f.now+50],[4,'draft',0,f.now-52,f.now+50],[5,'active',1,f.now-50,f.now+50]]) {
    const id=`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
    f.sqlite.prepare("INSERT INTO ambassador_campaigns(campaign_id,ambassador_id,scope_kind,program_code,scope_evidence_hash,starts_at,ends_at,created_at,updated_at) VALUES(?,?,'program','bank_program',?,?,?,?,?)")
      .run(id,owners[owner],'c'.repeat(64),start,end,f.now-400,f.now-400);
    if(status!=='draft') {
      const at=start+1;
      f.sqlite.prepare("INSERT INTO ambassador_campaign_transitions(transition_id,transition_key,campaign_id,campaign_revision,from_status,to_status,reason_code,actor_kind,evidence_hash,occurred_at,created_at) VALUES(?,?,?,2,'draft','active','activation_approved','admin',?,?,?)")
        .run(`44444444-4444-4444-8444-${String(index).padStart(12,'0')}`,String(index).repeat(64),id,'c'.repeat(64),at,at);
      if(status==='paused') f.sqlite.prepare("INSERT INTO ambassador_campaign_transitions(transition_id,transition_key,campaign_id,campaign_revision,from_status,to_status,reason_code,actor_kind,evidence_hash,occurred_at,created_at) VALUES(?,?,?,3,'active','paused','owner_paused','ambassador',?,?,?)")
        .run(`55555555-5555-4555-8555-${String(index).padStart(12,'0')}`,String(index+5).repeat(64),id,'c'.repeat(64),at+1,at+1);
    }
  }
  const result=await resolve(f,202,'campaign.read_own');
  assert.equal(result.facts.usage.active_campaigns,2);
  assert.equal(result.facts.domain.approvedIssuerRoute,false);
  assert.equal(fresh(f,result.resource),1);
  f.sqlite.prepare("UPDATE partner_profiles SET telegram_id=101 WHERE id=?").run(partner.profileId);
  assert.equal(fresh(f,result.resource),0);
});

test('explicit admin target does not manufacture own partner edit rights; unsupported future operations stay closed',async t=>{
  const f=setup(t);const published=await publishedOffer(f,202);
  const admin=await resolve(f,900,'admin.offer.moderate',{kind:'offer',key:published.code});
  assert.equal(admin.facts.domain.adminTargetExplicit,true);assert.equal(admin.facts.ownerTelegramId,202);
  const ordinary=await resolve(f,900,'offer.edit_own',{kind:'offer',key:published.code});
  assert.equal(ordinary.facts.exists,false);
  const future=await resolve(f,101,'crm.export');
  assert.equal(future.facts.exists,false);assert.equal(future.facts.reasonCode,'resource_adapter_unavailable');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM entitlement_grants').get().n,0);
});

test('canonical loader is SELECT-only, shares root primary session and rejects unavailable/overflowed storage',async t=>{
  const f=setup(t);const published=await publishedOffer(f,202);
  f.binding.audit.length=0;
  const before=f.binding.sessions.length;
  const result=await resolve(f,101,'offer.read_public',{kind:'offer',key:published.code});
  assert.equal(result.facts.exists,true);readsOnly(f);
  assert.equal(f.binding.sessions.length-before,1);
  assert.equal(f.binding.sessions.at(-1),'first-primary');
  assert.ok(RESOURCE_QUOTA_PREDICATES.active_campaigns.includes("c.status='active'"));
  assert.equal(/starts_at|ends_at/iu.test(RESOURCE_QUOTA_PREDICATES.active_campaigns),false);
  await assert.rejects(()=>createResourceResolver({queryLimit:1}).resolve(result.context,result.actor,{kind:'offer',key:published.code}),/resource_query_budget_exhausted/);
});

test('service outbox proof requires exact compiled purpose and a durable committed source receipt',async t=>{
  const f=setup(t);
  f.sqlite.exec("INSERT INTO mini_app_command_receipts(idempotency_key,request_hash,bot_id,actor_telegram_id,operation,commit_status,response_json,committed_at,precondition_ok) VALUES('service_receipt','hash','123456789',101,'cabinet.synthetic','committed','{}',unixepoch(),1)");
  f.sqlite.exec("INSERT INTO mini_app_effect_outbox(dedupe_key,command_key,effect_kind,payload_json,created_at) VALUES('synthetic_effect','service_receipt','analytics_adapter','{}',unixepoch())");
  const result=await serviceResource(f,'outbox_drain',{kind:'effect_outbox',key:'synthetic_effect'});
  assert.equal(result.facts.exists,true);assert.equal(result.facts.domain.sourceReceiptVerified,true);
  assert.equal(result.facts.domain.trustedPurpose,'outbox_drain');
  const {can}=await import('../src/v1.4.1/entitlement-engine.mjs');
  assert.equal(can(result.actor,'service.outbox.drain',result.resource).allowed,true);
  assert.equal(fresh(f,result.resource),1);
  f.sqlite.exec("UPDATE mini_app_effect_outbox SET status='delivered' WHERE dedupe_key='synthetic_effect'");
  assert.equal(fresh(f,result.resource),0);
  const changed=await serviceResource(f,'outbox_drain',{kind:'effect_outbox',key:'synthetic_effect'});
  assert.equal(changed.facts.exists,false);
  const otherContext=createServiceExecutor({binding:f.binding,env:f.baseEnv,purpose:'stars_expire',clockSeconds:()=>f.now}).createContext();
  const otherActor=await createAuthorityResolver().resolveActor(otherContext);
  await assert.rejects(()=>createResourceResolver().resolve(otherContext,otherActor,{kind:'effect_outbox',key:'synthetic_effect'}),/invalid_resource_reference/);
});

test('system public offer requires its real coherent hashed current version and a valid canonical URL',async t=>{
  const f=setup(t);
  f.sqlite.exec("INSERT INTO offers(code,button_text,title,url,status) VALUES('system_public','Open','System source','https://bank.example/official','active')");
  f.sqlite.exec("INSERT INTO offer_owners(offer_code,owner_kind,created_by) VALUES('system_public','system',900)");
  const row=f.sqlite.prepare('SELECT * FROM offers WHERE code=?').get('system_public');
  const material=['code','button_text','title','description','provider','category','url','url_env_key','payout_text','required_action','min_age','max_age','geo','hold_days','traffic_sources','source_name','starts_at','expires_at','status'];
  const snapshot=JSON.stringify(Object.fromEntries(material.map(key=>[key,row[key]])));
  const hash='sha256:'+createHash('sha256').update(snapshot).digest('hex');
  f.sqlite.prepare("INSERT INTO offer_versions(offer_code,version_number,snapshot_json,business_status,content_hash,created_by) VALUES('system_public',1,?,'active',?,900)").run(snapshot,hash);
  const version=f.sqlite.prepare("SELECT id FROM offer_versions WHERE offer_code='system_public'").get().id;
  f.sqlite.prepare("INSERT INTO offer_visibility_rules(offer_code,moderation_status,visibility,current_version_id,approved_version_id) VALUES('system_public','approved','public',?,?)").run(version,version);
  const good=await resolve(f,101,'offer.read_public',{kind:'offer',key:'system_public'});
  assert.equal(good.facts.exists,true);assert.equal(good.facts.domain.ownerKind,'system');
  f.sqlite.exec("UPDATE offers SET title='Unversioned change' WHERE code='system_public'");
  assert.equal((await resolve(f,101,'offer.read_public',{kind:'offer',key:'system_public'})).facts.exists,false);
  f.sqlite.prepare('UPDATE offers SET title=? WHERE code=?').run(row.title,'system_public');
  assert.throws(()=>f.sqlite.prepare('UPDATE offer_versions SET content_hash=? WHERE id=?').run('sha256:'+'0'.repeat(64),version),/immutable/);
  f.sqlite.exec("INSERT INTO offers(code,button_text,title,url,status) VALUES('system_badhash','Open','Bad initial hash','https://bank.example/official','active')");
  f.sqlite.exec("INSERT INTO offer_owners(offer_code,owner_kind,created_by) VALUES('system_badhash','system',900)");
  const badRow=f.sqlite.prepare("SELECT * FROM offers WHERE code='system_badhash'").get();
  const badSnapshot=JSON.stringify(Object.fromEntries(material.map(key=>[key,badRow[key]])));
  f.sqlite.prepare("INSERT INTO offer_versions(offer_code,version_number,snapshot_json,business_status,content_hash,created_by) VALUES('system_badhash',1,?,'active',?,900)").run(badSnapshot,'sha256:'+'0'.repeat(64));
  const invalidVersion=f.sqlite.prepare("SELECT id FROM offer_versions WHERE offer_code='system_badhash'").get().id;
  f.sqlite.prepare("INSERT INTO offer_visibility_rules(offer_code,moderation_status,visibility,current_version_id,approved_version_id) VALUES('system_badhash','approved','public',?,?)").run(invalidVersion,invalidVersion);
  assert.equal((await resolve(f,101,'offer.read_public',{kind:'offer',key:'system_badhash'})).facts.exists,false);
});

test('previously approved campaign owner resumes only under actual closed admin-shadow controls and exact scope',async t=>{
  const f=setup(t);const partner=await approvedPartner(f,202);
  const ambassador='11111111-1111-4111-8111-111111111111',campaign='22222222-2222-4222-8222-222222222222';
  f.sqlite.prepare("INSERT INTO ambassador_profiles_v2(ambassador_id,partner_profile_id,owner_pseudonym,pseudonym_key_version,eligibility_evidence_hash,created_at,updated_at) VALUES(?,?,?,1,?,?,?)")
    .run(ambassador,partner.profileId,'a'.repeat(64),'b'.repeat(64),f.now-200,f.now-200);
  f.sqlite.prepare("INSERT INTO ambassador_profile_transitions(transition_id,transition_key,ambassador_id,profile_revision,from_status,to_status,reason_code,actor_kind,evidence_hash,occurred_at,created_at) VALUES(?,?,?,2,'draft','active','activation_approved','admin',?,?,?)")
    .run(crypto.randomUUID(),'1'.repeat(64),ambassador,'b'.repeat(64),f.now-190,f.now-190);
  f.sqlite.prepare("INSERT INTO ambassador_campaigns(campaign_id,ambassador_id,scope_kind,program_code,scope_evidence_hash,starts_at,ends_at,created_at,updated_at) VALUES(?,?,'program','bank_program',?,?,?,?,?)")
    .run(campaign,ambassador,'c'.repeat(64),f.now-180,f.now+600,f.now-190,f.now-190);
  f.sqlite.prepare("INSERT INTO ambassador_campaign_transitions(transition_id,transition_key,campaign_id,campaign_revision,from_status,to_status,reason_code,actor_kind,evidence_hash,occurred_at,created_at) VALUES(?,?,?,2,'draft','active','activation_approved','admin',?,?,?)")
    .run(crypto.randomUUID(),'2'.repeat(64),campaign,'c'.repeat(64),f.now-170,f.now-170);
  f.sqlite.prepare("INSERT INTO ambassador_campaign_transitions(transition_id,transition_key,campaign_id,campaign_revision,from_status,to_status,reason_code,actor_kind,evidence_hash,occurred_at,created_at) VALUES(?,?,?,3,'active','paused','owner_paused','ambassador',?,?,?)")
    .run(crypto.randomUUID(),'3'.repeat(64),campaign,'c'.repeat(64),f.now-160,f.now-160);
  const controls={ANALYTICS_V2_ROLLOUT_MODE:'admin_shadow',ANALYTICS_V2_ENABLED:'true',
    ANALYTICS_V2_INGEST_ENABLED:'true',ANALYTICS_V2_PROJECTIONS_ENABLED:'true',AMBASSADOR_V2_ENABLED:'true'};
  f.sqlite.prepare("INSERT INTO analytics_v2_settings(id,rollout_mode,master_enabled,ingest_enabled,projections_enabled,ambassador_enabled,updated_at) VALUES(1,'admin_shadow',1,1,1,1,?)").run(f.now);
  const run=env=>resolve(f,202,'campaign.resume',{kind:'campaign',key:campaign},{env:{...f.env(202),ADMIN_ID:'900',...controls,...env}});
  const eligible=await run({});
  assert.equal(eligible.facts.domain.approvedIssuerRoute,true);assert.equal(eligible.facts.domain.scopeEligible,true);
  assert.equal(eligible.facts.usage.active_campaigns,0);assert.equal(eligible.facts.quotaDelta,1);
  const {can}=await import('../src/v1.4.1/entitlement-engine.mjs');
  assert.equal(can(eligible.actor,'campaign.resume',eligible.resource).allowed,true);
  const disabled=await run({AMBASSADOR_V2_ENABLED:'false'});
  assert.equal(disabled.facts.domain.approvedIssuerRoute,false);
  assert.equal(can(disabled.actor,'campaign.resume',disabled.resource).allowed,false);
  f.sqlite.exec("UPDATE partner_programs SET status='paused' WHERE code='bank_program'");
  assert.equal(fresh(f,eligible.resource),0);
  assert.equal((await run({})).facts.domain.scopeEligible,false);
});

test('admin result facts come from exact bound domain intent and canonical state, never confirmation booleans',async t=>{
  const f=setup(t);f.sqlite.exec("INSERT INTO offers(code,button_text,title) VALUES('admin_target','Test','Synthetic')");
  f.sqlite.exec("INSERT INTO lead_requests(telegram_id,offer_code) VALUES(101,'admin_target')");
  const id=f.sqlite.prepare("SELECT id FROM lead_requests WHERE offer_code='admin_target'").get().id;
  const intent={leadId:id,decision:'confirm',rewardKopecks:500};
  const real=await resolve(f,900,'admin.application.result',{kind:'application',key:id},{requestPayload:intent});
  assert.equal(real.facts.domain.actionConfirmed,true);assert.equal(real.facts.domain.domainAuthorityValid,true);
  const {can}=await import('../src/v1.4.1/entitlement-engine.mjs');
  assert.equal(can(real.actor,'admin.application.result',real.resource).allowed,true);
  const forged=await resolve(f,900,'admin.application.result',{kind:'application',key:id},
    {requestPayload:{...intent,allowed:true,actionConfirmed:true}});
  assert.equal(forged.facts.domain.actionConfirmed,false);
  assert.equal(can(forged.actor,'admin.application.result',forged.resource).allowed,false);
});

test('actual Stars payment and cancel-at-period-end source permits due expiry maintenance, never early expiry',async t=>{
  const f=setup(t);let sequence=800000;
  const next=()=>++sequence;
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0026-v1.3.6-stars-core-foundation.sql',import.meta.url),'utf8'));
  f.sqlite.exec("INSERT INTO user_plans(telegram_id,plan_code,source_code) VALUES(101,'free','system_default'); INSERT INTO user_access_states(telegram_id,access_state,source_code) VALUES(101,'none','system_default')");
  const env={...f.baseEnv,STARS_PAYMENTS_ENABLED:'true',STARS_BILLING_MODE:'prepaid',STARS_PRICE_VERSION:'1',
    STARS_TERMS_REVISION:'2026-09-10.stars-v1',STARS_INVOICE_SECRET:'offline-resource-stars-secret-more-than-thirty-two-characters'};
  const at=f.now-10,calls=[];
  const telegramApi=async(_env,method,payload)=>{calls.push({method,payload});return method==='sendInvoice'?{message_id:next()}:true;};
  await acceptStarsPurchaseTerms(env,{telegramId:101,telegramUpdateId:next(),acceptedAt:at-1});
  const orderId=crypto.randomUUID();
  const issued=await issueStarsPurchase(env,{telegramId:101,requestedPlanCode:'professional',telegramUpdateId:next(),orderId,createdAt:at},{telegramApi});
  const invoicePayload=calls.find(call=>call.method==='sendInvoice').payload.payload;
  const pre=await handleStarsCommerceUpdate(env,{update_id:next(),pre_checkout_query:{id:'offline-checkout-'+next(),from:{id:101,is_bot:false},currency:'XTR',total_amount:issued.amountStars,invoice_payload:invoicePayload}},{nowSeconds:at+1,telegramApi});
  assert.equal(pre.approved,true);
  const paid=await handleStarsCommerceUpdate(env,{update_id:next(),message:{message_id:next(),from:{id:101,is_bot:false},chat:{id:101,type:'private'},successful_payment:{currency:'XTR',total_amount:issued.amountStars,invoice_payload:invoicePayload,telegram_payment_charge_id:'offline-resource-charge-'+next(),provider_payment_charge_id:''}}},{nowSeconds:at+2,telegramApi});
  assert.equal(paid.accessApplied,true);
  const subscription=f.sqlite.prepare('SELECT subscription_id,current_period_end FROM subscriptions WHERE source_order_id=?').get(orderId);
  f.sqlite.exec("UPDATE subscriptions SET status='cancel_at_period_end',revision=revision+1; UPDATE user_access_states SET access_state='cancel_at_period_end',revision=revision+1 WHERE telegram_id=101");
  const early=await serviceResource(f,'stars_expire',{kind:'subscription',key:subscription.subscription_id});
  assert.equal(early.facts.exists,false);
  f.now=subscription.current_period_end+1;
  const due=await serviceResource(f,'stars_expire',{kind:'subscription',key:subscription.subscription_id});
  assert.equal(due.facts.exists,true);assert.equal(due.facts.status,'cancel_at_period_end');
  const {can}=await import('../src/v1.4.1/entitlement-engine.mjs');
  assert.equal(can(due.actor,'service.stars.expire',due.resource).allowed,true);
  assert.ok(calls.every(call=>['sendInvoice','answerPreCheckoutQuery'].includes(call.method)));
});

test('existing program catalog admission resolves the actual attached partner link and immutable first attribution',async t=>{
  const f=setup(t);const partner=await approvedPartner(f,202);
  f.sqlite.exec("UPDATE users SET inviter_id=202 WHERE telegram_id=101; INSERT INTO offer_owners(offer_code,owner_kind,created_by) VALUES('bank_catalog','system',900)");
  const root=f.sqlite.prepare("SELECT * FROM offers WHERE code='bank_catalog'").get();
  const material=['code','button_text','title','description','provider','category','url','url_env_key','payout_text','required_action','min_age','max_age','geo','hold_days','traffic_sources','source_name','starts_at','expires_at','status'];
  const snapshot=JSON.stringify(Object.fromEntries(material.map(key=>[key,root[key]])));
  f.sqlite.prepare("INSERT INTO offer_versions(offer_code,version_number,snapshot_json,business_status,content_hash,created_by) VALUES('bank_catalog',1,?,'active',?,900)")
    .run(snapshot,'sha256:'+createHash('sha256').update(snapshot).digest('hex'));
  const version=f.sqlite.prepare("SELECT id FROM offer_versions WHERE offer_code='bank_catalog'").get().id;
  f.sqlite.prepare("INSERT INTO offer_visibility_rules(offer_code,moderation_status,visibility,current_version_id,approved_version_id) VALUES('bank_catalog','approved','public',?,?)").run(version,version);
  const result=await resolve(f,101,'application.create',{kind:'catalog_offer',key:17});
  assert.equal(result.facts.exists,true);assert.equal(result.facts.publicEligible,true);
  assert.equal(result.facts.canonical.eligibleOffer.sourceKind,'program_offer');
  assert.equal(result.facts.canonical.eligibleOffer.partnerProfileId,partner.profileId);
  assert.equal(result.facts.canonical.eligibleOffer.resolvedForTelegramId,101);
  const {can}=await import('../src/v1.4.1/entitlement-engine.mjs');
  assert.equal(can(result.actor,'application.create',result.resource).allowed,true);
  f.sqlite.prepare("UPDATE partner_links SET status='rejected' WHERE id=?").run(partner.linkId);
  assert.equal(fresh(f,result.resource),0);
  const unavailable=await resolve(f,101,'application.create',{kind:'catalog_offer',key:17});
  assert.equal(unavailable.facts.exists,false);
});

test('all ten fixed service purposes have genuine eligible canonical sources and unknown sources stay denied',async t=>{
  const f=setup(t),sources=await serviceSources(f);
  f.now=sources.subscription.current_period_end+1;
  const {can}=await import('../src/v1.4.1/entitlement-engine.mjs');
  for(const [purpose,capability,ref] of sources.cases) {
    const result=await serviceResource(f,purpose,ref);
    assert.equal(result.facts.exists,true,capability);
    assert.equal(result.facts.domain.canonicalServiceResource,true,capability);
    assert.equal(can(result.actor,capability,result.resource).allowed,true,capability);
    const absent=await serviceResource(f,purpose,{...ref,key:'unknown-service-source'});
    assert.equal(absent.facts.exists,false,capability);
    assert.equal(can(absent.actor,capability,absent.resource).allowed,false,capability);
  }
  const privacy=await serviceResource(f,'privacy_cleanup',{kind:'retention_trial_grant',key:sources.expired});
  assert.equal(privacy.facts.exists,false,'retention cannot erase an identified expired user grant');
  f.sqlite.exec('UPDATE users SET is_blocked=1 WHERE telegram_id=101');
  const notification=sources.cases.find(row=>row[0]==='notification_deliver_historical');
  const delivery=await serviceResource(f,notification[0],notification[2]);
  assert.equal(delivery.facts.exists,false,'notification must respect current recipient block');
  const referral=sources.cases.find(row=>row[0]==='referral_settle');
  const cleanup=await serviceResource(f,referral[0],referral[2]);
  assert.equal(can(cleanup.actor,referral[1],cleanup.resource).allowed,true,'financial maintenance must survive beneficiary restrictions');
});

test('actual service flags preserve seven essential duties and close the three delivery or analytics jobs',async t=>{
  const f=setup(t),sources=await serviceSources(f);
  f.now=sources.subscription.current_period_end+1;
  const {can}=await import('../src/v1.4.1/entitlement-engine.mjs');
  for(const [purpose,capability,ref,essential] of sources.cases) {
    f.sqlite.prepare("INSERT INTO feature_flags(flag_key,policy_version,enabled,emergency_disabled,reason,updated_at) VALUES(?,?,0,1,'offline service emergency stop',?)")
      .run('capability:'+capability,FOUNDATION_POLICY_VERSION,f.now);
    const result=await serviceResource(f,purpose,ref);
    assert.equal(result.facts.exists,true,capability);
    assert.equal(can(result.actor,capability,result.resource).allowed,essential,capability);
  }
  const outbox=sources.cases.find(row=>row[0]==='outbox_drain'),key='capability:'+outbox[1];
  const flags=(rollout)=>f.sqlite.prepare("UPDATE feature_flags SET enabled=1,emergency_disabled=0,rollout_json=?,updated_by=900,revision=revision+1,updated_at=updated_at+1 WHERE flag_key=?").run(JSON.stringify(rollout),key);
  for(const rollout of [{mode:'all'},{mode:'admin'},{mode:'selected_actors'},{mode:'all',payloadAllows:true},{mode:'unknown'}]) {
    flags(rollout);
    const result=await serviceResource(f,outbox[0],outbox[2]);
    assert.equal(can(result.actor,outbox[1],result.resource).allowed,rollout.mode==='all' && Object.keys(rollout).length===1,JSON.stringify(rollout));
  }
});

test('fixed server operation aliases resolve the same canonical capability and keep arbitrary aliases closed',async t=>{
  const f=setup(t);await approvedPartner(f,202);
  assert.equal((await f.call(202,'partner/legal-profile',{method:'POST',payload:{profileKind:'individual',selfDeclarationAccepted:true}})).status,200);
  const {can}=await import('../src/v1.4.1/entitlement-engine.mjs');
  for(const [alias,canonical,id] of [['offer.create','offer.create_private',202],['account.profile.read','profile.read_own',101]]) {
    const result=await resolve(f,id,alias);
    assert.equal(result.facts.capability,canonical);assert.equal(can(result.actor,canonical,result.resource).allowed,true,alias);
    assert.equal(can(result.actor,alias,result.resource).allowed,true,alias);
  }
  await assert.rejects(()=>resolve(f,101,'unknown.profile.alias'),/invalid_resource_operation/);
});

test('Professional comparison uses only actual released own partner projection and preserves privacy or rollout fences',async t=>{
  const f=setup(t);await serviceSources(f);const partner=await approvedPartner(f,202);
  const ambassador=crypto.randomUUID();
  f.sqlite.prepare("INSERT INTO ambassador_profiles_v2(ambassador_id,partner_profile_id,owner_pseudonym,pseudonym_key_version,eligibility_evidence_hash,created_at,updated_at) VALUES(?,?,?,1,?,?,?)")
    .run(ambassador,partner.profileId,'e'.repeat(64),'a'.repeat(64),f.now-100,f.now-100);
  f.sqlite.prepare("INSERT INTO ambassador_profile_transitions(transition_id,transition_key,ambassador_id,profile_revision,from_status,to_status,reason_code,actor_kind,evidence_hash,occurred_at,created_at) VALUES(?,?,?,2,'draft','active','activation_approved','admin',?,?,?)")
    .run(crypto.randomUUID(),'b'.repeat(64),ambassador,'a'.repeat(64),f.now-90,f.now-90);
  f.sqlite.prepare("UPDATE analytics_v2_settings SET rollout_mode='admin_shadow',master_enabled=1,ingest_enabled=1,projections_enabled=1,ambassador_enabled=1,revision=revision+1,updated_at=MAX(updated_at,?) WHERE id=1").run(f.now);
  f.sqlite.prepare("INSERT INTO analytics_v139_owner_runtime(id,audience_mode,enabled,updated_at) VALUES(1,'owner_only',1,?)").run(f.now);
  f.sqlite.prepare('INSERT INTO analytics_v139_partner_pilot(telegram_id,enabled,admitted_at,expires_at) VALUES(202,1,?,?)').run(f.now-1,f.now+600);
  const controls={ANALYTICS_V2_ROLLOUT_MODE:'admin_shadow',ANALYTICS_V2_ENABLED:'true',
    ANALYTICS_V2_INGEST_ENABLED:'true',ANALYTICS_V2_PROJECTIONS_ENABLED:'true',AMBASSADOR_V2_ENABLED:'true'};
  const run=env=>resolve(f,202,'analytics.compare_periods',null,{env:{...f.env(202),ADMIN_ID:'900',...controls,...env}});
  const good=await run({});
  const {can}=await import('../src/v1.4.1/entitlement-engine.mjs');
  assert.equal(good.actor.access.effectivePlan,'professional');
  assert.equal(good.facts.kind,'partner_projection');assert.equal(good.facts.partnerProfileId,partner.profileId);
  assert.equal(good.facts.ownerTelegramId,202);assert.equal(good.facts.domain.releasedRuleAndRollout,true);
  assert.equal(can(good.actor,'analytics.compare_periods',good.resource).allowed,true);
  const disabled=await run({ANALYTICS_V2_ENABLED:'false'});
  assert.equal(can(disabled.actor,'analytics.compare_periods',disabled.resource).allowed,false);
  await assert.rejects(()=>resolve(f,202,'analytics.compare_periods',{kind:'partner_projection',key:101}),/invalid_resource_reference/);
  f.sqlite.prepare("INSERT INTO analytics_privacy_maintenance_guard(id,reason,subject_pseudonym,token_hash,created_by_kind,created_at,expires_at) VALUES(1,'user_deletion',?,?,'system',?,?)")
    .run('c'.repeat(64),'d'.repeat(64),f.now-1,f.now+300);
  f.sqlite.prepare('INSERT INTO analytics_privacy_projection_fence(id,created_at) VALUES(1,?)').run(f.now);
  assert.equal(fresh(f,good.resource),0);
  const fenced=await run({});
  assert.equal(fenced.facts.domain.releasedRuleAndRollout,false);
  assert.equal(can(fenced.actor,'analytics.compare_periods',fenced.resource).allowed,false);
});

test('first own private draft activation uses its actual selected approved route and consumes no additional slot',async t=>{
  const f=setup(t),partner=await approvedPartner(f,202);
  assert.equal((await f.call(202,'partner/legal-profile',{method:'POST',payload:{profileKind:'individual',selfDeclarationAccepted:true}})).status,200);
  const created=await f.call(202,'offers',{method:'POST',payload:{}});assert.equal(created.status,200);
  const code=created.data.offerCode;
  const patch={buttonText:'Открыть',title:'Проверенный частный оффер',description:'Условия оффера для проверки владельцем',
    provider:'Тест Банк',category:'debit',payoutText:'До 1000 рублей',requiredAction:'Выполнить условия банка',
    minAge:18,maxAge:70,geo:'Россия',holdDays:30,trafficSources:'Telegram',sourceName:'Официальная программа',
    startsAt:'2026-01-01',expiresAt:'2027-09-01',partnerLinkId:partner.linkId};
  const edited=await f.call(202,'offers/'+code+'/version',{method:'POST',payload:{version:1,patch}});
  assert.equal(edited.status,200);
  const expectedVersionId=f.sqlite.prepare('SELECT current_version_id FROM offer_visibility_rules WHERE offer_code=?').get(code).current_version_id;
  const result=await resolve(f,202,'offer.activate_own',{kind:'offer',key:code},{requestPayload:{expectedVersionId}});
  assert.equal(result.facts.status,'draft');assert.equal(result.facts.visibility,'private');
  assert.equal(result.facts.version.hashValid,true);assert.equal(result.facts.version.approvedId,null);
  assert.equal(result.facts.route.approved,true);assert.equal(result.facts.domain.transitionAllowed,true);
  assert.equal(result.facts.usage.own_working_offers,1);assert.equal(result.facts.quotaDelta,0);
  const {can}=await import('../src/v1.4.1/entitlement-engine.mjs');
  assert.equal(can(result.actor,'offer.activate_own',result.resource).allowed,true);
  f.sqlite.prepare("UPDATE partner_links SET status='rejected' WHERE id=?").run(partner.linkId);
  assert.equal(fresh(f,result.resource),0);
  const changed=await resolve(f,202,'offer.activate_own',{kind:'offer',key:code},{requestPayload:{expectedVersionId}});
  assert.equal(can(changed.actor,'offer.activate_own',changed.resource).allowed,false);
});
