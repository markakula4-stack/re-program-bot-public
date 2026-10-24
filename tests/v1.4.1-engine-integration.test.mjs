import test from 'node:test';
import assert from 'node:assert/strict';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { createAuthorityResolver, readActorContext } from '../src/v1.4.1/authority-resolver.mjs';
import { createResourceResolver } from '../src/v1.4.1/resource-resolver.mjs';
import { can, compileDecisionAssertions, isTrustedDecision } from '../src/v1.4.1/entitlement-engine.mjs';
import { CAPABILITY_DEFINITIONS, FOUNDATION_POLICY_VERSION } from '../src/v1.4.1/capability-policy.mjs';

const resolve = async (f, id, capability, ref = null, patch = {}) => {
  const context = await f.context(id, capability, 'mini_app', patch);
  const actor = await createAuthorityResolver().resolveActor(context);
  const resource = await createResourceResolver().resolve(context, actor, ref);
  return { context, actor, resource, decision: can(actor, capability, resource) };
};
const prove = (f, decision) => compileDecisionAssertions(decision).assertions.every(proof =>
  f.sqlite.prepare(`SELECT CASE WHEN (${proof.sql}) THEN 1 ELSE 0 END AS ok`).get(...proof.params).ok === 1);
const dtoKeys = ['version','capability','allowed','reasonCode','policyVersion','effectivePlan',
  'accessState','validUntil','quota','actionPolicy'].sort();

test('canonical actor/resource/decision composition stays pure and detects later account restriction before write', async t => {
  const f = foundationFixture(t), result = await resolve(f, 101, 'profile.read_own');
  assert.equal(result.decision.allowed, true); assert.equal(prove(f, result.decision), true);
  f.binding.audit.length = 0;
  const before = JSON.stringify(result.decision);
  for (let i = 0; i < 5; i++) assert.equal(JSON.stringify(can(result.actor, 'profile.read_own', result.resource)), before);
  assert.equal(f.binding.audit.length, 0);
  f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=101').run();
  assert.equal(prove(f, result.decision), false);
  const blocked = await resolve(f, 101, 'profile.read_own');
  assert.equal(blocked.decision.allowed, false); assert.equal(blocked.decision.reasonCode, 'account_restricted');
});
test('actual public document and own privacy producers keep their protected paths during block and terms restriction', async t => {
  const f = foundationFixture(t);
  f.sqlite.exec('UPDATE users SET is_blocked=1, accepted_terms=0 WHERE telegram_id=101');
  for (const capability of ['terms.read', 'help.read', 'privacy.read_own', 'privacy.export_own']) {
    const { decision } = await resolve(f, 101, capability);
    assert.equal(decision.allowed, true, `${capability}: ${decision.reasonCode}`);
    assert.deepEqual(Object.keys(decision).sort(), dtoKeys);
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM entitlement_grants').get().n, 0);
});
test('unregistered authenticated subject can read terms and use fixed preregistration without creating account or role', async t => {
  const f = foundationFixture(t);
  for (const capability of ['terms.read', 'help.read', 'account.register', 'terms.accept']) {
    const { actor, decision } = await resolve(f, 999, capability);
    assert.equal(actor.account.exists, false); assert.deepEqual(actor.roles, []);
    assert.equal(decision.allowed, true, `${capability}: ${decision.reasonCode}`);
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM users WHERE telegram_id=999').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM user_roles WHERE telegram_id=999').get().n, 0);
});
test('client copies and mixed contexts cannot transfer a decision or expose private authority in public DTO', async t => {
  const f = foundationFixture(t), own = await resolve(f, 101, 'profile.read_own'), other = await resolve(f, 202, 'profile.read_own');
  assert.equal(readActorContext(own.actor), own.context);
  const mixed = can(own.actor, 'profile.read_own', other.resource);
  assert.equal(mixed.allowed, false); assert.equal(mixed.reasonCode, 'resource_unavailable');
  assert.equal(mixed.quota, null); assert.equal(mixed.effectivePlan, null);
  assert.equal(can(JSON.parse(JSON.stringify(own.actor)), 'profile.read_own', own.resource).allowed, false);
  const copy = JSON.parse(JSON.stringify(own.decision));
  assert.equal(isTrustedDecision(copy), false); assert.throws(() => compileDecisionAssertions(copy), /untrusted_decision/u);
  assert.deepEqual(Object.keys(own.decision).sort(), dtoKeys);
  assert.ok(!/sourceFingerprint|telegramId|accountFingerprint|claimToken|sessionId|requestPayload/u.test(JSON.stringify(own.decision)));
});
test('all seven future customer capabilities and all ten service capabilities stay unavailable to real customer actors', async t => {
  const f = foundationFixture(t), future = CAPABILITY_DEFINITIONS.filter(row => row.availability === 'future_disabled');
  const services = CAPABILITY_DEFINITIONS.filter(row => row.actor_kind === 'trusted_service');
  assert.equal(future.length, 7); assert.equal(services.length, 10);
  for (const row of [...future, ...services]) {
    const context = await f.context(900, row.capability), actor = await createAuthorityResolver().resolveActor(context);
    const decision = can(actor, row.capability);
    assert.equal(decision.allowed, false, row.capability);
    assert.equal(decision.quota, null); assert.equal(decision.policyVersion, FOUNDATION_POLICY_VERSION);
  }
  const { actor } = await resolve(f, 101, 'profile.read_own');
  for (const unknown of ['future.open_all', '__proto__', '', null, 1]) assert.equal(can(actor, unknown).allowed, false);
});
