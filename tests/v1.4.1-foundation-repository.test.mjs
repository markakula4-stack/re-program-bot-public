import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { runPublicPython } from './helpers/public-python.mjs';
import { fixture } from './helpers/v1.4.0-rebuild-sqlite.mjs';
import { reviewedRepositoryFactory } from '../src/v1.4.0-rebuild/storage-factory.mjs';
import {
  createFoundationRepository, FOUNDATION_TABLES, FOUNDATION_METADATA_ACTIVATION,
} from '../src/v1.4.1/foundation-repository.mjs';
import {
  FOUNDATION_POLICY_VERSION, CAPABILITY_CATALOG, PLAN_CAPABILITIES,
} from '../src/v1.4.1/capability-policy.mjs';
import { FOUNDATION_SCHEMA } from '../src/v1.4.1/foundation-schema.mjs';

const policyVersion = FOUNDATION_POLICY_VERSION;
const migrations = ['0062-v1.4.1-capability-policy.sql',
  '0063-v1.4.1-grants-overrides.sql', '0064-v1.4.1-audit-rollout.sql'];
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const sqlSource = name => fs.readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8');
const insert = (db, table, row) => {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})
    ON CONFLICT DO NOTHING`).run(...keys.map(key => row[key]));
};
const setup = (t, { seeded = true } = {}) => {
  const f = fixture({ exactSchema: true }); t.after(f.close);
  for (const name of migrations) f.sqlite.exec(sqlSource(name));
  if (seeded) {
    for (const row of CAPABILITY_CATALOG) insert(f.sqlite, 'capability_catalog', row);
    for (const row of PLAN_CAPABILITIES) insert(f.sqlite, 'plan_capabilities', row);
  }
  return f;
};
const policyInput = (capability = 'application.create', planCode = 'free', accessOverlay = 'none') =>
  ({ policyVersion, capability, planCode, accessOverlay });
const subjectInput = (f, patch = {}) => ({ policyVersion, capability: 'application.create',
  subjectTelegramId: 101, scopeKind: 'actor', scopeKey: 'actor:101', nowSeconds: f.now, ...patch });
const grant = (f, name, patch = {}) => ({
  grant_id: name, idempotency_key: hash(name), policy_version: policyVersion,
  capability: 'application.create', subject_telegram_id: 101,
  scope_kind: 'actor', scope_key: 'actor:101', source_kind: 'manual_capability',
  source_ref: 'synthetic:' + name, source_revision: 1,
  source_fingerprint: hash('synthetic-source:' + name), issued_by: 900,
  reason: 'Synthetic metadata only', starts_at: f.now - 20, expires_at: f.now + 600,
  revision: 1, created_at: f.now - 20, updated_at: f.now - 20,
  revoked_at: null, revoked_by: null, revocation_reason: null, retention_until: null, ...patch,
});
const override = (f, name, patch = {}) => ({
  override_id: name, idempotency_key: hash(name), policy_version: policyVersion,
  capability: 'application.create', subject_telegram_id: 101,
  subject_source_fingerprint: hash('synthetic-account:' + name),
  scope_kind: 'actor', scope_key: 'actor:101', effect: 'deny', limit_value: null,
  issued_by: 900, reason: 'Synthetic metadata only', starts_at: f.now - 20,
  expires_at: f.now + 600, revision: 1, created_at: f.now - 20, updated_at: f.now - 20,
  revoked_at: null, revoked_by: null, revocation_reason: null, retention_until: null, ...patch,
});
const flag = (f, name, patch = {}) => ({ flag_key: name, policy_version: policyVersion,
  enabled: 0, emergency_disabled: 1, revision: 1, rollout_json: '{}',
  updated_by: null, reason: 'Synthetic disabled flag', updated_at: f.now - 20, ...patch });
const assignment = (f, name, patch = {}) => ({ assignment_id: name,
  idempotency_key: hash(name), flag_key: 'synthetic.flag', subject_kind: 'actor',
  subject_key: 'actor:101', subject_telegram_id: 101,
  subject_source_fingerprint: hash('synthetic-account:' + name), assigned_by: 900,
  reason: 'Synthetic metadata only', starts_at: f.now - 20, expires_at: f.now + 600,
  revision: 1, created_at: f.now - 20, updated_at: f.now - 20,
  revoked_at: null, revoked_by: null, revocation_reason: null, retention_until: null, ...patch });
const removeTriggers = (f, table) => {
  for (const { name } of f.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(table)) {
    f.sqlite.exec(`DROP TRIGGER "${name}"`);
  }
};
const readsOnly = f => {
  assert.ok(f.binding.audit.length);
  assert.ok(f.binding.audit.every(entry => entry.mode === 'read'));
  assert.ok(f.binding.audit.every(entry => !/SELECT\s+\*/iu.test(entry.sql)));
  assert.ok(f.binding.audit.every(entry => !/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(entry.sql)));
};

test('foundation inspection proves all seven tables and exact 104/416 canonical rows using reads only', async t => {
  const f = setup(t);
  const beforeUsers = f.sqlite.prepare('SELECT telegram_id, accepted_terms FROM users ORDER BY telegram_id').all();
  f.binding.audit.length = 0;
  const repository = createFoundationRepository(f.binding);
  const result = await repository.inspectFoundation({ policyVersion });
  assert.equal(result.status, 'ready');
  assert.equal(result.capabilityCount, 104); assert.equal(result.planPolicyCount, 416);
  assert.equal(result.schemaObjectCount, FOUNDATION_SCHEMA.objects.length);
  assert.equal(result.schemaSha256, FOUNDATION_SCHEMA.schemaSha256);
  assert.ok(FOUNDATION_SCHEMA.objects.some(row => row.type === 'index' && row.sql === null));
  assert.deepEqual(result.tables, FOUNDATION_TABLES);
  assert.equal(result.metadataOnly, true); assert.equal(result.activation, FOUNDATION_METADATA_ACTIVATION);
  assert.equal(Object.hasOwn(result, 'allowed'), false);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.tables));
  assert.equal(f.binding.sessions.at(-1), 'first-primary');
  assert.deepEqual(f.sqlite.prepare('SELECT telegram_id, accepted_terms FROM users ORDER BY telegram_id').all(), beforeUsers);
  readsOnly(f);
});

test('old schema and unseeded foundation cannot claim ready and cannot waive canonical counts', async t => {
  const old = fixture({ exactSchema: true }); t.after(old.close);
  assert.equal((await createFoundationRepository(old.binding).inspectFoundation({ policyVersion })).reasonCode,
    'foundation_schema_inconsistent');
  const empty = setup(t, { seeded: false });
  // The checked-in migration can include canonical seed already. Delete only
  // inside the isolated fixture to test an incomplete deployment, not policy.
  const deletedTriggers = empty.sqlite.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('plan_capabilities','capability_catalog') ORDER BY name").all();
  removeTriggers(empty, 'plan_capabilities'); removeTriggers(empty, 'capability_catalog');
  empty.sqlite.exec('DELETE FROM plan_capabilities; DELETE FROM capability_catalog');
  for (const { sql } of deletedTriggers) empty.sqlite.exec(sql);
  const repository = createFoundationRepository(empty.binding);
  assert.equal((await repository.inspectFoundation({ policyVersion })).reasonCode, 'foundation_policy_inconsistent');
  await assert.rejects(repository.inspectFoundation({ policyVersion, expectedCapabilityCount: 0 }),
    { code: 'invalid_foundation_request' });
});

test('unknown policy or capability fails closed before reading any private metadata', async t => {
  const f = setup(t); f.binding.audit.length = 0;
  const repository = createFoundationRepository(f.binding);
  assert.equal((await repository.inspectFoundation({ policyVersion: 'unknown.policy' })).reasonCode, 'unknown_policy');
  assert.equal((await repository.readCapabilityPolicy({ ...policyInput(), policyVersion: 'unknown.policy' })).reasonCode,
    'unknown_policy');
  assert.equal((await repository.readSubjectMetadata(subjectInput(f, { capability: 'unknown.capability' }))).reasonCode,
    'unknown_capability');
  assert.equal(f.binding.audit.length, 0);
});

test('read policy projects stored plan metadata and never acts as entitlement decision', async t => {
  const f = setup(t), repository = createFoundationRepository(f.binding);
  const free = await repository.readCapabilityPolicy(policyInput());
  const preview = await repository.readCapabilityPolicy(policyInput('application.create', 'free', 'dragon_preview'));
  assert.equal(free.status, 'policy_metadata'); assert.equal(free.planRule.limit_value, 5);
  assert.equal(preview.planRule.limit_value, 50); assert.equal(preview.planRule.plan_code, 'free');
  assert.equal(Object.hasOwn(free, 'allowed'), false); assert.equal(Object.hasOwn(free, 'effectivePlan'), false);
  assert.equal(free.activation, FOUNDATION_METADATA_ACTIVATION);
  assert.throws(() => { free.planRule.allowed = 1; }, TypeError);
  await assert.rejects(repository.readCapabilityPolicy(policyInput('application.create', 'dragon', 'dragon_preview')),
    { code: 'invalid_foundation_request' });
});

test('missing and tampered plan rows fail closed instead of falling back to free policy', async t => {
  const f = setup(t); removeTriggers(f, 'plan_capabilities');
  f.sqlite.prepare("DELETE FROM plan_capabilities WHERE policy_version=? AND capability='application.create' AND plan_code='dragon'").run(policyVersion);
  const repository = createFoundationRepository(f.binding);
  assert.equal((await repository.readCapabilityPolicy(policyInput('application.create', 'dragon'))).reasonCode,
    'foundation_policy_inconsistent');
  assert.equal((await repository.inspectFoundation({ policyVersion })).reasonCode, 'foundation_schema_inconsistent');
});

test('same-sized but altered policy JSON/hash is detected against frozen canonical rows', async t => {
  const f = setup(t); removeTriggers(f, 'capability_catalog');
  const original = CAPABILITY_CATALOG.find(row => row.capability === 'application.create');
  const changed = { ...JSON.parse(original.definition_json), prerequisites: [] };
  f.sqlite.prepare('UPDATE capability_catalog SET definition_json=?,definition_sha256=? WHERE policy_version=? AND capability=?')
    .run(JSON.stringify(changed), hash(JSON.stringify(changed)), policyVersion, original.capability);
  const repository = createFoundationRepository(f.binding);
  assert.equal((await repository.readCapabilityPolicy(policyInput())).reasonCode, 'foundation_policy_inconsistent');
  assert.equal((await repository.inspectFoundation({ policyVersion })).reasonCode, 'foundation_schema_inconsistent');
});

test('subject reads enforce exact subject/scope, half-open times and terminal revocation', async t => {
  const f = setup(t);
  insert(f.sqlite, 'entitlement_grants', grant(f, 'current'));
  insert(f.sqlite, 'entitlement_grants', grant(f, 'expired', { expires_at: f.now }));
  insert(f.sqlite, 'entitlement_grants', grant(f, 'future', { starts_at: f.now + 1, created_at: f.now, updated_at: f.now }));
  insert(f.sqlite, 'entitlement_grants', grant(f, 'foreign', { subject_telegram_id: 202, scope_key: 'actor:202' }));
  insert(f.sqlite, 'entitlement_grants', grant(f, 'other-scope', { scope_kind: 'resource', scope_key: 'lead:1' }));
  insert(f.sqlite, 'entitlement_grants', grant(f, 'revoked'));
  f.sqlite.prepare("UPDATE entitlement_grants SET revoked_at=?,revoked_by=900,revocation_reason='Synthetic revoke',revision=2,updated_at=? WHERE grant_id='revoked'")
    .run(f.now, f.now);
  insert(f.sqlite, 'entitlement_overrides', override(f, 'own-deny'));
  const repository = createFoundationRepository(f.binding);
  const result = await repository.readSubjectMetadata(subjectInput(f));
  assert.deepEqual(result.grants.map(row => row.grant_id), ['current']);
  assert.deepEqual(result.overrides.map(row => row.override_id), ['own-deny']);
  assert.equal(result.sourceProofVerified, false); assert.equal(Object.hasOwn(result, 'allowed'), false);
  assert.ok(Object.isFrozen(result.grants[0]));
  const foreign = await repository.readSubjectMetadata(subjectInput(f,
    { subjectTelegramId: 202, scopeKey: 'actor:202' }));
  assert.deepEqual(foreign.grants.map(row => row.grant_id), ['foreign']);
});

test('future and trusted-service policy cannot be interpreted as customer grant metadata', async t => {
  const f = setup(t), repository = createFoundationRepository(f.binding);
  for (const capability of [CAPABILITY_CATALOG.find(row => row.availability === 'future_disabled').capability,
    CAPABILITY_CATALOG.find(row => row.actor_kind === 'trusted_service').capability]) {
    const result = await repository.readSubjectMetadata(subjectInput(f, { capability }));
    assert.equal(result.reasonCode, 'subject_metadata_not_applicable');
    assert.equal(Object.hasOwn(result, 'grants'), false);
  }
});

test('too many applicable grants deny the read rather than silently truncate source evidence', async t => {
  const f = setup(t);
  for (let i = 0; i < 65; i++) insert(f.sqlite, 'entitlement_grants', grant(f, 'overflow-' + i));
  await assert.rejects(createFoundationRepository(f.binding).readSubjectMetadata(subjectInput(f)),
    { code: 'foundation_metadata_overflow' });
});

test('flag reads return metadata only and never assume client cohorts or other subjects', async t => {
  const f = setup(t);
  insert(f.sqlite, 'feature_flags', flag(f, 'synthetic.flag', { enabled: 1, emergency_disabled: 0,
    updated_by: 900, rollout_json: '{\n "cohort":"synthetic"\n}' }));
  insert(f.sqlite, 'feature_flag_assignments', assignment(f, 'own-assignment'));
  insert(f.sqlite, 'feature_flag_assignments', assignment(f, 'other-assignment',
    { subject_telegram_id: 202, subject_key: 'actor:202' }));
  insert(f.sqlite, 'feature_flag_assignments', assignment(f, 'cohort-assignment',
    { subject_kind: 'cohort', subject_telegram_id: null, subject_key: 'cohort:synthetic', subject_source_fingerprint: null }));
  const repository = createFoundationRepository(f.binding);
  const result = await repository.readFeatureFlagMetadata({ policyVersion, flagKey: 'synthetic.flag',
    subjectTelegramId: 101, subjectKey: 'actor:101', nowSeconds: f.now });
  assert.equal(result.flag.enabled, 1); assert.equal(result.sourceProofVerified, false);
  assert.deepEqual(result.assignments.map(row => row.assignment_id), ['own-assignment']);
  assert.equal(Object.hasOwn(result, 'allowed'), false);
  const absent = await repository.readFeatureFlagMetadata({ policyVersion, flagKey: 'missing.flag',
    subjectTelegramId: 101, subjectKey: 'actor:101', nowSeconds: f.now });
  assert.equal(absent.flag, null); assert.deepEqual(absent.assignments, []);
});

test('strict input validation rejects extra actor authority, SQL input, oversize keys and invalid subject IDs', async t => {
  const f = setup(t), repository = createFoundationRepository(f.binding);
  for (const patch of [{ allowed: true }, { actorKind: 'trusted_service' },
    { capability: "application.create'; DROP TABLE users" }, { scopeKey: 'x'.repeat(193) },
    { subjectTelegramId: Number.MAX_SAFE_INTEGER + 1 }, { subjectTelegramId: -1 }, { nowSeconds: 0 }]) {
    await assert.rejects(repository.readSubjectMetadata({ ...subjectInput(f), ...patch }),
      { code: 'invalid_foundation_request' });
  }
  assert.equal(f.binding.audit.length, 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM users').get().n, 5);
});

test('query budgets are bounded per repository and no policy/subject rows leak across requests', async t => {
  const f = setup(t);
  const limited = createFoundationRepository(f.binding, { queryLimit: 1 });
  await assert.rejects(limited.readCapabilityPolicy(policyInput()), { code: 'foundation_query_budget_exhausted' });
  const first = createFoundationRepository(f.binding);
  assert.deepEqual((await first.readSubjectMetadata(subjectInput(f))).grants, []);
  insert(f.sqlite, 'entitlement_grants', grant(f, 'fresh-next-request'));
  const second = createFoundationRepository(f.binding);
  assert.deepEqual((await second.readSubjectMetadata(subjectInput(f))).grants.map(row => row.grant_id),
    ['fresh-next-request']);
  assert.throws(() => createFoundationRepository(f.binding, { queryLimit: 51 }), { code: 'foundation_unavailable' });
});

test('storage failure is safe and never mistaken for a free allowance', async t => {
  const f = setup(t);
  const binding = { withSession() { return { prepare() { throw new Error('synthetic private storage detail'); } }; } };
  await assert.rejects(createFoundationRepository(binding).readCapabilityPolicy(policyInput()),
    error => error.code === 'foundation_unavailable' && !error.message.includes('private'));
});

test('accepted old reviewed repository and cabinet session/read still work against additive expanded schema', async t => {
  const f = setup(t);
  const oldRepo = reviewedRepositoryFactory(f.env(101), { readOnly: true });
  await oldRepo.assertCandidateSchema();
  assert.equal((await oldRepo.one('users', 'telegram_id = ?', [101])).telegramId, 101);
  await f.session(101);
  const read = await f.call(101, 'profile');
  assert.equal(read.status, 200); assert.equal(read.data.access.planCode, 'free');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM entitlement_grants').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM entitlement_decision_audit').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM feature_flags').get().n, 0);
  assert.equal(f.sqlite.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('compiled foundation schema is deterministic and checks actual migration hashes', () => {
  for (const [name, digest] of Object.entries(FOUNDATION_SCHEMA.migrationSha256)) {
    assert.equal(hash(fs.readFileSync(new URL('../migrations/' + name, import.meta.url))), digest);
  }
  const check = runPublicPython(['scripts/v1.4.1-build-foundation-schema.py', '--check'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.ok(Object.isFrozen(FOUNDATION_SCHEMA.objects));
  assert.ok(Object.isFrozen(FOUNDATION_SCHEMA.columns.entitlement_grants));
});

for (const alteration of ['missing_trigger', 'missing_unique_index', 'changed_table_constraint', 'unexpected_new_trigger']) {
  test('foundation readiness rejects ' + alteration + ' even when all policy rows are unchanged', async t => {
    const f = setup(t);
    const before = f.sqlite.prepare('SELECT count(*) n FROM capability_catalog').get().n;
    if (alteration === 'missing_trigger') f.sqlite.exec('DROP TRIGGER v141_entitlement_grants_customer_capability');
    if (alteration === 'missing_unique_index') f.sqlite.exec('DROP INDEX idx_v141_override_unrevoked_scope');
    if (alteration === 'changed_table_constraint') {
      // Rebuild an empty fixture table with identical columns and weaker CHECK.
      // Policy rows and original table guards remain; readiness must reject it.
      const expected = FOUNDATION_SCHEMA.objects.filter(row => row.table_name === 'feature_flags');
      const table = expected.find(row => row.type === 'table');
      assert.ok(table.sql.includes('emergency_disabled IN (0,1)'));
      f.sqlite.exec('DROP TABLE feature_flags');
      f.sqlite.exec(table.sql.replace('emergency_disabled IN (0,1)', 'emergency_disabled IN (0,1,2)'));
      for (const row of expected) if (row.type !== 'table' && row.sql !== null) f.sqlite.exec(row.sql);
    }
    if (alteration === 'unexpected_new_trigger') f.sqlite.exec(
      "CREATE TRIGGER synthetic_unreviewed_grant_trigger BEFORE INSERT ON entitlement_grants BEGIN SELECT 1; END");
    const result = await createFoundationRepository(f.binding).inspectFoundation({ policyVersion });
    assert.equal(result.status, 'denied'); assert.equal(result.reasonCode, 'foundation_schema_inconsistent');
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM capability_catalog').get().n, before);
  });
}

test('foundation inspection is limited to the seven new tables and cannot bless changed old DDL', async t => {
  const f = setup(t);
  f.sqlite.exec('CREATE INDEX synthetic_old_schema_drift ON users(accepted_terms)');
  const result = await createFoundationRepository(f.binding).inspectFoundation({ policyVersion });
  assert.equal(result.status, 'ready');
  await assert.rejects(reviewedRepositoryFactory(f.env(101), { readOnly: true }).assertCandidateSchema(),
    { code: 'storage_unavailable' });
  assert.ok(f.binding.audit.filter(entry => entry.sql.includes('tbl_name IN')).some(entry =>
    entry.params.length === 7 && entry.params.every(name => FOUNDATION_TABLES.includes(name))));
});
