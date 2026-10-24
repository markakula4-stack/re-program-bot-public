// P04: owner-only view of existing 0039 decisions and 0040 projections.
// Authentication comes from the server session; no owner identifier is read
// from a client request. The source families are never summed together.
const DAY = 86_400;
const KEYS = Object.freeze([
  "tracking_opens", "attributed_registrations", "attributed_leads",
  "applied_paid_access", "confirmed_referral_rewards",
]);
const FAMILIES = Object.freeze({
  relationship: "first_inviter",
  engagement: "verified_touchpoint",
  commercial_lead: "lead_partner_attribution",
  commercial_access: "stars_access",
  commercial_reward: "referral_reward",
});
const HEX = /^[0-9a-f]{64}$/;

function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`${name} must be a safe integer >= ${min}`);
  }
  return value;
}

function period(start, end, asOfAt) {
  integer(start, "start", 1);
  integer(end, "end", 1);
  integer(asOfAt, "cutoff", 1);
  if (start % DAY || end % DAY || end <= start || end - start > 31 * DAY ||
      asOfAt < end || asOfAt > Math.floor(Date.now() / 1000) ||
      start < asOfAt - 180 * DAY) {
    throw new RangeError("owner metrics require 1–31 closed UTC days in retention");
  }
  return (end - start) / DAY;
}

function cell(value, safe, available = true) {
  return Object.freeze({ value: safe && available ? value : null,
    suppressed: available && !safe, available });
}

export function buildOwnerAnalyticsFrame({ start, end, asOfAt, settings,
  owner, checkpoints, projectionRows, decisionRows } = {}) {
  const days = period(start, end, asOfAt);
  if (settings?.rollout_mode !== "admin_shadow" ||
      settings?.master_enabled !== 1 || settings?.ambassador_enabled !== 1 ||
      settings?.projections_enabled !== 1 ||
      owner?.partner_profile_status !== "active" ||
      owner?.ambassador_status !== "active" ||
      owner?.activation_actor_kind !== "admin") {
    throw new Error("owner analytics is closed");
  }
  const threshold = integer(settings.small_segment_threshold, "threshold", 5);
  if (threshold > 20 || !Array.isArray(checkpoints) ||
      !Array.isArray(projectionRows) || !Array.isArray(decisionRows)) {
    throw new TypeError("owner metric authority is incomplete");
  }
  const snapshotByDate = new Map();
  for (const row of checkpoints) {
    const date = integer(row.metric_date, "checkpoint date", 1);
    if (date < start || date >= end || date % DAY || snapshotByDate.has(date) ||
        !HEX.test(row.snapshot_id) ||
        integer(row.created_at, "snapshot time", 1) > asOfAt ||
        ["source_delta", "canonical_delta", "projection_delta"].some((key) =>
          row[key] !== 0)) {
      throw new Error("owner projection checkpoint is inconsistent");
    }
    snapshotByDate.set(date, row.snapshot_id);
  }
  if (snapshotByDate.size !== days) {
    throw new Error("owner projection period is incomplete");
  }
  const buckets = new Map(KEYS.map((key) => [key, { count: 0,
    safe: true, seen: new Set() }]));
  for (const row of projectionRows) {
    const bucket = buckets.get(row.metric_key);
    if (!bucket || !snapshotByDate.has(row.metric_date) ||
        snapshotByDate.get(row.metric_date) !== row.snapshot_id ||
        row.ambassador_id !== owner.ambassador_id ||
        row.scope_kind !== "ambassador" ||
        integer(row.small_cell_threshold, "cell threshold", 5) !== threshold ||
        ![0, 1].includes(row.suppressed) || bucket.seen.has(row.metric_date)) {
      throw new Error("ambassador projection is outside verified owner scope");
    }
    const count = integer(row.metric_count, "event count");
    const actors = integer(row.unique_actors, "event actors");
    if (actors > count || (row.suppressed === 1) !== (actors < threshold)) {
      throw new Error("ambassador suppression authority is inconsistent");
    }
    bucket.count += count;
    bucket.safe &&= row.suppressed === 0;
    bucket.seen.add(row.metric_date);
  }
  const decisions = new Map(Object.keys(FAMILIES).map((key) => [key,
    { count: 0, safe: true, seen: new Set() }]));
  for (const row of decisionRows) {
    const name = row.attribution_kind === "commercial"
      ? `commercial_${row.authority_kind === "lead_partner_attribution"
        ? "lead" : row.authority_kind === "stars_access" ? "access" : "reward"}`
      : row.attribution_kind;
    const bucket = decisions.get(name);
    if (!bucket || row.authority_kind !== FAMILIES[name] ||
        row.ambassador_id !== owner.ambassador_id ||
        !Number.isSafeInteger(row.metric_date) || row.metric_date % DAY ||
        row.metric_date < start || row.metric_date >= end ||
        bucket.seen.has(row.metric_date)) {
      throw new Error("attribution family or owner is inconsistent");
    }
    const count = integer(row.decisions, "decisions");
    const actors = integer(row.actors, "attribution actors");
    if (count < 1 || actors < 1 || actors > count) {
      throw new Error("attribution evidence count is inconsistent");
    }
    bucket.count += count;
    bucket.safe &&= actors >= threshold;
    bucket.seen.add(row.metric_date);
  }
  if ([...buckets.values(), ...decisions.values()].some((b) =>
    !Number.isSafeInteger(b.count))) {
    throw new RangeError("owner metric count exceeds safe integer");
  }
  // Both exact families can contribute to the one old registration event key.
  // Revealing that combined number next to one visible family would allow
  // subtraction of a suppressed family, so suppress the combined cell too.
  buckets.get("attributed_registrations").safe &&=
    decisions.get("relationship").safe && decisions.get("engagement").safe;
  return Object.freeze({
    policyVersion: "2026-09-24.analytics-v139-p04-v1",
    period: Object.freeze({ start, endExclusive: end, asOfAt }),
    scope: Object.freeze({ kind: "ambassador", ambassadorId: owner.ambassador_id }),
    snapshotIds: Object.freeze([...snapshotByDate.entries()]
      .sort((a, b) => a[0] - b[0]).map(([, snapshot]) => snapshot)),
    metrics: Object.freeze(Object.fromEntries([...buckets].map(([key, b]) =>
      [key, cell(b.count, b.safe)]))),
    attribution: Object.freeze(Object.fromEntries([...decisions].map(([key, b]) =>
      [key, cell(b.count, b.safe)]))),
  });
}

export function createD1OwnerAnalyticsReader(db, authenticate) {
  if (!db?.prepare || !db?.batch || typeof authenticate !== "function") {
    throw new TypeError("D1 and server authentication are required");
  }
  const gate = `EXISTS (SELECT 1 FROM analytics_v139_active_shadow_authority)
    AND NOT EXISTS (SELECT 1 FROM analytics_privacy_projection_fence)`;
  const ownerSql = `SELECT a.ambassador_id,
      p.status AS partner_profile_status, a.status AS ambassador_status,
      transition.actor_kind AS activation_actor_kind
    FROM partner_profiles p
    JOIN user_roles r ON r.telegram_id = p.telegram_id
      AND r.role = 'partner' AND r.status = 'active'
    JOIN users u ON u.telegram_id = p.telegram_id AND u.is_blocked = 0
    JOIN ambassador_profiles_v2 a ON a.partner_profile_id = p.id
    JOIN ambassador_profile_transitions transition
      ON transition.ambassador_id = a.ambassador_id
      AND transition.from_status = 'draft' AND transition.to_status = 'active'
      AND transition.actor_kind = 'admin'
    WHERE p.telegram_id = ? AND p.status = 'active'
      AND a.status = 'active' AND ${gate}`;
  return Object.freeze({
    async read({ periodStart, periodEnd, asOfAt } = {}) {
      period(periodStart, periodEnd, asOfAt);
      const principal = await authenticate();
      if (principal?.verified !== true) throw new Error("owner session is unverified");
      const actorId = integer(principal.telegramId, "authenticated actor", 1);
      const queries = [
        db.prepare(`SELECT rollout_mode, master_enabled, ambassador_enabled,
            projections_enabled, small_segment_threshold
          FROM analytics_v2_settings WHERE id = 1 AND ${gate}`),
        db.prepare(ownerSql).bind(actorId),
        db.prepare(`SELECT c.metric_date, c.current_snapshot_id AS snapshot_id,
            s.created_at, r.source_delta, r.canonical_delta, r.projection_delta
          FROM analytics_projection_checkpoints c
          JOIN analytics_projection_snapshots s
            ON s.snapshot_id = c.current_snapshot_id
          JOIN analytics_projection_reconciliation r
            ON r.snapshot_id = s.snapshot_id
          WHERE c.projection_kind = 'ambassador' AND c.metric_date >= ?
            AND c.metric_date < ? AND s.created_at <= ? AND ${gate}
          ORDER BY c.metric_date`).bind(periodStart, periodEnd, asOfAt),
        db.prepare(`SELECT m.snapshot_id, m.metric_date, m.ambassador_id,
            m.scope_kind, m.metric_key, m.metric_count, m.unique_actors,
            m.small_cell_threshold, m.suppressed
          FROM analytics_projection_checkpoints c
          JOIN ambassador_metrics_daily m ON m.snapshot_id = c.current_snapshot_id
            AND m.metric_date = c.metric_date AND m.scope_kind = 'ambassador'
          JOIN ambassador_profiles_v2 a ON a.ambassador_id = m.ambassador_id
          JOIN partner_profiles p ON p.id = a.partner_profile_id
          JOIN user_roles role ON role.telegram_id = p.telegram_id
            AND role.role = 'partner' AND role.status = 'active'
          JOIN users account ON account.telegram_id = p.telegram_id
            AND account.is_blocked = 0
          JOIN analytics_projection_snapshots s ON s.snapshot_id = c.current_snapshot_id
          WHERE p.telegram_id = ? AND p.status = 'active' AND a.status = 'active'
            AND c.projection_kind = 'ambassador' AND c.metric_date >= ?
            AND c.metric_date < ? AND s.created_at <= ? AND ${gate}
          ORDER BY m.metric_date, m.metric_key`)
          .bind(actorId, periodStart, periodEnd, asOfAt),
        db.prepare(`SELECT d.ambassador_id,
            CAST(d.decided_at / 86400 AS INTEGER) * 86400 AS metric_date,
            d.attribution_kind, d.authority_kind,
            COUNT(*) AS decisions, COUNT(DISTINCT d.actor_pseudonym) AS actors
          FROM analytics_attribution_decisions d
          JOIN ambassador_profiles_v2 a ON a.ambassador_id = d.ambassador_id
          JOIN partner_profiles p ON p.id = a.partner_profile_id
          JOIN user_roles role ON role.telegram_id = p.telegram_id
            AND role.role = 'partner' AND role.status = 'active'
          JOIN users account ON account.telegram_id = p.telegram_id
            AND account.is_blocked = 0
          WHERE p.telegram_id = ? AND p.status = 'active' AND a.status = 'active'
            AND d.outcome = 'attributed' AND d.decided_at >= ?
            AND d.decided_at < ? AND d.decided_at <= ?
            AND d.retention_until > unixepoch() AND ${gate}
          GROUP BY d.ambassador_id, metric_date,
            d.attribution_kind, d.authority_kind
          ORDER BY metric_date, d.attribution_kind, d.authority_kind`)
          .bind(actorId, periodStart, periodEnd, asOfAt),
      ];
      const result = await db.batch(queries);
      const rows = (i) => result?.[i]?.results ?? [];
      if (rows(0).length !== 1 || rows(1).length !== 1) {
        throw new Error("verified owner analytics scope is unavailable");
      }
      const stillOwner = await db.prepare(ownerSql).bind(actorId).first();
      if (!stillOwner || stillOwner.ambassador_id !== rows(1)[0].ambassador_id) {
        throw new Error("owner analytics scope changed during read");
      }
      return buildOwnerAnalyticsFrame({ start: periodStart, end: periodEnd,
        asOfAt, settings: rows(0)[0], owner: rows(1)[0],
        checkpoints: rows(2), projectionRows: rows(3), decisionRows: rows(4) });
    },
  });
}
