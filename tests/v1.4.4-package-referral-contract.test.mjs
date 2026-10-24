import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {cabinetSubscriptionFixture} from './helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import {PACKAGE_REFERRAL_SCHEMA,inspectPackageReferralSchema,packageReferralSchemaAssertion} from '../src/v1.4.4/package-referral-contract.mjs';
const migration=fs.readFileSync(new URL('../migrations/0074-v1.4.4-package-referral-compatibility.sql',import.meta.url),'utf8');
function fixture(t,{install=true}={}) {
 const f=cabinetSubscriptionFixture(t);
 for(const name of ['0028-v1.3.7-referral-reward-foundation.sql','0029-v1.3.7-referral-candidate-cycle-guard.sql','0030-v1.3.7-referral-protection-workflow.sql','0031-v1.3.7-referral-bonus-access.sql','0032-v1.3.7-referral-ux-admin.sql','0069-v1.4.3-d1-compatibility.sql','0070-v1.4.3-refund-notification.sql','0071-v1.4.3-refund-contract-retirement.sql','0072-v1.4.4-package-contract.sql','0073-v1.4.4-package-payment-review.sql']) f.sqlite.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 if(install) f.sqlite.exec(migration);
 return f;
}
const rejects=(work,code)=>assert.rejects(work,error=>error.code===code);
const legacyTables=['referral_reward_candidates','referral_rewards','referral_reward_transitions','bonus_access_grants','referral_reward_protection_jobs','referral_reward_protection_checks','subscription_orders','payment_ledger','subscription_package_orders','subscription_package_periods','subscriptions'];
const snapshot=f=>Object.fromEntries(legacyTables.map(table=>[table,f.sqlite.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
const scalar=(f,proof)=>f.sqlite.prepare('SELECT ('+proof.sql+') AS valid').get(...proof.params).valid;

test('entirely absent additive storage preserves legacy reads; required writes fail closed',async t=>{
 const f=fixture(t,{install:false});const before=snapshot(f),audit=f.binding.audit.length;
 const absent=await inspectPackageReferralSchema(f.binding);assert.deepEqual(absent,{ready:true,present:false});assert.ok(Object.isFrozen(absent));const assertion=packageReferralSchemaAssertion(absent);assert.equal(scalar(f,assertion),1);
 await rejects(()=>inspectPackageReferralSchema(f.binding,{required:true}),'package_referral_schema_missing');
 assert.deepEqual(snapshot(f),before);assert.ok(f.binding.audit.slice(audit).every(x=>x.mode==='read'));
});
test('exact finite schema captures all genuine source FKs and four legacy shared guards',async t=>{
 const f=fixture(t),proof=await inspectPackageReferralSchema(f.binding,{required:true});assert.equal(proof.present,true);assert.equal(proof.objectCount,131);
 assert.equal(PACKAGE_REFERRAL_SCHEMA.migrationSha256,createHash('sha256').update(migration).digest('hex'));
 assert.equal(scalar(f,packageReferralSchemaAssertion(proof)),1);
 for(const table of ['package_referral_candidates','package_referral_protection_checks']) {
  assert.ok(f.sqlite.prepare('PRAGMA foreign_key_list('+table+')').all().some(x=>x.from==='source_package_period_id'&&x.table==='subscription_package_periods'&&x.to==='period_id'));
 }
 for(const table of ['package_referral_bonus_grants','package_referral_bonus_effects']) assert.ok(f.sqlite.prepare('PRAGMA foreign_key_list('+table+')').all().some(x=>x.from==='target_package_period_id'&&x.table==='subscription_package_periods'));
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN (?,?,?,?)").get(...PACKAGE_REFERRAL_SCHEMA.attachedTriggers).n,4);
});
test('rerunning the additive migration preserves exact schema and every existing financial row',async t=>{
 const f=fixture(t),before=snapshot(f),first=await inspectPackageReferralSchema(f.binding,{required:true});f.sqlite.exec(migration);
 const second=await inspectPackageReferralSchema(f.binding,{required:true});assert.deepEqual(second,first);assert.deepEqual(snapshot(f),before);assert.equal(scalar(f,packageReferralSchemaAssertion(first)),1);
 assert.equal(f.sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
});
test('partial installation and missing marker are rejected instead of exposing writable referral state',async t=>{
 const f=fixture(t,{install:false});f.sqlite.exec("CREATE TABLE package_referral_bonus_segments(segments_id TEXT)");await rejects(()=>inspectPackageReferralSchema(f.binding),'package_referral_schema_invalid');
 f.sqlite.exec('DROP TABLE package_referral_bonus_segments');f.sqlite.exec(migration);f.sqlite.prepare('DELETE FROM re_schema_migrations WHERE version=?').run(PACKAGE_REFERRAL_SCHEMA.marker);
 await rejects(()=>inspectPackageReferralSchema(f.binding),'package_referral_schema_invalid');
});
test('a dropped source or lifetime trigger invalidates both fresh reads and already captured atomic assertions',async t=>{
 const f=fixture(t);const proof=await inspectPackageReferralSchema(f.binding,{required:true}),assertion=packageReferralSchemaAssertion(proof);
 f.sqlite.exec('DROP TRIGGER v144_legacy_referral_lifetime_guard');assert.equal(scalar(f,assertion),0);
 await rejects(()=>inspectPackageReferralSchema(f.binding,{required:true}),'package_referral_schema_invalid');
});
test('extra triggers and altered table SQL cannot pass an otherwise complete column-only schema',async t=>{
 const f=fixture(t);f.sqlite.exec("CREATE TRIGGER unreviewed_referral_side_effect AFTER INSERT ON package_referral_candidates BEGIN SELECT 1; END");await rejects(()=>inspectPackageReferralSchema(f.binding),'package_referral_schema_invalid');
 f.sqlite.exec('DROP TRIGGER unreviewed_referral_side_effect');f.sqlite.exec('ALTER TABLE package_referral_candidates ADD COLUMN unreviewed_source_alias TEXT');
 await rejects(()=>inspectPackageReferralSchema(f.binding),'package_referral_schema_invalid');
});
test('schema assertions reject cloned or forged proof state and remain bounded to D1 limits',async t=>{
 const f=fixture(t),proof=await inspectPackageReferralSchema(f.binding,{required:true});
 for(const invalid of [{...proof},Object.freeze({...proof}),{ready:true,present:true}]) assert.throws(()=>packageReferralSchemaAssertion(invalid),x=>x.code==='package_referral_schema_assertion_invalid');
 const a=packageReferralSchemaAssertion(proof);assert.ok(a.params.length<=100);assert.ok(Buffer.byteLength(a.sql)<100000);assert.ok(Buffer.byteLength(a.params.at(-2))<131072);assert.ok(Object.isFrozen(a)&&Object.isFrozen(a.params));
});
test('all companion history and shared slot tables prohibit deletion and mutation at the schema boundary',t=>{
 const f=fixture(t);
 for(const table of ['package_referral_candidates','package_referral_transitions','package_referral_protection_checks','referral_reward_lifetime_slots','package_referral_bonus_segments','package_referral_bonus_effects','package_referral_bonus_transitions','package_referral_bonus_reversals','referral_bonus_reward_slots']) {
  const guards=f.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table);
  assert.ok(guards.some(x=>/BEFORE UPDATE/u.test(x.sql)&&/RAISE\(ABORT/u.test(x.sql)),table+' immutable update');
  assert.ok(guards.some(x=>/BEFORE DELETE/u.test(x.sql)&&/RAISE\(ABORT/u.test(x.sql)),table+' immutable delete');
 }
 assert.ok(!migration.includes('UPDATE subscription_package_periods'));assert.ok(!migration.includes('UPDATE subscription_orders'));
});
