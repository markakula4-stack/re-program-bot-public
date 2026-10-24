import { verifyTelegramInitData } from '../v1.4.0-rebuild/mini-app-security.mjs';
import { createDemoEngine } from './engine.mjs';
import { renderDemoHtml, DEMO_CSS, DEMO_JS } from './ui.mjs';
import { matchDemoGuard, DEMO_GUARD_LOOKUP } from './guard-diagnostics.mjs';

const SESSION_TTL = 3600;
const WEBHOOK_COMMAND_MAX_AGE = 86400;
const WEBHOOK_RECEIPT_RETENTION = 7 * 86400;
const COOKIE = '__Host-re_demo';
const ACTIONS = new Set(['buy', 'advance_30d', 'cancel', 'resume', 'reset', 'duplicate', 'low_funds', 'lost_response']);
const TRANSPORT_METHODS = new Set(['getMe', 'sendMessage', 'answerCallbackQuery']);
const DIAGNOSTIC_STAGES = new Set(['prepare_purchase', 'record_payment', 'apply_access', 'project_view', 'finalize']);
const DIAGNOSTIC_CODES = new Set(['demo_access_not_applied', 'demo_origin_missing', 'demo_contract_missing', 'demo_control_unconfirmed',
  'demo_commit_unverified', 'demo_execution_obsolete', 'demo_generation_missing', 'successful_payment_persistence_invariant',
  'recurring_payment_binding_invalid', 'payment_ledger_evidence_missing', 'payment_not_ready_for_access', 'paid_product_not_released',
  'stars_payments_not_ready', 'invoice_secret_invalid', 'recurring_first_payment_unverified', 'recurring_contract_binding_invalid',
  'payment_charge_collision', 'paid_access_suspended', 'recurring_contract_compensated', 'recurring_contract_conflict',
  'recurring_contract_consent_missing', 'access_application_invariant_failed']);
const DIAGNOSTIC_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'D1_ERROR', 'D1_TYPE_ERROR']);
const NATIVE_IDENTIFIERS = new Set([
  ...DEMO_GUARD_LOOKUP.flatMap(row => [...row.tables, ...row.triggers]),
  'mini_app_atomic_guards', 'precondition_ok', 'json_valid', 'json_type', 'json_extract', 'json_object', 'json_array',
  'json_set', 'json_each', 'unixepoch', 'datetime', 'strftime', 'coalesce', 'length',
]);
// Match query structure rather than SQL words appearing in English reasons.
const SQL_STATEMENT = /\b(?:INSERT\s+(?:OR\s+(?:ABORT|FAIL|IGNORE|REPLACE|ROLLBACK)\s+)?INTO\b|UPDATE\s+(?:OR\s+(?:ABORT|FAIL|IGNORE|REPLACE|ROLLBACK)\s+)?(?:[A-Za-z_][A-Za-z0-9_]*|\[(?:value|id)\])(?:\s*\.\s*(?:[A-Za-z_][A-Za-z0-9_]*|\[(?:value|id)\]))?\s+SET\b|DELETE\s+FROM\b|CREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\b|ALTER\s+TABLE\b|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)\b|WITH\s+(?:[A-Za-z_][A-Za-z0-9_]*|\[(?:value|id)\])(?:\s*\([^)]*\))?\s+AS\s*\(|SELECT\s+[^:]*\bFROM\b|SELECT\s+(?:[+-]?\d|\?|NULL\b|TRUE\b|FALSE\b|\[(?:value|id|number|secret)\]|[A-Za-z_][A-Za-z0-9_]*\s*\())/iu;
const enc = new TextEncoder();
const headers = {
  'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache',
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy': "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org",
};

const fail = (code, status = 400) => { const error = new Error(code); error.code = code; error.status = status; throw error; };
const response = (body, status = 200, extra = {}) => new Response(body, { status, headers: { ...headers, ...extra } });
const json = (body, status = 200, extra = {}) => response(JSON.stringify(body), status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
const positiveId = value => /^[1-9][0-9]{0,15}$/u.test(String(value)) && Number.isSafeInteger(Number(value));
const secretOk = value => typeof value === 'string' && value.length >= 32 && value.length <= 256;
const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let result = 0; for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
};

/** Fixed enums only. Native error details stay inside this request. */
export function classifyDemoDiagnostic(error) {
  const details = [];
  let errorName = 'unknown';
  let current = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 4; depth++) {
    if (typeof current === 'string') { details.push(current.slice(0, 4096)); break; }
    if (typeof current !== 'object') break;
    const code = typeof current.code === 'string' ? current.code.slice(0, 128) : '';
    const message = typeof current.message === 'string' ? current.message.slice(0, 4096) : '';
    if (DIAGNOSTIC_NAMES.has(current.name) && (errorName === 'unknown' || errorName === 'Error')) errorName = current.name;
    details.push(code + '\n' + message);
    current = current.cause;
  }
  const text = details.join('\n');
  const guardCode = matchDemoGuard(text);
  let category = 'unknown';
  if (guardCode) category = 'constraint';
  else if (/too many (?:api requests|subrequests|queries)|(?:query|subrequest)[ _-]?(?:count|limit)[^\n]{0,80}exceeded|maximum[^\n]{0,40}queries|exceeded[^\n]{0,40}(?:query|subrequest)[^\n]{0,40}(?:limit|budget)/iu.test(text)) category = 'd1_query_limit';
  else if (/D1_TYPE_ERROR|unsupported[^\n]{0,80}(?:bind|type)|type[^\n]{0,40}not supported|invalid[^\n]{0,40}bind(?:ing| type)?|invalid type for parameter|wrong number of (?:parameter )?bindings|too many SQL variables|D1PreparedStatement[^\n]{0,40}(?:expected|required)/iu.test(text)) category = 'binding_unsupported';
  else if (/SQLITE_CONSTRAINT|constraint failed|foreign key constraint|unique constraint|not null constraint|check constraint/iu.test(text)) category = 'constraint';
  else if (/SQLITE_SCHEMA|no such (?:table|column|function)|unknown column|has no column named|schema[^\n]{0,40}(?:mismatch|missing)|(?:SQL|SQLite)[^\n]{0,40}(?:syntax|parse|parsing) error|syntax error|failed to parse (?:SQL|query)/iu.test(text)) category = 'schema';
  else if (/not authorized|authorization denied|permission denied/iu.test(text)) category = 'authorization_denied';
  else if (/SQLITE_BUSY|SQLITE_LOCKED|database[^\n]{0,40}(?:unavailable|locked)|D1[^\n]{0,40}(?:unavailable|timeout)|service unavailable|connection[^\n]{0,40}(?:failed|closed)|NetworkError/iu.test(text)) category = 'unavailable';
  else if (/SQLITE_ERROR/iu.test(text)) category = 'sqlite_error';
  return {
    stage: DIAGNOSTIC_STAGES.has(error?.demoStage) ? error.demoStage : 'unknown',
    category,
    engineCode: DIAGNOSTIC_CODES.has(error?.code) ? error.code : null,
    guardCode,
    errorName,
  };
}

/** Deployment-controller detail: never available from the ordinary Mini App. */
export function redactDemoNativeDetail(error, env) {
  let current = error, nativeLine = null;
  for (let depth = 0; current !== null && current !== undefined && depth < 4; depth++) {
    const message = typeof current === 'string' ? current : typeof current?.message === 'string' ? current.message : '';
    if (/\b(?:D1_ERROR|SQLITE_[A-Z_]+)\b/u.test(message)) nativeLine = message;
    if (typeof current !== 'object') break;
    current = current.cause;
  }
  if (!nativeLine) return null;
  // Mask complete values before any cutoff, so a cutoff cannot expose a prefix.
  for (const [key, value] of Object.entries(env ?? {})) {
    if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/iu.test(key) && typeof value === 'string' && value.length) {
      nativeLine = nativeLine.replaceAll(value, '[secret]');
    }
  }
  nativeLine = nativeLine.replace(/\r\n?/gu, '\n').replace(/^\s*at\s+.*$/gmu, '').trim();
  nativeLine = nativeLine
    .replace(/https?:\/\/[^\s"'`<>]+/giu, '[url]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[email]')
    .replace(/@[A-Za-z0-9_]{3,}/gu, '[value]')
    .replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`/gu, '[value]')
    .replace(/["'`][^"'`]*$/gu, '[value]')
    .replace(/\b[A-Fa-f0-9]{12,}\b/gu, '[id]')
    .replace(/\b[A-Za-z0-9_-]{20,}\b/gu, value => NATIVE_IDENTIFIERS.has(value) || /^(?:D1_ERROR|SQLITE_[A-Z_]+)$/u.test(value) ? value : '[id]')
    .replace(/\d{6,}/gu, '[number]')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/gu, ' ');
  const firstMarker = /\b(?:D1_ERROR|SQLITE_[A-Z_]+)\b/u.exec(nativeLine);
  if (!firstMarker) return null;
  // SQLite commonly appends its marker after the actual reason. Keep that
  // sanitized reason rather than cutting the line down to SQLITE_ERROR.
  nativeLine = /^D1_ERROR\b/u.test(nativeLine) ? nativeLine : 'D1_ERROR: ' + nativeLine;
  // A native first line may include an entire query. Keep its error prefix and
  // marked error tail, but collapse the SQL itself rather than returning it.
  const statement = SQL_STATEMENT.exec(nativeLine);
  if (statement) {
    const prefix = nativeLine.slice(0, statement.index);
    const remainder = nativeLine.slice(statement.index);
    const markers = [...remainder.matchAll(/\b(?:D1_ERROR|SQLITE_[A-Z_]+)\b/gu)];
    let tail = '';
    if (markers.length) {
      const last = markers.at(-1);
      const markerLine = remainder.lastIndexOf('\n', last.index) + 1;
      if (markerLine > 0) tail = remainder.slice(markerLine).trim();
      else {
        const separator = /:\s*$/u.exec(remainder.slice(0, last.index));
        const colon = remainder.lastIndexOf(':', (separator?.index ?? last.index) - 1);
        tail = remainder.slice(colon >= 0 ? colon + 1 : last.index).trim();
      }
      if (SQL_STATEMENT.test(tail) || /^(?:FROM|JOIN|WHERE|VALUES|HAVING|LIMIT)\b/iu.test(tail)) tail = remainder.slice(last.index);
    }
    nativeLine = prefix + '[sql]' + (tail ? ' · ' + tail : '');
  }
  nativeLine = nativeLine.replace(/\s+/gu, ' ').trim();
  if (nativeLine.length > 240) nativeLine = nativeLine.slice(0, 119) + ' … ' + nativeLine.slice(-118);
  return nativeLine;
}
const base64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
const unbase64 = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
async function sign(secret, value) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(value))));
}

function configuration(env, request) {
  if (env.DEMO_MODE !== 'virtual-stars-only' || !env.DEMO_DB?.prepare || env.DB ||
      !positiveId(env.DEMO_OWNER_ID) || !positiveId(env.DEMO_BOT_ID) || String(env.DEMO_BOT_ID) === '8562951985' ||
      env.DEMO_BOT_USERNAME !== 'RE_TG_TEST_bot' ||
      typeof env.BOT_TOKEN !== 'string' || !/^[1-9][0-9]{0,15}:[A-Za-z0-9_-]{20,120}$/u.test(env.BOT_TOKEN) ||
      env.BOT_TOKEN.split(':')[0] !== String(env.DEMO_BOT_ID) ||
      !secretOk(env.DEMO_SESSION_SECRET) || !secretOk(env.DEMO_WEBHOOK_SECRET) || !secretOk(env.DEMO_INVOICE_SECRET)) {
    fail('demo_configuration_unavailable', 503);
  }
  let origin;
  try { const url = new URL(env.DEMO_ORIGIN); if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) fail('demo_configuration_unavailable', 503); origin = url.origin; }
  catch { fail('demo_configuration_unavailable', 503); }
  if (origin === 'https://re-program-bot.markakula4.workers.dev' || new URL(request.url).origin !== origin) fail('demo_origin_mismatch', 503);
  return { ownerId: Number(env.DEMO_OWNER_ID), botId: Number(env.DEMO_BOT_ID), origin };
}

async function bodyJson(request, limit = 16384) {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') fail('json_required', 415);
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)))) fail('invalid_request');
  if (Number(length) > limit) {
    void request.body?.cancel().catch(() => {});
    fail('request_too_large', 413);
  }
  if (!request.body) fail('invalid_request');
  const reader = request.body.getReader(), chunks = [];
  let size = 0, timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('invalid_request'), { code: 'invalid_request', status: 400 })), 5000);
    });
    while (true) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('invalid_request');
      size += value.byteLength;
      if (size > limit) fail('request_too_large', 413);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('invalid_request'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('invalid_request');
    return body;
  } finally {
    clearTimeout(timer);
    // A hostile stream can leave cancel() pending. Do not extend the deadline.
    void reader.cancel().catch(() => {});
  }
}

function sameOrigin(request, config) {
  if (request.headers.get('origin') !== config.origin || request.headers.get('x-re-demo') !== '1') fail('request_origin_denied', 403);
}

async function sessionToken(env, config, now) {
  const core = base64(enc.encode(JSON.stringify({ v: 1, owner: config.ownerId, bot: config.botId, origin: config.origin, issued: now, expires: now + SESSION_TTL })));
  return `${core}.${await sign(env.DEMO_SESSION_SECRET, `re-virtual-stars-session/v1:${core}`)}`;
}

async function authenticate(request, env, config, now) {
  const cookies = request.headers.get('cookie') || '';
  const matches = [...cookies.matchAll(/(?:^|;\s*)__Host-re_demo=([^;]+)/gu)];
  if (matches.length !== 1 || matches[0][1].length > 2048) fail('demo_session_required', 401);
  const [core, signature, extra] = matches[0][1].split('.');
  if (!core || !signature || extra || !/^[A-Za-z0-9_-]+$/u.test(core) || !/^[A-Za-z0-9_-]{43}$/u.test(signature) ||
      !safeEqual(signature, await sign(env.DEMO_SESSION_SECRET, `re-virtual-stars-session/v1:${core}`))) fail('demo_session_required', 401);
  let claims; try { claims = JSON.parse(new TextDecoder().decode(unbase64(core))); } catch { fail('demo_session_required', 401); }
  if (claims.v !== 1 || claims.owner !== config.ownerId || claims.bot !== config.botId || claims.origin !== config.origin ||
      !Number.isSafeInteger(claims.issued) || !Number.isSafeInteger(claims.expires) || claims.issued > now + 60 ||
      claims.expires <= now || claims.expires - claims.issued !== SESSION_TTL) fail('demo_session_expired', 401);
}

/** Deliberately small, nonfinancial Telegram transport. No arbitrary method passthrough. */
export function createDemoTelegramTransport({ token, fetchImpl = fetch }) {
  return async (method, payload = {}) => {
    if (!TRANSPORT_METHODS.has(method)) fail('telegram_method_denied', 403);
    const result = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!result.ok) fail('telegram_transport_unavailable', 503);
    let data; try { data = await result.json(); } catch { fail('telegram_transport_unavailable', 503); }
    if (data?.ok !== true) fail('telegram_transport_unavailable', 503);
    return data.result;
  };
}

export function createDemoWorker({ engineFactory = createDemoEngine, fetchImpl = fetch, wallNowSeconds = () => Math.floor(Date.now() / 1000) } = {}) {
  let verifiedToken, verifiedUntil = 0;
  async function verifyBot(env, config, now) {
    if (verifiedToken === env.BOT_TOKEN && verifiedUntil > now) return;
    const bot = await createDemoTelegramTransport({ token: env.BOT_TOKEN, fetchImpl })('getMe');
    if (bot?.id !== config.botId || bot?.is_bot !== true || bot?.username !== env.DEMO_BOT_USERNAME) fail('demo_bot_identity_mismatch', 503);
    verifiedToken = env.BOT_TOKEN; verifiedUntil = now + 60;
  }
  return {
    async fetch(request, env) {
      let authenticatedOwnerAction = false;
      try {
        const config = configuration(env, request);
        const url = new URL(request.url);
        const now = typeof wallNowSeconds === 'function' ? wallNowSeconds() : wallNowSeconds;
        if (!Number.isSafeInteger(now) || now <= 0) fail('demo_clock_unavailable', 503);
        if (url.search) fail('query_parameters_not_supported');
        if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 're-program-stars-demo', mode: 'virtual-stars-only', realPaymentsEnabled: false,
          sourceSha: /^[0-9a-f]{40}$/u.test(env.DEMO_SOURCE_SHA || '') ? env.DEMO_SOURCE_SHA : null });
        if (request.method === 'GET' && ['/', '/demo', '/demo/'].includes(url.pathname)) return response(renderDemoHtml({ botUsername: env.DEMO_BOT_USERNAME }), 200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (request.method === 'GET' && url.pathname === '/demo.css') return response(DEMO_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8' });
        if (request.method === 'GET' && url.pathname === '/demo.js') return response(DEMO_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        if (request.method === 'POST' && url.pathname === '/api/session') {
          sameOrigin(request, config);
          const body = await bodyJson(request);
          if (Object.keys(body).some(key => key !== 'initData')) fail('invalid_request');
          try { await verifyTelegramInitData({ initData: body.initData, botToken: env.BOT_TOKEN, expectedBotId: config.botId,
            expectedTelegramId: config.ownerId, nowSeconds: now }); }
          catch { fail('telegram_owner_authentication_required', 401); }
          await verifyBot(env, config, now);
          return json({ ok: true, expiresInSeconds: SESSION_TTL }, 200, {
            'Set-Cookie': `${COOKIE}=${await sessionToken(env, config, now)}; Path=/; Max-Age=${SESSION_TTL}; Secure; HttpOnly; SameSite=None`,
          });
        }
        if (url.pathname === '/api/state' && request.method === 'GET') {
          await authenticate(request, env, config, now);
          const engine = await engineFactory({ db: env.DEMO_DB, ownerId: config.ownerId, invoiceSecret: env.DEMO_INVOICE_SECRET, wallNowSeconds: now });
          return json({ ok: true, state: await engine.read() });
        }
        if (url.pathname === '/api/action' && request.method === 'POST') {
          sameOrigin(request, config);
          await authenticate(request, env, config, now);
          authenticatedOwnerAction = true;
          const body = await bodyJson(request);
          if (Object.keys(body).some(key => !['action', 'planCode', 'operationId', 'consent'].includes(key)) ||
              !ACTIONS.has(body.action) || typeof body.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/u.test(body.operationId) ||
              (body.planCode !== undefined && !['professional', 'dragon'].includes(body.planCode))) fail('invalid_demo_action');
          if (body.action === 'buy' && (body.consent !== true || !body.planCode)) fail('test_purchase_consent_required');
          const engine = await engineFactory({ db: env.DEMO_DB, ownerId: config.ownerId, invoiceSecret: env.DEMO_INVOICE_SECRET, wallNowSeconds: now });
          return json({ ok: true, state: await engine.act({ action: body.action, planCode: body.planCode, operationId: body.operationId }) });
        }
        if (url.pathname === '/webhook' && request.method === 'POST') {
          if (!safeEqual(request.headers.get('x-telegram-bot-api-secret-token'), env.DEMO_WEBHOOK_SECRET)) fail('webhook_authentication_required', 401);
          const update = await bodyJson(request);
          const message = update.message;
          if (message?.chat?.type !== 'private' || message.chat.id !== config.ownerId || message.from?.id !== config.ownerId || message.from?.is_bot === true ||
              typeof message.text !== 'string' || !/^\/(?:start|demo)(?:@RE_TG_TEST_bot)?(?:\s|$)/u.test(message.text)) return json({ ok: true });
          if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) fail('invalid_request');
          // Ignore expired commands before receipt cleanup, so deleting old
          // receipts can never turn an old delivery into a new send.
          if (!Number.isSafeInteger(message.date) || message.date < now - WEBHOOK_COMMAND_MAX_AGE || message.date > now + 60) return json({ ok: true });
          await verifyBot(env, config, now);
          const cleanup = await env.DEMO_DB.prepare('DELETE FROM re_demo_webhook_receipts WHERE received_at < ?')
            .bind(now - WEBHOOK_RECEIPT_RETENTION).run();
          if (cleanup?.success !== true) fail('demo_temporarily_unavailable', 503);
          // Persist the claim before the non-idempotent Telegram call. It also
          // survives isolate restarts and concurrent delivery of the same update.
          const claim = await env.DEMO_DB.prepare(`INSERT INTO re_demo_webhook_receipts
            (bot_id, update_id, state, received_at) VALUES(?, ?, 'claimed', ?)
            ON CONFLICT(bot_id, update_id) DO NOTHING`).bind(config.botId, update.update_id, now).run();
          if (claim?.success !== true || ![0, 1].includes(claim.meta?.changes)) fail('demo_temporarily_unavailable', 503);
          if (claim.meta.changes === 0) return json({ ok: true });
          try {
            await createDemoTelegramTransport({ token: env.BOT_TOKEN, fetchImpl })('sendMessage', {
              chat_id: config.ownerId,
              text: 'RE · Песочница Stars\n\n1000 тестовых Stars, виртуальное продление и тестовые квитанции. Оплаты нет. Доступ только владельцу.',
              reply_markup: { inline_keyboard: [[{ text: 'Открыть песочницу · оплаты нет', web_app: { url: `${config.origin}/demo` } }]] },
            });
          } catch (error) {
            // A lost response does not prove that Telegram did not deliver it.
            // Keep the claim; a new owner command has a fresh update_id.
            await env.DEMO_DB.prepare("UPDATE re_demo_webhook_receipts SET state='unknown', finished_at=? WHERE bot_id=? AND update_id=? AND state='claimed'")
              .bind(now, config.botId, update.update_id).run();
            throw error;
          }
          const completed = await env.DEMO_DB.prepare("UPDATE re_demo_webhook_receipts SET state='delivered', finished_at=? WHERE bot_id=? AND update_id=? AND state='claimed'")
            .bind(now, config.botId, update.update_id).run();
          if (completed?.success !== true || completed.meta?.changes !== 1) fail('demo_temporarily_unavailable', 503);
          return json({ ok: true });
        }
        return json({ ok: false, error: 'not_found' }, 404);
      } catch (error) {
        // Never return Telegram bodies, tokens, initData, SQL or exception stacks.
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
        const allowed = new Set(['demo_configuration_unavailable', 'demo_origin_mismatch', 'demo_clock_unavailable', 'query_parameters_not_supported', 'json_required', 'request_too_large', 'invalid_request', 'request_origin_denied', 'demo_session_required', 'demo_session_expired', 'telegram_owner_authentication_required', 'telegram_transport_unavailable', 'demo_bot_identity_mismatch', 'invalid_demo_action', 'test_purchase_consent_required', 'webhook_authentication_required', 'demo_control_cooldown']);
        if (error?.code === 'demo_control_cooldown' && status === 429) {
          const retryAfterSeconds = Number.isSafeInteger(error.retryAfterSeconds) ? Math.min(60, Math.max(1, error.retryAfterSeconds)) : 1;
          return json({ ok: false, error: 'demo_control_cooldown', retryAfterSeconds }, 429, { 'Retry-After': String(retryAfterSeconds) });
        }
        const diagnostic = authenticatedOwnerAction && status >= 500 ? classifyDemoDiagnostic(error) : null;
        if (diagnostic && safeEqual(request.headers.get('x-re-demo-diagnostics'), env.DEMO_WEBHOOK_SECRET)) {
          diagnostic.nativeDetail = redactDemoNativeDetail(error, env);
        }
        return json({ ok: false, error: allowed.has(error?.code) ? error.code : 'demo_temporarily_unavailable',
          ...(diagnostic ? { diagnostic } : {}) }, status);
      }
    },
  };
}

export default createDemoWorker();
