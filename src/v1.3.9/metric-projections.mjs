import {
  ANALYTICS_V2_DIMENSION_VALUES,
  readAnalyticsV2Config,
} from "./analytics-foundation.mjs";

const DAY = 86_400;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const EVENT_KEY_PATTERN = /^evt_[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CORE_DIMENSIONS = Object.freeze([
  "role",
  "plan",
  "access_state",
  "source_family",
]);
const ALL_DIMENSIONS = Object.freeze([
  "role",
  "legal_profile",
  "plan",
  "access_state",
  "source_family",
  "object_type",
]);

export const ANALYTICS_V2_PROJECTION_POLICY_VERSION =
  "2026-09-13.analytics-v2-part4";
export const ANALYTICS_V2_PROJECTION_MAX_EVENTS = 20_000;
export const ANALYTICS_V2_RETENTION_OFFSETS = Object.freeze([1, 7, 30]);

const ACTIVE_EVENTS = Object.freeze([
  "menu_opened",
  "offer_opened",
  "lead_submitted",
  "notification_opened",
  "partner_program_opened",
  "partner_link_submitted",
  "partner_link_opened",
  "campaign_touch_recorded",
  "lead_attributed",
  "payment_succeeded",
  "access_activated",
  "ai_opened",
  "ai_generation_succeeded",
  "ai_generation_failed",
  "ai_limit_hit",
]);
const RETENTION_EVENTS = new Set([
  "menu_opened",
  "offer_opened",
  "lead_submitted",
  "notification_opened",
  "partner_program_opened",
  "partner_link_opened",
  "campaign_touch_recorded",
  "payment_succeeded",
  "access_activated",
  "ai_opened",
  "ai_generation_succeeded",
]);

const DAILY_METRICS = Object.freeze([
  Object.freeze({ key: "events_total", aggregation: "event_count", numerator: null, denominator: [] }),
  Object.freeze({ key: "active_actors", aggregation: "unique_actor", numerator: ACTIVE_EVENTS, denominator: [] }),
  Object.freeze({ key: "registrations", aggregation: "event_count", numerator: ["account_created"], denominator: [] }),
  Object.freeze({ key: "offer_views", aggregation: "event_count", numerator: ["offer_opened"], denominator: [] }),
  Object.freeze({ key: "leads", aggregation: "event_count", numerator: ["lead_submitted"], denominator: [] }),
  Object.freeze({ key: "payments_succeeded", aggregation: "event_count", numerator: ["payment_succeeded"], denominator: [] }),
  Object.freeze({ key: "access_applied", aggregation: "event_count", numerator: ["access_activated"], denominator: [] }),
  Object.freeze({ key: "refunds", aggregation: "event_count", numerator: ["payment_refunded"], denominator: [] }),
  Object.freeze({ key: "ai_successes", aggregation: "event_count", numerator: ["ai_generation_succeeded"], denominator: [] }),
  Object.freeze({ key: "ai_failures", aggregation: "event_count", numerator: ["ai_generation_failed"], denominator: [] }),
  Object.freeze({ key: "ai_limits", aggregation: "event_count", numerator: ["ai_limit_hit"], denominator: [] }),
  Object.freeze({
    key: "ai_success_rate",
    aggregation: "ratio",
    numerator: ["ai_generation_succeeded"],
    denominator: ["ai_generation_succeeded", "ai_generation_failed"],
  }),
  Object.freeze({ key: "confirmed_rewards", aggregation: "event_count", numerator: ["referral_reward_confirmed"], denominator: [] }),
]);

export const ANALYTICS_V2_METRIC_DEFINITIONS = DAILY_METRICS;

export const ANALYTICS_V2_FUNNEL_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "product",
    exactAttributionRequired: false,
    steps: Object.freeze([
      Object.freeze({ key: "start", eventName: "start_received" }),
      Object.freeze({ key: "registration", eventName: "account_created" }),
      Object.freeze({ key: "menu", eventName: "menu_opened" }),
      Object.freeze({ key: "offer", eventName: "offer_opened" }),
      Object.freeze({ key: "lead", eventName: "lead_submitted" }),
      Object.freeze({ key: "applied_access", eventName: "access_activated" }),
    ]),
  }),
  Object.freeze({
    key: "ambassador",
    exactAttributionRequired: true,
    steps: Object.freeze([
      Object.freeze({ key: "tracking_open", eventName: "campaign_touch_recorded" }),
      Object.freeze({ key: "registration", eventName: "registration_attributed" }),
      Object.freeze({ key: "lead", eventName: "lead_attributed" }),
      Object.freeze({ key: "applied_access", eventName: "paid_access_attributed" }),
    ]),
  }),
]);

const AMBASSADOR_METRIC_BY_EVENT = Object.freeze({
  campaign_touch_recorded: "tracking_opens",
  registration_attributed: "attributed_registrations",
  lead_attributed: "attributed_leads",
  paid_access_attributed: "applied_paid_access",
  referral_reward_confirmed: "confirmed_referral_rewards",
});

const PROJECTION_FIELDS = Object.freeze({
  bindingRefs: [
    "snapshot_id", "binding_id", "created_at", "retention_until",
  ],
  actorFacts: [
    "snapshot_id", "metric_date", "actor_pseudonym",
    "pseudonym_key_version", "event_name", "event_version", "event_count",
    "first_occurred_at", "last_occurred_at", "fact_hash", "created_at",
    "retention_until",
  ],
  dailyMetrics: [
    "snapshot_id", "metric_date", "metric_key", "dimension_name",
    "dimension_value", "numerator_count", "denominator_count",
    "unique_actors", "metric_value", "small_cell_threshold", "suppressed",
    "row_hash", "created_at",
  ],
  funnelDaily: [
    "snapshot_id", "metric_date", "funnel_key", "step_key", "step_order",
    "qualified_actors", "previous_step_actors", "conversion_bps",
    "small_cell_threshold", "suppressed", "row_hash", "created_at",
  ],
  cohortDaily: [
    "snapshot_id", "cohort_date", "offset_days", "activity_date",
    "cohort_size", "retained_actors", "eligible", "retention_bps",
    "small_cell_threshold", "suppressed", "row_hash", "created_at",
  ],
  ambassadorMetrics: [
    "snapshot_id", "metric_date", "ambassador_id", "scope_kind",
    "scope_hash", "campaign_id", "program_code", "catalog_offer_id",
    "metric_key", "metric_count", "unique_actors", "small_cell_threshold",
    "suppressed", "row_hash", "created_at",
  ],
});

function assertExactKeys(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function text(value, name, minimum = 1, maximum = 160) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function nullableText(value, name, maximum = 160) {
  if (value === null) return null;
  return text(value, name, 1, maximum);
}

function assertHash(value, name) {
  if (!HASH_PATTERN.test(value || "")) throw new TypeError(`${name} must be a sha256 hex digest`);
  return value;
}

function assertUuid(value, name) {
  if (!UUID_V4_PATTERN.test(value || "")) throw new TypeError(`${name} must be a UUIDv4`);
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

async function sha256Hex(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto is required");
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value));
  const digest = await cryptoImpl.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function utcDay(timestamp) {
  return Math.floor(timestamp / DAY) * DAY;
}

function assertUtcDay(value, name) {
  integer(value, name, DAY);
  if (value % DAY !== 0) throw new TypeError(`${name} must be a UTC midnight`);
  return value;
}

function unique(values) {
  return [...new Set(values)];
}

function compareEvents(left, right) {
  return left.occurred_at - right.occurred_at ||
    left.recorded_at - right.recorded_at || left.event_id.localeCompare(right.event_id);
}

function changed(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

export function readAnalyticsProjectionConfig(env = {}) {
  const base = readAnalyticsV2Config(env);
  return Object.freeze({
    ...base,
    projectionPolicyVersion: ANALYTICS_V2_PROJECTION_POLICY_VERSION,
    projectionEnabled: base.configurationValid && base.projectionsEnabled &&
      base.rolloutMode === "admin_shadow",
  });
}

export function assertAnalyticsProjectionGate({
  config,
  databaseSettings,
  requestedScope,
} = {}) {
  assertExactKeys(databaseSettings, new Set([
    "ambassador_enabled", "event_registry_version", "id", "ingest_enabled",
    "master_enabled", "metric_dictionary_version", "projections_enabled",
    "pseudonym_key_version", "raw_retention_days", "revision", "rollout_mode",
    "small_segment_threshold",
  ]), "analytics projection database settings");
  if (
    !config?.configurationValid || !config.projectionEnabled ||
    config.rolloutMode !== "admin_shadow" || requestedScope !== "admin_shadow"
  ) throw new Error("analytics projections are closed");
  if (
    databaseSettings.id !== 1 || databaseSettings.rollout_mode !== "admin_shadow" ||
    databaseSettings.master_enabled !== 1 || databaseSettings.ingest_enabled !== 1 ||
    databaseSettings.projections_enabled !== 1 ||
    databaseSettings.event_registry_version !== 1 ||
    databaseSettings.metric_dictionary_version !== 1 ||
    databaseSettings.raw_retention_days < 1 || databaseSettings.raw_retention_days > 180 ||
    databaseSettings.small_segment_threshold < 5 ||
    databaseSettings.small_segment_threshold > 20
  ) throw new Error("analytics projection database gate is closed");
  return true;
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("canonical event is invalid");
  }
  assertUuid(event.event_id, "canonical event id");
  if (!EVENT_KEY_PATTERN.test(event.event_key || "")) {
    throw new TypeError("canonical event key is invalid");
  }
  text(event.event_name, "canonical event name", 3, 80);
  integer(event.event_version, "canonical event version", 1);
  integer(event.occurred_at, "canonical occurred at", 1);
  integer(event.recorded_at, "canonical recorded at", event.occurred_at);
  assertHash(event.actor_pseudonym, "canonical actor pseudonym");
  integer(event.pseudonym_key_version, "canonical pseudonym key version", 1);
  assertHash(event.source_key_hash, "canonical source hash");
  assertHash(event.payload_hash, "canonical payload hash");
  integer(event.retention_until, "canonical retention", event.recorded_at);
  if (!new Set(["none", "retract", "replace"]).has(event.correction_kind)) {
    throw new TypeError("canonical correction kind is invalid");
  }
  if (event.event_name === "analytics_event_corrected") {
    assertHash(event.correction_of_event_key_hash, "correction target hash");
    if (event.correction_kind === "replace") {
      assertHash(event.replacement_event_key_hash, "replacement event hash");
    } else if (event.replacement_event_key_hash !== null) {
      throw new TypeError("retract cannot identify a replacement");
    }
  } else if (
    event.correction_kind !== "none" ||
    event.correction_of_event_key_hash !== null ||
    event.replacement_event_key_hash !== null
  ) throw new TypeError("ordinary canonical event cannot be a correction");
  return event;
}

function normalizeDimensions(events, rows) {
  if (!Array.isArray(rows)) throw new TypeError("analytics dimensions must be an array");
  const eventIds = new Set(events.map((event) => event.event_id));
  const grouped = new Map();
  for (const row of rows) {
    if (!eventIds.has(row?.event_id)) throw new TypeError("dimension references an unknown event");
    if (!ALL_DIMENSIONS.includes(row.dimension_name)) throw new TypeError("dimension name is invalid");
    if (!ANALYTICS_V2_DIMENSION_VALUES[row.dimension_name]?.includes(row.dimension_value)) {
      throw new TypeError("dimension value is not registered");
    }
    const dimensions = grouped.get(row.event_id) || {};
    if (Object.hasOwn(dimensions, row.dimension_name)) throw new TypeError("dimension is duplicated");
    dimensions[row.dimension_name] = row.dimension_value;
    grouped.set(row.event_id, dimensions);
  }
  for (const event of events) {
    const dimensions = grouped.get(event.event_id);
    if (!dimensions || Object.keys(dimensions).length !== ALL_DIMENSIONS.length) {
      throw new TypeError("canonical event dimensions are incomplete");
    }
  }
  return grouped;
}

export async function resolveEffectiveAnalyticsEvents(events, {
  cryptoImpl = globalThis.crypto,
} = {}) {
  if (!Array.isArray(events) || events.length > ANALYTICS_V2_PROJECTION_MAX_EVENTS) {
    throw new TypeError("canonical projection input is not bounded");
  }
  const normalized = events.map(normalizeEvent);
  const ids = new Set();
  const keys = new Set();
  const byHash = new Map();
  for (const event of normalized) {
    if (ids.has(event.event_id) || keys.has(event.event_key)) {
      throw new TypeError("canonical projection input contains duplicate identity");
    }
    ids.add(event.event_id);
    keys.add(event.event_key);
    byHash.set(await sha256Hex(event.event_key, cryptoImpl), event);
  }

  const corrections = normalized.filter((event) => event.event_name === "analytics_event_corrected");
  const correctionByTarget = new Map();
  const correctionApplications = [];
  const inactive = new Set();
  for (const correction of corrections.sort(compareEvents)) {
    const target = byHash.get(correction.correction_of_event_key_hash);
    if (!target || target.event_name === "analytics_event_corrected") {
      throw new Error("correction target is absent or is another correction");
    }
    if (correctionByTarget.has(correction.correction_of_event_key_hash)) {
      throw new Error("multiple corrections for one event are ambiguous");
    }
    if (
      correction.actor_pseudonym !== target.actor_pseudonym ||
      correction.occurred_at < target.occurred_at
    ) throw new Error("correction authority does not match its target");
    let replacement = null;
    if (correction.correction_kind === "replace") {
      replacement = byHash.get(correction.replacement_event_key_hash);
      if (
        !replacement || replacement.event_name === "analytics_event_corrected" ||
        replacement.event_id === target.event_id ||
        replacement.actor_pseudonym !== target.actor_pseudonym
      ) throw new Error("replacement event is absent or mismatched");
    }
    correctionByTarget.set(correction.correction_of_event_key_hash, correction);
    correctionApplications.push(Object.freeze({ correction, target, replacement }));
    inactive.add(target.event_id);
  }
  const effectiveEvents = normalized
    .filter((event) => event.event_name !== "analytics_event_corrected" && !inactive.has(event.event_id))
    .sort(compareEvents);
  return Object.freeze({
    allEvents: Object.freeze(normalized.sort(compareEvents)),
    effectiveEvents: Object.freeze(effectiveEvents),
    corrections: Object.freeze(corrections),
    correctionApplications: Object.freeze(correctionApplications),
    retractedEventIds: Object.freeze([...inactive].sort()),
  });
}

function normalizeBinding(binding, eventById) {
  assertExactKeys(binding, new Set([
    "actor_pseudonym", "ambassador_id", "attribution_kind", "authority_kind",
    "binding_id", "binding_key", "campaign_id", "catalog_offer_id",
    "created_at", "decision_id", "evidence_hash", "evidence_kind",
    "event_id", "occurred_at", "outcome", "program_code", "retention_until",
    "touchpoint_id",
  ]), "projection attribution binding");
  const event = eventById.get(assertUuid(binding.event_id, "binding event id"));
  if (!event) throw new TypeError("projection binding references an unknown event");
  assertUuid(binding.binding_id, "projection binding id");
  assertHash(binding.binding_key, "projection binding key");
  assertHash(binding.actor_pseudonym, "binding actor pseudonym");
  assertUuid(binding.ambassador_id, "binding ambassador id");
  const campaignId = binding.campaign_id === null
    ? null : assertUuid(binding.campaign_id, "binding campaign id");
  const programCode = text(binding.program_code, "binding program code", 1, 80);
  const catalogOfferId = binding.catalog_offer_id === null
    ? null : integer(binding.catalog_offer_id, "binding offer id", 1);
  const touchpointId = binding.touchpoint_id === null
    ? null : assertUuid(binding.touchpoint_id, "binding touchpoint id");
  const decisionId = binding.decision_id === null
    ? null : assertUuid(binding.decision_id, "binding decision id");
  assertHash(binding.evidence_hash, "binding evidence hash");
  integer(binding.created_at, "binding created at", 1);
  integer(binding.retention_until, "binding retention", binding.created_at);
  if (binding.retention_until > binding.created_at + 180 * DAY) {
    throw new TypeError("binding retention exceeds 180 days");
  }
  if (binding.retention_until > event.retention_until) {
    throw new TypeError("binding retention exceeds its canonical event");
  }
  if (campaignId === null && catalogOfferId !== null) {
    throw new TypeError("program-level binding cannot claim an offer");
  }
  integer(binding.occurred_at, "binding occurred at", 1);
  if (
    binding.actor_pseudonym !== event.actor_pseudonym ||
    binding.occurred_at !== event.occurred_at
  ) throw new Error("projection binding does not match canonical actor and time");

  if (binding.evidence_kind === "touchpoint") {
    if (
      event.event_name !== "campaign_touch_recorded" || !campaignId ||
      !touchpointId || decisionId !== null ||
      binding.attribution_kind !== null || binding.authority_kind !== null ||
      binding.outcome !== null
    ) throw new Error("touchpoint binding is not exact");
  } else if (binding.evidence_kind === "decision") {
    if (!decisionId || touchpointId !== null) throw new Error("decision binding is incomplete");
    if (binding.outcome !== "attributed") throw new Error("non-attributed decision cannot bind a metric");
    const valid =
      (event.event_name === "registration_attributed" &&
        ["relationship", "engagement"].includes(binding.attribution_kind) &&
        ["first_inviter", "verified_touchpoint"].includes(binding.authority_kind)) ||
      (event.event_name === "lead_attributed" &&
        binding.attribution_kind === "commercial" &&
        binding.authority_kind === "lead_partner_attribution") ||
      (event.event_name === "paid_access_attributed" &&
        binding.attribution_kind === "commercial" &&
        binding.authority_kind === "stars_access") ||
      (event.event_name === "referral_reward_confirmed" &&
        binding.attribution_kind === "commercial" &&
        binding.authority_kind === "referral_reward");
    if (!valid) throw new Error("decision binding authority is not exact");
    if (binding.attribution_kind === "engagement" && !campaignId) {
      throw new Error("engagement binding requires its exact campaign");
    }
  } else throw new TypeError("binding evidence kind is invalid");
  return Object.freeze({
    ...binding,
    campaign_id: campaignId,
    program_code: programCode,
    catalog_offer_id: catalogOfferId,
    touchpoint_id: touchpointId,
    decision_id: decisionId,
  });
}

function dimensionGroups() {
  return [
    Object.freeze({ name: "global", value: "all" }),
    ...CORE_DIMENSIONS.flatMap((name) =>
      ANALYTICS_V2_DIMENSION_VALUES[name].map((value) => Object.freeze({ name, value }))),
  ];
}

function eventMatchesDimension(event, dimensionsByEvent, dimension) {
  return dimension.name === "global" ||
    dimensionsByEvent.get(event.event_id)?.[dimension.name] === dimension.value;
}

function metricEventSet(metric, kind) {
  if (metric.key === "events_total" && kind === "numerator") return null;
  return new Set(kind === "numerator" ? metric.numerator : metric.denominator);
}

async function addRowHash(row, cryptoImpl) {
  return Object.freeze({ ...row, row_hash: await sha256Hex(row, cryptoImpl) });
}

async function buildActorFacts(events, snapshotId, metricDate, createdAt, cryptoImpl) {
  const grouped = new Map();
  for (const event of events) {
    const key = `${event.actor_pseudonym}\u0000${event.event_name}`;
    const row = grouped.get(key) || {
      snapshot_id: snapshotId,
      metric_date: metricDate,
      actor_pseudonym: event.actor_pseudonym,
      pseudonym_key_version: event.pseudonym_key_version,
      event_name: event.event_name,
      event_version: event.event_version,
      event_count: 0,
      first_occurred_at: event.occurred_at,
      last_occurred_at: event.occurred_at,
      created_at: createdAt,
      retention_until: event.retention_until,
    };
    if (row.pseudonym_key_version !== event.pseudonym_key_version) {
      throw new Error("one actor day cannot mix pseudonym key versions");
    }
    row.event_count += 1;
    row.first_occurred_at = Math.min(row.first_occurred_at, event.occurred_at);
    row.last_occurred_at = Math.max(row.last_occurred_at, event.occurred_at);
    row.retention_until = Math.min(row.retention_until, event.retention_until);
    grouped.set(key, row);
  }
  const rows = [];
  for (const row of [...grouped.values()].sort((a, b) =>
    a.actor_pseudonym.localeCompare(b.actor_pseudonym) || a.event_name.localeCompare(b.event_name))) {
    if (row.retention_until < createdAt) throw new Error("expired raw event cannot create an actor fact");
    rows.push(Object.freeze({ ...row, fact_hash: await sha256Hex(row, cryptoImpl) }));
  }
  return Object.freeze(rows);
}

async function buildDailyMetrics(events, dimensionsByEvent, snapshotId, metricDate,
  threshold, createdAt, cryptoImpl) {
  const rows = [];
  for (const metric of DAILY_METRICS) {
    const numeratorNames = metricEventSet(metric, "numerator");
    const denominatorNames = metricEventSet(metric, "denominator");
    for (const dimension of dimensionGroups()) {
      const scoped = events.filter((event) => eventMatchesDimension(event, dimensionsByEvent, dimension));
      const numeratorEvents = numeratorNames === null
        ? scoped : scoped.filter((event) => numeratorNames.has(event.event_name));
      const denominatorEvents = denominatorNames.size === 0
        ? [] : scoped.filter((event) => denominatorNames.has(event.event_name));
      const actors = new Set((metric.aggregation === "ratio" ? denominatorEvents : numeratorEvents)
        .map((event) => event.actor_pseudonym));
      const numeratorCount = metric.aggregation === "unique_actor"
        ? actors.size : numeratorEvents.length;
      const denominatorCount = denominatorEvents.length;
      const suppressed = actors.size < threshold ? 1 : 0;
      let metricValue = numeratorCount;
      if (metric.aggregation === "ratio") {
        metricValue = denominatorCount === 0 || suppressed
          ? null : Math.floor(numeratorCount * 10_000 / denominatorCount);
      }
      rows.push(await addRowHash({
        snapshot_id: snapshotId,
        metric_date: metricDate,
        metric_key: metric.key,
        dimension_name: dimension.name,
        dimension_value: dimension.value,
        numerator_count: numeratorCount,
        denominator_count: denominatorCount,
        unique_actors: actors.size,
        metric_value: metricValue,
        small_cell_threshold: threshold,
        suppressed,
        created_at: createdAt,
      }, cryptoImpl));
    }
  }
  return Object.freeze(rows);
}

function completedFunnelDepth(events, steps) {
  let depth = 0;
  for (const event of [...events].sort(compareEvents)) {
    if (event.event_name === steps[depth]?.eventName) depth += 1;
    if (depth === steps.length) break;
  }
  return depth;
}

async function buildFunnels(events, bindingByEvent, snapshotId, metricDate,
  threshold, createdAt, cryptoImpl) {
  const rows = [];
  for (const funnel of ANALYTICS_V2_FUNNEL_DEFINITIONS) {
    const grouped = new Map();
    for (const event of events) {
      const binding = bindingByEvent.get(event.event_id);
      if (funnel.exactAttributionRequired && !binding) continue;
      const groupKey = funnel.exactAttributionRequired
        ? `${event.actor_pseudonym}\u0000${binding.ambassador_id}`
        : event.actor_pseudonym;
      const group = grouped.get(groupKey) || { actor: event.actor_pseudonym, events: [] };
      group.events.push(event);
      grouped.set(groupKey, group);
    }
    const actorsByStep = funnel.steps.map(() => new Set());
    for (const group of grouped.values()) {
      const depth = completedFunnelDepth(group.events, funnel.steps);
      for (let index = 0; index < depth; index += 1) actorsByStep[index].add(group.actor);
    }
    for (let index = 0; index < funnel.steps.length; index += 1) {
      const qualified = actorsByStep[index].size;
      const previous = index === 0 ? qualified : actorsByStep[index - 1].size;
      const suppressed = qualified < threshold ? 1 : 0;
      const conversion = index === 0 || previous === 0 || suppressed
        ? null : Math.floor(qualified * 10_000 / previous);
      rows.push(await addRowHash({
        snapshot_id: snapshotId,
        metric_date: metricDate,
        funnel_key: funnel.key,
        step_key: funnel.steps[index].key,
        step_order: index + 1,
        qualified_actors: qualified,
        previous_step_actors: previous,
        conversion_bps: conversion,
        small_cell_threshold: threshold,
        suppressed,
        created_at: createdAt,
      }, cryptoImpl));
    }
  }
  return Object.freeze(rows);
}

export function affectedCohortDatesForActivityDate(metricDate) {
  assertUtcDay(metricDate, "activity metric date");
  return Object.freeze(unique([
    metricDate,
    ...ANALYTICS_V2_RETENTION_OFFSETS.map((offset) => metricDate - offset * DAY),
  ]).filter((value) => value > 0).sort((a, b) => a - b));
}

async function buildCohorts(allEffectiveEvents, snapshotId, cohortDates, asOfAt,
  threshold, createdAt, cryptoImpl) {
  const firstRegistration = new Map();
  for (const event of allEffectiveEvents) {
    if (event.event_name !== "account_created") continue;
    const previous = firstRegistration.get(event.actor_pseudonym);
    if (!previous || compareEvents(event, previous) < 0) {
      firstRegistration.set(event.actor_pseudonym, event);
    }
  }
  const activeByDay = new Map();
  for (const event of allEffectiveEvents) {
    if (!RETENTION_EVENTS.has(event.event_name)) continue;
    const day = utcDay(event.occurred_at);
    const actors = activeByDay.get(day) || new Set();
    actors.add(event.actor_pseudonym);
    activeByDay.set(day, actors);
  }
  const rows = [];
  for (const cohortDate of cohortDates) {
    const cohort = new Set([...firstRegistration.entries()]
      .filter(([, event]) => utcDay(event.occurred_at) === cohortDate)
      .map(([actor]) => actor));
    for (const offset of ANALYTICS_V2_RETENTION_OFFSETS) {
      const activityDate = cohortDate + offset * DAY;
      const eligible = asOfAt >= activityDate + DAY ? 1 : 0;
      const active = activeByDay.get(activityDate) || new Set();
      const retained = eligible
        ? [...cohort].filter((actor) => active.has(actor)).length : 0;
      const suppressed = cohort.size < threshold ? 1 : 0;
      const retentionBps = !eligible || cohort.size === 0 || suppressed
        ? null : Math.floor(retained * 10_000 / cohort.size);
      rows.push(await addRowHash({
        snapshot_id: snapshotId,
        cohort_date: cohortDate,
        offset_days: offset,
        activity_date: activityDate,
        cohort_size: cohort.size,
        retained_actors: retained,
        eligible,
        retention_bps: retentionBps,
        small_cell_threshold: threshold,
        suppressed,
        created_at: createdAt,
      }, cryptoImpl));
    }
  }
  return Object.freeze(rows);
}

async function scopeRows(binding, cryptoImpl) {
  const scopes = [
    { kind: "ambassador", value: binding.ambassador_id, campaign_id: null, program_code: null, catalog_offer_id: null },
    { kind: "program", value: `${binding.ambassador_id}:${binding.program_code}`, campaign_id: null, program_code: binding.program_code, catalog_offer_id: null },
  ];
  if (binding.campaign_id) scopes.push({
    kind: "campaign", value: binding.campaign_id, campaign_id: binding.campaign_id,
    program_code: null, catalog_offer_id: null,
  });
  if (binding.catalog_offer_id !== null) scopes.push({
    kind: "offer", value: `${binding.ambassador_id}:${binding.program_code}:${binding.catalog_offer_id}`,
    campaign_id: null, program_code: binding.program_code,
    catalog_offer_id: binding.catalog_offer_id,
  });
  return Promise.all(scopes.map(async (scope) => ({
    ...scope,
    hash: await sha256Hex(`re-analytics:ambassador-scope:v1:${scope.kind}:${scope.value}`, cryptoImpl),
  })));
}

async function buildAmbassadorMetrics(events, bindingByEvent, snapshotId, metricDate,
  threshold, createdAt, cryptoImpl) {
  const groups = new Map();
  for (const event of events) {
    const metricKey = AMBASSADOR_METRIC_BY_EVENT[event.event_name];
    const binding = bindingByEvent.get(event.event_id);
    if (!metricKey || !binding) continue;
    for (const scope of await scopeRows(binding, cryptoImpl)) {
      const key = [binding.ambassador_id, scope.kind, scope.hash, metricKey].join("\u0000");
      const group = groups.get(key) || {
        ambassador_id: binding.ambassador_id,
        scope,
        metric_key: metricKey,
        events: [],
      };
      group.events.push(event);
      groups.set(key, group);
    }
  }
  const rows = [];
  for (const group of [...groups.values()].sort((a, b) =>
    a.ambassador_id.localeCompare(b.ambassador_id) ||
    a.scope.kind.localeCompare(b.scope.kind) ||
    a.scope.hash.localeCompare(b.scope.hash) || a.metric_key.localeCompare(b.metric_key))) {
    const actors = new Set(group.events.map((event) => event.actor_pseudonym));
    rows.push(await addRowHash({
      snapshot_id: snapshotId,
      metric_date: metricDate,
      ambassador_id: group.ambassador_id,
      scope_kind: group.scope.kind,
      scope_hash: group.scope.hash,
      campaign_id: group.scope.campaign_id,
      program_code: group.scope.program_code,
      catalog_offer_id: group.scope.catalog_offer_id,
      metric_key: group.metric_key,
      metric_count: group.events.length,
      unique_actors: actors.size,
      small_cell_threshold: threshold,
      suppressed: actors.size < threshold ? 1 : 0,
      created_at: createdAt,
    }, cryptoImpl));
  }
  return Object.freeze(rows);
}

export function safeProjectionDisplay(row) {
  if (!row || typeof row !== "object") throw new TypeError("projection row is required");
  const threshold = integer(row.small_cell_threshold, "small-cell threshold", 5);
  if (row.suppressed === 1) {
    return Object.freeze({ visible: false, value: null, label: `<${threshold}` });
  }
  const value = Object.hasOwn(row, "metric_value") ? row.metric_value
    : Object.hasOwn(row, "conversion_bps") ? row.conversion_bps
    : Object.hasOwn(row, "retention_bps") ? row.retention_bps
    : Object.hasOwn(row, "metric_count") ? row.metric_count : null;
  return Object.freeze({
    visible: true,
    value,
    label: value === null ? "—" : String(value),
  });
}

export function reconcileProjectionStages({
  sourceRowsSeen,
  sourceRowsAccounted,
  canonicalRowsObserved,
  canonicalRowsExpected,
  correctionRows,
  effectiveRows,
  projectedEffectiveRows,
}) {
  const values = {
    source_rows_seen: integer(sourceRowsSeen, "source rows seen"),
    source_rows_accounted: integer(sourceRowsAccounted, "source rows accounted"),
    canonical_rows_observed: integer(canonicalRowsObserved, "canonical rows observed"),
    canonical_rows_expected: integer(canonicalRowsExpected, "canonical rows expected"),
    correction_rows: integer(correctionRows, "correction rows"),
    effective_rows: integer(effectiveRows, "effective rows"),
    projected_effective_rows: integer(projectedEffectiveRows, "projected effective rows"),
  };
  return Object.freeze({
    ...values,
    source_delta: values.source_rows_seen - values.source_rows_accounted,
    canonical_delta: values.canonical_rows_observed - values.canonical_rows_expected,
    projection_delta: values.effective_rows - values.projected_effective_rows,
  });
}

export async function buildAnalyticsProjectionSnapshot(input = {}, {
  cryptoImpl = globalThis.crypto,
} = {}) {
  assertExactKeys(input, new Set([
    "asOfAt", "attributionBindings", "cohortDates", "config",
    "databaseSettings", "dimensions", "events", "metricDate",
    "requestedScope", "sourceEvidence",
  ]), "analytics projection input");
  assertAnalyticsProjectionGate(input);
  const metricDate = assertUtcDay(input.metricDate, "projection metric date");
  const asOfAt = assertUtcDay(input.asOfAt, "projection as-of time");
  if (asOfAt < metricDate + DAY) {
    throw new TypeError("projection as-of time must close the metric UTC day");
  }
  if (!Array.isArray(input.cohortDates) || input.cohortDates.length < 1 || input.cohortDates.length > 4) {
    throw new TypeError("projection cohort dates must contain one to four dates");
  }
  const cohortDates = unique(input.cohortDates.map((value) => assertUtcDay(value, "cohort date")))
    .sort((a, b) => a - b);
  if (cohortDates.length !== input.cohortDates.length) throw new TypeError("cohort dates must be unique");
  const threshold = input.databaseSettings.small_segment_threshold;
  const resolution = await resolveEffectiveAnalyticsEvents(input.events, { cryptoImpl });
  const dimensionsByEvent = normalizeDimensions(resolution.allEvents, input.dimensions);
  const eventById = new Map(resolution.allEvents.map((event) => [event.event_id, event]));
  if (!Array.isArray(input.attributionBindings)) throw new TypeError("attribution bindings must be an array");
  const bindingByEvent = new Map();
  for (const rawBinding of input.attributionBindings) {
    const binding = normalizeBinding(rawBinding, eventById);
    if (bindingByEvent.has(binding.event_id)) throw new TypeError("event has more than one attribution binding");
    bindingByEvent.set(binding.event_id, binding);
  }

  const dailyEvents = resolution.effectiveEvents.filter((event) => utcDay(event.occurred_at) === metricDate);
  const cohortDateSet = new Set(cohortDates);
  const cohortActors = new Set(resolution.effectiveEvents
    .filter((event) => event.event_name === "account_created" && cohortDateSet.has(utcDay(event.occurred_at)))
    .map((event) => event.actor_pseudonym));
  const cohortActivityDates = new Set(cohortDates.flatMap((date) =>
    ANALYTICS_V2_RETENTION_OFFSETS.map((offset) => date + offset * DAY)));
  const relevantBaseEvent = (event) =>
    utcDay(event.occurred_at) === metricDate ||
    (event.event_name === "account_created" && cohortDateSet.has(utcDay(event.occurred_at))) ||
    (cohortActors.has(event.actor_pseudonym) && cohortActivityDates.has(utcDay(event.occurred_at)));
  const relevantEffective = resolution.effectiveEvents.filter((event) =>
    relevantBaseEvent(event) ||
    (event.event_name === "account_created" && cohortActors.has(event.actor_pseudonym)));
  const relevantIds = new Set(relevantEffective.map((event) => event.event_id));
  const relevantBindings = [...bindingByEvent.values()]
    .filter((binding) => relevantIds.has(binding.event_id))
    .sort((left, right) => left.binding_id.localeCompare(right.binding_id));
  const relevantCorrections = resolution.correctionApplications.filter(({ target, replacement }) =>
    relevantBaseEvent(target) || (replacement && relevantBaseEvent(replacement)));
  const dailyBaseEvents = resolution.allEvents.filter((event) =>
    event.event_name !== "analytics_event_corrected" && utcDay(event.occurred_at) === metricDate);
  const dailyCorrections = resolution.correctionApplications.filter(({ target, replacement }) =>
    utcDay(target.occurred_at) === metricDate ||
    (replacement && utcDay(replacement.occurred_at) === metricDate));
  const sourceEvidence = input.sourceEvidence;
  assertExactKeys(sourceEvidence, new Set([
    "canonicalExpected", "evidenceDigest", "rowsAccounted", "rowsSeen",
  ]), "projection source evidence");
  assertHash(sourceEvidence.evidenceDigest, "projection source evidence digest");

  const inputDigest = await sha256Hex({
    policy: ANALYTICS_V2_PROJECTION_POLICY_VERSION,
    metricDate,
    cohortDates,
    asOfAt,
    events: relevantEffective.map((event) => ({
      event_id: event.event_id,
      event_key: event.event_key,
      event_name: event.event_name,
      event_version: event.event_version,
      occurred_at: event.occurred_at,
      recorded_at: event.recorded_at,
      actor_pseudonym: event.actor_pseudonym,
      pseudonym_key_version: event.pseudonym_key_version,
      payload_hash: event.payload_hash,
      retention_until: event.retention_until,
      dimensions: dimensionsByEvent.get(event.event_id),
    })),
    bindings: relevantBindings,
    corrections: relevantCorrections.map(({ correction, target, replacement }) => ({
      correction_event_id: correction.event_id,
      correction_payload_hash: correction.payload_hash,
      correction_kind: correction.correction_kind,
      target_event_id: target.event_id,
      replacement_event_id: replacement?.event_id ?? null,
    })),
    sourceEvidence,
  }, cryptoImpl);
  const snapshotId = await sha256Hex(
    `re-analytics:projection-snapshot:v1:${metricDate}:${inputDigest}`,
    cryptoImpl,
  );
  const bindingRefs = Object.freeze(relevantBindings.map((binding) => {
      if (binding.retention_until < asOfAt) {
        throw new Error("expired attribution binding cannot enter a snapshot");
      }
      return Object.freeze({
        snapshot_id: snapshotId,
        binding_id: binding.binding_id,
        created_at: asOfAt,
        retention_until: binding.retention_until,
      });
    }));
  const actorFacts = await buildActorFacts(dailyEvents, snapshotId, metricDate, asOfAt, cryptoImpl);
  const dailyMetrics = await buildDailyMetrics(
    dailyEvents, dimensionsByEvent, snapshotId, metricDate, threshold, asOfAt, cryptoImpl,
  );
  const funnelDaily = await buildFunnels(
    dailyEvents, bindingByEvent, snapshotId, metricDate, threshold, asOfAt, cryptoImpl,
  );
  const cohortDaily = await buildCohorts(
    resolution.effectiveEvents, snapshotId, cohortDates, asOfAt, threshold, asOfAt, cryptoImpl,
  );
  const ambassadorMetrics = await buildAmbassadorMetrics(
    dailyEvents, bindingByEvent, snapshotId, metricDate, threshold, asOfAt, cryptoImpl,
  );
  const eventsTotal = dailyMetrics.find((row) =>
    row.metric_key === "events_total" && row.dimension_name === "global");
  const reconciliationValues = reconcileProjectionStages({
    sourceRowsSeen: sourceEvidence.rowsSeen,
    sourceRowsAccounted: sourceEvidence.rowsAccounted,
    canonicalRowsObserved: dailyBaseEvents.length + dailyCorrections.length,
    canonicalRowsExpected: sourceEvidence.canonicalExpected,
    correctionRows: dailyCorrections.length,
    effectiveRows: dailyEvents.length,
    projectedEffectiveRows: eventsTotal?.numerator_count ?? 0,
  });
  const evidenceDigest = await sha256Hex({
    source: sourceEvidence.evidenceDigest,
    inputDigest,
    reconciliation: reconciliationValues,
  }, cryptoImpl);
  const projectionRows = actorFacts.length + dailyMetrics.length + funnelDaily.length +
    cohortDaily.length + ambassadorMetrics.length;
  const outputDigest = await sha256Hex({
    actorFacts,
    dailyMetrics,
    funnelDaily,
    cohortDaily,
    ambassadorMetrics,
    reconciliation: reconciliationValues,
  }, cryptoImpl);
  const snapshot = Object.freeze({
    snapshot_id: snapshotId,
    metric_date: metricDate,
    input_digest: inputDigest,
    output_digest: outputDigest,
    policy_version: ANALYTICS_V2_PROJECTION_POLICY_VERSION,
    event_rows: dailyBaseEvents.length + dailyCorrections.length,
    correction_rows: dailyCorrections.length,
    effective_rows: dailyEvents.length,
    projection_rows: projectionRows,
    cohort_dates: cohortDates.length,
    created_at: asOfAt,
  });
  const reconciliation = Object.freeze({
    snapshot_id: snapshotId,
    ...reconciliationValues,
    evidence_digest: evidenceDigest,
    created_at: asOfAt,
  });
  const checkpointTargets = Object.freeze([
    Object.freeze({ projection_kind: "daily", metric_date: metricDate }),
    Object.freeze({ projection_kind: "funnel", metric_date: metricDate }),
    Object.freeze({ projection_kind: "ambassador", metric_date: metricDate }),
    ...cohortDates.map((date) => Object.freeze({ projection_kind: "cohort", metric_date: date })),
  ]);
  return Object.freeze({
    snapshot,
    bindingRefs,
    actorFacts,
    dailyMetrics,
    funnelDaily,
    cohortDaily,
    ambassadorMetrics,
    reconciliation,
    checkpointTargets,
  });
}

function insertStatement(db, table, fields, row) {
  const placeholders = fields.map(() => "?").join(", ");
  return db.prepare(
    `INSERT INTO ${table} (${fields.join(", ")}) VALUES (${placeholders})`,
  ).bind(...fields.map((field) => row[field]));
}

function exactFields(actual, expected, fields) {
  return fields.every((field) => actual?.[field] === expected?.[field]);
}

export function createD1MetricProjectionStore(db) {
  if (!db?.prepare || !db?.batch) throw new TypeError("D1 projection store requires prepare and batch");
  return Object.freeze({
    async getDatabaseSettings() {
      return db.prepare(
        `SELECT id, rollout_mode, master_enabled, ingest_enabled,
                projections_enabled, ambassador_enabled, event_registry_version,
                metric_dictionary_version, pseudonym_key_version,
                raw_retention_days, small_segment_threshold, revision
         FROM analytics_v2_settings WHERE id = 1 LIMIT 1`,
      ).first();
    },

    async getSnapshot(snapshotId) {
      return db.prepare(
        "SELECT * FROM analytics_projection_snapshots WHERE snapshot_id = ? LIMIT 1",
      ).bind(snapshotId).first();
    },

    async getCheckpoint(projectionKind, metricDate) {
      return db.prepare(
        `SELECT * FROM analytics_projection_checkpoints
         WHERE projection_kind = ? AND metric_date = ? LIMIT 1`,
      ).bind(projectionKind, metricDate).first();
    },

    async validateAttributionBindings(bindings) {
      const fields = [
        "binding_id", "binding_key", "event_id", "evidence_kind",
        "touchpoint_id", "decision_id", "ambassador_id", "campaign_id",
        "program_code", "catalog_offer_id", "evidence_hash", "created_at",
        "retention_until", "actor_pseudonym", "occurred_at",
        "attribution_kind", "authority_kind", "outcome",
      ];
      for (const binding of bindings) {
        const stored = await db.prepare(
          `SELECT binding.binding_id, binding.binding_key, binding.event_id,
                  binding.evidence_kind, binding.touchpoint_id,
                  binding.decision_id, binding.ambassador_id,
                  binding.campaign_id, binding.program_code,
                  binding.catalog_offer_id, binding.evidence_hash,
                  binding.created_at, binding.retention_until,
                  event.actor_pseudonym, event.occurred_at,
                  decision.attribution_kind, decision.authority_kind,
                  decision.outcome
           FROM analytics_projection_attribution_bindings binding
           JOIN canonical_analytics_events event
             ON event.event_id = binding.event_id
           LEFT JOIN analytics_attribution_decisions decision
             ON decision.decision_id = binding.decision_id
           WHERE binding.binding_id = ? LIMIT 1`,
        ).bind(binding.binding_id).first();
        if (!stored || !exactFields(stored, binding, fields)) {
          throw new Error("projection attribution binding is not database-authoritative");
        }
      }
      return true;
    },

    async commitSnapshot(bundle) {
      const existing = await this.getSnapshot(bundle.snapshot.snapshot_id);
      if (existing) {
        if (!exactFields(existing, bundle.snapshot, Object.keys(bundle.snapshot))) {
          return Object.freeze({ outcome: "conflict" });
        }
        const checkpoints = await Promise.all(bundle.checkpointTargets.map((target) =>
          this.getCheckpoint(target.projection_kind, target.metric_date)));
        if (checkpoints.every((row) => row?.current_snapshot_id === bundle.snapshot.snapshot_id)) {
          return Object.freeze({ outcome: "duplicate", snapshot: existing });
        }
        throw new Error("projection snapshot recovery requires a reviewed repair");
      }

      const current = await Promise.all(bundle.checkpointTargets.map((target) =>
        this.getCheckpoint(target.projection_kind, target.metric_date)));
      const snapshotFields = Object.keys(bundle.snapshot);
      const reconciliationFields = Object.keys(bundle.reconciliation);
      const statements = [
        insertStatement(db, "analytics_projection_snapshots", snapshotFields, bundle.snapshot),
        ...bundle.bindingRefs.map((row) => insertStatement(
          db, "analytics_projection_snapshot_bindings", PROJECTION_FIELDS.bindingRefs, row)),
        ...bundle.actorFacts.map((row) => insertStatement(
          db, "analytics_daily_actor_facts", PROJECTION_FIELDS.actorFacts, row)),
        ...bundle.dailyMetrics.map((row) => insertStatement(
          db, "analytics_daily_metrics", PROJECTION_FIELDS.dailyMetrics, row)),
        ...bundle.funnelDaily.map((row) => insertStatement(
          db, "analytics_funnel_daily", PROJECTION_FIELDS.funnelDaily, row)),
        ...bundle.cohortDaily.map((row) => insertStatement(
          db, "analytics_cohort_daily", PROJECTION_FIELDS.cohortDaily, row)),
        ...bundle.ambassadorMetrics.map((row) => insertStatement(
          db, "ambassador_metrics_daily", PROJECTION_FIELDS.ambassadorMetrics, row)),
        insertStatement(db, "analytics_projection_reconciliation",
          reconciliationFields, bundle.reconciliation),
      ];
      const checkpointResultIndexes = [];
      bundle.checkpointTargets.forEach((target, index) => {
        const previous = current[index];
        checkpointResultIndexes.push(statements.length);
        if (!previous) {
          statements.push(db.prepare(
            `INSERT INTO analytics_projection_checkpoints (
               projection_kind, metric_date, current_snapshot_id,
               input_digest, output_digest, revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          ).bind(
            target.projection_kind,
            target.metric_date,
            bundle.snapshot.snapshot_id,
            bundle.snapshot.input_digest,
            bundle.snapshot.output_digest,
            bundle.snapshot.created_at,
            bundle.snapshot.created_at,
          ));
        } else {
          statements.push(db.prepare(
            `UPDATE analytics_projection_checkpoints
             SET current_snapshot_id = ?, input_digest = ?, output_digest = ?,
                 revision = revision + 1, updated_at = ?
             WHERE projection_kind = ? AND metric_date = ? AND revision = ?`,
          ).bind(
            bundle.snapshot.snapshot_id,
            bundle.snapshot.input_digest,
            bundle.snapshot.output_digest,
            bundle.snapshot.created_at,
            target.projection_kind,
            target.metric_date,
            previous.revision,
          ));
          // A D1 batch is atomic only when a statement fails. A zero-row CAS
          // update would otherwise commit an orphan snapshot during a race.
          // If another writer won, this conditional duplicate insert aborts
          // the whole batch and rolls every snapshot row back.
          statements.push(db.prepare(
            `INSERT INTO analytics_projection_checkpoints (
               projection_kind, metric_date, current_snapshot_id,
               input_digest, output_digest, revision, created_at, updated_at
             )
             SELECT projection_kind, metric_date, current_snapshot_id,
                    input_digest, output_digest, revision, created_at, updated_at
             FROM analytics_projection_checkpoints
             WHERE projection_kind = ? AND metric_date = ?
               AND current_snapshot_id != ?`,
          ).bind(
            target.projection_kind,
            target.metric_date,
            bundle.snapshot.snapshot_id,
          ));
        }
      });
      const results = await db.batch(statements);
      if (checkpointResultIndexes.some((index) => changed(results[index]) !== 1)) {
        throw new Error("projection checkpoint compare-and-swap failed");
      }
      const stored = await this.getSnapshot(bundle.snapshot.snapshot_id);
      if (!stored || !exactFields(stored, bundle.snapshot, Object.keys(bundle.snapshot))) {
        throw new Error("projection snapshot was not stored exactly");
      }
      return Object.freeze({ outcome: "inserted", snapshot: stored });
    },
  });
}

export async function rebuildAnalyticsProjections({
  store,
  config,
  requestedScope = "admin_shadow",
  metricDate,
  cohortDates = affectedCohortDatesForActivityDate(metricDate),
  asOfAt,
  events,
  dimensions,
  attributionBindings = [],
  sourceEvidence,
} = {}, options = {}) {
  if (!store?.getDatabaseSettings || !store?.commitSnapshot) {
    throw new TypeError("analytics projection store is invalid");
  }
  if (attributionBindings.length > 0) {
    if (!store.validateAttributionBindings) {
      throw new TypeError("analytics projection store cannot verify attribution bindings");
    }
    await store.validateAttributionBindings(attributionBindings);
  }
  const databaseSettings = await store.getDatabaseSettings();
  const bundle = await buildAnalyticsProjectionSnapshot({
    config,
    databaseSettings,
    requestedScope,
    metricDate,
    cohortDates,
    asOfAt,
    events,
    dimensions,
    attributionBindings,
    sourceEvidence,
  }, options);
  const deltas = bundle.reconciliation;
  if (deltas.source_delta !== 0 || deltas.canonical_delta !== 0 || deltas.projection_delta !== 0) {
    throw new Error("analytics projection reconciliation is not exact");
  }
  return store.commitSnapshot(bundle);
}
