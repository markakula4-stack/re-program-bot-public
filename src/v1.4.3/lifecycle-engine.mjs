import { BASELINE_GRACE_POLICY } from './lifecycle-contract.mjs';
import { readVerifiedLifecycleFacts } from './lifecycle-authority.mjs';
import { isVerifiedProviderInactiveExit } from '../v1.4.1/authority-resolver.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
const PAID = new Set(['professional', 'dragon']);
const CONTROL = new Set(['active', 'canceled', 'failed']);
const MAX_ROWS = 128;
const canonical = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
const compare = (a, b) => a.startsAt - b.startsAt || a.endsAt - b.endsAt || a.ledgerEntryId.localeCompare(b.ledgerEntryId);

// A delivery timestamp and Telegram update_id are observations, not universal
// provider chronology. Without an authenticated epoch/supersession relation,
// contradictory control observations remain reviewable rather than last-wins.
function renewalProjection(events, commands, contract, reasons, inactiveExits=[], nowSec) {
  const contractId=contract?.contract_id??null;
  const observations = events.filter(event => event.contract_id === contractId &&
    (['provider_control', 'renewal_failed'].includes(event.event_type) ||
      event.event_type === 'command_confirmed' && event.source === 'telegram_update' && CONTROL.has(event.provider_state)));
  const identities = new Map();
  for (const event of observations) {
    const key = event.telegram_update_id === null ? event.event_id : `update:${event.telegram_update_id}`;
    const previous = identities.get(key);
    if (previous && previous.provider_state !== event.provider_state) reasons.add('control_identity_conflict');
    identities.set(key, event);
  }
  const states = new Set([...identities.values()].map(event => event.provider_state));
  const pending = commands.filter(command => command.contract_id === contractId &&
    ['admitted', 'attempted', 'unknown'].includes(command.state));
  if (pending.some(command => command.state === 'unknown')) reasons.add('provider_command_unknown');
  if (states.size > 1) reasons.add('control_order_ambiguous');
  if ([...states].some(state => !CONTROL.has(state))) reasons.add('control_evidence_invalid');
  let state = states.size === 1 && !['control_identity_conflict','provider_update_identity_conflict',
    'provider_update_receipt_without_fact'].some(reason => reasons.has(reason)) &&
    CONTROL.has([...states][0]) ? [...states][0] : 'unknown';
  const acknowledged=commands.filter(command=>command.contract_id===contractId&&command.state==='confirmed'&&
    events.some(event=>event.event_id===command.acknowledgement_event_id&&event.command_id===command.command_id&&
      event.event_type==='command_confirmed'&&event.source==='provider_response'));
  if(acknowledged.length) {
    const latestTime=Math.max(...acknowledged.map(command=>command.attempted_at));
    const latest=acknowledged.filter(command=>command.attempted_at===latestTime);
    if(latest.length!==1) {state='unknown';reasons.add('provider_command_order_ambiguous');}
    else if(latest[0].expected_contract_revision!==contract?.revision) {
      // A later provider observation changed the captured contract epoch. Its
      // delivery time alone cannot establish causality with the command.
      state='unknown';reasons.add('provider_command_ack_order_ambiguous');
    } else if(['provider_update_identity_conflict','provider_update_receipt_without_fact'].some(reason=>reasons.has(reason))) state='unknown';
    else if(latest[0].desired_auto_renew===0) state='canceled';
    else {state='unknown';reasons.add('provider_reenable_permission_pending');pending.push(latest[0]);}
  }
  // A pending provider effect can already have changed auto-renew remotely.
  // The preceding observation remains history, not a current confirmation.
  if(pending.length)state='unknown';
  if(inactiveExits.some(proof=>isVerifiedProviderInactiveExit(proof,contract,nowSec))&&
      [...reasons].every(reason=>reason==='provider_reenable_permission_pending')&&
      !pending.some(command=>['admitted','attempted','unknown'].includes(command.state))){
    reasons.delete('provider_reenable_permission_pending');state='inactive';pending.length=0;
  }
  return { state, observations: [...identities.values()], pending };
}

// Inspect one genuine historical recurring contract independently of the
// currently selected paid segment. A prepaid package becoming current does
// not turn the prior cancellation acknowledgement into an unknown response.
// This projection supplies control state only, never access or a new contract.
export function projectVerifiedRecurringControl({ verifiedFacts, contractId, nowSec } = {}) {
  if (!positive(nowSec)) fail('lifecycle_clock_invalid');
  const facts = readVerifiedLifecycleFacts(verifiedFacts);
  if (typeof contractId !== 'string' || !contractId) fail('lifecycle_contract_invalid');
  const contracts = facts.contracts.filter(row => row.contract_id === contractId && row.retired_at === null);
  if (contracts.length !== 1 || contracts[0].telegram_id !== facts.telegramId)
    fail('lifecycle_contract_invalid');
  const reasons = new Set(facts.reviewReasons ?? []);
  if (facts.reviewRequired) reasons.add('financial_source_review_required');
  const renewal = renewalProjection(facts.providerEvents, facts.commands, contracts[0], reasons,facts.providerInactiveExits,nowSec);
  return freeze({ contractId, revision: contracts[0].revision, renewalState: renewal.state,
    pendingOperations: renewal.pending.length, reviewReasons: [...reasons].sort() });
}

// Recompute from a private, request-local financial authority proof. Structural
// contract/event validators and JSON copies cannot call this with paid facts.
// This calculation has no persistence, provider calls or grant-writing effect.
export function projectVerifiedSubscriptionLifecycle({ verifiedFacts, nowSec } = {}) {
  if (!positive(nowSec)) fail('lifecycle_clock_invalid');
  const facts = readVerifiedLifecycleFacts(verifiedFacts);
  const reasons = new Set(facts.reviewReasons ?? []);
  if (facts.reviewRequired) reasons.add('financial_source_review_required');
  if ((facts.gracePolicy?.graceSeconds ?? 0) !== 0) fail('lifecycle_unapproved_grace_policy');
  const inputPeriods = facts.periods ?? [];
  const contracts = facts.contracts ?? [], providerEvents = facts.providerEvents ?? [], commands = facts.commands ?? [];
  for (const rows of [inputPeriods, contracts, providerEvents, commands, facts.subscriptions ?? []]) {
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) fail('lifecycle_projection_budget_exhausted');
  }
  const ledgerIds = new Map(), excluded = new Set(), chargeIds = new Map();
  for (const period of inputPeriods) {
    if (!positive(period.startsAt) || !positive(period.endsAt) || period.endsAt <= period.startsAt ||
        typeof period.ledgerEntryId !== 'string' || !period.ledgerEntryId ||
        typeof period.subscriptionId !== 'string' || !period.subscriptionId || !PAID.has(period.planCode) ||
        !['active', 'refunded', 'chargeback'].includes(period.status)) {
      reasons.add('paid_period_evidence_invalid'); continue;
    }
    const prior = ledgerIds.get(period.ledgerEntryId);
    if (prior && canonical(prior) !== canonical(period)) {
      excluded.add(period.ledgerEntryId); reasons.add('paid_period_identity_conflict');
    } else ledgerIds.set(period.ledgerEntryId, period);
    if (period.chargeId) {
      const other = chargeIds.get(period.chargeId);
      if (other && other !== period.ledgerEntryId) {
        excluded.add(other); excluded.add(period.ledgerEntryId); reasons.add('paid_charge_identity_conflict');
      }
      chargeIds.set(period.chargeId, period.ledgerEntryId);
    }
  }
  const periods = [...ledgerIds.values()].filter(period => !excluded.has(period.ledgerEntryId)).sort(compare);
  const live = periods.filter(period => period.status === 'active' && period.startsAt <= nowSec && period.endsAt > nowSec);
  const liveSubscriptions = new Set(live.map(period => period.subscriptionId));
  if (liveSubscriptions.size > 1) reasons.add('concurrent_paid_subscriptions');
  let selectedId = liveSubscriptions.size === 1 ? [...liveSubscriptions][0] : null;
  if (selectedId === null && liveSubscriptions.size === 0 && periods.length) {
    selectedId = [...periods].sort((a, b) => b.endsAt - a.endsAt || b.startsAt - a.startsAt ||
      a.subscriptionId.localeCompare(b.subscriptionId))[0].subscriptionId;
  }
  const selected = periods.filter(period => period.subscriptionId === selectedId);
  const summaries = (facts.subscriptions ?? []).filter(sub => sub.subscription_id === selectedId);
  const subscription = summaries.length === 1 ? summaries[0] : null;
  if (selectedId && summaries.length !== 1) reasons.add('subscription_binding_ambiguous');
  const contractIds = new Set(selected.map(period => period.contractId).filter(Boolean));
  const ownOpenContracts = contracts.filter(contract => contract.retired_at === null);
  let contract = contractIds.size === 1 ? contracts.find(item => item.contract_id === [...contractIds][0]) ?? null : null;
  if (!selectedId && ownOpenContracts.length === 1) contract = ownOpenContracts[0];
  if (contractIds.size > 1 || (!selectedId && ownOpenContracts.length > 1)) reasons.add('contract_binding_ambiguous');
  if (contractIds.size && !contract) reasons.add('contract_binding_missing');
  const billingMode = contract ? 'recurring' : subscription?.billing_mode ?? (selected.length ? 'prepaid' : null);
  const renewal = billingMode === 'recurring'
    ? renewalProjection(providerEvents, commands, contract, reasons,facts.providerInactiveExits,nowSec)
    : { state: 'not_applicable', observations: [], pending: [] };
  const active = selected.filter(period => period.status === 'active');
  const current = active.filter(period => period.startsAt <= nowSec && period.endsAt > nowSec);
  const livePlans = new Set(current.map(period => period.planCode));
  if (livePlans.size > 1) reasons.add('paid_plan_binding_ambiguous');
  const currentPeriod = current.length ? [...current].sort((a, b) => b.endsAt - a.endsAt || compare(a, b))[0] : null;
  // Include contiguous verified renewals in the paid-through date; future
  // disconnected periods never grant capabilities before their start.
  let paidUntil = currentPeriod?.endsAt ?? null;
  if (paidUntil !== null) {
    let prior;
    do {
      prior = paidUntil;
      for (const period of active) if (period.startsAt <= paidUntil && period.endsAt > paidUntil) paidUntil = period.endsAt;
    } while (prior !== paidUntil);
  } else if (active.length) paidUntil = Math.max(...active.map(period => period.endsAt));
  const startsAt = currentPeriod ? Math.min(...current.map(period => period.startsAt)) : active.length ? Math.min(...active.map(period => period.startsAt)) : null;
  const identityBlocked = ['paid_period_identity_conflict', 'paid_charge_identity_conflict', 'paid_period_evidence_invalid',
    'concurrent_paid_subscriptions', 'subscription_binding_ambiguous', 'contract_binding_ambiguous',
    'contract_binding_missing', 'paid_plan_binding_ambiguous'].some(reason => reasons.has(reason));
  let paidAccess = current.length > 0 && !identityBlocked && !facts.reviewRequired;
  const failed = renewal.observations.filter(event => event.provider_state === 'failed');
  // A later genuine provider period can clear a previous failure. Receipt time
  // cannot do so: late historic payment evidence is not a successful renewal.
  const unresolvedFailure = failed.some(event => !active.some(period =>
    period.sourceKind === 'payment' && positive(period.occurredAt) &&
    period.occurredAt > event.received_at && period.startsAt >= event.received_at));
  let state = null, reasonCode = 'paid_evidence_absent';
  if (facts.chargebackSuspended) {
    state = 'chargeback'; paidAccess = false; reasons.add('confirmed_dispute_review_required'); reasonCode = 'paid_dispute_policy_off';
  } else if (facts.administrativelySuspended) {
    state = 'suspended'; paidAccess = false; reasonCode = 'paid_administrative_policy_off';
  } else if (identityBlocked || facts.reviewRequired) {
    state = null; paidAccess = false; reasonCode = 'paid_source_review_required';
  } else if (paidAccess) {
    state = unresolvedFailure ? 'payment_failed' : renewal.state === 'canceled' ||
      billingMode === 'prepaid' && subscription?.status === 'cancel_at_period_end' ? 'cancel_at_period_end' : 'active';
    reasonCode = state === 'payment_failed' ? 'renewal_failed_paid_residue_preserved' :
      state === 'cancel_at_period_end' ? 'renewal_canceled_paid_residue_preserved' : 'verified_paid_period';
  } else if (selected.some(period => period.status === 'chargeback')) {
    state = 'chargeback'; reasons.add('confirmed_dispute_review_required'); reasonCode = 'paid_dispute_policy_off';
  } else if (selected.some(period => period.status === 'refunded') && active.length === 0) {
    state = 'refunded'; reasonCode = 'affected_paid_charges_refunded';
  } else if (active.some(period => period.startsAt <= nowSec)) {
    state = 'expired'; reasonCode = 'verified_paid_period_ended';
  } else if (active.length && active.every(period => period.startsAt > nowSec)) {
    reasonCode = 'verified_paid_period_not_started';
  }
  return freeze({
    schemaVersion: 1, state, renewalState: renewal.state, paidAccess,
    subscriptionId: selectedId, planCode: currentPeriod?.planCode ?? subscription?.plan_code ?? contract?.plan_code ?? null,
    billingMode, startsAt, paidUntil, accessUntil: paidAccess ? paidUntil : null,
    contractId: contract?.contract_id ?? null, reasonCode, reviewRequired: reasons.size > 0,
    reviewReasons: [...reasons].sort(), graceSeconds: 0, gracePolicyVersion: BASELINE_GRACE_POLICY.policyVersion,
    pendingOperations: renewal.pending.length, nextChargeAt: null,
  });
}
