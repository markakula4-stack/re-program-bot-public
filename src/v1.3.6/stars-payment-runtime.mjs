import {
  STARS_CURRENCY,
  STARS_MONTH_SECONDS,
  buildServerOrderSnapshot,
  buildStarsInvoicePayload,
  normalizePositiveTelegramId,
  normalizeStarsPlanCode,
  parseStarsInvoicePayload,
  readStarsCoreConfig,
  selectServerPrice,
  verifyStarsInvoicePayload,
} from "./stars-core-foundation.mjs";
import {
  hasLegacyCompatibilityEnv,
  assertLegacyCompatibilityFresh,
} from "../v1.4.1/telegram-legacy-compatibility.mjs";
import { STARS_PURCHASE_LOCK_SQL } from "../v1.4.3/payment-evidence.mjs";
import { readV143NativeReadinessConfig } from '../v1.4.3/native-readiness-config.mjs';
import { readStarsRecurringConfig } from "../v1.4.3/recurring-provider-config.mjs";
import { describeTelegramCommandError } from '../v1.4.3/telegram-command-error.mjs';

const STARS_SEND_INVOICE_TIMEOUT_MS = 8_000;
const STARS_PRECHECKOUT_ANSWER_TIMEOUT_MS = 3_000;
const STARS_TERMS_SCOPE = "stars_purchase";

function nowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function paymentError(code, message = "Telegram Stars operation rejected") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeReason(error, fallback = "stars_runtime_error") {
  return String(error?.code || error?.name || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 64);
}

function resultChanges(result) {
  return Number(result?.meta?.changes || result?.changes || 0);
}

function requireDatabase(env) {
  if (!env?.DB?.prepare || !env?.DB?.batch) {
    throw paymentError("stars_database_not_ready");
  }
  return env.DB;
}

function requireInvoiceSecret(env) {
  const secret = String(env?.STARS_INVOICE_SECRET || "");
  if (secret.length < 32) throw paymentError("invoice_secret_invalid");
  return secret;
}

function validateClock(value) {
  const timestamp = Number(value ?? nowSeconds());
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw paymentError("payment_clock_invalid");
  }
  return timestamp;
}

function validateUpdateId(value) {
  const updateId = Number(value);
  if (!Number.isSafeInteger(updateId) || updateId < 0) {
    throw paymentError("telegram_update_id_invalid");
  }
  return updateId;
}

function validateTelegramObjectId(value, code) {
  const id = String(value || "").trim();
  if (!id || id.length > 256) throw paymentError(code);
  return id;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value || "")),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function readTelegramJson(response, method, redactions) {
  let data;
  try {
    data = await response.json();
  } catch (cause) {
    const error = paymentError("telegram_response_invalid");
    error.method = method;
    error.ambiguous = true;
    error.cause = cause;
    const diagnostic = await describeTelegramCommandError(method, null, response.status, {redactions});
    if (diagnostic) Object.assign(error, diagnostic);
    throw error;
  }
  if (!response.ok || !data?.ok) {
    const status = Number(data?.error_code || response.status || 0);
    const error = paymentError(`telegram_${status || "error"}`);
    error.method = method;
    error.telegramErrorCode = status;
    const diagnostic = await describeTelegramCommandError(method, data, response.status, {redactions});
    if (diagnostic) Object.assign(error, diagnostic);
    error.retryAfter = Number(data?.parameters?.retry_after || 0);
    error.retryable = status === 429 || status >= 500;
    error.ambiguous = false;
    throw error;
  }
  return data.result;
}

export async function callStarsTelegram(
  env,
  method,
  payload,
  { timeoutMs, fetchImpl = globalThis.fetch } = {},
) {
  if (!env?.BOT_TOKEN) throw paymentError("bot_token_missing");
  if (typeof fetchImpl !== "function") throw paymentError("telegram_fetch_missing");
  const maximum = method === "answerPreCheckoutQuery"
    ? STARS_PRECHECKOUT_ANSWER_TIMEOUT_MS
    : STARS_SEND_INVOICE_TIMEOUT_MS;
  const timeout = Number.isFinite(timeoutMs)
    ? Math.max(250, Math.min(Number(timeoutMs), maximum))
    : maximum;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetchImpl(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
  } catch (cause) {
    const error = paymentError(
      controller.signal.aborted
        ? "telegram_transport_timeout"
        : "telegram_transport_failure",
    );
    error.method = method;
    error.ambiguous = true;
    error.cause = cause;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return readTelegramJson(response, method, [env.BOT_TOKEN,String(payload?.user_id??''),payload?.telegram_payment_charge_id]);
}

function starsTelegramApi(options) {
  return typeof options?.telegramApi === "function"
    ? options.telegramApi
    : callStarsTelegram;
}

async function recordPaymentEvent(env, {
  eventKey,
  orderId = null,
  telegramId = null,
  updateId = null,
  eventType,
  outcome,
  reasonCode = "",
  payloadSha256 = null,
  occurredAt,
}) {
  return requireDatabase(env).prepare(
    `INSERT OR IGNORE INTO payment_events
       (event_id, event_key, order_id, telegram_id, telegram_update_id,
        event_type, outcome, reason_code, payload_sha256,
        occurred_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      String(eventKey).slice(0, 160),
      orderId,
      telegramId,
      updateId,
      eventType,
      outcome,
      String(reasonCode || "").slice(0, 64),
      payloadSha256,
      occurredAt,
      nowSeconds(),
    )
    .run();
}

async function safelyRecordPaymentEvent(env, event) {
  try {
    await recordPaymentEvent(env, event);
  } catch {
    // A rejection answer must not be delayed or replaced by an audit failure.
  }
}

async function getPurchasePrerequisites(env, telegramId, termsRevision) {
  return requireDatabase(env).prepare(
    `SELECT users.telegram_id, users.accepted_terms, users.is_blocked,
            EXISTS (
              SELECT 1 FROM terms_acceptances acceptance
              WHERE acceptance.telegram_id = users.telegram_id
                AND acceptance.terms_revision = ?
                AND acceptance.acceptance_scope = ?
            ) AS stars_terms_accepted
     FROM users
     WHERE users.telegram_id = ?
     LIMIT 1`,
  )
    .bind(termsRevision, STARS_TERMS_SCOPE, Number(telegramId))
    .first();
}

function validatePurchasePrerequisites(row) {
  if (!row) throw paymentError("payment_user_not_found");
  if (Number(row.is_blocked) === 1) throw paymentError("payment_user_blocked");
  if (Number(row.accepted_terms) !== 1) {
    throw paymentError("general_terms_not_accepted");
  }
  if (Number(row.stars_terms_accepted) !== 1) {
    throw paymentError("stars_terms_not_accepted");
  }
}

export async function acceptStarsPurchaseTerms(env, {
  telegramId,
  telegramUpdateId,
  acceptedAt = nowSeconds(),
} = {}) {
  const database = requireDatabase(env);
  const userId = normalizePositiveTelegramId(telegramId);
  if (!userId) throw paymentError("telegram_id_invalid");
  const updateId = validateUpdateId(telegramUpdateId);
  const timestamp = validateClock(acceptedAt);
  const termsRevision = String(
    env?.STARS_TERMS_REVISION || "2026-09-10.stars-v1",
  ).trim();
  if (!/^[0-9A-Za-z._-]{8,64}$/.test(termsRevision)) {
    throw paymentError("terms_revision_invalid");
  }
  const user = await database.prepare(
    `SELECT telegram_id, accepted_terms, is_blocked
     FROM users WHERE telegram_id = ? LIMIT 1`,
  ).bind(userId).first();
  if (!user || Number(user.accepted_terms) !== 1 || Number(user.is_blocked) === 1) {
    throw paymentError("terms_acceptance_not_allowed");
  }
  const evidence = await sha256Hex(
    `${STARS_TERMS_SCOPE}\n${termsRevision}\n${userId}\n${updateId}`,
  );
  await database.prepare(
    `INSERT OR IGNORE INTO terms_acceptances
       (acceptance_id, telegram_id, terms_revision, acceptance_scope,
        evidence_sha256, telegram_update_id, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    userId,
    termsRevision,
    STARS_TERMS_SCOPE,
    evidence,
    updateId,
    timestamp,
  ).run();
  const acceptance = await database.prepare(
    `SELECT acceptance_id, telegram_id, terms_revision, accepted_at
     FROM terms_acceptances
     WHERE telegram_id = ? AND terms_revision = ?
       AND acceptance_scope = ?
     LIMIT 1`,
  ).bind(userId, termsRevision, STARS_TERMS_SCOPE).first();
  if (!acceptance) throw paymentError("terms_acceptance_not_persisted");
  return Object.freeze({ ...acceptance, accepted: true });
}

async function loadReleasedServerPrice(env, planCode, config, timestamp) {
  const query = await requireDatabase(env).prepare(
    `SELECT price_id, price_version, plan_code, currency, amount_stars,
            access_seconds, billing_mode, publication_state, terms_revision,
            valid_from, valid_until
     FROM price_book
     WHERE plan_code = ? AND billing_mode = ? AND price_version = ?
       AND access_seconds = ? AND terms_revision = ?
     ORDER BY price_id
     LIMIT 2`,
  ).bind(
    planCode,
    config.billingMode,
    config.priceVersion,
    STARS_MONTH_SECONDS,
    config.termsRevision,
  ).all();
  return selectServerPrice(query?.results || [], planCode, config, timestamp);
}

export async function getStarsPurchaseCatalog(env, {
  at = nowSeconds(),
} = {}) {
  const config = readStarsCoreConfig(env);
  const timestamp = validateClock(at);
  const database = requireDatabase(env);
  const query = await database.prepare(
    `SELECT price_id, price_version, plan_code, currency, amount_stars,
            access_seconds, billing_mode, publication_state, terms_revision,
            valid_from, valid_until
     FROM price_book
     WHERE plan_code IN ('professional', 'dragon')
       AND billing_mode = ? AND price_version = ?
       AND access_seconds = ? AND terms_revision = ?
     ORDER BY plan_code, price_id`,
  ).bind(
    config.billingMode,
    config.priceVersion,
    STARS_MONTH_SECONDS,
    config.termsRevision,
  ).all();
  const rows = query?.results || [];
  const offers = [];
  const problems = [...config.problems];
  for (const planCode of ['professional', 'dragon']) {
    try {
      const price = selectServerPrice(
        rows,
        planCode,
        { ...config, ready: true },
        timestamp,
      );
      offers.push(Object.freeze({
        planCode: price.planCode,
        amountStars: price.amountStars,
        accessSeconds: price.accessSeconds,
        billingMode: price.billingMode,
        termsRevision: price.termsRevision,
      }));
    } catch (error) {
      problems.push(`${planCode}:${safeReason(error, 'catalog_unavailable')}`);
    }
  }
  const catalogReady = offers.length === 2;
  return Object.freeze({
    paymentsEnabled: config.enabled,
    paymentsReady: config.ready && catalogReady,
    catalogReady,
    problems: Object.freeze(problems),
    offers: Object.freeze(offers),
  });
}

function invoicePresentation(price) {
  return price.planCode === "dragon"
    ? {
        title: "RE Program Dragon",
        description: "Dragon 🔴 — доступ на 30 дней без автосписания",
        label: "Dragon · 30 дней",
      }
    : {
        title: "RE Program Professional",
        description: "Professional 🔵 — доступ на 30 дней без автосписания",
        label: "Professional · 30 дней",
      };
}

export async function issueStarsInvoice(env, {
  telegramId,
  requestedPlanCode,
  telegramUpdateId,
  orderId = crypto.randomUUID(),
  createdAt = nowSeconds(),
} = {}, options = {}) {
  if (readV143NativeReadinessConfig()?.mode === 'owner_acceptance') {
    throw paymentError('native_owner_prepaid_checkout_disabled');
  }
  if (env?.V141_AUTHORIZATION_ENABLED === "true" && !hasLegacyCompatibilityEnv(env)) {
    throw paymentError("legacy_compatibility_required");
  }
  const database = requireDatabase(env);
  const config = readStarsCoreConfig(env);
  if (!config.ready) throw paymentError("stars_payments_not_ready");
  const userId = normalizePositiveTelegramId(telegramId);
  if (!userId) throw paymentError("telegram_id_invalid");
  if (hasLegacyCompatibilityEnv(env)) {
    await assertLegacyCompatibilityFresh(env, {
      family: "stars_purchase", actorId: userId, resourceRef: null,
    });
  }
  const planCode = normalizeStarsPlanCode(requestedPlanCode);
  if (!planCode) throw paymentError("plan_not_purchasable");
  const updateId = validateUpdateId(telegramUpdateId);
  const timestamp = validateClock(createdAt);
  const prerequisites = await getPurchasePrerequisites(
    env,
    userId,
    config.termsRevision,
  );
  validatePurchasePrerequisites(prerequisites);

  await database.prepare(
    `UPDATE subscription_orders
     SET order_state = 'cancelled', closed_at = ?,
         state_revision = state_revision + 1, updated_at = ?
     WHERE telegram_id = ? AND order_state IN ('created', 'precheckout_ok')
       AND expires_at <= ?`,
  ).bind(timestamp, timestamp, userId, timestamp).run();
  const existing = await database.prepare(
    `SELECT order_id, order_state, expires_at
     FROM subscription_orders
     WHERE telegram_id = ?
       AND ${STARS_PURCHASE_LOCK_SQL}
     LIMIT 1`,
  ).bind(userId, timestamp).first();
  if (existing) throw paymentError("payment_order_in_progress");

  const price = await loadReleasedServerPrice(
    env,
    planCode,
    config,
    timestamp,
  );
  const snapshot = buildServerOrderSnapshot({
    telegramId: userId,
    requestedPlanCode: planCode,
    orderId,
    nowSeconds: timestamp,
    price,
  });
  const invoicePayload = await buildStarsInvoicePayload({
    invoiceSecret: requireInvoiceSecret(env),
    orderId: snapshot.orderId,
    telegramId: userId,
    priceId: snapshot.priceId,
  });
  const payloadHash = await sha256Hex(invoicePayload);

  await database.batch([
    database.prepare(
      `INSERT INTO subscription_orders
         (order_id, telegram_id, price_id, price_version, plan_code,
          currency, amount_stars, access_seconds, billing_mode,
          terms_revision, invoice_payload, order_state,
          created_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?)`,
    ).bind(
      snapshot.orderId,
      snapshot.telegramId,
      snapshot.priceId,
      snapshot.priceVersion,
      snapshot.planCode,
      snapshot.currency,
      snapshot.amountStars,
      snapshot.accessSeconds,
      snapshot.billingMode,
      snapshot.termsRevision,
      invoicePayload,
      snapshot.createdAt,
      snapshot.expiresAt,
      snapshot.createdAt,
    ),
    database.prepare(
      `INSERT INTO payment_events
         (event_id, event_key, order_id, telegram_id, telegram_update_id,
          event_type, outcome, reason_code, payload_sha256,
          occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, 'order_created', 'accepted',
               'server_price_snapshot', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      `order:${snapshot.orderId}:created`,
      snapshot.orderId,
      userId,
      updateId,
      payloadHash,
      timestamp,
      nowSeconds(),
    ),
  ]);

  const presentation = invoicePresentation(price);
  const api = starsTelegramApi(options);
  // The order write is not permission to send an invoice later. Recheck the
  // privately bound actor at the last local boundary before Telegram.
  if (typeof options.purchaseGuard === "function") {
    await options.purchaseGuard(env, {
      telegramId: userId, requestedPlanCode: planCode,
      at: nowSeconds(), orderId: snapshot.orderId,
    });
  }
  if (hasLegacyCompatibilityEnv(env)) {
    await assertLegacyCompatibilityFresh(env, {
      family: "stars_purchase", actorId: userId, resourceRef: null,
    });
  } else if (env?.V141_AUTHORIZATION_ENABLED === "true") {
    throw paymentError("legacy_compatibility_required");
  }
  let telegramResult;
  try {
    telegramResult = await api(env, "sendInvoice", {
      chat_id: userId,
      title: presentation.title,
      description: presentation.description,
      payload: invoicePayload,
      provider_token: "",
      currency: STARS_CURRENCY,
      prices: [{ label: presentation.label, amount: price.amountStars }],
    });
  } catch (error) {
    const reason = safeReason(error, "invoice_delivery_failed");
    await safelyRecordPaymentEvent(env, {
      eventKey: `invoice:${snapshot.orderId}:error`,
      orderId: snapshot.orderId,
      telegramId: userId,
      updateId,
      eventType: "invoice_issued",
      outcome: "error",
      reasonCode: reason,
      payloadSha256: payloadHash,
      occurredAt: nowSeconds(),
    });
    if (!error?.ambiguous) {
      await database.prepare(
        `UPDATE subscription_orders
         SET order_state = 'failed', closed_at = ?,
             state_revision = state_revision + 1, updated_at = ?
         WHERE order_id = ? AND order_state = 'created'`,
      ).bind(nowSeconds(), nowSeconds(), snapshot.orderId).run();
    }
    throw error;
  }
  await recordPaymentEvent(env, {
    eventKey: `invoice:${snapshot.orderId}:issued`,
    orderId: snapshot.orderId,
    telegramId: userId,
    updateId,
    eventType: "invoice_issued",
    outcome: "accepted",
    reasonCode: "telegram_invoice_created",
    payloadSha256: payloadHash,
    occurredAt: nowSeconds(),
  });
  return Object.freeze({
    status: "issued",
    orderId: snapshot.orderId,
    planCode: snapshot.planCode,
    currency: snapshot.currency,
    amountStars: snapshot.amountStars,
    accessSeconds: snapshot.accessSeconds,
    expiresAt: snapshot.expiresAt,
    telegramMessageId: Number(telegramResult?.message_id || 0) || null,
  });
}

async function loadOrderFromPayload(env, payload) {
  const parsed = parseStarsInvoicePayload(payload);
  const order = await requireDatabase(env).prepare(
    `SELECT order_id, telegram_id, price_id, price_version, plan_code,
            currency, amount_stars, access_seconds, billing_mode,
            terms_revision, invoice_payload, order_state,
            created_at, expires_at, paid_at, applied_at
     FROM subscription_orders WHERE order_id = ? LIMIT 1`,
  ).bind(parsed.orderId).first();
  if (!order) throw paymentError("payment_order_not_found");
  if (String(order.invoice_payload) !== String(payload)) {
    throw paymentError("invoice_payload_mismatch");
  }
  await verifyStarsInvoicePayload({
    invoiceSecret: requireInvoiceSecret(env),
    payload,
    telegramId: order.telegram_id,
    priceId: order.price_id,
  });
  return order;
}

async function readReservedMonthlyTransition(env,orderId,userId) {
  return requireDatabase(env).prepare(`SELECT t.transition_id,t.state,t.revision,t.source_payment_ledger_entry_id,
    EXISTS(SELECT 1 FROM payment_ledger compensation WHERE compensation.related_ledger_entry_id=t.source_payment_ledger_entry_id
      AND compensation.entry_type IN ('refund','chargeback') AND compensation.direction='debit') AS source_compensated
    FROM subscription_package_orders m JOIN subscription_plan_transitions t ON t.transition_id=m.transition_id
    JOIN payment_ledger source ON source.ledger_entry_id=t.source_payment_ledger_entry_id
    WHERE m.order_id=? AND m.telegram_id=? AND m.billing_mode='recurring' AND m.package_code='30d'
      AND t.telegram_id=m.telegram_id AND t.to_plan=m.plan_code AND t.target_price_id=m.price_id AND t.target_price_version=m.price_version
      AND t.to_billing_mode='recurring' AND source.telegram_id=m.telegram_id AND source.entry_type='payment'
      AND source.direction='credit' AND source.currency='XTR' LIMIT 1`).bind(orderId,userId).first();
}
function reservedMonthlySourceAssertion(database,row,timestamp) {
  return database.prepare(`INSERT INTO payment_events(event_id,event_key,event_type,outcome,occurred_at,received_at)
    SELECT lower(hex(randomblob(16))),NULL,'payment_recorded','error',${timestamp},${timestamp} WHERE NOT EXISTS(
      SELECT 1 FROM subscription_plan_transitions WHERE transition_id=? AND state=? AND revision=?
        AND source_payment_ledger_entry_id=? AND (?=1 OR NOT EXISTS(SELECT 1 FROM payment_ledger compensation
          WHERE compensation.related_ledger_entry_id=source_payment_ledger_entry_id AND compensation.entry_type IN ('refund','chargeback')
            AND compensation.direction='debit')))`)
    .bind(row.transition_id,row.state,row.revision,row.source_payment_ledger_entry_id,row.state==='fulfilled'?1:0);
}

async function validatePreCheckout(env, query, timestamp, options = {}) {
  const config = readStarsCoreConfig(env);
  if (!config.ready) throw paymentError("stars_payments_not_ready");
  const queryId = validateTelegramObjectId(
    query?.id,
    "precheckout_query_id_invalid",
  );
  const userId = normalizePositiveTelegramId(query?.from?.id);
  if (!userId || query?.from?.is_bot) {
    throw paymentError("precheckout_user_invalid");
  }
  const order = await loadOrderFromPayload(env, query?.invoice_payload);
  const packageRuntime = await import('../v1.4.4/package-payment-runtime.mjs');
  if (await packageRuntime.isStoredPackageFinancialInvoice(env, query?.invoice_payload)) {
    await packageRuntime.verifyPackageFinancialIngress(env, options.financialUpdate, {
      context:options.packageFinancialContext,actor:options.packageActor,nowSec:timestamp,
    });
  }
  if (Number(order.telegram_id) !== userId) {
    throw paymentError("precheckout_user_mismatch");
  }
  if (order.currency !== STARS_CURRENCY || query?.currency !== STARS_CURRENCY) {
    throw paymentError("precheckout_currency_mismatch");
  }
  if (Number(query?.total_amount) !== Number(order.amount_stars)) {
    throw paymentError("precheckout_amount_mismatch");
  }
  if (Number(order.access_seconds) !== STARS_MONTH_SECONDS ||
      !['prepaid', 'recurring'].includes(order.billing_mode)) {
    throw paymentError("precheckout_product_not_released");
  }
  let reservedMonthlyTransition=null;
  if(order.billing_mode==='recurring' && await packageRuntime.isStoredPackageFinancialInvoice(env,query.invoice_payload)) {
    reservedMonthlyTransition=await readReservedMonthlyTransition(env,order.order_id,userId);
    if(!reservedMonthlyTransition||reservedMonthlyTransition.state!=='scheduled')throw paymentError('package_monthly_transition_unavailable');
    if(Number(reservedMonthlyTransition.source_compensated)===1)throw paymentError('package_monthly_transition_source_compensated');
  }
  if (order.billing_mode === 'recurring') {
    const recurring = readStarsRecurringConfig(env);
    if (!recurring.ready || order.terms_revision !== recurring.termsRevision ||
        Number(order.price_version) !== recurring.priceVersion) {
      throw paymentError('precheckout_product_not_released');
    }
    const contract = await loadVerifiedRecurringContract(env, order, query.invoice_payload);
    const invoice = await requireDatabase(env).prepare(
      `SELECT request_id FROM subscription_invoice_requests
       WHERE contract_id=? AND origin_order_id=? AND telegram_id=?
        AND attempted_count=1 AND state IN ('attempted','confirmed','unknown') LIMIT 1`,
    ).bind(contract.contract_id,order.order_id,userId).first();
    if (!invoice || contract.retired_at !== null) throw paymentError('precheckout_product_not_released');
  }
  if (!['created', 'precheckout_ok'].includes(String(order.order_state))) {
    throw paymentError("precheckout_order_closed");
  }
  if (Number(order.expires_at) <= timestamp) {
    throw paymentError("precheckout_order_expired");
  }
  validatePurchasePrerequisites(await getPurchasePrerequisites(
    env,
    userId,
    order.terms_revision,
  ));
  if (typeof options.purchaseGuard === "function") {
    await options.purchaseGuard(env, {
      telegramId: userId,
      requestedPlanCode: order.plan_code,
      at: timestamp,
    });
  }
  return { queryId, userId, order, reservedMonthlyTransition };
}

function preCheckoutUserMessage(reason) {
  const messages = {
    stars_payments_not_ready:
      "Оплата временно недоступна. Stars не списаны — попробуйте позже.",
    precheckout_order_expired:
      "Срок этого счёта истёк. Stars не списаны — создайте новый счёт.",
    stars_terms_not_accepted:
      "Сначала примите актуальные условия покупки. Stars не списаны.",
  };
  return messages[reason] ||
    "Не удалось безопасно проверить счёт. Stars не списаны — создайте новый.";
}

export async function handleStarsPreCheckoutQuery(
  env,
  update,
  options = {},
) {
  const packages = await import('../v1.4.4/package-payment-runtime.mjs');
  let financialObservation=null,financialTransportError=null;
  if(options.packageFinancialContext||options.packageActor) {
    try {
      financialObservation=await packages.verifyPackageFinancialIngress(env,update,{context:options.packageFinancialContext,actor:options.packageActor,nowSec:options.nowSeconds});
      env={...financialObservation.identity.env,DB:financialObservation.identity.db};
    }catch(error){financialTransportError=error;}
  }
  if (!financialTransportError && await packages.isStoredPackageInvoice(env, update?.pre_checkout_query?.invoice_payload)) {
    return packages.handlePackagePreCheckoutQuery(env, update, options);
  }
  const query = update?.pre_checkout_query;
  const updateId = validateUpdateId(update?.update_id);
  const timestamp = validateClock(options.nowSeconds);
  const queryId = validateTelegramObjectId(
    query?.id,
    "precheckout_query_id_invalid",
  );
  const queryKeyHash = await sha256Hex(queryId);
  const payloadHash = await sha256Hex(query?.invoice_payload || "");
  const api = starsTelegramApi(options);
  let validation;
  let reason = "precheckout_approved";
  try {
    if(financialTransportError)throw financialTransportError;
    const candidate = await validatePreCheckout(env, query, timestamp, {...options,financialUpdate:update});
    const database = requireDatabase(env);
    const approvalStatements = [
      database.prepare(
        `UPDATE subscription_orders
         SET order_state = 'precheckout_ok',
             precheckout_approved_at = COALESCE(precheckout_approved_at, ?),
             state_revision = CASE WHEN order_state = 'created'
               THEN state_revision + 1 ELSE state_revision END,
             updated_at = ?
         WHERE order_id = ? AND order_state IN ('created', 'precheckout_ok')
           AND telegram_id = ? AND expires_at > ?`,
      ).bind(timestamp, timestamp, candidate.order.order_id, candidate.userId, timestamp),
      database.prepare(
        `INSERT OR IGNORE INTO payment_events
           (event_id, event_key, order_id, telegram_id, telegram_update_id,
            event_type, outcome, reason_code, payload_sha256,
            occurred_at, received_at)
         SELECT ?, ?, ?, ?, ?, 'precheckout_received', 'accepted',
                 'snapshot_verified', ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM subscription_orders WHERE order_id=? AND telegram_id=?
           AND order_state='precheckout_ok' AND precheckout_approved_at IS NOT NULL
           AND expires_at>?)`,
      ).bind(
        crypto.randomUUID(),
        `precheckout:${queryKeyHash.slice(0, 32)}:received`,
        candidate.order.order_id,
        candidate.userId,
        updateId,
        payloadHash,
        timestamp,
        nowSeconds(),
        candidate.order.order_id,
        candidate.userId,
        timestamp,
      ),
      database.prepare(
        `INSERT OR IGNORE INTO payment_events
           (event_id, event_key, order_id, telegram_id, telegram_update_id,
            event_type, outcome, reason_code, payload_sha256,
            occurred_at, received_at)
         SELECT ?, ?, ?, ?, ?, 'precheckout_approved', 'accepted',
                 'snapshot_verified', ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM subscription_orders WHERE order_id=? AND telegram_id=?
           AND order_state='precheckout_ok' AND precheckout_approved_at IS NOT NULL
           AND expires_at>?)`,
      ).bind(
        crypto.randomUUID(),
        `precheckout:${queryKeyHash.slice(0, 32)}:approved`,
        candidate.order.order_id,
        candidate.userId,
        updateId,
        payloadHash,
        timestamp,
        nowSeconds(),
        candidate.order.order_id,
        candidate.userId,
        timestamp,
      ),
    ];
    if(financialObservation) {
      const proof=financialObservation.assertion;
      approvalStatements.push(database.prepare(`INSERT INTO payment_events(event_id,event_key,event_type,outcome,occurred_at,received_at)
        SELECT lower(hex(randomblob(16))),NULL,'precheckout_approved','error',${timestamp},${timestamp} WHERE NOT (${proof.sql})`).bind(...proof.params));
    }
    if(candidate.reservedMonthlyTransition)approvalStatements.push(reservedMonthlySourceAssertion(database,candidate.reservedMonthlyTransition,timestamp));
    const results=await database.batch(approvalStatements);
    // Validation in memory is not approval. A zero-row raced update or a
    // failed D1 result cannot authorize the external positive answer.
    if (!Array.isArray(results) || results.length !== approvalStatements.length ||
        results.some(result => result?.success === false || result?.error) ||
        resultChanges(results[0]) !== 1) {
      throw paymentError("precheckout_approval_not_durable");
    }
    const persisted = await database.prepare(
      `SELECT orders.order_state, orders.precheckout_approved_at,
              events.order_id, events.telegram_id, events.event_type,
              events.outcome, events.payload_sha256
       FROM subscription_orders orders JOIN payment_events events
         ON events.order_id = orders.order_id
       WHERE orders.order_id = ? AND events.event_key = ? LIMIT 1`,
    ).bind(candidate.order.order_id,
      `precheckout:${queryKeyHash.slice(0, 32)}:approved`).first();
    const received = await database.prepare(
      `SELECT order_id, telegram_id, event_type, outcome, payload_sha256
       FROM payment_events WHERE event_key = ? LIMIT 1`,
    ).bind(`precheckout:${queryKeyHash.slice(0, 32)}:received`).first();
    const matchingEvent = (event, type) => event &&
      event.order_id === candidate.order.order_id &&
      Number(event.telegram_id) === candidate.userId &&
      event.event_type === type && event.outcome === "accepted" &&
      event.payload_sha256 === payloadHash;
    if (!persisted || persisted.order_state !== "precheckout_ok" ||
        !Number.isSafeInteger(Number(persisted.precheckout_approved_at)) ||
        Number(persisted.precheckout_approved_at) < Number(candidate.order.created_at) ||
        !matchingEvent(persisted, "precheckout_approved") ||
        !matchingEvent(received, "precheckout_received")) {
      throw paymentError("precheckout_approval_not_durable");
    }
    validation = candidate;
  } catch (error) {
    validation = null;
    reason = safeReason(error, "precheckout_rejected");
    let orderId = null;
    try {
      orderId = parseStarsInvoicePayload(query?.invoice_payload).orderId;
    } catch {
      // Invalid payloads deliberately remain unlinkable to an order.
    }
    await safelyRecordPaymentEvent(env, {
      eventKey: `precheckout:${queryKeyHash.slice(0, 32)}:rejected`,
      orderId,
      telegramId: normalizePositiveTelegramId(query?.from?.id),
      updateId,
      eventType: "precheckout_rejected",
      outcome: "rejected",
      reasonCode: reason,
      payloadSha256: payloadHash,
      occurredAt: timestamp,
    });
  }

  try {
    await api(env, "answerPreCheckoutQuery", validation
      ? { pre_checkout_query_id: queryId, ok: true }
      : {
          pre_checkout_query_id: queryId,
          ok: false,
          error_message: preCheckoutUserMessage(reason),
        });
  } catch (error) {
    return Object.freeze({
      handled: true,
      approved: Boolean(validation),
      answerDelivered: false,
      reason: safeReason(error, "precheckout_answer_failed"),
    });
  }
  return Object.freeze({
    handled: true,
    approved: Boolean(validation),
    answerDelivered: true,
    reason,
    orderId: validation?.order?.order_id || null,
  });
}

function successfulPaymentFromUpdate(update) {
  const message = update?.message;
  const payment = message?.successful_payment;
  const userId = normalizePositiveTelegramId(message?.from?.id);
  if (
    !payment ||
    !userId ||
    message?.from?.is_bot ||
    message?.chat?.type !== "private" ||
    Number(message?.chat?.id) !== userId
  ) {
    throw paymentError("successful_payment_actor_invalid");
  }
  return { message, payment, userId };
}

function validateSuccessfulPayment(order, payment, userId) {
  if (Number(order.telegram_id) !== userId) {
    throw paymentError("successful_payment_user_mismatch");
  }
  if (payment.currency !== STARS_CURRENCY || order.currency !== STARS_CURRENCY) {
    throw paymentError("successful_payment_currency_mismatch");
  }
  if (Number(payment.total_amount) !== Number(order.amount_stars)) {
    throw paymentError("successful_payment_amount_mismatch");
  }
  const recurring = order.billing_mode === "recurring";
  if (Number(order.access_seconds) !== STARS_MONTH_SECONDS ||
      !["prepaid", "recurring"].includes(order.billing_mode) ||
      (recurring ? payment.is_recurring !== true ||
        (payment.is_first_recurring !== undefined && typeof payment.is_first_recurring !== "boolean") ||
        !Number.isSafeInteger(payment.subscription_expiration_date) ||
        payment.subscription_expiration_date <= STARS_MONTH_SECONDS
        : payment.is_recurring === true || payment.is_first_recurring === true ||
          payment.subscription_expiration_date !== undefined)) {
    throw paymentError("successful_payment_product_mismatch");
  }
  // Terminal post-payment states are accepted only far enough to recognize an
  // already stored charge as a replay. A new ledger entry is still restricted
  // to precheckout_ok below.
  if (![
    'precheckout_ok',
    'paid',
    'applied',
    'refunded',
    'chargeback',
    'failed',
    'cancelled',
    ...(recurring ? ['created'] : []),
  ].includes(String(order.order_state))) {
    throw paymentError("successful_payment_order_state_invalid");
  }
}

async function loadVerifiedRecurringContract(env, origin, externalPayload) {
  const contract = await requireDatabase(env).prepare(
    `SELECT * FROM subscription_billing_contracts
     WHERE origin_order_id = ? LIMIT 1`,
  ).bind(origin.order_id).first();
  if (!contract || Number(contract.telegram_id) !== Number(origin.telegram_id) ||
      contract.plan_code !== origin.plan_code || contract.price_id !== origin.price_id ||
      contract.external_invoice_payload !== externalPayload ||
      contract.external_payload_sha256 !== await sha256Hex(externalPayload) ||
      contract.currency !== origin.currency ||
      Number(contract.amount_stars) !== Number(origin.amount_stars) ||
      Number(contract.period_seconds) !== Number(origin.access_seconds) ||
      contract.terms_revision !== origin.terms_revision || contract.billing_mode !== "recurring") {
    throw paymentError("recurring_contract_binding_invalid");
  }
  const consent = await requireDatabase(env).prepare(
    `SELECT acceptance_id FROM terms_acceptances WHERE acceptance_id = ?
     AND telegram_id = ? AND terms_revision = ? AND acceptance_scope = 'stars_purchase'
     AND accepted_at <= ? LIMIT 1`,
  ).bind(contract.terms_acceptance_id, Number(origin.telegram_id),
    origin.terms_revision, Number(contract.created_at)).first();
  if (!consent) throw paymentError("recurring_contract_consent_missing");
  return contract;
}

async function prepareRecoveryOrder(env, origin, timestamp, applied = false) {
  // The provider payload has already been authenticated against origin. This
  // separate server payload is never passed to Telegram or substituted into
  // successful_payment. Reuse the historical approved snapshot time verbatim.
  const orderId = crypto.randomUUID();
  const invoicePayload = await buildStarsInvoicePayload({
    invoiceSecret: requireInvoiceSecret(env), orderId,
    telegramId: Number(origin.telegram_id), priceId: origin.price_id,
  });
  const child = { ...origin, order_id: orderId, invoice_payload: invoicePayload,
    order_state: applied ? "applied" : "precheckout_ok", paid_at: applied ? timestamp : null,
    applied_at: applied ? timestamp : null };
  return { child, statements: [requireDatabase(env).prepare(
    `INSERT INTO subscription_orders
       (order_id, telegram_id, price_id, price_version, plan_code, currency,
        amount_stars, access_seconds, billing_mode, terms_revision, invoice_payload,
        order_state, created_at, expires_at, precheckout_approved_at, paid_at, applied_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(orderId, Number(origin.telegram_id), origin.price_id, Number(origin.price_version),
    origin.plan_code, origin.currency, Number(origin.amount_stars), Number(origin.access_seconds),
    origin.billing_mode, origin.terms_revision, invoicePayload,
    applied ? "applied" : "precheckout_ok", Number(origin.created_at), Number(origin.expires_at),
    timestamp, applied ? timestamp : null, applied ? timestamp : null, timestamp)] };
}

export async function recordStarsSuccessfulPayment(
  env,
  update,
  { receivedAt = nowSeconds(), packageActor, packageFinancialContext, _packageConflictRetried = false } = {},
) {
  const packages = await import('../v1.4.4/package-payment-runtime.mjs');
  let authenticFinancialObservation=null;
  if(packageFinancialContext||packageActor) {
    authenticFinancialObservation=await packages.verifyPackageFinancialIngress(env,update,{context:packageFinancialContext,actor:packageActor,nowSec:receivedAt});
    env={...authenticFinancialObservation.identity.env,DB:authenticFinancialObservation.identity.db};
  }
  if (await packages.isStoredPackageInvoice(env, update?.message?.successful_payment?.invoice_payload)) {
    return packages.recordPackageSuccessfulPayment(env, update, { packageActor, packageFinancialContext, receivedAt });
  }
  const database = requireDatabase(env);
  const updateId = validateUpdateId(update?.update_id);
  const timestamp = validateClock(receivedAt);
  const recordedAt = Math.max(timestamp, nowSeconds());
  const { payment, userId } = successfulPaymentFromUpdate(update);
  const origin = await loadOrderFromPayload(env, payment.invoice_payload);
  validateSuccessfulPayment(origin, payment, userId);
  const reservedMonthly = origin.billing_mode === 'recurring' && await packages.isStoredPackageFinancialInvoice(env,payment.invoice_payload);
  let financialObservation = null, reservedTransition = null;
  if (reservedMonthly) {
    financialObservation = authenticFinancialObservation ?? await packages.verifyPackageFinancialIngress(env,update,{context:packageFinancialContext,actor:packageActor,nowSec:timestamp});
    reservedTransition = await readReservedMonthlyTransition(env,origin.order_id,userId);
    if(!reservedTransition)throw paymentError('package_monthly_transition_binding_invalid');
  }
  let order = origin;
  const recurring = origin.billing_mode === "recurring";
  const contract = recurring
    ? await loadVerifiedRecurringContract(env, origin, payment.invoice_payload) : null;
  const chargeId = validateTelegramObjectId(
    payment.telegram_payment_charge_id,
    "telegram_payment_charge_id_invalid",
  );
  const providerChargeId = String(payment.provider_payment_charge_id || "")
    .slice(0, 256);
  const chargeHash = await sha256Hex(chargeId);
  const payloadHash = await sha256Hex(JSON.stringify({
    currency: payment.currency,
    total_amount: Number(payment.total_amount),
    invoice_payload_sha256: await sha256Hex(payment.invoice_payload),
    telegram_payment_charge_sha256: chargeHash,
    is_recurring: recurring,
    is_first_recurring: payment.is_first_recurring === true,
    subscription_expiration_date: recurring ? payment.subscription_expiration_date : null,
  }));

  const existing = await database.prepare(
    `SELECT ledger_entry_id, order_id, telegram_id, entry_type, direction,
            currency, amount_stars, telegram_payment_charge_id, reason_code
     FROM payment_ledger
     WHERE telegram_payment_charge_id = ? AND entry_type = 'payment'
     LIMIT 1`,
  ).bind(chargeId).first();
  if (existing) {
    if (existing.reason_code === "payment_review_retained") {
      const retained = await database.prepare(
        `SELECT * FROM subscription_payment_review_receipts WHERE ledger_entry_id=? LIMIT 1`,
      ).bind(existing.ledger_entry_id).first();
      if (!retained || retained.origin_order_id !== origin.order_id ||
          existing.order_id !== origin.order_id || Number(existing.telegram_id) !== userId ||
          existing.currency !== STARS_CURRENCY || existing.direction !== "credit" ||
          Number(existing.amount_stars) !== Number(origin.amount_stars) ||
          Number(retained.telegram_id) !== userId || retained.plan_code !== origin.plan_code ||
          retained.contract_id !== (contract?.contract_id ?? null) ||
          retained.external_invoice_payload !== payment.invoice_payload ||
          retained.evidence_sha256 !== payloadHash ||
          Number(retained.is_first_recurring) !== (payment.is_first_recurring === true ? 1 : 0) ||
          (recurring && Number(retained.provider_period_end) !== payment.subscription_expiration_date)) {
        throw paymentError("payment_charge_collision");
      }
      const settlementStage = await database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='subscription_payment_review_settlements'",
      ).first();
      if (settlementStage) {
        // Owner review keeps the credit on its immutable original order. Its
        // actual child/link/grant therefore has a separate exact settlement,
        // rather than moving the ledger or applying the old origin again.
        const settled = await database.prepare(
          `SELECT child.order_id,grant_record.grant_id,grant_record.subscription_id,
            grant_record.plan_code,grant_record.starts_at,grant_record.ends_at
           FROM subscription_payment_review_settlements settlement
           JOIN subscription_payment_links link ON link.operation_id=settlement.operation_id
           JOIN subscription_orders child ON child.order_id=settlement.applied_order_id
           JOIN subscription_access_grants grant_record ON grant_record.payment_ledger_entry_id=settlement.ledger_entry_id
           JOIN subscriptions projection ON projection.subscription_id=grant_record.subscription_id
           WHERE settlement.ledger_entry_id=? AND link.ledger_entry_id=settlement.ledger_entry_id
            AND link.direction='incoming' AND link.origin_order_id=? AND link.applied_order_id=child.order_id
            AND link.provider_charge_id=? AND link.telegram_id=? AND link.plan_code=?
            AND link.external_invoice_payload=? AND link.external_payload_sha256=? AND link.evidence_sha256=?
            AND link.contract_id IS ? AND link.link_kind=?
            AND link.provider_period_start IS ? AND link.provider_period_end IS ?
            AND child.telegram_id=link.telegram_id AND child.plan_code=link.plan_code AND child.order_state='applied'
            AND child.order_id!=link.origin_order_id AND child.invoice_payload!=link.external_invoice_payload
            AND child.price_id=? AND child.price_version=? AND child.currency=? AND child.amount_stars=?
            AND child.access_seconds=? AND child.billing_mode=? AND child.terms_revision=?
            AND child.created_at=? AND child.expires_at=? AND child.applied_at IS NOT NULL
            AND grant_record.order_id=child.order_id AND grant_record.telegram_id=link.telegram_id
            AND grant_record.plan_code=link.plan_code AND grant_record.status='active'
            AND grant_record.access_seconds=child.access_seconds AND grant_record.ends_at=grant_record.starts_at+grant_record.access_seconds
            AND (?=0 OR (grant_record.starts_at=link.provider_period_start AND grant_record.ends_at=link.provider_period_end))
            AND projection.telegram_id=grant_record.telegram_id AND projection.plan_code=grant_record.plan_code
            AND projection.billing_mode=child.billing_mode AND projection.status IN ('active','cancel_at_period_end')
            AND NOT EXISTS(SELECT 1 FROM payment_ledger compensation WHERE compensation.related_ledger_entry_id=settlement.ledger_entry_id
              AND compensation.entry_type IN ('refund','chargeback') AND compensation.direction='debit') LIMIT 1`,
        ).bind(existing.ledger_entry_id,origin.order_id,chargeId,userId,origin.plan_code,
          retained.external_invoice_payload,retained.external_payload_sha256,payloadHash,retained.contract_id,
          recurring ? 'recurring_charge' : 'late_prepaid_charge',retained.provider_period_start,retained.provider_period_end,
          origin.price_id,origin.price_version,origin.currency,origin.amount_stars,origin.access_seconds,origin.billing_mode,
          origin.terms_revision,origin.created_at,origin.expires_at,recurring ? 1 : 0).first();
        if (settled) return Object.freeze({ status:'duplicate',duplicate:true,ownerReviewSettled:true,
          orderId:settled.order_id,ledgerEntryId:existing.ledger_entry_id,grantId:settled.grant_id,
          subscriptionId:settled.subscription_id,planCode:settled.plan_code,amountStars:Number(existing.amount_stars),
          periodStartsAt:settled.starts_at,periodEndsAt:settled.ends_at,accessApplied:true,reviewRequired:false });
      }
      return Object.freeze({ status: "manual_review", reason: retained.reason_code,
        orderId: origin.order_id, ledgerEntryId: existing.ledger_entry_id,
        accessApplied: false, reviewRequired: true, duplicate: true });
    }
    const link = recurring || existing.order_id !== origin.order_id
      ? await database.prepare(
        `SELECT * FROM subscription_payment_links
         WHERE provider_charge_id = ? AND direction = 'incoming' LIMIT 1`,
      ).bind(chargeId).first() : null;
    if (
      (existing.order_id !== origin.order_id && !link) ||
      Number(existing.telegram_id) !== userId ||
      existing.currency !== STARS_CURRENCY ||
      Number(existing.amount_stars) !== Number(order.amount_stars) ||
      existing.direction !== "credit" ||
      ((recurring || link) && (!link || link.origin_order_id !== origin.order_id ||
        link.applied_order_id !== existing.order_id || link.ledger_entry_id !== existing.ledger_entry_id ||
        link.external_invoice_payload !== payment.invoice_payload || link.evidence_sha256 !== payloadHash ||
        (recurring && (link.contract_id !== contract.contract_id ||
          Number(link.provider_period_end) !== payment.subscription_expiration_date))))
    ) {
      throw paymentError("payment_charge_collision");
    }
    await safelyRecordPaymentEvent(env, {
      eventKey: `update:${updateId}:payment-duplicate`,
      orderId: existing.order_id,
      telegramId: userId,
      updateId,
      eventType: "successful_payment_received",
      outcome: "ignored",
      reasonCode: "duplicate_charge",
      payloadSha256: payloadHash,
      occurredAt: timestamp,
    });
    return Object.freeze({
      status: "duplicate",
      orderId: existing.order_id,
      ledgerEntryId: existing.ledger_entry_id,
      accessApplied: false,
    });
  }

  const latePrepaid = !recurring && ['cancelled', 'failed'].includes(origin.order_state);
  const recover = latePrepaid || recurring && !['created', 'precheckout_ok'].includes(origin.order_state);
  const preparations = [];
  let recovery;
  if (recover) {
    recovery = await prepareRecoveryOrder(env, origin, timestamp);
    order = recovery.child;
    preparations.push(...recovery.statements);
  } else if (recurring && origin.order_state === "created") {
    preparations.push(database.prepare(
      `UPDATE subscription_orders SET order_state='precheckout_ok',
       precheckout_approved_at=COALESCE(precheckout_approved_at, ?),
       state_revision=state_revision+1, updated_at=? WHERE order_id=? AND order_state='created'`,
    ).bind(timestamp, timestamp, origin.order_id));
    order = { ...origin, order_state: "precheckout_ok" };
  }
  if (String(order.order_state) !== "precheckout_ok") {
    throw paymentError("payment_ledger_missing_for_paid_order");
  }
  const ledgerEntryId = crypto.randomUUID();
  let importedAccess = null;
  let reviewReason = reservedTransition?.state === 'cancelled' ? 'package_monthly_transition_cancelled' :
    reservedTransition?.state==='scheduled'&&Number(reservedTransition.source_compensated)===1?'package_monthly_transition_source_compensated':null;
  let retainedReview = false;
  let operationId = null;
  let incomingLink = null;
  if (recurring || latePrepaid) {
    operationId = crypto.randomUUID();
    incomingLink = { operation_id: operationId, contract_id: contract?.contract_id ?? null,
      origin_order_id: origin.order_id, applied_order_id: order.order_id, ledger_entry_id: ledgerEntryId,
      provider_charge_id: chargeId, telegram_id: userId, plan_code: order.plan_code,
      external_invoice_payload: payment.invoice_payload,
      external_payload_sha256: await sha256Hex(payment.invoice_payload),
      provider_period_start: recurring ? payment.subscription_expiration_date - STARS_MONTH_SECONDS : null,
      provider_period_end: recurring ? payment.subscription_expiration_date : null };
  }
  if (recurring && payment.is_first_recurring === true && !reviewReason) {
    if (contract.first_payment_ledger_entry_id || origin.order_state === "applied") {
      reviewReason = "recurring_first_charge_conflict";
    } else if (origin.order_state === "paid") {
      const pendingRenewal = await database.prepare(
        `SELECT link.provider_period_start,link.provider_period_end FROM subscription_payment_links link
         JOIN payment_ledger payment ON payment.ledger_entry_id=link.ledger_entry_id
         WHERE link.contract_id=? AND link.direction='incoming' AND link.link_kind='recurring_charge'
         AND link.applied_order_id=? AND payment.order_id=? AND payment.entry_type='payment'
         ORDER BY link.provider_period_end DESC LIMIT 1`,
      ).bind(contract.contract_id,origin.order_id,origin.order_id).first();
      if (!pendingRenewal || Number(pendingRenewal.provider_period_start) < payment.subscription_expiration_date) {
        reviewReason = "recurring_first_charge_conflict";
      }
    }
  }
  if (recover && !reviewReason) {
    try {
      const { prepareStarsImportedAccessStatements } = await import("./stars-access-runtime.mjs");
      importedAccess = await prepareStarsImportedAccessStatements(env, {
        order, ledgerEntryId, chargeId, link: incomingLink, contract,
        isFirstRecurring: payment.is_first_recurring === true, at: timestamp,
      });
      // Build the final child only once all policy checks have admitted the
      // real slice. D1 commits child+money+link+slice as one atomic result.
      preparations[0] = database.prepare(
        `INSERT INTO subscription_orders (order_id,telegram_id,price_id,price_version,plan_code,currency,
         amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,
         expires_at,precheckout_approved_at,paid_at,applied_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'applied',?,?,?,?,?,?)`,
      ).bind(order.order_id,userId,order.price_id,Number(order.price_version),order.plan_code,
        order.currency,Number(order.amount_stars),Number(order.access_seconds),order.billing_mode,
        order.terms_revision,order.invoice_payload,Number(order.created_at),Number(order.expires_at),
        timestamp,timestamp,timestamp,timestamp);
    } catch (error) {
      // Unknown policy/control/conflict still records the genuine receipt when
      // the old open-order slot permits a pending paid child. No slice or
      // applied claim is made; the existing application path returns review.
      if (!["recurring_first_payment_unverified", "recurring_command_unsettled",
        "recurring_contract_compensated", "recurring_contract_conflict",
        "paid_access_suspended", "paid_plan_transition_not_released", "recurring_package_period_conflict", "paid_package_monthly_conflict"].includes(error?.code)) throw error;
      reviewReason = error.code;
    }
  }
  if (recover && !importedAccess) {
    const occupied = await database.prepare(
      `SELECT order_id FROM subscription_orders WHERE telegram_id=?
       AND order_state IN ('created','precheckout_ok','paid') LIMIT 1`,
    ).bind(userId).first();
    if (occupied || ["recurring_first_charge_conflict", "recurring_package_period_conflict", "paid_package_monthly_conflict", "package_monthly_transition_cancelled", "package_monthly_transition_source_compensated"].includes(reviewReason)) {
      // Preserve the real charge without changing a newer invoice or pretending
      // an applied child exists. Metadata retains the exact provider interval
      // for reviewed reconciliation/refund; it is never an entitlement source.
      retainedReview = true;
      order = origin;
      preparations.length = 0;
    }
  }
  if(reservedMonthly&&['package_monthly_transition_cancelled','package_monthly_transition_source_compensated'].includes(reviewReason)) {
    retainedReview=true;order=origin;preparations.length=0;
    if(['created','precheckout_ok'].includes(origin.order_state))preparations.push(database.prepare(`UPDATE subscription_orders
      SET order_state='failed',closed_at=?,state_revision=state_revision+1,updated_at=?
      WHERE order_id=? AND order_state IN ('created','precheckout_ok')`).bind(timestamp,timestamp,origin.order_id));
  }
  const statements = [
    ...preparations,
    database.prepare(
      `INSERT OR IGNORE INTO payment_events
         (event_id, event_key, order_id, telegram_id, telegram_update_id,
          event_type, outcome, reason_code, payload_sha256,
          occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, 'successful_payment_received', 'accepted',
               ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      `update:${updateId}:successful-payment`,
      order.order_id,
      userId,
      updateId,
      retainedReview ? "payment_review_retained" : "snapshot_verified",
      payloadHash,
      timestamp,
      recordedAt,
    ),
    database.prepare(
      `INSERT OR IGNORE INTO payment_ledger
         (ledger_entry_id, idempotency_key, order_id, telegram_id,
          entry_type, direction, currency, amount_stars,
          telegram_payment_charge_id, provider_payment_charge_id,
          telegram_update_id, related_ledger_entry_id, reason_code,
          occurred_at, recorded_at)
       VALUES (?, ?, ?, ?, 'payment', 'credit', 'XTR', ?, ?, ?, ?, NULL,
               ?, ?, ?)`,
    ).bind(
      ledgerEntryId,
      `payment:${chargeHash}`,
      order.order_id,
      userId,
      Number(order.amount_stars),
      chargeId,
      providerChargeId,
      updateId,
      retainedReview ? "payment_review_retained" : "successful_payment",
      timestamp,
      recordedAt,
    ),
    database.prepare(
      `UPDATE subscription_orders
       SET order_state = 'paid', paid_at = ?,
           state_revision = state_revision + 1, updated_at = ?
       WHERE order_id = ? AND order_state = 'precheckout_ok'
         AND telegram_id = ? AND currency = 'XTR' AND amount_stars = ?`,
    ).bind(
      timestamp,
      timestamp,
      order.order_id,
      userId,
      Number(order.amount_stars),
    ),
    database.prepare(
      `INSERT OR IGNORE INTO payment_events
         (event_id, event_key, order_id, telegram_id, telegram_update_id,
          event_type, outcome, reason_code, payload_sha256,
          occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, 'payment_recorded', 'accepted',
               ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      `update:${updateId}:payment-recorded`,
      order.order_id,
      userId,
      updateId,
      retainedReview ? "payment_review_retained" : "append_only_ledger",
      payloadHash,
      timestamp,
      recordedAt,
    ),
  ];
  if (retainedReview) {
    // The origin state stays untouched, including a terminal canceled/refunded
    // state. The accepted money receipt is review only, with no grant/link.
    statements.splice(preparations.length + 2, 1);
    statements.push(database.prepare(
      `INSERT INTO subscription_payment_review_receipts
       (ledger_entry_id,origin_order_id,contract_id,telegram_id,plan_code,
        external_invoice_payload,external_payload_sha256,provider_period_start,
        provider_period_end,is_first_recurring,evidence_sha256,telegram_update_id,
        reason_code,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(ledgerEntryId,origin.order_id,contract?.contract_id ?? null,userId,origin.plan_code,
      payment.invoice_payload,await sha256Hex(payment.invoice_payload),
      recurring ? payment.subscription_expiration_date-STARS_MONTH_SECONDS : null,
      recurring ? payment.subscription_expiration_date : null,payment.is_first_recurring === true ? 1 : 0,
      payloadHash,updateId,reviewReason || "recovery_order_in_progress",recordedAt));
  } else if (recurring || latePrepaid) {
    statements.push(database.prepare(
      `INSERT INTO subscription_payment_links
       (operation_id, operation_key, provider_charge_id, provider_charge_sha256,
        direction, link_kind, contract_id, origin_order_id, applied_order_id,
        telegram_id, plan_code, external_invoice_payload, external_payload_sha256,
        ledger_entry_id, provider_period_start, provider_period_end,
        evidence_sha256, occurred_at, recorded_at)
       VALUES (?, ?, ?, ?, 'incoming', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(operationId, `incoming:${chargeHash}`, chargeId, chargeHash,
      recurring ? "recurring_charge" : "late_prepaid_charge", contract?.contract_id ?? null,
      origin.order_id, order.order_id, userId, order.plan_code, payment.invoice_payload,
      await sha256Hex(payment.invoice_payload), ledgerEntryId,
      recurring ? payment.subscription_expiration_date - STARS_MONTH_SECONDS : null,
      recurring ? payment.subscription_expiration_date : null, payloadHash, timestamp, recordedAt));
    if (recurring && payment.is_first_recurring === true) {
      statements.push(database.prepare(
        `INSERT INTO subscription_first_recurring_receipts
         (contract_id, operation_id, evidence_sha256, verified_at) VALUES (?, ?, ?, ?)`,
      ).bind(contract.contract_id, operationId, payloadHash, recordedAt),
      database.prepare(
        `UPDATE subscription_billing_contracts SET first_payment_ledger_entry_id=?,
         revision=revision+1, updated_at=? WHERE contract_id=?
         AND first_payment_ledger_entry_id IS NULL`,
      ).bind(ledgerEntryId, timestamp, contract.contract_id));
    }
  }
  if (importedAccess) {
    statements.push(...importedAccess.statements);
    // Zero-row optimistic updates are successful SQL statements. Assert the
    // real financial/application result INSIDE the transaction, so any missing
    // slice aborts and rolls back the final applied child as well as its money.
    statements.push(database.prepare(
      `INSERT INTO payment_events (event_id,event_key,event_type,outcome,occurred_at,received_at)
       SELECT ?,NULL,'access_applied','accepted',?,? WHERE NOT EXISTS (
         SELECT 1 FROM subscription_orders orders JOIN payment_ledger payment ON payment.order_id=orders.order_id
         JOIN subscription_payment_links link ON link.ledger_entry_id=payment.ledger_entry_id
         JOIN subscription_access_grants grant_record ON grant_record.payment_ledger_entry_id=payment.ledger_entry_id
         JOIN subscriptions projection ON projection.subscription_id=grant_record.subscription_id
         WHERE orders.order_id=? AND orders.order_state='applied'
          AND payment.ledger_entry_id=? AND payment.telegram_payment_charge_id=?
          AND link.applied_order_id=orders.order_id AND link.origin_order_id=?
          AND grant_record.order_id=orders.order_id AND grant_record.status='active'
          AND grant_record.telegram_id=? AND projection.telegram_id=grant_record.telegram_id
          AND projection.plan_code=grant_record.plan_code
          AND (?=0 OR EXISTS (SELECT 1 FROM subscription_first_recurring_receipts receipt
            JOIN subscription_billing_contracts contract ON contract.contract_id=receipt.contract_id
            WHERE receipt.operation_id=link.operation_id AND contract.contract_id=link.contract_id
              AND contract.first_payment_ledger_entry_id=payment.ledger_entry_id)))`
    ).bind(crypto.randomUUID(),timestamp,timestamp,order.order_id,ledgerEntryId,chargeId,origin.order_id,userId,
      recurring && payment.is_first_recurring === true ? 1 : 0));
  }
  let packageGuardCount=0;
  if(financialObservation) {
    const financialProof=financialObservation.assertion;
    statements.unshift(database.prepare(`INSERT INTO payment_events(event_id,event_key,event_type,outcome,occurred_at,received_at)
      SELECT lower(hex(randomblob(16))),NULL,'payment_recorded','error',${timestamp},${timestamp} WHERE NOT (${financialProof.sql})`).bind(...financialProof.params));
    packageGuardCount++;
    if(!retainedReview) {
      statements.unshift(reservedMonthlySourceAssertion(database,reservedTransition,timestamp));
      packageGuardCount++;
    }
  }
  let batchResults;
  try {
    batchResults = await database.batch(statements);
  } catch (error) {
    // Concurrent deliveries can both pass the first charge lookup. Re-read the
    // committed winner through the same exact payload/link collision verifier;
    // a failed import without a committed charge remains a real failure.
    const winner = await database.prepare(
      `SELECT ledger_entry_id FROM payment_ledger
       WHERE telegram_payment_charge_id=? AND entry_type='payment' LIMIT 1`,
    ).bind(chargeId).first();
    if (winner) return recordStarsSuccessfulPayment(env, update, { receivedAt: timestamp,packageActor,packageFinancialContext });
    if(reservedMonthly&&!_packageConflictRetried) {
      const changed=await readReservedMonthlyTransition(env,origin.order_id,userId);
      if(changed?.state==='cancelled'||changed?.state==='scheduled'&&Number(changed.source_compensated)===1)
        return recordStarsSuccessfulPayment(env,update,{receivedAt:timestamp,packageActor,packageFinancialContext,_packageConflictRetried:true});
    }
    if (recurring && importedAccess && !_packageConflictRetried) {
      // A future package may commit between the source read and the atomic
      // old renewal write. Verify the conflict again after rollback before
      // retrying once through the existing exact retained-credit path.
      try {
        const { prepareStarsImportedAccessStatements } = await import('./stars-access-runtime.mjs');
        await prepareStarsImportedAccessStatements(env,{order,ledgerEntryId,chargeId,link:incomingLink,contract,
          isFirstRecurring:payment.is_first_recurring===true,at:timestamp});
      } catch (observed) {
        if (['recurring_package_period_conflict','paid_package_monthly_conflict'].includes(observed?.code)) {
          return recordStarsSuccessfulPayment(env,update,{receivedAt:timestamp,packageActor,packageFinancialContext,_packageConflictRetried:true});
        }
      }
    }
    throw error;
  }

  const persisted = await database.prepare(
    `SELECT ledger_entry_id, order_id, telegram_id, amount_stars
     FROM payment_ledger
     WHERE telegram_payment_charge_id = ? AND entry_type = 'payment'
     LIMIT 1`,
  ).bind(chargeId).first();
  const paidOrder = await database.prepare(
    `SELECT order_state FROM subscription_orders
     WHERE order_id = ? LIMIT 1`,
  ).bind(order.order_id).first();
  if (
    !persisted ||
    persisted.order_id !== order.order_id ||
    Number(persisted.telegram_id) !== userId ||
    Number(persisted.amount_stars) !== Number(order.amount_stars) ||
    (!retainedReview && paidOrder?.order_state !== (importedAccess ? "applied" : "paid"))
  ) {
    throw paymentError("successful_payment_persistence_invariant");
  }
  const ledgerInserted = resultChanges(batchResults?.[packageGuardCount + preparations.length + 1]) === 1;
  if (recurring && payment.is_first_recurring === true && !retainedReview) {
    // A renewal may have arrived before the first recurring receipt. Once the
    // genuine first marker is durable, apply its already stored own charge
    // through the same verifier. It never inserts another ledger entry.
    const pending = await database.prepare(
      `SELECT orders.order_id FROM subscription_orders orders
       JOIN subscription_payment_links link ON link.applied_order_id=orders.order_id
       WHERE link.contract_id=? AND link.direction='incoming' AND orders.order_state='paid'
       AND orders.order_id!=? LIMIT 1`,
    ).bind(contract.contract_id,order.order_id).first();
    if (pending) {
      try {
        const { applyStarsPaidAccess } = await import("./stars-access-runtime.mjs");
        await applyStarsPaidAccess(env,{ orderId: pending.order_id,appliedAt: timestamp });
      } catch (error) {
        await safelyRecordPaymentEvent(env, { eventKey: `pending:${pending.order_id}:review`,
          orderId: pending.order_id,telegramId: userId,eventType: "access_apply_failed",
          outcome: "error",reasonCode: safeReason(error),occurredAt: timestamp });
      }
    }
  }
  return Object.freeze({
    status: retainedReview ? "manual_review" : ledgerInserted ? "recorded" : "duplicate",
    ...(retainedReview ? { reason: reviewReason || "recovery_order_in_progress", reviewRequired: true } : {}),
    orderId: order.order_id,
    ledgerEntryId: persisted.ledger_entry_id,
    planCode: order.plan_code,
    amountStars: Number(order.amount_stars),
    accessSeconds: Number(order.access_seconds),
    accessApplied: Boolean(importedAccess),
  });
}

export function isStarsPaymentUpdate(update) {
  return Boolean(
    update?.pre_checkout_query || update?.message?.successful_payment,
  );
}

export async function handleStarsPaymentUpdate(env, update, options = {}) {
  if (update?.pre_checkout_query) {
    return handleStarsPreCheckoutQuery(env, update, options);
  }
  if (!update?.message?.successful_payment) {
    return Object.freeze({ handled: false });
  }
  try {
    const result = await recordStarsSuccessfulPayment(env, update, {
      receivedAt: options.nowSeconds,
      packageActor: options.packageActor,
      packageFinancialContext: options.packageFinancialContext,
    });
    return Object.freeze({ handled: true, ...result });
  } catch (error) {
    const updateId = Number.isSafeInteger(Number(update?.update_id))
      ? Number(update.update_id)
      : null;
    const userId = normalizePositiveTelegramId(update?.message?.from?.id);
    const payment = update?.message?.successful_payment;
    let orderId = null;
    try {
      orderId = parseStarsInvoicePayload(payment?.invoice_payload).orderId;
    } catch {
      // Invalid payloads cannot safely be linked to an order.
    }
    await safelyRecordPaymentEvent(env, {
      eventKey: `update:${updateId ?? "invalid"}:payment-manual-review`,
      orderId,
      telegramId: userId,
      updateId,
      eventType: "successful_payment_received",
      outcome: "error",
      reasonCode: safeReason(error),
      payloadSha256: await sha256Hex(payment?.invoice_payload || ""),
      occurredAt: validateClock(options.nowSeconds),
    });
    return Object.freeze({
      handled: true,
      status: "manual_review",
      reason: safeReason(error),
      accessApplied: false,
    });
  }
}
