-- RE Program Bot v1.4.0 Part 3 — canonical applications and minimal CRM.
--
-- Additive and idempotent. A canonical application is anchored to one legacy
-- lead_requests row and one exact Part 2 publication cycle. All new switches
-- start disabled. This migration does not wire the production Worker, mutate
-- remote D1, create rewards/payments/access, or enable rollout.

CREATE TABLE IF NOT EXISTS re_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cabinet_application_v1_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  lifecycle_enabled INTEGER NOT NULL DEFAULT 0 CHECK (lifecycle_enabled IN (0, 1)),
  crm_enabled INTEGER NOT NULL DEFAULT 0 CHECK (crm_enabled IN (0, 1)),
  contacts_enabled INTEGER NOT NULL DEFAULT 0 CHECK (contacts_enabled IN (0, 1)),
  notes_enabled INTEGER NOT NULL DEFAULT 0 CHECK (notes_enabled IN (0, 1)),
  assignment_enabled INTEGER NOT NULL DEFAULT 0 CHECK (assignment_enabled IN (0, 1)),
  result_enabled INTEGER NOT NULL DEFAULT 0 CHECK (result_enabled IN (0, 1)),
  transition_contract_version INTEGER NOT NULL DEFAULT 1
    CHECK (transition_contract_version = 1),
  policy_version TEXT NOT NULL DEFAULT '2026-09-14.cabinet-v1-part3'
    CHECK (policy_version = '2026-09-14.cabinet-v1-part3'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by INTEGER REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  CHECK (
    enabled = 1 OR (
      lifecycle_enabled = 0 AND crm_enabled = 0 AND contacts_enabled = 0
      AND notes_enabled = 0 AND assignment_enabled = 0 AND result_enabled = 0
    )
  ),
  CHECK (
    lifecycle_enabled = 1 OR (
      crm_enabled = 0 AND contacts_enabled = 0 AND notes_enabled = 0
      AND assignment_enabled = 0 AND result_enabled = 0
    )
  ),
  CHECK (
    crm_enabled = 1 OR (
      contacts_enabled = 0 AND notes_enabled = 0
      AND assignment_enabled = 0 AND result_enabled = 0
    )
  )
);

INSERT OR IGNORE INTO cabinet_application_v1_settings (
  id, enabled, lifecycle_enabled, crm_enabled, contacts_enabled,
  notes_enabled, assignment_enabled, result_enabled,
  transition_contract_version, policy_version, revision, updated_by, updated_at
) VALUES (
  1, 0, 0, 0, 0, 0, 0, 0, 1,
  '2026-09-14.cabinet-v1-part3', 1, NULL, unixepoch()
);

CREATE TABLE IF NOT EXISTS cabinet_application_status_registry (
  status_code TEXT NOT NULL CHECK (status_code IN (
    'submitted', 'accepted', 'in_progress', 'waiting_user',
    'completed', 'rejected', 'cancelled', 'archived'
  )),
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK (contract_version = 1),
  active_slot INTEGER NOT NULL CHECK (active_slot IN (0, 1)),
  terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
  sort_order INTEGER NOT NULL UNIQUE CHECK (sort_order BETWEEN 10 AND 80),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (status_code, contract_version),
  CHECK (active_slot + terminal = 1),
  CHECK (
    (status_code IN ('submitted', 'accepted', 'in_progress', 'waiting_user')
      AND active_slot = 1 AND terminal = 0)
    OR
    (status_code IN ('completed', 'rejected', 'cancelled', 'archived')
      AND active_slot = 0 AND terminal = 1)
  )
);

INSERT OR IGNORE INTO cabinet_application_status_registry (
  status_code, contract_version, active_slot, terminal, sort_order, created_at
) VALUES
  ('submitted', 1, 1, 0, 10, unixepoch()),
  ('accepted', 1, 1, 0, 20, unixepoch()),
  ('in_progress', 1, 1, 0, 30, unixepoch()),
  ('waiting_user', 1, 1, 0, 40, unixepoch()),
  ('completed', 1, 0, 1, 50, unixepoch()),
  ('rejected', 1, 0, 1, 60, unixepoch()),
  ('cancelled', 1, 0, 1, 70, unixepoch()),
  ('archived', 1, 0, 1, 80, unixepoch());

CREATE TABLE IF NOT EXISTS cabinet_application_transition_registry (
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK (contract_version = 1),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (contract_version, from_status, to_status),
  FOREIGN KEY (from_status, contract_version)
    REFERENCES cabinet_application_status_registry(status_code, contract_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (to_status, contract_version)
    REFERENCES cabinet_application_status_registry(status_code, contract_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (from_status != to_status)
);

INSERT OR IGNORE INTO cabinet_application_transition_registry (
  contract_version, from_status, to_status, created_at
) VALUES
  (1, 'submitted', 'accepted', unixepoch()),
  (1, 'submitted', 'rejected', unixepoch()),
  (1, 'submitted', 'cancelled', unixepoch()),
  (1, 'accepted', 'in_progress', unixepoch()),
  (1, 'accepted', 'waiting_user', unixepoch()),
  (1, 'accepted', 'rejected', unixepoch()),
  (1, 'accepted', 'cancelled', unixepoch()),
  (1, 'in_progress', 'waiting_user', unixepoch()),
  (1, 'in_progress', 'completed', unixepoch()),
  (1, 'in_progress', 'rejected', unixepoch()),
  (1, 'in_progress', 'cancelled', unixepoch()),
  (1, 'waiting_user', 'in_progress', unixepoch()),
  (1, 'waiting_user', 'completed', unixepoch()),
  (1, 'waiting_user', 'rejected', unixepoch()),
  (1, 'waiting_user', 'cancelled', unixepoch()),
  (1, 'completed', 'archived', unixepoch()),
  (1, 'rejected', 'archived', unixepoch()),
  (1, 'cancelled', 'archived', unixepoch());

CREATE TABLE IF NOT EXISTS cabinet_application_create_receipts (
  create_receipt_id TEXT PRIMARY KEY CHECK (
    length(create_receipt_id) = 68
    AND substr(create_receipt_id, 1, 4) = 'acr_'
    AND substr(create_receipt_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  application_id TEXT NOT NULL UNIQUE CHECK (
    length(application_id) = 68
    AND substr(application_id, 1, 4) = 'app_'
    AND substr(application_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  resource_id TEXT NOT NULL UNIQUE CHECK (
    length(resource_id) = 68
    AND substr(resource_id, 1, 4) = 'res_'
    AND substr(resource_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  event_id TEXT NOT NULL UNIQUE CHECK (
    length(event_id) = 68
    AND substr(event_id, 1, 4) = 'aev_'
    AND substr(event_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  source_kind TEXT NOT NULL DEFAULT 'lead_request'
    CHECK (source_kind = 'lead_request'),
  source_lead_id INTEGER NOT NULL REFERENCES lead_requests(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  subject_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  offer_cycle_id TEXT NOT NULL REFERENCES cabinet_offer_publication_receipts(
    publication_id
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  offer_code TEXT NOT NULL REFERENCES offer_owners(offer_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  offer_version_id INTEGER NOT NULL REFERENCES offer_versions(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  owner_partner_profile_id INTEGER NOT NULL REFERENCES partner_profiles(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  owner_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  partner_link_id INTEGER NOT NULL REFERENCES partner_links(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  program_code TEXT NOT NULL REFERENCES partner_programs(code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  plan_code TEXT NOT NULL CHECK (plan_code IN (
    'free', 'professional', 'dragon'
  )),
  quota_code TEXT NOT NULL DEFAULT 'active_applications'
    CHECK (quota_code = 'active_applications'),
  quota_limit INTEGER NOT NULL CHECK (quota_limit IN (5, 25, 50)),
  plan_authority_source TEXT NOT NULL DEFAULT 'database'
    CHECK (plan_authority_source = 'database'),
  plan_authority_key_hash TEXT NOT NULL CHECK (
    length(plan_authority_key_hash) = 64
    AND plan_authority_key_hash = lower(plan_authority_key_hash)
    AND plan_authority_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  source_authority_hash TEXT NOT NULL CHECK (
    length(source_authority_hash) = 64
    AND source_authority_hash = lower(source_authority_hash)
    AND source_authority_hash NOT GLOB '*[^0-9a-f]*'
  ),
  resource_authority_hash TEXT NOT NULL CHECK (
    length(resource_authority_hash) = 64
    AND resource_authority_hash = lower(resource_authority_hash)
    AND resource_authority_hash NOT GLOB '*[^0-9a-f]*'
  ),
  offer_authority_hash TEXT NOT NULL CHECK (
    length(offer_authority_hash) = 64
    AND offer_authority_hash = lower(offer_authority_hash)
    AND offer_authority_hash NOT GLOB '*[^0-9a-f]*'
  ),
  contact_hash TEXT NOT NULL CHECK (
    length(contact_hash) = 64
    AND contact_hash = lower(contact_hash)
    AND contact_hash NOT GLOB '*[^0-9a-f]*'
  ),
  actor_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('user', 'admin')),
  action_source TEXT NOT NULL CHECK (
    action_source IN ('mini_app', 'worker', 'admin', 'system')
  ),
  actor_key_hash TEXT NOT NULL CHECK (
    length(actor_key_hash) = 64
    AND actor_key_hash = lower(actor_key_hash)
    AND actor_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  initial_status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (initial_status = 'submitted'),
  transition_contract_version INTEGER NOT NULL DEFAULT 1
    CHECK (transition_contract_version = 1),
  initial_revision INTEGER NOT NULL DEFAULT 1 CHECK (initial_revision = 1),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) = 68
    AND substr(idempotency_key, 1, 4) = 'key_'
    AND substr(idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash = lower(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  before_hash TEXT NOT NULL CHECK (
    length(before_hash) = 64 AND before_hash = lower(before_hash)
    AND before_hash NOT GLOB '*[^0-9a-f]*'
  ),
  after_hash TEXT NOT NULL CHECK (
    length(after_hash) = 64 AND after_hash = lower(after_hash)
    AND after_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  UNIQUE (source_kind, source_lead_id, offer_cycle_id),
  FOREIGN KEY (plan_code, quota_code)
    REFERENCES cabinet_plan_quotas(plan_code, quota_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (initial_status, transition_contract_version)
    REFERENCES cabinet_application_status_registry(status_code, contract_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (before_hash != after_hash),
  CHECK (
    (actor_role = 'user' AND action_source IN ('mini_app', 'worker'))
    OR (actor_role = 'admin'
      AND action_source IN ('admin', 'worker', 'system'))
  )
);

CREATE INDEX IF NOT EXISTS idx_cabinet_application_create_subject
  ON cabinet_application_create_receipts(
    subject_telegram_id, created_at, create_receipt_id
  );

CREATE INDEX IF NOT EXISTS idx_cabinet_application_create_owner
  ON cabinet_application_create_receipts(
    owner_partner_profile_id, created_at, create_receipt_id
  );

CREATE TABLE IF NOT EXISTS cabinet_applications (
  application_id TEXT PRIMARY KEY CHECK (
    length(application_id) = 68
    AND substr(application_id, 1, 4) = 'app_'
    AND substr(application_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  resource_id TEXT NOT NULL UNIQUE REFERENCES cabinet_resource_bindings(
    resource_id
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  create_receipt_id TEXT NOT NULL UNIQUE
    REFERENCES cabinet_application_create_receipts(create_receipt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_kind TEXT NOT NULL DEFAULT 'lead_request'
    CHECK (source_kind = 'lead_request'),
  source_lead_id INTEGER NOT NULL REFERENCES lead_requests(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  subject_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  offer_cycle_id TEXT NOT NULL REFERENCES cabinet_offer_publication_receipts(
    publication_id
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  offer_code TEXT NOT NULL REFERENCES offer_owners(offer_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  offer_version_id INTEGER NOT NULL REFERENCES offer_versions(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  owner_partner_profile_id INTEGER NOT NULL REFERENCES partner_profiles(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  owner_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  plan_code_at_creation TEXT NOT NULL CHECK (plan_code_at_creation IN (
    'free', 'professional', 'dragon'
  )),
  quota_limit_at_creation INTEGER NOT NULL CHECK (
    quota_limit_at_creation IN (5, 25, 50)
  ),
  current_status TEXT NOT NULL,
  transition_contract_version INTEGER NOT NULL DEFAULT 1
    CHECK (transition_contract_version = 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_transition_id TEXT UNIQUE,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (source_kind, source_lead_id, offer_cycle_id),
  FOREIGN KEY (current_status, transition_contract_version)
    REFERENCES cabinet_application_status_registry(status_code, contract_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (revision = 1 AND last_transition_id IS NULL)
    OR (revision > 1 AND last_transition_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_cabinet_applications_subject_status
  ON cabinet_applications(
    subject_telegram_id, current_status, updated_at, application_id
  );

CREATE INDEX IF NOT EXISTS idx_cabinet_applications_owner_status
  ON cabinet_applications(
    owner_partner_profile_id, current_status, updated_at, application_id
  );

CREATE TABLE IF NOT EXISTS cabinet_application_contacts_private (
  application_id TEXT PRIMARY KEY REFERENCES cabinet_applications(application_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  subject_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  owner_partner_profile_id INTEGER NOT NULL REFERENCES partner_profiles(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  contact_kind TEXT NOT NULL DEFAULT 'telegram_id'
    CHECK (contact_kind = 'telegram_id'),
  contact_value TEXT NOT NULL CHECK (
    length(contact_value) BETWEEN 1 AND 32
    AND contact_value NOT GLOB '*[^0-9]*'
  ),
  contact_hash TEXT NOT NULL CHECK (
    length(contact_hash) = 64 AND contact_hash = lower(contact_hash)
    AND contact_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_cabinet_application_contacts_owner
  ON cabinet_application_contacts_private(
    owner_partner_profile_id, application_id
  );

CREATE TABLE IF NOT EXISTS cabinet_application_assignments (
  application_id TEXT PRIMARY KEY REFERENCES cabinet_applications(application_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  owner_partner_profile_id INTEGER NOT NULL REFERENCES partner_profiles(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  assignee_telegram_id INTEGER REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_assignment_receipt_id TEXT UNIQUE,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (revision = 0 AND last_assignment_receipt_id IS NULL)
    OR (revision > 0 AND last_assignment_receipt_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS cabinet_application_events (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) = 68
    AND substr(event_id, 1, 4) = 'aev_'
    AND substr(event_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  application_id TEXT NOT NULL REFERENCES cabinet_applications(application_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'created', 'status_changed', 'note_added',
    'assignment_changed', 'result_recorded'
  )),
  status_from TEXT,
  status_to TEXT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('user', 'partner', 'admin')),
  action_source TEXT NOT NULL CHECK (
    action_source IN ('mini_app', 'worker', 'admin', 'system')
  ),
  actor_key_hash TEXT NOT NULL CHECK (
    length(actor_key_hash) = 64 AND actor_key_hash = lower(actor_key_hash)
    AND actor_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  data_hash TEXT NOT NULL CHECK (
    length(data_hash) = 64 AND data_hash = lower(data_hash)
    AND data_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash = lower(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  revision_before INTEGER NOT NULL CHECK (revision_before >= 0),
  revision_after INTEGER NOT NULL CHECK (revision_after >= revision_before),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) = 68
    AND substr(idempotency_key, 1, 4) = 'key_'
    AND substr(idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  CHECK (
    (event_kind = 'created' AND status_from IS NULL AND status_to = 'submitted'
      AND revision_before = 0 AND revision_after = 1)
    OR
    (event_kind = 'status_changed' AND status_from IS NOT NULL
      AND status_to IS NOT NULL AND status_from != status_to
      AND revision_after = revision_before + 1)
    OR
    (event_kind IN ('note_added', 'assignment_changed', 'result_recorded')
      AND status_from IS NULL AND status_to IS NULL)
  ),
  CHECK (
    (actor_role IN ('user', 'partner')
      AND action_source IN ('mini_app', 'worker'))
    OR (actor_role = 'admin'
      AND action_source IN ('admin', 'worker', 'system'))
  )
);

CREATE INDEX IF NOT EXISTS idx_cabinet_application_events_history
  ON cabinet_application_events(application_id, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS cabinet_application_transition_receipts (
  transition_id TEXT PRIMARY KEY CHECK (
    length(transition_id) = 68
    AND substr(transition_id, 1, 4) = 'atr_'
    AND substr(transition_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  event_id TEXT NOT NULL UNIQUE CHECK (
    length(event_id) = 68
    AND substr(event_id, 1, 4) = 'aev_'
    AND substr(event_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  application_id TEXT NOT NULL REFERENCES cabinet_applications(application_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  owner_partner_profile_id INTEGER NOT NULL REFERENCES partner_profiles(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK (contract_version = 1),
  expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
  revision_after INTEGER NOT NULL CHECK (revision_after = expected_revision + 1),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('partner', 'admin')),
  action_source TEXT NOT NULL CHECK (
    action_source IN ('mini_app', 'worker', 'admin', 'system')
  ),
  actor_key_hash TEXT NOT NULL CHECK (
    length(actor_key_hash) = 64 AND actor_key_hash = lower(actor_key_hash)
    AND actor_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  reason_code TEXT NOT NULL CHECK (
    length(reason_code) BETWEEN 2 AND 64
    AND reason_code = lower(reason_code)
    AND reason_code NOT GLOB '*[^a-z0-9_]*'
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
  before_hash TEXT NOT NULL CHECK (
    length(before_hash) = 64 AND before_hash = lower(before_hash)
    AND before_hash NOT GLOB '*[^0-9a-f]*'
  ),
  after_hash TEXT NOT NULL CHECK (
    length(after_hash) = 64 AND after_hash = lower(after_hash)
    AND after_hash NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  FOREIGN KEY (contract_version, from_status, to_status)
    REFERENCES cabinet_application_transition_registry(
      contract_version, from_status, to_status
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (before_hash != after_hash),
  CHECK (
    (actor_role = 'partner' AND action_source IN ('mini_app', 'worker'))
    OR (actor_role = 'admin'
      AND action_source IN ('admin', 'worker', 'system'))
  )
);

CREATE INDEX IF NOT EXISTS idx_cabinet_application_transitions_history
  ON cabinet_application_transition_receipts(
    application_id, expected_revision, transition_id
  );

CREATE TABLE IF NOT EXISTS cabinet_application_notes_private (
  note_id TEXT PRIMARY KEY CHECK (
    length(note_id) = 68
    AND substr(note_id, 1, 4) = 'ant_'
    AND substr(note_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  event_id TEXT NOT NULL UNIQUE CHECK (
    length(event_id) = 68
    AND substr(event_id, 1, 4) = 'aev_'
    AND substr(event_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  application_id TEXT NOT NULL REFERENCES cabinet_applications(application_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  owner_partner_profile_id INTEGER NOT NULL REFERENCES partner_profiles(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  author_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  author_role TEXT NOT NULL CHECK (author_role IN ('partner', 'admin')),
  action_source TEXT NOT NULL CHECK (
    action_source IN ('mini_app', 'worker', 'admin', 'system')
  ),
  actor_key_hash TEXT NOT NULL CHECK (
    length(actor_key_hash) = 64 AND actor_key_hash = lower(actor_key_hash)
    AND actor_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  note TEXT NOT NULL CHECK (
    length(note) BETWEEN 1 AND 4000 AND length(trim(note)) > 0
  ),
  note_hash TEXT NOT NULL CHECK (
    length(note_hash) = 64 AND note_hash = lower(note_hash)
    AND note_hash NOT GLOB '*[^0-9a-f]*'
  ),
  application_revision INTEGER NOT NULL CHECK (application_revision > 0),
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
  CHECK (
    (author_role = 'partner' AND action_source IN ('mini_app', 'worker'))
    OR (author_role = 'admin'
      AND action_source IN ('admin', 'worker', 'system'))
  )
);

CREATE INDEX IF NOT EXISTS idx_cabinet_application_notes_owner
  ON cabinet_application_notes_private(
    owner_partner_profile_id, application_id, occurred_at, note_id
  );

CREATE TABLE IF NOT EXISTS cabinet_application_assignment_receipts (
  assignment_receipt_id TEXT PRIMARY KEY CHECK (
    length(assignment_receipt_id) = 68
    AND substr(assignment_receipt_id, 1, 4) = 'aas_'
    AND substr(assignment_receipt_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  event_id TEXT NOT NULL UNIQUE CHECK (
    length(event_id) = 68
    AND substr(event_id, 1, 4) = 'aev_'
    AND substr(event_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  application_id TEXT NOT NULL REFERENCES cabinet_applications(application_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  owner_partner_profile_id INTEGER NOT NULL REFERENCES partner_profiles(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  revision_after INTEGER NOT NULL CHECK (revision_after = expected_revision + 1),
  from_assignee_telegram_id INTEGER REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  to_assignee_telegram_id INTEGER REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('partner', 'admin')),
  action_source TEXT NOT NULL CHECK (
    action_source IN ('mini_app', 'worker', 'admin', 'system')
  ),
  actor_key_hash TEXT NOT NULL CHECK (
    length(actor_key_hash) = 64 AND actor_key_hash = lower(actor_key_hash)
    AND actor_key_hash NOT GLOB '*[^0-9a-f]*'
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
  before_hash TEXT NOT NULL CHECK (
    length(before_hash) = 64 AND before_hash = lower(before_hash)
    AND before_hash NOT GLOB '*[^0-9a-f]*'
  ),
  after_hash TEXT NOT NULL CHECK (
    length(after_hash) = 64 AND after_hash = lower(after_hash)
    AND after_hash NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  CHECK (from_assignee_telegram_id IS NOT to_assignee_telegram_id),
  CHECK (before_hash != after_hash),
  CHECK (
    (actor_role = 'partner' AND action_source IN ('mini_app', 'worker'))
    OR (actor_role = 'admin'
      AND action_source IN ('admin', 'worker', 'system'))
  )
);

CREATE INDEX IF NOT EXISTS idx_cabinet_assignment_receipts_application
  ON cabinet_application_assignment_receipts(
    application_id, expected_revision, assignment_receipt_id
  );

CREATE TABLE IF NOT EXISTS cabinet_application_results (
  result_id TEXT PRIMARY KEY CHECK (
    length(result_id) = 68
    AND substr(result_id, 1, 4) = 'ars_'
    AND substr(result_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  event_id TEXT NOT NULL UNIQUE CHECK (
    length(event_id) = 68
    AND substr(event_id, 1, 4) = 'aev_'
    AND substr(event_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  application_id TEXT NOT NULL UNIQUE REFERENCES cabinet_applications(
    application_id
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  owner_partner_profile_id INTEGER NOT NULL REFERENCES partner_profiles(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  application_revision INTEGER NOT NULL CHECK (application_revision > 0),
  terminal_status TEXT NOT NULL CHECK (terminal_status IN (
    'completed', 'rejected', 'cancelled'
  )),
  result_code TEXT NOT NULL CHECK (result_code IN (
    'successful', 'unsuccessful', 'cancelled'
  )),
  reason_code TEXT NOT NULL CHECK (
    length(reason_code) BETWEEN 2 AND 64
    AND reason_code = lower(reason_code)
    AND reason_code NOT GLOB '*[^a-z0-9_]*'
  ),
  actor_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('partner', 'admin')),
  action_source TEXT NOT NULL CHECK (
    action_source IN ('mini_app', 'worker', 'admin', 'system')
  ),
  actor_key_hash TEXT NOT NULL CHECK (
    length(actor_key_hash) = 64 AND actor_key_hash = lower(actor_key_hash)
    AND actor_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  result_hash TEXT NOT NULL CHECK (
    length(result_hash) = 64 AND result_hash = lower(result_hash)
    AND result_hash NOT GLOB '*[^0-9a-f]*'
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
  before_hash TEXT NOT NULL CHECK (
    length(before_hash) = 64 AND before_hash = lower(before_hash)
    AND before_hash NOT GLOB '*[^0-9a-f]*'
  ),
  after_hash TEXT NOT NULL CHECK (
    length(after_hash) = 64 AND after_hash = lower(after_hash)
    AND after_hash NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  CHECK (
    (terminal_status = 'completed' AND result_code = 'successful')
    OR (terminal_status = 'rejected' AND result_code = 'unsuccessful')
    OR (terminal_status = 'cancelled' AND result_code = 'cancelled')
  ),
  CHECK (before_hash != after_hash),
  CHECK (
    (actor_role = 'partner' AND action_source IN ('mini_app', 'worker'))
    OR (actor_role = 'admin'
      AND action_source IN ('admin', 'worker', 'system'))
  )
);

CREATE INDEX IF NOT EXISTS idx_cabinet_application_results_owner
  ON cabinet_application_results(
    owner_partner_profile_id, occurred_at, result_id
  );

-- Settings are closed by default and can only be changed by an active admin
-- while the parent cabinet application gate is aligned.
CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_settings_identity
BEFORE UPDATE ON cabinet_application_v1_settings
WHEN NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT, 'application settings identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_settings_revision
BEFORE UPDATE ON cabinet_application_v1_settings
WHEN NEW.revision != OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'application settings revision must advance exactly once');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_settings_admin
BEFORE UPDATE ON cabinet_application_v1_settings
WHEN NEW.updated_by IS NULL OR NOT EXISTS (
  SELECT 1 FROM user_roles role
  WHERE role.telegram_id = NEW.updated_by
    AND role.role = 'admin' AND role.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'application settings update requires active admin');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_settings_gate
BEFORE UPDATE ON cabinet_application_v1_settings
WHEN NEW.enabled = 1 AND NOT EXISTS (
  SELECT 1 FROM cabinet_v1_settings settings
  WHERE settings.id = 1 AND settings.rollout_mode = 'admin_shadow'
    AND settings.master_enabled = 1 AND settings.application_enabled = 1
)
BEGIN
  SELECT RAISE(ABORT, 'parent application gate is closed');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_settings_time
BEFORE UPDATE ON cabinet_application_v1_settings
WHEN NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'application settings time cannot regress');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_settings_no_delete
BEFORE DELETE ON cabinet_application_v1_settings
BEGIN
  SELECT RAISE(ABORT, 'application settings cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_statuses_no_update
BEFORE UPDATE ON cabinet_application_status_registry
BEGIN
  SELECT RAISE(ABORT, 'application status registry is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_statuses_no_delete
BEFORE DELETE ON cabinet_application_status_registry
BEGIN
  SELECT RAISE(ABORT, 'application status registry cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_transitions_registry_no_update
BEFORE UPDATE ON cabinet_application_transition_registry
BEGIN
  SELECT RAISE(ABORT, 'application transition registry is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_transitions_registry_no_delete
BEFORE DELETE ON cabinet_application_transition_registry
BEGIN
  SELECT RAISE(ABORT, 'application transition registry cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_create_idempotency_mismatch
BEFORE INSERT ON cabinet_application_create_receipts
WHEN EXISTS (
  SELECT 1 FROM cabinet_application_create_receipts existing
  WHERE existing.idempotency_key = NEW.idempotency_key
    AND (existing.create_receipt_id != NEW.create_receipt_id
      OR existing.application_id != NEW.application_id
      OR existing.resource_id != NEW.resource_id
      OR existing.event_id != NEW.event_id
      OR existing.source_lead_id != NEW.source_lead_id
      OR existing.offer_cycle_id != NEW.offer_cycle_id
      OR existing.actor_telegram_id != NEW.actor_telegram_id
      OR existing.actor_role != NEW.actor_role
      OR existing.action_source != NEW.action_source
      OR existing.request_hash != NEW.request_hash)
)
BEGIN
  SELECT RAISE(ABORT, 'application create idempotency mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_create_source_cycle
BEFORE INSERT ON cabinet_application_create_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_application_create_receipts existing
  WHERE existing.idempotency_key = NEW.idempotency_key
)
AND EXISTS (
  SELECT 1 FROM cabinet_applications application
  WHERE application.source_kind = NEW.source_kind
    AND application.source_lead_id = NEW.source_lead_id
    AND application.offer_cycle_id = NEW.offer_cycle_id
)
BEGIN
  SELECT RAISE(ABORT, 'source lead already has application in offer cycle');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_create_validate
BEFORE INSERT ON cabinet_application_create_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_application_create_receipts existing
  WHERE existing.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM cabinet_v1_settings cabinet, cabinet_offer_v1_settings offer_settings,
      cabinet_application_v1_settings application_settings,
      partner_beta_settings beta
    WHERE cabinet.id = 1 AND cabinet.rollout_mode = 'admin_shadow'
      AND cabinet.master_enabled = 1 AND cabinet.application_enabled = 1
      AND offer_settings.id = 1 AND offer_settings.enabled = 1
      AND offer_settings.lifecycle_enabled = 1
      AND offer_settings.publication_enabled = 1
      AND application_settings.id = 1 AND application_settings.enabled = 1
      AND application_settings.lifecycle_enabled = 1
      AND application_settings.crm_enabled = 1
      AND application_settings.contacts_enabled = 1
      AND beta.id = 1 AND beta.enabled = 1
      AND beta.public_visibility_enabled = 1
  ) THEN RAISE(ABORT, 'application create gate is closed') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM users subject
    JOIN user_roles subject_role ON subject_role.telegram_id = subject.telegram_id
      AND subject_role.role = 'user' AND subject_role.status = 'active'
    WHERE subject.telegram_id = NEW.subject_telegram_id
      AND subject.is_blocked = 0
      AND (
        (NEW.actor_role = 'user'
          AND NEW.actor_telegram_id = NEW.subject_telegram_id)
        OR
        (NEW.actor_role = 'admin' AND EXISTS (
          SELECT 1 FROM user_roles admin_role
          WHERE admin_role.telegram_id = NEW.actor_telegram_id
            AND admin_role.role = 'admin' AND admin_role.status = 'active'
        ))
      )
  ) THEN RAISE(ABORT, 'application create actor mismatch') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM cabinet_capability_grants grant_row
    WHERE grant_row.actor_telegram_id = NEW.actor_telegram_id
      AND grant_row.capability_code = 'application.create'
      AND grant_row.effect = 'deny'
      AND grant_row.starts_at <= NEW.created_at
      AND (grant_row.expires_at IS NULL OR grant_row.expires_at > NEW.created_at)
      AND grant_row.scope_rule IN ('global', 'self')
      AND NOT EXISTS (
        SELECT 1 FROM cabinet_capability_grant_revocations revocation
        WHERE revocation.grant_id = grant_row.grant_id
          AND revocation.revoked_at <= NEW.created_at
      )
  ) THEN RAISE(ABORT, 'application create capability denied') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM lead_requests lead
    JOIN lead_partner_attribution attribution
      ON attribution.lead_id = lead.id
    JOIN cabinet_offer_publication_receipts publication
      ON publication.publication_id = NEW.offer_cycle_id
    JOIN cabinet_offer_review_receipts review
      ON review.review_id = publication.review_id
    JOIN cabinet_offer_submissions submission
      ON submission.submission_id = review.submission_id
    JOIN offer_visibility_rules visibility
      ON visibility.offer_code = publication.offer_code
    JOIN offer_owners owner ON owner.offer_code = publication.offer_code
    JOIN partner_profiles profile ON profile.id = owner.partner_profile_id
    JOIN user_roles partner_role ON partner_role.telegram_id = profile.telegram_id
      AND partner_role.role = 'partner' AND partner_role.status = 'active'
    JOIN partner_beta_access beta_access
      ON beta_access.partner_profile_id = profile.id
    JOIN partner_offer_links selection
      ON selection.offer_code = publication.offer_code
    JOIN partner_links partner_link ON partner_link.id = selection.partner_link_id
    JOIN program_offers program_offer
      ON program_offer.id = partner_link.catalog_offer_id
    JOIN partner_programs program ON program.code = program_offer.program_code
    JOIN offers catalog_offer ON catalog_offer.code = program_offer.offer_code
    WHERE lead.id = NEW.source_lead_id
      AND lead.telegram_id = NEW.subject_telegram_id
      AND lead.offer_code = NEW.offer_code
      AND lead.status = 'pending'
      AND lead.telegram_id != profile.telegram_id
      AND publication.offer_code = NEW.offer_code
      AND publication.offer_version_id = NEW.offer_version_id
      AND publication.owner_partner_profile_id = NEW.owner_partner_profile_id
      AND publication.authority_hash = NEW.offer_authority_hash
      AND review.decision = 'approved'
      AND submission.offer_code = NEW.offer_code
      AND submission.offer_version_id = NEW.offer_version_id
      AND submission.owner_partner_profile_id = NEW.owner_partner_profile_id
      AND submission.partner_link_id = NEW.partner_link_id
      AND submission.program_code = NEW.program_code
      AND visibility.moderation_status = 'approved'
      AND visibility.visibility = 'public'
      AND visibility.current_version_id = NEW.offer_version_id
      AND visibility.approved_version_id = NEW.offer_version_id
      AND owner.owner_kind = 'partner'
      AND owner.partner_profile_id = NEW.owner_partner_profile_id
      AND profile.telegram_id = NEW.owner_telegram_id
      AND profile.status = 'active'
      AND beta_access.access_status = 'active'
      AND (beta_access.expires_at IS NULL
        OR unixepoch(beta_access.expires_at) > NEW.created_at)
      AND selection.partner_link_id = NEW.partner_link_id
      AND partner_link.partner_profile_id = NEW.owner_partner_profile_id
      AND partner_link.status = 'approved'
      AND partner_link.ownership_confirmed = 1
      AND partner_link.traffic_confirmed = 1
      AND program_offer.program_code = NEW.program_code
      AND program_offer.status = 'active'
      AND program.status = 'active'
      AND catalog_offer.status = 'active'
      AND attribution.partner_link_id = NEW.partner_link_id
      AND attribution.partner_profile_id = NEW.owner_partner_profile_id
      AND attribution.program_code = NEW.program_code
  ) THEN RAISE(ABORT, 'application source or offer authority mismatch') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_plan_quotas quota
    JOIN cabinet_tariff_capacity capacity
      ON capacity.plan_code = quota.plan_code
    WHERE quota.plan_code = NEW.plan_code
      AND quota.quota_code = 'active_applications'
      AND quota.window_kind = 'concurrent'
      AND quota.source_kind = 'fixed_product_override'
      AND quota.quota_version = 1
      AND quota.limit_value = NEW.quota_limit
      AND ((NEW.plan_code = 'free' AND NEW.quota_limit = 5
          AND capacity.capacity_percent = 10)
        OR (NEW.plan_code = 'professional' AND NEW.quota_limit = 25
          AND capacity.capacity_percent = 50)
        OR (NEW.plan_code = 'dragon' AND NEW.quota_limit = 50
          AND capacity.capacity_percent = 100))
  ) THEN RAISE(ABORT, 'application quota authority mismatch') END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM cabinet_applications application
    JOIN cabinet_application_status_registry status
      ON status.status_code = application.current_status
      AND status.contract_version = application.transition_contract_version
    WHERE application.subject_telegram_id = NEW.subject_telegram_id
      AND status.active_slot = 1
  ) >= NEW.quota_limit
  THEN RAISE(ABORT, 'active application quota exhausted') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_create_apply
AFTER INSERT ON cabinet_application_create_receipts
BEGIN
  INSERT INTO cabinet_resource_bindings (
    resource_id, resource_kind, authority_kind, authority_key_hash,
    owner_kind, owner_telegram_id, owner_partner_profile_id, created_at
  ) VALUES (
    NEW.resource_id, 'application', 'lead_requests',
    NEW.resource_authority_hash, 'partner', NEW.owner_telegram_id,
    NEW.owner_partner_profile_id, NEW.created_at
  );

  INSERT INTO cabinet_applications (
    application_id, resource_id, create_receipt_id, source_kind,
    source_lead_id, subject_telegram_id, offer_cycle_id, offer_code,
    offer_version_id, owner_partner_profile_id, owner_telegram_id,
    plan_code_at_creation, quota_limit_at_creation, current_status,
    transition_contract_version, revision, last_transition_id,
    created_at, updated_at
  ) VALUES (
    NEW.application_id, NEW.resource_id, NEW.create_receipt_id, NEW.source_kind,
    NEW.source_lead_id, NEW.subject_telegram_id, NEW.offer_cycle_id,
    NEW.offer_code, NEW.offer_version_id, NEW.owner_partner_profile_id,
    NEW.owner_telegram_id, NEW.plan_code, NEW.quota_limit,
    NEW.initial_status, NEW.transition_contract_version,
    NEW.initial_revision, NULL, NEW.created_at, NEW.created_at
  );

  INSERT INTO cabinet_application_contacts_private (
    application_id, subject_telegram_id, owner_partner_profile_id,
    contact_kind, contact_value, contact_hash, created_at
  ) VALUES (
    NEW.application_id, NEW.subject_telegram_id,
    NEW.owner_partner_profile_id, 'telegram_id',
    CAST(NEW.subject_telegram_id AS TEXT), NEW.contact_hash, NEW.created_at
  );

  INSERT INTO cabinet_application_assignments (
    application_id, owner_partner_profile_id, assignee_telegram_id,
    revision, last_assignment_receipt_id, created_at, updated_at
  ) VALUES (
    NEW.application_id, NEW.owner_partner_profile_id, NULL,
    0, NULL, NEW.created_at, NEW.created_at
  );

  INSERT INTO cabinet_application_events (
    event_id, application_id, event_kind, status_from, status_to,
    actor_role, action_source, actor_key_hash, data_hash, request_hash,
    revision_before, revision_after, idempotency_key, occurred_at
  ) VALUES (
    NEW.event_id, NEW.application_id, 'created', NULL, NEW.initial_status,
    NEW.actor_role, NEW.action_source, NEW.actor_key_hash,
    NEW.after_hash, NEW.request_hash,
    0, 1, NEW.idempotency_key, NEW.created_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_create_no_update
BEFORE UPDATE ON cabinet_application_create_receipts
BEGIN
  SELECT RAISE(ABORT, 'application create receipts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_create_no_delete
BEFORE DELETE ON cabinet_application_create_receipts
BEGIN
  SELECT RAISE(ABORT, 'application create receipts cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_applications_insert_guard
BEFORE INSERT ON cabinet_applications
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_application_create_receipts receipt
  WHERE receipt.application_id = NEW.application_id
    AND receipt.resource_id = NEW.resource_id
    AND receipt.create_receipt_id = NEW.create_receipt_id
    AND receipt.source_kind = NEW.source_kind
    AND receipt.source_lead_id = NEW.source_lead_id
    AND receipt.subject_telegram_id = NEW.subject_telegram_id
    AND receipt.offer_cycle_id = NEW.offer_cycle_id
    AND receipt.offer_code = NEW.offer_code
    AND receipt.offer_version_id = NEW.offer_version_id
    AND receipt.owner_partner_profile_id = NEW.owner_partner_profile_id
    AND receipt.owner_telegram_id = NEW.owner_telegram_id
    AND receipt.plan_code = NEW.plan_code_at_creation
    AND receipt.quota_limit = NEW.quota_limit_at_creation
    AND receipt.initial_status = NEW.current_status
    AND receipt.transition_contract_version = NEW.transition_contract_version
    AND receipt.initial_revision = NEW.revision
    AND NEW.last_transition_id IS NULL
    AND receipt.created_at = NEW.created_at
    AND receipt.created_at = NEW.updated_at
)
BEGIN
  SELECT RAISE(ABORT, 'application insert requires exact create receipt');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_applications_identity
BEFORE UPDATE ON cabinet_applications
WHEN NEW.application_id IS NOT OLD.application_id
  OR NEW.resource_id IS NOT OLD.resource_id
  OR NEW.create_receipt_id IS NOT OLD.create_receipt_id
  OR NEW.source_kind IS NOT OLD.source_kind
  OR NEW.source_lead_id IS NOT OLD.source_lead_id
  OR NEW.subject_telegram_id IS NOT OLD.subject_telegram_id
  OR NEW.offer_cycle_id IS NOT OLD.offer_cycle_id
  OR NEW.offer_code IS NOT OLD.offer_code
  OR NEW.offer_version_id IS NOT OLD.offer_version_id
  OR NEW.owner_partner_profile_id IS NOT OLD.owner_partner_profile_id
  OR NEW.owner_telegram_id IS NOT OLD.owner_telegram_id
  OR NEW.plan_code_at_creation IS NOT OLD.plan_code_at_creation
  OR NEW.quota_limit_at_creation IS NOT OLD.quota_limit_at_creation
  OR NEW.transition_contract_version IS NOT OLD.transition_contract_version
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'application identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_applications_transition_guard
BEFORE UPDATE ON cabinet_applications
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_application_transition_receipts receipt
  WHERE receipt.transition_id = NEW.last_transition_id
    AND receipt.application_id = OLD.application_id
    AND receipt.contract_version = OLD.transition_contract_version
    AND receipt.expected_revision = OLD.revision
    AND receipt.revision_after = NEW.revision
    AND receipt.from_status = OLD.current_status
    AND receipt.to_status = NEW.current_status
    AND receipt.occurred_at = NEW.updated_at
)
BEGIN
  SELECT RAISE(ABORT, 'application update requires exact transition receipt');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_applications_no_delete
BEFORE DELETE ON cabinet_applications
BEGIN
  SELECT RAISE(ABORT, 'applications cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_contacts_insert_guard
BEFORE INSERT ON cabinet_application_contacts_private
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_application_create_receipts receipt
  WHERE receipt.application_id = NEW.application_id
    AND receipt.subject_telegram_id = NEW.subject_telegram_id
    AND receipt.owner_partner_profile_id = NEW.owner_partner_profile_id
    AND receipt.contact_hash = NEW.contact_hash
    AND NEW.contact_kind = 'telegram_id'
    AND NEW.contact_value = CAST(receipt.subject_telegram_id AS TEXT)
    AND receipt.created_at = NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'application contact requires exact create receipt');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_contacts_no_update
BEFORE UPDATE ON cabinet_application_contacts_private
BEGIN
  SELECT RAISE(ABORT, 'application contacts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_contacts_guarded_delete
BEFORE DELETE ON cabinet_application_contacts_private
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_privacy_maintenance_guard guard
  WHERE guard.id = 1 AND guard.reason = 'user_deletion'
    AND guard.subject_telegram_id = OLD.subject_telegram_id
    AND guard.expires_at >= unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'application contact deletion requires privacy guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_events_insert_guard
BEFORE INSERT ON cabinet_application_events
WHEN NOT (
  (NEW.event_kind = 'created' AND EXISTS (
    SELECT 1 FROM cabinet_application_create_receipts receipt
    WHERE receipt.event_id = NEW.event_id
      AND receipt.application_id = NEW.application_id
      AND receipt.idempotency_key = NEW.idempotency_key
  ))
  OR (NEW.event_kind = 'status_changed' AND EXISTS (
    SELECT 1 FROM cabinet_application_transition_receipts receipt
    WHERE receipt.event_id = NEW.event_id
      AND receipt.application_id = NEW.application_id
      AND receipt.idempotency_key = NEW.idempotency_key
  ))
  OR (NEW.event_kind = 'note_added' AND EXISTS (
    SELECT 1 FROM cabinet_application_notes_private note_row
    WHERE note_row.event_id = NEW.event_id
      AND note_row.application_id = NEW.application_id
      AND note_row.idempotency_key = NEW.idempotency_key
  ))
  OR (NEW.event_kind = 'assignment_changed' AND EXISTS (
    SELECT 1 FROM cabinet_application_assignment_receipts receipt
    WHERE receipt.event_id = NEW.event_id
      AND receipt.application_id = NEW.application_id
      AND receipt.idempotency_key = NEW.idempotency_key
  ))
  OR (NEW.event_kind = 'result_recorded' AND EXISTS (
    SELECT 1 FROM cabinet_application_results result_row
    WHERE result_row.event_id = NEW.event_id
      AND result_row.application_id = NEW.application_id
      AND result_row.idempotency_key = NEW.idempotency_key
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'application event requires canonical receipt');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_events_no_update
BEFORE UPDATE ON cabinet_application_events
BEGIN
  SELECT RAISE(ABORT, 'application events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_events_no_delete
BEFORE DELETE ON cabinet_application_events
BEGIN
  SELECT RAISE(ABORT, 'application events cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_transition_idempotency
BEFORE INSERT ON cabinet_application_transition_receipts
WHEN EXISTS (
  SELECT 1 FROM cabinet_application_transition_receipts existing
  WHERE existing.idempotency_key = NEW.idempotency_key
    AND (existing.transition_id != NEW.transition_id
      OR existing.event_id != NEW.event_id
      OR existing.application_id != NEW.application_id
      OR existing.expected_revision != NEW.expected_revision
      OR existing.from_status != NEW.from_status
      OR existing.to_status != NEW.to_status
      OR existing.actor_telegram_id != NEW.actor_telegram_id
      OR existing.actor_role != NEW.actor_role
      OR existing.action_source != NEW.action_source
      OR existing.request_hash != NEW.request_hash)
)
BEGIN
  SELECT RAISE(ABORT, 'application transition idempotency mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_transition_validate
BEFORE INSERT ON cabinet_application_transition_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_application_transition_receipts existing
  WHERE existing.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_v1_settings cabinet,
      cabinet_application_v1_settings settings
    WHERE cabinet.id = 1 AND cabinet.rollout_mode = 'admin_shadow'
      AND cabinet.master_enabled = 1 AND cabinet.application_enabled = 1
      AND settings.id = 1 AND settings.enabled = 1
      AND settings.lifecycle_enabled = 1 AND settings.crm_enabled = 1
  ) THEN RAISE(ABORT, 'application transition gate is closed') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_applications application
    JOIN cabinet_application_transition_registry transition
      ON transition.contract_version = NEW.contract_version
      AND transition.from_status = NEW.from_status
      AND transition.to_status = NEW.to_status
    WHERE application.application_id = NEW.application_id
      AND application.owner_partner_profile_id = NEW.owner_partner_profile_id
      AND application.transition_contract_version = NEW.contract_version
      AND application.revision = NEW.expected_revision
      AND application.current_status = NEW.from_status
      AND NEW.revision_after = application.revision + 1
      AND NEW.occurred_at >= application.updated_at
      AND (NEW.to_status != 'archived' OR EXISTS (
        SELECT 1 FROM cabinet_application_results result_row
        WHERE result_row.application_id = application.application_id
      ))
  ) THEN RAISE(ABORT, 'application transition stale or denied') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_applications application
    WHERE application.application_id = NEW.application_id
      AND (
        (NEW.actor_role = 'partner' AND EXISTS (
          SELECT 1 FROM partner_profiles profile
          JOIN user_roles role ON role.telegram_id = profile.telegram_id
          WHERE profile.id = application.owner_partner_profile_id
            AND profile.id = NEW.owner_partner_profile_id
            AND profile.telegram_id = NEW.actor_telegram_id
            AND profile.status = 'active'
            AND role.role = 'partner' AND role.status = 'active'
        ))
        OR
        (NEW.actor_role = 'admin' AND EXISTS (
          SELECT 1 FROM user_roles role
          WHERE role.telegram_id = NEW.actor_telegram_id
            AND role.role = 'admin' AND role.status = 'active'
        ))
      )
  ) THEN RAISE(ABORT, 'application transition actor mismatch') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM cabinet_capability_grants grant_row
    JOIN cabinet_applications application
      ON application.application_id = NEW.application_id
    WHERE grant_row.actor_telegram_id = NEW.actor_telegram_id
      AND grant_row.capability_code = 'application.update'
      AND grant_row.effect = 'deny'
      AND grant_row.starts_at <= NEW.occurred_at
      AND (grant_row.expires_at IS NULL OR grant_row.expires_at > NEW.occurred_at)
      AND (
        grant_row.scope_rule = 'global'
        OR (grant_row.scope_rule = 'resource'
          AND grant_row.resource_id = application.resource_id)
        OR (NEW.actor_role = 'partner'
          AND grant_row.scope_rule IN ('self', 'partner_owner'))
      )
      AND NOT EXISTS (
        SELECT 1 FROM cabinet_capability_grant_revocations revocation
        WHERE revocation.grant_id = grant_row.grant_id
          AND revocation.revoked_at <= NEW.occurred_at
      )
  ) THEN RAISE(ABORT, 'application update capability denied') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_transition_apply
AFTER INSERT ON cabinet_application_transition_receipts
BEGIN
  UPDATE cabinet_applications
  SET current_status = NEW.to_status,
      revision = NEW.revision_after,
      last_transition_id = NEW.transition_id,
      updated_at = NEW.occurred_at
  WHERE application_id = NEW.application_id
    AND current_status = NEW.from_status
    AND revision = NEW.expected_revision;

  INSERT INTO cabinet_application_events (
    event_id, application_id, event_kind, status_from, status_to,
    actor_role, action_source, actor_key_hash, data_hash, request_hash,
    revision_before, revision_after, idempotency_key, occurred_at
  ) VALUES (
    NEW.event_id, NEW.application_id, 'status_changed',
    NEW.from_status, NEW.to_status, NEW.actor_role, NEW.action_source,
    NEW.actor_key_hash, NEW.after_hash, NEW.request_hash, NEW.expected_revision,
    NEW.revision_after, NEW.idempotency_key, NEW.occurred_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_transitions_no_update
BEFORE UPDATE ON cabinet_application_transition_receipts
BEGIN
  SELECT RAISE(ABORT, 'application transition receipts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_transitions_no_delete
BEFORE DELETE ON cabinet_application_transition_receipts
BEGIN
  SELECT RAISE(ABORT, 'application transition receipts cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_note_idempotency
BEFORE INSERT ON cabinet_application_notes_private
WHEN EXISTS (
  SELECT 1 FROM cabinet_application_notes_private existing
  WHERE existing.idempotency_key = NEW.idempotency_key
    AND (existing.note_id != NEW.note_id
      OR existing.event_id != NEW.event_id
      OR existing.application_id != NEW.application_id
      OR existing.note_hash != NEW.note_hash
      OR existing.author_telegram_id != NEW.author_telegram_id
      OR existing.author_role != NEW.author_role
      OR existing.action_source != NEW.action_source
      OR existing.request_hash != NEW.request_hash)
)
BEGIN
  SELECT RAISE(ABORT, 'application note idempotency mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_note_validate
BEFORE INSERT ON cabinet_application_notes_private
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_application_notes_private existing
  WHERE existing.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_v1_settings cabinet,
      cabinet_application_v1_settings settings
    WHERE cabinet.id = 1 AND cabinet.rollout_mode = 'admin_shadow'
      AND cabinet.master_enabled = 1 AND cabinet.application_enabled = 1
      AND settings.id = 1 AND settings.enabled = 1
      AND settings.lifecycle_enabled = 1 AND settings.crm_enabled = 1
      AND settings.notes_enabled = 1
  ) THEN RAISE(ABORT, 'application note gate is closed') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_applications application
    WHERE application.application_id = NEW.application_id
      AND application.owner_partner_profile_id = NEW.owner_partner_profile_id
      AND application.revision = NEW.application_revision
      AND application.current_status != 'archived'
      AND NEW.occurred_at >= application.updated_at
      AND (
        (NEW.author_role = 'partner' AND EXISTS (
          SELECT 1 FROM partner_profiles profile
          JOIN user_roles role ON role.telegram_id = profile.telegram_id
          WHERE profile.id = application.owner_partner_profile_id
            AND profile.telegram_id = NEW.author_telegram_id
            AND profile.status = 'active'
            AND role.role = 'partner' AND role.status = 'active'
        ))
        OR
        (NEW.author_role = 'admin' AND EXISTS (
          SELECT 1 FROM user_roles role
          WHERE role.telegram_id = NEW.author_telegram_id
            AND role.role = 'admin' AND role.status = 'active'
        ))
      )
  ) THEN RAISE(ABORT, 'application note actor or revision mismatch') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM cabinet_capability_grants grant_row
    JOIN cabinet_applications application
      ON application.application_id = NEW.application_id
    WHERE grant_row.actor_telegram_id = NEW.author_telegram_id
      AND grant_row.capability_code = 'application.update'
      AND grant_row.effect = 'deny'
      AND grant_row.starts_at <= NEW.occurred_at
      AND (grant_row.expires_at IS NULL OR grant_row.expires_at > NEW.occurred_at)
      AND (
        grant_row.scope_rule = 'global'
        OR (grant_row.scope_rule = 'resource'
          AND grant_row.resource_id = application.resource_id)
        OR (NEW.author_role = 'partner'
          AND grant_row.scope_rule IN ('self', 'partner_owner'))
      )
      AND NOT EXISTS (
        SELECT 1 FROM cabinet_capability_grant_revocations revocation
        WHERE revocation.grant_id = grant_row.grant_id
          AND revocation.revoked_at <= NEW.occurred_at
      )
  ) THEN RAISE(ABORT, 'application update capability denied') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_note_event
AFTER INSERT ON cabinet_application_notes_private
BEGIN
  INSERT INTO cabinet_application_events (
    event_id, application_id, event_kind, status_from, status_to,
    actor_role, action_source, actor_key_hash, data_hash, request_hash,
    revision_before, revision_after, idempotency_key, occurred_at
  ) VALUES (
    NEW.event_id, NEW.application_id, 'note_added', NULL, NULL,
    NEW.author_role, NEW.action_source, NEW.actor_key_hash,
    NEW.note_hash, NEW.request_hash,
    NEW.application_revision, NEW.application_revision,
    NEW.idempotency_key, NEW.occurred_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_notes_no_update
BEFORE UPDATE ON cabinet_application_notes_private
BEGIN
  SELECT RAISE(ABORT, 'application notes are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_application_notes_guarded_delete
BEFORE DELETE ON cabinet_application_notes_private
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_privacy_maintenance_guard guard
  JOIN cabinet_applications application
    ON application.application_id = OLD.application_id
  WHERE guard.id = 1 AND guard.reason = 'user_deletion'
    AND guard.expires_at >= unixepoch()
    AND guard.subject_telegram_id IN (
      application.subject_telegram_id, OLD.author_telegram_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'application note deletion requires privacy guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_assignment_idempotency
BEFORE INSERT ON cabinet_application_assignment_receipts
WHEN EXISTS (
  SELECT 1 FROM cabinet_application_assignment_receipts existing
  WHERE existing.idempotency_key = NEW.idempotency_key
    AND (existing.assignment_receipt_id != NEW.assignment_receipt_id
      OR existing.event_id != NEW.event_id
      OR existing.application_id != NEW.application_id
      OR existing.expected_revision != NEW.expected_revision
      OR existing.to_assignee_telegram_id IS NOT NEW.to_assignee_telegram_id
      OR existing.actor_telegram_id != NEW.actor_telegram_id
      OR existing.actor_role != NEW.actor_role
      OR existing.action_source != NEW.action_source
      OR existing.request_hash != NEW.request_hash)
)
BEGIN
  SELECT RAISE(ABORT, 'application assignment idempotency mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_assignment_validate
BEFORE INSERT ON cabinet_application_assignment_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_application_assignment_receipts existing
  WHERE existing.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_v1_settings cabinet,
      cabinet_application_v1_settings settings
    WHERE cabinet.id = 1 AND cabinet.rollout_mode = 'admin_shadow'
      AND cabinet.master_enabled = 1 AND cabinet.application_enabled = 1
      AND settings.id = 1 AND settings.enabled = 1
      AND settings.lifecycle_enabled = 1 AND settings.crm_enabled = 1
      AND settings.assignment_enabled = 1
  ) THEN RAISE(ABORT, 'application assignment gate is closed') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_applications application
    JOIN cabinet_application_assignments assignment
      ON assignment.application_id = application.application_id
    JOIN partner_profiles owner_profile
      ON owner_profile.id = application.owner_partner_profile_id
    WHERE application.application_id = NEW.application_id
      AND application.owner_partner_profile_id = NEW.owner_partner_profile_id
      AND application.current_status != 'archived'
      AND assignment.revision = NEW.expected_revision
      AND assignment.assignee_telegram_id IS NEW.from_assignee_telegram_id
      AND NEW.revision_after = assignment.revision + 1
      AND NEW.occurred_at >= assignment.updated_at
      AND (NEW.to_assignee_telegram_id IS NULL
        OR NEW.to_assignee_telegram_id = owner_profile.telegram_id)
      AND (
        (NEW.actor_role = 'partner'
          AND owner_profile.telegram_id = NEW.actor_telegram_id
          AND owner_profile.status = 'active'
          AND EXISTS (
            SELECT 1 FROM user_roles role
            WHERE role.telegram_id = NEW.actor_telegram_id
              AND role.role = 'partner' AND role.status = 'active'
          ))
        OR
        (NEW.actor_role = 'admin' AND EXISTS (
          SELECT 1 FROM user_roles role
          WHERE role.telegram_id = NEW.actor_telegram_id
            AND role.role = 'admin' AND role.status = 'active'
        ))
      )
  ) THEN RAISE(ABORT, 'application assignment authority mismatch') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM cabinet_capability_grants grant_row
    JOIN cabinet_applications application
      ON application.application_id = NEW.application_id
    WHERE grant_row.actor_telegram_id = NEW.actor_telegram_id
      AND grant_row.capability_code = 'application.update'
      AND grant_row.effect = 'deny'
      AND grant_row.starts_at <= NEW.occurred_at
      AND (grant_row.expires_at IS NULL OR grant_row.expires_at > NEW.occurred_at)
      AND (
        grant_row.scope_rule = 'global'
        OR (grant_row.scope_rule = 'resource'
          AND grant_row.resource_id = application.resource_id)
        OR (NEW.actor_role = 'partner'
          AND grant_row.scope_rule IN ('self', 'partner_owner'))
      )
      AND NOT EXISTS (
        SELECT 1 FROM cabinet_capability_grant_revocations revocation
        WHERE revocation.grant_id = grant_row.grant_id
          AND revocation.revoked_at <= NEW.occurred_at
      )
  ) THEN RAISE(ABORT, 'application update capability denied') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_assignment_apply
AFTER INSERT ON cabinet_application_assignment_receipts
BEGIN
  UPDATE cabinet_application_assignments
  SET assignee_telegram_id = NEW.to_assignee_telegram_id,
      revision = NEW.revision_after,
      last_assignment_receipt_id = NEW.assignment_receipt_id,
      updated_at = NEW.occurred_at
  WHERE application_id = NEW.application_id
    AND revision = NEW.expected_revision
    AND assignee_telegram_id IS NEW.from_assignee_telegram_id;

  INSERT INTO cabinet_application_events (
    event_id, application_id, event_kind, status_from, status_to,
    actor_role, action_source, actor_key_hash, data_hash, request_hash,
    revision_before, revision_after, idempotency_key, occurred_at
  ) VALUES (
    NEW.event_id, NEW.application_id, 'assignment_changed', NULL, NULL,
    NEW.actor_role, NEW.action_source, NEW.actor_key_hash,
    NEW.after_hash, NEW.request_hash,
    NEW.expected_revision, NEW.revision_after,
    NEW.idempotency_key, NEW.occurred_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_assignments_update_guard
BEFORE UPDATE ON cabinet_application_assignments
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_application_assignment_receipts receipt
  WHERE receipt.assignment_receipt_id = NEW.last_assignment_receipt_id
    AND receipt.application_id = OLD.application_id
    AND receipt.owner_partner_profile_id = OLD.owner_partner_profile_id
    AND receipt.expected_revision = OLD.revision
    AND receipt.revision_after = NEW.revision
    AND receipt.from_assignee_telegram_id IS OLD.assignee_telegram_id
    AND receipt.to_assignee_telegram_id IS NEW.assignee_telegram_id
    AND receipt.occurred_at = NEW.updated_at
    AND NEW.application_id = OLD.application_id
    AND NEW.owner_partner_profile_id = OLD.owner_partner_profile_id
    AND NEW.created_at = OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'assignment update requires exact receipt');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_assignments_no_delete
BEFORE DELETE ON cabinet_application_assignments
BEGIN
  SELECT RAISE(ABORT, 'application assignments cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_assignment_receipts_no_update
BEFORE UPDATE ON cabinet_application_assignment_receipts
BEGIN
  SELECT RAISE(ABORT, 'application assignment receipts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_assignment_receipts_no_delete
BEFORE DELETE ON cabinet_application_assignment_receipts
BEGIN
  SELECT RAISE(ABORT, 'application assignment receipts cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_result_idempotency
BEFORE INSERT ON cabinet_application_results
WHEN EXISTS (
  SELECT 1 FROM cabinet_application_results existing
  WHERE existing.idempotency_key = NEW.idempotency_key
    AND (existing.result_id != NEW.result_id
      OR existing.event_id != NEW.event_id
      OR existing.application_id != NEW.application_id
      OR existing.result_hash != NEW.result_hash
      OR existing.actor_telegram_id != NEW.actor_telegram_id
      OR existing.actor_role != NEW.actor_role
      OR existing.action_source != NEW.action_source
      OR existing.request_hash != NEW.request_hash)
)
BEGIN
  SELECT RAISE(ABORT, 'application result idempotency mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_result_validate
BEFORE INSERT ON cabinet_application_results
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_application_results existing
  WHERE existing.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_v1_settings cabinet,
      cabinet_application_v1_settings settings
    WHERE cabinet.id = 1 AND cabinet.rollout_mode = 'admin_shadow'
      AND cabinet.master_enabled = 1 AND cabinet.application_enabled = 1
      AND settings.id = 1 AND settings.enabled = 1
      AND settings.lifecycle_enabled = 1 AND settings.crm_enabled = 1
      AND settings.result_enabled = 1
  ) THEN RAISE(ABORT, 'application result gate is closed') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_applications application
    WHERE application.application_id = NEW.application_id
      AND application.owner_partner_profile_id = NEW.owner_partner_profile_id
      AND application.revision = NEW.application_revision
      AND application.current_status = NEW.terminal_status
      AND ((NEW.terminal_status = 'completed' AND NEW.result_code = 'successful')
        OR (NEW.terminal_status = 'rejected'
          AND NEW.result_code = 'unsuccessful')
        OR (NEW.terminal_status = 'cancelled'
          AND NEW.result_code = 'cancelled'))
      AND NEW.occurred_at >= application.updated_at
      AND (
        (NEW.actor_role = 'partner' AND EXISTS (
          SELECT 1 FROM partner_profiles profile
          JOIN user_roles role ON role.telegram_id = profile.telegram_id
          WHERE profile.id = application.owner_partner_profile_id
            AND profile.telegram_id = NEW.actor_telegram_id
            AND profile.status = 'active'
            AND role.role = 'partner' AND role.status = 'active'
        ))
        OR
        (NEW.actor_role = 'admin' AND EXISTS (
          SELECT 1 FROM user_roles role
          WHERE role.telegram_id = NEW.actor_telegram_id
            AND role.role = 'admin' AND role.status = 'active'
        ))
      )
  ) THEN RAISE(ABORT, 'application result authority mismatch') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM cabinet_capability_grants grant_row
    JOIN cabinet_applications application
      ON application.application_id = NEW.application_id
    WHERE grant_row.actor_telegram_id = NEW.actor_telegram_id
      AND grant_row.capability_code = 'application.update'
      AND grant_row.effect = 'deny'
      AND grant_row.starts_at <= NEW.occurred_at
      AND (grant_row.expires_at IS NULL OR grant_row.expires_at > NEW.occurred_at)
      AND (
        grant_row.scope_rule = 'global'
        OR (grant_row.scope_rule = 'resource'
          AND grant_row.resource_id = application.resource_id)
        OR (NEW.actor_role = 'partner'
          AND grant_row.scope_rule IN ('self', 'partner_owner'))
      )
      AND NOT EXISTS (
        SELECT 1 FROM cabinet_capability_grant_revocations revocation
        WHERE revocation.grant_id = grant_row.grant_id
          AND revocation.revoked_at <= NEW.occurred_at
      )
  ) THEN RAISE(ABORT, 'application update capability denied') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_result_event
AFTER INSERT ON cabinet_application_results
BEGIN
  INSERT INTO cabinet_application_events (
    event_id, application_id, event_kind, status_from, status_to,
    actor_role, action_source, actor_key_hash, data_hash, request_hash,
    revision_before, revision_after, idempotency_key, occurred_at
  ) VALUES (
    NEW.event_id, NEW.application_id, 'result_recorded', NULL, NULL,
    NEW.actor_role, NEW.action_source, NEW.actor_key_hash,
    NEW.after_hash, NEW.request_hash,
    NEW.application_revision, NEW.application_revision,
    NEW.idempotency_key, NEW.occurred_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_results_no_update
BEFORE UPDATE ON cabinet_application_results
BEGIN
  SELECT RAISE(ABORT, 'application results are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_results_no_delete
BEFORE DELETE ON cabinet_application_results
BEGIN
  SELECT RAISE(ABORT, 'application results cannot be deleted');
END;

INSERT OR IGNORE INTO re_schema_migrations(version)
VALUES ('0045-v1.4.0-applications-crm');
