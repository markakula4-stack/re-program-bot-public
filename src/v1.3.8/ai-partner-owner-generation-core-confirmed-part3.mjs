// Isolated adaptation of the sealed Part 2 generator. The historical Part 6
// manifest pins that implementation, so confirmed writes live in this module.
import {
  AI_PARTNER_MODEL_ALIASES,
  normalizeAiPartnerDraftType,
  readAiPartnerConfig,
} from "./ai-partner-foundation.mjs";
import {
  assertSafeAiPartnerPrompt,
  listAiPartnerDraftFormats,
  loadApprovedAiPartnerFactBundle,
  runAiPartnerReadTool,
  validateAiPartnerModelOutput,
} from "./ai-partner-draft-runtime.mjs";
import {
  AI_GATEWAY_HARD_LIMITS,
  createVerifiedAdminGatewayContext,
  runAiPartnerGateway,
} from "./ai-partner-gateway.mjs";
import {
  AI_PARTNER_DEEPSEEK_FLASH_PRICING,
  createAiPartnerProviderTransports,
} from "./ai-partner-provider-transports.mjs";
import {
  applyAiPartnerOwnerPart4Policy,
  assertAiPartnerOwnerPart4Output,
  assertAiPartnerOwnerPart4Policy,
  assertAiPartnerOwnerPart4Prompt,
  assertAiPartnerOwnerPart4ProviderPayload,
  createAiPartnerOwnerPart4GatewayContext,
  createAiPartnerOwnerPart4ProviderTransports,
} from "./ai-partner-owner-security-cost-fallback-part4.mjs";
import {
  beginAiPartnerGenerationSession,
  completeAiPartnerGenerationSession,
  createAiPartnerContextFromVerifiedUpdate,
  failAiPartnerGenerationSession,
  retryAiPartnerGenerationSession,
} from "./ai-partner-telegram-ux-confirmed-part3.mjs";
import { prepareOwnerConfirmedDraftWrite } from "./ai-partner-owner-write-tools-part2.mjs";
import {
  AI_PARTNER_OWNER_NEUTRAL_WORDS,
  assertOwnerDraftClaims,
  assertOwnerPromptDataBoundary,
  assertOwnerProviderPayloadBoundary,
} from "./ai-partner-owner-factuality-part4.mjs";

export const AI_PARTNER_OWNER_GENERATION_CORE_VERSION =
  "1.3.8-owner-generation-confirmed-part3";
export const AI_PARTNER_OWNER_GENERATION_MODEL_ALIAS =
  AI_PARTNER_MODEL_ALIASES.safe;
export const AI_PARTNER_OWNER_GENERATION_LIMITS = Object.freeze({
  maximumFactPlaceholders: 128,
  maximumProviderPayloadCharacters: 38_000,
  maximumTitleCharacters: 160,
});

const SAFE_OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,47}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROUTING_FIELDS = Object.freeze([
  "model",
  "modelAlias",
  "provider",
  "providerCode",
  "thinking",
  "thinkingEnabled",
  "tools",
  "toolChoice",
]);
const GENERATION_OPTION_FIELDS = new Set([
  "actorTelegramId",
  "updateId",
  "operationKey",
  "offerFactSourceId",
  "draftType",
  "title",
  "prompt",
  "generatedAt",
  "versionRequestId",
]);
const GENERATION_DEPENDENCY_FIELDS = new Set([
  "cryptoImpl",
  "idFactory",
  "pricing",
  "transports",
  "fetchImpl",
  "timeoutMs",
  "monotonicNow",
  "part4Policy",
  "shouldContinue",
  "allowTerminalRetry",
  "deferDraftSave",
]);
const CATALOG_OPTION_FIELDS = new Set([
  "actorTelegramId",
  "generatedAt",
]);
const CATALOG_DEPENDENCY_FIELDS = new Set(["cryptoImpl"]);
const FORMAT_METADATA = Object.freeze({
  telegram_post: Object.freeze({
    label: "Telegram-пост",
    maxOutputTokens: 1_000,
    shape: Object.freeze({
      format: "telegram_post",
      title: "Короткий заголовок",
      body: "Основной текст",
      bullets: Object.freeze(["Безопасный пункт"]),
      cta: "Нейтральный призыв проверить условия",
    }),
  }),
  private_message: Object.freeze({
    label: "Личное сообщение",
    maxOutputTokens: 700,
    shape: Object.freeze({
      format: "private_message",
      greeting: "Короткое приветствие",
      body: "Основной текст",
      cta: "Предложение самостоятельно изучить условия",
    }),
  }),
  short_card: Object.freeze({
    label: "Короткая карточка",
    maxOutputTokens: 600,
    shape: Object.freeze({
      format: "short_card",
      headline: "Короткий заголовок",
      body: "Краткое описание",
      cta: "Нейтральный призыв",
    }),
  }),
  promotion_idea: Object.freeze({
    label: "Идея продвижения",
    maxOutputTokens: 900,
    shape: Object.freeze({
      format: "promotion_idea",
      title: "Название идеи",
      audience: "Подходящая аудитория",
      concept: "Безопасная концепция",
      steps: Object.freeze(["Один безопасный шаг"]),
      cta: "Предложение проверить условия",
    }),
  }),
  short_video_script: Object.freeze({
    label: "Сценарий Shorts/Reels",
    maxOutputTokens: 1_000,
    shape: Object.freeze({
      format: "short_video_script",
      hook: "Короткий хук без обещания результата",
      scenes: Object.freeze([
        Object.freeze({
          visual: "Описание безопасного кадра",
          voiceover: "Текст диктора",
        }),
      ]),
      cta: "Призыв изучить официальные условия",
    }),
  }),
  offer_explanation: Object.freeze({
    label: "Объяснение условий",
    maxOutputTokens: 1_000,
    shape: Object.freeze({
      format: "offer_explanation",
      title: "Понятный заголовок",
      summary: "Простое объяснение",
      conditions: Object.freeze(["Проверенное условие"]),
      cta: "Предложение проверить актуальные условия",
    }),
  }),
});

function ownerCoreError(code, cause) {
  const error = new Error("AI Partner owner generation rejected");
  error.name = "AiPartnerOwnerGenerationError";
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

function flag(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function positiveTelegramId(value, code) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw ownerCoreError(code);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw ownerCoreError(code);
  return parsed;
}

function clock(value = Math.floor(Date.now() / 1_000)) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1_600_000_000 ||
    parsed > 9_999_999_999
  ) {
    throw ownerCoreError("ai_partner_owner_clock_invalid");
  }
  return parsed;
}

function updateId(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw ownerCoreError("ai_partner_owner_update_id_invalid");
  }
  return parsed;
}

function operationKey(value) {
  const normalized = String(value || "").trim();
  if (!SAFE_OPERATION_KEY.test(normalized)) {
    throw ownerCoreError("ai_partner_owner_operation_key_invalid");
  }
  return normalized;
}

function uuid(value, code = "ai_partner_owner_fact_source_invalid") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!UUID_V4.test(normalized)) throw ownerCoreError(code);
  return normalized;
}

function title(value) {
  const normalized = String(value || "Черновик RE AI").trim();
  if (
    !normalized ||
    normalized.length > AI_PARTNER_OWNER_GENERATION_LIMITS.maximumTitleCharacters ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw ownerCoreError("ai_partner_owner_title_invalid");
  }
  return normalized;
}

function failureCode(value, fallback = "ai_partner_owner_generation_failed") {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 80);
  return /^[a-z0-9][a-z0-9_.-]{2,79}$/.test(normalized)
    ? normalized
    : fallback;
}

function assertExactFields(value, allowed, invalidCode, deniedCode) {
  if (!plainObject(value)) throw ownerCoreError(invalidCode);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw ownerCoreError(deniedCode);
  }
}

function assertGenerationOptions(options) {
  if (!plainObject(options)) {
    throw ownerCoreError("ai_partner_owner_options_invalid");
  }
  for (const field of ROUTING_FIELDS) {
    if (Object.hasOwn(options, field)) {
      throw ownerCoreError("ai_partner_owner_client_routing_denied");
    }
  }
  assertExactFields(
    options,
    GENERATION_OPTION_FIELDS,
    "ai_partner_owner_options_invalid",
    "ai_partner_owner_option_denied",
  );
}

function assertGenerationDependencies(dependencies) {
  assertExactFields(
    dependencies,
    GENERATION_DEPENDENCY_FIELDS,
    "ai_partner_owner_dependencies_invalid",
    "ai_partner_owner_dependency_denied",
  );
}

function assertCatalogOptions(options) {
  assertExactFields(
    options,
    CATALOG_OPTION_FIELDS,
    "ai_partner_owner_catalog_options_invalid",
    "ai_partner_owner_catalog_option_denied",
  );
}

function assertCatalogDependencies(dependencies) {
  assertExactFields(
    dependencies,
    CATALOG_DEPENDENCY_FIELDS,
    "ai_partner_owner_catalog_dependencies_invalid",
    "ai_partner_owner_catalog_dependency_denied",
  );
}

function requireOwnerBoundary(
  env,
  actorTelegramId,
  {
    part4Policy = null,
    at = Math.floor(Date.now() / 1_000),
  } = {},
) {
  if (!env?.DB?.prepare || !env?.DB?.batch) {
    throw ownerCoreError("ai_partner_owner_database_not_ready");
  }
  if (!flag(env.AI_PARTNER_OWNER_GENERATION_ENABLED)) {
    throw ownerCoreError("ai_partner_owner_generation_disabled");
  }
  const actor = positiveTelegramId(
    actorTelegramId,
    "ai_partner_owner_actor_invalid",
  );
  const admin = positiveTelegramId(
    env.ADMIN_ID,
    "ai_partner_owner_admin_not_configured",
  );
  if (actor !== admin) throw ownerCoreError("ai_partner_owner_scope_denied");

  let verifiedPart4Policy = null;
  let safeEnv;
  if (part4Policy) {
    verifiedPart4Policy = assertAiPartnerOwnerPart4Policy(part4Policy, {
      ownerTelegramId: actor,
      at,
    });
    safeEnv = applyAiPartnerOwnerPart4Policy(env, verifiedPart4Policy);
  } else {
    safeEnv = Object.freeze({
      ...env,
      AI_PARTNER_EXTERNAL_PROVIDER_ENABLED: "false",
      AI_PARTNER_RICH_MESSAGES_ENABLED: "false",
    });
  }
  const config = readAiPartnerConfig(safeEnv);
  if (
    !config.configurationValid ||
    !config.masterEnabled ||
    config.rolloutMode !== "admin" ||
    config.fallbackModelAlias !== AI_PARTNER_MODEL_ALIASES.safe ||
    config.thinkingEnabled !== false
  ) {
    throw ownerCoreError("ai_partner_owner_configuration_invalid");
  }
  if (!verifiedPart4Policy) {
    if (
      config.externalProviderEnabled ||
      config.primaryModelAlias !== AI_PARTNER_MODEL_ALIASES.safe
    ) {
      throw ownerCoreError("ai_partner_owner_configuration_invalid");
    }
  } else if (
    config.externalProviderEnabled !==
      verifiedPart4Policy.externalProviderEnabled ||
    config.primaryModelAlias !== AI_PARTNER_MODEL_ALIASES.safe
  ) {
    throw ownerCoreError("ai_partner_owner_part4_configuration_mismatch");
  }
  const sessionEnv = Object.freeze({
    ...safeEnv,
    AI_PARTNER_EXTERNAL_PROVIDER_ENABLED: "false",
    AI_PARTNER_RICH_MESSAGES_ENABLED: "false",
  });
  const sessionConfig = readAiPartnerConfig(sessionEnv);
  if (
    !sessionConfig.configurationValid ||
    !sessionConfig.masterEnabled ||
    sessionConfig.rolloutMode !== "admin" ||
    sessionConfig.externalProviderEnabled ||
    sessionConfig.primaryModelAlias !== AI_PARTNER_MODEL_ALIASES.safe ||
    sessionConfig.fallbackModelAlias !== AI_PARTNER_MODEL_ALIASES.safe ||
    sessionConfig.thinkingEnabled !== false
  ) {
    throw ownerCoreError("ai_partner_owner_session_configuration_invalid");
  }
  return Object.freeze({
    actor,
    owner: actor,
    safeEnv,
    sessionEnv,
    config,
    part4Policy: verifiedPart4Policy,
  });
}

function cycleWindow(at) {
  const startAt =
    Math.floor(at / AI_GATEWAY_HARD_LIMITS.cycleSeconds) *
    AI_GATEWAY_HARD_LIMITS.cycleSeconds;
  return Object.freeze({
    startAt,
    endAt: startAt + AI_GATEWAY_HARD_LIMITS.cycleSeconds,
  });
}

function requestKeys(owner, key, versionRequestId = null) {
  return Object.freeze({
    generationKey: `a138gen:${owner}:${key}`,
    draftRequestKey: `a138draft:${owner}:${key}`,
    versionRequestId: versionRequestId || `a138ver:${owner}:${key}`,
  });
}

function gatewayRequestId(generationId, attemptNo) {
  const value = `a138gateway:${generationId}:${attemptNo}`;
  if (value.length > 96) {
    throw ownerCoreError("ai_partner_owner_request_id_invalid");
  }
  return value;
}

function factEntries(source) {
  const entries = [];
  const visit = (value, path) => {
    if (value === null) return;
    if (typeof value === "boolean" || typeof value === "number") {
      entries.push({ path: path.join("."), value: String(value) });
      return;
    }
    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized && normalized.length <= 500) {
        entries.push({ path: path.join("."), value: normalized });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)]));
      return;
    }
    if (plainObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        visit(item, [...path, key]);
      }
    }
  };
  visit(source.facts, []);
  return entries
    .filter((entry) => entry.path)
    .slice(0, AI_PARTNER_OWNER_GENERATION_LIMITS.maximumFactPlaceholders)
    .map((entry) =>
      Object.freeze({
        path: entry.path,
        value: entry.value,
        placeholder: `{{fact:${source.factSourceId}:${entry.path}}}`,
      }),
    );
}

function injectExamplePlaceholder(value, placeholder) {
  if (typeof value === "string") return `${value}: ${placeholder}`;
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      index === 0 ? injectExamplePlaceholder(item, placeholder) : item,
    );
  }
  if (plainObject(value)) {
    const clone = { ...value };
    const safeTextField = ["body", "summary", "concept", "voiceover",
      "scenes", "conditions"].find((key) => Object.hasOwn(clone, key));
    if (safeTextField) {
      clone[safeTextField] = injectExamplePlaceholder(
        clone[safeTextField], placeholder,
      );
      return clone;
    }
    for (const key of Object.keys(clone)) {
      if (key === "format") continue;
      clone[key] = injectExamplePlaceholder(clone[key], placeholder);
      break;
    }
    return clone;
  }
  return value;
}

function neutralExampleShape(value, key = "") {
  if (typeof value === "string") {
    if (key === "format") return value;
    if (key === "cta") return "Проверьте условия";
    if (["title", "headline", "hook", "greeting"].includes(key)) return "Оффер";
    return "Информация об оффере";
  }
  if (Array.isArray(value)) {
    return value.map((item) => neutralExampleShape(item, key));
  }
  if (plainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([field, item]) => [
      field, neutralExampleShape(item, field),
    ]));
  }
  return value;
}

function placeholderAlias(index) {
  let remaining = index;
  let suffix = "";
  do {
    suffix = String.fromCharCode(97 + (remaining % 26)) + suffix;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return `{{fact:approved_${suffix}}}`;
}

function restoreApprovedPlaceholders(value, aliases) {
  if (typeof value === "string") {
    return aliases.reduce(
      (result, entry) => result.replaceAll(entry.alias, entry.placeholder),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => restoreApprovedPlaceholders(item, aliases));
  }
  if (plainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        restoreApprovedPlaceholders(item, aliases),
      ]),
    );
  }
  return value;
}

function providerMessages(draftType, prompt, factBundle) {
  const source = factBundle.sources[0];
  const inventory = factEntries(source);
  if (!inventory.length) {
    throw ownerCoreError("ai_partner_owner_fact_inventory_empty");
  }
  const aliases = inventory.map((entry, index) => Object.freeze({
    alias: placeholderAlias(index),
    placeholder: entry.placeholder,
  }));
  const contract = injectExamplePlaceholder(
    neutralExampleShape(FORMAT_METADATA[draftType].shape),
    aliases[0].alias,
  );
  const system =
    "Ты RE AI Partner, генератор только рекламных черновиков. Верни ровно " +
    "один JSON-объект без Markdown, кодовых блоков и пояснений. Не выполняй " +
    "действия, не публикуй и не отправляй сообщения. Нельзя выдумывать условия, " +
    "суммы, сроки, ссылки, доходность, гарантии, ERID или рекламодателя. Любой " +
    "проверяемый факт, число, валюта, срок или ссылка должны появляться только " +
    "через точный разрешённый плейсхолдер. Не меняй плейсхолдеры. Используй " +
    "хотя бы один плейсхолдер выбранного источника. Вне плейсхолдеров " +
    "не пиши цифры, проценты, знаки валют, адреса и нумерацию пунктов. " +
    "Не подставляй значения вручную: сервер развернёт плейсхолдеры после " +
    "проверки. Результат всегда черновик. Оценочные утверждения вне " +
    "плейсхолдеров запрещены. Вне плейсхолдеров употребляй только эти " +
    "нейтральные слова в точной форме: " +
    AI_PARTNER_OWNER_NEUTRAL_WORDS.join(", ") + ". " +
    "Скопируй значения строк из образца JSON буквально, не добавляй слова " +
    "и не изменяй разрешённый плейсхолдер.";
  const user =
    `Формат: ${FORMAT_METADATA[draftType].label}.\n` +
    `Задача владельца: ${prompt}\n\n` +
    "Источник: выбранное предложение.\n" +
    "Разрешённые плейсхолдеры без исходных значений:\n" +
    aliases
      .map((entry) => entry.alias)
      .join("\n") +
    "\n\nТочная форма JSON, набор ключей и типы:\n" +
    JSON.stringify(contract, null, 2);
  const messages = Object.freeze([
    Object.freeze({ role: "system", content: system }),
    Object.freeze({ role: "user", content: user }),
  ]);
  const characters = messages.reduce(
    (sum, message) => sum + message.content.length,
    0,
  );
  if (
    characters >
    AI_PARTNER_OWNER_GENERATION_LIMITS.maximumProviderPayloadCharacters
  ) {
    throw ownerCoreError("ai_partner_owner_provider_payload_too_large");
  }
  const utf8Bytes = messages.reduce(
    (sum, message) => sum + new TextEncoder().encode(message.content).length,
    0,
  );
  return Object.freeze({
    messages,
    aliases: Object.freeze(aliases),
    estimatedInputTokens: Math.max(
      32,
      Math.min(
        AI_GATEWAY_HARD_LIMITS.maxInputTokens,
        utf8Bytes,
      ),
    ),
    maxOutputTokens: FORMAT_METADATA[draftType].maxOutputTokens,
  });
}

function parseProviderOutput(value) {
  const normalized = String(value || "").trim();
  if (
    !normalized ||
    normalized.length > 12_000 ||
    normalized.includes("```") ||
    !normalized.startsWith("{") ||
    !normalized.endsWith("}")
  ) {
    throw ownerCoreError("ai_partner_owner_provider_json_invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch (cause) {
    throw ownerCoreError("ai_partner_owner_provider_json_invalid", cause);
  }
  if (!plainObject(parsed)) {
    throw ownerCoreError("ai_partner_owner_provider_json_invalid");
  }
  return parsed;
}

async function selectedOffer(env, owner, factSourceId, at, cryptoImpl) {
  const listed = await runAiPartnerReadTool(env, {
    toolName: "read_own_allowed_offers",
    actorTelegramId: owner,
    ownerTelegramId: owner,
    args: {},
    generatedAt: at,
    cryptoImpl,
  });
  const offer = listed.data.offers.find(
    (entry) => entry.factSourceId === factSourceId,
  );
  if (
    !offer ||
    !new Set(["offer", "partner_offer"]).has(offer.subjectType)
  ) {
    throw ownerCoreError("ai_partner_owner_offer_denied");
  }
  const factBundle = await loadApprovedAiPartnerFactBundle(env, {
    actorTelegramId: owner,
    ownerTelegramId: owner,
    factSourceIds: [factSourceId],
    generatedAt: at,
    cryptoImpl,
  });
  const source = factBundle.sources[0];
  if (
    !source ||
    source.factSourceId !== factSourceId ||
    !new Set(["offer", "partner_offer"]).has(source.subjectType)
  ) {
    throw ownerCoreError("ai_partner_owner_offer_denied");
  }
  return Object.freeze({ offer, factBundle });
}

async function completedGeneration(env, owner, generationId) {
  const row = await env.DB.prepare(
    `SELECT session.generation_id, session.draft_type,
            session.fact_source_ids_json, session.attempt_no,
            draft.draft_id, draft.title, draft.current_version_no,
            version.version_id, version.version_no, version.content,
            version.structured_payload_json, version.content_hash,
            version.model_alias, version.created_at
     FROM ai_generation_sessions session
     JOIN ai_drafts draft ON draft.draft_id = session.draft_id
     JOIN ai_draft_versions version ON version.version_id = session.version_id
     WHERE session.generation_id = ?
       AND session.owner_telegram_id = ?
       AND session.generation_state = 'completed'
       AND draft.owner_telegram_id = session.owner_telegram_id
       AND version.draft_id = draft.draft_id
     LIMIT 1`,
  ).bind(generationId, owner).first();
  if (!row) {
    throw ownerCoreError("ai_partner_owner_completed_draft_missing");
  }
  let structuredPayload;
  let factSourceIds;
  try {
    structuredPayload = JSON.parse(String(row.structured_payload_json));
    factSourceIds = JSON.parse(String(row.fact_source_ids_json));
  } catch (cause) {
    throw ownerCoreError("ai_partner_owner_completed_draft_invalid", cause);
  }
  return deepFreeze({
    ok: true,
    status: "saved",
    generationId: String(row.generation_id),
    draftId: String(row.draft_id),
    versionId: String(row.version_id),
    versionNo: Number(row.version_no),
    currentVersionNo: Number(row.current_version_no),
    draftType: String(row.draft_type),
    title: String(row.title),
    content: String(row.content),
    contentHash: String(row.content_hash),
    modelAlias: String(row.model_alias),
    factSourceIds,
    structuredPayload,
    attemptNo: Number(row.attempt_no),
    createdAt: Number(row.created_at),
    replayed: true,
    telemetry: null,
  });
}

async function failSession(env, context, session, reason, at, idFactory) {
  if (!session || !new Set(["streaming", "finalizing"]).has(session.state)) {
    return;
  }
  try {
    await failAiPartnerGenerationSession(env, context, {
      generationId: session.generationId,
      failureCode: failureCode(reason),
      actionKey: `owner-core-fail:${session.generationId}:${session.attemptNo}`,
      failedAt: at,
      idFactory,
    });
  } catch {
    // Preserve the original failure when a concurrent stop/completion won.
  }
}

function failedResult(session, reason, replayed = false) {
  return deepFreeze({
    ok: false,
    status: reason === "request_in_progress" ? "processing" : "failed",
    reason: failureCode(reason),
    generationId: session?.generationId || null,
    attemptNo: Number(session?.attemptNo || 0),
    replayed: Boolean(replayed),
  });
}

export function listAiPartnerOwnerDraftFormats() {
  return deepFreeze(
    listAiPartnerDraftFormats().map(({ draftType, schemaVersion }) => ({
      draftType,
      label: FORMAT_METADATA[draftType].label,
      schemaVersion,
      maxOutputTokens: FORMAT_METADATA[draftType].maxOutputTokens,
    })),
  );
}

export async function listAiPartnerOwnerOffers(
  env,
  options = {},
  dependencies = {},
) {
  assertCatalogOptions(options);
  assertCatalogDependencies(dependencies);
  const {
    actorTelegramId,
    generatedAt = Math.floor(Date.now() / 1_000),
  } = options;
  const cryptoImpl = dependencies.cryptoImpl || globalThis.crypto;
  const boundary = requireOwnerBoundary(env, actorTelegramId);
  const at = clock(generatedAt);
  const result = await runAiPartnerReadTool(boundary.safeEnv, {
    toolName: "read_own_allowed_offers",
    actorTelegramId: boundary.owner,
    ownerTelegramId: boundary.owner,
    args: {},
    generatedAt: at,
    cryptoImpl,
  });
  return deepFreeze({
    ownerTelegramId: boundary.owner,
    offers: result.data.offers,
    formats: listAiPartnerOwnerDraftFormats(),
  });
}

export async function generateAiPartnerOwnerDraft(
  env,
  options = {},
  dependencies = {},
) {
  assertGenerationOptions(options);
  assertGenerationDependencies(dependencies);
  const {
    actorTelegramId,
    updateId: telegramUpdateIdInput,
    operationKey: operationKeyInput,
    offerFactSourceId,
    draftType,
    title: draftTitle = "Черновик RE AI",
    prompt,
    versionRequestId = null,
    generatedAt = Math.floor(Date.now() / 1_000),
  } = options;
  const at = clock(generatedAt);
  const boundary = requireOwnerBoundary(env, actorTelegramId, {
    part4Policy: dependencies.part4Policy || null,
    at,
  });
  const deferDraftSave = dependencies.deferDraftSave === true;
  if (deferDraftSave && (
    env.AI_PARTNER_OWNER_WRITE_TOOLS_ENABLED !== "true" ||
    env.AI_PARTNER_OWNER_CONFIRMATION_UX_ENABLED !== "true" ||
    !/^a138wr:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(versionRequestId) ||
    boundary.part4Policy?.externalProviderEnabled
  )) throw ownerCoreError("ai_partner_owner_confirmation_mode_denied");
  if (!deferDraftSave && versionRequestId !== null) {
    throw ownerCoreError("ai_partner_owner_confirmation_mode_denied");
  }
  const telegramUpdateId = updateId(telegramUpdateIdInput);
  const key = operationKey(operationKeyInput);
  const sourceId = uuid(offerFactSourceId);
  const type = normalizeAiPartnerDraftType(draftType);
  const normalizedTitle = title(draftTitle);
  let safePrompt = assertSafeAiPartnerPrompt(prompt);
  if (boundary.part4Policy) {
    safePrompt = assertAiPartnerOwnerPart4Prompt(
      boundary.part4Policy,
      safePrompt,
    );
  }
  const cryptoImpl = dependencies.cryptoImpl || globalThis.crypto;
  const idFactory =
    dependencies.idFactory ||
    (() => {
      if (!globalThis.crypto?.randomUUID) {
        throw ownerCoreError("ai_partner_owner_random_uuid_unavailable");
      }
      return globalThis.crypto.randomUUID();
    });
  if (typeof idFactory !== "function") {
    throw ownerCoreError("ai_partner_owner_id_factory_invalid");
  }

  const { factBundle } = await selectedOffer(
    boundary.safeEnv,
    boundary.owner,
    sourceId,
    at,
    cryptoImpl,
  );
  assertOwnerPromptDataBoundary(safePrompt, factBundle);
  const providerRequest = providerMessages(type, safePrompt, factBundle);
  assertOwnerProviderPayloadBoundary({
    messages: providerRequest.messages,
  }, factBundle);
  if (boundary.part4Policy) {
    assertAiPartnerOwnerPart4ProviderPayload(boundary.part4Policy, {
      messages: providerRequest.messages,
    });
  }
  const keys = requestKeys(boundary.owner, key, versionRequestId);
  const telegramContext = createAiPartnerContextFromVerifiedUpdate(
    boundary.sessionEnv,
    {
      actorTelegramId: boundary.owner,
      updateId: telegramUpdateId,
      chatType: "private",
      isAdmin: true,
    },
  );
  let session = await beginAiPartnerGenerationSession(
    boundary.sessionEnv,
    telegramContext,
    {
      generationKey: keys.generationKey,
      draftRequestKey: keys.draftRequestKey,
      versionRequestId: keys.versionRequestId,
      draftType: type,
      title: normalizedTitle,
      prompt: safePrompt,
      factSourceIds: [sourceId],
      startedAt: at,
      idFactory,
      cryptoImpl,
    },
  );

  if (session.state === "completed") {
    return completedGeneration(
      boundary.sessionEnv,
      boundary.owner,
      session.generationId,
    );
  }
  if (session.state === "finalizing") {
    if (deferDraftSave) return failedResult(session, "confirmation_pending", true);
    try {
      session = await completeAiPartnerGenerationSession(
        boundary.sessionEnv,
        telegramContext,
        {
          generationId: session.generationId,
          output: null,
          completedAt: at,
          idFactory,
          cryptoImpl,
        },
      );
      if (session.state === "completed") {
        return completedGeneration(
          boundary.sessionEnv,
          boundary.owner,
          session.generationId,
        );
      }
    } catch (error) {
      await failSession(
        boundary.sessionEnv,
        telegramContext,
        session,
        error?.code || "ai_partner_owner_recovery_required",
        at,
        idFactory,
      );
      throw error;
    }
  }
  if (session.state === "failed" || session.state === "stopped") {
    if (dependencies.allowTerminalRetry === false) {
      throw ownerCoreError("ai_partner_owner_generation_terminal");
    }
    session = await retryAiPartnerGenerationSession(
      boundary.sessionEnv,
      telegramContext,
      {
        generationId: session.generationId,
        actionKey:
          `owner-core-retry:${session.generationId}:${session.attemptNo + 1}`,
        retriedAt: at,
        idFactory,
      },
    );
  }
  if (session.state !== "streaming") {
    throw ownerCoreError("ai_partner_owner_generation_state_invalid");
  }

  const cycle = cycleWindow(at);
  const dataClass =
    factBundle.sources[0].visibility === "public" ? "public" : "private";
  const gatewayContext = boundary.part4Policy
    ? createAiPartnerOwnerPart4GatewayContext(boundary.part4Policy, {
        dataClass,
        at,
      })
    : createVerifiedAdminGatewayContext({
        actorTelegramId: boundary.owner,
        ownerTelegramId: boundary.owner,
        isAdmin: true,
        purpose: "admin_chat",
        at,
        userCycleStartAt: cycle.startAt,
        userCycleEndAt: cycle.endAt,
        globalCycleStartAt: cycle.startAt,
        globalCycleEndAt: cycle.endAt,
        externalConsent: null,
        dataClass,
        cacheAllowed: false,
      });
  const providerTransports =
    dependencies.transports ||
    (boundary.part4Policy
      ? createAiPartnerOwnerPart4ProviderTransports(boundary.safeEnv, {
          policy: boundary.part4Policy,
          fetchImpl: dependencies.fetchImpl || globalThis.fetch,
          shouldContinue: dependencies.shouldContinue || null,
        })
      : createAiPartnerProviderTransports(boundary.safeEnv, {
          fetchImpl: dependencies.fetchImpl || globalThis.fetch,
        }));

  let gatewayResult;
  try {
    gatewayResult = await runAiPartnerGateway({
      db: boundary.safeEnv.DB,
      context: gatewayContext,
      config: boundary.config,
      request: {
        requestId: gatewayRequestId(
          session.generationId,
          session.attemptNo,
        ),
        dataClass,
        estimatedInputTokens: providerRequest.estimatedInputTokens,
        maxOutputTokens: providerRequest.maxOutputTokens,
        sourceCount: 1,
        allowCache: false,
        payload: { messages: providerRequest.messages },
      },
      pricing:
        dependencies.pricing || AI_PARTNER_DEEPSEEK_FLASH_PRICING,
      transports: providerTransports,
      providerUserIdSecret:
        boundary.safeEnv.AI_PARTNER_PROVIDER_USER_ID_SECRET,
      cacheScopeSecret:
        boundary.safeEnv.AI_PARTNER_PRIVATE_CACHE_SECRET,
      validateOutput: async (content) => {
        const providerTemplate = parseProviderOutput(content);
        if (boundary.part4Policy) {
          assertAiPartnerOwnerPart4Output(boundary.part4Policy, providerTemplate);
        }
        const template = restoreApprovedPlaceholders(
          providerTemplate,
          providerRequest.aliases,
        );
        assertOwnerDraftClaims(template);
        const validated = validateAiPartnerModelOutput({
          draftType: type,
          output: template,
          factBundle,
        });
        if (boundary.part4Policy) {
          assertAiPartnerOwnerPart4Output(boundary.part4Policy, {
            content: validated.content,
            fields: validated.structuredPayload.fields,
          });
        }
        return deepFreeze({ template, validated });
      },
      idFactory,
      timeoutMs:
        dependencies.timeoutMs || AI_GATEWAY_HARD_LIMITS.timeoutMs,
      monotonicNow:
        dependencies.monotonicNow ||
        (() => globalThis.performance?.now?.() ?? Date.now()),
      cryptoImpl,
    });
  } catch (error) {
    await failSession(
      boundary.sessionEnv,
      telegramContext,
      session,
      error?.code || error?.message,
      at,
      idFactory,
    );
    throw error;
  }

  if (!gatewayResult?.ok) {
    if (gatewayResult?.reason !== "request_in_progress") {
      await failSession(
        boundary.sessionEnv,
        telegramContext,
        session,
        gatewayResult?.reason,
        at,
        idFactory,
      );
    }
    return failedResult(
      session,
      gatewayResult?.reason || "ai_partner_owner_gateway_failed",
      gatewayResult?.replay,
    );
  }
  const allowedModelAliases = boundary.part4Policy
    ? boundary.part4Policy.allowedModelAliases
    : [AI_PARTNER_MODEL_ALIASES.safe];
  if (!allowedModelAliases.includes(gatewayResult.modelAlias)) {
    await failSession(
      boundary.sessionEnv,
      telegramContext,
      session,
      "ai_partner_owner_unexpected_model_route",
      at,
      idFactory,
    );
    throw ownerCoreError("ai_partner_owner_unexpected_model_route");
  }

  if (deferDraftSave) {
    try {
      await completeAiPartnerGenerationSession(
        boundary.sessionEnv,
        telegramContext,
        {
          generationId: session.generationId,
          output: gatewayResult.output.template,
          finalModelAlias: gatewayResult.modelAlias,
          providerRequestId: gatewayResult.requestId,
          fallbackUsed: gatewayResult.fallbackUsed,
          completedAt: at,
          deferDraftSave: true,
          idFactory,
          cryptoImpl,
        },
      );
      const prepared = await prepareOwnerConfirmedDraftWrite(env, {
        actorTelegramId: boundary.owner,
        actionType: "save_own_draft",
        intentId: versionRequestId.slice("a138wr:".length),
        requestKey: `${versionRequestId}:prepared`,
        draftType: type,
        title: normalizedTitle,
        output: gatewayResult.output.template,
        factSourceIds: [sourceId],
        at,
      });
      return deepFreeze({
        ok: true,
        status: "pending_confirmation",
        generationId: session.generationId,
        draftType: type,
        title: normalizedTitle,
        ...prepared,
        telemetry: gatewayResult.telemetry,
      });
    } catch (error) {
      await failSession(
        boundary.sessionEnv, telegramContext, session,
        error?.code || "confirmation_prepare_failed", at, idFactory,
      );
      throw error;
    }
  }
  const completed = await completeAiPartnerGenerationSession(
    boundary.sessionEnv,
    telegramContext,
    {
      generationId: session.generationId,
      output: gatewayResult.output.template,
      finalModelAlias: gatewayResult.modelAlias,
      providerRequestId: gatewayResult.requestId,
      fallbackUsed: gatewayResult.fallbackUsed,
      completedAt: at,
      idFactory,
      cryptoImpl,
    },
  );
  const stored = await completedGeneration(
    boundary.sessionEnv,
    boundary.owner,
    completed.generationId,
  );
  return deepFreeze({
    ...stored,
    replayed: false,
    telemetry: gatewayResult.telemetry,
  });
}
