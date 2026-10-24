-- RE Program Bot v1.4.0 Part 4 — access authority and application E2E.
--
-- Additive and idempotent. Existing v1.3.5 Dragon Preview, v1.3.6 Stars,
-- v1.3.9 analytics and v1.4.0 Parts 1-3 remain the only authorities. Every
-- new switch starts disabled. This migration does not wire the Worker, mutate
-- remote D1, grant access, charge Stars, change a lead/result, or enable rollout.

CREATE TABLE IF NOT EXISTS re_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cabinet_access_e2e_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rollout_mode TEXT NOT NULL DEFAULT 'off'
    CHECK (rollout_mode IN ('off', 'admin_shadow')),
  master_enabled INTEGER NOT NULL DEFAULT 0 CHECK (master_enabled IN (0, 1)),
  access_projection_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (access_projection_enabled IN (0, 1)),
  application_binding_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (application_binding_enabled IN (0, 1)),
  analytics_bridge_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (analytics_bridge_enabled IN (0, 1)),
  resolution_ttl_seconds INTEGER NOT NULL DEFAULT 300
    CHECK (resolution_ttl_seconds = 300),
  resolution_version INTEGER NOT NULL DEFAULT 1 CHECK (resolution_version = 1),
  policy_version TEXT NOT NULL DEFAULT '2026-09-14.cabinet-v1-part4'
    CHECK (policy_version = '2026-09-14.cabinet-v1-part4'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by INTEGER REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  CHECK (
    (master_enabled = 0 AND rollout_mode = 'off')
    OR (master_enabled = 1 AND rollout_mode = 'admin_shadow')
  ),
  CHECK (
    master_enabled = 1 OR (
      access_projection_enabled = 0 AND application_binding_enabled = 0
      AND analytics_bridge_enabled = 0
    )
  ),
  CHECK (application_binding_enabled = 0 OR access_projection_enabled = 1),
  CHECK (analytics_bridge_enabled = 0 OR application_binding_enabled = 1)
);

INSERT OR IGNORE INTO cabinet_access_e2e_settings (
  id, rollout_mode, master_enabled, access_projection_enabled,
  application_binding_enabled, analytics_bridge_enabled,
  resolution_ttl_seconds, resolution_version, policy_version,
  revision, updated_by, updated_at
) VALUES (
  1, 'off', 0, 0, 0, 0, 300, 1,
  '2026-09-14.cabinet-v1-part4', 1, NULL, unixepoch()
);

-- Application outcomes extend the immutable v1.3.9 registry without changing
-- its version or rewriting prior rows. The underlying authority remains the
-- exact lead + application result chain.
INSERT OR IGNORE INTO analytics_event_registry (
  event_name, event_version, category, authority_source, privacy_class,
  correction_policy, enabled, created_at
) VALUES
  ('application_succeeded', 1, 'product', 'leads', 'pseudonymous',
   'append_correction', 1, unixepoch()),
  ('application_unsuccessful', 1, 'product', 'leads', 'pseudonymous',
   'append_correction', 1, unixepoch()),
  ('application_cancelled', 1, 'product', 'leads', 'pseudonymous',
   'append_correction', 1, unixepoch());

INSERT OR IGNORE INTO analytics_metric_dictionary (
  metric_key, metric_version, metric_family, aggregation_kind,
  denominator_policy, timezone, dimension_policy, exclusion_policy,
  source_authority, small_cell_policy, created_at
) VALUES
  ('applications_successful', 1, 'daily', 'event_count', 'none', 'UTC',
   'global_and_core', 'effective_events_only', 'canonical_events',
   'suppress_below_threshold', unixepoch()),
  ('applications_unsuccessful', 1, 'daily', 'event_count', 'none', 'UTC',
   'global_and_core', 'effective_events_only', 'canonical_events',
   'suppress_below_threshold', unixepoch()),
  ('applications_cancelled', 1, 'daily', 'event_count', 'none', 'UTC',
   'global_and_core', 'effective_events_only', 'canonical_events',
   'suppress_below_threshold', unixepoch());

INSERT OR IGNORE INTO analytics_metric_event_members (
  metric_key, event_name, event_version, contribution_kind, created_at
) VALUES
  ('applications_successful', 'application_succeeded', 1, 'numerator', unixepoch()),
  ('applications_unsuccessful', 'application_unsuccessful', 1, 'numerator', unixepoch()),
  ('applications_cancelled', 'application_cancelled', 1, 'numerator', unixepoch());

CREATE TABLE IF NOT EXISTS cabinet_access_resolution_receipts (
  resolution_id TEXT PRIMARY KEY CHECK (
    length(resolution_id) = 68
    AND substr(resolution_id, 1, 4) = 'axr_'
    AND substr(resolution_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  subject_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  base_plan_code TEXT NOT NULL CHECK (base_plan_code IN (
    'free', 'professional', 'dragon'
  )),
  plan_code TEXT NOT NULL REFERENCES cabinet_tariff_capacity(plan_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  access_state TEXT NOT NULL CHECK (access_state IN (
    'none', 'trial', 'active', 'cancel_at_period_end', 'expired',
    'refunded', 'suspended'
  )),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'free_default', 'dragon_preview', 'stars_subscription'
  )),
  source_starts_at INTEGER NOT NULL CHECK (source_starts_at > 0),
  source_ends_at INTEGER CHECK (
    source_ends_at IS NULL OR source_ends_at > source_starts_at
  ),
  subscription_id TEXT REFERENCES subscriptions(subscription_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  access_grant_id TEXT REFERENCES subscription_access_grants(grant_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  trial_grant_id TEXT REFERENCES trial_grants(grant_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_plan_revision INTEGER NOT NULL CHECK (user_plan_revision > 0),
  access_state_revision INTEGER NOT NULL CHECK (access_state_revision > 0),
  capacity_percent INTEGER NOT NULL CHECK (capacity_percent IN (10, 50, 100)),
  quota_code TEXT NOT NULL DEFAULT 'active_applications'
    CHECK (quota_code = 'active_applications'),
  active_application_limit INTEGER NOT NULL CHECK (
    active_application_limit IN (5, 25, 50)
  ),
  resolution_version INTEGER NOT NULL DEFAULT 1 CHECK (resolution_version = 1),
  authority_key_hash TEXT NOT NULL CHECK (
    length(authority_key_hash) = 64
    AND authority_key_hash = lower(authority_key_hash)
    AND authority_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) = 68
    AND substr(idempotency_key, 1, 4) = 'key_'
    AND substr(idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash = lower(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  valid_until INTEGER NOT NULL CHECK (
    valid_until > created_at AND valid_until <= created_at + 300
  ),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= valid_until
    AND retention_until <= created_at + 15552000
  ),
  FOREIGN KEY (subject_telegram_id) REFERENCES user_plans(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (subject_telegram_id) REFERENCES user_access_states(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (plan_code, quota_code)
    REFERENCES cabinet_plan_quotas(plan_code, quota_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (source_kind = 'free_default'
      AND base_plan_code = 'free' AND plan_code = 'free'
      AND access_state IN ('none', 'expired', 'refunded')
      AND source_ends_at IS NULL
      AND subscription_id IS NULL AND access_grant_id IS NULL
      AND trial_grant_id IS NULL)
    OR
    (source_kind = 'dragon_preview'
      AND base_plan_code = 'free' AND plan_code = 'dragon'
      AND access_state = 'trial'
      AND source_ends_at = source_starts_at + 604800
      AND subscription_id IS NULL AND access_grant_id IS NULL
      AND trial_grant_id IS NOT NULL)
    OR
    (source_kind = 'stars_subscription'
      AND base_plan_code = plan_code
      AND plan_code IN ('professional', 'dragon')
      AND access_state IN ('active', 'cancel_at_period_end')
      AND source_ends_at IS NOT NULL
      AND subscription_id IS NOT NULL AND access_grant_id IS NOT NULL
      AND trial_grant_id IS NULL)
  ),
  CHECK (
    (plan_code = 'free' AND capacity_percent = 10
      AND active_application_limit = 5)
    OR (plan_code = 'professional' AND capacity_percent = 50
      AND active_application_limit = 25)
    OR (plan_code = 'dragon' AND capacity_percent = 100
      AND active_application_limit = 50)
  )
);

CREATE INDEX IF NOT EXISTS idx_cabinet_access_resolution_subject
  ON cabinet_access_resolution_receipts(
    subject_telegram_id, created_at DESC, resolution_id
  );

CREATE INDEX IF NOT EXISTS idx_cabinet_access_resolution_retention
  ON cabinet_access_resolution_receipts(retention_until, resolution_id);

CREATE TABLE IF NOT EXISTS cabinet_application_access_bindings (
  binding_id TEXT PRIMARY KEY CHECK (
    length(binding_id) = 68
    AND substr(binding_id, 1, 4) = 'axb_'
    AND substr(binding_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  application_id TEXT NOT NULL UNIQUE CHECK (
    length(application_id) = 68
    AND substr(application_id, 1, 4) = 'app_'
    AND substr(application_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  create_receipt_id TEXT NOT NULL UNIQUE CHECK (
    length(create_receipt_id) = 68
    AND substr(create_receipt_id, 1, 4) = 'acr_'
    AND substr(create_receipt_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  source_lead_id INTEGER NOT NULL REFERENCES lead_requests(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  offer_cycle_id TEXT NOT NULL REFERENCES cabinet_offer_publication_receipts(
    publication_id
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  subject_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  access_resolution_id TEXT NOT NULL REFERENCES cabinet_access_resolution_receipts(
    resolution_id
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  plan_code TEXT NOT NULL CHECK (plan_code IN (
    'free', 'professional', 'dragon'
  )),
  access_state TEXT NOT NULL CHECK (access_state IN (
    'none', 'trial', 'active', 'cancel_at_period_end', 'expired', 'refunded'
  )),
  plan_authority_key_hash TEXT NOT NULL CHECK (
    length(plan_authority_key_hash) = 64
    AND plan_authority_key_hash = lower(plan_authority_key_hash)
    AND plan_authority_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) = 68
    AND substr(idempotency_key, 1, 4) = 'key_'
    AND substr(idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash = lower(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_cabinet_application_access_subject
  ON cabinet_application_access_bindings(
    subject_telegram_id, created_at, binding_id
  );

CREATE TABLE IF NOT EXISTS cabinet_application_analytics_bridges (
  bridge_id TEXT PRIMARY KEY CHECK (
    length(bridge_id) = 68
    AND substr(bridge_id, 1, 4) = 'aab_'
    AND substr(bridge_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  application_id TEXT NOT NULL UNIQUE REFERENCES cabinet_applications(
    application_id
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  result_id TEXT NOT NULL UNIQUE REFERENCES cabinet_application_results(result_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_lead_id INTEGER NOT NULL REFERENCES lead_requests(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  offer_cycle_id TEXT NOT NULL REFERENCES cabinet_offer_publication_receipts(
    publication_id
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  offer_code TEXT NOT NULL CHECK (length(offer_code) BETWEEN 1 AND 64),
  owner_partner_profile_id INTEGER NOT NULL REFERENCES partner_profiles(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  access_resolution_id TEXT NOT NULL REFERENCES cabinet_access_resolution_receipts(
    resolution_id
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  plan_code TEXT NOT NULL CHECK (plan_code IN (
    'free', 'professional', 'dragon'
  )),
  access_state TEXT NOT NULL CHECK (access_state IN (
    'none', 'trial', 'active', 'cancel_at_period_end', 'expired', 'refunded'
  )),
  terminal_status TEXT NOT NULL CHECK (terminal_status IN (
    'completed', 'rejected', 'cancelled'
  )),
  result_code TEXT NOT NULL CHECK (result_code IN (
    'successful', 'unsuccessful', 'cancelled'
  )),
  result_hash TEXT NOT NULL CHECK (
    length(result_hash) = 64 AND result_hash = lower(result_hash)
    AND result_hash NOT GLOB '*[^0-9a-f]*'
  ),
  event_id TEXT NOT NULL UNIQUE CHECK (
    length(event_id) = 36 AND event_id = lower(event_id)
  ),
  event_key TEXT NOT NULL UNIQUE CHECK (
    length(event_key) = 68
    AND substr(event_key, 1, 4) = 'evt_'
    AND substr(event_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  event_name TEXT NOT NULL CHECK (event_name IN (
    'application_succeeded', 'application_unsuccessful',
    'application_cancelled'
  )),
  actor_pseudonym TEXT NOT NULL CHECK (
    length(actor_pseudonym) = 64
    AND actor_pseudonym = lower(actor_pseudonym)
    AND actor_pseudonym NOT GLOB '*[^0-9a-f]*'
  ),
  pseudonym_key_version INTEGER NOT NULL DEFAULT 1
    CHECK (pseudonym_key_version = 1),
  source_key_hash TEXT NOT NULL CHECK (
    length(source_key_hash) = 64 AND source_key_hash = lower(source_key_hash)
    AND source_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64 AND payload_hash = lower(payload_hash)
    AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  role_dimension TEXT NOT NULL DEFAULT 'user' CHECK (role_dimension = 'user'),
  legal_profile_dimension TEXT NOT NULL DEFAULT 'unknown'
    CHECK (legal_profile_dimension = 'unknown'),
  source_family_dimension TEXT NOT NULL DEFAULT 'partner_link'
    CHECK (source_family_dimension = 'partner_link'),
  object_type_dimension TEXT NOT NULL DEFAULT 'lead'
    CHECK (object_type_dimension = 'lead'),
  authority_hash TEXT NOT NULL CHECK (
    length(authority_hash) = 64 AND authority_hash = lower(authority_hash)
    AND authority_hash NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) = 68
    AND substr(idempotency_key, 1, 4) = 'key_'
    AND substr(idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash = lower(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= occurred_at),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= recorded_at
    AND retention_until <= recorded_at + 15552000
  ),
  CHECK (
    (terminal_status = 'completed' AND result_code = 'successful'
      AND event_name = 'application_succeeded')
    OR (terminal_status = 'rejected' AND result_code = 'unsuccessful'
      AND event_name = 'application_unsuccessful')
    OR (terminal_status = 'cancelled' AND result_code = 'cancelled'
      AND event_name = 'application_cancelled')
  )
);

CREATE INDEX IF NOT EXISTS idx_cabinet_application_analytics_owner
  ON cabinet_application_analytics_bridges(
    owner_partner_profile_id, recorded_at, bridge_id
  );

-- Settings can only enter the closed admin shadow when every parent authority
-- required by the requested child flags is already aligned.
CREATE TRIGGER IF NOT EXISTS trg_cabinet_access_e2e_settings_identity
BEFORE UPDATE ON cabinet_access_e2e_settings
WHEN NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT, 'access E2E settings identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_access_e2e_settings_revision
BEFORE UPDATE ON cabinet_access_e2e_settings
WHEN NEW.revision != OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'access E2E settings revision must advance exactly once');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_access_e2e_settings_admin
BEFORE UPDATE ON cabinet_access_e2e_settings
WHEN NEW.updated_by IS NULL OR NOT EXISTS (
  SELECT 1 FROM user_roles role
  WHERE role.telegram_id = NEW.updated_by
    AND role.role = 'admin' AND role.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'access E2E settings update requires active admin');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_access_e2e_settings_parent_gate
BEFORE UPDATE ON cabinet_access_e2e_settings
WHEN NEW.master_enabled = 1 AND NOT EXISTS (
  SELECT 1 FROM cabinet_v1_settings cabinet,
    cabinet_application_v1_settings application
  WHERE cabinet.id = 1 AND cabinet.rollout_mode = 'admin_shadow'
    AND cabinet.master_enabled = 1 AND cabinet.profile_enabled = 1
    AND cabinet.application_enabled = 1
    AND application.id = 1 AND application.enabled = 1
    AND application.lifecycle_enabled = 1
)
BEGIN
  SELECT RAISE(ABORT, 'parent cabinet gate is closed');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_access_e2e_settings_analytics_gate
BEFORE UPDATE ON cabinet_access_e2e_settings
WHEN NEW.analytics_bridge_enabled = 1 AND NOT EXISTS (
  SELECT 1 FROM analytics_v2_settings analytics,
    cabinet_application_v1_settings application
  WHERE analytics.id = 1 AND analytics.rollout_mode = 'admin_shadow'
    AND analytics.master_enabled = 1 AND analytics.ingest_enabled = 1
    AND application.id = 1 AND application.result_enabled = 1
)
BEGIN
  SELECT RAISE(ABORT, 'analytics bridge parent gate is closed');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_access_e2e_settings_time
BEFORE UPDATE ON cabinet_access_e2e_settings
WHEN NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'access E2E settings time cannot regress');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_access_e2e_settings_no_delete
BEFORE DELETE ON cabinet_access_e2e_settings
BEGIN
  SELECT RAISE(ABORT, 'access E2E settings cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_access_resolution_idempotency
BEFORE INSERT ON cabinet_access_resolution_receipts
WHEN EXISTS (
  SELECT 1 FROM cabinet_access_resolution_receipts existing
  WHERE existing.idempotency_key = NEW.idempotency_key
    AND (existing.resolution_id != NEW.resolution_id
      OR existing.subject_telegram_id != NEW.subject_telegram_id
      OR existing.base_plan_code != NEW.base_plan_code
      OR existing.plan_code != NEW.plan_code
      OR existing.access_state != NEW.access_state
      OR existing.source_kind != NEW.source_kind
      OR existing.source_starts_at != NEW.source_starts_at
      OR existing.source_ends_at IS NOT NEW.source_ends_at
      OR existing.subscription_id IS NOT NEW.subscription_id
      OR existing.access_grant_id IS NOT NEW.access_grant_id
      OR existing.trial_grant_id IS NOT NEW.trial_grant_id
      OR existing.user_plan_revision != NEW.user_plan_revision
      OR existing.access_state_revision != NEW.access_state_revision
      OR existing.capacity_percent != NEW.capacity_percent
      OR existing.quota_code != NEW.quota_code
      OR existing.active_application_limit != NEW.active_application_limit
      OR existing.resolution_version != NEW.resolution_version
      OR existing.authority_key_hash != NEW.authority_key_hash
      OR existing.request_hash != NEW.request_hash
      OR existing.created_at != NEW.created_at
      OR existing.valid_until != NEW.valid_until
      OR existing.retention_until != NEW.retention_until)
)
BEGIN
  SELECT RAISE(ABORT, 'access resolution idempotency mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_access_resolution_identity_collision
BEFORE INSERT ON cabinet_access_resolution_receipts
WHEN EXISTS (
  SELECT 1 FROM cabinet_access_resolution_receipts existing
  WHERE existing.resolution_id = NEW.resolution_id
    AND existing.idempotency_key != NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'access resolution identity collision');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_access_resolution_validate
BEFORE INSERT ON cabinet_access_resolution_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_access_resolution_receipts existing
  WHERE existing.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_access_e2e_settings settings,
      cabinet_v1_settings cabinet
    WHERE settings.id = 1 AND settings.rollout_mode = 'admin_shadow'
      AND settings.master_enabled = 1
      AND settings.access_projection_enabled = 1
      AND settings.resolution_version = NEW.resolution_version
      AND settings.resolution_ttl_seconds = 300
      AND cabinet.id = 1 AND cabinet.rollout_mode = 'admin_shadow'
      AND cabinet.master_enabled = 1 AND cabinet.profile_enabled = 1
  ) THEN RAISE(ABORT, 'access resolution gate is closed') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM users subject
    JOIN user_plans plan ON plan.telegram_id = subject.telegram_id
    JOIN user_access_states state ON state.telegram_id = subject.telegram_id
    JOIN cabinet_tariff_capacity capacity
      ON capacity.plan_code = NEW.plan_code
    JOIN cabinet_plan_quotas quota
      ON quota.plan_code = NEW.plan_code
      AND quota.quota_code = 'active_applications'
    WHERE subject.telegram_id = NEW.subject_telegram_id
      AND subject.is_blocked = 0
      AND plan.plan_code = NEW.base_plan_code
      AND plan.revision = NEW.user_plan_revision
      AND unixepoch(plan.effective_from) <= NEW.created_at
      AND (plan.effective_until IS NULL
        OR unixepoch(plan.effective_until) > NEW.created_at)
      AND state.access_state = NEW.access_state
      AND state.revision = NEW.access_state_revision
      AND (NEW.source_kind != 'dragon_preview' OR (
        unixepoch(state.state_started_at) = NEW.source_starts_at
        AND unixepoch(state.state_ends_at) = NEW.source_ends_at
      ))
      AND capacity.capacity_version = 1
      AND capacity.capacity_percent = NEW.capacity_percent
      AND quota.quota_version = 1
      AND quota.limit_value = NEW.active_application_limit
  ) THEN RAISE(ABORT, 'access projection authority mismatch') END;

  SELECT CASE WHEN NEW.source_kind = 'free_default' AND NOT (
    NOT EXISTS (
      SELECT 1 FROM trial_grants preview
      WHERE preview.telegram_id = NEW.subject_telegram_id
        AND preview.program_code = 'dragon_preview'
        AND preview.status = 'active'
        AND preview.started_at <= NEW.created_at
        AND preview.ends_at > NEW.created_at
    )
    AND NOT EXISTS (
      SELECT 1 FROM subscriptions subscription
      JOIN subscription_access_grants access
        ON access.subscription_id = subscription.subscription_id
      WHERE subscription.telegram_id = NEW.subject_telegram_id
        AND subscription.status IN ('active', 'cancel_at_period_end')
        AND subscription.current_period_start <= NEW.created_at
        AND subscription.current_period_end > NEW.created_at
        AND access.telegram_id = NEW.subject_telegram_id
        AND access.plan_code = subscription.plan_code
        AND access.status = 'active'
        AND access.ends_at = subscription.current_period_end
    )
  ) THEN RAISE(ABORT, 'free access authority mismatch') END;

  SELECT CASE WHEN NEW.source_kind = 'dragon_preview' AND NOT EXISTS (
    SELECT 1 FROM trial_grants preview
    WHERE preview.grant_id = NEW.trial_grant_id
      AND preview.telegram_id = NEW.subject_telegram_id
      AND preview.program_code = 'dragon_preview'
      AND preview.status = 'active'
      AND preview.started_at = NEW.source_starts_at
      AND preview.ends_at = NEW.source_ends_at
      AND preview.started_at <= NEW.created_at
      AND preview.ends_at > NEW.created_at
      AND NEW.valid_until <= preview.ends_at
      AND NOT EXISTS (
        SELECT 1 FROM subscriptions subscription
        JOIN subscription_access_grants access
          ON access.subscription_id = subscription.subscription_id
        WHERE subscription.telegram_id = NEW.subject_telegram_id
          AND subscription.status IN ('active', 'cancel_at_period_end')
          AND subscription.current_period_start <= NEW.created_at
          AND subscription.current_period_end > NEW.created_at
          AND access.telegram_id = NEW.subject_telegram_id
          AND access.status = 'active'
          AND access.ends_at = subscription.current_period_end
      )
  ) THEN RAISE(ABORT, 'Dragon Preview authority mismatch') END;

  SELECT CASE WHEN NEW.source_kind = 'stars_subscription' AND NOT EXISTS (
    SELECT 1
    FROM subscriptions subscription
    JOIN subscription_access_grants access
      ON access.grant_id = NEW.access_grant_id
      AND access.subscription_id = subscription.subscription_id
    JOIN user_plans plan ON plan.telegram_id = subscription.telegram_id
    JOIN user_access_states state ON state.telegram_id = subscription.telegram_id
    WHERE subscription.subscription_id = NEW.subscription_id
      AND subscription.telegram_id = NEW.subject_telegram_id
      AND subscription.plan_code = NEW.plan_code
      AND subscription.status = NEW.access_state
      AND subscription.status IN ('active', 'cancel_at_period_end')
      AND subscription.current_period_start = NEW.source_starts_at
      AND subscription.current_period_end = NEW.source_ends_at
      AND subscription.current_period_start <= NEW.created_at
      AND subscription.current_period_end > NEW.created_at
      AND access.telegram_id = NEW.subject_telegram_id
      AND access.plan_code = NEW.plan_code
      AND access.status = 'active'
      AND access.starts_at <= NEW.created_at
      AND access.ends_at = subscription.current_period_end
      AND plan.plan_code = subscription.plan_code
      AND plan.revision = NEW.user_plan_revision
      AND unixepoch(plan.effective_until) = subscription.current_period_end
      AND state.access_state = subscription.status
      AND state.revision = NEW.access_state_revision
      AND unixepoch(state.state_ends_at) = subscription.current_period_end
      AND NEW.valid_until <= subscription.current_period_end
      AND NOT EXISTS (
        SELECT 1 FROM trial_grants preview
        WHERE preview.telegram_id = NEW.subject_telegram_id
          AND preview.program_code = 'dragon_preview'
          AND preview.status = 'active'
          AND preview.started_at <= NEW.created_at
          AND preview.ends_at > NEW.created_at
      )
  ) THEN RAISE(ABORT, 'Stars access authority mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_access_identity_collision
BEFORE INSERT ON cabinet_application_access_bindings
WHEN EXISTS (
  SELECT 1 FROM cabinet_application_access_bindings existing
  WHERE (
    existing.binding_id = NEW.binding_id
    OR existing.application_id = NEW.application_id
    OR existing.create_receipt_id = NEW.create_receipt_id
  ) AND existing.idempotency_key != NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'application access binding identity collision');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_access_resolution_no_update
BEFORE UPDATE ON cabinet_access_resolution_receipts
BEGIN
  SELECT RAISE(ABORT, 'access resolution receipts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_access_resolution_guarded_delete
BEFORE DELETE ON cabinet_access_resolution_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_privacy_maintenance_guard guard
  WHERE guard.id = 1 AND guard.expires_at >= unixepoch()
    AND (
      (guard.reason = 'retention' AND OLD.retention_until <= unixepoch())
      OR (guard.reason = 'user_deletion'
        AND guard.subject_telegram_id = OLD.subject_telegram_id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'access resolution deletion requires privacy guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_access_idempotency
BEFORE INSERT ON cabinet_application_access_bindings
WHEN EXISTS (
  SELECT 1 FROM cabinet_application_access_bindings existing
  WHERE existing.idempotency_key = NEW.idempotency_key
    AND (existing.binding_id != NEW.binding_id
      OR existing.application_id != NEW.application_id
      OR existing.create_receipt_id != NEW.create_receipt_id
      OR existing.source_lead_id != NEW.source_lead_id
      OR existing.offer_cycle_id != NEW.offer_cycle_id
      OR existing.subject_telegram_id != NEW.subject_telegram_id
      OR existing.access_resolution_id != NEW.access_resolution_id
      OR existing.plan_code != NEW.plan_code
      OR existing.access_state != NEW.access_state
      OR existing.plan_authority_key_hash != NEW.plan_authority_key_hash
      OR existing.request_hash != NEW.request_hash
      OR existing.created_at != NEW.created_at)
)
BEGIN
  SELECT RAISE(ABORT, 'application access binding idempotency mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_access_validate
BEFORE INSERT ON cabinet_application_access_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_application_access_bindings existing
  WHERE existing.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_access_e2e_settings settings
    WHERE settings.id = 1 AND settings.rollout_mode = 'admin_shadow'
      AND settings.master_enabled = 1
      AND settings.access_projection_enabled = 1
      AND settings.application_binding_enabled = 1
  ) THEN RAISE(ABORT, 'application access binding gate is closed') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_access_resolution_receipts access
    JOIN lead_requests lead ON lead.id = NEW.source_lead_id
    JOIN cabinet_offer_publication_receipts publication
      ON publication.publication_id = NEW.offer_cycle_id
    WHERE access.resolution_id = NEW.access_resolution_id
      AND access.subject_telegram_id = NEW.subject_telegram_id
      AND access.plan_code = NEW.plan_code
      AND access.access_state = NEW.access_state
      AND access.authority_key_hash = NEW.plan_authority_key_hash
      AND access.created_at <= NEW.created_at
      AND access.valid_until >= NEW.created_at
      AND lead.telegram_id = NEW.subject_telegram_id
      AND lead.offer_code = publication.offer_code
      AND NOT EXISTS (
        SELECT 1 FROM cabinet_application_create_receipts receipt
        WHERE receipt.create_receipt_id = NEW.create_receipt_id
          OR receipt.application_id = NEW.application_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM cabinet_applications application
        WHERE application.application_id = NEW.application_id
      )
  ) THEN RAISE(ABORT, 'application access binding authority mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_access_no_update
BEFORE UPDATE ON cabinet_application_access_bindings
BEGIN
  SELECT RAISE(ABORT, 'application access bindings are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_access_no_delete
BEFORE DELETE ON cabinet_application_access_bindings
BEGIN
  SELECT RAISE(ABORT, 'application access bindings cannot be deleted');
END;

-- Once the Part 4 binding gate is enabled, every Part 3 create statement must
-- carry the exact fresh server access resolution created in the same D1 batch.
CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_create_access_binding
BEFORE INSERT ON cabinet_application_create_receipts
WHEN EXISTS (
  SELECT 1 FROM cabinet_access_e2e_settings settings
  WHERE settings.id = 1 AND settings.rollout_mode = 'admin_shadow'
    AND settings.master_enabled = 1
    AND settings.application_binding_enabled = 1
)
AND NOT EXISTS (
  SELECT 1
  FROM cabinet_application_access_bindings binding
  JOIN cabinet_access_resolution_receipts access
    ON access.resolution_id = binding.access_resolution_id
  WHERE binding.application_id = NEW.application_id
    AND binding.create_receipt_id = NEW.create_receipt_id
    AND binding.source_lead_id = NEW.source_lead_id
    AND binding.offer_cycle_id = NEW.offer_cycle_id
    AND binding.subject_telegram_id = NEW.subject_telegram_id
    AND binding.plan_code = NEW.plan_code
    AND binding.access_state = access.access_state
    AND binding.plan_authority_key_hash = NEW.plan_authority_key_hash
    AND access.subject_telegram_id = NEW.subject_telegram_id
    AND access.plan_code = NEW.plan_code
    AND access.authority_key_hash = NEW.plan_authority_key_hash
    AND access.created_at <= NEW.created_at
    AND access.valid_until >= NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'fresh access binding is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_analytics_idempotency
BEFORE INSERT ON cabinet_application_analytics_bridges
WHEN EXISTS (
  SELECT 1 FROM cabinet_application_analytics_bridges existing
  WHERE existing.idempotency_key = NEW.idempotency_key
    AND (existing.bridge_id != NEW.bridge_id
      OR existing.application_id != NEW.application_id
      OR existing.result_id != NEW.result_id
      OR existing.source_lead_id != NEW.source_lead_id
      OR existing.offer_cycle_id != NEW.offer_cycle_id
      OR existing.offer_code != NEW.offer_code
      OR existing.owner_partner_profile_id != NEW.owner_partner_profile_id
      OR existing.access_resolution_id != NEW.access_resolution_id
      OR existing.plan_code != NEW.plan_code
      OR existing.access_state != NEW.access_state
      OR existing.terminal_status != NEW.terminal_status
      OR existing.result_code != NEW.result_code
      OR existing.result_hash != NEW.result_hash
      OR existing.event_id != NEW.event_id
      OR existing.event_key != NEW.event_key
      OR existing.event_name != NEW.event_name
      OR existing.actor_pseudonym != NEW.actor_pseudonym
      OR existing.pseudonym_key_version != NEW.pseudonym_key_version
      OR existing.source_key_hash != NEW.source_key_hash
      OR existing.payload_hash != NEW.payload_hash
      OR existing.role_dimension != NEW.role_dimension
      OR existing.legal_profile_dimension != NEW.legal_profile_dimension
      OR existing.source_family_dimension != NEW.source_family_dimension
      OR existing.object_type_dimension != NEW.object_type_dimension
      OR existing.authority_hash != NEW.authority_hash
      OR existing.request_hash != NEW.request_hash
      OR existing.occurred_at != NEW.occurred_at
      OR existing.recorded_at != NEW.recorded_at
      OR existing.retention_until != NEW.retention_until)
)
BEGIN
  SELECT RAISE(ABORT, 'application analytics idempotency mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_analytics_identity_collision
BEFORE INSERT ON cabinet_application_analytics_bridges
WHEN EXISTS (
  SELECT 1 FROM cabinet_application_analytics_bridges existing
  WHERE (
    existing.bridge_id = NEW.bridge_id
    OR existing.application_id = NEW.application_id
    OR existing.result_id = NEW.result_id
    OR existing.event_id = NEW.event_id
    OR existing.event_key = NEW.event_key
  ) AND existing.idempotency_key != NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'application analytics identity collision');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_analytics_single_result
BEFORE INSERT ON cabinet_application_analytics_bridges
WHEN EXISTS (
  SELECT 1 FROM cabinet_application_analytics_bridges existing
  WHERE existing.result_id = NEW.result_id
    AND existing.idempotency_key != NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'application result already has analytics bridge');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_analytics_validate
BEFORE INSERT ON cabinet_application_analytics_bridges
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_application_analytics_bridges existing
  WHERE existing.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_access_e2e_settings settings,
      analytics_v2_settings analytics
    WHERE settings.id = 1 AND settings.rollout_mode = 'admin_shadow'
      AND settings.master_enabled = 1
      AND settings.analytics_bridge_enabled = 1
      AND analytics.id = 1 AND analytics.rollout_mode = 'admin_shadow'
      AND analytics.master_enabled = 1 AND analytics.ingest_enabled = 1
  ) THEN RAISE(ABORT, 'application analytics bridge gate is closed') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM cabinet_applications application
    JOIN cabinet_application_results result
      ON result.application_id = application.application_id
    JOIN cabinet_application_access_bindings binding
      ON binding.application_id = application.application_id
    JOIN cabinet_access_resolution_receipts access
      ON access.resolution_id = binding.access_resolution_id
    JOIN lead_requests lead ON lead.id = application.source_lead_id
    JOIN lead_partner_attribution attribution
      ON attribution.lead_id = lead.id
    JOIN cabinet_offer_publication_receipts publication
      ON publication.publication_id = application.offer_cycle_id
    WHERE application.application_id = NEW.application_id
      AND result.result_id = NEW.result_id
      AND application.source_lead_id = NEW.source_lead_id
      AND application.offer_cycle_id = NEW.offer_cycle_id
      AND application.offer_code = NEW.offer_code
      AND application.owner_partner_profile_id = NEW.owner_partner_profile_id
      AND application.plan_code_at_creation = NEW.plan_code
      AND application.current_status = NEW.terminal_status
      AND result.owner_partner_profile_id = NEW.owner_partner_profile_id
      AND result.terminal_status = NEW.terminal_status
      AND result.result_code = NEW.result_code
      AND result.result_hash = NEW.result_hash
      AND result.occurred_at = NEW.occurred_at
      AND binding.source_lead_id = NEW.source_lead_id
      AND binding.offer_cycle_id = NEW.offer_cycle_id
      AND binding.subject_telegram_id = application.subject_telegram_id
      AND binding.access_resolution_id = NEW.access_resolution_id
      AND binding.plan_code = NEW.plan_code
      AND binding.access_state = NEW.access_state
      AND access.subject_telegram_id = application.subject_telegram_id
      AND access.plan_code = NEW.plan_code
      AND access.access_state = NEW.access_state
      AND lead.telegram_id = application.subject_telegram_id
      AND lead.offer_code = NEW.offer_code
      AND attribution.partner_profile_id = NEW.owner_partner_profile_id
      AND publication.offer_code = NEW.offer_code
      AND publication.offer_version_id = application.offer_version_id
      AND publication.owner_partner_profile_id = NEW.owner_partner_profile_id
  ) THEN RAISE(ABORT, 'application analytics journey mismatch') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM canonical_analytics_events event
    WHERE event.event_id = NEW.event_id OR event.event_key = NEW.event_key
  ) THEN RAISE(ABORT, 'application analytics event already exists') END;
END;

-- New result event names may only enter the canonical ledger through the exact
-- Part 4 bridge row. This keeps arbitrary direct analytics writes fail-closed.
CREATE TRIGGER IF NOT EXISTS trg_canonical_application_event_bridge_guard
BEFORE INSERT ON canonical_analytics_events
WHEN NEW.event_name IN (
  'application_succeeded', 'application_unsuccessful',
  'application_cancelled'
)
AND NOT EXISTS (
  SELECT 1 FROM cabinet_application_analytics_bridges bridge
  WHERE bridge.event_id = NEW.event_id
    AND bridge.event_key = NEW.event_key
    AND bridge.event_name = NEW.event_name
    AND bridge.actor_pseudonym = NEW.actor_pseudonym
    AND bridge.source_key_hash = NEW.source_key_hash
    AND bridge.payload_hash = NEW.payload_hash
    AND bridge.occurred_at = NEW.occurred_at
    AND bridge.recorded_at = NEW.recorded_at
    AND bridge.retention_until = NEW.retention_until
)
BEGIN
  SELECT RAISE(ABORT, 'application analytics event requires exact bridge');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_analytics_apply
AFTER INSERT ON cabinet_application_analytics_bridges
BEGIN
  INSERT INTO canonical_analytics_events (
    event_id, event_key, event_name, event_version, occurred_at,
    recorded_at, origin, actor_pseudonym, pseudonym_key_version,
    source_kind, source_key_hash, payload_hash, privacy_class,
    correction_kind, correction_of_event_key_hash,
    replacement_event_key_hash, retention_until, created_at
  ) VALUES (
    NEW.event_id, NEW.event_key, NEW.event_name, 1, NEW.occurred_at,
    NEW.recorded_at, 'live', NEW.actor_pseudonym,
    NEW.pseudonym_key_version, 'lead', NEW.source_key_hash,
    NEW.payload_hash, 'pseudonymous', 'none', NULL, NULL,
    NEW.retention_until, NEW.recorded_at
  );

  INSERT INTO analytics_event_dimensions (
    event_id, dimension_name, dimension_value, created_at
  ) VALUES
    (NEW.event_id, 'role', NEW.role_dimension, NEW.recorded_at),
    (NEW.event_id, 'legal_profile', NEW.legal_profile_dimension, NEW.recorded_at),
    (NEW.event_id, 'plan', NEW.plan_code, NEW.recorded_at),
    (NEW.event_id, 'access_state', NEW.access_state, NEW.recorded_at),
    (NEW.event_id, 'source_family', NEW.source_family_dimension, NEW.recorded_at),
    (NEW.event_id, 'object_type', NEW.object_type_dimension, NEW.recorded_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_analytics_no_update
BEFORE UPDATE ON cabinet_application_analytics_bridges
BEGIN
  SELECT RAISE(ABORT, 'application analytics bridges are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_analytics_no_delete
BEFORE DELETE ON cabinet_application_analytics_bridges
BEGIN
  SELECT RAISE(ABORT, 'application analytics bridges cannot be deleted');
END;

CREATE VIEW IF NOT EXISTS cabinet_application_journey_v1 AS
SELECT
  bridge.application_id,
  bridge.result_id,
  bridge.source_lead_id,
  bridge.offer_cycle_id,
  bridge.offer_code,
  bridge.owner_partner_profile_id,
  bridge.plan_code,
  bridge.access_state,
  bridge.terminal_status,
  bridge.result_code,
  bridge.event_id,
  bridge.event_name,
  bridge.actor_pseudonym,
  bridge.occurred_at,
  bridge.recorded_at
FROM cabinet_application_analytics_bridges bridge
JOIN canonical_analytics_events event
  ON event.event_id = bridge.event_id
  AND event.event_key = bridge.event_key
  AND event.payload_hash = bridge.payload_hash;

INSERT OR IGNORE INTO re_schema_migrations(version)
VALUES ('0046-v1.4.0-access-and-e2e');
