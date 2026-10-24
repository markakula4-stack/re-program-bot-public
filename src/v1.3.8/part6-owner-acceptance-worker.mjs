import hotfixWorker, {
  DragonPreviewWorkflow,
  ReferralRewardProtectionWorkflow,
} from "../v1.3.8-hotfix.1/worker-entrypoint.mjs";
import {
  createAiPartnerOwnerWorkerRuntimePart5,
} from "./ai-partner-owner-worker-runtime-part5.mjs";

const BODY_LIMIT = 64 * 1024;
const OWNER_COMMAND = /^\/ai_partner(?:@RE_Program_Bot)?$/i;
const OWNER_CALLBACK = /^(?:ai_hub|a38p:|a38:|a38o:)/;

const OWNER_TELEGRAM_METHODS = new Set([
  "answerCallbackQuery",
  "savePreparedInlineMessage",
  "sendMessage",
  "sendMessageDraft",
  "sendRichMessage",
  "sendRichMessageDraft",
]);

function boundedInteger(value, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

export function isPart6TelegramFeatureUnsupported(
  method,
  statusCode,
  description = "",
) {
  const status = boundedInteger(statusCode, 100, 599);
  const richMethod =
    method === "sendRichMessage" || method === "sendRichMessageDraft";
  return Boolean(
    status === 404 ||
      (richMethod && status === 400) ||
      (status === 400 &&
        /method not found|not supported|unknown method|rich_message|ephemeral|disabled button/iu.test(
          String(description || ""),
        ))
  );
}

async function recordSafeDeliveryError(env, method, code, details = {}) {
  if (!env?.DB?.prepare) return;
  try {
    const safeMethod = OWNER_TELEGRAM_METHODS.has(String(method))
      ? String(method)
      : "unknown";
    const safeCode = /^[a-z0-9_.-]{3,80}$/.test(String(code || ""))
      ? String(code)
      : "telegram_delivery_failed";
    const statusCode = boundedInteger(details.statusCode, 100, 599);
    const telegramErrorCode = boundedInteger(
      details.telegramErrorCode,
      100,
      999,
    );
    const retryAfterSeconds = boundedInteger(
      details.retryAfterSeconds,
      1,
      86_400,
    );
    const tags = [
      safeMethod,
      safeCode,
      statusCode ? `http_${statusCode}` : null,
      telegramErrorCode ? `telegram_${telegramErrorCode}` : null,
      retryAfterSeconds ? `retry_${retryAfterSeconds}` : null,
    ].filter(Boolean);
    await env.DB.prepare(
      `INSERT INTO bot_error_log (context, message)
       VALUES (?, ?)`,
    ).bind(
      "ai_partner.part6_delivery",
      tags.join(":"),
    ).run();
  } catch {
    // Diagnostics must never widen or block the acceptance boundary.
  }
}

function dedupeInlineKeyboard(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const copy = structuredClone(payload);
  const rows = copy?.reply_markup?.inline_keyboard;
  if (!Array.isArray(rows)) return copy;

  const seen = new Set();
  copy.reply_markup.inline_keyboard = rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return copy;
}

async function part6TelegramCall(env, method, payload) {
  if (!OWNER_TELEGRAM_METHODS.has(method)) {
    const error = new Error("telegram_method_denied");
    error.code = "telegram_method_denied";
    throw error;
  }
  if (typeof env?.BOT_TOKEN !== "string" || env.BOT_TOKEN.trim().length < 20) {
    const error = new Error("telegram_bot_token_missing");
    error.code = "telegram_bot_token_missing";
    await recordSafeDeliveryError(env, method, error.code);
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    let response;
    try {
      response = await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(dedupeInlineKeyboard(payload)),
          signal: controller.signal,
        },
      );
    } catch (cause) {
      const error = new Error("telegram_delivery_unknown");
      error.code = cause?.name === "AbortError"
        ? "telegram_timeout_unknown"
        : "telegram_delivery_unknown";
      await recordSafeDeliveryError(env, method, error.code);
      throw error;
    }

    let result;
    try {
      result = await response.json();
    } catch {
      const error = new Error("telegram_response_invalid");
      error.code = "telegram_response_invalid";
      error.statusCode = response.status;
      await recordSafeDeliveryError(env, method, error.code, {
        statusCode: response.status,
      });
      throw error;
    }

    if (!response.ok || result?.ok !== true) {
      const description = String(result?.description || "");
      const unsupported = isPart6TelegramFeatureUnsupported(
        method,
        response.status,
        description,
      );
      const error = new Error(
        unsupported ? "telegram_feature_unsupported" : "telegram_request_rejected",
      );
      error.code = unsupported
        ? "telegram_feature_unsupported"
        : "telegram_request_rejected";
      error.statusCode = response.status;
      error.telegramErrorCode = boundedInteger(result?.error_code, 100, 999);
      error.retryAfterSeconds = boundedInteger(
        result?.parameters?.retry_after,
        1,
        86_400,
      );
      await recordSafeDeliveryError(env, method, error.code, {
        statusCode: error.statusCode,
        telegramErrorCode: error.telegramErrorCode,
        retryAfterSeconds: error.retryAfterSeconds,
      });
      throw error;
    }
    return result.result;
  } finally {
    clearTimeout(timeout);
  }
}

const part6OwnerRuntime = createAiPartnerOwnerWorkerRuntimePart5({
  callTelegram: part6TelegramCall,
});

function positiveId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function isPart6OwnerAcceptanceTarget(env, update) {
  const owner = positiveId(env?.ADMIN_ID);
  if (!owner || !update || typeof update !== "object") return false;

  const message = update.message;
  if (
    message?.chat?.type === "private" &&
    !message?.from?.is_bot &&
    positiveId(message?.from?.id) === owner &&
    positiveId(message?.chat?.id) === owner &&
    OWNER_COMMAND.test(String(message?.text || "").trim())
  ) {
    return true;
  }

  const callback = update.callback_query;
  if (
    callback?.message?.chat?.type === "private" &&
    !callback?.from?.is_bot &&
    positiveId(callback?.from?.id) === owner &&
    positiveId(callback?.message?.chat?.id) === owner &&
    typeof callback?.id === "string" &&
    OWNER_CALLBACK.test(String(callback?.data || ""))
  ) {
    return true;
  }

  const stopped = update.stopped_message_generation;
  const draftId = Number(stopped?.draft_id);
  if (
    stopped?.chat?.type === "private" &&
    positiveId(stopped?.chat?.id) === owner &&
    Number.isSafeInteger(draftId) &&
    draftId > 0
  ) {
    return true;
  }

  return false;
}

async function readJsonClone(request) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > BODY_LIMIT) return null;
  if (!/^application\/json(?:\s*;|$)/i.test(
    request.headers.get("Content-Type") || "",
  )) return null;
  try {
    return await request.clone().json();
  } catch {
    return null;
  }
}

async function claimOwnerAcceptanceUpdate(env, update) {
  const updateId = Number(update?.update_id);
  if (!Number.isSafeInteger(updateId) || updateId < 0 || !env?.DB?.prepare) {
    return false;
  }
  const actor = positiveId(
    update?.message?.from?.id ||
      update?.callback_query?.from?.id ||
      update?.stopped_message_generation?.chat?.id,
  );
  // The additive Part 6 schema predates Bot API 10.3 and constrains this column.
  // Preserve that schema while the runtime routes the official stop update.
  const type = update?.message
    ? "message"
    : update?.callback_query
      ? "callback_query"
      : "unsupported";
  const now = Math.floor(Date.now() / 1_000);
  const token = crypto.randomUUID();
  const row = await env.DB.prepare(
    `INSERT INTO telegram_update_receipts
       (update_id, update_type, actor_id, status, claim_token, attempt_count,
        received_at, lease_expires_at)
     VALUES (?, ?, ?, 'processing', ?, 1, ?, ?)
     ON CONFLICT(update_id) DO NOTHING
     RETURNING update_id`,
  ).bind(updateId, type, actor, token, now, now + 300).first();
  return Number(row?.update_id) === updateId ? token : false;
}

async function completeOwnerAcceptanceUpdate(env, update, token, status) {
  if (!token) return;
  const updateId = Number(update?.update_id);
  const now = Math.floor(Date.now() / 1_000);
  const errorCode = status === "failed" ? "owner_acceptance_runtime_failed" : "";
  await env.DB.prepare(
    `UPDATE telegram_update_receipts
        SET status = ?, completed_at = ?, lease_expires_at = 0,
            last_error_code = ?
      WHERE update_id = ? AND status = 'processing' AND claim_token = ?`,
  ).bind(
    status === "failed" ? "failed" : "completed",
    now,
    errorCode,
    updateId,
    token,
  ).run();
}

export async function handlePart6OwnerAcceptanceRequest(request, env, ctx) {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.pathname !== "/webhook" ||
    url.search ||
    !env?.WEBHOOK_SECRET ||
    request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET
  ) {
    return null;
  }

  const update = await readJsonClone(request);
  if (!isPart6OwnerAcceptanceTarget(env, update)) return null;

  const claimToken = await claimOwnerAcceptanceUpdate(env, update);
  if (!claimToken) return new Response("OK");

  let result;
  try {
    result = await part6OwnerRuntime.handleUpdate(env, update, {
      waitUntil:
        typeof ctx?.waitUntil === "function"
          ? ctx.waitUntil.bind(ctx)
          : null,
    });
  } catch {
    await completeOwnerAcceptanceUpdate(env, update, claimToken, "failed");
    return new Response("Handled with error", { status: 200 });
  }

  await completeOwnerAcceptanceUpdate(
    env,
    update,
    claimToken,
    result?.handled === true && result?.status !== "failed"
      ? "completed"
      : "failed",
  );
  return new Response("OK");
}

export { DragonPreviewWorkflow, ReferralRewardProtectionWorkflow };

export default {
  ...hotfixWorker,
  async fetch(request, env, ctx) {
    const accepted = await handlePart6OwnerAcceptanceRequest(request, env, ctx);
    if (accepted) return accepted;
    return hotfixWorker.fetch(request, env, ctx);
  },
};
