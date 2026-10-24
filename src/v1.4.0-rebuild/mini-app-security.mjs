const encoder = new TextEncoder();
// JSON cannot create this Worker-internal verified Telegram provenance.
export { isVerifiedTelegramCommandContext } from './telegram-command-authority.mjs';
const decoder = new TextDecoder("utf-8", { fatal: true });

const deepFreeze = (value) => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
};

export const MINI_APP_SECURITY_VERSION =
  "2026-09-29.v1.4.0-rebuild-p03";
export const INIT_DATA_MAX_AGE_SECONDS = 300;
export const INIT_DATA_FUTURE_SKEW_SECONDS = 60;
export const SESSION_TTL_SECONDS = 300;
export const CURSOR_TTL_SECONDS = 300;
export const MAX_INIT_DATA_BYTES = 8_192;
export const MAX_JSON_BODY_BYTES = 32_768;

export const MINI_APP_SECURITY_HEADERS = deepFreeze({
  "Cache-Control": "no-store, max-age=0",
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self' https://telegram.org",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors https://web.telegram.org https://*.telegram.org",
  ].join("; "),
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=()",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-DNS-Prefetch-Control": "off",
});

export const SECURITY_STORAGE_CONTRACT = deepFreeze({
  version: 1,
  operation: "consume_init_data_and_create_session",
  atomic: true,
  replayKey: "init_data_fingerprint",
  replayKeyUnique: true,
  sessionTokenStorage: "sha256_only",
  rawInitDataStorage: "forbidden",
  rawSessionTokenStorage: "forbidden",
  schemaState: "blocked_until_live_read_only_inventory",
  earliestMigration: 57,
});

export const SECURITY_THREAT_MATRIX = deepFreeze({
  forgedInitData: "telegram_hmac_sha256",
  staleOrFutureInitData: "bounded_auth_date",
  replay: "unique_fingerprint_plus_atomic_persist",
  tokenDatabaseLeak: "hash_only_session_token",
  crossAccountSession: "telegram_bot_and_session_binding",
  csrfAndCrossOrigin: "bearer_token_plus_exact_origin",
  duplicateMutation: "required_hashed_idempotency_key",
  cursorTampering: "hmac_bound_cursor",
  xssBlastRadius: "strict_csp_no_inline_code",
  credentialInUrl: "secret_query_parameter_rejection",
});

const HEX_64 = /^[0-9a-f]{64}$/u;
const SAFE_INIT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const BOT_TOKEN = /^([1-9][0-9]{4,15}):([A-Za-z0-9_-]{20,120})$/u;
const SESSION_TOKEN = /^rpms1_[A-Za-z0-9_-]{43}$/u;
const SESSION_ID = /^mss_[0-9a-f]{64}$/u;
const CURSOR_ROUTE = /^[a-z][a-z0-9_.:-]{1,95}$/u;
const CURSOR_ANCHOR = /^[A-Za-z0-9_.:-]{1,128}$/u;
const CLIENT_IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/u;
const OPERATION = /^[a-z][a-z0-9_.:-]{1,95}$/u;
const REQUEST_ID = /^req_[0-9a-f]{32,64}$/u;
const SECRET_QUERY_KEYS = new Set([
  "api_key",
  "authorization",
  "init_data",
  "initdata",
  "session",
  "session_token",
  "token",
]);

const STATUS_BY_CODE = Object.freeze({
  invalid_request: 400,
  invalid_origin: 403,
  invalid_content_type: 415,
  payload_too_large: 413,
  missing_idempotency_key: 400,
  invalid_idempotency_key: 400,
  credentials_in_url: 400,
  replayed_init_data: 409,
  security_storage_unavailable: 503,
});

export class MiniAppSecurityError extends Error {
  constructor(code, status = STATUS_BY_CODE[code] ?? 401) {
    super(code);
    this.name = "MiniAppSecurityError";
    this.code = code;
    this.status = status;
  }
}

const fail = (code, status) => {
  throw new MiniAppSecurityError(code, status);
};

const subtle = () => {
  if (!globalThis.crypto?.subtle) fail("crypto_unavailable", 503);
  return globalThis.crypto.subtle;
};

const byteLength = (value) => encoder.encode(value).byteLength;

const bytesToHex = (bytes) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const hexToBytes = (value, code = "invalid_signature") => {
  if (!HEX_64.test(value)) fail(code);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const constantTimeEqual = (left, right) => {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) {
    return false;
  }
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
};

const sha256Bytes = async (value) => new Uint8Array(
  await subtle().digest(
    "SHA-256",
    typeof value === "string" ? encoder.encode(value) : value,
  ),
);

export const sha256Hex = async (value) => bytesToHex(await sha256Bytes(value));

const hmacSha256 = async (keyBytes, messageBytes) => {
  const key = await subtle().importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await subtle().sign("HMAC", key, messageBytes));
};

const hmacHex = async (secret, message, code = "invalid_secret") => {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 512) {
    fail(code, 500);
  }
  return bytesToHex(await hmacSha256(encoder.encode(secret), encoder.encode(message)));
};

const stableValue = (value) => {
  if (value === null || typeof value === "string" ||
      typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_canonical_value", 500);
    return value;
  }
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      stableValue(value[key]),
    ]));
  }
  fail("invalid_canonical_value", 500);
};

const stableJson = (value) => JSON.stringify(stableValue(value));

const asPositiveSafeInteger = (value, code) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
};

const takeRandomBytes = (length, randomBytes) => {
  const bytes = randomBytes
    ? randomBytes(length)
    : globalThis.crypto?.getRandomValues(new Uint8Array(length));
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    fail("invalid_random_source", 500);
  }
  return new Uint8Array(bytes);
};

const bytesToBase64Url = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const base64UrlToBytes = (value, code = "invalid_cursor") => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value) ||
      value.length > 2_048) fail(code);
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    fail(code);
  }
};

const parseBotToken = (botToken) => {
  if (typeof botToken !== "string" || botToken.length > 140) {
    fail("invalid_bot_token", 500);
  }
  const match = BOT_TOKEN.exec(botToken);
  if (!match) fail("invalid_bot_token", 500);
  return asPositiveSafeInteger(match[1], "invalid_bot_token");
};

const decodeQueryComponent = (value) => {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    fail("invalid_init_data");
  }
};

const parseInitData = (initData) => {
  if (typeof initData !== "string" || byteLength(initData) < 16 ||
      byteLength(initData) > MAX_INIT_DATA_BYTES || /[\0\r\n]/u.test(initData)) {
    fail("invalid_init_data");
  }

  const pairs = initData.split("&");
  if (pairs.length < 3 || pairs.length > 64 || pairs.some((pair) => !pair)) {
    fail("invalid_init_data");
  }

  const fields = new Map();
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator <= 0) fail("invalid_init_data");
    const key = decodeQueryComponent(pair.slice(0, separator));
    const value = decodeQueryComponent(pair.slice(separator + 1));
    if (!SAFE_INIT_KEY.test(key) || fields.has(key) ||
        /[\0\r\n]/u.test(value) || byteLength(value) > 4_096) {
      fail("invalid_init_data");
    }
    fields.set(key, value);
  }

  for (const required of ["auth_date", "hash", "user"]) {
    if (!fields.has(required)) fail("invalid_init_data");
  }
  return fields;
};

export async function verifyTelegramInitData({
  initData,
  botToken,
  expectedBotId,
  expectedTelegramId,
  nowSeconds = Math.floor(Date.now() / 1_000),
  maxAgeSeconds = INIT_DATA_MAX_AGE_SECONDS,
  futureSkewSeconds = INIT_DATA_FUTURE_SKEW_SECONDS,
} = {}) {
  const now = asPositiveSafeInteger(nowSeconds, "invalid_time");
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 60 ||
      maxAgeSeconds > INIT_DATA_MAX_AGE_SECONDS ||
      !Number.isSafeInteger(futureSkewSeconds) || futureSkewSeconds < 0 ||
      futureSkewSeconds > INIT_DATA_FUTURE_SKEW_SECONDS) {
    fail("invalid_ttl", 500);
  }

  const botId = parseBotToken(botToken);
  if (expectedBotId !== undefined &&
      asPositiveSafeInteger(expectedBotId, "bot_mismatch") !== botId) {
    fail("bot_mismatch");
  }

  const fields = parseInitData(initData);
  const providedHash = hexToBytes(fields.get("hash"));
  const dataCheckString = [...fields.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = await hmacSha256(
    encoder.encode("WebAppData"),
    encoder.encode(botToken),
  );
  const expectedHash = await hmacSha256(
    secretKey,
    encoder.encode(dataCheckString),
  );
  if (!constantTimeEqual(providedHash, expectedHash)) {
    fail("forged_init_data");
  }

  const authDateText = fields.get("auth_date");
  if (!/^[1-9][0-9]{8,12}$/u.test(authDateText)) {
    fail("invalid_auth_date");
  }
  const authDate = asPositiveSafeInteger(authDateText, "invalid_auth_date");
  if (authDate > now + futureSkewSeconds) fail("future_init_data");
  if (now - authDate > maxAgeSeconds) fail("stale_init_data");

  let user;
  try {
    user = JSON.parse(fields.get("user"));
  } catch {
    fail("invalid_user");
  }
  if (!user || typeof user !== "object" || Array.isArray(user)) {
    fail("invalid_user");
  }
  const telegramId = asPositiveSafeInteger(user.id, "invalid_user");
  if (user.is_bot === true) fail("invalid_user");
  if (expectedTelegramId !== undefined &&
      asPositiveSafeInteger(expectedTelegramId, "identity_mismatch") !==
        telegramId) {
    fail("identity_mismatch");
  }

  const fingerprint = await sha256Hex(
    `telegram-mini-app-init-v2\n${dataCheckString}\nhash=${fields.get("hash")}`,
  );
  const queryIdHash = fields.has("query_id")
    ? await sha256Hex(fields.get("query_id"))
    : null;

  return deepFreeze({
    verificationVersion: 2,
    botId,
    telegramId,
    authDate,
    verifiedAt: now,
    expiresAt: authDate + maxAgeSeconds,
    initDataFingerprint: fingerprint,
    queryIdHash,
  });
}

const assertVerifiedAuthentication = (authentication) => {
  if (!authentication || typeof authentication !== "object" ||
      Array.isArray(authentication) || authentication.verificationVersion !== 2 ||
      !HEX_64.test(authentication.initDataFingerprint) ||
      !Number.isSafeInteger(authentication.botId) ||
      !Number.isSafeInteger(authentication.telegramId) ||
      !Number.isSafeInteger(authentication.authDate) ||
      !Number.isSafeInteger(authentication.expiresAt)) {
    fail("invalid_authentication", 500);
  }
  return authentication;
};

const scopedMiniAppSessionId = async (token, scope) => {
  if (scope === undefined) return `mss_${await sha256Hex(`mini-app-session-v1:${token}`)}`;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) ||
      Object.keys(scope).length !== 2 || !/^[0-9a-f]{40}$/u.test(scope.candidateSha) ||
      !Number.isSafeInteger(scope.revision) || scope.revision < 1) fail('invalid_session_scope', 500);
  return `mss_${await sha256Hex(`mini-app-session-v2:${scope.candidateSha}:${scope.revision}:${token}`)}`;
};

export async function buildMiniAppSessionEnvelope({
  authentication,
  nowSeconds = Math.floor(Date.now() / 1_000),
  ttlSeconds = SESSION_TTL_SECONDS,
  randomBytes,
  sessionScope,
} = {}) {
  const auth = assertVerifiedAuthentication(authentication);
  const now = asPositiveSafeInteger(nowSeconds, "invalid_time");
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 ||
      ttlSeconds > SESSION_TTL_SECONDS) fail("invalid_ttl", 500);
  const expiresAt = Math.min(now + ttlSeconds, auth.expiresAt);
  if (expiresAt <= now) fail("stale_init_data");

  const sessionToken = `rpms1_${bytesToBase64Url(
    takeRandomBytes(32, randomBytes),
  )}`;
  const sessionTokenHash = await sha256Hex(sessionToken);
  const sessionId = await scopedMiniAppSessionId(sessionToken, sessionScope);

  return deepFreeze({
    sessionToken,
    receipt: {
      receiptId: `mir_${auth.initDataFingerprint}`,
      initDataFingerprint: auth.initDataFingerprint,
      botId: auth.botId,
      telegramId: auth.telegramId,
      queryIdHash: auth.queryIdHash,
      authDate: auth.authDate,
      receivedAt: now,
      expiresAt: auth.expiresAt,
    },
    session: {
      sessionId,
      sessionTokenHash,
      initDataFingerprint: auth.initDataFingerprint,
      botId: auth.botId,
      telegramId: auth.telegramId,
      tokenVersion: 1,
      status: "active",
      issuedAt: now,
      expiresAt,
      revokedAt: null,
    },
  });
}

export async function establishMiniAppSession({
  authentication,
  persistAtomically,
  nowSeconds,
  ttlSeconds,
  randomBytes,
  sessionScope,
} = {}) {
  if (typeof persistAtomically !== "function") {
    fail("invalid_storage_adapter", 500);
  }
  const envelope = await buildMiniAppSessionEnvelope({
    authentication,
    nowSeconds,
    ttlSeconds,
    randomBytes,
    sessionScope,
  });

  let result;
  try {
    result = await persistAtomically({
      receipt: envelope.receipt,
      session: envelope.session,
    });
  } catch {
    fail("security_storage_unavailable");
  }
  if (result?.accepted === false && result?.reason === "replay") {
    fail("replayed_init_data");
  }
  if (result?.accepted !== true) fail("security_storage_unavailable");

  return deepFreeze({
    sessionToken: envelope.sessionToken,
    sessionId: envelope.session.sessionId,
    expiresAt: envelope.session.expiresAt,
    tokenType: "Bearer",
  });
}

export function extractBearerSessionToken(authorization) {
  if (typeof authorization !== "string" || authorization.length > 128) {
    fail("invalid_session");
  }
  const match = /^Bearer (rpms1_[A-Za-z0-9_-]{43})$/u.exec(authorization);
  if (!match || !SESSION_TOKEN.test(match[1])) fail("invalid_session");
  return match[1];
}

export async function verifyMiniAppSession({
  sessionRecord,
  sessionToken,
  expectedTelegramId,
  expectedBotId,
  nowSeconds = Math.floor(Date.now() / 1_000),
  sessionScope,
} = {}) {
  if (!sessionRecord || typeof sessionRecord !== "object" ||
      Array.isArray(sessionRecord) ||
      sessionRecord.authoritySource !== "database") {
    fail("untrusted_session");
  }
  const now = asPositiveSafeInteger(nowSeconds, "invalid_time");
  const telegramId = asPositiveSafeInteger(
    sessionRecord.telegramId,
    "invalid_session",
  );
  const botId = asPositiveSafeInteger(sessionRecord.botId, "invalid_session");
  const issuedAt = asPositiveSafeInteger(
    sessionRecord.issuedAt,
    "invalid_session",
  );
  const expiresAt = asPositiveSafeInteger(
    sessionRecord.expiresAt,
    "invalid_session",
  );
  if (!SESSION_ID.test(sessionRecord.sessionId) ||
      !HEX_64.test(sessionRecord.sessionTokenHash) ||
      !HEX_64.test(sessionRecord.initDataFingerprint) ||
      sessionRecord.tokenVersion !== 1 || sessionRecord.status !== "active" ||
      sessionRecord.revokedAt !== null || !SESSION_TOKEN.test(sessionToken) ||
      issuedAt > now || expiresAt <= now ||
      expiresAt > issuedAt + SESSION_TTL_SECONDS ||
      telegramId !== asPositiveSafeInteger(
        expectedTelegramId,
        "identity_mismatch",
      ) || botId !== asPositiveSafeInteger(expectedBotId, "bot_mismatch")) {
    fail("invalid_session");
  }

  const actualHash = await sha256Hex(sessionToken);
  if (!constantTimeEqual(
    hexToBytes(actualHash, "invalid_session"),
    hexToBytes(sessionRecord.sessionTokenHash, "invalid_session"),
  )) fail("invalid_session");
  if (sessionRecord.sessionId !== await scopedMiniAppSessionId(sessionToken, sessionScope)) {
    fail("invalid_session");
  }

  return deepFreeze({
    contextVersion: 1,
    authoritySource: "database_session",
    sessionId: sessionRecord.sessionId,
    telegramId,
    botId,
    expiresAt,
  });
}

const assertSessionContext = (context) => {
  if (!context || typeof context !== "object" ||
      context.contextVersion !== 1 ||
      context.authoritySource !== "database_session" ||
      !SESSION_ID.test(context.sessionId) ||
      !Number.isSafeInteger(context.telegramId) || context.telegramId <= 0 ||
      !Number.isSafeInteger(context.botId) || context.botId <= 0) {
    fail("invalid_session_context");
  }
  return context;
};

export async function createBoundCursor({
  context,
  routeCode,
  anchorTime,
  anchorKey,
  secret,
  nowSeconds = Math.floor(Date.now() / 1_000),
  ttlSeconds = CURSOR_TTL_SECONDS,
} = {}) {
  const session = assertSessionContext(context);
  const now = asPositiveSafeInteger(nowSeconds, "invalid_time");
  if (!CURSOR_ROUTE.test(routeCode) || !CURSOR_ANCHOR.test(anchorKey) ||
      !Number.isSafeInteger(anchorTime) || anchorTime <= 0 ||
      !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 ||
      ttlSeconds > CURSOR_TTL_SECONDS) fail("invalid_cursor");
  const expiresAt = Math.min(now + ttlSeconds, session.expiresAt);
  if (expiresAt <= now) fail("invalid_cursor");
  const payload = {
    version: 1,
    routeCode,
    sessionId: session.sessionId,
    telegramId: session.telegramId,
    botId: session.botId,
    anchorTime,
    anchorKey,
    issuedAt: now,
    expiresAt,
  };
  const encoded = bytesToBase64Url(encoder.encode(stableJson(payload)));
  const signature = await hmacHex(
    secret,
    `re-program-mini-app-cursor-v1\n${encoded}`,
    "invalid_cursor_secret",
  );
  return `rpc1.${encoded}.${signature}`;
}

export async function verifyBoundCursor({
  context,
  routeCode,
  cursor,
  secret,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const session = assertSessionContext(context);
  if (!CURSOR_ROUTE.test(routeCode) || typeof cursor !== "string" ||
      cursor.length > 2_048) fail("invalid_cursor");
  const parts = cursor.split(".");
  if (parts.length !== 3 || parts[0] !== "rpc1" || !HEX_64.test(parts[2])) {
    fail("invalid_cursor");
  }
  const expected = await hmacHex(
    secret,
    `re-program-mini-app-cursor-v1\n${parts[1]}`,
    "invalid_cursor_secret",
  );
  if (!constantTimeEqual(
    hexToBytes(parts[2], "invalid_cursor"),
    hexToBytes(expected, "invalid_cursor"),
  )) fail("invalid_cursor");

  let payload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlToBytes(parts[1])));
  } catch {
    fail("invalid_cursor");
  }
  const now = asPositiveSafeInteger(nowSeconds, "invalid_time");
  const exactKeys = [
    "anchorKey",
    "anchorTime",
    "botId",
    "expiresAt",
    "issuedAt",
    "routeCode",
    "sessionId",
    "telegramId",
    "version",
  ];
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).sort().join("|") !== exactKeys.sort().join("|") ||
      payload.version !== 1 || payload.routeCode !== routeCode ||
      payload.sessionId !== session.sessionId ||
      payload.telegramId !== session.telegramId || payload.botId !== session.botId ||
      !CURSOR_ANCHOR.test(payload.anchorKey) ||
      !Number.isSafeInteger(payload.anchorTime) || payload.anchorTime <= 0 ||
      !Number.isSafeInteger(payload.issuedAt) || payload.issuedAt > now ||
      !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now ||
      payload.expiresAt > payload.issuedAt + CURSOR_TTL_SECONDS ||
      payload.expiresAt > session.expiresAt) fail("invalid_cursor");

  return deepFreeze({
    anchorTime: payload.anchorTime,
    anchorKey: payload.anchorKey,
  });
}

const normalizeExpectedOrigin = (expectedOrigin) => {
  if (typeof expectedOrigin !== "string" || expectedOrigin.length > 256) {
    fail("invalid_server_origin", 500);
  }
  let parsed;
  try {
    parsed = new URL(expectedOrigin);
  } catch {
    fail("invalid_server_origin", 500);
  }
  if (parsed.protocol !== "https:" || parsed.origin !== expectedOrigin ||
      parsed.pathname !== "/" || parsed.search || parsed.hash) {
    fail("invalid_server_origin", 500);
  }
  return parsed.origin;
};

const isJsonContentType = (value) => {
  if (typeof value !== "string") return false;
  return /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value.trim());
};

export function assertMiniAppRequest({
  method,
  url,
  origin,
  expectedOrigin,
  contentType,
  contentLength = 0,
  idempotencyKey,
  secFetchSite,
} = {}) {
  const serverOrigin = normalizeExpectedOrigin(expectedOrigin);
  if (method !== "GET" && method !== "POST") fail("invalid_request");
  let parsed;
  try {
    parsed = new URL(url, serverOrigin);
  } catch {
    fail("invalid_request");
  }
  if (parsed.origin !== serverOrigin || parsed.username || parsed.password ||
      parsed.hash || !parsed.pathname.startsWith("/api/v1.4.0/cabinet/")) {
    fail("invalid_request");
  }
  for (const key of parsed.searchParams.keys()) {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase())) fail("credentials_in_url");
  }
  if (origin !== undefined && origin !== null && origin !== serverOrigin) {
    fail("invalid_origin");
  }
  if (secFetchSite !== undefined && secFetchSite !== "same-origin" &&
      secFetchSite !== "none") fail("invalid_origin");
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    fail("invalid_request");
  }

  if (method === "GET") {
    if (contentLength !== 0 || contentType || idempotencyKey) {
      fail("invalid_request");
    }
  } else {
    if (origin !== serverOrigin) fail("invalid_origin");
    if (!isJsonContentType(contentType)) fail("invalid_content_type");
    if (contentLength > MAX_JSON_BODY_BYTES) fail("payload_too_large");
    if (!idempotencyKey) fail("missing_idempotency_key");
    if (!CLIENT_IDEMPOTENCY_KEY.test(idempotencyKey)) {
      fail("invalid_idempotency_key");
    }
  }

  return deepFreeze({
    method,
    pathname: parsed.pathname,
    query: parsed.search,
    expectedOrigin: serverOrigin,
    idempotencyKey: method === "POST" ? idempotencyKey : null,
  });
}

export async function deriveServerIdempotencyKey({
  secret,
  operation,
  clientKey,
  telegramId,
} = {}) {
  if (!OPERATION.test(operation) || !CLIENT_IDEMPOTENCY_KEY.test(clientKey)) {
    fail("invalid_idempotency_key");
  }
  const actor = asPositiveSafeInteger(telegramId, "invalid_actor");
  return `mikey_${await hmacHex(
    secret,
    `${MINI_APP_SECURITY_VERSION}\n${operation}\n${actor}\n${clientKey}`,
    "invalid_idempotency_secret",
  )}`;
}

export async function buildSecurityLogRecord({
  code,
  requestId,
  context = null,
  logSecret,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  if (typeof code !== "string" || !/^[a-z][a-z0-9_]{1,63}$/u.test(code) ||
      !REQUEST_ID.test(requestId)) fail("invalid_log_record", 500);
  const now = asPositiveSafeInteger(nowSeconds, "invalid_time");
  const session = context === null ? null : assertSessionContext(context);
  const actorPseudonym = session
    ? await hmacHex(
      logSecret,
      `security-log-actor-v1:${session.telegramId}`,
      "invalid_log_secret",
    )
    : null;
  const sessionPseudonym = session
    ? await hmacHex(
      logSecret,
      `security-log-session-v1:${session.sessionId}`,
      "invalid_log_secret",
    )
    : null;
  return deepFreeze({
    schemaVersion: 1,
    code,
    requestId,
    actorPseudonym,
    sessionPseudonym,
    occurredAt: now,
  });
}

export function publicSecurityError(error) {
  const status = error instanceof MiniAppSecurityError ? error.status : 500;
  const publicCode = status === 409 ? "request_conflict"
    : status === 413 ? "payload_too_large"
      : status === 415 ? "unsupported_media_type"
        : status === 503 ? "temporarily_unavailable"
          : status === 403 ? "forbidden"
            : status === 400 ? "bad_request"
              : status === 401 ? "unauthorized"
                : "internal_error";
  return deepFreeze({ status, body: { error: publicCode } });
}
