import test from 'node:test';
import assert from 'node:assert/strict';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { approvedPartner, publishedOffer } from './helpers/v1.4.0-rebuild-sqlite.mjs';
import { createRuntimeAuthorizer, readRuntimeAuthorization, runtimeAuthorizationDTO,
  isRuntimeAuthorization, assertRuntimeAuthorizationFresh, requireRuntimeAuthorization,
  projectRuntimeAccessAuthority, assertRuntimeAuthorizationsFresh } from '../src/v1.4.1/runtime-authorizer.mjs';
import { deriveTrustedOperationContext } from '../src/v1.4.1/trusted-context.mjs';

test('runtime uses authenticated canonical request-local facts and emits only a passive public projection', async t => {
  const f = foundationFixture(t), authorizer = createRuntimeAuthorizer();
  const context = await f.context(101, 'profile.read_own');
  const bundle = await authorizer.authorize(context);
  assert.equal(isRuntimeAuthorization(bundle), true);
  assert.equal(readRuntimeAuthorization(bundle).context, context);
  assert.equal(runtimeAuthorizationDTO(bundle).allowed, true);
  assert.equal(requireRuntimeAuthorization(bundle), bundle);
  assert.equal(await assertRuntimeAuthorizationFresh(bundle), bundle);
  const { lifecycle, ...access } = projectRuntimeAccessAuthority(bundle);
  assert.equal(lifecycle,readRuntimeAuthorization(bundle).actor.access.lifecycle);
  assert.equal(lifecycle.paidAccess,false); assert.equal(lifecycle.state,null);
  assert.deepEqual(access, { authority: 'worker', decisionVersion: 2,
    telegramId: 101, systemRole: 'user', planCode: 'free', accessState: 'none',
    comparisonStatus: 'matched', reviewRequired: false, resolved: true, readPath: 'canonical', paidCapabilitiesEnabled: false });
  assert.equal(isRuntimeAuthorization(JSON.parse(JSON.stringify(bundle))), false);
  assert.throws(() => readRuntimeAuthorization({ version: 1 }), /untrusted_runtime_authorization/u);
  await assert.rejects(authorizer.authorize({ telegramId: 900, operation: 'admin.cabinet.open' }), /untrusted_context/u);
});
test('freshness refuses account changes in the same read batch and a fresh authorization never reuses stale actors', async t => {
  const f = foundationFixture(t), authorizer = createRuntimeAuthorizer(), context = await f.context(101, 'profile.read_own');
  const first = await authorizer.authorize(context);
  f.binding.audit.length = 0;
  f.binding.beforeBatch = () => f.sqlite.exec('UPDATE users SET is_blocked=1 WHERE telegram_id=101');
  await assert.rejects(assertRuntimeAuthorizationFresh(first), /authority_stale/u);
  f.binding.beforeBatch = null;
  const second = await authorizer.authorize(context);
  assert.notEqual(readRuntimeAuthorization(first).actor, readRuntimeAuthorization(second).actor);
  assert.equal(runtimeAuthorizationDTO(second).allowed, false);
  assert.throws(() => requireRuntimeAuthorization(second), /account_restricted/u);
  assert.ok(f.binding.audit.every(event => event.kind !== 'batch' || event.statements.every(statement => /^SELECT/u.test(statement.sql))));
});
test('financial review projection stays conservative and exposes no raw source or identity proofs', async t => {
  const f = foundationFixture(t);
  f.sqlite.exec("UPDATE user_access SET access_tier='team' WHERE telegram_id=101");
  const bundle = await createRuntimeAuthorizer().authorize(await f.context(101, 'profile.read_own'));
  assert.equal(runtimeAuthorizationDTO(bundle).allowed, true);
  const projection = projectRuntimeAccessAuthority(bundle);
  assert.equal(projection.planCode, 'free'); assert.equal(projection.comparisonStatus, 'manual_review');
  assert.equal(projection.paidCapabilitiesEnabled, false); assert.equal(projection.reviewRequired, true);
  assert.ok(!/sourceFingerprint|accountFingerprint|claimToken|payloadHash|requestPayload|sourceRef/u.test(JSON.stringify(projection)));
});
test('sibling read contexts retain every distinct guard in one deduplicated primary batch and reject another principal',async t=>{
  const f=foundationFixture(t),authorizer=createRuntimeAuthorizer(),context=await f.context(101,'profile.read_own');
  const own=await authorizer.authorize(context);
  const help=await authorizer.authorize(await deriveTrustedOperationContext(context,{operation:'help.read'}));
  f.binding.audit.length=0;
  assert.deepEqual(await assertRuntimeAuthorizationsFresh([own,help]),[own,help]);
  const singleCount=f.binding.audit.length;
  f.binding.audit.length=0;await assertRuntimeAuthorizationFresh(own);await assertRuntimeAuthorizationFresh(help);
  assert.ok(singleCount<f.binding.audit.length,'only identical producer assertions deduplicate');
  const other=await authorizer.authorize(await f.context(202,'profile.read_own'));
  await assert.rejects(assertRuntimeAuthorizationsFresh([own,other]),/proof_context_mismatch/u);
  f.sqlite.exec('UPDATE users SET accepted_terms=0 WHERE telegram_id=101');
  await assert.rejects(assertRuntimeAuthorizationsFresh([own,help]),/authority_stale/u);
});
test('canonical collection reads use actual zero counts or every public/own member and never authorize a mutation',async t=>{
  const f=foundationFixture(t),authorizer=createRuntimeAuthorizer();
  const collection=async(id,capability,kind,view,selectedKeys)=>authorizer.authorize(await f.context(id,capability,'mini_app',{
    requestPayload:{routeCode:kind==='offer_collection'?'cabinet.offers':'cabinet.applications',view,selectedKeys}}),{kind,key:view});
  const empty=await collection(101,'application.read_own','application_collection','mine',[]);
  assert.equal(runtimeAuthorizationDTO(empty).allowed,true);await assertRuntimeAuthorizationFresh(empty);
  const partner=await approvedPartner(f,202);
  assert.equal(runtimeAuthorizationDTO(await collection(202,'offer.read_own','offer_collection','mine',[])).allowed,true);
  const published=await publishedOffer(f,202,partner);
  const publicPage=await collection(101,'offer.read_public','offer_collection','catalog',[published.code]);
  assert.equal(runtimeAuthorizationDTO(publicPage).allowed,true);await assertRuntimeAuthorizationFresh(publicPage);
  assert.equal(runtimeAuthorizationDTO(await collection(202,'offer.read_own','offer_collection','mine',[published.code])).allowed,true);
  assert.equal(runtimeAuthorizationDTO(await collection(101,'offer.read_public','offer_collection','catalog',[])).allowed,false,'empty selection is not proof an existing catalog is empty');
  await assert.rejects(collection(202,'offer.archive_own','offer_collection','mine',[published.code]),/invalid_resource_reference/u);
  f.sqlite.prepare("UPDATE offer_visibility_rules SET visibility='private' WHERE offer_code=?").run(published.code);
  await assert.rejects(assertRuntimeAuthorizationFresh(publicPage),/authority_stale/u);
  assert.equal(runtimeAuthorizationDTO(await collection(101,'offer.read_public','offer_collection','catalog',[published.code])).allowed,false);
});
