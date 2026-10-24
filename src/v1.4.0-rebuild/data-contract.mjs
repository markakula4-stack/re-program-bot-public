const deepFreeze = (value) => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
};

export const SOURCE_MODES = deepFreeze({
  CANONICAL: "canonical",
  COMPATIBILITY_READ: "compatibility_read",
  APPEND_ONLY_HISTORY: "append_only_history",
  DERIVED_READ_ONLY: "derived_read_only",
  DORMANT_NO_WRITE: "dormant_no_write",
  PLANNED_ADDITIVE: "planned_additive",
});

export const CONTRACT_BASE = deepFreeze({
  release: "1.4.0-rebuild",
  part: "P02",
  baseCommit: "cf070ea90a7f2ad079d167473ae410b006f50323",
  firstPermittedMigration: 57,
  historicalMigrations: Object.freeze([43, 44, 45, 46, 47, 48]),
});

export const DORMANT_CABINET_TABLES = deepFreeze([
  "cabinet_v1_settings",
  "cabinet_capability_registry",
  "cabinet_role_capability_matrix",
  "cabinet_tariff_capacity",
  "cabinet_plan_quotas",
  "cabinet_partner_specializations",
  "cabinet_partner_specialization_events",
  "cabinet_resource_bindings",
  "cabinet_capability_grants",
  "cabinet_capability_grant_revocations",
  "cabinet_init_data_receipts",
  "cabinet_sessions",
  "cabinet_authorization_audit",
  "cabinet_privacy_maintenance_guard",
  "cabinet_offer_v1_settings",
  "cabinet_offer_submissions",
  "cabinet_offer_preview_receipts",
  "cabinet_offer_version_media",
  "cabinet_offer_review_receipts",
  "cabinet_offer_media_approvals",
  "cabinet_offer_publication_receipts",
  "cabinet_promotion_policies",
  "cabinet_promotion_windows",
  "cabinet_promotion_evaluation_receipts",
  "cabinet_promotion_application_receipts",
  "cabinet_application_v1_settings",
  "cabinet_application_status_registry",
  "cabinet_application_transition_registry",
  "cabinet_application_create_receipts",
  "cabinet_applications",
  "cabinet_application_contacts_private",
  "cabinet_application_assignments",
  "cabinet_application_events",
  "cabinet_application_transition_receipts",
  "cabinet_application_notes_private",
  "cabinet_application_assignment_receipts",
  "cabinet_application_results",
  "cabinet_access_e2e_settings",
  "cabinet_access_resolution_receipts",
  "cabinet_application_access_bindings",
  "cabinet_application_analytics_bridges",
  "cabinet_mini_app_v1_settings",
  "cabinet_mini_app_route_registry",
  "cabinet_release_v1_runs",
  "cabinet_release_v1_stage_evidence",
  "cabinet_release_v1_canary_evidence",
  "cabinet_release_v1_privacy_inventory",
]);

export const INDEPENDENT_DIMENSIONS = deepFreeze({
  systemRole: {
    values: ["user", "partner", "admin"],
    authority: "user_roles",
    defaultValue: "user",
  },
  legalProfile: {
    values: ["individual", "self_employed", "individual_entrepreneur"],
    authority: "partner_legal_profiles",
    defaultValue: "unknown",
    state: SOURCE_MODES.PLANNED_ADDITIVE,
  },
  plan: {
    values: ["free", "professional", "dragon"],
    authority: "user_plans + plan_aliases + plan_catalog",
    defaultValue: "free",
  },
  accessState: {
    values: [
      "none",
      "trial",
      "active",
      "cancel_at_period_end",
      "expired",
      "refunded",
      "suspended",
    ],
    authority:
      "user_access_states + trial_grants + subscription_access_grants + bonus_access_grants",
    defaultValue: "none",
  },
});

const GLOBAL_SERVER_AUTHORITY_FIELDS = deepFreeze([
  "telegram_id",
  "telegramId",
  "actor_id",
  "actorId",
  "user_id",
  "userId",
  "role",
  "roles",
  "systemRole",
  "partner_profile_id",
  "partnerProfileId",
  "owner_id",
  "ownerId",
  "owner_kind",
  "ownerKind",
  "inviter_id",
  "inviterId",
  "first_source_code",
  "firstSourceCode",
  "plan",
  "planCode",
  "access_state",
  "accessState",
  "status",
  "moderation_status",
  "moderationStatus",
  "visibility",
  "price",
  "priceVersion",
  "quota",
  "created_at",
  "createdAt",
  "updated_at",
  "updatedAt",
  "reviewed_by",
  "reviewedBy",
  "approved_by",
  "approvedBy",
]);

export const V140_DATA_CONTRACT = deepFreeze({
  identity: {
    purpose: "Telegram identity anchored only by verified initData",
    read: [
      { table: "users", mode: SOURCE_MODES.CANONICAL },
      { table: "user_attribution", mode: SOURCE_MODES.COMPATIBILITY_READ },
    ],
    write: null,
    writePolicy: "existing_registration_flow_only",
    immutableFields: [
      "telegram_id",
      "inviter_id",
      "inviter_bound_at",
      "referral_code",
      "first_source_code",
      "first_seen_at",
    ],
    clientWritableFields: [],
  },

  role: {
    purpose: "System role, independent from plan and legal profile",
    read: [{ table: "user_roles", mode: SOURCE_MODES.CANONICAL }],
    write: null,
    writePolicy: "admin_server_flow_only",
    clientWritableFields: [],
  },

  partnerApplication: {
    purpose: "One partner application with append-only decision history",
    read: [
      { table: "partner_applications", mode: SOURCE_MODES.CANONICAL },
      {
        table: "partner_application_decisions",
        mode: SOURCE_MODES.APPEND_ONLY_HISTORY,
      },
    ],
    write: {
      table: "partner_applications",
      mode: SOURCE_MODES.CANONICAL,
      operations: ["submit_own", "resubmit_own"],
    },
    history: ["partner_application_decisions"],
    clientWritableFields: ["displayName", "contact", "ageConfirmed"],
  },

  partnerProfile: {
    purpose: "Approved partner identity and explicit Beta access",
    read: [
      { table: "partner_profiles", mode: SOURCE_MODES.CANONICAL },
      { table: "partner_beta_access", mode: SOURCE_MODES.CANONICAL },
      {
        table: "partner_beta_access_events",
        mode: SOURCE_MODES.APPEND_ONLY_HISTORY,
      },
    ],
    write: null,
    writePolicy: "admin_approval_flow_only",
    clientWritableFields: [],
  },

  legalProfile: {
    purpose: "Minimal legal status, without identity documents",
    read: [
      { table: "partner_legal_profiles", mode: SOURCE_MODES.PLANNED_ADDITIVE },
      {
        table: "partner_legal_profile_events",
        mode: SOURCE_MODES.PLANNED_ADDITIVE,
      },
    ],
    write: {
      table: "partner_legal_profiles",
      mode: SOURCE_MODES.PLANNED_ADDITIVE,
      operations: ["self_declare_own"],
      earliestMigration: 57,
    },
    plannedSchema: {
      key: "partner_profile_id",
      values: ["individual", "self_employed", "individual_entrepreneur"],
      verificationStates: ["self_declared", "verified", "rejected"],
      forbiddenData: ["passport", "bank_details", "document_scan"],
    },
    history: ["partner_legal_profile_events"],
    clientWritableFields: ["profileKind", "selfDeclarationAccepted"],
  },

  offer: {
    purpose: "Single offer root with immutable versions and moderation history",
    read: [
      { table: "offers", mode: SOURCE_MODES.CANONICAL },
      { table: "offer_owners", mode: SOURCE_MODES.CANONICAL },
      { table: "offer_versions", mode: SOURCE_MODES.APPEND_ONLY_HISTORY },
      { table: "offer_visibility_rules", mode: SOURCE_MODES.CANONICAL },
      {
        table: "offer_moderation_decisions",
        mode: SOURCE_MODES.APPEND_ONLY_HISTORY,
      },
      { table: "partner_offer_links", mode: SOURCE_MODES.CANONICAL },
      { table: "partner_programs", mode: SOURCE_MODES.COMPATIBILITY_READ },
      { table: "program_offers", mode: SOURCE_MODES.COMPATIBILITY_READ },
    ],
    write: {
      table: "offers",
      mode: SOURCE_MODES.CANONICAL,
      operations: ["create_owned_draft", "create_new_version"],
    },
    history: ["offer_versions", "offer_moderation_decisions"],
    clientWritableFields: [
      "buttonText",
      "title",
      "description",
      "provider",
      "category",
      "payoutText",
      "requiredAction",
      "minAge",
      "maxAge",
      "geo",
      "holdDays",
      "trafficSources",
      "sourceName",
      "startsAt",
      "expiresAt",
      "partnerLinkId",
    ],
  },

  leadApplication: {
    purpose: "Existing client application; no parallel cabinet application row",
    read: [
      { table: "lead_requests", mode: SOURCE_MODES.CANONICAL },
      { table: "lead_partner_attribution", mode: SOURCE_MODES.CANONICAL },
      { table: "lead_request_events", mode: SOURCE_MODES.PLANNED_ADDITIVE },
      { table: "conversions", mode: SOURCE_MODES.COMPATIBILITY_READ },
    ],
    write: {
      table: "lead_requests",
      mode: SOURCE_MODES.CANONICAL,
      operations: ["create_own_for_offer", "resubmit_rejected_own"],
    },
    history: ["lead_request_events"],
    plannedHistory: {
      table: "lead_request_events",
      earliestMigration: 57,
      policy: "append_only_unique_event_key",
    },
    dormantAlternatives: ["cabinet_applications"],
    clientWritableFields: ["offerCode"],
  },

  result: {
    purpose: "Result stays attached to the canonical lead flow",
    read: [
      { table: "lead_requests", mode: SOURCE_MODES.CANONICAL },
      { table: "conversions", mode: SOURCE_MODES.COMPATIBILITY_READ },
    ],
    write: {
      table: "lead_requests",
      mode: SOURCE_MODES.CANONICAL,
      operations: ["admin_server_transition"],
    },
    history: ["lead_request_events"],
    compatibilityProjection: {
      table: "conversions",
      mode: SOURCE_MODES.COMPATIBILITY_READ,
      operations: ["mirror_confirmed", "mirror_paid"],
      mayAuthorize: false,
      mustFollowCanonicalCas: true,
    },
    dormantAlternatives: ["cabinet_application_results"],
    clientWritableFields: ["leadId", "decision", "rewardKopecks", "reason"],
  },

  planAccess: {
    purpose: "Read-only composition; role and plan never imply one another",
    read: [
      { table: "user_access", mode: SOURCE_MODES.COMPATIBILITY_READ },
      { table: "user_plans", mode: SOURCE_MODES.CANONICAL },
      { table: "user_access_states", mode: SOURCE_MODES.CANONICAL },
      { table: "trial_grants", mode: SOURCE_MODES.CANONICAL },
      { table: "subscription_access_grants", mode: SOURCE_MODES.CANONICAL },
      { table: "bonus_access_grants", mode: SOURCE_MODES.CANONICAL },
    ],
    write: null,
    writePolicy: "existing_payment_trial_reward_flows_only",
    clientWritableFields: [],
  },

  attribution: {
    purpose: "First inviter and first source are immutable",
    read: [
      { table: "users", mode: SOURCE_MODES.CANONICAL },
      { table: "user_attribution", mode: SOURCE_MODES.CANONICAL },
      { table: "partner_links", mode: SOURCE_MODES.CANONICAL },
      { table: "partner_link_clicks", mode: SOURCE_MODES.CANONICAL },
    ],
    write: null,
    writePolicy: "existing_attribution_flow_only",
    immutableFields: ["inviter_id", "inviter_bound_at", "first_source_code"],
    clientWritableFields: [],
  },

  analytics: {
    purpose: "Append canonical events; projections are never edited by clients",
    read: [
      { table: "canonical_analytics_events", mode: SOURCE_MODES.CANONICAL },
      {
        table: "analytics_projection_snapshots",
        mode: SOURCE_MODES.DERIVED_READ_ONLY,
      },
      {
        table: "analytics_daily_metrics",
        mode: SOURCE_MODES.DERIVED_READ_ONLY,
      },
      {
        table: "analytics_cohort_daily",
        mode: SOURCE_MODES.DERIVED_READ_ONLY,
      },
      {
        table: "ambassador_metrics_daily",
        mode: SOURCE_MODES.DERIVED_READ_ONLY,
      },
    ],
    write: {
      table: "canonical_analytics_events",
      mode: SOURCE_MODES.CANONICAL,
      operations: ["append_server_event"],
    },
    clientWritableFields: [],
  },
});

export const EXCLUDED_FROM_V140_WRITE_SCOPE = deepFreeze({
  promotions: [
    "cabinet_promotion_policies",
    "cabinet_promotion_windows",
    "cabinet_promotion_evaluation_receipts",
    "cabinet_promotion_application_receipts",
  ],
  crm: [
    "cabinet_application_contacts_private",
    "cabinet_application_assignments",
    "cabinet_application_notes_private",
    "cabinet_application_assignment_receipts",
  ],
  centralEntitlements: [
    "cabinet_capability_registry",
    "cabinet_role_capability_matrix",
    "cabinet_capability_grants",
    "cabinet_capability_grant_revocations",
  ],
});

export function getDataContract(resourceName) {
  const contract = V140_DATA_CONTRACT[resourceName];
  if (!contract) {
    throw new TypeError(`unknown_data_resource:${resourceName}`);
  }
  return contract;
}

export function assertClientPayloadAllowed(resourceName, payload) {
  const contract = getDataContract(resourceName);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("client_payload_must_be_plain_object");
  }

  const allowed = new Set(contract.clientWritableFields ?? []);
  const denied = new Set(GLOBAL_SERVER_AUTHORITY_FIELDS);

  for (const field of Object.keys(payload)) {
    if (denied.has(field)) {
      throw new TypeError(`server_authority_field:${field}`);
    }
    if (!allowed.has(field)) {
      throw new TypeError(`unknown_client_field:${field}`);
    }
  }

  return true;
}

export function validateDataContract(contract = V140_DATA_CONTRACT) {
  const problems = [];
  const excludedWrites = new Set(Object.values(EXCLUDED_FROM_V140_WRITE_SCOPE).flat());
  const dormant = new Set(DORMANT_CABINET_TABLES);

  for (const [resourceName, resource] of Object.entries(contract)) {
    if (!Array.isArray(resource.read) || resource.read.length === 0) {
      problems.push(`${resourceName}:missing_read_source`);
    }

    if (resource.write) {
      if (!resource.write.table || !resource.write.mode) {
        problems.push(`${resourceName}:invalid_write_authority`);
      }
      if (dormant.has(resource.write.table)) {
        problems.push(`${resourceName}:writes_dormant_table:${resource.write.table}`);
      }
      if (excludedWrites.has(resource.write.table)) {
        problems.push(`${resourceName}:writes_deferred_scope:${resource.write.table}`);
      }
      if (
        resource.write.mode === SOURCE_MODES.PLANNED_ADDITIVE &&
        resource.write.earliestMigration < CONTRACT_BASE.firstPermittedMigration
      ) {
        problems.push(`${resourceName}:planned_before_0057`);
      }
    } else if (!resource.writePolicy) {
      problems.push(`${resourceName}:missing_read_only_policy`);
    }

    if (
      resource.plannedHistory &&
      resource.plannedHistory.earliestMigration <
        CONTRACT_BASE.firstPermittedMigration
    ) {
      problems.push(`${resourceName}:history_planned_before_0057`);
    }
    if (
      resource.compatibilityProjection &&
      resource.compatibilityProjection.mayAuthorize !== false
    ) {
      problems.push(`${resourceName}:compatibility_projection_may_authorize`);
    }

    for (const source of resource.read ?? []) {
      if (!source.table || !Object.values(SOURCE_MODES).includes(source.mode)) {
        problems.push(`${resourceName}:invalid_read_source`);
      }
    }
  }

  if (new Set(DORMANT_CABINET_TABLES).size !== DORMANT_CABINET_TABLES.length) {
    problems.push("dormant_table_list_has_duplicates");
  }

  return deepFreeze({ ok: problems.length === 0, problems });
}

export function listWriteAuthorities() {
  return deepFreeze(
    Object.entries(V140_DATA_CONTRACT)
      .filter(([, resource]) => resource.write)
      .map(([resourceName, resource]) => ({
        resourceName,
        table: resource.write.table,
        mode: resource.write.mode,
      })),
  );
}
