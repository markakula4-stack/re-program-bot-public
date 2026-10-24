import { readStarsCoreConfig, normalizePositiveTelegramId } from "./stars-core-foundation.mjs";

const ROLLOUT_MODES = new Set([
  "off",
  "admin",
  "allowlist",
  "percent",
  "all",
]);
function rolloutError(code) {
  const error = new Error("Telegram Stars rollout gate rejected the request");
  error.code = code;
  return error;
}

function rolloutMode(env) {
  const mode = String(env?.STARS_ROLLOUT_MODE || "off")
    .trim()
    .toLowerCase();
  return ROLLOUT_MODES.has(mode) ? mode : "off";
}

function rolloutAllowlist(env) {
  const values = String(env?.STARS_ROLLOUT_ALLOWLIST || "")
    .split(/[\s,;]+/)
    .map(normalizePositiveTelegramId)
    .filter(Boolean)
    .slice(0, 500);
  return new Set(values);
}

async function rolloutBucket(env, telegramId) {
  const secret = String(env?.STARS_ROLLOUT_SECRET || "");
  if (secret.length < 32) throw rolloutError("stars_rollout_secret_missing");
  const bytes = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${secret}\n${telegramId}`),
  ));
  const value = (
    ((bytes[0] << 24) >>> 0) +
    (bytes[1] << 16) +
    (bytes[2] << 8) +
    bytes[3]
  ) >>> 0;
  return value % 100;
}

export async function getStarsRolloutDecision(env, telegramId) {
  const userId = normalizePositiveTelegramId(telegramId);
  if (!userId) throw rolloutError("telegram_id_invalid");
  const config = readStarsCoreConfig(env);
  const mode = rolloutMode(env);
  const adminId = normalizePositiveTelegramId(env?.ADMIN_ID);
  const allowlist = rolloutAllowlist(env);
  let eligible = false;
  let reason = "stars_rollout_off";
  let percent = 0;

  if (!config.ready) {
    reason = config.enabled
      ? "stars_payments_not_ready"
      : "stars_payments_disabled";
  } else if (mode === "all") {
    eligible = true;
    reason = "all_users";
    percent = 100;
  } else if (mode === "admin") {
    eligible = Boolean(adminId && userId === adminId);
    reason = eligible ? "admin_canary" : "admin_canary_only";
  } else if (mode === "allowlist") {
    eligible = Boolean(
      (adminId && userId === adminId) || allowlist.has(userId),
    );
    reason = eligible ? "allowlist_canary" : "not_allowlisted";
  } else if (mode === "percent") {
    percent = Number(env?.STARS_ROLLOUT_PERCENT || 0);
    if (!Number.isSafeInteger(percent) || percent < 1 || percent > 100) {
      reason = "stars_rollout_percent_invalid";
    } else if ((adminId && userId === adminId) || allowlist.has(userId)) {
      eligible = true;
      reason = "canary_override";
    } else {
      eligible = (await rolloutBucket(env, userId)) < percent;
      reason = eligible ? "percentage_selected" : "percentage_not_selected";
    }
  }

  return Object.freeze({
    mode,
    eligible,
    reason,
    percent,
    paymentsEnabled: config.enabled,
    paymentsReady: config.ready,
    configurationProblems: Object.freeze([...config.problems]),
  });
}

export { rolloutError, rolloutMode, rolloutAllowlist };
