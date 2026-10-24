const encoder = new TextEncoder();

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

export const CABINET_POLICY_VERSION = "2026-09-14.cabinet-v1-part1";
export const CABINET_CAPABILITY_REGISTRY_VERSION = 1;
export const CABINET_TARIFF_CAPACITY_VERSION = 1;
export const TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = 300;
export const CABINET_SESSION_TTL_SECONDS = 300;
export const CABINET_TECHNICAL_RETENTION_SECONDS = 15_552_000;

export const CABINET_ROLES = deepFreeze(["user", "partner", "admin"]);
export const CABINET_LEGAL_PROFILES = deepFreeze([
  "individual",
  "self_employed",
  "individual_entrepreneur",
  "unknown",
]);
export const CABINET_PARTNER_SPECIALIZATIONS = deepFreeze([
  "producer",
  "investor",
  "scout",
]);

export const CABINET_CAPABILITIES = deepFreeze({
  "profile.read": {
    resourceKind: "profile",
    action: "read",
    feature: "profile",
  },
  "profile.update": {
    resourceKind: "profile",
    action: "update",
    feature: "profile",
  },
  "offer.read": {
    resourceKind: "offer",
    action: "read",
    feature: "offer",
  },
  "offer.create": {
    resourceKind: "offer",
    action: "create",
    feature: "offer",
  },
  "offer.update": {
    resourceKind: "offer",
    action: "update",
    feature: "offer",
  },
  "offer.submit": {
    resourceKind: "offer",
    action: "submit",
    feature: "offer",
  },
  "application.read": {
    resourceKind: "application",
    action: "read",
    feature: "application",
  },
  "application.create": {
    resourceKind: "application",
    action: "create",
    feature: "application",
  },
  "application.update": {
    resourceKind: "application",
    action: "update",
    feature: "application",
  },
  "export.create": {
    resourceKind: "export",
    action: "create",
    feature: "export",
  },
});

export const CABINET_ROLE_MATRIX = deepFreeze({
  "profile.read": {
    user: ["allow", "self"],
    partner: ["allow", "self"],
    admin: ["allow", "global"],
  },
  "profile.update": {
    user: ["allow", "self"],
    partner: ["allow", "self"],
    admin: ["allow", "global"],
  },
  "offer.read": {
    user: ["allow", "public"],
    partner: ["allow", "public_or_partner_owner"],
    admin: ["allow", "global"],
  },
  "offer.create": {
    user: ["deny", "none"],
    partner: ["allow", "partner_owner"],
    admin: ["allow", "global"],
  },
  "offer.update": {
    user: ["deny", "none"],
    partner: ["allow", "partner_owner"],
    admin: ["allow", "global"],
  },
  "offer.submit": {
    user: ["deny", "none"],
    partner: ["allow", "partner_owner"],
    admin: ["allow", "global"],
  },
  "application.read": {
    user: ["allow", "self"],
    partner: ["allow", "partner_owner"],
    admin: ["allow", "global"],
  },
  "application.create": {
    user: ["allow", "self"],
    partner: ["deny", "none"],
    admin: ["allow", "global"],
  },
  "application.update": {
    user: ["deny", "none"],
    partner: ["allow", "partner_owner"],
    admin: ["allow", "global"],
  },
  "export.create": {
    user: ["allow", "self"],
    partner: ["allow", "partner_owner"],
    admin: ["allow", "global"],
  },
});

export const TARIFF_CAPACITY_PERCENT = deepFreeze({
  free: 10,
  professional: 50,
  dragon: 100,
});

export const CABINET_PLAN_QUOTAS = deepFreeze({
  active_applications: {
    free: 5,
    professional: 25,
    dragon: 50,
    windowKind: "concurrent",
    sourceKind: "fixed_product_override",
  },
  successful_ai_messages_utc_day: {
    free: 5,
    professional: 25,
    dragon: 50,
    windowKind: "utc_day",
    sourceKind: "capacity_formula",
  },
});

const ACCESS_STATES = new Set([
  "none",
  "trial",
  "active",
  "cancel_at_period_end",
  "expired",
  "refunded",
  "suspended",
  "unknown",
]);
const ROLE_SET = new Set(CABINET_ROLES);
const LEGAL_PROFILE_SET = new Set(CABINET_LEGAL_PROFILES);
const SPECIALIZATION_SET = new Set(CABINET_PARTNER_SPECIALIZATIONS);
const PLAN_SET = new Set(Object.keys(TARIFF_CAPACITY_PERCENT));
const HEX_64 = /^[0-9a-f]{64}$/;
const RESOURCE_ID = /^res_[0-9a-f]{64}$/;
const GRANT_ID = /^cgr_[0-9a-f]{64}$/;
const SAFE_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_CAPABILITY = /^[a-z0-9._]{3,64}$/;
const IDEMPOTENCY_OPERATION = /^[a-z][a-z0-9_.:-]{2,63}$/;
const AUDIT_REASONS = new Set([
  "baseline_allow",
  "grant_allow",
  "explicit_deny",
  "feature_off",
  "invalid_actor",
  "invalid_resource",
  "role_denied",
  "scope_denied",
  "unknown_capability",
]);

export class CabinetSecurityError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "CabinetSecurityError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new CabinetSecurityError(code, message);
};

const asRecord = (value, code) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code);
  }
  return value;
};

const positiveSafeInteger = (value, code) => {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
};

const unixSeconds = (value, code = "invalid_time") =>
  positiveSafeInteger(value, code);

const exactBoolean = (value, name) => {
  if (value === true || value === "true") return true;
  if (value === false || value === "false" || value === undefined) return false;
  fail("invalid_config", `${name} must be exactly true or false`);
};

const bytesToHex = (bytes) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const hexToBytes = (hex) => {
  if (!HEX_64.test(hex)) fail("invalid_signature", "invalid Telegram hash");
  const result = new Uint8Array(hex.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
};

const constantTimeEqual = (left, right) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
};

const subtleCrypto = () => {
  if (!globalThis.crypto?.subtle) fail("crypto_unavailable");
  return globalThis.crypto.subtle;
};

const sha256Bytes = async (value) => new Uint8Array(
  await subtleCrypto().digest("SHA-256", typeof value === "string"
    ? encoder.encode(value)
    : value),
);

export const sha256Hex = async (value) => bytesToHex(await sha256Bytes(value));

const hmacSha256 = async (keyBytes, valueBytes) => {
  const key = await subtleCrypto().importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await subtleCrypto().sign("HMAC", key, valueBytes));
};

const base64Url = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const takeRandomBytes = (length, randomBytes) => {
  const bytes = randomBytes
    ? randomBytes(length)
    : globalThis.crypto?.getRandomValues(new Uint8Array(length));
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    fail("invalid_random_source");
  }
  return new Uint8Array(bytes);
};

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      stableValue(value[key]),
    ]));
  }
  return value;
};

const stableJson = (value) => JSON.stringify(stableValue(value));
const compareKeys = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export function readCabinetRuntimeConfig(env = {}) {
  const rolloutMode = env.CABINET_V1_ROLLOUT_MODE ?? "off";
  if (!new Set(["off", "admin_shadow"]).has(rolloutMode)) {
    fail("invalid_config", "CABINET_V1_ROLLOUT_MODE is invalid");
  }
  const config = {
    rolloutMode,
    masterEnabled: exactBoolean(env.CABINET_V1_ENABLED, "CABINET_V1_ENABLED"),
    profileEnabled: exactBoolean(
      env.CABINET_PROFILE_ENABLED,
      "CABINET_PROFILE_ENABLED",
    ),
    offerEnabled: exactBoolean(
      env.CABINET_OFFER_ENABLED,
      "CABINET_OFFER_ENABLED",
    ),
    applicationEnabled: exactBoolean(
      env.CABINET_APPLICATION_ENABLED,
      "CABINET_APPLICATION_ENABLED",
    ),
    exportEnabled: exactBoolean(
      env.CABINET_EXPORT_ENABLED,
      "CABINET_EXPORT_ENABLED",
    ),
    initDataMaxAgeSeconds: TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
    sessionTtlSeconds: CABINET_SESSION_TTL_SECONDS,
  };
  const childEnabled = config.profileEnabled || config.offerEnabled
    || config.applicationEnabled || config.exportEnabled;
  if ((!config.masterEnabled && (config.rolloutMode !== "off" || childEnabled))
      || (config.masterEnabled && config.rolloutMode !== "admin_shadow")) {
    fail("invalid_config", "cabinet flags violate the fail-closed hierarchy");
  }
  return deepFreeze(config);
}

export function resolveCabinetFeatureGate({
  environmentConfig,
  databaseSettings,
} = {}) {
  const env = environmentConfig && typeof environmentConfig === "object"
    ? environmentConfig
    : {};
  const database = databaseSettings && typeof databaseSettings === "object"
    ? databaseSettings
    : {};
  const envFlags = [
    "masterEnabled",
    "profileEnabled",
    "offerEnabled",
    "applicationEnabled",
    "exportEnabled",
  ];
  const dbFlagPairs = [
    ["masterEnabled", "master_enabled"],
    ["profileEnabled", "profile_enabled"],
    ["offerEnabled", "offer_enabled"],
    ["applicationEnabled", "application_enabled"],
    ["exportEnabled", "export_enabled"],
  ];
  const envShapeValid = new Set(["off", "admin_shadow"]).has(env.rolloutMode)
    && envFlags.every((name) => typeof env[name] === "boolean");
  const databaseShapeValid = database.id === 1
    && new Set(["off", "admin_shadow"]).has(database.rollout_mode)
    && dbFlagPairs.every(([, snake]) => new Set([0, 1]).has(database[snake]))
    && database.capability_registry_version === CABINET_CAPABILITY_REGISTRY_VERSION
    && database.tariff_capacity_version === CABINET_TARIFF_CAPACITY_VERSION
    && database.policy_version === CABINET_POLICY_VERSION
    && database.init_data_max_age_seconds === env.initDataMaxAgeSeconds
    && database.session_ttl_seconds === env.sessionTtlSeconds;
  const flagsAligned = envShapeValid && databaseShapeValid
    && dbFlagPairs.every(([camel, snake]) => Number(env[camel]) === database[snake]);
  const modeAligned = envShapeValid && databaseShapeValid
    && env.rolloutMode === database.rollout_mode;
  const hierarchyValid = envShapeValid && (
    (env.rolloutMode === "off" && !env.masterEnabled
      && envFlags.slice(1).every((name) => !env[name]))
    || (env.rolloutMode === "admin_shadow" && env.masterEnabled)
  );
  const configurationAligned = databaseShapeValid && flagsAligned
    && modeAligned && hierarchyValid;
  const open = configurationAligned && env.rolloutMode === "admin_shadow";
  return deepFreeze({
    gateVersion: 1,
    configurationAligned,
    rolloutMode: open ? "admin_shadow" : "off",
    masterEnabled: open,
    profileEnabled: open && env.profileEnabled,
    offerEnabled: open && env.offerEnabled,
    applicationEnabled: open && env.applicationEnabled,
    exportEnabled: open && env.exportEnabled,
    capabilityRegistryVersion: CABINET_CAPABILITY_REGISTRY_VERSION,
    tariffCapacityVersion: CABINET_TARIFF_CAPACITY_VERSION,
    policyVersion: CABINET_POLICY_VERSION,
    initDataMaxAgeSeconds: TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
    sessionTtlSeconds: CABINET_SESSION_TTL_SECONDS,
  });
}

const tokenBotId = (botToken) => {
  if (typeof botToken !== "string" || botToken.length > 128) {
    fail("invalid_bot_token");
  }
  const match = /^([1-9][0-9]*):([A-Za-z0-9_-]{20,})$/u.exec(botToken);
  if (!match) fail("invalid_bot_token");
  const botId = Number(match[1]);
  return positiveSafeInteger(botId, "invalid_bot_token");
};

const parseInitData = (initData) => {
  if (typeof initData !== "string" || initData.length < 16
      || initData.length > 8192) {
    fail("invalid_init_data");
  }
  const entries = [...new URLSearchParams(initData).entries()];
  if (entries.length < 3 || entries.length > 64) fail("invalid_init_data");
  const fields = new Map();
  for (const [key, value] of entries) {
    if (!SAFE_KEY.test(key) || fields.has(key)
        || /[\0\r\n]/u.test(value)) fail("invalid_init_data");
    fields.set(key, value);
  }
  for (const required of ["auth_date", "hash", "user"]) {
    if (!fields.has(required)) fail("invalid_init_data");
  }
  return fields;
};

export async function verifyTelegramMiniAppInitData({
  initData,
  botToken,
  expectedBotId,
  expectedTelegramId,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
  futureSkewSeconds = 60,
}) {
  const now = unixSeconds(nowSeconds);
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 60
      || maxAgeSeconds > 900) {
    fail("invalid_ttl");
  }
  if (!Number.isSafeInteger(futureSkewSeconds) || futureSkewSeconds < 0
      || futureSkewSeconds > 60) {
    fail("invalid_ttl");
  }
  const botId = tokenBotId(botToken);
  const boundBotId = expectedBotId === undefined
    ? botId
    : positiveSafeInteger(expectedBotId, "bot_mismatch");
  if (boundBotId !== botId) fail("bot_mismatch");

  const fields = parseInitData(initData);
  const providedHash = hexToBytes(fields.get("hash"));
  const dataCheckString = [...fields.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => compareKeys(left, right))
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
  if (!constantTimeEqual(providedHash, expectedHash)) fail("forged_init_data");

  const authDateText = fields.get("auth_date");
  if (!/^[1-9][0-9]{8,12}$/u.test(authDateText)) fail("invalid_auth_date");
  const authDate = Number(authDateText);
  unixSeconds(authDate, "invalid_auth_date");
  if (authDate > now + futureSkewSeconds) fail("future_init_data");
  if (now - authDate > maxAgeSeconds) fail("stale_init_data");

  let user;
  try {
    user = asRecord(JSON.parse(fields.get("user")), "invalid_user");
  } catch (error) {
    if (error instanceof CabinetSecurityError) throw error;
    fail("invalid_user");
  }
  const telegramId = positiveSafeInteger(user.id, "invalid_user");
  if (user.is_bot === true) fail("invalid_user");
  if (expectedTelegramId !== undefined
      && positiveSafeInteger(expectedTelegramId, "identity_mismatch")
        !== telegramId) {
    fail("identity_mismatch");
  }

  const initDataHash = await sha256Hex(
    `telegram-init-data-v1\n${dataCheckString}\nhash=${fields.get("hash")}`,
  );
  const queryIdHash = fields.has("query_id")
    ? await sha256Hex(fields.get("query_id"))
    : null;
  return deepFreeze({
    verificationVersion: 1,
    botId,
    telegramId,
    authDate,
    authenticatedAt: now,
    expiresAt: authDate + maxAgeSeconds,
    initDataHash,
    queryIdHash,
  });
}

export async function createCabinetSessionEnvelope({
  authentication,
  nowSeconds = Math.floor(Date.now() / 1000),
  ttlSeconds = CABINET_SESSION_TTL_SECONDS,
  retentionSeconds = 2_592_000,
  randomBytes,
}) {
  const auth = asRecord(authentication, "invalid_authentication");
  const now = unixSeconds(nowSeconds);
  if (auth.verificationVersion !== 1 || !HEX_64.test(auth.initDataHash)
      || !Number.isSafeInteger(auth.botId)
      || !Number.isSafeInteger(auth.telegramId)
      || !Number.isSafeInteger(auth.authDate)
      || !Number.isSafeInteger(auth.expiresAt)) {
    fail("invalid_authentication");
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 900) {
    fail("invalid_ttl");
  }
  if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < ttlSeconds
      || retentionSeconds > CABINET_TECHNICAL_RETENTION_SECONDS) {
    fail("invalid_retention");
  }
  const expiresAt = Math.min(now + ttlSeconds, auth.expiresAt);
  if (expiresAt <= now) fail("stale_init_data");

  const tokenEntropy = takeRandomBytes(32, randomBytes);
  const sessionToken = `cbs1_${base64Url(tokenEntropy)}`;
  const sessionTokenHash = await sha256Hex(sessionToken);
  const sessionId = `ses_${await sha256Hex(`session:${sessionToken}`)}`;
  const receiptId = `idr_${auth.initDataHash}`;
  const idempotencyKey = `key_${await sha256Hex(
    `init-data:${auth.botId}:${auth.initDataHash}`,
  )}`;
  const retentionUntil = now + retentionSeconds;

  return deepFreeze({
    sessionToken,
    receipt: {
      receiptId,
      initDataHash: auth.initDataHash,
      botId: auth.botId,
      telegramId: auth.telegramId,
      queryIdHash: auth.queryIdHash ?? null,
      authDate: auth.authDate,
      receivedAt: now,
      expiresAt: auth.expiresAt,
      idempotencyKey,
      retentionUntil,
    },
    session: {
      sessionId,
      sessionTokenHash,
      receiptId,
      telegramId: auth.telegramId,
      botId: auth.botId,
      tokenVersion: 1,
      issuedAt: now,
      expiresAt,
      retentionUntil,
    },
  });
}

export async function createOpaqueId(prefix, randomBytes) {
  if (!new Set(["res_", "cgr_", "crv_", "spe_", "aud_"]).has(prefix)) {
    fail("invalid_id_prefix");
  }
  return `${prefix}${bytesToHex(takeRandomBytes(32, randomBytes))}`;
}

export async function deriveIdempotencyKey({ secret, operation, rawKey }) {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 512) {
    fail("invalid_idempotency_secret");
  }
  if (typeof operation !== "string" || !IDEMPOTENCY_OPERATION.test(operation)) {
    fail("invalid_idempotency_operation");
  }
  if (typeof rawKey !== "string" || rawKey.length < 8 || rawKey.length > 256) {
    fail("invalid_idempotency_key");
  }
  const digest = await hmacSha256(
    encoder.encode(secret),
    encoder.encode(`${operation}\n${rawKey}`),
  );
  return `key_${bytesToHex(digest)}`;
}

const field = (record, camel, snake) => record?.[camel] ?? record?.[snake];

export function buildCabinetProfileProjection({
  user,
  roleRows = [],
  partnerProfile = null,
  legalProfile = "unknown",
  planCode = "free",
  accessState = "none",
  specialization = null,
}) {
  const authorityUser = asRecord(user, "invalid_user_authority");
  const telegramId = positiveSafeInteger(
    field(authorityUser, "telegramId", "telegram_id"),
    "invalid_user_authority",
  );
  const blocked = field(authorityUser, "isBlocked", "is_blocked") === true
    || field(authorityUser, "isBlocked", "is_blocked") === 1;
  if (!Array.isArray(roleRows)) fail("invalid_role_authority");
  const activeRoles = new Set();
  for (const rowValue of roleRows) {
    const row = asRecord(rowValue, "invalid_role_authority");
    if (row.status !== "active") continue;
    if (!ROLE_SET.has(row.role)) fail("invalid_role_authority");
    activeRoles.add(row.role);
  }

  let activePartner = null;
  if (partnerProfile !== null && partnerProfile !== undefined) {
    const profile = asRecord(partnerProfile, "invalid_partner_authority");
    const profileId = positiveSafeInteger(
      field(profile, "id", "id"),
      "invalid_partner_authority",
    );
    const profileTelegramId = positiveSafeInteger(
      field(profile, "telegramId", "telegram_id"),
      "invalid_partner_authority",
    );
    if (profileTelegramId !== telegramId || profile.status !== "active") {
      fail("partner_authority_mismatch");
    }
    activePartner = { id: profileId, telegramId: profileTelegramId };
  }
  if (activeRoles.has("partner") !== Boolean(activePartner)) {
    fail("partner_authority_mismatch");
  }
  if (!LEGAL_PROFILE_SET.has(legalProfile)) fail("invalid_legal_profile");
  if (!PLAN_SET.has(planCode)) fail("invalid_plan");
  if (!ACCESS_STATES.has(accessState)) fail("invalid_access_state");
  if (specialization !== null && !SPECIALIZATION_SET.has(specialization)) {
    fail("invalid_specialization");
  }
  if (specialization !== null && !activePartner) {
    fail("specialization_requires_partner");
  }

  const systemRole = activeRoles.has("admin")
    ? "admin"
    : activePartner
      ? "partner"
      : "user";
  return deepFreeze({
    projectionVersion: 1,
    telegramId,
    systemRole,
    partnerProfileId: activePartner?.id ?? null,
    specialization: specialization ?? "none",
    legalProfile,
    planCode,
    accessState,
    active: !blocked,
  });
}

const normalizeSettings = (value) => {
  const settings = value && typeof value === "object" ? value : {};
  const enabled = (camel, snake) => field(settings, camel, snake) === true
    || field(settings, camel, snake) === 1;
  return {
    gateVersion: settings.gateVersion,
    configurationAligned: settings.configurationAligned === true,
    rolloutMode: field(settings, "rolloutMode", "rollout_mode") ?? "off",
    masterEnabled: enabled("masterEnabled", "master_enabled"),
    profileEnabled: enabled("profileEnabled", "profile_enabled"),
    offerEnabled: enabled("offerEnabled", "offer_enabled"),
    applicationEnabled: enabled(
      "applicationEnabled",
      "application_enabled",
    ),
    exportEnabled: enabled("exportEnabled", "export_enabled"),
  };
};

const featureEnabled = (settings, feature) => settings.rolloutMode === "admin_shadow"
  && settings.gateVersion === 1 && settings.configurationAligned
  && settings.masterEnabled && settings[`${feature}Enabled`] === true;

const normalizeActor = (value) => {
  if (!value || typeof value !== "object") return null;
  const telegramId = field(value, "telegramId", "telegram_id");
  const systemRole = field(value, "systemRole", "system_role");
  const partnerProfileId = field(
    value,
    "partnerProfileId",
    "partner_profile_id",
  );
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0
      || !ROLE_SET.has(systemRole) || value.active === false
      || (partnerProfileId !== null && partnerProfileId !== undefined
        && (!Number.isSafeInteger(partnerProfileId) || partnerProfileId <= 0))) {
    return null;
  }
  if (systemRole === "partner" && !Number.isSafeInteger(partnerProfileId)) {
    return null;
  }
  return { telegramId, systemRole, partnerProfileId: partnerProfileId ?? null };
};

const normalizeResource = (value, expectedKind) => {
  if (!value || typeof value !== "object") return null;
  const resourceId = field(value, "resourceId", "resource_id");
  const resourceKind = field(value, "resourceKind", "resource_kind");
  const ownerTelegramId = field(
    value,
    "ownerTelegramId",
    "owner_telegram_id",
  );
  const ownerPartnerProfileId = field(
    value,
    "ownerPartnerProfileId",
    "owner_partner_profile_id",
  );
  const visibility = value.visibility;
  const visibilityAuthority = field(
    value,
    "visibilityAuthority",
    "visibility_authority",
  );
  if (!RESOURCE_ID.test(resourceId) || resourceKind !== expectedKind
      || !new Set(["private", "public", "admin"]).has(visibility)
      || visibilityAuthority !== "database"
      || (ownerTelegramId !== null && ownerTelegramId !== undefined
        && (!Number.isSafeInteger(ownerTelegramId) || ownerTelegramId <= 0))
      || (ownerPartnerProfileId !== null && ownerPartnerProfileId !== undefined
        && (!Number.isSafeInteger(ownerPartnerProfileId)
          || ownerPartnerProfileId <= 0))) {
    return null;
  }
  return {
    resourceId,
    resourceKind,
    ownerTelegramId: ownerTelegramId ?? null,
    ownerPartnerProfileId: ownerPartnerProfileId ?? null,
    visibility,
    visibilityAuthority,
  };
};

const scopeMatches = (scope, actor, resource) => {
  const self = resource.ownerTelegramId === actor.telegramId;
  const partnerOwner = Number.isSafeInteger(actor.partnerProfileId)
    && resource.ownerPartnerProfileId === actor.partnerProfileId
    && self;
  if (scope === "global") return true;
  if (scope === "self") return self;
  if (scope === "public") return resource.visibility === "public";
  if (scope === "partner_owner") return partnerOwner;
  if (scope === "public_or_partner_owner") {
    return resource.visibility === "public" || partnerOwner;
  }
  return false;
};

const grantMatches = (grant, actor, capability, resource, now, revoked) => {
  if (!grant || typeof grant !== "object") return false;
  const grantId = field(grant, "grantId", "grant_id");
  const actorTelegramId = field(
    grant,
    "actorTelegramId",
    "actor_telegram_id",
  );
  const capabilityCode = field(
    grant,
    "capabilityCode",
    "capability_code",
  );
  const startsAt = field(grant, "startsAt", "starts_at");
  const expiresAt = field(grant, "expiresAt", "expires_at");
  const scopeRule = field(grant, "scopeRule", "scope_rule");
  const resourceId = field(grant, "resourceId", "resource_id");
  if (!GRANT_ID.test(grantId) || revoked.has(grantId)
      || actorTelegramId !== actor.telegramId || capabilityCode !== capability
      || !Number.isSafeInteger(startsAt) || startsAt > now
      || (expiresAt !== null && expiresAt !== undefined
        && (!Number.isSafeInteger(expiresAt) || expiresAt <= now))) {
    return false;
  }
  if (scopeRule === "resource") return resourceId === resource.resourceId;
  if (scopeRule === "global") return true;
  return scopeMatches(scopeRule, actor, resource);
};

const decision = (allowed, reason, capability, resource, scopeRule = "none") =>
  deepFreeze({
    allowed,
    decision: allowed ? "allow" : "deny",
    reason,
    capability,
    resourceKind: resource?.resourceKind ?? "unknown",
    resourceId: resource?.resourceId ?? null,
    scopeRule,
  });

export function evaluateCabinetCapability({
  settings,
  actor,
  capability,
  resource,
  grants = [],
  revokedGrantIds = [],
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const metadata = CABINET_CAPABILITIES[capability];
  if (!metadata) return decision(false, "unknown_capability", capability, null);
  const normalizedSettings = normalizeSettings(settings);
  if (!featureEnabled(normalizedSettings, metadata.feature)) {
    return decision(false, "feature_off", capability, null);
  }
  const normalizedActor = normalizeActor(actor);
  if (!normalizedActor) return decision(false, "invalid_actor", capability, null);
  const normalizedResource = normalizeResource(resource, metadata.resourceKind);
  if (!normalizedResource) {
    return decision(false, "invalid_resource", capability, null);
  }
  const matrixEntry = CABINET_ROLE_MATRIX[capability]?.[
    normalizedActor.systemRole
  ];
  if (!matrixEntry || matrixEntry[0] !== "allow") {
    return decision(
      false,
      "role_denied",
      capability,
      normalizedResource,
      matrixEntry?.[1] ?? "none",
    );
  }
  if (!Array.isArray(grants) || !Array.isArray(revokedGrantIds)) {
    return decision(false, "invalid_actor", capability, normalizedResource);
  }
  const now = unixSeconds(nowSeconds);
  const revoked = new Set(revokedGrantIds.filter((id) => GRANT_ID.test(id)));
  const matching = grants.filter((grant) => grantMatches(
    grant,
    normalizedActor,
    capability,
    normalizedResource,
    now,
    revoked,
  ));
  if (matching.some((grant) => grant.effect === "deny")) {
    return decision(
      false,
      "explicit_deny",
      capability,
      normalizedResource,
      matrixEntry[1],
    );
  }
  if (scopeMatches(matrixEntry[1], normalizedActor, normalizedResource)) {
    return decision(
      true,
      "baseline_allow",
      capability,
      normalizedResource,
      matrixEntry[1],
    );
  }
  if (matching.some((grant) => grant.effect === "allow")) {
    return decision(
      true,
      "grant_allow",
      capability,
      normalizedResource,
      "resource",
    );
  }
  return decision(
    false,
    "scope_denied",
    capability,
    normalizedResource,
    matrixEntry[1],
  );
}

export function scaleDragonReference({
  dragonReference,
  capacityPercent,
  safeMinimum = 1,
  enabled = true,
}) {
  if (!Number.isSafeInteger(dragonReference) || dragonReference < 0
      || !new Set([10, 50, 100]).has(capacityPercent)
      || !Number.isSafeInteger(safeMinimum) || safeMinimum < 0) {
    fail("invalid_quota_formula");
  }
  if (!enabled) return 0;
  return Math.max(
    safeMinimum,
    Math.floor(dragonReference * capacityPercent / 100),
  );
}

export function resolveCabinetQuota({
  planCode,
  quotaCode,
  used = 0,
  resetsAt = null,
}) {
  if (!PLAN_SET.has(planCode)) fail("invalid_plan");
  const quota = CABINET_PLAN_QUOTAS[quotaCode];
  if (!quota) fail("invalid_quota");
  if (!Number.isSafeInteger(used) || used < 0) fail("invalid_quota_usage");
  if (resetsAt !== null && (!Number.isSafeInteger(resetsAt) || resetsAt <= 0)) {
    fail("invalid_quota_reset");
  }
  const limit = quota[planCode];
  return deepFreeze({
    planCode,
    capacityPercent: TARIFF_CAPACITY_PERCENT[planCode],
    quotaCode,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetsAt: quota.windowKind === "utc_day" ? resetsAt : null,
    windowKind: quota.windowKind,
    sourceKind: quota.sourceKind,
  });
}

export async function buildAuthorizationAuditRecord({
  decision: authorizationDecision,
  actor,
  resource,
  sourceKind,
  rawIdempotencyKey,
  idempotencySecret,
  request = {},
  before = {},
  after = {},
  nowSeconds = Math.floor(Date.now() / 1000),
  retentionSeconds = CABINET_TECHNICAL_RETENTION_SECONDS,
}) {
  const authorization = asRecord(
    authorizationDecision,
    "invalid_authorization_decision",
  );
  if (typeof authorization.allowed !== "boolean"
      || typeof authorization.capability !== "string"
      || !SAFE_CAPABILITY.test(authorization.capability)
      || !AUDIT_REASONS.has(authorization.reason)
      || (authorization.allowed
        && !new Set(["baseline_allow", "grant_allow"]).has(authorization.reason))
      || (!authorization.allowed
        && new Set(["baseline_allow", "grant_allow"]).has(authorization.reason))) {
    fail("invalid_authorization_decision");
  }
  const normalizedActor = normalizeActor(actor);
  if (!normalizedActor) fail("invalid_actor");
  if (!new Set(["mini_app", "worker", "admin", "system"]).has(sourceKind)) {
    fail("invalid_audit_source");
  }
  const now = unixSeconds(nowSeconds);
  if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < 1
      || retentionSeconds > CABINET_TECHNICAL_RETENTION_SECONDS) {
    fail("invalid_retention");
  }
  const idempotencyKey = await deriveIdempotencyKey({
    secret: idempotencySecret,
    operation: `authorization.${authorization.capability}`,
    rawKey: rawIdempotencyKey,
  });
  const auditId = `aud_${await sha256Hex(`audit:${idempotencyKey}`)}`;
  const requestHash = await sha256Hex(stableJson(request));
  const beforeHash = await sha256Hex(stableJson(before));
  const afterHash = await sha256Hex(stableJson(after));
  const resourceKind = authorization.resourceKind ?? resource?.resourceKind
    ?? "unknown";
  const resourceId = authorization.resourceId ?? resource?.resourceId ?? null;
  if (!new Set(["profile", "offer", "application", "export", "unknown"])
    .has(resourceKind) || (resourceId !== null && !RESOURCE_ID.test(resourceId))) {
    fail("invalid_authorization_decision");
  }
  return deepFreeze({
    auditId,
    actorTelegramId: normalizedActor.telegramId,
    actorRole: normalizedActor.systemRole,
    requestedCapability: authorization.capability,
    resourceKind,
    resourceId,
    decision: authorization.allowed ? "allow" : "deny",
    reasonCode: authorization.reason,
    sourceKind,
    requestHash,
    beforeHash,
    afterHash,
    idempotencyKey,
    occurredAt: now,
    retentionUntil: now + retentionSeconds,
  });
}
