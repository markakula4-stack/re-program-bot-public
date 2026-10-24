import { createD1OwnerAnalyticsReader } from "../v1.3.9/owner-analytics.mjs";
import { isPreviewGrantActive } from "../v1.3.5/dragon-preview-core.mjs";
import { buildLegacyPlanAuthorityDecision } from "./existing-plan-policy.mjs";
import { CabinetStorageError } from "./command-sql.mjs";
import { hasRole } from "./cabinet-authority.mjs";
import { databaseSeconds } from "./d1-cabinet-repository.mjs";

// Read-only bridge for the accepted v1.3.9 legacy-read configuration. Reusing
// getServerPlanAuthority directly would reconcile/provision grants during GET.
// Its unchanged pure fallback is generated from the accepted source and
// compared byte-for-byte by the build check. A canonical-read switch requires
// an explicitly supplied, separately verified read-only existing resolver.
export async function readExistingAccessAuthority({ repo, actor, env, nowSeconds }) {
  if (env.PLAN_COMPATIBILITY_DUAL_READ_ENABLED === "true" ||
      env.PLAN_CANONICAL_READ_ENABLED === "true") {
    throw new CabinetStorageError("access_bridge_unavailable");
  }
  const telegramId = actor.user.telegramId;
  const legacy = await repo.one("user_access", "telegram_id = ?", [telegramId]);
  const grants = await repo.select("trial_grants",
    "telegram_id = ? AND program_code = 'dragon_preview'", [telegramId], "grant_id");
  if (grants.length > 1) throw new CabinetStorageError("authority_inconsistent");
  const grant = grants[0];
  const preview = env.DRAGON_PREVIEW_ENABLED === "true" && grant &&
    isPreviewGrantActive({ status: grant.status, started_at: grant.startedAt, ends_at: grant.endsAt }, nowSeconds);
  let decision = buildLegacyPlanAuthorityDecision({
    access_tier: legacy?.accessTier ?? "free",
  });
  let verifiedPreview = false;
  if (preview) {
    const plan = await repo.one("user_plans", "telegram_id = ?", [telegramId]);
    const state = await repo.one("user_access_states", "telegram_id = ?", [telegramId]);
    verifiedPreview = plan?.planCode === "free" && state?.accessState === "trial" &&
      databaseSeconds(state.stateStartedAt) === grant.startedAt &&
      databaseSeconds(state.stateEndsAt) === grant.endsAt &&
      legacy?.accessTier === "trial" && legacy.trialUsed === 1 &&
      databaseSeconds(legacy.trialStartedAt) === grant.startedAt &&
      databaseSeconds(legacy.trialEndsAt) === grant.endsAt;
    if (!verifiedPreview) decision = { planCode: null, accessState: state?.accessState ?? null,
      comparisonStatus: "manual_review", reviewRequired: true, resolved: false };
    repo.deadline(grant.endsAt);
  }
  return Object.freeze({
    authority: "worker", decisionVersion: 1, telegramId,
    systemRole: hasRole(actor, "admin") ? "admin" : hasRole(actor, "partner") ? "partner" : "user",
    ...decision,
    ...(verifiedPreview ? { planCode: "free", accessState: "trial", reviewRequired: false,
      resolved: true, comparisonStatus: "dragon_preview_active" } : {}),
    readPath: verifiedPreview ? "preview_overlay" : "legacy",
    planRevision: null, accessStateRevision: null, paidCapabilitiesEnabled: false,
  });
}

export async function readExistingAmbassadorFrame({ repo, context, profile, ambassador, period, nowSeconds }) {
  if (!ambassador || ambassador.status !== "active") return null;
  const reader = createD1OwnerAnalyticsReader(repo.db, async () => ({
    verified: true, telegramId: context.telegramId,
  }));
  try {
    const frame = await reader.read({
      periodStart: Date.parse(period.start + "T00:00:00Z") / 1000,
      periodEnd: Date.parse(period.endExclusive + "T00:00:00Z") / 1000,
      asOfAt: nowSeconds,
    });
    return Object.freeze({ authoritySource: "server_projection",
      partnerProfileId: profile.id, ambassadorId: ambassador.ambassadorId,
      periodCode: period.code, periodStart: period.start,
      periodEndExclusive: period.endExclusive, frame });
  } catch {
    // Existing privacy/rollout/checkpoint gates own availability. Never turn
    // a missing or suppressed v1.3.9 frame into a fabricated numeric zero.
    return null;
  }
}
