-- RE Program Bot v1.3.3 — additive Official Web registry, audit and cache metadata.
-- Safe to run repeatedly. Page bodies and user questions are never stored in D1.

CREATE TABLE IF NOT EXISTS official_web_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  admin_only INTEGER NOT NULL DEFAULT 1 CHECK (admin_only IN (0, 1)),
  stale_enabled INTEGER NOT NULL DEFAULT 0 CHECK (stale_enabled IN (0, 1)),
  window_limit INTEGER NOT NULL DEFAULT 5 CHECK (window_limit BETWEEN 1 AND 60),
  daily_limit INTEGER NOT NULL DEFAULT 30 CHECK (daily_limit BETWEEN 1 AND 500),
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS official_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  scheme TEXT NOT NULL DEFAULT 'https' CHECK (scheme = 'https'),
  hostname_ascii TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'organization'
    CHECK (source_type IN ('wiki', 'organization', 'api')),
  default_language TEXT NOT NULL DEFAULT 'ru',
  default_ttl_seconds INTEGER NOT NULL DEFAULT 86400
    CHECK (default_ttl_seconds BETWEEN 60 AND 604800),
  max_stale_seconds INTEGER NOT NULL DEFAULT 0
    CHECK (max_stale_seconds BETWEEN 0 AND 604800),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'disabled')),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_official_sources_status
  ON official_sources(status, source_key);

CREATE TABLE IF NOT EXISTS official_source_paths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  document_key TEXT NOT NULL,
  topic_code TEXT NOT NULL,
  exact_path TEXT NOT NULL DEFAULT '',
  allowed_path_prefix TEXT NOT NULL DEFAULT '',
  allowed_query_keys TEXT NOT NULL DEFAULT '',
  content_type_policy TEXT NOT NULL DEFAULT 'html_plain'
    CHECK (content_type_policy IN ('html_plain', 'json')),
  volatility_class TEXT NOT NULL DEFAULT 'stable'
    CHECK (volatility_class IN ('volatile', 'requirements', 'contact', 'stable')),
  ttl_seconds INTEGER NOT NULL DEFAULT 86400
    CHECK (ttl_seconds BETWEEN 60 AND 604800),
  max_stale_seconds INTEGER NOT NULL DEFAULT 0
    CHECK (max_stale_seconds BETWEEN 0 AND 604800),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_id, document_key),
  CHECK (
    (length(exact_path) > 0 AND length(allowed_path_prefix) = 0) OR
    (length(exact_path) = 0 AND length(allowed_path_prefix) > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_official_paths_source_status
  ON official_source_paths(source_id, status, document_key);

CREATE TABLE IF NOT EXISTS official_source_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL UNIQUE,
  actor_user_id INTEGER,
  source_id INTEGER,
  source_path_id INTEGER,
  result_status TEXT NOT NULL
    CHECK (result_status IN ('reserved', 'fresh', 'cached', 'stale', 'unavailable', 'blocked', 'rate_limited')),
  http_status INTEGER,
  final_url_hash TEXT NOT NULL DEFAULT '',
  cache_status TEXT NOT NULL DEFAULT 'none'
    CHECK (cache_status IN ('none', 'miss', 'hit', 'revalidated', 'stale', 'bypass')),
  duration_ms INTEGER NOT NULL DEFAULT 0,
  raw_bytes INTEGER NOT NULL DEFAULT 0,
  clean_chars INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_official_checks_source_date
  ON official_source_checks(source_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_official_checks_actor_date
  ON official_source_checks(actor_user_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS official_source_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  source_id INTEGER,
  source_path_id INTEGER,
  error_code TEXT NOT NULL,
  http_status INTEGER,
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  details_safe TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_official_errors_source_date
  ON official_source_errors(source_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_official_errors_trace
  ON official_source_errors(trace_id);

CREATE TABLE IF NOT EXISTS official_source_cache_meta (
  cache_key_hash TEXT PRIMARY KEY,
  source_id INTEGER NOT NULL,
  source_path_id INTEGER NOT NULL,
  locale TEXT NOT NULL DEFAULT 'ru',
  sanitizer_version TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  content_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  stale_until TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL DEFAULT 0,
  clean_chars INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_official_cache_source
  ON official_source_cache_meta(source_id, source_path_id, locale);

INSERT OR IGNORE INTO official_web_settings (id) VALUES (1);

INSERT OR IGNORE INTO official_sources
  (source_key, display_name, scheme, hostname_ascii, source_type,
   default_language, default_ttl_seconds, max_stale_seconds, status)
VALUES
  ('re_program_wiki', 'RE Program Wiki', 'https',
   're-program-wiki.pages.dev', 'wiki', 'ru', 86400, 259200, 'active');

INSERT OR IGNORE INTO official_source_paths
  (source_id, document_key, topic_code, exact_path,
   allowed_path_prefix, allowed_query_keys, content_type_policy,
   volatility_class, ttl_seconds, max_stale_seconds, status)
SELECT id, 'home', 'official_overview', '/', '', '', 'html_plain',
       'stable', 21600, 86400, 'active'
FROM official_sources WHERE source_key = 're_program_wiki';

INSERT OR IGNORE INTO official_source_paths
  (source_id, document_key, topic_code, exact_path, allowed_path_prefix,
   allowed_query_keys, content_type_policy, volatility_class,
   ttl_seconds, max_stale_seconds, status)
SELECT id, 'start', 'getting_started', '/start.html', '', '', 'html_plain', 'stable', 86400, 259200, 'active'
FROM official_sources WHERE source_key = 're_program_wiki';
INSERT OR IGNORE INTO official_source_paths
  (source_id, document_key, topic_code, exact_path, allowed_path_prefix,
   allowed_query_keys, content_type_policy, volatility_class,
   ttl_seconds, max_stale_seconds, status)
SELECT id, 'programs', 'official_programs', '/programs.html', '', '', 'html_plain', 'requirements', 3600, 0, 'active'
FROM official_sources WHERE source_key = 're_program_wiki';
INSERT OR IGNORE INTO official_source_paths
  (source_id, document_key, topic_code, exact_path, allowed_path_prefix,
   allowed_query_keys, content_type_policy, volatility_class,
   ttl_seconds, max_stale_seconds, status)
SELECT id, 'partner_profile', 'partner_profile', '/partner-profile.html', '', '', 'html_plain', 'stable', 86400, 259200, 'active'
FROM official_sources WHERE source_key = 're_program_wiki';
INSERT OR IGNORE INTO official_source_paths
  (source_id, document_key, topic_code, exact_path, allowed_path_prefix,
   allowed_query_keys, content_type_policy, volatility_class,
   ttl_seconds, max_stale_seconds, status)
SELECT id, 'partner_link', 'partner_link', '/partner-link.html', '', '', 'html_plain', 'requirements', 3600, 0, 'active'
FROM official_sources WHERE source_key = 're_program_wiki';
INSERT OR IGNORE INTO official_source_paths
  (source_id, document_key, topic_code, exact_path, allowed_path_prefix,
   allowed_query_keys, content_type_policy, volatility_class,
   ttl_seconds, max_stale_seconds, status)
SELECT id, 'stats', 'partner_stats', '/stats.html', '', '', 'html_plain', 'stable', 86400, 259200, 'active'
FROM official_sources WHERE source_key = 're_program_wiki';
INSERT OR IGNORE INTO official_source_paths
  (source_id, document_key, topic_code, exact_path, allowed_path_prefix,
   allowed_query_keys, content_type_policy, volatility_class,
   ttl_seconds, max_stale_seconds, status)
SELECT id, 'ai', 're_ai_rules', '/ai.html', '', '', 'html_plain', 'stable', 21600, 86400, 'active'
FROM official_sources WHERE source_key = 're_program_wiki';
INSERT OR IGNORE INTO official_source_paths
  (source_id, document_key, topic_code, exact_path, allowed_path_prefix,
   allowed_query_keys, content_type_policy, volatility_class,
   ttl_seconds, max_stale_seconds, status)
SELECT id, 'safety', 'official_safety', '/safety.html', '', '', 'html_plain', 'stable', 86400, 259200, 'active'
FROM official_sources WHERE source_key = 're_program_wiki';
INSERT OR IGNORE INTO official_source_paths
  (source_id, document_key, topic_code, exact_path, allowed_path_prefix,
   allowed_query_keys, content_type_policy, volatility_class,
   ttl_seconds, max_stale_seconds, status)
SELECT id, 'privacy', 'official_privacy', '/privacy.html', '', '', 'html_plain', 'stable', 86400, 259200, 'active'
FROM official_sources WHERE source_key = 're_program_wiki';
INSERT OR IGNORE INTO official_source_paths
  (source_id, document_key, topic_code, exact_path, allowed_path_prefix,
   allowed_query_keys, content_type_policy, volatility_class,
   ttl_seconds, max_stale_seconds, status)
SELECT id, 'terms', 'official_terms', '/terms.html', '', '', 'html_plain', 'requirements', 3600, 0, 'active'
FROM official_sources WHERE source_key = 're_program_wiki';
INSERT OR IGNORE INTO official_source_paths
  (source_id, document_key, topic_code, exact_path, allowed_path_prefix,
   allowed_query_keys, content_type_policy, volatility_class,
   ttl_seconds, max_stale_seconds, status)
SELECT id, 'faq', 'official_faq', '/faq.html', '', '', 'html_plain', 'stable', 86400, 259200, 'active'
FROM official_sources WHERE source_key = 're_program_wiki';
INSERT OR IGNORE INTO official_source_paths
  (source_id, document_key, topic_code, exact_path, allowed_path_prefix,
   allowed_query_keys, content_type_policy, volatility_class,
   ttl_seconds, max_stale_seconds, status)
SELECT id, 'contacts', 'official_contacts', '/contacts.html', '', '', 'html_plain', 'contact', 21600, 86400, 'active'
FROM official_sources WHERE source_key = 're_program_wiki';
INSERT OR IGNORE INTO official_source_paths
  (source_id, document_key, topic_code, exact_path, allowed_path_prefix,
   allowed_query_keys, content_type_policy, volatility_class,
   ttl_seconds, max_stale_seconds, status)
SELECT id, 'updates', 'official_updates', '/updates.html', '', '', 'html_plain', 'stable', 3600, 21600, 'active'
FROM official_sources WHERE source_key = 're_program_wiki';

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.3-official-web-2.0');
