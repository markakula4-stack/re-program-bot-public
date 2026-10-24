// A continuation is scheduling metadata, never evidence that a payment exists.
// Keep each reconciliation invocation bounded; the Workflow persists each
// completed window separately and repeats only the unfinished window on retry.
const fail = () => { throw Object.assign(new Error('referral_reconciliation_cursor_invalid'),
  { code: 'referral_reconciliation_cursor_invalid' }); };
// A continuously growing or repeating provider feed must not keep one reward
// Workflow alive forever. The existing 20 x 100 per-window limit is unchanged;
// target-only reconciliation avoids journaling unrelated history. Ten windows
// retain headroom under the default Workflow subrequest budget even when every
// window consumes all five retries; regression tests count D1 statements + API
// requests conservatively (including every statement inside D1 batches).
export const MAX_REFERRAL_RECONCILIATION_WINDOWS = 10;

export function referralReconciliationOffset(value = 0) {
  if (!Number.isSafeInteger(value) || value < 0) fail();
  return value;
}

export function referralReconciliationContinuation(response, { offsetStart, rewardId, checkedAt }) {
  if (response?.scanComplete !== false) return null;
  const start = referralReconciliationOffset(offsetStart);
  const next = referralReconciliationOffset(response.nextOffset);
  if (response.status !== 'manual_review' || response.complete === true ||
      !Number.isSafeInteger(response.transactionsSeen) || response.transactionsSeen <= 0 ||
      next <= start || next - start !== response.transactionsSeen) fail();
  return Object.freeze({ status: 'pending', reason: 'referral_reconciliation_continues',
    rewardId, reconciliationRunId: response.runId, checkedAt, nextOffset: next });
}

export function boundReferralReconciliationContinuation(recheck, completedWindows) {
  if (!Number.isSafeInteger(completedWindows) || completedWindows < 1) fail();
  if (recheck?.status !== 'pending' || completedWindows < MAX_REFERRAL_RECONCILIATION_WINDOWS) return recheck;
  return Object.freeze({ ...recheck, status: 'manual_review', reason: 'referral_reconciliation_scan_budget_exhausted' });
}
