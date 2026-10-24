import { deriveServerIdempotencyKey, sha256Hex } from "./mini-app-security.mjs";
import {
  buildPartnerApplicationSubmitCommand, buildPartnerApplicationDecisionCommand,
  buildApprovedPartnerProfileRepairCommand, buildLegalProfileDeclarationCommand,
  buildPublicUsernameCommand,
} from "./partner-identity.mjs";
import {
  derivePartnerOfferCode, buildPartnerOfferCreateCommand, buildPartnerOfferVersionCommand,
  buildPartnerOfferSubmitCommand, buildOfferModerationCommand, buildOfferVisibilityCommand,
  buildOfferAssignmentCommand,
} from "./offer-lifecycle.mjs";
import { buildLeadSubmitCommand, buildLeadResultCommand } from "./lead-lifecycle.mjs";
import {
  projectCabinetBootstrap, projectCabinetProfile, projectCabinetOfferPage,
  projectCabinetApplicationPage, projectCabinetApplicationDetail, projectCabinetAnalytics,
  verifyCabinetPageCursor,
} from "./cabinet-read-model.mjs";
import {
  authorityError, hasRole, loadCabinetActor, loadPartnerIdentity, loadBetaSettings,
  loadCanonicalRoute, loadOfferAggregate, loadLeadAttribution, loadEligibleOffer,
  projectFreshOffer, assertPartnerWriteAuthority,
} from "./cabinet-authority.mjs";
import { databaseSeconds } from "./d1-cabinet-repository.mjs";
import { readExistingAccessAuthority, readExistingAmbassadorFrame } from "./existing-read-adapters.mjs";

const object = value => value && typeof value === "object" && !Array.isArray(value);
export const exactPayload = (payload, fields) => {
  if (!object(payload) || Object.keys(payload).some(k => !fields.includes(k))) authorityError("invalid_request", 400);
  return payload;
};
const positive = value => {
  if (!Number.isSafeInteger(value) || value < 1) authorityError("invalid_request", 400);
  return value;
};
const code = value => {
  if (typeof value !== "string" || !/^[a-z0-9_-]{3,24}$/u.test(value)) authorityError("invalid_request", 400);
  return value;
};
const stableValue = value => Array.isArray(value) ? value.map(stableValue)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stableValue(value[k])])) : value;
const OFFER_PATCH = ["buttonText", "title", "description", "provider", "category", "payoutText",
  "requiredAction", "minAge", "maxAge", "geo", "holdDays", "trafficSources", "sourceName",
  "startsAt", "expiresAt", "partnerLinkId"];
// Minted only by the actual fixed catalog producer below, after its captured
// repository reads pass the first fence. It is not a client DTO or public mint.
const verifiedEmptyCatalogPages=new WeakMap();
const emptyCatalogRouteKey=route=>JSON.stringify([route.routeCode,route.params.view,
  route.params.limit,route.params.cursor??null]);
export function consumeVerifiedEmptyCabinetCatalogPage(result,context,route) {
  const source=verifiedEmptyCatalogPages.get(result);
  if(!source) return null;
  verifiedEmptyCatalogPages.delete(result);
  if(source.context!==context || route?.routeCode!=='cabinet.offers' ||
      route.params?.view!=='catalog' || source.key!==emptyCatalogRouteKey(route)) {
    authorityError('untrusted_catalog_projection');
  }
  return source;
}
const CATALOG_WHERE = `o.status = 'active'
  AND EXISTS (SELECT 1 FROM offer_owners own JOIN partner_profiles p ON p.id = own.partner_profile_id
    WHERE own.offer_code = o.code AND own.owner_kind = 'partner' AND p.status = 'active')
  AND EXISTS (SELECT 1 FROM offer_visibility_rules r WHERE r.offer_code = o.code
    AND r.moderation_status = 'approved' AND r.current_version_id = r.submitted_version_id
    AND r.current_version_id = r.approved_version_id
    AND (r.visibility = 'public' OR (r.visibility = 'assigned' AND EXISTS
      (SELECT 1 FROM offer_visibility_assignments a WHERE a.offer_code = o.code
       AND a.telegram_id = ? AND a.assignment_status = 'active'))))`;
const cursorWhere = (anchor, time, key) => anchor
  ? { sql: ` AND (${time} < ? OR (${time} = ? AND ${key} < ?))`,
    params: [anchor.anchorTime, anchor.anchorTime, anchor.anchorKey] } : { sql: "", params: [] };
const periodFor = (periodCode, now) => {
  const end = Math.floor(now / 86400) * 86400;
  return { code: periodCode, start: new Date((end - (periodCode === "7d" ? 7 : 30) * 86400) * 1000).toISOString().slice(0, 10),
    endExclusive: new Date(end * 1000).toISOString().slice(0, 10) };
};

export function resolveCabinetWriteRoute(url) {
  const parsed = new URL(url);
  if (parsed.search) authorityError("invalid_request", 400);
  const prefix = "/api/v1.4.0/cabinet/";
  const fixed = { "partner/application": "partner.apply", "partner/legal-profile": "partner.legal",
    "partner/public-username": "partner.username", offers: "offer.create", applications: "lead.submit" };
  const path = parsed.pathname.startsWith(prefix) ? parsed.pathname.slice(prefix.length) : "";
  if (Object.hasOwn(fixed, path)) return { action: fixed[path], target: {} };
  const match = /^offers\/([a-z0-9_-]{3,24})\/(version|submit)$/u.exec(path);
  if (match) return { action: match[2] === "version" ? "offer.edit" : "offer.submit", target: { code: match[1] } };
  authorityError("not_found", 404);
}

// A service is internal to the Worker. HTTP accepts only the fixed P08 action
// routes; trusted actions below are a server bridge, never an admin JSON API.
export function createCabinetService({ repo, env, context, gate, nowSeconds,
  readAccessAuthority = readExistingAccessAuthority,
  readAmbassadorFrame = readExistingAmbassadorFrame, reconcileReceipt = null, runtime = null }) {
  const common = async () => {
    const actor = await loadCabinetActor(repo, context.telegramId);
    const identity = await loadPartnerIdentity(repo, context.telegramId);
    return { actor, identity, args: { ...actor, ...identity, context, nowSeconds } };
  };
  const ambassadorFor = async profile => profile
    ? repo.one("ambassador_profiles_v2", "partner_profile_id = ?", [profile.id]) : null;
  const count = async (sql, params) => (await repo.readQuery(sql, params, ["n"]))[0].n;
  const visibleOfferCount = async actor => {
    const candidates = await repo.readQuery(`SELECT o.code FROM offers o WHERE ${CATALOG_WHERE}
      ORDER BY o.code LIMIT 201`, [context.telegramId], ["code"]);
    if (candidates.length > 200) authorityError("catalog_scan_unavailable", 503);
    await repo.loadOfferAggregates?.(candidates.map(c=>c.code),context.telegramId);
    let visible = 0;
    for (const candidate of candidates) {
      const aggregate = await loadOfferAggregate(repo, candidate.code, env, context);
      try { await projectFreshOffer(repo, aggregate, actor, context, nowSeconds); visible++; }
      catch (error) {
        if (!["offer_not_public", "offer_not_available", "invalid_route"].includes(error?.code)) throw error;
      }
    }
    return visible;
  };
  const authenticateAction = async (action, actor, identity) => {
    if (action.startsWith("admin.")) {
      if (!hasRole(actor, "admin")) authorityError("admin_required");
    } else if (action.startsWith("offer.") || ["partner.legal", "partner.username"].includes(action)) {
      const settings = await loadBetaSettings(repo, env);
      await assertPartnerWriteAuthority(repo, actor, identity, settings,
        action.startsWith("offer.") ? action === "offer.submit" ? "submit" : "create" : null, nowSeconds);
    } else if (action === "lead.submit" && !hasRole(actor, "user")) authorityError("user_required");
  };
  const versionId = (aggregate, visibleNumber) => {
    if (positive(visibleNumber) !== aggregate.currentVersion.versionNumber ||
        aggregate.currentVersion.id !== aggregate.visibilityRule.currentVersionId ||
        aggregate.currentVersion.offerCode !== aggregate.offer.code) authorityError("version_conflict", 409);
    return aggregate.currentVersion.id;
  };
  const mutate = async (action, payload, target = {}, trusted = false, clientKey) => {
    const { actor, identity, args } = await common();
    await authenticateAction(action, actor, identity);
    const operation = "cabinet." + action;
    const idempotencyKey = await deriveServerIdempotencyKey({
      secret: env.MINI_APP_IDEMPOTENCY_SECRET, operation, clientKey, telegramId: context.telegramId,
    });
    const requestHash = await sha256Hex(JSON.stringify(stableValue({ action, payload, target })));
    const receipt = await repo.findReceipt(idempotencyKey);
    if (receipt) return repo.replayReceipt({ receipt, requestHash, operation, context, gate });
    const authority = { ...args, idempotencyKey };
    let command;
    if (action === "partner.apply") {
      exactPayload(payload, ["displayName", "contact", "ageConfirmed"]);
      command = await buildPartnerApplicationSubmitCommand({ ...authority, existingApplication: identity.application, payload });
    } else if (action === "partner.legal") {
      exactPayload(payload, ["profileKind", "selfDeclarationAccepted"]);
      command = await buildLegalProfileDeclarationCommand({ ...authority, existingLegalProfile: identity.legalProfile, payload });
    } else if (action === "partner.username") {
      exactPayload(payload, ["enabled"]);
      command = await buildPublicUsernameCommand({ ...authority, currentSettings: identity.publicSettings, enabled: payload.enabled });
    } else if (action === "offer.create") {
      exactPayload(payload, []);
      const offerCode = await derivePartnerOfferCode({ partnerProfileId: identity.partnerProfile.id, idempotencyKey });
      const existingRoot = await repo.one("offers", "code = ?", [offerCode]);
      const existingOffer = existingRoot ? await loadOfferAggregate(repo, offerCode, env, context) : null;
      const activeOfferCount = { authoritySource: "database", partnerProfileId: identity.partnerProfile.id,
        activeOfferCount: await count(`SELECT COUNT(*) AS n FROM offers o JOIN offer_owners own ON own.offer_code = o.code
          WHERE own.owner_kind = 'partner' AND own.partner_profile_id = ? AND o.status <> 'archived'`, [identity.partnerProfile.id]) };
      command = await buildPartnerOfferCreateCommand({ ...authority,
        betaSettings: await loadBetaSettings(repo, env), activeOfferCount, existingOffer });
    } else if (["offer.edit", "offer.submit", "offer.business"].includes(action)) {
      if (action === "offer.business" && !trusted) authorityError("not_found", 404);
      exactPayload(payload, action === "offer.edit" ? ["version", "patch"] : action === "offer.business" ? ["version", "desiredBusinessStatus"] : ["version"]);
      const aggregate = await loadOfferAggregate(repo, code(target.code), env, context);
      if (aggregate.owner.partnerProfileId !== identity.partnerProfile.id || aggregate.owner.ownerKind !== "partner") authorityError("not_found", 404);
      const expectedVersionId = versionId(aggregate, payload.version);
      if (action === "offer.submit") {
        command = await buildPartnerOfferSubmitCommand({ ...authority, ...aggregate, expectedVersionId });
      } else {
        const patch = action === "offer.edit" ? exactPayload(payload.patch, OFFER_PATCH) : {};
        if (action === "offer.edit" && !Object.keys(patch).length) authorityError("invalid_request", 400);
        const selectedRoute = Object.hasOwn(patch, "partnerLinkId")
          ? await loadCanonicalRoute(repo, positive(patch.partnerLinkId)) : null;
        command = await buildPartnerOfferVersionCommand({ ...authority, ...aggregate, expectedVersionId,
          patch: action === "offer.edit" ? patch : null, selectedRoute,
          desiredBusinessStatus: action === "offer.business" ? payload.desiredBusinessStatus : null });
      }
    } else if (action === "lead.submit") {
      exactPayload(payload, ["offerCode"]);
      const offerCode = code(payload.offerCode);
      const eligibleOffer = await loadEligibleOffer(repo, offerCode, actor, context, env, nowSeconds);
      const existingLead = await repo.one("lead_requests", "telegram_id = ? AND offer_code = ?", [context.telegramId, offerCode]);
      command = await buildLeadSubmitCommand({ ...authority, payload, eligibleOffer, existingLead,
        existingAttribution: await loadLeadAttribution(repo, existingLead) });
    } else if (trusted && ["admin.partner.review", "admin.partner.repair"].includes(action)) {
      exactPayload(payload, action.endsWith("review") ? ["decision", "reason"] : []);
      const application = await repo.one("partner_applications", "id = ?", [positive(target.applicationId)]);
      if (!application) authorityError("not_found", 404);
      const existingProfile = await repo.one("partner_profiles", "telegram_id = ?", [application.telegramId]);
      command = action.endsWith("repair")
        ? await buildApprovedPartnerProfileRepairCommand({ ...authority, application, existingProfile })
        : await buildPartnerApplicationDecisionCommand({ ...authority, application, existingProfile,
          decision: payload.decision, reason: payload.reason ?? "" });
    } else if (trusted && ["admin.offer.moderate", "admin.offer.visibility", "admin.offer.assignment"].includes(action)) {
      const aggregate = await loadOfferAggregate(repo, code(target.code), env, context);
      const assignmentCount = { authoritySource: "database", offerCode: aggregate.offer.code,
        activeAssignmentCount: await count("SELECT COUNT(*) AS n FROM offer_visibility_assignments WHERE offer_code = ? AND assignment_status = 'active'", [aggregate.offer.code]) };
      if (action === "admin.offer.assignment") {
        exactPayload(payload, ["targetTelegramId", "action", "reason"]);
        const targetTelegramId = positive(payload.targetTelegramId);
        const targetUser = await repo.one("users", "telegram_id = ?", [targetTelegramId]);
        const existingAssignment = await repo.one("offer_visibility_assignments",
          "offer_code = ? AND telegram_id = ?", [aggregate.offer.code, targetTelegramId]);
        command = await buildOfferAssignmentCommand({ ...authority, ...aggregate, assignmentCount, existingAssignment,
          targetTelegramId, targetUser, action: payload.action, reason: payload.reason ?? "" });
      } else {
        exactPayload(payload, action.endsWith("moderate") ? ["version", "decision", "reason"] : ["version", "visibility", "reason"]);
        const expectedVersionId = versionId(aggregate, payload.version);
        command = action.endsWith("moderate")
          ? await buildOfferModerationCommand({ ...authority, ...aggregate, expectedVersionId,
            ownerProfile: await repo.one("partner_profiles", "id = ?", [aggregate.owner.partnerProfileId]),
            decision: payload.decision, reason: payload.reason ?? "" })
          : await buildOfferVisibilityCommand({ ...authority, ...aggregate, expectedVersionId, assignmentCount,
            visibility: payload.visibility, reason: payload.reason ?? "" });
      }
    } else if (trusted && action === "admin.lead.result") {
      exactPayload(payload, ["decision", "rewardKopecks", "reason"]);
      const lead = await repo.one("lead_requests", "id = ?", [positive(target.leadId)]);
      if (!lead) authorityError("not_found", 404);
      const compatibilityConversion = await repo.one("conversions", "telegram_id = ? AND offer_code = ?", [lead.telegramId, lead.offerCode]);
      command = await buildLeadResultCommand({ ...authority, payload: { ...payload, leadId: lead.id }, lead,
        attribution: await loadLeadAttribution(repo, lead), compatibilityConversion });
    } else authorityError("not_found", 404);
    try { return await repo.commit({ command, idempotencyKey, requestHash, operation, context, gate }); }
    catch (error) {
      if (error?.code === "receipt_race" && typeof reconcileReceipt === "function") {
        return reconcileReceipt({ action, payload, target, clientKey });
      }
      throw error;
    }
  };
  return Object.freeze({
    async prepareReferral(body, clientKey, options) {
      if (!runtime?.prepareReferral) authorityError('authorization_unavailable', 503);
      return runtime.prepareReferral(exactPayload(body, []), clientKey, options);
    },
    mutate: (action, payload, target, clientKey) => runtime
      ? runtime.mutate(action,payload,target,clientKey) : mutate(action, payload, target, false, clientKey),
    trusted: (action, payload, target, clientKey) => {
      if(runtime) authorityError('authorization_unavailable',503);
      return mutate(action,payload,target,true,clientKey);
    },
    async reconcile({ action, payload, target, clientKey }) {
      if(runtime) return runtime.mutate(action,payload,target,clientKey);
      const { actor, identity } = await common();
      await authenticateAction(action, actor, identity);
      const operation = "cabinet." + action;
      const idempotencyKey = await deriveServerIdempotencyKey({
        secret: env.MINI_APP_IDEMPOTENCY_SECRET, operation, clientKey, telegramId: context.telegramId,
      });
      const requestHash = await sha256Hex(JSON.stringify(stableValue({ action, payload, target })));
      const receipt = await repo.findReceipt(idempotencyKey);
      if (!receipt) authorityError("storage_unavailable", 503);
      return repo.replayReceipt({ receipt, requestHash, operation, context, gate });
    },
    async read(route) {
      if (route.routeCode === "cabinet.subscription") {
        // This route has no legacy or caller-provided authority fallback.
        // The established own session and source fence still surrounds the
        // central read-only projection, including its additional price reads.
        if (!runtime?.readSubscription) authorityError("authorization_unavailable", 503);
        await repo.assertReadFence({ context, gate });
        const result = await runtime.readSubscription();
        await repo.assertReadFence({ context, gate });
        return result;
      }
      const { actor, identity, args } = await common();
      const profile = identity.partnerProfile;
      const { routeCode, params } = route;
      let result;
      if (routeCode === "cabinet.profile" || routeCode === "cabinet.bootstrap") {
        const accessAuthority = await readAccessAuthority({ repo, actor, env, nowSeconds });
        if (routeCode === "cabinet.profile") result = projectCabinetProfile({ ...args, accessAuthority });
        else {
          const summary = { authoritySource: "database", telegramId: context.telegramId,
            partnerProfileId: profile?.id ?? null,
            visibleOffers: await visibleOfferCount(actor),
            ownOffers: profile ? await count("SELECT COUNT(*) AS n FROM offer_owners WHERE partner_profile_id = ? AND owner_kind = 'partner'", [profile.id]) : 0,
            ownApplications: await count("SELECT COUNT(*) AS n FROM lead_requests WHERE telegram_id = ?", [context.telegramId]),
            attributedApplications: profile ? await count("SELECT COUNT(*) AS n FROM lead_partner_attribution WHERE partner_profile_id = ?", [profile.id]) : 0 };
          result = projectCabinetBootstrap({ ...args, accessAuthority, summary,
            ambassadorProfile: await ambassadorFor(profile) });
        }
      } else if (routeCode === "cabinet.offer_action") {
        const aggregate = await loadOfferAggregate(repo, params.code, env, context);
        result = await projectFreshOffer(repo, aggregate, actor, context, nowSeconds);
      } else if (routeCode === "cabinet.offers") {
        const { view, limit, cursor } = params;
        if (view === "mine" && (!hasRole(actor, "partner") || !profile || !runtime && profile.status !== "active")) authorityError("partner_required");
        let anchor = cursor ? await verifyCabinetPageCursor({ context, collection: "offers", view, cursor,
          cursorSecret: env.MINI_APP_CURSOR_SECRET, nowSeconds }) : null;
        const entries = [];
        let exhausted = false;
        let scanned = 0;
        while (entries.length <= limit && !exhausted) {
          const cut = cursorWhere(anchor, "unixepoch(o.updated_at)", "o.code");
          const predicate = view === "mine"
            ? "EXISTS (SELECT 1 FROM offer_owners own WHERE own.offer_code = o.code AND own.owner_kind = 'partner' AND own.partner_profile_id = ?)"
            : CATALOG_WHERE;
          const candidates = await repo.readQuery(`SELECT o.code, unixepoch(o.updated_at) AS cursor_time FROM offers o
            WHERE ${predicate}${cut.sql} ORDER BY cursor_time DESC, o.code DESC LIMIT ?`,
            [view === "mine" ? profile.id : context.telegramId, ...cut.params, limit + 1], ["code", "cursor_time"]);
          exhausted = candidates.length < limit + 1;
          await repo.loadOfferAggregates?.(candidates.map(c=>c.code),context.telegramId);
          for (const candidate of candidates) {
            if (++scanned > 200) authorityError("catalog_scan_unavailable", 503);
            anchor = { anchorTime: candidate.cursorTime, anchorKey: candidate.code };
            const aggregate = await loadOfferAggregate(repo, candidate.code, env, context);
            if (view === "catalog") {
              try { await projectFreshOffer(repo, aggregate, actor, context, nowSeconds); }
              catch (error) {
                if (["offer_not_public", "offer_not_available", "invalid_route"].includes(error?.code)) continue;
                throw error;
              }
            }
            entries.push({ authoritySource: "database", cursorTime: candidate.cursorTime, cursorKey: candidate.code,
              scope: view === "mine" ? "own" : aggregate.visibilityRule.visibility, aggregate });
            if (entries.length > limit) break;
          }
        }
        result = await projectCabinetOfferPage({ ...args, view, entries: entries.slice(0, limit),
          hasMore: entries.length > limit, limit, cursorSecret: env.MINI_APP_CURSOR_SECRET });
      } else if (routeCode === "cabinet.applications") {
        const { view, limit, cursor } = params;
        if (view === "attributed" && (!hasRole(actor, "partner") || !profile || !runtime && profile.status !== "active")) authorityError("partner_required");
        const anchor = cursor ? await verifyCabinetPageCursor({ context, collection: "applications", view, cursor,
          cursorSecret: env.MINI_APP_CURSOR_SECRET, nowSeconds }) : null;
        const cut = cursorWhere(anchor, "unixepoch(l.updated_at)", "CAST(l.id AS TEXT)");
        const predicate = view === "mine" ? "l.telegram_id = ?" :
          "EXISTS (SELECT 1 FROM lead_partner_attribution a WHERE a.lead_id = l.id AND a.partner_profile_id = ?)";
        const ids = await repo.readQuery(`SELECT l.id, unixepoch(l.updated_at) AS cursor_time FROM lead_requests l
          WHERE ${predicate}${cut.sql} ORDER BY cursor_time DESC, CAST(l.id AS TEXT) DESC LIMIT ?`,
          [view === "mine" ? context.telegramId : profile.id, ...cut.params, limit + 1], ["id", "cursor_time"]);
        const entries = [];
        const selectedIds=ids.slice(0,limit).map(row=>row.id);
        const leads=new Map((await repo.select('lead_requests','id IN (SELECT value FROM json_each(?))',[JSON.stringify(selectedIds)])).map(row=>[row.id,row]));
        const attributions=view==='attributed' ? new Map((await repo.select('lead_partner_attribution',
          'lead_id IN (SELECT value FROM json_each(?))',[JSON.stringify(selectedIds)])).map(row=>[row.leadId,{...row,inviterId:profile.telegramId}])):null;
        for (const row of ids.slice(0, limit)) {
          const lead = leads.get(row.id);
          if (!lead) authorityError('state_conflict',409);
          entries.push({ authoritySource: "database", cursorTime: row.cursorTime, cursorKey: String(row.id), lead,
            attribution: view === "attributed" ? attributions.get(row.id)??null : null });
        }
        result = await projectCabinetApplicationPage({ ...args, view, limit, entries,
          hasMore: ids.length > limit, cursorSecret: env.MINI_APP_CURSOR_SECRET });
      } else if (routeCode === "cabinet.application_detail") {
        const lead = await repo.one("lead_requests", "id = ?", [params.leadId]);
        if (!lead) authorityError("not_found", 404);
        let attribution = null;
        let view = "mine";
        if (lead.telegramId !== context.telegramId) {
          if (!hasRole(actor, "partner") || !profile || !runtime && profile.status !== "active") authorityError("not_found", 404);
          attribution = await loadLeadAttribution(repo, lead);
          if (attribution?.partnerProfileId !== profile.id) authorityError("not_found", 404);
          view = "attributed";
        }
        result = projectCabinetApplicationDetail({ ...args, view, lead, attribution });
      } else if (routeCode === "cabinet.analytics") {
        if (!hasRole(actor, "partner") || !profile || profile.status !== "active") authorityError("partner_required");
        const period = periodFor(params.period, nowSeconds);
        const totals = (await repo.readQuery(`SELECT COUNT(*) AS applications,
          COALESCE(SUM(l.status = 'pending'),0) AS pending_applications,
          COALESCE(SUM(l.status = 'confirmed'),0) AS confirmed_applications,
          COALESCE(SUM(l.status = 'rejected'),0) AS rejected_applications,
          COALESCE(SUM(l.status = 'paid'),0) AS paid_applications,
          COALESCE(SUM(CASE WHEN l.status IN ('confirmed','paid') THEN l.reward_kopecks ELSE 0 END),0) AS confirmed_result_kopecks
          FROM lead_requests l JOIN lead_partner_attribution a ON a.lead_id = l.id
          WHERE a.partner_profile_id = ? AND unixepoch(l.created_at) >= unixepoch(?)
            AND unixepoch(l.created_at) < unixepoch(?)`, [profile.id, period.start, period.endExclusive],
          ["applications", "pending_applications", "confirmed_applications", "rejected_applications", "paid_applications", "confirmed_result_kopecks"]))[0];
        const clicks = (await repo.readQuery(`SELECT COUNT(*) AS link_clicks, COUNT(DISTINCT c.telegram_id) AS unique_link_clicks
          FROM partner_link_clicks c JOIN partner_links p ON p.id = c.partner_link_id
          WHERE p.partner_profile_id = ? AND unixepoch(c.clicked_at) >= unixepoch(?)
            AND unixepoch(c.clicked_at) < unixepoch(?)`, [profile.id, period.start, period.endExclusive],
          ["link_clicks", "unique_link_clicks"]))[0];
        const ambassadorProfile = await ambassadorFor(profile);
        result = projectCabinetAnalytics({ ...args, period, ambassadorProfile,
          leadAggregate: { ...totals, ...clicks, authoritySource: "database_aggregate",
            partnerProfileId: profile.id, periodCode: period.code, periodStart: period.start,
            periodEndExclusive: period.endExclusive, generatedAt: nowSeconds },
          ambassadorFrame: await readAmbassadorFrame({ repo, context, profile, ambassador: ambassadorProfile, period, nowSeconds }) });
      } else authorityError("not_found", 404);
      await repo.assertReadFence({context,gate});
      if(!runtime) return result;
      if(routeCode==='cabinet.offers' && params.view==='catalog' &&
          result.view==='catalog' && result.items.length===0 && result.nextCursor===null) {
        verifiedEmptyCatalogPages.set(result,Object.freeze({context,nowSeconds,key:emptyCatalogRouteKey(route)}));
      }
      const projected=await runtime.read(route,result);
      // Canonical policy reads must not supersede the accepted source snapshot
      // used to build a URL, cursor, owner projection or privacy-safe page.
      await repo.assertReadFence({context,gate});
      return projected;
    },
  });
}
