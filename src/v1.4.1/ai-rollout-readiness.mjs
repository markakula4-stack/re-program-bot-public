// The same public-chat enablement condition used by the Telegram RE AI
// control: every active program has an approved snapshot for its exact URL.
// This is not a new freshness, tariff, provider-budget or Partner Beta policy.
const approvedSource = `EXISTS (
  SELECT 1 FROM ai_source_snapshots s
  WHERE s.program_code = p.code AND s.source_url = p.official_url
    AND s.status = 'approved'
)`;

export const AI_PUBLIC_SOURCE_READINESS_SQL = `SELECT COUNT(*) AS active,
  COALESCE(SUM(CASE WHEN ${approvedSource} THEN 1 ELSE 0 END), 0) AS approved
  FROM partner_programs p WHERE p.status = 'active'`;

export const AI_PUBLIC_SOURCE_READINESS_PREDICATE = `
  EXISTS (SELECT 1 FROM partner_programs p WHERE p.status = 'active')
  AND NOT EXISTS (SELECT 1 FROM partner_programs p
    WHERE p.status = 'active' AND NOT ${approvedSource})`;

export function projectPublicAiEnablement(providerConnected, row) {
  if (!row || !Number.isSafeInteger(row.active) || row.active < 0 ||
      !Number.isSafeInteger(row.approved) || row.approved < 0 || row.approved > row.active) {
    throw Object.assign(new Error('ai_rollout_readiness_unavailable'), { code: 'ai_rollout_readiness_unavailable', status: 503 });
  }
  if (typeof providerConnected !== 'boolean') throw new Error('ai_rollout_readiness_unavailable');
  const reasonCode = !providerConnected ? 'provider_unavailable' : row.active === 0 ? 'no_active_programs'
    : row.approved !== row.active ? 'sources_not_approved' : 'ready';
  return Object.freeze({ providerConnected, activePrograms: row.active, approvedPrograms: row.approved,
    ready: reasonCode === 'ready', reasonCode });
}
