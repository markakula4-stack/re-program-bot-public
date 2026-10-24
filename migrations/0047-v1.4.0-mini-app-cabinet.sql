-- RE Program Bot v1.4.0 Part 5 — dormant partner Mini App cabinet.
--
-- Additive and idempotent. This migration registers the read-only Mini App
-- surface and its closed gate. It does not wire the Worker, publish assets,
-- change a production route, mutate an authority, or enable rollout.

CREATE TABLE IF NOT EXISTS re_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cabinet_mini_app_v1_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rollout_mode TEXT NOT NULL DEFAULT 'off'
    CHECK (rollout_mode IN ('off', 'admin_shadow')),
  master_enabled INTEGER NOT NULL DEFAULT 0 CHECK (master_enabled IN (0, 1)),
  shell_enabled INTEGER NOT NULL DEFAULT 0 CHECK (shell_enabled IN (0, 1)),
  profile_screen_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (profile_screen_enabled IN (0, 1)),
  offers_screen_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (offers_screen_enabled IN (0, 1)),
  applications_screen_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (applications_screen_enabled IN (0, 1)),
  results_screen_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (results_screen_enabled IN (0, 1)),
  read_only_recovery_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (read_only_recovery_enabled IN (0, 1)),
  shell_version INTEGER NOT NULL DEFAULT 1 CHECK (shell_version = 1),
  route_registry_version INTEGER NOT NULL DEFAULT 1
    CHECK (route_registry_version = 1),
  page_size INTEGER NOT NULL DEFAULT 10 CHECK (page_size BETWEEN 5 AND 20),
  cursor_ttl_seconds INTEGER NOT NULL DEFAULT 300
    CHECK (cursor_ttl_seconds = 300),
  recovery_max_age_seconds INTEGER NOT NULL DEFAULT 900
    CHECK (recovery_max_age_seconds = 900),
  policy_version TEXT NOT NULL DEFAULT '2026-09-14.cabinet-v1-part5'
    CHECK (policy_version = '2026-09-14.cabinet-v1-part5'),
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
      shell_enabled = 0 AND profile_screen_enabled = 0
      AND offers_screen_enabled = 0 AND applications_screen_enabled = 0
      AND results_screen_enabled = 0 AND read_only_recovery_enabled = 0
    )
  ),
  CHECK (
    shell_enabled = 1 OR (
      profile_screen_enabled = 0 AND offers_screen_enabled = 0
      AND applications_screen_enabled = 0 AND results_screen_enabled = 0
      AND read_only_recovery_enabled = 0
    )
  )
);

INSERT OR IGNORE INTO cabinet_mini_app_v1_settings (
  id, rollout_mode, master_enabled, shell_enabled,
  profile_screen_enabled, offers_screen_enabled,
  applications_screen_enabled, results_screen_enabled,
  read_only_recovery_enabled, shell_version, route_registry_version,
  page_size, cursor_ttl_seconds, recovery_max_age_seconds,
  policy_version, revision, updated_by, updated_at
) VALUES (
  1, 'off', 0, 0, 0, 0, 0, 0, 0, 1, 1, 10, 300, 900,
  '2026-09-14.cabinet-v1-part5', 1, NULL, unixepoch()
);

CREATE TABLE IF NOT EXISTS cabinet_mini_app_route_registry (
  route_code TEXT PRIMARY KEY CHECK (
    length(route_code) BETWEEN 5 AND 48
    AND route_code = lower(route_code)
    AND route_code GLOB '*.*'
    AND route_code NOT GLOB '*[^a-z0-9._]*'
  ),
  http_method TEXT NOT NULL CHECK (http_method = 'GET'),
  path_template TEXT NOT NULL UNIQUE CHECK (
    length(path_template) BETWEEN 16 AND 128
    AND substr(path_template, 1, 20) = '/api/v1.4.0/cabinet/'
  ),
  screen_code TEXT NOT NULL CHECK (screen_code IN (
    'home', 'profile', 'offers', 'applications', 'results',
    'application_detail'
  )),
  capability_code TEXT NOT NULL REFERENCES cabinet_capability_registry(
    capability_code
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN (
    'profile', 'offer', 'application'
  )),
  recovery_safe INTEGER NOT NULL CHECK (recovery_safe IN (0, 1)),
  route_registry_version INTEGER NOT NULL DEFAULT 1
    CHECK (route_registry_version = 1),
  policy_version TEXT NOT NULL DEFAULT '2026-09-14.cabinet-v1-part5'
    CHECK (policy_version = '2026-09-14.cabinet-v1-part5'),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  CHECK (
    (screen_code IN ('home', 'profile')
      AND capability_code = 'profile.read' AND resource_kind = 'profile')
    OR (screen_code = 'offers'
      AND capability_code = 'offer.read' AND resource_kind = 'offer')
    OR (screen_code IN (
      'applications', 'results', 'application_detail'
    ) AND capability_code = 'application.read'
      AND resource_kind = 'application')
  ),
  CHECK (screen_code != 'application_detail' OR recovery_safe = 0)
);

INSERT OR IGNORE INTO cabinet_mini_app_route_registry (
  route_code, http_method, path_template, screen_code, capability_code,
  resource_kind, recovery_safe, route_registry_version, policy_version,
  created_at
) VALUES
  ('bootstrap.read', 'GET', '/api/v1.4.0/cabinet/bootstrap', 'home',
   'profile.read', 'profile', 1, 1,
   '2026-09-14.cabinet-v1-part5', unixepoch()),
  ('profile.read', 'GET', '/api/v1.4.0/cabinet/profile', 'profile',
   'profile.read', 'profile', 1, 1,
   '2026-09-14.cabinet-v1-part5', unixepoch()),
  ('offers.list', 'GET', '/api/v1.4.0/cabinet/offers', 'offers',
   'offer.read', 'offer', 1, 1,
   '2026-09-14.cabinet-v1-part5', unixepoch()),
  ('applications.list', 'GET', '/api/v1.4.0/cabinet/applications',
   'applications', 'application.read', 'application', 1, 1,
   '2026-09-14.cabinet-v1-part5', unixepoch()),
  ('results.list', 'GET', '/api/v1.4.0/cabinet/results', 'results',
   'application.read', 'application', 1, 1,
   '2026-09-14.cabinet-v1-part5', unixepoch()),
  ('applications.detail', 'GET',
   '/api/v1.4.0/cabinet/applications/:application_id',
   'application_detail', 'application.read', 'application', 0, 1,
   '2026-09-14.cabinet-v1-part5', unixepoch());

CREATE TRIGGER IF NOT EXISTS trg_cabinet_mini_app_settings_identity
BEFORE UPDATE ON cabinet_mini_app_v1_settings
WHEN NEW.id != OLD.id OR NEW.policy_version != OLD.policy_version
  OR NEW.shell_version != OLD.shell_version
  OR NEW.route_registry_version != OLD.route_registry_version
  OR NEW.page_size != OLD.page_size
  OR NEW.cursor_ttl_seconds != OLD.cursor_ttl_seconds
  OR NEW.recovery_max_age_seconds != OLD.recovery_max_age_seconds
BEGIN
  SELECT RAISE(ABORT, 'cabinet mini app settings identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_mini_app_settings_revision
BEFORE UPDATE ON cabinet_mini_app_v1_settings
WHEN NEW.revision != OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'cabinet mini app revision must increment by one');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_mini_app_settings_admin
BEFORE UPDATE ON cabinet_mini_app_v1_settings
WHEN NEW.updated_by IS NULL OR NOT EXISTS (
  SELECT 1 FROM user_roles role
  WHERE role.telegram_id = NEW.updated_by
    AND role.role = 'admin' AND role.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet mini app settings require active admin');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_mini_app_settings_time
BEFORE UPDATE ON cabinet_mini_app_v1_settings
WHEN NEW.updated_at <= OLD.updated_at OR NEW.updated_at > unixepoch() + 60
BEGIN
  SELECT RAISE(ABORT, 'cabinet mini app settings time is invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_mini_app_parent_gate
BEFORE UPDATE ON cabinet_mini_app_v1_settings
WHEN NEW.master_enabled = 1 AND NOT EXISTS (
  SELECT 1
  FROM cabinet_v1_settings foundation,
       cabinet_offer_v1_settings offers,
       cabinet_application_v1_settings applications,
       cabinet_access_e2e_settings access
  WHERE foundation.id = 1 AND foundation.rollout_mode = 'admin_shadow'
    AND foundation.master_enabled = 1 AND foundation.profile_enabled = 1
    AND foundation.offer_enabled = 1 AND foundation.application_enabled = 1
    AND offers.id = 1 AND offers.enabled = 1
    AND offers.lifecycle_enabled = 1 AND offers.preview_enabled = 1
    AND applications.id = 1 AND applications.enabled = 1
    AND applications.lifecycle_enabled = 1 AND applications.crm_enabled = 1
    AND applications.contacts_enabled = 1
    AND applications.notes_enabled = 1
    AND applications.assignment_enabled = 1
    AND applications.result_enabled = 1
    AND access.id = 1 AND access.rollout_mode = 'admin_shadow'
    AND access.master_enabled = 1 AND access.access_projection_enabled = 1
    AND access.application_binding_enabled = 1
    AND access.analytics_bridge_enabled = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet mini app parent gate is closed');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_mini_app_settings_no_delete
BEFORE DELETE ON cabinet_mini_app_v1_settings
BEGIN
  SELECT RAISE(ABORT, 'cabinet mini app settings cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_mini_app_routes_allowlist
BEFORE INSERT ON cabinet_mini_app_route_registry
WHEN NEW.route_code NOT IN (
  'bootstrap.read', 'profile.read', 'offers.list', 'applications.list',
  'results.list', 'applications.detail'
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet mini app route registry is fixed');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_mini_app_routes_no_update
BEFORE UPDATE ON cabinet_mini_app_route_registry
BEGIN
  SELECT RAISE(ABORT, 'cabinet mini app route registry is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_mini_app_routes_no_delete
BEFORE DELETE ON cabinet_mini_app_route_registry
BEGIN
  SELECT RAISE(ABORT, 'cabinet mini app route registry is immutable');
END;

INSERT OR IGNORE INTO re_schema_migrations(version)
VALUES ('0047-v1.4.0-mini-app-cabinet');
