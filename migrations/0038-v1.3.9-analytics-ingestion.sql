-- RE Program Bot v1.3.9 Part 2 — bounded analytics ingestion evidence.
--
-- Additive and idempotent. This migration does not read or mutate legacy
-- authority tables, does not enable analytics, and does not wire production.
-- Unknown source values are represented only by hashes and allowlisted reason
-- codes; raw source rows, Telegram IDs and content are never persisted here.

CREATE TABLE IF NOT EXISTS analytics_legacy_funnel_map (
  legacy_event_name TEXT PRIMARY KEY CHECK (
    length(legacy_event_name) BETWEEN 3 AND 64
    AND legacy_event_name = lower(legacy_event_name)
    AND legacy_event_name NOT GLOB '*[^a-z0-9_]*'
  ),
  disposition TEXT NOT NULL CHECK (disposition IN (
    'mapped', 'excluded', 'unmapped', 'ambiguous'
  )),
  canonical_event_name TEXT,
  canonical_event_version INTEGER,
  object_dimension_name TEXT NOT NULL DEFAULT 'object_type'
    CHECK (object_dimension_name = 'object_type'),
  object_type TEXT,
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'mapped_exact', 'authoritative_source_elsewhere',
    'not_in_v1_registry', 'semantics_not_exact'
  )),
  mapping_version INTEGER NOT NULL DEFAULT 1 CHECK (mapping_version = 1),
  policy_version TEXT NOT NULL CHECK (
    policy_version = '2026-09-13.analytics-v2-part2'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  FOREIGN KEY (canonical_event_name, canonical_event_version)
    REFERENCES analytics_event_registry(event_name, event_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (object_dimension_name, object_type)
    REFERENCES analytics_dimension_registry(dimension_name, dimension_value)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (disposition = 'mapped'
      AND canonical_event_name IS NOT NULL
      AND canonical_event_version = 1
      AND object_type IS NOT NULL
      AND reason_code = 'mapped_exact')
    OR
    (disposition != 'mapped'
      AND canonical_event_name IS NULL
      AND canonical_event_version IS NULL
      AND object_type IS NULL
      AND reason_code != 'mapped_exact')
  )
);

INSERT OR IGNORE INTO analytics_legacy_funnel_map
  (legacy_event_name, disposition, canonical_event_name,
   canonical_event_version, object_type, reason_code, mapping_version,
   policy_version, created_at)
VALUES
  ('start', 'excluded', NULL, NULL, NULL,
   'authoritative_source_elsewhere', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('welcome_opened', 'unmapped', NULL, NULL, NULL,
   'not_in_v1_registry', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('terms_accepted', 'excluded', NULL, NULL, NULL,
   'authoritative_source_elsewhere', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('menu_opened', 'mapped', 'menu_opened', 1, 'menu',
   'mapped_exact', 1, '2026-09-13.analytics-v2-part2', unixepoch()),
  ('offers_opened', 'ambiguous', NULL, NULL, NULL,
   'semantics_not_exact', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('offer_opened', 'mapped', 'offer_opened', 1, 'offer',
   'mapped_exact', 1, '2026-09-13.analytics-v2-part2', unixepoch()),
  ('lead_submitted', 'excluded', NULL, NULL, NULL,
   'authoritative_source_elsewhere', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('partner_applied', 'unmapped', NULL, NULL, NULL,
   'not_in_v1_registry', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('partner_programs_opened', 'ambiguous', NULL, NULL, NULL,
   'semantics_not_exact', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('partner_program_opened', 'excluded', NULL, NULL, NULL,
   'authoritative_source_elsewhere', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('partner_link_submitted', 'excluded', NULL, NULL, NULL,
   'authoritative_source_elsewhere', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('partner_beta_opened', 'unmapped', NULL, NULL, NULL,
   'not_in_v1_registry', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('partner_offer_created', 'unmapped', NULL, NULL, NULL,
   'not_in_v1_registry', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('partner_offer_submitted', 'unmapped', NULL, NULL, NULL,
   'not_in_v1_registry', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('notifications_opened', 'mapped', 'notification_opened', 1,
   'notification', 'mapped_exact', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('stats_opened', 'unmapped', NULL, NULL, NULL,
   'not_in_v1_registry', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('channel_prompt_opened', 'unmapped', NULL, NULL, NULL,
   'not_in_v1_registry', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('ai_opened', 'excluded', NULL, NULL, NULL,
   'authoritative_source_elsewhere', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('ai_enabled', 'unmapped', NULL, NULL, NULL,
   'not_in_v1_registry', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('ai_disabled', 'unmapped', NULL, NULL, NULL,
   'not_in_v1_registry', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('ai_consent_accepted', 'excluded', NULL, NULL, NULL,
   'authoritative_source_elsewhere', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('ai_answered', 'excluded', NULL, NULL, NULL,
   'authoritative_source_elsewhere', 1,
   '2026-09-13.analytics-v2-part2', unixepoch()),
  ('ai_limit_hit', 'excluded', NULL, NULL, NULL,
   'authoritative_source_elsewhere', 1,
   '2026-09-13.analytics-v2-part2', unixepoch());

CREATE TABLE IF NOT EXISTS analytics_ingestion_issues (
  issue_id TEXT PRIMARY KEY CHECK (
    length(issue_id) = 36 AND issue_id = lower(issue_id)
  ),
  issue_key TEXT NOT NULL UNIQUE CHECK (
    length(issue_key) = 70
    AND substr(issue_key, 1, 6) = 'issue_'
    AND substr(issue_key, 7) NOT GLOB '*[^0-9a-f]*'
  ),
  classification TEXT NOT NULL CHECK (classification IN (
    'unmapped', 'invalid', 'ambiguous', 'excluded'
  )),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'unknown_legacy_event', 'not_in_v1_registry',
    'semantics_not_exact', 'authoritative_source_elsewhere',
    'record_shape_invalid', 'authority_time_invalid',
    'high_watermark_exceeded', 'event_contract_invalid',
    'source_kind_invalid'
  )),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'users', 'terms', 'bot_start', 'legacy_funnel', 'partner_program',
    'partner_link', 'lead', 'stars_payment', 'stars_access',
    'referral_reward', 'ai_partner'
  )),
  source_key_hash TEXT CHECK (
    source_key_hash IS NULL
    OR (
      length(source_key_hash) = 64
      AND source_key_hash = lower(source_key_hash)
      AND source_key_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  observation_hash TEXT NOT NULL CHECK (
    length(observation_hash) = 64
    AND observation_hash = lower(observation_hash)
    AND observation_hash NOT GLOB '*[^0-9a-f]*'
  ),
  origin TEXT NOT NULL CHECK (origin IN (
    'live', 'backfill', 'reconciliation'
  )),
  detected_at INTEGER NOT NULL CHECK (detected_at > 0),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= detected_at
    AND retention_until <= detected_at + 15552000
  )
);

CREATE INDEX IF NOT EXISTS idx_analytics_ingestion_issues_class_time
  ON analytics_ingestion_issues(
    classification, reason_code, detected_at, issue_id
  );

CREATE INDEX IF NOT EXISTS idx_analytics_ingestion_issues_source
  ON analytics_ingestion_issues(source_kind, source_key_hash, issue_id);

CREATE INDEX IF NOT EXISTS idx_analytics_ingestion_issues_retention
  ON analytics_ingestion_issues(retention_until, issue_id);

CREATE TABLE IF NOT EXISTS analytics_ingestion_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(receipt_id) = 36 AND receipt_id = lower(receipt_id)
  ),
  batch_fingerprint TEXT NOT NULL CHECK (
    length(batch_fingerprint) = 64
    AND batch_fingerprint = lower(batch_fingerprint)
    AND batch_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'users', 'terms', 'bot_start', 'legacy_funnel', 'partner_program',
    'partner_link', 'lead', 'stars_payment', 'stars_access',
    'referral_reward', 'ai_partner'
  )),
  origin TEXT NOT NULL CHECK (origin IN (
    'live', 'backfill', 'reconciliation'
  )),
  high_watermark_at INTEGER NOT NULL CHECK (high_watermark_at > 0),
  cursor_hash TEXT NOT NULL CHECK (
    length(cursor_hash) = 64
    AND cursor_hash = lower(cursor_hash)
    AND cursor_hash NOT GLOB '*[^0-9a-f]*'
  ),
  checkpoint_revision INTEGER NOT NULL CHECK (checkpoint_revision >= 2),
  checkpoint_rows_seen INTEGER NOT NULL CHECK (checkpoint_rows_seen >= 0),
  checkpoint_rows_inserted INTEGER NOT NULL
    CHECK (checkpoint_rows_inserted >= 0),
  checkpoint_rows_duplicate INTEGER NOT NULL
    CHECK (checkpoint_rows_duplicate >= 0),
  checkpoint_rows_conflict INTEGER NOT NULL
    CHECK (checkpoint_rows_conflict >= 0),
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 1 AND 2),
  max_rows INTEGER NOT NULL CHECK (max_rows BETWEEN 1 AND 100),
  rows_seen INTEGER NOT NULL CHECK (
    rows_seen BETWEEN 0 AND max_rows
  ),
  rows_inserted INTEGER NOT NULL CHECK (rows_inserted >= 0),
  rows_duplicate INTEGER NOT NULL CHECK (rows_duplicate >= 0),
  rows_conflict INTEGER NOT NULL CHECK (rows_conflict >= 0),
  rows_unmapped INTEGER NOT NULL CHECK (rows_unmapped >= 0),
  rows_invalid INTEGER NOT NULL CHECK (rows_invalid >= 0),
  rows_ambiguous INTEGER NOT NULL CHECK (rows_ambiguous >= 0),
  rows_excluded INTEGER NOT NULL CHECK (rows_excluded >= 0),
  input_digest TEXT NOT NULL CHECK (
    length(input_digest) = 64
    AND input_digest = lower(input_digest)
    AND input_digest NOT GLOB '*[^0-9a-f]*'
  ),
  result_digest TEXT NOT NULL CHECK (
    length(result_digest) = 64
    AND result_digest = lower(result_digest)
    AND result_digest NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('complete', 'partial')),
  started_at INTEGER NOT NULL CHECK (started_at > 0),
  finished_at INTEGER NOT NULL CHECK (finished_at >= started_at),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= finished_at
    AND retention_until <= finished_at + 15552000
  ),
  CHECK (
    rows_seen = rows_inserted + rows_duplicate + rows_conflict
      + rows_unmapped + rows_invalid + rows_ambiguous + rows_excluded
  ),
  CHECK (
    (status = 'complete'
      AND rows_conflict = 0
      AND rows_unmapped = 0
      AND rows_invalid = 0
      AND rows_ambiguous = 0)
    OR status = 'partial'
  )
);

CREATE INDEX IF NOT EXISTS idx_analytics_ingestion_receipts_source_time
  ON analytics_ingestion_receipts(
    source_kind, high_watermark_at, finished_at, receipt_id
  );

CREATE INDEX IF NOT EXISTS idx_analytics_ingestion_receipts_batch
  ON analytics_ingestion_receipts(batch_fingerprint, finished_at, receipt_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_ingestion_receipts_checkpoint
  ON analytics_ingestion_receipts(source_kind, checkpoint_revision);

CREATE INDEX IF NOT EXISTS idx_analytics_ingestion_receipts_retention
  ON analytics_ingestion_receipts(retention_until, receipt_id);

CREATE TABLE IF NOT EXISTS analytics_privacy_inventory_extensions (
  dataset_name TEXT PRIMARY KEY CHECK (dataset_name IN (
    'analytics_legacy_funnel_map', 'analytics_ingestion_issues',
    'analytics_ingestion_receipts'
  )),
  privacy_class TEXT NOT NULL CHECK (privacy_class IN (
    'non_identifying', 'anonymous', 'operational'
  )),
  raw_identifier_columns INTEGER NOT NULL DEFAULT 0
    CHECK (raw_identifier_columns = 0),
  content_columns INTEGER NOT NULL DEFAULT 0 CHECK (content_columns = 0),
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 0 AND 180),
  deletion_mode TEXT NOT NULL CHECK (deletion_mode IN (
    'immutable_contract', 'guarded_retention'
  )),
  policy_version TEXT NOT NULL CHECK (
    policy_version = '2026-09-13.analytics-v2-part2'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

INSERT OR IGNORE INTO analytics_privacy_inventory_extensions
  (dataset_name, privacy_class, raw_identifier_columns, content_columns,
   retention_days, deletion_mode, policy_version, created_at)
VALUES
  ('analytics_legacy_funnel_map', 'non_identifying', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part2', unixepoch()),
  ('analytics_ingestion_issues', 'anonymous', 0, 0, 180,
   'guarded_retention', '2026-09-13.analytics-v2-part2', unixepoch()),
  ('analytics_ingestion_receipts', 'operational', 0, 0, 180,
   'guarded_retention', '2026-09-13.analytics-v2-part2', unixepoch());

CREATE TRIGGER IF NOT EXISTS trg_analytics_legacy_funnel_map_no_update
BEFORE UPDATE ON analytics_legacy_funnel_map
BEGIN
  SELECT RAISE(ABORT, 'analytics funnel mapping is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_legacy_funnel_map_no_delete
BEFORE DELETE ON analytics_legacy_funnel_map
BEGIN
  SELECT RAISE(ABORT, 'analytics funnel mapping cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_ingestion_issues_no_update
BEFORE UPDATE ON analytics_ingestion_issues
BEGIN
  SELECT RAISE(ABORT, 'analytics ingestion issues are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_ingestion_issues_guarded_delete
BEFORE DELETE ON analytics_ingestion_issues
WHEN NOT EXISTS (
  SELECT 1
  FROM analytics_privacy_maintenance_guard guard
  WHERE guard.id = 1
    AND guard.reason = 'retention'
    AND guard.expires_at >= unixepoch()
    AND OLD.retention_until <= unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'analytics issue deletion requires retention guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_ingestion_receipts_no_update
BEFORE UPDATE ON analytics_ingestion_receipts
BEGIN
  SELECT RAISE(ABORT, 'analytics ingestion receipts are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_ingestion_receipts_checkpoint_guard
BEFORE INSERT ON analytics_ingestion_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM analytics_source_checkpoints checkpoint
  WHERE checkpoint.source_kind = NEW.source_kind
    AND checkpoint.revision = NEW.checkpoint_revision
    AND checkpoint.cursor_hash = NEW.cursor_hash
    AND checkpoint.high_watermark_at = NEW.high_watermark_at
    AND checkpoint.rows_seen = NEW.checkpoint_rows_seen
    AND checkpoint.rows_inserted = NEW.checkpoint_rows_inserted
    AND checkpoint.rows_duplicate = NEW.checkpoint_rows_duplicate
    AND checkpoint.rows_conflict = NEW.checkpoint_rows_conflict
)
BEGIN
  SELECT RAISE(ABORT, 'analytics receipt requires exact checkpoint advance');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_ingestion_receipts_guarded_delete
BEFORE DELETE ON analytics_ingestion_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM analytics_privacy_maintenance_guard guard
  WHERE guard.id = 1
    AND guard.reason = 'retention'
    AND guard.expires_at >= unixepoch()
    AND OLD.retention_until <= unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'analytics receipt deletion requires retention guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_privacy_extensions_no_update
BEFORE UPDATE ON analytics_privacy_inventory_extensions
BEGIN
  SELECT RAISE(ABORT, 'analytics privacy extensions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_privacy_extensions_no_delete
BEFORE DELETE ON analytics_privacy_inventory_extensions
BEGIN
  SELECT RAISE(ABORT, 'analytics privacy extensions cannot be deleted');
END;

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.9-analytics-ingestion');
