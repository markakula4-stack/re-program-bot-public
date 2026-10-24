-- RE Program Bot v1.3.5 hotfix.1 — Dragon Preview lifecycle.
-- Additive and idempotent. No legacy table, callback or user data is removed.

CREATE TABLE IF NOT EXISTS trial_eligibility_checks (
  check_id TEXT PRIMARY KEY CHECK (length(check_id) BETWEEN 16 AND 64),
  telegram_id INTEGER,
  subject_fingerprint TEXT CHECK (
    subject_fingerprint IS NULL OR length(subject_fingerprint) = 64
  ),
  program_code TEXT NOT NULL CHECK (program_code = 'dragon_preview'),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'eligible', 'granted', 'already_used', 'terms_required',
    'access_conflict', 'user_unavailable', 'not_member',
    'channel_unavailable'
  )),
  channel_status TEXT NOT NULL DEFAULT '' CHECK (length(channel_status) <= 32),
  checked_at INTEGER NOT NULL CHECK (checked_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_trial_eligibility_user_time
  ON trial_eligibility_checks(telegram_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS trial_grants (
  grant_id TEXT PRIMARY KEY CHECK (length(grant_id) = 36),
  telegram_id INTEGER,
  subject_fingerprint TEXT NOT NULL CHECK (length(subject_fingerprint) = 64),
  program_code TEXT NOT NULL CHECK (program_code = 'dragon_preview'),
  source_code TEXT NOT NULL CHECK (length(source_code) BETWEEN 8 AND 64),
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
  started_at INTEGER NOT NULL CHECK (started_at > 0),
  ends_at INTEGER NOT NULL CHECK (ends_at = started_at + 604800),
  retention_until INTEGER NOT NULL CHECK (retention_until >= ends_at),
  workflow_instance_id TEXT NOT NULL UNIQUE
    CHECK (length(workflow_instance_id) BETWEEN 20 AND 96),
  workflow_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (workflow_state IN ('pending', 'started', 'start_failed', 'completed')),
  workflow_error_code TEXT NOT NULL DEFAULT ''
    CHECK (length(workflow_error_code) <= 64),
  warning_sent_at INTEGER CHECK (warning_sent_at IS NULL OR warning_sent_at > 0),
  granted_at INTEGER NOT NULL CHECK (granted_at > 0),
  ended_at INTEGER CHECK (ended_at IS NULL OR ended_at >= started_at),
  anonymized_at INTEGER CHECK (anonymized_at IS NULL OR anonymized_at >= started_at),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  UNIQUE (program_code, subject_fingerprint)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_grants_live_user
  ON trial_grants(telegram_id, program_code)
  WHERE telegram_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trial_grants_due
  ON trial_grants(status, ends_at, grant_id);

CREATE INDEX IF NOT EXISTS idx_trial_grants_retention
  ON trial_grants(retention_until, anonymized_at);

CREATE TABLE IF NOT EXISTS access_status_history (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 16 AND 96),
  telegram_id INTEGER,
  plan_code TEXT NOT NULL CHECK (plan_code IN ('free', 'professional', 'dragon')),
  from_state TEXT NOT NULL CHECK (from_state IN (
    'none', 'trial', 'active', 'cancel_at_period_end', 'expired',
    'refunded', 'suspended'
  )),
  to_state TEXT NOT NULL CHECK (to_state IN (
    'none', 'trial', 'active', 'cancel_at_period_end', 'expired',
    'refunded', 'suspended'
  )),
  source_code TEXT NOT NULL CHECK (length(source_code) BETWEEN 8 AND 64),
  related_grant_id TEXT,
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_access_status_history_user_time
  ON access_status_history(telegram_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS trial_funnel_events (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 16 AND 96),
  telegram_id INTEGER,
  program_code TEXT NOT NULL CHECK (program_code = 'dragon_preview'),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'preview_granted', 'preview_expired'
  )),
  related_grant_id TEXT,
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_trial_funnel_user_time
  ON trial_funnel_events(telegram_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS notification_jobs (
  job_key TEXT PRIMARY KEY CHECK (length(job_key) BETWEEN 16 AND 128),
  telegram_id INTEGER,
  related_grant_id TEXT NOT NULL,
  job_type TEXT NOT NULL CHECK (job_type IN (
    'preview_warning', 'preview_ended'
  )),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'sent', 'failed', 'suppressed', 'unknown'
  )),
  scheduled_for INTEGER NOT NULL CHECK (scheduled_for > 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  delivery_started_at INTEGER CHECK (
    delivery_started_at IS NULL OR delivery_started_at > 0
  ),
  sent_at INTEGER CHECK (sent_at IS NULL OR sent_at > 0),
  last_error_code TEXT NOT NULL DEFAULT '' CHECK (length(last_error_code) <= 64),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  UNIQUE (related_grant_id, job_type)
);

CREATE INDEX IF NOT EXISTS idx_notification_jobs_due
  ON notification_jobs(status, job_type, scheduled_for, job_key);

-- Preview is now a supported access-state overlay for Free. It is still not a
-- fourth tariff and it does not make legacy Team safe to map automatically.
INSERT OR IGNORE INTO plan_aliases
  (alias_code, alias_version, alias_kind, target_plan_code,
   target_access_state, resolution_mode, accepts_new_writes, note)
VALUES
  ('trial', 2, 'legacy_state', 'free', 'trial', 'mapped_legacy', 0,
   'v1.3.5 hotfix: Dragon Preview is a temporary access state over Free.');

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.5-dragon-preview-hotfix.1');
