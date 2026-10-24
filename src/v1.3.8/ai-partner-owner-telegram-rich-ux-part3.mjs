import {inheritRuntimeContext} from '../v1.4.1/runtime-binding.mjs';
import {
  generateAiPartnerOwnerDraft,
  listAiPartnerOwnerDraftFormats,
  listAiPartnerOwnerOffers,
} from "./ai-partner-owner-generation-core-part2.mjs";
import {
  beginAiPartnerGenerationSession,
  buildAiPartnerTelegramCallback,
  cancelAiPartnerShareConfirmation,
  consumeAiPartnerShareConfirmation,
  createAiPartnerContextFromVerifiedUpdate,
  parseAiPartnerTelegramCallback,
  prepareAiPartnerShareConfirmation,
  readAiPartnerDraftPreview,
  readAiPartnerEditDescriptor,
  readAiPartnerGenerationSession,
  renderAiPartnerDraftPreview,
  renderAiPartnerGenerationState,
  renderAiPartnerShareConfirmation,
  retryAiPartnerGenerationSession,
  saveAiPartnerEditedDraftVersion,
  stopAiPartnerGenerationSession,
} from "./ai-partner-telegram-ux.mjs";
import {
  createAiPartnerProviderTransports,
  preserveAiProviderTerminalOutcome,
} from "./ai-partner-provider-transports.mjs";
import {
  assertAiPartnerOwnerPart4Policy,
  createAiPartnerOwnerPart4ProviderTransports,
  preserveAiPartnerStreamTerminalOutcome,
} from "./ai-partner-owner-security-cost-fallback-part4.mjs";

export const AI_PARTNER_OWNER_TELEGRAM_RICH_UX_VERSION =
  "1.3.8-owner-telegram-rich-ux-part3";

export const AI_PARTNER_OWNER_TELEGRAM_RICH_UX_LIMITS = Object.freeze({
  callbackBytes: 64,
  offersPerPage: 5,
  draftsPerPage: 5,
  versionsPerPage: 6,
  editTokenTtlSeconds: 600,
  editPayloadCharacters: 12_000,
  progressiveChunkCharacters: 180,
  maximumProgressActions: 24,
  preparedMessageCharacters: 4_000,
});

const CALLBACK_PREFIX = "a38p";
const TEXT_ENCODER = new TextEncoder();
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EDIT_TOKEN = /^a38e\.([A-Za-z0-9_-]{20,220})\.([A-Za-z0-9_-]{22})$/;
const FORMAT_CODES = Object.freeze({
  tp: "telegram_post",
  pm: "private_message",
  sc: "short_card",
  pi: "promotion_idea",
  sv: "short_video_script",
  oe: "offer_explanation",
});
const FORMAT_CODE_BY_TYPE = Object.freeze(
  Object.fromEntries(Object.entries(FORMAT_CODES).map(([code, value]) => [value, code])),
);
const FORMAT_LABELS = Object.freeze({
  telegram_post: "📣 Telegram-пост",
  private_message: "💬 Личное сообщение",
  short_card: "🪪 Короткая карточка",
  promotion_idea: "💡 Идея продвижения",
  short_video_script: "🎬 Shorts / Reels",
  offer_explanation: "📘 Объяснение оффера",
});
const DEFAULT_PROMPTS = Object.freeze({
  telegram_post:
    "Подготовь спокойный Telegram-пост по утверждённым условиям оффера. Не обещай гарантированный результат и не добавляй неподтверждённые факты.",
  private_message:
    "Подготовь короткое личное сообщение по утверждённым условиям оффера без давления, спама и гарантий результата.",
  short_card:
    "Подготовь компактную карточку оффера только по утверждённым данным, с понятным нейтральным призывом проверить условия.",
  promotion_idea:
    "Предложи безопасную идею продвижения оффера без массовой рассылки, автоматической публикации и выдуманных обещаний.",
  short_video_script:
    "Подготовь сценарий короткого видео по утверждённым условиям оффера без гарантированной доходности и неподтверждённых заявлений.",
  offer_explanation:
    "Объясни утверждённые условия оффера простыми словами, отделяя проверенные факты от общего пояснения.",
});
const ALLOWED_CONTEXT_FIELDS = new Set([
  "actorTelegramId",
  "chatId",
  "chatType",
  "updateId",
  "callbackQueryId",
  "capabilities",
]);
const ALLOWED_CAPABILITIES = new Set([
  "richMessages",
  "messageDrafts",
  "richMessageDrafts",
  "disabledButtons",
  "preparedInlineMessages",
  "ephemeralUi",
]);
const ALLOWED_START_FIELDS = new Set([
  "offerFactSourceId",
  "draftType",
  "operationSeed",
  "at",
]);
const ALLOWED_EXECUTE_FIELDS = new Set([
  "generationId",
  "at",
]);
const ALLOWED_EDIT_FIELDS = new Set([
  "draftId",
  "versionNo",
  "at",
]);
const ALLOWED_EDIT_REPLY_FIELDS = new Set([
  "editToken",
  "replyText",
  "at",
]);
const ALLOWED_SHARE_FIELDS = new Set([
  "draftId",
  "versionNo",
  "at",
  "confirmationToken",
]);
const ALLOWED_CONSUME_SHARE_FIELDS = new Set([
  "confirmationToken",
  "at",
]);
const ALLOWED_LIST_FIELDS = new Set(["page", "at"]);

function uxError(code, cause = null) {
  const error = new Error("AI Partner owner Telegram Rich UX rejected");
  error.name = "AiPartnerOwnerTelegramRichUxError";
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function plainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactFields(value, allowed, invalidCode, deniedCode) {
  if (!plainObject(value)) throw uxError(invalidCode);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw uxError(deniedCode);
  }
  return value;
}

function positiveInteger(value, code, { allowZero = false, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed > maximum ||
    (allowZero ? parsed < 0 : parsed <= 0)
  ) {
    throw uxError(code);
  }
  return parsed;
}

function normalizeClock(value = Math.floor(Date.now() / 1_000)) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_600_000_000 || parsed > 9_999_999_999) {
    throw uxError("ai_partner_owner_telegram_clock_invalid");
  }
  return parsed;
}

function normalizeUuid(value, code) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!UUID_V4.test(normalized)) throw uxError(code);
  return normalized;
}

function normalizePage(value = 0) {
  return positiveInteger(value, "ai_partner_owner_telegram_page_invalid", {
    allowZero: true,
    maximum: 9_999,
  });
}

function normalizeFormat(value) {
  const normalized = String(value || "").trim();
  if (!Object.hasOwn(FORMAT_CODE_BY_TYPE, normalized)) {
    throw uxError("ai_partner_owner_telegram_format_invalid");
  }
  return normalized;
}

function normalizeFormatCode(value) {
  const code = String(value || "").trim().toLowerCase();
  if (!Object.hasOwn(FORMAT_CODES, code)) {
    throw uxError("ai_partner_owner_telegram_format_invalid");
  }
  return code;
}

function requireDatabase(env) {
  if (!env?.DB?.prepare || !env?.DB?.batch) {
    throw uxError("ai_partner_owner_telegram_database_not_ready");
  }
  return env.DB;
}

function requireOwnerId(env, actorTelegramId) {
  const actor = positiveInteger(actorTelegramId, "ai_partner_owner_telegram_actor_invalid");
  const admin = positiveInteger(env?.ADMIN_ID, "ai_partner_owner_telegram_admin_invalid");
  if (actor !== admin) throw uxError("ai_partner_owner_telegram_owner_only");
  return actor;
}

function normalizeCapabilities(value = {}) {
  exactFields(
    value,
    ALLOWED_CAPABILITIES,
    "ai_partner_owner_telegram_capabilities_invalid",
    "ai_partner_owner_telegram_capability_denied",
  );
  return deepFreeze({
    richMessages: value.richMessages === true,
    messageDrafts: value.messageDrafts !== false,
    richMessageDrafts: value.richMessageDrafts === true,
    disabledButtons: value.disabledButtons === true,
    preparedInlineMessages: value.preparedInlineMessages === true,
    ephemeralUi: value.ephemeralUi === true,
  });
}

function ownerUiEnv(env) {
  return inheritRuntimeContext(env,Object.freeze({
    ...env,
    AI_PARTNER_EXTERNAL_PROVIDER_ENABLED: "false",
    AI_PARTNER_RICH_MESSAGES_ENABLED: "true",
  }));
}

function runtimeWithCallback(env, context, purpose = "internal") {
  if (context?.runtime?.callbackQueryId) return context.runtime;
  const suffix = String(purpose || "internal")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .slice(0, 40);
  return createAiPartnerContextFromVerifiedUpdate(ownerUiEnv(env), {
    actorTelegramId: context.actorTelegramId,
    updateId: context.updateId,
    callbackQueryId: `a38p_${suffix}_${context.updateId}`,
    chatType: "private",
    isAdmin: true,
  });
}

export function createAiPartnerOwnerTelegramContext(env, input = {}) {
  exactFields(
    input,
    ALLOWED_CONTEXT_FIELDS,
    "ai_partner_owner_telegram_context_invalid",
    "ai_partner_owner_telegram_context_field_denied",
  );
  requireDatabase(env);
  const owner = requireOwnerId(env, input.actorTelegramId);
  const chatId = positiveInteger(input.chatId, "ai_partner_owner_telegram_chat_invalid");
  const chatType = String(input.chatType || "private").trim().toLowerCase();
  if (chatType !== "private" || chatId !== owner) {
    throw uxError("ai_partner_owner_telegram_private_chat_required");
  }
  const updateId = positiveInteger(
    input.updateId,
    "ai_partner_owner_telegram_update_invalid",
    { allowZero: true },
  );
  const callbackQueryId = input.callbackQueryId === undefined
    ? null
    : input.callbackQueryId;
  const runtime = createAiPartnerContextFromVerifiedUpdate(ownerUiEnv(env), {
    actorTelegramId: owner,
    updateId,
    callbackQueryId,
    chatType,
    isAdmin: true,
  });
  return deepFreeze({
    actorTelegramId: owner,
    chatId,
    chatType,
    updateId,
    callbackQueryId,
    capabilities: normalizeCapabilities(input.capabilities || {}),
    runtime,
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function truncate(value, maximum) {
  const text = String(value || "").trim();
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function button(text, callbackData, { disabled = false, style = null } = {}) {
  const label = truncate(text, 64);
  if (!label) throw uxError("ai_partner_owner_telegram_button_invalid");
  if (disabled) {
    const value = { text: label, disabled: {} };
    if (style) value.style = style;
    return Object.freeze(value);
  }
  const data = String(callbackData || "");
  if (!data || TEXT_ENCODER.encode(data).byteLength > AI_PARTNER_OWNER_TELEGRAM_RICH_UX_LIMITS.callbackBytes) {
    throw uxError("ai_partner_owner_telegram_callback_invalid");
  }
  const value = { text: label, callback_data: data };
  if (style) value.style = style;
  return Object.freeze(value);
}

function callback(action, payload = {}) {
  let value;
  switch (action) {
    case "hub":
      value = `${CALLBACK_PREFIX}:hub`;
      break;
    case "offers":
      value = `${CALLBACK_PREFIX}:offers:${normalizePage(payload.page)}`;
      break;
    case "offer":
      value = `${CALLBACK_PREFIX}:offer:${normalizeUuid(payload.offerId, "ai_partner_owner_telegram_offer_invalid")}`;
      break;
    case "generate":
      value = `${CALLBACK_PREFIX}:gen:${normalizeUuid(payload.offerId, "ai_partner_owner_telegram_offer_invalid")}:${normalizeFormatCode(payload.formatCode)}`;
      break;
    case "drafts":
      value = `${CALLBACK_PREFIX}:drafts:${normalizePage(payload.page)}`;
      break;
    case "history":
      value = `${CALLBACK_PREFIX}:hist:${normalizeUuid(payload.draftId, "ai_partner_owner_telegram_draft_invalid")}:${normalizePage(payload.page)}`;
      break;
    default:
      throw uxError("ai_partner_owner_telegram_callback_action_denied");
  }
  if (TEXT_ENCODER.encode(value).byteLength > AI_PARTNER_OWNER_TELEGRAM_RICH_UX_LIMITS.callbackBytes) {
    throw uxError("ai_partner_owner_telegram_callback_too_large");
  }
  return value;
}

export function parseAiPartnerOwnerTelegramCallback(value) {
  const text = String(value || "");
  if (!text || TEXT_ENCODER.encode(text).byteLength > AI_PARTNER_OWNER_TELEGRAM_RICH_UX_LIMITS.callbackBytes) {
    throw uxError("ai_partner_owner_telegram_callback_invalid");
  }
  if (text === `${CALLBACK_PREFIX}:hub`) return deepFreeze({ action: "hub" });
  let match = text.match(/^a38p:offers:(\d{1,4})$/);
  if (match) return deepFreeze({ action: "offers", page: normalizePage(match[1]) });
  match = text.match(/^a38p:offer:([0-9a-f-]{36})$/i);
  if (match) return deepFreeze({
    action: "offer",
    offerId: normalizeUuid(match[1], "ai_partner_owner_telegram_offer_invalid"),
  });
  match = text.match(/^a38p:gen:([0-9a-f-]{36}):(tp|pm|sc|pi|sv|oe)$/i);
  if (match) return deepFreeze({
    action: "generate",
    offerId: normalizeUuid(match[1], "ai_partner_owner_telegram_offer_invalid"),
    draftType: FORMAT_CODES[normalizeFormatCode(match[2])],
  });
  match = text.match(/^a38p:drafts:(\d{1,4})$/);
  if (match) return deepFreeze({ action: "drafts", page: normalizePage(match[1]) });
  match = text.match(/^a38p:hist:([0-9a-f-]{36}):(\d{1,4})$/i);
  if (match) return deepFreeze({
    action: "history",
    draftId: normalizeUuid(match[1], "ai_partner_owner_telegram_draft_invalid"),
    page: normalizePage(match[2]),
  });
  throw uxError("ai_partner_owner_telegram_callback_action_denied");
}

function telegramEnvelope({
  context,
  kind,
  text,
  keyboard = [],
  richHtml = null,
  ephemeral = false,
}) {
  const payload = {
    chat_id: context.chatId,
    text: String(text || ""),
    reply_markup: { inline_keyboard: keyboard },
  };
  if (ephemeral && context.capabilities.ephemeralUi && context.callbackQueryId) {
    payload.ephemeral_message_parameters = {
      callback_query_id: context.callbackQueryId,
      replace_callback_query_message: true,
    };
  }
  const rich = context.capabilities.richMessages && richHtml
    ? {
        method: "sendRichMessage",
        payload: {
          chat_id: context.chatId,
          rich_message: { html: richHtml },
          reply_markup: { inline_keyboard: keyboard },
          ...(payload.ephemeral_message_parameters
            ? { ephemeral_message_parameters: payload.ephemeral_message_parameters }
            : {}),
        },
      }
    : null;
  return deepFreeze({
    kind,
    preferred: rich || { method: "sendMessage", payload },
    fallback: { method: "sendMessage", payload },
  });
}

function offerLabel(offer, index) {
  const subject = truncate(offer.subjectKey || `Оффер ${index + 1}`, 42);
  const visibility = offer.visibility === "private" ? "🔒" : "🌐";
  return `${visibility} ${subject}`;
}

export async function renderAiPartnerOwnerHub(env, context) {
  requireOwnerId(env, context?.actorTelegramId);
  const offers = await listAiPartnerOwnerOffers(ownerUiEnv(env), {
    actorTelegramId: context.actorTelegramId,
    generatedAt: Math.floor(Date.now() / 1_000),
  });
  const draftCount = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM ai_drafts
     WHERE owner_telegram_id = ? AND draft_state IN ('draft', 'archived')`,
  ).bind(context.actorTelegramId).first();
  const keyboard = [];
  if (offers.offers.length) {
    keyboard.push([
      button("🎯 Выбрать оффер", callback("offers", { page: 0 }), { style: "primary" }),
    ]);
  } else if (context.capabilities.disabledButtons) {
    keyboard.push([
      button("Офферы пока недоступны", null, { disabled: true, style: "primary" }),
    ]);
  }
  keyboard.push([button("📝 Мои черновики", callback("drafts", { page: 0 }))]);
  const body =
    "🤖 RE AI Partner\n\n" +
    "Генератор проверяемых рекламных черновиков. Ничего не публикуется и не отправляется без вашего отдельного действия.\n\n" +
    `Доступных approved-офферов: ${offers.offers.length}.\n` +
    `Черновиков: ${Number(draftCount?.total || 0)}.`;
  return telegramEnvelope({
    context,
    kind: "ai_partner_owner_hub",
    text: body,
    richHtml:
      `<b>🤖 RE AI Partner</b><br><br>` +
      "Генератор проверяемых рекламных черновиков. Ничего не публикуется и не отправляется без вашего отдельного действия.<br><br>" +
      `Доступных approved-офферов: <b>${offers.offers.length}</b>.<br>` +
      `Черновиков: <b>${Number(draftCount?.total || 0)}</b>.`,
    keyboard,
    ephemeral: true,
  });
}

export async function renderAiPartnerOwnerOfferPage(
  env,
  context,
  input = {},
) {
  exactFields(
    input,
    ALLOWED_LIST_FIELDS,
    "ai_partner_owner_telegram_offer_page_invalid",
    "ai_partner_owner_telegram_offer_page_field_denied",
  );
  const page = normalizePage(input.page || 0);
  const at = normalizeClock(input.at);
  const catalog = await listAiPartnerOwnerOffers(ownerUiEnv(env), {
    actorTelegramId: context.actorTelegramId,
    generatedAt: at,
  });
  const start = page * AI_PARTNER_OWNER_TELEGRAM_RICH_UX_LIMITS.offersPerPage;
  const offers = catalog.offers.slice(
    start,
    start + AI_PARTNER_OWNER_TELEGRAM_RICH_UX_LIMITS.offersPerPage,
  );
  if (!offers.length && page > 0) {
    throw uxError("ai_partner_owner_telegram_offer_page_empty");
  }
  const keyboard = offers.map((offer, index) => [
    button(
      offerLabel(offer, start + index),
      callback("offer", { offerId: offer.factSourceId }),
    ),
  ]);
  const navigation = [];
  if (page > 0) navigation.push(
    button("⬅️", callback("offers", { page: page - 1 })),
  );
  if (start + offers.length < catalog.offers.length) navigation.push(
    button("➡️", callback("offers", { page: page + 1 })),
  );
  if (navigation.length) keyboard.push(navigation);
  keyboard.push([button("⬅️ К RE AI", callback("hub"))]);
  const lines = offers.map((offer, index) =>
    `${start + index + 1}. ${offer.visibility === "private" ? "Приватный" : "Публичный"} · ${offer.subjectKey}`,
  );
  return telegramEnvelope({
    context,
    kind: "ai_partner_owner_offer_page",
    text:
      `🎯 Approved-офферы · страница ${page + 1}\n\n` +
      (lines.join("\n") || "Подходящих офферов пока нет."),
    richHtml:
      `<b>🎯 Approved-офферы · страница ${page + 1}</b><br><br>` +
      (lines.map(escapeHtml).join("<br>") || "Подходящих офферов пока нет."),
    keyboard,
    ephemeral: true,
  });
}

export async function renderAiPartnerOwnerFormatPicker(
  env,
  context,
  { offerFactSourceId, at = Math.floor(Date.now() / 1_000) } = {},
) {
  const offerId = normalizeUuid(
    offerFactSourceId,
    "ai_partner_owner_telegram_offer_invalid",
  );
  const catalog = await listAiPartnerOwnerOffers(ownerUiEnv(env), {
    actorTelegramId: context.actorTelegramId,
    generatedAt: normalizeClock(at),
  });
  const offer = catalog.offers.find((item) => item.factSourceId === offerId);
  if (!offer) throw uxError("ai_partner_owner_telegram_offer_denied");
  const formats = listAiPartnerOwnerDraftFormats();
  const keyboard = formats.map((format) => [
    button(
      FORMAT_LABELS[format.draftType],
      callback("generate", {
        offerId,
        formatCode: FORMAT_CODE_BY_TYPE[format.draftType],
      }),
    ),
  ]);
  keyboard.push([button("⬅️ К офферам", callback("offers", { page: 0 }))]);
  return telegramEnvelope({
    context,
    kind: "ai_partner_owner_format_picker",
    text:
      `🧩 Формат черновика\n\nОффер: ${offer.subjectKey}\n` +
      "Выберите один из шести форматов. Модель, provider, tools и кеш выбирает только сервер.",
    richHtml:
      `<b>🧩 Формат черновика</b><br><br>` +
      `Оффер: <b>${escapeHtml(offer.subjectKey)}</b><br>` +
      "Выберите один из шести форматов. Модель, provider, tools и кеш выбирает только сервер.",
    keyboard,
    ephemeral: true,
  });
}

async function sha256(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw uxError("ai_partner_owner_telegram_crypto_unavailable");
  const digest = await cryptoImpl.subtle.digest(
    "SHA-256",
    TEXT_ENCODER.encode(String(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64UrlEncode(value) {
  const bytes = value instanceof Uint8Array
    ? value
    : TEXT_ENCODER.encode(String(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = typeof btoa === "function"
    ? btoa(binary)
    : globalThis.Buffer?.from(bytes)?.toString("base64");
  if (!encoded) throw uxError("ai_partner_owner_telegram_base64_unavailable");
  return encoded.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value) {
  const text = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = text + "=".repeat((4 - (text.length % 4 || 4)) % 4);
  const binary = typeof atob === "function"
    ? atob(padded)
    : globalThis.Buffer?.from(padded, "base64")?.toString("binary");
  if (binary === undefined) throw uxError("ai_partner_owner_telegram_base64_unavailable");
  return new Uint8Array([...binary].map((character) => character.charCodeAt(0)));
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function operationKey({ owner, updateId, offerId, draftType, operationSeed = "" }, cryptoImpl) {
  const seed = String(operationSeed || "").trim();
  if (seed.length > 80 || /[\u0000-\u001f]/u.test(seed)) {
    throw uxError("ai_partner_owner_telegram_operation_seed_invalid");
  }
  const digest = await sha256(canonicalJson({
    version: AI_PARTNER_OWNER_TELEGRAM_RICH_UX_VERSION,
    owner,
    updateId,
    offerId,
    draftType,
    seed,
  }), cryptoImpl);
  return `tg38:${digest.slice(0, 32)}`;
}

function generationKeys(owner, key) {
  return Object.freeze({
    generationKey: `a138gen:${owner}:${key}`,
    draftRequestKey: `a138draft:${owner}:${key}`,
    versionRequestId: `a138ver:${owner}:${key}`,
  });
}

async function telegramDraftId(generationId, cryptoImpl) {
  const digest = await sha256(generationId, cryptoImpl);
  return (Number.parseInt(digest.slice(0, 8), 16) % 2_147_483_646) + 1;
}

function draftAction(context, {
  draftId,
  text = "",
  richHtml = null,
  canStop = true,
  keepOnStop = false,
}) {
  if (!context.capabilities.messageDrafts) {
    return deepFreeze({
      method: "sendMessage",
      payload: {
        chat_id: context.chatId,
        text: text || "Готовлю проверяемый черновик…",
      },
      fallback: true,
    });
  }
  if (context.capabilities.richMessageDrafts && richHtml !== null) {
    return deepFreeze({
      method: "sendRichMessageDraft",
      payload: {
        chat_id: context.chatId,
        draft_id: draftId,
        rich_message: { html: richHtml },
        can_stop: canStop,
        keep_on_stop: keepOnStop,
      },
      fallback: {
        method: "sendMessageDraft",
        payload: {
          chat_id: context.chatId,
          draft_id: draftId,
          text,
          can_stop: canStop,
          keep_on_stop: keepOnStop,
        },
      },
    });
  }
  return deepFreeze({
    method: "sendMessageDraft",
    payload: {
      chat_id: context.chatId,
      draft_id: draftId,
      text,
      can_stop: canStop,
      keep_on_stop: keepOnStop,
    },
  });
}

export async function prepareAiPartnerOwnerTelegramGeneration(
  env,
  context,
  input = {},
  dependencies = {},
) {
  exactFields(
    input,
    ALLOWED_START_FIELDS,
    "ai_partner_owner_telegram_generation_input_invalid",
    "ai_partner_owner_telegram_generation_field_denied",
  );
  const owner = requireOwnerId(env, context?.actorTelegramId);
  const at = normalizeClock(input.at);
  const offerId = normalizeUuid(
    input.offerFactSourceId,
    "ai_partner_owner_telegram_offer_invalid",
  );
  const draftType = normalizeFormat(input.draftType);
  const cryptoImpl = dependencies.cryptoImpl || globalThis.crypto;
  const catalog = await listAiPartnerOwnerOffers(ownerUiEnv(env), {
    actorTelegramId: owner,
    generatedAt: at,
  });
  const offer = catalog.offers.find((item) => item.factSourceId === offerId);
  if (!offer) throw uxError("ai_partner_owner_telegram_offer_denied");
  const key = await operationKey({
    owner,
    updateId: context.updateId,
    offerId,
    draftType,
    operationSeed: input.operationSeed,
  }, cryptoImpl);
  const title = truncate(`${FORMAT_LABELS[draftType]} · ${offer.subjectKey}`, 160);
  const prompt = DEFAULT_PROMPTS[draftType];
  const keys = generationKeys(owner, key);
  const session = await beginAiPartnerGenerationSession(
    ownerUiEnv(env),
    context.runtime,
    {
      generationKey: keys.generationKey,
      draftRequestKey: keys.draftRequestKey,
      versionRequestId: keys.versionRequestId,
      draftType,
      title,
      prompt,
      factSourceIds: [offerId],
      startedAt: at,
      idFactory: dependencies.idFactory,
      cryptoImpl,
    },
  );
  const telegramId = await telegramDraftId(session.generationId, cryptoImpl);
  return deepFreeze({
    ownerTelegramId: owner,
    operationKey: key,
    offer,
    draftType,
    title,
    prompt,
    generationId: session.generationId,
    telegramDraftId: telegramId,
    session,
    initialAction: draftAction(context, {
      draftId: telegramId,
      text: "Готовлю проверяемый черновик…",
      richHtml: "<tg-thinking>Готовлю проверяемый черновик…</tg-thinking>",
      canStop: true,
      keepOnStop: false,
    }),
  });
}

function parseOperationKey(generationKey) {
  const match = String(generationKey || "").match(/^a138gen:\d+:(tg38:[0-9a-f]{32})$/);
  if (!match) throw uxError("ai_partner_owner_telegram_operation_key_missing");
  return match[1];
}

function chunkText(value, chunkSize) {
  const text = String(value || "");
  if (!text) return [];
  const chunks = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + chunkSize));
    offset += chunkSize;
  }
  return chunks;
}

async function emitValidatedProgress({
  context,
  telegramId,
  content,
  actions,
  emit,
}) {
  if (!context.capabilities.messageDrafts) {
    return deepFreeze({ actions });
  }
  const chunks = chunkText(
    content,
    AI_PARTNER_OWNER_TELEGRAM_RICH_UX_LIMITS.progressiveChunkCharacters,
  );
  let current = "";
  const maxActions =
    AI_PARTNER_OWNER_TELEGRAM_RICH_UX_LIMITS.maximumProgressActions;
  const stride = Math.max(1, Math.ceil(chunks.length / maxActions));
  for (let index = 0; index < chunks.length; index += 1) {
    current += chunks[index];
    const shouldEmit =
      index === chunks.length - 1 || index % stride === 0;
    if (!shouldEmit) continue;
    const safePreview = truncate(current, 3_200);
    const action = draftAction(context, {
      draftId: telegramId,
      text: safePreview,
      richHtml: `<pre><code>${escapeHtml(safePreview)}</code></pre>`,
      canStop: false,
      keepOnStop: false,
    });
    actions.push(action);
    if (typeof emit === "function") await emit(action);
  }
  return deepFreeze({ actions });
}

function finalPreviewAction(context, result) {
  const keyboard = [[
    button(
      "👁 Открыть черновик",
      buildAiPartnerTelegramCallback("view", {
        draftId: result.draftId,
        versionNo: result.versionNo,
      }),
      { style: "primary" },
    ),
  ], [button("📝 Мои черновики", callback("drafts", { page: 0 }))]];
  return telegramEnvelope({
    context,
    kind: "ai_partner_owner_generation_complete",
    text:
      `✅ Черновик сохранён\n\n${result.content}\n\n` +
      `Версия: ${result.versionNo}. Перед отправкой можно открыть предпросмотр и отредактировать текст.`,
    richHtml:
      `<b>✅ Черновик сохранён</b><br><br>` +
      `${escapeHtml(result.content).replaceAll("\n", "<br>")}<br><br>` +
      `Версия: <b>${result.versionNo}</b>. Перед отправкой можно открыть предпросмотр и отредактировать текст.`,
    keyboard,
  });
}

export async function executeAiPartnerOwnerTelegramGeneration(
  env,
  context,
  input = {},
  dependencies = {},
) {
  exactFields(
    input,
    ALLOWED_EXECUTE_FIELDS,
    "ai_partner_owner_telegram_execute_input_invalid",
    "ai_partner_owner_telegram_execute_field_denied",
  );
  const at = normalizeClock(input.at);
  const generationId = normalizeUuid(
    input.generationId,
    "ai_partner_owner_telegram_generation_invalid",
  );
  const cryptoImpl = dependencies.cryptoImpl || globalThis.crypto;
  const session = await readAiPartnerGenerationSession(
    ownerUiEnv(env),
    context.runtime,
    { generationId },
  );
  const operation = parseOperationKey(session.generationKey);
  const offerId = session.factSourceIds[0];
  const telegramId = await telegramDraftId(generationId, cryptoImpl);
  const actions = [];
  const part4Policy = dependencies.part4Policy
    ? assertAiPartnerOwnerPart4Policy(dependencies.part4Policy, {
        ownerTelegramId: context.actorTelegramId,
        at,
      })
    : null;
  const defaultTransports = part4Policy
    ? createAiPartnerOwnerPart4ProviderTransports(ownerUiEnv(env), {
        policy: part4Policy,
        fetchImpl: dependencies.fetchImpl || globalThis.fetch,
        shouldContinue: async () => {
          const current = await readAiPartnerGenerationSession(
            ownerUiEnv(env),
            context.runtime,
            { generationId },
          );
          return current.state === "streaming";
        },
      })
    : createAiPartnerProviderTransports(ownerUiEnv(env), {
        fetchImpl: dependencies.fetchImpl || globalThis.fetch,
      });
  const baseTransports = dependencies.transports || defaultTransports;
  const generationIsStreaming = async () => {
    const current = await readAiPartnerGenerationSession(
      ownerUiEnv(env),
      context.runtime,
      { generationId },
    );
    return current.state === "streaming";
  };
  const guardedTransport = (transport) => async (...args) => {
    if (!(await generationIsStreaming())) {
      throw uxError("ai_partner_owner_telegram_generation_stopped");
    }
    const response = await transport(...args);
    if (!(await generationIsStreaming())) {
      const error=uxError("ai_partner_owner_telegram_generation_stopped");
      preserveAiProviderTerminalOutcome(error,response);
      preserveAiPartnerStreamTerminalOutcome(error,response);
      throw error;
    }
    return response;
  };
  let result;
  try {
    result = await generateAiPartnerOwnerDraft(
      ownerUiEnv(env),
      {
        actorTelegramId: context.actorTelegramId,
        updateId: context.updateId,
        operationKey: operation,
        offerFactSourceId: offerId,
        draftType: session.draftType,
        title: session.title,
        prompt: DEFAULT_PROMPTS[session.draftType],
        generatedAt: at,
      },
      {
        cryptoImpl,
        idFactory: dependencies.idFactory,
        pricing: dependencies.pricing,
        part4Policy,
        allowTerminalRetry: false,
        shouldContinue: part4Policy
          ? generationIsStreaming
          : null,
        transports: {
          ...baseTransports,
          qwenSafe: guardedTransport(baseTransports.qwenSafe),
          deepseekFlash: part4Policy
            ? guardedTransport(baseTransports.deepseekFlash)
            : async () => {
                throw uxError(
                  "ai_partner_owner_telegram_deepseek_closed_part3",
                );
              },
        },
        timeoutMs: dependencies.timeoutMs,
        monotonicNow: dependencies.monotonicNow,
      },
    );
  } catch (cause) {
    const current = await readAiPartnerGenerationSession(
      ownerUiEnv(env),
      context.runtime,
      { generationId },
    );
    if (current.state === "stopped") {
      const stoppedAction = telegramEnvelope({
        context,
        kind: "ai_partner_owner_generation_stopped",
        text: "⏹ Генерация остановлена. Незавершённый текст не сохранён и не отправлен.",
        richHtml: "<b>⏹ Генерация остановлена</b><br><br>Незавершённый текст не сохранён и не отправлен.",
        keyboard: [[button(
          "🔄 Повторить",
          buildAiPartnerTelegramCallback("retry", { generationId }),
        )]],
      });
      return deepFreeze({
        ok: false,
        status: "stopped",
        generationId,
        progressiveActions: actions,
        finalAction: stoppedAction,
      });
    }
    throw uxError(cause?.code || "ai_partner_owner_telegram_generation_failed", cause);
  }
  if (!result?.ok) {
    return deepFreeze({
      ok: false,
      status: result?.status || "failed",
      reason: result?.reason || "ai_partner_owner_telegram_generation_failed",
      generationId,
      progressiveActions: actions,
      finalAction: renderAiPartnerGenerationState(
        context.runtime,
        await readAiPartnerGenerationSession(ownerUiEnv(env), context.runtime, {
          generationId,
        }),
        { capabilities: context.capabilities },
      ),
    });
  }
  await emitValidatedProgress({
  context,
  telegramId,
  content: result.content,
  actions,
  emit: dependencies.emitDraftAction,
});
  const finalAction = finalPreviewAction(context, result);
  if (typeof dependencies.emitFinalAction === "function") {
    await dependencies.emitFinalAction(finalAction);
  }
  return deepFreeze({
    ok: true,
    status: "saved",
    generationId,
    telegramDraftId: telegramId,
    result,
    progressiveActions: actions,
    finalAction,
  });
}

export async function stopAiPartnerOwnerTelegramGeneration(
  env,
  context,
  {
    generationId,
    at = Math.floor(Date.now() / 1_000),
  } = {},
  dependencies = {},
) {
  const stopped = await stopAiPartnerGenerationSession(
    ownerUiEnv(env),
    context.runtime,
    {
      generationId: normalizeUuid(
        generationId,
        "ai_partner_owner_telegram_generation_invalid",
      ),
      stoppedAt: normalizeClock(at),
      idFactory: dependencies.idFactory,
    },
  );
  return deepFreeze({
    session: stopped,
    action: renderAiPartnerGenerationState(
      context.runtime,
      stopped,
      { capabilities: context.capabilities },
    ),
  });
}

export async function stopAiPartnerOwnerTelegramNativeDraft(
  env,
  context,
  {
    draftId,
    at = Math.floor(Date.now() / 1_000),
  } = {},
  dependencies = {},
) {
  const numericDraftId = positiveInteger(
    draftId,
    "ai_partner_owner_telegram_native_draft_invalid",
    { maximum: 2_147_483_647 },
  );
  const row = await env.DB.prepare(
    `SELECT generation_id
     FROM ai_generation_sessions
     WHERE owner_telegram_id = ? AND generation_state = 'streaming'
     ORDER BY updated_at DESC
     LIMIT 1`,
  ).bind(context.actorTelegramId).first();
  if (!row) throw uxError("ai_partner_owner_telegram_active_generation_missing");
  const expected = await telegramDraftId(
    String(row.generation_id),
    dependencies.cryptoImpl || globalThis.crypto,
  );
  if (expected !== numericDraftId) {
    throw uxError("ai_partner_owner_telegram_native_draft_mismatch");
  }
  return stopAiPartnerOwnerTelegramGeneration(
    env,
    context,
    { generationId: String(row.generation_id), at },
    dependencies,
  );
}

export async function retryAiPartnerOwnerTelegramGeneration(
  env,
  context,
  {
    generationId,
    at = Math.floor(Date.now() / 1_000),
  } = {},
  dependencies = {},
) {
  const retried = await retryAiPartnerGenerationSession(
    ownerUiEnv(env),
    context.runtime,
    {
      generationId: normalizeUuid(
        generationId,
        "ai_partner_owner_telegram_generation_invalid",
      ),
      retriedAt: normalizeClock(at),
      idFactory: dependencies.idFactory,
    },
  );
  return deepFreeze({
    session: retried,
    action: renderAiPartnerGenerationState(
      context.runtime,
      retried,
      { capabilities: context.capabilities },
    ),
  });
}

export async function renderAiPartnerOwnerDraftPage(
  env,
  context,
  input = {},
) {
  exactFields(
    input,
    ALLOWED_LIST_FIELDS,
    "ai_partner_owner_telegram_draft_page_invalid",
    "ai_partner_owner_telegram_draft_page_field_denied",
  );
  const page = normalizePage(input.page || 0);
  const limit = AI_PARTNER_OWNER_TELEGRAM_RICH_UX_LIMITS.draftsPerPage;
  const offset = page * limit;
  const result = await env.DB.prepare(
    `SELECT draft_id, draft_type, draft_state, title, current_version_no,
            updated_at
     FROM ai_drafts
     WHERE owner_telegram_id = ?
     ORDER BY updated_at DESC, draft_id ASC
     LIMIT ? OFFSET ?`,
  ).bind(context.actorTelegramId, limit + 1, offset).all();
  const rows = result?.results || [];
  const hasNext = rows.length > limit;
  const drafts = rows.slice(0, limit);
  if (!drafts.length && page > 0) throw uxError("ai_partner_owner_telegram_draft_page_empty");
  const keyboard = drafts.map((draft) => [
    button(
      `📝 ${truncate(draft.title, 40)} · v${Number(draft.current_version_no)}`,
      buildAiPartnerTelegramCallback("view", {
        draftId: draft.draft_id,
        versionNo: Number(draft.current_version_no),
      }),
    ),
    button(
      "🕘",
      callback("history", { draftId: draft.draft_id, page: 0 }),
    ),
  ]);
  const navigation = [];
  if (page > 0) navigation.push(button("⬅️", callback("drafts", { page: page - 1 })));
  if (hasNext) navigation.push(button("➡️", callback("drafts", { page: page + 1 })));
  if (navigation.length) keyboard.push(navigation);
  keyboard.push([button("⬅️ К RE AI", callback("hub"))]);
  return telegramEnvelope({
    context,
    kind: "ai_partner_owner_drafts",
    text:
      `📝 Мои черновики · страница ${page + 1}\n\n` +
      (drafts.map((draft, index) =>
        `${offset + index + 1}. ${draft.title} · версия ${draft.current_version_no} · ${draft.draft_state}`,
      ).join("\n") || "Черновиков пока нет."),
    richHtml:
      `<b>📝 Мои черновики · страница ${page + 1}</b><br><br>` +
      (drafts.map((draft, index) =>
        `${offset + index + 1}. ${escapeHtml(draft.title)} · версия ${Number(draft.current_version_no)} · ${escapeHtml(draft.draft_state)}`,
      ).join("<br>") || "Черновиков пока нет."),
    keyboard,
    ephemeral: true,
  });
}

export async function renderAiPartnerOwnerHistoryPage(
  env,
  context,
  { draftId, page = 0 } = {},
) {
  const id = normalizeUuid(draftId, "ai_partner_owner_telegram_draft_invalid");
  const normalizedPage = normalizePage(page);
  const draft = await env.DB.prepare(
    `SELECT draft_id, owner_telegram_id, title, current_version_no
     FROM ai_drafts WHERE draft_id = ? LIMIT 1`,
  ).bind(id).first();
  if (!draft || Number(draft.owner_telegram_id) !== context.actorTelegramId) {
    throw uxError("ai_partner_owner_telegram_draft_denied");
  }
  const limit = AI_PARTNER_OWNER_TELEGRAM_RICH_UX_LIMITS.versionsPerPage;
  const offset = normalizedPage * limit;
  const result = await env.DB.prepare(
    `SELECT version_no, version_origin, model_alias, created_at
     FROM ai_draft_versions
     WHERE draft_id = ?
     ORDER BY version_no DESC
     LIMIT ? OFFSET ?`,
  ).bind(id, limit + 1, offset).all();
  const rows = result?.results || [];
  const hasNext = rows.length > limit;
  const versions = rows.slice(0, limit);
  if (!versions.length && normalizedPage > 0) {
    throw uxError("ai_partner_owner_telegram_history_page_empty");
  }
  const keyboard = versions.map((version) => [
    button(
      `Версия ${Number(version.version_no)} · ${version.version_origin}`,
      buildAiPartnerTelegramCallback("view", {
        draftId: id,
        versionNo: Number(version.version_no),
      }),
    ),
  ]);
  const navigation = [];
  if (normalizedPage > 0) navigation.push(button("⬅️", callback("history", {
    draftId: id,
    page: normalizedPage - 1,
  })));
  if (hasNext) navigation.push(button("➡️", callback("history", {
    draftId: id,
    page: normalizedPage + 1,
  })));
  if (navigation.length) keyboard.push(navigation);
  keyboard.push([button("⬅️ К черновикам", callback("drafts", { page: 0 }))]);
  return telegramEnvelope({
    context,
    kind: "ai_partner_owner_history",
    text:
      `🕘 История · ${draft.title}\n\n` +
      versions.map((version) =>
        `v${Number(version.version_no)} · ${version.version_origin} · ${version.model_alias}`,
      ).join("\n"),
    richHtml:
      `<b>🕘 История · ${escapeHtml(draft.title)}</b><br><br>` +
      versions.map((version) =>
        `v${Number(version.version_no)} · ${escapeHtml(version.version_origin)} · ${escapeHtml(version.model_alias)}`,
      ).join("<br>"),
    keyboard,
    ephemeral: true,
  });
}

export async function renderAiPartnerOwnerDraftPreview(
  env,
  context,
  { draftId, versionNo } = {},
) {
  const preview = await readAiPartnerDraftPreview(
    ownerUiEnv(env),
    context.runtime,
    { draftId, versionNo },
  );
  return deepFreeze({
    preview,
    envelope: renderAiPartnerDraftPreview(
      context.runtime,
      preview,
      { capabilities: context.capabilities },
    ),
  });
}

async function hmacSha256(secret, data, cryptoImpl) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw uxError("ai_partner_owner_telegram_edit_secret_invalid");
  }
  const key = await cryptoImpl.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await cryptoImpl.subtle.sign(
    "HMAC",
    key,
    TEXT_ENCODER.encode(data),
  );
  return new Uint8Array(signature);
}

async function issueEditToken(env, { draftId, versionNo, issuedAt }, cryptoImpl) {
  const payload = base64UrlEncode(canonicalJson({
    v: 1,
    d: draftId,
    n: versionNo,
    i: issuedAt,
    e: issuedAt + AI_PARTNER_OWNER_TELEGRAM_RICH_UX_LIMITS.editTokenTtlSeconds,
  }));
  const signature = await hmacSha256(
    String(env.AI_PARTNER_PRIVATE_CACHE_SECRET || ""),
    `a38e\n${payload}`,
    cryptoImpl,
  );
  return `a38e.${payload}.${base64UrlEncode(signature.slice(0, 16))}`;
}

async function verifyEditToken(env, token, at, cryptoImpl) {
  const match = String(token || "").match(EDIT_TOKEN);
  if (!match) throw uxError("ai_partner_owner_telegram_edit_token_invalid");
  const expected = await hmacSha256(
    String(env.AI_PARTNER_PRIVATE_CACHE_SECRET || ""),
    `a38e\n${match[1]}`,
    cryptoImpl,
  );
  const actual = base64UrlDecode(match[2]);
  if (actual.length !== 16) throw uxError("ai_partner_owner_telegram_edit_token_invalid");
  let mismatch = 0;
  for (let index = 0; index < 16; index += 1) {
    mismatch |= actual[index] ^ expected[index];
  }
  if (mismatch !== 0) throw uxError("ai_partner_owner_telegram_edit_token_invalid");
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(match[1])));
  } catch (cause) {
    throw uxError("ai_partner_owner_telegram_edit_token_invalid", cause);
  }
  if (
    !plainObject(payload) ||
    payload.v !== 1 ||
    !UUID_V4.test(String(payload.d || "")) ||
    !Number.isSafeInteger(payload.n) || payload.n < 1 ||
    !Number.isSafeInteger(payload.i) ||
    !Number.isSafeInteger(payload.e) ||
    payload.e !== payload.i + AI_PARTNER_OWNER_TELEGRAM_RICH_UX_LIMITS.editTokenTtlSeconds ||
    at < payload.i || at >= payload.e
  ) {
    throw uxError(
      Number.isSafeInteger(payload?.e) && at >= payload.e
        ? "ai_partner_owner_telegram_edit_token_expired"
        : "ai_partner_owner_telegram_edit_token_invalid",
    );
  }
  return deepFreeze({
    draftId: String(payload.d).toLowerCase(),
    versionNo: payload.n,
    issuedAt: payload.i,
    expiresAt: payload.e,
  });
}

export async function prepareAiPartnerOwnerEditReply(
  env,
  context,
  input = {},
  dependencies = {},
) {
  exactFields(
    input,
    ALLOWED_EDIT_FIELDS,
    "ai_partner_owner_telegram_edit_input_invalid",
    "ai_partner_owner_telegram_edit_field_denied",
  );
  const at = normalizeClock(input.at);
  const descriptor = await readAiPartnerEditDescriptor(
    ownerUiEnv(env),
    context.runtime,
    {
      draftId: input.draftId,
      versionNo: input.versionNo,
    },
  );
  const editToken = await issueEditToken(env, {
    draftId: descriptor.draftId,
    versionNo: descriptor.baseVersionNo,
    issuedAt: at,
  }, dependencies.cryptoImpl || globalThis.crypto);
  const body =
    "✏️ Редактирование черновика\n\n" +
    `Код сессии: ${editToken}\n\n` +
    "Ответьте на это сообщение одним JSON-объектом. Не удаляйте и не изменяйте {{fact:…}}.\n\n" +
    `Шаблон:\n${JSON.stringify(descriptor.templateFields, null, 2)}`;
  return deepFreeze({
    editToken,
    descriptor,
    action: {
      method: "sendMessage",
      payload: {
        chat_id: context.chatId,
        text: truncate(body, 4_000),
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "Отправьте изменённый JSON",
        },
      },
    },
  });
}

export function extractAiPartnerOwnerEditToken(message) {
  const source = String(
    message?.reply_to_message?.text ||
      message?.reply_to_message?.caption ||
      "",
  );
  const match = source.match(/a38e\.[A-Za-z0-9_-]{20,220}\.[A-Za-z0-9_-]{22}/);
  if (!match) throw uxError("ai_partner_owner_telegram_edit_token_missing");
  return match[0];
}

export async function consumeAiPartnerOwnerEditReply(
  env,
  context,
  input = {},
  dependencies = {},
) {
  exactFields(
    input,
    ALLOWED_EDIT_REPLY_FIELDS,
    "ai_partner_owner_telegram_edit_reply_invalid",
    "ai_partner_owner_telegram_edit_reply_field_denied",
  );
  const at = normalizeClock(input.at);
  const token = await verifyEditToken(
    env,
    input.editToken,
    at,
    dependencies.cryptoImpl || globalThis.crypto,
  );
  const replyText = String(input.replyText || "").trim();
  if (!replyText || replyText.length > AI_PARTNER_OWNER_TELEGRAM_RICH_UX_LIMITS.editPayloadCharacters) {
    throw uxError("ai_partner_owner_telegram_edit_payload_invalid");
  }
  let output;
  try {
    output = JSON.parse(replyText);
  } catch (cause) {
    throw uxError("ai_partner_owner_telegram_edit_json_invalid", cause);
  }
  if (!plainObject(output)) throw uxError("ai_partner_owner_telegram_edit_json_invalid");
  const requestHash = await sha256(
    `${input.editToken}\n${canonicalJson(output)}`,
    dependencies.cryptoImpl || globalThis.crypto,
  );
  const editRuntime = runtimeWithCallback(env, context, "edit_reply");
  const stored = await saveAiPartnerEditedDraftVersion(
    ownerUiEnv(env),
    editRuntime,
    {
      draftId: token.draftId,
      baseVersionNo: token.versionNo,
      output,
      requestId: `a38edit:${requestHash.slice(0, 48)}`,
      editedAt: at,
      idFactory: dependencies.idFactory,
      cryptoImpl: dependencies.cryptoImpl || globalThis.crypto,
    },
  );
  const preview = await readAiPartnerDraftPreview(
    ownerUiEnv(env),
    editRuntime,
    { draftId: stored.draftId, versionNo: stored.versionNo },
  );
  return deepFreeze({
    stored,
    preview,
    action: renderAiPartnerDraftPreview(
      editRuntime,
      preview,
      { capabilities: context.capabilities },
    ),
  });
}

export async function prepareAiPartnerOwnerShare(
  env,
  context,
  input = {},
  dependencies = {},
) {
  exactFields(
    input,
    ALLOWED_SHARE_FIELDS,
    "ai_partner_owner_telegram_share_input_invalid",
    "ai_partner_owner_telegram_share_field_denied",
  );
  const at = normalizeClock(input.at);
  const draftId = normalizeUuid(input.draftId, "ai_partner_owner_telegram_draft_invalid");
  const versionNo = positiveInteger(
    input.versionNo,
    "ai_partner_owner_telegram_version_invalid",
    { maximum: 999_999 },
  );
  const intentHash = await sha256(
    canonicalJson({ owner: context.actorTelegramId, draftId, versionNo, at }),
    dependencies.cryptoImpl || globalThis.crypto,
  );
  const intent = await prepareAiPartnerShareConfirmation(
    ownerUiEnv(env),
    context.runtime,
    {
      draftId,
      versionNo,
      intentKey: `a38share:${intentHash.slice(0, 48)}`,
      deliveryKey: `a38delivery:${intentHash.slice(0, 44)}`,
      confirmationToken: input.confirmationToken || null,
      issuedAt: at,
      idFactory: dependencies.idFactory,
      tokenFactory: dependencies.tokenFactory,
      cryptoImpl: dependencies.cryptoImpl || globalThis.crypto,
    },
  );
  return deepFreeze({
    intent,
    action: renderAiPartnerShareConfirmation(
      context.runtime,
      intent,
      { capabilities: context.capabilities },
    ),
  });
}

export async function consumeAiPartnerOwnerShare(
  env,
  context,
  input = {},
  dependencies = {},
) {
  exactFields(
    input,
    ALLOWED_CONSUME_SHARE_FIELDS,
    "ai_partner_owner_telegram_share_consume_invalid",
    "ai_partner_owner_telegram_share_consume_field_denied",
  );
  if (!context.capabilities.preparedInlineMessages) {
    throw uxError("ai_partner_owner_telegram_prepared_messages_disabled");
  }
  const at = normalizeClock(input.at);
  const authorization = await consumeAiPartnerShareConfirmation(
    ownerUiEnv(env),
    context.runtime,
    {
      confirmationToken: input.confirmationToken,
      consumedAt: at,
      cryptoImpl: dependencies.cryptoImpl || globalThis.crypto,
    },
  );
  const preview = await readAiPartnerDraftPreview(
    ownerUiEnv(env),
    context.runtime,
    {
      draftId: authorization.draftId,
      versionNo: authorization.versionNo,
    },
  );
  if (preview.contentHash !== authorization.previewHash) {
    throw uxError("ai_partner_owner_telegram_share_preview_mismatch");
  }
  const resultId = (await sha256(
    authorization.deliveryKey,
    dependencies.cryptoImpl || globalThis.crypto,
  )).slice(0, 32);
  const content = truncate(
    preview.content,
    AI_PARTNER_OWNER_TELEGRAM_RICH_UX_LIMITS.preparedMessageCharacters,
  );
  return deepFreeze({
    authorization,
    preview,
    action: {
      method: "savePreparedInlineMessage",
      payload: {
        user_id: context.actorTelegramId,
        result: {
          type: "article",
          id: resultId,
          title: truncate(preview.title, 64),
          description: "Проверенный черновик RE AI Partner",
          input_message_content: {
            message_text: content,
          },
        },
        allow_user_chats: true,
        allow_bot_chats: false,
        allow_group_chats: true,
        allow_channel_chats: true,
      },
    },
    autoSent: false,
  });
}

export async function cancelAiPartnerOwnerShare(
  env,
  context,
  {
    confirmationToken,
    at = Math.floor(Date.now() / 1_000),
  } = {},
  dependencies = {},
) {
  const cancelled = await cancelAiPartnerShareConfirmation(
    ownerUiEnv(env),
    context.runtime,
    {
      confirmationToken,
      cancelledAt: normalizeClock(at),
      cryptoImpl: dependencies.cryptoImpl || globalThis.crypto,
    },
  );
  return deepFreeze({
    cancelled,
    action: telegramEnvelope({
      context,
      kind: "ai_partner_owner_share_cancelled",
      text: "Отправка отменена. Черновик и его история сохранены.",
      richHtml: "<b>Отправка отменена</b><br><br>Черновик и его история сохранены.",
      keyboard: [[button("⬅️ К черновикам", callback("drafts", { page: 0 }))]],
    }),
  });
}

export async function handleAiPartnerOwnerTelegramCallback(
  env,
  context,
  callbackData,
  dependencies = {},
) {
  const at = normalizeClock(
    dependencies.at === undefined
      ? Math.floor(Date.now() / 1_000)
      : dependencies.at,
  );
  const value = String(callbackData || "");
  if (value.startsWith(`${CALLBACK_PREFIX}:`)) {
    const parsed = parseAiPartnerOwnerTelegramCallback(value);
    if (parsed.action === "hub") {
      return deepFreeze({
        action: await renderAiPartnerOwnerHub(env, context),
        background: null,
      });
    }
    if (parsed.action === "offers") {
      return deepFreeze({
        action: await renderAiPartnerOwnerOfferPage(env, context, {
          page: parsed.page,
          at,
        }),
        background: null,
      });
    }
    if (parsed.action === "offer") {
      return deepFreeze({
        action: await renderAiPartnerOwnerFormatPicker(env, context, {
          offerFactSourceId: parsed.offerId,
          at,
        }),
        background: null,
      });
    }
    if (parsed.action === "generate") {
      const prepared = await prepareAiPartnerOwnerTelegramGeneration(
        env,
        context,
        {
          offerFactSourceId: parsed.offerId,
          draftType: parsed.draftType,
          operationSeed: value,
          at,
        },
        dependencies,
      );
      return deepFreeze({
        action: prepared.initialAction,
        background: {
          type: "execute_ai_partner_owner_generation",
          generationId: prepared.generationId,
          prepared,
        },
      });
    }
    if (parsed.action === "drafts") {
      return deepFreeze({
        action: await renderAiPartnerOwnerDraftPage(env, context, {
          page: parsed.page,
          at,
        }),
        background: null,
      });
    }
    if (parsed.action === "history") {
      return deepFreeze({
        action: await renderAiPartnerOwnerHistoryPage(env, context, {
          draftId: parsed.draftId,
          page: parsed.page,
        }),
        background: null,
      });
    }
    throw uxError("ai_partner_owner_telegram_callback_action_denied");
  }

  const parsed = parseAiPartnerTelegramCallback(context.runtime, value);
  if (parsed.action === "stop") {
    const result = await stopAiPartnerOwnerTelegramGeneration(
      env,
      context,
      { generationId: parsed.generationId, at },
      dependencies,
    );
    return deepFreeze({ action: result.action, background: null, result });
  }
  if (parsed.action === "retry") {
    const result = await retryAiPartnerOwnerTelegramGeneration(
      env,
      context,
      { generationId: parsed.generationId, at },
      dependencies,
    );
    return deepFreeze({
      action: result.action,
      background: {
        type: "execute_ai_partner_owner_generation",
        generationId: result.session.generationId,
      },
      result,
    });
  }
  if (parsed.action === "view") {
    const result = await renderAiPartnerOwnerDraftPreview(env, context, {
      draftId: parsed.draftId,
      versionNo: parsed.versionNo,
    });
    return deepFreeze({ action: result.envelope, background: null, result });
  }
  if (parsed.action === "edit") {
    const result = await prepareAiPartnerOwnerEditReply(
      env,
      context,
      { draftId: parsed.draftId, versionNo: parsed.versionNo, at },
      dependencies,
    );
    return deepFreeze({ action: result.action, background: null, result });
  }
  if (parsed.action === "share_ask") {
    const result = await prepareAiPartnerOwnerShare(
      env,
      context,
      { draftId: parsed.draftId, versionNo: parsed.versionNo, at },
      dependencies,
    );
    return deepFreeze({ action: result.action, background: null, result });
  }
  if (parsed.action === "share_confirm") {
    const result = await consumeAiPartnerOwnerShare(
      env,
      context,
      { confirmationToken: parsed.confirmationToken, at },
      dependencies,
    );
    return deepFreeze({ action: result.action, background: null, result });
  }
  if (parsed.action === "share_cancel") {
    const result = await cancelAiPartnerOwnerShare(
      env,
      context,
      { confirmationToken: parsed.confirmationToken, at },
      dependencies,
    );
    return deepFreeze({ action: result.action, background: null, result });
  }
  if (parsed.action === "back") {
    const action = parsed.destination === "drafts"
      ? await renderAiPartnerOwnerDraftPage(env, context, { page: 0, at })
      : await renderAiPartnerOwnerHub(env, context);
    return deepFreeze({ action, background: null });
  }
  throw uxError("ai_partner_owner_telegram_callback_action_denied");
}
