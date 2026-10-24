import {
  AI_FORBIDDEN_PAYMENT_FIELDS,
  STARS_CURRENCY,
  STARS_MONTH_SECONDS,
  normalizePositiveTelegramId,
  normalizeStarsPlanCode,
  parseStarsInvoicePayload,
  readStarsCoreConfig,
  validateLedgerShape,
  verifyStarsInvoicePayload,
} from "./stars-core-foundation.mjs";
import { callStarsTelegram } from "./stars-payment-runtime.mjs";
import { inspectLifecyclePrivacyRetention } from '../v1.4.3/privacy-retention.mjs';
import { cancelConfirmedRefundFutureRenewal } from '../v1.4.3/refund-contract-lifecycle.mjs';
import { readPackageSettlementSource, readPackageFinancialAccessSummary,
  inspectPackageMaintenanceSubjects, preparePackageMonthlyIntervalFence,
  readReservedMonthlyRetainedSettlementSource } from '../v1.4.4/package-settlement-runtime.mjs';
import {
  hasLegacyCompatibilityEnv,
  readLegacyCompatibilityEnv,
  assertLegacyCompatibilityFresh,
  bindConfirmedStarsRefundAccountingEnv,
  hasOwnPackageRefundCompatibilityEnv,
} from "../v1.4.1/telegram-legacy-compatibility.mjs";

const confirmedRefundEvidence = new WeakMap();

// Evidence can be read by the fixed accounting facade, but is only minted in
// requestStarsRefund after a conclusive true refundStarPayment response.
export function readConfirmedStarsRefundEvidence(evidence) {
  return evidence && typeof evidence === "object"
    ? confirmedRefundEvidence.get(evidence) ?? null : null;
}

async function assertRefundEffectFresh(env, actorId, orderId) {
  if (hasLegacyCompatibilityEnv(env)) {
    return assertLegacyCompatibilityFresh(env, {
      family: "stars_refund", actorId,
      resourceRef: { kind: "payment", key: orderId },
    });
  }
  if (env?.V141_AUTHORIZATION_ENABLED === "true") {
    throw accessError("legacy_compatibility_required");
  }
}

function mintConfirmedRefundEvidence(compatibility, original, refundId, actorId, env) {
  const evidence = Object.freeze({});
  const assertion = (sql, params) => Object.freeze({ sql, params: Object.freeze(params) });
  const assertions = Object.freeze([
    assertion(`EXISTS (SELECT 1 FROM payment_ledger WHERE ledger_entry_id=?
      AND order_id=? AND telegram_id=? AND entry_type='payment'
      AND direction='credit' AND currency='XTR' AND amount_stars=?
      AND telegram_payment_charge_id=?)`, [original.ledger_entry_id,
      original.order_id, Number(original.telegram_id), Number(original.amount_stars),
      original.telegram_payment_charge_id]),
    assertion(`EXISTS (SELECT 1 FROM subscription_orders WHERE order_id=?
      AND telegram_id=? AND price_id=? AND price_version=? AND plan_code=?
      AND currency='XTR' AND amount_stars=? AND access_seconds=?
      AND billing_mode=? AND terms_revision=? AND invoice_payload=?
      AND created_at=? AND expires_at=?
      AND order_state IN ('paid','applied','refunded'${original.package_retained_review || original.package_monthly_retained_review ? ",'failed','cancelled'" : ''}))`, [original.order_id,
      Number(original.telegram_id), original.price_id, Number(original.price_version),
      original.plan_code, Number(original.amount_stars), Number(original.access_seconds),
      original.billing_mode, original.terms_revision, original.invoice_payload,
      Number(original.order_created_at), Number(original.order_expires_at)]),
    assertion(`EXISTS (SELECT 1 FROM payment_refunds WHERE refund_id=?
      AND order_id=? AND original_ledger_entry_id=? AND telegram_id=?
      AND telegram_payment_charge_id=? AND currency='XTR' AND amount_stars=?
      AND requested_by_type='admin' AND requested_by=?
      AND status IN ('requested','manual_review','confirmed','applied'))`, [refundId,
      original.order_id, original.ledger_entry_id, Number(original.telegram_id),
      original.telegram_payment_charge_id, Number(original.amount_stars), actorId]),
    ...(original.package_schema_assertion ? [assertion(original.package_schema_assertion.sql,
      original.package_schema_assertion.params)] : []),
    ...(original.package_retained_review ? [assertion(`EXISTS (SELECT 1 FROM subscription_package_payment_reviews
      WHERE ledger_entry_id=? AND order_id=? AND telegram_id=? AND evidence_sha256=?)`,
      [original.ledger_entry_id, original.order_id, Number(original.telegram_id),
        original.package_retained_review.evidence_sha256])] : []),
    ...(original.package_monthly_retained_review?.accountingAssertions.map(piece => assertion(piece.sql, piece.params)) ?? []),
  ]);
  confirmedRefundEvidence.set(evidence, Object.freeze({
    context: compatibility?.context ?? null,
    originalBinding: compatibility?.originalBinding ?? null,
    env, actorId,
    orderId: original.order_id, chargeId: original.telegram_payment_charge_id,
    telegramId: Number(original.telegram_id), refundId, confirmedAt: nowSeconds(),
    amountStars: Number(original.amount_stars), originalLedgerEntryId: original.ledger_entry_id,
    grantId: original.grant_id ?? null, subscriptionId: original.subscription_id ?? null,
    assertions,
  }));
  return evidence;
}

const STARS_SOURCE_CODE = "stars_payment";
const STARS_REFUND_TIMEOUT_MS = 8_000;
const STARS_RECONCILIATION_TIMEOUT_MS = 10_000;
const STARS_RECONCILIATION_PAGE_LIMIT = 100;
const STARS_RECONCILIATION_MAX_PAGES = 20;
const ACTIVE_SUBSCRIPTION_STATES = Object.freeze([
  "active",
  "cancel_at_period_end",
  "suspended",
]);
const SAFE_AI_ACCESS_FIELDS = Object.freeze([
  "planCode",
  "planLabel",
  "accessState",
  "periodEndsAt",
  "remainingSeconds",
  "autoRenew",
]);

function nowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function accessError(code, message = "Telegram Stars access operation rejected") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeReason(error, fallback = "stars_access_error") {
  return String(error?.code || error?.name || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 64);
}

function requireDatabase(env) {
  if (!env?.DB?.prepare || !env?.DB?.batch) {
    throw accessError("stars_database_not_ready");
  }
  return env.DB;
}

function resultChanges(result) {
  return Number(result?.meta?.changes || result?.changes || 0);
}

function validateClock(value) {
  const timestamp = Number(value ?? nowSeconds());
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw accessError("payment_clock_invalid");
  }
  return timestamp;
}

function validateUpdateId(value, { optional = false } = {}) {
  if (optional && (value === null || value === undefined)) return null;
  const updateId = Number(value);
  if (!Number.isSafeInteger(updateId) || updateId < 0) {
    throw accessError("telegram_update_id_invalid");
  }
  return updateId;
}

function validateUuid(value, code = "identifier_invalid") {
  const id = String(value || "").toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw accessError(code);
  }
  return id;
}

function validateTelegramObjectId(value, code) {
  const id = String(value || "").trim();
  if (!id || id.length > 256) throw accessError(code);
  return id;
}

function normalizeReasonCode(value, fallback = "payment_support_approved") {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (normalized.length < 3) throw accessError("refund_reason_invalid");
  return normalized;
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

function sqlDateTime(timestamp) {
  return new Date(Number(timestamp) * 1_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

function publicDateTime(timestamp) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(Number(timestamp) * 1_000));
}

function planLabel(planCode) {
  return planCode === "dragon" ? "Dragon 🔴" :
    planCode === "professional" ? "Professional 🔵" : "Free ⚪";
}

function isMissingCompatibilitySchema(error) {
  return /no such table:\s*(?:user_plans|user_access_states|user_access)/i.test(
    String(error?.message || error),
  );
}

function isAdmin(env, telegramId) {
  const actorId = normalizePositiveTelegramId(telegramId);
  const adminId = normalizePositiveTelegramId(env?.ADMIN_ID);
  return Boolean(actorId && adminId && actorId === adminId);
}

function assertAdmin(env, telegramId) {
  const actorId = normalizePositiveTelegramId(telegramId);
  if (!actorId || !isAdmin(env, actorId)) {
    throw accessError("stars_admin_required");
  }
  return actorId;
}

export function readStarsOperationsConfig(env = {}) {
  const core = readStarsCoreConfig(env);
  const refundsEnabled = /^(?:1|true|on|yes|enabled)$/i.test(
    String(env.STARS_REFUNDS_ENABLED || ""),
  );
  const reconciliationEnabled = /^(?:1|true|on|yes|enabled)$/i.test(
    String(env.STARS_RECONCILIATION_ENABLED || ""),
  );
  return Object.freeze({
    paymentsEnabled: core.enabled,
    paymentsReady: core.ready,
    paymentProblems: core.problems,
    refundsEnabled: refundsEnabled || hasOwnPackageRefundCompatibilityEnv(env),
    reconciliationEnabled,
  });
}

async function loadCompatibilityAccess(env, telegramId) {
  try {
    return await requireDatabase(env).prepare(
      `SELECT plans.plan_code, states.access_state,
              legacy.access_tier AS legacy_access_tier
       FROM (SELECT ? AS telegram_id) subject
       LEFT JOIN user_plans plans
         ON plans.telegram_id = subject.telegram_id
       LEFT JOIN user_access_states states
         ON states.telegram_id = subject.telegram_id
       LEFT JOIN user_access legacy
         ON legacy.telegram_id = subject.telegram_id
       LIMIT 1`,
    ).bind(Number(telegramId)).first();
  } catch (error) {
    // Part 2's isolated tests deliberately do not install the v1.3.5 access
    // tables. Production and the Part 3 gate always have them.
    if (isMissingCompatibilitySchema(error)) return null;
    throw error;
  }
}

async function loadCurrentSubscription(env, telegramId) {
  return requireDatabase(env).prepare(
    `SELECT subscription_id, telegram_id, plan_code, billing_mode,
            source_order_id, status, current_period_start,
            current_period_end, auto_renew, last_ledger_entry_id,
            revision, created_at, updated_at
     FROM subscriptions
     WHERE telegram_id = ?
       AND status IN ('active', 'cancel_at_period_end', 'suspended')
     ORDER BY current_period_end DESC, created_at DESC
     LIMIT 1`,
  ).bind(Number(telegramId)).first();
}

export async function assertStarsPurchaseAllowed(env, {
  telegramId,
  requestedPlanCode,
  at = nowSeconds(),
} = {}) {
  const userId = normalizePositiveTelegramId(telegramId);
  if (!userId) throw accessError("telegram_id_invalid");
  const planCode = normalizeStarsPlanCode(requestedPlanCode);
  if (!planCode) throw accessError("plan_not_purchasable");
  const timestamp = validateClock(at);
  const packageAccess = await readPackageFinancialAccessSummary(env, userId, timestamp);
  if (packageAccess.periods.some(period => period.status === 'active' && period.endsAt > timestamp))
    throw accessError('paid_package_monthly_conflict');
  const current = await loadCurrentSubscription(env, userId);
  if (current && Number(current.current_period_end) > timestamp) {
    if (current.status === "suspended") {
      throw accessError("paid_access_suspended");
    }
    if (current.plan_code !== planCode) {
      throw accessError("paid_plan_transition_not_released");
    }
    return Object.freeze({
      allowed: true,
      mode: "renewal",
      planCode,
      currentPeriodEnd: Number(current.current_period_end),
    });
  }

  const compatibility = await loadCompatibilityAccess(env, userId);
  const legacyTier = String(compatibility?.legacy_access_tier || "")
    .trim()
    .toLowerCase();
  const accessState = String(compatibility?.access_state || "none");
  const canonicalPlan = String(compatibility?.plan_code || "free");
  if (legacyTier === "team") {
    throw accessError("legacy_team_requires_manual_review");
  }
  if (accessState === "suspended") {
    throw accessError("paid_access_suspended");
  }
  if (
    ["professional", "dragon"].includes(canonicalPlan) &&
    ["active", "cancel_at_period_end"].includes(accessState)
  ) {
    throw accessError("unmanaged_paid_access_requires_review");
  }
  return Object.freeze({ allowed: true, mode: "new_period", planCode });
}

async function recordAccessFailure(env, orderId, telegramId, error, timestamp) {
  try {
    await requireDatabase(env).prepare(
      `INSERT OR IGNORE INTO payment_events
         (event_id, event_key, order_id, telegram_id, event_type,
          outcome, reason_code, occurred_at, received_at)
       VALUES (?, ?, ?, ?, 'access_apply_failed', 'error', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      `access:${orderId}:failed`,
      orderId,
      telegramId,
      safeReason(error),
      timestamp,
      nowSeconds(),
    ).run();
  } catch {
    // The original charged-payment error must remain the primary result.
  }
}

async function loadPaymentApplication(env, orderId) {
  return requireDatabase(env).prepare(
    `SELECT orders.order_id, orders.telegram_id, orders.plan_code,
            orders.currency, orders.amount_stars, orders.access_seconds,
            orders.billing_mode, orders.order_state, orders.paid_at,
            orders.applied_at,
            payment.ledger_entry_id AS payment_ledger_entry_id,
            payment.telegram_payment_charge_id,
            payment.entry_type AS payment_entry_type,
            payment.direction AS payment_direction,
            grants.grant_id, grants.subscription_id AS grant_subscription_id,
            grants.starts_at AS grant_starts_at,
            grants.ends_at AS grant_ends_at, grants.status AS grant_status
     FROM subscription_orders orders
     LEFT JOIN payment_ledger payment
       ON payment.order_id = orders.order_id
      AND payment.entry_type = 'payment'
     LEFT JOIN subscription_access_grants grants
       ON grants.order_id = orders.order_id
     WHERE orders.order_id = ?
     LIMIT 1`,
  ).bind(orderId).first();
}

function paidApplicationResult(row, status = "applied") {
  return Object.freeze({
    status,
    orderId: row.order_id,
    subscriptionId: row.grant_subscription_id,
    grantId: row.grant_id,
    planCode: row.plan_code,
    amountStars: Number(row.amount_stars),
    periodStartsAt: Number(row.grant_starts_at),
    periodEndsAt: Number(row.grant_ends_at),
    accessApplied: true,
  });
}

async function prepareRecurringAccessStatements(env, application, timestamp, imported) {
  const database = requireDatabase(env);
  const userId = Number(application.telegram_id);
  const planCode = application.plan_code;
  const link = imported?.link ?? await database.prepare(
    `SELECT * FROM subscription_payment_links WHERE ledger_entry_id=?
     AND direction='incoming' AND link_kind='recurring_charge' LIMIT 1`,
  ).bind(application.payment_ledger_entry_id).first();
  const contract = imported?.contract ?? (link && await database.prepare(
    `SELECT * FROM subscription_billing_contracts WHERE contract_id=? LIMIT 1`,
  ).bind(link.contract_id).first());
  if (!link || !contract || link.applied_order_id !== application.order_id ||
      link.ledger_entry_id !== application.payment_ledger_entry_id ||
      link.provider_charge_id !== application.telegram_payment_charge_id ||
      Number(link.telegram_id) !== userId || Number(contract.telegram_id) !== userId ||
      link.plan_code !== planCode || contract.plan_code !== planCode ||
      Number(contract.amount_stars) !== Number(application.amount_stars) ||
      link.external_invoice_payload !== contract.external_invoice_payload ||
      link.external_payload_sha256 !== contract.external_payload_sha256 ||
      Number(link.provider_period_end) - Number(link.provider_period_start) !== STARS_MONTH_SECONDS ||
      Number(application.access_seconds) !== STARS_MONTH_SECONDS ||
      application.currency !== STARS_CURRENCY || application.payment_entry_type !== "payment" ||
      application.payment_direction !== "credit") throw accessError("recurring_payment_binding_invalid");
  const first = imported?.isFirstRecurring === true || await database.prepare(
    `SELECT receipt.contract_id FROM subscription_first_recurring_receipts receipt
     JOIN subscription_payment_links first_link ON first_link.operation_id=receipt.operation_id
     WHERE receipt.contract_id=? AND first_link.ledger_entry_id=? LIMIT 1`,
  ).bind(contract.contract_id, contract.first_payment_ledger_entry_id).first();
  if (!first) throw accessError("recurring_first_payment_unverified");
  const [policy, command, compensated, otherContract, priorAccess] = await Promise.all([
    database.prepare(`SELECT is_blocked FROM users WHERE telegram_id=?`).bind(userId).first(),
    database.prepare(`SELECT command_id FROM subscription_provider_commands WHERE contract_id=?
      AND state IN ('admitted','attempted','unknown') LIMIT 1`).bind(contract.contract_id).first(),
    database.prepare(`SELECT effect.ledger_entry_id FROM subscription_payment_links paid
      JOIN payment_ledger effect ON effect.related_ledger_entry_id=paid.ledger_entry_id
      WHERE paid.contract_id=? AND paid.direction='incoming'
      AND effect.entry_type='chargeback' LIMIT 1`).bind(contract.contract_id).first(),
    database.prepare(`SELECT contract_id FROM subscription_billing_contracts
      WHERE telegram_id=? AND retired_at IS NULL AND contract_id!=? LIMIT 1`)
      .bind(userId, contract.contract_id).first(),
    loadCompatibilityAccess(env, userId),
  ]);
  if (!policy || Number(policy.is_blocked) === 1 || priorAccess?.access_state === "suspended") {
    throw accessError("paid_access_suspended");
  }
  if (compensated) throw accessError("recurring_contract_compensated");
  if (otherContract) throw accessError("recurring_contract_conflict");
  const current = await loadCurrentSubscription(env, userId);
  if (current?.status === "suspended") throw accessError("paid_access_suspended");
  const currentContract = current && await database.prepare(
    `SELECT contract_id FROM subscription_payment_links WHERE applied_order_id=?
     AND direction='incoming' AND link_kind='recurring_charge' LIMIT 1`,
  ).bind(current.source_order_id).first();
  if (current && Number(current.current_period_end) > timestamp &&
      (current.billing_mode !== "recurring" || currentContract?.contract_id !== contract.contract_id)) {
    throw accessError("recurring_contract_conflict");
  }
  const same = currentContract?.contract_id === contract.contract_id ? current :
    await database.prepare(
      `SELECT projection.* FROM subscriptions projection JOIN subscription_payment_links first_link
       ON first_link.applied_order_id=projection.source_order_id
       WHERE first_link.contract_id=? AND first_link.direction='incoming'
       ORDER BY projection.current_period_end DESC LIMIT 1`,
    ).bind(contract.contract_id).first();
  const startsAt = Number(link.provider_period_start);
  const endsAt = Number(link.provider_period_end);
  const historical = endsAt <= timestamp || same &&
    ['active','cancel_at_period_end'].includes(same.status) && endsAt <= Number(same.current_period_end);
  const reuse = same && (historical || ['active','cancel_at_period_end'].includes(same.status));
  const subscriptionId = reuse ? same.subscription_id : crypto.randomUUID();
  const grantId = crypto.randomUUID();
  const status = endsAt <= timestamp ? "expired" :
    contract.provider_state === "canceled" ? "cancel_at_period_end" : "active";
  const controls=await database.prepare(`SELECT DISTINCT provider_state FROM subscription_provider_events
    WHERE contract_id=? AND event_type IN ('provider_control','renewal_failed') AND provider_state IS NOT NULL LIMIT 3`)
    .bind(contract.contract_id).all();
  const unambiguous=Array.isArray(controls?.results)&&controls.results.length<=1;
  const autoRenew = unambiguous && !command && contract.provider_state === "active" && Number(contract.auto_renew_confirmed) === 1 ? 1 : 0;
  const statements = await preparePackageMonthlyIntervalFence(env, { telegramId: userId,
    startsAt, endsAt, orderId: application.order_id, at: timestamp, conflictCode: 'recurring_package_period_conflict' });
  if (current && !reuse) {
    statements.push(database.prepare(
      `UPDATE subscriptions SET status='expired', revision=revision+1, updated_at=?
       WHERE subscription_id=? AND revision=? AND current_period_end<=?
       AND status IN ('active','cancel_at_period_end')`,
    ).bind(timestamp, current.subscription_id, Number(current.revision), timestamp));
  }
  if (!reuse) {
    statements.push(database.prepare(
      `INSERT INTO subscriptions (subscription_id,telegram_id,plan_code,billing_mode,
       source_order_id,telegram_payment_charge_id,status,current_period_start,current_period_end,
       auto_renew,last_ledger_entry_id,revision,created_at,updated_at)
       VALUES (?,?,?,'recurring',?,?,?,?,?,?,?,1,?,?)`,
    ).bind(subscriptionId, userId, planCode, application.order_id,
      application.telegram_payment_charge_id, status, startsAt, endsAt, autoRenew,
      application.payment_ledger_entry_id, timestamp, timestamp));
  } else if (!historical) {
    statements.push(database.prepare(
      `UPDATE subscriptions SET status=?,current_period_start=?,current_period_end=?,
       auto_renew=?,last_ledger_entry_id=?,revision=revision+1,updated_at=?
       WHERE subscription_id=? AND revision=? AND status IN ('active','cancel_at_period_end')`,
    ).bind(status, startsAt, endsAt, autoRenew, application.payment_ledger_entry_id,
      timestamp, subscriptionId, Number(same.revision)));
  }
  statements.push(database.prepare(
    `INSERT INTO subscription_access_grants (grant_id,grant_key,subscription_id,order_id,
     payment_ledger_entry_id,telegram_id,plan_code,access_seconds,starts_at,ends_at,status,
     compensation_ledger_entry_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,2592000,?,?,'active',NULL,?,?)`,
  ).bind(grantId, `access:${application.payment_ledger_entry_id}`, subscriptionId,
    application.order_id, application.payment_ledger_entry_id, userId, planCode,
    startsAt, endsAt, timestamp, timestamp),
  database.prepare(
    `UPDATE subscription_orders SET order_state='applied',applied_at=?,
     state_revision=state_revision+1,updated_at=? WHERE order_id=? AND order_state='paid'`,
  ).bind(timestamp,timestamp,application.order_id),
  database.prepare(
    `INSERT INTO subscription_status_history (event_id,event_key,subscription_id,order_id,
     telegram_id,plan_code,from_status,to_status,reason_code,actor_type,actor_id,occurred_at)
     VALUES (?,?,?,?,?,?,?,?,?,'system',NULL,?)`,
  ).bind(crypto.randomUUID(), `subscription:${subscriptionId}:order:${application.order_id}`,
    subscriptionId,application.order_id,userId,planCode,reuse ? same.status : null,
    historical && reuse ? same.status : status, historical ? "provider_historical_payment" : "provider_paid_period",timestamp),
  database.prepare(
    `INSERT INTO payment_events (event_id,event_key,order_id,telegram_id,event_type,outcome,
     reason_code,occurred_at,received_at) VALUES (?,?,?,?,'access_applied','accepted',?,?,?)`,
  ).bind(crypto.randomUUID(),`access:${application.order_id}:applied`,application.order_id,
    userId,historical ? "provider_historical_payment" : "provider_paid_period",timestamp,timestamp));
  if (!historical && endsAt > timestamp) {
    statements.push(database.prepare(
      `INSERT INTO user_plans (telegram_id,plan_code,source_code,effective_from,effective_until,revision,updated_at)
       VALUES (?,?,'stars_payment',?,?,1,CURRENT_TIMESTAMP) ON CONFLICT(telegram_id) DO UPDATE SET
       plan_code=excluded.plan_code,source_code=excluded.source_code,effective_from=excluded.effective_from,
       effective_until=excluded.effective_until,revision=user_plans.revision+1,updated_at=CURRENT_TIMESTAMP`,
    ).bind(userId,planCode,sqlDateTime(startsAt),sqlDateTime(endsAt)),
    database.prepare(
      `INSERT INTO user_access_states (telegram_id,access_state,source_code,state_started_at,state_ends_at,revision,updated_at)
       VALUES (?,?,'stars_payment',?,?,1,CURRENT_TIMESTAMP) ON CONFLICT(telegram_id) DO UPDATE SET
       access_state=excluded.access_state,source_code=excluded.source_code,state_started_at=excluded.state_started_at,
       state_ends_at=excluded.state_ends_at,revision=user_access_states.revision+1,updated_at=CURRENT_TIMESTAMP`,
    ).bind(userId,status,sqlDateTime(startsAt),sqlDateTime(endsAt)),
    database.prepare(`UPDATE trial_grants SET status='expired',ended_at=?,updated_at=?
      WHERE telegram_id=? AND program_code='dragon_preview' AND status='active'`).bind(timestamp,timestamp,userId),
    database.prepare(`UPDATE notification_jobs SET status='suppressed',last_error_code='paid_access_started',updated_at=?
      WHERE telegram_id=? AND status IN ('pending','processing')
      AND job_type IN ('preview_warning','preview_ended')`).bind(timestamp,userId));
  }
  statements.push(database.prepare(
    `INSERT INTO payment_events (event_id,event_key,event_type,outcome,occurred_at,received_at)
     SELECT ?,NULL,'access_applied','accepted',?,? WHERE NOT EXISTS (
      SELECT 1 FROM subscription_access_grants grant_record JOIN subscriptions projection
       ON projection.subscription_id=grant_record.subscription_id
      WHERE grant_record.order_id=? AND grant_record.payment_ledger_entry_id=?
       AND grant_record.status='active' AND grant_record.starts_at=? AND grant_record.ends_at=?
       AND projection.subscription_id=? AND (?=1 OR (projection.current_period_start=?
        AND projection.current_period_end=? AND projection.last_ledger_entry_id=?)))`,
  ).bind(crypto.randomUUID(),timestamp,timestamp,application.order_id,
    application.payment_ledger_entry_id,startsAt,endsAt,subscriptionId,historical ? 1 : 0,
    startsAt,endsAt,application.payment_ledger_entry_id));
  return { statements, userId, planCode, historical: Boolean(historical), subscriptionId, grantId };
}

// A statement builder for the existing writer's single D1 transaction. It does
// not write or authorize a fabricated provider update; its caller verifies the
// original external payload and builds the ledger/link before these statements.
export async function prepareStarsImportedAccessStatements(env, {
  order, ledgerEntryId, chargeId, link, contract, isFirstRecurring, at,
}) {
  return preparePaidAccessStatements(env, {
    ...order, order_state: "paid", payment_entry_type: "payment", payment_direction: "credit",
    payment_ledger_entry_id: ledgerEntryId, telegram_payment_charge_id: chargeId,
  }, validateClock(at), { link, contract, isFirstRecurring });
}

async function preparePaidAccessStatements(env, application, timestamp, imported = null) {
  const database = requireDatabase(env);
  const normalizedOrderId = application.order_id;
  if (application.billing_mode === "recurring") {
    return prepareRecurringAccessStatements(env, application, timestamp, imported);
  }
  if (
    application.payment_entry_type !== "payment" ||
    application.payment_direction !== "credit" ||
    !application.payment_ledger_entry_id ||
    !application.telegram_payment_charge_id
  ) {
    throw accessError("payment_ledger_evidence_missing");
  }
  validateLedgerShape({
    entryType: application.payment_entry_type,
    direction: application.payment_direction,
    currency: application.currency,
    amountStars: Number(application.amount_stars),
    telegramPaymentChargeId: application.telegram_payment_charge_id,
    relatedLedgerEntryId: null,
  });
  if (
    application.currency !== STARS_CURRENCY ||
    application.billing_mode !== "prepaid" ||
    Number(application.access_seconds) !== STARS_MONTH_SECONDS
  ) {
    throw accessError("paid_product_not_released");
  }

  const userId = Number(application.telegram_id);
  const planCode = String(application.plan_code);
  const priorAccess = await loadCompatibilityAccess(env, userId);
  const subjectPolicy = await database.prepare(
    `SELECT is_blocked FROM users WHERE telegram_id=? LIMIT 1`,
  ).bind(userId).first();
  if (!subjectPolicy || Number(subjectPolicy.is_blocked) === 1 || priorAccess?.access_state === "suspended") {
    throw accessError("paid_access_suspended");
  }
  const fromAccessState = [
    "none", "trial", "active", "cancel_at_period_end", "expired",
    "refunded", "suspended",
  ].includes(String(priorAccess?.access_state || ""))
    ? String(priorAccess.access_state)
    : "none";
  const current = await loadCurrentSubscription(env, userId);
  let subscriptionId;
  let startsAt;
  let endsAt;
  let applicationMode;
  let staleCurrent = null;

  if (current && Number(current.current_period_end) > timestamp) {
    if (current.status === "suspended") {
      throw accessError("paid_access_suspended");
    }
    if (current.plan_code !== planCode) {
      throw accessError("paid_plan_transition_not_released");
    }
    subscriptionId = String(current.subscription_id);
    startsAt = Number(current.current_period_end);
    endsAt = startsAt + Number(application.access_seconds);
    applicationMode = "renewal";
  } else {
    if (current) staleCurrent = current;
    subscriptionId = crypto.randomUUID();
    startsAt = timestamp;
    endsAt = timestamp + Number(application.access_seconds);
    applicationMode = "activation";
  }
  const grantId = crypto.randomUUID();
  const startedSql = sqlDateTime(timestamp);
  const endsSql = sqlDateTime(endsAt);
  const statements = await preparePackageMonthlyIntervalFence(env, { telegramId: userId,
    startsAt, endsAt, orderId: application.order_id, at: timestamp, conflictCode: 'paid_package_monthly_conflict' });

  if (staleCurrent) {
    statements.push(
      database.prepare(
        `UPDATE subscriptions
         SET status = 'expired', revision = revision + 1, updated_at = ?
         WHERE subscription_id = ? AND revision = ?
           AND status IN ('active', 'cancel_at_period_end', 'suspended')
           AND current_period_end <= ?`,
      ).bind(
        timestamp,
        staleCurrent.subscription_id,
        Number(staleCurrent.revision),
        timestamp,
      ),
      database.prepare(
        `INSERT INTO subscription_status_history
           (event_id, event_key, subscription_id, order_id, telegram_id,
            plan_code, from_status, to_status, reason_code, actor_type,
            actor_id, occurred_at)
         SELECT ?, ?, subscription_id, source_order_id, telegram_id,
                plan_code, status, 'expired', 'period_elapsed', 'system',
                NULL, ?
         FROM subscriptions
         WHERE subscription_id = ? AND status = 'expired'
           AND current_period_end <= ?`,
      ).bind(
        crypto.randomUUID(),
        `subscription:${staleCurrent.subscription_id}:expired:${timestamp}`,
        timestamp,
        staleCurrent.subscription_id,
        timestamp,
      ),
    );
  }

  if (applicationMode === "renewal") {
    statements.push(
      database.prepare(
        `UPDATE subscriptions
         SET status = 'active', current_period_end = ?,
             last_ledger_entry_id = ?, revision = revision + 1,
             updated_at = ?
         WHERE subscription_id = ? AND telegram_id = ? AND plan_code = ?
           AND revision = ? AND current_period_end = ?
           AND status IN ('active', 'cancel_at_period_end')`,
      ).bind(
        endsAt,
        application.payment_ledger_entry_id,
        timestamp,
        subscriptionId,
        userId,
        planCode,
        Number(current.revision),
        startsAt,
      ),
    );
  } else {
    statements.push(
      database.prepare(
        `INSERT INTO subscriptions
           (subscription_id, telegram_id, plan_code, billing_mode,
            source_order_id, telegram_payment_charge_id, status,
            current_period_start, current_period_end, auto_renew,
            last_ledger_entry_id, revision, created_at, updated_at)
         VALUES (?, ?, ?, 'prepaid', ?, ?, 'active', ?, ?, 0, ?, 1, ?, ?)`,
      ).bind(
        subscriptionId,
        userId,
        planCode,
        normalizedOrderId,
        application.telegram_payment_charge_id,
        startsAt,
        endsAt,
        application.payment_ledger_entry_id,
        timestamp,
        timestamp,
      ),
    );
  }

  statements.push(
    database.prepare(
      `INSERT INTO subscription_access_grants
         (grant_id, grant_key, subscription_id, order_id,
          payment_ledger_entry_id, telegram_id, plan_code, access_seconds,
          starts_at, ends_at, status, compensation_ledger_entry_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
    ).bind(
      grantId,
      `access:${application.payment_ledger_entry_id}`,
      subscriptionId,
      normalizedOrderId,
      application.payment_ledger_entry_id,
      userId,
      planCode,
      Number(application.access_seconds),
      startsAt,
      endsAt,
      timestamp,
      timestamp,
    ),
    database.prepare(
      `UPDATE subscription_orders
       SET order_state = 'applied', applied_at = ?,
           state_revision = state_revision + 1, updated_at = ?
       WHERE order_id = ? AND order_state = 'paid' AND telegram_id = ?`,
    ).bind(timestamp, timestamp, normalizedOrderId, userId),
    database.prepare(
      `INSERT INTO subscription_status_history
         (event_id, event_key, subscription_id, order_id, telegram_id,
          plan_code, from_status, to_status, reason_code, actor_type,
          actor_id, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, 'system', NULL, ?)`,
    ).bind(
      crypto.randomUUID(),
      `subscription:${subscriptionId}:order:${normalizedOrderId}`,
      subscriptionId,
      normalizedOrderId,
      userId,
      planCode,
      applicationMode === "renewal" ? String(current.status) : null,
      applicationMode === "renewal" ? "payment_renewal" : "payment_activation",
      timestamp,
    ),
    database.prepare(
      `INSERT INTO payment_events
         (event_id, event_key, order_id, telegram_id, event_type,
          outcome, reason_code, occurred_at, received_at)
       VALUES (?, ?, ?, ?, 'access_applied', 'accepted', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      `access:${normalizedOrderId}:applied`,
      normalizedOrderId,
      userId,
      applicationMode === "renewal" ? "payment_renewal" : "payment_activation",
      timestamp,
      nowSeconds(),
    ),
    database.prepare(
      `INSERT INTO user_plans
         (telegram_id, plan_code, source_code, effective_from,
          effective_until, revision, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(telegram_id) DO UPDATE SET
         plan_code = excluded.plan_code,
         source_code = excluded.source_code,
         effective_from = excluded.effective_from,
         effective_until = excluded.effective_until,
         revision = user_plans.revision + 1,
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(userId, planCode, STARS_SOURCE_CODE, startedSql, endsSql),
    database.prepare(
      `INSERT INTO user_access_states
         (telegram_id, access_state, source_code, state_started_at,
          state_ends_at, revision, updated_at)
       VALUES (?, 'active', ?, ?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(telegram_id) DO UPDATE SET
         access_state = 'active', source_code = excluded.source_code,
         state_started_at = excluded.state_started_at,
         state_ends_at = excluded.state_ends_at,
         revision = user_access_states.revision + 1,
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(userId, STARS_SOURCE_CODE, startedSql, endsSql),
    database.prepare(
      `INSERT OR IGNORE INTO access_status_history
         (event_id, telegram_id, plan_code, from_state, to_state,
          source_code, related_grant_id, occurred_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).bind(
      `stars-access:${grantId}`,
      userId,
      planCode,
      fromAccessState,
      STARS_SOURCE_CODE,
      grantId,
      timestamp,
    ),
    // A paid period supersedes Dragon Preview without erasing its one-use
    // evidence. Pending Preview messages are suppressed.
    database.prepare(
      `UPDATE trial_grants
       SET status = 'expired', ended_at = ?, updated_at = ?
       WHERE telegram_id = ? AND program_code = 'dragon_preview'
         AND status = 'active'`,
    ).bind(timestamp, timestamp, userId),
    database.prepare(
      `UPDATE notification_jobs
       SET status = 'suppressed', last_error_code = 'paid_access_started',
           updated_at = ?
       WHERE telegram_id = ? AND status IN ('pending', 'processing')
         AND job_type IN ('preview_warning', 'preview_ended')`,
    ).bind(timestamp, userId),
    database.prepare(
      `INSERT OR IGNORE INTO trial_funnel_events
         (event_id, telegram_id, program_code, event_type,
          related_grant_id, occurred_at)
       SELECT 'preview-paid:' || grant_id, telegram_id, program_code,
              'preview_expired', grant_id, ?
       FROM trial_grants
       WHERE telegram_id = ? AND program_code = 'dragon_preview'
         AND status = 'expired' AND ended_at = ?`,
    ).bind(timestamp, userId, timestamp),
    database.prepare(
      `UPDATE user_access
       SET access_tier = 'free', trial_used = 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND access_tier = 'trial'`,
    ).bind(userId),
  );

  return { statements, userId, planCode, subscriptionId, grantId };
}

export async function applyStarsPaidAccess(env, {
  orderId,
  appliedAt = nowSeconds(),
} = {}) {
  const database = requireDatabase(env);
  const normalizedOrderId = validateUuid(orderId, "order_id_invalid");
  const timestamp = validateClock(appliedAt);
  const packageSchema = await database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='subscription_package_orders'").first();
  if (packageSchema) {
    const metadata = await database.prepare('SELECT billing_mode FROM subscription_package_orders WHERE order_id=? LIMIT 1')
      .bind(normalizedOrderId).first();
    if (metadata?.billing_mode === 'prepaid') {
      const { applyVerifiedPackagePaidAccess } = await import('../v1.4.4/package-payment-runtime.mjs');
      return applyVerifiedPackagePaidAccess(env, { orderId: normalizedOrderId, appliedAt: timestamp });
    }
  }
  let application = await loadPaymentApplication(env, normalizedOrderId);
  if (!application) throw accessError("payment_order_not_found");
  if (
    application.order_state === "applied" &&
    application.grant_id &&
    application.grant_status === "active"
  ) {
    return paidApplicationResult(application, "duplicate");
  }
  if (application.order_state !== "paid") {
    throw accessError("payment_not_ready_for_access");
  }
  const { statements, userId, planCode, historical = false } = await preparePaidAccessStatements(env, application, timestamp);

  try {
    await database.batch(statements);
  } catch (error) {
    application = await loadPaymentApplication(env, normalizedOrderId);
    if (
      application?.order_state === "applied" &&
      application?.grant_id &&
      application?.grant_status === "active"
    ) {
      return paidApplicationResult(application, "duplicate");
    }
    await recordAccessFailure(env, normalizedOrderId, userId, error, timestamp);
    throw error;
  }

  application = await loadPaymentApplication(env, normalizedOrderId);
  const projection = await database.prepare(
    `SELECT plan_code, access_state
     FROM user_plans JOIN user_access_states USING (telegram_id)
     WHERE telegram_id = ? LIMIT 1`,
  ).bind(userId).first();
  if (
    !application?.grant_id ||
    application.order_state !== "applied" ||
    application.grant_status !== "active" ||
    (!historical && (projection?.plan_code !== planCode ||
      !["active", ...(application.billing_mode === "recurring" ? ["cancel_at_period_end"] : [])]
        .includes(projection?.access_state)))
  ) {
    const error = accessError("access_application_invariant_failed");
    await recordAccessFailure(env, normalizedOrderId, userId, error, timestamp);
    throw error;
  }
  return paidApplicationResult(application, "applied");
}

export async function expireStarsPaidAccess(env, {
  telegramId,
  at = nowSeconds(),
} = {}) {
  const database = requireDatabase(env);
  const userId = normalizePositiveTelegramId(telegramId);
  if (!userId) throw accessError("telegram_id_invalid");
  const timestamp = validateClock(at);
  const current = await loadCurrentSubscription(env, userId);
  if (!current || Number(current.current_period_end) > timestamp) {
    return Object.freeze({ changed: false, reason: "not_due" });
  }
  // This immutable event is the transaction's private expiry claim. Only the
  // still-due captured revision can create it. Every dependent projection and
  // history write uses the same claim, so a renewal committed before this batch
  // makes the WHOLE expiry a no-op, not merely its first UPDATE.
  const eventId = crypto.randomUUID();
  const claimed = `EXISTS (SELECT 1 FROM subscription_status_history WHERE event_id = ?)`;
  const result = await database.batch([
    database.prepare(
      `INSERT OR IGNORE INTO subscription_status_history
         (event_id, event_key, subscription_id, order_id, telegram_id,
          plan_code, from_status, to_status, reason_code, actor_type,
          actor_id, occurred_at)
       SELECT ?, ?, subscription_id, source_order_id, telegram_id,
              plan_code, status, 'expired', 'period_elapsed', 'system', NULL, ?
       FROM subscriptions
       WHERE subscription_id = ? AND revision = ?
         AND status IN ('active', 'cancel_at_period_end', 'suspended')
         AND current_period_end = ? AND current_period_end <= ?`,
    ).bind(
      eventId,
      `subscription:${current.subscription_id}:expired:${timestamp}`,
      timestamp,
      current.subscription_id,
      Number(current.revision),
      Number(current.current_period_end),
      timestamp,
    ),
    database.prepare(
      `UPDATE subscriptions
       SET status = 'expired', revision = revision + 1, updated_at = ?
       WHERE subscription_id = ? AND revision = ?
         AND status IN ('active', 'cancel_at_period_end', 'suspended')
         AND current_period_end <= ? AND ${claimed}`,
    ).bind(timestamp, current.subscription_id, Number(current.revision), timestamp, eventId),
    database.prepare(
      `UPDATE user_plans
       SET plan_code = 'free', source_code = 'stars_period_ended',
           effective_from = ?, effective_until = NULL,
           revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND ${claimed}`,
    ).bind(sqlDateTime(timestamp), userId, eventId),
    database.prepare(
      `UPDATE user_access_states
       SET access_state = 'expired', source_code = 'stars_period_ended',
           state_ends_at = ?, revision = revision + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND ${claimed}`,
    ).bind(sqlDateTime(Number(current.current_period_end)), userId, eventId),
    database.prepare(
      `INSERT OR IGNORE INTO access_status_history
         (event_id, telegram_id, plan_code, from_state, to_state,
          source_code, related_grant_id, occurred_at)
       SELECT ?, ?, ?, ?, 'expired', 'stars_period_ended', ?, ? WHERE ${claimed}`,
    ).bind(
      `stars-expired:${current.subscription_id}`,
      userId,
      current.plan_code,
      current.status === "suspended" ? "suspended" : "active",
      current.subscription_id,
      timestamp,
      eventId,
    ),
    database.prepare(
      `UPDATE user_access SET access_tier = 'free', updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND access_tier = 'trial' AND ${claimed}`,
    ).bind(userId, eventId),
  ]);
  const changed = resultChanges(result?.[1]) === 1;
  return Object.freeze({
    changed,
    reason: changed ? "expired" : "stale",
    planCode: current.plan_code,
    periodEndedAt: Number(current.current_period_end),
  });
}

export async function runStarsAccessMaintenance(env, {
  at = nowSeconds(),
  limit = 100,
} = {}) {
  const timestamp = validateClock(at);
  const maximum = Number(limit);
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 500) {
    throw accessError("stars_maintenance_limit_invalid");
  }
  const due = await requireDatabase(env).prepare(
    `SELECT telegram_id
     FROM subscriptions
     WHERE status IN ('active', 'cancel_at_period_end', 'suspended')
       AND current_period_end <= ?
     ORDER BY current_period_end, telegram_id
     LIMIT ?`,
  ).bind(timestamp, maximum).all();
  let expired = 0;
  for (const row of due?.results || []) {
    const result = await expireStarsPaidAccess(env, {
      telegramId: Number(row.telegram_id),
      at: timestamp,
    });
    if (result.changed) expired += 1;
  }
  const packages = await inspectPackageMaintenanceSubjects(env, {
    at: timestamp, limit: maximum, readAccess: readPackageFinancialAccessSummary,
  });
  return Object.freeze({
    scanned: Number(due?.results?.length || 0),
    expired,
    hasMore: Number(due?.results?.length || 0) === maximum || packages.hasMore,
    packageSubjectsVerified: packages.scanned,
    currentPackageSubjects: packages.current,
  });
}

async function loadOriginalPayment(env, chargeId) {
  const original = await requireDatabase(env).prepare(
    `SELECT payment.ledger_entry_id, payment.order_id, payment.telegram_id,
            payment.currency, payment.amount_stars,
            payment.telegram_payment_charge_id, payment.occurred_at,
            payment.recorded_at, payment.telegram_update_id, payment.entry_type, payment.direction,
            payment.related_ledger_entry_id, payment.reason_code,
            payment.reason_code AS payment_reason_code,
            orders.plan_code, orders.access_seconds, orders.order_state,
            orders.invoice_payload, orders.price_id, orders.price_version,
            orders.billing_mode, orders.terms_revision,
            orders.created_at AS order_created_at,
            orders.expires_at AS order_expires_at,
            grants.grant_id, grants.subscription_id, grants.starts_at,
            grants.ends_at, grants.status AS grant_status,
            subscriptions.status AS subscription_status,
            subscriptions.current_period_start,
            subscriptions.current_period_end,
            subscriptions.revision AS subscription_revision
     FROM payment_ledger payment
     JOIN subscription_orders orders ON orders.order_id = payment.order_id
     LEFT JOIN subscription_access_grants grants
       ON grants.payment_ledger_entry_id = payment.ledger_entry_id
     LEFT JOIN subscriptions
       ON subscriptions.subscription_id = grants.subscription_id
     WHERE payment.telegram_payment_charge_id = ?
       AND payment.entry_type = 'payment' AND payment.direction = 'credit'
     LIMIT 1`,
  ).bind(chargeId).first();
  if (!original) return null;
  const packageSource = await readPackageSettlementSource(env, original);
  if (!packageSource) return original;
  const packageRetainedReview = original.payment_reason_code === 'package_payment_review_retained'
    ? await (await import('../v1.4.4/package-payment-runtime.mjs')).readPackageRetainedReview(env, original) : null;
  const packageMonthlyRetainedReview = packageSource.metadata.billing_mode === 'recurring' && original.payment_reason_code === 'payment_review_retained'
    ? await readReservedMonthlyRetainedSettlementSource(env, original, packageSource) : null;
  return { ...original, package_metadata: packageSource.metadata,
    package_schema_assertion: packageSource.schemaAssertion,
    package_retained_review: packageRetainedReview,
    package_monthly_retained_review: packageMonthlyRetainedReview,
    package_period_id: packageSource.period?.period_id ?? null,
    package_starts_at: packageSource.period?.starts_at ?? null,
    package_ends_at: packageSource.period?.ends_at ?? null };
}

async function settleExistingRefundRecord(env, refundId, timestamp) {
  if (!refundId) return;
  const database = requireDatabase(env);
  const recordedAt = Math.max(timestamp, nowSeconds());
  const row = await database.prepare(
    `SELECT status FROM payment_refunds WHERE refund_id = ? LIMIT 1`,
  ).bind(refundId).first();
  if (!row || row.status === "applied") return;
  if (["requested", "manual_review"].includes(row.status)) {
    await database.prepare(
      `UPDATE payment_refunds
       SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, ?),
           revision = revision + 1, error_code = '', updated_at = MAX(updated_at, ?)
       WHERE refund_id = ? AND status IN ('requested', 'manual_review')`,
    ).bind(timestamp, recordedAt, refundId).run();
  }
  await database.prepare(
    `UPDATE payment_refunds
     SET status = 'applied', applied_at = COALESCE(applied_at, ?),
         revision = revision + 1, updated_at = MAX(updated_at, ?)
     WHERE refund_id = ? AND status = 'confirmed'`,
  ).bind(timestamp, recordedAt, refundId).run();
}

export async function applyStarsCompensation(env, {
  telegramPaymentChargeId,
  compensationType,
  occurredAt = nowSeconds(),
  telegramUpdateId = null,
  refundId = null,
  reasonCode,
} = {}) {
  const database = requireDatabase(env);
  const chargeId = validateTelegramObjectId(
    telegramPaymentChargeId,
    "telegram_payment_charge_id_invalid",
  );
  const type = String(compensationType || "");
  if (!['refund', 'chargeback'].includes(type)) {
    throw accessError("compensation_type_invalid");
  }
  const timestamp = validateClock(occurredAt);
  // A provider refund may precede the delayed access application. Keep its
  // financial event date, while mutable rows record processing monotonically.
  const recordedAt = Math.max(timestamp, nowSeconds());
  const updateId = validateUpdateId(telegramUpdateId, { optional: true });
  const reason = normalizeReasonCode(
    reasonCode,
    type === "chargeback" ? "chargeback_observed" : "refund_confirmed",
  );
  const original = await loadOriginalPayment(env, chargeId);
  if (!original) throw accessError("original_payment_not_found");
  let retainedReview = false;
  if (original.payment_reason_code === 'package_payment_review_retained') {
    if (!original.package_retained_review) throw accessError('package_payment_review_receipt_binding_invalid');
    retainedReview = true;
  }
  if (original.payment_reason_code === "payment_review_retained") {
    const receipt = await database.prepare(
      `SELECT ledger_entry_id FROM subscription_payment_review_receipts
       WHERE ledger_entry_id=? AND origin_order_id=? AND telegram_id=? LIMIT 1`,
    ).bind(original.ledger_entry_id,original.order_id,Number(original.telegram_id)).first();
    if (!receipt) throw accessError("payment_review_receipt_binding_invalid");
    retainedReview = true;
  }
  const existing = await database.prepare(
    `SELECT ledger_entry_id FROM payment_ledger
     WHERE telegram_payment_charge_id = ? AND entry_type = ? LIMIT 1`,
  ).bind(chargeId, type).first();
  if (existing) {
    if (type === "refund") {
      await settleExistingRefundRecord(env, refundId, timestamp);
    }
    return Object.freeze({
      status: "duplicate",
      compensationType: type,
      ledgerEntryId: existing.ledger_entry_id,
      orderId: original.order_id,
      accessChanged: false,
    });
  }

  validateLedgerShape({
    entryType: type,
    direction: "debit",
    currency: original.currency,
    amountStars: Number(original.amount_stars),
    telegramPaymentChargeId: chargeId,
    relatedLedgerEntryId: original.ledger_entry_id,
  });
  const compensationLedgerId = crypto.randomUUID();
  const chargeHash = await sha256Hex(chargeId);
  const statements = [
    database.prepare(
      `INSERT INTO payment_ledger
         (ledger_entry_id, idempotency_key, order_id, telegram_id,
          entry_type, direction, currency, amount_stars,
          telegram_payment_charge_id, telegram_update_id,
          related_ledger_entry_id, reason_code, occurred_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, 'debit', 'XTR', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      compensationLedgerId,
      `${type}:${chargeHash}`,
      original.order_id,
      Number(original.telegram_id),
      type,
      Number(original.amount_stars),
      chargeId,
      updateId,
      original.ledger_entry_id,
      reason,
      timestamp,
      recordedAt,
    ),
    database.prepare(
      `UPDATE subscription_orders
       SET order_state = ?, closed_at = COALESCE(closed_at, ?),
           state_revision = state_revision + 1, updated_at = MAX(updated_at, ?)
       WHERE order_id = ? AND order_state IN ('paid', 'applied')`,
    ).bind(type === "refund" ? "refunded" : "chargeback", timestamp, recordedAt, original.order_id),
  ];
  // A retained credit can share the immutable origin with another applied
  // charge. Compensate this exact ledger entry without changing that unrelated
  // order/grant. Chargeback policy below can still suspend the subject.
  if (retainedReview) statements.splice(1,1);
  if (retainedReview && original.grant_id) {
    statements.splice(1,0,database.prepare(`UPDATE subscription_orders
      SET order_state=?,closed_at=COALESCE(closed_at,?),updated_at=MAX(updated_at,?),state_revision=state_revision+1
      WHERE order_id IN (SELECT applied_order_id FROM subscription_payment_review_settlements
       WHERE ledger_entry_id=?) AND order_state IN ('paid','applied')`)
      .bind(type === 'refund' ? 'refunded' : 'chargeback',timestamp,recordedAt,original.ledger_entry_id));
  }

  if (type === "refund" && refundId) {
    statements.push(
      database.prepare(
        `UPDATE payment_refunds
         SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, ?),
             revision = revision + 1, error_code = '', updated_at = MAX(updated_at, ?)
         WHERE refund_id = ? AND status IN ('requested', 'manual_review')`,
      ).bind(timestamp, recordedAt, refundId),
    );
  }

  if (original.grant_id && original.grant_status === "active") {
    statements.push(
      database.prepare(
        `UPDATE subscription_access_grants
         SET status = ?, compensation_ledger_entry_id = ?, updated_at = MAX(updated_at, ?)
         WHERE grant_id = ? AND status = 'active'`,
      ).bind(
        type === "refund" ? "refunded" : "chargeback",
        compensationLedgerId,
        recordedAt,
        original.grant_id,
      ),
    );
  }

  // Immutable package periods derive validity from this exact compensation
  // ledger entry. They have no old access grant or timeline to compact. A
  // current refunded package loses access immediately; an unrelated current
  // or future period retains its original dates and payment authority.
  let accessChanged = Boolean(original.package_period_id &&
    Number(original.package_starts_at) <= timestamp && Number(original.package_ends_at) > timestamp);
  const current = await loadCurrentSubscription(env, Number(original.telegram_id));
  if (type === "refund" && original.grant_id && current?.subscription_id === original.subscription_id) {
    const survivor = current.billing_mode === "recurring" ? await database.prepare(
      `SELECT starts_at,ends_at,payment_ledger_entry_id FROM subscription_access_grants
       WHERE subscription_id=? AND status='active' AND grant_id!=?
       ORDER BY ends_at DESC,starts_at DESC,grant_id LIMIT 1`,
    ).bind(current.subscription_id,original.grant_id).first() : null;
    const newStart = current.billing_mode === "recurring" && survivor
      ? Number(survivor.starts_at) : Number(current.current_period_start);
    const newEnd = current.billing_mode === "recurring"
      ? (survivor ? Number(survivor.ends_at) : Number(current.current_period_end)) : Math.max(
      Number(current.current_period_start) + 1,
      Number(current.current_period_end) - Number(original.access_seconds),
    );
    const terminal = newEnd <= timestamp || current.billing_mode === "recurring" && !survivor;
    const nextHead = current.billing_mode === "recurring" && survivor
      ? survivor.payment_ledger_entry_id : compensationLedgerId;
    const toStatus = terminal ? "refunded" : String(current.status);
    statements.push(
      database.prepare(
        `UPDATE subscriptions
         SET status = ?, current_period_start = ?, current_period_end = ?, last_ledger_entry_id = ?,
             revision = revision + 1, updated_at = MAX(updated_at, ?)
         WHERE subscription_id = ? AND revision = ?
           AND status IN ('active', 'cancel_at_period_end', 'suspended')`,
      ).bind(
        toStatus,
        newStart,
        newEnd,
        nextHead,
        recordedAt,
        current.subscription_id,
        Number(current.revision),
      ),
      database.prepare(
        `INSERT INTO subscription_status_history
           (event_id, event_key, subscription_id, order_id, telegram_id,
            plan_code, from_status, to_status, reason_code, actor_type,
            actor_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'telegram', NULL, ?)`,
      ).bind(
        crypto.randomUUID(),
        `subscription:${current.subscription_id}:refund:${chargeHash.slice(0, 24)}`,
        current.subscription_id,
        original.order_id,
        Number(original.telegram_id),
        original.plan_code,
        current.status,
        toStatus,
        terminal ? "refund_access_ended" : "refund_access_shortened",
        timestamp,
      ),
    );
    if (terminal) {
      statements.push(
        database.prepare(
          `UPDATE user_plans
           SET plan_code = 'free', source_code = 'stars_refund',
               effective_from = ?, effective_until = NULL,
               revision = revision + 1, updated_at = CURRENT_TIMESTAMP
           WHERE telegram_id = ?`,
        ).bind(sqlDateTime(timestamp), Number(original.telegram_id)),
        database.prepare(
          `UPDATE user_access_states
           SET access_state = 'refunded', source_code = 'stars_refund',
               state_ends_at = CASE WHEN state_started_at IS NULL OR ? > state_started_at
                 THEN ? ELSE NULL END, revision = revision + 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE telegram_id = ?`,
        ).bind(sqlDateTime(timestamp), sqlDateTime(timestamp), Number(original.telegram_id)),
        database.prepare(
          `INSERT OR IGNORE INTO access_status_history
             (event_id, telegram_id, plan_code, from_state, to_state,
              source_code, related_grant_id, occurred_at)
           VALUES (?, ?, ?, ?, 'refunded', 'stars_refund', ?, ?)`,
        ).bind(
          `stars-refund:${original.grant_id}`,
          Number(original.telegram_id),
          original.plan_code,
          current.status === "suspended" ? "suspended" : "active",
          original.grant_id,
          timestamp,
        ),
      );
    } else {
      statements.push(
        database.prepare(
          `UPDATE user_plans
           SET effective_from = ?, effective_until = ?, revision = revision + 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE telegram_id = ? AND plan_code = ?`,
        ).bind(sqlDateTime(newStart),sqlDateTime(newEnd), Number(original.telegram_id), original.plan_code),
        database.prepare(
          `UPDATE user_access_states
           SET state_started_at = ?, state_ends_at = ?, revision = revision + 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE telegram_id = ? AND access_state IN
             ('active', 'cancel_at_period_end')`,
        ).bind(sqlDateTime(newStart),sqlDateTime(newEnd), Number(original.telegram_id)),
      );
    }
    accessChanged = true;
  }

  if (type === "chargeback") {
    if (current) {
      const targetStatus = current.subscription_id === original.subscription_id
        ? "chargeback"
        : "suspended";
      statements.push(
        database.prepare(
          `UPDATE subscriptions
           SET status = ?, last_ledger_entry_id = ?,
               revision = revision + 1, updated_at = MAX(updated_at, ?)
           WHERE subscription_id = ? AND revision = ?
             AND status IN ('active', 'cancel_at_period_end', 'suspended')`,
        ).bind(
          targetStatus,
          compensationLedgerId,
          recordedAt,
          current.subscription_id,
          Number(current.revision),
        ),
        database.prepare(
          `INSERT INTO subscription_status_history
             (event_id, event_key, subscription_id, order_id, telegram_id,
              plan_code, from_status, to_status, reason_code, actor_type,
              actor_id, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'chargeback_observed',
                   'telegram', NULL, ?)`,
        ).bind(
          crypto.randomUUID(),
          `subscription:${current.subscription_id}:chargeback:${chargeHash.slice(0, 24)}`,
          current.subscription_id,
          original.order_id,
          Number(original.telegram_id),
          current.plan_code,
          current.status,
          targetStatus,
          timestamp,
        ),
      );
    }
    statements.push(
      database.prepare(
        `INSERT INTO user_access_states
           (telegram_id, access_state, source_code, state_started_at,
            state_ends_at, revision, updated_at)
         VALUES (?, 'suspended', 'stars_chargeback', ?, NULL, 1,
                 CURRENT_TIMESTAMP)
         ON CONFLICT(telegram_id) DO UPDATE SET
           access_state = 'suspended', source_code = 'stars_chargeback',
           state_started_at = excluded.state_started_at,
           state_ends_at = NULL,
           revision = user_access_states.revision + 1,
           updated_at = CURRENT_TIMESTAMP`,
      ).bind(Number(original.telegram_id), sqlDateTime(timestamp)),
      database.prepare(
        `INSERT OR IGNORE INTO access_status_history
           (event_id, telegram_id, plan_code, from_state, to_state,
            source_code, related_grant_id, occurred_at)
         VALUES (?, ?, ?, ?, 'suspended', 'stars_chargeback', ?, ?)`,
      ).bind(
        `stars-chargeback:${chargeHash.slice(0, 32)}`,
        Number(original.telegram_id),
        current?.plan_code || original.plan_code,
        current?.status === "suspended" ? "suspended" : "active",
        original.grant_id || original.order_id,
        timestamp,
      ),
    );
    accessChanged = true;
  }

  statements.push(
    database.prepare(
      `INSERT OR IGNORE INTO payment_events
         (event_id, event_key, order_id, telegram_id, telegram_update_id,
          event_type, outcome, reason_code, occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      `${type}:${chargeHash}:applied`,
      original.order_id,
      Number(original.telegram_id),
      updateId,
      type === "refund" ? "refund_confirmed" : "chargeback_observed",
      reason,
      timestamp,
      recordedAt,
    ),
  );

  if (type === "refund" && refundId) {
    statements.push(
      database.prepare(
        `UPDATE payment_refunds
         SET status = 'applied', applied_at = COALESCE(applied_at, ?),
             revision = revision + 1, updated_at = MAX(updated_at, ?)
         WHERE refund_id = ? AND status = 'confirmed'`,
      ).bind(timestamp, recordedAt, refundId),
    );
  }

  try {
    await database.batch(statements);
  } catch (error) {
    const raced = await database.prepare(
      `SELECT ledger_entry_id FROM payment_ledger
       WHERE telegram_payment_charge_id = ? AND entry_type = ? LIMIT 1`,
    ).bind(chargeId, type).first();
    if (raced) {
      if (type === "refund") {
        await settleExistingRefundRecord(env, refundId, timestamp);
      }
      return Object.freeze({
        status: "duplicate",
        compensationType: type,
        ledgerEntryId: raced.ledger_entry_id,
        orderId: original.order_id,
        accessChanged: false,
      });
    }
    throw error;
  }
  return Object.freeze({
    status: "applied",
    compensationType: type,
    ledgerEntryId: compensationLedgerId,
    orderId: original.order_id,
    accessChanged,
  });
}

function operationsTelegramApi(options) {
  return typeof options?.telegramApi === "function"
    ? options.telegramApi
    : callStarsTelegram;
}

export async function listAdminStarsRefundCandidates(env, {
  adminTelegramId,
  limit = 5,
} = {}) {
  const config = readStarsOperationsConfig(env);
  if (!config.refundsEnabled) throw accessError("stars_refunds_disabled");
  const actorId = assertAdmin(env, adminTelegramId);
  const pageSize = Number(limit);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10) {
    throw accessError("refund_candidate_limit_invalid");
  }
  const query = await requireDatabase(env).prepare(
    `SELECT orders.order_id, orders.plan_code, orders.amount_stars,
            orders.paid_at, orders.applied_at
     FROM subscription_orders orders
     JOIN payment_ledger payment
       ON payment.order_id = orders.order_id
      AND payment.entry_type = 'payment'
      AND payment.direction = 'credit'
     LEFT JOIN payment_ledger compensation
       ON compensation.related_ledger_entry_id = payment.ledger_entry_id
      AND compensation.entry_type IN ('refund', 'chargeback')
     LEFT JOIN payment_refunds refund
       ON refund.telegram_payment_charge_id = payment.telegram_payment_charge_id
     WHERE orders.telegram_id = ?
       AND orders.order_state IN ('paid', 'applied')
       AND compensation.ledger_entry_id IS NULL
       AND refund.refund_id IS NULL
     ORDER BY COALESCE(orders.applied_at, orders.paid_at, orders.created_at) DESC,
              orders.order_id DESC
     LIMIT ?`,
  ).bind(actorId, pageSize).all();
  return Object.freeze((query?.results || []).map((row) => Object.freeze({
    orderId: validateUuid(row.order_id, "refund_order_id_invalid"),
    planCode: normalizeStarsPlanCode(row.plan_code),
    amountStars: Number(row.amount_stars),
    paidAt: Number(row.paid_at || row.applied_at || 0) || null,
  })));
}

export async function requestAdminOwnStarsRefund(env, {
  adminTelegramId,
  orderId,
  reasonCode = "admin_canary_validation",
  requestedAt = nowSeconds(),
} = {}, options = {}) {
  const actorId = assertAdmin(env, adminTelegramId);
  const normalizedOrderId = validateUuid(orderId, "refund_order_id_invalid");
  const original = await requireDatabase(env).prepare(
    `SELECT payment.telegram_payment_charge_id
     FROM subscription_orders orders
     JOIN payment_ledger payment
       ON payment.order_id = orders.order_id
      AND payment.entry_type = 'payment'
      AND payment.direction = 'credit'
     LEFT JOIN payment_ledger compensation
       ON compensation.related_ledger_entry_id = payment.ledger_entry_id
      AND compensation.entry_type IN ('refund', 'chargeback')
     LEFT JOIN payment_refunds refund
       ON refund.telegram_payment_charge_id = payment.telegram_payment_charge_id
     WHERE orders.order_id = ? AND orders.telegram_id = ?
       AND orders.order_state IN ('paid', 'applied')
       AND compensation.ledger_entry_id IS NULL
       AND refund.refund_id IS NULL
     LIMIT 1`,
  ).bind(normalizedOrderId, actorId).first();
  if (!original?.telegram_payment_charge_id) {
    throw accessError("refundable_admin_order_not_found");
  }
  return requestStarsRefund(env, {
    adminTelegramId: actorId,
    telegramPaymentChargeId: original.telegram_payment_charge_id,
    reasonCode,
    requestedAt,
  }, options);
}

async function getOrCreateRefundRequest(env, {
  original,
  actorType,
  actorId,
  reasonCode,
  requestedAt,
}) {
  const database = requireDatabase(env);
  let existing = await database.prepare(
    `SELECT refund_id, status, reason_code, error_code
     FROM payment_refunds
     WHERE telegram_payment_charge_id = ? LIMIT 1`,
  ).bind(original.telegram_payment_charge_id).first();
  if (existing) return { row: existing, created: false };
  const refundId = crypto.randomUUID();
  const chargeHash = await sha256Hex(original.telegram_payment_charge_id);
  await database.batch([
    database.prepare(
      `INSERT OR IGNORE INTO payment_refunds
         (refund_id, idempotency_key, order_id, original_ledger_entry_id,
          telegram_id, telegram_payment_charge_id, currency, amount_stars,
          reason_code, requested_by_type, requested_by, status,
          requested_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'XTR', ?, ?, ?, ?, 'requested', ?, ?)`,
    ).bind(
      refundId,
      `refund-request:${chargeHash}`,
      original.order_id,
      original.ledger_entry_id,
      Number(original.telegram_id),
      original.telegram_payment_charge_id,
      Number(original.amount_stars),
      reasonCode,
      actorType,
      actorId,
      requestedAt,
      requestedAt,
    ),
    database.prepare(
      `INSERT OR IGNORE INTO payment_events
         (event_id, event_key, order_id, telegram_id, event_type,
          outcome, reason_code, occurred_at, received_at)
       VALUES (?, ?, ?, ?, 'refund_requested', 'accepted', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      `refund:${chargeHash}:requested`,
      original.order_id,
      Number(original.telegram_id),
      reasonCode,
      requestedAt,
      nowSeconds(),
    ),
  ]);
  existing = await database.prepare(
    `SELECT refund_id, status, reason_code, error_code
     FROM payment_refunds
     WHERE telegram_payment_charge_id = ? LIMIT 1`,
  ).bind(original.telegram_payment_charge_id).first();
  if (!existing) throw accessError("refund_request_not_persisted");
  return { row: existing, created: existing.refund_id === refundId };
}

export async function requestStarsRefund(env, {
  adminTelegramId,
  telegramPaymentChargeId,
  reasonCode,
  requestedAt = nowSeconds(),
} = {}, options = {}) {
  const config = readStarsOperationsConfig(env);
  if (!config.refundsEnabled) throw accessError("stars_refunds_disabled");
  const actorId = assertAdmin(env, adminTelegramId);
  const timestamp = validateClock(requestedAt);
  const chargeId = validateTelegramObjectId(
    telegramPaymentChargeId,
    "telegram_payment_charge_id_invalid",
  );
  const reason = normalizeReasonCode(reasonCode);
  const original = await loadOriginalPayment(env, chargeId);
  if (!original) throw accessError("original_payment_not_found");
  const compensation = await requireDatabase(env).prepare(
    `SELECT ledger_entry_id FROM payment_ledger
     WHERE telegram_payment_charge_id = ? AND entry_type = 'refund'
     LIMIT 1`,
  ).bind(chargeId).first();
  if (compensation) {
    const request = await requireDatabase(env).prepare('SELECT refund_id FROM payment_refunds WHERE original_ledger_entry_id=? AND status=\'applied\'')
      .bind(original.ledger_entry_id).first();
    const compatibility = hasLegacyCompatibilityEnv(env) ? readLegacyCompatibilityEnv(env) : null;
    const renewalCancellation = request ? await cancelConfirmedRefundFutureRenewal(
      mintConfirmedRefundEvidence(compatibility, original, request.refund_id, actorId, env), options) :
      Object.freeze({status:'manual_review',confirmed:false,reviewRequired:true});
    return Object.freeze({ status: "duplicate", refunded: true, renewalCancellation });
  }
  await assertRefundEffectFresh(env, actorId, original.order_id);
  const request = await getOrCreateRefundRequest(env, {
    original,
    actorType: "admin",
    actorId,
    reasonCode: reason,
    requestedAt: timestamp,
  });
  if (request.row.status === "applied") {
    const compatibility = hasLegacyCompatibilityEnv(env) ? readLegacyCompatibilityEnv(env) : null;
    const renewalCancellation = await cancelConfirmedRefundFutureRenewal(
      mintConfirmedRefundEvidence(compatibility, original, request.row.refund_id, actorId, env), options);
    return Object.freeze({ status: "duplicate", refunded: true, renewalCancellation });
  }
  if (!request.created && request.row.status !== 'confirmed') {
    return Object.freeze({
      status: request.row.status,
      refunded: request.row.status === "applied",
    });
  }

  const api = operationsTelegramApi(options);
  await assertRefundEffectFresh(env, actorId, original.order_id);
  const compatibility = hasLegacyCompatibilityEnv(env)
    ? readLegacyCompatibilityEnv(env) : null;
  if (request.created) try {
    const telegramConfirmed = await api(env, "refundStarPayment", {
      user_id: Number(original.telegram_id),
      telegram_payment_charge_id: chargeId,
    }, { timeoutMs: STARS_REFUND_TIMEOUT_MS });
    if (telegramConfirmed !== true) {
      throw accessError("telegram_refund_not_confirmed");
    }
  } catch (error) {
    const failure = safeReason(error, "refund_api_failed");
    await requireDatabase(env).batch([
      requireDatabase(env).prepare(
        `UPDATE payment_refunds
         SET status = 'manual_review', error_code = ?,
             revision = revision + 1, updated_at = ?
         WHERE refund_id = ? AND status = 'requested'`,
      ).bind(failure, nowSeconds(), request.row.refund_id),
      requireDatabase(env).prepare(
        `INSERT OR IGNORE INTO payment_events
           (event_id, event_key, order_id, telegram_id, event_type,
            outcome, reason_code, occurred_at, received_at)
         VALUES (?, ?, ?, ?, 'refund_failed', 'error', ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        `refund:${request.row.refund_id}:api-review`,
        original.order_id,
        Number(original.telegram_id),
        failure,
        nowSeconds(),
        nowSeconds(),
      ),
    ]);
    return Object.freeze({
      status: "manual_review",
      refunded: false,
      reason: failure,
    });
  }

  const refundEvidence = mintConfirmedRefundEvidence(compatibility, original, request.row.refund_id, actorId, env);
  const accountingEnv = compatibility
    ? await bindConfirmedStarsRefundAccountingEnv(env, refundEvidence)
    : env;
  await requireDatabase(accountingEnv).prepare(
    `UPDATE payment_refunds
     SET status = 'confirmed', confirmed_at = ?, error_code = '',
         revision = revision + 1, updated_at = ?
     WHERE refund_id = ? AND status = 'requested'`,
  ).bind(timestamp, timestamp, request.row.refund_id).run();
  const applied = await applyStarsCompensation(accountingEnv, {
    telegramPaymentChargeId: chargeId,
    compensationType: "refund",
    occurredAt: timestamp,
    refundId: request.row.refund_id,
    reasonCode: reason,
  });
  const renewalCancellation = await cancelConfirmedRefundFutureRenewal(refundEvidence, options);
  return Object.freeze({
    status: applied.status,
    refunded: true,
    accessChanged: applied.accessChanged,
    renewalCancellation,
  });
}

function refundedPaymentFromUpdate(update) {
  const message = update?.message;
  const payment = message?.refunded_payment;
  const userId = normalizePositiveTelegramId(message?.chat?.id);
  const senderId = normalizePositiveTelegramId(message?.from?.id);
  if (
    !payment || !userId || message?.chat?.type !== "private" ||
    (senderId && !message?.from?.is_bot && senderId !== userId)
  ) {
    throw accessError("refunded_payment_actor_invalid");
  }
  return { payment, userId };
}

export async function handleStarsRefundedPaymentUpdate(env, update, {
  receivedAt = nowSeconds(),
} = {}) {
  const timestamp = validateClock(receivedAt);
  const updateId = validateUpdateId(update?.update_id);
  const { payment, userId } = refundedPaymentFromUpdate(update);
  const chargeId = validateTelegramObjectId(
    payment.telegram_payment_charge_id,
    "telegram_payment_charge_id_invalid",
  );
  const original = await loadOriginalPayment(env, chargeId);
  if (!original) throw accessError("original_payment_not_found");
  let expectedProviderPayload = original.invoice_payload;
  let importedLink = null;
  try {
    importedLink = await requireDatabase(env).prepare(
      `SELECT link.external_invoice_payload,link.external_payload_sha256,
              origin.telegram_id,origin.price_id,origin.order_id
       FROM subscription_payment_links link JOIN subscription_orders origin
        ON origin.order_id=link.origin_order_id
       WHERE link.ledger_entry_id=? AND link.applied_order_id=?
        AND link.provider_charge_id=? AND link.telegram_id=? AND link.direction='incoming'
        AND link.external_invoice_payload=origin.invoice_payload LIMIT 1`,
    ).bind(original.ledger_entry_id,original.order_id,chargeId,userId).first();
  } catch (error) {
    // Accepted prepaid installations predating 0066 have no link table.
    // Other read failures must keep the compensation in review.
    if (!/no such table[^\n]*subscription_payment_links/i.test(String(error?.message))) throw error;
  }
  if (importedLink) {
    if (Number(importedLink.telegram_id) !== userId ||
        await sha256Hex(importedLink.external_invoice_payload) !== importedLink.external_payload_sha256) {
      throw accessError("refunded_payment_mismatch");
    }
    const verified = await verifyStarsInvoicePayload({
      invoiceSecret: String(env?.STARS_INVOICE_SECRET || ""),
      payload: importedLink.external_invoice_payload,telegramId: userId,
      priceId: importedLink.price_id,
    });
    if (verified.orderId !== importedLink.order_id) throw accessError("refunded_payment_mismatch");
    expectedProviderPayload = importedLink.external_invoice_payload;
  }
  if (
    Number(original.telegram_id) !== userId ||
    payment.currency !== STARS_CURRENCY ||
    Number(payment.total_amount) !== Number(original.amount_stars) ||
    String(payment.invoice_payload || "") !== String(expectedProviderPayload)
  ) {
    throw accessError("refunded_payment_mismatch");
  }
  const request = await getOrCreateRefundRequest(env, {
    original,
    actorType: "telegram",
    actorId: null,
    reasonCode: "telegram_refunded_payment",
    requestedAt: timestamp,
  });
  return applyStarsCompensation(env, {
    telegramPaymentChargeId: chargeId,
    compensationType: "refund",
    occurredAt: timestamp,
    telegramUpdateId: updateId,
    refundId: request.row.refund_id,
    reasonCode: "telegram_refunded_payment",
  });
}

async function recordReconciledPayment(env, transaction, timestamp, packageObservation = null) {
  const database = requireDatabase(env);
  const chargeId = validateTelegramObjectId(
    transaction?.id,
    "reconciliation_transaction_id_invalid",
  );
  const payload = String(transaction?.source?.invoice_payload || "");
  const userId = normalizePositiveTelegramId(transaction?.source?.user?.id);
  const amountStars = Math.abs(Number(transaction?.amount));
  if (!payload || !userId || !Number.isSafeInteger(amountStars) || amountStars <= 0) {
    throw accessError("reconciliation_payment_shape_invalid");
  }
  const orderId = parseStarsInvoicePayload(payload).orderId;
  const order = await database.prepare(
    `SELECT *
     FROM subscription_orders WHERE order_id = ? LIMIT 1`,
  ).bind(orderId).first();
  if (!order) throw accessError("reconciliation_order_not_found");
  const packageSchema = await database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='subscription_package_orders'").first();
  if (packageSchema && await database.prepare('SELECT order_id FROM subscription_package_orders WHERE order_id=? AND billing_mode=\'prepaid\' LIMIT 1')
    .bind(orderId).first()) {
    const { recordReconciledPackagePayment } = await import('../v1.4.4/package-payment-runtime.mjs');
    return recordReconciledPackagePayment(env, transaction, timestamp, packageObservation);
  }
  // StarTransaction does not carry subscription_expiration_date or the
  // first-recurring marker. A transaction date cannot substitute either.
  if (order.billing_mode !== 'prepaid') {
    throw accessError('recurring_provider_period_evidence_missing');
  }
  await verifyStarsInvoicePayload({
    invoiceSecret: String(env?.STARS_INVOICE_SECRET || ""),
    payload,
    telegramId: order.telegram_id,
    priceId: order.price_id,
  });
  if (
    Number(order.telegram_id) !== userId ||
    order.currency !== STARS_CURRENCY ||
    Number(order.amount_stars) !== amountStars ||
    order.invoice_payload !== payload || validateClock(transaction.date)<Number(order.created_at) ||
    !["created", "precheckout_ok", "paid", "applied",'failed','cancelled'].includes(order.order_state)
  ) {
    throw accessError("reconciliation_payment_mismatch");
  }
  const existing = await database.prepare(
    `SELECT ledger_entry_id FROM payment_ledger
     WHERE telegram_payment_charge_id = ? AND entry_type = 'payment'
     LIMIT 1`,
  ).bind(chargeId).first();
  if (existing) {
    if (order.order_state === "paid") {
      await applyStarsPaidAccess(env, { orderId, appliedAt: timestamp });
    }
    return { recovered: false, orderId, ledgerEntryId: existing.ledger_entry_id };
  }
  if (order.order_state === "applied") {
    throw accessError("reconciliation_applied_without_ledger");
  }
  const ledgerEntryId = crypto.randomUUID();
  const chargeHash = await sha256Hex(chargeId);
  if(['failed','cancelled'].includes(order.order_state)){
    // A genuine late prepaid transaction has sufficient duration evidence,
    // but cannot reopen its terminal invoice. Retain its existing-ledger cash
    // and original transaction proof for the explicit owner settlement path.
    if(!await database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='subscription_payment_review_receipts'").first())
      throw accessError('late_prepaid_review_schema_required');
    const recordedAt=nowSeconds(),evidenceHash=await sha256Hex(JSON.stringify(['v143.star-transaction.prepaid.v1',
      chargeId,Number(transaction.date),amountStars,userId,payload]));
    const result=await database.batch([
      database.prepare(`INSERT INTO payment_ledger(ledger_entry_id,idempotency_key,order_id,telegram_id,
        entry_type,direction,currency,amount_stars,telegram_payment_charge_id,reason_code,occurred_at,recorded_at)
        VALUES(?,?,?,?,'payment','credit','XTR',?,?,'payment_review_retained',?,?)`)
        .bind(ledgerEntryId,`payment:${chargeHash}`,orderId,userId,amountStars,chargeId,Number(transaction.date),recordedAt),
      database.prepare(`INSERT INTO payment_events(event_id,event_key,order_id,telegram_id,event_type,outcome,
        reason_code,payload_sha256,occurred_at,received_at)
        VALUES(?,?,?,?,'payment_recorded','accepted','payment_review_retained',?,?,?)`)
        .bind(crypto.randomUUID(),`reconcile:${chargeHash}:prepaid-retained`,orderId,userId,evidenceHash,Number(transaction.date),recordedAt),
      database.prepare(`INSERT INTO subscription_payment_review_receipts(ledger_entry_id,origin_order_id,telegram_id,
        plan_code,external_invoice_payload,external_payload_sha256,is_first_recurring,evidence_sha256,reason_code,recorded_at)
        VALUES(?,?,?,?,?,?,0,?,'reconciliation_late_prepaid',?)`)
        .bind(ledgerEntryId,orderId,userId,order.plan_code,payload,await sha256Hex(payload),evidenceHash,recordedAt),
    ]);
    if(!Array.isArray(result)||result.some(row=>row?.success!==true))throw accessError('reconciliation_payment_not_persisted');
    return {recovered:true,reviewRequired:true,orderId,ledgerEntryId};
  }
  const statements = [];
  if (order.order_state === "created") {
    statements.push(database.prepare(
      `UPDATE subscription_orders
       SET order_state = 'precheckout_ok', precheckout_approved_at = ?,
           state_revision = state_revision + 1, updated_at = ?
       WHERE order_id = ? AND order_state = 'created'`,
    ).bind(timestamp, timestamp, orderId));
  }
  statements.push(
    database.prepare(
      `INSERT INTO payment_ledger
         (ledger_entry_id, idempotency_key, order_id, telegram_id,
          entry_type, direction, currency, amount_stars,
          telegram_payment_charge_id, related_ledger_entry_id,
          reason_code, occurred_at, recorded_at)
       VALUES (?, ?, ?, ?, 'payment', 'credit', 'XTR', ?, ?, NULL,
               'reconciliation_recovery', ?, ?)`,
    ).bind(
      ledgerEntryId,
      `payment:${chargeHash}`,
      orderId,
      userId,
      amountStars,
      chargeId,
      Number(transaction.date || timestamp),
      nowSeconds(),
    ),
    database.prepare(
      `UPDATE subscription_orders
       SET order_state = 'paid', paid_at = COALESCE(paid_at, ?),
           state_revision = state_revision + 1, updated_at = ?
       WHERE order_id = ? AND order_state = 'precheckout_ok'`,
    ).bind(timestamp, timestamp, orderId),
    database.prepare(
      `INSERT OR IGNORE INTO payment_events
         (event_id, event_key, order_id, telegram_id, event_type,
          outcome, reason_code, occurred_at, received_at)
       VALUES (?, ?, ?, ?, 'reconciliation_observed', 'accepted',
               'payment_recovered', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      `reconcile:${chargeHash}:payment-recovered`,
      orderId,
      userId,
      timestamp,
      nowSeconds(),
    ),
  );
  await database.batch(statements);
  await applyStarsPaidAccess(env, { orderId, appliedAt: validateClock(transaction.date) });
  return { recovered: true, orderId, ledgerEntryId };
}

function normalizeStarTransaction(transaction) {
  const id = validateTelegramObjectId(
    transaction?.id,
    "reconciliation_transaction_id_invalid",
  );
  const date = validateClock(transaction?.date);
  const rawAmount = Number(transaction?.amount);
  if (!Number.isSafeInteger(rawAmount) || rawAmount === 0) {
    throw accessError("reconciliation_amount_invalid");
  }
  if(transaction?.nanostar_amount!=null && (!Number.isSafeInteger(transaction.nanostar_amount)||transaction.nanostar_amount!==0))
    throw accessError('reconciliation_fractional_invoice_unsupported');
  const hasSource = Boolean(transaction?.source);
  const hasReceiver = Boolean(transaction?.receiver);
  if (hasSource === hasReceiver) {
    throw accessError("reconciliation_direction_invalid");
  }
  const direction = hasSource ? "incoming" : "outgoing";
  const partner = hasSource ? transaction.source : transaction.receiver;
  return {
    raw: transaction,
    id,
    date,
    amountStars: Math.abs(rawAmount),
    direction,
    partner,
    partnerType: String(partner?.type || "").slice(0, 32),
    transactionType: String(partner?.transaction_type || "").slice(0, 48),
    telegramId: normalizePositiveTelegramId(partner?.user?.id),
  };
}

async function insertReconciliationItem(env, {
  runId,
  transactionHash,
  observationSide,
  direction,
  partnerType,
  transactionType,
  telegramId,
  amountStars,
  transactionDate,
  localState,
  orderId = null,
  ledgerEntryId = null,
  reasonCode = "",
  observedAt,
  itemDiscriminator = '',
}) {
  return requireDatabase(env).prepare(
    `INSERT OR IGNORE INTO payment_reconciliation_items
       (item_id, item_key, run_id, transaction_id_sha256,
        observation_side, transaction_direction, partner_type,
        transaction_type, telegram_id, amount_stars, transaction_date,
        local_state, order_id, ledger_entry_id, reason_code, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    `${runId}:${observationSide}:${direction}:${transactionHash}${itemDiscriminator}`,
    runId,
    transactionHash,
    observationSide,
    direction,
    partnerType,
    transactionType,
    telegramId,
    amountStars,
    transactionDate,
    localState,
    orderId,
    ledgerEntryId,
    String(reasonCode || "").slice(0, 64),
    observedAt,
  ).run();
}

async function reconcileOneTelegramTransaction(env, runId, normalized, observedAt, packageObservation = null) {
  const database = requireDatabase(env);
  const transactionHash = await sha256Hex(normalized.id);
  const relevant = normalized.partnerType === "user" &&
    normalized.transactionType === "invoice_payment";
  if (!relevant) {
    await insertReconciliationItem(env, {
      runId,
      transactionHash,
      observationSide: "telegram",
      direction: normalized.direction,
      partnerType: normalized.partnerType,
      transactionType: normalized.transactionType,
      telegramId: normalized.telegramId,
      amountStars: normalized.amountStars,
      transactionDate: normalized.date,
      localState: "unsupported",
      reasonCode: "not_re_program_invoice",
      observedAt,
    });
    return { relevant: false, matched: false, discrepancy: false };
  }

  const original = await loadOriginalPayment(env, normalized.id);
  let expectedExternalPayload = original?.invoice_payload || null;
  if (original && await database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='subscription_payment_links'").first()) {
    const binding=await database.prepare(`SELECT external_invoice_payload FROM subscription_payment_links
      WHERE ledger_entry_id=? AND direction='incoming' LIMIT 1`).bind(original.ledger_entry_id).first();
    if (binding) expectedExternalPayload=binding.external_invoice_payload;
  }
  let state = "matched";
  let reason = "ledger_matches_telegram";
  let orderId = original?.order_id || null;
  let ledgerEntryId = original?.ledger_entry_id || null;
  let discrepancy = false;

  if (normalized.direction === "incoming") {
    if (original) {
      const payload = String(normalized.partner?.invoice_payload || "");
      const matches =
        Number(original.telegram_id) === Number(normalized.telegramId) &&
        Number(original.amount_stars) === normalized.amountStars &&
        (!payload || payload === expectedExternalPayload);
      if (!matches) {
        state = "mismatch";
        reason = "incoming_transaction_mismatch";
        discrepancy = true;
      } else if (['payment_review_retained', 'package_payment_review_retained'].includes(original.payment_reason_code) && !original.grant_id) {
        const settledPackageRefund = original.package_retained_review || original.package_monthly_retained_review ? await database.prepare(`SELECT ledger_entry_id
          FROM payment_ledger WHERE related_ledger_entry_id=? AND order_id=? AND telegram_id=?
          AND entry_type='refund' AND direction='debit' AND currency='XTR' AND amount_stars=?
          AND telegram_payment_charge_id=? LIMIT 1`).bind(original.ledger_entry_id, original.order_id,
            Number(original.telegram_id), Number(original.amount_stars), original.telegram_payment_charge_id).first() : null;
        if (settledPackageRefund) reason = 'retained_package_refund_settled';
        else { state='manual_review';reason='retained_payment_settlement_required';discrepancy=true; }
      } else if (original.order_state === "paid") {
        try {
          await applyStarsPaidAccess(env,{orderId:original.order_id,appliedAt:observedAt});
        } catch(error) {
          if(!original.package_metadata && !['recurring_first_payment_unverified','recurring_command_unsettled','recurring_contract_compensated',
            'recurring_contract_conflict','paid_access_suspended','paid_plan_transition_not_released'].includes(error?.code))throw error;
          state='manual_review';reason=safeReason(error);discrepancy=true;
        }
      }
    } else {
      try {
        const recovered = await recordReconciledPayment(
          env,
          normalized.raw,
          observedAt,
          packageObservation,
        );
        state = recovered.recovered ? "recovered" : "matched";
        reason = recovered.recovered
          ? "missing_webhook_recovered"
          : "ledger_matches_telegram";
        orderId = recovered.orderId;
        ledgerEntryId = recovered.ledgerEntryId;
        if(recovered.reviewRequired){state='manual_review';reason='recovered_payment_settlement_required';discrepancy=true;}
      } catch (error) {
        state = "missing_local";
        reason = safeReason(error, "missing_local_payment");
        discrepancy = true;
      }
    }
  } else if (!original) {
    state = "missing_local";
    reason = "outgoing_without_original_payment";
    discrepancy = true;
  } else if (
    Number(original.telegram_id) !== Number(normalized.telegramId) ||
    Number(original.amount_stars) !== normalized.amountStars ||
    (normalized.partner?.invoice_payload && normalized.partner.invoice_payload !== expectedExternalPayload)
  ) {
    state = "mismatch";
    reason = "outgoing_transaction_mismatch";
    discrepancy = true;
  } else {
    const localRefund = await database.prepare(
      `SELECT refund_id, status FROM payment_refunds
       WHERE telegram_payment_charge_id = ? AND original_ledger_entry_id=?
       AND order_id=? AND telegram_id=? AND currency='XTR' AND amount_stars=?
       AND status IN ('requested','manual_review','confirmed','applied') LIMIT 1`,
    ).bind(normalized.id, original.ledger_entry_id, original.order_id,
      Number(original.telegram_id), Number(original.amount_stars)).first();
    const existingEffect = await database.prepare(
      `SELECT ledger_entry_id,entry_type FROM payment_ledger
       WHERE related_ledger_entry_id=? AND telegram_payment_charge_id=?
       AND entry_type IN ('refund','chargeback') AND direction='debit'
       AND telegram_id=? AND currency='XTR' AND amount_stars=? LIMIT 1`,
    ).bind(original.ledger_entry_id, normalized.id, Number(original.telegram_id),
      Number(original.amount_stars)).first();
    // An outgoing invoice observation alone does not identify a dispute.
    // Preserve the observation; only a bound refund request may be settled.
    if (!localRefund && !existingEffect) {
      state = 'manual_review';
      reason = 'outgoing_financial_type_unverified';
      discrepancy = true;
    } else if (existingEffect?.entry_type === 'chargeback') {
      state = 'manual_review';
      reason = 'existing_chargeback_requires_evidence_audit';
      ledgerEntryId = existingEffect.ledger_entry_id;
      discrepancy = true;
    } else {
    try {
      const applied = await applyStarsCompensation(env, {
        telegramPaymentChargeId: normalized.id,
        compensationType: 'refund',
        occurredAt: normalized.date,
        refundId: localRefund?.refund_id || null,
        reasonCode: 'reconciliation_refund',
      });
      ledgerEntryId = applied.ledgerEntryId;
      reason = 'refund_matches_telegram';
    } catch (error) {
      state = "manual_review";
      reason = safeReason(error, "compensation_import_failed");
      discrepancy = true;
    }
    }
  }

  await insertReconciliationItem(env, {
    runId,
    transactionHash,
    observationSide: "telegram",
    direction: normalized.direction,
    partnerType: normalized.partnerType,
    transactionType: normalized.transactionType,
    telegramId: normalized.telegramId,
    amountStars: normalized.amountStars,
    transactionDate: normalized.date,
    localState: state,
    orderId,
    ledgerEntryId,
    reasonCode: reason,
    observedAt,
  });
  if (normalized.direction === 'outgoing') {
    await appendOutgoingReconciliationEvidence(env,normalized,original,{
      reason,ledgerEntryId: state === 'matched' ? ledgerEntryId : null,observedAt,
    });
  }
  return {
    relevant: true,
    matched: !discrepancy,
    discrepancy,
    key: `${normalized.id}:${normalized.direction}`,
  };
}

async function appendOutgoingReconciliationEvidence(env,normalized,original,{reason,ledgerEntryId,observedAt}) {
  const db=requireDatabase(env);
  // Older installations keep the existing reconciliation journal. The new
  // profile additionally retains a stable direction-specific identity.
  if (!await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='subscription_payment_links'").first()) return;
  const chargeHash=await sha256Hex(normalized.id);
  const evidenceHash=await sha256Hex(JSON.stringify(['v143.star-transaction.outgoing.v1',normalized.id,
    normalized.date,normalized.amountStars,normalized.telegramId,normalized.partnerType,
    normalized.transactionType,String(normalized.partner?.invoice_payload||'')]));
  const prior=await db.prepare(`SELECT operation_id,provider_charge_sha256,telegram_id
    FROM subscription_payment_links WHERE provider_charge_id=? AND direction='outgoing' LIMIT 1`).bind(normalized.id).first();
  const ownOriginal=original && Number(original.telegram_id)===normalized.telegramId &&
    Number(original.amount_stars)===normalized.amountStars ? original : null;
  const operationId=prior?.operation_id || crypto.randomUUID();
  const effect=ledgerEntryId && await db.prepare(`SELECT ledger_entry_id FROM payment_ledger
    WHERE ledger_entry_id=? AND related_ledger_entry_id=? AND entry_type='refund' AND direction='debit'
    AND telegram_payment_charge_id=? AND telegram_id=? AND amount_stars=? AND currency='XTR' LIMIT 1`)
    .bind(ledgerEntryId,ownOriginal?.ledger_entry_id||null,normalized.id,normalized.telegramId,normalized.amountStars).first();
  const decision=effect ? 'confirmed_refund' : 'review_required';
  const statements=[];
  if (!prior) statements.push(db.prepare(`INSERT INTO subscription_payment_links
    (operation_id,operation_key,provider_charge_id,provider_charge_sha256,direction,link_kind,
     origin_order_id,telegram_id,plan_code,external_invoice_payload,external_payload_sha256,
     ledger_entry_id,original_payment_ledger_entry_id,evidence_sha256,occurred_at,recorded_at)
    VALUES(?,?,?,?,'outgoing','outgoing_observation',?,?,?,?,?,?,?,?,?,?)`)
    .bind(operationId,`outgoing:${chargeHash}`,normalized.id,chargeHash,ownOriginal?.order_id||null,
      ownOriginal?normalized.telegramId:null,ownOriginal?.plan_code||null,ownOriginal?.invoice_payload||null,
      ownOriginal?await sha256Hex(ownOriginal.invoice_payload):null,effect?.ledger_entry_id||null,
      ownOriginal?.ledger_entry_id||null,evidenceHash,normalized.date,observedAt));
  if (prior?.telegram_id != null && prior.telegram_id!==normalized.telegramId) {
    throw accessError('reconciliation_operation_identity_collision');
  }
  statements.push(db.prepare(`INSERT OR IGNORE INTO payment_review_resolutions
    (resolution_id,resolution_key,operation_id,original_payment_ledger_entry_id,
     financial_effect_ledger_entry_id,decision,actor_type,reason_code,evidence_sha256,recorded_at)
    VALUES(?,?,?,?,?,?,'system',?,?,?)`)
    .bind(crypto.randomUUID(),`reconcile:out:${chargeHash.slice(0,32)}:${evidenceHash}:${decision}`,
      operationId,ownOriginal?.ledger_entry_id||null,effect?.ledger_entry_id||null,decision,reason,evidenceHash,observedAt));
  const result=await db.batch(statements);
  if (!Array.isArray(result)||result.some(row=>row?.success===false)) throw accessError('reconciliation_evidence_not_persisted');
}

async function recordMissingTelegramItems(env, runId, observedKeys, observedAt) {
  const ledger = await requireDatabase(env).prepare(
    `SELECT ledger_entry_id, order_id, telegram_id, entry_type,
            amount_stars, telegram_payment_charge_id, occurred_at
     FROM payment_ledger
     WHERE entry_type IN ('payment', 'refund', 'chargeback')
     ORDER BY occurred_at, ledger_entry_id LIMIT 2001`,
  ).all();
  if(ledger?.success!==true||!Array.isArray(ledger.results))throw accessError('reconciliation_local_read_failed');
  let missing = 0;
  for (const row of ledger.results.slice(0,2000)) {
    const direction = row.entry_type === "payment" ? "incoming" : "outgoing";
    const key = `${row.telegram_payment_charge_id}:${direction}`;
    if (observedKeys.has(key)) continue;
    missing += 1;
    await insertReconciliationItem(env, {
      runId,
      transactionHash: await sha256Hex(row.telegram_payment_charge_id),
      observationSide: "local",
      direction,
      partnerType: "user",
      transactionType: "invoice_payment",
      telegramId: Number(row.telegram_id),
      amountStars: Number(row.amount_stars),
      transactionDate: Number(row.occurred_at),
      localState: "missing_telegram",
      orderId: row.order_id,
      ledgerEntryId: row.ledger_entry_id,
      reasonCode: "local_entry_not_returned",
      observedAt,
    });
  }
  return {missing,overflow:(ledger?.results || []).length>2000};
}

export async function reconcileStarsTransactions(env, {
  runSource = "admin",
  initiatedBy = null,
  offsetStart = 0,
  pageLimit = STARS_RECONCILIATION_PAGE_LIMIT,
  maxPages = STARS_RECONCILIATION_MAX_PAGES,
  startedAt = nowSeconds(),
  targetPaymentLedgerEntryId = null,
} = {}, options = {}) {
  const config = readStarsOperationsConfig(env);
  if (!config.reconciliationEnabled) {
    throw accessError("stars_reconciliation_disabled");
  }
  const source = String(runSource || "");
  if (!['scheduled', 'admin', 'release'].includes(source)) {
    throw accessError("reconciliation_source_invalid");
  }
  const actorId = source === "admin" ? assertAdmin(env, initiatedBy) : null;
  const offset = Number(offsetStart);
  const limit = Number(pageLimit);
  const maximumPages = Number(maxPages);
  if (
    !Number.isSafeInteger(offset) || offset < 0 ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
    !Number.isSafeInteger(maximumPages) || maximumPages < 1 || maximumPages > STARS_RECONCILIATION_MAX_PAGES
  ) {
    throw accessError("reconciliation_window_invalid");
  }
  const timestamp = validateClock(startedAt);
  const database = requireDatabase(env);
  // Referral protection needs a fresh observation of one immutable local
  // payment and any reversal carrying that provider identity. Resolve the
  // identity here, from the same DB; callers cannot supply a provider charge.
  // Unrelated history is paged, but must not create thousands of D1 writes in
  // this narrowly scoped Workflow. Such a run never claims full reconciliation.
  let targetChargeId = null;
  if (targetPaymentLedgerEntryId !== null) {
    if (typeof targetPaymentLedgerEntryId !== 'string' || !targetPaymentLedgerEntryId.length ||
        targetPaymentLedgerEntryId.length > 256) throw accessError('reconciliation_target_invalid');
    const target = await database.prepare(`SELECT telegram_payment_charge_id FROM payment_ledger
      WHERE ledger_entry_id=? AND entry_type='payment' AND direction='credit' AND currency='XTR' LIMIT 1`)
      .bind(targetPaymentLedgerEntryId).first();
    targetChargeId = validateTelegramObjectId(target?.telegram_payment_charge_id, 'reconciliation_target_invalid');
  }
  const runId = crypto.randomUUID();
  const admitted=await database.prepare(
    `INSERT INTO payment_reconciliation_runs
       (run_id, run_source, initiated_by, status, offset_start,
        started_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?)`,
  ).bind(runId, source, actorId, offset, timestamp, timestamp).run();
  if(admitted?.success!==true||resultChanges(admitted)!==1)throw accessError('reconciliation_run_not_persisted');
  const api = operationsTelegramApi(options);
  const { createServiceExecutor } = await import('../v1.4.1/trusted-context.mjs');
  const reconciliationContext = await createServiceExecutor({ binding: database, env,
    purpose: 'stars_reconcile', clockSeconds: () => timestamp }).createContext();
  let transactionsSeen = 0;
  let nextOffset = offset;
  let complete = false;
  const observedKeys = new Set();
  const observedDigests = new Map();
  let matched = 0;
  let missingLocal = 0;
  let mismatches = 0;
  let malformedSeen = false;
  try {
    for (let page = 0; page < maximumPages; page += 1) {
      const result = await api(env, "getStarTransactions", {
        offset: nextOffset, limit,
      }, { timeoutMs: STARS_RECONCILIATION_TIMEOUT_MS });
      const rows = Array.isArray(result?.transactions) ? result.transactions : null;
      if (!rows || rows.length > limit) throw accessError("reconciliation_response_invalid");
      for (const transaction of rows) {
        transactionsSeen += 1;
        if (targetChargeId !== null && transaction?.id !== targetChargeId) continue;
        let normalized;
        try {
          normalized = normalizeStarTransaction(transaction);
        } catch (error) {
          mismatches += 1;
          malformedSeen = true;
          // The old item table requires an actual amount/date/identity. When
          // those are absent, only the run records the malformed evidence;
          // inventing one Star or the observation clock would be dishonest.
          const exactId=typeof transaction?.id==='string'&&transaction.id.length>0&&transaction.id.length<=256?transaction.id:null;
          const exactAmount=Number(transaction?.amount),exactDate=Number(transaction?.date);
          const direction=Boolean(transaction?.source)!==Boolean(transaction?.receiver)?
            (transaction.source?'incoming':'outgoing'):null;
          if(exactId&&Number.isSafeInteger(exactAmount)&&exactAmount!==0&&Number.isSafeInteger(exactDate)&&exactDate>0&&direction&&(transaction.nanostar_amount==null||transaction.nanostar_amount===0)){
            await insertReconciliationItem(env,{runId,transactionHash:await sha256Hex(exactId),observationSide:'telegram',direction,
              partnerType:String(transaction?.source?.type||transaction?.receiver?.type||'').slice(0,32),transactionType:'',
              telegramId:null,amountStars:Math.abs(exactAmount),transactionDate:exactDate,localState:'mismatch',
              reasonCode:safeReason(error),observedAt:timestamp});
          }
          if (targetChargeId !== null) throw accessError('reconciliation_target_malformed_evidence');
          continue;
        }
        const key = `${normalized.id}:${normalized.direction}`;
        const digest = await sha256Hex(JSON.stringify([normalized.date,normalized.amountStars,
          normalized.partnerType,normalized.transactionType,normalized.telegramId,
          String(normalized.partner?.invoice_payload || ''), normalized.partner?.subscription_period ?? null, normalized.raw.nanostar_amount ?? 0]));
        if (observedDigests.has(key)) {
          if (observedDigests.get(key) !== digest) {
            mismatches += 1;
            await insertReconciliationItem(env,{runId,transactionHash:await sha256Hex(normalized.id),
              observationSide:'telegram',direction:normalized.direction,partnerType:normalized.partnerType,
              transactionType:normalized.transactionType,telegramId:normalized.telegramId,amountStars:normalized.amountStars,
              transactionDate:normalized.date,localState:'mismatch',reasonCode:'duplicate_transaction_evidence_conflict',
              observedAt:timestamp,itemDiscriminator:':'+digest.slice(0,16)});
            if (targetChargeId !== null) throw accessError('reconciliation_target_conflicting_evidence');
          }
          continue;
        }
        observedDigests.set(key,digest);
        let packageObservation = null;
        if (normalized.direction === 'incoming' && normalized.partnerType === 'user' && normalized.transactionType === 'invoice_payment') {
          const { capturePackageReconciliationObservation } = await import('../v1.4.4/package-payment-runtime.mjs');
          packageObservation = await capturePackageReconciliationObservation({ context: reconciliationContext,
            runId, providerPage: result, transaction: normalized.raw, observedAt: timestamp });
        }
        const item = await reconcileOneTelegramTransaction(env,runId,normalized,timestamp,packageObservation);
        if (targetChargeId !== null && !item.relevant)
          throw accessError('reconciliation_target_unrecognized_evidence');
        if (targetChargeId !== null && normalized.direction === 'outgoing' && item.discrepancy)
          throw accessError('reconciliation_target_reversal_unverified');
        if (item.key) observedKeys.add(item.key);
        if (!item.relevant) continue;
        if (item.matched) matched += 1;
        if (item.discrepancy) {
          if (normalized.direction === "incoming" && !await loadOriginalPayment(env,normalized.id)) missingLocal += 1;
          else mismatches += 1;
        }
      }
      nextOffset += rows.length;
      // Commit the processed page before fetching another one. A failed next
      // page leaves its own durable journal and an explicit restart offset.
      const progress=await database.prepare(`UPDATE payment_reconciliation_runs SET offset_end=?,
        transactions_seen=?,transactions_matched=?,missing_local=?,discrepancies=?,updated_at=?
        WHERE run_id=? AND status='running'`).bind(nextOffset,transactionsSeen,matched,
          missingLocal,missingLocal+mismatches,nowSeconds(),runId).run();
      if(progress?.success!==true||resultChanges(progress)!==1)throw accessError('reconciliation_progress_not_persisted');
      if (rows.length < limit) { complete = true; break; }
    }
    const providerCoverage = targetChargeId === null && offset === 0 && complete && !malformedSeen;
    const localScan = providerCoverage ? await recordMissingTelegramItems(env,runId,observedKeys,timestamp) : {missing:0,overflow:false};
    const missingTelegram=localScan.missing;
    const fullCoverage=providerCoverage&&!localScan.overflow;
    const discrepancies = missingLocal + missingTelegram + mismatches +
      (fullCoverage ? 0 : 1);
    const status = discrepancies === 0 ? "completed" : "manual_review";
    const completed=await database.prepare(
      `UPDATE payment_reconciliation_runs
       SET status = ?, offset_end = ?, transactions_seen = ?,
           transactions_matched = ?, missing_local = ?,
           missing_telegram = ?, discrepancies = ?, error_code = ?,
           finished_at = ?, updated_at = ?
       WHERE run_id = ? AND status = 'running'`,
    ).bind(
      status,
      nextOffset,
      transactionsSeen,
      matched,
      missingLocal,
      missingTelegram,
      discrepancies,
      malformedSeen ? 'transaction_evidence_malformed' : localScan.overflow ? 'local_journal_scan_truncated' : fullCoverage ? '' :
        (complete ? (targetChargeId === null ? "transaction_scan_partial" : "transaction_scan_targeted") : "transaction_scan_truncated"),
      nowSeconds(),
      nowSeconds(),
      runId,
    ).run();
    if(completed?.success!==true||resultChanges(completed)!==1)throw accessError('reconciliation_completion_not_persisted');
    return Object.freeze({
      runId,
      status,
      complete: fullCoverage,
      transactionsSeen,
      nextOffset,
      scanComplete: complete,
      transactionsMatched: matched,
      missingLocal,
      missingTelegram,
      discrepancies,
    });
  } catch (error) {
    await database.prepare(
      `UPDATE payment_reconciliation_runs
       SET status = 'failed', offset_end = ?, error_code = ?,
           finished_at = ?, updated_at = ?
       WHERE run_id = ? AND status = 'running'`,
    ).bind(
      nextOffset,
      safeReason(error, "reconciliation_failed"),
      nowSeconds(),
      nowSeconds(),
      runId,
    ).run();
    throw error;
  }
}

export async function getStarsPaymentDiagnostics(env) {
  const database = requireDatabase(env);
  const config = readStarsOperationsConfig(env);
  const [schema, orders, ledger, subscriptions, refunds, latestRun] =
    await Promise.all([
      database.prepare(
        `SELECT COUNT(*) AS total FROM sqlite_schema
         WHERE type = 'table' AND name IN (
           'price_book', 'subscription_orders', 'payment_events',
           'payment_ledger', 'subscriptions', 'subscription_status_history',
           'terms_acceptances', 'payment_reconciliation_runs',
           'payment_refunds', 'subscription_access_grants',
           'payment_reconciliation_items'
         )`,
      ).first(),
      database.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN order_state = 'paid' THEN 1 ELSE 0 END) AS paid_pending,
                SUM(CASE WHEN order_state = 'applied' THEN 1 ELSE 0 END) AS applied
         FROM subscription_orders`,
      ).first(),
      database.prepare(
        `SELECT COUNT(*) AS entries,
                COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_stars
                                  ELSE -amount_stars END), 0) AS net_stars
         FROM payment_ledger`,
      ).first(),
      database.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status IN ('active', 'cancel_at_period_end')
                         THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended
         FROM subscriptions`,
      ).first(),
      database.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'manual_review' THEN 1 ELSE 0 END)
                  AS manual_review,
                SUM(CASE WHEN status IN
                  ('requested', 'confirmed', 'manual_review')
                  THEN 1 ELSE 0 END) AS unsettled
         FROM payment_refunds`,
      ).first(),
      database.prepare(
        `SELECT status, transactions_seen, transactions_matched,
                missing_local, missing_telegram, discrepancies,
                error_code, finished_at
         FROM payment_reconciliation_runs
         ORDER BY started_at DESC LIMIT 1`,
      ).first(),
    ]);
  return Object.freeze({
    ready: Number(schema?.total || 0) === 11 &&
      Number(orders?.paid_pending || 0) === 0 &&
      Number(refunds?.unsettled || 0) === 0 &&
      (!latestRun || (
        latestRun.status === "completed" &&
        Number(latestRun.discrepancies || 0) === 0
      )),
    schemaTables: Number(schema?.total || 0),
    expectedSchemaTables: 11,
    switches: {
      paymentsEnabled: config.paymentsEnabled,
      paymentsReady: config.paymentsReady,
      refundsEnabled: config.refundsEnabled,
      reconciliationEnabled: config.reconciliationEnabled,
    },
    configurationProblems: [...config.paymentProblems],
    orders: {
      total: Number(orders?.total || 0),
      paidPending: Number(orders?.paid_pending || 0),
      applied: Number(orders?.applied || 0),
    },
    ledger: {
      entries: Number(ledger?.entries || 0),
      netStars: Number(ledger?.net_stars || 0),
    },
    subscriptions: {
      total: Number(subscriptions?.total || 0),
      active: Number(subscriptions?.active || 0),
      suspended: Number(subscriptions?.suspended || 0),
    },
    refunds: {
      total: Number(refunds?.total || 0),
      manualReview: Number(refunds?.manual_review || 0),
      unsettled: Number(refunds?.unsettled || 0),
    },
    reconciliation: latestRun ? {
      status: latestRun.status,
      transactionsSeen: Number(latestRun.transactions_seen || 0),
      transactionsMatched: Number(latestRun.transactions_matched || 0),
      missingLocal: Number(latestRun.missing_local || 0),
      missingTelegram: Number(latestRun.missing_telegram || 0),
      discrepancies: Number(latestRun.discrepancies || 0),
      errorCode: String(latestRun.error_code || ""),
      finishedAt: latestRun.finished_at ? Number(latestRun.finished_at) : null,
    } : null,
  });
}

export async function getStarsUserAccessSummary(env, telegramId, {
  at = nowSeconds(),
} = {}) {
  const userId = normalizePositiveTelegramId(telegramId);
  if (!userId) throw accessError("telegram_id_invalid");
  const timestamp = validateClock(at);
  const row = await requireDatabase(env).prepare(
    `SELECT plans.plan_code, states.access_state,
            subscriptions.current_period_end, subscriptions.auto_renew
     FROM (SELECT ? AS telegram_id) subject
     LEFT JOIN user_plans plans ON plans.telegram_id = subject.telegram_id
     LEFT JOIN user_access_states states
       ON states.telegram_id = subject.telegram_id
     LEFT JOIN subscriptions
       ON subscriptions.telegram_id = subject.telegram_id
      AND subscriptions.status IN
        ('active', 'cancel_at_period_end', 'suspended')
     ORDER BY subscriptions.current_period_end DESC
     LIMIT 1`,
  ).bind(userId).first();
  const packages = await readPackageFinancialAccessSummary(env, userId, timestamp);
  if (packages.current) return Object.freeze({
    planCode: packages.current.planCode,
    planLabel: planLabel(packages.current.planCode),
    accessState: row?.access_state === 'suspended' ? 'suspended' : 'active',
    periodEndsAt: packages.current.endsAt,
    remainingSeconds: Math.max(0, packages.current.endsAt - timestamp),
    autoRenew: false,
  });
  const planCode = ["free", "professional", "dragon"].includes(row?.plan_code)
    ? row.plan_code
    : "free";
  const periodEndsAt = Number(row?.current_period_end || 0) || null;
  return Object.freeze({
    planCode,
    planLabel: planLabel(planCode),
    accessState: String(row?.access_state || "none"),
    periodEndsAt,
    remainingSeconds: periodEndsAt ? Math.max(0, periodEndsAt - timestamp) : 0,
    autoRenew: false,
  });
}

export async function getStarsUserPrivacySummary(env, telegramId) {
  const userId = normalizePositiveTelegramId(telegramId);
  if (!userId) throw accessError("telegram_id_invalid");
  const lifecycle = await inspectLifecyclePrivacyRetention(requireDatabase(env), userId);
  const row = await requireDatabase(env).prepare(
    `SELECT
       (SELECT COUNT(*) FROM terms_acceptances
        WHERE telegram_id = ?) AS terms_acceptances,
       (SELECT COUNT(*) FROM subscription_orders
        WHERE telegram_id = ?) AS orders,
       (SELECT COUNT(*) FROM payment_ledger
        WHERE telegram_id = ?) AS ledger_entries,
       (SELECT COUNT(*) FROM subscriptions
        WHERE telegram_id = ?) AS subscriptions,
       (SELECT COUNT(*) FROM payment_refunds
        WHERE telegram_id = ?) AS refunds,
       (SELECT COUNT(*) FROM subscription_orders
        WHERE telegram_id = ?
          AND order_state IN ('created', 'precheckout_ok', 'paid')) AS open_orders,
       (SELECT COUNT(*) FROM subscriptions
        WHERE telegram_id = ?
          AND status IN ('active', 'cancel_at_period_end', 'suspended'))
          AS live_subscriptions
     LIMIT 1`,
  ).bind(userId, userId, userId, userId, userId, userId, userId).first();
  return Object.freeze({
    termsAcceptances: Number(row?.terms_acceptances || 0),
    orders: Number(row?.orders || 0),
    ledgerEntries: Number(row?.ledger_entries || 0),
    subscriptions: Number(row?.subscriptions || 0),
    refunds: Number(row?.refunds || 0),
    openOrders: Number(row?.open_orders || 0),
    liveSubscriptions: Number(row?.live_subscriptions || 0),
    ...(lifecycle.state.present ? {
      ...lifecycle.summary, retainedLifecycleFinancial: lifecycle.retainedFinancial,
    } : {}),
  });
}

export async function getStarsPrivacyDeletionBlockers(env, telegramId) {
  const summary = await getStarsUserPrivacySummary(env, telegramId);
  const blockers = [];
  if (summary.openOrders) {
    blockers.push("есть незавершённый счёт Telegram Stars");
  }
  if (summary.liveSubscriptions) {
    blockers.push("есть действующий или приостановленный платный период");
  }
  if (
    summary.termsAcceptances || summary.orders || summary.ledgerEntries ||
    summary.subscriptions || summary.refunds || summary.retainedLifecycleFinancial
  ) {
    blockers.push(
      "есть платёжный аудит, который пока должен обрабатываться через поддержку",
    );
  }
  return Object.freeze({ summary, blockers: Object.freeze(blockers) });
}

export async function getStarsAiAccessStatus(env, telegramId, options = {}) {
  const summary = await getStarsUserAccessSummary(env, telegramId, options);
  return Object.freeze(Object.fromEntries(
    SAFE_AI_ACCESS_FIELDS.map((field) => [field, summary[field]]),
  ));
}

export function assertStarsAiOperation(operation) {
  if (String(operation || "") !== "access_status.read") {
    throw accessError("ai_payment_action_forbidden");
  }
  return "access_status.read";
}

export function buildStarsReceipt({
  orderId,
  planCode,
  amountStars,
  periodEndsAt,
}) {
  const normalizedOrderId = validateUuid(orderId, "order_id_invalid");
  const plan = normalizeStarsPlanCode(planCode);
  const amount = Number(amountStars);
  const endsAt = validateClock(periodEndsAt);
  if (!plan || ![249, 499].includes(amount)) {
    throw accessError("receipt_product_invalid");
  }
  return Object.freeze({
    text:
      "<b>✅ Оплата подтверждена</b>\n\n" +
      `Тариф: <b>${planLabel(plan)}</b>\n` +
      `Оплачено: <b>${amount} ⭐</b>\n` +
      "Период: <b>30 дней</b>\n" +
      `Доступ до: <b>${publicDateTime(endsAt)} МСК</b>\n` +
      `Квитанция: <code>${normalizedOrderId.slice(-8).toUpperCase()}</code>\n\n` +
      "Автосписания нет. Для следующего периода потребуется новая оплата. " +
      "По вопросам покупки используйте /paysupport.",
    orderReference: normalizedOrderId.slice(-8).toUpperCase(),
  });
}

export function buildStarsTermsText({ offers = [] } = {}) {
  const releasedPrices = new Map(
    (Array.isArray(offers) ? offers : [])
      .filter((offer) =>
        ["professional", "dragon"].includes(offer?.planCode) &&
        Number.isSafeInteger(Number(offer?.amountStars)) &&
        Number(offer.amountStars) > 0
      )
      .map((offer) => [offer.planCode, Number(offer.amountStars)]),
  );
  const priceText = releasedPrices.size === 2
    ? `Professional 🔵 стоит ${releasedPrices.get("professional")} ⭐, ` +
      `Dragon 🔴 — ${releasedPrices.get("dragon")} ⭐. `
    : "Актуальная цена выбранного тарифа показывается перед подтверждением. ";
  return (
    "<b>💳 Условия покупок в Telegram Stars</b>\n\n" +
    priceText + "Каждая покупка " +
    "даёт 30 дней доступа. Это предоплата без автоматического продления: " +
    "после окончания периода новые Stars сами не списываются.\n\n" +
    "Цена и срок показываются до подтверждения. Доступ включается только после " +
    "сообщения Telegram об успешной оплате. Тариф не меняет системную роль, " +
    "партнёрский статус или юридический профиль. После окончания сохраняются " +
    "аккаунт, заявки, профиль и история.\n\n" +
    "Вопросы, спорные списания и запросы возврата рассматриваются через " +
    "/paysupport. Возврат не обещается автоматически: решение принимается по " +
    "обстоятельствам и правилам покупки. Поддержка Telegram не решает споры по " +
    "товарам и услугам этого бота.\n\n" +
    "Версия условий: <code>2026-09-10.stars-v1</code>. Перед покупкой требуется " +
    "отдельное подтверждение этой версии."
  );
}

export function buildStarsSupportText(paymentQuestion = false) {
  if (paymentQuestion) {
    return (
      "<b>💳 Поддержка по оплате</b>\n\n" +
      "Напишите в официальный бот @RE_Program_Support_Bot и укажите, что " +
      "вопрос связан с Telegram Stars. Не отправляйте номер карты, CVV/CVC, " +
      "код из СМС или пароль.\n\n" +
      "Покупки обслуживает команда RE Program; поддержка Telegram не может " +
      "оформить возврат за услугу этого бота."
    );
  }
  return (
    "<b>🛟 Официальная поддержка</b>\n\n" +
    "Опишите вопрос в @RE_Program_Support_Bot. Профиль, переписка и платёжные " +
    "данные из основного бота туда автоматически не передаются."
  );
}

export const STARS_AI_FORBIDDEN_FIELDS = Object.freeze([
  ...AI_FORBIDDEN_PAYMENT_FIELDS,
  "order_id",
  "ledger_entry_id",
  "refund_id",
]);
