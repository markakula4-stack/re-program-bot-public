-- Extend the existing paid notification outbox with confirmed refund notices.
-- No delivery flag or financial/access evidence is changed. Apply this complete
-- migration atomically. The rebuild copies every retained job before replacing
-- the old CHECK and restores the same indexes, admission and delivery fences.
-- Rollback is the transaction rollback or the verified pre-migration backup;
-- do not downgrade a database containing refund_confirmed jobs by deleting them.

CREATE TABLE IF NOT EXISTS paid_subscription_notification_jobs_v143_refund (
  job_key TEXT PRIMARY KEY CHECK(length(job_key) BETWEEN 16 AND 160),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(subscription_id),
  telegram_id INTEGER NOT NULL CHECK(typeof(telegram_id)='integer' AND telegram_id>0),
  event_id TEXT REFERENCES subscription_provider_events(event_id),
  job_type TEXT NOT NULL CHECK(job_type IN ('renewal_canceled','renewal_failed','period_expiring','period_expired','refund_confirmed')),
  expected_subscription_revision INTEGER NOT NULL CHECK(typeof(expected_subscription_revision)='integer' AND expected_subscription_revision>0),
  expected_period_end INTEGER NOT NULL CHECK(typeof(expected_period_end)='integer' AND expected_period_end>0),
  expected_lifecycle_state TEXT NOT NULL CHECK(expected_lifecycle_state IN ('active','cancel_at_period_end','payment_failed','expired','refunded','chargeback','suspended')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed','suppressed','unknown')),
  scheduled_for INTEGER NOT NULL CHECK(typeof(scheduled_for)='integer' AND scheduled_for>0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempt_count)='integer' AND attempt_count BETWEEN 0 AND 3),
  delivery_started_at INTEGER,
  telegram_message_id INTEGER,
  delivery_receipt_sha256 TEXT CHECK(delivery_receipt_sha256 IS NULL OR (length(delivery_receipt_sha256)=64 AND delivery_receipt_sha256 NOT GLOB '*[^0-9a-f]*')),
  sent_at INTEGER,
  last_error_code TEXT NOT NULL DEFAULT '' CHECK(length(last_error_code)<=64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>0),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=created_at),
  CHECK(status!='sent' OR (typeof(telegram_message_id)='integer' AND telegram_message_id>0 AND delivery_receipt_sha256 IS NOT NULL AND typeof(sent_at)='integer' AND sent_at>=created_at)),
  CHECK(attempt_count=0 OR (typeof(delivery_started_at)='integer' AND delivery_started_at>=created_at))
);
INSERT INTO paid_subscription_notification_jobs_v143_refund
SELECT * FROM paid_subscription_notification_jobs;
DROP TABLE paid_subscription_notification_jobs;
ALTER TABLE paid_subscription_notification_jobs_v143_refund RENAME TO paid_subscription_notification_jobs;

CREATE UNIQUE INDEX IF NOT EXISTS idx_v143_paid_notification_dedupe ON paid_subscription_notification_jobs(subscription_id,job_type,expected_period_end,COALESCE(event_id,''));
CREATE INDEX IF NOT EXISTS idx_v143_paid_notification_due ON paid_subscription_notification_jobs(status,scheduled_for,job_key);
CREATE INDEX IF NOT EXISTS idx_v143_paid_notification_own ON paid_subscription_notification_jobs(telegram_id,created_at DESC,job_key);
CREATE TRIGGER IF NOT EXISTS v143_paid_notification_insert BEFORE INSERT ON paid_subscription_notification_jobs
WHEN NEW.status!='pending' OR NEW.attempt_count!=0 OR NEW.revision!=1 OR NOT EXISTS(SELECT 1 FROM subscriptions s
 WHERE s.subscription_id=NEW.subscription_id AND s.telegram_id=NEW.telegram_id
 AND s.revision=NEW.expected_subscription_revision AND s.current_period_end=NEW.expected_period_end)
 OR (NEW.event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_provider_events e WHERE e.event_id=NEW.event_id AND e.telegram_id=NEW.telegram_id))
BEGIN SELECT RAISE(ABORT,'v143_paid_notification_binding_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v143_paid_notification_update BEFORE UPDATE ON paid_subscription_notification_jobs
WHEN NEW.job_key IS NOT OLD.job_key OR NEW.subscription_id IS NOT OLD.subscription_id OR NEW.telegram_id IS NOT OLD.telegram_id
 OR NEW.event_id IS NOT OLD.event_id OR NEW.job_type IS NOT OLD.job_type OR NEW.expected_subscription_revision IS NOT OLD.expected_subscription_revision
 OR NEW.expected_period_end IS NOT OLD.expected_period_end OR NEW.expected_lifecycle_state IS NOT OLD.expected_lifecycle_state
 OR NEW.scheduled_for IS NOT OLD.scheduled_for OR NEW.created_at IS NOT OLD.created_at OR NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at
 OR NOT ((OLD.status='pending' AND NEW.status IN ('processing','suppressed'))
  OR (OLD.status='processing' AND NEW.status IN ('sent','failed','suppressed','unknown'))
  OR (OLD.status='failed' AND NEW.status IN ('processing','suppressed'))
  OR (OLD.status='unknown' AND NEW.status IN ('sent','suppressed')))
 OR (NEW.status='processing' AND (NEW.attempt_count!=OLD.attempt_count+1 OR
  (OLD.status='failed' AND OLD.last_error_code NOT IN ('telegram_rate_limited','retry_after')) OR NOT EXISTS(SELECT 1 FROM subscriptions s
  WHERE s.subscription_id=NEW.subscription_id AND s.telegram_id=NEW.telegram_id AND s.revision=NEW.expected_subscription_revision
  AND s.current_period_end=NEW.expected_period_end)))
 OR (NEW.status!='processing' AND (NEW.attempt_count!=OLD.attempt_count OR NEW.delivery_started_at IS NOT OLD.delivery_started_at))
BEGIN SELECT RAISE(ABORT,'v143_paid_notification_transition_invalid'); END;
CREATE TRIGGER IF NOT EXISTS v143_paid_notification_no_delete BEFORE DELETE ON paid_subscription_notification_jobs
BEGIN SELECT RAISE(ABORT,'v143_paid_notification_retention_required'); END;

INSERT OR IGNORE INTO re_schema_migrations(version) VALUES('1.4.3-refund-notification');
