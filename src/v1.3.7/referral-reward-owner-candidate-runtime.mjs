import {
  createReferralRewardCandidate as createLegacyReferralRewardCandidate,
  getReferralRewardRolloutDecision,
} from "./referral-reward-candidate-runtime.mjs";
import {
  readReferralRewardConfig,
} from "./referral-reward-foundation.mjs";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function normalizeTelegramId(value) {
  const normalized =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value;
  return Number.isSafeInteger(normalized) && normalized > 0
    ? normalized
    : null;
}

function normalizeOrderId(value) {
  return String(value || "").trim().toLowerCase();
}

function ineligible(reason, orderId) {
  return Object.freeze({
    status: "ineligible",
    reason: String(reason || "referral_rollout_denied"),
    orderId,
  });
}

async function loadOwnerAuthority(database, orderId) {
  return database.prepare(
    `SELECT orders.telegram_id AS buyer_telegram_id,
            user.inviter_id AS inviter_telegram_id,
            EXISTS (
              SELECT 1
              FROM referral_reward_candidates candidate
              WHERE candidate.source_order_id = orders.order_id
            ) AS candidate_exists
     FROM subscription_orders orders
     LEFT JOIN users user ON user.telegram_id = orders.telegram_id
     WHERE orders.order_id = ?
     LIMIT 1`,
  ).bind(orderId).first();
}

function beneficiaryBridgeEnv(env, buyerId) {
  // The legacy candidate engine still performs its final rollout check against
  // the buyer. Part 2 first authorizes the actual beneficiary/inviter, then
  // supplies a one-call compatibility allowlist containing only this buyer.
  // No binding, global setting or persisted rollout scope is changed.
  return Object.freeze({
    ...env,
    REFERRAL_REWARD_ROLLOUT_MODE: "allowlist",
    REFERRAL_REWARD_ROLLOUT_ALLOWLIST: String(buyerId),
  });
}

export async function createReferralRewardCandidate(
  env,
  options = {},
) {
  const config = readReferralRewardConfig(env);
  if (!config.candidateWritesEnabled) {
    return createLegacyReferralRewardCandidate(env, options);
  }

  const orderId = normalizeOrderId(options?.orderId);
  if (!UUID_V4.test(orderId) || !env?.DB?.prepare) {
    return createLegacyReferralRewardCandidate(env, options);
  }

  const authority = await loadOwnerAuthority(env.DB, orderId);
  if (!authority || Number(authority.candidate_exists) === 1) {
    // Preserve the legacy evidence errors and duplicate idempotency contract.
    return createLegacyReferralRewardCandidate(env, options);
  }

  const buyerId = normalizeTelegramId(authority.buyer_telegram_id);
  const inviterId = normalizeTelegramId(authority.inviter_telegram_id);
  if (!buyerId || !inviterId) {
    return createLegacyReferralRewardCandidate(env, options);
  }

  const rollout = getReferralRewardRolloutDecision(env, inviterId);
  if (!rollout.eligible) return ineligible(rollout.reason, orderId);

  if (config.rolloutMode === "public") {
    return createLegacyReferralRewardCandidate(env, options);
  }

  return createLegacyReferralRewardCandidate(
    beneficiaryBridgeEnv(env, buyerId),
    options,
  );
}

export { getReferralRewardRolloutDecision };
