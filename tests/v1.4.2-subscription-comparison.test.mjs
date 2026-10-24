import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { createRuntimeAuthorizer, assertRuntimeAuthorizationFresh } from '../src/v1.4.1/runtime-authorizer.mjs';
import { FOUNDATION_POLICY_VERSION, QUOTA_DEFINITIONS } from '../src/v1.4.1/capability-policy.mjs';
import { readSubscriptionCatalog } from '../src/v1.4.2/subscription-catalog.mjs';
import { projectSubscriptionComparison } from '../src/v1.4.2/subscription-comparison.mjs';
import { readOwnSubscriptionQuotas } from '../src/v1.4.2/subscription-quotas.mjs';
import { STARS_TERMS_REVISION } from '../src/v1.3.6/stars-core-foundation.mjs';

const authorizer=createRuntimeAuthorizer();
const keys=['active_applications','own_working_offers','active_campaigns'];
const sqlTime=value=>new Date(value*1000).toISOString().slice(0,19).replace('T',' ');
function fixture(t) {
  const f=foundationFixture(t);
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0026-v1.3.6-stars-core-foundation.sql',import.meta.url),'utf8'));
  f.serverEnv={...f.serverEnv,STARS_PAYMENTS_ENABLED:'true',STARS_BILLING_MODE:'prepaid',STARS_PRICE_VERSION:'1',
    STARS_TERMS_REVISION,STARS_INVOICE_SECRET:'offline-comparison-secret-more-than-32-characters',
    STARS_ROLLOUT_MODE:'allowlist',STARS_ROLLOUT_ALLOWLIST:'101,202'};
  f.authorize=async(id=101,operation='access.read_own')=>authorizer.authorize(await f.context(id,operation));
  return f;
}
async function read(f,id=101) {
  const authorization=await f.authorize(id);
  const catalog=await readSubscriptionCatalog({authorization});
  const quotas=await readOwnSubscriptionQuotas({authorization});
  await assertRuntimeAuthorizationFresh(authorization);
  return {catalog,quotas};
}
function partnerPreview(f,id=202) {
  const app=f.sqlite.prepare("INSERT INTO partner_applications(telegram_id,display_name,contact,age_confirmed,status,reviewed_by,reviewed_at) VALUES(?,'Synthetic','@synthetic',1,'approved',900,?)").run(id,sqlTime(f.now));
  const profile=f.sqlite.prepare("INSERT INTO partner_profiles(telegram_id,application_id,display_name,contact,status,approved_by) VALUES(?,?,'Synthetic','@synthetic','active',900)").run(id,Number(app.lastInsertRowid));
  const profileId=Number(profile.lastInsertRowid);
  f.sqlite.prepare("INSERT INTO user_roles(telegram_id,role,status) VALUES(?,'partner','active')").run(id);
  f.sqlite.prepare("INSERT INTO partner_legal_profiles(partner_profile_id,profile_kind,verification_state,revision,declared_by,declared_at,updated_at) VALUES(?,'individual','self_declared',1,?,?,?)").run(profileId,id,sqlTime(f.now),sqlTime(f.now));
  f.grantBeta(profileId);f.sqlite.exec('UPDATE partner_beta_settings SET max_active_offers_per_partner=3 WHERE id=1');
  const start=f.now-5,end=start+604800,source='dragon_preview:v1.3.5-hotfix.1';
  f.sqlite.prepare("INSERT INTO user_plans(telegram_id,plan_code,source_code,effective_from) VALUES(?,'free',?,?)").run(id,source,sqlTime(start));
  f.sqlite.prepare("INSERT INTO user_access_states(telegram_id,access_state,source_code,state_started_at,state_ends_at) VALUES(?,'trial',?,?,?)").run(id,source,sqlTime(start),sqlTime(end));
  f.sqlite.prepare("INSERT INTO trial_grants(grant_id,telegram_id,subject_fingerprint,program_code,source_code,status,started_at,ends_at,retention_until,workflow_instance_id,workflow_state,granted_at,updated_at) VALUES(?,?,?,'dragon_preview',?,'active',?,?,?,?,'started',?,?)").run(crypto.randomUUID(),id,'a'.repeat(64),source,start,end,end+86400,crypto.randomUUID(),start,start);
  f.sqlite.prepare("UPDATE user_access SET access_tier='trial',trial_used=1,trial_started_at=?,trial_ends_at=? WHERE telegram_id=?").run(sqlTime(start),sqlTime(end),id);
  return profileId;
}

test('actual own server catalog emits the versioned three-object comparison with baseline support and no speculative AI or future capabilities',async t=>{
  const f=fixture(t);f.binding.audit.length=0;
  const before=f.sqlite.prepare('SELECT total_changes() AS n').get().n;
  const {catalog}=await read(f),comparison=catalog.comparison;
  assert.equal(comparison.version,1);assert.equal(comparison.authority,'worker');
  assert.equal(comparison.policyVersion,FOUNDATION_POLICY_VERSION);
  assert.equal(comparison.publishedPolicyOnly,true);assert.equal(comparison.grantsRoles,false);
  assert.deepEqual(comparison.rows.map(row=>row.key),keys);
  for(const row of comparison.rows){
    assert.deepEqual(row.limits,Object.fromEntries(['free','professional','dragon'].map(plan=>[plan,QUOTA_DEFINITIONS[row.key].limits[plan]])));
    assert.equal(comparison.previewLimits[row.key],QUOTA_DEFINITIONS[row.key].limits.preview);
    assert.ok(row.label.length>0);assert.ok(row.additionalRestrictions.includes('actual_action_authorization_required'));
    assert.equal('eligible' in row,false);assert.equal('canCreate' in row,false);
  }
  assert.deepEqual(comparison.baseline,['own_profile','own_history','basic_support','payment_help']);
  assert.deepEqual(comparison.support,{basic:'included',paymentHelp:'included',priority:'not_released',founderLine:'not_released'});
  assert.equal(catalog.support.available,true);assert.equal(catalog.support.paymentCommand,'/paysupport');
  assert.equal(f.sqlite.prepare('SELECT total_changes() AS n').get().n,before);
  assert.ok(f.binding.audit.every(event=>!event.sql||/^SELECT/u.test(event.sql.trim())));
  assert.doesNotMatch(JSON.stringify(comparison),/public_ai|partner_ai|analytics\.compare|CRM|team|sourceFingerprint|telegramId/u);
  assert.ok(Object.isFrozen(comparison.rows[0].limits));
});

test('Preview published object limits do not replace a smaller real Partner Beta capacity or grant the partner role',async t=>{
  const f=fixture(t);partnerPreview(f);
  const {catalog,quotas}=await read(f,202),comparison=catalog.comparison;
  const offer=comparison.rows.find(row=>row.key==='own_working_offers');
  assert.equal(offer.roleRequirement,'active_partner');
  assert.ok(offer.additionalRestrictions.includes('partner_beta_access_required'));
  assert.ok(offer.additionalRestrictions.includes('partner_beta_cap_preserved'));
  const actual=quotas.quotas.find(row=>row.key==='own_working_offers');
  assert.equal(actual.planLimit,comparison.previewLimits.own_working_offers);
  assert.equal(actual.limit,3);assert.ok(actual.limit<offer.limits.dragon);
  const ordinary=await read(f,101),ordinaryOffers=ordinary.quotas.quotas.find(row=>row.key==='own_working_offers');
  assert.ok(ordinaryOffers.restrictions.includes('active_partner_required'));
  assert.equal(ordinary.catalog.comparison.grantsRoles,false);
});

test('unavailable authority preserves published policy reference but never manufactures usable personal capacity or purchase eligibility',async t=>{
  const f=fixture(t),prepare=f.binding.prepare.bind(f.binding);
  f.binding.prepare=sql=>{if(sql.includes('FROM capability_catalog ')||sql.includes('FROM user_plans '))throw new Error('offline missing authority');return prepare(sql);};
  const {catalog,quotas}=await read(f);
  assert.equal(catalog.comparison.publishedPolicyOnly,true);
  assert.equal(catalog.comparison.policyVersion,FOUNDATION_POLICY_VERSION);
  assert.equal(catalog.comparison.rows.length,3);
  assert.ok(quotas.quotas.every(row=>row.limit===null&&row.remaining===null));
  assert.ok(catalog.offers.filter(row=>row.planCode!=='free').every(row=>!row.purchaseEligibility.eligible&&row.purchaseEligibility.reasonCode==='access_review_required'));
});

test('comparison rejects fabricated authority and a different own operation without database reads',async t=>{
  const f=fixture(t),authorization=await f.authorize(),profile=await f.authorize(101,'profile.read_own');
  f.binding.audit.length=0;
  assert.throws(()=>projectSubscriptionComparison(JSON.parse(JSON.stringify(authorization))),/untrusted_runtime_authorization/u);
  assert.throws(()=>projectSubscriptionComparison(profile),/subscription_comparison_scope_mismatch/u);
  assert.equal(f.binding.audit.length,0);
});
