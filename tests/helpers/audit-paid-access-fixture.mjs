import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { foundationFixture } from './v1.4.1-fixtures.mjs';
import { buildStarsInvoicePayload } from '../../src/v1.3.6/stars-core-foundation.mjs';
import { acceptStarsPurchaseTerms, recordStarsSuccessfulPayment } from '../../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsPaidAccess } from '../../src/v1.3.6/stars-access-runtime.mjs';

const MONTH = 2_592_000;
let sequence = 1_430_000;
const next = () => ++sequence;
const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const sqlTime = value => new Date(value * 1000).toISOString().slice(0, 19).replace('T', ' ');

function fixture(t) {
  const f = foundationFixture(t);
  f.sqlite.function('current_timestamp', { deterministic: true }, () => sqlTime(f.now));
  for (const name of ['0026-v1.3.6-stars-core-foundation.sql', '0027-v1.3.6-stars-access-and-reconciliation.sql',
    '0066-v1.4.3-subscription-lifecycle-foundation.sql', '0067-v1.4.3-lifecycle-engine-binding.sql',
    '0068-v1.4.3-provider-and-review-binding.sql','0069-v1.4.3-d1-compatibility.sql',
    '0070-v1.4.3-refund-notification.sql','0071-v1.4.3-refund-contract-retirement.sql',
    '0072-v1.4.4-package-contract.sql','0073-v1.4.4-package-payment-review.sql']) {
    f.sqlite.exec(fs.readFileSync(new URL('../../migrations/' + name, import.meta.url), 'utf8'));
  }
  f.env = { ...f.serverEnv, STARS_PAYMENTS_ENABLED: 'true', STARS_BILLING_MODE: 'prepaid',
    STARS_PRICE_VERSION: '1', STARS_TERMS_REVISION: '2026-09-10.stars-v1',
    STARS_INVOICE_SECRET: 'offline-v143-payment-writer-secret-more-than-32-characters' };
  for (const id of [101, 202, 303, 404]) {
    f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(id);
    f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(id);
  }
  return f;
}

async function seedOrder(f, { id = 101, plan = 'dragon', mode = 'prepaid', state = 'created',
  createdAt = f.now - 60, expiresAt = f.now + 600 } = {}) {
  await acceptStarsPurchaseTerms(f.env, { telegramId: id, telegramUpdateId: next(), acceptedAt: createdAt - 1 });
  const priceId = `${plan}-30d-${mode}-v1`, amount = plan === 'dragon' ? 499 : 249;
  if (mode === 'recurring') {
    f.sqlite.prepare(`INSERT OR IGNORE INTO price_book(price_id,price_version,plan_code,currency,amount_stars,
      access_seconds,billing_mode,publication_state,terms_revision,valid_from,created_at,created_by)
      VALUES(?,1,?,'XTR',?,?,'recurring','approved',?,?,?,'offline-v143-fixture')`)
      .run(priceId, plan, amount, MONTH, f.env.STARS_TERMS_REVISION, createdAt - 100, createdAt - 100);
  }
  const orderId = crypto.randomUUID();
  const payload = await buildStarsInvoicePayload({ invoiceSecret: f.env.STARS_INVOICE_SECRET,
    orderId, telegramId: id, priceId });
  f.sqlite.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,currency,
    amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,expires_at,
    precheckout_approved_at,closed_at,updated_at) VALUES(?,?,?,1,?,'XTR',?,?,?,?,?,?,?,?,?,?,?)`)
    .run(orderId, id, priceId, plan, amount, MONTH, mode, f.env.STARS_TERMS_REVISION, payload, state,
      createdAt, expiresAt, state === 'precheckout_ok' ? createdAt + 1 : null,
      ['failed', 'cancelled'].includes(state) ? expiresAt : null, Math.max(createdAt, Math.min(f.now, expiresAt)));
  return { orderId, payload, id, plan, mode, amount, createdAt, expiresAt };
}

function successful(order, { charge = 'offline-v143-charge-' + next(), expiration, first = true, updateId = next() } = {}) {
  return { update_id: updateId, message: { message_id: next(), from: { id: order.id, is_bot: false },
    chat: { id: order.id, type: 'private' }, successful_payment: { currency: 'XTR', total_amount: order.amount,
      invoice_payload: order.payload, telegram_payment_charge_id: charge, provider_payment_charge_id: '',
      ...(order.mode === 'recurring' ? { is_recurring: true, is_first_recurring: first,
        subscription_expiration_date: expiration } : {}) } } };
}

async function recordAndApply(f, update, at = f.now) {
  const recorded = await recordStarsSuccessfulPayment(f.env, update, { receivedAt: at });
  const applied = await applyStarsPaidAccess(f.env, { orderId: recorded.orderId, appliedAt: at });
  assert.equal(applied.accessApplied, true);
  return { recorded, applied };
}

async function recurring(f, options = {}) {
  const order = await seedOrder(f, { mode: 'recurring', state: 'precheckout_ok', createdAt: f.now - 2 * MONTH, ...options });
  const contractId = crypto.randomUUID();
  const acceptance = f.sqlite.prepare(`SELECT acceptance_id FROM terms_acceptances
    WHERE telegram_id=? AND terms_revision=? AND acceptance_scope='stars_purchase'`).get(order.id, f.env.STARS_TERMS_REVISION);
  f.sqlite.prepare(`INSERT INTO subscription_billing_contracts(contract_id,telegram_id,plan_code,price_id,
    origin_order_id,external_invoice_payload,external_payload_sha256,terms_revision,terms_acceptance_id,billing_mode,
    period_seconds,currency,amount_stars,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'recurring',?,'XTR',?,?,?)`)
    .run(contractId, order.id, order.plan, `${order.plan}-30d-recurring-v1`, order.orderId, order.payload,
      sha256(order.payload), f.env.STARS_TERMS_REVISION, acceptance.acceptance_id, MONTH, order.amount,
      order.createdAt, order.createdAt);
  return { ...order, contractId };
}


export {fixture, seedOrder, recurring, successful, recordAndApply, MONTH};
