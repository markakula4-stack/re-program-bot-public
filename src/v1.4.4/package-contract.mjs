import { STARS_CURRENCY, STARS_MONTH_SECONDS, STARS_TERMS_REVISION,
  verifyStarsInvoicePayload, normalizeServerPrice, selectServerPrice } from '../v1.3.6/stars-core-foundation.mjs';
import { readStarsRecurringConfig } from '../v1.4.3/recurring-provider-config.mjs';
import { readActorFacts, readActorContext, readLifecycleActorFacts,
  compileAuthorityAssertions,isVerifiedProviderInactiveExit } from '../v1.4.1/authority-resolver.mjs';
import { readTrustedContext } from '../v1.4.1/trusted-context.mjs';
import { readVerifiedLifecycleFacts } from '../v1.4.3/lifecycle-authority.mjs';
import { projectVerifiedRecurringControl } from '../v1.4.3/lifecycle-engine.mjs';
import { inspectPackageSchema, packageSchemaAssertion } from './package-schema.mjs';

// Opt-in v1.4.4 contract. The legacy 30-day resolver and its persisted money
// history are deliberately not widened by this module. No function here
// writes a ledger, grants access, calls Telegram or performs a refund.
export const PACKAGE_CONTRACT_VERSION = '2026-10-06.v1.4.4.p01';
export const PACKAGE_OFFER_VERSION = '2026-10-06.packages-v1';
export const PACKAGE_START_RULE = 'after_confirmed_payment_and_paid_residue';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const commandKey = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{16,160}$/.test(value);
const charge = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const PAID = new Set(['professional', 'dragon']);
export const PACKAGE_DURATIONS = freeze({
  '3m': { durationDays: 90, periodSeconds: 3 * STARS_MONTH_SECONDS },
  '6m': { durationDays: 180, periodSeconds: 6 * STARS_MONTH_SECONDS },
  '12m': { durationDays: 360, periodSeconds: 12 * STARS_MONTH_SECONDS },
});
export const PACKAGE_CANONICAL_PRICES = freeze({
  professional: { '30d': 249, '3m': 699, '6m': 1299, '12m': 2299 },
  dragon: { '30d': 499, '3m': 1399, '6m': 2599, '12m': 4499 },
});
export const PACKAGE_OWNER_TEST_OFFER = freeze({ priceId: 'professional-90d-owner-test-250-20261008', priceVersion: 3,
  planCode: 'professional', packageCode: '3m', durationDays: 90, periodSeconds: 7776000, amountStars: 250,
  currency: 'XTR', billingMode: 'prepaid', termsRevision: '2026-09-10.stars-v1', telegramId: 8987576334, botId: 8562951985,
  validFrom: 1791478800, validUntil: 1791579599, offerVersion: '2026-10-08.owner-test-250-v1', campaignCode: 'owner-test-250-20261008' });
const quotes = new WeakMap(), packageAuthorities = new WeakMap();
const enabled = value => value === true || value === 1 || value === '1' || value === 'true';
const version = value => typeof value === 'string' && /^[0-9A-Za-z._-]{8,64}$/.test(value);

export function readPackageContractConfig(env = {}) {
  const offerVersion = env.STARS_PACKAGE_OFFER_VERSION ?? PACKAGE_OFFER_VERSION;
  const termsRevision = env.STARS_PACKAGE_TERMS_REVISION ?? STARS_TERMS_REVISION;
  const priceVersion = Number(env.STARS_PACKAGE_PRICE_VERSION ?? 1);
  const campaignCode = env.STARS_PACKAGE_CAMPAIGN_CODE === undefined || env.STARS_PACKAGE_CAMPAIGN_CODE === ''
    ? null : env.STARS_PACKAGE_CAMPAIGN_CODE;
  if (!version(offerVersion) || !version(termsRevision) || !positive(priceVersion) ||
      campaignCode !== null && (typeof campaignCode !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(campaignCode)))
    fail('package_config_invalid');
  return freeze({ enabled: enabled(env.STARS_PACKAGES_ENABLED), ownerOnly: true,
    priceVersion, offerVersion, termsRevision, campaignCode,
    packages: { '3m': enabled(env.STARS_PACKAGE_3M_ENABLED),
      '6m': enabled(env.STARS_PACKAGE_6M_ENABLED), '12m': enabled(env.STARS_PACKAGE_12M_ENABLED) },
    economicsEvidence: digest(env.STARS_PACKAGE_ECONOMICS_EVIDENCE_SHA256),
    refundEvidence: digest(env.STARS_PACKAGE_REFUND_EVIDENCE_SHA256) });
}

function ownActor(actor, nowSec) {
  const facts = readActorFacts(actor);
  if (!positive(nowSec) || nowSec < facts.nowSeconds || nowSec >= facts.validUntil)
    fail('package_authority_expired');
  if (facts.actorKind !== 'customer' || !facts.canonicalOwner || !facts.account?.exists ||
      !facts.account.acceptedTerms || facts.account.isBlocked || facts.account.pendingDeletion ||
      !facts.financialSourceAvailable || !digest(facts.sourceFingerprint)) fail('package_owner_authority_required');
  return facts;
}

function packageGate(config, packageCode) {
  if (!Object.hasOwn(PACKAGE_DURATIONS, packageCode)) fail('package_code_invalid');
  if (!config.enabled || !config.packages[packageCode]) fail('package_disabled');
  if (packageCode !== '3m' && (!config.economicsEvidence || !config.refundEvidence))
    fail('package_economics_and_refund_evidence_required');
}

function ownerTestPrice(row) {
  const p = PACKAGE_OWNER_TEST_OFFER;
  return row && [['price_id','priceId'],['price_version','priceVersion'],['plan_code','planCode'],['currency','currency'],
    ['amount_stars','amountStars'],['access_seconds','periodSeconds'],['billing_mode','billingMode'],['terms_revision','termsRevision'],
    ['valid_from','validFrom'],['valid_until','validUntil']].every(([key, target]) => row[key] === p[target]);
}
function normalizePackagePrice(row, test = false) {
  const packageCode = Object.keys(PACKAGE_DURATIONS).find(code =>
    PACKAGE_DURATIONS[code].periodSeconds === row?.access_seconds);
  if (!PAID.has(row?.plan_code)) fail('package_price_plan_invalid');
  if (!packageCode || row.billing_mode !== 'prepaid') fail('package_price_period_invalid');
  if (row.currency !== STARS_CURRENCY || !positive(row.price_version) ||
      (test ? !ownerTestPrice(row) : row.amount_stars !== PACKAGE_CANONICAL_PRICES[row.plan_code][packageCode])) fail('package_price_amount_invalid');
  if (typeof row.price_id !== 'string' || !/^[a-z0-9][a-z0-9-]{10,95}$/.test(row.price_id) ||
      !version(row.terms_revision) || !['draft', 'approved', 'retired'].includes(row.publication_state) ||
      !positive(row.valid_from) || row.valid_until != null &&
      (!positive(row.valid_until) || row.valid_until <= row.valid_from)) fail('package_price_metadata_invalid');
  return freeze({ priceId: row.price_id, priceVersion: row.price_version,
    planCode: row.plan_code, packageCode, currency: STARS_CURRENCY, amountStars: row.amount_stars,
    ...PACKAGE_DURATIONS[packageCode], accessSeconds: row.access_seconds, billingMode: 'prepaid',
    termsRevision: row.terms_revision, publicationState: row.publication_state,
    validFrom: row.valid_from, validUntil: row.valid_until ?? null });
}
export const normalizeServerPackagePrice = row => normalizePackagePrice(row);

// Historical row recognition is data validation only. Actual DB reads,
// invoice HMAC and branded financial authority remain required by callers.
export function normalizeStoredServerPackagePrice(row, { order, metadata, botId } = {}) {
  if (row?.price_id !== PACKAGE_OWNER_TEST_OFFER.priceId) return normalizeServerPackagePrice(row);
  const p = PACKAGE_OWNER_TEST_OFFER;
  if (botId !== p.botId || !ownerTestPrice(row) || !order || !metadata || !uuid(order.order_id) ||
      order.telegram_id !== p.telegramId || metadata.telegram_id !== p.telegramId || metadata.order_id !== order.order_id ||
      metadata.contract_version !== PACKAGE_CONTRACT_VERSION || metadata.package_code !== p.packageCode ||
      metadata.duration_days !== p.durationDays || metadata.period_seconds !== p.periodSeconds ||
      metadata.offer_version !== p.offerVersion || metadata.campaign_code !== p.campaignCode ||
      !positive(order.created_at) || order.created_at < p.validFrom || order.created_at >= p.validUntil ||
      metadata.created_at !== order.created_at || !positive(metadata.quoted_starts_at) || metadata.quoted_starts_at < order.created_at ||
      metadata.quoted_ends_at !== metadata.quoted_starts_at + p.periodSeconds || !digest(metadata.source_fingerprint) ||
      [['price_id','priceId'],['price_version','priceVersion'],['plan_code','planCode'],['currency','currency'],
        ['amount_stars','amountStars'],['billing_mode','billingMode']].some(([key,target]) => order[key] !== p[target] || metadata[key] !== p[target]) ||
      order.access_seconds !== p.periodSeconds || order.terms_revision !== p.termsRevision) fail('package_owner_test_order_invalid');
  return normalizePackagePrice(row, true);
}

async function ownerTestRetry(source, identity, nowSec) {
  const p=PACKAGE_OWNER_TEST_OFFER;
  if(identity.telegramId!==p.telegramId || identity.botId!==p.botId || nowSec<p.validFrom || nowSec>=p.validUntil || source.testOrders.length!==1) return null;
  const prior=source.testOrders[0],o=prior.order,r=prior.journal,e=prior.events;
  if(o.order_state!=='created' || !positive(o.expires_at) || o.expires_at>nowSec || o.state_revision!==1 ||
    o.precheckout_approved_at!=null || o.paid_at!=null || o.applied_at!=null || o.closed_at!=null ||
    prior.ledgerCount!==0 || prior.periodCount!==0 || prior.reviewCount!==0 || r.state!=='confirmed' ||
    r.order_id!==o.order_id || r.telegram_id!==p.telegramId || !uuid(r.request_id) || r.attempted_count!==1 || r.revision!==3 || r.error_code!=='' ||
    !positive(r.created_at) || r.created_at<o.created_at || !positive(r.attempted_at) || r.attempted_at<r.created_at ||
    r.attempted_at>=o.expires_at || !positive(r.updated_at) || r.updated_at<r.attempted_at || r.updated_at>nowSec ||
    !/^https:\/\/t\.me\/\$[A-Za-z0-9_-]{8,256}$/u.test(r.invoice_url??'') || !digest(r.provider_result_sha256) ||
    !Array.isArray(e) || e.length!==2) return null;
  const payloadHash=await hash(o.invoice_payload);
  for(const [type,suffix,reason] of [['order_created','created','server_package_snapshot'],['invoice_issued','issued','telegram_package_invoice']]) {
    const matching=e.filter(event=>event.event_type===type);
    if(matching.length!==1) return null;
    const event=matching[0];
    if(event.order_id!==o.order_id || event.telegram_id!==p.telegramId || event.event_key!==`package:${o.order_id}:${suffix}` ||
      event.outcome!=='accepted' || event.reason_code!==reason || event.payload_sha256!==payloadHash ||
      !positive(event.occurred_at) || event.occurred_at<o.created_at || !positive(event.received_at) ||
      event.received_at<event.occurred_at || event.received_at>nowSec) return null;
  }
  if(await hash(JSON.stringify(r.invoice_url))!==r.provider_result_sha256) return null;
  const signed=await verifyStarsInvoicePayload({invoiceSecret:identity.env.STARS_INVOICE_SECRET,payload:o.invoice_payload,telegramId:p.telegramId,priceId:p.priceId});
  if(signed.orderId!==o.order_id) fail('package_order_signature_invalid');
  return prior;
}

export function readOwnerTestInvoiceRetry({actor,verifiedPackagePeriods,nowSec}={}) {
  ownActor(actor,nowSec);
  const proof=packageAuthorities.get(verifiedPackagePeriods);
  if(!proof || proof.actor!==actor) fail('untrusted_package_periods');
  return proof.retry;
}

export function selectServerPackagePrice({ actor, verifiedPackagePeriods, request, nowSec, retainedOrderId } = {}) {
  const facts = ownActor(actor, nowSec), identity = readTrustedContext(readActorContext(actor));
  if (!request || !same(Object.keys(request).sort(), ['packageCode', 'requestedPlanCode']) ||
      !PAID.has(request.requestedPlanCode)) fail('package_request_invalid');
  const proof = packageAuthorities.get(verifiedPackagePeriods);
  if (!proof || proof.actor !== actor) fail('untrusted_package_periods');
  const config = readPackageContractConfig(identity.env);
  packageGate(config, request.packageCode);
  const rows = proof.prices;
  if (!Array.isArray(rows) || rows.length > 128) fail('package_price_rows_invalid');
  const p = PACKAGE_OWNER_TEST_OFFER, ownTest = facts.telegramId === p.telegramId && identity.botId === p.botId &&
    request.requestedPlanCode === p.planCode && request.packageCode === p.packageCode && config.priceVersion === 2;
  const retained = retainedOrderId === undefined ? null : proof.testOrders.find(row => row.order.order_id === retainedOrderId);
  if (retainedOrderId !== undefined && !retained) fail('package_owner_test_order_invalid');
  // The temporary owner campaign is closed. New purchases use the canonical
  // price; only an already saved signed order can retain its original 250.
  if (retained) {
    if (!ownTest) fail('package_owner_test_order_invalid');
    const testRows = rows.filter(row => row.price_id === p.priceId);
    if (retained || testRows.length) {
      if (testRows.length !== 1) fail('package_price_unavailable');
      const price = retained ? normalizeStoredServerPackagePrice(testRows[0], { ...retained, botId: identity.botId })
        : normalizePackagePrice(testRows[0], true);
      if (!retained && price.publicationState !== 'approved') fail('package_price_unavailable');
      return price;
    }
  }
  const raw = rows.filter(row => row?.plan_code === request.requestedPlanCode &&
    row.billing_mode === 'prepaid' && row.access_seconds === PACKAGE_DURATIONS[request.packageCode].periodSeconds &&
    row.price_version === config.priceVersion && row.terms_revision === config.termsRevision);
  const candidates = raw.map(normalizeServerPackagePrice).filter(price => price.publicationState === 'approved' &&
    price.validFrom <= nowSec && (price.validUntil === null || price.validUntil > nowSec));
  if (candidates.length !== 1) fail(candidates.length ? 'package_price_ambiguous' : 'package_price_unavailable');
  return candidates[0];
}

// Each query is recorded as exact JSON and rechecked in the eventual atomic
// producer. A branded actor chooses DB/subject; caller JSON supplies neither.
// D1 permits at most 32 json_object arguments, so wide rows use json_patch.
const COLUMNS = freeze({
  subscription_package_periods: 'period_id order_id payment_ledger_entry_id telegram_id plan_code price_id price_version billing_mode starts_at ends_at period_seconds recorded_at transition_id',
  subscription_package_orders: 'order_id telegram_id contract_version plan_code package_code duration_days period_seconds quoted_starts_at quoted_ends_at price_id price_version offer_version campaign_code billing_mode currency amount_stars source_subscription_id source_package_period_id source_paid_until source_revision source_payment_ledger_entry_id source_fingerprint created_at',
  subscription_orders: 'order_id telegram_id price_id price_version plan_code currency amount_stars access_seconds billing_mode terms_revision invoice_payload order_state created_at paid_at applied_at',
  price_book: 'price_id price_version plan_code currency amount_stars access_seconds billing_mode publication_state terms_revision valid_from valid_until',
  payment_ledger: 'ledger_entry_id order_id telegram_id entry_type direction currency amount_stars telegram_payment_charge_id related_ledger_entry_id reason_code occurred_at recorded_at',
  terms_acceptances: 'acceptance_id telegram_id terms_revision acceptance_scope accepted_at',
  subscription_package_invoice_requests: 'request_id order_id telegram_id request_sha256 state attempted_count attempted_at invoice_url provider_result_sha256 error_code revision created_at updated_at',
  payment_events: 'event_id event_key order_id telegram_id telegram_update_id event_type outcome reason_code payload_sha256 occurred_at received_at',
});
function jsonRow(names, prefix = '') {
  const columns = names.split(' '), chunks = [];
  for (let index = 0; index < columns.length; index += 16)
    chunks.push(`json_object(${columns.slice(index, index + 16).map(name => `'${name}',${prefix}${name}`).join(',')})`);
  return chunks.reduce((left, right) => `json_patch(${left},${right})`);
}
const ownPeriods = 'SELECT order_id FROM subscription_package_periods WHERE telegram_id=?';

export async function resolveOwnPackagePeriodAuthority({ actor, nowSec } = {}) {
  const facts = ownActor(actor, nowSec), identity = readTrustedContext(readActorContext(actor));
  if (identity.telegramId !== facts.telegramId) fail('package_subject_mismatch');
  const schema = await inspectPackageSchema(identity.db, { required: true });
  const jobs = [
    ['periods', 'subscription_package_periods', 'telegram_id=?', 'period_id'],
    ['metadata', 'subscription_package_orders', `order_id IN (${ownPeriods})`, 'order_id'],
    ['orders', 'subscription_orders', `order_id IN (${ownPeriods})`, 'order_id'],
    ['testOrders', 'subscription_package_orders m LEFT JOIN subscription_orders o ON o.order_id=m.order_id LEFT JOIN subscription_package_invoice_requests r ON r.order_id=m.order_id AND r.telegram_id=m.telegram_id',
      `m.telegram_id=? AND m.price_id='${PACKAGE_OWNER_TEST_OFFER.priceId}'`, 'm.order_id'],
    ['prices', 'price_book', `price_id IN (SELECT price_id FROM subscription_package_periods WHERE telegram_id=?)
      OR (billing_mode='prepaid' AND access_seconds IN (7776000,15552000,31104000))
      OR (billing_mode='recurring' AND access_seconds=2592000)`, 'price_id'],
    ['ledger', 'payment_ledger', `ledger_entry_id IN (SELECT payment_ledger_entry_id FROM subscription_package_periods WHERE telegram_id=?)
      OR related_ledger_entry_id IN (SELECT payment_ledger_entry_id FROM subscription_package_periods WHERE telegram_id=?)`, 'ledger_entry_id'],
    ['terms', 'terms_acceptances', "telegram_id=? AND acceptance_scope='stars_purchase'", 'acceptance_id'],
  ];
  const captures = [], source = {};
  for (const [key, table, where, order] of jobs) {
    const params = table === 'payment_ledger' ? [facts.telegramId, facts.telegramId] : [facts.telegramId];
    const columns = key === 'testOrders' ? `json_object('metadata',json(${jsonRow(COLUMNS.subscription_package_orders, 'm.')}),
      'order',json(${jsonRow(COLUMNS.subscription_orders+' expires_at precheckout_approved_at state_revision closed_at updated_at', 'o.')}),
      'journal',json(${jsonRow(COLUMNS.subscription_package_invoice_requests,'r.')}),
      'ledgerCount',(SELECT COUNT(*) FROM payment_ledger WHERE order_id=m.order_id),
      'periodCount',(SELECT COUNT(*) FROM subscription_package_periods WHERE order_id=m.order_id),
      'reviewCount',(SELECT COUNT(*) FROM subscription_package_payment_reviews WHERE order_id=m.order_id),
      'events',json((SELECT json_group_array(json(event)) FROM (SELECT ${jsonRow(COLUMNS.payment_events)} AS event FROM payment_events
        WHERE order_id=m.order_id ORDER BY event_id LIMIT 3))))` : jsonRow(COLUMNS[table]);
    const sql = `SELECT COALESCE(json_group_array(json(snapshot)),'[]') AS snapshot FROM
      (SELECT ${columns} AS snapshot FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT 129)`;
    let result;
    try { result = await identity.db.prepare(sql).bind(...params).all(); }
    catch { fail('package_period_source_unavailable'); }
    if (result?.success !== true || result.results?.length !== 1 ||
        typeof result.results[0].snapshot !== 'string' || result.results[0].snapshot.length > 2_000_000)
      fail('package_period_source_unavailable');
    let rows; try { rows = JSON.parse(result.results[0].snapshot); } catch { fail('package_period_source_invalid'); }
    if (!Array.isArray(rows) || rows.length > 128) fail('package_period_source_overflow');
    source[key] = rows; captures.push({ sql, params, snapshot: result.results[0].snapshot });
  }
  for (const retained of source.testOrders) normalizeStoredServerPackagePrice(
    source.prices.find(row => row.price_id === PACKAGE_OWNER_TEST_OFFER.priceId), { ...retained, botId: identity.botId });
  const retry=await ownerTestRetry(source,identity,nowSec);
  const seenOrders = new Set(), seenPayments = new Set(), periods = [];
  for (const period of source.periods) {
    const order = source.orders.find(row => row.order_id === period.order_id);
    const metadata = source.metadata.find(row => row.order_id === period.order_id);
    const price = source.prices.find(row => row.price_id === period.price_id);
    const payment = source.ledger.find(row => row.ledger_entry_id === period.payment_ledger_entry_id);
    if (!id(period.period_id) || period.telegram_id !== facts.telegramId || !order || !metadata || !price || !payment ||
        seenOrders.has(period.order_id) || seenPayments.has(period.payment_ledger_entry_id)) fail('package_paid_period_binding_invalid');
    seenOrders.add(period.order_id); seenPayments.add(period.payment_ledger_entry_id);
    const normalized = price.access_seconds === STARS_MONTH_SECONDS ?
      freeze({ ...normalizeServerPrice(price), packageCode: '30d', durationDays: 30, periodSeconds: STARS_MONTH_SECONDS }) :
      normalizeStoredServerPackagePrice(price, { order, metadata, botId: identity.botId });
    if (order.telegram_id !== facts.telegramId || metadata.telegram_id !== facts.telegramId ||
        metadata.contract_version !== PACKAGE_CONTRACT_VERSION || metadata.plan_code !== order.plan_code ||
        payment.telegram_id !== facts.telegramId || period.plan_code !== order.plan_code ||
        period.plan_code !== normalized.planCode || period.price_id !== order.price_id ||
        period.price_version !== order.price_version || metadata.price_id !== order.price_id ||
        metadata.price_version !== order.price_version || period.price_version !== normalized.priceVersion ||
        period.billing_mode !== 'prepaid' || order.billing_mode !== 'prepaid' || metadata.billing_mode !== 'prepaid' ||
        order.currency !== 'XTR' || metadata.currency !== 'XTR' || payment.currency !== 'XTR' ||
        order.amount_stars !== normalized.amountStars || metadata.amount_stars !== order.amount_stars ||
        payment.amount_stars !== order.amount_stars || order.access_seconds !== normalized.periodSeconds ||
        metadata.period_seconds !== normalized.periodSeconds || metadata.duration_days !== normalized.durationDays ||
        metadata.package_code !== normalized.packageCode || period.period_seconds !== normalized.periodSeconds ||
        !version(metadata.offer_version) || !digest(metadata.source_fingerprint) ||
        metadata.campaign_code !== null && (typeof metadata.campaign_code !== 'string' ||
          !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(metadata.campaign_code)) ||
        !['paid', 'applied', 'refunded', 'chargeback'].includes(order.order_state) ||
        payment.order_id !== order.order_id || payment.entry_type !== 'payment' || payment.direction !== 'credit' ||
        payment.related_ledger_entry_id !== null || payment.reason_code !== 'successful_payment' ||
        !charge(payment.telegram_payment_charge_id) ||
        !positive(payment.occurred_at) || !positive(payment.recorded_at) || payment.occurred_at > payment.recorded_at ||
        payment.recorded_at > nowSec || !positive(period.recorded_at) || period.recorded_at < payment.recorded_at ||
        period.recorded_at > nowSec || !positive(metadata.quoted_starts_at) ||
        metadata.quoted_ends_at !== metadata.quoted_starts_at + normalized.periodSeconds ||
        !positive(period.starts_at) || period.starts_at !== Math.max(metadata.quoted_starts_at, payment.occurred_at) ||
        period.ends_at !== period.starts_at + normalized.periodSeconds || !Number.isSafeInteger(period.ends_at) ||
        order.terms_revision !== normalized.termsRevision || normalized.validFrom > order.created_at ||
        normalized.validUntil !== null && normalized.validUntil <= order.created_at ||
        !source.terms.some(row => row.telegram_id === facts.telegramId && row.terms_revision === order.terms_revision &&
          positive(row.accepted_at) && row.accepted_at <= order.created_at)) fail('package_paid_period_evidence_invalid');
    const verifiedPayload = await verifyStarsInvoicePayload({ invoiceSecret: identity.env.STARS_INVOICE_SECRET,
      payload: order.invoice_payload, telegramId: facts.telegramId, priceId: order.price_id });
    if (verifiedPayload.orderId !== order.order_id) fail('package_paid_period_binding_invalid');
    const reversals = source.ledger.filter(row => row.related_ledger_entry_id === payment.ledger_entry_id);
    if (reversals.length > 1 || reversals.some(row => row.telegram_id !== facts.telegramId ||
        !['refund', 'chargeback'].includes(row.entry_type) || row.direction !== 'debit' ||
        row.currency !== payment.currency || row.amount_stars !== payment.amount_stars ||
        row.telegram_payment_charge_id !== payment.telegram_payment_charge_id || !positive(row.occurred_at) ||
        !positive(row.recorded_at) || row.occurred_at < payment.occurred_at || row.occurred_at > row.recorded_at ||
        row.recorded_at > nowSec)) fail('package_compensation_evidence_invalid');
    const status = reversals[0]?.entry_type === 'chargeback' ? 'chargeback' : reversals.length ? 'refunded' : 'active';
    if ((order.order_state === 'refunded' && status !== 'refunded') ||
        (order.order_state === 'chargeback' && status !== 'chargeback')) fail('package_compensation_evidence_invalid');
    periods.push({ periodId: period.period_id, orderId: order.order_id, ledgerEntryId: payment.ledger_entry_id,
      telegramId: facts.telegramId, planCode: period.plan_code, packageCode: normalized.packageCode,
      priceId: normalized.priceId, priceVersion: normalized.priceVersion, offerVersion: metadata.offer_version,
      campaignCode: metadata.campaign_code, billingMode: 'prepaid', amountStars: payment.amount_stars,
      startsAt: period.starts_at, endsAt: period.ends_at, recordedAt: period.recorded_at,
      sourceKind: 'package_payment', status });
  }
  const active = periods.filter(row => row.status === 'active').sort((a, b) => a.startsAt - b.startsAt);
  for (let index = 1; index < active.length; index++)
    if (active[index].startsAt < active[index - 1].endsAt) fail('package_paid_period_overlap');
  if (active.some(row => row.endsAt > nowSec)) assertRecurringExitConfirmed({ actor, nowSec });
  const token = Object.freeze({ version: 1, authority: 'verified_package_periods' });
  // This is the immutable quote's paid-boundary identity, not the broader
  // actor/read transaction identity. Creating its own pending invoice or
  // precheckout receipt must not stale a quote. Exact captures remain in the
  // atomic assertion compiler below; only verified financial/control facts
  // participate in this stable identity.
  const lifecycle = readVerifiedLifecycleFacts(readLifecycleActorFacts(actor));
  const sourceFingerprint = await hash(JSON.stringify({ domain: 'v1.4.4.package-financial-boundary.v1',
    telegramId: facts.telegramId, accountFingerprint: facts.accountFingerprint,
    ordinaryPeriods: lifecycle.periods.filter(row => row.sourceKind !== 'package_payment'),
    ordinarySubscriptions: lifecycle.subscriptions.filter(row => row.sourceKind !== 'package_payment' &&
      !String(row.subscription_id).startsWith('package:')),
    contracts: lifecycle.contracts, providerEvents: lifecycle.providerEvents,
    commands: lifecycle.commands, reviewResolutions: lifecycle.reviewResolutions,
    packagePeriods: periods }));
  packageAuthorities.set(token, { actor, periods: freeze(periods), prices: freeze(source.prices), testOrders: freeze(source.testOrders), retry,
    captures, sourceFingerprint, schemaAssertion: packageSchemaAssertion(schema) });
  return token;
}

export function readVerifiedPackagePeriods(token) {
  const proof = packageAuthorities.get(token);
  if (!proof) fail('untrusted_package_periods');
  return proof.periods;
}
export function compilePackagePeriodAssertions(token) {
  const proof = packageAuthorities.get(token);
  if (!proof) fail('untrusted_package_periods');
  return freeze({ assertions: [...compileAuthorityAssertions(proof.actor).assertions, proof.schemaAssertion,
    ...proof.captures.map(capture => ({ sql: `(${capture.sql}) IS ?`, params: [...capture.params, capture.snapshot] }))] });
}

export function projectPackagePaidBoundary({ actor, verifiedPackagePeriods, nowSec } = {}) {
  const principal = ownActor(actor, nowSec), proof = packageAuthorities.get(verifiedPackagePeriods);
  if (!proof || proof.actor !== actor) fail('untrusted_package_periods');
  const facts = readVerifiedLifecycleFacts(readLifecycleActorFacts(actor));
  if (facts.telegramId !== principal.telegramId || facts.reviewRequired || facts.administrativelySuspended ||
      facts.chargebackSuspended || proof.periods.some(row => row.status === 'chargeback')) fail('package_paid_source_review_required');
  // The existing authority has already projected prepaid refund compaction
  // and earned referral slices. Never infer paid time from subscription heads,
  // previews, manual plan overrides, scheduled intentions or unpaid renewals.
  const ordinary = facts.periods.filter(row => row.status === 'active' && row.sourceKind !== 'package_payment');
  const future = proof.periods.filter(row => row.status === 'active');
  const combined = [...ordinary, ...future];
  for (const row of combined) if (!positive(row.startsAt) || !positive(row.endsAt) || row.endsAt <= row.startsAt)
    fail('package_paid_source_review_required');
  const realOrdinary = ordinary.filter(row => row.sourceKind === 'payment');
  if (future.some(row => realOrdinary.some(old => old.ledgerEntryId === row.ledgerEntryId)))
    fail('package_paid_period_duplicate_source');
  if (future.some(row => ordinary.some(old => row.startsAt < old.endsAt && old.startsAt < row.endsAt)))
    fail('package_paid_period_overlap');
  const current = combined.filter(row => row.startsAt <= nowSec && row.endsAt > nowSec);
  const currentPlans = new Set(current.map(row => row.planCode));
  if (currentPlans.size > 1) fail('package_current_plan_conflict');
  const retained = combined.filter(row => row.endsAt > nowSec);
  const last = retained.sort((a, b) => b.endsAt - a.endsAt || a.ledgerEntryId.localeCompare(b.ledgerEntryId))[0] ?? null;
  const lastPayment = [...realOrdinary, ...future].filter(row => row.endsAt > nowSec)
    .sort((a, b) => b.endsAt - a.endsAt)[0] ?? null;
  const subscription = facts.subscriptions.find(row => row.subscription_id === (last?.subscriptionId ?? lastPayment?.subscriptionId));
  // A standalone earned referral period has no paid order/ledger FK. It still
  // delays the next package, but must not be serialized as a paid subscription.
  const paidSourceSubscription = subscription && realOrdinary.some(row =>
    row.subscriptionId === subscription.subscription_id) ? subscription : null;
  let currentPaidUntil = current.length ? Math.max(...current.map(row => row.endsAt)) : null;
  if (currentPaidUntil !== null) {
    let prior; do { prior = currentPaidUntil;
      for (const row of retained) if (row.startsAt <= currentPaidUntil && row.endsAt > currentPaidUntil) currentPaidUntil = row.endsAt;
    } while (prior !== currentPaidUntil);
  }
  return freeze({ telegramId: principal.telegramId, currentPlanCode: [...currentPlans][0] ?? 'free',
    paidAccess: current.length > 0, currentPaidUntil,
    sourcePaidUntil: last?.periodId || paidSourceSubscription ? last?.endsAt ?? null : null,
    nextAvailableAt: Math.max(nowSec, last?.endsAt ?? nowSec),
    sourceSubscriptionId: last?.periodId ? null : paidSourceSubscription?.subscription_id ?? null,
    sourcePackagePeriodId: last?.periodId ?? null,
    sourceRevision: last?.periodId ? 1 : paidSourceSubscription?.revision ?? null,
    sourcePaymentLedgerEntryId: lastPayment?.ledgerEntryId ?? null,
    sourcePlanCode: last?.planCode ?? null,
    sourceBillingMode: last?.periodId ? 'prepaid' : paidSourceSubscription?.billing_mode ?? null,
    sourceFingerprint: proof.sourceFingerprint,
    nextPaidPlan: future.filter(row => row.startsAt > nowSec).sort((a, b) => a.startsAt - b.startsAt)[0]?.planCode ?? null,
    paidFuturePeriods: future.filter(row => row.startsAt > nowSec).length,
    scheduledIntentGrantsAccess: false });
}

export function assertRecurringExitConfirmed({ actor, nowSec } = {}) {
  ownActor(actor, nowSec);
  const token = readLifecycleActorFacts(actor), facts = readVerifiedLifecycleFacts(token);
  const contracts = facts.contracts.filter(row => row.retired_at === null);
  if (!contracts.length) return freeze({ required: false, confirmed: true, contractId: null, revision: null });
  if (contracts.length !== 1 || facts.reviewRequired) fail('package_recurring_contract_conflict');
  const contract = contracts[0], lifecycle = projectVerifiedRecurringControl({
    verifiedFacts: token, contractId: contract.contract_id, nowSec });
  if(lifecycle.renewalState==='inactive'&&lifecycle.pendingOperations===0&&lifecycle.reviewReasons.length===0&&
      facts.providerInactiveExits?.some(proof=>isVerifiedProviderInactiveExit(proof,contract,nowSec)))
    return freeze({required:true,confirmed:false,inactive:true,contractId:contract.contract_id,revision:contract.revision});
  const acknowledged = facts.commands.filter(command => command.contract_id === contract.contract_id &&
    command.telegram_id === facts.telegramId && command.state === 'confirmed' && command.action === 'cancel_renewal' &&
    command.desired_auto_renew === 0 && command.expected_contract_revision === contract.revision &&
    command.first_payment_ledger_entry_id === contract.first_payment_ledger_entry_id &&
    facts.providerEvents.some(event => event.event_id === command.acknowledgement_event_id &&
      event.command_id === command.command_id && event.contract_id === contract.contract_id &&
      event.telegram_id === facts.telegramId && event.event_type === 'command_confirmed' && event.source === 'provider_response'));
  if (lifecycle.contractId !== contract.contract_id || lifecycle.renewalState !== 'canceled' ||
      lifecycle.pendingOperations !== 0 || !acknowledged.length || lifecycle.reviewReasons.some(reason =>
        ['provider_update_identity_conflict', 'provider_update_receipt_without_fact', 'control_identity_conflict',
          'provider_command_order_ambiguous', 'provider_command_ack_order_ambiguous'].includes(reason)))
    fail('package_recurring_cancellation_unconfirmed');
  return freeze({ required: true, confirmed: true, contractId: contract.contract_id, revision: contract.revision });
}

function serverQuote({ actor, price, verifiedPackagePeriods, nowSec, retainedOrderId }) {
  const principal = ownActor(actor, nowSec);
  const config = readPackageContractConfig(readTrustedContext(readActorContext(actor)).env);
  const boundary = projectPackagePaidBoundary({ actor, verifiedPackagePeriods, nowSec });
  const quotedStartsAt = boundary.nextAvailableAt, quotedEndsAt = quotedStartsAt + price.periodSeconds;
  if (!Number.isSafeInteger(quotedEndsAt)) fail('package_clock_overflow');
  const quote = freeze({ contractVersion: PACKAGE_CONTRACT_VERSION, telegramId: principal.telegramId,
    packageCode: price.packageCode, planCode: price.planCode, durationDays: price.durationDays,
    periodSeconds: price.periodSeconds, priceId: price.priceId, priceVersion: price.priceVersion,
    amountStars: price.amountStars, currency: 'XTR', billingMode: price.billingMode, termsRevision: price.termsRevision,
    offerVersion: price.priceId === PACKAGE_OWNER_TEST_OFFER.priceId ? PACKAGE_OWNER_TEST_OFFER.offerVersion : config.offerVersion,
    campaignCode: price.priceId === PACKAGE_OWNER_TEST_OFFER.priceId ? PACKAGE_OWNER_TEST_OFFER.campaignCode : config.campaignCode, quotedStartsAt, quotedEndsAt,
    startRule: PACKAGE_START_RULE, quotedDatesAreEstimate: true,
    sourceSubscriptionId: boundary.sourceSubscriptionId, sourcePaidUntil: boundary.sourcePaidUntil,
    sourcePackagePeriodId: boundary.sourcePackagePeriodId,
    sourceRevision: boundary.sourceRevision, sourcePaymentLedgerEntryId: boundary.sourcePaymentLedgerEntryId,
    sourcePlanCode: boundary.sourcePlanCode, sourceBillingMode: boundary.sourceBillingMode,
    sourceFingerprint: boundary.sourceFingerprint, currentPlanCode: boundary.currentPlanCode,
    nextPaidPlan: boundary.nextPaidPlan, automaticProration: false, recurringConsentTransferred: false,
    accessApplied: false, createdAt: nowSec, validUntil: Math.min(principal.validUntil, nowSec + 900,
      price.priceId === PACKAGE_OWNER_TEST_OFFER.priceId && !retainedOrderId ? price.validUntil : Infinity) });
  quotes.set(quote, { actor, verifiedPackagePeriods });
  return quote;
}
export function createServerPackageQuote({ actor, request, verifiedPackagePeriods, nowSec, retainedOrderId } = {}) {
  const price = selectServerPackagePrice({ actor, verifiedPackagePeriods, request, nowSec, retainedOrderId });
  return serverQuote({ actor, price, verifiedPackagePeriods, nowSec, retainedOrderId });
}
export function createServerMonthlyTransitionQuote({ actor, verifiedPackagePeriods, request, nowSec } = {}) {
  ownActor(actor, nowSec);
  const proof = packageAuthorities.get(verifiedPackagePeriods);
  if (!proof || proof.actor !== actor) fail('untrusted_package_periods');
  if (!request || !same(Object.keys(request).sort(), ['requestedPlanCode']) || !PAID.has(request.requestedPlanCode))
    fail('package_request_invalid');
  const env = readTrustedContext(readActorContext(actor)).env;
  if (!readPackageContractConfig(env).enabled) fail('package_disabled');
  const price = selectServerPrice(proof.prices, request.requestedPlanCode, readStarsRecurringConfig(env), nowSec);
  if (price.amountStars !== PACKAGE_CANONICAL_PRICES[price.planCode]['30d']) fail('package_price_amount_invalid');
  return serverQuote({ actor, price: { ...price, packageCode: '30d', durationDays: 30,
    periodSeconds: STARS_MONTH_SECONDS }, verifiedPackagePeriods, nowSec });
}

export function assertPackageQuoteAdmissible({ quote, actor, nowSec } = {}) {
  const proof = quotes.get(quote);
  if (!proof || proof.actor !== actor) fail('untrusted_package_quote');
  ownActor(actor, nowSec);
  if (nowSec >= quote.validUntil) fail('package_quote_expired');
  if (quote.billingMode === 'recurring' && nowSec < quote.quotedStartsAt)
    fail('package_monthly_invoice_not_due');
  const boundary = projectPackagePaidBoundary({ actor, verifiedPackagePeriods: proof.verifiedPackagePeriods, nowSec });
  if (boundary.sourceFingerprint !== quote.sourceFingerprint ||
      boundary.nextAvailableAt > Math.max(quote.quotedStartsAt, nowSec)) fail('package_quote_source_changed');
  return assertRecurringExitConfirmed({ actor, nowSec });
}

// Scheduled changes are intentions only. For a target monthly recurring
// contract, Telegram cannot defer its first charge: Part 2 must create a fresh
// invoice with fresh explicit consent at/after effectiveAt, never future_start.
export function monthlyTransitionEligibility({ actor, verifiedPackagePeriods, nowSec, targetPlanCode } = {}) {
  if (!PAID.has(targetPlanCode)) fail('package_target_plan_invalid');
  const boundary = projectPackagePaidBoundary({ actor, verifiedPackagePeriods, nowSec });
  const cancellation = assertRecurringExitConfirmed({ actor, nowSec });
  return freeze({ targetPlanCode, effectiveAt: boundary.nextAvailableAt,
    invoiceEligibleNow: nowSec >= boundary.nextAvailableAt, freshConsentRequired: true,
    providerPeriodSeconds: STARS_MONTH_SECONDS, providerFutureStartSupported: false,
    cancellationConfirmed: cancellation.confirmed, accessApplied: false });
}

function transitionShape(row) {
  if (!row || !uuid(row.transitionId) || !commandKey(row.idempotencyKey) || !digest(row.requestHash) ||
      !positive(row.telegramId) || !['free', 'professional', 'dragon'].includes(row.fromPlan) || !PAID.has(row.toPlan) ||
      !['30d', ...Object.keys(PACKAGE_DURATIONS)].includes(row.targetPackageCode) || !id(row.targetPriceId) ||
      !positive(row.effectiveAt) || !positive(row.revision) || !['scheduled', 'cancelled', 'fulfilled'].includes(row.state))
    fail('package_transition_invalid');
  return row;
}
export function planScheduledPackageTransition({ quote, actor, nowSec, transitionId, idempotencyKey,
  requestHash, previous = null } = {}) {
  if (!quotes.has(quote) || quotes.get(quote).actor !== actor) fail('untrusted_package_quote');
  ownActor(actor, nowSec);
  if (!uuid(transitionId) || !commandKey(idempotencyKey) || !digest(requestHash)) fail('package_schedule_identity_invalid');
  if (previous) {
    transitionShape(previous);
    if (previous.telegramId !== quote.telegramId) fail('package_transition_foreign_actor');
    if (previous.idempotencyKey === idempotencyKey) {
      if (previous.requestHash !== requestHash || previous.toPlan !== quote.planCode ||
          previous.toBillingMode !== quote.billingMode || previous.targetPriceVersion !== quote.priceVersion ||
          previous.targetPackageCode !== quote.packageCode || previous.targetPriceId !== quote.priceId)
        fail('package_schedule_idempotency_collision');
      return freeze({ transition: { ...previous }, replayed: true, accessApplied: false });
    }
    if (previous.state === 'scheduled') fail('package_transition_already_scheduled');
  }
  if (!PAID.has(quote.sourcePlanCode) || !positive(quote.sourcePaidUntil) || quote.sourcePaidUntil <= nowSec ||
      !quote.sourcePaymentLedgerEntryId) fail('package_schedule_paid_source_required');
  if (nowSec >= quote.validUntil) fail('package_quote_expired');
  return freeze({ transition: { transitionId, telegramId: quote.telegramId, idempotencyKey, requestHash,
    fromPlan: quote.sourcePlanCode, toPlan: quote.planCode, targetPackageCode: quote.packageCode,
    targetPriceId: quote.priceId, offerVersion: quote.offerVersion, campaignCode: quote.campaignCode,
    sourceSubscriptionId: quote.sourceSubscriptionId, sourcePaidUntil: quote.sourcePaidUntil,
    sourcePackagePeriodId: quote.sourcePackagePeriodId, sourcePaymentLedgerEntryId: quote.sourcePaymentLedgerEntryId,
    contractVersion: PACKAGE_CONTRACT_VERSION, fromBillingMode: quote.sourceBillingMode,
    toBillingMode: quote.billingMode, targetPriceVersion: quote.priceVersion, periodSeconds: quote.periodSeconds,
    sourceRevision: quote.sourceRevision, sourceFingerprint: quote.sourceFingerprint,
    effectiveAt: quote.quotedStartsAt, state: 'scheduled', revision: 1,
    targetOrderId: null, targetPeriodId: null, targetGrantId: null,
    cancelCommandId: null, cancelIdempotencyKey: null, cancelRequestHash: null,
    cancelledAt: null, createdAt: nowSec, updatedAt: nowSec }, replayed: false, accessApplied: false });
}
export function cancelScheduledPackageTransition({ actor, nowSec, transition, expectedRevision,
  commandId, idempotencyKey, requestHash } = {}) {
  const principal = ownActor(actor, nowSec), prior = transitionShape(transition);
  if (prior.telegramId !== principal.telegramId) fail('package_transition_foreign_actor');
  if (!positive(expectedRevision) || !uuid(commandId) || !commandKey(idempotencyKey) || !digest(requestHash))
    fail('package_cancel_identity_invalid');
  if (prior.state === 'cancelled') {
    if (prior.cancelCommandId !== commandId || prior.cancelIdempotencyKey !== idempotencyKey ||
        prior.cancelRequestHash !== requestHash || expectedRevision !== prior.revision - 1)
      fail('package_cancel_idempotency_collision');
    return freeze({ transition: { ...prior }, replayed: true, accessApplied: false, refundApplied: false });
  }
  if (prior.state === 'fulfilled' || prior.targetPeriodId !== null || prior.targetGrantId !== null)
    fail('package_transition_already_paid');
  if (prior.revision !== expectedRevision) fail('package_cancel_revision_changed');
  if (!Number.isSafeInteger(prior.revision + 1)) fail('package_cancel_revision_changed');
  return freeze({ transition: { ...prior, state: 'cancelled', revision: prior.revision + 1,
    cancelCommandId: commandId, cancelIdempotencyKey: idempotencyKey, cancelRequestHash: requestHash,
    cancelledAt: nowSec, updatedAt: nowSec }, replayed: false, accessApplied: false, refundApplied: false });
}
