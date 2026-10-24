import test from 'node:test';
import assert from 'node:assert/strict';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { createRuntimeAuthorizer, runtimeAuthorizationDTO } from '../src/v1.4.1/runtime-authorizer.mjs';
import { RESOURCE_QUOTA_PREDICATES } from '../src/v1.4.1/resource-resolver.mjs';
import { accountGenerationFingerprint } from '../src/v1.4.1/authority-resolver.mjs';
import { FOUNDATION_POLICY_VERSION } from '../src/v1.4.1/capability-policy.mjs';
import { readOwnSubscriptionQuotas } from '../src/v1.4.2/subscription-quotas.mjs';

const authorizer = createRuntimeAuthorizer();
const sqlTime = value => new Date(value * 1000).toISOString().slice(0, 19).replace('T', ' ');
const authorize = async (f, id = 101, operation = 'access.read_own') =>
  authorizer.authorize(await f.context(id, operation));
const project = async (f, id = 101) => readOwnSubscriptionQuotas({ authorization: await authorize(f, id) });
const quota = (dto, key) => dto.quotas.find(row => row.key === key);

function partner(f, id = 202) {
  const application = f.sqlite.prepare(`INSERT INTO partner_applications(telegram_id,display_name,contact,
    age_confirmed,status,reviewed_by,reviewed_at) VALUES(?,'Synthetic','@synthetic',1,'approved',900,?)`)
    .run(id, sqlTime(f.now));
  const profile = f.sqlite.prepare(`INSERT INTO partner_profiles(telegram_id,application_id,display_name,
    contact,status,approved_by) VALUES(?,?,'Synthetic','@synthetic','active',900)`)
    .run(id, Number(application.lastInsertRowid));
  const profileId = Number(profile.lastInsertRowid);
  f.sqlite.prepare("INSERT INTO user_roles(telegram_id,role,status) VALUES(?,'partner','active')").run(id);
  f.sqlite.prepare(`INSERT INTO partner_legal_profiles(partner_profile_id,profile_kind,verification_state,
    revision,declared_by,declared_at,updated_at) VALUES(?,'individual','self_declared',1,?,?,?)`)
    .run(profileId, id, sqlTime(f.now), sqlTime(f.now));
  f.grantBeta(profileId);
  return profileId;
}
function offers(f, profileId, statuses) {
  statuses.forEach((status, index) => {
    const code = `quota_offer_${profileId}_${index}`;
    f.sqlite.prepare("INSERT INTO offers(code,button_text,title,status) VALUES(?,'Open','Synthetic',?)").run(code, status);
    f.sqlite.prepare("INSERT INTO offer_owners(offer_code,owner_kind,partner_profile_id) VALUES(?,'partner',?)").run(code, profileId);
  });
}
function applications(f, id, statuses) {
  statuses.forEach((status, index) => f.sqlite.prepare('INSERT INTO lead_requests(telegram_id,offer_code,status) VALUES(?,?,?)')
    .run(id, `quota_lead_${id}_${index}`, status));
}
function campaigns(f, profileId, statuses) {
  f.sqlite.exec("INSERT OR IGNORE INTO partner_programs(code,name,allowed_domains,status) VALUES('quota_program','Synthetic','bank.example','active')");
  const ambassadorId = crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO ambassador_profiles_v2(ambassador_id,partner_profile_id,owner_pseudonym,
    pseudonym_key_version,status,eligibility_evidence_hash,created_at,updated_at)
    VALUES(?,?,?,1,'draft',?,?,?)`).run(ambassadorId, profileId, 'a'.repeat(64), 'b'.repeat(64), f.now - 2000, f.now - 2000);
  f.sqlite.prepare(`INSERT INTO ambassador_profile_transitions(transition_id,transition_key,ambassador_id,
    profile_revision,from_status,to_status,reason_code,actor_kind,evidence_hash,occurred_at,created_at)
    VALUES(?,?,?,2,'draft','active','activation_approved','admin',?,?,?)`)
    .run(crypto.randomUUID(), crypto.randomUUID().replaceAll('-', '').repeat(2), ambassadorId,
      'b'.repeat(64), f.now - 2000, f.now - 2000);
  statuses.forEach((status, index) => {
    // Active rows whose dates already ended still occupy the central quota.
    const start = f.now - 1000 + index;
    const campaignId = crypto.randomUUID();
    f.sqlite.prepare(`INSERT INTO ambassador_campaigns(campaign_id,ambassador_id,scope_kind,program_code,
      scope_evidence_hash,starts_at,ends_at,created_at,updated_at)
      VALUES(?,?,'program','quota_program',?,?,?,?,?)`)
      .run(campaignId, ambassadorId, 'c'.repeat(64), start, start + 10, start, start);
    const transition = (revision, from, to, reason, actor, at) => f.sqlite.prepare(`INSERT INTO ambassador_campaign_transitions(
      transition_id,transition_key,campaign_id,campaign_revision,from_status,to_status,reason_code,actor_kind,
      evidence_hash,occurred_at,created_at) VALUES(?,?,?,?,?,?,?,? ,?,?,?)`)
      .run(crypto.randomUUID(), crypto.randomUUID().replaceAll('-', '').repeat(2), campaignId,
        revision, from, to, reason, actor, 'c'.repeat(64), at, at);
    if (['active', 'paused'].includes(status)) transition(2, 'draft', 'active', 'activation_approved', 'admin', start + 1);
    if (status === 'paused') transition(3, 'active', 'paused', 'owner_paused', 'ambassador', start + 2);
    if (status === 'archived') transition(2, 'draft', 'archived', 'admin_archived', 'admin', start + 1);
  });
}
function preview(f, id) {
  const start = f.now - 5, end = start + 604800, source = 'dragon_preview:v1.3.5-hotfix.1';
  f.sqlite.prepare("INSERT INTO user_plans(telegram_id,plan_code,source_code,effective_from) VALUES(?,'free',?,?)")
    .run(id, source, sqlTime(start));
  f.sqlite.prepare(`INSERT INTO user_access_states(telegram_id,access_state,source_code,state_started_at,state_ends_at)
    VALUES(?,'trial',?,?,?)`).run(id, source, sqlTime(start), sqlTime(end));
  f.sqlite.prepare(`INSERT INTO trial_grants(grant_id,telegram_id,subject_fingerprint,program_code,source_code,
    status,started_at,ends_at,retention_until,workflow_instance_id,workflow_state,granted_at,updated_at)
    VALUES(?,?,?,'dragon_preview',?,'active',?,?,?,?,'started',?,?)`)
    .run(crypto.randomUUID(), id, 'd'.repeat(64), source, start, end, end + 86400, crypto.randomUUID(), start, start);
  f.sqlite.prepare("UPDATE user_access SET access_tier='trial',trial_used=1,trial_started_at=?,trial_ends_at=? WHERE telegram_id=?")
    .run(sqlTime(start), sqlTime(end), id);
}
async function numericOverride(f, id, capability, limitValue) {
  const user = f.sqlite.prepare('SELECT * FROM users WHERE telegram_id=?').get(id);
  const fingerprint = await accountGenerationFingerprint(user);
  f.sqlite.prepare(`INSERT INTO entitlement_overrides(override_id,idempotency_key,policy_version,capability,
    subject_telegram_id,subject_source_fingerprint,scope_kind,scope_key,effect,limit_value,issued_by,reason,
    starts_at,expires_at,revision,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'actor',?,'allow',?,900,'Synthetic quota adjustment',?,?,1,?,?)`)
    .run(crypto.randomUUID(), 'e'.repeat(64), FOUNDATION_POLICY_VERSION, capability, id, fingerprint,
      `actor:${id}`, limitValue, f.now - 1, f.now + 120, f.now - 1, f.now - 1);
}

test('own counters use exact central predicates and exclude foreign owners, other statuses and mirrors', async t => {
  const f = foundationFixture(t), own = partner(f, 202), other = partner(f, 303);
  applications(f, 202, ['pending', 'confirmed', 'rejected', 'paid']);
  applications(f, 303, Array(6).fill('pending'));
  f.sqlite.prepare("INSERT INTO conversions(telegram_id,offer_code,status) VALUES(202,'mirror_only','pending')").run();
  offers(f, own, ['draft', 'active', 'paused', 'archived']); offers(f, other, Array(6).fill('active'));
  campaigns(f, own, ['active', 'draft', 'paused', 'archived']); campaigns(f, other, Array(4).fill('active'));
  const authorization = await authorize(f, 202);
  f.binding.audit.length = 0;
  const dto = await readOwnSubscriptionQuotas({ authorization, telegramId: 303, profileId: other });
  assert.deepEqual(dto.quotas.map(row => row.used), [2, 3, 1]);
  assert.deepEqual(dto.quotas.map(row => row.limit), [5, 1, 2]);
  assert.deepEqual(dto.quotas.map(row => row.remaining), [3, 0, 1]);
  assert.deepEqual(f.binding.audit.map(row => row.sql), Object.values(RESOURCE_QUOTA_PREDICATES));
  assert.deepEqual(f.binding.audit.map(row => row.params), [[202], [own], [own]]);
  assert.ok(f.binding.audit.every(row => row.mode === 'read'));
  assert.equal(dto.actionAdmissionRequired, true);
  assert.ok(dto.quotas.every(row => row.actionAdmissionRequired === true && !Object.hasOwn(row, 'canCreate')));
  assert.ok(Object.isFrozen(dto.quotas[0]));
});

test('over-cap and inactive profile usage remains visible without modifying existing rows', async t => {
  const f = foundationFixture(t), profileId = partner(f);
  applications(f, 202, Array(7).fill('pending'));
  offers(f, profileId, ['draft', 'paused', 'active']); campaigns(f, profileId, Array(3).fill('active'));
  f.sqlite.prepare("UPDATE partner_profiles SET status='paused' WHERE id=?").run(profileId);
  const dto = await project(f, 202);
  assert.deepEqual(dto.quotas.map(row => row.used), [7, 3, 3]);
  assert.deepEqual(dto.quotas.map(row => row.remaining), [0, 0, 0]);
  assert.ok(dto.quotas.every(row => row.restrictions.includes('quota_exceeded')));
  assert.ok(quota(dto, 'own_working_offers').restrictions.includes('active_partner_required'));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM offers WHERE status IN ('draft','active','paused')").get().n, 3);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ambassador_campaigns WHERE status='active'").get().n, 3);
});

test('verified Preview overlays quota capacity and retains the separate Beta cap, not a fourth plan', async t => {
  const f = foundationFixture(t); partner(f); preview(f, 202);
  const dto = await project(f, 202);
  assert.deepEqual(dto.quotas.map(row => row.planLimit), [50, 10, 20]);
  assert.deepEqual(dto.quotas.map(row => row.limit), [50, 3, 20]);
  assert.equal(quota(dto, 'own_working_offers').betaLimit, 3);
  assert.equal(JSON.stringify(dto).includes('planCode'), false);
  const create = await authorize(f, 202, 'offer.create_private');
  assert.equal(runtimeAuthorizationDTO(create).quota.limit, quota(dto, 'own_working_offers').limit);
  assert.equal(runtimeAuthorizationDTO(create).allowed, true);
});

test('role, admin, legal and strict Beta expiry are separate restrictions, never admission from remaining', async t => {
  const f = foundationFixture(t);
  const user = await project(f, 101);
  assert.ok(quota(user, 'own_working_offers').restrictions.includes('role_required'));
  partner(f, 900);
  assert.ok(quota(await project(f, 900), 'own_working_offers').restrictions.includes('role_required'));
  const profileId = partner(f, 202);
  f.sqlite.prepare('DELETE FROM partner_legal_profiles WHERE partner_profile_id=?').run(profileId);
  f.sqlite.prepare('UPDATE partner_beta_access SET expires_at=? WHERE partner_profile_id=?').run(sqlTime(f.now), profileId);
  const expired = quota(await project(f, 202), 'own_working_offers');
  assert.equal(expired.remaining, 1);
  assert.ok(expired.restrictions.includes('legal_declaration_required'));
  assert.ok(expired.restrictions.includes('partner_beta_access_required'));
  f.serverEnv.PARTNER_BETA_ENABLED = 'false';
  assert.ok(quota(await project(f, 202), 'own_working_offers').restrictions.includes('partner_beta_disabled'));
  f.serverEnv.PARTNER_BETA_ENABLED = 'true';
  f.sqlite.prepare("UPDATE partner_beta_access SET expires_at='not-a-date' WHERE partner_profile_id=?").run(profileId);
  assert.ok(quota(await project(f, 202), 'own_working_offers').restrictions.includes('partner_beta_access_required'));
});

test('allowed own read with an unresolved access source returns counts and unknown limits', async t => {
  const f = foundationFixture(t);
  applications(f, 101, ['pending']);
  f.sqlite.exec("UPDATE user_access SET access_tier='team' WHERE telegram_id=101");
  const authorization = await authorize(f);
  assert.equal(runtimeAuthorizationDTO(authorization).allowed, true);
  const dto = await readOwnSubscriptionQuotas({ authorization });
  assert.equal(dto.quotas[0].used, 1);
  assert.ok(dto.quotas.every(row => row.status === 'unavailable' && row.limit === null && row.remaining === null &&
    row.planLimit === null && row.reasonCode === 'authority_review_required'));
});

test('verified manual numeric action limits are not projected as plan entitlements', async t => {
  const f = foundationFixture(t); partner(f);
  await numericOverride(f, 202, 'offer.create_private', 0);
  const dto = quota(await project(f, 202), 'own_working_offers');
  assert.equal(dto.planLimit, 1);
  assert.equal(dto.used, 0);
  assert.equal(dto.limit, null);
  assert.equal(dto.remaining, null);
  assert.equal(dto.reasonCode, 'action_specific_limit');
  assert.equal(runtimeAuthorizationDTO(await authorize(f, 202, 'offer.create_private')).quota.limit, 0);
});

test('resubmission and campaign resume overrides also make aggregate admission capacity action-specific', async t => {
  for (const [capability, key] of [['application.resubmit', 'active_applications'], ['campaign.resume', 'active_campaigns']]) {
    const f = foundationFixture(t); partner(f);
    await numericOverride(f, 202, capability, 0);
    const dto = await project(f, 202), adjusted = quota(dto, key);
    assert.equal(adjusted.used, 0);
    assert.equal(adjusted.limit, null);
    assert.equal(adjusted.remaining, null);
    assert.equal(adjusted.reasonCode, 'action_specific_limit');
    assert.ok(dto.quotas.filter(row => row.key !== key).every(row => row.status === 'available'));
  }
});

test('counter or authority degradation returns unknown values instead of fabricated empty usage', async t => {
  const f = foundationFixture(t), authorization = await authorize(f);
  f.binding.failStatement = sql => sql === RESOURCE_QUOTA_PREDICATES.active_applications;
  const failed = await readOwnSubscriptionQuotas({ authorization });
  assert.ok(failed.quotas.every(row => row.used === null && row.remaining === null && row.status === 'unavailable' &&
    row.reasonCode === 'quota_counter_unavailable'));
  const g = foundationFixture(t);
  g.sqlite.exec('DROP TABLE partner_profiles');
  const missingScope = await project(g);
  assert.equal(quota(missingScope, 'active_applications').used, 0);
  assert.equal(quota(missingScope, 'own_working_offers').used, null);
  assert.equal(quota(missingScope, 'active_campaigns').reasonCode, 'quota_scope_unavailable');
  const h = foundationFixture(t);
  h.sqlite.exec('DROP TABLE entitlement_overrides');
  const missingPolicy = await project(h);
  assert.equal(missingPolicy.quotas[0].planLimit, 5);
  assert.equal(missingPolicy.quotas[0].limit, null);
  assert.equal(missingPolicy.quotas[0].reasonCode, 'authority_review_required');
});

test('only a genuine allowed own access runtime authorization may request counters', async t => {
  const f = foundationFixture(t), genuine = await authorize(f);
  await assert.rejects(readOwnSubscriptionQuotas({ authorization: { ...genuine } }), /untrusted_runtime_authorization/u);
  await assert.rejects(readOwnSubscriptionQuotas({ authorization: await authorize(f, 101, 'profile.read_own') }), /subscription_own_access_required/u);
  f.sqlite.exec('UPDATE users SET is_blocked=1 WHERE telegram_id=101');
  await assert.rejects(readOwnSubscriptionQuotas({ authorization: await authorize(f) }), /account_restricted/u);
});
