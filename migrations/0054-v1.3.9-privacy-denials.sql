-- P02: durable, pseudonymous denial after a completed user deletion.
-- The existing short-lived maintenance guard authorizes creation; the denial
-- remains after that guard expires, so replay cannot recreate analytics.
CREATE TABLE IF NOT EXISTS analytics_privacy_denials (
  subject_pseudonym TEXT PRIMARY KEY CHECK (
    length(subject_pseudonym) = 64
    AND subject_pseudonym = lower(subject_pseudonym)
    AND subject_pseudonym NOT GLOB '*[^0-9a-f]*'
  ),
  pseudonym_key_version INTEGER NOT NULL CHECK (pseudonym_key_version > 0),
  denied_at INTEGER NOT NULL CHECK (denied_at > 0)
);

CREATE TRIGGER IF NOT EXISTS trg_analytics_privacy_denial_authority
BEFORE INSERT ON analytics_privacy_denials
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_privacy_maintenance_guard guard
  WHERE guard.id = 1 AND guard.reason = 'user_deletion'
    AND guard.subject_pseudonym = NEW.subject_pseudonym
    AND guard.expires_at >= unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'analytics privacy denial requires deletion guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_privacy_denial_no_update
BEFORE UPDATE ON analytics_privacy_denials
BEGIN
  SELECT RAISE(ABORT, 'analytics privacy denial is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_privacy_denial_no_delete
BEFORE DELETE ON analytics_privacy_denials
BEGIN
  SELECT RAISE(ABORT, 'analytics privacy denial cannot be removed');
END;

CREATE TRIGGER IF NOT EXISTS trg_canonical_analytics_privacy_denied
BEFORE INSERT ON canonical_analytics_events
WHEN EXISTS (
  SELECT 1 FROM analytics_privacy_denials denied
  WHERE denied.subject_pseudonym = NEW.actor_pseudonym
)
BEGIN
  SELECT RAISE(ABORT, 'analytics subject was deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_context_privacy_denied
BEFORE INSERT ON analytics_event_context
WHEN EXISTS (
  SELECT 1 FROM analytics_privacy_denials denied
  JOIN canonical_analytics_events event ON event.event_id = NEW.event_id
  WHERE denied.subject_pseudonym IN (
    event.actor_pseudonym, NEW.owner_pseudonym
  )
)
BEGIN
  SELECT RAISE(ABORT, 'analytics context subject was deleted');
END;

INSERT OR IGNORE INTO re_schema_migrations(version)
VALUES ('1.3.9-privacy-denials');
