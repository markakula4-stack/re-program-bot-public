export const DRAGON_PREVIEW_PROGRAM_CODE = "dragon_preview";
export const DRAGON_PREVIEW_DURATION_SECONDS = 7 * 24 * 60 * 60;
export const DRAGON_PREVIEW_WARNING_SECONDS = 24 * 60 * 60;

const DISABLED_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

export function isPreviewFeatureEnabled(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return !DISABLED_VALUES.has(String(value).trim().toLowerCase());
}

export function normalizePreviewChannelId(value) {
  const normalized = String(value || "").trim();
  if (/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(normalized)) return normalized;
  if (/^-100\d{6,20}$/.test(normalized)) return normalized;
  return null;
}

export function normalizePreviewChannelUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "t.me" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(path)) return null;
    return `https://t.me/${path}`;
  } catch {
    return null;
  }
}

export function parsePreviewProgramEnd(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : null;
}

export function parsePreviewRetentionDays(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 30 && parsed <= 730
    ? parsed
    : null;
}

export function parsePreviewAiDailyLimit(value, fallback = 30) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(200, Math.max(1, parsed));
}

export function readDragonPreviewConfig(env, nowSeconds = Math.floor(Date.now() / 1_000)) {
  const enabled = isPreviewFeatureEnabled(env?.DRAGON_PREVIEW_ENABLED, false);
  const channelId = normalizePreviewChannelId(env?.DRAGON_PREVIEW_CHANNEL_ID);
  const channelUrl = normalizePreviewChannelUrl(env?.DRAGON_PREVIEW_CHANNEL_URL);
  const programEndsAt = parsePreviewProgramEnd(env?.DRAGON_PREVIEW_PROGRAM_END_AT);
  const antiAbuseRetentionDays = parsePreviewRetentionDays(
    env?.DRAGON_PREVIEW_ANTI_ABUSE_RETENTION_DAYS,
  );
  const antiAbuseSecret = String(
    env?.DRAGON_PREVIEW_ANTI_ABUSE_SECRET || "",
  );
  const aiDailySuccessLimit = parsePreviewAiDailyLimit(
    env?.DRAGON_PREVIEW_AI_DAILY_SUCCESS_LIMIT,
    30,
  );
  const problems = [];
  if (enabled && !channelId) problems.push("channel_id");
  if (enabled && !channelUrl) problems.push("channel_url");
  if (enabled && !programEndsAt) problems.push("program_end");
  if (enabled && programEndsAt && programEndsAt <= nowSeconds) {
    problems.push("program_closed");
  }
  if (enabled && !antiAbuseRetentionDays) problems.push("retention_days");
  if (enabled && antiAbuseSecret.length < 32) problems.push("anti_abuse_secret");
  if (enabled && typeof env?.DRAGON_PREVIEW_WORKFLOW?.create !== "function") {
    problems.push("workflow_binding");
  }
  return Object.freeze({
    enabled,
    ready: enabled && problems.length === 0,
    problems: Object.freeze(problems),
    channelId,
    channelUrl,
    programEndsAt,
    antiAbuseRetentionDays,
    antiAbuseSecret,
    aiDailySuccessLimit,
  });
}

export function isActiveTelegramMembership(member) {
  const status = String(member?.status || "").toLowerCase();
  if (["creator", "administrator", "member"].includes(status)) return true;
  return status === "restricted" && member?.is_member === true;
}

export function calculatePreviewWindow(
  startedAtSeconds,
  durationSeconds = DRAGON_PREVIEW_DURATION_SECONDS,
) {
  const startedAt = Number(startedAtSeconds);
  const duration = Number(durationSeconds);
  if (!Number.isInteger(startedAt) || startedAt <= 0) {
    throw new TypeError("A positive integer start timestamp is required");
  }
  if (!Number.isInteger(duration) || duration <= DRAGON_PREVIEW_WARNING_SECONDS) {
    throw new TypeError("Preview duration must exceed the warning window");
  }
  const endsAt = startedAt + duration;
  return Object.freeze({
    startedAt,
    warningAt: endsAt - DRAGON_PREVIEW_WARNING_SECONDS,
    endsAt,
  });
}

export function isPreviewGrantActive(grant, nowSeconds = Math.floor(Date.now() / 1_000)) {
  return (
    String(grant?.status || "") === "active" &&
    Number(grant?.started_at || 0) <= nowSeconds &&
    Number(grant?.ends_at || 0) > nowSeconds
  );
}

export function formatPreviewDate(timestampSeconds) {
  const milliseconds = Number(timestampSeconds) * 1_000;
  if (!Number.isFinite(milliseconds)) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(milliseconds)) + " UTC";
}

export function formatPreviewRemaining(endsAtSeconds, nowSeconds = Math.floor(Date.now() / 1_000)) {
  const remaining = Math.max(0, Number(endsAtSeconds) - Number(nowSeconds));
  const days = Math.floor(remaining / 86_400);
  const hours = Math.floor((remaining % 86_400) / 3_600);
  const minutes = Math.floor((remaining % 3_600) / 60);
  if (days > 0) return `${days} дн. ${hours} ч.`;
  if (hours > 0) return `${hours} ч. ${minutes} мин.`;
  return `${minutes} мин.`;
}
