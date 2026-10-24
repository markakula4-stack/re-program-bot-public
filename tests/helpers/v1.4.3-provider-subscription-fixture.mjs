import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { foundationFixture } from './v1.4.1-fixtures.mjs';
import { authoritySeconds } from '../../src/v1.4.1/authority-resolver.mjs';
import { createServiceExecutor } from '../../src/v1.4.1/trusted-context.mjs';
import { buildStarsInvoicePayload } from '../../src/v1.3.6/stars-core-foundation.mjs';
import { acceptStarsPurchaseTerms, recordStarsSuccessfulPayment } from '../../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsPaidAccess } from '../../src/v1.3.6/stars-access-runtime.mjs';

export const MONTH = 2592000;
const hash = value => createHash('sha256').update(value).digest('hex');
const stamp = sec => new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ');
let nextUpdate = 1433000;
export async function subscriptionFixture(t, { paid = true } = {}) {
  const f = foundationFixture(t);
  f.sqlite.function('current_timestamp', { deterministic: false }, () => stamp(f.now));
  f.sqlite.function('unixepoch', { deterministic: false, varargs: true }, (...args) =>
    args.length === 0 || args[0] === 'now' ? f.now : authoritySeconds(args[0]));
  for (const file of ['0026-v1.3.6-stars-core-foundation.sql', '0027-v1.3.6-stars-access-and-reconciliation.sql',
    '0066-v1.4.3-subscription-lifecycle-foundation.sql', '0067-v1.4.3-lifecycle-engine-binding.sql'])
    f.sqlite.exec(fs.readFileSync(new URL('../../migrations/' + file, import.meta.url), 'utf8'));
  f.serverEnv = { ...f.serverEnv, WEBHOOK_SECRET: 'offline-subscription-transport-secret', STARS_PAYMENTS_ENABLED: 'true',
    STARS_BILLING_MODE: 'prepaid', STARS_PRICE_VERSION: '1', STARS_TERMS_REVISION: '2026-09-10.stars-v1',
    STARS_INVOICE_SECRET: 'offline-subscription-invoice-secret-more-than-32-characters' };
  const created = f.now - 100, price = 'professional-30d-recurring-v1', orderId = crypto.randomUUID();
  await acceptStarsPurchaseTerms(f.serverEnv, { telegramId: 101, telegramUpdateId: ++nextUpdate, acceptedAt: created - 1 });
  f.sqlite.prepare(`INSERT INTO price_book(price_id,price_version,plan_code,currency,amount_stars,
    access_seconds,billing_mode,terms_revision,valid_from,created_at)
    VALUES(?,1,'professional','XTR',249,?,'recurring',?,?,?)`).run(price, MONTH,
    f.serverEnv.STARS_TERMS_REVISION, created - 100, created - 100);
  const payload = await buildStarsInvoicePayload({ invoiceSecret: f.serverEnv.STARS_INVOICE_SECRET,
    orderId, telegramId: 101, priceId: price });
  f.sqlite.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,currency,
    amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,expires_at,
    precheckout_approved_at,updated_at) VALUES(?,101,?,1,'professional','XTR',249,?,'recurring',?,?,'precheckout_ok',?,?,?,?)`)
    .run(orderId, price, MONTH, f.serverEnv.STARS_TERMS_REVISION, payload, created, f.now + 600, created + 1, created + 1);
  const acceptance = f.sqlite.prepare('SELECT acceptance_id FROM terms_acceptances WHERE telegram_id=101').get();
  const contractId = crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO subscription_billing_contracts(contract_id,telegram_id,plan_code,price_id,
    origin_order_id,external_invoice_payload,external_payload_sha256,terms_revision,terms_acceptance_id,
    billing_mode,period_seconds,currency,amount_stars,created_at,updated_at)
    VALUES(?,101,'professional',?,?,?,?,?,?,'recurring',?,'XTR',249,?,?)`)
    .run(contractId, price, orderId, payload, hash(payload), f.serverEnv.STARS_TERMS_REVISION,
      acceptance.acceptance_id, MONTH, created, created);
  f.contractId = contractId; f.payload = payload; f.orderId = orderId; f.paidUntil = f.now - 10 + MONTH;
  if (paid) {
    const result = await recordStarsSuccessfulPayment(f.serverEnv, { update_id: ++nextUpdate, message: {
      message_id: ++nextUpdate, from: { id: 101, is_bot: false }, chat: { id: 101, type: 'private' },
      successful_payment: { currency: 'XTR', total_amount: 249, invoice_payload: payload,
        telegram_payment_charge_id: 'offline-subscription-charge-' + nextUpdate, provider_payment_charge_id: '',
        is_recurring: true, is_first_recurring: true, subscription_expiration_date: f.paidUntil } } },
    { receivedAt: f.now - 10 });
    const access = await applyStarsPaidAccess(f.serverEnv, { orderId: result.orderId, appliedAt: f.now - 10 });
    if (!access.accessApplied) throw new Error('offline synthetic financial fixture did not apply');
  }
  const executor = createServiceExecutor({ binding: f.binding, env: f.serverEnv,
    purpose: 'stars_process_event', clockSeconds: () => f.now });
  f.serviceContext = () => executor.createContext();
  f.update = (state = 'active', updateId = ++nextUpdate, userId = 101, invoicePayload = payload) => ({
    update_id: updateId, subscription: { user: { id: userId, is_bot: false, first_name: 'Offline' },
      invoice_payload: invoicePayload, state } });
  f.request = (update, patch = {}) => new Request(patch.url ?? 'https://worker.example/webhook', {
    method: patch.method ?? 'POST', headers: { 'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': f.serverEnv.WEBHOOK_SECRET, ...(patch.headers ?? {}) },
    body: patch.body ?? JSON.stringify(update) });
  f.claim = (update, { state = 'processing', token = crypto.randomUUID(), actor = update.subscription.user.id,
    lease = state === 'processing' ? f.now + 60 : 0 } = {}) => {
    f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,
      claim_token,received_at,lease_expires_at,completed_at) VALUES(?,'unsupported',?,?,?,?,?,?)`)
      .run(update.update_id, actor, state, token, f.now, lease, state === 'processing' ? null : f.now);
    return token;
  };
  return f;
}
