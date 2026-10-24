import { readAnalyticsV2Config } from "./analytics-foundation.mjs";
import {
  ANALYTICS_V2_INGESTION_MAX_ROWS,
  ANALYTICS_V2_INGESTION_SOURCE_KINDS,
  ingestAnalyticsBatch,
} from "./analytics-ingestion.mjs";
import {
  readAnalyticsProjectionConfig,
  rebuildAnalyticsProjections,
} from "./metric-projections.mjs";

const DAY = 86_400;
const TEXT_ENCODER = new TextEncoder();
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const ANALYTICS_V2_RELEASE_POLICY_VERSION =
  "2026-09-13.analytics-v2-part6";
export const ANALYTICS_V2_RELEASE_ACTIONS = Object.freeze([
  "audit",
  "prepare_closed",
  "enable_admin_shadow",
  "disable",
]);
export const ANALYTICS_V2_RELEASE_SOURCE_MODES = Object.freeze([
  "none",
  "synthetic",
  "readonly_backfill",
]);
export const ANALYTICS_V2_RELEASE_SOURCE_ORDER = Object.freeze([
  ...ANALYTICS_V2_INGESTION_SOURCE_KINDS,
]);

const STAGE_ORDER = Object.freeze({
  backup: 1,
  restore: 2,
  schema: 3,
  source_snapshot: 4,
  ingestion: 5,
  projection: 6,
  reconciliation: 7,
  runtime_regression: 8,
  disable: 9,
});
const CONFIRMATIONS = Object.freeze({
  audit: "",
  prepare_closed: "PREPARE CLOSED ANALYTICS 1.3.9",
  enable_admin_shadow: "ENABLE ADMIN SHADOW ANALYTICS 1.3.9",
  disable: "DISABLE ANALYTICS 1.3.9",
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      canonicalize(value[key]),
    ]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function bytesToHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto is required");
  const bytes = TEXT_ENCODER.encode(
    typeof value === "string" ? value : canonicalJson(value),
  );
  return bytesToHex(await cryptoImpl.subtle.digest("SHA-256", bytes));
}

async function hmacHex(secret, value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto is required");
  const normalized = text(secret, "release digest secret", 32, 512);
  const key = await cryptoImpl.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(normalized),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(await cryptoImpl.subtle.sign(
    "HMAC",
    key,
    TEXT_ENCODER.encode(typeof value === "string" ? value : canonicalJson(value)),
  ));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function exactKeys(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) throw new TypeError(`${name} fields are not exact`);
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function text(value, name, minimum = 1, maximum = 160) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function hash(value, name) {
  const normalized = text(value, name, 64, 64).toLowerCase();
  if (!HASH_PATTERN.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function commitSha(value) {
  const normalized = text(value, "release commit SHA", 40, 40).toLowerCase();
  if (!COMMIT_PATTERN.test(normalized)) throw new TypeError("release commit SHA is invalid");
  return normalized;
}

function uuid(value, name = "release run id") {
  const normalized = text(value, name, 36, 36).toLowerCase();
  if (!UUID_V4_PATTERN.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function action(value) {
  const normalized = text(value, "analytics release action", 5, 32).toLowerCase();
  if (!ANALYTICS_V2_RELEASE_ACTIONS.includes(normalized)) {
    throw new TypeError("analytics release action is not allowlisted");
  }
  return normalized;
}

function sourceMode(value) {
  const normalized = text(value, "analytics release source mode", 4, 32)
    .toLowerCase();
  if (!ANALYTICS_V2_RELEASE_SOURCE_MODES.includes(normalized)) {
    throw new TypeError("analytics release source mode is not allowlisted");
  }
  return normalized;
}

function changed(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

function normalizeSettings(settings) {
  exactKeys(settings, new Set([
    "ambassador_enabled", "event_registry_version", "id", "ingest_enabled",
    "master_enabled", "metric_dictionary_version", "projections_enabled",
    "pseudonym_key_version", "raw_retention_days", "revision", "rollout_mode",
    "small_segment_threshold",
  ]), "analytics database settings");
  return settings;
}

function flagsForDigest(config) {
  return Object.freeze({
    ambassadorEnabled: config.ambassadorEnabled,
    configurationValid: config.configurationValid,
    ingestEnabled: config.ingestEnabled,
    masterEnabled: config.masterEnabled,
    projectionsEnabled: config.projectionsEnabled,
    rolloutMode: config.rolloutMode,
  });
}

export function requiredAnalyticsReleaseConfirmation(requestedAction) {
  return CONFIRMATIONS[action(requestedAction)];
}

export function validateAnalyticsReleaseConfirmation(requestedAction, confirmation) {
  const normalizedAction = action(requestedAction);
  const expected = CONFIRMATIONS[normalizedAction];
  if (String(confirmation || "") !== expected) {
    throw new Error(expected
      ? `Confirmation must be exactly: ${expected}`
      : "Audit must not carry a confirmation phrase");
  }
  return normalizedAction;
}

export function describeAnalyticsReleaseAction(requestedAction) {
  const normalized = action(requestedAction);
  const descriptions = {
    audit: {
      databaseMutation: false,
      workerDeployment: false,
      sourceRead: false,
      rollout: "off",
      result: "read_only_validation",
    },
    prepare_closed: {
      databaseMutation: true,
      workerDeployment: false,
      sourceRead: false,
      rollout: "off",
      result: "additive_schema_backup_restore_only",
    },
    enable_admin_shadow: {
      databaseMutation: true,
      workerDeployment: false,
      sourceRead: true,
      rollout: "admin_shadow",
      result: "closed_shadow_rehearsal_only",
    },
    disable: {
      databaseMutation: true,
      workerDeployment: false,
      sourceRead: false,
      rollout: "off",
      result: "all_v139_flags_closed",
    },
  };
  return deepFreeze({ action: normalized, ...descriptions[normalized] });
}

export function readAnalyticsReleaseConfig(env = {}) {
  const base = readAnalyticsV2Config(env);
  const projection = readAnalyticsProjectionConfig(env);
  return Object.freeze({
    ...base,
    projectionEnabled: projection.projectionEnabled,
    releasePolicyVersion: ANALYTICS_V2_RELEASE_POLICY_VERSION,
  });
}

export function assertAnalyticsReleaseGate({
  action: requestedAction,
  config,
  databaseSettings,
  requestedScope,
  actorTelegramId,
  configuredAdminId,
} = {}) {
  const normalizedAction = action(requestedAction);
  normalizeSettings(databaseSettings);
  const actor = integer(actorTelegramId, "release actor Telegram ID", 1);
  const admin = integer(configuredAdminId, "configured admin Telegram ID", 1);
  if (actor !== admin) throw new Error("analytics release is restricted to the configured admin");
  if (!config?.configurationValid || config.configurationProblems?.length !== 0) {
    throw new Error("analytics release configuration is invalid");
  }
  if (requestedScope !== "admin_shadow") {
    throw new Error("analytics release scope must be admin_shadow");
  }
  const databaseEnabled = databaseSettings.id === 1 &&
    databaseSettings.rollout_mode === "admin_shadow" &&
    databaseSettings.master_enabled === 1 &&
    databaseSettings.ingest_enabled === 1 &&
    databaseSettings.projections_enabled === 1 &&
    databaseSettings.ambassador_enabled === Number(config.ambassadorEnabled);
  const databaseClosed = databaseSettings.id === 1 &&
    databaseSettings.rollout_mode === "off" &&
    databaseSettings.master_enabled === 0 &&
    databaseSettings.ingest_enabled === 0 &&
    databaseSettings.projections_enabled === 0 &&
    databaseSettings.ambassador_enabled === 0;
  const schemaAligned = databaseSettings.event_registry_version ===
      config.eventRegistryVersion &&
    databaseSettings.metric_dictionary_version === config.metricDictionaryVersion &&
    databaseSettings.pseudonym_key_version === config.pseudonymKeyVersion &&
    databaseSettings.raw_retention_days === config.rawRetentionDays &&
    databaseSettings.small_segment_threshold === config.smallSegmentThreshold;
  if (!schemaAligned) throw new Error("analytics release environment and D1 schema disagree");

  if (normalizedAction === "enable_admin_shadow") {
    if (
      config.rolloutMode !== "admin_shadow" || !config.masterEnabled ||
      !config.ingestEnabled || !config.projectionsEnabled || !databaseEnabled
    ) throw new Error("analytics admin shadow gate is closed");
  } else if (normalizedAction === "prepare_closed" || normalizedAction === "audit") {
    if (
      config.rolloutMode !== "off" || config.masterEnabled || config.ingestEnabled ||
      config.projectionsEnabled || config.ambassadorEnabled || !databaseClosed
    ) throw new Error("analytics closed preparation requires every flag off");
  } else if (!(databaseClosed || databaseEnabled)) {
    throw new Error("analytics disable gate cannot identify the current state");
  }
  return Object.freeze({
    action: normalizedAction,
    adminOnly: true,
    publicAction: false,
    databaseState: databaseEnabled ? "admin_shadow" : "off",
    requestedScope: "admin_shadow",
  });
}

export async function createControlledSourceSnapshot({
  sourceKind,
  sourceMode: requestedSourceMode,
  highWatermarkAt,
  sourceRevision,
  records,
  digestSecret,
  cryptoImpl = globalThis.crypto,
} = {}) {
  const kind = text(sourceKind, "analytics source kind", 3, 40).toLowerCase();
  if (!ANALYTICS_V2_RELEASE_SOURCE_ORDER.includes(kind)) {
    throw new TypeError("analytics source kind is not allowlisted");
  }
  const mode = sourceMode(requestedSourceMode);
  if (mode === "none") throw new TypeError("a source snapshot cannot use none mode");
  const watermark = integer(highWatermarkAt, "source high watermark", 1);
  const revision = integer(sourceRevision, "source snapshot revision", 1);
  if (!Array.isArray(records) || records.length > ANALYTICS_V2_INGESTION_MAX_ROWS) {
    throw new RangeError("source snapshot exceeds its bounded 100-row limit");
  }
  const frozenRecords = deepFreeze(clone(records));
  const inputDigest = await hmacHex(digestSecret, {
    highWatermarkAt: watermark,
    records: frozenRecords,
    sourceKind: kind,
    sourceMode: mode,
    sourceRevision: revision,
  }, cryptoImpl);
  const descriptor = deepFreeze({
    sourceKind: kind,
    sourceMode: mode,
    sourceRevision: revision,
    highWatermarkAt: watermark,
    rowsSelected: frozenRecords.length,
    inputDigest,
  });
  return Object.freeze({
    ...descriptor,
    async readBatch({ requestedHighWatermarkAt, limit } = {}) {
      if (requestedHighWatermarkAt !== watermark) {
        throw new Error("source high watermark changed after planning");
      }
      integer(limit, "source read limit", 1, ANALYTICS_V2_INGESTION_MAX_ROWS);
      if (limit < frozenRecords.length) {
        throw new RangeError("source read limit cannot truncate a frozen snapshot");
      }
      return deepFreeze({
        descriptor,
        records: clone(frozenRecords),
        readOnly: true,
      });
    },
  });
}

function validateSourceSnapshots(sourceSnapshots, mode, watermark) {
  if (!Array.isArray(sourceSnapshots) || sourceSnapshots.length < 1 ||
      sourceSnapshots.length > ANALYTICS_V2_RELEASE_SOURCE_ORDER.length) {
    throw new TypeError("release plan requires one to eleven source snapshots");
  }
  const uniqueKinds = new Set();
  let previousOrder = -1;
  for (const snapshot of sourceSnapshots) {
    const order = ANALYTICS_V2_RELEASE_SOURCE_ORDER.indexOf(snapshot?.sourceKind);
    if (order < 0 || uniqueKinds.has(snapshot.sourceKind) || order <= previousOrder) {
      throw new TypeError("source snapshots must be unique and in fixed authority order");
    }
    if (
      snapshot.sourceMode !== mode || snapshot.highWatermarkAt !== watermark ||
      !HASH_PATTERN.test(snapshot.inputDigest || "") ||
      !Number.isSafeInteger(snapshot.rowsSelected) || snapshot.rowsSelected < 0 ||
      snapshot.rowsSelected > ANALYTICS_V2_INGESTION_MAX_ROWS ||
      typeof snapshot.readBatch !== "function"
    ) throw new TypeError("source snapshot descriptor is invalid");
    uniqueKinds.add(snapshot.sourceKind);
    previousOrder = order;
  }
}

export async function buildAnalyticsReleasePlan({
  runId,
  action: requestedAction,
  sourceMode: requestedSourceMode,
  sourceSnapshots = [],
  config,
  requestedByHash,
  commitSha: requestedCommitSha,
  manifestDigest,
  highWatermarkAt,
  createdAt,
  retentionDays = 180,
  cryptoImpl = globalThis.crypto,
} = {}) {
  const normalizedAction = action(requestedAction);
  if (normalizedAction === "audit") throw new TypeError("audit does not create a release run");
  const mode = sourceMode(requestedSourceMode);
  const watermark = integer(highWatermarkAt, "release high watermark", 1);
  const created = integer(createdAt, "release created at", watermark);
  const retention = integer(retentionDays, "release retention days", 1, 180);
  if (normalizedAction === "enable_admin_shadow") {
    if (mode === "none") throw new TypeError("admin shadow requires a source mode");
    validateSourceSnapshots(sourceSnapshots, mode, watermark);
  } else if (mode !== "none" || sourceSnapshots.length !== 0) {
    throw new TypeError("closed release actions cannot read source rows");
  }
  const normalizedRunId = uuid(runId);
  const normalizedActorHash = hash(requestedByHash, "release actor hash");
  const normalizedCommit = commitSha(requestedCommitSha);
  const normalizedManifest = hash(manifestDigest, "release manifest digest");
  const flagsDigest = await sha256Hex(flagsForDigest(config), cryptoImpl);
  const sourceDescriptors = sourceSnapshots.map((snapshot) => ({
    highWatermarkAt: snapshot.highWatermarkAt,
    inputDigest: snapshot.inputDigest,
    rowsSelected: snapshot.rowsSelected,
    sourceKind: snapshot.sourceKind,
    sourceMode: snapshot.sourceMode,
    sourceRevision: snapshot.sourceRevision,
  }));
  const planDigest = await sha256Hex({
    action: normalizedAction,
    commitSha: normalizedCommit,
    flagsDigest,
    highWatermarkAt: watermark,
    manifestDigest: normalizedManifest,
    policyVersion: ANALYTICS_V2_RELEASE_POLICY_VERSION,
    requestedByHash: normalizedActorHash,
    runId: normalizedRunId,
    sourceDescriptors,
    sourceMode: mode,
  }, cryptoImpl);
  const row = deepFreeze({
    run_id: normalizedRunId,
    action: normalizedAction,
    source_mode: mode,
    requested_by_hash: normalizedActorHash,
    commit_sha: normalizedCommit,
    manifest_digest: normalizedManifest,
    flags_digest: flagsDigest,
    high_watermark_at: watermark,
    expected_source_count: sourceSnapshots.length,
    plan_digest: planDigest,
    created_at: created,
    retention_until: created + retention * DAY,
    policy_version: ANALYTICS_V2_RELEASE_POLICY_VERSION,
  });
  return Object.freeze({
    row,
    sourceDescriptors: deepFreeze(sourceDescriptors),
    sourceSnapshots: Object.freeze([...sourceSnapshots]),
  });
}

function assertPlan(plan) {
  if (!plan?.row || !Array.isArray(plan.sourceDescriptors) ||
      !Array.isArray(plan.sourceSnapshots)) {
    throw new TypeError("analytics release plan is invalid");
  }
  uuid(plan.row.run_id);
  hash(plan.row.plan_digest, "release plan digest");
  if (plan.row.policy_version !== ANALYTICS_V2_RELEASE_POLICY_VERSION) {
    throw new Error("analytics release plan policy changed");
  }
  if (plan.sourceDescriptors.length !== plan.row.expected_source_count ||
      plan.sourceSnapshots.length !== plan.row.expected_source_count) {
    throw new Error("analytics release plan source count changed");
  }
  return plan;
}

function sourceEvidenceRow(plan, descriptor, result, recordedAt, evidenceDigest) {
  const counts = result.counts;
  const blocked = result.status !== "complete" || counts.rows_conflict !== 0 ||
    counts.rows_unmapped !== 0 || counts.rows_invalid !== 0 ||
    counts.rows_ambiguous !== 0 || !result.reconciliation.exact;
  return Object.freeze({
    run_id: plan.row.run_id,
    source_kind: descriptor.sourceKind,
    source_order: ANALYTICS_V2_RELEASE_SOURCE_ORDER.indexOf(descriptor.sourceKind) + 1,
    high_watermark_at: descriptor.highWatermarkAt,
    ...counts,
    rows_accounted: result.reconciliation.rowsAccounted,
    canonical_expected: counts.rows_inserted + counts.rows_duplicate,
    outcome: blocked ? "blocked" : "complete",
    input_digest: result.receipt.inputDigest,
    result_digest: result.receipt.resultDigest,
    evidence_digest: evidenceDigest,
    recorded_at: recordedAt,
    retention_until: plan.row.retention_until,
    policy_version: ANALYTICS_V2_RELEASE_POLICY_VERSION,
  });
}

function stageRow(plan, stageKind, {
  outcome = "passed",
  reasonCode = "none",
  observedCount = 0,
  expectedCount = observedCount,
  unexplainedDelta = observedCount - expectedCount,
  evidenceDigest,
  recordedAt,
}) {
  return Object.freeze({
    run_id: plan.row.run_id,
    stage_order: STAGE_ORDER[stageKind],
    stage_kind: stageKind,
    outcome,
    reason_code: reasonCode,
    observed_count: integer(observedCount, `${stageKind} observed count`, 0),
    expected_count: integer(expectedCount, `${stageKind} expected count`, 0),
    unexplained_delta: integer(
      unexplainedDelta,
      `${stageKind} unexplained delta`,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ),
    evidence_digest: hash(evidenceDigest, `${stageKind} evidence digest`),
    recorded_at: integer(recordedAt, `${stageKind} recorded at`, plan.row.created_at),
    retention_until: plan.row.retention_until,
    policy_version: ANALYTICS_V2_RELEASE_POLICY_VERSION,
  });
}

async function recordPreflight(plan, releaseStore, preflight, recordedAt) {
  exactKeys(preflight, new Set([
    "backupDigest", "restoreDigest", "restoreIntegrity", "schemaDigest",
    "schemaIntegrity", "runtimeDigest", "runtimeRegression",
  ]), "analytics release preflight");
  await releaseStore.writeStageEvidence(stageRow(plan, "backup", {
    evidenceDigest: preflight.backupDigest,
    recordedAt,
  }));
  const restorePassed = preflight.restoreIntegrity === true;
  await releaseStore.writeStageEvidence(stageRow(plan, "restore", {
    outcome: restorePassed ? "passed" : "blocked",
    reasonCode: restorePassed ? "none" : "restore_failed",
    observedCount: Number(restorePassed),
    expectedCount: 1,
    unexplainedDelta: Number(restorePassed) - 1,
    evidenceDigest: preflight.restoreDigest,
    recordedAt,
  }));
  if (!restorePassed) throw new Error("analytics release restore rehearsal failed");
  const schemaPassed = preflight.schemaIntegrity === true;
  await releaseStore.writeStageEvidence(stageRow(plan, "schema", {
    outcome: schemaPassed ? "passed" : "blocked",
    reasonCode: schemaPassed ? "none" : "schema_mismatch",
    observedCount: Number(schemaPassed),
    expectedCount: 1,
    unexplainedDelta: Number(schemaPassed) - 1,
    evidenceDigest: preflight.schemaDigest,
    recordedAt,
  }));
  if (!schemaPassed) throw new Error("analytics release schema audit failed");
}

async function aggregateEvidenceDigest(rows, cryptoImpl) {
  return sha256Hex(rows.map((row) => ({
    canonicalExpected: row.canonical_expected,
    evidenceDigest: row.evidence_digest,
    outcome: row.outcome,
    rowsAccounted: row.rows_accounted,
    rowsSeen: row.rows_seen,
    sourceKind: row.source_kind,
  })), cryptoImpl);
}

export async function runAnalyticsShadowRehearsal({
  plan,
  config,
  databaseSettings,
  requestedScope = "admin_shadow",
  actorTelegramId,
  configuredAdminId,
  ingestionStore,
  projectionStore,
  releaseStore,
  pseudonymSecret,
  projectionInputFactory,
  preflight,
  recordedAt,
  stopAfterSources = Number.MAX_SAFE_INTEGER,
  idFactory = () => globalThis.crypto.randomUUID(),
  cryptoImpl = globalThis.crypto,
} = {}) {
  assertPlan(plan);
  assertAnalyticsReleaseGate({
    action: plan.row.action,
    config,
    databaseSettings,
    requestedScope,
    actorTelegramId,
    configuredAdminId,
  });
  if (plan.row.action !== "enable_admin_shadow") {
    throw new Error("shadow rehearsal requires enable_admin_shadow action");
  }
  if (!releaseStore?.createRun || !releaseStore?.listSourceEvidence ||
      !releaseStore?.writeSourceEvidence || !releaseStore?.writeStageEvidence ||
      !releaseStore?.listStageEvidence) {
    throw new TypeError("analytics release evidence store is incomplete");
  }
  if (typeof projectionInputFactory !== "function") {
    throw new TypeError("projection input factory is required");
  }
  const timestamp = integer(recordedAt, "release evidence time", plan.row.created_at);
  // Stage rows are keyed by the immutable plan timestamp so a stopped run can
  // be resumed later without rewriting evidence or inventing a second stage.
  const stageRecordedAt = plan.row.created_at;
  integer(stopAfterSources, "release source stop limit", 0);
  await releaseStore.createRun(plan.row);
  await recordPreflight(plan, releaseStore, preflight, stageRecordedAt);

  let evidence = await releaseStore.listSourceEvidence(plan.row.run_id);
  const completedKinds = new Set(evidence
    .filter((row) => row.outcome === "complete")
    .map((row) => row.source_kind));
  if (evidence.some((row) => row.outcome !== "complete")) {
    throw new Error("analytics release contains blocked source evidence");
  }
  let processed = 0;
  for (let index = 0; index < plan.sourceSnapshots.length; index += 1) {
    const snapshot = plan.sourceSnapshots[index];
    const descriptor = plan.sourceDescriptors[index];
    if (completedKinds.has(descriptor.sourceKind)) continue;
    if (processed >= stopAfterSources) {
      return Object.freeze({
        status: "paused",
        runId: plan.row.run_id,
        sourcesComplete: completedKinds.size,
        sourcesExpected: plan.row.expected_source_count,
      });
    }
    const batch = await snapshot.readBatch({
      requestedHighWatermarkAt: plan.row.high_watermark_at,
      limit: ANALYTICS_V2_INGESTION_MAX_ROWS,
    });
    if (
      batch.readOnly !== true || batch.descriptor.inputDigest !== descriptor.inputDigest ||
      batch.descriptor.sourceRevision !== descriptor.sourceRevision ||
      batch.records.length !== descriptor.rowsSelected
    ) throw new Error("analytics source snapshot changed after plan creation");
    const freshDigest = await hmacHex(pseudonymSecret, {
      highWatermarkAt: descriptor.highWatermarkAt,
      records: batch.records,
      sourceKind: descriptor.sourceKind,
      sourceMode: descriptor.sourceMode,
      sourceRevision: descriptor.sourceRevision,
    }, cryptoImpl);
    if (freshDigest !== descriptor.inputDigest) {
      throw new Error("analytics source snapshot digest changed");
    }
    const result = await ingestAnalyticsBatch({
      config,
      store: ingestionStore,
      sourceKind: descriptor.sourceKind,
      records: batch.records,
      origin: "backfill",
      highWatermarkAt: plan.row.high_watermark_at,
      pseudonymSecret,
      pseudonymKeyVersion: config.pseudonymKeyVersion,
      retentionDays: config.rawRetentionDays,
      startedAt: timestamp,
      finishedAt: timestamp,
      idFactory: (kind, itemIndex) => idFactory(
        `${descriptor.sourceKind}:${kind}`,
        itemIndex,
      ),
      cryptoImpl,
    });
    const evidenceDigest = await sha256Hex({
      inputDigest: result.receipt.inputDigest,
      policyVersion: ANALYTICS_V2_RELEASE_POLICY_VERSION,
      reconciliation: result.reconciliation,
      resultDigest: result.receipt.resultDigest,
      sourceKind: descriptor.sourceKind,
    }, cryptoImpl);
    const row = sourceEvidenceRow(plan, descriptor, result, timestamp, evidenceDigest);
    await releaseStore.writeSourceEvidence(row);
    processed += 1;
    if (row.outcome !== "complete") {
      await releaseStore.writeStageEvidence(stageRow(plan, "ingestion", {
        outcome: "blocked",
        reasonCode: "source_partial",
        observedCount: row.rows_accounted,
        expectedCount: row.rows_seen,
        unexplainedDelta: row.rows_accounted - row.rows_seen,
        evidenceDigest,
        recordedAt: stageRecordedAt,
      }));
      throw new Error("analytics source produced blocking ingestion evidence");
    }
    completedKinds.add(descriptor.sourceKind);
  }

  evidence = await releaseStore.listSourceEvidence(plan.row.run_id);
  if (evidence.length !== plan.row.expected_source_count ||
      evidence.some((row) => row.outcome !== "complete")) {
    return Object.freeze({
      status: "paused",
      runId: plan.row.run_id,
      sourcesComplete: evidence.length,
      sourcesExpected: plan.row.expected_source_count,
    });
  }
  evidence.sort((left, right) => left.source_order - right.source_order);
  const rowsSeen = evidence.reduce((sum, row) => sum + row.rows_seen, 0);
  const rowsAccounted = evidence.reduce((sum, row) => sum + row.rows_accounted, 0);
  const canonicalExpected = evidence.reduce(
    (sum, row) => sum + row.canonical_expected,
    0,
  );
  const sourceDigest = await aggregateEvidenceDigest(evidence, cryptoImpl);
  await releaseStore.writeStageEvidence(stageRow(plan, "source_snapshot", {
    observedCount: evidence.length,
    expectedCount: plan.row.expected_source_count,
    evidenceDigest: sourceDigest,
    recordedAt: stageRecordedAt,
  }));
  await releaseStore.writeStageEvidence(stageRow(plan, "ingestion", {
    observedCount: rowsAccounted,
    expectedCount: rowsSeen,
    evidenceDigest: sourceDigest,
    recordedAt: stageRecordedAt,
  }));

  const projectionInput = await projectionInputFactory(Object.freeze({
    canonicalExpected,
    highWatermarkAt: plan.row.high_watermark_at,
    runId: plan.row.run_id,
    sourceEvidence: Object.freeze([...evidence]),
  }));
  exactKeys(projectionInput, new Set([
    "asOfAt", "attributionBindings", "cohortDates", "dimensions", "events",
    "metricDate", "scopeLeakCount",
  ]), "shadow projection input");
  const scopeLeakCount = integer(
    projectionInput.scopeLeakCount,
    "shadow scope leak count",
    0,
  );
  if (scopeLeakCount !== 0) {
    const scopeDigest = await sha256Hex({ scopeLeakCount, sourceDigest }, cryptoImpl);
    await releaseStore.writeStageEvidence(stageRow(plan, "reconciliation", {
      outcome: "blocked",
      reasonCode: "scope_leak",
      observedCount: scopeLeakCount,
      expectedCount: 0,
      unexplainedDelta: scopeLeakCount,
      evidenceDigest: scopeDigest,
      recordedAt: stageRecordedAt,
    }));
    throw new Error("analytics admin shadow scope leak detected");
  }
  const projectionResult = await rebuildAnalyticsProjections({
    store: projectionStore,
    config,
    requestedScope,
    metricDate: projectionInput.metricDate,
    cohortDates: projectionInput.cohortDates,
    asOfAt: projectionInput.asOfAt,
    events: projectionInput.events,
    dimensions: projectionInput.dimensions,
    attributionBindings: projectionInput.attributionBindings,
    sourceEvidence: {
      rowsSeen,
      rowsAccounted,
      canonicalExpected,
      evidenceDigest: sourceDigest,
    },
  }, { cryptoImpl });
  const projectionDigest = await sha256Hex({
    snapshotId: projectionResult.snapshot?.snapshot_id,
    sourceDigest,
  }, cryptoImpl);
  await releaseStore.writeStageEvidence(stageRow(plan, "projection", {
    observedCount: canonicalExpected,
    expectedCount: canonicalExpected,
    evidenceDigest: projectionDigest,
    recordedAt: stageRecordedAt,
  }));
  await releaseStore.writeStageEvidence(stageRow(plan, "reconciliation", {
    observedCount: rowsAccounted,
    expectedCount: rowsSeen,
    evidenceDigest: await sha256Hex({
      canonicalExpected,
      projectionDigest,
      rowsAccounted,
      rowsSeen,
      scopeLeakCount,
    }, cryptoImpl),
    recordedAt: stageRecordedAt,
  }));

  const runtimePassed = preflight.runtimeRegression === true;
  await releaseStore.writeStageEvidence(stageRow(plan, "runtime_regression", {
    outcome: runtimePassed ? "passed" : "blocked",
    reasonCode: runtimePassed ? "none" : "runtime_regression",
    observedCount: Number(runtimePassed),
    expectedCount: 1,
    unexplainedDelta: Number(runtimePassed) - 1,
    evidenceDigest: preflight.runtimeDigest,
    recordedAt: stageRecordedAt,
  }));
  if (!runtimePassed) throw new Error("previous runtime regression failed");
  return Object.freeze({
    status: "complete",
    runId: plan.row.run_id,
    sourceMode: plan.row.source_mode,
    sourcesComplete: evidence.length,
    sourcesExpected: plan.row.expected_source_count,
    rowsSeen,
    rowsAccounted,
    canonicalExpected,
    unexplainedDelta: rowsSeen - rowsAccounted,
    scopeLeakCount,
    projectionOutcome: projectionResult.outcome,
    evidenceDigest: await sha256Hex({
      planDigest: plan.row.plan_digest,
      projectionDigest,
      sourceDigest,
    }, cryptoImpl),
    publicEnabled: false,
    workerDeployment: false,
  });
}

function insert(db, table, row) {
  const fields = Object.keys(row);
  return db.prepare(
    `INSERT OR IGNORE INTO ${table} (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`,
  ).bind(...fields.map((field) => row[field]));
}

function exactRow(actual, expected) {
  return actual && Object.keys(expected).every((key) => actual[key] === expected[key]);
}

export function createD1AnalyticsReleaseStore(db) {
  if (!db?.prepare || !db?.batch) {
    throw new TypeError("D1 analytics release store requires prepare and batch");
  }
  return Object.freeze({
    async createRun(row) {
      const result = await insert(db, "analytics_release_runs", row).run();
      const stored = await db.prepare(
        "SELECT * FROM analytics_release_runs WHERE run_id = ? LIMIT 1",
      ).bind(row.run_id).first();
      if (!exactRow(stored, row)) throw new Error("analytics release run conflicts with stored plan");
      return Object.freeze({ outcome: changed(result) === 1 ? "inserted" : "duplicate" });
    },

    async listSourceEvidence(runId) {
      const result = await db.prepare(
        `SELECT * FROM analytics_release_source_evidence
         WHERE run_id = ? ORDER BY source_order`,
      ).bind(uuid(runId)).all();
      return (result?.results || []).map((row) => ({ ...row }));
    },

    async writeSourceEvidence(row) {
      const result = await insert(db, "analytics_release_source_evidence", row).run();
      const stored = await db.prepare(
        `SELECT * FROM analytics_release_source_evidence
         WHERE run_id = ? AND source_kind = ? LIMIT 1`,
      ).bind(row.run_id, row.source_kind).first();
      if (!exactRow(stored, row)) throw new Error("analytics release source evidence conflicts");
      return Object.freeze({ outcome: changed(result) === 1 ? "inserted" : "duplicate" });
    },

    async listStageEvidence(runId) {
      const result = await db.prepare(
        `SELECT * FROM analytics_release_stage_evidence
         WHERE run_id = ? ORDER BY stage_order`,
      ).bind(uuid(runId)).all();
      return (result?.results || []).map((row) => ({ ...row }));
    },

    async writeStageEvidence(row) {
      const result = await insert(db, "analytics_release_stage_evidence", row).run();
      const stored = await db.prepare(
        `SELECT * FROM analytics_release_stage_evidence
         WHERE run_id = ? AND stage_kind = ? LIMIT 1`,
      ).bind(row.run_id, row.stage_kind).first();
      if (!exactRow(stored, row)) throw new Error("analytics release stage evidence conflicts");
      return Object.freeze({ outcome: changed(result) === 1 ? "inserted" : "duplicate" });
    },
  });
}

export async function buildClosedReleaseEvidence({
  plan,
  releaseStore,
  preflight,
  recordedAt,
  reasonCode = "not_applicable",
  cryptoImpl = globalThis.crypto,
} = {}) {
  assertPlan(plan);
  if (!new Set(["prepare_closed", "disable"]).has(plan.row.action)) {
    throw new Error("closed evidence requires prepare_closed or disable action");
  }
  integer(recordedAt, "closed release evidence time", plan.row.created_at);
  const stageRecordedAt = plan.row.created_at;
  await releaseStore.createRun(plan.row);
  await recordPreflight(plan, releaseStore, preflight, stageRecordedAt);
  for (const kind of ["source_snapshot", "ingestion", "projection", "reconciliation"]){
    await releaseStore.writeStageEvidence(stageRow(plan, kind, {
      outcome: "skipped",
      reasonCode,
      evidenceDigest: await sha256Hex({ kind, planDigest: plan.row.plan_digest }, cryptoImpl),
      recordedAt: stageRecordedAt,
    }));
  }
  const runtimePassed = preflight.runtimeRegression === true;
  await releaseStore.writeStageEvidence(stageRow(plan, "runtime_regression", {
    outcome: runtimePassed ? "passed" : "blocked",
    reasonCode: runtimePassed ? "none" : "runtime_regression",
    observedCount: Number(runtimePassed),
    expectedCount: 1,
    unexplainedDelta: Number(runtimePassed) - 1,
    evidenceDigest: preflight.runtimeDigest,
    recordedAt: stageRecordedAt,
  }));
  if (!runtimePassed) throw new Error("previous runtime regression failed");
  if (plan.row.action === "disable") {
    await releaseStore.writeStageEvidence(stageRow(plan, "disable", {
      outcome: "skipped",
      reasonCode: "operator_disabled",
      evidenceDigest: await sha256Hex({
        action: "disable",
        planDigest: plan.row.plan_digest,
      }, cryptoImpl),
      recordedAt: stageRecordedAt,
    }));
  }
  const stages = await releaseStore.listStageEvidence(plan.row.run_id);
  return Object.freeze({
    status: "complete",
    action: plan.row.action,
    runId: plan.row.run_id,
    stageCount: stages.length,
    allFlagsOff: true,
    sourceRead: false,
    workerDeployment: false,
    publicEnabled: false,
  });
}
