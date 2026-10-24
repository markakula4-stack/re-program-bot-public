import { verifyTelegramInitData, verifyMiniAppSession, sha256Hex } from '../v1.4.0-rebuild/mini-app-security.mjs';
import { isVerifiedTelegramCommandContext, readVerifiedCabinetUpdate } from '../v1.4.0-rebuild/telegram-command-authority.mjs';
import { FIXED_OPERATION_ALIASES, AUDIT_NAME_ALIASES, CAPABILITY_CATALOG } from './capability-policy.mjs';
import { releaseAdminFence, releaseLeaseFence } from '../v1.4.0-rebuild/release-lease.mjs';
import { canonicalCabinetOwnerId } from '../v1.4.0-rebuild/cabinet-participants.mjs';

// Internal server boundary. Nothing received through JSON carries this brand.
// Canonical readers own their actor/resource brands; there is deliberately no
// generic mintActor/mintResource/mintDecision entry point here.
const contexts = new WeakMap();
const CHANNELS = new Set(['telegram_command', 'telegram_callback', 'mini_app', 'http', 'service']);
const compiledOperations = new Set(CAPABILITY_CATALOG.map(row => row.capability));
const normalizeOperation = value => FIXED_OPERATION_ALIASES[value] ?? AUDIT_NAME_ALIASES[value] ?? value;
export const SERVICE_PURPOSES = Object.freeze({
  preview_expire: 'service.preview.expire', stars_reconcile: 'service.stars.reconcile',
  stars_expire: 'service.stars.expire', stars_process_event: 'service.stars.process_event',
  referral_settle: 'service.referral.settle', privacy_cleanup: 'service.privacy.cleanup',
  notification_deliver_historical: 'service.notification.deliver_historical',
  outbox_drain: 'service.outbox.drain', analytics_ingest: 'service.analytics.ingest',
  ai_settle_cost: 'service.ai.settle_cost',
});
export const SERVICE_CANONICAL_PURPOSES = Object.freeze({
  preview_expire: 'preview_expiry', stars_reconcile: 'Stars_reconciliation',
  stars_expire: 'Stars_expiry', stars_process_event: 'Stars_payment_event',
  referral_settle: 'referral_settlement', privacy_cleanup: 'privacy_retention',
  notification_deliver_historical: 'historical_notification', outbox_drain: 'outbox_drain',
  analytics_ingest: 'analytics_ingestion', ai_settle_cost: 'AI_incurred_cost_settlement',
});
const fail = code => { throw Object.assign(new Error(code), { code }); };
const positive = n => Number.isSafeInteger(n) && n > 0;
const operationText = value => typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,95}$/u.test(value);
const canonicalPayload = value => {
  let budget = 0;
  const visit = (item, depth = 0) => {
    if (++budget > 2048 || depth > 12) fail('invalid_operation_payload');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' ||
        typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, visit(item[key], depth + 1)]));
    }
    fail('invalid_operation_payload');
  };
  const encoded = JSON.stringify(visit(value));
  if (new TextEncoder().encode(encoded).length > 16384) fail('invalid_operation_payload');
  return encoded;
};
const freezePayload = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezePayload(child);
    Object.freeze(value);
  }
  return value;
};
const sessionColumns = ['session_id', 'session_token_hash', 'init_data_fingerprint', 'bot_id',
  'telegram_id', 'token_version', 'status', 'issued_at', 'expires_at', 'revoked_at'];
const dbSession = binding => {
  if (!binding?.withSession || !binding?.prepare || !binding?.batch) fail('untrusted_database');
  const db = binding.withSession('first-primary');
  if (!db?.prepare || !db?.batch) fail('untrusted_database');
  return db;
};
const clock = nowSeconds => {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!positive(now)) fail('invalid_time');
  return now;
};
const serverEnv = env => {
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail('invalid_server_configuration');
  // Copy primitives only: bindings and secrets never appear in the context DTO.
  return Object.freeze(Object.fromEntries(Object.entries(env).filter(([, value]) =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')));
};
const register = (facts, assertions) => {
  if (!positive(facts.nowSeconds) || !positive(facts.expiresAt) || facts.expiresAt <= facts.nowSeconds ||
      facts.expiresAt > facts.nowSeconds + 300) fail('invalid_context_deadline');
  const context = Object.freeze({ version: 1, actorKind: facts.actorKind, requestId: facts.requestId });
  contexts.set(context, Object.freeze({ ...facts, assertions: Object.freeze(assertions) }));
  return context;
};
export const isTrustedContext = context => contexts.has(context);
export function readTrustedContext(context) {
  const facts = contexts.get(context);
  if (!facts) fail('untrusted_context');
  return facts;
}
export function compileContextAssertions(context) {
  const facts = readTrustedContext(context);
  const sql = ['unixepoch() < ?', ...facts.assertions.map(proof => `(${proof.sql})`)];
  const params = [facts.expiresAt, ...facts.assertions.flatMap(proof => proof.params)];
  return Object.freeze({ sql: sql.join(' AND '), params: Object.freeze(params), validUntil: facts.expiresAt });
}

export async function createCustomerContext({ binding, env, initData, sessionToken, sessionScope,
  telegramContext, webhookRequest, receiptClaimToken, idempotencyKey, requestPayload,
  channel, operation, nowSeconds } = {}) {
  const now = clock(nowSeconds);
  operation = normalizeOperation(operation);
  if (!CHANNELS.has(channel) || channel === 'service' || !operationText(operation)) fail('invalid_transport');
  if ([initData !== undefined, sessionToken !== undefined, telegramContext !== undefined,
    webhookRequest !== undefined].filter(Boolean).length !== 1) {
    fail('ambiguous_authentication');
  }
  const configuration = serverEnv(env), db = dbSession(binding);
  const assertions = [];
  let principal, transportOperationId = null, transportPayload, transportBinding = null;
  if (initData !== undefined) {
    if (!['mini_app', 'http'].includes(channel)) fail('invalid_transport');
    principal = await verifyTelegramInitData({ initData, botToken: configuration.BOT_TOKEN,
      expectedBotId: configuration.REBUILD_V140_BOT_ID === undefined ? undefined : Number(configuration.REBUILD_V140_BOT_ID),
      nowSeconds: now });
  } else if (sessionToken !== undefined) {
    if (!['mini_app', 'http'].includes(channel)) fail('invalid_transport');
    if (typeof sessionToken !== 'string' || !/^rpms1_[A-Za-z0-9_-]{43}$/u.test(sessionToken)) fail('invalid_session');
    const hash = await sha256Hex(sessionToken);
    const query = `SELECT ${sessionColumns.join(', ')} FROM mini_app_sessions WHERE session_token_hash=? ORDER BY session_id LIMIT 2`;
    const result = await db.prepare(query).bind(hash).all();
    if (result?.success !== true) fail('session_read_failed');
    const rows = result.results;
    if (!Array.isArray(rows) || rows.length !== 1) fail('invalid_session');
    const row = rows[0];
    const tokenBotId = Number(configuration.BOT_TOKEN?.split(':')[0]);
    if (!positive(tokenBotId)) fail('invalid_server_configuration');
    principal = await verifyMiniAppSession({ sessionRecord: { authoritySource: 'database',
      sessionId: row.session_id, sessionTokenHash: row.session_token_hash,
      initDataFingerprint: row.init_data_fingerprint, telegramId: row.telegram_id,
      botId: row.bot_id, tokenVersion: row.token_version, status: row.status,
      issuedAt: row.issued_at, expiresAt: row.expires_at, revokedAt: row.revoked_at },
      sessionToken, expectedTelegramId: row.telegram_id, expectedBotId: tokenBotId,
      nowSeconds: now, sessionScope });
    const equality = sessionColumns.map(name => `${name} IS ?`).join(' AND ');
    assertions.push(Object.freeze({ sql: `EXISTS(SELECT 1 FROM mini_app_sessions WHERE ${equality})`,
      params: Object.freeze(sessionColumns.map(name => row[name])) }));
  } else if (webhookRequest !== undefined) {
    if (!['telegram_command', 'telegram_callback'].includes(channel) || !(webhookRequest instanceof Request)) {
      fail('invalid_transport');
    }
    const botId = Number(configuration.BOT_TOKEN?.split(':')[0]);
    if (!positive(botId)) fail('invalid_server_configuration');
    const authentication = await readVerifiedCabinetUpdate(webhookRequest, { env: configuration,
      gate: { origin: new URL(webhookRequest.url).origin, botId, accessScope: 'admin', issuedAt: 0 }, nowSeconds: now });
    if (!authentication || Boolean(authentication.update.callback_query) !== (channel === 'telegram_callback')) {
      fail('untrusted_telegram_update');
    }
    if (typeof receiptClaimToken !== 'string' || receiptClaimToken.length < 16 || receiptClaimToken.length > 256) {
      fail('invalid_telegram_receipt');
    }
    const receipt = await db.prepare(`SELECT update_id, actor_id, claim_token, lease_expires_at, status
      FROM telegram_update_receipts WHERE update_id=?`).bind(authentication.update.update_id).all();
    if (receipt?.success !== true) fail('telegram_receipt_read_failed');
    if (!Array.isArray(receipt.results) || receipt.results.length !== 1) fail('invalid_telegram_receipt');
    const row = receipt.results[0];
    if (row.actor_id !== authentication.actor || row.claim_token !== receiptClaimToken ||
        row.status !== 'processing' || !positive(row.lease_expires_at) ||
        row.lease_expires_at <= now) fail('invalid_telegram_receipt');
    principal = { telegramId: authentication.actor, botId, expiresAt: Math.min(row.lease_expires_at, now + 300) };
    if (typeof authentication.update.message?.text === 'string') transportPayload = { prompt: authentication.update.message.text };
    transportOperationId = `telegram:${botId}:${authentication.actor}:${row.update_id}:${operation}`;
    transportBinding = Object.freeze({ kind: 'telegram', botId, actor: authentication.actor, updateId: row.update_id });
    assertions.push(Object.freeze({ sql: `EXISTS(SELECT 1 FROM telegram_update_receipts WHERE update_id=?
      AND actor_id=? AND claim_token=? AND lease_expires_at=? AND status='processing'
      AND lease_expires_at>unixepoch())`, params: Object.freeze([row.update_id, row.actor_id,
        row.claim_token, row.lease_expires_at]) }));
  } else {
    if (!['telegram_command', 'telegram_callback'].includes(channel) || !isVerifiedTelegramCommandContext(telegramContext)) {
      fail('untrusted_telegram_context');
    }
    principal = telegramContext;
    transportOperationId = `telegram:${principal.botId}:${principal.telegramId}:${principal.updateId}:${operation}`;
    transportBinding = Object.freeze({ kind: 'telegram', botId: principal.botId, actor: principal.telegramId, updateId: principal.updateId });
    if (principal.issuedAt > now || principal.expiresAt <= now ||
        principal.botId !== Number(configuration.BOT_TOKEN?.split(':')[0])) fail('invalid_telegram_context');
    assertions.push(Object.freeze({ sql: `EXISTS(SELECT 1 FROM telegram_update_receipts WHERE update_id=?
      AND actor_id=? AND status='processing' AND claim_token=? AND lease_expires_at>unixepoch())
      AND EXISTS(SELECT 1 FROM mini_app_release_control WHERE id=1 AND candidate_sha=? AND revision=?)`,
      params: Object.freeze([principal.updateId, principal.telegramId, principal.claimToken,
        principal.candidateSha, principal.revision]) }));
  }
  if (!positive(principal.telegramId) || !positive(principal.botId) ||
      !positive(principal.expiresAt) || principal.expiresAt <= now) fail('expired_authentication');
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' ||
      !/^[A-Za-z0-9_.:-]{16,128}$/u.test(idempotencyKey))) fail('invalid_idempotency_key');
  const encodedPayload = requestPayload === undefined && transportPayload === undefined ? null :
    canonicalPayload(requestPayload ?? transportPayload);
  const payloadHash = encodedPayload === null ? null : await sha256Hex(encodedPayload);
  const privatePayload = encodedPayload === null ? null : freezePayload(JSON.parse(encodedPayload));
  if (idempotencyKey !== undefined && payloadHash === null) fail('missing_operation_payload');
  const stableOperation = transportOperationId ?? (idempotencyKey === undefined ? null :
    `http:${principal.botId}:${principal.telegramId}:${operation}:${idempotencyKey}`);
  if (!transportBinding && idempotencyKey !== undefined) transportBinding = Object.freeze({
    kind: 'http', botId: principal.botId, actor: principal.telegramId, idempotencyKey,
  });
  const operationId = stableOperation === null ? null : await sha256Hex(`v1.4.1.operation\n${stableOperation}`);
  return register({ actorKind: 'customer', telegramId: principal.telegramId, botId: principal.botId,
    verifiedSessionId: principal.sessionId ?? null,
    // Preserve a derived provider-availability fact without copying the
    // binding itself or trusting a request/configuration boolean assertion.
    publicAiProviderConnected: typeof env.AI?.run === 'function',
    // Keep only the observed availability of the real Workflow binding.
    // A request or a primitive configuration flag cannot mint this fact.
    previewWorkflowConnected: typeof env.DRAGON_PREVIEW_WORKFLOW?.create === 'function',
    nowSeconds: now, issuedAt: now, expiresAt: Math.min(principal.expiresAt, now + 300),
    channel, operation, requestId: crypto.randomUUID(), operationId, payloadHash,
    requestPayload: privatePayload, transportBinding, db, env: configuration }, assertions);
}

// Compiled server handlers may select another operation on the same verified
// request. This cannot change a principal, binding, authentication or deadline.
export async function deriveTrustedOperationContext(original, { operation, requestPayload } = {}) {
  const facts = readTrustedContext(original);
  operation = normalizeOperation(operation);
  if (!compiledOperations.has(operation) || facts.actorKind !== 'customer') fail('invalid_derived_operation');
  const encoded = requestPayload === undefined ? (facts.requestPayload === null ? null : canonicalPayload(facts.requestPayload))
    : canonicalPayload(requestPayload);
  const transport = facts.transportBinding;
  const stable = !transport ? null : transport.kind === 'telegram'
    ? `telegram:${transport.botId}:${transport.actor}:${transport.updateId}:${operation}`
    : `http:${transport.botId}:${transport.actor}:${operation}:${transport.idempotencyKey}`;
  return register({ ...facts, operation, requestId: crypto.randomUUID(),
    operationId: stable === null ? null : await sha256Hex(`v1.4.1.operation\n${stable}`),
    payloadHash: encoded === null ? null : await sha256Hex(encoded),
    requestPayload: encoded === null ? null : freezePayload(JSON.parse(encoded)),
  }, facts.assertions);
}

// Authentication proofs are re-read on the same primary session, using the
// server clock. Refresh never extends the original transport/claim deadline.
export async function refreshTrustedContext(original) {
  const facts = readTrustedContext(original), now = clock();
  if (now >= facts.expiresAt) fail('expired_authentication');
  const proof = compileContextAssertions(original);
  const result = await facts.db.prepare(`SELECT (${proof.sql}) AS allowed`).bind(...proof.params).all();
  if (result?.success !== true || result.results?.length !== 1 || result.results[0].allowed !== 1) fail('authentication_changed');
  return register({ ...facts, nowSeconds: now, requestId: crypto.randomUUID() }, facts.assertions);
}

const flowColumns=Object.freeze({
  admin:['telegram_id','action','step','offer_code','payload_json','updated_at'],
  partner:['telegram_id','action','step','payload_json','updated_at'],
});
// Plain-text follow-ups consume a fixed actual own flow row. The row snapshot
// becomes part of every derived effect proof until that flow is consumed.
export async function captureTelegramFlowContext(original,{kind}={}) {
  const facts=readTrustedContext(original),columns=flowColumns[kind];
  if(facts.actorKind!=='customer'||!['telegram_command','telegram_callback'].includes(facts.channel)||!columns)fail('invalid_flow_scope');
  const where=`telegram_id=?${kind==='admin'?" AND datetime(updated_at)>=datetime('now','-30 minutes')":''}`;
  const sql=`SELECT ${columns.join(',')} FROM ${kind}_sessions WHERE ${where}`;
  const result=await facts.db.prepare(sql).bind(facts.telegramId).all();
  if(result?.success!==true||!Array.isArray(result.results)||result.results.length>1)fail('flow_read_failed');
  const row=result.results[0]??null;
  const snapshotSql=`SELECT json_array(${columns.join(',')}) FROM ${kind}_sessions WHERE ${where}`;
  const proof=Object.freeze({proofKind:`flow:${kind}`,sql:`(${snapshotSql}) IS ?`,
    params:Object.freeze([facts.telegramId,row===null?null:JSON.stringify(columns.map(key=>row[key]))])});
  const assertions=[...facts.assertions.filter(item=>item.proofKind!==proof.proofKind),proof];
  return Object.freeze({context:register({...facts,requestId:crypto.randomUUID()},assertions),
    row:row===null?null:freezePayload({...row})});
}
export function releaseConsumedTelegramFlowContext(original,{kind}={}) {
  const facts=readTrustedContext(original);
  if(!flowColumns[kind]||facts.actorKind!=='customer')fail('invalid_flow_scope');
  return register({...facts,requestId:crypto.randomUUID()},facts.assertions.filter(item=>item.proofKind!==`flow:${kind}`));
}

const stricterWrapperFlags=new Set(['AI_PARTNER_EXTERNAL_PROVIDER_ENABLED','AI_PARTNER_RICH_MESSAGES_ENABLED']);
// These two existing wrappers can turn functionality off. All other captured
// identity, source, budget and configuration primitives must remain exact.
export function restrictTrustedContextForWrapper(original,env) {
  const facts=readTrustedContext(original),configuration={...facts.env};let changed=false;
  for(const [key,value] of Object.entries(facts.env)) {
    if(env[key]===value)continue;
    if(!stricterWrapperFlags.has(key)||!(env[key]===false||env[key]==='false'))fail('runtime_binding_changed');
    configuration[key]=env[key];changed=true;
  }
  for(const key of stricterWrapperFlags)if(!Object.hasOwn(facts.env,key)&&(env[key]===false||env[key]==='false')) {
    configuration[key]=env[key];changed=true;
  }
  if(!changed)return original;
  return register({...facts,env:Object.freeze(configuration),requestId:crypto.randomUUID()},facts.assertions);
}

// Cabinet scope derives only from the authenticated canonical subject and
// fixed server release configuration. Callers cannot inject SQL assertions.
export async function createCabinetCustomerContext(args = {}) {
  if (!['mini_app', 'http', 'telegram_command', 'telegram_callback'].includes(args.channel)) fail('invalid_transport');
  const context = await createCustomerContext(args), facts = readTrustedContext(context);
  if (facts.env.REBUILD_V140_STORAGE_ENABLED !== 'true') fail('cabinet_storage_unavailable');
  const admin = facts.telegramId === canonicalCabinetOwnerId(facts.env);
  const fence = admin ? releaseAdminFence(facts.env) : releaseLeaseFence(facts.env);
  if (!fence) fail('release_lease_unavailable');
  let expiresAt = facts.expiresAt;
  if (!admin) {
    const owner = Number(facts.env.REBUILD_V140_OWNER_TELEGRAM_ID ?? facts.env.OWNER_TELEGRAM_ID);
    const window = /^true:([0-9]{10}):([0-9]{10})$/u.exec(facts.env.REBUILD_V140_OWNER_WINDOW ?? '');
    if (facts.telegramId !== owner || !window || Number(window[1]) > facts.nowSeconds) fail('cabinet_participant_mismatch');
    expiresAt = Math.min(expiresAt, Number(window[2]));
  }
  const result = register({ ...facts, expiresAt }, [...facts.assertions, fence]);
  const proof = compileContextAssertions(result);
  const checked = await facts.db.prepare(`SELECT (${proof.sql}) AS allowed`).bind(...proof.params).all();
  if (checked?.success !== true || checked.results?.length !== 1 || checked.results[0].allowed !== 1) fail('release_lease_unavailable');
  return result;
}

// Fixed financial ingress adapter. This brand comes from the original secret-
// authenticated webhook and its currently claimed receipt, never a supplied
// actor ID, financial DTO or fabricated Mini App session. Delayed successful
// payment messages are observations, so command-message freshness is not used.
// Refund service messages cannot mint customer authority here.
export async function createFinancialCustomerContext({ binding, env, webhookRequest,
  receiptClaimToken, nowSeconds } = {}) {
  const now = clock(nowSeconds), configuration = serverEnv(env), db = dbSession(binding);
  if (!(webhookRequest instanceof Request) || typeof configuration.WEBHOOK_SECRET !== 'string' ||
      configuration.WEBHOOK_SECRET.length < 16 || typeof receiptClaimToken !== 'string' ||
      receiptClaimToken.length < 16 || receiptClaimToken.length > 256) fail('untrusted_financial_transport');
  const url = new URL(webhookRequest.url), expectedOrigin = configuration.MINI_APP_ORIGIN;
  if (webhookRequest.method !== 'POST' || url.pathname !== '/webhook' || url.search ||
      url.origin !== expectedOrigin || webhookRequest.headers.get('X-Telegram-Bot-Api-Secret-Token') !== configuration.WEBHOOK_SECRET ||
      !/^application\/json(?:\s*;|$)/iu.test(webhookRequest.headers.get('Content-Type') ?? ''))
    fail('untrusted_financial_transport');
  const declared = webhookRequest.headers.get('Content-Length');
  if (declared !== null && (!/^[0-9]{1,6}$/u.test(declared) || Number(declared) > 65536)) fail('untrusted_financial_transport');
  const reader = webhookRequest.clone().body?.getReader();
  if (!reader) fail('untrusted_financial_transport');
  let update, timer;
  try {
    const chunks = []; let length = 0;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('financial_body_timeout')), 5000); });
    for (;;) {
      const result = await Promise.race([reader.read(), deadline]); if (result.done) break;
      length += result.value.byteLength; if (length > 65536) fail('untrusted_financial_transport'); chunks.push(result.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    update = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { fail('untrusted_financial_transport'); }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
  if (!update || typeof update !== 'object' || Array.isArray(update) ||
      !Number.isSafeInteger(update.update_id) || update.update_id < 0 || update.callback_query || update.subscription ||
      Boolean(update.pre_checkout_query) === Boolean(update.message?.successful_payment) || update.message?.refunded_payment)
    fail('untrusted_financial_transport');
  const checkout = update.pre_checkout_query, message = update.message, from = checkout?.from ?? message?.from;
  if (!positive(from?.id) || from.is_bot === true || !checkout &&
      (message.chat?.type !== 'private' || message.chat.id !== from.id || message.forward_origin ||
       message.sender_chat || message.business_connection_id)) fail('untrusted_financial_transport');
  const botId = Number(configuration.BOT_TOKEN?.split(':')[0]);
  if (!positive(botId)) fail('invalid_server_configuration');
  const result = await db.prepare(`SELECT update_id,actor_id,claim_token,lease_expires_at,status
    FROM telegram_update_receipts WHERE update_id=?`).bind(update.update_id).all();
  if (result?.success !== true || result.results?.length !== 1) fail('invalid_telegram_receipt');
  const row = result.results[0];
  if (row.actor_id !== from.id || row.claim_token !== receiptClaimToken || row.status !== 'processing' ||
      !positive(row.lease_expires_at) || row.lease_expires_at <= now) fail('invalid_telegram_receipt');
  const assertion = Object.freeze({ sql: `EXISTS(SELECT 1 FROM telegram_update_receipts WHERE update_id=?
    AND actor_id=? AND claim_token=? AND lease_expires_at=? AND status='processing' AND lease_expires_at>unixepoch())`,
    params: Object.freeze([row.update_id,row.actor_id,row.claim_token,row.lease_expires_at]) });
  const encodedUpdate = canonicalPayload(update), updateSha256 = await sha256Hex(encodedUpdate);
  const payload = canonicalPayload({ update });
  return register({ actorKind:'customer',telegramId:from.id,botId,nowSeconds:now,issuedAt:now,
    expiresAt:Math.min(row.lease_expires_at,now+300),channel:'telegram_command',operation:'access.read_own',
    requestId:crypto.randomUUID(),operationId:await sha256Hex(`v144.financial:${botId}:${from.id}:${update.update_id}`),
    payloadHash:await sha256Hex(payload),requestPayload:freezePayload(JSON.parse(payload)),
    transportBinding:Object.freeze({kind:'telegram',botId,actor:from.id,updateId:update.update_id,financialUpdateSha256:updateSha256}),
    db,env:configuration },[assertion]);
}

// Construct once in a fixed server executor, never from a job's purpose field.
// The resulting run() accepts no actor/role/plan/purpose authority from payloads.
export function createServiceExecutor({ binding, env, purpose, clockSeconds } = {}) {
  if (!Object.hasOwn(SERVICE_PURPOSES, purpose)) fail('unknown_service_purpose');
  const configuration = serverEnv(env), capability = SERVICE_PURPOSES[purpose];
  return Object.freeze({ purpose, capability,
    createContext({ requestPayload } = {}) {
      const now = clock(typeof clockSeconds === 'function' ? clockSeconds() : undefined);
      const privatePayload = requestPayload === undefined ? null : freezePayload(JSON.parse(canonicalPayload(requestPayload)));
      return register({ actorKind: 'service', telegramId: null, botId: null,
        nowSeconds: now, issuedAt: now, expiresAt: now + 300, channel: 'service',
        operation: capability, purpose: SERVICE_CANONICAL_PURPOSES[purpose], executorPurpose: purpose,
        capability, requestId: crypto.randomUUID(), operationId: null, payloadHash: null,
        requestPayload: privatePayload, db: dbSession(binding), env: configuration }, []);
    },
  });
}
