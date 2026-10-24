import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { createRuntimeAuthorizer, assertRuntimeAuthorizationFresh } from '../src/v1.4.1/runtime-authorizer.mjs';
import { readSubscriptionCatalog, SUBSCRIPTION_CATALOG_VERSION } from '../src/v1.4.2/subscription-catalog.mjs';
import { acceptStarsPurchaseTerms, issueStarsPurchase, handleStarsCommerceUpdate } from '../src/v1.3.6/stars-commerce-runtime.mjs';
import { STARS_MONTH_SECONDS, STARS_TERMS_REVISION } from '../src/v1.3.6/stars-core-foundation.mjs';

const authorizer = createRuntimeAuthorizer();
let sequence = 1_420_000;
function fixture(t, patch = {}) {
  const f = foundationFixture(t);
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0026-v1.3.6-stars-core-foundation.sql', import.meta.url), 'utf8'));
  f.serverEnv = { ...f.serverEnv, STARS_PAYMENTS_ENABLED: 'true', STARS_BILLING_MODE: 'prepaid', STARS_PRICE_VERSION: '1',
    STARS_TERMS_REVISION, STARS_INVOICE_SECRET: 'fictional-v142-catalog-secret-more-than-thirty-two-characters',
    STARS_ROLLOUT_MODE: 'allowlist', STARS_ROLLOUT_ALLOWLIST: '101', ...patch };
  f.authorize = async (id = 101, operation = 'access.read_own') => authorizer.authorize(await f.context(id, operation));
  f.read = async (id = 101) => {
    const authorization = await f.authorize(id);
    const result = await readSubscriptionCatalog({ authorization });
    await assertRuntimeAuthorizationFresh(authorization);
    return result;
  };
  return f;
}
const paid = catalog => catalog.offers.filter(offer => offer.planCode !== 'free');
function insertPrice(f, { plan = 'professional', version = 2, amount = 299, publication = 'approved', suffix = 'primary', terms = STARS_TERMS_REVISION } = {}) {
  f.sqlite.prepare(`INSERT INTO price_book(price_id,price_version,plan_code,currency,amount_stars,access_seconds,
    billing_mode,publication_state,terms_revision,valid_from,valid_until,created_at,created_by)
    VALUES(?,?,?,'XTR',?,?,'prepaid',?,?,?,NULL,?,'offline-v142-fixture')`)
    .run(`${plan}-30d-prepaid-v${version}-${suffix}`, version, plan, amount, STARS_MONTH_SECONDS, publication, terms, f.now - 60, f.now - 60);
}
async function purchase(f, planCode = 'professional') {
  const env = { ...f.serverEnv, V141_AUTHORIZATION_ENABLED: 'false' }, userId = 101;
  await acceptStarsPurchaseTerms(env, { telegramId: userId, telegramUpdateId: ++sequence, acceptedAt: f.now - 2 });
  let invoice;
  const telegramApi = async (_env, method, payload) => {
    if (method === 'sendInvoice') { invoice = payload; return { message_id: ++sequence }; }
    return true;
  };
  const issue = await issueStarsPurchase(env, { telegramId: userId, requestedPlanCode: planCode,
    telegramUpdateId: ++sequence, orderId: crypto.randomUUID(), createdAt: f.now - 1 }, { telegramApi });
  const checkout = await handleStarsCommerceUpdate(env, { update_id: ++sequence, pre_checkout_query: {
    id: `fictional-v142-checkout-${sequence}`, from: { id: userId, is_bot: false }, currency: 'XTR',
    total_amount: issue.amountStars, invoice_payload: invoice.payload } }, { nowSeconds: f.now, telegramApi });
  assert.equal(checkout.approved, true);
  const payment = await handleStarsCommerceUpdate(env, { update_id: ++sequence, message: { date: f.now,
    from: { id: userId, is_bot: false }, chat: { id: userId, type: 'private' }, successful_payment: {
      currency: 'XTR', total_amount: issue.amountStars, invoice_payload: invoice.payload,
      telegram_payment_charge_id: `fictional-v142-charge-${sequence}`, provider_payment_charge_id: '' } } }, { nowSeconds: f.now });
  assert.equal(payment.accessApplied, true);
}

test('own read uses published server prices and manual 30-day terms without any writes or invented native assets', async t => {
  const f = fixture(t), authorization = await f.authorize();
  f.binding.audit.length = 0;
  const changes = f.sqlite.prepare('SELECT total_changes() AS n').get().n;
  const data = await readSubscriptionCatalog({ authorization });
  await assertRuntimeAuthorizationFresh(authorization);
  assert.equal(data.version, SUBSCRIPTION_CATALOG_VERSION);
  assert.deepEqual(data.offers.map(offer => [offer.planCode, offer.amountStars]), [['free', 0], ['professional', 249], ['dragon', 499]]);
  assert.ok(paid(data).every(offer => offer.published && offer.accessSeconds === STARS_MONTH_SECONDS && offer.billingMode === 'prepaid' && !offer.autoRenew));
  assert.ok(paid(data).every(offer => offer.purchaseEligibility.eligible && offer.purchaseEligibility.termsAcceptanceRequired));
  assert.equal(data.offers[0].accessSeconds, null);
  assert.equal(data.offers[0].purchaseEligibility.reasonCode, 'free_plan_no_purchase');
  assert.equal(data.terms.revision, STARS_TERMS_REVISION); assert.equal(data.terms.accepted, false);
  assert.match(data.terms.text, /без автоматического продления/u); assert.match(data.terms.text, /Возврат не обещается автоматически/u);
  assert.equal(data.terms.telegramCommand, '/terms'); assert.equal(data.support.paymentCommand, '/paysupport');
  assert.equal(data.support.url, 'https://t.me/RE_Program_Support_Bot?start=paysupport');
  assert.ok(paid(data).every(offer => offer.checkout.available && offer.checkout.reasonCode === null &&
    offer.checkout.url === `https://t.me/RE_Program_Bot?start=subscribe_${offer.planCode}` && !offer.checkout.hintIsAuthority));
  assert.equal(data.offers[1].checkout.termsCallback, 'stars_buy:professional');
  assert.equal(data.nativeDependencies.referralShare.preparedMessageId, null);
  assert.equal(data.nativeDependencies.dragonEmoji.customEmojiId, null);
  assert.equal(f.sqlite.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.ok(f.binding.audit.every(event => !event.sql || /^SELECT/u.test(event.sql.trim())));
  assert.doesNotMatch(JSON.stringify(data), /fictional-v142-catalog-secret|BOT_TOKEN|sourceFingerprint|subscription_id/u);
});

test('closed payments retain known published prices but never offer checkout eligibility', async t => {
  const f = fixture(t, { STARS_PAYMENTS_ENABLED: 'false', STARS_ROLLOUT_MODE: 'all' });
  const data = await f.read();
  assert.equal(data.catalogReady, true); assert.equal(data.paymentsEnabled, false); assert.equal(data.paymentsReady, false);
  assert.deepEqual(paid(data).map(offer => offer.amountStars), [249, 499]);
  assert.ok(paid(data).every(offer => !offer.purchaseEligibility.eligible && offer.purchaseEligibility.reasonCode === 'stars_payments_disabled'));
  assert.ok(paid(data).every(offer => !offer.checkout.available && offer.checkout.url === null && offer.checkout.reasonCode === 'stars_payments_disabled'));
});

test('actor rollout is the actual shared Stars gate, including admin and allowlist scope', async t => {
  const f = fixture(t);
  assert.equal((await f.read(101)).rollout.eligible, true);
  const other = await f.read(202);
  assert.equal(other.rollout.eligible, false); assert.equal(other.rollout.reasonCode, 'not_allowlisted');
  assert.ok(paid(other).every(offer => !offer.purchaseEligibility.eligible));
  f.serverEnv.STARS_ROLLOUT_MODE = 'admin';
  assert.equal((await f.read(900)).rollout.reasonCode, 'admin_canary');
  assert.equal((await f.read(101)).rollout.reasonCode, 'admin_canary_only');
});

test('brand and own operation are required and client subject overrides create no reads', async t => {
  const f = fixture(t), authorization = await f.authorize(), profile = await f.authorize(101, 'profile.read_own');
  f.binding.audit.length = 0;
  await assert.rejects(readSubscriptionCatalog({ authorization: JSON.parse(JSON.stringify(authorization)) }), /untrusted_runtime_authorization/u);
  await assert.rejects(readSubscriptionCatalog({ authorization, telegramId: 202 }), /subscription_catalog_scope_invalid/u);
  await assert.rejects(readSubscriptionCatalog({ authorization: profile }), /subscription_catalog_scope_invalid/u);
  assert.equal(f.binding.audit.length, 0);
  f.sqlite.exec('UPDATE users SET is_blocked=1 WHERE telegram_id=101');
  await assert.rejects(readSubscriptionCatalog({ authorization: await f.authorize() }), /account_restricted/u);
});

test('actual price-book changes are reported rather than replaced by roadmap prices', async t => {
  const f = fixture(t, { STARS_PRICE_VERSION: '2' });
  insertPrice(f); insertPrice(f, { plan: 'dragon', amount: 599 });
  const data = await f.read();
  assert.equal(data.priceVersion, 2); assert.deepEqual(paid(data).map(offer => offer.amountStars), [299, 599]);
  assert.ok(paid(data).every(offer => offer.matchesInitialPrice === false && offer.priceVersion === 2));
  assert.match(data.terms.text, /299 ⭐.*599 ⭐/u);
});

test('draft and different-term prices remain unavailable without fallback amounts', async t => {
  for (const scenario of ['draft', 'different_terms']) await t.test(scenario, async t => {
    const f = fixture(t, { STARS_PRICE_VERSION: '2' });
    insertPrice(f, { publication: scenario === 'draft' ? 'draft' : 'approved', terms: scenario === 'different_terms' ? '2026-10-03.future-v2' : STARS_TERMS_REVISION });
    insertPrice(f, { plan: 'dragon', amount: 599 });
    const data = await f.read();
    const pro = data.offers.find(offer => offer.planCode === 'professional');
    assert.equal(pro.amountStars, null); assert.equal(pro.published, false); assert.equal(pro.purchaseEligibility.eligible, false);
    assert.equal(data.catalogReady, false); assert.equal(data.paymentsReady, false);
    assert.ok(data.problems.some(problem => problem.startsWith('professional:server_price_')));
  });
});

test('the existing schema rejects ambiguous prices without replacing the valid catalog', async t => {
  const f = fixture(t, { STARS_PRICE_VERSION: '2' });
  insertPrice(f); insertPrice(f, { plan: 'dragon', amount: 599 });
  assert.throws(() => insertPrice(f, { suffix: 'duplicate' }), /UNIQUE constraint failed/u);
  const data = await f.read();
  assert.equal(data.catalogReady, true); assert.deepEqual(paid(data).map(offer => offer.amountStars), [299, 599]);
});

test('unknown terms or recurring configuration do not advertise a working payment contract', async t => {
  for (const patch of [{ STARS_TERMS_REVISION: '2026-10-03.future-v2' }, { STARS_BILLING_MODE: 'recurring' }]) await t.test(JSON.stringify(patch), async t => {
    const f = fixture(t, patch), data = await f.read();
    assert.equal(data.paymentsReady, false); assert.ok(paid(data).every(offer => !offer.purchaseEligibility.eligible));
    if (patch.STARS_TERMS_REVISION) { assert.equal(data.terms.available, false); assert.equal(data.terms.text, null); }
    else { assert.equal(data.billing.releasedMode, false); }
  });
});

test('price-book insertion during the final read fence rejects a stale catalog', async t => {
  const f = fixture(t, { STARS_PRICE_VERSION: '2' }); insertPrice(f);
  const authorization = await f.authorize();
  f.binding.beforeBatch = () => insertPrice(f, { plan: 'dragon', amount: 599, suffix: 'race' });
  await assert.rejects(readSubscriptionCatalog({ authorization }), /subscription_catalog_stale/u);
});

test('real offline paid access permits same-plan manual renewal and blocks an unreleased plan transition', async t => {
  const f = fixture(t); await purchase(f);
  const data = await f.read();
  assert.equal(data.terms.accepted, true);
  const pro = data.offers.find(offer => offer.planCode === 'professional'), dragon = data.offers.find(offer => offer.planCode === 'dragon');
  assert.equal(pro.purchaseEligibility.eligible, true); assert.equal(pro.purchaseEligibility.mode, 'renewal');
  assert.equal(pro.purchaseEligibility.termsAcceptanceRequired, false);
  assert.equal(dragon.purchaseEligibility.eligible, false); assert.equal(dragon.purchaseEligibility.reasonCode, 'paid_plan_transition_not_released');
});
