import {
  REFERRAL_REWARD_PROGRAM_CODE,
  REFERRAL_REWARD_SECONDS,
  isPaymentInsideEligibilityWindow,
  paymentEligibilityDeadline,
  readReferralRewardConfig,
  requireUnixSeconds,
  rewardConfirmationTime,
} from '../v1.3.7/referral-reward-foundation.mjs';
import { getReferralRewardRolloutDecision } from '../v1.3.7/referral-reward-candidate-runtime.mjs';
import { inspectPackageReferralSchema, packageReferralSchemaAssertion } from './package-referral-contract.mjs';
import { referralReconciliationOffset, referralReconciliationContinuation } from '../v1.3.7/referral-reconciliation-pagination.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PAID_PLANS = new Set(['professional', 'dragon']);
const now = () => Math.floor(Date.now() / 1000);
function fail(code, cause) {
  const error = new Error('Package referral operation rejected');
  error.code = code;
  if (cause) error.cause = cause;
  throw error;
}
function uuid(value, code) {
  const id = String(value || '').trim().toLowerCase();
  if (!UUID.test(id)) fail(code);
  return id;
}
function clock(value = now()) {
  try { return requireUnixSeconds(value); }
  catch (cause) { fail('package_referral_clock_invalid', cause); }
}
function telegramId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function database(env) {
  if (!env?.DB?.prepare || !env?.DB?.batch) fail('package_referral_database_not_ready');
  return env.DB;
}
const result = data => Object.freeze({ ...data, rewardKind: 'package', accessApplied: false });

// These are immutable package/payment facts, not a legacy access grant. In
// particular a prepaid period scheduled for a future boundary can qualify on
// its genuine paid_at; its future start is never substituted for payment time.
const SOURCE_SQL = `SELECT
  o.order_id, o.telegram_id AS buyer_telegram_id, o.plan_code AS buyer_plan_code,
  o.amount_stars, o.currency, o.order_state, o.billing_mode, o.paid_at AS order_paid_at,
  o.applied_at, o.access_seconds,
  m.plan_code AS metadata_plan_code, m.telegram_id AS metadata_telegram_id,
  m.package_code, m.period_seconds AS metadata_period_seconds,
  m.amount_stars AS metadata_amount_stars, m.currency AS metadata_currency,
  m.billing_mode AS metadata_billing_mode,
  pp.period_id AS source_package_period_id, pp.order_id AS period_order_id,
  pp.telegram_id AS period_telegram_id, pp.plan_code AS period_plan_code,
  pp.billing_mode AS period_billing_mode, pp.starts_at, pp.ends_at,
  pp.period_seconds, pp.recorded_at AS period_recorded_at,
  p.ledger_entry_id AS source_payment_ledger_entry_id, p.order_id AS payment_order_id,
  p.telegram_id AS payment_telegram_id, p.entry_type AS payment_entry_type,
  p.direction AS payment_direction, p.currency AS payment_currency,
  p.amount_stars AS payment_amount_stars, p.occurred_at AS paid_at,
  p.recorded_at AS payment_recorded_at, p.telegram_payment_charge_id,
  p.related_ledger_entry_id,
  u.inviter_id AS inviter_telegram_id,
  CAST(strftime('%s',u.inviter_bound_at) AS INTEGER) AS inviter_bound_at,
  (SELECT CAST(strftime('%s',MIN(s.started_at)) AS INTEGER) FROM bot_start_events s
   WHERE s.telegram_id=o.telegram_id AND s.is_new_user=1) AS first_started_at,
  EXISTS(WITH RECURSIVE chain(telegram_id) AS (
    SELECT u.inviter_id UNION SELECT ancestor.inviter_id FROM users ancestor
    JOIN chain ON ancestor.telegram_id=chain.telegram_id WHERE ancestor.inviter_id IS NOT NULL)
    SELECT 1 FROM chain WHERE telegram_id=o.telegram_id) AS has_invitation_cycle,
  EXISTS(SELECT 1 FROM payment_ledger c WHERE c.related_ledger_entry_id=p.ledger_entry_id
    AND c.entry_type IN ('refund','chargeback')) AS has_compensation,
  EXISTS(SELECT 1 FROM subscription_access_grants g WHERE g.order_id=o.order_id
    OR g.payment_ledger_entry_id=p.ledger_entry_id) AS has_legacy_grant,
  EXISTS(SELECT 1 FROM payment_ledger earlier JOIN subscription_orders eo ON eo.order_id=earlier.order_id
    WHERE earlier.telegram_id=o.telegram_id AND earlier.entry_type='payment' AND earlier.direction='credit'
    AND earlier.currency='XTR' AND eo.plan_code IN ('professional','dragon')
    AND (earlier.occurred_at<p.occurred_at OR
      (earlier.occurred_at=p.occurred_at AND earlier.ledger_entry_id<p.ledger_entry_id))) AS has_earlier_paid_purchase
 FROM subscription_orders o
 JOIN subscription_package_orders m ON m.order_id=o.order_id
 LEFT JOIN subscription_package_periods pp ON pp.order_id=o.order_id
 LEFT JOIN payment_ledger p ON p.ledger_entry_id=pp.payment_ledger_entry_id
 LEFT JOIN users u ON u.telegram_id=o.telegram_id
 WHERE o.order_id=? LIMIT 1`;
const SOURCE_FIELDS = ['order_id','buyer_telegram_id','buyer_plan_code','amount_stars','currency','order_state','billing_mode',
  'order_paid_at','applied_at','access_seconds','metadata_plan_code','metadata_telegram_id','package_code','metadata_period_seconds',
  'metadata_amount_stars','metadata_currency','metadata_billing_mode','source_package_period_id','period_order_id','period_telegram_id',
  'period_plan_code','period_billing_mode','starts_at','ends_at','period_seconds','period_recorded_at','source_payment_ledger_entry_id',
  'payment_order_id','payment_telegram_id','payment_entry_type','payment_direction','payment_currency','payment_amount_stars','paid_at',
  'payment_recorded_at','telegram_payment_charge_id','related_ledger_entry_id','inviter_telegram_id','inviter_bound_at','first_started_at',
  'has_invitation_cycle','has_compensation','has_legacy_grant','has_earlier_paid_purchase'];
function snapshotSql(sql, fields) {
  const chunks = [];
  for (let i=0; i<fields.length; i+=16) chunks.push('json_object(' + fields.slice(i,i+16)
    .map(key => `'${key}',source.${key}`).join(',') + ')');
  const value = chunks.reduce((left,right) => `json_patch(${left},${right})`);
  return `SELECT ${value} AS snapshot FROM (${sql}) source`;
}
async function capture(db, sql, fields, params) {
  const query = snapshotSql(sql, fields);
  const row = await db.prepare(query).bind(...params).first();
  if (!row) return null;
  if (typeof row.snapshot !== 'string') fail('package_referral_source_unavailable');
  let evidence;
  try { evidence = JSON.parse(row.snapshot); }
  catch (cause) { fail('package_referral_source_unavailable', cause); }
  return { evidence, assertion: { sql:`(${query}) = ?`, params:[...params,row.snapshot] } };
}
function sourceIssue(e, selectedAt, programStartedAt) {
  if (!e) return 'payment_order_not_found';
  if (!PAID_PLANS.has(e.buyer_plan_code)) return 'paid_plan_not_eligible';
  if (e.order_state !== 'applied' || e.billing_mode !== 'prepaid') return 'package_payment_not_applied';
  if (!e.source_payment_ledger_entry_id || e.payment_entry_type !== 'payment' || e.payment_direction !== 'credit' ||
      e.currency !== 'XTR' || e.payment_currency !== 'XTR' || e.payment_order_id !== e.order_id ||
      Number(e.payment_telegram_id) !== Number(e.buyer_telegram_id) ||
      Number(e.payment_amount_stars) !== Number(e.amount_stars) || !Number.isSafeInteger(e.amount_stars) ||
      e.amount_stars < 1 || e.amount_stars > 10000 || !e.telegram_payment_charge_id || e.related_ledger_entry_id != null ||
      e.order_paid_at !== e.paid_at) return 'payment_ledger_evidence_missing';
  if (!e.source_package_period_id || e.period_order_id !== e.order_id ||
      e.period_telegram_id !== e.buyer_telegram_id || e.period_plan_code !== e.buyer_plan_code ||
      e.period_billing_mode !== 'prepaid' || e.metadata_billing_mode !== 'prepaid' ||
      e.metadata_telegram_id !== e.buyer_telegram_id || e.metadata_plan_code !== e.buyer_plan_code ||
      e.metadata_amount_stars !== e.amount_stars || e.metadata_currency !== 'XTR' ||
      e.metadata_period_seconds !== e.period_seconds || e.access_seconds !== e.period_seconds ||
      ![2592000,7776000,15552000,31104000].includes(e.period_seconds) ||
      !Number.isSafeInteger(e.starts_at) || e.starts_at < e.paid_at || e.ends_at !== e.starts_at+e.period_seconds)
    return 'package_period_evidence_missing';
  if (Number(e.has_legacy_grant)===1) return 'package_source_has_legacy_grant';
  if (Number(e.has_compensation) === 1) return 'payment_already_compensated';
  const buyer = telegramId(e.buyer_telegram_id), inviter = telegramId(e.inviter_telegram_id);
  if (!buyer) return 'buyer_identity_invalid';
  if (!inviter || !e.inviter_bound_at) return 'immutable_inviter_missing';
  if (buyer === inviter) return 'self_referral';
  if (Number(e.has_invitation_cycle) === 1) return 'invitation_cycle';
  for (const key of ['first_started_at','inviter_bound_at','paid_at','applied_at','payment_recorded_at','period_recorded_at']) {
    try { requireUnixSeconds(e[key]); } catch { return key === 'first_started_at' ? 'first_start_evidence_missing' : 'payment_time_invalid'; }
  }
  if (e.inviter_bound_at > e.paid_at) return 'inviter_binding_invalid';
  if (e.paid_at < programStartedAt) return 'payment_before_program_start';
  if (e.applied_at < e.paid_at || selectedAt < Math.max(e.applied_at,e.payment_recorded_at,e.period_recorded_at))
    return 'access_application_time_invalid';
  if (!isPaymentInsideEligibilityWindow({firstStartedAt:e.first_started_at,paidAt:e.paid_at}))
    return e.paid_at < e.first_started_at ? 'payment_before_first_start' : 'payment_after_eligibility_window';
  if (Number(e.has_earlier_paid_purchase) === 1) return 'not_first_paid_purchase';
  return null;
}
async function occupiedSlot(db, buyer, inviter) {
  return db.prepare(`SELECT
    (SELECT source_order_id FROM referral_reward_lifetime_slots WHERE program_code=? AND buyer_telegram_id=? LIMIT 1) AS buyer_source_order_id,
    (SELECT source_order_id FROM referral_reward_lifetime_slots WHERE program_code=? AND inviter_telegram_id=? LIMIT 1) AS inviter_source_order_id`)
    .bind(REFERRAL_REWARD_PROGRAM_CODE,buyer,REFERRAL_REWARD_PROGRAM_CODE,inviter).first();
}
async function storedCandidate(db, orderId) {
  return db.prepare(`SELECT c.candidate_id,c.source_order_id,c.confirm_after,r.reward_id,r.reward_status,r.revision,
    j.protection_job_id, EXISTS(SELECT 1 FROM package_referral_transitions t WHERE t.reward_id=r.reward_id
      AND t.from_status='none' AND t.to_status='pending' AND t.from_revision=0 AND t.to_revision=1) AS has_initial_transition
    FROM package_referral_candidates c LEFT JOIN package_referral_rewards r ON r.candidate_id=c.candidate_id
    LEFT JOIN package_referral_protection_jobs j ON j.reward_id=r.reward_id
    WHERE c.source_order_id=? LIMIT 1`).bind(orderId).first();
}
function storedResult(row, status) {
  if (!row?.candidate_id || !row.reward_id || !row.protection_job_id || Number(row.has_initial_transition)!==1 || Number(row.revision)<1)
    fail('package_referral_candidate_storage_invariant');
  return result({status,reason:status==='created'?'first_eligible_paid_friend':'candidate_already_recorded',
    orderId:row.source_order_id,candidateId:row.candidate_id,rewardId:row.reward_id,rewardStatus:row.reward_status,
    confirmAfter:Number(row.confirm_after)});
}
async function guardedBatch(db, assertions, effects) {
  const key = 'v144r_'+crypto.randomUUID().replaceAll('-','');
  const guards = assertions.map((proof,i) => db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
    VALUES(?,CASE WHEN (${proof.sql}) THEN 1 ELSE 0 END)`).bind(key+':'+i,...proof.params));
  const cleanup = db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key LIKE ?').bind(key+':%');
  const responses = await db.batch([...guards,...effects,cleanup]);
  if (!Array.isArray(responses) || responses.length!==guards.length+effects.length+1 || responses.some(row=>row?.success!==true))
    fail('package_referral_atomic_persistence_unconfirmed');
  return responses.slice(guards.length,-1);
}

export async function createPackageReferralRewardCandidate(env, {orderId,selectedAt=now()}={}) {
  const id=uuid(orderId,'package_referral_order_id_invalid'),at=clock(selectedAt),config=readReferralRewardConfig(env);
  if (!config.candidateWritesEnabled) return result({status:'disabled',reason:config.configurationProblems[0]||'referral_candidates_disabled',orderId:id});
  const db=database(env),schema=await inspectPackageReferralSchema(db,{required:true});
  const prior=await storedCandidate(db,id);
  if (prior) return storedResult(prior,'duplicate');
  const captured=await capture(db,SOURCE_SQL,SOURCE_FIELDS,[id]),e=captured?.evidence;
  const issue=sourceIssue(e,at,config.programStartedAt);
  if (issue) return result({status:'ineligible',reason:issue,orderId:id});
  // The beneficiary, rather than the paying friend, is the rollout subject.
  const rollout=getReferralRewardRolloutDecision(env,e.inviter_telegram_id);
  if (!rollout.eligible) return result({status:'ineligible',reason:rollout.reason,orderId:id});
  const slots=await occupiedSlot(db,e.buyer_telegram_id,e.inviter_telegram_id);
  if (slots?.buyer_source_order_id) return result({status:'ineligible',reason:'buyer_reward_already_used',orderId:id});
  if (slots?.inviter_source_order_id) return result({status:'ineligible',reason:'inviter_reward_already_used',orderId:id});
  const candidateId=crypto.randomUUID(),rewardId=crypto.randomUUID(),jobId=crypto.randomUUID();
  const confirmAfter=rewardConfirmationTime(e.paid_at);
  try {
    await guardedBatch(db,[packageReferralSchemaAssertion(schema),captured.assertion],[
      db.prepare(`INSERT INTO package_referral_candidates(candidate_id,candidate_key,program_code,buyer_telegram_id,
        inviter_telegram_id,source_order_id,source_payment_ledger_entry_id,source_package_period_id,buyer_plan_code,amount_stars,
        first_started_at,inviter_bound_at,paid_at,eligible_until,confirm_after,selected_at,selection_reason,schema_version,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'first_eligible_paid_friend',1,?)`).bind(candidateId,
        `package-candidate:${REFERRAL_REWARD_PROGRAM_CODE}:${id}`,REFERRAL_REWARD_PROGRAM_CODE,e.buyer_telegram_id,
        e.inviter_telegram_id,id,e.source_payment_ledger_entry_id,e.source_package_period_id,e.buyer_plan_code,e.amount_stars,
        e.first_started_at,e.inviter_bound_at,e.paid_at,paymentEligibilityDeadline(e.first_started_at),confirmAfter,at,at),
      db.prepare(`INSERT INTO package_referral_rewards(reward_id,reward_key,candidate_id,program_code,beneficiary_telegram_id,
        buyer_telegram_id,reward_seconds,reward_status,confirm_after,confirmed_at,cancelled_at,last_transition_id,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'pending',?,NULL,NULL,NULL,1,?,?)`).bind(rewardId,
        `package-reward:${REFERRAL_REWARD_PROGRAM_CODE}:${id}`,candidateId,REFERRAL_REWARD_PROGRAM_CODE,e.inviter_telegram_id,
        e.buyer_telegram_id,REFERRAL_REWARD_SECONDS.bonusAccess,confirmAfter,at,at),
      db.prepare(`INSERT INTO package_referral_protection_jobs(protection_job_id,job_key,reward_id,candidate_id,workflow_instance_id,
        workflow_state,scheduled_for,start_attempt_count,last_attempt_at,started_at,completed_at,settlement_outcome,
        settled_transition_id,last_reconciliation_run_id,last_error_code,created_at,updated_at)
        VALUES(?,?,?,?,?,'pending',?,0,NULL,NULL,NULL,'',NULL,NULL,'',?,?)`).bind(jobId,
        `package-protection-job:${rewardId}`,rewardId,candidateId,`package-referral-protection-${rewardId}`,confirmAfter,at,at),
    ]);
  } catch (cause) {
    const raced=await storedCandidate(db,id);
    if (raced) return storedResult(raced,'duplicate');
    const occupied=await occupiedSlot(db,e.buyer_telegram_id,e.inviter_telegram_id);
    if (occupied?.buyer_source_order_id) return result({status:'ineligible',reason:'buyer_reward_already_used',orderId:id});
    if (occupied?.inviter_source_order_id) return result({status:'ineligible',reason:'inviter_reward_already_used',orderId:id});
    const fresh=await capture(db,SOURCE_SQL,SOURCE_FIELDS,[id]);
    if (sourceIssue(fresh?.evidence,at,config.programStartedAt)) return result({status:'manual_review',reason:'package_referral_source_changed',orderId:id});
    fail('package_referral_candidate_persistence_failed',cause);
  }
  const stored=await storedCandidate(db,id);
  if (stored?.candidate_id!==candidateId) fail('package_referral_candidate_storage_invariant');
  return storedResult(stored,'created');
}

const REWARD_SQL=`SELECT r.reward_id,r.candidate_id,r.reward_status,r.confirm_after,r.confirmed_at,r.cancelled_at,
  r.last_transition_id,r.revision,r.created_at,r.updated_at,r.beneficiary_telegram_id,r.buyer_telegram_id,r.reward_seconds,
  c.source_order_id,c.source_payment_ledger_entry_id,c.source_package_period_id,c.buyer_plan_code,c.amount_stars,
  c.paid_at,c.inviter_telegram_id,c.first_started_at,c.inviter_bound_at,c.eligible_until,c.selected_at,
  check_row.protection_check_id,check_row.decision AS check_decision,check_row.reward_revision AS check_revision,
  check_row.reconciliation_run_id,check_row.reconciliation_item_id,check_row.compensation_ledger_entry_id,
  check_row.checked_at AS check_checked_at,
  t.from_status AS transition_from_status,t.to_status AS transition_to_status,
  t.from_revision AS transition_from_revision,t.to_revision AS transition_to_revision
 FROM package_referral_rewards r JOIN package_referral_candidates c ON c.candidate_id=r.candidate_id
 LEFT JOIN package_referral_protection_checks check_row ON check_row.transition_id=r.last_transition_id
 LEFT JOIN package_referral_transitions t ON t.transition_id=r.last_transition_id
 WHERE r.reward_id=? LIMIT 1`;
const REWARD_FIELDS=['reward_id','candidate_id','reward_status','confirm_after','confirmed_at','cancelled_at','last_transition_id',
  'revision','created_at','updated_at','beneficiary_telegram_id','buyer_telegram_id','reward_seconds','source_order_id',
  'source_payment_ledger_entry_id','source_package_period_id','buyer_plan_code','amount_stars','paid_at','inviter_telegram_id',
  'first_started_at','inviter_bound_at','eligible_until','selected_at','protection_check_id','check_decision','check_revision',
  'reconciliation_run_id','reconciliation_item_id','compensation_ledger_entry_id','check_checked_at','transition_from_status',
  'transition_to_status','transition_from_revision','transition_to_revision'];
const COMPENSATION_SQL=`SELECT ledger_entry_id,related_ledger_entry_id,entry_type,direction,currency,order_id,telegram_id,
  amount_stars,telegram_payment_charge_id,occurred_at,recorded_at FROM payment_ledger
 WHERE related_ledger_entry_id=? AND entry_type IN ('refund','chargeback')
 ORDER BY recorded_at,CASE entry_type WHEN 'chargeback' THEN 0 ELSE 1 END,ledger_entry_id LIMIT 1`;
const COMPENSATION_FIELDS=['ledger_entry_id','related_ledger_entry_id','entry_type','direction','currency','order_id','telegram_id',
  'amount_stars','telegram_payment_charge_id','occurred_at','recorded_at'];
const RECHECK_SQL=`SELECT run.run_id,run.status AS run_status,run.started_at AS run_started_at,run.finished_at AS run_finished_at,
  item.item_id,item.observation_side,item.transaction_direction,item.telegram_id,item.amount_stars,item.transaction_date,
  item.local_state,item.order_id,item.ledger_entry_id,item.observed_at,item.transaction_id_sha256
 FROM payment_reconciliation_runs run JOIN payment_reconciliation_items item ON item.run_id=run.run_id
 WHERE item.ledger_entry_id=? AND (? IS NULL OR run.run_id=?)
 ORDER BY run.started_at DESC,item.observed_at DESC,item.item_id LIMIT 1`;
const RECHECK_FIELDS=['run_id','run_status','run_started_at','run_finished_at','item_id','observation_side','transaction_direction',
  'telegram_id','amount_stars','transaction_date','local_state','order_id','ledger_entry_id','observed_at','transaction_id_sha256'];
async function protectionEvidence(db,rewardId) {
  const reward=await capture(db,REWARD_SQL,REWARD_FIELDS,[rewardId]);
  if (!reward) fail('package_referral_reward_not_found');
  const source=await capture(db,SOURCE_SQL,SOURCE_FIELDS,[reward.evidence.source_order_id]);
  const compensation=await capture(db,COMPENSATION_SQL,COMPENSATION_FIELDS,[reward.evidence.source_payment_ledger_entry_id]);
  return {reward:reward.evidence,source:source?.evidence,compensation:compensation?.evidence,
    assertions:[reward.assertion,...(source?[source.assertion]:[]),...(compensation?[compensation.assertion]:[])]};
}
function rewardSourceIssue(e,checkedAt) {
  const r=e.reward,s=e.source;
  // For an already cancelled reward the genuine compensation may supersede
  // source access. Confirmation/delivery require the original period identity.
  if (!s || r.source_order_id!==s.order_id || r.source_payment_ledger_entry_id!==s.source_payment_ledger_entry_id ||
      r.source_package_period_id!==s.source_package_period_id || r.buyer_telegram_id!==s.buyer_telegram_id ||
      r.buyer_plan_code!==s.buyer_plan_code || r.amount_stars!==s.amount_stars || r.paid_at!==s.paid_at ||
      r.beneficiary_telegram_id!==r.inviter_telegram_id || r.inviter_telegram_id!==s.inviter_telegram_id ||
      r.first_started_at!==s.first_started_at || r.inviter_bound_at!==s.inviter_bound_at ||
      r.confirm_after!==rewardConfirmationTime(r.paid_at) || r.eligible_until!==paymentEligibilityDeadline(r.first_started_at) ||
      r.reward_seconds!==REFERRAL_REWARD_SECONDS.bonusAccess) return 'package_referral_source_identity_mismatch';
  const issue=sourceIssue({...s,has_compensation:0},checkedAt,1);
  return issue ? 'package_referral_'+issue : null;
}
function compensationIssue(e,checkedAt) {
  const c=e.compensation,r=e.reward,s=e.source;
  if (!c) return e.source?.has_compensation ? 'package_referral_compensation_evidence_missing' : null;
  if (!['refund','chargeback'].includes(c.entry_type) || c.direction!=='debit' || c.currency!=='XTR' ||
      c.related_ledger_entry_id!==r.source_payment_ledger_entry_id || c.order_id!==r.source_order_id ||
      c.telegram_id!==r.buyer_telegram_id || c.amount_stars!==r.amount_stars ||
      c.telegram_payment_charge_id!==s?.telegram_payment_charge_id || !Number.isSafeInteger(c.occurred_at) ||
      c.occurred_at<r.paid_at || !Number.isSafeInteger(c.recorded_at) || c.recorded_at<c.occurred_at || c.recorded_at>checkedAt)
    return 'package_referral_compensation_evidence_mismatch';
  return null;
}
async function chargeHash(value) {
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  return Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function recheckIssue(e,proof,checkedAt) {
  if (!proof?.run_id || !proof.item_id) return 'package_referral_payment_recheck_missing';
  const r=e.reward,s=e.source;
  if (!['completed','manual_review'].includes(proof.run_status) || !Number.isSafeInteger(proof.run_started_at) ||
      proof.run_started_at<r.confirm_after || !Number.isSafeInteger(proof.run_finished_at) ||
      proof.run_finished_at<proof.run_started_at || proof.run_finished_at>checkedAt ||
      proof.observation_side!=='telegram' || proof.transaction_direction!=='incoming' ||
      !['matched','recovered'].includes(proof.local_state) || proof.ledger_entry_id!==r.source_payment_ledger_entry_id ||
      proof.order_id!==r.source_order_id || proof.telegram_id!==r.buyer_telegram_id || proof.amount_stars!==r.amount_stars ||
      !Number.isSafeInteger(proof.transaction_date) || Math.abs(proof.transaction_date-r.paid_at)>86400 ||
      !Number.isSafeInteger(proof.observed_at) || proof.observed_at<r.confirm_after || proof.observed_at>checkedAt ||
      proof.observed_at<proof.run_started_at || proof.observed_at>proof.run_finished_at ||
      proof.transaction_id_sha256!==await chargeHash(s.telegram_payment_charge_id))
    return 'package_referral_payment_recheck_not_verified';
  return null;
}
function review(e,reason,runId=null) {
  return result({status:'manual_review',reason,rewardId:e.reward.reward_id,confirmAfter:e.reward.confirm_after,reconciliationRunId:runId});
}
function terminal(e,status='already_settled') {
  const r=e.reward;
  if (!['confirmed','cancelled'].includes(r.reward_status) || !r.last_transition_id ||
      r.transition_to_status!==r.reward_status || r.transition_to_revision!==r.revision ||
      !r.protection_check_id || r.check_revision!==r.revision-1) fail('package_referral_terminal_invariant');
  return result({status,rewardId:r.reward_id,outcome:r.reward_status,transitionId:r.last_transition_id,confirmAfter:r.confirm_after});
}

export async function reconcilePackageReferralRewardSourcePayment(env,{rewardId,checkedAt=now(),offsetStart=0}={}, {reconcileTransactions}={}) {
  const id=uuid(rewardId,'package_referral_reward_id_invalid'),at=clock(checkedAt),db=database(env);
  const offset=referralReconciliationOffset(offsetStart);
  await inspectPackageReferralSchema(db,{required:true});
  let e=await protectionEvidence(db,id),issue=compensationIssue(e,at);
  if (issue) return review(e,issue);
  if (e.compensation) return result({status:'compensated',rewardId:id,reason:e.compensation.entry_type,
    compensationLedgerEntryId:e.compensation.ledger_entry_id,checkedAt:at,reconciliationRunId:null});
  if (['confirmed','cancelled'].includes(e.reward.reward_status)) return terminal(e);
  const config=readReferralRewardConfig(env);
  if (!config.confirmationsEnabled) return result({status:'disabled',rewardId:id,reason:'referral_confirmations_disabled'});
  if (at<e.reward.confirm_after) return result({status:'waiting',rewardId:id,confirmAfter:e.reward.confirm_after,
    remainingSeconds:e.reward.confirm_after-at});
  issue=rewardSourceIssue(e,at);
  if (issue) return review(e,issue);
  let proof=await capture(db,RECHECK_SQL,RECHECK_FIELDS,[e.reward.source_payment_ledger_entry_id,null,null]);
  if (!await recheckIssue(e,proof?.evidence,at)) return result({status:'verified',rewardId:id,
    reconciliationRunId:proof.evidence.run_id,reconciliationItemId:proof.evidence.item_id,checkedAt:at,reused:true});
  if (typeof reconcileTransactions!=='function') return review(e,'package_referral_reconciliation_runtime_missing');
  const response=await reconcileTransactions(env,{runSource:'scheduled',startedAt:at,offsetStart:offset,
    targetPaymentLedgerEntryId:e.reward.source_payment_ledger_entry_id});
  const runId=String(response?.runId||'').trim().toLowerCase();
  if (!UUID.test(runId)) fail('package_referral_reconciliation_run_invalid');
  const verifiedAt=Math.max(at,now());
  e=await protectionEvidence(db,id);
  issue=compensationIssue(e,verifiedAt);
  if (issue) return review(e,issue,runId);
  if (e.compensation) return result({status:'compensated',rewardId:id,reason:e.compensation.entry_type,
    compensationLedgerEntryId:e.compensation.ledger_entry_id,checkedAt:verifiedAt,reconciliationRunId:runId});
  if (['confirmed','cancelled'].includes(e.reward.reward_status)) return terminal(e);
  issue=rewardSourceIssue(e,verifiedAt);
  if (issue) return review(e,issue,runId);
  proof=await capture(db,RECHECK_SQL,RECHECK_FIELDS,[e.reward.source_payment_ledger_entry_id,runId,runId]);
  issue=await recheckIssue(e,proof?.evidence,verifiedAt);
  if (issue) {
    if (issue==='package_referral_payment_recheck_missing') {
      const continuation=referralReconciliationContinuation(response,{offsetStart:offset,rewardId:id,checkedAt:verifiedAt});
      if (continuation) return continuation;
    }
    return review(e,issue,runId);
  }
  return result({status:'verified',rewardId:id,reconciliationRunId:runId,reconciliationItemId:proof.evidence.item_id,checkedAt:verifiedAt});
}

async function persistDecision(db,schema,e,at,proof) {
  const r=e.reward,c=e.compensation,cancelling=Boolean(c),transitionId=crypto.randomUUID(),checkId=crypto.randomUUID();
  const decision=cancelling?'cancel':'confirm',toStatus=cancelling?'cancelled':'confirmed';
  await guardedBatch(db,[packageReferralSchemaAssertion(schema),...e.assertions,...(proof?[proof.assertion]:[])],[
    db.prepare(`INSERT INTO package_referral_protection_checks(protection_check_id,check_key,reward_id,candidate_id,reward_revision,
      decision,reason_code,source_payment_ledger_entry_id,source_package_period_id,reconciliation_run_id,reconciliation_item_id,
      compensation_ledger_entry_id,transition_id,checked_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      checkId,`package-protection-check:${r.reward_id}:${r.revision}`,r.reward_id,r.candidate_id,r.revision,decision,
      cancelling?c.entry_type:'hold_elapsed',r.source_payment_ledger_entry_id,r.source_package_period_id,
      cancelling?null:proof.evidence.run_id,cancelling?null:proof.evidence.item_id,cancelling?c.ledger_entry_id:null,transitionId,at,at),
    db.prepare(`INSERT INTO package_referral_transitions(transition_id,transition_key,transition_scope,reward_id,bonus_grant_id,
      from_status,to_status,from_revision,to_revision,reason_code,actor_type,actor_id,related_payment_ledger_entry_id,
      effect_starts_at,effect_ends_at,compensated_seconds,occurred_at,recorded_at)
      VALUES(?,?,'reward',?,NULL,?,?,?,?,?,'workflow',NULL,?,NULL,NULL,0,?,?)`).bind(transitionId,
      `package-protection-transition:${r.reward_id}:${r.revision}`,r.reward_id,r.reward_status,toStatus,r.revision,r.revision+1,
      cancelling?c.entry_type:'hold_elapsed',cancelling?c.ledger_entry_id:r.source_payment_ledger_entry_id,cancelling?c.occurred_at:at,at),
  ]);
  const persisted=await protectionEvidence(db,r.reward_id);
  if (persisted.reward.last_transition_id!==transitionId || persisted.reward.reward_status!==toStatus ||
      persisted.reward.revision!==r.revision+1) fail('package_referral_settlement_invariant');
  return terminal(persisted,'settled');
}

export async function settlePackageReferralRewardProtection(env,{rewardId,reconciliationRunId=null,checkedAt=now()}={}) {
  const id=uuid(rewardId,'package_referral_reward_id_invalid'),at=clock(checkedAt),db=database(env);
  const schema=await inspectPackageReferralSchema(db,{required:true});
  let e=await protectionEvidence(db,id),issue=compensationIssue(e,at);
  if (issue) return review(e,issue,reconciliationRunId);
  if (e.reward.reward_status==='cancelled') return terminal(e);
  if (e.reward.reward_status==='confirmed' && !e.compensation) return terminal(e);
  let proof=null;
  if (!e.compensation) {
    if (!readReferralRewardConfig(env).confirmationsEnabled) return result({status:'disabled',rewardId:id,reason:'referral_confirmations_disabled'});
    const rollout=getReferralRewardRolloutDecision(env,e.reward.beneficiary_telegram_id);
    if (!rollout.eligible) return result({status:'disabled',rewardId:id,reason:rollout.reason});
    if (at<e.reward.confirm_after) return result({status:'waiting',rewardId:id,confirmAfter:e.reward.confirm_after,
      remainingSeconds:e.reward.confirm_after-at});
    issue=rewardSourceIssue(e,at);
    if (issue) return review(e,issue,reconciliationRunId);
    const runId=String(reconciliationRunId||'').trim().toLowerCase();
    if (!UUID.test(runId)) return review(e,'package_referral_payment_recheck_missing');
    proof=await capture(db,RECHECK_SQL,RECHECK_FIELDS,[e.reward.source_payment_ledger_entry_id,runId,runId]);
    issue=await recheckIssue(e,proof?.evidence,at);
    if (issue) return review(e,issue,runId);
  }
  try { return await persistDecision(db,schema,e,at,proof); }
  catch (cause) {
    // A transaction whose response was lost is acknowledged only through its
    // persisted decision. A compensation racing confirmation wins on a fresh
    // revision; an unverified write is never reported as settled.
    e=await protectionEvidence(db,id);
    issue=compensationIssue(e,at);
    if (issue) return review(e,issue,reconciliationRunId);
    if (e.reward.reward_status==='cancelled' || (e.reward.reward_status==='confirmed' && !e.compensation)) return terminal(e);
    if (e.compensation) {
      try { return await persistDecision(db,schema,e,at,null); }
      catch { const raced=await protectionEvidence(db,id); if (raced.reward.reward_status==='cancelled') return terminal(raced); }
    }
    return review(e,'package_referral_settlement_persistence_unconfirmed',reconciliationRunId);
  }
}

export async function applyPackageReferralRewardCompensation(env,{compensationLedgerEntryId,recordedAt=now()}={}) {
  const ledgerId=uuid(compensationLedgerEntryId,'package_referral_compensation_ledger_id_invalid'),at=clock(recordedAt),db=database(env);
  const schema=await inspectPackageReferralSchema(db,{required:false});
  if (!schema.present) return result({status:'not_applicable',compensationLedgerEntryId:ledgerId});
  const row=await db.prepare(`SELECT r.reward_id FROM payment_ledger c JOIN package_referral_candidates candidate
    ON candidate.source_payment_ledger_entry_id=c.related_ledger_entry_id JOIN package_referral_rewards r
    ON r.candidate_id=candidate.candidate_id WHERE c.ledger_entry_id=? AND c.entry_type IN ('refund','chargeback') LIMIT 1`)
    .bind(ledgerId).first();
  if (!row) return result({status:'not_applicable',compensationLedgerEntryId:ledgerId});
  const e=await protectionEvidence(db,row.reward_id);
  const specific=await db.prepare(`SELECT ${COMPENSATION_FIELDS.join(',')} FROM payment_ledger WHERE ledger_entry_id=? LIMIT 1`).bind(ledgerId).first();
  const issue=compensationIssue({...e,compensation:specific},at);
  if (issue || !specific)
    return review(e,issue||'package_referral_compensation_identity_mismatch');
  if (e.reward.reward_status==='cancelled') return result({...terminal(e),compensationLedgerEntryId:ledgerId});
  const settled=await settlePackageReferralRewardProtection(env,{rewardId:row.reward_id,checkedAt:at});
  return result({...settled,compensationLedgerEntryId:ledgerId});
}

const CONFIRM_CHECK_SQL=`SELECT protection_check_id,reconciliation_run_id,reconciliation_item_id,reward_revision,
  checked_at,transition_id FROM package_referral_protection_checks WHERE reward_id=? AND decision='confirm'
  ORDER BY reward_revision LIMIT 1`;
const CONFIRM_CHECK_FIELDS=['protection_check_id','reconciliation_run_id','reconciliation_item_id','reward_revision','checked_at','transition_id'];
export async function readPackageReferralRewardForBonus(env,{rewardId,checkedAt=now()}={}) {
  const id=uuid(rewardId,'package_referral_reward_id_invalid'),at=clock(checkedAt),db=database(env);
  const schema=await inspectPackageReferralSchema(db,{required:true}),e=await protectionEvidence(db,id),r=e.reward;
  let issue=compensationIssue(e,at),confirmation=null,proof=null;
  if (!issue && !e.compensation) issue=rewardSourceIssue(e,at);
  if (!issue && r.confirmed_at!=null) {
    confirmation=await capture(db,CONFIRM_CHECK_SQL,CONFIRM_CHECK_FIELDS,[id]);
    if (!confirmation || confirmation.evidence.checked_at!==r.confirmed_at || r.confirmed_at<r.confirm_after)
      issue='package_referral_confirmation_evidence_missing';
    else {
      const run=confirmation.evidence.reconciliation_run_id;
      proof=await capture(db,RECHECK_SQL,RECHECK_FIELDS,[r.source_payment_ledger_entry_id,run,run]);
      issue=await recheckIssue(e,proof?.evidence,at);
      if (!issue && proof.evidence.item_id!==confirmation.evidence.reconciliation_item_id)
        issue='package_referral_confirmation_evidence_mismatch';
    }
  }
  if (!issue && ['confirmed','cancelled'].includes(r.reward_status)) terminal(e);
  const assertions=[packageReferralSchemaAssertion(schema),...e.assertions,
    ...(confirmation?[confirmation.assertion]:[]),...(proof?[proof.assertion]:[])];
  return Object.freeze({status:issue?'manual_review':e.compensation&&r.reward_status!=='cancelled'?'compensated':r.reward_status,
    reason:issue||null,rewardKind:'package',rewardId:id,beneficiaryTelegramId:r.beneficiary_telegram_id,
    buyerTelegramId:r.buyer_telegram_id,sourceOrderId:r.source_order_id,sourcePaymentLedgerEntryId:r.source_payment_ledger_entry_id,
    sourcePackagePeriodId:r.source_package_period_id,confirmedAt:r.confirmed_at??null,confirmAfter:r.confirm_after,
    compensationLedgerEntryId:e.compensation?.ledger_entry_id||null,compensationType:e.compensation?.entry_type||null,
    compensationOccurredAt:e.compensation?.occurred_at||null,compensationRecordedAt:e.compensation?.recorded_at||null,
    reconciliationRunId:confirmation?.evidence.reconciliation_run_id||null,
    reconciliationItemId:confirmation?.evidence.reconciliation_item_id||null,
    assertions:Object.freeze(assertions.map(p=>Object.freeze({sql:p.sql,params:Object.freeze(p.params)}))),accessApplied:false});
}

const JOB_SQL=`SELECT protection_job_id,reward_id,candidate_id,workflow_instance_id,workflow_state,scheduled_for,
  start_attempt_count,last_attempt_at,started_at,completed_at,settlement_outcome,settled_transition_id,
  last_reconciliation_run_id,last_error_code,created_at,updated_at FROM package_referral_protection_jobs WHERE reward_id=? LIMIT 1`;
async function job(db,rewardId) { return db.prepare(JOB_SQL).bind(rewardId).first(); }
// Workflow routing derives source identity from durable storage. The event's
// optional kind is descriptive only and never grants routing authority.
export async function resolvePackageReferralProtectionIdentity(env,{rewardId}={}) {
  const id=uuid(rewardId,'package_referral_reward_id_invalid'),db=database(env);
  const legacy=await db.prepare('SELECT reward_id FROM referral_rewards WHERE reward_id=? LIMIT 1').bind(id).first();
  const schema=await inspectPackageReferralSchema(db,{required:false});
  if (!schema.present) return legacy?Object.freeze({status:'resolved',rewardKind:'legacy',rewardId:id,accessApplied:false}):null;
  const row=await db.prepare(`SELECT r.reward_id,r.candidate_id,j.protection_job_id,j.candidate_id AS job_candidate_id,
    j.scheduled_for,r.confirm_after FROM package_referral_rewards r LEFT JOIN package_referral_protection_jobs j
    ON j.reward_id=r.reward_id WHERE r.reward_id=? LIMIT 1`).bind(id).first();
  if (legacy&&row) fail('package_referral_reward_identity_collision');
  if (!row) return legacy?Object.freeze({status:'resolved',rewardKind:'legacy',rewardId:id,accessApplied:false}):null;
  if (!row.protection_job_id||row.candidate_id!==row.job_candidate_id||row.confirm_after!==row.scheduled_for)
    fail('package_referral_protection_identity_unconfirmed');
  return result({status:'resolved',rewardId:id,protectionJobId:row.protection_job_id});
}
export async function getPackageReferralProtectionSchedule(env,{rewardId}={}) {
  const id=uuid(rewardId,'package_referral_reward_id_invalid'),db=database(env);
  await inspectPackageReferralSchema(db,{required:true});
  const e=await protectionEvidence(db,id);
  if (['confirmed','cancelled'].includes(e.reward.reward_status)) return terminal(e);
  if (!readReferralRewardConfig(env).confirmationsEnabled) return result({status:'disabled',rewardId:id,reason:'referral_confirmations_disabled'});
  const stored=await job(db,id);
  if (!stored || stored.candidate_id!==e.reward.candidate_id || stored.scheduled_for!==e.reward.confirm_after)
    fail('package_referral_protection_job_invariant');
  return result({status:'scheduled',rewardId:id,candidateId:e.reward.candidate_id,protectionJobId:stored.protection_job_id,
    workflowInstanceId:stored.workflow_instance_id,workflowState:stored.workflow_state,confirmAfter:stored.scheduled_for});
}
async function instanceState(binding,id) {
  if (typeof binding?.get!=='function') return 'unknown';
  try { const instance=await binding.get(id); return typeof instance?.status==='function'?String((await instance.status())?.status||'unknown'):'unknown'; }
  catch { return 'unknown'; }
}
const ACTIVE_STATES=new Set(['queued','running','paused','waiting','waitingForPause']);
async function startJob(db,id,at) {
  await db.prepare(`UPDATE package_referral_protection_jobs SET workflow_state='started',start_attempt_count=start_attempt_count+1,
    last_attempt_at=?,started_at=COALESCE(started_at,?),completed_at=NULL,settlement_outcome='',settled_transition_id=NULL,
    last_reconciliation_run_id=NULL,last_error_code='',updated_at=?
    WHERE reward_id=? AND workflow_state IN ('pending','start_failed','manual_review') AND start_attempt_count<20`)
    .bind(at,at,at,id).run();
  const saved=await job(db,id);
  if (saved?.workflow_state!=='started') fail('package_referral_protection_start_invariant');
  return saved;
}
async function failedJob(db,id,at,reason) {
  const prior=await job(db,id);
  if (prior?.workflow_state==='manual_review') return result({status:'manual_review',reason,rewardId:id});
  await db.prepare(`UPDATE package_referral_protection_jobs SET workflow_state='start_failed',start_attempt_count=start_attempt_count+1,
    last_attempt_at=?,completed_at=NULL,settlement_outcome='',settled_transition_id=NULL,last_reconciliation_run_id=NULL,
    last_error_code=?,updated_at=? WHERE reward_id=? AND workflow_state IN ('pending','start_failed') AND start_attempt_count<20`)
    .bind(at,reason,at,id).run();
  return result({status:'start_failed',reason,rewardId:id});
}
export async function ensurePackageReferralProtectionWorkflow(env,{rewardId,requestedAt=now()}={}) {
  const id=uuid(rewardId,'package_referral_reward_id_invalid'),at=clock(requestedAt),schedule=await getPackageReferralProtectionSchedule(env,{rewardId:id});
  if (schedule.status!=='scheduled') return schedule;
  const db=database(env),stored=await job(db,id),binding=env?.REFERRAL_REWARD_PROTECTION_WORKFLOW;
  if (stored.workflow_state==='completed') return result({status:'completed',rewardId:id,protectionJobId:stored.protection_job_id});
  if (stored.workflow_state==='started') return result({status:'started',reason:'workflow_already_started',rewardId:id,
    protectionJobId:stored.protection_job_id,workflowInstanceId:stored.workflow_instance_id,confirmAfter:stored.scheduled_for});
  if (stored.start_attempt_count>=20) return markPackageReferralProtectionJobManualReview(env,{rewardId:id,
    reason:'workflow_start_attempts_exhausted',recordedAt:at});
  if (typeof binding?.create!=='function') return failedJob(db,id,at,'workflow_binding_missing');
  const state=await instanceState(binding,stored.workflow_instance_id);
  if (ACTIVE_STATES.has(state)) {
    await startJob(db,id,at);
    return result({status:'started',reason:'workflow_instance_recovered',rewardId:id,protectionJobId:stored.protection_job_id,
      workflowInstanceId:stored.workflow_instance_id,confirmAfter:stored.scheduled_for});
  }
  if (['complete','errored','terminated'].includes(state)) return markPackageReferralProtectionJobManualReview(env,
    {rewardId:id,reason:'workflow_instance_'+state,recordedAt:at});
  try { await binding.create({id:stored.workflow_instance_id,params:{rewardId:id,rewardKind:'package'}}); }
  catch {
    const observed=await instanceState(binding,stored.workflow_instance_id);
    if (!ACTIVE_STATES.has(observed)) return failedJob(db,id,at,'workflow_start_unconfirmed');
    await startJob(db,id,at);
    return result({status:'started',reason:'ambiguous_create_recovered',rewardId:id,protectionJobId:stored.protection_job_id,
      workflowInstanceId:stored.workflow_instance_id,confirmAfter:stored.scheduled_for});
  }
  await startJob(db,id,at);
  return result({status:'started',reason:'workflow_instance_created',rewardId:id,protectionJobId:stored.protection_job_id,
    workflowInstanceId:stored.workflow_instance_id,confirmAfter:stored.scheduled_for});
}
export async function completePackageReferralProtectionJob(env,{rewardId,transitionId,outcome,reconciliationRunId=null,completedAt=now()}={}) {
  const id=uuid(rewardId,'package_referral_reward_id_invalid'),tid=uuid(transitionId,'package_referral_transition_id_invalid'),at=clock(completedAt);
  if (!['confirmed','cancelled'].includes(outcome)) fail('package_referral_settlement_outcome_invalid');
  const db=database(env); await inspectPackageReferralSchema(db,{required:true});
  await db.prepare(`UPDATE package_referral_protection_jobs SET workflow_state='completed',completed_at=?,settlement_outcome=?,
    settled_transition_id=?,last_reconciliation_run_id=?,last_error_code='',updated_at=? WHERE reward_id=? AND workflow_state='started'`)
    .bind(at,outcome,tid,reconciliationRunId,at,id).run();
  const stored=await job(db,id);
  if (stored?.workflow_state!=='completed' || stored.settlement_outcome!==outcome || stored.settled_transition_id!==tid)
    fail('package_referral_job_completion_unconfirmed');
  return result({status:'completed',rewardId:id,protectionJobId:stored.protection_job_id,outcome,transitionId:tid});
}
export async function markPackageReferralProtectionJobManualReview(env,{rewardId,reason,reconciliationRunId=null,recordedAt=now()}={}) {
  const id=uuid(rewardId,'package_referral_reward_id_invalid'),at=clock(recordedAt),db=database(env);
  const safe=String(reason||'package_referral_manual_review').toLowerCase().replace(/[^a-z0-9_.-]+/gu,'_').slice(0,64);
  await inspectPackageReferralSchema(db,{required:true});
  await db.prepare(`UPDATE package_referral_protection_jobs SET workflow_state='manual_review',
    start_attempt_count=CASE WHEN start_attempt_count=0 THEN 1 ELSE start_attempt_count END,
    last_attempt_at=COALESCE(last_attempt_at,?),completed_at=?,settlement_outcome='',settled_transition_id=NULL,
    last_reconciliation_run_id=?,last_error_code=?,updated_at=? WHERE reward_id=? AND workflow_state IN ('pending','started','start_failed')`)
    .bind(at,at,reconciliationRunId,safe,at,id).run();
  const saved=await job(db,id);
  if (!saved) fail('package_referral_protection_job_not_found');
  return result({status:saved.workflow_state,rewardId:id,protectionJobId:saved.protection_job_id,reason:saved.last_error_code});
}
export async function repairPackageReferralRewardProtection(env,{limit=25,requestedAt=now()}={}) {
  const at=clock(requestedAt),size=Number(limit),db=database(env);
  if (!Number.isSafeInteger(size)||size<1||size>50) fail('package_referral_repair_limit_invalid');
  const schema=await inspectPackageReferralSchema(db,{required:false});
  if (!schema.present || !readReferralRewardConfig(env).confirmationsEnabled)
    return result({status:'disabled',reason:'referral_confirmations_disabled',results:Object.freeze([])});
  const rows=await db.prepare(`SELECT r.reward_id FROM package_referral_rewards r JOIN package_referral_protection_jobs j ON j.reward_id=r.reward_id
    WHERE r.reward_status='pending' AND j.workflow_state IN ('pending','start_failed','manual_review')
    ORDER BY j.scheduled_for,j.protection_job_id LIMIT ?`).bind(size).all();
  if (rows?.success!==true||!Array.isArray(rows.results)||rows.results.length>size) fail('package_referral_repair_read_unconfirmed');
  const results=[];
  for (const row of rows.results||[]) {
    try { results.push(await ensurePackageReferralProtectionWorkflow(env,{rewardId:row.reward_id,requestedAt:at})); }
    catch { results.push(result({status:'manual_review',rewardId:row.reward_id,reason:'package_referral_workflow_repair_failed'})); }
  }
  return result({status:'repaired',results:Object.freeze(results)});
}
