import {
  AI_PARTNER_MODEL_ALIASES,
  readAiPartnerConfig,
} from "./ai-partner-foundation.mjs";
import {
  AI_GATEWAY_HARD_LIMITS,
  AI_GATEWAY_PROVIDER_CONSENT_VERSION,
  createVerifiedAdminGatewayContext,
  runAiPartnerGateway,
} from "./ai-partner-gateway.mjs";
import {
  AI_PARTNER_DEEPSEEK_FLASH_PRICING,
  createAiPartnerProviderTransports,
} from "./ai-partner-provider-transports.mjs";

export const ADMIN_SAFETY_RUNTIME_KEY =
  "__RE_PROGRAM_ADMIN_SAFETY_RUNTIME__";
export const ADMIN_SAFETY_HOTFIX_VERSION = "1.3.8-hotfix.1";

export const ADMIN_SAFETY_LIMITS = Object.freeze({
  moderationSessionSeconds: 15 * 60,
  blockedNoticeSeconds: 24 * 60 * 60,
  blockListSize: 12,
  reasonCharacters: 300,
  chatMessageCharacters: 2_500,
  chatAnswerCharacters: 3_300,
  chatHistoryExchanges: 5,
  chatDailySuccesses: 30,
  chatCycleSuccesses: 300,
  chatCycleCostMicrousd: 1_000_000,
  chatMaxOutputTokens: 700,
});

const TELEGRAM_TIMEOUT_MS = 10_000;
const PRIVATE_LEGAL_COMMAND =
  /^\/(?:support|paysupport|terms|privacy|data|delete_me|myid)(?:@RE_Program_Bot)?$/i;
const ADMIN_BLOCK_COMMAND = /^\/admin_blocks?(?:@RE_Program_Bot)?$/i;
const HOTFIX_CALLBACK = /^h138:/;
const SAFE_ERROR_CODE = /^[a-z0-9_.-]{3,80}$/;
const TEXT_ENCODER = new TextEncoder();

function flag(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function positiveTelegramId(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function statementChanged(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0) > 0;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function safeErrorCode(value, fallback = "admin_ai_chat_failed") {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 80);
  return SAFE_ERROR_CODE.test(normalized) ? normalized : fallback;
}

function isAdmin(env, telegramId) {
  const admin = positiveTelegramId(env?.ADMIN_ID);
  return Boolean(admin && admin === positiveTelegramId(telegramId));
}

function privateUpdateActor(update) {
  const message = update?.message;
  const callback = update?.callback_query;
  const checkout = update?.pre_checkout_query;
  const messageActor = positiveTelegramId(message?.from?.id);
  const messageChat = positiveTelegramId(message?.chat?.id);
  if (
    messageActor && messageChat && messageActor === messageChat &&
    message?.chat?.type === "private" && !message?.from?.is_bot
  ) {
    return Object.freeze({
      telegramId: messageActor,
      chatId: messageChat,
      message,
      callback: null,
      checkout: null,
    });
  }
  const callbackActor = positiveTelegramId(callback?.from?.id);
  const callbackChat = positiveTelegramId(callback?.message?.chat?.id);
  if (
    callbackActor && callbackChat && callbackActor === callbackChat &&
    callback?.message?.chat?.type === "private" &&
    !callback?.from?.is_bot && typeof callback?.id === "string"
  ) {
    return Object.freeze({
      telegramId: callbackActor,
      chatId: callbackChat,
      message: null,
      callback,
      checkout: null,
    });
  }
  const checkoutActor = positiveTelegramId(checkout?.from?.id);
  if (checkoutActor && typeof checkout?.id === "string") {
    return Object.freeze({
      telegramId: checkoutActor,
      chatId: null,
      message: null,
      callback: null,
      checkout,
    });
  }
  return null;
}

async function defaultTelegramCall(env, method, payload) {
  if (!env?.BOT_TOKEN) throw new Error("BOT_TOKEN is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
    const result = await response.json();
    if (!response.ok || result?.ok !== true) {
      throw new Error(`Telegram API ${method} rejected the request`);
    }
    return result.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendHtml(callTelegram, env, chatId, text, keyboard = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
  if (Array.isArray(keyboard)) {
    payload.reply_markup = { inline_keyboard: keyboard };
  }
  return callTelegram(env, "sendMessage", payload);
}

async function safelyAnswerCallback(callTelegram, env, callbackId) {
  if (!callbackId) return;
  try {
    await callTelegram(env, "answerCallbackQuery", {
      callback_query_id: callbackId,
    });
  } catch {
    // Callback acknowledgement cannot widen an authorization boundary.
  }
}

async function safelyTyping(callTelegram, env, chatId) {
  try {
    await callTelegram(env, "sendChatAction", {
      chat_id: chatId,
      action: "typing",
    });
  } catch {
    // Typing is cosmetic and must not affect the provider request.
  }
}

async function safeTechnicalLog(env, context, error) {
  try {
    await env.DB.prepare(
      `INSERT INTO bot_error_log (context, message) VALUES (?, ?)`,
    ).bind(
      String(context || "admin_hotfix").slice(0, 80),
      safeErrorCode(error?.code || error?.message || error),
    ).run();
  } catch {
    // Logging failure must not disclose request text or secrets.
  }
}

async function readRuntimeSettings(env) {
  const row = await env.DB.prepare(
    `SELECT moderation_enabled, admin_ai_chat_enabled, deepseek_chat_enabled
     FROM admin_safety_runtime_settings WHERE id = 1 LIMIT 1`,
  ).first();
  if (!row) throw new Error("admin_safety_schema_not_ready");
  return Object.freeze({
    moderationEnabled:
      flag(env?.ADMIN_MODERATION_ENABLED) &&
      Number(row.moderation_enabled) === 1,
    adminAiChatEnabled:
      flag(env?.ADMIN_AI_CHAT_ENABLED) &&
      Number(row.admin_ai_chat_enabled) === 1,
    deepseekChatEnabled:
      flag(env?.ADMIN_DEEPSEEK_CHAT_ENABLED) &&
      Number(row.deepseek_chat_enabled) === 1,
  });
}

async function activeModerationBlock(env, telegramId) {
  return env.DB.prepare(
    `SELECT target_telegram_id, status, reason, blocked_by, blocked_at,
            last_notice_at, revision
     FROM user_moderation_blocks
     WHERE target_telegram_id = ? AND status = 'active'
     LIMIT 1`,
  ).bind(telegramId).first();
}

async function recordAdminAudit(
  env,
  actorId,
  action,
  entityType,
  entityId,
  details,
) {
  await env.DB.prepare(
    `INSERT INTO admin_audit_log
       (actor_id, action, entity_type, entity_id, details)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    actorId,
    String(action).slice(0, 64),
    String(entityType).slice(0, 32),
    String(entityId).slice(0, 80),
    String(details).slice(0, 300),
  ).run();
}

async function maybeSendBlockedNotice(
  env,
  actor,
  block,
  callTelegram,
  at,
) {
  if (!actor.chatId) return;
  const claimed = await env.DB.prepare(
    `UPDATE user_moderation_blocks
     SET last_notice_at = ?
     WHERE target_telegram_id = ? AND status = 'active'
       AND revision = ?
       AND (last_notice_at IS NULL OR last_notice_at <= ?)
     RETURNING target_telegram_id`,
  ).bind(
    at,
    actor.telegramId,
    Number(block.revision),
    at - ADMIN_SAFETY_LIMITS.blockedNoticeSeconds,
  ).first();
  if (!claimed) return;
  try {
    await sendHtml(
      callTelegram,
      env,
      actor.chatId,
      "<b>Доступ к RE Program ограничен</b>\n\n" +
        "Основные функции бота для этого аккаунта отключены. Данные, история платежей и реферальные записи не удалены. Если это ошибка, обратитесь в официальный бот поддержки: @RE_Program_Support_Bot.",
      [[{
        text: "🛟 Открыть поддержку",
        url: "https://t.me/RE_Program_Support_Bot?start=moderation_appeal",
      }]],
    );
  } catch {
    // A blocked Telegram recipient may reject the notification itself.
  }
}

function isPaymentLedgerMessage(message) {
  return Boolean(message?.successful_payment || message?.refunded_payment);
}

async function handleBlockedActor(env, actor, block, callTelegram, at) {
  if (
    actor.message &&
    PRIVATE_LEGAL_COMMAND.test(String(actor.message.text || "").trim())
  ) {
    return Object.freeze({ handled: false, status: "blocked_legal_route" });
  }
  if (actor.message && isPaymentLedgerMessage(actor.message)) {
    return Object.freeze({ handled: false, status: "blocked_ledger_route" });
  }
  if (actor.checkout) {
    try {
      await callTelegram(env, "answerPreCheckoutQuery", {
        pre_checkout_query_id: actor.checkout.id,
        ok: false,
        error_message:
          "Доступ к боту ограничен. Stars не списаны. Обратитесь в поддержку.",
      });
    } catch {
      // Telegram will time out closed; no purchase is authorized by the bot.
    }
    return Object.freeze({ handled: true, status: "blocked_checkout_denied" });
  }
  if (actor.callback) {
    await safelyAnswerCallback(callTelegram, env, actor.callback.id);
  }
  await maybeSendBlockedNotice(env, actor, block, callTelegram, at);
  return Object.freeze({ handled: true, status: "moderation_blocked" });
}

async function clearModerationSession(env, adminId) {
  await env.DB.prepare(
    "DELETE FROM admin_moderation_sessions WHERE admin_telegram_id = ?",
  ).bind(adminId).run();
}

async function getModerationSession(env, adminId, at) {
  const row = await env.DB.prepare(
    `SELECT admin_telegram_id, step, target_telegram_id, reason, expires_at
     FROM admin_moderation_sessions
     WHERE admin_telegram_id = ? AND expires_at > ?
     LIMIT 1`,
  ).bind(adminId, at).first();
  if (!row) {
    await env.DB.prepare(
      `DELETE FROM admin_moderation_sessions
       WHERE admin_telegram_id = ? AND expires_at <= ?`,
    ).bind(adminId, at).run();
  }
  return row;
}

async function setModerationSession(env, adminId, {
  step,
  targetTelegramId = null,
  reason = "",
  at,
}) {
  await env.DB.prepare(
    `INSERT INTO admin_moderation_sessions (
       admin_telegram_id, step, target_telegram_id, reason,
       expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(admin_telegram_id) DO UPDATE SET
       step = excluded.step,
       target_telegram_id = excluded.target_telegram_id,
       reason = excluded.reason,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
  ).bind(
    adminId,
    step,
    targetTelegramId,
    reason,
    at + ADMIN_SAFETY_LIMITS.moderationSessionSeconds,
    at,
    at,
  ).run();
}

async function deactivateAdminAiChat(env, adminId, at) {
  await env.DB.prepare(
    `INSERT INTO admin_ai_chat_state (admin_telegram_id, active_model, updated_at)
     VALUES (?, 'off', ?)
     ON CONFLICT(admin_telegram_id) DO UPDATE SET
       active_model = 'off', updated_at = excluded.updated_at`,
  ).bind(adminId, at).run();
}

async function showModerationHome(env, chatId, callTelegram) {
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM user_moderation_blocks
     WHERE status = 'active'`,
  ).first();
  const rows = await env.DB.prepare(
    `SELECT target_telegram_id, reason, blocked_at, revision
     FROM user_moderation_blocks
     WHERE status = 'active'
     ORDER BY blocked_at DESC, target_telegram_id
     LIMIT ?`,
  ).bind(ADMIN_SAFETY_LIMITS.blockListSize).all();
  const active = rows?.results || [];
  const keyboard = active.map((row) => [{
    text: `🚫 ${Number(row.target_telegram_id)}`,
    callback_data:
      `h138:block:view:${Number(row.target_telegram_id)}`,
  }]);
  keyboard.push(
    [{ text: "➕ Заблокировать по Telegram ID", callback_data: "h138:block:new" }],
    [{ text: "⬅️ В админ-панель", callback_data: "admin_dashboard" }],
  );
  await sendHtml(
    callTelegram,
    env,
    chatId,
    "<b>🚫 Персональные блокировки</b>\n\n" +
      `Активных: <b>${Number(count?.total || 0)}</b>.\n\n` +
      "Блокировка отключает основные функции, AI, новые заявки, реферальные действия и оплату для одного Telegram ID. Финансовые и аудиторские записи сохраняются; пользователя можно разблокировать.",
    keyboard,
  );
}

async function showModerationRecord(env, chatId, targetId, callTelegram) {
  const row = await env.DB.prepare(
    `SELECT target_telegram_id, status, reason, blocked_by, blocked_at,
            unblocked_by, unblocked_at, revision
     FROM user_moderation_blocks
     WHERE target_telegram_id = ? LIMIT 1`,
  ).bind(targetId).first();
  if (!row) {
    await sendHtml(
      callTelegram,
      env,
      chatId,
      "Запись блокировки не найдена.",
      [[{ text: "⬅️ К блокировкам", callback_data: "h138:blocks" }]],
    );
    return;
  }
  const active = row.status === "active";
  const keyboard = [];
  if (active) {
    keyboard.push([{
      text: "✅ Разблокировать",
      callback_data:
        `h138:unblock:ask:${Number(row.target_telegram_id)}:${Number(row.revision)}`,
    }]);
  }
  keyboard.push([{
    text: "⬅️ К блокировкам",
    callback_data: "h138:blocks",
  }]);
  await sendHtml(
    callTelegram,
    env,
    chatId,
    `<b>${active ? "🚫 Активная блокировка" : "✅ Блокировка снята"}</b>\n\n` +
      `Telegram ID: <code>${Number(row.target_telegram_id)}</code>\n` +
      `Причина: ${escapeHtml(row.reason)}\n` +
      `Версия записи: <b>${Number(row.revision)}</b>\n` +
      `Заблокирован: <code>${new Date(Number(row.blocked_at) * 1000).toISOString()}</code>`,
    keyboard,
  );
}

async function startModerationFlow(env, adminId, chatId, callTelegram, at) {
  await deactivateAdminAiChat(env, adminId, at);
  await setModerationSession(env, adminId, { step: "target", at });
  await sendHtml(
    callTelegram,
    env,
    chatId,
    "<b>Шаг 1 из 3 · пользователь</b>\n\nОтправьте точный числовой Telegram ID зарегистрированного пользователя. Свой ID заблокировать нельзя.",
    [[{ text: "✖️ Отменить", callback_data: "h138:block:cancel" }]],
  );
}

async function handleModerationSessionMessage(
  env,
  actor,
  session,
  callTelegram,
  at,
) {
  const text = String(actor.message?.text || "").trim();
  if (!text || text.startsWith("/")) return false;
  if (session.step === "target") {
    const targetId = positiveTelegramId(text);
    if (!targetId) {
      await sendHtml(callTelegram, env, actor.chatId, "Нужен числовой Telegram ID.", [
        [{ text: "✖️ Отменить", callback_data: "h138:block:cancel" }],
      ]);
      return true;
    }
    if (targetId === actor.telegramId) {
      await sendHtml(callTelegram, env, actor.chatId, "Администратор не может заблокировать самого себя.", [
        [{ text: "✖️ Отменить", callback_data: "h138:block:cancel" }],
      ]);
      return true;
    }
    const user = await env.DB.prepare(
      "SELECT telegram_id FROM users WHERE telegram_id = ? LIMIT 1",
    ).bind(targetId).first();
    if (!user) {
      await sendHtml(callTelegram, env, actor.chatId, "Такого зарегистрированного пользователя пока нет. Проверьте ID.", [
        [{ text: "✖️ Отменить", callback_data: "h138:block:cancel" }],
      ]);
      return true;
    }
    const existing = await activeModerationBlock(env, targetId);
    if (existing) {
      await clearModerationSession(env, actor.telegramId);
      await showModerationRecord(env, actor.chatId, targetId, callTelegram);
      return true;
    }
    await setModerationSession(env, actor.telegramId, {
      step: "reason",
      targetTelegramId: targetId,
      at,
    });
    await sendHtml(
      callTelegram,
      env,
      actor.chatId,
      `<b>Шаг 2 из 3 · причина</b>\n\nID: <code>${targetId}</code>\nОтправьте короткую причину: спам, мошенничество, вредительство и т.п. От 3 до ${ADMIN_SAFETY_LIMITS.reasonCharacters} символов.`,
      [[{ text: "✖️ Отменить", callback_data: "h138:block:cancel" }]],
    );
    return true;
  }
  if (session.step === "reason") {
    const length = Array.from(text).length;
    if (length < 3 || length > ADMIN_SAFETY_LIMITS.reasonCharacters) {
      await sendHtml(
        callTelegram,
        env,
        actor.chatId,
        `Причина должна содержать 3–${ADMIN_SAFETY_LIMITS.reasonCharacters} символов.`,
        [[{ text: "✖️ Отменить", callback_data: "h138:block:cancel" }]],
      );
      return true;
    }
    const targetId = positiveTelegramId(session.target_telegram_id);
    await setModerationSession(env, actor.telegramId, {
      step: "confirm",
      targetTelegramId: targetId,
      reason: text,
      at,
    });
    await sendHtml(
      callTelegram,
      env,
      actor.chatId,
      "<b>Шаг 3 из 3 · подтверждение</b>\n\n" +
        `Пользователь: <code>${targetId}</code>\n` +
        `Причина: ${escapeHtml(text)}\n\n` +
        "Будет закрыт только доступ к функциям. Данные, платежи и аудит не удаляются.",
      [
        [{ text: "🚫 Подтвердить блокировку", callback_data: "h138:block:confirm" }],
        [{ text: "✖️ Отменить", callback_data: "h138:block:cancel" }],
      ],
    );
    return true;
  }
  await sendHtml(
    callTelegram,
    env,
    actor.chatId,
    "Подтвердите действие кнопкой или отмените его.",
    [
      [{ text: "🚫 Подтвердить блокировку", callback_data: "h138:block:confirm" }],
      [{ text: "✖️ Отменить", callback_data: "h138:block:cancel" }],
    ],
  );
  return true;
}

async function applyModerationBlock(env, actor, callTelegram, at) {
  const session = await getModerationSession(env, actor.telegramId, at);
  const targetId = positiveTelegramId(session?.target_telegram_id);
  const reason = String(session?.reason || "").trim();
  if (
    session?.step !== "confirm" || !targetId || targetId === actor.telegramId ||
    Array.from(reason).length < 3 ||
    Array.from(reason).length > ADMIN_SAFETY_LIMITS.reasonCharacters
  ) {
    await clearModerationSession(env, actor.telegramId);
    await sendHtml(callTelegram, env, actor.chatId, "Подтверждение истекло. Ничего не изменено.", [
      [{ text: "⬅️ К блокировкам", callback_data: "h138:blocks" }],
    ]);
    return;
  }
  const previous = await env.DB.prepare(
    `SELECT status, revision FROM user_moderation_blocks
     WHERE target_telegram_id = ? LIMIT 1`,
  ).bind(targetId).first();
  if (previous?.status === "active") {
    await clearModerationSession(env, actor.telegramId);
    await showModerationRecord(env, actor.chatId, targetId, callTelegram);
    return;
  }
  const revision = Number(previous?.revision || 0) + 1;
  const eventKey = `moderation:block:${targetId}:r${revision}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user_moderation_blocks (
         target_telegram_id, status, reason, blocked_by, blocked_at,
         unblocked_by, unblocked_at, last_notice_at, revision
       ) VALUES (?, 'active', ?, ?, ?, NULL, NULL, NULL, ?)
       ON CONFLICT(target_telegram_id) DO UPDATE SET
         status = 'active', reason = excluded.reason,
         blocked_by = excluded.blocked_by, blocked_at = excluded.blocked_at,
         unblocked_by = NULL, unblocked_at = NULL, last_notice_at = NULL,
         revision = excluded.revision
       WHERE user_moderation_blocks.status = 'revoked'
         AND user_moderation_blocks.revision = ?`,
    ).bind(
      targetId,
      reason,
      actor.telegramId,
      at,
      revision,
      Number(previous?.revision || 0),
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO user_moderation_events (
         event_key, target_telegram_id, actor_telegram_id, action,
         reason, resulting_revision, created_at
       )
       SELECT ?, ?, ?, 'block', ?, ?, ?
       FROM user_moderation_blocks
       WHERE target_telegram_id = ? AND status = 'active' AND revision = ?`,
    ).bind(
      eventKey,
      targetId,
      actor.telegramId,
      reason,
      revision,
      at,
      targetId,
      revision,
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_log
         (actor_id, action, entity_type, entity_id, details)
       SELECT ?, 'user_moderation_blocked', 'telegram_user', ?, ?
       WHERE EXISTS (
         SELECT 1 FROM user_moderation_events WHERE event_key = ?
       ) AND NOT EXISTS (
         SELECT 1 FROM admin_audit_log
         WHERE action = 'user_moderation_blocked'
           AND entity_type = 'telegram_user' AND entity_id = ?
           AND details = ?
       )`,
    ).bind(
      actor.telegramId,
      String(targetId),
      `revision: ${revision}; reason: ${reason}`.slice(0, 300),
      eventKey,
      String(targetId),
      `revision: ${revision}; reason: ${reason}`.slice(0, 300),
    ),
  ]);
  await clearModerationSession(env, actor.telegramId);
  await sendHtml(
    callTelegram,
    env,
    actor.chatId,
    `✅ Пользователь <code>${targetId}</code> заблокирован. Остальные пользователи и их данные не затронуты.`,
  );
  await showModerationRecord(env, actor.chatId, targetId, callTelegram);
}

async function showUnblockConfirmation(
  env,
  actor,
  targetId,
  revision,
  callTelegram,
) {
  const row = await env.DB.prepare(
    `SELECT target_telegram_id, reason, revision
     FROM user_moderation_blocks
     WHERE target_telegram_id = ? AND status = 'active' AND revision = ?
     LIMIT 1`,
  ).bind(targetId, revision).first();
  if (!row) {
    await showModerationHome(env, actor.chatId, callTelegram);
    return;
  }
  await sendHtml(
    callTelegram,
    env,
    actor.chatId,
    `<b>Разблокировать пользователя?</b>\n\nID: <code>${targetId}</code>\nПричина блокировки: ${escapeHtml(row.reason)}`,
    [
      [{
        text: "✅ Да, разблокировать",
        callback_data: `h138:unblock:ok:${targetId}:${revision}`,
      }],
      [{
        text: "Отмена",
        callback_data: `h138:block:view:${targetId}`,
      }],
    ],
  );
}

async function applyModerationUnblock(
  env,
  actor,
  targetId,
  revision,
  callTelegram,
  at,
) {
  const row = await env.DB.prepare(
    `SELECT reason FROM user_moderation_blocks
     WHERE target_telegram_id = ? AND status = 'active' AND revision = ?
     LIMIT 1`,
  ).bind(targetId, revision).first();
  if (!row) {
    await sendHtml(callTelegram, env, actor.chatId, "Запись уже изменилась. Ничего не выполнено.");
    await showModerationHome(env, actor.chatId, callTelegram);
    return;
  }
  const nextRevision = revision + 1;
  const eventKey = `moderation:unblock:${targetId}:r${nextRevision}`;
  const details = `revision: ${nextRevision}; previous reason: ${row.reason}`
    .slice(0, 300);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE user_moderation_blocks
       SET status = 'revoked', unblocked_by = ?, unblocked_at = ?,
           revision = ?
       WHERE target_telegram_id = ? AND status = 'active' AND revision = ?`,
    ).bind(actor.telegramId, at, nextRevision, targetId, revision),
    env.DB.prepare(
      `INSERT OR IGNORE INTO user_moderation_events (
         event_key, target_telegram_id, actor_telegram_id, action,
         reason, resulting_revision, created_at
       )
       SELECT ?, ?, ?, 'unblock', ?, ?, ?
       FROM user_moderation_blocks
       WHERE target_telegram_id = ? AND status = 'revoked' AND revision = ?`,
    ).bind(
      eventKey,
      targetId,
      actor.telegramId,
      String(row.reason),
      nextRevision,
      at,
      targetId,
      nextRevision,
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit_log
         (actor_id, action, entity_type, entity_id, details)
       SELECT ?, 'user_moderation_unblocked', 'telegram_user', ?, ?
       WHERE EXISTS (
         SELECT 1 FROM user_moderation_events WHERE event_key = ?
       ) AND NOT EXISTS (
         SELECT 1 FROM admin_audit_log
         WHERE action = 'user_moderation_unblocked'
           AND entity_type = 'telegram_user' AND entity_id = ?
           AND details = ?
       )`,
    ).bind(
      actor.telegramId,
      String(targetId),
      details,
      eventKey,
      String(targetId),
      details,
    ),
  ]);
  await sendHtml(
    callTelegram,
    env,
    actor.chatId,
    `✅ Пользователь <code>${targetId}</code> разблокирован. Его данные и история не переписывались.`,
  );
  await showModerationHome(env, actor.chatId, callTelegram);
}

async function ensureAdminAiState(env, adminId, at) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO admin_ai_chat_state
       (admin_telegram_id, active_model, updated_at)
     VALUES (?, 'off', ?)`,
  ).bind(adminId, at).run();
  return env.DB.prepare(
    `SELECT admin_telegram_id, active_model, external_consent_version,
            external_consented_at, external_revoked_at, updated_at
     FROM admin_ai_chat_state WHERE admin_telegram_id = ? LIMIT 1`,
  ).bind(adminId).first();
}

function currentDeepSeekConsent(state) {
  return Boolean(
    state?.external_consent_version === AI_GATEWAY_PROVIDER_CONSENT_VERSION &&
    Number(state?.external_consented_at || 0) > 0 &&
    state?.external_revoked_at === null,
  );
}

function aiChooserKeyboard(state, settings) {
  const active = String(state?.active_model || "off");
  const rows = [[
    {
      text: `${active === "qwen" ? "✅ " : ""}🛡 Qwen Safe`,
      callback_data: "h138:ai:qwen",
    },
    {
      text: `${active === "deepseek" ? "✅ " : ""}⚡ DeepSeek Flash`,
      callback_data: "h138:ai:deepseek",
    },
  ]];
  rows.push([
    { text: "🧹 Очистить диалог", callback_data: "h138:ai:clear" },
    { text: "⏹ Завершить", callback_data: "h138:ai:exit" },
  ]);
  if (currentDeepSeekConsent(state)) {
    rows.push([{
      text: "🔒 Отозвать разрешение DeepSeek",
      callback_data: "h138:ai:revoke",
    }]);
  }
  rows.push([{ text: "⬅️ К RE AI", callback_data: "admin_ai" }]);
  if (!settings.deepseekChatEnabled) {
    rows[0][1].text = "⛔ DeepSeek выключен";
  }
  return rows;
}

async function showAdminAiChooser(
  env,
  actor,
  settings,
  callTelegram,
  at,
) {
  const state = await ensureAdminAiState(env, actor.telegramId, at);
  const turns = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM admin_ai_chat_turns
     WHERE admin_telegram_id = ? AND status = 'completed'`,
  ).bind(actor.telegramId).first();
  const activeLabel = {
    off: "не выбран",
    qwen: "Qwen Safe",
    deepseek: "DeepSeek Flash",
  }[state.active_model] || "не выбран";
  await sendHtml(
    callTelegram,
    env,
    actor.chatId,
    "<b>🤖 Личный чат RE AI · администратор</b>\n\n" +
      `Активная модель: <b>${escapeHtml(activeLabel)}</b>\n` +
      `Память: <b>${Math.min(Number(turns?.total || 0), ADMIN_SAFETY_LIMITS.chatHistoryExchanges)} / ${ADMIN_SAFETY_LIMITS.chatHistoryExchanges} обменов</b>.\n\n` +
      "🛡 Qwen работает через Cloudflare Workers AI.\n" +
      "⚡ DeepSeek Flash использует ваш платный API-баланс; thinking и инструменты выключены.\n\n" +
      "Обе модели только отвечают текстом: у них нет доступа к SQL, платежам, ролям, блокировкам, публикации или чужим данным.",
    aiChooserKeyboard(state, settings),
  );
}

async function activateAdminAiModel(
  env,
  actor,
  settings,
  model,
  callTelegram,
  at,
) {
  const state = await ensureAdminAiState(env, actor.telegramId, at);
  if (model === "deepseek") {
    if (!settings.deepseekChatEnabled || String(env?.DEEPSEEK_API_KEY || "").trim().length < 20) {
      await sendHtml(callTelegram, env, actor.chatId, "DeepSeek сейчас безопасно выключен или API-ключ недоступен.", [
        [{ text: "⬅️ К выбору", callback_data: "h138:ai" }],
      ]);
      return;
    }
    if (!currentDeepSeekConsent(state)) {
      await sendHtml(
        callTelegram,
        env,
        actor.chatId,
        "<b>Включить платный DeepSeek Flash?</b>\n\n" +
          "Текст ваших сообщений и до 5 последних обменов будут передаваться API DeepSeek. Распознанные секреты, токены, номера карт, телефоны, email, Telegram ID и @username блокируются или скрываются до отправки.\n\n" +
          "Лимит: 30 успешных ответов в сутки и не более $1 за 30-дневный цикл. Вы сможете отозвать разрешение кнопкой.",
        [
          [{ text: "✅ Разрешаю и включаю", callback_data: "h138:ai:deepseek:ok" }],
          [{ text: "Отмена", callback_data: "h138:ai" }],
        ],
      );
      return;
    }
  }
  if (model === "qwen" && typeof env?.AI?.run !== "function") {
    await sendHtml(callTelegram, env, actor.chatId, "Cloudflare Workers AI сейчас не подключён.", [
      [{ text: "⬅️ К выбору", callback_data: "h138:ai" }],
    ]);
    return;
  }
  await clearModerationSession(env, actor.telegramId);
  await env.DB.prepare(
    `UPDATE admin_ai_chat_state SET active_model = ?, updated_at = ?
     WHERE admin_telegram_id = ?`,
  ).bind(model, at, actor.telegramId).run();
  await recordAdminAudit(
    env,
    actor.telegramId,
    "admin_ai_chat_model_selected",
    "admin_ai_chat",
    String(actor.telegramId),
    `model: ${model}`,
  );
  await sendHtml(
    callTelegram,
    env,
    actor.chatId,
    `✅ Выбран <b>${model === "deepseek" ? "DeepSeek Flash" : "Qwen Safe"}</b>. Теперь отправьте обычное сообщение.`,
    aiChooserKeyboard({ ...state, active_model: model }, settings),
  );
}

async function confirmDeepSeekConsent(
  env,
  actor,
  settings,
  callTelegram,
  at,
) {
  if (!settings.deepseekChatEnabled || String(env?.DEEPSEEK_API_KEY || "").trim().length < 20) {
    await sendHtml(callTelegram, env, actor.chatId, "DeepSeek сейчас недоступен. Разрешение не изменено.");
    return;
  }
  await ensureAdminAiState(env, actor.telegramId, at);
  await env.DB.prepare(
    `UPDATE admin_ai_chat_state
     SET active_model = 'deepseek', external_consent_version = ?,
         external_consented_at = ?, external_revoked_at = NULL,
         updated_at = ?
     WHERE admin_telegram_id = ?`,
  ).bind(
    AI_GATEWAY_PROVIDER_CONSENT_VERSION,
    at,
    at,
    actor.telegramId,
  ).run();
  await recordAdminAudit(
    env,
    actor.telegramId,
    "admin_deepseek_chat_consented",
    "admin_ai_chat",
    String(actor.telegramId),
    `consent: ${AI_GATEWAY_PROVIDER_CONSENT_VERSION}`,
  );
  await sendHtml(
    callTelegram,
    env,
    actor.chatId,
    "✅ DeepSeek Flash включён. Отправьте обычное сообщение — ответ придёт сюда.",
    aiChooserKeyboard({
      active_model: "deepseek",
      external_consent_version: AI_GATEWAY_PROVIDER_CONSENT_VERSION,
      external_consented_at: at,
      external_revoked_at: null,
    }, settings),
  );
}

async function clearAdminAiHistory(env, actor, callTelegram, at) {
  await env.DB.prepare(
    "DELETE FROM admin_ai_chat_turns WHERE admin_telegram_id = ?",
  ).bind(actor.telegramId).run();
  await recordAdminAudit(
    env,
    actor.telegramId,
    "admin_ai_chat_history_cleared",
    "admin_ai_chat",
    String(actor.telegramId),
    "raw messages deleted",
  );
  await sendHtml(callTelegram, env, actor.chatId, "✅ Память личного AI-чата очищена.");
  const settings = await readRuntimeSettings(env);
  await showAdminAiChooser(env, actor, settings, callTelegram, at);
}

async function exitAdminAiChat(env, actor, callTelegram, at) {
  await deactivateAdminAiChat(env, actor.telegramId, at);
  await sendHtml(
    callTelegram,
    env,
    actor.chatId,
    "✅ Личный AI-чат завершён. История сохранена до очистки и больше не передаётся моделям.",
    [[{ text: "⬅️ К RE AI", callback_data: "admin_ai" }]],
  );
}

async function revokeDeepSeekConsent(env, actor, callTelegram, at) {
  await ensureAdminAiState(env, actor.telegramId, at);
  await env.DB.prepare(
    `UPDATE admin_ai_chat_state
     SET active_model = CASE WHEN active_model = 'deepseek' THEN 'off' ELSE active_model END,
         external_revoked_at = ?, updated_at = ?
     WHERE admin_telegram_id = ?`,
  ).bind(at, at, actor.telegramId).run();
  await recordAdminAudit(
    env,
    actor.telegramId,
    "admin_deepseek_chat_revoked",
    "admin_ai_chat",
    String(actor.telegramId),
    "external consent revoked",
  );
  await sendHtml(callTelegram, env, actor.chatId, "✅ Разрешение DeepSeek отозвано. Новые сообщения ему не отправляются.");
  const settings = await readRuntimeSettings(env);
  await showAdminAiChooser(env, actor, settings, callTelegram, at);
}

async function sha256Hex(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw new Error("admin_ai_crypto_unavailable");
  const digest = await cryptoImpl.subtle.digest(
    "SHA-256",
    TEXT_ENCODER.encode(String(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function cycleWindow(at) {
  const startAt = Math.floor(at / AI_GATEWAY_HARD_LIMITS.cycleSeconds) *
    AI_GATEWAY_HARD_LIMITS.cycleSeconds;
  return Object.freeze({
    startAt,
    endAt: startAt + AI_GATEWAY_HARD_LIMITS.cycleSeconds,
  });
}

function adminChatConfig(env, model) {
  return readAiPartnerConfig({
    ...env,
    AI_PARTNER_ENABLED: "true",
    AI_PARTNER_ROLLOUT_MODE: "admin",
    AI_PARTNER_EXTERNAL_PROVIDER_ENABLED:
      model === "deepseek" ? "true" : "false",
    AI_PARTNER_RICH_MESSAGES_ENABLED: "false",
    AI_PARTNER_DRAGON_DAILY_BURST_LIMIT:
      String(ADMIN_SAFETY_LIMITS.chatDailySuccesses),
    AI_PARTNER_DRAGON_CYCLE_SUCCESS_LIMIT:
      String(ADMIN_SAFETY_LIMITS.chatCycleSuccesses),
    AI_PARTNER_USER_CYCLE_COST_CEILING_MICROUSD:
      String(ADMIN_SAFETY_LIMITS.chatCycleCostMicrousd),
    AI_PARTNER_GLOBAL_CYCLE_COST_CEILING_MICROUSD:
      String(ADMIN_SAFETY_LIMITS.chatCycleCostMicrousd),
  });
}

function buildChatMessages(history, userText) {
  const messages = [{
    role: "system",
    content:
      "Ты RE AI, личный текстовый помощник администратора RE Program Bot. " +
      "Отвечай по-русски ясно и по делу. У тебя нет инструментов, интернета, " +
      "доступа к базе, платежам, ролям, блокировкам, публикации или чужим " +
      "данным. Не утверждай, что выполнил действие. Никогда не проси API-ключи, " +
      "пароли, банковские данные или коды из СМС.",
  }];
  for (const turn of history) {
    messages.push(
      { role: "user", content: String(turn.user_message) },
      { role: "assistant", content: String(turn.assistant_message) },
    );
  }
  messages.push({ role: "user", content: userText });
  return messages;
}

function estimatedTokens(messages) {
  const characters = messages.reduce(
    (sum, message) => sum + String(message.content || "").length,
    0,
  );
  return Math.max(
    32,
    Math.min(AI_GATEWAY_HARD_LIMITS.maxInputTokens, Math.ceil(characters / 3)),
  );
}

function modelLabel(alias) {
  return alias === AI_PARTNER_MODEL_ALIASES.dragon
    ? "⚡ DeepSeek Flash"
    : "🛡 Qwen Safe";
}

function gatewayFailureText(reason) {
  if (reason === "secret_material_blocked") {
    return "🔒 Сообщение не отправлено: похоже, в нём есть API-ключ, токен или другой секрет. Уберите секрет и повторите.";
  }
  if (reason === "daily_success_limit") {
    return "🙂 Дневной лимит личного AI-чата закончился. Он обновится по UTC.";
  }
  if (new Set([
    "user_cost_ceiling",
    "global_cost_ceiling",
    "user_token_ceiling",
    "global_token_ceiling",
  ]).has(reason)) {
    return "🛡 Лимит расходов AI-чата достигнут. Платный вызов не выполнен.";
  }
  if (reason === "request_in_progress") {
    return "⏳ Предыдущее сообщение ещё обрабатывается.";
  }
  return "⚠️ AI сейчас не смог ответить. Сообщение можно отправить ещё раз; остальные функции бота работают.";
}

async function replayExistingTurn(env, actor, row, callTelegram) {
  if (row.status === "completed") {
    await sendHtml(
      callTelegram,
      env,
      actor.chatId,
      `${escapeHtml(row.assistant_message)}\n\n<i>${modelLabel(row.final_model_alias)} · повторная доставка без нового списания</i>`,
      [[{ text: "🤖 Выбор модели", callback_data: "h138:ai" }]],
    );
    return true;
  }
  await sendHtml(
    callTelegram,
    env,
    actor.chatId,
    row.status === "pending"
      ? "⏳ Это сообщение уже обрабатывается. Новый платный запрос не запущен."
      : "⚠️ Эта попытка уже завершилась ошибкой. Отправьте сообщение заново, если хотите повторить.",
    [[{ text: "🤖 Выбор модели", callback_data: "h138:ai" }]],
  );
  return true;
}

async function handleAdminAiMessage(
  env,
  actor,
  state,
  settings,
  callTelegram,
  at,
  updateId,
  options,
) {
  const text = String(actor.message?.text || "").trim();
  if (!text || text.startsWith("/")) return false;
  const length = Array.from(text).length;
  if (length > ADMIN_SAFETY_LIMITS.chatMessageCharacters) {
    await sendHtml(
      callTelegram,
      env,
      actor.chatId,
      `Сообщение слишком длинное. Максимум ${ADMIN_SAFETY_LIMITS.chatMessageCharacters} символов.`,
      [[{ text: "🤖 Выбор модели", callback_data: "h138:ai" }]],
    );
    return true;
  }
  const model = String(state.active_model);
  if (model === "deepseek" && (
    !settings.deepseekChatEnabled || !currentDeepSeekConsent(state)
  )) {
    await deactivateAdminAiChat(env, actor.telegramId, at);
    await sendHtml(callTelegram, env, actor.chatId, "DeepSeek выключен или разрешение отозвано. Выберите модель снова.", [
      [{ text: "🤖 Выбрать модель", callback_data: "h138:ai" }],
    ]);
    return true;
  }
  if (model === "qwen" && typeof env?.AI?.run !== "function") {
    await sendHtml(callTelegram, env, actor.chatId, "Qwen сейчас недоступен. Выберите другую модель.", [
      [{ text: "🤖 Выбрать модель", callback_data: "h138:ai" }],
    ]);
    return true;
  }
  const telegramUpdateId = Number(updateId);
  if (!Number.isSafeInteger(telegramUpdateId) || telegramUpdateId < 0) {
    await sendHtml(callTelegram, env, actor.chatId, "Telegram не передал надёжный номер сообщения. Запрос не отправлен.");
    return true;
  }
  const requestId = `a138chat:${actor.telegramId}:${telegramUpdateId}`;
  const promptHash = await sha256Hex(text, options.cryptoImpl || globalThis.crypto);
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO admin_ai_chat_turns (
       request_id, admin_telegram_id, telegram_update_id,
       requested_model, prompt_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    requestId,
    actor.telegramId,
    telegramUpdateId,
    model,
    promptHash,
    at,
  ).run();
  if (!statementChanged(inserted)) {
    const existing = await env.DB.prepare(
      `SELECT status, assistant_message, final_model_alias
       FROM admin_ai_chat_turns WHERE request_id = ? LIMIT 1`,
    ).bind(requestId).first();
    return replayExistingTurn(env, actor, existing, callTelegram);
  }

  await safelyTyping(callTelegram, env, actor.chatId);
  const historyRows = await env.DB.prepare(
    `SELECT user_message, assistant_message
     FROM admin_ai_chat_turns
     WHERE admin_telegram_id = ? AND status = 'completed'
     ORDER BY completed_at DESC, telegram_update_id DESC
     LIMIT ?`,
  ).bind(
    actor.telegramId,
    ADMIN_SAFETY_LIMITS.chatHistoryExchanges,
  ).all();
  const history = [...(historyRows?.results || [])].reverse();
  const messages = buildChatMessages(history, text);
  const cycle = cycleWindow(at);
  const config = adminChatConfig(env, model);
  const context = createVerifiedAdminGatewayContext({
    actorTelegramId: actor.telegramId,
    isAdmin: true,
    purpose: "admin_chat",
    at,
    userCycleStartAt: cycle.startAt,
    userCycleEndAt: cycle.endAt,
    globalCycleStartAt: cycle.startAt,
    globalCycleEndAt: cycle.endAt,
    externalConsent: model === "deepseek"
      ? {
          version: state.external_consent_version,
          consentedAt: Number(state.external_consented_at),
          revokedAt: state.external_revoked_at === null
            ? null
            : Number(state.external_revoked_at),
        }
      : null,
    dataClass: "private",
    cacheAllowed: false,
  });
  let result;
  try {
    result = await runAiPartnerGateway({
      db: env.DB,
      context,
      config,
      request: {
        requestId,
        dataClass: "private",
        estimatedInputTokens: estimatedTokens(messages),
        maxOutputTokens: ADMIN_SAFETY_LIMITS.chatMaxOutputTokens,
        sourceCount: 0,
        allowCache: false,
        payload: { messages },
      },
      pricing: AI_PARTNER_DEEPSEEK_FLASH_PRICING,
      transports: createAiPartnerProviderTransports(env, {
        fetchImpl: options.fetchImpl || globalThis.fetch,
      }),
      providerUserIdSecret: env.AI_PARTNER_PROVIDER_USER_ID_SECRET,
      cacheScopeSecret: env.AI_PARTNER_PRIVATE_CACHE_SECRET,
      validateOutput: async (content) => {
        const normalized = String(content || "").trim();
        if (!normalized) {
          const error = new Error("empty admin AI answer");
          error.code = "admin_ai_empty_answer";
          throw error;
        }
        return Array.from(normalized)
          .slice(0, ADMIN_SAFETY_LIMITS.chatAnswerCharacters)
          .join("");
      },
      cryptoImpl: options.cryptoImpl || globalThis.crypto,
    });
  } catch (error) {
    const code = safeErrorCode(error?.code || error?.message);
    await env.DB.prepare(
      `UPDATE admin_ai_chat_turns
       SET status = 'failed', error_code = ?, completed_at = ?
       WHERE request_id = ? AND status = 'pending'`,
    ).bind(code, at, requestId).run();
    await safeTechnicalLog(env, "admin_ai_chat.gateway", error);
    await sendHtml(callTelegram, env, actor.chatId, gatewayFailureText(code), [
      [{ text: "🤖 Выбор модели", callback_data: "h138:ai" }],
    ]);
    return true;
  }
  if (!result?.ok) {
    const code = safeErrorCode(result?.reason);
    await env.DB.prepare(
      `UPDATE admin_ai_chat_turns
       SET status = 'failed', error_code = ?, completed_at = ?
       WHERE request_id = ? AND status = 'pending'`,
    ).bind(code, at, requestId).run();
    await sendHtml(callTelegram, env, actor.chatId, gatewayFailureText(code), [
      [{ text: "🤖 Выбор модели", callback_data: "h138:ai" }],
    ]);
    return true;
  }
  const answer = String(result.output);
  await env.DB.prepare(
    `UPDATE admin_ai_chat_turns
     SET status = 'completed', final_model_alias = ?, user_message = ?,
         assistant_message = ?, billed_tokens = ?, cost_microusd = ?,
         latency_ms = ?, completed_at = ?
     WHERE request_id = ? AND status = 'pending'`,
  ).bind(
    result.modelAlias,
    text,
    answer,
    Number(result.telemetry?.billedTokens || 0),
    Number(result.telemetry?.costMicrousd || 0),
    Number(result.telemetry?.totalLatencyMs || 0),
    at,
    requestId,
  ).run();
  await env.DB.prepare(
    `DELETE FROM admin_ai_chat_turns
     WHERE admin_telegram_id = ? AND status = 'completed'
       AND request_id NOT IN (
         SELECT request_id FROM admin_ai_chat_turns
         WHERE admin_telegram_id = ? AND status = 'completed'
         ORDER BY completed_at DESC, telegram_update_id DESC LIMIT ?
       )`,
  ).bind(
    actor.telegramId,
    actor.telegramId,
    ADMIN_SAFETY_LIMITS.chatHistoryExchanges,
  ).run();
  await env.DB.prepare(
    `DELETE FROM admin_ai_chat_turns
     WHERE admin_telegram_id = ? AND status = 'failed'
       AND completed_at < ?`,
  ).bind(actor.telegramId, at - 24 * 60 * 60).run();
  const fallback = model === "deepseek" &&
    result.modelAlias !== AI_PARTNER_MODEL_ALIASES.dragon;
  const cost = Number(result.telemetry?.costMicrousd || 0) / 1_000_000;
  const footer =
    `${modelLabel(result.modelAlias)}` +
    `${fallback ? " · fallback" : ""}` +
    ` · ${Number(result.telemetry?.billedTokens || 0)} токенов` +
    `${cost ? ` · $${cost.toFixed(6)}` : ""}`;
  await sendHtml(
    callTelegram,
    env,
    actor.chatId,
    `${escapeHtml(answer)}\n\n<i>${escapeHtml(footer)}</i>`,
    [[{ text: "🤖 Выбор модели", callback_data: "h138:ai" }]],
  );
  return true;
}

async function handleAdminCallback(
  env,
  actor,
  settings,
  callTelegram,
  at,
) {
  const action = String(actor.callback?.data || "");
  await safelyAnswerCallback(callTelegram, env, actor.callback?.id);
  if (
    !settings.moderationEnabled &&
    /^h138:(?:blocks?|unblock:)/.test(action)
  ) {
    await clearModerationSession(env, actor.telegramId);
    await sendHtml(
      callTelegram,
      env,
      actor.chatId,
      "Персональные блокировки сейчас выключены защитным переключателем.",
      [[{ text: "⬅️ В админ-панель", callback_data: "admin_dashboard" }]],
    );
    return true;
  }
  if (!settings.adminAiChatEnabled && action.startsWith("h138:ai")) {
    await deactivateAdminAiChat(env, actor.telegramId, at);
    await sendHtml(
      callTelegram,
      env,
      actor.chatId,
      "Личный AI-чат сейчас выключен защитным переключателем.",
      [[{ text: "⬅️ К RE AI", callback_data: "admin_ai" }]],
    );
    return true;
  }
  if (action === "h138:blocks") {
    await clearModerationSession(env, actor.telegramId);
    await showModerationHome(env, actor.chatId, callTelegram);
    return true;
  }
  if (action === "h138:block:new") {
    await startModerationFlow(env, actor.telegramId, actor.chatId, callTelegram, at);
    return true;
  }
  if (action === "h138:block:cancel") {
    await clearModerationSession(env, actor.telegramId);
    await sendHtml(callTelegram, env, actor.chatId, "✅ Действие отменено. Ничего не изменено.");
    await showModerationHome(env, actor.chatId, callTelegram);
    return true;
  }
  if (action === "h138:block:confirm") {
    await applyModerationBlock(env, actor, callTelegram, at);
    return true;
  }
  const blockView = action.match(/^h138:block:view:(\d+)$/);
  if (blockView) {
    await showModerationRecord(
      env,
      actor.chatId,
      positiveTelegramId(blockView[1]),
      callTelegram,
    );
    return true;
  }
  const unblockAsk = action.match(/^h138:unblock:ask:(\d+):(\d+)$/);
  if (unblockAsk) {
    await showUnblockConfirmation(
      env,
      actor,
      positiveTelegramId(unblockAsk[1]),
      Number(unblockAsk[2]),
      callTelegram,
    );
    return true;
  }
  const unblockOk = action.match(/^h138:unblock:ok:(\d+):(\d+)$/);
  if (unblockOk) {
    await applyModerationUnblock(
      env,
      actor,
      positiveTelegramId(unblockOk[1]),
      Number(unblockOk[2]),
      callTelegram,
      at,
    );
    return true;
  }
  if (action === "h138:ai") {
    await showAdminAiChooser(env, actor, settings, callTelegram, at);
    return true;
  }
  if (action === "h138:ai:qwen") {
    await activateAdminAiModel(env, actor, settings, "qwen", callTelegram, at);
    return true;
  }
  if (action === "h138:ai:deepseek") {
    await activateAdminAiModel(env, actor, settings, "deepseek", callTelegram, at);
    return true;
  }
  if (action === "h138:ai:deepseek:ok") {
    await confirmDeepSeekConsent(env, actor, settings, callTelegram, at);
    return true;
  }
  if (action === "h138:ai:clear") {
    await clearAdminAiHistory(env, actor, callTelegram, at);
    return true;
  }
  if (action === "h138:ai:exit") {
    await exitAdminAiChat(env, actor, callTelegram, at);
    return true;
  }
  if (action === "h138:ai:revoke") {
    await revokeDeepSeekConsent(env, actor, callTelegram, at);
    return true;
  }
  await sendHtml(callTelegram, env, actor.chatId, "Действие hotfix недоступно.");
  return true;
}

export function createAdminSafetyRuntime({
  callTelegram = defaultTelegramCall,
  now = () => Math.floor(Date.now() / 1_000),
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
} = {}) {
  if (typeof callTelegram !== "function") {
    throw new TypeError("Telegram transport is required");
  }
  return Object.freeze({
    getAdminDashboardRows(env) {
      return flag(env?.ADMIN_MODERATION_ENABLED)
        ? [[{
            text: "🚫 Блокировки пользователей",
            callback_data: "h138:blocks",
          }]]
        : [];
    },
    getAdminAiChatRows(env) {
      return flag(env?.ADMIN_AI_CHAT_ENABLED)
        ? [[
            { text: "🛡 Чат Qwen", callback_data: "h138:ai:qwen" },
            { text: "⚡ Чат DeepSeek", callback_data: "h138:ai:deepseek" },
          ], [
            { text: "🤖 Открыть личный AI-чат", callback_data: "h138:ai" },
          ]]
        : [];
    },
    async canDeliverToUser(env, telegramId) {
      if (!flag(env?.ADMIN_MODERATION_ENABLED)) return true;
      const settings = await readRuntimeSettings(env);
      if (!settings.moderationEnabled || isAdmin(env, telegramId)) return true;
      return !(await activeModerationBlock(env, positiveTelegramId(telegramId)));
    },
    async countBroadcastRecipients(env) {
      const settings = await readRuntimeSettings(env);
      if (!settings.moderationEnabled) return null;
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS total
         FROM users u
         LEFT JOIN notification_settings n ON n.telegram_id = u.telegram_id
         WHERE u.accepted_terms = 1 AND u.is_blocked = 0
           AND COALESCE(n.telegram_enabled, 1) = 1
           AND NOT EXISTS (
             SELECT 1 FROM user_moderation_blocks b
             WHERE b.target_telegram_id = u.telegram_id
               AND b.status = 'active'
           )`,
      ).first();
      return Number(row?.total || 0);
    },
    async seedBroadcastRecipients(env, broadcastId, actorId) {
      const settings = await readRuntimeSettings(env);
      if (!settings.moderationEnabled) return false;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO admin_broadcast_deliveries
             (broadcast_id, telegram_id)
           SELECT ?, u.telegram_id
           FROM users u
           LEFT JOIN notification_settings n ON n.telegram_id = u.telegram_id
           WHERE u.accepted_terms = 1 AND u.is_blocked = 0
             AND COALESCE(n.telegram_enabled, 1) = 1
             AND NOT EXISTS (
               SELECT 1 FROM user_moderation_blocks b
               WHERE b.target_telegram_id = u.telegram_id
                 AND b.status = 'active'
             )`,
        ).bind(broadcastId),
        env.DB.prepare(
          `UPDATE admin_broadcasts
           SET recipient_count = (
             SELECT COUNT(*) FROM admin_broadcast_deliveries
             WHERE broadcast_id = ?
           )
           WHERE id = ? AND actor_id = ?`,
        ).bind(broadcastId, broadcastId, actorId),
      ]);
      return true;
    },
    async handleUpdate(env, update, options = {}) {
      const actor = privateUpdateActor(update);
      if (!actor) return Object.freeze({ handled: false, status: "not_private" });
      const at = Number(options.at ?? now());
      if (
        actor.message &&
        PRIVATE_LEGAL_COMMAND.test(String(actor.message.text || "").trim())
      ) {
        return Object.freeze({ handled: false, status: "legal_route" });
      }
      if (actor.message && isPaymentLedgerMessage(actor.message)) {
        return Object.freeze({ handled: false, status: "ledger_route" });
      }
      let settings;
      try {
        settings = await readRuntimeSettings(env);
      } catch (error) {
        await safeTechnicalLog(env, "admin_safety.schema", error);
        if (isAdmin(env, actor.telegramId)) {
          return Object.freeze({ handled: false, status: "schema_unavailable" });
        }
        return Object.freeze({ handled: true, status: "fail_closed" });
      }
      if (settings.moderationEnabled && !isAdmin(env, actor.telegramId)) {
        const block = await activeModerationBlock(env, actor.telegramId);
        if (block) {
          return handleBlockedActor(env, actor, block, callTelegram, at);
        }
      }
      if (!isAdmin(env, actor.telegramId)) {
        return Object.freeze({ handled: false, status: "allowed" });
      }
      if (actor.callback && HOTFIX_CALLBACK.test(String(actor.callback.data || ""))) {
        await handleAdminCallback(env, actor, settings, callTelegram, at);
        return Object.freeze({ handled: true, status: "admin_action" });
      }
      if (actor.callback) {
        await clearModerationSession(env, actor.telegramId);
        if (settings.adminAiChatEnabled) {
          await deactivateAdminAiChat(env, actor.telegramId, at);
        }
      }
      if (actor.message && ADMIN_BLOCK_COMMAND.test(String(actor.message.text || "").trim())) {
        await startModerationFlow(env, actor.telegramId, actor.chatId, callTelegram, at);
        return Object.freeze({ handled: true, status: "moderation_started" });
      }
      if (actor.message && /^\/cancel(?:@RE_Program_Bot)?$/i.test(String(actor.message.text || "").trim())) {
        const moderation = await getModerationSession(env, actor.telegramId, at);
        if (moderation) {
          await clearModerationSession(env, actor.telegramId);
          await sendHtml(callTelegram, env, actor.chatId, "✅ Блокировка отменена. Ничего не изменено.");
          return Object.freeze({ handled: true, status: "moderation_cancelled" });
        }
        const chatState = await ensureAdminAiState(env, actor.telegramId, at);
        if (chatState.active_model !== "off") {
          await exitAdminAiChat(env, actor, callTelegram, at);
          return Object.freeze({ handled: true, status: "admin_ai_exited" });
        }
      }
      if (actor.message && settings.moderationEnabled) {
        const moderation = await getModerationSession(env, actor.telegramId, at);
        if (moderation && await handleModerationSessionMessage(
          env,
          actor,
          moderation,
          callTelegram,
          at,
        )) {
          return Object.freeze({ handled: true, status: "moderation_input" });
        }
      }
      if (actor.message && settings.adminAiChatEnabled) {
        const state = await ensureAdminAiState(env, actor.telegramId, at);
        if (
          state.active_model !== "off" &&
          await handleAdminAiMessage(
            env,
            actor,
            state,
            settings,
            callTelegram,
            at,
            update?.update_id,
            { fetchImpl, cryptoImpl },
          )
        ) {
          return Object.freeze({ handled: true, status: "admin_ai_message" });
        }
      }
      return Object.freeze({ handled: false, status: "not_targeted" });
    },
  });
}

export const adminSafetyRuntime = createAdminSafetyRuntime();
