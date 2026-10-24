export const PLAN_CODES = Object.freeze([
  "free",
  "professional",
  "dragon",
]);

export const ACCESS_STATES = Object.freeze([
  "none",
  "trial",
  "active",
  "cancel_at_period_end",
  "expired",
  "refunded",
  "suspended",
]);

export const PLAN_CATALOG = Object.freeze({
  free: Object.freeze({
    code: "free",
    publicName: "Free",
    marker: "⚪",
    publicLabel: "Free ⚪",
    colorToken: "neutral",
    rankOrder: 0,
  }),
  professional: Object.freeze({
    code: "professional",
    publicName: "Professional",
    marker: "🔵",
    publicLabel: "Professional 🔵",
    colorToken: "blue",
    rankOrder: 10,
  }),
  dragon: Object.freeze({
    code: "dragon",
    publicName: "Dragon",
    marker: "🔴",
    publicLabel: "Dragon 🔴",
    colorToken: "red",
    rankOrder: 20,
  }),
});

const LEGACY_IDENTIFIERS = Object.freeze({
  trial: Object.freeze({
    kind: "legacy_state",
    planCode: null,
    accessState: "trial",
    resolutionMode: "preserve_legacy",
    acceptsNewWrites: false,
    reviewRequired: true,
  }),
  team: Object.freeze({
    kind: "legacy_plan",
    planCode: null,
    accessState: null,
    resolutionMode: "manual_review",
    acceptsNewWrites: false,
    reviewRequired: true,
  }),
});

function normalizeIdentifier(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeCanonicalPlanCode(value) {
  const normalized = normalizeIdentifier(value);
  return Object.hasOwn(PLAN_CATALOG, normalized) ? normalized : null;
}

export function classifyStoredPlanIdentifier(value) {
  const identifier = normalizeIdentifier(value);
  const planCode = normalizeCanonicalPlanCode(identifier);
  if (planCode) {
    return {
      identifier,
      kind: "canonical",
      planCode,
      accessState: null,
      resolutionMode: "canonical",
      acceptsNewWrites: true,
      reviewRequired: false,
    };
  }
  if (Object.hasOwn(LEGACY_IDENTIFIERS, identifier)) {
    return { identifier, ...LEGACY_IDENTIFIERS[identifier] };
  }
  return {
    identifier,
    kind: "unknown",
    planCode: null,
    accessState: null,
    resolutionMode: "manual_review",
    acceptsNewWrites: false,
    reviewRequired: true,
  };
}

export function assertCanonicalPlanWrite(value) {
  const planCode = normalizeCanonicalPlanCode(value);
  if (!planCode) {
    throw new TypeError("Only canonical Free, Professional or Dragon plan codes may be written");
  }
  return planCode;
}

function parsePrereleasePart(part) {
  if (/^(0|[1-9]\d*)$/.test(part)) return Number(part);
  return part;
}

export function parseSemver(value) {
  const match = String(value || "").trim().match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
  if (!match) throw new TypeError(`Invalid semantic version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? match[4].split(".").map(parsePrereleasePart)
      : [],
  };
}

export function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart !== "number") return -1;
    if (typeof leftPart !== "number" && typeof rightPart === "number") return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}
