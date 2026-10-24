import {
  REFERRAL_REWARD_PROGRAM_CODE,
  REFERRAL_REWARD_SECONDS,
  isPaymentInsideEligibilityWindow,
  paymentEligibilityDeadline,
  readReferralRewardConfig,
  requireUnixSeconds,
  rewardConfirmationTime,
} from "./referral-reward-foundation.mjs";
import { inspectPackageReferralSchema } from "../v1.4.4/package-referral-contract.mjs";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PAID_PLAN_CODES = new Set(["professional", "dragon"]);
const MAX_ROLLOUT_IDS = 500;

function nowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function candidateError(code, cause) {
  const error = new Error("Referral reward candidate operation rejected");
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function requireDatabase(env) {
  if (!env?.DB?.prepare || !env?.DB?.batch) {
    throw candidateError("referral_database_not_ready");
  }
  return env.DB;
}

function normalizeTelegramId(value) {
  const normalized =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value;
  return Number.isSafeInteger(normalized) && normalized > 0
    ? normalized
    : null;
}

function validateOrderId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!UUID_V4.test(normalized)) {
    throw candidateError("referral_order_id_invalid");
  }
  return normalized;
}

function validateSelectionTime(value) {
  try {
    return requireUnixSeconds(value ?? nowSeconds(), "selectedAt");
  } catch (cause) {
    throw candidateError("referral_selection_clock_invalid", cause);
  }
}

function evidenceUnixSeconds(value) {
  try {
    return requireUnixSeconds(value, "evidence timestamp");
  } catch {
    return null;
  }
}

function rolloutAllowlist(env) {
  const ids = String(env?.REFERRAL_REWARD_ROLLOUT_ALLOWLIST || "")
    .split(/[\s,;]+/)
    .map(normalizeTelegramId)
    .filter(Boolean)
    .slice(0, MAX_ROLLOUT_IDS);
  return new Set(ids);
}

export function getReferralRewardRolloutDecision(env, telegramId) {
  const config = readReferralRewardConfig(env);
  const userId = normalizeTelegramId(telegramId);
  if (!userId) throw candidateError("referral_telegram_id_invalid");

  if (!config.candidateWritesEnabled) {
    return Object.freeze({
      eligible: false,
      mode: config.rolloutMode,
      reason:
        config.configurationProblems[0] || "referral_candidates_disabled",
    });
  }

  const adminId = normalizeTelegramId(env?.ADMIN_ID);
  const allowlist = rolloutAllowlist(env);
  if (config.rolloutMode === "public") {
    return Object.freeze({
      eligible: true,
      mode: config.rolloutMode,
      reason: "public_rollout",
    });
  }
  if (config.rolloutMode === "admin") {
    const eligible = Boolean(adminId && userId === adminId);
    return Object.freeze({
      eligible,
      mode: config.rolloutMode,
      reason: eligible
        ? "admin_canary"
        : adminId
          ? "admin_canary_only"
          : "referral_admin_id_missing",
    });
  }
  if (config.rolloutMode === "allowlist") {
    const eligible = Boolean(
      (adminId && userId === adminId) || allowlist.has(userId),
    );
    return Object.freeze({
      eligible,
      mode: config.rolloutMode,
      reason: eligible ? "allowlist_canary" : "not_allowlisted",
    });
  }
  return Object.freeze({
    eligible: false,
    mode: "off",
    reason: "referral_rollout_off",
  });
}

async function loadStoredCandidate(database, orderId) {
  return database.prepare(
    `SELECT candidate.candidate_id, candidate.source_order_id,
            candidate.buyer_telegram_id, candidate.inviter_telegram_id,
            candidate.confirm_after,
            reward.reward_id, reward.reward_status,
            EXISTS (
              SELECT 1
              FROM referral_reward_transitions transition
              WHERE transition.reward_id = reward.reward_id
                AND transition.transition_scope = 'reward'
                AND transition.from_status = 'none'
                AND transition.to_status = 'pending'
                AND transition.from_revision = 0
                AND transition.to_revision = 1
            ) AS has_initial_transition
     FROM referral_reward_candidates candidate
     LEFT JOIN referral_rewards reward
       ON reward.candidate_id = candidate.candidate_id
     WHERE candidate.source_order_id = ?
     LIMIT 1`,
  ).bind(orderId).first();
}

async function loadOccupiedSlot(database, buyerId, inviterId) {
  // The additive registry retains every legacy claim, including cancelled
  // rewards, and shares lifetime limits with genuine package candidates.
  // Before that schema is installed, preserve the original legacy query.
  const schema = await inspectPackageReferralSchema(database, { required: false });
  if (schema.present) {
    return database.prepare(
      `SELECT
         (SELECT source_order_id FROM referral_reward_lifetime_slots
          WHERE program_code = ? AND buyer_telegram_id = ? LIMIT 1)
            AS buyer_source_order_id,
         (SELECT source_order_id FROM referral_reward_lifetime_slots
          WHERE program_code = ? AND inviter_telegram_id = ? LIMIT 1)
            AS inviter_source_order_id`,
    ).bind(REFERRAL_REWARD_PROGRAM_CODE, buyerId, REFERRAL_REWARD_PROGRAM_CODE, inviterId).first();
  }
  return database.prepare(
    `SELECT
       (
         SELECT source_order_id
         FROM referral_reward_candidates
         WHERE program_code = ?
           AND buyer_telegram_id = ?
         LIMIT 1
       ) AS buyer_source_order_id,
       (
         SELECT source_order_id
         FROM referral_reward_candidates
         WHERE program_code = ?
           AND inviter_telegram_id = ?
         LIMIT 1
       ) AS inviter_source_order_id`,
  ).bind(
    REFERRAL_REWARD_PROGRAM_CODE,
    buyerId,
    REFERRAL_REWARD_PROGRAM_CODE,
    inviterId,
  ).first();
}

async function loadEligibilityEvidence(database, orderId) {
  return database.prepare(
    `SELECT
       orders.order_id,
       orders.telegram_id AS buyer_telegram_id,
       orders.plan_code AS buyer_plan_code,
       orders.amount_stars,
       orders.currency,
       orders.order_state,
       orders.applied_at,
       access_grant.grant_id AS source_access_grant_id,
       access_grant.telegram_id AS grant_telegram_id,
       access_grant.plan_code AS grant_plan_code,
       access_grant.status AS grant_status,
       payment.ledger_entry_id AS source_payment_ledger_entry_id,
       payment.telegram_id AS payment_telegram_id,
       payment.entry_type AS payment_entry_type,
       payment.direction AS payment_direction,
       payment.currency AS payment_currency,
       payment.amount_stars AS payment_amount_stars,
       payment.occurred_at AS paid_at,
       user.inviter_id AS inviter_telegram_id,
       CAST(strftime('%s', user.inviter_bound_at) AS INTEGER)
         AS inviter_bound_at,
       EXISTS (
         WITH RECURSIVE inviter_chain(telegram_id) AS (
           SELECT user.inviter_id
           UNION
           SELECT ancestor.inviter_id
           FROM users ancestor
           JOIN inviter_chain chain
             ON ancestor.telegram_id = chain.telegram_id
           WHERE ancestor.inviter_id IS NOT NULL
         )
         SELECT 1
         FROM inviter_chain
         WHERE telegram_id = orders.telegram_id
       ) AS has_invitation_cycle,
       (
         SELECT CAST(strftime('%s', MIN(starts.started_at)) AS INTEGER)
         FROM bot_start_events starts
         WHERE starts.telegram_id = orders.telegram_id
           AND starts.is_new_user = 1
       ) AS first_started_at,
       EXISTS (
         SELECT 1
         FROM payment_ledger compensation
         WHERE compensation.related_ledger_entry_id =
           payment.ledger_entry_id
           AND compensation.entry_type IN ('refund', 'chargeback')
       ) AS has_compensation,
       EXISTS (
         SELECT 1
         FROM payment_ledger earlier
         JOIN subscription_orders earlier_order
           ON earlier_order.order_id = earlier.order_id
         WHERE earlier.telegram_id = orders.telegram_id
           AND earlier.entry_type = 'payment'
           AND earlier.direction = 'credit'
           AND earlier.currency = 'XTR'
           AND earlier_order.plan_code IN ('professional', 'dragon')
           AND (
             earlier.occurred_at < payment.occurred_at
             OR (
               earlier.occurred_at = payment.occurred_at
               AND earlier.ledger_entry_id < payment.ledger_entry_id
             )
           )
       ) AS has_earlier_paid_purchase
     FROM subscription_orders orders
     LEFT JOIN subscription_access_grants access_grant
       ON access_grant.order_id = orders.order_id
     LEFT JOIN payment_ledger payment
       ON payment.ledger_entry_id = access_grant.payment_ledger_entry_id
     LEFT JOIN users user
       ON user.telegram_id = orders.telegram_id
     WHERE orders.order_id = ?
     LIMIT 1`,
  ).bind(orderId).first();
}

function ineligible(reason, orderId) {
  return Object.freeze({ status: "ineligible", reason, orderId });
}

function storedResult(row, status) {
  if (
    !row?.candidate_id ||
    !row?.reward_id ||
    Number(row.has_initial_transition) !== 1
  ) {
    throw candidateError("referral_candidate_storage_invariant");
  }
  return Object.freeze({
    status,
    reason: status === "created"
      ? "first_eligible_paid_friend"
      : "candidate_already_recorded",
    orderId: String(row.source_order_id),
    candidateId: String(row.candidate_id),
    rewardId: String(row.reward_id),
    rewardStatus: String(row.reward_status),
    confirmAfter: Number(row.confirm_after),
  });
}

function evaluateEvidence(evidence, {
  orderId,
  selectedAt,
  programStartedAt,
}) {
  if (!evidence) return "payment_order_not_found";
  if (!PAID_PLAN_CODES.has(String(evidence.buyer_plan_code || ""))) {
    return "paid_plan_not_eligible";
  }
  if (evidence.order_state !== "applied") {
    return "payment_access_not_applied";
  }
  if (
    !evidence.source_payment_ledger_entry_id ||
    evidence.payment_entry_type !== "payment" ||
    evidence.payment_direction !== "credit" ||
    evidence.payment_currency !== "XTR" ||
    evidence.currency !== "XTR" ||
    Number(evidence.payment_telegram_id) !==
      Number(evidence.buyer_telegram_id) ||
    Number(evidence.payment_amount_stars) !== Number(evidence.amount_stars) ||
    !Number.isSafeInteger(Number(evidence.amount_stars)) ||
    Number(evidence.amount_stars) < 1 ||
    Number(evidence.amount_stars) > 10_000
  ) {
    return "payment_ledger_evidence_missing";
  }
  if (
    !evidence.source_access_grant_id ||
    evidence.grant_status !== "active" ||
    Number(evidence.grant_telegram_id) !==
      Number(evidence.buyer_telegram_id) ||
    evidence.grant_plan_code !== evidence.buyer_plan_code
  ) {
    return "active_access_grant_missing";
  }
  if (Number(evidence.has_compensation) === 1) {
    return "payment_already_compensated";
  }
  const buyerId = normalizeTelegramId(evidence.buyer_telegram_id);
  const inviterId = normalizeTelegramId(evidence.inviter_telegram_id);
  if (!buyerId) return "buyer_identity_invalid";
  if (!inviterId || !evidence.inviter_bound_at) {
    return "immutable_inviter_missing";
  }
  if (buyerId === inviterId) return "self_referral";
  if (Number(evidence.has_invitation_cycle) === 1) {
    return "invitation_cycle";
  }
  const firstStartedAt = evidenceUnixSeconds(evidence.first_started_at);
  if (firstStartedAt === null) {
    return "first_start_evidence_missing";
  }
  const inviterBoundAt = evidenceUnixSeconds(evidence.inviter_bound_at);
  const paidAt = evidenceUnixSeconds(evidence.paid_at);
  const appliedAt = evidenceUnixSeconds(evidence.applied_at);
  if (paidAt === null) return "payment_time_invalid";
  if (inviterBoundAt === null || inviterBoundAt > paidAt) {
    return "inviter_binding_invalid";
  }
  if (paidAt < programStartedAt) return "payment_before_program_start";
  if (
    appliedAt === null ||
    appliedAt < paidAt ||
    selectedAt < appliedAt ||
    selectedAt < paidAt
  ) {
    return "access_application_time_invalid";
  }
  if (!isPaymentInsideEligibilityWindow({ firstStartedAt, paidAt })) {
    return paidAt < firstStartedAt
      ? "payment_before_first_start"
      : "payment_after_eligibility_window";
  }
  if (Number(evidence.has_earlier_paid_purchase) === 1) {
    return "not_first_paid_purchase";
  }
  if (String(evidence.order_id) !== orderId) {
    return "payment_order_mismatch";
  }
  return null;
}

export async function createReferralRewardCandidate(env, {
  orderId,
  selectedAt = nowSeconds(),
} = {}) {
  const normalizedOrderId = validateOrderId(orderId);
  const timestamp = validateSelectionTime(selectedAt);
  const config = readReferralRewardConfig(env);
  if (!config.candidateWritesEnabled) {
    return Object.freeze({
      status: "disabled",
      reason:
        config.configurationProblems[0] || "referral_candidates_disabled",
      orderId: normalizedOrderId,
    });
  }

  const database = requireDatabase(env);
  const existing = await loadStoredCandidate(database, normalizedOrderId);
  if (existing) return storedResult(existing, "duplicate");

  const evidence = await loadEligibilityEvidence(database, normalizedOrderId);
  const evidenceReason = evaluateEvidence(evidence, {
    orderId: normalizedOrderId,
    selectedAt: timestamp,
    programStartedAt: config.programStartedAt,
  });
  if (evidenceReason) return ineligible(evidenceReason, normalizedOrderId);

  const buyerId = Number(evidence.buyer_telegram_id);
  const inviterId = Number(evidence.inviter_telegram_id);
  const rollout = getReferralRewardRolloutDecision(env, buyerId);
  if (!rollout.eligible) return ineligible(rollout.reason, normalizedOrderId);

  const occupied = await loadOccupiedSlot(database, buyerId, inviterId);
  if (occupied?.buyer_source_order_id) {
    return ineligible("buyer_reward_already_used", normalizedOrderId);
  }
  if (occupied?.inviter_source_order_id) {
    return ineligible("inviter_reward_already_used", normalizedOrderId);
  }

  const candidateId = crypto.randomUUID();
  const rewardId = crypto.randomUUID();
  const firstStartedAt = Number(evidence.first_started_at);
  const inviterBoundAt = Number(evidence.inviter_bound_at);
  const paidAt = Number(evidence.paid_at);
  const eligibleUntil = paymentEligibilityDeadline(firstStartedAt);
  const confirmAfter = rewardConfirmationTime(paidAt);
  const candidateKey =
    `candidate:${REFERRAL_REWARD_PROGRAM_CODE}:${normalizedOrderId}`;
  const rewardKey =
    `reward:${REFERRAL_REWARD_PROGRAM_CODE}:${normalizedOrderId}`;

  try {
    await database.batch([
      database.prepare(
        `INSERT INTO referral_reward_candidates (
           candidate_id, candidate_key, program_code,
           buyer_telegram_id, inviter_telegram_id,
           source_order_id, source_payment_ledger_entry_id,
           source_access_grant_id, buyer_plan_code, amount_stars,
           first_started_at, inviter_bound_at, paid_at,
           eligible_until, confirm_after, selected_at,
           selection_reason, schema_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      ).bind(
        candidateId,
        candidateKey,
        REFERRAL_REWARD_PROGRAM_CODE,
        buyerId,
        inviterId,
        normalizedOrderId,
        evidence.source_payment_ledger_entry_id,
        evidence.source_access_grant_id,
        evidence.buyer_plan_code,
        Number(evidence.amount_stars),
        firstStartedAt,
        inviterBoundAt,
        paidAt,
        eligibleUntil,
        confirmAfter,
        timestamp,
        "first_eligible_paid_friend",
        timestamp,
      ),
      database.prepare(
        `INSERT INTO referral_rewards (
           reward_id, reward_key, candidate_id, program_code,
           beneficiary_telegram_id, buyer_telegram_id, reward_seconds,
           reward_status, confirm_after, confirmed_at, cancelled_at,
           last_transition_id, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL,
                   NULL, 1, ?, ?)`,
      ).bind(
        rewardId,
        rewardKey,
        candidateId,
        REFERRAL_REWARD_PROGRAM_CODE,
        inviterId,
        buyerId,
        REFERRAL_REWARD_SECONDS.bonusAccess,
        confirmAfter,
        timestamp,
        timestamp,
      ),
    ]);
  } catch (cause) {
    const raced = await loadStoredCandidate(database, normalizedOrderId);
    if (raced) return storedResult(raced, "duplicate");
    const conflict = await loadOccupiedSlot(database, buyerId, inviterId);
    if (conflict?.buyer_source_order_id) {
      return ineligible("buyer_reward_already_used", normalizedOrderId);
    }
    if (conflict?.inviter_source_order_id) {
      return ineligible("inviter_reward_already_used", normalizedOrderId);
    }
    throw candidateError("referral_candidate_persistence_failed", cause);
  }

  const stored = await loadStoredCandidate(database, normalizedOrderId);
  if (!stored || stored.candidate_id !== candidateId) {
    throw candidateError("referral_candidate_storage_invariant");
  }
  return storedResult(stored, "created");
}
