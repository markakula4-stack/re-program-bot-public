import { CAPABILITY_DEFINITIONS, CAPABILITY_CATALOG, PLAN_CAPABILITIES, FOUNDATION_POLICY_VERSION,
  FIXED_OPERATION_ALIASES, AUDIT_NAME_ALIASES } from './capability-policy.mjs';
import { projectPublicPartnerOffer } from '../v1.4.0-rebuild/offer-lifecycle.mjs';
import { databaseRow, databaseSeconds } from '../v1.4.0-rebuild/d1-cabinet-repository.mjs';
import { readTrustedContext } from './trusted-context.mjs';
import { readActorFacts, readActorContext } from './authority-resolver.mjs';
import { loadAiQuotaFacts, compileAiQuotaFactsAssertions } from './ai-quota-settlement.mjs';
import { readAnalyticsV2Config } from '../v1.3.9/analytics-foundation.mjs';
import { readStarsCoreConfig, selectServerPrice, STARS_MONTH_SECONDS } from '../v1.3.6/stars-core-foundation.mjs';
import { readStarsRecurringConfig } from '../v1.4.3/recurring-provider-config.mjs';
import { readStarsOperationsConfig } from '../v1.3.6/stars-access-runtime.mjs';
import { readPackageSettlementSource, readReservedMonthlyRetainedSettlementSource } from '../v1.4.4/package-settlement-runtime.mjs';
import { readPackageRetainedReview } from '../v1.4.4/package-payment-runtime.mjs';
import { inspectPackagePaymentReviewSchema, packagePaymentReviewSchemaAssertion } from '../v1.4.4/package-schema.mjs';
import { readReferralRewardConfig } from '../v1.3.7/referral-reward-foundation.mjs';
import { resolveLegacyAccessSources, readLegacyAccessSourceFacts, readLegacyAccessSourceContext,
  compileLegacyAccessSourceAssertions } from './legacy-access-sources.mjs';
import { takeVerifiedEmptyCabinetCatalog } from './cabinet-empty-catalog.mjs';
import { AI_PUBLIC_SOURCE_READINESS_SQL, AI_PUBLIC_SOURCE_READINESS_PREDICATE,
  projectPublicAiEnablement } from './ai-rollout-readiness.mjs';

// Request-local canonical resource facts. No transport route invokes this
// module until Part4; snapshots are neither a decision nor a client response.
export const RESOURCE_RESOLVER_VERSION = '2026-10-02.v1.4.1.p03';
const definitions = new Map(CAPABILITY_DEFINITIONS.map(row => [row.capability, row]));
const proofs = new WeakMap();
const contexts = new WeakMap();
const factsByResource = new WeakMap();
const replayProofs = new WeakMap();
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
export class ResourceResolverError extends Error {
  constructor(code) { super(code); this.name = 'ResourceResolverError'; this.code = code; }
}
const fail = code => { throw new ResourceResolverError(code); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const token = value => typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/u.test(value);
const ownCapabilities = new Set(CAPABILITY_DEFINITIONS.filter(row =>
  !/^(offer\.|application\.|campaign\.|admin\.|service\.|crm\.|team\.)/u.test(row.capability) &&
  !['partner.legal_declare_own', 'partner.link.manage_own', 'notification.manage_own',
    'ai.partner_draft.read', 'ai.partner_draft.edit', 'ai.partner_draft.prepare_share'].includes(row.capability)
).map(row => row.capability));
const adminTargetPlans = freeze({
  'admin.partner.review':['partner_application','partner_applications','id'],
  'admin.partner.repair':['partner_application','partner_applications','id'],
  'admin.partner.beta.manage':['partner_profile','partner_profiles','id'],
  'admin.partner_link.review':['partner_link','partner_links','id'],
  'admin.application.result':['application','lead_requests','id'],
  'admin.result.repair':['application','lead_requests','id'],
  'admin.user.moderation':['user','users','telegram_id'],
  'admin.stars.refund':['payment','subscription_orders','order_id'],
});
const adminSurfaces = freeze({
  'admin.cabinet.open':'cabinet', 'admin.analytics.read':'analytics',
  'admin.broadcast.send':'broadcast', 'admin.settings.manage':'settings',
  'admin.stars.reconcile':'stars_reconciliation',
});
const servicePlans = freeze({
  'service.preview.expire':['trial_grant','trial_grants','grant_id','preview_expiry'],
  'service.stars.reconcile':['reconciliation_run','payment_reconciliation_runs','run_id','Stars_reconciliation'],
  'service.stars.expire':['subscription','subscriptions','subscription_id','Stars_expiry'],
  'service.stars.process_event':['payment_event','payment_events','event_id','Stars_payment_event'],
  'service.referral.settle':['referral_reward','referral_rewards','reward_id','referral_settlement'],
  'service.privacy.cleanup':['retention_trial_grant','trial_grants','grant_id','privacy_retention'],
  'service.notification.deliver_historical':['notification_job','notification_jobs','job_key','historical_notification'],
  'service.outbox.drain':['effect_outbox','mini_app_effect_outbox','dedupe_key','outbox_drain'],
  'service.analytics.ingest':['ingestion_receipt','analytics_ingestion_receipts','receipt_id','analytics_ingestion'],
  'service.ai.settle_cost':['ai_budget_reservation','ai_gateway_budget_reservations','request_id','AI_incurred_cost_settlement'],
});

export const RESOURCE_QUOTA_PREDICATES = freeze({
  active_applications: "SELECT COUNT(*) AS n FROM lead_requests WHERE telegram_id=? AND status IN ('pending','confirmed')",
  own_working_offers: "SELECT COUNT(*) AS n FROM offers o JOIN offer_owners own ON own.offer_code=o.code WHERE own.owner_kind='partner' AND own.partner_profile_id=? AND o.status IN ('draft','active','paused')",
  active_campaigns: "SELECT COUNT(*) AS n FROM ambassador_campaigns c JOIN ambassador_profiles_v2 a ON a.ambassador_id=c.ambassador_id WHERE a.partner_profile_id=? AND c.status='active'",
});

// Fixed columns only. Sensitive content is used internally for snapshot
// verification and is never included in the minimal resource DTO.
const columns = freeze({
  users: ['telegram_id','inviter_id','inviter_bound_at','referral_code','accepted_terms','is_blocked','joined_at'],
  user_roles: ['telegram_id','role','status','assigned_by','assigned_at','updated_at'],
  partner_profiles: ['id','telegram_id','application_id','display_name','telegram_username','contact','status','approved_by','approved_at','updated_at'],
  partner_applications: ['id','telegram_id','display_name','telegram_username','contact','age_confirmed','status','rejection_reason','reviewed_by','submitted_at','reviewed_at','updated_at'],
  partner_public_settings: ['telegram_id','public_username_enabled','updated_at'],
  admin_sessions: ['telegram_id','action','step','offer_code','payload_json','updated_at'],
  partner_sessions: ['telegram_id','action','step','payload_json','updated_at'],
  admin_broadcasts: ['id','actor_id','message_text','status','recipient_count','delivered_count','failed_count','created_at','confirmed_at','completed_at'],
  admin_broadcast_release_gate: ['id','paused','updated_at'],
  admin_safety_runtime_settings: ['id','moderation_enabled','admin_ai_chat_enabled','deepseek_chat_enabled','updated_at'],
  admin_moderation_sessions: ['admin_telegram_id','step','target_telegram_id','reason','expires_at','created_at','updated_at'],
  user_moderation_blocks: ['target_telegram_id','status','reason','blocked_by','blocked_at','unblocked_by','unblocked_at','revision'],
  ai_runtime_settings: ['id','rollout_mode','model_name','updated_by','updated_at'],
  official_web_settings: ['id','enabled','admin_only','stale_enabled','window_limit','daily_limit','updated_by','updated_at'],
  official_sources: ['id','source_key','scheme','hostname_ascii','source_type','status','updated_at'],
  ai_source_snapshots: ['id','program_code','source_url','content_hash','status','fetched_at','reviewed_at','reviewed_by'],
  offers: ['code','button_text','title','description','provider','category','url','url_env_key','payout_text','required_action','min_age','max_age','geo','hold_days','traffic_sources','source_name','starts_at','expires_at','status','sort_order','created_at','updated_at'],
  offer_owners: ['offer_code','owner_kind','partner_profile_id','created_by','created_at','updated_by','updated_at'],
  offer_visibility_rules: ['offer_code','moderation_status','visibility','current_version_id','submitted_version_id','approved_version_id','published_at','updated_by','updated_at'],
  offer_versions: ['id','offer_code','version_number','snapshot_schema_version','snapshot_json','business_status','content_hash','created_by','created_at'],
  offer_visibility_assignments: ['offer_code','telegram_id','assignment_status','assigned_by','assigned_at','revoked_by','revoked_at','updated_at'],
  partner_offer_links: ['offer_code','partner_link_id','updated_at'],
  partner_links: ['id','partner_profile_id','catalog_offer_id','url','tracking_key','ownership_confirmed','traffic_confirmed','status','updated_at'],
  program_offers: ['id','program_code','offer_code','status','updated_at'],
  partner_programs: ['code','allowed_domains','status','official_url','updated_at'],
  partner_beta_settings: ['id','enabled','private_offers_enabled','submissions_enabled','public_visibility_enabled','max_active_offers_per_partner','updated_at'],
  partner_beta_access: ['partner_profile_id','access_status','can_create_private_offers','can_submit_offers','granted_by','granted_at','expires_at','reason','status_changed_by','status_changed_at','updated_at'],
  lead_requests: ['id','telegram_id','inviter_id','offer_code','status','reward_kopecks','rejection_reason','reviewed_by','created_at','updated_at','reviewed_at'],
  lead_partner_attribution: ['lead_id','partner_link_id','partner_profile_id','program_code','attributed_at'],
  conversions: ['id','telegram_id','inviter_id','offer_code','status','reward_kopecks','created_at','updated_at'],
  ambassador_profiles_v2: ['ambassador_id','partner_profile_id','status','revision','updated_at'],
  ambassador_campaigns: ['campaign_id','ambassador_id','scope_kind','program_code','catalog_offer_id','status','scope_evidence_hash','starts_at','ends_at','revision','updated_at'],
  ambassador_profile_transitions: ['transition_id','ambassador_id','profile_revision','from_status','to_status','reason_code','actor_kind','evidence_hash','occurred_at'],
  ambassador_campaign_transitions: ['transition_id','campaign_id','campaign_revision','from_status','to_status','reason_code','actor_kind','evidence_hash','occurred_at'],
  analytics_v2_settings: ['id','rollout_mode','master_enabled','ingest_enabled','projections_enabled','ambassador_enabled','updated_at'],
  analytics_v139_owner_runtime: ['id','audience_mode','enabled','updated_at'],
  analytics_v139_partner_pilot: ['telegram_id','enabled','admitted_at','expires_at'],
  notifications: ['id','recipient_id','event_type','message_html','action_label','action_callback','is_read','archived_at','created_at'],
  notification_settings: ['telegram_id','telegram_enabled','updated_at'],
  subscription_orders: ['order_id','telegram_id','price_id','price_version','plan_code','currency','amount_stars','access_seconds','billing_mode','terms_revision','order_state','state_revision','created_at','expires_at','paid_at','applied_at','updated_at'],
  price_book: ['price_id','price_version','plan_code','currency','amount_stars','access_seconds','billing_mode','publication_state','terms_revision','valid_from','valid_until'],
  terms_acceptances: ['acceptance_id','telegram_id','terms_revision','acceptance_scope','evidence_sha256','telegram_update_id','accepted_at'],
  payment_ledger: ['ledger_entry_id','order_id','telegram_id','entry_type','direction','currency','amount_stars','telegram_payment_charge_id','related_ledger_entry_id','occurred_at'],
  payment_refunds: ['refund_id','order_id','original_ledger_entry_id','telegram_id','telegram_payment_charge_id','currency','amount_stars','reason_code','requested_by_type','requested_by','status','requested_at','updated_at'],
  ai_drafts: ['draft_id','owner_telegram_id','draft_state','current_version_no','deleted_at','updated_at'],
  trial_grants: ['grant_id','telegram_id','subject_fingerprint','program_code','source_code','status','started_at','ends_at','retention_until','workflow_state','ended_at','anonymized_at','updated_at'],
  subscriptions: ['subscription_id','telegram_id','plan_code','source_order_id','status','current_period_start','current_period_end','revision','updated_at'],
  payment_reconciliation_runs: ['run_id','run_source','initiated_by','status','started_at','finished_at','updated_at'],
  payment_events: ['event_id','event_key','order_id','telegram_id','telegram_update_id','event_type','outcome','reason_code','occurred_at','received_at'],
  referral_rewards: ['reward_id','reward_key','candidate_id','program_code','beneficiary_telegram_id','buyer_telegram_id','reward_status','confirm_after','confirmed_at','revision','updated_at'],
  notification_jobs: ['job_key','telegram_id','related_grant_id','job_type','status','scheduled_for','attempt_count','updated_at'],
  mini_app_effect_outbox: ['dedupe_key','command_key','effect_kind','payload_json','status','created_at','delivered_at'],
  mini_app_effect_claims: ['dedupe_key','claim_token','notification_id','delivery_state','recipient_telegram_id','attempted_at','next_attempt_at','error_code'],
  mini_app_command_receipts: ['idempotency_key','request_hash','bot_id','actor_telegram_id','operation','commit_status','committed_at'],
  analytics_ingestion_receipts: ['receipt_id','batch_fingerprint','source_kind','origin','status','started_at','finished_at','retention_until'],
  ai_gateway_budget_reservations: ['request_id','owner_telegram_id','usage_date','reservation_state','reserved_cost_microusd','policy_version','created_at','completed_at'],
  ai_operation_journal: ['request_id','namespace','subject_telegram_id','account_generation_hash','usage_date','bucket','admitted_at','expires_at',
    'user_cycle_start_at','user_cycle_end_at','global_cycle_start_at','global_cycle_end_at','reserved_milli','reserved_billed_tokens','reserved_cost_microusd',
    'policy_version','pricing_version','policy_json','policy_hash','primary_model_alias','generation_id','state','settlement_kind','attempted_count',
    'active_attempt_no','active_attempt_id','active_route_step','active_model_alias','active_started_at','provider_started_at','terminal_at','terminal_reason','revision','updated_at','retention_until'],
  ai_operation_receipts: ['request_id','attempt_no','attempt_id','route_step','model_alias','provider_code','attempt_status','input_tokens','cached_input_tokens','output_tokens',
    'cost_microusd','neurons_milli','latency_ms','status_code','error_code','receipt_hash','expense_location','created_at','applied_at'],
  privacy_deletion_requests: ['request_id','telegram_id','status','expires_at'],
  capability_catalog: ['policy_version','capability','actor_kind','resource_scope','availability','future_release','quota_key','definition_json','definition_sha256'],
  plan_capabilities: ['policy_version','plan_code','access_overlay','capability','allowed','quota_key','limit_value','quota_unit','quota_window','rule_json','definition_sha256'],
});
const jsonExpression = names => {
  let expression="'{}'";
  for(let offset=0;offset<names.length;offset+=10) {
    expression=`json_set(${expression},${names.slice(offset,offset+10).map(name=>`'$.${name}',${name}`).join(',')})`;
  }
  return expression;
};
const sha256 = async text => {
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2,'0')).join('');
};
const validWindow = (offer, now) => {
  const start = databaseSeconds(offer.starts_at), end = databaseSeconds(offer.expires_at);
  return !(offer.starts_at != null && start === null || offer.expires_at != null && end === null) &&
    (start === null || start <= now) && (end === null || end > now);
};
const coherentSystemVersion = (root, version, hashValid) => {
  try {
    const snapshot=JSON.parse(version?.snapshot_json ?? 'null');
    return Boolean(hashValid && snapshot && columns.offers.filter(key=>!['sort_order','created_at','updated_at'].includes(key))
      .every(key=>Object.hasOwn(snapshot,key) && snapshot[key]===root[key]));
  } catch {return false;}
};
const allowedUrl = (value, allowedDomains) => {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' ||
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u.test(hostname) ||
        /(?:^|\.)(?:localhost|local|internal)$/u.test(hostname) || hostname.endsWith('.home.arpa')) return false;
    return String(allowedDomains ?? '').split(/[\s,;]+/u).map(domain => domain.toLowerCase().replace(/^\*\./u,''))
      .filter(domain => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain))
      .some(domain => hostname === domain || hostname.endsWith('.' + domain));
  } catch { return false; }
};

// Same fixed rollout grammar/bucket as the released Stars entrypoint. Keeping
// this read-only projection here avoids importing the full Worker graph.
const starsRolloutEligible = async (env, subject, ready) => {
  if(!ready)return false;
  const mode=String(env.STARS_ROLLOUT_MODE||'off').trim().toLowerCase();
  const admin=Number(env.ADMIN_ID),allowlist=String(env.STARS_ROLLOUT_ALLOWLIST||'')
    .split(/[\s,;]+/u).map(Number).filter(positive).slice(0,500);
  if(mode==='all')return true;
  if(mode==='admin')return positive(admin)&&admin===subject;
  if(mode==='allowlist')return admin===subject||allowlist.includes(subject);
  if(mode!=='percent')return false;
  const percent=Number(env.STARS_ROLLOUT_PERCENT||0);
  if(!Number.isSafeInteger(percent)||percent<1||percent>100)return false;
  if(admin===subject||allowlist.includes(subject))return true;
  const secret=String(env.STARS_ROLLOUT_SECRET||'');if(secret.length<32)return false;
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${secret}\n${subject}`)));
  const bucket=((((bytes[0]<<24)>>>0)+(bytes[1]<<16)+(bytes[2]<<8)+bytes[3])>>>0)%100;
  return bucket<percent;
};
const catalogFields=new Set(['button_text','title','description','provider','category','url','url_env_key','payout_text',
  'required_action','min_age','max_age','geo','hold_days','traffic_sources','source_name','starts_at','expires_at','sort_order','status']);
const catalogCode=value=>typeof value==='string'&&/^[a-z0-9_-]{3,24}$/u.test(value);
const httpsUrl=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&value.length<=1000;}catch{return false;}};

export function createResourceResolver({ queryLimit = 24 } = {}) {
  if (!Number.isSafeInteger(queryLimit) || queryLimit < 1 || queryLimit > 40) fail('resource_unavailable');
  return freeze({
    version: RESOURCE_RESOLVER_VERSION,
    async resolve(context, actor, ref = null) {
      const trusted = readTrustedContext(context);
      const actorFacts = readActorFacts(actor);
      if (readActorContext(actor) !== context) fail('untrusted_actor');
      const { db, nowSeconds, requestId, operation } = trusted;
      const capability = FIXED_OPERATION_ALIASES[operation] ?? AUDIT_NAME_ALIASES[operation] ?? operation;
      const subject = trusted.telegramId;
      if (!db?.prepare || trusted.actorKind==='customer' && !positive(subject) ||
          !['customer','service'].includes(trusted.actorKind)) fail('untrusted_actor');
      let queryCount = 0,sourceBytes=0;
      const read = async (sql, params, maxRows = 1,maxBytes=64_000) => {
        if (++queryCount > queryLimit) fail('resource_query_budget_exhausted');
        let result;
        try { result = await db.prepare(sql).bind(...params).all(); } catch { fail('resource_unavailable'); }
        const bytes=JSON.stringify(result?.results ?? []).length;
        sourceBytes+=bytes;
        if (result?.success !== true || !Array.isArray(result.results) || result.results.length > maxRows ||
            bytes>maxBytes || sourceBytes>1_000_000) fail('resource_unavailable');
        return result.results;
      };
      const definition = definitions.get(capability);
      if (!definition) fail('invalid_resource_operation');
      if (ref !== null && (!ref || typeof ref !== 'object' || Array.isArray(ref) ||
          Object.keys(ref).some(key => !['kind','key'].includes(key)) ||
          !token(ref.kind) || !(positive(ref.key) || token(ref.key)))) fail('invalid_resource_reference');
      const checks = [];
      const deadlines = [nowSeconds + 60];
      const cachedRows=new Map();
      const cacheKey=(table,where,params)=>JSON.stringify([table,where,params]);
      const load = async (table, where, params) => {
        const cached=cacheKey(table,where,params);
        if(cachedRows.has(cached)) return cachedRows.get(cached);
        const sql = `SELECT ${jsonExpression(columns[table])} AS snapshot FROM ${table} WHERE ${where} LIMIT 2`;
        const rows = await read(sql, params);
        const value = rows[0]?.snapshot ?? null;
        if (value !== null && typeof value !== 'string') fail('resource_unavailable');
        checks.push({ sql: `(${sql}) IS ?`, params: [...params,value] });
        const parsed=value===null?null:JSON.parse(value);
        cachedRows.set(cached,parsed);return parsed;
      };
      const bulk=async(table,field,keys,{extraWhere='',extraParams=[]}={})=>{
        const unique=[...new Set(keys)].sort((a,b)=>String(a).localeCompare(String(b)));
        if(!unique.length) return [];
        if(unique.length>50 || !columns[table].includes(field)) fail('resource_unavailable');
        const where=`${field} IN (${unique.map(()=>'?').join(',')})${extraWhere}`;
        const params=[...unique,...extraParams];
        const sql=`SELECT COALESCE(json_group_array(json(snapshot)),'[]') FROM (SELECT ${jsonExpression(columns[table])} AS snapshot FROM ${table} WHERE ${where} ORDER BY ${field} LIMIT 51)`;
        const value=Object.values((await read(sql,params,1,262_144))[0]??{})[0];
        if(typeof value!=='string') fail('resource_unavailable');
        let rows;try{rows=JSON.parse(value);}catch{fail('resource_unavailable');}
        if(!Array.isArray(rows) || rows.length>50) fail('resource_unavailable');
        checks.push({sql:`(${sql}) IS ?`,params:[...params,value]});
        for(const key of unique) {
          const matches=rows.filter(row=>row[field]===key);
          if(matches.length>1) fail('resource_unavailable');
          cachedRows.set(cacheKey(table,`${field}=?${extraWhere}`, [key,...extraParams]),matches[0]??null);
        }
        return rows;
      };
      const collectionSelection=(kind,key)=>{
        const payload=trusted.requestPayload;
        const routeCode=kind==='offer_collection'?'cabinet.offers':'cabinet.applications';
        if(!payload || payload.routeCode!==routeCode || payload.view!==key || !Array.isArray(payload.selectedKeys) ||
          payload.selectedKeys.length>50 || Object.keys(payload).some(name=>!['routeCode','view','selectedKeys'].includes(name)) ||
          new Set(payload.selectedKeys).size!==payload.selectedKeys.length || payload.selectedKeys.some(value=>
            kind==='offer_collection'?!token(value):!positive(value))) fail('invalid_resource_reference');
        return payload.selectedKeys;
      };
      const count = async (name, key) => {
        const sql = RESOURCE_QUOTA_PREDICATES[name];
        const result = (await read(sql,[key]))[0]?.n;
        if (!Number.isSafeInteger(result) || result < 0) fail('resource_unavailable');
        checks.push({sql:`(${sql}) = ?`,params:[key,result]});
        return result;
      };
      let profile = null;
      const ownProfile = async () => profile ??= await load('partner_profiles','telegram_id=?',[subject]);
      const ownFlow=async(kind,payload)=>{
        const row=await load(kind==='admin'?'admin_sessions':'partner_sessions','telegram_id=?',[subject]);
        const at=databaseSeconds(row?.updated_at);
        if(!row||!Number.isSafeInteger(at)||kind==='admin'&&at<=nowSeconds-1800)return null;
        if(kind==='admin')deadlines.push(at+1800);
        let staged;try{staged=JSON.parse(row.payload_json);}catch{return null;}
        if(!staged||typeof staged!=='object'||Array.isArray(staged)||
          payload?.flowAction!==undefined&&payload.flowAction!==row.action||payload?.flowStep!==undefined&&payload.flowStep!==row.step)return null;
        return {row,staged};
      };
      const dto = { schemaVersion:1, capability, operation, kind:ref?.kind ?? 'actor',
        ref:ref?.key ?? `actor:${subject}`, exists:true, subjectTelegramId:subject,
        ownerTelegramId:subject, partnerProfileId:null, ambassadorId:null, tenantKey:`actor:${subject}`,
        status:null, visibility:null, assignedTelegramId:null, version:null, route:null,
        windowValid:null, publicEligible:false, selfApplication:false, attribution:null,
        usage:{}, quotaDelta:0, observedAt:nowSeconds, requestId, domain:{} };
      const missing = () => {
        Object.assign(dto,{exists:false,reasonCode:'not_found',ownerTelegramId:null,
          partnerProfileId:null,ambassadorId:null,tenantKey:null,status:null,visibility:null,
          assignedTelegramId:null,version:null,route:null,windowValid:null,attribution:null,usage:{},domain:{}});
      };
      const offer = async key => {
        const owner = await load('offer_owners','offer_code=?',[key]);
        if (!owner) return null;
        const ownerProfile = owner.owner_kind === 'partner'
          ? await load('partner_profiles','id=?',[owner.partner_profile_id]) : null;
        const root = await load('offers','code=?',[key]);
        if (!root) return null;
        const rule = await load('offer_visibility_rules','offer_code=?',[key]);
        const version = rule?.current_version_id
          ? await load('offer_versions','id=? AND offer_code=?',[rule.current_version_id,key]) : null;
        const assignment = await load('offer_visibility_assignments','offer_code=? AND telegram_id=?',[key,subject]);
        const selected = await load('partner_offer_links','offer_code=?',[key]);
        const link = selected ? await load('partner_links','id=?',[selected.partner_link_id]) : null;
        const catalog = link ? await load('program_offers','id=?',[link.catalog_offer_id]) : null;
        const program = catalog ? await load('partner_programs','code=?',[catalog.program_code]) : null;
        const destination = catalog ? await load('offers','code=?',[catalog.offer_code]) : null;
        const routeApproved = Boolean(link && catalog && program && destination && ownerProfile?.status === 'active' &&
          link.status === 'approved' && link.ownership_confirmed === 1 && link.traffic_confirmed === 1 &&
          catalog.status === 'active' && program.status === 'active' && destination.status === 'active');
        const route = {approved:routeApproved,domainAllowed:allowedUrl(link?.url,program?.allowed_domains),
          ownerMatches:link?.partner_profile_id === owner.partner_profile_id,
          linkId:link?.id ?? null,catalogOfferId:catalog?.id ?? null,programCode:program?.code ?? null};
        let hashValid = false;
        if (version?.snapshot_json && typeof version.content_hash === 'string') {
          hashValid = `sha256:${await sha256(version.snapshot_json)}` === version.content_hash;
        }
        const approved = root.status === 'active' && rule?.moderation_status === 'approved' &&
          positive(rule.current_version_id) && rule.current_version_id === rule.approved_version_id &&
          (owner.owner_kind === 'system' || rule.current_version_id === rule.submitted_version_id);
        let publicationValid = false;
        if (owner.owner_kind === 'partner' && approved && hashValid && routeApproved && route.domainAllowed && route.ownerMatches) {
          const beta = await load('partner_beta_settings','id=1',[]);
          if (beta) {
            const currentRoute = {authoritySource:'database',partnerLinkId:link.id,partnerProfileId:link.partner_profile_id,
              ownerProfileStatus:ownerProfile.status,partnerLinkStatus:link.status,ownershipConfirmed:link.ownership_confirmed,
              trafficConfirmed:link.traffic_confirmed,catalogOfferId:catalog.id,catalogOfferCode:catalog.offer_code,
              catalogOfferStatus:catalog.status,programCode:program.code,programStatus:program.status,
              catalogBusinessStatus:destination.status,url:link.url,trackingKey:link.tracking_key,
              allowedDomains:program.allowed_domains,updatedAt:link.updated_at};
            try {
              // Assigned publication uses the same canonical snapshot validator;
              // assignment visibility itself remains factual and exact below.
              await projectPublicPartnerOffer({offer:databaseRow(root),owner:databaseRow(owner),
                currentVersion:databaseRow(version),visibilityRule:databaseRow({...rule,visibility:'public'}),
                currentRoute,betaSettings:databaseRow({...beta,public_visibility_enabled:1})});
              publicationValid = beta.enabled === 1 && beta.private_offers_enabled === 1 &&
                trusted.env.PARTNER_BETA_ENABLED === 'true' && trusted.env.PARTNER_PRIVATE_OFFERS_ENABLED === 'true' &&
                (rule.visibility !== 'public' || beta.public_visibility_enabled === 1 && trusted.env.PARTNER_OFFER_PUBLIC_VISIBILITY_ENABLED === 'true');
            } catch { publicationValid = false; }
          }
        }
        if (owner.owner_kind === 'system') {
          const actualUrl=root.url || (root.url_env_key ? trusted.env[root.url_env_key] : '');
          try {
            publicationValid = approved && coherentSystemVersion(root,version,hashValid) && Boolean(actualUrl) && allowedUrl(actualUrl,new URL(actualUrl).hostname);
          }
          catch { publicationValid=false; }
        }
        const assigned = rule?.visibility === 'assigned' && assignment?.assignment_status === 'active';
        const visible = rule?.visibility === 'public' || assigned;
        const windowValid = validWindow(root,nowSeconds);
        const end = databaseSeconds(root.expires_at);
        if (end !== null && end > nowSeconds) deadlines.push(end);
        return {root,owner,ownerProfile,rule,version,route,hashValid,windowValid,assigned,link,catalog,program,destination,
          publicEligible:Boolean(visible && approved && publicationValid && windowValid)};
      };
      const attachOffer = facts => {
        dto.kind='offer';dto.ownerTelegramId=facts.ownerProfile?.telegram_id ?? null;
        dto.partnerProfileId=facts.owner.partner_profile_id;dto.tenantKey=facts.owner.partner_profile_id == null ? 'system' : `partner:${facts.owner.partner_profile_id}`;
        dto.status=facts.root.status;dto.visibility=facts.rule?.visibility ?? null;
        dto.assignedTelegramId=facts.assigned ? subject : null;dto.route=facts.route;
        dto.version={currentId:facts.rule?.current_version_id ?? null,submittedId:facts.rule?.submitted_version_id ?? null,
          approvedId:facts.rule?.approved_version_id ?? null,number:facts.version?.version_number ?? null,hashValid:facts.hashValid};
        dto.windowValid=facts.windowValid;dto.publicEligible=facts.publicEligible;
        dto.domain={ownerMatches:dto.ownerTelegramId===subject,moderationPending:facts.rule?.moderation_status==='pending',
          archived:facts.root.status==='archived',activeProfile:facts.ownerProfile?.status==='active'};
      };
      const catalogOffer = async key => {
        if(!positive(key)) fail('invalid_resource_reference');
        const catalog=await load('program_offers','id=?',[key]);
        if(!catalog) return null;
        const program=await load('partner_programs','code=?',[catalog.program_code]);
        const root=await load('offers','code=?',[catalog.offer_code]);
        const owner=await load('offer_owners','offer_code=?',[catalog.offer_code]);
        const rule=await load('offer_visibility_rules','offer_code=?',[catalog.offer_code]);
        const version=rule?.current_version_id ? await load('offer_versions','id=? AND offer_code=?',[rule.current_version_id,catalog.offer_code]) : null;
        const user=await load('users','telegram_id=?',[subject]);
        const ownerProfile=positive(user?.inviter_id) ? await load('partner_profiles','telegram_id=?',[user.inviter_id]) : null;
        const link=ownerProfile ? await load('partner_links',"partner_profile_id=? AND catalog_offer_id=? AND status='approved'",[ownerProfile.id,key]) : null;
        if(!root || owner?.owner_kind!=='system') return null;
        const hashValid=version?.snapshot_json ? `sha256:${await sha256(version.snapshot_json)}`===version.content_hash : false;
        const route={approved:Boolean(link && ownerProfile?.status==='active' && link.ownership_confirmed===1 && link.traffic_confirmed===1 &&
          catalog.status==='active' && program?.status==='active' && root.status==='active'),
          domainAllowed:allowedUrl(link?.url,program?.allowed_domains),ownerMatches:link?.partner_profile_id===ownerProfile?.id,
          linkId:link?.id ?? null,catalogOfferId:catalog.id,programCode:program?.code ?? null};
        const windowValid=validWindow(root,nowSeconds);
        const eligible=Boolean(rule?.visibility==='public' && rule.moderation_status==='approved' &&
          rule.current_version_id===rule.approved_version_id && coherentSystemVersion(root,version,hashValid) &&
          windowValid && route.approved && route.domainAllowed && route.ownerMatches);
        const end=databaseSeconds(root.expires_at);if(end!==null && end>nowSeconds) deadlines.push(end);
        return {root,owner:{...owner,partner_profile_id:ownerProfile?.id ?? null},ownerProfile,rule,version,route,hashValid,
          windowValid,assigned:false,link,catalog,program,destination:root,publicEligible:eligible,sourceKind:'program_offer'};
      };
      if (definition.availability === 'future_disabled') {
        missing(); dto.reasonCode='resource_adapter_unavailable';
      } else if(ref?.kind==='offer_collection') {
        const view=ref.key;
        if(!['mine','catalog'].includes(view) || capability!==(view==='mine'?'offer.read_own':'offer.read_public')) fail('invalid_resource_reference');
        const keys=collectionSelection(ref.kind,view);
        const owners=await bulk('offer_owners','offer_code',keys);
        await bulk('offers','code',keys);
        const rules=await bulk('offer_visibility_rules','offer_code',keys);
        const versions=await bulk('offer_versions','id',rules.map(row=>row.current_version_id).filter(positive));
        for(const row of versions) cachedRows.set(cacheKey('offer_versions','id=? AND offer_code=?',[row.id,row.offer_code]),row);
        await bulk('partner_profiles','id',owners.map(row=>row.partner_profile_id).filter(positive));
        await bulk('offer_visibility_assignments','offer_code',keys,{extraWhere:' AND telegram_id=?',extraParams:[subject]});
        const selected=await bulk('partner_offer_links','offer_code',keys);
        const links=await bulk('partner_links','id',selected.map(row=>row.partner_link_id));
        const catalogs=await bulk('program_offers','id',links.map(row=>row.catalog_offer_id));
        await bulk('partner_programs','code',catalogs.map(row=>row.program_code));
        await bulk('offers','code',catalogs.map(row=>row.offer_code));
        const p=view==='mine'?await ownProfile():null;
        const memberFacts=[];
        for(const key of keys) {
          const item=await offer(key);
          if(!item || (view==='mine'?item.ownerProfile?.telegram_id!==subject:!item.publicEligible)) {missing();break;}
          memberFacts.push({key,ownerKind:item.owner.owner_kind,ownerTelegramId:item.ownerProfile?.telegram_id??null,
            partnerProfileId:item.owner.partner_profile_id,publicEligible:item.publicEligible,windowValid:item.windowValid,
            visibility:item.rule?.visibility??null,currentVersionId:item.rule?.current_version_id??null,
            assignedTelegramId:item.assigned?subject:null});
        }
        if(dto.exists) {
          let ownCount=null,visibleCount=null;
          if(view==='mine') {
            const sql="SELECT COUNT(*) AS n FROM offers o JOIN offer_owners own ON own.offer_code=o.code JOIN partner_profiles p ON p.id=own.partner_profile_id WHERE own.owner_kind='partner' AND p.telegram_id=?";
            ownCount=(await read(sql,[subject]))[0]?.n;
            if(!Number.isSafeInteger(ownCount) || ownCount<0) fail('resource_unavailable');
            checks.push({sql:`(${sql})=?`,params:[subject,ownCount]});
          }
          const verifiedEmptyCatalog=view==='catalog' && keys.length===0 && takeVerifiedEmptyCabinetCatalog(context);
          if(view==='catalog' && keys.length===0 && !verifiedEmptyCatalog) {
            const sql="SELECT COUNT(*) AS n FROM offers o JOIN offer_visibility_rules r ON r.offer_code=o.code WHERE o.status='active' AND r.moderation_status='approved' AND r.current_version_id=r.approved_version_id AND (r.visibility='public' OR r.visibility='assigned' AND EXISTS(SELECT 1 FROM offer_visibility_assignments a WHERE a.offer_code=o.code AND a.telegram_id=? AND a.assignment_status='active'))";
            visibleCount=(await read(sql,[subject]))[0]?.n;
            if(!Number.isSafeInteger(visibleCount) || visibleCount<0) fail('resource_unavailable');
            checks.push({sql:`(${sql})=?`,params:[subject,visibleCount]});
          }
          dto.kind='offer_collection';dto.ref=view;dto.partnerProfileId=p?.id??null;
          dto.tenantKey=p?`partner:${p.id}`:`actor:${subject}`;
          dto.visibility=view==='catalog'?'collection':null;
          dto.publicEligible=view==='catalog';dto.windowValid=view==='catalog'?true:null;
          dto.domain={collectionScopeVerified:true,collectionView:view,allMembersVisible:view==='catalog',
            emptyOwnCollectionVerified:view==='mine' && keys.length===0 && ownCount===0,
            emptyVisibleCollectionVerified:view==='catalog' && keys.length===0 && (verifiedEmptyCatalog || visibleCount===0)};
          dto.records={members:memberFacts,partnerProfile:databaseRow(p)};
        }
      } else if(ref?.kind==='application_collection') {
        const view=ref.key;
        if(!['mine','attributed'].includes(view) || capability!==(view==='mine'?'application.read_own':'application.read_attributed')) fail('invalid_resource_reference');
        const keys=collectionSelection(ref.kind,view),p=view==='attributed'?await ownProfile():null;
        const leads=await bulk('lead_requests','id',keys);
        const attributed=await bulk('lead_partner_attribution','lead_id',keys);
        const byId=new Map(leads.map(row=>[row.id,row])),byLead=new Map(attributed.map(row=>[row.lead_id,row]));
        if(keys.some(key=>!byId.has(key) || (view==='mine'?byId.get(key).telegram_id!==subject:
          !p || byLead.get(key)?.partner_profile_id!==p.id))) missing();
        if(dto.exists) {
          const sql=view==='mine'?'SELECT COUNT(*) AS n FROM lead_requests WHERE telegram_id=?':
            'SELECT COUNT(*) AS n FROM lead_partner_attribution attr JOIN partner_profiles p ON p.id=attr.partner_profile_id WHERE p.telegram_id=?';
          const ownedCount=(await read(sql,[subject]))[0]?.n;
          if(!Number.isSafeInteger(ownedCount) || ownedCount<0) fail('resource_unavailable');
          checks.push({sql:`(${sql})=?`,params:[subject,ownedCount]});
          dto.kind='application_collection';dto.ref=view;dto.partnerProfileId=p?.id??null;
          dto.tenantKey=p?`partner:${p.id}`:`actor:${subject}`;
          dto.attribution=p?{partnerProfileId:p.id,immutable:true}:null;
          dto.domain={collectionScopeVerified:true,collectionView:view,emptyOwnCollectionVerified:keys.length===0 && ownedCount===0};
          dto.records={members:leads.map(row=>({key:row.id,ownerTelegramId:row.telegram_id,
            attributedPartnerProfileId:byLead.get(row.id)?.partner_profile_id??null})),partnerProfile:databaseRow(p)};
        }
      } else if (definition.actor_kind === 'trusted_service') {
        const deliveryClaim=capability==='service.outbox.drain'&&ref?.kind==='effect_claim';
        const journalCost=capability==='service.ai.settle_cost'&&ref?.kind==='ai_operation_journal';
        const plan=deliveryClaim?['effect_claim','mini_app_effect_claims','dedupe_key','outbox_drain']:
          journalCost?['ai_operation_journal','ai_operation_journal','request_id','AI_incurred_cost_settlement']:servicePlans[capability];
        if (trusted.actorKind!=='service' || !plan || ref?.kind!==plan[0]) fail('invalid_resource_reference');
        const row=await load(plan[1],`${plan[2]}=?`,[ref.key]);
        const time=value=>databaseSeconds(value);
        let due=false;
        if(row) {
          if(capability==='service.preview.expire') due=row.status==='active' && time(row.ends_at)!==null && time(row.ends_at)<=nowSeconds;
          if(capability==='service.stars.expire') due=['active','cancel_at_period_end'].includes(row.status) && time(row.current_period_end)!==null && time(row.current_period_end)<=nowSeconds;
          if(capability==='service.stars.reconcile') due=['running','completed','failed','manual_review'].includes(row.status);
          if(capability==='service.stars.process_event') due=positive(row.telegram_update_id) && typeof row.event_key==='string';
          if(capability==='service.referral.settle') due=['pending','confirmed','cancelled'].includes(row.reward_status) && time(row.confirm_after)!==null && time(row.confirm_after)<=nowSeconds;
          if(capability==='service.privacy.cleanup') due=row.telegram_id===null && time(row.anonymized_at)!==null &&
            time(row.retention_until)!==null && time(row.retention_until)<=nowSeconds;
          if(capability==='service.notification.deliver_historical') due=['pending','failed'].includes(row.status) && time(row.scheduled_for)!==null && time(row.scheduled_for)<=nowSeconds;
          if(capability==='service.outbox.drain') {
            if(deliveryClaim) {
              const outbox=await load('mini_app_effect_outbox','dedupe_key=?',[row.dedupe_key]);
              const receipt=typeof outbox?.command_key==='string'?await load('mini_app_command_receipts','idempotency_key=?',[outbox.command_key]):null;
              const notice=positive(row.notification_id)&&positive(row.recipient_telegram_id)?
                await load('notifications','id=? AND recipient_id=?',[row.notification_id,row.recipient_telegram_id]):null;
              const user=positive(row.recipient_telegram_id)?await load('users','telegram_id=?',[row.recipient_telegram_id]):null;
              const push=positive(row.recipient_telegram_id)?await load('notification_settings','telegram_id=?',[row.recipient_telegram_id]):null;
              const privacySql="SELECT COUNT(*) AS n FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending' AND unixepoch(expires_at)>unixepoch()";
              const pending=(await read(privacySql,[row.recipient_telegram_id??-1]))[0]?.n;
              if(!Number.isSafeInteger(pending)||pending<0)fail('resource_unavailable');
              checks.push({sql:`(${privacySql})=?`,params:[row.recipient_telegram_id??-1,pending]});
              let recipient=null;try{recipient=JSON.parse(outbox?.payload_json??'null')?.recipientTelegramId;}catch{}
              due=Boolean(row.delivery_state==='stored'&&Number.isSafeInteger(row.next_attempt_at)&&row.next_attempt_at<=nowSeconds&&
                notice&&user?.is_blocked===0&&pending===0&&(push===null||push.telegram_enabled===1)&&
                outbox?.effect_kind==='notification'&&outbox.status==='delivered'&&recipient===row.recipient_telegram_id&&
                ['committed','unchanged'].includes(receipt?.commit_status));
              if(due)checks.push({sql:'unixepoch()>=?',params:[row.next_attempt_at]});
              dto.records={outbox:databaseRow(outbox),receipt:databaseRow(receipt),notification:databaseRow(notice),recipientUser:databaseRow(user),pushSettings:databaseRow(push)};
            } else {
              const receipt=typeof row.command_key==='string' ? await load('mini_app_command_receipts','idempotency_key=?',[row.command_key]) : null;
              due=row.status==='pending' && ['notification','analytics_adapter'].includes(row.effect_kind) &&
                ['committed','unchanged'].includes(receipt?.commit_status);
            }
          }
          if(capability==='service.analytics.ingest') due=['complete','partial'].includes(row.status) && typeof row.batch_fingerprint==='string';
          if(capability==='service.ai.settle_cost') {
            if(journalCost) {
              const sql=`SELECT COALESCE(json_group_array(json(snapshot)),'[]') FROM (SELECT ${jsonExpression(columns.ai_operation_receipts)} AS snapshot FROM ai_operation_receipts WHERE request_id=? ORDER BY attempt_no LIMIT 4)`;
              const encoded=Object.values((await read(sql,[row.request_id]))[0]??{})[0];
              if(typeof encoded!=='string')fail('resource_unavailable');
              const receipts=JSON.parse(encoded);if(!Array.isArray(receipts)||receipts.length>3)fail('resource_unavailable');
              checks.push({sql:`(${sql}) IS ?`,params:[row.request_id,encoded]});
              const started=positive(row.provider_started_at)&&row.attempted_count>=1;
              const pending=receipts.some(receipt=>receipt.expense_location==='pending');
              const unusedExpired=row.state==='admitted'&&row.provider_started_at===null&&row.attempted_count===0&&
                row.active_attempt_no===null&&row.active_attempt_id===null&&receipts.length===0&&row.expires_at<=nowSeconds;
              due=Boolean(unusedExpired||row.state!=='admitted'&&started&&
                (pending||['unknown','terminal_succeeded','terminal_failed'].includes(row.state)||row.state==='provider_started'&&row.expires_at<=nowSeconds));
              if(due&&(unusedExpired||row.state==='provider_started'&&!pending))checks.push({sql:'unixepoch()>=?',params:[row.expires_at]});
              dto.records={journal:databaseRow(row),receipts:receipts.map(databaseRow)};
              dto.domain.unusedExpiredAdmissionCleanup=unusedExpired;
            } else due=['reserved','consumed','released'].includes(row.reservation_state) && Number.isSafeInteger(row.reserved_cost_microusd) && row.reserved_cost_microusd>=0;
          }
        }
        if(!due) missing();
        else {
          const recipient=row.subject_telegram_id ?? row.recipient_telegram_id ?? row.telegram_id ?? row.beneficiary_telegram_id ?? row.owner_telegram_id ?? null;
          if(capability==='service.notification.deliver_historical') {
            const grant=await load('trial_grants','grant_id=?',[row.related_grant_id]);
            const user=await load('users','telegram_id=?',[recipient]);
            const pending=await read("SELECT COUNT(*) AS n FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending' AND datetime(expires_at)>datetime(?,'unixepoch')",[recipient,nowSeconds]);
            const pendingCount=pending[0]?.n;
            checks.push({sql:"(SELECT COUNT(*) FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending' AND datetime(expires_at)>CURRENT_TIMESTAMP)=?",params:[recipient,pendingCount]});
            const grantEligible=grant?.telegram_id===recipient && (row.job_type==='preview_warning'
              ? grant.status==='active' && time(grant.ends_at)>nowSeconds :
              row.job_type==='preview_ended' && grant.status==='expired');
            if(!grantEligible || !user || user.is_blocked===1 || pendingCount!==0) missing();
            if(grantEligible && row.job_type==='preview_warning') deadlines.push(time(grant.ends_at));
          }
          if(dto.exists) {
            dto.ownerTelegramId=recipient;dto.tenantKey=null;dto.status=row.state ?? row.delivery_state ?? row.status ?? row.reward_status ?? row.reservation_state ?? row.outcome;
            dto.domain={canonicalServiceResource:true,sourceReceiptVerified:true,trustedPurpose:plan[3],
              due:true,onlyIncurredCost:capability==='service.ai.settle_cost',
              unusedExpiredAdmissionCleanup:dto.domain.unusedExpiredAdmissionCleanup===true,
              financialMaintenanceOnly:capability==='service.referral.settle',
              noNewBeneficiaryGrant:capability==='service.referral.settle'};
            dto.records={...dto.records,serviceSource:databaseRow(row)};
          }
        }
      } else if (capability === 'terms.read' || capability === 'help.read' || capability === 'support.basic') {
        if (ref !== null) fail('invalid_resource_reference');
        dto.kind=capability==='terms.read'?'public_document':'public_help';dto.ownerTelegramId=null;dto.tenantKey=null;
        dto.domain.publicHelp=true;
      } else if (capability === 'offer.create_private') {
        if (ref !== null) fail('invalid_resource_reference');
        const p = await ownProfile();
        if (!p) missing();
        else {
          dto.kind='partner_profile';dto.ref=p.id;dto.partnerProfileId=p.id;dto.tenantKey=`partner:${p.id}`;
          dto.status=p.status;dto.quotaDelta=1;
          dto.usage.own_working_offers=await count('own_working_offers',p.id);
          const beta=await load('partner_beta_settings','id=1',[]);
          dto.usage.betaOfferLimit=beta?.max_active_offers_per_partner ?? null;
          dto.records={partnerProfile:databaseRow(p)};
        }
      } else if (capability.startsWith('offer.')) {
        const publicRead=['offer.read_public','offer.open_action'].includes(capability);
        if (ref?.kind !== 'offer' && !(publicRead && ref?.kind==='catalog_offer')) fail('invalid_resource_reference');
        const facts=ref.kind==='catalog_offer'?await catalogOffer(ref.key):await offer(ref.key);
        const own = facts?.ownerProfile?.telegram_id === subject;
        const ownOnly=!['offer.read_public','offer.read_assigned','offer.open_action'].includes(capability);
        if (!facts || ownOnly && !own || !ownOnly && (!facts.publicEligible ||
            capability === 'offer.read_public' && facts.rule.visibility !== 'public' ||
            capability === 'offer.read_assigned' && !facts.assigned)) missing();
        else {
          attachOffer(facts);
          dto.records={offer:databaseRow(facts.root),owner:databaseRow(facts.owner),
            visibilityRule:databaseRow(facts.rule),currentVersion:databaseRow(facts.version),
            partnerProfile:databaseRow(facts.ownerProfile),currentRoute: facts.link && facts.catalog && facts.program && facts.destination ?
              {authoritySource:'database',partnerLinkId:facts.link.id,partnerProfileId:facts.link.partner_profile_id,
                ownerProfileStatus:facts.ownerProfile?.status,partnerLinkStatus:facts.link.status,
                ownershipConfirmed:facts.link.ownership_confirmed,trafficConfirmed:facts.link.traffic_confirmed,
                catalogOfferId:facts.catalog.id,catalogOfferCode:facts.catalog.offer_code,
                catalogOfferStatus:facts.catalog.status,programCode:facts.program.code,programStatus:facts.program.status,
                catalogBusinessStatus:facts.destination.status,url:facts.link.url,trackingKey:facts.link.tracking_key,
                allowedDomains:facts.program.allowed_domains,updatedAt:facts.link.updated_at} : null};
          if (ownOnly && capability !== 'offer.read_own') {
            dto.usage.own_working_offers=await count('own_working_offers',dto.partnerProfileId);
            const beta=await load('partner_beta_settings','id=1',[]);
            dto.usage.betaOfferLimit=beta?.max_active_offers_per_partner ?? null;
          }
          dto.domain.transitionAllowed=capability === 'offer.read_own' ||
            capability === 'offer.archive_own' && ['draft','active','paused'].includes(dto.status) ||
            capability === 'offer.pause_own' && dto.status === 'active' ||
            capability === 'offer.activate_own' && ['draft','paused'].includes(dto.status) ||
            ['offer.edit_own','offer.submit_moderation'].includes(capability) &&
              dto.status !== 'archived' && !dto.domain.moderationPending ||
            ['offer.read_public','offer.read_assigned','offer.open_action'].includes(capability);
        }
      } else if (capability.startsWith('application.')) {
        let lead=null,attribution=null,facts=null;
        if (capability === 'application.create') {
          if (!['offer','catalog_offer'].includes(ref?.kind)) fail('invalid_resource_reference');
          facts=ref.kind==='catalog_offer' ? await catalogOffer(ref.key) : await offer(ref.key);
          if (facts?.publicEligible) lead=await load('lead_requests','telegram_id=? AND offer_code=?',[subject,facts.root.code]);
        } else {
          if (ref?.kind !== 'application' || !positive(ref.key)) fail('invalid_resource_reference');
          lead=await load('lead_requests','id=?',[ref.key]);
        }
        if (lead) attribution=await load('lead_partner_attribution','lead_id=?',[lead.id]);
        const p=capability === 'application.read_attributed' ? await ownProfile() : null;
        const accessible=capability === 'application.read_attributed'
          ? p && attribution?.partner_profile_id === p.id : !lead || lead.telegram_id === subject;
        if (capability === 'application.resubmit' && lead && accessible) {
          const rootOwner=await load('offer_owners','offer_code=?',[lead.offer_code]);
          const firstLink=rootOwner?.owner_kind==='system' && attribution ? await load('partner_links','id=?',[attribution.partner_link_id]) : null;
          facts=firstLink ? await catalogOffer(firstLink.catalog_offer_id) : await offer(lead.offer_code);
        }
        if (!accessible || capability === 'application.create' && !facts?.publicEligible ||
            capability !== 'application.create' && !lead ||
            capability === 'application.resubmit' && (!facts?.publicEligible || lead.status !== 'rejected')) missing();
        else {
          dto.kind='application';dto.ref=lead?.id ?? ref.key;dto.status=lead?.status ?? 'new';
          dto.ownerTelegramId=lead?.telegram_id ?? subject;
          dto.partnerProfileId=attribution?.partner_profile_id ?? facts?.owner.partner_profile_id ?? null;
          dto.attribution=attribution ? {partnerProfileId:attribution.partner_profile_id,immutable:true} : null;
          dto.selfApplication=facts?.ownerProfile?.telegram_id === subject;
          dto.publicEligible=facts?.publicEligible ?? false;
          dto.domain={transitionAllowed:capability !== 'application.resubmit' || lead.status === 'rejected',
            attributionMatches:!attribution || !facts || attribution.partner_profile_id === facts.owner.partner_profile_id,
            attributionConflict:Boolean(attribution && facts && attribution.partner_profile_id!==facts.owner.partner_profile_id),
            existingIdenticalApplication:Boolean(lead && ['pending','confirmed'].includes(lead.status))};
          dto.records={existingLead:databaseRow(lead),existingAttribution:attribution ?
            {...databaseRow(attribution),inviterId:lead?.inviter_id ?? facts?.ownerProfile?.telegram_id ?? null} : null};
          if (facts) {
            dto.route=facts.route;dto.windowValid=facts.windowValid;
            dto.visibility=facts.rule.visibility;dto.assignedTelegramId=facts.assigned?subject:null;
            dto.records.eligibleOffer={authoritySource:'database',offerCode:facts.root.code,sourceKind:facts.sourceKind ?? 'partner_offer',
              partnerLinkId:facts.route.linkId,partnerProfileId:facts.owner.partner_profile_id,
              inviterId:facts.ownerProfile?.telegram_id ?? null,ownerTelegramId:facts.ownerProfile?.telegram_id ?? null,
              ownerProfileStatus:facts.ownerProfile?.status ?? null,partnerLinkStatus:facts.route.approved?'approved':null,
              ownershipConfirmed:facts.route.approved?1:0,trafficConfirmed:facts.route.approved?1:0,
              destinationAvailable:facts.publicEligible,isOwnerPreview:dto.selfApplication,
              programCode:facts.route.programCode,businessStatus:facts.root.status,
              currentVersionId:facts.rule.current_version_id,submittedVersionId:facts.rule.submitted_version_id,
              approvedVersionId:facts.rule.approved_version_id,moderationStatus:facts.rule.moderation_status,
              visibility:facts.rule.visibility,assignmentActive:facts.assigned,assignedTelegramId:facts.assigned?subject:null};
            if(facts.sourceKind==='program_offer') Object.assign(dto.records.eligibleOffer,
              {catalogOfferId:facts.catalog.id,catalogOfferStatus:facts.catalog.status,
                catalogBusinessStatus:facts.root.status,programStatus:facts.program.status,resolvedForTelegramId:subject});
          }
          if (['application.create','application.resubmit'].includes(capability)) {
            dto.usage.active_applications=await count('active_applications',subject);
            dto.quotaDelta=!lead || lead.status==='rejected'?1:0;
          }
        }
      } else if (capability.startsWith('campaign.')) {
        const p=await ownProfile();
        const ambassador=p ? await load('ambassador_profiles_v2','partner_profile_id=?',[p.id]) : null;
        const campaign=ref?.kind==='campaign' ? await load('ambassador_campaigns','campaign_id=?',[ref.key]) : null;
        if (!p || !ambassador || ref !== null && (!campaign || campaign.ambassador_id!==ambassador.ambassador_id)) missing();
        else {
          dto.kind='campaign';dto.ref=campaign?.campaign_id ?? ambassador.ambassador_id;
          dto.partnerProfileId=p.id;dto.ambassadorId=ambassador.ambassador_id;
          dto.tenantKey=`partner:${p.id}`;dto.status=campaign?.status ?? 'new';
          dto.usage.active_campaigns=await count('active_campaigns',p.id);
          const transition={ 'campaign.activate':['draft'], 'campaign.resume':['paused'],
            'campaign.pause':['active'], 'campaign.archive':['draft','active','paused'],
            'campaign.edit_draft':['draft'], 'campaign.tracking_code.issue':['active'],
            'campaign.tracking_code.revoke':['active','paused','archived'] };
          const config=readAnalyticsV2Config(trusted.env);
          const settings=await load('analytics_v2_settings','id=1',[]);
          const activation=await load('ambassador_profile_transitions',"ambassador_id=? AND reason_code='activation_approved' AND from_status='draft' AND to_status='active'",[ambassador.ambassador_id]);
          const campaignApproval=campaign ? await load('ambassador_campaign_transitions',"campaign_id=? AND reason_code='activation_approved' AND from_status='draft' AND to_status='active'",[campaign.campaign_id]) : null;
          const approvedProfile=Boolean(activation && ['admin','system'].includes(activation.actor_kind) &&
            activation.profile_revision<=ambassador.revision && activation.occurred_at<=nowSeconds);
          const approvedCampaign=Boolean(campaignApproval && ['admin','system'].includes(campaignApproval.actor_kind) &&
            campaignApproval.campaign_revision<=campaign.revision && campaignApproval.occurred_at<=nowSeconds);
          const closedControls=config.configurationValid && config.rolloutMode==='admin_shadow' && config.masterEnabled &&
            config.ingestEnabled && config.projectionsEnabled && config.ambassadorEnabled && settings?.rollout_mode==='admin_shadow' &&
            ['master_enabled','ingest_enabled','projections_enabled','ambassador_enabled'].every(key=>settings[key]===1);
          const adminIssuer=actorFacts.canonicalOwner===true;
          const ownerContinuation=['campaign.resume','campaign.pause','campaign.tracking_code.revoke'].includes(capability) &&
            approvedCampaign && actorFacts.roles.includes('partner');
          const program=campaign ? await load('partner_programs','code=?',[campaign.program_code]) : null;
          const catalog=campaign?.scope_kind==='offer' ? await load('program_offers','id=?',[campaign.catalog_offer_id]) : null;
          const scopeEligible=Boolean(campaign && program?.status==='active' &&
            (campaign.scope_kind==='program' && campaign.catalog_offer_id===null ||
              campaign.scope_kind==='offer' && catalog?.status==='active' && catalog.program_code===program.code));
          const inWindow=!campaign || campaign.starts_at<=nowSeconds && campaign.ends_at>nowSeconds;
          if(campaign && campaign.ends_at>nowSeconds && ['campaign.activate','campaign.resume','campaign.tracking_code.issue'].includes(capability)) deadlines.push(campaign.ends_at);
          dto.domain={activeProfile:p.status==='active' && ambassador.status==='active',
            transitionAllowed:capability==='campaign.read_own' || capability==='campaign.create_draft' && !campaign ||
              Boolean(campaign && transition[capability]?.includes(campaign.status)),
            approvedIssuerRoute:Boolean(closedControls && approvedProfile && (adminIssuer || ownerContinuation)),
            scopeEligible:scopeEligible && (['campaign.activate','campaign.resume','campaign.tracking_code.issue'].includes(capability)?inWindow:true),
            actualAdminShadowControls:closedControls,approvedProfile,approvedCampaign};
          // A campaign alone cannot authorize a selected tracking link/code.
          // The exact canonical tracking-target adapter is not released here.
          if(capability.startsWith('campaign.tracking_code.')) dto.domain.handlerUnavailable=true;
          dto.quotaDelta=['campaign.activate','campaign.resume'].includes(capability) &&
            ['draft','paused'].includes(campaign?.status)?1:0;
          dto.records={campaign:databaseRow(campaign),ambassadorProfile:databaseRow(ambassador),partnerProfile:databaseRow(p),
            profileActivation:databaseRow(activation),campaignActivation:databaseRow(campaignApproval),
            analyticsSettings:databaseRow(settings),program:databaseRow(program),catalogOffer:databaseRow(catalog)};
        }
      } else if (capability === 'notification.manage_own') {
        if(ref===null && ['mark_all_read','archive_read'].includes(trusted.requestPayload?.action) &&
            Object.keys(trusted.requestPayload).length===1) {
          const sql='SELECT COUNT(*) AS n FROM notifications WHERE recipient_id=?';
          const ownCount=(await read(sql,[subject]))[0]?.n;
          if(!Number.isSafeInteger(ownCount)||ownCount<0)fail('resource_unavailable');
          checks.push({sql:`(${sql})=?`,params:[subject,ownCount]});
          dto.kind='notification_collection';dto.ref='own';dto.domain={recipientMatches:true,ownCount};
        } else {
          if (ref?.kind!=='notification' || !positive(ref.key)) fail('invalid_resource_reference');
          const row=await load('notifications','id=? AND recipient_id=?',[ref.key,subject]);
          if (!row) missing(); else {dto.kind='notification';dto.status=row.archived_at?'archived':'active';dto.domain={recipientMatches:true};dto.records={notification:databaseRow(row)};}
        }
      } else if (['partner.legal_declare_own','partner.link.manage_own'].includes(capability)) {
        const p=await ownProfile();
        if (!p) missing();
        else {
          dto.kind='partner_profile';dto.ref=p.id;dto.partnerProfileId=p.id;dto.status=p.status;dto.tenantKey=`partner:${p.id}`;
          dto.records={partnerProfile:databaseRow(p),existingLegalProfile:databaseRow(actorFacts.canonical?.legalProfile)};
          if (ref !== null) {
            if (capability!=='partner.link.manage_own' || ref.kind!=='partner_link' || !positive(ref.key)) fail('invalid_resource_reference');
            const link=await load('partner_links','id=? AND partner_profile_id=?',[ref.key,p.id]);
            if (!link) missing();else {
              dto.kind='partner_link';dto.ref=link.id;dto.status=link.status;dto.records.partnerLink=databaseRow(link);
              const payload=trusted.requestPayload;
              const intent=payload&&Object.keys(payload).length===1&&(['pause','archive'].includes(payload.action)&&
                ['approved','paused'].includes(link.status)||payload.action==='resume'&&link.status==='paused');
              dto.domain.handlerUnavailable=!intent;
              if(payload?.action==='resume') {
                const catalog=await load('program_offers','id=?',[link.catalog_offer_id]);
                const program=catalog?await load('partner_programs','code=?',[catalog.program_code]):null;
                const root=catalog?await load('offers','code=?',[catalog.offer_code]):null;
                const eligible=Boolean(catalog?.status==='active'&&program?.status==='active'&&root?.status==='active'&&
                  validWindow(root,nowSeconds)&&link.ownership_confirmed===1&&link.traffic_confirmed===1&&allowedUrl(link.url,program.allowed_domains));
                dto.domain.handlerUnavailable=!intent||!eligible;
              }
            }
          } else if(capability==='partner.link.manage_own') {
            const payload=trusted.requestPayload;
            let valid=false,flow=null,catalog=null,program=null,root=null,existing=null;
            if(payload?.action==='select_program'&&Object.keys(payload).length===2&&token(payload.programCode)) {
              program=await load('partner_programs','code=?',[payload.programCode]);valid=program?.status==='active';
            } else if(['select_offer','stage_link','submit_link'].includes(payload?.action)&&positive(payload.catalogOfferId)) {
              catalog=await load('program_offers','id=?',[payload.catalogOfferId]);
              program=catalog?await load('partner_programs','code=?',[catalog.program_code]):null;
              root=catalog?await load('offers','code=?',[catalog.offer_code]):null;
              existing=await load('partner_links','partner_profile_id=? AND catalog_offer_id=?',[p.id,payload.catalogOfferId]);
              const target=Boolean(catalog?.status==='active'&&program?.status==='active'&&root?.status==='active'&&validWindow(root,nowSeconds));
              if(payload.action==='select_offer')valid=Object.keys(payload).length===2&&target;
              else {
                flow=await ownFlow('partner',payload);
                const step=payload.action==='stage_link'?'url':'confirm';
                valid=Boolean(Object.keys(payload).every(key=>['action','catalogOfferId','url','flowAction','flowStep'].includes(key))&&
                  flow?.row.action==='submit_partner_link'&&flow.row.step===step&&flow.staged.catalogOfferId===payload.catalogOfferId&&
                  (step==='url'||flow.staged.url===payload.url)&&target&&allowedUrl(payload.url,program?.allowed_domains)&&
                  (!existing||['rejected','archived'].includes(existing.status)||existing.status==='pending'&&existing.url===payload.url));
              }
            }
            dto.domain.handlerUnavailable=!valid;
            Object.assign(dto.records,{partnerFlow:flow?.row??null,catalogOffer:databaseRow(catalog),program:databaseRow(program),
              catalogRoot:databaseRow(root),existingLink:databaseRow(existing)});
          }
        }
      } else if (['ai.partner_draft.read','ai.partner_draft.edit','ai.partner_draft.prepare_share'].includes(capability)) {
        if (ref?.kind!=='ai_draft') fail('invalid_resource_reference');
        const row=await load('ai_drafts','draft_id=? AND owner_telegram_id=? AND deleted_at IS NULL',[ref.key,subject]);
        if (!row) missing(); else {dto.kind='ai_draft';dto.status=row.draft_state;dto.version={number:row.current_version_no};}
      } else if (capability.startsWith('admin.')) {
        const plan=adminTargetPlans[capability];
        if(capability==='admin.result.repair'&&ref?.kind==='legacy_conversion') {
          const payload=trusted.requestPayload;
          if(!payload||!positive(payload.subjectTelegramId)||!catalogCode(payload.offerCode)||
            ref.key!==`user:${payload.subjectTelegramId}:offer:${payload.offerCode}`)fail('invalid_resource_reference');
          const target=await load('users','telegram_id=?',[payload.subjectTelegramId]);
          const root=await load('offers','code=?',[payload.offerCode]);
          const lead=await load('lead_requests','telegram_id=? AND offer_code=?',[payload.subjectTelegramId,payload.offerCode]);
          const conversion=await load('conversions','telegram_id=? AND offer_code=?',[payload.subjectTelegramId,payload.offerCode]);
          const confirm=payload.decision==='confirm'&&Object.keys(payload).length===4&&Number.isSafeInteger(payload.rewardKopecks)&&
            payload.rewardKopecks>=0&&payload.rewardKopecks<=100_000_000&&conversion?.status!=='paid'&&lead?.status!=='paid';
          const paid=payload.decision==='mark_paid'&&Object.keys(payload).length===3&&conversion?.status==='confirmed'&&(!lead||lead.status==='confirmed');
          const intent=Boolean(target&&root&&target.telegram_id!==subject&&actorFacts.canonicalOwner&&(confirm||paid));
          dto.kind='legacy_conversion';dto.ref=ref.key;dto.ownerTelegramId=target?.telegram_id??null;dto.tenantKey='admin';dto.status=lead?.status??conversion?.status??null;
          dto.domain={adminTargetExplicit:true,targetVerified:Boolean(target&&root),actionConfirmed:intent,reasonPresent:intent,domainAuthorityValid:intent};
          dto.records={target:{id:lead?.id??null,telegramId:target?.telegram_id??null,offerCode:payload.offerCode},
            existingLead:lead?databaseRow(lead):null,compatibilityConversion:databaseRow(conversion),targetUser:databaseRow(target),offer:databaseRow(root)};
          if(!target||!root)missing();
        } else if(capability==='admin.result.repair'&&
          (ref===null||ref?.kind==='admin_surface'&&ref.key==='result_repair')&&trusted.requestPayload?.action==='referral_repair') {
          const payload=trusted.requestPayload,config=readReferralRewardConfig(trusted.env);
          const queues={};
          const rewardFields="'reward_id',r.reward_id,'candidate_id',r.candidate_id,'beneficiary_telegram_id',r.beneficiary_telegram_id,'buyer_telegram_id',r.buyer_telegram_id,'reward_status',r.reward_status,'revision',r.revision";
          const sourceFields=",'candidate',json((SELECT json_array(c.source_order_id,c.source_payment_ledger_entry_id,c.source_access_grant_id,c.inviter_telegram_id,c.buyer_telegram_id) FROM referral_reward_candidates c WHERE c.candidate_id=r.candidate_id)),'order',json((SELECT json_array(o.order_id,o.telegram_id,o.order_state,o.state_revision) FROM subscription_orders o JOIN referral_reward_candidates c ON c.source_order_id=o.order_id WHERE c.candidate_id=r.candidate_id)),'compensation',json((SELECT COALESCE(json_group_array(json_array(p.ledger_entry_id,p.entry_type,p.amount_stars)),'[]') FROM payment_ledger p JOIN referral_reward_candidates c ON c.source_payment_ledger_entry_id=p.related_ledger_entry_id WHERE c.candidate_id=r.candidate_id AND p.entry_type IN ('refund','chargeback')))";
          const selections=[
            ['protection',`SELECT json_object(${rewardFields}${sourceFields},'protection_job_id',j.protection_job_id,'workflow_state',j.workflow_state) AS snapshot FROM referral_rewards r LEFT JOIN referral_reward_protection_jobs j ON j.reward_id=r.reward_id WHERE r.reward_status='pending' AND (j.reward_id IS NULL OR j.workflow_state IN ('pending','start_failed')) ORDER BY r.confirm_after,r.reward_id LIMIT 25`,[]],
            ['grants',`SELECT json_object(${rewardFields}${sourceFields}) AS snapshot FROM referral_rewards r LEFT JOIN bonus_access_grants g ON g.reward_id=r.reward_id WHERE r.reward_status='confirmed' AND g.bonus_grant_id IS NULL ORDER BY r.confirmed_at,r.reward_id LIMIT 25`,[]],
            ['claims',"SELECT json_object('bonus_grant_id',g.bonus_grant_id,'reward_id',g.reward_id,'beneficiary_telegram_id',g.beneficiary_telegram_id,'grant_status',g.grant_status,'revision',g.revision,'claim_expires_at',g.claim_expires_at) AS snapshot FROM bonus_access_grants g WHERE g.delivery_mode='manual_claim' AND g.grant_status='claimable' AND g.claim_expires_at<? ORDER BY g.claim_expires_at,g.bonus_grant_id LIMIT 25",[nowSeconds]],
            ['access',"SELECT json_object('bonus_grant_id',g.bonus_grant_id,'reward_id',g.reward_id,'beneficiary_telegram_id',g.beneficiary_telegram_id,'grant_status',g.grant_status,'revision',g.revision,'effect_id',e.effect_id,'effect_ends_at',e.effect_ends_at) AS snapshot FROM bonus_access_grants g JOIN bonus_access_effects e ON e.bonus_grant_id=g.bonus_grant_id LEFT JOIN bonus_access_expiry_events x ON x.bonus_grant_id=g.bonus_grant_id WHERE g.delivery_mode='manual_claim' AND g.grant_status IN ('applied','manual_review') AND e.effect_ends_at<=? AND x.bonus_grant_id IS NULL ORDER BY e.effect_ends_at,g.bonus_grant_id LIMIT 25",[nowSeconds]],
            ['notices',"SELECT json_object('notice_key',n.notice_key,'reward_id',n.reward_id,'bonus_grant_id',n.bonus_grant_id,'beneficiary_telegram_id',n.recipient_telegram_id,'delivery_state',n.delivery_state,'attempt_count',n.attempt_count,'next_attempt_at',n.next_attempt_at,'not_before',n.not_before) AS snapshot FROM referral_reward_notice_jobs n WHERE n.delivery_state IN ('pending','retry') AND n.not_before<=? AND n.next_attempt_at<=? AND n.attempt_count<10 ORDER BY n.next_attempt_at,n.not_before,n.notice_key LIMIT 25",[nowSeconds,nowSeconds]],
            ['expiredNotices',"SELECT json_object('notice_key',n.notice_key,'reward_id',n.reward_id,'bonus_grant_id',n.bonus_grant_id,'beneficiary_telegram_id',n.recipient_telegram_id,'delivery_state',n.delivery_state,'lease_expires_at',n.lease_expires_at,'lease_token',n.lease_token) AS snapshot FROM referral_reward_notice_jobs n WHERE n.delivery_state='processing' AND n.lease_expires_at<? ORDER BY n.lease_expires_at,n.notice_key LIMIT 26",[nowSeconds]],
          ];
          for(const [name,selection,params]of selections) {
            const sql=`SELECT COALESCE(json_group_array(json(snapshot)),'[]') FROM (${selection})`;
            const value=Object.values((await read(sql,params,1,262_144))[0]??{})[0];
            if(typeof value!=='string')fail('resource_unavailable');
            const rows=JSON.parse(value);if(!Array.isArray(rows)||rows.length>25)fail('resource_unavailable');
            queues[name]=rows;checks.push({sql:`(${sql}) IS ?`,params:[...params,value]});
          }
          const intent=Object.keys(payload).length===1&&actorFacts.canonicalOwner&&config.configurationProblems.length===0;
          dto.kind='admin_surface';dto.ref='result_repair';dto.ownerTelegramId=null;dto.tenantKey='admin';
          dto.domain={adminTargetExplicit:true,targetVerified:true,actionConfirmed:intent,reasonPresent:intent,domainAuthorityValid:intent};
          dto.records={maintenanceQueues:queues,maintenanceProgram:config.programCode};
        } else if(capability==='admin.catalog.manage') {
          const payload=trusted.requestPayload;
          const creating=ref?.kind==='admin_surface'&&ref.key==='catalog_creation'||ref===null&&payload?.action==='create';
          if(!creating&&(ref?.kind!=='offer'||!catalogCode(ref.key)))fail('invalid_resource_reference');
          const code=creating?payload?.offerCode:ref.key;
          if(!catalogCode(code))fail('invalid_resource_reference');
          const root=await load('offers','code=?',[code]),owner=await load('offer_owners','offer_code=?',[code]);
          const system=!owner||owner.owner_kind==='system';
          let valid=false,flow=null;
          if(creating) {
            if(payload?.flowAction!==undefined) {
              flow=await ownFlow('admin',payload);
              const step=flow?.row.step;
              valid=Boolean(flow?.row.action==='create_offer'&&['code','button_text','title','category','url'].includes(step)&&
                payload.action==='create'&&typeof payload.value==='string'&&payload.value.length<=1000&&
                Object.keys(payload).every(key=>['action','offerCode','flowAction','flowStep','value'].includes(key))&&
                (step==='code'?payload.value.trim().toLowerCase()===code:flow.staged.code===code&&flow.row.offer_code===code)&&
                (step!=='button_text'||payload.value.length>=1&&payload.value.length<=60)&&
                (step!=='title'||payload.value.length>=1&&payload.value.length<=180)&&
                (step!=='category'||['debit','credit','business','loan','deposit','insurance','job','other'].includes(payload.value))&&
                (step!=='url'||payload.value==='-'||httpsUrl(payload.value)));
            } else valid=Boolean(payload&&Object.keys(payload).length===5&&payload.action==='create'&&
              typeof payload.buttonText==='string'&&payload.buttonText.length>=1&&payload.buttonText.length<=60&&
              typeof payload.title==='string'&&payload.title.length>=1&&payload.title.length<=180&&
              typeof payload.url==='string'&&(payload.url===''||httpsUrl(payload.url)));
            valid=valid&&!root&&!owner;
            dto.kind='admin_surface';dto.ref='catalog_creation';dto.ownerTelegramId=null;dto.tenantKey='admin';
          } else if(root) {
            const shape=payload&&Object.keys(payload).every(key=>['action','field','value','flowAction','flowStep'].includes(key));
            valid=Boolean(shape&&(payload.action==='delete'&&Object.keys(payload).length===1||payload.action==='edit'&&
              catalogFields.has(payload.field)&&typeof payload.value==='string'&&payload.value.length<=2500));
            if(payload?.flowAction!==undefined) {
              flow=await ownFlow('admin',payload);
              valid=valid&&flow?.row.action==='edit_offer'&&flow.row.offer_code===code&&flow.row.step===payload.field;
            }
            if(payload?.field==='status')valid=valid&&['draft','active','paused','archived'].includes(payload.value);
            dto.kind='offer';dto.ref=code;dto.ownerTelegramId=null;dto.tenantKey='admin';dto.status=root.status;
          } else missing();
          if(dto.exists) {
            const intent=Boolean(valid&&system&&actorFacts.canonicalOwner);
            dto.domain={adminTargetExplicit:true,targetVerified:creating?!root&&!owner:Boolean(root),
              adminPartnerContentEditForbidden:!system,actionConfirmed:intent,reasonPresent:intent,domainAuthorityValid:intent};
            dto.records={offer:databaseRow(root),owner:databaseRow(owner),adminFlow:flow?.row??null};
          }
        } else if(capability==='admin.entitlement.manage') {
          if(ref?.kind!=='entitlement_subject'||!positive(ref.key)) fail('invalid_resource_reference');
          const payload=trusted.requestPayload;
          const shape=payload&&typeof payload==='object'&&!Array.isArray(payload)&&
            Object.keys(payload).length===6&&['subjectTelegramId','capability','scopeKind','scopeKey','expiresAt','reason'].every(key=>Object.hasOwn(payload,key));
          const requested=shape?CAPABILITY_CATALOG.find(row=>row.capability===payload.capability):null;
          const boundaries=Boolean(requested&&requested.actor_kind==='customer'&&requested.future_release===null&&requested.availability!=='future_disabled'&&
            !/^(admin|service|crm|team|billing|preview)\./u.test(requested.capability)&&requested.capability!=='ai.provider.external.use');
          const target=await load('users','telegram_id=?',[ref.key]);
          const privacySql="SELECT COUNT(*) AS n FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending' AND unixepoch(expires_at)>unixepoch()";
          const privacyCount=(await read(privacySql,[ref.key]))[0]?.n;
          if(!Number.isSafeInteger(privacyCount)||privacyCount<0) fail('resource_unavailable');
          checks.push({sql:`(${privacySql})=?`,params:[ref.key,privacyCount]});
          let catalog=null,plans=[],published=false;
          if(requested) {
            catalog=await load('capability_catalog','policy_version=? AND capability=?',[FOUNDATION_POLICY_VERSION,requested.capability]);
            const sql=`SELECT COALESCE(json_group_array(json(snapshot)),'[]') FROM (SELECT ${jsonExpression(columns.plan_capabilities)} AS snapshot FROM plan_capabilities WHERE policy_version=? AND capability=? ORDER BY plan_code,access_overlay LIMIT 5)`;
            const params=[FOUNDATION_POLICY_VERSION,requested.capability];
            const encoded=Object.values((await read(sql,params))[0]??{})[0];
            if(typeof encoded!=='string') fail('resource_unavailable');plans=JSON.parse(encoded);
            checks.push({sql:`(${sql}) IS ?`,params:[...params,encoded]});
            const expected=PLAN_CAPABILITIES.filter(row=>row.capability===requested.capability).sort((a,b)=>a.plan_code.localeCompare(b.plan_code)||a.access_overlay.localeCompare(b.access_overlay));
            const equal=(a,b,fields)=>a&&fields.every(field=>a[field]===b[field]);
            published=Boolean(equal(catalog,requested,columns.capability_catalog)&&plans.length===4&&
              expected.every((row,index)=>equal(plans[index],row,columns.plan_capabilities)));
          }
          const expiry=shape&&positive(payload.expiresAt)&&payload.expiresAt>nowSeconds&&payload.expiresAt<=nowSeconds+30*86400;
          const intent=Boolean(shape&&boundaries&&published&&payload.subjectTelegramId===ref.key&&payload.scopeKind==='actor'&&
            payload.scopeKey===`actor:${ref.key}`&&typeof payload.reason==='string'&&payload.reason.trim()===payload.reason&&payload.reason.length>=1&&payload.reason.length<=1000&&expiry);
          const targetValid=Boolean(target&&target.accepted_terms===1&&target.is_blocked===0&&privacyCount===0&&ref.key!==subject);
          if(!target) missing();else {
            dto.kind='entitlement_subject';dto.ref=ref.key;dto.ownerTelegramId=ref.key;dto.tenantKey=`actor:${ref.key}`;
            dto.domain={adminTargetExplicit:true,targetVerified:targetValid,internalWriterReleased:trusted.env.V141_INTERNAL_METADATA_WRITER_ENABLED==='true',
              publishedPolicyBoundaries:boundaries&&published,temporaryExpiryValid:Boolean(expiry),authenticatedIssuer:actorFacts.canonicalOwner===true,
              actionConfirmed:intent,reasonPresent:intent,domainAuthorityValid:intent&&targetValid&&actorFacts.canonicalOwner===true};
            dto.records={targetUser:databaseRow(target),requestedCapabilityCatalog:catalog,requestedPlanCapabilities:plans};
          }
        } else if (plan) {
          if (ref?.kind!==plan[0] || !positive(ref.key) && plan[0]!=='payment') fail('invalid_resource_reference');
          const row=await load(plan[1],`${plan[2]}=?`,[ref.key]);
          if (!row) missing();
          else {
            dto.kind=plan[0];dto.status=row.status ?? row.order_state ?? null;
            dto.ownerTelegramId=row.telegram_id ?? null;
            dto.domain={adminTargetExplicit:true,targetVerified:true};
            dto.records={target:databaseRow(row)};
            if(capability==='admin.stars.refund') {
              const payload=trusted.requestPayload,config=readStarsOperationsConfig(trusted.env);
              if (payload && Object.keys(payload).length === 1 && typeof payload.ledgerEntryId === 'string') {
                const selected = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(payload.ledgerEntryId);
                const names = ['ledger_entry_id','order_id','telegram_id','entry_type','direction','currency','amount_stars',
                  'telegram_payment_charge_id','telegram_update_id','related_ledger_entry_id','reason_code','occurred_at','recorded_at'];
                const sql = `SELECT ${jsonExpression(names)} AS snapshot FROM payment_ledger
                  WHERE ledger_entry_id=? AND order_id=? AND telegram_id=? LIMIT 2`;
                const params = [payload.ledgerEntryId, row.order_id, subject];
                const paymentSnapshot = selected ? (await read(sql, params))[0]?.snapshot ?? null : null;
                if (selected) checks.push({ sql: `(${sql}) IS ?`, params: [...params, paymentSnapshot] });
                const payment = paymentSnapshot === null ? null : JSON.parse(paymentSnapshot);
                const compensation = payment ? await load('payment_ledger', "related_ledger_entry_id=? AND entry_type IN ('refund','chargeback')", [payment.ledger_entry_id]) : null;
                const refund = payment ? await load('payment_refunds', 'original_ledger_entry_id=?', [payment.ledger_entry_id]) : null;
                let packageSource = null, retained = null, monthlyRetained = null;
                if (payment?.entry_type === 'payment' && payment.direction === 'credit' && payment.currency === 'XTR' &&
                    payment.telegram_id === subject && row.telegram_id === subject) {
                  packageSource = await readPackageSettlementSource({ ...trusted.env, DB: db }, payment);
                  if (packageSource?.metadata?.billing_mode === 'prepaid') {
                    checks.push(packageSource.schemaAssertion);
                    if (payment.reason_code === 'package_payment_review_retained') {
                      retained = await readPackageRetainedReview({ ...trusted.env, DB: db }, payment);
                      checks.push(packagePaymentReviewSchemaAssertion(await inspectPackagePaymentReviewSchema(db, { required: true })));
                      const receiptSql = `SELECT json_array(ledger_entry_id,order_id,telegram_id,external_payload_sha256,evidence_sha256)
                        FROM subscription_package_payment_reviews WHERE ledger_entry_id=? LIMIT 1`;
                      const receiptValue = Object.values((await read(receiptSql, [payment.ledger_entry_id]))[0] ?? {})[0] ?? null;
                      checks.push({ sql: `(${receiptSql}) IS ?`, params: [payment.ledger_entry_id, receiptValue] });
                    }
                  } else if (packageSource?.metadata?.billing_mode === 'recurring') {
                    monthlyRetained = await readReservedMonthlyRetainedSettlementSource({ ...trusted.env, DB: db }, payment, packageSource);
                    if (monthlyRetained) checks.push(...monthlyRetained.assertions);
                  }
                }
                const sameRequest = !refund || refund.order_id === row.order_id && refund.original_ledger_entry_id === payment?.ledger_entry_id &&
                  refund.telegram_id === subject && refund.requested_by_type === 'admin' && refund.requested_by === subject &&
                  refund.reason_code === 'package_customer_refund' && refund.amount_stars === payment?.amount_stars && refund.currency === 'XTR';
                const alreadyRefunded = compensation?.entry_type === 'refund' && compensation.related_ledger_entry_id === payment?.ledger_entry_id &&
                  compensation.order_id === row.order_id && compensation.telegram_id === subject && compensation.currency === 'XTR' &&
                  compensation.amount_stars === payment?.amount_stars && compensation.telegram_payment_charge_id === payment?.telegram_payment_charge_id;
                const intent = Boolean(selected && (packageSource?.metadata?.billing_mode === 'prepaid' &&
                  (packageSource.period || retained) || monthlyRetained) && sameRequest && (!compensation || alreadyRefunded) &&
                  (['paid','applied','refunded'].includes(row.order_state) || (retained || monthlyRetained) && ['failed','cancelled'].includes(row.order_state)) &&
                  trusted.env.STARS_PACKAGE_REFUNDS_ENABLED === 'true' && actorFacts.canonicalOwner && trusted.channel === 'mini_app');
                dto.domain.actionConfirmed = intent; dto.domain.reasonPresent = intent; dto.domain.domainAuthorityValid = intent;
                dto.domain.ownPackageChargeRefundVerified = intent;
                dto.records.originalPayment = databaseRow(payment); dto.records.refundRequest = databaseRow(refund);
              } else {
              const shape=payload&&Object.keys(payload).length===3&&payload.action==='refund'&&
                payload.orderId===row.order_id&&payload.reasonCode==='admin_canary_validation'&&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(row.order_id);
              const payment=await load('payment_ledger',"order_id=? AND entry_type='payment' AND direction='credit'",[row.order_id]);
              const compensation=payment?await load('payment_ledger',"related_ledger_entry_id=? AND entry_type IN ('refund','chargeback')",[payment.ledger_entry_id]):null;
              const refund=payment?await load('payment_refunds','telegram_payment_charge_id=?',[payment.telegram_payment_charge_id]):null;
              const sameRequest=refund===null||refund.status==='requested'&&refund.order_id===row.order_id&&
                refund.original_ledger_entry_id===payment?.ledger_entry_id&&refund.telegram_id===subject&&
                refund.requested_by_type==='admin'&&refund.requested_by===subject&&refund.reason_code===payload?.reasonCode&&
                refund.amount_stars===payment?.amount_stars&&refund.currency==='XTR';
              const source=Boolean(row.telegram_id===subject&&['paid','applied'].includes(row.order_state)&&
                payment?.telegram_id===subject&&payment.currency==='XTR'&&payment.amount_stars===row.amount_stars&&
                positive(payment.amount_stars)&&typeof payment.telegram_payment_charge_id==='string'&&
                payment.telegram_payment_charge_id.length>0&&!compensation&&sameRequest);
              const intent=Boolean(shape&&source&&config.refundsEnabled&&actorFacts.canonicalOwner);
              dto.domain.actionConfirmed=intent;dto.domain.reasonPresent=intent;dto.domain.domainAuthorityValid=intent;
              dto.records.originalPayment=databaseRow(payment);dto.records.refundRequest=databaseRow(refund);
              }
            }
            if(capability==='admin.partner_link.review') {
              const payload=trusted.requestPayload,profile=await load('partner_profiles','id=?',[row.partner_profile_id]);
              const catalog=await load('program_offers','id=?',[row.catalog_offer_id]);
              const program=catalog?await load('partner_programs','code=?',[catalog.program_code]):null;
              const root=catalog?await load('offers','code=?',[catalog.offer_code]):null;
              const approval=payload?.decision==='approve'&&Object.keys(payload).length===1&&profile?.status==='active'&&
                catalog?.status==='active'&&program?.status==='active'&&root?.status==='active'&&validWindow(root,nowSeconds)&&
                row.ownership_confirmed===1&&row.traffic_confirmed===1&&allowedUrl(row.url,program.allowed_domains);
              const rejection=payload?.decision==='reject'&&Object.keys(payload).length===2&&typeof payload.reason==='string'&&
                payload.reason.trim().length>=1&&payload.reason.length<=300;
              const intent=Boolean(row.status==='pending'&&(approval||rejection)&&actorFacts.canonicalOwner&&profile&&profile.telegram_id!==subject);
              dto.domain.actionConfirmed=intent;dto.domain.reasonPresent=intent;dto.domain.domainAuthorityValid=intent;
              Object.assign(dto.records,{partnerProfile:databaseRow(profile),catalogOffer:databaseRow(catalog),program:databaseRow(program),catalogRoot:databaseRow(root)});
            }
            if(capability==='admin.user.moderation') {
              const payload=trusted.requestPayload,settings=await load('admin_safety_runtime_settings','id=1',[]);
              const previous=await load('user_moderation_blocks','target_telegram_id=?',[row.telegram_id]);
              let session=null,intent=false;
              if(trusted.channel==='mini_app'&&trusted.env.V141_ADMIN_MINI_APP_ENABLED==='true'&&
                  trusted.env.V141_RELEASE_MODE==='owner_only'&&typeof trusted.verifiedSessionId==='string'&&
                  payload&&Object.keys(payload).length===5&&
                  ['action','targetTelegramId','expectedRevision','reason','confirmed'].every(key=>Object.hasOwn(payload,key))) {
                const revision=previous?.revision??0;
                intent=Boolean(payload.confirmed===true&&payload.targetTelegramId===row.telegram_id&&
                  Number.isSafeInteger(payload.expectedRevision)&&payload.expectedRevision>=0&&payload.expectedRevision===revision&&
                  typeof payload.reason==='string'&&payload.reason.trim()===payload.reason&&
                  Array.from(payload.reason).length>=3&&Array.from(payload.reason).length<=300&&
                  (payload.action==='block'&&(!previous||previous.status==='revoked')||
                   payload.action==='unblock'&&previous?.status==='active'));
              } else if(payload?.action==='block'&&Object.keys(payload).length===4) {
                session=await load('admin_moderation_sessions','admin_telegram_id=?',[subject]);
                intent=Boolean(session?.step==='confirm'&&session.target_telegram_id===row.telegram_id&&
                  payload.targetTelegramId===row.telegram_id&&session.reason===payload.reason&&session.expires_at===payload.sessionExpiresAt&&
                  session.expires_at>nowSeconds&&typeof payload.reason==='string'&&payload.reason.trim().length>=3&&payload.reason.length<=300&&
                  (!previous||previous.status==='revoked'));
                if(positive(session?.expires_at))deadlines.push(session.expires_at);
              } else if(payload?.action==='unblock'&&Object.keys(payload).length===3)intent=Boolean(
                payload.targetTelegramId===row.telegram_id&&positive(payload.expectedRevision)&&previous?.status==='active'&&previous.revision===payload.expectedRevision);
              const valid=Boolean(intent&&trusted.env.ADMIN_MODERATION_ENABLED==='true'&&settings?.moderation_enabled===1&&
                row.telegram_id!==subject&&actorFacts.canonicalOwner);
              dto.domain.actionConfirmed=valid;dto.domain.reasonPresent=valid;dto.domain.domainAuthorityValid=valid;
              Object.assign(dto.records,{moderationSettings:databaseRow(settings),moderationSession:databaseRow(session),previousBlock:databaseRow(previous)});
            }
            if(plan[1]==='partner_applications') {
              const existingProfile=await load('partner_profiles','telegram_id=?',[row.telegram_id]);
              dto.records.application=databaseRow(row);dto.records.existingProfile=databaseRow(existingProfile);
              const payload=trusted.requestPayload;
              const repair=capability==='admin.partner.repair';
              const shape=payload && typeof payload==='object' && !Array.isArray(payload) &&
                Object.keys(payload).every(key=>(repair?[]:['decision','reason']).includes(key));
              const decision=payload?.decision,reason=payload?.reason??'';
              const intent=shape && (repair?true:['approve','reject'].includes(decision) && typeof reason==='string' && reason.length<=300 &&
                (decision==='approve' || reason.trim().length>0));
              dto.domain.actionConfirmed=Boolean(intent);dto.domain.reasonPresent=Boolean(intent);
              dto.domain.domainAuthorityValid=Boolean(intent && actorFacts.canonicalOwner && row.telegram_id!==subject &&
                (repair?row.status==='approved':['pending',decision==='approve'?'approved':'rejected'].includes(row.status)) &&
                (repair || decision!=='approve' || row.age_confirmed===1));
            }
            if(capability==='admin.partner.beta.manage') {
              const payload=trusted.requestPayload;
              const finite=payload && Object.keys(payload).every(key=>['action','durationSeconds'].includes(key))&&payload.action==='grant'&&payload.durationSeconds===3600;
              const legacy=payload&&Object.keys(payload).every(key=>['action','reason'].includes(key))&&
                ['grant','resume','pause','revoke'].includes(payload.action)&&typeof (payload.reason??'')==='string'&&(payload.reason??'').length<=300&&
                (!['pause','revoke'].includes(payload.action)||(payload.reason??'').trim().length>=3);
              const user=await load('users','telegram_id=?',[row.telegram_id]);
              const application=await load('partner_applications','id=?',[row.application_id]);
              const role=await load('user_roles',"telegram_id=? AND role='partner'",[row.telegram_id]);
              const adminRole=await load('user_roles',"telegram_id=? AND role='admin'",[row.telegram_id]);
              const beta=await load('partner_beta_access','partner_profile_id=?',[row.id]);
              const pendingSql="SELECT COUNT(*) AS n FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending' AND unixepoch(expires_at)>unixepoch()";
              const pending=(await read(pendingSql,[row.telegram_id]))[0]?.n;
              if(!Number.isSafeInteger(pending)||pending<0)fail('resource_unavailable');
              checks.push({sql:`(${pendingSql})=?`,params:[row.telegram_id,pending]});
              const adult=application?.telegram_id===row.telegram_id&&application.status==='approved'&&application.age_confirmed===1;
              const growth=['grant','resume'].includes(payload?.action);
              const status=beta?.access_status??'',end=databaseSeconds(beta?.expires_at);
              const expired=status==='active'&&end!==null&&end<=nowSeconds;
              const transition=finite?!['paused','revoked'].includes(status):payload?.action==='grant'?['','revoked','active'].includes(status):
                payload?.action==='resume'?['paused','active'].includes(status):payload?.action==='pause'?['active','paused'].includes(status):
                payload?.action==='revoke'?['active','paused','revoked'].includes(status):false;
              if(expired)checks.push({sql:'unixepoch()>=?',params:[end]});
              const targetValid=user?.is_blocked===0&&user.accepted_terms===1&&pending===0&&adult&&adminRole?.status!=='active'&&
                (!growth||row.status==='active'&&role?.status==='active');
              const intent=Boolean((finite||legacy)&&transition&&targetValid);
              dto.domain.actionConfirmed=intent;dto.domain.reasonPresent=intent;
              dto.domain.domainAuthorityValid=Boolean(intent&&actorFacts.canonicalOwner&&row.telegram_id!==subject);
              dto.records.targetUser=databaseRow(user);dto.records.application=databaseRow(application);dto.records.betaAccess=databaseRow(beta);
            }
            if (plan[1]==='lead_requests') {
              const attribution=await load('lead_partner_attribution','lead_id=?',[row.id]);
              dto.records.existingLead=databaseRow(row);
              dto.records.existingAttribution=attribution ? {...databaseRow(attribution),inviterId:row.inviter_id} : null;
              dto.records.compatibilityConversion=databaseRow(await load('conversions','telegram_id=? AND offer_code=?',[row.telegram_id,row.offer_code]));
              const payload=trusted.requestPayload;
              const decision=payload?.decision;
              const reward=payload?.rewardKopecks;
              const reason=payload?.reason;
              const shape=payload && typeof payload==='object' && !Array.isArray(payload) &&
                Object.keys(payload).every(key=>['leadId','decision','rewardKopecks','reason'].includes(key)) &&
                payload.leadId===row.id && ['confirm','reject','mark_paid'].includes(decision);
              const transition=decision==='confirm' && row.status==='pending' ||
                decision==='reject' && row.status==='pending' || decision==='mark_paid' && row.status==='confirmed';
              const validIntent=shape && (decision==='confirm' ? Number.isSafeInteger(reward) && reward>=0 && reward<=1_000_000_000_000 && reason===undefined :
                decision==='reject' ? typeof reason==='string' && reason.trim().length>=1 && reason.length<=300 && reward===undefined : reward===undefined && reason===undefined);
              dto.domain.actionConfirmed=Boolean(validIntent);
              dto.domain.reasonPresent=decision!=='reject' || Boolean(validIntent);
              dto.domain.domainAuthorityValid=Boolean(validIntent && transition && actorFacts.canonicalOwner && row.telegram_id!==subject);
              dto.domain.transitionAllowed=Boolean(transition);
              dto.operationAfterStatus=decision==='confirm'?'confirmed':decision==='reject'?'rejected':decision==='mark_paid'?'paid':row.status;
            }
          }
        } else if (['admin.offer.moderate','admin.offer.visibility','admin.offer.assign','admin.catalog.manage'].includes(capability)) {
          if (ref?.kind!=='offer') fail('invalid_resource_reference');
          const facts=await offer(ref.key);
          if (!facts) missing();
          else {
            attachOffer(facts);
            dto.domain.adminTargetExplicit=true;dto.domain.targetVerified=true;
            dto.domain.adminPartnerContentEditForbidden=capability==='admin.catalog.manage' && facts.owner.owner_kind==='partner';
            dto.records={offer:databaseRow(facts.root),owner:databaseRow(facts.owner),visibilityRule:databaseRow(facts.rule),
              currentVersion:databaseRow(facts.version),partnerProfile:databaseRow(facts.ownerProfile),ownerProfile:databaseRow(facts.ownerProfile),
              currentRoute:facts.link && facts.catalog && facts.program && facts.destination ?
                {authoritySource:'database',partnerLinkId:facts.link.id,partnerProfileId:facts.link.partner_profile_id,
                  ownerProfileStatus:facts.ownerProfile?.status,partnerLinkStatus:facts.link.status,
                  ownershipConfirmed:facts.link.ownership_confirmed,trafficConfirmed:facts.link.traffic_confirmed,
                  catalogOfferId:facts.catalog.id,catalogOfferCode:facts.catalog.offer_code,catalogOfferStatus:facts.catalog.status,
                  programCode:facts.program.code,programStatus:facts.program.status,catalogBusinessStatus:facts.destination.status,
                  url:facts.link.url,trackingKey:facts.link.tracking_key,allowedDomains:facts.program.allowed_domains,updatedAt:facts.link.updated_at}:null};
            dto.records.aggregate={...dto.records};
            if(['admin.offer.moderate','admin.offer.visibility','admin.offer.assign'].includes(capability)) {
              const payload=trusted.requestPayload;
              const fields=capability==='admin.offer.moderate'?['version','expectedVersionId','decision','reason']:
                capability==='admin.offer.visibility'?['version','expectedVersionId','visibility','reason']:['targetTelegramId','action','reason','expectedVersionId'];
              const shape=payload && typeof payload==='object' && !Array.isArray(payload) && Object.keys(payload).every(key=>fields.includes(key));
              const reason=payload?.reason??'';
              const versionMatches=payload && (positive(payload.version) && payload.expectedVersionId===undefined && payload.version===facts.version?.version_number ||
                positive(payload.expectedVersionId) && payload.version===undefined && payload.expectedVersionId===facts.rule?.current_version_id);
              const moderation=capability==='admin.offer.moderate';
              const assignment=capability==='admin.offer.assign';
              let intent=Boolean(shape && typeof reason==='string' && reason.length<=300 && (assignment?
                positive(payload.targetTelegramId) && ['assign','revoke'].includes(payload.action) &&
                  (payload.expectedVersionId===undefined || positive(payload.expectedVersionId) && payload.expectedVersionId===facts.rule?.current_version_id):versionMatches && (moderation?
                ['approved','changes_requested','rejected'].includes(payload.decision) && (payload.decision==='approved' || reason.trim().length>0):
                ['private','assigned','public'].includes(payload.visibility))));
              const assignmentSql="SELECT COUNT(*) AS n FROM offer_visibility_assignments WHERE offer_code=? AND assignment_status='active'";
              const active=(await read(assignmentSql,[ref.key]))[0]?.n;
              if(!Number.isSafeInteger(active) || active<0) fail('resource_unavailable');
              checks.push({sql:`(${assignmentSql})=?`,params:[ref.key,active]});
              dto.records.assignmentCount={authoritySource:'database',offerCode:ref.key,activeAssignmentCount:active};
              if(assignment && positive(payload?.targetTelegramId)) {
                const targetUser=await load('users','telegram_id=?',[payload.targetTelegramId]);
                const existingAssignment=await load('offer_visibility_assignments','offer_code=? AND telegram_id=?',[ref.key,payload.targetTelegramId]);
                dto.records.targetUser=databaseRow(targetUser);dto.records.existingAssignment=databaseRow(existingAssignment);
                const pendingSql="SELECT COUNT(*) AS n FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending' AND unixepoch(expires_at)>?";
                const pending=(await read(pendingSql,[payload.targetTelegramId,nowSeconds]))[0]?.n;
                checks.push({sql:'(SELECT COUNT(*) FROM privacy_deletion_requests WHERE telegram_id=? AND status=\'pending\' AND unixepoch(expires_at)>unixepoch())=?',params:[payload.targetTelegramId,pending]});
                intent=intent && targetUser?.is_blocked===0 && targetUser.accepted_terms===1 && pending===0 && payload.targetTelegramId!==subject;
              }
              dto.domain.actionConfirmed=Boolean(intent);dto.domain.reasonPresent=Boolean(intent);
              dto.domain.domainAuthorityValid=Boolean(intent && actorFacts.canonicalOwner && facts.owner.owner_kind==='partner' && facts.ownerProfile?.telegram_id!==subject);
              if(!assignment) dto.domain.expectedVersionMismatch=!versionMatches;
            }
          }
        } else if (Object.hasOwn(adminSurfaces,capability)) {
          const surface=adminSurfaces[capability];
          if (ref !== null && (ref.kind!=='admin_surface' || ref.key!==surface)) fail('invalid_resource_reference');
          dto.kind='admin_surface';dto.ref=surface;dto.ownerTelegramId=null;dto.tenantKey='admin';
          dto.domain={adminTargetExplicit:true,targetVerified:true,fixedNamespace:surface};
          if(capability==='admin.stars.reconcile') {
            const intent=trusted.requestPayload&&Object.keys(trusted.requestPayload).length===1&&
              trusted.requestPayload.action==='reconcile'&&readStarsOperationsConfig(trusted.env).reconciliationEnabled&&actorFacts.canonicalOwner;
            dto.domain.actionConfirmed=Boolean(intent);dto.domain.reasonPresent=Boolean(intent);dto.domain.domainAuthorityValid=Boolean(intent);
          }
          if(capability==='admin.broadcast.send') {
            const payload=trusted.requestPayload;
            const gate=await load('admin_broadcast_release_gate','id=1',[]);
            let intent=false,row=null,flow=null;
            if(payload?.action==='prepare'&&Object.keys(payload).length===4&&typeof payload.messageText==='string'&&
              payload.messageText.trim().length>=1&&payload.messageText.length<=1000) {
              flow=await ownFlow('admin',payload);
              intent=flow?.row.action==='compose_broadcast'&&flow.row.step==='message'&&Object.keys(flow.staged).length===0;
            } else if(payload&&Object.keys(payload).length===2&&['send','continue','cancel'].includes(payload.action)&&positive(payload.broadcastId)) {
              row=await load('admin_broadcasts','id=? AND actor_id=?',[payload.broadcastId,subject]);
              intent=Boolean(row&&(payload.action==='send'?['draft','sending'].includes(row.status):
                payload.action==='continue'?row.status==='sending':['draft','cancelled'].includes(row.status)));
            }
            intent=Boolean(intent&&actorFacts.canonicalOwner&&
              (payload?.action==='cancel'||payload?.action==='prepare'||gate?.paused===0));
            dto.domain.actionConfirmed=intent;dto.domain.reasonPresent=intent;dto.domain.domainAuthorityValid=intent;
            dto.records={broadcast:databaseRow(row),adminFlow:flow?.row??null,releaseGate:databaseRow(gate)};
          }
          if(capability==='admin.settings.manage') {
            const payload=trusted.requestPayload;
            let intent=false,row=null;
            if(trusted.channel==='mini_app'&&trusted.env.V141_ADMIN_MINI_APP_ENABLED==='true'&&
                trusted.env.V141_RELEASE_MODE==='owner_only'&&typeof trusted.verifiedSessionId==='string'&&
                payload&&Object.keys(payload).length===5&&payload.action==='update_setting'&&
                ['action','key','value','expectedValue','confirmed'].every(key=>Object.hasOwn(payload,key))&&payload.confirmed===true) {
              if(payload.key==='ai_rollout_mode') {
                row=await load('ai_runtime_settings','id=1',[]);
                intent=Boolean(row&&['off','admin','all'].includes(payload.value)&&['off','admin','all'].includes(payload.expectedValue)&&
                  row.rollout_mode===payload.expectedValue);
                if(intent&&payload.value==='all'&&row.rollout_mode!=='all') {
                  const readiness=projectPublicAiEnablement(trusted.publicAiProviderConnected===true,(await read(AI_PUBLIC_SOURCE_READINESS_SQL,[]))[0]);
                  intent=readiness.ready;
                  // The fixed ready predicate is rechecked in the management
                  // transaction before any receipt, setting or audit commits.
                  checks.push({sql:AI_PUBLIC_SOURCE_READINESS_PREDICATE,params:[]});
                }
              } else if(['official_web_enabled','official_web_stale_enabled'].includes(payload.key)) {
                row=await load('official_web_settings','id=1',[]);
                const current=payload.key==='official_web_enabled'?row?.enabled:row?.stale_enabled;
                intent=Boolean(row&&typeof payload.value==='boolean'&&typeof payload.expectedValue==='boolean'&&
                  current===Number(payload.expectedValue));
              }
            } else if(payload?.action==='sync_menu'&&Object.keys(payload).length===1)intent=true;
            else if(payload?.action==='setting'&&Object.keys(payload).length===2&&typeof payload.selector==='string') {
              const selector=payload.selector;
              if(/^admin_ow_toggle:(enabled|admin_only|stale_enabled):(0|1)$/u.test(selector)) {
                row=await load('official_web_settings','id=1',[]);intent=Boolean(row);
              } else if(/^admin_ai_mode:(off|admin)$/u.test(selector)||selector==='admin_ai_mode_confirm:all') {
                row=await load('ai_runtime_settings','id=1',[]);intent=Boolean(row);
              } else {
                const official=/^admin_ow_(status|check):([1-9][0-9]*)(?::(active|paused))?$/u.exec(selector);
                const snapshot=/^admin_ai_source_(approve|reject):([1-9][0-9]*)$/u.exec(selector);
                const refresh=/^admin_ai_source_refresh:([a-z0-9_-]{2,32})$/u.exec(selector);
                if(official&&positive(Number(official[2]))&&(official[1]==='check'?official[3]===undefined:Boolean(official[3]))) {
                  row=await load('official_sources','id=?',[Number(official[2])]);
                  intent=Boolean(row&&row.scheme==='https'&&row.status!=='disabled'&&/^[a-z0-9.-]+$/u.test(row.hostname_ascii));
                } else if(snapshot&&positive(Number(snapshot[2]))) {
                  row=await load('ai_source_snapshots','id=?',[Number(snapshot[2])]);intent=Boolean(row);
                } else if(refresh) {
                  row=await load('partner_programs','code=?',[refresh[1]]);intent=Boolean(row?.status==='active'&&httpsUrl(row.official_url));
                }
              }
            }
            intent=Boolean(intent&&actorFacts.canonicalOwner);
            dto.domain.actionConfirmed=intent;dto.domain.reasonPresent=intent;dto.domain.domainAuthorityValid=intent;
            dto.records={settingsTarget:databaseRow(row)};
          }
        } else {missing();dto.reasonCode='resource_adapter_unavailable';}
      } else if (capability==='analytics.compare_periods') {
        if(ref!==null) fail('invalid_resource_reference');
        const p=await ownProfile();
        const ambassador=p ? await load('ambassador_profiles_v2','partner_profile_id=?',[p.id]) : null;
        const activation=ambassador ? await load('ambassador_profile_transitions',
          "ambassador_id=? AND from_status='draft' AND to_status='active' AND reason_code='activation_approved' AND actor_kind='admin'",[ambassador.ambassador_id]) : null;
        const settings=await load('analytics_v2_settings','id=1',[]);
        const audience=await load('analytics_v139_owner_runtime','id=1',[]);
        const pilot=actorFacts.canonicalOwner ? null : await load('analytics_v139_partner_pilot','telegram_id=?',[subject]);
        const shadowSql='SELECT COUNT(*) AS n FROM analytics_v139_active_shadow_authority';
        const shadow=(await read(shadowSql,[]))[0]?.n;
        if(!Number.isSafeInteger(shadow) || shadow<0 || shadow>1) fail('resource_unavailable');
        checks.push({sql:`(${shadowSql})=?`,params:[shadow]});
        const config=readAnalyticsV2Config(trusted.env);
        const released=Boolean(config.configurationValid && config.rolloutMode==='admin_shadow' &&
          config.masterEnabled && config.ingestEnabled && config.projectionsEnabled && config.ambassadorEnabled &&
          settings?.rollout_mode==='admin_shadow' && audience?.audience_mode==='owner_only' && audience.enabled===1 && shadow===1 &&
          (actorFacts.canonicalOwner || pilot?.enabled===1 && pilot.expires_at>nowSeconds));
        if(!p || p.status!=='active' || ambassador?.status!=='active' || !activation) missing();
        else {
          dto.kind='partner_projection';dto.ref=p.id;dto.partnerProfileId=p.id;dto.ambassadorId=ambassador.ambassador_id;
          dto.tenantKey=`partner:${p.id}`;dto.status=p.status;
          dto.domain={handlerUnavailable:!released,ownerProjectionVerified:true,privacySuppressionRequired:true,
            releasedRuleAndRollout:released};
          dto.records={partnerProfile:databaseRow(p),ambassadorProfile:databaseRow(ambassador),activation:databaseRow(activation)};
          if(pilot?.expires_at>nowSeconds) deadlines.push(pilot.expires_at);
        }
      } else if (['preview.activate_own','referral.bonus.claim_own'].includes(capability)) {
        if(ref!==null)fail('invalid_resource_reference');
        const source=await resolveLegacyAccessSources({context,actor});
        if(readLegacyAccessSourceContext(source)!==context)fail('untrusted_resource');
        const facts=readLegacyAccessSourceFacts(source),proof=compileLegacyAccessSourceAssertions(source);
        dto.domain={...facts.domain};dto.records={...facts.canonical};
        if(!Array.isArray(proof.assertions)||proof.assertions.length>14)fail('resource_unavailable');
        checks.push(...proof.assertions);deadlines.push(facts.validUntil);
      } else if (ownCapabilities.has(capability)) {
        if (capability.startsWith('billing.') && ref !== null) {
          if (ref.kind!=='payment') fail('invalid_resource_reference');
          const row=await load('subscription_orders','order_id=? AND telegram_id=?',[ref.key,subject]);
          if (!row) missing();else {dto.kind='payment';dto.status=row.order_state;}
        } else if (ref !== null) fail('invalid_resource_reference');
        if(capability==='billing.purchase_monthly') {
          const payload=trusted.requestPayload,recurring=payload?.billingMode==='recurring';
          const config=recurring?readStarsRecurringConfig(trusted.env):readStarsCoreConfig(trusted.env);
          const shape=payload&&['professional','dragon'].includes(payload.requestedPlanCode)&&
            (recurring?Object.keys(payload).length===6&&payload.action==='accept'&&payload.recurringConsent===true&&
              payload.termsRevision===config.termsRevision&&payload.priceVersion===config.priceVersion:
              Object.keys(payload).length===2&&['open','accept'].includes(payload.action));
          const priceSql=`SELECT COALESCE(json_group_array(json(snapshot)),'[]') FROM (SELECT ${jsonExpression(columns.price_book)} AS snapshot FROM price_book WHERE plan_code IN ('professional','dragon') AND billing_mode=? AND price_version=? AND access_seconds=? AND terms_revision=? ORDER BY plan_code,price_id LIMIT 3)`;
          const priceParams=[config.billingMode,config.priceVersion,STARS_MONTH_SECONDS,config.termsRevision];
          const pricesValue=Object.values((await read(priceSql,priceParams))[0]??{})[0];
          if(typeof pricesValue!=='string')fail('resource_unavailable');
          const prices=JSON.parse(pricesValue);if(!Array.isArray(prices)||prices.length>2)fail('resource_unavailable');
          checks.push({sql:`(${priceSql}) IS ?`,params:[...priceParams,pricesValue]});
          let selected=null,catalogReady=false;
          try {
            const professional=selectServerPrice(prices,'professional',config,nowSeconds);
            const dragon=selectServerPrice(prices,'dragon',config,nowSeconds);
            selected=payload?.requestedPlanCode==='professional'?professional:payload?.requestedPlanCode==='dragon'?dragon:null;
            catalogReady=true;
            for(const price of [professional,dragon])if(positive(price.validUntil))deadlines.push(price.validUntil);
          }catch{}
          const acceptance=await load('terms_acceptances',"telegram_id=? AND terms_revision=? AND acceptance_scope='stars_purchase'",[subject,config.termsRevision]);
          const current=await load('subscriptions',"telegram_id=? AND status IN ('active','cancel_at_period_end','suspended')",[subject]);
          const live=positive(current?.current_period_end)&&current.current_period_end>nowSeconds;
          if(positive(current?.current_period_end)) {
            if(live)deadlines.push(current.current_period_end);
            else checks.push({sql:'unixepoch()>=?',params:[current.current_period_end]});
          }
          const transition=actorFacts.access?.storedState!=='suspended'&&actorFacts.access?.storedPlan!=='team'&&
            (recurring?!live&&current?.status!=='suspended':live?current.status!=='suspended'&&current.plan_code===payload?.requestedPlanCode:
              !(['professional','dragon'].includes(actorFacts.access?.storedPlan)&&['active','cancel_at_period_end'].includes(actorFacts.access?.storedState)));
          const released=await starsRolloutEligible(trusted.env,subject,config.ready);
          const intent=Boolean(shape&&selected&&transition&&released&&actorFacts.account.acceptedTerms&&!actorFacts.account.isBlocked);
          dto.domain.starsPurchaseReleased=released;dto.domain.pricebookVerified=catalogReady;
          dto.domain.actionConfirmed=intent;dto.domain.domainAuthorityValid=intent;
          dto.records={serverPrice:selected,starsTermsAcceptance:databaseRow(acceptance),currentSubscription:databaseRow(current),
            ...(recurring?{recurringConsentConfirmed:Boolean(shape),recurringTermsRevision:config.termsRevision}: {})};
        }
        // This is only a restricted principal/read proof for the fixed cancel
        // adapter. Its separate private bridge verifies the own paid contract
        // and every effect fence; this exception grants no provider permission.
        if(capability==='access.read_own'&&trusted.requestPayload?.subscriptionAction==='cancel_renewal'&&
            Object.keys(trusted.requestPayload).length===3&&typeof trusted.requestPayload.contractId==='string'&&
            positive(trusted.requestPayload.expectedRevision)) dto.domain.existingAccountException='access.read_own';
        if(capability==='partner.apply') {
          dto.records={application:databaseRow(await load('partner_applications','telegram_id=?',[subject])),
            partnerProfile:databaseRow(await ownProfile())};
        }
        if(capability==='partner.public_username.update_own') {
          const p=await ownProfile(),settings=await load('partner_public_settings','telegram_id=?',[subject]);
          dto.records={partnerProfile:databaseRow(p),publicSettings:databaseRow(settings)};
          dto.partnerProfileId=p?.id??null;
          dto.domain.enablingUsername=trusted.requestPayload?.enabled===true;
          dto.domain.usernameExists=typeof p?.telegram_username==='string' && /^[A-Za-z0-9_]{5,32}$/u.test(p.telegram_username);
        }
      } else { missing();dto.reasonCode='resource_adapter_unavailable'; }
      if(dto.exists && (capability==='ai.public_chat' || capability.startsWith('ai.partner_draft') || capability==='ai.provider.external.use')) {
        const ai=await loadAiQuotaFacts(actor);
        const aiProof=compileAiQuotaFactsAssertions(ai);
        dto.ai=ai;
        checks.push({sql:aiProof.sql,params:[...aiProof.params]});
        if(positive(aiProof.validUntil)) deadlines.push(aiProof.validUntil);
      }
      if (!dto.exists) delete dto.records;
      const validUntil=Math.min(trusted.expiresAt,...deadlines);
      dto.validUntil=validUntil;
      const sql='unixepoch() < ?'+(checks.length ? ' AND '+checks.map(check=>check.sql).join(' AND ') : '');
      const params=[validUntil,...checks.flatMap(check=>check.params)];
      const sourceFingerprint=await sha256(JSON.stringify({capability,operation,subject,requestId,checks}));
      dto.canonical=dto.records ?? {};
      if (dto.exists) {
        dto.canonical.actor=actorFacts.canonical;
      }
      delete dto.records;
      const beforeStatus=dto.status;
      const transitions={'offer.archive_own':'archived','offer.pause_own':'paused','offer.activate_own':'active',
        'application.create':'pending','application.resubmit':'pending','campaign.activate':'active',
        'campaign.resume':'active','campaign.pause':'paused','campaign.archive':'archived'};
      dto.operationFacts={beforeStatus,afterStatus:dto.operationAfterStatus ?? transitions[capability] ?? beforeStatus,
        fixedTransition:dto.domain.transitionAllowed === true,replayAcknowledgement:false,receiptVerified:false};
      dto.domain.transitionValid=dto.domain.transitionAllowed ?? true;
      dto.domain.ownerKind=dto.canonical.owner?.ownerKind ?? null;
      if(capability==='offer.archive_own' && dto.exists && dto.status!=='archived') dto.quotaDelta=-1;
      if(['campaign.pause','campaign.archive'].includes(capability) && dto.status==='active') dto.quotaDelta=-1;
      const result=Object.freeze({resourceVersion:RESOURCE_RESOLVER_VERSION});
      factsByResource.set(result,freeze(dto));
      contexts.set(result,context);
      proofs.set(result,freeze({sql,params,validUntil,
        resourceScope:dto.tenantKey,sourceFingerprint}));
      let replay={sql:'0=1',params:[]};
      if (dto.exists) {
        if (capability.startsWith('offer.') && dto.partnerProfileId != null && dto.ownerTelegramId===subject) {
          replay={sql:"EXISTS(SELECT 1 FROM offer_owners own JOIN partner_profiles p ON p.id=own.partner_profile_id WHERE own.offer_code=? AND own.owner_kind='partner' AND p.telegram_id=?)",params:[dto.ref,subject]};
        } else if (['application.create','application.resubmit','application.read_own'].includes(capability)) {
          const offerCode=dto.canonical.existingLead?.offerCode ?? dto.canonical.eligibleOffer?.offerCode;
          replay={sql:'EXISTS(SELECT 1 FROM lead_requests WHERE telegram_id=? AND offer_code=?)',params:[subject,offerCode]};
        } else if (capability.startsWith('campaign.') && dto.ambassadorId != null) {
          replay={sql:'EXISTS(SELECT 1 FROM ambassador_campaigns c JOIN ambassador_profiles_v2 a ON a.ambassador_id=c.ambassador_id JOIN partner_profiles p ON p.id=a.partner_profile_id WHERE c.campaign_id=? AND p.telegram_id=?)',params:[dto.ref,subject]};
        } else if (capability==='offer.create_private') {
          replay={sql:'EXISTS(SELECT 1 FROM partner_profiles WHERE id=? AND telegram_id=?)',params:[dto.partnerProfileId,subject]};
        } else if (capability==='admin.application.result' && dto.canonical.existingLead) {
          const lead=dto.canonical.existingLead;
          replay={sql:'EXISTS(SELECT 1 FROM lead_requests WHERE id=? AND telegram_id=?)',params:[lead.id,lead.telegramId]};
        } else if (ownCapabilities.has(capability) && ref===null) replay={sql:'1=1',params:[]};
      }
      replayProofs.set(result,freeze(replay));
      return result;
    },
  });
}

export const isTrustedResource = value => factsByResource.has(value);
export function readResourceFacts(resource) {
  if (!factsByResource.has(resource)) fail('untrusted_resource');
  return factsByResource.get(resource);
}
export function readResourceContext(resource) {
  if (!contexts.has(resource)) fail('untrusted_resource');
  return contexts.get(resource);
}

export function compileResourceAssertions(resource) {
  const proof=proofs.get(resource);
  if (!proof) fail('untrusted_resource');
  return proof;
}
export function compileResourceReplayAssertions(resource) {
  if (!replayProofs.has(resource)) fail('untrusted_resource');
  return replayProofs.get(resource);
}
