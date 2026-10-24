import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const CABINET_RELEASE_POLICY_VERSION =
  "2026-09-14.cabinet-v1-part6";

export const CABINET_V140_RELEASE_ACTIONS = Object.freeze([
  "audit",
  "prepare_closed",
  "enable_admin_shadow",
  "disable",
]);

export const CABINET_V140_RELEASE_STAGES = Object.freeze([
  "backup",
  "restore",
  "schema",
  "stable_regression",
  "owner_scope",
  "closed_canary",
  "replay",
  "rollback",
]);

export const CABINET_V140_CONFIRMATIONS = Object.freeze({
  audit: "",
  prepare_closed: "PREPARE CLOSED CABINET 1.4.0",
  enable_admin_shadow: "ENABLE ADMIN SHADOW CABINET 1.4.0",
  disable: "DISABLE CABINET 1.4.0",
});

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function integer(value, name, minimum = 0) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return normalized;
}

function digest(value, name) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!SHA256.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function action(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!CABINET_V140_RELEASE_ACTIONS.includes(normalized)) {
    throw new TypeError("v1.4.0 release action is not allowlisted");
  }
  return normalized;
}

export function validateCabinetReleaseIntent(value, confirmation = "") {
  const normalized = action(value);
  const expected = CABINET_V140_CONFIRMATIONS[normalized];
  assert.equal(String(confirmation || ""), expected,
    expected
      ? `Confirmation must be exactly: ${expected}`
      : "Audit must not carry a confirmation phrase");
  return Object.freeze({
    action: normalized,
    confirmation: expected ? "verified" : "not_required",
    rollout: normalized === "enable_admin_shadow" ? "admin_shadow" : "off",
    publicEnabled: false,
    workerDeployment: false,
    miniAppPublished: false,
  });
}

export function buildCabinetReleasePlan({
  runId,
  action: requestedAction,
  requestedByHash,
  commitSha,
  manifestDigest,
  createdAt,
} = {}) {
  const normalizedAction = action(requestedAction);
  assert.notEqual(normalizedAction, "audit", "audit does not create a run");
  const normalizedRunId = String(runId || "").trim().toLowerCase();
  const normalizedCommit = String(commitSha || "").trim().toLowerCase();
  assert.match(normalizedRunId, UUID_V4, "release run id is invalid");
  assert.match(normalizedCommit, COMMIT, "release commit SHA is invalid");
  const actorHash = digest(requestedByHash, "requested-by hash");
  const manifest = digest(manifestDigest, "manifest digest");
  const now = integer(createdAt, "createdAt", 1);
  const sourceMode = normalizedAction === "enable_admin_shadow"
    ? "synthetic"
    : "none";
  const unsigned = Object.freeze({
    action: normalizedAction,
    commitSha: normalizedCommit,
    createdAt: now,
    expectedCanaryCount: Number(normalizedAction === "enable_admin_shadow"),
    expectedStageCount: CABINET_V140_RELEASE_STAGES.length,
    manifestDigest: manifest,
    policyVersion: CABINET_RELEASE_POLICY_VERSION,
    requestedByHash: actorHash,
    runId: normalizedRunId,
    sourceMode,
  });
  return Object.freeze({
    ...unsigned,
    planDigest: sha256(stable(unsigned)),
    publicEnabled: false,
    workerDeployment: false,
    miniAppPublished: false,
  });
}

function exactPreflight(preflight) {
  assert.ok(preflight && typeof preflight === "object",
    "release preflight is required");
  for (const field of [
    "backupVerified",
    "restoreVerified",
    "schemaVerified",
    "stableRegressionPassed",
    "ownerScopePassed",
    "rollbackVerified",
  ]) assert.equal(preflight[field], true, `${field} must pass`);
  assert.equal(preflight.productionWiringChanged, false);
  assert.equal(preflight.publicEnabled, false);
  assert.equal(preflight.workerDeployment, false);
  return preflight;
}

function exactCanary(canary) {
  assert.ok(canary && typeof canary === "object",
    "closed synthetic canary is required");
  const expected = {
    routeCount: 6,
    tariffCount: 3,
    quotaCount: 6,
    ownerProjectorCount: 5,
    scopeLeakCount: 0,
    replayNewRows: 0,
  };
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(integer(canary[field], field), value, `${field} mismatch`);
  }
  for (const field of [
    "foreignDenialCount",
    "cursorDenialCount",
    "recoveryDenialCount",
  ]) assert.ok(integer(canary[field], field) >= 4, `${field} is incomplete`);
  assert.equal(canary.publicEnabled, false);
  assert.equal(canary.workerDeployed, false);
  return canary;
}

function stageRow({ plan, stageKind, stageOrder, outcome, count, recordedAt }) {
  const expectedCount = outcome === "skipped" ? 0 : count;
  const row = {
    run_id: plan.runId,
    stage_order: stageOrder,
    stage_kind: stageKind,
    outcome,
    reason_code: outcome === "skipped" ? "not_applicable" : "none",
    observed_count: expectedCount,
    expected_count: expectedCount,
    unexplained_delta: 0,
    recorded_at: recordedAt,
    retention_until: plan.createdAt + 15_552_000,
    policy_version: CABINET_RELEASE_POLICY_VERSION,
  };
  return Object.freeze({
    ...row,
    evidence_digest: sha256(stable(row)),
  });
}

export function buildCabinetReleaseEvidence({
  plan,
  preflight,
  canary = null,
  recordedAt,
} = {}) {
  assert.ok(plan && typeof plan === "object", "release plan is required");
  assert.match(String(plan.planDigest || ""), SHA256);
  exactPreflight(preflight);
  const at = integer(recordedAt, "recordedAt", plan.createdAt);
  const isShadow = plan.action === "enable_admin_shadow";
  const normalizedCanary = isShadow ? exactCanary(canary) : null;
  const counts = Object.freeze({
    backup: 1,
    restore: 1,
    schema: 6,
    stable_regression: 1,
    owner_scope: isShadow ? 4 : 0,
    closed_canary: isShadow ? 1 : 0,
    replay: isShadow ? 1 : 0,
    rollback: 1,
  });
  const skipped = new Set(isShadow ? [] : [
    "owner_scope", "closed_canary", "replay",
  ]);
  const stages = CABINET_V140_RELEASE_STAGES.map((stageKind, index) =>
    stageRow({
      plan,
      stageKind,
      stageOrder: index + 1,
      outcome: skipped.has(stageKind) ? "skipped" : "passed",
      count: counts[stageKind],
      recordedAt: at,
    }));
  const run = Object.freeze({
    run_id: plan.runId,
    action: plan.action,
    source_mode: plan.sourceMode,
    requested_by_hash: plan.requestedByHash,
    commit_sha: plan.commitSha,
    manifest_digest: plan.manifestDigest,
    plan_digest: plan.planDigest,
    expected_stage_count: 8,
    expected_canary_count: Number(isShadow),
    status: "complete",
    created_at: plan.createdAt,
    retention_until: plan.createdAt + 15_552_000,
    policy_version: CABINET_RELEASE_POLICY_VERSION,
  });
  let canaryRow = null;
  if (normalizedCanary) {
    const row = {
      run_id: plan.runId,
      route_count: normalizedCanary.routeCount,
      tariff_count: normalizedCanary.tariffCount,
      quota_count: normalizedCanary.quotaCount,
      owner_projector_count: normalizedCanary.ownerProjectorCount,
      foreign_denial_count: normalizedCanary.foreignDenialCount,
      cursor_denial_count: normalizedCanary.cursorDenialCount,
      recovery_denial_count: normalizedCanary.recoveryDenialCount,
      scope_leak_count: normalizedCanary.scopeLeakCount,
      replay_new_rows: normalizedCanary.replayNewRows,
      public_enabled: 0,
      worker_deployed: 0,
      recorded_at: at,
      retention_until: plan.createdAt + 15_552_000,
      policy_version: CABINET_RELEASE_POLICY_VERSION,
    };
    canaryRow = Object.freeze({
      ...row,
      evidence_digest: sha256(stable(row)),
    });
  }
  return Object.freeze({
    run,
    stages: Object.freeze(stages),
    canary: canaryRow,
    evidenceDigest: sha256(stable({ run, stages, canary: canaryRow })),
    publicEnabled: false,
    workerDeployment: false,
    miniAppPublished: false,
  });
}

export function assertCabinetReleaseReplay(first, replay) {
  assert.equal(first?.evidenceDigest, replay?.evidenceDigest,
    "release replay evidence changed");
  assert.deepEqual(replay, first, "release replay is not idempotent");
  return Object.freeze({ evidenceDigest: first.evidenceDigest, newRows: 0 });
}
