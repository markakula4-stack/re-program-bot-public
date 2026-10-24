-- RE Program Bot v1.3.3 — canonical Cloudflare Pages paths.
-- Idempotent metadata correction only: no table or historical row is removed.
-- Cloudflare Pages redirects *.html to the extensionless canonical URL.

UPDATE official_source_paths
SET exact_path = '/start', updated_at = CURRENT_TIMESTAMP
WHERE source_id = (SELECT id FROM official_sources WHERE source_key = 're_program_wiki')
  AND document_key = 'start' AND exact_path = '/start.html';

UPDATE official_source_paths
SET exact_path = '/programs', updated_at = CURRENT_TIMESTAMP
WHERE source_id = (SELECT id FROM official_sources WHERE source_key = 're_program_wiki')
  AND document_key = 'programs' AND exact_path = '/programs.html';

UPDATE official_source_paths
SET exact_path = '/partner-profile', updated_at = CURRENT_TIMESTAMP
WHERE source_id = (SELECT id FROM official_sources WHERE source_key = 're_program_wiki')
  AND document_key = 'partner_profile' AND exact_path = '/partner-profile.html';

UPDATE official_source_paths
SET exact_path = '/partner-link', updated_at = CURRENT_TIMESTAMP
WHERE source_id = (SELECT id FROM official_sources WHERE source_key = 're_program_wiki')
  AND document_key = 'partner_link' AND exact_path = '/partner-link.html';

UPDATE official_source_paths
SET exact_path = '/stats', updated_at = CURRENT_TIMESTAMP
WHERE source_id = (SELECT id FROM official_sources WHERE source_key = 're_program_wiki')
  AND document_key = 'stats' AND exact_path = '/stats.html';

UPDATE official_source_paths
SET exact_path = '/ai', updated_at = CURRENT_TIMESTAMP
WHERE source_id = (SELECT id FROM official_sources WHERE source_key = 're_program_wiki')
  AND document_key = 'ai' AND exact_path = '/ai.html';

UPDATE official_source_paths
SET exact_path = '/safety', updated_at = CURRENT_TIMESTAMP
WHERE source_id = (SELECT id FROM official_sources WHERE source_key = 're_program_wiki')
  AND document_key = 'safety' AND exact_path = '/safety.html';

UPDATE official_source_paths
SET exact_path = '/privacy', updated_at = CURRENT_TIMESTAMP
WHERE source_id = (SELECT id FROM official_sources WHERE source_key = 're_program_wiki')
  AND document_key = 'privacy' AND exact_path = '/privacy.html';

UPDATE official_source_paths
SET exact_path = '/terms', updated_at = CURRENT_TIMESTAMP
WHERE source_id = (SELECT id FROM official_sources WHERE source_key = 're_program_wiki')
  AND document_key = 'terms' AND exact_path = '/terms.html';

UPDATE official_source_paths
SET exact_path = '/faq', updated_at = CURRENT_TIMESTAMP
WHERE source_id = (SELECT id FROM official_sources WHERE source_key = 're_program_wiki')
  AND document_key = 'faq' AND exact_path = '/faq.html';

UPDATE official_source_paths
SET exact_path = '/contacts', updated_at = CURRENT_TIMESTAMP
WHERE source_id = (SELECT id FROM official_sources WHERE source_key = 're_program_wiki')
  AND document_key = 'contacts' AND exact_path = '/contacts.html';

UPDATE official_source_paths
SET exact_path = '/updates', updated_at = CURRENT_TIMESTAMP
WHERE source_id = (SELECT id FROM official_sources WHERE source_key = 're_program_wiki')
  AND document_key = 'updates' AND exact_path = '/updates.html';

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.3-official-web-canonical-paths-1.0');
