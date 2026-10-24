import { inspectLifecycleSchema, lifecycleSchemaAssertion, LIFECYCLE_SCHEMA } from './lifecycle-schema.mjs';

const fields=Object.freeze({subscriptionContracts:'subscription_billing_contracts',paymentLinks:'subscription_payment_links',
  providerEvents:'subscription_provider_events',providerCommands:'subscription_provider_commands',
  paidNotifications:'paid_subscription_notification_jobs'});
const fail=()=>{throw Object.assign(new Error('v143_privacy_not_ready'),{code:'v143_privacy_not_ready',status:503});};
const ownPredicates=Object.freeze([
  ...Object.values(fields).map(table=>`NOT EXISTS(SELECT 1 FROM ${table} WHERE telegram_id=?)`),
  `NOT EXISTS(SELECT 1 FROM subscription_provider_events WHERE actor_id=?)`,
  `NOT EXISTS(SELECT 1 FROM payment_review_resolutions r LEFT JOIN subscription_payment_links l ON l.operation_id=r.operation_id
    LEFT JOIN payment_ledger p ON p.ledger_entry_id=r.original_payment_ledger_entry_id
    WHERE r.actor_id=? OR l.telegram_id=? OR p.telegram_id=?)`,
]);
export function lifecycleRetentionAssertion(state,subjectId) {
  const schema=lifecycleSchemaAssertion(state);
  if(!state.present)return schema;
  const predicates=[...ownPredicates];
  if(state.marker!=='1.4.3-subscription-lifecycle-foundation')predicates.push(`NOT EXISTS(SELECT 1 FROM subscription_first_recurring_receipts r
    JOIN subscription_billing_contracts c ON c.contract_id=r.contract_id WHERE c.telegram_id=?)`,
    `NOT EXISTS(SELECT 1 FROM subscription_payment_review_receipts WHERE telegram_id=?)`);
  if(LIFECYCLE_SCHEMA.stages[state.marker].tables.includes('subscription_invoice_requests'))predicates.push(
    `NOT EXISTS(SELECT 1 FROM subscription_invoice_requests WHERE telegram_id=?)`,
    `NOT EXISTS(SELECT 1 FROM subscription_payment_review_settlements s
      JOIN subscription_payment_review_receipts r ON r.ledger_entry_id=s.ledger_entry_id WHERE r.telegram_id=? OR s.actor_id=?)`);
  if(LIFECYCLE_SCHEMA.stages[state.marker].tables.includes('subscription_refund_cancellations'))predicates.push(
    `NOT EXISTS(SELECT 1 FROM subscription_refund_cancellations WHERE telegram_id=? OR actor_id=?)`);
  return Object.freeze({sql:'('+schema.sql+') AND '+predicates.join(' AND '),
    params:Object.freeze([...schema.params,...Array(predicates.reduce((count,sql)=>count+(sql.match(/\?/gu)?.length??0),0)).fill(subjectId)])});
}
// Financial evidence stays immutable. Unresolved controls and raw provider
// identity require the existing support retention route, never an erase claim.
export async function inspectLifecyclePrivacyRetention(db,subjectId) {
  if(!Number.isSafeInteger(subjectId)||subjectId<=0)fail();
  const state=await inspectLifecycleSchema(db);
  const summary=Object.fromEntries([...Object.keys(fields),'paymentReviews','firstRecurringReceipts','paymentReviewReceipts',
    'invoiceRequests','paymentReviewSettlements','refundCancellations'].map(key=>[key,0]));
  if(!state.present)return Object.freeze({state,summary:Object.freeze(summary),retainedFinancial:false});
  const columns=[...Object.entries(fields).map(([key,table])=>`(SELECT COUNT(*) FROM ${table} WHERE telegram_id=?) AS ${key}`),
    `(SELECT COUNT(*) FROM payment_review_resolutions r LEFT JOIN subscription_payment_links l ON l.operation_id=r.operation_id
      LEFT JOIN payment_ledger p ON p.ledger_entry_id=r.original_payment_ledger_entry_id
      WHERE r.actor_id=? OR l.telegram_id=? OR p.telegram_id=?) AS paymentReviews`,
    `(SELECT COUNT(*) FROM subscription_provider_events WHERE actor_id=? AND telegram_id!=?) AS authoredProviderEvents`];
  const params=Array(10).fill(subjectId);
  if(state.marker!=='1.4.3-subscription-lifecycle-foundation'){
    columns.push(`(SELECT COUNT(*) FROM subscription_first_recurring_receipts r JOIN subscription_billing_contracts c
      ON c.contract_id=r.contract_id WHERE c.telegram_id=?) AS firstRecurringReceipts`,
      `(SELECT COUNT(*) FROM subscription_payment_review_receipts WHERE telegram_id=?) AS paymentReviewReceipts`);params.push(subjectId,subjectId);
  }
  if(LIFECYCLE_SCHEMA.stages[state.marker].tables.includes('subscription_invoice_requests')){
    columns.push(`(SELECT COUNT(*) FROM subscription_invoice_requests WHERE telegram_id=?) AS invoiceRequests`,
      `(SELECT COUNT(*) FROM subscription_payment_review_settlements s
        JOIN subscription_payment_review_receipts r ON r.ledger_entry_id=s.ledger_entry_id
        WHERE r.telegram_id=? OR s.actor_id=?) AS paymentReviewSettlements`);params.push(subjectId,subjectId,subjectId);
  }
  if(LIFECYCLE_SCHEMA.stages[state.marker].tables.includes('subscription_refund_cancellations')){
    columns.push(`(SELECT COUNT(*) FROM subscription_refund_cancellations WHERE telegram_id=? OR actor_id=?) AS refundCancellations`);
    params.push(subjectId,subjectId);
  }
  let row;
  try{row=await db.prepare('SELECT '+columns.join(',')).bind(...params).first();}catch{fail();}
  if(!row)fail();
  for(const key of Object.keys(summary)){
    const count=Number(row[key]??0);if(!Number.isSafeInteger(count)||count<0)fail();summary[key]=count;
  }
  summary.providerEvents+=Number(row.authoredProviderEvents??0);
  return Object.freeze({state,summary:Object.freeze(summary),retainedFinancial:Object.values(summary).some(count=>count>0)});
}
