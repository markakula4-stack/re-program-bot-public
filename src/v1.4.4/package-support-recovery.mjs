import { readRuntimeAuthorization, requireRuntimeAuthorization } from '../v1.4.1/runtime-authorizer.mjs';
import { readTrustedContext, compileContextAssertions } from '../v1.4.1/trusted-context.mjs';
import { readActorFacts, compileAuthorityAssertions } from '../v1.4.1/authority-resolver.mjs';
import { inspectLifecycleSchema, lifecycleSchemaAssertion } from '../v1.4.3/lifecycle-schema.mjs';
import { inspectPackageSchema, inspectPackagePaymentReviewSchema,
  packageSchemaAssertion, packagePaymentReviewSchemaAssertion } from './package-schema.mjs';
import { STARS_MONTH_SECONDS, verifyStarsInvoicePayload } from '../v1.3.6/stars-core-foundation.mjs';
import { sha256Hex } from '../v1.4.0-rebuild/mini-app-security.mjs';

export const PACKAGE_SUPPORT_RECOVERY_VERSION = '2026-10-07.v1.4.4.p04';
const reports = new WeakSet();
const fail = (code, status = 503) => { throw Object.assign(new Error(code), { code, status }); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) {
  Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// SELECT-only recorded reads. A final guarded SELECT proves every captured
// table, including absence of later commands/cash, still matches the report.
// No arbitrary SQL, subject IDs, provider calls or caller evidence are inputs.
function reader(db) {
  const assertions = [];
  return { assertions, async rows(table, where, params = []) {
    const sql = `SELECT * FROM ${table} WHERE ${where} ORDER BY rowid LIMIT 129`;
    let result; try { result = await db.prepare(sql).bind(...params).all(); }
    catch { fail('package_recovery_source_unavailable'); }
    if (result?.success !== true || !Array.isArray(result.results) || result.results.length > 128 ||
        new TextEncoder().encode(JSON.stringify(result.results)).length > 1_000_000)
      fail('package_recovery_source_unavailable');
    const rows = result.results, keys = Object.keys(rows[0] ?? {});
    if (keys.some(key => !/^[a-z][a-z0-9_]*$/u.test(key))) fail('package_recovery_source_invalid');
    if (!rows.length) assertions.push({ sql: `NOT EXISTS(${sql})`, params });
    else assertions.push({ sql: `(SELECT COALESCE(json_group_array(json(snapshot)),'[]') FROM
      (SELECT json_array(${keys.map(key => 'source.' + key).join(',')}) AS snapshot FROM (${sql}) AS source)) IS ?`,
      params: [...params, JSON.stringify(rows.map(row => keys.map(key => row[key])))] });
    return rows;
  } };
}
async function assertFresh(identity, assertions) {
  const groups = []; let group = { sql: [], params: [] };
  for (const piece of assertions) {
    if (!Array.isArray(piece.params) || piece.params.length > 99 || piece.sql.length > 90_000)
      fail('package_recovery_source_invalid');
    if (group.params.length + piece.params.length > 99 || group.sql.join(' AND ').length + piece.sql.length > 90_000) {
      groups.push(group); group = { sql: [], params: [] };
    }
    group.sql.push('(' + piece.sql + ')'); group.params.push(...piece.params);
  }
  if (group.sql.length) groups.push(group);
  let result;
  try { result = await identity.db.batch(groups.map(piece => identity.db.prepare(
    `SELECT CASE WHEN ${piece.sql.join(' AND ')} THEN 1 ELSE 0 END AS allowed`).bind(...piece.params))); }
  catch { fail('package_recovery_source_unavailable'); }
  if (!Array.isArray(result) || result.length !== groups.length || result.some(row => row?.success !== true ||
      !Array.isArray(row.results) || row.results.length !== 1 || row.results[0].allowed !== 1))
    fail('package_recovery_stale', 409);
}

async function verifyContract(identity, contract, source) {
  const origin = source.orders.find(row => row.order_id === contract.origin_order_id),
    price = source.prices.find(row => row.price_id === contract.price_id && row.price_version === origin?.price_version),
    consent = source.terms.find(row => row.acceptance_id === contract.terms_acceptance_id);
  if (!origin || !price || !consent || contract.telegram_id !== identity.telegramId ||
      origin.telegram_id !== identity.telegramId || consent.telegram_id !== identity.telegramId ||
      contract.billing_mode !== 'recurring' || contract.period_seconds !== STARS_MONTH_SECONDS ||
      contract.currency !== 'XTR' || !positive(contract.amount_stars) || !positive(contract.revision) ||
      !positive(contract.created_at) || contract.created_at > identity.nowSeconds ||
      origin.invoice_payload !== contract.external_invoice_payload || !digest(contract.external_payload_sha256) ||
      await sha256Hex(contract.external_invoice_payload) !== contract.external_payload_sha256 ||
      ['price_id', 'plan_code', 'billing_mode', 'terms_revision', 'currency', 'amount_stars'].some(key => origin[key] !== contract[key]) ||
      origin.access_seconds !== contract.period_seconds ||
      ['plan_code', 'billing_mode', 'terms_revision', 'currency', 'amount_stars', 'access_seconds'].some(key => price[key] !== origin[key]) ||
      !['approved', 'retired'].includes(price.publication_state) || price.valid_from > origin.created_at ||
      price.valid_until !== null && price.valid_until <= origin.created_at || consent.terms_revision !== contract.terms_revision ||
      consent.acceptance_scope !== 'stars_purchase' || consent.accepted_at > contract.created_at || !digest(consent.evidence_sha256))
    fail('package_recovery_contract_binding_invalid');
  const verified = await verifyStarsInvoicePayload({ invoiceSecret: identity.env.STARS_INVOICE_SECRET,
    payload: contract.external_invoice_payload, telegramId: identity.telegramId, priceId: contract.price_id });
  if (verified.orderId !== contract.origin_order_id) fail('package_recovery_contract_binding_invalid');
  return origin;
}
function firstReceipt(contract, source) {
  if (contract.first_payment_ledger_entry_id === null) return null;
  const receipt = source.firstReceipts.find(row => row.contract_id === contract.contract_id),
    link = source.links.find(row => row.operation_id === receipt?.operation_id),
    paid = source.ledger.find(row => row.ledger_entry_id === contract.first_payment_ledger_entry_id);
  if (!receipt || !link || !paid || paid.entry_type !== 'payment' || paid.direction !== 'credit' ||
      paid.telegram_id !== contract.telegram_id || paid.currency !== contract.currency || paid.amount_stars !== contract.amount_stars ||
      link.contract_id !== contract.contract_id || link.telegram_id !== contract.telegram_id || link.direction !== 'incoming' ||
      link.link_kind !== 'recurring_charge' || link.ledger_entry_id !== paid.ledger_entry_id ||
      link.origin_order_id !== contract.origin_order_id || link.provider_charge_id !== paid.telegram_payment_charge_id ||
      link.external_invoice_payload !== contract.external_invoice_payload || link.external_payload_sha256 !== contract.external_payload_sha256 ||
      link.evidence_sha256 !== receipt.evidence_sha256 || !digest(receipt.evidence_sha256) || !positive(receipt.verified_at))
    fail('package_recovery_first_receipt_invalid');
  return paid;
}
async function providerEvidence(identity, contract, source) {
  const events = source.events.filter(row => row.contract_id === contract.contract_id),
    commands = source.commands.filter(row => row.contract_id === contract.contract_id), controls = [];
  for (const event of events.filter(row => row.source === 'telegram_update' && row.actor_type === 'telegram' &&
      ['provider_control', 'renewal_failed'].includes(row.event_type))) {
    if (event.telegram_id !== identity.telegramId || !Number.isSafeInteger(event.telegram_update_id) || event.telegram_update_id < 0 ||
        !['active', 'canceled', 'failed'].includes(event.provider_state) || !digest(event.evidence_sha256) ||
        !positive(event.received_at) || event.received_at > identity.nowSeconds)
      fail('package_recovery_provider_evidence_invalid');
    const claim = source.updateReceipts.find(row => row.update_id === event.telegram_update_id);
    const expected = await sha256Hex(JSON.stringify({ domain: 'v1.4.3.telegram-subscription.v1',
      botId: identity.botId, updateId: event.telegram_update_id, telegramId: identity.telegramId,
      contractId: contract.contract_id, payloadSha256: contract.external_payload_sha256, providerState: event.provider_state }));
    if (!claim || claim.actor_id !== identity.telegramId || !['processing', 'completed', 'failed', 'abandoned'].includes(claim.status) ||
        event.evidence_sha256 !== expected || event.event_key !== `telegram:subscription:${identity.botId}:${event.telegram_update_id}`)
      fail('package_recovery_provider_evidence_invalid');
    controls.push({ eventId: event.event_id, updateId: event.telegram_update_id, state: event.provider_state,
      source: 'telegram_update', evidenceSha256: event.evidence_sha256, receivedAt: event.received_at });
  }
  const acks = [];
  for (const command of commands.filter(row => row.state === 'confirmed')) {
    const ack = events.find(row => row.event_id === command.acknowledgement_event_id);
    if (!ack || ack.command_id !== command.command_id || ack.contract_id !== contract.contract_id || ack.telegram_id !== identity.telegramId ||
        ack.source !== 'provider_response' || ack.event_type !== 'command_confirmed' || ack.provider_state !== null ||
        command.attempted_count !== 1 || !positive(command.attempted_at) || command.attempted_at > identity.nowSeconds ||
        !['cancel_renewal', 'reenable_renewal'].includes(command.action) || command.telegram_id !== identity.telegramId ||
        command.first_payment_ledger_entry_id !== contract.first_payment_ledger_entry_id ||
        command.desired_auto_renew !== (command.action === 'cancel_renewal' ? 0 : 1) ||
        !positive(ack.received_at) || ack.received_at < command.attempted_at || ack.received_at > identity.nowSeconds ||
        !digest(ack.evidence_sha256) || ack.evidence_sha256 !== await sha256Hex(JSON.stringify([
          command.command_id, command.action, 'confirmed', command.error_code])))
      fail('package_recovery_provider_evidence_invalid');
    acks.push({ commandId: command.command_id, eventId: ack.event_id, action: command.action,
      source: 'provider_response', providerState: null, evidenceSha256: ack.evidence_sha256,
      attemptedAt: command.attempted_at, contractRevision: command.expected_contract_revision });
  }
  const states = [...new Set(controls.map(row => row.state))], observed = controls.find(row => row.eventId === contract.last_provider_event_id);
  const laterEnable = observed && commands.some(row => row.state === 'confirmed' && row.action === 'reenable_renewal' && row.attempted_at >= observed.receivedAt);
  const unresolved = commands.some(row => ['admitted', 'attempted', 'unknown'].includes(row.state)) ||
    events.some(row => row.event_type === 'review_observed');
  const canceled = states.length === 1 && states[0] === 'canceled' && observed?.state === 'canceled' &&
    contract.provider_state === 'canceled' && !unresolved && !laterEnable;
  return { cancellationObserved: canceled, conflicted: states.length > 1 || !!laterEnable || unresolved,
    controlEvents: controls, commandAcknowledgements: acks,
    pendingCommandIds: commands.filter(row => ['admitted', 'attempted', 'unknown'].includes(row.state)).map(row => row.command_id) };
}
async function retainedCharges(identity, contract, origin, source) {
  return Promise.all(source.reviewReceipts.filter(row => row.contract_id === contract.contract_id).map(async receipt => {
    const paid = source.ledger.find(row => row.ledger_entry_id === receipt.ledger_entry_id);
    if (!paid || paid.entry_type !== 'payment' || paid.direction !== 'credit' || paid.reason_code !== 'payment_review_retained' ||
        paid.related_ledger_entry_id !== null || paid.order_id !== origin.order_id || paid.telegram_id !== identity.telegramId ||
        paid.currency !== origin.currency || paid.amount_stars !== origin.amount_stars || !paid.telegram_payment_charge_id ||
        receipt.telegram_id !== identity.telegramId || receipt.origin_order_id !== origin.order_id || receipt.plan_code !== origin.plan_code ||
        receipt.external_invoice_payload !== contract.external_invoice_payload || receipt.external_payload_sha256 !== contract.external_payload_sha256 ||
        !digest(receipt.evidence_sha256) || !positive(receipt.provider_period_start) ||
        receipt.provider_period_end !== receipt.provider_period_start + contract.period_seconds ||
        receipt.telegram_update_id !== paid.telegram_update_id || ![0, 1].includes(receipt.is_first_recurring))
      fail('package_recovery_charge_binding_invalid');
    const originalEvent = source.paymentEvents.find(row => row.order_id === origin.order_id && row.telegram_id === identity.telegramId &&
      row.telegram_update_id === receipt.telegram_update_id && row.event_type === 'payment_recorded' && row.outcome === 'accepted' &&
      row.reason_code === 'payment_review_retained' && row.payload_sha256 === receipt.evidence_sha256);
    const expectedHash = await sha256Hex(JSON.stringify({ currency: paid.currency, total_amount: paid.amount_stars,
      invoice_payload_sha256: contract.external_payload_sha256, telegram_payment_charge_sha256: await sha256Hex(paid.telegram_payment_charge_id),
      is_recurring: true, is_first_recurring: receipt.is_first_recurring === 1, subscription_expiration_date: receipt.provider_period_end }));
    if (!originalEvent || expectedHash !== receipt.evidence_sha256) fail('package_recovery_charge_binding_invalid');
    const compensations = source.ledger.filter(row => row.related_ledger_entry_id === paid.ledger_entry_id),
      fullRefund = compensations.find(row => row.entry_type === 'refund' && row.direction === 'debit' &&
        row.telegram_id === identity.telegramId && row.currency === paid.currency && row.amount_stars === paid.amount_stars),
      request = fullRefund && source.refunds.find(row => row.original_ledger_entry_id === paid.ledger_entry_id &&
        row.telegram_id === identity.telegramId && row.order_id === paid.order_id && row.currency === paid.currency &&
        row.amount_stars === paid.amount_stars && row.telegram_payment_charge_id === paid.telegram_payment_charge_id &&
        row.status === 'applied' && positive(row.confirmed_at) && positive(row.applied_at));
    const metadata = source.packageOrders.find(row => row.order_id === origin.order_id),
      transition = metadata && source.transitions.find(row => row.transition_id === metadata.transition_id);
    if (metadata && (!transition || metadata.telegram_id !== identity.telegramId || transition.telegram_id !== identity.telegramId ||
        metadata.billing_mode !== 'recurring' || metadata.package_code !== '30d' || transition.to_billing_mode !== 'recurring' ||
        transition.target_package_code !== '30d' || transition.to_plan !== origin.plan_code || metadata.plan_code !== origin.plan_code ||
        metadata.amount_stars !== origin.amount_stars || metadata.price_id !== origin.price_id))
      fail('package_recovery_transition_binding_invalid');
    return { ledgerEntryId: paid.ledger_entry_id, orderId: origin.order_id, contractId: contract.contract_id,
      transitionId: transition?.transition_id ?? null, transitionRevision: transition?.revision ?? null,
      transitionState: transition?.state ?? null, telegramPaymentChargeId: paid.telegram_payment_charge_id,
      amountStars: paid.amount_stars, currency: paid.currency, firstRecurringObserved: receipt.is_first_recurring === 1,
      evidenceSha256: receipt.evidence_sha256, telegramUpdateId: receipt.telegram_update_id, reasonCode: receipt.reason_code,
      paidStartsAt: receipt.provider_period_start, paidEndsAt: receipt.provider_period_end,
      fullRefundAccounted: !!fullRefund, providerRefundConfirmed: !!request, refundId: request?.refund_id ?? null,
      refundLedgerEntryId: fullRefund?.ledger_entry_id ?? null,
      settled: source.settlements.some(row => row.ledger_entry_id === paid.ledger_entry_id) };
  }));
}

// This report is a support handoff, never invoice/cancellation/retirement
// admission. Even a genuine canceled Telegram observation and an exact full
// refund cannot release retained first-NULL cash through unchanged 0071.
export async function readOwnPackageSupportRecovery(options) {
  if (!exact(options, ['authorization'])) fail('package_recovery_scope_invalid', 403);
  const bundle = readRuntimeAuthorization(requireRuntimeAuthorization(options.authorization)),
    identity = readTrustedContext(bundle.context), facts = readActorFacts(bundle.actor);
  const ownTransport = identity.channel === 'mini_app' ? !!identity.verifiedSessionId &&
    (identity.transportBinding === null || identity.transportBinding?.kind === 'http' && identity.transportBinding.actor === identity.telegramId) :
    ['telegram_command', 'telegram_callback'].includes(identity.channel) && identity.transportBinding?.kind === 'telegram' &&
      identity.transportBinding.actor === identity.telegramId;
  if (identity.actorKind !== 'customer' || identity.operation !== 'access.read_own' ||
      !ownTransport || facts.telegramId !== identity.telegramId || !facts.canonicalOwner || !facts.policyReady ||
      !facts.financialSourceAvailable || facts.protectedAuthorityFallback || facts.degradedTables?.length ||
      !facts.account.exists || !facts.account.acceptedTerms || facts.account.isBlocked || facts.account.pendingDeletion)
    fail('package_recovery_owner_authority_required', 403);
  const lifecycle = await inspectLifecycleSchema(identity.db, { required: true }),
    packages = await inspectPackageSchema(identity.db, { required: true }),
    review = await inspectPackagePaymentReviewSchema(identity.db, { required: true });
  if (lifecycle.marker !== '1.4.3-refund-contract-retirement') fail('package_recovery_schema_required');
  const read = reader(identity.db), own = ['telegram_id=?', [identity.telegramId]], source = {};
  for (const [key, table, where, params] of [
    ['contracts', 'subscription_billing_contracts', ...own],
    ['orders', 'subscription_orders', ...own], ['ledger', 'payment_ledger', ...own], ['paymentEvents', 'payment_events', ...own],
    ['links', 'subscription_payment_links', ...own], ['commands', 'subscription_provider_commands', ...own],
    ['events', 'subscription_provider_events', ...own], ['reviewReceipts', 'subscription_payment_review_receipts', ...own],
    ['refunds', 'payment_refunds', ...own], ['packageOrders', 'subscription_package_orders', ...own],
    ['transitions', 'subscription_plan_transitions', ...own],
    ['firstReceipts', 'subscription_first_recurring_receipts', 'contract_id IN(SELECT contract_id FROM subscription_billing_contracts WHERE telegram_id=?)', [identity.telegramId]],
    ['settlements', 'subscription_payment_review_settlements', 'ledger_entry_id IN(SELECT ledger_entry_id FROM subscription_payment_review_receipts WHERE telegram_id=?)', [identity.telegramId]],
    ['prices', 'price_book', 'price_id IN(SELECT price_id FROM subscription_orders WHERE telegram_id=?)', [identity.telegramId]],
    ['terms', 'terms_acceptances', ...own],
    ['updateReceipts', 'telegram_update_receipts', 'update_id IN(SELECT telegram_update_id FROM subscription_provider_events WHERE telegram_id=? AND source=\'telegram_update\')', [identity.telegramId]],
  ]) source[key] = await read.rows(table, where, params);
  const cases = [];
  for (const contract of source.contracts) {
    const origin = await verifyContract(identity, contract, source), first = firstReceipt(contract, source),
      provider = await providerEvidence(identity, contract, source), retained = await retainedCharges(identity, contract, origin, source),
      unsettled = retained.filter(row => !row.settled),
      nullRetained = contract.first_payment_ledger_entry_id === null && retained.length > 0,
      ackOnly = provider.commandAcknowledgements.some(row => row.action === 'cancel_renewal') && !provider.cancellationObserved,
      kind = nullRetained ? contract.retired_at === null ? 'retained_first_null' : 'retained_first_null_retired' :
        provider.conflicted ? 'provider_evidence_conflict' : ackOnly ? 'cancel_ack_only' :
        provider.cancellationObserved ? 'provider_cancellation_observed' : 'provider_state_unresolved';
    const identitySha = await sha256Hex(JSON.stringify(['v144.support-recovery.v1', identity.telegramId,
      contract.contract_id, contract.origin_order_id, contract.revision, retained.map(row => [row.ledgerEntryId, row.telegramPaymentChargeId, row.transitionId])]));
    cases.push({ recoveryCode: 'recovery-' + identitySha.slice(0, 24), kind, contractId: contract.contract_id,
      orderId: origin.order_id, contractRevision: contract.revision, orderState: origin.order_state,
      retiredAt: contract.retired_at, firstPaymentLedgerEntryId: first?.ledger_entry_id ?? null,
      providerState: contract.provider_state, autoRenewConfirmed: contract.auto_renew_confirmed,
      provider, retainedCharges: retained, unresolvedCash: unsettled.filter(row => !row.fullRefundAccounted).length,
      compatibleRecoveryRequired: nullRetained && contract.retired_at === null, automaticRetirementAllowed: false, newInvoiceAdmitted: false,
      grantsAccess: false, providerCallsAllowed: false,
      nextStep: nullRetained && contract.retired_at !== null ? 'existing_exact_retained_cash_review_preserving_current_access' :
        nullRetained ? provider.cancellationObserved ? 'compatible_reviewed_recovery_required_0071' :
        'cancel_in_telegram_then_wait_for_authenticated_subscription_update' : provider.conflicted ?
        'resolve_conflicting_original_provider_evidence' : ackOnly ? 'wait_for_authenticated_subscription_update' :
        provider.cancellationObserved ? 'use_existing_fresh_authorized_monthly_boundary' : 'verify_existing_subscription_in_telegram',
      originalEvidenceRequired: ['contract', 'order', 'transition_if_present', 'exact_charge', 'original_provider_event_or_command_ack'],
      forbiddenActions: ['synthesize_first_receipt', 'refund_as_renewal_cancel', 'repeat_unknown_provider_operation',
        'drop_0071_guard', 'erase_payment_or_earned_period', 'blind_legacy_binary_rollback'] });
  }
  await assertFresh(identity, [compileContextAssertions(bundle.context), ...compileAuthorityAssertions(bundle.actor).assertions,
    lifecycleSchemaAssertion(lifecycle), packageSchemaAssertion(packages), packagePaymentReviewSchemaAssertion(review), ...read.assertions]);
  const report = freeze({ version: PACKAGE_SUPPORT_RECOVERY_VERSION, authority: 'own_worker_recorded_sources',
    generatedAt: identity.nowSeconds, validUntil: Math.min(identity.expiresAt, facts.validUntil ?? identity.expiresAt),
    available: true, readonly: true, accessAuthority: false, providerAuthority: false, sqlWrites: 0, providerCalls: 0,
    schemaGuard: '1.4.3-refund-contract-retirement', cases,
    rollback: { compatibleSameSourceRequired: true, preservePaidFuturePeriods: true, preserveEarnedPeriods: true,
      disableNewProducersOnly: true, restoresProviderState: false },
    referralQualification: { newLongPackageRewardVerified: false, priorEarnedResiduePreserved: true } });
  reports.add(report); return report;
}

// Public support copy deliberately carries only an opaque own case code.
// Financial/provider identities stay in the genuine readonly owner report.
export function packageSupportRecoveryMessage(report) {
  if (!reports.has(report)) fail('package_recovery_report_untrusted', 403);
  const pending = report.cases.filter(row => row.retiredAt === null &&
    ['retained_first_null', 'cancel_ack_only', 'provider_evidence_conflict'].includes(row.kind));
  if (!pending.length) return null;
  const row = pending[0], text = row.kind === 'retained_first_null' ?
    'Платёж сохранён для разбора. Возврат Stars сам по себе не отменяет автопродление. Проверь подписку в Telegram; новый счёт откроется после подтверждённого разрешения договора.' :
    row.kind === 'cancel_ack_only' ? 'Команда отмены принята. Подтверждение состояния подписки ещё ожидается — проверь автопродление в Telegram.' :
      'Состояние автопродления требует проверки. Сохраняем оплату и историю; повторную команду автоматически не отправляем.';
  return freeze({ text, recoveryCode: row.recoveryCode, helpCommand: '/paysupport', automaticRetry: false });
}
