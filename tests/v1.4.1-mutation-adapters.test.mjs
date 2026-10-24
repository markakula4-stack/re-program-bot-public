import test from 'node:test';
import assert from 'node:assert/strict';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { approvedPartner, publishedOffer } from './helpers/v1.4.0-rebuild-sqlite.mjs';
import { createRuntimeAuthorizer, readRuntimeAuthorization } from '../src/v1.4.1/runtime-authorizer.mjs';
import { normalizeRuntimeMutationIntent, createRuntimeMutation, isRuntimeMutation,
  readRuntimeMutation, compileRuntimeMutationReplayScope } from '../src/v1.4.1/mutation-adapters.mjs';
import { compileDecisionAssertions } from '../src/v1.4.1/entitlement-engine.mjs';

const KEY = 'mikey_' + 'a'.repeat(64);
const resolve = async (f, id, capability, payload, ref = null) => readRuntimeAuthorization(await createRuntimeAuthorizer()
  .authorize(await f.context(id, capability, 'mini_app', { requestPayload: payload, idempotencyKey: 'adapter-operation-0001' }), ref));
async function applyPlan(f, decision) {
  const opaque = await createRuntimeMutation(decision, KEY), plan = readRuntimeMutation(opaque);
  assert.equal(isRuntimeMutation(opaque), true);
  assert.equal(isRuntimeMutation(JSON.parse(JSON.stringify(opaque))), false);
  // Real SQLite enforces every captured source snapshot and builder CAS before
  // the actual canonical write/history. The production executor owns receipt,
  // audit and effects; these tests verify this module's closed SQL plan.
  const guards = compileDecisionAssertions(decision).assertions;
  const statements = [];
  let index = 0;
  for (const proof of guards) statements.push(f.binding.prepare('INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) SELECT ?,CASE WHEN (' + proof.sql + ') THEN 1 ELSE 0 END').bind('adapter:' + index++, ...proof.params));
  for (const write of plan.writes) {
    statements.push(f.binding.prepare(write.sql).bind(...write.params));
    statements.push(f.binding.prepare('INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) SELECT ?,CASE WHEN changes()>=? AND changes()<=? THEN 1 ELSE 0 END').bind('adapter:' + index++, write.minChanges, write.maxChanges));
  }
  statements.push(f.binding.prepare("DELETE FROM mini_app_atomic_guards WHERE guard_key LIKE 'adapter:%'"));
  await f.binding.batch(statements);
  return plan;
}
test('closed intent canonicalization preserves signed fields and rejects actor/SQL/ambiguous versions', () => {
  const payload = { decision: 'approved', version: 3 };
  const normalized = normalizeRuntimeMutationIntent('admin.offer.moderate', payload);
  assert.deepEqual(normalized, { decision: 'approved', version: 3 });
  assert.equal(Object.hasOwn(normalized, 'reason'), false);
  payload.version = 99; assert.equal(normalized.version, 3);
  for (const bad of [{ ...payload, expectedVersionId: 7 }, { ...payload, actorId: 900 }, { ...payload, sql: 'DELETE FROM users' }]) {
    assert.throws(() => normalizeRuntimeMutationIntent('admin.offer.moderate', bad), /invalid_intent/u);
  }
  assert.throws(() => normalizeRuntimeMutationIntent('admin.entitlement.manage', {}), /unsupported_atomic_operation/u);
  assert.throws(() => readRuntimeMutation({ version: 1 }), /untrusted_runtime_mutation/u);
});
test('actual own partner application, legal declaration and username plans preserve canonical history and independent facts', async t => {
  const f = foundationFixture(t);
  const application = await resolve(f, 101, 'partner.apply', { displayName: 'Synthetic partner', contact: '@test', ageConfirmed: true });
  assert.equal(application.decision.allowed, true);
  await applyPlan(f, application.decision);
  assert.equal(f.sqlite.prepare('SELECT status FROM partner_applications WHERE telegram_id=101').get().status, 'pending');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM user_roles WHERE telegram_id=101 AND role=\'partner\'').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM partner_application_decisions').get().n, 1);
  await approvedPartner(f, 202);
  f.sqlite.exec("UPDATE partner_profiles SET telegram_username='valid_partner' WHERE telegram_id=202");
  const legal = await resolve(f, 202, 'partner.legal_declare_own', { profileKind: 'individual', selfDeclarationAccepted: true });
  await applyPlan(f, legal.decision);
  assert.equal(f.sqlite.prepare('SELECT verification_state FROM partner_legal_profiles').get().verification_state, 'self_declared');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM partner_legal_profile_events').get().n, 1);
  const username = await resolve(f, 202, 'partner.public_username.update_own', { enabled: true });
  await applyPlan(f, username.decision);
  assert.equal(f.sqlite.prepare('SELECT public_username_enabled FROM partner_public_settings WHERE telegram_id=202').get().public_username_enabled, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM user_plans WHERE telegram_id=202').get().n, 0);
});
test('canonical owner admin review and approved profile repair use existing domain CAS and cannot self review', async t => {
  const f = foundationFixture(t);
  await f.session(303);
  await f.call(303, 'partner/application', { method: 'POST', payload: { displayName: 'Synthetic target', contact: '', ageConfirmed: true } });
  const id = f.sqlite.prepare('SELECT id FROM partner_applications WHERE telegram_id=303').get().id;
  const result = await resolve(f, 900, 'admin.partner.review', { decision: 'approve' }, { kind: 'partner_application', key: id });
  assert.equal(result.decision.allowed, true);
  await applyPlan(f, result.decision);
  assert.equal(f.sqlite.prepare('SELECT status FROM partner_applications WHERE id=?').get(id).status, 'approved');
  assert.equal(f.sqlite.prepare('SELECT status FROM user_roles WHERE telegram_id=303 AND role=\'partner\'').get().status, 'active');
  f.sqlite.exec('DELETE FROM partner_profiles WHERE telegram_id=303');
  const repair = await resolve(f, 900, 'admin.partner.repair', {}, { kind: 'partner_application', key: id });
  await applyPlan(f, repair.decision);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM partner_profiles WHERE telegram_id=303').get().n, 1);
  f.sqlite.exec("UPDATE user_roles SET status='paused' WHERE telegram_id=900 AND role='admin'");
  const denied = await resolve(f, 900, 'admin.partner.review', { decision: 'approve' }, { kind: 'partner_application', key: id });
  await assert.rejects(createRuntimeMutation(denied.decision, KEY), /role_required|resource_unavailable/u);
  await assert.rejects(compileRuntimeMutationReplayScope(denied.decision), /admin_target_required/u);
});
test('actual admin moderation, visibility and assignment plans use the captured current version and current target', async t => {
  const f = foundationFixture(t), p = await publishedOffer(f);
  f.sqlite.prepare("UPDATE offer_visibility_rules SET moderation_status='pending',visibility='private',approved_version_id=NULL WHERE offer_code=?").run(p.code);
  const ref = { kind: 'offer', key: p.code };
  const moderation = await resolve(f, 900, 'admin.offer.moderate', { version: 3, decision: 'approved' }, ref);
  assert.equal(moderation.decision.allowed, true); await applyPlan(f, moderation.decision);
  const assignment = await resolve(f, 900, 'admin.offer.assign', { targetTelegramId: 101, action: 'assign' }, ref);
  await applyPlan(f, assignment.decision);
  assert.equal(f.sqlite.prepare('SELECT assignment_status FROM offer_visibility_assignments WHERE offer_code=? AND telegram_id=101').get(p.code).assignment_status, 'active');
  const visibility = await resolve(f, 900, 'admin.offer.visibility', { version: 3, visibility: 'assigned' }, ref);
  await applyPlan(f, visibility.decision);
  const revoke = await resolve(f, 900, 'admin.offer.assign', { targetTelegramId: 101, action: 'revoke', reason: 'Closed' }, ref);
  await applyPlan(f, revoke.decision);
  assert.equal(f.sqlite.prepare('SELECT visibility FROM offer_visibility_rules WHERE offer_code=?').get(p.code).visibility, 'private');
  assert.equal(f.sqlite.prepare('SELECT assignment_status FROM offer_visibility_assignments WHERE offer_code=? AND telegram_id=101').get(p.code).assignment_status, 'revoked');
  const wrong = await resolve(f, 900, 'admin.offer.visibility', { version: 2, visibility: 'public' }, ref);
  assert.equal(wrong.decision.allowed, false); await assert.rejects(createRuntimeMutation(wrong.decision, KEY));
});
test('decision copies, payload transplant, and change before batch cannot produce or commit a trusted mutation', async t => {
  const f = foundationFixture(t), target = await resolve(f, 101, 'partner.apply', { displayName: 'Synthetic target', contact: '', ageConfirmed: true });
  await assert.rejects(createRuntimeMutation(JSON.parse(JSON.stringify(target.decision)), KEY), /untrusted_decision/u);
  await assert.rejects(createRuntimeMutation(target.decision, 'caller-key'), /invalid_server_key/u);
  f.binding.beforeBatch = () => f.sqlite.exec('UPDATE users SET is_blocked=1 WHERE telegram_id=101');
  await assert.rejects(applyPlan(f, target.decision));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM partner_applications WHERE telegram_id=101').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM partner_application_decisions').get().n, 0);
});
