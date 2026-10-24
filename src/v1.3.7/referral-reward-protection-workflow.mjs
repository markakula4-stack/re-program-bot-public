import { WorkflowEntrypoint } from "cloudflare:workers";
import {
  reconcileStarsTransactions,
} from "../v1.3.6/stars-access-runtime.mjs";
import {
  completeReferralProtectionJob,
  getReferralProtectionSchedule,
  markReferralProtectionJobManualReview,
  reconcileReferralRewardSourcePayment,
  safeReferralProtectionErrorCode,
  settleReferralRewardProtection,
} from "./referral-reward-protection-runtime.mjs";
import {
  ensureReferralBonusGrant,
} from "./referral-bonus-access-runtime.mjs";
import { resolvePackageReferralProtectionIdentity, getPackageReferralProtectionSchedule,
  reconcilePackageReferralRewardSourcePayment, settlePackageReferralRewardProtection,
  completePackageReferralProtectionJob, markPackageReferralProtectionJobManualReview }
  from '../v1.4.4/package-referral-runtime.mjs';
import { ensurePackageReferralBonusGrant } from '../v1.4.4/package-referral-bonus-runtime.mjs';
import { boundReferralReconciliationContinuation } from './referral-reconciliation-pagination.mjs';

// Source kind comes from the genuine immutable reward/job binding, never from
// the Workflow event. All operations retain the existing physical binding.
async function protectionApi(env, rewardId) {
  const identity = await resolvePackageReferralProtectionIdentity(env, { rewardId });
  if (!identity) throw workflowError('referral_reward_not_found');
  return identity.rewardKind === 'package' ? {
    schedule: getPackageReferralProtectionSchedule,
    reconcile: reconcilePackageReferralRewardSourcePayment,
    settle: settlePackageReferralRewardProtection,
    complete: completePackageReferralProtectionJob,
    review: markPackageReferralProtectionJobManualReview,
    bonus: (env, args) => ensurePackageReferralBonusGrant(env, { ...args, rewardKind: 'package' }),
  } : { schedule: getReferralProtectionSchedule, reconcile: reconcileReferralRewardSourcePayment,
    settle: settleReferralRewardProtection, complete: completeReferralProtectionJob,
    review: markReferralProtectionJobManualReview, bonus: ensureReferralBonusGrant };
}

export const REFERRAL_PROTECTION_RETRY_POLICY = Object.freeze({
  reconciliation: Object.freeze({
    retries: Object.freeze({
      limit: 5,
      delay: "1 minute",
      backoff: "exponential",
    }),
    timeout: "2 minutes",
  }),
  settlement: Object.freeze({
    retries: Object.freeze({
      limit: 10,
      delay: "10 seconds",
      backoff: "exponential",
    }),
    timeout: "1 minute",
  }),
  bonusDelivery: Object.freeze({
    retries: Object.freeze({
      limit: 10,
      delay: "10 seconds",
      backoff: "exponential",
    }),
    timeout: "1 minute",
  }),
  jobState: Object.freeze({
    retries: Object.freeze({
      limit: 5,
      delay: "10 seconds",
      backoff: "exponential",
    }),
    timeout: "1 minute",
  }),
});

function nowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function workflowError(code) {
  const error = new Error("Referral protection Workflow rejected its state");
  error.code = code;
  return error;
}

async function recordManualReview(
  step,
  env,
  rewardId,
  reason,
  runId = null,
  stepName = "record referral protection manual review",
) {
  return step.do(
    stepName,
    REFERRAL_PROTECTION_RETRY_POLICY.jobState,
    async () => (await protectionApi(env, rewardId)).review(env, {
      rewardId,
      reason,
      reconciliationRunId: runId,
      recordedAt: nowSeconds(),
    }),
  );
}

async function completeJob(
  step,
  env,
  rewardId,
  settlement,
  reconciliationRunId,
  stepName = "complete referral protection job",
) {
  return step.do(
    stepName,
    REFERRAL_PROTECTION_RETRY_POLICY.jobState,
    async () => (await protectionApi(env, rewardId)).complete(env, {
      rewardId,
      transitionId: settlement.transitionId,
      outcome: settlement.outcome,
      reconciliationRunId,
      completedAt: nowSeconds(),
    }),
  );
}

export class ReferralRewardProtectionWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const rewardId = String(event?.payload?.rewardId || "");
    let reconciliationRunId = null;
    try {
      const schedule = await step.do(
        "load canonical referral protection schedule",
        REFERRAL_PROTECTION_RETRY_POLICY.jobState,
        async () => (await protectionApi(this.env, rewardId)).schedule(this.env, { rewardId }),
      );
      if (schedule.status === "already_settled") {
        await completeJob(
          step,
          this.env,
          rewardId,
          schedule,
          null,
          "complete previously settled referral job",
        );
        return schedule;
      }
      if (schedule.status !== "scheduled") {
        throw workflowError(schedule.reason || "protection_schedule_unavailable");
      }

      await step.sleepUntil(
        "wait until referral protection hold ends",
        schedule.confirmAfter * 1_000,
      );

      let recheck, offsetStart = 0, completedWindows = 0;
      for (;;) {
        const windowOffset = offsetStart;
        recheck = await step.do(
          windowOffset === 0 ? "reconcile exact referral source payment" :
            `reconcile exact referral source payment from offset ${windowOffset}`,
          REFERRAL_PROTECTION_RETRY_POLICY.reconciliation,
          async () => (await protectionApi(this.env, rewardId)).reconcile(
            this.env,
            { rewardId, checkedAt: nowSeconds(), offsetStart: windowOffset },
            { reconcileTransactions: reconcileStarsTransactions },
          ),
        );
        recheck = boundReferralReconciliationContinuation(recheck, ++completedWindows);
        reconciliationRunId = recheck.reconciliationRunId || null;
        if (recheck.status !== 'pending') break;
        // Never confirm from a cursor. The next durable step must find the
        // exact source evidence or an authoritative compensation/terminal state.
        if (!Number.isSafeInteger(recheck.nextOffset) || recheck.nextOffset <= windowOffset)
          throw workflowError('referral_reconciliation_cursor_invalid');
        offsetStart = recheck.nextOffset;
      }
      reconciliationRunId = recheck.reconciliationRunId || null;

      if (recheck.status === "already_settled") {
        await completeJob(
          step,
          this.env,
          rewardId,
          recheck,
          reconciliationRunId,
          "complete concurrently settled referral job",
        );
        return recheck;
      }
      if (recheck.status === "manual_review" || recheck.status === "disabled") {
        await recordManualReview(
          step,
          this.env,
          rewardId,
          recheck.reason,
          reconciliationRunId,
        );
        return recheck;
      }
      if (!["verified", "compensated"].includes(recheck.status)) {
        throw workflowError("referral_recheck_incomplete");
      }

      const settlement = await step.do(
        "settle referral reward idempotently",
        REFERRAL_PROTECTION_RETRY_POLICY.settlement,
        async () => (await protectionApi(this.env, rewardId)).settle(this.env, {
          rewardId,
          reconciliationRunId,
          checkedAt: Math.max(nowSeconds(), Number(recheck.checkedAt || 0)),
        }),
      );

      if (["settled", "already_settled"].includes(settlement.status)) {
        let bonusAccess = null;
        if (settlement.outcome === "confirmed") {
          try {
            bonusAccess = await step.do(
              "prepare referral bonus access idempotently",
              REFERRAL_PROTECTION_RETRY_POLICY.bonusDelivery,
              async () => (await protectionApi(this.env, rewardId)).bonus(this.env, {
                rewardId,
                deliveredAt: nowSeconds(),
              }),
            );
          } catch (error) {
            // The reward is already settled. A dedicated Part 4 repair scan
            // retries delivery without rewriting payment or reward history.
            bonusAccess = Object.freeze({
              status: "manual_review",
              reason: safeReferralProtectionErrorCode(
                error,
                "referral_bonus_delivery_failed",
              ),
            });
          }
        }
        await completeJob(
          step,
          this.env,
          rewardId,
          settlement,
          reconciliationRunId,
        );
        return bonusAccess
          ? Object.freeze({ ...settlement, bonusAccess })
          : settlement;
      }

      if (settlement.status === "manual_review" || settlement.status === "disabled") {
        await recordManualReview(
          step,
          this.env,
          rewardId,
          settlement.reason,
          reconciliationRunId,
        );
        return settlement;
      }
      throw workflowError("referral_settlement_incomplete");
    } catch (error) {
      const reason = safeReferralProtectionErrorCode(
        error,
        "referral_protection_workflow_failed",
      );
      try {
        await recordManualReview(
          step,
          this.env,
          rewardId,
          reason,
          reconciliationRunId,
          "record referral protection failure",
        );
      } catch (recordingError) {
        console.error(
          "Could not record referral protection manual review",
          safeReferralProtectionErrorCode(recordingError),
        );
      }
      throw error;
    }
  }
}
