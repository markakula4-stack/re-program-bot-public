import { readRuntimeAuthorization, requireRuntimeAuthorization, runtimeAuthorizationDTO } from '../v1.4.1/runtime-authorizer.mjs';
import { readTrustedContext, compileContextAssertions } from '../v1.4.1/trusted-context.mjs';
import { readActorFacts, readLifecycleActorFacts, compileAuthorityAssertions } from '../v1.4.1/authority-resolver.mjs';
import { readVerifiedLifecycleFacts } from '../v1.4.3/lifecycle-authority.mjs';
import { readCabinetAdminGate } from '../v1.4.0-rebuild/cabinet-participants.mjs';
import { releaseAdminFence } from '../v1.4.0-rebuild/release-lease.mjs';
import { sha256Hex } from '../v1.4.0-rebuild/mini-app-security.mjs';
import { STARS_MONTH_SECONDS, STARS_TERMS_REVISION, readStarsCoreConfig, verifyStarsInvoicePayload } from '../v1.3.6/stars-core-foundation.mjs';
import { readStarsRecurringConfig, STARS_RECURRING_TERMS_REVISION } from '../v1.4.3/recurring-provider-config.mjs';
import { STARS_PURCHASE_LOCK_SQL } from '../v1.4.3/payment-evidence.mjs';
import { readPackageContractConfig, PACKAGE_DURATIONS, resolveOwnPackagePeriodAuthority,
  readVerifiedPackagePeriods, compilePackagePeriodAssertions, createServerPackageQuote,
  createServerMonthlyTransitionQuote, assertRecurringExitConfirmed, normalizeStoredServerPackagePrice } from './package-contract.mjs';
import { inspectPackagePaymentReviewSchema, packagePaymentReviewSchemaAssertion } from './package-schema.mjs';
import { buildPackageOfferTerms, packageConfirmationPayloadHash } from './package-confirmation.mjs';

export const PACKAGE_READ_MODEL_VERSION = '2026-10-07.v1.4.4.p03';
const fail = (code, status = 503) => { throw Object.assign(new Error(code), { code, status }); };
const reason = error => /^[a-z][a-z0-9_]{0,95}$/u.test(error?.code ?? '') ? error.code : 'package_read_unavailable';
const positive = value => Number.isSafeInteger(value) && value > 0;
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) {
  Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const route = (path, available, reasonCode = null, details = {}) => ({ available, reasonCode: available ? null : reasonCode,
  route: '/packages/' + path, actionAdmissionRequired: true, ...details });
const paidState = (period, now) => ['refunded', 'chargeback'].includes(period.status) ? period.status :
  period.startsAt > now ? 'future' : period.endsAt <= now ? 'expired' : 'current';
const ownReceiptId = (telegramId, ledgerEntryId) => sha256Hex(`v1.4.3.own-receipt\n${telegramId}\n${ledgerEntryId}`)
  .then(value => 'stars-' + value.slice(0, 24));

// Exact package metadata comes from the private canonical lifecycle source.
// This helper issues no access, capability or payment authority.
export function packageHistoryMetadata(period, now) {
  if (period?.sourceKind !== 'package_payment' || !positive(period.startsAt) || !positive(period.endsAt) ||
      period.endsAt <= period.startsAt || !['3m','6m','12m'].includes(period.packageCode)) return null;
  return freeze({ packageCode: period.packageCode, durationDays: (period.endsAt - period.startsAt) / 86400,
    accessState: paidState(period, now), startsAt: period.startsAt, endsAt: period.endsAt });
}

function capturedReads(db) {
  const captures = [], preloaded = new Map();
  return { async preload(jobs) {
    if (!Array.isArray(jobs) || !jobs.length || jobs.length > 12) fail('package_read_limit');
    const params = [], projections = jobs.map(([sql, values, keys], index) => {
      if (!/^\s*SELECT\b/iu.test(sql) || sql.includes(';') || sql.length > 8192 || values.length > 32 ||
          !keys.length || keys.some(key => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key))) fail('package_read_limit');
      let row = "json('{}')";
      for (let start = 0; start < keys.length; start += 15) row = `json_set(${row},${keys.slice(start,start+15)
        .flatMap(key => [`'$.${key}'`,`source.${key}`]).join(',')})`;
      params.push(...values);
      return `(SELECT COALESCE(json_group_array(json(snapshot)),'[]') FROM
        (SELECT ${row} AS snapshot FROM (${sql}) AS source)) AS package_snapshot_${index}`;
    });
    // D1 limits compound SELECT terms more tightly than local SQLite. Scalar
    // projections preserve one read and the exact per-source snapshots without
    // depending on a seven-branch UNION or adding authorization-budget reads.
    const sql = 'SELECT ' + projections.join(',');
    if (params.length > 99 || sql.length > 90_000) fail('package_read_limit');
    let result; try { result = await db.prepare(sql).bind(...params).all(); } catch { fail('package_read_unavailable'); }
    if (result?.success !== true || !Array.isArray(result.results) || result.results.length !== 1) fail('package_read_unavailable');
    const item = result.results[0], expectedKeys = jobs.map((_, index) => `package_snapshot_${index}`);
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== expectedKeys.length ||
        Object.keys(item).some(key => !expectedKeys.includes(key))) fail('package_read_unavailable');
    for (const [index, key] of expectedKeys.entries()) {
      const snapshot = item[key];
      if (typeof snapshot !== 'string' || new TextEncoder().encode(snapshot).length > 1_000_000)
        fail('package_read_unavailable');
      let rows; try { rows = JSON.parse(snapshot); } catch { fail('package_read_unavailable'); }
      if (!Array.isArray(rows) || rows.length > 128) fail('package_read_unavailable');
      preloaded.set(JSON.stringify([jobs[index][0],jobs[index][1]]), rows);
    }
  }, async rows(sql, params = []) {
    if (!/^\s*SELECT\b/iu.test(sql) || sql.includes(';') || sql.length > 8192 || params.length > 32 || captures.length >= 12)
      fail('package_read_limit');
    let result;
    const cached = preloaded.get(JSON.stringify([sql,params]));
    if (cached) result = { success: true, results: cached };
    else try { result = await db.prepare(sql).bind(...params).all(); } catch { fail('package_read_unavailable'); }
    if (result?.success !== true || !Array.isArray(result.results) || result.results.length > 128 ||
        new TextEncoder().encode(JSON.stringify(result.results)).length > 1_000_000) fail('package_read_unavailable');
    captures.push({ sql, params, snapshot: JSON.stringify(result.results) }); return result.results;
  }, async assertFresh(proofs = []) {
    const conditions = [...proofs];
    for (const capture of captures) {
      const rows = JSON.parse(capture.snapshot), keys = Object.keys(rows[0] ?? {});
      if (!keys.length) conditions.push({ sql: `NOT EXISTS(${capture.sql})`, params: capture.params });
      else {
        if (keys.some(key => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key))) fail('package_read_source_invalid');
        let row = "json('{}')";
        for (let index = 0; index < keys.length; index += 15) row = `json_set(${row},${keys.slice(index,index+15)
          .flatMap(key => [`'$.${key}'`,`source.${key}`]).join(',')})`;
        conditions.push({ sql: `(SELECT COALESCE(json_group_array(json(snapshot)),'[]') FROM
          (SELECT ${row} AS snapshot FROM (${capture.sql}) AS source)) IS ?`, params: [...capture.params, capture.snapshot] });
      }
    }
    // Every source comparison remains exact. Packing compatible SELECT
    // predicates saves request queries without relaxing D1's parameter/SQL
    // bounds or increasing the accepted subscription read budget.
    const groups = []; let group = { sql: [], params: [] };
    for (const condition of conditions) {
      if (condition.params.length > 99 || condition.sql.length > 90_000) fail('package_read_source_invalid');
      if (group.params.length + condition.params.length > 99 || group.sql.join(' AND ').length + condition.sql.length > 90_000) {
        groups.push(group); group = { sql: [], params: [] };
      }
      group.sql.push(`(${condition.sql})`); group.params.push(...condition.params);
    }
    if (group.sql.length) groups.push(group);
    const statements = groups.map(item => db.prepare(`SELECT CASE WHEN ${item.sql.join(' AND ')} THEN 1 ELSE 0 END AS allowed`).bind(...item.params));
    const results = await db.batch(statements);
    if (!Array.isArray(results) || results.length !== statements.length || results.some(result =>
      result?.success !== true || !Array.isArray(result.results) || result.results.length !== 1 || result.results[0].allowed !== 1))
      fail('package_read_stale', 409);
  } };
}
const TRANSITION_COLUMNS = 'transition_id telegram_id from_plan from_billing_mode to_plan to_billing_mode target_package_code target_price_id target_price_version period_seconds offer_version campaign_code source_paid_until effective_at state revision target_order_id target_period_id target_grant_id source_payment_ledger_entry_id'.split(' ');
const transitionSql = `SELECT ${TRANSITION_COLUMNS.join(',')} FROM subscription_plan_transitions
  WHERE telegram_id=? ORDER BY effective_at DESC,transition_id LIMIT 129`;
const reservationSql = `SELECT m.transition_id,m.order_id,m.plan_code,m.price_id,m.price_version,m.currency,m.amount_stars,
  m.period_seconds,o.order_state,o.expires_at,o.terms_revision,o.precheckout_approved_at,
  r.state AS invoice_state,r.invoice_url,
  EXISTS(SELECT 1 FROM payment_ledger p WHERE p.order_id=o.order_id AND p.entry_type='payment') AS payment_recorded,
  EXISTS(SELECT 1 FROM payment_events e WHERE e.order_id=o.order_id AND e.outcome='accepted'
    AND e.event_type IN ('precheckout_received','precheckout_approved','successful_payment_received','payment_recorded','access_applied')) AS payment_accepted,
  EXISTS(SELECT 1 FROM subscription_billing_contracts c WHERE c.origin_order_id=o.order_id AND NOT(c.provider_state='unconfirmed'
    AND c.first_payment_ledger_entry_id IS NULL AND c.retired_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands cmd WHERE cmd.contract_id=c.contract_id)
    AND EXISTS(SELECT 1 FROM subscription_invoice_requests request WHERE request.contract_id=c.contract_id
      AND request.origin_order_id=o.order_id AND request.telegram_id=m.telegram_id AND request.attempted_count=1
      AND request.state IN ('confirmed','rejected')))) AS cancellation_blocked
  FROM subscription_package_orders m JOIN subscription_orders o ON o.order_id=m.order_id
  LEFT JOIN subscription_invoice_requests r ON r.origin_order_id=o.order_id AND r.telegram_id=m.telegram_id
  WHERE m.telegram_id=? AND m.billing_mode='recurring' AND m.transition_id IS NOT NULL ORDER BY m.order_id LIMIT 129`;
const compensationSql = `SELECT t.transition_id FROM subscription_plan_transitions t JOIN payment_ledger p
  ON p.related_ledger_entry_id=t.source_payment_ledger_entry_id AND p.telegram_id=t.telegram_id
  WHERE t.telegram_id=? AND p.entry_type IN ('refund','chargeback') ORDER BY t.transition_id LIMIT 129`;
const pendingInvoiceSql = `SELECT r.state,r.attempted_count,r.request_sha256,r.provider_result_sha256,r.invoice_url,
  m.telegram_id,m.contract_version,m.source_fingerprint,m.created_at AS metadata_created_at,m.billing_mode AS metadata_billing_mode,
  o.telegram_id AS order_telegram_id,
  m.package_code,m.duration_days,m.period_seconds,m.quoted_starts_at,m.quoted_ends_at,m.price_id,m.price_version,
  m.plan_code,m.currency,m.amount_stars,m.offer_version,m.campaign_code,o.order_id,o.invoice_payload,o.order_state,
  o.created_at,o.expires_at,o.terms_revision,o.price_id AS order_price_id,o.price_version AS order_price_version,
  o.plan_code AS order_plan_code,o.currency AS order_currency,o.amount_stars AS order_amount_stars,
  o.access_seconds AS order_access_seconds,o.billing_mode AS order_billing_mode,
  p.price_id AS canonical_price_id,p.price_version AS canonical_price_version,p.plan_code AS canonical_plan_code,
  p.currency AS canonical_currency,p.amount_stars AS canonical_amount_stars,p.terms_revision AS canonical_terms_revision,
  p.access_seconds,p.billing_mode,p.publication_state,p.valid_from,p.valid_until
  FROM subscription_package_invoice_requests r JOIN subscription_package_orders m ON m.order_id=r.order_id
  JOIN subscription_orders o ON o.order_id=m.order_id JOIN price_book p ON p.price_id=m.price_id
  WHERE r.telegram_id=? AND m.telegram_id=r.telegram_id AND o.telegram_id=r.telegram_id AND m.billing_mode='prepaid'
    AND r.state IN ('admitted','attempted','confirmed','unknown')
    AND NOT EXISTS(SELECT 1 FROM payment_ledger paid WHERE paid.order_id=o.order_id AND paid.entry_type='payment')
  ORDER BY r.created_at DESC,r.request_id LIMIT 129`;
const RESERVATION_COLUMNS='transition_id order_id plan_code price_id price_version currency amount_stars period_seconds order_state expires_at terms_revision precheckout_approved_at invoice_state invoice_url payment_recorded payment_accepted cancellation_blocked'.split(' ');
const PENDING_INVOICE_COLUMNS='state attempted_count request_sha256 provider_result_sha256 invoice_url telegram_id contract_version source_fingerprint metadata_created_at metadata_billing_mode order_telegram_id package_code duration_days period_seconds quoted_starts_at quoted_ends_at price_id price_version plan_code currency amount_stars offer_version campaign_code order_id invoice_payload order_state created_at expires_at terms_revision order_price_id order_price_version order_plan_code order_currency order_amount_stars order_access_seconds order_billing_mode canonical_price_id canonical_price_version canonical_plan_code canonical_currency canonical_amount_stars canonical_terms_revision access_seconds billing_mode publication_state valid_from valid_until'.split(' ');
async function pendingInvoiceView(rows, identity, now) {
  const result = [];
  for (const row of rows) {
    const verified = await verifyStarsInvoicePayload({ invoiceSecret: identity.env.STARS_INVOICE_SECRET, payload: row.invoice_payload,
      telegramId: identity.telegramId, priceId: row.price_id });
    const price = normalizeStoredServerPackagePrice({ price_id: row.canonical_price_id, price_version: row.canonical_price_version, plan_code: row.canonical_plan_code,
      currency: row.canonical_currency, amount_stars: row.canonical_amount_stars, access_seconds: row.access_seconds, billing_mode: row.billing_mode,
      publication_state: row.publication_state, terms_revision: row.canonical_terms_revision, valid_from: row.valid_from, valid_until: row.valid_until },
      {botId:identity.botId,order:{order_id:row.order_id,telegram_id:row.order_telegram_id,price_id:row.order_price_id,
        price_version:row.order_price_version,plan_code:row.order_plan_code,currency:row.order_currency,amount_stars:row.order_amount_stars,
        access_seconds:row.order_access_seconds,billing_mode:row.order_billing_mode,terms_revision:row.terms_revision,created_at:row.created_at},
      metadata:{...row,billing_mode:row.metadata_billing_mode,created_at:row.metadata_created_at}});
    const confirmationHash = await packageConfirmationPayloadHash({ planCode: row.plan_code, packageCode: row.package_code,
      amountStars: row.amount_stars, currency: row.currency, priceVersion: row.price_version, offerVersion: row.offer_version,
      campaignCode: row.campaign_code, termsRevision: row.terms_revision });
    if (verified.orderId !== row.order_id || ![confirmationHash, await sha256Hex(row.invoice_payload)].includes(row.request_sha256) ||
        row.price_id !== price.priceId || row.order_price_id !== price.priceId || row.price_version !== price.priceVersion ||
        row.order_price_version !== price.priceVersion || row.plan_code !== price.planCode || row.order_plan_code !== price.planCode ||
        row.currency !== price.currency || row.order_currency !== price.currency || row.amount_stars !== price.amountStars ||
        row.order_amount_stars !== price.amountStars || row.order_access_seconds !== price.periodSeconds || row.order_billing_mode !== 'prepaid' ||
        row.terms_revision !== price.termsRevision || !/^[0-9A-Za-z._-]{8,64}$/u.test(row.offer_version ?? '') ||
        row.campaign_code !== null && !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(row.campaign_code ?? '') ||
        price.packageCode !== row.package_code || price.durationDays !== row.duration_days || price.periodSeconds !== row.period_seconds ||
        !positive(row.quoted_starts_at) || row.quoted_ends_at !== row.quoted_starts_at + row.period_seconds ||
        price.validFrom > row.created_at || price.validUntil !== null && price.validUntil <= row.created_at ||
        !['created','precheckout_ok','failed','cancelled'].includes(row.order_state)) fail('package_read_invoice_invalid');
    const confirmed = row.state === 'confirmed' && row.attempted_count === 1 &&
      /^https:\/\/t\.me\/\$[A-Za-z0-9_-]{8,256}$/u.test(row.invoice_url ?? '') &&
      row.provider_result_sha256 === await sha256Hex(JSON.stringify(row.invoice_url));
    if (row.state === 'confirmed' && !confirmed) fail('package_read_invoice_invalid');
    const state = ['attempted','unknown'].includes(row.state) ? 'manual_review' : row.expires_at <= now ? 'expired' :
      confirmed && ['created','precheckout_ok'].includes(row.order_state) ? 'issued' : 'pending';
    result.push({ planCode: row.plan_code, packageCode: row.package_code, durationDays: row.duration_days,
      amountStars: row.amount_stars, currency: 'XTR', billingMode: 'prepaid', state,
      priceVersion: row.price_version, offerVersion: row.offer_version, campaignCode: row.campaign_code, termsRevision: row.terms_revision,
      startsAt: row.quoted_starts_at, endsAt: row.quoted_ends_at, datesAreEstimate: true, expiresAt: row.expires_at,
      invoiceUrl: state === 'issued' ? row.invoice_url : null, grantsAccess: false });
  }
  return result;
}

function monthlyProviderReason(lifecycle, now) {
  const open = lifecycle.contracts.filter(contract => contract.retired_at === null);
  if (!open.length) return null;
  if (open.length !== 1) return 'monthly_old_contract_conflict';
  const contract = open[0];
  if (!contract.first_payment_ledger_entry_id) return 'monthly_old_contract_provider_confirmation_required';
  const observed = lifecycle.providerEvents.find(event => event.event_id === contract.last_provider_event_id &&
    event.contract_id === contract.contract_id && event.telegram_id === contract.telegram_id &&
    event.source === 'telegram_update' && event.provider_state === 'canceled');
  if (contract.provider_state !== 'canceled' || !observed || lifecycle.commands.some(command => command.contract_id === contract.contract_id &&
      (['admitted','attempted','unknown'].includes(command.state) || command.state === 'confirmed' &&
        command.action === 'reenable_renewal' && command.attempted_at >= observed.received_at)))
    return 'monthly_old_contract_provider_confirmation_required';
  if (lifecycle.periods.some(period => period.contractId === contract.contract_id && period.status === 'active' && period.endsAt > now))
    return 'monthly_transition_paid_residue_remaining';
  return null;
}
function transitionView(row, { reservations, compensated, canWrite, now, lifecycle, recurring, boundary, packageEnabled, sourceReview, monthlyQuotes }) {
  const isMonthly = row.target_package_code === '30d' && row.to_billing_mode === 'recurring';
  const reservation = reservations.find(item => item.transition_id === row.transition_id);
  const sourceCompensated = compensated.some(item => item.transition_id === row.transition_id);
  const paid = row.state === 'fulfilled' || row.target_period_id !== null || row.target_grant_id !== null || reservation?.payment_recorded === 1;
  const attempted = reservation && ['admitted','attempted','unknown'].includes(reservation.invoice_state);
  const cancellationReason = row.state !== 'scheduled' ? 'package_transition_closed' : paid ? 'package_transition_already_paid' :
    isMonthly && (attempted || reservation?.cancellation_blocked === 1) ? 'monthly_transition_invoice_review_required' :
      isMonthly && (reservation?.order_state === 'precheckout_ok' || reservation?.payment_accepted === 1) ? 'monthly_transition_payment_pending' :
        isMonthly && reservation && !['created','cancelled','failed'].includes(reservation.order_state) ? 'package_transition_already_paid' :
          !canWrite ? 'cabinet_session_required' : null;
  let status = row.state, checkoutReason = 'package_transition_not_monthly';
  if (isMonthly) {
    checkoutReason = row.state !== 'scheduled' ? 'package_transition_closed' : sourceCompensated ? 'monthly_transition_source_compensated' :
      sourceReview ? 'package_paid_source_review_required' : !packageEnabled ? 'package_disabled' :
        !reservation ? 'monthly_reservation_expired_or_closed' : paid ? 'package_transition_already_paid' :
          attempted ? 'monthly_transition_invoice_review_required' : reservation.invoice_state === 'confirmed' ? 'invoice_already_issued' :
            reservation.invoice_state === 'rejected' ? 'monthly_transition_invoice_rejected' :
              reservation.order_state !== 'created' || reservation.expires_at <= now ? 'monthly_reservation_expired_or_closed' :
                now < row.effective_at ? 'package_monthly_invoice_not_due' : !recurring.ready || !monthlyQuotes[row.to_plan] ||
                  monthlyQuotes[row.to_plan].priceId !== reservation.price_id || monthlyQuotes[row.to_plan].amountStars !== reservation.amount_stars ||
                  reservation.price_version !== recurring.priceVersion || reservation.terms_revision !== recurring.termsRevision ||
                  reservation.price_id !== row.target_price_id || reservation.plan_code !== row.to_plan ||
                  reservation.period_seconds !== STARS_MONTH_SECONDS ? 'monthly_transition_price_changed' :
                    boundary?.nextAvailableAt > now ? 'monthly_transition_paid_residue_remaining' : monthlyProviderReason(lifecycle, now);
    if (row.state === 'scheduled') status = sourceCompensated ? 'source_compensated' : paid ? 'payment_recorded' : attempted ? 'manual_review' :
      reservation?.invoice_state === 'confirmed' ? 'awaiting_payment' : reservation && reservation.expires_at <= now ? 'expired_reservation' :
        now < row.effective_at ? 'scheduled' : checkoutReason === null ? 'ready_for_consent' : 'manual_review';
  } else if (row.state === 'scheduled') status = sourceCompensated ? 'source_compensated' : sourceReview ? 'manual_review' : 'scheduled';
  const safeInvoice = reservation?.invoice_state === 'confirmed' &&
    /^https:\/\/t\.me\/\$[A-Za-z0-9_-]{8,256}$/u.test(reservation.invoice_url ?? '') && reservation.order_state === 'created' &&
    reservation.expires_at > now && !sourceCompensated && !sourceReview ? reservation.invoice_url : null;
  return { transitionId: row.transition_id, revision: row.revision, fromPlan: row.from_plan, toPlan: row.to_plan,
    packageCode: row.target_package_code, billingMode: row.to_billing_mode, durationDays: row.period_seconds / 86400,
    effectiveAt: row.effective_at, state: row.state, status, sourceCompensated, grantsAccess: false,
    cancel: route('cancel', cancellationReason === null, cancellationReason),
    monthlyCheckout: route('monthly-invoice', isMonthly && checkoutReason === null && canWrite, checkoutReason ?? (!canWrite ? 'cabinet_session_required' : null),
      { freshConsentRequired: true, amountStars: isMonthly ? reservation?.amount_stars ?? null : null, currency: 'XTR',
        termsRevision: isMonthly ? reservation?.terms_revision ?? null : null, priceVersion: isMonthly ? reservation?.price_version ?? null : null,
        invoiceUrl: safeInvoice, expiresAt: isMonthly ? reservation?.expires_at ?? null : null }) };
}

// The caller supplies only a server-minted authorization. Values returned here
// describe own recorded sources; commands independently admit their effect.
export async function readOwnPackageSubscription(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).join(',') !== 'authorization')
    fail('package_read_scope_invalid', 403);
  const { context, actor } = readRuntimeAuthorization(requireRuntimeAuthorization(options.authorization));
  const identity = readTrustedContext(context), facts = readActorFacts(actor), now = identity.nowSeconds;
  if (identity.actorKind !== 'customer' || identity.operation !== 'access.read_own' || facts.telegramId !== identity.telegramId)
    fail('package_read_scope_invalid', 403);
  const lifecycle = readVerifiedLifecycleFacts(readLifecycleActorFacts(actor));
  const historyPeriods = lifecycle.periods.filter(period => period.sourceKind === 'package_payment');
  const paidPeriods = await Promise.all(historyPeriods.map(async period => ({
    ...packageHistoryMetadata(period, now), receiptId: await ownReceiptId(identity.telegramId, period.ledgerEntryId),
    planCode: period.planCode, amountStars: period.amountStars, currency: 'XTR', billingMode: 'prepaid',
    state: paidState(period, now), grantsCurrentAccess: facts.access.status === 'verified' &&
      facts.access.sourceKind === 'package_payment' && facts.access.sourceRef === period.subscriptionId && paidState(period, now) === 'current' })));
  const base = { version: 1, modelVersion: PACKAGE_READ_MODEL_VERSION, authority: 'worker', accessAuthority: false,
    observedAt: now, validUntil: Math.min(facts.validUntil, identity.expiresAt, runtimeAuthorizationDTO(options.authorization).validUntil), canWrite: false, available: false,
    reasonCode: null, offers: [], paidPeriods, transitions: [], pendingInvoices: [], terms: null };
  if (!facts.canonicalOwner) return freeze({ ...base, reasonCode: 'package_owner_authority_required' });
  if (!facts.financialSourceAvailable || facts.access.status !== 'verified') return freeze({ ...base, reasonCode: 'package_paid_source_review_required' });
  const reads = capturedReads(identity.db);
  let config, paid, paymentSchema;
  try {
    config = readPackageContractConfig(identity.env);
    // The absence of the additive package contour preserves the accepted old
    // subscription read. A damaged existing contour remains closed.
    paid = await resolveOwnPackagePeriodAuthority({ actor, nowSec: now });
    paymentSchema = await inspectPackagePaymentReviewSchema(identity.db, { required: true });
  } catch (error) { return freeze({ ...base, reasonCode: reason(error) }); }
  const gate = readCabinetAdminGate(identity.env, now), canWrite = Boolean(gate && identity.channel === 'mini_app' &&
    identity.verifiedSessionId && gate.ownerTelegramId === identity.telegramId && gate.botId === identity.botId &&
    compileContextAssertions(context).sql.includes(releaseAdminFence(identity.env).sql));
  const lockSql=`SELECT COUNT(*) AS count FROM subscription_orders WHERE telegram_id=? AND ${STARS_PURCHASE_LOCK_SQL}`;
  const acceptanceSql=`SELECT terms_revision FROM terms_acceptances WHERE telegram_id=?
    AND acceptance_scope='stars_purchase' AND accepted_at<=? ORDER BY terms_revision LIMIT 129`;
  const comparisonSql=`SELECT price_version,plan_code,amount_stars,terms_revision FROM price_book
    WHERE billing_mode='prepaid' AND access_seconds=? AND publication_state='approved' AND valid_from<=?
      AND (valid_until IS NULL OR valid_until>?) ORDER BY price_id LIMIT 129`;
  await reads.preload([[transitionSql,[identity.telegramId],TRANSITION_COLUMNS],
    [reservationSql,[identity.telegramId],RESERVATION_COLUMNS], [compensationSql,[identity.telegramId],['transition_id']],
    [pendingInvoiceSql,[identity.telegramId],PENDING_INVOICE_COLUMNS], [lockSql,[identity.telegramId,now],['count']],
    [acceptanceSql,[identity.telegramId,now],['terms_revision']],
    [comparisonSql,[STARS_MONTH_SECONDS,now,now],['price_version','plan_code','amount_stars','terms_revision']]]);
  const transitions = await reads.rows(transitionSql, [identity.telegramId]);
  const reservations = await reads.rows(reservationSql, [identity.telegramId]);
  const compensated = await reads.rows(compensationSql, [identity.telegramId]);
  const pendingInvoices = await pendingInvoiceView(await reads.rows(pendingInvoiceSql, [identity.telegramId]), identity, now);
  const locks = await reads.rows(lockSql,
    [identity.telegramId, now]);
  const accepted = await reads.rows(acceptanceSql, [identity.telegramId, now]);
  const monthlyPrices = await reads.rows(comparisonSql, [STARS_MONTH_SECONDS, now, now]);
  const recurring = readStarsRecurringConfig(identity.env), core = readStarsCoreConfig(identity.env);
  const sourceReview = lifecycle.reviewRequired || lifecycle.administrativelySuspended || lifecycle.chargebackSuspended;
  let boundary = null;
  const offers = [], monthlyQuotes = {};
  for (const planCode of ['professional','dragon']) for (const packageCode of ['30d',...Object.keys(PACKAGE_DURATIONS)]) {
    const durationDays = packageCode === '30d' ? 30 : PACKAGE_DURATIONS[packageCode].durationDays;
    let quote = null, unavailable = null;
    try { quote = packageCode === '30d' ? createServerMonthlyTransitionQuote({ actor, verifiedPackagePeriods: paid, nowSec: now,
      request: { requestedPlanCode: planCode } }) : createServerPackageQuote({ actor, verifiedPackagePeriods: paid, nowSec: now,
      request: { requestedPlanCode: planCode, packageCode } });
    } catch (error) { unavailable = reason(error); }
    if (quote && packageCode === '30d') monthlyQuotes[planCode] = quote;
    if (quote) boundary ??= { nextAvailableAt: quote.quotedStartsAt };
    let exitReason = null;
    if (quote) try { assertRecurringExitConfirmed({ actor, nowSec: now }); } catch (error) { exitReason = reason(error); }
    const existing = transitions.find(transition => transition.state === 'scheduled');
    const matches = existing && quote && existing.to_plan === planCode && existing.target_package_code === packageCode &&
      existing.target_price_id === quote.priceId && existing.target_price_version === quote.priceVersion;
    const termsAvailable = quote && quote.termsRevision === (packageCode === '30d' ? STARS_RECURRING_TERMS_REVISION : STARS_TERMS_REVISION);
    const termsAccepted = Boolean(quote && accepted.some(row => row.terms_revision === quote.termsRevision));
    const invoiceReason = unavailable ?? (sourceReview ? 'package_paid_source_review_required' : packageCode === '30d' ? 'monthly_transition_requires_schedule' :
      !canWrite ? 'cabinet_session_required' : exitReason ?? (!core.ready ? 'stars_payments_not_ready' :
        !termsAvailable ? 'stars_terms_revision_not_released' :
          locks[0]?.count > 0 ? 'payment_order_in_progress' : existing && !matches ? 'package_transition_already_scheduled' : null));
    const scheduleReason = unavailable ?? (sourceReview ? 'package_paid_source_review_required' : !termsAvailable ? 'stars_terms_revision_not_released' :
      !canWrite ? 'cabinet_session_required' : existing ? 'package_transition_already_scheduled' :
      !quote?.sourcePaymentLedgerEntryId || !positive(quote?.sourcePaidUntil) || quote.sourcePaidUntil <= now ? 'package_schedule_paid_source_required' :
        packageCode === '30d' && locks[0]?.count > 0 ? 'payment_order_in_progress' : null);
    const sameMonthly = monthlyPrices.filter(row => row.plan_code === planCode && row.price_version === core.priceVersion &&
      row.terms_revision === core.termsRevision);
    const comparison = quote && packageCode !== '30d' && sameMonthly.length === 1 && positive(sameMonthly[0].amount_stars) ? {
      amountStars: sameMonthly[0].amount_stars * durationDays / 30, monthlyAmountStars: sameMonthly[0].amount_stars,
      periodCount: durationDays / 30, basis: 'same_plan_monthly_equivalent', currency: 'XTR' } : null;
    offers.push({ planCode, packageCode, durationDays, periodSeconds: durationDays * 86400,
      published: quote !== null, available: quote !== null, reasonCode: unavailable,
      amountStars: quote?.amountStars ?? null, currency: 'XTR', billingMode: packageCode === '30d' ? 'recurring' : 'prepaid',
      automaticRenewal: packageCode === '30d', freshConsentRequired: packageCode === '30d',
      priceVersion: quote?.priceVersion ?? null, offerVersion: quote?.offerVersion ?? null, campaignCode: quote?.campaignCode ?? null,
      termsRevision: quote?.termsRevision ?? null, terms: { revision: quote?.termsRevision ?? null, available: Boolean(termsAvailable),
        accepted: termsAccepted, text: quote ? buildPackageOfferTerms(quote) : null,
        telegramCommand: '/terms' }, priceComparison: comparison,
      preview: quote ? { startsAt: quote.quotedStartsAt, endsAt: quote.quotedEndsAt, datesAreEstimate: true, validUntil: Math.min(quote.validUntil, base.validUntil) } : null,
      invoice: route('invoice', invoiceReason === null, invoiceReason), schedule: route('schedule', scheduleReason === null, scheduleReason) });
  }
  const projectedTransitions = transitions.map(row => transitionView(row, { reservations, compensated, canWrite, now, lifecycle,
    recurring, boundary, packageEnabled: config.enabled, sourceReview, monthlyQuotes }));
  // Canonical actor assertions are already checked once by the subscription
  // transport. Recheck the additional quote schema/price/period captures only;
  // repeating every actor read here would exhaust its accepted finite budget.
  const original = compileAuthorityAssertions(actor).assertions;
  const assertions = compilePackagePeriodAssertions(paid).assertions;
  if (assertions.length <= original.length || JSON.stringify(assertions.slice(0, original.length)) !== JSON.stringify(original))
    fail('package_read_source_invalid');
  await reads.assertFresh([...assertions.slice(original.length), packagePaymentReviewSchemaAssertion(paymentSchema)]);
  return freeze({ ...base, canWrite, available: config.enabled && offers.some(offer => offer.available),
    reasonCode: config.enabled ? offers.some(offer => offer.available) ? null : 'package_price_unavailable' : 'package_disabled',
    offers, transitions: projectedTransitions, pendingInvoices,
    terms: { revision: config.termsRevision, available: config.termsRevision === STARS_TERMS_REVISION,
      accepted: accepted.some(row => row.terms_revision === config.termsRevision), telegramCommand: '/terms' } });
}
