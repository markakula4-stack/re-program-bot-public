// Shared purchase-slot interpretation. Expiry frees an invoice slot, never
// proves cancellation at Telegram or erases an approved/payment receipt.
export function isStarsOrderPurchaseLock(order, at) {
  const state = String(order?.order_state ?? order?.orderState ?? "");
  if (state === "paid") return true;
  return ["created", "precheckout_ok"].includes(state) &&
    Number(order?.expires_at ?? order?.expiresAt) > Number(at);
}

export const STARS_PURCHASE_LOCK_SQL =
  "(order_state = 'paid' OR (order_state IN ('created', 'precheckout_ok') AND expires_at > ?))";
