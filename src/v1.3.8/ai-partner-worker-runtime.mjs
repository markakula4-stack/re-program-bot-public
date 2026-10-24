import {
  AI_PARTNER_LIMITS,
  AI_PARTNER_MODEL_ALIASES,
} from "./ai-partner-foundation.mjs";
import {
  listAiPartnerDraftFormats,
} from "./ai-partner-draft-runtime.mjs";
import {
  AI_GATEWAY_HARD_LIMITS,
} from "./ai-partner-gateway.mjs";
import {
  createAiPartnerContextFromVerifiedUpdate,
} from "./ai-partner-telegram-ux.mjs";
import {
  getAiPartnerRolloutDecision,
} from "./ai-partner-release-runtime.mjs";

export const AI_PARTNER_RUNTIME_KEY =
  "__RE_PROGRAM_AI_PARTNER_RUNTIME__";

const TELEGRAM_TIMEOUT_MS = 10_000;
const AI_PARTNER_COMMAND = /^\/ai_partner(?:@RE_Program_Bot)?$/i;
const AI_PARTNER_CALLBACK = /^a38:(?:hub|status)$/;
const FORMAT_LABELS = Object.freeze({
  telegram_post: "Telegram-пост",
  private_message: "личное сообщение",
  short_card: "короткая карточка",
  promotion_idea: "идея продвижения",
  short_video_script: "сценарий Shorts/Reels",
  offer_explanation: "объяснение условий",
});

function positiveTelegramId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function privateMessage(update) {
  const message = update?.message;
  const actor = positiveTelegramId(message?.from?.id);
  const chat = positiveTelegramId(message?.chat?.id);
  if (
    !actor ||
    !chat ||
    actor !== chat ||
    message?.from?.is_bot ||
    message?.chat?.type !== "private"
  ) {
    return null;
  }
  return Object.freeze({
    actorTelegramId: actor,
    chatId: chat,
    text: String(message.text || "").trim(),
  });
}

function privateCallback(update) {
  const query = update?.callback_query;
  const actor = positiveTelegramId(query?.from?.id);
  const chat = positiveTelegramId(query?.message?.chat?.id);
  if (
    !actor ||
    !chat ||
    actor !== chat ||
    query?.from?.is_bot ||
    query?.message?.chat?.type !== "private" ||
    typeof query?.id !== "string" ||
    query.id.length < 4
  ) {
    return null;
  }
  return Object.freeze({
    actorTelegramId: actor,
    chatId: chat,
    callbackQueryId: query.id,
    data: String(query.data || ""),
  });
}

function isAdmin(env, actorTelegramId) {
  const admin = positiveTelegramId(env?.ADMIN_ID);
  return Boolean(admin && admin === positiveTelegramId(actorTelegramId));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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

async function safelyAnswerCallback(callTelegram, env, callbackQueryId) {
  try {
    await callTelegram(env, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
    });
  } catch {
    // A failed callback acknowledgement must not widen the rollout boundary.
  }
}

async function sendPlainMessage(callTelegram, env, chatId, text, keyboard) {
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

function hubText(context) {
  const formats = listAiPartnerDraftFormats()
    .map(({ draftType }) => `• ${FORMAT_LABELS[draftType] || draftType}`)
    .join("\n");
  const provider = context.model.modelAlias === AI_PARTNER_MODEL_ALIASES.dragon
    ? "DeepSeek Flash (thinking выключен)"
    : "безопасный Cloudflare Qwen";
  return (
    "<b>🤖 RE AI Partner · закрытый admin-контур</b>\n\n" +
    "Runtime v1.3.8 подключён, но доступен только администратору внутри " +
    "короткого подтверждённого canary-окна. Публичного и allowlist-режима нет.\n\n" +
    `<b>Маршрут:</b> ${escapeHtml(provider)}\n` +
    `<b>Форматы:</b>\n${escapeHtml(formats)}\n\n` +
    `<b>Лимиты:</b> ${AI_PARTNER_LIMITS.dailyBurst}/сутки, ` +
    `${AI_PARTNER_LIMITS.cycleSuccess}/30 дней, ` +
    `${AI_GATEWAY_HARD_LIMITS.maxExternalAttempts} внешние попытки максимум, ` +
    `${AI_GATEWAY_HARD_LIMITS.maxFallbackAttempts} fallback.\n\n` +
    "На этом этапе экран доказывает production wiring и admin-only границу. " +
    "Генерация и внешний provider-вызов остаются закрыты до отдельного " +
    "reviewed smoke/deploy шага."
  );
}

function hubKeyboard() {
  return [
    [{ text: "🔄 Проверить контур", callback_data: "a38:status" }],
    [{ text: "⬅️ В меню", callback_data: "menu" }],
  ];
}

export function createAiPartnerWorkerRuntime({
  callTelegram = defaultTelegramCall,
} = {}) {
  if (typeof callTelegram !== "function") {
    throw new TypeError("Telegram transport is required");
  }
  return Object.freeze({
    async handleUpdate(env, update) {
      const message = privateMessage(update);
      const callback = privateCallback(update);
      const commandTarget = Boolean(
        message && AI_PARTNER_COMMAND.test(message.text),
      );
      const callbackTarget = Boolean(
        callback &&
        (callback.data === "ai_hub" || callback.data.startsWith("a38:")),
      );
      if (!commandTarget && !callbackTarget) {
        return Object.freeze({ handled: false, status: "not_targeted" });
      }

      const actorTelegramId =
        message?.actorTelegramId || callback?.actorTelegramId;
      const chatId = message?.chatId || callback?.chatId;
      if (callback?.data.startsWith("a38:")) {
        await safelyAnswerCallback(
          callTelegram,
          env,
          callback.callbackQueryId,
        );
      }

      let decision;
      try {
        decision = await getAiPartnerRolloutDecision(env, actorTelegramId);
      } catch {
        decision = { eligible: false, reason: "runtime_not_ready" };
      }

      if (!decision.eligible) {
        if (callback?.data === "ai_hub") {
          return Object.freeze({ handled: false, status: decision.reason });
        }
        if (!isAdmin(env, actorTelegramId)) {
          return Object.freeze({ handled: true, status: "non_admin_blocked" });
        }
        await sendPlainMessage(
          callTelegram,
          env,
          chatId,
          "<b>🤖 RE AI Partner</b>\n\nЗакрытый admin-контур сейчас выключен или срок его разрешения истёк. Базовые функции бота не изменены.",
          [[{ text: "⬅️ В меню", callback_data: "menu" }]],
        );
        return Object.freeze({ handled: true, status: decision.reason });
      }

      if (callback?.data === "ai_hub") {
        await safelyAnswerCallback(
          callTelegram,
          env,
          callback.callbackQueryId,
        );
      }

      if (
        callback?.data.startsWith("a38:") &&
        !AI_PARTNER_CALLBACK.test(callback.data)
      ) {
        await sendPlainMessage(
          callTelegram,
          env,
          chatId,
          "Действие закрытого RE AI Partner недоступно.",
          hubKeyboard(),
        );
        return Object.freeze({ handled: true, status: "action_denied" });
      }

      try {
        const context = createAiPartnerContextFromVerifiedUpdate(env, {
          actorTelegramId,
          updateId: Number(update?.update_id),
          callbackQueryId: callback?.callbackQueryId || null,
          chatType: "private",
          isAdmin: true,
        });
        await sendPlainMessage(
          callTelegram,
          env,
          chatId,
          hubText(context),
          hubKeyboard(),
        );
        return Object.freeze({ handled: true, status: "admin_canary" });
      } catch {
        await sendPlainMessage(
          callTelegram,
          env,
          chatId,
          "<b>🤖 RE AI Partner</b>\n\nКонтур закрылся безопасно: проверка runtime не пройдена. Остальные функции бота продолжают работать.",
          [[{ text: "⬅️ В меню", callback_data: "menu" }]],
        );
        return Object.freeze({ handled: true, status: "fail_closed" });
      }
    },
  });
}

export const aiPartnerWorkerRuntime = createAiPartnerWorkerRuntime();
