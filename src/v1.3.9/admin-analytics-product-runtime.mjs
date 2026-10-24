import {
  createD1AnalyticsAdminStore,
  renderAnalyticsAdminScreen,
} from "./admin-analytics-ux.mjs";

export const ANALYTICS_ADMIN_PRODUCT_RUNTIME_KEY =
  "__RE_PROGRAM_V139_ADMIN_ANALYTICS_RUNTIME__";

const DAY = 86_400;
const CALLBACK_TTL_SECONDS = 15 * 60;
const CALLBACK_CLOCK_SKEW_SECONDS = 60;
const CALLBACK_PREFIX = "a139r";
const CALLBACK_PATTERN = /^a139r:([ofrdpabcmx]):([0-9a-z]+):([0-9a-z]+):([0-9a-f]{24})$/;
const ANALYTICS_COMMAND = /^\/analytics(?:_v139)?(?:@RE_Program_Bot)?$/i;
const AMBASSADORS_COMMAND = /^\/ambassadors(?:_v139)?(?:@RE_Program_Bot)?$/i;
const OPEN_ANALYTICS_CALLBACK = "admin_analytics_v2";
const OPEN_AMBASSADORS_CALLBACK = "admin_ambassadors_v2";
const SCREEN_CODES = Object.freeze({
  overview: "o",
  product_funnel: "f",
  retention: "r",
  diagnostics: "d",
  privacy: "p",
  ambassador_home: "a",
  ambassador_profiles: "b",
  ambassador_campaigns: "c",
  ambassador_results: "m",
  close: "x",
});
const SCREENS = Object.freeze(Object.fromEntries(
  Object.entries(SCREEN_CODES).map(([screen, code]) => [code, screen]),
));

function telegramId(value) {
  const text = String(value ?? "");
  const parsed = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

function privateActor(update) {
  const source = update?.message || update?.callback_query;
  const actor = telegramId(source?.from?.id);
  const chat = update?.message?.chat || update?.callback_query?.message?.chat;
  return actor && source?.from?.is_bot !== true && chat?.type === "private" &&
    telegramId(chat?.id) === actor ? actor : null;
}

function target(update) {
  const text = String(update?.message?.text || "").trim();
  if (ANALYTICS_COMMAND.test(text)) return "overview";
  if (AMBASSADORS_COMMAND.test(text)) return "ambassador_home";
  const data = String(update?.callback_query?.data || "");
  if (data === OPEN_ANALYTICS_CALLBACK) return "overview";
  if (data === OPEN_AMBASSADORS_CALLBACK) return "ambassador_home";
  if (data.startsWith(`${CALLBACK_PREFIX}:`)) return "callback";
  return null;
}

export function analyticsAdminProductEnabled(env) {
  return String(env?.ANALYTICS_V139_OWNER_ENABLED || "").trim() === "true";
}

function runtimeMode(settings) {
  const flags = [
    "master_enabled",
    "ingest_enabled",
    "projections_enabled",
    "ambassador_enabled",
  ].map((field) => Number(settings?.[field]));
  if (settings?.rollout_mode === "off" && flags.every((value) => value === 0)) {
    return "off";
  }
  if (settings?.rollout_mode === "admin_shadow" &&
      flags.every((value) => value === 1)) {
    return "admin_shadow";
  }
  throw new Error("analytics database gates are inconsistent");
}

async function verifyReadableProductState(db) {
  if (!db?.prepare || !db?.batch) {
    throw new Error("analytics database is unavailable");
  }
  const settings = await db.prepare(
    `SELECT id, rollout_mode, master_enabled, ingest_enabled, projections_enabled,
            ambassador_enabled, event_registry_version,
            metric_dictionary_version, pseudonym_key_version,
            raw_retention_days, small_segment_threshold, revision
     FROM analytics_v2_settings WHERE id = 1 LIMIT 1`,
  ).first();
  if (!settings || Number(settings.id) !== 1 ||
      Number(settings.event_registry_version) !== 1 ||
      Number(settings.metric_dictionary_version) !== 1 ||
      Number(settings.pseudonym_key_version) !== 1 ||
      !Number.isSafeInteger(Number(settings.raw_retention_days)) ||
      Number(settings.raw_retention_days) < 1 ||
      Number(settings.raw_retention_days) > 180 ||
      !Number.isSafeInteger(Number(settings.small_segment_threshold)) ||
      Number(settings.small_segment_threshold) < 5 ||
      Number(settings.small_segment_threshold) > 20) {
    throw new Error("analytics database settings are incompatible");
  }
  const mode = runtimeMode(settings);
  const safety = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM analytics_privacy_projection_fence) AS fences,
       (SELECT COUNT(*) FROM analytics_privacy_maintenance_guard
          WHERE expires_at > unixepoch()) AS active_guards`,
  ).first();
  if (Number(safety?.fences || 0) !== 0 ||
      Number(safety?.active_guards || 0) !== 0) {
    throw new Error("analytics privacy gate is closed");
  }
  const checkpoint = await db.prepare(
    `SELECT checkpoint.metric_date, reconciliation.source_delta,
            reconciliation.canonical_delta, reconciliation.projection_delta
     FROM analytics_projection_checkpoints checkpoint
     JOIN analytics_projection_reconciliation reconciliation
       ON reconciliation.snapshot_id = checkpoint.current_snapshot_id
     WHERE checkpoint.projection_kind = 'daily'
     ORDER BY checkpoint.metric_date DESC LIMIT 1`,
  ).first();
  const latestMetricDate = Number(checkpoint?.metric_date);
  if (!Number.isSafeInteger(latestMetricDate) || latestMetricDate < DAY ||
      latestMetricDate % DAY !== 0 ||
      Number(checkpoint.source_delta) !== 0 ||
      Number(checkpoint.canonical_delta) !== 0 ||
      Number(checkpoint.projection_delta) !== 0) {
    throw new Error("analytics projection is not reconciled");
  }
  return Object.freeze({
    settings: Object.freeze({ ...settings }),
    latestMetricDate,
    mode,
  });
}

function displaySettings(settings) {
  return Object.freeze({
    ...settings,
    rollout_mode: "admin_shadow",
    master_enabled: 1,
    ingest_enabled: 1,
    projections_enabled: 1,
    ambassador_enabled: 1,
  });
}

function callbackPayload(actor, screenCode, dayCode, expiresCode) {
  return `v1|${actor}|${screenCode}|${dayCode}|${expiresCode}`;
}

async function callbackSignature(payload, secret, cryptoImpl = globalThis.crypto) {
  if (typeof secret !== "string" || secret.length < 32 || !cryptoImpl?.subtle) {
    throw new Error("analytics callback authority is unavailable");
  }
  const encoder = new TextEncoder();
  const key = await cryptoImpl.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await cryptoImpl.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  ));
  return Array.from(signature.slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

function secureEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function buildProductCallback({
  actor,
  screen,
  metricDate,
  expiresAt,
  secret,
  cryptoImpl,
}) {
  const screenCode = SCREEN_CODES[screen];
  const dayCode = Math.floor(metricDate / DAY).toString(36);
  const expiresCode = expiresAt.toString(36);
  if (!screenCode || !Number.isSafeInteger(metricDate) || metricDate < DAY ||
      metricDate % DAY !== 0 || !Number.isSafeInteger(expiresAt)) {
    throw new TypeError("analytics callback input is invalid");
  }
  const signature = await callbackSignature(
    callbackPayload(actor, screenCode, dayCode, expiresCode),
    secret,
    cryptoImpl,
  );
  const callback = `${CALLBACK_PREFIX}:${screenCode}:${dayCode}:${expiresCode}:${signature}`;
  if (new TextEncoder().encode(callback).length > 64) {
    throw new Error("analytics callback exceeds Telegram limit");
  }
  return callback;
}

async function parseProductCallback({
  value,
  actor,
  secret,
  now,
  cryptoImpl,
}) {
  const match = CALLBACK_PATTERN.exec(String(value || ""));
  if (!match) throw new Error("analytics callback is invalid");
  const [, screenCode, dayCode, expiresCode, actualSignature] = match;
  const day = Number.parseInt(dayCode, 36);
  const expiresAt = Number.parseInt(expiresCode, 36);
  if (!Number.isSafeInteger(day) || day < 1 ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= now ||
      expiresAt > now + CALLBACK_TTL_SECONDS + CALLBACK_CLOCK_SKEW_SECONDS) {
    throw new Error("analytics callback expired");
  }
  const expectedSignature = await callbackSignature(
    callbackPayload(actor, screenCode, dayCode, expiresCode),
    secret,
    cryptoImpl,
  );
  if (!secureEqual(actualSignature, expectedSignature)) {
    throw new Error("analytics callback authority mismatch");
  }
  return Object.freeze({
    screen: SCREENS[screenCode],
    metricDate: day * DAY,
  });
}

function isAmbassadorScreen(screen) {
  return String(screen || "").startsWith("ambassador_");
}

function freezeKeyboard(rows) {
  return Object.freeze(rows.map((row) => Object.freeze(
    row.map((button) => Object.freeze(button)),
  )));
}

async function buildKeyboard({
  actor,
  screen,
  metricDate,
  latestMetricDate,
  secret,
  now,
  cryptoImpl,
}) {
  const expiresAt = now + CALLBACK_TTL_SECONDS;
  const earliest = Math.max(DAY, latestMetricDate - 366 * DAY);
  const callback = (targetScreen, targetDate = metricDate) =>
    buildProductCallback({
      actor,
      screen: targetScreen,
      metricDate: targetDate,
      expiresAt,
      secret,
      cryptoImpl,
    });
  const dayRow = async () => {
    const values = await Promise.all([
      callback(screen, Math.max(earliest, metricDate - DAY)),
      callback(screen),
      callback(screen, Math.min(latestMetricDate, metricDate + DAY)),
    ]);
    return [
      { text: "◀️ День", callback_data: values[0] },
      { text: "🔄", callback_data: values[1] },
      { text: "День ▶️", callback_data: values[2] },
    ];
  };
  const backRow = [{
    text: "⬅️ В админ-панель",
    callback_data: "admin_dashboard",
  }];

  if (isAmbassadorScreen(screen)) {
    const values = await Promise.all([
      callback("ambassador_home"),
      callback("ambassador_profiles"),
      callback("ambassador_campaigns"),
      callback("ambassador_results"),
    ]);
    const rows = [
      [{ text: "🤝 Сводка", callback_data: values[0] }],
      [
        { text: "👤 Профили", callback_data: values[1] },
        { text: "📣 Кампании", callback_data: values[2] },
      ],
      [{ text: "📈 Эффективность", callback_data: values[3] }],
    ];
    if (screen === "ambassador_results") rows.push(await dayRow());
    rows.push(backRow);
    return freezeKeyboard(rows);
  }

  const values = await Promise.all([
    callback("overview"),
    callback("product_funnel"),
    callback("retention"),
    callback("diagnostics"),
    callback("privacy"),
  ]);
  return freezeKeyboard([
    [
      { text: "📊 Обзор", callback_data: values[0] },
      { text: "🪜 Воронка", callback_data: values[1] },
    ],
    [{ text: "🗓 Retention D1/D7/D30", callback_data: values[2] }],
    [
      { text: "🩺 Диагностика", callback_data: values[3] },
      { text: "🔐 Privacy", callback_data: values[4] },
    ],
    await dayRow(),
    backRow,
  ]);
}

function keyboard(message) {
  return message?.reply_markup?.inline_keyboard || [];
}

async function ambassadorInventory(db) {
  const profiles = await db.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(status = 'active'), 0) AS active,
            COALESCE(SUM(status = 'draft'), 0) AS draft,
            COALESCE(SUM(status = 'paused'), 0) AS paused,
            COALESCE(SUM(status = 'suspended'), 0) AS suspended,
            COALESCE(SUM(status = 'archived'), 0) AS archived
     FROM ambassador_profiles_v2`,
  ).first();
  const campaigns = await db.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(status = 'active'), 0) AS active
     FROM ambassador_campaigns`,
  ).first();
  const total = Number(profiles?.total || 0);
  const fields = ["active", "draft", "paused", "suspended", "archived"];
  const counts = Object.fromEntries(fields.map((field) =>
    [field, Number(profiles?.[field] || 0)]));
  const campaignTotal = Number(campaigns?.total || 0);
  const activeCampaigns = Number(campaigns?.active || 0);
  if (!Number.isSafeInteger(total) || total < 0 ||
      Object.values(counts).some((value) =>
        !Number.isSafeInteger(value) || value < 0) ||
      Object.values(counts).reduce((sum, value) => sum + value, 0) !== total ||
      !Number.isSafeInteger(campaignTotal) || campaignTotal < 0 ||
      !Number.isSafeInteger(activeCampaigns) || activeCampaigns < 0 ||
      activeCampaigns > campaignTotal) {
    throw new Error("ambassador inventory is inconsistent");
  }
  return Object.freeze({
    total,
    ...counts,
    campaigns: campaignTotal,
    activeCampaigns,
  });
}

function decorateMessage(message, mode) {
  let text = message.text;
  const modeLabel = mode === "off" ? "engine OFF" : "admin shadow";
  text += `\n\n<i>Режим: чтение проверенного snapshot · ${modeLabel} · ` +
    "без backfill и пересчёта.</i>";
  return Object.freeze({
    ...message,
    text,
  });
}

function renderAmbassadorScreen({ screen, metricDate, inventory, view }) {
  if (screen === "ambassador_results") {
    const rendered = renderAnalyticsAdminScreen({
      sessionToken: "0".repeat(18),
      session: Object.freeze({
        screen: "ambassadors",
        metric_date: metricDate,
        revision: 1,
      }),
      view,
    });
    return Object.freeze({
      ...rendered,
      text: rendered.text.replace(
        "<b>🤝 Амбассадоры 2.0</b>",
        "<b>📈 Эффективность амбассадоров</b>",
      ),
    });
  }

  const date = new Date(metricDate * 1_000).toISOString().slice(0, 10);
  let title = "🤝 Амбассадоры 2.0";
  let lines = [];
  if (screen === "ambassador_home") {
    const state = inventory.total === 0
      ? "Профилей пока нет — это реальное пустое состояние."
      : `Активных профилей: <b>${inventory.active}</b>.`;
    lines = [
      "Отдельный центр амбассадорской программы.",
      `<b>Профили:</b> <b>${inventory.total}</b>. ${state}`,
      `<b>Кампании:</b> <b>${inventory.campaigns}</b> · активных: ` +
        `<b>${inventory.activeCampaigns}</b>.`,
      "Используйте кнопки ниже для профилей, кампаний и эффективности.",
    ];
  } else if (screen === "ambassador_profiles") {
    title = "👤 Профили амбассадоров";
    lines = inventory.total === 0
      ? ["Профилей пока нет — это реальное пустое состояние."]
      : [
          `Всего: <b>${inventory.total}</b>`,
          `• Активные: <b>${inventory.active}</b>`,
          `• Черновики: <b>${inventory.draft}</b>`,
          `• На паузе: <b>${inventory.paused}</b>`,
          `• Приостановлены: <b>${inventory.suspended}</b>`,
          `• Архив: <b>${inventory.archived}</b>`,
        ];
  } else {
    title = "📣 Кампании амбассадоров";
    const inactive = inventory.campaigns - inventory.activeCampaigns;
    lines = inventory.campaigns === 0
      ? ["Кампаний пока нет — это реальное пустое состояние."]
      : [
          `Всего: <b>${inventory.campaigns}</b>`,
          `• Активные: <b>${inventory.activeCampaigns}</b>`,
          `• Неактивные: <b>${inactive}</b>`,
        ];
  }
  return Object.freeze({
    text: `<b>${title}</b>\n\nПроверенный UTC snapshot: ` +
      `<code>${date}</code>\n\n${lines.join("\n")}`,
    parse_mode: "HTML",
  });
}

async function renderProductScreen({
  db,
  store,
  screen,
  metricDate,
  latestMetricDate,
  settings,
  mode,
  actor,
  secret,
  now,
  cryptoImpl,
}) {
  let rendered;
  if (isAmbassadorScreen(screen)) {
    const inventory = await ambassadorInventory(db);
    const view = screen === "ambassador_results"
      ? await store.loadScreen(
          "ambassadors",
          metricDate,
          displaySettings(settings),
        )
      : null;
    rendered = renderAmbassadorScreen({ screen, metricDate, inventory, view });
  } else {
    const view = await store.loadScreen(
      screen,
      metricDate,
      displaySettings(settings),
    );
    rendered = renderAnalyticsAdminScreen({
      sessionToken: "0".repeat(18),
      session: Object.freeze({ screen, metric_date: metricDate, revision: 1 }),
      view,
    });
  }
  const replyMarkup = Object.freeze({
    inline_keyboard: await buildKeyboard({
      actor,
      screen,
      metricDate,
      latestMetricDate,
      secret,
      now,
      cryptoImpl,
    }),
  });
  return decorateMessage(Object.freeze({
    ...rendered,
    reply_markup: replyMarkup,
  }), mode);
}

async function acknowledgeCallback(transport, env, update) {
  const callbackId = update?.callback_query?.id;
  if (!callbackId) return;
  try {
    await transport.answerCallback(env, callbackId);
  } catch {
    // Rendering remains useful when Telegram considers an old callback expired.
  }
}

async function deliver(transport, env, update, message) {
  const callback = update.callback_query;
  const chatId = privateActor(update);
  if (callback?.message?.message_id) {
    return transport.editMessage(
      env,
      chatId,
      callback.message.message_id,
      message.text,
      keyboard(message),
      "analytics_v139.admin_product",
    );
  }
  return transport.sendMessage(env, chatId, message.text, keyboard(message));
}

function assertTransport(transport) {
  if (!transport || typeof transport.sendMessage !== "function" ||
      typeof transport.editMessage !== "function" ||
      typeof transport.answerCallback !== "function") {
    throw new TypeError("analytics Telegram transport is incomplete");
  }
}

function normalizeVerifiedState(verified) {
  if (verified?.settings && Number.isSafeInteger(verified.latestMetricDate)) {
    return verified;
  }
  return Object.freeze({
    settings: Object.freeze({ ...verified }),
    latestMetricDate: null,
    mode: runtimeMode(verified),
  });
}

export async function handleAnalyticsAdminProductUpdate({
  env,
  update,
  transport,
} = {}, options = {}) {
  const requested = target(update);
  if (!requested || !analyticsAdminProductEnabled(env)) {
    return Object.freeze({ handled: false });
  }
  assertTransport(transport);
  const actor = privateActor(update);
  const configuredAdmin = telegramId(env?.ADMIN_ID);
  if (!actor || actor !== configuredAdmin) {
    await acknowledgeCallback(transport, env, update);
    if (actor) {
      await transport.sendMessage(env, actor, "Команда недоступна.", []);
    }
    return Object.freeze({ handled: true, outcome: "denied" });
  }

  await acknowledgeCallback(transport, env, update);
  try {
    const now = Math.floor(Date.now() / 1_000);
    const cryptoImpl = options.cryptoImpl || globalThis.crypto;
    const secret = env?.ANALYTICS_SUBJECT_PSEUDONYM_SECRET;
    let requestedScreen = requested;
    let requestedDate = null;
    if (requested === "callback") {
      const parsed = await parseProductCallback({
        value: update.callback_query.data,
        actor,
        secret,
        now,
        cryptoImpl,
      });
      requestedScreen = parsed.screen;
      requestedDate = parsed.metricDate;
      if (requestedScreen === "close") {
        const message = Object.freeze({
          text: "✅ Просмотр аналитики закрыт. Данные не изменены.",
          reply_markup: Object.freeze({ inline_keyboard: Object.freeze([
            Object.freeze([Object.freeze({
              text: "⬅️ В админ-панель",
              callback_data: "admin_dashboard",
            })]),
          ]) }),
        });
        await deliver(transport, env, update, message);
        return Object.freeze({ handled: true, outcome: "closed" });
      }
    }

    const verifyState = options.verifyState || verifyReadableProductState;
    const storeFactory = options.storeFactory || createD1AnalyticsAdminStore;
    const store = storeFactory(env.DB);
    let verified = normalizeVerifiedState(await verifyState(env.DB));
    if (verified.latestMetricDate === null) {
      verified = Object.freeze({
        ...verified,
        latestMetricDate: await store.getLatestMetricDate(),
      });
    }
    const earliest = Math.max(DAY, verified.latestMetricDate - 366 * DAY);
    const metricDate = requestedDate ?? verified.latestMetricDate;
    if (!Number.isSafeInteger(metricDate) || metricDate % DAY !== 0 ||
        metricDate < earliest || metricDate > verified.latestMetricDate) {
      throw new Error("analytics callback date is outside the read window");
    }
    const message = await renderProductScreen({
      db: env.DB,
      store,
      screen: requestedScreen,
      metricDate,
      latestMetricDate: verified.latestMetricDate,
      settings: verified.settings,
      mode: verified.mode,
      actor,
      secret,
      now,
      cryptoImpl,
    });
    await deliver(transport, env, update, message);
    return Object.freeze({
      handled: true,
      outcome: "rendered",
      screen: requestedScreen,
    });
  } catch {
    await transport.sendMessage(
      env,
      actor,
      "Аналитика временно недоступна. Данные не изменены.",
      [[{ text: "⬅️ В админ-панель", callback_data: "admin_dashboard" }]],
    );
    return Object.freeze({ handled: true, outcome: "unavailable" });
  }
}

export const analyticsAdminProductRuntime = Object.freeze({
  handleUpdate: handleAnalyticsAdminProductUpdate,
});
