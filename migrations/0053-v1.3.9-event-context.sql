-- P01 / v1.3.9: optional context for canonical events. Historical v1 events
-- remain unchanged; adapters attach verified context in P02.
CREATE TABLE IF NOT EXISTS analytics_event_context (
  event_id TEXT PRIMARY KEY
    REFERENCES canonical_analytics_events(event_id) ON DELETE CASCADE,
  event_key TEXT NOT NULL UNIQUE,
  canonical_payload_hash TEXT NOT NULL CHECK (
    length(canonical_payload_hash) = 64
    AND canonical_payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  context_version INTEGER NOT NULL CHECK (context_version = 1),
  owner_scope_kind TEXT NOT NULL CHECK (
    owner_scope_kind IN ('actor', 'partner', 'system')
  ),
  owner_pseudonym TEXT CHECK (
    owner_pseudonym IS NULL OR (
      length(owner_pseudonym) = 64
      AND owner_pseudonym NOT GLOB '*[^0-9a-f]*'
    )
  ),
  correlation_key_hash TEXT NOT NULL CHECK (
    length(correlation_key_hash) = 64
    AND correlation_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  offer_key_hash TEXT CHECK (
    offer_key_hash IS NULL OR (
      length(offer_key_hash) = 64
      AND offer_key_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  context_hash TEXT NOT NULL CHECK (
    length(context_hash) = 64
    AND context_hash NOT GLOB '*[^0-9a-f]*'
  ),
  recorded_at INTEGER NOT NULL CHECK (recorded_at > 0),
  CHECK (
    (owner_scope_kind = 'system' AND owner_pseudonym IS NULL)
    OR (owner_scope_kind IN ('actor', 'partner')
      AND owner_pseudonym IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_analytics_event_context_owner
  ON analytics_event_context(owner_scope_kind, owner_pseudonym, event_id);
CREATE INDEX IF NOT EXISTS idx_analytics_event_context_correlation
  ON analytics_event_context(correlation_key_hash, event_id);
CREATE INDEX IF NOT EXISTS idx_analytics_event_context_offer
  ON analytics_event_context(offer_key_hash, event_id)
  WHERE offer_key_hash IS NOT NULL;

-- Consumers must opt into enriched events explicitly. Old rows cannot acquire
-- an invented owner, correlation, or offer by a view fallback.
CREATE VIEW IF NOT EXISTS analytics_enriched_events_v1 AS
SELECT event.*, context.context_version, context.owner_scope_kind,
       context.owner_pseudonym, context.correlation_key_hash,
       context.offer_key_hash, context.context_hash
FROM canonical_analytics_events AS event
JOIN analytics_event_context AS context ON context.event_id = event.event_id;

CREATE TRIGGER IF NOT EXISTS trg_analytics_event_context_parent
BEFORE INSERT ON analytics_event_context
WHEN NOT EXISTS (
  SELECT 1 FROM canonical_analytics_events event
  WHERE event.event_id = NEW.event_id
    AND event.event_key = NEW.event_key
    AND event.payload_hash = NEW.canonical_payload_hash
    AND event.recorded_at = NEW.recorded_at
    AND (NEW.owner_scope_kind != 'actor'
      OR event.actor_pseudonym = NEW.owner_pseudonym)
    AND (NEW.owner_scope_kind != 'system'
      OR event.origin = 'system')
)
BEGIN
  SELECT RAISE(ABORT, 'analytics event context parent mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_event_context_deletion_in_progress
BEFORE INSERT ON analytics_event_context
WHEN EXISTS (
  SELECT 1 FROM analytics_privacy_maintenance_guard guard
  JOIN canonical_analytics_events event ON event.event_id = NEW.event_id
  WHERE guard.id = 1
    AND guard.reason = 'user_deletion'
    AND guard.expires_at >= unixepoch()
    AND guard.subject_pseudonym IN (
      event.actor_pseudonym, NEW.owner_pseudonym
    )
)
BEGIN
  SELECT RAISE(ABORT, 'analytics context subject deletion is in progress');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_event_context_no_update
BEFORE UPDATE ON analytics_event_context
BEGIN
  SELECT RAISE(ABORT, 'analytics event context is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_analytics_event_context_guarded_delete
BEFORE DELETE ON analytics_event_context
WHEN EXISTS (
  SELECT 1 FROM canonical_analytics_events event
  WHERE event.event_id = OLD.event_id
)
AND NOT EXISTS (
  SELECT 1 FROM canonical_analytics_events event
  JOIN analytics_privacy_maintenance_guard guard ON guard.id = 1
  WHERE event.event_id = OLD.event_id
    AND guard.expires_at >= unixepoch()
    AND (
      (guard.reason = 'retention' AND event.retention_until <= unixepoch())
      OR (guard.reason = 'user_deletion'
        AND guard.subject_pseudonym IN (
          event.actor_pseudonym, OLD.owner_pseudonym
        ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'analytics event context deletion requires privacy guard');
END;

-- The existing privacy inventory has a closed dataset_name CHECK; leave it
-- immutable and register this additive dataset under its own policy record.
CREATE TABLE IF NOT EXISTS analytics_event_context_privacy_inventory (
  dataset_name TEXT PRIMARY KEY CHECK (dataset_name = 'analytics_event_context'),
  privacy_class TEXT NOT NULL CHECK (privacy_class = 'pseudonymous'),
  raw_identifier_columns INTEGER NOT NULL CHECK (raw_identifier_columns = 0),
  content_columns INTEGER NOT NULL CHECK (content_columns = 0),
  retention_days INTEGER NOT NULL CHECK (retention_days = 180),
  deletion_mode TEXT NOT NULL CHECK (deletion_mode = 'cascade_with_event'),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 8 AND 80)
);
INSERT OR IGNORE INTO analytics_event_context_privacy_inventory
  (dataset_name, privacy_class, raw_identifier_columns, content_columns,
   retention_days, deletion_mode, policy_version)
VALUES ('analytics_event_context', 'pseudonymous', 0, 0, 180,
        'cascade_with_event', '2026-09-24.analytics-v2-p01-context');

CREATE TRIGGER IF NOT EXISTS trg_analytics_event_context_privacy_no_update
BEFORE UPDATE ON analytics_event_context_privacy_inventory
BEGIN
  SELECT RAISE(ABORT, 'analytics event context privacy inventory is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_analytics_event_context_privacy_no_delete
BEFORE DELETE ON analytics_event_context_privacy_inventory
BEGIN
  SELECT RAISE(ABORT, 'analytics event context privacy inventory is append-only');
END;
