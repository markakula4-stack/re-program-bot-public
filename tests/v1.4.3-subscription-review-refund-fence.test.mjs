import test from 'node:test';
import assert from 'node:assert/strict';
import { cabinetSubscriptionFixture,next } from './helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import { resolveRetainedStarsPaymentReview } from '../src/v1.4.3/subscription-review-runtime.mjs';
import { compileVerifiedOwnerSubscriptionReviewAssertions } from '../src/v1.4.3/subscription-action-authority.mjs';

function refundAttempt(f,ledgerEntryId,status) {
  const p=f.sqlite.prepare('SELECT * FROM payment_ledger WHERE ledger_entry_id=?').get(ledgerEntryId);
  f.sqlite.prepare(`INSERT INTO payment_refunds(refund_id,idempotency_key,order_id,original_ledger_entry_id,
    telegram_id,telegram_payment_charge_id,currency,amount_stars,reason_code,requested_by_type,requested_by,
    status,requested_at,confirmed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'payment_support_review','admin',900,?,?,?,?)`)
    .run(crypto.randomUUID(),'pending-owner-refund-'+next(),p.order_id,p.ledger_entry_id,p.telegram_id,
      p.telegram_payment_charge_id,p.currency,p.amount_stars,status,f.now,status==='confirmed'?f.now:null,f.now);
}
const count=(f,table)=>f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

test('requested, unknown and confirmed refunds without a debit each prevent a new owner paid grant',async t=>{
  for(const state of ['requested','manual_review','confirmed']) {
    const f=cabinetSubscriptionFixture(t),paid=await f.retained(),mint=await f.owner();
    const before=count(f,'subscription_access_grants');refundAttempt(f,paid.retained.ledgerEntryId,state);
    await assert.rejects(mint(paid.retained.ledgerEntryId,'apply'),{code:'subscription_review_refund_pending'});
    assert.equal(count(f,'subscription_access_grants'),before);assert.equal(count(f,'subscription_payment_review_settlements'),0);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM payment_ledger WHERE entry_type='refund'").get().n,0);
  }
});

test('a concurrent exact refund admission invalidates the captured absence before owner apply writes',async t=>{
  const f=cabinetSubscriptionFixture(t),paid=await f.retained(),mint=await f.owner(),token=await mint(paid.retained.ledgerEntryId);
  const guards=compileVerifiedOwnerSubscriptionReviewAssertions(token).assertions;
  assert.ok(guards.some(row=>row.sql.includes('FROM payment_refunds')&&row.params.includes(paid.retained.ledgerEntryId)));
  const before=count(f,'subscription_access_grants');
  f.binding.beforeBatch=()=>refundAttempt(f,paid.retained.ledgerEntryId,'requested');
  await assert.rejects(resolveRetainedStarsPaymentReview(token));
  assert.equal(count(f,'subscription_access_grants'),before);assert.equal(count(f,'subscription_payment_review_settlements'),0);
  assert.equal(count(f,'payment_refunds'),1);assert.equal(count(f,'mini_app_atomic_guards'),0);
});

test('an already settled owner apply only returns its stored grant after refund admission',async t=>{
  const f=cabinetSubscriptionFixture(t),paid=await f.retained(),mint=await f.owner();
  const applied=await resolveRetainedStarsPaymentReview(await mint(paid.retained.ledgerEntryId));assert.equal(applied.accessApplied,true);
  const before=count(f,'subscription_access_grants');refundAttempt(f,paid.retained.ledgerEntryId,'manual_review');
  const duplicate=await resolveRetainedStarsPaymentReview(await mint(paid.retained.ledgerEntryId));
  assert.equal(duplicate.status,'duplicate');assert.equal(duplicate.accessApplied,true);
  assert.equal(count(f,'subscription_access_grants'),before);assert.equal(count(f,'subscription_payment_review_settlements'),1);
});
