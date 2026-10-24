-- RE Program Bot v1.3.5 Part 1 — canonical plan foundation.
-- Additive and idempotent. Legacy user_access rows, values and indexes remain
-- untouched until the compatibility adapter is implemented in Part 2.

CREATE TABLE IF NOT EXISTS plan_catalog (
  plan_code TEXT PRIMARY KEY
    CHECK (plan_code IN ('free', 'professional', 'dragon')),
  rank_order INTEGER NOT NULL UNIQUE CHECK (rank_order BETWEEN 0 AND 100),
  color_token TEXT NOT NULL
    CHECK (color_token IN ('neutral', 'blue', 'red')),
  is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1)),
  is_purchasable INTEGER NOT NULL DEFAULT 0
    CHECK (is_purchasable IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO plan_catalog
  (plan_code, rank_order, color_token, is_public, is_purchasable)
VALUES
  ('free', 0, 'neutral', 1, 0),
  ('professional', 10, 'blue', 1, 0),
  ('dragon', 20, 'red', 1, 0);

CREATE TABLE IF NOT EXISTS plan_display_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_code TEXT NOT NULL REFERENCES plan_catalog(plan_code),
  locale TEXT NOT NULL DEFAULT 'ru',
  display_version INTEGER NOT NULL CHECK (display_version > 0),
  display_name TEXT NOT NULL,
  display_marker TEXT NOT NULL,
  display_label TEXT NOT NULL,
  change_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (plan_code, locale, display_version)
);

CREATE INDEX IF NOT EXISTS idx_plan_display_latest
  ON plan_display_versions(plan_code, locale, display_version DESC);

INSERT OR IGNORE INTO plan_display_versions
  (plan_code, locale, display_version, display_name, display_marker,
   display_label, change_reason)
VALUES
  ('free', 'ru', 1, 'Free', '⚪', 'Free ⚪',
   'Каноническое название v1.3.5.'),
  ('professional', 'ru', 1, 'Professional', '🔵', 'Professional 🔵',
   'Каноническое название v1.3.5.'),
  ('dragon', 'ru', 1, 'Dragon', '🔴', 'Dragon 🔴',
   'Каноническое название v1.3.5.');

CREATE TRIGGER IF NOT EXISTS trg_plan_display_versions_immutable_update
BEFORE UPDATE ON plan_display_versions
BEGIN
  SELECT RAISE(ABORT, 'plan display versions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_plan_display_versions_immutable_delete
BEFORE DELETE ON plan_display_versions
BEGIN
  SELECT RAISE(ABORT, 'plan display versions are immutable');
END;

-- Aliases are versioned so a later audited compatibility decision can append a
-- rule without rewriting history. Trial is a legacy access-state marker, not
-- a fourth tariff. Team is deliberately left unmapped pending the Part 2 audit.
CREATE TABLE IF NOT EXISTS plan_aliases (
  alias_code TEXT NOT NULL COLLATE NOCASE,
  alias_version INTEGER NOT NULL DEFAULT 1 CHECK (alias_version > 0),
  alias_kind TEXT NOT NULL
    CHECK (alias_kind IN ('canonical', 'legacy_state', 'legacy_plan')),
  target_plan_code TEXT REFERENCES plan_catalog(plan_code),
  target_access_state TEXT
    CHECK (target_access_state IS NULL OR target_access_state IN
      ('none', 'trial', 'active', 'cancel_at_period_end', 'expired',
       'refunded', 'suspended')),
  resolution_mode TEXT NOT NULL
    CHECK (resolution_mode IN
      ('canonical', 'preserve_legacy', 'manual_review', 'mapped_legacy')),
  accepts_new_writes INTEGER NOT NULL DEFAULT 0
    CHECK (accepts_new_writes IN (0, 1)),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (alias_code, alias_version),
  CHECK (
    (alias_kind = 'canonical' AND target_plan_code IS NOT NULL
      AND target_access_state IS NULL AND resolution_mode = 'canonical'
      AND accepts_new_writes = 1)
    OR
    (alias_kind = 'legacy_state'
      AND target_access_state IS NOT NULL
      AND accepts_new_writes = 0
      AND (
        (resolution_mode = 'preserve_legacy' AND target_plan_code IS NULL)
        OR
        (resolution_mode = 'mapped_legacy' AND target_plan_code IS NOT NULL)
      ))
    OR
    (alias_kind = 'legacy_plan'
      AND accepts_new_writes = 0
      AND (
        (resolution_mode = 'manual_review' AND target_plan_code IS NULL
          AND target_access_state IS NULL)
        OR
        (resolution_mode = 'mapped_legacy' AND target_plan_code IS NOT NULL)
      ))
  )
);

CREATE INDEX IF NOT EXISTS idx_plan_aliases_latest
  ON plan_aliases(alias_code, alias_version DESC);

CREATE VIEW IF NOT EXISTS plan_aliases_current AS
SELECT a.alias_code, a.alias_version, a.alias_kind, a.target_plan_code,
       a.target_access_state, a.resolution_mode, a.accepts_new_writes,
       a.note, a.created_at
FROM plan_aliases a
WHERE a.alias_version = (
  SELECT MAX(next_alias.alias_version)
  FROM plan_aliases next_alias
  WHERE next_alias.alias_code = a.alias_code COLLATE NOCASE
);

INSERT OR IGNORE INTO plan_aliases
  (alias_code, alias_version, alias_kind, target_plan_code,
   target_access_state, resolution_mode, accepts_new_writes, note)
VALUES
  ('free', 1, 'canonical', 'free', NULL, 'canonical', 1,
   'Канонический код Free.'),
  ('professional', 1, 'canonical', 'professional', NULL, 'canonical', 1,
   'Канонический код Professional.'),
  ('dragon', 1, 'canonical', 'dragon', NULL, 'canonical', 1,
   'Канонический код Dragon.'),
  ('trial', 1, 'legacy_state', NULL, 'trial', 'preserve_legacy', 0,
   'Старое значение сохраняется как состояние доступа; новых записей нет.'),
  ('team', 1, 'legacy_plan', NULL, NULL, 'manual_review', 0,
   'Не сопоставлять с Dragon без отдельного аудита прав.' );

CREATE TRIGGER IF NOT EXISTS trg_plan_aliases_immutable_update
BEFORE UPDATE ON plan_aliases
BEGIN
  SELECT RAISE(ABORT, 'plan aliases are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_plan_aliases_immutable_delete
BEFORE DELETE ON plan_aliases
BEGIN
  SELECT RAISE(ABORT, 'plan aliases are append-only');
END;

-- Tariff and access state are stored in separate tables. Part 1 backfills only
-- unambiguous Free/default users. Legacy Trial and Team stay on the old read
-- path until the compatibility adapter is proven in Part 2.
CREATE TABLE IF NOT EXISTS user_plans (
  telegram_id INTEGER PRIMARY KEY,
  plan_code TEXT NOT NULL REFERENCES plan_catalog(plan_code),
  source_code TEXT NOT NULL DEFAULT 'system_default',
  effective_from TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  effective_until TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE INDEX IF NOT EXISTS idx_user_plans_current
  ON user_plans(plan_code, effective_until, updated_at DESC);

CREATE TABLE IF NOT EXISTS user_access_states (
  telegram_id INTEGER PRIMARY KEY,
  access_state TEXT NOT NULL DEFAULT 'none'
    CHECK (access_state IN
      ('none', 'trial', 'active', 'cancel_at_period_end', 'expired',
       'refunded', 'suspended')),
  source_code TEXT NOT NULL DEFAULT 'system_default',
  state_started_at TEXT,
  state_ends_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (state_ends_at IS NULL OR state_started_at IS NULL
    OR state_ends_at > state_started_at)
);

CREATE INDEX IF NOT EXISTS idx_user_access_states_current
  ON user_access_states(access_state, state_ends_at, updated_at DESC);

INSERT OR IGNORE INTO user_plans
  (telegram_id, plan_code, source_code, effective_from)
SELECT u.telegram_id, 'free', 'v1.3.5:legacy_free',
       COALESCE(a.created_at, u.joined_at, CURRENT_TIMESTAMP)
FROM users u
LEFT JOIN user_access a ON a.telegram_id = u.telegram_id
WHERE a.telegram_id IS NULL OR lower(a.access_tier) = 'free';

INSERT OR IGNORE INTO user_access_states
  (telegram_id, access_state, source_code, state_started_at)
SELECT u.telegram_id, 'none', 'v1.3.5:legacy_free',
       COALESCE(a.created_at, u.joined_at, CURRENT_TIMESTAMP)
FROM users u
LEFT JOIN user_access a ON a.telegram_id = u.telegram_id
WHERE a.telegram_id IS NULL OR lower(a.access_tier) = 'free';

-- Aggregate-only inventory: no Telegram identifiers are copied into the audit.
CREATE TABLE IF NOT EXISTS plan_legacy_audit (
  audit_key TEXT PRIMARY KEY,
  audit_phase TEXT NOT NULL
    CHECK (audit_phase IN ('part1_inventory', 'part2_adapter', 'part5_release')),
  users_total INTEGER NOT NULL CHECK (users_total >= 0),
  access_rows_total INTEGER NOT NULL CHECK (access_rows_total >= 0),
  access_rows_missing INTEGER NOT NULL CHECK (access_rows_missing >= 0),
  legacy_free_rows INTEGER NOT NULL CHECK (legacy_free_rows >= 0),
  legacy_trial_rows INTEGER NOT NULL CHECK (legacy_trial_rows >= 0),
  legacy_team_rows INTEGER NOT NULL CHECK (legacy_team_rows >= 0),
  unknown_rows INTEGER NOT NULL CHECK (unknown_rows >= 0),
  canonical_backfilled_rows INTEGER NOT NULL
    CHECK (canonical_backfilled_rows >= 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO plan_legacy_audit
  (audit_key, audit_phase, users_total, access_rows_total,
   access_rows_missing, legacy_free_rows, legacy_trial_rows,
   legacy_team_rows, unknown_rows, canonical_backfilled_rows, note)
SELECT
  'v1.3.5-part1-inventory',
  'part1_inventory',
  (SELECT COUNT(*) FROM users),
  (SELECT COUNT(*) FROM user_access),
  (SELECT COUNT(*) FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM user_access a WHERE a.telegram_id = u.telegram_id
    )),
  (SELECT COUNT(*) FROM user_access WHERE lower(access_tier) = 'free'),
  (SELECT COUNT(*) FROM user_access WHERE lower(access_tier) = 'trial'),
  (SELECT COUNT(*) FROM user_access WHERE lower(access_tier) = 'team'),
  (SELECT COUNT(*) FROM user_access
    WHERE lower(COALESCE(access_tier, '')) NOT IN ('free', 'trial', 'team')),
  (SELECT COUNT(*) FROM user_plans
    WHERE source_code = 'v1.3.5:legacy_free'),
  'Part 1 snapshot: Trial and Team deliberately remain on the legacy read path.';

CREATE TRIGGER IF NOT EXISTS trg_plan_legacy_audit_immutable_update
BEFORE UPDATE ON plan_legacy_audit
BEGIN
  SELECT RAISE(ABORT, 'plan legacy audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_plan_legacy_audit_immutable_delete
BEFORE DELETE ON plan_legacy_audit
BEGIN
  SELECT RAISE(ABORT, 'plan legacy audit is append-only');
END;

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.5-plan-foundation');
