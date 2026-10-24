import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASELINE_GRACE_POLICY, LIFECYCLE_MONTH_SECONDS, LIFECYCLE_STATES,
  LIFECYCLE_ORDER_STATES, LIFECYCLE_PROJECTION_BOUNDARY,
  LIFECYCLE_TRANSITION_DESCRIPTORS, lifecycleEventIdentity,
  lifecycleEventRole, normalizeGracePolicy, normalizeLifecycleAction,
  normalizeLifecycleContract, normalizeLifecycleEvent,
} from '../src/v1.4.3/lifecycle-contract.mjs';

const timestamp = 1_791_000_000;
const payloadDigest = 'a'.repeat(64);
const contract = (patch = {}) => ({
  schemaVersion: 1, contractId: 'offline-contract-01', userId: 101,
  planCode: 'professional', billingMode: 'recurring', currency: 'XTR',
  amountStars: 249, periodSeconds: 2_592_000, invoicePayloadDigest: payloadDigest,
  createdAt: timestamp, consentEvidenceId: 'terms-acceptance-01',
  policyVersion: BASELINE_GRACE_POLICY.policyVersion, ...patch,
});
const event = (patch = {}) => ({
  schemaVersion: 1, eventId: 'offline-event-01', contractId: 'offline-contract-01',
  userId: 101, eventType: 'payment.confirmed', source: 'telegram_webhook',
  receivedAt: timestamp + 10, providerOccurredAt: timestamp + 9,
  timeBasis: 'provider_reported', evidence: {
    sourceUpdateId: 7001, payloadDigest, telegramChargeId: 'offline-charge-01',
    direction: 'incoming', currency: 'XTR', amountStars: 249,
    paidUntil: timestamp + 2_592_009, isRecurring: true, isFirstRecurring: true,
  }, ...patch,
});
const control = (state, patch = {}) => event({
  eventType: `renewal.${state}`, providerOccurredAt: null,
  timeBasis: 'server_received', evidence: { sourceUpdateId: 7002, payloadDigest,
    providerState: state }, ...patch,
});
const refund = (patch = {}) => event({
  eventType: 'financial.refund_confirmed', evidence: {
    sourceUpdateId: 7003, payloadDigest, telegramChargeId: 'offline-charge-01',
    direction: 'outgoing', currency: 'XTR', amountStars: 249,
  }, ...patch,
});

test('shared financial constants do not mix order, renewal and access state namespaces', () => {
  assert.equal(LIFECYCLE_MONTH_SECONDS, 2_592_000);
  assert.equal(LIFECYCLE_STATES.length, 7);
  assert.equal(LIFECYCLE_STATES.includes('paid'), false);
  assert.equal(LIFECYCLE_STATES.includes('precheckout_ok'), false);
  assert.equal(LIFECYCLE_ORDER_STATES.includes('precheckout_ok'), true);
  assert.equal(LIFECYCLE_PROJECTION_BOUNDARY.unknownLifecycleState, null);
  assert.equal(LIFECYCLE_PROJECTION_BOUNDARY.precheckoutGrantsPaidPeriod, false);
  assert.equal(LIFECYCLE_PROJECTION_BOUNDARY.previewIsPaidSubscription, false);
});

test('recurring requires explicit consent and a genuine monthly product; prepaid stays prepaid', () => {
  assert.throws(() => normalizeLifecycleContract(contract({ consentEvidenceId: null })),
    { code: 'lifecycle_recurring_consent_required' });
  for (const patch of [{ periodSeconds: 86400 }, { currency: 'USD' },
    { planCode: 'free' }, { planCode: 'dragon_preview' }, { billingMode: 'automatic' }]) {
    assert.throws(() => normalizeLifecycleContract(contract(patch)));
  }
  const prepaid = normalizeLifecycleContract(contract({ billingMode: 'prepaid', consentEvidenceId: null }));
  assert.equal(prepaid.billingMode, 'prepaid');
  assert.equal(prepaid.consentEvidenceId, null);
  assert.equal(LIFECYCLE_PROJECTION_BOUNDARY.automaticPrepaidConversion, false);
});

test('no additional grace is minted by default; a nonzero policy needs recorded approval', () => {
  const baseline = normalizeGracePolicy();
  assert.equal(baseline.graceSeconds, 0);
  assert.equal(baseline.approvalEvidenceId, null);
  assert.equal(baseline.basis, 'preserve_existing_no_unpaid_extension');
  assert.throws(() => normalizeGracePolicy({ policyVersion: 'policy-new', graceSeconds: 86400 }),
    { code: 'lifecycle_grace_approval_required' });
  const explicit = normalizeGracePolicy({ policyVersion: 'policy-approved', graceSeconds: 86400,
    approvalEvidenceId: 'owner-policy-decision-02' });
  assert.equal(explicit.graceSeconds, 86400);
  assert.equal(explicit.basis, 'explicit_recorded_policy');
  assert.ok(Object.isFrozen(baseline));
});

test('subject and payload matching are strict, and failures do not expose input values', () => {
  for (const badId of [true, '101', 0, -1, 101.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeLifecycleContract(contract({ userId: badId })),
      { code: 'lifecycle_user_invalid' });
  }
  assert.throws(() => normalizeLifecycleEvent(event({ userId: 102 }), contract()),
    { code: 'lifecycle_subject_mismatch' });
  assert.throws(() => normalizeLifecycleEvent(event({ contractId: 'another-contract' }), contract()),
    { code: 'lifecycle_subject_mismatch' });
  assert.throws(() => normalizeLifecycleEvent(event({ evidence: {
    ...event().evidence, payloadDigest: 'b'.repeat(64),
  } }), contract()), { code: 'lifecycle_payload_mismatch' });
  const secret = 'sensitive-offline-token-not-a-real-secret';
  try {
    normalizeLifecycleContract(contract({ BOT_TOKEN: secret }));
    assert.fail('unknown secret-bearing key was accepted');
  } catch (error) {
    assert.equal(error.code, 'lifecycle_contract_shape_invalid');
    assert.equal(error.message.includes(secret), false);
  }
  assert.throws(() => normalizeLifecycleEvent(event({ evidence: {
    ...event().evidence, invoice_payload: 'raw-provider-payload',
  } }), contract()), { code: 'lifecycle_evidence_shape_invalid' });
});

test('active/canceled/failed BotSubscriptionUpdated cannot manufacture a payment or provider date', () => {
  for (const state of ['active', 'canceled', 'failed']) {
    const normalized = normalizeLifecycleEvent(control(state), contract());
    assert.equal(normalized.providerOccurredAt, null);
    assert.equal(normalized.evidence.telegramChargeId, null);
    assert.equal(normalized.evidence.paidUntil, null);
    assert.equal(lifecycleEventRole(normalized.eventType), 'renewal_control_only');
    for (const patch of [{ telegramChargeId: 'fake-charge' },
      { amountStars: 249 }, { paidUntil: timestamp + 2592000 }]) {
      assert.throws(() => normalizeLifecycleEvent(control(state, { evidence: {
        ...control(state).evidence, ...patch,
      } }), contract()), { code: 'lifecycle_control_is_not_payment' });
    }
    assert.throws(() => normalizeLifecycleEvent(control(state, {
      providerOccurredAt: timestamp, timeBasis: 'provider_reported',
    }), contract()), { code: 'lifecycle_control_is_not_payment' });
  }
  assert.throws(() => normalizeLifecycleEvent(control('cancelled'), contract()),
    { code: 'lifecycle_event_type_invalid' });
  assert.throws(() => normalizeLifecycleEvent(control('active'), contract({ billingMode: 'prepaid' })),
    { code: 'lifecycle_recurring_contract_required' });
});

test('money requires matching product and charge; historical late evidence remains recordable', () => {
  const confirmed = normalizeLifecycleEvent(event(), contract());
  assert.equal(confirmed.evidence.paidUntil, timestamp + 2592009);
  assert.equal(lifecycleEventRole(confirmed.eventType), 'payment_evidence_candidate');
  for (const patch of [{ amountStars: 499 }, { telegramChargeId: null },
    { direction: 'outgoing' }, { payloadDigest: null }]) {
    assert.throws(() => normalizeLifecycleEvent(event({ evidence: {
      ...event().evidence, ...patch,
    } }), contract()), { code: 'lifecycle_payment_evidence_invalid' });
  }
  const late = normalizeLifecycleEvent(event({ receivedAt: timestamp + 5_184_000,
    providerOccurredAt: null, timeBasis: 'server_received' }), contract());
  assert.ok(late.evidence.paidUntil < late.receivedAt);
  // Recordable evidence does not mean current paid access or a second period.
  assert.equal('hasPaidAccess' in late, false);
  assert.equal(LIFECYCLE_PROJECTION_BOUNDARY.pendingOperationGrantsPaidPeriod, false);
  assert.throws(() => normalizeLifecycleEvent(event(), contract({ billingMode: 'prepaid' })),
    { code: 'lifecycle_prepaid_product_mismatch' });
  const prepaid = event({ evidence: { ...event().evidence, isRecurring: false,
    isFirstRecurring: false, paidUntil: null } });
  assert.equal(normalizeLifecycleEvent(prepaid, contract({ billingMode: 'prepaid' })).evidence.paidUntil, null);
});

test('payment and refund sharing a Telegram transaction ID are distinct; repeated routes dedupe one movement', () => {
  const inbound = lifecycleEventIdentity(event(), contract());
  const outbound = lifecycleEventIdentity(refund(), contract());
  assert.notEqual(inbound, outbound);
  assert.equal(inbound, 'stars:incoming:offline-charge-01');
  assert.equal(outbound, 'stars:outgoing:offline-charge-01');
  const reconciled = refund({ source: 'telegram_reconciliation', evidence: {
    ...refund().evidence, sourceUpdateId: null, transactionId: 'offline-charge-01',
  } });
  assert.equal(lifecycleEventIdentity(reconciled, contract()), outbound);
  assert.throws(() => normalizeLifecycleEvent(refund({ evidence: {
    ...refund().evidence, direction: 'incoming',
  } }), contract()), { code: 'lifecycle_refund_evidence_invalid' });
  assert.throws(() => normalizeLifecycleEvent(event({ source: 'telegram_reconciliation',
    evidence: { ...event().evidence, transactionId: 'unrelated-charge' } }), contract()),
  { code: 'lifecycle_payment_transaction_mismatch' });
});

test('unknown balance loss remains review; explicit chargeback needs reviewed evidence', () => {
  const observation = event({ eventType: 'financial.review_required',
    source: 'telegram_reconciliation', evidence: {
      transactionId: 'offline-unknown-outgoing', direction: 'outgoing',
      reasonCode: 'outgoing_invoice_type_unproved',
    } });
  const normalized = normalizeLifecycleEvent(observation, contract());
  assert.equal(lifecycleEventRole(normalized.eventType), 'unclassified_financial_observation');
  assert.equal(normalized.evidence.telegramChargeId, null);
  assert.equal(LIFECYCLE_PROJECTION_BOUNDARY.inferredBalanceLossMeansChargeback, false);
  const reviewed = event({ eventType: 'financial.chargeback_confirmed', source: 'owner_review',
    evidence: { ...refund().evidence, sourceUpdateId: null, reviewEvidenceId: 'dispute-reviewed-01' } });
  assert.equal(lifecycleEventIdentity(reviewed, contract()), lifecycleEventIdentity(refund(), contract()));
  assert.throws(() => normalizeLifecycleEvent({ ...reviewed, source: 'telegram_reconciliation' }, contract()),
    { code: 'lifecycle_event_source_invalid' });
  assert.throws(() => normalizeLifecycleEvent({ ...reviewed, evidence: {
    ...reviewed.evidence, reviewEvidenceId: null,
  } }, contract()), { code: 'lifecycle_chargeback_review_required' });
});

test('own cancel/re-enable action pending or unknown does not claim confirmed provider success', () => {
  const action = { schemaVersion: 1, actionId: 'offline-action-01',
    contractId: 'offline-contract-01', userId: 101, actionType: 'renewal.cancel',
    state: 'unknown', requestedAt: timestamp + 10 };
  const pending = normalizeLifecycleAction(action, contract());
  assert.equal(pending.providerObservationId, null);
  assert.equal(pending.settledAt, null);
  assert.throws(() => normalizeLifecycleAction({ ...action, state: 'confirmed' }, contract()),
    { code: 'lifecycle_action_observation_required' });
  assert.throws(() => normalizeLifecycleAction({ ...action, userId: 102 }, contract()),
    { code: 'lifecycle_subject_mismatch' });
  assert.throws(() => normalizeLifecycleAction(action, contract({ billingMode: 'prepaid' })),
    { code: 'lifecycle_recurring_contract_required' });
  const confirmed = normalizeLifecycleAction({ ...action, state: 'confirmed',
    settledAt: timestamp + 11, providerObservationId: 'provider-control-observation-01' }, contract());
  assert.equal(confirmed.state, 'confirmed');
  assert.equal('paidUntil' in confirmed, false);
  assert.ok(Object.isFrozen(confirmed));
});

test('projection specification retains other periods and source separation instead of last-event-wins', () => {
  assert.ok(LIFECYCLE_TRANSITION_DESCRIPTORS['financial.refund_confirmed'].requires
    .includes('retain_other_valid_periods_and_grants'));
  assert.ok(LIFECYCLE_TRANSITION_DESCRIPTORS['renewal.canceled'].requires
    .includes('preserve_verified_paid_remainder'));
  assert.equal(LIFECYCLE_PROJECTION_BOUNDARY.controlOrderUsesUpdateIdAsUniversalClock, false);
  assert.equal(LIFECYCLE_PROJECTION_BOUNDARY.missingWebhookMeansPaymentFailed, false);
  assert.ok(Object.isFrozen(LIFECYCLE_TRANSITION_DESCRIPTORS['payment.confirmed'].requires));
  assert.ok(Object.isFrozen(normalizeLifecycleEvent(event(), contract()).evidence));
  assert.throws(() => normalizeLifecycleEvent(event({ eventType: 'payment.pending' }), contract()),
    { code: 'lifecycle_event_type_invalid' });
  assert.throws(() => normalizeLifecycleEvent(event({ source: 'client' }), contract()),
    { code: 'lifecycle_event_source_invalid' });
});
