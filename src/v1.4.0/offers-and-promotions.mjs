import {
  deriveIdempotencyKey,
  sha256Hex,
} from "./cabinet-foundation.mjs";

const encoder = new TextEncoder();

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

export const OFFER_POLICY_VERSION = "2026-09-14.cabinet-v1-part2";
export const OFFER_TECHNICAL_RETENTION_SECONDS = 15_552_000;
export const PROMOTION_POLICY_VERSION = 1;

export const PROMOTION_POLICIES = deepFreeze({
  newcomer_20_72h: {
    discountBasisPoints: 2_000,
    windowSeconds: 259_200,
    windowScope: "user",
    eligibleUserLimit: 1,
    priority: 100,
  },
  monthly_50_48h: {
    discountBasisPoints: 5_000,
    windowSeconds: 172_800,
    windowScope: "global",
    eligibleUserLimit: 10,
    priority: 200,
  },
});

export const PREVIEW_FIELD_ALLOWLIST = deepFreeze({
  minimal: ["button_text", "title", "description", "provider", "category"],
  full: [
    "button_text",
    "title",
    "description",
    "provider",
    "category",
    "payout_text",
    "required_action",
    "min_age",
    "max_age",
    "geo",
    "hold_days",
    "traffic_sources",
    "source_name",
    "starts_at",
    "expires_at",
  ],
});

const PLAN_PRESENTATION = deepFreeze({
  free: "minimal",
  professional: "full",
  dragon: "full",
});

const HEX_64 = /^[0-9a-f]{64}$/u;
const OFFER_CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/u;
const ID_PREFIXES = new Set([
  "sub_",
  "prv_",
  "med_",
  "rev_",
  "map_",
  "pub_",
  "pwn_",
  "pev_",
  "pap_",
]);
const PROHIBITED_PROMOTION_CLIENT_FIELDS = new Set([
  "price",
  "basePrice",
  "base_price",
  "basePriceStars",
  "discount",
  "discountPercent",
  "discountBasisPoints",
  "eligibility",
  "eligible",
  "finalPrice",
  "finalPriceStars",
  "policyCode",
  "selectedPolicyCode",
]);

export class OfferPolicyError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "OfferPolicyError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new OfferPolicyError(code, message);
};

const record = (value, code = "invalid_record") => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
};

const positiveInteger = (value, code = "invalid_integer") => {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
};

const nonNegativeInteger = (value, code = "invalid_integer") => {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
};

const exactBoolean = (value, code = "invalid_boolean") => {
  if (value !== true && value !== false) fail(code);
  return value;
};

const exactText = (value, code, min = 1, max = 512) => {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    fail(code);
  }
  return value;
};

const boundedText = (value, code, max = 2_000) => {
  if (typeof value !== "string" || value.length > max) fail(code);
  return value;
};

const field = (value, camel, snake) => value?.[camel] ?? value?.[snake];

const digest = (value, code = "invalid_hash") => {
  const normalized = String(value || "").toLowerCase().replace(/^sha256:/u, "");
  if (!HEX_64.test(normalized)) fail(code);
  return normalized;
};

const time = (value, code = "invalid_time") => positiveInteger(value, code);

const sourceIsDatabase = (value) =>
  field(value, "authoritySource", "authority_source") === "database";

const bytesToHex = (bytes) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const takeRandomBytes = (length, randomBytes) => {
  const bytes = randomBytes
    ? randomBytes(length)
    : globalThis.crypto?.getRandomValues(new Uint8Array(length));
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    fail("invalid_random_source");
  }
  return bytes;
};

export function createPart2OpaqueId(prefix, randomBytes) {
  if (!ID_PREFIXES.has(prefix)) fail("invalid_id_prefix");
  return `${prefix}${bytesToHex(takeRandomBytes(32, randomBytes))}`;
}

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

export const stableStringify = (value) => JSON.stringify(canonicalize(value));

const hashRecord = (value) => sha256Hex(stableStringify(value));

const enabledOfferSettings = (settings, feature) => {
  const value = record(settings, "invalid_settings");
  return value.configurationAligned === true &&
    value.rolloutMode === "admin_shadow" &&
    value.cabinetMasterEnabled === true &&
    value.cabinetOfferEnabled === true &&
    value.part2Enabled === true &&
    value.lifecycleEnabled === true &&
    value[feature] === true;
};

const actorProjection = (value, expectedRole = null) => {
  const actor = record(value, "invalid_actor");
  const telegramId = positiveInteger(
    field(actor, "telegramId", "telegram_id"),
    "invalid_actor",
  );
  const role = field(actor, "systemRole", "system_role");
  if (!new Set(["user", "partner", "admin"]).has(role) || actor.active !== true) {
    fail("invalid_actor");
  }
  if (expectedRole && role !== expectedRole) fail("role_denied");
  return { telegramId, role };
};

const versionProjection = async (value, offerCode) => {
  const version = record(value, "invalid_version");
  const versionId = positiveInteger(
    field(version, "id", "offer_version_id"),
    "invalid_version",
  );
  if (field(version, "offerCode", "offer_code") !== offerCode) {
    fail("foreign_version");
  }
  const versionNumber = positiveInteger(
    field(version, "versionNumber", "version_number"),
    "invalid_version",
  );
  const snapshotJson = exactText(
    field(version, "snapshotJson", "snapshot_json"),
    "invalid_snapshot",
    2,
    200_000,
  );
  let snapshot;
  try {
    snapshot = JSON.parse(snapshotJson);
  } catch {
    fail("invalid_snapshot");
  }
  record(snapshot, "invalid_snapshot");
  const contentHash = digest(
    field(version, "contentHash", "content_hash"),
    "invalid_content_hash",
  );
  if (await sha256Hex(snapshotJson) !== contentHash) fail("content_hash_mismatch");
  const businessStatus = field(version, "businessStatus", "business_status");
  if (!new Set(["draft", "active", "paused", "archived"]).has(businessStatus)) {
    fail("invalid_business_status");
  }
  return {
    versionId,
    versionNumber,
    snapshotJson,
    snapshot,
    contentHash,
    businessStatus,
  };
};

const stateProjection = (value, offerCode) => {
  const state = record(value, "invalid_offer_state");
  if (!sourceIsDatabase(state)) fail("visibility_not_database_bound");
  if (field(state, "offerCode", "offer_code") !== offerCode) {
    fail("offer_state_mismatch");
  }
  const moderationStatus = field(state, "moderationStatus", "moderation_status");
  const visibility = field(state, "visibility", "visibility");
  if (!new Set([
    "not_submitted", "pending", "changes_requested", "approved", "rejected",
  ]).has(moderationStatus)) fail("invalid_moderation_status");
  if (!new Set(["private", "assigned", "public"]).has(visibility)) {
    fail("invalid_visibility");
  }
  const optionalId = (camel, snake) => {
    const candidate = field(state, camel, snake);
    return candidate === null || candidate === undefined
      ? null
      : positiveInteger(candidate, "invalid_offer_state");
  };
  return {
    offerCode,
    moderationStatus,
    visibility,
    currentVersionId: optionalId("currentVersionId", "current_version_id"),
    submittedVersionId: optionalId("submittedVersionId", "submitted_version_id"),
    approvedVersionId: optionalId("approvedVersionId", "approved_version_id"),
  };
};

const activeUntil = (expiresAt, nowSeconds) => {
  if (expiresAt === null || expiresAt === undefined || expiresAt === "") return true;
  return time(expiresAt, "invalid_authority_expiry") > nowSeconds;
};

export async function buildOfferAuthoritySnapshot({
  offerCode: rawOfferCode,
  actor,
  owner,
  partnerProfile,
  partnerRole,
  betaAccess,
  selection,
  partnerLink,
  programOffer,
  program,
  catalogOffer,
  nowSeconds,
  requireActorOwner = true,
}) {
  const offerCode = exactText(rawOfferCode, "invalid_offer_code", 2, 64);
  if (!OFFER_CODE.test(offerCode)) fail("invalid_offer_code");
  const now = time(nowSeconds);
  const authorityRows = [
    owner, partnerProfile, partnerRole, betaAccess, selection, partnerLink,
    programOffer, program, catalogOffer,
  ].map((value) => record(value, "invalid_authority"));
  if (!authorityRows.every(sourceIsDatabase)) fail("authority_not_database_bound");

  const ownerRow = owner;
  if (field(ownerRow, "offerCode", "offer_code") !== offerCode ||
      field(ownerRow, "ownerKind", "owner_kind") !== "partner") {
    fail("ownership_mismatch");
  }
  const ownerPartnerProfileId = positiveInteger(
    field(ownerRow, "partnerProfileId", "partner_profile_id"),
    "ownership_mismatch",
  );
  const profileId = positiveInteger(
    field(partnerProfile, "id", "partner_profile_id"),
    "partner_inactive",
  );
  const ownerTelegramId = positiveInteger(
    field(partnerProfile, "telegramId", "telegram_id"),
    "partner_inactive",
  );
  if (profileId !== ownerPartnerProfileId || partnerProfile.status !== "active") {
    fail("partner_inactive");
  }
  if (field(partnerRole, "telegramId", "telegram_id") !== ownerTelegramId ||
      partnerRole.role !== "partner" || partnerRole.status !== "active") {
    fail("partner_role_inactive");
  }
  if (field(betaAccess, "partnerProfileId", "partner_profile_id") !== profileId ||
      field(betaAccess, "accessStatus", "access_status") !== "active" ||
      !activeUntil(field(betaAccess, "expiresAt", "expires_at"), now)) {
    fail("partner_beta_inactive");
  }
  if (requireActorOwner) {
    const ownerActor = actorProjection(actor, "partner");
    if (ownerActor.telegramId !== ownerTelegramId ||
        field(actor, "partnerProfileId", "partner_profile_id") !== profileId) {
      fail("cross_owner");
    }
  }

  if (field(selection, "offerCode", "offer_code") !== offerCode) {
    fail("selection_mismatch");
  }
  const selectedLinkId = positiveInteger(
    field(selection, "partnerLinkId", "partner_link_id"),
    "selection_mismatch",
  );
  const linkId = positiveInteger(field(partnerLink, "id", "partner_link_id"),
    "link_inactive");
  const catalogOfferId = positiveInteger(
    field(partnerLink, "catalogOfferId", "catalog_offer_id"),
    "link_inactive",
  );
  if (selectedLinkId !== linkId ||
      field(partnerLink, "partnerProfileId", "partner_profile_id") !== profileId ||
      field(partnerLink, "status", "partner_link_status") !== "approved" ||
      field(partnerLink, "ownershipConfirmed", "ownership_confirmed") !== 1 ||
      field(partnerLink, "trafficConfirmed", "traffic_confirmed") !== 1) {
    fail("link_inactive");
  }

  const programOfferId = positiveInteger(field(programOffer, "id", "id"),
    "program_offer_inactive");
  const programCode = exactText(
    field(programOffer, "programCode", "program_code"),
    "program_offer_inactive",
    1,
    64,
  );
  const catalogOfferCode = exactText(
    field(programOffer, "offerCode", "offer_code"),
    "program_offer_inactive",
    1,
    64,
  );
  if (programOfferId !== catalogOfferId || programOffer.status !== "active" ||
      field(program, "code", "code") !== programCode || program.status !== "active" ||
      field(catalogOffer, "code", "code") !== catalogOfferCode ||
      catalogOffer.status !== "active") {
    fail("program_inactive");
  }

  const betaExpiresAtValue = field(betaAccess, "expiresAt", "expires_at");
  const betaExpiresAt = betaExpiresAtValue === null || betaExpiresAtValue === undefined ||
      betaExpiresAtValue === ""
    ? null
    : time(betaExpiresAtValue, "invalid_authority_expiry");
  const [ownerAuthorityHash, profileAuthorityHash, betaAuthorityHash,
    selectionAuthorityHash, linkAuthorityHash, programOfferAuthorityHash,
    programAuthorityHash, catalogOfferAuthorityHash] = await Promise.all([
    hashRecord({
      offerCode,
      ownerKind: "partner",
      partnerProfileId: profileId,
      updatedAt: boundedText(field(ownerRow, "updatedAt", "updated_at"),
        "invalid_owner_authority", 80),
    }),
    hashRecord({
      profileId,
      telegramId: ownerTelegramId,
      status: partnerProfile.status,
      updatedAt: boundedText(field(partnerProfile, "updatedAt", "updated_at"),
        "invalid_profile_authority", 80),
    }),
    hashRecord({
      partnerProfileId: profileId,
      accessStatus: field(betaAccess, "accessStatus", "access_status"),
      expiresAt: betaExpiresAt,
      updatedAt: boundedText(field(betaAccess, "updatedAt", "updated_at"),
        "invalid_beta_authority", 80),
    }),
    hashRecord({
      offerCode,
      partnerLinkId: linkId,
      updatedAt: boundedText(field(selection, "updatedAt", "updated_at"),
        "invalid_selection_authority", 80),
    }),
    hashRecord({
      partnerLinkId: linkId,
      partnerProfileId: profileId,
      catalogOfferId,
      url: exactText(field(partnerLink, "url", "url"),
        "invalid_link_authority", 8, 2_000),
      trackingKey: exactText(field(partnerLink, "trackingKey", "tracking_key"),
        "invalid_link_authority", 1, 512),
      status: field(partnerLink, "status", "partner_link_status"),
      ownershipConfirmed: 1,
      trafficConfirmed: 1,
      updatedAt: boundedText(field(partnerLink, "updatedAt", "updated_at"),
        "invalid_link_authority", 80),
    }),
    hashRecord({
      programOfferId,
      programCode,
      offerCode: catalogOfferCode,
      status: programOffer.status,
      updatedAt: boundedText(field(programOffer, "updatedAt", "updated_at"),
        "invalid_program_offer_authority", 80),
    }),
    hashRecord({
      programCode,
      status: program.status,
      allowedDomains: boundedText(
        field(program, "allowedDomains", "allowed_domains"),
        "invalid_program_authority",
      ),
      updatedAt: boundedText(field(program, "updatedAt", "updated_at"),
        "invalid_program_authority", 80),
    }),
    hashRecord({
      offerCode: catalogOfferCode,
      status: catalogOffer.status,
      updatedAt: boundedText(field(catalogOffer, "updatedAt", "updated_at"),
        "invalid_catalog_offer_authority", 80),
    }),
  ]);

  const snapshot = {
    authoritySource: "database",
    offerCode,
    ownerPartnerProfileId: profileId,
    ownerTelegramId,
    partnerLinkId: linkId,
    programOfferId,
    programCode,
    catalogOfferCode,
    ownerStatus: "partner",
    partnerProfileStatus: "active",
    partnerRoleStatus: "active",
    betaAccessStatus: "active",
    partnerLinkStatus: "approved",
    ownershipConfirmed: 1,
    trafficConfirmed: 1,
    programOfferStatus: "active",
    programStatus: "active",
    catalogOfferStatus: "active",
    betaExpiresAt,
    ownerAuthorityHash,
    profileAuthorityHash,
    betaAuthorityHash,
    selectionAuthorityHash,
    linkAuthorityHash,
    programOfferAuthorityHash,
    programAuthorityHash,
    catalogOfferAuthorityHash,
  };
  return deepFreeze({ ...snapshot, authorityHash: await hashRecord(snapshot) });
}

const verifyAuthoritySnapshot = async (value) => {
  const authority = record(value, "invalid_authority_snapshot");
  if (authority.authoritySource !== "database") {
    fail("authority_not_database_bound");
  }
  const authorityHash = digest(authority.authorityHash, "invalid_authority_hash");
  const snapshot = Object.fromEntries(Object.entries(authority).filter(
    ([key]) => key !== "authorityHash",
  ));
  if (await hashRecord(snapshot) !== authorityHash) fail("authority_hash_mismatch");
  positiveInteger(authority.ownerPartnerProfileId, "invalid_authority_snapshot");
  positiveInteger(authority.ownerTelegramId, "invalid_authority_snapshot");
  positiveInteger(authority.partnerLinkId, "invalid_authority_snapshot");
  positiveInteger(authority.programOfferId, "invalid_authority_snapshot");
  exactText(authority.programCode, "invalid_authority_snapshot", 1, 64);
  return authority;
};

export async function normalizeOfferMedia(mediaRows, { offerCode, versionId }) {
  if (!Array.isArray(mediaRows)) fail("invalid_media");
  const seenPositions = new Set();
  const normalized = [];
  for (const raw of mediaRows) {
    const media = record(raw, "invalid_media");
    if (field(media, "offerCode", "offer_code") !== offerCode ||
        field(media, "offerVersionId", "offer_version_id") !== versionId) {
      fail("foreign_media");
    }
    const position = positiveInteger(media.position, "invalid_media_position");
    if (position > 1_000) fail("invalid_media_position");
    if (seenPositions.has(position)) fail("duplicate_media_position");
    seenPositions.add(position);
    const mediaId = exactText(field(media, "mediaId", "media_id"),
      "invalid_media_id", 68, 68);
    if (!/^med_[0-9a-f]{64}$/u.test(mediaId)) fail("invalid_media_id");
    const mediaKind = field(media, "mediaKind", "media_kind");
    if (!new Set(["image", "video"]).has(mediaKind)) fail("invalid_media_kind");
    const storageKey = exactText(field(media, "storageKey", "storage_key"),
      "invalid_storage_key", 8, 512);
    if (storageKey.includes("://")) fail("invalid_storage_key");
    const mimeType = field(media, "mimeType", "mime_type");
    const allowedMime = mediaKind === "image"
      ? new Set(["image/jpeg", "image/png", "image/webp"])
      : new Set(["video/mp4"]);
    if (!allowedMime.has(mimeType)) fail("invalid_media_mime");
    const byteSize = positiveInteger(field(media, "byteSize", "byte_size"),
      "invalid_media_size");
    if (byteSize > 20_971_520) fail("invalid_media_size");
    const altText = String(field(media, "altText", "alt_text") || "");
    if (altText.length > 500) fail("invalid_media_alt_text");
    normalized.push({
      mediaId,
      position,
      mediaKind,
      storageKey,
      mimeType,
      byteSize,
      contentHash: digest(field(media, "contentHash", "content_hash"),
        "invalid_media_hash"),
      altText,
    });
  }
  normalized.sort((left, right) => left.position - right.position);
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index].position !== index + 1) fail("media_order_gap");
  }
  const mediaSetHash = await hashRecord(normalized.map((media) => ({
    mediaId: media.mediaId,
    position: media.position,
    mediaKind: media.mediaKind,
    storageKey: media.storageKey,
    mimeType: media.mimeType,
    byteSize: media.byteSize,
    contentHash: media.contentHash,
  })));
  return deepFreeze({ media: normalized, mediaSetHash });
}

const exactCurrentVersion = (state, version) => {
  if (state.currentVersionId !== version.versionId) fail("version_changed");
};

const verifySnapshotRoute = (version, authority) => {
  const snapshot = version.snapshot;
  if (Number(snapshot.partner_link_id) !== authority.partnerLinkId ||
      Number(snapshot.catalog_offer_id) !== authority.programOfferId ||
      String(snapshot.program_code || "") !== authority.programCode) {
    fail("snapshot_authority_mismatch");
  }
};

const receiptBase = async ({
  prefix,
  operation,
  idempotencySecret,
  rawIdempotencyKey,
  request,
  randomBytes,
}) => ({
  id: createPart2OpaqueId(prefix, randomBytes),
  idempotencyKey: await deriveIdempotencyKey({
    secret: idempotencySecret,
    operation,
    rawKey: rawIdempotencyKey,
  }),
  requestHash: await hashRecord(request),
});

export async function buildOfferSubmissionReceipt({
  settings,
  actor,
  offerCode,
  offerState,
  version: rawVersion,
  authority,
  mediaRows = [],
  moderationDecisionId,
  nowSeconds,
  idempotencySecret,
  rawIdempotencyKey,
  randomBytes,
}) {
  if (!enabledOfferSettings(settings, "moderationEnabled")) fail("feature_off");
  const ownerActor = actorProjection(actor, "partner");
  const liveAuthority = await verifyAuthoritySnapshot(authority);
  const state = stateProjection(offerState, offerCode);
  const version = await versionProjection(rawVersion, offerCode);
  exactCurrentVersion(state, version);
  if (state.moderationStatus !== "pending" ||
      state.submittedVersionId !== version.versionId ||
      state.approvedVersionId !== null || state.visibility !== "private") {
    fail("submission_state_mismatch");
  }
  if (version.businessStatus !== "active") fail("offer_not_active");
  if (ownerActor.telegramId !== liveAuthority.ownerTelegramId) fail("cross_owner");
  verifySnapshotRoute(version, liveAuthority);
  const normalizedMedia = await normalizeOfferMedia(mediaRows, {
    offerCode,
    versionId: version.versionId,
  });
  const submittedAt = time(nowSeconds);
  const decisionId = positiveInteger(moderationDecisionId,
    "invalid_moderation_decision");
  const base = await receiptBase({
    prefix: "sub_",
    operation: "offer.submit",
    idempotencySecret,
    rawIdempotencyKey,
    randomBytes,
    request: {
      offerCode,
      versionId: version.versionId,
      contentHash: version.contentHash,
      authorityHash: liveAuthority.authorityHash,
      mediaSetHash: normalizedMedia.mediaSetHash,
      moderationDecisionId: decisionId,
    },
  });
  return deepFreeze({
    submissionId: base.id,
    offerCode,
    offerVersionId: version.versionId,
    moderationDecisionId: decisionId,
    ownerPartnerProfileId: liveAuthority.ownerPartnerProfileId,
    partnerLinkId: liveAuthority.partnerLinkId,
    programOfferId: liveAuthority.programOfferId,
    programCode: liveAuthority.programCode,
    submittedBy: ownerActor.telegramId,
    versionContentHash: version.contentHash,
    authorityHash: liveAuthority.authorityHash,
    mediaSetHash: normalizedMedia.mediaSetHash,
    idempotencyKey: base.idempotencyKey,
    requestHash: base.requestHash,
    submittedAt,
  });
}

export async function buildOfferReviewReceipt({
  settings,
  actor,
  offerCode,
  offerState,
  version: rawVersion,
  authority,
  submission,
  decision,
  moderationDecisionId,
  reason,
  mediaRows = [],
  nowSeconds,
  idempotencySecret,
  rawIdempotencyKey,
  randomBytes,
}) {
  if (!enabledOfferSettings(settings, "moderationEnabled")) fail("feature_off");
  const admin = actorProjection(actor, "admin");
  const liveAuthority = await verifyAuthoritySnapshot(authority);
  if (!new Set(["approved", "changes_requested", "rejected"]).has(decision)) {
    fail("invalid_decision");
  }
  const normalizedReason = String(reason || "").trim();
  if (decision !== "approved" && normalizedReason.length < 3) {
    fail("reason_required");
  }
  if (normalizedReason.length > 1_000) fail("invalid_reason");
  const state = stateProjection(offerState, offerCode);
  const version = await versionProjection(rawVersion, offerCode);
  exactCurrentVersion(state, version);
  if (state.submittedVersionId !== version.versionId ||
      state.moderationStatus !== decision ||
      (decision === "approved" && state.approvedVersionId !== version.versionId) ||
      (decision !== "approved" && state.approvedVersionId !== null) ||
      state.visibility !== "private") {
    fail("review_state_mismatch");
  }
  const boundSubmission = record(submission, "invalid_submission");
  if (boundSubmission.offerCode !== offerCode ||
      boundSubmission.offerVersionId !== version.versionId ||
      boundSubmission.versionContentHash !== version.contentHash ||
      boundSubmission.authorityHash !== liveAuthority.authorityHash) {
    fail("submission_binding_mismatch");
  }
  verifySnapshotRoute(version, liveAuthority);
  const normalizedMedia = await normalizeOfferMedia(mediaRows, {
    offerCode,
    versionId: version.versionId,
  });
  if (normalizedMedia.mediaSetHash !== boundSubmission.mediaSetHash) {
    fail("media_set_changed");
  }
  const reviewedAt = time(nowSeconds);
  const decisionId = positiveInteger(moderationDecisionId,
    "invalid_moderation_decision");
  const reasonHash = await sha256Hex(normalizedReason);
  const beforeHash = await hashRecord({
    moderationStatus: "pending",
    visibility: "private",
    submittedVersionId: version.versionId,
    approvedVersionId: null,
  });
  const afterHash = await hashRecord({
    moderationStatus: decision,
    visibility: "private",
    submittedVersionId: version.versionId,
    approvedVersionId: decision === "approved" ? version.versionId : null,
  });
  const base = await receiptBase({
    prefix: "rev_",
    operation: `offer.review.${decision}`,
    idempotencySecret,
    rawIdempotencyKey,
    randomBytes,
    request: {
      submissionId: boundSubmission.submissionId,
      moderationDecisionId: decisionId,
      decision,
      reasonHash,
      authorityHash: liveAuthority.authorityHash,
      mediaSetHash: normalizedMedia.mediaSetHash,
    },
  });
  return deepFreeze({
    reviewId: base.id,
    submissionId: boundSubmission.submissionId,
    moderationDecisionId: decisionId,
    decision,
    reviewedBy: admin.telegramId,
    reasonHash,
    reviewedContentHash: version.contentHash,
    reviewedAuthorityHash: liveAuthority.authorityHash,
    approvedMediaSetHash: normalizedMedia.mediaSetHash,
    idempotencyKey: base.idempotencyKey,
    requestHash: base.requestHash,
    beforeHash,
    afterHash,
    reviewedAt,
  });
}

export function buildMediaApprovalRows({ review, mediaRows }) {
  const boundReview = record(review, "invalid_review");
  if (boundReview.decision !== "approved") fail("review_not_approved");
  if (!Array.isArray(mediaRows)) fail("invalid_media");
  return deepFreeze(mediaRows.map((media) => ({
    mediaId: field(media, "mediaId", "media_id"),
    reviewId: boundReview.reviewId,
    approvedBy: boundReview.reviewedBy,
    contentHash: digest(field(media, "contentHash", "content_hash"),
      "invalid_media_hash"),
    approvedAt: boundReview.reviewedAt,
  })));
}

export async function buildOfferPublicationReceipt({
  settings,
  actor,
  offerCode,
  offerState,
  version: rawVersion,
  authority,
  submission,
  review,
  mediaRows = [],
  mediaApprovalRows = [],
  nowSeconds,
  idempotencySecret,
  rawIdempotencyKey,
  randomBytes,
}) {
  if (!enabledOfferSettings(settings, "publicationEnabled") ||
      settings.partnerBetaPublicVisibilityEnabled !== true) {
    fail("feature_off");
  }
  const partner = actorProjection(actor, "partner");
  const liveAuthority = await verifyAuthoritySnapshot(authority);
  if (partner.telegramId !== liveAuthority.ownerTelegramId) fail("cross_owner");
  const state = stateProjection(offerState, offerCode);
  const version = await versionProjection(rawVersion, offerCode);
  exactCurrentVersion(state, version);
  if (state.moderationStatus !== "approved" || state.visibility !== "private" ||
      state.submittedVersionId !== version.versionId ||
      state.approvedVersionId !== version.versionId) {
    fail("version_not_publishable");
  }
  const boundSubmission = record(submission, "invalid_submission");
  const boundReview = record(review, "invalid_review");
  if (boundReview.decision !== "approved" ||
      boundReview.submissionId !== boundSubmission.submissionId ||
      boundSubmission.offerCode !== offerCode ||
      boundSubmission.offerVersionId !== version.versionId ||
      boundSubmission.versionContentHash !== version.contentHash ||
      boundSubmission.authorityHash !== liveAuthority.authorityHash ||
      boundReview.reviewedContentHash !== version.contentHash ||
      boundReview.reviewedAuthorityHash !== liveAuthority.authorityHash) {
    fail("approval_binding_mismatch");
  }
  verifySnapshotRoute(version, liveAuthority);
  const normalizedMedia = await normalizeOfferMedia(mediaRows, {
    offerCode,
    versionId: version.versionId,
  });
  if (normalizedMedia.mediaSetHash !== boundSubmission.mediaSetHash ||
      normalizedMedia.mediaSetHash !== boundReview.approvedMediaSetHash) {
    fail("media_set_changed");
  }
  const approvalByMediaId = new Map(mediaApprovalRows.map((rowValue) => {
    const row = record(rowValue, "invalid_media_approval");
    return [field(row, "mediaId", "media_id"), row];
  }));
  if (approvalByMediaId.size !== normalizedMedia.media.length) {
    fail("media_not_approved");
  }
  for (const media of normalizedMedia.media) {
    const approval = approvalByMediaId.get(media.mediaId);
    if (!approval || field(approval, "reviewId", "review_id") !== boundReview.reviewId ||
        digest(field(approval, "contentHash", "content_hash"),
          "invalid_media_approval") !== media.contentHash) {
      fail("media_not_approved");
    }
  }
  const publishedAt = time(nowSeconds);
  const beforeHash = await hashRecord({
    moderationStatus: "approved",
    visibility: "private",
    versionId: version.versionId,
  });
  const afterHash = await hashRecord({
    moderationStatus: "approved",
    visibility: "public",
    versionId: version.versionId,
  });
  const base = await receiptBase({
    prefix: "pub_",
    operation: "offer.publish",
    idempotencySecret,
    rawIdempotencyKey,
    randomBytes,
    request: {
      offerCode,
      versionId: version.versionId,
      reviewId: boundReview.reviewId,
      contentHash: version.contentHash,
      authorityHash: liveAuthority.authorityHash,
      mediaSetHash: normalizedMedia.mediaSetHash,
    },
  });
  return deepFreeze({
    publicationId: base.id,
    offerCode,
    offerVersionId: version.versionId,
    reviewId: boundReview.reviewId,
    ownerPartnerProfileId: liveAuthority.ownerPartnerProfileId,
    publishedBy: partner.telegramId,
    visibilityBefore: "private",
    visibilityAfter: "public",
    contentHash: version.contentHash,
    authorityHash: liveAuthority.authorityHash,
    mediaSetHash: normalizedMedia.mediaSetHash,
    idempotencyKey: base.idempotencyKey,
    requestHash: base.requestHash,
    beforeHash,
    afterHash,
    publishedAt,
  });
}

const safeSnapshotFields = (snapshot, presentation) => Object.fromEntries(
  PREVIEW_FIELD_ALLOWLIST[presentation].map((key) => [key, snapshot[key] ?? null]),
);

export async function buildOfferPreview({
  settings,
  actor,
  planCode,
  planSource,
  audienceKind,
  offerCode,
  offerState,
  version: rawVersion,
  authority,
  review = null,
  mediaRows = [],
  mediaApprovalRows = [],
}) {
  if (!enabledOfferSettings(settings, "previewEnabled")) fail("feature_off");
  const viewer = actorProjection(actor);
  const liveAuthority = await verifyAuthoritySnapshot(authority);
  const state = stateProjection(offerState, offerCode);
  const version = await versionProjection(rawVersion, offerCode);
  if (!new Set(["owner", "moderator", "user"]).has(audienceKind)) {
    fail("invalid_preview_audience");
  }
  let presentation = "full";
  if (audienceKind === "owner") {
    if (viewer.role !== "partner" || viewer.telegramId !== liveAuthority.ownerTelegramId) {
      fail("cross_owner");
    }
    exactCurrentVersion(state, version);
  } else if (audienceKind === "moderator") {
    if (viewer.role !== "admin") fail("role_denied");
    if (state.submittedVersionId !== version.versionId) fail("foreign_version");
  } else {
    if (viewer.role !== "user" && viewer.role !== "partner") fail("role_denied");
    if (planSource !== "database" || !PLAN_PRESENTATION[planCode]) {
      fail("plan_not_database_bound");
    }
    presentation = PLAN_PRESENTATION[planCode];
    if (state.visibility !== "public" || state.moderationStatus !== "approved" ||
        state.currentVersionId !== version.versionId ||
        state.approvedVersionId !== version.versionId) {
      fail("offer_not_public");
    }
  }
  const normalizedMedia = await normalizeOfferMedia(mediaRows, {
    offerCode,
    versionId: version.versionId,
  });
  if (audienceKind === "user") {
    const boundReview = record(review, "invalid_review");
    if (boundReview.decision !== "approved" ||
        boundReview.approvedMediaSetHash !== normalizedMedia.mediaSetHash) {
      fail("media_not_approved");
    }
    const approvals = new Map(mediaApprovalRows.map((row) => [
      field(row, "mediaId", "media_id"), row,
    ]));
    for (const media of normalizedMedia.media) {
      const approval = approvals.get(media.mediaId);
      if (!approval || field(approval, "reviewId", "review_id") !== boundReview.reviewId ||
          digest(field(approval, "contentHash", "content_hash"),
            "invalid_media_approval") !== media.contentHash) {
        fail("media_not_approved");
      }
    }
  }
  return deepFreeze({
    offerCode,
    versionId: version.versionId,
    presentation,
    fields: safeSnapshotFields(version.snapshot, presentation),
    media: normalizedMedia.media,
    mediaSetHash: normalizedMedia.mediaSetHash,
  });
}

export async function buildApprovedOfferCard(input) {
  const card = await buildOfferPreview({
    ...input,
    audienceKind: "user",
    planCode: "dragon",
    planSource: "database",
  });
  return deepFreeze({ ...card, presentation: "full" });
}

export function assertPromotionClientPayload(payload = {}) {
  const value = record(payload, "invalid_client_payload");
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (PROHIBITED_PROMOTION_CLIENT_FIELDS.has(key)) {
        fail("client_authority_field_forbidden", key);
      }
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(value);
  return true;
}

export async function buildPromotionWindow({
  settings,
  policyCode,
  subjectTelegramId = null,
  startsAt,
  createdBy,
  sourceKind,
  idempotencySecret,
  rawIdempotencyKey,
  requestAuthorityHash,
  createdAt,
  randomBytes,
}) {
  if (!enabledOfferSettings(settings, "promotionsEnabled")) fail("feature_off");
  const policy = PROMOTION_POLICIES[policyCode];
  if (!policy) fail("unknown_promotion_policy");
  const start = time(startsAt);
  const created = time(createdAt);
  const creator = nonNegativeInteger(createdBy, "invalid_creator");
  if (!new Set(["worker", "admin"]).has(sourceKind) ||
      (sourceKind === "worker" && creator !== 0) ||
      (sourceKind === "admin" && creator === 0)) {
    fail("invalid_window_source");
  }
  const subject = subjectTelegramId === null
    ? null
    : positiveInteger(subjectTelegramId, "invalid_subject");
  if ((policy.windowScope === "user") !== (subject !== null)) {
    fail("promotion_scope_mismatch");
  }
  const requestHash = digest(requestAuthorityHash, "invalid_request_authority");
  const base = await receiptBase({
    prefix: "pwn_",
    operation: `promotion.window.${policyCode}`,
    idempotencySecret,
    rawIdempotencyKey,
    randomBytes,
    request: { policyCode, subjectTelegramId: subject, startsAt: start, requestHash },
  });
  return deepFreeze({
    windowId: base.id,
    policyCode,
    subjectTelegramId: subject,
    startsAt: start,
    endsAt: start + policy.windowSeconds,
    eligibleUserLimit: policy.eligibleUserLimit,
    sourceKind,
    createdBy: creator,
    idempotencyKey: base.idempotencyKey,
    requestHash: base.requestHash,
    authorityHash: requestHash,
    createdAt: created,
  });
}

const priceProjection = (value) => {
  const price = record(value, "invalid_price_authority");
  if (field(price, "authoritySource", "authority_source") !== "stars_access" ||
      price.verified !== true || price.currency !== "XTR") {
    fail("price_not_authoritative");
  }
  return {
    authorityKeyHash: digest(
      field(price, "authorityKeyHash", "authority_key_hash"),
      "invalid_price_authority",
    ),
    priceVersionHash: digest(
      field(price, "priceVersionHash", "price_version_hash"),
      "invalid_price_authority",
    ),
    basePriceStars: positiveInteger(
      field(price, "basePriceStars", "base_price_stars"),
      "invalid_price_authority",
    ),
    currency: "XTR",
  };
};

const promotionWindowProjection = (raw) => {
  const window = record(raw, "invalid_promotion_window");
  const policyCode = field(window, "policyCode", "policy_code");
  const policy = PROMOTION_POLICIES[policyCode];
  if (!policy) fail("unknown_promotion_policy");
  const startsAt = time(field(window, "startsAt", "starts_at"));
  const endsAt = time(field(window, "endsAt", "ends_at"));
  const subjectTelegramId = field(
    window,
    "subjectTelegramId",
    "subject_telegram_id",
  ) ?? null;
  const eligibleUserLimit = positiveInteger(
    field(window, "eligibleUserLimit", "eligible_user_limit"),
    "invalid_promotion_window",
  );
  if (endsAt - startsAt !== policy.windowSeconds ||
      eligibleUserLimit !== policy.eligibleUserLimit ||
      (policy.windowScope === "user" &&
        (!Number.isSafeInteger(subjectTelegramId) || subjectTelegramId <= 0)) ||
      (policy.windowScope === "global" && subjectTelegramId !== null)) {
    fail("invalid_promotion_window");
  }
  const windowId = exactText(field(window, "windowId", "window_id"),
    "invalid_promotion_window", 68, 68);
  if (!/^pwn_[0-9a-f]{64}$/u.test(windowId)) fail("invalid_promotion_window");
  return {
    windowId,
    policyCode,
    policy,
    subjectTelegramId,
    startsAt,
    endsAt,
    eligibleUserLimit,
    claimedUserCount: nonNegativeInteger(
      field(window, "claimedUserCount", "claimed_user_count") ?? 0,
      "invalid_promotion_window",
    ),
  };
};

const choosePromotion = ({ windows, subjectTelegramId, joinedAt, now, claims }) => {
  const claimRows = Array.isArray(claims) ? claims : fail("invalid_claims");
  const claimedNewcomer = claimRows.some((claim) =>
    field(claim, "policyCode", "policy_code") === "newcomer_20_72h" &&
    field(claim, "subjectTelegramId", "subject_telegram_id") === subjectTelegramId);
  const candidates = [];
  const reasons = [];
  for (const rawWindow of windows) {
    const window = promotionWindowProjection(rawWindow);
    if (now < window.startsAt) {
      reasons.push("not_started");
      continue;
    }
    if (now >= window.endsAt) {
      reasons.push(`${window.policyCode.startsWith("newcomer") ? "newcomer" : "monthly"}_expired`);
      continue;
    }
    if (window.policy.windowScope === "user") {
      if (window.subjectTelegramId !== subjectTelegramId ||
          window.startsAt !== joinedAt || claimedNewcomer) {
        reasons.push(claimedNewcomer ? "already_claimed" : "cross_owner");
        continue;
      }
    } else if (window.subjectTelegramId !== null) {
      reasons.push("authority_mismatch");
      continue;
    }
    if (window.claimedUserCount >= window.eligibleUserLimit) {
      reasons.push("quota_exhausted");
      continue;
    }
    candidates.push(window);
  }
  candidates.sort((left, right) =>
    right.policy.discountBasisPoints - left.policy.discountBasisPoints ||
    right.policy.priority - left.policy.priority ||
    left.policyCode.localeCompare(right.policyCode));
  return {
    selected: candidates[0] || null,
    reason: candidates.length ? "eligible" : (reasons[0] || "no_policy"),
  };
};

export async function evaluatePromotion({
  settings,
  actor,
  subject,
  offerCode,
  offerState,
  offerAuthority,
  priceAuthority,
  windows,
  claims = [],
  checkoutIntentHash,
  clientPayload = {},
  nowSeconds,
  idempotencySecret,
  rawIdempotencyKey,
  randomBytes,
}) {
  assertPromotionClientPayload(clientPayload);
  if (!enabledOfferSettings(settings, "promotionsEnabled")) fail("feature_off");
  const requester = actorProjection(actor);
  const user = record(subject, "invalid_subject");
  if (!sourceIsDatabase(user)) fail("subject_not_database_bound");
  const subjectTelegramId = positiveInteger(
    field(user, "telegramId", "telegram_id"),
    "invalid_subject",
  );
  if (requester.role !== "user" || requester.telegramId !== subjectTelegramId) {
    fail("cross_owner");
  }
  if (user.active !== true) fail("invalid_subject");
  const joinedAt = time(field(user, "joinedAt", "joined_at"), "invalid_subject");
  const now = time(nowSeconds);
  const liveOfferAuthority = await verifyAuthoritySnapshot(offerAuthority);
  const state = stateProjection(offerState, offerCode);
  let forcedReason = null;
  if (state.moderationStatus !== "approved" || state.visibility !== "public" ||
      state.currentVersionId !== state.approvedVersionId) {
    forcedReason = "offer_not_public";
  }
  if (liveOfferAuthority.ownerTelegramId === subjectTelegramId) {
    forcedReason = "self_dealing";
  }
  const price = priceProjection(priceAuthority);
  const intentHash = digest(checkoutIntentHash, "invalid_checkout_intent");
  const selection = forcedReason
    ? { selected: null, reason: forcedReason }
    : choosePromotion({ windows, subjectTelegramId, joinedAt, now, claims });
  const selected = selection.selected;
  const discountBasisPoints = selected?.policy.discountBasisPoints || 0;
  const discountStars = Math.floor(
    price.basePriceStars * discountBasisPoints / 10_000,
  );
  const finalPriceStars = price.basePriceStars - discountStars;
  const candidateSetHash = await hashRecord(windows.map((window) => ({
    windowId: field(window, "windowId", "window_id"),
    policyCode: field(window, "policyCode", "policy_code"),
    claimedUserCount: field(window, "claimedUserCount", "claimed_user_count") ?? 0,
  })));
  const authorityHash = await hashRecord({
    offerAuthorityHash: liveOfferAuthority.authorityHash,
    priceAuthorityKeyHash: price.authorityKeyHash,
    priceVersionHash: price.priceVersionHash,
    checkoutIntentHash: intentHash,
  });
  const base = await receiptBase({
    prefix: "pev_",
    operation: "promotion.evaluate",
    idempotencySecret,
    rawIdempotencyKey,
    randomBytes,
    request: {
      subjectTelegramId,
      offerCode,
      checkoutIntentHash: intentHash,
      candidateSetHash,
      authorityHash,
    },
  });
  return deepFreeze({
    evaluationId: base.id,
    actorTelegramId: requester.telegramId,
    subjectTelegramId,
    offerCode,
    checkoutIntentHash: intentHash,
    selectedPolicyCode: selected?.policyCode || null,
    promotionWindowId: selected?.windowId || null,
    outcome: selected ? "eligible" : "ineligible",
    reasonCode: selection.reason,
    priceAuthorityKind: "stars_access",
    priceAuthorityKeyHash: price.authorityKeyHash,
    priceVersionHash: price.priceVersionHash,
    currency: price.currency,
    basePriceStars: price.basePriceStars,
    discountBasisPoints,
    discountStars,
    finalPriceStars,
    candidateSetHash,
    authorityHash,
    idempotencyKey: base.idempotencyKey,
    requestHash: base.requestHash,
    evaluatedAt: now,
    retentionUntil: now + OFFER_TECHNICAL_RETENTION_SECONDS,
  });
}

export async function buildPromotionApplicationReceipt({
  settings,
  evaluation,
  liveWindow,
  offerAuthority,
  priceAuthority,
  nowSeconds,
  idempotencySecret,
  rawIdempotencyKey,
  randomBytes,
}) {
  if (!enabledOfferSettings(settings, "promotionsEnabled")) fail("feature_off");
  const evaluated = record(evaluation, "invalid_evaluation");
  if (evaluated.outcome !== "eligible" || evaluated.reasonCode !== "eligible" ||
      !PROMOTION_POLICIES[evaluated.selectedPolicyCode]) {
    fail("promotion_not_eligible");
  }
  const now = time(nowSeconds);
  const liveOfferAuthority = await verifyAuthoritySnapshot(offerAuthority);
  const window = promotionWindowProjection(liveWindow);
  if (window.windowId !== evaluated.promotionWindowId ||
      window.policyCode !== evaluated.selectedPolicyCode ||
      now < window.startsAt || now >= window.endsAt) {
    fail("promotion_expired");
  }
  if (window.claimedUserCount >= window.eligibleUserLimit) {
    fail("quota_exhausted");
  }
  if (liveOfferAuthority.ownerTelegramId === evaluated.subjectTelegramId) {
    fail("self_dealing");
  }
  const price = priceProjection(priceAuthority);
  if (price.authorityKeyHash !== evaluated.priceAuthorityKeyHash ||
      price.priceVersionHash !== evaluated.priceVersionHash ||
      price.basePriceStars !== evaluated.basePriceStars ||
      price.currency !== evaluated.currency) {
    fail("price_authority_changed");
  }
  const expectedAuthorityHash = await hashRecord({
    offerAuthorityHash: liveOfferAuthority.authorityHash,
    priceAuthorityKeyHash: price.authorityKeyHash,
    priceVersionHash: price.priceVersionHash,
    checkoutIntentHash: evaluated.checkoutIntentHash,
  });
  if (expectedAuthorityHash !== evaluated.authorityHash) {
    fail("authority_changed");
  }
  const beforeHash = await hashRecord({
    checkoutIntentHash: evaluated.checkoutIntentHash,
    promotion: null,
  });
  const afterHash = await hashRecord({
    checkoutIntentHash: evaluated.checkoutIntentHash,
    promotion: evaluated.selectedPolicyCode,
    finalPriceStars: evaluated.finalPriceStars,
    authorityStatus: "awaiting_stars",
  });
  const base = await receiptBase({
    prefix: "pap_",
    operation: "promotion.apply",
    idempotencySecret,
    rawIdempotencyKey,
    randomBytes,
    request: {
      evaluationId: evaluated.evaluationId,
      checkoutIntentHash: evaluated.checkoutIntentHash,
      policyCode: evaluated.selectedPolicyCode,
      windowId: evaluated.promotionWindowId,
      authorityHash: expectedAuthorityHash,
    },
  });
  return deepFreeze({
    applicationId: base.id,
    evaluationId: evaluated.evaluationId,
    subjectTelegramId: evaluated.subjectTelegramId,
    offerCode: evaluated.offerCode,
    policyCode: evaluated.selectedPolicyCode,
    promotionWindowId: evaluated.promotionWindowId,
    checkoutIntentHash: evaluated.checkoutIntentHash,
    priceAuthorityKeyHash: evaluated.priceAuthorityKeyHash,
    priceVersionHash: evaluated.priceVersionHash,
    currency: evaluated.currency,
    basePriceStars: evaluated.basePriceStars,
    discountBasisPoints: evaluated.discountBasisPoints,
    discountStars: evaluated.discountStars,
    finalPriceStars: evaluated.finalPriceStars,
    authorityStatus: "awaiting_stars",
    idempotencyKey: base.idempotencyKey,
    requestHash: base.requestHash,
    beforeHash,
    afterHash,
    appliedAt: now,
  });
}

export const utf8ByteLength = (value) => encoder.encode(String(value)).length;
