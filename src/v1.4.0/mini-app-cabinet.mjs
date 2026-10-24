import {
  CABINET_PLAN_QUOTAS,
  TARIFF_CAPACITY_PERCENT,
  buildCabinetProfileProjection,
  sha256Hex,
} from "./cabinet-foundation.mjs";
import { buildOfferPreview } from "./offers-and-promotions.mjs";
import {
  projectApplicationForActor,
} from "./applications-crm.mjs";
import { projectCabinetAccessSummary } from "./access-and-e2e.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

export const MINI_APP_POLICY_VERSION =
  "2026-09-14.cabinet-v1-part5";
export const MINI_APP_SHELL_VERSION = 1;
export const MINI_APP_ROUTE_REGISTRY_VERSION = 1;
export const MINI_APP_PAGE_SIZE = 10;
export const MINI_APP_PAGE_SIZE_MAX = 20;
export const MINI_APP_CURSOR_TTL_SECONDS = 300;
export const MINI_APP_RECOVERY_MAX_AGE_SECONDS = 900;

export const CABINET_MINI_APP_ROUTES = deepFreeze({
  "bootstrap.read": {
    method: "GET",
    path: "/api/v1.4.0/cabinet/bootstrap",
    screen: "home",
    capability: "profile.read",
    recoverySafe: true,
  },
  "profile.read": {
    method: "GET",
    path: "/api/v1.4.0/cabinet/profile",
    screen: "profile",
    capability: "profile.read",
    recoverySafe: true,
  },
  "offers.list": {
    method: "GET",
    path: "/api/v1.4.0/cabinet/offers",
    screen: "offers",
    capability: "offer.read",
    recoverySafe: true,
  },
  "applications.list": {
    method: "GET",
    path: "/api/v1.4.0/cabinet/applications",
    screen: "applications",
    capability: "application.read",
    recoverySafe: true,
  },
  "results.list": {
    method: "GET",
    path: "/api/v1.4.0/cabinet/results",
    screen: "results",
    capability: "application.read",
    recoverySafe: true,
  },
  "applications.detail": {
    method: "GET",
    path: "/api/v1.4.0/cabinet/applications/:application_id",
    screen: "application_detail",
    capability: "application.read",
    recoverySafe: false,
  },
});

export const CABINET_MINI_APP_SECURITY_HEADERS = deepFreeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self' https://telegram.org",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-ancestors https://web.telegram.org https://*.telegram.org",
  ].join("; "),
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

const HEX_64 = /^[0-9a-f]{64}$/u;
const SESSION_ID = /^ses_[0-9a-f]{64}$/u;
const SESSION_TOKEN = /^cbs1_[A-Za-z0-9_-]{43}$/u;
const APPLICATION_ID = /^app_[0-9a-f]{64}$/u;
const OFFER_CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/u;
const CURSOR_KEY = /^[a-z0-9_:-]{1,96}$/u;
const PAGINATED_ROUTES = new Set([
  "offers.list", "applications.list", "results.list",
]);
const SCREEN_FLAG = {
  home: "profileScreenEnabled",
  profile: "profileScreenEnabled",
  offers: "offersScreenEnabled",
  applications: "applicationsScreenEnabled",
  results: "resultsScreenEnabled",
  application_detail: "applicationsScreenEnabled",
};
const CLIENT_AUTHORITY_FIELDS = new Set([
  "telegramId", "telegram_id", "userId", "user_id", "role",
  "systemRole", "system_role", "partnerProfileId", "partner_profile_id",
  "ownerTelegramId", "owner_telegram_id", "ownerPartnerProfileId",
  "owner_partner_profile_id", "plan", "planCode", "plan_code", "quota",
  "capacity", "access", "accessState", "access_state", "capability",
  "grants", "authority", "authoritySource", "authority_source",
  "visibility", "moderationStatus", "moderation_status", "resultCode",
  "result_code", "status", "revision", "actionsEnabled",
]);

export class MiniAppCabinetPolicyError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "MiniAppCabinetPolicyError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new MiniAppCabinetPolicyError(code, message);
};

const record = (value, code = "invalid_record") => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
};

const field = (value, camel, snake) => value && Object.hasOwn(value, camel)
  ? value[camel]
  : value?.[snake];

const databaseRecord = (value, code) => {
  const row = record(value, code);
  if (field(row, "authoritySource", "authority_source") !== "database") {
    fail(`untrusted_${code}`);
  }
  return row;
};

const positiveInteger = (value, code = "invalid_integer") => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
};

const nonNegativeInteger = (value, code = "invalid_integer") => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail(code);
  return number;
};

const exactText = (value, code, minimum = 1, maximum = 512) => {
  if (typeof value !== "string") fail(code);
  const text = value.trim();
  if (text.length < minimum || text.length > maximum) fail(code);
  return text;
};

const canonicalize = (value) => {
  if (value === null || typeof value === "string" ||
      typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_canonical_value");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      canonicalize(value[key]),
    ]));
  }
  fail("invalid_canonical_value");
};

export const stableMiniAppJson = (value) =>
  JSON.stringify(canonicalize(value));

const exactFlag = (value, code) => {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0" ||
      value === undefined || value === null || value === "") return false;
  fail(code);
};

export function readCabinetMiniAppRuntimeConfig(env = {}) {
  const rolloutMode = env.CABINET_MINI_APP_ROLLOUT_MODE ?? "off";
  if (!new Set(["off", "admin_shadow"]).has(rolloutMode)) {
    fail("invalid_rollout_mode");
  }
  const config = {
    authoritySource: "environment",
    rolloutMode,
    masterEnabled: exactFlag(
      env.CABINET_MINI_APP_MASTER_ENABLED,
      "invalid_master_flag",
    ),
    shellEnabled: exactFlag(
      env.CABINET_MINI_APP_SHELL_ENABLED,
      "invalid_shell_flag",
    ),
    profileScreenEnabled: exactFlag(
      env.CABINET_MINI_APP_PROFILE_ENABLED,
      "invalid_profile_flag",
    ),
    offersScreenEnabled: exactFlag(
      env.CABINET_MINI_APP_OFFERS_ENABLED,
      "invalid_offers_flag",
    ),
    applicationsScreenEnabled: exactFlag(
      env.CABINET_MINI_APP_APPLICATIONS_ENABLED,
      "invalid_applications_flag",
    ),
    resultsScreenEnabled: exactFlag(
      env.CABINET_MINI_APP_RESULTS_ENABLED,
      "invalid_results_flag",
    ),
    readOnlyRecoveryEnabled: exactFlag(
      env.CABINET_MINI_APP_RECOVERY_ENABLED,
      "invalid_recovery_flag",
    ),
    policyVersion: MINI_APP_POLICY_VERSION,
    shellVersion: MINI_APP_SHELL_VERSION,
    routeRegistryVersion: MINI_APP_ROUTE_REGISTRY_VERSION,
    pageSize: MINI_APP_PAGE_SIZE,
    cursorTtlSeconds: MINI_APP_CURSOR_TTL_SECONDS,
    recoveryMaxAgeSeconds: MINI_APP_RECOVERY_MAX_AGE_SECONDS,
  };
  const children = [
    config.shellEnabled,
    config.profileScreenEnabled,
    config.offersScreenEnabled,
    config.applicationsScreenEnabled,
    config.resultsScreenEnabled,
    config.readOnlyRecoveryEnabled,
  ];
  if ((!config.masterEnabled && children.some(Boolean)) ||
      (!config.shellEnabled && children.slice(1).some(Boolean)) ||
      (config.masterEnabled && rolloutMode !== "admin_shadow") ||
      (!config.masterEnabled && rolloutMode !== "off")) {
    fail("invalid_config_hierarchy");
  }
  return deepFreeze(config);
}

const enabled = (value, camel, snake) =>
  field(value, camel, snake) === true || field(value, camel, snake) === 1;

const parentGatesOpen = (parentsValue) => {
  const parents = record(parentsValue, "invalid_parent_settings");
  const foundation = databaseRecord(parents.foundation, "foundation_settings");
  const offers = databaseRecord(parents.offers, "offer_settings");
  const applications = databaseRecord(
    parents.applications,
    "application_settings",
  );
  const access = databaseRecord(parents.access, "access_settings");
  return field(foundation, "rolloutMode", "rollout_mode") === "admin_shadow" &&
    enabled(foundation, "masterEnabled", "master_enabled") &&
    enabled(foundation, "profileEnabled", "profile_enabled") &&
    enabled(foundation, "offerEnabled", "offer_enabled") &&
    enabled(foundation, "applicationEnabled", "application_enabled") &&
    enabled(offers, "enabled", "enabled") &&
    enabled(offers, "lifecycleEnabled", "lifecycle_enabled") &&
    enabled(offers, "previewEnabled", "preview_enabled") &&
    enabled(applications, "enabled", "enabled") &&
    enabled(applications, "lifecycleEnabled", "lifecycle_enabled") &&
    enabled(applications, "crmEnabled", "crm_enabled") &&
    enabled(applications, "contactsEnabled", "contacts_enabled") &&
    enabled(applications, "notesEnabled", "notes_enabled") &&
    enabled(applications, "assignmentEnabled", "assignment_enabled") &&
    enabled(applications, "resultEnabled", "result_enabled") &&
    field(access, "rolloutMode", "rollout_mode") === "admin_shadow" &&
    enabled(access, "masterEnabled", "master_enabled") &&
    enabled(access, "accessProjectionEnabled", "access_projection_enabled") &&
    enabled(access, "applicationBindingEnabled", "application_binding_enabled") &&
    enabled(access, "analyticsBridgeEnabled", "analytics_bridge_enabled");
};

export function resolveCabinetMiniAppGate({
  environment,
  database: databaseValue,
  parentSettings,
}) {
  const env = record(environment, "invalid_environment_config");
  const database = databaseRecord(databaseValue, "mini_app_settings");
  const pairs = [
    ["rolloutMode", "rollout_mode"],
    ["masterEnabled", "master_enabled"],
    ["shellEnabled", "shell_enabled"],
    ["profileScreenEnabled", "profile_screen_enabled"],
    ["offersScreenEnabled", "offers_screen_enabled"],
    ["applicationsScreenEnabled", "applications_screen_enabled"],
    ["resultsScreenEnabled", "results_screen_enabled"],
    ["readOnlyRecoveryEnabled", "read_only_recovery_enabled"],
    ["policyVersion", "policy_version"],
    ["shellVersion", "shell_version"],
    ["routeRegistryVersion", "route_registry_version"],
    ["pageSize", "page_size"],
    ["cursorTtlSeconds", "cursor_ttl_seconds"],
    ["recoveryMaxAgeSeconds", "recovery_max_age_seconds"],
  ];
  const aligned = pairs.every(([camel, snake]) => {
    const databaseValueForKey = field(database, camel, snake);
    if (typeof env[camel] === "boolean") {
      return env[camel] === enabled(database, camel, snake);
    }
    return env[camel] === databaseValueForKey;
  });
  let parentsOpen = false;
  try {
    parentsOpen = parentGatesOpen(parentSettings);
  } catch {
    parentsOpen = false;
  }
  const open = aligned && parentsOpen && env.rolloutMode === "admin_shadow" &&
    env.masterEnabled === true && env.shellEnabled === true;
  return deepFreeze({
    gateVersion: 1,
    configurationAligned: aligned && parentsOpen,
    rolloutMode: open ? "admin_shadow" : "off",
    masterEnabled: open,
    shellEnabled: open,
    profileScreenEnabled: open && env.profileScreenEnabled,
    offersScreenEnabled: open && env.offersScreenEnabled,
    applicationsScreenEnabled: open && env.applicationsScreenEnabled,
    resultsScreenEnabled: open && env.resultsScreenEnabled,
    readOnlyRecoveryEnabled: open && env.readOnlyRecoveryEnabled,
    pageSize: MINI_APP_PAGE_SIZE,
    cursorTtlSeconds: MINI_APP_CURSOR_TTL_SECONDS,
    recoveryMaxAgeSeconds: MINI_APP_RECOVERY_MAX_AGE_SECONDS,
    reason: open ? "aligned_admin_shadow" : "feature_off",
  });
}

const constantTimeHexEqual = (left, right) => {
  if (!HEX_64.test(left) || !HEX_64.test(right)) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
};

const normalizePartnerActor = (value) => {
  const actor = record(value, "invalid_actor");
  const telegramId = positiveInteger(
    field(actor, "telegramId", "telegram_id"),
    "invalid_actor",
  );
  const partnerProfileId = positiveInteger(
    field(actor, "partnerProfileId", "partner_profile_id"),
    "invalid_actor",
  );
  if (field(actor, "systemRole", "system_role") !== "partner" ||
      actor.active !== true) fail("partner_role_required");
  return { telegramId, partnerProfileId, systemRole: "partner", active: true };
};

export async function verifyCabinetMiniAppSession({
  gate,
  session: sessionValue,
  sessionToken,
  actor: actorValue,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const settings = record(gate, "invalid_gate");
  if (settings.configurationAligned !== true ||
      settings.rolloutMode !== "admin_shadow" ||
      settings.masterEnabled !== true || settings.shellEnabled !== true) {
    fail("feature_off");
  }
  const session = databaseRecord(sessionValue, "session");
  const actor = normalizePartnerActor(actorValue);
  const now = positiveInteger(nowSeconds, "invalid_time");
  const sessionId = field(session, "sessionId", "session_id");
  const tokenHash = field(session, "sessionTokenHash", "session_token_hash");
  const telegramId = positiveInteger(
    field(session, "telegramId", "telegram_id"),
    "invalid_session",
  );
  const tokenVersion = positiveInteger(
    field(session, "tokenVersion", "token_version"),
    "invalid_session",
  );
  const issuedAt = positiveInteger(
    field(session, "issuedAt", "issued_at"),
    "invalid_session",
  );
  const expiresAt = positiveInteger(
    field(session, "expiresAt", "expires_at"),
    "invalid_session",
  );
  if (!SESSION_ID.test(sessionId) || !HEX_64.test(tokenHash) ||
      !SESSION_TOKEN.test(sessionToken) || tokenVersion !== 1 ||
      telegramId !== actor.telegramId || issuedAt > now || expiresAt <= now ||
      expiresAt > issuedAt + 900) fail("invalid_session");
  const actualHash = await sha256Hex(sessionToken);
  if (!constantTimeHexEqual(actualHash, tokenHash)) fail("invalid_session");
  return deepFreeze({
    contextVersion: 1,
    authoritySource: "database",
    sessionId,
    actor,
    ownerPartnerProfileId: actor.partnerProfileId,
    screenFlags: {
      profile: settings.profileScreenEnabled === true,
      offers: settings.offersScreenEnabled === true,
      applications: settings.applicationsScreenEnabled === true,
      results: settings.resultsScreenEnabled === true,
    },
    pageSize: settings.pageSize,
    cursorTtlSeconds: settings.cursorTtlSeconds,
    recoveryEnabled: settings.readOnlyRecoveryEnabled === true,
    recoveryMaxAgeSeconds: settings.recoveryMaxAgeSeconds,
    expiresAt,
    actionsEnabled: false,
  });
}

export function assertCabinetMiniAppClientPayload(payload = {}) {
  const root = record(payload, "invalid_client_payload");
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (CLIENT_AUTHORITY_FIELDS.has(key)) {
        fail(
          "client_authority_field_forbidden",
          `client_authority_field_forbidden:${key}`,
        );
      }
      visit(child);
    }
  };
  visit(root);
  return true;
}

export function resolveCabinetMiniAppRoute({ method, url }) {
  if (method !== "GET") fail("method_not_allowed");
  let parsed;
  try {
    parsed = new URL(url, "https://cabinet.invalid");
  } catch {
    fail("invalid_route");
  }
  let routeCode = null;
  let applicationId = null;
  for (const [code, route] of Object.entries(CABINET_MINI_APP_ROUTES)) {
    if (route.path === parsed.pathname) routeCode = code;
  }
  if (!routeCode) {
    const match = parsed.pathname.match(
      /^\/api\/v1\.4\.0\/cabinet\/applications\/(app_[0-9a-f]{64})$/u,
    );
    if (match) {
      routeCode = "applications.detail";
      applicationId = match[1];
    }
  }
  if (!routeCode) fail("route_not_found");
  const keys = [...parsed.searchParams.keys()];
  const allowsCursor = PAGINATED_ROUTES.has(routeCode);
  if (keys.some((key) => key !== "cursor") ||
      (!allowsCursor && keys.length > 0) ||
      parsed.searchParams.getAll("cursor").length > 1) {
    fail("invalid_query");
  }
  const cursor = parsed.searchParams.get("cursor");
  if (cursor !== null && (cursor.length < 32 || cursor.length > 2_048)) {
    fail("invalid_cursor");
  }
  return deepFreeze({
    routeCode,
    ...CABINET_MINI_APP_ROUTES[routeCode],
    applicationId,
    cursor,
  });
}

const bytesToBase64Url = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_")
    .replace(/=+$/gu, "");
};

const base64UrlToBytes = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    fail("invalid_cursor");
  }
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  let binary;
  try {
    binary = atob(padded);
  } catch {
    fail("invalid_cursor");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const hmacHex = async (secret, message) => {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 512) {
    fail("invalid_cursor_secret");
  }
  if (!globalThis.crypto?.subtle) fail("web_crypto_required");
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const requireContext = (value, screen) => {
  const context = record(value, "invalid_context");
  if (context.contextVersion !== 1 || context.authoritySource !== "database" ||
      !SESSION_ID.test(context.sessionId) || context.actionsEnabled !== false) {
    fail("invalid_context");
  }
  const actor = normalizePartnerActor(context.actor);
  if (context.ownerPartnerProfileId !== actor.partnerProfileId ||
      !Number.isSafeInteger(context.pageSize) || context.pageSize < 5 ||
      context.pageSize > MINI_APP_PAGE_SIZE_MAX ||
      context.screenFlags?.[SCREEN_FLAG[screen]?.replace("ScreenEnabled", "")] === false) {
    fail("invalid_context");
  }
  const flag = SCREEN_FLAG[screen];
  if (flag) {
    const key = flag.replace("ScreenEnabled", "");
    if (context.screenFlags?.[key] !== true) fail("screen_off");
  }
  return { context, actor };
};

export async function createCabinetMiniAppCursor({
  context: contextValue,
  routeCode,
  anchorTime,
  anchorKey,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const { context } = requireContext(
    contextValue,
    CABINET_MINI_APP_ROUTES[routeCode]?.screen,
  );
  if (!PAGINATED_ROUTES.has(routeCode) || !CURSOR_KEY.test(anchorKey)) {
    fail("invalid_cursor_anchor");
  }
  const now = positiveInteger(nowSeconds, "invalid_time");
  const payload = {
    version: 1,
    routeCode,
    sessionId: context.sessionId,
    ownerPartnerProfileId: context.ownerPartnerProfileId,
    anchorTime: positiveInteger(anchorTime, "invalid_cursor_anchor"),
    anchorKey,
    issuedAt: now,
    expiresAt: now + MINI_APP_CURSOR_TTL_SECONDS,
  };
  const encoded = bytesToBase64Url(encoder.encode(stableMiniAppJson(payload)));
  const signature = await hmacHex(
    secret,
    `cabinet-mini-app-cursor-v1\n${encoded}`,
  );
  return `cur1.${encoded}.${signature}`;
}

export async function verifyCabinetMiniAppCursor({
  context: contextValue,
  routeCode,
  cursor,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const { context } = requireContext(
    contextValue,
    CABINET_MINI_APP_ROUTES[routeCode]?.screen,
  );
  if (!PAGINATED_ROUTES.has(routeCode) || typeof cursor !== "string" ||
      cursor.length > 2_048) fail("invalid_cursor");
  const parts = cursor.split(".");
  if (parts.length !== 3 || parts[0] !== "cur1" || !HEX_64.test(parts[2])) {
    fail("invalid_cursor");
  }
  const expected = await hmacHex(
    secret,
    `cabinet-mini-app-cursor-v1\n${parts[1]}`,
  );
  if (!constantTimeHexEqual(parts[2], expected)) fail("invalid_cursor");
  let payload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlToBytes(parts[1])));
  } catch {
    fail("invalid_cursor");
  }
  const now = positiveInteger(nowSeconds, "invalid_time");
  const exactKeys = [
    "anchorKey", "anchorTime", "expiresAt", "issuedAt",
    "ownerPartnerProfileId", "routeCode", "sessionId", "version",
  ];
  if (Object.keys(record(payload, "invalid_cursor")).sort().join("|") !==
      exactKeys.sort().join("|") || payload.version !== 1 ||
      payload.routeCode !== routeCode ||
      payload.sessionId !== context.sessionId ||
      payload.ownerPartnerProfileId !== context.ownerPartnerProfileId ||
      !CURSOR_KEY.test(payload.anchorKey) ||
      !Number.isSafeInteger(payload.anchorTime) || payload.anchorTime <= 0 ||
      !Number.isSafeInteger(payload.issuedAt) || payload.issuedAt > now ||
      !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now ||
      payload.expiresAt !== payload.issuedAt + MINI_APP_CURSOR_TTL_SECONDS) {
    fail("invalid_cursor");
  }
  return deepFreeze({
    anchorTime: payload.anchorTime,
    anchorKey: payload.anchorKey,
  });
}

const assertOwnerRow = (value, actor, code = "cross_owner") => {
  const row = databaseRecord(value, "screen_row");
  if (positiveInteger(
    field(row, "ownerPartnerProfileId", "owner_partner_profile_id"),
    code,
  ) !== actor.partnerProfileId || positiveInteger(
    field(row, "ownerTelegramId", "owner_telegram_id"),
    code,
  ) !== actor.telegramId) fail(code);
  return row;
};

const recoveryMetadata = async (context, screen, generatedAt, safe) => ({
  eligible: safe && context.recoveryEnabled === true,
  maxAgeSeconds: context.recoveryMaxAgeSeconds,
  ownerBindingHash: await sha256Hex(
    `cabinet-owner:${context.sessionId}:${context.ownerPartnerProfileId}`,
  ),
  generatedAt,
  screen,
});

const normalizeCounts = (value, actor) => {
  const counts = assertOwnerRow(value, actor, "foreign_counts");
  return {
    offers: nonNegativeInteger(counts.offers, "invalid_counts"),
    activeApplications: nonNegativeInteger(
      field(counts, "activeApplications", "active_applications"),
      "invalid_counts",
    ),
    results: nonNegativeInteger(counts.results, "invalid_counts"),
  };
};

const profileModel = ({ context, actor, profileAuthority, accessResolution }) => {
  const authority = databaseRecord(
    profileAuthority,
    "profile_authority",
  );
  databaseRecord(authority.user, "profile_user_authority");
  if (!Array.isArray(authority.roleRows) || authority.roleRows.length === 0) {
    fail("invalid_profile_authority");
  }
  authority.roleRows.forEach((row) =>
    databaseRecord(row, "profile_role_authority"));
  databaseRecord(authority.partnerProfile, "partner_profile_authority");
  const profile = buildCabinetProfileProjection(authority);
  const accessRow = databaseRecord(accessResolution, "access_resolution");
  const accessSubject = positiveInteger(
    field(accessRow, "subjectTelegramId", "subject_telegram_id"),
    "invalid_access_resolution",
  );
  const access = projectCabinetAccessSummary(accessRow);
  if (profile.telegramId !== actor.telegramId ||
      profile.partnerProfileId !== actor.partnerProfileId ||
      profile.systemRole !== "partner" || profile.active !== true ||
      accessSubject !== actor.telegramId || profile.planCode !== access.planCode ||
      profile.accessState !== access.accessState ||
      TARIFF_CAPACITY_PERCENT[access.planCode] !== access.capacityPercent ||
      CABINET_PLAN_QUOTAS.active_applications[access.planCode] !==
        access.activeApplicationsLimit) fail("profile_authority_mismatch");
  return {
    role: "partner",
    specialization: profile.specialization,
    legalProfile: profile.legalProfile,
    planCode: access.planCode,
    accessState: access.accessState,
    capacityPercent: access.capacityPercent,
    activeApplicationsLimit: access.activeApplicationsLimit,
    dragonPreview: access.preview,
    accessExpiresAt: access.expiresAt,
  };
};

export async function projectCabinetMiniAppBootstrap({
  context: contextValue,
  profileAuthority,
  accessResolution,
  counts,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const { context, actor } = requireContext(contextValue, "home");
  const generatedAt = positiveInteger(nowSeconds, "invalid_time");
  const profile = profileModel({
    context,
    actor,
    profileAuthority,
    accessResolution,
  });
  return deepFreeze({
    contractVersion: 1,
    screen: "home",
    mode: "live",
    actionsEnabled: false,
    generatedAt,
    profile,
    counts: normalizeCounts(counts, actor),
    navigation: ["profile", "offers", "applications", "results"].filter(
      (screen) => context.screenFlags[screen] === true,
    ),
    recovery: await recoveryMetadata(context, "home", generatedAt, true),
  });
}

export async function projectCabinetMiniAppProfile({
  context: contextValue,
  profileAuthority,
  accessResolution,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const { context, actor } = requireContext(contextValue, "profile");
  const generatedAt = positiveInteger(nowSeconds, "invalid_time");
  return deepFreeze({
    contractVersion: 1,
    screen: "profile",
    mode: "live",
    actionsEnabled: false,
    generatedAt,
    profile: profileModel({
      context,
      actor,
      profileAuthority,
      accessResolution,
    }),
    recovery: await recoveryMetadata(
      context,
      "profile",
      generatedAt,
      true,
    ),
  });
}

const assertPage = (rows, pageSize) => {
  if (!Array.isArray(rows) || rows.length > pageSize + 1) fail("invalid_page");
};

const assertDescending = (items) => {
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    if (previous.sortTime < current.sortTime ||
        (previous.sortTime === current.sortTime &&
          previous.sortKey.localeCompare(current.sortKey) <= 0)) {
      fail("unstable_page_order");
    }
  }
};

const paginatedResponse = async ({
  context,
  screen,
  routeCode,
  items,
  cursorSecret,
  generatedAt,
}) => {
  assertDescending(items);
  const visible = items.slice(0, context.pageSize);
  let nextCursor = null;
  if (items.length > context.pageSize) {
    const anchor = visible.at(-1);
    nextCursor = await createCabinetMiniAppCursor({
      context,
      routeCode,
      anchorTime: anchor.sortTime,
      anchorKey: anchor.sortKey,
      secret: cursorSecret,
      nowSeconds: generatedAt,
    });
  }
  return deepFreeze({
    contractVersion: 1,
    screen,
    mode: "live",
    actionsEnabled: false,
    generatedAt,
    items: visible.map(({ sortTime, sortKey, ...item }) => item),
    nextCursor,
    recovery: await recoveryMetadata(context, screen, generatedAt, true),
  });
};

export async function projectCabinetMiniAppOffers({
  context: contextValue,
  offerSettings,
  entries,
  cursorSecret,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const { context, actor } = requireContext(contextValue, "offers");
  const generatedAt = positiveInteger(nowSeconds, "invalid_time");
  assertPage(entries, context.pageSize);
  const items = [];
  for (const entryValue of entries) {
    const entry = databaseRecord(entryValue, "offer_entry");
    assertOwnerRow(entry.authority, actor);
    const offerState = databaseRecord(entry.offerState, "offer_state");
    const version = databaseRecord(entry.version, "offer_version");
    const mediaRows = entry.mediaRows ?? [];
    if (!Array.isArray(mediaRows)) fail("invalid_offer_entry");
    mediaRows.forEach((row) => databaseRecord(row, "offer_media"));
    const offerCode = exactText(entry.offerCode, "invalid_offer_code", 2, 64);
    if (!OFFER_CODE.test(offerCode)) fail("invalid_offer_code");
    const preview = await buildOfferPreview({
      settings: offerSettings,
      actor: context.actor,
      audienceKind: "owner",
      planCode: "dragon",
      planSource: "database",
      offerCode,
      offerState,
      version,
      authority: entry.authority,
      mediaRows,
    });
    const sortTime = positiveInteger(entry.sortTime, "invalid_offer_entry");
    items.push({
      sortTime,
      sortKey: offerCode,
      offerCode,
      versionId: preview.versionId,
      title: preview.fields.title ?? offerCode,
      description: preview.fields.description ?? "",
      category: preview.fields.category ?? null,
      provider: preview.fields.provider ?? null,
      payoutText: preview.fields.payout_text ?? null,
      moderationStatus: field(
        offerState,
        "moderationStatus",
        "moderation_status",
      ),
      visibility: offerState.visibility,
      mediaCount: preview.media.length,
    });
  }
  return paginatedResponse({
    context,
    screen: "offers",
    routeCode: "offers.list",
    items,
    cursorSecret,
    generatedAt,
  });
}

const applicationListItem = ({
  context,
  actor,
  applicationSettings,
  entryValue,
}) => {
  const entry = databaseRecord(entryValue, "application_entry");
  assertOwnerRow(entry, actor);
  const application = databaseRecord(
    entry.application,
    "application_authority",
  );
  const result = entry.result === null || entry.result === undefined
    ? null
    : databaseRecord(entry.result, "application_result");
  const projected = projectApplicationForActor({
    settings: applicationSettings,
    actor: context.actor,
    application,
    result,
  });
  const offerCode = exactText(
    field(entry, "offerCode", "offer_code"),
    "invalid_application_entry",
    2,
    64,
  );
  if (!OFFER_CODE.test(offerCode)) fail("invalid_application_entry");
  const createdAt = positiveInteger(
    field(entry, "createdAt", "created_at"),
    "invalid_application_entry",
  );
  return {
    sortTime: createdAt,
    sortKey: projected.application.applicationId,
    applicationId: projected.application.applicationId,
    offerCode,
    currentStatus: projected.application.currentStatus,
    revision: projected.application.revision,
    active: projected.application.active,
    terminal: projected.application.terminal,
    result: projected.result,
    createdAt,
  };
};

export async function projectCabinetMiniAppApplications({
  context: contextValue,
  applicationSettings,
  entries,
  cursorSecret,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const { context, actor } = requireContext(contextValue, "applications");
  const generatedAt = positiveInteger(nowSeconds, "invalid_time");
  assertPage(entries, context.pageSize);
  const items = entries.map((entryValue) => applicationListItem({
    context,
    actor,
    applicationSettings,
    entryValue,
  }));
  return paginatedResponse({
    context,
    screen: "applications",
    routeCode: "applications.list",
    items,
    cursorSecret,
    generatedAt,
  });
}

export async function projectCabinetMiniAppResults({
  context: contextValue,
  applicationSettings,
  entries,
  cursorSecret,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const { context, actor } = requireContext(contextValue, "results");
  const generatedAt = positiveInteger(nowSeconds, "invalid_time");
  assertPage(entries, context.pageSize);
  const items = entries.map((entryValue) => applicationListItem({
    context,
    actor,
    applicationSettings,
    entryValue,
  }));
  if (items.some((item) => !item.terminal || item.result === null)) {
    fail("invalid_result_page");
  }
  return paginatedResponse({
    context,
    screen: "results",
    routeCode: "results.list",
    items,
    cursorSecret,
    generatedAt,
  });
}

export async function projectCabinetMiniAppApplicationDetail({
  context: contextValue,
  applicationSettings,
  application,
  contact = null,
  notes = [],
  assignment = null,
  result = null,
  history = [],
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const { context, actor } = requireContext(
    contextValue,
    "application_detail",
  );
  const generatedAt = positiveInteger(nowSeconds, "invalid_time");
  const databaseApplication = assertOwnerRow(application, actor);
  const databaseContact = contact === null || contact === undefined
    ? null
    : databaseRecord(contact, "application_contact");
  if (!Array.isArray(notes) || !Array.isArray(history)) {
    fail("invalid_application_detail");
  }
  const databaseNotes = notes.map((row) =>
    databaseRecord(row, "application_note"));
  const databaseAssignment = assignment === null || assignment === undefined
    ? null
    : databaseRecord(assignment, "application_assignment");
  const databaseResult = result === null || result === undefined
    ? null
    : databaseRecord(result, "application_result");
  const databaseHistory = history.map((row) =>
    databaseRecord(row, "application_history"));
  const detail = projectApplicationForActor({
    settings: applicationSettings,
    actor: context.actor,
    application: databaseApplication,
    contact: databaseContact,
    notes: databaseNotes,
    assignment: databaseAssignment,
    result: databaseResult,
    history: databaseHistory,
    nowSeconds: generatedAt,
  });
  return deepFreeze({
    contractVersion: 1,
    screen: "application_detail",
    mode: "live",
    actionsEnabled: false,
    generatedAt,
    detail,
    recovery: await recoveryMetadata(
      context,
      "application_detail",
      generatedAt,
      false,
    ),
  });
}

export async function createReadOnlyRecoverySnapshot({
  context: contextValue,
  response: responseValue,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const response = record(responseValue, "invalid_recovery_response");
  const { context } = requireContext(contextValue, response.screen);
  const now = positiveInteger(nowSeconds, "invalid_time");
  if (response.screen === "application_detail") {
    fail("recovery_not_allowed");
  }
  const generatedAt = positiveInteger(
    response.generatedAt,
    "invalid_recovery_response",
  );
  if (context.recoveryEnabled !== true || response.mode !== "live" ||
      response.actionsEnabled !== false || response.recovery?.eligible !== true ||
      response.recovery.generatedAt !== generatedAt || generatedAt > now ||
      generatedAt + MINI_APP_RECOVERY_MAX_AGE_SECONDS <= now ||
      response.recovery.ownerBindingHash !== await sha256Hex(
        `cabinet-owner:${context.sessionId}:${context.ownerPartnerProfileId}`,
      )) {
    fail("recovery_not_allowed");
  }
  const payload = JSON.parse(stableMiniAppJson(response));
  const payloadJson = stableMiniAppJson(payload);
  if (encoder.encode(payloadJson).length > 131_072) fail("recovery_too_large");
  return deepFreeze({
    snapshotVersion: 1,
    ownerBindingHash: response.recovery.ownerBindingHash,
    screen: response.screen,
    createdAt: generatedAt,
    expiresAt: generatedAt + MINI_APP_RECOVERY_MAX_AGE_SECONDS,
    payloadHash: await sha256Hex(payloadJson),
    payload,
  });
}

export async function restoreReadOnlyRecoverySnapshot({
  snapshot: snapshotValue,
  expectedOwnerBindingHash,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const snapshot = record(snapshotValue, "invalid_recovery_snapshot");
  const now = positiveInteger(nowSeconds, "invalid_time");
  const payload = record(snapshot.payload, "invalid_recovery_snapshot");
  const payloadJson = stableMiniAppJson(payload);
  if (snapshot.snapshotVersion !== 1 ||
      !HEX_64.test(expectedOwnerBindingHash) ||
      snapshot.ownerBindingHash !== expectedOwnerBindingHash ||
      snapshot.screen !== payload.screen || payload.screen === "application_detail" ||
      payload.recovery?.eligible !== true ||
      !Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt > now ||
      !Number.isSafeInteger(snapshot.expiresAt) || snapshot.expiresAt <= now ||
      snapshot.expiresAt !== snapshot.createdAt +
        MINI_APP_RECOVERY_MAX_AGE_SECONDS ||
      !constantTimeHexEqual(
        snapshot.payloadHash,
        await sha256Hex(payloadJson),
      )) fail("invalid_recovery_snapshot");
  return deepFreeze({
    ...payload,
    mode: "read_only_recovery",
    actionsEnabled: false,
    stale: true,
    nextCursor: null,
  });
}
