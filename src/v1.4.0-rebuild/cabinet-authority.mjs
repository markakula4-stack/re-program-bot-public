import { databaseSeconds } from "./d1-cabinet-repository.mjs";
import { CabinetStorageError } from "./command-sql.mjs";
import { projectAssignedPartnerOffer, projectPublicPartnerOffer } from "./offer-lifecycle.mjs";

export const authorityError = (code, status = 403) => { throw new CabinetStorageError(code, status); };
export async function loadCabinetActor(repo, telegramId) {
  const user = await repo.one("users", "telegram_id = ?", [telegramId]);
  if (!user) authorityError("registration_required");
  if (user.isBlocked === 1 || user.isBlocked === true) authorityError("actor_blocked");
  const roleRows = await repo.select("user_roles", "telegram_id = ?", [telegramId], "role");
  if (roleRows.some(r => !["user", "partner", "admin"].includes(r.role) || !["active", "paused"].includes(r.status))) {
    authorityError("authority_inconsistent", 503);
  }
  return { user, roleRows };
}
export const hasRole = (actor, role) => actor.roleRows.some(r => r.role === role && r.status === "active");
export async function loadPartnerIdentity(repo, telegramId) {
  const application = await repo.one("partner_applications", "telegram_id = ?", [telegramId]);
  const partnerProfile = await repo.one("partner_profiles", "telegram_id = ?", [telegramId]);
  const publicSettings = await repo.one("partner_public_settings", "telegram_id = ?", [telegramId]);
  const legalProfile = partnerProfile
    ? await repo.one("partner_legal_profiles", "partner_profile_id = ?", [partnerProfile.id]) : null;
  const betaAccess = partnerProfile
    ? await repo.one("partner_beta_access", "partner_profile_id = ?", [partnerProfile.id]) : null;
  return { application, partnerProfile, publicSettings, legalProfile, betaAccess };
}
export async function loadBetaSettings(repo, env) {
  const row = await repo.one("partner_beta_settings", "id = 1");
  if (!row) authorityError("storage_unavailable", 503);
  // P12 acceptance is a separate, finite rollout authority. It enables only
  // this selected actor's rebuild and never changes the accepted global Beta
  // settings or flags. Actual partner role/profile/legal/Beta grants remain
  // canonical and are still checked independently by every command.
  const lease=env.REBUILD_V140_RELEASE_LEASE_REQUIRED==='true'&&env.REBUILD_V140_BETA_ENABLED==='true'
    ? await repo.one('mini_app_release_control','id=1') : null;
  const privateBeta=lease?.state==='open'&&lease.betaEnabled===1&&lease.ownerTelegramId===Number(env.REBUILD_V140_OWNER_TELEGRAM_ID??env.OWNER_TELEGRAM_ID)&&
    lease.candidateSha===env.REBUILD_V140_RC_SHA&&lease.revision===Number(env.REBUILD_V140_RELEASE_REVISION)&&
    lease.expiresAt>Math.floor(Date.now()/1000);
  // Worker hard flags and a database rollout authority are required. No
  // request field can enable Beta, editing, submission or publication.
  return Object.freeze({ ...row,
    enabled: (row.enabled === 1 || privateBeta) && env.PARTNER_BETA_ENABLED === "true",
    privateOffersEnabled: (row.privateOffersEnabled === 1 || privateBeta) && env.PARTNER_PRIVATE_OFFERS_ENABLED === "true",
    submissionsEnabled: (row.submissionsEnabled === 1 || privateBeta) && env.PARTNER_OFFER_SUBMISSIONS_ENABLED === "true",
    publicVisibilityEnabled: (row.publicVisibilityEnabled === 1 || privateBeta) && env.PARTNER_OFFER_PUBLIC_VISIBILITY_ENABLED === "true",
  });
}
export async function loadCanonicalRoute(repo, linkId) {
  const link = await repo.one("partner_links", "id = ?", [linkId]);
  if (!link) return null;
  const catalog = await repo.one("program_offers", "id = ?", [link.catalogOfferId]);
  if (!catalog) return null;
  const profile = await repo.one("partner_profiles", "id = ?", [link.partnerProfileId]);
  const program = await repo.one("partner_programs", "code = ?", [catalog.programCode]);
  const offer = await repo.one("offers", "code = ?", [catalog.offerCode]);
  if (!profile || !program || !offer) return null;
  return Object.freeze({ authoritySource: "database",
    partnerLinkId: link.id, partnerProfileId: link.partnerProfileId,
    ownerProfileStatus: profile.status, partnerLinkStatus: link.status,
    ownershipConfirmed: link.ownershipConfirmed, trafficConfirmed: link.trafficConfirmed,
    catalogOfferId: catalog.id, catalogOfferCode: catalog.offerCode,
    catalogOfferStatus: catalog.status, programCode: program.code, programStatus: program.status,
    catalogBusinessStatus: offer.status, url: link.url, trackingKey: link.trackingKey,
    allowedDomains: program.allowedDomains, updatedAt: link.updatedAt,
  });
}
export async function loadOfferAggregate(repo, code, env, context = null) {
  if (typeof repo.loadOfferAggregates==='function') {
    const aggregate=(await repo.loadOfferAggregates([code],context?.telegramId??0)).get(code);
    if (!aggregate?.offer) authorityError('not_found',404);
    if (!aggregate.owner||!aggregate.visibilityRule||!aggregate.currentVersion) authorityError('offer_not_available',404);
    return {...aggregate,betaSettings:await loadBetaSettings(repo,env)};
  }
  const offer = await repo.one("offers", "code = ?", [code]);
  if (!offer) authorityError("not_found", 404);
  const owner = await repo.one("offer_owners", "offer_code = ?", [code]);
  const visibilityRule = await repo.one("offer_visibility_rules", "offer_code = ?", [code]);
  const currentVersion = visibilityRule
    ? await repo.one("offer_versions", "id = ? AND offer_code = ?", [visibilityRule.currentVersionId, code]) : null;
  if (!owner || !visibilityRule || !currentVersion) authorityError("offer_not_available", 404);
  const selected = await repo.one("partner_offer_links", "offer_code = ?", [code]);
  const currentRoute = selected ? await loadCanonicalRoute(repo, selected.partnerLinkId) : null;
  const betaSettings = await loadBetaSettings(repo, env);
  const assignment = context
    ? await repo.one("offer_visibility_assignments", "offer_code = ? AND telegram_id = ?", [code, context.telegramId]) : null;
  return { offer, owner, currentVersion, visibilityRule, currentRoute, betaSettings, assignment };
}
export function assertOfferWindow(repo, offer, now) {
  const start = databaseSeconds(offer.startsAt);
  let end = databaseSeconds(offer.expiresAt);
  if (typeof offer.expiresAt === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(offer.expiresAt)) end += 86400;
  if ((offer.startsAt && start === null) || (offer.expiresAt && end === null) ||
      (start !== null && start > now) || (end !== null && end <= now)) {
    authorityError("offer_not_available", 404);
  }
  repo.deadline(end);
}
export async function projectFreshOffer(repo, aggregate, actor, context, now) {
  assertOfferWindow(repo, aggregate.offer, now);
  if (aggregate.visibilityRule.visibility === "public") return projectPublicPartnerOffer(aggregate);
  if (aggregate.visibilityRule.visibility === "assigned") {
    if (aggregate.assignment?.assignmentStatus !== "active" ||
        aggregate.assignment.telegramId !== context.telegramId) authorityError("offer_not_public", 404);
    return projectAssignedPartnerOffer({ ...aggregate, ...actor, context });
  }
  authorityError("offer_not_public", 404);
}
export async function loadLeadAttribution(repo, lead) {
  if (!lead) return null;
  const row = await repo.one("lead_partner_attribution", "lead_id = ?", [lead.id]);
  if (!row) return null;
  const profile = await repo.one("partner_profiles", "id = ?", [row.partnerProfileId]);
  if (!profile) authorityError("attribution_conflict", 409);
  return Object.freeze({ ...row, inviterId: profile.telegramId });
}
export async function loadEligibleOffer(repo, code, actor, context, env, now) {
  const aggregate = await loadOfferAggregate(repo, code, env, context);
  // P05 validates current approved snapshot hash, audience and canonical URL.
  await projectFreshOffer(repo, aggregate, actor, context, now);
  const route = aggregate.currentRoute;
  const ownerProfile = await repo.one("partner_profiles", "id = ?", [aggregate.owner.partnerProfileId]);
  if (!route || !ownerProfile) authorityError("offer_not_available", 404);
  return Object.freeze({ authoritySource: "database", offerCode: code, sourceKind: "partner_offer",
    partnerLinkId: route.partnerLinkId, partnerProfileId: route.partnerProfileId,
    inviterId: ownerProfile.telegramId, ownerTelegramId: ownerProfile.telegramId,
    ownerProfileStatus: ownerProfile.status, partnerLinkStatus: route.partnerLinkStatus,
    ownershipConfirmed: route.ownershipConfirmed, trafficConfirmed: route.trafficConfirmed,
    destinationAvailable: true, isOwnerPreview: ownerProfile.telegramId === context.telegramId,
    programCode: route.programCode, businessStatus: aggregate.offer.status,
    currentVersionId: aggregate.currentVersion.id,
    submittedVersionId: aggregate.visibilityRule.submittedVersionId,
    approvedVersionId: aggregate.visibilityRule.approvedVersionId,
    moderationStatus: aggregate.visibilityRule.moderationStatus,
    visibility: aggregate.visibilityRule.visibility,
    assignmentActive: aggregate.assignment?.assignmentStatus === "active",
    assignedTelegramId: aggregate.assignment?.telegramId ?? null,
  });
}
export async function assertPartnerWriteAuthority(repo, actor, identity, settings, capability, now) {
  if (!hasRole(actor, "partner") || !identity.partnerProfile ||
      identity.partnerProfile.telegramId !== actor.user.telegramId || identity.partnerProfile.status !== "active") {
    authorityError("partner_required");
  }
  // Legal declarations and privacy settings concern this actor's own real
  // partner profile. The separate offer capabilities remain unavailable to
  // admins, including admins who also have the canonical partner role.
  if (capability === null) return;
  if (hasRole(actor, "admin")) authorityError("admin_content_edit_forbidden");
  const beta = identity.betaAccess;
  const expires = databaseSeconds(beta?.expiresAt);
  if (!beta || beta.accessStatus !== "active" || !settings.enabled || !settings.privateOffersEnabled ||
      (beta.expiresAt != null && expires === null) || (expires !== null && expires <= now) ||
      (capability === "submit" ? !(beta.canSubmitOffers === 1 && settings.submissionsEnabled) : beta.canCreatePrivateOffers !== 1)) {
    authorityError("partner_beta_required");
  }
  repo.deadline(expires);
}
