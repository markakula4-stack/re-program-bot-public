import { readRuntimeAuthorization,requireRuntimeAuthorization,assertRuntimeAuthorizationFresh } from '../v1.4.1/runtime-authorizer.mjs';
import { readTrustedContext } from '../v1.4.1/trusted-context.mjs';
import { readFinancialHistoryActorFacts, readLifecycleActorFacts } from '../v1.4.1/authority-resolver.mjs';
import { readVerifiedLifecycleFacts } from './lifecycle-authority.mjs';
import { packageHistoryMetadata } from '../v1.4.4/package-read-model.mjs';
import { sha256Hex } from '../v1.4.0-rebuild/mini-app-security.mjs';

export const SUBSCRIPTION_HISTORY_LIMIT=20;
const fail=(code,status=403)=>{throw Object.assign(new Error(code),{code,status});};
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){
  Object.values(value).forEach(freeze);Object.freeze(value);}return value;};

// This projector consumes the same private ledger verification as paid
// capabilities. It performs no additional lookup or grant-writing action.
// Full subscription transports retain their one final authorization fence.
export async function projectOwnSubscriptionHistory(authorization) {
  requireRuntimeAuthorization(authorization);
  const {context,actor}=readRuntimeAuthorization(authorization),identity=readTrustedContext(context);
  if(identity.actorKind!=='customer'||!['access.read_own','billing.read_history_own'].includes(identity.operation))
    fail('subscription_history_scope_mismatch');
  const source=readFinancialHistoryActorFacts(actor);
  if(source.telegramId!==identity.telegramId||!Array.isArray(source.entries)||source.entries.length>128)
    fail('subscription_history_scope_mismatch');
  const periods=readVerifiedLifecycleFacts(readLifecycleActorFacts(actor)).periods;
  const items=await Promise.all(source.entries.slice(0,SUBSCRIPTION_HISTORY_LIMIT).map(async entry=>{
    const receiptId='stars-'+(await sha256Hex(`v1.4.3.own-receipt\n${identity.telegramId}\n${entry.ledgerEntryId}`)).slice(0,24);
    const receipt={receiptId,planCode:entry.planCode,amountStars:entry.amountStars,currency:entry.currency,
      occurredAt:entry.occurredAt,billingMode:entry.billingMode,status:entry.status,
      paidPeriod:entry.paidPeriod,reviewRequired:entry.reviewRequired};
    const period=periods.find(row=>row.ledgerEntryId===entry.ledgerEntryId&&row.sourceKind==='package_payment');
    const packageMetadata=packageHistoryMetadata(period,identity.nowSeconds);
    if(packageMetadata&&entry.paidPeriod?.startsAt===packageMetadata.startsAt&&entry.paidPeriod?.endsAt===packageMetadata.endsAt)
      receipt.package=packageMetadata;
    return {...receipt,receipt};
  }));
  return freeze({version:1,available:source.available,reasonCode:source.reasonCode,observedAt:identity.nowSeconds,
    items,hasMore:source.entries.length>SUBSCRIPTION_HISTORY_LIMIT,limit:SUBSCRIPTION_HISTORY_LIMIT,
    authority:'worker',accessAuthority:false});
}

// A standalone bot/history read checks its captured source before returning.
// Neither a requested subject nor a receipt/order/charge identifier is accepted.
export async function readOwnSubscriptionHistory(options={}) {
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).length!==1||
      !Object.hasOwn(options,'authorization')) fail('subscription_history_scope_mismatch');
  const result=await projectOwnSubscriptionHistory(options.authorization);
  await assertRuntimeAuthorizationFresh(options.authorization);
  return result;
}
