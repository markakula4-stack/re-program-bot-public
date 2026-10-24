import {
  acceptStarsPurchaseTerms,
  handleStarsCommerceUpdate as handleStableStarsCommerceUpdate,
  isStarsCommerceUpdate,
  issueStarsPurchase,
} from "../v1.3.6/stars-commerce-runtime.mjs";
import {
  createReferralRewardCandidate,
} from "./referral-reward-owner-candidate-runtime.mjs";
import {
  ensureReferralProtectionWorkflow,
} from "./referral-reward-protection-runtime.mjs";
import {
  applyReferralRewardCompensation,
} from "./referral-bonus-access-runtime.mjs";
import { createPackageReferralRewardCandidate, ensurePackageReferralProtectionWorkflow }
  from '../v1.4.4/package-referral-runtime.mjs';

function safeReason(error, fallback = "referral_candidate_error") {
  return String(error?.code || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 64);
}

export {
  acceptStarsPurchaseTerms,
  isStarsCommerceUpdate,
  issueStarsPurchase,
};

export async function attachReferralCandidateAfterAppliedAccess(
  env,
  update,
  accessResult,
  { selectedAt } = {},
) {
  if (
    !update?.message?.successful_payment ||
    (!accessResult?.accessApplied && accessResult?.packagePayment !== true) ||
    !accessResult?.orderId
  ) {
    return accessResult;
  }

  let referralReward;
  try {
    const packagePayment = accessResult.packagePayment === true;
    referralReward = await (packagePayment ? createPackageReferralRewardCandidate : createReferralRewardCandidate)(env, {
      orderId: accessResult.orderId,
      selectedAt,
    });
    if (
      ["created", "duplicate"].includes(referralReward.status) &&
      referralReward.rewardId
    ) {
      let protection;
      try {
        protection = await (packagePayment ? ensurePackageReferralProtectionWorkflow : ensureReferralProtectionWorkflow)(env, {
          rewardId: referralReward.rewardId,
          requestedAt: selectedAt,
        });
      } catch (error) {
        protection = Object.freeze({
          status: "manual_review",
          reason: safeReason(error, "referral_protection_error"),
          rewardId: referralReward.rewardId,
        });
      }
      referralReward = Object.freeze({ ...referralReward, protection });
    }
  } catch (error) {
    // Referral bookkeeping must never undo or disguise already-paid access.
    referralReward = Object.freeze({
      status: "manual_review",
      reason: safeReason(error),
      orderId: String(accessResult.orderId),
    });
  }
  return Object.freeze({ ...accessResult, referralReward });
}

export async function attachReferralCompensationAfterStarsResult(
  env,
  update,
  starsResult,
  { recordedAt } = {},
) {
  if (
    !update?.message?.refunded_payment ||
    !starsResult?.ledgerEntryId ||
    !["applied", "duplicate"].includes(starsResult.status)
  ) {
    return starsResult;
  }
  let referralRewardCompensation;
  try {
    referralRewardCompensation = await applyReferralRewardCompensation(env, {
      compensationLedgerEntryId: starsResult.ledgerEntryId,
      recordedAt,
    });
  } catch (error) {
    // Refund processing remains authoritative even when referral cleanup needs
    // repair or manual review.
    referralRewardCompensation = Object.freeze({
      status: "manual_review",
      reason: safeReason(error, "referral_compensation_error"),
    });
  }
  return Object.freeze({ ...starsResult, referralRewardCompensation });
}

export async function handleStarsCommerceUpdate(env, update, options = {}) {
  const accessResult = await handleStableStarsCommerceUpdate(
    env,
    update,
    options,
  );
  if (update?.message?.refunded_payment) {
    return attachReferralCompensationAfterStarsResult(
      env,
      update,
      accessResult,
      { recordedAt: options.nowSeconds },
    );
  }
  return attachReferralCandidateAfterAppliedAccess(env, update, accessResult, {
    selectedAt: options.nowSeconds,
  });
}
