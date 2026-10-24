import { readTrustedContext, compileContextAssertions } from '../v1.4.1/trusted-context.mjs';
import { readVerifiedLifecycleFacts, compileVerifiedLifecycleAssertions } from './lifecycle-authority.mjs';
import { projectVerifiedSubscriptionLifecycle } from './lifecycle-engine.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha256 = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const ordered = (rows, identity) => [...rows].sort((a, b) => String(a[identity]).localeCompare(String(b[identity])));

// This store records a verified server projection, never a provider candidate.
// Raw subscription updates are admitted by the authenticated provider adapter
// in Part 3; neither this function nor a control event creates ledger money.
export async function appendLifecycleProjectionFact({ context, verifiedFacts, nowSec } = {}) {
  const trusted = readTrustedContext(context);
  if (trusted.actorKind !== 'service' || trusted.executorPurpose !== 'stars_process_event' ||
      trusted.operation !== 'service.stars.process_event') fail('lifecycle_event_service_required');
  if (nowSec !== undefined && nowSec !== trusted.nowSeconds) fail('lifecycle_event_clock_mismatch');
  const facts = readVerifiedLifecycleFacts(verifiedFacts);
  const projection = projectVerifiedSubscriptionLifecycle({ verifiedFacts, nowSec: trusted.nowSeconds });
  if (projection.state === null || !projection.subscriptionId) fail('lifecycle_projection_not_recordable');
  const sourceGuard = compileVerifiedLifecycleAssertions(verifiedFacts);
  const contextGuard = compileContextAssertions(context);
  const evidenceCore = {
    domain: 'v1.4.3.verified-lifecycle-projection.v1', telegramId: facts.telegramId,
    projection,
    periods: ordered(facts.periods, 'ledgerEntryId'),
    subscriptions: ordered(facts.subscriptions.map(row => ({ subscription_id: row.subscription_id, revision: row.revision })), 'subscription_id'),
    contracts: ordered(facts.contracts.map(row => ({ contract_id: row.contract_id, revision: row.revision })), 'contract_id'),
    observations: ordered(facts.providerEvents.filter(row => row.event_type !== 'lifecycle_transition')
      .map(row => ({ event_id: row.event_id, event_type: row.event_type, provider_state: row.provider_state })), 'event_id'),
    commands: ordered(facts.commands.map(row => ({ command_id: row.command_id, revision: row.revision, state: row.state })), 'command_id'),
  };
  const evidenceHash = await sha256(JSON.stringify(evidenceCore));
  const eventKey = `lifecycle:projection:${evidenceHash}`;
  const db = trusted.db;
  const prior = await db.prepare(`SELECT event_id, telegram_id, contract_id, to_state, evidence_sha256
    FROM subscription_provider_events WHERE event_key=? LIMIT 2`).bind(eventKey).all();
  if (prior?.success !== true || !Array.isArray(prior.results) || prior.results.length > 1) fail('lifecycle_event_read_failed');
  if (prior.results.length === 1) {
    const row = prior.results[0];
    if (row.telegram_id !== facts.telegramId || row.contract_id !== projection.contractId ||
        row.to_state !== projection.state || row.evidence_sha256 !== evidenceHash) fail('lifecycle_event_identity_conflict');
  }
  const eventId = crypto.randomUUID();
  const assertions = [contextGuard, ...(sourceGuard.assertions ?? [sourceGuard])];
  if (assertions.length > 128 || assertions.some(piece => typeof piece.sql !== 'string' ||
      !Array.isArray(piece.params) || piece.params.length > 99)) fail('lifecycle_event_guard_budget_exhausted');
  const guardKeys = assertions.map((_, index) => `v143_lifecycle_${eventId}_${index}`);
  const statements = assertions.map((piece, index) => db.prepare(`INSERT INTO mini_app_atomic_guards
    (guard_key,precondition_ok) VALUES(?,CASE WHEN (${piece.sql}) THEN 1 ELSE 0 END)`)
    .bind(guardKeys[index], ...piece.params));
  const mutationIndex = statements.length;
  statements.push(db.prepare(`INSERT INTO subscription_provider_events
    (event_id,event_key,contract_id,telegram_id,event_type,source,to_state,
     actor_type,reason_code,evidence_sha256,received_at)
    SELECT ?,?,?,?,'lifecycle_transition','system',?,'system',?,?,?
    ON CONFLICT(event_key) DO NOTHING`).bind(eventId, eventKey, projection.contractId,
    facts.telegramId, projection.state, projection.reasonCode, evidenceHash,
    trusted.nowSeconds));
  statements.push(...guardKeys.map(key => db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key=?').bind(key)));
  let result;
  try { result = await db.batch(statements); } catch (error) {
    fail(/precondition_ok|mini_app_atomic_guards/u.test(String(error?.message))
      ? 'lifecycle_event_source_stale' : 'lifecycle_event_persistence_failed');
  }
  if (!Array.isArray(result) || result.length !== statements.length || result.some(row => row?.success !== true)) fail('lifecycle_event_persistence_failed');
  const changes = result[mutationIndex]?.meta?.changes ?? result[mutationIndex]?.changes ?? 0;
  if (changes === 1) return Object.freeze({ status: 'appended', eventId, projection });
  // A concurrent writer can win the unique event key. Verify the same durable
  // receipt before accepting that result; stale proofs never report success.
  const durable = await db.prepare(`SELECT event_id, telegram_id, contract_id, to_state, evidence_sha256
    FROM subscription_provider_events WHERE event_key=? LIMIT 2`).bind(eventKey).all();
  const row = durable?.success === true && durable.results?.length === 1 ? durable.results[0] : null;
  if (!row || row.telegram_id !== facts.telegramId || row.contract_id !== projection.contractId ||
      row.to_state !== projection.state || row.evidence_sha256 !== evidenceHash) fail('lifecycle_event_source_stale');
  return Object.freeze({ status: 'duplicate', eventId: row.event_id, projection });
}
