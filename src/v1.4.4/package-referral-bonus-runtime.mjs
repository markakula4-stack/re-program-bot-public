import { REFERRAL_REWARD_PROGRAM_CODE as PROGRAM, REFERRAL_REWARD_SECONDS as SECONDS,
  readReferralRewardConfig, requireUnixSeconds } from '../v1.3.7/referral-reward-foundation.mjs';
import { inspectPackageReferralSchema, packageReferralSchemaAssertion } from './package-referral-contract.mjs';
import { readPackageReferralRewardForBonus,applyPackageReferralRewardCompensation } from './package-referral-runtime.mjs';
import { createServiceExecutor } from '../v1.4.1/trusted-context.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const positive = x => Number.isSafeInteger(x) && x > 0;
const uuid = x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(x);
const freeze = x => { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const now = () => Math.floor(Date.now() / 1000);
const clock = x => { try { return requireUnixSeconds(x); } catch { fail('package_bonus_clock_invalid'); } };
const hash = async x => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x)))].map(v => v.toString(16).padStart(2, '0')).join('');
const dbFor = env => { if (!env?.DB?.prepare || !env?.DB?.batch) fail('package_bonus_database_required'); return env.DB; };
const GRANTS = 'bonus_grant_id grant_key program_code reward_kind reward_id legacy_reward_id package_reward_id beneficiary_telegram_id delivery_mode plan_code bonus_seconds grant_status available_at claim_expires_at claimed_at applied_at starts_at ends_at allocation_anchor_at allocation_fingerprint target_source_kind target_subscription_id target_package_period_id target_payment_ledger_entry_id target_legacy_bonus_grant_id target_package_bonus_grant_id source_payment_ledger_entry_id compensation_ledger_entry_id compensated_seconds compensated_at last_transition_id revision created_at updated_at';
const EFFECTS = 'effect_id effect_key bonus_grant_id reward_kind reward_id beneficiary_telegram_id effect_kind plan_code source_payment_ledger_entry_id target_source_kind target_subscription_id target_package_period_id target_payment_ledger_entry_id target_legacy_bonus_grant_id target_package_bonus_grant_id allocation_anchor_at allocation_fingerprint allocation_json applied_transition_id recorded_at';
const SEGMENTS = 'segment_id bonus_grant_id segment_index plan_code starts_at ends_at seconds recorded_at';
const TRANSITIONS = 'transition_id transition_key bonus_grant_id from_status to_status from_revision to_revision reason_code actor_type actor_id related_payment_ledger_entry_id compensated_seconds occurred_at recorded_at';
const REVERSED = 'reversal_id reversal_key bonus_grant_id effect_id compensation_ledger_entry_id reversal_transition_id compensated_seconds occurred_at recorded_at';
const TABLES = { grants: ['package_referral_bonus_grants', GRANTS], effects: ['package_referral_bonus_effects', EFFECTS],
  segments: ['package_referral_bonus_segments', SEGMENTS], transitions: ['package_referral_bonus_transitions', TRANSITIONS], reversals: ['package_referral_bonus_reversals', REVERSED] };
function jsonRow(columns) {
  const names = columns.split(' '); let value = "json('{}')";
  for (let i = 0; i < names.length; i += 15) value = `json_set(${value},${names.slice(i, i + 15).flatMap(name => [`'$.${name}'`, name]).join(',')})`;
  return value;
}
async function rows(db, captures, table, columns, where, params, order) {
  const sql = `SELECT COALESCE(json_group_array(json(snapshot)),'[]') FROM (SELECT ${jsonRow(columns)} AS snapshot FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT 129)`;
  const response = await db.prepare(sql).bind(...params).first(), snapshot = Object.values(response ?? {})[0];
  if (typeof snapshot !== 'string' || new TextEncoder().encode(snapshot).length > 2_000_000) fail('package_bonus_source_unavailable');
  let result; try { result = JSON.parse(snapshot); } catch { fail('package_bonus_source_unavailable'); }
  if (!Array.isArray(result) || result.length > 128) fail('package_bonus_source_overflow');
  captures.push({ sql, params: [...params], snapshot }); return result;
}
const predicates = captures => captures.map(c => ({ sql: `(${c.sql}) IS ?`, params: [...c.params, c.snapshot] }));
const capturePredicates = assertions => assertions.map(a => ({ sql: `SELECT (${a.sql})`, params: [...a.params], snapshot: 1 }));
async function schemaCaptures(db,schema) {
  return capturePredicates([packageReferralSchemaAssertion(schema)]);
}
async function guarded(db, assertions, writes) {
  const key = 'v144b_' + crypto.randomUUID().replaceAll('-', '');
  const guards = assertions.map((a, i) => db.prepare('INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN (' + a.sql + ') THEN 1 ELSE 0 END)').bind(key + ':' + i, ...a.params));
  const result = await db.batch([...guards, ...writes, db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key LIKE ?').bind(key + ':%')]);
  if (!Array.isArray(result) || result.length !== guards.length + writes.length + 1 || result.some(r => r?.success !== true)) fail('package_bonus_persistence_unconfirmed');
}
const RAW_PAID='grant_id subscription_id order_id payment_ledger_entry_id plan_code access_seconds starts_at ends_at created_at';
async function paymentProvenance(db,periods,at) {
  const captures=[],proofs=[];
  for(const id of [...new Set(periods.filter(p=>p.sourceKind==='payment').map(p=>p.subscriptionId))]) {
    const subscription=(await rows(db,captures,'subscriptions','subscription_id telegram_id billing_mode current_period_start','subscription_id=?',[id],'subscription_id'))[0];
    if(!subscription) fail('package_bonus_allocation_source_invalid');
    const raw=await rows(db,captures,'subscription_access_grants',RAW_PAID,'subscription_id=?',[id],'starts_at,grant_id');
    const compensated=await rows(db,captures,'payment_ledger','ledger_entry_id related_ledger_entry_id entry_type direction recorded_at',
      "related_ledger_entry_id IN (SELECT payment_ledger_entry_id FROM subscription_access_grants WHERE subscription_id=?) AND entry_type IN ('refund','chargeback') AND recorded_at<=?",[id,at],'ledger_entry_id');
    proofs.push({subscriptionId:id,billingMode:subscription.billing_mode,raw:raw.map(r=>({...r,compensationLedgerEntryId:compensated.find(x=>x.related_ledger_entry_id===r.payment_ledger_entry_id)?.ledger_entry_id??null}))});
  }
  return {proofs,captures};
}
async function verifiedPaymentWindow(db,captures,allocation,window,owner,at) {
  const group=allocation.paymentProofs?.find(p=>p.raw?.some(r=>r.payment_ledger_entry_id===window.sourceRef));
  if(!group||!['prepaid','recurring'].includes(group.billingMode)||!Array.isArray(group.raw)||!group.raw.length||group.raw.length>128) fail('package_bonus_allocation_source_invalid');
  const sorted=[...group.raw].sort((a,b)=>a.starts_at-b.starts_at||a.grant_id.localeCompare(b.grant_id));
  if(new Set(sorted.map(r=>r.grant_id)).size!==sorted.length||new Set(sorted.map(r=>r.payment_ledger_entry_id)).size!==sorted.length) fail('package_bonus_allocation_source_invalid');
  let compact=sorted[0].starts_at,selected=null;
  for(const pinned of sorted) {
    const raw=(await rows(db,captures,'subscription_access_grants',RAW_PAID,'grant_id=? AND telegram_id=?',[pinned.grant_id,owner],'grant_id'))[0];
    if(!raw||RAW_PAID.split(' ').some(k=>raw[k]!==pinned[k])||raw.subscription_id!==group.subscriptionId||raw.created_at>at) fail('package_bonus_allocation_source_invalid');
    const order=(await rows(db,captures,'subscription_orders','order_id billing_mode telegram_id','order_id=?',[raw.order_id],'order_id'))[0];
    if(!order||order.telegram_id!==owner||order.billing_mode!==group.billingMode) fail('package_bonus_allocation_source_invalid');
    if(pinned.compensationLedgerEntryId) {
      const compensation=(await rows(db,captures,'payment_ledger','ledger_entry_id related_ledger_entry_id entry_type direction recorded_at','ledger_entry_id=?',[pinned.compensationLedgerEntryId],'ledger_entry_id'))[0];
      if(!compensation||compensation.related_ledger_entry_id!==raw.payment_ledger_entry_id||!['refund','chargeback'].includes(compensation.entry_type)||compensation.direction!=='debit'||compensation.recorded_at>at) fail('package_bonus_allocation_source_invalid');
      continue;
    }
    const startsAt=group.billingMode==='prepaid'?compact:raw.starts_at,endsAt=group.billingMode==='prepaid'?compact+raw.access_seconds:raw.ends_at;
    if(group.billingMode==='prepaid') compact=endsAt;
    if(raw.payment_ledger_entry_id===window.sourceRef) selected={raw,startsAt,endsAt};
  }
  if(!selected||selected.raw.plan_code!==window.planCode||selected.endsAt!==window.endsAt) fail('package_bonus_allocation_source_invalid');
  if(selected.startsAt!==window.startsAt) {
    if(group.billingMode!=='recurring') fail('package_bonus_allocation_source_invalid');
    const sql=`SELECT EXISTS(SELECT 1 FROM subscription_payment_links l JOIN subscription_first_recurring_receipts f ON f.operation_id=l.operation_id
      JOIN subscription_billing_contracts c ON c.contract_id=l.contract_id JOIN payment_ledger p ON p.ledger_entry_id=l.ledger_entry_id
      WHERE l.ledger_entry_id=? AND f.contract_id=c.contract_id AND c.first_payment_ledger_entry_id=p.ledger_entry_id
      AND f.evidence_sha256=l.evidence_sha256 AND p.telegram_id=? AND p.occurred_at=? AND l.occurred_at=p.occurred_at
      AND p.occurred_at>=c.created_at AND p.occurred_at<=p.recorded_at AND p.recorded_at<=? AND p.occurred_at<=l.recorded_at
      AND l.recorded_at<=f.verified_at AND f.verified_at<=?)`;
    const params=[window.sourceRef,owner,window.startsAt,at,at],snapshot=Object.values(await db.prepare(sql).bind(...params).first())[0];
    if(snapshot!==1||selected.startsAt<window.startsAt||selected.startsAt-window.startsAt>86400) fail('package_bonus_allocation_source_invalid');
    captures.push({sql,params,snapshot});
  }
  return selected.raw;
}

// Pure scheduling only; callers still need genuine recorded source assertions.
// Allocation is persisted once. Refunding a later occupied paid window does
// not retrofill already elapsed time or grant those earned seconds twice.
export function allocatePackageReferralBonusSegments({ planCode, anchorAt, occupied = [] } = {}) {
  if (!['professional', 'dragon'].includes(planCode) || !positive(anchorAt) || !Array.isArray(occupied) || occupied.length > 128 ||
      occupied.some(p => !positive(p.startsAt) || !positive(p.endsAt) || p.endsAt <= p.startsAt)) fail('package_bonus_allocation_invalid');
  const windows = occupied.filter(p => p.endsAt > anchorAt).map(p => ({ startsAt: p.startsAt, endsAt: p.endsAt }))
    .sort((a, b) => a.startsAt - b.startsAt || a.endsAt - b.endsAt);
  let cursor = anchorAt, remaining = SECONDS.bonusAccess; const segments = [];
  const append = count => { if (count > 0) { segments.push({ planCode, startsAt: cursor, endsAt: cursor + count, seconds: count }); cursor += count; remaining -= count; } };
  for (const window of windows) {
    if (!remaining) break;
    if (window.startsAt > cursor) append(Math.min(remaining, window.startsAt - cursor));
    if (remaining && window.endsAt > cursor) cursor = window.endsAt;
  }
  append(remaining);
  if (segments.length > 64 || segments.reduce((n, s) => n + s.seconds, 0) !== SECONDS.bonusAccess ||
      segments.some(s => !Number.isSafeInteger(s.endsAt) || s.endsAt > 4_102_444_800)) fail('package_bonus_allocation_invalid');
  return freeze(segments);
}

async function rewardProof(env, rewardKind, rewardId, at) {
  if (!['legacy', 'package'].includes(rewardKind) || !uuid(rewardId)) fail('package_bonus_reward_invalid');
  if(rewardKind==='package') return readPackageReferralRewardForBonus(env, { rewardId, checkedAt: at });
  const sql=`SELECT COALESCE(json_group_array(json_object('rewardId',r.reward_id,'beneficiaryTelegramId',r.beneficiary_telegram_id,
    'buyerTelegramId',r.buyer_telegram_id,'sourcePaymentLedgerEntryId',c.source_payment_ledger_entry_id,'sourceOrderId',c.source_order_id,
    'confirmedAt',r.confirmed_at,'confirmAfter',r.confirm_after,'status',r.reward_status,'revision',r.revision,
    'compensationLedgerEntryId',x.ledger_entry_id,'compensationType',x.entry_type,'compensationOccurredAt',x.occurred_at,
    'compensationRecordedAt',x.recorded_at,'reconciliationRunId',k.reconciliation_run_id,'reconciliationItemId',k.reconciliation_item_id)),'[]')
    FROM referral_rewards r JOIN referral_reward_candidates c ON c.candidate_id=r.candidate_id
    JOIN subscription_orders o ON o.order_id=c.source_order_id JOIN payment_ledger p ON p.ledger_entry_id=c.source_payment_ledger_entry_id
    JOIN subscription_access_grants g ON g.grant_id=c.source_access_grant_id
    JOIN referral_reward_protection_checks k ON k.reward_id=r.reward_id AND k.decision='confirm'
    JOIN referral_reward_transitions t ON t.transition_id=k.transition_id AND t.reward_id=r.reward_id AND t.to_status='confirmed'
    JOIN payment_reconciliation_runs q ON q.run_id=k.reconciliation_run_id
    JOIN payment_reconciliation_items i ON i.item_id=k.reconciliation_item_id
    LEFT JOIN payment_ledger x ON x.ledger_entry_id=(SELECT ledger_entry_id FROM payment_ledger WHERE related_ledger_entry_id=p.ledger_entry_id
      AND entry_type IN ('refund','chargeback') ORDER BY recorded_at,ledger_entry_id LIMIT 1)
    WHERE r.reward_id=? AND r.program_code=? AND r.reward_seconds=259200 AND r.beneficiary_telegram_id=c.inviter_telegram_id
    AND r.buyer_telegram_id=c.buyer_telegram_id AND r.confirm_after=c.confirm_after AND r.confirmed_at=t.recorded_at
    AND r.confirmed_at>=r.confirm_after AND r.confirmed_at<=? AND r.reward_status IN ('confirmed','cancelled')
    AND o.telegram_id=c.buyer_telegram_id AND o.plan_code=c.buyer_plan_code AND o.amount_stars=c.amount_stars
    AND o.order_state IN ('applied','refunded') AND p.order_id=o.order_id AND p.telegram_id=c.buyer_telegram_id
    AND p.entry_type='payment' AND p.direction='credit' AND p.currency='XTR' AND p.amount_stars=c.amount_stars AND p.occurred_at=c.paid_at
    AND g.order_id=o.order_id AND g.payment_ledger_entry_id=p.ledger_entry_id AND g.telegram_id=c.buyer_telegram_id AND g.plan_code=c.buyer_plan_code
    AND k.candidate_id=c.candidate_id AND k.source_payment_ledger_entry_id=p.ledger_entry_id AND k.source_access_grant_id=g.grant_id
    AND k.reward_revision=t.from_revision AND k.checked_at>=r.confirm_after AND k.recorded_at=t.recorded_at
    AND q.status IN ('completed','manual_review') AND q.started_at>=r.confirm_after AND q.finished_at<=k.recorded_at
    AND i.run_id=q.run_id AND i.ledger_entry_id=p.ledger_entry_id AND i.observation_side='telegram' AND i.transaction_direction='incoming'
    AND i.telegram_id=c.buyer_telegram_id AND i.amount_stars=c.amount_stars AND ABS(i.transaction_date-c.paid_at)<=86400
    AND i.local_state IN ('matched','recovered') AND i.observed_at>=r.confirm_after AND i.observed_at<=k.checked_at
    AND ((x.ledger_entry_id IS NULL AND r.reward_status='confirmed' AND r.last_transition_id=t.transition_id AND r.revision=t.to_revision)
      OR (x.ledger_entry_id IS NOT NULL AND x.order_id=p.order_id AND x.telegram_id=p.telegram_id AND x.direction='debit' AND x.currency=p.currency
        AND x.amount_stars=p.amount_stars AND x.telegram_payment_charge_id=p.telegram_payment_charge_id AND x.occurred_at>=p.occurred_at AND x.recorded_at<=?))`;
  const response=await dbFor(env).prepare(sql).bind(rewardId,PROGRAM,at,at).first(),snapshot=Object.values(response??{})[0];
  let proof;try{const values=JSON.parse(snapshot);if(values.length===1) proof=values[0];}catch{}
  if(!proof) fail('package_bonus_legacy_source_invalid');
  return freeze({...proof,rewardKind,status:proof.compensationLedgerEntryId?'compensated':proof.status,
    assertions:[{sql:`(${sql}) IS ?`,params:[rewardId,PROGRAM,at,at,snapshot]}]});
}
function result(grant, status = grant?.grant_status ?? 'unavailable', reason = null) {
  return freeze({ status, reason, rewardId: grant?.reward_id ?? null, rewardKind: grant?.reward_kind ?? null,
    bonusGrantId: grant?.bonus_grant_id ?? null, deliveryMode: grant?.delivery_mode ?? null, planCode: grant?.plan_code ?? null,
    availableAt: grant?.available_at ?? null, claimExpiresAt: grant?.claim_expires_at ?? null,
    startsAt: grant?.starts_at ?? null, endsAt: grant?.ends_at ?? null, accessApplied: false, packageReferralBonus: true });
}
async function ownRows(db, beneficiary, captures) {
  const source = {};
  for (const [key, [table, columns]] of Object.entries(TABLES)) {
    const where = key === 'grants' ? 'beneficiary_telegram_id=?' : 'bonus_grant_id IN (SELECT bonus_grant_id FROM package_referral_bonus_grants WHERE beneficiary_telegram_id=?)';
    source[key] = await rows(db, captures, table, columns, where, [beneficiary], key === 'grants' ? 'created_at,bonus_grant_id' : columns.split(' ')[0]);
  }
  return source;
}
function target(grant, effect) {
  const keys = ['target_source_kind', 'target_subscription_id', 'target_package_period_id', 'target_payment_ledger_entry_id', 'target_legacy_bonus_grant_id', 'target_package_bonus_grant_id'];
  return keys.every(key => grant[key] === effect[key]);
}
async function validateApplied(db,captures,grant, source, proof, at) {
  const effect = source.effects.find(e => e.bonus_grant_id === grant.bonus_grant_id);
  const transition = source.transitions.find(t => t.transition_id === grant.last_transition_id);
  const segments = source.segments.filter(s => s.bonus_grant_id === grant.bonus_grant_id).sort((a, b) => a.segment_index - b.segment_index);
  if (!effect || !transition || grant.grant_status !== 'applied' || proof.status !== 'confirmed' ||
      grant.source_payment_ledger_entry_id !== proof.sourcePaymentLedgerEntryId || grant.reward_id !== proof.rewardId ||
      grant.beneficiary_telegram_id !== proof.beneficiaryTelegramId || grant.bonus_seconds !== SECONDS.bonusAccess ||
      grant.available_at !== proof.confirmedAt || !positive(grant.applied_at) || grant.applied_at > at || grant.compensation_ledger_entry_id !== null ||
      grant.compensated_seconds !== 0 || grant.compensated_at !== null || !positive(grant.revision) ||
      effect.reward_kind !== grant.reward_kind || effect.reward_id !== grant.reward_id || effect.plan_code !== grant.plan_code ||
      effect.beneficiary_telegram_id !== grant.beneficiary_telegram_id || effect.source_payment_ledger_entry_id !== grant.source_payment_ledger_entry_id ||
      effect.recorded_at !== grant.applied_at || effect.allocation_anchor_at !== grant.allocation_anchor_at ||
      effect.effect_kind !== (grant.delivery_mode==='manual_claim'?'manual_professional_access':'paid_plan_extension') ||
      effect.allocation_fingerprint !== grant.allocation_fingerprint || !target(grant, effect) ||
      transition.bonus_grant_id !== grant.bonus_grant_id || transition.to_status !== 'applied' || transition.to_revision !== grant.revision ||
      transition.related_payment_ledger_entry_id !== grant.source_payment_ledger_entry_id || transition.recorded_at !== grant.applied_at ||
      effect.applied_transition_id !== transition.transition_id || source.reversals.some(r => r.bonus_grant_id === grant.bonus_grant_id) ||
      !segments.length || segments.some((s, i) => s.segment_index !== i || s.plan_code !== grant.plan_code ||
        !positive(s.starts_at) || s.ends_at <= s.starts_at || s.seconds !== s.ends_at - s.starts_at || s.recorded_at !== grant.applied_at ||
        i > 0 && s.starts_at < segments[i - 1].ends_at) || segments.reduce((n, s) => n + s.seconds, 0) !== SECONDS.bonusAccess ||
      grant.starts_at !== segments[0].starts_at || grant.ends_at !== segments.at(-1).ends_at) fail('package_bonus_effect_invalid');
  let allocation; try { allocation = JSON.parse(effect.allocation_json); } catch { fail('package_bonus_allocation_invalid'); }
  if (allocation?.version !== 1 || allocation.planCode !== grant.plan_code || allocation.anchorAt !== grant.allocation_anchor_at ||
      allocation.appliedAt !== grant.applied_at || !Array.isArray(allocation.occupied) ||
      await hash(effect.allocation_json) !== grant.allocation_fingerprint) fail('package_bonus_allocation_invalid');
  const expected = allocatePackageReferralBonusSegments(allocation);
  if (JSON.stringify(expected) !== JSON.stringify(segments.map(s => ({ planCode: s.plan_code, startsAt: s.starts_at, endsAt: s.ends_at, seconds: s.seconds }))))
    fail('package_bonus_allocation_invalid');
  const targetRefs=[grant.target_subscription_id,grant.target_package_period_id,grant.target_legacy_bonus_grant_id,grant.target_package_bonus_grant_id];
  if(grant.delivery_mode==='manual_claim') {
    if(grant.target_source_kind!=='none'||targetRefs.some(x=>x!==null)||grant.target_payment_ledger_entry_id!==null||
      grant.claimed_at!==grant.applied_at||grant.plan_code!=='professional'||allocation.anchorAt!==grant.applied_at) fail('package_bonus_target_invalid');
  } else if(grant.delivery_mode!=='extend_active_plan'||grant.claimed_at!==null||targetRefs.filter(x=>x!==null).length!==1)
    fail('package_bonus_target_invalid');
  let currentTarget=false;
  for(const window of allocation.occupied) {
    let table,ref,column,where,columns='plan_code starts_at ends_at recorded_at';
    if(window.sourceKind==='package_payment') {table='subscription_package_periods';ref=window.sourceRef;column='payment_ledger_entry_id';where='telegram_id=?';columns+=' period_id';}
    else if(window.sourceKind==='payment') {table='subscription_access_grants';ref=window.sourceRef;column='payment_ledger_entry_id';where='telegram_id=?';columns='plan_code starts_at ends_at created_at subscription_id';}
    else if(window.sourceKind==='referral_bonus') {
      const packageSegment=/^bonus:package:([0-9a-f-]{36})$/u.exec(window.sourceRef)?.[1];
      const legacyGrant=/^bonus:([0-9a-f-]{36})$/u.exec(window.sourceRef)?.[1];
      if(packageSegment) {table='package_referral_bonus_segments';ref=packageSegment;column='segment_id';where='bonus_grant_id IN (SELECT bonus_grant_id FROM package_referral_bonus_grants WHERE beneficiary_telegram_id=?)';}
      else if(legacyGrant) {table='bonus_access_grants';ref=legacyGrant;column='bonus_grant_id';where='beneficiary_telegram_id=?';columns='plan_code starts_at ends_at applied_at';}
      else fail('package_bonus_allocation_source_invalid');
    } else fail('package_bonus_allocation_source_invalid');
    const evidence=window.sourceKind==='payment'?await verifiedPaymentWindow(db,captures,allocation,window,grant.beneficiary_telegram_id,grant.applied_at):
      (await rows(db,captures,table,columns,`${column}=? AND ${where}`,[ref,grant.beneficiary_telegram_id],column))[0];
    if(!evidence||evidence.plan_code!==window.planCode||window.sourceKind!=='payment'&&(evidence.starts_at!==window.startsAt||evidence.ends_at!==window.endsAt)||
      (evidence.recorded_at??evidence.created_at??evidence.applied_at)>grant.applied_at) fail('package_bonus_allocation_source_invalid');
    const matched=grant.target_source_kind==='package'?ref===grant.target_payment_ledger_entry_id&&evidence.period_id===grant.target_package_period_id:
      grant.target_source_kind==='subscription'?ref===grant.target_payment_ledger_entry_id&&evidence.subscription_id===grant.target_subscription_id:
      grant.target_source_kind==='earned'?(ref===grant.target_legacy_bonus_grant_id||
        table==='package_referral_bonus_segments'&&source.segments.some(s=>s.segment_id===ref&&s.bonus_grant_id===grant.target_package_bonus_grant_id)):false;
    if(matched&&window.planCode===grant.plan_code&&window.startsAt<=grant.applied_at&&window.endsAt>grant.applied_at&&allocation.anchorAt>=window.endsAt) currentTarget=true;
  }
  if(grant.delivery_mode==='extend_active_plan') {
    if(!currentTarget) fail('package_bonus_target_invalid');
    const current=allocation.occupied.filter(w=>w.planCode===grant.plan_code&&w.startsAt<=grant.applied_at&&w.endsAt>grant.applied_at);
    let anchor=Math.max(...current.map(w=>w.endsAt)),prior;
    do{prior=anchor;for(const w of allocation.occupied)if(w.planCode===grant.plan_code&&w.startsAt<=anchor&&w.endsAt>anchor)anchor=w.endsAt;}while(anchor!==prior);
    if(anchor!==allocation.anchorAt) fail('package_bonus_allocation_anchor_invalid');
  }
  return { effect, segments };
}

export async function readPackageReferralBonusDatabaseSource({ db, env, telegramId, nowSec } = {}) {
  if (!positive(telegramId) || !positive(nowSec)) fail('package_bonus_source_invalid');
  const schema = await inspectPackageReferralSchema(db),captures=await schemaCaptures(db,schema);
  if (!schema.present) return freeze({ present: false, periods: [], subscriptions: [], captures });
  const source = await ownRows(db, telegramId, captures), periods = [], subscriptions = [];
  for (const grant of source.grants) {
    if (grant.program_code !== PROGRAM || grant.beneficiary_telegram_id !== telegramId || !uuid(grant.bonus_grant_id) ||
        grant.reward_id !== (grant.reward_kind === 'legacy' ? grant.legacy_reward_id : grant.package_reward_id)) fail('package_bonus_source_invalid');
    const proof = await rewardProof({ ...env, DB: db }, grant.reward_kind, grant.reward_id, nowSec);
    captures.push(...capturePredicates(proof.assertions ?? []));
    if (grant.grant_status !== 'applied' || proof.status !== 'confirmed') continue;
    const { segments } = await validateApplied(db,captures,grant, source, proof, nowSec);
    for (const segment of segments) {
      const subscriptionId = 'bonus:package:' + grant.bonus_grant_id + ':' + segment.segment_index;
      subscriptions.push({ subscription_id: subscriptionId, telegram_id: telegramId, plan_code: grant.plan_code,
        billing_mode: 'prepaid', status: 'active', current_period_start: segment.starts_at, current_period_end: segment.ends_at,
        revision: grant.revision, source_kind: 'referral_bonus', source_order_id: null, telegram_payment_charge_id: null,
        last_ledger_entry_id: null, auto_renew: 0, created_at: grant.applied_at, updated_at: grant.updated_at,
        bonus_grant_id: grant.bonus_grant_id });
      periods.push({ subscriptionId, planCode: grant.plan_code, startsAt: segment.starts_at, endsAt: segment.ends_at,
        status: 'active', sourceKind: 'referral_bonus', ledgerEntryId: 'bonus:package:' + segment.segment_id,
        chargeId: 'bonus:package:' + segment.segment_id, contractId: null, occurredAt: grant.applied_at,
        recordedAt: grant.applied_at, compensatedAt: null });
    }
  }
  if (periods.length > 128) fail('package_bonus_source_overflow');
  return freeze({ present: true, periods, subscriptions, captures });
}

export async function readPackageReferralBonusClaimDatabaseSource({ db, env, telegramId, nowSec } = {}) {
  if(!positive(telegramId)||!positive(nowSec)) fail('package_bonus_claim_source_invalid');
  const schema = await inspectPackageReferralSchema(db), captures = await schemaCaptures(db,schema);
  if (!schema.present) return freeze({ present: false, grant: null, claimableByEvidence: false, captures, validUntil: nowSec + 60 });
  const grants = await rows(db, captures, ...TABLES.grants, 'beneficiary_telegram_id=?', [telegramId], 'created_at DESC,bonus_grant_id');
  const grant = grants[0] ?? null; let available = false, validUntil = nowSec + 60;
  if (grant) {
    const proof = await rewardProof({ ...env, DB: db }, grant.reward_kind, grant.reward_id, nowSec);
    captures.push(...capturePredicates(proof.assertions ?? []));
    const effects = await rows(db, captures, ...TABLES.effects, 'bonus_grant_id=?', [grant.bonus_grant_id], 'effect_id');
    available = readReferralRewardConfig(env).bonusGrantsEnabled && grant.program_code === PROGRAM &&
      grant.beneficiary_telegram_id === telegramId && grant.delivery_mode === 'manual_claim' && grant.grant_status === 'claimable' &&
      grant.plan_code === 'professional' && grant.bonus_seconds === SECONDS.bonusAccess && proof.status === 'confirmed' &&
      proof.beneficiaryTelegramId === telegramId && proof.sourcePaymentLedgerEntryId === grant.source_payment_ledger_entry_id &&
      grant.available_at === proof.confirmedAt && grant.claim_expires_at === grant.available_at + SECONDS.manualClaimWindow &&
      grant.available_at <= nowSec && grant.claim_expires_at >= nowSec && grant.compensation_ledger_entry_id === null && effects.length === 0;
    if (positive(grant.claim_expires_at) && grant.claim_expires_at >= nowSec) validUntil = Math.min(validUntil, grant.claim_expires_at + 1);
  }
  return freeze({ present: true, grant, claimableByEvidence: available, captures, validUntil });
}

async function beneficiaryFacts(env, proof, at) {
  const { resolveServiceReferralBeneficiaryFacts } = await import('../v1.4.1/authority-resolver.mjs');
  const context = createServiceExecutor({ binding: dbFor(env), env, purpose: 'referral_settle', clockSeconds: () => at }).createContext();
  return resolveServiceReferralBeneficiaryFacts({ context, rewardId: proof.rewardId, rewardKind: proof.rewardKind ?? 'package' });
}
function delivery(facts, at) {
  if (!facts.account?.exists || !facts.account.acceptedTerms || facts.account.isBlocked || facts.account.pendingDeletion ||
      facts.access.status !== 'verified' || facts.financialSourceAvailable === false ||
      ['suspended', 'chargeback'].includes(facts.access.accessState) || facts.reviewRequired) fail('package_bonus_beneficiary_requires_review');
  const live = facts.periods.filter(p => p.status === 'active'), current = live.filter(p => p.startsAt <= at && p.endsAt > at);
  const currentPlan = facts.access.effectivePlan;
  if (current.length && ['professional', 'dragon'].includes(currentPlan)) {
    if (current.some(p => p.planCode !== currentPlan)) fail('package_bonus_beneficiary_requires_review');
    let anchor = Math.max(...current.map(p => p.endsAt)), prior;
    do { prior = anchor; for (const p of live) if (p.planCode === currentPlan && p.startsAt <= anchor && p.endsAt > anchor) anchor = p.endsAt; } while (prior !== anchor);
    const targetPeriod = [...current].sort((a, b) => b.endsAt - a.endsAt)[0];
    return { deliveryMode: 'extend_active_plan', planCode: currentPlan, anchorAt: anchor, targetPeriod, occupied: live };
  }
  if (currentPlan === 'free' && !current.length && ['none', 'trial', 'expired', 'refunded'].includes(facts.access.accessState))
    return { deliveryMode: 'manual_claim', planCode: 'professional', anchorAt: at, targetPeriod: null, occupied: live };
  fail('package_bonus_beneficiary_requires_review');
}
function targetFields(period) {
  const fields = { target_source_kind: 'none', target_subscription_id: null, target_package_period_id: null,
    target_payment_ledger_entry_id: null, target_legacy_bonus_grant_id: null, target_package_bonus_grant_id: null };
  if (!period) return fields;
  if (period.sourceKind === 'package_payment') return { ...fields, target_source_kind: 'package',
    target_package_period_id: period.packagePeriodId, target_payment_ledger_entry_id: period.ledgerEntryId };
  if (period.sourceKind === 'payment') return { ...fields, target_source_kind: 'subscription',
    target_subscription_id: period.subscriptionId, target_payment_ledger_entry_id: period.ledgerEntryId };
  if (period.sourceKind === 'referral_bonus') {
    const packageId = /^bonus:package:([0-9a-f-]{36}):/u.exec(period.subscriptionId)?.[1];
    const legacyId = packageId ? null : /^bonus:([0-9a-f-]{36})$/u.exec(period.subscriptionId)?.[1]
      ?? /^bonus:([0-9a-f-]{36})$/u.exec(period.ledgerEntryId)?.[1];
    if (!uuid(packageId ?? legacyId)) fail('package_bonus_earned_target_invalid');
    return { ...fields, target_source_kind: 'earned', target_legacy_bonus_grant_id: legacyId, target_package_bonus_grant_id: packageId ?? null };
  }
  fail('package_bonus_target_invalid');
}
const insert = (db, table, row) => db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row));
function transitionRow(grant, toStatus, at, { reasonCode, actorId = null, ledgerId = grant.source_payment_ledger_entry_id, seconds = 0 } = {}) {
  return { transition_id: crypto.randomUUID(), transition_key: `package-bonus:${grant.bonus_grant_id}:${grant.revision}:${toStatus}`,
    bonus_grant_id: grant.bonus_grant_id, from_status: grant.grant_status, to_status: toStatus, from_revision: grant.revision,
    to_revision: grant.revision + 1, reason_code: reasonCode, actor_type: actorId === null ? 'system' : 'telegram', actor_id: actorId,
    related_payment_ledger_entry_id: ledgerId, compensated_seconds: seconds, occurred_at: at, recorded_at: at };
}
async function applicationStatements(db, grant, selected, at, actorId = null) {
  const segments = allocatePackageReferralBonusSegments(selected);
  const provenance=await paymentProvenance(db,selected.occupied,at);
  const allocation = JSON.stringify({ version: 1, planCode: selected.planCode, anchorAt: selected.anchorAt, appliedAt: at,
    paymentProofs:provenance.proofs,
    occupied: selected.occupied.map(p => ({ sourceKind: p.sourceKind, sourceRef: p.ledgerEntryId, planCode: p.planCode,
      startsAt: p.startsAt, endsAt: p.endsAt })).sort((a, b) => a.startsAt - b.startsAt || a.sourceRef.localeCompare(b.sourceRef)) });
  const fingerprint = await hash(allocation), target = targetFields(selected.targetPeriod);
  const transition = transitionRow(grant, 'applied', at, { reasonCode: selected.deliveryMode === 'manual_claim' ? 'manual_claim' : 'active_plan_extension', actorId });
  const effect = { effect_id: crypto.randomUUID(), effect_key: 'package-bonus-effect:' + grant.bonus_grant_id,
    bonus_grant_id: grant.bonus_grant_id, reward_kind: grant.reward_kind, reward_id: grant.reward_id,
    beneficiary_telegram_id: grant.beneficiary_telegram_id, effect_kind: selected.deliveryMode === 'manual_claim' ? 'manual_professional_access' : 'paid_plan_extension',
    plan_code: selected.planCode, source_payment_ledger_entry_id: grant.source_payment_ledger_entry_id, ...target,
    allocation_anchor_at: selected.anchorAt, allocation_fingerprint: fingerprint, allocation_json: allocation,
    applied_transition_id: transition.transition_id, recorded_at: at };
  const writes = segments.map((s, i) => insert(db, TABLES.segments[0], { segment_id: crypto.randomUUID(), bonus_grant_id: grant.bonus_grant_id,
    segment_index: i, plan_code: s.planCode, starts_at: s.startsAt, ends_at: s.endsAt, seconds: s.seconds, recorded_at: at }));
  writes.push(insert(db, TABLES.effects[0], effect), insert(db, TABLES.transitions[0], transition));
  return {writes,assertions:predicates(provenance.captures)};
}

export async function ensurePackageReferralBonusGrant(env, { rewardId, rewardKind = 'package', deliveredAt = now() } = {}) {
  const at = clock(deliveredAt), db = dbFor(env);
  if (!readReferralRewardConfig(env).bonusGrantsEnabled) return freeze({ status: 'disabled', reason: 'referral_bonus_grants_disabled', rewardId, rewardKind });
  const schema = await inspectPackageReferralSchema(db);
  if (!schema.present) return freeze({ status: 'not_applicable', reason: 'package_referral_storage_not_installed', rewardId, rewardKind });
  const proof = await rewardProof(env, rewardKind, rewardId, at);
  if (proof.status !== 'confirmed') return freeze({ status: 'waiting', reason: 'referral_reward_not_confirmed', rewardId, rewardKind });
  const captures = [], existing = (await rows(db, captures, ...TABLES.grants, 'reward_kind=? AND reward_id=?', [rewardKind, rewardId], 'bonus_grant_id'))[0];
  if (existing) return result(existing, 'duplicate');
  const facts = await beneficiaryFacts(env, { ...proof, rewardKind }, at), selected = delivery(facts, at);
  if (rewardKind === 'legacy' && selected.targetPeriod?.sourceKind !== 'package_payment' &&
      !String(selected.targetPeriod?.subscriptionId ?? '').startsWith('bonus:package:')) return freeze({ status: 'not_applicable', rewardId, rewardKind });
  const target = targetFields(selected.targetPeriod);
  const grant = { bonus_grant_id: crypto.randomUUID(), grant_key: `bonus:${PROGRAM}:${rewardKind}:${rewardId}`, program_code: PROGRAM,
    reward_kind: rewardKind, reward_id: rewardId, legacy_reward_id: rewardKind === 'legacy' ? rewardId : null,
    package_reward_id: rewardKind === 'package' ? rewardId : null, beneficiary_telegram_id: proof.beneficiaryTelegramId,
    delivery_mode: selected.deliveryMode, plan_code: selected.planCode, bonus_seconds: SECONDS.bonusAccess,
    grant_status: selected.deliveryMode === 'manual_claim' ? 'claimable' : 'pending', available_at: proof.confirmedAt,
    claim_expires_at: selected.deliveryMode === 'manual_claim' ? proof.confirmedAt + SECONDS.manualClaimWindow : null,
    claimed_at: null, applied_at: null, starts_at: null, ends_at: null, allocation_anchor_at: null, allocation_fingerprint: null,
    ...target, source_payment_ledger_entry_id: proof.sourcePaymentLedgerEntryId, compensation_ledger_entry_id: null,
    compensated_seconds: 0, compensated_at: null, last_transition_id: null, revision: 1, created_at: at, updated_at: at };
  const writes = [insert(db, TABLES.grants[0], grant)];
  let application={assertions:[]};
  if (selected.deliveryMode === 'extend_active_plan') {application=await applicationStatements(db,grant,selected,at);writes.push(...application.writes);}
  else if(at>grant.claim_expires_at) writes.push(insert(db,TABLES.transitions[0],transitionRow(grant,'expired',at,{reasonCode:'claim_window_expired'})));
  await guarded(db, [packageReferralSchemaAssertion(schema), ...proof.assertions, ...facts.sourceAssertions.assertions, ...predicates(captures),...application.assertions], writes);
  const saved = (await rows(db, [], ...TABLES.grants, 'bonus_grant_id=?', [grant.bonus_grant_id], 'bonus_grant_id'))[0];
  if (!saved || selected.deliveryMode === 'extend_active_plan' && saved.grant_status !== 'applied') fail('package_bonus_delivery_invariant');
  return result(saved);
}

export async function claimPackageReferralBonusGrant(env, { telegramId, bonusGrantId, claimedAt = now() } = {},options={}) {
  const at = clock(claimedAt), db = dbFor(env);
  if (!positive(telegramId) || !uuid(bonusGrantId)) fail('package_bonus_claim_invalid');
  const claim = await readPackageReferralBonusClaimDatabaseSource({ db, env, telegramId, nowSec: at });
  if (!claim.present || claim.grant?.bonus_grant_id !== bonusGrantId) return freeze({ status: 'not_applicable', bonusGrantId });
  if (claim.grant.grant_status === 'applied') return result(claim.grant, 'duplicate');
  if (!claim.claimableByEvidence) return result(claim.grant, 'unavailable', 'referral_bonus_not_claimable');
  const proof = await rewardProof(env, claim.grant.reward_kind, claim.grant.reward_id, at);
  const facts = await beneficiaryFacts(env, { ...proof, rewardKind: claim.grant.reward_kind }, at), selected = delivery(facts, at);
  if (selected.deliveryMode !== 'manual_claim') return result(claim.grant, 'manual_review', 'referral_bonus_paid_access_conflict');
  const extra=options.additionalAssertions??[];
  if(!Array.isArray(extra)||extra.some(a=>typeof a?.sql!=='string'||!Array.isArray(a.params)||a.params.length>99)) fail('package_bonus_claim_assertions_invalid');
  const application=await applicationStatements(db,claim.grant,selected,at,telegramId);
  await guarded(db, [...predicates(claim.captures), ...facts.sourceAssertions.assertions,...extra,...application.assertions],application.writes);
  const saved = (await rows(db, [], ...TABLES.grants, 'bonus_grant_id=? AND beneficiary_telegram_id=?', [bonusGrantId, telegramId], 'bonus_grant_id'))[0];
  if (saved?.grant_status !== 'applied') fail('package_bonus_claim_invariant');
  return result(saved);
}

export async function applyPackageReferralBonusCompensation(env, { compensationLedgerEntryId, recordedAt = now() } = {}) {
  if (!uuid(compensationLedgerEntryId)) fail('package_bonus_compensation_invalid');
  const at = clock(recordedAt), db = dbFor(env), schema = await inspectPackageReferralSchema(db);
  if (!schema.present) return freeze({ status: 'not_applicable', compensationLedgerEntryId });
  const captures = [], compensation = (await rows(db, captures, 'payment_ledger',
    'ledger_entry_id related_ledger_entry_id order_id telegram_id entry_type direction currency amount_stars telegram_payment_charge_id occurred_at recorded_at',
    'ledger_entry_id=?', [compensationLedgerEntryId], 'ledger_entry_id'))[0];
  if (!compensation || !['refund', 'chargeback'].includes(compensation.entry_type) || compensation.direction !== 'debit' || compensation.recorded_at > at)
    fail('package_bonus_compensation_invalid');
  const grants = await rows(db, captures, ...TABLES.grants, 'source_payment_ledger_entry_id=?', [compensation.related_ledger_entry_id], 'bonus_grant_id');
  const effects = await rows(db, captures, ...TABLES.effects, 'source_payment_ledger_entry_id=?', [compensation.related_ledger_entry_id], 'effect_id');
  const writes = [], assertions = [packageReferralSchemaAssertion(schema), ...predicates(captures)];let affectedGrants=0;
  for (const grant of grants.filter(g => ['pending', 'claimable', 'applied'].includes(g.grant_status))) {
    const proof = await rewardProof(env, grant.reward_kind, grant.reward_id, at); assertions.push(...proof.assertions);
    if (proof.compensationLedgerEntryId !== compensationLedgerEntryId) fail('package_bonus_compensation_binding_invalid');
    const safe = grant.grant_status !== 'applied' || grant.starts_at > compensation.occurred_at;
    const transition = transitionRow(grant, safe ? 'revoked' : 'manual_review', at,
      { reasonCode: compensation.entry_type, ledgerId: compensationLedgerEntryId, seconds: safe ? SECONDS.bonusAccess : 0 });
    transition.occurred_at=compensation.occurred_at;
    writes.push(insert(db, TABLES.transitions[0], transition));affectedGrants++;
    if (grant.grant_status === 'applied' && safe) writes.push(insert(db, TABLES.reversals[0], {
      reversal_id: crypto.randomUUID(), reversal_key: 'package-bonus-reversal:' + grant.bonus_grant_id, bonus_grant_id: grant.bonus_grant_id,
      effect_id: effects.find(e => e.bonus_grant_id === grant.bonus_grant_id)?.effect_id, compensation_ledger_entry_id: compensationLedgerEntryId,
      reversal_transition_id: transition.transition_id, compensated_seconds: SECONDS.bonusAccess,
      occurred_at: compensation.occurred_at, recorded_at: at }));
  }
  if (!writes.length) return freeze({ status: grants.length ? 'duplicate' : 'not_applicable', compensationLedgerEntryId });
  await guarded(db, assertions, writes); return freeze({ status: 'applied', compensationLedgerEntryId, affectedGrants });
}

const page = value => {if(!positive(value)||value>50) fail('package_bonus_limit_invalid');return value;};
export async function repairPackageReferralBonusGrants(env,{limit=25,deliveredAt=now()}={}) {
  const db=dbFor(env),at=clock(deliveredAt),schema=await inspectPackageReferralSchema(db),results=[];
  if(!schema.present) return freeze({status:'not_applicable',attempted:0,results});
  if(!readReferralRewardConfig(env).bonusGrantsEnabled) return freeze({status:'disabled',attempted:0,results});
  const source=await db.prepare(`SELECT reward_kind,reward_id FROM (
    SELECT 'package' AS reward_kind,reward_id,confirmed_at,beneficiary_telegram_id FROM package_referral_rewards WHERE reward_status='confirmed'
    UNION ALL SELECT 'legacy',reward_id,confirmed_at,beneficiary_telegram_id FROM referral_rewards r WHERE reward_status='confirmed'
      AND (EXISTS(SELECT 1 FROM subscription_package_periods p WHERE p.telegram_id=r.beneficiary_telegram_id AND p.starts_at<=? AND p.ends_at>?
        AND NOT EXISTS(SELECT 1 FROM payment_ledger x WHERE x.related_ledger_entry_id=p.payment_ledger_entry_id AND x.entry_type IN ('refund','chargeback')))
        OR EXISTS(SELECT 1 FROM package_referral_bonus_grants g JOIN package_referral_bonus_segments z ON z.bonus_grant_id=g.bonus_grant_id
          WHERE g.beneficiary_telegram_id=r.beneficiary_telegram_id AND g.grant_status='applied' AND z.starts_at<=? AND z.ends_at>?))) r
    WHERE NOT EXISTS(SELECT 1 FROM referral_bonus_reward_slots s WHERE s.reward_kind=r.reward_kind AND s.reward_id=r.reward_id)
      AND EXISTS(SELECT 1 FROM users u WHERE u.telegram_id=r.beneficiary_telegram_id AND u.accepted_terms=1 AND u.is_blocked=0)
      AND NOT EXISTS(SELECT 1 FROM privacy_deletion_requests d WHERE d.telegram_id=r.beneficiary_telegram_id AND d.status='pending')
    ORDER BY confirmed_at DESC,reward_kind,reward_id LIMIT ?`).bind(at,at,at,at,page(limit)).all();
  for(const r of source.results??[]) {
    try{results.push(await ensurePackageReferralBonusGrant(env,{rewardId:r.reward_id,rewardKind:r.reward_kind,deliveredAt:at}));}
    catch(error){results.push({status:'manual_review',rewardId:r.reward_id,rewardKind:r.reward_kind,reason:error?.code??'package_bonus_delivery_failed'});}
  }
  return freeze({status:'completed',attempted:results.length,results});
}
export async function runPackageReferralBonusMaintenance(env,{limit=25,recordedAt=now()}={}) {
  const db=dbFor(env),at=clock(recordedAt),schema=await inspectPackageReferralSchema(db),results=[];
  if(!schema.present) return freeze({status:'not_applicable',attempted:0,results});
  const count=page(limit),refunds=await db.prepare(`SELECT DISTINCT x.ledger_entry_id,g.reward_kind FROM package_referral_bonus_grants g
    JOIN payment_ledger x ON x.related_ledger_entry_id=g.source_payment_ledger_entry_id
    WHERE g.grant_status IN ('pending','claimable','applied') AND x.entry_type IN ('refund','chargeback') AND x.recorded_at<=?
    ORDER BY x.recorded_at,x.ledger_entry_id LIMIT ?`).bind(at,count).all();
  for(const row of refunds.results??[]) {
    if(row.reward_kind==='package') await applyPackageReferralRewardCompensation(env,{compensationLedgerEntryId:row.ledger_entry_id,recordedAt:at});
    results.push(await applyPackageReferralBonusCompensation(env,{compensationLedgerEntryId:row.ledger_entry_id,recordedAt:at}));
  }
  const selected=await db.prepare("SELECT bonus_grant_id FROM package_referral_bonus_grants WHERE grant_status='claimable' AND claim_expires_at<? ORDER BY claim_expires_at,bonus_grant_id LIMIT ?").bind(at,Math.max(0,count-results.length)).all();
  for(const grant of selected.results??[]) {
    const captures=[],fresh=(await rows(db,captures,...TABLES.grants,'bonus_grant_id=?',[grant.bonus_grant_id],'bonus_grant_id'))[0];
    if(fresh.grant_status!=='claimable'||fresh.claim_expires_at>=at) continue;
    await guarded(db,[packageReferralSchemaAssertion(schema),...predicates(captures)],
      [insert(db,TABLES.transitions[0],transitionRow(fresh,'expired',at,{reasonCode:'claim_window_expired'}))]);
    results.push(result({...fresh,grant_status:'expired'}));
  }
  return freeze({status:'completed',attempted:results.length,results});
}
export async function getPackageReferralBonusStatus(env,{telegramId,at=now()}={}) {
  const checkedAt=clock(at),db=dbFor(env),claim=await readPackageReferralBonusClaimDatabaseSource({db,env,telegramId,nowSec:checkedAt});
  if(!claim.present) return freeze({status:'none'});
  const grant=claim.grant;
  if(!grant) {
    const reward=await db.prepare('SELECT reward_id,reward_status,confirm_after,confirmed_at,cancelled_at FROM package_referral_rewards WHERE beneficiary_telegram_id=? ORDER BY created_at DESC,reward_id LIMIT 1').bind(telegramId).first();
    return freeze(reward?{status:reward.reward_status,rewardId:reward.reward_id,rewardStatus:reward.reward_status,
      confirmAfter:reward.confirm_after,confirmedAt:reward.confirmed_at,cancelledAt:reward.cancelled_at,bonusGrantId:null}:{status:'none'});
  }
  const proof=await rewardProof(env,grant.reward_kind,grant.reward_id,checkedAt);
  const segments=await rows(db,[],...TABLES.segments,'bonus_grant_id=?',[grant.bonus_grant_id],'segment_index');
  let status=grant.grant_status==='applied'&&grant.ends_at<=checkedAt?'expired':grant.grant_status;
  if(['pending','claimable','applied'].includes(grant.grant_status)&&proof.status!=='confirmed') {
    const compensated=['compensated','cancelled'].includes(proof.status)&&proof.compensationLedgerEntryId&&
      ['refund','chargeback'].includes(proof.compensationType)&&positive(proof.compensationOccurredAt)&&
      positive(proof.compensationRecordedAt)&&proof.compensationOccurredAt<=proof.compensationRecordedAt&&proof.compensationRecordedAt<=checkedAt;
    status=compensated&&(grant.grant_status!=='applied'||grant.starts_at>proof.compensationOccurredAt)?'revoked':'manual_review';
  }
  return freeze({...result(grant),rewardStatus:proof.status,confirmAfter:proof.confirmAfter,confirmedAt:proof.confirmedAt,
    bonusSegments:segments.map(s=>({planCode:s.plan_code,startsAt:s.starts_at,endsAt:s.ends_at,seconds:s.seconds})),
    claimable:status==='claimable'&&claim.claimableByEvidence,effective:status==='applied'&&proof.status==='confirmed'&&segments.some(s=>s.starts_at<=checkedAt&&s.ends_at>checkedAt),status});
}
