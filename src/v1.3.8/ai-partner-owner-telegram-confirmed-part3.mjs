import {
  completeAiPartnerGenerationSession,
  failAiPartnerGenerationSession,
} from "./ai-partner-telegram-ux-confirmed-part3.mjs";
import {
  cancelOwnerConfirmedDraftWrite,
  consumeOwnerConfirmedDraftWrite,
  expireOwnerPreparedDraftWrites,
} from "./ai-partner-owner-write-tools-part2.mjs";
import {
  clearOwnerMemoryExchanges,
  listOwnerMemoryExchanges,
  readOwnerMemoryState,
  setOwnerMemoryConsent,
} from "./ai-partner-owner-memory-part1.mjs";
import { renderAiPartnerOwnerDraftPreview } from "./ai-partner-owner-telegram-rich-ux-confirmed-part3.mjs";

const TOKEN = /^a38w:(save|cancel):(w38_[A-Za-z0-9_-]{32})$/;
const MEMORY = /^a38m:(show|grant|grant_ok|revoke|clear|clear_ok|list(?::[0-4])?)$/;
const encoder = new TextEncoder();

function rejection(code) {
  const error = new Error("Owner confirmation Telegram action rejected");
  error.code = code;
  return error;
}

function ownerContext(env, context) {
  const actor = Number(context?.actorTelegramId);
  if (!Number.isSafeInteger(actor) || actor <= 0 ||
    actor !== Number(env?.ADMIN_ID) ||
    Number(context?.chatId) !== actor || context?.chatType !== "private" ||
    !context?.runtime ||
    env?.AI_PARTNER_OWNER_CONFIRMATION_UX_ENABLED !== "true" ||
    env?.AI_PARTNER_OWNER_WRITE_TOOLS_ENABLED !== "true") {
    throw rejection("ai_partner_confirmation_owner_only");
  }
  return actor;
}

function action(chatId, text, rows = []) {
  if (String(text).length > 3_800) throw rejection("ai_partner_confirmation_message_long");
  for (const row of rows) for (const button of row) {
    if (encoder.encode(button.callback_data).length > 64) {
      throw rejection("ai_partner_confirmation_callback_long");
    }
  }
  return Object.freeze({
    method: "sendMessage",
    payload: {
      chat_id: chatId,
      text,
      reply_markup: { inline_keyboard: rows },
    },
  });
}

function button(text, callbackData) {
  return { text, callback_data: callbackData };
}

async function lookupIntent(env, owner, token) {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  const tokenHash = [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  return env.DB.prepare(
    `SELECT intent.intent_id, intent.action_type, intent.intent_state,
            session.generation_id, session.generation_state
     FROM ai_partner_write_intents intent
     LEFT JOIN ai_generation_sessions session
       ON session.version_request_id = 'a138wr:' || intent.intent_id
       AND session.owner_telegram_id = intent.owner_telegram_id
     WHERE intent.owner_telegram_id = ?
       AND intent.confirmation_token_hash = ?`,
  ).bind(owner, tokenHash).first();
}

export async function handleOwnerConfirmedWriteCallback(env, context, callbackData, at) {
  const owner = ownerContext(env, context);
  const parsed = String(callbackData || "").match(TOKEN);
  if (!parsed) throw rejection("ai_partner_confirmation_callback_invalid");
  const [, operation, confirmationToken] = parsed;
  const intent = await lookupIntent(env, owner, confirmationToken);
  if (!intent || (intent.action_type === "save_own_draft" && !intent.generation_id)) {
    throw rejection("ai_partner_confirmation_intent_denied");
  }
  if (intent.generation_id &&
    !["finalizing", "completed"].includes(intent.generation_state)) {
    throw rejection("ai_partner_confirmation_session_invalid");
  }
  if (operation === "cancel") {
    await cancelOwnerConfirmedDraftWrite(env, {
      actorTelegramId: owner, confirmationToken, at,
    });
    if (intent.generation_id) {
      await failAiPartnerGenerationSession(env, context.runtime, {
        generationId: intent.generation_id,
        failureCode: "owner_confirmation_cancelled",
        actionKey: `owner-confirmation-cancel:${intent.intent_id}`,
        failedAt: at,
      });
    }
    return Object.freeze({
      ...action(owner, "❌ Сохранение отменено. Черновик и версия не созданы.",
        [[button("⬅️ К RE AI", "a38o:hub")]]),
      cancelled: true,
    });
  }
  const saved = await consumeOwnerConfirmedDraftWrite(env, {
    actorTelegramId: owner, confirmationToken, at,
  });
  if (intent.generation_id) {
    await completeAiPartnerGenerationSession(env, context.runtime, {
      generationId: intent.generation_id, output: null, completedAt: at,
    });
  }
  let preview;
  try {
    preview = await renderAiPartnerOwnerDraftPreview(env, context, {
      draftId: saved.draftId, versionNo: saved.versionNo,
    });
  } catch {
    preview = { envelope: action(owner,
      `✅ Черновик сохранён, версия ${saved.versionNo}. Откройте «Мои черновики».`,
      [[button("📝 Мои черновики", "a38p:drafts:0")]]) };
  }
  return Object.freeze({
    ...preview.envelope,
    savedVersion: Object.freeze({ draftId: saved.draftId, versionNo: saved.versionNo }),
  });
}

async function memoryScreen(env, owner, at) {
  const state = await readOwnerMemoryState(env, { actorTelegramId: owner, at });
  const rows = state.enabled ? [
    [button("📝 Последние записи", "a38m:list")],
    [button("🧹 Очистить", "a38m:clear"), button("⛔ Выключить", "a38m:revoke")],
  ] : state.available ? [
    [button("✅ Включить память", "a38m:grant")],
  ] : [];
  rows.push([button("⬅️ К RE AI", "a38o:hub")]);
  return action(owner,
    `🧠 Память RE AI: ${state.enabled ? "включена" : "выключена"}.\n` +
    `Записей: ${state.exchanges}/${state.limit}. Хранение до 30 дней.\n` +
    "Включение требует отдельного согласия. Запись разговоров в модель пока не подключена.",
    rows);
}

export async function handleOwnerMemoryCallback(env, context, callbackData, at) {
  const owner = ownerContext(env, context);
  const parsed = String(callbackData || "").match(MEMORY);
  if (!parsed) throw rejection("ai_partner_memory_callback_invalid");
  const choice = parsed[1];
  if (choice === "grant") return action(owner,
    "🧠 Включить память? Бот сможет хранить до пяти коротких сводок не дольше 30 дней. Вы сможете очистить их или выключить память в любой момент.",
    [[button("✅ Да, разрешаю", "a38m:grant_ok")],
      [button("⬅️ Назад", "a38m:show")]]);
  if (choice === "clear") return action(owner,
    "🧹 Удалить все короткие сводки из памяти?",
    [[button("✅ Удалить", "a38m:clear_ok")],
      [button("⬅️ Назад", "a38m:show")]]);
  if (choice === "grant_ok") {
    await setOwnerMemoryConsent(env, { actorTelegramId: owner, enabled: true, at });
  } else if (choice === "revoke") {
    await setOwnerMemoryConsent(env, { actorTelegramId: owner, enabled: false, at });
  } else if (choice === "clear_ok") {
    await clearOwnerMemoryExchanges(env, { actorTelegramId: owner, at });
  }
  // One item per page keeps even five 800-char pairs within Telegram's limit.
  if (choice.startsWith("list")) {
    const page = Number(choice.split(":")[1] || 0);
    const list = await listOwnerMemoryExchanges(env, { actorTelegramId: owner, at });
    if (page >= list.length && page !== 0) {
      throw rejection("ai_partner_memory_page_invalid");
    }
    const item = list[page];
    const rows = [];
    if (page > 0) rows.push(button("⬅️", `a38m:list:${page - 1}`));
    if (page + 1 < list.length) rows.push(button("➡️", `a38m:list:${page + 1}`));
    return action(owner,
      item
        ? `🧠 Короткая сводка ${page + 1}/${list.length}\n\nВы: ${item.userSummary}\nRE AI: ${item.assistantSummary}`
        : "🧠 Сохранённых сводок нет.",
      [...(rows.length ? [rows] : []), [button("⬅️ К памяти", "a38m:show")]]);
  }
  return memoryScreen(env, owner, at);
}

export async function clearExpiredOwnerConfirmations(env, context, at) {
  const owner = ownerContext(env, context);
  const result = await expireOwnerPreparedDraftWrites(env, {
    actorTelegramId: owner, at,
  });
  // A Worker can stop after D1 commits the version and before it binds the
  // generation. Recover from the immutable saved version on the next update.
  const saved = await env.DB.prepare(
    `SELECT session.generation_id FROM ai_generation_sessions session
     JOIN ai_partner_write_intents intent
       ON session.version_request_id = 'a138wr:' || intent.intent_id
     JOIN ai_draft_versions version
       ON version.request_id = session.version_request_id
     WHERE session.owner_telegram_id = ?
       AND session.generation_state = 'finalizing'
       AND intent.intent_state = 'consumed'`,
  ).bind(owner).all();
  for (const row of saved.results) {
    await completeAiPartnerGenerationSession(env, context.runtime, {
      generationId: row.generation_id, output: null, completedAt: at,
    });
  }
  // Expired confirmations must release the one-active-generation session.
  const expired = await env.DB.prepare(
    `SELECT session.generation_id, intent.intent_id, intent.intent_state
     FROM ai_generation_sessions session
     LEFT JOIN ai_partner_write_intents intent
       ON session.version_request_id = 'a138wr:' || intent.intent_id
     WHERE session.owner_telegram_id = ?
       AND session.generation_state = 'finalizing'
       AND (intent.intent_state IN ('expired', 'cancelled') OR
         (intent.intent_id IS NULL AND session.updated_at <= ?))`,
  ).bind(owner, at - 600).all();
  for (const row of expired.results) {
    await failAiPartnerGenerationSession(env, context.runtime, {
      generationId: row.generation_id,
      failureCode: row.intent_state === "cancelled"
        ? "owner_confirmation_cancelled" : "owner_confirmation_expired",
      actionKey: `owner-confirmation-expired:${row.intent_id || row.generation_id}`,
      failedAt: at,
    });
  }
  return result;
}
