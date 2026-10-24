-- RE Program Bot v1.4.0 Part 2 — offers, Preview, moderation and promotions.
--
-- Additive and idempotent. Existing Partner Beta tables remain the canonical
-- offer, version, moderation and visibility authority. Every switch added here
-- starts disabled. This migration does not wire the production Worker, apply
-- itself to remote D1, publish a Mini App, charge Stars or grant access.

CREATE TABLE IF NOT EXISTS re_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cabinet_offer_v1_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  lifecycle_enabled INTEGER NOT NULL DEFAULT 0 CHECK (lifecycle_enabled IN (0, 1)),
  preview_enabled INTEGER NOT NULL DEFAULT 0 CHECK (preview_enabled IN (0, 1)),
  moderation_enabled INTEGER NOT NULL DEFAULT 0 CHECK (moderation_enabled IN (0, 1)),
  publication_enabled INTEGER NOT NULL DEFAULT 0 CHECK (publication_enabled IN (0, 1)),
  promotions_enabled INTEGER NOT NULL DEFAULT 0 CHECK (promotions_enabled IN (0, 1)),
  policy_version TEXT NOT NULL DEFAULT '2026-09-14.cabinet-v1-part2'
    CHECK (policy_version = '2026-09-14.cabinet-v1-part2'),
  promotion_policy_version INTEGER NOT NULL DEFAULT 1
    CHECK (promotion_policy_version = 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by INTEGER REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  CHECK (
    enabled = 1 OR (
      lifecycle_enabled = 0 AND preview_enabled = 0
      AND moderation_enabled = 0 AND publication_enabled = 0
      AND promotions_enabled = 0
    )
  ),
  CHECK (
    lifecycle_enabled = 1 OR (
      preview_enabled = 0 AND moderation_enabled = 0
      AND publication_enabled = 0 AND promotions_enabled = 0
    )
  )
);

INSERT OR IGNORE INTO cabinet_offer_v1_settings (
  id, enabled, lifecycle_enabled, preview_enabled, moderation_enabled,
  publication_enabled, promotions_enabled, policy_version,
  promotion_policy_version, revision, updated_by, updated_at
) VALUES (
  1, 0, 0, 0, 0, 0, 0, '2026-09-14.cabinet-v1-part2', 1, 1,
  NULL, unixepoch()
);

CREATE TABLE IF NOT EXISTS cabinet_offer_submissions (
  submission_id TEXT PRIMARY KEY CHECK (
    length(submission_id) = 68
    AND substr(submission_id, 1, 4) = 'sub_'
    AND substr(submission_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  offer_code TEXT NOT NULL REFERENCES offer_owners(offer_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  offer_version_id INTEGER NOT NULL REFERENCES offer_versions(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  moderation_decision_id INTEGER NOT NULL UNIQUE
    REFERENCES offer_moderation_decisions(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  owner_partner_profile_id INTEGER NOT NULL REFERENCES partner_profiles(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  partner_link_id INTEGER NOT NULL REFERENCES partner_links(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  program_offer_id INTEGER NOT NULL REFERENCES program_offers(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  program_code TEXT NOT NULL REFERENCES partner_programs(code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  submitted_by INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  version_content_hash TEXT NOT NULL CHECK (
    length(version_content_hash) = 64
    AND version_content_hash = lower(version_content_hash)
    AND version_content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  authority_hash TEXT NOT NULL CHECK (
    length(authority_hash) = 64
    AND authority_hash = lower(authority_hash)
    AND authority_hash NOT GLOB '*[^0-9a-f]*'
  ),
  media_set_hash TEXT NOT NULL CHECK (
    length(media_set_hash) = 64
    AND media_set_hash = lower(media_set_hash)
    AND media_set_hash NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) = 68
    AND substr(idempotency_key, 1, 4) = 'key_'
    AND substr(idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash = lower(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  submitted_at INTEGER NOT NULL CHECK (submitted_at > 0),
  UNIQUE (offer_code, offer_version_id)
);

CREATE INDEX IF NOT EXISTS idx_cabinet_offer_submissions_owner
  ON cabinet_offer_submissions(
    owner_partner_profile_id, submitted_at, submission_id
  );

CREATE TABLE IF NOT EXISTS cabinet_offer_preview_receipts (
  preview_id TEXT PRIMARY KEY CHECK (
    length(preview_id) = 68
    AND substr(preview_id, 1, 4) = 'prv_'
    AND substr(preview_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  offer_code TEXT NOT NULL REFERENCES offer_owners(offer_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  offer_version_id INTEGER NOT NULL REFERENCES offer_versions(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  viewer_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  audience_kind TEXT NOT NULL CHECK (
    audience_kind IN ('owner', 'moderator', 'user')
  ),
  plan_code TEXT NOT NULL CHECK (
    plan_code IN ('free', 'professional', 'dragon')
  ),
  presentation TEXT NOT NULL CHECK (presentation IN ('minimal', 'full')),
  visibility_source TEXT NOT NULL DEFAULT 'database'
    CHECK (visibility_source = 'database'),
  version_content_hash TEXT NOT NULL CHECK (
    length(version_content_hash) = 64
    AND version_content_hash = lower(version_content_hash)
    AND version_content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  media_set_hash TEXT NOT NULL CHECK (
    length(media_set_hash) = 64
    AND media_set_hash = lower(media_set_hash)
    AND media_set_hash NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) = 68
    AND substr(idempotency_key, 1, 4) = 'key_'
    AND substr(idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash = lower(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= occurred_at
    AND retention_until <= occurred_at + 15552000
  ),
  CHECK (
    audience_kind != 'user'
    OR (plan_code = 'free' AND presentation = 'minimal')
    OR (plan_code IN ('professional', 'dragon') AND presentation = 'full')
  ),
  CHECK (audience_kind = 'user' OR presentation = 'full')
);

CREATE INDEX IF NOT EXISTS idx_cabinet_offer_previews_retention
  ON cabinet_offer_preview_receipts(retention_until, preview_id);

CREATE TABLE IF NOT EXISTS cabinet_offer_version_media (
  media_id TEXT PRIMARY KEY CHECK (
    length(media_id) = 68
    AND substr(media_id, 1, 4) = 'med_'
    AND substr(media_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  offer_code TEXT NOT NULL REFERENCES offer_owners(offer_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  offer_version_id INTEGER NOT NULL REFERENCES offer_versions(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 1000),
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video')),
  storage_key TEXT NOT NULL CHECK (
    length(storage_key) BETWEEN 8 AND 512
    AND instr(storage_key, '://') = 0
  ),
  mime_type TEXT NOT NULL CHECK (
    (media_kind = 'image' AND mime_type IN (
      'image/jpeg', 'image/png', 'image/webp'
    )) OR (media_kind = 'video' AND mime_type = 'video/mp4')
  ),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 20971520),
  width INTEGER CHECK (width IS NULL OR width BETWEEN 1 AND 16384),
  height INTEGER CHECK (height IS NULL OR height BETWEEN 1 AND 16384),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64
    AND content_hash = lower(content_hash)
    AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  alt_text TEXT NOT NULL DEFAULT '' CHECK (length(alt_text) <= 500),
  uploaded_by INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  UNIQUE (offer_version_id, position),
  UNIQUE (offer_version_id, storage_key)
);

CREATE INDEX IF NOT EXISTS idx_cabinet_offer_media_order
  ON cabinet_offer_version_media(offer_code, offer_version_id, position);

CREATE TABLE IF NOT EXISTS cabinet_offer_review_receipts (
  review_id TEXT PRIMARY KEY CHECK (
    length(review_id) = 68
    AND substr(review_id, 1, 4) = 'rev_'
    AND substr(review_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  submission_id TEXT NOT NULL UNIQUE REFERENCES cabinet_offer_submissions(
    submission_id
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  moderation_decision_id INTEGER NOT NULL UNIQUE
    REFERENCES offer_moderation_decisions(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (
    decision IN ('approved', 'changes_requested', 'rejected')
  ),
  reviewed_by INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  reason_hash TEXT NOT NULL CHECK (
    length(reason_hash) = 64
    AND reason_hash = lower(reason_hash)
    AND reason_hash NOT GLOB '*[^0-9a-f]*'
  ),
  reviewed_content_hash TEXT NOT NULL CHECK (
    length(reviewed_content_hash) = 64
    AND reviewed_content_hash = lower(reviewed_content_hash)
    AND reviewed_content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  reviewed_authority_hash TEXT NOT NULL CHECK (
    length(reviewed_authority_hash) = 64
    AND reviewed_authority_hash = lower(reviewed_authority_hash)
    AND reviewed_authority_hash NOT GLOB '*[^0-9a-f]*'
  ),
  approved_media_set_hash TEXT NOT NULL CHECK (
    length(approved_media_set_hash) = 64
    AND approved_media_set_hash = lower(approved_media_set_hash)
    AND approved_media_set_hash NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) = 68
    AND substr(idempotency_key, 1, 4) = 'key_'
    AND substr(idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash = lower(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  before_hash TEXT NOT NULL CHECK (
    length(before_hash) = 64
    AND before_hash = lower(before_hash)
    AND before_hash NOT GLOB '*[^0-9a-f]*'
  ),
  after_hash TEXT NOT NULL CHECK (
    length(after_hash) = 64
    AND after_hash = lower(after_hash)
    AND after_hash NOT GLOB '*[^0-9a-f]*'
  ),
  reviewed_at INTEGER NOT NULL CHECK (reviewed_at > 0),
  CHECK (before_hash != after_hash)
);

CREATE INDEX IF NOT EXISTS idx_cabinet_offer_reviews_admin
  ON cabinet_offer_review_receipts(reviewed_by, reviewed_at, review_id);

CREATE TABLE IF NOT EXISTS cabinet_offer_media_approvals (
  media_id TEXT PRIMARY KEY REFERENCES cabinet_offer_version_media(media_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  review_id TEXT NOT NULL REFERENCES cabinet_offer_review_receipts(review_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  approved_by INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64
    AND content_hash = lower(content_hash)
    AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  approved_at INTEGER NOT NULL CHECK (approved_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_cabinet_media_approvals_review
  ON cabinet_offer_media_approvals(review_id, media_id);

CREATE TABLE IF NOT EXISTS cabinet_offer_publication_receipts (
  publication_id TEXT PRIMARY KEY CHECK (
    length(publication_id) = 68
    AND substr(publication_id, 1, 4) = 'pub_'
    AND substr(publication_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  offer_code TEXT NOT NULL REFERENCES offer_owners(offer_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  offer_version_id INTEGER NOT NULL REFERENCES offer_versions(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  review_id TEXT NOT NULL UNIQUE REFERENCES cabinet_offer_review_receipts(
    review_id
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  owner_partner_profile_id INTEGER NOT NULL REFERENCES partner_profiles(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  published_by INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  visibility_before TEXT NOT NULL CHECK (visibility_before = 'private'),
  visibility_after TEXT NOT NULL CHECK (visibility_after = 'public'),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64
    AND content_hash = lower(content_hash)
    AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  authority_hash TEXT NOT NULL CHECK (
    length(authority_hash) = 64
    AND authority_hash = lower(authority_hash)
    AND authority_hash NOT GLOB '*[^0-9a-f]*'
  ),
  media_set_hash TEXT NOT NULL CHECK (
    length(media_set_hash) = 64
    AND media_set_hash = lower(media_set_hash)
    AND media_set_hash NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) = 68
    AND substr(idempotency_key, 1, 4) = 'key_'
    AND substr(idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash = lower(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  before_hash TEXT NOT NULL CHECK (
    length(before_hash) = 64
    AND before_hash = lower(before_hash)
    AND before_hash NOT GLOB '*[^0-9a-f]*'
  ),
  after_hash TEXT NOT NULL CHECK (
    length(after_hash) = 64
    AND after_hash = lower(after_hash)
    AND after_hash NOT GLOB '*[^0-9a-f]*'
  ),
  published_at INTEGER NOT NULL CHECK (published_at > 0),
  UNIQUE (offer_code, offer_version_id),
  CHECK (before_hash != after_hash)
);

CREATE INDEX IF NOT EXISTS idx_cabinet_offer_publications_owner
  ON cabinet_offer_publication_receipts(
    owner_partner_profile_id, published_at, publication_id
  );

CREATE TABLE IF NOT EXISTS cabinet_promotion_policies (
  policy_code TEXT PRIMARY KEY CHECK (
    policy_code IN ('newcomer_20_72h', 'monthly_50_48h')
  ),
  discount_basis_points INTEGER NOT NULL CHECK (
    discount_basis_points IN (2000, 5000)
  ),
  window_seconds INTEGER NOT NULL CHECK (
    window_seconds IN (259200, 172800)
  ),
  window_scope TEXT NOT NULL CHECK (window_scope IN ('user', 'global')),
  eligible_user_limit INTEGER NOT NULL CHECK (
    eligible_user_limit IN (1, 10)
  ),
  priority INTEGER NOT NULL CHECK (priority IN (100, 200)),
  non_stacking INTEGER NOT NULL DEFAULT 1 CHECK (non_stacking = 1),
  price_authority_kind TEXT NOT NULL DEFAULT 'stars_access'
    CHECK (price_authority_kind = 'stars_access'),
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version = 1),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  CHECK (
    (policy_code = 'newcomer_20_72h'
      AND discount_basis_points = 2000 AND window_seconds = 259200
      AND window_scope = 'user' AND eligible_user_limit = 1
      AND priority = 100)
    OR
    (policy_code = 'monthly_50_48h'
      AND discount_basis_points = 5000 AND window_seconds = 172800
      AND window_scope = 'global' AND eligible_user_limit = 10
      AND priority = 200)
  )
);

INSERT OR IGNORE INTO cabinet_promotion_policies (
  policy_code, discount_basis_points, window_seconds, window_scope,
  eligible_user_limit, priority, non_stacking, price_authority_kind,
  policy_version, created_at
) VALUES
  ('newcomer_20_72h', 2000, 259200, 'user', 1, 100, 1,
   'stars_access', 1, unixepoch()),
  ('monthly_50_48h', 5000, 172800, 'global', 10, 200, 1,
   'stars_access', 1, unixepoch());

CREATE TABLE IF NOT EXISTS cabinet_promotion_windows (
  window_id TEXT PRIMARY KEY CHECK (
    length(window_id) = 68
    AND substr(window_id, 1, 4) = 'pwn_'
    AND substr(window_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  policy_code TEXT NOT NULL REFERENCES cabinet_promotion_policies(policy_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  subject_telegram_id INTEGER REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  starts_at INTEGER NOT NULL CHECK (starts_at > 0),
  ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
  eligible_user_limit INTEGER NOT NULL CHECK (
    eligible_user_limit IN (1, 10)
  ),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('worker', 'admin')),
  created_by INTEGER NOT NULL CHECK (created_by >= 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) = 68
    AND substr(idempotency_key, 1, 4) = 'key_'
    AND substr(idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash = lower(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  authority_hash TEXT NOT NULL CHECK (
    length(authority_hash) = 64
    AND authority_hash = lower(authority_hash)
    AND authority_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  CHECK (
    (source_kind = 'worker' AND created_by = 0)
    OR (source_kind = 'admin' AND created_by > 0)
  ),
  CHECK (
    (policy_code = 'newcomer_20_72h' AND subject_telegram_id IS NOT NULL
      AND ends_at = starts_at + 259200 AND eligible_user_limit = 1)
    OR
    (policy_code = 'monthly_50_48h' AND subject_telegram_id IS NULL
      AND ends_at = starts_at + 172800 AND eligible_user_limit = 10)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cabinet_promo_newcomer_once
  ON cabinet_promotion_windows(policy_code, subject_telegram_id)
  WHERE policy_code = 'newcomer_20_72h';

CREATE UNIQUE INDEX IF NOT EXISTS idx_cabinet_promo_monthly_start
  ON cabinet_promotion_windows(policy_code, starts_at)
  WHERE policy_code = 'monthly_50_48h';

CREATE UNIQUE INDEX IF NOT EXISTS idx_cabinet_promo_monthly_cycle
  ON cabinet_promotion_windows(
    policy_code, strftime('%Y-%m', starts_at, 'unixepoch')
  ) WHERE policy_code = 'monthly_50_48h';

CREATE INDEX IF NOT EXISTS idx_cabinet_promo_windows_active
  ON cabinet_promotion_windows(policy_code, starts_at, ends_at, window_id);

CREATE TABLE IF NOT EXISTS cabinet_promotion_evaluation_receipts (
  evaluation_id TEXT PRIMARY KEY CHECK (
    length(evaluation_id) = 68
    AND substr(evaluation_id, 1, 4) = 'pev_'
    AND substr(evaluation_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  actor_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  subject_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  offer_code TEXT NOT NULL REFERENCES offer_owners(offer_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  checkout_intent_hash TEXT NOT NULL CHECK (
    length(checkout_intent_hash) = 64
    AND checkout_intent_hash = lower(checkout_intent_hash)
    AND checkout_intent_hash NOT GLOB '*[^0-9a-f]*'
  ),
  selected_policy_code TEXT REFERENCES cabinet_promotion_policies(policy_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  promotion_window_id TEXT REFERENCES cabinet_promotion_windows(window_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('eligible', 'ineligible')),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'eligible', 'feature_off', 'offer_not_public', 'self_dealing',
    'cross_owner', 'not_started', 'newcomer_expired', 'monthly_expired',
    'quota_exhausted', 'already_claimed', 'authority_mismatch', 'no_policy'
  )),
  price_authority_kind TEXT NOT NULL CHECK (
    price_authority_kind = 'stars_access'
  ),
  price_authority_key_hash TEXT NOT NULL CHECK (
    length(price_authority_key_hash) = 64
    AND price_authority_key_hash = lower(price_authority_key_hash)
    AND price_authority_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  price_version_hash TEXT NOT NULL CHECK (
    length(price_version_hash) = 64
    AND price_version_hash = lower(price_version_hash)
    AND price_version_hash NOT GLOB '*[^0-9a-f]*'
  ),
  currency TEXT NOT NULL CHECK (currency = 'XTR'),
  base_price_stars INTEGER NOT NULL CHECK (base_price_stars > 0),
  discount_basis_points INTEGER NOT NULL CHECK (
    discount_basis_points IN (0, 2000, 5000)
  ),
  discount_stars INTEGER NOT NULL CHECK (discount_stars >= 0),
  final_price_stars INTEGER NOT NULL CHECK (final_price_stars > 0),
  candidate_set_hash TEXT NOT NULL CHECK (
    length(candidate_set_hash) = 64
    AND candidate_set_hash = lower(candidate_set_hash)
    AND candidate_set_hash NOT GLOB '*[^0-9a-f]*'
  ),
  authority_hash TEXT NOT NULL CHECK (
    length(authority_hash) = 64
    AND authority_hash = lower(authority_hash)
    AND authority_hash NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) = 68
    AND substr(idempotency_key, 1, 4) = 'key_'
    AND substr(idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash = lower(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  evaluated_at INTEGER NOT NULL CHECK (evaluated_at > 0),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= evaluated_at
    AND retention_until <= evaluated_at + 15552000
  ),
  CHECK (
    discount_stars = (base_price_stars * discount_basis_points) / 10000
    AND final_price_stars = base_price_stars - discount_stars
  ),
  CHECK (
    (outcome = 'eligible' AND reason_code = 'eligible'
      AND selected_policy_code IS NOT NULL
      AND promotion_window_id IS NOT NULL
      AND discount_basis_points IN (2000, 5000))
    OR
    (outcome = 'ineligible' AND reason_code != 'eligible'
      AND selected_policy_code IS NULL AND promotion_window_id IS NULL
      AND discount_basis_points = 0 AND discount_stars = 0
      AND final_price_stars = base_price_stars)
  )
);

CREATE INDEX IF NOT EXISTS idx_cabinet_promo_evaluations_subject
  ON cabinet_promotion_evaluation_receipts(
    subject_telegram_id, evaluated_at, evaluation_id
  );

CREATE INDEX IF NOT EXISTS idx_cabinet_promo_evaluations_retention
  ON cabinet_promotion_evaluation_receipts(retention_until, evaluation_id);

CREATE TABLE IF NOT EXISTS cabinet_promotion_application_receipts (
  application_id TEXT PRIMARY KEY CHECK (
    length(application_id) = 68
    AND substr(application_id, 1, 4) = 'pap_'
    AND substr(application_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  evaluation_id TEXT NOT NULL UNIQUE
    REFERENCES cabinet_promotion_evaluation_receipts(evaluation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  subject_telegram_id INTEGER NOT NULL REFERENCES users(telegram_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  offer_code TEXT NOT NULL REFERENCES offer_owners(offer_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  policy_code TEXT NOT NULL REFERENCES cabinet_promotion_policies(policy_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  promotion_window_id TEXT NOT NULL REFERENCES cabinet_promotion_windows(window_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  checkout_intent_hash TEXT NOT NULL UNIQUE CHECK (
    length(checkout_intent_hash) = 64
    AND checkout_intent_hash = lower(checkout_intent_hash)
    AND checkout_intent_hash NOT GLOB '*[^0-9a-f]*'
  ),
  price_authority_key_hash TEXT NOT NULL CHECK (
    length(price_authority_key_hash) = 64
    AND price_authority_key_hash = lower(price_authority_key_hash)
    AND price_authority_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  price_version_hash TEXT NOT NULL CHECK (
    length(price_version_hash) = 64
    AND price_version_hash = lower(price_version_hash)
    AND price_version_hash NOT GLOB '*[^0-9a-f]*'
  ),
  currency TEXT NOT NULL CHECK (currency = 'XTR'),
  base_price_stars INTEGER NOT NULL CHECK (base_price_stars > 0),
  discount_basis_points INTEGER NOT NULL CHECK (
    discount_basis_points IN (2000, 5000)
  ),
  discount_stars INTEGER NOT NULL CHECK (discount_stars >= 0),
  final_price_stars INTEGER NOT NULL CHECK (final_price_stars > 0),
  authority_status TEXT NOT NULL DEFAULT 'awaiting_stars'
    CHECK (authority_status = 'awaiting_stars'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) = 68
    AND substr(idempotency_key, 1, 4) = 'key_'
    AND substr(idempotency_key, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash = lower(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  before_hash TEXT NOT NULL CHECK (
    length(before_hash) = 64
    AND before_hash = lower(before_hash)
    AND before_hash NOT GLOB '*[^0-9a-f]*'
  ),
  after_hash TEXT NOT NULL CHECK (
    length(after_hash) = 64
    AND after_hash = lower(after_hash)
    AND after_hash NOT GLOB '*[^0-9a-f]*'
  ),
  applied_at INTEGER NOT NULL CHECK (applied_at > 0),
  CHECK (
    discount_stars = (base_price_stars * discount_basis_points) / 10000
    AND final_price_stars = base_price_stars - discount_stars
  ),
  CHECK (before_hash != after_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cabinet_promo_window_user_once
  ON cabinet_promotion_application_receipts(
    promotion_window_id, subject_telegram_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_cabinet_promo_newcomer_claim_once
  ON cabinet_promotion_application_receipts(policy_code, subject_telegram_id)
  WHERE policy_code = 'newcomer_20_72h';

CREATE INDEX IF NOT EXISTS idx_cabinet_promo_applications_window
  ON cabinet_promotion_application_receipts(
    promotion_window_id, applied_at, application_id
  );

-- Settings remain admin-controlled and cannot be enabled while Part 1 is off.
CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_settings_identity
BEFORE UPDATE ON cabinet_offer_v1_settings
WHEN NEW.id != OLD.id OR NEW.policy_version != OLD.policy_version
  OR NEW.promotion_policy_version != OLD.promotion_policy_version
BEGIN
  SELECT RAISE(ABORT, 'offer policy identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_settings_revision
BEFORE UPDATE ON cabinet_offer_v1_settings
WHEN NEW.revision != OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'offer settings revision must advance once');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_settings_admin
BEFORE UPDATE ON cabinet_offer_v1_settings
WHEN NEW.updated_by IS NULL OR NOT EXISTS (
  SELECT 1 FROM user_roles
  WHERE telegram_id = NEW.updated_by AND role = 'admin' AND status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'offer settings update requires active admin');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_settings_gate
BEFORE UPDATE ON cabinet_offer_v1_settings
WHEN NEW.enabled = 1 AND NOT EXISTS (
  SELECT 1 FROM cabinet_v1_settings
  WHERE id = 1 AND rollout_mode = 'admin_shadow'
    AND master_enabled = 1 AND offer_enabled = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cabinet offer gate is closed');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_settings_time
BEFORE UPDATE ON cabinet_offer_v1_settings
WHEN NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'offer settings time cannot regress');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_settings_no_delete
BEFORE DELETE ON cabinet_offer_v1_settings
BEGIN
  SELECT RAISE(ABORT, 'offer settings cannot be deleted');
END;

-- A changed current version can never carry forward approval or visibility.
CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_version_change_invalidates
BEFORE UPDATE OF current_version_id ON offer_visibility_rules
WHEN NEW.current_version_id != OLD.current_version_id AND (
  NEW.moderation_status != 'not_submitted'
  OR NEW.visibility != 'private'
  OR NEW.submitted_version_id IS NOT NULL
  OR NEW.approved_version_id IS NOT NULL
  OR NEW.published_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'content change must invalidate approval');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_approval_stays_private
BEFORE UPDATE OF approved_version_id ON offer_visibility_rules
WHEN OLD.approved_version_id IS NOT NEW.approved_version_id
  AND NEW.approved_version_id IS NOT NULL
  AND (NEW.visibility != 'private' OR NEW.published_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'approval does not publish');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_public_requires_owner_receipt
BEFORE UPDATE OF visibility ON offer_visibility_rules
WHEN NEW.visibility = 'public' AND OLD.visibility != 'public'
  AND EXISTS (
    SELECT 1 FROM cabinet_offer_v1_settings
    WHERE id = 1 AND enabled = 1 AND publication_enabled = 1
  )
  AND EXISTS (
    SELECT 1 FROM offer_owners
    WHERE offer_code = NEW.offer_code AND owner_kind = 'partner'
  )
  AND NOT EXISTS (
    SELECT 1 FROM cabinet_offer_publication_receipts p
    WHERE p.offer_code = NEW.offer_code
      AND p.offer_version_id = NEW.current_version_id
      AND p.published_by = NEW.updated_by
      AND p.published_at = unixepoch(NEW.published_at)
  )
BEGIN
  SELECT RAISE(ABORT, 'public visibility requires owner publication receipt');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_submission_idempotency_mismatch
BEFORE INSERT ON cabinet_offer_submissions
WHEN EXISTS (
  SELECT 1 FROM cabinet_offer_submissions existing
  WHERE existing.idempotency_key = NEW.idempotency_key
    AND (
      existing.offer_code != NEW.offer_code
      OR existing.offer_version_id != NEW.offer_version_id
      OR existing.request_hash != NEW.request_hash
    )
)
BEGIN
  SELECT RAISE(ABORT, 'offer submission idempotency mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_submission_validate
BEFORE INSERT ON cabinet_offer_submissions
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_offer_submissions
  WHERE idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_v1_settings c, cabinet_offer_v1_settings s
    WHERE c.id = 1 AND c.rollout_mode = 'admin_shadow'
      AND c.master_enabled = 1 AND c.offer_enabled = 1
      AND s.id = 1 AND s.enabled = 1 AND s.lifecycle_enabled = 1
      AND s.moderation_enabled = 1
  ) THEN RAISE(ABORT, 'offer submission gate is closed') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM offer_versions v
    JOIN offer_visibility_rules vr ON vr.offer_code = v.offer_code
    JOIN offer_owners ow ON ow.offer_code = v.offer_code
    JOIN partner_profiles pf ON pf.id = ow.partner_profile_id
    JOIN user_roles ur ON ur.telegram_id = pf.telegram_id
      AND ur.role = 'partner' AND ur.status = 'active'
    JOIN partner_beta_access ba ON ba.partner_profile_id = pf.id
    JOIN partner_offer_links selection ON selection.offer_code = v.offer_code
    JOIN partner_links pl ON pl.id = selection.partner_link_id
    JOIN program_offers po ON po.id = pl.catalog_offer_id
    JOIN partner_programs pp ON pp.code = po.program_code
    JOIN offers base ON base.code = po.offer_code
    JOIN offer_moderation_decisions md ON md.id = NEW.moderation_decision_id
    WHERE v.id = NEW.offer_version_id AND v.offer_code = NEW.offer_code
      AND (v.content_hash = NEW.version_content_hash
        OR v.content_hash = 'sha256:' || NEW.version_content_hash)
      AND v.business_status = 'active'
      AND vr.current_version_id = v.id AND vr.submitted_version_id = v.id
      AND vr.approved_version_id IS NULL
      AND vr.moderation_status = 'pending' AND vr.visibility = 'private'
      AND ow.owner_kind = 'partner'
      AND ow.partner_profile_id = NEW.owner_partner_profile_id
      AND pf.status = 'active' AND pf.telegram_id = NEW.submitted_by
      AND ba.access_status = 'active' AND ba.can_submit_offers = 1
      AND (ba.expires_at IS NULL OR unixepoch(ba.expires_at) > NEW.submitted_at)
      AND selection.partner_link_id = NEW.partner_link_id
      AND pl.partner_profile_id = pf.id AND pl.status = 'approved'
      AND pl.ownership_confirmed = 1 AND pl.traffic_confirmed = 1
      AND po.id = NEW.program_offer_id AND po.program_code = NEW.program_code
      AND po.status = 'active' AND pp.status = 'active' AND base.status = 'active'
      AND md.offer_code = NEW.offer_code AND md.offer_version_id = v.id
      AND md.decision = 'submitted' AND md.actor_id = NEW.submitted_by
      AND md.actor_role = 'partner'
  ) THEN RAISE(ABORT, 'offer submission authority mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_submissions_no_update
BEFORE UPDATE ON cabinet_offer_submissions
BEGIN
  SELECT RAISE(ABORT, 'offer submissions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_submissions_no_delete
BEFORE DELETE ON cabinet_offer_submissions
BEGIN
  SELECT RAISE(ABORT, 'offer submissions cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_preview_validate
BEFORE INSERT ON cabinet_offer_preview_receipts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_v1_settings c, cabinet_offer_v1_settings s
    WHERE c.id = 1 AND c.rollout_mode = 'admin_shadow'
      AND c.master_enabled = 1 AND c.offer_enabled = 1
      AND s.id = 1 AND s.enabled = 1 AND s.lifecycle_enabled = 1
      AND s.preview_enabled = 1
  ) THEN RAISE(ABORT, 'offer preview gate is closed') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM offer_versions v
    WHERE v.id = NEW.offer_version_id AND v.offer_code = NEW.offer_code
      AND (v.content_hash = NEW.version_content_hash
        OR v.content_hash = 'sha256:' || NEW.version_content_hash)
  ) THEN RAISE(ABORT, 'offer preview version mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM offer_owners ow
    JOIN partner_profiles pf ON pf.id = ow.partner_profile_id
    JOIN user_roles ur ON ur.telegram_id = pf.telegram_id
      AND ur.role = 'partner' AND ur.status = 'active'
    JOIN partner_beta_access ba ON ba.partner_profile_id = pf.id
    JOIN partner_offer_links selection ON selection.offer_code = ow.offer_code
    JOIN partner_links pl ON pl.id = selection.partner_link_id
    JOIN program_offers po ON po.id = pl.catalog_offer_id
    JOIN partner_programs pp ON pp.code = po.program_code
    JOIN offers base ON base.code = po.offer_code
    WHERE ow.offer_code = NEW.offer_code AND ow.owner_kind = 'partner'
      AND pf.status = 'active' AND ba.access_status = 'active'
      AND (ba.expires_at IS NULL OR unixepoch(ba.expires_at) > NEW.occurred_at)
      AND pl.partner_profile_id = pf.id AND pl.status = 'approved'
      AND pl.ownership_confirmed = 1 AND pl.traffic_confirmed = 1
      AND po.status = 'active' AND pp.status = 'active' AND base.status = 'active'
  ) THEN RAISE(ABORT, 'offer preview authority mismatch') END;
  SELECT CASE WHEN NEW.audience_kind = 'owner' AND NOT EXISTS (
    SELECT 1 FROM offer_owners ow
    JOIN partner_profiles pf ON pf.id = ow.partner_profile_id
    JOIN offer_visibility_rules vr ON vr.offer_code = ow.offer_code
    WHERE ow.offer_code = NEW.offer_code AND ow.owner_kind = 'partner'
      AND pf.status = 'active' AND pf.telegram_id = NEW.viewer_telegram_id
      AND vr.current_version_id = NEW.offer_version_id
  ) THEN RAISE(ABORT, 'owner preview denied') END;
  SELECT CASE WHEN NEW.audience_kind = 'moderator' AND NOT EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN offer_visibility_rules vr ON vr.offer_code = NEW.offer_code
    WHERE ur.telegram_id = NEW.viewer_telegram_id
      AND ur.role = 'admin' AND ur.status = 'active'
      AND vr.submitted_version_id = NEW.offer_version_id
  ) THEN RAISE(ABORT, 'moderator preview denied') END;
  SELECT CASE WHEN NEW.audience_kind = 'user' AND NOT EXISTS (
    SELECT 1 FROM offer_visibility_rules vr
    WHERE vr.offer_code = NEW.offer_code
      AND vr.moderation_status = 'approved' AND vr.visibility = 'public'
      AND vr.current_version_id = NEW.offer_version_id
      AND vr.approved_version_id = NEW.offer_version_id
  ) THEN RAISE(ABORT, 'public preview denied') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_previews_no_update
BEFORE UPDATE ON cabinet_offer_preview_receipts
BEGIN
  SELECT RAISE(ABORT, 'offer preview receipts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_previews_guarded_delete
BEFORE DELETE ON cabinet_offer_preview_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_privacy_maintenance_guard g
  WHERE g.id = 1 AND g.expires_at >= unixepoch()
    AND (
      (g.reason = 'retention' AND OLD.retention_until <= unixepoch())
      OR (g.reason = 'user_deletion'
        AND g.subject_telegram_id = OLD.viewer_telegram_id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'offer preview deletion requires privacy guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_media_validate
BEFORE INSERT ON cabinet_offer_version_media
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_v1_settings c, cabinet_offer_v1_settings s
    WHERE c.id = 1 AND c.rollout_mode = 'admin_shadow'
      AND c.master_enabled = 1 AND c.offer_enabled = 1
      AND s.id = 1 AND s.enabled = 1 AND s.lifecycle_enabled = 1
  ) THEN RAISE(ABORT, 'offer media gate is closed') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM offer_versions v
    JOIN offer_visibility_rules vr ON vr.offer_code = v.offer_code
    JOIN offer_owners ow ON ow.offer_code = v.offer_code
    JOIN partner_profiles pf ON pf.id = ow.partner_profile_id
    JOIN user_roles ur ON ur.telegram_id = pf.telegram_id
      AND ur.role = 'partner' AND ur.status = 'active'
    JOIN partner_beta_access ba ON ba.partner_profile_id = pf.id
    JOIN partner_offer_links selection ON selection.offer_code = ow.offer_code
    JOIN partner_links pl ON pl.id = selection.partner_link_id
    JOIN program_offers po ON po.id = pl.catalog_offer_id
    JOIN partner_programs pp ON pp.code = po.program_code
    JOIN offers base ON base.code = po.offer_code
    WHERE v.id = NEW.offer_version_id AND v.offer_code = NEW.offer_code
      AND vr.current_version_id = v.id AND vr.moderation_status != 'pending'
      AND vr.approved_version_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM cabinet_offer_submissions s
        WHERE s.offer_version_id = v.id
      )
      AND ow.owner_kind = 'partner' AND pf.status = 'active'
      AND ba.access_status = 'active' AND ba.can_create_private_offers = 1
      AND (ba.expires_at IS NULL OR unixepoch(ba.expires_at) > NEW.created_at)
      AND pl.partner_profile_id = pf.id AND pl.status = 'approved'
      AND pl.ownership_confirmed = 1 AND pl.traffic_confirmed = 1
      AND po.status = 'active' AND pp.status = 'active' AND base.status = 'active'
      AND (
        EXISTS (
          SELECT 1 FROM user_roles ur
          WHERE ur.telegram_id = NEW.uploaded_by
            AND ur.role = 'admin' AND ur.status = 'active'
        )
        OR (ow.owner_kind = 'partner' AND pf.status = 'active'
          AND pf.telegram_id = NEW.uploaded_by)
      )
  ) THEN RAISE(ABORT, 'offer media authority mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_media_no_update
BEFORE UPDATE ON cabinet_offer_version_media
BEGIN
  SELECT RAISE(ABORT, 'offer version media are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_media_no_delete
BEFORE DELETE ON cabinet_offer_version_media
BEGIN
  SELECT RAISE(ABORT, 'offer version media cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_review_idempotency_mismatch
BEFORE INSERT ON cabinet_offer_review_receipts
WHEN EXISTS (
  SELECT 1 FROM cabinet_offer_review_receipts existing
  WHERE existing.idempotency_key = NEW.idempotency_key
    AND (existing.submission_id != NEW.submission_id
      OR existing.decision != NEW.decision
      OR existing.request_hash != NEW.request_hash)
)
BEGIN
  SELECT RAISE(ABORT, 'offer review idempotency mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_review_validate
BEFORE INSERT ON cabinet_offer_review_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_offer_review_receipts
  WHERE idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_v1_settings c, cabinet_offer_v1_settings s
    WHERE c.id = 1 AND c.rollout_mode = 'admin_shadow'
      AND c.master_enabled = 1 AND c.offer_enabled = 1
      AND s.id = 1 AND s.enabled = 1 AND s.lifecycle_enabled = 1
      AND s.moderation_enabled = 1
  ) THEN RAISE(ABORT, 'offer review gate is closed') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM user_roles
    WHERE telegram_id = NEW.reviewed_by
      AND role = 'admin' AND status = 'active'
  ) THEN RAISE(ABORT, 'offer review requires active admin') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM cabinet_offer_submissions s
    JOIN offer_moderation_decisions md ON md.id = NEW.moderation_decision_id
    JOIN offer_visibility_rules vr ON vr.offer_code = s.offer_code
    WHERE s.submission_id = NEW.submission_id
      AND md.offer_code = s.offer_code
      AND md.offer_version_id = s.offer_version_id
      AND md.decision = NEW.decision AND md.actor_id = NEW.reviewed_by
      AND md.actor_role = 'admin'
      AND vr.current_version_id = s.offer_version_id
      AND vr.submitted_version_id = s.offer_version_id
      AND vr.moderation_status = NEW.decision
      AND vr.visibility = 'private'
      AND ((NEW.decision = 'approved'
          AND vr.approved_version_id = s.offer_version_id)
        OR (NEW.decision != 'approved'
          AND vr.approved_version_id IS NULL))
      AND s.version_content_hash = NEW.reviewed_content_hash
      AND s.authority_hash = NEW.reviewed_authority_hash
      AND s.media_set_hash = NEW.approved_media_set_hash
  ) THEN RAISE(ABORT, 'offer review binding mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM cabinet_offer_submissions s
    JOIN offer_owners ow ON ow.offer_code = s.offer_code
    JOIN partner_profiles pf ON pf.id = ow.partner_profile_id
    JOIN user_roles ur ON ur.telegram_id = pf.telegram_id
      AND ur.role = 'partner' AND ur.status = 'active'
    JOIN partner_beta_access ba ON ba.partner_profile_id = pf.id
    JOIN partner_offer_links selection ON selection.offer_code = s.offer_code
    JOIN partner_links pl ON pl.id = selection.partner_link_id
    JOIN program_offers po ON po.id = pl.catalog_offer_id
    JOIN partner_programs pp ON pp.code = po.program_code
    JOIN offers base ON base.code = po.offer_code
    WHERE s.submission_id = NEW.submission_id
      AND pf.status = 'active' AND ba.access_status = 'active'
      AND selection.partner_link_id = s.partner_link_id
      AND pl.partner_profile_id = pf.id AND pl.status = 'approved'
      AND pl.ownership_confirmed = 1 AND pl.traffic_confirmed = 1
      AND po.id = s.program_offer_id AND po.program_code = s.program_code
      AND po.status = 'active' AND pp.status = 'active' AND base.status = 'active'
  ) THEN RAISE(ABORT, 'reviewed offer authority changed') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_reviews_no_update
BEFORE UPDATE ON cabinet_offer_review_receipts
BEGIN
  SELECT RAISE(ABORT, 'offer review receipts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_reviews_no_delete
BEFORE DELETE ON cabinet_offer_review_receipts
BEGIN
  SELECT RAISE(ABORT, 'offer review receipts cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_media_approval_validate
BEFORE INSERT ON cabinet_offer_media_approvals
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM cabinet_offer_version_media m
    JOIN cabinet_offer_review_receipts r ON r.review_id = NEW.review_id
    JOIN cabinet_offer_submissions s ON s.submission_id = r.submission_id
    WHERE m.media_id = NEW.media_id
      AND m.offer_version_id = s.offer_version_id
      AND m.content_hash = NEW.content_hash
      AND r.decision = 'approved'
      AND r.reviewed_by = NEW.approved_by
      AND NEW.approved_at = r.reviewed_at
  ) THEN RAISE(ABORT, 'media approval binding mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_media_approvals_no_update
BEFORE UPDATE ON cabinet_offer_media_approvals
BEGIN
  SELECT RAISE(ABORT, 'media approvals are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_media_approvals_no_delete
BEFORE DELETE ON cabinet_offer_media_approvals
BEGIN
  SELECT RAISE(ABORT, 'media approvals cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_publication_idempotency_mismatch
BEFORE INSERT ON cabinet_offer_publication_receipts
WHEN EXISTS (
  SELECT 1 FROM cabinet_offer_publication_receipts existing
  WHERE existing.idempotency_key = NEW.idempotency_key
    AND (existing.offer_code != NEW.offer_code
      OR existing.offer_version_id != NEW.offer_version_id
      OR existing.request_hash != NEW.request_hash)
)
BEGIN
  SELECT RAISE(ABORT, 'offer publication idempotency mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_publication_validate
BEFORE INSERT ON cabinet_offer_publication_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_offer_publication_receipts
  WHERE idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_v1_settings c, cabinet_offer_v1_settings s,
      partner_beta_settings b
    WHERE c.id = 1 AND c.rollout_mode = 'admin_shadow'
      AND c.master_enabled = 1 AND c.offer_enabled = 1
      AND s.id = 1 AND s.enabled = 1 AND s.lifecycle_enabled = 1
      AND s.publication_enabled = 1
      AND b.id = 1 AND b.enabled = 1 AND b.private_offers_enabled = 1
      AND b.public_visibility_enabled = 1
  ) THEN RAISE(ABORT, 'offer publication gate is closed') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM cabinet_offer_review_receipts r
    JOIN cabinet_offer_submissions s ON s.submission_id = r.submission_id
    JOIN offer_visibility_rules vr ON vr.offer_code = s.offer_code
    JOIN offer_owners ow ON ow.offer_code = s.offer_code
    JOIN partner_profiles pf ON pf.id = ow.partner_profile_id
    JOIN user_roles ur ON ur.telegram_id = pf.telegram_id
      AND ur.role = 'partner' AND ur.status = 'active'
    JOIN partner_beta_access ba ON ba.partner_profile_id = pf.id
    JOIN partner_offer_links selection ON selection.offer_code = s.offer_code
    JOIN partner_links pl ON pl.id = selection.partner_link_id
    JOIN program_offers po ON po.id = pl.catalog_offer_id
    JOIN partner_programs pp ON pp.code = po.program_code
    JOIN offers base ON base.code = po.offer_code
    WHERE r.review_id = NEW.review_id AND r.decision = 'approved'
      AND s.offer_code = NEW.offer_code
      AND s.offer_version_id = NEW.offer_version_id
      AND s.owner_partner_profile_id = NEW.owner_partner_profile_id
      AND s.version_content_hash = NEW.content_hash
      AND s.authority_hash = NEW.authority_hash
      AND s.media_set_hash = NEW.media_set_hash
      AND r.reviewed_content_hash = NEW.content_hash
      AND r.reviewed_authority_hash = NEW.authority_hash
      AND r.approved_media_set_hash = NEW.media_set_hash
      AND vr.moderation_status = 'approved' AND vr.visibility = 'private'
      AND vr.current_version_id = NEW.offer_version_id
      AND vr.submitted_version_id = NEW.offer_version_id
      AND vr.approved_version_id = NEW.offer_version_id
      AND ow.owner_kind = 'partner' AND ow.partner_profile_id = pf.id
      AND pf.status = 'active' AND pf.telegram_id = NEW.published_by
      AND ba.access_status = 'active'
      AND (ba.expires_at IS NULL OR unixepoch(ba.expires_at) > NEW.published_at)
      AND selection.partner_link_id = s.partner_link_id
      AND pl.partner_profile_id = pf.id AND pl.status = 'approved'
      AND pl.ownership_confirmed = 1 AND pl.traffic_confirmed = 1
      AND po.id = s.program_offer_id AND po.program_code = s.program_code
      AND po.status = 'active' AND pp.status = 'active' AND base.status = 'active'
  ) THEN RAISE(ABORT, 'offer publication authority mismatch') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM cabinet_offer_version_media m
    WHERE m.offer_code = NEW.offer_code
      AND m.offer_version_id = NEW.offer_version_id
      AND NOT EXISTS (
        SELECT 1 FROM cabinet_offer_media_approvals a
        WHERE a.media_id = m.media_id AND a.review_id = NEW.review_id
          AND a.content_hash = m.content_hash
      )
  ) THEN RAISE(ABORT, 'offer publication has unapproved media') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_publication_apply
AFTER INSERT ON cabinet_offer_publication_receipts
BEGIN
  INSERT OR IGNORE INTO offer_moderation_decisions (
    offer_code, offer_version_id, decision, from_status, to_status,
    actor_id, actor_role, reason, event_key, created_at
  ) VALUES (
    NEW.offer_code, NEW.offer_version_id, 'visibility_changed', 'private',
    'public', NEW.published_by, 'partner',
    'Партнёр опубликовал точную одобренную версию.',
    'v140-publish:' || NEW.publication_id,
    datetime(NEW.published_at, 'unixepoch')
  );
  UPDATE offer_visibility_rules
  SET visibility = 'public',
      published_at = datetime(NEW.published_at, 'unixepoch'),
      updated_by = NEW.published_by,
      updated_at = datetime(NEW.published_at, 'unixepoch')
  WHERE offer_code = NEW.offer_code
    AND moderation_status = 'approved' AND visibility = 'private'
    AND current_version_id = NEW.offer_version_id
    AND submitted_version_id = NEW.offer_version_id
    AND approved_version_id = NEW.offer_version_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_publications_no_update
BEFORE UPDATE ON cabinet_offer_publication_receipts
BEGIN
  SELECT RAISE(ABORT, 'offer publication receipts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_publications_no_delete
BEFORE DELETE ON cabinet_offer_publication_receipts
BEGIN
  SELECT RAISE(ABORT, 'offer publication receipts cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_promotion_policies_no_update
BEFORE UPDATE ON cabinet_promotion_policies
BEGIN
  SELECT RAISE(ABORT, 'promotion policies are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_promotion_policies_no_delete
BEFORE DELETE ON cabinet_promotion_policies
BEGIN
  SELECT RAISE(ABORT, 'promotion policies cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_promotion_window_validate
BEFORE INSERT ON cabinet_promotion_windows
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_v1_settings c, cabinet_offer_v1_settings s
    WHERE c.id = 1 AND c.rollout_mode = 'admin_shadow'
      AND c.master_enabled = 1 AND c.offer_enabled = 1
      AND s.id = 1 AND s.enabled = 1 AND s.lifecycle_enabled = 1
      AND s.promotions_enabled = 1
  ) THEN RAISE(ABORT, 'promotion gate is closed') END;
  SELECT CASE WHEN NEW.source_kind = 'admin' AND NOT EXISTS (
    SELECT 1 FROM user_roles WHERE telegram_id = NEW.created_by
      AND role = 'admin' AND status = 'active'
  ) THEN RAISE(ABORT, 'promotion window requires active admin') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cabinet_promotion_policies p
    WHERE p.policy_code = NEW.policy_code
      AND p.window_seconds = NEW.ends_at - NEW.starts_at
      AND p.eligible_user_limit = NEW.eligible_user_limit
      AND ((p.window_scope = 'user' AND NEW.subject_telegram_id IS NOT NULL)
        OR (p.window_scope = 'global' AND NEW.subject_telegram_id IS NULL))
  ) THEN RAISE(ABORT, 'promotion window policy mismatch') END;
  SELECT CASE WHEN NEW.policy_code = 'newcomer_20_72h' AND NOT EXISTS (
    SELECT 1 FROM users
    WHERE telegram_id = NEW.subject_telegram_id
      AND unixepoch(joined_at) = NEW.starts_at
  ) THEN RAISE(ABORT, 'newcomer window must bind account creation') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_promotion_windows_no_update
BEFORE UPDATE ON cabinet_promotion_windows
BEGIN
  SELECT RAISE(ABORT, 'promotion windows are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_promotion_windows_no_delete
BEFORE DELETE ON cabinet_promotion_windows
BEGIN
  SELECT RAISE(ABORT, 'promotion windows cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_promotion_evaluation_validate
BEFORE INSERT ON cabinet_promotion_evaluation_receipts
BEGIN
  SELECT CASE WHEN NEW.actor_telegram_id != NEW.subject_telegram_id OR NOT EXISTS (
    SELECT 1 FROM users u
    JOIN user_roles ur ON ur.telegram_id = u.telegram_id
    WHERE u.telegram_id = NEW.subject_telegram_id AND u.is_blocked = 0
      AND ur.role = 'user' AND ur.status = 'active'
  ) THEN RAISE(ABORT, 'promotion evaluation requires active self') END;
  SELECT CASE WHEN NEW.outcome = 'eligible' AND NOT EXISTS (
    SELECT 1
    FROM cabinet_v1_settings c, cabinet_offer_v1_settings s,
      cabinet_promotion_windows w
    JOIN cabinet_promotion_policies p ON p.policy_code = w.policy_code
    JOIN offer_visibility_rules vr ON vr.offer_code = NEW.offer_code
    JOIN offer_owners ow ON ow.offer_code = NEW.offer_code
    JOIN partner_profiles pf ON pf.id = ow.partner_profile_id
    JOIN partner_offer_links selection ON selection.offer_code = ow.offer_code
    JOIN partner_links pl ON pl.id = selection.partner_link_id
    JOIN program_offers po ON po.id = pl.catalog_offer_id
    JOIN partner_programs pp ON pp.code = po.program_code
    JOIN offers base ON base.code = po.offer_code
    WHERE c.id = 1 AND c.rollout_mode = 'admin_shadow'
      AND c.master_enabled = 1 AND c.offer_enabled = 1
      AND s.id = 1 AND s.enabled = 1 AND s.lifecycle_enabled = 1
      AND s.promotions_enabled = 1
      AND w.window_id = NEW.promotion_window_id
      AND w.policy_code = NEW.selected_policy_code
      AND NEW.evaluated_at >= w.starts_at AND NEW.evaluated_at < w.ends_at
      AND p.discount_basis_points = NEW.discount_basis_points
      AND ((p.window_scope = 'user'
          AND w.subject_telegram_id = NEW.subject_telegram_id)
        OR (p.window_scope = 'global' AND w.subject_telegram_id IS NULL))
      AND vr.moderation_status = 'approved' AND vr.visibility = 'public'
      AND vr.current_version_id = vr.approved_version_id
      AND ow.owner_kind = 'partner' AND pf.status = 'active'
      AND pf.telegram_id != NEW.subject_telegram_id
      AND pl.partner_profile_id = pf.id AND pl.status = 'approved'
      AND pl.ownership_confirmed = 1 AND pl.traffic_confirmed = 1
      AND po.status = 'active' AND pp.status = 'active' AND base.status = 'active'
      AND (SELECT COUNT(DISTINCT a.subject_telegram_id)
           FROM cabinet_promotion_application_receipts a
           WHERE a.promotion_window_id = w.window_id) < w.eligible_user_limit
  ) THEN RAISE(ABORT, 'eligible promotion authority mismatch') END;
  SELECT CASE WHEN NEW.outcome = 'eligible'
    AND NEW.selected_policy_code = 'newcomer_20_72h'
    AND EXISTS (
      SELECT 1 FROM cabinet_promotion_application_receipts a
      WHERE a.policy_code = 'newcomer_20_72h'
        AND a.subject_telegram_id = NEW.subject_telegram_id
    ) THEN RAISE(ABORT, 'newcomer promotion already claimed') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_promotion_evaluations_no_update
BEFORE UPDATE ON cabinet_promotion_evaluation_receipts
BEGIN
  SELECT RAISE(ABORT, 'promotion evaluations are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_promotion_evaluations_guarded_delete
BEFORE DELETE ON cabinet_promotion_evaluation_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM cabinet_privacy_maintenance_guard g
  WHERE g.id = 1 AND g.expires_at >= unixepoch()
    AND (
      (g.reason = 'retention' AND OLD.retention_until <= unixepoch())
      OR (g.reason = 'user_deletion'
        AND g.subject_telegram_id = OLD.subject_telegram_id)
    )
) OR EXISTS (
  SELECT 1 FROM cabinet_promotion_application_receipts a
  WHERE a.evaluation_id = OLD.evaluation_id
)
BEGIN
  SELECT RAISE(ABORT, 'promotion evaluation deletion requires privacy guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_promotion_application_validate
BEFORE INSERT ON cabinet_promotion_application_receipts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM cabinet_promotion_evaluation_receipts e
    JOIN cabinet_promotion_windows w ON w.window_id = e.promotion_window_id
    JOIN cabinet_promotion_policies p ON p.policy_code = e.selected_policy_code
    JOIN offer_visibility_rules vr ON vr.offer_code = e.offer_code
    JOIN offer_owners ow ON ow.offer_code = e.offer_code
    JOIN partner_profiles pf ON pf.id = ow.partner_profile_id
    JOIN partner_offer_links selection ON selection.offer_code = ow.offer_code
    JOIN partner_links pl ON pl.id = selection.partner_link_id
    JOIN program_offers po ON po.id = pl.catalog_offer_id
    JOIN partner_programs pp ON pp.code = po.program_code
    JOIN offers base ON base.code = po.offer_code
    WHERE e.evaluation_id = NEW.evaluation_id
      AND e.outcome = 'eligible' AND e.reason_code = 'eligible'
      AND e.subject_telegram_id = NEW.subject_telegram_id
      AND e.offer_code = NEW.offer_code
      AND e.selected_policy_code = NEW.policy_code
      AND e.promotion_window_id = NEW.promotion_window_id
      AND e.checkout_intent_hash = NEW.checkout_intent_hash
      AND e.price_authority_key_hash = NEW.price_authority_key_hash
      AND e.price_version_hash = NEW.price_version_hash
      AND e.currency = NEW.currency
      AND e.base_price_stars = NEW.base_price_stars
      AND e.discount_basis_points = NEW.discount_basis_points
      AND e.discount_stars = NEW.discount_stars
      AND e.final_price_stars = NEW.final_price_stars
      AND NEW.applied_at >= w.starts_at AND NEW.applied_at < w.ends_at
      AND p.discount_basis_points = NEW.discount_basis_points
      AND vr.moderation_status = 'approved' AND vr.visibility = 'public'
      AND vr.current_version_id = vr.approved_version_id
      AND ow.owner_kind = 'partner' AND pf.status = 'active'
      AND pf.telegram_id != NEW.subject_telegram_id
      AND pl.partner_profile_id = pf.id AND pl.status = 'approved'
      AND pl.ownership_confirmed = 1 AND pl.traffic_confirmed = 1
      AND po.status = 'active' AND pp.status = 'active' AND base.status = 'active'
      AND (SELECT COUNT(DISTINCT a.subject_telegram_id)
           FROM cabinet_promotion_application_receipts a
           WHERE a.promotion_window_id = w.window_id) < w.eligible_user_limit
  ) THEN RAISE(ABORT, 'promotion application authority mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_promotion_applications_no_update
BEFORE UPDATE ON cabinet_promotion_application_receipts
BEGIN
  SELECT RAISE(ABORT, 'promotion applications are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_promotion_applications_no_delete
BEFORE DELETE ON cabinet_promotion_application_receipts
BEGIN
  SELECT RAISE(ABORT, 'promotion applications cannot be deleted');
END;

-- Authority changes immediately make an approved/published partner offer
-- private and unapproved. The runtime still writes the richer receipt; these
-- triggers are the database-level fail-safe against stale authority.
CREATE TRIGGER IF NOT EXISTS trg_cabinet_selected_link_invalidates_approval
AFTER UPDATE OF partner_link_id ON partner_offer_links
WHEN NEW.partner_link_id != OLD.partner_link_id
BEGIN
  INSERT OR IGNORE INTO offer_moderation_decisions (
    offer_code, offer_version_id, decision, from_status, to_status,
    actor_id, actor_role, reason, event_key
  )
  SELECT vr.offer_code, vr.current_version_id, 'approval_invalidated',
    vr.moderation_status, 'not_submitted', 0, 'system',
    'Выбранная партнёрская ссылка изменилась.',
    'v140-link-selection:' || lower(hex(randomblob(16)))
  FROM offer_visibility_rules vr
  WHERE vr.offer_code = NEW.offer_code
    AND (vr.moderation_status != 'not_submitted' OR vr.visibility != 'private');
  UPDATE offer_visibility_rules
  SET moderation_status = 'not_submitted', visibility = 'private',
      submitted_version_id = NULL, approved_version_id = NULL,
      published_at = NULL, updated_by = NEW.selected_by,
      updated_at = CURRENT_TIMESTAMP
  WHERE offer_code = NEW.offer_code
    AND (moderation_status != 'not_submitted' OR visibility != 'private');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_partner_link_invalidates_approval
AFTER UPDATE OF partner_profile_id, catalog_offer_id, url, tracking_key,
  ownership_confirmed, traffic_confirmed, status ON partner_links
WHEN NEW.partner_profile_id != OLD.partner_profile_id
  OR NEW.catalog_offer_id != OLD.catalog_offer_id OR NEW.url != OLD.url
  OR NEW.tracking_key != OLD.tracking_key
  OR NEW.ownership_confirmed != OLD.ownership_confirmed
  OR NEW.traffic_confirmed != OLD.traffic_confirmed OR NEW.status != OLD.status
BEGIN
  INSERT OR IGNORE INTO offer_moderation_decisions (
    offer_code, offer_version_id, decision, from_status, to_status,
    actor_id, actor_role, reason, event_key
  )
  SELECT vr.offer_code, vr.current_version_id, 'approval_invalidated',
    vr.moderation_status, 'not_submitted', 0, 'system',
    'Партнёрская ссылка или её authority изменилась.',
    'v140-link-authority:' || lower(hex(randomblob(16)))
  FROM partner_offer_links selection
  JOIN offer_visibility_rules vr ON vr.offer_code = selection.offer_code
  WHERE selection.partner_link_id = NEW.id
    AND (vr.moderation_status != 'not_submitted' OR vr.visibility != 'private');
  UPDATE offer_visibility_rules
  SET moderation_status = 'not_submitted', visibility = 'private',
      submitted_version_id = NULL, approved_version_id = NULL,
      published_at = NULL, updated_by = 0, updated_at = CURRENT_TIMESTAMP
  WHERE offer_code IN (
    SELECT offer_code FROM partner_offer_links WHERE partner_link_id = NEW.id
  ) AND (moderation_status != 'not_submitted' OR visibility != 'private');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_program_offer_invalidates_approval
AFTER UPDATE OF program_code, offer_code, status ON program_offers
WHEN NEW.program_code != OLD.program_code OR NEW.offer_code != OLD.offer_code
  OR NEW.status != OLD.status
BEGIN
  INSERT OR IGNORE INTO offer_moderation_decisions (
    offer_code, offer_version_id, decision, from_status, to_status,
    actor_id, actor_role, reason, event_key
  )
  SELECT vr.offer_code, vr.current_version_id, 'approval_invalidated',
    vr.moderation_status, 'not_submitted', 0, 'system',
    'Связь оффера с программой изменилась.',
    'v140-program-offer:' || lower(hex(randomblob(16)))
  FROM partner_links pl
  JOIN partner_offer_links selection ON selection.partner_link_id = pl.id
  JOIN offer_visibility_rules vr ON vr.offer_code = selection.offer_code
  WHERE pl.catalog_offer_id = NEW.id
    AND (vr.moderation_status != 'not_submitted' OR vr.visibility != 'private');
  UPDATE offer_visibility_rules
  SET moderation_status = 'not_submitted', visibility = 'private',
      submitted_version_id = NULL, approved_version_id = NULL,
      published_at = NULL, updated_by = 0, updated_at = CURRENT_TIMESTAMP
  WHERE offer_code IN (
    SELECT selection.offer_code FROM partner_links pl
    JOIN partner_offer_links selection ON selection.partner_link_id = pl.id
    WHERE pl.catalog_offer_id = NEW.id
  ) AND (moderation_status != 'not_submitted' OR visibility != 'private');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_program_invalidates_approval
AFTER UPDATE OF status, allowed_domains ON partner_programs
WHEN NEW.status != OLD.status OR NEW.allowed_domains != OLD.allowed_domains
BEGIN
  INSERT OR IGNORE INTO offer_moderation_decisions (
    offer_code, offer_version_id, decision, from_status, to_status,
    actor_id, actor_role, reason, event_key
  )
  SELECT vr.offer_code, vr.current_version_id, 'approval_invalidated',
    vr.moderation_status, 'not_submitted', 0, 'system',
    'Программа или разрешённые домены изменились.',
    'v140-program:' || lower(hex(randomblob(16)))
  FROM program_offers po
  JOIN partner_links pl ON pl.catalog_offer_id = po.id
  JOIN partner_offer_links selection ON selection.partner_link_id = pl.id
  JOIN offer_visibility_rules vr ON vr.offer_code = selection.offer_code
  WHERE po.program_code = NEW.code
    AND (vr.moderation_status != 'not_submitted' OR vr.visibility != 'private');
  UPDATE offer_visibility_rules
  SET moderation_status = 'not_submitted', visibility = 'private',
      submitted_version_id = NULL, approved_version_id = NULL,
      published_at = NULL, updated_by = 0, updated_at = CURRENT_TIMESTAMP
  WHERE offer_code IN (
    SELECT selection.offer_code FROM program_offers po
    JOIN partner_links pl ON pl.catalog_offer_id = po.id
    JOIN partner_offer_links selection ON selection.partner_link_id = pl.id
    WHERE po.program_code = NEW.code
  ) AND (moderation_status != 'not_submitted' OR visibility != 'private');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_partner_profile_invalidates_approval
AFTER UPDATE OF telegram_id, status ON partner_profiles
WHEN NEW.telegram_id != OLD.telegram_id OR NEW.status != OLD.status
BEGIN
  INSERT OR IGNORE INTO offer_moderation_decisions (
    offer_code, offer_version_id, decision, from_status, to_status,
    actor_id, actor_role, reason, event_key
  )
  SELECT vr.offer_code, vr.current_version_id, 'approval_invalidated',
    vr.moderation_status, 'not_submitted', 0, 'system',
    'Профиль владельца изменился.',
    'v140-partner-profile:' || lower(hex(randomblob(16)))
  FROM offer_owners ow
  JOIN offer_visibility_rules vr ON vr.offer_code = ow.offer_code
  WHERE ow.owner_kind = 'partner' AND ow.partner_profile_id = NEW.id
    AND (vr.moderation_status != 'not_submitted' OR vr.visibility != 'private');
  UPDATE offer_visibility_rules
  SET moderation_status = 'not_submitted', visibility = 'private',
      submitted_version_id = NULL, approved_version_id = NULL,
      published_at = NULL, updated_by = 0, updated_at = CURRENT_TIMESTAMP
  WHERE offer_code IN (
    SELECT offer_code FROM offer_owners
    WHERE owner_kind = 'partner' AND partner_profile_id = NEW.id
  ) AND (moderation_status != 'not_submitted' OR visibility != 'private');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_partner_beta_access_invalidates_approval
AFTER UPDATE OF access_status, can_create_private_offers, can_submit_offers,
  expires_at ON partner_beta_access
WHEN NEW.access_status != OLD.access_status
  OR NEW.can_create_private_offers != OLD.can_create_private_offers
  OR NEW.can_submit_offers != OLD.can_submit_offers
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  INSERT OR IGNORE INTO offer_moderation_decisions (
    offer_code, offer_version_id, decision, from_status, to_status,
    actor_id, actor_role, reason, event_key
  )
  SELECT vr.offer_code, vr.current_version_id, 'approval_invalidated',
    vr.moderation_status, 'not_submitted', 0, 'system',
    'Partner Beta authority владельца изменилась.',
    'v140-partner-beta:' || lower(hex(randomblob(16)))
  FROM offer_owners ow
  JOIN offer_visibility_rules vr ON vr.offer_code = ow.offer_code
  WHERE ow.owner_kind = 'partner'
    AND ow.partner_profile_id = NEW.partner_profile_id
    AND (vr.moderation_status != 'not_submitted' OR vr.visibility != 'private');
  UPDATE offer_visibility_rules
  SET moderation_status = 'not_submitted', visibility = 'private',
      submitted_version_id = NULL, approved_version_id = NULL,
      published_at = NULL, updated_by = 0, updated_at = CURRENT_TIMESTAMP
  WHERE offer_code IN (
    SELECT offer_code FROM offer_owners
    WHERE owner_kind = 'partner'
      AND partner_profile_id = NEW.partner_profile_id
  ) AND (moderation_status != 'not_submitted' OR visibility != 'private');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_partner_role_invalidates_approval
AFTER UPDATE OF status ON user_roles
WHEN NEW.role = 'partner' AND NEW.status != OLD.status
BEGIN
  INSERT OR IGNORE INTO offer_moderation_decisions (
    offer_code, offer_version_id, decision, from_status, to_status,
    actor_id, actor_role, reason, event_key
  )
  SELECT vr.offer_code, vr.current_version_id, 'approval_invalidated',
    vr.moderation_status, 'not_submitted', 0, 'system',
    'Системная роль партнёра изменилась.',
    'v140-partner-role:' || lower(hex(randomblob(16)))
  FROM partner_profiles pf
  JOIN offer_owners ow ON ow.partner_profile_id = pf.id
    AND ow.owner_kind = 'partner'
  JOIN offer_visibility_rules vr ON vr.offer_code = ow.offer_code
  WHERE pf.telegram_id = NEW.telegram_id
    AND (vr.moderation_status != 'not_submitted' OR vr.visibility != 'private');
  UPDATE offer_visibility_rules
  SET moderation_status = 'not_submitted', visibility = 'private',
      submitted_version_id = NULL, approved_version_id = NULL,
      published_at = NULL, updated_by = 0, updated_at = CURRENT_TIMESTAMP
  WHERE offer_code IN (
    SELECT ow.offer_code FROM partner_profiles pf
    JOIN offer_owners ow ON ow.partner_profile_id = pf.id
      AND ow.owner_kind = 'partner'
    WHERE pf.telegram_id = NEW.telegram_id
  ) AND (moderation_status != 'not_submitted' OR visibility != 'private');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_offer_owner_invalidates_approval
AFTER UPDATE OF owner_kind, partner_profile_id ON offer_owners
WHEN NEW.owner_kind != OLD.owner_kind
  OR NEW.partner_profile_id IS NOT OLD.partner_profile_id
BEGIN
  INSERT OR IGNORE INTO offer_moderation_decisions (
    offer_code, offer_version_id, decision, from_status, to_status,
    actor_id, actor_role, reason, event_key
  )
  SELECT vr.offer_code, vr.current_version_id, 'approval_invalidated',
    vr.moderation_status, 'not_submitted', 0, 'system',
    'Владелец оффера изменился.',
    'v140-offer-owner:' || lower(hex(randomblob(16)))
  FROM offer_visibility_rules vr
  WHERE vr.offer_code = NEW.offer_code
    AND (vr.moderation_status != 'not_submitted' OR vr.visibility != 'private');
  UPDATE offer_visibility_rules
  SET moderation_status = 'not_submitted', visibility = 'private',
      submitted_version_id = NULL, approved_version_id = NULL,
      published_at = NULL, updated_by = NEW.updated_by,
      updated_at = CURRENT_TIMESTAMP
  WHERE offer_code = NEW.offer_code
    AND (moderation_status != 'not_submitted' OR visibility != 'private');
END;

CREATE TRIGGER IF NOT EXISTS trg_cabinet_catalog_offer_invalidates_approval
AFTER UPDATE OF status ON offers
WHEN NEW.status != OLD.status
BEGIN
  INSERT OR IGNORE INTO offer_moderation_decisions (
    offer_code, offer_version_id, decision, from_status, to_status,
    actor_id, actor_role, reason, event_key
  )
  SELECT vr.offer_code, vr.current_version_id, 'approval_invalidated',
    vr.moderation_status, 'not_submitted', 0, 'system',
    'Базовый оффер программы изменил состояние.',
    'v140-catalog-offer:' || lower(hex(randomblob(16)))
  FROM program_offers po
  JOIN partner_links pl ON pl.catalog_offer_id = po.id
  JOIN partner_offer_links selection ON selection.partner_link_id = pl.id
  JOIN offer_visibility_rules vr ON vr.offer_code = selection.offer_code
  WHERE po.offer_code = NEW.code
    AND (vr.moderation_status != 'not_submitted' OR vr.visibility != 'private');
  UPDATE offer_visibility_rules
  SET moderation_status = 'not_submitted', visibility = 'private',
      submitted_version_id = NULL, approved_version_id = NULL,
      published_at = NULL, updated_by = 0, updated_at = CURRENT_TIMESTAMP
  WHERE offer_code IN (
    SELECT selection.offer_code FROM program_offers po
    JOIN partner_links pl ON pl.catalog_offer_id = po.id
    JOIN partner_offer_links selection ON selection.partner_link_id = pl.id
    WHERE po.offer_code = NEW.code
  ) AND (moderation_status != 'not_submitted' OR visibility != 'private');
END;

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('0044-v1.4.0-offers-and-promotions');
