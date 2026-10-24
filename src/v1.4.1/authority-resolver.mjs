import { readTrustedContext, isTrustedContext, compileContextAssertions } from './trusted-context.mjs';
import { canonicalCabinetOwnerId } from '../v1.4.0-rebuild/cabinet-participants.mjs';
import { sha256Hex } from '../v1.4.0-rebuild/mini-app-security.mjs';
import { FOUNDATION_POLICY_VERSION, CAPABILITY_CATALOG, PLAN_CAPABILITIES, FIXED_OPERATION_ALIASES, AUDIT_NAME_ALIASES, canonicalPolicyJson } from './capability-policy.mjs';
import { readDragonPreviewConfig, DRAGON_PREVIEW_PROGRAM_CODE, DRAGON_PREVIEW_DURATION_SECONDS } from '../v1.3.5/dragon-preview-core.mjs';
import { verifyStarsInvoicePayload } from '../v1.3.6/stars-core-foundation.mjs';
import { readOwnLifecycleFacts, LIFECYCLE_SOURCE_COLUMNS, LIFECYCLE_SOURCE_TABLES, LIFECYCLE_REVIEW_SETTLEMENT_COLUMNS } from '../v1.4.3/lifecycle-facts.mjs';
import { createLifecycleAuthorityBridge,compileVerifiedLifecycleAssertions,readVerifiedLifecycleFacts } from '../v1.4.3/lifecycle-authority.mjs';
import { projectVerifiedSubscriptionLifecycle } from '../v1.4.3/lifecycle-engine.mjs';
import { readPackageAccessDatabaseSource, validateUnifiedPackageTimeline } from '../v1.4.4/package-access-runtime.mjs';
import { readPackageReferralBonusDatabaseSource } from '../v1.4.4/package-referral-bonus-runtime.mjs';

// Read-only, request-local source authority. A JSON copy never has this brand.
const actors = new WeakMap();
// Subscription dates are private projection facts from the selected verified
// source. They are distinct from the short authority/session deadline.
const subscriptionActors = new WeakMap();
const financialHistoryActors = new WeakMap();
const lifecycleSources = new WeakMap(), lifecycleActors = new WeakMap();
const providerInactiveExits = new WeakMap();
// An observed inactive, fully refunded legacy subscription is a package exit,
// never a cancellation ACK or a promise that it cannot be reactivated later.
export function isVerifiedProviderInactiveExit(proof, contract, at, historical = false) {
  const source=providerInactiveExits.get(proof);
  return !!source&&source.contract===contract&&positive(at)&&at>=proof.observedAt&&at<proof.invalidatedAt&&
    (historical?proof.revision<=contract.revision:proof.revision===contract.revision);
}
const freeze = v => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const fail = code => { throw Object.assign(new Error(code), { code }); };
const positive = v => Number.isSafeInteger(v) && v > 0;
const PLANS = new Set(['free', 'professional', 'dragon']);
const PAID = new Set(['professional', 'dragon']);
const MAX_ROWS = 128, MAX_BYTES = 8_388_608, MAX_READS = 48;
const encoder = new TextEncoder();
// Frozen P01 protected contours; the server operation selects this boundary.
const PROTECTED_SOURCE_OPERATIONS = new Set(['terms.read','terms.accept','help.read','support.basic',
  'privacy.read_own','privacy.export_own','privacy.clear_ai_own','privacy.request_delete_own',
  'billing.payment_help','billing.read_history_own','application.read_own','application.read_attributed',
  'offer.read_own','campaign.read_own','notification.read_own','profile.read_own','access.read_own','billing.request_refund_own']);
const ESSENTIAL_SERVICE_OPERATIONS = new Set(['service.preview.expire','service.stars.reconcile','service.stars.expire',
  'service.stars.process_event','service.referral.settle','service.privacy.cleanup','service.ai.settle_cost']);
// These fixed Telegram presentation operations use the same canonical source
// reader. Batch only its independent snapshots; mutation/provider paths keep
// their existing reader order and all final freshness assertions stay intact.
const TELEGRAM_READ_SOURCE_OPERATIONS = new Set(['account.menu.read','help.read','terms.read','support.basic',
  'billing.payment_help','profile.read_own','access.read_own','referral.link.read_own','referral.stats.read_own',
  'notification.read_own','offer.read_public','offer.read_own','application.read_own','application.read_attributed',
  'campaign.read_own','analytics.read_personal','privacy.read_own','catalog.preference.read_own',
  'ai.memory.read_own','ai.official_source.read','ai.partner_draft.read','admin.cabinet.open','admin.analytics.read']);
const FOUNDATION_METADATA_TABLES = new Set(['capability_catalog','plan_capabilities','feature_flags','feature_flag_assignments','entitlement_grants','entitlement_overrides']);
const FINANCIAL_SOURCE_TABLES = new Set(['package_referral_bonus_grants','subscription_package_orders','subscription_package_periods','user_access','user_plans','user_access_states','trial_grants','subscriptions','subscription_orders','subscription_access_grants','payment_ledger','price_book','bonus_access_grants','bonus_access_effects','referral_rewards','referral_reward_candidates','referral_reward_transitions']);
const LIFECYCLE_READ_TABLES = new Set([...LIFECYCLE_SOURCE_TABLES,'terms_acceptances',
  'subscription_first_recurring_receipts','subscription_payment_review_receipts','subscription_payment_review_settlements']);
const CUSTOMER_CAPS = new Set(CAPABILITY_CATALOG.filter(r => r.actor_kind === 'customer' && r.availability !== 'future_release' && !r.future_release).map(r => r.capability));

// Exact accepted UTC SQL timestamps only; reject rollover and local-time parsing.
export function authoritySeconds(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:Z)?$/u.test(value)) return null;
  const normalized = value.replace(' ', 'T').replace(/Z$/u, '') + 'Z';
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== normalized.slice(0, 19)) return null;
  const seconds = ms / 1000;
  return positive(seconds) ? seconds : null;
}
export async function accountGenerationFingerprint(user) {
  if (!user || !positive(user.telegram_id) || typeof user.joined_at !== 'string' ||
      authoritySeconds(user.joined_at) === null || typeof user.referral_code !== 'string' || !user.referral_code) return null;
  return sha256Hex(canonicalPolicyJson({ domain: 'v1.4.1.account-generation', telegramId: user.telegram_id,
    joinedAt: user.joined_at, referralCode: user.referral_code }));
}
// Shared issuance identity for the future controlled writer; never an actor mint.
export async function manualGrantSourceFingerprint(row, accountFingerprint) {
  return sha256Hex(canonicalPolicyJson({ domain: 'v1.4.1.manual-capability-source', accountFingerprint,
    grantId: row.grant_id, idempotencyKey: row.idempotency_key, policyVersion: row.policy_version,
    capability: row.capability, scopeKind: row.scope_kind, scopeKey: row.scope_key,
    sourceRef: row.source_ref, sourceRevision: row.source_revision, issuedBy: row.issued_by,
    reason: row.reason, startsAt: row.starts_at, expiresAt: row.expires_at }));
}
const SEAL_COLUMNS = Object.freeze({
  entitlement_grants: 'grant_id idempotency_key policy_version capability subject_telegram_id subject_source_fingerprint scope_kind scope_key source_kind source_ref source_revision source_fingerprint starts_at expires_at revision created_at updated_at revoked_at retention_until',
  entitlement_overrides: 'override_id idempotency_key policy_version capability subject_telegram_id subject_source_fingerprint scope_kind scope_key effect limit_value starts_at expires_at revision created_at updated_at revoked_at retention_until',
  feature_flag_assignments: 'assignment_id idempotency_key flag_key subject_kind subject_key subject_telegram_id subject_source_fingerprint starts_at expires_at revision created_at updated_at revoked_at retention_until',
  feature_flags: 'flag_key policy_version enabled emergency_disabled revision rollout_json updated_at',
});
// Verifier-only contract. A private fixed authenticated issuer may create a
// seal; no generic metadata signer or backfill is exposed by this module.
export function canonicalAuthoritySealCore(table, row) {
  const names = SEAL_COLUMNS[table]?.split(' ');
  if (!names || !row || names.some(name => !Object.hasOwn(row, name) ||
      row[name] !== null && !['string', 'number'].includes(typeof row[name]))) return null;
  if (table !== 'feature_flags' && !/^[0-9a-f]{64}$/u.test(row.subject_source_fingerprint ?? '')) return null;
  return canonicalPolicyJson({ domain: 'v1.4.1.authority-seal.v1', table, catalogPolicyVersion: FOUNDATION_POLICY_VERSION,
    ...Object.fromEntries(names.map(name => [name, row[name]])) });
}
export async function verifyAuthoritySeal(table, row, env) {
  if (row?.seal_version !== 1 || !/^[0-9a-f]{64}$/u.test(row?.authority_seal ?? '') ||
      typeof env?.BOT_TOKEN !== 'string' || !env.BOT_TOKEN) return false;
  const core = canonicalAuthoritySealCore(table, row);
  if (core === null) return false;
  const bytes = new TextEncoder();
  const material = await crypto.subtle.digest('SHA-256', bytes.encode('v1.4.1.authority-seal.key\n' + env.BOT_TOKEN));
  const key = await crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, Uint8Array.from(row.authority_seal.match(/../gu), byte => parseInt(byte, 16)), bytes.encode(core));
}
const SEAL_SCHEMA_COLUMNS = Object.freeze({
  entitlement_grants: 'subject_source_fingerprint issuer_anonymized revoker_anonymized authority_seal seal_version',
  entitlement_overrides: 'issuer_anonymized revoker_anonymized authority_seal seal_version',
  feature_flag_assignments: 'assigner_anonymized revoker_anonymized authority_seal seal_version',
  feature_flags: 'updater_anonymized authority_seal seal_version',
});
const COLUMNS = {
  ...LIFECYCLE_SOURCE_COLUMNS,
  admin_audit_log: 'id actor_id action entity_type entity_id details created_at',
  payment_refunds: 'refund_id idempotency_key order_id original_ledger_entry_id telegram_id telegram_payment_charge_id currency amount_stars reason_code requested_by_type requested_by status requested_at confirmed_at applied_at error_code revision updated_at',
  subscription_first_recurring_receipts: 'contract_id operation_id evidence_sha256 verified_at',
  subscription_payment_review_receipts: 'ledger_entry_id origin_order_id contract_id telegram_id plan_code external_invoice_payload external_payload_sha256 provider_period_start provider_period_end is_first_recurring evidence_sha256 telegram_update_id reason_code recorded_at',
  terms_acceptances: 'acceptance_id telegram_id terms_revision acceptance_scope telegram_update_id evidence_sha256 accepted_at',
  mini_app_release_control: 'id candidate_sha revision state beta_enabled owner_telegram_id issued_at expires_at updated_at',
  capability_catalog: 'policy_version capability actor_kind resource_scope availability future_release quota_key definition_json definition_sha256',
  plan_capabilities: 'policy_version capability plan_code access_overlay allowed quota_key limit_value quota_unit quota_window rule_json definition_sha256',
  feature_flags: 'flag_key policy_version enabled emergency_disabled revision rollout_json updated_by reason updated_at',
  feature_flag_assignments: 'assignment_id idempotency_key flag_key subject_kind subject_key subject_telegram_id subject_source_fingerprint assigned_by reason starts_at expires_at revision created_at updated_at revoked_at revoked_by revocation_reason retention_until',
  users: 'telegram_id inviter_id referral_code accepted_terms is_blocked joined_at inviter_bound_at',
  user_roles: 'telegram_id role status assigned_by assigned_at updated_at',
  privacy_deletion_requests: 'request_id telegram_id confirmation_token status summary_json expires_at created_at completed_at',
  partner_profiles: 'id telegram_id application_id display_name telegram_username contact status approved_by approved_at updated_at',
  partner_applications: 'id telegram_id display_name telegram_username contact age_confirmed status rejection_reason reviewed_by submitted_at updated_at reviewed_at',
  partner_legal_profiles: 'partner_profile_id profile_kind verification_state revision declared_by declared_at verified_by verified_at updated_at',
  partner_beta_access: 'partner_profile_id access_status can_create_private_offers can_submit_offers granted_by granted_at expires_at reason status_changed_by status_changed_at updated_at',
  partner_beta_settings: 'id enabled private_offers_enabled submissions_enabled public_visibility_enabled max_active_offers_per_partner updated_by updated_at',
  user_access: 'telegram_id access_tier ai_enabled trial_used trial_started_at trial_ends_at team_started_at team_ends_at created_at updated_at',
  user_plans: 'telegram_id plan_code source_code effective_from effective_until revision created_at updated_at',
  user_access_states: 'telegram_id access_state source_code state_started_at state_ends_at revision created_at updated_at',
  trial_grants: 'grant_id telegram_id subject_fingerprint program_code source_code status started_at ends_at retention_until workflow_instance_id workflow_state workflow_error_code warning_sent_at granted_at ended_at anonymized_at updated_at',
  subscriptions: 'subscription_id telegram_id plan_code billing_mode source_order_id telegram_payment_charge_id status current_period_start current_period_end auto_renew last_ledger_entry_id revision created_at updated_at',
  subscription_access_grants: 'grant_id grant_key subscription_id order_id payment_ledger_entry_id telegram_id plan_code access_seconds starts_at ends_at status compensation_ledger_entry_id created_at updated_at',
  subscription_orders: 'order_id telegram_id price_id price_version plan_code currency amount_stars access_seconds billing_mode terms_revision invoice_payload order_state state_revision created_at expires_at precheckout_approved_at paid_at applied_at closed_at updated_at',
  subscription_payment_review_settlements: LIFECYCLE_REVIEW_SETTLEMENT_COLUMNS,
  payment_ledger: 'ledger_entry_id idempotency_key order_id telegram_id entry_type direction currency amount_stars telegram_payment_charge_id provider_payment_charge_id telegram_update_id related_ledger_entry_id reason_code occurred_at recorded_at',
  price_book: 'price_id price_version plan_code currency amount_stars access_seconds billing_mode publication_state terms_revision valid_from valid_until created_at created_by',
  bonus_access_grants: 'bonus_grant_id grant_key reward_id program_code beneficiary_telegram_id delivery_mode plan_code bonus_seconds grant_status available_at claim_expires_at claimed_at applied_at starts_at ends_at target_subscription_id compensation_ledger_entry_id compensated_seconds compensated_at last_transition_id revision created_at updated_at',
  bonus_access_effects: 'effect_id effect_key bonus_grant_id reward_id beneficiary_telegram_id effect_kind plan_code prior_plan_code prior_access_state prior_plan_revision result_plan_revision prior_access_revision result_access_revision target_subscription_id prior_subscription_revision result_subscription_revision source_payment_ledger_entry_id applied_transition_id effect_starts_at effect_ends_at recorded_at',
  referral_rewards: 'reward_id reward_key candidate_id program_code beneficiary_telegram_id buyer_telegram_id reward_seconds reward_status confirm_after confirmed_at cancelled_at last_transition_id revision created_at updated_at',
  referral_reward_candidates: 'candidate_id candidate_key program_code buyer_telegram_id inviter_telegram_id source_order_id source_payment_ledger_entry_id source_access_grant_id buyer_plan_code amount_stars first_started_at inviter_bound_at paid_at eligible_until confirm_after selected_at selection_reason schema_version created_at',
  referral_reward_transitions: 'transition_id transition_key transition_scope reward_id bonus_grant_id from_status to_status from_revision to_revision reason_code actor_type actor_id related_payment_ledger_entry_id effect_starts_at effect_ends_at compensated_seconds occurred_at recorded_at',
  ai_runtime_settings: 'id rollout_mode model_name public_daily_neurons_milli admin_daily_neurons_milli reserve_daily_neurons_milli user_daily_success_limit response_character_limit updated_by updated_at',
  ai_user_consents: 'telegram_id consent_version consented_at revoked_at updated_at',
  entitlement_grants: 'grant_id idempotency_key policy_version capability subject_telegram_id scope_kind scope_key source_kind source_ref source_revision source_fingerprint issued_by reason starts_at expires_at revision created_at updated_at revoked_at revoked_by revocation_reason retention_until',
  entitlement_overrides: 'override_id idempotency_key policy_version capability subject_telegram_id subject_source_fingerprint scope_kind scope_key effect limit_value issued_by reason starts_at expires_at revision created_at updated_at revoked_at revoked_by revocation_reason retention_until',
};
const one = rows => rows.length === 1 ? rows[0] : null;
const index = (rows, key) => new Map(rows.map(row => [row[key], row]));
const jsonRow = columns => {
  const names = columns.split(' '); let expr = "json('{}')";
  for (let i = 0; i < names.length; i += 15) expr = `json_set(${expr}, ${names.slice(i, i + 15).flatMap(k => [`'$.${k}'`, k]).join(', ')})`;
  return expr;
};
const aliases = row => freeze({ ...row, sourceVerified: true, capability: row.capability,
  scopeKind: row.scope_kind, scopeKey: row.scope_key, startsAt: row.starts_at,
  expiresAt: row.expires_at, revokedAt: row.revoked_at });
const unsigned = row => row.authority_seal == null && row.seal_version == null;

export const isTrustedActor = actor => actors.has(actor);
export function readActorFacts(actor) { if (!actors.has(actor)) fail('untrusted_actor'); return actor; }
export function readActorContext(actor) { const proof = actors.get(actor); if (!proof) fail('untrusted_actor'); return proof.context; }
export function readSubscriptionActorFacts(actor) {
  if (!isTrustedActor(actor)) fail('untrusted_actor');
  const facts = subscriptionActors.get(actor);
  if (!facts) fail('subscription_actor_scope_mismatch');
  return facts;
}
export function readFinancialHistoryActorFacts(actor) {
  if (!isTrustedActor(actor)) fail('untrusted_actor');
  const facts=financialHistoryActors.get(actor);
  if(!facts) fail('subscription_history_scope_mismatch');
  return facts;
}
export function readAuthorityLifecycleSource(token) {
  const proof = lifecycleSources.get(token);
  if (!proof) fail('untrusted_lifecycle_source');
  return proof.facts;
}
export function compileAuthorityLifecycleSourceAssertions(token) {
  const proof = lifecycleSources.get(token);
  if (!proof) fail('untrusted_lifecycle_source');
  const context = compileContextAssertions(proof.context);
  return freeze({ assertions:[context, { sql:'unixepoch() < ?', params:[proof.validUntil] },
    ...proof.captures.map(capture => ({ sql:`(${capture.sql}) = ?`, params:[...capture.params,capture.snapshot] }))] });
}
export function readLifecycleActorFacts(actor) {
  if (!isTrustedActor(actor)) fail('untrusted_actor');
  const proof = lifecycleActors.get(actor);
  if (!proof) fail('lifecycle_actor_scope_mismatch');
  return proof;
}
async function previewSubjectFingerprint(secret, telegramId) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(`${DRAGON_PREVIEW_PROGRAM_CODE}:${telegramId}`));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const assertions = (actor, replay) => {
  const proof = actors.get(actor); if (!proof) fail('untrusted_actor');
  const context = compileContextAssertions(proof.context);
  const captures = replay ? proof.identityCaptures : proof.captures;
  const validUntil = replay ? actor.identityValidUntil : actor.validUntil;
  const pieces = [{ sql: context.sql, params: [...context.params] }, { sql: 'unixepoch() < ?', params: [validUntil] },
    ...captures.map(c => ({ sql: `(${c.sql}) = ?`, params: [...c.params,c.snapshot] }))];
  if (replay && actor.actorKind === 'customer') pieces.push({
    sql: "EXISTS(SELECT 1 FROM users WHERE telegram_id=? AND accepted_terms=1 AND is_blocked=0) AND " +
      "EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=? AND status='active' AND role IN ('user','partner','admin')) AND " +
      "NOT EXISTS(SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending' AND (unixepoch(expires_at) IS NULL OR unixepoch(expires_at)>unixepoch()))",
    params: [actor.telegramId,actor.telegramId,actor.telegramId] });
  const params = pieces.flatMap(piece => piece.params), sql = pieces.map(piece => `(${piece.sql})`).join(' AND ');
  if (pieces.some(piece => piece.params.length > 99)) fail('authority_assertion_budget_exhausted');
  return freeze({ sql, params, assertions: pieces, validUntil, actorTelegramId: actor.telegramId,
    botId: actor.botId, policyVersion: actor.policyVersion, sourceFingerprint: actor.sourceFingerprint });
};
export const compileAuthorityAssertions = actor => assertions(actor, false);
export const compileAuthorityReplayAssertions = actor => assertions(actor, true);

// No binding/env/proof arguments: canonical DB and server configuration belong
// solely to the authenticated root context. Every resolve performs fresh reads.
async function resolveCanonicalActor(context, serviceSource=null) {
    if (!isTrustedContext(context)) fail('untrusted_context');
    const original = readTrustedContext(context);
    const trusted=serviceSource?{...original,actorKind:'customer',telegramId:serviceSource.telegramId??serviceSource.subscription.telegram_id,
      botId:Number(original.env.BOT_TOKEN?.split(':')[0]),operation:'access.read_own'}:original;
    const { db, env, telegramId, botId, nowSeconds: now } = trusted;
    if (!db?.prepare || !positive(now) || trusted.expiresAt <= now) fail('authority_unavailable');
    let deadline = trusted.expiresAt, identityDeadline = trusted.expiresAt, bytes = 0, reads = 0;
    const captures = [], identityCaptures = [], degradedTables = [];
    if(serviceSource) captures.push(serviceSource.capture);
    const policyCapability = FIXED_OPERATION_ALIASES[trusted.operation] ?? AUDIT_NAME_ALIASES[trusted.operation] ?? trusted.operation;
    const protectedOperation = trusted.actorKind === 'customer' && PROTECTED_SOURCE_OPERATIONS.has(policyCapability);
    const essentialServiceOperation = trusted.actorKind === 'service' && ESSENTIAL_SERVICE_OPERATIONS.has(policyCapability);
    // Registration, fixed Telegram reads and the Mini App's own subscription
    // read need the same full canonical proofs. Their independent snapshots
    // can share one primary read batch; operation eligibility stays unchanged.
    // Results live only in this invocation and are consumed by the existing
    // parser/capture/overflow checks; they never replace the final write guards.
    const prefetched = new Map();
    const snapshotSql = (table,where,order,max=MAX_ROWS) => {
      const extra = sealTables.has(table) ? ' ' + SEAL_SCHEMA_COLUMNS[table] : '';
      return `SELECT COALESCE(json_group_array(json(authority_row)), '[]') FROM (SELECT ${jsonRow(COLUMNS[table] + extra)} AS authority_row FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ${max + 1})`;
    };
    const snapshotKey = (sql,params) => JSON.stringify([sql,params]);
    const degrade = (table,code) => { if (!degradedTables.some(row=>row.table===table)) degradedTables.push({table,code}); return []; };
    const timegate = (value, identity = false) => { const s = authoritySeconds(value); if (s !== null && s > now) { deadline = Math.min(deadline, s); if (identity) identityDeadline = Math.min(identityDeadline, s); } };
    const read = async (table, where, params, order, identity = false, max = MAX_ROWS) => {
      if (!Object.hasOwn(COLUMNS, table) || ++reads > MAX_READS) fail('authority_query_budget_exhausted');
      const sql = snapshotSql(table,where,order,max);
      try {
        let snapshot; try { snapshot = prefetched.has(snapshotKey(sql,params))
          ? prefetched.get(snapshotKey(sql,params)) : await db.prepare(sql).bind(...params).first(); } catch { fail('authority_unavailable'); }
        if (!snapshot || Object.keys(snapshot).length !== 1) fail('authority_unavailable');
        snapshot = Object.values(snapshot)[0];
        if (typeof snapshot !== 'string') fail('authority_unavailable');
        const size = encoder.encode(snapshot).length; if (bytes + size > MAX_BYTES) fail('authority_source_overflow'); bytes += size;
        let rows; try { rows = JSON.parse(snapshot); } catch { fail('authority_unavailable'); }
        if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== 'object' || Array.isArray(r))) fail('authority_source_overflow');
        const capture = freeze({ sql, params: [...params], snapshot }); captures.push(capture); if (identity) identityCaptures.push(capture);
        if (rows.length > max) fail('authority_source_overflow');
        return rows;
      } catch (error) {
        // Canonical auth/account/roles/privacy is mandatory. Optional financial
        // or new metadata cannot take away P01's fixed protected own contours.
        if (!(protectedOperation || LIFECYCLE_READ_TABLES.has(table) || essentialServiceOperation && FOUNDATION_METADATA_TABLES.has(table)) || identity ||
          !['authority_unavailable','authority_source_overflow'].includes(error?.code)) throw error;
        return degrade(table,error.code);
      }
    };
    // P03 remains readable before the candidate migration; P04 seals are read
    // only when all fixed companion columns actually exist. Schema capture
    // invalidates the proof if a table changes between resolution and effect.
    const sealTables = new Set();
    let lifecycleSchemaPresent = false, lifecycleSchemaPartial = false, firstReceiptSchemaPresent = false, reviewReceiptSchemaPresent = false, reviewSettlementSchemaPresent = false;
    const schemaSql = "SELECT COALESCE(json_group_array(json(authority_row)), '[]') FROM (SELECT json_object('name',name,'sql',sql) AS authority_row FROM sqlite_master WHERE type='table' AND name IN ('entitlement_grants','entitlement_overrides','feature_flag_assignments','feature_flags','subscription_billing_contracts','subscription_payment_links','subscription_provider_events','subscription_provider_commands','payment_review_resolutions','subscription_first_recurring_receipts','subscription_payment_review_receipts','subscription_payment_review_settlements') ORDER BY name)";
    try {
      if (++reads > MAX_READS) fail('authority_query_budget_exhausted');
      const result = await db.prepare(schemaSql).first();
      const snapshot = result && Object.values(result)[0];
      if (typeof snapshot !== 'string') fail('authority_unavailable');
      const size = encoder.encode(snapshot).length;
      if (size > 262_144 || bytes + size > MAX_BYTES) fail('authority_source_overflow');
      bytes += size;
      const schemaRows = JSON.parse(snapshot);
      if (!Array.isArray(schemaRows) || schemaRows.length > 12) fail('authority_unavailable');
      captures.push(freeze({ sql: schemaSql, params: [], snapshot }));
      for (const entry of schemaRows) {
        if (LIFECYCLE_SOURCE_TABLES.includes(entry?.name) ||
            ['subscription_first_recurring_receipts','subscription_payment_review_receipts','subscription_payment_review_settlements'].includes(entry?.name)) {
          if (typeof entry.sql !== 'string') fail('authority_unavailable');
          continue;
        }
        if (typeof entry?.sql !== 'string' || !Object.hasOwn(SEAL_SCHEMA_COLUMNS,entry.name)) fail('authority_unavailable');
        const names = SEAL_SCHEMA_COLUMNS[entry.name].split(' ');
        if (names.every(name => new RegExp('\\b' + name + '\\b','u').test(entry.sql))) sealTables.add(entry.name);
        else if (/\bauthority_seal\b/u.test(entry.sql)) fail('authority_unavailable');
      }
      const lifecycleTables = schemaRows.filter(entry => LIFECYCLE_SOURCE_TABLES.includes(entry.name));
      lifecycleSchemaPresent = lifecycleTables.length === LIFECYCLE_SOURCE_TABLES.length;
      lifecycleSchemaPartial = lifecycleTables.length > 0 && !lifecycleSchemaPresent;
      firstReceiptSchemaPresent = schemaRows.some(entry => entry.name === 'subscription_first_recurring_receipts');
      reviewReceiptSchemaPresent = schemaRows.some(entry => entry.name === 'subscription_payment_review_receipts');
      reviewSettlementSchemaPresent = schemaRows.some(entry => entry.name === 'subscription_payment_review_settlements');
    } catch (error) {
      if (!protectedOperation && !essentialServiceOperation) throw error;
      degrade('entitlement_grants','authority_unavailable');
    }
    const flagKeys = ['v1.4.1.global', 'capability:' + policyCapability];
    const canonicalOwnerId = canonicalCabinetOwnerId(env);
    const related = 'SELECT source_order_id FROM referral_reward_candidates WHERE inviter_telegram_id=?';
    // Bound financial evidence, not the lifetime number of abandoned invoices.
    // Paid/reversed orders and every referenced source remain captured even if
    // their status was corrupted. A late payment or source reference makes a
    // previously ignored order enter this same captured query, invalidating the
    // proof before any effect. Genuine financial evidence still has MAX_ROWS.
    const ownOrderEvidence = `(telegram_id=? AND (
      (order_state IN ('created','precheckout_ok') AND expires_at>?)
      OR order_state IN ('paid','applied','refunded','chargeback')
      OR EXISTS (SELECT 1 FROM payment_ledger p WHERE p.order_id=subscription_orders.order_id)
      OR EXISTS (SELECT 1 FROM subscription_access_grants g WHERE g.order_id=subscription_orders.order_id)
      OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.source_order_id=subscription_orders.order_id)
      ${lifecycleSchemaPresent ? 'OR EXISTS (SELECT 1 FROM subscription_billing_contracts c WHERE c.origin_order_id=subscription_orders.order_id)' : ''}
    )) OR order_id IN (${related})`;
    const ownOrderParams = [telegramId,now,telegramId];
    if(trusted.actorKind==='customer'&&(policyCapability==='account.register'||
      ['telegram_command','telegram_callback'].includes(trusted.channel)&&TELEGRAM_READ_SOURCE_OPERATIONS.has(policyCapability)||
      trusted.channel==='mini_app'&&policyCapability==='access.read_own')) {
      const specs=[
        ['capability_catalog','policy_version=? AND capability=?',[FOUNDATION_POLICY_VERSION,policyCapability],'capability',1],
        ['plan_capabilities','policy_version=? AND capability=?',[FOUNDATION_POLICY_VERSION,policyCapability],'plan_code, access_overlay',4],
        ['feature_flags','flag_key IN (?,?)',flagKeys,'flag_key',2],
        ['feature_flag_assignments',"flag_key IN (?,?) AND (subject_telegram_id=? OR subject_kind='cohort')",[...flagKeys,telegramId??-1],'assignment_id',64],
        ['users','telegram_id=?',[canonicalOwnerId??-1],'telegram_id',1],
        ['user_roles',"telegram_id=? AND role='admin'",[canonicalOwnerId??-1],'role',1],
        ['privacy_deletion_requests',"telegram_id=? AND status='pending'",[canonicalOwnerId??-1],'request_id'],
        ['users','telegram_id=?',[telegramId],'telegram_id',1],
        ['user_roles','telegram_id=?',[telegramId],'role',8],
        ['privacy_deletion_requests',"telegram_id=? AND status='pending'",[telegramId],'request_id'],
        ['partner_applications','telegram_id=?',[telegramId],'id',1],
        ['partner_profiles','telegram_id=?',[telegramId],'id',1],
        ['partner_beta_settings','id=1',[],'id',1],
        ['mini_app_release_control','id=1',[],'id',1],
        ['user_access','telegram_id=?',[telegramId],'telegram_id',1],
        ['user_plans','telegram_id=?',[telegramId],'telegram_id',1],
        ['user_access_states','telegram_id=?',[telegramId],'telegram_id',1],
        ['trial_grants',"telegram_id=? AND program_code='dragon_preview'",[telegramId],'grant_id',2],
        ['subscriptions','telegram_id=?',[telegramId],'subscription_id'],
        ['referral_reward_candidates','inviter_telegram_id=?',[telegramId],'candidate_id'],
        ['subscription_orders',ownOrderEvidence,ownOrderParams,'order_id'],
        ['payment_ledger',`telegram_id=? OR order_id IN (${related})`,[telegramId,telegramId],'ledger_entry_id'],
        ['subscription_access_grants',`telegram_id=? OR order_id IN (${related})`,[telegramId,telegramId],'grant_id'],
        ['price_book',`price_id IN (SELECT price_id FROM subscription_orders WHERE ${ownOrderEvidence})`,ownOrderParams,'price_id, price_version'],
        ['bonus_access_grants','beneficiary_telegram_id=?',[telegramId],'bonus_grant_id'],
        ['bonus_access_effects','beneficiary_telegram_id=?',[telegramId],'effect_id'],
        ['referral_rewards','beneficiary_telegram_id=?',[telegramId],'reward_id'],
        ['referral_reward_transitions','reward_id IN (SELECT reward_id FROM referral_rewards WHERE beneficiary_telegram_id=?)',[telegramId],'transition_id'],
        ['ai_runtime_settings','id=1',[],'id',1],
        ['ai_user_consents','telegram_id=?',[telegramId],'telegram_id',1],
        ['entitlement_grants','subject_telegram_id=? AND policy_version=?',[telegramId,FOUNDATION_POLICY_VERSION],'grant_id',64],
        ['entitlement_overrides','subject_telegram_id=? AND policy_version=?',[telegramId,FOUNDATION_POLICY_VERSION],'override_id',64],
      ];
      try {
        const requests=specs.map(([table,where,params,order,max])=>({sql:snapshotSql(table,where,order,max),params}));
        const results=await db.batch(requests.map(({sql,params})=>db.prepare(sql).bind(...params)));
        if(!Array.isArray(results)||results.length!==requests.length||results.some(r=>r?.success!==true||!Array.isArray(r.results)||r.results.length!==1))throw new Error('authority_batch_unavailable');
        let totalBytes=0;
        for(let i=0;i<requests.length;i++) {
          const row=results[i].results[0],value=row&&Object.values(row)[0];
          if(!row||Object.keys(row).length!==1||typeof value!=='string'||
              (totalBytes+=encoder.encode(value).length)>MAX_BYTES)throw new Error('authority_batch_unavailable');
          prefetched.set(snapshotKey(requests[i].sql,requests[i].params),row);
        }
      } catch {
        // Read-only failure/malformed acknowledgement grants nothing. Retain
        // the established individual mandatory-read failure semantics.
        prefetched.clear();
      }
    }
    const catalogRows = await read('capability_catalog', 'policy_version=? AND capability=?', [FOUNDATION_POLICY_VERSION, policyCapability], 'capability', false, 1);
    const planRows = await read('plan_capabilities', 'policy_version=? AND capability=?', [FOUNDATION_POLICY_VERSION, policyCapability], 'plan_code, access_overlay', false, 4);
    const expectedCatalog = CAPABILITY_CATALOG.find(r => r.capability === policyCapability);
    const expectedPlans = PLAN_CAPABILITIES.filter(r => r.capability === policyCapability);
    const sameRow = (a,b) => !!a && !!b && Object.keys(b).every(k => Object.hasOwn(a,k) && a[k] === b[k]);
    const policyReady = !!expectedCatalog && catalogRows.length === 1 && sameRow(catalogRows[0],expectedCatalog) && planRows.length === 4 &&
      expectedPlans.every(expected => planRows.some(actual => sameRow(actual,expected)));
    let currentFlags = await read('feature_flags', 'flag_key IN (?,?)', flagKeys, 'flag_key', false, 2);
    const assignmentRows = await read('feature_flag_assignments', "flag_key IN (?,?) AND (subject_telegram_id=? OR subject_kind='cohort')", [...flagKeys, telegramId ?? -1], 'assignment_id', false, 64);
    for (const row of assignmentRows) if (row.revoked_at === null) { timegate(row.starts_at); timegate(row.expires_at); }
    const issuerUsers = await read('users', 'telegram_id=?', [canonicalOwnerId ?? -1], 'telegram_id', false, 1);
    const issuerRoles = await read('user_roles', "telegram_id=? AND role='admin'", [canonicalOwnerId ?? -1], 'role', false, 1);
    const issuerDeletions = await read('privacy_deletion_requests', "telegram_id=? AND status='pending'", [canonicalOwnerId ?? -1], 'request_id');
    issuerDeletions.forEach(r => timegate(r.expires_at));
    const issuer = one(issuerUsers);
    const issuerAuthorityAvailable = !degradedTables.some(row=>['users','user_roles','privacy_deletion_requests'].includes(row.table));
    const authorizedIssuer = issuerAuthorityAvailable && !!issuer && issuer.accepted_terms === 1 && issuer.is_blocked === 0 && issuerRoles[0]?.status === 'active' &&
      !issuerDeletions.some(r => authoritySeconds(r.expires_at) === null || authoritySeconds(r.expires_at) > now);
    currentFlags = await Promise.all(currentFlags.map(async row => freeze({ ...row,
      sourceVerified: positive(row.revision) && (await verifyAuthoritySeal('feature_flags',row,env) ||
        unsigned(row) && row.updated_by === canonicalOwnerId && authorizedIssuer && typeof row.reason === 'string' && row.reason.trim().length > 0) })));
    if (trusted.actorKind === 'service') {
      const actor = freeze({ version: 1, actorKind: 'service', telegramId: null, botId: null,
        nowSeconds: now, validUntil: deadline, identityValidUntil: identityDeadline,
        policyVersion: FOUNDATION_POLICY_VERSION, policyCapability, policyReady, currentFlags, verifiedAssignments: [],
        essentialServiceAuthorityFallback: essentialServiceOperation && (!policyReady || degradedTables.length>0),
        foundationMetadataAvailable: policyReady && !degradedTables.some(row=>FOUNDATION_METADATA_TABLES.has(row.table)), degradedTables, purpose: trusted.purpose, capability: trusted.capability,
        roles: [], canonicalOwner: false, accountFingerprint: null, sourceFingerprint: null,
        account: { exists: false, acceptedTerms: false, isBlocked: false, pendingDeletion: false, accountFingerprint: null },
        access: null, grants: [], overrides: [], ai: null, partner: null, legalProfile: null, canonical: {} });
      actors.set(actor, { context, captures, identityCaptures }); return actor;
    }
    if (trusted.actorKind !== 'customer' || !positive(telegramId)) fail('untrusted_actor_kind');
    const users = await read('users', 'telegram_id=?', [telegramId], 'telegram_id', true, 1);
    const user = one(users);
    if (user && (user.telegram_id !== telegramId || ![0,1].includes(user.accepted_terms) || ![0,1].includes(user.is_blocked))) fail('authority_identity_restriction_invalid');
    const roleRows = await read('user_roles', 'telegram_id=?', [telegramId], 'role', true, 8);
    if (roleRows.some(r => !['user', 'partner', 'admin'].includes(r.role) || !['active', 'paused'].includes(r.status))) fail('authority_inconsistent');
    const deletions = await read('privacy_deletion_requests', "telegram_id=? AND status='pending'", [telegramId], 'request_id', true);
    deletions.forEach(r => timegate(r.expires_at, true));
    const pendingDeletion = deletions.some(r => authoritySeconds(r.expires_at) === null || authoritySeconds(r.expires_at) > now);
    const roles = user ? roleRows.filter(r => r.status === 'active').map(r => r.role) : [];
    const accountFingerprint = await accountGenerationFingerprint(user);
    if (user && !accountFingerprint) fail('authority_account_generation_invalid');
    const canonicalOwner = !!user && telegramId === canonicalOwnerId && roles.includes('admin') && user.accepted_terms === 1 && user.is_blocked !== 1 && !pendingDeletion;
    const application = one(await read('partner_applications', 'telegram_id=?', [telegramId], 'id', false, 1));
    const profile = one(await read('partner_profiles', 'telegram_id=?', [telegramId], 'id', false, 1));
    const profileId = profile?.id ?? -1;
    const legal = one(await read('partner_legal_profiles', 'partner_profile_id=?', [profileId], 'partner_profile_id', false, 1));
    const betaAccess = one(await read('partner_beta_access', 'partner_profile_id=?', [profileId], 'partner_profile_id', false, 1));
    const rawBetaSettings = one(await read('partner_beta_settings', 'id=1', [], 'id', false, 1));
    const releaseLease = one(await read('mini_app_release_control', 'id=1', [], 'id', false, 1));
    timegate(releaseLease?.issued_at); timegate(releaseLease?.expires_at);
    const privateBeta = env.REBUILD_V140_RELEASE_LEASE_REQUIRED === 'true' && env.REBUILD_V140_BETA_ENABLED === 'true' &&
      releaseLease?.state === 'open' && releaseLease.beta_enabled === 1 && releaseLease.owner_telegram_id === Number(env.REBUILD_V140_OWNER_TELEGRAM_ID ?? env.OWNER_TELEGRAM_ID) &&
      releaseLease.candidate_sha === env.REBUILD_V140_RC_SHA && releaseLease.revision === Number(env.REBUILD_V140_RELEASE_REVISION) &&
      releaseLease.issued_at <= now && releaseLease.expires_at > now;
    // Preserve the accepted global hard switches AND database settings. The
    // finite private Beta lease cannot reopen a disabled server contour.
    const betaSettings = rawBetaSettings ? { ...rawBetaSettings,
      enabled: (rawBetaSettings.enabled === 1 || privateBeta) && env.PARTNER_BETA_ENABLED === 'true' ? 1 : 0,
      private_offers_enabled: (rawBetaSettings.private_offers_enabled === 1 || privateBeta) && env.PARTNER_PRIVATE_OFFERS_ENABLED === 'true' ? 1 : 0,
      submissions_enabled: (rawBetaSettings.submissions_enabled === 1 || privateBeta) && env.PARTNER_OFFER_SUBMISSIONS_ENABLED === 'true' ? 1 : 0,
      public_visibility_enabled: (rawBetaSettings.public_visibility_enabled === 1 || privateBeta) && env.PARTNER_OFFER_PUBLIC_VISIBILITY_ENABLED === 'true' ? 1 : 0 } : null;
    timegate(betaAccess?.expires_at);
    const legacy = one(await read('user_access', 'telegram_id=?', [telegramId], 'telegram_id', false, 1));
    const plan = one(await read('user_plans', 'telegram_id=?', [telegramId], 'telegram_id', false, 1));
    const state = one(await read('user_access_states', 'telegram_id=?', [telegramId], 'telegram_id', false, 1));
    timegate(plan?.effective_from); timegate(plan?.effective_until); timegate(state?.state_started_at); timegate(state?.state_ends_at);
    const previews = await read('trial_grants', "telegram_id=? AND program_code='dragon_preview'", [telegramId], 'grant_id', false, 2);
    previews.forEach(r => { timegate(r.started_at); timegate(r.ends_at); });
    // Only the subscription read needs the retained one-use marker. Keep this
    // captured lookup separate from the original own Preview authority rows;
    // an anonymized marker must never become a live access grant.
    const subscriptionReading = policyCapability === 'access.read_own';
    const previewConfig = subscriptionReading ? readDragonPreviewConfig(env, now) : null;
    let previewHistory = [], previewHistoryAvailable = false;
    if (subscriptionReading && previewConfig.antiAbuseSecret.length >= 32) {
      const fingerprint = await previewSubjectFingerprint(previewConfig.antiAbuseSecret, telegramId);
      previewHistory = await read('trial_grants', "subject_fingerprint=? AND program_code='dragon_preview'",
        [fingerprint], 'grant_id', false, 1);
      previewHistoryAvailable = !degradedTables.some(row => row.table === 'trial_grants');
    }
    const subscriptions = await read('subscriptions', 'telegram_id=?', [telegramId], 'subscription_id');
    subscriptions.forEach(r => { timegate(r.current_period_start); timegate(r.current_period_end); });
    const candidates = await read('referral_reward_candidates', 'inviter_telegram_id=?', [telegramId], 'candidate_id');
    const orders = await read('subscription_orders', ownOrderEvidence, ownOrderParams, 'order_id');
    const payments = await read('payment_ledger', `telegram_id=? OR order_id IN (${related})`, [telegramId, telegramId], 'ledger_entry_id');
    const slices = await read('subscription_access_grants', `telegram_id=? OR order_id IN (${related})`, [telegramId, telegramId], 'grant_id');
    const prices = await read('price_book', `price_id IN (SELECT price_id FROM subscription_orders WHERE ${ownOrderEvidence})`, ownOrderParams, 'price_id, price_version');
    const lifecycleRows = await readOwnLifecycleFacts({ telegramId, read, schemaPresent:lifecycleSchemaPresent,
      firstReceiptSchemaPresent, reviewReceiptSchemaPresent, reviewSettlementSchemaPresent });
    const starsTerms = lifecycleSchemaPresent ? await read('terms_acceptances', "telegram_id=? AND acceptance_scope='stars_purchase'",
      [telegramId], 'acceptance_id') : [];
    if (lifecycleSchemaPartial) degrade('subscription_billing_contracts','authority_unavailable');
    const lifecycleSourceAvailable = !lifecycleSchemaPartial &&
      !degradedTables.some(row => LIFECYCLE_READ_TABLES.has(row.table) && !['subscription_payment_review_receipts','subscription_payment_review_settlements'].includes(row.table));
    let packageSource={present:false,periods:[],subscriptions:[],captures:[]},packageSourceInvalid=false;
    try {
      packageSource=await readPackageAccessDatabaseSource({db,env,telegramId,nowSec:now,orders,payments,prices,terms:starsTerms});
      const packageBytes=packageSource.captures.reduce((size,capture)=>size+encoder.encode(String(capture.snapshot)).length,0);
      if(bytes+packageBytes>MAX_BYTES) fail('authority_source_overflow');
      bytes+=packageBytes;captures.push(...packageSource.captures);
      packageSource.periods.forEach(period=>{timegate(period.startsAt);timegate(period.endsAt);});
    } catch(error) {
      // An unavailable package contour cannot elevate capabilities; fixed own
      // support/history remain readable under the existing protected fallback.
      packageSourceInvalid=true;degrade('subscription_package_periods',error?.code??'package_access_source_unavailable');
    }
    const bonuses = await read('bonus_access_grants', 'beneficiary_telegram_id=?', [telegramId], 'bonus_grant_id');
    const effects = await read('bonus_access_effects', 'beneficiary_telegram_id=?', [telegramId], 'effect_id');
    const rewards = await read('referral_rewards', 'beneficiary_telegram_id=?', [telegramId], 'reward_id');
    const transitions = await read('referral_reward_transitions', 'reward_id IN (SELECT reward_id FROM referral_rewards WHERE beneficiary_telegram_id=?)', [telegramId], 'transition_id');
    bonuses.forEach(r => { timegate(r.starts_at); timegate(r.ends_at); timegate(r.available_at); timegate(r.claim_expires_at); });
    let packageBonusSource={present:false,periods:[],subscriptions:[],captures:[]},packageBonusInvalid=false;
    try {
      packageBonusSource=await readPackageReferralBonusDatabaseSource({db,env,telegramId,nowSec:now});
      const size=packageBonusSource.captures.reduce((n,c)=>n+encoder.encode(String(c.snapshot)).length,0);
      if(bytes+size>MAX_BYTES) fail('authority_source_overflow');
      bytes+=size;captures.push(...packageBonusSource.captures);
    } catch(error) {packageBonusInvalid=true;degrade('package_referral_bonus_grants',error?.code??'package_bonus_source_unavailable');}
    const settings = one(await read('ai_runtime_settings', 'id=1', [], 'id', false, 1));
    const consent = one(await read('ai_user_consents', 'telegram_id=?', [telegramId], 'telegram_id', false, 1));
    const metadata = await read('entitlement_grants', 'subject_telegram_id=? AND policy_version=?', [telegramId, FOUNDATION_POLICY_VERSION], 'grant_id', false, 64);
    const overrideRows = await read('entitlement_overrides', 'subject_telegram_id=? AND policy_version=?', [telegramId, FOUNDATION_POLICY_VERSION], 'override_id', false, 64);
    for (const row of [...metadata, ...overrideRows]) if (row.revoked_at === null) { timegate(row.starts_at); timegate(row.expires_at); }
    const orderMap = index(orders, 'order_id'), ledgerMap = index(payments, 'ledger_entry_id'), sliceMap = index(slices, 'grant_id');
    const rewardMap = index(rewards, 'reward_id'), candidateMap = index(candidates, 'candidate_id'), effectMap = index(effects, 'bonus_grant_id'), transitionMap = index(transitions, 'transition_id');
    const compensation = paymentId => payments.filter(r => r.related_ledger_entry_id === paymentId && ['refund', 'chargeback'].includes(r.entry_type));
    const verifiedCompensation = paymentId => {
      const payment = ledgerMap.get(paymentId);
      if (!payment || payment.entry_type !== 'payment' || payment.direction !== 'credit' || payment.currency !== 'XTR') return [];
      return compensation(paymentId).filter(reversal => reversal.direction === 'debit' && reversal.telegram_id === payment.telegram_id &&
        reversal.order_id === payment.order_id && reversal.currency === payment.currency && reversal.amount_stars === payment.amount_stars &&
        reversal.telegram_payment_charge_id === payment.telegram_payment_charge_id);
    };
    const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
    const verifiedContracts = [];
    const signedOrderIds = new Set();
    if (lifecycleSchemaPresent && lifecycleSourceAvailable) {
      for (const order of orders.filter(row => row.telegram_id === telegramId && row.billing_mode === 'recurring')) {
        try {
          const parsed = await verifyStarsInvoicePayload({ invoiceSecret:env.STARS_INVOICE_SECRET,
            payload:order.invoice_payload, telegramId, priceId:order.price_id });
          if (parsed.orderId === order.order_id) signedOrderIds.add(order.order_id);
        } catch { /* A malformed recurring invoice is never a paid source. */ }
      }
      for (const contract of lifecycleRows.contracts) {
        const origin = orderMap.get(contract.origin_order_id), terms = starsTerms.find(row => row.acceptance_id === contract.terms_acceptance_id);
        if (!origin || contract.telegram_id !== telegramId || contract.billing_mode !== 'recurring' ||
            !positive(contract.revision) || !positive(contract.created_at) || contract.updated_at < contract.created_at ||
            contract.period_seconds !== 2592000 || !signedOrderIds.has(origin.order_id) ||
            origin.telegram_id !== telegramId || origin.billing_mode !== 'recurring' ||
            ['plan_code','price_id','currency','amount_stars','terms_revision'].some(key => origin[key] !== contract[key]) ||
            origin.access_seconds !== contract.period_seconds || origin.invoice_payload !== contract.external_invoice_payload ||
            !digest(contract.external_payload_sha256) || await sha256Hex(contract.external_invoice_payload) !== contract.external_payload_sha256 ||
            !terms || terms.telegram_id !== telegramId || terms.terms_revision !== contract.terms_revision ||
            terms.acceptance_scope !== 'stars_purchase' || !digest(terms.evidence_sha256) ||
            !positive(terms.accepted_at) || terms.accepted_at > contract.created_at) continue;
        const firstPayment = contract.first_payment_ledger_entry_id === null ? null : ledgerMap.get(contract.first_payment_ledger_entry_id);
        const firstReceipt = (lifecycleRows.firstRecurringReceipts ?? []).find(row => row.contract_id === contract.contract_id);
        if (contract.first_payment_ledger_entry_id !== null && (!firstPayment || firstPayment.telegram_id !== telegramId ||
            firstPayment.entry_type !== 'payment' || firstPayment.direction !== 'credit' ||
            !firstReceipt || !digest(firstReceipt.evidence_sha256) || !positive(firstReceipt.verified_at) ||
            !lifecycleRows.paymentLinks.some(link => link.operation_id === firstReceipt.operation_id &&
              link.contract_id === contract.contract_id && link.direction === 'incoming' && link.link_kind === 'recurring_charge' &&
              link.ledger_entry_id === firstPayment.ledger_entry_id && link.origin_order_id === origin.order_id &&
              link.evidence_sha256 === firstReceipt.evidence_sha256 && link.recorded_at <= firstReceipt.verified_at))) continue;
        verifiedContracts.push(contract);
      }
    }
    // A retained credit remains attached to its immutable origin order. Only
    // the append-only owner settlement, exact retained receipt and incoming
    // link can bind it to one distinct completed child/grant.
    const settledPayments = new Map();
    for (const settlement of lifecycleRows.paymentReviewSettlements ?? []) {
      const receipt = (lifecycleRows.paymentReviewReceipts ?? []).find(row => row.ledger_entry_id === settlement.ledger_entry_id);
      const payment = ledgerMap.get(settlement.ledger_entry_id), origin = orderMap.get(receipt?.origin_order_id);
      const child = orderMap.get(settlement.applied_order_id), link = lifecycleRows.paymentLinks.find(row => row.operation_id === settlement.operation_id);
      if (!receipt || !payment || !origin || !child || !link || receipt.telegram_id !== telegramId ||
          payment.telegram_id !== telegramId || payment.order_id !== origin.order_id || payment.entry_type !== 'payment' ||
          payment.direction !== 'credit' || payment.reason_code !== 'payment_review_retained' || payment.related_ledger_entry_id !== null ||
          child.telegram_id !== telegramId || child.order_id === origin.order_id || child.invoice_payload === origin.invoice_payload ||
          ['price_id','price_version','plan_code','currency','amount_stars','access_seconds','billing_mode','terms_revision','created_at','expires_at'].some(key => child[key] !== origin[key]) ||
          receipt.plan_code !== origin.plan_code || payment.currency !== origin.currency || payment.amount_stars !== origin.amount_stars ||
          receipt.external_invoice_payload !== origin.invoice_payload || !digest(receipt.external_payload_sha256) ||
          await sha256Hex(receipt.external_invoice_payload) !== receipt.external_payload_sha256 || !digest(receipt.evidence_sha256) ||
          settlement.actor_id !== canonicalOwnerId || !positive(settlement.settled_at) || settlement.settled_at < receipt.recorded_at ||
          !digest(settlement.evidence_sha256) || typeof settlement.reason_code !== 'string' || !settlement.reason_code ||
          link.direction !== 'incoming' || link.ledger_entry_id !== payment.ledger_entry_id || link.original_payment_ledger_entry_id !== null ||
          link.applied_order_id !== child.order_id || link.origin_order_id !== origin.order_id || link.contract_id !== receipt.contract_id ||
          link.telegram_id !== telegramId || link.plan_code !== receipt.plan_code || link.provider_charge_id !== payment.telegram_payment_charge_id ||
          link.evidence_sha256 !== receipt.evidence_sha256 || link.external_invoice_payload !== receipt.external_invoice_payload ||
          link.external_payload_sha256 !== receipt.external_payload_sha256 || link.provider_period_start !== receipt.provider_period_start ||
          link.provider_period_end !== receipt.provider_period_end || !digest(link.provider_charge_sha256) ||
          await sha256Hex(link.provider_charge_id) !== link.provider_charge_sha256 ||
          child.billing_mode === 'recurring' && (link.link_kind !== 'recurring_charge' || !receipt.contract_id ||
            !positive(receipt.provider_period_start) || receipt.provider_period_end !== receipt.provider_period_start + child.access_seconds) ||
          child.billing_mode === 'prepaid' && (link.link_kind !== 'late_prepaid_charge' || receipt.contract_id !== null ||
            receipt.provider_period_start !== null || receipt.provider_period_end !== null || receipt.is_first_recurring !== 0)) continue;
      const decisionHash = await sha256Hex(JSON.stringify(['v143.payment-review.apply.v1',payment.ledger_entry_id,receipt.evidence_sha256,
        child.order_id,link.operation_id,settlement.actor_id,settlement.reason_code,settlement.resolution_key]));
      if (decisionHash !== settlement.evidence_sha256) continue;
      try {
        const parsed = await verifyStarsInvoicePayload({ invoiceSecret:env.STARS_INVOICE_SECRET,payload:child.invoice_payload,
          telegramId,priceId:child.price_id });
        if (parsed.orderId !== child.order_id) continue;
      } catch { continue; }
      if (settledPayments.has(payment.ledger_entry_id)) { settledPayments.set(payment.ledger_entry_id,null); continue; }
      settledPayments.set(payment.ledger_entry_id,{ settlement,receipt,child,link });
    }
    const recurringLinks = new Map();
    for (const link of lifecycleRows.paymentLinks) {
      if (link.direction !== 'incoming' || link.link_kind !== 'recurring_charge') continue;
      const contract = verifiedContracts.find(row => row.contract_id === link.contract_id);
      const origin = orderMap.get(link.origin_order_id), applied = orderMap.get(link.applied_order_id), payment = ledgerMap.get(link.ledger_entry_id);
      if (!contract || !origin || !applied || !payment || link.telegram_id !== telegramId ||
          contract.origin_order_id !== origin.order_id || applied.telegram_id !== telegramId || link.plan_code !== contract.plan_code ||
          ['price_id','price_version','plan_code','currency','amount_stars','access_seconds','billing_mode','terms_revision','created_at','expires_at'].some(key => applied[key] !== origin[key]) ||
          !signedOrderIds.has(applied.order_id) || applied.order_id !== origin.order_id && applied.invoice_payload === contract.external_invoice_payload ||
          link.external_invoice_payload !== contract.external_invoice_payload || link.external_payload_sha256 !== contract.external_payload_sha256 ||
          payment.order_id !== applied.order_id && settledPayments.get(payment.ledger_entry_id)?.child.order_id !== applied.order_id ||
          payment.telegram_id !== telegramId || payment.entry_type !== 'payment' || payment.direction !== 'credit' ||
          payment.telegram_payment_charge_id !== link.provider_charge_id || payment.currency !== contract.currency || payment.amount_stars !== contract.amount_stars ||
          payment.related_ledger_entry_id !== null || !digest(link.provider_charge_sha256) || await sha256Hex(link.provider_charge_id) !== link.provider_charge_sha256 ||
          !digest(link.evidence_sha256) || !positive(link.provider_period_start) || link.provider_period_end !== link.provider_period_start + contract.period_seconds ||
          link.original_payment_ledger_entry_id !== null || !positive(link.recorded_at)) continue;
      if (recurringLinks.has(payment.ledger_entry_id)) { recurringLinks.set(payment.ledger_entry_id,null); continue; }
      recurringLinks.set(payment.ledger_entry_id,link);
    }
    const validPaymentSlice = (slice, allowCompensated = false) => {
      if (!slice || !positive(slice.access_seconds) || slice.ends_at !== slice.starts_at + slice.access_seconds || !PAID.has(slice.plan_code)) return false;
      const order = orderMap.get(slice.order_id), payment = ledgerMap.get(slice.payment_ledger_entry_id);
      if (!order || !payment || order.telegram_id !== slice.telegram_id || order.plan_code !== slice.plan_code ||
          order.access_seconds !== slice.access_seconds || order.access_seconds !== 2592000 || !['prepaid','recurring'].includes(order.billing_mode) ||
          !positive(order.state_revision) || !positive(order.paid_at) || !positive(order.applied_at) || order.applied_at < order.paid_at ||
          payment.order_id !== order.order_id && settledPayments.get(payment.ledger_entry_id)?.child.order_id !== order.order_id ||
          payment.telegram_id !== order.telegram_id || payment.entry_type !== 'payment' ||
          payment.direction !== 'credit' || payment.currency !== 'XTR' || payment.amount_stars !== order.amount_stars ||
          !payment.telegram_payment_charge_id || payment.related_ledger_entry_id !== null) return false;
      if (order.billing_mode === 'recurring') {
        const link = recurringLinks.get(payment.ledger_entry_id);
        if (!link || slice.starts_at !== link.provider_period_start || slice.ends_at !== link.provider_period_end) return false;
      }
      const price = prices.find(p => p.price_id === order.price_id && p.price_version === order.price_version);
      if (!price || ['plan_code','currency','amount_stars','access_seconds','billing_mode','terms_revision'].some(k => price[k] !== order[k]) ||
          !['approved','retired'].includes(price.publication_state) || price.valid_from > order.created_at ||
          price.valid_until !== null && price.valid_until <= order.created_at) return false;
      const observed = compensation(payment.ledger_entry_id);
      if (slice.status === 'active') return order.order_state === 'applied' && slice.compensation_ledger_entry_id === null && observed.length === 0;
      if (!allowCompensated || !['refunded','chargeback'].includes(slice.status) || order.order_state !== slice.status || observed.length !== 1) return false;
      const reversal = observed[0];
      return reversal.ledger_entry_id === slice.compensation_ledger_entry_id && reversal.entry_type === (slice.status === 'refunded' ? 'refund' : 'chargeback') &&
        reversal.direction === 'debit' && reversal.currency === 'XTR' && reversal.amount_stars === payment.amount_stars &&
        reversal.order_id === payment.order_id && reversal.telegram_id === payment.telegram_id && reversal.telegram_payment_charge_id === payment.telegram_payment_charge_id;
    };
    const validBonus = bonus => {
      const reward = rewardMap.get(bonus.reward_id), candidate = candidateMap.get(reward?.candidate_id), effect = effectMap.get(bonus.bonus_grant_id), transition = transitionMap.get(effect?.applied_transition_id);
      if (bonus.grant_status !== 'applied' || bonus.beneficiary_telegram_id !== telegramId || !positive(bonus.revision) || bonus.bonus_seconds !== 259200 ||
          bonus.ends_at !== bonus.starts_at + 259200 || !positive(bonus.applied_at) || bonus.compensation_ledger_entry_id !== null || bonus.compensated_seconds !== 0 ||
          !reward || reward.reward_status !== 'confirmed' || !positive(reward.confirmed_at) || reward.cancelled_at !== null || reward.beneficiary_telegram_id !== telegramId ||
          reward.reward_seconds !== 259200 || reward.confirm_after !== candidate?.confirm_after || !candidate || candidate.inviter_telegram_id !== telegramId || candidate.buyer_telegram_id !== reward.buyer_telegram_id ||
          !effect || effect.reward_id !== reward.reward_id || effect.beneficiary_telegram_id !== telegramId || effect.plan_code !== bonus.plan_code ||
          effect.source_payment_ledger_entry_id !== candidate.source_payment_ledger_entry_id || effect.effect_starts_at !== bonus.starts_at || effect.effect_ends_at !== bonus.ends_at ||
          effect.result_plan_revision !== effect.prior_plan_revision + 1 || effect.result_access_revision !== effect.prior_access_revision + 1 ||
          !transition || transition.transition_scope !== 'bonus_grant' || transition.bonus_grant_id !== bonus.bonus_grant_id || transition.reward_id !== reward.reward_id ||
          transition.to_status !== 'applied' || transition.to_revision !== bonus.revision || transition.related_payment_ledger_entry_id !== candidate.source_payment_ledger_entry_id ||
          transition.effect_starts_at !== bonus.starts_at || transition.effect_ends_at !== bonus.ends_at || bonus.last_transition_id !== transition.transition_id) return false;
      const source = sliceMap.get(candidate.source_access_grant_id);
      return source?.telegram_id === candidate.buyer_telegram_id && source.order_id === candidate.source_order_id && source.payment_ledger_entry_id === candidate.source_payment_ledger_entry_id &&
        source.plan_code === candidate.buyer_plan_code && validPaymentSlice(source) && compensation(candidate.source_payment_ledger_entry_id).length === 0;
    };
    // Telegram supplies an expiry, while the immutable financial schema keeps
    // the nominal 30-day slice ending there. A first paid receipt can therefore
    // precede that inferred slice by one day. Resolve the effective first start
    // from its verified receipt without rewriting money, links or grants.
    // Renewals retain their exact provider slice, including future periods.
    const effectiveSliceStart = (slice, payment, link) => {
      const contract = link && verifiedContracts.find(row => row.contract_id === link.contract_id);
      const first = contract && (lifecycleRows.firstRecurringReceipts ?? []).find(row =>
        row.contract_id === contract.contract_id && row.operation_id === link.operation_id);
      const paidAt = payment?.occurred_at;
      if (!contract || !first || contract.first_payment_ledger_entry_id !== payment?.ledger_entry_id ||
          link.ledger_entry_id !== payment.ledger_entry_id || first.evidence_sha256 !== link.evidence_sha256 ||
          !positive(paidAt) || paidAt !== link.occurred_at || paidAt < contract.created_at ||
          paidAt > payment.recorded_at || paidAt > link.recorded_at || link.recorded_at > first.verified_at ||
          paidAt > slice.starts_at || slice.starts_at - paidAt > 86400) return slice.starts_at;
      return paidAt;
    };
    const verifiedBonuses = bonuses.filter(validBonus);
    const sourceBase = { storedPlan: plan?.plan_code ?? null, storedState: state?.access_state ?? null, effectivePlan: 'free', accessOverlay: 'none',
      accessState: state?.access_state ?? 'none', status: 'review_required', reasonCode: 'access_source_review_required',
      sourceKind: null, sourceRef: null, sourceRevision: null, sourceFingerprint: null, validUntil: deadline };
    let access = { ...sourceBase };
    let subscriptionTimeline = { verified:false, sourceKind:null, startsAt:null, expiresAt:null };
    let verifiedPrepaidSubscription = null;
    const setAccess = (reasonCode, effectivePlan = 'free', extra = {}) => { access = { ...sourceBase, status: 'verified', reasonCode, effectivePlan, ...extra }; };
    const current = subscriptions.filter(s => ['active', 'cancel_at_period_end', 'suspended'].includes(s.status));
    const planStart = authoritySeconds(plan?.effective_from), planEnd = authoritySeconds(plan?.effective_until), stateEnd = authoritySeconds(state?.state_ends_at);
    const stateStart = authoritySeconds(state?.state_started_at);
    const canonicalDates = plan && state && positive(plan.revision) && positive(state.revision) && planStart !== null && planStart <= now &&
      plan.source_code === state.source_code;
    const verifiedRecurringSubscriptions = subscriptions.filter(sub => {
      if (sub.billing_mode !== 'recurring' || sub.telegram_id !== telegramId || !positive(sub.revision) || !PAID.has(sub.plan_code)) return false;
      const relevant = slices.filter(slice => slice.subscription_id === sub.subscription_id && slice.telegram_id === telegramId);
      const source = relevant.find(slice => slice.order_id === sub.source_order_id), lastLedger = ledgerMap.get(sub.last_ledger_entry_id);
      if (!source || relevant.length === 0 || relevant.some(slice => slice.plan_code !== sub.plan_code || !validPaymentSlice(slice,true)) ||
          ledgerMap.get(source.payment_ledger_entry_id)?.telegram_payment_charge_id !== sub.telegram_payment_charge_id ||
          !lastLedger || !relevant.some(slice => slice.payment_ledger_entry_id === lastLedger.ledger_entry_id || slice.compensation_ledger_entry_id === lastLedger.ledger_entry_id)) return false;
      if (relevant.some(slice => orderMap.get(slice.order_id)?.billing_mode !== 'recurring') ||
          new Set(relevant.map(slice => recurringLinks.get(slice.payment_ledger_entry_id)?.contract_id)).size !== 1) return false;
      const live = relevant.filter(slice => slice.status === 'active').sort((a,b) => b.ends_at-a.ends_at || b.starts_at-a.starts_at);
      const latest = live[0] ?? [...relevant].sort((a,b) => b.ends_at-a.ends_at || b.starts_at-a.starts_at)[0];
      const extensions = verifiedBonuses.filter(bonus => bonus.delivery_mode === 'extend_active_plan' &&
        bonus.target_subscription_id === sub.subscription_id && bonus.plan_code === sub.plan_code &&
        effectMap.get(bonus.bonus_grant_id)?.effect_kind === 'paid_plan_extension');
      const expectedEnd = latest.ends_at + extensions.reduce((seconds,bonus) => seconds+bonus.bonus_seconds,0);
      return sub.current_period_start === latest.starts_at && sub.current_period_end === expectedEnd &&
        (!current.includes(sub) || plan && state && positive(plan.revision) && positive(state.revision) &&
          plan.source_code === state.source_code && planStart === sub.current_period_start && stateStart === sub.current_period_start &&
          plan.plan_code === sub.plan_code && planEnd === sub.current_period_end &&
          stateEnd === sub.current_period_end && ['stars_payment','stars_refund','stars_chargeback','referral_bonus_extension','referral_bonus_compensation'].includes(plan.source_code));
    });
    if (legacy?.access_tier === 'team' || plan && !PLANS.has(plan.plan_code)) access.reasonCode = 'legacy_team_requires_manual_review';
    else if (state?.access_state === 'suspended' || current.some(s => s.status === 'suspended') || subscriptions.some(s => s.status === 'chargeback' && state?.source_code === 'stars_chargeback')) {
      setAccess('paid_access_suspended', 'free', { accessState: 'suspended' });
    } else if (['refunded','expired'].includes(state?.access_state)) setAccess('access_' + state.access_state, 'free');
    else if (current.length === 1 && current[0].billing_mode === 'recurring' && verifiedRecurringSubscriptions.includes(current[0])) {
      const sub = current[0];
      setAccess('stars_source_verified', sub.plan_code, { sourceKind:'stars', sourceRef:'stars:'+sub.subscription_id,
        sourceRevision:sub.revision, validUntil:Math.min(deadline,sub.current_period_end) });
      subscriptionTimeline = { verified:true, sourceKind:'stars', startsAt:sub.current_period_start, expiresAt:sub.current_period_end };
    }
    else if (current.length === 1 && canonicalDates && PAID.has(plan.plan_code) && ['active','cancel_at_period_end'].includes(state.access_state)) {
      const sub = current[0], relevantSlices = slices.filter(s => s.subscription_id === sub.subscription_id && s.telegram_id === telegramId);
      const extensions = verifiedBonuses.filter(b => b.delivery_mode === 'extend_active_plan' && b.target_subscription_id === sub.subscription_id && b.plan_code === sub.plan_code &&
        effectMap.get(b.bonus_grant_id)?.effect_kind === 'paid_plan_extension' && effectMap.get(b.bonus_grant_id)?.target_subscription_id === sub.subscription_id);
      const sourceSlice = relevantSlices.find(s => s.order_id === sub.source_order_id);
      const issuedSeconds = relevantSlices.filter(s => s.status === 'active').reduce((sum, s) => sum + s.access_seconds, 0) + extensions.reduce((sum, b) => sum + b.bonus_seconds, 0);
      const lastLedger = ledgerMap.get(sub.last_ledger_entry_id);
      const consistent = sub.billing_mode === 'prepaid' && positive(sub.revision) && sub.plan_code === plan.plan_code && sub.status === state.access_state &&
        sub.current_period_start <= now && sub.current_period_end > sub.current_period_start && planEnd === sub.current_period_end && stateEnd === sub.current_period_end &&
        ['stars_payment','referral_bonus_extension','referral_bonus_compensation'].includes(plan.source_code) &&
        sourceSlice && sourceSlice.starts_at === sub.current_period_start && sourceSlice.plan_code === sub.plan_code &&
        ledgerMap.get(sourceSlice.payment_ledger_entry_id)?.telegram_payment_charge_id === sub.telegram_payment_charge_id &&
        relevantSlices.length > 0 && relevantSlices.every(s => s.plan_code === sub.plan_code &&
          orderMap.get(s.order_id)?.billing_mode === 'prepaid' && validPaymentSlice(s, true)) &&
        lastLedger && relevantSlices.some(s => s.payment_ledger_entry_id === lastLedger.ledger_entry_id || s.compensation_ledger_entry_id === lastLedger.ledger_entry_id) &&
        sub.current_period_end === sub.current_period_start + issuedSeconds && issuedSeconds > 0;
      if (consistent) {
        verifiedPrepaidSubscription = sub;
        if (sub.current_period_end <= now) setAccess('access_expired', 'free', { accessState: 'expired' });
        else setAccess('stars_source_verified', sub.plan_code, { sourceKind: 'stars', sourceRef: 'stars:' + sub.subscription_id,
          sourceRevision: sub.revision, validUntil: Math.min(deadline, sub.current_period_end) });
        subscriptionTimeline = { verified:true, sourceKind:'stars', startsAt:sub.current_period_start, expiresAt:sub.current_period_end };
      }
    } else if (canonicalDates && plan.plan_code === 'professional' && state.access_state === 'active' && plan.source_code === 'referral_bonus_manual' && current.length === 0) {
      const matches = verifiedBonuses.filter(b => b.delivery_mode === 'manual_claim' && b.plan_code === 'professional' && b.target_subscription_id === null &&
        b.starts_at <= now && planEnd === b.ends_at && stateEnd === b.ends_at && stateStart === b.starts_at && planStart === b.starts_at &&
        effectMap.get(b.bonus_grant_id)?.effect_kind === 'manual_professional_access' && effectMap.get(b.bonus_grant_id)?.result_plan_revision === plan.revision &&
        effectMap.get(b.bonus_grant_id)?.result_access_revision === state.revision);
      if (matches.length === 1) { const bonus = matches[0];
        if (bonus.ends_at <= now) setAccess('access_expired', 'free', { accessState: 'expired' });
        else setAccess('referral_bonus_source_verified', 'professional', { sourceKind: 'referral_bonus', sourceRef: 'referral_bonus:' + bonus.bonus_grant_id,
          sourceRevision: bonus.revision, validUntil: Math.min(deadline, bonus.ends_at) });
        subscriptionTimeline = { verified:true, sourceKind:'referral_bonus', startsAt:bonus.starts_at, expiresAt:bonus.ends_at };
      }
    } else if (canonicalDates && plan.plan_code === 'free' && state.access_state === 'trial' && current.length === 0 && legacy?.access_tier === 'trial') {
      const preview = one(previews);
      if (env.DRAGON_PREVIEW_ENABLED === 'true' && preview?.status === 'active' && preview.source_code === 'dragon_preview:v1.3.5-hotfix.1' &&
          preview.started_at <= now && preview.ends_at === preview.started_at + 604800 && legacy.trial_used === 1 &&
          state.source_code === preview.source_code && stateStart === preview.started_at && stateEnd === preview.ends_at &&
          authoritySeconds(legacy.trial_started_at) === preview.started_at && authoritySeconds(legacy.trial_ends_at) === preview.ends_at &&
          planEnd === null && planStart === preview.started_at && !subscriptions.some(s => s.created_at >= preview.started_at)) {
        if (preview.ends_at <= now) setAccess('access_expired', 'free', { accessState: 'expired' });
        else setAccess('preview_source_verified', 'free', { accessOverlay: 'dragon_preview', sourceKind: 'preview', sourceRef: 'preview:' + preview.grant_id,
          sourceRevision: preview.updated_at, validUntil: Math.min(deadline, preview.ends_at) });
        subscriptionTimeline = { verified:true, sourceKind:'preview', startsAt:preview.started_at, expiresAt:preview.ends_at };
      }
    } else if ((!plan && !state || plan?.plan_code === 'free' && ['none','expired','refunded'].includes(state?.access_state)) &&
      (!legacy || legacy.access_tier === 'free') && current.length === 0 && !previews.some(p => p.status === 'active' && p.ends_at > now)) {
      setAccess(user ? 'free_source_verified' : 'unregistered_actor', 'free');
    }
    const terminalPrepaid = subscriptions.filter(sub => sub.telegram_id === telegramId && sub.billing_mode === 'prepaid' &&
      ['expired','refunded','chargeback'].includes(sub.status) && positive(sub.revision) &&
      slices.some(slice => slice.subscription_id === sub.subscription_id && slice.telegram_id === telegramId) &&
      slices.filter(slice => slice.subscription_id === sub.subscription_id && slice.telegram_id === telegramId)
        .every(slice => orderMap.get(slice.order_id)?.billing_mode === 'prepaid' && validPaymentSlice(slice,true)));
    const verifiedSubscriptions = [...new Set([...(verifiedPrepaidSubscription ? [verifiedPrepaidSubscription] : []),
      ...terminalPrepaid,...verifiedRecurringSubscriptions])];
    const periods = [];
    for (const sub of verifiedSubscriptions) {
      const ownSlices = slices.filter(slice => slice.subscription_id === sub.subscription_id && slice.telegram_id === telegramId)
        .sort((a,b) => a.starts_at-b.starts_at || a.grant_id.localeCompare(b.grant_id));
      let compactStart = sub.current_period_start;
      for (const slice of ownSlices) {
        const payment = ledgerMap.get(slice.payment_ledger_entry_id), link = recurringLinks.get(slice.payment_ledger_entry_id);
        const startsAt = sub.billing_mode === 'prepaid' && slice.status === 'active' ? compactStart : effectiveSliceStart(slice,payment,link);
        const endsAt = sub.billing_mode === 'prepaid' && slice.status === 'active' ? startsAt+slice.access_seconds : slice.ends_at;
        if (sub.billing_mode === 'prepaid' && slice.status === 'active') compactStart = endsAt;
        periods.push({ subscriptionId:sub.subscription_id, planCode:sub.plan_code, startsAt, endsAt, status:slice.status,
          sourceKind:'payment',
          ledgerEntryId:payment.ledger_entry_id, chargeId:payment.telegram_payment_charge_id,
          contractId:link?.contract_id ?? null, occurredAt:link?.occurred_at ?? payment.occurred_at,
          recordedAt:payment.recorded_at, compensatedAt:ledgerMap.get(slice.compensation_ledger_entry_id)?.occurred_at ?? null });
      }
      const extensions = verifiedBonuses.filter(bonus => bonus.delivery_mode === 'extend_active_plan' &&
        bonus.target_subscription_id === sub.subscription_id && bonus.plan_code === sub.plan_code &&
        effectMap.get(bonus.bonus_grant_id)?.effect_kind === 'paid_plan_extension');
      let extensionStart = sub.billing_mode === 'prepaid' ? compactStart : Math.max(...ownSlices.filter(slice => slice.status === 'active').map(slice => slice.ends_at));
      for (const bonus of extensions) {
        if (!positive(extensionStart)) break;
        periods.push({ subscriptionId:sub.subscription_id, planCode:sub.plan_code, startsAt:extensionStart,
          endsAt:extensionStart+bonus.bonus_seconds, status:'active', sourceKind:'referral_bonus', ledgerEntryId:'bonus:'+bonus.bonus_grant_id,
          chargeId:'bonus:'+bonus.bonus_grant_id, contractId:sub.billing_mode === 'recurring' ? recurringLinks.get(ownSlices[0].payment_ledger_entry_id)?.contract_id ?? null : null,
          occurredAt:bonus.applied_at, recordedAt:bonus.applied_at, compensatedAt:null });
        extensionStart += bonus.bonus_seconds;
      }
    }
    // Earned manual referral access has genuine immutable reward/effect
    // evidence but no own financial ledger. Keep it in the same time contour
    // so a separately purchased package waits for this lawful residual too.
    // These summaries exist only in memory; never fabricate paid-source FKs.
    for (const bonus of verifiedBonuses.filter(row=>row.delivery_mode==='manual_claim'&&
      row.target_subscription_id===null&&effectMap.get(row.bonus_grant_id)?.effect_kind==='manual_professional_access')) {
      const subscriptionId='bonus:'+bonus.bonus_grant_id;
      verifiedSubscriptions.push({subscription_id:subscriptionId,telegram_id:telegramId,plan_code:bonus.plan_code,
        billing_mode:'prepaid',status:'active',current_period_start:bonus.starts_at,current_period_end:bonus.ends_at,
        revision:bonus.revision,source_kind:'referral_bonus',source_order_id:null,telegram_payment_charge_id:null,
        last_ledger_entry_id:null,auto_renew:0,created_at:bonus.applied_at,updated_at:bonus.updated_at});
      periods.push({subscriptionId,planCode:bonus.plan_code,startsAt:bonus.starts_at,endsAt:bonus.ends_at,status:'active',
        sourceKind:'referral_bonus',ledgerEntryId:'bonus:'+bonus.bonus_grant_id,chargeId:'bonus:'+bonus.bonus_grant_id,
        contractId:null,occurredAt:bonus.applied_at,recordedAt:bonus.applied_at,compensatedAt:null});
    }
    periods.push(...packageBonusSource.periods);verifiedSubscriptions.push(...packageBonusSource.subscriptions);
    periods.forEach(period => { timegate(period.startsAt); timegate(period.endsAt); });
    const contractMap = index(verifiedContracts,'contract_id'), commandMap = index(lifecycleRows.commands,'command_id');
    const commandAcknowledgementHashes = new Map(await Promise.all(lifecycleRows.commands.filter(command => command.state === 'confirmed')
      .map(async command => [command.command_id,await sha256Hex(JSON.stringify([command.command_id,command.action,'confirmed','']))])));
    const verifiedProviderEvents = lifecycleRows.providerEvents.filter(event => {
      const contract = contractMap.get(event.contract_id);
      if (!contract || event.telegram_id !== telegramId || !positive(event.received_at) || event.received_at < contract.created_at ||
          !digest(event.evidence_sha256) ||
          !['provider_control','renewal_failed','command_confirmed','review_observed'].includes(event.event_type)) return false;
      if (event.operation_id !== null && !lifecycleRows.paymentLinks.some(link => link.operation_id === event.operation_id &&
          link.contract_id === contract.contract_id && link.telegram_id === telegramId)) return false;
      if (event.event_type === 'command_confirmed') {
        const command = commandMap.get(event.command_id);
        if (!command || command.telegram_id !== telegramId || command.contract_id !== contract.contract_id ||
          command.state !== 'confirmed' || command.acknowledgement_event_id !== event.event_id) return false;
        if(event.source==='provider_response') return event.actor_type==='system'&&event.actor_id===null&&
          event.telegram_update_id===null&&event.provider_state===null&&event.provider_occurred_at===null&&
          event.reason_code==='telegram_command_acknowledged'&&command.attempted_count===1&&positive(command.attempted_at)&&
          event.received_at>=command.attempted_at&&event.evidence_sha256===commandAcknowledgementHashes.get(command.command_id);
        return event.source==='telegram_update'&&event.actor_type==='telegram'&&event.actor_id===null&&
          event.provider_occurred_at===null&&Number.isSafeInteger(event.telegram_update_id)&&event.telegram_update_id>=0&&
          ['active','canceled','failed'].includes(event.provider_state)&&
          command.state === 'confirmed' && command.acknowledgement_event_id === event.event_id &&
          command.attempted_count===1;
      }
      if (event.event_type === 'review_observed') return event.source === 'telegram_update' &&
        event.actor_type === 'telegram' && event.actor_id === null && event.telegram_update_id === null &&
        event.command_id === null && event.operation_id === null && event.provider_occurred_at === null &&
        ['active','canceled','failed'].includes(event.provider_state) &&
        ['provider_update_identity_conflict','provider_update_receipt_without_fact'].includes(event.reason_code);
      return event.source === 'telegram_update' && event.actor_type === 'telegram' && event.actor_id === null &&
        event.provider_occurred_at === null &&
        Number.isSafeInteger(event.telegram_update_id) && event.telegram_update_id >= 0 &&
        ['active','canceled','failed'].includes(event.provider_state) &&
        (event.event_type !== 'renewal_failed' || event.provider_state === 'failed');
    });
    const verifiedCommands = lifecycleRows.commands.filter(command => {
      const contract = contractMap.get(command.contract_id), payment = ledgerMap.get(command.first_payment_ledger_entry_id);
      return !!contract && command.telegram_id === telegramId && positive(command.revision) &&
        positive(command.expected_contract_revision) && command.expected_contract_revision <= contract.revision &&
        contract.first_payment_ledger_entry_id === command.first_payment_ledger_entry_id && payment?.entry_type === 'payment' &&
        payment.direction === 'credit' && payment.telegram_id === telegramId &&
        ['cancel_renewal','reenable_renewal'].includes(command.action) &&
        command.desired_auto_renew === (command.action === 'cancel_renewal' ? 0 : 1) &&
        ['admitted','attempted','confirmed','rejected','unknown','superseded'].includes(command.state) && digest(command.request_sha256);
    });
    const recurringClaims = subscriptions.some(sub => sub.telegram_id === telegramId && sub.billing_mode === 'recurring') ||
      slices.some(slice => slice.telegram_id === telegramId && orderMap.get(slice.order_id)?.billing_mode === 'recurring');
    const recurringReviewRequired = recurringClaims && (!lifecycleSchemaPresent || !lifecycleSourceAvailable ||
      subscriptions.some(sub => sub.telegram_id === telegramId && sub.billing_mode === 'recurring' && !verifiedRecurringSubscriptions.includes(sub)));
    const genuineChargeback = payments.some(reversal => {
      const payment = ledgerMap.get(reversal.related_ledger_entry_id), order = orderMap.get(payment?.order_id);
      return reversal.telegram_id === telegramId && reversal.entry_type === 'chargeback' && verifiedCompensation(payment?.ledger_entry_id).includes(reversal) &&
        payment?.entry_type === 'payment' && payment.direction === 'credit' && payment.telegram_id === telegramId &&
        order?.telegram_id === telegramId && reversal.order_id === payment.order_id && reversal.currency === payment.currency &&
        reversal.currency === 'XTR' && reversal.amount_stars === payment.amount_stars &&
        reversal.telegram_payment_charge_id === payment.telegram_payment_charge_id;
    });
    const inactiveExits=[];
    const inactiveHash='29b36909890ff6ffc0230f02a03f07eb00465af871a8ebbb21f9c222d61a0b0e',
      inactiveCode='telegram_400_detail_'+inactiveHash.slice(0,16),
      inactiveLegacy=verifiedContracts.filter(c=>c.retired_at===null&&c.plan_code==='professional'&&c.currency==='XTR'&&
        c.amount_stars===249&&c.period_seconds===2592000&&c.terms_revision==='2026-10-03.stars-recurring-v1'&&
        orderMap.get(c.origin_order_id)?.price_version===1),
      inactiveCandidates=lifecycleRows.commands.filter(c=>inactiveLegacy.some(contract=>contract.contract_id===c.contract_id)&&
        c.action==='cancel_renewal'&&c.state==='rejected'&&c.error_code===inactiveCode);
    if(packageSource.providerInactiveExitReady===true&&canonicalOwner&&telegramId===8987576334&&botId===8562951985&&inactiveCandidates.length&&
        !recurringReviewRequired&&!genuineChargeback&&!packageSourceInvalid&&!packageBonusInvalid&&
        !lifecycleRows.providerEvents.some(e=>e.event_type==='review_observed')){
      const audits=await read('admin_audit_log',"actor_id=? AND action='subscription_provider_diagnostic' AND entity_type='subscription_provider_command' AND entity_id IN (SELECT command_id FROM subscription_provider_commands WHERE telegram_id=? AND state='rejected' AND error_code=?)",
        [telegramId,telegramId,inactiveCode],'id'),
        refunds=await read('payment_refunds','telegram_id=?',[telegramId],'refund_id');
      for(const command of inactiveCandidates){
        const contract=inactiveLegacy.find(c=>c.contract_id===command.contract_id),first=ledgerMap.get(contract.first_payment_ledger_entry_id),
          reversal=one(verifiedCompensation(first?.ledger_entry_id)),
          refund=one(refunds.filter(r=>r.original_ledger_entry_id===first?.ledger_entry_id&&r.status==='applied'&&
            r.order_id===first.order_id&&r.telegram_id===telegramId&&r.telegram_payment_charge_id===first.telegram_payment_charge_id&&
            r.currency==='XTR'&&r.amount_stars===249&&r.requested_by_type==='admin'&&r.requested_by===telegramId&&
            r.reason_code==='admin_canary_validation')),
          event=one(lifecycleRows.providerEvents.filter(e=>e.command_id===command.command_id&&e.event_type==='command_rejected')),
          audit=one(audits.filter(a=>a.entity_id===command.command_id));
        let detail;try{detail=JSON.parse(audit?.details);}catch{continue;}
        if(!verifiedCommands.includes(command)||command.desired_auto_renew!==0||command.attempted_count!==1||
            !positive(command.attempted_at)||command.expected_contract_revision>contract.revision||command.acknowledgement_event_id!==null||
            !first||!reversal||reversal.entry_type!=='refund'||!refund||!positive(refund.applied_at)||
            command.attempted_at<=Math.max(refund.applied_at,reversal.recorded_at)||
            !periods.some(p=>p.contractId===contract.contract_id&&p.ledgerEntryId===first.ledger_entry_id&&p.status==='refunded')||
            !event||event.contract_id!==contract.contract_id||event.telegram_id!==telegramId||event.source!=='provider_response'||
            event.actor_type!=='system'||event.actor_id!==null||event.operation_id!==null||event.telegram_update_id!==null||
            event.provider_state!==null||event.provider_occurred_at!==null||event.reason_code!==inactiveCode||
            event.evidence_sha256!==await sha256Hex(JSON.stringify([command.command_id,command.action,'rejected',inactiveCode]))||
            !positive(event.received_at)||event.received_at<command.attempted_at||event.received_at>now||command.updated_at!==event.received_at||
            !positive(authoritySeconds(audit.created_at))||authoritySeconds(audit.created_at)<event.received_at||authoritySeconds(audit.created_at)>now||
            detail?.version!==1||detail.method!=='editUserStarSubscription'||detail.code!==inactiveCode||
            detail.httpStatus!==400||detail.apiErrorCode!==400||detail.descriptionCode!=='unclassified'||
            detail.descriptionSafe!=='Bad Request: SUBSCRIPTION_NOT_ACTIVE'||detail.descriptionSha256!==inactiveHash||
            detail.descriptionTruncated!==false)continue;
        const at=event.received_at,earlierEnable=verifiedCommands.filter(c=>c.contract_id===contract.contract_id&&c.state==='confirmed'&&c.action==='reenable_renewal'&&c.created_at<=at);
        if(earlierEnable.some(c=>c.attempted_at>=command.attempted_at||!verifiedProviderEvents.some(e=>
          e.event_id===c.acknowledgement_event_id&&e.source==='provider_response'&&e.received_at<command.attempted_at)))continue;
        let end=Infinity,invalid=false;
        const boundary=time=>{if(!positive(time)||time<=at)invalid=true;else end=Math.min(end,time);};
        for(const other of lifecycleRows.contracts.filter(c=>c.retired_at===null&&c!==contract))boundary(other.created_at);
        if(command.expected_contract_revision!==contract.revision)boundary(contract.updated_at);
        for(const other of lifecycleRows.commands.filter(c=>c.contract_id===contract.contract_id&&c!==command)){
          if(other.created_at>=at)boundary(other.created_at);
          else if(other.updated_at>at)boundary(other.updated_at);
          else if(['admitted','attempted','unknown'].includes(other.state))invalid=true;
        }
        for(const other of lifecycleRows.providerEvents.filter(e=>e.contract_id===contract.contract_id&&e!==event&&
          e.event_type!=='lifecycle_transition'&&e.received_at>=at))boundary(other.received_at);
        for(const r of refunds.filter(r=>['requested','confirmed','manual_review'].includes(r.status)))boundary(r.requested_at);
        for(const p of periods.filter(p=>p.status==='active'&&p.endsAt>at))boundary(p.occurredAt);
        for(const link of lifecycleRows.paymentLinks.filter(l=>l.contract_id===contract.contract_id&&l.direction==='incoming')){
          const paid=ledgerMap.get(link.ledger_entry_id),compensation=one(verifiedCompensation(link.ledger_entry_id));
          if(!paid)invalid=true;
          else if(paid.recorded_at>at)boundary(paid.recorded_at);
          else if(!compensation||compensation.entry_type!=='refund'||compensation.recorded_at>at)invalid=true;
        }
        for(const receipt of lifecycleRows.paymentReviewReceipts??[]){
          if(receipt.contract_id!==contract.contract_id)continue;
          const compensation=one(verifiedCompensation(receipt.ledger_entry_id));
          if(receipt.recorded_at>at)boundary(receipt.recorded_at);
          else if(!compensation||compensation.entry_type!=='refund'||compensation.recorded_at>at)invalid=true;
        }
        if(invalid)continue;
        const proof=freeze({contractId:contract.contract_id,revision:command.expected_contract_revision,
          firstPaymentLedgerEntryId:first.ledger_entry_id,commandId:command.command_id,eventId:event.event_id,observedAt:at,invalidatedAt:end});
        providerInactiveExits.set(proof,{contract});inactiveExits.push(proof);
      }
    }
    try {
      const unified=validateUnifiedPackageTimeline({source:packageSource,ordinaryPeriods:periods,contracts:verifiedContracts,
        commands:verifiedCommands,providerEvents:verifiedProviderEvents,providerInactiveExits:inactiveExits,nowSec:now});
      periods.splice(0,periods.length,...unified.periods);verifiedSubscriptions.push(...unified.subscriptions);
    } catch(error) {packageSourceInvalid=true;degrade('subscription_package_periods',error?.code??'package_access_source_invalid');}
    const projectionOverflow = periods.length > MAX_ROWS;
    const genuineReviewObservation = (lifecycleRows.paymentReviewReceipts ?? []).some(receipt => {
      const payment = ledgerMap.get(receipt.ledger_entry_id), origin = orderMap.get(receipt.origin_order_id);
      return receipt.telegram_id === telegramId && payment?.telegram_id === telegramId && payment.order_id === origin?.order_id &&
        payment.entry_type === 'payment' && payment.direction === 'credit' && payment.reason_code === 'payment_review_retained' &&
        verifiedCompensation(payment.ledger_entry_id).length === 0 &&
        !slices.some(slice=>slice.payment_ledger_entry_id===payment.ledger_entry_id&&
          slice.order_id===settledPayments.get(payment.ledger_entry_id)?.child.order_id&&validPaymentSlice(slice,true)) &&
        origin.telegram_id === telegramId && origin.plan_code === receipt.plan_code &&
        receipt.external_invoice_payload === origin.invoice_payload && digest(receipt.external_payload_sha256) &&
        payment.amount_stars === origin.amount_stars && payment.currency === origin.currency && digest(receipt.evidence_sha256);
    });
    const sourceToken = Object.freeze({ version:1 });
    lifecycleSources.set(sourceToken,{ context, validUntil:deadline, captures:[...captures], facts:freeze({ telegramId,
      subscriptions:verifiedSubscriptions, periods:projectionOverflow ? [] : periods, contracts:verifiedContracts, providerEvents:verifiedProviderEvents,
      commands:verifiedCommands, providerInactiveExits:inactiveExits, reviewResolutions:[], reviewRequired:recurringReviewRequired || projectionOverflow || packageSourceInvalid || packageBonusInvalid,
      reviewReasons:[...(packageSourceInvalid ? ['package_paid_source_review_required'] : []),...(projectionOverflow ? ['paid_projection_overflow'] : []),
        ...(genuineReviewObservation ? ['financial_observation_review_required'] : []),
        ...verifiedProviderEvents.filter(event => event.event_type === 'review_observed').map(event => event.reason_code),
        ...(lifecycleRows.providerEvents.some(event => ['provider_control','renewal_failed'].includes(event.event_type) &&
          !verifiedProviderEvents.includes(event)) ? ['control_evidence_invalid'] : [])],
      administrativelySuspended:(state?.access_state === 'suspended' || current.some(sub => sub.status === 'suspended')) &&
        !(state?.source_code === 'stars_chargeback' && genuineChargeback),
      chargebackSuspended:state?.source_code === 'stars_chargeback' && genuineChargeback }) });
    const verifiedLifecycleFacts = createLifecycleAuthorityBridge().verify(sourceToken);
    const lifecycle = projectVerifiedSubscriptionLifecycle({ verifiedFacts:verifiedLifecycleFacts, nowSec:now });
    // Unknown renewal control does not make an independently verified paid
    // ending unknown. Keep its review banner, but derive Free at the genuine
    // financial boundary even before maintenance updates the stored head.
    // Financial/identity review and unrelated lawful sources retain their
    // existing conservative path.
    const endedVerifiedPeriod = !recurringReviewRequired && !projectionOverflow &&
      access.reasonCode !== 'legacy_team_requires_manual_review' &&
      current.every(sub=>verifiedSubscriptions.includes(sub)) &&
      lifecycle.state === 'expired' && lifecycle.reasonCode === 'verified_paid_period_ended' &&
      positive(lifecycle.startsAt) && positive(lifecycle.paidUntil) && lifecycle.paidUntil <= now &&
      verifiedSubscriptions.some(sub=>sub.subscription_id===lifecycle.subscriptionId) &&
      lifecycle.reviewReasons.every(reason=>['control_identity_conflict','control_order_ambiguous',
        'control_evidence_invalid','provider_command_unknown','provider_update_identity_conflict',
        'provider_update_receipt_without_fact','provider_command_order_ambiguous',
        'provider_command_ack_order_ambiguous','provider_reenable_permission_pending'].includes(reason));
    if ((recurringReviewRequired || projectionOverflow || packageSourceInvalid || packageBonusInvalid || lifecycle.reviewRequired && !lifecycle.paidAccess &&
        access.sourceKind === 'stars' && !endedVerifiedPeriod) &&
        access.sourceKind !== 'preview' && access.sourceKind !== 'referral_bonus') access = { ...sourceBase };
    else if (lifecycle.subscriptionId && (lifecycle.paidAccess && (lifecycle.subscriptionId.startsWith('package:') || lifecycle.subscriptionId.startsWith('bonus:package:')) ||
      !['preview','referral_bonus'].includes(access.sourceKind))) {
      if (lifecycle.paidAccess) {
        const sub = verifiedSubscriptions.find(row => row.subscription_id === lifecycle.subscriptionId);
        const packageCurrent=sub.subscription_id.startsWith('package:');
        const referralCurrent=sub.source_kind==='referral_bonus'&&sub.subscription_id.startsWith('bonus:');
        const sourceKind=packageCurrent?'package_payment':referralCurrent?'referral_bonus':'stars';
        setAccess(packageCurrent?'package_source_verified':referralCurrent?'referral_bonus_source_verified':'stars_source_verified',
          lifecycle.planCode,{ sourceKind,sourceRef:packageCurrent?sub.subscription_id:referralCurrent?
            'referral_bonus:'+sub.subscription_id.slice(6):'stars:'+sub.subscription_id,
          sourceRevision:sub.revision, accessState:lifecycle.state, validUntil:Math.min(deadline,lifecycle.accessUntil) });
        subscriptionTimeline = { verified:true,sourceKind,startsAt:lifecycle.startsAt,expiresAt:lifecycle.paidUntil };
      } else if (access.status === 'verified' || endedVerifiedPeriod) {
        setAccess(lifecycle.state === 'chargeback' || lifecycle.state === 'suspended' ? 'paid_access_suspended' :
          lifecycle.state ? 'access_'+lifecycle.state : lifecycle.reasonCode,
          'free',{ accessState:lifecycle.state === 'chargeback' ? 'suspended' : lifecycle.state ?? 'none' });
        if (positive(lifecycle.startsAt) && positive(lifecycle.paidUntil)) subscriptionTimeline =
          { verified:true,sourceKind:lifecycle.subscriptionId?.startsWith('package:')?'package_payment':'stars',startsAt:lifecycle.startsAt,expiresAt:lifecycle.paidUntil };
      }
    }
    if (access.sourceKind) access.sourceFingerprint = await sha256Hex(canonicalPolicyJson({ domain: 'v1.4.1.verified-access-source', accountFingerprint,
      sourceKind: access.sourceKind, sourceRef: access.sourceRef, sourceRevision: access.sourceRevision,
      plan, state, subscriptions: current, slices, bonuses: verifiedBonuses, effects, rewards, candidates, payments, orders, prices, previews,
      ...(recurringClaims || settledPayments.size || packageSource.present || packageBonusSource.present ? { lifecycleRows,lifecycle,packageSource,packageBonusSource } : {}) }));
    const financialSourceAvailable = !degradedTables.some(row=>FINANCIAL_SOURCE_TABLES.has(row.table));
    const foundationMetadataAvailable = !degradedTables.some(row=>FOUNDATION_METADATA_TABLES.has(row.table)) && policyReady;
    if (!financialSourceAvailable) access = { ...sourceBase, reasonCode:'access_source_unavailable', validUntil:deadline };
    const sealedRows = new Set();
    for (const [table, rows] of [['entitlement_grants',metadata],['entitlement_overrides',overrideRows],['feature_flag_assignments',assignmentRows]]) {
      for (const row of rows) if (row.subject_source_fingerprint === accountFingerprint && await verifyAuthoritySeal(table,row,env)) sealedRows.add(row);
    }
    const liveMetadata = row => foundationMetadataAvailable && financialSourceAvailable && accountFingerprint && CUSTOMER_CAPS.has(row.capability) && row.policy_version === FOUNDATION_POLICY_VERSION &&
      (row.scope_kind !== 'actor' || row.scope_key === 'actor:' + telegramId) && (row.scope_kind !== 'tenant' || row.scope_key === 'bot:' + botId) &&
      (sealedRows.has(row) || unsigned(row) && row.issued_by === canonicalOwnerId && authorizedIssuer && typeof row.reason === 'string' && row.reason.trim().length > 0) && positive(row.revision) &&
      positive(row.starts_at) && positive(row.expires_at) && row.starts_at <= now && row.expires_at > now && row.revoked_at === null &&
      ['actor','resource','tenant'].includes(row.scope_kind) && typeof row.scope_key === 'string' && row.scope_key.length > 0;
    const grants = [];
    for (const row of metadata.filter(liveMetadata)) {
      let verified = false;
      if (row.source_kind === 'manual_capability' && row.source_ref === 'manual:' + row.grant_id && row.source_revision === 1) verified = sealedRows.has(row) || row.source_fingerprint === await manualGrantSourceFingerprint(row, accountFingerprint);
      else if (row.source_kind === 'verified_existing_source' && access.status === 'verified' && access.sourceRef && row.source_ref === access.sourceRef && row.source_revision === access.sourceRevision) {
        verified = row.source_fingerprint === await sha256Hex(canonicalPolicyJson({ domain: 'v1.4.1.grant-source', accountFingerprint,
          sourceKind: access.sourceKind, sourceRef: access.sourceRef, sourceRevision: access.sourceRevision, sourceFingerprint: access.sourceFingerprint }));
      }
      if (verified) grants.push(aliases(row));
    }
    const verifiedAssignments = assignmentRows.filter(row => foundationMetadataAvailable && accountFingerprint && row.subject_kind === 'actor' && row.subject_telegram_id === telegramId &&
      row.subject_key === 'actor:' + telegramId && row.subject_source_fingerprint === accountFingerprint && (sealedRows.has(row) || unsigned(row) && row.assigned_by === canonicalOwnerId && authorizedIssuer) &&
      row.revoked_at === null && positive(row.revision) && row.starts_at <= now && row.expires_at > now && currentFlags.some(flag => flag.sourceVerified === true && flag.flag_key === row.flag_key && flag.policy_version === FOUNDATION_POLICY_VERSION)).map(row => freeze({...row,sourceVerified:true}));
    const overrides = overrideRows.filter(row => liveMetadata(row) && row.subject_source_fingerprint === accountFingerprint).map(aliases);
    const approvedApplication = !!application && !!profile && profile.application_id === application.id && application.status === 'approved' && application.age_confirmed === 1 &&
      positive(application.reviewed_by) && application.reviewed_by !== telegramId && application.reviewed_at !== null && profile.approved_by === application.reviewed_by;
    const legalProfile = legal && legal.partner_profile_id === profileId && legal.verification_state === 'self_declared' && legal.verified_by === null && legal.verified_at === null &&
      positive(legal.revision) && legal.declared_by === telegramId ? { kind: legal.profile_kind, verificationState: 'self_declared', revision: legal.revision } : null;
    const sourceFingerprint = await sha256Hex(canonicalPolicyJson({ domain: 'v1.4.1.actor-source', accountFingerprint, snapshots: captures.map(c => c.snapshot) }));
    access.validUntil = Math.min(access.validUntil, deadline);
    access.lifecycle = lifecycle;
    const actor = freeze({ version: 1, actorKind: 'customer', telegramId, botId, nowSeconds: now, validUntil: deadline, identityValidUntil: identityDeadline,
      policyVersion: FOUNDATION_POLICY_VERSION, policyCapability, policyReady, protectedAuthorityFallback: protectedOperation && (!policyReady || degradedTables.length>0),
      foundationMetadataAvailable, financialSourceAvailable, degradedTables, currentFlags, verifiedAssignments, accountFingerprint, sourceFingerprint,
      account: { exists: !!user, acceptedTerms: user?.accepted_terms === 1, isBlocked: user?.is_blocked === 1, pendingDeletion, accountFingerprint },
      roles, canonicalOwner, partner: { profileId: profile?.id ?? null, status: profile?.status ?? null, approvedApplication,
        ageConfirmed: approvedApplication, betaAccess, betaSettings }, legalProfile, access, grants, overrides,
      ai: { settings, consent, enabledPreference: legacy?.ai_enabled === 1, previewDailyLimit: 30 },
      canonical: { user, roleRows, partnerProfile: profile, application, betaSettings, rawBetaSettings, releaseLease, betaAccess, legalProfile: legal, sealedMetadataTables: [...sealTables],
        entitlementGrants: metadata, entitlementOverrides: overrideRows, capabilityCatalog: catalogRows, planCapabilities: planRows, featureFlags: currentFlags, featureFlagAssignments: assignmentRows } });
    actors.set(actor, { context, captures, identityCaptures });
    lifecycleActors.set(actor, verifiedLifecycleFacts);
    const ownCredits=payments.filter(row=>row.telegram_id===telegramId&&row.entry_type==='payment'&&row.direction==='credit');
    const receiptEntries=[];
    let invalidHistorySource=false;
    for(const payment of ownCredits) {
      const order=orderMap.get(payment.order_id),price=prices.find(row=>row.price_id===order?.price_id&&row.price_version===order?.price_version);
      if(!order||order.telegram_id!==telegramId||!PAID.has(order.plan_code)||!['prepaid','recurring'].includes(order.billing_mode)||
          payment.currency!=='XTR'||!positive(payment.amount_stars)||payment.amount_stars!==order.amount_stars||
          payment.related_ledger_entry_id!==null||!positive(payment.occurred_at)||!positive(payment.recorded_at)||
          !price||['plan_code','currency','amount_stars','access_seconds','billing_mode','terms_revision'].some(key=>price[key]!==order[key])||
          !['approved','retired'].includes(price.publication_state)||price.valid_from>order.created_at||
          price.valid_until!==null&&price.valid_until<=order.created_at) {invalidHistorySource=true;continue;}
      const grant=slices.find(slice=>slice.telegram_id===telegramId&&slice.payment_ledger_entry_id===payment.ledger_entry_id&&validPaymentSlice(slice,true));
      const packagePeriod=packageSourceInvalid?null:packageSource.periods.find(period=>period.ledgerEntryId===payment.ledger_entry_id);
      const reversals=verifiedCompensation(payment.ledger_entry_id);
      const retained=(lifecycleRows.paymentReviewReceipts??[]).some(receipt=>receipt.ledger_entry_id===payment.ledger_entry_id&&
        receipt.telegram_id===telegramId&&receipt.origin_order_id===order.order_id&&receipt.plan_code===order.plan_code&&
        receipt.external_invoice_payload===order.invoice_payload&&digest(receipt.external_payload_sha256)&&digest(receipt.evidence_sha256));
      const review=payment.reason_code==='payment_review_retained'&&!retained||reversals.length>1||
        compensation(payment.ledger_entry_id).length!==reversals.length;
      const status=reversals.some(row=>row.entry_type==='chargeback')?'chargeback':
        reversals.some(row=>row.entry_type==='refund')?'refunded':review?'review':grant?.status==='active'||packagePeriod?.status==='active'?'paid':
          retained?'retained':'recorded';
      receiptEntries.push({ledgerEntryId:payment.ledger_entry_id,planCode:order.plan_code,amountStars:payment.amount_stars,
        currency:payment.currency,occurredAt:payment.occurred_at,billingMode:order.billing_mode,status,
        paidPeriod:grant?{startsAt:effectiveSliceStart(grant,payment,recurringLinks.get(payment.ledger_entry_id)),endsAt:grant.ends_at}:
          packagePeriod?{startsAt:packagePeriod.startsAt,endsAt:packagePeriod.endsAt}:null,
        reviewRequired:review||status==='retained'||status==='recorded'});
    }
    receiptEntries.sort((a,b)=>b.occurredAt-a.occurredAt||a.ledgerEntryId.localeCompare(b.ledgerEntryId));
    financialHistoryActors.set(actor,freeze({telegramId,available:financialSourceAvailable,
      reasonCode:!financialSourceAvailable?'subscription_history_unavailable':invalidHistorySource?'history_evidence_review_required':null,
      entries:financialSourceAvailable?receiptEntries:[]}));
    if (subscriptionReading) {
      const historyRows = [...previews, ...previewHistory];
      const used = historyRows.length > 0 || legacy?.trial_used === 1 ? true :
        financialSourceAvailable && previewHistoryAvailable && legacy?.trial_used === 0 ? false : null;
      const historical = historyRows.find(row => row.source_code === 'dragon_preview:v1.3.5-hotfix.1' &&
        positive(row.started_at) && row.started_at <= now && positive(row.granted_at) && row.granted_at <= now &&
        row.ends_at === row.started_at + DRAGON_PREVIEW_DURATION_SECONDS);
      const activePreview = access.status === 'verified' && access.accessOverlay === 'dragon_preview';
      const configurationReady = previewConfig.enabled && trusted.previewWorkflowConnected === true &&
        previewConfig.problems.every(problem => problem === 'workflow_binding');
      let activationReason = 'membership_check_required';
      if (!accountFingerprint || !user || user.is_blocked === 1 || pendingDeletion) activationReason = 'user_unavailable';
      else if (user.accepted_terms !== 1) activationReason = 'terms_required';
      else if (activePreview) activationReason = 'preview_active';
      else if (used === true) activationReason = 'preview_already_used';
      else if (!previewConfig.enabled) activationReason = 'preview_disabled';
      else if (previewConfig.problems.includes('program_closed')) activationReason = 'preview_program_closed';
      else if (!configurationReady) activationReason = 'preview_configuration_required';
      else if (!financialSourceAvailable || access.status !== 'verified' || used === null) activationReason = 'access_source_unavailable';
      else if (!legacy || legacy.access_tier !== 'free' || plan?.plan_code && plan.plan_code !== 'free' ||
        access.effectivePlan !== 'free' || ['active','cancel_at_period_end','refunded','suspended'].includes(access.accessState))
        activationReason = 'preview_access_conflict';
      subscriptionActors.set(actor, freeze({
        lifecycle,
        timeline:financialSourceAvailable && access.status === 'verified' ? subscriptionTimeline :
          { verified:false, sourceKind:null, startsAt:null, expiresAt:null },
        preview:{ historyUsed:used, historyStatus:used === true ? 'used' : used === false ? 'not_used' : 'unknown',
          startsAt:historical?.started_at ?? null, expiresAt:historical?.ends_at ?? null,
          canRequestActivation:activationReason === 'membership_check_required', reasonCode:activationReason,
          eligibility:activationReason === 'membership_check_required' ? 'check_required' : 'unavailable',
          membershipCheckRequired:true, durationSeconds:DRAGON_PREVIEW_DURATION_SECONDS, oneTime:true },
      }));
    }
    compileAuthorityAssertions(actor); // Every independent predicate fits a D1 guard statement.
    return actor;
}

export function createAuthorityResolver() {
  return Object.freeze({resolveActor:context=>resolveCanonicalActor(context)});
}

// A fixed notification service can inspect a canonical subscription's
// financial history, but cannot mint a customer context or customer decision.
// Its private result carries the same ledger verifier and source fences used
// by own access; no caller supplies a subject or paid facts.
export async function resolveServiceSubscriptionFinancialFacts({context,subscriptionId}={}) {
  if(!isTrustedContext(context)) fail('untrusted_context');
  const identity=readTrustedContext(context);
  if(identity.actorKind!=='service'||identity.purpose!=='historical_notification'||
      identity.operation!=='service.notification.deliver_historical'||identity.executorPurpose!=='notification_deliver_historical'||
      typeof subscriptionId!=='string'||subscriptionId.length<1||subscriptionId.length>128)
    fail('subscription_notification_service_required');
  const sql=`SELECT COALESCE(json_group_array(json(snapshot)),'[]') FROM (SELECT ${jsonRow(COLUMNS.subscriptions)} AS snapshot
    FROM subscriptions WHERE subscription_id=? ORDER BY subscription_id LIMIT 2)`;
  let result;
  try {result=await identity.db.prepare(sql).bind(subscriptionId).first();} catch {fail('subscription_notification_source_unavailable');}
  const snapshot=Object.values(result??{})[0];
  if(typeof snapshot!=='string'||snapshot.length>16384) fail('subscription_notification_source_unavailable');
  let rows;try {rows=JSON.parse(snapshot);}catch {fail('subscription_notification_source_unavailable');}
  if(!Array.isArray(rows)||rows.length!==1||rows[0].subscription_id!==subscriptionId||!positive(rows[0].telegram_id))
    fail('subscription_notification_source_unavailable');
  const subscription=freeze(rows[0]);
  const actor=await resolveCanonicalActor(context,{subscription,capture:freeze({sql,params:[subscriptionId],snapshot})});
  const verifiedFacts=readLifecycleActorFacts(actor);
  return freeze({verifiedFacts,subscription,recipient:subscription.telegram_id,
    account:{...actor.account,financialSourceAvailable:actor.financialSourceAvailable},
    sourceAssertions:compileVerifiedLifecycleAssertionsForActor(actor)});
}

// The fixed settlement executor selects the beneficiary from the genuine
// reward. Neither caller JSON nor a supplied Telegram ID selects the subject.
export async function resolveServiceReferralBeneficiaryFacts({context,rewardId,rewardKind}={}) {
  if(!isTrustedContext(context)) fail('untrusted_context');
  const identity=readTrustedContext(context);
  if(identity.actorKind!=='service'||identity.purpose!=='referral_settlement'||
    identity.operation!=='service.referral.settle'||identity.executorPurpose!=='referral_settle'||
    !['legacy','package'].includes(rewardKind)||typeof rewardId!=='string'||rewardId.length!==36)
    fail('referral_settlement_service_required');
  const table=rewardKind==='legacy'?'referral_rewards':'package_referral_rewards';
  const sql=`SELECT COALESCE(json_group_array(json_object('reward_id',reward_id,'beneficiary_telegram_id',beneficiary_telegram_id,'reward_status',reward_status,'revision',revision)),'[]') FROM ${table} WHERE reward_id=?`;
  const response=await identity.db.prepare(sql).bind(rewardId).first(),snapshot=Object.values(response??{})[0];
  let rows;try{rows=JSON.parse(snapshot);}catch{fail('referral_settlement_source_unavailable');}
  if(!Array.isArray(rows)||rows.length!==1||rows[0].reward_id!==rewardId||!positive(rows[0].beneficiary_telegram_id)) fail('referral_settlement_source_unavailable');
  const actor=await resolveCanonicalActor(context,{telegramId:rows[0].beneficiary_telegram_id,capture:{sql,params:[rewardId],snapshot}});
  const facts=readVerifiedLifecycleFacts(readLifecycleActorFacts(actor));
  return freeze({periods:facts.periods,reviewRequired:facts.reviewRequired,access:actor.access,account:actor.account,
    financialSourceAvailable:actor.financialSourceAvailable,sourceAssertions:compileAuthorityAssertions(actor)});
}

function compileVerifiedLifecycleAssertionsForActor(actor) {
  const token=readLifecycleActorFacts(actor);
  // The lifecycle brand retains the private source token. Its compiler also
  // checks the genuine service context and the fixed subscription selector.
  return compileVerifiedLifecycleAssertions(token);
}
