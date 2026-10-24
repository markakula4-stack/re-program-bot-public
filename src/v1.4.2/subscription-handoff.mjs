// These fixed selectors express a user's choice, never permission to buy or a
// client-side price. Telegram's verified actor and server admission stay final.
const paidPlans = new Set(['professional', 'dragon']);
const positive = value => Number.isSafeInteger(value) && value > 0;

export function parseSubscriptionStartPayload(payload) {
  if (typeof payload !== 'string') return null;
  const match = /^subscribe_(professional|dragon)$/u.exec(payload);
  return match?.[1] ?? null;
}

export function createSubscriptionSelectionUrl(planCode) {
  return paidPlans.has(planCode)
    ? `https://t.me/RE_Program_Bot?start=subscribe_${planCode}`
    : null;
}

export function parseSubscriptionPurchaseQuote(callback) {
  if (typeof callback !== 'string' || new TextEncoder().encode(callback).length > 64) return null;
  const match = /^stars_accept:(professional|dragon):([1-9][0-9]*):([1-9][0-9]*):([a-f0-9]{16})$/u.exec(callback);
  if (!match || !positive(Number(match[2])) || !positive(Number(match[3]))) return null;
  return Object.freeze({
    planCode: match[1], priceVersion: Number(match[2]), amountStars: Number(match[3]),
    contextFingerprint: match[4],
  });
}

export async function createSubscriptionPurchaseQuote({
  planCode, priceVersion, amountStars, termsRevision, billingMode, accessSeconds,
} = {}) {
  if (!paidPlans.has(planCode) || !positive(priceVersion) || !positive(amountStars) ||
      typeof termsRevision !== 'string' || !/^[0-9A-Za-z._-]{8,64}$/u.test(termsRevision) ||
      billingMode !== 'prepaid' || !positive(accessSeconds)) return null;
  // The fingerprint detects a changed terms/duration/billing context even if
  // its published price version and amount stayed the same. It is not a permit
  // or signature: accepting any quote still requires fresh server authority.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify([termsRevision, billingMode, accessSeconds]))));
  const fingerprint = Array.from(digest.slice(0, 8), byte => byte.toString(16).padStart(2, '0')).join('');
  const callback = `stars_accept:${planCode}:${priceVersion}:${amountStars}:${fingerprint}`;
  return parseSubscriptionPurchaseQuote(callback) ? callback : null;
}
