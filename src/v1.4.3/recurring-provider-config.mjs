import { readStarsCoreConfig, STARS_MONTH_SECONDS } from '../v1.3.6/stars-core-foundation.mjs';

export const STARS_RECURRING_TERMS_REVISION = '2026-10-03.stars-recurring-v1';
export const STARS_RECURRING_PROVIDER_VERSION = '2026-10-03.v1.4.3.p03';

// A separate opt-in release; the accepted global prepaid configuration and
// its existing price/terms remain intact. Request JSON cannot enable this.
export function readStarsRecurringConfig(env = {}) {
  const core = readStarsCoreConfig(env);
  const enabled = env.STARS_RECURRING_ENABLED === 'true';
  const priceVersion = Number(env.STARS_RECURRING_PRICE_VERSION || 1);
  const termsRevision = String(env.STARS_RECURRING_TERMS_REVISION || STARS_RECURRING_TERMS_REVISION).trim();
  const problems = [];
  if (!core.ready) problems.push('stars_payments_not_ready');
  if (!Number.isSafeInteger(priceVersion) || priceVersion < 1) problems.push('recurring_price_version_invalid');
  if (termsRevision !== STARS_RECURRING_TERMS_REVISION) problems.push('recurring_terms_revision_unreleased');
  return Object.freeze({ enabled, ready: enabled && problems.length === 0,
    billingMode: 'recurring', priceVersion, termsRevision,
    periodSeconds: STARS_MONTH_SECONDS, problems: Object.freeze(problems) });
}
