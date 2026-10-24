import {
  acceptStarsPurchaseTerms,
  handleStarsPreCheckoutQuery,
  issueStarsInvoice,
  recordStarsSuccessfulPayment,
} from "./stars-payment-runtime.mjs";
import {
  applyStarsPaidAccess,
  assertStarsPurchaseAllowed,
  buildStarsReceipt,
  expireStarsPaidAccess,
  handleStarsRefundedPaymentUpdate,
} from "./stars-access-runtime.mjs";
import { preparePackageFinancialIngress,buildVerifiedPackagePaymentResult } from '../v1.4.4/package-commerce-runtime.mjs';
import { createServiceExecutor } from '../v1.4.1/trusted-context.mjs';
import { fulfillMonthlyTransitionFromAppliedPayment } from '../v1.4.4/monthly-transition-runtime.mjs';

function safeReason(error, fallback = "stars_commerce_error") {
  return String(error?.code || error?.name || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 64);
}

// Only the compiled143 webhook opts in. Permanent validation/policy failures
// still need manual review; a D1 failure must not acknowledge an unrecorded
// financial observation. Preserve the original error for the receipt/error log.
function rethrowUnconfirmedPersistence(error, options) {
  if (options.retryPersistenceFailures !== true) return;
  const code = String(error?.code || "");
  if (!code || /^(?:D1_|SQLITE_)/i.test(code) || [
    "stars_database_not_ready", "successful_payment_persistence_invariant",
    "access_application_invariant_failed", "refunded_payment_persistence_invariant",
    "refund_request_not_persisted",
    "monthly_transition_commit_unverified",
    "v144_package_schema_not_ready", "package_payment_persistence_invariant",
    "package_batch_unverified", "package_schema_unverified",
  ].includes(code)) throw error;
}

export { acceptStarsPurchaseTerms };

export async function issueStarsPurchase(env, request, options = {}) {
  const timestamp = Number(request?.createdAt) ||
    Math.floor(Date.now() / 1_000);
  await expireStarsPaidAccess(env, {
    telegramId: request?.telegramId,
    at: timestamp,
  });
  await assertStarsPurchaseAllowed(env, {
    telegramId: request?.telegramId,
    requestedPlanCode: request?.requestedPlanCode,
    at: timestamp,
  });
  if (typeof options.purchaseGuard === "function") {
    await options.purchaseGuard(env, {
      telegramId: request?.telegramId,
      requestedPlanCode: request?.requestedPlanCode,
      at: timestamp,
    });
  }
  return issueStarsInvoice(env, request, options);
}

export function isStarsCommerceUpdate(update) {
  return Boolean(
    update?.pre_checkout_query ||
    update?.message?.successful_payment ||
    update?.message?.refunded_payment
  );
}

export async function handleStarsCommerceUpdate(env, update, options = {}) {
  // Financial identity is minted from the actual authenticated webhook and
  // durable claim. A serialized/caller-supplied packageActor is never accepted.
  const {packageActor,packageFinancialContext} = await preparePackageFinancialIngress(env, update, options);
  if (update?.pre_checkout_query) {
    const purchaseGuard = async (runtimeEnv, request) => {
      await assertStarsPurchaseAllowed(runtimeEnv, request);
      if (typeof options.purchaseGuard === "function") {
        await options.purchaseGuard(runtimeEnv, request);
      }
    };
    return handleStarsPreCheckoutQuery(env, update, {
      ...options,
      packageActor,
      packageFinancialContext,
      purchaseGuard,
    });
  }
  if (update?.message?.refunded_payment) {
    try {
      const result = await handleStarsRefundedPaymentUpdate(env, update, {
        receivedAt: options.nowSeconds,
      });
      if (options.retryPersistenceFailures === true && result.status !== "manual_review") {
        const debit = await env.DB.prepare(
          `SELECT ledger_entry_id FROM payment_ledger
           WHERE ledger_entry_id=? AND telegram_payment_charge_id=?
             AND entry_type='refund' AND direction='debit' LIMIT 1`,
        ).bind(result.ledgerEntryId, update.message.refunded_payment.telegram_payment_charge_id).first();
        if (!debit) throw Object.assign(new Error("refunded_payment_persistence_invariant"), {
          code: "refunded_payment_persistence_invariant",
        });
      }
      return Object.freeze({ handled: true, ...result });
    } catch (error) {
      rethrowUnconfirmedPersistence(error, options);
      return Object.freeze({
        handled: true,
        status: "manual_review",
        reason: safeReason(error),
        accessChanged: false,
      });
    }
  }
  if (!update?.message?.successful_payment) {
    return Object.freeze({ handled: false });
  }
  try {
    const payment = await recordStarsSuccessfulPayment(env, update, {
      receivedAt: options.nowSeconds,
      packageActor,
      packageFinancialContext,
    });
    if (payment.status === "manual_review") {
      return Object.freeze({ handled: true, ...payment });
    }
    if (payment.packagePayment === true) {
      return Object.freeze({ handled:true,...await buildVerifiedPackagePaymentResult(packageFinancialContext,payment) });
    }
    if (payment.ownerReviewSettled === true && payment.accessApplied === true) {
      await fulfillMonthlyTransitionFromAppliedPayment(createServiceExecutor({binding:env.DB,env,purpose:'stars_process_event'})
        .createContext(),{orderId:payment.orderId});
      return Object.freeze({ handled:true,...payment,receipt:buildStarsReceipt({
        orderId:payment.orderId,planCode:payment.planCode,amountStars:payment.amountStars,
        periodEndsAt:payment.periodEndsAt,
      }) });
    }
    const access = await applyStarsPaidAccess(env, {
      orderId: payment.orderId,
      appliedAt: options.nowSeconds,
    });
    await fulfillMonthlyTransitionFromAppliedPayment(createServiceExecutor({binding:env.DB,env,purpose:'stars_process_event'})
      .createContext(),{orderId:access.orderId});
    return Object.freeze({
      handled: true,
      status: access.status,
      orderId: access.orderId,
      subscriptionId: access.subscriptionId,
      grantId: access.grantId,
      planCode: access.planCode,
      amountStars: access.amountStars,
      periodStartsAt: access.periodStartsAt,
      periodEndsAt: access.periodEndsAt,
      accessApplied: true,
      receipt: buildStarsReceipt({
        orderId: access.orderId,
        planCode: access.planCode,
        amountStars: access.amountStars,
        periodEndsAt: access.periodEndsAt,
      }),
    });
  } catch (error) {
    rethrowUnconfirmedPersistence(error, options);
    return Object.freeze({
      handled: true,
      status: "manual_review",
      reason: safeReason(error),
      accessApplied: false,
    });
  }
}
