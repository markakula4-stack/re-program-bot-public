import stableWorker, {
  DragonPreviewWorkflow,
  ReferralRewardProtectionWorkflow,
} from "../v1.3.8-hotfix.1/worker-entrypoint.mjs";
import { createD1UnifiedMetricsReader } from "./unified-metrics.mjs";
import { createD1OwnerAnalyticsReader } from "./owner-analytics.mjs";
import { ANALYTICS_PRIVACY_RUNTIME_KEY,
  analyticsPrivacyRuntime } from "./privacy-deletion-runtime.mjs";
import { ANALYTICS_ADMIN_PRODUCT_RUNTIME_KEY,
  analyticsAdminProductRuntime } from "./admin-analytics-product-runtime.mjs";

const PUBLIC_RELEASE_RUNTIME_KEY = "__RE_PROGRAM_PUBLIC_RELEASE_RUNTIME__";
const PUBLIC_VERSION = "1.3.9";
const ACCEPTANCE_REVISION = "p05-admin-product-candidate";

globalThis[PUBLIC_RELEASE_RUNTIME_KEY] = Object.freeze({
  version: PUBLIC_VERSION,
  acceptanceRevision: ACCEPTANCE_REVISION,
});
globalThis[ANALYTICS_PRIVACY_RUNTIME_KEY] = analyticsPrivacyRuntime;
globalThis[ANALYTICS_ADMIN_PRODUCT_RUNTIME_KEY] = analyticsAdminProductRuntime;

const DAY = 86_400;
const LIMIT = 64 * 1024;
const COMMAND = /^\/analytics_v139(?:@RE_Program_Bot)?$/i;
const AMBASSADORS_COMMAND = /^\/ambassadors_v139(?:@RE_Program_Bot)?$/i;
const OWNER_WINDOW = /^true:(\d{10}):(\d{10})$/;
const OWNER_WINDOW_MAX_SECONDS = 20 * 60;
export { DragonPreviewWorkflow, ReferralRewardProtectionWorkflow };

function id(value) {
  const text = String(value ?? "");
  const number = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(number) && number > 0
    ? number : null;
}

function commandTarget(update, command) {
  const message = update?.message;
  const user = id(message?.from?.id);
  return user && message?.chat?.type === "private" &&
    id(message.chat.id) === user && message.from.is_bot !== true &&
    command.test(String(message.text || "").trim()) ? user : null;
}

export function analyticsV139Target(update) {
  return commandTarget(update, COMMAND);
}

export function ambassadorsV139Target(update) {
  return commandTarget(update, AMBASSADORS_COMMAND);
}

export function analyticsV139OwnerWindowOpen(env, now = Math.floor(Date.now() / 1_000)) {
  const match = OWNER_WINDOW.exec(String(env?.ANALYTICS_V139_OWNER_ENABLED || ""));
  if (!match || !Number.isSafeInteger(now) || now < 1) return false;
  const issuedAt = Number(match[1]);
  const expiresAt = Number(match[2]);
  return Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt) &&
    issuedAt <= now + 60 && now < expiresAt && expiresAt > issuedAt &&
    expiresAt - issuedAt <= OWNER_WINDOW_MAX_SECONDS &&
    now - issuedAt <= OWNER_WINDOW_MAX_SECONDS + 60;
}

function formatCell(label, cell) {
  return `${label}: ${cell?.available && !cell?.suppressed &&
    cell?.value !== null ? cell.value : 'скрыто'}`;
}

export function renderAnalyticsV139(frame, audience) {
  if (audience === "admin") {
    if (frame?.ready !== true) return "Аналитика: сверка источников ещё не завершена.";
    return ["Аналитика · вчера · UTC",
      formatCell("Заявки", frame.metrics.leads),
      formatCell("Платежи", frame.metrics.payments),
      formatCell("Возвраты", frame.metrics.refunds),
      formatCell("Оценка затрат AI Gateway (мкUSD)", frame.metrics.estimatedAiCostMicrousd),
    ].join("\n");
  }
  return ["Моя аналитика амбассадора · вчера · UTC",
    formatCell("Переходы", frame.metrics.tracking_opens),
    formatCell("Заявки", frame.metrics.attributed_leads),
    formatCell("Подтверждённые награды", frame.metrics.confirmed_referral_rewards),
  ].join("\n");
}

export function renderAmbassadorsV139(counts) {
  const fields = ["total", "active", "draft", "paused", "suspended", "archived"];
  if (!counts || fields.some((field) =>
    !Number.isSafeInteger(counts[field]) || counts[field] < 0) ||
    counts.total !== fields.slice(1).reduce((sum, field) => sum + counts[field], 0)) {
    throw new TypeError("ambassador inventory is inconsistent");
  }
  return ["Амбассадоры 2.0",
    `Всего: ${counts.total}`,
    `Активных: ${counts.active}`,
    `Черновиков: ${counts.draft}`,
    `На паузе: ${counts.paused}`,
    `Приостановлено: ${counts.suspended}`,
    `В архиве: ${counts.archived}`,
    counts.total === 0 ? "Пока профилей нет — это честный empty-state." :
      "Показаны только агрегированные статусы.",
  ].join("\n");
}

async function send(env, actor, text) {
  if (typeof env.BOT_TOKEN !== "string" || env.BOT_TOKEN.length < 20) {
    throw new Error("Telegram delivery is unavailable");
  }
  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: actor, text }),
      signal: AbortSignal.timeout(10_000),
    });
  if (!response.ok || (await response.json())?.ok !== true) {
    throw new Error("Telegram delivery failed");
  }
}

async function releaseHealth(response) {
  if (response.status !== 200 ||
      !String(response.headers.get("content-type") || "")
        .toLowerCase().includes("application/json")) return response;
  const payload = await response.json();
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  return Response.json({
    ...payload,
    version: PUBLIC_VERSION,
    acceptanceRevision: ACCEPTANCE_REVISION,
  }, { status: response.status, headers });
}

async function readUpdate(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(
    request.headers.get("Content-Type") || "")) return null;
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > LIMIT) return null;
  const body = await request.clone().text();
  if (new TextEncoder().encode(body).length > LIMIT) return null;
  try { return JSON.parse(body); } catch { return null; }
}

async function claim(db, update, actor) {
  const updateId = Number(update?.update_id);
  if (!Number.isSafeInteger(updateId) || updateId < 0) return null;
  const token = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1_000);
  const row = await db.prepare(`INSERT INTO telegram_update_receipts
    (update_id, update_type, actor_id, status, claim_token, attempt_count,
      received_at, lease_expires_at)
    VALUES (?, 'message', ?, 'processing', ?, 1, ?, ?)
    ON CONFLICT(update_id) DO NOTHING RETURNING update_id`)
    .bind(updateId, actor, token, now, now + 300).first();
  return Number(row?.update_id) === updateId ? token : null;
}

async function finish(db, update, token, status) {
  await db.prepare(`UPDATE telegram_update_receipts
    SET status = ?, lease_expires_at = 0, completed_at = unixepoch(),
      last_error_code = ? WHERE update_id = ? AND claim_token = ?
      AND status = 'processing'`)
    .bind(status, status === "completed" ? "" : "analytics_v139_delivery_unknown",
      update.update_id, token).run();
}

export async function handleAnalyticsV139Request(request, env, executionContext) {
  const url = new URL(request.url);
  if (!analyticsV139OwnerWindowOpen(env) ||
      request.method !== "POST" || url.pathname !== "/webhook" ||
      url.search || !env?.WEBHOOK_SECRET ||
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
        env.WEBHOOK_SECRET) return null;
  const update = await readUpdate(request);
  const analyticsActor = analyticsV139Target(update);
  const ambassadorsActor = ambassadorsV139Target(update);
  const actor = analyticsActor || ambassadorsActor;
  if (!actor) return null;
  const owner = id(env.ADMIN_ID);
  if (ambassadorsActor && actor !== owner) return new Response("OK");
  // A command from an unlisted account is handled without any D1 read or
  // Telegram response. The stable Worker never sees it as an admin command.
  const audience = actor === owner ? "admin" : "partner";
  if (!env.DB?.prepare || !env.DB?.batch) return new Response("OK");
  try {
    const authority = await env.DB.prepare(`SELECT 1 AS active
      FROM analytics_v139_active_shadow_authority LIMIT 1`).first();
    if (!authority) return new Response("OK");
    if (audience === "partner") {
      const allowed = await env.DB.prepare(`SELECT 1 AS allowed
        FROM analytics_v139_partner_pilot pilot
        JOIN user_roles role ON role.telegram_id = pilot.telegram_id
          AND role.role = 'partner' AND role.status = 'active'
        JOIN users account ON account.telegram_id = pilot.telegram_id
          AND account.is_blocked = 0
        WHERE pilot.telegram_id = ? AND pilot.enabled = 1
          AND pilot.expires_at > unixepoch() LIMIT 1`)
        .bind(actor).first();
      if (!allowed) return new Response("OK");
    }
    const token = await claim(env.DB, update, actor);
    if (!token) return new Response("OK");
    try {
      const v141=env.V141_AUTHORIZATION_ENABLED==='true'
        ?globalThis.__RE_PROGRAM_V141_AUTHORIZATION_RUNTIME__:null;
      if(env.V141_AUTHORIZATION_ENABLED==='true'&&!v141)throw new Error('v141_runtime_unavailable');
      if(v141) {
        env=await v141.enterTelegram({env,request,receiptClaimToken:token,update,executionContext});
        await v141.read(env,audience==='admin'?'admin.analytics.read':'analytics.read_personal',undefined,
          audience==='admin'?{kind:'admin_surface',key:'analytics'}:null);
      }
      if (ambassadorsActor) {
        const counts = await env.DB.prepare(`SELECT COUNT(*) AS total,
          COALESCE(SUM(status='active'),0) AS active,
          COALESCE(SUM(status='draft'),0) AS draft,
          COALESCE(SUM(status='paused'),0) AS paused,
          COALESCE(SUM(status='suspended'),0) AS suspended,
          COALESCE(SUM(status='archived'),0) AS archived
          FROM ambassador_profiles_v2
          WHERE EXISTS (SELECT 1 FROM analytics_v139_active_shadow_authority)
            AND NOT EXISTS (SELECT 1 FROM analytics_privacy_projection_fence)`).first();
        if(v141)await v141.read(env,'admin.analytics.read',undefined,{kind:'admin_surface',key:'analytics'});
        await send(env, actor, renderAmbassadorsV139(counts));
      } else {
        const end = Math.floor(Date.now() / 1_000 / DAY) * DAY;
        const args = { periodStart: end - DAY, periodEnd: end,
          asOfAt: Math.floor(Date.now() / 1_000) };
        const frame = audience === "admin"
          ? await createD1UnifiedMetricsReader(env.DB, async () => ({
            verified: true, scope: "admin_global" })).read({ audience, ...args })
          : await createD1OwnerAnalyticsReader(env.DB, async () => ({
            verified: true, telegramId: actor })).read(args);
        if(v141)await v141.read(env,audience==='admin'?'admin.analytics.read':'analytics.read_personal',undefined,
          audience==='admin'?{kind:'admin_surface',key:'analytics'}:null);
        await send(env, actor, renderAnalyticsV139(frame, audience));
      }
      await finish(env.DB, update, token, "completed");
    } catch {
      try { await send(env, actor, "Аналитика временно недоступна."); } catch {}
      await finish(env.DB, update, token, "failed");
    }
  } catch {
    // A missing migration, unavailable D1, or closed fence fails closed.
  }
  return new Response("OK");
}

export default {
  ...stableWorker,
  async fetch(request, env, ctx) {
    const handled = await handleAnalyticsV139Request(request, env, ctx);
    if (handled) return handled;
    const response = await stableWorker.fetch(request, env, ctx);
    const url = new URL(request.url);
    if (request.method === "GET" && !url.search &&
        (url.pathname === "/" || url.pathname === "/health")) {
      return releaseHealth(response);
    }
    return response;
  },
};
