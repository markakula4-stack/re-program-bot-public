import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { AdminClient, buildAdminActionRequest, readAdminSubscriptionReviewDTO } from '../src/v1.4.0-rebuild/mini-app/admin-client.mjs';

const now = Math.floor(Date.now() / 1000), origin = 'https://cabinet.example.test';
const ledger = '10000000-0000-4000-8000-000000000143';
const authorization = (patch = {}) => ({ version: 1, capability: 'admin.cabinet.open', allowed: true,
  reasonCode: 'allowed', policyVersion: '2026-10-02.v1.4.1.policy-proposal.1', effectivePlan: 'free',
  accessState: 'none', validUntil: now + 300, quota: null, actionPolicy: 'allow', ...patch });
const row = (patch = {}) => ({ ledgerEntryId: ledger, telegramId: 101, planCode: 'dragon', currency: 'XTR',
  amountStars: 499, startsAt: now - 60, endsAt: now - 60 + 2_592_000, reasonCode: 'recovery_order_in_progress',
  recordedAt: now - 30, status: 'pending_review', ...patch });
const queue = (items = [row()], patch = {}) => ({ authority: 'worker', observedAt: now, items, hasMore: false,
  actionAdmissionRequired: true, authorization: authorization(), ...patch });
const response = (data, status = 200) => Response.json(data, { status });
const session = (canMutate = true) => ({ sessionToken: 'rpms1_' + 'A'.repeat(43), tokenType: 'Bearer', expiresAt: now + 300,
  principal: { telegramId: 900, botId: 123456789 }, features: { version: 1, mutationsEnabled: canMutate, offerActionsEnabled: false } });
async function transport(handler, { canMutate = true } = {}) {
  const calls = [], client = new AdminClient({ origin, cryptoImpl: webcrypto, now: () => now * 1000,
    fetchImpl: async (url, options) => { calls.push({ url, options });
      return url.endsWith('/session') ? response(session(canMutate)) : handler(url, options); } });
  await client.authenticate('OFFLINE_UI_SIGNED_TRANSPORT_FIXTURE');
  return { client, calls };
}

test('owner queue decoder accepts only bounded server-authorized financial display, including durable unresolved and terminal records', () => {
  for (const status of ['pending_review', 'applied', 'refunded', 'chargeback', 'pending', 'unknown']) {
    assert.equal(readAdminSubscriptionReviewDTO(queue([row({ status })])).items[0].status, status);
  }
  assert.equal(readAdminSubscriptionReviewDTO(queue([row({ startsAt: null, endsAt: null })])).items[0].startsAt, null);
  assert.equal(readAdminSubscriptionReviewDTO(queue(Array.from({ length: 50 }, (_, i) => row({ ledgerEntryId: 'receipt_' + i })))).items.length, 50);
  const damaged = [queue([row()], { authority: 'browser' }), queue([row()], { actionAdmissionRequired: false }),
    queue(Array.from({ length: 51 }, (_, i) => row({ ledgerEntryId: 'receipt_' + i }))), queue([row(), row()]),
    queue([row({ startsAt: null })]), queue([row({ amountStars: 0 })]), queue([row({ status: 'paid' })]),
    queue([row({ telegram_payment_charge_id: 'private-charge' })]), queue([row()], { sql: 'private' }),
    queue([row()], { authorization: authorization({ capability: 'access.read_own' }) }),
    queue([row()], { authorization: authorization({ allowed: false, reasonCode: 'role_required', actionPolicy: 'deny' }) })];
  for (const data of damaged) assert.throws(() => readAdminSubscriptionReviewDTO(data));
});

test('review request builder binds only one stored credit and approved reason, with no editable price, user, period or arbitrary route', () => {
  for (const action of ['apply', 'refund']) {
    const request = buildAdminActionRequest('subscription.review.' + action,
      { reasonCode: action === 'apply' ? 'owner_payment_confirmed' : 'owner_refund_requested' }, { ledgerEntryId: ledger });
    assert.equal(request.path, '/api/v1.4.0/cabinet/admin/subscription-review/' + action);
    assert.equal(request.capability, 'admin.cabinet.open');
    assert.deepEqual(Object.keys(JSON.parse(request.body)).sort(), ['ledgerEntryId', 'reasonCode']);
  }
  for (const field of ['amountStars', 'telegramId', 'planCode', 'startsAt', 'endsAt', 'confirmed']) {
    assert.throws(() => buildAdminActionRequest('subscription.review.apply',
      { reasonCode: 'owner_payment_confirmed', [field]: 1 }, { ledgerEntryId: ledger }));
  }
  assert.throws(() => buildAdminActionRequest('subscription.review.apply', { reasonCode: 'unreviewed_reason' }, { ledgerEntryId: ledger }));
  assert.throws(() => buildAdminActionRequest('subscription.review.refund', { reasonCode: 'owner_refund_requested' }, { ledgerEntryId: ledger, telegramId: 202 }));
  assert.throws(() => buildAdminActionRequest('subscription.review.refund', { reasonCode: 'owner_refund_requested' }, { ledgerEntryId: '../foreign' }));
});

test('owner client fixes queue GET, keeps session guard and deduplicates an exact pending apply into one idempotent POST', async () => {
  let finish;
  const { client, calls } = await transport((url, options) => options.method === 'GET'
    ? response(queue()) : new Promise(resolve => { finish = resolve; }));
  assert.equal((await client.readSubscriptionReview()).items[0].ledgerEntryId, ledger);
  assert.equal(calls[1].url, origin + '/api/v1.4.0/cabinet/admin/subscription-review');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer rpms1_' + 'A'.repeat(43));
  await assert.rejects(client.readSubscriptionReview({ telegramId: 202 }), { code: 'invalid_request' });
  const payload = { reasonCode: 'owner_payment_confirmed' }, target = { ledgerEntryId: ledger };
  const first = client.mutate('subscription.review.apply', payload, target);
  assert.equal(client.mutate('subscription.review.apply', payload, target), first);
  await assert.rejects(client.mutate('subscription.review.refund', { reasonCode: 'owner_refund_requested' }, target), { code: 'request_in_progress' });
  assert.match(calls[2].options.headers['Idempotency-Key'], /^[a-f0-9]{48}$/u);
  assert.deepEqual(JSON.parse(calls[2].options.body), { reasonCode: 'owner_payment_confirmed', ledgerEntryId: ledger });
  finish(response({ status: 'applied', decision: 'apply', ledgerEntryId: ledger, accessApplied: true, authorization: authorization() }));
  assert.equal((await first).accessApplied, true);
  assert.equal(calls.length, 3);
  client.clearSession();
  await assert.rejects(client.readSubscriptionReview(), { code: 'session_expired' });
  const readOnly = await transport(() => { throw new Error('write transport must not run'); }, { canMutate: false });
  await assert.rejects(readOnly.client.mutate('subscription.review.refund', { reasonCode: 'owner_refund_requested' }, target), { code: 'writes_unavailable' });
  assert.equal(readOnly.calls.length, 1);
});

test('unknown or malformed mutation results lock further writes; reading durable unknown does not blindly retry or clear that lock', async () => {
  for (const outcome of ['manual_review', 'lost', 'malformed']) {
    const { client, calls } = await transport((_url, options) => {
      if (options.method === 'GET') return response(queue([row({ status: 'unknown' })]));
      if (outcome === 'lost') throw new Error('offline lost response');
      return response(outcome === 'malformed' ? { status: 'applied', decision: 'refund', refunded: false, authorization: authorization() }
        : { status: 'manual_review', decision: 'refund', refunded: false, reason: 'provider_refund_result_unresolved', authorization: authorization() });
    });
    const operation = client.mutate('subscription.review.refund', { reasonCode: 'owner_refund_requested' }, { ledgerEntryId: ledger });
    if (outcome === 'manual_review') assert.equal((await operation).refunded, false);
    else await assert.rejects(operation, { code: 'outcome_unknown' });
    assert.equal(client.uncertain, true);
    assert.equal((await client.readSubscriptionReview()).items[0].status, 'unknown');
    await assert.rejects(client.mutate('subscription.review.refund', { reasonCode: 'owner_refund_requested' }, { ledgerEntryId: ledger }), { code: 'outcome_unknown' });
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 2); // Session and one financial action.
    client.clearSession();
  }
});

async function view(t, { items = [row()], hasMore = false, outcome = 'applied', canMutate = true } = {}) {
  const requireBrowser = createRequire(new URL('./p11-runtime/package.json', import.meta.url));
  const { chromium } = requireBrowser('playwright');
  const executablePath = process.env.P11_BROWSER_PATH ?? process.env.CABINET_BROWSER_EXECUTABLE;
  const browser = await chromium.launch({ headless: true, ...(executablePath
    ? { executablePath } : {}), args: ['--disable-background-networking'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 320, height: 844 }, serviceWorkers: 'block' });
  let networkRequests = 0;
  await context.route('**/*', route => { networkRequests++; return route.abort(); });
  await context.routeWebSocket('**/*', socket => { networkRequests++; socket.close(); });
  const page = await context.newPage();
  const source = async file => readFile(new URL('../src/v1.4.0-rebuild/mini-app/' + file, import.meta.url), 'utf8');
  const [html, common, owner, helpers, viewSource] = await Promise.all([
    source('admin-cabinet.html'), source('partner-cabinet.css'), source('admin-cabinet.css'), source('cabinet-client.mjs'), source('admin-view.mjs')]);
  const shell = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '').replace(/<link\b[^>]*>/giu, '').replace(/<noscript>[\s\S]*?<\/noscript>/giu, '');
  const helperCode = helpers.replace(/^export /gmu, '');
  const viewCode = viewSource.replace(/^import \{ errorMessage, formatDate \} from "\.\/cabinet-client\.mjs";\n/u, '').replace(/^export /gmu, '');
  assert.ok(!/^import /mu.test(viewCode));
  const script = `const {errorMessage,formatDate}=(()=>{${helperCode}\nreturn {errorMessage,formatDate};})();\n${viewCode}\n
    const items=${JSON.stringify(items)}, base=${JSON.stringify(queue([], { hasMore }))};
    globalThis.ownerClient={authenticated:true,canMutate:${canMutate},uncertain:false,expiresAt:${now + 300},writes:[],reads:[],
      clearSession(){this.authenticated=false;this.canMutate=false;},
      async read(section){return {section,items:section==='support'?[{ticketId:12,userLabel:'Пользователь',status:'open',pendingMessages:1,updatedAt:${now},canReply:true}]:[],release:{version:'1.4.3',mode:'owner_only',partnerBetaEnabled:false}};},
      async readSubscriptionReview(params){this.reads.push(params);return {...base,items:structuredClone(items)};},
      async readTicket(){return {section:'support',ticket:{ticketId:12,userLabel:'Пользователь',status:'open',lastMessageId:15,canReply:true,canClose:true},messages:[{messageId:15,direction:'user',text:'Нужна помощь',createdAt:${now},hasPhoto:false}],hasMore:false};},
      async mutate(action,payload,target){this.writes.push({action,payload,target});
        if(action.startsWith('support.'))return {commitStatus:'committed',deliveryState:'queued'};
        if(${JSON.stringify(outcome)}==='manual_review'){this.uncertain=true;this.uncertainReason='payment_review_unknown';return {status:'manual_review',decision:'refund',refunded:false};}
        items[0].status='applied';return {status:'applied',accessApplied:true};}
    };
    globalThis.ownerView=mountAdminCabinet({document,client:ownerClient});
    globalThis.__ready=(async()=>{await ownerView.start();await ownerView.navigate('payments');})();`;
  await page.setContent(shell.replace('</head>', `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'"><style>${common}\n${owner}</style></head>`)
    .replace('</body>', `<script type="module">${script.replaceAll('</script', '<\\/script')}</script></body>`), { waitUntil: 'load' });
  await page.evaluate(() => globalThis.__ready);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('launch-screen')).visibility === 'hidden');
  t.after(() => assert.equal(networkRequests, 0));
  return page;
}

test('owner payment UI renders stored history read-only and requires an explicit reason plus confirmation before one apply', async t => {
  const items = ['pending_review', 'applied', 'refunded', 'chargeback', 'pending', 'unknown'].map((status, i) => row({ status, ledgerEntryId: 'receipt_' + i }));
  const page = await view(t, { items, hasMore: true });
  assert.deepEqual(await page.locator('#admin-navigation button').allTextContents(), ['Пульт', 'Поддержка', 'Платежи']);
  assert.deepEqual(await page.evaluate(() => ownerClient.reads), [{}]);
  const text = await page.locator('#admin-screen').textContent();
  assert.match(text, /Есть более ранние записи/u);
  for (const status of ['Возвращено', 'Спор по оплате', 'Ожидаем подтверждение', 'Результат неясен']) assert.match(text, new RegExp(status, 'u'));
  for (const i of [2, 3, 4, 5]) assert.equal(await page.locator(`[data-payment-id="receipt_${i}"] [data-admin-write]`).count(), 0);
  const first = page.locator('[data-payment-id="receipt_0"]');
  await first.locator('summary').click(); await first.getByRole('button', { name: 'Выдать доступ', exact: true }).click();
  const form = first.locator('.admin-confirm'), submit = form.locator('button[type="submit"]');
  assert.equal(await form.locator('textarea').count(), 0);
  assert.equal(await submit.isDisabled(), true);
  await form.dispatchEvent('submit'); assert.equal(await page.evaluate(() => ownerClient.writes.length), 0);
  await form.locator('select').selectOption('owner_payment_confirmed'); assert.equal(await submit.isDisabled(), true);
  await form.locator('input[type="checkbox"]').check(); assert.equal(await submit.isDisabled(), false);
  await page.evaluate(() => { const form=document.querySelector('.admin-confirm');form.dispatchEvent(new Event('submit',{cancelable:true}));form.dispatchEvent(new Event('submit',{cancelable:true})); });
  await page.waitForFunction(() => ownerClient.reads.length === 2);
  assert.deepEqual(await page.evaluate(() => ownerClient.writes), [{ action: 'subscription.review.apply', payload: { reasonCode: 'owner_payment_confirmed' }, target: { ledgerEntryId: 'receipt_0' } }]);
  assert.match(await page.locator('#admin-notice').textContent(), /Доступ выдан/u);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => ownerView.expire()); assert.equal(await page.locator('#admin-navigation').isHidden(), true);
  assert.equal(await page.locator('[data-admin-write]').count(), 0);
});

test('owner view keeps unknown outcomes and closed writes disabled, with safe text and no invented success or retry button', async t => {
  const page = await view(t, { outcome: 'manual_review' });
  await page.locator('.admin-payment-card summary').click(); await page.getByRole('button', { name: 'Вернуть Stars', exact: true }).click();
  const form = page.locator('.admin-confirm');
  await form.locator('select').selectOption('owner_refund_requested'); await form.locator('input[type="checkbox"]').check();
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(() => ownerClient.reads.length === 2);
  assert.match(await page.locator('#admin-notice').textContent(), /не подтверждён/u);
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-admin-write]')].every(node => node.disabled)));
  await page.evaluate(() => ownerView.navigate('payments'));
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-admin-write]')].every(node => node.disabled)));
  assert.equal(await page.evaluate(() => ownerClient.writes.length), 1);
  const readOnly = await view(t, { canMutate: false, items: [row({ ledgerEntryId: '<img src=x onerror=alert(1)>' })] });
  assert.equal(await readOnly.locator('img').count(), 0);
  assert.match(await readOnly.locator('#admin-screen').textContent(), /<img src=x/u);
  assert.ok(await readOnly.evaluate(() => [...document.querySelectorAll('[data-admin-write]')].every(node => node.disabled)));
  const support = await view(t);
  await support.evaluate(() => ownerView.navigate('support'));
  await support.locator('[data-ticket-id="12"]').click();
  const composer = support.locator('.admin-reply-composer');
  await composer.waitFor(); assert.equal(await composer.getByRole('button', { name: 'Отправить', exact: true }).isDisabled(), true);
  await composer.locator('textarea').fill('Проверяем ваше обращение.');
  await composer.getByRole('button', { name: 'Отправить', exact: true }).click();
  assert.equal(await composer.locator('.admin-confirm').count(), 1);
  await composer.getByRole('button', { name: 'Отправить пользователю', exact: true }).click();
  await support.waitForFunction(() => ownerClient.writes.length === 1);
  assert.equal(await support.evaluate(() => ownerClient.writes[0].action), 'support.reply');
  assert.ok(await support.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});
