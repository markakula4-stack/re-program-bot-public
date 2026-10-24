import { readTrustedContext, refreshTrustedContext, compileContextAssertions } from '../v1.4.1/trusted-context.mjs';
import { resolveServiceSubscriptionFinancialFacts } from '../v1.4.1/authority-resolver.mjs';
import { readVerifiedLifecycleFacts } from './lifecycle-authority.mjs';
import { projectVerifiedSubscriptionLifecycle } from './lifecycle-engine.mjs';
import { callStarsTelegram } from '../v1.3.6/stars-payment-runtime.mjs';

export const PAID_NOTIFICATION_VERSION='2026-10-04.v1.4.3.confirmed-refund';
export const PAID_NOTIFICATION_WARNING_SECONDS=86400;
const UNKNOWN_AFTER_SECONDS=300;
const intents=new WeakMap();
const positive=value=>Number.isSafeInteger(value)&&value>0;
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const sha=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))]
  .map(byte=>byte.toString(16).padStart(2,'0')).join('');
const safeReason=error=>String(error?.code||'paid_notification_outcome_unknown').toLowerCase().replace(/[^a-z0-9_.-]/gu,'_').slice(0,64);
const service=context=>{
  const identity=readTrustedContext(context);
  if(identity.actorKind!=='service'||identity.purpose!=='historical_notification'||
    identity.operation!=='service.notification.deliver_historical'||identity.executorPurpose!=='notification_deliver_historical')
    fail('paid_notification_service_required',403);
  return identity;
};
async function rows(db,sql,params=[],maximum=1) {
  const result=await db.prepare(sql).bind(...params).all();
  if(result?.success!==true||!Array.isArray(result.results)||result.results.length>maximum)fail('paid_notification_read_unverified',503);
  return result.results;
}
async function captured(db,table,columns,where,params,proofs,maximum=1) {
  const sql=`SELECT COALESCE(json_group_array(json(snapshot)),'[]') snapshot FROM
    (SELECT json_array(${columns.join(',')}) snapshot FROM ${table} WHERE ${where} ORDER BY ${columns[0]} LIMIT ${maximum+1})`;
  const [encoded]=await rows(db,sql,params);
  let raw;try{raw=JSON.parse(encoded?.snapshot);}catch{fail('paid_notification_read_unverified',503);}
  if(!Array.isArray(raw)||raw.length>maximum||raw.some(row=>!Array.isArray(row)||row.length!==columns.length))fail('paid_notification_read_unverified',503);
  proofs.push({sql:`(${sql}) IS ?`,params:[...params,encoded.snapshot]});
  return raw.map(row=>Object.fromEntries(columns.map((column,index)=>[column,row[index]])));
}
function batch(db) {
  const statements=[],key='paid_notice_'+crypto.randomUUID();
  return {assert(sql,params=[]){statements.push(db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
    VALUES(?,CASE WHEN (${sql}) THEN 1 ELSE 0 END)`).bind(key+'_'+statements.length,...params));},
  add(sql,params=[],min=1,max=min){statements.push(db.prepare(sql).bind(...params));statements.push(db.prepare(
    'INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN changes() BETWEEN ? AND ? THEN 1 ELSE 0 END)')
    .bind(key+'_'+statements.length,min,max));},
  async commit(){statements.push(db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key LIKE ?').bind(key+'_%'));
    const result=await db.batch(statements);
    if(!Array.isArray(result)||result.length!==statements.length||result.some(row=>row?.success!==true))fail('paid_notification_commit_unverified',503);
  }};
}
const JOB_COLUMNS=['job_key','subscription_id','telegram_id','event_id','job_type','expected_subscription_revision',
  'expected_period_end','expected_lifecycle_state','status','scheduled_for','attempt_count','delivery_started_at',
  'telegram_message_id','delivery_receipt_sha256','sent_at','last_error_code','revision','created_at','updated_at'];
const EVENT_COLUMNS=['event_id','event_key','contract_id','operation_id','command_id','telegram_id','event_type','source',
  'telegram_update_id','provider_state','from_state','to_state','actor_type','actor_id','reason_code','evidence_sha256',
  'provider_occurred_at','received_at'];
const LEDGER_COLUMNS=['ledger_entry_id','idempotency_key','order_id','telegram_id','entry_type','direction','currency',
  'amount_stars','telegram_payment_charge_id','related_ledger_entry_id','occurred_at','recorded_at'];
const keyFor=(subscriptionId,type,reference)=>`paid:${subscriptionId}:${type}:${reference}`;
const eventKeyFor=(subscriptionId,type,deadline)=>`paid:period:${subscriptionId}:${type}:${deadline}`;
const expectedReference=job=>job.job_key.slice(`paid:${job.subscription_id}:${job.job_type}:`.length);
const recipientRows=async(db,id,proofs)=>{
  const [settings]=await captured(db,'notification_settings',['telegram_id','telegram_enabled'],'telegram_id=?',[id],proofs);
  const privacy=await captured(db,'privacy_deletion_requests',['request_id','telegram_id','status','expires_at'],
    "telegram_id=? AND status='pending' AND unixepoch(expires_at)>unixepoch()",[id],proofs,128);
  return {settings,privacy};
};

function periodDeadline(facts,lifecycle,subscriptionId,now,type) {
  const active=facts.periods.filter(period=>period.subscriptionId===subscriptionId&&period.status==='active');
  if(type==='period_expiring')return lifecycle.paidAccess&&positive(lifecycle.paidUntil)?lifecycle.paidUntil:null;
  const ended=active.filter(period=>period.startsAt<=now&&period.endsAt<=now);
  return lifecycle.state==='expired'&&!lifecycle.paidAccess&&ended.length?Math.max(...ended.map(period=>period.endsAt)):null;
}
function eventCurrent(facts,lifecycle,event,type) {
  if(!event||event.contract_id!==lifecycle.contractId)return false;
  if(type==='renewal_failed')return lifecycle.state==='payment_failed'&&event.event_type==='renewal_failed'&&
    event.source==='telegram_update'&&event.provider_state==='failed'&&!facts.periods.some(period=>period.status==='active'&&
      period.sourceKind==='payment'&&positive(period.occurredAt)&&period.occurredAt>event.received_at&&period.startsAt>=event.received_at);
  if(lifecycle.renewalState!=='canceled'||lifecycle.state!=='cancel_at_period_end')return false;
  if(event.event_type==='provider_control')return event.source==='telegram_update'&&event.provider_state==='canceled';
  const command=facts.commands.find(row=>row.command_id===event.command_id&&row.acknowledgement_event_id===event.event_id);
  const contract=facts.contracts.find(row=>row.contract_id===event.contract_id);
  const acknowledged=facts.commands.filter(row=>row.contract_id===event.contract_id&&row.state==='confirmed'&&
    facts.providerEvents.some(e=>e.event_id===row.acknowledgement_event_id&&e.source==='provider_response'));
  return event.event_type==='command_confirmed'&&event.source==='provider_response'&&event.provider_state===null&&
    command?.state==='confirmed'&&command.action==='cancel_renewal'&&command.desired_auto_renew===0&&
    command.expected_contract_revision===contract?.revision&&command.attempted_count===1&&
    command.attempted_at===Math.max(...acknowledged.map(row=>row.attempted_at));
}

// This outbox is bound to an applied subscription. A retained credit with no
// paid grant has no subscription selector and is intentionally excluded here.
async function confirmedRefund(db,candidate,source,facts,proofs) {
  const [refund]=await captured(db,'payment_ledger',LEDGER_COLUMNS,'ledger_entry_id=?',
    [candidate.refund_ledger_entry_id],proofs);
  if(!refund||refund.entry_type!=='refund'||refund.direction!=='debit'||refund.currency!=='XTR'||
    refund.telegram_id!==source.recipient||!positive(refund.amount_stars)||!positive(refund.occurred_at)||
    !positive(refund.recorded_at)||!refund.related_ledger_entry_id)return null;
  const [original]=await captured(db,'payment_ledger',LEDGER_COLUMNS,'ledger_entry_id=?',
    [refund.related_ledger_entry_id],proofs);
  const [event]=await captured(db,'payment_events',['event_id','event_key','order_id','telegram_id','event_type','outcome'],
    'event_key=?',[refund.idempotency_key+':applied'],proofs);
  const [grant]=await captured(db,'subscription_access_grants',
    ['grant_id','subscription_id','telegram_id','payment_ledger_entry_id','status','compensation_ledger_entry_id'],
    'payment_ledger_entry_id=?',[refund.related_ledger_entry_id],proofs);
  if(!original||original.entry_type!=='payment'||original.direction!=='credit'||original.related_ledger_entry_id!==null||
    original.telegram_id!==source.recipient||original.order_id!==refund.order_id||original.currency!==refund.currency||
    original.amount_stars!==refund.amount_stars||original.telegram_payment_charge_id!==refund.telegram_payment_charge_id||
    refund.idempotency_key!=='refund:'+await sha(refund.telegram_payment_charge_id)||
    event?.event_type!=='refund_confirmed'||event.outcome!=='accepted'||event.telegram_id!==source.recipient||
    event.order_id!==original.order_id||grant?.telegram_id!==source.recipient||grant.subscription_id!==candidate.subscription_id||
    grant.status!=='refunded'||grant.compensation_ledger_entry_id!==refund.ledger_entry_id||
    !facts.periods.some(period=>period.subscriptionId===candidate.subscription_id&&period.ledgerEntryId===original.ledger_entry_id&&
      period.status==='refunded'&&period.compensatedAt===refund.occurred_at))return null;
  return refund;
}

// This is a private fixed family admission. Neither a read DTO, a can flag nor
// a JSON job can mint it. Every refresh calls the real shared financial reader.
async function admit(context,candidate,{job=null}={}) {
  const identity=service(context),source=await resolveServiceSubscriptionFinancialFacts({context,subscriptionId:candidate.subscription_id});
  const facts=readVerifiedLifecycleFacts(source.verifiedFacts),subscription=source.subscription;
  const lifecycle=projectVerifiedSubscriptionLifecycle({verifiedFacts:source.verifiedFacts,nowSec:identity.nowSeconds});
  const proofs=[compileContextAssertions(context),...source.sourceAssertions.assertions];
  const recipient=await recipientRows(identity.db,source.recipient,proofs);
  let event=null;
  if(candidate.event_id) {
    [event]=await captured(identity.db,'subscription_provider_events',EVENT_COLUMNS,'event_id=?',[candidate.event_id],proofs);
    if(event?.telegram_id!==source.recipient)event=null;
  }
  let actualJob=null;
  if(job) {
    [actualJob]=await captured(identity.db,'paid_subscription_notification_jobs',JOB_COLUMNS,'job_key=?',[job.job_key],proofs);
    if(!actualJob||actualJob.telegram_id!==source.recipient||actualJob.subscription_id!==subscription.subscription_id)
      fail('paid_notification_job_subject_mismatch');
  }
  const type=candidate.job_type,periodType=type==='period_expiring'||type==='period_expired',refundType=type==='refund_confirmed';
  if(!['renewal_canceled','renewal_failed','period_expiring','period_expired','refund_confirmed'].includes(type))fail('paid_notification_kind_invalid');
  const refund=refundType?await confirmedRefund(identity.db,candidate,source,facts,proofs):null;
  const deadline=periodType?periodDeadline(facts,lifecycle,subscription.subscription_id,identity.nowSeconds,type):lifecycle.paidUntil;
  const reference=String(refundType?candidate.refund_ledger_entry_id:candidate.period_end);
  let reason='';
  if(source.recipient!==subscription.telegram_id||facts.telegramId!==source.recipient||lifecycle.subscriptionId!==subscription.subscription_id||
    !source.account.financialSourceAvailable||facts.reviewRequired)reason='financial_source_unverified';
  else if(!source.account.exists||!source.account.acceptedTerms||source.account.isBlocked||source.account.pendingDeletion||recipient.privacy.length)
    reason='recipient_unavailable';
  else if(recipient.settings?.telegram_enabled===0)reason='recipient_notifications_disabled';
  else if(refundType&&!refund)reason='refund_confirmation_unverified';
  else if(!refundType&&(['refunded','chargeback','suspended'].includes(lifecycle.state)||!lifecycle.state))reason='paid_lifecycle_not_notifiable';
  else if(periodType&&(!positive(deadline)||String(deadline)!==reference))reason='paid_period_changed';
  else if(type==='period_expiring'&&!(deadline>identity.nowSeconds&&deadline<=identity.nowSeconds+PAID_NOTIFICATION_WARNING_SECONDS))reason='paid_warning_not_due';
  else if(type==='period_expired'&&deadline>identity.nowSeconds)reason='paid_expiry_not_due';
  else if(!periodType&&!refundType&&(!lifecycle.paidAccess||!positive(deadline)||String(deadline)!==reference||!eventCurrent(facts,lifecycle,event,type)))reason='provider_transition_stale';
  if(actualJob&&(actualJob.expected_subscription_revision!==subscription.revision||actualJob.expected_period_end!==subscription.current_period_end||
    actualJob.expected_lifecycle_state!==(lifecycle.state??subscription.status)||actualJob.job_type!==type||actualJob.event_id!==candidate.event_id))reason='paid_notification_source_changed';
  if(!reason&&periodType&&positive(deadline))proofs.push(type==='period_expiring'?{
    sql:'unixepoch()>=? AND unixepoch()<?',params:[deadline-PAID_NOTIFICATION_WARNING_SECONDS,deadline]}:
    {sql:'unixepoch()>=?',params:[deadline]});
  if(!reason&&!periodType&&!refundType&&positive(deadline))proofs.push({sql:'unixepoch()<?',params:[deadline]});
  const token=Object.freeze({version:1,authority:'fixed_paid_lifecycle_notification'});
  intents.set(token,{identity,source,facts,subscription,lifecycle,event,refund,job:actualJob,type,deadline,reference,
    key:keyFor(subscription.subscription_id,type,!periodType&&!refundType&&reason?'stale-'+candidate.event_id:reference),eligible:reason==='',reason,proofs});
  return token;
}
function readIntent(token){if(!intents.has(token))fail('paid_notification_authority_required',403);return intents.get(token);}
const addProof=(b,proof)=>{for(const piece of readIntent(proof).proofs)b.assert(piece.sql,piece.params);};

async function enqueue(token) {
  const intent=readIntent(token),{identity,subscription,lifecycle,type,reference}=intent,b=batch(identity.db);
  addProof(b,token);
  let eventId=intent.event?.event_id??null;
  if(type==='refund_confirmed'&&intent.eligible) {
    const eventKey=`paid:refund:${reference}`,evidence=await sha(JSON.stringify({domain:'v1.4.3.paid-notification-refund.v1',
      subscriptionId:subscription.subscription_id,telegramId:subscription.telegram_id,refundLedgerEntryId:reference}));
    const [prior]=await rows(identity.db,'SELECT event_id,telegram_id,event_type,source,evidence_sha256 FROM subscription_provider_events WHERE event_key=?',[eventKey]);
    if(prior&&(prior.telegram_id!==subscription.telegram_id||prior.event_type!=='review_observed'||prior.source!=='system'||prior.evidence_sha256!==evidence))
      fail('paid_notification_refund_identity_conflict');
    eventId=prior?.event_id??crypto.randomUUID();
    b.add(`INSERT INTO subscription_provider_events(event_id,event_key,telegram_id,event_type,source,actor_type,reason_code,evidence_sha256,received_at)
      VALUES(?,?,?,'review_observed','system','system','paid_notification_refund_confirmed',?,?) ON CONFLICT(event_key) DO NOTHING`,
      [eventId,eventKey,subscription.telegram_id,evidence,identity.nowSeconds],0,1);
    b.assert('EXISTS(SELECT 1 FROM subscription_provider_events WHERE event_id=? AND event_key=? AND telegram_id=? AND evidence_sha256=?)',
      [eventId,eventKey,subscription.telegram_id,evidence]);
  }
  if(['period_expiring','period_expired'].includes(type)) {
    const eventKey=eventKeyFor(subscription.subscription_id,type,reference);
    const evidence=await sha(JSON.stringify({domain:'v1.4.3.paid-notification-period.v1',
      subscriptionId:subscription.subscription_id,telegramId:subscription.telegram_id,type,deadline:Number(reference)}));
    const [prior]=await rows(identity.db,'SELECT event_id,telegram_id,event_type,source,evidence_sha256 FROM subscription_provider_events WHERE event_key=?',[eventKey]);
    const anchorType=intent.eligible?'lifecycle_transition':'review_observed';
    if(prior&&(prior.telegram_id!==subscription.telegram_id||!['lifecycle_transition','review_observed'].includes(prior.event_type)||prior.source!=='system'||prior.evidence_sha256!==evidence))
      fail('paid_notification_period_identity_conflict');
    eventId=prior?.event_id??crypto.randomUUID();
    b.add(`INSERT INTO subscription_provider_events(event_id,event_key,contract_id,telegram_id,event_type,source,to_state,
      actor_type,reason_code,evidence_sha256,received_at) VALUES(?,?,?,?,?,'system',?,'system',?,?,?)
      ON CONFLICT(event_key) DO NOTHING`,[eventId,eventKey,lifecycle.contractId,subscription.telegram_id,
      anchorType,intent.eligible?lifecycle.state:null,'paid_notification_period_observed',evidence,identity.nowSeconds],0,1);
    b.assert('EXISTS(SELECT 1 FROM subscription_provider_events WHERE event_id=? AND event_key=? AND telegram_id=? AND evidence_sha256=?)',
      [eventId,eventKey,subscription.telegram_id,evidence]);
  }
  b.add(`INSERT INTO paid_subscription_notification_jobs(job_key,subscription_id,telegram_id,event_id,job_type,
    expected_subscription_revision,expected_period_end,expected_lifecycle_state,scheduled_for,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,[intent.key,subscription.subscription_id,subscription.telegram_id,eventId,type,
    subscription.revision,subscription.current_period_end,lifecycle.state??subscription.status,identity.nowSeconds,identity.nowSeconds,identity.nowSeconds],0,1);
  if(!intent.eligible)b.add(`UPDATE paid_subscription_notification_jobs SET status='suppressed',last_error_code=?,
    revision=revision+1,updated_at=MAX(updated_at,?) WHERE job_key=? AND status='pending' AND attempt_count=0`,
    [intent.reason,identity.nowSeconds,intent.key],0,1);
  await b.commit();
}

const CANDIDATES=`WITH RECURSIVE live_spans(subscription_id,ends_at) AS (
  SELECT subscription_id,MAX(ends_at) FROM subscription_access_grants
    WHERE status='active' AND starts_at<=? AND ends_at>? GROUP BY subscription_id
  UNION SELECT span.subscription_id,grant_record.ends_at FROM live_spans span
    JOIN subscription_access_grants grant_record ON grant_record.subscription_id=span.subscription_id
    AND grant_record.status='active' AND grant_record.starts_at<=span.ends_at AND grant_record.ends_at>span.ends_at
), deadlines AS (
  SELECT s.subscription_id,s.telegram_id,COALESCE((SELECT MAX(ends_at) FROM live_spans span WHERE span.subscription_id=s.subscription_id),
    (SELECT MAX(ends_at) FROM subscription_access_grants g WHERE g.subscription_id=s.subscription_id AND g.status='active' AND g.ends_at<=?)) period_end
  FROM subscriptions s
), candidates AS (
  SELECT subscription_id,'period_expiring' job_type,NULL event_id,period_end,period_end priority FROM deadlines d
    WHERE period_end>? AND period_end<=? AND NOT EXISTS(SELECT 1 FROM paid_subscription_notification_jobs job
      WHERE job.job_key='paid:'||d.subscription_id||':period_expiring:'||d.period_end)
  UNION ALL SELECT subscription_id,'period_expired',NULL,period_end,period_end FROM deadlines d WHERE period_end<=?
    AND NOT EXISTS(SELECT 1 FROM paid_subscription_notification_jobs job WHERE job.job_key='paid:'||d.subscription_id||':period_expired:'||d.period_end)
  UNION ALL SELECT s.subscription_id,'renewal_canceled',e.event_id,d.period_end,e.received_at FROM subscriptions s
    JOIN deadlines d ON d.subscription_id=s.subscription_id
    JOIN subscription_billing_contracts contract ON contract.telegram_id=s.telegram_id AND contract.retired_at IS NULL
      AND (contract.origin_order_id=s.source_order_id OR EXISTS(SELECT 1 FROM subscription_payment_links source_link
        WHERE source_link.contract_id=contract.contract_id AND source_link.applied_order_id=s.source_order_id AND source_link.direction='incoming'))
    JOIN subscription_provider_events e ON e.telegram_id=s.telegram_id AND e.contract_id=contract.contract_id
    LEFT JOIN subscription_provider_commands command ON command.command_id=e.command_id
    WHERE ((e.event_type='provider_control' AND e.provider_state='canceled' AND e.source='telegram_update') OR
      (e.event_type='command_confirmed' AND e.source='provider_response' AND command.state='confirmed' AND command.desired_auto_renew=0))
    AND d.period_end IS NOT NULL AND NOT EXISTS(SELECT 1 FROM paid_subscription_notification_jobs job WHERE job.job_key='paid:'||s.subscription_id||':renewal_canceled:'||d.period_end)
    AND NOT EXISTS(SELECT 1 FROM paid_subscription_notification_jobs job WHERE job.job_key='paid:'||s.subscription_id||':renewal_canceled:stale-'||e.event_id)
  UNION ALL SELECT s.subscription_id,'renewal_failed',e.event_id,d.period_end,e.received_at FROM subscriptions s
    JOIN deadlines d ON d.subscription_id=s.subscription_id
    JOIN subscription_billing_contracts contract ON contract.telegram_id=s.telegram_id AND contract.retired_at IS NULL
      AND (contract.origin_order_id=s.source_order_id OR EXISTS(SELECT 1 FROM subscription_payment_links source_link
        WHERE source_link.contract_id=contract.contract_id AND source_link.applied_order_id=s.source_order_id AND source_link.direction='incoming'))
    JOIN subscription_provider_events e ON e.telegram_id=s.telegram_id AND e.contract_id=contract.contract_id
    WHERE e.event_type='renewal_failed' AND e.source='telegram_update'
    AND d.period_end IS NOT NULL AND NOT EXISTS(SELECT 1 FROM paid_subscription_notification_jobs job WHERE job.job_key='paid:'||s.subscription_id||':renewal_failed:'||d.period_end)
    AND NOT EXISTS(SELECT 1 FROM paid_subscription_notification_jobs job WHERE job.job_key='paid:'||s.subscription_id||':renewal_failed:stale-'||e.event_id)
  ) SELECT subscription_id,job_type,event_id,period_end,NULL refund_ledger_entry_id,priority FROM candidates
  UNION ALL SELECT s.subscription_id,'refund_confirmed',NULL,s.current_period_end,refund.ledger_entry_id,refund.recorded_at
    FROM payment_ledger refund JOIN payment_ledger original ON original.ledger_entry_id=refund.related_ledger_entry_id
    JOIN subscription_access_grants grant_record ON grant_record.payment_ledger_entry_id=original.ledger_entry_id
      AND grant_record.compensation_ledger_entry_id=refund.ledger_entry_id AND grant_record.status='refunded'
    JOIN subscriptions s ON s.subscription_id=grant_record.subscription_id AND s.telegram_id=refund.telegram_id
    JOIN payment_events confirmation ON confirmation.event_key=refund.idempotency_key||':applied'
      AND confirmation.event_type='refund_confirmed' AND confirmation.outcome='accepted'
      AND confirmation.telegram_id=refund.telegram_id AND confirmation.order_id=refund.order_id
    WHERE refund.entry_type='refund' AND refund.direction='debit' AND refund.currency='XTR'
      AND original.entry_type='payment' AND original.direction='credit' AND original.telegram_id=refund.telegram_id
      AND NOT EXISTS(SELECT 1 FROM paid_subscription_notification_jobs job
        WHERE job.job_key='paid:'||s.subscription_id||':refund_confirmed:'||refund.ledger_entry_id)
    ORDER BY priority,subscription_id,job_type,event_id LIMIT ?`;

async function suppress(token,code) {
  const intent=readIntent(token),b=batch(intent.identity.db);addProof(b,token);
  b.add(`UPDATE paid_subscription_notification_jobs SET status='suppressed',last_error_code=?,revision=revision+1,
    updated_at=MAX(updated_at,?) WHERE job_key=? AND revision=? AND status IN ('pending','processing')`,
    [code,intent.identity.nowSeconds,intent.job.job_key,intent.job.revision]);await b.commit();
}
function message(intent) {
  if(intent.type==='refund_confirmed')return `Возврат платежа подтверждён. Возвращено ${intent.refund.amount_stars} Telegram Stars. Текущее состояние подписки доступно в кабинете.`;
  const until=new Date(intent.deadline*1000).toISOString().slice(0,16).replace('T',' ')+' UTC';
  if(intent.type==='renewal_canceled')return `Автопродление отменено. Оплаченный доступ сохранён до ${until}.`;
  if(intent.type==='renewal_failed')return `Telegram сообщил об ошибке продления. Оплаченный доступ сохранён до ${until}. Проверьте состояние подписки в кабинете.`;
  if(intent.type==='period_expiring')return `Оплаченный период заканчивается ${until}. Проверьте состояние продления в кабинете.`;
  return `Оплаченный период завершился ${until}. Текущее состояние подписки доступно в кабинете.`;
}
async function settle(identity,job,state,{messageId=null,receipt=null,errorCode=''}={}) {
  const b=batch(identity.db);b.assert(compileContextAssertions(identity.context).sql,compileContextAssertions(identity.context).params);
  b.add(`UPDATE paid_subscription_notification_jobs SET status=?,telegram_message_id=?,delivery_receipt_sha256=?,sent_at=?,
    last_error_code=?,revision=revision+1,updated_at=MAX(updated_at,?) WHERE job_key=? AND telegram_id=? AND status='processing'
    AND attempt_count=1 AND delivery_started_at=?`,[state,messageId,receipt,state==='sent'?identity.nowSeconds:null,errorCode,
    identity.nowSeconds,job.job_key,job.telegram_id,job.delivery_started_at]);await b.commit();
}

async function deliver(context,job,fetchImpl) {
  const candidate={subscription_id:job.subscription_id,job_type:job.job_type,event_id:job.event_id,
    period_end:job.job_type==='refund_confirmed'?job.expected_period_end:Number(expectedReference(job)),
    refund_ledger_entry_id:job.job_type==='refund_confirmed'?expectedReference(job):null};
  let token=await admit(await refreshTrustedContext(context),candidate,{job}),intent=readIntent(token);
  if(!intent.eligible){await suppress(token,intent.reason);return 'suppressed';}
  const claim=batch(intent.identity.db);addProof(claim,token);
  claim.add(`UPDATE paid_subscription_notification_jobs SET status='processing',attempt_count=1,delivery_started_at=?,
    revision=revision+1,updated_at=MAX(updated_at,?) WHERE job_key=? AND revision=? AND status='pending' AND attempt_count=0 AND scheduled_for<=?`,
    [intent.identity.nowSeconds,intent.identity.nowSeconds,job.job_key,job.revision,intent.identity.nowSeconds]);
  try{await claim.commit();}catch{return 'not_claimed';}
  const [attempted]=await rows(intent.identity.db,'SELECT * FROM paid_subscription_notification_jobs WHERE job_key=?',[job.job_key]);
  const freshContext=await refreshTrustedContext(context);let at={...service(freshContext),context:freshContext};
  try {
    token=await admit(at.context,candidate,{job:attempted});intent=readIntent(token);
    if(!intent.eligible){await suppress(token,intent.reason);return 'suppressed';}
    const preflight=batch(intent.identity.db);addProof(preflight,token);
    preflight.assert("EXISTS(SELECT 1 FROM paid_subscription_notification_jobs WHERE job_key=? AND revision=? AND status='processing' AND attempt_count=1)",
      [attempted.job_key,attempted.revision]);await preflight.commit();
    const result=await callStarsTelegram(intent.identity.env,'sendMessage',{chat_id:intent.source.recipient,text:message(intent)},
      {fetchImpl:fetchImpl??globalThis.fetch});
    if(!positive(result?.message_id)||result?.chat?.id!==intent.source.recipient)fail('paid_notification_response_invalid');
    await settle({...intent.identity,context:at.context},attempted,'sent',{messageId:result.message_id,
      receipt:await sha(JSON.stringify({jobKey:attempted.job_key,telegramId:intent.source.recipient,messageId:result.message_id}))});
    return 'sent';
  }catch(error) {
    const [current]=await rows(at.db,'SELECT * FROM paid_subscription_notification_jobs WHERE job_key=?',[job.job_key]);
    if(current?.status==='sent')return 'sent';
    const state=error?.ambiguous===false?(error.telegramErrorCode===403?'suppressed':'failed'):'unknown';
    try{await settle(at,attempted,state,{errorCode:safeReason(error)});}catch{}
    return state;
  }
}

// The installed cron passes a fixed genuine service context, never a user ID,
// purpose string, a read authorization, paid DTO or an arbitrary job intent.
export async function runPaidSubscriptionNotifications(context,{fetchImpl,limit=20}={}) {
  let identity=service(context);
  if(!Number.isSafeInteger(limit)||limit<1||limit>50)fail('paid_notification_limit_invalid',400);
  if(identity.env.STARS_PAID_NOTIFICATIONS_ENABLED!=='true')return Object.freeze({version:PAID_NOTIFICATION_VERSION,enabled:false,planned:0,sent:0});
  const counters={version:PAID_NOTIFICATION_VERSION,enabled:true,planned:0,sent:0,suppressed:0,unknown:0,failed:0,not_claimed:0,errors:0};
  const stale=await rows(identity.db,`SELECT * FROM paid_subscription_notification_jobs WHERE status='processing' AND attempt_count=1
    AND delivery_started_at<=? ORDER BY delivery_started_at,job_key LIMIT ?`,[identity.nowSeconds-UNKNOWN_AFTER_SECONDS,limit],limit);
  for(const job of stale) {
    const fresh=await refreshTrustedContext(context),at={...service(fresh),context:fresh};
    try{await settle(at,job,'unknown',{errorCode:'delivery_attempt_interrupted'});counters.unknown++;}catch{counters.errors++;}
  }
  const candidates=await rows(identity.db,CANDIDATES,[identity.nowSeconds,identity.nowSeconds,identity.nowSeconds,identity.nowSeconds,
    identity.nowSeconds+PAID_NOTIFICATION_WARNING_SECONDS,identity.nowSeconds,limit],limit);
  for(const candidate of candidates) {
    try{await enqueue(await admit(await refreshTrustedContext(context),candidate));counters.planned++;}catch{counters.errors++;}
  }
  const due=await rows(identity.db,"SELECT * FROM paid_subscription_notification_jobs WHERE status='pending' AND scheduled_for<=? ORDER BY scheduled_for,job_key LIMIT ?",
    [identity.nowSeconds,limit],limit);
  for(const job of due)try{const state=await deliver(context,job,fetchImpl);counters[state]++;}catch{counters.errors++;}
  return Object.freeze(counters);
}
