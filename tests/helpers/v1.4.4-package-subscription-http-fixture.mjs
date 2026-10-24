import fs from 'node:fs';
import assert from 'node:assert/strict';
import { foundationFixture, signedInitData } from './v1.4.1-fixtures.mjs';
import { authoritySeconds } from '../../src/v1.4.1/authority-resolver.mjs';
import { PACKAGE_DURATIONS, PACKAGE_CANONICAL_PRICES } from '../../src/v1.4.4/package-contract.mjs';

// Genuine closed owner session and subscription HTTP producer, using only an
// in-memory database. No invoice, payment or provider operation is performed.
export async function packageSubscriptionHttpFixture(t, { paymentsEnabled = true } = {}) {
  const f = foundationFixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: f.now * 1000 });
  f.sqlite.function('current_timestamp', { deterministic: false }, () =>
    new Date(f.now * 1000).toISOString().slice(0, 19).replace('T', ' '));
  f.sqlite.function('unixepoch', { deterministic: false, varargs: true }, (...args) =>
    !args.length || args[0] === 'now' ? f.now : authoritySeconds(args[0]));
  for (const name of ['0026-v1.3.6-stars-core-foundation.sql', '0027-v1.3.6-stars-access-and-reconciliation.sql',
    '0066-v1.4.3-subscription-lifecycle-foundation.sql', '0067-v1.4.3-lifecycle-engine-binding.sql',
    '0068-v1.4.3-provider-and-review-binding.sql', '0069-v1.4.3-d1-compatibility.sql',
    '0070-v1.4.3-refund-notification.sql', '0071-v1.4.3-refund-contract-retirement.sql',
    '0072-v1.4.4-package-contract.sql', '0073-v1.4.4-package-payment-review.sql'])
    f.sqlite.exec(fs.readFileSync(new URL('../../migrations/' + name, import.meta.url), 'utf8'));
  const candidate = 'e'.repeat(40), revision = 17;
  f.sqlite.prepare("INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,updated_at) VALUES(1,?,?,'closed',0,?)")
    .run(candidate, revision, f.now);
  f.serverEnv = { ...f.serverEnv, STARS_PAYMENTS_ENABLED: String(paymentsEnabled), STARS_BILLING_MODE: 'prepaid',
    STARS_PRICE_VERSION: '1', STARS_TERMS_REVISION: '2026-09-10.stars-v1', STARS_RECURRING_ENABLED: 'true',
    STARS_INVOICE_SECRET: 'offline-v144-client-http-secret-more-than-32-characters', STARS_ROLLOUT_MODE: 'allowlist',
    STARS_ROLLOUT_ALLOWLIST: '900', STARS_PACKAGES_ENABLED: 'true', STARS_PACKAGE_3M_ENABLED: 'true',
    V141_AUTHORIZATION_ENABLED: 'true', REBUILD_V140_ADMIN_ACCESS_ENABLED: 'true',
    REBUILD_V140_RELEASE_LEASE_REQUIRED: 'true', REBUILD_V140_OWNER_WINDOW: 'false',
    REBUILD_V140_RC_SHA: candidate, REBUILD_V140_RELEASE_REVISION: String(revision) };
  for (const plan of ['professional', 'dragon']) for (const [code, period] of Object.entries(PACKAGE_DURATIONS))
    f.sqlite.prepare(`INSERT INTO price_book(price_id,price_version,plan_code,currency,amount_stars,
      access_seconds,billing_mode,publication_state,terms_revision,valid_from,created_at)
      VALUES(?,1,?,'XTR',?,?,'prepaid','approved',?,?,?)`).run(`${plan}-${period.durationDays}d-prepaid-v1`,
      plan, PACKAGE_CANONICAL_PRICES[plan][code], period.periodSeconds, f.serverEnv.STARS_TERMS_REVISION,
      f.now - 10000, f.now - 10000);
  f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(900,'free','system_default')").run();
  f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(900,'none','system_default')").run();
  const session = await f.call(900, 'session', { method: 'POST', token: null,
    payload: { initData: signedInitData(900, f.now) }, customEnv: f.serverEnv });
  assert.equal(session.status, 200, JSON.stringify(session.data));
  const read = async resource => {
    const result = await f.call(900, resource, { token: session.data.sessionToken, customEnv: f.serverEnv });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  };
  return { ...f, session: session.data, read };
}
