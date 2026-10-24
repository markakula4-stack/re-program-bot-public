import {
  STARS_BILLING_MODES,
  STARS_CURRENCY,
  STARS_MONTH_SECONDS,
  STARS_ORDER_STATES,
  STARS_PURCHASABLE_PLANS,
} from '../v1.3.6/stars-core-foundation.mjs';

// Stage 1 is a structural boundary, not a payment verifier, projector or writer.
// Provider authentication, ledger authority and own authorization stay with the
// existing runtimes and the stage 2/3 adapters. A valid object grants no access.
export const LIFECYCLE_CONTRACT_VERSION = '2026-10-03.v1.4.3.p01';
export const LIFECYCLE_SCHEMA_VERSION = 1;
export const LIFECYCLE_MONTH_SECONDS = STARS_MONTH_SECONDS;
export const LIFECYCLE_BILLING_MODES = STARS_BILLING_MODES;
export const LIFECYCLE_ORDER_STATES = STARS_ORDER_STATES;
export const LIFECYCLE_STATES = Object.freeze([
  'active', 'cancel_at_period_end', 'payment_failed', 'expired',
  'refunded', 'chargeback', 'suspended',
]);
export const RENEWAL_STATES = Object.freeze([
  'not_applicable', 'unknown', 'active', 'canceled', 'failed', 'inactive',
]);
export const LIFECYCLE_ACTION_TYPES = Object.freeze(['renewal.cancel', 'renewal.enable']);
export const LIFECYCLE_ACTION_STATES = Object.freeze([
  'requested', 'pending', 'confirmed', 'failed', 'unknown',
]);
export const LIFECYCLE_EVENT_TYPES = Object.freeze([
  'payment.confirmed', 'renewal.active', 'renewal.canceled', 'renewal.failed',
  'period.expired', 'financial.refund_confirmed',
  'financial.chargeback_confirmed', 'financial.review_required',
  'access.suspended', 'access.resumed',
]);
export const LIFECYCLE_EVENT_SOURCES = Object.freeze([
  'telegram_webhook', 'telegram_reconciliation', 'server_clock',
  'owner_review', 'admin_policy',
]);

function freeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) freeze(child);
  }
  return Object.freeze(value);
}
function reject(code) {
  throw Object.assign(new Error(code), { code });
}
function record(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject(code);
  if (Object.keys(value).some(key => !keys.includes(key))) reject(code);
  return value;
}
function choice(value, choices, code) {
  if (!choices.includes(value)) reject(code);
  return value;
}
function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) reject(code);
  return value;
}
function seconds(value, code) {
  return integer(value, 1, Number.MAX_SAFE_INTEGER, code);
}
function identifier(value, code) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) reject(code);
  return value;
}
function opaqueId(value, code) {
  if (typeof value !== 'string' || !value.length || value.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(value)) reject(code);
  return value;
}
function digest(value, code) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) reject(code);
  return value;
}
function nullable(value, validator, code) {
  return value === undefined || value === null ? null : validator(value, code);
}
function userId(value) {
  // Unlike the legacy convenience normalizer, contracts do not coerce a bool,
  // whitespace, float or arbitrary string into a Telegram identity.
  return integer(value, 1, Number.MAX_SAFE_INTEGER, 'lifecycle_user_invalid');
}

export const BASELINE_GRACE_POLICY = freeze({
  policyVersion: '2026-10-03.v1.4.3.baseline-zero', graceSeconds: 0,
  approvalEvidenceId: null, basis: 'preserve_existing_no_unpaid_extension',
});

export function normalizeGracePolicy(value = BASELINE_GRACE_POLICY) {
  record(value, ['policyVersion', 'graceSeconds', 'approvalEvidenceId', 'basis'], 'lifecycle_grace_shape_invalid');
  const policyVersion = identifier(value.policyVersion, 'lifecycle_grace_version_invalid');
  const graceSeconds = integer(value.graceSeconds, 0, STARS_MONTH_SECONDS, 'lifecycle_grace_seconds_invalid');
  const approvalEvidenceId = nullable(value.approvalEvidenceId, identifier, 'lifecycle_grace_approval_invalid');
  if (graceSeconds > 0 && !approvalEvidenceId) reject('lifecycle_grace_approval_required');
  const basis = graceSeconds > 0 ? 'explicit_recorded_policy' : 'preserve_existing_no_unpaid_extension';
  if (value.basis !== undefined && value.basis !== basis) reject('lifecycle_grace_basis_invalid');
  return freeze({ policyVersion, graceSeconds, approvalEvidenceId, basis });
}

export function normalizeLifecycleContract(value) {
  record(value, [
    'schemaVersion', 'contractId', 'userId', 'planCode', 'billingMode',
    'currency', 'amountStars', 'periodSeconds', 'invoicePayloadDigest',
    'createdAt', 'consentEvidenceId', 'policyVersion',
  ], 'lifecycle_contract_shape_invalid');
  if (value.schemaVersion !== LIFECYCLE_SCHEMA_VERSION) reject('lifecycle_schema_version_invalid');
  const contractId = identifier(value.contractId, 'lifecycle_contract_id_invalid');
  const telegramId = userId(value.userId);
  const planCode = choice(value.planCode, STARS_PURCHASABLE_PLANS, 'lifecycle_plan_invalid');
  const billingMode = choice(value.billingMode, STARS_BILLING_MODES, 'lifecycle_billing_mode_invalid');
  if (value.currency !== STARS_CURRENCY) reject('lifecycle_currency_invalid');
  const amountStars = integer(value.amountStars, 1, 10_000, 'lifecycle_amount_invalid');
  if (value.periodSeconds !== STARS_MONTH_SECONDS) reject('lifecycle_period_invalid');
  const invoicePayloadDigest = digest(value.invoicePayloadDigest, 'lifecycle_payload_digest_invalid');
  const createdAt = seconds(value.createdAt, 'lifecycle_created_at_invalid');
  const consentEvidenceId = nullable(value.consentEvidenceId, identifier, 'lifecycle_consent_invalid');
  if (billingMode === 'recurring' && !consentEvidenceId) reject('lifecycle_recurring_consent_required');
  const policyVersion = identifier(value.policyVersion, 'lifecycle_policy_version_invalid');
  return freeze({
    schemaVersion: LIFECYCLE_SCHEMA_VERSION, contractId, userId: telegramId,
    planCode, billingMode, currency: STARS_CURRENCY, amountStars,
    periodSeconds: STARS_MONTH_SECONDS, invoicePayloadDigest, createdAt,
    consentEvidenceId, policyVersion,
  });
}

const PROVIDER_SOURCES = Object.freeze(['telegram_webhook', 'telegram_reconciliation']);
export const LIFECYCLE_EVENT_RULES = freeze({
  'payment.confirmed': {
    sources: PROVIDER_SOURCES, role: 'payment_evidence_candidate',
    changesPaidPeriod: 'only_after_existing_ledger_verifies_exact_charge',
  },
  'renewal.active': {
    sources: ['telegram_webhook'], role: 'renewal_control_only', changesPaidPeriod: 'never',
  },
  'renewal.canceled': {
    sources: ['telegram_webhook'], role: 'renewal_control_only', changesPaidPeriod: 'never',
  },
  'renewal.failed': {
    sources: ['telegram_webhook'], role: 'renewal_control_only', changesPaidPeriod: 'never',
  },
  'period.expired': {
    sources: ['server_clock'], role: 'time_recheck', changesPaidPeriod: 'never',
  },
  'financial.refund_confirmed': {
    sources: PROVIDER_SOURCES, role: 'compensation_evidence_candidate',
    changesPaidPeriod: 'only_the_verified_affected_charge',
  },
  'financial.chargeback_confirmed': {
    sources: ['owner_review'], role: 'reviewed_compensation_candidate',
    changesPaidPeriod: 'only_after_verified_dispute_and_existing_compensation_policy',
  },
  'financial.review_required': {
    sources: ['telegram_reconciliation', 'owner_review'], role: 'unclassified_financial_observation',
    changesPaidPeriod: 'never',
  },
  'access.suspended': {
    sources: ['admin_policy'], role: 'administrative_policy', changesPaidPeriod: 'never',
  },
  'access.resumed': {
    sources: ['admin_policy'], role: 'administrative_policy', changesPaidPeriod: 'never',
  },
});

export function lifecycleEventRole(eventType) {
  choice(eventType, LIFECYCLE_EVENT_TYPES, 'lifecycle_event_type_invalid');
  return LIFECYCLE_EVENT_RULES[eventType].role;
}

export function normalizeLifecycleEvent(value, expectedContract) {
  const contract = normalizeLifecycleContract(expectedContract);
  record(value, [
    'schemaVersion', 'eventId', 'contractId', 'userId', 'eventType', 'source',
    'receivedAt', 'providerOccurredAt', 'timeBasis', 'evidence',
  ], 'lifecycle_event_shape_invalid');
  if (value.schemaVersion !== LIFECYCLE_SCHEMA_VERSION) reject('lifecycle_schema_version_invalid');
  const eventId = identifier(value.eventId, 'lifecycle_event_id_invalid');
  const contractId = identifier(value.contractId, 'lifecycle_contract_id_invalid');
  const telegramId = userId(value.userId);
  if (contractId !== contract.contractId || telegramId !== contract.userId) reject('lifecycle_subject_mismatch');
  const eventType = choice(value.eventType, LIFECYCLE_EVENT_TYPES, 'lifecycle_event_type_invalid');
  const source = choice(value.source, LIFECYCLE_EVENT_RULES[eventType].sources, 'lifecycle_event_source_invalid');
  const receivedAt = seconds(value.receivedAt, 'lifecycle_received_at_invalid');
  const providerOccurredAt = nullable(value.providerOccurredAt, seconds, 'lifecycle_provider_time_invalid');
  const timeBasis = choice(value.timeBasis, ['server_received', 'provider_reported', 'server_clock'], 'lifecycle_time_basis_invalid');
  if ((timeBasis === 'provider_reported') !== (providerOccurredAt !== null)) reject('lifecycle_time_evidence_mismatch');
  if ((source === 'server_clock') !== (timeBasis === 'server_clock')) reject('lifecycle_clock_source_mismatch');
  const e = record(value.evidence, [
    'sourceUpdateId', 'payloadDigest', 'telegramChargeId', 'transactionId',
    'direction', 'currency', 'amountStars', 'paidUntil', 'isRecurring',
    'isFirstRecurring', 'providerState', 'reviewEvidenceId', 'reasonCode',
  ], 'lifecycle_evidence_shape_invalid');
  const evidence = {
    sourceUpdateId: nullable(e.sourceUpdateId,
      (v, code) => integer(v, 0, Number.MAX_SAFE_INTEGER, code), 'lifecycle_update_id_invalid'),
    payloadDigest: nullable(e.payloadDigest, digest, 'lifecycle_payload_digest_invalid'),
    telegramChargeId: nullable(e.telegramChargeId, opaqueId, 'lifecycle_charge_id_invalid'),
    transactionId: nullable(e.transactionId, opaqueId, 'lifecycle_transaction_id_invalid'),
    direction: e.direction == null ? null : choice(e.direction, ['incoming', 'outgoing'], 'lifecycle_direction_invalid'),
    currency: e.currency == null ? null : choice(e.currency, [STARS_CURRENCY], 'lifecycle_currency_invalid'),
    amountStars: nullable(e.amountStars,
      (v, code) => integer(v, 1, 10_000, code), 'lifecycle_amount_invalid'),
    paidUntil: nullable(e.paidUntil, seconds, 'lifecycle_paid_until_invalid'),
    isRecurring: e.isRecurring ?? false,
    isFirstRecurring: e.isFirstRecurring ?? false,
    providerState: e.providerState == null ? null : choice(e.providerState,
      ['active', 'canceled', 'failed'], 'lifecycle_provider_state_invalid'),
    reviewEvidenceId: nullable(e.reviewEvidenceId, identifier, 'lifecycle_review_evidence_invalid'),
    reasonCode: nullable(e.reasonCode, identifier, 'lifecycle_reason_invalid'),
  };
  if (typeof evidence.isRecurring !== 'boolean' || typeof evidence.isFirstRecurring !== 'boolean') reject('lifecycle_recurring_flags_invalid');
  if (evidence.isFirstRecurring && !evidence.isRecurring) reject('lifecycle_recurring_flags_invalid');
  if (evidence.payloadDigest !== null && evidence.payloadDigest !== contract.invoicePayloadDigest) reject('lifecycle_payload_mismatch');
  if (source === 'telegram_webhook' && evidence.sourceUpdateId === null) reject('lifecycle_update_id_required');
  if (source === 'telegram_reconciliation' && !evidence.transactionId) reject('lifecycle_transaction_id_required');
  if (source === 'telegram_reconciliation' && !evidence.direction) reject('lifecycle_direction_required');
  if (eventType.startsWith('renewal.')) {
    if (contract.billingMode !== 'recurring') reject('lifecycle_recurring_contract_required');
    if (evidence.providerState !== eventType.slice('renewal.'.length) ||
        evidence.payloadDigest === null) reject('lifecycle_renewal_evidence_invalid');
    // BotSubscriptionUpdated has neither a timestamp, charge nor next-charge
    // date. Injecting those fields would turn a control update into fake money.
    if (providerOccurredAt !== null || evidence.telegramChargeId !== null ||
        evidence.transactionId !== null || evidence.direction !== null ||
        evidence.currency !== null || evidence.amountStars !== null ||
        evidence.paidUntil !== null || evidence.isRecurring || evidence.isFirstRecurring ||
        evidence.reviewEvidenceId !== null) reject('lifecycle_control_is_not_payment');
  } else if (eventType === 'payment.confirmed') {
    if (!evidence.telegramChargeId || evidence.payloadDigest === null ||
        evidence.currency !== STARS_CURRENCY || evidence.amountStars !== contract.amountStars ||
        evidence.direction !== 'incoming' || evidence.providerState !== null ||
        evidence.reviewEvidenceId !== null) reject('lifecycle_payment_evidence_invalid');
    if (source === 'telegram_reconciliation' && evidence.transactionId !== evidence.telegramChargeId) reject('lifecycle_payment_transaction_mismatch');
    if (contract.billingMode === 'recurring') {
      if (!evidence.isRecurring || evidence.paidUntil === null ||
          (providerOccurredAt !== null && evidence.paidUntil <= providerOccurredAt)) reject('lifecycle_recurring_payment_invalid');
    } else if (evidence.isRecurring || evidence.isFirstRecurring || evidence.paidUntil !== null) {
      reject('lifecycle_prepaid_product_mismatch');
    }
  } else if (eventType === 'financial.refund_confirmed') {
    if (!evidence.telegramChargeId || evidence.payloadDigest === null ||
        evidence.currency !== STARS_CURRENCY || evidence.amountStars !== contract.amountStars ||
        evidence.direction !== 'outgoing' || evidence.paidUntil !== null ||
        evidence.providerState !== null || evidence.isRecurring || evidence.isFirstRecurring) reject('lifecycle_refund_evidence_invalid');
    if (source === 'telegram_reconciliation' && evidence.transactionId !== evidence.telegramChargeId) reject('lifecycle_refund_transaction_mismatch');
  } else if (eventType === 'financial.chargeback_confirmed') {
    if (!evidence.telegramChargeId || !evidence.reviewEvidenceId ||
        evidence.payloadDigest === null || evidence.currency !== STARS_CURRENCY ||
        evidence.amountStars !== contract.amountStars ||
        evidence.direction !== 'outgoing' || evidence.paidUntil !== null ||
        evidence.providerState !== null || evidence.isRecurring || evidence.isFirstRecurring) reject('lifecycle_chargeback_review_required');
  } else if (eventType === 'financial.review_required') {
    if (!evidence.reasonCode || evidence.paidUntil !== null ||
        evidence.providerState !== null || evidence.isRecurring || evidence.isFirstRecurring) reject('lifecycle_review_evidence_invalid');
  } else {
    if (evidence.telegramChargeId || evidence.transactionId || evidence.direction ||
        evidence.currency || evidence.amountStars || evidence.paidUntil ||
        evidence.providerState || evidence.isRecurring || evidence.isFirstRecurring) reject('lifecycle_nonfinancial_evidence_invalid');
    if (eventType.startsWith('access.') && (!evidence.reviewEvidenceId || !evidence.reasonCode)) reject('lifecycle_policy_evidence_required');
  }
  return freeze({ schemaVersion: LIFECYCLE_SCHEMA_VERSION, eventId, contractId,
    userId: telegramId, eventType, source, receivedAt, providerOccurredAt, timeBasis, evidence });
}

// The same transaction id is valid for the original payment and its refund.
// Kind is deliberately not part of money identity: later classifying one
// outgoing observation as refund/chargeback must not create another movement.
export function lifecycleEventIdentity(value, expectedContract) {
  const event = normalizeLifecycleEvent(value, expectedContract);
  const e = event.evidence;
  if (e.direction && (e.transactionId || e.telegramChargeId)) {
    return `stars:${e.direction}:${encodeURIComponent(e.transactionId ?? e.telegramChargeId)}`;
  }
  if (event.source === 'telegram_webhook') return `telegram:subscription:${e.sourceUpdateId}`;
  return `lifecycle:${event.eventId}`;
}

export function normalizeLifecycleAction(value, expectedContract) {
  const contract = normalizeLifecycleContract(expectedContract);
  record(value, [
    'schemaVersion', 'actionId', 'contractId', 'userId', 'actionType', 'state',
    'requestedAt', 'settledAt', 'providerObservationId',
  ], 'lifecycle_action_shape_invalid');
  if (value.schemaVersion !== LIFECYCLE_SCHEMA_VERSION) reject('lifecycle_schema_version_invalid');
  const actionId = identifier(value.actionId, 'lifecycle_action_id_invalid');
  const contractId = identifier(value.contractId, 'lifecycle_contract_id_invalid');
  const telegramId = userId(value.userId);
  if (contractId !== contract.contractId || telegramId !== contract.userId) reject('lifecycle_subject_mismatch');
  if (contract.billingMode !== 'recurring') reject('lifecycle_recurring_contract_required');
  const actionType = choice(value.actionType, LIFECYCLE_ACTION_TYPES, 'lifecycle_action_type_invalid');
  const state = choice(value.state, LIFECYCLE_ACTION_STATES, 'lifecycle_action_state_invalid');
  const requestedAt = seconds(value.requestedAt, 'lifecycle_requested_at_invalid');
  const settledAt = nullable(value.settledAt, seconds, 'lifecycle_settled_at_invalid');
  const providerObservationId = nullable(value.providerObservationId, identifier, 'lifecycle_provider_observation_invalid');
  if (settledAt !== null && settledAt < requestedAt) reject('lifecycle_action_time_invalid');
  if (['confirmed', 'failed'].includes(state)) {
    if (settledAt === null || providerObservationId === null) reject('lifecycle_action_observation_required');
  } else if (settledAt !== null || providerObservationId !== null) reject('lifecycle_action_unsettled');
  return freeze({ schemaVersion: LIFECYCLE_SCHEMA_VERSION, actionId, contractId,
    userId: telegramId, actionType, state, requestedAt, settledAt, providerObservationId });
}

// These are specifications for the stage 2 projector, not executable state
// transitions. Recompute from all verified periods; do not last-event-wins.
export const LIFECYCLE_TRANSITION_DESCRIPTORS = freeze({
  'payment.confirmed': {
    from: LIFECYCLE_STATES, candidates: LIFECYCLE_STATES,
    requires: ['existing_ledger_verified_charge_once', 'server_period_projection',
      'preserve_admin_suspension', 'preserve_unresolved_dispute_off_policy',
      'late_receipt_does_not_reactivate_expired_or_compensated_period'],
  },
  'renewal.active': {
    from: LIFECYCLE_STATES, candidates: ['active', 'payment_failed', 'expired', 'refunded', 'chargeback', 'suspended'],
    requires: ['recurring_contract_binding', 'unambiguous_control_observation',
      'no_paid_period_created', 'recompute_verified_periods_at_server_time'],
  },
  'renewal.canceled': {
    from: LIFECYCLE_STATES, candidates: ['cancel_at_period_end', 'expired', 'refunded', 'chargeback', 'suspended'],
    requires: ['recurring_contract_binding', 'preserve_verified_paid_remainder',
      'recompute_verified_periods_at_server_time'],
  },
  'renewal.failed': {
    from: LIFECYCLE_STATES, candidates: ['payment_failed', 'expired', 'refunded', 'chargeback', 'suspended'],
    requires: ['confirmed_provider_failure', 'preserve_verified_paid_remainder',
      'explicit_grace_policy', 'recompute_verified_periods_at_server_time'],
  },
  'period.expired': {
    from: LIFECYCLE_STATES, candidates: ['expired', 'active', 'cancel_at_period_end', 'payment_failed', 'refunded', 'chargeback', 'suspended'],
    requires: ['server_time_recheck', 'latest_verified_periods', 'explicit_grace_policy'],
  },
  'financial.refund_confirmed': {
    from: LIFECYCLE_STATES, candidates: LIFECYCLE_STATES,
    requires: ['affected_charge_compensation_once', 'retain_other_valid_periods_and_grants'],
  },
  'financial.chargeback_confirmed': {
    from: LIFECYCLE_STATES, candidates: LIFECYCLE_STATES,
    requires: ['documented_dispute_evidence', 'existing_compensation_policy', 'retain_unrelated_financial_history'],
  },
  'financial.review_required': {
    from: LIFECYCLE_STATES, candidates: LIFECYCLE_STATES,
    requires: ['retain_observation', 'no_unearned_access', 'no_guessed_compensation'],
  },
  'access.suspended': {
    from: LIFECYCLE_STATES, candidates: ['suspended'],
    requires: ['current_authorized_administrative_policy', 'preserve_data_and_paid_history'],
  },
  'access.resumed': {
    from: ['suspended'], candidates: LIFECYCLE_STATES,
    requires: ['current_authorized_administrative_policy', 'recompute_verified_periods_at_server_time'],
  },
});

export const LIFECYCLE_PROJECTION_BOUNDARY = freeze({
  authority: 'existing_server_financial_authority',
  paidPeriodSource: 'verified_existing_stars_ledger_and_charge_mapping',
  unknownLifecycleState: null,
  reviewDimension: ['clear', 'required', 'pending'],
  pendingOperationGrantsPaidPeriod: false,
  renewalActiveGrantsPaidPeriod: false,
  precheckoutGrantsPaidPeriod: false,
  missingWebhookMeansPaymentFailed: false,
  inferredBalanceLossMeansChargeback: false,
  recurringOptInRequired: true,
  automaticPrepaidConversion: false,
  lifetimeOwnerAccessIsPaidSubscription: false,
  previewIsPaidSubscription: false,
  paidUntilUsesServerVerifiedEvidence: true,
  exactNextChargeDateAvailableFromSubscriptionUpdate: false,
  controlOrderUsesUpdateIdAsUniversalClock: false,
  expiryEffectiveWithoutCron: true,
});
