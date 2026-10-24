import {
  FOUNDATION_POLICY_VERSION, CAPABILITY_CATALOG, PLAN_CAPABILITIES,
} from './capability-policy.mjs';
import { FOUNDATION_SCHEMA } from './foundation-schema.mjs';
import { inspectP04Schema, P04_SCHEMA } from './privacy-schema.mjs';

// Part 2 reads foundation metadata only. No object returned here is an actor
// snapshot, entitlement decision, verified source proof, or rollout admission.
export const FOUNDATION_REPOSITORY_VERSION = '2026-10-02.v1.4.1.p02';
export const FOUNDATION_METADATA_ACTIVATION =
  'blocked_until_privacy_cleanup_and_verified_source_fencing';
export const FOUNDATION_TABLES = Object.freeze([
  'capability_catalog', 'plan_capabilities', 'entitlement_grants',
  'entitlement_overrides', 'entitlement_decision_audit', 'feature_flags',
  'feature_flag_assignments',
]);

const COLUMNS = Object.freeze({
  capability_catalog: Object.freeze(['policy_version', 'capability', 'actor_kind',
    'resource_scope', 'availability', 'future_release', 'quota_key',
    'definition_json', 'definition_sha256']),
  plan_capabilities: Object.freeze(['policy_version', 'capability', 'plan_code',
    'access_overlay', 'allowed', 'quota_key', 'limit_value', 'quota_unit',
    'quota_window', 'rule_json', 'definition_sha256']),
  entitlement_grants: Object.freeze(['grant_id', 'idempotency_key', 'policy_version',
    'capability', 'subject_telegram_id', 'scope_kind', 'scope_key', 'source_kind',
    'source_ref', 'source_revision', 'source_fingerprint', 'issued_by', 'reason',
    'starts_at', 'expires_at', 'revision', 'created_at', 'updated_at',
    'revoked_at', 'revoked_by', 'revocation_reason', 'retention_until']),
  entitlement_overrides: Object.freeze(['override_id', 'idempotency_key',
    'policy_version', 'capability', 'subject_telegram_id',
    'subject_source_fingerprint', 'scope_kind', 'scope_key', 'effect', 'limit_value',
    'issued_by', 'reason', 'starts_at', 'expires_at', 'revision', 'created_at',
    'updated_at', 'revoked_at', 'revoked_by', 'revocation_reason', 'retention_until']),
  entitlement_decision_audit: Object.freeze(['audit_id', 'event_key',
    'policy_version', 'capability', 'actor_kind', 'subject_telegram_id',
    'actor_telegram_id', 'resource_ref', 'decision', 'reason_code',
    'source_fingerprint', 'operation_ref', 'evaluated_at', 'valid_until',
    'retention_until']),
  feature_flags: Object.freeze(['flag_key', 'policy_version', 'enabled',
    'emergency_disabled', 'revision', 'rollout_json', 'updated_by', 'reason',
    'updated_at']),
  feature_flag_assignments: Object.freeze(['assignment_id', 'idempotency_key',
    'flag_key', 'subject_kind', 'subject_key', 'subject_telegram_id',
    'subject_source_fingerprint', 'assigned_by', 'reason', 'starts_at',
    'expires_at', 'revision', 'created_at', 'updated_at', 'revoked_at',
    'revoked_by', 'revocation_reason', 'retention_until']),
});
const MAX_METADATA_ROWS = 64;
const MAX_RESPONSE_BYTES = 8_388_608;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const HASH = /^[0-9a-f]{64}$/u;
const PLANS = new Set(['free', 'professional', 'dragon']);
const SCOPES = new Set(['actor', 'resource', 'tenant']);
const encoder = new TextEncoder();

export class FoundationRepositoryError extends Error {
  constructor(code) {
    super(code);
    this.name = 'FoundationRepositoryError';
    this.code = code;
  }
}
const fail = code => { throw new FoundationRepositoryError(code); };
const freeze = value => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};
const request = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key)) ||
      keys.some(key => !Object.hasOwn(value, key))) fail('invalid_foundation_request');
  return value;
};
const text = (value, max, { nullable = false, token = false } = {}) => {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || value.length < 1 || value.length > max ||
      /[\0\r\n]/u.test(value) || (token && !TOKEN.test(value))) {
    fail('invalid_foundation_request');
  }
  return value;
};
const positive = value => {
  if (!Number.isSafeInteger(value) || value < 1) fail('invalid_foundation_request');
  return value;
};
const jsonObject = value => {
  if (typeof value !== 'string' || !value.length || value.length > 16_384 ||
      /\0/u.test(value)) fail('foundation_policy_inconsistent');
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail('foundation_policy_inconsistent'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('foundation_policy_inconsistent');
  }
  return parsed;
};
const sameRow = (actual, expected, table) => COLUMNS[table].every(column =>
  Object.hasOwn(actual, column) && Object.hasOwn(expected, column) &&
  actual[column] === expected[column]);
const knownPolicy = policyVersion => policyVersion === FOUNDATION_POLICY_VERSION;
const unavailablePolicy = (policyVersion, reasonCode) => freeze({
  status: 'denied', metadataOnly: true, policyVersion, reasonCode,
  activation: FOUNDATION_METADATA_ACTIVATION,
});
const validateSeedInterface = () => {
  if (FOUNDATION_SCHEMA.version !== 1 ||
      FOUNDATION_SCHEMA.tables.join('\0') !== FOUNDATION_TABLES.join('\0') ||
      FOUNDATION_SCHEMA.objects.length > 128 ||
      FOUNDATION_TABLES.some(table => COLUMNS[table].some(column =>
        !FOUNDATION_SCHEMA.columns[table]?.includes(column))) ||
      CAPABILITY_CATALOG.length !== 104 || PLAN_CAPABILITIES.length !== 416 ||
      new Set(CAPABILITY_CATALOG.map(row => row.capability)).size !== 104 ||
      CAPABILITY_CATALOG.some(row => row.policy_version !== FOUNDATION_POLICY_VERSION) ||
      PLAN_CAPABILITIES.some(row => row.policy_version !== FOUNDATION_POLICY_VERSION)) {
    fail('foundation_policy_inconsistent');
  }
};

export function createFoundationRepository(binding, { queryLimit = 32 } = {}) {
  if (!binding?.withSession || !Number.isSafeInteger(queryLimit) ||
      queryLimit < 1 || queryLimit > 50) fail('foundation_unavailable');
  validateSeedInterface();
  let db;
  try { db = binding.withSession('first-primary'); } catch { fail('foundation_unavailable'); }
  if (typeof db?.prepare !== 'function') fail('foundation_unavailable');
  // Every counter and every read lives in this repository instance. Construct
  // one per request; do not share it across actors or concurrent requests.
  let queryCount = 0;
  let responseBytes = 0;
  const rows = async (sql, params = [], maxRows = MAX_METADATA_ROWS) => {
    if (++queryCount > queryLimit) fail('foundation_query_budget_exhausted');
    if (params.length > 100 || !/^(?:SELECT |PRAGMA table_info\()/u.test(sql)) {
      fail('foundation_unavailable');
    }
    let result;
    try { result = await db.prepare(sql).bind(...params).all(); }
    catch { fail('foundation_unavailable'); }
    if (result?.success !== true || !Array.isArray(result.results)) {
      fail('foundation_unavailable');
    }
    if (result.results.length > maxRows) fail('foundation_metadata_overflow');
    for (const row of result.results) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) fail('foundation_unavailable');
      let serialized;
      try { serialized = JSON.stringify(row); } catch { fail('foundation_unavailable'); }
      responseBytes += encoder.encode(serialized).length;
      if (responseBytes > MAX_RESPONSE_BYTES) fail('foundation_metadata_overflow');
    }
    return result.results;
  };
  const catalogMetadata = async (policyVersion, capability) => {
    const expected = CAPABILITY_CATALOG.find(row => row.capability === capability);
    if (!expected) return unavailablePolicy(policyVersion, 'unknown_capability');
    const result = await rows(`SELECT ${COLUMNS.capability_catalog.join(', ')}
      FROM capability_catalog WHERE policy_version = ? AND capability = ? LIMIT 2`,
    [policyVersion, capability], 1);
    if (result.length !== 1 || !sameRow(result[0], expected, 'capability_catalog')) {
      return unavailablePolicy(policyVersion, 'foundation_policy_inconsistent');
    }
    return freeze({ status: 'policy_metadata', metadataOnly: true,
      activation: FOUNDATION_METADATA_ACTIVATION, catalog: { ...result[0] } });
  };
  const validatePersonalRows = (result, kind) => {
    for (const row of result) {
      for (const key of COLUMNS[kind]) {
        if (!Object.hasOwn(row, key)) fail('foundation_policy_inconsistent');
      }
      if (!HASH.test(kind === 'entitlement_grants' ? row.source_fingerprint :
          row.subject_source_fingerprint) || !Number.isSafeInteger(row.revision) || row.revision < 1) {
        fail('foundation_policy_inconsistent');
      }
    }
    return result.map(row => ({ ...row }));
  };
  return Object.freeze({
    version: FOUNDATION_REPOSITORY_VERSION,
    metadataOnly: true,
    async inspectFoundation(input) {
      const { policyVersion } = request(input, ['policyVersion']);
      text(policyVersion, 128, { token: true });
      if (!knownPolicy(policyVersion)) return unavailablePolicy(policyVersion, 'unknown_policy');
      const p04Ledger=await rows('SELECT version FROM re_schema_migrations WHERE version=?',
        [P04_SCHEMA.ledgerVersion],1);
      let approvedSchema=FOUNDATION_SCHEMA;
      if(p04Ledger.length) {
        try { await inspectP04Schema(db); } catch { return unavailablePolicy(policyVersion,'foundation_schema_inconsistent'); }
        approvedSchema={...P04_SCHEMA,objects:P04_SCHEMA.objects.filter(row=>FOUNDATION_TABLES.includes(row.table_name))};
      }
      // Exact new-table DDL includes constraints, indexes (also implicit
      // sql=NULL indexes), and triggers. Old-table manifests remain separate.
      const maxSchemaRows = approvedSchema.objects.length + 1;
      const objects = await rows(`SELECT name, type, tbl_name AS table_name, sql
        FROM sqlite_schema WHERE tbl_name IN (${FOUNDATION_TABLES.map(() => '?').join(', ')})
        ORDER BY type, name LIMIT ${maxSchemaRows}`, [...FOUNDATION_TABLES], maxSchemaRows);
      if (objects.length !== approvedSchema.objects.length ||
          objects.some((row, index) => ['name', 'type', 'table_name', 'sql'].some(key =>
            !Object.hasOwn(row, key) || row[key] !== approvedSchema.objects[index][key]))) {
        return unavailablePolicy(policyVersion, 'foundation_schema_inconsistent');
      }
      const catalog = await rows(`SELECT ${COLUMNS.capability_catalog.join(', ')}
        FROM capability_catalog WHERE policy_version = ? ORDER BY capability LIMIT 105`,
      [policyVersion], 104);
      const plans = await rows(`SELECT ${COLUMNS.plan_capabilities.join(', ')}
        FROM plan_capabilities WHERE policy_version = ?
        ORDER BY capability, plan_code, access_overlay LIMIT 417`, [policyVersion], 416);
      const expectedCatalog = new Map(CAPABILITY_CATALOG.map(row => [row.capability, row]));
      const expectedPlans = new Map(PLAN_CAPABILITIES.map(row =>
        [[row.capability, row.plan_code, row.access_overlay].join('\0'), row]));
      if (catalog.length !== 104 || plans.length !== 416 ||
          catalog.some(row => !sameRow(row, expectedCatalog.get(row.capability) ?? {}, 'capability_catalog')) ||
          plans.some(row => !sameRow(row, expectedPlans.get(
            [row.capability, row.plan_code, row.access_overlay].join('\0')) ?? {}, 'plan_capabilities'))) {
        return unavailablePolicy(policyVersion, 'foundation_policy_inconsistent');
      }
      return freeze({ status: 'ready', metadataOnly: true, policyVersion,
        capabilityCount: catalog.length, planPolicyCount: plans.length,
        tables: [...FOUNDATION_TABLES], schemaObjectCount: objects.length,
        schemaSha256: approvedSchema.schemaSha256,
        activation: FOUNDATION_METADATA_ACTIVATION });
    },
    async readCapabilityPolicy(input) {
      const { policyVersion, capability, planCode, accessOverlay } = request(input,
        ['policyVersion', 'capability', 'planCode', 'accessOverlay']);
      text(policyVersion, 128, { token: true }); text(capability, 128, { token: true });
      if (!PLANS.has(planCode) || !['none', 'dragon_preview'].includes(accessOverlay) ||
          (accessOverlay === 'dragon_preview' && planCode !== 'free')) fail('invalid_foundation_request');
      if (!knownPolicy(policyVersion)) return unavailablePolicy(policyVersion, 'unknown_policy');
      const found = await catalogMetadata(policyVersion, capability);
      if (found.status !== 'policy_metadata') return found;
      const expected = PLAN_CAPABILITIES.find(row => row.capability === capability &&
        row.plan_code === planCode && row.access_overlay === accessOverlay);
      const rules = await rows(`SELECT ${COLUMNS.plan_capabilities.join(', ')}
        FROM plan_capabilities WHERE policy_version = ? AND capability = ?
          AND plan_code = ? AND access_overlay = ? LIMIT 2`,
      [policyVersion, capability, planCode, accessOverlay], 1);
      if (!expected || rules.length !== 1 || !sameRow(rules[0], expected, 'plan_capabilities')) {
        return unavailablePolicy(policyVersion, 'foundation_policy_inconsistent');
      }
      return freeze({ ...found, planRule: { ...rules[0] } });
    },
    async readSubjectMetadata(input) {
      const { policyVersion, capability, subjectTelegramId, scopeKind, scopeKey,
        nowSeconds } = request(input, ['policyVersion', 'capability',
        'subjectTelegramId', 'scopeKind', 'scopeKey', 'nowSeconds']);
      text(policyVersion, 128, { token: true }); text(capability, 128, { token: true });
      positive(subjectTelegramId); positive(nowSeconds); text(scopeKey, 192);
      if (!SCOPES.has(scopeKind)) fail('invalid_foundation_request');
      if (!knownPolicy(policyVersion)) return unavailablePolicy(policyVersion, 'unknown_policy');
      const found = await catalogMetadata(policyVersion, capability);
      if (found.status !== 'policy_metadata') return found;
      if (found.catalog.actor_kind !== 'customer' || found.catalog.availability === 'future_disabled') {
        return unavailablePolicy(policyVersion, 'subject_metadata_not_applicable');
      }
      const params = [policyVersion, capability, subjectTelegramId, scopeKind,
        scopeKey, nowSeconds, nowSeconds];
      const grants = await rows(`SELECT ${COLUMNS.entitlement_grants.join(', ')}
        FROM entitlement_grants WHERE policy_version = ? AND capability = ?
          AND subject_telegram_id = ? AND scope_kind = ? AND scope_key = ?
          AND starts_at <= ? AND expires_at > ? AND revoked_at IS NULL
        ORDER BY grant_id LIMIT 65`, params);
      const overrides = await rows(`SELECT ${COLUMNS.entitlement_overrides.join(', ')}
        FROM entitlement_overrides WHERE policy_version = ? AND capability = ?
          AND subject_telegram_id = ? AND scope_kind = ? AND scope_key = ?
          AND starts_at <= ? AND expires_at > ? AND revoked_at IS NULL
        ORDER BY override_id LIMIT 2`, params, 1);
      return freeze({ status: 'subject_metadata', metadataOnly: true, policyVersion,
        capability, activation: FOUNDATION_METADATA_ACTIVATION,
        sourceProofVerified: false, grants: validatePersonalRows(grants, 'entitlement_grants'),
        overrides: validatePersonalRows(overrides, 'entitlement_overrides') });
    },
    async readFeatureFlagMetadata(input) {
      const { policyVersion, flagKey, subjectTelegramId, subjectKey, nowSeconds } =
        request(input, ['policyVersion', 'flagKey', 'subjectTelegramId', 'subjectKey', 'nowSeconds']);
      text(policyVersion, 128, { token: true }); text(flagKey, 128, { token: true });
      positive(subjectTelegramId); text(subjectKey, 192); positive(nowSeconds);
      if (!knownPolicy(policyVersion)) return unavailablePolicy(policyVersion, 'unknown_policy');
      const flags = await rows(`SELECT ${COLUMNS.feature_flags.join(', ')}
        FROM feature_flags WHERE policy_version = ? AND flag_key = ? LIMIT 2`,
      [policyVersion, flagKey], 1);
      if (!flags.length) return freeze({ status: 'flag_metadata', metadataOnly: true,
        policyVersion, activation: FOUNDATION_METADATA_ACTIVATION, flag: null,
        assignments: [], sourceProofVerified: false });
      const flag = flags[0];
      jsonObject(flag.rollout_json);
      if (![0, 1].includes(flag.enabled) || ![0, 1].includes(flag.emergency_disabled) ||
          !Number.isSafeInteger(flag.revision) || flag.revision < 1) fail('foundation_policy_inconsistent');
      const assignments = await rows(`SELECT ${COLUMNS.feature_flag_assignments.join(', ')}
        FROM feature_flag_assignments WHERE flag_key = ? AND subject_kind = 'actor'
          AND subject_telegram_id = ? AND subject_key = ?
          AND starts_at <= ? AND expires_at > ? AND revoked_at IS NULL
        ORDER BY assignment_id LIMIT 2`, [flagKey, subjectTelegramId, subjectKey,
        nowSeconds, nowSeconds], 1);
      return freeze({ status: 'flag_metadata', metadataOnly: true, policyVersion,
        activation: FOUNDATION_METADATA_ACTIVATION, sourceProofVerified: false,
        flag: { ...flag }, assignments: validatePersonalRows(assignments, 'feature_flag_assignments') });
    },
  });
}
