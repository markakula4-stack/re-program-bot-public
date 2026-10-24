import assert from 'node:assert/strict';
import test from 'node:test';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { approvedPartner, publishedOffer } from './helpers/v1.4.0-rebuild-sqlite.mjs';
import { createAuthorityResolver } from '../src/v1.4.1/authority-resolver.mjs';
import { createResourceResolver, readResourceFacts } from '../src/v1.4.1/resource-resolver.mjs';
import { can } from '../src/v1.4.1/entitlement-engine.mjs';
import { createAtomicAdmission, ATOMIC_OPERATIONS, ATOMIC_ADMISSION_RUNTIME_WIRED } from '../src/v1.4.1/atomic-admission.mjs';
import { createD1AmbassadorAttributionStore,createAmbassadorProfileDraft,transitionAmbassadorProfile,
  createAmbassadorCampaignDraft,transitionAmbassadorCampaign } from '../src/v1.3.9/ambassador-attribution.mjs';
import { readAnalyticsV2Config } from '../src/v1.3.9/analytics-foundation.mjs';

const total=(f,table)=>f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const executor=createAtomicAdmission();
async function partner(f,id=202) {
  const p=await approvedPartner(f,id);
  const result=await f.call(id,'partner/legal-profile',{method:'POST',
    payload:{profileKind:'individual',selfDeclarationAccepted:true}});
  assert.equal(result.status,200);
  return p;
}
async function proof(f,{id=202,cap='offer.create_private',ref=null,intent={},key='atomic_default_request_1234'}={}) {
  const context=await f.context(id,cap,'mini_app',{idempotencyKey:key,requestPayload:intent});
  const actor=await createAuthorityResolver().resolveActor(context);
  const resource=await createResourceResolver().resolve(context,actor,ref);
  return {context,actor,resource,decision:can(actor,cap,resource)};
}
const rejectedCode=(promise,code)=>assert.rejects(promise,error=>error?.code===code);
const v141Receipts=f=>f.sqlite.prepare("SELECT COUNT(*) n FROM mini_app_command_receipts WHERE operation IN ('offer.create_private','offer.edit_own','offer.archive_own','application.create','application.resubmit')").get().n;
const uuid=n=>`40000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function campaigns(f) {
  const p=await partner(f),secret='offline-approved-analytics-pseudonym-secret-at-least-32';
  Object.assign(f.serverEnv,{ANALYTICS_V2_ROLLOUT_MODE:'admin_shadow',ANALYTICS_V2_ENABLED:'true',
    ANALYTICS_V2_INGEST_ENABLED:'true',ANALYTICS_V2_PROJECTIONS_ENABLED:'true',AMBASSADOR_V2_ENABLED:'true',
    ANALYTICS_SUBJECT_PSEUDONYM_SECRET:secret});
  f.sqlite.prepare(`INSERT INTO analytics_v2_settings(id,rollout_mode,master_enabled,ingest_enabled,
    projections_enabled,ambassador_enabled,updated_at) VALUES(1,'admin_shadow',1,1,1,1,?)
    ON CONFLICT(id) DO UPDATE SET rollout_mode='admin_shadow',master_enabled=1,ingest_enabled=1,
      projections_enabled=1,ambassador_enabled=1,updated_at=excluded.updated_at`).run(f.now);
  const config=readAnalyticsV2Config(f.serverEnv),store=createD1AmbassadorAttributionStore(f.binding);
  const authority={partnerProfileId:p.profileId,ownerTelegramId:202,partnerProfileStatus:'active',
    partnerRoleStatus:'active',programEligibility:'eligible',moderationStatus:'clear'};
  await createAmbassadorProfileDraft({config,store,ambassadorId:uuid(1),partnerProfileId:p.profileId,
    authority,evidenceIdentity:'actual-approved-profile',createdAt:f.now-100,pseudonymSecret:secret});
  await transitionAmbassadorProfile({config,store,transitionId:uuid(11),ambassadorId:uuid(1),expectedRevision:1,
    fromStatus:'draft',toStatus:'active',reasonCode:'activation_approved',actorKind:'admin',authority,
    evidenceIdentity:'actual-approved-activation',occurredAt:f.now-90,pseudonymSecret:secret});
  for (let n=2;n<=4;n++) {
    await createAmbassadorCampaignDraft({config,store,campaignId:uuid(n),ambassadorId:uuid(1),scopeKind:'program',
      programCode:'bank_program',startsAt:f.now-200+n,endsAt:n===2?f.now-10:f.now+600,
      evidenceIdentity:`actual-campaign-draft-${n}`,createdAt:f.now-80,pseudonymSecret:secret});
    await transitionAmbassadorCampaign({config,store,campaignId:uuid(n),transitionId:uuid(20+n),expectedRevision:1,
      fromStatus:'draft',toStatus:'active',reasonCode:'activation_approved',actorKind:'admin',
      evidenceIdentity:`actual-admin-campaign-approval-${n}`,occurredAt:f.now-70,pseudonymSecret:secret});
    if(n>2) await transitionAmbassadorCampaign({config,store,campaignId:uuid(n),transitionId:uuid(30+n),expectedRevision:2,
      fromStatus:'active',toStatus:'paused',reasonCode:'owner_paused',actorKind:'ambassador',
      evidenceIdentity:`actual-owner-pause-${n}`,occurredAt:f.now-60,pseudonymSecret:secret});
  }
  return p;
}

test('closed registry rejects forged decisions, injected authority and unbound intent',async t=>{
  const f=foundationFixture(t);await partner(f);
  const p=await proof(f);
  assert.equal(p.decision.allowed,true);
  assert.equal(ATOMIC_ADMISSION_RUNTIME_WIRED,false);
  assert.equal(ATOMIC_OPERATIONS.length,21);
  await rejectedCode(executor.admit({decision:{...p.decision}}),'untrusted_decision');
  await rejectedCode(executor.admit({decision:p.decision,intent:{limit:99}}),'invalid_intent');
  await rejectedCode(executor.admit({decision:p.decision,sql:'DELETE FROM users'}),'invalid_admission_input');
  await rejectedCode(executor.admit({decision:p.decision,clientKey:'arbitrary_second_key_123'}),'invalid_admission_input');
  assert.equal(v141Receipts(f),0);assert.equal(total(f,'offers'),1); // Existing catalog route only.
});

test('database Beta cannot reopen an offer creation contour disabled by server configuration',async t=>{
  for (const flag of ['PARTNER_BETA_ENABLED','PARTNER_PRIVATE_OFFERS_ENABLED']) {
    const f=foundationFixture(t);await partner(f);f.serverEnv[flag]='false';
    const p=await proof(f,{key:`disabled_${flag}_request_1234`});
    assert.equal(p.decision.allowed,false);
    await assert.rejects(executor.admit({decision:p.decision}),error=>error.status===403);
    assert.equal(total(f,'offer_owners'),0);assert.equal(v141Receipts(f),0);
    assert.equal(total(f,'entitlement_decision_audit'),0);
  }
});

test('two genuine requests racing for the last working-offer slot commit exactly once',async t=>{
  const f=foundationFixture(t);await partner(f);
  const a=await proof(f,{key:'last_slot_request_a_1234'}),b=await proof(f,{key:'last_slot_request_b_1234'});
  assert.equal(a.decision.quota.used,0);assert.equal(b.decision.quota.used,0);
  const result=await Promise.allSettled([executor.admit({decision:a.decision}),executor.admit({decision:b.decision})]);
  assert.equal(result.filter(row=>row.status==='fulfilled').length,1);
  assert.equal(result.find(row=>row.status==='rejected').reason.code,'state_conflict');
  assert.equal(total(f,'offer_owners'),1);assert.equal(total(f,'offer_versions'),1);
  assert.equal(total(f,'entitlement_decision_audit'),1);assert.equal(v141Receipts(f),1);
  assert.equal(total(f,'mini_app_atomic_guards'),0);
  assert.ok(f.binding.sessions.every(mode=>mode==='first-primary'));
});

test('changed role or canonical usage after preflight aborts receipt and effects together',async t=>{
  for (const changed of ['role','usage']) {
    const f=foundationFixture(t);const p=await partner(f);
    const prepared=await proof(f,{key:`changed_${changed}_request_1234`});
    f.binding.beforeBatch=()=>{
      if (changed==='role') f.sqlite.prepare("UPDATE user_roles SET status='paused' WHERE telegram_id=202 AND role='partner'").run();
      else {
        f.sqlite.exec("INSERT INTO offers(code,button_text,title,status) VALUES('existing_limit','Open','Existing','draft')");
        f.sqlite.prepare("INSERT INTO offer_owners(offer_code,owner_kind,partner_profile_id,created_by,updated_by) VALUES('existing_limit','partner',?,202,202)").run(p.profileId);
      }
    };
    await rejectedCode(executor.admit({decision:prepared.decision}),'state_conflict');
    assert.equal(v141Receipts(f),0);assert.equal(total(f,'entitlement_decision_audit'),0);
    assert.equal(total(f,'offer_versions'),0);assert.equal(total(f,'mini_app_atomic_guards'),0);
  }
});

test('a zero-row mandatory INSERT is a CHECK failure and rolls back earlier canonical effects',async t=>{
  const f=foundationFixture(t);await partner(f);
  const prepared=await proof(f);
  f.sqlite.exec(`CREATE TEMP TRIGGER skip_decision_audit BEFORE INSERT ON entitlement_decision_audit
    BEGIN SELECT RAISE(IGNORE); END`);
  await rejectedCode(executor.admit({decision:prepared.decision}),'state_conflict');
  assert.equal(v141Receipts(f),0);assert.equal(total(f,'offer_owners'),0);
  assert.equal(total(f,'offer_versions'),0);assert.equal(total(f,'entitlement_decision_audit'),0);
  assert.equal(total(f,'mini_app_atomic_guards'),0);
});

test('fresh same-payload receipt replay acknowledges its own version change without another effect',async t=>{
  const f=foundationFixture(t);await partner(f);
  const created=await executor.admit({decision:(await proof(f,{key:'replay_create_request_1234'})).decision});
  const oldVersion=f.sqlite.prepare('SELECT current_version_id AS id FROM offer_visibility_rules WHERE offer_code=?').get(created.offerCode).id;
  const intent={expectedVersionId:oldVersion,patch:{title:'Updated private offer'}};
  const opts={cap:'offer.edit_own',ref:{kind:'offer',key:created.offerCode},intent,key:'replay_edit_request_12345'};
  const edit=await proof(f,opts);assert.equal(edit.decision.allowed,true);
  assert.equal((await executor.admit({decision:edit.decision})).commitStatus,'committed');
  const refreshed=await proof(f,opts);
  assert.notEqual(readResourceFacts(refreshed.resource).version.currentId,oldVersion);
  assert.equal((await executor.admit({decision:refreshed.decision})).commitStatus,'unchanged');
  assert.equal(total(f,'offer_versions'),2);assert.equal(total(f,'entitlement_decision_audit'),2);
  const altered=await proof(f,{...opts,intent:{...intent,patch:{title:'Different payload'}}});
  await rejectedCode(executor.admit({decision:altered.decision}),'idempotency_conflict');
  assert.equal(total(f,'offer_versions'),2);
});

test('actual approved offer can pause, activate privately and submit the new version with one working slot',async t=>{
  const f=foundationFixture(t),p=await partner(f),published=await publishedOffer(f,202,p);
  const ref={kind:'offer',key:published.code};
  const current=()=>f.sqlite.prepare('SELECT current_version_id id,approved_version_id approved,visibility,moderation_status moderation FROM offer_visibility_rules WHERE offer_code=?').get(published.code);
  const initial=current(),before=total(f,'offer_versions');
  const pauseOptions={cap:'offer.pause_own',ref,intent:{expectedVersionId:initial.id},key:'private_pause_request_12345'};
  const pause=await proof(f,pauseOptions);assert.equal(pause.decision.allowed,true);assert.equal(readResourceFacts(pause.resource).quotaDelta,0);
  await executor.admit({decision:pause.decision});
  assert.equal(f.sqlite.prepare('SELECT status FROM offers WHERE code=?').get(published.code).status,'paused');
  const paused=current();assert.notEqual(paused.id,initial.id);assert.equal(paused.visibility,'private');
  assert.notEqual(paused.id,paused.approved);
  const activation=await proof(f,{cap:'offer.activate_own',ref,intent:{expectedVersionId:paused.id},key:'private_activate_request_1234'});
  assert.equal(activation.decision.allowed,true);assert.equal(activation.decision.quota.used,1);assert.equal(readResourceFacts(activation.resource).quotaDelta,0);
  await executor.admit({decision:activation.decision});
  const active=current();assert.equal(active.visibility,'private');assert.equal(active.moderation,'not_submitted');
  assert.equal(f.sqlite.prepare('SELECT status FROM offers WHERE code=?').get(published.code).status,'active');
  const submit=await proof(f,{cap:'offer.submit_moderation',ref,intent:{expectedVersionId:active.id},key:'private_submit_request_1234'});
  assert.equal(submit.decision.allowed,true);assert.equal(readResourceFacts(submit.resource).quotaDelta,0);
  await executor.admit({decision:submit.decision});
  assert.equal(current().visibility,'private');assert.equal(current().moderation,'pending');
  assert.equal(total(f,'offer_versions'),before+2);assert.equal(total(f,'entitlement_decision_audit'),3);
  assert.equal((await executor.admit({decision:(await proof(f,pauseOptions)).decision})).commitStatus,'unchanged');
  assert.equal(total(f,'entitlement_decision_audit'),3);
});

test('receipt replay at full quota skips fresh growth admission but still checks fresh privacy',async t=>{
  const f=foundationFixture(t);await partner(f);
  const opts={key:'quota_replay_request_1234'};
  assert.equal((await executor.admit({decision:(await proof(f,opts)).decision})).commitStatus,'committed');
  const fresh=await proof(f,opts);assert.equal(fresh.decision.allowed,false);
  assert.equal((await executor.admit({decision:fresh.decision})).commitStatus,'unchanged');
  const current=await proof(f,opts);
  f.sqlite.prepare("INSERT INTO privacy_deletion_requests(request_id,telegram_id,confirmation_token,status,summary_json,expires_at) VALUES('delete_request',202,'synthetic_confirm','pending','{}',datetime('now','+5 minutes'))").run();
  await rejectedCode(executor.admit({decision:current.decision}),'replay_scope_conflict');
  assert.equal(total(f,'entitlement_decision_audit'),1);
});

test('intent is bound to the authenticated stable operation before mutation',async t=>{
  const f=foundationFixture(t);await partner(f);
  const created=await executor.admit({decision:(await proof(f)).decision});
  const version=f.sqlite.prepare('SELECT current_version_id id FROM offer_visibility_rules WHERE offer_code=?').get(created.offerCode).id;
  const p=await proof(f,{cap:'offer.edit_own',ref:{kind:'offer',key:created.offerCode},
    intent:{expectedVersionId:version,patch:{title:'Authenticated body'}}});
  await rejectedCode(executor.admit({decision:p.decision,intent:{expectedVersionId:version,patch:{title:'Altered after verification'}}}),'intent_operation_mismatch');
  assert.equal(total(f,'offer_versions'),1);
});

test('fresh restricted account proof cannot acknowledge a previous receipt',async t=>{
  for (const restriction of ['blocked','terms','deletion']) {
    const f=foundationFixture(t);await partner(f);
    const options={key:`fresh_restricted_${restriction}_request`};
    await executor.admit({decision:(await proof(f,options)).decision});
    if (restriction==='blocked') f.sqlite.exec('UPDATE users SET is_blocked=1 WHERE telegram_id=202');
    else if (restriction==='terms') f.sqlite.exec('UPDATE users SET accepted_terms=0 WHERE telegram_id=202');
    else f.sqlite.prepare("INSERT INTO privacy_deletion_requests(request_id,telegram_id,confirmation_token,status,summary_json,expires_at) VALUES('fresh_delete_request',202,'synthetic_confirm','pending','{}',datetime('now','+5 minutes'))").run();
    const current=await proof(f,options);assert.equal(current.decision.allowed,false);
    await rejectedCode(executor.admit({decision:current.decision}),'replay_scope_conflict');
    assert.equal(total(f,'offer_owners'),1);assert.equal(total(f,'entitlement_decision_audit'),1);
  }
});

test('lost commit response reconciles only through the durable receipt and fresh proof',async t=>{
  const f=foundationFixture(t);await partner(f);
  const options={key:'lost_response_request_1234'};
  const prepared=await proof(f,options);
  f.binding.loseCommandResponse=true;
  await rejectedCode(executor.admit({decision:prepared.decision}),'receipt_race');
  assert.equal(total(f,'offer_owners'),1);assert.equal(total(f,'entitlement_decision_audit'),1);
  assert.equal((await executor.admit({decision:(await proof(f,options)).decision})).commitStatus,'unchanged');
  assert.equal(total(f,'offer_versions'),1);
});

test('current ownership and fresh account generation fence previous receipt replay',async t=>{
  const f=foundationFixture(t);await partner(f);
  const created=await executor.admit({decision:(await proof(f,{key:'owner_create_request_1234'})).decision});
  const version=f.sqlite.prepare('SELECT current_version_id id FROM offer_visibility_rules WHERE offer_code=?').get(created.offerCode).id;
  const options={cap:'offer.edit_own',ref:{kind:'offer',key:created.offerCode},
    intent:{expectedVersionId:version,patch:{title:'Owned before reassignment'}},key:'owner_edit_request_1234'};
  await executor.admit({decision:(await proof(f,options)).decision});
  f.sqlite.exec('UPDATE partner_profiles SET telegram_id=303 WHERE telegram_id=202');
  await rejectedCode(executor.admit({decision:(await proof(f,options)).decision}),'proof_scope_mismatch');
  assert.equal(total(f,'offer_versions'),2);
  f.sqlite.exec('UPDATE partner_profiles SET telegram_id=202 WHERE telegram_id=303');
  f.sqlite.exec("UPDATE users SET referral_code='fresh_generation_code' WHERE telegram_id=202");
  // A same-ID replacement cannot recover the previous generation's receipt.
  // Its stale version is admitted as a new operation only after current CAS.
  await rejectedCode(executor.admit({decision:(await proof(f,options)).decision}),'proof_scope_mismatch');
  assert.equal(total(f,'entitlement_decision_audit'),2);
});

test('expired source proof is rejected inside the batch even when no source row changed',async t=>{
  const f=foundationFixture(t);const p=await partner(f);
  f.sqlite.prepare("UPDATE partner_beta_access SET expires_at=datetime(?, 'unixepoch') WHERE partner_profile_id=?").run(f.now+2,p.profileId);
  const prepared=await proof(f);assert.equal(prepared.decision.allowed,true);
  f.binding.beforeBatch=()=>f.sqlite.function('unixepoch',()=>f.now+3);
  await rejectedCode(executor.admit({decision:prepared.decision}),'state_conflict');
  assert.equal(v141Receipts(f),0);assert.equal(total(f,'offer_owners'),0);assert.equal(total(f,'entitlement_decision_audit'),0);
});

test('lead admission counts pending and confirmed; rejected resubmission consumes one slot',async t=>{
  const f=foundationFixture(t);const published=await publishedOffer(f);
  f.sqlite.prepare("INSERT INTO lead_requests(telegram_id,inviter_id,offer_code,status) VALUES(101,202,'other_pending','pending'),(101,202,'other_confirmed','confirmed')").run();
  const opts={id:101,cap:'application.create',ref:{kind:'offer',key:published.code},
    intent:{offerCode:published.code},key:'lead_admission_request_1234'};
  const prepared=await proof(f,opts);assert.equal(prepared.decision.allowed,true);
  assert.equal(prepared.decision.quota.used,2);
  assert.equal((await executor.admit({decision:prepared.decision})).commitStatus,'committed');
  assert.equal(total(f,'lead_request_events'),1);assert.equal(total(f,'mini_app_effect_outbox'),3);
  assert.equal(total(f,'entitlement_decision_audit'),1);
  assert.equal((await executor.admit({decision:(await proof(f,opts)).decision})).commitStatus,'unchanged');
  const lead=f.sqlite.prepare('SELECT id FROM lead_requests WHERE telegram_id=101 AND offer_code=?').get(published.code);
  f.sqlite.prepare("UPDATE lead_requests SET status='rejected',rejection_reason='retry' WHERE id=?").run(lead.id);
  const resubmit=await proof(f,{...opts,cap:'application.resubmit',ref:{kind:'application',key:lead.id},key:'resubmit_admission_request_1234'});
  assert.equal(resubmit.decision.quota.used,2);assert.equal(resubmit.decision.allowed,true);
  await executor.admit({decision:resubmit.decision});
  assert.equal(f.sqlite.prepare('SELECT status FROM lead_requests WHERE id=?').get(lead.id).status,'pending');
  assert.equal(total(f,'lead_request_events'),2);assert.equal(total(f,'mini_app_effect_outbox'),6);
});

test('two genuine lead submissions race for the fifth slot using pending and confirmed canonical rows',async t=>{
  const f=foundationFixture(t);
  const left=await publishedOffer(f,202),right=await publishedOffer(f,303);
  for (const [index,status] of ['pending','confirmed','pending','confirmed'].entries()) {
    f.sqlite.prepare('INSERT INTO lead_requests(telegram_id,inviter_id,offer_code,status) VALUES(101,202,?,?)').run(`canonical_existing_${index}`,status);
  }
  const a=await proof(f,{id:101,cap:'application.create',ref:{kind:'offer',key:left.code},
    intent:{offerCode:left.code},key:'lead_race_left_request_1234'});
  const b=await proof(f,{id:101,cap:'application.create',ref:{kind:'offer',key:right.code},
    intent:{offerCode:right.code},key:'lead_race_right_request_1234'});
  assert.equal(a.decision.allowed,true);assert.equal(b.decision.allowed,true);
  assert.equal(a.decision.quota.used,4);assert.equal(a.decision.quota.limit,5);
  const results=await Promise.allSettled([executor.admit({decision:a.decision}),executor.admit({decision:b.decision})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1,JSON.stringify(results.map(result=>result.reason?.code ?? result.value)));
  assert.equal(results.find(result=>result.status==='rejected').reason.code,'state_conflict');
  assert.equal(total(f,'lead_requests'),5);assert.equal(total(f,'lead_partner_attribution'),1);
  assert.equal(total(f,'lead_request_events'),1);assert.equal(total(f,'entitlement_decision_audit'),1);
  assert.equal(total(f,'mini_app_effect_outbox'),3);assert.equal(total(f,'mini_app_atomic_guards'),0);
});

test('own application receipt remains acknowledgeable after current publication eligibility closes',async t=>{
  const f=foundationFixture(t);const published=await publishedOffer(f);
  const options={id:101,cap:'application.create',ref:{kind:'offer',key:published.code},
    intent:{offerCode:published.code},key:'publication_closed_replay_1234'};
  await executor.admit({decision:(await proof(f,options)).decision});
  f.sqlite.prepare("UPDATE offers SET status='paused' WHERE code=?").run(published.code);
  const current=await proof(f,options);assert.equal(current.decision.allowed,false);
  assert.equal((await executor.admit({decision:current.decision})).commitStatus,'unchanged');
  assert.equal(total(f,'lead_requests'),1);assert.equal(total(f,'lead_request_events'),1);
  assert.equal(total(f,'mini_app_effect_outbox'),3);assert.equal(total(f,'entitlement_decision_audit'),1);
});

test('campaign last-slot resumes use actual approval ledgers and count overdue active rows',async t=>{
  const f=foundationFixture(t);await campaigns(f);
  const before=total(f,'ambassador_campaign_transitions');
  const a=await proof(f,{cap:'campaign.resume',ref:{kind:'campaign',key:uuid(3)},key:'campaign_resume_left_1234'});
  const b=await proof(f,{cap:'campaign.resume',ref:{kind:'campaign',key:uuid(4)},key:'campaign_resume_right_1234'});
  assert.equal(a.decision.allowed,true);assert.equal(b.decision.allowed,true);
  assert.equal(a.decision.quota.used,1);assert.equal(a.decision.quota.limit,2);
  const results=await Promise.allSettled([executor.admit({decision:a.decision}),executor.admit({decision:b.decision})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1,JSON.stringify(results.map(result=>result.reason?.code ?? result.value)));
  assert.equal(results.find(result=>result.status==='rejected').reason.code,'state_conflict');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ambassador_campaigns WHERE status='active'").get().n,2);
  assert.equal(total(f,'ambassador_campaign_transitions'),before+1);
  assert.equal(total(f,'entitlement_decision_audit'),1);assert.equal(total(f,'mini_app_atomic_guards'),0);
  const winner=results[0].status==='fulfilled'?uuid(3):uuid(4);
  const pause=await proof(f,{cap:'campaign.pause',ref:{kind:'campaign',key:winner},key:'campaign_pause_request_1234'});
  assert.equal(pause.decision.allowed,true);await executor.admit({decision:pause.decision});
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ambassador_campaigns WHERE status='active'").get().n,1);
  assert.equal(total(f,'ambassador_campaign_transitions'),before+2);
});

test('pending to confirmed preserves one application slot and the compatibility mirror is not a second resource',async t=>{
  const f=foundationFixture(t);const published=await publishedOffer(f);
  await executor.admit({decision:(await proof(f,{id:101,cap:'application.create',ref:{kind:'offer',key:published.code},
    intent:{offerCode:published.code},key:'confirm_create_request_1234'})).decision});
  const lead=f.sqlite.prepare('SELECT id FROM lead_requests WHERE telegram_id=101').get();
  const review=await proof(f,{id:900,cap:'admin.application.result',ref:{kind:'application',key:lead.id},
    intent:{leadId:lead.id,decision:'confirm',rewardKopecks:100},key:'confirm_result_request_1234'});
  assert.equal(review.decision.allowed,true);await executor.admit({decision:review.decision});
  assert.equal(f.sqlite.prepare('SELECT status FROM lead_requests WHERE id=?').get(lead.id).status,'confirmed');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM lead_requests WHERE telegram_id=101 AND status IN ('pending','confirmed')").get().n,1);
  assert.equal(total(f,'conversions'),1);assert.equal(total(f,'lead_request_events'),2);
  const targetAudit=f.sqlite.prepare("SELECT subject_telegram_id subject,actor_telegram_id actor FROM entitlement_decision_audit WHERE capability='admin.application.result'").get();
  assert.deepEqual({...targetAudit},{subject:101,actor:900});
  Object.assign(f.serverEnv,{ADMIN_ID:'101',OWNER_TELEGRAM_ID:'101'});
  const revokedOwner=await proof(f,{id:900,cap:'admin.application.result',ref:{kind:'application',key:lead.id},
    intent:{leadId:lead.id,decision:'confirm',rewardKopecks:100},key:'confirm_result_request_1234'});
  assert.equal(revokedOwner.decision.allowed,false);
  await rejectedCode(executor.admit({decision:revokedOwner.decision}),'replay_scope_conflict');
  assert.equal(total(f,'lead_request_events'),2);assert.equal(total(f,'entitlement_decision_audit'),2);
  Object.assign(f.serverEnv,{ADMIN_ID:'900',OWNER_TELEGRAM_ID:'900'});
  const paid=await proof(f,{id:900,cap:'admin.application.result',ref:{kind:'application',key:lead.id},
    intent:{leadId:lead.id,decision:'mark_paid'},key:'mark_paid_result_request_1234'});
  assert.equal(paid.decision.allowed,true);await executor.admit({decision:paid.decision});
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM lead_requests WHERE telegram_id=101 AND status IN ('pending','confirmed')").get().n,0);
  assert.equal(f.sqlite.prepare('SELECT status FROM conversions WHERE telegram_id=101').get().status,'paid');
});

test('mandatory lead history, audit or outbox failure rolls back domain, quota effect and receipt',async t=>{
  for (const table of ['lead_request_events','entitlement_decision_audit','mini_app_effect_outbox']) {
    const f=foundationFixture(t);const published=await publishedOffer(f);
    const prepared=await proof(f,{id:101,cap:'application.create',ref:{kind:'offer',key:published.code},
      intent:{offerCode:published.code},key:`mandatory_${table}_request_1234`});
    assert.equal(prepared.decision.allowed,true);
    const before=total(f,'mini_app_command_receipts');
    f.binding.failStatement=sql=>sql.startsWith(`INSERT INTO ${table}`);
    await rejectedCode(executor.admit({decision:prepared.decision}),'admission_outcome_unknown');
    assert.equal(total(f,'lead_requests'),0);assert.equal(total(f,'lead_partner_attribution'),0);
    assert.equal(total(f,'lead_request_events'),0);assert.equal(total(f,'entitlement_decision_audit'),0);
    assert.equal(total(f,'mini_app_effect_outbox'),0);assert.equal(total(f,'mini_app_command_receipts'),before);
    assert.equal(total(f,'mini_app_atomic_guards'),0);
  }
});

test('zero-row canonical lead CAS aborts the entire reservation and mandatory ledger batch',async t=>{
  const f=foundationFixture(t);const published=await publishedOffer(f);
  f.sqlite.prepare("INSERT INTO lead_requests(telegram_id,inviter_id,offer_code,status,rejection_reason) VALUES(101,202,?,'rejected','retry')").run(published.code);
  const lead=f.sqlite.prepare('SELECT id FROM lead_requests WHERE telegram_id=101').get();
  const prepared=await proof(f,{id:101,cap:'application.resubmit',ref:{kind:'application',key:lead.id},
    intent:{offerCode:published.code},key:'zero_cas_request_1234567'});
  let intercepted=false;
  f.binding.failStatement=sql=>{
    if (!intercepted && sql.startsWith('UPDATE lead_requests')) {
      intercepted=true;
      // A simulated intervening canonical change after admission predicates,
      // inside the test transaction. Execute the actual source CAS unchanged.
      f.sqlite.prepare("UPDATE lead_requests SET status='paid' WHERE id=?").run(lead.id);
    }
    return false;
  };
  await rejectedCode(executor.admit({decision:prepared.decision}),'state_conflict');
  assert.equal(intercepted,true);
  assert.equal(f.sqlite.prepare('SELECT status FROM lead_requests WHERE id=?').get(lead.id).status,'rejected');
  assert.equal(total(f,'lead_request_events'),0);assert.equal(total(f,'lead_partner_attribution'),0);
  assert.equal(total(f,'entitlement_decision_audit'),0);assert.equal(total(f,'mini_app_effect_outbox'),0);
});

test('over-cap archive is a fixed terminal reduction and rejects content patches',async t=>{
  const f=foundationFixture(t);const p=await partner(f);
  const one=await f.call(202,'offers',{method:'POST',payload:{}}),two=await f.call(202,'offers',{method:'POST',payload:{}});
  assert.equal(one.status,200);assert.equal(two.status,200);
  const version=f.sqlite.prepare('SELECT current_version_id id FROM offer_visibility_rules WHERE offer_code=?').get(one.data.offerCode).id;
  f.sqlite.prepare("UPDATE partner_beta_access SET access_status='revoked' WHERE partner_profile_id=?").run(p.profileId);
  f.serverEnv.PARTNER_BETA_ENABLED='false';f.serverEnv.PARTNER_PRIVATE_OFFERS_ENABLED='false';
  const options={cap:'offer.archive_own',ref:{kind:'offer',key:one.data.offerCode},intent:{expectedVersionId:version},key:'archive_overcap_request_1234'};
  const archive=await proof(f,options);assert.equal(archive.decision.allowed,true);
  assert.equal(archive.decision.quota.used,2);assert.equal(archive.decision.quota.limit,1);
  await rejectedCode(executor.admit({decision:archive.decision,intent:{expectedVersionId:version,patch:{title:'Injected edit'}}}),'invalid_intent');
  await executor.admit({decision:archive.decision});
  assert.equal(f.sqlite.prepare('SELECT status FROM offers WHERE code=?').get(one.data.offerCode).status,'archived');
  const remaining=f.sqlite.prepare("SELECT COUNT(*) n FROM offers o JOIN offer_owners own ON own.offer_code=o.code WHERE own.partner_profile_id=? AND o.status IN ('draft','active','paused')").get(p.profileId).n;
  assert.equal(remaining,1);
  const last=f.sqlite.prepare('SELECT current_version_id id FROM offer_visibility_rules WHERE offer_code=?').get(one.data.offerCode).id;
  const revive=await proof(f,{cap:'offer.activate_own',ref:options.ref,intent:{expectedVersionId:last},key:'archived_revive_request_1234'});
  await assert.rejects(executor.admit({decision:revive.decision}));
  assert.equal(f.sqlite.prepare('SELECT status FROM offers WHERE code=?').get(one.data.offerCode).status,'archived');
});

test('closed partner application, legal declaration and username effects share receipt and audit admission',async t=>{
  const f=foundationFixture(t);
  const application={id:101,cap:'partner.apply',intent:{displayName:'Synthetic applicant',contact:'@synthetic',ageConfirmed:true},key:'p04_atomic_application_1234'};
  const ack=await executor.admit({decision:(await proof(f,application)).decision});
  assert.equal(ack.commitStatus,'committed');
  assert.equal(f.sqlite.prepare('SELECT status FROM partner_applications WHERE telegram_id=101').get().status,'pending');
  assert.equal((await executor.admit({decision:(await proof(f,application)).decision})).commitStatus,'unchanged');
  assert.equal(total(f,'partner_application_decisions'),1);
  await partner(f);
  f.sqlite.exec("UPDATE partner_profiles SET telegram_username='valid_partner' WHERE telegram_id=202");
  for(const item of [
    {cap:'partner.legal_declare_own',intent:{profileKind:'self_employed',selfDeclarationAccepted:true},key:'p04_atomic_legal_1234'},
    {cap:'partner.public_username.update_own',intent:{enabled:true},key:'p04_atomic_username_1234'},
  ]) {
    const result=await executor.admit({decision:(await proof(f,item)).decision});
    assert.equal(result.commitStatus,'committed');
    assert.equal((await executor.admit({decision:(await proof(f,item)).decision})).commitStatus,'unchanged');
  }
  assert.equal(f.sqlite.prepare('SELECT profile_kind FROM partner_legal_profiles').get().profile_kind,'self_employed');
  assert.equal(f.sqlite.prepare('SELECT public_username_enabled FROM partner_public_settings WHERE telegram_id=202').get().public_username_enabled,1);
  assert.equal(total(f,'entitlement_decision_audit'),3);
});

test('closed admin partner review and repair retain target scope in atomic mandatory history',async t=>{
  const f=foundationFixture(t);
  await executor.admit({decision:(await proof(f,{id:303,cap:'partner.apply',intent:{displayName:'Synthetic target',contact:'',ageConfirmed:true},key:'p04_target_application_1234'})).decision});
  const ref={kind:'partner_application',key:f.sqlite.prepare('SELECT id FROM partner_applications WHERE telegram_id=303').get().id};
  const options={id:900,cap:'admin.partner.review',ref,intent:{decision:'approve'},key:'p04_admin_review_1234'};
  await executor.admit({decision:(await proof(f,options)).decision});
  assert.equal(f.sqlite.prepare('SELECT status FROM partner_applications WHERE telegram_id=303').get().status,'approved');
  assert.equal(f.sqlite.prepare("SELECT subject_telegram_id FROM entitlement_decision_audit WHERE capability='admin.partner.review'").get().subject_telegram_id,303);
  assert.equal((await executor.admit({decision:(await proof(f,options)).decision})).commitStatus,'unchanged');
  f.sqlite.exec('DELETE FROM partner_profiles WHERE telegram_id=303');
  await executor.admit({decision:(await proof(f,{id:900,cap:'admin.partner.repair',ref,intent:{},key:'p04_admin_repair_1234'})).decision});
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM partner_profiles WHERE telegram_id=303').get().n,1);
  f.serverEnv.ADMIN_ID='101';f.serverEnv.OWNER_TELEGRAM_ID='101';
  await assert.rejects(executor.admit({decision:(await proof(f,options)).decision}),/admin_target_required/u);
});

test('closed admin moderation, assignment and visibility commit sanitized immutable history with private counterpart',async t=>{
  const f=foundationFixture(t),p=await publishedOffer(f),ref={kind:'offer',key:p.code};
  f.sqlite.prepare("UPDATE offer_visibility_rules SET moderation_status='pending',visibility='private',approved_version_id=NULL WHERE offer_code=?").run(p.code);
  for(const item of [
    {cap:'admin.offer.moderate',intent:{version:3,decision:'approved'},key:'p04_admin_moderation_1234'},
    {cap:'admin.offer.assign',intent:{targetTelegramId:101,action:'assign'},key:'p04_admin_assignment_1234'},
    {cap:'admin.offer.visibility',intent:{version:3,visibility:'assigned'},key:'p04_admin_visibility_1234'},
  ]) {
    await executor.admit({decision:(await proof(f,{id:900,ref,...item})).decision});
    assert.equal((await executor.admit({decision:(await proof(f,{id:900,ref,...item})).decision})).commitStatus,'unchanged');
  }
  assert.equal(f.sqlite.prepare('SELECT visibility FROM offer_visibility_rules WHERE offer_code=?').get(p.code).visibility,'assigned');
  const history=f.sqlite.prepare('SELECT telegram_id,actor_id,reason FROM offer_visibility_assignment_events').all();
  assert.ok(history.every(row=>row.telegram_id===0&&row.actor_id===0&&row.reason===''));
  assert.equal(f.sqlite.prepare('SELECT telegram_id FROM offer_assignment_event_private').get().telegram_id,101);
  assert.equal(total(f,'entitlement_decision_audit'),3);
  // The actor's receipt key is stable, but a replacement target generation
  // cannot acknowledge the old assignment operation as a current permission.
  f.sqlite.exec("UPDATE users SET referral_code='replacement_account_101' WHERE telegram_id=101");
  await rejectedCode(executor.admit({decision:(await proof(f,{id:900,ref,cap:'admin.offer.assign',intent:{targetTelegramId:101,action:'assign'},key:'p04_admin_assignment_1234'})).decision}),'idempotency_conflict');
});

test('new adapter mandatory application history failure rolls back canonical effect, receipt and audit',async t=>{
  const f=foundationFixture(t),p=await proof(f,{id:101,cap:'partner.apply',intent:{displayName:'Synthetic applicant',contact:'',ageConfirmed:true},key:'p04_application_rollback_1234'});
  f.sqlite.exec(`CREATE TEMP TRIGGER fail_application_history BEFORE INSERT ON partner_application_decisions BEGIN SELECT RAISE(IGNORE); END`);
  await rejectedCode(executor.admit({decision:p.decision}),'state_conflict');
  assert.equal(total(f,'partner_applications'),0);assert.equal(total(f,'partner_application_decisions'),0);
  assert.equal(total(f,'mini_app_command_receipts'),0);assert.equal(total(f,'entitlement_decision_audit'),0);
});
