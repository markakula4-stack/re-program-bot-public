import {
  createAnalyticsActorPseudonym,
} from "./analytics-foundation.mjs";
import {
  assertAnalyticsProjectionGate,
  readAnalyticsProjectionConfig,
  safeProjectionDisplay,
} from "./metric-projections.mjs";

const DAY = 86_400;
const SESSION_TTL = 900;
const ACTION_TTL = 600;
const AUDIT_RETENTION = 180 * DAY;
const TOKEN_PATTERN = /^[0-9a-f]{18}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CALLBACK_PREFIX = "a139";
const CALLBACK_LIMIT = 64;
const TELEGRAM_TEXT_LIMIT = 4096;

export const ANALYTICS_V2_ADMIN_POLICY_VERSION =
  "2026-09-13.analytics-v2-part5";

export const ANALYTICS_V2_ADMIN_SCREENS = Object.freeze([
  "overview",
  "product_funnel",
  "retention",
  "ambassadors",
  "diagnostics",
  "privacy",
]);

export const ANALYTICS_V2_RETENTION_DATASETS = Object.freeze([
  "analytics_admin_action_results",
  "analytics_admin_action_items",
  "analytics_admin_action_requests",
  "analytics_admin_view_sessions",
  "analytics_projection_snapshot_bindings",
  "analytics_projection_attribution_bindings",
  "analytics_daily_actor_facts",
  "analytics_attribution_decisions",
  "analytics_attribution_touchpoints",
  "canonical_analytics_events",
  "analytics_ingestion_conflicts",
  "analytics_ingestion_issues",
  "analytics_ingestion_receipts",
]);

const SCREEN_BY_ACTION = Object.freeze({
  home: "overview",
  funnel: "product_funnel",
  retention: "retention",
  ambassadors: "ambassadors",
  diagnostics: "diagnostics",
  privacy: "privacy",
});

const ACTIONS = new Set([
  ...Object.keys(SCREEN_BY_ACTION),
  "prev",
  "next",
  "refresh",
  "close",
  "ret_plan",
  "ret_apply",
  "ret_cancel",
]);

const METRIC_LABELS = Object.freeze({
  events_total: "События",
  active_actors: "Активные пользователи",
  registrations: "Регистрации",
  offer_views: "Просмотры офферов",
  leads: "Заявки",
  payments_succeeded: "Успешные платежи",
  access_applied: "Выданный доступ",
  refunds: "Возвраты",
  ai_successes: "Успешные ответы AI",
  ai_failures: "Ошибки AI",
  ai_limits: "Достигнутые лимиты AI",
  ai_success_rate: "Успешность AI",
  confirmed_rewards: "Подтверждённые награды",
  tracking_opens: "Переходы по кампании",
  attributed_registrations: "Атрибутированные регистрации",
  attributed_leads: "Атрибутированные заявки",
  applied_paid_access: "Атрибутированный доступ",
  confirmed_referral_rewards: "Подтверждённые награды",
});

const FUNNEL_LABELS = Object.freeze({
  start: "Старт",
  registration: "Регистрация",
  menu: "Меню",
  offer: "Оффер",
  lead: "Заявка",
  applied_access: "Доступ",
});

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function positiveTelegramId(value, name = "Telegram ID") {
  const normalized = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : value;
  return integer(normalized, name, 1);
}

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function hash(value, name) {
  if (!HASH_PATTERN.test(value || "")) throw new TypeError(`${name} must be a sha256 digest`);
  return value;
}

function uuid(value, name) {
  if (!UUID_V4_PATTERN.test(value || "")) throw new TypeError(`${name} must be a UUIDv4`);
  return value;
}

function utcDay(value, name = "metric date") {
  integer(value, name, DAY);
  if (value % DAY !== 0) throw new TypeError(`${name} must be UTC midnight`);
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

async function sha256Hex(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto is required");
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value));
  const digest = await cryptoImpl.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.getRandomValues) throw new Error("secure randomness is required");
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomUuid(cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.randomUUID) throw new Error("secure UUID generation is required");
  return cryptoImpl.randomUUID().toLowerCase();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isoDay(timestamp) {
  return new Date(utcDay(timestamp) * 1000).toISOString().slice(0, 10);
}

function resultChanges(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

function resultRows(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

function assertCallbackLength(callbackData) {
  if (new TextEncoder().encode(callbackData).length > CALLBACK_LIMIT) {
    throw new Error("Telegram callback_data exceeds 64 bytes");
  }
  return callbackData;
}

export function buildAnalyticsAdminCallback({
  sessionToken,
  action,
  revision,
  requestToken = null,
} = {}) {
  if (!TOKEN_PATTERN.test(sessionToken || "")) throw new TypeError("session token is invalid");
  if (!ACTIONS.has(action)) throw new TypeError("analytics admin action is invalid");
  integer(revision, "session revision", 1);
  if ((action === "ret_apply" || action === "ret_cancel") !== Boolean(requestToken)) {
    throw new TypeError("retention confirmation token mismatch");
  }
  if (requestToken !== null && !TOKEN_PATTERN.test(requestToken)) {
    throw new TypeError("request token is invalid");
  }
  const parts = [CALLBACK_PREFIX, sessionToken, action, String(revision)];
  if (requestToken) parts.push(requestToken);
  return assertCallbackLength(parts.join(":"));
}

export function parseAnalyticsAdminCallback(value) {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > CALLBACK_LIMIT) {
    throw new TypeError("analytics callback is invalid");
  }
  const parts = value.split(":");
  if (parts.length < 4 || parts.length > 5 || parts[0] !== CALLBACK_PREFIX) {
    throw new TypeError("analytics callback shape is invalid");
  }
  const [, sessionToken, action, rawRevision, requestToken = null] = parts;
  if (!TOKEN_PATTERN.test(sessionToken) || !ACTIONS.has(action) || !/^[1-9]\d{0,8}$/.test(rawRevision)) {
    throw new TypeError("analytics callback value is invalid");
  }
  const requiresRequest = action === "ret_apply" || action === "ret_cancel";
  if (requiresRequest !== Boolean(requestToken) || (requestToken && !TOKEN_PATTERN.test(requestToken))) {
    throw new TypeError("analytics callback confirmation is invalid");
  }
  return Object.freeze({
    sessionToken,
    action,
    revision: Number(rawRevision),
    requestToken,
  });
}

export function assertAnalyticsAdminGate({
  config,
  databaseSettings,
  actorTelegramId,
  configuredAdminId,
  requestedScope = "admin_shadow",
} = {}) {
  const actor = positiveTelegramId(actorTelegramId, "admin actor");
  const configured = positiveTelegramId(configuredAdminId, "configured admin");
  if (actor !== configured) throw new Error("analytics admin access denied");
  assertAnalyticsProjectionGate({ config, databaseSettings, requestedScope });
  if (
    config.rawRetentionDays !== databaseSettings.raw_retention_days ||
    config.smallSegmentThreshold !== databaseSettings.small_segment_threshold ||
    config.pseudonymKeyVersion !== databaseSettings.pseudonym_key_version ||
    Number(config.ambassadorEnabled) !== databaseSettings.ambassador_enabled
  ) throw new Error("analytics admin environment and database settings differ");
  return true;
}

async function authorizeAdmin({ store, env, actorTelegramId, now }, options = {}) {
  if (!store?.getDatabaseSettings) throw new TypeError("analytics admin store is invalid");
  integer(now, "current time", 1);
  const config = readAnalyticsProjectionConfig(env);
  const databaseSettings = await store.getDatabaseSettings();
  assertAnalyticsAdminGate({
    config,
    databaseSettings,
    actorTelegramId,
    configuredAdminId: env?.SUPPORT_ADMIN_ID,
  });
  const adminPseudonym = await createAnalyticsActorPseudonym({
    telegramId: positiveTelegramId(actorTelegramId),
    secret: env?.ANALYTICS_SUBJECT_PSEUDONYM_SECRET,
    keyVersion: databaseSettings.pseudonym_key_version,
    cryptoImpl: options.cryptoImpl,
  });
  return Object.freeze({ config, databaseSettings, adminPseudonym });
}

export async function openAnalyticsAdminSession({
  store,
  env,
  actorTelegramId,
  metricDate,
  now,
} = {}, options = {}) {
  if (!store?.createSession) throw new TypeError("analytics admin store cannot create sessions");
  const authorized = await authorizeAdmin({ store, env, actorTelegramId, now }, options);
  const selectedDate = metricDate === undefined
    ? await store.getLatestMetricDate()
    : metricDate;
  utcDay(selectedDate);
  const sessionToken = randomToken(options.cryptoImpl);
  const session = Object.freeze({
    session_id: randomUuid(options.cryptoImpl),
    session_token_hash: await sha256Hex(sessionToken, options.cryptoImpl),
    admin_pseudonym: authorized.adminPseudonym,
    screen: "overview",
    metric_date: selectedDate,
    revision: 1,
    created_at: now,
    updated_at: now,
    expires_at: now + SESSION_TTL,
    closed_at: null,
    retention_until: now + AUDIT_RETENTION,
    policy_version: ANALYTICS_V2_ADMIN_POLICY_VERSION,
  });
  await store.createSession(session);
  const view = await store.loadScreen("overview", selectedDate, authorized.databaseSettings);
  return Object.freeze({
    sessionToken,
    session,
    message: renderAnalyticsAdminScreen({ sessionToken, session, view }),
  });
}

async function resolveSession({ store, env, actorTelegramId, parsed, now }, options = {}) {
  const authorized = await authorizeAdmin({ store, env, actorTelegramId, now }, options);
  const sessionHash = await sha256Hex(parsed.sessionToken, options.cryptoImpl);
  const session = await store.getSessionByTokenHash(sessionHash);
  if (!session || session.admin_pseudonym !== authorized.adminPseudonym) {
    throw new Error("analytics admin session is not owned by this admin");
  }
  if (session.closed_at !== null || session.expires_at <= now) {
    throw new Error("analytics admin session expired");
  }
  if (session.revision !== parsed.revision) {
    throw new Error("analytics admin callback is stale");
  }
  return Object.freeze({ authorized, session });
}

export async function handleAnalyticsAdminCallback({
  store,
  env,
  actorTelegramId,
  callbackData,
  now,
} = {}, options = {}) {
  const parsed = parseAnalyticsAdminCallback(callbackData);
  const { authorized, session } = await resolveSession({
    store, env, actorTelegramId, parsed, now,
  }, options);

  if (parsed.action === "ret_plan") {
    if (session.screen !== "privacy") throw new Error("retention plan requires privacy screen");
    return planAnalyticsRetention({
      store,
      session,
      sessionToken: parsed.sessionToken,
      adminPseudonym: authorized.adminPseudonym,
      now,
    }, options);
  }
  if (parsed.action === "ret_apply" || parsed.action === "ret_cancel") {
    if (session.screen !== "privacy") throw new Error("retention confirmation requires privacy screen");
    const result = parsed.action === "ret_apply"
      ? await applyAnalyticsRetention({
        store,
        session,
        sessionToken: parsed.sessionToken,
        requestToken: parsed.requestToken,
        adminPseudonym: authorized.adminPseudonym,
        now,
      }, options)
      : await cancelAnalyticsRetention({
        store,
        session,
        requestToken: parsed.requestToken,
        adminPseudonym: authorized.adminPseudonym,
        now,
      }, options);
    const view = await store.loadScreen("privacy", session.metric_date, authorized.databaseSettings);
    return Object.freeze({
      ...result,
      message: renderAnalyticsAdminScreen({
        sessionToken: parsed.sessionToken,
        session,
        view: { ...view, operationResult: result },
      }),
    });
  }

  let screen = session.screen;
  let metricDate = session.metric_date;
  if (SCREEN_BY_ACTION[parsed.action]) screen = SCREEN_BY_ACTION[parsed.action];
  if (parsed.action === "prev") metricDate -= DAY;
  if (parsed.action === "next") {
    const latest = await store.getLatestMetricDate();
    metricDate = Math.min(metricDate + DAY, latest);
  }
  if (parsed.action === "close") {
    const closed = await store.updateSession({
      sessionId: session.session_id,
      expectedRevision: session.revision,
      screen,
      metricDate,
      updatedAt: now,
      closedAt: now,
    });
    if (!closed) throw new Error("analytics admin session changed concurrently");
    return Object.freeze({
      outcome: "closed",
      message: Object.freeze({
        text: "✅ Закрытая сессия аналитики завершена.",
        reply_markup: Object.freeze({ inline_keyboard: Object.freeze([]) }),
      }),
    });
  }
  utcDay(metricDate);
  const changed = await store.updateSession({
    sessionId: session.session_id,
    expectedRevision: session.revision,
    screen,
    metricDate,
    updatedAt: now,
    closedAt: null,
  });
  if (!changed) throw new Error("analytics admin session changed concurrently");
  const nextSession = Object.freeze({
    ...session,
    screen,
    metric_date: metricDate,
    revision: session.revision + 1,
    updated_at: now,
  });
  const view = await store.loadScreen(screen, metricDate, authorized.databaseSettings);
  return Object.freeze({
    outcome: "rendered",
    session: nextSession,
    message: renderAnalyticsAdminScreen({
      sessionToken: parsed.sessionToken,
      session: nextSession,
      view,
    }),
  });
}

function safeCount(row, field) {
  const display = safeProjectionDisplay(row);
  if (!display.visible) return escapeHtml(display.label);
  const value = integer(row[field], field);
  return String(value);
}

function safeRatio(row, field) {
  const display = safeProjectionDisplay(row);
  if (!display.visible) return escapeHtml(display.label);
  const value = row[field];
  if (value === null || value === undefined) return "—";
  integer(value, field);
  return `${(value / 100).toFixed(2)}%`;
}

function navKeyboard(sessionToken, revision) {
  const callback = (action) => buildAnalyticsAdminCallback({ sessionToken, action, revision });
  return [
    [
      { text: "📊 Обзор", callback_data: callback("home") },
      { text: "🪜 Воронка", callback_data: callback("funnel") },
    ],
    [
      { text: "🗓 Retention", callback_data: callback("retention") },
      { text: "🤝 Амбассадоры", callback_data: callback("ambassadors") },
    ],
    [
      { text: "🩺 Диагностика", callback_data: callback("diagnostics") },
      { text: "🔐 Privacy", callback_data: callback("privacy") },
    ],
    [
      { text: "◀️ День", callback_data: callback("prev") },
      { text: "🔄", callback_data: callback("refresh") },
      { text: "День ▶️", callback_data: callback("next") },
    ],
    [{ text: "⏹ Закрыть", callback_data: callback("close") }],
  ];
}

function overviewLines(rows) {
  const allowed = new Set([
    "active_actors", "registrations", "offer_views", "leads",
    "access_applied", "refunds", "ai_successes", "ai_failures",
  ]);
  return rows.filter((row) => allowed.has(row.metric_key)).slice(0, 12).map((row) => {
    const label = METRIC_LABELS[row.metric_key] || "Метрика";
    return `• ${escapeHtml(label)}: <b>${safeCount(row, "numerator_count")}</b>`;
  });
}

function funnelLines(rows) {
  return [...rows].sort((a, b) => a.step_order - b.step_order).slice(0, 8).map((row) => {
    const label = FUNNEL_LABELS[row.step_key] || "Шаг";
    const count = safeCount(row, "qualified_actors");
    const ratio = row.step_order === 1 ? "—" : safeRatio(row, "conversion_bps");
    return `${row.step_order}. ${escapeHtml(label)}: <b>${count}</b> · ${ratio}`;
  });
}

function retentionLines(rows) {
  return [...rows].sort((a, b) => a.offset_days - b.offset_days).slice(0, 3).map((row) => {
    if (row.eligible !== 1) return `• D${row.offset_days}: <b>ещё не закрыт</b>`;
    const retained = safeCount(row, "retained_actors");
    const ratio = safeRatio(row, "retention_bps");
    return `• D${row.offset_days}: <b>${retained}</b> · ${ratio}`;
  });
}

function ambassadorLines(rows) {
  return rows.slice(0, 10).map((row) => {
    const label = METRIC_LABELS[row.metric_key] || "Метрика амбассадора";
    const scope = row.scope_kind === "ambassador" ? "итого" : row.scope_kind;
    return `• ${escapeHtml(label)} · ${escapeHtml(scope)}: <b>${safeCount(row, "metric_count")}</b>`;
  });
}

export function summarizeAnalyticsDiagnostics(input = {}) {
  exactKeys(input, new Set([
    "configurationAligned", "sourceFailed", "sourceIncomplete",
    "issueRows", "conflictRows", "sourceDelta", "canonicalDelta",
    "projectionDelta", "hasSnapshot", "snapshotAgeSeconds",
  ]), "analytics diagnostics");
  const values = {
    configurationAligned: input.configurationAligned === true,
    sourceFailed: integer(input.sourceFailed, "failed sources"),
    sourceIncomplete: integer(input.sourceIncomplete, "incomplete sources"),
    issueRows: integer(input.issueRows, "ingestion issues"),
    conflictRows: integer(input.conflictRows, "ingestion conflicts"),
    sourceDelta: integer(Math.abs(input.sourceDelta), "source delta"),
    canonicalDelta: integer(Math.abs(input.canonicalDelta), "canonical delta"),
    projectionDelta: integer(Math.abs(input.projectionDelta), "projection delta"),
    hasSnapshot: input.hasSnapshot === true,
    snapshotAgeSeconds: integer(input.snapshotAgeSeconds, "snapshot age"),
  };
  const red = !values.configurationAligned || values.sourceFailed > 0 ||
    values.conflictRows > 0 || values.sourceDelta > 0 ||
    values.canonicalDelta > 0 || values.projectionDelta > 0;
  const amber = !values.hasSnapshot || values.sourceIncomplete > 0 ||
    values.issueRows > 0 || values.snapshotAgeSeconds > 2 * DAY;
  return Object.freeze({
    level: red ? "red" : amber ? "amber" : "green",
    ...values,
  });
}

function diagnosticsLines(value) {
  const icon = value.level === "green" ? "🟢" : value.level === "amber" ? "🟡" : "🔴";
  return [
    `${icon} Состояние: <b>${value.level}</b>`,
    `• Ошибочные источники: <b>${value.sourceFailed}</b>`,
    `• Незавершённые источники: <b>${value.sourceIncomplete}</b>`,
    `• Issues / conflicts: <b>${value.issueRows} / ${value.conflictRows}</b>`,
    `• Delta source/canonical/projection: <b>${value.sourceDelta}/${value.canonicalDelta}/${value.projectionDelta}</b>`,
  ];
}

export function renderAnalyticsAdminScreen({ sessionToken, session, view } = {}) {
  if (!TOKEN_PATTERN.test(sessionToken || "")) throw new TypeError("session token is invalid");
  if (!ANALYTICS_V2_ADMIN_SCREENS.includes(session?.screen)) throw new TypeError("admin screen is invalid");
  integer(session.revision, "session revision", 1);
  const date = isoDay(session.metric_date);
  let title = "📊 Аналитика 2.0";
  let lines = [];
  if (session.screen === "overview") {
    lines = overviewLines(view?.rows || []);
  } else if (session.screen === "product_funnel") {
    title = "🪜 Продуктовая воронка";
    lines = funnelLines(view?.rows || []);
  } else if (session.screen === "retention") {
    title = "🗓 Удержание D1/D7/D30";
    lines = retentionLines(view?.rows || []);
  } else if (session.screen === "ambassadors") {
    title = "🤝 Амбассадоры 2.0";
    lines = ambassadorLines(view?.rows || []);
    lines.push("", "Идентификаторы и малые сегменты намеренно скрыты.");
  } else if (session.screen === "diagnostics") {
    title = "🩺 Диагностика аналитики";
    lines = diagnosticsLines(view?.diagnostics);
  } else {
    title = "🔐 Privacy и retention";
    const total = integer(view?.retentionRows || 0, "retention rows");
    lines = [
      `Истёкших строк: <b>${total}</b>.`,
      "Очистка не затрагивает агрегаты, платежи, доступ, награды или реферальные связи.",
    ];
    if (view?.operationResult) {
      lines.push("", `Последняя операция: <b>${escapeHtml(view.operationResult.outcome)}</b>.`);
    }
  }
  if (lines.length === 0) lines.push("Пока нет подтверждённого snapshot за этот день.");
  const text = `<b>${title}</b>\n\nUTC-день: <code>${date}</code>\n\n${lines.join("\n")}`;
  if (new TextEncoder().encode(text).length > TELEGRAM_TEXT_LIMIT) {
    throw new Error("analytics Telegram message exceeds 4096 bytes");
  }
  const keyboard = navKeyboard(sessionToken, session.revision);
  if (session.screen === "privacy") {
    keyboard.unshift([{
      text: "🧪 Подготовить dry-run",
      callback_data: buildAnalyticsAdminCallback({
        sessionToken, action: "ret_plan", revision: session.revision,
      }),
    }]);
  }
  return Object.freeze({
    text,
    parse_mode: "HTML",
    reply_markup: Object.freeze({
      inline_keyboard: Object.freeze(keyboard.map((row) => Object.freeze(row.map(Object.freeze)))),
    }),
  });
}

async function buildRetentionPlan(store, cutoffAt, cryptoImpl) {
  const counts = await store.countRetentionCandidates(cutoffAt);
  const keys = Object.keys(counts).sort();
  const expected = [...ANALYTICS_V2_RETENTION_DATASETS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("retention dataset inventory is incomplete");
  }
  const items = [];
  for (const datasetName of ANALYTICS_V2_RETENTION_DATASETS) {
    const plannedRows = integer(counts[datasetName], `${datasetName} rows`);
    items.push(Object.freeze({
      dataset_name: datasetName,
      planned_rows: plannedRows,
      item_digest: await sha256Hex({ datasetName, plannedRows, cutoffAt }, cryptoImpl),
    }));
  }
  const plannedRows = items.reduce((sum, item) => sum + item.planned_rows, 0);
  const planDigest = await sha256Hex({
    policyVersion: ANALYTICS_V2_ADMIN_POLICY_VERSION,
    cutoffAt,
    items,
  }, cryptoImpl);
  return Object.freeze({ items: Object.freeze(items), plannedRows, planDigest });
}

export async function planAnalyticsRetention({
  store,
  session,
  sessionToken,
  adminPseudonym,
  now,
} = {}, options = {}) {
  if (!store?.countRetentionCandidates || !store?.createRetentionRequest) {
    throw new TypeError("analytics admin store cannot plan retention");
  }
  if (!TOKEN_PATTERN.test(sessionToken || "")) throw new TypeError("session token is invalid");
  uuid(session?.session_id, "session id");
  hash(adminPseudonym, "admin pseudonym");
  integer(now, "current time", 1);
  if (session.screen !== "privacy") throw new Error("retention plan requires privacy screen");
  if (session.admin_pseudonym !== adminPseudonym || session.closed_at !== null ||
      session.expires_at <= now) {
    throw new Error("retention session is unavailable");
  }
  const cutoffAt = now;
  const plan = await buildRetentionPlan(store, cutoffAt, options.cryptoImpl);
  const requestToken = randomToken(options.cryptoImpl);
  const request = Object.freeze({
    request_id: randomUuid(options.cryptoImpl),
    request_token_hash: await sha256Hex(requestToken, options.cryptoImpl),
    session_id: session.session_id,
    admin_pseudonym: adminPseudonym,
    action_kind: "retention",
    cutoff_at: cutoffAt,
    plan_digest: plan.planDigest,
    planned_rows: plan.plannedRows,
    dataset_count: ANALYTICS_V2_RETENTION_DATASETS.length,
    session_revision: session.revision,
    created_at: now,
    expires_at: now + ACTION_TTL,
    retention_until: now + AUDIT_RETENTION,
    policy_version: ANALYTICS_V2_ADMIN_POLICY_VERSION,
  });
  const items = plan.items.map((item) => Object.freeze({
    request_id: request.request_id,
    ...item,
    created_at: now,
    retention_until: now + AUDIT_RETENTION,
  }));
  await store.createRetentionRequest(request, items);
  const applyCallback = buildAnalyticsAdminCallback({
    sessionToken,
    action: "ret_apply",
    revision: session.revision,
    requestToken,
  });
  const cancelCallback = buildAnalyticsAdminCallback({
    sessionToken,
    action: "ret_cancel",
    revision: session.revision,
    requestToken,
  });
  return Object.freeze({
    outcome: "planned",
    plannedRows: plan.plannedRows,
    expiresAt: request.expires_at,
    message: Object.freeze({
      text: `<b>🧪 Dry-run retention</b>\n\nК удалению: <b>${plan.plannedRows}</b> истёкших строк в ${items.length} наборах.\nПлатежи, доступ, награды, пользователи и анонимные агрегаты не затрагиваются.\n\nПодтверждение действует 10 минут.`,
      parse_mode: "HTML",
      reply_markup: Object.freeze({ inline_keyboard: Object.freeze([
        Object.freeze([{ text: "🗑 Подтвердить очистку", callback_data: applyCallback }]),
        Object.freeze([{ text: "Отмена", callback_data: cancelCallback }]),
      ]) }),
    }),
  });
}

async function actionEvidence(request, outcome, actualRows, now, cryptoImpl) {
  return sha256Hex({
    requestId: request.request_id,
    planDigest: request.plan_digest,
    outcome,
    actualRows,
    completedAt: now,
    policyVersion: ANALYTICS_V2_ADMIN_POLICY_VERSION,
  }, cryptoImpl);
}

async function resolveRetentionRequest({
  store,
  session,
  requestToken,
  adminPseudonym,
  now,
}, options) {
  if (!TOKEN_PATTERN.test(requestToken || "")) throw new TypeError("request token is invalid");
  const request = await store.getRetentionRequestByTokenHash(
    await sha256Hex(requestToken, options.cryptoImpl),
  );
  if (!request || request.session_id !== session.session_id ||
      request.admin_pseudonym !== adminPseudonym ||
      request.session_revision !== session.revision) {
    throw new Error("retention request authority mismatch");
  }
  if (await store.getRetentionResult(request.request_id)) {
    throw new Error("retention request was already consumed");
  }
  if (request.expires_at <= now) throw new Error("retention request expired");
  return request;
}

export async function applyAnalyticsRetention({
  store,
  session,
  sessionToken,
  requestToken,
  adminPseudonym,
  now,
} = {}, options = {}) {
  if (!store?.commitRetention) throw new TypeError("analytics admin store cannot apply retention");
  if (!TOKEN_PATTERN.test(sessionToken || "")) throw new TypeError("session token is invalid");
  if (session?.screen !== "privacy") throw new Error("retention apply requires privacy screen");
  const request = await resolveRetentionRequest({
    store, session, requestToken, adminPseudonym, now,
  }, options);
  const current = await buildRetentionPlan(store, request.cutoff_at, options.cryptoImpl);
  if (current.planDigest !== request.plan_digest || current.plannedRows !== request.planned_rows) {
    const result = Object.freeze({
      result_id: randomUuid(options.cryptoImpl),
      request_id: request.request_id,
      outcome: "stale",
      reason_code: "plan_changed",
      actual_rows: 0,
      evidence_digest: await actionEvidence(request, "stale", 0, now, options.cryptoImpl),
      completed_at: now,
      retention_until: now + AUDIT_RETENTION,
      policy_version: ANALYTICS_V2_ADMIN_POLICY_VERSION,
    });
    await store.recordRetentionResult(result);
    return Object.freeze({ outcome: "stale", deletedRows: 0 });
  }
  const storedItems = await store.getRetentionItems(request.request_id);
  const storedComparable = storedItems.map(({
    dataset_name, planned_rows, item_digest,
  }) => ({ dataset_name, planned_rows, item_digest }));
  const currentComparable = [...current.items].sort((left, right) =>
    left.dataset_name.localeCompare(right.dataset_name));
  if (canonicalJson(storedComparable) !== canonicalJson(currentComparable)) {
    throw new Error("stored retention plan differs from current plan");
  }
  const result = Object.freeze({
    result_id: randomUuid(options.cryptoImpl),
    request_id: request.request_id,
    outcome: "completed",
    reason_code: "none",
    actual_rows: request.planned_rows,
    evidence_digest: await actionEvidence(
      request, "completed", request.planned_rows, now, options.cryptoImpl,
    ),
    completed_at: now,
    retention_until: now + AUDIT_RETENTION,
    policy_version: ANALYTICS_V2_ADMIN_POLICY_VERSION,
  });
  const guardTokenHash = await sha256Hex(randomToken(options.cryptoImpl), options.cryptoImpl);
  const committed = await store.commitRetention({
    request,
    items: storedItems,
    result,
    guardTokenHash,
    now,
  });
  if (committed.actualRows !== request.planned_rows) {
    throw new Error("retention deletion count was not exact");
  }
  return Object.freeze({ outcome: "completed", deletedRows: committed.actualRows });
}

export async function cancelAnalyticsRetention({
  store,
  session,
  requestToken,
  adminPseudonym,
  now,
} = {}, options = {}) {
  if (session?.screen !== "privacy") throw new Error("retention cancel requires privacy screen");
  const request = await resolveRetentionRequest({
    store, session, requestToken, adminPseudonym, now,
  }, options);
  const result = Object.freeze({
    result_id: randomUuid(options.cryptoImpl),
    request_id: request.request_id,
    outcome: "cancelled",
    reason_code: "admin_cancelled",
    actual_rows: 0,
    evidence_digest: await actionEvidence(request, "cancelled", 0, now, options.cryptoImpl),
    completed_at: now,
    retention_until: now + AUDIT_RETENTION,
    policy_version: ANALYTICS_V2_ADMIN_POLICY_VERSION,
  });
  await store.recordRetentionResult(result);
  return Object.freeze({ outcome: "cancelled", deletedRows: 0 });
}

function insertStatement(db, table, fields, row) {
  return db.prepare(
    `INSERT INTO ${table} (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`,
  ).bind(...fields.map((field) => row[field]));
}

export function createD1AnalyticsAdminStore(db) {
  if (!db?.prepare || !db?.batch) throw new TypeError("D1 analytics admin store requires prepare and batch");
  return Object.freeze({
    async getDatabaseSettings() {
      return db.prepare(
        `SELECT id, rollout_mode, master_enabled, ingest_enabled,
                projections_enabled, ambassador_enabled, event_registry_version,
                metric_dictionary_version, pseudonym_key_version,
                raw_retention_days, small_segment_threshold, revision
         FROM analytics_v2_settings WHERE id = 1 LIMIT 1`,
      ).first();
    },

    async getLatestMetricDate() {
      const row = await db.prepare(
        `SELECT MAX(metric_date) AS metric_date
         FROM analytics_projection_checkpoints
         WHERE projection_kind = 'daily'`,
      ).first();
      if (!row?.metric_date) throw new Error("analytics projection snapshot is unavailable");
      return row.metric_date;
    },

    async createSession(row) {
      const fields = [
        "session_id", "session_token_hash", "admin_pseudonym", "screen",
        "metric_date", "revision", "created_at", "updated_at", "expires_at",
        "closed_at", "retention_until", "policy_version",
      ];
      const result = await insertStatement(db, "analytics_admin_view_sessions", fields, row).run();
      if (resultChanges(result) !== 1) throw new Error("analytics admin session was not created");
      return row;
    },

    async getSessionByTokenHash(tokenHash) {
      return db.prepare(
        `SELECT * FROM analytics_admin_view_sessions
         WHERE session_token_hash = ? LIMIT 1`,
      ).bind(tokenHash).first();
    },

    async updateSession({
      sessionId, expectedRevision, screen, metricDate, updatedAt, closedAt,
    }) {
      const result = await db.prepare(
        `UPDATE analytics_admin_view_sessions
         SET screen = ?, metric_date = ?, revision = revision + 1,
             updated_at = ?, closed_at = ?
         WHERE session_id = ? AND revision = ? AND closed_at IS NULL
           AND expires_at > ?`,
      ).bind(
        screen, metricDate, updatedAt, closedAt, sessionId, expectedRevision,
        updatedAt,
      ).run();
      return resultChanges(result) === 1;
    },

    async loadScreen(screen, metricDate, databaseSettings) {
      utcDay(metricDate);
      if (screen === "diagnostics") {
        const [sources, issue, conflict, checkpoint] = await Promise.all([
          db.prepare(
            `SELECT
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
               SUM(CASE WHEN status NOT IN ('complete', 'off') THEN 1 ELSE 0 END) AS incomplete
             FROM analytics_source_checkpoints`,
          ).first(),
          db.prepare("SELECT COUNT(*) AS total FROM analytics_ingestion_issues").first(),
          db.prepare("SELECT COUNT(*) AS total FROM analytics_ingestion_conflicts").first(),
          db.prepare(
            `SELECT reconciliation.source_delta, reconciliation.canonical_delta,
                    reconciliation.projection_delta, snapshot.created_at
             FROM analytics_projection_checkpoints checkpoint
             JOIN analytics_projection_reconciliation reconciliation
               ON reconciliation.snapshot_id = checkpoint.current_snapshot_id
             JOIN analytics_projection_snapshots snapshot
               ON snapshot.snapshot_id = checkpoint.current_snapshot_id
             WHERE checkpoint.projection_kind = 'daily'
             ORDER BY checkpoint.metric_date DESC LIMIT 1`,
          ).first(),
        ]);
        return Object.freeze({ diagnostics: summarizeAnalyticsDiagnostics({
          configurationAligned: databaseSettings.rollout_mode === "admin_shadow" &&
            databaseSettings.master_enabled === 1 &&
            databaseSettings.ingest_enabled === 1 &&
            databaseSettings.projections_enabled === 1,
          sourceFailed: Number(sources?.failed || 0),
          sourceIncomplete: Number(sources?.incomplete || 0),
          issueRows: Number(issue?.total || 0),
          conflictRows: Number(conflict?.total || 0),
          sourceDelta: Number(checkpoint?.source_delta || 0),
          canonicalDelta: Number(checkpoint?.canonical_delta || 0),
          projectionDelta: Number(checkpoint?.projection_delta || 0),
          hasSnapshot: Boolean(checkpoint),
          snapshotAgeSeconds: checkpoint
            ? Math.max(0, Math.floor(Date.now() / 1000) - Number(checkpoint.created_at))
            : 0,
        }) });
      }
      if (screen === "privacy") {
        const counts = await this.countRetentionCandidates(Math.floor(Date.now() / 1000));
        return Object.freeze({
          retentionRows: Object.values(counts).reduce((sum, value) => sum + value, 0),
        });
      }
      const projectionKind = screen === "product_funnel" ? "funnel"
        : screen === "retention" ? "cohort"
        : screen === "ambassadors" ? "ambassador" : "daily";
      const checkpoint = await db.prepare(
        `SELECT current_snapshot_id FROM analytics_projection_checkpoints
         WHERE projection_kind = ? AND metric_date = ? LIMIT 1`,
      ).bind(projectionKind, metricDate).first();
      if (!checkpoint) return Object.freeze({ rows: Object.freeze([]) });
      let statement;
      if (screen === "overview") {
        statement = db.prepare(
          `SELECT metric_key, numerator_count, denominator_count, unique_actors,
                  metric_value, small_cell_threshold, suppressed
           FROM analytics_daily_metrics
           WHERE snapshot_id = ? AND metric_date = ?
             AND dimension_name = 'global' AND dimension_value = 'all'
           ORDER BY metric_key LIMIT 24`,
        ).bind(checkpoint.current_snapshot_id, metricDate);
      } else if (screen === "product_funnel") {
        statement = db.prepare(
          `SELECT step_key, step_order, qualified_actors, previous_step_actors,
                  conversion_bps, small_cell_threshold, suppressed
           FROM analytics_funnel_daily
           WHERE snapshot_id = ? AND metric_date = ? AND funnel_key = 'product'
           ORDER BY step_order LIMIT 8`,
        ).bind(checkpoint.current_snapshot_id, metricDate);
      } else if (screen === "retention") {
        statement = db.prepare(
          `SELECT offset_days, cohort_size, retained_actors, eligible,
                  retention_bps, small_cell_threshold, suppressed
           FROM analytics_cohort_daily
           WHERE snapshot_id = ? AND cohort_date = ?
           ORDER BY offset_days LIMIT 3`,
        ).bind(checkpoint.current_snapshot_id, metricDate);
      } else {
        statement = db.prepare(
          `SELECT scope_kind, metric_key, metric_count, unique_actors,
                  small_cell_threshold, suppressed
           FROM ambassador_metrics_daily
           WHERE snapshot_id = ? AND metric_date = ?
           ORDER BY metric_key, scope_kind LIMIT 10`,
        ).bind(checkpoint.current_snapshot_id, metricDate);
      }
      return Object.freeze({ rows: Object.freeze(resultRows(await statement.all()).map(Object.freeze)) });
    },

    async countRetentionCandidates(cutoffAt) {
      integer(cutoffAt, "retention cutoff", 1);
      const entries = await Promise.all(ANALYTICS_V2_RETENTION_DATASETS.map(async (table) => {
        const row = await db.prepare(
          `SELECT COUNT(*) AS total FROM ${table} WHERE retention_until <= ?`,
        ).bind(cutoffAt).first();
        return [table, Number(row?.total || 0)];
      }));
      return Object.freeze(Object.fromEntries(entries));
    },

    async createRetentionRequest(request, items) {
      const requestFields = [
        "request_id", "request_token_hash", "session_id", "admin_pseudonym",
        "action_kind", "cutoff_at", "plan_digest", "planned_rows",
        "dataset_count", "session_revision", "created_at", "expires_at",
        "retention_until", "policy_version",
      ];
      const itemFields = [
        "request_id", "dataset_name", "planned_rows", "item_digest",
        "created_at", "retention_until",
      ];
      const results = await db.batch([
        insertStatement(db, "analytics_admin_action_requests", requestFields, request),
        ...items.map((item) => insertStatement(db, "analytics_admin_action_items", itemFields, item)),
      ]);
      if (results.length !== items.length + 1 || results.some((result) => resultChanges(result) !== 1)) {
        throw new Error("retention request was not stored exactly");
      }
      return request;
    },

    async getRetentionRequestByTokenHash(tokenHash) {
      return db.prepare(
        `SELECT * FROM analytics_admin_action_requests
         WHERE request_token_hash = ? LIMIT 1`,
      ).bind(tokenHash).first();
    },

    async getRetentionItems(requestId) {
      const rows = await db.prepare(
        `SELECT dataset_name, planned_rows, item_digest, created_at,
                retention_until, request_id
         FROM analytics_admin_action_items
         WHERE request_id = ? ORDER BY dataset_name`,
      ).bind(requestId).all();
      return resultRows(rows);
    },

    async getRetentionResult(requestId) {
      return db.prepare(
        "SELECT * FROM analytics_admin_action_results WHERE request_id = ? LIMIT 1",
      ).bind(requestId).first();
    },

    async recordRetentionResult(result) {
      const fields = [
        "result_id", "request_id", "outcome", "reason_code", "actual_rows",
        "evidence_digest", "completed_at", "retention_until", "policy_version",
      ];
      const stored = await insertStatement(db, "analytics_admin_action_results", fields, result).run();
      if (resultChanges(stored) !== 1) throw new Error("retention result was not stored");
      return result;
    },

    async commitRetention({ request, items, result, guardTokenHash, now }) {
      const byDataset = new Map(items.map((item) => [item.dataset_name, item.planned_rows]));
      if (byDataset.size !== ANALYTICS_V2_RETENTION_DATASETS.length) {
        throw new Error("retention items are incomplete");
      }
      const resultFields = [
        "result_id", "request_id", "outcome", "reason_code", "actual_rows",
        "evidence_digest", "completed_at", "retention_until", "policy_version",
      ];
      const statements = [
        db.prepare(
          "DELETE FROM analytics_privacy_maintenance_guard WHERE id = 1 AND expires_at <= ?",
        ).bind(now),
        db.prepare(
          `INSERT INTO analytics_privacy_maintenance_guard (
             id, reason, subject_pseudonym, token_hash, created_by_kind,
             created_at, expires_at
           ) VALUES (1, 'retention', '', ?, 'admin', ?, ?)`,
        ).bind(guardTokenHash, now, now + 120),
      ];
      for (const table of ANALYTICS_V2_RETENTION_DATASETS) {
        statements.push(db.prepare(
          `DELETE FROM ${table}
           WHERE retention_until <= ?
             AND (SELECT COUNT(*) FROM ${table} WHERE retention_until <= ?) = ?`,
        ).bind(request.cutoff_at, request.cutoff_at, byDataset.get(table)));
      }
      statements.push(
        db.prepare(
          "DELETE FROM analytics_privacy_maintenance_guard WHERE id = 1 AND token_hash = ?",
        ).bind(guardTokenHash),
        insertStatement(db, "analytics_admin_action_results", resultFields, result),
      );
      const results = await db.batch(statements);
      const deletionResults = results.slice(2, 2 + ANALYTICS_V2_RETENTION_DATASETS.length);
      const actualRows = deletionResults.reduce((sum, item) => sum + resultChanges(item), 0);
      if (resultChanges(results.at(-1)) !== 1) {
        throw new Error("retention completion evidence was not stored");
      }
      return Object.freeze({ actualRows });
    },
  });
}
