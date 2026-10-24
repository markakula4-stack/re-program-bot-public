import { verifyStarsInvoicePayload } from '../v1.3.6/stars-core-foundation.mjs';
import { inspectPackageSchema, packageSchemaAssertion } from './package-schema.mjs';
import { readPackageAccessDatabaseSource } from './package-access-runtime.mjs';
import { inspectLifecycleSchema, lifecycleSchemaAssertion } from '../v1.4.3/lifecycle-schema.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const sameNumber = (left, right) => Number.isSafeInteger(Number(left)) && Number(left) === Number(right);
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const paidPlans = new Set(['professional', 'dragon']);
const durations = Object.freeze({ '30d': 30, '3m': 90, '6m': 180, '12m': 360 });
const schemaDatabase = db => ({ prepare: sql => db.prepare(sql.replace(/^SELECT\s/u, 'SELECT ')),
  batch: statements => db.batch(statements) });
const sha256 = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const rowAssertion = (table, row) => {
  const key = { subscription_plan_transitions: 'transition_id', subscription_payment_review_receipts: 'ledger_entry_id',
    subscription_billing_contracts: 'contract_id', payment_events: 'event_id', payment_ledger: 'ledger_entry_id' }[table];
  if (!key || !row[key]) fail('package_settlement_assertion_invalid');
  const columns = Object.keys(row); let expression = "json('{}')";
  for (let index = 0; index < columns.length; index += 15)
    expression = `json_set(${expression},${columns.slice(index, index + 15).flatMap(name => [`'$.${name}'`, name]).join(',')})`;
  return { sql: `(SELECT ${expression} FROM ${table} WHERE ${key}=? LIMIT 1) IS ?`, params: [row[key], JSON.stringify(row)] };
};

// Public bodies choose one own ledger UUID. Amount, plan, invoice and provider
// charge are read only from the canonical DB, then admitted by the existing
// private capability/resource engine and its fixed refund accounting facade.
export async function requestOwnPackageRefund(context, payload, options = {}) {
  const { readTrustedContext } = await import('../v1.4.1/trusted-context.mjs');
  const { createRuntimeAuthorizer, requireRuntimeAuthorization } = await import('../v1.4.1/runtime-authorizer.mjs');
  const { prepareOwnPackageRefundCompatibility, bindLegacyCompatibilityEnv } = await import('../v1.4.1/telegram-legacy-compatibility.mjs');
  const { requestStarsRefund } = await import('../v1.3.6/stars-access-runtime.mjs');
  const identity = readTrustedContext(context);
  if (identity.actorKind !== 'customer' || identity.channel !== 'mini_app' || identity.operation !== 'admin.stars.refund' ||
      !payload || Array.isArray(payload) || Object.keys(payload).length !== 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(payload.ledgerEntryId ?? '') ||
      JSON.stringify(payload) !== JSON.stringify(identity.requestPayload)) fail('package_refund_request_invalid');
  const payment = await identity.db.prepare(`SELECT order_id,telegram_payment_charge_id FROM payment_ledger
    WHERE ledger_entry_id=? AND telegram_id=? AND entry_type='payment' AND direction='credit' AND currency='XTR' LIMIT 1`)
    .bind(payload.ledgerEntryId, identity.telegramId).first();
  if (!payment) fail('package_refund_source_unavailable');
  const authorization = requireRuntimeAuthorization(await createRuntimeAuthorizer().authorize(context,
    { kind: 'payment', key: payment.order_id }));
  const permit = await prepareOwnPackageRefundCompatibility(authorization);
  const accounting = bindLegacyCompatibilityEnv(permit, { ...identity.env, DB: identity.db });
  return requestStarsRefund(accounting, { adminTelegramId: identity.telegramId,
    telegramPaymentChargeId: payment.telegram_payment_charge_id, reasonCode: 'package_customer_refund' }, options);
}

// This reader runs inside the existing fixed financial facade. It does not
// mint customer authorization, write a second ledger or grant access. Reads
// remain enabled after producer flags are disabled: accepted money must still
// be refundable and reconcilable during rollback.
export async function readPackageSettlementSource(env, original) {
  const db = env?.DB;
  if (!db?.prepare) fail('package_settlement_database_required');
  const schema = await inspectPackageSchema(schemaDatabase(db));
  if (!schema.present) return null;
  const metadata = await db.prepare('SELECT * FROM subscription_package_orders WHERE order_id=? LIMIT 1')
    .bind(original.order_id).first();
  if (!metadata) return null;
  const order = await db.prepare('SELECT * FROM subscription_orders WHERE order_id=? LIMIT 1')
    .bind(original.order_id).first();
  const price = await db.prepare('SELECT * FROM price_book WHERE price_id=? LIMIT 1')
    .bind(metadata.price_id).first();
  if (!order || !price || !paidPlans.has(order.plan_code) || !Object.hasOwn(durations, metadata.package_code) ||
      metadata.billing_mode !== order.billing_mode || !['prepaid', 'recurring'].includes(order.billing_mode) ||
      metadata.billing_mode === 'recurring' && metadata.package_code !== '30d' ||
      metadata.order_id !== original.order_id || order.order_id !== original.order_id ||
      metadata.price_id !== order.price_id || price.price_id !== order.price_id ||
      metadata.plan_code !== order.plan_code || price.plan_code !== order.plan_code ||
      metadata.currency !== 'XTR' || order.currency !== 'XTR' || price.currency !== 'XTR' ||
      !sameNumber(metadata.telegram_id, original.telegram_id) || !sameNumber(order.telegram_id, original.telegram_id) ||
      !sameNumber(metadata.price_version, order.price_version) || !sameNumber(price.price_version, order.price_version) ||
      !sameNumber(metadata.amount_stars, order.amount_stars) || !sameNumber(price.amount_stars, order.amount_stars) ||
      !sameNumber(original.amount_stars, order.amount_stars) ||
      !sameNumber(metadata.duration_days, durations[metadata.package_code]) ||
      !sameNumber(metadata.period_seconds, durations[metadata.package_code] * 86400) ||
      !sameNumber(metadata.period_seconds, order.access_seconds) || !sameNumber(price.access_seconds, order.access_seconds) ||
      price.billing_mode !== order.billing_mode || price.terms_revision !== order.terms_revision ||
      !positive(metadata.quoted_starts_at) || !sameNumber(metadata.quoted_ends_at, Number(metadata.quoted_starts_at) + Number(metadata.period_seconds)) ||
      !positive(original.occurred_at) || Number(original.occurred_at) < Number(order.created_at))
    fail('package_settlement_binding_invalid');
  const verified = await verifyStarsInvoicePayload({ invoiceSecret: String(env.STARS_INVOICE_SECRET || ''),
    payload: order.invoice_payload, telegramId: Number(order.telegram_id), priceId: order.price_id });
  if (verified.orderId !== order.order_id) fail('package_settlement_invoice_invalid');
  const period = await db.prepare('SELECT * FROM subscription_package_periods WHERE payment_ledger_entry_id=? LIMIT 1')
    .bind(original.ledger_entry_id).first();
  if (!period) return Object.freeze({ metadata, period: null, schemaAssertion: packageSchemaAssertion(schema) });
  const startsAt = Math.max(Number(metadata.quoted_starts_at), Number(original.occurred_at));
  if (order.billing_mode !== 'prepaid' || original.grant_id || period.order_id !== original.order_id ||
      !sameNumber(period.telegram_id, original.telegram_id) || period.plan_code !== order.plan_code ||
      period.price_id !== order.price_id || !sameNumber(period.price_version, order.price_version) ||
      period.billing_mode !== 'prepaid' || !sameNumber(period.period_seconds, order.access_seconds) ||
      !sameNumber(period.starts_at, startsAt) || !sameNumber(period.ends_at, startsAt + Number(order.access_seconds)) ||
      period.transition_id !== metadata.transition_id || !positive(period.recorded_at) ||
      Number(period.recorded_at) < Number(original.occurred_at) ||
      !['paid', 'applied', 'refunded', 'chargeback'].includes(order.order_state))
    fail('package_settlement_period_invalid');
  return Object.freeze({ metadata, period, schemaAssertion: packageSchemaAssertion(schema) });
}

// A canceled or source-compensated reserved monthly invoice can still arrive
// as real cash. Only its existing immutable review receipt is admitted here;
// ordinary recurring grants and active monthly invoices are outside this gate.
export async function readReservedMonthlyRetainedSettlementSource(env, original, source = null) {
  source ??= await readPackageSettlementSource(env, original);
  const metadata = source?.metadata;
  if (metadata?.billing_mode !== 'recurring' || metadata.package_code !== '30d') return null;
  if (original.reason_code !== 'payment_review_retained' || original.entry_type !== 'payment' || original.direction !== 'credit' ||
      original.currency !== 'XTR' || original.related_ledger_entry_id !== null || source.period || !metadata.transition_id)
    return null;
  const db = env.DB, schema = await inspectLifecycleSchema(schemaDatabase(db), { required: true });
  const order = await db.prepare('SELECT * FROM subscription_orders WHERE order_id=?').bind(original.order_id).first();
  const transition = await db.prepare('SELECT * FROM subscription_plan_transitions WHERE transition_id=?').bind(metadata.transition_id).first();
  const receipt = await db.prepare('SELECT * FROM subscription_payment_review_receipts WHERE ledger_entry_id=?').bind(original.ledger_entry_id).first();
  if (!receipt || !['package_monthly_transition_cancelled', 'package_monthly_transition_source_compensated'].includes(receipt.reason_code))
    return null;
  const contract = receipt?.contract_id ? await db.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').bind(receipt.contract_id).first() : null;
  if (!order || !transition || !receipt || !contract || !['failed', 'cancelled'].includes(order.order_state) ||
      transition.telegram_id !== original.telegram_id || transition.to_plan !== metadata.plan_code ||
      transition.to_billing_mode !== 'recurring' || transition.target_package_code !== '30d' ||
      transition.target_price_id !== metadata.price_id || transition.target_price_version !== metadata.price_version ||
      transition.period_seconds !== metadata.period_seconds || transition.source_paid_until !== metadata.source_paid_until ||
      transition.contract_version !== metadata.contract_version || transition.source_fingerprint !== metadata.source_fingerprint ||
      transition.source_revision !== metadata.source_revision || transition.offer_version !== metadata.offer_version ||
      transition.source_payment_ledger_entry_id !== metadata.source_payment_ledger_entry_id ||
      transition.source_subscription_id !== metadata.source_subscription_id || transition.source_package_period_id !== metadata.source_package_period_id ||
      receipt.origin_order_id !== original.order_id || receipt.telegram_id !== original.telegram_id || receipt.plan_code !== metadata.plan_code ||
      receipt.external_invoice_payload !== order.invoice_payload || receipt.external_payload_sha256 !== await sha256(order.invoice_payload) ||
      receipt.telegram_update_id !== original.telegram_update_id || !positive(receipt.recorded_at) || receipt.recorded_at < original.recorded_at ||
      !positive(receipt.provider_period_start) || receipt.provider_period_end !== receipt.provider_period_start + metadata.period_seconds ||
      ![0, 1].includes(receipt.is_first_recurring) ||
      contract.origin_order_id !== original.order_id || contract.telegram_id !== original.telegram_id || contract.plan_code !== metadata.plan_code ||
      contract.price_id !== order.price_id || contract.currency !== 'XTR' || contract.amount_stars !== original.amount_stars ||
      contract.billing_mode !== 'recurring' || contract.period_seconds !== metadata.period_seconds || contract.terms_revision !== order.terms_revision ||
      contract.external_invoice_payload !== order.invoice_payload || contract.external_payload_sha256 !== receipt.external_payload_sha256)
    fail('package_monthly_retained_refund_binding_invalid');
  const expectedEvidence = await sha256(JSON.stringify({ currency: 'XTR', total_amount: original.amount_stars,
    invoice_payload_sha256: receipt.external_payload_sha256, telegram_payment_charge_sha256: await sha256(original.telegram_payment_charge_id),
    is_recurring: true, is_first_recurring: receipt.is_first_recurring === 1, subscription_expiration_date: receipt.provider_period_end }));
  const event = await db.prepare(`SELECT * FROM payment_events WHERE order_id=? AND telegram_id=? AND telegram_update_id IS ?
    AND event_type='payment_recorded' AND outcome='accepted' AND reason_code='payment_review_retained' AND payload_sha256=? LIMIT 1`)
    .bind(original.order_id, original.telegram_id, original.telegram_update_id, expectedEvidence).first();
  if (receipt.evidence_sha256 !== expectedEvidence || !event || event.received_at > receipt.recorded_at ||
      await db.prepare('SELECT grant_id FROM subscription_access_grants WHERE payment_ledger_entry_id=? LIMIT 1').bind(original.ledger_entry_id).first() ||
      await db.prepare("SELECT operation_id FROM subscription_payment_links WHERE ledger_entry_id=? AND direction='incoming' LIMIT 1").bind(original.ledger_entry_id).first())
    fail('package_monthly_retained_refund_evidence_invalid');
  const assertions = [source.schemaAssertion, lifecycleSchemaAssertion(schema), rowAssertion('subscription_plan_transitions', transition),
    rowAssertion('subscription_payment_review_receipts', receipt), rowAssertion('subscription_billing_contracts', contract), rowAssertion('payment_events', event),
    { sql: 'NOT EXISTS(SELECT 1 FROM subscription_access_grants WHERE payment_ledger_entry_id=?)', params: [original.ledger_entry_id] },
    { sql: "NOT EXISTS(SELECT 1 FROM subscription_payment_links WHERE ledger_entry_id=? AND direction='incoming')", params: [original.ledger_entry_id] }];
  // Provider-confirmed accounting keeps immutable financial binding. A later
  // retirement/provider-state observation cannot undo the actual refund.
  const immutableContract = Object.fromEntries(['contract_id', 'origin_order_id', 'telegram_id', 'plan_code', 'price_id',
    'external_invoice_payload', 'external_payload_sha256', 'currency', 'amount_stars', 'billing_mode', 'period_seconds',
    'terms_revision', 'created_at'].map(key => [key, contract[key]]));
  const immutableTransition = Object.fromEntries(Object.entries(transition).filter(([key]) =>
    !['state', 'revision', 'target_order_id', 'target_period_id', 'target_grant_id', 'cancel_command_id',
      'cancel_idempotency_key', 'cancel_request_sha256', 'cancelled_at', 'updated_at'].includes(key)));
  const accountingAssertions = [source.schemaAssertion, lifecycleSchemaAssertion(schema), rowAssertion('subscription_plan_transitions', immutableTransition),
    rowAssertion('subscription_payment_review_receipts', receipt), rowAssertion('subscription_billing_contracts', immutableContract),
    rowAssertion('payment_events', event), ...assertions.slice(-2)];
  if (transition.state === 'cancelled' && receipt.reason_code === 'package_monthly_transition_cancelled') {
    return Object.freeze({ receipt, assertions: Object.freeze(assertions), accountingAssertions: Object.freeze(accountingAssertions) });
  }
  if (!['scheduled', 'cancelled'].includes(transition.state) || receipt.reason_code !== 'package_monthly_transition_source_compensated')
    fail('package_monthly_retained_refund_transition_invalid');
  const paid = await db.prepare("SELECT * FROM payment_ledger WHERE ledger_entry_id=? AND entry_type='payment' AND direction='credit'")
    .bind(transition.source_payment_ledger_entry_id).first();
  const reversal = paid ? await db.prepare(`SELECT * FROM payment_ledger WHERE related_ledger_entry_id=? AND telegram_id=? AND currency='XTR'
    AND entry_type IN ('refund','chargeback') AND direction='debit' AND amount_stars=? AND telegram_payment_charge_id=? LIMIT 1`)
    .bind(paid.ledger_entry_id, original.telegram_id, paid.amount_stars, paid.telegram_payment_charge_id).first() : null;
  if (!paid || paid.telegram_id !== original.telegram_id || paid.currency !== 'XTR' || !reversal)
    fail('package_monthly_retained_refund_source_invalid');
  assertions.push(rowAssertion('payment_ledger', paid), rowAssertion('payment_ledger', reversal));
  accountingAssertions.push(rowAssertion('payment_ledger', paid), rowAssertion('payment_ledger', reversal));
  return Object.freeze({ receipt, assertions: Object.freeze(assertions), accountingAssertions: Object.freeze(accountingAssertions) });
}

// Advisory server-side summary only. This DTO is not an authorization token;
// the private actor resolver remains the sole issuer of paid capabilities.
export async function readPackageFinancialAccessSummary(env, telegramId, at) {
  const db = env?.DB;
  const schema = await inspectPackageSchema(schemaDatabase(db));
  if (!schema.present) return Object.freeze({ present: false, current: null, periods: [] });
  if (!positive(telegramId) || !positive(at)) fail('package_summary_subject_invalid');
  if (!await db.prepare('SELECT period_id FROM subscription_package_periods WHERE telegram_id=? LIMIT 1')
    .bind(telegramId).first()) return Object.freeze({ present: true, current: null, periods: [] });
  const source = {};
  for (const [key, table] of [['orders', 'subscription_orders'], ['payments', 'payment_ledger'],
    ['terms', 'terms_acceptances']]) {
    const result = await db.prepare(`SELECT * FROM ${table} WHERE telegram_id=? ORDER BY 1 LIMIT 129`)
      .bind(telegramId).all();
    if (result?.success !== true || !Array.isArray(result.results) || result.results.length > 128)
      fail('package_summary_read_failed');
    source[key] = result.results;
  }
  const prices = await db.prepare('SELECT * FROM price_book ORDER BY price_id LIMIT 129').all();
  if (prices?.success !== true || !Array.isArray(prices.results) || prices.results.length > 128)
    fail('package_summary_read_failed');
  const verified = await readPackageAccessDatabaseSource({ db, env, telegramId, nowSec: at,
    ...source, prices: prices.results });
  const current = verified.periods.filter(period => period.status === 'active' && period.startsAt <= at && period.endsAt > at);
  if (current.length > 1) fail('package_summary_overlapping_periods');
  return Object.freeze({ present: verified.present, current: current[0] ?? null, periods: verified.periods });
}

// Existing monthly access writers use this fence before their first projection
// mutation. Its in-transaction read closes renewal/package commit races; a
// genuine losing charge belongs in the existing retained-payment review path.
export async function preparePackageMonthlyIntervalFence(env, { telegramId, startsAt, endsAt, orderId, at, conflictCode }) {
  const db = env?.DB, schema = await inspectPackageSchema(schemaDatabase(db));
  if (!schema.present) return [];
  const access = await readPackageFinancialAccessSummary(env, telegramId, at);
  if (access.periods.some(period => period.status === 'active' && period.startsAt < endsAt && startsAt < period.endsAt))
    fail(conflictCode);
  const proof = packageSchemaAssertion(schema);
  const fence = db.prepare(`INSERT INTO payment_events(event_id,event_key,order_id,telegram_id,event_type,outcome,occurred_at,received_at)
    SELECT ?,NULL,?,?,'access_applied','error',?,? WHERE NOT (${proof.sql}) OR EXISTS (
      SELECT 1 FROM subscription_package_periods pp JOIN payment_ledger paid ON paid.ledger_entry_id=pp.payment_ledger_entry_id
      WHERE pp.telegram_id=? AND pp.starts_at<? AND pp.ends_at>? AND paid.telegram_id=pp.telegram_id
      AND paid.entry_type='payment' AND paid.direction='credit' AND paid.currency='XTR'
      AND NOT EXISTS(SELECT 1 FROM payment_ledger r WHERE r.related_ledger_entry_id=paid.ledger_entry_id AND r.entry_type IN ('refund','chargeback')))`) 
    .bind(crypto.randomUUID(), orderId, telegramId, at, at, ...proof.params, telegramId, endsAt, startsAt);
  return [fence];
}

// A scheduled sweep verifies bounded subjects through the same read-only
// package authority used by access summaries. There is no projection writer:
// start/end/refund take effect at read time from immutable periods and ledger.
export async function inspectPackageMaintenanceSubjects(env, { at, limit, readAccess }) {
  const db = env?.DB;
  const schema = await inspectPackageSchema(schemaDatabase(db));
  if (!schema.present) return Object.freeze({ scanned: 0, current: 0, hasMore: false });
  if (!positive(at) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || typeof readAccess !== 'function')
    fail('package_maintenance_request_invalid');
  const result = await db.prepare(`SELECT telegram_id,MIN(starts_at) first_start
    FROM subscription_package_periods WHERE starts_at<=? GROUP BY telegram_id
    ORDER BY first_start,telegram_id LIMIT ?`).bind(at, limit).all();
  if (result?.success !== true || !Array.isArray(result.results)) fail('package_maintenance_read_failed');
  let current = 0;
  for (const row of result.results) {
    const access = await readAccess(env, Number(row.telegram_id), at);
    if (access?.current) current++;
  }
  return Object.freeze({ scanned: result.results.length, current, hasMore: result.results.length === limit });
}
