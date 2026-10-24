import {
  REFERRAL_REWARD_PROGRAM_CODE,
  REFERRAL_REWARD_SECONDS,
  manualClaimExpiry,
  readReferralRewardConfig,
  requireUnixSeconds,
  resolveBonusDelivery,
} from "./referral-reward-foundation.mjs";
import { ensurePackageReferralBonusGrant,applyPackageReferralBonusCompensation } from '../v1.4.4/package-referral-bonus-runtime.mjs';
import { applyPackageReferralRewardCompensation } from '../v1.4.4/package-referral-runtime.mjs';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PAID_ACCESS_STATES = new Set(["active", "cancel_at_period_end"]);
const MANUAL_ACCESS_STATES = new Set([
  "none",
  "trial",
  "expired",
  "refunded",
]);
const TERMINAL_GRANT_STATES = new Set([
  "expired",
  "revoked",
  "manual_review",
]);
const MAX_MAINTENANCE_BATCH = 50;
const SOURCE_MANUAL = "referral_bonus_manual";
const SOURCE_EXTENSION = "referral_bonus_extension";
const SOURCE_EXPIRED = "referral_bonus_expired";
const SOURCE_COMPENSATION = "referral_bonus_compensation";

function nowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function bonusError(code, cause) {
  const error = new Error("Referral bonus access operation rejected");
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export function safeReferralBonusErrorCode(
  error,
  fallback = "referral_bonus_access_error",
) {
  return String(error?.code || error?.name || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 64);
}

function requireDatabase(env) {
  if (!env?.DB?.prepare || !env?.DB?.batch) {
    throw bonusError("referral_bonus_database_not_ready");
  }
  return env.DB;
}

function validateUuid(value, code) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!UUID_V4.test(normalized)) throw bonusError(code);
  return normalized;
}

function validateTelegramId(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw bonusError("referral_bonus_telegram_id_invalid");
  }
  return normalized;
}

function validateClock(value, fieldName = "recordedAt") {
  try {
    return requireUnixSeconds(value ?? nowSeconds(), fieldName);
  } catch (cause) {
    throw bonusError("referral_bonus_clock_invalid", cause);
  }
}

function sqlDateTime(timestamp) {
  return new Date(Number(timestamp) * 1_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

function unixFromSqlDateTime(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.includes("T")
    ? value
    : `${value.trim().replace(" ", "T")}Z`;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds)
    ? Math.floor(milliseconds / 1_000)
    : null;
}

function bonusGate(env) {
  const config = readReferralRewardConfig(env);
  return Object.freeze({
    enabled: config.bonusGrantsEnabled,
    reason: config.bonusGrantsEnabled
      ? "referral_bonus_grants_enabled"
      : config.configurationProblems[0] || "referral_bonus_grants_disabled",
  });
}

async function loadRewardEvidence(database, rewardId) {
  return database.prepare(
    `SELECT
       reward.reward_id,
       reward.candidate_id,
       reward.program_code,
       reward.beneficiary_telegram_id,
       reward.buyer_telegram_id,
       reward.reward_seconds,
       reward.reward_status,
       reward.confirm_after,
       reward.confirmed_at,
       reward.cancelled_at,
       reward.last_transition_id AS reward_last_transition_id,
       reward.revision AS reward_revision,
       candidate.source_order_id,
       candidate.source_payment_ledger_entry_id,
       candidate.source_access_grant_id,
       compensation.ledger_entry_id AS compensation_ledger_entry_id,
       compensation.entry_type AS compensation_type,
       compensation.occurred_at AS compensation_occurred_at,
       compensation.recorded_at AS compensation_recorded_at,
       grant_record.bonus_grant_id,
       grant_record.delivery_mode,
       grant_record.plan_code AS bonus_plan_code,
       grant_record.grant_status,
       grant_record.available_at,
       grant_record.claim_expires_at,
       grant_record.claimed_at,
       grant_record.applied_at,
       grant_record.starts_at,
       grant_record.ends_at,
       grant_record.target_subscription_id,
       grant_record.compensation_ledger_entry_id AS grant_compensation_id,
       grant_record.compensated_seconds,
       grant_record.last_transition_id AS grant_last_transition_id,
       grant_record.revision AS grant_revision,
       effect.effect_id,
       effect.effect_kind,
       effect.applied_transition_id,
       effect.prior_plan_code AS effect_prior_plan_code,
       effect.prior_access_state AS effect_prior_access_state,
       effect.result_plan_revision AS effect_plan_revision,
       effect.result_access_revision AS effect_access_revision,
       effect.result_subscription_revision AS effect_subscription_revision,
       plans.plan_code AS current_plan_code,
       plans.source_code AS plan_source_code,
       plans.effective_until AS plan_effective_until,
       plans.revision AS plan_revision,
       access_state.access_state AS current_access_state,
       access_state.source_code AS access_source_code,
       access_state.state_ends_at AS access_state_ends_at,
       access_state.revision AS access_revision,
       legacy.access_tier AS legacy_access_tier,
       subscription.subscription_id AS current_subscription_id,
       subscription.plan_code AS subscription_plan_code,
       subscription.status AS subscription_status,
       subscription.current_period_end,
       subscription.last_ledger_entry_id AS subscription_last_ledger_entry_id,
       subscription.revision AS subscription_revision,
       preview.grant_id AS preview_grant_id,
       preview.status AS preview_status,
       preview.ends_at AS preview_ends_at
     FROM referral_rewards reward
     JOIN referral_reward_candidates candidate
       ON candidate.candidate_id = reward.candidate_id
     LEFT JOIN bonus_access_grants grant_record
       ON grant_record.reward_id = reward.reward_id
     LEFT JOIN bonus_access_effects effect
       ON effect.bonus_grant_id = grant_record.bonus_grant_id
     LEFT JOIN user_plans plans
       ON plans.telegram_id = reward.beneficiary_telegram_id
     LEFT JOIN user_access_states access_state
       ON access_state.telegram_id = reward.beneficiary_telegram_id
     LEFT JOIN user_access legacy
       ON legacy.telegram_id = reward.beneficiary_telegram_id
     LEFT JOIN subscriptions subscription
       ON subscription.subscription_id = (
         SELECT current_subscription.subscription_id
         FROM subscriptions current_subscription
         WHERE current_subscription.telegram_id = reward.beneficiary_telegram_id
           AND current_subscription.status IN (
             'active', 'cancel_at_period_end', 'suspended'
           )
         ORDER BY current_subscription.current_period_end DESC,
                  current_subscription.created_at DESC,
                  current_subscription.subscription_id
         LIMIT 1
       )
     LEFT JOIN trial_grants preview
       ON preview.grant_id = (
         SELECT current_preview.grant_id
         FROM trial_grants current_preview
         WHERE current_preview.telegram_id = reward.beneficiary_telegram_id
           AND current_preview.program_code = 'dragon_preview'
         ORDER BY current_preview.granted_at DESC, current_preview.grant_id
         LIMIT 1
       )
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

async function loadGrantEvidence(database, bonusGrantId, telegramId = null) {
  const identity = await database.prepare(
    `SELECT reward_id, beneficiary_telegram_id
     FROM bonus_access_grants
     WHERE bonus_grant_id = ?
       AND (? IS NULL OR beneficiary_telegram_id = ?)
     LIMIT 1`,
  ).bind(bonusGrantId, telegramId, telegramId).first();
  if (!identity) return null;
  return loadRewardEvidence(database, identity.reward_id);
}

function grantResult(evidence, status = null, reason = null) {
  const resolvedStatus = status || evidence?.grant_status || "unavailable";
  return Object.freeze({
    status: resolvedStatus,
    reason,
    rewardId: evidence?.reward_id ? String(evidence.reward_id) : null,
    bonusGrantId: evidence?.bonus_grant_id
      ? String(evidence.bonus_grant_id)
      : null,
    deliveryMode: evidence?.delivery_mode || null,
    planCode: evidence?.bonus_plan_code || null,
    availableAt: Number(evidence?.available_at || 0) || null,
    claimExpiresAt: Number(evidence?.claim_expires_at || 0) || null,
    startsAt: Number(evidence?.starts_at || 0) || null,
    endsAt: Number(evidence?.ends_at || 0) || null,
    targetSubscriptionId: evidence?.target_subscription_id || null,
    effectId: evidence?.effect_id || null,
  });
}

function canonicalDeliveryProblem(evidence, timestamp) {
  if (!evidence.current_plan_code || !evidence.current_access_state) {
    return "referral_bonus_canonical_access_missing";
  }
  if (
    !Number.isSafeInteger(Number(evidence.plan_revision)) ||
    Number(evidence.plan_revision) <= 0 ||
    !Number.isSafeInteger(Number(evidence.access_revision)) ||
    Number(evidence.access_revision) <= 0
  ) {
    return "referral_bonus_canonical_revision_invalid";
  }
  if (String(evidence.legacy_access_tier || "").toLowerCase() === "team") {
    return "referral_bonus_legacy_team_requires_review";
  }
  if (evidence.current_access_state === "suspended") {
    return "referral_bonus_access_suspended";
  }

  const isPaid = ["professional", "dragon"].includes(
    evidence.current_plan_code,
  );
  if (isPaid && PAID_ACCESS_STATES.has(evidence.current_access_state)) {
    const planEndsAt = unixFromSqlDateTime(evidence.plan_effective_until);
    const accessEndsAt = unixFromSqlDateTime(evidence.access_state_ends_at);
    if (
      !evidence.current_subscription_id ||
      evidence.subscription_plan_code !== evidence.current_plan_code ||
      evidence.subscription_status !== evidence.current_access_state ||
      Number(evidence.current_period_end) <= timestamp ||
      planEndsAt !== Number(evidence.current_period_end) ||
      accessEndsAt !== Number(evidence.current_period_end) ||
      !Number.isSafeInteger(Number(evidence.subscription_revision)) ||
      Number(evidence.subscription_revision) <= 0
    ) {
      return "referral_bonus_paid_projection_mismatch";
    }
    return null;
  }

  if (
    evidence.current_plan_code === "free" &&
    MANUAL_ACCESS_STATES.has(evidence.current_access_state)
  ) {
    if (
      evidence.current_subscription_id &&
      Number(evidence.current_period_end) > timestamp
    ) {
      return "referral_bonus_paid_projection_conflict";
    }
    if (
      evidence.current_access_state === "trial" &&
      (
        !evidence.preview_grant_id ||
        evidence.preview_status !== "active" ||
        Number(evidence.preview_ends_at) <= timestamp ||
        unixFromSqlDateTime(evidence.access_state_ends_at) !==
          Number(evidence.preview_ends_at)
      )
    ) {
      return "referral_bonus_preview_projection_mismatch";
    }
    return null;
  }
  return "referral_bonus_delivery_state_unsupported";
}

function addSeconds(timestamp, seconds) {
  return requireUnixSeconds(timestamp, "effectStartsAt") + Number(seconds);
}

function transitionStatement(database, {
  transitionId,
  transitionKey,
  rewardId,
  bonusGrantId,
  fromStatus,
  toStatus,
  fromRevision,
  reasonCode,
  actorType,
  actorId = null,
  ledgerEntryId,
  effectStartsAt = null,
  effectEndsAt = null,
  compensatedSeconds = 0,
  occurredAt,
  recordedAt,
}) {
  return database.prepare(
    `INSERT INTO referral_reward_transitions (
       transition_id, transition_key, transition_scope, reward_id,
       bonus_grant_id, from_status, to_status, from_revision, to_revision,
       reason_code, actor_type, actor_id, related_payment_ledger_entry_id,
       effect_starts_at, effect_ends_at, compensated_seconds,
       occurred_at, recorded_at
     ) VALUES (?, ?, 'bonus_grant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    transitionId,
    transitionKey,
    rewardId,
    bonusGrantId,
    fromStatus,
    toStatus,
    Number(fromRevision),
    Number(fromRevision) + 1,
    reasonCode,
    actorType,
    actorId,
    ledgerEntryId,
    effectStartsAt,
    effectEndsAt,
    compensatedSeconds,
    occurredAt,
    recordedAt,
  );
}

async function insertManualGrant(database, evidence, timestamp) {
  const bonusGrantId = crypto.randomUUID();
  const claimExpiresAt = manualClaimExpiry(Number(evidence.confirmed_at));
  const statements = [
    database.prepare(
      `INSERT INTO bonus_access_grants (
         bonus_grant_id, grant_key, reward_id, program_code,
         beneficiary_telegram_id, delivery_mode, plan_code, bonus_seconds,
         grant_status, available_at, claim_expires_at,
         claimed_at, applied_at, starts_at, ends_at,
         target_subscription_id, compensation_ledger_entry_id,
         compensated_seconds, compensated_at, last_transition_id,
         revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'manual_claim', 'professional', ?,
                 'claimable', ?, ?, NULL, NULL, NULL, NULL, NULL,
                 NULL, 0, NULL, NULL, 1, ?, ?)`,
    ).bind(
      bonusGrantId,
      `bonus:${REFERRAL_REWARD_PROGRAM_CODE}:${evidence.reward_id}`,
      evidence.reward_id,
      REFERRAL_REWARD_PROGRAM_CODE,
      Number(evidence.beneficiary_telegram_id),
      REFERRAL_REWARD_SECONDS.bonusAccess,
      Number(evidence.confirmed_at),
      claimExpiresAt,
      timestamp,
      timestamp,
    ),
  ];
  if (timestamp > claimExpiresAt) {
    const transitionId = crypto.randomUUID();
    statements.push(transitionStatement(database, {
      transitionId,
      transitionKey: `bonus-expired:${bonusGrantId}`,
      rewardId: evidence.reward_id,
      bonusGrantId,
      fromStatus: "claimable",
      toStatus: "expired",
      fromRevision: 1,
      reasonCode: "claim_window_expired",
      actorType: "workflow",
      ledgerEntryId: evidence.source_payment_ledger_entry_id,
      occurredAt: timestamp,
      recordedAt: timestamp,
    }));
  }
  await database.batch(statements);
  return loadRewardEvidence(database, evidence.reward_id);
}

async function insertAndApplyExtension(database, evidence, timestamp) {
  const bonusGrantId = crypto.randomUUID();
  const transitionId = crypto.randomUUID();
  const effectId = crypto.randomUUID();
  const startsAt = Number(evidence.current_period_end);
  const endsAt = addSeconds(
    startsAt,
    REFERRAL_REWARD_SECONDS.bonusAccess,
  );
  const endsSql = sqlDateTime(endsAt);
  const userId = Number(evidence.beneficiary_telegram_id);
  const planCode = String(evidence.current_plan_code);
  const accessState = String(evidence.current_access_state);
  const planRevision = Number(evidence.plan_revision);
  const accessRevision = Number(evidence.access_revision);
  const subscriptionRevision = Number(evidence.subscription_revision);

  await database.batch([
    database.prepare(
      `INSERT INTO bonus_access_grants (
         bonus_grant_id, grant_key, reward_id, program_code,
         beneficiary_telegram_id, delivery_mode, plan_code, bonus_seconds,
         grant_status, available_at, claim_expires_at,
         claimed_at, applied_at, starts_at, ends_at,
         target_subscription_id, compensation_ledger_entry_id,
         compensated_seconds, compensated_at, last_transition_id,
         revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'extend_active_plan', ?, ?, 'pending', ?,
                 NULL, NULL, NULL, NULL, NULL, ?, NULL, 0, NULL, NULL,
                 1, ?, ?)`,
    ).bind(
      bonusGrantId,
      `bonus:${REFERRAL_REWARD_PROGRAM_CODE}:${evidence.reward_id}`,
      evidence.reward_id,
      REFERRAL_REWARD_PROGRAM_CODE,
      userId,
      planCode,
      REFERRAL_REWARD_SECONDS.bonusAccess,
      Number(evidence.confirmed_at),
      evidence.current_subscription_id,
      timestamp,
      timestamp,
    ),
    transitionStatement(database, {
      transitionId,
      transitionKey: `bonus-extension:${bonusGrantId}`,
      rewardId: evidence.reward_id,
      bonusGrantId,
      fromStatus: "pending",
      toStatus: "applied",
      fromRevision: 1,
      reasonCode: "active_plan_extension",
      actorType: "workflow",
      ledgerEntryId: evidence.source_payment_ledger_entry_id,
      effectStartsAt: startsAt,
      effectEndsAt: endsAt,
      occurredAt: timestamp,
      recordedAt: timestamp,
    }),
    database.prepare(
      `UPDATE subscriptions
       SET current_period_end = ?, revision = revision + 1, updated_at = ?
       WHERE subscription_id = ? AND telegram_id = ? AND plan_code = ?
         AND status = ? AND revision = ? AND current_period_end = ?`,
    ).bind(
      endsAt,
      timestamp,
      evidence.current_subscription_id,
      userId,
      planCode,
      accessState,
      subscriptionRevision,
      startsAt,
    ),
    database.prepare(
      `UPDATE user_plans
       SET source_code = ?, effective_until = ?, revision = revision + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND plan_code = ? AND revision = ?`,
    ).bind(SOURCE_EXTENSION, endsSql, userId, planCode, planRevision),
    database.prepare(
      `UPDATE user_access_states
       SET source_code = ?, state_ends_at = ?, revision = revision + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND access_state = ? AND revision = ?`,
    ).bind(SOURCE_EXTENSION, endsSql, userId, accessState, accessRevision),
    database.prepare(
      `INSERT OR IGNORE INTO access_status_history (
         event_id, telegram_id, plan_code, from_state, to_state,
         source_code, related_grant_id, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      `referral-bonus:${bonusGrantId}`,
      userId,
      planCode,
      accessState,
      accessState,
      SOURCE_EXTENSION,
      bonusGrantId,
      timestamp,
    ),
    database.prepare(
      `INSERT INTO bonus_access_effects (
         effect_id, effect_key, bonus_grant_id, reward_id,
         beneficiary_telegram_id, effect_kind, plan_code,
         prior_plan_code, prior_access_state,
         prior_plan_revision, result_plan_revision,
         prior_access_revision, result_access_revision,
         target_subscription_id, prior_subscription_revision,
         result_subscription_revision, source_payment_ledger_entry_id,
         applied_transition_id, effect_starts_at, effect_ends_at, recorded_at
       ) VALUES (?, ?, ?, ?, ?, 'paid_plan_extension', ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      effectId,
      `bonus-effect:${bonusGrantId}`,
      bonusGrantId,
      evidence.reward_id,
      userId,
      planCode,
      planCode,
      accessState,
      planRevision,
      planRevision + 1,
      accessRevision,
      accessRevision + 1,
      evidence.current_subscription_id,
      subscriptionRevision,
      subscriptionRevision + 1,
      evidence.source_payment_ledger_entry_id,
      transitionId,
      startsAt,
      endsAt,
      timestamp,
    ),
  ]);
  return loadRewardEvidence(database, evidence.reward_id);
}

export async function ensureReferralBonusGrant(
  env,
  { rewardId, deliveredAt = nowSeconds() } = {},
) {
  const normalizedRewardId = validateUuid(
    rewardId,
    "referral_reward_id_invalid",
  );
  const timestamp = validateClock(deliveredAt, "deliveredAt");
  const gate = bonusGate(env);
  if (!gate.enabled) {
    return Object.freeze({
      status: "disabled",
      reason: gate.reason,
      rewardId: normalizedRewardId,
    });
  }
  const database = requireDatabase(env);
  let evidence = await loadRewardEvidence(database, normalizedRewardId);
  if (!evidence) throw bonusError("referral_reward_not_found");
  if (evidence.bonus_grant_id) return grantResult(evidence, "duplicate");
  if (evidence.reward_status === "cancelled") {
    return grantResult(evidence, "unavailable", "referral_reward_cancelled");
  }
  if (evidence.reward_status !== "confirmed" || !evidence.confirmed_at) {
    return grantResult(evidence, "waiting", "referral_reward_not_confirmed");
  }
  if (timestamp < Number(evidence.confirmed_at)) {
    throw bonusError("referral_bonus_delivery_before_confirmation");
  }
  if (evidence.compensation_ledger_entry_id) {
    const compensation = await applyReferralRewardCompensation(env, {
      compensationLedgerEntryId: evidence.compensation_ledger_entry_id,
      recordedAt: Math.max(timestamp, Number(evidence.compensation_recorded_at)),
    });
    return Object.freeze({
      ...grantResult(evidence, "unavailable", "referral_payment_compensated"),
      compensation,
    });
  }

  const packageDelivery=await ensurePackageReferralBonusGrant(env,{rewardId:normalizedRewardId,rewardKind:'legacy',deliveredAt:timestamp});
  if(packageDelivery.status!=='not_applicable') return packageDelivery;

  const problem = canonicalDeliveryProblem(evidence, timestamp);
  if (problem) return grantResult(evidence, "manual_review", problem);
  let delivery;
  try {
    delivery = resolveBonusDelivery({
      currentPlanCode: evidence.current_plan_code,
      accessState: evidence.current_access_state,
    });
  } catch (cause) {
    return grantResult(
      evidence,
      "manual_review",
      safeReferralBonusErrorCode(cause, "referral_bonus_delivery_unsupported"),
    );
  }

  try {
    evidence = delivery.deliveryMode === "extend_active_plan"
      ? await insertAndApplyExtension(database, evidence, timestamp)
      : await insertManualGrant(database, evidence, timestamp);
  } catch (cause) {
    evidence = await loadRewardEvidence(database, normalizedRewardId);
    if (evidence?.bonus_grant_id) return grantResult(evidence, "duplicate");
    if (evidence?.compensation_ledger_entry_id) {
      return grantResult(
        evidence,
        "manual_review",
        "referral_payment_compensation_race",
      );
    }
    throw bonusError("referral_bonus_grant_persistence_failed", cause);
  }

  if (!evidence?.bonus_grant_id) {
    throw bonusError("referral_bonus_grant_invariant_failed");
  }
  if (
    delivery.deliveryMode === "extend_active_plan" &&
    (evidence.grant_status !== "applied" || !evidence.effect_id)
  ) {
    throw bonusError("referral_bonus_extension_invariant_failed");
  }
  return grantResult(evidence);
}

export async function expireReferralBonusClaim(
  env,
  { bonusGrantId, expiredAt = nowSeconds() } = {},
) {
  const normalizedGrantId = validateUuid(
    bonusGrantId,
    "referral_bonus_grant_id_invalid",
  );
  const timestamp = validateClock(expiredAt, "expiredAt");
  const database = requireDatabase(env);
  let evidence = await loadGrantEvidence(database, normalizedGrantId);
  if (!evidence) throw bonusError("referral_bonus_grant_not_found");
  if (evidence.grant_status !== "claimable") {
    return grantResult(evidence, "not_due", "referral_bonus_claim_not_open");
  }
  if (timestamp <= Number(evidence.claim_expires_at)) {
    return grantResult(evidence, "not_due", "referral_bonus_claim_window_open");
  }
  const transitionId = crypto.randomUUID();
  try {
    await database.batch([
      transitionStatement(database, {
        transitionId,
        transitionKey: `bonus-expired:${normalizedGrantId}`,
        rewardId: evidence.reward_id,
        bonusGrantId: normalizedGrantId,
        fromStatus: "claimable",
        toStatus: "expired",
        fromRevision: Number(evidence.grant_revision),
        reasonCode: "claim_window_expired",
        actorType: "workflow",
        ledgerEntryId: evidence.source_payment_ledger_entry_id,
        occurredAt: timestamp,
        recordedAt: timestamp,
      }),
    ]);
  } catch (cause) {
    evidence = await loadGrantEvidence(database, normalizedGrantId);
    if (evidence && evidence.grant_status !== "claimable") {
      return grantResult(evidence, "duplicate");
    }
    throw bonusError("referral_bonus_claim_expiry_failed", cause);
  }
  evidence = await loadGrantEvidence(database, normalizedGrantId);
  return grantResult(evidence, "expired");
}

export async function claimReferralBonusAccess(
  env,
  {
    telegramId,
    bonusGrantId,
    claimedAt = nowSeconds(),
  } = {},
) {
  const userId = validateTelegramId(telegramId);
  const normalizedGrantId = validateUuid(
    bonusGrantId,
    "referral_bonus_grant_id_invalid",
  );
  const timestamp = validateClock(claimedAt, "claimedAt");
  const gate = bonusGate(env);
  if (!gate.enabled) {
    return Object.freeze({
      status: "disabled",
      reason: gate.reason,
      bonusGrantId: normalizedGrantId,
    });
  }
  const database = requireDatabase(env);
  let evidence = await loadGrantEvidence(database, normalizedGrantId, userId);
  if (!evidence) throw bonusError("referral_bonus_grant_not_found");
  if (evidence.grant_status === "applied") {
    return grantResult(evidence, "duplicate");
  }
  if (TERMINAL_GRANT_STATES.has(evidence.grant_status)) {
    return grantResult(evidence);
  }
  if (
    evidence.delivery_mode !== "manual_claim" ||
    evidence.grant_status !== "claimable"
  ) {
    return grantResult(evidence, "manual_review", "referral_bonus_not_claimable");
  }
  if (timestamp < Number(evidence.available_at)) {
    throw bonusError("referral_bonus_claim_before_available");
  }
  if (timestamp > Number(evidence.claim_expires_at)) {
    return expireReferralBonusClaim(env, {
      bonusGrantId: normalizedGrantId,
      expiredAt: timestamp,
    });
  }
  if (
    evidence.reward_status !== "confirmed" ||
    evidence.compensation_ledger_entry_id
  ) {
    return grantResult(
      evidence,
      "manual_review",
      "referral_bonus_reward_not_valid",
    );
  }
  const problem = canonicalDeliveryProblem(evidence, timestamp);
  if (problem) return grantResult(evidence, "manual_review", problem);
  let delivery;
  try {
    delivery = resolveBonusDelivery({
      currentPlanCode: evidence.current_plan_code,
      accessState: evidence.current_access_state,
    });
  } catch (cause) {
    return grantResult(
      evidence,
      "manual_review",
      safeReferralBonusErrorCode(cause, "referral_bonus_claim_state_unsupported"),
    );
  }
  if (delivery.deliveryMode !== "manual_claim") {
    return grantResult(
      evidence,
      "manual_review",
      "referral_bonus_paid_access_conflict",
    );
  }

  const startsAt = timestamp;
  const endsAt = addSeconds(startsAt, REFERRAL_REWARD_SECONDS.bonusAccess);
  const startsSql = sqlDateTime(startsAt);
  const endsSql = sqlDateTime(endsAt);
  const planRevision = Number(evidence.plan_revision);
  const accessRevision = Number(evidence.access_revision);
  const priorAccessState = String(evidence.current_access_state);
  const transitionId = crypto.randomUUID();
  const effectId = crypto.randomUUID();
  const statements = [
    transitionStatement(database, {
      transitionId,
      transitionKey: `bonus-claim:${normalizedGrantId}`,
      rewardId: evidence.reward_id,
      bonusGrantId: normalizedGrantId,
      fromStatus: "claimable",
      toStatus: "applied",
      fromRevision: Number(evidence.grant_revision),
      reasonCode: "manual_claim",
      actorType: "telegram",
      actorId: userId,
      ledgerEntryId: evidence.source_payment_ledger_entry_id,
      effectStartsAt: startsAt,
      effectEndsAt: endsAt,
      occurredAt: startsAt,
      recordedAt: startsAt,
    }),
    database.prepare(
      `UPDATE user_plans
       SET plan_code = 'professional', source_code = ?,
           effective_from = ?, effective_until = ?, revision = revision + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND plan_code = 'free' AND revision = ?`,
    ).bind(SOURCE_MANUAL, startsSql, endsSql, userId, planRevision),
    database.prepare(
      `UPDATE user_access_states
       SET access_state = 'active', source_code = ?, state_started_at = ?,
           state_ends_at = ?, revision = revision + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND access_state = ? AND revision = ?`,
    ).bind(
      SOURCE_MANUAL,
      startsSql,
      endsSql,
      userId,
      priorAccessState,
      accessRevision,
    ),
    database.prepare(
      `INSERT OR IGNORE INTO access_status_history (
         event_id, telegram_id, plan_code, from_state, to_state,
         source_code, related_grant_id, occurred_at
       ) VALUES (?, ?, 'professional', ?, 'active', ?, ?, ?)`,
    ).bind(
      `referral-bonus:${normalizedGrantId}`,
      userId,
      priorAccessState,
      SOURCE_MANUAL,
      normalizedGrantId,
      startsAt,
    ),
  ];

  if (priorAccessState === "trial") {
    statements.push(
      database.prepare(
        `UPDATE trial_grants
         SET status = 'expired', ended_at = ?, updated_at = ?
         WHERE grant_id = ? AND telegram_id = ?
           AND program_code = 'dragon_preview' AND status = 'active'
           AND ends_at > ?`,
      ).bind(
        startsAt,
        startsAt,
        evidence.preview_grant_id,
        userId,
        startsAt,
      ),
      database.prepare(
        `UPDATE notification_jobs
         SET status = 'suppressed', last_error_code = 'bonus_access_started',
             updated_at = ?
         WHERE telegram_id = ? AND related_grant_id = ?
           AND status IN ('pending', 'processing')`,
      ).bind(startsAt, userId, evidence.preview_grant_id),
      database.prepare(
        `INSERT OR IGNORE INTO trial_funnel_events (
           event_id, telegram_id, program_code, event_type,
           related_grant_id, occurred_at
         ) VALUES (?, ?, 'dragon_preview', 'preview_expired', ?, ?)`,
      ).bind(
        `bonus-preview-expired:${normalizedGrantId}`,
        userId,
        evidence.preview_grant_id,
        startsAt,
      ),
      database.prepare(
        `UPDATE user_access
         SET access_tier = 'free', trial_used = 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE telegram_id = ? AND access_tier = 'trial'`,
      ).bind(userId),
    );
  }

  statements.push(database.prepare(
    `INSERT INTO bonus_access_effects (
       effect_id, effect_key, bonus_grant_id, reward_id,
       beneficiary_telegram_id, effect_kind, plan_code,
       prior_plan_code, prior_access_state,
       prior_plan_revision, result_plan_revision,
       prior_access_revision, result_access_revision,
       target_subscription_id, prior_subscription_revision,
       result_subscription_revision, source_payment_ledger_entry_id,
       applied_transition_id, effect_starts_at, effect_ends_at, recorded_at
     ) VALUES (?, ?, ?, ?, ?, 'manual_professional_access', 'professional',
               'free', ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
  ).bind(
    effectId,
    `bonus-effect:${normalizedGrantId}`,
    normalizedGrantId,
    evidence.reward_id,
    userId,
    priorAccessState,
    planRevision,
    planRevision + 1,
    accessRevision,
    accessRevision + 1,
    evidence.source_payment_ledger_entry_id,
    transitionId,
    startsAt,
    endsAt,
    startsAt,
  ));

  try {
    await database.batch(statements);
  } catch (cause) {
    evidence = await loadGrantEvidence(database, normalizedGrantId, userId);
    if (evidence?.grant_status === "applied" && evidence.effect_id) {
      return grantResult(evidence, "duplicate");
    }
    if (evidence?.compensation_ledger_entry_id) {
      return grantResult(
        evidence,
        "manual_review",
        "referral_payment_compensation_race",
      );
    }
    throw bonusError("referral_bonus_claim_persistence_failed", cause);
  }
  evidence = await loadGrantEvidence(database, normalizedGrantId, userId);
  if (
    evidence?.grant_status !== "applied" ||
    !evidence.effect_id ||
    evidence.current_plan_code !== "professional" ||
    evidence.current_access_state !== "active"
  ) {
    throw bonusError("referral_bonus_claim_invariant_failed");
  }
  return grantResult(evidence, "applied");
}

async function loadCompensationEvidence(database, ledgerEntryId) {
  const row = await database.prepare(
    `SELECT reward.reward_id
     FROM payment_ledger compensation
     JOIN referral_reward_candidates candidate
       ON candidate.source_payment_ledger_entry_id =
         compensation.related_ledger_entry_id
     JOIN referral_rewards reward
       ON reward.candidate_id = candidate.candidate_id
     WHERE compensation.ledger_entry_id = ?
       AND compensation.entry_type IN ('refund', 'chargeback')
       AND compensation.direction = 'debit'
       AND compensation.currency = 'XTR'
       AND compensation.order_id = candidate.source_order_id
       AND compensation.telegram_id = candidate.buyer_telegram_id
       AND compensation.amount_stars = candidate.amount_stars
     LIMIT 1`,
  ).bind(ledgerEntryId).first();
  if (!row) return null;
  return loadRewardEvidence(database, row.reward_id);
}

function rewardCompensationTransition(database, evidence, transitionId, timestamp) {
  const fromStatus = String(evidence.reward_status);
  return database.prepare(
    `INSERT INTO referral_reward_transitions (
       transition_id, transition_key, transition_scope, reward_id,
       bonus_grant_id, from_status, to_status, from_revision, to_revision,
       reason_code, actor_type, actor_id, related_payment_ledger_entry_id,
       effect_starts_at, effect_ends_at, compensated_seconds,
       occurred_at, recorded_at
     ) VALUES (?, ?, 'reward', ?, NULL, ?, 'cancelled', ?, ?, ?, 'system',
               NULL, ?, NULL, NULL, 0, ?, ?)`,
  ).bind(
    transitionId,
    `reward-compensation:${evidence.reward_id}:${evidence.reward_revision}`,
    evidence.reward_id,
    fromStatus,
    Number(evidence.reward_revision),
    Number(evidence.reward_revision) + 1,
    evidence.compensation_type,
    evidence.compensation_ledger_entry_id,
    Number(evidence.compensation_occurred_at),
    timestamp,
  );
}

function canSafelyReverseAppliedEffect(evidence, timestamp) {
  if (
    !evidence.effect_id ||
    timestamp > Number(evidence.starts_at) ||
    evidence.plan_revision !== evidence.effect_plan_revision ||
    evidence.access_revision !== evidence.effect_access_revision
  ) {
    return false;
  }
  if (evidence.effect_kind === "manual_professional_access") {
    return evidence.current_plan_code === "professional" &&
      evidence.current_access_state === "active" &&
      evidence.plan_source_code === SOURCE_MANUAL &&
      evidence.access_source_code === SOURCE_MANUAL;
  }
  return evidence.effect_kind === "paid_plan_extension" &&
    evidence.current_subscription_id === evidence.target_subscription_id &&
    Number(evidence.current_period_end) === Number(evidence.ends_at) &&
    evidence.subscription_revision === evidence.effect_subscription_revision &&
    evidence.plan_source_code === SOURCE_EXTENSION &&
    evidence.access_source_code === SOURCE_EXTENSION;
}

function appendSafeReversalStatements(
  statements,
  database,
  evidence,
  timestamp,
) {
  const userId = Number(evidence.beneficiary_telegram_id);
  const planRevision = Number(evidence.plan_revision);
  const accessRevision = Number(evidence.access_revision);
  const reversalId = crypto.randomUUID();
  const startsAt = Number(evidence.starts_at);
  const startsSql = sqlDateTime(startsAt);
  const compensationType = String(evidence.compensation_type);
  if (evidence.effect_kind === "paid_plan_extension") {
    const subscriptionRevision = Number(evidence.subscription_revision);
    statements.push(
      database.prepare(
        `UPDATE subscriptions
         SET current_period_end = ?, revision = revision + 1, updated_at = ?
         WHERE subscription_id = ? AND revision = ?
           AND current_period_end = ? AND status IN
             ('active', 'cancel_at_period_end')`,
      ).bind(
        startsAt,
        timestamp,
        evidence.target_subscription_id,
        subscriptionRevision,
        Number(evidence.ends_at),
      ),
      database.prepare(
        `UPDATE user_plans
         SET source_code = ?, effective_until = ?, revision = revision + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE telegram_id = ? AND plan_code = ? AND revision = ?
           AND source_code = ?`,
      ).bind(
        SOURCE_COMPENSATION,
        startsSql,
        userId,
        evidence.bonus_plan_code,
        planRevision,
        SOURCE_EXTENSION,
      ),
      database.prepare(
        `UPDATE user_access_states
         SET source_code = ?, state_ends_at = ?, revision = revision + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE telegram_id = ? AND access_state = ? AND revision = ?
           AND source_code = ?`,
      ).bind(
        SOURCE_COMPENSATION,
        startsSql,
        userId,
        evidence.effect_prior_access_state,
        accessRevision,
        SOURCE_EXTENSION,
      ),
      database.prepare(
        `INSERT OR IGNORE INTO access_status_history (
           event_id, telegram_id, plan_code, from_state, to_state,
           source_code, related_grant_id, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `referral-compensation:${evidence.bonus_grant_id}`,
        userId,
        evidence.bonus_plan_code,
        evidence.effect_prior_access_state,
        evidence.effect_prior_access_state,
        SOURCE_COMPENSATION,
        evidence.bonus_grant_id,
        Number(evidence.compensation_occurred_at),
      ),
      database.prepare(
        `INSERT INTO bonus_access_reversals (
           reversal_id, reversal_key, effect_id, bonus_grant_id, reward_id,
           compensation_ledger_entry_id, beneficiary_telegram_id,
           reversal_kind, removed_seconds,
           prior_plan_revision, result_plan_revision,
           prior_access_revision, result_access_revision,
           target_subscription_id, prior_subscription_revision,
           result_subscription_revision, access_would_start_at,
           access_would_end_at, compensation_occurred_at, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'paid_extension_removed', ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        reversalId,
        `bonus-reversal:${evidence.bonus_grant_id}`,
        evidence.effect_id,
        evidence.bonus_grant_id,
        evidence.reward_id,
        evidence.compensation_ledger_entry_id,
        userId,
        REFERRAL_REWARD_SECONDS.bonusAccess,
        planRevision,
        planRevision + 1,
        accessRevision,
        accessRevision + 1,
        evidence.target_subscription_id,
        subscriptionRevision,
        subscriptionRevision + 1,
        startsAt,
        Number(evidence.ends_at),
        Number(evidence.compensation_occurred_at),
        timestamp,
      ),
    );
    return;
  }

  statements.push(
    database.prepare(
      `UPDATE user_plans
       SET plan_code = 'free', source_code = ?, effective_from = ?,
           effective_until = NULL, revision = revision + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND plan_code = 'professional'
         AND revision = ? AND source_code = ?`,
    ).bind(
      SOURCE_COMPENSATION,
      sqlDateTime(timestamp),
      userId,
      planRevision,
      SOURCE_MANUAL,
    ),
    database.prepare(
      `UPDATE user_access_states
       SET access_state = 'expired', source_code = ?, state_started_at = NULL,
           state_ends_at = ?, revision = revision + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND access_state = 'active'
         AND revision = ? AND source_code = ?`,
    ).bind(
      SOURCE_COMPENSATION,
      startsSql,
      userId,
      accessRevision,
      SOURCE_MANUAL,
    ),
    database.prepare(
      `INSERT OR IGNORE INTO access_status_history (
         event_id, telegram_id, plan_code, from_state, to_state,
         source_code, related_grant_id, occurred_at
       ) VALUES (?, ?, 'professional', 'active', 'expired', ?, ?, ?)`,
    ).bind(
      `referral-compensation:${evidence.bonus_grant_id}`,
      userId,
      SOURCE_COMPENSATION,
      evidence.bonus_grant_id,
      Number(evidence.compensation_occurred_at),
    ),
    database.prepare(
      `INSERT INTO bonus_access_reversals (
         reversal_id, reversal_key, effect_id, bonus_grant_id, reward_id,
         compensation_ledger_entry_id, beneficiary_telegram_id,
         reversal_kind, removed_seconds,
         prior_plan_revision, result_plan_revision,
         prior_access_revision, result_access_revision,
         target_subscription_id, prior_subscription_revision,
         result_subscription_revision, access_would_start_at,
         access_would_end_at, compensation_occurred_at, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual_access_removed', ?, ?, ?, ?, ?,
                 NULL, NULL, NULL, ?, ?, ?, ?)`,
    ).bind(
      reversalId,
      `bonus-reversal:${evidence.bonus_grant_id}`,
      evidence.effect_id,
      evidence.bonus_grant_id,
      evidence.reward_id,
      evidence.compensation_ledger_entry_id,
      userId,
      REFERRAL_REWARD_SECONDS.bonusAccess,
      planRevision,
      planRevision + 1,
      accessRevision,
      accessRevision + 1,
      startsAt,
      Number(evidence.ends_at),
      Number(evidence.compensation_occurred_at),
      timestamp,
    ),
  );
}

export async function applyReferralRewardCompensation(
  env,
  {
    compensationLedgerEntryId,
    recordedAt = nowSeconds(),
  } = {},
) {
  const ledgerEntryId = validateUuid(
    compensationLedgerEntryId,
    "referral_compensation_ledger_id_invalid",
  );
  const timestamp = validateClock(recordedAt, "recordedAt");
  const database = requireDatabase(env);
  const packageReward=await applyPackageReferralRewardCompensation(env,{compensationLedgerEntryId:ledgerEntryId,recordedAt:timestamp});
  const packageBonus=await applyPackageReferralBonusCompensation(env,{compensationLedgerEntryId:ledgerEntryId,recordedAt:timestamp});
  let evidence = await loadCompensationEvidence(database, ledgerEntryId);
  if (!evidence) {
    return Object.freeze({
      status: packageReward.status==='applied'||packageBonus.status==='applied'?'applied':packageReward.status==='duplicate'||packageBonus.status==='duplicate'?'duplicate':"not_applicable",
      compensationLedgerEntryId: ledgerEntryId,
      packageReward,packageBonus,
    });
  }
  if (timestamp < Number(evidence.compensation_recorded_at)) {
    throw bonusError("referral_compensation_before_ledger_record");
  }
  if (
    evidence.reward_status === "cancelled" &&
    (!evidence.bonus_grant_id ||
      TERMINAL_GRANT_STATES.has(evidence.grant_status))
  ) {
    return Object.freeze({
      status: "duplicate",
      rewardId: evidence.reward_id,
      bonusGrantId: evidence.bonus_grant_id || null,
      packageReward,packageBonus,
    });
  }

  const statements = [];
  if (["pending", "confirmed"].includes(evidence.reward_status)) {
    const rewardTransitionId = crypto.randomUUID();
    if (evidence.reward_status === "pending") {
      statements.push(database.prepare(
        `INSERT INTO referral_reward_protection_checks (
           protection_check_id, check_key, reward_id, candidate_id,
           reward_revision, decision, reason_code,
           source_payment_ledger_entry_id, source_access_grant_id,
           reconciliation_run_id, reconciliation_item_id,
           compensation_ledger_entry_id, transition_id,
           checked_at, recorded_at
         ) VALUES (?, ?, ?, ?, ?, 'cancel', ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        `compensation-check:${evidence.reward_id}:${evidence.reward_revision}`,
        evidence.reward_id,
        evidence.candidate_id,
        Number(evidence.reward_revision),
        evidence.compensation_type,
        evidence.source_payment_ledger_entry_id,
        evidence.source_access_grant_id,
        evidence.compensation_ledger_entry_id,
        rewardTransitionId,
        timestamp,
        timestamp,
      ));
    }
    statements.push(rewardCompensationTransition(
      database,
      evidence,
      rewardTransitionId,
      timestamp,
    ));
  }

  let grantOutcome = null;
  if (["pending", "claimable"].includes(evidence.grant_status)) {
    grantOutcome = "revoked";
    statements.push(transitionStatement(database, {
      transitionId: crypto.randomUUID(),
      transitionKey: `bonus-compensation:${evidence.bonus_grant_id}:${evidence.grant_revision}`,
      rewardId: evidence.reward_id,
      bonusGrantId: evidence.bonus_grant_id,
      fromStatus: evidence.grant_status,
      toStatus: "revoked",
      fromRevision: Number(evidence.grant_revision),
      reasonCode: evidence.compensation_type,
      actorType: "system",
      ledgerEntryId: evidence.compensation_ledger_entry_id,
      compensatedSeconds: REFERRAL_REWARD_SECONDS.bonusAccess,
      occurredAt: Number(evidence.compensation_occurred_at),
      recordedAt: timestamp,
    }));
  } else if (evidence.grant_status === "applied") {
    const safeReversal = canSafelyReverseAppliedEffect(evidence, timestamp);
    grantOutcome = safeReversal ? "revoked" : "manual_review";
    statements.push(transitionStatement(database, {
      transitionId: crypto.randomUUID(),
      transitionKey: `bonus-compensation:${evidence.bonus_grant_id}:${evidence.grant_revision}`,
      rewardId: evidence.reward_id,
      bonusGrantId: evidence.bonus_grant_id,
      fromStatus: "applied",
      toStatus: grantOutcome,
      fromRevision: Number(evidence.grant_revision),
      reasonCode: evidence.compensation_type,
      actorType: "system",
      ledgerEntryId: evidence.compensation_ledger_entry_id,
      compensatedSeconds: safeReversal
        ? REFERRAL_REWARD_SECONDS.bonusAccess
        : 0,
      occurredAt: Number(evidence.compensation_occurred_at),
      recordedAt: timestamp,
    }));
    if (safeReversal) {
      appendSafeReversalStatements(statements, database, evidence, timestamp);
    }
  }

  if (statements.length === 0) {
    return Object.freeze({
      status: "duplicate",
      rewardId: evidence.reward_id,
      bonusGrantId: evidence.bonus_grant_id || null,
      packageReward,packageBonus,
    });
  }

  try {
    await database.batch(statements);
  } catch (cause) {
    evidence = await loadCompensationEvidence(database, ledgerEntryId);
    if (
      evidence?.reward_status === "cancelled" &&
      (!evidence.bonus_grant_id ||
        TERMINAL_GRANT_STATES.has(evidence.grant_status))
    ) {
      return Object.freeze({
        status: "duplicate",
        rewardId: evidence.reward_id,
        bonusGrantId: evidence.bonus_grant_id || null,
        grantStatus: evidence.grant_status || null,
        packageReward,packageBonus,
      });
    }
    throw bonusError("referral_bonus_compensation_failed", cause);
  }

  evidence = await loadCompensationEvidence(database, ledgerEntryId);
  if (evidence?.reward_status !== "cancelled") {
    throw bonusError("referral_bonus_compensation_invariant_failed");
  }
  return Object.freeze({
    status: "applied",
    rewardId: evidence.reward_id,
    rewardStatus: evidence.reward_status,
    bonusGrantId: evidence.bonus_grant_id || null,
    grantStatus: evidence.grant_status || grantOutcome,
    packageReward,packageBonus,
  });
}

export async function expireReferralBonusAccess(
  env,
  { bonusGrantId, recordedAt = nowSeconds() } = {},
) {
  const normalizedGrantId = validateUuid(
    bonusGrantId,
    "referral_bonus_grant_id_invalid",
  );
  const timestamp = validateClock(recordedAt, "recordedAt");
  const database = requireDatabase(env);
  let evidence = await loadGrantEvidence(database, normalizedGrantId);
  if (!evidence) throw bonusError("referral_bonus_grant_not_found");
  if (
    evidence.delivery_mode !== "manual_claim" ||
    !["applied", "manual_review"].includes(evidence.grant_status) ||
    !evidence.effect_id
  ) {
    return grantResult(evidence, "not_due", "referral_bonus_access_not_managed");
  }
  if (timestamp < Number(evidence.ends_at)) {
    return grantResult(evidence, "not_due", "referral_bonus_access_active");
  }
  const existing = await database.prepare(
    `SELECT expiry_event_id FROM bonus_access_expiry_events
     WHERE bonus_grant_id = ? LIMIT 1`,
  ).bind(normalizedGrantId).first();
  if (existing) return grantResult(evidence, "duplicate");
  if (
    evidence.current_plan_code !== "professional" ||
    evidence.current_access_state !== "active" ||
    evidence.plan_source_code !== SOURCE_MANUAL ||
    evidence.access_source_code !== SOURCE_MANUAL ||
    Number(evidence.plan_revision) !== Number(evidence.effect_plan_revision) ||
    Number(evidence.access_revision) !== Number(evidence.effect_access_revision)
  ) {
    return grantResult(evidence, "superseded", "referral_bonus_access_replaced");
  }

  const endedAt = Number(evidence.ends_at);
  const endedSql = sqlDateTime(endedAt);
  const planRevision = Number(evidence.plan_revision);
  const accessRevision = Number(evidence.access_revision);
  const expiryEventId = crypto.randomUUID();
  const userId = Number(evidence.beneficiary_telegram_id);
  try {
    await database.batch([
      database.prepare(
        `UPDATE user_plans
         SET plan_code = 'free', source_code = ?, effective_from = ?,
             effective_until = NULL, revision = revision + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE telegram_id = ? AND plan_code = 'professional'
           AND source_code = ? AND revision = ?
           AND CAST(strftime('%s', effective_until) AS INTEGER) = ?`,
      ).bind(
        SOURCE_EXPIRED,
        endedSql,
        userId,
        SOURCE_MANUAL,
        planRevision,
        endedAt,
      ),
      database.prepare(
        `UPDATE user_access_states
         SET access_state = 'expired', source_code = ?, state_ends_at = ?,
             revision = revision + 1, updated_at = CURRENT_TIMESTAMP
         WHERE telegram_id = ? AND access_state = 'active'
           AND source_code = ? AND revision = ?
           AND CAST(strftime('%s', state_ends_at) AS INTEGER) = ?`,
      ).bind(
        SOURCE_EXPIRED,
        endedSql,
        userId,
        SOURCE_MANUAL,
        accessRevision,
        endedAt,
      ),
      database.prepare(
        `INSERT OR IGNORE INTO access_status_history (
           event_id, telegram_id, plan_code, from_state, to_state,
           source_code, related_grant_id, occurred_at
         ) VALUES (?, ?, 'professional', 'active', 'expired', ?, ?, ?)`,
      ).bind(
        `referral-expired:${normalizedGrantId}`,
        userId,
        SOURCE_EXPIRED,
        normalizedGrantId,
        endedAt,
      ),
      database.prepare(
        `INSERT INTO bonus_access_expiry_events (
           expiry_event_id, event_key, effect_id, bonus_grant_id,
           beneficiary_telegram_id, prior_plan_revision,
           result_plan_revision, prior_access_revision,
           result_access_revision, access_ended_at, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        expiryEventId,
        `bonus-expiry:${normalizedGrantId}`,
        evidence.effect_id,
        normalizedGrantId,
        userId,
        planRevision,
        planRevision + 1,
        accessRevision,
        accessRevision + 1,
        endedAt,
        timestamp,
      ),
    ]);
  } catch (cause) {
    const raced = await database.prepare(
      `SELECT expiry_event_id FROM bonus_access_expiry_events
       WHERE bonus_grant_id = ? LIMIT 1`,
    ).bind(normalizedGrantId).first();
    if (raced) return grantResult(evidence, "duplicate");
    throw bonusError("referral_bonus_access_expiry_failed", cause);
  }
  evidence = await loadGrantEvidence(database, normalizedGrantId);
  return grantResult(evidence, "expired");
}

export async function repairReferralBonusGrants(
  env,
  { limit = 25, deliveredAt = nowSeconds() } = {},
) {
  const gate = bonusGate(env);
  if (!gate.enabled) {
    return Object.freeze({ status: "disabled", reason: gate.reason, results: [] });
  }
  const pageSize = Number(limit);
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_MAINTENANCE_BATCH
  ) {
    throw bonusError("referral_bonus_repair_limit_invalid");
  }
  const timestamp = validateClock(deliveredAt, "deliveredAt");
  const database = requireDatabase(env);
  const rows = await database.prepare(
    `SELECT reward.reward_id
     FROM referral_rewards reward
     LEFT JOIN bonus_access_grants grant_record
       ON grant_record.reward_id = reward.reward_id
     WHERE reward.reward_status = 'confirmed'
       AND grant_record.bonus_grant_id IS NULL
     ORDER BY reward.confirmed_at, reward.reward_id
     LIMIT ?`,
  ).bind(pageSize).all();
  const results = [];
  for (const row of rows?.results || []) {
    results.push(await ensureReferralBonusGrant(env, {
      rewardId: row.reward_id,
      deliveredAt: timestamp,
    }));
  }
  return Object.freeze({
    status: "completed",
    attempted: results.length,
    results: Object.freeze(results),
  });
}

export async function runReferralBonusMaintenance(
  env,
  { limit = 25, recordedAt = nowSeconds() } = {},
) {
  const pageSize = Number(limit);
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_MAINTENANCE_BATCH
  ) {
    throw bonusError("referral_bonus_maintenance_limit_invalid");
  }
  const timestamp = validateClock(recordedAt, "recordedAt");
  const database = requireDatabase(env);
  const claimRows = await database.prepare(
    `SELECT bonus_grant_id
     FROM bonus_access_grants
     WHERE delivery_mode = 'manual_claim' AND grant_status = 'claimable'
       AND claim_expires_at < ?
     ORDER BY claim_expires_at, bonus_grant_id
     LIMIT ?`,
  ).bind(timestamp, pageSize).all();
  const results = [];
  for (const row of claimRows?.results || []) {
    results.push(await expireReferralBonusClaim(env, {
      bonusGrantId: row.bonus_grant_id,
      expiredAt: timestamp,
    }));
  }

  const remaining = Math.max(0, pageSize - results.length);
  if (remaining > 0) {
    const accessRows = await database.prepare(
      `SELECT grant_record.bonus_grant_id
       FROM bonus_access_grants grant_record
       JOIN bonus_access_effects effect
         ON effect.bonus_grant_id = grant_record.bonus_grant_id
       LEFT JOIN bonus_access_expiry_events expiry
         ON expiry.bonus_grant_id = grant_record.bonus_grant_id
       WHERE grant_record.delivery_mode = 'manual_claim'
         AND grant_record.grant_status IN ('applied', 'manual_review')
         AND effect.effect_ends_at <= ?
         AND expiry.bonus_grant_id IS NULL
       ORDER BY effect.effect_ends_at, grant_record.bonus_grant_id
       LIMIT ?`,
    ).bind(timestamp, remaining).all();
    for (const row of accessRows?.results || []) {
      results.push(await expireReferralBonusAccess(env, {
        bonusGrantId: row.bonus_grant_id,
        recordedAt: timestamp,
      }));
    }
  }
  return Object.freeze({
    status: "completed",
    attempted: results.length,
    results: Object.freeze(results),
  });
}

export async function getReferralBonusStatus(
  env,
  { telegramId, at = nowSeconds() } = {},
) {
  const userId = validateTelegramId(telegramId);
  const timestamp = validateClock(at, "at");
  const database = requireDatabase(env);
  const row = await database.prepare(
    `SELECT reward.reward_id, reward.reward_status, reward.confirm_after,
            reward.confirmed_at, reward.cancelled_at,
            grant_record.bonus_grant_id, grant_record.delivery_mode,
            grant_record.plan_code, grant_record.grant_status,
            grant_record.available_at, grant_record.claim_expires_at,
            grant_record.starts_at, grant_record.ends_at,
            expiry.expiry_event_id
     FROM referral_rewards reward
     LEFT JOIN bonus_access_grants grant_record
       ON grant_record.reward_id = reward.reward_id
     LEFT JOIN bonus_access_expiry_events expiry
       ON expiry.bonus_grant_id = grant_record.bonus_grant_id
     WHERE reward.beneficiary_telegram_id = ?
       AND reward.program_code = ?
     ORDER BY reward.created_at DESC
     LIMIT 1`,
  ).bind(userId, REFERRAL_REWARD_PROGRAM_CODE).first();
  if (!row) return Object.freeze({ status: "none" });
  const effective = ["applied", "manual_review"].includes(row.grant_status) &&
    Number(row.starts_at) <= timestamp &&
    Number(row.ends_at) > timestamp;
  return Object.freeze({
    status: row.expiry_event_id
      ? "expired"
      : row.grant_status || row.reward_status,
    rewardId: String(row.reward_id),
    rewardStatus: String(row.reward_status),
    bonusGrantId: row.bonus_grant_id || null,
    deliveryMode: row.delivery_mode || null,
    planCode: row.plan_code || null,
    confirmAfter: Number(row.confirm_after),
    confirmedAt: Number(row.confirmed_at || 0) || null,
    cancelledAt: Number(row.cancelled_at || 0) || null,
    availableAt: Number(row.available_at || 0) || null,
    claimExpiresAt: Number(row.claim_expires_at || 0) || null,
    startsAt: Number(row.starts_at || 0) || null,
    endsAt: Number(row.ends_at || 0) || null,
    effective,
  });
}
