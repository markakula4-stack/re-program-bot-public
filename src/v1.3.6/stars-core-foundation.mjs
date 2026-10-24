export const STARS_CURRENCY = "XTR";
export const STARS_MONTH_SECONDS = 2_592_000;
export const STARS_ORDER_TTL_SECONDS = 15 * 60;
export const STARS_INITIAL_PRICE_VERSION = 1;
export const STARS_TERMS_REVISION = "2026-09-10.stars-v1";
export const STARS_INVOICE_PAYLOAD_PREFIX = "re:v1";
export const STARS_INVOICE_SIGNATURE_CHARACTERS = 22;

export const STARS_PURCHASABLE_PLANS = Object.freeze([
  "professional",
  "dragon",
]);

export const STARS_BILLING_MODES = Object.freeze([
  "prepaid",
  "recurring",
]);

export const STARS_ORDER_STATES = Object.freeze([
  "created",
  "precheckout_ok",
  "paid",
  "applied",
  "refunded",
  "chargeback",
  "failed",
  "cancelled",
]);

export const STARS_LEDGER_ENTRY_TYPES = Object.freeze([
  "payment",
  "refund",
  "chargeback",
  "adjustment",
]);

export const STARS_INITIAL_PRICE_BOOK = Object.freeze({
  professional: Object.freeze({
    priceId: "professional-30d-prepaid-v1",
    priceVersion: STARS_INITIAL_PRICE_VERSION,
    planCode: "professional",
    currency: STARS_CURRENCY,
    amountStars: 249,
    accessSeconds: STARS_MONTH_SECONDS,
    billingMode: "prepaid",
    termsRevision: STARS_TERMS_REVISION,
  }),
  dragon: Object.freeze({
    priceId: "dragon-30d-prepaid-v1",
    priceVersion: STARS_INITIAL_PRICE_VERSION,
    planCode: "dragon",
    currency: STARS_CURRENCY,
    amountStars: 499,
    accessSeconds: STARS_MONTH_SECONDS,
    billingMode: "prepaid",
    termsRevision: STARS_TERMS_REVISION,
  }),
});

const DISABLED_VALUES = new Set(["0", "false", "off", "no", "disabled"]);
const ORDER_TRANSITIONS = Object.freeze({
  created: new Set(["precheckout_ok", "failed", "cancelled"]),
  precheckout_ok: new Set(["paid", "failed", "cancelled"]),
  paid: new Set(["applied", "refunded", "chargeback"]),
  applied: new Set(["refunded", "chargeback"]),
  refunded: new Set(),
  chargeback: new Set(),
  failed: new Set(),
  cancelled: new Set(),
});

function fixedError(code, message = "Telegram Stars operation rejected") {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function isStarsFeatureEnabled(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return !DISABLED_VALUES.has(String(value).trim().toLowerCase());
}

export function normalizeStarsPlanCode(value) {
  const planCode = String(value || "").trim().toLowerCase();
  return STARS_PURCHASABLE_PLANS.includes(planCode) ? planCode : null;
}

export function normalizeStarsBillingMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return STARS_BILLING_MODES.includes(mode) ? mode : null;
}

export function normalizePositiveTelegramId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function readStarsCoreConfig(env = {}) {
  const enabled = isStarsFeatureEnabled(env.STARS_PAYMENTS_ENABLED, false);
  const billingMode = normalizeStarsBillingMode(
    env.STARS_BILLING_MODE || "prepaid",
  );
  const priceVersion = Number(env.STARS_PRICE_VERSION || STARS_INITIAL_PRICE_VERSION);
  const termsRevision = String(
    env.STARS_TERMS_REVISION || STARS_TERMS_REVISION,
  ).trim();
  const invoiceSecret = String(env.STARS_INVOICE_SECRET || "");
  const problems = [];

  if (enabled && billingMode !== "prepaid") {
    problems.push("billing_mode_not_released");
  }
  if (enabled && (!Number.isInteger(priceVersion) || priceVersion <= 0)) {
    problems.push("price_version");
  }
  if (enabled && !/^[0-9A-Za-z._-]{8,64}$/.test(termsRevision)) {
    problems.push("terms_revision");
  }
  if (enabled && invoiceSecret.length < 32) {
    problems.push("invoice_secret");
  }

  return Object.freeze({
    enabled,
    ready: enabled && problems.length === 0,
    problems: Object.freeze(problems),
    billingMode,
    priceVersion,
    termsRevision,
  });
}

export function normalizeServerPrice(row) {
  const planCode = normalizeStarsPlanCode(row?.plan_code);
  const billingMode = normalizeStarsBillingMode(row?.billing_mode);
  const priceVersion = Number(row?.price_version);
  const amountStars = Number(row?.amount_stars);
  const accessSeconds = Number(row?.access_seconds);
  const validFrom = Number(row?.valid_from);
  const validUntil = row?.valid_until === null || row?.valid_until === undefined
    ? null
    : Number(row.valid_until);
  const priceId = String(row?.price_id || "");
  const termsRevision = String(row?.terms_revision || "");

  if (!planCode) throw fixedError("price_plan_invalid");
  if (!billingMode) throw fixedError("price_billing_mode_invalid");
  if (!Number.isInteger(priceVersion) || priceVersion <= 0) {
    throw fixedError("price_version_invalid");
  }
  if (row?.currency !== STARS_CURRENCY) {
    throw fixedError("price_currency_invalid");
  }
  if (!Number.isInteger(amountStars) || amountStars < 1 || amountStars > 10_000) {
    throw fixedError("price_amount_invalid");
  }
  if (accessSeconds !== STARS_MONTH_SECONDS) {
    throw fixedError("price_period_invalid");
  }
  if (!/^[a-z0-9][a-z0-9-]{10,95}$/.test(priceId)) {
    throw fixedError("price_id_invalid");
  }
  if (!/^[0-9A-Za-z._-]{8,64}$/.test(termsRevision)) {
    throw fixedError("price_terms_revision_invalid");
  }
  if (!Number.isSafeInteger(validFrom) || validFrom <= 0) {
    throw fixedError("price_valid_from_invalid");
  }
  if (
    validUntil !== null &&
    (!Number.isSafeInteger(validUntil) || validUntil <= validFrom)
  ) {
    throw fixedError("price_valid_until_invalid");
  }

  return Object.freeze({
    priceId,
    priceVersion,
    planCode,
    currency: STARS_CURRENCY,
    amountStars,
    accessSeconds,
    billingMode,
    publicationState: String(row.publication_state || ""),
    termsRevision,
    validFrom,
    validUntil,
  });
}

export function selectServerPrice(rows, requestedPlanCode, config, nowSeconds) {
  if (!config?.ready) throw fixedError("stars_payments_not_ready");
  const planCode = normalizeStarsPlanCode(requestedPlanCode);
  if (!planCode) throw fixedError("plan_not_purchasable");
  const now = Number(nowSeconds);
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw fixedError("payment_clock_invalid");
  }

  // Scope raw rows to the exact v1.3.6 release contract before strict
  // normalization. This keeps later additive price versions and longer
  // prepaid packages from breaking an older Worker while still rejecting a
  // malformed row that claims to be the active 30-day price.
  const releaseRows = (Array.isArray(rows) ? rows : []).filter((row) =>
    normalizeStarsPlanCode(row?.plan_code) === planCode &&
    normalizeStarsBillingMode(row?.billing_mode) === config.billingMode &&
    Number(row?.price_version) === config.priceVersion &&
    Number(row?.access_seconds) === STARS_MONTH_SECONDS &&
    String(row?.terms_revision || "") === config.termsRevision
  );

  const candidates = releaseRows
    .map(normalizeServerPrice)
    .filter((price) =>
      price.publicationState === "approved" &&
      price.validFrom <= now &&
      (price.validUntil === null || price.validUntil > now)
    );

  if (candidates.length !== 1) {
    throw fixedError(
      candidates.length === 0
        ? "server_price_unavailable"
        : "server_price_ambiguous",
    );
  }
  return candidates[0];
}

function assertUuid(value, code) {
  const normalized = String(value || "").toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw fixedError(code);
  }
  return normalized;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function constantTimeTextMatches(leftValue, rightValue) {
  const left = new TextEncoder().encode(String(leftValue || ""));
  const right = new TextEncoder().encode(String(rightValue || ""));
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] || 0) ^ (right[index] || 0);
  }
  return difference === 0;
}

function invoiceSignatureMaterial(orderId, telegramId, priceId) {
  return [
    STARS_INVOICE_PAYLOAD_PREFIX,
    assertUuid(orderId, "order_id_invalid"),
    normalizePositiveTelegramId(telegramId),
    String(priceId || ""),
  ].join("\n");
}

async function createInvoiceSignature(invoiceSecret, material) {
  const secret = String(invoiceSecret || "");
  if (secret.length < 32) throw fixedError("invoice_secret_invalid");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(material),
  );
  return bytesToBase64Url(new Uint8Array(signature))
    .slice(0, STARS_INVOICE_SIGNATURE_CHARACTERS);
}

export async function buildStarsInvoicePayload({
  invoiceSecret,
  orderId,
  telegramId,
  priceId,
}) {
  const normalizedOrderId = assertUuid(orderId, "order_id_invalid");
  const userId = normalizePositiveTelegramId(telegramId);
  if (!userId) throw fixedError("telegram_id_invalid");
  if (!/^[a-z0-9][a-z0-9-]{10,95}$/.test(String(priceId || ""))) {
    throw fixedError("price_id_invalid");
  }
  const signature = await createInvoiceSignature(
    invoiceSecret,
    invoiceSignatureMaterial(normalizedOrderId, userId, priceId),
  );
  const payload = `${STARS_INVOICE_PAYLOAD_PREFIX}:${normalizedOrderId}:${signature}`;
  if (payload.length > 128) throw fixedError("invoice_payload_too_long");
  return payload;
}

export function parseStarsInvoicePayload(payload) {
  const match = String(payload || "").match(
    /^re:v1:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([A-Za-z0-9_-]{22})$/,
  );
  if (!match) throw fixedError("invoice_payload_invalid");
  return Object.freeze({ orderId: match[1], signature: match[2] });
}

export async function verifyStarsInvoicePayload({
  invoiceSecret,
  payload,
  telegramId,
  priceId,
}) {
  const parsed = parseStarsInvoicePayload(payload);
  const userId = normalizePositiveTelegramId(telegramId);
  if (!userId) throw fixedError("telegram_id_invalid");
  const expected = await createInvoiceSignature(
    invoiceSecret,
    invoiceSignatureMaterial(parsed.orderId, userId, priceId),
  );
  if (!constantTimeTextMatches(parsed.signature, expected)) {
    throw fixedError("invoice_signature_invalid");
  }
  return parsed;
}

export function buildServerOrderSnapshot({
  telegramId,
  requestedPlanCode,
  orderId,
  nowSeconds,
  price,
}) {
  const userId = normalizePositiveTelegramId(telegramId);
  if (!userId) throw fixedError("telegram_id_invalid");
  const planCode = normalizeStarsPlanCode(requestedPlanCode);
  if (!planCode || planCode !== price?.planCode) {
    throw fixedError("order_plan_mismatch");
  }
  const normalizedOrderId = assertUuid(orderId, "order_id_invalid");
  const createdAt = Number(nowSeconds);
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) {
    throw fixedError("payment_clock_invalid");
  }
  // Part 1 keeps this deterministic unsigned placeholder for isolated schema
  // tests. The payment runtime must replace it with buildStarsInvoicePayload()
  // before persisting or sending a real invoice.
  const invoicePayload = `${STARS_INVOICE_PAYLOAD_PREFIX}:${normalizedOrderId}`;

  return Object.freeze({
    orderId: normalizedOrderId,
    telegramId: userId,
    priceId: price.priceId,
    priceVersion: price.priceVersion,
    planCode: price.planCode,
    currency: price.currency,
    amountStars: price.amountStars,
    accessSeconds: price.accessSeconds,
    billingMode: price.billingMode,
    termsRevision: price.termsRevision,
    invoicePayload,
    orderState: "created",
    createdAt,
    expiresAt: createdAt + STARS_ORDER_TTL_SECONDS,
  });
}

export function canTransitionStarsOrder(fromState, toState) {
  const from = String(fromState || "");
  const to = String(toState || "");
  if (!STARS_ORDER_STATES.includes(from) || !STARS_ORDER_STATES.includes(to)) {
    return false;
  }
  return from === to || ORDER_TRANSITIONS[from].has(to);
}

export function validateLedgerShape(entry) {
  const entryType = String(entry?.entryType || "");
  const direction = String(entry?.direction || "");
  const amountStars = Number(entry?.amountStars);
  const relatedEntryId = entry?.relatedLedgerEntryId || null;
  const chargeId = String(entry?.telegramPaymentChargeId || "");

  if (!STARS_LEDGER_ENTRY_TYPES.includes(entryType)) {
    throw fixedError("ledger_entry_type_invalid");
  }
  if (entry?.currency !== STARS_CURRENCY) {
    throw fixedError("ledger_currency_invalid");
  }
  if (!Number.isInteger(amountStars) || amountStars < 1 || amountStars > 10_000) {
    throw fixedError("ledger_amount_invalid");
  }
  if (entryType === "payment") {
    if (direction !== "credit" || relatedEntryId || !chargeId) {
      throw fixedError("ledger_payment_shape_invalid");
    }
  } else if (["refund", "chargeback"].includes(entryType)) {
    if (direction !== "debit" || !relatedEntryId || !chargeId) {
      throw fixedError("ledger_compensation_shape_invalid");
    }
  } else if (!relatedEntryId || !["credit", "debit"].includes(direction)) {
    throw fixedError("ledger_adjustment_shape_invalid");
  }

  return Object.freeze({
    entryType,
    direction,
    currency: STARS_CURRENCY,
    amountStars,
    signedAmountStars: direction === "credit" ? amountStars : -amountStars,
  });
}

export const AI_FORBIDDEN_PAYMENT_FIELDS = Object.freeze([
  "telegram_payment_charge_id",
  "provider_payment_charge_id",
  "invoice_payload",
  "payment_ledger",
  "star_balance",
]);
