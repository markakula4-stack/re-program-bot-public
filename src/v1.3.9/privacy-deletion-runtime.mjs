import { prepareAnalyticsSubjectDeletion } from "./analytics-subject-privacy.mjs";

export const ANALYTICS_PRIVACY_RUNTIME_KEY =
  "__RE_PROGRAM_V139_PRIVACY_RUNTIME__";

export async function prepareV139PrivacyDeletion(env, userId, requestId) {
  const schema = await env.DB.prepare(`SELECT
      EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table'
        AND name = 'analytics_privacy_denials') AS denials,
      EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table'
        AND name = 'analytics_privacy_projection_fence') AS fence,
      EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table'
        AND name = 'analytics_v139_partner_pilot') AS pilot`).first();
  if (!Number(schema?.denials) || !Number(schema?.fence) ||
      !Number(schema?.pilot)) {
    throw new Error("analytics privacy migrations are incomplete");
  }
  const settings = await env.DB.prepare(`SELECT pseudonym_key_version
    FROM analytics_v2_settings WHERE id = 1`).first();
  const latest = Number(settings?.pseudonym_key_version);
  if (!Number.isSafeInteger(latest) || latest < 1 || latest > 8) {
    throw new Error("analytics pseudonym key inventory is invalid");
  }
  let rotated;
  try {
    rotated = env.ANALYTICS_SUBJECT_PSEUDONYM_KEYS_JSON
      ? JSON.parse(env.ANALYTICS_SUBJECT_PSEUDONYM_KEYS_JSON) : {};
  } catch {
    throw new Error("analytics pseudonym key inventory is invalid");
  }
  if (!rotated || typeof rotated !== "object" || Array.isArray(rotated) ||
      Object.keys(rotated).some((key) => !/^[1-8]$/.test(key) ||
        Number(key) > latest)) {
    throw new Error("analytics pseudonym key inventory is invalid");
  }
  const primary = env.ANALYTICS_SUBJECT_PSEUDONYM_SECRET;
  if (typeof primary !== "string" || primary.length < 32 ||
      (rotated["1"] && rotated["1"] !== primary)) {
    throw new Error("analytics pseudonym key inventory is incomplete");
  }
  const keys = Array.from({ length: latest }, (_, index) => ({
    keyVersion: index + 1,
    secret: index === 0 ? primary : rotated[String(index + 1)],
  }));
  if (keys.some((key) => typeof key.secret !== "string" ||
      key.secret.length < 32)) {
    throw new Error("analytics pseudonym key inventory is incomplete");
  }
  const prepared = await prepareAnalyticsSubjectDeletion(env.DB, {
    telegramId: userId, requestId, keyVersions: keys,
    deniedAt: Math.floor(Date.now() / 1000),
  });
  return [...prepared.statements,
    env.DB.prepare(`DELETE FROM analytics_v139_partner_pilot
      WHERE telegram_id = ?`).bind(userId)];
}

export const analyticsPrivacyRuntime = Object.freeze({
  prepareV139PrivacyDeletion,
});
