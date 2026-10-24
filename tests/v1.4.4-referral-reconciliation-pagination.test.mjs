import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/v1.4.3-p05-offline-network.mjs';
import { referralReconciliationOffset, referralReconciliationContinuation, boundReferralReconciliationContinuation,
  MAX_REFERRAL_RECONCILIATION_WINDOWS } from '../src/v1.3.7/referral-reconciliation-pagination.mjs';

test('referral cursors require strictly increasing bounded-window progress, never authorize a reward', () => {
  const context={offsetStart:2000,rewardId:'synthetic-reward',checkedAt:10};
  const valid={runId:'synthetic-run',status:'manual_review',complete:false,scanComplete:false,nextOffset:4000,transactionsSeen:2000};
  assert.deepEqual(referralReconciliationContinuation(valid,context),{status:'pending',reason:'referral_reconciliation_continues',
    rewardId:context.rewardId,reconciliationRunId:valid.runId,checkedAt:10,nextOffset:4000});
  for(const patch of [{nextOffset:2000},{nextOffset:1999},{nextOffset:Number.MAX_SAFE_INTEGER+1},
    {nextOffset:'4000'},{transactionsSeen:0},{transactionsSeen:1},{transactionsSeen:-1},
    {status:'failed'},{complete:true}]) assert.throws(()=>referralReconciliationContinuation({...valid,...patch},context),
      /referral_reconciliation_cursor_invalid/);
  for(const offset of [-1,0.5,'0',NaN,Infinity])assert.throws(()=>referralReconciliationOffset(offset),/referral_reconciliation_cursor_invalid/);
  assert.equal(referralReconciliationOffset(),0);
  assert.equal(referralReconciliationContinuation({...valid,scanComplete:true},context),null);
  assert.equal(referralReconciliationContinuation({runId:'old-response'},context),null);
});

test('growing or repeating feeds have a finite workflow budget and retain their explicit resume cursor',()=>{
  const pending={status:'pending',reason:'referral_reconciliation_continues',rewardId:'synthetic',nextOffset:20000};
  assert.equal(boundReferralReconciliationContinuation(pending,MAX_REFERRAL_RECONCILIATION_WINDOWS-1),pending);
  const stopped=boundReferralReconciliationContinuation(pending,MAX_REFERRAL_RECONCILIATION_WINDOWS);
  assert.equal(stopped.status,'manual_review');assert.equal(stopped.reason,'referral_reconciliation_scan_budget_exhausted');
  assert.equal(stopped.nextOffset,pending.nextOffset);
  const verified={status:'verified'};
  assert.equal(boundReferralReconciliationContinuation(verified,MAX_REFERRAL_RECONCILIATION_WINDOWS),verified);
  assert.throws(()=>boundReferralReconciliationContinuation(pending,0),/referral_reconciliation_cursor_invalid/);
});
