import { readTrustedContext, compileContextAssertions } from '../v1.4.1/trusted-context.mjs';
import { verifyStarsInvoicePayload } from '../v1.3.6/stars-core-foundation.mjs';
import { inspectLifecycleSchema, lifecycleSchemaAssertion } from './lifecycle-schema.mjs';

const CONTROL = new Set(['active', 'canceled', 'failed']);
const fail = (code, status = 403) => { throw Object.assign(new Error(code), { code, status }); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const encoder = new TextEncoder();
const digest = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const equal = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// Purpose-specific authenticated transport. The only input carrying provider
// provenance is the actual webhook Request; parsed JSON and a trusted boolean
// are never accepted as an observation. The existing service brand owns DB,
// server configuration, purpose, and time.
async function readSubscriptionRequest(request, trusted) {
  if (!(request instanceof Request) || request.method !== 'POST' ||
      new URL(request.url).pathname !== '/webhook' || new URL(request.url).search ||
      typeof trusted.env.WEBHOOK_SECRET !== 'string' || trusted.env.WEBHOOK_SECRET.length < 16 ||
      !equal(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), trusted.env.WEBHOOK_SECRET) ||
      !/^application\/json(?:\s*;|$)/iu.test(request.headers.get('Content-Type') ?? ''))
    fail('subscription_transport_untrusted');
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^[0-9]{1,6}$/u.test(length) || Number(length) > 65536))
    fail('subscription_body_invalid', 400);
  const reader = request.clone().body?.getReader();
  if (!reader) fail('subscription_body_invalid', 400);
  const chunks = []; let size = 0, timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('subscription_body_timeout'),
        { code: 'subscription_body_timeout', status: 400 })), 5000);
    });
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 65536) fail('subscription_body_invalid', 400);
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let update;
    try { update = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('subscription_body_invalid', 400); }
    if (!update || typeof update !== 'object' || Array.isArray(update) ||
        !Number.isSafeInteger(update.update_id) || update.update_id < 0) fail('subscription_update_invalid', 400);
    if (!Object.hasOwn(update, 'subscription')) return null;
    const subscription = update.subscription;
    if (!exact(update, ['update_id', 'subscription']) || !exact(subscription, ['user', 'invoice_payload', 'state']) ||
        !subscription.user || typeof subscription.user !== 'object' || Array.isArray(subscription.user) ||
        !positive(subscription.user.id) || subscription.user.is_bot !== false ||
        typeof subscription.invoice_payload !== 'string' || subscription.invoice_payload.length < 1 ||
        encoder.encode(subscription.invoice_payload).length > 128 || !CONTROL.has(subscription.state))
      fail('subscription_update_invalid', 400);
    return Object.freeze({ updateId: update.update_id, telegramId: subscription.user.id,
      payload: subscription.invoice_payload, providerState: subscription.state });
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}

async function readRows(db, sql, params, max = 2) {
  let result;
  try { result = await db.prepare(sql).bind(...params).all(); }
  catch { fail('subscription_source_unavailable', 503); }
  if (result?.success !== true || !Array.isArray(result.results) || result.results.length > max)
    fail('subscription_source_unavailable', 503);
  return result.results;
}

const CONTRACT_SCOPE = `FROM subscription_billing_contracts c
 JOIN subscription_orders o ON o.order_id=c.origin_order_id
 JOIN price_book p ON p.price_id=o.price_id AND p.price_version=o.price_version
 JOIN terms_acceptances t ON t.acceptance_id=c.terms_acceptance_id
 WHERE c.telegram_id=? AND c.external_invoice_payload=? AND c.billing_mode='recurring'
 AND o.telegram_id=c.telegram_id AND o.billing_mode=c.billing_mode AND o.plan_code=c.plan_code
 AND o.price_id=c.price_id AND o.currency=c.currency AND o.amount_stars=c.amount_stars
 AND o.access_seconds=c.period_seconds AND o.terms_revision=c.terms_revision
 AND o.invoice_payload=c.external_invoice_payload
 AND p.plan_code=o.plan_code AND p.currency=o.currency AND p.amount_stars=o.amount_stars
 AND p.access_seconds=o.access_seconds AND p.billing_mode=o.billing_mode
 AND p.terms_revision=o.terms_revision AND p.publication_state IN ('approved','retired')
 AND p.valid_from<=o.created_at AND (p.valid_until IS NULL OR p.valid_until>o.created_at)
 AND t.telegram_id=c.telegram_id AND t.terms_revision=c.terms_revision
 AND t.acceptance_scope='stars_purchase' AND t.accepted_at<=c.created_at`;
const bindingColumns = ['contract_id', 'telegram_id', 'plan_code', 'price_id', 'origin_order_id',
  'external_invoice_payload', 'external_payload_sha256', 'terms_revision', 'terms_acceptance_id',
  'billing_mode', 'period_seconds', 'currency', 'amount_stars', 'created_at'];
const providerResult = (fields, controls, pending) => {
  const states = new Set(controls.map(row => row.provider_state));
  const ambiguous = states.size > 1 || fields.identityReview;
  const unknownCommand = pending.some(command => command.state === 'unknown');
  return Object.freeze({ handled: true, status: fields.status, eventId: fields.eventId,
    contractId: fields.contractId, renewalState: ambiguous || states.size !== 1 ? 'unknown' : [...states][0],
    reviewRequired: ambiguous || unknownCommand, reasonCode: fields.reasonCode ??
      (ambiguous ? 'provider_control_order_ambiguous' : unknownCommand ? 'provider_command_unknown' : 'provider_control_recorded'),
    pendingOperations: pending.length, paidTimeChanged: false });
};

// The worker calls this before customer command dispatch, passing its original
// webhook clone and the claimed processing receipt. Terminal receipts admit
// only an exact durable duplicate or an append-only identity review.
export async function handleVerifiedTelegramSubscriptionUpdate({ webhookRequest, serviceContext,
  receiptClaimToken } = {}) {
  const trusted = readTrustedContext(serviceContext);
  if (trusted.actorKind !== 'service' || trusted.executorPurpose !== 'stars_process_event' ||
      trusted.operation !== 'service.stars.process_event') fail('subscription_service_required');
  const botId = Number(trusted.env.BOT_TOKEN?.split(':')[0]);
  if (!positive(botId) || trusted.expiresAt <= trusted.nowSeconds) fail('subscription_service_required');
  const observation = await readSubscriptionRequest(webhookRequest, trusted);
  if (!observation) return Object.freeze({ handled: false });
  const db = trusted.db, now = trusted.nowSeconds;
  const schema = await inspectLifecycleSchema(db, { required: true });
  const contracts = await readRows(db, `SELECT c.* ${CONTRACT_SCOPE} LIMIT 2`,
    [observation.telegramId, observation.payload]);
  if (contracts.length !== 1) return Object.freeze({ handled: true, status: 'ignored',
    reasonCode: 'subscription_contract_not_found', reviewRequired: false, paidTimeChanged: false });
  const contract = contracts[0];
  let signature;
  try { signature = await verifyStarsInvoicePayload({ invoiceSecret: trusted.env.STARS_INVOICE_SECRET,
    payload: observation.payload, telegramId: observation.telegramId, priceId: contract.price_id }); }
  catch { fail('subscription_binding_invalid'); }
  if (signature.orderId !== contract.origin_order_id || !positive(contract.created_at) ||
      now < contract.created_at || contract.external_payload_sha256 !== await digest(observation.payload))
    fail('subscription_binding_invalid');
  const receipts = await readRows(db, `SELECT update_id,actor_id,status,claim_token,lease_expires_at,
    received_at,completed_at FROM telegram_update_receipts WHERE update_id=? LIMIT 2`, [observation.updateId]);
  const receipt = receipts[0];
  if (receipts.length !== 1 || receipt.actor_id !== observation.telegramId ||
      !['processing', 'completed', 'failed', 'abandoned'].includes(receipt.status) ||
      receipt.status === 'processing' && (receipt.claim_token !== receiptClaimToken || receipt.lease_expires_at <= now) ||
      receipt.status === 'completed' && (!positive(receipt.completed_at) || receipt.lease_expires_at !== 0) ||
      ['failed', 'abandoned'].includes(receipt.status) && receipt.lease_expires_at !== 0)
    fail('subscription_receipt_untrusted');
  const eventKey = `telegram:subscription:${botId}:${observation.updateId}`;
  const evidenceHash = await digest(JSON.stringify({ domain: 'v1.4.3.telegram-subscription.v1',
    botId, updateId: observation.updateId, telegramId: observation.telegramId,
    contractId: contract.contract_id, payloadSha256: contract.external_payload_sha256,
    providerState: observation.providerState }));
  const prior = await readRows(db, `SELECT event_id,event_key,contract_id,telegram_id,event_type,
    source,telegram_update_id,provider_state,evidence_sha256 FROM subscription_provider_events
    WHERE event_key=? OR (telegram_update_id=? AND event_type IN ('provider_control','renewal_failed'))
    ORDER BY event_id LIMIT 3`, [eventKey, observation.updateId], 2);
  const exactDuplicate = prior.length === 1 && prior[0].event_key === eventKey && prior[0].contract_id === contract.contract_id &&
    prior[0].telegram_id === observation.telegramId && prior[0].source === 'telegram_update' &&
    prior[0].provider_state === observation.providerState && prior[0].evidence_sha256 === evidenceHash;
  const identityReview = prior.length > 0 && !exactDuplicate || receipt.status !== 'processing' && !exactDuplicate;
  const reasonCode = identityReview ? prior.length ? 'provider_update_identity_conflict' : 'provider_update_receipt_without_fact' :
    observation.providerState === 'failed' ? 'telegram_renewal_failed' : 'telegram_control_observed';
  const storedKey = identityReview ? `telegram:subscription:review:${botId}:${observation.updateId}:${evidenceHash}` : eventKey;
  const eventId = exactDuplicate ? prior[0].event_id : crypto.randomUUID();
  const contextGuard = compileContextAssertions(serviceContext);
  const receiptGuard = {
    sql: `EXISTS(SELECT 1 FROM telegram_update_receipts WHERE update_id=? AND actor_id=?
      AND status=? AND claim_token=? AND lease_expires_at=? AND received_at=? AND completed_at IS ?
      ${receipt.status === 'processing' ? 'AND lease_expires_at>unixepoch()' : ''})`,
    params: [receipt.update_id, receipt.actor_id, receipt.status, receipt.claim_token,
      receipt.lease_expires_at, receipt.received_at, receipt.completed_at],
  };
  const contractGuard = {
    sql: `EXISTS(SELECT 1 ${CONTRACT_SCOPE} AND ${bindingColumns.map(column => `c.${column} IS ?`).join(' AND ')})`,
    params: [observation.telegramId, observation.payload, ...bindingColumns.map(column => contract[column])],
  };
  const guards = [contextGuard, lifecycleSchemaAssertion(schema), receiptGuard, contractGuard];
  const guardKeys = guards.map((_, index) => `v143_subscription_${crypto.randomUUID()}_${index}`);
  const statements = guards.map((piece, index) => db.prepare(`INSERT INTO mini_app_atomic_guards
    (guard_key,precondition_ok) VALUES(?,CASE WHEN (${piece.sql}) THEN 1 ELSE 0 END)`)
    .bind(guardKeys[index], ...piece.params));
  let eventMutationIndex = null, eventChanges = 0;
  if (!exactDuplicate) {
    eventMutationIndex = statements.length;
    statements.push(db.prepare(`INSERT INTO subscription_provider_events
      (event_id,event_key,contract_id,telegram_id,event_type,source,telegram_update_id,
       provider_state,actor_type,reason_code,evidence_sha256,provider_occurred_at,received_at)
      VALUES(?,?,?, ?,?,'telegram_update',?,?,'telegram',?,?,NULL,?)
      ON CONFLICT(event_key) DO NOTHING`).bind(eventId, storedKey, contract.contract_id,
      observation.telegramId, identityReview ? 'review_observed' : observation.providerState === 'failed' ? 'renewal_failed' : 'provider_control',
      identityReview ? null : observation.updateId, observation.providerState, reasonCode, evidenceHash, now));
    if (!identityReview && receipt.status === 'processing') {
      // Compute unanimity inside the same transaction. Delivery time/update_id
      // do not select a winner. An old stored summary cannot override the
      // projector's complete append-only control facts after a conflict.
      statements.push(db.prepare(`UPDATE subscription_billing_contracts SET provider_state=?,
        auto_renew_confirmed=CASE WHEN EXISTS(SELECT 1 FROM subscription_provider_commands command
          WHERE command.contract_id=subscription_billing_contracts.contract_id
          AND command.state IN ('admitted','attempted','unknown')) THEN NULL ELSE ? END,
        last_provider_event_id=(SELECT event_id FROM subscription_provider_events WHERE event_key=?),
        revision=revision+1,updated_at=MAX(updated_at,?)
        WHERE contract_id=? AND telegram_id=? AND retired_at IS NULL
        AND last_provider_event_id IS NOT (SELECT event_id FROM subscription_provider_events WHERE event_key=?)
        AND 1=(SELECT COUNT(DISTINCT event.provider_state) FROM subscription_provider_events event
          WHERE event.contract_id=subscription_billing_contracts.contract_id AND event.telegram_id=?
          AND event.source='telegram_update' AND event.actor_type='telegram'
          AND event.event_type IN ('provider_control','renewal_failed'))`).bind(observation.providerState,
        observation.providerState === 'active' ? 1 : 0, storedKey, now, contract.contract_id,
        observation.telegramId, storedKey, observation.telegramId));
    }
  }
  statements.push(...guardKeys.map(key => db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key=?').bind(key)));
  try {
    const result = await db.batch(statements);
    if (!Array.isArray(result) || result.length !== statements.length || result.some(row => row?.success !== true))
      fail('subscription_event_persistence_failed', 503);
    if (eventMutationIndex !== null) {
      eventChanges = result[eventMutationIndex]?.meta?.changes ?? result[eventMutationIndex]?.changes ?? 0;
      if (!Number.isSafeInteger(eventChanges) || eventChanges < 0 || eventChanges > 1)
        fail('subscription_event_persistence_failed', 503);
    }
  } catch (error) {
    if (error?.code === 'subscription_event_persistence_failed') throw error;
    fail(/precondition_ok|mini_app_atomic_guards/u.test(String(error?.message))
      ? 'subscription_event_source_stale' : 'subscription_event_persistence_failed', 503);
  }
  const durable = await readRows(db, `SELECT event_id,contract_id,telegram_id,provider_state,evidence_sha256
    FROM subscription_provider_events WHERE event_key=? LIMIT 2`, [storedKey]);
  if (durable.length !== 1 || durable[0].contract_id !== contract.contract_id ||
      durable[0].telegram_id !== observation.telegramId || durable[0].provider_state !== observation.providerState ||
      durable[0].evidence_sha256 !== evidenceHash) fail('subscription_event_identity_conflict', 503);
  const [controls, pending] = await Promise.all([
    readRows(db, `SELECT DISTINCT provider_state FROM subscription_provider_events
      WHERE contract_id=? AND telegram_id=? AND source='telegram_update' AND actor_type='telegram'
      AND event_type IN ('provider_control','renewal_failed') ORDER BY provider_state LIMIT 4`,
      [contract.contract_id, observation.telegramId], 3),
    readRows(db, `SELECT state FROM subscription_provider_commands WHERE contract_id=? AND telegram_id=?
      AND state IN ('admitted','attempted','unknown') LIMIT 2`, [contract.contract_id, observation.telegramId], 1),
  ]);
  return providerResult({ status: identityReview ? 'review_required' : exactDuplicate || eventChanges === 0 ? 'duplicate' : 'recorded',
    eventId: durable[0].event_id, contractId: contract.contract_id, identityReview,
    reasonCode: identityReview ? reasonCode : undefined }, controls, pending);
}
