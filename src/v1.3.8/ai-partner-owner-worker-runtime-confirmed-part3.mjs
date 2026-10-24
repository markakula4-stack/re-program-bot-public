import {
  AI_PARTNER_LIMITS,
  AI_PARTNER_MODEL_ALIASES,
  AI_PARTNER_POLICY_VERSION,
  readAiPartnerConfig,
} from "./ai-partner-foundation.mjs";
import {
  AI_PARTNER_RUNTIME_KEY,
} from "./ai-partner-worker-runtime.mjs";
import {
  failAiPartnerGenerationSession,
} from "./ai-partner-telegram-ux-confirmed-part3.mjs";
import {
  consumeAiPartnerOwnerEditReply,
  createAiPartnerOwnerTelegramContext,
  executeAiPartnerOwnerTelegramGeneration,
  extractAiPartnerOwnerEditToken,
  handleAiPartnerOwnerTelegramCallback,
  prepareAiPartnerOwnerEditedDraftConfirmation,
  renderAiPartnerOwnerHub,
  stopAiPartnerOwnerTelegramGeneration,
  stopAiPartnerOwnerTelegramNativeDraft,
} from "./ai-partner-owner-telegram-rich-ux-confirmed-part3.mjs";
import {
  clearExpiredOwnerConfirmations,
  handleOwnerConfirmedWriteCallback,
  handleOwnerMemoryCallback,
} from "./ai-partner-owner-telegram-confirmed-part3.mjs";
import {
  consumeAiPartnerOwnerExternalConsent,
  createAiPartnerOwnerPart4Policy,
  getAiPartnerOwnerPart4BudgetStatus,
  prepareAiPartnerOwnerExternalConsent,
  readAiPartnerOwnerExternalConsentState,
} from "./ai-partner-owner-security-cost-fallback-part4.mjs";

export const AI_PARTNER_OWNER_WORKER_RUNTIME_PART5_VERSION =
  "2026-09-19.owner-controlled-runtime-part5-step3";
export const AI_PARTNER_OWNER_WORKER_RUNTIME_KEY = AI_PARTNER_RUNTIME_KEY;
export const AI_PARTNER_OWNER_WORKER_CALLBACK_PREFIX = "a38o";
export const AI_PARTNER_OWNER_WORKER_SCHEMA = Object.freeze({
  tables: 14,
  indexes: 18,
  triggers: 40,
  reusedLedgers: 4,
});

const TELEGRAM_TIMEOUT_MS = 10_000;
const AI_PARTNER_COMMAND = /^\/ai_partner(?:@RE_Program_Bot)?$/i;
// ai_hub belongs to the existing public RE AI screen; only a38 callbacks
// belong to the separate owner-only AI Partner flow.
const OWNER_CALLBACK = /^(?:a38p:|a38:|a38o:|a38w:|a38m:)/;
const EDIT_TOKEN_IN_REPLY = /a38e\.[A-Za-z0-9_-]{20,220}\.[A-Za-z0-9_-]{22}/;
const SAFE_ERROR_CODE = /^[a-z0-9_.-]{3,80}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_TELEGRAM_METHODS = new Set([
  "answerCallbackQuery",
  "savePreparedInlineMessage",
  "sendMessage",
  "sendMessageDraft",
  "sendRichMessage",
  "sendRichMessageDraft",
]);
const AI_PARTNER_TABLES = Object.freeze([
  "ai_partner_runtime_settings",
  "content_fact_sources",
  "ai_drafts",
  "ai_draft_versions",
  "ai_policy_events",
  "ai_generation_sessions",
  "ai_generation_actions",
  "ai_share_intents",
  "ai_gateway_budget_reservations",
  "ai_gateway_attempts",
  "ai_gateway_usage_metadata",
  "ai_gateway_daily_aggregates",
  "ai_gateway_policy_daily_aggregates",
  "ai_generation_provider_evidence",
]);
const REUSED_AI_LEDGERS = Object.freeze([
  "ai_user_consents",
  "ai_usage_events",
  "ai_quota_reservations",
  "ai_conversation_messages",
]);

function runtimeError(code, cause = null) {
  const error = new Error("AI Partner owner Worker runtime rejected the request");
  error.name = "AiPartnerOwnerWorkerRuntimeError";
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function flag(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function positiveTelegramId(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeClock(value = Math.floor(Date.now() / 1_000)) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1_600_000_000 ||
    parsed > 9_999_999_999
  ) {
    throw runtimeError("ai_partner_owner_runtime_clock_invalid");
  }
  return parsed;
}

function safeErrorCode(value, fallback = "ai_partner_owner_runtime_failed") {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 80);
  return SAFE_ERROR_CODE.test(normalized) ? normalized : fallback;
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

function deepClone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function secretReady(value, minimum = 32) {
  return typeof value === "string" && value.trim().length >= minimum;
}

function parseApproval(env, at) {
  // A permanent owner-only rollout requires its own explicit switch. A bounded
  // canary cannot silently turn into a permanent approval.
  if (flag(env?.AI_PARTNER_OWNER_ONLY_ENABLED)) {
    const ready = String(env?.AI_PARTNER_ADMIN_CANARY_APPROVED_AT) === "0" &&
      String(env?.AI_PARTNER_ADMIN_CANARY_APPROVED_UNTIL) === "0";
    return Object.freeze({
      ready,
      approvedAt: null,
      approvedUntil: null,
      expiresInSeconds: 0,
      permanent: ready,
    });
  }
  const approvedAtText = String(
    env?.AI_PARTNER_ADMIN_CANARY_APPROVED_AT || "",
  ).trim();
  const approvedUntilText = String(
    env?.AI_PARTNER_ADMIN_CANARY_APPROVED_UNTIL || "",
  ).trim();
  const approvedAt = /^\d{10}$/.test(approvedAtText)
    ? Number(approvedAtText)
    : null;
  const approvedUntil = /^\d{10}$/.test(approvedUntilText)
    ? Number(approvedUntilText)
    : null;
  const ready = Boolean(
    Number.isSafeInteger(approvedAt) &&
      Number.isSafeInteger(approvedUntil) &&
      approvedAt <= at &&
      at < approvedUntil &&
      approvedUntil > approvedAt &&
      approvedUntil - approvedAt <= 600
  );
  return Object.freeze({
    ready,
    approvedAt: ready ? approvedAt : null,
    approvedUntil: ready ? approvedUntil : null,
    expiresInSeconds: ready ? approvedUntil - at : 0,
  });
}

function requireDatabase(env) {
  if (!env?.DB?.prepare || !env?.DB?.batch) {
    throw runtimeError("ai_partner_owner_runtime_database_not_ready");
  }
  return env.DB;
}

async function readSchemaState(database) {
  const tablePlaceholders = AI_PARTNER_TABLES.map(() => "?").join(",");
  const reusedPlaceholders = REUSED_AI_LEDGERS.map(() => "?").join(",");
  const row = await database.prepare(
    `SELECT
       (SELECT COUNT(*) FROM sqlite_schema
          WHERE type = 'table' AND name IN (${tablePlaceholders}))
         AS schema_tables,
       (SELECT COUNT(*) FROM sqlite_schema
          WHERE type = 'index'
            AND name NOT LIKE 'sqlite_autoindex_%'
            AND tbl_name IN (${tablePlaceholders}))
         AS schema_indexes,
       (SELECT COUNT(*) FROM sqlite_schema
          WHERE type = 'trigger'
            AND (
              tbl_name IN (${tablePlaceholders})
              OR name LIKE 'trg_content_fact_sources_%'
            ))
         AS schema_triggers,
       (SELECT COUNT(*) FROM sqlite_schema
          WHERE type = 'table' AND name IN (${reusedPlaceholders}))
         AS reused_ledgers
     LIMIT 1`,
  ).bind(
    ...AI_PARTNER_TABLES,
    ...AI_PARTNER_TABLES,
    ...AI_PARTNER_TABLES,
    ...REUSED_AI_LEDGERS,
  ).first();
  return Object.freeze({
    tables: Number(row?.schema_tables || 0),
    indexes: Number(row?.schema_indexes || 0),
    triggers: Number(row?.schema_triggers || 0),
    reusedLedgers: Number(row?.reused_ledgers || 0),
  });
}

async function readRuntimeSettings(database) {
  const row = await database.prepare(
    `SELECT rollout_mode, master_enabled, external_provider_enabled,
            primary_model_alias, dragon_model_alias, fallback_model_alias,
            external_model_name, thinking_enabled,
            dragon_daily_burst_limit, dragon_cycle_success_limit,
            quota_cycle_days, quota_cycle_carryover_enabled,
            max_concurrent_per_user, max_provider_retries,
            pilot_user_limit, user_cycle_cost_ceiling_microusd,
            global_cycle_cost_ceiling_microusd, memory_exchange_limit,
            confirmation_ttl_seconds, telemetry_retention_days,
            policy_version
     FROM ai_partner_runtime_settings
     WHERE id = 1
     LIMIT 1`,
  ).first();
  if (!row) return null;
  return Object.freeze({
    rolloutMode: String(row.rollout_mode || "off"),
    masterEnabled: Number(row.master_enabled) === 1,
    externalProviderEnabled: Number(row.external_provider_enabled) === 1,
    primaryModelAlias: String(row.primary_model_alias || ""),
    dragonModelAlias: String(row.dragon_model_alias || ""),
    fallbackModelAlias: String(row.fallback_model_alias || ""),
    externalModelName: String(row.external_model_name || ""),
    thinkingEnabled: Number(row.thinking_enabled) === 1,
    dailyBurst: Number(row.dragon_daily_burst_limit),
    cycleSuccess: Number(row.dragon_cycle_success_limit),
    cycleDays: Number(row.quota_cycle_days),
    cycleCarryoverEnabled:
      Number(row.quota_cycle_carryover_enabled) === 1,
    maxConcurrentPerUser: Number(row.max_concurrent_per_user),
    maxProviderRetries: Number(row.max_provider_retries),
    pilotUsers: Number(row.pilot_user_limit),
    userCostCeilingMicrousd:
      Number(row.user_cycle_cost_ceiling_microusd),
    globalCostCeilingMicrousd:
      Number(row.global_cycle_cost_ceiling_microusd),
    memoryExchanges: Number(row.memory_exchange_limit),
    confirmationTtlSeconds: Number(row.confirmation_ttl_seconds),
    telemetryRetentionDays: Number(row.telemetry_retention_days),
    policyVersion: String(row.policy_version || ""),
  });
}

function settingsMatchContract(settings, config) {
  return Boolean(
    settings &&
      settings.rolloutMode === config.rolloutMode &&
      settings.masterEnabled === config.masterEnabled &&
      settings.externalProviderEnabled === config.externalProviderEnabled &&
      settings.primaryModelAlias === AI_PARTNER_MODEL_ALIASES.safe &&
      settings.dragonModelAlias === AI_PARTNER_MODEL_ALIASES.dragon &&
      settings.fallbackModelAlias === AI_PARTNER_MODEL_ALIASES.safe &&
      settings.externalModelName === "deepseek-flash" &&
      settings.thinkingEnabled === false &&
      settings.dailyBurst === config.dailyBurst &&
      settings.cycleSuccess === config.cycleSuccess &&
      settings.cycleDays === AI_PARTNER_LIMITS.cycleDays &&
      settings.cycleCarryoverEnabled === false &&
      settings.maxConcurrentPerUser === 1 &&
      settings.maxProviderRetries === 1 &&
      settings.pilotUsers === config.pilotUsers &&
      settings.userCostCeilingMicrousd === config.userCostCeilingMicrousd &&
      settings.globalCostCeilingMicrousd ===
        config.globalCostCeilingMicrousd &&
      settings.memoryExchanges === AI_PARTNER_LIMITS.memoryExchanges &&
      settings.confirmationTtlSeconds ===
        AI_PARTNER_LIMITS.confirmationTtlSeconds &&
      settings.telemetryRetentionDays ===
        AI_PARTNER_LIMITS.telemetryRetentionDays &&
      settings.policyVersion === AI_PARTNER_POLICY_VERSION
  );
}

export async function getAiPartnerOwnerWorkerDecision(
  env,
  actorTelegramId,
  { at = Math.floor(Date.now() / 1_000) } = {},
) {
  const timestamp = normalizeClock(at);
  const actor = positiveTelegramId(actorTelegramId);
  const owner = positiveTelegramId(env?.ADMIN_ID);
  if (!actor || !owner || actor !== owner) {
    return Object.freeze({
      eligible: false,
      reason: "non_admin_blocked",
      actorTelegramId: actor,
      ownerTelegramId: owner,
      schema: null,
      approval: null,
    });
  }

  const database = requireDatabase(env);
  const config = readAiPartnerConfig(env);
  const approval = parseApproval(env, timestamp);
  const [settings, schema] = await Promise.all([
    readRuntimeSettings(database),
    readSchemaState(database),
  ]);
  const confirmedMode = flag(env?.AI_PARTNER_OWNER_CONFIRMATION_UX_ENABLED);
  const confirmedSchema = confirmedMode
    ? await database.prepare(
      `SELECT COUNT(*) AS total FROM sqlite_schema
       WHERE (type = 'table' AND name IN (
         'ai_partner_memory_settings', 'ai_partner_write_intents',
         'ai_partner_write_events', 'ai_partner_write_payloads'
       )) OR (type = 'trigger' AND name IN (
         'trg_ai_partner_draft_versions_confirmed_guard',
         'trg_ai_partner_write_events_terminal_guard',
         'trg_ai_partner_draft_versions_human_confirmed_guard'
       ))`,
    ).first()
    : null;
  const schemaReady = Object.entries(AI_PARTNER_OWNER_WORKER_SCHEMA)
    .every(([key, expected]) => schema[key] === expected +
      (confirmedMode && key === "triggers" ? 2 : 0)) &&
    (!confirmedMode || Number(confirmedSchema?.total) === 7);
  const settingsReady = settingsMatchContract(settings, config);
  const runtimeFlagsReady = Boolean(
    flag(env?.AI_PARTNER_OWNER_GENERATION_ENABLED) &&
      flag(env?.AI_PARTNER_OWNER_SECURITY_COST_FALLBACK_ENABLED) &&
      (!flag(env?.AI_PARTNER_OWNER_ONLY_ENABLED) ||
        (confirmedMode && !config.externalProviderEnabled &&
         String(env?.AI_PARTNER_OWNER_MODEL_POLICY) === "qwen_safe")) &&
      (confirmedMode
        ? flag(env?.AI_PARTNER_OWNER_MEMORY_ENABLED) &&
          flag(env?.AI_PARTNER_OWNER_WRITE_TOOLS_ENABLED)
        : !flag(env?.AI_PARTNER_OWNER_MEMORY_ENABLED))
  );
  const secretsReady = Boolean(
    secretReady(env?.AI_PARTNER_PROVIDER_USER_ID_SECRET) &&
      secretReady(env?.AI_PARTNER_PRIVATE_CACHE_SECRET) &&
      (!config.externalProviderEnabled || secretReady(env?.DEEPSEEK_API_KEY, 20))
  );
  const eligible = Boolean(
    config.configurationValid &&
      config.masterEnabled &&
      config.rolloutMode === "admin" &&
      approval.ready &&
      schemaReady &&
      settingsReady &&
      runtimeFlagsReady &&
      secretsReady
  );
  const reason = eligible
    ? approval.permanent ? "owner_only_enabled" : "admin_canary"
    : !config.masterEnabled || config.rolloutMode !== "admin"
      ? "feature_off"
      : !approval.ready
        ? "approval_missing_or_expired"
        : !schemaReady
          ? "schema_not_ready"
          : !settingsReady
            ? "database_settings_mismatch"
            : !runtimeFlagsReady
              ? "owner_runtime_flags_not_ready"
              : !secretsReady
                ? "secret_boundary_not_ready"
                : "configuration_invalid";
  return Object.freeze({
    eligible,
    reason,
    actorTelegramId: actor,
    ownerTelegramId: owner,
    schema,
    approval,
    richMessagesEnabled: flag(env?.AI_PARTNER_RICH_MESSAGES_ENABLED),
    externalProviderConfigured: config.externalProviderEnabled,
  });
}

function privateActor(update) {
  const message = update?.message;
  const callback = update?.callback_query;
  const draftStop = update?.stopped_message_generation;

  const messageActor = positiveTelegramId(message?.from?.id);
  const messageChat = positiveTelegramId(message?.chat?.id);
  if (
    messageActor &&
    messageChat &&
    messageActor === messageChat &&
    message?.chat?.type === "private" &&
    !message?.from?.is_bot
  ) {
    return Object.freeze({
      kind: "message",
      telegramId: messageActor,
      chatId: messageChat,
      message,
      callback: null,
      draftStop: null,
    });
  }

  const callbackActor = positiveTelegramId(callback?.from?.id);
  const callbackChat = positiveTelegramId(callback?.message?.chat?.id);
  if (
    callbackActor &&
    callbackChat &&
    callbackActor === callbackChat &&
    callback?.message?.chat?.type === "private" &&
    !callback?.from?.is_bot &&
    typeof callback?.id === "string"
  ) {
    return Object.freeze({
      kind: "callback",
      telegramId: callbackActor,
      chatId: callbackChat,
      message: null,
      callback,
      draftStop: null,
    });
  }

  const draftChat = positiveTelegramId(draftStop?.chat?.id);
  const draftId = Number(draftStop?.draft_id);
  if (
    draftChat &&
    draftStop?.chat?.type === "private" &&
    Number.isSafeInteger(draftId) &&
    draftId > 0
  ) {
    return Object.freeze({
      kind: "draft_stop",
      telegramId: draftChat,
      chatId: draftChat,
      message: null,
      callback: null,
      draftStop: Object.freeze({ ...draftStop, draft_id: draftId }),
    });
  }
  return null;
}

function rawTarget(update) {
  const text = String(update?.message?.text || "").trim();
  if (AI_PARTNER_COMMAND.test(text)) return "command";
  const replyText = String(
    update?.message?.reply_to_message?.text ||
      update?.message?.reply_to_message?.caption ||
      "",
  );
  if (EDIT_TOKEN_IN_REPLY.test(replyText)) return "edit_reply";
  const callbackData = String(update?.callback_query?.data || "");
  if (OWNER_CALLBACK.test(callbackData)) return "callback";
  if (update?.stopped_message_generation) {
    return "draft_stop";
  }
  return null;
}

function capabilities(env) {
  const rich = flag(env?.AI_PARTNER_RICH_MESSAGES_ENABLED);
  return Object.freeze({
    richMessages: rich,
    messageDrafts: true,
    richMessageDrafts: rich,
    disabledButtons: rich,
    preparedInlineMessages: true,
    ephemeralUi: rich,
  });
}

function createOwnerContext(env, actor, update) {
  return createAiPartnerOwnerTelegramContext(env, {
    actorTelegramId: actor.telegramId,
    chatId: actor.chatId,
    chatType: "private",
    updateId: Number.isSafeInteger(Number(update?.update_id))
      ? Number(update.update_id)
      : 0,
    callbackQueryId: actor.callback?.id || undefined,
    capabilities: capabilities(env),
  });
}

function customEnvelope(chatId, text, keyboard = []) {
  const payload = {
    chat_id: chatId,
    text: String(text || "").slice(0, 4_000),
    reply_markup: { inline_keyboard: keyboard },
    link_preview_options: { is_disabled: true },
  };
  return deepFreeze({
    kind: "ai_partner_owner_runtime",
    preferred: Object.freeze({ method: "sendMessage", payload }),
    fallback: Object.freeze({ method: "sendMessage", payload }),
  });
}

function callbackButton(text, callbackData) {
  const data = String(callbackData || "");
  if (!data || new TextEncoder().encode(data).byteLength > 64) {
    throw runtimeError("ai_partner_owner_runtime_callback_invalid");
  }
  return Object.freeze({ text: String(text).slice(0, 64), callback_data: data });
}

function appendOwnerControls(envelope, consentState, confirmationMode = false) {
  const clone = deepClone(envelope);
  const rows = [
    ...(!confirmationMode ? [[callbackButton(
      consentState.active ? "⚡ DeepSeek · подключён" : "⚡ Подключить DeepSeek",
      consentState.active
        ? `${AI_PARTNER_OWNER_WORKER_CALLBACK_PREFIX}:consent:revoke`
        : `${AI_PARTNER_OWNER_WORKER_CALLBACK_PREFIX}:consent:grant`,
    )]] : []),
    [callbackButton(
      "📊 Лимиты и расходы",
      `${AI_PARTNER_OWNER_WORKER_CALLBACK_PREFIX}:budget`,
    )],
    ...(confirmationMode ? [[callbackButton("🧠 Память", "a38m:show")]] : []),
    [callbackButton("⬅️ В главное меню", "menu")],
  ];
  const decoratedKeyboards = new Set();
  for (const key of ["preferred", "fallback"]) {
    const payload = clone?.[key]?.payload;
    if (!payload) continue;
    if (!plainObject(payload.reply_markup)) {
      payload.reply_markup = { inline_keyboard: [] };
    }
    if (!Array.isArray(payload.reply_markup.inline_keyboard)) {
      payload.reply_markup.inline_keyboard = [];
    }
    const keyboard = payload.reply_markup.inline_keyboard;
    if (decoratedKeyboards.has(keyboard)) continue;
    decoratedKeyboards.add(keyboard);
    keyboard.push(...deepClone(rows));
  }
  return deepFreeze(clone);
}

function sanitizeLegacyKeyboard(keyboard) {
  if (!Array.isArray(keyboard)) return [];
  return keyboard
    .map((row) => Array.isArray(row)
      ? row
          .filter((item) => plainObject(item) && !item.disabled)
          .map((item) => {
            const copy = { ...item };
            delete copy.style;
            delete copy.disabled;
            return copy;
          })
      : [])
    .filter((row) => row.length > 0);
}

function sanitizeLegacyPayload(payload) {
  const copy = deepClone(payload || {});
  delete copy.ephemeral_message_parameters;
  if (copy.reply_markup?.inline_keyboard) {
    copy.reply_markup.inline_keyboard = sanitizeLegacyKeyboard(
      copy.reply_markup.inline_keyboard,
    );
  }
  return copy;
}

function telegramError(code, statusCode = null, cause = null) {
  const error = runtimeError(code, cause);
  if (Number.isInteger(statusCode)) error.statusCode = statusCode;
  return error;
}

export async function defaultAiPartnerOwnerTelegramCall(env, method, payload) {
  if (!ALLOWED_TELEGRAM_METHODS.has(method)) {
    throw telegramError("telegram_method_denied");
  }
  if (!secretReady(env?.BOT_TOKEN, 20)) {
    throw telegramError("telegram_bot_token_missing");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );
    } catch (cause) {
      const code = cause?.name === "AbortError"
        ? "telegram_timeout_unknown" : "telegram_delivery_unknown";
      await recordOwnerTrace(env, `${method}:${code}`);
      throw telegramError(code, null, cause);
    }
    let result = null;
    try {
      result = await response.json();
    } catch {
      await recordOwnerTrace(env,
        `${method}:telegram_response_invalid:http_${response.status}`);
      throw telegramError("telegram_response_invalid", response.status);
    }
    if (!response.ok || result?.ok !== true) {
      const description = String(result?.description || "");
      const unsupported =
        response.status === 404 ||
        // Telegram may answer HTTP 400 for a Rich API method without a
        // recognizable description. Use the existing plain-message fallback.
        ((method === "sendRichMessage" ||
          method === "sendRichMessageDraft") && response.status === 400) ||
        (response.status === 400 &&
          /method not found|not supported|unknown method|rich_message|ephemeral|disabled button/iu.test(description));
      const code = unsupported
        ? "telegram_feature_unsupported" : "telegram_request_rejected";
      await recordOwnerTrace(env, `${method}:${code}:http_${response.status}`);
      throw telegramError(code, response.status);
    }
    return result.result;
  } finally {
    clearTimeout(timeout);
  }
}

// Bounded, content-free diagnostics for the owner-only Telegram delivery path.
async function recordOwnerTrace(env, code) {
  if (!/^[a-zA-Z0-9_.:-]{3,120}$/.test(code) || !env?.DB?.prepare) return;
  try {
    await env.DB.prepare(
      "INSERT INTO bot_error_log (context, message) VALUES (?, ?)",
    ).bind("ai_partner.owner_trace", code).run();
  } catch {
    // Diagnostics cannot block a Telegram reply.
  }
}

function assertTelegramAction(action, ownerTelegramId) {
  if (!plainObject(action) || !ALLOWED_TELEGRAM_METHODS.has(action.method)) {
    throw runtimeError("ai_partner_owner_runtime_action_denied");
  }
  if (!plainObject(action.payload)) {
    throw runtimeError("ai_partner_owner_runtime_payload_invalid");
  }
  if (action.method === "answerCallbackQuery") {
    if (typeof action.payload.callback_query_id !== "string") {
      throw runtimeError("ai_partner_owner_runtime_callback_id_invalid");
    }
    return action;
  }
  if (action.method === "savePreparedInlineMessage") {
    if (positiveTelegramId(action.payload.user_id) !== ownerTelegramId) {
      throw runtimeError("ai_partner_owner_runtime_prepared_owner_mismatch");
    }
    return action;
  }
  if (positiveTelegramId(action.payload.chat_id) !== ownerTelegramId) {
    throw runtimeError("ai_partner_owner_runtime_chat_mismatch");
  }
  return action;
}

function legacyFallbackCandidate(action, ownerTelegramId) {
  const messages = action?.fallback?.messages;
  if (!Array.isArray(messages) || messages.length !== 1) return null;
  const message = messages[0];
  if (!plainObject(message) || message.method !== "sendMessage") return null;
  const payload = {
    chat_id: ownerTelegramId,
    text: String(message.text || "").slice(0, 4_000),
  };
  if (plainObject(message.reply_markup)) {
    payload.reply_markup = deepClone(message.reply_markup);
  }
  if (typeof message.parse_mode === "string" && message.parse_mode) {
    payload.parse_mode = message.parse_mode;
  }
  return Object.freeze({ method: "sendMessage", payload });
}

function actionCandidates(action, ownerTelegramId) {
  const legacy = legacyFallbackCandidate(action, ownerTelegramId);
  if (legacy) return [legacy];
  if (plainObject(action?.preferred)) {
    const values = [action.preferred];
    if (plainObject(action.fallback)) values.push(action.fallback);
    return values;
  }
  const values = [action];
  if (plainObject(action?.fallback)) values.push(action.fallback);
  return values;
}

function legacyPagedCandidates(action, ownerTelegramId) {
  const messages = action?.fallback?.messages;
  if (!Array.isArray(messages) || messages.length < 2) return null;
  if (!messages.every((page) => plainObject(page) && page.method === "sendMessage")) {
    throw runtimeError("ai_partner_owner_runtime_action_denied");
  }
  return messages.map((page) => ({ method: "sendMessage", payload: {
    chat_id: ownerTelegramId,
    text: String(page.text || "").slice(0, 4_000),
    reply_markup: plainObject(page.reply_markup)
      ? deepClone(page.reply_markup) : { inline_keyboard: [] },
  } }));
}

async function deliverAction(
  callTelegram,
  env,
  ownerTelegramId,
  action,
  { phase = "final" } = {},
) {
  const pages = legacyPagedCandidates(action, ownerTelegramId);
  if (pages) {
    let last = null;
    for (const page of pages) {
      const candidate = assertTelegramAction(page, ownerTelegramId);
      last = await callTelegram(env, "sendMessage",
        sanitizeLegacyPayload(candidate.payload));
    }
    return last;
  }
  const candidates = actionCandidates(action, ownerTelegramId);
  let lastError = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = assertTelegramAction(candidates[index], ownerTelegramId);
    const payload = candidate.method === "sendMessage"
      ? sanitizeLegacyPayload(candidate.payload)
      : candidate.payload;
    try {
      return await callTelegram(env, candidate.method, payload);
    } catch (error) {
      lastError = error;
      if (error?.code !== "telegram_feature_unsupported") throw error;
      if (index + 1 < candidates.length) continue;
      if (
        candidate.method === "sendMessageDraft" ||
        candidate.method === "sendRichMessageDraft"
      ) {
        if (phase === "progress") return null;
        const fallbackText = String(
          candidate.payload.text ||
            candidate.payload.rich_message?.html ||
            "Готовлю проверяемый черновик…",
        )
          .replace(/<[^>]+>/g, "")
          .slice(0, 4_000);
        return callTelegram(env, "sendMessage", {
          chat_id: ownerTelegramId,
          text: fallbackText || "Готовлю проверяемый черновик…",
        });
      }
    }
  }
  throw lastError || runtimeError("ai_partner_owner_runtime_delivery_failed");
}

async function safelyAnswerCallback(callTelegram, env, callbackId) {
  if (typeof callbackId !== "string" || !callbackId) return;
  try {
    await callTelegram(env, "answerCallbackQuery", {
      callback_query_id: callbackId,
    });
  } catch {
    // Callback acknowledgement is cosmetic and cannot widen authorization.
  }
}

async function safelySend(
  callTelegram,
  env,
  ownerTelegramId,
  action,
  options = {},
) {
  try {
    return await deliverAction(
      callTelegram,
      env,
      ownerTelegramId,
      action,
      options,
    );
  } catch {
    return null;
  }
}

function consentScreen(chatId, action) {
  const grant = action === "grant";
  return customEnvelope(
    chatId,
    grant
      ? "⚡ Подключение DeepSeek\n\nПри генерации сервер сможет отправить DeepSeek только утверждённые факты оффера и безопасное пожелание. Память и кеш выключены. Публикация остаётся только ручной. Подключение можно отозвать в любой момент."
      : "⛔ Отключение DeepSeek\n\nПосле подтверждения внешний provider перестанет использоваться. RE AI Partner продолжит работать через Qwen Safe.",
    [
      [callbackButton(
        grant ? "✅ Подключить" : "✅ Отключить",
        `${AI_PARTNER_OWNER_WORKER_CALLBACK_PREFIX}:consent:${action}:confirm`,
      )],
      [callbackButton(
        "⬅️ Назад",
        `${AI_PARTNER_OWNER_WORKER_CALLBACK_PREFIX}:hub`,
      )],
    ],
  );
}

function budgetScreen(chatId, status, confirmationMode = false) {
  return customEnvelope(
    chatId,
    "📊 Лимиты и расходы RE AI Partner\n\n" +
      `Модель: ${!confirmationMode && status.externalProviderEnabled ? "DeepSeek Flash → Qwen Safe" : "Qwen Safe"}\n` +
      `Память: ${status.memoryMode}. Кеш: ${status.cacheAllowed ? "включён" : "выключен"}.\n` +
      `Успешных сегодня: ${status.dailySuccesses}.\n` +
      `Успешных в цикле: ${status.cycleSuccesses}.\n` +
      `Активных запросов: ${status.activeRequests}.\n` +
      `Расход владельца: ${status.userCostMicrousd} / ${status.userCostCeilingMicrousd} µUSD.\n` +
      `Общий расход: ${status.globalCostMicrousd} / ${status.globalCostCeilingMicrousd} µUSD.`,
    [[callbackButton(
      "⬅️ К RE AI",
      `${AI_PARTNER_OWNER_WORKER_CALLBACK_PREFIX}:hub`,
    )]],
  );
}

function closedScreen(chatId, reason) {
  return customEnvelope(
    chatId,
    "🤖 RE AI Partner сейчас закрыт.\n\n" +
      "Остальные функции бота продолжают работать. Код состояния: " +
      safeErrorCode(reason, "feature_off") + ".",
    [[callbackButton("⬅️ В главное меню", "menu")]],
  );
}

function unavailableForAccountScreen(chatId) {
  return customEnvelope(
    chatId,
    "🤖 AI Partner (генератор черновиков) доступен только администратору.\n\n" +
      "Обычный RE AI можно открыть через главное меню.",
    [[callbackButton("⬅️ В главное меню", "menu")]],
  );
}

function errorScreen(chatId, code) {
  return customEnvelope(
    chatId,
    "⚠️ RE AI Partner не смог безопасно выполнить действие. " +
      "Ничего не опубликовано и не отправлено. Код: " +
      safeErrorCode(code) + ".",
    [[callbackButton(
      "⬅️ К RE AI",
      `${AI_PARTNER_OWNER_WORKER_CALLBACK_PREFIX}:hub`,
    )]],
  );
}

// Part 4 provider policy remains memory-free even when the separate owner
// memory controls are available. Consent and data never enter its payload.
function part4ReadEnv(env) {
  return flag(env?.AI_PARTNER_OWNER_CONFIRMATION_UX_ENABLED)
    ? { ...env, AI_PARTNER_OWNER_MEMORY_ENABLED: "false" }
    : env;
}

async function renderDecoratedHub(env, context, part4Api) {
  const [hub, consent] = await Promise.all([
    renderAiPartnerOwnerHub(env, context),
    part4Api.readConsentState(part4ReadEnv(env), {
      actorTelegramId: context.actorTelegramId,
      at: Math.floor(Date.now() / 1_000),
    }),
  ]);
  return appendOwnerControls(hub, consent,
    env.AI_PARTNER_OWNER_CONFIRMATION_UX_ENABLED === "true");
}

async function handleOwnerCustomCallback(
  env,
  context,
  data,
  {
    at,
    part4Api,
    cryptoImpl,
  },
) {
  if (data === `${AI_PARTNER_OWNER_WORKER_CALLBACK_PREFIX}:hub`) {
    return Object.freeze({
      action: await renderDecoratedHub(env, context, part4Api),
      background: null,
    });
  }
  if (data === `${AI_PARTNER_OWNER_WORKER_CALLBACK_PREFIX}:budget`) {
    const status = await part4Api.getBudgetStatus(part4ReadEnv(env), {
      actorTelegramId: context.actorTelegramId,
      at,
    });
    return Object.freeze({
      action: budgetScreen(context.chatId, status,
        flag(env.AI_PARTNER_OWNER_CONFIRMATION_UX_ENABLED)),
      background: null,
    });
  }
  const consent = data.match(/^a38o:consent:(grant|revoke)(?::confirm)?$/);
  if (consent) {
    if (flag(env.AI_PARTNER_OWNER_CONFIRMATION_UX_ENABLED)) {
      return Object.freeze({
        action: customEnvelope(context.chatId,
          "⚡ В этом режиме подтверждённые черновики генерируются через Qwen Safe. Управление DeepSeek вернётся после отдельной проверки политики модели.",
          [[callbackButton("⬅️ К RE AI", "a38o:hub")]]),
        background: null,
      });
    }
    const action = consent[1];
    if (!data.endsWith(":confirm")) {
      return Object.freeze({
        action: consentScreen(context.chatId, action),
        background: null,
      });
    }
    const prepared = await part4Api.prepareConsent(
      part4ReadEnv(env),
      {
        actorTelegramId: context.actorTelegramId,
        action,
        at,
      },
      { cryptoImpl },
    );
    const changed = await part4Api.consumeConsent(
      part4ReadEnv(env),
      {
        actorTelegramId: context.actorTelegramId,
        token: prepared.token,
        at,
      },
      { cryptoImpl },
    );
    return Object.freeze({
      action: customEnvelope(
        context.chatId,
        changed.action === "grant"
          ? "✅ DeepSeek подключён. Следующие генерации смогут использовать Flash с Qwen Safe как fallback."
          : "✅ DeepSeek отключён. Следующие генерации будут использовать Qwen Safe.",
        [[callbackButton(
          "⬅️ К RE AI",
          `${AI_PARTNER_OWNER_WORKER_CALLBACK_PREFIX}:hub`,
        )]],
      ),
      background: null,
    });
  }
  throw runtimeError("ai_partner_owner_runtime_callback_denied");
}

function isBaseHubCallback(data) {
  return data === "a38:hub" || data === "a38:status";
}

async function safelyStopFailedBackground(
  env,
  context,
  generationId,
  at,
  dependencies,
) {
  try {
    const stopped = await stopAiPartnerOwnerTelegramGeneration(
      env,
      context,
      { generationId, at },
      dependencies,
    );
    return stopped.action;
  } catch {
    return null;
  }
}

async function safelyFailInitialDelivery(
  env,
  context,
  generationId,
  at,
  dependencies,
) {
  try {
    return await failAiPartnerGenerationSession(env, context.runtime, {
      ownerTelegramId: context.actorTelegramId,
      generationId,
      failureCode: "telegram_initial_delivery_failed",
      failedAt: at,
      idFactory: dependencies?.idFactory,
    });
  } catch {
    return null;
  }
}

export function createAiPartnerOwnerWorkerRuntimePart5({
  callTelegram = defaultAiPartnerOwnerTelegramCall,
  now = () => Math.floor(Date.now() / 1_000),
  getDecision = getAiPartnerOwnerWorkerDecision,
  generationDependencies = {},
  cryptoImpl = globalThis.crypto,
  part4Api = {},
} = {}) {
  if (typeof callTelegram !== "function") {
    throw new TypeError("Telegram transport is required");
  }
  if (typeof now !== "function" || typeof getDecision !== "function") {
    throw new TypeError("Runtime clock and decision function are required");
  }
  const resolvedPart4 = Object.freeze({
    createPolicy:
      part4Api.createPolicy || createAiPartnerOwnerPart4Policy,
    prepareConsent:
      part4Api.prepareConsent || prepareAiPartnerOwnerExternalConsent,
    consumeConsent:
      part4Api.consumeConsent || consumeAiPartnerOwnerExternalConsent,
    readConsentState:
      part4Api.readConsentState || readAiPartnerOwnerExternalConsentState,
    getBudgetStatus:
      part4Api.getBudgetStatus || getAiPartnerOwnerPart4BudgetStatus,
  });

  async function sendHub(env, context) {
    const action = await renderDecoratedHub(env, context, resolvedPart4);
    await deliverAction(
      callTelegram,
      env,
      context.actorTelegramId,
      action,
    );
  }

  async function executeGenerationBackground(
    env,
    context,
    generationId,
  ) {
    const at = normalizeClock(now());
    try {
      const confirmationMode =
        env.AI_PARTNER_OWNER_CONFIRMATION_UX_ENABLED === "true";
      const policy = await resolvedPart4.createPolicy(
        confirmationMode
          ? { ...part4ReadEnv(env), AI_PARTNER_OWNER_MODEL_POLICY: "qwen_safe" }
          : env, {
        actorTelegramId: context.actorTelegramId,
        at,
      });
      const result = await executeAiPartnerOwnerTelegramGeneration(
        env,
        context,
        { generationId, at },
        {
          ...generationDependencies,
          cryptoImpl,
          part4Policy: policy,
          emitDraftAction: (action) => deliverAction(
            callTelegram,
            env,
            context.actorTelegramId,
            action,
            { phase: "progress" },
          ),
          emitFinalAction: (action) => deliverAction(
            callTelegram,
            env,
            context.actorTelegramId,
            action,
            { phase: "final" },
          ),
        },
      );
      if (result?.ok !== true && result?.finalAction) {
        await safelySend(
          callTelegram,
          env,
          context.actorTelegramId,
          result.finalAction,
        );
      }
      return result;
    } catch (error) {
      const stoppedAction = await safelyStopFailedBackground(
        env,
        context,
        generationId,
        at,
        { ...generationDependencies, cryptoImpl },
      );
      if (!stoppedAction && flag(env.AI_PARTNER_OWNER_CONFIRMATION_UX_ENABLED)) {
        try {
          await failAiPartnerGenerationSession(env, context.runtime, {
            generationId,
            failureCode: "telegram_preview_delivery_failed",
            actionKey: `preview-delivery-failed:${generationId}`,
            failedAt: at,
          });
        } catch {
          // A concurrent final state already won; keep the delivery failure.
        }
      }
      if (stoppedAction) {
        await safelySend(
          callTelegram,
          env,
          context.actorTelegramId,
          stoppedAction,
        );
      }
      await safelySend(
        callTelegram,
        env,
        context.actorTelegramId,
        errorScreen(context.chatId, error?.code),
      );
      return Object.freeze({
        ok: false,
        status: "failed",
        reason: safeErrorCode(error?.code),
      });
    }
  }

  async function scheduleBackground(task, waitUntil) {
    if (typeof waitUntil === "function") {
      waitUntil(task);
      return Object.freeze({ scheduled: true, result: null });
    }
    return Object.freeze({ scheduled: false, result: await task });
  }

  return Object.freeze({
    version: AI_PARTNER_OWNER_WORKER_RUNTIME_PART5_VERSION,

    async handleUpdate(env, update, options = {}) {
      const target = rawTarget(update);
      if (!target) return Object.freeze({ handled: false, status: "not_targeted" });

      const callbackId = update?.callback_query?.id;
      const actor = privateActor(update);
      if (!actor) {
        await safelyAnswerCallback(callTelegram, env, callbackId);
        return Object.freeze({ handled: true, status: "private_chat_required" });
      }

      const owner = positiveTelegramId(env?.ADMIN_ID);
      if (!owner || actor.telegramId !== owner) {
        await safelyAnswerCallback(callTelegram, env, callbackId);
        if (actor.callback?.data === "menu") {
          return Object.freeze({ handled: false, status: "ordinary_user_unchanged" });
        }
        if (target === "command") {
          await safelySend(
            callTelegram,
            env,
            actor.telegramId,
            unavailableForAccountScreen(actor.chatId),
          );
        }
        return Object.freeze({ handled: true, status: "owner_only" });
      }

      const at = normalizeClock(now());
      let decision;
      try {
        decision = await getDecision(env, actor.telegramId, { at });
      } catch (error) {
        decision = Object.freeze({
          eligible: false,
          reason: safeErrorCode(error?.code, "runtime_not_ready"),
        });
      }
      if (!decision?.eligible) {
        await safelyAnswerCallback(callTelegram, env, callbackId);
        await safelySend(
          callTelegram,
          env,
          owner,
          closedScreen(actor.chatId, decision?.reason),
        );
        return Object.freeze({
          handled: true,
          status: "closed",
          reason: safeErrorCode(decision?.reason, "feature_off"),
        });
      }

      const context = createOwnerContext(env, actor, update);
      if (target === "command") await recordOwnerTrace(env, "command_reached");
      await safelyAnswerCallback(callTelegram, env, callbackId);

      let pendingInitialGenerationId = null;
      let initialDeliveryCompleted = false;
      try {
        if (env.AI_PARTNER_OWNER_CONFIRMATION_UX_ENABLED === "true") {
          await clearExpiredOwnerConfirmations(env, context, at);
        }
        if (target === "command") {
          await sendHub(env, context);
          await recordOwnerTrace(env, "command_hub_delivered");
          return Object.freeze({ handled: true, status: "hub" });
        }

        if (target === "edit_reply") {
          const token = extractAiPartnerOwnerEditToken(actor.message);
          if (env.AI_PARTNER_OWNER_CONFIRMATION_UX_ENABLED === "true") {
            const prepared = await prepareAiPartnerOwnerEditedDraftConfirmation(
              env, context,
              { editToken: token, replyText: String(actor.message?.text || ""), at },
              { ...generationDependencies, cryptoImpl },
            );
            for (const action of prepared.actions) {
              await deliverAction(callTelegram, env, owner, action);
            }
            return Object.freeze({ handled: true, status: "edit_pending_confirmation" });
          }
          const result = await consumeAiPartnerOwnerEditReply(
            env,
            context,
            {
              editToken: token,
              replyText: String(actor.message?.text || ""),
              at,
            },
            { ...generationDependencies, cryptoImpl },
          );
          await deliverAction(callTelegram, env, owner, result.action);
          return Object.freeze({
            handled: true,
            status: "edit_saved",
            versionNo: result.stored.versionNo,
          });
        }

        if (target === "draft_stop") {
          const result = await stopAiPartnerOwnerTelegramNativeDraft(
            env,
            context,
            { draftId: actor.draftStop.draft_id, at },
            { ...generationDependencies, cryptoImpl },
          );
          await deliverAction(callTelegram, env, owner, result.action);
          return Object.freeze({ handled: true, status: "stopped" });
        }

        const data = String(actor.callback?.data || "");
        if (env.AI_PARTNER_OWNER_CONFIRMATION_UX_ENABLED === "true" &&
          data.startsWith("a38w:")) {
          const action = await handleOwnerConfirmedWriteCallback(env, context, data, at);
          try {
            await deliverAction(callTelegram, env, owner, action);
          } catch {
            await safelySend(callTelegram, env, owner,
              customEnvelope(owner, action.savedVersion
                ? `✅ Черновик сохранён, версия ${action.savedVersion.versionNo}. Карточка не доставлена; откройте «Мои черновики».`
                : "❌ Сохранение отменено. Ответ Telegram не доставлен.",
              [[callbackButton("📝 Мои черновики", "a38p:drafts:0")]]));
            return Object.freeze({ handled: true,
              status: action.savedVersion
                ? "saved_delivery_uncertain" : "cancelled_delivery_uncertain" });
          }
          return Object.freeze({ handled: true,
            status: action.savedVersion ? "write_saved" : "write_cancelled" });
        }
        if (env.AI_PARTNER_OWNER_CONFIRMATION_UX_ENABLED === "true" &&
          data.startsWith("a38m:")) {
          const action = await handleOwnerMemoryCallback(env, context, data, at);
          await deliverAction(callTelegram, env, owner, action);
          return Object.freeze({ handled: true, status: "memory_control" });
        }
        if (isBaseHubCallback(data)) {
          await sendHub(env, context);
          return Object.freeze({ handled: true, status: "hub" });
        }

        let dispatched;
        if (data.startsWith(`${AI_PARTNER_OWNER_WORKER_CALLBACK_PREFIX}:`)) {
          dispatched = await handleOwnerCustomCallback(
            env,
            context,
            data,
            { at, part4Api: resolvedPart4, cryptoImpl },
          );
        } else {
          dispatched = await handleAiPartnerOwnerTelegramCallback(
            env,
            context,
            data,
            {
              ...generationDependencies,
              cryptoImpl,
              at,
            },
          );
        }
        if (dispatched.background) {
          if (
            dispatched.background.type !==
              "execute_ai_partner_owner_generation" ||
            !UUID_V4.test(String(dispatched.background.generationId || ""))
          ) {
            throw runtimeError("ai_partner_owner_runtime_background_denied");
          }
          pendingInitialGenerationId = String(
            dispatched.background.generationId,
          ).toLowerCase();
        }
        await deliverAction(
          callTelegram,
          env,
          owner,
          dispatched.action,
          { phase: dispatched.background ? "initial" : "final" },
        );
        initialDeliveryCompleted = true;
        if (!dispatched.background) {
          return Object.freeze({ handled: true, status: "completed" });
        }
        const task = executeGenerationBackground(
          env,
          context,
          pendingInitialGenerationId,
        );
        const completion = await scheduleBackground(task, options.waitUntil);
        return Object.freeze({
          handled: true,
          status: completion.scheduled ? "generation_started"
            : completion.result?.ok === false ? "generation_failed"
            : completion.result?.status === "pending_confirmation"
              ? "generation_pending_confirmation" : "generation_completed",
          generationId: pendingInitialGenerationId,
        });
      } catch (error) {
        await recordOwnerTrace(env,
          `${target}_failed:${safeErrorCode(error?.code)}`);
        if (pendingInitialGenerationId && !initialDeliveryCompleted) {
          await safelyFailInitialDelivery(
            env,
            context,
            pendingInitialGenerationId,
            at,
            generationDependencies,
          );
        }
        await safelySend(
          callTelegram,
          env,
          owner,
          errorScreen(actor.chatId, error?.code),
        );
        return Object.freeze({
          handled: true,
          status: "failed",
          reason: safeErrorCode(error?.code),
        });
      }
    },
  });
}

export const aiPartnerOwnerWorkerRuntimePart5 =
  createAiPartnerOwnerWorkerRuntimePart5();
