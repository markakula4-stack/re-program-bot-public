import { isTrustedContext, readTrustedContext, compileContextAssertions } from './trusted-context.mjs';
import { isTrustedActor, readActorFacts, readActorContext, compileAuthorityReplayAssertions,
  accountGenerationFingerprint } from './authority-resolver.mjs';
import { isTrustedResource, readResourceFacts, readResourceContext } from './resource-resolver.mjs';
import { isTrustedDecision, readDecisionFacts, readDecisionContext, compileDecisionAssertions } from './entitlement-engine.mjs';
import { CAPABILITY_DEFINITIONS, FOUNDATION_POLICY_VERSION } from './capability-policy.mjs';
import { databaseRow } from '../v1.4.0-rebuild/d1-cabinet-repository.mjs';
import { compileCabinetCommand } from '../v1.4.0-rebuild/command-sql.mjs';
import { buildLeadSubmitCommand, buildLeadResultCommand } from '../v1.4.0-rebuild/lead-lifecycle.mjs';
import { buildPartnerOfferCreateCommand, buildPartnerOfferVersionCommand, buildPartnerOfferSubmitCommand } from '../v1.4.0-rebuild/offer-lifecycle.mjs';
import { transitionAmbassadorCampaign } from '../v1.3.9/ambassador-attribution.mjs';
import { readAnalyticsV2Config } from '../v1.3.9/analytics-foundation.mjs';
import { RUNTIME_MUTATION_OPERATIONS, normalizeRuntimeMutationIntent, createRuntimeMutation,
  readRuntimeMutation, compileRuntimeMutationReplayScope } from './mutation-adapters.mjs';

// Part3 isolated server executor. No route imports it; personal audit writes
// must remain unwired until Part4 proves subject AND author privacy cleanup.
export const ATOMIC_ADMISSION_VERSION = '2026-10-02.v1.4.1.p03';
export const ATOMIC_ADMISSION_RUNTIME_WIRED = false;
const definitions = new Map(CAPABILITY_DEFINITIONS.map(row => [row.capability, row]));
const REGISTRY = Object.freeze({
  'application.create': 'lead_submit', 'application.resubmit': 'lead_submit',
  'admin.application.result': 'lead_result',
  'offer.create_private': 'offer_create', 'offer.edit_own': 'offer_version',
  'offer.submit_moderation': 'offer_submit', 'offer.activate_own': 'offer_version',
  'offer.pause_own': 'offer_version', 'offer.archive_own': 'offer_version',
  'campaign.activate': 'campaign_transition', 'campaign.resume': 'campaign_transition',
  'campaign.pause': 'campaign_transition', 'campaign.archive': 'campaign_transition',
  ...Object.fromEntries(RUNTIME_MUTATION_OPERATIONS.map(capability => [capability, 'runtime_mutation'])),
});
export const ATOMIC_OPERATIONS = Object.freeze(Object.keys(REGISTRY));
const COUNTS = Object.freeze({
  active_applications: "SELECT COUNT(*) FROM lead_requests WHERE telegram_id=? AND status IN ('pending','confirmed')",
  own_working_offers: "SELECT COUNT(*) FROM offers o JOIN offer_owners own ON own.offer_code=o.code WHERE own.owner_kind='partner' AND own.partner_profile_id=? AND o.status IN ('draft','active','paused')",
  active_campaigns: "SELECT COUNT(*) FROM ambassador_campaigns c JOIN ambassador_profiles_v2 a ON a.ambassador_id=c.ambassador_id WHERE a.partner_profile_id=? AND c.status='active'",
});
const HASH = /^[0-9a-f]{64}$/u;
const positive = value => Number.isSafeInteger(value) && value > 0;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
};
export class AtomicAdmissionError extends Error {
  constructor(code, status = 409) { super(code); this.name = 'AtomicAdmissionError'; this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new AtomicAdmissionError(code, status); };
const canonical = value => {
  if (value === null || ['string','boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  fail('invalid_intent', 400);
};
const stableJson = value => JSON.stringify(canonical(value));
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2,'0')).join('');
const serverKey = async (identity, actor, capability) => {
  const secret = identity.env.MINI_APP_IDEMPOTENCY_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || !HASH.test(actor.accountFingerprint) ||
      !HASH.test(identity.operationId) || !HASH.test(identity.payloadHash)) fail('missing_operation_binding', 403);
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),
    { name:'HMAC', hash:'SHA-256' },false,['sign']);
  const data = stableJson([ATOMIC_ADMISSION_VERSION,identity.botId,identity.telegramId,
    actor.accountFingerprint,capability,identity.operationId]);
  return 'mikey_' + Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,
    new TextEncoder().encode(data))), byte => byte.toString(16).padStart(2,'0')).join('');
};
const exactIntent = (value, required, optional = []) => {
  if (!plain(value) || required.some(key => !Object.hasOwn(value,key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('invalid_intent',400);
  // Detach the payload before the first await; later caller mutation cannot
  // change the command after the receipt hash was calculated.
  const copy = canonical(value);
  if (JSON.stringify(copy).length > 16_384) fail('invalid_intent',400);
  return freeze(copy);
};
function normalizeIntent(capability, input) {
  if (REGISTRY[capability] === 'runtime_mutation') return normalizeRuntimeMutationIntent(capability, input);
  if (REGISTRY[capability] === 'lead_submit') return exactIntent(input,['offerCode']);
  if (REGISTRY[capability] === 'lead_result') return exactIntent(input,['leadId','decision'],['rewardKopecks','reason']);
  if (REGISTRY[capability] === 'offer_create' || REGISTRY[capability] === 'campaign_transition') return exactIntent(input,[]);
  if (capability === 'offer.edit_own') return exactIntent(input,['expectedVersionId','patch']);
  return exactIntent(input,['expectedVersionId']);
}
const row = value => value?.authoritySource === 'database' ? value : databaseRow(value);
const rows = values => (values ?? []).map(row);
const oldContext = identity => Object.freeze({ contextVersion:1,authoritySource:'database_session',
  telegramId:identity.telegramId,botId:identity.botId,sessionId:identity.requestId });

function inputs(identity, actor, resource) {
  const a = actor.canonical, r = resource.canonical;
  if (!a || !r || !a.user || !Array.isArray(a.roleRows)) fail('domain_proof_missing',503);
  return { context:oldContext(identity),user:row(a.user),roleRows:rows(a.roleRows),
    partnerProfile:row(r.partnerProfile ?? a.partnerProfile),betaSettings:row(r.betaSettings ?? a.betaSettings),
    betaAccess:row(r.betaAccess ?? a.betaAccess),offer:row(r.offer),owner:row(r.owner),
    currentVersion:row(r.currentVersion),visibilityRule:row(r.visibilityRule),
    currentRoute:r.currentRoute ?? null,selectedRoute:r.selectedRoute ?? null,
    nowSeconds:identity.nowSeconds };
}
function expectedBindings(identity, resource, capability, intent, { replay = false } = {}) {
  if (resource.capability !== capability || resource.subjectTelegramId !== identity.telegramId) fail('proof_scope_mismatch',403);
  if (REGISTRY[capability] === 'lead_submit') {
    const code = resource.canonical?.eligibleOffer?.offerCode ?? resource.canonical?.existingLead?.offerCode;
    if ((!replay || code !== undefined) && intent.offerCode !== code) fail('proof_scope_mismatch',403);
  } else if (REGISTRY[capability]?.startsWith('offer_') && capability !== 'offer.create_private') {
    if (resource.ownerTelegramId !== identity.telegramId || !positive(intent.expectedVersionId) ||
        !replay && intent.expectedVersionId !== resource.version?.currentId) fail('proof_scope_mismatch',403);
  } else if (REGISTRY[capability] === 'campaign_transition' && resource.ownerTelegramId !== identity.telegramId) {
    fail('proof_scope_mismatch',403);
  } else if (REGISTRY[capability] === 'lead_result' && intent.leadId !== (resource.canonical?.lead ?? resource.canonical?.existingLead)?.id) {
    fail('proof_scope_mismatch',403);
  }
}

async function domainCommand(identity, actor, resource, capability, intent, key) {
  if (/^offer\./u.test(capability) && capability !== 'offer.archive_own' && (identity.env.PARTNER_BETA_ENABLED !== 'true' ||
      identity.env.PARTNER_PRIVATE_OFFERS_ENABLED !== 'true' || capability === 'offer.submit_moderation' &&
      identity.env.PARTNER_OFFER_SUBMISSIONS_ENABLED !== 'true')) fail('feature_unavailable',403);
  const base = { ...inputs(identity,actor,resource),idempotencyKey:key };
  const facts = resource.canonical;
  switch (REGISTRY[capability]) {
    case 'lead_submit': {
      const existing = facts.existingLead ?? facts.lead ?? null;
      if (capability === 'application.resubmit' && existing?.status !== 'rejected') fail('transition_conflict');
      if (capability === 'application.create' && existing?.status === 'rejected') fail('transition_conflict');
      return buildLeadSubmitCommand({ ...base,payload:intent,eligibleOffer:facts.eligibleOffer,
        existingLead:row(existing),existingAttribution:row(facts.existingAttribution ?? facts.attribution) });
    }
    case 'lead_result':
      return buildLeadResultCommand({ ...base,payload:intent,lead:row(facts.lead ?? facts.existingLead),
        attribution:row(facts.attribution ?? facts.existingAttribution),compatibilityConversion:row(facts.compatibilityConversion) });
    case 'offer_create':
      return buildPartnerOfferCreateCommand({ ...base,activeOfferCount:row({
        partner_profile_id:resource.partnerProfileId,active_offer_count:resource.usage.own_working_offers }),
        existingOffer:facts.offer ? {offer:base.offer,owner:base.owner,currentVersion:base.currentVersion,
          visibilityRule:base.visibilityRule} : null });
    case 'offer_submit':
      return buildPartnerOfferSubmitCommand({ ...base,expectedVersionId:intent.expectedVersionId });
    case 'offer_version': {
      if (capability === 'offer.archive_own') return archiveOfferCommand(identity,actor,resource,key);
      const status = resource.status;
      const desired = { 'offer.activate_own':'active','offer.pause_own':'paused','offer.archive_own':'archived' }[capability] ?? null;
      if (status === 'archived' || desired === 'active' && !['draft','paused'].includes(status) ||
          desired === 'paused' && status !== 'active') fail('transition_conflict');
      return buildPartnerOfferVersionCommand({ ...base,patch:capability === 'offer.edit_own' ? intent.patch : null,
        desiredBusinessStatus:desired,expectedVersionId:intent.expectedVersionId });
    }
    case 'campaign_transition': return campaignCommand(identity,actor,resource,capability,key);
    default: fail('unsupported_atomic_operation',403);
  }
}

async function archiveOfferCommand(identity, actor, resource, key) {
  const f=resource.canonical,root=row(f.offer),owner=row(f.owner),version=row(f.currentVersion),rule=row(f.visibilityRule);
  if (!root || !owner || !version || !rule || resource.ownerTelegramId!==identity.telegramId ||
      owner.ownerKind!=='partner' || owner.partnerProfileId!==resource.partnerProfileId ||
      !['draft','active','paused'].includes(root.status) || rule.moderationStatus==='pending' ||
      rule.currentVersionId!==version.id || version.offerCode!==root.code ||
      !positive(version.versionNumber) || !(actor.roles ?? []).includes('partner') ||
      (actor.roles ?? []).includes('admin')) fail('transition_conflict');
  if (await hash(version.snapshotJson)!==version.contentHash?.replace(/^sha256:/u,'')) fail('domain_proof_missing',503);
  let snapshot;try {snapshot=JSON.parse(version.snapshotJson);}catch{fail('domain_proof_missing',503);}
  if (!plain(snapshot) || snapshot.code!==root.code || snapshot.status!==root.status) fail('domain_proof_missing',503);
  const content=['button_text','title','description','provider','category','payout_text','required_action','min_age',
    'max_age','geo','hold_days','traffic_sources','source_name','starts_at','expires_at'];
  for (const field of content) {
    const camel=field.replace(/_([a-z])/gu,(_,letter)=>letter.toUpperCase());
    if (snapshot[field]!==root[camel]) fail('domain_proof_missing',503);
  }
  // Exact reduction: retain content, clear the selected route, create a new
  // immutable version and invalidate publication. No content edit is accepted.
  Object.assign(snapshot,{status:'archived',url:'',url_env_key:'',partner_link_id:null,partner_link_url:'',
    partner_link_tracking_key:'',partner_link_status:'',partner_link_ownership_confirmed:0,
    partner_link_traffic_confirmed:0,partner_link_updated_at:'',catalog_offer_id:null,catalog_offer_code:'',program_code:''});
  const snapshotJson=JSON.stringify(snapshot),contentHash='sha256:'+await hash(snapshotJson);
  const eventKey='v141_archive_'+await hash(key),next=version.versionNumber+1,now=identity.nowSeconds;
  const writes=[
    {table:'offers',action:'compare_and_swap_current_version',key:root.code,expectedVersionId:version.id,
      values:{status:'archived',url:'',urlEnvKey:'',updatedAt:now}},
    {table:'offer_versions',action:'append_next_version',values:{offerCode:root.code,versionNumber:next,
      snapshotSchemaVersion:1,snapshotJson,businessStatus:'archived',contentHash,createdBy:identity.telegramId,createdAt:now}},
    {table:'offer_visibility_rules',action:'compare_and_swap_reset_private',key:root.code,expectedCurrentVersionId:version.id,
      values:{moderationStatus:'not_submitted',visibility:'private',currentVersionId:'inserted_version_id',
        submittedVersionId:null,approvedVersionId:null,publishedAt:null,updatedBy:identity.telegramId,updatedAt:now}},
    {table:'offer_owners',action:'touch_owned_partner_offer',values:{offerCode:root.code,
      partnerProfileId:resource.partnerProfileId,updatedBy:identity.telegramId,updatedAt:now}},
  ];
  if (f.currentRoute) writes.splice(1,0,{table:'partner_offer_links',action:'delete_owned_route',values:{offerCode:root.code}});
  if (rule.moderationStatus==='approved') writes.push({table:'offer_moderation_decisions',action:'append_unique_event',
    values:{offerCode:root.code,offerVersionId:'inserted_version_id',decision:'approval_invalidated',fromStatus:'approved',
      toStatus:'not_submitted',actorId:identity.telegramId,actorRole:'partner',reason:'owner_archived_exact_version',eventKey,createdAt:now}});
  writes.push({table:'admin_audit_log',action:'append_if_version_created',values:{actorId:identity.telegramId,
    action:'partner_offer_archived',entityType:'offer',entityId:root.code,details:`version=${next};event=${eventKey}`,createdAt:now}});
  return freeze({commandVersion:1,operation:'partner_offer.create_version',offerCode:root.code,
    transactionRequired:true,writes,postcondition:{sql:`EXISTS(SELECT 1 FROM offers o JOIN offer_visibility_rules r
      ON r.offer_code=o.code JOIN offer_versions v ON v.id=r.current_version_id WHERE o.code=? AND o.status='archived'
      AND r.visibility='private' AND r.moderation_status='not_submitted' AND v.version_number=? AND v.business_status='archived')`,
      params:[root.code,next]}});
}

async function campaignCommand(identity, actor, resource, capability, key) {
  const raw = resource.canonical.campaign;
  const campaign = raw ? {...raw,campaign_id:raw.campaignId ?? raw.campaign_id,
    ambassador_id:raw.ambassadorId ?? raw.ambassador_id,scope_evidence_hash:raw.scopeEvidenceHash ?? raw.scope_evidence_hash} : null;
  if (!campaign || campaign.campaign_id !== resource.ref || !positive(campaign.revision) ||
      campaign.status === 'archived') fail('transition_conflict');
  const isAdmin = (actor.canonical.roleRows ?? []).some(role => role.role === 'admin' && role.status === 'active');
  const transitions = {
    'campaign.activate': ['draft','active','activation_approved','admin'],
    'campaign.resume': ['paused','active',isAdmin ? 'admin_resumed':'owner_resumed',isAdmin ? 'admin':'ambassador'],
    'campaign.pause': ['active','paused',isAdmin ? 'admin_paused':'owner_paused',isAdmin ? 'admin':'ambassador'],
    'campaign.archive': [campaign.status,'archived','admin_archived','admin'],
  };
  const [from,to,reason,kind] = transitions[capability];
  // The existing ledger permits draft activation/archive only for the actual
  // issuer/admin. A tariff capability cannot broaden this domain authority.
  if (from !== campaign.status || kind === 'admin' && !isAdmin) fail('campaign_issuer_required',403);
  const idHash = await hash(`${ATOMIC_ADMISSION_VERSION}\n${capability}\n${key}`);
  const transitionId = `${idHash.slice(0,8)}-${idHash.slice(8,12)}-4${idHash.slice(13,16)}-a${idHash.slice(17,20)}-${idHash.slice(20,32)}`;
  let transition;
  // Reuse the actual existing domain validator/evidence algorithm with a
  // private planning store. It can produce one canonical row but performs no
  // database effect outside the admission batch. No callback is caller supplied.
  await transitionAmbassadorCampaign({config:readAnalyticsV2Config(identity.env),
    store:{getCampaign:async()=>campaign,getCampaignTransition:async()=>null,
      writeCampaignTransition:async value=>{transition=value;return {outcome:'planned'};}},
    transitionId,campaignId:campaign.campaign_id,expectedRevision:campaign.revision,
    fromStatus:from,toStatus:to,reasonCode:reason,actorKind:kind,
    evidenceIdentity:`v1.4.1.atomic:${identity.operationId}`,occurredAt:identity.nowSeconds,
    pseudonymSecret:identity.env.ANALYTICS_SUBJECT_PSEUDONYM_SECRET});
  if (!transition) fail('domain_proof_missing',503);
  return freeze({ operation:capability,writes:[{
    sql:`INSERT INTO ambassador_campaign_transitions
      (transition_id,transition_key,campaign_id,campaign_revision,from_status,to_status,
       reason_code,actor_kind,evidence_hash,occurred_at,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ambassador_campaigns
        WHERE campaign_id=? AND ambassador_id=? AND revision=? AND status=?)`,
    params:[transition.transition_id,transition.transition_key,campaign.campaign_id,campaign.revision+1,from,to,reason,kind,
      transition.evidence_hash,identity.nowSeconds,identity.nowSeconds,campaign.campaign_id,
      campaign.ambassador_id,campaign.revision,from],minChanges:1,maxChanges:1,
  }],compiled:true,campaignId:campaign.campaign_id,
    postcondition:{sql:'EXISTS(SELECT 1 FROM ambassador_campaigns WHERE campaign_id=? AND revision=? AND status=?)',
      params:[campaign.campaign_id,campaign.revision+1,to]} });
}

function deltaFor(resource, capability, command) {
  if (!command.writes.length) return 0;
  if (['application.create','application.resubmit','offer.create_private','campaign.activate','campaign.resume'].includes(capability)) return 1;
  if (capability === 'offer.archive_own') return resource.status === 'archived' ? 0 : -1;
  if (capability === 'campaign.pause') return -1;
  if (capability === 'campaign.archive') return resource.status === 'active' ? -1 : 0;
  return 0;
}
function quotaAssertion(identity, resource, decision, capability, command) {
  const definition = definitions.get(capability);
  const quotaKey = definition.quota_key ?? definition.quota_observe_key;
  if (!quotaKey) return null;
  const delta = deltaFor(resource,capability,command);
  if (!Number.isSafeInteger(decision.quotaLimit) || decision.quotaLimit < 0 ||
      decision.quotaDelta !== delta || !Number.isSafeInteger(resource.usage?.[quotaKey])) fail('quota_proof_mismatch',503);
  const scope = quotaKey === 'active_applications' ? identity.telegramId : resource.partnerProfileId;
  if (!positive(scope)) fail('quota_scope_mismatch',403);
  const usage = resource.usage[quotaKey], params = [scope,usage];
  let sql = `(${COUNTS[quotaKey]}) = ?`;
  const reducing = definition.overcap_action_policy === 'allow_fixed_reduction_with_domain_guards';
  if (!reducing && command.writes.length) { sql += ` AND ? + ? <= ?`;params.push(usage,Math.max(0,delta),decision.quotaLimit); }
  if (capability === 'offer.create_private' && command.writes.length) {
    const beta = resource.canonical.betaSettings ?? resource.canonical.actor?.betaSettings;
    const betaLimit = beta?.max_active_offers_per_partner ?? beta?.maxActiveOffersPerPartner;
    if (!positive(betaLimit)) fail('beta_proof_missing',503);
    sql += ' AND ? + 1 <= ?';params.push(usage,betaLimit);
  }
  return {sql,params};
}

const statement = (db, sql, params=[]) => {
  if (!Array.isArray(params) || params.length > 100 || new TextEncoder().encode(sql).length > 100_000) fail('admission_unavailable',503);
  return db.prepare(sql).bind(...params);
};
const assertWrite = (db,key,min=1,max=1) => statement(db,
  'INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN changes() BETWEEN ? AND ? THEN 1 ELSE 0 END)',[key,min,max]);
const predicate = (db,key,proof) => {
  if (!proof || typeof proof.sql !== 'string' || !Array.isArray(proof.params)) fail('admission_unavailable',503);
  return statement(db,`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN (${proof.sql}) THEN 1 ELSE 0 END)`,[key,...proof.params]);
};
const resultRows = value => Array.isArray(value?.results) ? value.results : [];
const replayIdentity = identity => ({
  sql:`EXISTS(SELECT 1 FROM users WHERE telegram_id=? AND accepted_terms=1 AND is_blocked=0)
    AND EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=? AND role='user' AND status='active')
    AND NOT EXISTS(SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending'
      AND (unixepoch(expires_at) IS NULL OR unixepoch(expires_at)>unixepoch()))`,
  params:[identity.telegramId,identity.telegramId,identity.telegramId],
});
function receiptAck(receipt, expected) {
  if (!receipt || receipt.request_hash !== expected.hash || receipt.bot_id !== expected.identity.botId ||
      receipt.actor_telegram_id !== expected.identity.telegramId || receipt.operation !== expected.capability) fail('idempotency_conflict');
  let ack;try { ack=JSON.parse(receipt.response_json); } catch { fail('admission_unavailable',503); }
  if (!['committed','unchanged'].includes(ack?.commitStatus) || ack.capability !== expected.capability) fail('admission_unavailable',503);
  return freeze({...ack,commitStatus:'unchanged'});
}
function replayScope(identity, actor, resource, capability, receipt, intent) {
  // Only current ownership is relevant to acknowledging an already durable
  // effect. Do not compare the pre-effect status/version/count or entitlement.
  if (/^application\./u.test(capability)) return {
    sql:'EXISTS(SELECT 1 FROM lead_requests WHERE telegram_id=? AND offer_code=?)',params:[identity.telegramId,intent.offerCode] };
  if (/^offer\./u.test(capability)) {
    const ack=JSON.parse(receipt.response_json);
    return {sql:`EXISTS(SELECT 1 FROM offer_owners o JOIN partner_profiles p ON p.id=o.partner_profile_id
      WHERE o.offer_code=? AND o.owner_kind='partner' AND p.telegram_id=?)`,params:[ack.offerCode ?? resource.ref,identity.telegramId]};
  }
  if (/^campaign\./u.test(capability)) return {sql:`EXISTS(SELECT 1 FROM ambassador_campaigns c
    JOIN ambassador_profiles_v2 a ON a.ambassador_id=c.ambassador_id JOIN partner_profiles p ON p.id=a.partner_profile_id
    WHERE c.campaign_id=? AND p.telegram_id=?)`,params:[resource.ref,identity.telegramId]};
  if (capability === 'admin.application.result') {
    // A foreign-subject receipt stays restricted to the currently configured
    // canonical owner, even if an old admin role still exists in D1.
    if (actor.canonicalOwner !== true) fail('replay_scope_conflict',403);
    return {sql:`EXISTS(SELECT 1 FROM user_roles
    WHERE telegram_id=? AND role='admin' AND status='active') AND EXISTS(SELECT 1 FROM lead_requests WHERE id=?)`,
    params:[identity.telegramId,(resource.canonical.lead ?? resource.canonical.existingLead).id]};
  }
  fail('unsupported_atomic_operation',403);
}

export function createAtomicAdmission() {
  return Object.freeze({
    version:ATOMIC_ADMISSION_VERSION,runtimeWired:false,
    async admit(input={}) {
      if (!plain(input) || Object.keys(input).some(key=>!['decision','intent'].includes(key))) fail('invalid_admission_input',400);
      const {decision,intent} = input;
      if (!isTrustedDecision(decision)) fail('untrusted_decision',403);
      const facts=readDecisionFacts(decision), context=readDecisionContext(decision);
      if (!isTrustedContext(context) || !isTrustedActor(facts.actor) || !isTrustedResource(facts.resource) ||
          readActorContext(facts.actor) !== context || readResourceContext(facts.resource) !== context) fail('proof_context_mismatch',403);
      const identity=readTrustedContext(context), actor=readActorFacts(facts.actor), resource=readResourceFacts(facts.resource);
      const capability=facts.capability;
      if (identity.actorKind !== 'customer' || !REGISTRY[capability] || facts.operation !== identity.operation) fail('unsupported_atomic_operation',403);
      const payload=normalizeIntent(capability,intent ?? identity.requestPayload);
      if (await hash(stableJson(payload)) !== identity.payloadHash) fail('intent_operation_mismatch',403);
      expectedBindings(identity,resource,capability,payload,{replay:true});
      const key=await serverKey(identity,actor,capability);
      const target=resource.canonical.targetUser;
      const targetGeneration=capability==='admin.offer.assign'
        ? await accountGenerationFingerprint(target&&{telegram_id:target.telegram_id??target.telegramId,
          joined_at:target.joined_at??target.joinedAt,referral_code:target.referral_code??target.referralCode}) : null;
      if(capability==='admin.offer.assign'&&!HASH.test(targetGeneration??'')) fail('replay_scope_conflict',403);
      const requestHash=await hash(stableJson({capability,kind:REGISTRY[capability]==='lead_submit'?'application_offer':resource.kind,
        ref:REGISTRY[capability]==='lead_submit'?payload.offerCode:resource.ref,intent:payload,
        ...(capability==='admin.offer.assign'?{targetGeneration}:{})}));
      const expected={hash:requestHash,identity,capability};
      const db=identity.db;
      const findReceipt=()=>statement(db,'SELECT * FROM mini_app_command_receipts WHERE idempotency_key=?',[key]).first();
      const prior=await findReceipt();
      if (prior) {
        const ack=receiptAck(prior,expected), source=compileAuthorityReplayAssertions(facts.actor);
        const replay=[compileContextAssertions(context),...(source.assertions ?? [source]),
          replayIdentity(identity),REGISTRY[capability] === 'runtime_mutation'
            ? await compileRuntimeMutationReplayScope(decision)
            : replayScope(identity,actor,resource,capability,prior,payload)];
        const checked=await db.batch(replay.map(proof=>statement(db,`SELECT CASE WHEN (${proof.sql}) THEN 1 ELSE 0 END AS valid`,proof.params)));
        if (checked.some(result=>result?.success !== true || resultRows(result)[0]?.valid !== 1)) fail('replay_scope_conflict');
        return ack;
      }
      if (facts.publicDTO?.allowed !== true) fail(facts.publicDTO?.reasonCode ?? 'capability_denied',403);
      expectedBindings(identity,resource,capability,payload);
      const command=REGISTRY[capability] === 'runtime_mutation'
        ? readRuntimeMutation(await createRuntimeMutation(decision,key))
        : await domainCommand(identity,actor,resource,capability,payload,key);
      if (REGISTRY[capability] === 'runtime_mutation' && (command.context !== context ||
          command.capability !== capability || command.operation !== identity.operation ||
          command.compiled !== true || command.quotaDelta !== 0)) fail('proof_context_mismatch',403);
      const writes=command.compiled ? command.writes : compileCabinetCommand(command);
      const approved=compileDecisionAssertions(decision);
      const proofs=approved.assertions ?? [approved];
      const quota=quotaAssertion(identity,resource,facts,capability,command);
      const guards=[], batch=[];
      const addGuard=proof=>{const guardKey=`${key}:g${guards.length}`;guards.push(guardKey);batch.push(predicate(db,guardKey,proof));};
      const addWrite=write=>{batch.push(statement(db,write.sql,write.params));const guardKey=`${key}:g${guards.length}`;
        guards.push(guardKey);batch.push(assertWrite(db,guardKey,write.minChanges,write.maxChanges));};
      const ack=freeze({commitStatus:writes.length?'committed':'unchanged',capability,
        ...(command.ack ?? {}),
        ...(command.offerCode ? {offerCode:command.offerCode}:{}),
        ...(command.campaignId ? {campaignId:command.campaignId}:{}),
        ...(typeof command.leadId === 'number' ? {leadId:command.leadId}:{})});
      const contextProof=compileContextAssertions(context);
      // The receipt, all guards, canonical effects and mandatory ledgers share
      // one batch; zero rows are converted to CHECK failures immediately.
      addWrite({sql:`INSERT INTO mini_app_command_receipts
        (idempotency_key,request_hash,bot_id,actor_telegram_id,operation,commit_status,response_json,committed_at,precondition_ok)
        VALUES(?,?,?,?,?,?,?,unixepoch(),CASE WHEN (${contextProof.sql}) THEN 1 ELSE 0 END)`,
        params:[key,requestHash,identity.botId,identity.telegramId,capability,ack.commitStatus,JSON.stringify(ack),...contextProof.params],minChanges:1,maxChanges:1});
      for (const proof of proofs) addGuard(proof);
      addGuard({sql:'unixepoch() < ?',params:[facts.validUntil]});
      if (quota) addGuard(quota);
      for (const write of writes) addWrite(write);
      if (command.postcondition) addGuard(command.postcondition);
      for (const postcondition of command.postconditions ?? []) addGuard(postcondition);
      const eventKey=await hash(`${ATOMIC_ADMISSION_VERSION}\n${key}\n${requestHash}`);
      addWrite({sql:`INSERT INTO entitlement_decision_audit
        (audit_id,event_key,policy_version,capability,actor_kind,subject_telegram_id,actor_telegram_id,
         resource_ref,decision,reason_code,source_fingerprint,operation_ref,evaluated_at,valid_until,retention_until)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,params:[`v141_${eventKey}`,eventKey,FOUNDATION_POLICY_VERSION,capability,
          'customer',REGISTRY[capability]==='lead_result'?(resource.canonical.lead ?? resource.canonical.existingLead).telegramId:
            (command.subjectTelegramId ?? resource.subjectTelegramId),
          identity.telegramId,`${resource.kind}:${resource.ref}`,'allow',
          writes.length?'atomic_admission_committed':'atomic_admission_unchanged',actor.sourceFingerprint,key,facts.evaluatedAt,facts.validUntil,null],minChanges:1,maxChanges:1});
      for (const effect of command.postCommitEffects ?? []) {
        if (!['notification','analytics_adapter'].includes(effect.kind)) fail('domain_effect_invalid',503);
        const lead=command.writes.find(write=>write.table==='lead_requests')?.values;
        const inserted=effect.leadId==='inserted_lead_id';
        const effectPayload={...effect,recipientTelegramId:effect.recipient==='subject'?identity.telegramId:effect.recipientTelegramId};
        delete effectPayload.recipient;
        addWrite({sql:`INSERT INTO mini_app_effect_outbox(dedupe_key,command_key,effect_kind,payload_json,created_at)
          VALUES(?,?,?,json_set(?,'$.leadId',${inserted?'(SELECT id FROM lead_requests WHERE telegram_id=? AND offer_code=?)':'?'}),unixepoch())`,
          params:[effect.dedupeKey,key,effect.kind,JSON.stringify(effectPayload),...(inserted?[lead.telegramId,lead.offerCode]:[effect.leadId])],minChanges:1,maxChanges:1});
      }
      batch.push(statement(db,`DELETE FROM mini_app_atomic_guards WHERE guard_key IN (${guards.map(()=>'?').join(',')})`,guards));
      batch.push(statement(db,'SELECT * FROM mini_app_command_receipts WHERE idempotency_key=?',[key]));
      if (batch.length>96) fail('admission_query_budget_exhausted',503);
      let committed;
      try { committed=await db.batch(batch); }
      catch(error) {
        // A receipt may have committed in a racing request or a lost-response
        // batch. Never acknowledge under old proof: demand a fresh resolution.
        const winner=await findReceipt();
        if (winner) {receiptAck(winner,expected);fail('receipt_race');}
        if (/CHECK constraint failed|UNIQUE constraint failed|requires exact transition/u.test(String(error?.message))) fail('state_conflict');
        fail('admission_outcome_unknown',503);
      }
      if (committed.some(result=>result?.success!==true) || resultRows(committed.at(-1)).length!==1) fail('admission_outcome_unknown',503);
      const receipt=resultRows(committed.at(-1))[0];receiptAck(receipt,expected);
      return ack;
    },
  });
}
