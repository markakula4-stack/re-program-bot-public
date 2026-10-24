import test from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionFixture as fixture, subscriptionServerDTO as serverDTO } from './helpers/v1.4.2-subscription-fixtures.mjs';
import { acceptStarsPurchaseTerms, issueStarsPurchase, handleStarsCommerceUpdate } from '../src/v1.3.6/stars-commerce-runtime.mjs';
import { MiniAppClient, CabinetNavigator, buildReadPath, readSubscriptionDTO } from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';

const ORIGIN = 'https://cabinet.example', TOKEN = 'rpms1_' + 'a'.repeat(43);
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let sequence = 1_420_200;
function browser(f, handler, { negotiation = 1, onExpired = () => {} } = {}) {
  const calls = [], clock = { value: f.now * 1000 };
  const client = new MiniAppClient({ origin: ORIGIN, now: () => clock.value, onExpired,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return url.endsWith('/session') ? response({ sessionToken: TOKEN, tokenType: 'Bearer', expiresAt: f.now + 300,
        ...(negotiation ? { authorizationVersion: negotiation } : {}) }) : handler(url, init);
    } });
  return { client, calls, clock };
}
async function paid(f) {
  const at = f.now - 5, calls = [];
  const telegramApi = async (_env, method, payload) => { calls.push({ method, payload }); return method === 'sendInvoice' ? { message_id: ++sequence } : true; };
  await acceptStarsPurchaseTerms(f.serverEnv, { telegramId: 101, telegramUpdateId: ++sequence, acceptedAt: at - 1 });
  const issued = await issueStarsPurchase(f.serverEnv, { telegramId: 101, requestedPlanCode: 'dragon',
    telegramUpdateId: ++sequence, orderId: crypto.randomUUID(), createdAt: at }, { telegramApi });
  const invoice = calls.find(call => call.method === 'sendInvoice').payload;
  const precheckout = await handleStarsCommerceUpdate(f.serverEnv, { update_id: ++sequence, pre_checkout_query: {
    id: `offline-v142-browser-${sequence}`, from: { id: 101, is_bot: false }, currency: 'XTR',
    total_amount: issued.amountStars, invoice_payload: invoice.payload } }, { nowSeconds: at + 1, telegramApi });
  assert.equal(precheckout.approved, true);
  const applied = await handleStarsCommerceUpdate(f.serverEnv, { update_id: ++sequence, message: {
    from: { id: 101, is_bot: false }, chat: { id: 101, type: 'private' }, successful_payment: {
      currency: 'XTR', total_amount: issued.amountStars, invoice_payload: invoice.payload,
      telegram_payment_charge_id: `offline-v142-browser-charge-${sequence}`, provider_payment_charge_id: '' } } }, { nowSeconds: at + 2 });
  assert.equal(applied.accessApplied, true);
}
function preview(f) {
  const start = f.now - 5, end = start + 604800, source = 'dragon_preview:v1.3.5-hotfix.1';
  const time = value => new Date(value * 1000).toISOString().slice(0, 19).replace('T', ' ');
  f.sqlite.prepare("INSERT INTO user_plans(telegram_id,plan_code,source_code,effective_from) VALUES(101,'free',?,?)").run(source, time(start));
  f.sqlite.prepare("INSERT INTO user_access_states(telegram_id,access_state,source_code,state_started_at,state_ends_at) VALUES(101,'trial',?,?,?)")
    .run(source, time(start), time(end));
  f.sqlite.prepare(`INSERT INTO trial_grants(grant_id,telegram_id,subject_fingerprint,program_code,source_code,
    status,started_at,ends_at,retention_until,workflow_instance_id,workflow_state,granted_at,updated_at)
    VALUES(?,101,?,'dragon_preview',?,'active',?,?,?,?,'started',?,?)`)
    .run(crypto.randomUUID(), 'c'.repeat(64), source, start, end, end + 86400, crypto.randomUUID(), start, start);
  f.sqlite.prepare("UPDATE user_access SET access_tier='trial',trial_used=1,trial_started_at=?,trial_ends_at=? WHERE telegram_id=101")
    .run(time(start), time(end));
}

test('subscription navigation reads the fixed authenticated own endpoint and accepts the real server contract', async t => {
  const f = fixture(t), dto = await serverDTO(f), states = [];
  const { client, calls } = browser(f, () => response(dto));
  assert.equal(buildReadPath('subscription'), '/api/v1.4.0/cabinet/subscription');
  for (const params of [{ telegramId: 202 }, { plan: 'dragon' }, { cursor: 'foreign' }])
    assert.throws(() => buildReadPath('subscription', params), { code: 'invalid_request' });
  await client.authenticate('signed-offline');
  await new CabinetNavigator(client, state => states.push(state)).load('subscription');
  assert.equal(states.at(-1).status, 'ready');
  assert.equal(states.at(-1).data.access.current.planCode, 'free');
  assert.equal(calls[1].url, ORIGIN + buildReadPath('subscription'));
  assert.equal(calls[1].init.headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(calls[1].init.method, 'GET'); assert.equal(calls[1].init.body, undefined);
  assert.ok(Object.isFrozen(states.at(-1).data.catalog.comparison.rows[0].limits));
});

test('an unresolved own source remains unknown rather than Free or a zero quota', async t => {
  const f = fixture(t);
  f.sqlite.exec("UPDATE user_access SET access_tier='team' WHERE telegram_id=101");
  const dto = readSubscriptionDTO(await serverDTO(f));
  assert.equal(dto.access.current.planCode, null);
  assert.equal(dto.access.current.status, 'review_required');
  assert.equal(dto.access.current.expiresAt, null);
  assert.equal(dto.quotas.quotas[0].used, 0);
  assert.equal(dto.quotas.quotas[0].limit, null);
  assert.equal(dto.quotas.quotas[0].remaining, null);
});

test('real paid period and Preview overlay extend beyond the session without becoming the owner exception', async t => {
  const f = fixture(t); await paid(f);
  const paidDTO = readSubscriptionDTO(await serverDTO(f), { sessionExpiresAt: f.now + 300, nowSeconds: f.now });
  assert.equal(paidDTO.access.current.planCode, 'dragon');
  assert.equal(paidDTO.access.current.activeDragon, true);
  assert.ok(paidDTO.access.current.expiresAt > paidDTO.access.sessionExpiresAt + 20 * 86400);
  assert.equal(paidDTO.access.current.remainingSeconds, paidDTO.access.current.expiresAt - f.now);
  const g = fixture(t); preview(g);
  const previewDTO = readSubscriptionDTO(await serverDTO(g));
  assert.equal(previewDTO.authorization.effectivePlan, 'preview');
  assert.equal(previewDTO.access.current.planCode, 'free');
  assert.equal(previewDTO.access.current.previewActive, true);
  assert.equal(previewDTO.access.current.activeDragon, false);
  const owner = readSubscriptionDTO(await serverDTO(g, 900));
  assert.equal(owner.access.ownerException.applies, true);
  assert.equal(owner.access.current.planCode, 'free');
  assert.equal(owner.access.ownerException.isPaidPlan, false);
});

test('subscription always rejects missing, wrong-operation, denied or privately embellished authorization', async t => {
  const f = fixture(t), source = await serverDTO(f);
  for (const negotiation of [0, 1]) for (const edit of [
    dto => { delete dto.authorization; }, dto => { dto.authorization.capability = 'profile.read_own'; },
    dto => { dto.authorization.allowed = false; }, dto => { dto.authorization.allowed = 1; },
    dto => { dto.authorization.actor = { planCode: 'dragon', sourceVerified: true }; },
  ]) {
    const dto = structuredClone(source); edit(dto);
    const { client } = browser(f, () => response(dto), { negotiation });
    await client.authenticate('signed-offline');
    await assert.rejects(client.read('subscription'), { code: 'invalid_response' });
  }
});

test('invalid plans, timelines and capacity cannot be accepted as locally authoritative fields', async t => {
  const f = fixture(t), source = await serverDTO(f);
  for (const edit of [
    dto => { dto.planFromStorage = 'dragon'; }, dto => { dto.access.current.planCode = 'preview'; },
    dto => { dto.access.current.expiresAt = dto.access.sessionExpiresAt; },
    dto => { dto.access.ownerException.isPaidPlan = true; },
    dto => { dto.quotas.quotas[0].used = -1; }, dto => { dto.quotas.quotas[0].remaining++; },
    dto => { dto.quotas.quotas[1].key = dto.quotas.quotas[0].key; },
    dto => { dto.quotas.quotas[0].scope = 'foreign_applicant'; },
    dto => { dto.quotas.quotas[0].actionAdmissionRequired = false; },
    dto => { dto.quotas.quotas[0].canCreate = true; },
    dto => { dto.catalog.comparison.grantsRoles = true; },
  ]) {
    const dto = structuredClone(source); edit(dto);
    assert.throws(() => readSubscriptionDTO(dto), { code: 'invalid_response' });
  }
  f.sqlite.exec("UPDATE user_access SET access_tier='team' WHERE telegram_id=101");
  const unknown = structuredClone(await serverDTO(f)); unknown.quotas.quotas[0].remaining = 0;
  assert.throws(() => readSubscriptionDTO(unknown), { code: 'invalid_response' });
});

test('malformed support URLs, executable checkout links and invented native assets fail closed', async t => {
  const f = fixture(t), source = await serverDTO(f);
  for (const edit of [
    dto => { dto.catalog.support.url = 'javascript:alert(1)'; },
    dto => { dto.catalog.support.url = 'https://t.me.evil.example/RE_Program_Support_Bot?start=paysupport'; },
    dto => { dto.catalog.support.url = 'https://secret@t.me/RE_Program_Support_Bot?start=paysupport'; },
    dto => { dto.catalog.support.url += '&session_token=private'; },
    dto => { dto.catalog.offers[1].checkout.url = 'https://evil.example/checkout'; },
    dto => { dto.catalog.offers[1].checkout.available = false; },
    dto => { dto.catalog.offers[1].checkout.acceptanceCallback = 'admin_enable_all'; },
    dto => { dto.catalog.offers[1].checkout.hintIsAuthority = true; },
    dto => { dto.catalog.nativeDependencies.dragonEmoji.customEmojiId = 'invented'; },
    dto => { dto.catalog.nativeDependencies.referralShare.preparedMessageId = 'invented'; },
  ]) {
    const dto = structuredClone(source); edit(dto);
    assert.throws(() => readSubscriptionDTO(dto), { code: 'invalid_response' });
  }
});

test('changed published prices and absent price versions are preserved from actual server data', async t => {
  const f = fixture(t);
  for (const [plan, price] of [['professional', 299], ['dragon', 599]])
    f.sqlite.prepare(`INSERT INTO price_book(price_id,price_version,plan_code,currency,amount_stars,access_seconds,
      billing_mode,publication_state,terms_revision,valid_from,valid_until,created_at,created_by)
      VALUES(?,2,?,'XTR',?,2592000,'prepaid','approved','2026-09-10.stars-v1',?,NULL,?,'offline-v142-browser')`)
      .run(`${plan}-30d-prepaid-v2-browser`, plan, price, f.now - 30, f.now - 30);
  f.serverEnv.STARS_PRICE_VERSION = '2';
  const changed = readSubscriptionDTO(await serverDTO(f));
  assert.equal(changed.catalog.offers[1].amountStars, 299);
  assert.equal(changed.catalog.offers[1].matchesInitialPrice, false);
  f.serverEnv.STARS_PRICE_VERSION = '3';
  const absent = readSubscriptionDTO(await serverDTO(f));
  assert.equal(absent.catalog.offers[1].published, false);
  assert.equal(absent.catalog.offers[1].amountStars, null);
  assert.equal(absent.catalog.offers[1].purchaseEligibility.eligible, false);
});

test('subscription network failure can be retried against a fresh GET with no cached profile authority', async t => {
  const f = fixture(t), dto = await serverDTO(f), states = []; let attempts = 0;
  const { client, calls } = browser(f, () => ++attempts === 1 ? Promise.reject(new TypeError('offline')) : response(dto));
  await client.authenticate('signed-offline');
  const nav = new CabinetNavigator(client, state => states.push(state));
  await nav.load('subscription'); assert.equal(states.at(-1).error.code, 'network_error');
  await nav.load('subscription'); assert.equal(states.at(-1).status, 'ready');
  assert.equal(calls.length, 3);
  assert.ok(calls.slice(1).every(call => call.url === ORIGIN + buildReadPath('subscription')));
});

test('latest subscription request wins despite an old transport ignoring cancellation', async t => {
  const f = fixture(t), dto = await serverDTO(f), old = deferred(), fresh = deferred(), states = []; let attempt = 0;
  const { client } = browser(f, () => ++attempt === 1 ? old.promise : fresh.promise);
  await client.authenticate('signed-offline');
  const nav = new CabinetNavigator(client, state => states.push(state));
  const first = nav.load('subscription'), second = nav.load('subscription');
  fresh.resolve(response(dto)); await second;
  const bad = structuredClone(dto); bad.authorization.capability = 'admin.cabinet.open';
  old.resolve(response(bad)); await first;
  assert.equal(states.filter(state => state.status === 'ready').length, 1);
  assert.equal(states.some(state => state.status === 'error'), false);
});

test('session expiry and explicit cancellation never publish late private subscription data', async t => {
  const f = fixture(t), dto = await serverDTO(f), pending = deferred(), states = []; let expired = 0;
  const { client, clock } = browser(f, () => pending.promise, { onExpired: () => { expired++; } });
  await client.authenticate('signed-offline');
  const nav = new CabinetNavigator(client, state => states.push(state)), load = nav.load('subscription');
  clock.value = (f.now + 301) * 1000;
  pending.resolve(response(dto)); await load;
  assert.equal(states.at(-1).error.code, 'session_expired');
  assert.equal(client.authenticated, false); assert.equal(expired, 1);
  assert.equal(states.some(state => state.status === 'ready'), false);
  const secondPending = deferred(), secondStates = [];
  const next = browser(f, () => secondPending.promise);
  await next.client.authenticate('fresh-signed-offline');
  const secondNav = new CabinetNavigator(next.client, state => secondStates.push(state)), nextLoad = secondNav.load('subscription');
  secondNav.cancel(); secondPending.resolve(response(dto)); await nextLoad;
  assert.equal(secondStates.some(state => state.status === 'ready'), false);
});
