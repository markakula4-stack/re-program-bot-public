import {
  ANALYTICS_V2_DEFAULTS,
  createAnalyticsActorPseudonym,
} from "./analytics-foundation.mjs";

const TEXT_ENCODER = new TextEncoder();
const DAY = 86_400;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRACKING_CODE_PATTERN = /^av2_[0-9a-f]{48}$/;

export const AMBASSADOR_V2_ATTRIBUTION_POLICY_VERSION =
  "2026-09-13.analytics-v2-part3";
export const AMBASSADOR_V2_ENGAGEMENT_WINDOW_SECONDS = 30 * DAY;
export const AMBASSADOR_V2_TRACKING_CODE_BYTES = 24;

const PROFILE_AUTHORITY_KEYS = new Set([
  "moderationStatus",
  "ownerTelegramId",
  "partnerProfileId",
  "partnerProfileStatus",
  "partnerRoleStatus",
  "programEligibility",
]);
const RELATIONSHIP_AUTHORITY_KEYS = new Set([
  "cycleDetected",
  "firstInviterTelegramId",
  "inviterBound",
  "ownerTelegramId",
  "sourceIdentity",
]);
const COMMERCIAL_AUTHORITY_KEYS = new Set([
  "authorityKind",
  "authorityStatus",
  "cycleDetected",
  "ownerMatches",
  "ownerTelegramId",
  "sourceKnown",
  "sourceRecordId",
]);
const PROFILE_TRANSITIONS = new Set([
  "draft:active:activation_approved",
  "active:paused:admin_paused",
  "paused:active:admin_resumed",
  "active:suspended:moderation_suspended",
  "active:suspended:eligibility_expired",
  "paused:suspended:moderation_suspended",
  "paused:suspended:eligibility_expired",
  "suspended:active:eligibility_restored",
  "draft:archived:admin_archived",
  "active:archived:admin_archived",
  "paused:archived:admin_archived",
  "suspended:archived:admin_archived",
]);
const CAMPAIGN_TRANSITIONS = new Set([
  "draft:active:activation_approved",
  "active:paused:owner_paused",
  "active:paused:admin_paused",
  "paused:active:owner_resumed",
  "paused:active:admin_resumed",
  "draft:archived:admin_archived",
  "active:archived:period_ended",
  "active:archived:admin_archived",
  "paused:archived:period_ended",
  "paused:archived:admin_archived",
]);
const COMMERCIAL_STATUS = Object.freeze({
  lead_partner_attribution: "attributed",
  stars_access: "applied",
  referral_reward: "confirmed",
});

function canonicalJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical evidence contains an unsupported object");
    }
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("canonical evidence contains a non-finite number");
  }
  if (!["string", "number", "boolean"].includes(typeof value)) {
    throw new TypeError("canonical evidence contains an unsupported value");
  }
  return JSON.stringify(value);
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value, cryptoImpl) {
  return bytesToHex(await cryptoImpl.subtle.digest(
    "SHA-256",
    TEXT_ENCODER.encode(value),
  ));
}

async function hmacHex(secret, value, cryptoImpl) {
  const key = await cryptoImpl.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(await cryptoImpl.subtle.sign(
    "HMAC",
    key,
    TEXT_ENCODER.encode(value),
  ));
}

function assertExactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`${name} shape is invalid`);
  }
}

function requiredString(value, name, { minimum = 1, maximum = 160 } = {}) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new TypeError(`${name} must be a string or integer`);
  }
  const normalized = String(value).trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new TypeError(`${name} length is invalid`);
  }
  return normalized;
}

function requiredCode(value, name, { maximum = 80 } = {}) {
  const normalized = requiredString(value, name, { maximum }).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function requiredInteger(value, name, { minimum = 1, maximum } = {}) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    (maximum !== undefined && parsed > maximum)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return parsed;
}

function requiredBoolean(value, name) {
  if (value !== true && value !== false) {
    throw new TypeError(`${name} must be boolean`);
  }
  return value;
}

function normalizeUuid(value, name) {
  const normalized = requiredString(value, name, {
    minimum: 36,
    maximum: 36,
  }).toLowerCase();
  if (!UUID_V4_PATTERN.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function normalizedSecret(value) {
  return requiredString(value, "analytics pseudonym secret", {
    minimum: 32,
    maximum: 512,
  });
}

function normalizeEvidenceIdentity(value, name = "evidence identity") {
  return requiredString(value, name, { maximum: 240 });
}

function normalizeCommercialSourceRecord(authorityKind, value) {
  if (authorityKind === "lead_partner_attribution") {
    return String(requiredInteger(value, "commercial source record id"));
  }
  return normalizeUuid(value, "commercial source record id");
}

function normalizeRetention(value) {
  return requiredInteger(value, "attribution retention days", {
    maximum: ANALYTICS_V2_DEFAULTS.rawRetentionDays,
  });
}

function assertAdminShadow(config) {
  if (
    !config ||
    config.configurationValid !== true ||
    config.rolloutMode !== "admin_shadow" ||
    config.masterEnabled !== true ||
    config.ingestEnabled !== true ||
    config.projectionsEnabled !== true ||
    config.ambassadorEnabled !== true
  ) {
    throw new Error("Ambassador 2.0 attribution is closed");
  }
}

function assertCrypto(cryptoImpl) {
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto is required");
}

function normalizeProfileAuthority(authority, expectedProfileId) {
  assertExactKeys(authority, PROFILE_AUTHORITY_KEYS, "ambassador authority");
  const normalized = Object.freeze({
    partnerProfileId: requiredInteger(
      authority.partnerProfileId,
      "partner profile id",
    ),
    ownerTelegramId: requiredInteger(
      authority.ownerTelegramId,
      "ambassador owner Telegram id",
    ),
    partnerProfileStatus: requiredCode(
      authority.partnerProfileStatus,
      "partner profile status",
    ),
    partnerRoleStatus: requiredCode(
      authority.partnerRoleStatus,
      "partner role status",
    ),
    programEligibility: requiredCode(
      authority.programEligibility,
      "program eligibility",
    ),
    moderationStatus: requiredCode(
      authority.moderationStatus,
      "moderation status",
    ),
  });
  if (normalized.partnerProfileId !== expectedProfileId) {
    throw new Error("ambassador authority profile mismatch");
  }
  if (
    normalized.partnerProfileStatus !== "active" ||
    normalized.partnerRoleStatus !== "active" ||
    normalized.programEligibility !== "eligible" ||
    normalized.moderationStatus !== "clear"
  ) {
    throw new Error("ambassador authority is not eligible");
  }
  return normalized;
}

async function assertProfileDatabaseAuthority(store, authority) {
  if (!store?.resolveProfileAuthority) {
    throw new TypeError("ambassador store is incomplete");
  }
  const exact = await store.resolveProfileAuthority(authority.partnerProfileId);
  if (
    !exact ||
    Number(exact.partner_profile_id) !== authority.partnerProfileId ||
    Number(exact.owner_telegram_id) !== authority.ownerTelegramId ||
    String(exact.partner_profile_status) !== authority.partnerProfileStatus ||
    String(exact.partner_role_status) !== authority.partnerRoleStatus
  ) {
    throw new Error("ambassador profile database authority mismatch");
  }
}

async function evidenceHash(domain, evidence, secret, cryptoImpl) {
  return hmacHex(
    secret,
    `re-analytics:${domain}:v1:${canonicalJson(evidence)}`,
    cryptoImpl,
  );
}

function changed(result) {
  return Number(result?.meta?.changes || result?.changes || 0);
}

function scalarEqual(actual, expected) {
  if (actual === null || actual === undefined) return expected === null;
  if (typeof expected === "number") return Number(actual) === expected;
  return String(actual) === String(expected);
}

function exactFields(actual, expected, fields) {
  return fields.every((field) => scalarEqual(actual?.[field], expected[field]));
}

const PROFILE_FIELDS = Object.freeze([
  "ambassador_id",
  "partner_profile_id",
  "owner_pseudonym",
  "pseudonym_key_version",
  "status",
  "eligibility_evidence_hash",
  "revision",
  "activated_at",
  "created_at",
  "updated_at",
]);
const PROFILE_TRANSITION_FIELDS = Object.freeze([
  "transition_id",
  "transition_key",
  "ambassador_id",
  "profile_revision",
  "from_status",
  "to_status",
  "reason_code",
  "actor_kind",
  "evidence_hash",
  "occurred_at",
  "created_at",
]);
const CAMPAIGN_FIELDS = Object.freeze([
  "campaign_id",
  "ambassador_id",
  "scope_kind",
  "program_code",
  "catalog_offer_id",
  "status",
  "scope_evidence_hash",
  "starts_at",
  "ends_at",
  "revision",
  "activated_at",
  "created_at",
  "updated_at",
]);
const CAMPAIGN_TRANSITION_FIELDS = Object.freeze([
  "transition_id",
  "transition_key",
  "campaign_id",
  "campaign_revision",
  "from_status",
  "to_status",
  "reason_code",
  "actor_kind",
  "evidence_hash",
  "occurred_at",
  "created_at",
]);
const TRACKING_FIELDS = Object.freeze([
  "tracking_code_hash",
  "code_version",
  "campaign_id",
  "ambassador_id",
  "partner_link_id",
  "authority_evidence_hash",
  "issued_at",
  "expires_at",
  "created_at",
]);
const TOUCHPOINT_FIELDS = Object.freeze([
  "touchpoint_id",
  "touchpoint_key",
  "actor_pseudonym",
  "pseudonym_key_version",
  "tracking_code_hash",
  "ambassador_id",
  "campaign_id",
  "partner_link_id",
  "source_evidence_hash",
  "origin",
  "occurred_at",
  "valid_until",
  "recorded_at",
  "retention_until",
]);
const DECISION_FIELDS = Object.freeze([
  "decision_id",
  "decision_key",
  "actor_pseudonym",
  "pseudonym_key_version",
  "attribution_kind",
  "outcome",
  "ambassador_id",
  "campaign_id",
  "touchpoint_id",
  "authority_kind",
  "authority_evidence_hash",
  "reason_code",
  "model_version",
  "occurred_at",
  "decided_at",
  "retention_until",
]);

export function createD1AmbassadorAttributionStore(db) {
  if (!db?.prepare || !db?.batch) {
    throw new TypeError("D1 ambassador attribution store requires prepare and batch");
  }
  return Object.freeze({
    async createProfile(row) {
      const result = await db.prepare(
        `INSERT INTO ambassador_profiles_v2 (
           ambassador_id, partner_profile_id, owner_pseudonym,
           pseudonym_key_version, status, eligibility_evidence_hash,
           revision, activated_at, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM partner_profiles profile
         JOIN user_roles role
           ON role.telegram_id = profile.telegram_id
          AND role.role = 'partner'
          AND role.status = 'active'
         WHERE profile.id = ?
           AND profile.telegram_id = ?
           AND profile.status = 'active'
         ON CONFLICT DO NOTHING`,
      ).bind(
        row.ambassador_id,
        row.partner_profile_id,
        row.owner_pseudonym,
        row.pseudonym_key_version,
        row.status,
        row.eligibility_evidence_hash,
        row.revision,
        row.activated_at,
        row.created_at,
        row.updated_at,
        row.partner_profile_id,
        row.authority_owner_telegram_id,
      ).run();
      const existing = await db.prepare(
        `SELECT * FROM ambassador_profiles_v2
         WHERE ambassador_id = ? OR partner_profile_id = ? LIMIT 1`,
      ).bind(row.ambassador_id, row.partner_profile_id).first();
      if (!existing) throw new Error("ambassador profile authority is invalid");
      if (!exactFields(existing, row, PROFILE_FIELDS)) {
        return Object.freeze({ outcome: "conflict" });
      }
      return Object.freeze({
        outcome: changed(result) === 1 ? "inserted" : "duplicate",
        profile: existing,
      });
    },

    async getProfile(ambassadorId) {
      return db.prepare(
        "SELECT * FROM ambassador_profiles_v2 WHERE ambassador_id = ? LIMIT 1",
      ).bind(ambassadorId).first();
    },

    async resolveProfileAuthority(partnerProfileId) {
      return db.prepare(
        `SELECT profile.id AS partner_profile_id,
                profile.telegram_id AS owner_telegram_id,
                profile.status AS partner_profile_status,
                role.status AS partner_role_status
         FROM partner_profiles profile
         LEFT JOIN user_roles role
           ON role.telegram_id = profile.telegram_id
          AND role.role = 'partner'
         WHERE profile.id = ? LIMIT 1`,
      ).bind(partnerProfileId).first();
    },

    async resolveRelationshipAuthority(actorTelegramId, ambassadorId) {
      return db.prepare(
        `WITH RECURSIVE inviter_chain(telegram_id, path, cycle, depth) AS (
           SELECT subject.inviter_id,
                  ',' || CAST(subject.telegram_id AS TEXT) || ',',
                  CASE
                    WHEN subject.inviter_id = subject.telegram_id THEN 1
                    ELSE 0
                  END,
                  1
           FROM users subject
           WHERE subject.telegram_id = ?
           UNION ALL
           SELECT ancestor.inviter_id,
                  chain.path || CAST(chain.telegram_id AS TEXT) || ',',
                  CASE
                    WHEN instr(
                      chain.path,
                      ',' || CAST(ancestor.inviter_id AS TEXT) || ','
                    ) > 0 THEN 1
                    ELSE 0
                  END,
                  chain.depth + 1
           FROM users ancestor
           JOIN inviter_chain chain
             ON ancestor.telegram_id = chain.telegram_id
           WHERE chain.telegram_id IS NOT NULL
             AND chain.cycle = 0
             AND chain.depth < 64
         )
         SELECT subject.inviter_id AS first_inviter_telegram_id,
                subject.inviter_bound_at,
                owner.telegram_id AS owner_telegram_id,
                CASE WHEN EXISTS (
                  SELECT 1 FROM inviter_chain
                  WHERE cycle = 1 OR (depth = 64 AND telegram_id IS NOT NULL)
                ) THEN 1 ELSE 0 END AS cycle_detected
         FROM users subject
         JOIN ambassador_profiles_v2 ambassador
           ON ambassador.ambassador_id = ?
         JOIN partner_profiles owner
           ON owner.id = ambassador.partner_profile_id
         WHERE subject.telegram_id = ?
         LIMIT 1`,
      ).bind(actorTelegramId, ambassadorId, actorTelegramId).first();
    },

    async getProfileTransition(transitionKey, transitionId) {
      return db.prepare(
        `SELECT * FROM ambassador_profile_transitions
         WHERE transition_key = ? OR transition_id = ? LIMIT 1`,
      ).bind(transitionKey, transitionId).first();
    },

    async writeProfileTransition(row) {
      const result = await db.prepare(
        `INSERT INTO ambassador_profile_transitions (
           transition_id, transition_key, ambassador_id, profile_revision,
           from_status, to_status, reason_code, actor_kind, evidence_hash,
           occurred_at, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM ambassador_profiles_v2 ambassador
         JOIN partner_profiles profile
           ON profile.id = ambassador.partner_profile_id
         LEFT JOIN user_roles role
           ON role.telegram_id = profile.telegram_id
          AND role.role = 'partner'
         WHERE ambassador.ambassador_id = ?
           AND (
             ? != 'active'
             OR (
               profile.telegram_id = ?
               AND profile.status = 'active'
               AND role.status = 'active'
             )
           )
         ON CONFLICT DO NOTHING`,
      ).bind(
        row.transition_id,
        row.transition_key,
        row.ambassador_id,
        row.profile_revision,
        row.from_status,
        row.to_status,
        row.reason_code,
        row.actor_kind,
        row.evidence_hash,
        row.occurred_at,
        row.created_at,
        row.ambassador_id,
        row.to_status,
        row.authority_owner_telegram_id,
      ).run();
      const existing = await db.prepare(
        `SELECT * FROM ambassador_profile_transitions
         WHERE transition_key = ? OR transition_id = ? LIMIT 1`,
      ).bind(row.transition_key, row.transition_id).first();
      if (!existing || !exactFields(existing, row, PROFILE_TRANSITION_FIELDS)) {
        return Object.freeze({ outcome: "conflict" });
      }
      const profile = await db.prepare(
        "SELECT * FROM ambassador_profiles_v2 WHERE ambassador_id = ? LIMIT 1",
      ).bind(row.ambassador_id).first();
      if (
        !profile ||
        String(profile.status) !== row.to_status ||
        Number(profile.revision) !== row.profile_revision
      ) {
        throw new Error("ambassador profile transition was not applied");
      }
      return Object.freeze({
        outcome: changed(result) === 1 ? "inserted" : "duplicate",
        profile,
      });
    },

    async createCampaign(row) {
      const result = await db.prepare(
        `INSERT INTO ambassador_campaigns (
           campaign_id, ambassador_id, scope_kind, program_code,
           catalog_offer_id, status, scope_evidence_hash, starts_at,
           ends_at, revision, activated_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        row.campaign_id,
        row.ambassador_id,
        row.scope_kind,
        row.program_code,
        row.catalog_offer_id,
        row.status,
        row.scope_evidence_hash,
        row.starts_at,
        row.ends_at,
        row.revision,
        row.activated_at,
        row.created_at,
        row.updated_at,
      ).run();
      const existing = await db.prepare(
        "SELECT * FROM ambassador_campaigns WHERE campaign_id = ? LIMIT 1",
      ).bind(row.campaign_id).first();
      if (!existing) throw new Error("ambassador campaign authority is invalid");
      if (!exactFields(existing, row, CAMPAIGN_FIELDS)) {
        return Object.freeze({ outcome: "conflict" });
      }
      return Object.freeze({
        outcome: changed(result) === 1 ? "inserted" : "duplicate",
        campaign: existing,
      });
    },

    async getCampaign(campaignId) {
      return db.prepare(
        "SELECT * FROM ambassador_campaigns WHERE campaign_id = ? LIMIT 1",
      ).bind(campaignId).first();
    },

    async getCampaignTransition(transitionKey, transitionId) {
      return db.prepare(
        `SELECT * FROM ambassador_campaign_transitions
         WHERE transition_key = ? OR transition_id = ? LIMIT 1`,
      ).bind(transitionKey, transitionId).first();
    },

    async writeCampaignTransition(row) {
      const result = await db.prepare(
        `INSERT INTO ambassador_campaign_transitions (
           transition_id, transition_key, campaign_id, campaign_revision,
           from_status, to_status, reason_code, actor_kind, evidence_hash,
           occurred_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        row.transition_id,
        row.transition_key,
        row.campaign_id,
        row.campaign_revision,
        row.from_status,
        row.to_status,
        row.reason_code,
        row.actor_kind,
        row.evidence_hash,
        row.occurred_at,
        row.created_at,
      ).run();
      const existing = await db.prepare(
        `SELECT * FROM ambassador_campaign_transitions
         WHERE transition_key = ? OR transition_id = ? LIMIT 1`,
      ).bind(row.transition_key, row.transition_id).first();
      if (!existing || !exactFields(existing, row, CAMPAIGN_TRANSITION_FIELDS)) {
        return Object.freeze({ outcome: "conflict" });
      }
      const campaign = await db.prepare(
        "SELECT * FROM ambassador_campaigns WHERE campaign_id = ? LIMIT 1",
      ).bind(row.campaign_id).first();
      if (
        !campaign ||
        String(campaign.status) !== row.to_status ||
        Number(campaign.revision) !== row.campaign_revision
      ) {
        throw new Error("ambassador campaign transition was not applied");
      }
      return Object.freeze({
        outcome: changed(result) === 1 ? "inserted" : "duplicate",
        campaign,
      });
    },

    async issueTrackingCode(row) {
      const result = await db.prepare(
        `INSERT INTO ambassador_tracking_codes (
           tracking_code_hash, code_version, campaign_id, ambassador_id,
           partner_link_id, authority_evidence_hash, issued_at, expires_at,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        row.tracking_code_hash,
        row.code_version,
        row.campaign_id,
        row.ambassador_id,
        row.partner_link_id,
        row.authority_evidence_hash,
        row.issued_at,
        row.expires_at,
        row.created_at,
      ).run();
      const existing = await db.prepare(
        `SELECT * FROM ambassador_tracking_codes
         WHERE tracking_code_hash = ? LIMIT 1`,
      ).bind(row.tracking_code_hash).first();
      if (!existing) throw new Error("tracking code authority is invalid");
      if (!exactFields(existing, row, TRACKING_FIELDS)) {
        return Object.freeze({ outcome: "conflict" });
      }
      return Object.freeze({
        outcome: changed(result) === 1 ? "inserted" : "duplicate",
      });
    },

    async resolveTrackingCode(trackingCodeHash) {
      return db.prepare(
        `SELECT code.*, campaign.status AS campaign_status,
                campaign.starts_at AS campaign_starts_at,
                campaign.ends_at AS campaign_ends_at,
                profile.status AS profile_status,
                profile.owner_pseudonym,
                profile.pseudonym_key_version AS owner_key_version,
                link.status AS link_status,
                link.ownership_confirmed,
                link.traffic_confirmed,
                offer.status AS offer_status,
                program.status AS program_status,
                revocation.revoked_at
         FROM ambassador_tracking_codes code
         JOIN ambassador_campaigns campaign
           ON campaign.campaign_id = code.campaign_id
         JOIN ambassador_profiles_v2 profile
           ON profile.ambassador_id = code.ambassador_id
         JOIN partner_links link ON link.id = code.partner_link_id
         JOIN program_offers offer ON offer.id = link.catalog_offer_id
         JOIN partner_programs program ON program.code = offer.program_code
         LEFT JOIN ambassador_tracking_code_revocations revocation
           ON revocation.tracking_code_hash = code.tracking_code_hash
         WHERE code.tracking_code_hash = ? LIMIT 1`,
      ).bind(trackingCodeHash).first();
    },

    async revokeTrackingCode(row) {
      const result = await db.prepare(
        `INSERT INTO ambassador_tracking_code_revocations (
           tracking_code_hash, reason_code, actor_kind, evidence_hash,
           revoked_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tracking_code_hash) DO NOTHING`,
      ).bind(
        row.tracking_code_hash,
        row.reason_code,
        row.actor_kind,
        row.evidence_hash,
        row.revoked_at,
        row.created_at,
      ).run();
      const existing = await db.prepare(
        `SELECT * FROM ambassador_tracking_code_revocations
         WHERE tracking_code_hash = ? LIMIT 1`,
      ).bind(row.tracking_code_hash).first();
      const fields = [
        "tracking_code_hash",
        "reason_code",
        "actor_kind",
        "evidence_hash",
        "revoked_at",
        "created_at",
      ];
      if (!existing) throw new Error("tracking revocation authority is invalid");
      if (!exactFields(existing, row, fields)) {
        return Object.freeze({ outcome: "conflict" });
      }
      return Object.freeze({
        outcome: changed(result) === 1 ? "inserted" : "duplicate",
      });
    },

    async writeTouchpoint(row) {
      const result = await db.prepare(
        `INSERT INTO analytics_attribution_touchpoints (
           touchpoint_id, touchpoint_key, actor_pseudonym,
           pseudonym_key_version, tracking_code_hash, ambassador_id,
           campaign_id, partner_link_id, source_evidence_hash, origin,
           occurred_at, valid_until, recorded_at, retention_until
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        row.touchpoint_id,
        row.touchpoint_key,
        row.actor_pseudonym,
        row.pseudonym_key_version,
        row.tracking_code_hash,
        row.ambassador_id,
        row.campaign_id,
        row.partner_link_id,
        row.source_evidence_hash,
        row.origin,
        row.occurred_at,
        row.valid_until,
        row.recorded_at,
        row.retention_until,
      ).run();
      const existing = await db.prepare(
        `SELECT * FROM analytics_attribution_touchpoints
         WHERE touchpoint_key = ? OR touchpoint_id = ? LIMIT 1`,
      ).bind(row.touchpoint_key, row.touchpoint_id).first();
      if (!existing) throw new Error("attribution touchpoint authority is invalid");
      if (!exactFields(existing, row, TOUCHPOINT_FIELDS)) {
        return Object.freeze({ outcome: "conflict" });
      }
      return Object.freeze({
        outcome: changed(result) === 1 ? "inserted" : "duplicate",
        touchpoint: existing,
      });
    },

    async findLatestTouchpoint(actorPseudonym, occurredAt) {
      return db.prepare(
        `SELECT * FROM analytics_attribution_touchpoints
         WHERE actor_pseudonym = ? AND occurred_at <= ?
         ORDER BY occurred_at DESC, touchpoint_id DESC LIMIT 1`,
      ).bind(actorPseudonym, occurredAt).first();
    },

    async resolveCommercialAuthority({
      authorityKind,
      sourceRecordId,
      actorPseudonym,
      ambassadorId,
      campaignId,
    }) {
      if (authorityKind === "lead_partner_attribution") {
        return db.prepare(
          `SELECT request.telegram_id AS source_actor_telegram_id,
                  source_owner.telegram_id AS source_owner_telegram_id,
                  'attributed' AS authority_status,
                  unixepoch(attribution.attributed_at) AS source_occurred_at,
                  CASE WHEN
                    attribution.partner_profile_id = profile.partner_profile_id
                    AND link.partner_profile_id = attribution.partner_profile_id
                    AND attribution.program_code = campaign.program_code
                    AND offer.program_code = campaign.program_code
                    AND (
                      (campaign.scope_kind = 'program'
                        AND campaign.catalog_offer_id IS NULL)
                      OR (campaign.scope_kind = 'offer'
                        AND campaign.catalog_offer_id = link.catalog_offer_id)
                    )
                  THEN 1 ELSE 0 END AS owner_matches
           FROM lead_partner_attribution attribution
           JOIN lead_requests request ON request.id = attribution.lead_id
           JOIN partner_links link ON link.id = attribution.partner_link_id
           JOIN program_offers offer ON offer.id = link.catalog_offer_id
           JOIN partner_profiles source_owner
             ON source_owner.id = attribution.partner_profile_id
           JOIN ambassador_campaigns campaign ON campaign.campaign_id = ?
           JOIN ambassador_profiles_v2 profile
             ON profile.ambassador_id = ?
            AND campaign.ambassador_id = profile.ambassador_id
           WHERE attribution.lead_id = ? LIMIT 1`,
        ).bind(campaignId, ambassadorId, sourceRecordId).first();
      }
      if (authorityKind === "stars_access") {
        return db.prepare(
          `SELECT access.telegram_id AS source_actor_telegram_id,
                  owner.telegram_id AS source_owner_telegram_id,
                  CASE WHEN access.status = 'active'
                    THEN 'applied' ELSE access.status END AS authority_status,
                  access.starts_at AS source_occurred_at,
                  CASE WHEN EXISTS (
                    SELECT 1 FROM analytics_attribution_touchpoints touchpoint
                    WHERE touchpoint.actor_pseudonym = ?
                      AND touchpoint.ambassador_id = profile.ambassador_id
                      AND touchpoint.campaign_id = campaign.campaign_id
                      AND touchpoint.occurred_at <= access.starts_at
                      AND touchpoint.valid_until >= access.starts_at
                  ) THEN 1 ELSE 0 END AS owner_matches
           FROM subscription_access_grants access
           JOIN ambassador_campaigns campaign ON campaign.campaign_id = ?
           JOIN ambassador_profiles_v2 profile
             ON profile.ambassador_id = ?
            AND campaign.ambassador_id = profile.ambassador_id
           JOIN partner_profiles owner ON owner.id = profile.partner_profile_id
           WHERE access.grant_id = ? LIMIT 1`,
        ).bind(
          actorPseudonym,
          campaignId,
          ambassadorId,
          sourceRecordId,
        ).first();
      }
      if (authorityKind === "referral_reward") {
        return db.prepare(
          `SELECT reward.buyer_telegram_id AS source_actor_telegram_id,
                  reward.beneficiary_telegram_id AS source_owner_telegram_id,
                  reward.reward_status AS authority_status,
                  COALESCE(
                    reward.confirmed_at,
                    reward.cancelled_at,
                    reward.created_at
                  ) AS source_occurred_at,
                  CASE WHEN reward.beneficiary_telegram_id = owner.telegram_id
                    THEN 1 ELSE 0 END AS owner_matches
           FROM referral_rewards reward
           JOIN ambassador_campaigns campaign ON campaign.campaign_id = ?
           JOIN ambassador_profiles_v2 profile
             ON profile.ambassador_id = ?
            AND campaign.ambassador_id = profile.ambassador_id
           JOIN partner_profiles owner ON owner.id = profile.partner_profile_id
           WHERE reward.reward_id = ? LIMIT 1`,
        ).bind(campaignId, ambassadorId, sourceRecordId).first();
      }
      throw new TypeError("commercial authority kind is invalid");
    },

    async writeDecision(row) {
      const result = await db.prepare(
        `INSERT INTO analytics_attribution_decisions (
           decision_id, decision_key, actor_pseudonym,
           pseudonym_key_version, attribution_kind, outcome,
           ambassador_id, campaign_id, touchpoint_id, authority_kind,
           authority_evidence_hash, reason_code, model_version, occurred_at,
           decided_at, retention_until
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        row.decision_id,
        row.decision_key,
        row.actor_pseudonym,
        row.pseudonym_key_version,
        row.attribution_kind,
        row.outcome,
        row.ambassador_id,
        row.campaign_id,
        row.touchpoint_id,
        row.authority_kind,
        row.authority_evidence_hash,
        row.reason_code,
        row.model_version,
        row.occurred_at,
        row.decided_at,
        row.retention_until,
      ).run();
      const existing = await db.prepare(
        `SELECT * FROM analytics_attribution_decisions
         WHERE decision_key = ? OR decision_id = ? LIMIT 1`,
      ).bind(row.decision_key, row.decision_id).first();
      if (!existing || !exactFields(existing, row, DECISION_FIELDS)) {
        return Object.freeze({ outcome: "conflict" });
      }
      return Object.freeze({
        outcome: changed(result) === 1 ? "inserted" : "duplicate",
        decision: existing,
      });
    },
  });
}

export async function createAmbassadorProfileDraft({
  config,
  store,
  ambassadorId,
  partnerProfileId,
  authority,
  evidenceIdentity,
  createdAt,
  pseudonymSecret,
  pseudonymKeyVersion = ANALYTICS_V2_DEFAULTS.pseudonymKeyVersion,
  cryptoImpl = globalThis.crypto,
} = {}) {
  assertAdminShadow(config);
  if (!store?.createProfile || !store?.resolveProfileAuthority) {
    throw new TypeError("ambassador store is incomplete");
  }
  assertCrypto(cryptoImpl);
  const normalizedAmbassadorId = normalizeUuid(ambassadorId, "ambassador id");
  const normalizedProfileId = requiredInteger(partnerProfileId, "partner profile id");
  const normalizedAuthority = normalizeProfileAuthority(authority, normalizedProfileId);
  await assertProfileDatabaseAuthority(store, normalizedAuthority);
  const normalizedEvidenceIdentity = normalizeEvidenceIdentity(
    evidenceIdentity,
    "profile evidence identity",
  );
  const normalizedCreatedAt = requiredInteger(createdAt, "profile creation time");
  const keyVersion = requiredInteger(pseudonymKeyVersion, "pseudonym key version");
  const secret = normalizedSecret(pseudonymSecret);
  const ownerPseudonym = await createAnalyticsActorPseudonym({
    telegramId: normalizedAuthority.ownerTelegramId,
    secret,
    keyVersion,
    cryptoImpl,
  });
  const eligibilityHash = await evidenceHash(
    "ambassador-eligibility",
    { authority: normalizedAuthority, evidenceIdentity: normalizedEvidenceIdentity },
    secret,
    cryptoImpl,
  );
  const row = Object.freeze({
    ambassador_id: normalizedAmbassadorId,
    partner_profile_id: normalizedProfileId,
    owner_pseudonym: ownerPseudonym,
    pseudonym_key_version: keyVersion,
    status: "draft",
    eligibility_evidence_hash: eligibilityHash,
    revision: 1,
    activated_at: null,
    created_at: normalizedCreatedAt,
    updated_at: normalizedCreatedAt,
    authority_owner_telegram_id: normalizedAuthority.ownerTelegramId,
  });
  const result = await store.createProfile(row);
  return Object.freeze({ ...result, ambassadorId: normalizedAmbassadorId });
}

export async function transitionAmbassadorProfile({
  config,
  store,
  transitionId,
  ambassadorId,
  expectedRevision,
  fromStatus,
  toStatus,
  reasonCode,
  actorKind,
  authority,
  evidenceIdentity,
  occurredAt,
  createdAt = occurredAt,
  pseudonymSecret,
  cryptoImpl = globalThis.crypto,
} = {}) {
  assertAdminShadow(config);
  if (
    !store?.getProfile ||
    !store?.resolveProfileAuthority ||
    !store?.getProfileTransition ||
    !store?.writeProfileTransition
  ) {
    throw new TypeError("ambassador store is incomplete");
  }
  assertCrypto(cryptoImpl);
  const secret = normalizedSecret(pseudonymSecret);
  const normalizedAmbassadorId = normalizeUuid(ambassadorId, "ambassador id");
  const normalizedTransitionId = normalizeUuid(
    transitionId,
    "profile transition id",
  );
  const revision = requiredInteger(expectedRevision, "expected profile revision");
  const from = requiredCode(fromStatus, "profile from status");
  const to = requiredCode(toStatus, "profile to status");
  const reason = requiredCode(reasonCode, "profile transition reason");
  const actor = requiredCode(actorKind, "profile transition actor");
  const normalizedEvidenceIdentity = normalizeEvidenceIdentity(
    evidenceIdentity,
    "profile transition evidence identity",
  );
  if (!PROFILE_TRANSITIONS.has(`${from}:${to}:${reason}`)) {
    throw new Error("ambassador profile transition is invalid");
  }
  if (!["admin", "system"].includes(actor)) {
    throw new Error("ambassador profile transition actor is invalid");
  }
  if (reason.startsWith("admin_") && actor !== "admin") {
    throw new Error("profile transition actor does not match reason");
  }
  const current = await store.getProfile(normalizedAmbassadorId);
  if (!current) throw new Error("ambassador profile is missing");
  let normalizedAuthority = null;
  if (to === "active") {
    normalizedAuthority = normalizeProfileAuthority(
      authority,
      Number(current.partner_profile_id),
    );
    await assertProfileDatabaseAuthority(store, normalizedAuthority);
  } else if (authority !== null && authority !== undefined) {
    throw new TypeError("inactive profile transition cannot carry authority snapshot");
  }
  const at = requiredInteger(occurredAt, "profile transition time");
  const recordedAt = requiredInteger(createdAt, "profile transition record time");
  if (recordedAt < at) throw new TypeError("profile transition record time is invalid");
  const evidence = await evidenceHash(
    "ambassador-profile-transition",
    {
      ambassadorId: normalizedAmbassadorId,
      evidenceIdentity: normalizedEvidenceIdentity,
      from,
      normalizedAuthority,
      reason,
      revision: revision + 1,
      to,
    },
    secret,
    cryptoImpl,
  );
  const transitionKey = await evidenceHash(
    "ambassador-profile-transition-key",
    { ambassadorId: normalizedAmbassadorId, evidence, revision: revision + 1 },
    secret,
    cryptoImpl,
  );
  const row = Object.freeze({
    transition_id: normalizedTransitionId,
    transition_key: transitionKey,
    ambassador_id: normalizedAmbassadorId,
    profile_revision: revision + 1,
    from_status: from,
    to_status: to,
    reason_code: reason,
    actor_kind: actor,
    evidence_hash: evidence,
    occurred_at: at,
    created_at: recordedAt,
    authority_owner_telegram_id: normalizedAuthority?.ownerTelegramId ?? null,
  });
  const replay = await store.getProfileTransition(transitionKey, normalizedTransitionId);
  if (replay) {
    if (!exactFields(replay, row, PROFILE_TRANSITION_FIELDS)) {
      return Object.freeze({ outcome: "conflict" });
    }
    return Object.freeze({ outcome: "duplicate", profile: current });
  }
  if (
    String(current.status) !== from ||
    Number(current.revision) !== revision
  ) {
    throw new Error("ambassador profile revision conflict");
  }
  return store.writeProfileTransition(row);
}

export async function createAmbassadorCampaignDraft({
  config,
  store,
  campaignId,
  ambassadorId,
  scopeKind,
  programCode,
  catalogOfferId = null,
  startsAt,
  endsAt,
  evidenceIdentity,
  createdAt,
  pseudonymSecret,
  cryptoImpl = globalThis.crypto,
} = {}) {
  assertAdminShadow(config);
  if (!store?.createCampaign) throw new TypeError("ambassador store is incomplete");
  assertCrypto(cryptoImpl);
  const secret = normalizedSecret(pseudonymSecret);
  const scope = requiredCode(scopeKind, "campaign scope");
  if (!new Set(["program", "offer"]).has(scope)) {
    throw new TypeError("campaign scope is invalid");
  }
  const offerId = scope === "offer"
    ? requiredInteger(catalogOfferId, "catalog offer id")
    : null;
  if (scope === "program" && catalogOfferId !== null) {
    throw new TypeError("program campaign cannot name an offer");
  }
  const start = requiredInteger(startsAt, "campaign start");
  const end = requiredInteger(endsAt, "campaign end");
  if (end <= start) throw new TypeError("campaign period is invalid");
  const at = requiredInteger(createdAt, "campaign creation time");
  const normalizedCampaignId = normalizeUuid(campaignId, "campaign id");
  const normalizedAmbassadorId = normalizeUuid(ambassadorId, "ambassador id");
  const program = requiredCode(programCode, "program code");
  const normalizedEvidenceIdentity = normalizeEvidenceIdentity(
    evidenceIdentity,
    "campaign evidence identity",
  );
  const evidence = await evidenceHash(
    "ambassador-campaign-scope",
    {
      ambassadorId: normalizedAmbassadorId,
      catalogOfferId: offerId,
      evidenceIdentity: normalizedEvidenceIdentity,
      programCode: program,
      scopeKind: scope,
    },
    secret,
    cryptoImpl,
  );
  const row = Object.freeze({
    campaign_id: normalizedCampaignId,
    ambassador_id: normalizedAmbassadorId,
    scope_kind: scope,
    program_code: program,
    catalog_offer_id: offerId,
    status: "draft",
    scope_evidence_hash: evidence,
    starts_at: start,
    ends_at: end,
    revision: 1,
    activated_at: null,
    created_at: at,
    updated_at: at,
  });
  const result = await store.createCampaign(row);
  return Object.freeze({ ...result, campaignId: normalizedCampaignId });
}

export async function transitionAmbassadorCampaign({
  config,
  store,
  transitionId,
  campaignId,
  expectedRevision,
  fromStatus,
  toStatus,
  reasonCode,
  actorKind,
  evidenceIdentity,
  occurredAt,
  createdAt = occurredAt,
  pseudonymSecret,
  cryptoImpl = globalThis.crypto,
} = {}) {
  assertAdminShadow(config);
  if (
    !store?.getCampaign ||
    !store?.getCampaignTransition ||
    !store?.writeCampaignTransition
  ) {
    throw new TypeError("ambassador store is incomplete");
  }
  assertCrypto(cryptoImpl);
  const secret = normalizedSecret(pseudonymSecret);
  const normalizedCampaignId = normalizeUuid(campaignId, "campaign id");
  const normalizedTransitionId = normalizeUuid(
    transitionId,
    "campaign transition id",
  );
  const revision = requiredInteger(expectedRevision, "expected campaign revision");
  const from = requiredCode(fromStatus, "campaign from status");
  const to = requiredCode(toStatus, "campaign to status");
  const reason = requiredCode(reasonCode, "campaign transition reason");
  const actor = requiredCode(actorKind, "campaign transition actor");
  const normalizedEvidenceIdentity = normalizeEvidenceIdentity(
    evidenceIdentity,
    "campaign transition evidence identity",
  );
  if (!CAMPAIGN_TRANSITIONS.has(`${from}:${to}:${reason}`)) {
    throw new Error("ambassador campaign transition is invalid");
  }
  if (!["ambassador", "admin", "system"].includes(actor)) {
    throw new Error("ambassador campaign transition actor is invalid");
  }
  const expectedActors = reason.startsWith("owner_")
    ? new Set(["ambassador"])
    : reason === "period_ended"
      ? new Set(["system"])
      : reason === "activation_approved"
        ? new Set(["admin", "system"])
        : new Set(["admin"]);
  if (!expectedActors.has(actor)) {
    throw new Error("campaign transition actor does not match reason");
  }
  const current = await store.getCampaign(normalizedCampaignId);
  if (!current) throw new Error("ambassador campaign is missing");
  const at = requiredInteger(occurredAt, "campaign transition time");
  const recordedAt = requiredInteger(createdAt, "campaign transition record time");
  if (recordedAt < at) throw new TypeError("campaign transition record time is invalid");
  const evidence = await evidenceHash(
    "ambassador-campaign-transition",
    {
      campaignId: normalizedCampaignId,
      evidenceIdentity: normalizedEvidenceIdentity,
      from,
      reason,
      revision: revision + 1,
      to,
    },
    secret,
    cryptoImpl,
  );
  const transitionKey = await evidenceHash(
    "ambassador-campaign-transition-key",
    { campaignId: normalizedCampaignId, evidence, revision: revision + 1 },
    secret,
    cryptoImpl,
  );
  const row = Object.freeze({
    transition_id: normalizedTransitionId,
    transition_key: transitionKey,
    campaign_id: normalizedCampaignId,
    campaign_revision: revision + 1,
    from_status: from,
    to_status: to,
    reason_code: reason,
    actor_kind: actor,
    evidence_hash: evidence,
    occurred_at: at,
    created_at: recordedAt,
  });
  const replay = await store.getCampaignTransition(transitionKey, normalizedTransitionId);
  if (replay) {
    if (!exactFields(replay, row, CAMPAIGN_TRANSITION_FIELDS)) {
      return Object.freeze({ outcome: "conflict" });
    }
    return Object.freeze({ outcome: "duplicate", campaign: current });
  }
  if (
    String(current.status) !== from ||
    Number(current.revision) !== revision
  ) {
    throw new Error("ambassador campaign revision conflict");
  }
  return store.writeCampaignTransition(row);
}

function defaultRandomBytes(cryptoImpl) {
  if (!cryptoImpl?.getRandomValues) throw new Error("secure randomness is required");
  return cryptoImpl.getRandomValues(
    new Uint8Array(AMBASSADOR_V2_TRACKING_CODE_BYTES),
  );
}

function normalizeRandomBytes(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
  if (bytes.byteLength !== AMBASSADOR_V2_TRACKING_CODE_BYTES) {
    throw new TypeError("tracking code entropy must be exactly 24 bytes");
  }
  return bytes;
}

function normalizeTrackingCode(value) {
  const code = requiredString(value, "ambassador tracking code", {
    minimum: 52,
    maximum: 52,
  }).toLowerCase();
  if (!TRACKING_CODE_PATTERN.test(code)) {
    throw new TypeError("ambassador tracking code is invalid");
  }
  return code;
}

export async function issueAmbassadorTrackingCode({
  config,
  store,
  campaignId,
  ambassadorId,
  partnerLinkId,
  evidenceIdentity,
  issuedAt,
  expiresAt,
  createdAt = issuedAt,
  pseudonymSecret,
  randomBytes,
  cryptoImpl = globalThis.crypto,
} = {}) {
  assertAdminShadow(config);
  if (!store?.issueTrackingCode) throw new TypeError("ambassador store is incomplete");
  assertCrypto(cryptoImpl);
  const secret = normalizedSecret(pseudonymSecret);
  const bytes = normalizeRandomBytes(
    randomBytes === undefined ? defaultRandomBytes(cryptoImpl) : randomBytes,
  );
  const trackingCode = `av2_${bytesToHex(bytes)}`;
  const trackingCodeHash = await sha256Hex(trackingCode, cryptoImpl);
  const normalizedCampaignId = normalizeUuid(campaignId, "campaign id");
  const normalizedAmbassadorId = normalizeUuid(ambassadorId, "ambassador id");
  const normalizedLinkId = requiredInteger(partnerLinkId, "partner link id");
  const normalizedEvidenceIdentity = normalizeEvidenceIdentity(
    evidenceIdentity,
    "tracking authority evidence identity",
  );
  const issued = requiredInteger(issuedAt, "tracking issue time");
  const expires = requiredInteger(expiresAt, "tracking expiry time");
  const recorded = requiredInteger(createdAt, "tracking record time");
  if (expires <= issued || recorded < issued) {
    throw new TypeError("tracking code time boundary is invalid");
  }
  const evidence = await evidenceHash(
    "ambassador-tracking-authority",
    {
      ambassadorId: normalizedAmbassadorId,
      campaignId: normalizedCampaignId,
      evidenceIdentity: normalizedEvidenceIdentity,
      partnerLinkId: normalizedLinkId,
    },
    secret,
    cryptoImpl,
  );
  const row = Object.freeze({
    tracking_code_hash: trackingCodeHash,
    code_version: 1,
    campaign_id: normalizedCampaignId,
    ambassador_id: normalizedAmbassadorId,
    partner_link_id: normalizedLinkId,
    authority_evidence_hash: evidence,
    issued_at: issued,
    expires_at: expires,
    created_at: recorded,
  });
  const result = await store.issueTrackingCode(row);
  if (result.outcome === "conflict") {
    throw new Error("ambassador tracking code collision");
  }
  return Object.freeze({
    ...result,
    trackingCode,
    trackingCodeHash,
  });
}

export async function revokeAmbassadorTrackingCode({
  config,
  store,
  trackingCode,
  reasonCode,
  actorKind,
  evidenceIdentity,
  revokedAt,
  createdAt = revokedAt,
  pseudonymSecret,
  cryptoImpl = globalThis.crypto,
} = {}) {
  assertAdminShadow(config);
  if (!store?.revokeTrackingCode) throw new TypeError("ambassador store is incomplete");
  assertCrypto(cryptoImpl);
  const secret = normalizedSecret(pseudonymSecret);
  const code = normalizeTrackingCode(trackingCode);
  const reason = requiredCode(reasonCode, "tracking revocation reason");
  const actor = requiredCode(actorKind, "tracking revocation actor");
  const normalizedEvidenceIdentity = normalizeEvidenceIdentity(
    evidenceIdentity,
    "tracking revocation evidence identity",
  );
  if (!["owner_revoked", "admin_revoked", "campaign_closed", "security_review"].includes(reason)) {
    throw new TypeError("tracking revocation reason is invalid");
  }
  if (!["ambassador", "admin", "system"].includes(actor)) {
    throw new TypeError("tracking revocation actor is invalid");
  }
  if (reason === "owner_revoked" && actor !== "ambassador") {
    throw new Error("owner revocation requires ambassador actor");
  }
  const revoked = requiredInteger(revokedAt, "tracking revocation time");
  const recorded = requiredInteger(createdAt, "tracking revocation record time");
  if (recorded < revoked) throw new TypeError("tracking revocation record time is invalid");
  const trackingCodeHash = await sha256Hex(code, cryptoImpl);
  const evidence = await evidenceHash(
    "ambassador-tracking-revocation",
    {
      actor,
      evidenceIdentity: normalizedEvidenceIdentity,
      reason,
      trackingCodeHash,
    },
    secret,
    cryptoImpl,
  );
  return store.revokeTrackingCode(Object.freeze({
    tracking_code_hash: trackingCodeHash,
    reason_code: reason,
    actor_kind: actor,
    evidence_hash: evidence,
    revoked_at: revoked,
    created_at: recorded,
  }));
}

function trackingRejection(resolved, actorPseudonym, occurredAt, keyVersion) {
  if (!resolved) return "source_unknown";
  if (
    String(resolved.owner_pseudonym) === actorPseudonym &&
    Number(resolved.owner_key_version) === keyVersion
  ) return "self_attribution";
  if (
    resolved.profile_status !== "active" ||
    resolved.campaign_status !== "active" ||
    resolved.link_status !== "approved" ||
    Number(resolved.ownership_confirmed) !== 1 ||
    Number(resolved.traffic_confirmed) !== 1 ||
    resolved.offer_status !== "active" ||
    resolved.program_status !== "active"
  ) return "campaign_inactive";
  if (
    occurredAt < Number(resolved.issued_at) ||
    occurredAt > Number(resolved.expires_at) ||
    occurredAt < Number(resolved.campaign_starts_at) ||
    occurredAt > Number(resolved.campaign_ends_at) ||
    (resolved.revoked_at !== null &&
      occurredAt >= Number(resolved.revoked_at))
  ) return "campaign_expired";
  return null;
}

export async function recordAmbassadorTouchpoint({
  config,
  store,
  touchpointId,
  trackingCode,
  actorTelegramId,
  sourceTouchIdentity,
  origin,
  occurredAt,
  recordedAt,
  retentionDays = ANALYTICS_V2_DEFAULTS.rawRetentionDays,
  pseudonymSecret,
  pseudonymKeyVersion = ANALYTICS_V2_DEFAULTS.pseudonymKeyVersion,
  cryptoImpl = globalThis.crypto,
} = {}) {
  assertAdminShadow(config);
  if (!store?.resolveTrackingCode || !store?.writeTouchpoint) {
    throw new TypeError("ambassador store is incomplete");
  }
  assertCrypto(cryptoImpl);
  const secret = normalizedSecret(pseudonymSecret);
  const code = normalizeTrackingCode(trackingCode);
  const trackingCodeHash = await sha256Hex(code, cryptoImpl);
  const subject = requiredInteger(actorTelegramId, "touchpoint actor Telegram id");
  const normalizedSourceTouchIdentity = normalizeEvidenceIdentity(
    sourceTouchIdentity,
    "touchpoint source identity",
  );
  const occurred = requiredInteger(occurredAt, "touchpoint occurrence time");
  const recorded = requiredInteger(recordedAt, "touchpoint record time");
  if (recorded < occurred) throw new TypeError("touchpoint record time is invalid");
  const retention = normalizeRetention(retentionDays);
  const keyVersion = requiredInteger(pseudonymKeyVersion, "pseudonym key version");
  const actorPseudonym = await createAnalyticsActorPseudonym({
    telegramId: subject,
    secret,
    keyVersion,
    cryptoImpl,
  });
  const resolved = await store.resolveTrackingCode(trackingCodeHash);
  const rejection = trackingRejection(
    resolved,
    actorPseudonym,
    occurred,
    keyVersion,
  );
  if (rejection) {
    return Object.freeze({ outcome: "rejected", reasonCode: rejection });
  }
  const sourceEvidenceHash = await evidenceHash(
    "ambassador-touch-source",
    {
      partnerLinkId: Number(resolved.partner_link_id),
      sourceTouchIdentity: normalizedSourceTouchIdentity,
      trackingCodeHash,
    },
    secret,
    cryptoImpl,
  );
  const touchpointKey = await evidenceHash(
    "ambassador-touch-key",
    {
      actorPseudonym,
      occurredAt: occurred,
      sourceEvidenceHash,
      trackingCodeHash,
    },
    secret,
    cryptoImpl,
  );
  const row = Object.freeze({
    touchpoint_id: normalizeUuid(touchpointId, "touchpoint id"),
    touchpoint_key: touchpointKey,
    actor_pseudonym: actorPseudonym,
    pseudonym_key_version: keyVersion,
    tracking_code_hash: trackingCodeHash,
    ambassador_id: String(resolved.ambassador_id),
    campaign_id: String(resolved.campaign_id),
    partner_link_id: Number(resolved.partner_link_id),
    source_evidence_hash: sourceEvidenceHash,
    origin: requiredCode(origin, "touchpoint origin", { maximum: 24 }),
    occurred_at: occurred,
    valid_until: occurred + AMBASSADOR_V2_ENGAGEMENT_WINDOW_SECONDS,
    recorded_at: recorded,
    retention_until: recorded + retention * DAY,
  });
  if (!["live", "backfill", "reconciliation"].includes(row.origin)) {
    throw new TypeError("touchpoint origin is invalid");
  }
  const result = await store.writeTouchpoint(row);
  return Object.freeze({
    ...result,
    reasonCode: result.outcome === "conflict" ? "idempotency_conflict" : null,
    touchpointId: row.touchpoint_id,
  });
}

async function persistDecision({
  store,
  decisionId,
  attributionKind,
  outcome,
  reasonCode,
  authorityKind,
  authorityEvidence,
  sourceIdentity,
  actorTelegramId,
  ambassadorId,
  campaignId,
  touchpointId,
  occurredAt,
  decidedAt,
  retentionDays,
  pseudonymSecret,
  pseudonymKeyVersion,
  cryptoImpl,
}) {
  const secret = normalizedSecret(pseudonymSecret);
  const keyVersion = requiredInteger(pseudonymKeyVersion, "pseudonym key version");
  const occurred = requiredInteger(occurredAt, "attribution occurrence time");
  const decided = requiredInteger(decidedAt, "attribution decision time");
  if (decided < occurred) throw new TypeError("attribution decision time is invalid");
  const retention = normalizeRetention(retentionDays);
  const actorPseudonym = await createAnalyticsActorPseudonym({
    telegramId: requiredInteger(actorTelegramId, "attribution actor Telegram id"),
    secret,
    keyVersion,
    cryptoImpl,
  });
  const authorityEvidenceHash = await evidenceHash(
    "ambassador-attribution-authority",
    authorityEvidence,
    secret,
    cryptoImpl,
  );
  const decisionKey = await evidenceHash(
    "ambassador-attribution-decision-key",
    { attributionKind, authorityKind, sourceIdentity },
    secret,
    cryptoImpl,
  );
  const row = Object.freeze({
    decision_id: normalizeUuid(decisionId, "attribution decision id"),
    decision_key: decisionKey,
    actor_pseudonym: actorPseudonym,
    pseudonym_key_version: keyVersion,
    attribution_kind: attributionKind,
    outcome,
    ambassador_id: ambassadorId,
    campaign_id: campaignId,
    touchpoint_id: touchpointId,
    authority_kind: authorityKind,
    authority_evidence_hash: authorityEvidenceHash,
    reason_code: reasonCode,
    model_version: 1,
    occurred_at: occurred,
    decided_at: decided,
    retention_until: decided + retention * DAY,
  });
  const result = await store.writeDecision(row);
  return Object.freeze({
    ...result,
    writeOutcome: result.outcome,
    attributionKind,
    outcome,
    reasonCode,
    ambassadorId,
    campaignId,
  });
}

export async function recordRelationshipAttribution({
  config,
  store,
  decisionId,
  ambassadorId,
  actorTelegramId,
  authority,
  occurredAt,
  decidedAt,
  retentionDays = ANALYTICS_V2_DEFAULTS.rawRetentionDays,
  pseudonymSecret,
  pseudonymKeyVersion = ANALYTICS_V2_DEFAULTS.pseudonymKeyVersion,
  cryptoImpl = globalThis.crypto,
} = {}) {
  assertAdminShadow(config);
  if (!store?.resolveRelationshipAuthority || !store?.writeDecision) {
    throw new TypeError("ambassador store is incomplete");
  }
  assertCrypto(cryptoImpl);
  assertExactKeys(authority, RELATIONSHIP_AUTHORITY_KEYS, "relationship authority");
  const subject = requiredInteger(actorTelegramId, "relationship subject");
  const normalizedAmbassadorId = normalizeUuid(ambassadorId, "ambassador id");
  const owner = requiredInteger(authority.ownerTelegramId, "relationship owner");
  const inviter = authority.firstInviterTelegramId === null
    ? null
    : requiredInteger(authority.firstInviterTelegramId, "first inviter");
  const inviterBound = requiredBoolean(authority.inviterBound, "inviter bound");
  const cycleDetected = requiredBoolean(authority.cycleDetected, "cycle detected");
  const sourceIdentity = normalizeEvidenceIdentity(
    authority.sourceIdentity,
    "relationship source identity",
  );
  const exactAuthority = await store.resolveRelationshipAuthority(
    subject,
    normalizedAmbassadorId,
  );
  if (!exactAuthority) throw new Error("relationship authority source is missing");
  if (
    Number(exactAuthority.owner_telegram_id) !== owner ||
    (exactAuthority.first_inviter_telegram_id === null
      ? null
      : Number(exactAuthority.first_inviter_telegram_id)) !== inviter ||
    Boolean(exactAuthority.inviter_bound_at) !== inviterBound ||
    Boolean(Number(exactAuthority.cycle_detected)) !== cycleDetected
  ) {
    throw new Error("relationship authority snapshot mismatch");
  }
  let outcome = "attributed";
  let reasonCode = "attributed_exact";
  if (!inviterBound || inviter === null) {
    outcome = "unattributed";
    reasonCode = "no_exact_evidence";
  } else if (subject === owner) {
    outcome = "rejected";
    reasonCode = "self_attribution";
  } else if (cycleDetected) {
    outcome = "rejected";
    reasonCode = "cycle_detected";
  } else if (inviter !== owner) {
    outcome = "unattributed";
    reasonCode = "owner_mismatch";
  }
  return persistDecision({
    store,
    decisionId,
    attributionKind: "relationship",
    outcome,
    reasonCode,
    authorityKind: "first_inviter",
    authorityEvidence: {
      cycleDetected,
      firstInviterTelegramId: inviter,
      inviterBound,
      ownerTelegramId: owner,
      sourceIdentity,
    },
    sourceIdentity,
    actorTelegramId: subject,
    ambassadorId: normalizedAmbassadorId,
    campaignId: null,
    touchpointId: null,
    occurredAt,
    decidedAt,
    retentionDays,
    pseudonymSecret,
    pseudonymKeyVersion,
    cryptoImpl,
  });
}

export async function recordEngagementAttribution({
  config,
  store,
  decisionId,
  actorTelegramId,
  sourceIdentity,
  occurredAt,
  decidedAt,
  retentionDays = ANALYTICS_V2_DEFAULTS.rawRetentionDays,
  pseudonymSecret,
  pseudonymKeyVersion = ANALYTICS_V2_DEFAULTS.pseudonymKeyVersion,
  cryptoImpl = globalThis.crypto,
} = {}) {
  assertAdminShadow(config);
  if (!store?.findLatestTouchpoint || !store?.writeDecision) {
    throw new TypeError("ambassador store is incomplete");
  }
  assertCrypto(cryptoImpl);
  const subject = requiredInteger(actorTelegramId, "engagement subject");
  const normalizedSourceIdentity = normalizeEvidenceIdentity(
    sourceIdentity,
    "engagement source identity",
  );
  const occurred = requiredInteger(occurredAt, "engagement occurrence time");
  const secret = normalizedSecret(pseudonymSecret);
  const keyVersion = requiredInteger(pseudonymKeyVersion, "pseudonym key version");
  const actorPseudonym = await createAnalyticsActorPseudonym({
    telegramId: subject,
    secret,
    keyVersion,
    cryptoImpl,
  });
  const touchpoint = await store.findLatestTouchpoint(actorPseudonym, occurred);
  const attributed = touchpoint && Number(touchpoint.valid_until) >= occurred;
  return persistDecision({
    store,
    decisionId,
    attributionKind: "engagement",
    outcome: attributed ? "attributed" : "unattributed",
    reasonCode: attributed
      ? "attributed_exact"
      : touchpoint ? "window_expired" : "no_exact_evidence",
    authorityKind: "verified_touchpoint",
    authorityEvidence: attributed
      ? {
        sourceIdentity: normalizedSourceIdentity,
        touchpointKey: String(touchpoint.touchpoint_key),
        validUntil: Number(touchpoint.valid_until),
      }
      : {
        sourceIdentity: normalizedSourceIdentity,
        touchpointFound: Boolean(touchpoint),
      },
    sourceIdentity: normalizedSourceIdentity,
    actorTelegramId: subject,
    ambassadorId: attributed ? String(touchpoint.ambassador_id) : null,
    campaignId: attributed ? String(touchpoint.campaign_id) : null,
    touchpointId: attributed ? String(touchpoint.touchpoint_id) : null,
    occurredAt: occurred,
    decidedAt,
    retentionDays,
    pseudonymSecret: secret,
    pseudonymKeyVersion: keyVersion,
    cryptoImpl,
  });
}

export async function recordCommercialAttribution({
  config,
  store,
  decisionId,
  ambassadorId,
  campaignId,
  actorTelegramId,
  authority,
  occurredAt,
  decidedAt,
  retentionDays = ANALYTICS_V2_DEFAULTS.rawRetentionDays,
  pseudonymSecret,
  pseudonymKeyVersion = ANALYTICS_V2_DEFAULTS.pseudonymKeyVersion,
  cryptoImpl = globalThis.crypto,
} = {}) {
  assertAdminShadow(config);
  if (
    !store?.getProfile ||
    !store?.getCampaign ||
    !store?.resolveProfileAuthority ||
    !store?.resolveRelationshipAuthority ||
    !store?.resolveCommercialAuthority ||
    !store?.writeDecision
  ) {
    throw new TypeError("ambassador store is incomplete");
  }
  assertCrypto(cryptoImpl);
  assertExactKeys(authority, COMMERCIAL_AUTHORITY_KEYS, "commercial authority");
  const subject = requiredInteger(actorTelegramId, "commercial subject");
  const normalizedAmbassadorId = normalizeUuid(ambassadorId, "ambassador id");
  const normalizedCampaignId = normalizeUuid(campaignId, "campaign id");
  const owner = requiredInteger(authority.ownerTelegramId, "commercial owner");
  const authorityKind = requiredCode(authority.authorityKind, "commercial authority kind");
  if (!Object.hasOwn(COMMERCIAL_STATUS, authorityKind)) {
    throw new TypeError("commercial authority kind is invalid");
  }
  const authorityStatus = requiredCode(
    authority.authorityStatus,
    "commercial authority status",
  );
  const sourceRecordId = normalizeCommercialSourceRecord(
    authorityKind,
    authority.sourceRecordId,
  );
  const sourceIdentity = `${authorityKind}:${sourceRecordId}`;
  const sourceKnown = requiredBoolean(authority.sourceKnown, "commercial source known");
  const ownerMatches = requiredBoolean(authority.ownerMatches, "commercial owner match");
  const cycleDetected = requiredBoolean(authority.cycleDetected, "commercial cycle detected");
  const occurred = requiredInteger(occurredAt, "attribution occurrence time");
  const secret = normalizedSecret(pseudonymSecret);
  const keyVersion = requiredInteger(pseudonymKeyVersion, "pseudonym key version");
  const [actorPseudonym, ownerPseudonym] = await Promise.all([
    createAnalyticsActorPseudonym({
      telegramId: subject,
      secret,
      keyVersion,
      cryptoImpl,
    }),
    createAnalyticsActorPseudonym({
      telegramId: owner,
      secret,
      keyVersion,
      cryptoImpl,
    }),
  ]);
  const [profile, campaign, relationship] = await Promise.all([
    store.getProfile(normalizedAmbassadorId),
    store.getCampaign(normalizedCampaignId),
    store.resolveRelationshipAuthority(subject, normalizedAmbassadorId),
  ]);
  if (!profile) throw new Error("commercial ambassador profile is missing");
  if (!campaign || String(campaign.ambassador_id) !== normalizedAmbassadorId) {
    throw new Error("commercial campaign authority mismatch");
  }
  if (!relationship) throw new Error("commercial relationship authority is missing");
  const profileAuthority = await store.resolveProfileAuthority(
    Number(profile.partner_profile_id),
  );
  if (
    String(profile.owner_pseudonym) !== ownerPseudonym ||
    Number(profile.pseudonym_key_version) !== keyVersion ||
    !profileAuthority ||
    Number(profileAuthority.owner_telegram_id) !== owner ||
    Number(relationship.owner_telegram_id) !== owner
  ) {
    throw new Error("commercial owner does not match ambassador profile");
  }
  const exactCycleDetected = Boolean(Number(relationship.cycle_detected));
  if (cycleDetected !== exactCycleDetected) {
    throw new Error("commercial authority snapshot mismatch");
  }
  const exactSource = await store.resolveCommercialAuthority({
    authorityKind,
    sourceRecordId,
    actorPseudonym,
    ambassadorId: normalizedAmbassadorId,
    campaignId: normalizedCampaignId,
  });
  const exactSourceKnown = Boolean(exactSource);
  const exactAuthorityStatus = exactSource
    ? requiredCode(exactSource.authority_status, "commercial source status")
    : "unknown";
  const exactOwnerMatches = Boolean(
    exactSource &&
    Number(exactSource.owner_matches) === 1 &&
    Number(exactSource.source_owner_telegram_id) === owner
  );
  if (
    sourceKnown !== exactSourceKnown ||
    authorityStatus !== exactAuthorityStatus ||
    ownerMatches !== exactOwnerMatches
  ) {
    throw new Error("commercial authority snapshot mismatch");
  }
  if (exactSource) {
    if (Number(exactSource.source_actor_telegram_id) !== subject) {
      throw new Error("commercial source actor mismatch");
    }
    if (Number(exactSource.source_occurred_at) !== occurred) {
      throw new Error("commercial source occurrence mismatch");
    }
  }
  let outcome = "attributed";
  let reasonCode = "attributed_exact";
  const authorityActive =
    String(profile.status) === "active" &&
    String(profileAuthority.partner_profile_status) === "active" &&
    String(profileAuthority.partner_role_status) === "active" &&
    String(campaign.status) === "active";
  if (!exactSourceKnown) {
    outcome = "unattributed";
    reasonCode = "source_unknown";
  } else if (subject === owner) {
    outcome = "rejected";
    reasonCode = "self_attribution";
  } else if (exactCycleDetected) {
    outcome = "rejected";
    reasonCode = "cycle_detected";
  } else if (!exactOwnerMatches) {
    outcome = "rejected";
    reasonCode = "owner_mismatch";
  } else if (!authorityActive) {
    outcome = "rejected";
    reasonCode = "campaign_inactive";
  } else if (
    occurred < Number(campaign.starts_at) ||
    occurred > Number(campaign.ends_at)
  ) {
    outcome = "rejected";
    reasonCode = "campaign_expired";
  } else if (exactAuthorityStatus !== COMMERCIAL_STATUS[authorityKind]) {
    outcome = "rejected";
    reasonCode = "authority_status_invalid";
  }
  return persistDecision({
    store,
    decisionId,
    attributionKind: "commercial",
    outcome,
    reasonCode,
    authorityKind,
    authorityEvidence: {
      authorityKind,
      authorityStatus,
      cycleDetected,
      ownerMatches,
      ownerTelegramId: owner,
      sourceRecordId,
      sourceIdentity,
      sourceKnown,
    },
    sourceIdentity,
    actorTelegramId: subject,
    ambassadorId: normalizedAmbassadorId,
    campaignId: normalizedCampaignId,
    touchpointId: null,
    occurredAt: occurred,
    decidedAt,
    retentionDays,
    pseudonymSecret: secret,
    pseudonymKeyVersion: keyVersion,
    cryptoImpl,
  });
}

export function validateAttributionSeparation(decisions) {
  if (!Array.isArray(decisions)) {
    throw new TypeError("attribution decisions must be an array");
  }
  const kinds = new Set();
  for (const decision of decisions) {
    const kind = requiredCode(decision?.attribution_kind, "attribution kind");
    if (!["relationship", "engagement", "commercial"].includes(kind)) {
      throw new TypeError("attribution kind is invalid");
    }
    if (kinds.has(kind)) throw new Error("attribution kind is duplicated");
    kinds.add(kind);
  }
  return Object.freeze({
    exact: kinds.size === 3,
    relationship: kinds.has("relationship"),
    engagement: kinds.has("engagement"),
    commercial: kinds.has("commercial"),
  });
}

export const AMBASSADOR_V2_COMMERCIAL_AUTHORITY_STATUS = COMMERCIAL_STATUS;
