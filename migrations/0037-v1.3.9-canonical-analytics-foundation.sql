-- RE Program Bot v1.3.9 Part 1 — canonical analytics foundation.
--
-- Additive and idempotent. Every v1.3.9 switch is fail-closed. This migration
-- does not read or mutate a legacy authority, backfill data, change the Worker
-- entrypoint, expose ambassador analytics, or enable production ingestion.

CREATE TABLE IF NOT EXISTS analytics_v2_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rollout_mode TEXT NOT NULL DEFAULT 'off'
    CHECK (rollout_mode IN ('off', 'admin_shadow')),
  master_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (master_enabled IN (0, 1)),
  ingest_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (ingest_enabled IN (0, 1)),
  projections_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (projections_enabled IN (0, 1)),
  ambassador_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (ambassador_enabled IN (0, 1)),
  event_registry_version INTEGER NOT NULL DEFAULT 1
    CHECK (event_registry_version = 1),
  metric_dictionary_version INTEGER NOT NULL DEFAULT 1
    CHECK (metric_dictionary_version = 1),
  pseudonym_key_version INTEGER NOT NULL DEFAULT 1
    CHECK (pseudonym_key_version > 0),
  raw_retention_days INTEGER NOT NULL DEFAULT 180
    CHECK (raw_retention_days BETWEEN 1 AND 180),
  small_segment_threshold INTEGER NOT NULL DEFAULT 5
    CHECK (small_segment_threshold BETWEEN 5 AND 20),
  policy_version TEXT NOT NULL DEFAULT '2026-09-13.analytics-v2-part1'
    CHECK (length(policy_version) BETWEEN 8 AND 80),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  CHECK (
    (master_enabled = 0 AND rollout_mode = 'off')
    OR (master_enabled = 1 AND rollout_mode = 'admin_shadow')
  ),
  CHECK (
    master_enabled = 1
    OR (ingest_enabled = 0 AND projections_enabled = 0
      AND ambassador_enabled = 0)
  ),
  CHECK (projections_enabled = 0 OR ingest_enabled = 1),
  CHECK (ambassador_enabled = 0 OR projections_enabled = 1)
);

INSERT OR IGNORE INTO analytics_v2_settings (
  id, rollout_mode, master_enabled, ingest_enabled, projections_enabled,
  ambassador_enabled, event_registry_version, metric_dictionary_version,
  pseudonym_key_version, raw_retention_days, small_segment_threshold,
  policy_version, revision, updated_by, updated_at
) VALUES (
  1, 'off', 0, 0, 0, 0, 1, 1, 1, 180, 5,
  '2026-09-13.analytics-v2-part1', 1, NULL, unixepoch()
);

CREATE TABLE IF NOT EXISTS analytics_event_registry (
  event_name TEXT NOT NULL CHECK (
    length(event_name) BETWEEN 3 AND 80
    AND event_name = lower(event_name)
    AND event_name NOT GLOB '*[^a-z0-9_]*'
  ),
  event_version INTEGER NOT NULL CHECK (event_version = 1),
  category TEXT NOT NULL CHECK (category IN (
    'acquisition', 'product', 'partner', 'commerce', 'ai', 'system'
  )),
  authority_source TEXT NOT NULL CHECK (authority_source IN (
    'users', 'terms', 'bot_start', 'funnel', 'partner_program',
    'partner_link', 'leads', 'stars_payment', 'stars_access',
    'referral_v1_3_7', 'ai_v1_3_8', 'analytics_v2'
  )),
  privacy_class TEXT NOT NULL CHECK (privacy_class = 'pseudonymous'),
  correction_policy TEXT NOT NULL CHECK (
    correction_policy IN ('append_correction', 'append_only')
  ),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled = 1),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (event_name, event_version)
);

INSERT OR IGNORE INTO analytics_event_registry
  (event_name, event_version, category, authority_source, privacy_class,
   correction_policy, enabled, created_at)
VALUES
  ('start_received', 1, 'acquisition', 'bot_start', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('account_created', 1, 'acquisition', 'users', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('terms_accepted', 1, 'product', 'terms', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('menu_opened', 1, 'product', 'funnel', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('offer_opened', 1, 'product', 'funnel', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('lead_submitted', 1, 'product', 'leads', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('notification_opened', 1, 'product', 'funnel', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('partner_program_opened', 1, 'partner', 'partner_program', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('partner_link_submitted', 1, 'partner', 'partner_link', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('partner_link_opened', 1, 'partner', 'partner_link', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('ambassador_profile_activated', 1, 'partner', 'partner_program', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('campaign_touch_recorded', 1, 'partner', 'partner_link', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('registration_attributed', 1, 'partner', 'partner_link', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('lead_attributed', 1, 'partner', 'leads', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('paid_access_attributed', 1, 'partner', 'stars_access', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('referral_reward_confirmed', 1, 'partner', 'referral_v1_3_7', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('payment_succeeded', 1, 'commerce', 'stars_payment', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('access_activated', 1, 'commerce', 'stars_access', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('access_expired', 1, 'commerce', 'stars_access', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('payment_refunded', 1, 'commerce', 'stars_payment', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('ai_opened', 1, 'ai', 'ai_v1_3_8', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('ai_consent_accepted', 1, 'ai', 'ai_v1_3_8', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('ai_generation_succeeded', 1, 'ai', 'ai_v1_3_8', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('ai_generation_failed', 1, 'ai', 'ai_v1_3_8', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('ai_limit_hit', 1, 'ai', 'ai_v1_3_8', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('ai_draft_shared', 1, 'ai', 'ai_v1_3_8', 'pseudonymous', 'append_correction', 1, unixepoch()),
  ('analytics_event_corrected', 1, 'system', 'analytics_v2', 'pseudonymous', 'append_only', 1, unixepoch());

CREATE TABLE IF NOT EXISTS analytics_dimension_registry (
  dimension_name TEXT NOT NULL CHECK (dimension_name IN (
    'role', 'legal_profile', 'plan', 'access_state', 'source_family',
    'object_type'
  )),
  dimension_value TEXT NOT NULL CHECK (
    length(dimension_value) BETWEEN 2 AND 48
    AND dimension_value = lower(dimension_value)
    AND dimension_value NOT GLOB '*[^a-z0-9_]*'
  ),
  privacy_class TEXT NOT NULL CHECK (privacy_class = 'non_identifying'),
  suppression_required INTEGER NOT NULL DEFAULT 0
    CHECK (suppression_required IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled = 1),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (dimension_name, dimension_value)
);

INSERT OR IGNORE INTO analytics_dimension_registry
  (dimension_name, dimension_value, privacy_class, suppression_required,
   enabled, created_at)
VALUES
  ('role', 'user', 'non_identifying', 0, 1, unixepoch()),
  ('role', 'partner', 'non_identifying', 0, 1, unixepoch()),
  ('role', 'admin', 'non_identifying', 0, 1, unixepoch()),
  ('legal_profile', 'individual', 'non_identifying', 1, 1, unixepoch()),
  ('legal_profile', 'self_employed', 'non_identifying', 1, 1, unixepoch()),
  ('legal_profile', 'individual_entrepreneur', 'non_identifying', 1, 1, unixepoch()),
  ('legal_profile', 'unknown', 'non_identifying', 1, 1, unixepoch()),
  ('plan', 'free', 'non_identifying', 0, 1, unixepoch()),
  ('plan', 'professional', 'non_identifying', 0, 1, unixepoch()),
  ('plan', 'dragon', 'non_identifying', 0, 1, unixepoch()),
  ('plan', 'unknown', 'non_identifying', 0, 1, unixepoch()),
  ('access_state', 'none', 'non_identifying', 0, 1, unixepoch()),
  ('access_state', 'trial', 'non_identifying', 0, 1, unixepoch()),
  ('access_state', 'active', 'non_identifying', 0, 1, unixepoch()),
  ('access_state', 'cancel_at_period_end', 'non_identifying', 0, 1, unixepoch()),
  ('access_state', 'expired', 'non_identifying', 0, 1, unixepoch()),
  ('access_state', 'refunded', 'non_identifying', 0, 1, unixepoch()),
  ('access_state', 'suspended', 'non_identifying', 0, 1, unixepoch()),
  ('access_state', 'unknown', 'non_identifying', 0, 1, unixepoch()),
  ('source_family', 'direct', 'non_identifying', 0, 1, unixepoch()),
  ('source_family', 'referral', 'non_identifying', 0, 1, unixepoch()),
  ('source_family', 'partner_link', 'non_identifying', 0, 1, unixepoch()),
  ('source_family', 'campaign', 'non_identifying', 0, 1, unixepoch()),
  ('source_family', 'telegram', 'non_identifying', 0, 1, unixepoch()),
  ('source_family', 'admin', 'non_identifying', 0, 1, unixepoch()),
  ('source_family', 'system', 'non_identifying', 0, 1, unixepoch()),
  ('source_family', 'backfill', 'non_identifying', 0, 1, unixepoch()),
  ('object_type', 'bot_start', 'non_identifying', 0, 1, unixepoch()),
  ('object_type', 'account', 'non_identifying', 0, 1, unixepoch()),
  ('object_type', 'terms', 'non_identifying', 0, 1, unixepoch()),
  ('object_type', 'menu', 'non_identifying', 0, 1, unixepoch()),
  ('object_type', 'offer', 'non_identifying', 0, 1, unixepoch()),
  ('object_type', 'lead', 'non_identifying', 0, 1, unixepoch()),
  ('object_type', 'notification', 'non_identifying', 0, 1, unixepoch()),
  ('object_type', 'partner_program', 'non_identifying', 0, 1, unixepoch()),
  ('object_type', 'partner_link', 'non_identifying', 0, 1, unixepoch()),
  ('object_type', 'ambassador_profile', 'non_identifying', 1, 1, unixepoch()),
  ('object_type', 'campaign_touch', 'non_identifying', 1, 1, unixepoch()),
  ('object_type', 'registration', 'non_identifying', 1, 1, unixepoch()),
  ('object_type', 'paid_access', 'non_identifying', 1, 1, unixepoch()),
  ('object_type', 'referral_reward', 'non_identifying', 1, 1, unixepoch()),
  ('object_type', 'payment', 'non_identifying', 1, 1, unixepoch()),
  ('object_type', 'subscription_access', 'non_identifying', 1, 1, unixepoch()),
  ('object_type', 'ai_session', 'non_identifying', 1, 1, unixepoch()),
  ('object_type', 'ai_draft', 'non_identifying', 1, 1, unixepoch()),
  ('object_type', 'analytics_event', 'non_identifying', 1, 1, unixepoch());

CREATE TABLE IF NOT EXISTS canonical_analytics_events (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) = 36 AND event_id = lower(event_id)
  ),
  event_key TEXT NOT NULL UNIQUE CHECK (
    length(event_key) = 68
    AND substr(event_key, 1, 4) = 'evt_'
    AND substr(event_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  event_name TEXT NOT NULL,
  event_version INTEGER NOT NULL CHECK (event_version = 1),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= occurred_at),
  origin TEXT NOT NULL CHECK (origin IN (
    'live', 'backfill', 'reconciliation', 'system'
  )),
  actor_pseudonym TEXT NOT NULL CHECK (
    length(actor_pseudonym) = 64
    AND actor_pseudonym = lower(actor_pseudonym)
    AND actor_pseudonym NOT GLOB '*[^0-9a-f]*'
  ),
  pseudonym_key_version INTEGER NOT NULL CHECK (pseudonym_key_version > 0),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'users', 'terms', 'bot_start', 'legacy_funnel', 'partner_program',
    'partner_link', 'lead', 'stars_payment', 'stars_access',
    'referral_reward', 'ai_partner', 'analytics_system'
  )),
  source_key_hash TEXT NOT NULL CHECK (
    length(source_key_hash) = 64
    AND source_key_hash = lower(source_key_hash)
    AND source_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64
    AND payload_hash = lower(payload_hash)
    AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  privacy_class TEXT NOT NULL CHECK (privacy_class = 'pseudonymous'),
  correction_kind TEXT NOT NULL DEFAULT 'none'
    CHECK (correction_kind IN ('none', 'retract', 'replace')),
  correction_of_event_key_hash TEXT CHECK (
    correction_of_event_key_hash IS NULL
    OR (
      length(correction_of_event_key_hash) = 64
      AND correction_of_event_key_hash = lower(correction_of_event_key_hash)
      AND correction_of_event_key_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  replacement_event_key_hash TEXT CHECK (
    replacement_event_key_hash IS NULL
    OR (
      length(replacement_event_key_hash) = 64
      AND replacement_event_key_hash = lower(replacement_event_key_hash)
      AND replacement_event_key_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= recorded_at
    AND retention_until <= recorded_at + 15552000
  ),
  created_at INTEGER NOT NULL CHECK (created_at = recorded_at),
  FOREIGN KEY (event_name, event_version)
    REFERENCES analytics_event_registry(event_name, event_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (event_name != 'analytics_event_corrected'
      AND correction_kind = 'none'
      AND correction_of_event_key_hash IS NULL
      AND replacement_event_key_hash IS NULL)
    OR
    (event_name = 'analytics_event_corrected'
      AND correction_kind = 'retract'
      AND correction_of_event_key_hash IS NOT NULL
      AND replacement_event_key_hash IS NULL)
    OR
    (event_name = 'analytics_event_corrected'
      AND correction_kind = 'replace'
      AND correction_of_event_key_hash IS NOT NULL
      AND replacement_event_key_hash IS NOT NULL
      AND replacement_event_key_hash != correction_of_event_key_hash)
  )
);

CREATE INDEX IF NOT EXISTS idx_canonical_analytics_events_time
  ON canonical_analytics_events(occurred_at, event_name, event_id);

CREATE INDEX IF NOT EXISTS idx_canonical_analytics_events_actor_time
  ON canonical_analytics_events(actor_pseudonym, occurred_at, event_id);

CREATE INDEX IF NOT EXISTS idx_canonical_analytics_events_source
  ON canonical_analytics_events(source_kind, source_key_hash, event_id);

CREATE INDEX IF NOT EXISTS idx_canonical_analytics_events_retention
  ON canonical_analytics_events(retention_until, event_id);

CREATE INDEX IF NOT EXISTS idx_canonical_analytics_corrections
  ON canonical_analytics_events(correction_of_event_key_hash, occurred_at)
  WHERE correction_of_event_key_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS analytics_event_dimensions (
  event_id TEXT NOT NULL REFERENCES canonical_analytics_events(event_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  dimension_name TEXT NOT NULL,
  dimension_value TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (event_id, dimension_name),
  FOREIGN KEY (dimension_name, dimension_value)
    REFERENCES analytics_dimension_registry(dimension_name, dimension_value)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_analytics_event_dimensions_lookup
  ON analytics_event_dimensions(
    dimension_name, dimension_value, event_id
  );

CREATE TABLE IF NOT EXISTS analytics_ingestion_conflicts (
  conflict_id TEXT PRIMARY KEY CHECK (
    length(conflict_id) = 36 AND conflict_id = lower(conflict_id)
  ),
  conflict_key TEXT NOT NULL UNIQUE CHECK (
    length(conflict_key) = 73
    AND substr(conflict_key, 1, 9) = 'conflict_'
    AND substr(conflict_key, 10) NOT GLOB '*[^0-9a-f]*'
  ),
  event_key_hash TEXT NOT NULL CHECK (
    length(event_key_hash) = 64
    AND event_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  existing_payload_hash TEXT NOT NULL CHECK (
    length(existing_payload_hash) = 64
    AND existing_payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  observed_payload_hash TEXT NOT NULL CHECK (
    length(observed_payload_hash) = 64
    AND observed_payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'hash_mismatch', 'registry_mismatch', 'dimension_mismatch',
    'idempotency_race'
  )),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'users', 'terms', 'bot_start', 'legacy_funnel', 'partner_program',
    'partner_link', 'lead', 'stars_payment', 'stars_access',
    'referral_reward', 'ai_partner', 'analytics_system'
  )),
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count = 1),
  detected_at INTEGER NOT NULL CHECK (detected_at > 0),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= detected_at
    AND retention_until <= detected_at + 15552000
  ),
  CHECK (existing_payload_hash != observed_payload_hash)
);

CREATE INDEX IF NOT EXISTS idx_analytics_ingestion_conflicts_time
  ON analytics_ingestion_conflicts(detected_at, reason_code, conflict_id);

CREATE INDEX IF NOT EXISTS idx_analytics_ingestion_conflicts_retention
  ON analytics_ingestion_conflicts(retention_until, conflict_id);

CREATE TABLE IF NOT EXISTS analytics_source_checkpoints (
  source_kind TEXT PRIMARY KEY CHECK (source_kind IN (
    'users', 'terms', 'bot_start', 'legacy_funnel', 'partner_program',
    'partner_link', 'lead', 'stars_payment', 'stars_access',
    'referral_reward', 'ai_partner'
  )),
  status TEXT NOT NULL DEFAULT 'off' CHECK (status IN (
    'off', 'ready', 'running', 'paused', 'complete', 'failed'
  )),
  cursor_hash TEXT NOT NULL DEFAULT '' CHECK (
    cursor_hash = ''
    OR (
      length(cursor_hash) = 64
      AND cursor_hash = lower(cursor_hash)
      AND cursor_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  high_watermark_at INTEGER NOT NULL DEFAULT 0 CHECK (high_watermark_at >= 0),
  rows_seen INTEGER NOT NULL DEFAULT 0 CHECK (rows_seen >= 0),
  rows_inserted INTEGER NOT NULL DEFAULT 0 CHECK (
    rows_inserted >= 0 AND rows_inserted <= rows_seen
  ),
  rows_duplicate INTEGER NOT NULL DEFAULT 0 CHECK (
    rows_duplicate >= 0 AND rows_duplicate <= rows_seen
  ),
  rows_conflict INTEGER NOT NULL DEFAULT 0 CHECK (
    rows_conflict >= 0 AND rows_conflict <= rows_seen
  ),
  last_error_code TEXT NOT NULL DEFAULT '' CHECK (length(last_error_code) <= 80),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (status = 'off' AND cursor_hash = '' AND high_watermark_at = 0
      AND rows_seen = 0 AND rows_inserted = 0
      AND rows_duplicate = 0 AND rows_conflict = 0
      AND last_error_code = '')
    OR status != 'off'
  ),
  CHECK (
    (status = 'failed' AND length(last_error_code) BETWEEN 3 AND 80)
    OR (status != 'failed' AND last_error_code = '')
  )
);

INSERT OR IGNORE INTO analytics_source_checkpoints
  (source_kind, status, cursor_hash, high_watermark_at, rows_seen,
   rows_inserted, rows_duplicate, rows_conflict, last_error_code,
   revision, created_at, updated_at)
VALUES
  ('users', 'off', '', 0, 0, 0, 0, 0, '', 1, unixepoch(), unixepoch()),
  ('terms', 'off', '', 0, 0, 0, 0, 0, '', 1, unixepoch(), unixepoch()),
  ('bot_start', 'off', '', 0, 0, 0, 0, 0, '', 1, unixepoch(), unixepoch()),
  ('legacy_funnel', 'off', '', 0, 0, 0, 0, 0, '', 1, unixepoch(), unixepoch()),
  ('partner_program', 'off', '', 0, 0, 0, 0, 0, '', 1, unixepoch(), unixepoch()),
  ('partner_link', 'off', '', 0, 0, 0, 0, 0, '', 1, unixepoch(), unixepoch()),
  ('lead', 'off', '', 0, 0, 0, 0, 0, '', 1, unixepoch(), unixepoch()),
  ('stars_payment', 'off', '', 0, 0, 0, 0, 0, '', 1, unixepoch(), unixepoch()),
  ('stars_access', 'off', '', 0, 0, 0, 0, 0, '', 1, unixepoch(), unixepoch()),
  ('referral_reward', 'off', '', 0, 0, 0, 0, 0, '', 1, unixepoch(), unixepoch()),
  ('ai_partner', 'off', '', 0, 0, 0, 0, 0, '', 1, unixepoch(), unixepoch());

CREATE TABLE IF NOT EXISTS analytics_privacy_maintenance_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  reason TEXT NOT NULL CHECK (reason IN ('retention', 'user_deletion')),
  subject_pseudonym TEXT NOT NULL DEFAULT '' CHECK (
    subject_pseudonym = ''
    OR (
      length(subject_pseudonym) = 64
      AND subject_pseudonym = lower(subject_pseudonym)
      AND subject_pseudonym NOT GLOB '*[^0-9a-f]*'
    )
  ),
  token_hash TEXT NOT NULL CHECK (
    length(token_hash) = 64
    AND token_hash = lower(token_hash)
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_by_kind TEXT NOT NULL CHECK (
    created_by_kind IN ('system', 'admin')
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  expires_at INTEGER NOT NULL CHECK (
    expires_at >= created_at AND expires_at <= created_at + 900
  ),
  CHECK (
    (reason = 'retention' AND subject_pseudonym = '')
    OR (reason = 'user_deletion' AND length(subject_pseudonym) = 64)
  )
);

CREATE TABLE IF NOT EXISTS analytics_privacy_inventory (
  dataset_name TEXT PRIMARY KEY CHECK (dataset_name IN (
    'canonical_analytics_events', 'analytics_event_dimensions',
    'analytics_ingestion_conflicts', 'analytics_source_checkpoints'
  )),
  privacy_class TEXT NOT NULL CHECK (privacy_class IN (
    'pseudonymous', 'non_identifying', 'anonymous', 'operational'
  )),
  raw_identifier_columns INTEGER NOT NULL DEFAULT 0
    CHECK (raw_identifier_columns = 0),
  content_columns INTEGER NOT NULL DEFAULT 0 CHECK (content_columns = 0),
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 0 AND 180),
  deletion_mode TEXT NOT NULL CHECK (deletion_mode IN (
    'guarded_subject_or_retention', 'cascade_with_event',
    'guarded_retention', 'operational_replace'
  )),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 8 AND 80),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

INSERT OR IGNORE INTO analytics_privacy_inventory
  (dataset_name, privacy_class, raw_identifier_columns, content_columns,
   retention_days, deletion_mode, policy_version, created_at)
VALUES
  ('canonical_analytics_events', 'pseudonymous', 0, 0, 180,
   'guarded_subject_or_retention', '2026-09-13.analytics-v2-part1', unixepoch()),
  ('analytics_event_dimensions', 'non_identifying', 0, 0, 180,
   'cascade_with_event', '2026-09-13.analytics-v2-part1', unixepoch()),
  ('analytics_ingestion_conflicts', 'anonymous', 0, 0, 180,
   'guarded_retention', '2026-09-13.analytics-v2-part1', unixepoch()),
  ('analytics_source_checkpoints', 'operational', 0, 0, 0,
   'operational_replace', '2026-09-13.analytics-v2-part1', unixepoch());

CREATE TRIGGER IF NOT EXISTS trg_analytics_v2_settings_identity
BEFORE UPDATE ON analytics_v2_settings
WHEN NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT, 'analytics settings identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_v2_settings_revision
BEFORE UPDATE ON analytics_v2_settings
WHEN NEW.revision != OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'analytics settings revision must advance exactly once');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_v2_settings_no_delete
BEFORE DELETE ON analytics_v2_settings
BEGIN
  SELECT RAISE(ABORT, 'analytics settings cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_event_registry_append_only_update
BEFORE UPDATE ON analytics_event_registry
BEGIN
  SELECT RAISE(ABORT, 'analytics event registry is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_event_registry_append_only_delete
BEFORE DELETE ON analytics_event_registry
BEGIN
  SELECT RAISE(ABORT, 'analytics event registry cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_dimension_registry_append_only_update
BEFORE UPDATE ON analytics_dimension_registry
BEGIN
  SELECT RAISE(ABORT, 'analytics dimension registry is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_dimension_registry_append_only_delete
BEFORE DELETE ON analytics_dimension_registry
BEGIN
  SELECT RAISE(ABORT, 'analytics dimension registry cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_canonical_analytics_event_registry_guard
BEFORE INSERT ON canonical_analytics_events
WHEN NOT EXISTS (
  SELECT 1
  FROM analytics_event_registry registry
  WHERE registry.event_name = NEW.event_name
    AND registry.event_version = NEW.event_version
    AND registry.enabled = 1
    AND registry.privacy_class = NEW.privacy_class
)
BEGIN
  SELECT RAISE(ABORT, 'analytics event registry mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_canonical_analytics_events_no_update
BEFORE UPDATE ON canonical_analytics_events
BEGIN
  SELECT RAISE(ABORT, 'canonical analytics events require correction events');
END;

CREATE TRIGGER IF NOT EXISTS trg_canonical_analytics_events_guarded_delete
BEFORE DELETE ON canonical_analytics_events
WHEN NOT EXISTS (
  SELECT 1
  FROM analytics_privacy_maintenance_guard guard
  WHERE guard.id = 1
    AND guard.expires_at >= unixepoch()
    AND (
      (guard.reason = 'retention' AND OLD.retention_until <= unixepoch())
      OR
      (guard.reason = 'user_deletion'
        AND guard.subject_pseudonym = OLD.actor_pseudonym)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'canonical analytics deletion requires privacy guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_event_dimensions_no_update
BEFORE UPDATE ON analytics_event_dimensions
BEGIN
  SELECT RAISE(ABORT, 'analytics event dimensions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_event_dimensions_guarded_delete
BEFORE DELETE ON analytics_event_dimensions
WHEN EXISTS (
  SELECT 1 FROM canonical_analytics_events event
  WHERE event.event_id = OLD.event_id
)
AND NOT EXISTS (
  SELECT 1
  FROM canonical_analytics_events event
  JOIN analytics_privacy_maintenance_guard guard ON guard.id = 1
  WHERE event.event_id = OLD.event_id
    AND guard.expires_at >= unixepoch()
    AND (
      (guard.reason = 'retention' AND event.retention_until <= unixepoch())
      OR
      (guard.reason = 'user_deletion'
        AND guard.subject_pseudonym = event.actor_pseudonym)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'analytics dimension deletion requires privacy guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_ingestion_conflicts_no_update
BEFORE UPDATE ON analytics_ingestion_conflicts
BEGIN
  SELECT RAISE(ABORT, 'analytics ingestion conflicts are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_ingestion_conflicts_guarded_delete
BEFORE DELETE ON analytics_ingestion_conflicts
WHEN NOT EXISTS (
  SELECT 1
  FROM analytics_privacy_maintenance_guard guard
  WHERE guard.id = 1
    AND guard.reason = 'retention'
    AND guard.expires_at >= unixepoch()
    AND OLD.retention_until <= unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'analytics conflict deletion requires retention guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_source_checkpoints_identity
BEFORE UPDATE ON analytics_source_checkpoints
WHEN NEW.source_kind IS NOT OLD.source_kind
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'analytics checkpoint identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_source_checkpoints_revision
BEFORE UPDATE ON analytics_source_checkpoints
WHEN NEW.revision != OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'analytics checkpoint revision must advance exactly once');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_source_checkpoints_monotonic
BEFORE UPDATE ON analytics_source_checkpoints
WHEN NEW.high_watermark_at < OLD.high_watermark_at
  OR NEW.rows_seen < OLD.rows_seen
  OR NEW.rows_inserted < OLD.rows_inserted
  OR NEW.rows_duplicate < OLD.rows_duplicate
  OR NEW.rows_conflict < OLD.rows_conflict
BEGIN
  SELECT RAISE(ABORT, 'analytics checkpoint counters are monotonic');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_source_checkpoints_no_delete
BEFORE DELETE ON analytics_source_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'analytics checkpoints cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_privacy_guard_no_update
BEFORE UPDATE ON analytics_privacy_maintenance_guard
BEGIN
  SELECT RAISE(ABORT, 'analytics privacy guard must be replaced, not updated');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_privacy_inventory_no_update
BEFORE UPDATE ON analytics_privacy_inventory
BEGIN
  SELECT RAISE(ABORT, 'analytics privacy inventory is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_privacy_inventory_no_delete
BEFORE DELETE ON analytics_privacy_inventory
BEGIN
  SELECT RAISE(ABORT, 'analytics privacy inventory cannot be deleted');
END;
