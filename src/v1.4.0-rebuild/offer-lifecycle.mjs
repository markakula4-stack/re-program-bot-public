import { assertClientPayloadAllowed } from "./data-contract.mjs";
import { sha256Hex, isVerifiedTelegramCommandContext } from "./mini-app-security.mjs";

const deepFreeze = (value) => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
};

export const OFFER_LIFECYCLE_VERSION =
  "2026-09-29.v1.4.0-rebuild-p05";

export const OFFER_BUSINESS_STATES = deepFreeze([
  "draft",
  "active",
  "paused",
  "archived",
]);

export const OFFER_MODERATION_STATES = deepFreeze([
  "not_submitted",
  "pending",
  "changes_requested",
  "approved",
  "rejected",
]);

export const OFFER_VISIBILITIES = deepFreeze([
  "private",
  "assigned",
  "public",
]);

export const OFFER_CATEGORIES = deepFreeze([
  "debit",
  "credit",
  "business",
  "loan",
  "deposit",
  "insurance",
  "job",
  "other",
]);

export const OFFER_REPOSITORY_CONTRACT = deepFreeze({
  version: 1,
  reads: [
    "users",
    "user_roles",
    "partner_profiles",
    "partner_beta_settings",
    "partner_beta_access",
    "offers",
    "offer_owners",
    "offer_versions",
    "offer_visibility_rules",
    "partner_offer_links",
    "partner_links",
    "partner_programs",
    "program_offers",
    "offer_moderation_decisions",
    "offer_visibility_assignments",
    "offer_visibility_assignment_events",
  ],
  writes: {
    createDraft: [
      "offers",
      "offer_owners",
      "offer_versions",
      "offer_visibility_rules",
      "admin_audit_log",
    ],
    createVersion: [
      "offers",
      "partner_offer_links",
      "offer_versions",
      "offer_visibility_rules",
      "offer_owners",
      "offer_moderation_decisions",
      "admin_audit_log",
    ],
    submit: ["offer_visibility_rules", "offer_moderation_decisions"],
    moderate: ["offer_visibility_rules", "offer_moderation_decisions"],
    setVisibility: ["offer_visibility_rules", "offer_moderation_decisions"],
    assign: [
      "offer_visibility_assignments",
      "offer_visibility_assignment_events",
      "offer_visibility_rules",
      "offer_moderation_decisions",
    ],
  },
  everyCommandAtomic: true,
  compareAndSwapRequired: true,
  immutableVersions: true,
  approvalPublishes: false,
  arbitraryPartnerUrlAllowed: false,
  adminMayEditPartnerContent: false,
  promotionsIncluded: false,
  dormantWritePrefix: "cabinet_",
  newMigrationRequired: false,
});

const BUSINESS = new Set(OFFER_BUSINESS_STATES);
const MODERATION = new Set(OFFER_MODERATION_STATES);
const VISIBILITY = new Set(OFFER_VISIBILITIES);
const CATEGORY = new Set(OFFER_CATEGORIES);
const ACTIVE_ROLE = new Set(["user", "partner", "admin"]);
const SERVER_KEY = /^mikey_[0-9a-f]{64}$/u;
const EVENT_KEY = /^[a-z0-9_.:-]{16,180}$/u;
const OFFER_CODE = /^[a-z0-9_-]{3,24}$/u;
const UTC_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const UTC_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z)?$/u;

const STATUS_BY_CODE = Object.freeze({
  invalid_payload: 400,
  invalid_offer: 400,
  invalid_route: 400,
  incomplete_offer: 400,
  unauthorized: 401,
  actor_blocked: 403,
  partner_required: 403,
  partner_beta_required: 403,
  admin_required: 403,
  self_review_forbidden: 403,
  cross_owner: 403,
  offer_not_public: 404,
  offer_conflict: 409,
  version_conflict: 409,
});

export class OfferLifecycleError extends Error {
  constructor(code, status = STATUS_BY_CODE[code] ?? 400) {
    super(code);
    this.name = "OfferLifecycleError";
    this.code = code;
    this.status = status;
  }
}

const fail = (code, status) => {
  throw new OfferLifecycleError(code, status);
};

const positiveInteger = (value, code = "invalid_authority") => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
};

const nonNegativeInteger = (value, maximum, code = "invalid_payload") => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    fail(code);
  }
  return number;
};

const timestamp = (value, code = "invalid_time") => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
};

const databaseRow = (value, code, { optional = false } = {}) => {
  if (optional && (value === null || value === undefined)) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.authoritySource !== "database") fail(`untrusted_${code}`);
  return value;
};

const databaseBoolean = (value, code) => {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  fail(code);
};

const databaseTimeSeconds = (value, code) => {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string") fail(code);
  const text = value.trim();
  const canonical = UTC_TIMESTAMP.test(text)
    ? `${text.replace(" ", "T").replace(/Z$/u, "")}Z`
    : text;
  const milliseconds = Date.parse(canonical);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) fail(code);
  return Math.floor(milliseconds / 1_000);
};

const verifiedSession = (value) => {
  if (isVerifiedTelegramCommandContext(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.contextVersion !== 1 ||
      value.authoritySource !== "database_session" ||
      !Number.isSafeInteger(value.telegramId) || value.telegramId <= 0 ||
      !Number.isSafeInteger(value.botId) || value.botId <= 0 ||
      typeof value.sessionId !== "string") fail("unauthorized");
  return value;
};

const normalizeRoleRows = (roleRows, telegramId) => {
  if (!Array.isArray(roleRows)) fail("invalid_role_authority");
  const roles = new Set();
  for (const value of roleRows) {
    const row = databaseRow(value, "role_authority");
    if (positiveInteger(row.telegramId, "invalid_role_authority") !== telegramId ||
        !ACTIVE_ROLE.has(row.role) ||
        !new Set(["active", "paused"]).has(row.status)) {
      fail("invalid_role_authority");
    }
    if (row.status === "active") roles.add(row.role);
  }
  return roles;
};

const resolveActor = ({ context, user, roleRows }) => {
  const session = verifiedSession(context);
  const authority = databaseRow(user, "user_authority");
  const telegramId = positiveInteger(authority.telegramId, "invalid_user_authority");
  if (telegramId !== session.telegramId) fail("cross_owner");
  if (authority.isBlocked === true || authority.isBlocked === 1) {
    fail("actor_blocked");
  }
  return {
    session,
    telegramId,
    roles: normalizeRoleRows(roleRows, telegramId),
  };
};

const requirePartner = (actor) => {
  if (!actor.roles.has("partner")) fail("partner_required");
};

const requireAdmin = (actor) => {
  if (!actor.roles.has("admin")) fail("admin_required");
};

const normalizeText = (value, {
  minimum = 0,
  maximum,
  allowEmpty = minimum === 0,
  code = "invalid_payload",
} = {}) => {
  if (typeof value !== "string") fail(code);
  const text = value.normalize("NFKC").trim();
  const length = Array.from(text).length;
  if (/\p{Cc}/u.test(text) || length > maximum ||
      (!allowEmpty && length < minimum) ||
      (allowEmpty && length !== 0 && length < minimum)) fail(code);
  return text;
};

const normalizeNullableInteger = (value, maximum) => {
  if (value === null || value === undefined || value === "") return null;
  return nonNegativeInteger(value, maximum);
};

const normalizeOfferTime = (value, endOfDay = false) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") fail("invalid_payload");
  const text = value.trim();
  const expanded = UTC_DATE.test(text)
    ? `${text} ${endOfDay ? "23:59:59" : "00:00:00"}`
    : text.replace("T", " ").replace(/Z$/u, "");
  if (!UTC_TIMESTAMP.test(expanded)) fail("invalid_payload");
  const milliseconds = Date.parse(`${expanded.replace(" ", "T")}Z`);
  if (!Number.isFinite(milliseconds)) fail("invalid_payload");
  const date = new Date(milliseconds);
  const canonical = date.toISOString().slice(0, 19).replace("T", " ");
  if (canonical !== expanded.slice(0, 19)) fail("invalid_payload");
  return canonical;
};

const normalizeOfferContent = (value, { partial = false } = {}) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_payload");
  }
  try {
    assertClientPayloadAllowed("offer", value);
  } catch {
    fail("invalid_payload");
  }
  if (Object.hasOwn(value, "url") || Object.hasOwn(value, "urlEnvKey")) {
    fail("invalid_payload");
  }
  const result = {};
  const text = [
    ["buttonText", 1, 60],
    ["title", 1, 180],
    ["description", 0, 1200],
    ["provider", 0, 120],
    ["payoutText", 0, 200],
    ["requiredAction", 0, 500],
    ["geo", 0, 160],
    ["trafficSources", 0, 500],
    ["sourceName", 0, 160],
  ];
  for (const [field, minimum, maximum] of text) {
    if (Object.hasOwn(value, field)) {
      result[field] = normalizeText(value[field], {
        minimum,
        maximum,
        allowEmpty: minimum === 0,
      });
    } else if (!partial) {
      result[field] = field === "buttonText" ? "✨ Новый оффер"
        : field === "title" ? "Новый приватный оффер" : "";
    }
  }
  if (Object.hasOwn(value, "category")) {
    if (!CATEGORY.has(value.category)) fail("invalid_payload");
    result.category = value.category;
  } else if (!partial) {
    result.category = "other";
  }
  for (const [field, maximum] of [["minAge", 100], ["maxAge", 100], ["holdDays", 3650]]) {
    if (Object.hasOwn(value, field)) {
      result[field] = normalizeNullableInteger(value[field], maximum);
    } else if (!partial) {
      result[field] = null;
    }
  }
  if (Object.hasOwn(value, "startsAt")) {
    result.startsAt = normalizeOfferTime(value.startsAt, false);
  } else if (!partial) {
    result.startsAt = null;
  }
  if (Object.hasOwn(value, "expiresAt")) {
    result.expiresAt = normalizeOfferTime(value.expiresAt, true);
  } else if (!partial) {
    result.expiresAt = null;
  }
  if (Object.hasOwn(value, "partnerLinkId")) {
    result.partnerLinkId = positiveInteger(value.partnerLinkId, "invalid_route");
  }
  if (partial && Object.keys(result).length === 0) fail("invalid_payload");
  return result;
};

const offerCode = (value) => {
  if (typeof value !== "string" || !OFFER_CODE.test(value)) {
    fail("invalid_offer");
  }
  return value;
};

const serverKey = (value) => {
  if (typeof value !== "string" || !SERVER_KEY.test(value)) {
    fail("invalid_idempotency_key");
  }
  return value;
};

const eventKeyFor = async (operation, idempotencyKey) => {
  const digest = await sha256Hex(
    `${OFFER_LIFECYCLE_VERSION}\n${operation}\n${serverKey(idempotencyKey)}`,
  );
  const result = `offer-lifecycle:${operation}:${digest}`;
  if (!EVENT_KEY.test(result)) fail("invalid_event_key", 500);
  return result;
};

const commandIdFor = async (operation, discriminator) =>
  `olc_${await sha256Hex(`${operation}\n${discriminator}`)}`;

const contentHash = async (snapshotJson) =>
  `sha256:${await sha256Hex(snapshotJson)}`;

const normalizeProfile = (value) => {
  const row = databaseRow(value, "partner_profile");
  const id = positiveInteger(row.id, "invalid_partner_profile");
  const telegramId = positiveInteger(
    row.telegramId,
    "invalid_partner_profile",
  );
  if (!new Set(["active", "paused"]).has(row.status)) {
    fail("invalid_partner_profile");
  }
  return { row, id, telegramId, status: row.status };
};

const normalizeBetaSettings = (value) => {
  const row = databaseRow(value, "beta_settings");
  return {
    enabled: databaseBoolean(row.enabled, "invalid_beta_settings"),
    privateOffersEnabled: databaseBoolean(
      row.privateOffersEnabled,
      "invalid_beta_settings",
    ),
    submissionsEnabled: databaseBoolean(
      row.submissionsEnabled,
      "invalid_beta_settings",
    ),
    publicVisibilityEnabled: databaseBoolean(
      row.publicVisibilityEnabled,
      "invalid_beta_settings",
    ),
    maxActiveOffersPerPartner: positiveInteger(
      row.maxActiveOffersPerPartner,
      "invalid_beta_settings",
    ),
  };
};

const normalizeBetaAccess = (value, profileId, nowSeconds) => {
  const row = databaseRow(value, "beta_access");
  if (positiveInteger(row.partnerProfileId, "invalid_beta_access") !== profileId ||
      !new Set(["active", "paused", "revoked"]).has(row.accessStatus)) {
    fail("invalid_beta_access");
  }
  const expiresAt = row.expiresAt === null || row.expiresAt === undefined
    ? null
    : databaseTimeSeconds(row.expiresAt, "invalid_beta_access");
  return {
    active: row.accessStatus === "active" &&
      (expiresAt === null || expiresAt > nowSeconds),
    canCreate: databaseBoolean(
      row.canCreatePrivateOffers,
      "invalid_beta_access",
    ),
    canSubmit: databaseBoolean(row.canSubmitOffers, "invalid_beta_access"),
  };
};

const resolvePartnerAuthority = ({
  context,
  user,
  roleRows,
  partnerProfile,
  betaSettings,
  betaAccess,
  capability,
  nowSeconds,
}) => {
  const actor = resolveActor({ context, user, roleRows });
  requirePartner(actor);
  if (actor.roles.has("admin")) fail("admin_content_edit_forbidden", 403);
  const profile = normalizeProfile(partnerProfile);
  if (profile.telegramId !== actor.telegramId) fail("cross_owner");
  if (profile.status !== "active") fail("partner_required");
  const settings = normalizeBetaSettings(betaSettings);
  const access = normalizeBetaAccess(betaAccess, profile.id, nowSeconds);
  const allowed = settings.enabled && settings.privateOffersEnabled &&
    access.active && (capability === "submit"
      ? settings.submissionsEnabled && access.canSubmit
      : access.canCreate);
  if (!allowed) fail("partner_beta_required");
  return { actor, profile, settings, access };
};

const normalizeActiveCount = (value, profileId) => {
  const row = databaseRow(value, "offer_count");
  if (positiveInteger(row.partnerProfileId, "invalid_offer_count") !== profileId) {
    fail("cross_owner");
  }
  return nonNegativeInteger(row.activeOfferCount, 1_000_000, "invalid_offer_count");
};

const normalizeOwner = (value, code) => {
  const row = databaseRow(value, "offer_owner");
  if (offerCode(row.offerCode) !== code ||
      !new Set(["system", "partner"]).has(row.ownerKind)) {
    fail("invalid_offer_owner");
  }
  const partnerProfileId = row.ownerKind === "partner"
    ? positiveInteger(row.partnerProfileId, "invalid_offer_owner")
    : null;
  if (row.ownerKind === "system" && row.partnerProfileId !== null &&
      row.partnerProfileId !== undefined) fail("invalid_offer_owner");
  return { row, ownerKind: row.ownerKind, partnerProfileId };
};

const normalizeRoot = (value) => {
  const row = databaseRow(value, "offer");
  const code = offerCode(row.code);
  if (!BUSINESS.has(row.status) || !CATEGORY.has(row.category)) {
    fail("invalid_offer");
  }
  return { row, code, status: row.status };
};

const normalizeVersion = (value, code) => {
  const row = databaseRow(value, "offer_version");
  if (offerCode(row.offerCode) !== code || !BUSINESS.has(row.businessStatus)) {
    fail("invalid_offer_version");
  }
  const id = positiveInteger(row.id, "invalid_offer_version");
  const versionNumber = positiveInteger(
    row.versionNumber,
    "invalid_offer_version",
  );
  if (typeof row.snapshotJson !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(row.contentHash)) {
    fail("invalid_offer_version");
  }
  return { row, id, versionNumber };
};

const nullablePositive = (value, code) => value === null || value === undefined
  ? null
  : positiveInteger(value, code);

const normalizeRule = (value, code) => {
  const row = databaseRow(value, "visibility_rule");
  if (offerCode(row.offerCode) !== code ||
      !MODERATION.has(row.moderationStatus) ||
      !VISIBILITY.has(row.visibility)) fail("invalid_visibility_rule");
  return {
    row,
    moderationStatus: row.moderationStatus,
    visibility: row.visibility,
    currentVersionId: positiveInteger(
      row.currentVersionId,
      "invalid_visibility_rule",
    ),
    submittedVersionId: nullablePositive(
      row.submittedVersionId,
      "invalid_visibility_rule",
    ),
    approvedVersionId: nullablePositive(
      row.approvedVersionId,
      "invalid_visibility_rule",
    ),
  };
};

const normalizeOfferAggregate = ({
  offer,
  owner,
  currentVersion,
  visibilityRule,
}) => {
  const root = normalizeRoot(offer);
  const normalizedOwner = normalizeOwner(owner, root.code);
  const version = normalizeVersion(currentVersion, root.code);
  const rule = normalizeRule(visibilityRule, root.code);
  if (rule.currentVersionId !== version.id ||
      version.row.businessStatus !== root.status) fail("version_conflict");
  if (normalizedOwner.ownerKind === "partner" &&
      (String(root.row.url ?? "") !== "" ||
       String(root.row.urlEnvKey ?? "") !== "")) fail("invalid_offer");
  return { root, owner: normalizedOwner, version, rule };
};

const requireOwnedAggregate = (aggregate, profileId) => {
  if (aggregate.owner.ownerKind !== "partner" ||
      aggregate.owner.partnerProfileId !== profileId) fail("cross_owner");
};

const parseAllowedDomains = (value) => {
  if (typeof value !== "string") fail("invalid_route");
  const domains = value.split(/[\s,;]+/u).map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (domains.length === 0 || domains.length > 100) fail("invalid_route");
  for (const domain of domains) {
    const labels = domain.split(".");
    if (domain.length > 253 || labels.length < 2 ||
        labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
          .test(label))) fail("invalid_route");
  }
  return domains;
};

const normalizeRouteReference = (value, profileId) => {
  const row = databaseRow(value, "partner_route");
  const partnerLinkId = positiveInteger(row.partnerLinkId, "invalid_route");
  if (positiveInteger(row.partnerProfileId, "invalid_route") !== profileId) {
    fail("invalid_route");
  }
  return { row, partnerLinkId, partnerProfileId: profileId };
};

const normalizeRoute = (value, profileId) => {
  const reference = normalizeRouteReference(value, profileId);
  const { row, partnerLinkId } = reference;
  if (row.ownerProfileStatus !== "active" ||
      row.partnerLinkStatus !== "approved" ||
      !databaseBoolean(row.ownershipConfirmed, "invalid_route") ||
      !databaseBoolean(row.trafficConfirmed, "invalid_route") ||
      row.catalogOfferStatus !== "active" || row.programStatus !== "active" ||
      row.catalogBusinessStatus !== "active") fail("invalid_route");
  const catalogOfferId = positiveInteger(row.catalogOfferId, "invalid_route");
  const catalogOfferCode = offerCode(row.catalogOfferCode);
  const programCode = normalizeText(row.programCode, {
    minimum: 2,
    maximum: 32,
    allowEmpty: false,
    code: "invalid_route",
  });
  if (!/^[a-z0-9_-]{2,32}$/u.test(programCode)) fail("invalid_route");
  let url;
  try {
    url = new URL(row.url);
  } catch {
    fail("invalid_route");
  }
  const host = url.hostname.toLowerCase();
  const allowed = parseAllowedDomains(row.allowedDomains);
  if (url.protocol !== "https:" || url.username || url.password ||
      row.url.length > 1_000 || host === "localhost" || host.endsWith(".local") ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) || host.includes(":") ||
      !allowed.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    fail("invalid_route");
  }
  const trackingKey = normalizeText(row.trackingKey, {
    minimum: 3,
    maximum: 160,
    allowEmpty: false,
    code: "invalid_route",
  });
  return {
    ...reference,
    url: url.toString(),
    trackingKey,
    catalogOfferId,
    catalogOfferCode,
    programCode,
  };
};

const rootContent = (row) => ({
  buttonText: String(row.buttonText ?? ""),
  title: String(row.title ?? ""),
  description: String(row.description ?? ""),
  provider: String(row.provider ?? ""),
  category: String(row.category ?? "other"),
  payoutText: String(row.payoutText ?? ""),
  requiredAction: String(row.requiredAction ?? ""),
  minAge: row.minAge === null || row.minAge === undefined ? null : Number(row.minAge),
  maxAge: row.maxAge === null || row.maxAge === undefined ? null : Number(row.maxAge),
  geo: String(row.geo ?? ""),
  holdDays: row.holdDays === null || row.holdDays === undefined
    ? null : Number(row.holdDays),
  trafficSources: String(row.trafficSources ?? ""),
  sourceName: String(row.sourceName ?? ""),
  startsAt: row.startsAt ?? null,
  expiresAt: row.expiresAt ?? null,
});

const mergeContent = (root, patch) => ({ ...rootContent(root), ...patch });

const validateContentConsistency = (content) => {
  const normalized = normalizeOfferContent(content);
  if (normalized.minAge !== null && normalized.maxAge !== null &&
      normalized.minAge > normalized.maxAge) fail("invalid_payload");
  if (normalized.startsAt && normalized.expiresAt &&
      normalized.startsAt >= normalized.expiresAt) fail("invalid_payload");
  return normalized;
};

const buildSnapshot = ({ code, content, businessStatus, route }) => ({
  code,
  button_text: content.buttonText,
  title: content.title,
  description: content.description,
  provider: content.provider,
  category: content.category,
  url: "",
  url_env_key: "",
  payout_text: content.payoutText,
  required_action: content.requiredAction,
  min_age: content.minAge,
  max_age: content.maxAge,
  geo: content.geo,
  hold_days: content.holdDays,
  traffic_sources: content.trafficSources,
  source_name: content.sourceName,
  starts_at: content.startsAt,
  expires_at: content.expiresAt,
  status: businessStatus,
  partner_link_id: route?.partnerLinkId ?? null,
  partner_link_url: route?.url ?? "",
  partner_link_tracking_key: route?.trackingKey ?? "",
  partner_link_status: route ? "approved" : "",
  partner_link_ownership_confirmed: route ? 1 : 0,
  partner_link_traffic_confirmed: route ? 1 : 0,
  partner_link_updated_at: route?.row.updatedAt ?? "",
  catalog_offer_id: route?.catalogOfferId ?? null,
  catalog_offer_code: route?.catalogOfferCode ?? "",
  program_code: route?.programCode ?? "",
});

const snapshotFor = async (args) => {
  const snapshot = buildSnapshot(args);
  const snapshotJson = JSON.stringify(snapshot);
  return { snapshot, snapshotJson, contentHash: await contentHash(snapshotJson) };
};

const parseTrustedSnapshot = async (version) => {
  let snapshot;
  try {
    snapshot = JSON.parse(version.row.snapshotJson);
  } catch {
    fail("invalid_offer_version");
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
      await contentHash(version.row.snapshotJson) !== version.row.contentHash) {
    fail("invalid_offer_version");
  }
  return snapshot;
};

const validateSubmissionSnapshot = (snapshot, route, code) => {
  if (snapshot.code !== code || snapshot.status !== "active" ||
      normalizeText(snapshot.button_text, { minimum: 1, maximum: 60, allowEmpty: false }) === "" ||
      normalizeText(snapshot.title, { minimum: 3, maximum: 180, allowEmpty: false }) === "" ||
      normalizeText(snapshot.description, { minimum: 20, maximum: 1200, allowEmpty: false }) === "" ||
      normalizeText(snapshot.provider, { minimum: 2, maximum: 120, allowEmpty: false }) === "" ||
      normalizeText(snapshot.payout_text, { minimum: 1, maximum: 200, allowEmpty: false }) === "" ||
      normalizeText(snapshot.required_action, { minimum: 5, maximum: 500, allowEmpty: false }) === "" ||
      normalizeText(snapshot.geo, { minimum: 2, maximum: 160, allowEmpty: false }) === "" ||
      normalizeText(snapshot.traffic_sources, { minimum: 2, maximum: 500, allowEmpty: false }) === "" ||
      normalizeText(snapshot.source_name, { minimum: 2, maximum: 160, allowEmpty: false }) === "" ||
      !CATEGORY.has(snapshot.category) || snapshot.url !== "" ||
      snapshot.url_env_key !== "" ||
      Number(snapshot.partner_link_id) !== route.partnerLinkId ||
      snapshot.partner_link_url !== route.url ||
      snapshot.partner_link_tracking_key !== route.trackingKey ||
      Number(snapshot.catalog_offer_id) !== route.catalogOfferId ||
      snapshot.catalog_offer_code !== route.catalogOfferCode ||
      snapshot.program_code !== route.programCode) fail("incomplete_offer");
};

const noChange = (operation, outcome, code = null) => deepFreeze({
  commandVersion: 1,
  operation,
  outcome,
  offerCode: code,
  transactionRequired: false,
  writes: [],
});

export async function derivePartnerOfferCode({
  partnerProfileId,
  idempotencyKey,
} = {}) {
  const profileId = positiveInteger(partnerProfileId, "invalid_partner_profile");
  const digest = await sha256Hex(
    `${OFFER_LIFECYCLE_VERSION}\ncreate\n${profileId}\n${serverKey(idempotencyKey)}`,
  );
  return `po_${profileId.toString(36)}_${digest.slice(0, 12)}`.slice(0, 24);
}

export async function buildPartnerOfferCreateCommand({
  context,
  user,
  roleRows,
  partnerProfile,
  betaSettings,
  betaAccess,
  activeOfferCount,
  existingOffer = null,
  idempotencyKey,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const now = timestamp(nowSeconds);
  const authority = resolvePartnerAuthority({
    context, user, roleRows, partnerProfile, betaSettings, betaAccess,
    capability: "create", nowSeconds: now,
  });
  const code = await derivePartnerOfferCode({
    partnerProfileId: authority.profile.id,
    idempotencyKey,
  });
  if (existingOffer !== null) {
    if (!existingOffer || typeof existingOffer !== "object" ||
        Array.isArray(existingOffer)) fail("offer_conflict");
    const aggregate = normalizeOfferAggregate(existingOffer);
    requireOwnedAggregate(aggregate, authority.profile.id);
    if (aggregate.root.code !== code) fail("offer_conflict");
    return noChange("partner_offer.create_draft", "existing_owned", code);
  }
  const count = normalizeActiveCount(activeOfferCount, authority.profile.id);
  if (count >= authority.settings.maxActiveOffersPerPartner) {
    fail("offer_limit_reached", 409);
  }
  const content = normalizeOfferContent({});
  const version = await snapshotFor({
    code,
    content,
    businessStatus: "draft",
    route: null,
  });
  return deepFreeze({
    commandVersion: 1,
    commandId: await commandIdFor("create", code),
    operation: "partner_offer.create_draft",
    offerCode: code,
    transactionRequired: true,
    idempotency: { uniqueOfferCode: code, conflictResult: "return_existing_owned" },
    limitGuard: {
      partnerProfileId: authority.profile.id,
      activeLessThan: authority.settings.maxActiveOffersPerPartner,
    },
    writes: [
      {
        table: "offers",
        action: "insert_unique_code_if_limit",
        values: {
          code,
          ...content,
          url: "",
          urlEnvKey: "",
          status: "draft",
          sortOrder: 1_000,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        table: "offer_owners",
        action: "insert_partner_owner",
        values: {
          offerCode: code,
          ownerKind: "partner",
          partnerProfileId: authority.profile.id,
          createdBy: authority.actor.telegramId,
          updatedBy: authority.actor.telegramId,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        table: "offer_versions",
        action: "append_version_with_inserted_id",
        reference: "inserted_version_id",
        values: {
          offerCode: code,
          versionNumber: 1,
          snapshotSchemaVersion: 1,
          snapshotJson: version.snapshotJson,
          businessStatus: "draft",
          contentHash: version.contentHash,
          createdBy: authority.actor.telegramId,
          createdAt: now,
        },
      },
      {
        table: "offer_visibility_rules",
        action: "insert_private_rule",
        values: {
          offerCode: code,
          moderationStatus: "not_submitted",
          visibility: "private",
          currentVersionId: "inserted_version_id",
          submittedVersionId: null,
          approvedVersionId: null,
          publishedAt: null,
          updatedBy: authority.actor.telegramId,
          updatedAt: now,
        },
      },
      {
        table: "admin_audit_log",
        action: "append_if_offer_created",
        values: {
          actorId: authority.actor.telegramId,
          action: "partner_offer_created",
          entityType: "offer",
          entityId: code,
          details: "private_draft;version=1",
          createdAt: now,
        },
      },
    ],
    forbiddenSideEffects: ["publish", "approve", "grant_partner_beta"],
  });
}

export async function buildPartnerOfferVersionCommand({
  context,
  user,
  roleRows,
  partnerProfile,
  betaSettings,
  betaAccess,
  offer,
  owner,
  currentVersion,
  visibilityRule,
  currentRoute = null,
  selectedRoute = null,
  patch,
  desiredBusinessStatus = null,
  expectedVersionId,
  idempotencyKey,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const now = timestamp(nowSeconds);
  const authority = resolvePartnerAuthority({
    context, user, roleRows, partnerProfile, betaSettings, betaAccess,
    capability: "create", nowSeconds: now,
  });
  const aggregate = normalizeOfferAggregate({
    offer, owner, currentVersion, visibilityRule,
  });
  requireOwnedAggregate(aggregate, authority.profile.id);
  const expected = positiveInteger(expectedVersionId, "version_conflict");
  if (aggregate.rule.moderationStatus === "pending" ||
      aggregate.root.status === "archived") fail("offer_conflict");
  const normalizedPatch = patch === null || patch === undefined
    ? {}
    : normalizeOfferContent(patch, { partial: true });
  let status = aggregate.root.status;
  if (desiredBusinessStatus !== null) {
    if (!BUSINESS.has(desiredBusinessStatus) || desiredBusinessStatus === "draft" &&
        aggregate.root.status !== "draft" || aggregate.root.status === "archived") {
      fail("invalid_payload");
    }
    if (desiredBusinessStatus === "archived" ||
        desiredBusinessStatus === "active" || desiredBusinessStatus === "paused") {
      status = desiredBusinessStatus;
    }
  }
  const requestedRouteId = normalizedPatch.partnerLinkId;
  delete normalizedPatch.partnerLinkId;
  const oldRouteReference = currentRoute === null ? null
    : normalizeRouteReference(currentRoute, authority.profile.id);
  const route = requestedRouteId !== undefined
    ? normalizeRoute(selectedRoute, authority.profile.id)
    : status === "archived"
      ? null
      : currentRoute === null
        ? null
        : normalizeRoute(currentRoute, authority.profile.id);
  if (requestedRouteId !== undefined && route.partnerLinkId !== requestedRouteId) {
    fail("invalid_route");
  }
  const content = validateContentConsistency(
    mergeContent(aggregate.root.row, normalizedPatch),
  );
  const candidate = await snapshotFor({
    code: aggregate.root.code,
    content,
    businessStatus: status,
    route,
  });
  if (candidate.contentHash === aggregate.version.row.contentHash) {
    return noChange(
      "partner_offer.create_version",
      "unchanged",
      aggregate.root.code,
    );
  }
  if (expected !== aggregate.version.id) fail("version_conflict");
  const eventKey = await eventKeyFor("version.create", idempotencyKey);
  const nextVersionNumber = aggregate.version.versionNumber + 1;
  const writes = [
    {
      table: "offers",
      action: "compare_and_swap_current_version",
      key: aggregate.root.code,
      expectedVersionId: aggregate.version.id,
      values: {
        ...content,
        url: "",
        urlEnvKey: "",
        status,
        updatedAt: now,
      },
    },
  ];
  if ((oldRouteReference?.partnerLinkId ?? null) !==
      (route?.partnerLinkId ?? null)) {
    writes.push({
      table: "partner_offer_links",
      action: route ? "upsert_owned_approved_route" : "delete_owned_route",
      values: route ? {
        offerCode: aggregate.root.code,
        partnerLinkId: route.partnerLinkId,
        selectedBy: authority.actor.telegramId,
        selectedAt: now,
        updatedAt: now,
      } : { offerCode: aggregate.root.code },
    });
  }
  writes.push(
    {
      table: "offer_versions",
      action: "append_next_version",
      reference: "inserted_version_id",
      expectedCurrentVersionId: aggregate.version.id,
      values: {
        offerCode: aggregate.root.code,
        versionNumber: nextVersionNumber,
        snapshotSchemaVersion: 1,
        snapshotJson: candidate.snapshotJson,
        businessStatus: status,
        contentHash: candidate.contentHash,
        createdBy: authority.actor.telegramId,
        createdAt: now,
      },
    },
    {
      table: "offer_visibility_rules",
      action: "compare_and_swap_reset_private",
      key: aggregate.root.code,
      expectedCurrentVersionId: aggregate.version.id,
      expectedModerationStatus: aggregate.rule.moderationStatus,
      values: {
        moderationStatus: "not_submitted",
        visibility: "private",
        currentVersionId: "inserted_version_id",
        submittedVersionId: null,
        approvedVersionId: null,
        publishedAt: null,
        updatedBy: authority.actor.telegramId,
        updatedAt: now,
      },
    },
    {
      table: "offer_owners",
      action: "touch_owned_partner_offer",
      values: {
        offerCode: aggregate.root.code,
        partnerProfileId: authority.profile.id,
        updatedBy: authority.actor.telegramId,
        updatedAt: now,
      },
    },
  );
  if (aggregate.rule.moderationStatus === "approved") {
    writes.push({
      table: "offer_moderation_decisions",
      action: "append_unique_event",
      values: {
        offerCode: aggregate.root.code,
        offerVersionId: "inserted_version_id",
        decision: "approval_invalidated",
        fromStatus: "approved",
        toStatus: "not_submitted",
        actorId: authority.actor.telegramId,
        actorRole: "partner",
        reason: "owner_created_new_version",
        eventKey,
        createdAt: now,
      },
    });
  }
  writes.push({
    table: "admin_audit_log",
    action: "append_if_version_created",
    values: {
      actorId: authority.actor.telegramId,
      action: "partner_offer_version_created",
      entityType: "offer",
      entityId: aggregate.root.code,
      details: `version=${nextVersionNumber};event=${eventKey}`,
      createdAt: now,
    },
  });
  return deepFreeze({
    commandVersion: 1,
    commandId: await commandIdFor("version", eventKey),
    operation: "partner_offer.create_version",
    offerCode: aggregate.root.code,
    transactionRequired: true,
    idempotency: {
      eventKey,
      uniqueVersion: [aggregate.root.code, nextVersionNumber],
      conflictResult: "reload_and_compare_content_hash",
    },
    compareAndSwap: {
      fromVersionId: aggregate.version.id,
      toVersionId: "inserted_version_id",
    },
    writes,
    forbiddenSideEffects: ["publish", "moderate", "edit_system_offer"],
  });
}

export async function buildPartnerOfferSubmitCommand({
  context,
  user,
  roleRows,
  partnerProfile,
  betaSettings,
  betaAccess,
  offer,
  owner,
  currentVersion,
  visibilityRule,
  currentRoute,
  expectedVersionId,
  idempotencyKey,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const now = timestamp(nowSeconds);
  const authority = resolvePartnerAuthority({
    context, user, roleRows, partnerProfile, betaSettings, betaAccess,
    capability: "submit", nowSeconds: now,
  });
  const aggregate = normalizeOfferAggregate({
    offer, owner, currentVersion, visibilityRule,
  });
  requireOwnedAggregate(aggregate, authority.profile.id);
  const versionId = positiveInteger(expectedVersionId, "version_conflict");
  if (versionId !== aggregate.version.id) fail("version_conflict");
  if (aggregate.rule.moderationStatus === "pending" &&
      aggregate.rule.submittedVersionId === versionId) {
    return noChange("partner_offer.submit", "already_pending", aggregate.root.code);
  }
  if (aggregate.rule.moderationStatus === "pending" ||
      aggregate.root.status !== "active") fail("offer_conflict");
  const route = normalizeRoute(currentRoute, authority.profile.id);
  const snapshot = await parseTrustedSnapshot(aggregate.version);
  validateSubmissionSnapshot(snapshot, route, aggregate.root.code);
  const eventKey = await eventKeyFor(
    `submit.${aggregate.root.code}.${versionId}`,
    idempotencyKey,
  );
  return deepFreeze({
    commandVersion: 1,
    commandId: await commandIdFor("submit", eventKey),
    operation: "partner_offer.submit",
    offerCode: aggregate.root.code,
    transactionRequired: true,
    idempotency: { eventKey, conflictResult: "return_pending_same_version" },
    compareAndSwap: {
      moderationFrom: aggregate.rule.moderationStatus,
      moderationTo: "pending",
      versionId,
    },
    writes: [
      {
        table: "offer_visibility_rules",
        action: "compare_and_swap_submission",
        values: {
          offerCode: aggregate.root.code,
          moderationStatus: "pending",
          visibility: "private",
          submittedVersionId: versionId,
          approvedVersionId: null,
          publishedAt: null,
          updatedBy: authority.actor.telegramId,
          updatedAt: now,
        },
      },
      {
        table: "offer_moderation_decisions",
        action: "append_unique_event",
        values: {
          offerCode: aggregate.root.code,
          offerVersionId: versionId,
          decision: "submitted",
          fromStatus: aggregate.rule.moderationStatus,
          toStatus: "pending",
          actorId: authority.actor.telegramId,
          actorRole: "partner",
          reason: "exact_current_version_submitted",
          eventKey,
          createdAt: now,
        },
      },
    ],
    forbiddenSideEffects: ["publish", "approve"],
  });
}

export async function buildOfferModerationCommand({
  context,
  user,
  roleRows,
  offer,
  owner,
  ownerProfile,
  currentVersion,
  visibilityRule,
  currentRoute,
  decision,
  reason = "",
  expectedVersionId,
  idempotencyKey,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const actor = resolveActor({ context, user, roleRows });
  requireAdmin(actor);
  const aggregate = normalizeOfferAggregate({
    offer, owner, currentVersion, visibilityRule,
  });
  if (aggregate.owner.ownerKind !== "partner") fail("offer_conflict");
  const profile = normalizeProfile(ownerProfile);
  if (profile.id !== aggregate.owner.partnerProfileId ||
      profile.telegramId === actor.telegramId) fail(
    profile.telegramId === actor.telegramId
      ? "self_review_forbidden"
      : "offer_conflict",
  );
  if (!new Set(["approved", "changes_requested", "rejected"]).has(decision)) {
    fail("invalid_payload");
  }
  const versionId = positiveInteger(expectedVersionId, "version_conflict");
  if (aggregate.rule.moderationStatus === decision &&
      aggregate.rule.submittedVersionId === versionId &&
      (decision !== "approved" || aggregate.rule.approvedVersionId === versionId)) {
    return noChange(`partner_offer.${decision}`, `already_${decision}`, aggregate.root.code);
  }
  if (aggregate.rule.moderationStatus !== "pending" ||
      aggregate.rule.currentVersionId !== versionId ||
      aggregate.rule.submittedVersionId !== versionId) fail("version_conflict");
  const normalizedReason = decision === "approved"
    ? normalizeText(reason, { minimum: 0, maximum: 300, allowEmpty: true })
    : normalizeText(reason, { minimum: 1, maximum: 300, allowEmpty: false });
  if (decision === "approved") {
    if (profile.status !== "active" || aggregate.root.status !== "active") {
      fail("offer_conflict");
    }
    const route = normalizeRoute(currentRoute, profile.id);
    const snapshot = await parseTrustedSnapshot(aggregate.version);
    validateSubmissionSnapshot(snapshot, route, aggregate.root.code);
  }
  const eventKey = await eventKeyFor(
    `moderate.${aggregate.root.code}.${versionId}.${decision}`,
    idempotencyKey,
  );
  return deepFreeze({
    commandVersion: 1,
    commandId: await commandIdFor("moderate", eventKey),
    operation: `partner_offer.${decision}`,
    offerCode: aggregate.root.code,
    transactionRequired: true,
    idempotency: { eventKey, conflictResult: "return_same_final_decision" },
    compareAndSwap: {
      moderationFrom: "pending",
      moderationTo: decision,
      versionId,
    },
    writes: [
      {
        table: "offer_moderation_decisions",
        action: "append_unique_event",
        values: {
          offerCode: aggregate.root.code,
          offerVersionId: versionId,
          decision,
          fromStatus: "pending",
          toStatus: decision,
          actorId: actor.telegramId,
          actorRole: "admin",
          reason: normalizedReason,
          eventKey,
          createdAt: timestamp(nowSeconds),
        },
      },
      {
        table: "offer_visibility_rules",
        action: "compare_and_swap_moderation_after_event",
        values: {
          offerCode: aggregate.root.code,
          moderationStatus: decision,
          visibility: "private",
          submittedVersionId: versionId,
          approvedVersionId: decision === "approved" ? versionId : null,
          publishedAt: null,
          updatedBy: actor.telegramId,
          updatedAt: timestamp(nowSeconds),
        },
      },
    ],
    forbiddenSideEffects: ["publish", "edit_offer_content", "grant_access"],
  });
}

const requireApprovedCurrent = (aggregate) => {
  if (aggregate.root.status !== "active" ||
      aggregate.rule.moderationStatus !== "approved" ||
      aggregate.rule.currentVersionId !== aggregate.rule.approvedVersionId ||
      aggregate.rule.currentVersionId !== aggregate.rule.submittedVersionId) {
    fail("version_conflict");
  }
};

const normalizeAssignmentCount = (value, code) => {
  const row = databaseRow(value, "assignment_count");
  if (offerCode(row.offerCode) !== code) fail("invalid_assignment_count");
  return nonNegativeInteger(
    row.activeAssignmentCount,
    1_000_000,
    "invalid_assignment_count",
  );
};

const normalizeAssignmentTarget = (value, telegramId) => {
  const row = databaseRow(value, "assignment_target");
  if (positiveInteger(row.telegramId, "invalid_assignment_target") !==
      telegramId || row.isBlocked === true || row.isBlocked === 1) {
    fail("invalid_assignment_target");
  }
  return row;
};

export async function buildOfferVisibilityCommand({
  context,
  user,
  roleRows,
  offer,
  owner,
  currentVersion,
  visibilityRule,
  currentRoute,
  betaSettings,
  assignmentCount,
  visibility,
  reason = "",
  expectedVersionId,
  idempotencyKey,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const actor = resolveActor({ context, user, roleRows });
  requireAdmin(actor);
  const aggregate = normalizeOfferAggregate({
    offer, owner, currentVersion, visibilityRule,
  });
  if (aggregate.owner.ownerKind !== "partner") fail("offer_conflict");
  requireApprovedCurrent(aggregate);
  const versionId = positiveInteger(expectedVersionId, "version_conflict");
  if (versionId !== aggregate.version.id || !VISIBILITY.has(visibility)) {
    fail("version_conflict");
  }
  if (aggregate.rule.visibility === visibility) {
    return noChange("partner_offer.set_visibility", "unchanged", aggregate.root.code);
  }
  const settings = normalizeBetaSettings(betaSettings);
  if (!settings.enabled || !settings.privateOffersEnabled ||
      (visibility === "public" && !settings.publicVisibilityEnabled)) {
    fail("partner_beta_required");
  }
  if (visibility === "assigned" &&
      normalizeAssignmentCount(assignmentCount, aggregate.root.code) < 1) {
    fail("offer_conflict");
  }
  if (visibility !== "private") {
    const route = normalizeRoute(currentRoute, aggregate.owner.partnerProfileId);
    const snapshot = await parseTrustedSnapshot(aggregate.version);
    validateSubmissionSnapshot(snapshot, route, aggregate.root.code);
  }
  const eventKey = await eventKeyFor(
    `visibility.${aggregate.root.code}.${versionId}.${visibility}`,
    idempotencyKey,
  );
  const normalizedReason = normalizeText(reason, {
    minimum: 0,
    maximum: 300,
    allowEmpty: true,
  });
  return deepFreeze({
    commandVersion: 1,
    commandId: await commandIdFor("visibility", eventKey),
    operation: "partner_offer.set_visibility",
    offerCode: aggregate.root.code,
    transactionRequired: true,
    idempotency: { eventKey, conflictResult: "return_current_visibility" },
    compareAndSwap: {
      fromVisibility: aggregate.rule.visibility,
      toVisibility: visibility,
      versionId,
    },
    writes: [
      {
        table: "offer_moderation_decisions",
        action: "append_unique_event",
        values: {
          offerCode: aggregate.root.code,
          offerVersionId: versionId,
          decision: "visibility_changed",
          fromStatus: aggregate.rule.visibility,
          toStatus: visibility,
          actorId: actor.telegramId,
          actorRole: "admin",
          reason: normalizedReason || "admin_visibility_change",
          eventKey,
          createdAt: timestamp(nowSeconds),
        },
      },
      {
        table: "offer_visibility_rules",
        action: "compare_and_swap_visibility_after_event",
        values: {
          offerCode: aggregate.root.code,
          visibility,
          publishedAt: visibility === "private" ? null : timestamp(nowSeconds),
          updatedBy: actor.telegramId,
          updatedAt: timestamp(nowSeconds),
        },
      },
    ],
    forbiddenSideEffects: ["edit_offer_content", "change_moderation"],
  });
}

export async function buildOfferAssignmentCommand({
  context,
  user,
  roleRows,
  offer,
  owner,
  currentVersion,
  visibilityRule,
  existingAssignment = null,
  targetTelegramId,
  targetUser,
  action,
  assignmentCount,
  reason = "",
  idempotencyKey,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  const actor = resolveActor({ context, user, roleRows });
  requireAdmin(actor);
  const aggregate = normalizeOfferAggregate({
    offer, owner, currentVersion, visibilityRule,
  });
  if (aggregate.owner.ownerKind !== "partner") fail("offer_conflict");
  requireApprovedCurrent(aggregate);
  const target = positiveInteger(targetTelegramId, "invalid_payload");
  if (target === actor.telegramId) fail("self_assignment_forbidden", 403);
  normalizeAssignmentTarget(targetUser, target);
  if (action !== "assign" && action !== "revoke") fail("invalid_payload");
  const assignment = databaseRow(existingAssignment, "offer_assignment", {
    optional: true,
  });
  if (assignment && (offerCode(assignment.offerCode) !== aggregate.root.code ||
      positiveInteger(assignment.telegramId, "invalid_offer_assignment") !== target ||
      !new Set(["active", "revoked"]).has(assignment.assignmentStatus))) {
    fail("invalid_offer_assignment");
  }
  if (assignment) {
    positiveInteger(assignment.assignedBy, "invalid_offer_assignment");
    databaseTimeSeconds(assignment.assignedAt, "invalid_offer_assignment");
  }
  const desired = action === "assign" ? "active" : "revoked";
  if ((!assignment && action === "revoke") ||
      assignment?.assignmentStatus === desired) {
    return noChange(
      "partner_offer.assignment",
      action === "assign" ? "already_assigned" : "already_revoked",
      aggregate.root.code,
    );
  }
  const count = normalizeAssignmentCount(
    assignmentCount,
    aggregate.root.code,
  );
  const forcesPrivate = action === "revoke" && count === 1 &&
    aggregate.rule.visibility === "assigned";
  const eventKey = await eventKeyFor(
    `assignment.${aggregate.root.code}.${aggregate.version.id}.${target}.${action}`,
    idempotencyKey,
  );
  const now = timestamp(nowSeconds);
  const normalizedReason = normalizeText(reason, {
    minimum: action === "revoke" ? 1 : 0,
    maximum: 300,
    allowEmpty: action !== "revoke",
  });
  const writes = [
    {
      table: "offer_visibility_assignments",
      action: action === "assign" ? "upsert_active" : "compare_and_swap_revoke",
      values: {
        offerCode: aggregate.root.code,
        telegramId: target,
        assignmentStatus: desired,
        assignedBy: action === "assign" ? actor.telegramId
          : assignment?.assignedBy,
        assignedAt: action === "assign" ? now : assignment?.assignedAt,
        revokedBy: action === "revoke" ? actor.telegramId : null,
        revokedAt: action === "revoke" ? now : null,
        updatedAt: now,
      },
    },
    {
      table: "offer_visibility_assignment_events",
      action: "append_unique_event",
      values: {
        offerCode: aggregate.root.code,
        offerVersionId: aggregate.version.id,
        telegramId: target,
        action: action === "assign" ? "assigned" : "revoked",
        actorId: actor.telegramId,
        actorRole: "admin",
        reason: normalizedReason,
        eventKey,
        createdAt: now,
      },
    },
  ];
  if (forcesPrivate) {
    const visibilityEventKey = `${eventKey}:private`;
    writes.push(
      {
        table: "offer_moderation_decisions",
        action: "append_unique_event",
        values: {
          offerCode: aggregate.root.code,
          offerVersionId: aggregate.version.id,
          decision: "visibility_changed",
          fromStatus: "assigned",
          toStatus: "private",
          actorId: actor.telegramId,
          actorRole: "admin",
          reason: "last_assignment_revoked",
          eventKey: visibilityEventKey,
          createdAt: now,
        },
      },
      {
        table: "offer_visibility_rules",
        action: "compare_and_swap_visibility_after_event",
        values: {
          offerCode: aggregate.root.code,
          visibility: "private",
          publishedAt: null,
          updatedBy: actor.telegramId,
          updatedAt: now,
        },
      },
    );
  }
  return deepFreeze({
    commandVersion: 1,
    commandId: await commandIdFor("assignment", eventKey),
    operation: "partner_offer.assignment",
    offerCode: aggregate.root.code,
    transactionRequired: true,
    idempotency: { eventKey, conflictResult: "return_current_assignment" },
    writes,
    forcedVisibility: forcesPrivate ? "private" : null,
    forbiddenSideEffects: ["change_moderation", "edit_offer_content"],
  });
}

const publicFields = (snapshot) => deepFreeze({
  code: snapshot.code,
  buttonText: snapshot.button_text,
  title: snapshot.title,
  description: snapshot.description,
  provider: snapshot.provider,
  category: snapshot.category,
  payoutText: snapshot.payout_text,
  requiredAction: snapshot.required_action,
  minAge: snapshot.min_age,
  maxAge: snapshot.max_age,
  geo: snapshot.geo,
  holdDays: snapshot.hold_days,
  trafficSources: snapshot.traffic_sources,
  sourceName: snapshot.source_name,
  startsAt: snapshot.starts_at,
  expiresAt: snapshot.expires_at,
  actionUrl: snapshot.partner_link_url,
});

const projectApprovedOffer = async ({
  aggregate,
  currentRoute,
  betaSettings,
  requiredVisibility,
}) => {
  if (aggregate.root.status !== "active" ||
      aggregate.rule.moderationStatus !== "approved" ||
      aggregate.rule.currentVersionId !== aggregate.rule.approvedVersionId ||
      aggregate.rule.currentVersionId !== aggregate.rule.submittedVersionId) {
    fail("offer_not_public");
  }
  if (aggregate.rule.visibility !== requiredVisibility) fail("offer_not_public");
  const settings = normalizeBetaSettings(betaSettings);
  if (!settings.enabled || !settings.privateOffersEnabled ||
      (requiredVisibility === "public" && !settings.publicVisibilityEnabled)) {
    fail("offer_not_public");
  }
  try {
    const route = normalizeRoute(currentRoute, aggregate.owner.partnerProfileId);
    const snapshot = await parseTrustedSnapshot(aggregate.version);
    validateSubmissionSnapshot(snapshot, route, aggregate.root.code);
    return publicFields(snapshot);
  } catch {
    fail("offer_not_public");
  }
};

export async function projectPublicPartnerOffer({
  offer,
  owner,
  currentVersion,
  visibilityRule,
  currentRoute,
  betaSettings,
} = {}) {
  const aggregate = normalizeOfferAggregate({
    offer, owner, currentVersion, visibilityRule,
  });
  if (aggregate.owner.ownerKind !== "partner") fail("offer_not_public");
  return deepFreeze({
    projectionVersion: 1,
    visibility: "public",
    offer: await projectApprovedOffer({
      aggregate, currentRoute, betaSettings, requiredVisibility: "public",
    }),
  });
}

export async function projectAssignedPartnerOffer({
  context,
  user,
  roleRows = [],
  offer,
  owner,
  currentVersion,
  visibilityRule,
  currentRoute,
  betaSettings,
  assignment,
} = {}) {
  const actor = resolveActor({ context, user, roleRows });
  const aggregate = normalizeOfferAggregate({
    offer, owner, currentVersion, visibilityRule,
  });
  if (aggregate.owner.ownerKind !== "partner") fail("offer_not_public");
  const row = databaseRow(assignment, "offer_assignment");
  if (offerCode(row.offerCode) !== aggregate.root.code ||
      positiveInteger(row.telegramId, "invalid_offer_assignment") !== actor.telegramId ||
      row.assignmentStatus !== "active") fail("offer_not_public");
  return deepFreeze({
    projectionVersion: 1,
    visibility: "assigned",
    offer: await projectApprovedOffer({
      aggregate, currentRoute, betaSettings, requiredVisibility: "assigned",
    }),
  });
}

export function projectOwnPartnerOffer({
  context,
  user,
  roleRows,
  partnerProfile,
  offer,
  owner,
  currentVersion,
  visibilityRule,
} = {}) {
  const actor = resolveActor({ context, user, roleRows });
  requirePartner(actor);
  const profile = normalizeProfile(partnerProfile);
  if (profile.telegramId !== actor.telegramId) fail("cross_owner");
  const aggregate = normalizeOfferAggregate({
    offer, owner, currentVersion, visibilityRule,
  });
  requireOwnedAggregate(aggregate, profile.id);
  const content = rootContent(aggregate.root.row);
  return deepFreeze({
    projectionVersion: 1,
    code: aggregate.root.code,
    content,
    businessStatus: aggregate.root.status,
    moderationStatus: aggregate.rule.moderationStatus,
    visibility: aggregate.rule.visibility,
    version: aggregate.version.versionNumber,
    canEdit: aggregate.root.status !== "archived" &&
      aggregate.rule.moderationStatus !== "pending",
    canSubmit: aggregate.root.status === "active" &&
      aggregate.rule.moderationStatus !== "pending",
  });
}

export function projectAdminPartnerOffer({
  context,
  user,
  roleRows,
  offer,
  owner,
  currentVersion,
  visibilityRule,
} = {}) {
  const actor = resolveActor({ context, user, roleRows });
  requireAdmin(actor);
  const aggregate = normalizeOfferAggregate({
    offer, owner, currentVersion, visibilityRule,
  });
  if (aggregate.owner.ownerKind !== "partner") fail("offer_conflict");
  return deepFreeze({
    projectionVersion: 1,
    code: aggregate.root.code,
    partnerProfileId: aggregate.owner.partnerProfileId,
    content: rootContent(aggregate.root.row),
    businessStatus: aggregate.root.status,
    moderationStatus: aggregate.rule.moderationStatus,
    visibility: aggregate.rule.visibility,
    currentVersionId: aggregate.version.id,
    currentVersionNumber: aggregate.version.versionNumber,
    allowedDecisions: aggregate.rule.moderationStatus === "pending"
      ? ["approved", "changes_requested", "rejected"]
      : [],
  });
}

export function publicOfferLifecycleError(error) {
  const status = error instanceof OfferLifecycleError ? error.status : 500;
  const publicCode = status === 404 ? "not_found"
    : status === 409 ? "request_conflict"
      : status === 403 ? "forbidden"
        : status === 401 ? "unauthorized"
          : status === 400 ? "bad_request"
            : "internal_error";
  return deepFreeze({ status, body: { error: publicCode } });
}
