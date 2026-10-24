import { WorkflowEntrypoint } from "cloudflare:workers";
import {
  DRAGON_PREVIEW_PROGRAM_CODE,
  calculatePreviewWindow,
  formatPreviewDate,
  formatPreviewRemaining,
  isActiveTelegramMembership,
  isPreviewGrantActive,
  readDragonPreviewConfig,
} from "./dragon-preview-core.mjs";
import {hasLegacyCompatibilityEnv,assertLegacyPreviewWorkflowFresh} from '../v1.4.1/telegram-legacy-compatibility.mjs';
import {assertLegacyPreviewMembershipFresh,upgradeLegacyPreviewActivation} from '../v1.4.1/legacy-access-runtime.mjs';

const PREVIEW_SOURCE = "dragon_preview:v1.3.5-hotfix.1";
const PREVIEW_CALLBACK_OPEN = "dragon_preview_open";
const PREVIEW_CALLBACK_CHECK = "dragon_preview_check";
const TELEGRAM_TIMEOUT_MS = 8_000;
const MAINTENANCE_BATCH_LIMIT = 50;

function nowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function isMissingPreviewSchema(error) {
  return /no such table:\s*(?:trial_grants|trial_eligibility_checks|notification_jobs)/i.test(
    String(error?.message || error),
  );
}

function safeErrorCode(error) {
  return String(error?.code || error?.name || "preview_error")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 64);
}

function changes(result) {
  return Number(result?.meta?.changes || result?.changes || 0);
}

async function createSubjectFingerprint(secret, telegramId) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${DRAGON_PREVIEW_PROGRAM_CODE}:${Number(telegramId)}`),
  );
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function getGrantByTelegramId(env, telegramId) {
  try {
    return await env.DB.prepare(
      `SELECT grant_id, telegram_id, subject_fingerprint, program_code,
              status, started_at, ends_at, retention_until,
              workflow_instance_id, workflow_state, warning_sent_at,
              ended_at, anonymized_at
       FROM trial_grants
       WHERE telegram_id = ? AND program_code = ?
       ORDER BY granted_at DESC
       LIMIT 1`,
    )
      .bind(Number(telegramId), DRAGON_PREVIEW_PROGRAM_CODE)
      .first();
  } catch (error) {
    if (isMissingPreviewSchema(error)) return null;
    throw error;
  }
}

async function getGrantByFingerprint(env, fingerprint) {
  return env.DB.prepare(
    `SELECT grant_id, telegram_id, subject_fingerprint, program_code,
            status, started_at, ends_at, retention_until,
            workflow_instance_id, workflow_state, warning_sent_at,
            ended_at, anonymized_at
     FROM trial_grants
     WHERE subject_fingerprint = ? AND program_code = ?
     LIMIT 1`,
  )
    .bind(fingerprint, DRAGON_PREVIEW_PROGRAM_CODE)
    .first();
}

async function getUserPreviewPrerequisites(env, telegramId) {
  return env.DB.prepare(
    `SELECT users.telegram_id, users.accepted_terms, users.is_blocked,
            COALESCE(access.access_tier, 'free') AS access_tier,
            COALESCE(access.trial_used, 0) AS trial_used,
            plans.plan_code AS plan_code,
            states.access_state AS access_state
     FROM users
     LEFT JOIN user_access access ON access.telegram_id = users.telegram_id
     LEFT JOIN user_plans plans ON plans.telegram_id = users.telegram_id
     LEFT JOIN user_access_states states ON states.telegram_id = users.telegram_id
     WHERE users.telegram_id = ?
     LIMIT 1`,
  )
    .bind(Number(telegramId))
    .first();
}

async function recordEligibilityCheck(
  env,
  telegramId,
  fingerprint,
  outcome,
  channelStatus = "",
) {
  try {
    await env.DB.prepare(
      `INSERT INTO trial_eligibility_checks
         (check_id, telegram_id, subject_fingerprint, program_code,
          outcome, channel_status, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        Number(telegramId),
        fingerprint || null,
        DRAGON_PREVIEW_PROGRAM_CODE,
        String(outcome),
        String(channelStatus || "").slice(0, 32),
        nowSeconds(),
      )
      .run();
  } catch (error) {
    if (!isMissingPreviewSchema(error)) {
      console.error("Could not record Dragon Preview eligibility", error);
    }
  }
}

async function callTelegram(env, method, payload) {
  if (!env.BOT_TOKEN) {
    const error = new Error("BOT_TOKEN is not configured");
    error.code = "bot_token_missing";
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  let response;
  let data;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    data = await response.json();
  } catch (cause) {
    const error = new Error(
      controller.signal.aborted
        ? `Telegram ${method} timed out`
        : `Telegram ${method} transport failed`,
    );
    error.code = controller.signal.aborted
      ? "telegram_timeout"
      : "telegram_transport_ambiguous";
    error.ambiguous = true;
    error.cause = cause;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok || !data?.ok) {
    const error = new Error(`Telegram ${method} failed`);
    error.code = `telegram_${Number(data?.error_code || response.status || 0)}`;
    error.telegramErrorCode = Number(data?.error_code || response.status || 0);
    error.retryAfter = Number(data?.parameters?.retry_after || 0);
    error.retryable = error.telegramErrorCode === 429 || error.telegramErrorCode >= 500;
    throw error;
  }
  return data.result;
}

async function checkChannelMembership(env, config, telegramId) {
  const member = await callTelegram(env, "getChatMember", {
    chat_id: config.channelId,
    user_id: Number(telegramId),
  });
  return {
    active: isActiveTelegramMembership(member),
    status: String(member?.status || "unknown").slice(0, 32),
  };
}

function previewOperationalError(code) {
  const error = new Error("Dragon Preview operational check failed");
  error.code = code;
  return error;
}

export async function verifyDragonPreviewChannel(env) {
  const config = readDragonPreviewConfig(env);
  if (!config.ready) throw previewOperationalError("preview_config_not_ready");

  const bot = await callTelegram(env, "getMe", {});
  if (String(bot?.username || "").toLowerCase() !== "re_program_bot") {
    throw previewOperationalError("preview_bot_identity_mismatch");
  }

  const chat = await callTelegram(env, "getChat", {
    chat_id: config.channelId,
  });
  if (
    chat?.type !== "channel" ||
    `@${String(chat?.username || "").toLowerCase()}` !==
      String(config.channelId).toLowerCase()
  ) {
    throw previewOperationalError("preview_channel_identity_mismatch");
  }

  const member = await callTelegram(env, "getChatMember", {
    chat_id: config.channelId,
    user_id: Number(bot.id),
  });
  if (
    Number(member?.user?.id) !== Number(bot.id) ||
    !["creator", "administrator"].includes(String(member?.status || ""))
  ) {
    throw previewOperationalError("preview_bot_not_channel_admin");
  }

  return Object.freeze({
    channel: config.channelId,
    bot: `@${bot.username}`,
    botStatus: String(member.status),
  });
}

function activeSummary(grant, now = nowSeconds()) {
  return (
    "\n\n🔴 <b>Dragon Preview активен</b>\n" +
    `Осталось: <b>${formatPreviewRemaining(grant.ends_at, now)}</b>\n` +
    `До: <b>${formatPreviewDate(grant.ends_at)}</b>`
  );
}

function usedSummary(grant) {
  if (grant?.status === "expired") {
    return "\n\n✅ Dragon Preview уже был использован и завершён. Повторная выдача не предусмотрена.";
  }
  return "\n\n✅ Dragon Preview уже был использован. Повторная выдача не предусмотрена.";
}

async function setWorkflowState(env, grantId, state, errorCode = "") {
  try {
    await env.DB.prepare(
      `UPDATE trial_grants
       SET workflow_state = ?, workflow_error_code = ?, updated_at = ?
       WHERE grant_id = ?`,
    )
      .bind(state, errorCode.slice(0, 64), nowSeconds(), grantId)
      .run();
  } catch (error) {
    console.error("Could not update Dragon Preview workflow state", error);
  }
}

async function repairActiveAccess(env, grant) {
  const started = Number(grant.started_at);
  const ends = Number(grant.ends_at);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user_access
         (telegram_id, access_tier, trial_used, trial_started_at,
          trial_ends_at, updated_at)
       VALUES (?, 'trial', 1, datetime(?, 'unixepoch'),
               datetime(?, 'unixepoch'), CURRENT_TIMESTAMP)
       ON CONFLICT(telegram_id) DO UPDATE SET
         access_tier = 'trial',
         trial_used = 1,
         trial_started_at = datetime(excluded.trial_started_at),
         trial_ends_at = datetime(excluded.trial_ends_at),
         updated_at = CURRENT_TIMESTAMP
       WHERE user_access.access_tier = 'free'
          OR (user_access.access_tier = 'trial' AND (
            user_access.trial_used <> 1
            OR user_access.trial_started_at <> excluded.trial_started_at
            OR user_access.trial_ends_at <> excluded.trial_ends_at
          ))`,
    ).bind(Number(grant.telegram_id), started, ends),
    env.DB.prepare(
      `INSERT OR IGNORE INTO user_plans
         (telegram_id, plan_code, source_code, effective_from)
       VALUES (?, 'free', ?, datetime(?, 'unixepoch'))`,
    ).bind(Number(grant.telegram_id), PREVIEW_SOURCE, started),
    env.DB.prepare(
      `INSERT INTO user_access_states
         (telegram_id, access_state, source_code, state_started_at,
          state_ends_at, revision, updated_at)
       VALUES (?, 'trial', ?, datetime(?, 'unixepoch'),
               datetime(?, 'unixepoch'), 1, CURRENT_TIMESTAMP)
       ON CONFLICT(telegram_id) DO UPDATE SET
         access_state = 'trial',
         source_code = excluded.source_code,
         state_started_at = excluded.state_started_at,
         state_ends_at = excluded.state_ends_at,
         revision = user_access_states.revision + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE user_access_states.access_state IN ('none', 'expired')
          OR (user_access_states.access_state = 'trial' AND (
            user_access_states.source_code <> excluded.source_code
            OR user_access_states.state_started_at <> excluded.state_started_at
            OR user_access_states.state_ends_at <> excluded.state_ends_at
          ))`,
    ).bind(Number(grant.telegram_id), PREVIEW_SOURCE, started, ends),
  ]);
}

async function repairExpiredAccess(env, grant) {
  if (!grant?.telegram_id) return;
  const userId = Number(grant.telegram_id);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE user_access
       SET access_tier = 'free', trial_used = 1, updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND access_tier = 'trial'
         AND (trial_ends_at IS NULL OR trial_ends_at <= CURRENT_TIMESTAMP)`,
    ).bind(userId),
    env.DB.prepare(
      `UPDATE user_access_states
       SET access_state = 'expired', source_code = ?,
           state_ends_at = COALESCE(state_ends_at, datetime(?, 'unixepoch')),
           revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND access_state = 'trial'
         AND source_code = ?`,
    ).bind(PREVIEW_SOURCE, Number(grant.ends_at), userId, PREVIEW_SOURCE),
  ]);
}

export async function expireDragonPreviewGrant(
  env,
  grantId,
  currentTime = nowSeconds(),
) {
  const grant = await env.DB.prepare(
    `SELECT grant_id, telegram_id, status, started_at, ends_at
     FROM trial_grants WHERE grant_id = ? LIMIT 1`,
  )
    .bind(String(grantId))
    .first();
  if (!grant) return { changed: false, reason: "missing" };
  if (grant.status !== "active") {
    if (grant.status === "expired") await repairExpiredAccess(env, grant);
    return { changed: false, reason: grant.status };
  }
  if (Number(grant.ends_at) > Number(currentTime)) {
    return { changed: false, reason: "not_due" };
  }

  const expiredEventId = `preview-expired:${grant.grant_id}`;
  const funnelEventId = `preview-funnel-expired:${grant.grant_id}`;
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE trial_grants
       SET status = 'expired', ended_at = ?, updated_at = ?
       WHERE grant_id = ? AND status = 'active' AND ends_at <= ?`,
    ).bind(currentTime, currentTime, grant.grant_id, currentTime),
    env.DB.prepare(
      `UPDATE user_access
       SET access_tier = 'free', trial_used = 1, updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND access_tier = 'trial'
         AND (trial_ends_at IS NULL OR trial_ends_at <= datetime(?, 'unixepoch'))`,
    ).bind(Number(grant.telegram_id), currentTime),
    env.DB.prepare(
      `UPDATE user_access_states
       SET access_state = 'expired', source_code = ?,
           state_ends_at = datetime(?, 'unixepoch'),
           revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND access_state = 'trial'
         AND source_code = ?`,
    ).bind(PREVIEW_SOURCE, Number(grant.ends_at), Number(grant.telegram_id), PREVIEW_SOURCE),
    env.DB.prepare(
      `INSERT OR IGNORE INTO access_status_history
         (event_id, telegram_id, plan_code, from_state, to_state,
          source_code, related_grant_id, occurred_at)
       VALUES (?, ?, 'free', 'trial', 'expired', ?, ?, ?)`,
    ).bind(expiredEventId, Number(grant.telegram_id), PREVIEW_SOURCE, grant.grant_id, currentTime),
    env.DB.prepare(
      `INSERT OR IGNORE INTO trial_funnel_events
         (event_id, telegram_id, program_code, event_type,
          related_grant_id, occurred_at)
       VALUES (?, ?, ?, 'preview_expired', ?, ?)`,
    ).bind(funnelEventId, Number(grant.telegram_id), DRAGON_PREVIEW_PROGRAM_CODE, grant.grant_id, currentTime),
  ]);
  return { changed: changes(result?.[0]) > 0, reason: "expired" };
}

export async function reconcileDragonPreviewAccess(
  env,
  telegramId,
  currentTime = nowSeconds(),
) {
  const grant = await getGrantByTelegramId(env, telegramId);
  if (!grant) return null;
  if (grant.status === "active" && Number(grant.ends_at) <= currentTime) {
    await expireDragonPreviewGrant(env, grant.grant_id, currentTime);
    return getGrantByTelegramId(env, telegramId);
  }
  if (isPreviewGrantActive(grant, currentTime)) {
    await repairActiveAccess(env, grant);
  } else if (grant.status === "expired") {
    await repairExpiredAccess(env, grant);
  }
  return grant;
}

async function grantDragonPreview(env, telegramId, fingerprint, config) {
  const startedAt = nowSeconds();
  const window = calculatePreviewWindow(startedAt);
  const grantId = crypto.randomUUID();
  const workflowInstanceId = `dragon-preview-${grantId}`;
  const retentionUntil =
    Math.max(window.endsAt, Number(config.programEndsAt)) +
    Number(config.antiAbuseRetentionDays) * 86_400;
  const grantedEventId = `preview-granted:${grantId}`;
  const funnelEventId = `preview-funnel-granted:${grantId}`;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO trial_grants
         (grant_id, telegram_id, subject_fingerprint, program_code, source_code,
          status, started_at, ends_at, retention_until,
          workflow_instance_id, workflow_state, granted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(program_code, subject_fingerprint) DO NOTHING`,
    ).bind(
      grantId,
      Number(telegramId),
      fingerprint,
      DRAGON_PREVIEW_PROGRAM_CODE,
      PREVIEW_SOURCE,
      window.startedAt,
      window.endsAt,
      retentionUntil,
      workflowInstanceId,
      startedAt,
      startedAt,
    ),
    env.DB.prepare(
      `INSERT INTO user_access
         (telegram_id, access_tier, trial_used, trial_started_at,
          trial_ends_at, updated_at)
       SELECT telegram_id, 'trial', 1, datetime(started_at, 'unixepoch'),
              datetime(ends_at, 'unixepoch'), CURRENT_TIMESTAMP
       FROM trial_grants WHERE grant_id = ? AND status = 'active'
       ON CONFLICT(telegram_id) DO UPDATE SET
         access_tier = 'trial', trial_used = 1,
         trial_started_at = excluded.trial_started_at,
         trial_ends_at = excluded.trial_ends_at,
         updated_at = CURRENT_TIMESTAMP
       WHERE user_access.access_tier = 'free'`,
    ).bind(grantId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO user_plans
         (telegram_id, plan_code, source_code, effective_from)
       SELECT telegram_id, 'free', ?, datetime(started_at, 'unixepoch')
       FROM trial_grants WHERE grant_id = ? AND status = 'active'`,
    ).bind(PREVIEW_SOURCE, grantId),
    env.DB.prepare(
      `INSERT INTO user_access_states
         (telegram_id, access_state, source_code, state_started_at,
          state_ends_at, revision, updated_at)
       SELECT telegram_id, 'trial', ?, datetime(started_at, 'unixepoch'),
              datetime(ends_at, 'unixepoch'), 1, CURRENT_TIMESTAMP
       FROM trial_grants WHERE grant_id = ? AND status = 'active'
       ON CONFLICT(telegram_id) DO UPDATE SET
         access_state = 'trial', source_code = excluded.source_code,
         state_started_at = excluded.state_started_at,
         state_ends_at = excluded.state_ends_at,
         revision = user_access_states.revision + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE user_access_states.access_state IN ('none', 'expired')`,
    ).bind(PREVIEW_SOURCE, grantId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO access_status_history
         (event_id, telegram_id, plan_code, from_state, to_state,
          source_code, related_grant_id, occurred_at)
       SELECT ?, telegram_id, 'free', 'none', 'trial', ?, grant_id, ?
       FROM trial_grants WHERE grant_id = ? AND status = 'active'`,
    ).bind(grantedEventId, PREVIEW_SOURCE, startedAt, grantId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO trial_funnel_events
         (event_id, telegram_id, program_code, event_type,
          related_grant_id, occurred_at)
       SELECT ?, telegram_id, program_code, 'preview_granted', grant_id, ?
       FROM trial_grants WHERE grant_id = ? AND status = 'active'`,
    ).bind(funnelEventId, startedAt, grantId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO notification_jobs
         (job_key, telegram_id, related_grant_id, job_type,
          status, scheduled_for, created_at, updated_at)
       SELECT ?, telegram_id, grant_id, 'preview_warning',
              'pending', ?, ?, ?
       FROM trial_grants WHERE grant_id = ? AND status = 'active'`,
    ).bind(`preview-warning:${grantId}`, window.warningAt, startedAt, startedAt, grantId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO notification_jobs
         (job_key, telegram_id, related_grant_id, job_type,
          status, scheduled_for, created_at, updated_at)
       SELECT ?, telegram_id, grant_id, 'preview_ended',
              'pending', ?, ?, ?
       FROM trial_grants WHERE grant_id = ? AND status = 'active'`,
    ).bind(`preview-ended:${grantId}`, window.endsAt, startedAt, startedAt, grantId),
  ]);

  const grant = await getGrantByFingerprint(env, fingerprint);
  if (!grant) throw new Error("Dragon Preview grant was not persisted");
  const createdHere = grant.grant_id === grantId;
  if (createdHere) {
    try {
      if(hasLegacyCompatibilityEnv(env))await assertLegacyPreviewWorkflowFresh(env,{grantId,warningAt:window.warningAt,endsAt:window.endsAt});
      await env.DRAGON_PREVIEW_WORKFLOW.create({
        id: workflowInstanceId,
        params: {
          grantId,
          warningAt: window.warningAt,
          endsAt: window.endsAt,
        },
      });
      await setWorkflowState(env, grantId, "started");
    } catch (error) {
      console.error("Could not start Dragon Preview Workflow", error);
      await setWorkflowState(env, grantId, "start_failed", safeErrorCode(error));
    }
  }
  return { grant, createdHere };
}

export async function activateDragonPreview(env, telegramId) {
  const currentTime = nowSeconds();
  const config = readDragonPreviewConfig(env, currentTime);
  if (!config.enabled) {
    return { state: "disabled", grant: null };
  }
  if (!config.ready) {
    console.error("Dragon Preview configuration is incomplete", config.problems);
    return { state: "configuration_required", grant: null };
  }
  const fingerprint = await createSubjectFingerprint(
    config.antiAbuseSecret,
    telegramId,
  );
  const existing =
    (await getGrantByTelegramId(env, telegramId)) ||
    (await getGrantByFingerprint(env, fingerprint));
  if (existing) {
    if (isPreviewGrantActive(existing, currentTime) && existing.telegram_id) {
      if (!hasLegacyCompatibilityEnv(env)) await repairActiveAccess(env, existing);
      return { state: "active", grant: existing };
    }
    await recordEligibilityCheck(env, telegramId, fingerprint, "already_used");
    return { state: "already_used", grant: existing };
  }

  const user = await getUserPreviewPrerequisites(env, telegramId);
  if (!user || Number(user.is_blocked || 0) === 1) {
    await recordEligibilityCheck(env, telegramId, fingerprint, "user_unavailable");
    return { state: "user_unavailable", grant: null };
  }
  if (Number(user.accepted_terms || 0) !== 1) {
    await recordEligibilityCheck(env, telegramId, fingerprint, "terms_required");
    return { state: "terms_required", grant: null };
  }
  if (
    Number(user.trial_used || 0) === 1 ||
    String(user.access_tier || "free") !== "free" ||
    (user.plan_code && String(user.plan_code) !== "free") ||
    ["active", "cancel_at_period_end", "refunded", "suspended"].includes(
      String(user.access_state || "none"),
    )
  ) {
    await recordEligibilityCheck(env, telegramId, fingerprint, "access_conflict");
    return { state: Number(user.trial_used || 0) === 1 ? "already_used" : "access_conflict", grant: null };
  }

  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM trial_eligibility_checks
     WHERE telegram_id = ? AND checked_at >= ?`,
  )
    .bind(Number(telegramId), currentTime - 60)
    .first();
  if (Number(recent?.total || 0) >= 5) {
    return { state: "rate_limited", grant: null };
  }

  let membership;
  await assertLegacyPreviewMembershipFresh(env,Number(telegramId));
  try {
    membership = await checkChannelMembership(env, config, telegramId);
  } catch (error) {
    console.error("Dragon Preview channel check failed", error);
    await recordEligibilityCheck(
      env,
      telegramId,
      fingerprint,
      "channel_unavailable",
      safeErrorCode(error),
    );
    return { state: "channel_unavailable", grant: null };
  }
  if (!membership.active) {
    await recordEligibilityCheck(
      env,
      telegramId,
      fingerprint,
      "not_member",
      membership.status,
    );
    return { state: "not_member", grant: null };
  }
  await recordEligibilityCheck(
    env,
    telegramId,
    fingerprint,
    "eligible",
    membership.status,
  );
  env = await upgradeLegacyPreviewActivation(env,Number(telegramId));
  const granted = await grantDragonPreview(env, telegramId, fingerprint, config);
  await recordEligibilityCheck(
    env,
    telegramId,
    fingerprint,
    granted.createdHere ? "granted" : "already_used",
    membership.status,
  );
  return {
    state: isPreviewGrantActive(granted.grant, nowSeconds())
      ? "active"
      : "already_used",
    grant: granted.grant,
  };
}

export async function getDragonPreviewPlanAddon(env, telegramId) {
  const currentTime = nowSeconds();
  const grant = await reconcileDragonPreviewAccess(env, telegramId, currentTime);
  if (isPreviewGrantActive(grant, currentTime)) {
    return {
      state: "active",
      summaryHtml: activeSummary(grant, currentTime),
      buttons: [[{ text: "⏱ Dragon Preview", callback_data: PREVIEW_CALLBACK_OPEN }]],
    };
  }
  if (grant) {
    return {
      state: "already_used",
      summaryHtml: usedSummary(grant),
      buttons: [[{ text: "ℹ️ О Dragon Preview", callback_data: PREVIEW_CALLBACK_OPEN }]],
    };
  }
  const config = readDragonPreviewConfig(env, currentTime);
  if (!config.enabled) {
    return {
      state: "disabled",
      summaryHtml: "\n\n🔥 <b>Dragon Preview</b> — безопасный запуск готовится отдельно.",
      buttons: [],
    };
  }
  if (!config.ready) {
    return {
      state: "configuration_required",
      summaryHtml: "\n\n🔥 <b>Dragon Preview</b> временно недоступен: завершается настройка безопасного запуска.",
      buttons: [],
    };
  }
  return {
    state: "eligible",
    summaryHtml: "\n\n🔥 <b>Dragon Preview</b> — 7 дней знакомства с Dragon без карты и автопродления.",
    buttons: [[{ text: "🔥 Получить 7 дней", callback_data: PREVIEW_CALLBACK_OPEN }]],
  };
}

export async function getDragonPreviewScreen(env, telegramId, activation = false) {
  const result = activation
    ? await activateDragonPreview(env, telegramId)
    : { state: null, grant: await reconcileDragonPreviewAccess(env, telegramId) };
  const config = readDragonPreviewConfig(env);
  const grant = result.grant;
  const state = result.state || (isPreviewGrantActive(grant) ? "active" : grant ? "already_used" : config.ready ? "eligible" : config.enabled ? "configuration_required" : "disabled");
  const back = [{ text: "⬅️ К тарифам", callback_data: "plans" }];

  if (state === "active") {
    return {
      state,
      text:
        "<b>🔴 Dragon Preview активен</b>\n\n" +
        `Осталось: <b>${formatPreviewRemaining(grant.ends_at)}</b>\n` +
        `Дата окончания: <b>${formatPreviewDate(grant.ends_at)}</b>\n\n` +
        "Ваш тариф остаётся Free, а Preview временно открывает проверяемые Dragon-возможности. Карта не привязана, автопродления и списаний нет. Отписка от канала после активации не сокращает уже выданные 7 дней.",
      keyboard: [back],
    };
  }
  if (state === "already_used") {
    return {
      state,
      text:
        "<b>🔥 Dragon Preview</b>\n\n" +
        "Preview уже был выдан этому Telegram ID. Повторный /start, другая ссылка, смена username или удаление чата не создают второй период. Ваши данные и Free-доступ сохраняются.",
      keyboard: [back],
    };
  }
  if (state === "not_member") {
    return {
      state,
      text:
        "<b>🔥 Остался один шаг</b>\n\n" +
        "Подпишитесь на официальный канал и нажмите «Проверить подписку». Для обычного Free-доступа подписка по-прежнему не обязательна.",
      keyboard: [
        [{ text: "📢 Открыть официальный канал", url: config.channelUrl }],
        [{ text: "✅ Проверить подписку", callback_data: PREVIEW_CALLBACK_CHECK }],
        back,
      ],
    };
  }
  if (state === "terms_required") {
    return {
      state,
      text: "Сначала примите условия использования в стартовом экране бота, затем вернитесь к Dragon Preview.",
      keyboard: [[{ text: "📜 Условия", callback_data: "terms" }], back],
    };
  }
  if (state === "rate_limited") {
    return {
      state,
      text: "⏳ Слишком много проверок подряд. Подождите минуту и попробуйте снова.",
      keyboard: [[{ text: "✅ Проверить позже", callback_data: PREVIEW_CALLBACK_CHECK }], back],
    };
  }
  if (["configuration_required", "channel_unavailable"].includes(state)) {
    return {
      state,
      text:
        "<b>🔥 Dragon Preview</b>\n\n" +
        "Сейчас проверка временно недоступна. Доступ не был израсходован — попробуйте позже или напишите в официальную поддержку.",
      keyboard: [[{ text: "🛟 Поддержка", callback_data: "support" }], back],
    };
  }
  if (["access_conflict", "user_unavailable"].includes(state)) {
    return {
      state,
      text:
        "<b>🔥 Dragon Preview</b>\n\n" +
        "Автоматическая выдача сейчас недоступна для этого профиля. Никакие данные и текущий доступ не изменены.",
      keyboard: [[{ text: "🛟 Поддержка", callback_data: "support" }], back],
    };
  }
  if (state === "disabled") {
    return {
      state,
      text: "<b>🔥 Dragon Preview</b>\n\nБезопасный запуск временно выключен. Free продолжает работать без обязательной подписки.",
      keyboard: [back],
    };
  }
  return {
    state: "eligible",
    text:
      "<b>🔥 Dragon Preview на 7 дней</b>\n\n" +
      "Один бесплатный период на Telegram ID, без карты, оплаты и автопродления. Для активации нужна добровольная подписка на официальный канал. После активации Preview длится ровно 7 × 24 часа; примерно за сутки бот предупредит об окончании. Партнёрские и административные права не выдаются.\n\n" +
      "При удалении аккаунта персональные Preview-события удаляются, а ограниченный по сроку односторонний технический маркер сохраняется только для защиты от повторной выдачи.",
    keyboard: [
      [{ text: "📢 Открыть официальный канал", url: config.channelUrl }],
      [{ text: "✅ Проверить подписку", callback_data: PREVIEW_CALLBACK_CHECK }],
      back,
    ],
  };
}

export async function getDragonPreviewAiDailyLimit(env, telegramId, fallback) {
  const grant = await reconcileDragonPreviewAccess(env, telegramId);
  if (!isPreviewGrantActive(grant)) return Number(fallback);
  return readDragonPreviewConfig(env).aiDailySuccessLimit;
}

async function claimNotificationJob(env, jobKey, currentTime) {
  return env.DB.prepare(
    `UPDATE notification_jobs
     SET status = 'processing', attempt_count = attempt_count + 1,
         delivery_started_at = ?, updated_at = ?
     WHERE job_key = ? AND status = 'pending' AND scheduled_for <= ?
     RETURNING job_key, telegram_id, related_grant_id, job_type,
               attempt_count, scheduled_for`,
  )
    .bind(currentTime, currentTime, String(jobKey), currentTime)
    .first();
}

async function finishNotificationJob(env, jobKey, status, errorCode = "") {
  await env.DB.prepare(
    `UPDATE notification_jobs
     SET status = ?, last_error_code = ?,
         sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
         updated_at = ?
     WHERE job_key = ? AND status = 'processing'`,
  )
    .bind(status, errorCode.slice(0, 64), status, nowSeconds(), nowSeconds(), jobKey)
    .run();
}

export async function deliverDragonPreviewNotification(env, jobKey) {
  const currentTime = nowSeconds();
  const job = await claimNotificationJob(env, jobKey, currentTime);
  if (!job) return { changed: false, reason: "not_claimed" };
  const grant = await env.DB.prepare(
    `SELECT grant_id, telegram_id, status, ends_at
     FROM trial_grants WHERE grant_id = ? LIMIT 1`,
  )
    .bind(job.related_grant_id)
    .first();
  const isWarning = job.job_type === "preview_warning";
  const allowed =
    grant?.telegram_id &&
    Number(grant.telegram_id) === Number(job.telegram_id) &&
    (isWarning
      ? isPreviewGrantActive(grant, currentTime)
      : grant.status === "expired");
  if (!allowed) {
    await finishNotificationJob(env, job.job_key, "suppressed", "grant_state_changed");
    return { changed: true, reason: "suppressed" };
  }
  const text = isWarning
    ? `⏳ Dragon Preview завершится примерно через 24 часа — ${formatPreviewDate(grant.ends_at)}. После этого сохранится Free-доступ и ваши данные.`
    : "✅ Dragon Preview завершён. Free-доступ, профиль, настройки и история сохранены.";
  try {
    await callTelegram(env, "sendMessage", {
      chat_id: Number(job.telegram_id),
      text,
      reply_markup: {
        inline_keyboard: [[{ text: "💎 Тарифы и мой доступ", callback_data: "plans" }]],
      },
    });
    await finishNotificationJob(env, job.job_key, "sent");
    if (isWarning) {
      await env.DB.prepare(
        `UPDATE trial_grants SET warning_sent_at = ?, updated_at = ?
         WHERE grant_id = ? AND warning_sent_at IS NULL`,
      )
        .bind(currentTime, currentTime, grant.grant_id)
        .run();
    }
    return { changed: true, reason: "sent" };
  } catch (error) {
    const code = safeErrorCode(error);
    if (error?.ambiguous) {
      await finishNotificationJob(env, job.job_key, "unknown", code);
    } else if (Number(error?.telegramErrorCode) === 403) {
      await finishNotificationJob(env, job.job_key, "suppressed", code);
    } else if (error?.retryable && Number(job.attempt_count || 0) < 5) {
      await finishNotificationJob(env, job.job_key, "pending", code);
      throw error;
    } else {
      await finishNotificationJob(env, job.job_key, "failed", code);
    }
    return { changed: true, reason: code };
  }
}

export async function runDragonPreviewMaintenance(env) {
  const currentTime = nowSeconds();
  try {
    await env.DB.prepare(
      `UPDATE notification_jobs
       SET status = 'unknown', last_error_code = 'delivery_state_ambiguous',
           updated_at = ?
       WHERE status = 'processing' AND delivery_started_at < ?`,
    )
      .bind(currentTime, currentTime - 600)
      .run();

    const warningJobs = await env.DB.prepare(
      `SELECT jobs.job_key
       FROM notification_jobs jobs
       JOIN trial_grants grants ON grants.grant_id = jobs.related_grant_id
       WHERE jobs.status = 'pending' AND jobs.job_type = 'preview_warning'
         AND jobs.scheduled_for <= ? AND grants.status = 'active'
         AND grants.ends_at > ?
       ORDER BY jobs.scheduled_for ASC LIMIT ?`,
    )
      .bind(currentTime, currentTime, MAINTENANCE_BATCH_LIMIT)
      .all();
    for (const job of warningJobs?.results || []) {
      try {
        await deliverDragonPreviewNotification(env, job.job_key);
      } catch (error) {
        console.error("Dragon Preview warning retry deferred", error);
      }
    }

    const due = await env.DB.prepare(
      `SELECT grant_id FROM trial_grants
       WHERE status = 'active' AND ends_at <= ?
       ORDER BY ends_at ASC LIMIT ?`,
    )
      .bind(currentTime, MAINTENANCE_BATCH_LIMIT)
      .all();
    for (const grant of due?.results || []) {
      await expireDragonPreviewGrant(env, grant.grant_id, currentTime);
    }

    const endedJobs = await env.DB.prepare(
      `SELECT jobs.job_key
       FROM notification_jobs jobs
       JOIN trial_grants grants ON grants.grant_id = jobs.related_grant_id
       WHERE jobs.status = 'pending' AND jobs.job_type = 'preview_ended'
         AND jobs.scheduled_for <= ? AND grants.status = 'expired'
       ORDER BY jobs.scheduled_for ASC LIMIT ?`,
    )
      .bind(currentTime, MAINTENANCE_BATCH_LIMIT)
      .all();
    for (const job of endedJobs?.results || []) {
      try {
        await deliverDragonPreviewNotification(env, job.job_key);
      } catch (error) {
        console.error("Dragon Preview completion retry deferred", error);
      }
    }

    await purgeDragonPreviewRetention(env, currentTime);
  } catch (error) {
    if (!isMissingPreviewSchema(error)) throw error;
  }
}

export async function purgeDragonPreviewRetention(
  env,
  currentTime = nowSeconds(),
) {
  const config = readDragonPreviewConfig(env, currentTime);
  if (!config.antiAbuseRetentionDays) {
    return { purgedGrants: 0 };
  }
  const eligibilityCutoff =
    Number(currentTime) - Number(config.antiAbuseRetentionDays) * 86_400;
  const expired = await env.DB.prepare(
    `SELECT grant_id FROM trial_grants
     WHERE telegram_id IS NULL AND anonymized_at IS NOT NULL
       AND retention_until <= ?
     ORDER BY retention_until ASC LIMIT ?`,
  )
    .bind(Number(currentTime), MAINTENANCE_BATCH_LIMIT)
    .all();
  const grantIds = (expired?.results || [])
    .map((row) => String(row.grant_id || ""))
    .filter(Boolean);

  for (const grantId of grantIds) {
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM notification_jobs WHERE related_grant_id = ?`,
      ).bind(grantId),
      env.DB.prepare(
        `DELETE FROM trial_grants
         WHERE grant_id = ? AND telegram_id IS NULL
           AND anonymized_at IS NOT NULL AND retention_until <= ?`,
      ).bind(grantId, Number(currentTime)),
    ]);
  }
  await env.DB.prepare(
    `DELETE FROM trial_eligibility_checks
     WHERE checked_at < ?`,
  )
    .bind(eligibilityCutoff)
    .run();
  return { purgedGrants: grantIds.length };
}

export async function buildDragonPreviewPrivacyStatements(env, telegramId) {
  const currentTime = nowSeconds();
  const schema = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM sqlite_schema
     WHERE type = 'table' AND name IN (
       'trial_grants', 'trial_eligibility_checks',
       'trial_funnel_events', 'access_status_history', 'notification_jobs'
     )`,
  ).first();
  if (Number(schema?.total || 0) !== 5) return [];
  return [
    env.DB.prepare(
      `DELETE FROM trial_eligibility_checks WHERE telegram_id = ?`,
    ).bind(Number(telegramId)),
    env.DB.prepare(
      `DELETE FROM trial_funnel_events WHERE telegram_id = ?`,
    ).bind(Number(telegramId)),
    env.DB.prepare(
      `DELETE FROM access_status_history
       WHERE telegram_id = ? AND source_code = ?`,
    ).bind(Number(telegramId), PREVIEW_SOURCE),
    env.DB.prepare(
      `UPDATE notification_jobs
       SET telegram_id = NULL,
           status = CASE
             WHEN status IN ('pending', 'processing') THEN 'suppressed'
             ELSE status
           END,
           last_error_code = CASE
             WHEN status IN ('pending', 'processing') THEN 'privacy_deletion'
             ELSE last_error_code
           END,
           updated_at = ?
       WHERE telegram_id = ? AND job_type IN ('preview_warning', 'preview_ended')`,
    ).bind(currentTime, Number(telegramId)),
    env.DB.prepare(
      `UPDATE trial_grants
       SET telegram_id = NULL,
           status = CASE WHEN status = 'active' THEN 'revoked' ELSE status END,
           ended_at = CASE WHEN status = 'active' THEN ? ELSE ended_at END,
           anonymized_at = ?, updated_at = ?
       WHERE telegram_id = ? AND program_code = ?`,
    ).bind(
      currentTime,
      currentTime,
      currentTime,
      Number(telegramId),
      DRAGON_PREVIEW_PROGRAM_CODE,
    ),
  ];
}

export class DragonPreviewWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const grantId = String(event?.payload?.grantId || "");
    const warningAt = Number(event?.payload?.warningAt || 0);
    const endsAt = Number(event?.payload?.endsAt || 0);
    if (!/^[0-9a-f-]{36}$/i.test(grantId) || !warningAt || !endsAt || warningAt >= endsAt) {
      throw new Error("Invalid Dragon Preview workflow payload");
    }
    await step.sleepUntil("wait until Preview warning", warningAt * 1_000);
    await step.do(
      "send idempotent Preview warning",
      { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" }, timeout: "1 minute" },
      async () => deliverDragonPreviewNotification(this.env, `preview-warning:${grantId}`),
    );
    await step.sleepUntil("wait until Preview ends", endsAt * 1_000);
    await step.do(
      "expire Preview idempotently",
      { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" }, timeout: "1 minute" },
      async () => expireDragonPreviewGrant(this.env, grantId, endsAt),
    );
    await step.do(
      "send idempotent Preview completion",
      { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" }, timeout: "1 minute" },
      async () => deliverDragonPreviewNotification(this.env, `preview-ended:${grantId}`),
    );
    await step.do("mark Preview workflow complete", async () =>
      setWorkflowState(this.env, grantId, "completed"),
    );
  }
}
