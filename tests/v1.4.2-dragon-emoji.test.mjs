import test from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionFixture, subscriptionServerDTO } from './helpers/v1.4.2-subscription-fixtures.mjs';
import { createRuntimeAuthorizer, assertRuntimeAuthorizationFresh } from '../src/v1.4.1/runtime-authorizer.mjs';
import { readOwnDragonEmojiDescriptor } from '../src/v1.4.2/dragon-emoji.mjs';
import { REGISTERED_DRAGON_EMOJI } from '../src/v1.4.2/dragon-emoji-asset.mjs';
import { acceptStarsPurchaseTerms, issueStarsPurchase, handleStarsCommerceUpdate } from '../src/v1.3.6/stars-commerce-runtime.mjs';
import { applyStarsCompensation } from '../src/v1.3.6/stars-access-runtime.mjs';
import { authoritySeconds } from '../src/v1.4.1/authority-resolver.mjs';
import { readSubscriptionDTO } from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';
import { createTelegramNativeAdapter } from '../src/v1.4.0-rebuild/mini-app/telegram-native.mjs';

const authorizer = createRuntimeAuthorizer(), hasRegisteredAsset = REGISTERED_DRAGON_EMOJI !== null;
const missingAsset = 'A real getStickerSet + getCustomEmojiStickers receipt is still required';
const sqlTime = seconds => new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
let sequence = 1_429_000;
function fixture(t, envPatch = {}) {
  const f = subscriptionFixture(t, { envPatch: { STARS_ROLLOUT_ALLOWLIST: '101,900',
    STARS_REFUNDS_ENABLED: 'true', V142_DRAGON_EMOJI_ENABLED: 'true', ...envPatch } });
  f.sqlite.function('unixepoch', { deterministic: false, varargs: true }, (...args) =>
    args.length === 0 || args[0] === 'now' ? f.now : authoritySeconds(args[0]));
  f.authorization = async (id = 101, operation = 'access.read_own') => authorizer.authorize(await f.context(id, operation));
  return f;
}
async function pay(f, { id = 101, plan = 'dragon' } = {}) {
  const at = f.now - 5, env = { ...f.serverEnv, V141_AUTHORIZATION_ENABLED: 'false' };
  const calls = [], telegramApi = async (_env, method, payload) => {
    calls.push({ method, payload }); return method === 'sendInvoice' ? { message_id: ++sequence } : true;
  };
  await acceptStarsPurchaseTerms(env, { telegramId: id, telegramUpdateId: ++sequence, acceptedAt: at - 1 });
  const issued = await issueStarsPurchase(env, { telegramId: id, requestedPlanCode: plan,
    telegramUpdateId: ++sequence, orderId: crypto.randomUUID(), createdAt: at }, { telegramApi });
  const invoice = calls.find(call => call.method === 'sendInvoice').payload;
  const checkout = await handleStarsCommerceUpdate(env, { update_id: ++sequence, pre_checkout_query: {
    id: `offline-dragon-emoji-${sequence}`, from: { id, is_bot: false }, currency: 'XTR',
    total_amount: issued.amountStars, invoice_payload: invoice.payload } }, { nowSeconds: at + 1, telegramApi });
  assert.equal(checkout.approved, true);
  const chargeId = `offline-dragon-emoji-charge-${++sequence}`;
  const applied = await handleStarsCommerceUpdate(env, { update_id: ++sequence, message: {
    from: { id, is_bot: false }, chat: { id, type: 'private' }, successful_payment: {
      currency: 'XTR', total_amount: issued.amountStars, invoice_payload: invoice.payload,
      telegram_payment_charge_id: chargeId, provider_payment_charge_id: '' } } }, { nowSeconds: at + 2 });
  assert.equal(applied.accessApplied, true);
  return { chargeId, env };
}
function preview(f) {
  const start = f.now - 5, end = start + 604800, source = 'dragon_preview:v1.3.5-hotfix.1';
  f.sqlite.prepare("INSERT INTO user_plans(telegram_id,plan_code,source_code,effective_from) VALUES(101,'free',?,?)")
    .run(source, sqlTime(start));
  f.sqlite.prepare("INSERT INTO user_access_states(telegram_id,access_state,source_code,state_started_at,state_ends_at) VALUES(101,'trial',?,?,?)")
    .run(source, sqlTime(start), sqlTime(end));
  f.sqlite.prepare(`INSERT INTO trial_grants(grant_id,telegram_id,subject_fingerprint,program_code,source_code,
    status,started_at,ends_at,retention_until,workflow_instance_id,workflow_state,granted_at,updated_at)
    VALUES(?,101,?,'dragon_preview',?,'active',?,?,?,?,'started',?,?)`)
    .run(crypto.randomUUID(), 'd'.repeat(64), source, start, end, end + 86400, crypto.randomUUID(), start, start);
  f.sqlite.prepare("UPDATE user_access SET access_tier='trial',trial_used=1,trial_started_at=?,trial_ends_at=? WHERE telegram_id=101")
    .run(sqlTime(start), sqlTime(end));
}
const descriptor = dto => dto.catalog.nativeDependencies.dragonEmoji;
const assertUnavailable = value => {
  assert.equal(value.available, false); assert.equal(value.customEmojiId, null);
  assert.notEqual(value.reasonCode, 'eligible');
};

test('Dragon descriptor requires a genuine own-access authorization before inspecting asset configuration', async t => {
  const f = fixture(t), own = await f.authorization(), profile = await f.authorization(101, 'profile.read_own');
  assert.throws(() => readOwnDragonEmojiDescriptor(JSON.parse(JSON.stringify(own))), { code: 'untrusted_runtime_authorization' });
  assert.throws(() => readOwnDragonEmojiDescriptor(profile), { code: 'subscription_access_scope_mismatch' });
  assertUnavailable(readOwnDragonEmojiDescriptor(own));
});

test('asset and exact server flag fail closed; arbitrary environment IDs never configure Dragon', async t => {
  for (const flag of [undefined, false, true, 'false', 'TRUE', '1']) {
    const f = fixture(t, { V142_DRAGON_EMOJI_ENABLED: flag, DRAGON_CUSTOM_EMOJI_ID: '5412300012345000012',
      V142_DRAGON_CUSTOM_EMOJI_ID: '5412300012345000012', V142_DRAGON_EMOJI_SET: 'OtherSet' });
    await pay(f);
    const result = readOwnDragonEmojiDescriptor(await f.authorization());
    assertUnavailable(result);
    assert.equal(result.reasonCode, hasRegisteredAsset ? 'dragon_emoji_disabled' : 'dragon_custom_emoji_not_configured');
  }
  if (!hasRegisteredAsset) {
    const f = fixture(t); await pay(f);
    assert.equal(readOwnDragonEmojiDescriptor(await f.authorization()).reasonCode, 'dragon_custom_emoji_not_configured');
  }
});

test('Free, Professional, Preview, owner-only and unresolved sources never expose a Dragon ID', async t => {
  for (const scenario of ['free', 'professional', 'preview', 'owner', 'review_required']) await t.test(scenario, async t => {
    const f = fixture(t); let id = 101;
    if (scenario === 'professional') await pay(f, { plan: 'professional' });
    if (scenario === 'preview') preview(f);
    if (scenario === 'owner') id = 900;
    if (scenario === 'review_required') f.sqlite.exec("UPDATE user_access SET access_tier='team' WHERE telegram_id=101");
    const dto = await subscriptionServerDTO(f, id);
    assert.equal(dto.access.current.activeDragon, false);
    if (scenario === 'owner') assert.equal(dto.access.ownerException.applies, true);
    if (scenario === 'preview') assert.equal(dto.access.current.previewActive, true);
    if (scenario === 'review_required') assert.equal(dto.access.current.status, 'review_required');
    assertUnavailable(descriptor(dto));
    if (hasRegisteredAsset) assert.equal(descriptor(dto).reasonCode, 'active_dragon_required');
    readSubscriptionDTO(dto, { nowSeconds: f.now });
  });
});

test('expiry, suspended access and completed refund never expose the registered ID', async t => {
  for (const scenario of ['expired', 'suspended', 'refunded']) await t.test(scenario, async t => {
    const f = fixture(t), purchase = await pay(f);
    if (scenario === 'expired') f.now += 2592001;
    if (scenario === 'suspended') f.sqlite.exec("UPDATE subscriptions SET status='suspended',revision=revision+1;UPDATE user_access_states SET access_state='suspended',revision=revision+1 WHERE telegram_id=101");
    if (scenario === 'refunded') await applyStarsCompensation(purchase.env, {
      telegramPaymentChargeId: purchase.chargeId, compensationType: 'refund',
      telegramUpdateId: ++sequence, occurredAt: f.now });
    const dto = await subscriptionServerDTO(f);
    assert.equal(dto.access.current.activeDragon, false);
    assertUnavailable(descriptor(dto));
    if (hasRegisteredAsset) assert.equal(descriptor(dto).reasonCode, 'active_dragon_required');
  });
});

test('configured own GET performs only SELECTs and never calls Telegram or writes a status', async t => {
  const f = fixture(t); await pay(f);
  const originalFetch = globalThis.fetch; let fetches = 0;
  globalThis.fetch = () => { fetches++; throw new Error('GET must not call an external provider'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  f.binding.audit.length = 0;
  const changes = f.sqlite.prepare('SELECT total_changes() AS n').get().n;
  const dto = await subscriptionServerDTO(f);
  assert.equal(fetches, 0);
  assert.equal(f.sqlite.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.ok(f.binding.audit.every(row => row.mode === 'read' && /^SELECT\b/u.test(row.sql.trim())));
  assert.equal(descriptor(dto).available, hasRegisteredAsset);
  assert.equal(descriptor(dto).customEmojiId, REGISTERED_DRAGON_EMOJI?.customEmojiId ?? null);
  readSubscriptionDTO(dto, { nowSeconds: f.now });
});

test('client accepts a synthetic native descriptor only with genuine finite paid Dragon; malformed IDs and false-state IDs fail', async t => {
  const f = fixture(t); await pay(f);
  const paid = structuredClone(await subscriptionServerDTO(f));
  // Explicit transport-schema fixture only; this synthetic ID is never a
  // registered receipt, server configuration or real Telegram installation.
  paid.catalog.nativeDependencies.dragonEmoji = { available: true, reasonCode: 'eligible', customEmojiId: '5412300012345000012' };
  assert.equal(readSubscriptionDTO(paid, { nowSeconds: f.now }).catalog.nativeDependencies.dragonEmoji.available, true);
  for (const id of [null, 5412300012345000012, '', '0', '01', '-1', '🐉', '1\n', '9'.repeat(21)]) {
    const invalid = structuredClone(paid); descriptor(invalid).customEmojiId = id;
    assert.throws(() => readSubscriptionDTO(invalid, { nowSeconds: f.now }), { code: 'invalid_response' });
  }
  for (const edit of [
    dto => { descriptor(dto).available = false; },
    dto => { descriptor(dto).reasonCode = 'dragon_emoji_disabled'; },
    dto => { dto.access.current.activeDragon = false; },
    dto => { dto.access.current.previewActive = true; },
    dto => { dto.access.current.accessOverlay = 'dragon_preview'; },
  ]) { const invalid = structuredClone(paid); edit(invalid);
    assert.throws(() => readSubscriptionDTO(invalid, { nowSeconds: f.now }), { code: 'invalid_response' }); }
  const free = structuredClone(await subscriptionServerDTO(fixture(t)));
  free.catalog.nativeDependencies.dragonEmoji = { ...descriptor(paid) };
  assert.throws(() => readSubscriptionDTO(free, { nowSeconds: f.now }), { code: 'invalid_response' });
  assert.throws(() => readSubscriptionDTO(paid, { nowSeconds: paid.access.current.expiresAt }), { code: 'invalid_response' });
});

test('verified compiled asset reaches genuine paid customer and owner; cancellation keeps its real deadline', {
  skip: hasRegisteredAsset ? false : missingAsset,
}, async t => {
  assert.ok(Object.isFrozen(REGISTERED_DRAGON_EMOJI));
  for (const id of [101, 900]) await t.test(String(id), async t => {
    const f = fixture(t); await pay(f, { id });
    let dto = await subscriptionServerDTO(f, id);
    assert.equal(descriptor(dto).available, true); assert.equal(descriptor(dto).reasonCode, 'eligible');
    assert.equal(descriptor(dto).customEmojiId, REGISTERED_DRAGON_EMOJI.customEmojiId);
    assert.equal(dto.access.ownerException.applies, id === 900);
    readSubscriptionDTO(dto, { nowSeconds: f.now });
    const deadline = dto.access.current.expiresAt;
    f.sqlite.exec(`UPDATE subscriptions SET status='cancel_at_period_end',revision=revision+1 WHERE telegram_id=${id};
      UPDATE user_access_states SET access_state='cancel_at_period_end',revision=revision+1 WHERE telegram_id=${id}`);
    dto = await subscriptionServerDTO(f, id);
    assert.equal(dto.access.current.accessState, 'cancel_at_period_end');
    assert.equal(dto.access.current.expiresAt, deadline); assert.equal(descriptor(dto).available, true);
    readSubscriptionDTO(dto, { nowSeconds: f.now });
  });
});

test('verified asset projection retains the final canonical fence when a refund races an own read', {
  skip: hasRegisteredAsset ? false : missingAsset,
}, async t => {
  const f = fixture(t), purchase = await pay(f), authorization = await f.authorization();
  assert.equal(readOwnDragonEmojiDescriptor(authorization).available, true);
  await applyStarsCompensation(purchase.env, { telegramPaymentChargeId: purchase.chargeId,
    compensationType: 'refund', telegramUpdateId: ++sequence, occurredAt: f.now });
  await assert.rejects(assertRuntimeAuthorizationFresh(authorization), { code: 'authority_stale' });
  assertUnavailable(readOwnDragonEmojiDescriptor(await f.authorization()));
});

test('verified ID from the actual server DTO invokes only manual setEmojiStatus with bounded duration', {
  skip: hasRegisteredAsset ? false : missingAsset,
}, async t => {
  const f = fixture(t); await pay(f);
  const dto = readSubscriptionDTO(await subscriptionServerDTO(f), { nowSeconds: f.now });
  const calls = [], events = new Map(); let callback;
  const telegram = { version: '8.0', onEvent(name, handler) { events.set(name, handler); }, offEvent(name) { events.delete(name); },
    setEmojiStatus(id, params, done) { calls.push({ id, params }); callback = done; } };
  const adapter = createTelegramNativeAdapter({ telegram, nowSeconds: () => f.now });
  t.after(() => adapter.destroy());
  const pending = adapter.setDragonEmoji({ authority: 'worker', ...dto.access.current,
    customEmojiId: descriptor(dto).customEmojiId });
  assert.deepEqual(calls, [{ id: REGISTERED_DRAGON_EMOJI.customEmojiId,
    params: { duration: Math.min(dto.access.current.remainingSeconds, dto.access.current.expiresAt - f.now) } }]);
  assert.equal(telegram.requestEmojiStatusAccess, undefined);
  callback(true); assert.equal((await pending).status, 'confirmed');
});
