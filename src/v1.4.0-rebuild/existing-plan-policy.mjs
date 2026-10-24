// Generated unchanged pure fallback from accepted v1.3.9. No reconciliation or writes.
export function buildLegacyPlanAuthorityDecision(legacyAccess) {
  const legacyTier = String(legacyAccess?.access_tier || "")
    .trim()
    .toLowerCase();
  if (legacyTier === "free") {
    return {
      planCode: "free",
      accessState: "none",
      comparisonStatus: "legacy_free",
      reviewRequired: false,
      resolved: true,
    };
  }
  if (legacyTier === "trial") {
    return {
      planCode: null,
      accessState: "trial",
      comparisonStatus: "preserved_legacy",
      reviewRequired: true,
      resolved: false,
    };
  }
  if (legacyTier === "team") {
    return {
      planCode: null,
      accessState: null,
      comparisonStatus: "manual_review",
      reviewRequired: true,
      resolved: false,
    };
  }
  return {
    planCode: null,
    accessState: null,
    comparisonStatus: "unknown_legacy",
    reviewRequired: true,
    resolved: false,
  };
}
