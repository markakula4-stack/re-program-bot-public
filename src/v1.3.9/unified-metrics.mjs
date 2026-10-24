// P03: one bounded, read-only metric frame for trusted consumers. The existing
// 0040 projections own event counts and cohorts; payment_ledger owns Stars,
// and ai_gateway_attempts owns estimated provider cost. No second ledger.
const DAY = 86_400;
const MAX_DAYS = 31;
const REQUIRED_KEYS = ["leads", "registrations", "payments_succeeded", "refunds"];
const OPTIONAL_KEYS = ["ai_successes", "ai_failures"];
const STATUSES = new Set(["success", "failed", "timeout"]);
const PAYMENT_TYPES = new Set(["payment", "refund", "chargeback", "adjustment"]);

function safeInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function bounds(start, end, asOfAt) {
  safeInteger(start, "period start", 1);
  safeInteger(end, "period end", 1);
  safeInteger(asOfAt, "as-of time", 1);
  if (start % DAY || end % DAY || end <= start ||
      end - start > MAX_DAYS * DAY || asOfAt < end ||
      asOfAt > Math.floor(Date.now() / 1000)) {
    throw new RangeError("metrics require 1–31 closed UTC days and a current cutoff");
  }
  return (end - start) / DAY;
}

function hidden(value, actors, threshold, ready = true) {
  return Object.freeze({
    value: ready && actors >= threshold ? value : null,
    suppressed: ready && actors < threshold,
    available: ready,
  });
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Number(BigInt(numerator) * 10_000n /
    BigInt(denominator));
}

export function buildUnifiedMetrics({
  periodStart, periodEnd, asOfAt, settings, dailyRows, cohortRows,
  leadAuthority, ledgerRows, aiRows, aiActors,
} = {}) {
  const days = bounds(periodStart, periodEnd, asOfAt);
  if (settings?.rollout_mode !== "admin_shadow" ||
      settings?.master_enabled !== 1 || settings?.projections_enabled !== 1) {
    throw new Error("unified analytics is closed");
  }
  const threshold = safeInteger(settings.small_segment_threshold, "suppression", 5);
  if (threshold > 20) throw new TypeError("suppression exceeds schema limit");
  if (!Array.isArray(dailyRows) || !Array.isArray(cohortRows) ||
      !Array.isArray(ledgerRows) || !Array.isArray(aiRows) || !leadAuthority) {
    throw new TypeError("unified metric sources are incomplete");
  }
  const perDay = new Map();
  const snapshots = new Map();
  const cohortSnapshots = new Map();
  for (const row of dailyRows) {
    const date = safeInteger(row.metric_date, "metric date", 1);
    if (date < periodStart || date >= periodEnd || date % DAY) {
      throw new Error("daily metric is outside requested UTC period");
    }
    if (![...REQUIRED_KEYS, ...OPTIONAL_KEYS].includes(row.metric_key) ||
        typeof row.snapshot_id !== "string" || !/^[0-9a-f]{64}$/.test(row.snapshot_id)) {
      throw new Error("unrecognized daily metric or snapshot");
    }
    if (safeInteger(row.created_at, "snapshot time", 1) > asOfAt) {
      throw new Error("projection is newer than the as-of cutoff");
    }
    if (row.suppressed !== 0 && row.suppressed !== 1) {
      throw new Error("invalid daily suppression marker");
    }
    const day = perDay.get(date) ?? new Map();
    if (day.has(row.metric_key)) throw new Error("duplicate daily metric");
    day.set(row.metric_key, {
      count: safeInteger(row.numerator_count, "event count"),
      suppressed: row.suppressed === 1,
    });
    perDay.set(date, day);
    if (snapshots.has(date) && snapshots.get(date) !== row.snapshot_id) {
      throw new Error("daily metrics came from different snapshots");
    }
    snapshots.set(date, row.snapshot_id);
  }
  for (let date = periodStart; date < periodEnd; date += DAY) {
    const day = perDay.get(date);
    if (!day || REQUIRED_KEYS.some((key) => !day.has(key))) {
      throw new Error("daily projection period has a missing checkpoint");
    }
  }
  const projected = (key) => {
    const sum = [...perDay.values()].reduce((total, day) =>
      total + (day.get(key)?.count ?? 0), 0);
    if (!Number.isSafeInteger(sum)) throw new RangeError("projected sum exceeds safe integer");
    return sum;
  };
  const projectedSuppressed = (key) => [...perDay.values()].some((day) =>
    day.get(key)?.suppressed ?? true);
  const leadCount = safeInteger(leadAuthority.leads, "legacy leads");
  const qualified = safeInteger(leadAuthority.qualified, "qualified leads");
  const paid = safeInteger(leadAuthority.paid, "paid leads");
  const leadActors = safeInteger(leadAuthority.actors, "lead actors");
  const qualifiedActors = safeInteger(leadAuthority.qualified_actors, "qualified actors");
  const paidActors = safeInteger(leadAuthority.paid_actors, "paid actors");
  const futureStatuses = safeInteger(leadAuthority.future_statuses, "future statuses");
  if (qualified > leadCount || paid > qualified || leadActors > leadCount ||
      qualifiedActors > qualified || paidActors > paid ||
      qualifiedActors > leadActors || paidActors > qualifiedActors) {
    throw new Error("legacy lead statuses are inconsistent");
  }

  const money = { payments: 0, refunds: 0, chargebacks: 0,
    adjustments: 0, grossStars: 0, refundStars: 0, chargebackStars: 0 };
  const moneyActors = { payment: 0, refund: 0, chargeback: 0 };
  for (const row of ledgerRows) {
    if (!PAYMENT_TYPES.has(row.entry_type) ||
        !["credit", "debit"].includes(row.direction) ||
        (row.entry_type === "payment" && row.direction !== "credit") ||
        (["refund", "chargeback"].includes(row.entry_type) && row.direction !== "debit")) {
      throw new Error("payment ledger classification is invalid");
    }
    const count = safeInteger(row.entries, "ledger entries");
    const stars = safeInteger(row.stars, "Stars amount");
    const actors = safeInteger(row.actors, "ledger group actors");
    if (actors > count || (count === 0 && stars !== 0)) {
      throw new Error("payment ledger aggregation is inconsistent");
    }
    if (row.entry_type === "payment") {
      money.payments += count; money.grossStars += stars;
      moneyActors.payment += actors;
    } else if (row.entry_type === "refund") {
      money.refunds += count; money.refundStars += stars;
      moneyActors.refund += actors;
    } else if (row.entry_type === "chargeback") {
      money.chargebacks += count; money.chargebackStars += stars;
      moneyActors.chargeback += actors;
    } else money.adjustments += count;
  }
  const providerActors = safeInteger(aiActors, "provider actors");
  const ai = { attempts: 0, costMicrousd: 0 };
  for (const row of aiRows) {
    if (!STATUSES.has(row.attempt_status)) throw new Error("invalid AI attempt status");
    ai.attempts += safeInteger(row.attempts, "AI attempts");
    ai.costMicrousd += safeInteger(row.cost_microusd, "AI cost");
  }
  for (const value of Object.values({ ...money, ...moneyActors, ...ai })) {
    if (!Number.isSafeInteger(value)) throw new RangeError("metric sum exceeds safe integer");
  }
  const leadParity = projected("leads") === leadCount;
  const paymentParity = projected("payments_succeeded") === money.payments;
  const refundParity = projected("refunds") === money.refunds;
  const ready = leadParity && paymentParity && refundParity &&
    money.adjustments === 0 && futureStatuses === 0;
  const leadSafe = ready && !projectedSuppressed("leads");
  const paymentSafe = ready && !projectedSuppressed("payments_succeeded");
  const refundSafe = ready && !projectedSuppressed("refunds");
  const chargebackSafe = ready;
  const paymentVisible = moneyActors.payment >= threshold;
  const refundVisible = money.refunds === 0 || moneyActors.refund >= threshold;
  const chargebackVisible = money.chargebacks === 0 || moneyActors.chargeback >= threshold;
  const cohorts = {};
  for (const row of cohortRows) {
    const date = safeInteger(row.cohort_date, "cohort date", 1);
    if (date < periodStart || date >= periodEnd || date % DAY ||
        ![1, 7, 30].includes(row.offset_days) ||
        typeof row.snapshot_id !== "string" ||
        !/^[0-9a-f]{64}$/.test(row.snapshot_id) ||
        safeInteger(row.created_at, "cohort snapshot time", 1) > asOfAt ||
        (cohortSnapshots.has(date) &&
          cohortSnapshots.get(date) !== row.snapshot_id)) {
      throw new Error("cohort projection has invalid provenance");
    }
    cohortSnapshots.set(date, row.snapshot_id);
  }
  for (const offset of [1, 7, 30]) {
    const selected = cohortRows.filter((row) => row.offset_days === offset);
    if (selected.length !== days ||
        new Set(selected.map((row) => row.cohort_date)).size !== days ||
        selected.some((row) => row.eligible !== 1 || row.suppressed !== 0 ||
          row.cohort_date < periodStart || row.cohort_date >= periodEnd ||
          row.cohort_date % DAY)) {
      cohorts[`d${offset}`] = hidden(null, 0, threshold, false);
      continue;
    }
    const size = selected.reduce((sum, row) => sum +
      safeInteger(row.cohort_size, "cohort size"), 0);
    const retained = selected.reduce((sum, row) => sum +
      safeInteger(row.retained_actors, "retained actors"), 0);
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(retained) ||
        retained > size) throw new Error("cohort retention exceeds its size");
    cohorts[`d${offset}`] = hidden(ratio(retained, size), size, threshold, ready);
  }
  return Object.freeze({
    policyVersion: "2026-09-24.analytics-v139-p03-unified-v1",
    period: Object.freeze({ start: periodStart, endExclusive: periodEnd, asOfAt }),
    snapshotIds: Object.freeze([...snapshots.entries()].sort((a, b) => a[0] - b[0])
      .map(([, snapshot]) => snapshot)),
    cohortSnapshotIds: Object.freeze([...cohortSnapshots.entries()]
      .sort((a, b) => a[0] - b[0]).map(([, snapshot]) => snapshot)),
    parity: Object.freeze({ leads: leadParity, payments: paymentParity,
      refunds: refundParity, noAdjustments: money.adjustments === 0,
      historicalStatusesAvailable: futureStatuses === 0 }),
    ready,
    metrics: Object.freeze({
      registrations: hidden(projected("registrations"), threshold, threshold,
        ready && !projectedSuppressed("registrations")),
      leads: hidden(leadCount, leadActors, threshold, leadSafe),
      qualifiedLeads: hidden(qualified, qualifiedActors, threshold, leadSafe),
      paidLeads: hidden(paid, paidActors, threshold, leadSafe),
      leadConversionBps: hidden(ratio(qualified, leadCount), qualifiedActors,
        threshold, leadSafe),
      payments: hidden(money.payments, moneyActors.payment, threshold, paymentSafe),
      refunds: hidden(money.refunds, refundVisible ? threshold : 0,
        threshold, refundSafe && paymentVisible),
      chargebacks: hidden(money.chargebacks, chargebackVisible ? threshold : 0,
        threshold, chargebackSafe && paymentVisible),
      grossStars: hidden(money.grossStars, moneyActors.payment, threshold, paymentSafe),
      refundStars: hidden(money.refundStars, refundVisible ? threshold : 0,
        threshold, refundSafe && paymentVisible),
      chargebackStars: hidden(money.chargebackStars, chargebackVisible ? threshold : 0,
        threshold, chargebackSafe && paymentVisible),
      netStars: hidden(money.grossStars - money.refundStars - money.chargebackStars,
        paymentVisible && refundVisible && chargebackVisible ? threshold : 0,
        threshold, paymentSafe && refundSafe),
      aiAttempts: hidden(ai.attempts, providerActors, threshold, ready),
      estimatedAiCostMicrousd: hidden(ai.costMicrousd, providerActors, threshold, ready),
    }),
    cohorts: Object.freeze(cohorts),
  });
}

// Audience is authorized by the Worker, not by a request query parameter.
// P04 adds a DB-verified partner owner scope; until then no partner can read
// global metrics. The admin UI and admin-scoped RE AI consume the same frame.
export function createD1UnifiedMetricsReader(db, authorize) {
  if (!db?.prepare || !db?.batch || typeof authorize !== "function") {
    throw new TypeError("D1 and server authorizer are required");
  }
  return Object.freeze({
    async read({ audience, periodStart, periodEnd, asOfAt }) {
      if (!["admin", "admin_ai"].includes(audience)) {
        throw new Error("verified owner scope is required");
      }
      bounds(periodStart, periodEnd, asOfAt);
      const authorized = await authorize(audience);
      if (authorized?.scope !== "admin_global" || authorized?.verified !== true) {
        throw new Error("unified analytics authorization failed");
      }
      const gate = `EXISTS (SELECT 1 FROM analytics_v139_active_shadow_authority)
        AND NOT EXISTS (SELECT 1 FROM analytics_privacy_projection_fence)`;
      const statements = [
        db.prepare(`SELECT rollout_mode, master_enabled, projections_enabled,
            small_segment_threshold FROM analytics_v2_settings
          WHERE id = 1 AND ${gate}`),
        db.prepare(`SELECT c.metric_date, c.current_snapshot_id AS snapshot_id,
            s.created_at, m.metric_key, m.numerator_count, m.suppressed
          FROM analytics_projection_checkpoints c
          JOIN analytics_projection_snapshots s
            ON s.snapshot_id = c.current_snapshot_id
          JOIN analytics_daily_metrics m ON m.snapshot_id = s.snapshot_id
            AND m.metric_date = c.metric_date
          WHERE c.projection_kind = 'daily' AND c.metric_date >= ?
            AND c.metric_date < ? AND s.created_at <= ?
            AND m.dimension_name = 'global' AND m.dimension_value = 'all'
            AND m.metric_key IN ('leads','registrations','payments_succeeded',
              'refunds','ai_successes','ai_failures') AND ${gate}
          ORDER BY c.metric_date, m.metric_key`)
          .bind(periodStart, periodEnd, asOfAt),
        db.prepare(`SELECT h.cohort_date, h.offset_days, h.cohort_size,
            h.retained_actors, h.eligible, h.suppressed,
            h.snapshot_id, s.created_at
          FROM analytics_projection_checkpoints c
          JOIN analytics_cohort_daily h
            ON h.snapshot_id = c.current_snapshot_id
            AND h.cohort_date = c.metric_date
          JOIN analytics_projection_snapshots s
            ON s.snapshot_id = c.current_snapshot_id AND s.created_at <= ?
          WHERE c.projection_kind = 'cohort' AND c.metric_date >= ?
            AND c.metric_date < ? AND ${gate}
          ORDER BY h.cohort_date, h.offset_days`)
          .bind(asOfAt, periodStart, periodEnd),
        db.prepare(`WITH unified AS (
            SELECT l.telegram_id, l.status,
              CASE WHEN c.updated_at IS NOT NULL AND
                unixepoch(c.updated_at) > unixepoch(l.updated_at)
                THEN c.updated_at ELSE l.updated_at END AS updated_at,
              CASE WHEN c.created_at IS NOT NULL AND
                unixepoch(c.created_at) < unixepoch(l.created_at)
                THEN c.created_at ELSE l.created_at END AS submitted_at
            FROM lead_requests l LEFT JOIN conversions c
              ON c.telegram_id = l.telegram_id AND c.offer_code = l.offer_code
            UNION ALL
            SELECT c.telegram_id, c.status, c.updated_at, c.created_at
            FROM conversions c WHERE NOT EXISTS (
              SELECT 1 FROM lead_requests l WHERE l.telegram_id = c.telegram_id
                AND l.offer_code = c.offer_code)
          ) SELECT COUNT(*) AS leads,
            COALESCE(SUM(CASE WHEN status IN ('confirmed','paid') THEN 1 ELSE 0 END),0) AS qualified,
            COALESCE(SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END),0) AS paid,
            COUNT(DISTINCT u.telegram_id) AS actors,
            COUNT(DISTINCT CASE WHEN status IN ('confirmed','paid')
              THEN u.telegram_id END) AS qualified_actors,
            COUNT(DISTINCT CASE WHEN status = 'paid'
              THEN u.telegram_id END) AS paid_actors,
            COALESCE(SUM(CASE WHEN unixepoch(updated_at) > ?
              OR unixepoch(updated_at) IS NULL THEN 1 ELSE 0 END),0) AS future_statuses
          FROM unified u JOIN users actor ON actor.telegram_id = u.telegram_id
          WHERE unixepoch(submitted_at) >= ? AND unixepoch(submitted_at) < ?
            AND ${gate}`).bind(asOfAt, periodStart, periodEnd),
        db.prepare(`SELECT entry_type, direction, COUNT(*) AS entries,
            COALESCE(SUM(amount_stars),0) AS stars,
            COUNT(DISTINCT telegram_id) AS actors
          FROM payment_ledger WHERE occurred_at >= ? AND occurred_at < ?
            AND recorded_at <= ? AND ${gate}
          GROUP BY entry_type, direction ORDER BY entry_type, direction`)
          .bind(periodStart, periodEnd, asOfAt),
        db.prepare(`SELECT a.attempt_status, COUNT(*) AS attempts,
            COALESCE(SUM(a.cost_microusd),0) AS cost_microusd
          FROM ai_gateway_attempts a WHERE a.created_at >= ?
            AND a.created_at < ? AND a.created_at <= ? AND ${gate}
          GROUP BY a.attempt_status ORDER BY a.attempt_status`)
          .bind(periodStart, periodEnd, asOfAt),
        db.prepare(`SELECT COUNT(DISTINCT b.owner_telegram_id) AS actors
          FROM ai_gateway_attempts a JOIN ai_gateway_budget_reservations b
            ON b.request_id = a.request_id
          WHERE a.created_at >= ? AND a.created_at < ? AND
            a.created_at <= ? AND ${gate}`).bind(periodStart, periodEnd, asOfAt),
      ];
      const results = await db.batch(statements);
      const rows = (index) => results?.[index]?.results ?? [];
      if (rows(0).length !== 1 || rows(3).length !== 1 ||
          rows(6).length !== 1) {
        throw new Error("unified metric authority is unavailable");
      }
      // A closed lease after the batch must not leave a readable cached frame.
      const stillOpen = await db.prepare(`SELECT 1 FROM analytics_v139_active_shadow_authority
        WHERE NOT EXISTS (SELECT 1 FROM analytics_privacy_projection_fence)`)
        .first();
      if (!stillOpen) throw new Error("unified analytics lease closed");
      return buildUnifiedMetrics({ periodStart, periodEnd, asOfAt,
        settings: rows(0)[0], dailyRows: rows(1), cohortRows: rows(2),
        leadAuthority: rows(3)[0], ledgerRows: rows(4),
        aiRows: rows(5), aiActors: rows(6)[0].actors });
    },
  });
}
