// These reads are invoked only by the existing authority's recorded reader.
// Rows from this helper are candidates, never a financial-authority brand.
export const LIFECYCLE_SOURCE_COLUMNS = Object.freeze({
  subscription_billing_contracts: 'contract_id telegram_id plan_code price_id origin_order_id external_invoice_payload external_payload_sha256 terms_revision terms_acceptance_id billing_mode period_seconds currency amount_stars provider_state auto_renew_confirmed first_payment_ledger_entry_id last_provider_event_id retired_at retirement_event_id revision created_at updated_at',
  subscription_payment_links: 'operation_id operation_key provider_charge_id provider_charge_sha256 direction link_kind contract_id origin_order_id applied_order_id telegram_id plan_code external_invoice_payload external_payload_sha256 ledger_entry_id original_payment_ledger_entry_id provider_period_start provider_period_end evidence_sha256 occurred_at recorded_at',
  subscription_provider_events: 'event_id event_key contract_id operation_id command_id telegram_id event_type source telegram_update_id provider_state from_state to_state actor_type actor_id reason_code evidence_sha256 provider_occurred_at received_at',
  subscription_provider_commands: 'command_id idempotency_key contract_id telegram_id action desired_auto_renew expected_contract_revision first_payment_ledger_entry_id request_sha256 state attempted_count attempted_at acknowledgement_event_id error_code revision created_at updated_at',
  payment_review_resolutions: 'resolution_id resolution_key operation_id reconciliation_item_id original_payment_ledger_entry_id financial_effect_ledger_entry_id decision actor_type actor_id reason_code evidence_sha256 supersedes_resolution_id recorded_at',
});
export const LIFECYCLE_SOURCE_TABLES = Object.freeze(Object.keys(LIFECYCLE_SOURCE_COLUMNS));
export const LIFECYCLE_FIRST_RECEIPT_COLUMNS = 'contract_id operation_id evidence_sha256 verified_at';
export const LIFECYCLE_REVIEW_RECEIPT_COLUMNS = 'ledger_entry_id origin_order_id contract_id telegram_id plan_code external_invoice_payload external_payload_sha256 provider_period_start provider_period_end is_first_recurring evidence_sha256 telegram_update_id reason_code recorded_at';
export const LIFECYCLE_REVIEW_SETTLEMENT_COLUMNS = 'ledger_entry_id applied_order_id operation_id resolution_key actor_id reason_code evidence_sha256 settled_at';
const empty = () => ({ contracts: [], paymentLinks: [], providerEvents: [], commands: [], reviewResolutions: [], firstRecurringReceipts: [], paymentReviewReceipts: [], paymentReviewSettlements: [] });
const fail = code => { throw Object.assign(new Error(code), { code }); };

export async function readOwnLifecycleFacts({ telegramId, read, schemaPresent = false, firstReceiptSchemaPresent = false,
  reviewReceiptSchemaPresent = false, reviewSettlementSchemaPresent = false } = {}) {
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0 || typeof read !== 'function' ||
      typeof schemaPresent !== 'boolean' || typeof firstReceiptSchemaPresent !== 'boolean' ||
      typeof reviewReceiptSchemaPresent !== 'boolean' || typeof reviewSettlementSchemaPresent !== 'boolean') fail('lifecycle_own_reader_invalid');
  if (!schemaPresent) return Object.freeze(Object.fromEntries(Object.entries(empty()).map(([key, rows]) => [key, Object.freeze(rows)])));
  const jobs = [
    ['contracts', 'subscription_billing_contracts', 'telegram_id=?', 'contract_id'],
    ['paymentLinks', 'subscription_payment_links', 'telegram_id=?', 'operation_id'],
    // Projection receipts are an append-only output. They cannot feed their
    // own financial proof/fingerprint or invalidate a retry of that output.
    ['providerEvents', 'subscription_provider_events', "telegram_id=? AND event_type!='lifecycle_transition'", 'event_id'],
    ['commands', 'subscription_provider_commands', 'telegram_id=?', 'command_id'],
    ['reviewResolutions', 'payment_review_resolutions',
      'operation_id IN (SELECT operation_id FROM subscription_payment_links WHERE telegram_id=?)', 'resolution_id'],
  ];
  if (firstReceiptSchemaPresent) jobs.push(['firstRecurringReceipts', 'subscription_first_recurring_receipts',
    'contract_id IN (SELECT contract_id FROM subscription_billing_contracts WHERE telegram_id=?)', 'contract_id']);
  if (reviewReceiptSchemaPresent) jobs.push(['paymentReviewReceipts', 'subscription_payment_review_receipts',
    'telegram_id=?', 'ledger_entry_id']);
  if (reviewSettlementSchemaPresent) jobs.push(['paymentReviewSettlements', 'subscription_payment_review_settlements',
    'ledger_entry_id IN (SELECT ledger_entry_id FROM subscription_payment_review_receipts WHERE telegram_id=?)', 'ledger_entry_id']);
  const results = await Promise.allSettled(jobs.map(async ([key, table, where, order]) => {
    const rows = await read(table, where, [telegramId], order, false, 128);
    if (!Array.isArray(rows) || rows.length > 128) fail('lifecycle_own_source_overflow');
    return [key, rows];
  }));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return Object.freeze({ ...empty(), ...Object.fromEntries(results.map(result => result.value)) });
}
