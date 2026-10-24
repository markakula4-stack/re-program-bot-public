import {
  AI_PARTNER_DRAFT_TYPES,
  AI_PARTNER_LIMITS,
  AI_PARTNER_MODEL_ALIASES,
  assertAiPartnerOwnerScope,
  normalizeAiPartnerDraftType,
  readAiPartnerConfig,
  resolveAiPartnerModel,
} from "./ai-partner-foundation.mjs";
import {
  AI_PARTNER_DRAFT_NOTICE_RU,
  assertSafeAiPartnerPrompt,
  loadApprovedAiPartnerFactBundle,
  saveAiPartnerDraftVersion,
  validateAiPartnerModelOutput,
} from "./ai-partner-draft-runtime.mjs";

export const AI_PARTNER_TELEGRAM_UX_SCHEMA_VERSION = 1;
export const AI_PARTNER_TELEGRAM_CALLBACK_PREFIX = "a38";
export const AI_PARTNER_TELEGRAM_LIMITS = Object.freeze({
  callbackBytes: 64,
  messageChars: 3_500,
  streamPreviewChars: 3_200,
  streamEditIntervalMs: 750,
  maxDraftChars: 12_000,
  confirmationTokenChars: 22,
});

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const CONFIRMATION_TOKEN = /^[A-Za-z0-9_-]{22}$/;
const SAFE_CODE = /^[a-z0-9][a-z0-9_.-]{2,79}$/;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TEXT_ENCODER = new TextEncoder();
const TRUSTED_TELEGRAM_UPDATE = Symbol("trustedAiPartnerTelegramUpdate");
const TRUSTED_SHARE_AUTHORIZATION = Symbol(
  "trustedAiPartnerShareAuthorization",
);
const CHAT_TYPES = new Set(["private", "group", "supergroup", "channel"]);
const SESSION_STATES = new Set([
  "streaming",
  "stopped",
  "finalizing",
  "completed",
  "failed",
]);
const CALLBACK_PATTERNS = Object.freeze([
  Object.freeze({
    action: "stop",
    pattern: /^a38:stop:([0-9a-f-]{36})$/,
    fields: Object.freeze(["generationId"]),
  }),
  Object.freeze({
    action: "retry",
    pattern: /^a38:retry:([0-9a-f-]{36})$/,
    fields: Object.freeze(["generationId"]),
  }),
  Object.freeze({
    action: "view",
    pattern: /^a38:view:([0-9a-f-]{36}):([1-9][0-9]{0,5})$/,
    fields: Object.freeze(["draftId", "versionNo"]),
  }),
  Object.freeze({
    action: "edit",
    pattern: /^a38:edit:([0-9a-f-]{36}):([1-9][0-9]{0,5})$/,
    fields: Object.freeze(["draftId", "versionNo"]),
  }),
  Object.freeze({
    action: "share_ask",
    pattern: /^a38:shareask:([0-9a-f-]{36}):([1-9][0-9]{0,5})$/,
    fields: Object.freeze(["draftId", "versionNo"]),
  }),
  Object.freeze({
    action: "share_confirm",
    pattern: /^a38:share:([A-Za-z0-9_-]{22})$/,
    fields: Object.freeze(["confirmationToken"]),
  }),
  Object.freeze({
    action: "share_cancel",
    pattern: /^a38:cancel:([A-Za-z0-9_-]{22})$/,
    fields: Object.freeze(["confirmationToken"]),
  }),
  Object.freeze({
    action: "back",
    pattern: /^a38:back:(drafts|hub)$/,
    fields: Object.freeze(["destination"]),
  }),
]);
const DISABLED_COPY = Object.freeze({
  feature_disabled:
    "RE AI Partner пока выключен. Остальные функции бота продолжают работать.",
  unsupported_scope:
    "Этот режим интерфейса здесь недоступен. Используется обычное сообщение.",
  generation_stopped:
    "Генерация остановлена. Незавершённый текст не сохранён и не отправлен.",
  generation_failed:
    "Черновик не создан. Можно безопасно повторить попытку.",
  finalizing:
    "Черновик проходит финальную проверку. Отправка пока недоступна.",
  archived:
    "Черновик находится в архиве. Отправка и редактирование отключены.",
  stale_version:
    "Появилась новая версия. Откройте актуальный предпросмотр.",
  confirmation_expired:
    "Подтверждение истекло. Откройте предпросмотр и подтвердите снова.",
  confirmation_used:
    "Это подтверждение уже обработано. Повторная отправка не выполняется.",
});

function uxError(code, cause) {
  const error = new Error("AI Partner Telegram UX operation rejected");
  error.name = "AiPartnerTelegramUxError";
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
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function requireDatabase(env) {
  if (!env?.DB?.prepare || !env?.DB?.batch) {
    throw uxError("ai_partner_database_not_ready");
  }
  return env.DB;
}

function normalizeClock(value, code = "ai_partner_timestamp_invalid") {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw uxError(code);
  return parsed;
}

function normalizeUuid(value, code = "ai_partner_uuid_invalid") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!UUID_V4.test(normalized)) throw uxError(code);
  return normalized;
}

function normalizeKey(value, {
  code = "ai_partner_key_invalid",
  minimum = 16,
  maximum = 160,
} = {}) {
  const normalized = String(value || "").trim();
  if (
    normalized.length < minimum ||
    normalized.length > maximum ||
    !SAFE_KEY.test(normalized)
  ) {
    throw uxError(code);
  }
  return normalized;
}

function normalizeTitle(value) {
  const normalized = String(value || "Черновик").trim();
  if (!normalized || normalized.length > 160 || /[\u0000-\u001f]/u.test(normalized)) {
    throw uxError("ai_partner_draft_title_invalid");
  }
  return normalized;
}

function normalizeFailureCode(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 80);
  if (!SAFE_CODE.test(normalized)) {
    throw uxError("ai_partner_failure_code_invalid");
  }
  return normalized;
}

function normalizeGenerationModelAlias(value) {
  const normalized = String(value || "").trim();
  if (
    normalized !== AI_PARTNER_MODEL_ALIASES.safe &&
    normalized !== AI_PARTNER_MODEL_ALIASES.dragon
  ) {
    throw uxError("ai_partner_model_alias_invalid");
  }
  return normalized;
}

function providerCodeForModelAlias(modelAlias) {
  return modelAlias === AI_PARTNER_MODEL_ALIASES.dragon
    ? "deepseek"
    : "cloudflare";
}

function normalizeFallbackFlag(value) {
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0" || value === null) {
    return 0;
  }
  throw uxError("ai_partner_provider_fallback_invalid");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
      .join(",") +
    "}"
  );
}

async function sha256(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw uxError("ai_partner_crypto_unavailable");
  const digest = await cryptoImpl.subtle.digest(
    "SHA-256",
    TEXT_ENCODER.encode(String(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function defaultIdFactory() {
  if (!globalThis.crypto?.randomUUID) {
    throw uxError("ai_partner_random_uuid_unavailable");
  }
  return globalThis.crypto.randomUUID();
}

function defaultTokenFactory(cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.getRandomValues) {
    throw uxError("ai_partner_random_token_unavailable");
  }
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  const binary = [...bytes].map((value) => String.fromCharCode(value)).join("");
  const encoded =
    typeof btoa === "function"
      ? btoa(binary)
      : globalThis.Buffer?.from(bytes)?.toString("base64");
  if (!encoded) throw uxError("ai_partner_random_token_unavailable");
  return encoded.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function normalizeFactSourceIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw uxError("ai_partner_fact_source_ids_invalid");
  }
  const normalized = value.map((item) =>
    normalizeUuid(item, "ai_partner_fact_source_id_invalid")
  );
  if (new Set(normalized).size !== normalized.length) {
    throw uxError("ai_partner_fact_source_ids_duplicate");
  }
  return normalized.sort();
}

function freezeSession(row, replayed = false) {
  if (!row || !SESSION_STATES.has(String(row.generation_state))) {
    throw uxError("ai_partner_generation_not_found");
  }
  return deepFreeze({
    generationId: String(row.generation_id),
    generationKey: String(row.generation_key),
    ownerTelegramId: Number(row.owner_telegram_id),
    sourceDraftId: row.source_draft_id ? String(row.source_draft_id) : null,
    draftId: row.draft_id ? String(row.draft_id) : null,
    draftRequestKey: String(row.draft_request_key),
    versionRequestId: String(row.version_request_id),
    draftType: String(row.draft_type),
    title: String(row.draft_title),
    baseVersionNo: Number(row.base_version_no),
    modelAlias: String(row.model_alias),
    finalModelAlias: row.final_model_alias
      ? String(row.final_model_alias)
      : null,
    finalProviderCode: row.final_provider_code
      ? String(row.final_provider_code)
      : null,
    providerRequestId: row.final_provider_request_id
      ? String(row.final_provider_request_id)
      : null,
    providerFallbackUsed: Number(row.provider_fallback_used || 0) === 1,
    providerEvidenceSource: row.provider_evidence_source
      ? String(row.provider_evidence_source)
      : null,
    factSourceIds: JSON.parse(String(row.fact_source_ids_json)),
    factBundleHash: String(row.fact_bundle_hash),
    promptHash: String(row.prompt_hash),
    requestFingerprint: String(row.request_fingerprint),
    state: String(row.generation_state),
    attemptNo: Number(row.attempt_no),
    streamedChars: Number(row.streamed_chars),
    streamDigest: String(row.stream_digest),
    versionId: row.version_id ? String(row.version_id) : null,
    versionNo: row.version_no === null || row.version_no === undefined
      ? null
      : Number(row.version_no),
    failureCode: String(row.failure_code),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    stoppedAt: row.stopped_at === null ? null : Number(row.stopped_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    revision: Number(row.revision),
    replayed: Boolean(replayed),
  });
}

function requireTelegramContext(context, ownerTelegramId) {
  if (
    !plainObject(context) ||
    context[TRUSTED_TELEGRAM_UPDATE] !== true ||
    !context.config?.masterEnabled ||
    context.config.rolloutMode !== "admin" ||
    context.isAdmin !== true
  ) {
    throw uxError("ai_partner_verified_update_required");
  }
  try {
    assertAiPartnerOwnerScope(context.actorTelegramId, ownerTelegramId);
  } catch (cause) {
    throw uxError("ai_partner_owner_scope_denied", cause);
  }
  return Number(ownerTelegramId);
}

function requireTelegramCallbackContext(context, ownerTelegramId) {
  const owner = requireTelegramContext(context, ownerTelegramId);
  if (
    typeof context.callbackQueryId !== "string" ||
    context.callbackQueryId.length < 4
  ) {
    throw uxError("ai_partner_callback_context_required");
  }
  return owner;
}

export function createAiPartnerContextFromVerifiedUpdate(
  env,
  {
    actorTelegramId,
    updateId,
    callbackQueryId = null,
    chatType = "private",
    isAdmin = false,
  } = {},
) {
  const actor = Number(actorTelegramId);
  const numericUpdateId = Number(updateId);
  const normalizedChatType = String(chatType || "").trim().toLowerCase();
  if (!Number.isSafeInteger(actor) || actor <= 0) {
    throw uxError("ai_partner_actor_invalid");
  }
  if (!Number.isSafeInteger(numericUpdateId) || numericUpdateId < 0) {
    throw uxError("ai_partner_update_id_invalid");
  }
  if (!CHAT_TYPES.has(normalizedChatType)) {
    throw uxError("ai_partner_chat_type_invalid");
  }
  if (
    callbackQueryId !== null &&
    (typeof callbackQueryId !== "string" ||
      callbackQueryId.length < 4 ||
      callbackQueryId.length > 128 ||
      /[\u0000-\u001f]/u.test(callbackQueryId))
  ) {
    throw uxError("ai_partner_callback_query_id_invalid");
  }
  const config = readAiPartnerConfig(env);
  const model = resolveAiPartnerModel(config, { isAdmin: isAdmin === true });
  if (!config.masterEnabled || config.rolloutMode !== "admin" || !model.enabled) {
    throw uxError("ai_partner_feature_disabled");
  }
  return deepFreeze({
    [TRUSTED_TELEGRAM_UPDATE]: true,
    actorTelegramId: actor,
    updateId: numericUpdateId,
    callbackQueryId,
    chatType: normalizedChatType,
    isAdmin: isAdmin === true,
    config,
    model,
  });
}

export function buildAiPartnerTelegramCallback(action, payload = {}) {
  let value;
  switch (action) {
    case "stop":
    case "retry":
      value =
        AI_PARTNER_TELEGRAM_CALLBACK_PREFIX +
        ":" +
        action +
        ":" +
        normalizeUuid(payload.generationId, "ai_partner_generation_id_invalid");
      break;
    case "view":
    case "edit":
    case "share_ask": {
      const wireAction = action === "share_ask" ? "shareask" : action;
      const versionNo = Number(payload.versionNo);
      if (!Number.isSafeInteger(versionNo) || versionNo < 1 || versionNo > 999999) {
        throw uxError("ai_partner_version_number_invalid");
      }
      value =
        AI_PARTNER_TELEGRAM_CALLBACK_PREFIX +
        ":" +
        wireAction +
        ":" +
        normalizeUuid(payload.draftId, "ai_partner_draft_id_invalid") +
        ":" +
        versionNo;
      break;
    }
    case "share_confirm":
    case "share_cancel": {
      const token = String(payload.confirmationToken || "");
      if (!CONFIRMATION_TOKEN.test(token)) {
        throw uxError("ai_partner_confirmation_token_invalid");
      }
      value =
        AI_PARTNER_TELEGRAM_CALLBACK_PREFIX +
        ":" +
        (action === "share_confirm" ? "share" : "cancel") +
        ":" +
        token;
      break;
    }
    case "back": {
      const destination = String(payload.destination || "");
      if (destination !== "drafts" && destination !== "hub") {
        throw uxError("ai_partner_callback_destination_invalid");
      }
      value =
        AI_PARTNER_TELEGRAM_CALLBACK_PREFIX + ":back:" + destination;
      break;
    }
    default:
      throw uxError("ai_partner_callback_action_denied");
  }
  if (TEXT_ENCODER.encode(value).byteLength > AI_PARTNER_TELEGRAM_LIMITS.callbackBytes) {
    throw uxError("ai_partner_callback_too_large");
  }
  return value;
}

export function parseAiPartnerTelegramCallback(context, callbackData) {
  requireTelegramCallbackContext(context, context?.actorTelegramId);
  const value = String(callbackData || "");
  if (
    !value ||
    TEXT_ENCODER.encode(value).byteLength >
      AI_PARTNER_TELEGRAM_LIMITS.callbackBytes
  ) {
    throw uxError("ai_partner_callback_invalid");
  }
  for (const descriptor of CALLBACK_PATTERNS) {
    const match = value.match(descriptor.pattern);
    if (!match) continue;
    const parsed = { action: descriptor.action };
    descriptor.fields.forEach((field, index) => {
      let item = match[index + 1];
      if (field === "generationId" || field === "draftId") {
        item = normalizeUuid(item);
      } else if (field === "versionNo") {
        item = Number(item);
      }
      parsed[field] = item;
    });
    return deepFreeze(parsed);
  }
  throw uxError("ai_partner_callback_action_denied");
}

function fixedButton(text, callbackData) {
  const value = String(text || "").trim();
  if (!value || value.length > 64) throw uxError("ai_partner_button_text_invalid");
  if (
    TEXT_ENCODER.encode(String(callbackData || "")).byteLength >
    AI_PARTNER_TELEGRAM_LIMITS.callbackBytes
  ) {
    throw uxError("ai_partner_callback_too_large");
  }
  return Object.freeze({ text: value, callback_data: callbackData });
}

function splitTelegramText(text, maximum = AI_PARTNER_TELEGRAM_LIMITS.messageChars) {
  const normalized = String(text || "").trim();
  if (!normalized) return [""];
  const pages = [];
  let rest = normalized;
  while (rest.length > maximum) {
    let splitAt = rest.lastIndexOf("\n", maximum);
    if (splitAt < Math.floor(maximum * 0.6)) {
      splitAt = rest.lastIndexOf(" ", maximum);
    }
    if (splitAt < Math.floor(maximum * 0.6)) splitAt = maximum;
    pages.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trim();
  }
  if (rest) pages.push(rest);
  return pages;
}

function flattenCallbacks(keyboard) {
  return keyboard.flat().map((button) => button.callback_data);
}

function makeEnvelope({
  context,
  capabilities = {},
  kind,
  title,
  body,
  keyboard,
  status,
  disabledReason = null,
}) {
  const richEnabled =
    context?.config?.richMessagesEnabled === true &&
    capabilities.richMessages === true;
  const ephemeral =
    richEnabled &&
    capabilities.ephemeralUi === true &&
    context?.chatType === "private";
  const pages = splitTelegramText(body);
  const fallbackMessages = pages.map((text, index) =>
    deepFreeze({
      method: "sendMessage",
      text,
      reply_markup:
        index === pages.length - 1
          ? { inline_keyboard: keyboard }
          : { inline_keyboard: [] },
      parse_mode: null,
    })
  );
  const actions = keyboard.flat().map((button) => ({
    label: button.text,
    callbackData: button.callback_data,
  }));
  const richMessage = richEnabled
    ? deepFreeze({
        schemaVersion: AI_PARTNER_TELEGRAM_UX_SCHEMA_VERSION,
        kind,
        title,
        status,
        body: pages[0],
        pages,
        actions,
        ephemeral,
        disabledReason,
      })
    : null;
  return deepFreeze({
    mode: richEnabled ? "rich" : "plain",
    ephemeral,
    kind,
    status,
    disabledReason,
    primary: richMessage || { messages: fallbackMessages },
    richMessage,
    fallback: {
      messages: fallbackMessages,
      actionCallbacks: flattenCallbacks(keyboard),
    },
  });
}

export function renderAiPartnerDisabledState(
  context,
  {
    reason = "feature_disabled",
    capabilities = {},
    backDestination = "hub",
  } = {},
) {
  if (!Object.hasOwn(DISABLED_COPY, reason)) {
    throw uxError("ai_partner_disabled_reason_invalid");
  }
  const back = buildAiPartnerTelegramCallback("back", {
    destination: backDestination,
  });
  return makeEnvelope({
    context,
    capabilities,
    kind: "ai_partner_disabled",
    title: "RE AI Partner",
    status: "disabled",
    body: "🤖 RE AI Partner\n\n" + DISABLED_COPY[reason],
    keyboard: [[fixedButton("⬅️ Назад", back)]],
    disabledReason: reason,
  });
}

export function renderAiPartnerGenerationState(
  context,
  session,
  { capabilities = {} } = {},
) {
  const owner = requireTelegramContext(context, session?.ownerTelegramId);
  if (owner !== Number(session.ownerTelegramId) || !SESSION_STATES.has(session.state)) {
    throw uxError("ai_partner_generation_state_invalid");
  }
  const statusCopy = {
    streaming: "Готовлю проверяемый черновик…",
    stopped: DISABLED_COPY.generation_stopped,
    finalizing: DISABLED_COPY.finalizing,
    completed: "Черновик готов и сохранён как новая версия.",
    failed: DISABLED_COPY.generation_failed,
  }[session.state];
  const keyboard = [];
  if (session.state === "streaming") {
    keyboard.push([
      fixedButton(
        "⏹ Остановить",
        buildAiPartnerTelegramCallback("stop", {
          generationId: session.generationId,
        }),
      ),
    ]);
  } else if (session.state === "stopped" || session.state === "failed") {
    keyboard.push([
      fixedButton(
        "🔄 Повторить",
        buildAiPartnerTelegramCallback("retry", {
          generationId: session.generationId,
        }),
      ),
    ]);
  } else if (session.state === "completed" && session.draftId && session.versionId) {
    keyboard.push([
      fixedButton(
        "👁 Открыть черновик",
        buildAiPartnerTelegramCallback("view", {
          draftId: session.draftId,
          versionNo: session.versionNo || 1,
        }),
      ),
    ]);
  }
  keyboard.push([
    fixedButton(
      "⬅️ К RE AI",
      buildAiPartnerTelegramCallback("back", { destination: "hub" }),
    ),
  ]);
  return makeEnvelope({
    context,
    capabilities,
    kind: "ai_generation_status",
    title: "RE AI Partner",
    status: session.state,
    body:
      "🤖 RE AI Partner\n\n" +
      statusCopy +
      "\n\nПопытка: " +
      Number(session.attemptNo || 1) +
      ".",
    keyboard,
    disabledReason:
      session.state === "stopped"
        ? "generation_stopped"
        : session.state === "failed"
          ? "generation_failed"
          : session.state === "finalizing"
            ? "finalizing"
            : null,
  });
}

export function createAiPartnerStreamController({
  generationId,
  editIntervalMs = AI_PARTNER_TELEGRAM_LIMITS.streamEditIntervalMs,
  previewChars = AI_PARTNER_TELEGRAM_LIMITS.streamPreviewChars,
} = {}) {
  const normalizedGenerationId = normalizeUuid(
    generationId,
    "ai_partner_generation_id_invalid",
  );
  if (
    !Number.isSafeInteger(editIntervalMs) ||
    editIntervalMs < 250 ||
    editIntervalMs > 5_000
  ) {
    throw uxError("ai_partner_stream_interval_invalid");
  }
  if (
    !Number.isSafeInteger(previewChars) ||
    previewChars < 500 ||
    previewChars > AI_PARTNER_TELEGRAM_LIMITS.messageChars
  ) {
    throw uxError("ai_partner_stream_preview_limit_invalid");
  }
  let buffer = "";
  let stopped = false;
  let lastEmissionAt = null;
  const snapshot = (emit, at) =>
    deepFreeze({
      generationId: normalizedGenerationId,
      state: stopped ? "stopped" : "streaming",
      emit,
      preview: stopped ? "" : buffer.slice(-previewChars),
      charCount: buffer.length,
      emittedAt: emit ? at : null,
      sendable: false,
    });
  return Object.freeze({
    append(chunk, { at, force = false } = {}) {
      if (stopped) throw uxError("ai_partner_generation_stopped");
      const timestamp = Number(at);
      if (!Number.isFinite(timestamp) || timestamp < 0) {
        throw uxError("ai_partner_stream_clock_invalid");
      }
      const value = String(chunk || "");
      if (!value || /[\u0000]/u.test(value)) {
        throw uxError("ai_partner_stream_chunk_invalid");
      }
      if (buffer.length + value.length > AI_PARTNER_TELEGRAM_LIMITS.maxDraftChars) {
        throw uxError("ai_partner_stream_size_exceeded");
      }
      buffer += value;
      const emit =
        force ||
        lastEmissionAt === null ||
        timestamp - lastEmissionAt >= editIntervalMs;
      if (emit) lastEmissionAt = timestamp;
      return snapshot(emit, timestamp);
    },
    snapshot() {
      return snapshot(false, null);
    },
    stop() {
      if (stopped) return snapshot(false, null);
      stopped = true;
      buffer = "";
      return snapshot(true, null);
    },
  });
}

async function loadGenerationSession(database, generationId) {
  return database.prepare(
    `SELECT session.*, version.version_no,
            evidence.provider_request_id AS final_provider_request_id,
            evidence.final_model_alias, evidence.final_provider_code,
            evidence.fallback_used AS provider_fallback_used,
            evidence.evidence_source AS provider_evidence_source,
            evidence.recorded_at AS provider_recorded_at
     FROM ai_generation_sessions session
     LEFT JOIN ai_draft_versions version
       ON version.version_id = session.version_id
     LEFT JOIN ai_generation_provider_evidence evidence
       ON evidence.generation_id = session.generation_id
     WHERE session.generation_id = ?
     LIMIT 1`,
  ).bind(generationId).first();
}

async function loadGenerationSessionByKey(database, generationKey) {
  return database.prepare(
    `SELECT session.*, version.version_no,
            evidence.provider_request_id AS final_provider_request_id,
            evidence.final_model_alias, evidence.final_provider_code,
            evidence.fallback_used AS provider_fallback_used,
            evidence.evidence_source AS provider_evidence_source,
            evidence.recorded_at AS provider_recorded_at
     FROM ai_generation_sessions session
     LEFT JOIN ai_draft_versions version
       ON version.version_id = session.version_id
     LEFT JOIN ai_generation_provider_evidence evidence
       ON evidence.generation_id = session.generation_id
     WHERE session.generation_key = ?
     LIMIT 1`,
  ).bind(generationKey).first();
}

async function loadGenerationAction(database, actionKey) {
  return database.prepare(
    `SELECT action_id, action_key, generation_id, owner_telegram_id,
            action_type, from_state, to_state, attempt_no, detail_code,
            created_at
     FROM ai_generation_actions
     WHERE action_key = ?
     LIMIT 1`,
  ).bind(actionKey).first();
}

async function loadDraftForGeneration(database, draftId) {
  return database.prepare(
    `SELECT draft_id, owner_telegram_id, draft_type, draft_state,
            current_version_no
     FROM ai_drafts
     WHERE draft_id = ?
     LIMIT 1`,
  ).bind(draftId).first();
}

async function loadVersionByRequestId(database, requestId) {
  return database.prepare(
    `SELECT version.version_id, version.request_id, version.draft_id,
            version.version_no, version.generation_state, version.content,
            version.structured_payload_json, version.fact_source_ids_json,
            version.content_hash, version.model_alias, version.created_at,
            draft.owner_telegram_id, draft.draft_type, draft.draft_state,
            draft.current_version_no, draft.title
     FROM ai_draft_versions version
     JOIN ai_drafts draft ON draft.draft_id = version.draft_id
     WHERE version.request_id = ?
     LIMIT 1`,
  ).bind(requestId).first();
}

async function loadGenerationProviderEvidence(database, generationId) {
  return database.prepare(
    `SELECT generation_id, owner_telegram_id, provider_request_id,
            final_model_alias, final_provider_code, fallback_used,
            evidence_source, recorded_at
     FROM ai_generation_provider_evidence
     WHERE generation_id = ?
     LIMIT 1`,
  ).bind(generationId).first();
}

async function loadGatewayProviderEvidence(
  database,
  generationId,
  ownerTelegramId,
  attemptNo,
) {
  const requestId = `a138gateway:${generationId}:${Number(attemptNo)}`;
  return database.prepare(
    `SELECT metadata.request_id, metadata.final_model_alias,
            metadata.fallback_used
     FROM ai_gateway_usage_metadata metadata
     JOIN ai_gateway_budget_reservations reservation
       ON reservation.request_id = metadata.request_id
     WHERE metadata.request_id = ?
       AND reservation.owner_telegram_id = ?
       AND metadata.final_model_alias IN ('qwen_safe', 'deepseek_flash_dragon')
     LIMIT 1`,
  ).bind(requestId, ownerTelegramId).first();
}

function freezeProviderEvidence(row) {
  if (!row) throw uxError("ai_partner_provider_evidence_missing");
  const finalModelAlias = normalizeGenerationModelAlias(row.final_model_alias);
  const finalProviderCode = providerCodeForModelAlias(finalModelAlias);
  if (String(row.final_provider_code) !== finalProviderCode) {
    throw uxError("ai_partner_provider_evidence_mismatch");
  }
  return deepFreeze({
    generationId: String(row.generation_id),
    ownerTelegramId: Number(row.owner_telegram_id),
    providerRequestId: String(row.provider_request_id),
    finalModelAlias,
    finalProviderCode,
    fallbackUsed: Number(row.fallback_used) === 1,
    evidenceSource: String(row.evidence_source),
    recordedAt: Number(row.recorded_at),
  });
}

function assertProviderEvidenceMatches(actual, expected) {
  if (
    !actual ||
    actual.generationId !== expected.generationId ||
    actual.ownerTelegramId !== expected.ownerTelegramId ||
    actual.providerRequestId !== expected.providerRequestId ||
    actual.finalModelAlias !== expected.finalModelAlias ||
    actual.finalProviderCode !== expected.finalProviderCode ||
    actual.fallbackUsed !== expected.fallbackUsed ||
    actual.evidenceSource !== expected.evidenceSource
  ) {
    throw uxError("ai_partner_provider_evidence_replay_conflict");
  }
  return actual;
}

async function resolveProviderEvidence(
  database,
  {
    generationId,
    ownerTelegramId,
    sessionModelAlias,
    attemptNo,
    finalModelAlias = null,
    providerRequestId = null,
    fallbackUsed = false,
  },
) {
  const storedRow = await loadGenerationProviderEvidence(database, generationId);
  const explicit =
    finalModelAlias !== null || providerRequestId !== null;
  if (explicit && (finalModelAlias === null || providerRequestId === null)) {
    throw uxError("ai_partner_provider_evidence_input_incomplete");
  }
  let expected = null;
  if (explicit) {
    const normalizedAlias = normalizeGenerationModelAlias(finalModelAlias);
    const normalizedRequestId = normalizeKey(providerRequestId, {
      code: "ai_partner_provider_request_id_invalid",
      minimum: 16,
      maximum: 96,
    });
    expected = deepFreeze({
      generationId,
      ownerTelegramId,
      providerRequestId: normalizedRequestId,
      finalModelAlias: normalizedAlias,
      finalProviderCode: providerCodeForModelAlias(normalizedAlias),
      fallbackUsed: normalizeFallbackFlag(fallbackUsed) === 1,
      evidenceSource: "gateway",
    });
  }
  if (storedRow) {
    const stored = freezeProviderEvidence(storedRow);
    return expected
      ? assertProviderEvidenceMatches(stored, expected)
      : stored;
  }
  if (expected) return expected;

  const gateway = await loadGatewayProviderEvidence(
    database,
    generationId,
    ownerTelegramId,
    attemptNo,
  );
  if (gateway) {
    const normalizedAlias = normalizeGenerationModelAlias(
      gateway.final_model_alias,
    );
    return deepFreeze({
      generationId,
      ownerTelegramId,
      providerRequestId: String(gateway.request_id),
      finalModelAlias: normalizedAlias,
      finalProviderCode: providerCodeForModelAlias(normalizedAlias),
      fallbackUsed: Number(gateway.fallback_used) === 1,
      evidenceSource: "gateway",
    });
  }

  const compatibilityAlias = normalizeGenerationModelAlias(sessionModelAlias);
  return deepFreeze({
    generationId,
    ownerTelegramId,
    providerRequestId: `compat:${generationId}`,
    finalModelAlias: compatibilityAlias,
    finalProviderCode: providerCodeForModelAlias(compatibilityAlias),
    fallbackUsed: false,
    evidenceSource: "compatibility",
  });
}

async function ensureGenerationProviderEvidence(
  database,
  evidence,
  recordedAt,
) {
  const existing = await loadGenerationProviderEvidence(
    database,
    evidence.generationId,
  );
  if (existing) {
    return assertProviderEvidenceMatches(
      freezeProviderEvidence(existing),
      evidence,
    );
  }
  try {
    await database.prepare(
      `INSERT INTO ai_generation_provider_evidence (
         generation_id, owner_telegram_id, provider_request_id,
         final_model_alias, final_provider_code, fallback_used,
         evidence_source, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      evidence.generationId,
      evidence.ownerTelegramId,
      evidence.providerRequestId,
      evidence.finalModelAlias,
      evidence.finalProviderCode,
      evidence.fallbackUsed ? 1 : 0,
      evidence.evidenceSource,
      recordedAt,
    ).run();
  } catch (cause) {
    const concurrent = await loadGenerationProviderEvidence(
      database,
      evidence.generationId,
    );
    if (concurrent) {
      return assertProviderEvidenceMatches(
        freezeProviderEvidence(concurrent),
        evidence,
      );
    }
    throw uxError("ai_partner_provider_evidence_insert_rejected", cause);
  }
  return freezeProviderEvidence(
    await loadGenerationProviderEvidence(database, evidence.generationId),
  );
}

function actionKeyFor(context, action, generationId, attemptNo) {
  return normalizeKey(
    `${action}:${generationId}:${Number(attemptNo || 1)}:${context.updateId}`,
    { code: "ai_partner_action_key_invalid", minimum: 16, maximum: 160 },
  );
}

function assertActionReplay(row, {
  generationId,
  ownerTelegramId,
  actionType,
}) {
  if (
    !row ||
    String(row.generation_id) !== generationId ||
    Number(row.owner_telegram_id) !== ownerTelegramId ||
    String(row.action_type) !== actionType
  ) {
    throw uxError("ai_partner_action_replay_conflict");
  }
}

async function sessionFingerprint({
  ownerTelegramId,
  draftId,
  draftRequestKey,
  versionRequestId,
  draftType,
  title,
  modelAlias,
  factSourceIds,
  factBundleHash,
  promptHash,
  baseVersionNo,
}, cryptoImpl) {
  return sha256(canonicalJson({
    schemaVersion: AI_PARTNER_TELEGRAM_UX_SCHEMA_VERSION,
    ownerTelegramId,
    draftId,
    draftRequestKey,
    versionRequestId,
    draftType,
    title,
    modelAlias,
    factSourceIds,
    factBundleHash,
    promptHash,
    baseVersionNo,
  }), cryptoImpl);
}

function assertSameSessionRequest(existing, expected) {
  if (
    existing.ownerTelegramId !== expected.ownerTelegramId ||
    existing.sourceDraftId !== expected.draftId ||
    existing.draftRequestKey !== expected.draftRequestKey ||
    existing.versionRequestId !== expected.versionRequestId ||
    existing.draftType !== expected.draftType ||
    existing.title !== expected.title ||
    existing.modelAlias !== expected.modelAlias ||
    existing.promptHash !== expected.promptHash ||
    existing.baseVersionNo !== expected.baseVersionNo ||
    canonicalJson(existing.factSourceIds) !== canonicalJson(expected.factSourceIds) ||
    existing.requestFingerprint !== expected.requestFingerprint
  ) {
    throw uxError("ai_partner_generation_replay_conflict");
  }
}

export async function beginAiPartnerGenerationSession(
  env,
  context,
  {
    ownerTelegramId = context?.actorTelegramId,
    generationKey,
    draftId = null,
    draftRequestKey,
    versionRequestId,
    draftType,
    title = "Черновик",
    prompt,
    factSourceIds,
    startedAt,
    idFactory = defaultIdFactory,
    cryptoImpl = globalThis.crypto,
  } = {},
) {
  const database = requireDatabase(env);
  const owner = requireTelegramContext(context, ownerTelegramId);
  const timestamp = normalizeClock(startedAt, "ai_partner_generation_clock_invalid");
  const normalizedGenerationKey = normalizeKey(generationKey, {
    code: "ai_partner_generation_key_invalid",
    minimum: 16,
    maximum: 160,
  });
  const normalizedDraftRequestKey = normalizeKey(draftRequestKey, {
    code: "ai_partner_draft_request_key_invalid",
    minimum: 16,
    maximum: 160,
  });
  const normalizedVersionRequestId = normalizeKey(versionRequestId, {
    code: "ai_partner_version_request_id_invalid",
    minimum: 16,
    maximum: 96,
  });
  const type = normalizeAiPartnerDraftType(draftType);
  const normalizedTitle = normalizeTitle(title);
  const safePrompt = assertSafeAiPartnerPrompt(prompt);
  const promptHash = await sha256(safePrompt, cryptoImpl);
  const sourceIds = normalizeFactSourceIds(factSourceIds);
  const normalizedDraftId = draftId
    ? normalizeUuid(draftId, "ai_partner_draft_id_invalid")
    : null;
  const modelAlias = String(context.model?.modelAlias || "");
  if (
    modelAlias !== AI_PARTNER_MODEL_ALIASES.safe &&
    modelAlias !== AI_PARTNER_MODEL_ALIASES.dragon
  ) {
    throw uxError("ai_partner_model_alias_invalid");
  }

  let baseVersionNo = 0;
  if (normalizedDraftId) {
    const draft = await loadDraftForGeneration(database, normalizedDraftId);
    if (
      !draft ||
      Number(draft.owner_telegram_id) !== owner ||
      String(draft.draft_type) !== type
    ) {
      throw uxError("ai_partner_owner_scope_denied");
    }
    if (draft.draft_state !== "draft") {
      throw uxError("ai_partner_draft_unavailable");
    }
    baseVersionNo = Number(draft.current_version_no);
  }

  const replayRow = await loadGenerationSessionByKey(
    database,
    normalizedGenerationKey,
  );
  if (replayRow) {
    const existing = freezeSession(replayRow, true);
    const replayBaseVersionNo = existing.baseVersionNo;
    const requestFingerprint = await sessionFingerprint({
      ownerTelegramId: owner,
      draftId: normalizedDraftId,
      draftRequestKey: normalizedDraftRequestKey,
      versionRequestId: normalizedVersionRequestId,
      draftType: type,
      title: normalizedTitle,
      modelAlias,
      factSourceIds: sourceIds,
      factBundleHash: existing.factBundleHash,
      promptHash,
      baseVersionNo: replayBaseVersionNo,
    }, cryptoImpl);
    assertSameSessionRequest(existing, {
      ownerTelegramId: owner,
      draftId: normalizedDraftId,
      draftRequestKey: normalizedDraftRequestKey,
      versionRequestId: normalizedVersionRequestId,
      draftType: type,
      title: normalizedTitle,
      modelAlias,
      factSourceIds: sourceIds,
      promptHash,
      baseVersionNo: replayBaseVersionNo,
      requestFingerprint,
    });
    return existing;
  }

  const factBundle = await loadApprovedAiPartnerFactBundle(env, {
    actorTelegramId: owner,
    ownerTelegramId: owner,
    factSourceIds: sourceIds,
    generatedAt: timestamp,
    cryptoImpl,
  });
  const requestFingerprint = await sessionFingerprint({
    ownerTelegramId: owner,
    draftId: normalizedDraftId,
    draftRequestKey: normalizedDraftRequestKey,
    versionRequestId: normalizedVersionRequestId,
    draftType: type,
    title: normalizedTitle,
    modelAlias,
    factSourceIds: sourceIds,
    factBundleHash: factBundle.bundleHash,
    promptHash,
    baseVersionNo,
  }, cryptoImpl);
  const generationId = normalizeUuid(
    idFactory(),
    "ai_partner_generation_id_invalid",
  );
  const actionId = normalizeUuid(
    idFactory(),
    "ai_partner_action_id_invalid",
  );
  try {
    await database.batch([
      database.prepare(
        `INSERT INTO ai_generation_sessions (
           generation_id, generation_key, owner_telegram_id, source_draft_id,
           draft_id,
           draft_request_key, version_request_id, draft_type, draft_title,
           base_version_no, model_alias, fact_source_ids_json,
           fact_bundle_hash, prompt_hash, request_fingerprint,
           generation_state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'streaming', ?, ?)`,
      ).bind(
        generationId,
        normalizedGenerationKey,
        owner,
        normalizedDraftId,
        normalizedDraftId,
        normalizedDraftRequestKey,
        normalizedVersionRequestId,
        type,
        normalizedTitle,
        baseVersionNo,
        modelAlias,
        JSON.stringify(sourceIds),
        factBundle.bundleHash,
        promptHash,
        requestFingerprint,
        timestamp,
        timestamp,
      ),
      database.prepare(
        `INSERT INTO ai_generation_actions (
           action_id, action_key, generation_id, owner_telegram_id,
           action_type, from_state, to_state, attempt_no, created_at
         ) VALUES (?, ?, ?, ?, 'start', '', 'streaming', 1, ?)`,
      ).bind(
        actionId,
        `start:${generationId}`,
        generationId,
        owner,
        timestamp,
      ),
    ]);
  } catch (cause) {
    const concurrent = await loadGenerationSessionByKey(
      database,
      normalizedGenerationKey,
    );
    if (concurrent) {
      const existing = freezeSession(concurrent, true);
      assertSameSessionRequest(existing, {
        ownerTelegramId: owner,
        draftId: normalizedDraftId,
        draftRequestKey: normalizedDraftRequestKey,
        versionRequestId: normalizedVersionRequestId,
        draftType: type,
        title: normalizedTitle,
        modelAlias,
        factSourceIds: sourceIds,
        promptHash,
        baseVersionNo,
        requestFingerprint,
      });
      return existing;
    }
    throw uxError("ai_partner_generation_start_rejected", cause);
  }
  return freezeSession(
    await loadGenerationSession(database, generationId),
    false,
  );
}

export async function readAiPartnerGenerationSession(
  env,
  context,
  { ownerTelegramId = context?.actorTelegramId, generationId } = {},
) {
  const database = requireDatabase(env);
  const owner = requireTelegramContext(context, ownerTelegramId);
  const id = normalizeUuid(generationId, "ai_partner_generation_id_invalid");
  const row = await loadGenerationSession(database, id);
  if (!row || Number(row.owner_telegram_id) !== owner) {
    throw uxError("ai_partner_owner_scope_denied");
  }
  return freezeSession(row, false);
}

export async function recordAiPartnerGenerationProgress(
  env,
  context,
  {
    ownerTelegramId = context?.actorTelegramId,
    generationId,
    streamedChars,
    streamDigest,
    updatedAt,
  } = {},
) {
  const database = requireDatabase(env);
  const owner = requireTelegramContext(context, ownerTelegramId);
  const id = normalizeUuid(generationId, "ai_partner_generation_id_invalid");
  const chars = Number(streamedChars);
  const digest = String(streamDigest || "");
  const timestamp = normalizeClock(updatedAt, "ai_partner_generation_clock_invalid");
  if (
    !Number.isSafeInteger(chars) ||
    chars < 0 ||
    chars > AI_PARTNER_TELEGRAM_LIMITS.maxDraftChars ||
    (chars === 0 ? digest !== "" : !SHA_256.test(digest))
  ) {
    throw uxError("ai_partner_stream_progress_invalid");
  }
  const before = await loadGenerationSession(database, id);
  if (!before || Number(before.owner_telegram_id) !== owner) {
    throw uxError("ai_partner_owner_scope_denied");
  }
  if (before.generation_state !== "streaming") {
    throw uxError("ai_partner_generation_not_streaming");
  }
  if (
    Number(before.streamed_chars) === chars &&
    String(before.stream_digest) === digest
  ) {
    return freezeSession(before, true);
  }
  if (chars < Number(before.streamed_chars)) {
    throw uxError("ai_partner_stream_progress_invalid");
  }
  const result = await database.prepare(
    `UPDATE ai_generation_sessions
     SET streamed_chars = ?, stream_digest = ?, updated_at = ?,
         revision = revision + 1
     WHERE generation_id = ? AND owner_telegram_id = ?
       AND generation_state = 'streaming' AND revision = ?`,
  ).bind(
    chars,
    digest,
    timestamp,
    id,
    owner,
    Number(before.revision),
  ).run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    throw uxError("ai_partner_generation_concurrent_update");
  }
  return freezeSession(await loadGenerationSession(database, id), false);
}

export async function stopAiPartnerGenerationSession(
  env,
  context,
  {
    ownerTelegramId = context?.actorTelegramId,
    generationId,
    actionKey = null,
    stoppedAt,
    idFactory = defaultIdFactory,
  } = {},
) {
  const database = requireDatabase(env);
  const owner = requireTelegramContext(context, ownerTelegramId);
  const id = normalizeUuid(generationId, "ai_partner_generation_id_invalid");
  const timestamp = normalizeClock(stoppedAt, "ai_partner_generation_clock_invalid");
  const key = actionKey
    ? normalizeKey(actionKey, {
        code: "ai_partner_action_key_invalid",
        minimum: 16,
        maximum: 160,
      })
    : actionKeyFor(context, "stop", id, 1);
  const replay = await loadGenerationAction(database, key);
  if (replay) {
    assertActionReplay(replay, {
      generationId: id,
      ownerTelegramId: owner,
      actionType: "stop",
    });
    const current = await loadGenerationSession(database, id);
    if (!current || current.generation_state !== "stopped") {
      throw uxError("ai_partner_action_replay_conflict");
    }
    return freezeSession(current, true);
  }
  const before = await loadGenerationSession(database, id);
  if (!before || Number(before.owner_telegram_id) !== owner) {
    throw uxError("ai_partner_owner_scope_denied");
  }
  if (before.generation_state === "stopped") return freezeSession(before, true);
  if (before.generation_state !== "streaming") {
    throw uxError("ai_partner_generation_stop_denied");
  }
  if (timestamp < Number(before.updated_at)) {
    throw uxError("ai_partner_generation_clock_invalid");
  }
  const actionId = normalizeUuid(idFactory(), "ai_partner_action_id_invalid");
  try {
    const results = await database.batch([
      database.prepare(
        `UPDATE ai_generation_sessions
         SET generation_state = 'stopped', stopped_at = ?, updated_at = ?,
             revision = revision + 1
         WHERE generation_id = ? AND owner_telegram_id = ?
           AND generation_state = 'streaming' AND revision = ?`,
      ).bind(timestamp, timestamp, id, owner, Number(before.revision)),
      database.prepare(
        `INSERT INTO ai_generation_actions (
           action_id, action_key, generation_id, owner_telegram_id,
           action_type, from_state, to_state, attempt_no, created_at
         ) VALUES (?, ?, ?, ?, 'stop', 'streaming', 'stopped', ?, ?)`,
      ).bind(actionId, key, id, owner, Number(before.attempt_no), timestamp),
    ]);
    if (Number(results?.[0]?.meta?.changes || 0) !== 1) {
      throw uxError("ai_partner_generation_concurrent_update");
    }
  } catch (cause) {
    const concurrentReplay = await loadGenerationAction(database, key);
    if (concurrentReplay) {
      assertActionReplay(concurrentReplay, {
        generationId: id,
        ownerTelegramId: owner,
        actionType: "stop",
      });
      return freezeSession(await loadGenerationSession(database, id), true);
    }
    throw uxError("ai_partner_generation_stop_rejected", cause);
  }
  return freezeSession(await loadGenerationSession(database, id), false);
}

export async function retryAiPartnerGenerationSession(
  env,
  context,
  {
    ownerTelegramId = context?.actorTelegramId,
    generationId,
    actionKey = null,
    retriedAt,
    idFactory = defaultIdFactory,
  } = {},
) {
  const database = requireDatabase(env);
  const owner = requireTelegramContext(context, ownerTelegramId);
  const id = normalizeUuid(generationId, "ai_partner_generation_id_invalid");
  const timestamp = normalizeClock(retriedAt, "ai_partner_generation_clock_invalid");
  const before = await loadGenerationSession(database, id);
  if (!before || Number(before.owner_telegram_id) !== owner) {
    throw uxError("ai_partner_owner_scope_denied");
  }
  const key = actionKey
    ? normalizeKey(actionKey, {
        code: "ai_partner_action_key_invalid",
        minimum: 16,
        maximum: 160,
      })
    : actionKeyFor(context, "retry", id, Number(before.attempt_no) + 1);
  const replay = await loadGenerationAction(database, key);
  if (replay) {
    assertActionReplay(replay, {
      generationId: id,
      ownerTelegramId: owner,
      actionType: "retry",
    });
    return freezeSession(await loadGenerationSession(database, id), true);
  }
  if (!new Set(["stopped", "failed"]).has(before.generation_state)) {
    throw uxError("ai_partner_generation_retry_denied");
  }
  if (timestamp < Number(before.updated_at)) {
    throw uxError("ai_partner_generation_clock_invalid");
  }
  const nextAttempt = Number(before.attempt_no) + 1;
  const actionId = normalizeUuid(idFactory(), "ai_partner_action_id_invalid");
  try {
    const results = await database.batch([
      database.prepare(
        `UPDATE ai_generation_sessions
         SET generation_state = 'streaming', attempt_no = ?,
             streamed_chars = 0, stream_digest = '', failure_code = '',
             stopped_at = NULL, completed_at = NULL, updated_at = ?,
             revision = revision + 1
         WHERE generation_id = ? AND owner_telegram_id = ?
           AND generation_state = ? AND revision = ?`,
      ).bind(
        nextAttempt,
        timestamp,
        id,
        owner,
        String(before.generation_state),
        Number(before.revision),
      ),
      database.prepare(
        `INSERT INTO ai_generation_actions (
           action_id, action_key, generation_id, owner_telegram_id,
           action_type, from_state, to_state, attempt_no, created_at
         ) VALUES (?, ?, ?, ?, 'retry', ?, 'streaming', ?, ?)`,
      ).bind(
        actionId,
        key,
        id,
        owner,
        String(before.generation_state),
        nextAttempt,
        timestamp,
      ),
    ]);
    if (Number(results?.[0]?.meta?.changes || 0) !== 1) {
      throw uxError("ai_partner_generation_concurrent_update");
    }
  } catch (cause) {
    const concurrentReplay = await loadGenerationAction(database, key);
    if (concurrentReplay) {
      assertActionReplay(concurrentReplay, {
        generationId: id,
        ownerTelegramId: owner,
        actionType: "retry",
      });
      return freezeSession(await loadGenerationSession(database, id), true);
    }
    throw uxError("ai_partner_generation_retry_rejected", cause);
  }
  return freezeSession(await loadGenerationSession(database, id), false);
}

export async function failAiPartnerGenerationSession(
  env,
  context,
  {
    ownerTelegramId = context?.actorTelegramId,
    generationId,
    failureCode,
    actionKey = null,
    failedAt,
    idFactory = defaultIdFactory,
  } = {},
) {
  const database = requireDatabase(env);
  const owner = requireTelegramContext(context, ownerTelegramId);
  const id = normalizeUuid(generationId, "ai_partner_generation_id_invalid");
  const code = normalizeFailureCode(failureCode);
  const timestamp = normalizeClock(failedAt, "ai_partner_generation_clock_invalid");
  const before = await loadGenerationSession(database, id);
  if (!before || Number(before.owner_telegram_id) !== owner) {
    throw uxError("ai_partner_owner_scope_denied");
  }
  const key = actionKey
    ? normalizeKey(actionKey, {
        code: "ai_partner_action_key_invalid",
        minimum: 16,
        maximum: 160,
      })
    : actionKeyFor(context, "fail", id, Number(before.attempt_no));
  const replay = await loadGenerationAction(database, key);
  if (replay) {
    assertActionReplay(replay, {
      generationId: id,
      ownerTelegramId: owner,
      actionType: "fail",
    });
    return freezeSession(await loadGenerationSession(database, id), true);
  }
  if (before.generation_state === "failed") return freezeSession(before, true);
  if (!new Set(["streaming", "finalizing"]).has(before.generation_state)) {
    throw uxError("ai_partner_generation_fail_denied");
  }
  if (before.generation_state === "finalizing") {
    const stored = await loadVersionByRequestId(
      database,
      String(before.version_request_id),
    );
    if (stored) throw uxError("ai_partner_completion_recovery_required");
  }
  if (timestamp < Number(before.updated_at)) {
    throw uxError("ai_partner_generation_clock_invalid");
  }
  const actionId = normalizeUuid(idFactory(), "ai_partner_action_id_invalid");
  try {
    const results = await database.batch([
      database.prepare(
        `UPDATE ai_generation_sessions
         SET generation_state = 'failed', failure_code = ?,
             stopped_at = NULL, completed_at = NULL, updated_at = ?,
             revision = revision + 1
         WHERE generation_id = ? AND owner_telegram_id = ?
           AND generation_state = ? AND revision = ?`,
      ).bind(
        code,
        timestamp,
        id,
        owner,
        String(before.generation_state),
        Number(before.revision),
      ),
      database.prepare(
        `INSERT INTO ai_generation_actions (
           action_id, action_key, generation_id, owner_telegram_id,
           action_type, from_state, to_state, attempt_no, detail_code,
           created_at
         ) VALUES (?, ?, ?, ?, 'fail', ?, 'failed', ?, ?, ?)`,
      ).bind(
        actionId,
        key,
        id,
        owner,
        String(before.generation_state),
        Number(before.attempt_no),
        code,
        timestamp,
      ),
    ]);
    if (Number(results?.[0]?.meta?.changes || 0) !== 1) {
      throw uxError("ai_partner_generation_concurrent_update");
    }
  } catch (cause) {
    const concurrentReplay = await loadGenerationAction(database, key);
    if (concurrentReplay) {
      assertActionReplay(concurrentReplay, {
        generationId: id,
        ownerTelegramId: owner,
        actionType: "fail",
      });
      return freezeSession(await loadGenerationSession(database, id), true);
    }
    throw uxError("ai_partner_generation_fail_rejected", cause);
  }
  return freezeSession(await loadGenerationSession(database, id), false);
}

async function bindCompletedGeneration(
  database,
  owner,
  sessionRow,
  versionRow,
  completedAt,
  idFactory,
  expectedEvidence,
) {
  const generationId = String(sessionRow.generation_id);
  const evidence = assertProviderEvidenceMatches(
    freezeProviderEvidence(
      await loadGenerationProviderEvidence(database, generationId),
    ),
    expectedEvidence,
  );
  let storedPayload;
  try {
    storedPayload = JSON.parse(String(versionRow?.structured_payload_json || ""));
  } catch (cause) {
    throw uxError("ai_partner_generation_completion_mismatch", cause);
  }
  if (
    !versionRow ||
    Number(versionRow.owner_telegram_id) !== owner ||
    String(versionRow.request_id) !== String(sessionRow.version_request_id) ||
    String(versionRow.draft_type) !== String(sessionRow.draft_type) ||
    String(versionRow.generation_state) !== "complete" ||
    String(versionRow.model_alias) !== evidence.finalModelAlias ||
    String(versionRow.fact_source_ids_json) !==
      String(sessionRow.fact_source_ids_json) ||
    String(storedPayload?.factBundleHash || "") !==
      String(sessionRow.fact_bundle_hash) ||
    Number(versionRow.version_no) !== Number(sessionRow.base_version_no) + 1 ||
    Number(versionRow.current_version_no) !== Number(versionRow.version_no) ||
    !SHA_256.test(String(versionRow.content_hash || "")) ||
    (sessionRow.draft_id &&
      String(versionRow.draft_id) !== String(sessionRow.draft_id))
  ) {
    throw uxError("ai_partner_generation_completion_mismatch");
  }
  const existingAction = await loadGenerationAction(
    database,
    `complete:${generationId}:${Number(sessionRow.attempt_no)}`,
  );
  if (existingAction) {
    const current = await loadGenerationSession(database, generationId);
    if (current?.generation_state !== "completed") {
      throw uxError("ai_partner_action_replay_conflict");
    }
    return freezeSession(current, true);
  }
  const timestamp = normalizeClock(
    completedAt,
    "ai_partner_generation_clock_invalid",
  );
  if (timestamp < Number(sessionRow.updated_at)) {
    throw uxError("ai_partner_generation_clock_invalid");
  }
  const actionId = normalizeUuid(idFactory(), "ai_partner_action_id_invalid");
  const results = await database.batch([
    database.prepare(
      `UPDATE ai_generation_sessions
       SET generation_state = 'completed', draft_id = ?, version_id = ?,
           streamed_chars = ?, stream_digest = ?, failure_code = '',
           completed_at = ?, updated_at = ?, revision = revision + 1
       WHERE generation_id = ? AND owner_telegram_id = ?
         AND generation_state = 'finalizing' AND revision = ?`,
    ).bind(
      String(versionRow.draft_id),
      String(versionRow.version_id),
      String(versionRow.content).length,
      String(versionRow.content_hash),
      timestamp,
      timestamp,
      generationId,
      owner,
      Number(sessionRow.revision),
    ),
    database.prepare(
      `INSERT INTO ai_generation_actions (
         action_id, action_key, generation_id, owner_telegram_id,
         action_type, from_state, to_state, attempt_no, created_at
       ) VALUES (?, ?, ?, ?, 'complete', 'finalizing', 'completed', ?, ?)`,
    ).bind(
      actionId,
      `complete:${generationId}:${Number(sessionRow.attempt_no)}`,
      generationId,
      owner,
      Number(sessionRow.attempt_no),
      timestamp,
    ),
  ]);
  if (Number(results?.[0]?.meta?.changes || 0) !== 1) {
    throw uxError("ai_partner_generation_concurrent_update");
  }
  return freezeSession(
    await loadGenerationSession(database, generationId),
    false,
  );
}

export async function completeAiPartnerGenerationSession(
  env,
  context,
  {
    ownerTelegramId = context?.actorTelegramId,
    generationId,
    output,
    finalModelAlias = null,
    providerRequestId = null,
    fallbackUsed = false,
    completedAt,
    idFactory = defaultIdFactory,
    cryptoImpl = globalThis.crypto,
  } = {},
) {
  const database = requireDatabase(env);
  const owner = requireTelegramContext(context, ownerTelegramId);
  const id = normalizeUuid(generationId, "ai_partner_generation_id_invalid");
  const timestamp = normalizeClock(
    completedAt,
    "ai_partner_generation_clock_invalid",
  );
  let sessionRow = await loadGenerationSession(database, id);
  if (!sessionRow || Number(sessionRow.owner_telegram_id) !== owner) {
    throw uxError("ai_partner_owner_scope_denied");
  }
  let evidence = await resolveProviderEvidence(database, {
    generationId: id,
    ownerTelegramId: owner,
    sessionModelAlias: String(sessionRow.model_alias),
    attemptNo: Number(sessionRow.attempt_no),
    finalModelAlias,
    providerRequestId,
    fallbackUsed,
  });
  if (sessionRow.generation_state === "completed") {
    evidence = assertProviderEvidenceMatches(
      freezeProviderEvidence(
        await loadGenerationProviderEvidence(database, id),
      ),
      evidence,
    );
    return freezeSession(await loadGenerationSession(database, id), true);
  }
  if (!new Set(["streaming", "finalizing"]).has(sessionRow.generation_state)) {
    throw uxError("ai_partner_generation_completion_denied");
  }

  let stored = await loadVersionByRequestId(
    database,
    String(sessionRow.version_request_id),
  );
  if (stored) {
    if (sessionRow.generation_state !== "finalizing") {
      throw uxError("ai_partner_generation_completion_mismatch");
    }
    evidence = await ensureGenerationProviderEvidence(
      database,
      evidence,
      timestamp,
    );
    return bindCompletedGeneration(
      database,
      owner,
      sessionRow,
      stored,
      timestamp,
      idFactory,
      evidence,
    );
  }

  let validated;
  let contentHash;
  try {
    const factBundle = await loadApprovedAiPartnerFactBundle(env, {
      actorTelegramId: owner,
      ownerTelegramId: owner,
      factSourceIds: JSON.parse(String(sessionRow.fact_source_ids_json)),
      generatedAt: timestamp,
      cryptoImpl,
    });
    if (factBundle.bundleHash !== String(sessionRow.fact_bundle_hash)) {
      throw uxError("ai_partner_fact_bundle_changed");
    }
    validated = validateAiPartnerModelOutput({
      draftType: String(sessionRow.draft_type),
      output,
      factBundle,
    });
    contentHash = await sha256(validated.content, cryptoImpl);
  } catch (cause) {
    await failAiPartnerGenerationSession(env, context, {
      ownerTelegramId: owner,
      generationId: id,
      failureCode: cause?.code || "model_output_rejected",
      actionKey: `fail:${id}:${Number(sessionRow.attempt_no)}`,
      failedAt: timestamp,
      idFactory,
    });
    throw cause;
  }

  if (sessionRow.generation_state === "streaming") {
    const actionId = normalizeUuid(idFactory(), "ai_partner_action_id_invalid");
    try {
      const results = await database.batch([
        database.prepare(
          `UPDATE ai_generation_sessions
           SET generation_state = 'finalizing', streamed_chars = ?,
               stream_digest = ?, updated_at = ?, revision = revision + 1
           WHERE generation_id = ? AND owner_telegram_id = ?
             AND generation_state = 'streaming' AND revision = ?`,
        ).bind(
          validated.content.length,
          contentHash,
          timestamp,
          id,
          owner,
          Number(sessionRow.revision),
        ),
        database.prepare(
          `INSERT INTO ai_generation_actions (
             action_id, action_key, generation_id, owner_telegram_id,
             action_type, from_state, to_state, attempt_no, created_at
           ) VALUES (?, ?, ?, ?, 'finalize', 'streaming', 'finalizing', ?, ?)`,
        ).bind(
          actionId,
          `finalize:${id}:${Number(sessionRow.attempt_no)}`,
          id,
          owner,
          Number(sessionRow.attempt_no),
          timestamp,
        ),
      ]);
      if (Number(results?.[0]?.meta?.changes || 0) !== 1) {
        throw uxError("ai_partner_generation_concurrent_update");
      }
    } catch (cause) {
      const concurrent = await loadGenerationSession(database, id);
      if (concurrent?.generation_state === "stopped") {
        throw uxError("ai_partner_generation_completion_denied", cause);
      }
      throw uxError("ai_partner_generation_finalize_rejected", cause);
    }
    sessionRow = await loadGenerationSession(database, id);
  }

  try {
    await saveAiPartnerDraftVersion(env, {
      actorTelegramId: owner,
      ownerTelegramId: owner,
      draftId: sessionRow.draft_id ? String(sessionRow.draft_id) : null,
      requestKey: String(sessionRow.draft_request_key),
      requestId: String(sessionRow.version_request_id),
      draftType: String(sessionRow.draft_type),
      title: String(sessionRow.draft_title),
      output,
      expectedCurrentVersionNo: Number(sessionRow.base_version_no),
      modelAlias: evidence.finalModelAlias,
      createdAt: timestamp,
      idFactory,
      cryptoImpl,
    });
  } catch (cause) {
    stored = await loadVersionByRequestId(
      database,
      String(sessionRow.version_request_id),
    );
    if (!stored) {
      await failAiPartnerGenerationSession(env, context, {
        ownerTelegramId: owner,
        generationId: id,
        failureCode: cause?.code || "draft_save_failed",
        actionKey: `fail:${id}:${Number(sessionRow.attempt_no)}`,
        failedAt: timestamp,
        idFactory,
      });
      throw cause;
    }
  }
  stored ||= await loadVersionByRequestId(
    database,
    String(sessionRow.version_request_id),
  );
  sessionRow = await loadGenerationSession(database, id);
  evidence = await ensureGenerationProviderEvidence(
    database,
    evidence,
    timestamp,
  );
  return bindCompletedGeneration(
    database,
    owner,
    sessionRow,
    stored,
    timestamp,
    idFactory,
    evidence,
  );
}

async function loadDraftVersion(database, draftId, versionNo) {
  return database.prepare(
    `SELECT draft.draft_id, draft.owner_telegram_id, draft.draft_type,
            draft.draft_state, draft.title, draft.current_version_no,
            version.version_id, version.version_no, version.version_origin,
            version.generation_state, version.content,
            version.structured_payload_json, version.fact_source_ids_json,
            version.warnings_json, version.content_hash,
            version.model_alias, version.created_at
     FROM ai_drafts draft
     JOIN ai_draft_versions version ON version.draft_id = draft.draft_id
     WHERE draft.draft_id = ? AND version.version_no = ?
     LIMIT 1`,
  ).bind(draftId, versionNo).first();
}

function freezeDraftPreview(row, replayed = false) {
  if (!row) throw uxError("ai_partner_draft_version_not_found");
  let structuredPayload;
  let factSourceIds;
  let warnings;
  try {
    structuredPayload = JSON.parse(String(row.structured_payload_json));
    factSourceIds = JSON.parse(String(row.fact_source_ids_json));
    warnings = JSON.parse(String(row.warnings_json));
  } catch (cause) {
    throw uxError("ai_partner_draft_payload_invalid", cause);
  }
  return deepFreeze({
    draftId: String(row.draft_id),
    ownerTelegramId: Number(row.owner_telegram_id),
    draftType: String(row.draft_type),
    draftState: String(row.draft_state),
    title: String(row.title),
    currentVersionNo: Number(row.current_version_no),
    versionId: String(row.version_id),
    versionNo: Number(row.version_no),
    versionOrigin: String(row.version_origin),
    generationState: String(row.generation_state),
    content: String(row.content),
    structuredPayload,
    factSourceIds,
    warnings,
    contentHash: String(row.content_hash),
    modelAlias: String(row.model_alias),
    createdAt: Number(row.created_at),
    current: Number(row.current_version_no) === Number(row.version_no),
    replayed: Boolean(replayed),
  });
}

function normalizeVersionNo(value) {
  const versionNo = Number(value);
  if (!Number.isSafeInteger(versionNo) || versionNo < 1 || versionNo > 999999) {
    throw uxError("ai_partner_version_number_invalid");
  }
  return versionNo;
}

export async function readAiPartnerDraftPreview(
  env,
  context,
  {
    ownerTelegramId = context?.actorTelegramId,
    draftId,
    versionNo,
  } = {},
) {
  const database = requireDatabase(env);
  const owner = requireTelegramCallbackContext(context, ownerTelegramId);
  const id = normalizeUuid(draftId, "ai_partner_draft_id_invalid");
  const number = normalizeVersionNo(versionNo);
  const row = await loadDraftVersion(database, id, number);
  if (!row || Number(row.owner_telegram_id) !== owner) {
    throw uxError("ai_partner_owner_scope_denied");
  }
  return freezeDraftPreview(row, false);
}

export function renderAiPartnerDraftPreview(
  context,
  preview,
  { capabilities = {} } = {},
) {
  requireTelegramContext(context, preview?.ownerTelegramId);
  if (
    !preview?.draftId ||
    !preview?.versionId ||
    !Number.isSafeInteger(Number(preview.versionNo)) ||
    !SHA_256.test(String(preview.contentHash || ""))
  ) {
    throw uxError("ai_partner_draft_preview_invalid");
  }
  const keyboard = [];
  let disabledReason = null;
  if (preview.draftState === "archived") {
    disabledReason = "archived";
  } else if (!preview.current) {
    disabledReason = "stale_version";
  } else if (preview.generationState !== "complete") {
    disabledReason = "generation_stopped";
  } else {
    keyboard.push([
      fixedButton(
        "✏️ Редактировать",
        buildAiPartnerTelegramCallback("edit", {
          draftId: preview.draftId,
          versionNo: preview.versionNo,
        }),
      ),
      fixedButton(
        "📨 Подготовить отправку",
        buildAiPartnerTelegramCallback("share_ask", {
          draftId: preview.draftId,
          versionNo: preview.versionNo,
        }),
      ),
    ]);
  }
  keyboard.push([
    fixedButton(
      "⬅️ К черновикам",
      buildAiPartnerTelegramCallback("back", { destination: "drafts" }),
    ),
  ]);
  const warning = disabledReason ? `\n\n${DISABLED_COPY[disabledReason]}` : "";
  return makeEnvelope({
    context,
    capabilities,
    kind: "ai_draft_preview",
    title: preview.title,
    status: disabledReason ? "disabled" : "ready",
    body:
      `📝 ${preview.title}\nВерсия ${preview.versionNo}` +
      `\n\n${preview.content}${warning}`,
    keyboard,
    disabledReason,
  });
}

const EDIT_FACT_PLACEHOLDER =
  /\{\{fact:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):((?:[A-Za-z_][A-Za-z0-9_]{0,63}|[0-9]{1,2})(?:\.(?:[A-Za-z_][A-Za-z0-9_]{0,63}|[0-9]{1,2})){0,7})\}\}/g;

function collectEditableStrings(value, target = []) {
  if (typeof value === "string") target.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectEditableStrings(item, target);
  } else if (plainObject(value)) {
    for (const item of Object.values(value)) collectEditableStrings(item, target);
  }
  return target;
}

function collectPlaceholderMultiset(value) {
  const tokens = [];
  for (const text of collectEditableStrings(value)) {
    for (const match of text.matchAll(EDIT_FACT_PLACEHOLDER)) tokens.push(match[0]);
  }
  return tokens.sort();
}

function assertExactPlaceholderSet(original, edited) {
  const before = collectPlaceholderMultiset(original);
  const after = collectPlaceholderMultiset(edited);
  if (
    before.length < 1 ||
    before.length !== after.length ||
    before.some((token, index) => token !== after[index])
  ) {
    throw uxError("ai_partner_edit_fact_bindings_changed");
  }
}

export async function readAiPartnerEditDescriptor(
  env,
  context,
  {
    ownerTelegramId = context?.actorTelegramId,
    draftId,
    versionNo,
  } = {},
) {
  const preview = await readAiPartnerDraftPreview(env, context, {
    ownerTelegramId,
    draftId,
    versionNo,
  });
  if (
    preview.draftState !== "draft" ||
    !preview.current ||
    preview.generationState !== "complete"
  ) {
    throw uxError("ai_partner_edit_stale_version");
  }
  const templateFields = preview.structuredPayload?.templateFields;
  if (!plainObject(templateFields)) {
    throw uxError("ai_partner_edit_template_unavailable");
  }
  return deepFreeze({
    draftId: preview.draftId,
    draftType: preview.draftType,
    title: preview.title,
    baseVersionNo: preview.versionNo,
    templateFields,
    factBindings: collectPlaceholderMultiset(templateFields),
    notice: AI_PARTNER_DRAFT_NOTICE_RU,
  });
}

export async function saveAiPartnerEditedDraftVersion(
  env,
  context,
  {
    ownerTelegramId = context?.actorTelegramId,
    draftId,
    baseVersionNo,
    output,
    requestId,
    editedAt,
    idFactory = defaultIdFactory,
    cryptoImpl = globalThis.crypto,
  } = {},
) {
  const owner = requireTelegramContext(context, ownerTelegramId);
  const descriptor = await readAiPartnerEditDescriptor(env, context, {
    ownerTelegramId: owner,
    draftId,
    versionNo: baseVersionNo,
  });
  if (!plainObject(output)) throw uxError("ai_partner_edit_payload_invalid");
  assertExactPlaceholderSet(descriptor.templateFields, output);
  const stored = await saveAiPartnerDraftVersion(env, {
    actorTelegramId: owner,
    ownerTelegramId: owner,
    draftId: descriptor.draftId,
    requestId: normalizeKey(requestId, {
      code: "ai_partner_edit_request_id_invalid",
      minimum: 16,
      maximum: 96,
    }),
    draftType: descriptor.draftType,
    title: descriptor.title,
    output,
    expectedCurrentVersionNo: descriptor.baseVersionNo,
    modelAlias: AI_PARTNER_MODEL_ALIASES.humanEdit,
    createdAt: normalizeClock(editedAt, "ai_partner_edit_clock_invalid"),
    idFactory,
    cryptoImpl,
  });
  return deepFreeze({
    ...stored,
    humanEdited: true,
  });
}

async function loadCurrentDraftVersion(database, draftId, versionNo) {
  const row = await loadDraftVersion(database, draftId, versionNo);
  if (
    !row ||
    row.draft_state !== "draft" ||
    row.generation_state !== "complete" ||
    Number(row.current_version_no) !== Number(row.version_no)
  ) {
    return null;
  }
  return row;
}

async function loadShareIntentByKey(database, intentKey) {
  return database.prepare(
    `SELECT intent.*, version.version_no, version.content,
            draft.draft_type, draft.draft_state, draft.current_version_no,
            draft.title
     FROM ai_share_intents intent
     JOIN ai_draft_versions version ON version.version_id = intent.version_id
     JOIN ai_drafts draft ON draft.draft_id = intent.draft_id
     WHERE intent.intent_key = ?
     LIMIT 1`,
  ).bind(intentKey).first();
}

async function loadShareIntentByTokenHash(database, tokenHash) {
  return database.prepare(
    `SELECT intent.*, version.version_no, version.content,
            version.content_hash, version.generation_state,
            draft.draft_type, draft.draft_state, draft.current_version_no,
            draft.title
     FROM ai_share_intents intent
     JOIN ai_draft_versions version ON version.version_id = intent.version_id
     JOIN ai_drafts draft ON draft.draft_id = intent.draft_id
     WHERE intent.confirmation_token_hash = ?
     LIMIT 1`,
  ).bind(tokenHash).first();
}

function freezeShareIntent(row, confirmationToken, replayed = false) {
  if (!row) throw uxError("ai_partner_share_intent_not_found");
  return deepFreeze({
    shareIntentId: String(row.share_intent_id),
    ownerTelegramId: Number(row.owner_telegram_id),
    draftId: String(row.draft_id),
    versionId: String(row.version_id),
    versionNo: Number(row.version_no),
    title: String(row.title),
    content: String(row.content),
    previewHash: String(row.preview_hash),
    confirmationToken,
    state: String(row.intent_state),
    issuedAt: Number(row.issued_at),
    expiresAt: Number(row.expires_at),
    replayed: Boolean(replayed),
  });
}

export async function prepareAiPartnerShareConfirmation(
  env,
  context,
  {
    ownerTelegramId = context?.actorTelegramId,
    draftId,
    versionNo,
    intentKey,
    deliveryKey,
    confirmationToken = null,
    issuedAt,
    ttlSeconds = AI_PARTNER_LIMITS.confirmationTtlSeconds,
    idFactory = defaultIdFactory,
    tokenFactory = defaultTokenFactory,
    cryptoImpl = globalThis.crypto,
  } = {},
) {
  const database = requireDatabase(env);
  const owner = requireTelegramContext(context, ownerTelegramId);
  const id = normalizeUuid(draftId, "ai_partner_draft_id_invalid");
  const number = normalizeVersionNo(versionNo);
  const timestamp = normalizeClock(issuedAt, "ai_partner_share_clock_invalid");
  const ttl = Number(ttlSeconds);
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < 60 ||
    ttl > AI_PARTNER_LIMITS.confirmationTtlSeconds ||
    ttl > Number(context.config.confirmationTtlSeconds)
  ) {
    throw uxError("ai_partner_confirmation_ttl_invalid");
  }
  const normalizedIntentKey = normalizeKey(intentKey, {
    code: "ai_partner_share_intent_key_invalid",
    minimum: 16,
    maximum: 160,
  });
  const normalizedDeliveryKey = normalizeKey(deliveryKey, {
    code: "ai_partner_delivery_key_invalid",
    minimum: 16,
    maximum: 96,
  });
  const token = confirmationToken === null
    ? tokenFactory(cryptoImpl)
    : String(confirmationToken);
  if (!CONFIRMATION_TOKEN.test(token)) {
    throw uxError("ai_partner_confirmation_token_invalid");
  }
  const tokenHash = await sha256(token, cryptoImpl);

  const exact = await loadDraftVersion(database, id, number);
  if (!exact || Number(exact.owner_telegram_id) !== owner) {
    throw uxError("ai_partner_owner_scope_denied");
  }
  if (
    exact.draft_state !== "draft" ||
    exact.generation_state !== "complete" ||
    Number(exact.current_version_no) !== number
  ) {
    throw uxError("ai_partner_share_stale_version");
  }

  const replay = await loadShareIntentByKey(database, normalizedIntentKey);
  if (replay) {
    if (
      Number(replay.owner_telegram_id) !== owner ||
      String(replay.draft_id) !== id ||
      String(replay.version_id) !== String(exact.version_id) ||
      String(replay.preview_hash) !== String(exact.content_hash) ||
      String(replay.delivery_key) !== normalizedDeliveryKey ||
      String(replay.confirmation_token_hash) !== tokenHash
    ) {
      throw uxError("ai_partner_share_intent_replay_conflict");
    }
    return freezeShareIntent(replay, token, true);
  }

  const shareIntentId = normalizeUuid(
    idFactory(),
    "ai_partner_share_intent_id_invalid",
  );
  try {
    await database.prepare(
      `INSERT INTO ai_share_intents (
         share_intent_id, intent_key, delivery_key, owner_telegram_id,
         draft_id, version_id, preview_hash, confirmation_token_hash,
         intent_state, issued_at, expires_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).bind(
      shareIntentId,
      normalizedIntentKey,
      normalizedDeliveryKey,
      owner,
      id,
      String(exact.version_id),
      String(exact.content_hash),
      tokenHash,
      timestamp,
      timestamp + ttl,
      timestamp,
    ).run();
  } catch (cause) {
    const concurrent = await loadShareIntentByKey(database, normalizedIntentKey);
    if (
      concurrent &&
      Number(concurrent.owner_telegram_id) === owner &&
      String(concurrent.draft_id) === id &&
      String(concurrent.version_id) === String(exact.version_id) &&
      String(concurrent.preview_hash) === String(exact.content_hash) &&
      String(concurrent.delivery_key) === normalizedDeliveryKey &&
      String(concurrent.confirmation_token_hash) === tokenHash
    ) {
      return freezeShareIntent(concurrent, token, true);
    }
    throw uxError("ai_partner_share_intent_rejected", cause);
  }
  return freezeShareIntent(
    await loadShareIntentByKey(database, normalizedIntentKey),
    token,
    false,
  );
}

export function renderAiPartnerShareConfirmation(
  context,
  intent,
  { capabilities = {} } = {},
) {
  requireTelegramContext(context, intent?.ownerTelegramId);
  if (
    intent?.state !== "pending" ||
    !CONFIRMATION_TOKEN.test(String(intent.confirmationToken || "")) ||
    !SHA_256.test(String(intent.previewHash || ""))
  ) {
    throw uxError("ai_partner_share_confirmation_invalid");
  }
  const confirm = buildAiPartnerTelegramCallback("share_confirm", {
    confirmationToken: intent.confirmationToken,
  });
  const cancel = buildAiPartnerTelegramCallback("share_cancel", {
    confirmationToken: intent.confirmationToken,
  });
  return makeEnvelope({
    context,
    capabilities,
    kind: "ai_share_confirmation",
    title: intent.title,
    status: "confirmation_required",
    body:
      `📨 Подтверждение отправки\n\n${intent.content}` +
      "\n\nБудет использована именно эта версия. Подтверждение одноразовое" +
      " и действует не более 10 минут.",
    keyboard: [
      [
        fixedButton("✅ Подтвердить", confirm),
        fixedButton("❌ Отмена", cancel),
      ],
    ],
    disabledReason: null,
  });
}

async function resolvePendingShareIntent(
  database,
  row,
  state,
  resolvedAt,
) {
  const result = await database.prepare(
    `UPDATE ai_share_intents
     SET intent_state = ?, resolved_at = ?, updated_at = ?,
         revision = revision + 1
     WHERE share_intent_id = ? AND intent_state = 'pending'
       AND revision = ?`,
  ).bind(
    state,
    resolvedAt,
    resolvedAt,
    String(row.share_intent_id),
    Number(row.revision),
  ).run();
  return Number(result?.meta?.changes || 0) === 1;
}

function makeShareAuthorization(row, consumedAt) {
  const authorization = {
    schemaVersion: AI_PARTNER_TELEGRAM_UX_SCHEMA_VERSION,
    ownerTelegramId: Number(row.owner_telegram_id),
    draftId: String(row.draft_id),
    versionId: String(row.version_id),
    versionNo: Number(row.version_no),
    previewHash: String(row.preview_hash),
    deliveryKey: String(row.delivery_key),
    consumedAt,
  };
  Object.defineProperty(authorization, TRUSTED_SHARE_AUTHORIZATION, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return deepFreeze(authorization);
}

export function assertAiPartnerShareAuthorization(
  authorization,
  { ownerTelegramId } = {},
) {
  const owner = Number(ownerTelegramId);
  if (
    !plainObject(authorization) ||
    authorization[TRUSTED_SHARE_AUTHORIZATION] !== true ||
    !Number.isSafeInteger(owner) ||
    owner <= 0 ||
    authorization.ownerTelegramId !== owner ||
    !SHA_256.test(String(authorization.previewHash || "")) ||
    !authorization.deliveryKey
  ) {
    throw uxError("ai_partner_share_authorization_invalid");
  }
  return authorization;
}

export async function consumeAiPartnerShareConfirmation(
  env,
  context,
  {
    ownerTelegramId = context?.actorTelegramId,
    confirmationToken,
    consumedAt,
    cryptoImpl = globalThis.crypto,
  } = {},
) {
  const database = requireDatabase(env);
  const owner = requireTelegramCallbackContext(context, ownerTelegramId);
  const token = String(confirmationToken || "");
  if (!CONFIRMATION_TOKEN.test(token)) {
    throw uxError("ai_partner_confirmation_token_invalid");
  }
  const timestamp = normalizeClock(consumedAt, "ai_partner_share_clock_invalid");
  const tokenHash = await sha256(token, cryptoImpl);
  const row = await loadShareIntentByTokenHash(database, tokenHash);
  if (!row || Number(row.owner_telegram_id) !== owner) {
    throw uxError("ai_partner_share_confirmation_denied");
  }
  if (row.intent_state !== "pending") {
    throw uxError(
      row.intent_state === "expired"
        ? "ai_partner_confirmation_expired"
        : "ai_partner_confirmation_used",
    );
  }
  if (timestamp < Number(row.issued_at)) {
    throw uxError("ai_partner_share_clock_invalid");
  }
  if (timestamp >= Number(row.expires_at)) {
    await resolvePendingShareIntent(database, row, "expired", timestamp);
    throw uxError("ai_partner_confirmation_expired");
  }
  if (
    row.draft_state !== "draft" ||
    row.generation_state !== "complete" ||
    Number(row.current_version_no) !== Number(row.version_no) ||
    String(row.content_hash) !== String(row.preview_hash)
  ) {
    await resolvePendingShareIntent(database, row, "revoked", timestamp);
    throw uxError("ai_partner_share_stale_version");
  }
  if (!(await resolvePendingShareIntent(database, row, "consumed", timestamp))) {
    throw uxError("ai_partner_confirmation_used");
  }
  return makeShareAuthorization(row, timestamp);
}

export async function cancelAiPartnerShareConfirmation(
  env,
  context,
  {
    ownerTelegramId = context?.actorTelegramId,
    confirmationToken,
    cancelledAt,
    cryptoImpl = globalThis.crypto,
  } = {},
) {
  const database = requireDatabase(env);
  const owner = requireTelegramCallbackContext(context, ownerTelegramId);
  const token = String(confirmationToken || "");
  if (!CONFIRMATION_TOKEN.test(token)) {
    throw uxError("ai_partner_confirmation_token_invalid");
  }
  const timestamp = normalizeClock(cancelledAt, "ai_partner_share_clock_invalid");
  const row = await loadShareIntentByTokenHash(
    database,
    await sha256(token, cryptoImpl),
  );
  if (!row || Number(row.owner_telegram_id) !== owner) {
    throw uxError("ai_partner_share_confirmation_denied");
  }
  if (row.intent_state !== "pending") {
    throw uxError("ai_partner_confirmation_used");
  }
  if (timestamp < Number(row.issued_at)) {
    throw uxError("ai_partner_share_clock_invalid");
  }
  if (!(await resolvePendingShareIntent(database, row, "revoked", timestamp))) {
    throw uxError("ai_partner_confirmation_used");
  }
  return deepFreeze({
    shareIntentId: String(row.share_intent_id),
    draftId: String(row.draft_id),
    versionId: String(row.version_id),
    state: "revoked",
    replayed: false,
  });
}
