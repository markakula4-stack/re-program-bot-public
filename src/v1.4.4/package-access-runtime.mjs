import { verifyStarsInvoicePayload, STARS_MONTH_SECONDS } from '../v1.3.6/stars-core-foundation.mjs';
import { inspectPackageSchema, packageSchemaAssertion } from './package-schema.mjs';
import {PACKAGE_OWNER_TEST_OFFER,normalizeStoredServerPackagePrice} from './package-contract.mjs';
import {isVerifiedProviderInactiveExit} from '../v1.4.1/authority-resolver.mjs';

// Low-level database verification shared by canonical readers. This module
// issues no actor, capability, context or grant authority; only the private
// resolver can bind these recorded facts to its authenticated request brand.
const fail = code => { throw Object.assign(new Error(code), { code }); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const id = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const version = value => typeof value === 'string' && /^[0-9A-Za-z._-]{8,64}$/u.test(value);
const charge = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const CONTRACT_VERSION = '2026-10-06.v1.4.4.p01';
const PACKAGE_CODES = new Map([[STARS_MONTH_SECONDS,'30d'],[3*STARS_MONTH_SECONDS,'3m'],[6*STARS_MONTH_SECONDS,'6m'],[12*STARS_MONTH_SECONDS,'12m']]);
const PRICES = { professional: {'30d':249,'3m':699,'6m':1299,'12m':2299}, dragon: {'30d':499,'3m':1399,'6m':2599,'12m':4499} };
const COLUMNS = {
  subscription_package_periods: 'period_id order_id payment_ledger_entry_id telegram_id plan_code price_id price_version billing_mode starts_at ends_at period_seconds recorded_at transition_id',
  subscription_package_orders: 'order_id telegram_id contract_version plan_code package_code duration_days period_seconds quoted_starts_at quoted_ends_at price_id price_version offer_version campaign_code billing_mode currency amount_stars source_subscription_id source_package_period_id source_paid_until source_revision source_payment_ledger_entry_id source_fingerprint transition_id created_at',
};
function jsonRow(names) {
  const columns = names.split(' '); let expression = "json('{}')";
  for (let index = 0; index < columns.length; index += 15)
    expression = `json_set(${expression},${columns.slice(index,index+15).flatMap(name=>[`'$.${name}'`,name]).join(',')})`;
  return expression;
}

export async function readPackageAccessDatabaseSource({ db, env, telegramId, nowSec, orders, payments, prices, terms } = {}) {
  if (!db?.prepare || !db?.batch || !positive(telegramId) || !positive(nowSec) ||
      [orders,payments,prices,terms].some(rows=>!Array.isArray(rows)||rows.length>128)) fail('package_access_source_invalid');
  const schema = await inspectPackageSchema({prepare:sql=>db.prepare(sql.replace(/^SELECT\s/u,'SELECT ')),batch:statements=>db.batch(statements)});
  const schemaGuard = packageSchemaAssertion(schema);
  // Record the schema predicate in the same captured-read format as ordinary
  // authority sources. Future activation or a missing trigger invalidates it.
  const captures = [{sql:`SELECT (${schemaGuard.sql})`,params:[...schemaGuard.params],snapshot:1}];
  if (!schema.present) return freeze({present:false,periods:[],subscriptions:[],captures});
  const source = {};
  for (const [key,table,where] of [['periods','subscription_package_periods','telegram_id=?'],
    ['metadata','subscription_package_orders','order_id IN (SELECT order_id FROM subscription_package_periods WHERE telegram_id=?)']]) {
    const sql = `SELECT COALESCE(json_group_array(json(snapshot)),'[]') FROM
      (SELECT ${jsonRow(COLUMNS[table])} AS snapshot FROM ${table} WHERE ${where} ORDER BY order_id LIMIT 129)`;
    const params=[telegramId]; let result;
    try { result=await db.prepare(sql).bind(...params).first(); } catch {fail('package_access_source_unavailable');}
    if (!result || Object.keys(result).length!==1) fail('package_access_source_unavailable');
    const snapshot=Object.values(result)[0];
    if (typeof snapshot!=='string'||new TextEncoder().encode(snapshot).length>2_000_000) fail('package_access_source_overflow');
    let rows; try {rows=JSON.parse(snapshot);} catch {fail('package_access_source_invalid');}
    if (!Array.isArray(rows)||rows.length>128||rows.some(row=>!row||typeof row!=='object'||Array.isArray(row))) fail('package_access_source_overflow');
    source[key]=rows; captures.push({sql,params,snapshot});
  }
  const periods=[], subscriptions=[], seenOrders=new Set(), seenPayments=new Set(), seenCharges=new Set();
  for (const period of source.periods) {
    const order=orders.find(row=>row.order_id===period.order_id);
    const metadata=source.metadata.find(row=>row.order_id===period.order_id);
    const price=prices.find(row=>row.price_id===period.price_id);
    const payment=payments.find(row=>row.ledger_entry_id===period.payment_ledger_entry_id);
    const code=PACKAGE_CODES.get(period.period_seconds);let amount=PRICES[period.plan_code]?.[code];
    if (!id(period.period_id)||!id(period.order_id)||period.telegram_id!==telegramId||!order||!metadata||!price||!payment||
        !code||!amount||seenOrders.has(period.order_id)||seenPayments.has(period.payment_ledger_entry_id)||
        seenCharges.has(payment.telegram_payment_charge_id)) fail('package_access_binding_invalid');
    seenOrders.add(period.order_id);seenPayments.add(period.payment_ledger_entry_id);seenCharges.add(payment.telegram_payment_charge_id);
    if(price.price_id===PACKAGE_OWNER_TEST_OFFER.priceId)amount=normalizeStoredServerPackagePrice(price,
      {order,metadata,botId:Number(env?.BOT_TOKEN?.split(':')[0])}).amountStars;
    if (order.telegram_id!==telegramId||metadata.telegram_id!==telegramId||payment.telegram_id!==telegramId||
        metadata.contract_version!==CONTRACT_VERSION||!version(metadata.offer_version)||!digest(metadata.source_fingerprint)||
        metadata.plan_code!==period.plan_code||order.plan_code!==period.plan_code||price.plan_code!==period.plan_code||
        period.price_id!==order.price_id||period.price_id!==metadata.price_id||period.price_id!==price.price_id||
        !positive(period.price_version)||period.price_version!==order.price_version||period.price_version!==metadata.price_version||
        period.price_version!==price.price_version||[period,metadata,order,price].some(row=>row.billing_mode!=='prepaid')||
        [metadata,order,price,payment].some(row=>row.currency!=='XTR'||row.amount_stars!==amount)||
        order.access_seconds!==period.period_seconds||price.access_seconds!==period.period_seconds||
        metadata.period_seconds!==period.period_seconds||metadata.duration_days*86400!==period.period_seconds||
        metadata.package_code!==code||!['approved','retired'].includes(price.publication_state)||
        !positive(price.valid_from)||price.valid_from>order.created_at||price.valid_until!==null&&
          (!positive(price.valid_until)||price.valid_until<=order.created_at)||
        order.terms_revision!==price.terms_revision||!version(order.terms_revision)||
        !terms.some(row=>row.telegram_id===telegramId&&row.acceptance_scope==='stars_purchase'&&
          row.terms_revision===order.terms_revision&&digest(row.evidence_sha256)&&positive(row.accepted_at)&&row.accepted_at<=order.created_at)||
        !['paid','applied','refunded','chargeback'].includes(order.order_state)||!positive(order.state_revision)||
        !positive(order.created_at)||!positive(order.paid_at)||order.paid_at!==payment.occurred_at||
        order.applied_at!==null&&(!positive(order.applied_at)||order.applied_at<order.paid_at||order.applied_at>nowSec)||
        payment.order_id!==order.order_id||payment.entry_type!=='payment'||payment.direction!=='credit'||
        payment.related_ledger_entry_id!==null||payment.reason_code!=='successful_payment'||!charge(payment.telegram_payment_charge_id)||
        !positive(payment.occurred_at)||payment.occurred_at<order.created_at||!positive(payment.recorded_at)||
        payment.occurred_at>payment.recorded_at||payment.recorded_at>nowSec||
        !positive(metadata.created_at)||metadata.created_at<order.created_at||metadata.created_at>payment.occurred_at||
        !positive(metadata.quoted_starts_at)||metadata.quoted_starts_at<metadata.created_at||
        metadata.quoted_ends_at!==metadata.quoted_starts_at+period.period_seconds||
        !positive(period.starts_at)||period.starts_at!==Math.max(metadata.quoted_starts_at,payment.occurred_at)||
        period.ends_at!==period.starts_at+period.period_seconds||!Number.isSafeInteger(period.ends_at)||
        !positive(period.recorded_at)||period.recorded_at<payment.recorded_at||period.recorded_at>nowSec||
        period.transition_id!==metadata.transition_id||metadata.transition_id!==null&&!id(metadata.transition_id)||
        metadata.campaign_code!==null&&(typeof metadata.campaign_code!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(metadata.campaign_code)))
      fail('package_access_evidence_invalid');
    const sourceRefs=[metadata.source_subscription_id,metadata.source_package_period_id];
    if (sourceRefs.every(ref=>ref===null)) {
      if ([metadata.source_paid_until,metadata.source_revision,metadata.source_payment_ledger_entry_id].some(value=>value!==null)) fail('package_access_source_binding_invalid');
    } else if (sourceRefs.filter(ref=>ref!==null).length!==1||!positive(metadata.source_revision)||
      !positive(metadata.source_paid_until)||metadata.source_paid_until<=metadata.created_at||
      metadata.quoted_starts_at!==metadata.source_paid_until||typeof metadata.source_payment_ledger_entry_id!=='string'||
      metadata.source_package_period_id!==null&&(!id(metadata.source_package_period_id)||metadata.source_revision!==1))
      fail('package_access_source_binding_invalid');
    const verified=await verifyStarsInvoicePayload({invoiceSecret:env?.STARS_INVOICE_SECRET,payload:order.invoice_payload,telegramId,priceId:order.price_id});
    if (verified.orderId!==order.order_id) fail('package_access_binding_invalid');
    const reversals=payments.filter(row=>row.related_ledger_entry_id===payment.ledger_entry_id);
    if (reversals.length>1||reversals.some(row=>row.order_id!==order.order_id||row.telegram_id!==telegramId||
        !['refund','chargeback'].includes(row.entry_type)||row.direction!=='debit'||row.currency!=='XTR'||
        row.amount_stars!==payment.amount_stars||row.telegram_payment_charge_id!==payment.telegram_payment_charge_id||
        !positive(row.occurred_at)||row.occurred_at<payment.occurred_at||!positive(row.recorded_at)||
        row.recorded_at<row.occurred_at||row.recorded_at>nowSec)) fail('package_access_compensation_invalid');
    const reversal=reversals[0],status=reversal?.entry_type==='chargeback'?'chargeback':reversal?'refunded':'active';
    if (['refunded','chargeback'].includes(order.order_state)&&order.order_state!==status) fail('package_access_compensation_invalid');
    const subscriptionId='package:'+period.period_id;
    periods.push({subscriptionId,packagePeriodId:period.period_id,orderId:order.order_id,planCode:period.plan_code,
      startsAt:period.starts_at,endsAt:period.ends_at,status,sourceKind:'package_payment',
      ledgerEntryId:payment.ledger_entry_id,chargeId:payment.telegram_payment_charge_id,contractId:null,
      occurredAt:payment.occurred_at,recordedAt:period.recorded_at,compensatedAt:reversal?.occurred_at??null,
      packageCode:code,priceId:price.price_id,priceVersion:price.price_version,offerVersion:metadata.offer_version,
      campaignCode:metadata.campaign_code,amountStars:payment.amount_stars});
    subscriptions.push({subscription_id:subscriptionId,telegram_id:telegramId,plan_code:period.plan_code,billing_mode:'prepaid',
      source_order_id:order.order_id,telegram_payment_charge_id:payment.telegram_payment_charge_id,
      status:status==='active'?'active':status,current_period_start:period.starts_at,current_period_end:period.ends_at,
      auto_renew:0,last_ledger_entry_id:reversal?.ledger_entry_id??payment.ledger_entry_id,revision:1,
      created_at:metadata.created_at,updated_at:period.recorded_at,package_period_id:period.period_id});
  }
  return freeze({present:true,periods,subscriptions,captures,providerInactiveExitReady:schema.providerInactiveExitReady===true});
}

// No dates are shifted or compacted here. Old residual/earned segments already
// have their canonical dates; independently paid package intervals retain theirs.
export function validateUnifiedPackageTimeline({ source, ordinaryPeriods, contracts, commands, providerEvents, providerInactiveExits=[], nowSec } = {}) {
  if (!source||![ordinaryPeriods,contracts,commands,providerEvents,source.periods].every(Array.isArray)||!positive(nowSec))
    fail('package_access_source_invalid');
  const combined=[...ordinaryPeriods,...source.periods],live=combined.filter(row=>row.status==='active');
  if (combined.length>128) fail('package_access_source_overflow');
  for (const period of source.periods) {
    if (ordinaryPeriods.some(row=>row.ledgerEntryId===period.ledgerEntryId||row.chargeId===period.chargeId)) fail('package_access_duplicate_source');
    if (period.status!=='active') continue;
    if (live.some(row=>row!==period&&row.startsAt<period.endsAt&&period.startsAt<row.endsAt)) fail('package_access_overlap');
    // A pre-existing recurring contract must have its exact provider ACK before
    // this package payment. A later newly consented monthly contract is separate.
    for (const contract of contracts.filter(row=>row.retired_at===null&&row.created_at<=period.occurredAt)) {
      if(providerInactiveExits.some(proof=>isVerifiedProviderInactiveExit(proof,contract,period.recordedAt,true)))continue;
      const valid=commands.filter(cmd=>cmd.contract_id===contract.contract_id&&cmd.telegram_id===contract.telegram_id&&
        cmd.action==='cancel_renewal'&&cmd.desired_auto_renew===0&&cmd.state==='confirmed'&&cmd.attempted_count===1&&
        positive(cmd.expected_contract_revision)&&cmd.expected_contract_revision<=contract.revision&&cmd.first_payment_ledger_entry_id===contract.first_payment_ledger_entry_id&&
        positive(cmd.attempted_at)&&cmd.attempted_at<=period.recordedAt&&providerEvents.some(ack=>ack.event_id===cmd.acknowledgement_event_id&&
          ack.command_id===cmd.command_id&&ack.contract_id===contract.contract_id&&ack.event_type==='command_confirmed'&&
          ack.source==='provider_response'&&ack.received_at<=period.recordedAt));
      if (!valid.some(cmd=>!commands.some(other=>other.contract_id===contract.contract_id&&
          (other.created_at<=period.recordedAt&&['admitted','attempted','unknown'].includes(other.state)||other.command_id!==cmd.command_id&&
            other.state==='confirmed'&&other.attempted_at>=cmd.attempted_at&&other.attempted_at<=period.recordedAt))&&
        !providerEvents.some(event=>event.contract_id===contract.contract_id&&event.received_at>=cmd.attempted_at&&event.received_at<=period.recordedAt&&
          (event.source==='telegram_update'&&['active','failed'].includes(event.provider_state)||event.event_type==='review_observed'))))
        fail('package_access_recurring_exit_unconfirmed');
    }
  }
  return freeze({periods:combined,subscriptions:source.subscriptions});
}
