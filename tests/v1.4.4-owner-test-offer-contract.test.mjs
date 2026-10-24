import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHmac } from 'node:crypto';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { createCustomerContext } from '../src/v1.4.1/trusted-context.mjs';
import { createAuthorityResolver, readActorFacts } from '../src/v1.4.1/authority-resolver.mjs';
import { buildStarsInvoicePayload } from '../src/v1.3.6/stars-core-foundation.mjs';
import { PACKAGE_OWNER_TEST_OFFER as PIN, PACKAGE_CANONICAL_PRICES, PACKAGE_CONTRACT_VERSION,
  PACKAGE_OFFER_VERSION, resolveOwnPackagePeriodAuthority, createServerPackageQuote,
  createServerMonthlyTransitionQuote, normalizeServerPackagePrice, normalizeStoredServerPackagePrice,
  compilePackagePeriodAssertions } from '../src/v1.4.4/package-contract.mjs';

function signed(id, now, token) {
  const data = { auth_date: String(now), query_id: 'offline_owner_price', user: JSON.stringify({ id, first_name: 'Offline' }) };
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const check = Object.entries(data).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + '=' + value).join('\n');
  return new URLSearchParams({ ...data, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
}
async function fixture(t, { now = PIN.validFrom + 60, botId = PIN.botId, id = PIN.telegramId, patch = {}, canonical = true } = {}) {
  const f = foundationFixture(t); f.now = now;
  for (const name of ['0026-v1.3.6-stars-core-foundation.sql','0027-v1.3.6-stars-access-and-reconciliation.sql',
    '0066-v1.4.3-subscription-lifecycle-foundation.sql','0067-v1.4.3-lifecycle-engine-binding.sql',
    '0068-v1.4.3-provider-and-review-binding.sql','0072-v1.4.4-package-contract.sql',
    '0073-v1.4.4-package-payment-review.sql'])
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  f.sqlite.prepare('INSERT INTO users(telegram_id,referral_code,accepted_terms) VALUES(?,?,1)').run(PIN.telegramId, 'offline_owner_250');
  f.sqlite.prepare("INSERT INTO user_roles(telegram_id,role,status) VALUES(?,'admin','active')").run(PIN.telegramId);
  f.env = { ...f.serverEnv, ADMIN_ID: String(PIN.telegramId), OWNER_TELEGRAM_ID: String(PIN.telegramId),
    BOT_TOKEN: botId + ':synthetic-offline-price-test-token', REBUILD_V140_BOT_ID: String(botId),
    STARS_PACKAGES_ENABLED: 'true', STARS_PACKAGE_3M_ENABLED: 'true', STARS_PACKAGE_PRICE_VERSION: '2',
    STARS_PACKAGE_TERMS_REVISION: PIN.termsRevision, STARS_INVOICE_SECRET: 'offline-owner-price-invoice-secret-at-least-32-characters',
    STARS_PAYMENTS_ENABLED: 'true', STARS_BILLING_MODE: 'prepaid', STARS_PRICE_VERSION: '1', STARS_TERMS_REVISION: PIN.termsRevision, STARS_ROLLOUT_MODE: 'all',
    STARS_RECURRING_ENABLED: 'true', STARS_RECURRING_PRICE_VERSION: '1', ...patch };
  const insert = row => {
    const keys = Object.keys(row); f.sqlite.prepare(`INSERT INTO price_book(${keys.join(',')}) VALUES(${keys.map(() => '?')})`).run(...keys.map(key => row[key]));
  };
  f.price = { price_id: PIN.priceId, price_version: PIN.priceVersion, plan_code: PIN.planCode, currency: PIN.currency,
    amount_stars: PIN.amountStars, access_seconds: PIN.periodSeconds, billing_mode: PIN.billingMode, publication_state: 'approved',
    terms_revision: PIN.termsRevision, valid_from: PIN.validFrom, valid_until: PIN.validUntil, created_at: PIN.validFrom };
  insert(f.price);
  for (const [plan, amount] of canonical ? [['professional', 699], ['dragon', 1399]] : []) insert({ ...f.price,
    price_id: plan + '-90d-prepaid-v2', price_version: 2, plan_code: plan, amount_stars: amount, valid_from: 1791392780, valid_until: null });
  if (!f.sqlite.prepare("SELECT price_id FROM price_book WHERE plan_code='professional' AND billing_mode='recurring' AND access_seconds=2592000 AND price_version=1").get())
    insert({ ...f.price, price_id: 'professional-30d-recurring-v1', price_version: 1, amount_stars: 249,
      access_seconds: 2592000, billing_mode: 'recurring', terms_revision: '2026-10-03.stars-recurring-v1', valid_from: 1791392780, valid_until: null });
  f.scope = async () => {
    const context = await createCustomerContext({ binding: f.binding, env: f.env, initData: signed(id, f.now, f.env.BOT_TOKEN),
      channel: 'mini_app', operation: 'access.read_own', nowSeconds: f.now });
    const actor = await createAuthorityResolver().resolveActor(context);
    return { actor, verifiedPackagePeriods: await resolveOwnPackagePeriodAuthority({ actor, nowSec: f.now }), nowSec: f.now };
  };
  f.quote = (scope, extra = {}) => createServerPackageQuote({ ...scope, request: { requestedPlanCode: 'professional', packageCode: '3m' }, ...extra });
  f.retain = async ({ created = PIN.validFrom + 60 } = {}) => {
    const orderId = crypto.randomUUID(), payload = await buildStarsInvoicePayload({ invoiceSecret: f.env.STARS_INVOICE_SECRET,
      orderId, telegramId: PIN.telegramId, priceId: PIN.priceId });
    f.sqlite.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,currency,amount_stars,
      access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,expires_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'created',?,?,?)`).run(orderId, PIN.telegramId, PIN.priceId, PIN.priceVersion, PIN.planCode, PIN.currency,
        PIN.amountStars, PIN.periodSeconds, PIN.billingMode, PIN.termsRevision, payload, created, created + 900, created);
    const metadata = { order_id: orderId, telegram_id: PIN.telegramId, contract_version: PACKAGE_CONTRACT_VERSION,
      package_code: PIN.packageCode, duration_days: PIN.durationDays, period_seconds: PIN.periodSeconds, price_id: PIN.priceId,
      price_version: PIN.priceVersion, plan_code: PIN.planCode, billing_mode: PIN.billingMode, currency: PIN.currency,
      amount_stars: PIN.amountStars, offer_version: PIN.offerVersion, campaign_code: PIN.campaignCode,
      quoted_starts_at: created, quoted_ends_at: created + PIN.periodSeconds, source_fingerprint: 'a'.repeat(64), created_at: created };
    const keys = Object.keys(metadata); f.sqlite.prepare(`INSERT INTO subscription_package_orders(${keys.join(',')}) VALUES(${keys.map(() => '?')})`)
      .run(...keys.map(key => metadata[key]));
    return { order: f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(orderId),
      metadata: f.sqlite.prepare('SELECT * FROM subscription_package_orders WHERE order_id=?').get(orderId) };
  };
  return f;
}

test('closed owner campaign selects canonical699v2 even inside the historical250 window', async t => {
  const f = await fixture(t), scope = await f.scope(), quote = f.quote(scope);
  assert.equal(readActorFacts(scope.actor).canonicalOwner, true); assert.equal(Object.isFrozen(PIN), true);
  assert.equal(Date.parse('2026-10-08T17:00:00Z') / 1000, PIN.validFrom);
  assert.equal(Date.parse('2026-10-09T20:59:59Z') / 1000, PIN.validUntil);
  assert.equal(quote.priceId, 'professional-90d-prepaid-v2'); assert.equal(quote.priceVersion, 2);
  assert.equal(quote.amountStars, 699); assert.equal(quote.durationDays, 90); assert.equal(quote.periodSeconds, PIN.periodSeconds);
  assert.equal(quote.offerVersion, PACKAGE_OFFER_VERSION); assert.equal(quote.campaignCode, null);
  assert.equal(PACKAGE_CANONICAL_PRICES.professional['3m'], 699);
  assert.equal(f.sqlite.prepare("SELECT amount_stars FROM price_book WHERE price_id='professional-90d-prepaid-v2'").get().amount_stars, 699);
  assert.throws(() => normalizeServerPackagePrice(f.price), { code: 'package_price_amount_invalid' });
  f.now = PIN.validUntil - 1; assert.ok(f.quote(await f.scope()).validUntil > PIN.validUntil);
});

test('first retained test order makes new quotes699 and atomically invalidates empty capture; actual retained proof preserves250', async t => {
  const f = await fixture(t), prior = await f.scope();
  const captured = compilePackagePeriodAssertions(prior.verifiedPackagePeriods).assertions.find(row => row.sql.includes('subscription_package_orders m LEFT JOIN'));
  assert.ok(captured); assert.equal(captured.params.at(-1), '[]');
  assert.equal(f.sqlite.prepare('SELECT ' + captured.sql + ' AS allowed').get(...captured.params).allowed, 1);
  const retained = await f.retain();
  assert.equal(f.sqlite.prepare('SELECT ' + captured.sql + ' AS allowed').get(...captured.params).allowed, 0);
  const fresh = await f.scope(); assert.equal(f.quote(fresh).amountStars, 699);
  const original = f.quote(fresh, { retainedOrderId: retained.order.order_id });
  assert.equal(original.amountStars, 250); assert.equal(original.priceId, PIN.priceId);
  assert.throws(() => f.quote(fresh, { retainedOrderId: crypto.randomUUID() }), { code: 'package_owner_test_order_invalid' });
  assert.throws(() => f.quote({ ...fresh, verifiedPackagePeriods: { ...fresh.verifiedPackagePeriods } }, { retainedOrderId: retained.order.order_id }), { code: 'untrusted_package_periods' });
});

test('expired owner test window offers new699 but preserves signed original250 snapshot through branded captured order', async t => {
  const f = await fixture(t, { now: PIN.validUntil + 1 });
  assert.equal(f.quote(await f.scope()).amountStars, 699);
  const retained = await f.retain(), scope = await f.scope();
  assert.equal(f.quote(scope).amountStars, 699);
  const quote = f.quote(scope, { retainedOrderId: retained.order.order_id });
  assert.equal(quote.amountStars, 250); assert.equal(quote.offerVersion, PIN.offerVersion); assert.ok(quote.validUntil > f.now);
  assert.equal(normalizeStoredServerPackagePrice(f.price, { ...retained, botId: PIN.botId }).amountStars, 250);
});

test('foreign customer, wrong bot and copied actor cannot obtain owner test quote authority', async t => {
  const foreign = await fixture(t, { id: 101 }); await assert.rejects(foreign.scope(), { code: 'package_owner_authority_required' });
  const otherBot = await fixture(t, { botId: PIN.botId + 1 }), scope = await otherBot.scope();
  assert.equal(otherBot.quote(scope).amountStars, 699);
  const genuine = await fixture(t), actual = await genuine.scope();
  assert.throws(() => genuine.quote({ ...actual, actor: { ...actual.actor } }), { code: 'untrusted_actor' });
});

test('pure historical validator rejects owner/bot/amount/campaign/window spoofs without conferring quote authority', async t => {
  const f = await fixture(t), retained = await f.retain();
  for (const change of [value => value.order.telegram_id++, value => value.metadata.telegram_id++, value => value.botId++,
    value => value.metadata.amount_stars = 699, value => value.metadata.campaign_code = null,
    value => value.order.created_at = value.metadata.created_at = PIN.validUntil]) {
    const value = structuredClone({ ...retained, botId: PIN.botId }); change(value);
    assert.throws(() => normalizeStoredServerPackagePrice(f.price, value), { code: 'package_owner_test_order_invalid' });
  }
  assert.throws(() => normalizeStoredServerPackagePrice(f.price, { botId: PIN.botId }), { code: 'package_owner_test_order_invalid' });
});

test('canonical Dragon and monthly quotes keep their prices/version/offer and disabled3m stays closed', async t => {
  const f = await fixture(t), scope = await f.scope();
  const dragon = createServerPackageQuote({ ...scope, request: { requestedPlanCode: 'dragon', packageCode: '3m' } });
  assert.equal(dragon.amountStars, 1399); assert.equal(dragon.priceVersion, 2); assert.equal(dragon.offerVersion, PACKAGE_OFFER_VERSION); assert.equal(dragon.campaignCode, null);
  const monthly = createServerMonthlyTransitionQuote({ ...scope, request: { requestedPlanCode: 'professional' } });
  assert.equal(monthly.amountStars, 249); assert.equal(monthly.priceVersion, 1); assert.equal(monthly.billingMode, 'recurring');
  const closed = await fixture(t, { patch: { STARS_PACKAGE_3M_ENABLED: 'false' } });
  await assert.rejects(closed.scope().then(scope => closed.quote(scope)), { code: 'package_disabled' });
});

test('missing approved canonical699v2 never falls back to the retained250 catalog row', async t => {
  const f = await fixture(t, { canonical: false }), scope = await f.scope();
  assert.throws(() => f.quote(scope), { code: 'package_price_unavailable' });
  const retained = await f.retain(), fresh = await f.scope();
  assert.throws(() => f.quote(fresh), { code: 'package_price_unavailable' });
  assert.equal(f.quote(fresh, { retainedOrderId: retained.order.order_id }).amountStars, 250);
});
