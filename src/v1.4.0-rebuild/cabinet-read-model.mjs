import {
  MiniAppSecurityError,
  createBoundCursor,
  verifyBoundCursor,
} from "./mini-app-security.mjs";
import { projectOwnPartnerIdentity } from "./partner-identity.mjs";
import {
  projectAssignedPartnerOffer,
  projectOwnPartnerOffer,
  projectPublicPartnerOffer,
} from "./offer-lifecycle.mjs";
import {
  projectLeadForPartner,
  projectLeadForUser,
} from "./lead-lifecycle.mjs";

const deepFreeze = (value) => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
};

export const CABINET_READ_MODEL_VERSION =
  "2026-09-29.v1.4.0-rebuild-p07";

export const CABINET_READ_ROUTES = deepFreeze({
  bootstrap: "/api/v1.4.0/cabinet/bootstrap",
  profile: "/api/v1.4.0/cabinet/profile",
  subscription: "/api/v1.4.0/cabinet/subscription",
  offers: "/api/v1.4.0/cabinet/offers",
  applications: "/api/v1.4.0/cabinet/applications",
  applicationDetail: "/api/v1.4.0/cabinet/applications/:lead_id",
  analytics: "/api/v1.4.0/cabinet/analytics",
});

export const CABINET_READ_REPOSITORY_CONTRACT = deepFreeze({
  version: 1,
  mode: "read_only",
  reads: [
    "users",
    "user_roles",
    "partner_applications",
    "partner_profiles",
    "partner_public_settings",
    "partner_beta_access",
    "partner_legal_profiles",
    "user_plans",
    "user_access_states",
    "user_access",
    "trial_grants",
    "subscription_access_grants",
    "bonus_access_grants",
    "offers",
    "offer_owners",
    "offer_versions",
    "offer_visibility_rules",
    "offer_visibility_assignments",
    "partner_offer_links",
    "lead_requests",
    "lead_partner_attribution",
    "analytics_projection_checkpoints",
    "analytics_projection_reconciliation",
    "ambassador_profiles_v2",
    "ambassador_metrics_daily",
    "analytics_attribution_decisions",
  ],
  writes: [],
  dormantCabinetTablesRead: false,
  dormantCabinetTablesWrite: false,
  crmIncluded: false,
  centralEntitlementsIncluded: false,
  promotionsIncluded: false,
  arbitrarySqlAllowed: false,
  clientIdentityTrusted: false,
  sourceModules: ["P03", "P04", "P05", "P06"],
});

const ROLES = new Set(["user", "partner", "admin"]);
const PLANS = new Set(["free", "professional", "dragon"]);
const ACCESS_STATES = new Set([
  "none",
  "trial",
  "active",
  "cancel_at_period_end",
  "expired",
  "refunded",
  "suspended",
]);
const READ_PATHS = new Set(["legacy", "canonical", "preview_overlay"]);
const COMPARISON_STATUSES = new Set([
  "legacy_free",
  "dragon_preview_active",
  "matched",
  "different",
  "mapped_legacy",
  "mapped_legacy_mismatch",
  "missing_canonical",
  "partial_canonical",
  "manual_review",
  "preserved_legacy",
  "unknown_legacy",
]);
const PERIODS = new Set(["7d", "30d"]);
const VIEWS = deepFreeze({
  offers: ["catalog", "mine"],
  applications: ["mine", "attributed"],
});
const PAGE_LIMIT_DEFAULT = 20;
const PAGE_LIMIT_MAX = 50;
const SESSION_ID = /^mss_[0-9a-f]{64}$/u;
const CURSOR_ANCHOR = /^[A-Za-z0-9_.:-]{1,128}$/u;
const UTC_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const AMBASSADOR_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const STATUS_BY_CODE = Object.freeze({
  bad_request: 400,
  invalid_cursor: 400,
  unauthorized: 401,
  session_expired: 401,
  actor_blocked: 403,
  partner_required: 403,
  not_found: 404,
  method_not_allowed: 405,
  authority_inconsistent: 500,
  projection_failed: 500,
});

export class CabinetReadModelError extends Error {
  constructor(code, status = STATUS_BY_CODE[code] ?? 400) {
    super(code);
    this.name = "CabinetReadModelError";
    this.code = code;
    this.status = status;
  }
}

const fail = (code, status) => {
  throw new CabinetReadModelError(code, status);
};

const positiveInteger = (value, code = "authority_inconsistent") => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
};

const nonNegativeInteger = (value, code = "authority_inconsistent") => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail(code);
  return number;
};

const exactBoolean = (value, code = "authority_inconsistent") => {
  if (value !== true && value !== false) fail(code);
  return value;
};

const databaseRow = (value, code = "authority_inconsistent", {
  optional = false,
  source = "database",
} = {}) => {
  if (optional && (value === null || value === undefined)) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.authoritySource !== source) fail(code);
  return value;
};

const sessionContext = (value, nowSeconds) => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.contextVersion !== 1 ||
      value.authoritySource !== "database_session" ||
      !SESSION_ID.test(value.sessionId) ||
      !Number.isSafeInteger(value.telegramId) || value.telegramId <= 0 ||
      !Number.isSafeInteger(value.botId) || value.botId <= 0 ||
      !Number.isSafeInteger(value.expiresAt)) fail("unauthorized");
  if (value.expiresAt <= nowSeconds) fail("session_expired");
  return value;
};

const databaseTime = (value, { optional = false } = {}) => {
  if (optional && (value === null || value === undefined || value === "")) {
    return null;
  }
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string" || value.length > 40) {
    fail("authority_inconsistent");
  }
  const parsed = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(parsed) || parsed <= 0) fail("authority_inconsistent");
  return value;
};

const resolveActor = ({ context, user, roleRows = [], nowSeconds }) => {
  const session = sessionContext(context, nowSeconds);
  const account = databaseRow(user);
  const telegramId = positiveInteger(account.telegramId);
  if (telegramId !== session.telegramId) fail("not_found", 404);
  if (account.isBlocked === true || account.isBlocked === 1) {
    fail("actor_blocked");
  }
  if (!Array.isArray(roleRows)) fail("authority_inconsistent");
  const roles = new Set();
  const seen = new Set();
  for (const value of roleRows) {
    const row = databaseRow(value);
    if (positiveInteger(row.telegramId) !== telegramId ||
        !ROLES.has(row.role) ||
        !new Set(["active", "paused"]).has(row.status) ||
        seen.has(row.role)) fail("authority_inconsistent");
    seen.add(row.role);
    if (row.status === "active") roles.add(row.role);
  }
  const systemRole = roles.has("admin")
    ? "admin"
    : roles.has("partner") ? "partner" : "user";
  return {
    telegramId,
    systemRole,
    roles,
    acceptedTerms: account.acceptedTerms === true || account.acceptedTerms === 1,
    memberSince: databaseTime(account.joinedAt, { optional: true }),
  };
};

const accessProjection = (value, actor) => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.authority !== "worker" || ![1, 2].includes(value.decisionVersion) ||
      positiveInteger(value.telegramId) !== actor.telegramId ||
      value.systemRole !== actor.systemRole ||
      !READ_PATHS.has(value.readPath) ||
      !COMPARISON_STATUSES.has(value.comparisonStatus)) {
    fail("authority_inconsistent");
  }
  const reviewRequired = exactBoolean(value.reviewRequired);
  const resolved = exactBoolean(value.resolved);
  if (typeof value.paidCapabilitiesEnabled !== "boolean" ||
      value.decisionVersion === 1 && value.paidCapabilitiesEnabled !== false ||
      (value.planCode !== null && !PLANS.has(value.planCode)) ||
      (value.accessState !== null && !ACCESS_STATES.has(value.accessState)) ||
      (resolved && (reviewRequired || value.planCode === null ||
        value.accessState === null)) ||
      (!resolved && !reviewRequired) ||
      (resolved && value.accessState === "trial" && value.planCode !== "free")) {
    fail("authority_inconsistent");
  }
  const display = value.planCode === "professional"
    ? { name: "Professional", marker: "blue" }
    : value.planCode === "dragon"
      ? { name: "Dragon", marker: "red" }
      : value.planCode === "free"
        ? { name: "Free", marker: "neutral" }
        : { name: "Требуется проверка", marker: "warning" };
  return deepFreeze({
    status: resolved ? "resolved" : "review_required",
    planCode: value.planCode,
    planName: display.name,
    planMarker: display.marker,
    accessState: value.accessState,
    readPath: value.readPath,
    comparisonStatus: value.comparisonStatus,
    reviewRequired,
    paidCapabilitiesEnabled: value.paidCapabilitiesEnabled,
  });
};

const profileIdFrom = (partnerProfile) => {
  if (partnerProfile === null || partnerProfile === undefined) return null;
  const profile = databaseRow(partnerProfile);
  return positiveInteger(profile.id);
};

const assertRoleProfileConsistency = (actor, identity, partnerProfile) => {
  const profileId = profileIdFrom(partnerProfile);
  const hasPartnerRole = actor.roles.has("partner");
  const hasProfile = profileId !== null;
  if (hasPartnerRole !== hasProfile ||
      (hasProfile && identity.profile === null) ||
      (!hasProfile && identity.profile !== null)) {
    fail("authority_inconsistent");
  }
  return profileId;
};

const identityProjection = ({
  context,
  user,
  roleRows,
  application,
  partnerProfile,
  legalProfile,
  betaAccess,
  publicSettings,
  nowSeconds,
}) => {
  try {
    return projectOwnPartnerIdentity({
      context,
      user,
      roleRows,
      application,
      partnerProfile,
      legalProfile,
      betaAccess,
      publicSettings,
      nowSeconds,
    });
  } catch {
    fail("authority_inconsistent");
  }
};

const normalizeSummary = (value, actor, partnerProfileId) => {
  const row = databaseRow(value);
  if (positiveInteger(row.telegramId) !== actor.telegramId ||
      (row.partnerProfileId === null
        ? partnerProfileId !== null
        : positiveInteger(row.partnerProfileId) !== partnerProfileId)) {
    fail("authority_inconsistent");
  }
  const summary = {
    visibleOffers: nonNegativeInteger(row.visibleOffers),
    ownOffers: nonNegativeInteger(row.ownOffers),
    ownApplications: nonNegativeInteger(row.ownApplications),
    attributedApplications: nonNegativeInteger(row.attributedApplications),
  };
  if (partnerProfileId === null &&
      (summary.ownOffers !== 0 || summary.attributedApplications !== 0)) {
    fail("authority_inconsistent");
  }
  return summary;
};

const normalizeAmbassadorProfile = (value, partnerProfileId) => {
  const row = databaseRow(value, "authority_inconsistent", { optional: true });
  if (row === null) return null;
  if (partnerProfileId === null ||
      positiveInteger(row.partnerProfileId) !== partnerProfileId ||
      typeof row.ambassadorId !== "string" ||
      !AMBASSADOR_ID.test(row.ambassadorId) ||
      !new Set(["draft", "active", "paused", "suspended", "archived"])
        .has(row.status)) fail("authority_inconsistent");
  return { id: row.ambassadorId, status: row.status };
};

const buildProfile = (args, actor) => {
  const identity = identityProjection(args);
  const partnerProfileId = assertRoleProfileConsistency(
    actor,
    identity,
    args.partnerProfile,
  );
  return {
    identity,
    partnerProfileId,
    account: {
      memberSince: actor.memberSince,
      generalTermsAccepted: actor.acceptedTerms,
    },
    systemRole: actor.systemRole,
    access: accessProjection(args.accessAuthority, actor),
  };
};

export function projectCabinetProfile({
  nowSeconds = Math.floor(Date.now() / 1_000),
  ...args
} = {}) {
  const now = positiveInteger(nowSeconds, "bad_request");
  const actor = resolveActor({ ...args, nowSeconds: now });
  const profile = buildProfile({ ...args, nowSeconds: now }, actor);
  return deepFreeze({
    readModelVersion: 1,
    generatedAt: now,
    account: profile.account,
    systemRole: profile.systemRole,
    access: profile.access,
    partner: profile.identity,
  });
}

export function projectCabinetBootstrap({
  summary,
  ambassadorProfile = null,
  nowSeconds = Math.floor(Date.now() / 1_000),
  ...args
} = {}) {
  const now = positiveInteger(nowSeconds, "bad_request");
  const actor = resolveActor({ ...args, nowSeconds: now });
  const profile = buildProfile({ ...args, nowSeconds: now }, actor);
  const counts = normalizeSummary(summary, actor, profile.partnerProfileId);
  const ambassador = normalizeAmbassadorProfile(
    ambassadorProfile,
    profile.partnerProfileId,
  );
  const isPartner = profile.identity.state === "active_partner";
  return deepFreeze({
    readModelVersion: 1,
    generatedAt: now,
    account: profile.account,
    systemRole: profile.systemRole,
    access: profile.access,
    partner: profile.identity,
    counts,
    ambassador: {
      enrolled: ambassador !== null,
      status: ambassador?.status ?? "not_enrolled",
    },
    navigation: [
      { section: "profile", enabled: true, reason: null },
      { section: "offers", enabled: true, reason: null },
      { section: "applications", enabled: true, reason: null },
      {
        section: "analytics",
        enabled: isPartner,
        reason: isPartner ? null : "partner_required",
      },
      { section: "subscription", enabled: true, reason: null },
    ],
  });
}

const queryObject = (url, allowed) => {
  const result = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || Object.hasOwn(result, key)) fail("bad_request");
    result[key] = value;
  }
  return result;
};

const parseLimit = (value) => {
  if (value === undefined) return PAGE_LIMIT_DEFAULT;
  if (!/^\d{1,2}$/u.test(value)) fail("bad_request");
  const number = Number(value);
  if (number < 1 || number > PAGE_LIMIT_MAX) fail("bad_request");
  return number;
};

const parseUrl = (value) => {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 ||
      /[\0\r\n]/u.test(value)) fail("bad_request");
  let parsed;
  try {
    const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value);
    parsed = new URL(value, "https://cabinet.invalid");
    if ((absolute && parsed.protocol !== "https:") || parsed.username ||
        parsed.password || parsed.hash) fail("bad_request");
  } catch (error) {
    if (error instanceof CabinetReadModelError) throw error;
    fail("bad_request");
  }
  return parsed;
};

export function resolveCabinetReadRoute({ method, url } = {}) {
  if (String(method || "").toUpperCase() !== "GET") {
    fail("method_not_allowed");
  }
  const parsed = parseUrl(url);
  const pathname = parsed.pathname;
  if (pathname === CABINET_READ_ROUTES.bootstrap ||
      pathname === CABINET_READ_ROUTES.profile ||
      pathname === CABINET_READ_ROUTES.subscription) {
    queryObject(parsed, new Set());
    return deepFreeze({
      routeCode: pathname.endsWith("bootstrap")
        ? "cabinet.bootstrap"
        : pathname.endsWith("subscription") ? "cabinet.subscription" : "cabinet.profile",
      params: {},
    });
  }
  if (pathname === CABINET_READ_ROUTES.offers) {
    const query = queryObject(parsed, new Set(["view", "limit", "cursor"]));
    const view = query.view ?? "catalog";
    if (!VIEWS.offers.includes(view) ||
        (query.cursor !== undefined &&
          (query.cursor.length < 1 || query.cursor.length > 2_048))) {
      fail("bad_request");
    }
    return deepFreeze({ routeCode: "cabinet.offers", params: {
      view,
      limit: parseLimit(query.limit),
      cursor: query.cursor ?? null,
    } });
  }
  if (pathname === CABINET_READ_ROUTES.applications) {
    const query = queryObject(parsed, new Set(["view", "limit", "cursor"]));
    const view = query.view ?? "mine";
    if (!VIEWS.applications.includes(view) ||
        (query.cursor !== undefined &&
          (query.cursor.length < 1 || query.cursor.length > 2_048))) {
      fail("bad_request");
    }
    return deepFreeze({ routeCode: "cabinet.applications", params: {
      view,
      limit: parseLimit(query.limit),
      cursor: query.cursor ?? null,
    } });
  }
  const detail = /^\/api\/v1\.4\.0\/cabinet\/applications\/(\d+)$/u
    .exec(pathname);
  if (detail) {
    queryObject(parsed, new Set());
    return deepFreeze({ routeCode: "cabinet.application_detail", params: {
      leadId: positiveInteger(detail[1], "bad_request"),
    } });
  }
  if (pathname === CABINET_READ_ROUTES.analytics) {
    const query = queryObject(parsed, new Set(["period"]));
    const period = query.period ?? "30d";
    if (!PERIODS.has(period)) fail("bad_request");
    return deepFreeze({ routeCode: "cabinet.analytics", params: { period } });
  }
  fail("not_found");
}

const pageRouteCode = (collection, view) => {
  if (collection === "offers" && VIEWS.offers.includes(view)) {
    return `cabinet.offers.${view}`;
  }
  if (collection === "applications" && VIEWS.applications.includes(view)) {
    return `cabinet.applications.${view}`;
  }
  fail("bad_request");
};

export async function verifyCabinetPageCursor({
  context,
  collection,
  view,
  cursor,
  cursorSecret,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const now = positiveInteger(nowSeconds, "bad_request");
  sessionContext(context, now);
  try {
    return await verifyBoundCursor({
      context,
      routeCode: pageRouteCode(collection, view),
      cursor,
      secret: cursorSecret,
      nowSeconds: now,
    });
  } catch (error) {
    if (error instanceof MiniAppSecurityError && error.code === "invalid_cursor") {
      fail("invalid_cursor");
    }
    fail("projection_failed", 500);
  }
}

const normalizePageEntries = (entries, limit, hasMore) => {
  if (!Array.isArray(entries) || entries.length > limit ||
      typeof hasMore !== "boolean" || (hasMore && entries.length !== limit)) {
    fail("authority_inconsistent");
  }
  let previous = null;
  return entries.map((value) => {
    const row = databaseRow(value);
    const cursorTime = positiveInteger(row.cursorTime);
    if (typeof row.cursorKey !== "string" ||
        !CURSOR_ANCHOR.test(row.cursorKey)) fail("authority_inconsistent");
    if (previous && (previous.cursorTime < cursorTime ||
        (previous.cursorTime === cursorTime &&
          previous.cursorKey <= row.cursorKey))) {
      fail("authority_inconsistent");
    }
    previous = { cursorTime, cursorKey: row.cursorKey };
    return { row, cursorTime, cursorKey: row.cursorKey };
  });
};

const nextCursorFor = async ({
  normalized,
  hasMore,
  context,
  routeCode,
  cursorSecret,
  nowSeconds,
}) => {
  if (!hasMore) return null;
  const last = normalized.at(-1);
  try {
    return await createBoundCursor({
      context,
      routeCode,
      anchorTime: last.cursorTime,
      anchorKey: last.cursorKey,
      secret: cursorSecret,
      nowSeconds,
    });
  } catch {
    fail("projection_failed", 500);
  }
};

const projectOfferEntry = async ({
  entry,
  view,
  context,
  user,
  roleRows,
  partnerProfile,
}) => {
  if (!entry.aggregate || typeof entry.aggregate !== "object" ||
      Array.isArray(entry.aggregate)) fail("authority_inconsistent");
  try {
    if (view === "mine" && entry.scope === "own") {
      return deepFreeze({ scope: "own", ...projectOwnPartnerOffer({
        context, user, roleRows, partnerProfile, ...entry.aggregate,
      }) });
    }
    if (view === "catalog" && entry.scope === "public") {
      return deepFreeze({ scope: "public", ...await projectPublicPartnerOffer({
        ...entry.aggregate,
      }) });
    }
    if (view === "catalog" && entry.scope === "assigned") {
      return deepFreeze({ scope: "assigned", ...await projectAssignedPartnerOffer({
        context, user, roleRows, ...entry.aggregate,
      }) });
    }
    fail("authority_inconsistent");
  } catch (error) {
    if (error instanceof CabinetReadModelError) throw error;
    if (new Set(["cross_owner", "offer_not_public"]).has(error?.code)) {
      fail("not_found");
    }
    fail("projection_failed", 500);
  }
};

export async function projectCabinetOfferPage({
  context,
  user,
  roleRows = [],
  partnerProfile = null,
  view,
  entries,
  limit = PAGE_LIMIT_DEFAULT,
  hasMore = false,
  cursorSecret,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const now = positiveInteger(nowSeconds, "bad_request");
  const actor = resolveActor({ context, user, roleRows, nowSeconds: now });
  if (!VIEWS.offers.includes(view)) fail("bad_request");
  const pageLimit = positiveInteger(limit, "bad_request");
  if (pageLimit > PAGE_LIMIT_MAX) fail("bad_request");
  if (view === "mine" && !actor.roles.has("partner")) fail("partner_required");
  const normalized = normalizePageEntries(entries, pageLimit, hasMore);
  const items = [];
  for (const item of normalized) {
    items.push(await projectOfferEntry({
      entry: item.row,
      view,
      context,
      user,
      roleRows,
      partnerProfile,
    }));
  }
  return deepFreeze({
    readModelVersion: 1,
    collection: "offers",
    view,
    items,
    nextCursor: await nextCursorFor({
      normalized,
      hasMore,
      context,
      routeCode: pageRouteCode("offers", view),
      cursorSecret,
      nowSeconds: now,
    }),
  });
}

const projectApplicationEntry = ({
  entry,
  view,
  context,
  user,
  roleRows,
  partnerProfile,
}) => {
  try {
    if (view === "mine") {
      return projectLeadForUser({
        context, user, roleRows, lead: entry.lead,
      });
    }
    if (view === "attributed") {
      return projectLeadForPartner({
        context,
        user,
        roleRows,
        partnerProfile,
        lead: entry.lead,
        attribution: entry.attribution,
      });
    }
    fail("bad_request");
  } catch (error) {
    if (error instanceof CabinetReadModelError) throw error;
    if (new Set(["cross_owner", "lead_not_found"]).has(error?.code)) {
      fail("not_found");
    }
    fail("projection_failed", 500);
  }
};

export async function projectCabinetApplicationPage({
  context,
  user,
  roleRows = [],
  partnerProfile = null,
  view,
  entries,
  limit = PAGE_LIMIT_DEFAULT,
  hasMore = false,
  cursorSecret,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const now = positiveInteger(nowSeconds, "bad_request");
  const actor = resolveActor({ context, user, roleRows, nowSeconds: now });
  if (!VIEWS.applications.includes(view)) fail("bad_request");
  const pageLimit = positiveInteger(limit, "bad_request");
  if (pageLimit > PAGE_LIMIT_MAX) fail("bad_request");
  if (view === "attributed" && !actor.roles.has("partner")) {
    fail("partner_required");
  }
  const normalized = normalizePageEntries(entries, pageLimit, hasMore);
  const items = normalized.map((item) => projectApplicationEntry({
    entry: item.row,
    view,
    context,
    user,
    roleRows,
    partnerProfile,
  }));
  return deepFreeze({
    readModelVersion: 1,
    collection: "applications",
    view,
    items,
    nextCursor: await nextCursorFor({
      normalized,
      hasMore,
      context,
      routeCode: pageRouteCode("applications", view),
      cursorSecret,
      nowSeconds: now,
    }),
  });
}

export function projectCabinetApplicationDetail({
  context,
  user,
  roleRows = [],
  partnerProfile = null,
  view,
  lead,
  attribution = null,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const now = positiveInteger(nowSeconds, "bad_request");
  const actor = resolveActor({ context, user, roleRows, nowSeconds: now });
  if (!VIEWS.applications.includes(view)) fail("bad_request");
  if (view === "attributed" && !actor.roles.has("partner")) {
    fail("partner_required");
  }
  return deepFreeze({
    readModelVersion: 1,
    view,
    application: projectApplicationEntry({
      entry: { lead, attribution },
      view,
      context,
      user,
      roleRows,
      partnerProfile,
    }),
  });
}

const utcDateSeconds = (value) => {
  if (typeof value !== "string" || !UTC_DATE.test(value)) {
    fail("authority_inconsistent");
  }
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(milliseconds) ||
      new Date(milliseconds).toISOString().slice(0, 10) !== value) {
    fail("authority_inconsistent");
  }
  return Math.floor(milliseconds / 1_000);
};

const normalizePeriod = (value, expectedPeriod) => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.code !== expectedPeriod) {
    fail("authority_inconsistent");
  }
  const startSeconds = utcDateSeconds(value.start);
  const endSeconds = utcDateSeconds(value.endExclusive);
  if (startSeconds >= endSeconds) fail("authority_inconsistent");
  return { code: value.code, start: value.start, endExclusive: value.endExclusive };
};

const normalizeLeadAnalytics = (value, partnerProfileId, period, nowSeconds) => {
  const row = databaseRow(value, "authority_inconsistent", {
    source: "database_aggregate",
  });
  if (positiveInteger(row.partnerProfileId) !== partnerProfileId ||
      row.periodCode !== period.code || row.periodStart !== period.start ||
      row.periodEndExclusive !== period.endExclusive) {
    fail("authority_inconsistent");
  }
  const generatedAt = positiveInteger(row.generatedAt);
  if (generatedAt > nowSeconds + 60) fail("authority_inconsistent");
  const metrics = {
    linkClicks: nonNegativeInteger(row.linkClicks),
    uniqueLinkClicks: nonNegativeInteger(row.uniqueLinkClicks),
    applications: nonNegativeInteger(row.applications),
    pendingApplications: nonNegativeInteger(row.pendingApplications),
    confirmedApplications: nonNegativeInteger(row.confirmedApplications),
    rejectedApplications: nonNegativeInteger(row.rejectedApplications),
    paidApplications: nonNegativeInteger(row.paidApplications),
    confirmedResultKopecks: nonNegativeInteger(row.confirmedResultKopecks),
  };
  if (metrics.uniqueLinkClicks > metrics.linkClicks ||
      metrics.pendingApplications + metrics.confirmedApplications +
        metrics.rejectedApplications + metrics.paidApplications !==
        metrics.applications) fail("authority_inconsistent");
  return {
    generatedAt,
    freshness: nowSeconds - generatedAt <= 86_400 ? "fresh" : "stale",
    metrics,
  };
};

const normalizeCell = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.suppressed !== "boolean" ||
      typeof value.available !== "boolean" ||
      (value.value !== null &&
        (!Number.isSafeInteger(value.value) || value.value < 0)) ||
      (value.suppressed && value.value !== null) ||
      (!value.available && (value.value !== null || value.suppressed)) ||
      (value.available && !value.suppressed && value.value === null)) {
    fail("authority_inconsistent");
  }
  return { value: value.value, suppressed: value.suppressed,
    available: value.available };
};

const normalizeOwnerFrame = ({
  value,
  partnerProfileId,
  ambassador,
  period,
  nowSeconds,
}) => {
  if (ambassador === null) {
    if (value !== null && value !== undefined) fail("authority_inconsistent");
    return { status: "not_enrolled", metrics: null, attribution: null };
  }
  if (ambassador.status !== "active") {
    if (value !== null && value !== undefined) fail("authority_inconsistent");
    return { status: ambassador.status, metrics: null, attribution: null };
  }
  if (value === null || value === undefined) {
    return { status: "unavailable", metrics: null, attribution: null };
  }
  const wrapper = databaseRow(value, "authority_inconsistent", {
    source: "server_projection",
  });
  const frame = wrapper.frame;
  const expectedStart = utcDateSeconds(period.start);
  const expectedEnd = utcDateSeconds(period.endExclusive);
  if (positiveInteger(wrapper.partnerProfileId) !== partnerProfileId ||
      wrapper.ambassadorId !== ambassador.id || !frame ||
      frame.policyVersion !== "2026-09-24.analytics-v139-p04-v1" ||
      frame.scope?.kind !== "ambassador" ||
      frame.scope?.ambassadorId !== ambassador.id ||
      !Number.isSafeInteger(frame.period?.start) ||
      !Number.isSafeInteger(frame.period?.endExclusive) ||
      !Number.isSafeInteger(frame.period?.asOfAt) ||
      frame.period.start !== expectedStart ||
      frame.period.endExclusive !== expectedEnd ||
      frame.period.asOfAt < frame.period.endExclusive ||
      frame.period.asOfAt > nowSeconds + 60 ||
      wrapper.periodCode !== period.code ||
      wrapper.periodStart !== period.start ||
      wrapper.periodEndExclusive !== period.endExclusive ||
      !frame.metrics || !frame.attribution) fail("authority_inconsistent");
  const metricKeys = [
    "tracking_opens",
    "attributed_registrations",
    "attributed_leads",
    "applied_paid_access",
    "confirmed_referral_rewards",
  ];
  const attributionKeys = [
    "relationship",
    "engagement",
    "commercial_lead",
    "commercial_access",
    "commercial_reward",
  ];
  if (Object.keys(frame.metrics).sort().join("|") !==
      [...metricKeys].sort().join("|") ||
      Object.keys(frame.attribution).sort().join("|") !==
      [...attributionKeys].sort().join("|")) fail("authority_inconsistent");
  return {
    status: "ready",
    policyVersion: frame.policyVersion,
    metrics: Object.fromEntries(metricKeys.map((key) => [
      key,
      normalizeCell(frame.metrics[key]),
    ])),
    attribution: Object.fromEntries(attributionKeys.map((key) => [
      key,
      normalizeCell(frame.attribution[key]),
    ])),
  };
};

export function projectCabinetAnalytics({
  context,
  user,
  roleRows = [],
  partnerProfile,
  ambassadorProfile = null,
  leadAggregate,
  ambassadorFrame = null,
  period,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const now = positiveInteger(nowSeconds, "bad_request");
  const actor = resolveActor({ context, user, roleRows, nowSeconds: now });
  if (!actor.roles.has("partner")) fail("partner_required");
  const profile = databaseRow(partnerProfile);
  const partnerProfileId = positiveInteger(profile.id);
  if (positiveInteger(profile.telegramId) !== actor.telegramId ||
      profile.status !== "active") fail("not_found");
  const requestedPeriod = normalizePeriod(period, period?.code);
  if (!PERIODS.has(requestedPeriod.code)) fail("bad_request");
  const leads = normalizeLeadAnalytics(
    leadAggregate,
    partnerProfileId,
    requestedPeriod,
    now,
  );
  const ambassador = normalizeAmbassadorProfile(
    ambassadorProfile,
    partnerProfileId,
  );
  return deepFreeze({
    readModelVersion: 1,
    generatedAt: now,
    period: requestedPeriod,
    freshness: leads.freshness,
    leads: leads.metrics,
    ambassador: normalizeOwnerFrame({
      value: ambassadorFrame,
      partnerProfileId,
      ambassador,
      period: requestedPeriod,
      nowSeconds: now,
    }),
  });
}

export function cabinetReadModelHttpError(error) {
  if (!(error instanceof CabinetReadModelError)) {
    return deepFreeze({ status: 500, body: { error: "internal_error" } });
  }
  const publicCode = error.status >= 500
    ? "internal_error"
    : error.code === "authority_inconsistent" || error.code === "projection_failed"
      ? "internal_error"
      : error.code;
  return deepFreeze({ status: error.status, body: { error: publicCode } });
}
