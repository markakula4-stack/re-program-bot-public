import {
  readReferralRewardConfig,
  REFERRAL_REWARD_PROGRAM_CODE,
  requireUnixSeconds,
} from "./referral-reward-foundation.mjs";
import {
  claimReferralBonusAccess,
  getReferralBonusStatus,
  repairReferralBonusGrants,
  runReferralBonusMaintenance,
} from "./referral-bonus-access-runtime.mjs";
import {
  repairReferralProtectionWorkflows,
} from "./referral-reward-protection-runtime.mjs";
import {repairPackageReferralRewardProtection} from '../v1.4.4/package-referral-runtime.mjs';
import {getPackageReferralBonusStatus,claimPackageReferralBonusGrant,readPackageReferralBonusClaimDatabaseSource,
  repairPackageReferralBonusGrants,runPackageReferralBonusMaintenance} from '../v1.4.4/package-referral-bonus-runtime.mjs';
import {isLegacyCompatibilityEnv,executeOwnPackageReferralBonusClaim} from '../v1.4.1/telegram-legacy-compatibility.mjs';

async function readOwnRewardStatus(env,options) {
  const legacy=await getReferralBonusStatus(env,options),additive=await getPackageReferralBonusStatus(env,options);
  return additive.bonusGrantId||legacy.status==='none' ? additive : legacy;
}

export const REFERRAL_REWARD_CALLBACKS = Object.freeze({
  status: "referral_reward_status",
  claim: "referral_bonus_claim",
  admin: "admin_referral_rewards",
  adminRepairAsk: "admin_referral_repair_ask",
  adminRepair: "admin_referral_repair",
});

const NOTICE_LEASE_SECONDS = 2 * 60;
const NOTICE_MAX_ATTEMPTS = 10;
const DEFAULT_BATCH_LIMIT = 25;
const MAX_BATCH_LIMIT = 50;
const TERMINAL_NOTICE_STATES = new Set([
  "delivered",
  "suppressed",
  "manual_review",
]);

function nowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function uxError(code, cause) {
  const error = new Error("Referral reward UX operation rejected");
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export function safeReferralUxErrorCode(
  error,
  fallback = "referral_ux_error",
) {
  return String(error?.code || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 64) || fallback;
}

function requireDatabase(env) {
  if (!env?.DB?.prepare || !env?.DB?.batch) {
    throw uxError("referral_ux_database_not_ready");
  }
  return env.DB;
}

function validateTelegramId(value) {
  const normalized =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw uxError("referral_ux_telegram_id_invalid");
  }
  return normalized;
}

function validateClock(value, fieldName = "at") {
  try {
    return requireUnixSeconds(value ?? nowSeconds(), fieldName);
  } catch (cause) {
    throw uxError("referral_ux_clock_invalid", cause);
  }
}

function validateLimit(value) {
  const limit = Number(value ?? DEFAULT_BATCH_LIMIT);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_BATCH_LIMIT
  ) {
    throw uxError("referral_ux_limit_invalid");
  }
  return limit;
}

function changed(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0) > 0;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

export function formatReferralRewardTime(value) {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return "уточняется";
  const date = new Date(seconds * 1_000);
  if (!Number.isFinite(date.getTime())) return "уточняется";
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

function planLabel(planCode) {
  return planCode === "dragon" ? "Dragon 🔴" : "Professional 🔵";
}

function baseKeyboard(extra = []) {
  return [
    ...extra,
    [{ text: "🔄 Обновить", callback_data: REFERRAL_REWARD_CALLBACKS.status }],
    [{ text: "⬅️ В меню", callback_data: "menu" }],
  ];
}

async function loadCanonicalAccess(database, telegramId) {
  return database.prepare(
    `SELECT plans.plan_code, access_state.access_state,
            CAST(strftime('%s', access_state.state_ends_at) AS INTEGER)
              AS state_ends_at
     FROM user_plans plans
     JOIN user_access_states access_state
       ON access_state.telegram_id = plans.telegram_id
     WHERE plans.telegram_id = ?
     LIMIT 1`,
  ).bind(telegramId).first();
}

function unavailableScreen(message) {
  return Object.freeze({
    state: "unavailable",
    text:
      "<b>🎁 +3 дня за друга</b>\n\n" +
      String(message || "Статус временно недоступен. Попробуйте немного позже."),
    keyboard: baseKeyboard([
      [{ text: "🛟 Поддержка", callback_data: "support" }],
    ]),
  });
}

export function buildReferralRewardUserScreen({
  status,
  canonicalAccess = null,
  config = {},
  at,
} = {}) {
  const timestamp = validateClock(at);
  const state = String(status?.status || "none");
  const accessState = String(canonicalAccess?.access_state || "");
  const claimExpiresAt = Number(status?.claimExpiresAt || 0);
  const startsAt = Number(status?.startsAt || 0);
  const endsAt = Number(status?.endsAt || 0);

  if (state === "none") {
    return Object.freeze({
      state: "none",
      text:
        "<b>🎁 +3 дня за друга</b>\n\n" +
        "Награда пока не появилась. Она доступна один раз — за первого приглашённого друга, который впервые оплатит Professional или Dragon в предусмотренный срок.",
      keyboard: baseKeyboard(),
    });
  }

  if (state === "pending") {
    return Object.freeze({
      state,
      text:
        "<b>⏳ Награда проходит проверку</b>\n\n" +
        "Подходящая оплата друга найдена. Защитная проверка занимает 21 день; решение будет принято не раньше " +
        `<b>${formatReferralRewardTime(status.confirmAfter)}</b>.\n\n` +
        "Повторная оплата и дополнительные действия не нужны.",
      keyboard: baseKeyboard(),
    });
  }

  if (state === "confirmed" && !status?.bonusGrantId) {
    return Object.freeze({
      state: "preparing",
      text:
        "<b>✅ Награда подтверждена</b>\n\n" +
        "Безопасная выдача дополнительных трёх дней ещё завершается. Повторные действия не нужны. Если статус долго не меняется, напишите в поддержку.",
      keyboard: baseKeyboard([
        [{ text: "🛟 Поддержка", callback_data: "support" }],
      ]),
    });
  }

  if (state === "claimable") {
    if (claimExpiresAt && timestamp > claimExpiresAt) {
      return Object.freeze({
        state: "expired",
        text:
          "<b>⌛ Окно активации завершилось</b>\n\n" +
          "Тридцатидневный срок для запуска трёх бонусных дней истёк. Оплаченный доступ и Stars не изменялись.",
        keyboard: baseKeyboard(),
      });
    }
    const previewWarning = accessState === "trial"
      ? "\n\nСейчас действует Dragon Preview. После нажатия Preview завершится, и 72 часа Professional начнутся сразу."
      : "\n\nПосле нажатия 72 часа Professional начнутся сразу; выбрать будущую дату нельзя.";
    const activationAvailable = Boolean(config?.bonusGrantsEnabled);
    const activationState = activationAvailable
      ? ""
      : "\n\nАктивация временно приостановлена. Срок окна указан ниже; если он близко, напишите в поддержку.";
    const buttons = activationAvailable
      ? [[{
          text: "🎁 Активировать 3 дня Professional",
          callback_data: REFERRAL_REWARD_CALLBACKS.claim,
        }]]
      : [[{ text: "🛟 Поддержка", callback_data: "support" }]];
    return Object.freeze({
      state,
      text:
        "<b>🎁 Награда готова</b>\n\n" +
        "Вам доступны <b>3 дня Professional 🔵</b>. " +
        `Активировать можно до <b>${formatReferralRewardTime(claimExpiresAt)}</b>.` +
        previewWarning + activationState,
      keyboard: baseKeyboard(buttons),
    });
  }

  if (state === "applied" || state === "duplicate") {
    if (endsAt && endsAt <= timestamp) {
      return Object.freeze({
        state: "expired",
        text:
          "<b>✅ Бонусные дни завершились</b>\n\n" +
          "Три дополнительных дня использованы полностью. История награды сохранена.",
        keyboard: baseKeyboard(),
      });
    }
    if(status?.packageReferralBonus===true) {
      const segments=status.bonusSegments??[{startsAt,endsAt}];
      const dates=segments.slice(0,8).map(s=>`${formatReferralRewardTime(s.startsAt)} — ${formatReferralRewardTime(s.endsAt)}`).join('\n');
      return Object.freeze({state:'applied',text:'<b>✅ Бонусные 72 часа сохранены</b>\n\n'+
        `<b>${planLabel(status.planCode)}</b> · без списания Stars.\n`+
        (startsAt>timestamp?'Бонус начнётся после уже оплаченных периодов.\n':'')+
        (segments.length>1?'Бонус распределён между оплаченными периодами; все 72 часа сохранены.\n':'')+
        dates+(segments.length>8?'\nОстальные периоды сохранены в истории.':'')+'\n\nОплаченные даты не менялись.',
        keyboard:baseKeyboard([[{text:'💎 Мой тариф',callback_data:'stars_my_plan'}]])});
    }
    if (status?.deliveryMode === "extend_active_plan") {
      return Object.freeze({
        state: "applied",
        text:
          "<b>✅ Три дня добавлены</b>\n\n" +
          `Текущий ${planLabel(status.planCode)} продлён на 72 часа. ` +
          `Новая дата окончания: <b>${formatReferralRewardTime(endsAt)}</b>.\n\n` +
          "Stars не списывались, тариф не менялся.",
        keyboard: baseKeyboard([
          [{ text: "💎 Мой тариф", callback_data: "stars_my_plan" }],
        ]),
      });
    }
    return Object.freeze({
      state: "applied",
      text:
        "<b>✅ Professional Bonus активирован</b>\n\n" +
        `Доступ действует до <b>${formatReferralRewardTime(endsAt)}</b>.\n\n` +
        "Бонус не списывает Stars и не продлевается автоматически.",
      keyboard: baseKeyboard([
        [{ text: "💎 Мой тариф", callback_data: "stars_my_plan" }],
      ]),
    });
  }

  if (state === "expired") {
    const wasActivated = Boolean(startsAt && endsAt);
    return Object.freeze({
      state,
      text: wasActivated
        ? "<b>✅ Бонусные дни завершились</b>\n\nТри дополнительных дня использованы полностью. История награды сохранена."
        : "<b>⌛ Окно активации завершилось</b>\n\nТридцатидневный срок для запуска трёх бонусных дней истёк. Оплаченный доступ и Stars не изменялись.",
      keyboard: baseKeyboard(),
    });
  }

  if (state === "cancelled" || state === "revoked") {
    return Object.freeze({
      state: "cancelled",
      text:
        "<b>Награда не выдана</b>\n\n" +
        "После обязательной проверки условия программы не подтвердились. Это сообщение не раскрывает данные приглашённого или платёжной операции. Ваш обычный оплаченный доступ не затронут.",
      keyboard: baseKeyboard([
        [{ text: "🛟 Поддержка", callback_data: "support" }],
      ]),
    });
  }

  if (state === "manual_review") {
    if (status?.packageReferralBonus === true) {
      return Object.freeze({state, text:
        "<b>⚠️ Нужна ручная проверка</b>\n\n" +
        "Источник бонуса требует проверки. Бонусный доступ приостановлен; оплаченный доступ сохранён.\n\n" +
        "Повторная оплата не нужна. Обратитесь в поддержку.",
        keyboard: baseKeyboard([[{text: "🛟 Поддержка", callback_data: "support"}]]),
      });
    }
    const activeUntil = endsAt > timestamp
      ? ` Уже начавшийся бонус продолжает действовать до <b>${formatReferralRewardTime(endsAt)}</b>.`
      : "";
    return Object.freeze({
      state,
      text:
        "<b>⚠️ Нужна ручная проверка</b>\n\n" +
        "Автоматическая проверка награды не завершилась безопасно. Не повторяйте оплату и не передавайте платёжные идентификаторы в чат." +
        activeUntil,
      keyboard: baseKeyboard([
        [{ text: "🛟 Поддержка", callback_data: "support" }],
      ]),
    });
  }

  if (state === "disabled") {
    return unavailableScreen(
      "Активация временно выключена. Никаких изменений доступа не произошло.",
    );
  }

  return unavailableScreen();
}

export async function getReferralRewardUserScreen(
  env,
  { telegramId, at = nowSeconds() } = {},
) {
  const userId = validateTelegramId(telegramId);
  const timestamp = validateClock(at);
  const database = requireDatabase(env);
  const [status, canonicalAccess] = await Promise.all([
    readOwnRewardStatus(env, { telegramId: userId, at: timestamp }),
    loadCanonicalAccess(database, userId),
  ]);
  return buildReferralRewardUserScreen({
    status,
    canonicalAccess,
    config: readReferralRewardConfig(env),
    at: timestamp,
  });
}

export async function getReferralRewardMenuButton(
  env,
  { telegramId, at = nowSeconds() } = {},
) {
  const userId = validateTelegramId(telegramId);
  const status = await readOwnRewardStatus(env, {
    telegramId: userId,
    at: validateClock(at),
  });
  if (status.status === "none") return null;
  const marker = {
    pending: "⏳",
    confirmed: "✅",
    claimable: "🎁",
    applied: "✅",
    manual_review: "⚠️",
    cancelled: "",
    revoked: "",
    expired: "⌛",
  }[status.status] || "🎁";
  return Object.freeze({
    text: `${marker ? `${marker} ` : ""}Моя награда · +3 дня`,
    callback_data: REFERRAL_REWARD_CALLBACKS.status,
  });
}

async function findUserGrant(database, telegramId) {
  return database.prepare(
    `SELECT bonus_grant_id
     FROM bonus_access_grants
     WHERE beneficiary_telegram_id = ? AND program_code = ?
     ORDER BY created_at DESC, bonus_grant_id
     LIMIT 1`,
  ).bind(telegramId, REFERRAL_REWARD_PROGRAM_CODE).first();
}

async function findAppliedNoticeKey(database, bonusGrantId) {
  return database.prepare(
    `SELECT notice_key
     FROM referral_reward_notice_jobs
     WHERE bonus_grant_id = ? AND notice_type = 'bonus_applied'
       AND delivery_state IN ('pending', 'retry')
     LIMIT 1`,
  ).bind(bonusGrantId).first();
}

export async function claimReferralRewardForUser(
  env,
  { telegramId, at = nowSeconds() } = {},
) {
  const userId = validateTelegramId(telegramId);
  const timestamp = validateClock(at);
  const database = requireDatabase(env);
  const legacyGrant = await findUserGrant(database, userId);
  const additive = legacyGrant ? null : await readPackageReferralBonusClaimDatabaseSource({db:database,env,telegramId:userId,nowSec:timestamp});
  const grant = legacyGrant ?? additive?.grant;
  if (!grant?.bonus_grant_id) {
    return getReferralRewardUserScreen(env, { telegramId: userId, at: timestamp });
  }

  let claim;
  try {
    claim = additive?.grant ? await (isLegacyCompatibilityEnv(env) ? executeOwnPackageReferralBonusClaim : claimPackageReferralBonusGrant)(env, {
      telegramId:userId,bonusGrantId:grant.bonus_grant_id,claimedAt:timestamp,
    }) : await claimReferralBonusAccess(env, {
      telegramId: userId,
      bonusGrantId: grant.bonus_grant_id,
      claimedAt: timestamp,
    });
  } catch (error) {
    return Object.freeze({
      ...unavailableScreen(
        "Не удалось безопасно завершить активацию. Доступ не будет выдан повторно; попробуйте обновить статус или обратитесь в поддержку.",
      ),
      operation: "failed",
      reason: safeReferralUxErrorCode(error),
    });
  }

  const screen = await getReferralRewardUserScreen(env, {
    telegramId: userId,
    at: timestamp,
  });
  if (!additive?.grant && ["applied", "duplicate"].includes(claim.status)) {
    try {
      const notice = await findAppliedNoticeKey(database, grant.bonus_grant_id);
      if (notice?.notice_key) {
        await processNoticeKey(
          env,
          notice.notice_key,
          timestamp,
          async () => ({ status: "suppressed", reason: "interactive_delivery" }),
        );
      }
    } catch {
      // Access is already authoritative. Cron can safely retry only the notice.
    }
  }
  return Object.freeze({ ...screen, operation: claim.status });
}

function noticeEventType(noticeType) {
  return `notify_referral_${noticeType}`;
}

function noticePresentation(evidence, at) {
  const status = {
    status: evidence.grant_status || evidence.reward_status || "none",
    rewardStatus: evidence.reward_status,
    bonusGrantId: evidence.bonus_grant_id,
    deliveryMode: evidence.delivery_mode,
    planCode: evidence.plan_code,
    confirmAfter: Number(evidence.confirm_after || 0) || null,
    confirmedAt: Number(evidence.confirmed_at || 0) || null,
    claimExpiresAt: Number(evidence.claim_expires_at || 0) || null,
    startsAt: Number(evidence.starts_at || 0) || null,
    endsAt: Number(evidence.ends_at || 0) || null,
  };
  const type = evidence.notice_type;
  if (type === "pending_review") status.status = "pending";
  if (type === "reward_confirmed") status.status = "confirmed";
  if (type === "bonus_claimable") status.status = "claimable";
  if (type === "bonus_applied") status.status = "applied";
  if (["claim_window_expired", "bonus_access_ended"].includes(type)) {
    status.status = "expired";
  }
  if (type === "reward_cancelled") status.status = "cancelled";
  if (type === "bonus_manual_review") status.status = "manual_review";
  const screen = buildReferralRewardUserScreen({
    status,
    canonicalAccess: { access_state: evidence.current_access_state },
    config: { bonusGrantsEnabled: true },
    at,
  });
  const firstButton = screen.keyboard
    .flat()
    .find((button) => button.callback_data !== "menu");
  return Object.freeze({
    recipientId: Number(evidence.recipient_telegram_id),
    eventType: noticeEventType(type),
    text: screen.text,
    keyboard: firstButton ? [[firstButton]] : undefined,
  });
}

function noticeIsCurrent(evidence, at) {
  const type = evidence.notice_type;
  if (type === "pending_review") return evidence.reward_status === "pending";
  if (type === "reward_confirmed") {
    return evidence.reward_status === "confirmed" && !evidence.bonus_grant_id;
  }
  if (type === "reward_cancelled") return evidence.reward_status === "cancelled";
  if (type === "bonus_claimable") {
    return evidence.grant_status === "claimable" &&
      Number(evidence.claim_expires_at) >= at;
  }
  if (type === "bonus_applied") {
    return evidence.grant_status === "applied" &&
      !evidence.expiry_event_id && Number(evidence.ends_at) > at;
  }
  if (type === "claim_window_expired") {
    return evidence.grant_status === "expired" && !evidence.starts_at;
  }
  if (type === "bonus_access_ended") {
    return Boolean(evidence.expiry_event_id);
  }
  if (type === "bonus_manual_review") {
    return evidence.grant_status === "manual_review" &&
      !evidence.expiry_event_id;
  }
  return false;
}

async function loadNoticeEvidence(database, noticeKey) {
  return database.prepare(
    `SELECT notice.notice_key, notice.recipient_telegram_id,
            notice.notice_type, notice.delivery_state,
            notice.attempt_count, notice.lease_token,
            notice.inbox_recorded_at,
            reward.reward_status, reward.confirm_after, reward.confirmed_at,
            reward.cancelled_at,
            grant_record.bonus_grant_id, grant_record.delivery_mode,
            grant_record.plan_code, grant_record.grant_status,
            grant_record.claim_expires_at, grant_record.starts_at,
            grant_record.ends_at,
            expiry.expiry_event_id,
            access_state.access_state AS current_access_state
     FROM referral_reward_notice_jobs notice
     JOIN referral_rewards reward ON reward.reward_id = notice.reward_id
     LEFT JOIN bonus_access_grants grant_record
       ON grant_record.bonus_grant_id = COALESCE(
         notice.bonus_grant_id,
         (SELECT current_grant.bonus_grant_id
          FROM bonus_access_grants current_grant
          WHERE current_grant.reward_id = notice.reward_id
          LIMIT 1)
       )
     LEFT JOIN bonus_access_expiry_events expiry
       ON expiry.bonus_grant_id = grant_record.bonus_grant_id
     LEFT JOIN user_access_states access_state
       ON access_state.telegram_id = notice.recipient_telegram_id
     WHERE notice.notice_key = ?
     LIMIT 1`,
  ).bind(noticeKey).first();
}

async function recoverExpiredNoticeLeases(database, at) {
  // A lost lease may have followed a successful Telegram send whose final D1
  // acknowledgement was lost. Never auto-replay that ambiguous side effect.
  await database.prepare(
    `UPDATE referral_reward_notice_jobs
     SET delivery_state = 'manual_review', lease_token = NULL,
         lease_expires_at = NULL,
         last_error_code = 'delivery_lease_outcome_unknown', updated_at = ?
     WHERE delivery_state = 'processing' AND lease_expires_at < ?`,
  ).bind(at, at).run();
}

async function claimNoticeJob(database, noticeKey, at) {
  const leaseToken = crypto.randomUUID();
  const row = await database.prepare(
    `UPDATE referral_reward_notice_jobs
     SET delivery_state = 'processing', attempt_count = attempt_count + 1,
         lease_token = ?, lease_expires_at = ?, last_attempt_at = ?,
         updated_at = ?
     WHERE notice_key = ?
       AND delivery_state IN ('pending', 'retry')
       AND not_before <= ? AND next_attempt_at <= ?
       AND attempt_count < ?
     RETURNING notice_key, lease_token, attempt_count`,
  ).bind(
    leaseToken,
    at + NOTICE_LEASE_SECONDS,
    at,
    at,
    noticeKey,
    at,
    at,
    NOTICE_MAX_ATTEMPTS,
  ).first();
  return row || null;
}

async function recordNoticeInInbox(database, evidence, presentation, at) {
  if (evidence.inbox_recorded_at) return;
  const action = presentation.keyboard?.flat()?.[0] || {};
  await database.batch([
    database.prepare(
      `INSERT INTO notifications (
         recipient_id, event_type, message_html,
         action_label, action_callback
       )
       SELECT ?, ?, ?, ?, ?
       FROM referral_reward_notice_jobs
       WHERE notice_key = ? AND lease_token = ?
         AND delivery_state = 'processing' AND inbox_recorded_at IS NULL`,
    ).bind(
      presentation.recipientId,
      presentation.eventType,
      presentation.text,
      String(action.text || ""),
      String(action.callback_data || ""),
      evidence.notice_key,
      evidence.lease_token,
    ),
    database.prepare(
      `UPDATE referral_reward_notice_jobs
       SET inbox_recorded_at = ?, updated_at = ?
       WHERE notice_key = ? AND lease_token = ?
         AND delivery_state = 'processing' AND inbox_recorded_at IS NULL`,
    ).bind(at, at, evidence.notice_key, evidence.lease_token),
  ]);
}

function deliveryBackoffSeconds(attempt) {
  return Math.min(3_600, 30 * (2 ** Math.max(0, Number(attempt) - 1)));
}

async function finishNoticeJob(
  database,
  evidence,
  outcome,
  at,
) {
  const normalized = ["delivered", "suppressed", "retry", "manual_review"]
    .includes(outcome?.status)
    ? outcome.status
    : "retry";
  const attempts = Number(evidence.attempt_count || 1);
  const state = normalized === "retry" && attempts >= NOTICE_MAX_ATTEMPTS
    ? "manual_review"
    : normalized;
  const fallbackReason = state === "delivered"
    ? ""
    : state === "suppressed"
      ? "delivery_suppressed"
      : state === "manual_review"
        ? "delivery_requires_review"
        : "delivery_retry";
  const reason = state === "delivered"
    ? ""
    : safeReferralUxErrorCode({ code: outcome?.reason }, fallbackReason);
  const deliveredAt = ["delivered", "suppressed"].includes(state) ? at : null;
  const nextAttemptAt = state === "retry"
    ? at + deliveryBackoffSeconds(attempts)
    : at;
  const result = await database.prepare(
    `UPDATE referral_reward_notice_jobs
     SET delivery_state = ?, lease_token = NULL, lease_expires_at = NULL,
         next_attempt_at = ?, delivered_at = ?, last_error_code = ?,
         updated_at = ?
     WHERE notice_key = ? AND delivery_state = 'processing'
       AND lease_token = ?`,
  ).bind(
    state,
    nextAttemptAt,
    deliveredAt,
    reason,
    at,
    evidence.notice_key,
    evidence.lease_token,
  ).run();
  return changed(result) ? state : "lost_lease";
}

async function processNoticeKey(env, noticeKey, at, deliverNotice) {
  const database = requireDatabase(env);
  const claimed = await claimNoticeJob(database, noticeKey, at);
  if (!claimed) return Object.freeze({ status: "not_claimed" });
  let evidence = await loadNoticeEvidence(database, noticeKey);
  if (!evidence || evidence.lease_token !== claimed.lease_token) {
    return Object.freeze({ status: "lost_lease" });
  }
  if (!noticeIsCurrent(evidence, at)) {
    const status = await finishNoticeJob(
      database,
      evidence,
      { status: "suppressed", reason: "notice_superseded" },
      at,
    );
    return Object.freeze({ status });
  }

  const presentation = noticePresentation(evidence, at);
  let outcome = null;
  try {
    await recordNoticeInInbox(database, evidence, presentation, at);
    evidence = await loadNoticeEvidence(database, noticeKey);
    if (typeof deliverNotice !== "function") {
      outcome = { status: "retry", reason: "delivery_callback_missing" };
    } else {
      outcome = await deliverNotice(presentation);
    }
  } catch (error) {
    evidence = await loadNoticeEvidence(database, noticeKey);
    const status = await finishNoticeJob(
      database,
      evidence,
      {
        status: error?.ambiguous ? "manual_review" : "retry",
        reason: safeReferralUxErrorCode(error, "notice_delivery_failed"),
      },
      at,
    );
    return Object.freeze({ status });
  }
  // If this acknowledgement fails, leave the lease in processing. Lease
  // recovery routes it to manual review instead of possibly sending twice.
  const status = await finishNoticeJob(database, evidence, outcome || {}, at);
  return Object.freeze({ status });
}

export async function deliverReferralRewardNotices(
  env,
  {
    limit = DEFAULT_BATCH_LIMIT,
    at = nowSeconds(),
    deliverNotice,
  } = {},
) {
  const pageSize = validateLimit(limit);
  const timestamp = validateClock(at);
  const database = requireDatabase(env);
  await recoverExpiredNoticeLeases(database, timestamp);
  const rows = await database.prepare(
    `SELECT notice_key
     FROM referral_reward_notice_jobs
     WHERE delivery_state IN ('pending', 'retry')
       AND not_before <= ? AND next_attempt_at <= ?
       AND attempt_count < ?
     ORDER BY next_attempt_at, not_before, notice_key
     LIMIT ?`,
  ).bind(timestamp, timestamp, NOTICE_MAX_ATTEMPTS, pageSize).all();
  const counts = {
    delivered: 0,
    suppressed: 0,
    retry: 0,
    manualReview: 0,
    other: 0,
  };
  for (const row of rows?.results || []) {
    const result = await processNoticeKey(
      env,
      row.notice_key,
      timestamp,
      deliverNotice,
    );
    if (result.status === "delivered") counts.delivered += 1;
    else if (result.status === "suppressed") counts.suppressed += 1;
    else if (result.status === "retry") counts.retry += 1;
    else if (result.status === "manual_review") counts.manualReview += 1;
    else counts.other += 1;
  }
  return Object.freeze({
    status: "completed",
    attempted: (rows?.results || []).length,
    ...counts,
  });
}

async function safeMaintenanceStep(name, operation) {
  try {
    return Object.freeze({ name, ok: true, result: await operation() });
  } catch (error) {
    return Object.freeze({
      name,
      ok: false,
      reason: safeReferralUxErrorCode(error, `${name}_failed`),
    });
  }
}

export async function runReferralRewardMaintenance(
  env,
  {
    limit = DEFAULT_BATCH_LIMIT,
    at = nowSeconds(),
    deliverNotice,
  } = {},
) {
  const pageSize = validateLimit(limit);
  const timestamp = validateClock(at);
  requireDatabase(env);
  const protection = await safeMaintenanceStep("protection_repair", () =>
    repairReferralProtectionWorkflows(env, {
      limit: pageSize,
      requestedAt: timestamp,
    }));
  const grants = await safeMaintenanceStep("bonus_repair", () =>
    repairReferralBonusGrants(env, {
      limit: pageSize,
      deliveredAt: timestamp,
    }));
  const access = await safeMaintenanceStep("bonus_maintenance", () =>
    runReferralBonusMaintenance(env, {
      limit: pageSize,
      recordedAt: timestamp,
    }));
  const notices = await safeMaintenanceStep("notice_delivery", () =>
    deliverReferralRewardNotices(env, {
      limit: pageSize,
      at: timestamp,
      deliverNotice,
    }));
  // Additive repair runs in the existing background maintenance service. The
  // legacy admin SQL facade keeps its original narrower write capability.
  const packageRepair=isLegacyCompatibilityEnv(env) ? Object.freeze({name:'package_background_repair',ok:true,
    result:{status:'background_service_required'}}) : await safeMaintenanceStep('package_background_repair',async()=>({
      protection:await repairPackageReferralRewardProtection(env,{limit:pageSize,requestedAt:timestamp}),
      grants:await repairPackageReferralBonusGrants(env,{limit:pageSize,deliveredAt:timestamp}),
      access:await runPackageReferralBonusMaintenance(env,{limit:pageSize,recordedAt:timestamp}),
    }));
  return Object.freeze({
    status: [protection, grants, access, notices,packageRepair].every((step) => step.ok)
      ? "completed"
      : "partial",
    protection,
    grants,
    access,
    notices,
    packageRepair,
  });
}

async function readAdminCounts(database, at) {
  return database.prepare(
    `SELECT
       (SELECT COUNT(*) FROM referral_rewards) AS rewards_total,
       (SELECT COUNT(*) FROM referral_rewards
          WHERE reward_status = 'pending') AS rewards_pending,
       (SELECT COUNT(*) FROM referral_rewards
          WHERE reward_status = 'confirmed') AS rewards_confirmed,
       (SELECT COUNT(*) FROM referral_rewards
          WHERE reward_status = 'cancelled') AS rewards_cancelled,
       (SELECT COUNT(*) FROM referral_rewards
          WHERE reward_status = 'pending' AND confirm_after <= ?) AS rewards_due,
       (SELECT COUNT(*) FROM referral_rewards reward
          LEFT JOIN referral_reward_protection_jobs job
            ON job.reward_id = reward.reward_id
          WHERE reward.reward_status = 'pending'
            AND job.reward_id IS NULL) AS protection_missing,
       (SELECT COUNT(*) FROM referral_reward_protection_jobs
          WHERE workflow_state = 'start_failed') AS protection_failed,
       (SELECT COUNT(*) FROM referral_reward_protection_jobs
          WHERE workflow_state = 'manual_review') AS protection_review,
       (SELECT COUNT(*) FROM referral_rewards reward
          LEFT JOIN bonus_access_grants grant_record
            ON grant_record.reward_id = reward.reward_id
          WHERE reward.reward_status = 'confirmed'
            AND grant_record.bonus_grant_id IS NULL) AS grants_missing,
       (SELECT COUNT(*) FROM bonus_access_grants
          WHERE grant_status = 'claimable') AS grants_claimable,
       (SELECT COUNT(*) FROM bonus_access_grants
          WHERE grant_status = 'applied'
            AND NOT EXISTS (
              SELECT 1 FROM bonus_access_expiry_events expiry
              WHERE expiry.bonus_grant_id = bonus_access_grants.bonus_grant_id
            )) AS grants_applied,
       (SELECT COUNT(*) FROM bonus_access_grants
          WHERE grant_status = 'expired'
            OR EXISTS (
              SELECT 1 FROM bonus_access_expiry_events expiry
              WHERE expiry.bonus_grant_id = bonus_access_grants.bonus_grant_id
            )) AS grants_expired,
       (SELECT COUNT(*) FROM bonus_access_grants
          WHERE grant_status = 'revoked') AS grants_revoked,
       (SELECT COUNT(*) FROM bonus_access_grants
          WHERE grant_status = 'manual_review') AS grants_review,
       (SELECT COUNT(*) FROM bonus_access_grants
          WHERE grant_status = 'claimable' AND claim_expires_at < ?)
          AS claims_overdue,
       (SELECT COUNT(*)
          FROM bonus_access_grants grant_record
          JOIN bonus_access_effects effect
            ON effect.bonus_grant_id = grant_record.bonus_grant_id
          LEFT JOIN bonus_access_expiry_events expiry
            ON expiry.bonus_grant_id = grant_record.bonus_grant_id
          WHERE grant_record.delivery_mode = 'manual_claim'
            AND grant_record.grant_status IN ('applied', 'manual_review')
            AND effect.effect_ends_at <= ?
            AND expiry.bonus_grant_id IS NULL) AS access_overdue,
       (SELECT COUNT(*) FROM referral_reward_notice_jobs
          WHERE delivery_state = 'pending') AS notices_pending,
       (SELECT COUNT(*) FROM referral_reward_notice_jobs
          WHERE delivery_state = 'retry') AS notices_retry,
       (SELECT COUNT(*) FROM referral_reward_notice_jobs
          WHERE delivery_state = 'manual_review') AS notices_review,
       (SELECT COUNT(*) FROM referral_reward_notice_jobs
          WHERE delivery_state = 'processing' AND lease_expires_at < ?)
          AS notices_stale
     LIMIT 1`,
  ).bind(at, at, at, at).first();
}

function numberCounts(row) {
  return Object.freeze(Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => [key, Number(value || 0)]),
  ));
}

export async function getReferralRewardAdminDiagnostics(
  env,
  { at = nowSeconds() } = {},
) {
  const timestamp = validateClock(at);
  const config = readReferralRewardConfig(env);
  try {
    const counts = numberCounts(await readAdminCounts(requireDatabase(env), timestamp));
    const attention =
      counts.rewards_due + counts.protection_missing +
      counts.protection_failed + counts.protection_review +
      counts.grants_missing + counts.grants_review +
      counts.claims_overdue + counts.access_overdue +
      counts.notices_retry + counts.notices_review + counts.notices_stale;
    return Object.freeze({
      ready: true,
      status: attention ? "attention" : "healthy",
      attention,
      config,
      counts,
    });
  } catch (error) {
    return Object.freeze({
      ready: false,
      status: "not_ready",
      attention: 1,
      config,
      counts: Object.freeze({}),
      reason: safeReferralUxErrorCode(error, "referral_diagnostics_unavailable"),
    });
  }
}

function enabledLabel(value) {
  return value ? "✅" : "⚪";
}

export function buildReferralRewardAdminScreen(diagnostics) {
  if (!diagnostics?.ready) {
    return Object.freeze({
      state: "not_ready",
      text:
        "<b>🎁 Реферальная награда · диагностика</b>\n\n" +
        "❌ Схема или runtime пока не готовы. Функция считается выключенной; пользовательский доступ не изменён.",
      keyboard: [
        [{ text: "🔄 Обновить", callback_data: REFERRAL_REWARD_CALLBACKS.admin }],
        [{ text: "⬅️ В админ-панель", callback_data: "admin_dashboard" }],
      ],
    });
  }
  const c = diagnostics.counts;
  const config = diagnostics.config;
  const text = [
    "<b>🎁 Реферальная награда · v1.3.7</b>",
    "",
    "<b>Контуры</b>",
    `${enabledLabel(config.masterEnabled)} master · ${enabledLabel(config.candidateWritesEnabled)} candidates · ${enabledLabel(config.confirmationsEnabled)} protection · ${enabledLabel(config.bonusGrantsEnabled)} bonus`,
    `Rollout: <b>${config.rolloutMode}</b>`,
    "",
    "<b>Награды</b>",
    `Всего: <b>${c.rewards_total}</b> · проверка: <b>${c.rewards_pending}</b> · подтверждено: <b>${c.rewards_confirmed}</b> · отменено: <b>${c.rewards_cancelled}</b>`,
    `Просрочено к решению: <b>${c.rewards_due}</b> · без Workflow: <b>${c.protection_missing}</b>`,
    `Workflow failed / review: <b>${c.protection_failed}</b> / <b>${c.protection_review}</b>`,
    "",
    "<b>Bonus Access</b>",
    `Ожидают активации: <b>${c.grants_claimable}</b> · применено: <b>${c.grants_applied}</b> · завершено: <b>${c.grants_expired}</b> · отозвано: <b>${c.grants_revoked}</b>`,
    `Без grant / review: <b>${c.grants_missing}</b> / <b>${c.grants_review}</b>`,
    `Просроченные claim / access: <b>${c.claims_overdue}</b> / <b>${c.access_overdue}</b>`,
    "",
    "<b>Уведомления</b>",
    `Ожидают / retry / review / stale lease: <b>${c.notices_pending}</b> / <b>${c.notices_retry}</b> / <b>${c.notices_review}</b> / <b>${c.notices_stale}</b>`,
    "",
    diagnostics.attention
      ? `⚠️ Требует внимания: <b>${diagnostics.attention}</b>`
      : "✅ Несогласованных состояний не найдено.",
    "В сообщении нет Telegram ID, order ID или платёжных идентификаторов.",
  ].join("\n");
  return Object.freeze({
    state: diagnostics.status,
    text,
    keyboard: [
      [{
        text: "🧰 Безопасное восстановление",
        callback_data: REFERRAL_REWARD_CALLBACKS.adminRepairAsk,
      }],
      [{ text: "🔄 Обновить", callback_data: REFERRAL_REWARD_CALLBACKS.admin }],
      [{ text: "⬅️ В админ-панель", callback_data: "admin_dashboard" }],
    ],
  });
}

export async function getReferralRewardAdminScreen(env, options = {}) {
  return buildReferralRewardAdminScreen(
    await getReferralRewardAdminDiagnostics(env, options),
  );
}

export function getReferralRewardAdminRepairConfirmation() {
  return Object.freeze({
    state: "confirmation",
    text:
      "<b>🧰 Безопасное восстановление</b>\n\n" +
      "Будут повторно подняты только отсутствующие или явно retryable Workflow/grant, закрыты просроченные окна и отправлены ожидающие уведомления. Подтверждённые решения, платежи и уже выданный доступ не переписываются.\n\nЗапустить один ограниченный проход?",
    keyboard: [
      [{
        text: "✅ Запустить восстановление",
        callback_data: REFERRAL_REWARD_CALLBACKS.adminRepair,
      }],
      [{ text: "Отмена", callback_data: REFERRAL_REWARD_CALLBACKS.admin }],
    ],
  });
}

function attempted(step) {
  return Number(step?.result?.attempted || 0);
}

export async function runReferralRewardAdminRepair(
  env,
  {
    limit = DEFAULT_BATCH_LIMIT,
    at = nowSeconds(),
    deliverNotice,
  } = {},
) {
  const result = await runReferralRewardMaintenance(env, {
    limit,
    at,
    deliverNotice,
  });
  const noticeResult = result.notices?.result || {};
  const failedSteps = [result.protection, result.grants, result.access, result.notices]
    .filter((step) => !step.ok).length;
  return Object.freeze({
    ...result,
    screen: Object.freeze({
      state: result.status,
      text:
        `<b>${result.status === "completed" ? "✅" : "⚠️"} Восстановление завершено</b>\n\n` +
        `Workflow: <b>${attempted(result.protection)}</b>\n` +
        `Bonus grants: <b>${attempted(result.grants)}</b>\n` +
        `Завершённые claim/access: <b>${attempted(result.access)}</b>\n` +
        `Уведомления: <b>${Number(noticeResult.attempted || 0)}</b> · доставлено: <b>${Number(noticeResult.delivered || 0)}</b> · отложено: <b>${Number(noticeResult.retry || 0)}</b>\n` +
        `Шагов с ошибкой: <b>${failedSteps}</b>\n\n` +
        "Платежи и подтверждённая история не переписывались.",
      keyboard: [
        [{ text: "🎁 Открыть диагностику", callback_data: REFERRAL_REWARD_CALLBACKS.admin }],
        [{ text: "⬅️ В админ-панель", callback_data: "admin_dashboard" }],
      ],
    }),
  });
}

export function referralRuntimeAvailable(runtime) {
  return Boolean(
    runtime?.getUserScreen &&
    runtime?.claimUserBonus &&
    runtime?.getAdminScreen &&
    runtime?.runMaintenance,
  );
}

export function isTerminalReferralNoticeState(value) {
  return TERMINAL_NOTICE_STATES.has(String(value || ""));
}
