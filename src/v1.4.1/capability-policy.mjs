// Immutable, offline-generated v1.4.1 foundation policy data.
// Plan allowances are one conjunctive guard, never an authorization decision.
// This module performs no D1 IO, source reconciliation, role grants or rollout.

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
};
const fail = code => { throw new Error(code); };

export function canonicalPolicyJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) fail('foundation_non_json_array');
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) fail('foundation_non_json_array');
    }
    return '[' + value.map(canonicalPolicyJson).join(',') + ']';
  }
  if (value && typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalPolicyJson(value[key])).join(',') + '}';
  }
  fail('foundation_non_json_value');
}

export const POLICY_PLAN_SLOTS = deepFreeze([
  { policy_plan: 'free', plan_code: 'free', access_overlay: 'none' },
  { policy_plan: 'preview', plan_code: 'free', access_overlay: 'dragon_preview' },
  { policy_plan: 'professional', plan_code: 'professional', access_overlay: 'none' },
  { policy_plan: 'dragon', plan_code: 'dragon', access_overlay: 'none' },
]);
const numericQuotas = deepFreeze({
  active_applications: { unit: 'active_application', window: 'concurrent' },
  own_working_offers: { unit: 'working_offer', window: 'concurrent' },
  active_campaigns: { unit: 'active_campaign', window: 'concurrent' },
});
const availabilityValues = new Set(['existing_handler_and_rollout_required',
  'existing_maintenance_handler_required', 'future_disabled', 'planned_v141_controlled_internal_writer']);
const key = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[a-zA-Z0-9_.:-]+$/u.test(value);
const validReference = value => value === null || key(value);

// Structural policy projection only. Runtime actor, role, source and resource
// authority are deliberately absent; the later can() engine owns those checks.
export function projectFoundationDefinitions(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source) ||
      source.schema_version !== 1 || !key(source.policy_version) ||
      !Array.isArray(source.capabilities) || source.capabilities.length !== 104 ||
      !source.quota_definitions || typeof source.quota_definitions !== 'object' || Array.isArray(source.quota_definitions) ||
      canonicalPolicyJson(source.plan_order) !== canonicalPolicyJson(POLICY_PLAN_SLOTS.map(slot => slot.policy_plan))) {
    fail('foundation_source_shape_invalid');
  }
  const seen = new Set();
  const capabilities = [];
  const planCapabilities = [];
  for (const definition of source.capabilities) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition) ||
        !key(definition.capability) || seen.has(definition.capability) ||
        !['customer', 'trusted_service'].includes(definition.actor_kind) ||
        !key(definition.resource_scope) || !availabilityValues.has(definition.availability) ||
        !validReference(definition.quota_key) || !validReference(definition.future_release) ||
        !Array.isArray(definition.roles) || definition.roles.some(role => !['user', 'partner', 'admin'].includes(role)) ||
        !Array.isArray(definition.prerequisites) || definition.prerequisites.some(value => typeof value !== 'string') ||
        definition.all_five_channels_use_same_policy !== true || definition.transport_projection_is_not_authority !== true ||
        !definition.plan_allow || typeof definition.plan_allow !== 'object' || Array.isArray(definition.plan_allow) ||
        Object.keys(definition.plan_allow).length !== 4 ||
        POLICY_PLAN_SLOTS.some(slot => typeof definition.plan_allow[slot.policy_plan] !== 'boolean')) {
      fail('foundation_capability_definition_invalid');
    }
    if (definition.availability === 'future_disabled' && definition.future_release === null) fail('foundation_future_release_missing');
    if (definition.actor_kind === 'trusted_service' && definition.roles.length !== 0) fail('foundation_service_role_invalid');
    if ((definition.actor_kind === 'trusted_service' || definition.availability === 'future_disabled') &&
        POLICY_PLAN_SLOTS.some(slot => definition.plan_allow[slot.policy_plan])) fail('foundation_unreleased_customer_allowance');
    seen.add(definition.capability);
    const quotaDefinition = definition.quota_key === null ? null
      : Object.hasOwn(source.quota_definitions, definition.quota_key) ? source.quota_definitions[definition.quota_key] : null;
    const observeKey = definition.quota_observe_key ?? null;
    if (!validReference(observeKey)) fail('foundation_observe_quota_invalid');
    const quotaObserveDefinition = observeKey === null ? null
      : Object.hasOwn(source.quota_definitions, observeKey) ? source.quota_definitions[observeKey] : null;
    if (definition.quota_key !== null && (!quotaDefinition || typeof quotaDefinition !== 'object' || Array.isArray(quotaDefinition)) ||
        observeKey !== null && (!quotaObserveDefinition || typeof quotaObserveDefinition !== 'object' || Array.isArray(quotaObserveDefinition))) {
      fail('foundation_quota_definition_missing');
    }
    capabilities.push({ policy_version: source.policy_version, capability: definition.capability,
      actor_kind: definition.actor_kind, resource_scope: definition.resource_scope,
      availability: definition.availability, future_release: definition.future_release,
      quota_key: definition.quota_key, definition_json: canonicalPolicyJson(definition) });
    for (const slot of POLICY_PLAN_SLOTS) {
      // Admission limits are numeric only for the three accepted object quotas.
      // AI/runtime throttle/cost rules stay in JSON, including Preview30.
      const numeric = definition.quota_key !== null && Object.hasOwn(numericQuotas, definition.quota_key);
      const limit = numeric ? quotaDefinition?.limits?.[slot.policy_plan] : null;
      if (numeric && (!Number.isSafeInteger(limit) || limit < 0)) fail('foundation_numeric_limit_invalid');
      const allowed = definition.actor_kind === 'customer' && definition.availability !== 'future_disabled' && definition.plan_allow[slot.policy_plan];
      const rule = { schema_version: 1, policy_version: source.policy_version,
        capability: definition.capability, policy_plan: slot.policy_plan,
        plan_code: slot.plan_code, access_overlay: slot.access_overlay, allowed,
        capability_definition: definition, quota_definition: quotaDefinition,
        quota_observe_definition: quotaObserveDefinition };
      planCapabilities.push({ policy_version: source.policy_version, capability: definition.capability,
        plan_code: slot.plan_code, access_overlay: slot.access_overlay, allowed: Number(allowed),
        quota_key: definition.quota_key, limit_value: limit,
        quota_unit: numeric ? numericQuotas[definition.quota_key].unit : null,
        quota_window: numeric ? numericQuotas[definition.quota_key].window : null,
        rule_json: canonicalPolicyJson(rule) });
    }
  }
  return deepFreeze({ policyVersion: source.policy_version, capabilities, planCapabilities });
}

export const FOUNDATION_POLICY_VERSION = "2026-10-02.v1.4.1.policy-proposal.1";
export const FOUNDATION_SOURCE_SHA256 = "678b6db36833d525b1dd953297e87788e9de7cf8b9c6f430ffcf9e9119db6dd1";
export const CAPABILITY_DEFINITIONS = deepFreeze([
  {
    "capability": "account.register",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own",
    "quota_key": null,
    "prerequisites": [
      "verified_Telegram_transport_subject",
      "fixed_preregistration_action",
      "existing_anti_abuse",
      "no_prior_registration_role_or_terms_required",
      "does_not_grant_partner_admin_or_18_plus"
    ],
    "existing_source": "re-program-bot-worker.js",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "verified_subject_before_registration_allowed"
  },
  {
    "capability": "terms.read",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "public_document",
    "quota_key": null,
    "prerequisites": [
      "fixed_public_terms_document",
      "no_private_actor_or_resource_data"
    ],
    "existing_source": "re-program-bot-worker.js",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "public_information_no_registered_role_required"
  },
  {
    "capability": "terms.accept",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own",
    "quota_key": null,
    "prerequisites": [
      "verified_Telegram_transport_subject",
      "fixed_preregistration_action",
      "existing_anti_abuse",
      "no_prior_registration_role_or_terms_required",
      "does_not_grant_partner_admin_or_18_plus"
    ],
    "existing_source": "re-program-bot-worker.js",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "verified_subject_before_registration_allowed"
  },
  {
    "capability": "profile.read_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own",
    "quota_key": null,
    "prerequisites": [
      "actual_account_or_privacy_help_exception",
      "own_scope",
      "source_specific_confirmation_if_required"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "profile.update_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own",
    "quota_key": null,
    "prerequisites": [
      "actual_account_or_privacy_help_exception",
      "own_scope",
      "source_specific_confirmation_if_required"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "access.read_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own",
    "quota_key": null,
    "prerequisites": [
      "actual_account_or_privacy_help_exception",
      "own_scope",
      "source_specific_confirmation_if_required"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "referral.link.read_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own",
    "quota_key": null,
    "prerequisites": [
      "actual_account_or_privacy_help_exception",
      "own_scope",
      "source_specific_confirmation_if_required"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "referral.stats.read_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own",
    "quota_key": null,
    "prerequisites": [
      "actual_account_or_privacy_help_exception",
      "own_scope",
      "source_specific_confirmation_if_required"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "referral.bonus.claim_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own",
    "quota_key": null,
    "prerequisites": [
      "actual_account_or_privacy_help_exception",
      "own_scope",
      "source_specific_confirmation_if_required"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "notification.read_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own",
    "quota_key": null,
    "prerequisites": [
      "actual_account_or_privacy_help_exception",
      "own_scope",
      "source_specific_confirmation_if_required"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "notification.settings.update_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own",
    "quota_key": null,
    "prerequisites": [
      "actual_account_or_privacy_help_exception",
      "own_scope",
      "source_specific_confirmation_if_required"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "partner.apply",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own",
    "quota_key": null,
    "prerequisites": [
      "terms",
      "self_declared_18_plus",
      "valid_application_state",
      "no_role_from_purchase"
    ],
    "existing_source": "src/v1.4.0-rebuild/cabinet-service.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "partner.legal_declare_own",
    "roles": [
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_partner_profile",
    "quota_key": null,
    "prerequisites": [
      "active_partner_role_and_profile",
      "existing_admin_with_partner_profile_rule",
      "self_declared_not_KYC",
      "actual_link_or_setting_state"
    ],
    "existing_source": "src/v1.4.0-rebuild/cabinet-service.mjs; re-program-bot-worker.js",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "partner.public_username.update_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_public_username_preference",
    "quota_key": null,
    "prerequisites": [
      "verified_own_identity",
      "existing_own_preference_state",
      "Telegram_preapplication_toggle_preserved",
      "MiniApp_keeps_its_actual_partner_profile_route_guard",
      "username_exists_if_enabling",
      "no_paid_gate"
    ],
    "existing_source": "src/v1.4.0-rebuild/cabinet-service.mjs; re-program-bot-worker.js",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "partner.link.manage_own",
    "roles": [
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_partner_profile",
    "quota_key": null,
    "prerequisites": [
      "active_partner_role_and_profile",
      "existing_admin_with_partner_profile_rule",
      "self_declared_not_KYC",
      "actual_link_or_setting_state"
    ],
    "existing_source": "src/v1.4.0-rebuild/cabinet-service.mjs; re-program-bot-worker.js",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "offer.read_public",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "public_approved",
    "quota_key": null,
    "prerequisites": [
      "existing_role_for_selected_scope",
      "current_visibility",
      "moderation_version",
      "expiry",
      "validated_canonical_link"
    ],
    "existing_source": "src/v1.4.0-rebuild/cabinet-service.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "offer.read_assigned",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "exact_assignment",
    "quota_key": null,
    "prerequisites": [
      "existing_role_for_selected_scope",
      "current_visibility",
      "moderation_version",
      "expiry",
      "validated_canonical_link"
    ],
    "existing_source": "src/v1.4.0-rebuild/cabinet-service.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "offer.read_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_partner_profile_including_draft_and_archived_history",
    "quota_key": null,
    "prerequisites": [
      "verified_own_identity",
      "actual_owner_scope",
      "existing_private_read_privacy_and_account_policy",
      "own_draft_or_archived_history_needs_no_public_link_or_current_public_moderation"
    ],
    "existing_source": "src/v1.4.0-rebuild/cabinet-service.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "offer.open_action",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "current_visible_approved_route",
    "quota_key": null,
    "prerequisites": [
      "existing_role_for_selected_scope",
      "current_visibility",
      "moderation_version",
      "expiry",
      "validated_canonical_link"
    ],
    "existing_source": "src/v1.4.0-rebuild/cabinet-service.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "offer.create_private",
    "roles": [
      "partner"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_partner_profile",
    "quota_key": "own_working_offers",
    "prerequisites": [
      "active_partner_and_profile",
      "admin_partner_content_edit_forbidden",
      "age_legal",
      "Partner_Beta_separate_guard",
      "ownership",
      "version_CAS",
      "downgrade_action_policy",
      "existing_route_only"
    ],
    "existing_source": "src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/offer-lifecycle.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception",
    "quota_observe_key": "own_working_offers",
    "quota_delta": "1 unless replay",
    "overcap_action_policy": "read_only_unless_replay_ack"
  },
  {
    "capability": "offer.edit_own",
    "roles": [
      "partner"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_partner_profile",
    "quota_key": null,
    "prerequisites": [
      "active_partner_and_profile",
      "admin_partner_content_edit_forbidden",
      "age_legal",
      "Partner_Beta_separate_guard",
      "ownership",
      "version_CAS",
      "downgrade_action_policy",
      "existing_route_only"
    ],
    "existing_source": "src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/offer-lifecycle.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception",
    "quota_observe_key": "own_working_offers",
    "quota_delta": 0,
    "overcap_action_policy": "read_only_unless_replay_ack"
  },
  {
    "capability": "offer.submit_moderation",
    "roles": [
      "partner"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_partner_profile",
    "quota_key": null,
    "prerequisites": [
      "active_partner_and_profile",
      "admin_partner_content_edit_forbidden",
      "age_legal",
      "Partner_Beta_separate_guard",
      "ownership",
      "version_CAS",
      "downgrade_action_policy",
      "existing_route_only"
    ],
    "existing_source": "src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/offer-lifecycle.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception",
    "quota_observe_key": "own_working_offers",
    "quota_delta": 0,
    "overcap_action_policy": "read_only_unless_replay_ack"
  },
  {
    "capability": "offer.pause_own",
    "roles": [
      "partner"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_partner_profile",
    "quota_key": null,
    "prerequisites": [
      "active_partner_and_profile",
      "admin_partner_content_edit_forbidden",
      "age_legal",
      "Partner_Beta_separate_guard",
      "ownership",
      "version_CAS",
      "downgrade_action_policy",
      "existing_route_only"
    ],
    "existing_source": "src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/offer-lifecycle.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception",
    "quota_observe_key": "own_working_offers",
    "quota_delta": 0,
    "overcap_action_policy": "allow_fixed_reduction_with_domain_guards"
  },
  {
    "capability": "offer.archive_own",
    "roles": [
      "partner"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_partner_profile",
    "quota_key": null,
    "prerequisites": [
      "verified_identity",
      "actual_partner_owner",
      "existing_role_and_admin_content_edit_rule",
      "existing_release_emergency_kill",
      "fixed_reducing_action_only",
      "existing_domain_transition_and_version_CAS",
      "no_Beta_commercial_create_or_submit_permission_required",
      "no_tariff_or_overcap_deny"
    ],
    "existing_source": "src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/offer-lifecycle.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception",
    "quota_observe_key": "own_working_offers",
    "quota_delta": "-1 for nonarchived",
    "overcap_action_policy": "allow_fixed_reduction_with_domain_guards"
  },
  {
    "capability": "application.read_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_applicant",
    "quota_key": null,
    "prerequisites": [
      "actual_role_for_scope",
      "offer_eligibility_if_create",
      "immutable_first_attribution",
      "self_application_guard",
      "idempotency"
    ],
    "existing_source": "src/v1.4.0-rebuild/cabinet-service.mjs; re-program-bot-worker.js:13423,13790",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "application.read_attributed",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "exact_partner_attribution",
    "quota_key": null,
    "prerequisites": [
      "actual_role_for_scope",
      "offer_eligibility_if_create",
      "immutable_first_attribution",
      "self_application_guard",
      "idempotency"
    ],
    "existing_source": "src/v1.4.0-rebuild/cabinet-service.mjs; re-program-bot-worker.js:13423,13790",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "application.create",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_applicant_visible_offer",
    "quota_key": "active_applications",
    "prerequisites": [
      "actual_role_for_scope",
      "offer_eligibility_if_create",
      "immutable_first_attribution",
      "self_application_guard",
      "idempotency"
    ],
    "existing_source": "src/v1.4.0-rebuild/cabinet-service.mjs; re-program-bot-worker.js:13423,13790",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception",
    "quota_observe_key": "active_applications",
    "quota_delta": "1 unless existing active identical receipt or replay"
  },
  {
    "capability": "application.resubmit",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_rejected_application",
    "quota_key": "active_applications",
    "prerequisites": [
      "actual_role_for_scope",
      "offer_eligibility_if_create",
      "immutable_first_attribution",
      "self_application_guard",
      "idempotency"
    ],
    "existing_source": "src/v1.4.0-rebuild/cabinet-service.mjs; re-program-bot-worker.js:13423,13790",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception",
    "quota_observe_key": "active_applications",
    "quota_delta": "1 unless existing active identical receipt or replay"
  },
  {
    "capability": "campaign.read_own",
    "roles": [
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_ambassador_profile",
    "quota_key": null,
    "prerequisites": [
      "existing_owner_projection",
      "privacy_and_pilot_gates"
    ],
    "existing_source": "src/v1.3.9/ambassador-attribution.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "campaign.create_draft",
    "roles": [
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_ambassador_profile",
    "quota_key": null,
    "prerequisites": [
      "actual_approved_issuer_route",
      "role_profile_owner",
      "CAS_transition",
      "scope_and_link_eligibility",
      "downgrade_action_policy",
      "existing_technical_guards"
    ],
    "existing_source": "src/v1.3.9/ambassador-attribution.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception",
    "quota_observe_key": "active_campaigns",
    "quota_delta": 0,
    "overcap_action_policy": "no_active_slot_charge_existing_technical_guards"
  },
  {
    "capability": "campaign.edit_draft",
    "roles": [
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_ambassador_profile",
    "quota_key": null,
    "prerequisites": [
      "actual_approved_issuer_route",
      "role_profile_owner",
      "CAS_transition",
      "scope_and_link_eligibility",
      "downgrade_action_policy",
      "existing_technical_guards"
    ],
    "existing_source": "src/v1.3.9/ambassador-attribution.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception",
    "quota_observe_key": "active_campaigns",
    "quota_delta": 0,
    "overcap_action_policy": "read_only_for_overcap_working_object"
  },
  {
    "capability": "campaign.activate",
    "roles": [
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_ambassador_profile",
    "quota_key": "active_campaigns",
    "prerequisites": [
      "actual_approved_issuer_route",
      "role_profile_owner",
      "CAS_transition",
      "scope_and_link_eligibility",
      "downgrade_action_policy",
      "existing_technical_guards"
    ],
    "existing_source": "src/v1.3.9/ambassador-attribution.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception",
    "quota_observe_key": "active_campaigns",
    "quota_delta": 1,
    "overcap_action_policy": "read_only_for_overcap_working_object"
  },
  {
    "capability": "campaign.resume",
    "roles": [
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_ambassador_profile",
    "quota_key": "active_campaigns",
    "prerequisites": [
      "actual_approved_issuer_route",
      "role_profile_owner",
      "CAS_transition",
      "scope_and_link_eligibility",
      "downgrade_action_policy",
      "existing_technical_guards"
    ],
    "existing_source": "src/v1.3.9/ambassador-attribution.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception",
    "quota_observe_key": "active_campaigns",
    "quota_delta": 1,
    "overcap_action_policy": "read_only_for_overcap_working_object"
  },
  {
    "capability": "campaign.pause",
    "roles": [
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_ambassador_profile",
    "quota_key": null,
    "prerequisites": [
      "actual_approved_issuer_route",
      "role_profile_owner",
      "CAS_transition",
      "scope_and_link_eligibility",
      "downgrade_action_policy",
      "existing_technical_guards"
    ],
    "existing_source": "src/v1.3.9/ambassador-attribution.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception",
    "quota_observe_key": "active_campaigns",
    "quota_delta": -1,
    "overcap_action_policy": "allow_fixed_reduction_with_domain_guards"
  },
  {
    "capability": "campaign.archive",
    "roles": [
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_ambassador_profile",
    "quota_key": null,
    "prerequisites": [
      "actual_approved_issuer_route",
      "role_profile_owner",
      "CAS_transition",
      "scope_and_link_eligibility",
      "downgrade_action_policy",
      "existing_technical_guards"
    ],
    "existing_source": "src/v1.3.9/ambassador-attribution.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception",
    "quota_observe_key": "active_campaigns",
    "quota_delta": "-1 if active, otherwise0",
    "overcap_action_policy": "allow_fixed_reduction_with_domain_guards"
  },
  {
    "capability": "campaign.tracking_code.issue",
    "roles": [
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_ambassador_profile",
    "quota_key": null,
    "prerequisites": [
      "actual_approved_issuer_route",
      "role_profile_owner",
      "CAS_transition",
      "scope_and_link_eligibility",
      "downgrade_action_policy",
      "existing_technical_guards"
    ],
    "existing_source": "src/v1.3.9/ambassador-attribution.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "campaign.tracking_code.revoke",
    "roles": [
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_ambassador_profile",
    "quota_key": null,
    "prerequisites": [
      "actual_approved_issuer_route",
      "role_profile_owner",
      "CAS_transition",
      "scope_and_link_eligibility",
      "downgrade_action_policy",
      "existing_technical_guards"
    ],
    "existing_source": "src/v1.3.9/ambassador-attribution.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "analytics.read_personal",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_or_existing_partner_projection",
    "quota_key": null,
    "prerequisites": [
      "existing_projection",
      "privacy_suppression",
      "no_global_scope_from_plan"
    ],
    "existing_source": "src/v1.3.9/owner-analytics.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "analytics.compare_periods",
    "roles": [
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": false,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_partner_projection",
    "quota_key": null,
    "prerequisites": [
      "existing_comparison_handler_only",
      "privacy_suppression",
      "released_rule_and_rollout"
    ],
    "existing_source": "src/v1.3.9/owner-analytics.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "privacy.read_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "authenticated_own",
    "quota_key": null,
    "prerequisites": [
      "own_identity",
      "existing_privacy_account_restriction_exception",
      "confirmation_for_destructive_action",
      "privacy_contract_independent_of_paid_plan"
    ],
    "existing_source": "re-program-bot-worker.js:1510-1570; src/v1.4.0-rebuild/privacy-runtime.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "privacy.export_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "authenticated_own",
    "quota_key": null,
    "prerequisites": [
      "own_identity",
      "existing_privacy_account_restriction_exception",
      "confirmation_for_destructive_action",
      "privacy_contract_independent_of_paid_plan"
    ],
    "existing_source": "re-program-bot-worker.js:1510-1570; src/v1.4.0-rebuild/privacy-runtime.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "privacy.clear_ai_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "authenticated_own",
    "quota_key": null,
    "prerequisites": [
      "own_identity",
      "existing_privacy_account_restriction_exception",
      "confirmation_for_destructive_action",
      "privacy_contract_independent_of_paid_plan"
    ],
    "existing_source": "re-program-bot-worker.js:1510-1570; src/v1.4.0-rebuild/privacy-runtime.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "privacy.request_delete_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "authenticated_own",
    "quota_key": null,
    "prerequisites": [
      "own_identity",
      "existing_privacy_account_restriction_exception",
      "confirmation_for_destructive_action",
      "privacy_contract_independent_of_paid_plan"
    ],
    "existing_source": "re-program-bot-worker.js:1510-1570; src/v1.4.0-rebuild/privacy-runtime.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "billing.read_history_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_payment_or_help",
    "quota_key": null,
    "prerequisites": [
      "verified_own_identity_or_existing_payment_help_exception",
      "own_payment_scope_when_resource_required",
      "no_new_purchase_rollout_or_active_invoice_required",
      "no_paid_gate",
      "refund_request_is_not_admin_refund_execution"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.3.6/stars-commerce-runtime.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "billing.purchase_monthly",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_payment_or_help",
    "quota_key": null,
    "prerequisites": [
      "existing_Stars_pricebook_ledger_rollout_confirmation",
      "no_money_action_from_can",
      "refund_request_distinct_from_admin_execute"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.3.6/stars-commerce-runtime.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "billing.payment_help",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_payment_or_help",
    "quota_key": null,
    "prerequisites": [
      "verified_own_identity_or_existing_payment_help_exception",
      "own_payment_scope_when_resource_required",
      "no_new_purchase_rollout_or_active_invoice_required",
      "no_paid_gate",
      "refund_request_is_not_admin_refund_execution"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.3.6/stars-commerce-runtime.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "billing.request_refund_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_payment_or_help",
    "quota_key": null,
    "prerequisites": [
      "verified_own_identity_or_existing_payment_help_exception",
      "own_payment_scope_when_resource_required",
      "no_new_purchase_rollout_or_active_invoice_required",
      "no_paid_gate",
      "refund_request_is_not_admin_refund_execution"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.3.6/stars-commerce-runtime.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "support.basic",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_ticket_or_public_help",
    "quota_key": null,
    "prerequisites": [
      "existing_official_support_route",
      "independent_of_paid_entitlement"
    ],
    "existing_source": "support-bot/src/worker.mjs; re-program-bot-worker.js",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "ai.settings.update_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own",
    "quota_key": null,
    "prerequisites": [
      "existing_privacy_consent_policy",
      "not_success_quota_gated"
    ],
    "existing_source": "re-program-bot-worker.js",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "ai.consent.manage_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own",
    "quota_key": null,
    "prerequisites": [
      "existing_privacy_consent_policy",
      "not_success_quota_gated"
    ],
    "existing_source": "re-program-bot-worker.js",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "ai.memory.read_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own",
    "quota_key": null,
    "prerequisites": [
      "existing_privacy_consent_policy",
      "not_success_quota_gated"
    ],
    "existing_source": "re-program-bot-worker.js",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "ai.memory.clear_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own",
    "quota_key": null,
    "prerequisites": [
      "existing_privacy_consent_policy",
      "not_success_quota_gated"
    ],
    "existing_source": "re-program-bot-worker.js",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "ai.public_chat",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_chat",
    "quota_key": "public_ai_success_daily",
    "prerequisites": [
      "AI_toggle",
      "current_consent",
      "rollout",
      "current_runtime_setting",
      "Preview30_if_active",
      "existing_provider_budget",
      "effect_time_checks"
    ],
    "existing_source": "re-program-bot-worker.js:11560-11745",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "ai.official_source.read",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "approved_allowlisted_source",
    "quota_key": "official_source_technical_throttle",
    "prerequisites": [
      "existing_force_admin_or_rollout",
      "SSRF_allowlist_content_timeout_guards",
      "not_AI_success_pool"
    ],
    "existing_source": "re-program-bot-worker.js:8774-8842,9096-9145",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "ai.partner_draft",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_existing_AI_session_or_draft",
    "quota_key": "partner_ai_success_daily_and_cycle",
    "prerequisites": [
      "current_closed_owner_admin_contour",
      "master_and_schema_flags",
      "consent_model_policy",
      "confirmation_if_existing_tool_requires",
      "DLP",
      "cost_ceiling",
      "no_roles_or_finance_tools"
    ],
    "existing_source": "src/v1.3.8/ai-partner-owner-worker-runtime-part5.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "ai.partner_draft.read",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_existing_AI_session_or_draft",
    "quota_key": null,
    "prerequisites": [
      "current_closed_owner_admin_contour",
      "master_and_schema_flags",
      "consent_model_policy",
      "confirmation_if_existing_tool_requires",
      "DLP",
      "cost_ceiling",
      "no_roles_or_finance_tools"
    ],
    "existing_source": "src/v1.3.8/ai-partner-owner-worker-runtime-part5.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "ai.partner_draft.edit",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_existing_AI_session_or_draft",
    "quota_key": null,
    "prerequisites": [
      "current_closed_owner_admin_contour",
      "master_and_schema_flags",
      "consent_model_policy",
      "confirmation_if_existing_tool_requires",
      "DLP",
      "cost_ceiling",
      "no_roles_or_finance_tools"
    ],
    "existing_source": "src/v1.3.8/ai-partner-owner-worker-runtime-part5.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "ai.partner_draft.prepare_share",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_existing_AI_session_or_draft",
    "quota_key": null,
    "prerequisites": [
      "current_closed_owner_admin_contour",
      "master_and_schema_flags",
      "consent_model_policy",
      "confirmation_if_existing_tool_requires",
      "DLP",
      "cost_ceiling",
      "no_roles_or_finance_tools"
    ],
    "existing_source": "src/v1.3.8/ai-partner-owner-worker-runtime-part5.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "ai.provider.external.use",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_existing_AI_session_or_draft",
    "quota_key": "partner_provider_budget",
    "prerequisites": [
      "current_closed_owner_admin_contour",
      "master_and_schema_flags",
      "consent_model_policy",
      "confirmation_if_existing_tool_requires",
      "DLP",
      "cost_ceiling",
      "no_roles_or_finance_tools"
    ],
    "existing_source": "src/v1.3.8/ai-partner-owner-worker-runtime-part5.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.cabinet.open",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "exact_configured_canonical_ADMIN_ID",
      "active_admin_role",
      "registered_account",
      "terms_accepted",
      "not_blocked",
      "not_pending_deletion",
      "permanent_admin_access_control",
      "source_epoch_and_revision",
      "short_session_reissue_allowed",
      "no_paid_or_Partner_Beta_or_participant_window_required"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/telegram-cabinet.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.partner.review",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/telegram-cabinet.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.partner.repair",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/telegram-cabinet.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.partner.beta.manage",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/telegram-cabinet.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.partner_link.review",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/telegram-cabinet.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.offer.moderate",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/telegram-cabinet.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.offer.visibility",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/telegram-cabinet.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.offer.assign",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/telegram-cabinet.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.catalog.manage",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/telegram-cabinet.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.application.result",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/telegram-cabinet.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.result.repair",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/telegram-cabinet.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.analytics.read",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/telegram-cabinet.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.user.moderation",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/telegram-cabinet.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.broadcast.send",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/telegram-cabinet.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.settings.manage",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/telegram-cabinet.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.stars.refund",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/telegram-cabinet.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.stars.reconcile",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write"
    ],
    "existing_source": "re-program-bot-worker.js; src/v1.4.0-rebuild/cabinet-service.mjs; src/v1.4.0-rebuild/telegram-cabinet.mjs",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.entitlement.manage",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write",
      "authenticated_issuer",
      "specific_scope",
      "mandatory_reason_and_expiry_for_temporary_issuance",
      "published_policy_boundaries",
      "no_public_arbitrary_SQL_or_capability_input"
    ],
    "existing_source": "new src/v1.4.1 controlled grant/override/flag service; existing verified admin context",
    "availability": "planned_v141_controlled_internal_writer",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "admin.feature_flags.manage",
    "roles": [
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "explicit_verified_admin_target",
    "quota_key": null,
    "prerequisites": [
      "trusted_actual_admin_context",
      "registered_terms_nonblocked_nondeleted_where_required",
      "specific_action_confirmation_and_reason",
      "source_epoch",
      "current_financial_or_domain_authority",
      "no_blanket_partner_content_write",
      "authenticated_issuer",
      "specific_scope",
      "mandatory_reason_and_expiry_for_temporary_issuance",
      "published_policy_boundaries",
      "no_public_arbitrary_SQL_or_capability_input"
    ],
    "existing_source": "new src/v1.4.1 controlled grant/override/flag service; existing verified admin context",
    "availability": "planned_v141_controlled_internal_writer",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "crm.contacts.write",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": false,
      "preview": false,
      "professional": false,
      "dragon": false
    },
    "resource_scope": "future_defined_scope",
    "quota_key": null,
    "prerequisites": [
      "not_enabled_by_catalog_grant_or_flag_alone"
    ],
    "existing_source": "roadmap-v12-page10",
    "availability": "future_disabled",
    "future_release": "1.4.6",
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "crm.export",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": false,
      "preview": false,
      "professional": false,
      "dragon": false
    },
    "resource_scope": "future_defined_scope",
    "quota_key": null,
    "prerequisites": [
      "not_enabled_by_catalog_grant_or_flag_alone"
    ],
    "existing_source": "roadmap-v12-page10",
    "availability": "future_disabled",
    "future_release": "1.4.6",
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "team.invite_member",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": false,
      "preview": false,
      "professional": false,
      "dragon": false
    },
    "resource_scope": "future_defined_scope",
    "quota_key": null,
    "prerequisites": [
      "not_enabled_by_catalog_grant_or_flag_alone"
    ],
    "existing_source": "roadmap-v12-page10",
    "availability": "future_disabled",
    "future_release": "1.4.7",
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "team.change_role",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": false,
      "preview": false,
      "professional": false,
      "dragon": false
    },
    "resource_scope": "future_defined_scope",
    "quota_key": null,
    "prerequisites": [
      "not_enabled_by_catalog_grant_or_flag_alone"
    ],
    "existing_source": "roadmap-v12-page10",
    "availability": "future_disabled",
    "future_release": "1.4.7",
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "ai.agent_preview",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": false,
      "preview": false,
      "professional": false,
      "dragon": false
    },
    "resource_scope": "future_defined_scope",
    "quota_key": null,
    "prerequisites": [
      "not_enabled_by_catalog_grant_or_flag_alone"
    ],
    "existing_source": "roadmap-v12-page10",
    "availability": "future_disabled",
    "future_release": "1.4.8",
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "support.priority",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": false,
      "preview": false,
      "professional": false,
      "dragon": false
    },
    "resource_scope": "future_defined_scope",
    "quota_key": null,
    "prerequisites": [
      "not_enabled_by_catalog_grant_or_flag_alone"
    ],
    "existing_source": "roadmap-v12-page10",
    "availability": "future_disabled",
    "future_release": "1.4.5",
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "support.founder_line",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": false,
      "preview": false,
      "professional": false,
      "dragon": false
    },
    "resource_scope": "future_defined_scope",
    "quota_key": null,
    "prerequisites": [
      "not_enabled_by_catalog_grant_or_flag_alone"
    ],
    "existing_source": "roadmap-v12-page10",
    "availability": "future_disabled",
    "future_release": "1.4.5",
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "preview.activate_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_one_time_preview",
    "quota_key": null,
    "prerequisites": [
      "verified_identity",
      "terms",
      "explicit_user_activation",
      "existing_required_channel_membership",
      "eligible_current_free_access",
      "canonical_trial_unused_and_grant_state",
      "atomic_idempotent_grant_writer",
      "no_tariff_purchase_or_auto_role_grant"
    ],
    "existing_source": "appendix/telegram-canonical-traceability.md; current canonical service/monolith",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "offer.activate_own",
    "roles": [
      "partner"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_existing_partner_offer",
    "quota_key": null,
    "prerequisites": [
      "actual_partner_owner",
      "existing_role_legal_Beta_and_moderation_rules",
      "current_approved_route_if_publishing",
      "version_CAS",
      "downgrade_policy",
      "paused_already_counted_means_quota_delta_zero",
      "no_archived_restore_in_current_domain"
    ],
    "existing_source": "appendix/telegram-canonical-traceability.md; current canonical service/monolith",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception",
    "quota_observe_key": "own_working_offers",
    "quota_delta": 0,
    "overcap_action_policy": "read_only_unless_replay_ack"
  },
  {
    "capability": "catalog.preference.read_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_favorites_recent_and_filters",
    "quota_key": null,
    "prerequisites": [
      "verified_own_identity",
      "existing_fixed_favorite_recent_filter_operation",
      "no_paid_or_success_quota_gate"
    ],
    "existing_source": "appendix/telegram-canonical-traceability.md; current canonical service/monolith",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "catalog.preference.update_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_favorites_recent_and_filters",
    "quota_key": null,
    "prerequisites": [
      "verified_own_identity",
      "existing_fixed_favorite_recent_filter_operation",
      "no_paid_or_success_quota_gate"
    ],
    "existing_source": "appendix/telegram-canonical-traceability.md; current canonical service/monolith",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "notification.manage_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_notification",
    "quota_key": null,
    "prerequisites": [
      "verified_own_identity",
      "fixed_mark_read_archive_restore_operation",
      "notification_belongs_to_recipient",
      "no_paid_gate"
    ],
    "existing_source": "appendix/telegram-canonical-traceability.md; current canonical service/monolith",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "account.menu.read",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_menu",
    "quota_key": null,
    "prerequisites": [
      "fixed_existing_operation",
      "actual_identity_and_pre_registration_exception_if_route_supports_it",
      "no_paid_or_model_success_quota_gate"
    ],
    "existing_source": "appendix/telegram-canonical-traceability.md; current canonical service/monolith",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "help.read",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "public_or_own_safe_help",
    "quota_key": null,
    "prerequisites": [
      "fixed_existing_operation",
      "actual_identity_and_pre_registration_exception_if_route_supports_it",
      "no_paid_or_model_success_quota_gate"
    ],
    "existing_source": "appendix/telegram-canonical-traceability.md; current canonical service/monolith",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "existing_public_or_preregistration_help_exception"
  },
  {
    "capability": "flow.cancel_own",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_current_flow",
    "quota_key": null,
    "prerequisites": [
      "fixed_existing_operation",
      "actual_identity_and_pre_registration_exception_if_route_supports_it",
      "no_paid_or_model_success_quota_gate"
    ],
    "existing_source": "appendix/telegram-canonical-traceability.md; current canonical service/monolith",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "channel.check_membership",
    "roles": [
      "user",
      "partner",
      "admin"
    ],
    "plan_allow": {
      "free": true,
      "preview": true,
      "professional": true,
      "dragon": true
    },
    "resource_scope": "own_membership_check",
    "quota_key": null,
    "prerequisites": [
      "fixed_existing_operation",
      "actual_identity_and_pre_registration_exception_if_route_supports_it",
      "no_paid_or_model_success_quota_gate"
    ],
    "existing_source": "appendix/telegram-canonical-traceability.md; current canonical service/monolith",
    "availability": "existing_handler_and_rollout_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "customer",
    "role_requirement": "active_registered_roles_unless_named_exception"
  },
  {
    "capability": "service.preview.expire",
    "roles": [],
    "plan_allow": {
      "free": false,
      "preview": false,
      "professional": false,
      "dragon": false
    },
    "resource_scope": "canonical_resource_for_exact_trusted_purpose",
    "quota_key": null,
    "prerequisites": [
      "trusted_internal_server_executor_provenance",
      "exact_compiled_purpose_and_source_receipt_or_canonical_due_record",
      "fresh_relevant_privacy_and_source_fences",
      "source_specific_idempotency",
      "no_customer_plan_requirement_for_maintenance",
      "no_new_user_effect_or_role_payment_authority_from_payload"
    ],
    "existing_source": "appendix/ai-jobs-audit.md:background jobs; verified current maintenance writers",
    "availability": "existing_maintenance_handler_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "trusted_service",
    "role_requirement": "not_a_public_system_role",
    "plans_not_applicable": true,
    "trusted_purpose": "preview_expiry"
  },
  {
    "capability": "service.stars.reconcile",
    "roles": [],
    "plan_allow": {
      "free": false,
      "preview": false,
      "professional": false,
      "dragon": false
    },
    "resource_scope": "canonical_resource_for_exact_trusted_purpose",
    "quota_key": null,
    "prerequisites": [
      "trusted_internal_server_executor_provenance",
      "exact_compiled_purpose_and_source_receipt_or_canonical_due_record",
      "fresh_relevant_privacy_and_source_fences",
      "source_specific_idempotency",
      "no_customer_plan_requirement_for_maintenance",
      "no_new_user_effect_or_role_payment_authority_from_payload"
    ],
    "existing_source": "appendix/ai-jobs-audit.md:background jobs; verified current maintenance writers",
    "availability": "existing_maintenance_handler_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "trusted_service",
    "role_requirement": "not_a_public_system_role",
    "plans_not_applicable": true,
    "trusted_purpose": "Stars_reconciliation"
  },
  {
    "capability": "service.stars.expire",
    "roles": [],
    "plan_allow": {
      "free": false,
      "preview": false,
      "professional": false,
      "dragon": false
    },
    "resource_scope": "canonical_resource_for_exact_trusted_purpose",
    "quota_key": null,
    "prerequisites": [
      "trusted_internal_server_executor_provenance",
      "exact_compiled_purpose_and_source_receipt_or_canonical_due_record",
      "fresh_relevant_privacy_and_source_fences",
      "source_specific_idempotency",
      "no_customer_plan_requirement_for_maintenance",
      "no_new_user_effect_or_role_payment_authority_from_payload"
    ],
    "existing_source": "appendix/ai-jobs-audit.md:background jobs; verified current maintenance writers",
    "availability": "existing_maintenance_handler_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "trusted_service",
    "role_requirement": "not_a_public_system_role",
    "plans_not_applicable": true,
    "trusted_purpose": "Stars_expiry"
  },
  {
    "capability": "service.stars.process_event",
    "roles": [],
    "plan_allow": {
      "free": false,
      "preview": false,
      "professional": false,
      "dragon": false
    },
    "resource_scope": "canonical_resource_for_exact_trusted_purpose",
    "quota_key": null,
    "prerequisites": [
      "trusted_internal_server_executor_provenance",
      "exact_compiled_purpose_and_source_receipt_or_canonical_due_record",
      "fresh_relevant_privacy_and_source_fences",
      "source_specific_idempotency",
      "no_customer_plan_requirement_for_maintenance",
      "no_new_user_effect_or_role_payment_authority_from_payload"
    ],
    "existing_source": "appendix/ai-jobs-audit.md:background jobs; verified current maintenance writers",
    "availability": "existing_maintenance_handler_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "trusted_service",
    "role_requirement": "not_a_public_system_role",
    "plans_not_applicable": true,
    "trusted_purpose": "Stars_payment_event"
  },
  {
    "capability": "service.referral.settle",
    "roles": [],
    "plan_allow": {
      "free": false,
      "preview": false,
      "professional": false,
      "dragon": false
    },
    "resource_scope": "canonical_resource_for_exact_trusted_purpose",
    "quota_key": null,
    "prerequisites": [
      "trusted_internal_server_executor_provenance",
      "exact_compiled_purpose_and_source_receipt_or_canonical_due_record",
      "fresh_relevant_privacy_and_source_fences",
      "source_specific_idempotency",
      "no_customer_plan_requirement_for_maintenance",
      "no_new_user_effect_or_role_payment_authority_from_payload"
    ],
    "existing_source": "appendix/ai-jobs-audit.md:background jobs; verified current maintenance writers",
    "availability": "existing_maintenance_handler_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "trusted_service",
    "role_requirement": "not_a_public_system_role",
    "plans_not_applicable": true,
    "trusted_purpose": "referral_settlement"
  },
  {
    "capability": "service.privacy.cleanup",
    "roles": [],
    "plan_allow": {
      "free": false,
      "preview": false,
      "professional": false,
      "dragon": false
    },
    "resource_scope": "canonical_resource_for_exact_trusted_purpose",
    "quota_key": null,
    "prerequisites": [
      "trusted_internal_server_executor_provenance",
      "exact_compiled_purpose_and_source_receipt_or_canonical_due_record",
      "fresh_relevant_privacy_and_source_fences",
      "source_specific_idempotency",
      "no_customer_plan_requirement_for_maintenance",
      "no_new_user_effect_or_role_payment_authority_from_payload"
    ],
    "existing_source": "appendix/ai-jobs-audit.md:background jobs; verified current maintenance writers",
    "availability": "existing_maintenance_handler_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "trusted_service",
    "role_requirement": "not_a_public_system_role",
    "plans_not_applicable": true,
    "trusted_purpose": "privacy_retention"
  },
  {
    "capability": "service.notification.deliver_historical",
    "roles": [],
    "plan_allow": {
      "free": false,
      "preview": false,
      "professional": false,
      "dragon": false
    },
    "resource_scope": "canonical_resource_for_exact_trusted_purpose",
    "quota_key": null,
    "prerequisites": [
      "trusted_internal_server_executor_provenance",
      "exact_compiled_purpose_and_source_receipt_or_canonical_due_record",
      "fresh_relevant_privacy_and_source_fences",
      "source_specific_idempotency",
      "no_customer_plan_requirement_for_maintenance",
      "no_new_user_effect_or_role_payment_authority_from_payload"
    ],
    "existing_source": "appendix/ai-jobs-audit.md:background jobs; verified current maintenance writers",
    "availability": "existing_maintenance_handler_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "trusted_service",
    "role_requirement": "not_a_public_system_role",
    "plans_not_applicable": true,
    "trusted_purpose": "historical_notification"
  },
  {
    "capability": "service.outbox.drain",
    "roles": [],
    "plan_allow": {
      "free": false,
      "preview": false,
      "professional": false,
      "dragon": false
    },
    "resource_scope": "canonical_resource_for_exact_trusted_purpose",
    "quota_key": null,
    "prerequisites": [
      "trusted_internal_server_executor_provenance",
      "exact_compiled_purpose_and_source_receipt_or_canonical_due_record",
      "fresh_relevant_privacy_and_source_fences",
      "source_specific_idempotency",
      "no_customer_plan_requirement_for_maintenance",
      "no_new_user_effect_or_role_payment_authority_from_payload"
    ],
    "existing_source": "appendix/ai-jobs-audit.md:background jobs; verified current maintenance writers",
    "availability": "existing_maintenance_handler_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "trusted_service",
    "role_requirement": "not_a_public_system_role",
    "plans_not_applicable": true,
    "trusted_purpose": "outbox_drain"
  },
  {
    "capability": "service.analytics.ingest",
    "roles": [],
    "plan_allow": {
      "free": false,
      "preview": false,
      "professional": false,
      "dragon": false
    },
    "resource_scope": "canonical_resource_for_exact_trusted_purpose",
    "quota_key": null,
    "prerequisites": [
      "trusted_internal_server_executor_provenance",
      "exact_compiled_purpose_and_source_receipt_or_canonical_due_record",
      "fresh_relevant_privacy_and_source_fences",
      "source_specific_idempotency",
      "no_customer_plan_requirement_for_maintenance",
      "no_new_user_effect_or_role_payment_authority_from_payload"
    ],
    "existing_source": "appendix/ai-jobs-audit.md:background jobs; verified current maintenance writers",
    "availability": "existing_maintenance_handler_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "trusted_service",
    "role_requirement": "not_a_public_system_role",
    "plans_not_applicable": true,
    "trusted_purpose": "analytics_ingestion"
  },
  {
    "capability": "service.ai.settle_cost",
    "roles": [],
    "plan_allow": {
      "free": false,
      "preview": false,
      "professional": false,
      "dragon": false
    },
    "resource_scope": "canonical_resource_for_exact_trusted_purpose",
    "quota_key": null,
    "prerequisites": [
      "trusted_internal_server_executor_provenance",
      "exact_compiled_purpose_and_source_receipt_or_canonical_due_record",
      "fresh_relevant_privacy_and_source_fences",
      "source_specific_idempotency",
      "no_customer_plan_requirement_for_maintenance",
      "no_new_user_effect_or_role_payment_authority_from_payload"
    ],
    "existing_source": "appendix/ai-jobs-audit.md:background jobs; verified current maintenance writers",
    "availability": "existing_maintenance_handler_required",
    "future_release": null,
    "all_five_channels_use_same_policy": true,
    "transport_projection_is_not_authority": true,
    "actor_kind": "trusted_service",
    "role_requirement": "not_a_public_system_role",
    "plans_not_applicable": true,
    "trusted_purpose": "AI_incurred_cost_settlement"
  }
]);
export const QUOTA_DEFINITIONS = deepFreeze({
  "active_applications": {
    "limits": {
      "free": 5,
      "professional": 25,
      "dragon": 50,
      "preview": 50
    },
    "table": "lead_requests",
    "scope": "telegram_id of applicant",
    "counted_statuses": [
      "pending",
      "confirmed"
    ],
    "admission_on": [
      "insert",
      "rejected_to_pending"
    ],
    "mirror_conversions_counted": false
  },
  "own_working_offers": {
    "limits": {
      "free": 1,
      "professional": 5,
      "dragon": 10,
      "preview": 10
    },
    "tables": [
      "offers",
      "offer_owners"
    ],
    "scope": "partner profile owner",
    "counted_statuses": [
      "draft",
      "active",
      "paused"
    ],
    "separate_existing_Beta_cap_preserved": true
  },
  "active_campaigns": {
    "limits": {
      "free": 2,
      "professional": 10,
      "dragon": 20,
      "preview": 20
    },
    "table": "ambassador_campaigns",
    "scope": "current ambassador partner owner",
    "counted_statuses": [
      "active"
    ],
    "admission_on": [
      "draft_to_active",
      "paused_to_active"
    ],
    "time_predicate_added_to_counter": false
  },
  "public_ai_success_daily": {
    "limit": "preserve current ai_runtime_settings; code default30",
    "preview": 30,
    "admin_personal_count_exempt_but_budget_required": true,
    "window": "UTC day fixed at admission",
    "success": "validated provider answer with consumed reservation, before Telegram ack",
    "future_5_25_50_release": "1.4.8; owner confirmation requested",
    "separate_partner_quota_merged": false
  },
  "partner_ai_success_daily_and_cycle": {
    "rule": "preserve existing closed contour settings, code defaults100/day and900/30days",
    "budget": "preserve user and global cost reservations",
    "new_public_tariff_permission": false
  },
  "official_source_technical_throttle": {
    "rule": "preserve current source request checks throttle; not success tariff pool"
  },
  "partner_provider_budget": {
    "rule": "preserve current model-specific monetary ceilings; not raised by plan/grant"
  }
});
export const POLICY_HASH_MANIFEST = deepFreeze({
  "sourceSha256": "678b6db36833d525b1dd953297e87788e9de7cf8b9c6f430ffcf9e9119db6dd1",
  "catalog": [
    {
      "capability": "account.register",
      "definition_sha256": "aac9204f8b97062e40707673bac37534d35d7ba488bcf0c5ff99049398b20fa8"
    },
    {
      "capability": "terms.read",
      "definition_sha256": "b88ba374c4d71ba2995d903b99d3e18ac4139458b6017bac2f6bca7d56164add"
    },
    {
      "capability": "terms.accept",
      "definition_sha256": "6cfc949197a15b6eb8c4b129c06e846576eb507e83ab2115191f0d9c4b68fa92"
    },
    {
      "capability": "profile.read_own",
      "definition_sha256": "002be6e1b00bdf246e18581a3bce1a1860d4b0df2297dbd417fb3d9e13cd63df"
    },
    {
      "capability": "profile.update_own",
      "definition_sha256": "9c53f000f26810e2b0a0851e8fe310e0a13df95a0acb2f982b5437eaf7a9a077"
    },
    {
      "capability": "access.read_own",
      "definition_sha256": "108c22c384adf3098eb78615f961e7fed88b38336972507349fbcd90d46ad821"
    },
    {
      "capability": "referral.link.read_own",
      "definition_sha256": "28acecda56c19028a9ed0113c06f3a5b463ba503391c45568662ba0ddf41035e"
    },
    {
      "capability": "referral.stats.read_own",
      "definition_sha256": "deac84479e905b83840a5d5711d235006518f3958b0f31f251f4188d8c41b6c8"
    },
    {
      "capability": "referral.bonus.claim_own",
      "definition_sha256": "165e6f9ccee92a67cad9497691ced94c128961a99a135bc37d470a1eec618e86"
    },
    {
      "capability": "notification.read_own",
      "definition_sha256": "d362abbde6e3b26ea57f2fd065a4cc8ff19bacd7a82d0cd4cb521cb7dce66619"
    },
    {
      "capability": "notification.settings.update_own",
      "definition_sha256": "e3eb8a8483a5baf92e2ef99c9b76ee87e4fb582cc7cdba7b299a78a50d82a8d0"
    },
    {
      "capability": "partner.apply",
      "definition_sha256": "3e16b840b621ee0284b868ce88e6f180e0a84db6f68e285429ebc55555b53ff7"
    },
    {
      "capability": "partner.legal_declare_own",
      "definition_sha256": "d0f07b0db5f8f94b9213191d3334ee2b27cc0788d0f685fe0333b0745aa18e63"
    },
    {
      "capability": "partner.public_username.update_own",
      "definition_sha256": "43d1bf13d4b0c7088f0490a54ace504d1829a78eaa090fc468d37af2f5c77bc1"
    },
    {
      "capability": "partner.link.manage_own",
      "definition_sha256": "1ce0af06cce2c94da3847270a4990061e61368a3d832806858979eef3a603d3b"
    },
    {
      "capability": "offer.read_public",
      "definition_sha256": "ea63a9ce27de2f68f146d5dcbe4bc496c011499e3e3e8a5e50650273a95dde9c"
    },
    {
      "capability": "offer.read_assigned",
      "definition_sha256": "c5ad66e1f182cc2a3e165a3aedf822800e9188f0d8d0d5a656874a667f00cc6e"
    },
    {
      "capability": "offer.read_own",
      "definition_sha256": "b131d7832aee4bc5e035b2b927904fbec69012778f321cd56c67024af88c8fb8"
    },
    {
      "capability": "offer.open_action",
      "definition_sha256": "b6313b0d56defaf4dfcd0a806950e1424b3ed1fc2294dbf491167e3def54e336"
    },
    {
      "capability": "offer.create_private",
      "definition_sha256": "cd4c48795e895cd7adb389ad5535ad09ad0442b7cd5c0250d6d8bf4f82761092"
    },
    {
      "capability": "offer.edit_own",
      "definition_sha256": "f8b7d0b20d74d8691f709fc49b323b9119c16d9b00a168b738ca23e251752f45"
    },
    {
      "capability": "offer.submit_moderation",
      "definition_sha256": "87e76f1ad5d44c8293f01e1b439b7e303cb54292deddff58cbf5a7c4bbbeb1eb"
    },
    {
      "capability": "offer.pause_own",
      "definition_sha256": "7d89512ef341faec310f1a7acd77c8af10f2d612bc36647fc4beca8220b73dd7"
    },
    {
      "capability": "offer.archive_own",
      "definition_sha256": "c9bed9f6e4aea12918e188d4848514dbc0d7818edd5e6bc49c2a4cb1de3a4755"
    },
    {
      "capability": "application.read_own",
      "definition_sha256": "6900c5ff9c27add09aee7963cefa30ed68e277126fc57fa48aa17070be40fee7"
    },
    {
      "capability": "application.read_attributed",
      "definition_sha256": "2fd354bd9fe039b352a4c77e0e1fd7bdc4d90675156ad25d9ccdbe25bad7ccf0"
    },
    {
      "capability": "application.create",
      "definition_sha256": "bdfecbe5a0ce81d2f69094c0a6094dd75b525db13e56820e7cec2ce869830e04"
    },
    {
      "capability": "application.resubmit",
      "definition_sha256": "4af6b517e638f67a22289837041a5c8aac72f7aba59697691c12ce0124ebfd34"
    },
    {
      "capability": "campaign.read_own",
      "definition_sha256": "e474996f670d733e85abc29ec617d2a7754abb0e473c3626bd62999fa2f8a305"
    },
    {
      "capability": "campaign.create_draft",
      "definition_sha256": "5b32a011e225dcfe282d2754c6fefe8a28affc2dd2a396641f6351ceee770b5b"
    },
    {
      "capability": "campaign.edit_draft",
      "definition_sha256": "9b86b42edc22d2c8faa5a5786d6e7342c5e5214f7c412f9a46c37c22312b5967"
    },
    {
      "capability": "campaign.activate",
      "definition_sha256": "dccc65a251a52b210c9009bdf9dec4ac9586f95c30668e9852a096f2dc5136d3"
    },
    {
      "capability": "campaign.resume",
      "definition_sha256": "4a6d7f11905848f527f38f5538584b134a5b4508db1379fd771cd49f93b20846"
    },
    {
      "capability": "campaign.pause",
      "definition_sha256": "c8c1ad445904658a5168bdb68352fed10217659f30754de5040628c4bd6807eb"
    },
    {
      "capability": "campaign.archive",
      "definition_sha256": "08be828ffea7eff0dddd69c7ba6f11dc6d2ff699bf4bb6974cd7bfc7b3fdcc51"
    },
    {
      "capability": "campaign.tracking_code.issue",
      "definition_sha256": "9377fa4562ed4ee60591f215c8887922db6127e0678ee9765ba05368200ae7bd"
    },
    {
      "capability": "campaign.tracking_code.revoke",
      "definition_sha256": "81cc300308ffcd8982ca858fccfafe24834edd2864dae7cee8a3f20801476be5"
    },
    {
      "capability": "analytics.read_personal",
      "definition_sha256": "c7dfa5bd71806904e1bdd9833de2f8888e551646ee6e3f42a893f9961cb7f0f9"
    },
    {
      "capability": "analytics.compare_periods",
      "definition_sha256": "64cd4f791c60df9d508f2287528d6ca002092a9b6e0fff205dd631516021f116"
    },
    {
      "capability": "privacy.read_own",
      "definition_sha256": "eea8f4eb8c804ff080c36fa2b1e88e22dbf9e894561fc54d768f4e704fc18404"
    },
    {
      "capability": "privacy.export_own",
      "definition_sha256": "6355a253fe43f74f992ac2de627a28be64a14dea00962010272bc1d971b7a9ea"
    },
    {
      "capability": "privacy.clear_ai_own",
      "definition_sha256": "7d2e11c8a69d65a4a2e7e8ce9389bb6ca60acd3570d690e883cb78b1cf2e2a4f"
    },
    {
      "capability": "privacy.request_delete_own",
      "definition_sha256": "75adf2c416e4726ba0223f8c84894c072133bcde69ad946e89b2fcd15ebde93a"
    },
    {
      "capability": "billing.read_history_own",
      "definition_sha256": "bbf2dced88f8849263338cf1fdc151f73eece60f461baf33c95fa0bdd173379d"
    },
    {
      "capability": "billing.purchase_monthly",
      "definition_sha256": "431621d0ad3f59c18c5f5a4a6768145eea439338ad33b31aa28b3fa0dc5e0225"
    },
    {
      "capability": "billing.payment_help",
      "definition_sha256": "b0064c4b34ccfa0d5c927c4f3c3efefee8fced7d3233bb9862d418cd0fff6f63"
    },
    {
      "capability": "billing.request_refund_own",
      "definition_sha256": "bd5eff044bff0b9678384ffdd4bb7055b6c3ab2a975f715102713c6cfd4e023a"
    },
    {
      "capability": "support.basic",
      "definition_sha256": "6ef1aabc5f55f0001296e292ddc98a7f9ff830a9eac60dd702e4d6e60b298a18"
    },
    {
      "capability": "ai.settings.update_own",
      "definition_sha256": "96185e01a33e2afd669d165fd37014f5c0d8c579a37411a9cad0fc1fbb0f5f64"
    },
    {
      "capability": "ai.consent.manage_own",
      "definition_sha256": "266769ab0d41ca52cd2823db0e25137a334d12c0498531672ace4948b0d28cca"
    },
    {
      "capability": "ai.memory.read_own",
      "definition_sha256": "d19a95ce93ead418963643759899235f71d2c501cde40c4d530a351e13727438"
    },
    {
      "capability": "ai.memory.clear_own",
      "definition_sha256": "269e0a0095ec6bf170e6b5971192b98c1060a7ccd785fedc33e86b12bc8df648"
    },
    {
      "capability": "ai.public_chat",
      "definition_sha256": "22b1f58a35c308eda02da362e37f1ad2205170c62d3e1ba05ac966b4a90cd654"
    },
    {
      "capability": "ai.official_source.read",
      "definition_sha256": "b97df4e5cb5fbbc20fba9a697fd3a6035e3d65cf1379e155e3411026d07841bd"
    },
    {
      "capability": "ai.partner_draft",
      "definition_sha256": "e7beed4040af9647cdcf31f361e0e9c1300f8509aa57f7e91eafd2e100429752"
    },
    {
      "capability": "ai.partner_draft.read",
      "definition_sha256": "8293c625ff75391debf0b17505055709f78b8e7fdcd110c5241dad0a515e34b1"
    },
    {
      "capability": "ai.partner_draft.edit",
      "definition_sha256": "6552e2d8d52d6e6325dc9d2d468c8a449e10ad3ed0af42538f16b581a92f6c7d"
    },
    {
      "capability": "ai.partner_draft.prepare_share",
      "definition_sha256": "38908796b4bfbe566b0e1329292b72f678719a9b92616cdf499f76e06ccdffbc"
    },
    {
      "capability": "ai.provider.external.use",
      "definition_sha256": "296b686386d8cf5159ed1f52f63158a1b840fb54fbf7528d26ec5e0aeb1722d8"
    },
    {
      "capability": "admin.cabinet.open",
      "definition_sha256": "90161e742962d4414e49ada4dfa1067ee857de8380a5f6ec0f6633adce8d7d2d"
    },
    {
      "capability": "admin.partner.review",
      "definition_sha256": "1172e9c8d3e2f90a1a3c233bf1928d37baedd02c3e2db0c59f1128a5069f25ca"
    },
    {
      "capability": "admin.partner.repair",
      "definition_sha256": "67f1bc716449771ced1f291c45ec0b17d5463581b48160bd4e030bf7bc45f052"
    },
    {
      "capability": "admin.partner.beta.manage",
      "definition_sha256": "06ef8dc19f92ed2a954ef78dca5fc6ddb5b73270c0100b4e6e76d03065570362"
    },
    {
      "capability": "admin.partner_link.review",
      "definition_sha256": "69084f45a40dcbd47556c9c5dfb40fce8e81968dbf8b0d13b558c580e6a46ca3"
    },
    {
      "capability": "admin.offer.moderate",
      "definition_sha256": "5fbd5b76aea9ebf8426bd4a584723d3631d146d0228d35665a247f5633d5acd6"
    },
    {
      "capability": "admin.offer.visibility",
      "definition_sha256": "e3de56304cf9b8faeea0a421ad8edefccc0a49a427b9ee9922303385fa2f44be"
    },
    {
      "capability": "admin.offer.assign",
      "definition_sha256": "abde79a05ea7bf84d73110e8dcd5ce533b2797cd6396130bd2e68133ea391cb9"
    },
    {
      "capability": "admin.catalog.manage",
      "definition_sha256": "5da108004f8aa9a0d8baf492f61eea10c4487030fe45a3be65f47065abad9c30"
    },
    {
      "capability": "admin.application.result",
      "definition_sha256": "ee6a1950fb7e1bf2a20c325be0ef03793a152304ceb464f43c771c3bbaf0c2dc"
    },
    {
      "capability": "admin.result.repair",
      "definition_sha256": "102b090f1e79579caaf0cdf5194f10921517f7e6e8f2019b51005cfff2f5df63"
    },
    {
      "capability": "admin.analytics.read",
      "definition_sha256": "be8fc300115f94f0f5cbf9f41fbb8aacb348abc1652a6c2600511449d577652b"
    },
    {
      "capability": "admin.user.moderation",
      "definition_sha256": "b26a6639fad52c97f3a1656353af56cdeb2ba6dac7226165089b7e422dd065ea"
    },
    {
      "capability": "admin.broadcast.send",
      "definition_sha256": "89498d507752c53a194c16f32c520f020126862f251d5e7696acf12035932a81"
    },
    {
      "capability": "admin.settings.manage",
      "definition_sha256": "20b0177320a55c4d59e90cd4b30c98818028753a35b0d7837a401ef397d8a116"
    },
    {
      "capability": "admin.stars.refund",
      "definition_sha256": "69ffb4108d98d58d35628a7cd7edc6a2ce6820a028c361569160aa1aa5d2f3fb"
    },
    {
      "capability": "admin.stars.reconcile",
      "definition_sha256": "5f4747022b6877141b18e3b7a07a0b5b6a89d55e9dbe1068bd9ee910fc5f3648"
    },
    {
      "capability": "admin.entitlement.manage",
      "definition_sha256": "4c2b384e3782dd73ab9ca06ae21c24c57e8c22450d6090737d6a69c3386221ea"
    },
    {
      "capability": "admin.feature_flags.manage",
      "definition_sha256": "e1a9523b2ad00488818fc2bdde1b31ce3832b17e4fd1669ece5b0587a48bafb3"
    },
    {
      "capability": "crm.contacts.write",
      "definition_sha256": "54ed04bfbd7a7112a785a5171d0094befb0b1a8ff5b8f96fd92ad1216aa5ba45"
    },
    {
      "capability": "crm.export",
      "definition_sha256": "f6aa578b13bdc371d0a6da55e9d2ab1c6f6167d7adca110bea8c2c7a8dfdc77e"
    },
    {
      "capability": "team.invite_member",
      "definition_sha256": "465ad6e9946a8f2b4dd2f611742259851297c1abf69c409c5d6faa478764eefb"
    },
    {
      "capability": "team.change_role",
      "definition_sha256": "d2d71bedd5ce12430a2ae9afb8f97a7667830b9e5c8787edf77e1e91f87667f4"
    },
    {
      "capability": "ai.agent_preview",
      "definition_sha256": "a9abbea7ca5a3cecad719a8f35d31f764e04a4e76af971b1d7bd721ebc338eb0"
    },
    {
      "capability": "support.priority",
      "definition_sha256": "318edafcb06414b1c9284e875837c123ba150c3abc5ce8963900733c46b7d24a"
    },
    {
      "capability": "support.founder_line",
      "definition_sha256": "69a8284a3c6f51a2a4f01da794a2ad39c82a1385028baa3ecea3ff077ca615e9"
    },
    {
      "capability": "preview.activate_own",
      "definition_sha256": "4a8746b006554fb73a10b5f6f6752bb03a3f2a5d4473f45f83051d7ea5f4e73c"
    },
    {
      "capability": "offer.activate_own",
      "definition_sha256": "f50624af98a04646ac4449b42433f16d577fde04e53142116f215246c2757b2e"
    },
    {
      "capability": "catalog.preference.read_own",
      "definition_sha256": "d3c0b20e7d092d67eddf9f6b9de3c5c8d3d6fa278a98f1e0b5a57db71d37ee7b"
    },
    {
      "capability": "catalog.preference.update_own",
      "definition_sha256": "75a8d69aba643b6758ea89982881b866437d011377c382aecca0cb6f277dd85a"
    },
    {
      "capability": "notification.manage_own",
      "definition_sha256": "db60f4353a3eec99f041587b6aa8a9f3944e5cc5db1e912e1337ab208cc71abf"
    },
    {
      "capability": "account.menu.read",
      "definition_sha256": "781d2ab19d8cc39c8e1975da19eb17544958086d2402349d4e7b76ea4bf02846"
    },
    {
      "capability": "help.read",
      "definition_sha256": "cfc3c4d891c66174e008b60f036094240af10dba4e9f8b542afb94078721a246"
    },
    {
      "capability": "flow.cancel_own",
      "definition_sha256": "5e55d7fee133e88f1ec42e6fe91ddefa4cdfbff01912627267fdbc9b6e187bd4"
    },
    {
      "capability": "channel.check_membership",
      "definition_sha256": "7bd778bb9a40e93364ecfcf1a85d677904540576bbd1ddc48ff14c77de0e4823"
    },
    {
      "capability": "service.preview.expire",
      "definition_sha256": "d6629074e8c94e6820761b97ae82d81eb1fa67337ad72e04788f07e428129fd3"
    },
    {
      "capability": "service.stars.reconcile",
      "definition_sha256": "e556358ff2f50f9a7fc36279d23f9d8e3527f8c56cc6e37a5ec4007a288f17e9"
    },
    {
      "capability": "service.stars.expire",
      "definition_sha256": "cb42edb34e3a083edb7a4c771affbcfeff74df270994e5ba93c9d462f7160f6c"
    },
    {
      "capability": "service.stars.process_event",
      "definition_sha256": "aa0c8458dcaabe8ca9fcbfe3cc7f96a7d8564caf037995eef102e99dfdd0a6c9"
    },
    {
      "capability": "service.referral.settle",
      "definition_sha256": "09438a9002544c04a0a5fb239ec8d82c972ceb1019f01c1bee1292db97ce5a15"
    },
    {
      "capability": "service.privacy.cleanup",
      "definition_sha256": "2933cfb1aee17c4c76608b326b0cf099895b8bff46956c6ea05a1a9369c812fd"
    },
    {
      "capability": "service.notification.deliver_historical",
      "definition_sha256": "554fe3e63cfc7709462defe37991d723252789e8be3eba77e685f6f387e53e28"
    },
    {
      "capability": "service.outbox.drain",
      "definition_sha256": "49ab45203f4c67c46da6871e717280be8ff28b8eb8121638bdad1612a0028098"
    },
    {
      "capability": "service.analytics.ingest",
      "definition_sha256": "09d4d3724d7279483774756c8b44d9defd633a51c1a097b322cdbed557ddcd24"
    },
    {
      "capability": "service.ai.settle_cost",
      "definition_sha256": "6368c595304074a9dc4faf26dbfce8a0126d7c642f9616a4437c39e648abc0e1"
    }
  ],
  "plans": [
    {
      "capability": "account.register",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "beee2593dcb8da35723d05ad4c0ab63f46ae9dbecfed2e38cbb1cc62d2a1503d"
    },
    {
      "capability": "account.register",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "e21c0e42ebeccf120e837814fb5e9d2897e64ff51633c32ef541d284220faa2b"
    },
    {
      "capability": "account.register",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "b9ded38b3b22f9db09687b52e866cd7fc059327f74a49b32c3c4172cf146da99"
    },
    {
      "capability": "account.register",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "6732126092fb584ca1403f065b0103e0e640ea4f5a0c09018836d7faabdbceb4"
    },
    {
      "capability": "terms.read",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "86c1eb1c5d34c2b83d42f6a1c2b5834919d14fc7bd32436cb50ca88da8cfe59c"
    },
    {
      "capability": "terms.read",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "d1ac4d1930a31408b39e6e3d6487d30304ac1e8d45b4b582a58476cbb812885c"
    },
    {
      "capability": "terms.read",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "e0a0ba53aa65f4421131d229732c8575ba5f1034f0a9b3da204485d97a3fb7e8"
    },
    {
      "capability": "terms.read",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "29017a9d60c2a00c83f9ecb97abbcd7f79a23d12eb37f1fdc11b237793cb8161"
    },
    {
      "capability": "terms.accept",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "d960006944d24f7a78b86046d0d4796eacad9d6b3f0a071e5a99d612b6e6619e"
    },
    {
      "capability": "terms.accept",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "e49d7c21cf47b0b7f9cab6d387fb3e6e7df8979e656b74590980783324fbc39c"
    },
    {
      "capability": "terms.accept",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "d63b5c6942cb68284c29920b7177c19bfcb61eadebcf3ffde3b6664044bad1b6"
    },
    {
      "capability": "terms.accept",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "5bd542e0b14d9882f0dd2f6cc61bbf50bc9d63315e8a0bf223b922af6168913c"
    },
    {
      "capability": "profile.read_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "817eba93b6d87743027d8dc74d1edb04985a056fca36da9f193647fb37a8536d"
    },
    {
      "capability": "profile.read_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "9bd305480a40d04b475b4564ee20cdf6fe301327bffec03c626dcfd998dd54e0"
    },
    {
      "capability": "profile.read_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "e5df6e393a21bfa751ea2732a96f5a1146691cce9ff19c2d7517ef92e8f57fed"
    },
    {
      "capability": "profile.read_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "712ad20de7ad014a3df26fedd6a9fe17de7a8be72ed0f264adbac12d42af9081"
    },
    {
      "capability": "profile.update_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "81da2635f399635d2bae1fc815594232916ec469ec430057786b0b2927281a14"
    },
    {
      "capability": "profile.update_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "a7794c77ca350f7aadf2f6b11ef07dcc46135e5c2fae346afd79c2af1976ad56"
    },
    {
      "capability": "profile.update_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "3c003569a45de9fbb0a975ab90e6fca6f61b9f688915ad69ced93d98eb5e4a7e"
    },
    {
      "capability": "profile.update_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "6e94d2917c520bdd0964ad4d5c4a5867ef0c6e84bb025c5b64695eec60c56530"
    },
    {
      "capability": "access.read_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "ac327c0b5e4cc0b88d9ff07d2a663cb14b40eec4493fcb7530b056400537e22d"
    },
    {
      "capability": "access.read_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "964169599105c32066895f168d8e3dec7ed760d29b7d8bc24b1eb7e21005ae49"
    },
    {
      "capability": "access.read_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "faa9fdf14932f04121eb2eb1fa1fed7b5100fe0856555976d6975753a709e76f"
    },
    {
      "capability": "access.read_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "421cc8cecd4f66c91f4acb905d9770fd779de6327f51f573638c3e267b7f2ebc"
    },
    {
      "capability": "referral.link.read_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "d7efd8778396b7a265c905b1fad793216b3a41b26205276625d32ed2e612a3f2"
    },
    {
      "capability": "referral.link.read_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "5855852714e8cb1aab28f8c7fdd73d9a85798184949f4aee5c11f37b3018f5dc"
    },
    {
      "capability": "referral.link.read_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "03a7688b3f27d57e73a30975d382ebdd852eba900d87e1f1b6c5932e31e0b7fb"
    },
    {
      "capability": "referral.link.read_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "b5d10d16d6c2cfdea62e1b3a2ab582bd32ce76af7425bfabbe065253619c21f3"
    },
    {
      "capability": "referral.stats.read_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "e311a1b59fa21d2d7731e0fcbd0ae9e9689bb2a738b4293ce17eb973c84c291a"
    },
    {
      "capability": "referral.stats.read_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "e59197c0667259bd1c2c5a60436846fe47cfdcac8d5902418eda4a50c408e71f"
    },
    {
      "capability": "referral.stats.read_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "2491bebbdc85f158e46cdd07bf7056fc462038720814258fc7e76057cb8f3745"
    },
    {
      "capability": "referral.stats.read_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "8a33cc7f1c6d2e108599023000ad2d7715de56e26dcc756b1f7ecb22eb3e38b8"
    },
    {
      "capability": "referral.bonus.claim_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "4014a9ccecc87f6f2f06d7adeda480edf52929c8bb1f47a4dfdfe20ed04faf43"
    },
    {
      "capability": "referral.bonus.claim_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "50c7cdb79335d4e56b23e6cf0fb3d50f18fcce8b12311c9c99587039078fb917"
    },
    {
      "capability": "referral.bonus.claim_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "3f4aeea4ad45be1087a63cc6693514a4337cf72a2d655101e558269290eae7ee"
    },
    {
      "capability": "referral.bonus.claim_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "18b865e2bf75a360c39627f74a10ae50bbb6ec23952741e5cd84743ebd8b9c9a"
    },
    {
      "capability": "notification.read_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "08066b700c57c4b1a1bb3a65d81ef24367dea0deb48eb545e89f352f17b5cece"
    },
    {
      "capability": "notification.read_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "eb11df2a5daff02b7b2a48ab4ce0ef58f4e38765d3438f88f8943d221bee6184"
    },
    {
      "capability": "notification.read_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "cc9caa02633316ef71035053d136d73e46351e717b4082ab94ef5db2705f5aa2"
    },
    {
      "capability": "notification.read_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "07e8eca4edb5ad687dd9307996010bc0bb86db9de01c04717ba19088b1f814be"
    },
    {
      "capability": "notification.settings.update_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "d30e01bd9073204abf87c05fdae46477295fe46f7be7abc79055ac1019ce48e4"
    },
    {
      "capability": "notification.settings.update_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "ae283ca78a45c411ff05638e42ae3394558784015daa76ee000e6b777a5192be"
    },
    {
      "capability": "notification.settings.update_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "8ad5494d3034fb23a22f18f84c224164e029b1b6bc202dfa45a1a29129396fdc"
    },
    {
      "capability": "notification.settings.update_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "01e49e74aa5950bab2b34f59b96076a1db2a64865824e06a7597afa1f239e58e"
    },
    {
      "capability": "partner.apply",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "2eddf83779d140121da9963d1d2b3f09206271ea95674412679065fe5e3ba8d7"
    },
    {
      "capability": "partner.apply",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "57b2e76ddc09d2c22cd70ed918b63a3c32990a5961b4ccbe657928c3bf574990"
    },
    {
      "capability": "partner.apply",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "1752e8867c309ec67ea2eb7064a32e4aad3f9ec5781387cc06fa385a532488a5"
    },
    {
      "capability": "partner.apply",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "be0c59995fb90e735e37f16eed9a9859e1c865d33d5e98e0523196c5ef0a4895"
    },
    {
      "capability": "partner.legal_declare_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "f1c02176ae011b98e9d3df609580de0ad8aabfb2bb635fc7f74fcb2919a8a097"
    },
    {
      "capability": "partner.legal_declare_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "76481e5ba6b83bb1ceb50e7025eae3ecf5c9f38ef42c3641cacecfea5fab752b"
    },
    {
      "capability": "partner.legal_declare_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "eb6a30635c06a1ed59a79a6fbd66ffd0303f073031d97282be17e8391edba0c4"
    },
    {
      "capability": "partner.legal_declare_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "d2a2da18abaed1a113a4ad965ec7b7d3b3f8c3e9c10600dbd404a4d4a321306e"
    },
    {
      "capability": "partner.public_username.update_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "42860763fa713a306bca229c59e3327a6a2c8af563f2fc5b2c51e04920932740"
    },
    {
      "capability": "partner.public_username.update_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "89c0ae8ed2833cf04eecef83c12400acaa52db89698fdc55662720d59f6f9ed9"
    },
    {
      "capability": "partner.public_username.update_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "3c9476189e4ff4deb98e562a20ada2d0d6a76055613b5fdaf179e3f1d2160bd9"
    },
    {
      "capability": "partner.public_username.update_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "8a25f652c9d175c776fc85e9fc10ca01c13826cecd978dbaa18862f72738fd50"
    },
    {
      "capability": "partner.link.manage_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "d9f08dd41ff174de0404c0c97e023dc167c3bef8566340649f6c373abf120080"
    },
    {
      "capability": "partner.link.manage_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "eb3b41e3fa151a4e8e0381e9cc1d4a941c2db7f3303a78728f131cac643f0980"
    },
    {
      "capability": "partner.link.manage_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "e896d14b0a000b6ed2d84a3778dfc35921a4ffdeb150ff0e2010fa24c8a85f67"
    },
    {
      "capability": "partner.link.manage_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "36f8bb4af65cc4c7ef879fd81572481b97285c62e3c8990d40a259d33c242f8e"
    },
    {
      "capability": "offer.read_public",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "dc98a13efc4461288e7900c614d331a7d62c229f599f035ff569e50e41b23ad2"
    },
    {
      "capability": "offer.read_public",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "94a49b38ac3fb651025ef1aeafe965fee7ceb7d2a474e3b284b2799c5cf14663"
    },
    {
      "capability": "offer.read_public",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "3785670d30fedf237dd02d3f5dfa6359c245c07bea9efe0609b4ad4e1e0a5375"
    },
    {
      "capability": "offer.read_public",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "ca34334acb3db4225135d60b9a71538f49c7be008515b219336c77523f8e1bbc"
    },
    {
      "capability": "offer.read_assigned",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "00e48dc363ed726590c9e271699b92aedf506b0d224583036967a9c1e6206c63"
    },
    {
      "capability": "offer.read_assigned",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "8e88b030f9afa40709a0750ddedd1946048caa0166eb8878ac5e625faf624d14"
    },
    {
      "capability": "offer.read_assigned",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "5589223819e346a238f2f44ed2794356a8bdc37d1a14a721a9b4771e86f996fb"
    },
    {
      "capability": "offer.read_assigned",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "05c0f3c6b18ff5b074b384d47ddba9f1e1d9a75baf7b80ec9ae11f6a927ee7b1"
    },
    {
      "capability": "offer.read_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "e63eb6654d51bb4a77e95d4ccc20e0ac6a0861ca3089246723d8cc951991e8d0"
    },
    {
      "capability": "offer.read_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "3abeaf1b9935c7ae3b6a0bccc0f6be1ac947ee144315b6691ad2f154c8b3b831"
    },
    {
      "capability": "offer.read_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "a2cc90eb73639bff11c0ec646911a483f1d28a0cdf7ec685931b947008f6ca81"
    },
    {
      "capability": "offer.read_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "49609d7ecb0ca5713eb5dff69e947c93cff9758e7083f775ab18f8671da1ad78"
    },
    {
      "capability": "offer.open_action",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "67de5b12e35dc69187118864e10b94df7225c7fa2add020735a959987ccdb0d7"
    },
    {
      "capability": "offer.open_action",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "0b93e30f4e240b755b83958d04a599843d1dd83197128aeaeee9f521a627247c"
    },
    {
      "capability": "offer.open_action",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "8f88956a96b8766fbf3a2cdd1c7973b673a14dce63e5b6fe12e7fc9b353fc2c1"
    },
    {
      "capability": "offer.open_action",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "6fa5467204dcf5c11d0c4e6aefd843bfe85403fa0e7d961342abe5adf2909d9b"
    },
    {
      "capability": "offer.create_private",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "9e491e7282fd9e95d2421af041142b13fa9ee51cdd315dc300fde8909ef7f597"
    },
    {
      "capability": "offer.create_private",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "c0293e7da18fd5cbb34fe3dbfc72a92a23c5354bc57fb9f180f5509ffc66fa5b"
    },
    {
      "capability": "offer.create_private",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "c70dc514c09b0d1fa71174c3423ac25121c7aa5298f13fc4c8e120a86b144dc5"
    },
    {
      "capability": "offer.create_private",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "ee750bcdd30b34207cb29baa53573539c89f945e0b5f6ea09db0636c7634de28"
    },
    {
      "capability": "offer.edit_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "6c87027f5f853b2905a5537ff2ffa2e6b6028f13cc3715d1c7ca11792d5919a9"
    },
    {
      "capability": "offer.edit_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "baebeba1762f0a8428daf3b862657ebb558239c92e6dfe7b50be902c99f41f7c"
    },
    {
      "capability": "offer.edit_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "cc75e66115d17550d047b8a19488679fdd8c981b0ee4c75951e8ecc60bd371a2"
    },
    {
      "capability": "offer.edit_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "33f12203caed09fa16eac165cdc5291aa03c559fa7c7f57cc3c7c6730f9f1249"
    },
    {
      "capability": "offer.submit_moderation",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "f4f6280c3d90ccb871e0804f34ab9dc48c36c4eedce748f8b8790bb7baea05dc"
    },
    {
      "capability": "offer.submit_moderation",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "97b7cb977026b4a2c7d0ba172426695476404dcbfec3e73af0eb4b8a4e9ff157"
    },
    {
      "capability": "offer.submit_moderation",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "41b0fea05e1a498d5fc8999a8b6badec7ffc467f405a12df06e3ad23ff154d18"
    },
    {
      "capability": "offer.submit_moderation",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "9ca6f371bb0191be42d375edc21f7f2e4c5939d2b09b21221501e8d1a29fc3ec"
    },
    {
      "capability": "offer.pause_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "cdc0db7bb06dcf403e5d9b2f9dda12bb3c5ea39ee19fb6cba3f051a303d5fb77"
    },
    {
      "capability": "offer.pause_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "b1c47b9b5c0c40860064cacc494cf990df1179219230a8e50e6cb763d2f95e2a"
    },
    {
      "capability": "offer.pause_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "66cedc56c1a0c78841b7ffb6d037deb2b2b97bbcfd724f849cd6b172e3455f24"
    },
    {
      "capability": "offer.pause_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "60d11d0ee598591c987126f3964746fb43d2d7f338aa28a096e97894875ad763"
    },
    {
      "capability": "offer.archive_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "ac7163cbaf51d031df1abdb4bb1686e35b96d6131006353d4b6fd3423345964e"
    },
    {
      "capability": "offer.archive_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "f83593633fa6e641728082bd7c9561101d57ae98750bc29b1a160480973f1587"
    },
    {
      "capability": "offer.archive_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "a4d0f2e4b625944302af74998cbfdba3c9da21fb607de434f883c58b3fa93a70"
    },
    {
      "capability": "offer.archive_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "de2fb9364a42759d57bd09a3825f486167990d9317d6871645107b02cc6f1360"
    },
    {
      "capability": "application.read_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "8eb0333e915ff20979f40ec50e8a52b4f8cb5627687b2bc0cbeace43e28c9fbe"
    },
    {
      "capability": "application.read_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "605e3acea04c451d8c8d8886df03a80ae40bb3d1531af437a848958cfe0a06cc"
    },
    {
      "capability": "application.read_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "a9db2c90f34550d6b043c4d7b9359caed03ff6495209db4c1f89d21765023807"
    },
    {
      "capability": "application.read_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "fb3478fd2fbf9ba7254df7ced1c677c394e166388167044993344f367165a113"
    },
    {
      "capability": "application.read_attributed",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "a1f68dd4a6857f04e9fb10447e97d8b7ff6ea89b0de7151dd6756aa2a3552b47"
    },
    {
      "capability": "application.read_attributed",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "c39a78012f3b563819014b4fd625f001a3740e844fb49f9adb9aa85ccc6fcaeb"
    },
    {
      "capability": "application.read_attributed",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "131fe5f816e0bcbe4d766de8ffe952f2b97e2f141029314fa03672ed4a827223"
    },
    {
      "capability": "application.read_attributed",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "527970194fddfccebf844e2436756cc257eda562d1661dee853686e438109f29"
    },
    {
      "capability": "application.create",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "a42e3f1164ee4fab0519ec06b3f0c4195be5f9b0c909c33b6d1dd67025f53dfe"
    },
    {
      "capability": "application.create",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "eca97ced679f4d433bb14f759438a27108b2ff1e8991f91267262a43e66e7265"
    },
    {
      "capability": "application.create",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "f6fb5464bede7f60359d44ace62cd750227affc06c1fa5ae543ffa290cff5c51"
    },
    {
      "capability": "application.create",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "eab1e1f5c7ec3c6a2b191a855e139d269ae0203ec709339ab1b3bd510e4af961"
    },
    {
      "capability": "application.resubmit",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "8dd0f1620f17ec3887ab8256c6542baa11fbd5d6b40f16afce5735095f5799c3"
    },
    {
      "capability": "application.resubmit",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "6c18cd0c1d4aa79bf537a5b8aff9d25048f8b98ff323f18287bebcb440344db1"
    },
    {
      "capability": "application.resubmit",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "89d44bcd06a8b811d1ad6f65ae411fc36482bbd35d1afd81686bce33b05583aa"
    },
    {
      "capability": "application.resubmit",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "d53aefdcfacc47a5e6362de452b4f9c3a53ada5c752f9b0998b3c6f71750df25"
    },
    {
      "capability": "campaign.read_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "7657452c076ecb699b8d20e59a89dca2f643977f5ef05f68f636f147f24da221"
    },
    {
      "capability": "campaign.read_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "3833251e016ed209d5af267a64eab19931bde80f4748972d0b97efb676d35053"
    },
    {
      "capability": "campaign.read_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "a4859806bf895372bfbe489defd1fdcc1c37fdb9c6e8612bd93a116177a8287a"
    },
    {
      "capability": "campaign.read_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "7ced98c7f88eb4a8631191f9371503d92172b01cc1084c58f72384e5cde0bcb8"
    },
    {
      "capability": "campaign.create_draft",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "308c6d69935d1898ec25fa467f0ad29e279b93fdc7c2ead452b1be8e070c882d"
    },
    {
      "capability": "campaign.create_draft",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "b51bea596a13e1121d2f9bed52907c58fc93f3ecd228dde0c216db9f71f4d13b"
    },
    {
      "capability": "campaign.create_draft",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "0bdf6d32c7277ce51b8e18eac6aabab602c52e738e927e8194fb18693b3f1658"
    },
    {
      "capability": "campaign.create_draft",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "1176fb72fe00ecf927a7e6ff10979e296d6b1ee9f568f37f89bfedd0d99dc4cc"
    },
    {
      "capability": "campaign.edit_draft",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "eeb92c2723945246d54bcb07ca13619205cdffd40797b97984ced565dae8654d"
    },
    {
      "capability": "campaign.edit_draft",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "648fd2a4f724898437650379c6eef955698569f9c31e564281f9268150bfd839"
    },
    {
      "capability": "campaign.edit_draft",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "963a2bb15ca89e64004916167dc62c3a49ed1f2703847fb67ca5b206f4dac805"
    },
    {
      "capability": "campaign.edit_draft",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "1984d8711fb71b880f705341c898f9eb41ba41271066ed883e2199355e1db823"
    },
    {
      "capability": "campaign.activate",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "4a850ece4ee9eb56b0827706f64ed4aa64bc8d7320188deab474408a2463bff6"
    },
    {
      "capability": "campaign.activate",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "aad3a3441c36b08e2d852661cac9c2d89df4a5b415c4405c611a52013bb7abb9"
    },
    {
      "capability": "campaign.activate",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "f1317eea7cc3d6fc5895dfca1304d6f34150a1fde5f17b60b501c561a734e915"
    },
    {
      "capability": "campaign.activate",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "636f26fdddb36c9eaa472ffee8bfa9cbef029b9871d48c12305be438d9544176"
    },
    {
      "capability": "campaign.resume",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "8243fce8952c8bd9d686213460b07718db28b7c9e8592e46b4d050ed56bd22d6"
    },
    {
      "capability": "campaign.resume",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "9514fbaa5836cccb40721321c0764d72c65f4074b10c4aca4eb38345c2677292"
    },
    {
      "capability": "campaign.resume",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "43e6746c1f1eec32cc231cab44c59388b81622bbf111953ab86fa1fd25c9fe31"
    },
    {
      "capability": "campaign.resume",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "9680aa2d1621ca8da3659628e7a2d967fb6dddc569c674156f76714b15679078"
    },
    {
      "capability": "campaign.pause",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "733f3af063095862423580cf353d09558b8d1690efd545a195314358b5a8132f"
    },
    {
      "capability": "campaign.pause",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "f5f3a4b4adc2ddfec849135246c4f78c6de3ef1a136e36f5783a6ebfe65faad2"
    },
    {
      "capability": "campaign.pause",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "1262bb6a8a242de4630d15a2d7b50b06a707378391fad65b275da669dc4a5469"
    },
    {
      "capability": "campaign.pause",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "5f1f7c6d59687566a33d99bd4469ceb5ee8669b85e0c9a167f2b846571385462"
    },
    {
      "capability": "campaign.archive",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "b42e8da8101d87b47690e43853d133f19fc294d2d5eac5e1ee84279b46ebbd59"
    },
    {
      "capability": "campaign.archive",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "57f68d0eeae362148eaed8445198b1c3903df5d24925692027d9d9a9eea6c0b0"
    },
    {
      "capability": "campaign.archive",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "de68c379e820f6f567a45cf900ed69c970f526f2885aa36ecd7536d68f14c245"
    },
    {
      "capability": "campaign.archive",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "fbaffa133dfcbf70038bfb90c15cf2af0c9748ca9b9378e306d0ae50c012606a"
    },
    {
      "capability": "campaign.tracking_code.issue",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "49717c9eb7d6a8ac6d2c507373799118a9a58d58d7816d87199c6f3f88224ca9"
    },
    {
      "capability": "campaign.tracking_code.issue",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "9b8775945ae68278db459bcccad7c5093bd5ffb006bc926d160c30546b8bc269"
    },
    {
      "capability": "campaign.tracking_code.issue",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "59dac83b37331a91848fa8f9bc0e0a6d74def89433c667918156de90deebad75"
    },
    {
      "capability": "campaign.tracking_code.issue",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "4c0bc776983c2733aba794025464930954f9eb7575b2b314cbe21be6cefd6ab6"
    },
    {
      "capability": "campaign.tracking_code.revoke",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "97e1fad385db5db9ecdc243f0e3c8c02b4a1b26409343ddc6e2bc1adc884fbc1"
    },
    {
      "capability": "campaign.tracking_code.revoke",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "ddc45b619aa5d7f9f6cdc81a6a15c6f18ea4bb5212cba4142656527e7e251dd0"
    },
    {
      "capability": "campaign.tracking_code.revoke",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "4dfbfa54e88570f11f549c3631370d1c1f35e1e9e49996b959179489dd3c2d7f"
    },
    {
      "capability": "campaign.tracking_code.revoke",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "2be687e121315d8c8ade9a38ef5623c1617d15a2a317789582d2517f3ff61d78"
    },
    {
      "capability": "analytics.read_personal",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "3a123d9e4d954c0e77b2e500cfec5a750c7134b547e15f71efdbd2b2efd7dd3c"
    },
    {
      "capability": "analytics.read_personal",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "a2145da16bc61b585ea29dd64ae76a103c2ae3cfa8c409972106210f9af339b2"
    },
    {
      "capability": "analytics.read_personal",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "13e23ea3059174ca09ff548edf0eb3e175861dcd5c7ed235ba42ec744f4e0f19"
    },
    {
      "capability": "analytics.read_personal",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "dec34dacbfe3a3035cea962b41999810a7a775f3c98674d8a035765e74e50ce2"
    },
    {
      "capability": "analytics.compare_periods",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "de1068ba8b831c99f3411f3fb33e879327776ffb8740ba184c0ca44f9b9e21f7"
    },
    {
      "capability": "analytics.compare_periods",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "5674ec5d90b3cb8fa936254ede43d3ab7fb0f94eb32c1751c6c83d98c636edf2"
    },
    {
      "capability": "analytics.compare_periods",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "3c504e0e5dfb679d0feb78dcd2f92ccc93e1f21e629e89f70913590593405c52"
    },
    {
      "capability": "analytics.compare_periods",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "49bf9adb53d5d0131970b1bc03decaf2eddd1454b7915df6a4a1aaa8f62b03c0"
    },
    {
      "capability": "privacy.read_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "703280a891eb3c1a0af20bbb29a78a26dcdea9836b65371a197ad2fb881f917a"
    },
    {
      "capability": "privacy.read_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "ab9832c39034df7236cf1af0c34ab85607e6a050438b7faf8cb1a2da90d1d59f"
    },
    {
      "capability": "privacy.read_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "2ba6a1de4ef89d8f48c116656cfa28bda0c9057a6e119d7d947e08d44181679f"
    },
    {
      "capability": "privacy.read_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "ae81d87572adfabe658e24b64ee5bbabca52bc47b4f6a70ac44c3874fa26aede"
    },
    {
      "capability": "privacy.export_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "ce1a508991ccc127d6e149e5a32c8333d3c846ee6531c8ad4557ca69f1f76ccf"
    },
    {
      "capability": "privacy.export_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "a0a19ab5c04213bc35644f1db63df97aa1fd8c165586d591ab819b27077e6a94"
    },
    {
      "capability": "privacy.export_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "8b7538cbbb9a1041f78f0c9a3c6ac729ea1f62d6bd50cd6a6f5a64a54d3e4b65"
    },
    {
      "capability": "privacy.export_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "3b8b6fb42f38c404bbe6bad7a80854509562c06fc9fdbbbcbb5161429f1d7b22"
    },
    {
      "capability": "privacy.clear_ai_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "591ad57db0f8274511a75a49a8983c1841e82a21914b6baa599dfadc58385530"
    },
    {
      "capability": "privacy.clear_ai_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "c25b346f5067fd7d6fa03d8e73aa3324cd1e81aa27d09a2aa1d1cf70a1233c46"
    },
    {
      "capability": "privacy.clear_ai_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "22599a6eee20f39c580d0b2bcb3bf2beab908d7058e66239a420acd295188f08"
    },
    {
      "capability": "privacy.clear_ai_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "b20e352992cde38aea6b938bd33192f4b7fb1fe39871b150f57c1443660cb50c"
    },
    {
      "capability": "privacy.request_delete_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "6760a5c32224ae190c5602bf671c95738e1f4713e4ad81a28ba943883016440c"
    },
    {
      "capability": "privacy.request_delete_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "89466a4f72ebe46e57aed40798fca767cc8595a4b21d6b5c472cd191866b097e"
    },
    {
      "capability": "privacy.request_delete_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "0246b62bb4bfb95968f2c4c3b66f5cb66fddb424cf744805ad9422e71862b476"
    },
    {
      "capability": "privacy.request_delete_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "00fb508df7424a975cd73a1befb4f5ab30c3f1f9e6098bbb60e35fd18820b6fc"
    },
    {
      "capability": "billing.read_history_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "f9bb05463bd137c458cca04d40fcd5c4011494b8157e51e8a5e184617244ceb6"
    },
    {
      "capability": "billing.read_history_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "82b5418cd713c4f22148cf72a7b3e0cc6562145e34f2a80188feaaada8c4ef08"
    },
    {
      "capability": "billing.read_history_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "65cde9e6019119f7d60dcbff31f55c2f798c6956a681e5abbbb3a074785f8c35"
    },
    {
      "capability": "billing.read_history_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "703a26cfd433f4030bb6aab3805c1e7801f6de18bd5a6c8de0ba5240227c6759"
    },
    {
      "capability": "billing.purchase_monthly",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "648d20e37a92984a260c9b90bcbfbc3b4f4bf6b579411bb6f7bbb9793d6a7afb"
    },
    {
      "capability": "billing.purchase_monthly",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "92c4bd70ce6b6321961e991625d5016c303a1e8f29d37480ff1edeb40f1a6a38"
    },
    {
      "capability": "billing.purchase_monthly",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "cc391e0d8e929a4ebc86b2f3ec9e70eac6e8d581d628aa4a3e2400e9f8b6d88e"
    },
    {
      "capability": "billing.purchase_monthly",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "2c34def2321a1fcdcb705a14bcefa25721248b6a8bf30a87c3aa5d395e5ddf23"
    },
    {
      "capability": "billing.payment_help",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "139d0d2c597de835188fe2bbb61a29f279f57eacb7cf58c1cfaf74b4e6660377"
    },
    {
      "capability": "billing.payment_help",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "11ccddadd7efe013540e4dad62b38d31f4da9cf184dcb0a14821e843ed6ca89a"
    },
    {
      "capability": "billing.payment_help",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "d6585b2b07a7069f9a481490b1c0935d6ccc24d0fafb071e019ee9c30586c231"
    },
    {
      "capability": "billing.payment_help",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "0764e7c0a4c7cfdc4fa7fba06058404b7c43520c23e76328dd220bb13b315c1f"
    },
    {
      "capability": "billing.request_refund_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "b751522564948e45e4e06030e533618c6b61a9184932fc68117304c015305eda"
    },
    {
      "capability": "billing.request_refund_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "80bad7d997186f5367ab484ea8b65403e2ab0f38dafecdac9da377563bbfbd8d"
    },
    {
      "capability": "billing.request_refund_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "4330048f02c9bdcf9f33e8475ba29a519178eba041f507f20ca976fca887e142"
    },
    {
      "capability": "billing.request_refund_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "c19c7d628ab5ff7f2607493cb3a370b59b79d4c293b737eeacc7277076a5fd3a"
    },
    {
      "capability": "support.basic",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "0e8f9265869914cc525d92a354036b17e1d07b124509ec4764b59ff5cd0c54c1"
    },
    {
      "capability": "support.basic",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "955ada9ec1ed2f68dbd7dea5cd1e5b1ef6844e5f15e1c870addb5ce82aeca0bb"
    },
    {
      "capability": "support.basic",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "38c61319ec10e8f796daeb1a63e161f1498da4f52838bfa79d500cd2bc36a63e"
    },
    {
      "capability": "support.basic",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "04b8efd3aa681ae101fa1c378b6c13c26efedd8d87d0a6fc35773bbaf64e592a"
    },
    {
      "capability": "ai.settings.update_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "b3b5a9efadc8ddfc0025c0c944cdbca2da9eef9299723c9760c1993e07e16ca3"
    },
    {
      "capability": "ai.settings.update_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "ec92373b8e2a4940d106fe6fccc695abae39ef06915741709795add199c89965"
    },
    {
      "capability": "ai.settings.update_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "572afc627d5fe163649bec859b258e3e2478678a7c8e184451182a9a63d6753c"
    },
    {
      "capability": "ai.settings.update_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "0ad79daff7c268a83721b6896fbbc08a85df050e1dab71cc3f2694201b75e110"
    },
    {
      "capability": "ai.consent.manage_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "eab182a5c243be9d2b413ae31699214985ca3a8b45c462da9101af8036e1439f"
    },
    {
      "capability": "ai.consent.manage_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "8c3cd89e86a5d7781fecf5a24ddf26720a581322cd3bb1b820746bcc217dcf38"
    },
    {
      "capability": "ai.consent.manage_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "ace2bc6b35e59aebcc4b24e91d899a91af5d521cdaafaebb066c8449cf9f96ee"
    },
    {
      "capability": "ai.consent.manage_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "597b786019f573922a1da9cdd8eba62d02c909fc848adfba94d1140167046e5e"
    },
    {
      "capability": "ai.memory.read_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "5c618fa8d88b1c2fd6982571fa5dd65712a385ad22ffdeed75b516b93d8b3474"
    },
    {
      "capability": "ai.memory.read_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "a5c8bfc9498ea7177f65eb7767b27aedd506fefcf4ec2d072816e8cda44ad10d"
    },
    {
      "capability": "ai.memory.read_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "78a6e2acb7b2761b0aed92d763cc4df85f51dc88552ddb48117e2ebb7ac6765a"
    },
    {
      "capability": "ai.memory.read_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "d024913ac71d5a124f1d24934739a5b5bd9108b31ed5fc4b04e8c807662cfc4d"
    },
    {
      "capability": "ai.memory.clear_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "2637fde09fd9f2ce87d129739d3c83a8a3ad7fc74ac5579229df8541c8bb5857"
    },
    {
      "capability": "ai.memory.clear_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "a748d0b9715e74da655a5f0365d8636c62b198d77487b2f7bf9bea9dda2c109a"
    },
    {
      "capability": "ai.memory.clear_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "501469417b151718692be3b00a59dbb64245c3aae959fa68d70496d3353ea9ed"
    },
    {
      "capability": "ai.memory.clear_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "283c3ec1026369761f68f8d96e0e0ba8ba33d13c6dbd836bf70b4ffddec071c8"
    },
    {
      "capability": "ai.public_chat",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "73f1163784b3fa219058ea143dc0fa3efa068e32d5aa29258cf297370ef96155"
    },
    {
      "capability": "ai.public_chat",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "6e812806e444cd7f377542d0754c820bffdff9ce63cce1bc5bdc0f17f6017047"
    },
    {
      "capability": "ai.public_chat",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "8926ce4da163b8ae1f9179c0bb0d01223e83f2fde4bb78bf117c0d8c9f7fd37f"
    },
    {
      "capability": "ai.public_chat",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "521136714cae7caaf96326cc84b8dd237cafa146ca91a8d6b6f09df6f893873f"
    },
    {
      "capability": "ai.official_source.read",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "86aeb6b493f8589aa9302d1de49a89620a2697557e2ef3e3432f4ce681d8f00c"
    },
    {
      "capability": "ai.official_source.read",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "0a12f228c9da861f6273235fe3a5e6b3fa28a27504eb212b80ef92d37f479ad1"
    },
    {
      "capability": "ai.official_source.read",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "ee86c9183ce5871b34e1e96663f3fd235276755d22c739a6c38253c4be332466"
    },
    {
      "capability": "ai.official_source.read",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "723575442b19037959eb118de3aac006fd0cd555f952035dae3cb250135b2d0e"
    },
    {
      "capability": "ai.partner_draft",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "82ce0f1b09d95cf43569bafb8de8f672a239d636803fb57e357222df2ef82a29"
    },
    {
      "capability": "ai.partner_draft",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "fcda9ba15eacc4c031c2f2a5fcb2085e5ec95738317020a954feac6974c377a2"
    },
    {
      "capability": "ai.partner_draft",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "c80b1060675ffe8e0796b330d48df67f087496b967bb27fd21d0f522a5466a40"
    },
    {
      "capability": "ai.partner_draft",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "1edfa708e30b48c62d2abd6a0da0c04d3b13b79973f73dbd07ade508fc9a2e04"
    },
    {
      "capability": "ai.partner_draft.read",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "da04fa1da6500b7010703251d82774eaaf5372f2dfa4abf7319c5dc68b22bab9"
    },
    {
      "capability": "ai.partner_draft.read",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "b0864cc10aeec3d2ccc8ae0470085a9bee3b823e18ee3b786d6c8cb6c1c10c73"
    },
    {
      "capability": "ai.partner_draft.read",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "58fe3998009fa8399ca8908371515b6197a307543255f9434c9627cb085b4ead"
    },
    {
      "capability": "ai.partner_draft.read",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "86445e56a167541123231591a62c1c87f83f77257f67e8705497e632ef2b47f3"
    },
    {
      "capability": "ai.partner_draft.edit",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "c9fe3476db21f17e584b23e36c4eac92979eef63e17cf2e110fe25480876e084"
    },
    {
      "capability": "ai.partner_draft.edit",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "dcbd0dd2429401ff08dc22d01432c7dc486b36b75c18fd4bdec7c6985a7703dc"
    },
    {
      "capability": "ai.partner_draft.edit",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "d4444e3b3d607db0d9e56ff71d8b529c8c38344eaaefeee12592619eab879975"
    },
    {
      "capability": "ai.partner_draft.edit",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "3482ce654b2a91ddd8955b28ee238b94f36ebf045227d089cd023ecabaa6e3f2"
    },
    {
      "capability": "ai.partner_draft.prepare_share",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "8bd12dbc770fe44dd36a0fbe00d395bcdba6a1cf8b23da4cc04a3b93686427f6"
    },
    {
      "capability": "ai.partner_draft.prepare_share",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "4117c229d58d1333c01bd58dc73cac63ad580905d189b052d461f97f0aeacfaa"
    },
    {
      "capability": "ai.partner_draft.prepare_share",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "f738d50b6f475068373d86d8c8471139aa22f15105ea682a67b297f3f0575627"
    },
    {
      "capability": "ai.partner_draft.prepare_share",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "a6ee66f1ffb697365a41ffabedec39d32a1b6b812c8834c5e0bd63d2722781bb"
    },
    {
      "capability": "ai.provider.external.use",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "f960553e19d1888caa4bc6c37737b59a0295608b4e73f9b20da9614a05d0b435"
    },
    {
      "capability": "ai.provider.external.use",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "cd60375db003aa25d223db32e339f966e4bf81f19bda37e3ef33b3e6c036e99d"
    },
    {
      "capability": "ai.provider.external.use",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "8922bea188b3262037aed69bbeae5ac60f858ec7b926b1a0342ca8d80dbb0e14"
    },
    {
      "capability": "ai.provider.external.use",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "f6bd4e702eb954caf04366b61b758528438a34ca76faa2b743fe08013acd085f"
    },
    {
      "capability": "admin.cabinet.open",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "321095b1efe967170070535ab1d70bff3165d57e50b1f51ed05a09570e5a3af0"
    },
    {
      "capability": "admin.cabinet.open",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "670193f09dcc53ac4f6f96b6fd0eb48150cefae4592f75938a09b9848f7afca3"
    },
    {
      "capability": "admin.cabinet.open",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "2a46485aeaeb1ca5fe6a574b5f4a1b162908392435515e51205fbb3970ad14c3"
    },
    {
      "capability": "admin.cabinet.open",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "ad270c8cb1a1b68f70ce0cb9f7c1882e5526b23145509d7c9e41ba1082267aab"
    },
    {
      "capability": "admin.partner.review",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "102442caca0f77f5cc0b660dc0c1b05c4cd4cd60eb68f3f860b9c185973a9d8c"
    },
    {
      "capability": "admin.partner.review",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "0e28549a1f54ea2e66f5159fc28ecaf1f0bb09c5eee76cc621f696b273cfff2e"
    },
    {
      "capability": "admin.partner.review",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "b53856852295f727a4ae7c48977dfd52a5206cd5b192d0f8abd45a40831fa62e"
    },
    {
      "capability": "admin.partner.review",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "04c36fb555f995cbb0a63fcdcb09d0a4bf8415eb052991e210244dc453ea17e7"
    },
    {
      "capability": "admin.partner.repair",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "0aee43850941d67a30000b276fd0154286bfdb4b5d84308660540ded8b82edda"
    },
    {
      "capability": "admin.partner.repair",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "60e569f3c6618c28796276c66f7d5c729c2a5a1d2c11d9c2581d21a8a3ba527c"
    },
    {
      "capability": "admin.partner.repair",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "9e19c93069e7131d51bc15a54743dc1ca9289f69250402e9c1cc67a520e9e29f"
    },
    {
      "capability": "admin.partner.repair",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "783d0e5ede1e4de4281c814e0d82a841261a047fccddefdc4b73ac8b72b0cbc2"
    },
    {
      "capability": "admin.partner.beta.manage",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "086cdf68046aced3ee533bcb91eaecdf1414b8aac3bd30364f1fb2185ad7537c"
    },
    {
      "capability": "admin.partner.beta.manage",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "e26e4e76bfe5484421a7706abf8511378ebc49fe3852ee6b248af5acde7a13b0"
    },
    {
      "capability": "admin.partner.beta.manage",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "83def99245b1eafe56da47cab6efa718e208e4a8c891b118620d998f08b9d9c4"
    },
    {
      "capability": "admin.partner.beta.manage",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "904c07345c4a3d54ddc77426fb972c102526cccc20cdb1cc0bab6f0cbd33dcf3"
    },
    {
      "capability": "admin.partner_link.review",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "c8f21867496ef42ff4b88755e91fbe31922ed198f912afee0df6f8ccb220eb7e"
    },
    {
      "capability": "admin.partner_link.review",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "a1c909670d8b612cfd1b3b3f81b53004b554a29c279b465ee7df3a0010f7170e"
    },
    {
      "capability": "admin.partner_link.review",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "0fa5649a7b5327aa77f2bdb8a6022636107e6809cd1996ad3c04c6db898c96f2"
    },
    {
      "capability": "admin.partner_link.review",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "162a5511152115429fe901633856723efd3c92356a600978960f93e8901bedc1"
    },
    {
      "capability": "admin.offer.moderate",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "33b3fdda289597810a6cdf6aa36a7c6bead34dc89e89a6da0716ef34312e357b"
    },
    {
      "capability": "admin.offer.moderate",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "7d6822af2be4919d3826001a27c1e92ffda0058ce57ae5dafd4e0304c0343441"
    },
    {
      "capability": "admin.offer.moderate",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "2dc892259abcde9e10343389742c98e4e0b5db54b20ad787660428fa3ca9d9df"
    },
    {
      "capability": "admin.offer.moderate",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "3a018a7de3a5157693241caeb409c73e7e290aeb8cc92f7245f154db73d15fe4"
    },
    {
      "capability": "admin.offer.visibility",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "8acfed8ed92c3b83699af3da4738c2c5ef38a6f9788cbf8e4fcfda60446f3d91"
    },
    {
      "capability": "admin.offer.visibility",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "9a4628673cd275c95cc3e7fe37a73b0e2e77958f6b06b63cadaf8f9805825f4b"
    },
    {
      "capability": "admin.offer.visibility",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "51a1cf67ea3d052bc0f1a8ad2323282fd55e6f302259541966bcad7662475cd5"
    },
    {
      "capability": "admin.offer.visibility",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "2198123217488f4ef9a38682326d607b0d1a6432ad350e37482607a0b1e7406f"
    },
    {
      "capability": "admin.offer.assign",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "7999b548ff5732d3770d44a95228365935324321e35c19fafb40cb4753060ae7"
    },
    {
      "capability": "admin.offer.assign",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "a6453a2cbe7cce3c9bb0843bcb685fe3c975f6b95b72a594cf9f39b56e7b73bb"
    },
    {
      "capability": "admin.offer.assign",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "f7b343a18f20f3f929d29e84e181c41bf759bba22c4b62b3b1bf1350b874524c"
    },
    {
      "capability": "admin.offer.assign",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "ddff313e9f1bdfe442d6c1421b12ad4c5a7324bbedef8ea0a3f00e2257975b50"
    },
    {
      "capability": "admin.catalog.manage",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "2868e6fdd5055d8a76c9c8303a3db9d649ee59378207a05e5d800bec66aca227"
    },
    {
      "capability": "admin.catalog.manage",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "58e0cac186dbf31c49a617d304a2551960e4396bb4de8fea777405af5d970d2a"
    },
    {
      "capability": "admin.catalog.manage",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "543bf51b2263f22e6191d20a7e563117dc5cf6ed76e66af1cdb3375e96d078be"
    },
    {
      "capability": "admin.catalog.manage",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "ea8e3bc24d5324a26fb60ed5096076bc3ea27f4519b54bd5caad9ebcb0a35644"
    },
    {
      "capability": "admin.application.result",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "185b2798254f2579326ebd4687dfce317f5ebdd2cf57a300ff2f693523f2fd68"
    },
    {
      "capability": "admin.application.result",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "a3e6d9b74f0ae6970e233b3f0d46f40a23220919fc835cb1b819be7ed9744d4d"
    },
    {
      "capability": "admin.application.result",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "723f535a5b67328413007ba6d4bec8f897d8bca70401e31855d40d32b929518d"
    },
    {
      "capability": "admin.application.result",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "de5ae077dfab4cf1ac6f810541f9b905fbb65f72f5a3900c5b10efc9d978c289"
    },
    {
      "capability": "admin.result.repair",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "05b73fa2e5dfcab8839cbd17c44b97cd94eb9caaa7329e582ab93c96617c12c8"
    },
    {
      "capability": "admin.result.repair",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "dbc3a3f3ee3bc4be1c6e07d0e88a893dbf1f2eaeb3e50e7750d75dbcfa63e4b4"
    },
    {
      "capability": "admin.result.repair",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "aefd6c57adb38c0d0877c33cc5b3200c5bc993b1b9830d1f277c9dca0288f860"
    },
    {
      "capability": "admin.result.repair",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "8ce7e3b8d96c304a9701dbf6fbeeb57d02b06e02332b67b31bb69c624e06adff"
    },
    {
      "capability": "admin.analytics.read",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "66d7cea343fd99a6a87ad72690b5be535c1b1da3addb0b55e155b909529792ab"
    },
    {
      "capability": "admin.analytics.read",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "7eec718dcda4d6025d54588c2239950e1adf8b63a3ec5a88d2d3c9c4e1935ff9"
    },
    {
      "capability": "admin.analytics.read",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "50d578b28593b806700566f48b1a1f298fe40cc738d7b4ed0fc8e1ba44d9c0f8"
    },
    {
      "capability": "admin.analytics.read",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "475bdbb6c571718983b79833d18aea748177f0088e1193c6ef62ebbebfeedfbd"
    },
    {
      "capability": "admin.user.moderation",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "66084c6d596ab5598679651a2f6d9c76135472b984e009e3c239a7aa322b26ab"
    },
    {
      "capability": "admin.user.moderation",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "bd4b68fc4deddb497c67c272c9e063cd3290df218dea45d2cde4f6c21ed1491b"
    },
    {
      "capability": "admin.user.moderation",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "ed91dc539e1cede92e3ce61273b7a2e60b75194b75bb3756dfc5e48fa38f1ad9"
    },
    {
      "capability": "admin.user.moderation",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "8eb8af08e570afe7583878810fa1b35dac35a09811aa7f1cf25e04f1898356f4"
    },
    {
      "capability": "admin.broadcast.send",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "275873cc0eb9d0795e21f6ec62d7cfe30db70908a587165b7eb39f7112817083"
    },
    {
      "capability": "admin.broadcast.send",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "f8cc645e4e1af045a0e976112951f4e26545489cbfd807ec1d78131a14032493"
    },
    {
      "capability": "admin.broadcast.send",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "ab7788830a7df582f72a584a7d07b1640d7d903c250b35cd8489d1efd03bb39f"
    },
    {
      "capability": "admin.broadcast.send",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "0f41c38a73c24c73f88ec7d9be8d1d3afb368270e4d2904133dc6f7414aa357f"
    },
    {
      "capability": "admin.settings.manage",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "115941c4d7000bc9028ccc4e6fd8c79b84b25c4a69e20d1c127a010f8f72126b"
    },
    {
      "capability": "admin.settings.manage",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "25a17129621e3f00161f4d1e5d46bec1adb9fcfc8949455bed2dee6f7035897e"
    },
    {
      "capability": "admin.settings.manage",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "68c295ea9cb3d8d3df94ee292a217fab3eba4fca1e5a9bdff3757f97a2c272bb"
    },
    {
      "capability": "admin.settings.manage",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "208e3736fb6d603507263590d998526e4dbdfcead252c106c8f7879f56f07c15"
    },
    {
      "capability": "admin.stars.refund",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "34a0e9f55d9fba1e5ccc0548a451cd69a4dac869c519b813f5b6e3e6046f2ac4"
    },
    {
      "capability": "admin.stars.refund",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "a760892cc22e4030558e8af24e286c8868066a0a6d9f7219c01d022729546901"
    },
    {
      "capability": "admin.stars.refund",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "f15c823a49bd07cfea64abd261e1441adad9e142fbadcb5ead6c6cfe0e1cb997"
    },
    {
      "capability": "admin.stars.refund",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "b48164c8e16cdc68db5f9d6c4386c7eb43fc2e87def7e0ee59bfb1a8ecc35211"
    },
    {
      "capability": "admin.stars.reconcile",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "b0dc44f5e5acd7270b06b939b1d7006a0238470a5734c214e7f092fbcd91fcbe"
    },
    {
      "capability": "admin.stars.reconcile",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "106399945357c39837cd4034de70c651348ca6340d10913e672164085baadf12"
    },
    {
      "capability": "admin.stars.reconcile",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "b71c981af806cf6f42156b76f39909296b79a72002e65f94345befef791da476"
    },
    {
      "capability": "admin.stars.reconcile",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "193ce564d7401c325f03063858fd954df8c7937654ddb876a46028fd8117a8b7"
    },
    {
      "capability": "admin.entitlement.manage",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "f67c8e40c315606f36ad1efe406269ef9a6f7b493579e79b379484892f8cfb51"
    },
    {
      "capability": "admin.entitlement.manage",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "e321c5f13326a0d3f74d30b86386c2b1c0812628e5ee177ae960957acae7443d"
    },
    {
      "capability": "admin.entitlement.manage",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "6e61e5b3166e223b8b7171d8c457062394cb4273211b169f159c9a23fc4119ae"
    },
    {
      "capability": "admin.entitlement.manage",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "8bc56e55b14342b7db08aa41b444fdaa2bc19e8b2e37e1c20365f8021221c959"
    },
    {
      "capability": "admin.feature_flags.manage",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "69daaf9918174991e9e9c22a3cd87bc9f260c9dc9582e120fefe716039b97f89"
    },
    {
      "capability": "admin.feature_flags.manage",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "3ef192598af9878c68af32b95d34279e5045bb3b190cd845393b661ba935706e"
    },
    {
      "capability": "admin.feature_flags.manage",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "d85cb448a89fb76f310618d8cbc0a3b2f7217fe978434c8fa4ffa7e42d44109d"
    },
    {
      "capability": "admin.feature_flags.manage",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "dac2eea5f273a340144b9bcd433b613cb1730800f3fb7d7240255de327c1c7f3"
    },
    {
      "capability": "crm.contacts.write",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "431c6bf71a33819273b457b122e4a840e936ee6d8619841b0116449b1191c4b5"
    },
    {
      "capability": "crm.contacts.write",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "390a614aa9d25d23d2efa9d7d59112498ca23fdc65f2057202f54e6c4b5a35eb"
    },
    {
      "capability": "crm.contacts.write",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "a63f47a38430eeeb981257c1cc449f044989bb8b5a014176bd567037f898db89"
    },
    {
      "capability": "crm.contacts.write",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "4382b08f9b9d0f4f080c67416201d41397fe9d8ab7077745b6ce048c6873b2d5"
    },
    {
      "capability": "crm.export",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "5ef4af4930dd53dd648d0d0d55406a0dfd459d00f86e94ff27edaab103969054"
    },
    {
      "capability": "crm.export",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "c14b4917aae32ce6333400e2afec0ae127ae3d0481f56165c597dd404024c76f"
    },
    {
      "capability": "crm.export",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "519aa438b7184adc75711dd56791df53d8c75cd6a4f4bde97aec2e0dc95a49e3"
    },
    {
      "capability": "crm.export",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "ff7565bb6cfae77713d20c8e5f704038ba446099dbfbe15577b3b29fece0c9a7"
    },
    {
      "capability": "team.invite_member",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "333dbc2ad48e635cbfe9a272ec7c18e8a710c5c6b6f336a8341f22ba41dfd01e"
    },
    {
      "capability": "team.invite_member",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "6fe9a83f4076eff4729a4dec9835d9b9f9c2bab3fd0e9cf5700a19662542ea4c"
    },
    {
      "capability": "team.invite_member",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "33ab25b60ccf61c24a52ea3c5ab4f24f02a9cc836be8de4c1033e422789a6519"
    },
    {
      "capability": "team.invite_member",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "32acfc1327fbb1cef306845dd983a9235194668ef2c1f5ec374547fb7ff8cb56"
    },
    {
      "capability": "team.change_role",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "95ef30484bf719ce11fb30596f279ad691da1e2c2c0664c856f3f3526f965083"
    },
    {
      "capability": "team.change_role",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "f94a3e2702378551a178be7e4491952219e66cb8d6281aca1b3e228549a90978"
    },
    {
      "capability": "team.change_role",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "721e030d15e71225ccf2a8984dcc9d07790f1f2e9996005ea0290bba961fefab"
    },
    {
      "capability": "team.change_role",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "e48260694f4a3f968066f6faa87e3114c652d885daea8e18929efbf72749ab07"
    },
    {
      "capability": "ai.agent_preview",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "49f751dd8cf85be5265c037c15dc6efbdf25c87ba7d2ed2a7b7a38f1d4310a95"
    },
    {
      "capability": "ai.agent_preview",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "558d1714b4601e516fc00233d22cb901e9ca55025ec646d82a673f257f2dfbcc"
    },
    {
      "capability": "ai.agent_preview",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "424996be3be23634356f76a31f33e6cc5c7b65cb166f341728507bc736544e44"
    },
    {
      "capability": "ai.agent_preview",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "7eb7af4a4a694cb38e9a4b4298af26bd6aa1810c55b99e2fba91b1ef25165a54"
    },
    {
      "capability": "support.priority",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "924d91eecd4b8cff1508ee38d647c25b33c4e3821e2231d78001da20eeec5e57"
    },
    {
      "capability": "support.priority",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "ec43e34a0191dd7006de4ebbba88337c22bf85066086be19cc6b4d32fe17d1d6"
    },
    {
      "capability": "support.priority",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "ca28d3fb449a7d4cca5622da26ba0feacfef58e85b19559f60019b488da03a56"
    },
    {
      "capability": "support.priority",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "def8f65ee8ef072e3310109642646fd2843b3788ace95b495f787400e4a60e5e"
    },
    {
      "capability": "support.founder_line",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "768c99283b36372cbaac4f5b178820304f73805ae3c2bf1ce48c81f0651ced98"
    },
    {
      "capability": "support.founder_line",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "5b1999424cd6a10d524e63b9e8b9fcbebbdccf0e7f3a38557e237a4c5d99d2d1"
    },
    {
      "capability": "support.founder_line",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "c76be822e0766533570dc918ffb8ce40c208c3d43073ffbcf38e8bb01a7567a8"
    },
    {
      "capability": "support.founder_line",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "c7d04c5ac730a2cb1265abc99a727c3feeab7d06075cfc54a125cdd4aefa71d0"
    },
    {
      "capability": "preview.activate_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "c377b2e0b403f13e4f08dc8aee1fd2dd07742afa59c27c756992dfcca9e60d90"
    },
    {
      "capability": "preview.activate_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "9f1845dafa710e7ecb8423776b7dffe1dd3781d800f939178edc83549873f9cb"
    },
    {
      "capability": "preview.activate_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "a682a16293cd00876bbaa7233d11f8f63f8b787769ef53dc8f61c7875553ceea"
    },
    {
      "capability": "preview.activate_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "cc4c329f46caecfb8ebd6174a9eefcf4d4b75e4256cde1aeadb99f080e5714df"
    },
    {
      "capability": "offer.activate_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "dd9fca194c68267b4320f853835b487aa43836b04495b2837fbb5c95191ae647"
    },
    {
      "capability": "offer.activate_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "c8147f3e5e5b5fd334a15f21c1e398a72c575bcb9575cda039c724847c83da19"
    },
    {
      "capability": "offer.activate_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "89e7ac88149d35145e0592f84b19b17b69c468313401d1d9d628b78d42a685fc"
    },
    {
      "capability": "offer.activate_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "d34a4bdfdd831ac276394b446e4db2470fc3c1150d6d49be88cc31c1a9cbb135"
    },
    {
      "capability": "catalog.preference.read_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "ffad798f5aa92a2f81e6c42e4b5b9a151aeb82a2eaad912ae13e534f18c7a0d4"
    },
    {
      "capability": "catalog.preference.read_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "ccee4d05a5babe1b3706014f1c5432d9ff00e273a7e005353eacaac67dc6cdfc"
    },
    {
      "capability": "catalog.preference.read_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "7690250d9c03dcb3ac0cb72481fa0ab01609b02040f5a01bd81e9095d6f0c19f"
    },
    {
      "capability": "catalog.preference.read_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "4491bfeb0ef2ca230f3baf54eb3c0b7e0951dc276f72ec454ecc4b87ded9459c"
    },
    {
      "capability": "catalog.preference.update_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "c960a6c3eb36d8db9ebb9bda37f46d0e9139fb5410dcacf8d3f1b967f90347fc"
    },
    {
      "capability": "catalog.preference.update_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "be524f475ce5d6495f338ac78480923382920725744b2c5b8df40c7cab2d3c13"
    },
    {
      "capability": "catalog.preference.update_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "172d11444c0e0f1dd8ae87dc1c5fb6ad410ac835fa12f575b3a5680b7e298b04"
    },
    {
      "capability": "catalog.preference.update_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "7fb6e055fa9a0c4c3a63efe2fd820c3b982b87696943fc5d6ee6730f2c52ab58"
    },
    {
      "capability": "notification.manage_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "3866935e4cc4375f3d1d82db1700477a2cc6e10328c3de826d8d9f8a08e7baab"
    },
    {
      "capability": "notification.manage_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "cc8789f3f6cd31516e36e1f643a033ae04deb2437b78816f598171c01aa83a2c"
    },
    {
      "capability": "notification.manage_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "e8e13405ab53a27adbb3941ea2b84e4dcbfa0f5afc5fc5a6ced7369a620f2c4b"
    },
    {
      "capability": "notification.manage_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "d0dec67555fbd07a155c7e5f110b3224ad732de4586377330fe8cc4056b2a0a0"
    },
    {
      "capability": "account.menu.read",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "c2c814558cb40accc79846277f9136587d038d3ffd64006fa9f3c2a179f86f33"
    },
    {
      "capability": "account.menu.read",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "d29dcf1120f7c955fdd48d77bd1ca90b70409a3edba23ad04e47b623e9287369"
    },
    {
      "capability": "account.menu.read",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "d2ce278a1f3791a8557552c1fa7b40ab0e31db441423dee68b2622df05b661e5"
    },
    {
      "capability": "account.menu.read",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "b63107bcd99b6ed1e7f1379f58cacc7f8b8601034677182a0fc47a31326d711e"
    },
    {
      "capability": "help.read",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "8c75ec1088ab9469fb6bafb5a46a5c0d523faa8bf1bc736f4ab3492a303fa66c"
    },
    {
      "capability": "help.read",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "85bc7dc933f699ebeb5b4d888ca21497e0df1eacbcbcb87060feb7b8e04bce7d"
    },
    {
      "capability": "help.read",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "0d007db062e08aeb24b21d5d547f3d52d935750ef6c1ee36e868510a4bf9fa4d"
    },
    {
      "capability": "help.read",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "1ad888cf39937839ad8b99475a930edcbb1e83c83280dd6ba8e45f9a71b2fc89"
    },
    {
      "capability": "flow.cancel_own",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "6a2b21888c021b5ea4fa3571bf42344bad3b69026c9966d8833c0efa5c3c7a8d"
    },
    {
      "capability": "flow.cancel_own",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "0c853334a21272e99cc8413f0dab38065ec0ba920718d7e545467f2ba79e3c49"
    },
    {
      "capability": "flow.cancel_own",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "308a11336c7772d9f0c933a2f89285275b2bf6df28350d41fb7e46d9b6546416"
    },
    {
      "capability": "flow.cancel_own",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "8a1a7f517bee2f48dd7a274f46f596a41b06d0ff3876fb3405a7238c6c328958"
    },
    {
      "capability": "channel.check_membership",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "e9ceacac1c1b2e039df77d35aafd8dcf9999f079d36da8d4cc3321a0c2755439"
    },
    {
      "capability": "channel.check_membership",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "b32314aed63039e84b1f29799f4a2ff1bfc164fb248acecb4d51a29e93cd93e2"
    },
    {
      "capability": "channel.check_membership",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "f07f2f8940da147d71b2e98e8eab92b4bb1c8744662c5d8b60dd59772c12cfaf"
    },
    {
      "capability": "channel.check_membership",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "e549a054e8eee4e019e459277391fc91ba8f11c0781a4399a8cb64d3e2bd94cc"
    },
    {
      "capability": "service.preview.expire",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "621e87ab608101103c8352a31d446dc644fcbc798218da4818e7c5b45ff36208"
    },
    {
      "capability": "service.preview.expire",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "06d20bb412800b3ea2e732d4de1c39a6c780068f28c087b19b24bd6b7491ba44"
    },
    {
      "capability": "service.preview.expire",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "185a967b8ca070df278ee97cf651f7a8aea9587f2f209b324a753c9034c1a78d"
    },
    {
      "capability": "service.preview.expire",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "36b7c0afd9ae7fc8f7c249637e82f02234c62ab5036c27d0ddf7cc8c31fb07ec"
    },
    {
      "capability": "service.stars.reconcile",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "c2569133d8a50e2e83aa4488bf09f382cabf3486a91fe44fa3ac49031d5e728a"
    },
    {
      "capability": "service.stars.reconcile",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "142d69a967cb2d2fb36a05f53cffc67597c82fdecc885820524b4ac2fb9cd62a"
    },
    {
      "capability": "service.stars.reconcile",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "919cc279b8d67334e157a291521e7a84c4e007826eb35f9cc6bb94a823fdba99"
    },
    {
      "capability": "service.stars.reconcile",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "378ae07efe0d12cab298bf7ac1cc2030c11c27eb71fc58ddb75fc6cc623eebe0"
    },
    {
      "capability": "service.stars.expire",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "7247c606038aa0a28245676f0ade0fca23a9f91de71e4e59f5648a013c1acc40"
    },
    {
      "capability": "service.stars.expire",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "fff22407c7700399655e9660b38021bdc55a2d586b1a2ec1c05cfdc4c298cd33"
    },
    {
      "capability": "service.stars.expire",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "28f4856758dd3951b4bcc4896453d827fd213a17170fad7399b2e01ea9436152"
    },
    {
      "capability": "service.stars.expire",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "fdadfca81d7437ab4e39efa4a3d3f385810972ad02cc7c041e312c9c4eacc7a0"
    },
    {
      "capability": "service.stars.process_event",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "e4e4bda1c4d0a5eddcec542cd0f7046d1546e6f36d7518ccd5971f9f8bba3139"
    },
    {
      "capability": "service.stars.process_event",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "6f819858b43f3f5a2a0280fb31012ab470d6e2d0ba18a5956607661f192341e9"
    },
    {
      "capability": "service.stars.process_event",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "d3877425b91594db1ac753883b22922df6abe98b9a180465f26cdc2deb12ae4a"
    },
    {
      "capability": "service.stars.process_event",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "775a62e36112566b20acc6b9889c547afc3d60b44010588cb86df0e3a92ba115"
    },
    {
      "capability": "service.referral.settle",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "ddf6411c976c3888af5e65c0c888a4140c28825e81f3a2c4e2f61952fa8557f2"
    },
    {
      "capability": "service.referral.settle",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "0aa31923052bf67b66b8156153327860e42d91683eebeb546ea81024fe43c27b"
    },
    {
      "capability": "service.referral.settle",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "fe1742c2c070256189b50ce99b341317b983ced9db83aaa2d59cb986634c7057"
    },
    {
      "capability": "service.referral.settle",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "50ad562d98cba8c11bdbe5d8f812f531a541046a7332dccec546bc494d3b293a"
    },
    {
      "capability": "service.privacy.cleanup",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "117d13575e28447ef902c550a1c4aae250d50c7e6d4dd113802de535765f518f"
    },
    {
      "capability": "service.privacy.cleanup",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "dce56dbce77737e4cb742180c122dfd1a15b03ea7bbef78c8689eb5e8fa7b4c6"
    },
    {
      "capability": "service.privacy.cleanup",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "bc5029eb085d1d8fa644fa3508fc53b2818e3ad920382665cf0a773dbf65b3b9"
    },
    {
      "capability": "service.privacy.cleanup",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "8671be8de13c25325d9eb0fcf7f6877a0e1ca9416ed53df2cd83652168aead51"
    },
    {
      "capability": "service.notification.deliver_historical",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "50fe05d792c2d034c95cdaa8feaca1118cbdd000bb0e92fe6ac36b14eb5454a7"
    },
    {
      "capability": "service.notification.deliver_historical",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "aba3464c145b5f7539eb31fdfe227ae942ea3ba9188fbec013edc33499fc3bda"
    },
    {
      "capability": "service.notification.deliver_historical",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "dabd3f915fcfa2aaeb1eb86ecf72a9ad1568a0706d8c4cc60fdb6566728453e9"
    },
    {
      "capability": "service.notification.deliver_historical",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "187ba0b3406b5c5d6e83f71ac0b3c113d90885c68ec769a437ad5af6b23d5382"
    },
    {
      "capability": "service.outbox.drain",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "94e5df793fd6be529bae18c8b9d623440931e810b405466b7116ca543497556c"
    },
    {
      "capability": "service.outbox.drain",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "863753add8d5bce34c4c551336407bd5aac5c07ce1127dd9e10c57098b57063b"
    },
    {
      "capability": "service.outbox.drain",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "9df9dc36b0dfdd749fe3add1f217ad2631729bf3c31454e39be1d35551d5261c"
    },
    {
      "capability": "service.outbox.drain",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "42c8858cc36c1dc51b7c0c8805508d382b2e7412ee8c0035d7a56e6157fe97c5"
    },
    {
      "capability": "service.analytics.ingest",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "8a49d9174c15821525f3b4c1e85adfb808b0fa6e98608999b6526f4facb80e47"
    },
    {
      "capability": "service.analytics.ingest",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "3ed35ecdfd0406798b7293be1ab7b4fc1ea4df6b13cd941fda185ee28339fae8"
    },
    {
      "capability": "service.analytics.ingest",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "d6fe38fe061fba1ff4b937d7a4bce3cd33268e9f4565974bf6cda06b70a4a241"
    },
    {
      "capability": "service.analytics.ingest",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "0f077b7be02bb6d5c21de26e60ce896ee56abd14b5c5aa483e71da553f70a12e"
    },
    {
      "capability": "service.ai.settle_cost",
      "plan_code": "free",
      "access_overlay": "none",
      "definition_sha256": "e9aad621f0c33a9041106d744ccc2c87b325eb9b86712030e7ab06fd2c22f742"
    },
    {
      "capability": "service.ai.settle_cost",
      "plan_code": "free",
      "access_overlay": "dragon_preview",
      "definition_sha256": "042fcb19b26c71768c421b147c45d8be6341ec12cc2e916dccf66ca36ffee9fe"
    },
    {
      "capability": "service.ai.settle_cost",
      "plan_code": "professional",
      "access_overlay": "none",
      "definition_sha256": "c347244c5508834ec996dbf9f42259c456ca81d4a6a0439543e45b4033daed82"
    },
    {
      "capability": "service.ai.settle_cost",
      "plan_code": "dragon",
      "access_overlay": "none",
      "definition_sha256": "1544358dec04eeffaa36fc8bd6d9cda57b449095eff73fee9b9fe394ca7f6ae5"
    }
  ]
});
export const FIXED_OPERATION_ALIASES = deepFreeze({
  "lead.submit": "application.create",
  "lead.resubmit": "application.resubmit",
  "offer.create": "offer.create_private",
  "offer.edit": "offer.edit_own",
  "offer.submit": "offer.submit_moderation",
  "offer.business.active": "offer.activate_own",
  "offer.business.paused": "offer.pause_own",
  "offer.business.archived": "offer.archive_own",
  "dragon_preview_check_activation": "preview.activate_own",
  "partner.public_username": "partner.public_username.update_own"
});
export const AUDIT_NAME_ALIASES = deepFreeze({
  "ai.chat.generate": "ai.public_chat",
  "ai.partner.draft.generate": "ai.partner_draft",
  "ai.partner.draft.read": "ai.partner_draft.read",
  "ai.partner.draft.edit": "ai.partner_draft.edit",
  "ai.partner.draft.prepare_share": "ai.partner_draft.prepare_share",
  "lead.create": "application.create",
  "lead.read_own": "application.read_own",
  "lead.read_attributed": "application.read_attributed",
  "catalog.link.open": "offer.open_action",
  "account.profile.read": "profile.read_own",
  "account.profile.update": "profile.update_own",
  "support.open_ticket": "support.basic",
  "admin.application.result.manage": "admin.application.result"
});
export const PROTECTED_EXCEPTIONS = deepFreeze([
  "terms_acceptance",
  "own_privacy_report_and_delete_request",
  "payment_help",
  "safe_own_history"
]);

const projection = projectFoundationDefinitions({ schema_version: 1,
  policy_version: FOUNDATION_POLICY_VERSION, capabilities: CAPABILITY_DEFINITIONS,
  quota_definitions: QUOTA_DEFINITIONS, plan_order: POLICY_PLAN_SLOTS.map(slot => slot.policy_plan) });
export const CAPABILITY_CATALOG = deepFreeze(projection.capabilities.map((row, index) => ({
  ...row, definition_sha256: POLICY_HASH_MANIFEST.catalog[index].definition_sha256 })));
export const PLAN_CAPABILITIES = deepFreeze(projection.planCapabilities.map((row, index) => ({
  ...row, definition_sha256: POLICY_HASH_MANIFEST.plans[index].definition_sha256 })));
export const FOUNDATION_SEED = deepFreeze({ policyVersion: FOUNDATION_POLICY_VERSION,
  sourceSha256: FOUNDATION_SOURCE_SHA256, capabilities: CAPABILITY_CATALOG,
  planCapabilities: PLAN_CAPABILITIES, flagRows: [], hashManifest: POLICY_HASH_MANIFEST });
