import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { subscriptionFixture, MONTH } from './helpers/v1.4.3-provider-subscription-fixture.mjs';
import { buildStarsInvoicePayload } from '../src/v1.3.6/stars-core-foundation.mjs';
import { acceptStarsPurchaseTerms, recordStarsSuccessfulPayment } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsPaidAccess } from '../src/v1.3.6/stars-access-runtime.mjs';
import { handleVerifiedTelegramSubscriptionUpdate } from '../src/v1.4.3/provider-subscription-events.mjs';
import { createCustomerContext } from '../src/v1.4.1/trusted-context.mjs';
import { createRuntimeAuthorizer, assertRuntimeAuthorizationFresh } from '../src/v1.4.1/runtime-authorizer.mjs';
import { authorizeTelegramHandler } from '../src/v1.4.1/telegram-runtime.mjs';
import { resolveTelegramHandler } from '../src/v1.4.1/handler-registry.mjs';
import { SUBSCRIPTION_BOT_CALLBACKS } from '../src/v1.4.3/subscription-bot.mjs';
import { projectSubscriptionAccess } from '../src/v1.4.2/subscription-access.mjs';
import { readOwnDragonEmojiDescriptor } from '../src/v1.4.2/dragon-emoji.mjs';
import { REGISTERED_DRAGON_EMOJI } from '../src/v1.4.2/dragon-emoji-asset.mjs';
const runtimeRequire = createRequire(new URL('./p11-runtime/package.json', import.meta.url));
const { chromium } = runtimeRequire('playwright');
const esbuild = createRequire(new URL('./p11-runtime/package.json', import.meta.url))('esbuild');
let browser, bundle;
test.before(async () => {
  const built = await esbuild.build({ stdin: { contents: `
    import {renderTelegramActions} from './src/v1.4.0-rebuild/mini-app/telegram-actions-view.mjs';
    import {createTelegramNativeAdapter} from './src/v1.4.0-rebuild/mini-app/telegram-native.mjs';
    window.nativeModules={renderTelegramActions,createTelegramNativeAdapter};
  `, resolveDir: process.cwd(), sourcefile: 'offline-native-paid-residue.mjs' }, bundle: true, write: false,
    format: 'iife', platform: 'browser', target: 'es2022' });
  bundle = built.outputFiles[0].text;
  browser = await chromium.launch({ headless: true,
    ...(process.env.P11_BROWSER_PATH ? { executablePath: process.env.P11_BROWSER_PATH } : {}), args: ['--disable-background-networking'] });
});
test.after(async () => { await browser?.close(); });
async function page(t) {
  const context = await browser.newContext({ serviceWorkers: 'block' }); t.after(() => context.close());
  await context.route('**/*', route => route.abort('blockedbyclient'));
  await context.routeWebSocket('**/*', socket => socket.close());
  const p = await context.newPage();
  await p.setContent('<!doctype html><html><body></body></html>');
  await p.addScriptTag({ content: bundle }); return p;
}
const hash = value => createHash('sha256').update(value).digest('hex');
let sequence = 1434900;

async function genuineFailedDragon(t) {
  const f = await subscriptionFixture(t, { paid: false }), subject = 202, created = f.now - 100;
  f.serverEnv.V142_DRAGON_EMOJI_ENABLED = 'true';
  const priceId = 'dragon-30d-recurring-v1', orderId = crypto.randomUUID(), contractId = crypto.randomUUID();
  await acceptStarsPurchaseTerms(f.serverEnv, { telegramId: subject, telegramUpdateId: ++sequence, acceptedAt: created - 1 });
  f.sqlite.prepare(`INSERT INTO price_book(price_id,price_version,plan_code,currency,amount_stars,access_seconds,
    billing_mode,terms_revision,valid_from,created_at) VALUES(?,1,'dragon','XTR',349,?,'recurring',?,?,?)`)
    .run(priceId, MONTH, f.serverEnv.STARS_TERMS_REVISION, created - 100, created - 100);
  const payload = await buildStarsInvoicePayload({ invoiceSecret: f.serverEnv.STARS_INVOICE_SECRET,
    orderId, telegramId: subject, priceId });
  f.sqlite.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,currency,
    amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,expires_at,
    precheckout_approved_at,updated_at) VALUES(?,202,?,1,'dragon','XTR',349,?,'recurring',?,?,'precheckout_ok',?,?,?,?)`)
    .run(orderId, priceId, MONTH, f.serverEnv.STARS_TERMS_REVISION, payload, created, f.now + 600, created + 1, created + 1);
  const acceptance = f.sqlite.prepare('SELECT acceptance_id FROM terms_acceptances WHERE telegram_id=202').get();
  f.sqlite.prepare(`INSERT INTO subscription_billing_contracts(contract_id,telegram_id,plan_code,price_id,
    origin_order_id,external_invoice_payload,external_payload_sha256,terms_revision,terms_acceptance_id,
    billing_mode,period_seconds,currency,amount_stars,created_at,updated_at)
    VALUES(?,202,'dragon',?,?,?,?,?,?,'recurring',?,'XTR',349,?,?)`)
    .run(contractId, priceId, orderId, payload, hash(payload), f.serverEnv.STARS_TERMS_REVISION,
      acceptance.acceptance_id, MONTH, created, created);
  f.paidUntil = f.now + 500;
  const paid = await recordStarsSuccessfulPayment(f.serverEnv, { update_id: ++sequence, message: {
    from: { id: subject, is_bot: false }, chat: { id: subject, type: 'private' }, successful_payment: {
      currency: 'XTR', total_amount: 349, invoice_payload: payload, telegram_payment_charge_id: 'offline-paid-residue-' + sequence,
      provider_payment_charge_id: '', is_recurring: true, is_first_recurring: true, subscription_expiration_date: f.paidUntil } } },
  { receivedAt: f.now - 10 });
  assert.equal((await applyStarsPaidAccess(f.serverEnv, { orderId: paid.orderId, appliedAt: f.now - 10 })).accessApplied, true);
  const update = f.update('failed', ++sequence, subject, payload), claim = f.claim(update);
  await handleVerifiedTelegramSubscriptionUpdate({ webhookRequest: f.request(update), serviceContext: f.serviceContext(), receiptClaimToken: claim });
  f.read = async () => {
    const authorization = await createRuntimeAuthorizer().authorize(await f.context(subject, 'access.read_own'));
    const access = projectSubscriptionAccess(authorization), emoji = readOwnDragonEmojiDescriptor(authorization);
    await assertRuntimeAuthorizationFresh(authorization);
    return { readModelVersion: 1, authority: 'worker', access, catalog: { nativeDependencies: {
      referralShare: { available: false, reasonCode: 'referral_partner_required' }, dragonEmoji: emoji } } };
  };
  return f;
}

test('finite bot callback registry selects only existing read capabilities and genuine claimed Telegram authorization', async t => {
  const f = await subscriptionFixture(t, { paid: false });
  for (const selector of SUBSCRIPTION_BOT_CALLBACKS) {
    const update = { update_id: ++sequence, callback_query: { id: 'offline-registry-' + sequence, data: selector,
      from: { id: 101, is_bot: false }, message: { message_id: sequence, date: f.now,
        from: { id: 123456789, is_bot: true }, chat: { id: 101, type: 'private' } } } };
    const expected = /^sub143:(?:history|receipt:)/u.test(selector) ? 'billing.read_history_own' : 'access.read_own';
    const selected = resolveTelegramHandler(update);
    assert.equal(selected.capability, expected); assert.equal(selected.effect, 'read'); assert.equal(selected.resourceRef, null);
    const token = crypto.randomUUID();
    f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,
      received_at,lease_expires_at) VALUES(?,'callback_query',101,'processing',?,?,?)`).run(update.update_id, token, f.now, f.now + 60);
    const context = await createCustomerContext({ binding: f.binding, env: f.serverEnv, webhookRequest: f.request(update),
      receiptClaimToken: token, nowSeconds: f.now, channel: 'telegram_callback', operation: 'account.register' });
    const genuine = await authorizeTelegramHandler(context, update);
    assert.equal(genuine.handler.capability, expected); await assertRuntimeAuthorizationFresh(genuine.authorization);
  }
  for (const selector of ['sub143:receipt:5', 'sub143:cancel:202', 'sub143:status:anything', 'sub143:packages:202', 'sub143:confirm', 'sub143:history\n'])
    assert.equal(resolveTelegramHandler({ callback_query: { data: selector } }), null);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM payment_ledger').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM subscription_provider_commands').get().n, 0);
});

test('real failed Dragon renewal retains native descriptor, visible action and SDK duration only for genuine future paid remainder', async t => {
  const f = await genuineFailedDragon(t), data = await f.read();
  assert.equal(data.access.lifecycle.state, 'payment_failed'); assert.equal(data.access.current.activeDragon, true);
  assert.equal(data.access.current.durationKind, 'finite'); assert.equal(data.access.current.expiresAt, f.paidUntil);
  assert.equal(data.catalog.nativeDependencies.dragonEmoji.available, true);
  const p = await page(t);
  await p.evaluate(({ data, now }) => {
    window.nativeNow = now; window.nativeCalls = [];
    const telegram = { version: '8.0', setEmojiStatus(id, params, callback) { window.nativeCalls.push({ id, params }); callback(true); } };
    const native = window.nativeModules.createTelegramNativeAdapter({ telegram, nowSeconds: () => window.nativeNow });
    const view = window.nativeModules.renderTelegramActions({ document, data, native,
      onReadNative: async () => data, nowSeconds: () => window.nativeNow });
    window.native = native; document.body.append(view.element);
  }, { data, now: f.now });
  assert.equal(await p.locator('[data-telegram-action="emoji"]').isDisabled(), false);
  await p.locator('[data-telegram-action="emoji"]').click();
  await p.waitForFunction(() => window.nativeCalls.length === 1);
  const calls = await p.evaluate(() => window.nativeCalls);
  assert.deepEqual(calls, [{ id: REGISTERED_DRAGON_EMOJI.customEmojiId, params: { duration: 500 } }]);
  assert.match(await p.locator('body').innerText(), /после вашего подтверждения/u);
  f.now = f.paidUntil;
  assert.equal((await f.read()).catalog.nativeDependencies.dragonEmoji.available, false);
  const expired = await p.evaluate(async ({ now, current, customEmojiId }) => {
    window.nativeNow = now;
    return { result: await window.native.setDragonEmoji({ authority: 'worker', ...current, customEmojiId }), calls: window.nativeCalls.length };
  }, { now: f.now, current: data.access.current, customEmojiId: REGISTERED_DRAGON_EMOJI.customEmojiId });
  assert.equal(expired.result.status, 'unavailable'); assert.equal(expired.calls, 1);
});

test('payment_failed status alone, Preview, absent proof and expired paid time cannot open a native Dragon dialog', async t => {
  const p = await page(t);
  const checked = await p.evaluate(async customEmojiId => {
    const now = 1791000000, calls = [], statuses = [], disabled = [];
    const telegram = { version: '8.0', setEmojiStatus(_id, _params, callback) { calls.push('unexpected'); callback(true); } };
    const native = window.nativeModules.createTelegramNativeAdapter({ telegram, nowSeconds: () => now });
    const valid = { authority: 'worker', activeDragon: true, planCode: 'dragon', accessState: 'payment_failed',
      previewActive: false, expiresAt: now + 500, remainingSeconds: 500, customEmojiId };
    for (const patch of [{ activeDragon: false }, { previewActive: true }, { planCode: 'free' },
      { expiresAt: now }, { expiresAt: null }, { remainingSeconds: 0 }, { remainingSeconds: null }])
      statuses.push((await native.setDragonEmoji({ ...valid, ...patch })).status);
    for (const patch of [{ activeDragon: false }, { previewActive: true }, { expiresAt: now }, { remainingSeconds: 0 }]) {
      const current = { ...valid, status: 'verified', sourceKind: 'stars', ...patch };
      const data = { readModelVersion: 1, authority: 'worker', access: { sessionExpiresAt: now + 300, current },
        catalog: { nativeDependencies: { dragonEmoji: { available: true, customEmojiId } } } };
      const view = window.nativeModules.renderTelegramActions({ document, data, native, onReadNative: async () => data, nowSeconds: () => now });
      disabled.push(view.element.querySelector('[data-telegram-action="emoji"]').disabled); view.destroy();
    }
    native.destroy(); return { calls, statuses, disabled };
  }, REGISTERED_DRAGON_EMOJI.customEmojiId);
  assert.deepEqual(checked.calls, []); assert.ok(checked.statuses.every(value => value === 'unavailable'));
  assert.ok(checked.disabled.every(value => value === true));
});
