-- RE Program Bot v1.3.9 Part 4
-- Deterministic metric projections, funnels, cohorts and reconciliation.
-- Additive and dormant: no flag is enabled and no production source is read.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS analytics_metric_dictionary (
  metric_key TEXT PRIMARY KEY CHECK (
    length(metric_key) BETWEEN 3 AND 64
    AND metric_key = lower(metric_key)
    AND metric_key NOT GLOB '*[^a-z0-9_]*'
  ),
  metric_version INTEGER NOT NULL DEFAULT 1 CHECK (metric_version = 1),
  metric_family TEXT NOT NULL CHECK (metric_family IN (
    'daily', 'funnel', 'cohort', 'ambassador'
  )),
  aggregation_kind TEXT NOT NULL CHECK (aggregation_kind IN (
    'event_count', 'unique_actor', 'ratio', 'ordered_unique_actor'
  )),
  denominator_policy TEXT NOT NULL CHECK (denominator_policy IN (
    'none', 'event_members', 'previous_funnel_step', 'cohort_size'
  )),
  timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (timezone = 'UTC'),
  dimension_policy TEXT NOT NULL CHECK (dimension_policy IN (
    'global_and_core', 'funnel', 'cohort', 'ambassador_scopes'
  )),
  exclusion_policy TEXT NOT NULL CHECK (exclusion_policy IN (
    'effective_events_only', 'effective_active_events',
    'ordered_effective_events', 'exact_attribution_only'
  )),
  source_authority TEXT NOT NULL CHECK (source_authority IN (
    'canonical_events', 'canonical_events_and_exact_attribution'
  )),
  small_cell_policy TEXT NOT NULL DEFAULT 'suppress_below_threshold'
    CHECK (small_cell_policy = 'suppress_below_threshold'),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

INSERT OR IGNORE INTO analytics_metric_dictionary (
  metric_key, metric_version, metric_family, aggregation_kind,
  denominator_policy, timezone, dimension_policy, exclusion_policy,
  source_authority, small_cell_policy, created_at
) VALUES
  ('events_total', 1, 'daily', 'event_count', 'none', 'UTC',
   'global_and_core', 'effective_events_only', 'canonical_events',
   'suppress_below_threshold', unixepoch()),
  ('active_actors', 1, 'daily', 'unique_actor', 'none', 'UTC',
   'global_and_core', 'effective_active_events', 'canonical_events',
   'suppress_below_threshold', unixepoch()),
  ('registrations', 1, 'daily', 'event_count', 'none', 'UTC',
   'global_and_core', 'effective_events_only', 'canonical_events',
   'suppress_below_threshold', unixepoch()),
  ('offer_views', 1, 'daily', 'event_count', 'none', 'UTC',
   'global_and_core', 'effective_events_only', 'canonical_events',
   'suppress_below_threshold', unixepoch()),
  ('leads', 1, 'daily', 'event_count', 'none', 'UTC',
   'global_and_core', 'effective_events_only', 'canonical_events',
   'suppress_below_threshold', unixepoch()),
  ('payments_succeeded', 1, 'daily', 'event_count', 'none', 'UTC',
   'global_and_core', 'effective_events_only', 'canonical_events',
   'suppress_below_threshold', unixepoch()),
  ('access_applied', 1, 'daily', 'event_count', 'none', 'UTC',
   'global_and_core', 'effective_events_only', 'canonical_events',
   'suppress_below_threshold', unixepoch()),
  ('refunds', 1, 'daily', 'event_count', 'none', 'UTC',
   'global_and_core', 'effective_events_only', 'canonical_events',
   'suppress_below_threshold', unixepoch()),
  ('ai_successes', 1, 'daily', 'event_count', 'none', 'UTC',
   'global_and_core', 'effective_events_only', 'canonical_events',
   'suppress_below_threshold', unixepoch()),
  ('ai_failures', 1, 'daily', 'event_count', 'none', 'UTC',
   'global_and_core', 'effective_events_only', 'canonical_events',
   'suppress_below_threshold', unixepoch()),
  ('ai_limits', 1, 'daily', 'event_count', 'none', 'UTC',
   'global_and_core', 'effective_events_only', 'canonical_events',
   'suppress_below_threshold', unixepoch()),
  ('ai_success_rate', 1, 'daily', 'ratio', 'event_members', 'UTC',
   'global_and_core', 'effective_events_only', 'canonical_events',
   'suppress_below_threshold', unixepoch()),
  ('confirmed_rewards', 1, 'daily', 'event_count', 'none', 'UTC',
   'global_and_core', 'effective_events_only', 'canonical_events',
   'suppress_below_threshold', unixepoch()),
  ('product_funnel', 1, 'funnel', 'ordered_unique_actor',
   'previous_funnel_step', 'UTC', 'funnel', 'ordered_effective_events',
   'canonical_events', 'suppress_below_threshold', unixepoch()),
  ('ambassador_funnel', 1, 'funnel', 'ordered_unique_actor',
   'previous_funnel_step', 'UTC', 'funnel', 'ordered_effective_events',
   'canonical_events_and_exact_attribution',
   'suppress_below_threshold', unixepoch()),
  ('retention', 1, 'cohort', 'unique_actor', 'cohort_size', 'UTC',
   'cohort', 'effective_active_events', 'canonical_events',
   'suppress_below_threshold', unixepoch()),
  ('tracking_opens', 1, 'ambassador', 'event_count', 'none', 'UTC',
   'ambassador_scopes', 'exact_attribution_only',
   'canonical_events_and_exact_attribution',
   'suppress_below_threshold', unixepoch()),
  ('attributed_registrations', 1, 'ambassador', 'event_count', 'none', 'UTC',
   'ambassador_scopes', 'exact_attribution_only',
   'canonical_events_and_exact_attribution',
   'suppress_below_threshold', unixepoch()),
  ('attributed_leads', 1, 'ambassador', 'event_count', 'none', 'UTC',
   'ambassador_scopes', 'exact_attribution_only',
   'canonical_events_and_exact_attribution',
   'suppress_below_threshold', unixepoch()),
  ('applied_paid_access', 1, 'ambassador', 'event_count', 'none', 'UTC',
   'ambassador_scopes', 'exact_attribution_only',
   'canonical_events_and_exact_attribution',
   'suppress_below_threshold', unixepoch()),
  ('confirmed_referral_rewards', 1, 'ambassador', 'event_count', 'none', 'UTC',
   'ambassador_scopes', 'exact_attribution_only',
   'canonical_events_and_exact_attribution',
   'suppress_below_threshold', unixepoch());

CREATE TABLE IF NOT EXISTS analytics_metric_event_members (
  metric_key TEXT NOT NULL REFERENCES analytics_metric_dictionary(metric_key)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  event_name TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1 CHECK (event_version = 1),
  contribution_kind TEXT NOT NULL CHECK (contribution_kind IN (
    'numerator', 'denominator', 'active'
  )),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (metric_key, event_name, event_version, contribution_kind),
  FOREIGN KEY (event_name, event_version)
    REFERENCES analytics_event_registry(event_name, event_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

INSERT OR IGNORE INTO analytics_metric_event_members
  (metric_key, event_name, event_version, contribution_kind, created_at)
VALUES
  ('registrations', 'account_created', 1, 'numerator', unixepoch()),
  ('offer_views', 'offer_opened', 1, 'numerator', unixepoch()),
  ('leads', 'lead_submitted', 1, 'numerator', unixepoch()),
  ('payments_succeeded', 'payment_succeeded', 1, 'numerator', unixepoch()),
  ('access_applied', 'access_activated', 1, 'numerator', unixepoch()),
  ('refunds', 'payment_refunded', 1, 'numerator', unixepoch()),
  ('ai_successes', 'ai_generation_succeeded', 1, 'numerator', unixepoch()),
  ('ai_failures', 'ai_generation_failed', 1, 'numerator', unixepoch()),
  ('ai_limits', 'ai_limit_hit', 1, 'numerator', unixepoch()),
  ('ai_success_rate', 'ai_generation_succeeded', 1, 'numerator', unixepoch()),
  ('ai_success_rate', 'ai_generation_succeeded', 1, 'denominator', unixepoch()),
  ('ai_success_rate', 'ai_generation_failed', 1, 'denominator', unixepoch()),
  ('confirmed_rewards', 'referral_reward_confirmed', 1, 'numerator', unixepoch()),
  ('tracking_opens', 'campaign_touch_recorded', 1, 'numerator', unixepoch()),
  ('attributed_registrations', 'registration_attributed', 1, 'numerator', unixepoch()),
  ('attributed_leads', 'lead_attributed', 1, 'numerator', unixepoch()),
  ('applied_paid_access', 'paid_access_attributed', 1, 'numerator', unixepoch()),
  ('confirmed_referral_rewards', 'referral_reward_confirmed', 1, 'numerator', unixepoch()),
  ('active_actors', 'menu_opened', 1, 'active', unixepoch()),
  ('active_actors', 'offer_opened', 1, 'active', unixepoch()),
  ('active_actors', 'lead_submitted', 1, 'active', unixepoch()),
  ('active_actors', 'notification_opened', 1, 'active', unixepoch()),
  ('active_actors', 'partner_program_opened', 1, 'active', unixepoch()),
  ('active_actors', 'partner_link_submitted', 1, 'active', unixepoch()),
  ('active_actors', 'partner_link_opened', 1, 'active', unixepoch()),
  ('active_actors', 'campaign_touch_recorded', 1, 'active', unixepoch()),
  ('active_actors', 'lead_attributed', 1, 'active', unixepoch()),
  ('active_actors', 'payment_succeeded', 1, 'active', unixepoch()),
  ('active_actors', 'access_activated', 1, 'active', unixepoch()),
  ('active_actors', 'ai_opened', 1, 'active', unixepoch()),
  ('active_actors', 'ai_generation_succeeded', 1, 'active', unixepoch()),
  ('active_actors', 'ai_generation_failed', 1, 'active', unixepoch()),
  ('active_actors', 'ai_limit_hit', 1, 'active', unixepoch()),
  ('retention', 'menu_opened', 1, 'active', unixepoch()),
  ('retention', 'offer_opened', 1, 'active', unixepoch()),
  ('retention', 'lead_submitted', 1, 'active', unixepoch()),
  ('retention', 'notification_opened', 1, 'active', unixepoch()),
  ('retention', 'partner_program_opened', 1, 'active', unixepoch()),
  ('retention', 'partner_link_opened', 1, 'active', unixepoch()),
  ('retention', 'campaign_touch_recorded', 1, 'active', unixepoch()),
  ('retention', 'payment_succeeded', 1, 'active', unixepoch()),
  ('retention', 'access_activated', 1, 'active', unixepoch()),
  ('retention', 'ai_opened', 1, 'active', unixepoch()),
  ('retention', 'ai_generation_succeeded', 1, 'active', unixepoch());

CREATE TABLE IF NOT EXISTS analytics_funnel_registry (
  funnel_key TEXT PRIMARY KEY CHECK (funnel_key IN (
    'product', 'ambassador'
  )),
  metric_key TEXT NOT NULL REFERENCES analytics_metric_dictionary(metric_key)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (timezone = 'UTC'),
  sequence_policy TEXT NOT NULL DEFAULT 'same_day_non_decreasing_time'
    CHECK (sequence_policy = 'same_day_non_decreasing_time'),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

INSERT OR IGNORE INTO analytics_funnel_registry
  (funnel_key, metric_key, timezone, sequence_policy, created_at)
VALUES
  ('product', 'product_funnel', 'UTC',
   'same_day_non_decreasing_time', unixepoch()),
  ('ambassador', 'ambassador_funnel', 'UTC',
   'same_day_non_decreasing_time', unixepoch());

CREATE TABLE IF NOT EXISTS analytics_funnel_steps (
  funnel_key TEXT NOT NULL REFERENCES analytics_funnel_registry(funnel_key)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  step_key TEXT NOT NULL CHECK (
    length(step_key) BETWEEN 3 AND 64
    AND step_key = lower(step_key)
    AND step_key NOT GLOB '*[^a-z0-9_]*'
  ),
  step_order INTEGER NOT NULL CHECK (step_order BETWEEN 1 AND 16),
  event_name TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1 CHECK (event_version = 1),
  exact_attribution_required INTEGER NOT NULL DEFAULT 0
    CHECK (exact_attribution_required IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (funnel_key, step_key),
  UNIQUE (funnel_key, step_order),
  FOREIGN KEY (event_name, event_version)
    REFERENCES analytics_event_registry(event_name, event_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (funnel_key = 'product' AND exact_attribution_required = 0)
    OR (funnel_key = 'ambassador' AND exact_attribution_required = 1)
  )
);

INSERT OR IGNORE INTO analytics_funnel_steps
  (funnel_key, step_key, step_order, event_name, event_version,
   exact_attribution_required, created_at)
VALUES
  ('product', 'start', 1, 'start_received', 1, 0, unixepoch()),
  ('product', 'registration', 2, 'account_created', 1, 0, unixepoch()),
  ('product', 'menu', 3, 'menu_opened', 1, 0, unixepoch()),
  ('product', 'offer', 4, 'offer_opened', 1, 0, unixepoch()),
  ('product', 'lead', 5, 'lead_submitted', 1, 0, unixepoch()),
  ('product', 'applied_access', 6, 'access_activated', 1, 0, unixepoch()),
  ('ambassador', 'tracking_open', 1, 'campaign_touch_recorded', 1, 1, unixepoch()),
  ('ambassador', 'registration', 2, 'registration_attributed', 1, 1, unixepoch()),
  ('ambassador', 'lead', 3, 'lead_attributed', 1, 1, unixepoch()),
  ('ambassador', 'applied_access', 4, 'paid_access_attributed', 1, 1, unixepoch());

CREATE TABLE IF NOT EXISTS analytics_projection_snapshots (
  snapshot_id TEXT PRIMARY KEY CHECK (
    length(snapshot_id) = 64
    AND snapshot_id = lower(snapshot_id)
    AND snapshot_id NOT GLOB '*[^0-9a-f]*'
  ),
  metric_date INTEGER NOT NULL CHECK (
    metric_date > 0 AND metric_date % 86400 = 0
  ),
  input_digest TEXT NOT NULL CHECK (
    length(input_digest) = 64
    AND input_digest = lower(input_digest)
    AND input_digest NOT GLOB '*[^0-9a-f]*'
  ),
  output_digest TEXT NOT NULL CHECK (
    length(output_digest) = 64
    AND output_digest = lower(output_digest)
    AND output_digest NOT GLOB '*[^0-9a-f]*'
  ),
  policy_version TEXT NOT NULL
    CHECK (policy_version = '2026-09-13.analytics-v2-part4'),
  event_rows INTEGER NOT NULL CHECK (event_rows >= 0),
  correction_rows INTEGER NOT NULL CHECK (correction_rows >= 0),
  effective_rows INTEGER NOT NULL CHECK (effective_rows >= 0),
  projection_rows INTEGER NOT NULL CHECK (projection_rows >= 0),
  cohort_dates INTEGER NOT NULL CHECK (cohort_dates BETWEEN 1 AND 4),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  UNIQUE (metric_date, input_digest)
);

CREATE INDEX IF NOT EXISTS idx_projection_snapshots_date
  ON analytics_projection_snapshots(metric_date, created_at, snapshot_id);

CREATE TABLE IF NOT EXISTS analytics_projection_attribution_bindings (
  binding_id TEXT PRIMARY KEY CHECK (
    length(binding_id) = 36 AND binding_id = lower(binding_id)
  ),
  binding_key TEXT NOT NULL UNIQUE CHECK (
    length(binding_key) = 64
    AND binding_key = lower(binding_key)
    AND binding_key NOT GLOB '*[^0-9a-f]*'
  ),
  event_id TEXT NOT NULL UNIQUE REFERENCES canonical_analytics_events(event_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN (
    'touchpoint', 'decision'
  )),
  touchpoint_id TEXT REFERENCES analytics_attribution_touchpoints(touchpoint_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  decision_id TEXT REFERENCES analytics_attribution_decisions(decision_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ambassador_id TEXT NOT NULL REFERENCES ambassador_profiles_v2(ambassador_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  campaign_id TEXT REFERENCES ambassador_campaigns(campaign_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  program_code TEXT NOT NULL REFERENCES partner_programs(code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  catalog_offer_id INTEGER REFERENCES program_offers(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  evidence_hash TEXT NOT NULL CHECK (
    length(evidence_hash) = 64
    AND evidence_hash = lower(evidence_hash)
    AND evidence_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= created_at
    AND retention_until <= created_at + 15552000
  ),
  CHECK (
    (evidence_kind = 'touchpoint' AND touchpoint_id IS NOT NULL
      AND decision_id IS NULL AND campaign_id IS NOT NULL)
    OR (evidence_kind = 'decision' AND decision_id IS NOT NULL
      AND touchpoint_id IS NULL)
  ),
  CHECK (campaign_id IS NOT NULL OR catalog_offer_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_projection_bindings_ambassador
  ON analytics_projection_attribution_bindings(
    ambassador_id, campaign_id, event_id
  );

CREATE INDEX IF NOT EXISTS idx_projection_bindings_retention
  ON analytics_projection_attribution_bindings(retention_until, binding_id);

CREATE TABLE IF NOT EXISTS analytics_projection_snapshot_bindings (
  snapshot_id TEXT NOT NULL REFERENCES analytics_projection_snapshots(snapshot_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  binding_id TEXT NOT NULL
    REFERENCES analytics_projection_attribution_bindings(binding_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= created_at
    AND retention_until <= created_at + 15552000
  ),
  PRIMARY KEY (snapshot_id, binding_id)
);

CREATE INDEX IF NOT EXISTS idx_projection_snapshot_bindings_retention
  ON analytics_projection_snapshot_bindings(retention_until, snapshot_id);

CREATE TABLE IF NOT EXISTS analytics_daily_actor_facts (
  snapshot_id TEXT NOT NULL REFERENCES analytics_projection_snapshots(snapshot_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  metric_date INTEGER NOT NULL CHECK (
    metric_date > 0 AND metric_date % 86400 = 0
  ),
  actor_pseudonym TEXT NOT NULL CHECK (
    length(actor_pseudonym) = 64
    AND actor_pseudonym = lower(actor_pseudonym)
    AND actor_pseudonym NOT GLOB '*[^0-9a-f]*'
  ),
  pseudonym_key_version INTEGER NOT NULL CHECK (pseudonym_key_version > 0),
  event_name TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1 CHECK (event_version = 1),
  event_count INTEGER NOT NULL CHECK (event_count > 0),
  first_occurred_at INTEGER NOT NULL CHECK (first_occurred_at >= metric_date),
  last_occurred_at INTEGER NOT NULL CHECK (
    last_occurred_at >= first_occurred_at
    AND last_occurred_at < metric_date + 86400
  ),
  fact_hash TEXT NOT NULL CHECK (
    length(fact_hash) = 64
    AND fact_hash = lower(fact_hash)
    AND fact_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  retention_until INTEGER NOT NULL CHECK (
    retention_until >= created_at
    AND retention_until <= created_at + 15552000
  ),
  PRIMARY KEY (snapshot_id, metric_date, actor_pseudonym, event_name),
  FOREIGN KEY (event_name, event_version)
    REFERENCES analytics_event_registry(event_name, event_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_daily_actor_facts_subject
  ON analytics_daily_actor_facts(actor_pseudonym, metric_date, snapshot_id);

CREATE INDEX IF NOT EXISTS idx_daily_actor_facts_retention
  ON analytics_daily_actor_facts(retention_until, snapshot_id);

CREATE TABLE IF NOT EXISTS analytics_daily_metrics (
  snapshot_id TEXT NOT NULL REFERENCES analytics_projection_snapshots(snapshot_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  metric_date INTEGER NOT NULL CHECK (
    metric_date > 0 AND metric_date % 86400 = 0
  ),
  metric_key TEXT NOT NULL REFERENCES analytics_metric_dictionary(metric_key)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  dimension_name TEXT NOT NULL CHECK (dimension_name IN (
    'global', 'role', 'plan', 'access_state', 'source_family'
  )),
  dimension_value TEXT NOT NULL CHECK (length(dimension_value) BETWEEN 1 AND 80),
  numerator_count INTEGER NOT NULL CHECK (numerator_count >= 0),
  denominator_count INTEGER NOT NULL CHECK (denominator_count >= 0),
  unique_actors INTEGER NOT NULL CHECK (unique_actors >= 0),
  metric_value INTEGER CHECK (metric_value IS NULL OR metric_value >= 0),
  small_cell_threshold INTEGER NOT NULL CHECK (
    small_cell_threshold BETWEEN 5 AND 20
  ),
  suppressed INTEGER NOT NULL CHECK (suppressed IN (0, 1)),
  row_hash TEXT NOT NULL CHECK (
    length(row_hash) = 64
    AND row_hash = lower(row_hash)
    AND row_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (
    snapshot_id, metric_date, metric_key, dimension_name, dimension_value
  ),
  CHECK (
    (dimension_name = 'global' AND dimension_value = 'all')
    OR (dimension_name != 'global' AND dimension_value != 'all')
  ),
  CHECK (
    (suppressed = 1 AND unique_actors < small_cell_threshold)
    OR (suppressed = 0 AND unique_actors >= small_cell_threshold)
  )
);

CREATE INDEX IF NOT EXISTS idx_daily_metrics_lookup
  ON analytics_daily_metrics(metric_date, metric_key, dimension_name,
    dimension_value, snapshot_id);

CREATE TABLE IF NOT EXISTS analytics_funnel_daily (
  snapshot_id TEXT NOT NULL REFERENCES analytics_projection_snapshots(snapshot_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  metric_date INTEGER NOT NULL CHECK (
    metric_date > 0 AND metric_date % 86400 = 0
  ),
  funnel_key TEXT NOT NULL REFERENCES analytics_funnel_registry(funnel_key)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  step_key TEXT NOT NULL,
  step_order INTEGER NOT NULL CHECK (step_order BETWEEN 1 AND 16),
  qualified_actors INTEGER NOT NULL CHECK (qualified_actors >= 0),
  previous_step_actors INTEGER NOT NULL CHECK (previous_step_actors >= 0),
  conversion_bps INTEGER CHECK (
    conversion_bps IS NULL OR conversion_bps BETWEEN 0 AND 10000
  ),
  small_cell_threshold INTEGER NOT NULL CHECK (
    small_cell_threshold BETWEEN 5 AND 20
  ),
  suppressed INTEGER NOT NULL CHECK (suppressed IN (0, 1)),
  row_hash TEXT NOT NULL CHECK (
    length(row_hash) = 64
    AND row_hash = lower(row_hash)
    AND row_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (snapshot_id, metric_date, funnel_key, step_key),
  FOREIGN KEY (funnel_key, step_key)
    REFERENCES analytics_funnel_steps(funnel_key, step_key)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (qualified_actors <= previous_step_actors OR step_order = 1),
  CHECK (
    (suppressed = 1 AND qualified_actors < small_cell_threshold)
    OR (suppressed = 0 AND qualified_actors >= small_cell_threshold)
  )
);

CREATE INDEX IF NOT EXISTS idx_funnel_daily_lookup
  ON analytics_funnel_daily(metric_date, funnel_key, step_order, snapshot_id);

CREATE TABLE IF NOT EXISTS analytics_cohort_daily (
  snapshot_id TEXT NOT NULL REFERENCES analytics_projection_snapshots(snapshot_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  cohort_date INTEGER NOT NULL CHECK (
    cohort_date > 0 AND cohort_date % 86400 = 0
  ),
  offset_days INTEGER NOT NULL CHECK (offset_days IN (1, 7, 30)),
  activity_date INTEGER NOT NULL CHECK (
    activity_date = cohort_date + offset_days * 86400
  ),
  cohort_size INTEGER NOT NULL CHECK (cohort_size >= 0),
  retained_actors INTEGER NOT NULL CHECK (
    retained_actors >= 0 AND retained_actors <= cohort_size
  ),
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  retention_bps INTEGER CHECK (
    retention_bps IS NULL OR retention_bps BETWEEN 0 AND 10000
  ),
  small_cell_threshold INTEGER NOT NULL CHECK (
    small_cell_threshold BETWEEN 5 AND 20
  ),
  suppressed INTEGER NOT NULL CHECK (suppressed IN (0, 1)),
  row_hash TEXT NOT NULL CHECK (
    length(row_hash) = 64
    AND row_hash = lower(row_hash)
    AND row_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (snapshot_id, cohort_date, offset_days),
  CHECK (eligible = 1 OR (retained_actors = 0 AND retention_bps IS NULL)),
  CHECK (
    retention_bps IS NULL
    OR (eligible = 1 AND cohort_size > 0 AND suppressed = 0)
  ),
  CHECK (
    (suppressed = 1 AND cohort_size < small_cell_threshold)
    OR (suppressed = 0 AND cohort_size >= small_cell_threshold)
  )
);

CREATE INDEX IF NOT EXISTS idx_cohort_daily_lookup
  ON analytics_cohort_daily(cohort_date, offset_days, snapshot_id);

CREATE TABLE IF NOT EXISTS ambassador_metrics_daily (
  snapshot_id TEXT NOT NULL REFERENCES analytics_projection_snapshots(snapshot_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  metric_date INTEGER NOT NULL CHECK (
    metric_date > 0 AND metric_date % 86400 = 0
  ),
  ambassador_id TEXT NOT NULL REFERENCES ambassador_profiles_v2(ambassador_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN (
    'ambassador', 'campaign', 'program', 'offer'
  )),
  scope_hash TEXT NOT NULL CHECK (
    length(scope_hash) = 64
    AND scope_hash = lower(scope_hash)
    AND scope_hash NOT GLOB '*[^0-9a-f]*'
  ),
  campaign_id TEXT REFERENCES ambassador_campaigns(campaign_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  program_code TEXT,
  catalog_offer_id INTEGER,
  metric_key TEXT NOT NULL REFERENCES analytics_metric_dictionary(metric_key)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  metric_count INTEGER NOT NULL CHECK (metric_count >= 0),
  unique_actors INTEGER NOT NULL CHECK (unique_actors >= 0),
  small_cell_threshold INTEGER NOT NULL CHECK (
    small_cell_threshold BETWEEN 5 AND 20
  ),
  suppressed INTEGER NOT NULL CHECK (suppressed IN (0, 1)),
  row_hash TEXT NOT NULL CHECK (
    length(row_hash) = 64
    AND row_hash = lower(row_hash)
    AND row_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (
    snapshot_id, metric_date, ambassador_id, scope_kind, scope_hash, metric_key
  ),
  CHECK (
    (scope_kind = 'ambassador' AND campaign_id IS NULL
      AND program_code IS NULL AND catalog_offer_id IS NULL)
    OR (scope_kind = 'campaign' AND campaign_id IS NOT NULL
      AND program_code IS NULL AND catalog_offer_id IS NULL)
    OR (scope_kind = 'program' AND campaign_id IS NULL
      AND program_code IS NOT NULL AND catalog_offer_id IS NULL)
    OR (scope_kind = 'offer' AND campaign_id IS NULL
      AND program_code IS NOT NULL AND catalog_offer_id IS NOT NULL)
  ),
  CHECK (
    (suppressed = 1 AND unique_actors < small_cell_threshold)
    OR (suppressed = 0 AND unique_actors >= small_cell_threshold)
  )
);

CREATE INDEX IF NOT EXISTS idx_ambassador_metrics_daily_lookup
  ON ambassador_metrics_daily(
    ambassador_id, metric_date, metric_key, scope_kind, snapshot_id
  );

CREATE TABLE IF NOT EXISTS analytics_projection_checkpoints (
  projection_kind TEXT NOT NULL CHECK (projection_kind IN (
    'daily', 'funnel', 'cohort', 'ambassador'
  )),
  metric_date INTEGER NOT NULL CHECK (
    metric_date > 0 AND metric_date % 86400 = 0
  ),
  current_snapshot_id TEXT NOT NULL
    REFERENCES analytics_projection_snapshots(snapshot_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  input_digest TEXT NOT NULL CHECK (
    length(input_digest) = 64
    AND input_digest = lower(input_digest)
    AND input_digest NOT GLOB '*[^0-9a-f]*'
  ),
  output_digest TEXT NOT NULL CHECK (
    length(output_digest) = 64
    AND output_digest = lower(output_digest)
    AND output_digest NOT GLOB '*[^0-9a-f]*'
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (projection_kind, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_projection_checkpoints_snapshot
  ON analytics_projection_checkpoints(current_snapshot_id, projection_kind);

CREATE TABLE IF NOT EXISTS analytics_projection_reconciliation (
  snapshot_id TEXT PRIMARY KEY REFERENCES analytics_projection_snapshots(snapshot_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_rows_seen INTEGER NOT NULL CHECK (source_rows_seen >= 0),
  source_rows_accounted INTEGER NOT NULL CHECK (source_rows_accounted >= 0),
  canonical_rows_observed INTEGER NOT NULL CHECK (canonical_rows_observed >= 0),
  canonical_rows_expected INTEGER NOT NULL CHECK (canonical_rows_expected >= 0),
  correction_rows INTEGER NOT NULL CHECK (correction_rows >= 0),
  effective_rows INTEGER NOT NULL CHECK (effective_rows >= 0),
  projected_effective_rows INTEGER NOT NULL CHECK (projected_effective_rows >= 0),
  source_delta INTEGER NOT NULL,
  canonical_delta INTEGER NOT NULL,
  projection_delta INTEGER NOT NULL,
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64
    AND evidence_digest = lower(evidence_digest)
    AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  CHECK (source_delta = source_rows_seen - source_rows_accounted),
  CHECK (canonical_delta = canonical_rows_observed - canonical_rows_expected),
  CHECK (projection_delta = effective_rows - projected_effective_rows)
);

CREATE TABLE IF NOT EXISTS analytics_projection_privacy_inventory (
  dataset_name TEXT PRIMARY KEY CHECK (dataset_name IN (
    'analytics_metric_dictionary', 'analytics_metric_event_members',
    'analytics_funnel_registry', 'analytics_funnel_steps',
    'analytics_projection_snapshots',
    'analytics_projection_attribution_bindings',
    'analytics_projection_snapshot_bindings',
    'analytics_daily_actor_facts', 'analytics_daily_metrics',
    'analytics_funnel_daily', 'analytics_cohort_daily',
    'ambassador_metrics_daily', 'analytics_projection_checkpoints',
    'analytics_projection_reconciliation'
  )),
  privacy_class TEXT NOT NULL CHECK (privacy_class IN (
    'pseudonymous', 'anonymous', 'non_identifying', 'operational'
  )),
  raw_identifier_columns INTEGER NOT NULL DEFAULT 0
    CHECK (raw_identifier_columns = 0),
  content_columns INTEGER NOT NULL DEFAULT 0 CHECK (content_columns = 0),
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 0 AND 180),
  deletion_mode TEXT NOT NULL CHECK (deletion_mode IN (
    'immutable_contract', 'guarded_subject_or_retention'
  )),
  policy_version TEXT NOT NULL
    CHECK (policy_version = '2026-09-13.analytics-v2-part4'),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

INSERT OR IGNORE INTO analytics_projection_privacy_inventory
  (dataset_name, privacy_class, raw_identifier_columns, content_columns,
   retention_days, deletion_mode, policy_version, created_at)
VALUES
  ('analytics_metric_dictionary', 'non_identifying', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part4', unixepoch()),
  ('analytics_metric_event_members', 'non_identifying', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part4', unixepoch()),
  ('analytics_funnel_registry', 'non_identifying', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part4', unixepoch()),
  ('analytics_funnel_steps', 'non_identifying', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part4', unixepoch()),
  ('analytics_projection_snapshots', 'anonymous', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part4', unixepoch()),
  ('analytics_projection_attribution_bindings', 'pseudonymous', 0, 0, 180,
   'guarded_subject_or_retention', '2026-09-13.analytics-v2-part4', unixepoch()),
  ('analytics_projection_snapshot_bindings', 'pseudonymous', 0, 0, 180,
   'guarded_subject_or_retention', '2026-09-13.analytics-v2-part4', unixepoch()),
  ('analytics_daily_actor_facts', 'pseudonymous', 0, 0, 180,
   'guarded_subject_or_retention', '2026-09-13.analytics-v2-part4', unixepoch()),
  ('analytics_daily_metrics', 'anonymous', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part4', unixepoch()),
  ('analytics_funnel_daily', 'anonymous', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part4', unixepoch()),
  ('analytics_cohort_daily', 'anonymous', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part4', unixepoch()),
  ('ambassador_metrics_daily', 'anonymous', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part4', unixepoch()),
  ('analytics_projection_checkpoints', 'operational', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part4', unixepoch()),
  ('analytics_projection_reconciliation', 'anonymous', 0, 0, 0,
   'immutable_contract', '2026-09-13.analytics-v2-part4', unixepoch());

CREATE TRIGGER IF NOT EXISTS trg_metric_dictionary_no_update
BEFORE UPDATE ON analytics_metric_dictionary
BEGIN
  SELECT RAISE(ABORT, 'analytics metric dictionary is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_metric_dictionary_no_delete
BEFORE DELETE ON analytics_metric_dictionary
BEGIN
  SELECT RAISE(ABORT, 'analytics metric dictionary cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_metric_members_no_update
BEFORE UPDATE ON analytics_metric_event_members
BEGIN
  SELECT RAISE(ABORT, 'analytics metric members are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_metric_members_no_delete
BEFORE DELETE ON analytics_metric_event_members
BEGIN
  SELECT RAISE(ABORT, 'analytics metric members cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_funnel_registry_no_update
BEFORE UPDATE ON analytics_funnel_registry
BEGIN
  SELECT RAISE(ABORT, 'analytics funnel registry is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_funnel_registry_no_delete
BEFORE DELETE ON analytics_funnel_registry
BEGIN
  SELECT RAISE(ABORT, 'analytics funnel registry cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_funnel_steps_no_update
BEFORE UPDATE ON analytics_funnel_steps
BEGIN
  SELECT RAISE(ABORT, 'analytics funnel steps are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_funnel_steps_no_delete
BEFORE DELETE ON analytics_funnel_steps
BEGIN
  SELECT RAISE(ABORT, 'analytics funnel steps cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_projection_binding_authority
BEFORE INSERT ON analytics_projection_attribution_bindings
WHEN NOT EXISTS (
  SELECT 1
  FROM canonical_analytics_events event
  LEFT JOIN analytics_attribution_touchpoints touch
    ON touch.touchpoint_id = NEW.touchpoint_id
  LEFT JOIN analytics_attribution_decisions decision
    ON decision.decision_id = NEW.decision_id
  LEFT JOIN ambassador_campaigns campaign
    ON campaign.campaign_id = NEW.campaign_id
  WHERE event.event_id = NEW.event_id
    AND event.correction_kind = 'none'
    AND NEW.retention_until <= event.retention_until
    AND (
      (NEW.evidence_kind = 'touchpoint'
        AND event.event_name = 'campaign_touch_recorded'
        AND touch.actor_pseudonym = event.actor_pseudonym
        AND touch.occurred_at = event.occurred_at
        AND touch.ambassador_id = NEW.ambassador_id
        AND touch.campaign_id = NEW.campaign_id
        AND campaign.ambassador_id = NEW.ambassador_id
        AND campaign.program_code = NEW.program_code
        AND campaign.catalog_offer_id IS NEW.catalog_offer_id)
      OR
      (NEW.evidence_kind = 'decision'
        AND decision.actor_pseudonym = event.actor_pseudonym
        AND decision.occurred_at = event.occurred_at
        AND decision.outcome = 'attributed'
        AND decision.ambassador_id = NEW.ambassador_id
        AND decision.campaign_id IS NEW.campaign_id
        AND (
          (event.event_name = 'registration_attributed'
            AND decision.attribution_kind IN ('relationship', 'engagement'))
          OR (event.event_name = 'lead_attributed'
            AND decision.attribution_kind = 'commercial'
            AND decision.authority_kind = 'lead_partner_attribution')
          OR (event.event_name = 'paid_access_attributed'
            AND decision.attribution_kind = 'commercial'
            AND decision.authority_kind = 'stars_access')
          OR (event.event_name = 'referral_reward_confirmed'
            AND decision.attribution_kind = 'commercial'
            AND decision.authority_kind = 'referral_reward')
        )
        AND (
          (decision.campaign_id IS NULL
            AND NEW.campaign_id IS NULL
            AND EXISTS (
              SELECT 1 FROM ambassador_profiles_v2 profile
              JOIN partner_programs program ON program.code = NEW.program_code
              WHERE profile.ambassador_id = NEW.ambassador_id
                AND program.status = 'active'
            ))
          OR (decision.campaign_id IS NOT NULL
            AND campaign.ambassador_id = NEW.ambassador_id
            AND campaign.program_code = NEW.program_code
            AND campaign.catalog_offer_id IS NEW.catalog_offer_id)
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'analytics projection attribution authority mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_projection_bindings_no_update
BEFORE UPDATE ON analytics_projection_attribution_bindings
BEGIN
  SELECT RAISE(ABORT, 'analytics projection binding is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_projection_bindings_guarded_delete
BEFORE DELETE ON analytics_projection_attribution_bindings
WHEN NOT EXISTS (
  SELECT 1
  FROM canonical_analytics_events event
  JOIN analytics_privacy_maintenance_guard guard ON guard.id = 1
  WHERE event.event_id = OLD.event_id
    AND guard.expires_at >= unixepoch()
    AND (
      (guard.reason = 'retention' AND OLD.retention_until <= unixepoch())
      OR (guard.reason = 'user_deletion'
        AND guard.subject_pseudonym = event.actor_pseudonym)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'projection binding deletion requires privacy guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_projection_snapshot_bindings_no_update
BEFORE UPDATE ON analytics_projection_snapshot_bindings
BEGIN
  SELECT RAISE(ABORT, 'analytics projection snapshot binding is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_projection_snapshot_bindings_guarded_delete
BEFORE DELETE ON analytics_projection_snapshot_bindings
WHEN NOT EXISTS (
  SELECT 1
  FROM analytics_projection_attribution_bindings binding
  JOIN canonical_analytics_events event ON event.event_id = binding.event_id
  JOIN analytics_privacy_maintenance_guard guard ON guard.id = 1
  WHERE binding.binding_id = OLD.binding_id
    AND guard.expires_at >= unixepoch()
    AND (
      (guard.reason = 'retention' AND OLD.retention_until <= unixepoch())
      OR (guard.reason = 'user_deletion'
        AND guard.subject_pseudonym = event.actor_pseudonym)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'snapshot binding deletion requires privacy guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_projection_snapshots_no_update
BEFORE UPDATE ON analytics_projection_snapshots
BEGIN
  SELECT RAISE(ABORT, 'analytics projection snapshot is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_projection_snapshots_no_delete
BEFORE DELETE ON analytics_projection_snapshots
BEGIN
  SELECT RAISE(ABORT, 'analytics projection snapshot cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_daily_actor_facts_no_update
BEFORE UPDATE ON analytics_daily_actor_facts
BEGIN
  SELECT RAISE(ABORT, 'analytics daily actor fact is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_daily_actor_facts_guarded_delete
BEFORE DELETE ON analytics_daily_actor_facts
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_privacy_maintenance_guard guard
  WHERE guard.id = 1 AND guard.expires_at >= unixepoch()
    AND (
      (guard.reason = 'retention' AND OLD.retention_until <= unixepoch())
      OR (guard.reason = 'user_deletion'
        AND guard.subject_pseudonym = OLD.actor_pseudonym)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'daily actor fact deletion requires privacy guard');
END;

CREATE TRIGGER IF NOT EXISTS trg_daily_metrics_dimension_guard
BEFORE INSERT ON analytics_daily_metrics
WHEN NEW.dimension_name != 'global'
AND NOT EXISTS (
  SELECT 1 FROM analytics_dimension_registry registry
  WHERE registry.dimension_name = NEW.dimension_name
    AND registry.dimension_value = NEW.dimension_value
    AND registry.enabled = 1
)
BEGIN
  SELECT RAISE(ABORT, 'analytics daily metric dimension is not registered');
END;

CREATE TRIGGER IF NOT EXISTS trg_daily_metrics_no_update
BEFORE UPDATE ON analytics_daily_metrics
BEGIN
  SELECT RAISE(ABORT, 'analytics daily metric is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_daily_metrics_no_delete
BEFORE DELETE ON analytics_daily_metrics
BEGIN
  SELECT RAISE(ABORT, 'analytics daily metric cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_funnel_daily_step_guard
BEFORE INSERT ON analytics_funnel_daily
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_funnel_steps step
  WHERE step.funnel_key = NEW.funnel_key
    AND step.step_key = NEW.step_key
    AND step.step_order = NEW.step_order
)
BEGIN
  SELECT RAISE(ABORT, 'analytics funnel projection step mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_funnel_daily_no_update
BEFORE UPDATE ON analytics_funnel_daily
BEGIN
  SELECT RAISE(ABORT, 'analytics funnel projection is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_funnel_daily_no_delete
BEFORE DELETE ON analytics_funnel_daily
BEGIN
  SELECT RAISE(ABORT, 'analytics funnel projection cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_cohort_daily_no_update
BEFORE UPDATE ON analytics_cohort_daily
BEGIN
  SELECT RAISE(ABORT, 'analytics cohort projection is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cohort_daily_no_delete
BEFORE DELETE ON analytics_cohort_daily
BEGIN
  SELECT RAISE(ABORT, 'analytics cohort projection cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_metrics_scope_guard
BEFORE INSERT ON ambassador_metrics_daily
WHEN NOT EXISTS (
  SELECT 1 FROM ambassador_profiles_v2 profile
  WHERE profile.ambassador_id = NEW.ambassador_id
)
OR (
  NEW.scope_kind = 'campaign' AND NOT EXISTS (
    SELECT 1 FROM ambassador_campaigns campaign
    WHERE campaign.campaign_id = NEW.campaign_id
      AND campaign.ambassador_id = NEW.ambassador_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'ambassador metric scope mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_metrics_no_update
BEFORE UPDATE ON ambassador_metrics_daily
BEGIN
  SELECT RAISE(ABORT, 'ambassador daily metric is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ambassador_metrics_no_delete
BEFORE DELETE ON ambassador_metrics_daily
BEGIN
  SELECT RAISE(ABORT, 'ambassador daily metric cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_projection_checkpoint_insert_guard
BEFORE INSERT ON analytics_projection_checkpoints
WHEN NOT EXISTS (
  SELECT 1 FROM analytics_projection_snapshots snapshot
  WHERE snapshot.snapshot_id = NEW.current_snapshot_id
    AND snapshot.input_digest = NEW.input_digest
    AND snapshot.output_digest = NEW.output_digest
)
BEGIN
  SELECT RAISE(ABORT, 'analytics projection checkpoint snapshot mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_projection_checkpoint_update_guard
BEFORE UPDATE ON analytics_projection_checkpoints
WHEN NEW.projection_kind IS NOT OLD.projection_kind
  OR NEW.metric_date IS NOT OLD.metric_date
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision != OLD.revision + 1
  OR NEW.updated_at < OLD.updated_at
  OR NOT EXISTS (
    SELECT 1 FROM analytics_projection_snapshots snapshot
    WHERE snapshot.snapshot_id = NEW.current_snapshot_id
      AND snapshot.input_digest = NEW.input_digest
      AND snapshot.output_digest = NEW.output_digest
  )
BEGIN
  SELECT RAISE(ABORT, 'analytics projection checkpoint revision mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_projection_checkpoints_no_delete
BEFORE DELETE ON analytics_projection_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'analytics projection checkpoint cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_projection_reconciliation_no_update
BEFORE UPDATE ON analytics_projection_reconciliation
BEGIN
  SELECT RAISE(ABORT, 'analytics projection reconciliation is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_projection_reconciliation_no_delete
BEFORE DELETE ON analytics_projection_reconciliation
BEGIN
  SELECT RAISE(ABORT, 'analytics projection reconciliation cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_projection_privacy_inventory_no_update
BEFORE UPDATE ON analytics_projection_privacy_inventory
BEGIN
  SELECT RAISE(ABORT, 'analytics projection privacy contract is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_projection_privacy_inventory_no_delete
BEFORE DELETE ON analytics_projection_privacy_inventory
BEGIN
  SELECT RAISE(ABORT, 'analytics projection privacy contract cannot be deleted');
END;
