import {
  readReferralRewardConfig,
  requireUnixSeconds,
} from "./referral-reward-foundation.mjs";
import { referralReconciliationOffset, referralReconciliationContinuation } from './referral-reconciliation-pagination.mjs';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTIVE_WORKFLOW_STATES = new Set([
  "queued",
  "running",
  "paused",
  "waiting",
  "waitingForPause",
]);
const TERMINAL_REWARD_STATES = new Set(["confirmed", "cancelled"]);
const MAX_REPAIR_BATCH = 50;
const PAYMENT_TIME_TOLERANCE_SECONDS = 86_400;

function nowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function protectionError(code, cause) {
  const error = new Error("Referral reward protection operation rejected");
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export function safeReferralProtectionErrorCode(
  error,
  fallback = "referral_protection_error",
) {
  return String(error?.code || error?.name || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 64);
}

function requireDatabase(env) {
  if (!env?.DB?.prepare || !env?.DB?.batch) {
    throw protectionError("referral_protection_database_not_ready");
  }
  return env.DB;
}

function validateUuid(value, code) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!UUID_V4.test(normalized)) throw protectionError(code);
  return normalized;
}

function validateRewardId(value) {
  return validateUuid(value, "referral_reward_id_invalid");
}

function validateClock(value, fieldName = "checkedAt") {
  try {
    return requireUnixSeconds(value ?? nowSeconds(), fieldName);
  } catch (cause) {
    throw protectionError("referral_protection_clock_invalid", cause);
  }
}

function resultChanges(result) {
  return Number(result?.meta?.changes || result?.changes || 0);
}

function confirmationsDecision(env) {
  const config = readReferralRewardConfig(env);
  return Object.freeze({
    enabled: config.confirmationsEnabled,
    reason: config.confirmationsEnabled
      ? "referral_confirmations_enabled"
      : config.configurationProblems[0] || "referral_confirmations_disabled",
  });
}

async function loadProtectionEvidence(database, rewardId) {
  return database.prepare(
    `SELECT
       reward.reward_id,
       reward.candidate_id,
       reward.reward_status,
       reward.confirm_after,
       reward.last_transition_id,
       reward.revision,
       reward.created_at AS reward_created_at,
       reward.updated_at AS reward_updated_at,
       candidate.source_order_id,
       candidate.source_payment_ledger_entry_id,
       candidate.source_access_grant_id,
       candidate.buyer_telegram_id,
       candidate.buyer_plan_code,
       candidate.amount_stars,
       candidate.paid_at,
       orders.order_state,
       orders.telegram_id AS order_telegram_id,
       orders.plan_code AS order_plan_code,
       orders.amount_stars AS order_amount_stars,
       payment.order_id AS payment_order_id,
       payment.telegram_id AS payment_telegram_id,
       payment.entry_type AS payment_entry_type,
       payment.direction AS payment_direction,
       payment.currency AS payment_currency,
       payment.amount_stars AS payment_amount_stars,
       payment.occurred_at AS payment_occurred_at,
       source_access.order_id AS access_order_id,
       source_access.payment_ledger_entry_id AS access_payment_ledger_entry_id,
       source_access.telegram_id AS access_telegram_id,
       source_access.plan_code AS access_plan_code,
       source_access.status AS access_status,
       compensation.ledger_entry_id AS compensation_ledger_entry_id,
       compensation.entry_type AS compensation_type,
       compensation.direction AS compensation_direction,
       compensation.currency AS compensation_currency,
       compensation.amount_stars AS compensation_amount_stars,
       compensation.order_id AS compensation_order_id,
       compensation.telegram_id AS compensation_telegram_id,
       compensation.occurred_at AS compensation_occurred_at,
       compensation.recorded_at AS compensation_recorded_at
     FROM referral_rewards reward
     JOIN referral_reward_candidates candidate
       ON candidate.candidate_id = reward.candidate_id
     LEFT JOIN subscription_orders orders
       ON orders.order_id = candidate.source_order_id
     LEFT JOIN payment_ledger payment
       ON payment.ledger_entry_id = candidate.source_payment_ledger_entry_id
     LEFT JOIN subscription_access_grants source_access
       ON source_access.grant_id = candidate.source_access_grant_id
     LEFT JOIN payment_ledger compensation
       ON compensation.ledger_entry_id = (
         SELECT observed.ledger_entry_id
         FROM payment_ledger observed
         WHERE observed.related_ledger_entry_id =
           candidate.source_payment_ledger_entry_id
           AND observed.entry_type IN ('refund', 'chargeback')
         ORDER BY observed.recorded_at,
                  CASE observed.entry_type WHEN 'chargeback' THEN 0 ELSE 1 END,
                  observed.ledger_entry_id
         LIMIT 1
       )
     WHERE reward.reward_id = ?
     LIMIT 1`,
  ).bind(rewardId).first();
}

async function loadProtectionJob(database, rewardId) {
  return database.prepare(
    `SELECT protection_job_id, reward_id, candidate_id,
            workflow_instance_id, workflow_state, scheduled_for,
            start_attempt_count, last_attempt_at, started_at, completed_at,
            settlement_outcome, settled_transition_id,
            last_reconciliation_run_id, last_error_code,
            created_at, updated_at
     FROM referral_reward_protection_jobs
     WHERE reward_id = ?
     LIMIT 1`,
  ).bind(rewardId).first();
}

async function loadReconciliationEvidence(
  database,
  reconciliationRunId,
  sourceLedgerEntryId,
) {
  if (!reconciliationRunId) return null;
  return database.prepare(
    `SELECT reconciliation.run_id, reconciliation.status AS run_status,
            reconciliation.started_at AS run_started_at,
            reconciliation.finished_at AS run_finished_at,
            item.item_id, item.observation_side,
            item.transaction_direction, item.telegram_id,
            item.amount_stars, item.transaction_date,
            item.local_state, item.ledger_entry_id, item.observed_at
     FROM payment_reconciliation_runs reconciliation
     LEFT JOIN payment_reconciliation_items item
       ON item.item_id = (
         SELECT candidate_item.item_id
         FROM payment_reconciliation_items candidate_item
         WHERE candidate_item.run_id = reconciliation.run_id
           AND candidate_item.ledger_entry_id = ?
         ORDER BY
           CASE
             WHEN candidate_item.observation_side = 'telegram'
               AND candidate_item.transaction_direction = 'incoming'
               AND candidate_item.local_state IN ('matched', 'recovered')
             THEN 0 ELSE 1
           END,
           candidate_item.observed_at DESC,
           candidate_item.item_id
         LIMIT 1
       )
     WHERE reconciliation.run_id = ?
     LIMIT 1`,
  ).bind(sourceLedgerEntryId, reconciliationRunId).first();
}

async function loadLatestReconciliationEvidence(
  database,
  sourceLedgerEntryId,
  confirmAfter,
  checkedAt,
) {
  return database.prepare(
    `SELECT reconciliation.run_id, reconciliation.status AS run_status,
            reconciliation.started_at AS run_started_at,
            reconciliation.finished_at AS run_finished_at,
            item.item_id, item.observation_side,
            item.transaction_direction, item.telegram_id,
            item.amount_stars, item.transaction_date,
            item.local_state, item.ledger_entry_id, item.observed_at
     FROM payment_reconciliation_items item
     JOIN payment_reconciliation_runs reconciliation
       ON reconciliation.run_id = item.run_id
     WHERE item.ledger_entry_id = ?
       AND reconciliation.started_at >= ?
       AND reconciliation.finished_at IS NOT NULL
       AND reconciliation.finished_at <= ?
     ORDER BY reconciliation.started_at DESC, item.observed_at DESC,
              item.item_id
     LIMIT 1`,
  ).bind(sourceLedgerEntryId, confirmAfter, checkedAt).first();
}

function terminalRewardResult(evidence, status = "already_settled") {
  if (
    !evidence ||
    !TERMINAL_REWARD_STATES.has(String(evidence.reward_status || "")) ||
    !evidence.last_transition_id
  ) {
    throw protectionError("referral_protection_terminal_invariant");
  }
  return Object.freeze({
    status,
    rewardId: String(evidence.reward_id),
    outcome: String(evidence.reward_status),
    transitionId: String(evidence.last_transition_id),
    confirmAfter: Number(evidence.confirm_after),
  });
}

function localEvidenceProblem(evidence) {
  if (!evidence) return "referral_reward_not_found";
  if (
    evidence.order_state !== "applied" ||
    Number(evidence.order_telegram_id) !== Number(evidence.buyer_telegram_id) ||
    evidence.order_plan_code !== evidence.buyer_plan_code ||
    Number(evidence.order_amount_stars) !== Number(evidence.amount_stars)
  ) {
    return "referral_source_order_not_applied";
  }
  if (
    evidence.payment_entry_type !== "payment" ||
    evidence.payment_direction !== "credit" ||
    evidence.payment_currency !== "XTR" ||
    evidence.payment_order_id !== evidence.source_order_id ||
    Number(evidence.payment_telegram_id) !== Number(evidence.buyer_telegram_id) ||
    Number(evidence.payment_amount_stars) !== Number(evidence.amount_stars) ||
    Number(evidence.payment_occurred_at) !== Number(evidence.paid_at)
  ) {
    return "referral_source_payment_mismatch";
  }
  if (
    evidence.access_order_id !== evidence.source_order_id ||
    evidence.access_payment_ledger_entry_id !==
      evidence.source_payment_ledger_entry_id ||
    Number(evidence.access_telegram_id) !== Number(evidence.buyer_telegram_id) ||
    evidence.access_plan_code !== evidence.buyer_plan_code ||
    evidence.access_status !== "active"
  ) {
    return "referral_source_access_not_active";
  }
  return null;
}

function compensationProblem(evidence, checkedAt) {
  if (!evidence?.compensation_ledger_entry_id) return null;
  if (
    !["refund", "chargeback"].includes(evidence.compensation_type) ||
    evidence.compensation_direction !== "debit" ||
    evidence.compensation_currency !== "XTR" ||
    evidence.compensation_order_id !== evidence.source_order_id ||
    Number(evidence.compensation_telegram_id) !==
      Number(evidence.buyer_telegram_id) ||
    Number(evidence.compensation_amount_stars) !== Number(evidence.amount_stars) ||
    !Number.isSafeInteger(Number(evidence.compensation_occurred_at)) ||
    Number(evidence.compensation_occurred_at) <= 0 ||
    !Number.isSafeInteger(Number(evidence.compensation_recorded_at)) ||
    Number(evidence.compensation_recorded_at) > checkedAt
  ) {
    return "referral_compensation_evidence_mismatch";
  }
  return null;
}

function reconciliationProblem(evidence, reconciliation, checkedAt) {
  if (!reconciliation?.run_id || !reconciliation.item_id) {
    return "referral_payment_recheck_missing";
  }
  if (
    !["completed", "manual_review"].includes(reconciliation.run_status) ||
    !Number.isSafeInteger(Number(reconciliation.run_started_at)) ||
    Number(reconciliation.run_started_at) < Number(evidence.confirm_after) ||
    !Number.isSafeInteger(Number(reconciliation.run_finished_at)) ||
    Number(reconciliation.run_finished_at) > checkedAt ||
    reconciliation.observation_side !== "telegram" ||
    reconciliation.transaction_direction !== "incoming" ||
    !["matched", "recovered"].includes(reconciliation.local_state) ||
    reconciliation.ledger_entry_id !== evidence.source_payment_ledger_entry_id ||
    Number(reconciliation.telegram_id) !== Number(evidence.buyer_telegram_id) ||
    Number(reconciliation.amount_stars) !== Number(evidence.amount_stars) ||
    Math.abs(
      Number(reconciliation.transaction_date) - Number(evidence.paid_at),
    ) > PAYMENT_TIME_TOLERANCE_SECONDS ||
    !Number.isSafeInteger(Number(reconciliation.observed_at)) ||
    Number(reconciliation.observed_at) < Number(evidence.confirm_after) ||
    Number(reconciliation.observed_at) > checkedAt
  ) {
    return "referral_payment_recheck_not_verified";
  }
  return null;
}

function manualReviewResult(evidence, reason, reconciliationRunId = null) {
  return Object.freeze({
    status: "manual_review",
    reason,
    rewardId: String(evidence?.reward_id || ""),
    confirmAfter: Number(evidence?.confirm_after || 0),
    reconciliationRunId: reconciliationRunId || null,
  });
}

export async function getReferralProtectionSchedule(env, { rewardId } = {}) {
  const normalizedRewardId = validateRewardId(rewardId);
  const gate = confirmationsDecision(env);
  if (!gate.enabled) {
    return Object.freeze({
      status: "disabled",
      reason: gate.reason,
      rewardId: normalizedRewardId,
    });
  }
  const database = requireDatabase(env);
  const evidence = await loadProtectionEvidence(database, normalizedRewardId);
  if (!evidence) throw protectionError("referral_reward_not_found");
  if (TERMINAL_REWARD_STATES.has(evidence.reward_status)) {
    return terminalRewardResult(evidence);
  }
  const job = await loadProtectionJob(database, normalizedRewardId);
  if (!job) throw protectionError("referral_protection_job_not_found");
  if (
    job.candidate_id !== evidence.candidate_id ||
    Number(job.scheduled_for) !== Number(evidence.confirm_after)
  ) {
    throw protectionError("referral_protection_job_invariant");
  }
  return Object.freeze({
    status: "scheduled",
    rewardId: normalizedRewardId,
    candidateId: String(evidence.candidate_id),
    protectionJobId: String(job.protection_job_id),
    workflowInstanceId: String(job.workflow_instance_id),
    workflowState: String(job.workflow_state),
    confirmAfter: Number(evidence.confirm_after),
  });
}

async function ensureProtectionJobRecord(database, evidence, createdAt) {
  if (TERMINAL_REWARD_STATES.has(evidence.reward_status)) return null;
  const protectionJobId = crypto.randomUUID();
  const workflowInstanceId = `referral-protection-${evidence.reward_id}`;
  await database.prepare(
    `INSERT OR IGNORE INTO referral_reward_protection_jobs (
       protection_job_id, job_key, reward_id, candidate_id,
       workflow_instance_id, workflow_state, scheduled_for,
       start_attempt_count, last_attempt_at, started_at, completed_at,
       settlement_outcome, settled_transition_id,
       last_reconciliation_run_id, last_error_code,
       created_at, updated_at
     )
     SELECT ?, ?, reward.reward_id, reward.candidate_id,
            ?, 'pending', reward.confirm_after,
            0, NULL, NULL, NULL, '', NULL, NULL, '', ?, ?
     FROM referral_rewards reward
     WHERE reward.reward_id = ? AND reward.reward_status = 'pending'`,
  ).bind(
    protectionJobId,
    `protection-job:${evidence.reward_id}`,
    workflowInstanceId,
    createdAt,
    createdAt,
    evidence.reward_id,
  ).run();
  return loadProtectionJob(database, evidence.reward_id);
}

async function markJobStarted(database, rewardId, timestamp) {
  await database.prepare(
    `UPDATE referral_reward_protection_jobs
     SET workflow_state = 'started',
         start_attempt_count = start_attempt_count + 1,
         last_attempt_at = ?,
         started_at = COALESCE(started_at, ?),
         completed_at = NULL,
         settlement_outcome = '',
         settled_transition_id = NULL,
         last_reconciliation_run_id = NULL,
         last_error_code = '',
         updated_at = ?
     WHERE reward_id = ?
       AND workflow_state IN ('pending', 'start_failed', 'manual_review')
       AND start_attempt_count < 20`,
  ).bind(timestamp, timestamp, timestamp, rewardId).run();
  return loadProtectionJob(database, rewardId);
}

async function markJobStartFailed(database, rewardId, timestamp, errorCode) {
  await database.prepare(
    `UPDATE referral_reward_protection_jobs
     SET workflow_state = 'start_failed',
         start_attempt_count = start_attempt_count + 1,
         last_attempt_at = ?,
         completed_at = NULL,
         settlement_outcome = '',
         settled_transition_id = NULL,
         last_error_code = ?,
         updated_at = ?
     WHERE reward_id = ?
       AND workflow_state IN ('pending', 'start_failed', 'manual_review')
       AND start_attempt_count < 20`,
  ).bind(timestamp, errorCode, timestamp, rewardId).run();
  return loadProtectionJob(database, rewardId);
}

async function workflowBindingState(binding, instanceId) {
  if (typeof binding?.get !== "function") return "unknown";
  try {
    const instance = await binding.get(instanceId);
    if (!instance || typeof instance.status !== "function") return "unknown";
    const details = await instance.status();
    return String(details?.status || "unknown");
  } catch {
    return "unknown";
  }
}

async function markUnrecoverableJob(database, rewardId, timestamp, errorCode) {
  await database.prepare(
    `UPDATE referral_reward_protection_jobs
     SET workflow_state = 'manual_review',
         start_attempt_count = CASE
           WHEN start_attempt_count = 0 THEN 1 ELSE start_attempt_count
         END,
         last_attempt_at = COALESCE(last_attempt_at, ?),
         completed_at = ?,
         settlement_outcome = '',
         settled_transition_id = NULL,
         last_error_code = ?,
         updated_at = ?
     WHERE reward_id = ?
       AND workflow_state IN ('pending', 'started', 'start_failed')`,
  ).bind(timestamp, timestamp, errorCode, timestamp, rewardId).run();
  return loadProtectionJob(database, rewardId);
}

export async function ensureReferralProtectionWorkflow(
  env,
  { rewardId, requestedAt = nowSeconds() } = {},
) {
  const normalizedRewardId = validateRewardId(rewardId);
  const timestamp = validateClock(requestedAt, "requestedAt");
  const gate = confirmationsDecision(env);
  if (!gate.enabled) {
    return Object.freeze({
      status: "disabled",
      reason: gate.reason,
      rewardId: normalizedRewardId,
    });
  }

  const database = requireDatabase(env);
  let evidence = await loadProtectionEvidence(database, normalizedRewardId);
  if (!evidence) throw protectionError("referral_reward_not_found");
  if (TERMINAL_REWARD_STATES.has(evidence.reward_status)) {
    return terminalRewardResult(evidence);
  }
  const createdAt = Math.max(timestamp, Number(evidence.reward_created_at));
  let job = await ensureProtectionJobRecord(database, evidence, createdAt);
  if (!job) throw protectionError("referral_protection_job_not_persisted");
  if (job.workflow_state === "completed") {
    return Object.freeze({
      status: "completed",
      rewardId: normalizedRewardId,
      protectionJobId: String(job.protection_job_id),
      workflowInstanceId: String(job.workflow_instance_id),
    });
  }
  if (job.workflow_state === "started") {
    return Object.freeze({
      status: "started",
      reason: "workflow_already_started",
      rewardId: normalizedRewardId,
      protectionJobId: String(job.protection_job_id),
      workflowInstanceId: String(job.workflow_instance_id),
      confirmAfter: Number(job.scheduled_for),
    });
  }
  if (Number(job.start_attempt_count) >= 20) {
    job = await markUnrecoverableJob(
      database,
      normalizedRewardId,
      timestamp,
      "workflow_start_attempts_exhausted",
    );
    return Object.freeze({
      status: "manual_review",
      reason: "workflow_start_attempts_exhausted",
      rewardId: normalizedRewardId,
      protectionJobId: String(job?.protection_job_id || ""),
    });
  }

  const binding = env?.REFERRAL_REWARD_PROTECTION_WORKFLOW;
  if (typeof binding?.create !== "function") {
    job = await markJobStartFailed(
      database,
      normalizedRewardId,
      timestamp,
      "workflow_binding_missing",
    );
    return Object.freeze({
      status: "start_failed",
      reason: "workflow_binding_missing",
      rewardId: normalizedRewardId,
      protectionJobId: String(job?.protection_job_id || ""),
    });
  }

  const existingState = await workflowBindingState(
    binding,
    job.workflow_instance_id,
  );
  if (ACTIVE_WORKFLOW_STATES.has(existingState)) {
    job = await markJobStarted(database, normalizedRewardId, timestamp);
    return Object.freeze({
      status: "started",
      reason: "workflow_instance_recovered",
      rewardId: normalizedRewardId,
      protectionJobId: String(job.protection_job_id),
      workflowInstanceId: String(job.workflow_instance_id),
      confirmAfter: Number(job.scheduled_for),
    });
  }
  if (["complete", "errored", "terminated"].includes(existingState)) {
    evidence = await loadProtectionEvidence(database, normalizedRewardId);
    if (TERMINAL_REWARD_STATES.has(evidence?.reward_status)) {
      return terminalRewardResult(evidence);
    }
    job = await markUnrecoverableJob(
      database,
      normalizedRewardId,
      timestamp,
      `workflow_instance_${existingState}`,
    );
    return Object.freeze({
      status: "manual_review",
      reason: `workflow_instance_${existingState}`,
      rewardId: normalizedRewardId,
      protectionJobId: String(job?.protection_job_id || ""),
    });
  }

  try {
    await binding.create({
      id: job.workflow_instance_id,
      params: { rewardId: normalizedRewardId },
    });
    job = await markJobStarted(database, normalizedRewardId, timestamp);
  } catch (cause) {
    const recoveredState = await workflowBindingState(
      binding,
      job.workflow_instance_id,
    );
    if (ACTIVE_WORKFLOW_STATES.has(recoveredState)) {
      job = await markJobStarted(database, normalizedRewardId, timestamp);
      return Object.freeze({
        status: "started",
        reason: "ambiguous_create_recovered",
        rewardId: normalizedRewardId,
        protectionJobId: String(job.protection_job_id),
        workflowInstanceId: String(job.workflow_instance_id),
        confirmAfter: Number(job.scheduled_for),
      });
    }
    const errorCode = safeReferralProtectionErrorCode(
      cause,
      "workflow_start_failed",
    );
    job = await markJobStartFailed(
      database,
      normalizedRewardId,
      timestamp,
      errorCode,
    );
    return Object.freeze({
      status: "start_failed",
      reason: errorCode,
      rewardId: normalizedRewardId,
      protectionJobId: String(job?.protection_job_id || ""),
    });
  }

  if (!job || job.workflow_state !== "started") {
    throw protectionError("referral_protection_job_start_invariant");
  }
  return Object.freeze({
    status: "started",
    reason: "workflow_instance_created",
    rewardId: normalizedRewardId,
    protectionJobId: String(job.protection_job_id),
    workflowInstanceId: String(job.workflow_instance_id),
    confirmAfter: Number(job.scheduled_for),
  });
}

export async function reconcileReferralRewardSourcePayment(
  env,
  { rewardId, checkedAt = nowSeconds(), offsetStart = 0 } = {},
  { reconcileTransactions } = {},
) {
  const normalizedRewardId = validateRewardId(rewardId);
  const timestamp = validateClock(checkedAt);
  const offset = referralReconciliationOffset(offsetStart);
  const gate = confirmationsDecision(env);
  if (!gate.enabled) {
    return Object.freeze({
      status: "disabled",
      reason: gate.reason,
      rewardId: normalizedRewardId,
    });
  }
  const database = requireDatabase(env);
  let evidence = await loadProtectionEvidence(database, normalizedRewardId);
  if (!evidence) throw protectionError("referral_reward_not_found");
  if (TERMINAL_REWARD_STATES.has(evidence.reward_status)) {
    return terminalRewardResult(evidence);
  }
  if (timestamp < Number(evidence.confirm_after)) {
    return Object.freeze({
      status: "waiting",
      rewardId: normalizedRewardId,
      confirmAfter: Number(evidence.confirm_after),
      remainingSeconds: Number(evidence.confirm_after) - timestamp,
    });
  }
  const compensationIssue = compensationProblem(evidence, timestamp);
  if (compensationIssue) return manualReviewResult(evidence, compensationIssue);
  if (evidence.compensation_ledger_entry_id) {
    return Object.freeze({
      status: "compensated",
      rewardId: normalizedRewardId,
      reason: String(evidence.compensation_type),
      compensationLedgerEntryId: String(
        evidence.compensation_ledger_entry_id,
      ),
      reconciliationRunId: null,
      checkedAt: timestamp,
    });
  }
  const localProblem = localEvidenceProblem(evidence);
  if (localProblem) return manualReviewResult(evidence, localProblem);

  const reusableReconciliation = await loadLatestReconciliationEvidence(
    database,
    evidence.source_payment_ledger_entry_id,
    Number(evidence.confirm_after),
    timestamp,
  );
  if (!reconciliationProblem(evidence, reusableReconciliation, timestamp)) {
    return Object.freeze({
      status: "verified",
      rewardId: normalizedRewardId,
      reconciliationRunId: String(reusableReconciliation.run_id),
      reconciliationItemId: String(reusableReconciliation.item_id),
      checkedAt: timestamp,
      reused: true,
    });
  }
  if (typeof reconcileTransactions !== "function") {
    throw protectionError("referral_reconciliation_runtime_missing");
  }

  const reconciliation = await reconcileTransactions(env, {
    runSource: "scheduled",
    startedAt: timestamp,
    offsetStart: offset,
    targetPaymentLedgerEntryId: evidence.source_payment_ledger_entry_id,
  });
  const verifiedAt = Math.max(timestamp, nowSeconds());
  const runId = String(reconciliation?.runId || "").trim().toLowerCase();
  if (!UUID_V4.test(runId)) {
    throw protectionError("referral_reconciliation_run_invalid");
  }

  evidence = await loadProtectionEvidence(database, normalizedRewardId);
  if (!evidence) throw protectionError("referral_reward_not_found");
  if (TERMINAL_REWARD_STATES.has(evidence.reward_status)) {
    return terminalRewardResult(evidence);
  }
  const compensationAfterRecheck = compensationProblem(evidence, verifiedAt);
  if (compensationAfterRecheck) {
    return manualReviewResult(evidence, compensationAfterRecheck, runId);
  }
  if (evidence.compensation_ledger_entry_id) {
    return Object.freeze({
      status: "compensated",
      rewardId: normalizedRewardId,
      reason: String(evidence.compensation_type),
      compensationLedgerEntryId: String(
        evidence.compensation_ledger_entry_id,
      ),
      reconciliationRunId: runId,
      checkedAt: verifiedAt,
    });
  }
  const reconciliationEvidence = await loadReconciliationEvidence(
    database,
    runId,
    evidence.source_payment_ledger_entry_id,
  );
  const recheckProblem = reconciliationProblem(
    evidence,
    reconciliationEvidence,
    verifiedAt,
  );
  if (recheckProblem) {
    if (recheckProblem === 'referral_payment_recheck_missing') {
      const continuation = referralReconciliationContinuation(reconciliation, {
        offsetStart: offset, rewardId: normalizedRewardId, checkedAt: verifiedAt,
      });
      if (continuation) return continuation;
    }
    return manualReviewResult(evidence, recheckProblem, runId);
  }
  return Object.freeze({
    status: "verified",
    rewardId: normalizedRewardId,
    reconciliationRunId: runId,
    reconciliationItemId: String(reconciliationEvidence.item_id),
    checkedAt: verifiedAt,
  });
}

async function persistProtectionDecision(
  database,
  evidence,
  {
    checkedAt,
    reconciliation,
  },
) {
  const isCancellation = Boolean(evidence.compensation_ledger_entry_id);
  const decision = isCancellation ? "cancel" : "confirm";
  const reasonCode = isCancellation
    ? String(evidence.compensation_type)
    : "hold_elapsed";
  const transitionId = crypto.randomUUID();
  const checkId = crypto.randomUUID();
  const relatedLedgerEntryId = isCancellation
    ? evidence.compensation_ledger_entry_id
    : evidence.source_payment_ledger_entry_id;
  const occurredAt = isCancellation
    ? Number(evidence.compensation_occurred_at)
    : checkedAt;
  const toStatus = isCancellation ? "cancelled" : "confirmed";
  const reconciliationRunId = isCancellation
    ? null
    : reconciliation.run_id;
  const reconciliationItemId = isCancellation
    ? null
    : reconciliation.item_id;

  await database.batch([
    database.prepare(
      `INSERT INTO referral_reward_protection_checks (
         protection_check_id, check_key, reward_id, candidate_id,
         reward_revision, decision, reason_code,
         source_payment_ledger_entry_id, source_access_grant_id,
         reconciliation_run_id, reconciliation_item_id,
         compensation_ledger_entry_id, transition_id,
         checked_at, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      checkId,
      `protection-check:${evidence.reward_id}:${evidence.revision}`,
      evidence.reward_id,
      evidence.candidate_id,
      Number(evidence.revision),
      decision,
      reasonCode,
      evidence.source_payment_ledger_entry_id,
      evidence.source_access_grant_id,
      reconciliationRunId,
      reconciliationItemId,
      isCancellation ? evidence.compensation_ledger_entry_id : null,
      transitionId,
      checkedAt,
      checkedAt,
    ),
    database.prepare(
      `INSERT INTO referral_reward_transitions (
         transition_id, transition_key, transition_scope, reward_id,
         bonus_grant_id, from_status, to_status, from_revision, to_revision,
         reason_code, actor_type, actor_id, related_payment_ledger_entry_id,
         effect_starts_at, effect_ends_at, compensated_seconds,
         occurred_at, recorded_at
       ) VALUES (?, ?, 'reward', ?, NULL, 'pending', ?, ?, ?,
                 ?, 'workflow', NULL, ?, NULL, NULL, 0, ?, ?)`,
    ).bind(
      transitionId,
      `protection-transition:${evidence.reward_id}:${evidence.revision}`,
      evidence.reward_id,
      toStatus,
      Number(evidence.revision),
      Number(evidence.revision) + 1,
      reasonCode,
      relatedLedgerEntryId,
      occurredAt,
      checkedAt,
    ),
  ]);

  const settled = await loadProtectionEvidence(database, evidence.reward_id);
  if (
    settled?.reward_status !== toStatus ||
    settled?.last_transition_id !== transitionId ||
    Number(settled?.revision) !== Number(evidence.revision) + 1
  ) {
    throw protectionError("referral_protection_settlement_invariant");
  }
  return terminalRewardResult(settled, "settled");
}

export async function settleReferralRewardProtection(
  env,
  {
    rewardId,
    reconciliationRunId = null,
    checkedAt = nowSeconds(),
  } = {},
) {
  const normalizedRewardId = validateRewardId(rewardId);
  const timestamp = validateClock(checkedAt);
  const gate = confirmationsDecision(env);
  if (!gate.enabled) {
    return Object.freeze({
      status: "disabled",
      reason: gate.reason,
      rewardId: normalizedRewardId,
    });
  }
  const database = requireDatabase(env);
  let evidence = await loadProtectionEvidence(database, normalizedRewardId);
  if (!evidence) throw protectionError("referral_reward_not_found");
  if (TERMINAL_REWARD_STATES.has(evidence.reward_status)) {
    return terminalRewardResult(evidence);
  }
  if (timestamp < Number(evidence.confirm_after)) {
    return Object.freeze({
      status: "waiting",
      rewardId: normalizedRewardId,
      confirmAfter: Number(evidence.confirm_after),
      remainingSeconds: Number(evidence.confirm_after) - timestamp,
    });
  }

  let issue = compensationProblem(evidence, timestamp);
  if (issue) return manualReviewResult(evidence, issue, reconciliationRunId);
  let reconciliation = null;
  if (!evidence.compensation_ledger_entry_id) {
    issue = localEvidenceProblem(evidence);
    if (issue) return manualReviewResult(evidence, issue, reconciliationRunId);
    const normalizedRunId = String(reconciliationRunId || "")
      .trim()
      .toLowerCase();
    if (!UUID_V4.test(normalizedRunId)) {
      return manualReviewResult(
        evidence,
        "referral_payment_recheck_missing",
      );
    }
    reconciliation = await loadReconciliationEvidence(
      database,
      normalizedRunId,
      evidence.source_payment_ledger_entry_id,
    );
    issue = reconciliationProblem(evidence, reconciliation, timestamp);
    if (issue) return manualReviewResult(evidence, issue, normalizedRunId);
  }

  try {
    return await persistProtectionDecision(database, evidence, {
      checkedAt: timestamp,
      reconciliation,
    });
  } catch (cause) {
    evidence = await loadProtectionEvidence(database, normalizedRewardId);
    if (TERMINAL_REWARD_STATES.has(evidence?.reward_status)) {
      return terminalRewardResult(evidence);
    }
    const raceIssue = compensationProblem(evidence, timestamp);
    if (raceIssue) {
      return manualReviewResult(evidence, raceIssue, reconciliationRunId);
    }
    if (evidence?.compensation_ledger_entry_id) {
      try {
        return await persistProtectionDecision(database, evidence, {
          checkedAt: timestamp,
          reconciliation: null,
        });
      } catch (retryCause) {
        const raced = await loadProtectionEvidence(
          database,
          normalizedRewardId,
        );
        if (TERMINAL_REWARD_STATES.has(raced?.reward_status)) {
          return terminalRewardResult(raced);
        }
        throw protectionError(
          "referral_protection_persistence_failed",
          retryCause,
        );
      }
    }
    throw protectionError("referral_protection_persistence_failed", cause);
  }
}

export async function completeReferralProtectionJob(
  env,
  {
    rewardId,
    transitionId,
    outcome,
    reconciliationRunId = null,
    completedAt = nowSeconds(),
  } = {},
) {
  const normalizedRewardId = validateRewardId(rewardId);
  const normalizedTransitionId = validateUuid(
    transitionId,
    "referral_transition_id_invalid",
  );
  const normalizedOutcome = String(outcome || "");
  if (!TERMINAL_REWARD_STATES.has(normalizedOutcome)) {
    throw protectionError("referral_settlement_outcome_invalid");
  }
  const timestamp = validateClock(completedAt, "completedAt");
  const database = requireDatabase(env);
  const result = await database.prepare(
    `UPDATE referral_reward_protection_jobs
     SET workflow_state = 'completed',
         completed_at = ?,
         settlement_outcome = ?,
         settled_transition_id = ?,
         last_reconciliation_run_id = ?,
         last_error_code = '',
         updated_at = ?
     WHERE reward_id = ? AND workflow_state = 'started'`,
  ).bind(
    timestamp,
    normalizedOutcome,
    normalizedTransitionId,
    reconciliationRunId || null,
    timestamp,
    normalizedRewardId,
  ).run();
  const job = await loadProtectionJob(database, normalizedRewardId);
  if (!job) throw protectionError("referral_protection_job_not_found");
  if (job.workflow_state === "completed") {
    if (
      job.settlement_outcome !== normalizedOutcome ||
      job.settled_transition_id !== normalizedTransitionId
    ) {
      throw protectionError("referral_protection_job_completion_conflict");
    }
    return Object.freeze({
      status: resultChanges(result) > 0 ? "completed" : "already_completed",
      rewardId: normalizedRewardId,
      protectionJobId: String(job.protection_job_id),
      outcome: normalizedOutcome,
      transitionId: normalizedTransitionId,
    });
  }
  throw protectionError("referral_protection_job_completion_failed");
}

export async function markReferralProtectionJobManualReview(
  env,
  {
    rewardId,
    reason,
    reconciliationRunId = null,
    recordedAt = nowSeconds(),
  } = {},
) {
  const normalizedRewardId = validateRewardId(rewardId);
  const timestamp = validateClock(recordedAt, "recordedAt");
  const errorCode = safeReferralProtectionErrorCode(
    { code: reason },
    "referral_protection_manual_review",
  );
  const database = requireDatabase(env);
  await database.prepare(
    `UPDATE referral_reward_protection_jobs
     SET workflow_state = 'manual_review',
         start_attempt_count = CASE
           WHEN start_attempt_count = 0 THEN 1 ELSE start_attempt_count
         END,
         last_attempt_at = COALESCE(last_attempt_at, ?),
         completed_at = ?,
         settlement_outcome = '',
         settled_transition_id = NULL,
         last_reconciliation_run_id = ?,
         last_error_code = ?,
         updated_at = ?
     WHERE reward_id = ?
       AND workflow_state IN ('pending', 'started', 'start_failed')`,
  ).bind(
    timestamp,
    timestamp,
    reconciliationRunId || null,
    errorCode,
    timestamp,
    normalizedRewardId,
  ).run();
  const job = await loadProtectionJob(database, normalizedRewardId);
  if (!job) throw protectionError("referral_protection_job_not_found");
  return Object.freeze({
    status: job.workflow_state,
    rewardId: normalizedRewardId,
    protectionJobId: String(job.protection_job_id),
    reason: String(job.last_error_code),
  });
}

export async function repairReferralProtectionWorkflows(
  env,
  { limit = 25, requestedAt = nowSeconds() } = {},
) {
  const gate = confirmationsDecision(env);
  if (!gate.enabled) {
    return Object.freeze({ status: "disabled", reason: gate.reason, results: [] });
  }
  const pageSize = Number(limit);
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_REPAIR_BATCH
  ) {
    throw protectionError("referral_protection_repair_limit_invalid");
  }
  const timestamp = validateClock(requestedAt, "requestedAt");
  const database = requireDatabase(env);
  const rows = await database.prepare(
    `SELECT reward.reward_id
     FROM referral_rewards reward
     LEFT JOIN referral_reward_protection_jobs job
       ON job.reward_id = reward.reward_id
     WHERE reward.reward_status = 'pending'
       AND (
         job.reward_id IS NULL
         OR job.workflow_state IN ('pending', 'start_failed')
       )
     ORDER BY reward.confirm_after, reward.reward_id
     LIMIT ?`,
  ).bind(pageSize).all();
  const results = [];
  for (const row of rows?.results || []) {
    results.push(await ensureReferralProtectionWorkflow(env, {
      rewardId: row.reward_id,
      requestedAt: timestamp,
    }));
  }
  return Object.freeze({
    status: "completed",
    attempted: results.length,
    results: Object.freeze(results),
  });
}
