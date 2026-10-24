import { readAuthorityLifecycleSource, compileAuthorityLifecycleSourceAssertions } from '../v1.4.1/authority-resolver.mjs';
import { BASELINE_GRACE_POLICY } from './lifecycle-contract.mjs';

// A projector receives an in-memory verifier result, never request JSON. The
// authenticated resolver owns the financial verification and recorded reads.
const verified = new WeakMap();
const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};

export function createLifecycleAuthorityBridge() {
  return Object.freeze({ verify(sourceToken) {
    // The resolver creates this private source token only after its recorded
    // ledger/order/price/consent/link checks. No exported API can mint it.
    const facts = readAuthorityLifecycleSource(sourceToken);
    const telegramId = facts.telegramId;
    if (!positive(telegramId)) fail('lifecycle_subject_mismatch');
    for (const key of ['subscriptions', 'periods', 'contracts', 'providerEvents', 'commands', 'reviewResolutions']) {
      if (!Array.isArray(facts[key]) || facts[key].length > 128) fail('lifecycle_verified_facts_invalid');
    }
    if (facts.subscriptions.some(row => row.telegram_id !== telegramId) ||
        facts.contracts.some(row => row.telegram_id !== telegramId) ||
        facts.providerEvents.some(row => row.telegram_id !== telegramId) ||
        facts.periods.some(row => !positive(row.startsAt) || !positive(row.endsAt) || row.endsAt <= row.startsAt ||
          !['active', 'refunded', 'chargeback'].includes(row.status) ||
          !['professional', 'dragon'].includes(row.planCode) ||
          !facts.subscriptions.some(sub => sub.subscription_id === row.subscriptionId && sub.plan_code === row.planCode)))
      fail('lifecycle_verified_facts_invalid');
    // Part 2 retains the recorded zero-day baseline. Provider JSON cannot
    // supply a grace policy or an administrative override.
    const snapshot = freeze({ ...facts, gracePolicy: BASELINE_GRACE_POLICY });
    const token = Object.freeze({ version: 1, authority: 'verified_financial_history' });
    verified.set(token, { snapshot, sourceToken });
    return token;
  } });
}

export function readVerifiedLifecycleFacts(token) {
  if (!verified.has(token)) fail('untrusted_lifecycle_facts');
  return verified.get(token).snapshot;
}
export const unwrapVerifiedLifecycleFacts = readVerifiedLifecycleFacts;
export const isVerifiedLifecycleFacts = token => verified.has(token);
export function compileVerifiedLifecycleAssertions(token) {
  if (!verified.has(token)) fail('untrusted_lifecycle_facts');
  return compileAuthorityLifecycleSourceAssertions(verified.get(token).sourceToken);
}
