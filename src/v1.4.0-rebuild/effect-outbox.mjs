import { readCabinetOwnerGate } from './cabinet-http.mjs';
import { budgetBinding, makeQueryBudget } from './storage-factory.mjs';
import {releaseLeaseFence,assertReleaseLease} from './release-lease.mjs';
import { adaptAnalyticsSourceRecord } from '../v1.3.9/analytics-ingestion.mjs';
import { createD1LegacyContextStore } from '../v1.3.9/legacy-backfill.mjs';
import { buildAnalyticsEventContext } from '../v1.3.9/event-context.mjs';
import { prepareOutboxServiceFence } from '../v1.4.1/service-runtime.mjs';
import { readCabinetAdminGate, canonicalCabinetOwnerId } from './cabinet-participants.mjs';
import { releaseAdminFence } from './release-lease.mjs';

const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const suffix=kind=>kind==='analytics_adapter'?':analytics':null;
const textFor=event=>({pending:'Заявка отправлена на проверку.',confirmed:'Заявка подтверждена.',
  rejected:'Заявка отклонена.',paid:'Выплата по заявке отмечена.'}[event.status_to]);
async function analytics(db,env,row,now) {
  const settings=await db.prepare('SELECT master_enabled,ingest_enabled,rollout_mode,pseudonym_key_version FROM analytics_v2_settings WHERE id=1').first();
  if (settings?.master_enabled!==1||settings.ingest_enabled!==1||settings.rollout_mode!=='admin_shadow') return false;
  const version=settings.pseudonym_key_version;
  let keys={};try{keys=JSON.parse(env.ANALYTICS_SUBJECT_PSEUDONYM_KEYS_JSON??'{}');}catch{return false;}
  const secret=version===1?env.ANALYTICS_SUBJECT_PSEUDONYM_SECRET:keys[String(version)];
  if (!Number.isSafeInteger(version)||version<1||version>8||typeof secret!=='string'||secret.length<32) return false;
  const lead=await db.prepare(`SELECT l.*,COALESCE(a.first_source_code,'direct') AS source_code,
      p.telegram_id AS owner_telegram_id FROM lead_requests l
      JOIN users u ON u.telegram_id=l.telegram_id AND u.is_blocked=0
      LEFT JOIN user_attribution a ON a.telegram_id=l.telegram_id
      LEFT JOIN lead_partner_attribution attr ON attr.lead_id=l.id
      LEFT JOIN partner_profiles p ON p.id=attr.partner_profile_id
      WHERE l.id=?`).bind(row.lead_id).first();
  if (!lead) return false;
  const naturalKey=JSON.stringify([lead.telegram_id,lead.offer_code]);
  const adapted=await adaptAnalyticsSourceRecord({sourceKind:'lead',record:{telegramId:lead.telegram_id,
    recordId:naturalKey,recordType:'submitted',occurredAt:lead.created_at,sourceCode:lead.source_code,
    profile:{role:'user',legalProfile:'unknown',plan:'unknown',accessState:'unknown'}},
    eventId:crypto.randomUUID(),recordedAt:now,highWatermarkAt:now,origin:'live',pseudonymSecret:secret,pseudonymKeyVersion:version});
  if (adapted.kind!=='event') return false;
  const context=await buildAnalyticsEventContext({storageRecord:adapted.storageRecord,actorTelegramId:lead.telegram_id,
    ownerScopeKind:lead.owner_telegram_id?'partner':'actor',ownerTelegramId:lead.owner_telegram_id??null,
    correlationIdentity:`lead:${naturalKey}`,offerIdentity:`offers:${lead.offer_code}`,pseudonymSecret:secret});
  const outcome=await createD1LegacyContextStore(db).write(adapted.storageRecord,context);
  if (!['inserted','duplicate'].includes(outcome)) return false;
  // Result transitions update canonical lead totals; they do not fabricate new
  // event names or duplicate the accepted natural-key submission event.
  await db.prepare("UPDATE mini_app_effect_outbox SET status='delivered',delivered_at=unixepoch() WHERE dedupe_key=? AND status='pending'").bind(row.dedupe_key).run();
  return true;
}

async function storeNotice(db,row,gate,serviceFence=null) {
  const payload=JSON.parse(row.payload_json),recipient=payload.recipientTelegramId;
  const key=crypto.randomUUID(),valid=Number.isSafeInteger(recipient)&&recipient>0;
  const allowed=valid?await db.prepare(`SELECT u.telegram_id FROM users u WHERE u.telegram_id=? AND u.is_blocked=0
    AND NOT EXISTS(SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending' AND unixepoch(expires_at)>unixepoch())`).bind(recipient,recipient).first():null;
  // The limited acceptance window never sends to another real account.
  const state=allowed?'stored':'suppressed';
  const message=escape(textFor(row)??'Статус заявки обновлён.');
  await db.batch([
    ...(serviceFence?.before??[]).map(p=>db.prepare(p.sql).bind(...p.params)),
    db.prepare(`INSERT INTO mini_app_effect_claims(dedupe_key,claim_token,delivery_state,recipient_telegram_id)
      SELECT ?,?,CASE WHEN EXISTS(SELECT 1 FROM users WHERE telegram_id=? AND is_blocked=0)
        AND NOT EXISTS(SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending' AND unixepoch(expires_at)>unixepoch())
        THEN ? ELSE 'suppressed' END,? WHERE EXISTS(SELECT 1 FROM mini_app_effect_outbox WHERE dedupe_key=? AND status='pending')
      AND unixepoch()<? ON CONFLICT(dedupe_key) DO NOTHING`).bind(row.dedupe_key,key,recipient??0,recipient??0,state,valid?recipient:null,row.dedupe_key,gate.expiresAt),
    db.prepare(`INSERT INTO notifications(recipient_id,event_type,message_html,action_label,action_callback)
      SELECT ?,'notify_lead_status',?,'Мои заявки','my_leads' WHERE EXISTS
      (SELECT 1 FROM mini_app_effect_claims WHERE dedupe_key=? AND claim_token=? AND delivery_state='stored' AND notification_id IS NULL)
      AND EXISTS(SELECT 1 FROM users WHERE telegram_id=? AND is_blocked=0)
      AND NOT EXISTS(SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending' AND unixepoch(expires_at)>unixepoch())`)
      .bind(recipient??0,message,row.dedupe_key,key,recipient??0,recipient??0),
    db.prepare(`UPDATE mini_app_effect_claims SET notification_id=last_insert_rowid()
      WHERE dedupe_key=? AND claim_token=? AND delivery_state='stored' AND changes()=1`).bind(row.dedupe_key,key),
    db.prepare(`UPDATE mini_app_effect_outbox SET status='delivered',delivered_at=unixepoch()
      WHERE dedupe_key=? AND EXISTS(SELECT 1 FROM mini_app_effect_claims WHERE dedupe_key=?
        AND (notification_id IS NOT NULL OR delivery_state='suppressed'))`).bind(row.dedupe_key,row.dedupe_key),
    ...(serviceFence?.after??[]).map(p=>db.prepare(p.sql).bind(...p.params)),
  ]);
}

async function deliverNotice(db,env,gate,fetchImpl) {
  const central=env.V141_AUTHORIZATION_ENABLED==='true';
  const claimSql=`UPDATE mini_app_effect_claims SET delivery_state='attempted',attempted_at=unixepoch()
    WHERE dedupe_key=(SELECT c.dedupe_key FROM mini_app_effect_claims c
      JOIN users u ON u.telegram_id=c.recipient_telegram_id AND u.is_blocked=0
      LEFT JOIN notification_settings s ON s.telegram_id=u.telegram_id
      WHERE c.delivery_state='stored' AND c.notification_id IS NOT NULL AND c.next_attempt_at<=unixepoch()
        AND c.recipient_telegram_id=? AND COALESCE(s.telegram_enabled,1)=1
        AND NOT EXISTS(SELECT 1 FROM privacy_deletion_requests p WHERE p.telegram_id=u.telegram_id
          AND p.status='pending' AND unixepoch(p.expires_at)>unixepoch())
      ORDER BY c.dedupe_key LIMIT 1) AND delivery_state='stored' AND unixepoch()<?
    RETURNING dedupe_key,notification_id,recipient_telegram_id`;
  let claim;
  if(central) {
    const selected=await db.prepare(`SELECT dedupe_key FROM mini_app_effect_claims
      WHERE delivery_state='stored' AND notification_id IS NOT NULL AND next_attempt_at<=unixepoch()
        AND recipient_telegram_id=? ORDER BY dedupe_key LIMIT 1`).bind(gate.ownerTelegramId).first();
    if(!selected)return;
    const guard=await prepareOutboxServiceFence(env,{kind:'effect_claim',key:selected.dedupe_key});
    const statements=[...guard.before.map(p=>db.prepare(p.sql).bind(...p.params)),
      db.prepare(claimSql).bind(gate.ownerTelegramId,Math.min(gate.expiresAt,guard.validUntil)),
      ...guard.after.map(p=>db.prepare(p.sql).bind(...p.params))];
    const results=await db.batch(statements);
    if(!Array.isArray(results)||results.length!==statements.length||results.some(r=>r?.success!==true))throw new Error('outbox_claim_unknown');
    claim=results[guard.before.length].results?.[0]??null;
  } else claim=await db.prepare(claimSql).bind(gate.ownerTelegramId,gate.expiresAt).first();
  if (!claim) return;
  const notice=await db.prepare('SELECT message_html FROM notifications WHERE id=? AND recipient_id=?').bind(claim.notification_id,claim.recipient_telegram_id).first();
  if (!notice||typeof env.BOT_TOKEN!=='string') return; // Attempt remains unknown; never blind retry.
  let state='unknown',code='delivery_unknown',next=0;
  try {
    const response=await fetchImpl(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,{method:'POST',redirect:'error',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:claim.recipient_telegram_id,text:notice.message_html,parse_mode:'HTML'}),signal:AbortSignal.timeout(8000)});
    const body=await response.json();
    if (response.ok&&body.ok===true&&Number.isSafeInteger(body.result?.message_id)) {state='delivered';code='';}
    else if (response.status===429&&body.ok===false&&Number.isSafeInteger(body.parameters?.retry_after)&&body.parameters.retry_after>0) {
      state='stored';code='rate_limited';next=Math.floor(Date.now()/1000)+Math.min(body.parameters.retry_after,3600);
    } else if ([400,403].includes(response.status)&&body.ok===false) {state='suppressed';code='delivery_rejected';}
  } catch {} // Never log BOT_TOKEN, recipient, raw responses or exceptions.
  await db.prepare("UPDATE mini_app_effect_claims SET delivery_state=?,error_code=?,next_attempt_at=? WHERE dedupe_key=? AND delivery_state='attempted'")
    .bind(state,code,next,claim.dedupe_key).run();
}

export async function drainRebuildOutbox(env,{fetchImpl=fetch,nowSeconds=Math.floor(Date.now()/1000)}={}) {
  const central=env.V141_AUTHORIZATION_ENABLED==='true';
  const adminGate=central?readCabinetAdminGate(env,nowSeconds):null;
  const gate=adminGate?{...adminGate,ownerTelegramId:canonicalCabinetOwnerId(env)}:readCabinetOwnerGate(env,nowSeconds);
  if (!gate||env.REBUILD_V140_EFFECTS_ENABLED!=='true'||env.REBUILD_V140_STORAGE_ENABLED!=='true') return {status:'closed'};
  const budget=central?{limit:160,used:0}:makeQueryBudget(),fence=adminGate?releaseAdminFence(env):releaseLeaseFence(env),db=budgetBinding(env.DB,budget,{fence}).withSession('first-primary');
  await assertReleaseLease(db,fence);
  const row=await db.prepare(`SELECT o.*,e.lead_id,e.status_to,e.operation FROM mini_app_effect_outbox o
    JOIN lead_request_events e ON o.dedupe_key=e.event_key||CASE WHEN o.effect_kind='analytics_adapter'
      THEN ':analytics' WHEN json_extract(o.payload_json,'$.recipientTelegramId')=(SELECT telegram_id FROM lead_requests WHERE id=e.lead_id)
      THEN ':subject' ELSE ':partner' END
    WHERE o.status='pending' ORDER BY CASE o.effect_kind WHEN 'notification' THEN 0 ELSE 1 END,o.created_at,o.dedupe_key LIMIT 1`).first();
  if (row) {
    if (row.effect_kind==='notification') await storeNotice(db,row,gate,
      central?await prepareOutboxServiceFence(env,{kind:'effect_outbox',key:row.dedupe_key}):null);
    else if (!central&&row.effect_kind==='analytics_adapter'&&row.dedupe_key.endsWith(suffix(row.effect_kind))) await analytics(db,env,row,nowSeconds);
  }
  await deliverNotice(db,env,gate,fetchImpl);
  return {status:'processed',queries:budget.used};
}
