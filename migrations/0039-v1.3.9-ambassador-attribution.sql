-- RE Program Bot v1.3.9 Part 3
-- Ambassador 2.0 identity, campaigns and exact attribution.
-- Additive and dormant: this migration does not enable any runtime flag.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ambassador_profiles_v2 (
  ambassador_id TEXT PRIMARY KEY CHECK (
    length(ambassador_id) = 36 AND ambassador_id = lower(ambassador_id)
  ),
  partner_profile_id INTEGER NOT NULL UNIQUE
    REFERENCES partner_profiles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  owner_pseudonym TEXT NOT NULL CHECK (
    length(owner_pseudonym) = 64
    AND owner_pseudonym = lower(owner_pseudonym)
    AND owner_pseudonym NOT GLOB '*[^0-9a-f]*'
  ),
  pseudonym_key_version INTEGER NOT NULL CHECK (pseudonym_key_version > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'active', 'paused', 'suspended', 'archived'
  )),
  eligibility_evidence_hash TEXT NOT NULL CHECK (
    length(eligibility_evidence_hash) = 64
    AND eligibility_evidence_hash = lower(eligibility_evidence_hash)
    AND eligibility_evidence_hash NOT GLOB '*[^0-9a-f]*'
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  activated_at INTEGER CHECK (activated_at IS NULL OR activated_at > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (status = 'draft' AND activated_at IS NULL)
    OR (status IN ('active', 'paused', 'suspended') AND activated_at IS NOT NULL)
    OR status = 'archived'
  )
);

CREATE INDEX IF NOT EXISTS idx_ambassador_profiles_v2_status
  ON ambassador_profiles_v2(status, updated_at, ambassador_id);

CREATE INDEX IF NOT EXISTS idx_ambassador_profiles_v2_owner
  ON ambassador_profiles_v2(owner_pseudonym, ambassador_id);

CREATE TABLE IF NOT EXISTS ambassador_profile_transitions (
  transition_id TEXT PRIMARY KEY CHECK (
    length(transition_id) = 36 AND transition_id = lower(transition_id)
  ),
  transition_key TEXT NOT NULL UNIQUE CHECK (
    length(transition_key) = 64
    AND transition_key = lower(transition_key)
    AND transition_key NOT GLOB '*[^0-9a-f]*'
  ),
  ambassador_id TEXT NOT NULL
    REFERENCES ambassador_profiles_v2(ambassador_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 2),
  from_status TEXT NOT NULL CHECK (from_status IN (
    'draft', 'active', 'paused', 'suspended'
  )),
  to_status TEXT NOT NULL CHECK (to_status IN (
    'active', 'paused', 'suspended', 'archived'
  )),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'activation_approved', 'admin_paused', 'admin_resumed',
    'moderation_suspended', 'eligibility_expired',
    'eligibility_restored', 'admin_archived'
  )),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin', 'system')),
  evidence_hash TEXT NOT NULL CHECK (
    length(evidence_hash) = 64
    AND evidence_hash = lower(evidence_hash)
    AND evidence_hash NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= occurred_at),
  UNIQUE (ambassador_id, profile_revision),
  CHECK (from_status != to_status),
  CHECK (
    (from_status = 'draft' AND to_status = 'active'
      AND reason_code = 'activation_approved')
    OR (from_status = 'active' AND to_status = 'paused'
      AND reason_code = 'admin_paused')
    OR (from_status = 'paused' AND to_status = 'active'
      AND reason_code = 'admin_resumed')
    OR (from_status IN ('active', 'paused') AND to_status = 'suspended'
      AND reason_code IN ('moderation_suspended', 'eligibility_expired'))
    OR (from_status = 'suspended' AND to_status = 'active'
      AND reason_code = 'eligibility_restored')
    OR (to_status = 'archived' AND reason_code = 'admin_archived')
  ),
  CHECK (
    (reason_code IN ('activation_approved', 'moderation_suspended',
      'eligibility_expired', 'eligibility_restored')
      AND actor_kind IN ('admin', 'system'))
    OR (reason_code IN ('admin_paused', 'admin_resumed', 'admin_archived')
      AND actor_kind = 'admin')
  )
);

CREATE INDEX IF NOT EXISTS idx_ambassador_profile_transitions_time
  ON ambassador_profile_transitions(ambassador_id, occurred_at, transition_id);

CREATE INDEX IF NOT EXISTS idx_ambassador_profile_transitions_reason
  ON ambassador_profile_transitions(reason_code, occurred_at, transition_id);

CREATE TABLE IF NOT EXISTS ambassador_campaigns (
  campaign_id TEXT PRIMARY KEY CHECK (
    length(campaign_id) = 36 AND campaign_id = lower(campaign_id)
  ),
  ambassador_id TEXT NOT NULL
    REFERENCES ambassador_profiles_v2(ambassador_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('program', 'offer')),
  program_code TEXT NOT NULL
    REFERENCES partner_programs(code) ON UPDATE RESTRICT ON DELETE RESTRICT,
  catalog_offer_id INTEGER
    REFERENCES program_offers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'active', 'paused', 'archived'
  )),
  scope_evidence_hash TEXT NOT NULL CHECK (
    length(scope_evidence_hash) = 64
    AND scope_evidence_hash = lower(scope_evidence_hash)
    AND scope_evidence_hash NOT GLOB '*[^0-9a-f]*'
  ),
  starts_at INTEGER NOT NULL CHECK (starts_at > 0),
  ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  activated_at INTEGER CHECK (activated_at IS NULL OR activated_at > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (scope_kind = 'program' AND catalog_offer_id IS NULL)
    OR (scope_kind = 'offer' AND catalog_offer_id IS NOT NULL)
  ),
  CHECK (
    (status = 'draft' AND activated_at IS NULL)
    OR (status IN ('active', 'paused') AND activated_at IS NOT NULL)
    OR status = 'archived'
  ),
  UNIQUE (ambassador_id, program_code, catalog_offer_id, starts_at)
);

CREATE INDEX IF NOT EXISTS idx_ambassador_campaigns_owner_status
  ON ambassador_campaigns(ambassador_id, status, starts_at, ends_at);

CREATE INDEX IF NOT EXISTS idx_ambassador_campaigns_program_status
  ON ambassador_campaigns(program_code, status, starts_at, ends_at);

CREATE INDEX IF NOT EXISTS idx_ambassador_campaigns_offer_status
  ON ambassador_campaigns(catalog_offer_id, status, starts_at, ends_at)
  WHERE catalog_offer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ambassador_campaigns_program_identity
  ON ambassador_campaigns(ambassador_id, program_code, starts_at)
  WHERE scope_kind = 'program';

CREATE TABLE IF NOT EXISTS ambassador_campaign_transitions (
  transition_id TEXT PRIMARY KEY CHECK (
    length(transition_id) = 36 AND transition_id = lower(transition_id)
  ),
  transition_key TEXT NOT NULL UNIQUE CHECK (
    length(transition_key) = 64
    AND transition_key = lower(transition_key)
    AND transition_key NOT GLOB '*[^0-9a-f]*'
  ),
  campaign_id TEXT NOT NULL REFERENCES ambassador_campaigns(campaign_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  campaign_revision INTEGER NOT NULL CHECK (campaign_revision >= 2),
  from_status TEXT NOT NULL CHECK (from_status IN (
    'draft', 'active', 'paused'
  )),
  to_status TEXT NOT NULL CHECK (to_status IN (
    'active', 'paused', 'archived'
  )),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'activation_approved', 'owner_paused', 'admin_paused',
    'owner_resumed', 'admin_resumed', 'period_ended', 'admin_archived'
  )),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN (
    'ambassador', 'admin', 'system'
  )),
  evidence_hash TEXT NOT NULL CHECK (
    length(evidence_hash) = 64
    AND evidence_hash = lower(evidence_hash)
    AND evidence_hash NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= occurred_at),
  UNIQUE (campaign_id, campaign_revision),
  CHECK (from_status != to_status),
  CHECK (
    (from_status = 'draft' AND to_status = 'active'
      AND reason_code = 'activation_approved'
      AND actor_kind IN ('admin', 'system'))
    OR (from_status = 'active' AND to_status = 'paused'
      AND reason_code IN ('owner_paused', 'admin_paused'))
    OR (from_status = 'paused' AND to_status = 'active'
      AND reason_code IN ('owner_resumed', 'admin_resumed'))
    OR (to_status = 'archived'
      AND reason_code IN ('period_ended', 'admin_archived'))
  ),
  CHECK (
    (reason_code IN ('owner_paused', 'owner_resumed')
      AND actor_kind = 'ambassador')
    OR (reason_code IN ('admin_paused', 'admin_resumed', 'admin_archived')
      AND actor_kind = 'admin')
    OR (reason_code = 'activation_approved'
      AND actor_kind IN ('admin', 'system'))
    OR (reason_code = 'period_ended' AND actor_kind = 'system')
  )
);

CREATE INDEX IF NOT EXISTS idx_ambassador_campaign_transitions_time
  ON ambassador_campaign_transitions(campaign_id, occurred_at, transition_id);

CREATE TABLE IF NOT EXISTS ambassador_tracking_codes (
  tracking_code_hash TEXT PRIMARY KEY CHECK (
    length(tracking_code_hash) = 64
    AND tracking_code_hash = lower(tracking_code_hash)
    AND tracking_code_hash NOT GLOB '*[^0-9a-f]*'
  ),
  code_version INTEGER NOT NULL DEFAULT 1 CHECK (code_version = 1),
  campaign_id TEXT NOT NULL REFERENCES ambassador_campaigns(campaign_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ambassador_id TEXT NOT NULL
    REFERENCES ambassador_profiles_v2(ambassador_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  partner_link_id INTEGER NOT NULL REFERENCES partner_links(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  authority_evidence_hash TEXT NOT NULL CHECK (
    length(authority_evidence_hash) = 64
    AND authority_evidence_hash = lower(authority_evidence_hash)
    AND authority_evidence_hash NOT GLOB '*[^0-9a-f]*'
  ),
  issued_at INTEGER NOT NULL CHECK (issued_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  created_at INTEGER NOT NULL CHECK (created_at >= issued_at),
  UNIQUE (campaign_id, partner_link_id, tracking_code_hash)
);

CREATE INDEX IF NOT EXISTS idx_ambassador_tracking_codes_campaign
  ON ambassador_tracking_codes(campaign_id, expires_at, tracking_code_hash);

CREATE INDEX IF NOT EXISTS idx_ambassador_tracking_codes_partner_link
  ON ambassador_tracking_codes(partner_link_id, expires_at, tracking_code_hash);

CREATE TABLE IF NOT EXISTS ambassador_tracking_code_revocations (
  tracking_code_hash TEXT PRIMARY KEY
    REFERENCES ambassador_tracking_codes(tracking_code_hash)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'owner_revoked', 'admin_revoked', 'campaign_closed', 'security_review'
  )),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('ambassador', 'admin', 'system')),
  evidence_hash TEXT NOT NULL CHECK (
    length(evidence_hash) = 64
    AND evidence_hash = lower(evidence_hash)
    AND evidence_hash NOT GLOB '*[^0-9a-f]*'
  ),
  revoked_at INTEGER NOT NULL CHECK (revoked_at > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= revoked_at)
);

CREATE TABLE IF NOT EXISTS analytics_attribution_touchpoints (
  touchpoint_id TEXT PRIMARY KEY CHECK (
    length(touchpoint_id) = 36 AND touchpoint_id = lower(touchpoint_id)
  ),
  touchpoint_key TEXT NOT NULL UNIQUE CHECK (
    length(touchpoint_key) = 64
    AND touchpoint_key = lower(touchpoint_key)
    AND touchpoint_key NOT GLOB '*[^0-9a-f]*'
  ),
  actor_pseudonym TEXT NOT NULL CHECK (
    length(actor_pseudonym) = 64
    AND actor_pseudonym = lower(actor_pseudonym)
    AND actor_pseudonym NOT GLOB '*[^0-9a-f]*'
  ),
  pseudonym_key_version INTEGER NOT NULL CHECK (pseudonym_key_version > 0),
  tracking_code_hash TEXT NOT NULL
    REFERENCES ambassador_tracking_codes(tracking_code_hash)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ambassador_id TEXT NOT NULL
    REFERENCES ambassador_profiles_v2(ambassador_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  campaign_id TEXT NOT NULL REFERENCES ambassador_campaigns(campaign_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  partner_link_id INTEGER NOT NULL REFERENCES partner_links(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_evidence_hash TEXT NOT NULL CHECK (
    length(source_evidence_hash) = 64
    AND source_evidence_hash = lower(source_evidence_hash)
    AND source_evidence_hash NOT GLOB '*[^0-9a-f]*'
  ),
  origin TEXT NOT NULL CHECK (origin IN ('live', 'backfill', 'reconciliation')),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  valid_until INTEGER NOT NULL CHECK (valid_until = occurred_at + 2592000),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= occurred_at),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= recorded_at
    AND retention_until <= recorded_at + 15552000
  )
);

CREATE INDEX IF NOT EXISTS idx_attribution_touchpoints_actor_time
  ON analytics_attribution_touchpoints(
    actor_pseudonym, occurred_at, touchpoint_id
  );

CREATE INDEX IF NOT EXISTS idx_attribution_touchpoints_campaign_time
  ON analytics_attribution_touchpoints(campaign_id, occurred_at, touchpoint_id);

CREATE INDEX IF NOT EXISTS idx_attribution_touchpoints_ambassador_time
  ON analytics_attribution_touchpoints(
    ambassador_id, occurred_at, touchpoint_id
  );

CREATE INDEX IF NOT EXISTS idx_attribution_touchpoints_retention
  ON analytics_attribution_touchpoints(retention_until, touchpoint_id);

CREATE TABLE IF NOT EXISTS analytics_attribution_decisions (
  decision_id TEXT PRIMARY KEY CHECK (
    length(decision_id) = 36 AND decision_id = lower(decision_id)
  ),
  decision_key TEXT NOT NULL UNIQUE CHECK (
    length(decision_key) = 64
    AND decision_key = lower(decision_key)
    AND decision_key NOT GLOB '*[^0-9a-f]*'
  ),
  actor_pseudonym TEXT NOT NULL CHECK (
    length(actor_pseudonym) = 64
    AND actor_pseudonym = lower(actor_pseudonym)
    AND actor_pseudonym NOT GLOB '*[^0-9a-f]*'
  ),
  pseudonym_key_version INTEGER NOT NULL CHECK (pseudonym_key_version > 0),
  attribution_kind TEXT NOT NULL CHECK (attribution_kind IN (
    'relationship', 'engagement', 'commercial'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'attributed', 'unattributed', 'rejected'
  )),
  ambassador_id TEXT REFERENCES ambassador_profiles_v2(ambassador_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  campaign_id TEXT REFERENCES ambassador_campaigns(campaign_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  touchpoint_id TEXT REFERENCES analytics_attribution_touchpoints(touchpoint_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  authority_kind TEXT NOT NULL CHECK (authority_kind IN (
    'first_inviter', 'verified_touchpoint', 'lead_partner_attribution',
    'stars_access', 'referral_reward'
  )),
  authority_evidence_hash TEXT NOT NULL CHECK (
    length(authority_evidence_hash) = 64
    AND authority_evidence_hash = lower(authority_evidence_hash)
    AND authority_evidence_hash NOT GLOB '*[^0-9a-f]*'
  ),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'attributed_exact', 'no_exact_evidence', 'self_attribution',
    'owner_mismatch', 'cycle_detected', 'campaign_inactive',
    'campaign_expired', 'window_expired', 'source_unknown',
    'authority_status_invalid'
  )),
  model_version INTEGER NOT NULL DEFAULT 1 CHECK (model_version = 1),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  decided_at INTEGER NOT NULL CHECK (decided_at >= occurred_at),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= decided_at
    AND retention_until <= decided_at + 15552000
  ),
  CHECK (
    (attribution_kind = 'relationship'
      AND authority_kind = 'first_inviter'
      AND campaign_id IS NULL AND touchpoint_id IS NULL)
    OR (attribution_kind = 'engagement'
      AND authority_kind = 'verified_touchpoint')
    OR (attribution_kind = 'commercial'
      AND authority_kind IN (
        'lead_partner_attribution', 'stars_access', 'referral_reward'
      ))
  ),
  CHECK (
    (outcome = 'attributed' AND ambassador_id IS NOT NULL
      AND reason_code = 'attributed_exact')
    OR (outcome != 'attributed' AND reason_code != 'attributed_exact')
  ),
  CHECK (
    attribution_kind != 'engagement'
    OR outcome != 'attributed'
    OR (campaign_id IS NOT NULL AND touchpoint_id IS NOT NULL)
  ),
  CHECK (
    attribution_kind != 'commercial'
    OR outcome != 'attributed'
    OR campaign_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_attribution_decisions_actor_time
  ON analytics_attribution_decisions(
    actor_pseudonym, attribution_kind, occurred_at, decision_id
  );

CREATE INDEX IF NOT EXISTS idx_attribution_decisions_kind_outcome
  ON analytics_attribution_decisions(
    attribution_kind, outcome, occurred_at, decision_id
  );

CREATE INDEX IF NOT EXISTS idx_attribution_decisions_ambassador_time
  ON analytics_attribution_decisions(
    ambassador_id, attribution_kind, occurred_at, decision_id
  );

CREATE INDEX IF NOT EXISTS idx_attribution_decisions_retention
  ON analytics_attribution_decisions(retention_until, decision_id);

CREATE TABLE IF NOT EXISTS analytics_attribution_privacy_inventory (
  dataset_name TEXT PRIMARY KEY CHECK (dataset_name IN (
    'ambassador_profiles_v2', 'ambassador_profile_transitions',
    'ambassador_campaigns', 'ambassador_campaign_transitions',
    'ambassador_tracking_codes', 'ambassador_tracking_code_revocations',
    'analytics_attribution_touchpoints', 'analytics_attribution_decisions'
  )),
  privacy_class TEXT NOT NULL CHECK (privacy_class IN (
    'pseudonymous', 'non_identifying', 'operational'
  )),
  raw_identifier_columns INTEGER NOT NULL DEFAULT 0
    CHECK (raw_identifier_columns = 0),
  content_columns INTEGER NOT NULL DEFAULT 0 CHECK (content_columns = 0),
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 0 AND 180),
  deletion_mode TEXT NOT NULL CHECK (deletion_mode IN (
    'immutable_contract', 'guarded_subject_or_retention'
  )),
  policy_version TEXT NOT NULL CHECK (
    policy_version = '2026-09-13.analytics-v2-part3'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

INSERT OR IGNORE INTO analytics_attribution_privacy_inventory
  (dataset_name, privacy_class, raw_identifier_columns, content_columns,
   retention_days, deletion_mode, policy_version, created_at)
VALUES
  ('ambassador_profiles_v2', 'pseudonymous', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part3', unixepoch()),
  ('ambassador_profile_transitions', 'operational', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part3', unixepoch()),
  ('ambassador_campaigns', 'non_identifying', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part3', unixepoch()),
  ('ambassador_campaign_transitions', 'operational', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part3', unixepoch()),
  ('ambassador_tracking_codes', 'operational', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part3', unixepoch()),
  ('ambassador_tracking_code_revocations', 'operational', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part3', unixepoch()),
  ('analytics_attribution_touchpoints', 'pseudonymous', 0, 0, 180,
   'guarded_subject_or_retention', '2026-09-13.analytics-v2-part3', unixepoch()),
  ('analytics_attribution_decisions', 'pseudonymous', 0, 0, 180,
   'guarded_subject_or_retention', '2026-09-13.analytics-v2-part3', unixepoch());

CREATE TRIGGER IF NOT EXISTS trg_ambassador_profiles_v2_create_draft
BEFORE INSERT ON ambassador_profiles_v2
WHEN NEW.status != 'draft' OR NEW.revision != 1 OR NEW.activated_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'ambassador profile must start as draft');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_profiles_v2_identity
BEFORE UPDATE ON ambassador_profiles_v2
WHEN NEW.ambassador_id IS NOT OLD.ambassador_id
  OR NEW.partner_profile_id IS NOT OLD.partner_profile_id
  OR NEW.owner_pseudonym IS NOT OLD.owner_pseudonym
  OR NEW.pseudonym_key_version IS NOT OLD.pseudonym_key_version
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS NOT OLD.activated_at)
BEGIN
  SELECT RAISE(ABORT, 'ambassador profile identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_profiles_v2_transition
BEFORE UPDATE ON ambassador_profiles_v2
WHEN NEW.revision != OLD.revision + 1
  OR NEW.status = OLD.status
  OR NEW.updated_at < OLD.updated_at
  OR NOT EXISTS (
    SELECT 1 FROM ambassador_profile_transitions transition
    WHERE transition.ambassador_id = OLD.ambassador_id
      AND transition.profile_revision = NEW.revision
      AND transition.from_status = OLD.status
      AND transition.to_status = NEW.status
      AND transition.evidence_hash = NEW.eligibility_evidence_hash
      AND transition.occurred_at = NEW.updated_at
  )
  OR (
    OLD.status = 'draft'
    AND NOT (
      (NEW.status = 'active' AND NEW.activated_at = NEW.updated_at)
      OR (NEW.status = 'archived' AND NEW.activated_at IS NULL)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'ambassador profile update requires exact transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_profiles_v2_no_delete
BEFORE DELETE ON ambassador_profiles_v2
BEGIN
  SELECT RAISE(ABORT, 'ambassador profiles cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_profile_transition_guard
BEFORE INSERT ON ambassador_profile_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM ambassador_profiles_v2 profile
  WHERE profile.ambassador_id = NEW.ambassador_id
    AND profile.status = NEW.from_status
    AND profile.revision + 1 = NEW.profile_revision
)
BEGIN
  SELECT RAISE(ABORT, 'ambassador transition does not match current profile');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_profile_transition_apply
AFTER INSERT ON ambassador_profile_transitions
BEGIN
  UPDATE ambassador_profiles_v2
  SET status = NEW.to_status,
      eligibility_evidence_hash = NEW.evidence_hash,
      revision = NEW.profile_revision,
      activated_at = CASE
        WHEN NEW.from_status = 'draft' AND NEW.to_status = 'active'
          THEN NEW.occurred_at
        ELSE activated_at
      END,
      updated_at = NEW.occurred_at
  WHERE ambassador_id = NEW.ambassador_id
    AND status = NEW.from_status
    AND revision + 1 = NEW.profile_revision;
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_profile_transitions_no_update
BEFORE UPDATE ON ambassador_profile_transitions
BEGIN
  SELECT RAISE(ABORT, 'ambassador profile transitions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_profile_transitions_no_delete
BEFORE DELETE ON ambassador_profile_transitions
BEGIN
  SELECT RAISE(ABORT, 'ambassador profile transitions cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_campaigns_create_draft
BEFORE INSERT ON ambassador_campaigns
WHEN NEW.status != 'draft' OR NEW.revision != 1 OR NEW.activated_at IS NOT NULL
  OR NOT EXISTS (
    SELECT 1 FROM ambassador_profiles_v2 profile
    WHERE profile.ambassador_id = NEW.ambassador_id
      AND profile.status = 'active'
  )
  OR NOT EXISTS (
    SELECT 1 FROM partner_programs program
    WHERE program.code = NEW.program_code AND program.status = 'active'
  )
  OR (
    NEW.scope_kind = 'offer'
    AND NOT EXISTS (
      SELECT 1 FROM program_offers offer
      WHERE offer.id = NEW.catalog_offer_id
        AND offer.program_code = NEW.program_code
        AND offer.status = 'active'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'ambassador campaign authority is invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_campaigns_identity
BEFORE UPDATE ON ambassador_campaigns
WHEN NEW.campaign_id IS NOT OLD.campaign_id
  OR NEW.ambassador_id IS NOT OLD.ambassador_id
  OR NEW.scope_kind IS NOT OLD.scope_kind
  OR NEW.program_code IS NOT OLD.program_code
  OR NEW.catalog_offer_id IS NOT OLD.catalog_offer_id
  OR NEW.starts_at IS NOT OLD.starts_at
  OR NEW.ends_at IS NOT OLD.ends_at
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS NOT OLD.activated_at)
BEGIN
  SELECT RAISE(ABORT, 'ambassador campaign identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_campaigns_transition
BEFORE UPDATE ON ambassador_campaigns
WHEN NEW.revision != OLD.revision + 1
  OR NEW.status = OLD.status
  OR NEW.updated_at < OLD.updated_at
  OR NOT EXISTS (
    SELECT 1 FROM ambassador_campaign_transitions transition
    WHERE transition.campaign_id = OLD.campaign_id
      AND transition.campaign_revision = NEW.revision
      AND transition.from_status = OLD.status
      AND transition.to_status = NEW.status
      AND transition.evidence_hash = NEW.scope_evidence_hash
      AND transition.occurred_at = NEW.updated_at
  )
  OR (
    OLD.status = 'draft'
    AND NOT (
      (NEW.status = 'active' AND NEW.activated_at = NEW.updated_at)
      OR (NEW.status = 'archived' AND NEW.activated_at IS NULL)
    )
  )
  OR (
    NEW.status = 'active'
    AND (
      NEW.updated_at < NEW.starts_at OR NEW.updated_at > NEW.ends_at
      OR NOT EXISTS (
        SELECT 1 FROM ambassador_profiles_v2 profile
        WHERE profile.ambassador_id = NEW.ambassador_id
          AND profile.status = 'active'
      )
      OR NOT EXISTS (
        SELECT 1 FROM partner_programs program
        WHERE program.code = NEW.program_code
          AND program.status = 'active'
      )
      OR (
        NEW.scope_kind = 'offer'
        AND NOT EXISTS (
          SELECT 1 FROM program_offers offer
          WHERE offer.id = NEW.catalog_offer_id
            AND offer.program_code = NEW.program_code
            AND offer.status = 'active'
        )
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'ambassador campaign update requires exact transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_campaigns_no_delete
BEFORE DELETE ON ambassador_campaigns
BEGIN
  SELECT RAISE(ABORT, 'ambassador campaigns cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_campaign_transition_guard
BEFORE INSERT ON ambassador_campaign_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM ambassador_campaigns campaign
  WHERE campaign.campaign_id = NEW.campaign_id
    AND campaign.status = NEW.from_status
    AND campaign.revision + 1 = NEW.campaign_revision
)
BEGIN
  SELECT RAISE(ABORT, 'campaign transition does not match current campaign');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_campaign_transition_apply
AFTER INSERT ON ambassador_campaign_transitions
BEGIN
  UPDATE ambassador_campaigns
  SET status = NEW.to_status,
      scope_evidence_hash = NEW.evidence_hash,
      revision = NEW.campaign_revision,
      activated_at = CASE
        WHEN NEW.from_status = 'draft' AND NEW.to_status = 'active'
          THEN NEW.occurred_at
        ELSE activated_at
      END,
      updated_at = NEW.occurred_at
  WHERE campaign_id = NEW.campaign_id
    AND status = NEW.from_status
    AND revision + 1 = NEW.campaign_revision;
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_campaign_transitions_no_update
BEFORE UPDATE ON ambassador_campaign_transitions
BEGIN
  SELECT RAISE(ABORT, 'ambassador campaign transitions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_campaign_transitions_no_delete
BEFORE DELETE ON ambassador_campaign_transitions
BEGIN
  SELECT RAISE(ABORT, 'ambassador campaign transitions cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_tracking_codes_authority
BEFORE INSERT ON ambassador_tracking_codes
WHEN NOT EXISTS (
  SELECT 1
  FROM ambassador_campaigns campaign
  JOIN ambassador_profiles_v2 profile
    ON profile.ambassador_id = campaign.ambassador_id
  JOIN partner_links link ON link.id = NEW.partner_link_id
  JOIN program_offers offer ON offer.id = link.catalog_offer_id
  JOIN partner_programs program ON program.code = offer.program_code
  WHERE campaign.campaign_id = NEW.campaign_id
    AND campaign.ambassador_id = NEW.ambassador_id
    AND campaign.status = 'active'
    AND profile.status = 'active'
    AND link.partner_profile_id = profile.partner_profile_id
    AND link.status = 'approved'
    AND link.ownership_confirmed = 1
    AND link.traffic_confirmed = 1
    AND offer.status = 'active'
    AND program.status = 'active'
    AND offer.program_code = campaign.program_code
    AND (
      campaign.scope_kind = 'program'
      OR campaign.catalog_offer_id = link.catalog_offer_id
    )
    AND NEW.issued_at BETWEEN campaign.starts_at AND campaign.ends_at
    AND NEW.expires_at <= campaign.ends_at
)
BEGIN
  SELECT RAISE(ABORT, 'tracking code authority is invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_tracking_codes_no_update
BEFORE UPDATE ON ambassador_tracking_codes
BEGIN
  SELECT RAISE(ABORT, 'ambassador tracking codes are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_tracking_codes_no_delete
BEFORE DELETE ON ambassador_tracking_codes
BEGIN
  SELECT RAISE(ABORT, 'ambassador tracking codes cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_tracking_revocations_guard
BEFORE INSERT ON ambassador_tracking_code_revocations
WHEN NOT EXISTS (
  SELECT 1 FROM ambassador_tracking_codes code
  WHERE code.tracking_code_hash = NEW.tracking_code_hash
    AND NEW.revoked_at >= code.issued_at
)
BEGIN
  SELECT RAISE(ABORT, 'tracking revocation authority is invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_tracking_revocations_no_update
BEFORE UPDATE ON ambassador_tracking_code_revocations
BEGIN
  SELECT RAISE(ABORT, 'tracking code revocations are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_tracking_revocations_no_delete
BEFORE DELETE ON ambassador_tracking_code_revocations
BEGIN
  SELECT RAISE(ABORT, 'tracking code revocations cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_attribution_touchpoints_authority
BEFORE INSERT ON analytics_attribution_touchpoints
WHEN NOT EXISTS (
  SELECT 1
  FROM ambassador_tracking_codes code
  JOIN ambassador_campaigns campaign
    ON campaign.campaign_id = code.campaign_id
  JOIN ambassador_profiles_v2 profile
    ON profile.ambassador_id = code.ambassador_id
  JOIN partner_links link ON link.id = code.partner_link_id
  WHERE code.tracking_code_hash = NEW.tracking_code_hash
    AND code.campaign_id = NEW.campaign_id
    AND code.ambassador_id = NEW.ambassador_id
    AND code.partner_link_id = NEW.partner_link_id
    AND profile.owner_pseudonym != NEW.actor_pseudonym
    AND profile.pseudonym_key_version = NEW.pseudonym_key_version
    AND profile.status = 'active'
    AND campaign.status = 'active'
    AND link.partner_profile_id = profile.partner_profile_id
    AND link.status = 'approved'
    AND link.ownership_confirmed = 1
    AND link.traffic_confirmed = 1
    AND NEW.occurred_at BETWEEN code.issued_at AND code.expires_at
    AND NEW.occurred_at BETWEEN campaign.starts_at AND campaign.ends_at
    AND NOT EXISTS (
      SELECT 1 FROM ambassador_tracking_code_revocations revocation
      WHERE revocation.tracking_code_hash = code.tracking_code_hash
        AND revocation.revoked_at <= NEW.occurred_at
    )
)
BEGIN
  SELECT RAISE(ABORT, 'attribution touchpoint authority is invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_attribution_touchpoints_no_update
BEFORE UPDATE ON analytics_attribution_touchpoints
BEGIN
  SELECT RAISE(ABORT, 'attribution touchpoints are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_attribution_touchpoints_guarded_delete
BEFORE DELETE ON analytics_attribution_touchpoints
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_privacy_maintenance_guard guard
  WHERE guard.id = 1
    AND guard.expires_at >= unixepoch()
    AND (
      (guard.reason = 'retention' AND OLD.retention_until <= unixepoch())
      OR (guard.reason = 'user_deletion'
        AND guard.subject_pseudonym = OLD.actor_pseudonym)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'attribution touchpoint deletion requires privacy guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_attribution_decisions_authority
BEFORE INSERT ON analytics_attribution_decisions
WHEN NEW.outcome = 'attributed' AND (
  NOT EXISTS (
    SELECT 1 FROM ambassador_profiles_v2 profile
    WHERE profile.ambassador_id = NEW.ambassador_id
      AND profile.owner_pseudonym != NEW.actor_pseudonym
      AND profile.pseudonym_key_version = NEW.pseudonym_key_version
  )
  OR (
    NEW.attribution_kind = 'engagement'
    AND NOT EXISTS (
      SELECT 1 FROM analytics_attribution_touchpoints touchpoint
      WHERE touchpoint.touchpoint_id = NEW.touchpoint_id
        AND touchpoint.actor_pseudonym = NEW.actor_pseudonym
        AND touchpoint.ambassador_id = NEW.ambassador_id
        AND touchpoint.campaign_id = NEW.campaign_id
        AND touchpoint.occurred_at <= NEW.occurred_at
        AND touchpoint.valid_until >= NEW.occurred_at
    )
  )
  OR (
    NEW.campaign_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM ambassador_campaigns campaign
      WHERE campaign.campaign_id = NEW.campaign_id
        AND campaign.ambassador_id = NEW.ambassador_id
        AND NEW.occurred_at BETWEEN campaign.starts_at AND campaign.ends_at
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'attribution decision authority is invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_attribution_decisions_no_update
BEFORE UPDATE ON analytics_attribution_decisions
BEGIN
  SELECT RAISE(ABORT, 'attribution decisions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_attribution_decisions_guarded_delete
BEFORE DELETE ON analytics_attribution_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_privacy_maintenance_guard guard
  WHERE guard.id = 1
    AND guard.expires_at >= unixepoch()
    AND (
      (guard.reason = 'retention' AND OLD.retention_until <= unixepoch())
      OR (guard.reason = 'user_deletion'
        AND guard.subject_pseudonym = OLD.actor_pseudonym)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'attribution decision deletion requires privacy guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_attribution_privacy_inventory_no_update
BEFORE UPDATE ON analytics_attribution_privacy_inventory
BEGIN
  SELECT RAISE(ABORT, 'attribution privacy inventory is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_attribution_privacy_inventory_no_delete
BEFORE DELETE ON analytics_attribution_privacy_inventory
BEGIN
  SELECT RAISE(ABORT, 'attribution privacy inventory cannot be deleted');
END;

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.9-ambassador-attribution');
